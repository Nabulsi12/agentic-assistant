/**
 * WebhookReceiver - Exposes doPost endpoint for EmailOctopus webhooks,
 * validates signatures, deduplicates events, and logs engagement in Supabase Knowledge Graph.
 */
const WebhookReceiver = {
  verifySignature(rawBody, signatureHeader) {
    const secret = Config.getEmailOctopusWebhookSecret();
    if (!secret) {
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

  handlePost(e) {
    try {
      if (!e || !e.postData || !e.postData.contents) {
        return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: 'No payload' }))
                             .setMimeType(ContentService.MimeType.JSON);
      }

      const headers = e.headers || {};
      const signatureKey = Object.keys(headers).find(k => k.toLowerCase() === 'emailoctupus-signature');
      const signatureHeader = signatureKey ? headers[signatureKey] : (e.parameter['EmailOctupus-Signature'] || e.parameter['emailoctupus-signature']);

      const rawBody = e.postData.contents;
      if (!this.verifySignature(rawBody, signatureHeader)) {
        Database.writeErrorLog('WebhookReceiver.handlePost', 'BAD_SIGNATURE', 'HMAC signature verification failed', signatureHeader);
        return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: 'Bad signature' }))
                             .setMimeType(ContentService.MimeType.JSON);
      }

      const payload = JSON.parse(rawBody);
      const events = Array.isArray(payload) ? payload : [payload];

      const cache = CacheService.getScriptCache();
      
      events.forEach(evt => {
        try {
          const eventId = evt.id;
          if (!eventId) return;

          const cacheKey = `webhook_event:${eventId}`;
          if (cache.get(cacheKey)) {
            return;
          }

          this.processEvent(evt);
          cache.put(cacheKey, 'processed', 18000); 

        } catch (err) {
          Database.writeErrorLog(
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
      Database.writeErrorLog('WebhookReceiver.handlePost', 'WEBHOOK_RECEIVER_CRASHED', err.toString(), '');
      return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: err.toString() }))
                           .setMimeType(ContentService.MimeType.JSON);
    }
  },

  processEvent(evt) {
    const type = String(evt.type || '').toLowerCase();
    const contactDetails = evt.contact || {};
    const email = contactDetails.email_address || (evt.data && evt.data.email_address);

    if (!email) return;

    let match = Database.findContactRowByEmail(email);
    let contact;

    if (!match) {
      Database.writeErrorLog(
        'WebhookReceiver.processEvent',
        'WEBHOOK_CONTACT_MISSING',
        `Webhook event received for missing contact: ${email}. Creating minimal record.`,
        JSON.stringify(evt)
      );

      const raw = {
        email: email,
        source: 'email-octopus'
      };
      
      const ingestRes = ContactManager.ingestContact(raw);
      contact = ingestRes.contact;
    } else {
      contact = match.rowData;
    }

    const campaignName = (evt.campaign && evt.campaign.name) || 'Newsletter';

    if (type === 'opened' || type === 'clicked') {
      contact.last_engagement_at = new Date().toISOString();
      Database.saveContact(contact);
      Database.writeEmailActivity(email, campaignName, type);

    } else if (type === 'bounced') {
      contact.verification_status = 'invalid';
      contact.lifecycle_state = 'invalid';
      Database.saveContact(contact);
      Database.writeEmailActivity(email, campaignName, 'bounce');

    } else if (type === 'unsubscribed') {
      contact.archived = true;
      contact.lifecycle_state = 'archived';
      Database.saveContact(contact);
      Database.writeEmailActivity(email, campaignName, 'unsubscribe');
    }
  }
};

function doPost(e) {
  return WebhookReceiver.handlePost(e);
}


// Global Entry point for Google Apps Script Web App
function doPost(e) {
  return WebhookReceiver.handlePost(e);
}
