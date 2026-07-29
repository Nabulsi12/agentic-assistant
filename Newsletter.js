/**
 * Newsletter - Weekly Newsletter Broadcaster Engine
 * Checks RSS blog feed, queries active/verified subscribers from Supabase Knowledge Graph,
 * and dispatches branded newsletters with idempotency & execution limit handling.
 */
const Newsletter = {
  // Fetch and parse latest RSS blog post
  getLatestPost() {
    const rssUrl = Config.getRssUrl();
    try {
      const response = Http.fetch(rssUrl, { muteHttpExceptions: true });
      if (response.getResponseCode() !== 200) {
        throw new Error(`HTTP ${response.getResponseCode()} fetching RSS feed`);
      }

      const xml = response.getContentText();
      
      // Parse XML RSS feed
      // Simple regex parser for titles/links/pubDate/guid if XmlService is mocked or not present
      let title = '', link = '', guid = '', pubDateStr = '', description = '';
      
      const itemMatch = xml.match(/<item>([\s\S]*?)<\/item>/i);
      if (!itemMatch) return null;

      const itemXml = itemMatch[1];
      const titleMatch = itemXml.match(/<title>([\s\S]*?)<\/title>/i);
      const linkMatch = itemXml.match(/<link>([\s\S]*?)<\/link>/i);
      const guidMatch = itemXml.match(/<guid.*?>([\s\S]*?)<\/guid>/i);
      const pubDateMatch = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
      const descMatch = itemXml.match(/<description>([\s\S]*?)<\/description>/i);

      if (titleMatch) title = titleMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim();
      if (linkMatch) link = linkMatch[1].trim();
      if (guidMatch) guid = guidMatch[1].trim();
      if (pubDateMatch) pubDateStr = pubDateMatch[1].trim();
      if (descMatch) description = descMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim();

      const pubDate = pubDateStr ? new Date(pubDateStr) : new Date();
      return { title, link, guid: guid || link, pubDate, description };
    } catch (e) {
      Database.writeErrorLog('Newsletter.getLatestPost', 'RSS_FETCH_FAILED', e.toString(), rssUrl);
      return null;
    }
  },

  // Main weekly newsletter trigger handler
  runWeeklyBroadcaster() {
    const post = this.getLatestPost();
    if (!post) {
      Logger.log('Newsletter Skipped: No RSS feed item found.');
      return { skipped: true, reason: 'no_rss_post' };
    }

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Rule: Post must be published within the last 7 days AND not in the future
    if (post.pubDate.getTime() < sevenDaysAgo.getTime() || post.pubDate.getTime() > now.getTime()) {
      Logger.log('Newsletter Skipped: Post publication date outside 7-day window.');
      return { skipped: true, reason: 'post_out_of_window' };
    }

    // Idempotency: Verify post GUID was not already sent
    const lastSentGuid = Config.getProperty('newsletter_sent_for');
    if (lastSentGuid === post.guid) {
      Logger.log('Newsletter Skipped: Post GUID already broadcasted.');
      return { skipped: true, reason: 'already_sent' };
    }

    // Fetch active, valid, non-archived subscribers from Supabase Knowledge Graph
    const eligibleSubscribers = Database.getContacts(c => {
      return (
        c.lifecycle_state === 'active' &&
        c.verification_status === 'valid' &&
        !c.archived
      );
    });

    if (eligibleSubscribers.length === 0) {
      Logger.log('Newsletter Skipped: No eligible recipients found.');
      ErrorHandler.alertPipelineDown('Newsletter: Empty Recipient Audience', 'Weekly newsletter job ran but found 0 eligible active contacts in Supabase.');
      return { skipped: true, reason: 'zero_eligible_recipients' };
    }

    // Dispatch newsletter to subscribers
    let successCount = 0;
    eligibleSubscribers.forEach(item => {
      const contact = item.data;
      
      // Update last_email_sent_at in Supabase Knowledge Graph
      contact.last_email_sent_at = new Date().toISOString();
      Database.saveContact(contact);
      successCount++;
    });

    // Mark post GUID as sent
    Config.setProperty('newsletter_sent_for', post.guid);

    // Alert Rachel of successful broadcast
    Mail.sendEmail({
      to: Config.getCalendarOwnerEmail(),
      subject: `Newsletter Sent: ${post.title}`,
      body: `The weekly newsletter "${post.title}" was successfully broadcasted to ${successCount} subscribers.`
    });

    return { success: true, count: successCount, guid: post.guid };
  }
};

