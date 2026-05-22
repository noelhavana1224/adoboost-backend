const nodemailer = require('nodemailer');
const Handlebars = require('handlebars');
const { dbAll, dbRun, dbGet } = require('../models/db');
const { v4: uuidv4 } = require('uuid');

const BASE_URL = () => process.env.BASE_URL || 'https://api.adobosolutions.com';

// ── Helpers ──────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Sending presets ──────────────────────────────
const SENDING_PRESETS = {
  safe: {
    label: 'Safe',
    daily_limit: 15,
    emails_per_hour: 3,
    delay_min: 120,
    delay_max: 300,
    send_window_start: 9,
    send_window_end: 17,
    description: 'Best for new domains. Slow & safe.',
  },
  moderate: {
    label: 'Moderate',
    daily_limit: 40,
    emails_per_hour: 6,
    delay_min: 60,
    delay_max: 180,
    send_window_start: 8,
    send_window_end: 18,
    description: 'Balanced for warmed-up domains.',
  },
  aggressive: {
    label: 'Aggressive',
    daily_limit: 100,
    emails_per_hour: 15,
    delay_min: 25,
    delay_max: 75,
    send_window_start: 7,
    send_window_end: 20,
    description: 'High volume. Only for established domains.',
  },
  auto_warmer: {
    label: 'Auto Warmer',
    daily_limit: 10,
    emails_per_hour: 2,
    delay_min: 180,
    delay_max: 420,
    send_window_start: 9,
    send_window_end: 17,
    description: 'Warmup-optimised. Slow ramp-up.',
  },
};

// ── Check if current time is inside account's sending window ──
function isWithinSendingWindow(account) {
  const now = new Date();
  const hour = now.getHours();
  const winStart = account.send_window_start ?? 8;
  const winEnd   = account.send_window_end   ?? 17;
  return hour >= winStart && hour < winEnd;
}

/**
 * Generate humanized, human-like scheduled_at timestamps for ALL sends
 * in a campaign launch.
 *
 * Logic:
 *  - Contacts are batched by account's daily_limit (one batch = one calendar day)
 *  - Each batch's send times are randomly distributed within the account's
 *    working window (send_window_start → send_window_end)
 *  - Micro-noise (±30s) is added to avoid perfect clock-aligned patterns
 *  - Minimum 1-minute spacing enforced between any two sends
 *  - If launched during the window, today's sends start from now+5min
 *  - If launched after window, first sends begin tomorrow
 *
 * @param {Array}  contacts  - contact rows
 * @param {Array}  sequences - sequence rows (ordered by step_number)
 * @param {Object} account   - email_account row
 * @param {Date}   launchTime - when the campaign was launched (default: now)
 * @returns {Array} [{contact, sequence, scheduled_at}]
 */
function humanScheduleSends(contacts, sequences, account, launchTime = new Date()) {
  const dailyLimit  = Math.max(1, account.daily_limit  || 50);
  const winStart    = Number(account.send_window_start ?? 8);
  const winEnd      = Number(account.send_window_end   ?? 17);

  // Determine effective start for day-0
  const nowHour = launchTime.getHours();
  const nowMin  = launchTime.getMinutes();
  let startDayOffset = 0;
  let day0WinStart   = winStart; // may be adjusted if already in window

  if (nowHour >= winEnd) {
    // Already past today's window — start tomorrow
    startDayOffset = 1;
  } else if (nowHour >= winStart) {
    // Inside window — start 5 minutes from now
    day0WinStart = nowHour + (nowMin + 5) / 60;
  }

  const sends = [];
  let contactIdx = 0;
  let dayOffset  = startDayOffset;

  while (contactIdx < contacts.length) {
    const batch = contacts.slice(contactIdx, contactIdx + dailyLimit);
    contactIdx += dailyLimit;

    const effectiveWinStart = (dayOffset === startDayOffset) ? day0WinStart : winStart;
    const windowMinutes     = Math.max(30, (winEnd - effectiveWinStart) * 60);

    // Generate random offsets (minutes into the window) sorted ascending
    const offsets = batch.map(() => Math.random() * windowMinutes).sort((a, b) => a - b);

    // Enforce minimum 1-minute spacing with extra jitter
    for (let i = 1; i < offsets.length; i++) {
      if (offsets[i] - offsets[i - 1] < 1) {
        offsets[i] = offsets[i - 1] + 1 + Math.random() * 2;
      }
    }

    for (let i = 0; i < batch.length; i++) {
      const contact = batch[i];

      // Build the send timestamp for this contact on this day
      const sendDate = new Date(launchTime);
      sendDate.setDate(sendDate.getDate() + dayOffset);
      const totalMinutes = effectiveWinStart * 60 + offsets[i];
      sendDate.setHours(
        Math.floor(totalMinutes / 60),
        Math.floor(totalMinutes % 60),
        Math.floor(Math.random() * 60), // random seconds 0-59
        0
      );

      // Walk through all sequence steps, each offset from the previous
      let prevTime = new Date(sendDate);
      for (const seq of sequences) {
        const seqTime = new Date(prevTime);
        seqTime.setDate(seqTime.getDate() + (seq.delay_days   || 0));
        seqTime.setHours(seqTime.getHours() + (seq.delay_hours || 0));

        // For follow-up steps: snap to working window if outside
        if (seq.step_number > 1) {
          const h = seqTime.getHours();
          if (h < winStart) {
            seqTime.setHours(winStart, Math.floor(Math.random() * 60), Math.floor(Math.random() * 60), 0);
          } else if (h >= winEnd) {
            seqTime.setDate(seqTime.getDate() + 1);
            seqTime.setHours(winStart, Math.floor(Math.random() * 60), Math.floor(Math.random() * 60), 0);
          }
        }

        sends.push({ contact, sequence: seq, scheduled_at: seqTime.toISOString() });
        prevTime = seqTime;
      }
    }

    dayOffset++;
  }

  return sends;
}

// ── Personalize template ─────────────────────────
function personalize(template, contact, account) {
  try {
    const custom = JSON.parse(contact.custom_fields || '{}');
    const fallbacks = custom._fallbacks || {};
    let signature = '';
    if (account?.signature) {
      try {
        const sig = JSON.parse(account.signature);
        const raw = sig.mode === 'plain' ? (sig.plain || '') : (sig.html || sig.plain || '');
        signature = raw
          .replace(/\{\{from_name\}\}/g,  account.from_name  || '')
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

// ── Count sends in last hour for an account ──────
async function getSentLastHour(emailAccountId) {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const row = await dbGet(`
    SELECT COUNT(*) as count FROM sends
    WHERE email_account_id=? AND status='sent' AND sent_at>=?
  `, [emailAccountId, oneHourAgo]);
  return row?.count || 0;
}

// ── Main send processor (called by cron every 2 min) ──
async function processPendingSends() {
  const now = new Date().toISOString();

  // Pick up to 30 pending sends that are due
  const pending = await dbAll(`
    SELECT s.*,
      c.email,c.first_name,c.last_name,c.company,c.title,c.website,c.custom_fields,
      seq.subject,seq.body,
      camp.track_opens,camp.track_clicks,camp.status as campaign_status,camp.rotation_account_ids,
      ea.host,ea.port,ea.secure,ea.username,ea.password as smtp_pass,
      ea.from_name,ea.from_email,ea.signature,
      ea.daily_limit as acc_limit,ea.sent_today,
      ea.emails_per_hour,ea.delay_min,ea.delay_max,
      ea.send_window_start,ea.send_window_end,
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
    ORDER BY s.scheduled_at ASC LIMIT 30`, [now]);

  if (pending.length === 0) return;

  // Per-account hourly counters (cached for this batch)
  const hourlyCache = {};

  for (let send of pending) {
    // ── Inbox rotation: pick a random account if configured ──
    if (send.rotation_account_ids) {
      try {
        const rotIds = JSON.parse(send.rotation_account_ids || '[]');
        if (rotIds.length > 1) {
          const randomId = rotIds[Math.floor(Math.random() * rotIds.length)];
          if (randomId !== send.email_account_id) {
            const rotAcc = await dbGet(`SELECT * FROM email_accounts WHERE id=?`, [randomId]);
            if (rotAcc && rotAcc.sent_today < (rotAcc.daily_limit || 50)) {
              send = { ...send, ...rotAcc, email_account_id: rotAcc.id, acc_limit: rotAcc.daily_limit || 50, smtp_pass: rotAcc.password };
            }
          }
        }
      } catch {}
    }

    // ── Sending window check ──
    // Only send if current time is within this account's configured window.
    // Grace: if the send is more than 4h overdue we send anyway (prevents indefinite delay).
    const gracePeriodMs = 4 * 60 * 60 * 1000;
    const isOverdue     = Date.now() - new Date(send.scheduled_at).getTime() > gracePeriodMs;
    if (!isOverdue && !isWithinSendingWindow(send)) {
      // Outside window — skip for now; cron will retry once window opens
      continue;
    }

    // ── Daily limit check ──
    if (send.sent_today >= send.acc_limit) {
      console.log(`⏸ Daily limit reached for ${send.from_email} (${send.sent_today}/${send.acc_limit})`);
      continue;
    }

    // ── Hourly limit check ──
    const emailsPerHour = send.emails_per_hour || 10;
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
      const rawBody   = personalize(send.body,    send, account);
      const finalBody = buildBody(rawBody, send.id, send.track_clicks, send.track_opens, send.can_spam_footer);

      const transporter = nodemailer.createTransport({
        host:   send.host,
        port:   send.port,
        secure: send.secure === 1 || send.port === 465,
        auth:   { user: send.username, pass: send.smtp_pass },
        tls:    { rejectUnauthorized: false },
      });

      const info = await transporter.sendMail({
        from:    `"${send.from_name}" <${send.from_email}>`,
        to:      send.email,
        subject,
        html:    finalBody,
        text:    rawBody.replace(/<[^>]*>/g, ''),
      });

      await dbRun(`UPDATE sends SET status='sent', sent_at=?, message_id=? WHERE id=?`,
        [new Date().toISOString(), info.messageId, send.id]);
      await dbRun(`UPDATE email_accounts SET sent_today=sent_today+1 WHERE id=?`,
        [send.email_account_id]);

      hourlyCache[send.email_account_id] = (hourlyCache[send.email_account_id] || 0) + 1;
      console.log(`✅ Sent → ${send.email} via ${send.from_email} [${hourlyCache[send.email_account_id]}/${emailsPerHour} this hour]`);

      // Small SMTP recovery pause (2-5s) — not the main rate-limiter
      // Real pacing is in the humanized scheduled_at timestamps
      await sleep(2000 + Math.floor(Math.random() * 3000));

    } catch (err) {
      console.error(`❌ Send failed → ${send.email}:`, err.message);
      await dbRun(`UPDATE sends SET status='failed', error_message=? WHERE id=?`,
        [err.message, send.id]);
    }
  }
}

// ── Reset daily counters at midnight ────────────
async function resetDailyCounters() {
  const today = new Date().toISOString().split('T')[0];
  await dbRun(
    `UPDATE email_accounts SET sent_today=0, last_reset=? WHERE last_reset IS NULL OR last_reset<?`,
    [today, today]
  );
}

module.exports = { processPendingSends, resetDailyCounters, humanScheduleSends, SENDING_PRESETS };
