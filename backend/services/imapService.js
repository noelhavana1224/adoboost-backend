const { dbAll, dbGet, dbRun } = require('../models/db');
const { v4: uuidv4 } = require('uuid');

const AUTO_REPLY_KEYWORDS = [
  'out of office', 'auto-reply', 'automatic reply', 'autoreply',
  'i am away', 'i am out', 'on vacation', 'on leave', 'on holiday',
  'will be back', 'returning on', 'away from the office',
  'do not reply', 'noreply', 'no-reply', 'unmonitored',
  'this is an automated', 'automated response', 'automatic response',
  'auto response', 'autoresponder',
];

function isAutoReply(subject, fromEmail) {
  const text = `${subject || ''} ${fromEmail || ''}`.toLowerCase();
  return AUTO_REPLY_KEYWORDS.some(kw => text.includes(kw));
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms)
    ),
  ]);
}

async function syncInbox(account) {
  const Imap = require('imap');
  const { simpleParser } = require('mailparser');

  // Use last_synced_at if available, otherwise last 7 days
  let sinceDate;
  if (account.last_synced_at) {
    sinceDate = new Date(account.last_synced_at);
    sinceDate.setHours(sinceDate.getHours() - 1); // 1hr overlap to catch stragglers
  } else {
    sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - 7);
  }
  const sinceStr = sinceDate.toISOString().split('T')[0];

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

  return withTimeout(new Promise((resolve, reject) => {
    imap.once('ready', async () => {
      try {
        await new Promise((res, rej) => {
          imap.openBox('INBOX', false, (err) => err ? rej(err) : res());
        });

        const results = await new Promise((res, rej) => {
          imap.search(['ALL', ['SINCE', sinceStr]], (err, uids) => {
            if (err) rej(err);
            else res(uids || []);
          });
        });

        if (!results.length) {
          imap.end();
          return resolve({ synced: 0 });
        }

        const toFetch = results.slice(-50);
        const fetch = imap.fetch(toFetch, { bodies: '', markSeen: false });
        const emails = [];

        fetch.on('message', (msg) => {
          let buffer = '';
          msg.on('body', (stream) => {
            stream.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
            stream.once('end', () => emails.push(buffer));
          });
        });

        await new Promise((res) => fetch.once('end', res));

        let synced = 0;
        for (const raw of emails) {
          try {
            const parsed = await simpleParser(raw);
            const fromEmail  = parsed.from?.value?.[0]?.address?.toLowerCase() || '';
            const fromName   = parsed.from?.value?.[0]?.name || '';
            const subject    = parsed.subject || '';
            const body       = parsed.text || parsed.html || '';
            const messageId  = parsed.messageId || uuidv4();
            const receivedAt = parsed.date?.toISOString() || new Date().toISOString();

            // Skip if already stored
            const existing = await dbGet('SELECT id FROM messages WHERE message_id=?', [messageId]);
            if (existing) continue;

            // Skip our own outgoing emails showing in inbox
            if (fromEmail === account.username.toLowerCase()) continue;
            if (fromEmail === account.from_email?.toLowerCase()) continue;

            // Try to match to a campaign send — OPTIONAL, not required
            const send = await dbGet(`
              SELECT s.id, s.campaign_id
              FROM sends s
              JOIN campaigns c ON s.campaign_id = c.id
              JOIN contacts ct ON s.contact_id = ct.id
              WHERE ct.email = ? AND c.user_id = ? AND s.status = 'sent'
              ORDER BY s.sent_at DESC LIMIT 1
            `, [fromEmail, account.user_id]);

            const autoReply = isAutoReply(subject, fromEmail) ? 1 : 0;
            const status = autoReply ? 'auto-reply' : 'unread';

            // ── Detect warmup emails ──────────────────────────────────────────
            // An email is a warmup email if the sender is another AdoBoost
            // email account (any user) — meaning it came from the warmup network.
            // Also check the X-Warmup-Email header set by the warmup engine.
            const warmupHeader = parsed.headers?.get('x-warmup-email') || '';
            const senderIsAdoBoostAccount = await dbGet(
              'SELECT id FROM email_accounts WHERE LOWER(from_email)=? OR LOWER(username)=?',
              [fromEmail, fromEmail]
            );
            const isWarmup = (warmupHeader === 'true' || !!senderIsAdoBoostAccount) ? 1 : 0;

            // ✅ Save ALL incoming emails — campaign match is a bonus, not a requirement
            await dbRun(`
              INSERT INTO messages (id, user_id, campaign_id, from_email, from_name, subject, body, message_id, received_at, status, is_auto_reply, is_warmup)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
              uuidv4(),
              account.user_id,
              send?.campaign_id || null,
              fromEmail,
              fromName,
              subject,
              body.slice(0, 10000),
              messageId,
              receivedAt,
              status,
              autoReply,
              isWarmup,
            ]);

            // If matched to a campaign send, mark contact as replied
            if (send) {
              await dbRun('UPDATE sends SET replied=1 WHERE id=?', [send.id]);
            }

            synced++;
          } catch (e) {
            console.error('Error parsing email:', e.message);
          }
        }

        // Update last synced timestamp
        await dbRun('UPDATE email_accounts SET last_synced_at=? WHERE id=?',
          [new Date().toISOString(), account.id]);

        imap.end();
        resolve({ synced });
      } catch (e) {
        imap.end();
        reject(e);
      }
    });

    imap.once('error', (e) => reject(e));
    imap.connect();
  }), 60000, `syncInbox for ${account.username}`);
}

async function syncAllInboxes() {
  try {
    const accounts = await dbAll(`
      SELECT * FROM email_accounts
      WHERE imap_host IS NOT NULL AND imap_host != ''
    `);

    for (const account of accounts) {
      try {
        const result = await syncInbox(account);
        if (result.synced > 0) {
          console.log(`Synced ${result.synced} emails for ${account.username}`);
        }
      } catch (e) {
        console.error(`Failed to sync ${account.username}: ${e.message}`);
      }
    }
  } catch (e) {
    console.error('syncAllInboxes error:', e.message);
  }
}

module.exports = { syncInbox, syncAllInboxes };
