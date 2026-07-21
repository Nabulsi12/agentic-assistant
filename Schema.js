/**
 * Schema - Unified Data Dictionary & Normalization Rules
 */
const Schema = {
  // Validate email syntax (RFC-5322 approximation)
  isValidEmail(email) {
    if (!email || typeof email !== 'string') return false;
    const re = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
    return re.test(email.trim());
  },

  // Normalization rule for names: preserve internal capitals, capitalize boundaries
  toTitleCase(str) {
    if (!str || typeof str !== 'string') return '';
    return str.split(/(\s+|-)/).map(part => {
      if (/^(\s+|-)$/.test(part)) return part; // Keep spaces and hyphens as-is
      if (part.length === 0) return '';
      
      const firstChar = part.charAt(0).toUpperCase();
      const rest = part.slice(1);
      
      // Preserve internal capitals (e.g. McLeod, O'Brien)
      const hasInternalCapital = /[A-Z]/.test(rest);
      if (hasInternalCapital) {
        return firstChar + rest;
      } else {
        return firstChar + rest.toLowerCase();
      }
    }).join('');
  },

  // E.164 phone normalization (robust, doesn't reject contact if unparseable)
  normalizePhone(phone) {
    if (!phone) return '';
    const trimmed = String(phone).trim();
    const digits = trimmed.replace(/[^0-9]/g, '');
    
    if (digits.length === 10) {
      return '+1' + digits;
    }
    if (digits.length === 11 && digits.startsWith('1')) {
      return '+' + digits;
    }
    if (/^\+[1-9]\d{1,14}$/.test(trimmed)) {
      return trimmed;
    }
    return trimmed; // Return raw value as fallback if it is non-standard
  },

  // Tags list helpers
  parseTags(tagStr) {
    if (!tagStr || typeof tagStr !== 'string') return [];
    return tagStr.split(';').map(t => t.trim()).filter(Boolean);
  },

  formatTags(tagArray) {
    if (!tagArray || !Array.isArray(tagArray)) return '';
    const unique = [...new Set(tagArray.map(t => t.trim()).filter(Boolean))];
    return unique.sort().join(';');
  },

  unionTags(existingStr, incomingStr) {
    const existing = this.parseTags(existingStr);
    const incoming = this.parseTags(incomingStr);
    return this.formatTags(existing.concat(incoming));
  },

  // Prevent spreadsheet formula injection (=, +, -, @)
  sanitizeForSheet(val) {
    if (val === undefined || val === null) return '';
    const str = String(val);
    if (/^[=+\-@]/.test(str)) {
      return "'" + str;
    }
    return str;
  },

  // HTML escaping for safe emails
  escapeHtml(val) {
    if (val === undefined || val === null) return '';
    return String(val)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  },

  // Normalize an incoming object to the unified schema
  normalizeContact(raw) {
    const email = String(raw.email || '').trim().toLowerCase();
    if (!email) {
      throw new Error('missing_email_column');
    }
    if (!this.isValidEmail(email)) {
      throw new Error('invalid_email_format');
    }

    // Derive email MD5 hash
    // MD5 is not native to standard JS, so we use Apps Script Utilities if available
    let emailHash = '';
    try {
      const signature = Utils.computeDigest(Utilities.DigestAlgorithm.MD5, email, Utilities.Charset.UTF_8);
      emailHash = signature.map(byte => {
        let val = (byte & 0xff).toString(16);
        return val.length === 1 ? '0' + val : val;
      }).join('');
    } catch (e) {
      // Fallback for local node runner or mock
      emailHash = email; // or mock MD5 in testing
    }

    const first_name = this.toTitleCase(raw.first_name || '');
    const last_name = this.toTitleCase(raw.last_name || '');
    const phone = this.normalizePhone(raw.phone || '');
    const company = String(raw.company || '').trim();
    const job_title = String(raw.job_title || '').trim();

    // Default status & state mapping
    const source = raw.source || 'google-form';
    const event_name = raw.event_name || '';
    const created_at = raw.created_at || new Date().toISOString();
    const verification_status = raw.verification_status || 'unverified';
    const lifecycle_state = raw.lifecycle_state || 'new';
    
    // Engagement / Tracking
    const last_engagement_at = raw.last_engagement_at || '';
    const last_email_sent_at = raw.last_email_sent_at || '';
    const tags = this.formatTags(this.parseTags(raw.tags || ''));
    const archived = raw.archived === true || raw.archived === 'true';
    const esp_contact_id = raw.esp_contact_id || '';
    const error_flag = raw.error_flag === true || raw.error_flag === 'true';
    const last_processed_at = new Date().toISOString();

    return {
      email,
      email_hash: emailHash,
      first_name,
      last_name,
      phone,
      company,
      job_title,
      source,
      event_name,
      created_at,
      verification_status,
      lifecycle_state,
      last_engagement_at,
      last_email_sent_at,
      tags,
      archived,
      esp_contact_id,
      error_flag,
      last_processed_at
    };
  }
};
