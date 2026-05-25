const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// ── PERMANENT FIX: Always use persistent storage ──────────────────────────
// Hardcoded fallback so even if .env is missing (Hostinger redeploy wipes it),
// the app ALWAYS points to the correct persistent database.
const DATA_DIR = process.env.DATA_DIR || '/home/u346663333/adoboost-data';
const DB_PATH = path.join(DATA_DIR, 'adoboost.db');
let db;

function getDb() {
  if (!db) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new sqlite3.Database(DB_PATH);
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA foreign_keys = ON');
    console.log(`📦 Database: ${DB_PATH}`);
    initSchema();
    runMigrations();
  }
  return db;
}

function initSchema() {
  db.serialize(() => {
    // Users
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
      name TEXT NOT NULL, role TEXT DEFAULT 'user',
      plan TEXT DEFAULT 'trial', plan_expires_at DATETIME,
      is_suspended INTEGER DEFAULT 0, suspension_reason TEXT,
      timezone TEXT DEFAULT 'UTC',
      notify_replies INTEGER DEFAULT 1, notify_email TEXT,
      can_spam_footer INTEGER DEFAULT 1,
      company TEXT, address TEXT, country TEXT, city TEXT, zip TEXT,
      api_key TEXT UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_login DATETIME)`);

    // SMTP / Email Accounts
    db.run(`CREATE TABLE IF NOT EXISTS email_accounts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      name TEXT NOT NULL, type TEXT DEFAULT 'smtp',
      host TEXT, port INTEGER DEFAULT 587, secure INTEGER DEFAULT 0,
      username TEXT NOT NULL, password TEXT NOT NULL,
      from_name TEXT, from_email TEXT NOT NULL,
      daily_limit INTEGER DEFAULT 100, sent_today INTEGER DEFAULT 0,
      warmup_enabled INTEGER DEFAULT 0, warmup_days INTEGER DEFAULT 0,
      last_reset DATE, status TEXT DEFAULT 'active',
      tags TEXT DEFAULT '[]',
      imap_host TEXT DEFAULT '',
      imap_port INTEGER DEFAULT 993,
      imap_secure INTEGER DEFAULT 1,
      last_synced_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id))`);

    // Contact Lists
    db.run(`CREATE TABLE IF NOT EXISTS lists (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      name TEXT NOT NULL, description TEXT,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id))`);

    // Contacts
    db.run(`CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, list_id TEXT,
      email TEXT NOT NULL, first_name TEXT, last_name TEXT,
      company TEXT, title TEXT, phone TEXT, website TEXT,
      custom_fields TEXT DEFAULT '{}',
      status TEXT DEFAULT 'active',
      is_good INTEGER DEFAULT 1,
      unsubscribed INTEGER DEFAULT 0, bounced INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (list_id) REFERENCES lists(id))`);

    // Campaigns
    db.run(`CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      name TEXT NOT NULL, status TEXT DEFAULT 'draft',
      email_account_id TEXT, list_id TEXT,
      schedule_type TEXT DEFAULT 'immediate',
      scheduled_at DATETIME,
      daily_limit INTEGER DEFAULT 50,
      track_opens INTEGER DEFAULT 1, track_clicks INTEGER DEFAULT 1,
      sending_speed INTEGER DEFAULT 100,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME, completed_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id))`);

    // Email Sequences (campaign steps)
    db.run(`CREATE TABLE IF NOT EXISTS sequences (
      id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL,
      step_number INTEGER NOT NULL,
      subject TEXT NOT NULL, body TEXT NOT NULL,
      delay_days INTEGER DEFAULT 0, delay_hours INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE)`);

    // Email Sends
    db.run(`CREATE TABLE IF NOT EXISTS sends (
      id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL,
      sequence_id TEXT NOT NULL, contact_id TEXT NOT NULL,
      email_account_id TEXT, status TEXT DEFAULT 'pending',
      scheduled_at DATETIME, sent_at DATETIME,
      opened_at DATETIME, clicked_at DATETIME,
      replied INTEGER DEFAULT 0, bounced INTEGER DEFAULT 0,
      unsubscribed INTEGER DEFAULT 0,
      error_message TEXT, message_id TEXT,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
      FOREIGN KEY (sequence_id) REFERENCES sequences(id),
      FOREIGN KEY (contact_id) REFERENCES contacts(id))`);

    // Messages (inbox / replies)
    db.run(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      send_id TEXT, campaign_id TEXT,
      from_email TEXT NOT NULL, from_name TEXT,
      subject TEXT, body TEXT,
      message_id TEXT,
      tag TEXT,
      replied INTEGER DEFAULT 0,
      status TEXT DEFAULT 'unread',
      is_auto_reply INTEGER DEFAULT 0,
      automation_status TEXT DEFAULT 'running',
      received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id))`);

    // Exclusions (email/domain blocklist)
    db.run(`CREATE TABLE IF NOT EXISTS exclusions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      value TEXT NOT NULL, type TEXT DEFAULT 'email',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id))`);

    // Unsubscribes
    db.run(`CREATE TABLE IF NOT EXISTS unsubscribes (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      campaign_id TEXT, email TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id))`);

    // Templates
    db.run(`CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      name TEXT NOT NULL, subject TEXT,
      body TEXT NOT NULL, category TEXT DEFAULT 'general',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id))`);

    // Support Tickets
    db.run(`CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      name TEXT, email TEXT, phone TEXT,
      subject TEXT NOT NULL, message TEXT NOT NULL,
      status TEXT DEFAULT 'open',
      admin_reply TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id))`);

    // Plans
    db.run(`CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      price_monthly REAL DEFAULT 0,
      max_contacts INTEGER DEFAULT 500,
      max_campaigns INTEGER DEFAULT 3,
      max_emails_per_day INTEGER DEFAULT 100,
      max_email_accounts INTEGER DEFAULT 1,
      features TEXT DEFAULT '[]',
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

    // Warmup logs
    db.run(`CREATE TABLE IF NOT EXISTS warmup_logs (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      partner_email TEXT,
      subject TEXT,
      status TEXT DEFAULT 'sent',
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (account_id) REFERENCES email_accounts(id))`);

    // AI usage logs
    db.run(`CREATE TABLE IF NOT EXISTS ai_usage_logs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      feature TEXT NOT NULL,
      credits_used INTEGER DEFAULT 1,
      model TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id))`);

    // Password reset tokens
    db.run(`CREATE TABLE IF NOT EXISTS reset_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      used INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

    // Team members (per client account)
    db.run(`CREATE TABLE IF NOT EXISTS team_members (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      name TEXT,
      email TEXT NOT NULL,
      password TEXT NOT NULL,
      permissions TEXT DEFAULT '{}',
      status TEXT DEFAULT 'active',
      must_change_password INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (owner_id) REFERENCES users(id))`);

    // Admin columns on users table
    db.run(`ALTER TABLE users ADD COLUMN is_super_admin INTEGER DEFAULT 0`, ()=>{});
    db.run(`ALTER TABLE users ADD COLUMN admin_permissions TEXT DEFAULT '{}'`, ()=>{});

    // Subscriptions
    db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
      plan_id TEXT NOT NULL, status TEXT DEFAULT 'active',
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME, amount_paid REAL DEFAULT 0,
      notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

    // Seed plans
    db.run(`INSERT OR IGNORE INTO plans (id,name,price_monthly,max_contacts,max_campaigns,max_emails_per_day,max_email_accounts,features)
      VALUES ('plan_trial','Trial',0,200,2,50,1,'["2 campaigns","200 contacts","50 emails/day","1 email account"]')`);
    db.run(`INSERT OR IGNORE INTO plans (id,name,price_monthly,max_contacts,max_campaigns,max_emails_per_day,max_email_accounts,features)
      VALUES ('plan_starter','Starter',29,2000,10,500,3,'["10 campaigns","2,000 contacts","500 emails/day","3 email accounts","Templates"]')`);
    db.run(`INSERT OR IGNORE INTO plans (id,name,price_monthly,max_contacts,max_campaigns,max_emails_per_day,max_email_accounts,features)
      VALUES ('plan_pro','Professional',79,10000,50,2000,6,'["50 campaigns","10,000 contacts","2,000 emails/day","6 email accounts","Priority support","API access"]')`);
    db.run(`INSERT OR IGNORE INTO plans (id,name,price_monthly,max_contacts,max_campaigns,max_emails_per_day,max_email_accounts,features)
      VALUES ('plan_unlimited','Unlimited',199,999999,999,10000,999,'["Unlimited everything","White-label","Dedicated support","API access","Sub-accounts"]')`);
  });
}

function runMigrations() {
  // All migrations are idempotent — safe to run every startup
  const migrations = [
    // Users table
    `ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'`,
    `ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'trial'`,
    `ALTER TABLE users ADD COLUMN plan_expires_at DATETIME`,
    `ALTER TABLE users ADD COLUMN is_suspended INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN suspension_reason TEXT`,
    `ALTER TABLE users ADD COLUMN last_login DATETIME`,
    `ALTER TABLE users ADD COLUMN api_key TEXT`,
    `ALTER TABLE users ADD COLUMN timezone TEXT DEFAULT 'UTC'`,
    `ALTER TABLE users ADD COLUMN notify_replies INTEGER DEFAULT 1`,
    `ALTER TABLE users ADD COLUMN can_spam_footer INTEGER DEFAULT 1`,
    `ALTER TABLE users ADD COLUMN company TEXT`,
    `ALTER TABLE users ADD COLUMN country TEXT`,
    // ── IMAP columns (the ones that kept breaking) ──
    `ALTER TABLE email_accounts ADD COLUMN imap_host TEXT DEFAULT ''`,
    `ALTER TABLE email_accounts ADD COLUMN imap_port INTEGER DEFAULT 993`,
    `ALTER TABLE email_accounts ADD COLUMN imap_secure INTEGER DEFAULT 1`,
    `ALTER TABLE email_accounts ADD COLUMN last_synced_at DATETIME`,
    // ── Messages columns ──
    `ALTER TABLE messages ADD COLUMN tag TEXT`,
    `ALTER TABLE messages ADD COLUMN replied INTEGER DEFAULT 0`,
    `ALTER TABLE messages ADD COLUMN message_id TEXT`,
    // ── Signature column ──
    `ALTER TABLE email_accounts ADD COLUMN signature TEXT DEFAULT ''`,
    // ── Inbox rotation columns ──
    `ALTER TABLE campaigns ADD COLUMN rotation_account_ids TEXT DEFAULT ''`,
    // ── Sending speed columns ──
    `ALTER TABLE email_accounts ADD COLUMN emails_per_hour INTEGER DEFAULT 10`,
    `ALTER TABLE email_accounts ADD COLUMN delay_min INTEGER DEFAULT 45`,
    `ALTER TABLE email_accounts ADD COLUMN delay_max INTEGER DEFAULT 120`,
    // ── Contact tags + extra fields ──
    `ALTER TABLE contacts ADD COLUMN tags TEXT DEFAULT '[]'`,
    `ALTER TABLE contacts ADD COLUMN linkedin TEXT DEFAULT ''`,
    `ALTER TABLE contacts ADD COLUMN value_prop TEXT DEFAULT ''`,
    `ALTER TABLE contacts ADD COLUMN city TEXT DEFAULT ''`,
    `ALTER TABLE contacts ADD COLUMN country TEXT DEFAULT ''`,
    // ── List rename support ──
    `ALTER TABLE lists ADD COLUMN description TEXT`,
    // ── Warmup columns ──
    `ALTER TABLE email_accounts ADD COLUMN warmup_start_count INTEGER DEFAULT 5`,
    `ALTER TABLE email_accounts ADD COLUMN warmup_increment INTEGER DEFAULT 5`,
    `ALTER TABLE email_accounts ADD COLUMN warmup_max_count INTEGER DEFAULT 50`,
    `ALTER TABLE email_accounts ADD COLUMN warmup_health INTEGER DEFAULT 0`,
    `ALTER TABLE email_accounts ADD COLUMN last_warmup_at DATETIME`,
    // ── Team member force-password-change ──
    `ALTER TABLE team_members ADD COLUMN must_change_password INTEGER DEFAULT 0`,
    // ── Message archive ──
    `ALTER TABLE messages ADD COLUMN archived INTEGER DEFAULT 0`,
    // ── Human-like sending schedule columns ──
    `ALTER TABLE email_accounts ADD COLUMN send_window_start INTEGER DEFAULT 8`,
    `ALTER TABLE email_accounts ADD COLUMN send_window_end INTEGER DEFAULT 17`,
    `ALTER TABLE email_accounts ADD COLUMN sending_preset TEXT DEFAULT 'moderate'`,
    `ALTER TABLE email_accounts ADD COLUMN warmup_window_start INTEGER DEFAULT 9`,
    `ALTER TABLE email_accounts ADD COLUMN warmup_window_end INTEGER DEFAULT 17`,
    // ── AI credits per plan (0 = not set, will get default seeded below) ──
    `ALTER TABLE plans ADD COLUMN max_ai_credits INTEGER DEFAULT 0`,
    // ── Warmup persona — used for AI-generated contextual warmup emails ──
    `ALTER TABLE email_accounts ADD COLUMN warmup_product TEXT DEFAULT ''`,
    `ALTER TABLE email_accounts ADD COLUMN warmup_company TEXT DEFAULT ''`,
    `ALTER TABLE email_accounts ADD COLUMN warmup_industry TEXT DEFAULT ''`,
    // ── Custom unsubscribe footer (shown when CAN-SPAM footer is off) ──
    `ALTER TABLE users ADD COLUMN custom_unsubscribe_text TEXT DEFAULT ''`,
  ];

  for (const sql of migrations) {
    // Silently ignore "duplicate column" errors — that just means it's already applied
    db.run(sql, [], (err) => {
      if (err && !err.message.includes('duplicate column')) {
        console.error('Migration error:', err.message, '|', sql);
      }
    });
  }

  // Seed default AI credit allowances for plans that haven't been configured yet
  // (max_ai_credits=0 means "not set by admin yet" — safe to apply the default)
  db.run(`UPDATE plans SET max_ai_credits=10   WHERE LOWER(name) LIKE '%trial%'     AND max_ai_credits=0`);
  db.run(`UPDATE plans SET max_ai_credits=100  WHERE LOWER(name) LIKE '%starter%'   AND max_ai_credits=0`);
  db.run(`UPDATE plans SET max_ai_credits=1000 WHERE LOWER(name) LIKE '%pro%'       AND max_ai_credits=0`);
  db.run(`UPDATE plans SET max_ai_credits=9999 WHERE LOWER(name) LIKE '%unlimited%' AND max_ai_credits=0`);

  // Promote first user to admin with unlimited plan
  db.get(`SELECT COUNT(*) as c FROM users WHERE role='admin'`, [], (err, row) => {
    if (!err && row && row.c === 0) {
      db.run(`UPDATE users SET role='admin', plan='unlimited' WHERE id=(SELECT id FROM users ORDER BY created_at ASC LIMIT 1)`);
      console.log('✅ First user promoted to admin with unlimited plan');
    } else {
      db.run(`UPDATE users SET plan='unlimited' WHERE role='admin'`);
    }
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
}
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
  });
}
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDb().run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

module.exports = { getDb, dbGet, dbAll, dbRun };
