/**
 * GoogleForms - Handles installable onFormSubmit triggers from Google Forms.
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

  // Process form submission
  handleFormSubmit(e) {
    let rawRow = {};
    let timestamp = new Date().toISOString();

    try {
      if (!e) {
        throw new Error('No event payload provided');
      }

      // Check column mappings and validate headers
      // e.namedValues maps question titles (keys) to array of responses
      // In onFormSubmit, e.namedValues keys are the actual question titles in the sheet
      const headers = Object.keys(e.namedValues || {});
      if (headers.length === 0) {
        throw new Error('Empty namedValues in form submit event');
      }

      let emailHeaderFound = false;

      headers.forEach(header => {
        const cleanHeader = header.trim().toLowerCase();
        
        // Skip Timestamp / standard time column
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
          // Scenario 22: Unmapped questions must fail loudly, log, and alert Rachel
          ErrorHandler.logError(
            'GoogleForms.handleFormSubmit', 
            'UNMAPPED_QUESTION', 
            `Unmapped question header detected in form: "${header}"`, 
            JSON.stringify({ header, values: e.namedValues[header] })
          );
          // Send an immediate alert so they can fix the mapping or script
          ErrorHandler.alertPipelineDown(
            'Form Intake: Unmapped Question', 
            `The Google Form was submitted with a question that does not match the schema: "${header}".\nValues: ${e.namedValues[header]}`
          );
        }
      });

      if (!emailHeaderFound || !rawRow.email) {
        // Missing email is a critical error
        throw new Error('missing_email_column');
      }

      // Complete raw fields setup
      rawRow.source = 'google-form';
      rawRow.created_at = timestamp;

      // 1. Run Verification & Filtration (ZeroBounce integration)
      // Verify email before merging to sheet
      let processedContact = Schema.normalizeContact(rawRow);
      processedContact = Verification.processVerification(processedContact);

      // 2. Perform atomic ingest (Lookup -> Merge -> Write Sheet)
      const ingestResult = DedupeMerge.ingestContact(processedContact);

      // 3. EmailOctopus sync (only if verification is NOT invalid)
      // Note: Verification.processVerification sets lifecycle_state=invalid for hard bounces
      if (ingestResult.contact.lifecycle_state !== 'invalid') {
        const syncedContact = EmailOctopus.syncContact(ingestResult.contact);
        
        // Update database with the ESP contact ID returned
        if (syncedContact.esp_contact_id !== ingestResult.contact.esp_contact_id) {
          Database.saveContact(syncedContact);
        }
      }

    } catch (err) {
      // Log failures to Error Log
      ErrorHandler.logError(
        'GoogleForms.handleFormSubmit', 
        'SUBMIT_PROCESSING_FAILED', 
        err.toString(), 
        JSON.stringify(e ? e.namedValues : {})
      );
      
      // If it's a critical error like missing_email_column, log and bubble up
      if (err.message === 'missing_email_column') {
        ErrorHandler.logError(
          'GoogleForms.handleFormSubmit', 
          'MISSING_EMAIL_COLUMN', 
          'Form submission missing Email column', 
          JSON.stringify(e ? e.namedValues : {})
        );
      }
    }
  }
};
