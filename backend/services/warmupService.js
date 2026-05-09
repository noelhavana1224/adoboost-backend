const nodemailer = require('nodemailer');
const { dbAll, dbGet, dbRun } = require('../models/db');
const { v4: uuidv4 } = require('uuid');
const Imap = require('imap');
const { simpleParser } = require('mailparser');

// ── Warmup email subjects & bodies (natural sounding) ──
const WARMUP_SUBJECTS = [
  'Quick question for you',
  'Following up on something',
  'Thoughts on this?',
  'Checking in',
  'Have you seen this?',
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
];

const WARMUP_BODIES = [
  `Hi there,\n\nI hope this message finds you well. I wanted to reach out and connect briefly. It's always great to stay in touch with colleagues in the industry.\n\nLooking forward to hearing from you!\n\nBest regards`,
  `Hello,\n\nJust wanted to drop you a quick note. I've been thinking about some ideas lately and would love to get your perspective when you have a moment.\n\nThanks for your time!`,
  `Hi,\n\nHope you're having a great week! I wanted to touch base and see how things are going on your end. Always good to stay connected.\n\nTalk soon!`,
  `Good morning,\n\nI came across something interesting recently and immediately thought of you. Would love to share more details when you're free.\n\nBest wishes`,
  `Hello there,\n\nJust a quick note to say I appreciate our connection. It's important to stay in touch with great people in the network.\n\nHope to chat soon!`,
  `Hi,\n\nThought I'd reach out today. Been a while since we last connected and I wanted to check in to see how everything is going.\n\nWarm regards`,
  `Hey,\n\nHope all is well! I had a few thoughts I wanted to share with you. Nothing urgent, just wanted to keep the conversation going.\n\nTake care!`,
  `Hello,\n\nI wanted to reach out and say that it's always great connecting with professionals in our space. Looking forward to future conversations.\n\nBest`,
];

const WARMUP_REPLIES = [
  `Thanks for reaching out! Great to hear from you. I'll be in touch soon.`,
  `Hi! Thanks for the message. Really appreciate you taking the time to connect.`,
  `Hello! Thanks for reaching out. Always great to stay connected. Will follow up shortly.`,
  `Thanks for the note! Great to hear from you. Looking forward to staying in touch.`,
  `Hi there! Appreciate the message. Will definitely get back to you with more details soon.`,
  `Thanks for reaching out! This is great timing. Let's definitely stay in touch.`,
  `Hello! Thanks so much for connecting. Really appreciate it. Talk soon!`,
  `Hi! Great to hear from you. Thanks for the message. Will respond in more detail shortly.`,
];

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Get today's warmup target for an account ────
function getDailyTarget(account) {
  const startCount  = account.warmup_start_count  || 2;
  const increment   = account.warmup_increment    || 2;
  const maxCount    = account.warmup_max_count    || 40;
  const warmupDays  = account.warmup_days         || 0;
  const target = Math.min(startCount + (increment * warmupDays), maxCount);
  return target;
}

// ── Send one warmup email ────────────────────────
async function sendWarmupEmail(fromAccount, toAccount) {
  try {
    const transporter = nodemailer.createTransport({
      host: fromAccount.host,
      port: fromAccount.port,
      secure: fromAccount.secure === 1 || fromAccount.port === 465,
      auth: { user: fromAccount.username, pass: fromAccount.password },
      tls: { rejectUnauthorized: false },
    });

    const subject = randomItem(WARMUP_SUBJECTS);
    const body    = randomItem(WARMUP_BODIES);
    const msgId   = uuidv4();

    await transporter.sendMail({
      from: `"${fromAccount.from_name}" <${fromAccount.from_email}>`,
      to:   toAccount.from_email,
      subject,
      text: body,
      html: body.replace(/\n/g, '<br>'),
      headers: { 'X-Warmup-Email': 'true', 'X-Warmup-Id': msgId },
    });

    // Log the warmup send
    await dbRun(`
      INSERT INTO warmup_logs (id, account_id, direction, partner_email, subject, status, created_at)
      VALUES (?, ?, 'sent', ?, ?, 'sent', ?)
    `, [uuidv4(), fromAccount.id, toAccount.from_email, subject, new Date().toISOString()]);

    return { success: true, msgId, subject };
  } catch (e) {
    console.error(`Warmup send error ${fromAccount.from_email} → ${toAccount.from_email}:`, e.message);
    await dbRun(`
      INSERT INTO warmup_logs (id, account_id, direction, partner_email, subject, status, error, created_at)
      VALUES (?, ?, 'sent', ?, ?, 'failed', ?, ?)
    `, [uuidv4(), fromAccount.id, toAccount.from_email, 'Warmup email', 'failed', e.message, new Date().toISOString()]);
    return { success: false, error: e.message };
  }
}

// ── Auto-reply to warmup emails via IMAP ─────────
async function autoReplyWarmupEmails(account) {
  if (!account.imap_host) return { replied: 0 };

  try {
    const imap = new Imap({
      user: account.username,
      password: account.password,
      host: account.imap_host,
      port: account.imap_port || 993,
      tls: account.imap_secure === 1 || account.imap_port === 993,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 15000,
      authTimeout: 10000,
    });

    return await new Promise((resolve, reject) => {
      imap.once('ready', async () => {
        try {
          await new Promise((res, rej) => imap.openBox('INBOX', false, err => err ? rej(err) : res()));

          // Search for warmup emails from last 2 days
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
            msg.on('body', stream => {
              stream.on('data', chunk => buffer += chunk.toString('utf8'));
              stream.once('end', () => emails.push(buffer));
            });
          });

          await new Promise(res => fetch.once('end', res));

          let replied = 0;
          for (const raw of emails) {
            try {
              const parsed = await simpleParser(raw);
              const fromEmail = parsed.from?.value?.[0]?.address?.toLowerCase();
              if (!fromEmail) continue;

              // Only auto-reply to warmup emails from other AdoBoost accounts
              const partnerAccount = await dbGet(
                `SELECT * FROM email_accounts WHERE LOWER(from_email)=? AND warmup_enabled=1`,
                [fromEmail]
              );
              if (!partnerAccount) continue;

              // Send auto-reply
              const transporter = nodemailer.createTransport({
                host: account.host, port: account.port,
                secure: account.secure === 1 || account.port === 465,
                auth: { user: account.username, pass: account.password },
                tls: { rejectUnauthorized: false },
              });

              const replyText = randomItem(WARMUP_REPLIES);
              await transporter.sendMail({
                from: `"${account.from_name}" <${account.from_email}>`,
                to:   fromEmail,
                subject: `Re: ${parsed.subject || 'Warmup'}`,
                text:  replyText,
                html:  replyText.replace(/\n/g, '<br>'),
                headers: { 'X-Warmup-Email': 'true' },
              });

              await dbRun(`
                INSERT INTO warmup_logs (id, account_id, direction, partner_email, subject, status, created_at)
                VALUES (?, ?, 'replied', ?, ?, 'sent', ?)
              `, [uuidv4(), account.id, fromEmail, `Re: ${parsed.subject}`, new Date().toISOString()]);

              replied++;
              await sleep(3000); // Small delay between replies
            } catch (e) {
              console.error('Auto-reply error:', e.message);
            }
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

// ── Main warmup processor ────────────────────────
async function processWarmup() {
  try {
    // Get all warmup-enabled accounts
    const accounts = await dbAll(`
      SELECT * FROM email_accounts WHERE warmup_enabled=1
    `);

    if (accounts.length < 2) {
      console.log('⚠️ Need at least 2 warmup-enabled accounts to run warmup network');
      return;
    }

    console.log(`🌡️ Running warmup for ${accounts.length} accounts...`);

    for (const account of accounts) {
      try {
        const target = getDailyTarget(account);

        // Check how many warmup emails sent today
        const today = new Date().toISOString().split('T')[0];
        const sentToday = await dbGet(`
          SELECT COUNT(*) as c FROM warmup_logs
          WHERE account_id=? AND direction='sent' AND status='sent'
          AND DATE(created_at)=?
        `, [account.id, today]);

        const alreadySent = sentToday?.c || 0;
        const toSend = Math.max(0, target - alreadySent);

        if (toSend === 0) {
          console.log(`✅ ${account.from_email}: daily target ${target} already reached`);
          continue;
        }

        // Pick random partner accounts (not self, not same user)
        const partners = accounts.filter(a =>
          a.id !== account.id &&
          a.from_email !== account.from_email
        );

        if (!partners.length) continue;

        let sent = 0;
        for (let i = 0; i < toSend && i < partners.length; i++) {
          // Rotate through partners
          const partner = partners[i % partners.length];
          const result = await sendWarmupEmail(account, partner);
          if (result.success) {
            sent++;
            console.log(`✅ Warmup: ${account.from_email} → ${partner.from_email}`);
            // Random delay 30-90s between warmup sends
            await sleep(Math.floor(Math.random() * 60000) + 30000);
          }
        }

        // Auto-reply to received warmup emails
        const { replied } = await autoReplyWarmupEmails(account);
        if (replied > 0) console.log(`↩️ Auto-replied to ${replied} warmup emails for ${account.from_email}`);

        // Update warmup days counter
        const lastWarmup = account.last_warmup_at;
        const lastDate   = lastWarmup ? new Date(lastWarmup).toISOString().split('T')[0] : null;
        if (lastDate !== today && sent > 0) {
          await dbRun(`
            UPDATE email_accounts SET warmup_days=warmup_days+1, last_warmup_at=? WHERE id=?
          `, [new Date().toISOString(), account.id]);
        }

        // Update warmup health score
        const replyRate = await getReplyRate(account.id);
        const health = Math.min(100, Math.round(
          (Math.min(account.warmup_days || 0, 30) / 30) * 50 + // 50pts for days completed
          replyRate * 50  // 50pts for reply rate
        ));
        await dbRun(`UPDATE email_accounts SET warmup_health=? WHERE id=?`, [health, account.id]);

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
    const sent = await dbGet(`SELECT COUNT(*) as c FROM warmup_logs WHERE account_id=? AND direction='sent' AND status='sent'`, [accountId]);
    const replied = await dbGet(`SELECT COUNT(*) as c FROM warmup_logs WHERE account_id=? AND direction='replied' AND status='sent'`, [accountId]);
    if (!sent?.c) return 0;
    return Math.min(1, (replied?.c || 0) / (sent?.c || 1));
  } catch { return 0; }
}

module.exports = { processWarmup, getDailyTarget, getReplyRate };
