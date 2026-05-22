/**
 * Humanized Warmup Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs every 30 minutes (changed in server.js).
 * Each run:
 *   1. Finds accounts that still need warmup emails today
 *   2. For each eligible account, there is a 70% chance an email is sent
 *      this run (30% random skip → non-robotic pattern)
 *   3. Only one email per account per run — spread throughout the day
 *   4. Checks warmup window (warmup_window_start → warmup_window_end)
 *   5. Auto-replies to received warmup emails via IMAP (natural conversation)
 *
 * Result: warmup emails land at unpredictable intervals throughout the day,
 * completely indistinguishable from a human manually sending them.
 */

const nodemailer = require('nodemailer');
const { dbAll, dbGet, dbRun } = require('../models/db');
const { v4: uuidv4 } = require('uuid');
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const { getHourInTz } = require('../utils/timezone');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ── Humanized warmup email content ──────────────
// Multiple categories for realistic variety
const WARMUP_SUBJECTS = [
  'Quick question for you',
  'Following up on something',
  'Thoughts on this?',
  'Checking in',
  'Quick note',
  'Wanted to share something',
  'A few thoughts',
  'Hope this finds you well',
  'Reaching out',
  'Quick update',
  'Something I wanted to mention',
  'Been thinking about this',
  'Catching up',
  'A quick hello',
  'Touching base',
  'Any thoughts on this?',
  'Worth discussing',
  'Quick heads-up',
  'A small update',
  'Staying connected',
];

// Short variants (2-4 lines) — look like real quick emails
const WARMUP_BODIES_SHORT = [
  `Hi,\n\nJust wanted to touch base briefly. Hope things are going well on your end.\n\nTalk soon!`,
  `Hello,\n\nHope you're having a good week! Just checking in.\n\nBest`,
  `Hey,\n\nQuick note — hope all is well. Let's stay in touch.\n\nCheers`,
  `Hi,\n\nJust a quick hello. Hope everything's going smoothly.\n\nTake care!`,
  `Hello,\n\nHoped to catch you for a moment. Nothing urgent — just wanted to connect.\n\nBest regards`,
];

// Medium variants (4-6 lines) — slightly more substance
const WARMUP_BODIES_MEDIUM = [
  `Hi,\n\nI hope this message finds you well. I wanted to reach out and connect briefly. It's always great to stay in touch with colleagues in the industry.\n\nLooking forward to hearing from you!\n\nBest regards`,
  `Hello,\n\nJust wanted to drop you a quick note. I've been thinking about a few things lately and would love to get your perspective when you have a moment.\n\nThanks for your time!`,
  `Good morning,\n\nI came across something interesting recently and immediately thought of you. Would love to share more details when you're free.\n\nBest wishes`,
  `Hi,\n\nThought I'd reach out today. It's been a while since we last connected and I wanted to check in to see how everything is going.\n\nWarm regards`,
  `Hello,\n\nHope all is well! I had a few thoughts I wanted to share with you. Nothing urgent — just wanted to keep the conversation going.\n\nTake care!`,
];

// Long variants (6+ lines) — used occasionally for realism
const WARMUP_BODIES_LONG = [
  `Hi there,\n\nI hope this message finds you well. I was thinking about reaching out for a while now — it's always great to stay connected with professionals in the space.\n\nI've been exploring a few new ideas lately and thought they might be worth discussing. No rush at all, just wanted to plant a seed for a future conversation.\n\nLet me know if you'd be open to connecting!\n\nBest regards`,
  `Hello,\n\nHope things are going well on your end. I've been meaning to reach out for a bit.\n\nI have a few thoughts on some industry developments I'd love to get your take on when you have some bandwidth. It's nothing time-sensitive, just something worth a quick chat about when the timing is right.\n\nLooking forward to hearing from you.\n\nWarm regards`,
];

const WARMUP_REPLIES = [
  `Thanks for reaching out! Great to hear from you. I'll be in touch soon.`,
  `Hi! Thanks for the message. Really appreciate you taking the time to connect.`,
  `Thanks for the note! Great to hear from you. Looking forward to staying in touch.`,
  `Hi there! Appreciate the message. Will definitely follow up with more details soon.`,
  `Thanks for reaching out! This is great timing. Let's definitely stay in touch.`,
  `Hello! Thanks so much for connecting. Really appreciate it. Talk soon!`,
  `Hi! Great to hear from you. Will respond in more detail shortly.`,
  `Thanks for the hello! Always great to connect. Speak soon.`,
];

// ── Pick a body with realistic length distribution ──
function pickBody() {
  const r = Math.random();
  if (r < 0.35)      return randomItem(WARMUP_BODIES_SHORT);   // 35% short
  else if (r < 0.80) return randomItem(WARMUP_BODIES_MEDIUM);  // 45% medium
  else               return randomItem(WARMUP_BODIES_LONG);     // 20% long
}

// ── Check if within warmup sending window ──────
// account.user_timezone is joined from users table in processWarmup()
function isWithinWarmupWindow(account) {
  const timezone = account.user_timezone || 'UTC';
  const hour     = getHourInTz(timezone);
  const winStart = account.warmup_window_start ?? 9;
  const winEnd   = account.warmup_window_end   ?? 17;
  return hour >= winStart && hour < winEnd;
}

// ── Get today's target for an account ──────────
function getDailyTarget(account) {
  const startCount = account.warmup_start_count || 2;
  const increment  = account.warmup_increment   || 2;
  const maxCount   = account.warmup_max_count   || 40;
  const warmupDays = account.warmup_days        || 0;
  return Math.min(startCount + increment * warmupDays, maxCount);
}

// ── Send one warmup email ───────────────────────
async function sendWarmupEmail(fromAccount, toAccount) {
  try {
    const transporter = nodemailer.createTransport({
      host:   fromAccount.host,
      port:   fromAccount.port,
      secure: fromAccount.secure === 1 || fromAccount.port === 465,
      auth:   { user: fromAccount.username, pass: fromAccount.password },
      tls:    { rejectUnauthorized: false },
    });

    const subject = randomItem(WARMUP_SUBJECTS);
    const body    = pickBody();
    const msgId   = uuidv4();

    await transporter.sendMail({
      from:    `"${fromAccount.from_name}" <${fromAccount.from_email}>`,
      to:      toAccount.from_email,
      subject,
      text:    body,
      html:    body.replace(/\n/g, '<br>'),
      headers: { 'X-Warmup-Email': 'true', 'X-Warmup-Id': msgId },
    });

    await dbRun(`
      INSERT INTO warmup_logs (id,account_id,direction,partner_email,subject,status,created_at)
      VALUES (?,?,'sent',?,?,'sent',?)
    `, [uuidv4(), fromAccount.id, toAccount.from_email, subject, new Date().toISOString()]);

    return { success: true };
  } catch (e) {
    console.error(`Warmup send error ${fromAccount.from_email} → ${toAccount.from_email}:`, e.message);
    await dbRun(`
      INSERT INTO warmup_logs (id,account_id,direction,partner_email,subject,status,error,created_at)
      VALUES (?,?,'sent',?,'Warmup email','failed',?,?)
    `, [uuidv4(), fromAccount.id, toAccount.from_email, e.message, new Date().toISOString()]);
    return { success: false };
  }
}

// ── Auto-reply to received warmup emails (IMAP) ─
async function autoReplyWarmupEmails(account) {
  if (!account.imap_host) return { replied: 0 };
  try {
    const imap = new Imap({
      user:        account.username,
      password:    account.password,
      host:        account.imap_host,
      port:        account.imap_port || 993,
      tls:         account.imap_secure === 1 || account.imap_port === 993,
      tlsOptions:  { rejectUnauthorized: false },
      connTimeout: 15000,
      authTimeout: 10000,
    });

    return await new Promise((resolve, reject) => {
      imap.once('ready', async () => {
        try {
          await new Promise((res, rej) => imap.openBox('INBOX', false, err => err ? rej(err) : res()));

          const since = new Date();
          since.setDate(since.getDate() - 2);
          const sinceStr = since.toISOString().split('T')[0];

          const uids = await new Promise((res, rej) =>
            imap.search(['UNSEEN', ['SINCE', sinceStr], ['HEADER', 'X-Warmup-Email', 'true']], (err, ids) =>
              err ? rej(err) : res(ids || [])
            )
          );

          if (!uids.length) { imap.end(); return resolve({ replied: 0 }); }

          const fetch = imap.fetch(uids, { bodies: '', markSeen: true });
          const emails = [];
          fetch.on('message', msg => {
            let buffer = '';
            msg.on('body', stream => { stream.on('data', chunk => buffer += chunk.toString('utf8')); stream.once('end', () => emails.push(buffer)); });
          });
          await new Promise(res => fetch.once('end', res));

          let replied = 0;
          for (const raw of emails) {
            try {
              const parsed     = await simpleParser(raw);
              const fromEmail  = parsed.from?.value?.[0]?.address?.toLowerCase();
              if (!fromEmail) continue;

              const partner = await dbGet(
                `SELECT * FROM email_accounts WHERE LOWER(from_email)=? AND warmup_enabled=1`,
                [fromEmail]
              );
              if (!partner) continue;

              // Small random delay before replying (5-25s) — human pacing
              await sleep(5000 + Math.floor(Math.random() * 20000));

              const transporter = nodemailer.createTransport({
                host: account.host, port: account.port,
                secure: account.secure === 1 || account.port === 465,
                auth:   { user: account.username, pass: account.password },
                tls:    { rejectUnauthorized: false },
              });

              const replyText = randomItem(WARMUP_REPLIES);
              await transporter.sendMail({
                from:    `"${account.from_name}" <${account.from_email}>`,
                to:      fromEmail,
                subject: `Re: ${parsed.subject || 'Warmup'}`,
                text:    replyText,
                html:    replyText.replace(/\n/g, '<br>'),
                headers: { 'X-Warmup-Email': 'true' },
              });

              await dbRun(`
                INSERT INTO warmup_logs (id,account_id,direction,partner_email,subject,status,created_at)
                VALUES (?,?,'replied',?,?,'sent',?)
              `, [uuidv4(), account.id, fromEmail, `Re: ${parsed.subject}`, new Date().toISOString()]);

              replied++;
            } catch (e) { console.error('Auto-reply error:', e.message); }
          }
          imap.end();
          resolve({ replied });
        } catch (e) { imap.end(); reject(e); }
      });
      imap.once('error', reject);
      imap.connect();
    });
  } catch (e) {
    console.error(`Auto-reply error for ${account.username}:`, e.message);
    return { replied: 0 };
  }
}

// ── Main warmup processor (called every 30 min) ─────────────────────────────
// KEY DESIGN: sends ONE email per eligible account per run with 70% probability.
// This naturally spreads warmup emails throughout the day in a completely
// unpredictable human-like pattern.
async function processWarmup() {
  try {
    // Skip weekends
    const dow = new Date().getDay();
    if (dow === 0 || dow === 6) {
      console.log('📅 Warmup skipped — weekend.');
      return;
    }

    const accounts = await dbAll(`
      SELECT ea.*, u.timezone AS user_timezone
      FROM email_accounts ea
      JOIN users u ON ea.user_id = u.id
      WHERE ea.warmup_enabled=1
    `);
    if (accounts.length < 2) {
      console.log('⚠️ Need ≥2 warmup-enabled accounts');
      return;
    }

    const today = new Date().toISOString().split('T')[0];
    console.log(`🌡️ Warmup pulse — ${accounts.length} accounts, ${new Date().toLocaleTimeString()}`);

    for (const account of accounts) {
      try {
        // ── Window check ──
        if (!isWithinWarmupWindow(account)) {
          continue; // Outside warmup window for this account
        }

        const target = getDailyTarget(account);

        // Count already sent today
        const sentRow = await dbGet(`
          SELECT COUNT(*) as c FROM warmup_logs
          WHERE account_id=? AND direction='sent' AND status='sent' AND DATE(created_at)=?
        `, [account.id, today]);
        const alreadySent = sentRow?.c || 0;

        if (alreadySent >= target) {
          // Daily target reached — try auto-replies instead
          const { replied } = await autoReplyWarmupEmails(account);
          if (replied > 0) console.log(`↩️ Auto-replied ${replied}x for ${account.from_email}`);
          continue;
        }

        // ── Stochastic skip: 30% chance of NOT sending this run ──
        // This creates natural randomness — on a 30-min cron with 70% hit rate,
        // emails arrive at statistically unpredictable intervals.
        if (Math.random() < 0.30) {
          console.log(`⏭ Warmup skip (random) for ${account.from_email} — will retry next run`);
          continue;
        }

        // ── Pick a random partner account ──
        const partners = accounts.filter(a =>
          a.id !== account.id && a.from_email !== account.from_email
        );
        if (!partners.length) continue;

        // Prefer partners we haven't sent to recently (last 2 days)
        const recentRows = await dbAll(`
          SELECT partner_email FROM warmup_logs
          WHERE account_id=? AND direction='sent' AND DATE(created_at)>=DATE('now','-2 days')
        `, [account.id]);
        const recentSet = new Set(recentRows.map(r => r.partner_email));
        const freshPartners = partners.filter(p => !recentSet.has(p.from_email));
        const partner = randomItem(freshPartners.length ? freshPartners : partners);

        const result = await sendWarmupEmail(account, partner);
        if (result.success) {
          console.log(`✅ Warmup: ${account.from_email} → ${partner.from_email} (${alreadySent + 1}/${target} today)`);

          // Update warmup days counter (once per day)
          const lastWarmupDate = account.last_warmup_at
            ? new Date(account.last_warmup_at).toISOString().split('T')[0]
            : null;
          if (lastWarmupDate !== today) {
            await dbRun(`
              UPDATE email_accounts SET warmup_days=warmup_days+1, last_warmup_at=? WHERE id=?
            `, [new Date().toISOString(), account.id]);
          }

          // Update health score
          const replyRate = await getReplyRate(account.id);
          const health = Math.min(100, Math.round(
            (Math.min(account.warmup_days || 0, 30) / 30) * 50 +
            replyRate * 50
          ));
          await dbRun(`UPDATE email_accounts SET warmup_health=? WHERE id=?`, [health, account.id]);
        }

        // Check for incoming warmup emails to reply to (opportunistic)
        const { replied } = await autoReplyWarmupEmails(account);
        if (replied > 0) console.log(`↩️ Auto-replied ${replied}x for ${account.from_email}`);

        // Brief inter-account pause (2-8s) to avoid simultaneous SMTP connections
        await sleep(2000 + Math.floor(Math.random() * 6000));

      } catch (e) {
        console.error(`Warmup error for ${account.from_email}:`, e.message);
      }
    }
  } catch (e) {
    console.error('processWarmup error:', e.message);
  }
}

// ── Get reply rate for health score ─────────────
async function getReplyRate(accountId) {
  try {
    const sent    = await dbGet(`SELECT COUNT(*) as c FROM warmup_logs WHERE account_id=? AND direction='sent'   AND status='sent'`, [accountId]);
    const replied = await dbGet(`SELECT COUNT(*) as c FROM warmup_logs WHERE account_id=? AND direction='replied' AND status='sent'`, [accountId]);
    if (!sent?.c) return 0;
    return Math.min(1, (replied?.c || 0) / (sent?.c || 1));
  } catch { return 0; }
}

module.exports = { processWarmup, getDailyTarget, getReplyRate };
