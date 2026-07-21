/**
 * Maintenance - Handles monthly stale contacts sweeping, re-verification,
 * archiving, and the 20% mass-archive circuit breaker.
 */
const Maintenance = {
  // Main Sweep Trigger - Runs 1st of month, 02:00 America/Chicago
  cleanHouse() {
    const runKey = 'last_run:maintenance';
    const now = new Date();
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    try {
      // 1. Fetch active, unarchived contacts
      const activeContacts = Database.getContacts(c => !c.archived);
      const totalActive = activeContacts.length;
      
      if (totalActive === 0) {
        Logger.log('Maintenance: No active contacts to clean.');
        Config.setProperty(runKey, now.toISOString());
        return;
      }

      const staleList = [];

      // 2. Identify stale-60 contacts
      activeContacts.forEach(match => {
        const c = match.data;
        const createdDate = new Date(c.created_at);
        
        // Scenario 3: Must be created > 60 days ago AND have been sent at least one email
        if (createdDate >= sixtyDaysAgo || !c.last_email_sent_at) {
          return; // Not eligible
        }

        // If they have never engaged, or engaged > 60 days ago
        const lastEng = c.last_engagement_at ? new Date(c.last_engagement_at) : null;
        const isStale = !lastEng || lastEng < sixtyDaysAgo;

        if (isStale) {
          staleList.push(match);
        }
      });

      if (staleList.length === 0) {
        Logger.log('Maintenance: No stale contacts identified.');
        Config.setProperty(runKey, now.toISOString());
        return;
      }

      // 3. Circuit Breaker (Scenario 37)
      // If we are about to archive more than 20% of the active audience, STOP!
      const staleRate = staleList.length / totalActive;
      if (staleRate > 0.20) {
        const errorMsg = `Circuit Breaker Triggered: Maintenance attempted to archive ${staleList.length} of ${totalActive} active contacts (${(staleRate * 100).toFixed(1)}%). Halting job.`;
        
        ErrorHandler.logError(
          'Maintenance.cleanHouse', 
          'CIRCUIT_BREAKER_TRIGGERED', 
          errorMsg, 
          JSON.stringify({ staleCount: staleList.length, totalActive })
        );

        // Immediate email warning to Rachel
        ErrorHandler.alertPipelineDown('Monthly Maintenance Circuit Breaker', errorMsg);
        return; // Halt and change nothing
      }

      // 4. Process stale contacts: transition state, re-verify, archive if invalid/inactive
      let archivedCount = 0;
      const batchSize = 100;
      const cursorPropName = 'MAINTENANCE_CURSOR_INDEX';
      let startIndex = parseInt(Config.getProperty(cursorPropName, '0'), 10);
      const endIndex = Math.min(staleList.length, startIndex + batchSize);

      for (let i = startIndex; i < endIndex; i++) {
        const match = staleList[i];
        let contact = match.data;

        // Transition to stale-60 first
        contact = DedupeMerge.transitionState(contact, 'stale-60', 'maintenance-sweep');

        // Re-verify email address (monthly validation check)
        contact = Verification.processVerification(contact);

        // Check if verifier marked them invalid, or if they still have no validation/engagement
        const isVerificationInvalid = contact.verification_status === 'invalid';
        
        if (isVerificationInvalid) {
          // Cleanly Archive contact
          contact.archived = true;
          contact = DedupeMerge.transitionState(contact, 'archived', 'maintenance-archive');
          
          // Unsubscribe in EmailOctopus to save billable subscriber slots
          try {
            EmailOctopus.syncContact(contact);
          } catch (e) {
            ErrorHandler.logError('Maintenance.cleanHouse', 'ARCHIVE_ESP_UNSUBSCRIBE_FAILED', e.toString(), contact.email);
          }

          archivedCount++;
        }

        // Save updated contact in Master Sheet
        Database.saveContact(contact);
      }

      if (endIndex >= staleList.length) {
        // Sweep completed successfully!
        try {
          PropertiesService.getScriptProperties().deleteProperty(cursorPropName);
        } catch (e) {
          // ignore
        }

        // Email summary report to Rachel (Section 15)
        const rachelEmail = Config.getCalendarOwnerEmail();
        if (rachelEmail) {
          MailApp.sendEmail({
            to: rachelEmail,
            subject: `[SUMMARY] Monthly Maintenance Archive Report`,
            htmlBody: `
              <div style="background-color: #F4F1EA; padding: 30px; font-family: Georgia, serif; color: #1A1A1A; max-width: 600px; margin: 0 auto; border: 1px solid #D1CDC4;">
                <span style="font-family: 'Courier New', monospace; font-size: 11px; letter-spacing: 2px; color: #C27D53; font-weight: bold; display: block; margin-bottom: 10px;">MAINTENANCE SUMMARY</span>
                <h2 style="font-family: Garamond, Georgia, serif; font-weight: normal; margin-top: 0; border-bottom: 1px solid #D1CDC4; padding-bottom: 10px;">Monthly Inactive Clean completed</h2>
                <p style="font-size: 15px; line-height: 1.6;">The monthly database maintenance sweep has completed successfully:</p>
                <ul style="font-size: 14px; line-height: 1.8;">
                  <li>Active Contacts Audited: <strong>${totalActive}</strong></li>
                  <li>Stale Profiles Tagged (60d inactive): <strong>${staleList.length}</strong></li>
                  <li>Profiles Archived (Bounces/Cleaned): <strong>${archivedCount}</strong></li>
                  <li>Live List Size remaining: <strong>${totalActive - archivedCount}</strong></li>
                </ul>
              </div>
            `
          });
        }

        Config.setProperty(runKey, now.toISOString());
      } else {
        // Save progress index for next batch run
        Config.setProperty(cursorPropName, String(endIndex));
        Logger.log(`Maintenance batch complete. Progress saved at stale index ${endIndex}/${staleList.length}`);
      }

    } catch (e) {
      ErrorHandler.logError('Maintenance.cleanHouse', 'MAINTENANCE_SWEEP_FAILED', e.toString(), '');
      ErrorHandler.alertPipelineDown('Monthly Database Maintenance', `The clean sweep job encountered an error: ${e.toString()}`);
    }
  }
};
