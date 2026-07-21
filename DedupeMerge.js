/**
 * DedupeMerge - Handles deduplication, merging of fields,
 * state transition validation, audit logging, and locking.
 */
const DedupeMerge = {
  // Allowed state transitions from the lifecycle state model
  ALLOWED_TRANSITIONS: {
    'new': ['verified', 'invalid'],
    'verified': ['active'],
    'invalid': ['new', 'booked'], // Bookings win over invalid/bounce flag
    'active': ['booked', 'stale-60', 'archived'],
    'booked': ['won', 'lost', 'active'], // Outcome logged / no-show returns to active
    'won': [], // Terminal
    'lost': ['active'],
    'stale-60': ['active', 'archived'],
    'archived': ['active']
  },

  // Check if a state transition is valid
  isValidTransition(fromState, toState) {
    if (fromState === toState) return true;
    const allowed = this.ALLOWED_TRANSITIONS[fromState];
    return allowed ? allowed.indexOf(toState) !== -1 : false;
  },

  // Perform safe state transition update
  transitionState(contact, newState, source = 'system') {
    const currentState = contact.lifecycle_state;
    if (currentState === newState) return contact;

    if (this.isValidTransition(currentState, newState)) {
      contact.lifecycle_state = newState;
      
      // Update the status tag: status:{state} (exactly ONE; mirrors lifecycle_state)
      const currentTags = Schema.parseTags(contact.tags);
      // Remove old status tag
      const filteredTags = currentTags.filter(t => !t.startsWith('status:'));
      // Add new status tag
      filteredTags.push(`status:${newState}`);
      
      contact.tags = Schema.formatTags(filteredTags);
      contact.last_processed_at = new Date().toISOString();
      return contact;
    } else {
      // Log illegal transition and keep contact untouched
      ErrorHandler.logError(
        'DedupeMerge.transitionState', 
        'ILLEGAL_STATE_TRANSITION', 
        `Rejected illegal state transition for ${contact.email}: ${currentState} -> ${newState}`, 
        JSON.stringify({ email: contact.email, current: currentState, attempted: newState })
      );
      return contact; // Untouched
    }
  },

  // Merge incoming contact data into existing contact data
  merge(existing, incoming) {
    const isLinkedIn = incoming.source === 'linkedin-manual';
    const merged = { ...existing };

    // Core mutable fields to merge: first_name, last_name, phone, company, job_title
    const coreFields = ['first_name', 'last_name', 'phone', 'company', 'job_title'];

    coreFields.forEach(field => {
      const incomingVal = String(incoming[field] || '').trim();
      const existingVal = String(existing[field] || '').trim();

      if (!incomingVal) {
        // Blank incoming never overwrites populated existing
        return;
      }

      if (!existingVal) {
        // Existing is blank, update with incoming
        merged[field] = incomingVal;
      } else if (existingVal !== incomingVal) {
        // Both non-blank and they differ
        if (isLinkedIn) {
          // LinkedIn manual imports never overwrite populated core fields
          return;
        }
        
        // Incoming (newer) wins; write prior value to audit log
        merged[field] = incomingVal;
        Database.writeAuditLog(existing.email, field, existingVal, incomingVal);
      }
    });

    // Stable fields (email, created_at, source history): existing wins, never overwritten
    // Source history accumulates via source tags (union tags handles it)
    
    // Accumulate tags: union(existing, incoming)
    // Note: status tags, event tags, source tags are handled by unions
    // Add incoming source tag if present
    let incomingTags = Schema.parseTags(incoming.tags);
    if (incoming.source) {
      incomingTags.push(`source:${incoming.source}`);
    }
    if (incoming.event_name) {
      // slugify event name (e.g. "Workshop July" -> "event:workshop-july")
      const eventSlug = incoming.event_name.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
      incomingTags.push(`event:${eventSlug}`);
    }

    merged.tags = Schema.unionTags(existing.tags, Schema.formatTags(incomingTags));

    // Handle lifecycle state transition
    // If incoming attempts to set a state (e.g. from calendar booking setting state to 'booked')
    if (incoming.lifecycle_state && incoming.lifecycle_state !== 'new') {
      const transitioned = this.transitionState(merged, incoming.lifecycle_state, incoming.source);
      merged.lifecycle_state = transitioned.lifecycle_state;
      merged.tags = transitioned.tags;
    }

    // Keep verification status if existing is already verified
    if (existing.verification_status !== 'unverified' && incoming.verification_status === 'unverified') {
      // Keep existing verification
    } else if (incoming.verification_status !== 'unverified') {
      merged.verification_status = incoming.verification_status;
    }

    // Capture ESP contact ID if empty in existing but present in incoming
    if (!existing.esp_contact_id && incoming.esp_contact_id) {
      merged.esp_contact_id = incoming.esp_contact_id;
    }

    // Capture last_engagement_at and last_email_sent_at if newer
    if (incoming.last_engagement_at) {
      merged.last_engagement_at = incoming.last_engagement_at;
    }
    if (incoming.last_email_sent_at) {
      merged.last_email_sent_at = incoming.last_email_sent_at;
    }

    merged.last_processed_at = new Date().toISOString();
    return merged;
  },

  // Atomic lookup-and-write (wraps the lookup-merge-write in a script lock)
  ingestContact(rawInput) {
    const lock = LockService.getScriptLock();
    let lockAcquired = false;
    
    try {
      // Wait up to 10 seconds for concurrent tasks to clear
      lock.waitLock(10000);
      lockAcquired = true;

      // 1. Normalize raw input to our schema
      const incoming = Schema.normalizeContact(rawInput);
      
      // 2. Lookup existing contact
      const match = Database.findContactRowByEmail(incoming.email);
      
      let finalContact;
      if (match) {
        // Merge field-by-field
        finalContact = this.merge(match.rowData, incoming);
      } else {
        // Set initial status tag for new contact
        const tagsList = Schema.parseTags(incoming.tags);
        tagsList.push(`source:${incoming.source}`);
        tagsList.push(`status:${incoming.lifecycle_state}`);
        if (incoming.event_name) {
          const eventSlug = incoming.event_name.toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '');
          tagsList.push(`event:${eventSlug}`);
        }
        
        incoming.tags = Schema.formatTags(tagsList);
        finalContact = incoming;
      }

      // 3. Write to Google Sheets
      const rowIndex = Database.saveContact(finalContact);
      return { contact: finalContact, rowIndex, isUpdate: !!match };

    } catch (e) {
      // Log errors
      ErrorHandler.logError('DedupeMerge.ingestContact', 'INGEST_FAILED', e.toString(), JSON.stringify(rawInput));
      throw e;
    } finally {
      if (lockAcquired) {
        lock.releaseLock();
      }
    }
  }
};
