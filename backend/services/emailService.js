const nodemailer = require('nodemailer');
const Handlebars = require('handlebars');
const { dbAll, dbRun, dbGet } = require('../models/db');
const { v4: uuidv4 } = require('uuid');

const BASE_URL = () => process.env.BASE_URL || 'https://api.adobosolutions.com';

// ── Random delay helper ──────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(minSec, maxSec) {
  const min = Math.max(10, Number(minSec) || 45);
  const max = Math.max(min + 5, Number(maxSec) || 120);
  const ms = (Math.floor(Math.random() * (max - min + 1)) + min) * 1000;
  return ms;
}

// ── Personalize template ─────────────────────────
function personalize(template, contact, account) {
  try {
    const custom = JSON.parse(contact.custom_fields || '{}');
    const fallbacks = custom._fallbacks || {};
    // Build signature from account
    let signature = '';
    if (account?.signature) {
      try {
        const sig = JSON.parse(account.signature);
        const raw = sig.mode === 'plain' ? (sig.plain || '') : (sig.html || sig.plain || '');
        // Replace signature-level variables
        signature = raw
          .replace(/\{\{from_name\}\}/g, account.from_name || '')
          .replace(/\{\{from_email\}\}/g, account.from_email || '');
      } catch { signature = account.signature || ''; }
    }
    const data = {
      first_name: contact.first_name || fallbacks.first_name || 'there',
      last_name:  contact.last_name  || fallbacks.last_name  || '',
      full_name:  [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email,
      email:      contact.email,
      company:    contact.company || fallbacks.company || 'your company',
      title:      contact.title   || fallbacks.title   || '',
      website:    contact.website || '',
      from_name:  account?.from_name  || '',
      from_email: account?.from_email || '',
      signature,
      ...custom,
    };
    return Handlebars.compile(template)(data);
  } catch { return template; }
}

// ── Build email body with tracking ──────────────
function buildBody(html, sendId, trackClicks, trackOpens, canSpamFooter) {
  let body = html;
  if (trackClicks) {
    body = body.replace(/href="(https?:\/\/[^"]+)"/g, (_, url) =>
      `href="${BASE_URL()}/api/tracking/click/${sendId}?url=${encodeURIComponent(url)}"`);
  }
  if (canSpamFooter) {
    body += `<br><br><div style="font-size:11px;color:#999;border-top:1px solid #eee;padding-top:10px;">
      You received this email as part of a business outreach.
      <a href="${BASE_URL()}/api/tracking/unsubscribe/${sendId}" style="color:#999;">Unsubscribe</a>
    </div>`;
  } else {
    body += `<br><br><small><a href="${BASE_URL()}/api/tracking/unsubscribe/${sendId}">Unsubscribe</a></small>`;
  }
  if (trackOpens) {
    body += `<img src="${BASE_URL()}/api/tracking/open/${sendId}" width="1" height="1" style="display:none" />`;
  }
  return body;
}

// ── Check hourly rate limit ──────────────────────
// Count how many emails this account sent in the last 60 minutes
async function getSentLastHour(emailAccountId) {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const row = await dbGet(`
    SELECT COUNT(*) as count FROM sends
    WHERE email_account_id=? AND status='sent' AND sent_at>=?
  `, [emailAccountId, oneHourAgo]);
  return row?.count || 0;
}

// ── Main send processor ──────────────────────────
async function processPendingSends() {
  const now = new Date().toISOString();

  const pending = await dbAll(`
    SELECT s.*,
      c.email,c.first_name,c.last_name,c.company,c.title,c.website,c.custom_fields,
      seq.subject,seq.body,
      camp.track_opens,camp.track_clicks,camp.status as campaign_status,camp.rotation_account_ids,
      ea.host,ea.port,ea.secure,ea.username,ea.password as smtp_pass,
      ea.from_name,ea.from_email,ea.signature,
      ea.daily_limit as acc_limit,ea.sent_today,
      ea.emails_per_hour,ea.delay_min,ea.delay_max,
      u.can_spam_footer
    FROM sends s
    JOIN contacts c ON s.contact_id=c.id
    JOIN sequences seq ON s.sequence_id=seq.id
    JOIN campaigns camp ON s.campaign_id=camp.id
    JOIN email_accounts ea ON s.email_account_id=ea.id
    JOIN users u ON camp.user_id=u.id
    WHERE s.status='pending' AND s.scheduled_at<=?
    AND camp.status='active'
    AND c.unsubscribed=0 AND c.bounced=0
    ORDER BY s.scheduled_at ASC LIMIT 50`, [now]);

  // Track per-account hourly counts in memory for this batch
  const hourlyCache = {};
  let lastAccountId = null;
  let emailsInBatch = 0;

  for (const send of pending) {
    // ── Inbox Rotation: pick a random account if rotation is set ──
    let activeSend = send;
    if (send.rotation_account_ids) {
      try {
        const rotIds = JSON.parse(send.rotation_account_ids || '[]');
        if (rotIds.length > 1) {
          // Pick a random account from the rotation list
          const randomId = rotIds[Math.floor(Math.random() * rotIds.length)];
          if (randomId !== send.email_account_id) {
            const rotAcc = await dbGet(`SELECT * FROM email_accounts WHERE id=?`, [randomId]);
            if (rotAcc && rotAcc.sent_today < (rotAcc.daily_limit || 50)) {
              activeSend = { ...send, ...rotAcc, email_account_id: rotAcc.id, acc_limit: rotAcc.daily_limit || 50, smtp_pass: rotAcc.password };
            }
          }
        }
      } catch {}
    }
    send = activeSend;

    // ── Check daily limit ──
    if (send.sent_today >= send.acc_limit) {
      console.log(`⏸ Daily limit reached for ${send.from_email} (${send.sent_today}/${send.acc_limit})`);
      continue;
    }

    // ── Check hourly limit ──
    const emailsPerHour = send.emails_per_hour || 10; // default 10/hr if not set
    if (!hourlyCache[send.email_account_id]) {
      hourlyCache[send.email_account_id] = await getSentLastHour(send.email_account_id);
    }
    if (hourlyCache[send.email_account_id] >= emailsPerHour) {
      console.log(`⏸ Hourly limit reached for ${send.from_email} (${hourlyCache[send.email_account_id]}/${emailsPerHour}/hr)`);
      continue;
    }

    try {
      const account   = { from_name: send.from_name, from_email: send.from_email, signature: send.signature };
      const subject   = personalize(send.subject, send, account);
      const rawBody   = personalize(send.body, send, account);
      const finalBody = buildBody(rawBody, send.id, send.track_clicks, send.track_opens, send.can_spam_footer);

      const transporter = nodemailer.createTransport({
        host: send.host,
        port: send.port,
        secure: send.secure === 1 || send.port === 465 || send.port === 993,
        auth: { user: send.username, pass: send.smtp_pass },
        tls: { rejectUnauthorized: false },
      });

      const info = await transporter.sendMail({
        from: `"${send.from_name}" <${send.from_email}>`,
        to:   send.email,
        subject,
        html: finalBody,
        text: rawBody.replace(/<[^>]*>/g, ''),
      });

      await dbRun(`UPDATE sends SET status='sent', sent_at=?, message_id=? WHERE id=?`,
        [new Date().toISOString(), info.messageId, send.id]);
      await dbRun(`UPDATE email_accounts SET sent_today=sent_today+1 WHERE id=?`,
        [send.email_account_id]);

      // Update in-memory hourly counter
      hourlyCache[send.email_account_id] = (hourlyCache[send.email_account_id] || 0) + 1;

      console.log(`✅ Sent to ${send.email} via ${send.from_email} (${hourlyCache[send.email_account_id]}/${emailsPerHour} this hour)`);

      // ── Random delay between emails ──────────────
      // Only delay if there are more sends coming
      const delayMs = randomDelay(send.delay_min, send.delay_max);
      const delaySec = Math.round(delayMs / 1000);
      console.log(`⏱ Waiting ${delaySec}s before next email (random ${send.delay_min||45}–${send.delay_max||120}s)`);
      await sleep(delayMs);

    } catch (err) {
      console.error(`❌ Send failed to ${send.email}:`, err.message);
      await dbRun(`UPDATE sends SET status='failed', error_message=? WHERE id=?`,
        [err.message, send.id]);
    }
  }
}

// ── Reset daily counters at midnight ────────────
async function resetDailyCounters() {
  const today = new Date().toISOString().split('T')[0];
  await dbRun(`UPDATE email_accounts SET sent_today=0, last_reset=? WHERE last_reset IS NULL OR last_reset<?`,
    [today, today]);
}

module.exports = { processPendingSends, resetDailyCounters };
