/**
 * Triggers - Consolidates all entry points for installable triggers,
 * crons, and web app doGet requests.
 */

// Installable onFormSubmit Trigger bound to Spreadsheet
function onFormSubmitEntry(e) {
  GoogleForms.handleFormSubmit(e);
}

// Installable calendar onEventUpdated Trigger
function onCalendarUpdatedEntry(e) {
  CalendarBookings.syncBookings();
}

// 15-Minute Polling Trigger (Luma, Pre-Call digests, mailto outcomes)
function cron15Min() {
  // 1. Process Luma CSV files in Inbox
  LumaPoll.pollInbox();
  
  // 2. Synchronize Calendar Bookings & check reschedules
  CalendarBookings.syncBookings();
  
  // 3. Scan and dispatch pre-call digests
  CalendarBookings.scanAndSendDigests();
  
  // 4. Check for WON/LOST mailto log outcomes in Gmail
  OutcomeParser.parseGmailOutcomes();
}

// Daily Trigger (Cap Watcher)
function cronDaily() {
  ErrorHandler.checkCaps();
}

// Weekly Monday 08:00 Trigger (Weekly report)
function cronWeeklyReports() {
  Reports.generateWeeklyReport();
}

// Weekly Thursday 09:00 Trigger (Newsletter dispatcher)
function cronWeeklyNewsletter() {
  Newsletter.dispatchNewsletter();
}

// Monthly 1st 02:00 Trigger (Maintenance clean)
function cronMonthlyMaintenance() {
  Maintenance.cleanHouse();
}

// Web App doGet listener (e.g. Rachel's newsletter one-click send approvals)
function doGet(e) {
  const action = e.parameter.action;
  const title = e.parameter.title;

  let headerColor = '#C27D53';
  let titleText = 'Action Required';
  let messageText = 'Invalid or unrecognized request action.';

  if (action === 'approve_newsletter' && title) {
    try {
      // Find the unsent post in the RSS feed matching the title to send it
      const rssUrl = Config.getRssUrl();
      const response = UrlFetchApp.fetch(rssUrl, { muteHttpExceptions: true });
      let matchedPost = null;

      if (response.getResponseCode() === 200) {
        const xml = response.getContentText();
        const document = XmlService.parse(xml);
        const root = document.getRootElement();
        const channel = root.getChild('channel');
        const items = channel.getChildren('item');
        
        items.forEach(item => {
          const itemTitle = item.getChildText('title') || '';
          if (itemTitle.trim() === title.trim()) {
            const link = item.getChildText('link') || '';
            const guid = item.getChildText('guid') || link;
            let summary = item.getChildText('description') || '';
            const ns = XmlService.getNamespace('http://purl.org/rss/1.0/modules/content/');
            const encoded = item.getChildText('encoded', ns);
            if (encoded) summary = encoded;

            matchedPost = { title: itemTitle, link, guid, summary };
          }
        });
      }

      if (matchedPost) {
        // Enforce sending post by updating send mode temporarily to execute send
        const currentMode = Config.getNewsletterSendMode();
        // Set script property temporarily to allow sending
        Config.setProperty('EO_SEND_MODE', 'auto');
        
        Newsletter.sendPostToAudience(matchedPost);
        
        // Restore mode
        Config.setProperty('EO_SEND_MODE', currentMode);

        headerColor = 'green';
        titleText = 'Newsletter Sent';
        messageText = `Branded newsletter <strong>"${title}"</strong> has been successfully broadcast to EmailOctopus.`;
      } else {
        messageText = `Failed to find post matching title <strong>"${title}"</strong> in the RSS feed.`;
      }

    } catch (err) {
      headerColor = 'red';
      titleText = 'Broadcast Failed';
      messageText = `An error occurred while broadcasting the newsletter: ${err.toString()}`;
      ErrorHandler.logError('Triggers.doGet', 'MANUAL_SEND_FAILED', err.toString(), title);
    }
  }

  // Branded return HTML template (Section 17 design system)
  const responseHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Arkay Agent Action</title>
      <style>
        body { background-color: #F4F1EA; font-family: Georgia, serif; color: #1A1A1A; padding: 50px 20px; }
        .card { background-color: #FAF9F6; max-width: 500px; margin: 0 auto; padding: 40px; border: 1px solid #D1CDC4; text-align: center; }
        .label { font-family: 'Courier New', monospace; font-size: 11px; letter-spacing: 2px; color: ${headerColor}; font-weight: bold; text-transform: uppercase; margin-bottom: 20px; display: block; }
        h2 { font-family: Garamond, Georgia, serif; font-size: 24px; font-weight: normal; margin-top: 0; }
        p { font-size: 15px; line-height: 1.6; color: #333; }
      </style>
    </head>
    <body>
      <div class="card">
        <span class="label">${titleText}</span>
        <h2>System Status Notification</h2>
        <p>${messageText}</p>
      </div>
    </body>
    </html>
  `;

  return ContentService.createTextOutput(responseHtml)
                       .setMimeType(ContentService.MimeType.TEXT);
}
