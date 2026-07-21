/**
 * Verification - ZeroBounce Integration & Email Filtration
 */
const Verification = {
  // Map ZeroBounce verdicts to our taxonomy
  mapVerdict(status, subStatus) {
    const s = String(status || '').toLowerCase();
    const sub = String(subStatus || '').toLowerCase();

    if (s === 'valid') {
      return 'valid';
    }
    if (s === 'invalid') {
      return 'invalid';
    }
    if (s === 'catch-all' || s === 'unknown') {
      return 'risky';
    }
    if (s === 'do_not_mail' || s === 'abuse') {
      return 'invalid';
    }
    return 'risky'; // Fallback
  },

  // Tag helper to manage retry counts
  getRetryCount(tagsStr) {
    const tags = Schema.parseTags(tagsStr);
    const match = tags.find(t => t.startsWith('zb-retry:'));
    if (match) {
      return parseInt(match.split(':')[1], 10) || 0;
    }
    return 0;
  },

  incrementRetryCount(tagsStr) {
    const tags = Schema.parseTags(tagsStr);
    const count = this.getRetryCount(tagsStr) + 1;
    const cleanTags = tags.filter(t => !t.startsWith('zb-retry:'));
    cleanTags.push(`zb-retry:${count}`);
    return Schema.formatTags(cleanTags);
  },

  // Call ZeroBounce single-email API via UrlFetchApp
  verifyEmail(email) {
    // 1. Syntactic check first to avoid consuming paid credits
    if (!Schema.isValidEmail(email)) {
      return { status: 'invalid', sub_status: 'malformed_syntax' };
    }

    const apiKey = Config.getZeroBounceApiKey();
    if (!apiKey) {
      // Missing API key in settings
      throw new Error('ZEROBOUNCE_API_KEY is not configured');
    }

    const url = `https://api.zerobounce.net/v2/validate?api_key=${apiKey}&email=${encodeURIComponent(email)}&ip_address=`;
    
    // UrlFetchApp with timeout (default Apps Script is up to 60s, we handle timeout via try-catch)
    const options = {
      method: 'get',
      muteHttpExceptions: true
    };

    const response = Http.fetch(url, options);
    const code = response.getResponseCode();

    if (code !== 200) {
      throw new Error(`ZeroBounce API returned HTTP code ${code}`);
    }

    return JSON.parse(response.getContentText());
  },

  // Main verification procedure for a contact
  processVerification(contact) {
    try {
      // Call ZeroBounce single-email verification (wrapped in retry helper if needed)
      // Section 10: "Timeout 10s. On timeout / 5xx / quota: set risky, queue for retry next run."
      // Since UrlFetchApp doesn't support short custom timeouts natively, we simulate or handle exceptions.
      const result = this.verifyEmail(contact.email);
      
      const verdict = this.mapVerdict(result.status, result.sub_status);
      contact.verification_status = verdict;
      
      if (verdict === 'invalid') {
        // Section 10: "lifecycle_state=invalid; ESP status=unsubscribed; tag flag:invalid-undeliverable"
        contact = DedupeMerge.transitionState(contact, 'invalid', 'zerobounce');
        const tags = Schema.parseTags(contact.tags);
        tags.push('flag:invalid-undeliverable');
        contact.tags = Schema.formatTags(tags);
      } else if (verdict === 'valid') {
        // If state was 'new', transition to 'verified'
        if (contact.lifecycle_state === 'new') {
          contact = DedupeMerge.transitionState(contact, 'verified', 'zerobounce');
        }
      } else if (verdict === 'risky') {
        // Treat as risky: allowed to sync but bulk sends suppressed
        // If state was 'new', transition to 'verified' (since risky sync is allowed)
        if (contact.lifecycle_state === 'new') {
          contact = DedupeMerge.transitionState(contact, 'verified', 'zerobounce');
        }
      }
      
      contact.last_processed_at = new Date().toISOString();
      return contact;
      
    } catch (e) {
      // API call failed due to timeout, 5xx, or quota
      ErrorHandler.logError(
        'Verification.processVerification', 
        'API_FAILURE', 
        `ZeroBounce check failed for ${contact.email}: ${e.toString()}`,
        JSON.stringify({ email: contact.email })
      );

      // Section 10: "On timeout / 5xx / quota: set risky, queue for retry next run."
      // We set status to risky and increment retry tag
      contact.verification_status = 'risky';
      contact.tags = this.incrementRetryCount(contact.tags);
      
      // Still set lifecycle_state to verified so they are saved and sync is allowed
      if (contact.lifecycle_state === 'new') {
        contact = DedupeMerge.transitionState(contact, 'verified', 'zerobounce');
      }
      
      contact.last_processed_at = new Date().toISOString();
      return contact;
    }
  },

  // Perform re-verification for queue/stale contacts (runs monthly or scheduled)
  reVerifyPending() {
    // Select contacts who need verification:
    // - verification_status == 'risky' AND zb-retry < 3
    const riskyContacts = Database.getContacts(c => {
      if (c.verification_status !== 'risky' || c.archived) return false;
      const retries = this.getRetryCount(c.tags);
      return retries < 3;
    });

    riskyContacts.forEach(match => {
      let contact = match.data;
      
      // Re-verify
      contact = this.processVerification(contact);
      
      // Update database
      Database.saveContact(contact);
    });
  }
};
