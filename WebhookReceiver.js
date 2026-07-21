/**
 * WebhookReceiver - Exposes doPost endpoint for EmailOctopus webhooks,
 * validates signatures, deduplicates events, and logs engagement.
 */
const WebhookReceiver = {
  // Verifies the HMAC-SHA256 signature from EmailOctopus
  verifySignature(rawBody, signatureHeader) {
    const secret = Config.getEmailOctopusWebhookSecret();
    if (!secret) {
      // If secret is not configured, log warning and return true to avoid blocking in early setup
      Logger.log('Warning: EO_WEBHOOK_SECRET is not configured. Skipping signature check.');
      return true;
    }

    if (!signatureHeader) return false;

    try {
      const signatureBytes = Utilities.computeHmacSignature(
        Utilities.MacAlgorithm.HMAC_SHA_256,
        rawBody,
        secret,
        Utilities.Charset.UTF_8
      );
      
      const computedSignature = signatureBytes.map(byte => {
        let val = (byte & 0xff).toString(16);
        return val.length === 1 ? '0' + val : val;
      }).join('');

      return computedSignature === signatureHeader.trim();
    } catch (e) {
      Logger.log('Signature verification error: ' + e.toString());
      return false;
    }
  },

  // Main HTTP POST receiver
  handlePost(e) {
    try {
      if (!e || !e.postData || !e.postData.contents) {
        return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: 'No payload' }))
                             .setMimeType(ContentService.MimeType.JSON);
      }

      // 1. Authenticate signature
      // Check headers case-insensitively (user clarified header is EmailOctupus-Signature)
      const headers = e.headers || {};
      const signatureKey = Object.keys(headers).find(k => k.toLowerCase() === 'emailoctupus-signature');
      const signatureHeader = signatureKey ? headers[signatureKey] : (e.parameter['EmailOctupus-Signature'] || e.parameter['emailoctupus-signature']);

      const rawBody = e.postData.contents;
      if (!this.verifySignature(rawBody, signatureHeader)) {
        ErrorHandler.logError('WebhookReceiver.handlePost', 'BAD_SIGNATURE', 'HMAC signature verification failed', signatureHeader);
        return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: 'Bad signature' }))
                             .setMimeType(ContentService.MimeType.JSON);
      }

      // 2. Parse batch of events
      const payload = JSON.parse(rawBody);
      const events = Array.isArray(payload) ? payload : [payload];

      // 3. Process events independently
      const cache = CacheService.getScriptCache();
      
      events.forEach(evt => {
        try {
          const eventId = evt.id;
          if (!eventId) return; // Skip invalid events

          // Deduplicate on event ID (rolling cache)
          const cacheKey = `webhook_event:${eventId}`;
          if (cache.get(cacheKey)) {
            // Already processed this event
            return;
          }

          // Process the specific event
          this.processEvent(evt);

          // Cache event ID for 5 hours (rolling window)
          cache.put(cacheKey, 'processed', 18000); 

        } catch (err) {
          // Scenario 34: One bad event must not abort the batch
          ErrorHandler.logError(
            'WebhookReceiver.handlePost', 
            'EVENT_PROCESSING_FAILED', 
            `Failed processing event: ${err.toString()}`, 
            JSON.stringify(evt)
          );
        }
      });

      return ContentService.createTextOutput(JSON.stringify({ status: 'success' }))
                           .setMimeType(ContentService.MimeType.JSON);

    } catch (err) {
      ErrorHandler.logError('WebhookReceiver.handlePost', 'WEBHOOK_RECEIVER_CRASHED', err.toString(), '');
      return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: err.toString() }))
                           .setMimeType(ContentService.MimeType.JSON);
    }
  },

  // Processes a single webhook event
  processEvent(evt) {
    const type = String(evt.type || '').toLowerCase(); // e.g. 'opened', 'clicked', 'bounced', 'unsubscribed'
    const contactDetails = evt.contact || {};
    const email = contactDetails.email_address || (evt.data && evt.data.email_address);

    if (!email) return;

    // Lookup contact
    let match = Database.findContactRowByEmail(email);
    let contact;

    if (!match) {
      // Scenario 34: Webhook arrives before contact exists
      // Log warning and create minimal contact record
      ErrorHandler.logError(
        'WebhookReceiver.processEvent',
        'WEBHOOK_CONTACT_MISSING',
        `Webhook event received for missing contact: ${email}. Creating minimal record.`,
        JSON.stringify(evt)
      );

      contact = {
        email: email,
        source: 'email-octopus',
        lifecycle_state: 'active',
        verification_status: 'valid' // Exists on ESP
      };
      
      const ingestRes = DedupeMerge.ingestContact(contact);
      contact = ingestRes.contact;
    } else {
      contact = match.rowData;
    }

    const campaignName = (evt.campaign && evt.campaign.name) || 'Newsletter';

    // Handle different event types
    if (type === 'opened' || type === 'clicked') {
      // opened/clicked -> last_engagement_at=now
      contact.last_engagement_at = new Date().toISOString();
      Database.saveContact(contact);
      
      // Log campaign activity
      Database.writeEmailActivity(email, campaignName, type);

    } else if (type === 'bounced') {
      // bounced -> verification_status=invalid + Section 10 invalid handling
      contact.verification_status = 'invalid';
      contact = DedupeMerge.transitionState(contact, 'invalid', 'webhook-bounce');
      
      // Add flag:invalid-undeliverable
      const tags = Schema.parseTags(contact.tags);
      tags.push('flag:invalid-undeliverable');
      contact.tags = Schema.formatTags(tags);
      
      Database.saveContact(contact);
      
      // Log activity
      Database.writeEmailActivity(email, campaignName, 'bounce');

      // Unsubscribe from ESP
      try {
        EmailOctopus.syncContact(contact);
      } catch (e) {
        ErrorHandler.logError('WebhookReceiver.processEvent', 'BOUNCE_ESP_UNSUBSCRIBE_FAILED', e.toString(), email);
      }

    } else if (type === 'unsubscribed') {
      // unsubscribed -> ESP handles suppression; Sheet mirrors status
      // We set archived = true, lifecycle_state = archived, status = archived
      contact.archived = true;
      contact = DedupeMerge.transitionState(contact, 'archived', 'webhook-unsubscribe');
      
      Database.saveContact(contact);
      
      // Log activity
      Database.writeEmailActivity(email, campaignName, 'unsubscribe');
    }
  }
};

// Global Entry point for Google Apps Script Web App
function doPost(e) {
  return WebhookReceiver.handlePost(e);
}
