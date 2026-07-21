/**
 * LinkedInImport - Manages manual imports of LinkedIn connection lists.
 */
const LinkedInImport = {
  // Strip emojis, control chars, and double spaces
  cleanString(str) {
    if (!str || typeof str !== 'string') return '';
    
    // Strip control characters: ASCII 0-31 and 127
    let clean = str.replace(/[\x00-\x1F\x7F]/g, '');
    
    // Strip emojis (broad unicode range match)
    clean = clean.replace(/[\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDC00-\uDFFF]/g, '');
    
    // Replace double spaces and trim
    return clean.replace(/\s+/g, ' ').trim();
  },

  // Perform import from a file ID in Drive
  importFile(fileId) {
    const file = Drive.getFileById(fileId);
    const content = file.getBlob().getDataAsString();
    const rows = Utils.parseCsv(content);

    if (rows.length === 0) return;

    const headers = rows[0].map(h => this.cleanString(h).toLowerCase());
    
    // Resume cursors for long imports (Scenario 9)
    const cursorPropName = `LINKEDIN_CURSOR_${fileId}`;
    let startIndex = parseInt(Config.getProperty(cursorPropName, '1'), 10);

    const batchSize = 100;
    const endIndex = Math.min(rows.length, startIndex + batchSize);

    for (let i = startIndex; i < endIndex; i++) {
      const row = rows[i];
      if (row.length === 0 || !row.join('').trim()) continue;

      const raw = {};
      headers.forEach((header, idx) => {
        const val = this.cleanString(row[idx] || '');
        if (header.includes('email')) {
          raw.email = val;
        } else if (header.includes('first name') || header === 'firstname' || header === 'first_name') {
          raw.first_name = val;
        } else if (header.includes('last name') || header === 'lastname' || header === 'last_name') {
          raw.last_name = val;
        } else if (header.includes('phone')) {
          raw.phone = val;
        } else if (header.includes('company')) {
          raw.company = val;
        } else if (header.includes('job title') || header.includes('role') || header === 'title') {
          raw.job_title = val;
        }
      });

      if (!raw.email) {
        ErrorHandler.logError('LinkedInImport.importFile', 'SKIP_ROW_MISSING_EMAIL', `Row ${i + 1} missing email`, JSON.stringify(raw));
        continue;
      }

      raw.source = 'linkedin-manual';

      try {
        // 1. Verify (ZeroBounce)
        let processedContact = Schema.normalizeContact(raw);
        processedContact = Verification.processVerification(processedContact);

        // 2. Ingest (DedupeMerge ensures tag-only merge for linkedin-manual source)
        const result = DedupeMerge.ingestContact(processedContact);

        // 3. EmailOctopus Sync (if valid)
        if (result.contact.lifecycle_state !== 'invalid') {
          const synced = EmailOctopus.syncContact(result.contact);
          if (synced.esp_contact_id !== result.contact.esp_contact_id) {
            Database.saveContact(synced);
          }
        }
      } catch (err) {
        ErrorHandler.logError('LinkedInImport.importFile', 'ROW_INGEST_FAILED', err.toString(), JSON.stringify(raw));
      }
    }

    if (endIndex >= rows.length) {
      // Completed! Remove cursor
      try {
        PropertiesService.getScriptProperties().deleteProperty(cursorPropName);
      } catch (e) {
        // ignore
      }
      // Inform Admin of completion
      Logger.log(`LinkedIn import completed for file ${file.getName()}`);
    } else {
      // Update cursor
      Config.setProperty(cursorPropName, String(endIndex));
      // Re-trigger itself or let schedule handle it
      Logger.log(`LinkedIn import progress saved at row ${endIndex} for file ${file.getName()}`);
    }
  }
};
