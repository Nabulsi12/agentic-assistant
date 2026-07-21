/**
 * Newsletter - Fetches blog posts, filters targets,
 * updates custom fields and tags in EmailOctopus, and records run heartbeats.
 */
const Newsletter = {
  // Main Weekly Trigger - Runs Thursday 09:00 America/Chicago
  dispatchNewsletter() {
    const runKey = 'last_run:newsletter';
    const now = new Date();
    
    try {
      // 1. Fetch RSS Feed
      const rssUrl = Config.getRssUrl();
      const response = Http.fetch(rssUrl, { muteHttpExceptions: true });
      if (response.getResponseCode() !== 200) {
        throw new Error(`Failed to fetch RSS feed from ${rssUrl}. HTTP code: ${response.getResponseCode()}`);
      }
      
      const xml = response.getContentText();
      const document = XmlService.parse(xml);
      const root = document.getRootElement();
      const channel = root.getChild('channel');
      if (!channel) {
        throw new Error('Invalid RSS structure: missing <channel>');
      }

      const items = channel.getChildren('item');
      if (items.length === 0) {
        Logger.log('Newsletter: No items in RSS feed.');
        Config.setProperty(runKey, now.toISOString());
        return;
      }

      // 2. Identify unsent posts published in the last 7 days (and not in the future)
      const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const unsentPosts = [];

      items.forEach(item => {
        const title = item.getChildText('title') || '';
        const link = item.getChildText('link') || '';
        const guid = item.getChildText('guid') || link;
        const pubDateText = item.getChildText('pubDate') || '';
        
        let summary = item.getChildText('description') || '';
        // If content:encoded is present, we can use it or fallback
        const contentEncodedNs = XmlService.getNamespace('http://purl.org/rss/1.0/modules/content/');
        const contentEncoded = item.getChildText('encoded', contentEncodedNs);
        if (contentEncoded) {
          summary = contentEncoded;
        }

        if (!pubDateText) return;
        
        const pubDate = new Date(pubDateText);
        
        // Scenario 11: Check date boundaries (last 7 days AND not in the future)
        const isWithinLast7Days = pubDate >= oneWeekAgo;
        const isNotInFuture = pubDate <= now;
        
        if (isWithinLast7Days && isNotInFuture) {
          // Check if already sent
          const sentKey = `newsletter_sent:${guid}`;
          const isSent = Config.getProperty(sentKey);
          
          if (!isSent) {
            unsentPosts.push({ title, link, guid, pubDate, summary });
          }
        }
      });

      if (unsentPosts.length === 0) {
        Logger.log('Newsletter Skipped: No new content');
        Config.setProperty(runKey, now.toISOString());
        return;
      }

      // Process all unsent posts from the last 7 days (Gap 7)
      unsentPosts.forEach(post => {
        this.sendPostToAudience(post);
      });

      // Record success heartbeat
      Config.setProperty(runKey, now.toISOString());

    } catch (e) {
      ErrorHandler.logError('Newsletter.dispatchNewsletter', 'NEWSLETTER_JOB_FAILED', e.toString(), '');
      ErrorHandler.alertPipelineDown('Newsletter Dispatch', `The weekly newsletter job failed: ${e.toString()}`);
    }
  },

  // Process and send a specific post
  sendPostToAudience(post) {
    // 1. Segment contacts: active, verified, not archived
    const eligibleContacts = Database.getContacts(c => {
      return c.lifecycle_state === 'active' && 
             c.verification_status === 'valid' && 
             !c.archived;
    });

    // Scenario 32: Handle the empty-recipient case explicitly
    if (eligibleContacts.length === 0) {
      ErrorHandler.logError('Newsletter.sendPostToAudience', 'NO_ELIGIBLE_RECIPIENTS', `No active eligible contacts found for newsletter: ${post.title}`, post.guid);
      
      // Notify Rachel about empty audience
      const rachelEmail = Config.getCalendarOwnerEmail();
      if (rachelEmail) {
        Mail.sendEmail({
          to: rachelEmail,
          subject: '[ALERT] Newsletter Blocked: No Eligible Contacts',
          body: `The newsletter job found 0 active, verified, and unarchived subscribers to send the post: "${post.title}". Please verify the master contact spreadsheet.`
        });
      }
      return;
    }

    // 2. Build branded HTML
    // Scenario 33: HTML in RSS summary must be rendered correctly, not double-escaped, and empty is fine
    const newsletterBody = post.summary || '';
    const newsletterHtml = this.compileBrandedHtml(post.title, newsletterBody, post.link);

    // 3. Check Send Mode (Scenario 19 fallback / manual mode)
    const sendMode = Config.getNewsletterSendMode();
    if (sendMode === 'manual') {
      this.sendManualApprovalEmail(post.title, newsletterHtml);
      return;
    }

    // 4. Batch update contacts in EmailOctopus
    const automationId = Config.getEmailOctopusNewsletterAutomationId();
    if (!automationId) {
      throw new Error('EO_NEWSLETTER_AUTOMATION_ID is not configured in properties');
    }

    // Filter contacts who have EmailOctopus contact IDs
    const syncable = eligibleContacts.filter(c => c.data.esp_contact_id);

    // If some contacts lack esp_contact_id, sync them first
    const missingSync = eligibleContacts.filter(c => !c.data.esp_contact_id);
    if (missingSync.length > 0) {
      const synced = EmailOctopus.bulkSyncContacts(missingSync.map(m => m.data));
      synced.forEach(c => {
        // Find in database and save
        Database.saveContact(c);
        if (c.esp_contact_id) {
          syncable.push({ data: c });
        }
      });
    }

    // Track recipient list snapshot once (Scenario 19)
    const recipientSnapshot = [...syncable];

    // For each contact in the snapshot:
    // Update custom fields and add trigger tag: send:newsletter
    const fieldsMap = {
      NEWSLETTER_HTML: newsletterHtml,
      NEWSLETTER_SUBJECT: post.title
    };

    recipientSnapshot.forEach(item => {
      const contact = item.data;
      try {
        // Set HTML content and trigger tag
        EmailOctopus.updateCustomFields(contact.esp_contact_id, fieldsMap, ['send:newsletter'], []);
        
        // Log to Activity Sheet
        Database.writeEmailActivity(contact.email, post.title, 'sent');
      } catch (err) {
        ErrorHandler.logError('Newsletter.sendPostToAudience', 'CONTACT_SEND_TRIGGER_FAILED', err.toString(), contact.email);
      }
    });

    // Wait 5 seconds to let EmailOctopus process automation triggers before removing tags (Scenario 4 / Scenario 19)
    Utils.sleep(5000);

    // Remove trigger tag so automation can re-fire next week
    recipientSnapshot.forEach(item => {
      const contact = item.data;
      try {
        EmailOctopus.updateCustomFields(contact.esp_contact_id, {}, [], ['send:newsletter']);
      } catch (err) {
        // Log tag removal failures
        ErrorHandler.logError('Newsletter.sendPostToAudience', 'REMOVE_TAG_FAILED', err.toString(), contact.email);
      }
    });

    // Mark post as sent
    Config.setProperty(`newsletter_sent:${post.guid}`, 'true');

    // Send success notice to Rachel
    const rachelEmail = Config.getCalendarOwnerEmail();
    if (rachelEmail) {
      Mail.sendEmail({
        to: rachelEmail,
        subject: `[CONFIRMATION] Newsletter Sent: ${post.title}`,
        htmlBody: `<p style="font-family: Georgia, serif; font-size: 15px;">Branded newsletter <strong>"${post.title}"</strong> has been successfully dispatched to <strong>${recipientSnapshot.length}</strong> active subscribers via EmailOctopus automation.</p>`
      });
    }
  },

  // Build branded newsletter HTML (Section 17)
  compileBrandedHtml(title, bodyContent, postLink) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>${Schema.escapeHtml(title)}</title>
      </head>
      <body style="background-color: #F4F1EA; margin: 0; padding: 40px 20px; font-family: Georgia, Inter, sans-serif; color: #1A1A1A;">
        <div style="background-color: #FAF9F6; max-width: 600px; margin: 0 auto; padding: 40px; border: 1px solid #D1CDC4;">
          <span style="font-family: 'Courier New', monospace; font-size: 11px; letter-spacing: 2px; color: #C27D53; font-weight: bold; display: block; margin-bottom: 20px; text-transform: uppercase;">WEEKLY UPDATE</span>
          
          <h1 style="font-family: Garamond, Georgia, serif; font-size: 28px; font-weight: normal; margin-top: 0; margin-bottom: 25px; line-height: 1.2;">
            ${Schema.escapeHtml(title)}
          </h1>
          
          <div style="font-size: 16px; line-height: 1.6; margin-bottom: 30px;">
            ${bodyContent}
          </div>
          
          <div style="border-top: 1px solid #D1CDC4; padding-top: 25px; text-align: center;">
            <a href="${postLink}" style="display: inline-block; background-color: #FAF9F6; border: 1px solid #D1CDC4; color: #1A1A1A; padding: 12px 24px; font-family: 'Courier New', monospace; font-size: 13px; font-weight: bold; text-decoration: none; text-transform: uppercase; letter-spacing: 1px;">
              Read Full Article &bull;
            </a>
          </div>
        </div>
      </body>
      </html>
    `;
  },

  // Fallback: send email to Rachel with built HTML and a one-click trigger link
  sendManualApprovalEmail(title, htmlContent) {
    const rachelEmail = Config.getCalendarOwnerEmail();
    if (!rachelEmail) return;

    const webAppUrl = Config.getProperty('WEB_APP_URL', 'https://script.google.com/macros/s/example/exec');
    const approvalLink = `${webAppUrl}?action=approve_newsletter&title=${encodeURIComponent(title)}`;

    const mailHtml = `
      <div style="background-color: #F4F1EA; padding: 30px; font-family: Georgia, serif; color: #1A1A1A; border: 1px solid #D1CDC4;">
        <span style="font-family: 'Courier New', monospace; font-size: 11px; letter-spacing: 2px; color: #C27D53; font-weight: bold; display: block; margin-bottom: 10px;">MANUAL APPROVAL REQUIRED</span>
        <h2 style="font-family: Garamond, Georgia, serif; font-weight: normal;">Newsletter Ready to Send</h2>
        <p style="font-size: 15px;">Your latest blog post <strong>"${title}"</strong> is compiled and ready.</p>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${approvalLink}" style="background-color: #FAF9F6; border: 1px solid #D1CDC4; color: #1A1A1A; padding: 15px 30px; font-family: 'Courier New', monospace; text-transform: uppercase; font-weight: bold; text-decoration: none; font-size: 14px;">
            &bull; ONE-CLICK SEND NOW &bull;
          </a>
        </div>
        
        <hr style="border: 0; border-top: 1px solid #D1CDC4; margin: 30px 0;" />
        <h3 style="font-family: Garamond, Georgia, serif; font-weight: normal; margin-bottom: 15px;">Preview:</h3>
        <div style="border: 1px solid #D1CDC4; background-color: #FAF9F6; padding: 20px;">
          ${htmlContent}
        </div>
      </div>
    `;

    try {
      Mail.sendEmail({
        to: rachelEmail,
        subject: `[APPROVAL] Newsletter Send Request: ${title}`,
        htmlBody: mailHtml
      });
    } catch (e) {
      ErrorHandler.logError('Newsletter.sendManualApprovalEmail', 'MANUAL_APPROVAL_SEND_FAILED', e.toString(), title);
    }
  }
};
