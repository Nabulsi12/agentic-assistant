/**
 * Config - System Configuration Management
 * Uses PropertiesService to read script-level properties/secrets.
 */
const Config = {
  // Get a script property or return a default
  getProperty(key, defaultValue = '') {
    try {
      const val = PropertiesService.getScriptProperties().getProperty(key);
      return val !== null && val !== undefined ? val : defaultValue;
    } catch (e) {
      // In testing environments or local runner, fallback to standard object if properties service is mock
      return typeof global !== 'undefined' && global.MOCK_PROPERTIES && global.MOCK_PROPERTIES[key] !== undefined
        ? global.MOCK_PROPERTIES[key]
        : defaultValue;
    }
  },

  // Set a script property
  setProperty(key, value) {
    try {
      PropertiesService.getScriptProperties().setProperty(key, value);
    } catch (e) {
      if (typeof global !== 'undefined' && global.MOCK_PROPERTIES) {
        global.MOCK_PROPERTIES[key] = value;
      }
    }
  },

  // API Keys & Secrets
  getZeroBounceApiKey() {
    return this.getProperty('ZEROBOUNCE_API_KEY');
  },

  getEmailOctopusApiKey() {
    return this.getProperty('EO_API_KEY');
  },

  getEmailOctopusWebhookSecret() {
    return this.getProperty('EO_WEBHOOK_SECRET');
  },

  getEmailOctopusNewsletterAutomationId() {
    return this.getProperty('EO_NEWSLETTER_AUTOMATION_ID');
  },

  // Ingestion & Automation Settings
  getNewsletterSendMode() {
    return this.getProperty('EO_SEND_MODE', 'auto'); // 'auto' or 'manual'
  },

  getRssUrl() {
    return this.getProperty('RSS_URL', 'https://example.com/feed');
  },

  getCalendarId() {
    return this.getProperty('CALENDAR_ID', 'primary');
  },

  getCalendarOwnerEmail() {
    // If not specified, try to fetch current user's email, otherwise fallback
    let defaultEmail = '';
    try {
      defaultEmail = Session.getActiveUser().getEmail();
    } catch (e) {
      // ignore
    }
    return this.getProperty('CALENDAR_OWNER_EMAIL', defaultEmail);
  },

  // Spreadsheet settings
  getMasterSpreadsheetId() {
    return this.getProperty('MASTER_SPREADSHEET_ID');
  },

  // Timezone setting
  getTimeZone() {
    return this.getProperty('TIMEZONE', 'America/Chicago');
  }
};
