/**
 * EmailOctopus - Wrapper for the EmailOctopus v1.1 API
 */
const EmailOctopus = {
  // Helper to retrieve List ID from config
  getListId() {
    const listId = Config.getProperty('EO_LIST_ID');
    if (!listId) {
      throw new Error('EO_LIST_ID is not configured in Script Properties');
    }
    return listId;
  },

  // Simple rate-limiting helper: sleeps to maintain under 10 requests/second (100ms interval)
  throttle() {
    Utils.sleep(110);
  },

  // Generic request handler
  request(method, endpoint, payload = null) {
    const apiKey = Config.getEmailOctopusApiKey();
    if (!apiKey) {
      throw new Error('EO_API_KEY is not configured in Script Properties');
    }

    const url = `https://emailoctopus.com/api/1.1/${endpoint}`;
    
    const options = {
      method: method,
      contentType: 'application/json',
      muteHttpExceptions: true
    };

    if (payload) {
      // Inject api_key into body payload for POST/PUT
      payload.api_key = apiKey;
      options.payload = JSON.stringify(payload);
    } else {
      // For GET/DELETE, append api_key to URL
      const sep = url.indexOf('?') === -1 ? '?' : '&';
      options.url = `${url}${sep}api_key=${apiKey}`;
    }

    this.throttle();
    const response = Http.fetch(options.url || url, options);
    const code = response.getResponseCode();
    const responseText = response.getContentText();

    let json = {};
    try {
      json = JSON.parse(responseText);
    } catch (e) {
      // ignore
    }

    return { code, text: responseText, json };
  },

  // Lookup member ID by email
  getContactByEmail(email) {
    const listId = this.getListId();
    const emailEncoded = encodeURIComponent(email.trim().toLowerCase());
    const res = this.request('get', `lists/${listId}/contacts/by-email/${emailEncoded}`);
    
    if (res.code === 200) {
      return res.json;
    }
    return null;
  },

  // Sync a single contact to EmailOctopus (Upsert)
  syncContact(contact) {
    const listId = this.getListId();
    
    // Status mapping:
    // If contact is invalid/archived, status is unsubscribed. Otherwise subscribed.
    // Note: status is set to unsubscribed for invalid contacts so the ESP blocks sends.
    let status = 'subscribed';
    if (contact.lifecycle_state === 'invalid' || contact.archived) {
      status = 'unsubscribed';
    }

    // Format fields
    const fields = {
      FirstName: contact.first_name || '',
      LastName: contact.last_name || ''
    };

    // Include tags
    const tags = Schema.parseTags(contact.tags);

    const payload = {
      email_address: contact.email,
      fields: fields,
      tags: tags,
      status: status
    };

    // First attempt to create contact (POST)
    let res = this.request('post', `lists/${listId}/contacts`, payload);

    if (res.code === 200) {
      // Created successfully
      contact.esp_contact_id = res.json.id;
      return contact;
    }

    // Check if error is because member already exists
    const isMemberExists = res.code === 400 && 
      res.json.error && 
      (res.json.error.code === 'MEMBER_EXISTS_WITH_EMAIL_ADDRESS' || 
       res.json.error.code === 'CONTACT_ALREADY_EXISTS');

    if (isMemberExists) {
      // Lookup the contact ID
      const existingMember = this.getContactByEmail(contact.email);
      if (existingMember) {
        contact.esp_contact_id = existingMember.id;
        
        // Update contact (PUT)
        const updatePayload = {
          fields: fields,
          tags: tags,
          status: status
        };
        
        const updateRes = this.request('put', `lists/${listId}/contacts/${existingMember.id}`, updatePayload);
        if (updateRes.code === 200) {
          return contact;
        } else {
          throw new Error(`EmailOctopus PUT update failed for ${contact.email}: ${updateRes.text}`);
        }
      }
    }

    throw new Error(`EmailOctopus sync failed for ${contact.email}: ${res.text}`);
  },

  // Update specific fields (e.g. for newsletter HTML/subject field-writes)
  updateCustomFields(espContactId, fieldsMap, addTags = [], removeTags = []) {
    const listId = this.getListId();
    
    // Retrieve the current contact's tags if we need to modify them
    // Note: EmailOctopus v1.1 PUT replaces the whole tag set, so we fetch first
    let tags = [];
    const resGet = this.request('get', `lists/${listId}/contacts/${espContactId}`);
    if (resGet.code === 200) {
      tags = resGet.json.tags || [];
    }

    // Apply add/remove logic
    addTags.forEach(t => {
      if (!tags.includes(t)) tags.push(t);
    });
    tags = tags.filter(t => !removeTags.includes(t));

    const payload = {
      fields: fieldsMap,
      tags: tags
    };

    const res = this.request('put', `lists/${listId}/contacts/${espContactId}`, payload);
    if (res.code !== 200) {
      throw new Error(`EmailOctopus custom fields update failed for ${espContactId}: ${res.text}`);
    }
  },

  // Perform bulk tags update or field writes using rate limit throttling
  bulkSyncContacts(contacts) {
    const updated = [];
    contacts.forEach(c => {
      try {
        const synched = this.syncContact(c);
        updated.push(synched);
      } catch (e) {
        ErrorHandler.logError('EmailOctopus.bulkSyncContacts', 'BULK_SYNC_ROW_FAILED', e.toString(), JSON.stringify({ email: c.email }));
      }
    });
    return updated;
  }
};
