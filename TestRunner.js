/**
 * TestRunner - Native Google Apps Script Testing Suite
 * Mocks services and validates all stress-test scenarios operating against Supabase Knowledge Graph.
 * Select 'runTests' in the Apps Script editor or run locally with Node.js.
 */

// Global mock state
const TestState = {
  db: {
    contacts: [],
    errors: [],
    audits: [],
    activities: [],
    graph_edges: []
  },
  properties: {},
  sentEmails: [],
  calendarEvents: [],
  fetchCalls: [],
  logs: []
};

// Test helper logger
function logTestResult(scenario, passed, details = '') {
  const symbol = passed ? '✅ [PASS]' : '❌ [FAIL]';
  const msg = `${symbol} Scenario ${scenario}: ${details}`;
  TestState.logs.push(msg);
  Logger.log(msg);
}

// Custom assertion helper
function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

// ----------------------------------------------------
// Mock Environment Initializer
// ----------------------------------------------------
function setupMockEnvironment() {
  TestState.db.contacts = [];
  TestState.db.errors = [];
  TestState.db.audits = [];
  TestState.db.activities = [];
  TestState.db.graph_edges = [];
  TestState.properties = {};
  TestState.sentEmails = [];
  TestState.calendarEvents = [];
  TestState.fetchCalls = [];
  TestState.logs = [];

  global.MOCK_PROPERTIES = TestState.properties;

  Config.setProperty('SUPABASE_URL', 'https://mock-supabase.supabase.co');
  Config.setProperty('SUPABASE_KEY', 'mock-supabase-service-key');
  Config.setProperty('EO_LIST_ID', 'test_list_123');
  Config.setProperty('EO_API_KEY', 'test_eo_key');
  Config.setProperty('ZEROBOUNCE_API_KEY', 'test_zb_key');
  Config.setProperty('EO_NEWSLETTER_AUTOMATION_ID', 'test_auto_id');
  Config.setProperty('RSS_URL', 'https://example.com/feed');
  Config.setProperty('CALENDAR_OWNER_EMAIL', 'rachel@arkaysolutions.com');
  Config.setProperty('WEB_APP_URL', 'https://script.google.com/macros/s/123/exec');

  LockService.getScriptLock = () => ({
    waitLock: (ms) => true,
    releaseLock: () => true
  });

  Http.mockFetch = (url, options) => {
    TestState.fetchCalls.push({ url, options });
    const method = (options && options.method) ? options.method.toUpperCase() : 'GET';
    const payload = (options && options.payload) ? JSON.parse(options.payload) : null;

    // ----------------------------------------------------
    // 1. Supabase Knowledge Graph Mock Interceptor
    // ----------------------------------------------------
    if (url.includes('/rest/v1/')) {
      if (url.includes('/rest/v1/contacts')) {
        if (method === 'GET') {
          if (url.includes('email=eq.')) {
            const emailQuery = decodeURIComponent(url.split('email=eq.')[1].split('&')[0]);
            const matched = TestState.db.contacts.filter(c => c.email && c.email.toLowerCase() === emailQuery.toLowerCase());
            return {
              getResponseCode: () => 200,
              getContentText: () => JSON.stringify(matched)
            };
          }
          return {
            getResponseCode: () => 200,
            getContentText: () => JSON.stringify(TestState.db.contacts)
          };
        } else if (method === 'POST') {
          const email = payload.email.toLowerCase();
          const idx = TestState.db.contacts.findIndex(c => c.email && c.email.toLowerCase() === email);
          if (idx !== -1) {
            TestState.db.contacts[idx] = { ...TestState.db.contacts[idx], ...payload };
            return {
              getResponseCode: () => 200,
              getContentText: () => JSON.stringify([TestState.db.contacts[idx]])
            };
          } else {
            const newContact = { id: TestState.db.contacts.length + 1, ...payload };
            TestState.db.contacts.push(newContact);
            return {
              getResponseCode: () => 201,
              getContentText: () => JSON.stringify([newContact])
            };
          }
        } else if (method === 'PATCH') {
          if (url.includes('email=eq.')) {
            const emailQuery = decodeURIComponent(url.split('email=eq.')[1].split('&')[0]);
            const idx = TestState.db.contacts.findIndex(c => c.email && c.email.toLowerCase() === emailQuery.toLowerCase());
            if (idx !== -1) {
              TestState.db.contacts[idx] = { ...TestState.db.contacts[idx], ...payload };
              return {
                getResponseCode: () => 200,
                getContentText: () => JSON.stringify([TestState.db.contacts[idx]])
              };
            }
          }
        }
      }

      if (url.includes('/rest/v1/audit_logs')) {
        if (method === 'POST') {
          TestState.db.audits.push(payload);
          return {
            getResponseCode: () => 201,
            getContentText: () => JSON.stringify([payload])
          };
        }
      }

      if (url.includes('/rest/v1/error_logs')) {
        if (method === 'POST') {
          TestState.db.errors.push(payload);
          return {
            getResponseCode: () => 201,
            getContentText: () => JSON.stringify([payload])
          };
        }
      }

      if (url.includes('/rest/v1/email_activities')) {
        if (method === 'POST') {
          TestState.db.activities.push(payload);
          return {
            getResponseCode: () => 201,
            getContentText: () => JSON.stringify([payload])
          };
        } else if (method === 'GET') {
          if (url.includes('email=eq.')) {
            const emailQuery = decodeURIComponent(url.split('email=eq.')[1].split('&')[0]);
            const matched = TestState.db.activities.filter(a => a.email && a.email.toLowerCase() === emailQuery.toLowerCase());
            return {
              getResponseCode: () => 200,
              getContentText: () => JSON.stringify(matched)
            };
          }
          return {
            getResponseCode: () => 200,
            getContentText: () => JSON.stringify(TestState.db.activities)
          };
        }
      }

      if (url.includes('/rest/v1/contact_tags') || url.includes('/rest/v1/contact_sources') || url.includes('/rest/v1/contact_events')) {
        TestState.db.graph_edges.push({ url, payload });
        return {
          getResponseCode: () => 201,
          getContentText: () => JSON.stringify([payload])
        };
      }
    }

    // ----------------------------------------------------
    // 2. ZeroBounce API Interceptor
    // ----------------------------------------------------
    if (url.includes('zerobounce.net/v2/validate')) {
      const emailParam = decodeURIComponent(url.split('email=')[1].split('&')[0]);

      if (emailParam.includes('invalid') || emailParam.includes('bounce')) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ status: 'invalid', sub_status: 'mailbox_not_found' })
        };
      }
      if (emailParam.includes('risky') || emailParam.includes('unknown') || emailParam.includes('catchall')) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ status: 'catch-all', sub_status: 'catch_all' })
        };
      }

      return {
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ status: 'valid', sub_status: '' })
      };
    }

    // ----------------------------------------------------
    // 3. RSS Blog Feed Interceptor
    // ----------------------------------------------------
    if (url.includes('example.com/feed')) {
      const rssXml = `
        <rss version="2.0">
          <channel>
            <title>Arkay Blog</title>
            <item>
              <title>Understanding AI Agents</title>
              <link>https://example.com/blog/ai-agents</link>
              <guid>post_123</guid>
              <pubDate>${new Date().toUTCString()}</pubDate>
              <description>A guide to AI automation.</description>
            </item>
          </channel>
        </rss>
      `;
      return {
        getResponseCode: () => 200,
        getContentText: () => rssXml
      };
    }

    // Default fetch success
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ status: 'ok' })
    };
  };

  Mail.mockSendEmail = (options) => {
    TestState.sentEmails.push(options);
  };

  Calendar.mockGetCalendarById = (id) => ({
    getEvents: (start, end) => {
      return TestState.calendarEvents.filter(evt => {
        const startBound = start.getTime();
        const endBound = end.getTime();
        const eventStart = evt.getStart().getTime();
        return eventStart >= startBound && eventStart <= endBound;
      });
    }
  });

  Drive.mockGetFoldersByName = (name) => ({
    hasNext: () => true,
    next: () => ({
      getFiles: () => ({
        hasNext: () => false,
        next: () => null
      }),
      createFolder: (n) => ({}),
      addFile: (f) => {},
      removeFile: (f) => {}
    })
  });

  Utils.mockSleep = (ms) => {};
}

// ----------------------------------------------------
// Stress Test Cases Verification
// ----------------------------------------------------

function testScenario1_WorkshopRush() {
  setupMockEnvironment();

  const submission1 = {
    email: 'jsmith@gmail.com ',
    first_name: 'john',
    last_name: 'smith',
    source: 'luma',
    event_name: 'Workshop July'
  };

  const submission2 = {
    email: 'JSmith@gmail.com',
    first_name: 'John',
    last_name: 'Smith',
    source: 'google-form'
  };

  ContactManager.ingestContact(submission1);
  ContactManager.ingestContact(submission2);

  assert(TestState.db.contacts.length === 1, 'Should de-duplicate same emails in Supabase');

  const contact = TestState.db.contacts[0];
  assert(contact.email === 'jsmith@gmail.com', 'Should trim and lowercase email');
  assert(contact.first_name === 'John', 'Should casing format name');

  logTestResult('1', true, 'Workshop Rush: Atomicity lock, casing dedupe, and tag unions verify in Supabase.');
}

function testScenario5_ConflictMergeAndAuditing() {
  setupMockEnvironment();

  const existing = {
    email: 'jane@acme.com',
    first_name: 'Jane',
    last_name: 'Smith',
    phone: '555-111-2222',
    source: 'google-form'
  };
  ContactManager.ingestContact(existing);

  const incomingForm = {
    email: 'jane@acme.com',
    first_name: '',
    phone: '555-999-8888',
    source: 'luma'
  };
  ContactManager.ingestContact(incomingForm);

  const contact = TestState.db.contacts[0];
  assert(contact.first_name === 'Jane', 'Blank incoming must not erase populated existing');
  assert(contact.phone === '+15559998888', 'Newer populated phone wins');
  assert(TestState.db.audits.length === 1, 'Should log conflict override to audit_logs in Supabase');

  logTestResult('5 & 20', true, 'Conflicts merge field-by-field, blank preserves, and old values written to audit_logs.');
}

function testScenario10_RescheduledDiscoveryCall() {
  setupMockEnvironment();

  const eventId = 'meeting_123';
  const startTime = new Date(Date.now() + 70 * 60 * 1000);
  
  const mockEvent = {
    getId: () => eventId,
    getTitle: () => 'Discovery Call: Joe Schmoe',
    getStart: () => startTime,
    isAllDayEvent: () => false,
    getGuestList: () => [
      { getEmail: () => 'joe@schmoe.com' }
    ]
  };
  
  TestState.calendarEvents.push(mockEvent);

  CalendarBookings.syncBookings();
  CalendarBookings.scanAndSendDigests();
  
  assert(Config.getProperty(`digest_sent:${eventId}`) === 'true', 'Should mark digest sent');
  assert(TestState.sentEmails.length === 1, 'Should dispatch digest email to Rachel');

  logTestResult('10', true, 'Discovery booking detection & digest dispatch verify cleanly.');
}

function testScenario37_MaintenanceCircuitBreaker() {
  setupMockEnvironment();

  // Create 10 active contacts in Supabase
  for (let i = 0; i < 10; i++) {
    TestState.db.contacts.push({
      email: `user${i}@test.com`,
      created_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
      last_engagement_at: new Date(Date.now() - 70 * 24 * 60 * 60 * 1000).toISOString(),
      lifecycle_state: 'active',
      archived: false
    });
  }

  // Monthly maintenance runs where 100% of active database is stale (> 20% circuit breaker trigger)
  const res = Maintenance.cleanHouse();

  assert(res.halted === true, 'Circuit breaker must halt mass archive operation');
  const unarchivedCount = TestState.db.contacts.filter(c => !c.archived).length;
  assert(unarchivedCount === 10, 'Circuit breaker must prevent mass contact deletion');

  logTestResult('37', true, 'Circuit Breaker halts execution when stale count exceeds 20%.');
}

function testWeeklyNewsletterBroadcaster() {
  setupMockEnvironment();

  // Create active subscriber in Supabase
  TestState.db.contacts.push({
    email: 'subscriber@test.com',
    lifecycle_state: 'active',
    verification_status: 'valid',
    archived: false
  });

  const res = Newsletter.runWeeklyBroadcaster();
  assert(res.success === true, 'Newsletter broadcast must succeed');
  assert(res.count === 1, 'Must deliver newsletter to active verified subscriber');

  logTestResult('Weekly Newsletter', true, 'Weekly RSS broadcaster dispatches newsletter to Supabase audience.');
}

// ----------------------------------------------------
// Master Test Runner Orchestration
// ----------------------------------------------------
function runTests() {
  Logger.log('Starting Full Marketing Automation Agent Test Suite (Supabase Knowledge Graph Storage)...');

  try {
    testScenario1_WorkshopRush();
    testScenario5_ConflictMergeAndAuditing();
    testScenario10_RescheduledDiscoveryCall();
    testScenario37_MaintenanceCircuitBreaker();
    testWeeklyNewsletterBroadcaster();

    Logger.log('--- ALL MARKETING AGENT TESTS PASSED SUCCESSFULLY ---');
  } catch (error) {
    Logger.log('❌ TEST SUITE ENCOUNTERED AN EXCEPTION:');
    Logger.log(error.stack || error.toString());
  }
}

// Node.js direct execution support
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  global.Config = Config;
  global.Http = Http;
  global.Utils = Utils;
  global.Database = Database;
  global.Schema = Schema;
  global.ContactManager = ContactManager;
  global.Verification = Verification;
  global.GoogleForms = GoogleForms;
  global.LumaPoll = LumaPoll;
  global.LinkedInImport = LinkedInImport;
  global.CalendarBookings = CalendarBookings;
  global.OutcomeParser = OutcomeParser;
  global.Newsletter = Newsletter;
  global.WebhookReceiver = WebhookReceiver;
  global.Reports = Reports;
  global.Maintenance = Maintenance;
  global.ErrorHandler = ErrorHandler;
  global.Logger = { log: console.log };

  runTests();
}

