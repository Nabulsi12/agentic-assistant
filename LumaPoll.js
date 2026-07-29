/**
 * LumaPoll - Polls Google Drive folder for Luma CSV exports,
 * parsing and ingesting contacts & event graph edges into Supabase Knowledge Graph.
 * Supports cursor-resumable batch processing.
 */
const LumaPoll = {
  INBOX_FOLDER: 'Luma-Inbox',
  DONE_FOLDER: 'Luma-Done',
  PARENT_FOLDER: 'Arkay',

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

  parseLumaCsv(fileContent) {
    const rows = Utils.parseCsv(fileContent);
    if (rows.length === 0) return [];
    
    const headers = rows[0].map(h => h.trim().toLowerCase());
    const contacts = [];
    
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row.length === 0 || !row.join('').trim()) continue;

      const contact = {};
      headers.forEach((header, idx) => {
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
    
    let currentFileId = Config.getProperty('LUMA_CURRENT_FILE_ID');
    let currentRowIndex = parseInt(Config.getProperty('LUMA_CURRENT_ROW_INDEX', '0'), 10);

    let fileToProcess = null;
    let eventName = '';

    if (currentFileId) {
      try {
        fileToProcess = Drive.getFileById(currentFileId);
        eventName = fileToProcess.getName().replace(/\.csv$/i, '');
      } catch (e) {
        Database.writeErrorLog('LumaPoll.pollInbox', 'CURSOR_INVALID', `Failed to retrieve cursor file ID ${currentFileId}: ${e.toString()}`);
        this.clearCursor();
        currentFileId = null;
        currentRowIndex = 0;
      }
    }

    if (!fileToProcess) {
      const files = folders.inbox.getFiles();
      const csvFiles = [];
      while (files.hasNext()) {
        const file = files.next();
        if (file.getName().toLowerCase().endsWith('.csv')) {
          csvFiles.push(file);
        }
      }

      csvFiles.sort((a, b) => a.getLastUpdated().getTime() - b.getLastUpdated().getTime());

      if (csvFiles.length === 0) {
        return;
      }

      fileToProcess = csvFiles[0];
      currentFileId = fileToProcess.getId();
      currentRowIndex = 0;
      eventName = fileToProcess.getName().replace(/\.csv$/i, '');
      
      Config.setProperty('LUMA_CURRENT_FILE_ID', currentFileId);
      Config.setProperty('LUMA_CURRENT_ROW_INDEX', '0');
    }

    const content = fileToProcess.getBlob().getDataAsString();
    const contacts = this.parseLumaCsv(content);

    const batchSize = 100; 
    const startIndex = currentRowIndex;
    const endIndex = Math.min(contacts.length, startIndex + batchSize);

    for (let i = startIndex; i < endIndex; i++) {
      const raw = contacts[i];
      if (!raw.email) {
        Database.writeErrorLog('LumaPoll.pollInbox', 'MISSING_ROW_EMAIL', `Row ${i + 1} in Luma CSV is missing email address`, JSON.stringify(raw));
        continue;
      }

      raw.source = 'luma';
      raw.event_name = eventName;

      try {
        // Ingest into Supabase Knowledge Graph via ContactManager
        const result = ContactManager.ingestContact(raw);

        // Sync to EmailOctopus if valid
        if (result.contact.verification_status !== 'invalid') {
          try {
            const synced = EmailOctopus.syncContact(result.contact);
            if (synced.esp_contact_id && synced.esp_contact_id !== result.contact.esp_contact_id) {
              Database.saveContact(synced);
            }
          } catch (eoErr) {
            // ignore non-fatal ESP sync warning
          }
        }
      } catch (err) {
        Database.writeErrorLog('LumaPoll.pollInbox', 'ROW_INGEST_FAILED', err.toString(), JSON.stringify(raw));
      }

      Config.setProperty('LUMA_CURRENT_ROW_INDEX', String(i + 1));
    }

    if (endIndex >= contacts.length) {
      folders.done.addFile(fileToProcess);
      folders.inbox.removeFile(fileToProcess);
      this.clearCursor();
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

