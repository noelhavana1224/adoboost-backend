/**
 * Contact Email Verification (bounce protection)
 * ─────────────────────────────────────────────────────────────────────────────
 * Validates contact emails BEFORE sending so bounces (the #1 sender-reputation
 * killer) are caught early. Safe, non-intrusive checks only — no SMTP mailbox
 * probing (that hurts your own IP reputation and is unreliable with catch-alls).
 *
 * Status per contact:
 *   valid   → good format + domain has a mail server (MX/A)
 *   risky   → deliverable domain but disposable or role-based (info@, sales@…)
 *   invalid → bad format or domain cannot receive email (no MX/A record)
 *
 * Results are cached per-domain within a run, and persisted on the contact.
 */
const dns = require('dns').promises;
const { dbAll, dbGet, dbRun } = require('../models/db');

const DISPOSABLE = new Set([
  'mailinator.com','guerrillamail.com','10minutemail.com','tempmail.com','temp-mail.org',
  'throwawaymail.com','yopmail.com','getnada.com','trashmail.com','sharklasers.com',
  'guerrillamailblock.com','dispostable.com','maildrop.cc','fakeinbox.com','mailnesia.com',
  'tempinbox.com','mintemail.com','mohmal.com','emailondeck.com','spamgourmet.com',
  'mailcatch.com','tempr.email','moakt.com','luxusmail.org','inboxbear.com','emailfake.com',
]);

const ROLE_PREFIXES = new Set([
  'info','support','admin','sales','contact','hello','team','billing','noreply','no-reply',
  'postmaster','webmaster','abuse','office','mail','marketing','hr','jobs','careers','help',
  'service','enquiries','enquiry','accounts','accounting','notifications','donotreply',
]);

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);
}

async function domainHasMail(domain) {
  try {
    const mx = await withTimeout(dns.resolveMx(domain), 6000);
    if (mx && mx.length) return true;
  } catch {}
  // Fallback: some domains accept mail on the A record even without MX
  try {
    const a = await withTimeout(dns.resolve4(domain), 5000);
    if (a && a.length) return true;
  } catch {}
  return false;
}

// Verify a single email. mxCache: Map<domain, boolean>
async function verifyEmail(email, mxCache = new Map()) {
  const e = (email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return { status: 'invalid', reason: 'Invalid email format' };
  const [local, domain] = e.split('@');
  if (DISPOSABLE.has(domain)) return { status: 'risky', reason: 'Disposable / throwaway domain' };

  let hasMail = mxCache.get(domain);
  if (hasMail === undefined) { hasMail = await domainHasMail(domain); mxCache.set(domain, hasMail); }
  if (!hasMail) return { status: 'invalid', reason: 'Domain has no mail server (MX)' };

  if (ROLE_PREFIXES.has(local)) return { status: 'risky', reason: 'Role-based address (e.g. info@, sales@)' };
  return { status: 'valid', reason: 'Deliverable' };
}

// ── Background jobs (in-memory) ─────────────────────────────────────────────
const jobs = {};

function newJob(total) {
  const id = require('crypto').randomBytes(8).toString('hex');
  jobs[id] = { status: 'running', total, done: 0, valid: 0, risky: 0, invalid: 0, startedAt: Date.now() };
  return id;
}
function getJob(id) { return jobs[id] || null; }

// Verify all contacts in a list (or all of a user's contacts if listId is null)
async function verifyContacts(userId, listId, jobId) {
  const mxCache = new Map();
  const where = listId ? 'user_id=? AND list_id=?' : 'user_id=?';
  const params = listId ? [userId, listId] : [userId];
  const contacts = await dbAll(`SELECT id, email FROM contacts WHERE ${where}`, params);
  const job = jobs[jobId];
  if (job) job.total = contacts.length;

  const BATCH = 10;
  for (let i = 0; i < contacts.length; i += BATCH) {
    const slice = contacts.slice(i, i + BATCH);
    await Promise.all(slice.map(async (c) => {
      const { status, reason } = await verifyEmail(c.email, mxCache);
      await dbRun(
        'UPDATE contacts SET email_status=?, email_check_reason=?, email_checked_at=? WHERE id=?',
        [status, reason, new Date().toISOString(), c.id]
      );
      if (job) { job.done++; job[status] = (job[status] || 0) + 1; }
    }));
  }
  if (job) { job.status = 'done'; job.finishedAt = Date.now(); }
  return job;
}

function startVerifyJob(userId, listId) {
  const jobId = newJob(0);
  // run in background — caller polls status
  verifyContacts(userId, listId, jobId).catch(e => {
    if (jobs[jobId]) { jobs[jobId].status = 'error'; jobs[jobId].error = e.message; }
  });
  return jobId;
}

module.exports = { verifyEmail, verifyContacts, startVerifyJob, getJob };
