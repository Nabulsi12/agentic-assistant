/**
 * Services - Dependency Abstraction Layer for Google Apps Script Globals.
 * Allows easy mocking of network, email, calendar, drive, and utility services in tests.
 */

const Http = {
  fetch(url, options) {
    if (this.mockFetch) {
      return this.mockFetch(url, options);
    }
    return UrlFetchApp.fetch(url, options);
  }
};

const Mail = {
  sendEmail(options) {
    if (this.mockSendEmail) {
      return this.mockSendEmail(options);
    }
    return MailApp.sendEmail(options);
  }
};

const Gmail = {
  search(query) {
    if (this.mockSearch) {
      return this.mockSearch(query);
    }
    return GmailApp.search(query);
  }
};

const Calendar = {
  getCalendarById(id) {
    if (this.mockGetCalendarById) {
      return this.mockGetCalendarById(id);
    }
    return CalendarApp.getCalendarById(id);
  }
};

const Drive = {
  getFileById(id) {
    if (this.mockGetFileById) {
      return this.mockGetFileById(id);
    }
    return DriveApp.getFileById(id);
  },
  getFoldersByName(name) {
    if (this.mockGetFoldersByName) {
      return this.mockGetFoldersByName(name);
    }
    return DriveApp.getFoldersByName(name);
  }
};

const Utils = {
  sleep(ms) {
    if (this.mockSleep) {
      return this.mockSleep(ms);
    }
    Utilities.sleep(ms);
  },
  
  parseCsv(csvContent) {
    if (this.mockParseCsv) {
      return this.mockParseCsv(csvContent);
    }
    return Utilities.parseCsv(csvContent);
  },
  
  computeDigest(algorithm, value, charset) {
    if (this.mockComputeDigest) {
      return this.mockComputeDigest(algorithm, value, charset);
    }
    return Utilities.computeDigest(algorithm, value, charset);
  },
  
  computeHmacSignature(algorithm, value, key, charset) {
    if (this.mockComputeHmacSignature) {
      return this.mockComputeHmacSignature(algorithm, value, key, charset);
    }
    return Utilities.computeHmacSignature(algorithm, value, key, charset);
  }
};

const Cache = {
  getScriptCache() {
    if (this.mockGetScriptCache) {
      return this.mockGetScriptCache();
    }
    return CacheService.getScriptCache();
  }
};
