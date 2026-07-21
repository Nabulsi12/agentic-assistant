/**
 * Database - Sheet Access Layer
 * Handles schema initialization, lock-wrapped CRUD operations,
 * and sheets mapping.
 */
const Database = {
  // Headers for Master Contacts sheet
  CONTACT_HEADERS: [
    'email', 'email_hash', 'first_name', 'last_name', 'phone', 
    'company', 'job_title', 'source', 'event_name', 'created_at', 
    'verification_status', 'lifecycle_state', 'last_engagement_at', 
    'last_email_sent_at', 'tags', 'archived', 'esp_contact_id', 
    'error_flag', 'last_processed_at'
  ],

  // Headers for Error Log sheet
  ERROR_HEADERS: [
    'ts_utc', 'source', 'event_type', 'reason', 'payload_ref', 
    'retry_status', 'resolution_status'
  ],

  // Headers for Audit Log sheet
  AUDIT_HEADERS: [
    'ts_utc', 'email', 'field_name', 'old_value', 'new_value'
  ],

  // Headers for Email Activity sheet
  ACTIVITY_HEADERS: [
    'ts_utc', 'email', 'campaign_name', 'event_type'
  ],

  // Get active or configured spreadsheet
  getSpreadsheet() {
    const id = Config.getMasterSpreadsheetId();
    if (id) {
      return SpreadsheetApp.openById(id);
    }
    return SpreadsheetApp.getActiveSpreadsheet();
  },

  // Helper to get or create sheet by name
  getOrCreateSheet(name, headers) {
    const ss = this.getSpreadsheet();
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      sheet.appendRow(headers);
    }
    return sheet;
  },

  getContactsSheet() {
    return this.getOrCreateSheet('Master Contacts', this.CONTACT_HEADERS);
  },

  getErrorLogSheet() {
    return this.getOrCreateSheet('Error Log', this.ERROR_HEADERS);
  },

  getAuditLogSheet() {
    return this.getOrCreateSheet('Audit Log', this.AUDIT_HEADERS);
  },

  getEmailActivitySheet() {
    return this.getOrCreateSheet('Email Activity', this.ACTIVITY_HEADERS);
  },

  // Initialize all sheets and headers (idempotent setup)
  initializeDatabase() {
    this.getContactsSheet();
    this.getErrorLogSheet();
    this.getAuditLogSheet();
    this.getEmailActivitySheet();
  },

  // Find a contact row by email hash or email
  findContactRowByEmail(email) {
    const sheet = this.getContactsSheet();
    const data = sheet.getDataRange().getValues();
    const emailIndex = this.CONTACT_HEADERS.indexOf('email');
    
    const searchEmail = email.trim().toLowerCase();
    for (let i = 1; i < data.length; i++) {
      if (data[i][emailIndex] && data[i][emailIndex].toString().trim().toLowerCase() === searchEmail) {
        return { rowIndex: i + 1, rowData: this.mapRowToObject(data[i]) };
      }
    }
    return null;
  },

  // Convert array row data to schema object
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

  // Write a contact row (update existing or append new)
  saveContact(contact) {
    const sheet = this.getContactsSheet();
    const match = this.findContactRowByEmail(contact.email);
    const rowValues = this.mapObjectToRow(contact);

    if (match) {
      // Update existing row
      const range = sheet.getRange(match.rowIndex, 1, 1, this.CONTACT_HEADERS.length);
      range.setValues([rowValues]);
      return match.rowIndex;
    } else {
      // Insert new row
      sheet.appendRow(rowValues);
      return sheet.getLastRow();
    }
  },

  // Retrieve all contacts matching a criteria function
  getContacts(filterFn) {
    const sheet = this.getContactsSheet();
    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) return [];

    const contacts = [];
    for (let i = 1; i < data.length; i++) {
      const contact = this.mapRowToObject(data[i]);
      if (!filterFn || filterFn(contact)) {
        contacts.push({ rowIndex: i + 1, data: contact });
      }
    }
    return contacts;
  },

  // Log to Audit Log
  writeAuditLog(email, fieldName, oldValue, newValue) {
    const sheet = this.getAuditLogSheet();
    const ts = new Date().toISOString();
    
    // Sanitize values starting with =, +, -, @ to prevent formula injection
    const sanitize = (val) => {
      if (typeof val === 'string' && /^[=+\-@]/.test(val)) {
        return "'" + val;
      }
      return val;
    };

    sheet.appendRow([ts, email, fieldName, sanitize(oldValue), sanitize(newValue)]);
  },

  // Log to Email Activity Sheet
  writeEmailActivity(email, campaignName, eventType) {
    try {
      const sheet = this.getEmailActivitySheet();
      const ts = new Date().toISOString();
      sheet.appendRow([ts, email, campaignName, eventType]);
    } catch (e) {
      Logger.log('Failed to write email activity: ' + e.toString());
    }
  },

  // Get last N activities for an email
  getLastActivitiesForEmail(email, limit = 3) {
    try {
      const sheet = this.getEmailActivitySheet();
      const data = sheet.getDataRange().getValues();
      if (data.length <= 1) return [];

      const searchEmail = email.trim().toLowerCase();
      const activities = [];

      // Scan backwards to get recent events
      for (let i = data.length - 1; i >= 1; i--) {
        if (data[i][1] && data[i][1].toString().trim().toLowerCase() === searchEmail) {
          activities.push({
            ts: data[i][0],
            campaignName: data[i][2],
            eventType: data[i][3]
          });
          if (activities.length >= limit) break;
        }
      }
      return activities;
    } catch (e) {
      Logger.log('Failed to fetch email activities: ' + e.toString());
      return [];
    }
  },

  // Log to Error Log
  writeErrorLog(source, eventType, reason, payloadRef, retryStatus = 'none', resolutionStatus = 'unresolved') {
    const sheet = this.getErrorLogSheet();
    const ts = new Date().toISOString();
    sheet.appendRow([ts, source, eventType, reason, payloadRef, retryStatus, resolutionStatus]);
  }
};
