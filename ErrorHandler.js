/**
 * ErrorHandler - Deals with transient/permanent errors, digests, and quota checks.
 */
const ErrorHandler = {
  // Simple error wrapper
  logError(source, eventType, reason, payloadRef, retryStatus = 'none', resolutionStatus = 'unresolved') {
    try {
      Database.writeErrorLog(source, eventType, reason, payloadRef, retryStatus, resolutionStatus);
    } catch (e) {
      Logger.log('Failed to write to spreadsheet error log: ' + e.toString());
    }
  },

  // Immediate critical pipeline-down notification
  alertPipelineDown(component, details) {
    const rachelEmail = Config.getCalendarOwnerEmail();
    if (!rachelEmail) return;

    const subject = `[CRITICAL] Arkay Agent Pipeline Down: ${component}`;
    
    // Apply styling from Spec Section 17 (warm bone canvas, contrast text, monospace labels)
    const bodyHtml = `
      <div style="background-color: #F4F1EA; padding: 30px; font-family: Georgia, serif; color: #1A1A1A; max-width: 600px; margin: 0 auto; border: 1px solid #D1CDC4;">
        <span style="font-family: 'Courier New', monospace; font-size: 11px; letter-spacing: 2px; color: #C27D53; font-weight: bold; display: block; margin-bottom: 10px;">CRITICAL SYSTEM ALERT</span>
        <h2 style="font-family: Garamond, Georgia, serif; color: #1A1A1A; margin-top: 0; font-weight: normal; border-bottom: 1px solid #D1CDC4; padding-bottom: 10px;">Pipeline Interrupted</h2>
        <p style="font-size: 15px; line-height: 1.6;">The marketing agent encountered a fatal issue while executing <strong>${component}</strong>. The pipeline has been halted.</p>
        <div style="background-color: #FAF9F6; border: 1px solid #D1CDC4; padding: 15px; margin: 20px 0;">
          <p style="font-family: 'Courier New', monospace; font-size: 13px; margin: 0; white-space: pre-wrap;">${details}</p>
        </div>
        <p style="font-size: 13px; color: #555;">Please contact Ali or Devi to investigate the script properties or external integrations.</p>
      </div>
    `;

    try {
      Mail.sendEmail({
        to: rachelEmail,
        subject: subject,
        htmlBody: bodyHtml
      });
    } catch (e) {
      Logger.log('Failed to send pipeline down alert: ' + e.toString());
    }
  },

  // Executes a function with a retry policy (3 retries: 2s, 4s, 8s backoff)
  executeWithRetry(actionFn, source, eventType, payloadRef) {
    const backoffs = [2000, 4000, 8000];
    let attempt = 0;
    
    while (true) {
      try {
        return actionFn();
      } catch (err) {
        attempt++;
        const errStr = err.toString();
        
        if (attempt <= backoffs.length) {
          const sleepMs = backoffs[attempt - 1];
          const retryStatus = `Retry ${attempt}/${backoffs.length} (waiting ${sleepMs/1000}s)`;
          
          this.logError(source, eventType, `Attempt ${attempt} failed: ${errStr}`, payloadRef, retryStatus, 'retrying');
          
          Utils.sleep(sleepMs);
        } else {
          // Dead-letter state reached
          this.logError(source, eventType, `All retries exhausted. Error: ${errStr}`, payloadRef, 'exhausted', 'dead-letter');
          throw err; // bubble up or trigger pipeline-down if critical
        }
      }
    }
  },

  // Sends the 24-hour error digest to Rachel
  sendDailyDigest() {
    const sheet = Database.getErrorLogSheet();
    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) return; // No errors logged at all

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentErrors = [];

    // Parse rows (ignoring headers)
    for (let i = 1; i < data.length; i++) {
      const ts = new Date(data[i][0]);
      if (ts >= oneDayAgo) {
        recentErrors.push({
          ts: data[i][0],
          source: data[i][1],
          eventType: data[i][2],
          reason: data[i][3],
          status: data[i][6]
        });
      }
    }

    if (recentErrors.length === 0) return; // No recent errors in past 24h

    const rachelEmail = Config.getCalendarOwnerEmail();
    if (!rachelEmail) return;

    let errorTableRows = '';
    recentErrors.forEach(err => {
      errorTableRows += `
        <tr style="border-bottom: 1px solid #D1CDC4;">
          <td style="padding: 10px; font-family: 'Courier New', monospace; font-size: 11px;">${err.source}</td>
          <td style="padding: 10px; font-size: 13px;">${err.eventType}</td>
          <td style="padding: 10px; font-size: 13px; color: #C27D53;">${err.reason}</td>
          <td style="padding: 10px; font-family: 'Courier New', monospace; font-size: 11px; text-transform: uppercase;">${err.status}</td>
        </tr>
      `;
    });

    const bodyHtml = `
      <div style="background-color: #F4F1EA; padding: 30px; font-family: Georgia, serif; color: #1A1A1A; max-width: 700px; margin: 0 auto; border: 1px solid #D1CDC4;">
        <span style="font-family: 'Courier New', monospace; font-size: 11px; letter-spacing: 2px; color: #C27D53; font-weight: bold; display: block; margin-bottom: 10px;">DAILY OPERATIONS SUMMARY</span>
        <h2 style="font-family: Garamond, Georgia, serif; color: #1A1A1A; margin-top: 0; font-weight: normal; border-bottom: 1px solid #D1CDC4; padding-bottom: 10px;">Daily Error Digest</h2>
        <p style="font-size: 15px; line-height: 1.6;">The system encountered ${recentErrors.length} operations errors in the last 24 hours. See summary below:</p>
        
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0; background-color: #FAF9F6; border: 1px solid #D1CDC4;">
          <thead>
            <tr style="background-color: #FAF9F6; border-bottom: 1px solid #D1CDC4; text-align: left;">
              <th style="padding: 10px; font-family: 'Courier New', monospace; font-size: 11px; color: #C27D53; text-transform: uppercase;">Source</th>
              <th style="padding: 10px; font-family: 'Courier New', monospace; font-size: 11px; color: #C27D53; text-transform: uppercase;">Event Type</th>
              <th style="padding: 10px; font-family: 'Courier New', monospace; font-size: 11px; color: #C27D53; text-transform: uppercase;">Reason</th>
              <th style="padding: 10px; font-family: 'Courier New', monospace; font-size: 11px; color: #C27D53; text-transform: uppercase;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${errorTableRows}
          </tbody>
        </table>
      </div>
    `;

    try {
      Mail.sendEmail({
        to: rachelEmail,
        subject: `[ALERT] Arkay Agent: Daily Error Digest (${recentErrors.length} errors)`,
        htmlBody: bodyHtml
      });
    } catch (e) {
      Logger.log('Failed to send daily digest: ' + e.toString());
    }
  },

  // Cap watcher checks (runs daily)
  checkCaps() {
    const rachelEmail = Config.getCalendarOwnerEmail();
    if (!rachelEmail) return;

    // 1. EmailOctopus limits (90% of 2500 is 2250)
    let eoContactCount = 0;
    try {
      const apiKey = Config.getEmailOctopusApiKey();
      if (apiKey) {
        // Fetch audience contacts count from EmailOctopus list
        // Note: we fetch the lists to check size
        const url = `https://emailoctopus.com/api/1.1/lists?api_key=${apiKey}`;
        const response = Http.fetch(url, { muteHttpExceptions: true });
        if (response.getResponseCode() === 200) {
          const lists = JSON.parse(response.getContentText()).data;
          lists.forEach(l => {
            eoContactCount += l.counts.pending + l.counts.subscribed;
          });
        }
      }
    } catch (e) {
      Logger.log('CapWatcher: EmailOctopus check failed: ' + e.toString());
    }

    // 2. ZeroBounce limits (90% of 100/mo is 90)
    let zbCredits = 100;
    try {
      const apiKey = Config.getZeroBounceApiKey();
      if (apiKey) {
        const url = `https://api.zerobounce.net/v2/getcredits?api_key=${apiKey}`;
        const response = Http.fetch(url, { muteHttpExceptions: true });
        if (response.getResponseCode() === 200) {
          zbCredits = JSON.parse(response.getContentText()).credits;
        }
      }
    } catch (e) {
      Logger.log('CapWatcher: ZeroBounce check failed: ' + e.toString());
    }

    // Check thresholds
    const isEoCapBreached = eoContactCount >= 2250;
    const isZbCapBreached = zbCredits <= 10; // Less than 10 credits left (90% used)

    if (isEoCapBreached || isZbCapBreached) {
      let alerts = '';
      if (isEoCapBreached) {
        alerts += `<p style="font-size: 15px;">⚠️ <strong>EmailOctopus contacts count</strong> is at <strong>${eoContactCount}</strong> (Ceiling: 2,500. Next-tier upgrade required soon).</p>`;
      }
      if (isZbCapBreached) {
        alerts += `<p style="font-size: 15px;">⚠️ <strong>ZeroBounce credit balance</strong> is down to <strong>${zbCredits}</strong> credits (Ceiling: 100/mo. Next-tier upgrade required soon).</p>`;
      }

      const bodyHtml = `
        <div style="background-color: #F4F1EA; padding: 30px; font-family: Georgia, serif; color: #1A1A1A; max-width: 600px; margin: 0 auto; border: 1px solid #D1CDC4;">
          <span style="font-family: 'Courier New', monospace; font-size: 11px; letter-spacing: 2px; color: #C27D53; font-weight: bold; display: block; margin-bottom: 10px;">CAP WATCHER WARNING</span>
          <h2 style="font-family: Garamond, Georgia, serif; color: #1A1A1A; margin-top: 0; font-weight: normal; border-bottom: 1px solid #D1CDC4; padding-bottom: 10px;">API Quota Alert</h2>
          ${alerts}
          <p style="font-size: 14px; margin-top: 20px; font-style: italic;">Reply "UPGRADE to proceed" to authorize budget changes. Note: Auto-upgrades are disabled.</p>
        </div>
      `;

      try {
        Mail.sendEmail({
          to: rachelEmail,
          subject: '[ALERT] Arkay Agent: API Usage Near Limits',
          htmlBody: bodyHtml
        });
      } catch (e) {
        Logger.log('Failed to send cap watcher alert: ' + e.toString());
      }
    }
  }
};
