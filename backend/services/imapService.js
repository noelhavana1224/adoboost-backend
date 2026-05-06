const { dbAll, dbGet, dbRun } = require('../models/db');
const { v4: uuidv4 } = require('uuid');

// Auto-reply detection keywords
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

async function syncInbox(account) {
  try {
    const Imap = require('imap');
    const { simpleParser } = require('mailparser');

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

    await new Promise((resolve, reject) => {
      imap.once('ready', async () => {
        try {
          // Open INBOX
          await new Promise((res, rej) => {
            imap.openBox('INBOX', false, (err) => err ? rej(err) : res());
          });

          // Search for emails from last 7 days
          const since = new Date();
          since.setDate(since.getDate() - 7);
          const sinceStr = since.toISOString().split('T')[0];

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

          // Fetch recent 50 emails
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
              const fromEmail = parsed.from?.value?.[0]?.address?.toLowerCase() || '';
              const fromName = parsed.from?.value?.[0]?.name || '';
              const subject = parsed.subject || '';
              const body = parsed.text || parsed.html || '';
              const messageId = parsed.messageId || uuidv4();
              const receivedAt = parsed.date?.toISOString() || new Date().toISOString();

              // Skip if already stored
              const existing = await dbGet('SELECT id FROM messages WHERE message_id=?', [messageId]);
              if (existing) continue;

              // Skip our own emails
              if (fromEmail === account.username.toLowerCase()) continue;
              if (fromEmail === account.from_email?.toLowerCase()) continue;

              // Try to match to a campaign send
              const send = await dbGet(`
                SELECT s.id, s.campaign_id, c.user_id
                FROM sends s
                JOIN campaigns c ON s.campaign_id = c.id
                JOIN contacts ct ON s.contact_id = ct.id
                WHERE ct.email = ? AND c.user_id = ? AND s.status = 'sent'
                ORDER BY s.sent_at DESC LIMIT 1
              `, [fromEmail, account.user_id]);

              const autoReply = isAutoReply(subject, fromEmail) ? 1 : 0;

              await dbRun(`
                INSERT INTO messages (id, user_id, campaign_id, from_email, from_name, subject, body, message_id, received_at, status, is_auto_reply)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `, [
                uuidv4(),
                account.user_id,
                send?.campaign_id || null,
                fromEmail,
                fromName,
                subject,
                body.slice(0, 5000),
                messageId,
                receivedAt,
                autoReply ? 'auto-reply' : 'engaging',
                autoReply,
              ]);

              // Mark contact as replied if matched
              if (send) {
                await dbRun(`UPDATE sends SET replied=1 WHERE id=?`, [send.id]);
              }

              synced++;
            } catch (e) {
              console.error('Error parsing email:', e.message);
            }
          }

          // Update last synced time
          await dbRun('UPDATE email_accounts SET last_synced_at=? WHERE id=?', [new Date().toISOString(), account.id]);

          imap.end();
          resolve({ synced });
        } catch (e) {
          imap.end();
          reject(e);
        }
      });

      imap.once('error', reject);
      imap.connect();
    });

  } catch (e) {
    console.error(`IMAP sync error for ${account.username}:`, e.message);
    throw e;
  }
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
        console.error(`Failed to sync ${account.username}:`, e.message);
      }
    }
  } catch (e) {
    console.error('syncAllInboxes error:', e.message);
  }
}

module.exports = { syncInbox, syncAllInboxes };
