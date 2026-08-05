/**
 * ManagerNotification - Pre-Send Manager Notification Layer
 * Notifies the manager (Rachel) before any email is dispatched on behalf of the agent,
 * providing preview details, recipient counts, and send contexts.
 */
const ManagerNotification = {
  // Get manager email address (defaults to calendar owner / Rachel's email)
  getManagerEmail() {
    return Config.getCalendarOwnerEmail() || 'rachel@arkaysolutions.com';
  },

  // Notify manager before weekly newsletter broadcast goes out
  notifyNewsletterPending(post, recipientCount) {
    const managerEmail = this.getManagerEmail();
    const formattedDate = new Date().toLocaleDateString('en-US', { timeZone: Config.getTimeZone(), dateStyle: 'full' });

    const subject = `[AGENT PRE-SEND NOTICE] Weekly Newsletter Queued: "${post.title}"`;
    const htmlBody = `
      <div style="background-color: #F4F1EA; padding: 24px; font-family: Georgia, serif; color: #1A1A1A;">
        <div style="background-color: #FAF9F6; border: 1px solid #D1CDC4; padding: 20px; max-width: 600px; margin: 0 auto;">
          <p style="font-family: monospace; font-size: 11px; color: #C27D53; letter-spacing: 1px;">AGENT AUTOMATION • PRE-SEND NOTIFICATION</p>
          <h3 style="font-family: Garamond, Georgia, serif; margin-top: 0;">Weekly Newsletter Scheduled for Dispatch</h3>
          
          <p>The Marketing Agent is preparing to broadcast the weekly newsletter on behalf of Arkay Solutions.</p>
          
          <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
            <tr style="border-bottom: 1px solid #D1CDC4;">
              <td style="padding: 6px 0; font-weight: bold;">Post Title:</td>
              <td style="padding: 6px 0;">${Schema.escapeHtml(post.title)}</td>
            </tr>
            <tr style="border-bottom: 1px solid #D1CDC4;">
              <td style="padding: 6px 0; font-weight: bold;">Article Link:</td>
              <td style="padding: 6px 0;"><a href="${Schema.escapeHtml(post.link)}" style="color: #C27D53;">${Schema.escapeHtml(post.link)}</a></td>
            </tr>
            <tr style="border-bottom: 1px solid #D1CDC4;">
              <td style="padding: 6px 0; font-weight: bold;">Audience Size:</td>
              <td style="padding: 6px 0; font-family: monospace;">${recipientCount} active subscribers</td>
            </tr>
            <tr style="border-bottom: 1px solid #D1CDC4;">
              <td style="padding: 6px 0; font-weight: bold;">Execution Time:</td>
              <td style="padding: 6px 0;">${formattedDate}</td>
            </tr>
          </table>

          <div style="background: #F4F1EA; border: 1px solid #D1CDC4; padding: 12px; font-size: 13px;">
            <strong>Excerpt Preview:</strong><br />
            <em>${Schema.escapeHtml(post.description || 'No excerpt available.')}</em>
          </div>

          <p style="font-size: 12px; color: #666; margin-top: 16px;">
            This is an automated notification sent to the manager prior to campaign dispatch.
          </p>
        </div>
      </div>
    `;

    Mail.sendEmail({
      to: managerEmail,
      subject: subject,
      htmlBody: htmlBody
    });

    Logger.log(`Manager pre-send notification delivered to ${managerEmail} for newsletter "${post.title}" (${recipientCount} recipients).`);
  },

  // Notify manager before dispatching pre-call briefing digest
  notifyPreCallDigestPending(contact, eventTime) {
    const managerEmail = this.getManagerEmail();
    const contactName = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email;
    const formattedTime = new Date(eventTime).toLocaleString('en-US', { timeZone: Config.getTimeZone(), dateStyle: 'short', timeStyle: 'short' });

    const subject = `[AGENT PRE-SEND NOTICE] Pre-Call Digest Dispatching for ${contactName}`;
    const htmlBody = `
      <div style="background-color: #F4F1EA; padding: 20px; font-family: Georgia, serif; color: #1A1A1A;">
        <div style="background-color: #FAF9F6; border: 1px solid #D1CDC4; padding: 16px; max-width: 550px; margin: 0 auto;">
          <p style="font-family: monospace; font-size: 11px; color: #C27D53;">AGENT AUTOMATION • PRE-CALL BRIEFING</p>
          <h4 style="margin-top: 0;">Pre-Call Briefing Delivery Notice</h4>
          <p>The agent is delivering the discovery call briefing for <strong>${Schema.escapeHtml(contactName)}</strong> (${Schema.escapeHtml(contact.email)}) scheduled for ${formattedTime}.</p>
        </div>
      </div>
    `;

    Mail.sendEmail({
      to: managerEmail,
      subject: subject,
      htmlBody: htmlBody
    });
  },

  // Generic pre-send notification helper for any automated touch
  notifyEmailPending(recipient, emailSubject, emailType = 'Automated Message') {
    const managerEmail = this.getManagerEmail();
    
    // Skip notification if manager is sending directly to self
    if (recipient.toLowerCase() === managerEmail.toLowerCase()) {
      return;
    }

    const subject = `[AGENT PRE-SEND NOTICE] Email Sending to ${recipient}: "${emailSubject}"`;
    const htmlBody = `
      <div style="background-color: #F4F1EA; padding: 16px; font-family: Georgia, serif; color: #1A1A1A;">
        <div style="background-color: #FAF9F6; border: 1px solid #D1CDC4; padding: 14px; max-width: 550px; margin: 0 auto;">
          <p style="font-family: monospace; font-size: 11px; color: #C27D53;">AGENT AUTOMATION • PRE-SEND NOTIFICATION</p>
          <p style="margin: 4px 0;"><strong>Email Type:</strong> ${Schema.escapeHtml(emailType)}</p>
          <p style="margin: 4px 0;"><strong>Recipient:</strong> ${Schema.escapeHtml(recipient)}</p>
          <p style="margin: 4px 0;"><strong>Subject:</strong> ${Schema.escapeHtml(emailSubject)}</p>
        </div>
      </div>
    `;

    Mail.sendEmail({
      to: managerEmail,
      subject: subject,
      htmlBody: htmlBody
    });
  }
};
