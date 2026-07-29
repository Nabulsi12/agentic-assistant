/**
 * Database - Supabase Knowledge Graph Access Layer
 * Replaces Google Sheets with Supabase Knowledge Graph as the primary Source of Truth.
 * Handles entity nodes (contacts, sources, events, tags), graph edges,
 * audit logs, error logs, and activity tracking via REST / PostgREST.
 */
const Database = {
  // Headers for schema reference
  CONTACT_HEADERS: [
    'email', 'email_hash', 'first_name', 'last_name', 'phone', 
    'company', 'job_title', 'source', 'event_name', 'created_at', 
    'verification_status', 'lifecycle_state', 'last_engagement_at', 
    'last_email_sent_at', 'tags', 'archived', 'esp_contact_id', 
    'error_flag', 'last_processed_at'
  ],

  ERROR_HEADERS: [
    'ts_utc', 'source', 'event_type', 'reason', 'payload_ref', 
    'retry_status', 'resolution_status'
  ],

  AUDIT_HEADERS: [
    'ts_utc', 'email', 'field_name', 'old_value', 'new_value'
  ],

  ACTIVITY_HEADERS: [
    'ts_utc', 'email', 'campaign_name', 'event_type'
  ],

  // Supabase REST Helper
  supabaseRequest(path, method = 'GET', payload = null, extraHeaders = {}) {
    const baseUrl = Config.getSupabaseUrl().replace(/\/+$/, '');
    const apiKey = Config.getSupabaseKey();
    const url = `${baseUrl}/rest/v1/${path}`;

    const headers = {
      'apikey': apiKey,
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
      ...extraHeaders
    };

    const options = {
      method: method.toUpperCase(),
      headers: headers,
      muteHttpExceptions: true
    };

    if (payload && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
      options.payload = JSON.stringify(payload);
    }

    try {
      const response = Http.fetch(url, options);
      const statusCode = response.getResponseCode();
      const contentText = response.getContentText();

      if (statusCode >= 200 && statusCode < 300) {
        return contentText ? JSON.parse(contentText) : [];
      } else {
        Logger.log(`Supabase Request Failed [${statusCode}]: ${contentText}`);
        throw new Error(`Supabase API error (${statusCode}): ${contentText}`);
      }
    } catch (e) {
      Logger.log(`Supabase fetch exception for ${url}: ${e.toString()}`);
      throw e;
    }
  },

  // Initialize Knowledge Graph tables/schema (idempotent operational verification)
  initializeDatabase() {
    Logger.log('Supabase Knowledge Graph database initialized.');
  },

  // Convert array row data to schema object (for backward compatibility if needed)
  mapRowToObject(row) {
    const obj = {};
    this.CONTACT_HEADERS.forEach((header, idx) => {
      obj[header] = row[idx];
    });
    return obj;
  },

  // Convert schema object to array row data
  mapObjectToRow(obj) {
    return this.CONTACT_HEADERS.map(header => {
      const val = obj[header];
      return val !== undefined && val !== null ? val : '';
    });
  },

  // Find a contact node by email
  findContactRowByEmail(email) {
    if (!email) return null;
    const searchEmail = email.trim().toLowerCase();

    try {
      const path = `contacts?email=eq.${encodeURIComponent(searchEmail)}`;
      const res = this.supabaseRequest(path, 'GET');

      if (Array.isArray(res) && res.length > 0) {
        const contact = res[0];
        return { rowIndex: contact.id || 1, rowData: contact };
      }
      return null;
    } catch (e) {
      Logger.log('Error looking up contact in Supabase Knowledge Graph: ' + e.toString());
      return null;
    }
  },

  // Sync Knowledge Graph Edges (Contact -> Tags, Contact -> Sources, Contact -> Events)
  syncGraphEdges(contact) {
    if (!contact || !contact.email) return;

    try {
      const email = contact.email;
      const tagList = Schema.parseTags(contact.tags || '');

      // 1. Sync Contact Tags Edges
      tagList.forEach(tagName => {
        try {
          this.supabaseRequest('contact_tags', 'POST', {
            contact_email: email,
            tag_name: tagName,
            created_at: new Date().toISOString()
          }, { 'Prefer': 'resolution=ignore-duplicates' });
        } catch (err) {
          // Ignore duplicate edge errors silently
        }
      });

      // 2. Sync Contact Source Edge
      if (contact.source) {
        try {
          this.supabaseRequest('contact_sources', 'POST', {
            contact_email: email,
            source_slug: contact.source,
            created_at: contact.created_at || new Date().toISOString()
          }, { 'Prefer': 'resolution=ignore-duplicates' });
        } catch (err) {
          // Ignore duplicate edge errors
        }
      }

      // 3. Sync Contact Event Edge
      if (contact.event_name) {
        try {
          const eventSlug = contact.event_name.toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)/g, '');
            
          this.supabaseRequest('contact_events', 'POST', {
            contact_email: email,
            event_slug: eventSlug,
            event_name: contact.event_name,
            created_at: new Date().toISOString()
          }, { 'Prefer': 'resolution=ignore-duplicates' });
        } catch (err) {
          // Ignore duplicate edge errors
        }
      }
    } catch (e) {
      Logger.log('Error syncing graph edges: ' + e.toString());
    }
  },

  // Write a contact node (update existing or insert new in Supabase Knowledge Graph)
  saveContact(contact) {
    const existing = this.findContactRowByEmail(contact.email);

    let savedContact;
    if (existing) {
      // PATCH existing contact entity node
      const path = `contacts?email=eq.${encodeURIComponent(contact.email.toLowerCase())}`;
      const res = this.supabaseRequest(path, 'PATCH', contact);
      savedContact = Array.isArray(res) && res.length > 0 ? res[0] : contact;
    } else {
      // POST new contact entity node
      const res = this.supabaseRequest('contacts', 'POST', contact, { 'Prefer': 'resolution=merge-duplicates,return=representation' });
      savedContact = Array.isArray(res) && res.length > 0 ? res[0] : contact;
    }

    // Update Knowledge Graph Edges
    this.syncGraphEdges(savedContact);
    return savedContact.id || 1;
  },

  // Retrieve all contacts matching a criteria function from Supabase
  getContacts(filterFn) {
    try {
      const res = this.supabaseRequest('contacts?select=*', 'GET');
      if (!Array.isArray(res)) return [];

      const contacts = [];
      res.forEach((contactObj, idx) => {
        if (!filterFn || filterFn(contactObj)) {
          contacts.push({ rowIndex: contactObj.id || idx + 1, data: contactObj });
        }
      });
      return contacts;
    } catch (e) {
      Logger.log('Failed to fetch contacts from Supabase: ' + e.toString());
      return [];
    }
  },

  // Log field conflict to Audit Logs entity node in Supabase
  writeAuditLog(email, fieldName, oldValue, newValue) {
    try {
      const ts = new Date().toISOString();
      const payload = {
        ts_utc: ts,
        email: email,
        field_name: fieldName,
        old_value: oldValue !== undefined && oldValue !== null ? String(oldValue) : '',
        new_value: newValue !== undefined && newValue !== null ? String(newValue) : ''
      };
      this.supabaseRequest('audit_logs', 'POST', payload);
    } catch (e) {
      Logger.log('Failed to write audit log to Supabase: ' + e.toString());
    }
  },

  // Log error payload to Error Logs entity node in Supabase
  writeErrorLog(source, eventType, reason, payloadRef, retryStatus = 'none', resolutionStatus = 'unresolved') {
    try {
      const ts = new Date().toISOString();
      const payload = {
        ts_utc: ts,
        source: source,
        event_type: eventType,
        reason: reason,
        payload_ref: payloadRef,
        retry_status: retryStatus,
        resolution_status: resolutionStatus
      };
      this.supabaseRequest('error_logs', 'POST', payload);
    } catch (e) {
      Logger.log('Failed to write error log to Supabase: ' + e.toString());
    }
  },

  // Log email campaign events to Email Activity entity node in Supabase
  writeEmailActivity(email, campaignName, eventType) {
    try {
      const ts = new Date().toISOString();
      const payload = {
        ts_utc: ts,
        email: email,
        campaign_name: campaignName,
        event_type: eventType
      };
      this.supabaseRequest('email_activities', 'POST', payload);
    } catch (e) {
      Logger.log('Failed to write email activity to Supabase: ' + e.toString());
    }
  },

  // Get last N email activity logs for a contact from Supabase Knowledge Graph
  getLastActivitiesForEmail(email, limit = 3) {
    if (!email) return [];
    try {
      const searchEmail = email.trim().toLowerCase();
      const path = `email_activities?email=eq.${encodeURIComponent(searchEmail)}&order=ts_utc.desc&limit=${limit}`;
      const res = this.supabaseRequest(path, 'GET');

      if (!Array.isArray(res)) return [];
      return res.map(act => ({
        ts: act.ts_utc,
        campaignName: act.campaign_name,
        eventType: act.event_type
      }));
    } catch (e) {
      Logger.log('Failed to fetch email activities from Supabase: ' + e.toString());
      return [];
    }
  }
};
