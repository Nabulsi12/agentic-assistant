/**
 * Maintenance - Monthly Maintenance & Cleanup Engine
 * Runs 1st of month at 02:00 AM America/Chicago.
 * Finds subscribers who have gone dark for 60 days (created > 60d AND no engagement in 60d),
 * double-checks email via ZeroBounce, applies a 20% circuit breaker to prevent mass deletion,
 * archives inactive profiles in Supabase Knowledge Graph, and notifies Rachel.
 */
const Maintenance = {
  cleanHouse() {
    const now = new Date();
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    // 1. Fetch all active, unarchived contacts from Supabase Knowledge Graph
    const activeContacts = Database.getContacts(c => c.lifecycle_state === 'active' && !c.archived);
    const totalActiveCount = activeContacts.length;

    if (totalActiveCount === 0) {
      Logger.log('Maintenance Skipped: No active subscribers.');
      return { archivedCount: 0, reason: 'no_active_contacts' };
    }

    // 2. Identify candidates for stale-60
    // Rule: Must have NO engagement in 60 days AND were created more than 60 days ago
    const staleCandidates = [];
    activeContacts.forEach(match => {
      const c = match.data;
      const createdAt = new Date(c.created_at || now.toISOString());
      
      let lastEngagedAt = null;
      if (c.last_engagement_at) {
        lastEngagedAt = new Date(c.last_engagement_at);
      }

      // Check if created > 60 days ago
      if (createdAt <= sixtyDaysAgo) {
        // Check if zero engagement in 60 days
        if (!lastEngagedAt || lastEngagedAt <= sixtyDaysAgo) {
          staleCandidates.push(c);
        }
      }
    });

    // 3. CIRCUIT BREAKER (Scenario 37 / Spec Gap 8)
    // If a single run would archive > 20% of the active audience, STOP, change nothing, and alert Rachel!
    const percentStale = (staleCandidates.length / totalActiveCount) * 100;
    if (percentStale > 20.0) {
      const alertMsg = `CRITICAL CIRCUIT BREAKER TRIGGERED: Monthly maintenance sweep identified ${staleCandidates.length} stale contacts out of ${totalActiveCount} active contacts (${percentStale.toFixed(1)}% > 20% limit). Execution halted automatically to prevent mass lead destruction. Please inspect tracking setup.`;
      
      Database.writeErrorLog('Maintenance.cleanHouse', 'CIRCUIT_BREAKER_TRIGGERED', alertMsg, JSON.stringify({ staleCount: staleCandidates.length, totalActive: totalActiveCount }));
      
      ErrorHandler.alertPipelineDown('CRITICAL: Maintenance Circuit Breaker Triggered', alertMsg);
      return { halted: true, reason: 'circuit_breaker_triggered', percentStale };
    }

    // 4. Double-check email validity via ZeroBounce & Archive stale contacts in Supabase
    let archivedCount = 0;
    staleCandidates.forEach(contact => {
      // Double check verification
      const verified = Verification.processVerification(contact);
      
      if (verified.verification_status !== 'valid') {
        // Archive in Supabase Knowledge Graph
        verified.archived = true;
        verified.lifecycle_state = 'archived';
        verified.last_processed_at = new Date().toISOString();
        Database.saveContact(verified);
        archivedCount++;
      }
    });

    // 5. Send summary email to Rachel
    const liveListSize = totalActiveCount - archivedCount;
    Mail.sendEmail({
      to: Config.getCalendarOwnerEmail(),
      subject: 'Monthly Maintenance Summary Report',
      body: `Monthly house cleaning completed.\n\nContacts Archived: ${archivedCount}\nRemaining Live List Size: ${liveListSize}`
    });

    Config.setProperty('last_run:maintenance', now.toISOString());
    return { success: true, archivedCount, liveListSize };
  }
};

