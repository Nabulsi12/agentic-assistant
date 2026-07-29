/**
 * CalendarBookings - Calendar Booking Detection & Pre-Call Digest Engine
 * Detects discovery calls, updates state in Supabase Knowledge Graph,
 * and sends Rachel a warm-neutral pre-call digest email 60-75 mins before the call.
 */
const CalendarBookings = {
  // Check if calendar event is a discovery call booking
  isDiscoveryCall(event) {
    if (!event) return false;
    
    // Rule: Must be a confirmed event with title starting with "Discovery Call" (case-insensitive)
    const title = (event.getTitle() || '').trim();
    if (!/^Discovery Call/i.test(title)) {
      return false;
    }

    // Must not be an all-day event
    if (event.isAllDayEvent()) {
      return false;
    }

    // Must have at least one external guest (domain != arkay domain)
    const ownerEmail = Config.getCalendarOwnerEmail();
    const ownerDomain = ownerEmail.includes('@') ? ownerEmail.split('@')[1].toLowerCase() : 'arkaysolutions.com';

    const guests = event.getGuestList();
    const externalGuests = guests.filter(g => {
      const email = g.getEmail().toLowerCase();
      const domain = email.includes('@') ? email.split('@')[1] : '';
      return domain !== ownerDomain;
    });

    return externalGuests.length > 0;
  },

  // Get external guest email for booking
  getExternalGuestEmail(event) {
    const ownerEmail = Config.getCalendarOwnerEmail();
    const ownerDomain = ownerEmail.includes('@') ? ownerEmail.split('@')[1].toLowerCase() : 'arkaysolutions.com';

    const guests = event.getGuestList();
    const externalGuests = guests.filter(g => {
      const email = g.getEmail().toLowerCase();
      const domain = email.includes('@') ? email.split('@')[1] : '';
      return domain !== ownerDomain;
    });

    if (externalGuests.length === 0) return null;
    // Alphabetical first guest
    externalGuests.sort((a, b) => a.getEmail().localeCompare(b.getEmail()));
    return externalGuests[0].getEmail().toLowerCase();
  },

  // Scan calendar for new/rescheduled discovery calls
  syncBookings() {
    const calendarId = Config.getCalendarId();
    const calendar = Calendar.getCalendarById(calendarId);
    if (!calendar) return;

    // Look at events starting in the next 14 days
    const now = new Date();
    const future = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
    const events = calendar.getEvents(now, future);

    events.forEach(evt => {
      if (this.isDiscoveryCall(evt)) {
        const guestEmail = this.getExternalGuestEmail(evt);
        if (!guestEmail) return;

        const existing = Database.findContactRowByEmail(guestEmail);
        
        let contact;
        if (existing) {
          contact = existing.rowData;
          // Set state to booked in Supabase Knowledge Graph
          contact.lifecycle_state = 'booked';
          contact.last_processed_at = new Date().toISOString();
          Database.saveContact(contact);
        } else {
          // Minimal contact record created for calendar booking
          contact = Schema.normalizeContact({
            email: guestEmail,
            source: 'calendar-booking',
            lifecycle_state: 'booked'
          });
          Database.saveContact(contact);
        }

        // Save booking details to properties for digest tracking
        const eventId = evt.getId();
        Config.setProperty(`booking_guest:${eventId}`, guestEmail);
        Config.setProperty(`booking_time:${eventId}`, evt.getStart().toISOString());
      }
    });
  },

  // Generate warm-neutral HTML Pre-Call Digest for Rachel
  buildDigestHtml(contact, eventTime, activities, eventsAttended) {
    const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'Prospective Lead';
    const email = contact.email;
    const company = contact.company || 'Not Specified';
    const jobTitle = contact.job_title || 'Not Specified';
    const formattedTime = new Date(eventTime).toLocaleString('en-US', { timeZone: Config.getTimeZone(), dateStyle: 'full', timeStyle: 'short' });
    const webAppUrl = Config.getProperty('WEB_APP_URL', 'https://script.google.com/macros/s/123/exec');

    // Mailto links for WON / LOST outcome logging
    const wonSubject = encodeURIComponent(`OUTCOME: WON [${email}]`);
    const lostSubject = encodeURIComponent(`OUTCOME: LOST [${email}]`);
    const wonLink = `${webAppUrl}?action=outcome&email=${encodeURIComponent(email)}&result=won`;
    const lostLink = `${webAppUrl}?action=outcome&email=${encodeURIComponent(email)}&result=lost`;

    let activityRowsHtml = '';
    if (activities && activities.length > 0) {
      activityRowsHtml = activities.map(a => `
        <div style="border-bottom: 1px solid #D1CDC4; padding: 6px 0;">
          <span style="font-family: monospace; font-size: 11px; color: #C27D53;">[${new Date(a.ts).toLocaleDateString()}]</span>
          <strong>${Schema.escapeHtml(a.campaignName)}</strong> - <em>${Schema.escapeHtml(a.eventType)}</em>
        </div>
      `).join('');
    } else {
      activityRowsHtml = '<p style="color: #666;">No recent email activity recorded.</p>';
    }

    let eventsRowsHtml = '';
    if (eventsAttended && eventsAttended.length > 0) {
      eventsRowsHtml = eventsAttended.map(ev => `<span style="background: #FAF9F6; border: 1px solid #D1CDC4; padding: 2px 6px; font-family: monospace; font-size: 11px; margin-right: 4px;">${Schema.escapeHtml(ev)}</span>`).join(' ');
    } else {
      eventsRowsHtml = '<span style="color: #666;">No workshops registered</span>';
    }

    return `
      <div style="background-color: #F4F1EA; padding: 24px; font-family: Georgia, serif; color: #1A1A1A;">
        <div style="background-color: #FAF9F6; border: 1px solid #D1CDC4; padding: 20px; max-width: 600px; margin: 0 auto;">
          <p style="font-family: monospace; font-size: 12px; color: #C27D53; letter-spacing: 1px;">PRE-CALL BRIEFING</p>
          <h2 style="font-family: Garamond, Georgia, serif; margin-top: 0; color: #1A1A1A;">${Schema.escapeHtml(name)}</h2>
          <p style="margin: 4px 0;"><strong>Email:</strong> ${Schema.escapeHtml(email)}</p>
          <p style="margin: 4px 0;"><strong>Company:</strong> ${Schema.escapeHtml(company)}</p>
          <p style="margin: 4px 0;"><strong>Title:</strong> ${Schema.escapeHtml(jobTitle)}</p>
          <p style="margin: 4px 0;"><strong>Scheduled Time:</strong> ${formattedTime}</p>
          
          <hr style="border: 0; border-top: 1px solid #D1CDC4; margin: 16px 0;" />
          
          <p style="font-family: monospace; font-size: 11px; color: #C27D53;">WORKSHOPS ATTENDED</p>
          <div>${eventsRowsHtml}</div>
          
          <hr style="border: 0; border-top: 1px solid #D1CDC4; margin: 16px 0;" />
          
          <p style="font-family: monospace; font-size: 11px; color: #C27D53;">RECENT EMAIL ENGAGEMENT</p>
          <div>${activityRowsHtml}</div>
          
          <hr style="border: 0; border-top: 1px solid #D1CDC4; margin: 20px 0;" />
          
          <p style="font-family: monospace; font-size: 11px; color: #C27D53;">LOG CALL OUTCOME</p>
          <div style="margin-top: 10px;">
            <a href="${wonLink}" style="background-color: #1A1A1A; color: #F4F1EA; padding: 10px 16px; text-decoration: none; font-weight: bold; margin-right: 12px; display: inline-block;">MARK CLIENT WON</a>
            <a href="${lostLink}" style="background-color: #C27D53; color: #FFFFFF; padding: 10px 16px; text-decoration: none; font-weight: bold; display: inline-block;">MARK CLIENT LOST</a>
          </div>
        </div>
      </div>
    `;
  },

  // Scan calendar and dispatch digests for calls starting within 60-75 minutes (or immediate if < 60m out)
  scanAndSendDigests() {
    const calendarId = Config.getCalendarId();
    const calendar = Calendar.getCalendarById(calendarId);
    if (!calendar) return;

    const now = new Date();
    const lookAhead = new Date(now.getTime() + 75 * 60 * 1000);
    const events = calendar.getEvents(now, lookAhead);

    events.forEach(evt => {
      if (!this.isDiscoveryCall(evt)) return;

      const eventId = evt.getId();
      const isDigestSent = Config.getProperty(`digest_sent:${eventId}`);
      if (isDigestSent === 'true') return; // Already sent digest for this booking slot

      const guestEmail = this.getExternalGuestEmail(evt);
      if (!guestEmail) return;

      const existingMatch = Database.findContactRowByEmail(guestEmail);
      const contact = existingMatch ? existingMatch.rowData : Schema.normalizeContact({ email: guestEmail, source: 'calendar-booking' });

      // Fetch last 3 email activities from Supabase Knowledge Graph
      const activities = Database.getLastActivitiesForEmail(guestEmail, 3);

      // Fetch attended events from Supabase Knowledge Graph
      let attendedEvents = [];
      try {
        const path = `contact_events?contact_email=eq.${encodeURIComponent(guestEmail)}`;
        const res = Database.supabaseRequest(path, 'GET');
        if (Array.isArray(res)) {
          attendedEvents = res.map(r => r.event_name || r.event_slug);
        }
      } catch (err) {
        // ignore
      }

      // Render digest and send to Rachel
      const digestHtml = this.buildDigestHtml(contact, evt.getStart().toISOString(), activities, attendedEvents);
      const recipient = Config.getCalendarOwnerEmail();

      Mail.sendEmail({
        to: recipient,
        subject: `Pre-Call Briefing: Discovery Call with ${contact.first_name || guestEmail}`,
        htmlBody: digestHtml
      });

      // Mark digest sent for this event ID
      Config.setProperty(`digest_sent:${eventId}`, 'true');
    });
  }
};
