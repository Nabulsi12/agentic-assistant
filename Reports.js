/**
 * Reports - Generates weekly Monday morning reports reading metrics
 * directly from Supabase Knowledge Graph and runs job heartbeat monitoring.
 */
const Reports = {
  generateWeeklyReport() {
    const runKey = 'last_run:reports';
    const now = new Date();

    try {
      // 1. Gather Metrics from Supabase Knowledge Graph
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
      const emailSet = new Set();
      let duplicateRowsCount = 0;

      contacts.forEach(match => {
        const c = match.data;
        
        if (emailSet.has(c.email)) {
          duplicateRowsCount++;
        } else {
          emailSet.add(c.email);
        }

        if (c.verification_status === 'valid') validCount++;
        else if (c.verification_status === 'invalid') invalidCount++;
        else if (c.verification_status === 'risky') riskyCount++;
        else unverifiedCount++;

        if (c.lifecycle_state === 'stale-60') staleCount++;
        if (c.archived) archivedCount++;

        const createdAtDate = new Date(c.created_at);
        if (createdAtDate >= oneWeekAgo) {
          newThisWeekCount++;
        }

        const src = c.source || 'unknown';
        sourceCounts[src] = (sourceCounts[src] || 0) + 1;
      });

      // Metric Formulas (Guarded against division by zero)
      const duplicateRate = totalContacts > 0 ? (duplicateRowsCount / totalContacts) * 100 : 0;
      const validationCoverage = totalContacts > 0 ? ((validCount + invalidCount) / totalContacts) * 100 : 0;

      // 2. Fetch Unresolved Errors from Supabase error_logs
      let unresolvedErrorCount = 0;
      try {
        const path = 'error_logs?resolution_status=eq.unresolved';
        const res = Database.supabaseRequest(path, 'GET');
        if (Array.isArray(res)) {
          unresolvedErrorCount = res.length;
        }
      } catch (e) {
        // ignore
      }

      // 3. Heartbeat Watcher for Scheduled Jobs
      const jobHeartbeats = {
        'Weekly Newsletter': Config.getProperty('last_run:newsletter', 'Never'),
        'Luma Folder Poll': Config.getProperty('last_run:luma_poll', 'Never'),
        'Calendar Booking Sync': Config.getProperty('last_run:calendar_sync', 'Never'),
        'Monthly Maintenance': Config.getProperty('last_run:maintenance', 'Never')
      };

      // 4. Render Branded HTML Report
      const recipient = Config.getCalendarOwnerEmail();
      const reportHtml = `
        <div style="background-color: #F4F1EA; padding: 24px; font-family: Georgia, serif; color: #1A1A1A;">
          <div style="background-color: #FAF9F6; border: 1px solid #D1CDC4; padding: 20px; max-width: 650px; margin: 0 auto;">
            <p style="font-family: monospace; font-size: 11px; color: #C27D53; letter-spacing: 1px;">ARKAY MARKETING AGENT • WEEKLY PERFORMANCE REPORT</p>
            <h2 style="font-family: Garamond, Georgia, serif; margin-top: 0; color: #1A1A1A;">System Performance & Audience Health</h2>
            
            <table style="width: 100%; border-collapse: collapse; margin-top: 16px;">
              <tr style="border-bottom: 1px solid #D1CDC4;">
                <td style="padding: 8px; font-weight: bold;">Total Audience Size</td>
                <td style="padding: 8px; text-align: right; font-family: monospace;">${totalContacts}</td>
              </tr>
              <tr style="border-bottom: 1px solid #D1CDC4;">
                <td style="padding: 8px; font-weight: bold;">New Contacts (Past 7 Days)</td>
                <td style="padding: 8px; text-align: right; font-family: monospace;">${newThisWeekCount}</td>
              </tr>
              <tr style="border-bottom: 1px solid #D1CDC4;">
                <td style="padding: 8px; font-weight: bold;">Validation Coverage</td>
                <td style="padding: 8px; text-align: right; font-family: monospace;">${validationCoverage.toFixed(1)}%</td>
              </tr>
              <tr style="border-bottom: 1px solid #D1CDC4;">
                <td style="padding: 8px; font-weight: bold;">Duplicate Rate</td>
                <td style="padding: 8px; text-align: right; font-family: monospace;">${duplicateRate.toFixed(1)}%</td>
              </tr>
              <tr style="border-bottom: 1px solid #D1CDC4;">
                <td style="padding: 8px; font-weight: bold;">Unresolved Error Log Count</td>
                <td style="padding: 8px; text-align: right; font-family: monospace; color: ${unresolvedErrorCount > 0 ? '#C27D53' : '#1A1A1A'};">${unresolvedErrorCount}</td>
              </tr>
            </table>

            <hr style="border: 0; border-top: 1px solid #D1CDC4; margin: 20px 0;" />
            <p style="font-family: monospace; font-size: 11px; color: #C27D53;">SCHEDULED JOB HEARTBEATS</p>
            <ul>
              ${Object.keys(jobHeartbeats).map(j => `<li><strong>${j}:</strong> ${jobHeartbeats[j]}</li>`).join('')}
            </ul>
          </div>
        </div>
      `;

      Mail.sendEmail({
        to: recipient,
        subject: `Weekly Performance Report - ${now.toLocaleDateString()}`,
        htmlBody: reportHtml
      });

      Config.setProperty(runKey, now.toISOString());
      return { success: true, totalContacts, newThisWeekCount, validationCoverage };

    } catch (e) {
      Database.writeErrorLog('Reports.generateWeeklyReport', 'REPORT_GEN_FAILED', e.toString(), '');
      throw e;
    }
  }
};

