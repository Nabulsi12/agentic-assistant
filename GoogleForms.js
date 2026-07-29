/**
 * GoogleForms - Handles installable onFormSubmit triggers from Google Forms.
 * Maps form responses to schema, verifies email, and ingests contact into Supabase Knowledge Graph.
 */
const GoogleForms = {
  // Case-insensitive, trimmed question title mapping
  MAPPING: {
    'email address': 'email',
    'email': 'email',
    'first name': 'first_name',
    'last name': 'last_name',
    'phone': 'phone',
    'phone number': 'phone',
    'company': 'company',
    'job title': 'job_title',
    'job_title': 'job_title'
  },

  // Process form submission event
  handleFormSubmit(e) {
    let rawRow = {};
    let timestamp = new Date().toISOString();

    try {
      if (!e) {
        throw new Error('No event payload provided');
      }

      // Check column mappings and validate headers
      const headers = Object.keys(e.namedValues || {});
      if (headers.length === 0) {
        throw new Error('Empty namedValues in form submit event');
      }

      let emailHeaderFound = false;

      headers.forEach(header => {
        const cleanHeader = header.trim().toLowerCase();

        // Skip Timestamp column
        if (cleanHeader === 'timestamp') {
          if (e.namedValues[header] && e.namedValues[header][0]) {
            timestamp = new Date(e.namedValues[header][0]).toISOString();
          }
          return;
        }

        const mappedField = this.MAPPING[cleanHeader];
        if (mappedField) {
          rawRow[mappedField] = e.namedValues[header][0] || '';
          if (mappedField === 'email') {
            emailHeaderFound = true;
          }
        } else {
          // Scenario 22: Unmapped questions must fail loudly, log to Supabase error_logs, and alert Rachel
          Database.writeErrorLog(
            'GoogleForms.handleFormSubmit', 
            'UNMAPPED_QUESTION', 
            `Unmapped question header detected in form: "${header}"`, 
            JSON.stringify({ header, values: e.namedValues[header] })
          );
          
          ErrorHandler.alertPipelineDown(
            'Form Intake: Unmapped Question', 
            `The Google Form was submitted with a question that does not match the schema: "${header}".\nValues: ${JSON.stringify(e.namedValues[header])}`
          );
        }
      });

      if (!emailHeaderFound || !rawRow.email) {
        throw new Error('missing_email_column');
      }

      // Set origin and creation date
      rawRow.source = 'google-form';
      rawRow.created_at = timestamp;

      // Ingest via ContactManager (Normalizes, verifies, deduplicates, and saves to Supabase Knowledge Graph)
      const ingestResult = ContactManager.ingestContact(rawRow);

      // Sync to EmailOctopus if verification is valid / risky (not hard bounce invalid)
      if (ingestResult.contact.verification_status !== 'invalid') {
        try {
          const syncedContact = EmailOctopus.syncContact(ingestResult.contact);
          if (syncedContact.esp_contact_id && syncedContact.esp_contact_id !== ingestResult.contact.esp_contact_id) {
            Database.saveContact(syncedContact);
          }
        } catch (eoErr) {
          Logger.log('EmailOctopus sync warning: ' + eoErr.toString());
        }
      }

      return ingestResult;

    } catch (err) {
      Database.writeErrorLog(
        'GoogleForms.handleFormSubmit', 
        'SUBMIT_PROCESSING_FAILED', 
        err.toString(), 
        JSON.stringify(e ? e.namedValues : {})
      );

      if (err.message === 'missing_email_column') {
        Database.writeErrorLog(
          'GoogleForms.handleFormSubmit', 
          'MISSING_EMAIL_COLUMN', 
          'Form submission missing Email column', 
          JSON.stringify(e ? e.namedValues : {})
        );
      }
      throw err;
    }
  }
};

