/**
 * OutcomeParser - Parses Gmail unread replies for WON/LOST mailto log outcomes,
 * updating contact states idempotently.
 */
const OutcomeParser = {
  // Search and parse outcome emails (runs on 15-minute cycle)
  parseGmailOutcomes() {
    const rachelEmail = Config.getCalendarOwnerEmail();
    if (!rachelEmail) return;

    // Search for unread mail to Rachel containing WON: or LOST:
    const query = `is:unread (subject:"WON:" OR subject:"LOST:")`;
    let threads = [];
    
    try {
      threads = GmailApp.search(query);
    } catch (e) {
      Logger.log('OutcomeParser: GmailApp search failed: ' + e.toString());
      return;
    }

    threads.forEach(thread => {
      try {
        const messages = thread.getMessages();
        if (messages.length === 0) return;

        // Process the latest message in the thread
        const msg = messages[messages.length - 1];
        const subject = msg.getSubject() || '';
        
        // Parse subject: e.g. "Re: WON:4a5b6c7d8e:event_id_string"
        // Regex to extract outcome, email hash, and event ID
        const match = subject.match(/(WON|LOST):([a-f0-9]+):([a-zA-Z0-9_@\-\.]+)/i);
        
        if (match) {
          const outcome = match[1].toUpperCase(); // WON or LOST
          const emailHash = match[2];
          const eventId = match[3];

          this.processOutcome(outcome, emailHash, eventId);
        }

        // Mark thread as read so it isn't parsed again
        thread.markRead();

      } catch (err) {
        ErrorHandler.logError('OutcomeParser.parseGmailOutcomes', 'PARSING_ROW_FAILED', err.toString(), thread.getFirstMessageSubject());
      }
    });
  },

  // Process specific outcome and transition state
  processOutcome(outcome, emailHash, eventId) {
    // Find contact by email hash
    const contacts = Database.getContacts(c => c.email_hash === emailHash);
    
    if (contacts.length === 0) {
      ErrorHandler.logError(
        'OutcomeParser.processOutcome', 
        'CONTACT_NOT_FOUND_FOR_HASH', 
        `No contact found for email hash: ${emailHash}`, 
        JSON.stringify({ outcome, eventId })
      );
      return;
    }

    const match = contacts[0];
    let contact = match.data;

    // State Mapping: WON -> won, LOST -> lost
    const newState = outcome === 'WON' ? 'won' : 'lost';

    // Scenario 17: Outcome logging must be idempotent
    if (contact.lifecycle_state === newState) {
      Logger.log(`Contact ${contact.email} is already in state ${newState}. No state change.`);
      return; 
    }

    // Attempt transition (transitionState handles validation & status tags)
    contact = DedupeMerge.transitionState(contact, newState, 'gmail-mailto');
    
    // Save updated contact in sheet
    Database.saveContact(contact);

    // If state became won: sync to EmailOctopus (to unsubscribe from marketing newsletters)
    // If state became lost: sync to EmailOctopus (re-nurture allows active flow)
    try {
      EmailOctopus.syncContact(contact);
    } catch (e) {
      ErrorHandler.logError('OutcomeParser.processOutcome', 'ESP_OUTCOME_SYNC_FAILED', e.toString(), contact.email);
    }

    // Clean up calendar booking properties
    try {
      PropertiesService.getScriptProperties().deleteProperty(`booking_event:${eventId}`);
      PropertiesService.getScriptProperties().deleteProperty(`booking_time:${eventId}`);
    } catch (e) {
      if (typeof global !== 'undefined' && global.MOCK_PROPERTIES) {
        delete global.MOCK_PROPERTIES[`booking_event:${eventId}`];
        delete global.MOCK_PROPERTIES[`booking_time:${eventId}`];
      }
    }

    Logger.log(`Successfully logged outcome ${outcome} for ${contact.email} (Event: ${eventId})`);
  }
};
