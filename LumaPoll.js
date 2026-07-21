/**
 * LumaPoll - Polls Google Drive folder for Luma CSV exports,
 * parsing and ingesting contacts with cursor-resumable execution.
 */
const LumaPoll = {
  // Inbox and Done folder paths/names
  INBOX_FOLDER: 'Luma-Inbox',
  DONE_FOLDER: 'Luma-Done',
  PARENT_FOLDER: 'Arkay',

  // Find or create parent folder structure in Drive
  getFolder(name, parentFolder = null) {
    if (parentFolder) {
      const folders = parentFolder.getFoldersByName(name);
      if (folders.hasNext()) {
        return folders.next();
      }
      return parentFolder.createFolder(name);
    }
    const folders = Drive.getFoldersByName(name);
    if (folders.hasNext()) {
      return folders.next();
    }
    // Fallback for creation
    if (typeof DriveApp !== 'undefined') {
      return DriveApp.createFolder(name);
    }
    if (this.mockCreateFolder) {
      return this.mockCreateFolder(name);
    }
    return null;
  },

  getLumaFolders() {
    const arkayFolder = this.getFolder(this.PARENT_FOLDER);
    const inbox = this.getFolder(this.INBOX_FOLDER, arkayFolder);
    const done = this.getFolder(this.DONE_FOLDER, arkayFolder);
    return { inbox, done };
  },

  // Parse CSV string into an array of objects based on header mapping
  parseLumaCsv(fileContent) {
    const rows = Utils.parseCsv(fileContent);
    if (rows.length === 0) return [];
    
    // Normalize headers
    const headers = rows[0].map(h => h.trim().toLowerCase());
    
    const contacts = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row.length === 0 || !row.join('').trim()) continue; // Skip empty rows

      const contact = {};
      headers.forEach((header, idx) => {
        // Handle common Luma header formats
        let cleanVal = (row[idx] || '').trim();
        
        if (header.includes('email')) {
          contact.email = cleanVal;
        } else if (header.includes('first name') || header === 'firstname' || header === 'name') {
          contact.first_name = cleanVal;
        } else if (header.includes('last name') || header === 'lastname') {
          contact.last_name = cleanVal;
        } else if (header.includes('phone')) {
          contact.phone = cleanVal;
        } else if (header.includes('company')) {
          contact.company = cleanVal;
        } else if (header.includes('job title') || header.includes('role') || header === 'title') {
          contact.job_title = cleanVal;
        }
      });
      contacts.push(contact);
    }
    return contacts;
  },

  // Main polling runner
  pollInbox() {
    const folders = this.getLumaFolders();
    
    // Read cursor from script properties
    let currentFileId = Config.getProperty('LUMA_CURRENT_FILE_ID');
    let currentRowIndex = parseInt(Config.getProperty('LUMA_CURRENT_ROW_INDEX', '0'), 10);

    let fileToProcess = null;
    let eventName = '';

    if (currentFileId) {
      // Resume processing existing file
      try {
        fileToProcess = Drive.getFileById(currentFileId);
        // Deduce event name from filename (remove .csv)
        eventName = fileToProcess.getName().replace(/\.csv$/i, '');
      } catch (e) {
        // File might have been deleted or moved manually; reset cursor
        ErrorHandler.logError('LumaPoll.pollInbox', 'CURSOR_INVALID', `Failed to retrieve cursor file ID ${currentFileId}: ${e.toString()}`);
        this.clearCursor();
        currentFileId = null;
        currentRowIndex = 0;
      }
    }

    if (!fileToProcess) {
      // Find oldest unprocessed CSV in Inbox folder
      const files = folders.inbox.getFiles();
      const csvFiles = [];
      while (files.hasNext()) {
        const file = files.next();
        if (file.getName().toLowerCase().endsWith('.csv')) {
          csvFiles.push(file);
        }
      }

      // Sort by modified time ascending to process sequentially
      csvFiles.sort((a, b) => a.getLastUpdated().getTime() - b.getLastUpdated().getTime());

      if (csvFiles.length === 0) {
        // Nothing to process
        return;
      }

      fileToProcess = csvFiles[0];
      currentFileId = fileToProcess.getId();
      currentRowIndex = 0;
      eventName = fileToProcess.getName().replace(/\.csv$/i, '');
      
      // Save cursor
      Config.setProperty('LUMA_CURRENT_FILE_ID', currentFileId);
      Config.setProperty('LUMA_CURRENT_ROW_INDEX', '0');
    }

    // Process the file
    const content = fileToProcess.getBlob().getDataAsString();
    const contacts = this.parseLumaCsv(content);

    // Limit batch run to prevent execution timeout (e.g. process up to 100 rows per run)
    // If a CSV has 3,000 rows, it will take ~30 runs of 15 min, or we can adjust batch sizes.
    const batchSize = 100; 
    const startIndex = currentRowIndex;
    const endIndex = Math.min(contacts.length, startIndex + batchSize);

    for (let i = startIndex; i < endIndex; i++) {
      const raw = contacts[i];
      if (!raw.email) {
        // Skip rows without emails but log them
        ErrorHandler.logError(
          'LumaPoll.pollInbox', 
          'MISSING_ROW_EMAIL', 
          `Row ${i + 1} in Luma CSV is missing email address`, 
          JSON.stringify(raw)
        );
        continue;
      }

      raw.source = 'luma';
      raw.event_name = eventName;

      try {
        // 1. Validate / Verify (ZeroBounce check)
        let processedContact = Schema.normalizeContact(raw);
        processedContact = Verification.processVerification(processedContact);

        // 2. Atomic merge and sheet write
        const result = DedupeMerge.ingestContact(processedContact);

        // 3. EmailOctopus sync (if valid)
        if (result.contact.lifecycle_state !== 'invalid') {
          const synced = EmailOctopus.syncContact(result.contact);
          if (synced.esp_contact_id !== result.contact.esp_contact_id) {
            Database.saveContact(synced);
          }
        }
      } catch (err) {
        ErrorHandler.logError('LumaPoll.pollInbox', 'ROW_INGEST_FAILED', err.toString(), JSON.stringify(raw));
      }

      // Update cursor row index
      Config.setProperty('LUMA_CURRENT_ROW_INDEX', String(i + 1));
    }

    if (endIndex >= contacts.length) {
      // Completed the entire file! Move it to Done
      folders.done.addFile(fileToProcess);
      folders.inbox.removeFile(fileToProcess);
      
      this.clearCursor();
      
      // If there are more files in the folder, let the next run pick them up
    }
  },

  clearCursor() {
    try {
      PropertiesService.getScriptProperties().deleteProperty('LUMA_CURRENT_FILE_ID');
      PropertiesService.getScriptProperties().deleteProperty('LUMA_CURRENT_ROW_INDEX');
    } catch (e) {
      if (typeof global !== 'undefined' && global.MOCK_PROPERTIES) {
        delete global.MOCK_PROPERTIES['LUMA_CURRENT_FILE_ID'];
        delete global.MOCK_PROPERTIES['LUMA_CURRENT_ROW_INDEX'];
      }
    }
  }
};
