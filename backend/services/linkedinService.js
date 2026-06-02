const axios = require('axios');
const crypto = require('crypto');
const { dbAll, dbRun } = require('../models/db');
const { dec } = require('../utils/crypto');

function buildHeaders(liAt, jsessionid) {
  const csrf = jsessionid.replace(/^["']|["']$/g, '');
  return {
    'cookie': `li_at=${liAt}; JSESSIONID="${csrf}"`,
    'csrf-token': csrf,
    'x-restli-protocol-version': '2.0.0',
    'x-li-lang': 'en_US',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'accept': 'application/vnd.linkedin.normalized+json+2.1',
    'accept-language': 'en-US,en;q=0.9',
    'referer': 'https://www.linkedin.com/feed/',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  };
}

function extractProfileSlug(url) {
  const m = url.match(/linkedin\.com\/in\/([^/?#\s]+)/);
  return m ? m[1].replace(/\/+$/, '') : null;
}

async function testCookies(liAt, jsessionid) {
  let res;
  try {
    res = await axios.get('https://www.linkedin.com/voyager/api/me', {
      headers: buildHeaders(liAt, jsessionid),
      timeout: 12000,
      maxRedirects: 0,
      validateStatus: s => s < 400,
    });
  } catch (err) {
    // Any redirect (3xx) means LinkedIn rejected the cookies and is sending to login
    if (err.response?.status >= 300 && err.response?.status < 400) {
      const e = new Error('Cookies are expired or invalid — LinkedIn redirected to login. Re-copy your cookies and try again.');
      e.response = err.response;
      throw e;
    }
    throw err;
  }

  // A redirect that slipped through validateStatus
  if (res.status >= 300) {
    throw new Error('Cookies are expired or invalid — LinkedIn redirected to login. Re-copy your cookies and try again.');
  }

  const data = res.data;
  const name = data?.included?.[0]?.firstName?.localized?.en_US || data?.data?.firstName || 'LinkedIn User';
  return { ok: true, name };
}

async function sendConnectionRequest(liAt, jsessionid, profileSlug, note) {
  const trackingId = Buffer.from(crypto.randomBytes(16)).toString('base64');
  const payload = {
    trackingId,
    message: (note || '').slice(0, 300),
    invitations: [],
    excludeInvitations: [],
    invitee: {
      'com.linkedin.voyager.growth.invitation.InviteeProfile': {
        profileId: profileSlug,
      },
    },
  };

  await axios.post('https://www.linkedin.com/voyager/api/growth/normInvitations', payload, {
    headers: { ...buildHeaders(liAt, jsessionid), 'content-type': 'application/json' },
    timeout: 15000,
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function personalize(template, contact) {
  return (template || '')
    .replace(/\{\{first_name\}\}/g, contact.first_name || '')
    .replace(/\{\{last_name\}\}/g, contact.last_name || '')
    .replace(/\{\{company\}\}/g, contact.company || '')
    .replace(/\{\{full_name\}\}/g, [contact.first_name, contact.last_name].filter(Boolean).join(' ') || '');
}

async function processPendingLinkedInSends() {
  const now = new Date().toISOString();
  const pending = await dbAll(`
    SELECT ls.*,
           c.first_name, c.last_name, c.company, c.linkedin,
           COALESCE(ls.connection_note, lc.connection_note, '') as resolved_note,
           CASE WHEN ls.email_campaign_id IS NOT NULL THEN 'active' ELSE COALESCE(lc.status,'active') END as campaign_status,
           la.name as account_name,
           la.li_at, la.jsessionid, la.daily_limit as acct_daily_limit, la.sent_today
    FROM linkedin_sends ls
    JOIN contacts c ON ls.contact_id = c.id
    LEFT JOIN linkedin_campaigns lc ON ls.campaign_id = lc.id AND ls.email_campaign_id IS NULL
    JOIN linkedin_accounts la ON ls.linkedin_account_id = la.id
    WHERE ls.status = 'pending' AND ls.scheduled_at <= ?
    AND (ls.email_campaign_id IS NOT NULL OR lc.status = 'active')
    ORDER BY ls.scheduled_at ASC LIMIT 5
  `, [now]);

  for (const send of pending) {
    if (send.sent_today >= send.acct_daily_limit) continue;

    // linkedin_view: mark done immediately, no API call needed
    if (send.step_type === 'linkedin_view') {
      await dbRun(`UPDATE linkedin_sends SET status='sent', sent_at=? WHERE id=?`, [new Date().toISOString(), send.id]);
      continue;
    }

    const profileUrl = send.linkedin_profile_url || send.linkedin;
    if (!profileUrl) {
      await dbRun(`UPDATE linkedin_sends SET status='skipped', error_message='No LinkedIn URL on contact' WHERE id=?`, [send.id]);
      continue;
    }

    const slug = extractProfileSlug(profileUrl);
    if (!slug) {
      await dbRun(`UPDATE linkedin_sends SET status='skipped', error_message='Invalid LinkedIn URL format' WHERE id=?`, [send.id]);
      continue;
    }

    try {
      const note = personalize(send.resolved_note, send);
      await sendConnectionRequest(dec(send.li_at), dec(send.jsessionid), slug, note);
      const sentAt = new Date().toISOString();
      await dbRun(`UPDATE linkedin_sends SET status='sent', sent_at=? WHERE id=?`, [sentAt, send.id]);
      await dbRun(`UPDATE linkedin_accounts SET sent_today = sent_today + 1 WHERE id=?`, [send.linkedin_account_id]);
      // Auto-tag the contact as connected via this LinkedIn account
      await dbRun(`UPDATE contacts SET linkedin_connected_via=? WHERE id=?`, [send.account_name || 'LinkedIn', send.contact_id]);

      // 45–120 second human-like gap
      const delay = (Math.random() * 75 + 45) * 1000;
      await sleep(delay);
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      await dbRun(`UPDATE linkedin_sends SET status='failed', error_message=? WHERE id=?`, [msg, send.id]);
    }
  }
}

async function resetLinkedInDailyCounters() {
  const today = new Date().toISOString().split('T')[0];
  await dbRun(
    `UPDATE linkedin_accounts SET sent_today=0, last_reset=? WHERE last_reset IS NULL OR last_reset < ?`,
    [today, today]
  );
}

module.exports = { testCookies, extractProfileSlug, processPendingLinkedInSends, resetLinkedInDailyCounters };
