// ── Crash guards — MUST be first ─────────────────────────────────────────
// Keeps the Passenger process alive even if an unhandled error slips through.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message, err.stack);
  // Do NOT call process.exit() — let Passenger manage the process lifecycle.
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

// ── Load routers with isolation — one bad module won't take down the rest ─
let emailAccountsRouter, contactsRouter, campaignsRouter, messagesRouter,
    exclusionsRouter, templatesRouter, ticketsRouter, analyticsRouter,
    trackingRouter, adminRouter, warmupRouter, teamRouter, adminTeamRouter,
    vaUpsellRouter, supportRouter, internalRouter, usageRouter;

try {
  ({
    emailAccountsRouter, contactsRouter, campaignsRouter, messagesRouter,
    exclusionsRouter, templatesRouter, ticketsRouter, analyticsRouter,
    trackingRouter, adminRouter, warmupRouter, teamRouter, adminTeamRouter,
    vaUpsellRouter, supportRouter, internalRouter, usageRouter,
  } = require('./routes/index'));
} catch (e) {
  console.error('[startup] Failed to load routes/index.js:', e.message);
}

const app = express();
const PORT = process.env.PORT || 3001;

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:5173',
  'http://localhost:4173',
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.some(o => origin.startsWith(o))) return cb(null, true);
    cb(new Error('CORS not allowed'));
  },
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));

// ── Health check — FIRST, always responds regardless of DB / route state ──
app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  app: 'AdoBoost',
  version: '1.0.0',
  timestamp: new Date().toISOString(),
}));

// ── Mount routes (each wrapped so one failure won't block the others) ──────
const mount = (path, router, label) => {
  if (!router) { console.warn(`[startup] Skipping ${label} — router not loaded`); return; }
  try { app.use(path, router); }
  catch (e) { console.error(`[startup] Failed to mount ${label}:`, e.message); }
};

// Auth routes
try { app.use('/api/auth', require('./routes/auth')); } catch (e) { console.error('[startup] auth:', e.message); }
try { app.use('/api/smtp-test', require('./routes/smtptest')); } catch (e) { console.error('[startup] smtptest:', e.message); }
try { app.use('/api/auth', require('./routes/authSystem')); } catch (e) { console.error('[startup] authSystem:', e.message); }
try { app.use('/api/ai', require('./routes/ai')); } catch (e) { console.error('[startup] ai routes:', e.message); }

mount('/api/email-accounts', emailAccountsRouter,  'emailAccountsRouter');
mount('/api/contacts',       contactsRouter,        'contactsRouter');
mount('/api/campaigns',      campaignsRouter,       'campaignsRouter');
mount('/api/messages',       messagesRouter,        'messagesRouter');
mount('/api/exclusions',     exclusionsRouter,      'exclusionsRouter');
mount('/api/templates',      templatesRouter,       'templatesRouter');
mount('/api/tickets',        ticketsRouter,         'ticketsRouter');
mount('/api/analytics',      analyticsRouter,       'analyticsRouter');
mount('/api/tracking',       trackingRouter,        'trackingRouter');
mount('/api/admin',          adminRouter,           'adminRouter');
mount('/api/warmup',         warmupRouter,          'warmupRouter');
mount('/api/team-members',   teamRouter,            'teamRouter');
mount('/api/admin/team',     adminTeamRouter,       'adminTeamRouter');
mount('/api/admin/support',  supportRouter,         'supportRouter');
mount('/api',                vaUpsellRouter,        'vaUpsellRouter');
mount('/api/usage',          usageRouter,           'usageRouter');
mount('/api/internal',       internalRouter,        'internalRouter');

// ── Global error handler — catches any unhandled error in a route ──────────
// Returns JSON instead of crashing (Passenger would restart on crash anyway,
// but this keeps the current request clean).
app.use((err, req, res, _next) => {
  console.error('[route error]', err.message, err.stack);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

// ── Cron jobs ──────────────────────────────────────────────────────────────
const safeRequire = (mod) => { try { return require(mod); } catch (e) { console.error('[cron] Failed to load', mod, e.message); return null; } };

// ── Internal watchdog — restarts Passenger if health endpoint fails ─────────
// This is a *second* safety net on top of the external cron / UptimeRobot.
// It only helps with soft hangs (process alive but unresponsive). Hard crashes
// are caught by Passenger itself and the external monitor.
const http  = require('http');
const https = require('https');
const path  = require('path');
const fs    = require('fs');
let _watchdogFails = 0;
const RESTART_TXT = path.join(__dirname, '..', 'tmp', 'restart.txt');

function selfPing() {
  const url = process.env.HEALTH_URL || `http://localhost:${process.env.PORT || 3001}/api/health`;
  const lib  = url.startsWith('https') ? https : http;
  const req  = lib.get(url, { timeout: 8000 }, (res) => {
    if (res.statusCode === 200) {
      _watchdogFails = 0; // reset on success
    } else {
      handleWatchdogFail(`status ${res.statusCode}`);
    }
    res.resume();
  });
  req.on('error',   (e) => handleWatchdogFail(e.message));
  req.on('timeout', ()  => { req.destroy(); handleWatchdogFail('timeout'); });
}

function handleWatchdogFail(reason) {
  _watchdogFails++;
  console.error(`[watchdog] Ping failed (${_watchdogFails}/3): ${reason}`);
  if (_watchdogFails >= 3) {
    console.error('[watchdog] 3 consecutive failures — triggering Passenger restart');
    _watchdogFails = 0;
    try {
      fs.mkdirSync(path.dirname(RESTART_TXT), { recursive: true });
      fs.utimesSync(RESTART_TXT, new Date(), new Date());
    } catch (touchErr) {
      try { fs.writeFileSync(RESTART_TXT, ''); } catch (_) {}
    }
  }
}

// Ping every 2 minutes; restart only after 3 consecutive failures (6 min total)
setInterval(selfPing, 2 * 60 * 1000);

const emailService  = safeRequire('./services/emailService');
const imapService   = safeRequire('./services/imapService');
const warmupService = safeRequire('./services/warmupService');

if (emailService) {
  cron.schedule('*/2 * * * *', async () => {
    try { await emailService.processPendingSends(); }
    catch (e) { console.error('Send error:', e.message); }
  });
  cron.schedule('0 0 * * *', async () => {
    try { await emailService.resetDailyCounters(); }
    catch (e) { console.error('Reset error:', e.message); }
  });
}

if (imapService) {
  cron.schedule('*/5 * * * *', async () => {
    try { await imapService.syncAllInboxes(); }
    catch (e) { console.error('IMAP sync error:', e.message); }
  });
}

if (warmupService) {
  cron.schedule('*/30 * * * *', async () => {
    try { await warmupService.processWarmup(); }
    catch (e) { console.error('Warmup error:', e.message); }
  });
}

// ── Nightly cleanup — purge soft-deleted messages older than 30 days ────────
// Soft-deleted rows (deleted=1) are kept for 30 days so the IMAP sync
// message_id dedup prevents re-importing them. After 30 days the IMAP
// sync window can never reach that far back, so the rows are safe to purge.
// Runs at 2:00 AM every night (low-traffic window).
cron.schedule('0 2 * * *', async () => {
  try {
    const { dbRun, dbGet } = require('./models/db');
    const before = await dbGet(`SELECT COUNT(*) as c FROM messages WHERE deleted=1 AND received_at < datetime('now','-30 days')`);
    const result = await dbRun(`DELETE FROM messages WHERE deleted=1 AND received_at < datetime('now','-30 days')`);
    if (result.changes > 0) {
      console.log(`🧹 Nightly cleanup: purged ${result.changes} soft-deleted message(s) older than 30 days`);
    }
  } catch (e) { console.error('Cleanup error:', e.message); }
});

// ── Start server ───────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🚀 AdoBoost backend running on port ${PORT}`);
  try { require('./models/db').getDb(); } catch (e) { console.error('[startup] DB init error:', e.message); }
  if (emailService) {
    try { await emailService.resetDailyCounters(); } catch (e) { console.error('[startup] resetDailyCounters:', e.message); }
  }
});
