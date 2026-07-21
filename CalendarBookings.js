/**
 * CalendarBookings - Monitors calendar for discovery calls,
 * dispatches pre-call digests, tracks reschedules/cancellations,
 * and compiles outcome mailto links.
 */
const CalendarBookings = {
  // Check if an event matches a discovery call booking
  isDiscoveryCall(event) {
    if (!event) return false;

    // Scenario 29: Handle all-day events explicitly
    try {
      if (event.isAllDayEvent()) {
        return false; 
      }
    } catch (e) {
      Logger.log('Error checking if event is all-day: ' + e.toString());
      return false;
    }

    // 1. Title matches regex /Discovery Call/i (starts with discovery call marker)
    // Scenario 8: Must start with marker, not just contain "call"
    const title = event.getTitle() || '';
    if (!/^discovery\s+call/i.test(title.trim())) {
      return false;
    }

    // 2. Status is confirmed
    // Note: status check for event
    try {
      const status = event.getMyStatus();
      if (status === Calendar.Status.DECLINED) {
        return false;
      }
    } catch (e) {
      // ignore status check failure
    }

    // 3. Guest list check: has >= 1 guest that is not the calendar owner
    const guests = event.getGuestList();
    const ownerEmail = Config.getCalendarOwnerEmail().toLowerCase();
    
    const externalGuests = guests.filter(g => {
      const gEmail = g.getEmail().toLowerCase();
      // Owner is not external, and we ignore guests with empty emails
      return gEmail && gEmail !== ownerEmail;
    });

    return externalGuests.length > 0;
  },

  // Get the booking attendee (first external guest alphabetically)
  getBookingAttendee(event) {
    const guests = event.getGuestList();
    const ownerEmail = Config.getCalendarOwnerEmail().toLowerCase();
    
    const externalGuests = guests.filter(g => {
      const gEmail = g.getEmail().toLowerCase();
      return gEmail && gEmail !== ownerEmail;
    });

    if (externalGuests.length === 0) return null;

    // Sort alphabetically by email
    externalGuests.sort((a, b) => a.getEmail().localeCompare(b.getEmail()));
    return externalGuests[0].getEmail().toLowerCase();
  },

  // Monitors the calendar and tracks bookings (runs on calendar trigger or 15-min sync)
  syncBookings() {
    const calendarId = Config.getCalendarId();
    const calendar = Calendar.getCalendarById(calendarId);
    if (!calendar) {
      Logger.log('Calendar not found: ' + calendarId);
      return;
    }

    // Scan bookings in a window (e.g. from 2 days ago to 7 days ahead)
    const now = new Date();
    const start = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    let events = [];
    try {
      events = calendar.getEvents(start, end);
    } catch (e) {
      ErrorHandler.logError('CalendarBookings.syncBookings', 'FETCH_EVENTS_FAILED', e.toString(), '');
      return;
    }

    const currentBookingEventIds = [];

    events.forEach(event => {
      try {
        const eventId = event.getId();
        if (!this.isDiscoveryCall(event)) return;

        currentBookingEventIds.push(eventId);
        const attendeeEmail = this.getBookingAttendee(event);
        if (!attendeeEmail) return;

        // Check if we already recorded this booking
        const recordedEmailKey = `booking_event:${eventId}`;
        const recordedEmail = Config.getProperty(recordedEmailKey);
        const recordedTimeKey = `booking_time:${eventId}`;
        const recordedTime = Config.getProperty(recordedTimeKey);
        
        const eventStartTimeStr = event.getStart().toISOString();

        if (!recordedEmail) {
          // New Booking detected!
          // 1. Save reference in Script Properties
          Config.setProperty(recordedEmailKey, attendeeEmail);
          Config.setProperty(recordedTimeKey, eventStartTimeStr);

          // 2. Perform database ingestion/update
          // Lookup contact
          const match = Database.findContactRowByEmail(attendeeEmail);
          let contact;

          if (match) {
            contact = match.rowData;
            // Transition to booked state
            contact = DedupeMerge.transitionState(contact, 'booked', 'calendar-booking');
          } else {
            // Log warning 'booking_no_contact_match' but still process
            ErrorHandler.logError(
              'CalendarBookings.syncBookings',
              'booking_no_contact_match',
              `Booking found for ${attendeeEmail} but no contact exists in Master Contacts`,
              JSON.stringify({ eventId, title: event.getTitle() })
            );

            // Create minimal contact record
            contact = {
              email: attendeeEmail,
              source: 'calendar-booking',
              lifecycle_state: 'booked',
              verification_status: 'unverified'
            };
          }

          // Write contact update
          DedupeMerge.ingestContact(contact);
        } else {
          // Check for rescheduled bookings (time change)
          if (recordedTime && recordedTime !== eventStartTimeStr) {
            // Scenario 30: Start time changed -> clear digested mark to trigger re-digest!
            Config.setProperty(recordedTimeKey, eventStartTimeStr);
            try {
              PropertiesService.getScriptProperties().deleteProperty(`digest_sent:${eventId}`);
            } catch (e) {
              if (typeof global !== 'undefined' && global.MOCK_PROPERTIES) {
                delete global.MOCK_PROPERTIES[`digest_sent:${eventId}`];
              }
            }
            Logger.log(`Reschedule detected for event ${eventId}. Re-armed digest.`);
          }
        }
      } catch (err) {
        // Scenario 29: Never let one malformed event kill the polling job for others
        ErrorHandler.logError(
          'CalendarBookings.syncBookings',
          'EVENT_PROCESSING_FAILED',
          err.toString(),
          JSON.stringify({ title: event.getTitle() })
        );
      }
    });

    // Check for cancelled/deleted/declined bookings
    // We scan all recorded `booking_event:` keys in properties
    // If the event ID is not in `currentBookingEventIds`, it was deleted/declined
    this.revertCancelledBookings(currentBookingEventIds);
  },

  // Scan Script Properties to find and revert bookings that are no longer active
  revertCancelledBookings(activeEventIds) {
    try {
      let properties = {};
      try {
        properties = PropertiesService.getScriptProperties().getProperties();
      } catch (e) {
        if (typeof global !== 'undefined' && global.MOCK_PROPERTIES) {
          properties = global.MOCK_PROPERTIES;
        }
      }

      Object.keys(properties).forEach(key => {
        if (key.startsWith('booking_event:')) {
          const eventId = key.replace('booking_event:', '');
          
          if (!activeEventIds.includes(eventId)) {
            // Scenario 30: Booking was deleted, cancelled, or declined
            const contactEmail = properties[key];
            
            Logger.log(`Cancellation detected for event ${eventId} (Attendee: ${contactEmail})`);

            // 1. Revert contact to active state (if they are in booked state)
            const match = Database.findContactRowByEmail(contactEmail);
            if (match && match.rowData.lifecycle_state === 'booked') {
              let contact = match.rowData;
              contact = DedupeMerge.transitionState(contact, 'active', 'calendar-cancel');
              Database.saveContact(contact);
            }

            // 2. Clean up Script Properties
            try {
              PropertiesService.getScriptProperties().deleteProperty(`booking_event:${eventId}`);
              PropertiesService.getScriptProperties().deleteProperty(`booking_time:${eventId}`);
              PropertiesService.getScriptProperties().deleteProperty(`digest_sent:${eventId}`);
            } catch (e) {
              if (typeof global !== 'undefined' && global.MOCK_PROPERTIES) {
                delete global.MOCK_PROPERTIES[`booking_event:${eventId}`];
                delete global.MOCK_PROPERTIES[`booking_time:${eventId}`];
                delete global.MOCK_PROPERTIES[`digest_sent:${eventId}`];
              }
            }
          }
        }
      });
    } catch (err) {
      ErrorHandler.logError('CalendarBookings.revertCancelledBookings', 'REVERT_FAILED', err.toString(), '');
    }
  },

  // Scan events in the near-future and send digests if not already sent
  scanAndSendDigests() {
    const calendarId = Config.getCalendarId();
    const calendar = Calendar.getCalendarById(calendarId);
    if (!calendar) return;

    const now = new Date();
    // Scan events starting from now (or slightly in the past to catch last-minute bookings) up to 75 minutes out
    const start = new Date(now.getTime() - 15 * 60 * 1000);
    const end = new Date(now.getTime() + 75 * 60 * 1000);

    let events = [];
    try {
      events = calendar.getEvents(start, end);
    } catch (e) {
      return;
    }

    events.forEach(event => {
      try {
        const eventId = event.getId();
        if (!this.isDiscoveryCall(event)) return;

        // Check if already digested
        const digestedKey = `digest_sent:${eventId}`;
        const isDigested = Config.getProperty(digestedKey);
        
        if (!isDigested) {
          const attendeeEmail = this.getBookingAttendee(event);
          if (!attendeeEmail) return;

          // Send digest immediately
          this.sendPreCallDigest(attendeeEmail, event);

          // Mark as digested
          Config.setProperty(digestedKey, 'true');
        }
      } catch (err) {
        // Scenario 29: Do not let one error kill the loop
        ErrorHandler.logError(
          'CalendarBookings.scanAndSendDigests',
          'DIGEST_SEND_ROW_FAILED',
          err.toString(),
          JSON.stringify({ eventId: event.getId() })
        );
      }
    });
  },

  // Compile and mail the HTML digest to Rachel
  sendPreCallDigest(email, event) {
    const rachelEmail = Config.getCalendarOwnerEmail();
    if (!rachelEmail) return;

    // Retrieve contact data
    let contact;
    const match = Database.findContactRowByEmail(email);
    if (match) {
      contact = match.rowData;
    } else {
      contact = {
        email: email,
        first_name: '',
        last_name: '',
        company: '',
        job_title: '',
        source: 'calendar-booking',
        tags: '',
        lifecycle_state: 'booked'
      };
    }

    // Retrieve recent EmailOctopus/system campaign engagements
    const activities = Database.getLastActivitiesForEmail(email, 3);
    let activityHtml = '';
    
    if (activities.length > 0) {
      activities.forEach(act => {
        const dateStr = new Date(act.ts).toLocaleDateString('en-US');
        activityHtml += `
          <li style="margin-bottom: 8px; font-size: 13px;">
            <span style="font-family: 'Courier New', monospace; font-size: 11px;">[${dateStr}]</span> 
            <strong>${Schema.escapeHtml(act.campaignName)}</strong> &mdash; 
            <span style="color: #C27D53; font-family: 'Courier New', monospace; text-transform: uppercase;">${act.eventType}</span>
          </li>
        `;
      });
    } else {
      activityHtml = '<li style="font-style: italic; font-size: 13px; color: #666;">No email activity recorded</li>';
    }

    // Retrieve workshop attendance from event: tags
    const tags = Schema.parseTags(contact.tags);
    const workshops = tags
      .filter(t => t.startsWith('event:'))
      .map(t => t.replace('event:', '').replace(/-/g, ' '));
      
    let workshopHtml = '';
    if (workshops.length > 0) {
      workshops.forEach(w => {
        workshopHtml += `<span style="display: inline-block; background-color: #FAF9F6; border: 1px solid #D1CDC4; padding: 4px 8px; font-size: 11px; font-family: 'Courier New', monospace; margin-right: 5px; margin-bottom: 5px; text-transform: uppercase;">${Schema.escapeHtml(w)}</span>`;
      });
    } else {
      workshopHtml = '<span style="font-style: italic; font-size: 13px; color: #666;">None</span>';
    }

    // Build mailto outcome links
    // Scenario 16: Must encode specific contact and event ID in mailto link
    const emailHash = contact.email_hash || email;
    const eventId = event.getId();
    
    const wonSubject = encodeURIComponent(`WON:${emailHash}:${eventId}`);
    const lostSubject = encodeURIComponent(`LOST:${emailHash}:${eventId}`);
    
    const wonMailto = `mailto:${rachelEmail}?subject=${wonSubject}&body=Confirming%20client%20won.%20Please%20do%20not%20edit%20the%20subject%20line.`;
    const lostMailto = `mailto:${rachelEmail}?subject=${lostSubject}&body=Confirming%20client%20lost.%20Please%20do%20not%20edit%20the%20subject%20line.`;

    // Design branding HTML (Section 17)
    const bodyHtml = `
      <div style="background-color: #F4F1EA; padding: 30px; font-family: Georgia, serif; color: #1A1A1A; max-width: 600px; margin: 0 auto; border: 1px solid #D1CDC4;">
        <span style="font-family: 'Courier New', monospace; font-size: 11px; letter-spacing: 2px; color: #C27D53; font-weight: bold; display: block; margin-bottom: 10px;">PRE-CALL BRIEFING</span>
        
        <h2 style="font-family: Garamond, Georgia, serif; font-size: 26px; color: #1A1A1A; margin-top: 0; font-weight: normal; border-bottom: 1px solid #D1CDC4; padding-bottom: 10px;">
          ${Schema.escapeHtml(contact.first_name || '')} ${Schema.escapeHtml(contact.last_name || '') || 'Prospect'}
        </h2>
        
        <div style="margin: 20px 0;">
          <table style="width: 100%; font-size: 14px; line-height: 1.6;">
            <tr>
              <td style="width: 100px; font-family: 'Courier New', monospace; font-size: 11px; color: #C27D53; font-weight: bold;">EMAIL</td>
              <td>${Schema.escapeHtml(contact.email)}</td>
            </tr>
            <tr>
              <td style="font-family: 'Courier New', monospace; font-size: 11px; color: #C27D53; font-weight: bold;">COMPANY</td>
              <td>${Schema.escapeHtml(contact.company || 'Unknown')}</td>
            </tr>
            <tr>
              <td style="font-family: 'Courier New', monospace; font-size: 11px; color: #C27D53; font-weight: bold;">JOB TITLE</td>
              <td>${Schema.escapeHtml(contact.job_title || 'Unknown')}</td>
            </tr>
            <tr>
              <td style="font-family: 'Courier New', monospace; font-size: 11px; color: #C27D53; font-weight: bold;">SOURCE</td>
              <td style="text-transform: uppercase; font-family: 'Courier New', monospace; font-size: 12px;">${Schema.escapeHtml(contact.source)}</td>
            </tr>
          </table>
        </div>

        <hr style="border: 0; border-top: 1px solid #D1CDC4; margin: 20px 0;" />

        <h3 style="font-family: Garamond, Georgia, serif; font-size: 18px; font-weight: normal; color: #1A1A1A;">Workshop Attendance</h3>
        <div style="margin-bottom: 20px;">
          ${workshopHtml}
        </div>

        <h3 style="font-family: Garamond, Georgia, serif; font-size: 18px; font-weight: normal; color: #1A1A1A;">Recent Campaign History</h3>
        <ul style="padding-left: 20px; margin-bottom: 30px;">
          ${activityHtml}
        </ul>

        <hr style="border: 0; border-top: 1px solid #D1CDC4; margin: 20px 0;" />

        <h3 style="font-family: Garamond, Georgia, serif; font-size: 18px; font-weight: normal; color: #1A1A1A; margin-bottom: 15px;">Log Discovery Call Outcome</h3>
        <p style="font-size: 13px; color: #555; line-height: 1.5; margin-bottom: 20px;">Click one of the buttons below to log the outcome of this call. This will automatically update the prospect's status and trigger the appropriate email flows.</p>
        
        <table style="width: 100%;">
          <tr>
            <td style="width: 50%; text-align: center;">
              <a href="${wonMailto}" style="display: block; background-color: #FAF9F6; border: 1px solid #D1CDC4; color: #1A1A1A; padding: 12px; font-family: 'Courier New', monospace; font-weight: bold; font-size: 13px; text-decoration: none; text-transform: uppercase;">
                &bull; Client Won &bull;
              </a>
            </td>
            <td style="width: 50%; text-align: center;">
              <a href="${lostMailto}" style="display: block; background-color: #FAF9F6; border: 1px solid #D1CDC4; color: #C27D53; padding: 12px; font-family: 'Courier New', monospace; font-weight: bold; font-size: 13px; text-decoration: none; text-transform: uppercase;">
                &bull; Client Lost &bull;
              </a>
            </td>
          </tr>
        </table>
      </div>
    `;

    try {
      const timeStr = event.getStart().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      Mail.sendEmail({
        to: rachelEmail,
        subject: `[BRIEF] Discovery Call at ${timeStr} with ${contact.first_name || 'Prospect'}`,
        htmlBody: bodyHtml
      });
    } catch (e) {
      ErrorHandler.logError('CalendarBookings.sendPreCallDigest', 'SEND_DIGEST_EMAIL_FAILED', e.toString(), email);
    }
  }
};
