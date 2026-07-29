/**
 * Triggers - Installable Google Apps Script Trigger Setup & Orchestrator
 */
const Triggers = {
  // Set up all installable triggers (Run once by admin Ali/Devi)
  setupTriggers() {
    this.deleteAllTriggers();

    // 1. Calendar update trigger for discovery bookings
    ScriptApp.newTrigger('onCalendarEventUpdated')
      .forUserCalendar(Config.getCalendarOwnerEmail())
      .onEventUpdated()
      .create();

    // 2. Time-driven poll for Luma folder (every 15 mins)
    ScriptApp.newTrigger('onLumaPollTrigger')
      .timeBased()
      .everyMinutes(15)
      .create();

    // 3. Time-driven scanner for CalendarPreCall Digests (every 15 mins)
    ScriptApp.newTrigger('onCalendarDigestTrigger')
      .timeBased()
      .everyMinutes(15)
      .create();

    // 4. Weekly Newsletter trigger (Thursday 09:00 America/Chicago)
    ScriptApp.newTrigger('onWeeklyNewsletterTrigger')
      .timeBased()
      .onWeekDay(ScriptApp.WeekDay.THURSDAY)
      .atHour(9)
      .inTimezone(Config.getTimeZone())
      .create();

    // 5. Weekly Performance Report trigger (Monday 08:00 America/Chicago)
    ScriptApp.newTrigger('onWeeklyReportTrigger')
      .timeBased()
      .onWeekDay(ScriptApp.WeekDay.MONDAY)
      .atHour(8)
      .inTimezone(Config.getTimeZone())
      .create();

    // 6. Monthly Maintenance trigger (1st of month at 02:00 AM)
    ScriptApp.newTrigger('onMonthlyMaintenanceTrigger')
      .timeBased()
      .onMonthDay(1)
      .atHour(2)
      .inTimezone(Config.getTimeZone())
      .create();

    Logger.log('All Apps Script triggers created successfully.');
  },

  deleteAllTriggers() {
    const triggers = ScriptApp.getProjectTriggers();
    triggers.forEach(t => ScriptApp.deleteTrigger(t));
  }
};

// Global trigger handler functions
function onFormSubmitTrigger(e) {
  GoogleForms.handleFormSubmit(e);
}

function onCalendarEventUpdated(e) {
  CalendarBookings.syncBookings();
  CalendarBookings.scanAndSendDigests();
}

function onLumaPollTrigger() {
  LumaPoll.pollInbox();
}

function onCalendarDigestTrigger() {
  CalendarBookings.syncBookings();
  CalendarBookings.scanAndSendDigests();
}

function onWeeklyNewsletterTrigger() {
  Newsletter.runWeeklyBroadcaster();
}

function onWeeklyReportTrigger() {
  Reports.generateWeeklyReport();
}

function onMonthlyMaintenanceTrigger() {
  Maintenance.cleanHouse();
}

