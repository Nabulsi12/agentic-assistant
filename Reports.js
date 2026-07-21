/**
 * Reports - Generates weekly Monday morning reports,
 * computes metrics, and runs the trigger heartbeat watchdog.
 */
const Reports = {
  // Main Report Runner - Monday 08:00 America/Chicago
  generateWeeklyReport() {
    const runKey = 'last_run:reports';
    const now = new Date();

    try {
      // 1. Gather Sheet Metrics
      const contacts = Database.getContacts();
      const totalContacts = contacts.length;

      let validCount = 0;
      let invalidCount = 0;
      let riskyCount = 0;
      let unverifiedCount = 0;
      let staleCount = 0;
      let archivedCount = 0;
      let newThisWeekCount = 0;
      
      const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const sourceCounts = {};

      // Check for duplicates in Master Sheet (should be 0 due to our dedupe engine)
      const emailSet = new Set();
      let duplicateRowsCount = 0;

      contacts.forEach(match => {
        const c = match.data;
        
        // Count duplicates
        if (emailSet.has(c.email)) {
          duplicateRowsCount++;
        } else {
          emailSet.add(c.email);
        }

        // Count verifications
        if (c.verification_status === 'valid') validCount++;
        else if (c.verification_status === 'invalid') invalidCount++;
        else if (c.verification_status === 'risky') riskyCount++;
        else unverifiedCount++;

        // Count states
        if (c.lifecycle_state === 'stale-60') staleCount++;
        if (c.archived) archivedCount++;

        // Count new signups this week
        const createdAtDate = new Date(c.created_at);
        if (createdAtDate >= oneWeekAgo) {
          newThisWeekCount++;
        }

        // Count sources
        const src = c.source || 'unknown';
        sourceCounts[src] = (sourceCounts[src] || 0) + 1;
      });

      // Metric Formulas (Section 13)
      // Guard against division by zero (Scenario 35)
      const duplicateRate = totalContacts > 0 ? (duplicateRowsCount / totalContacts) * 100 : 0;
      const validationCoverage = totalContacts > 0 ? ((validCount + invalidCount) / totalContacts) * 100 : 0;

      // 2. Fetch Email Campaign Metrics from EmailOctopus (past 7 days)
      let totalDelivered = 0;
      let totalOpens = 0;
      let totalClicks = 0;
      let campaignsCount = 0;

      try {
        const apiKey = Config.getEmailOctopusApiKey();
        if (apiKey) {
          const listId = Config.getProperty('EO_LIST_ID');
          const url = `https://emailoctopus.com/api/1.1/campaigns?api_key=${apiKey}`;
          const response = Http.fetch(url, { muteHttpExceptions: true });
          
          if (response.getResponseCode() === 200) {
            const campaigns = JSON.parse(response.getContentText()).data || [];
            
            campaigns.forEach(camp => {
              // Only look at sent campaigns in past 7 days
              if (camp.status === 'sent' && camp.sent_at) {
                const sentAt = new Date(camp.sent_at);
                if (sentAt >= oneWeekAgo) {
                  campaignsCount++;
                  // Retrieve statistics
                  totalDelivered += camp.statistics.sent || 0;
                  totalOpens += camp.statistics.opened || 0;
                  totalClicks += camp.statistics.clicked || 0;
                }
              }
            });
          }
        }
      } catch (err) {
        Logger.log('WeeklyReport: Failed fetching campaigns from EmailOctopus: ' + err.toString());
      }

      // Compute email rates (Scenario 35: guard division by zero)
      const openRate = totalDelivered > 0 ? (totalOpens / totalDelivered) * 100 : 0;
      const clickRate = totalDelivered > 0 ? (totalClicks / totalDelivered) * 100 : 0;

      // 3. Gather Error Metrics (Scenario 36)
      let newErrorsThisWeek = 0;
      let totalUnresolvedErrors = 0;

      try {
        const errorSheet = Database.getErrorLogSheet();
        const errorData = errorSheet.getDataRange().getValues();
        
        for (let i = 1; i < errorData.length; i++) {
          const errTs = new Date(errorData[i][0]);
          const status = String(errorData[i][6] || '').toLowerCase();
          
          if (errTs >= oneWeekAgo) {
            newErrorsThisWeek++;
          }
          if (status === 'unresolved' || status === 'dead-letter') {
            totalUnresolvedErrors++;
          }
        }
      } catch (err) {
        Logger.log('WeeklyReport: Failed counting errors: ' + err.toString());
      }

      // 4. Watchdog Heartbeats (Scenario 38)
      // Check last run timestamps for scheduled cron jobs
      const jobs = [
        { name: 'Weekly Newsletter Dispatch', key: 'last_run:newsletter', intervalMs: 7 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000 },
        { name: 'Monthly Maintenance Cleaning', key: 'last_run:maintenance', intervalMs: 32 * 24 * 60 * 60 * 1000 }, // 32 days limit
        { name: 'Weekly Reporting Dispatch', key: 'last_run:reports', intervalMs: 7 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000 }
      ];

      let heartbeatAlerts = '';
      let isAnyHeartbeatDead = false;

      jobs.forEach(job => {
        const lastRunStr = Config.getProperty(job.key);
        let statusText = 'OK';
        let statusStyle = 'color: green; font-weight: bold;';

        if (!lastRunStr) {
          statusText = 'NEVER RUN (MISSING)';
          statusStyle = 'color: #C27D53; font-weight: bold;';
          isAnyHeartbeatDead = true;
        } else {
          const lastRunDate = new Date(lastRunStr);
          const elapsed = now.getTime() - lastRunDate.getTime();
          if (elapsed > job.intervalMs) {
            statusText = `STALE (Last run: ${lastRunDate.toLocaleDateString()})`;
            statusStyle = 'color: #C27D53; font-weight: bold;';
            isAnyHeartbeatDead = true;
          }
        }

        heartbeatAlerts += `
          <tr style="border-bottom: 1px solid #D1CDC4;">
            <td style="padding: 8px 10px; font-size: 13px;">${job.name}</td>
            <td style="padding: 8px 10px; font-family: 'Courier New', monospace; font-size: 11px; ${statusStyle}">${statusText}</td>
          </tr>
        `;
      });

      // 5. Send Report Email (Section 17 design system)
      const rachelEmail = Config.getCalendarOwnerEmail();
      if (rachelEmail) {
        let heartbeatWarningBlock = '';
        if (isAnyHeartbeatDead) {
          heartbeatWarningBlock = `
            <div style="background-color: #FAF9F6; border: 2px solid #C27D53; padding: 15px; margin-bottom: 25px;">
              <span style="font-family: 'Courier New', monospace; font-size: 11px; color: #C27D53; font-weight: bold; display: block; margin-bottom: 5px;">WARNING: TRIGGER HEARTBEAT FAILED</span>
              <p style="margin: 0; font-size: 13px; line-height: 1.5;">One or more background automation schedules have missed their scheduled execution times. Manual check of script triggers is recommended.</p>
            </div>
          `;
        }

        // Format source trends list
        let sourceTrendsHtml = '';
        Object.keys(sourceCounts).forEach(src => {
          sourceTrendsHtml += `<li style="font-size: 13px; margin-bottom: 5px;"><span style="font-family: 'Courier New', monospace; text-transform: uppercase;">${src}:</span> <strong>${sourceCounts[src]}</strong></li>`;
        });

        const bodyHtml = `
          <div style="background-color: #F4F1EA; padding: 30px; font-family: Georgia, serif; color: #1A1A1A; max-width: 650px; margin: 0 auto; border: 1px solid #D1CDC4;">
            <span style="font-family: 'Courier New', monospace; font-size: 11px; letter-spacing: 2px; color: #C27D53; font-weight: bold; display: block; margin-bottom: 10px;">WEEKLY METRICS HEARTBEAT</span>
            <h2 style="font-family: Garamond, Georgia, serif; font-size: 26px; color: #1A1A1A; margin-top: 0; font-weight: normal; border-bottom: 1px solid #D1CDC4; padding-bottom: 10px;">Weekly Performance Report</h2>
            
            ${heartbeatWarningBlock}

            <table style="width: 100%; border-collapse: collapse; margin-bottom: 25px; background-color: #FAF9F6; border: 1px solid #D1CDC4;">
              <tr style="border-bottom: 1px solid #D1CDC4; background-color: #F4F1EA;">
                <th colspan="2" style="padding: 8px 10px; text-align: left; font-family: Garamond, Georgia, serif; font-size: 16px; font-weight: normal;">Audience & Ingestion Metrics</th>
              </tr>
              <tr style="border-bottom: 1px solid #D1CDC4;">
                <td style="padding: 8px 10px; font-size: 13px;">Total Contacts</td>
                <td style="padding: 8px 10px; font-family: 'Courier New', monospace; font-size: 13px; font-weight: bold;">${totalContacts}</td>
              </tr>
              <tr style="border-bottom: 1px solid #D1CDC4;">
                <td style="padding: 8px 10px; font-size: 13px;">New Signups This Week</td>
                <td style="padding: 8px 10px; font-family: 'Courier New', monospace; font-size: 13px; font-weight: bold; color: green;">+${newThisWeekCount}</td>
              </tr>
              <tr style="border-bottom: 1px solid #D1CDC4;">
                <td style="padding: 8px 10px; font-size: 13px;">Verification Coverage</td>
                <td style="padding: 8px 10px; font-family: 'Courier New', monospace; font-size: 13px; font-weight: bold;">${validationCoverage.toFixed(1)}%</td>
              </tr>
              <tr style="border-bottom: 1px solid #D1CDC4;">
                <td style="padding: 8px 10px; font-size: 13px;">Duplicate Rate</td>
                <td style="padding: 8px 10px; font-family: 'Courier New', monospace; font-size: 13px; font-weight: bold; ${duplicateRate > 2 ? 'color: red;' : ''}">${duplicateRate.toFixed(2)}%</td>
              </tr>
              <tr style="border-bottom: 1px solid #D1CDC4;">
                <td style="padding: 8px 10px; font-size: 13px;">Stale Contacts (60-day inactive)</td>
                <td style="padding: 8px 10px; font-family: 'Courier New', monospace; font-size: 13px; font-weight: bold; color: #C27D53;">${staleCount}</td>
              </tr>
              <tr>
                <td style="padding: 8px 10px; font-size: 13px;">Archived Contacts</td>
                <td style="padding: 8px 10px; font-family: 'Courier New', monospace; font-size: 13px; font-weight: bold;">${archivedCount}</td>
              </tr>
            </table>

            <table style="width: 100%; border-collapse: collapse; margin-bottom: 25px; background-color: #FAF9F6; border: 1px solid #D1CDC4;">
              <tr style="border-bottom: 1px solid #D1CDC4; background-color: #F4F1EA;">
                <th colspan="2" style="padding: 8px 10px; text-align: left; font-family: Garamond, Georgia, serif; font-size: 16px; font-weight: normal;">Campaign Performance (Past 7 Days)</th>
              </tr>
              <tr style="border-bottom: 1px solid #D1CDC4;">
                <td style="padding: 8px 10px; font-size: 13px;">Campaigns Sent</td>
                <td style="padding: 8px 10px; font-family: 'Courier New', monospace; font-size: 13px; font-weight: bold;">${campaignsCount}</td>
              </tr>
              <tr style="border-bottom: 1px solid #D1CDC4;">
                <td style="padding: 8px 10px; font-size: 13px;">Delivered Sends</td>
                <td style="padding: 8px 10px; font-family: 'Courier New', monospace; font-size: 13px; font-weight: bold;">${totalDelivered}</td>
              </tr>
              <tr style="border-bottom: 1px solid #D1CDC4;">
                <td style="padding: 8px 10px; font-size: 13px;">Open Rate</td>
                <td style="padding: 8px 10px; font-family: 'Courier New', monospace; font-size: 13px; font-weight: bold; color: #C27D53;">${openRate.toFixed(1)}%</td>
              </tr>
              <tr>
                <td style="padding: 8px 10px; font-size: 13px;">Click Rate</td>
                <td style="padding: 8px 10px; font-family: 'Courier New', monospace; font-size: 13px; font-weight: bold; color: #C27D53;">${clickRate.toFixed(1)}%</td>
              </tr>
            </table>

            <table style="width: 100%; border-collapse: collapse; margin-bottom: 25px; background-color: #FAF9F6; border: 1px solid #D1CDC4;">
              <tr style="border-bottom: 1px solid #D1CDC4; background-color: #F4F1EA;">
                <th colspan="2" style="padding: 8px 10px; text-align: left; font-family: Garamond, Georgia, serif; font-size: 16px; font-weight: normal;">System Stability & Logs</th>
              </tr>
              <tr style="border-bottom: 1px solid #D1CDC4;">
                <td style="padding: 8px 10px; font-size: 13px;">New Failures (This Week)</td>
                <td style="padding: 8px 10px; font-family: 'Courier New', monospace; font-size: 13px; font-weight: bold; ${newErrorsThisWeek > 0 ? 'color: red;' : ''}">${newErrorsThisWeek}</td>
              </tr>
              <tr>
                <td style="padding: 8px 10px; font-size: 13px;">Total Unresolved Log Errors</td>
                <td style="padding: 8px 10px; font-family: 'Courier New', monospace; font-size: 13px; font-weight: bold; ${totalUnresolvedErrors > 0 ? 'color: red;' : ''}">${totalUnresolvedErrors}</td>
              </tr>
            </table>

            <table style="width: 100%; border-collapse: collapse; margin-bottom: 25px; background-color: #FAF9F6; border: 1px solid #D1CDC4;">
              <tr style="border-bottom: 1px solid #D1CDC4; background-color: #F4F1EA;">
                <th colspan="2" style="padding: 8px 10px; text-align: left; font-family: Garamond, Georgia, serif; font-size: 16px; font-weight: normal;">Background Jobs Heartbeat Status</th>
              </tr>
              ${heartbeatAlerts}
            </table>

            <h3 style="font-family: Garamond, Georgia, serif; font-size: 16px; font-weight: normal; margin-top: 20px;">Source Distribution Trends</h3>
            <ul style="padding-left: 20px;">
              ${sourceTrendsHtml}
            </ul>
          </div>
        `;

        Mail.sendEmail({
          to: rachelEmail,
          subject: `[REPORT] Arkay Agent Weekly Performance Summary`,
          htmlBody: bodyHtml
        });
      }

      // Record success run time
      Config.setProperty(runKey, now.toISOString());

    } catch (e) {
      ErrorHandler.logError('Reports.generateWeeklyReport', 'REPORT_DISPATCH_FAILED', e.toString(), '');
      ErrorHandler.alertPipelineDown('Weekly Report Engine', `The reports engine encountered a critical error: ${e.toString()}`);
    }
  }
};
