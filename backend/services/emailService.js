const nodemailer = require('nodemailer');
const Handlebars = require('handlebars');
const { dbAll, dbRun, dbGet } = require('../models/db');
const { v4: uuidv4 } = require('uuid');
const { getTzOffsetMs, getHourInTz } = require('../utils/timezone');
const { dec } = require('../utils/crypto');

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
// timezone: IANA string from the user's settings (e.g. 'America/New_York')
function isWithinSendingWindow(account, timezone = 'UTC') {
  const hour     = getHourInTz(timezone);
  const winStart = account.send_window_start ?? 8;
  const winEnd   = account.send_window_end   ?? 17;
  return hour >= winStart && hour < winEnd;
}

/**
 * Generate humanized, human-like scheduled_at timestamps for ALL sends
 * in a campaign launch.
 *
 * All send times are computed in the USER'S timezone (IANA, e.g. 'America/New_York')
 * and stored as UTC ISO strings in the database.  The processor just picks up
 * whatever rows are due (scheduled_at <= now UTC) — no further timezone math needed.
 *
 * Logic:
 *  - Contacts are batched by account's daily_limit (one batch = one calendar day)
 *  - Each batch's send times are randomly distributed within the account's
 *    working window (send_window_start → send_window_end) in the user's timezone
 *  - Minimum 1-minute spacing enforced between any two sends
 *  - If launched during the window, today's sends start from now+5min (local)
 *  - If launched after window, first sends begin tomorrow (local)
 *
 * @param {Array}  contacts   - contact rows
 * @param {Array}  sequences  - sequence rows (ordered by step_number)
 * @param {Object} account    - email_account row
 * @param {Date}   launchTime - when the campaign was launched (default: now)
 * @param {string} timezone   - IANA timezone of the user (default: 'UTC')
 * @returns {Array} [{contact, sequence, scheduled_at}]
 */
function humanScheduleSends(contacts, sequences, account, launchTime = new Date(), timezone = 'UTC') {
  const dailyLimit = Math.max(1, account.daily_limit  || 50);
  const winStart   = Number(account.send_window_start ?? 8);
  const winEnd     = Number(account.send_window_end   ?? 17);

  // ── Convert launch time into the user's local time ────────────────────────
  // getTzOffsetMs = UTC_ms − local_ms  →  local_ms = UTC_ms − offsetMs
  const launchOffsetMs  = getTzOffsetMs(timezone, launchTime);
  const localLaunchMs   = launchTime.getTime() - launchOffsetMs;
  // Treat this shifted value as a UTC Date so .getUTC*() gives local components
  const localLaunchDate = new Date(localLaunchMs);
  const localNowHour    = localLaunchDate.getUTCHours();
  const localNowMin     = localLaunchDate.getUTCMinutes();

  // Midnight of the launch date in the user's local timezone
  const localMidnightMs = localLaunchMs
    - localNowHour    * 3_600_000
    - localNowMin     *    60_000
    - localLaunchDate.getUTCSeconds()      * 1_000
    - localLaunchDate.getUTCMilliseconds();

  // ── Day-0 effective start ─────────────────────────────────────────────────
  let startDayOffset = 0;
  let day0WinStart   = winStart;

  if (localNowHour >= winEnd) {
    startDayOffset = 1;                                   // past window → start tomorrow
  } else if (localNowHour >= winStart) {
    day0WinStart = localNowHour + (localNowMin + 5) / 60; // in window  → start +5 min
  }

  // ── Helper: local ms → UTC ISO string ────────────────────────────────────
  // Re-computes the offset at the target time for accurate DST handling.
  function localMsToUtcISO(localMs) {
    const approxUtc        = new Date(localMs + launchOffsetMs); // rough UTC estimate
    const accurateOffsetMs = getTzOffsetMs(timezone, approxUtc); // offset at that time
    return new Date(localMs + accurateOffsetMs).toISOString();
  }

  const sends = [];
  let contactIdx = 0;
  let dayOffset  = startDayOffset;

  while (contactIdx < contacts.length) {
    const batch = contacts.slice(contactIdx, contactIdx + dailyLimit);
    contactIdx += dailyLimit;

    const effectiveWinStart = (dayOffset === startDayOffset) ? day0WinStart : winStart;
    const windowMinutes     = Math.max(30, (winEnd - effectiveWinStart) * 60);

    // Random sorted offsets (minutes into the window)
    const offsets = batch.map(() => Math.random() * windowMinutes).sort((a, b) => a - b);

    // Enforce 1-minute minimum spacing
    for (let i = 1; i < offsets.length; i++) {
      if (offsets[i] - offsets[i - 1] < 1) {
        offsets[i] = offsets[i - 1] + 1 + Math.random() * 2;
      }
    }

    // Midnight of this batch's day (local time, as shifted UTC ms)
    const thisDayLocalMidnightMs = localMidnightMs + dayOffset * 86_400_000;

    for (let i = 0; i < batch.length; i++) {
      const contact = batch[i];

      // Base send time = day midnight + window offset + random seconds
      const totalMinutesMs  = (effectiveWinStart * 60 + offsets[i]) * 60_000;
      const randomSecondsMs = Math.floor(Math.random() * 60) * 1_000;
      let prevLocalMs = thisDayLocalMidnightMs + totalMinutesMs + randomSecondsMs;

      for (const seq of sequences) {
        let seqLocalMs = prevLocalMs
          + (seq.delay_days  || 0) * 86_400_000
          + (seq.delay_hours || 0) *  3_600_000;

        // Snap follow-up steps back into the working window if they drifted outside
        if (seq.step_number > 1) {
          const seqLocal = new Date(seqLocalMs);
          const h = seqLocal.getUTCHours();
          const dayBase = seqLocalMs
            - h                       * 3_600_000
            - seqLocal.getUTCMinutes() *    60_000
            - seqLocal.getUTCSeconds() *     1_000
            - seqLocal.getUTCMilliseconds();

          if (h < winStart) {
            // Before window → snap to winStart same day
            seqLocalMs = dayBase
              + winStart * 3_600_000
              + Math.floor(Math.random() * 60) * 60_000
              + Math.floor(Math.random() * 60) *  1_000;
          } else if (h >= winEnd) {
            // After window → snap to winStart next day
            seqLocalMs = dayBase + 86_400_000
              + winStart * 3_600_000
              + Math.floor(Math.random() * 60) * 60_000
              + Math.floor(Math.random() * 60) *  1_000;
          }
        }

        sends.push({ contact, sequence: seq, scheduled_at: localMsToUtcISO(seqLocalMs) });
        prevLocalMs = seqLocalMs;
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
// contactData is used to personalise the custom unsubscribe footer variables.
function buildBody(html, sendId, trackClicks, trackOpens, canSpamFooter, customUnsubText, contactData = {}) {
  let body = html;
  const unsubUrl = `${BASE_URL()}/api/tracking/unsubscribe/${sendId}`;

  if (trackClicks) {
    body = body.replace(/href="(https?:\/\/[^"]+)"/g, (_, url) =>
      `href="${BASE_URL()}/api/tracking/click/${sendId}?url=${encodeURIComponent(url)}"`);
  }

  if (canSpamFooter) {
    // Full CAN-SPAM compliant footer
    body += `<br><br><div style="font-size:11px;color:#999;border-top:1px solid #eee;padding-top:10px;">
      You received this email as part of a business outreach.
      <a href="${unsubUrl}" style="color:#999;">Unsubscribe</a>
    </div>`;
  } else if (customUnsubText && customUnsubText.trim()) {
    // Custom unsubscribe footer with variable substitution.
    // Supports {{first_name}}, {{email}}, {{company}}, {{from_name}}, {{from_email}},
    // and the special {{unsubscribe_url}} token which becomes the tracking URL.
    const rendered = customUnsubText
      .replace(/{{unsubscribe_url}}/g, unsubUrl)
      .replace(/{{first_name}}/g,  contactData.first_name  || '')
      .replace(/{{last_name}}/g,   contactData.last_name   || '')
      .replace(/{{full_name}}/g,   [contactData.first_name, contactData.last_name].filter(Boolean).join(' ') || '')
      .replace(/{{email}}/g,       contactData.email        || '')
      .replace(/{{company}}/g,     contactData.company      || '')
      .replace(/{{title}}/g,       contactData.title        || '')
      .replace(/{{from_name}}/g,   contactData.from_name    || '')
      .replace(/{{from_email}}/g,  contactData.from_email   || '');
    body += `<br><br><div style="font-size:11px;color:#999;border-top:1px solid #eee;padding-top:10px;">${rendered}</div>`;
  } else {
    // Bare unsubscribe link (no CAN-SPAM footer, no custom text)
    body += `<br><br><small><a href="${unsubUrl}">Unsubscribe</a></small>`;
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

// ── Weighted inbox rotation by health + remaining capacity ──────────────────
// Instead of picking a random inbox, route more volume to healthier inboxes
// with more daily capacity left, and skip errored / at-capacity ones entirely.
//
//   weight = healthFactor × capacityFactor
//   • healthFactor   : warmed inboxes use their warmup_health (floored at 10 so a
//                      new warmup isn't starved); non-warmup inboxes are neutral (1.0)
//   • capacityFactor : remaining daily capacity ÷ daily limit (0 when at cap)
//
// This de-prioritizes degraded inboxes automatically (QuickMail-style) while
// still working for users who don't run warmup at all.
function pickWeightedAccount(pool, hourlyCache = {}) {
  const candidates = [];
  for (const a of pool) {
    if (a.status && a.status !== 'active') continue;            // skip errored/inactive
    const limit = a.daily_limit || 50;
    const remaining = limit - (a.sent_today || 0);
    if (remaining <= 0) continue;                               // at daily cap
    const perHour = a.emails_per_hour || 10;
    if (hourlyCache[a.id] != null && hourlyCache[a.id] >= perHour) continue; // hourly full
    const healthFactor   = a.warmup_enabled
      ? Math.max(10, Math.min(100, a.warmup_health || 0)) / 100
      : 1.0;
    const capacityFactor = remaining / limit;
    const weight = healthFactor * capacityFactor;
    if (weight > 0) candidates.push({ a, weight });
  }
  if (!candidates.length) return null;
  const total = candidates.reduce((s, c) => s + c.weight, 0);
  let r = Math.random() * total;
  for (const c of candidates) { r -= c.weight; if (r <= 0) return c.a; }
  return candidates[candidates.length - 1].a;
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
      u.can_spam_footer, u.custom_unsubscribe_text, u.timezone as user_timezone
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
  // Rotation pool accounts cached per rotation signature (avoids re-querying)
  const poolCache = {};

  for (let send of pending) {
    // ── Inbox rotation: weighted by health + remaining capacity ──
    if (send.rotation_account_ids) {
      try {
        const rotIds = JSON.parse(send.rotation_account_ids || '[]');
        if (rotIds.length > 1) {
          const key = send.rotation_account_ids;
          if (!poolCache[key]) {
            poolCache[key] = await dbAll(
              `SELECT * FROM email_accounts WHERE id IN (${rotIds.map(() => '?').join(',')})`,
              rotIds
            );
          }
          // Refresh sent_today from the live batch state isn't tracked here, but
          // the pool rows carry sent_today from their last load — good enough for
          // weighting; the hard daily/hourly checks below are the real guardrails.
          const chosen = pickWeightedAccount(poolCache[key], hourlyCache);
          if (chosen && chosen.id !== send.email_account_id) {
            send = { ...send, ...chosen, email_account_id: chosen.id, acc_limit: chosen.daily_limit || 50, smtp_pass: chosen.password };
          }
        }
      } catch {}
    }

    // ── Sending window check ──
    // Only send if current time is within this account's configured window.
    // Grace: if the send is more than 4h overdue we send anyway (prevents indefinite delay).
    const gracePeriodMs = 4 * 60 * 60 * 1000;
    const isOverdue     = Date.now() - new Date(send.scheduled_at).getTime() > gracePeriodMs;
    if (!isOverdue && !isWithinSendingWindow(send, send.user_timezone || 'UTC')) {
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
      // contactData passed to buildBody so custom unsubscribe footer can use {{email}}, {{first_name}}, etc.
      const contactData = { ...send, from_name: send.from_name, from_email: send.from_email };
      const finalBody = buildBody(rawBody, send.id, send.track_clicks, send.track_opens, send.can_spam_footer, send.custom_unsubscribe_text, contactData);

      const transporter = nodemailer.createTransport({
        host:   send.host,
        port:   send.port,
        secure: send.secure === 1 || send.port === 465,
        auth:   { user: send.username, pass: dec(send.smtp_pass) },
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
      // Keep the rotation pool cache in sync so weighting reflects this send
      // within the same batch (prevents over-loading one inbox in a burst).
      for (const k of Object.keys(poolCache)) {
        const row = poolCache[k].find(a => a.id === send.email_account_id);
        if (row) row.sent_today = (row.sent_today || 0) + 1;
      }
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
