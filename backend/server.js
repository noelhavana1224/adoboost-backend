require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { processPendingSends, resetDailyCounters } = require('./services/emailService');
const { syncAllInboxes } = require('./services/imapService');
const { processWarmup } = require('./services/warmupService');
const {
  emailAccountsRouter, contactsRouter, campaignsRouter, messagesRouter,
  exclusionsRouter, templatesRouter, ticketsRouter, analyticsRouter,
  trackingRouter, adminRouter, warmupRouter, teamRouter, adminTeamRouter,
  vaUpsellRouter, supportRouter, internalRouter, usageRouter
} = require('./routes/index');

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
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));

app.use('/api/auth',           require('./routes/auth'));
app.use('/api/email-accounts', emailAccountsRouter);
app.use('/api/smtp-test',      require('./routes/smtptest'));
app.use('/api/contacts',       contactsRouter);
app.use('/api/campaigns',      campaignsRouter);
app.use('/api/messages',       messagesRouter);
app.use('/api/exclusions',     exclusionsRouter);
app.use('/api/templates',      templatesRouter);
app.use('/api/tickets',        ticketsRouter);
app.use('/api/analytics',      analyticsRouter);
app.use('/api/tracking',       trackingRouter);
app.use('/api/admin',          adminRouter);
app.use('/api/warmup',         warmupRouter);
app.use('/api/team-members',   teamRouter);
app.use('/api/admin/team',     adminTeamRouter);
app.use('/api/admin/support',  supportRouter);
app.use('/api',                vaUpsellRouter);
app.use('/api/auth',           require('./routes/authSystem'));  // forgot/reset password
app.use('/api/usage',          usageRouter);
app.use('/api/internal',       internalRouter);

app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  app: 'AdoBoost',
  version: '1.0.0',
  timestamp: new Date().toISOString()
}));

// ── Cron: process outgoing emails every 2 min ──────────────────────────────
cron.schedule('*/2 * * * *', async () => {
  try { await processPendingSends(); }
  catch (e) { console.error('Send error:', e.message); }
});

// ── Cron: reset daily send counters at midnight ────────────────────────────
cron.schedule('0 0 * * *', async () => {
  try { await resetDailyCounters(); }
  catch (e) { console.error('Reset error:', e.message); }
});

// ── Cron: sync all IMAP inboxes every 5 min ───────────────────────────────
cron.schedule('*/5 * * * *', async () => {
  try { await syncAllInboxes(); }
  catch (e) { console.error('IMAP sync error:', e.message); }
});

// ── Cron: warmup pulse every 30 min ───────────────────────────────────────
// Sends ONE email per eligible account per run with 70% probability,
// creating a humanized non-robotic warmup pattern throughout the day.
cron.schedule('*/30 * * * *', async () => {
  try { await processWarmup(); }
  catch (e) { console.error('Warmup error:', e.message); }
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🚀 AdoBoost backend running on port ${PORT}`);
  require('./models/db').getDb();
  await resetDailyCounters();
});
