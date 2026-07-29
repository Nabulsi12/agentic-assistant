/**
 * OutcomeParser - Parses call outcomes (WON / LOST / NO-SHOW)
 * and updates contact lifecycle state in the Supabase Knowledge Graph idempotently.
 */
const OutcomeParser = {
  // Process outcome update
  processOutcome(email, outcomeResult) {
    if (!email || !outcomeResult) return { success: false, reason: 'missing_parameters' };
    const searchEmail = email.trim().toLowerCase();
    const result = outcomeResult.trim().toLowerCase();

    const match = Database.findContactRowByEmail(searchEmail);
    if (!match) {
      Database.writeErrorLog('OutcomeParser.processOutcome', 'CONTACT_NOT_FOUND', `Attempted to set outcome '${result}' for unknown email ${searchEmail}`, searchEmail);
      return { success: false, reason: 'contact_not_found' };
    }

    const contact = match.rowData;
    const previousState = contact.lifecycle_state;

    let targetState = '';
    if (result === 'won') {
      targetState = 'won';
    } else if (result === 'lost') {
      targetState = 'lost';
    } else if (result === 'no-show' || result === 'active') {
      targetState = 'active';
    } else {
      return { success: false, reason: 'invalid_outcome_result' };
    }

    // Idempotent: If already in target state, return success without duplicate logs
    if (previousState === targetState) {
      return { success: true, contact, unchanged: true };
    }

    // Transition state
    contact.lifecycle_state = targetState;
    contact.last_processed_at = new Date().toISOString();

    // Log to Supabase audit log
    Database.writeAuditLog(searchEmail, 'lifecycle_state', previousState, targetState);

    // Save updated contact in Supabase Knowledge Graph
    Database.saveContact(contact);

    return { success: true, contact, previousState, targetState };
  }
};

