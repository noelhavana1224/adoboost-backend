/**
 * In-app notification service
 * ─────────────────────────────────────────────────────────────────────────────
 * createNotification(userId, type, { title, body, link, icon, meta })
 *   - Respects the user's notification_prefs (JSON map type→bool). If a type is
 *     explicitly set to false, the notification is skipped. Missing/NULL = enabled.
 *   - Never throws to the caller (fire-and-forget); logs on failure.
 */
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbRun } = require('../models/db');

// Canonical notification types and their default-on state.
const NOTIF_TYPES = {
  list_request: { label: 'Lead-list request updates', default: true },
  infra_order:  { label: 'Infrastructure order updates', default: true },
  reply:        { label: 'New replies & hot leads', default: true },
  inbox_health: { label: 'Inbox & warmup health alerts', default: true },
  low_credit:   { label: 'Running low on credits', default: true },
  feature:      { label: 'Product updates & announcements', default: true },
  open:         { label: 'Email opens', default: false },
  click:        { label: 'Email link clicks', default: false },
};

function defaultPrefs() {
  const p = {};
  for (const k of Object.keys(NOTIF_TYPES)) p[k] = NOTIF_TYPES[k].default;
  return p;
}

function parsePrefs(raw) {
  const base = defaultPrefs();
  if (!raw) return base;
  try {
    const saved = JSON.parse(raw);
    return { ...base, ...saved };
  } catch { return base; }
}

async function isEnabled(userId, type) {
  try {
    const u = await dbGet('SELECT notification_prefs FROM users WHERE id=?', [userId]);
    const prefs = parsePrefs(u?.notification_prefs);
    return prefs[type] !== false;
  } catch { return true; }
}

async function createNotification(userId, type, { title, body = '', link = '', icon = '', meta = null } = {}) {
  try {
    if (!userId || !title) return null;
    if (!(await isEnabled(userId, type))) return null;
    const id = uuidv4();
    await dbRun(
      `INSERT INTO notifications (id,user_id,type,title,body,link,icon,meta,is_read)
       VALUES (?,?,?,?,?,?,?,?,0)`,
      [id, userId, type, title, body, link, icon, meta ? JSON.stringify(meta) : null]
    );
    return id;
  } catch (e) {
    console.error('[notify] createNotification failed:', e.message);
    return null;
  }
}

module.exports = { createNotification, NOTIF_TYPES, defaultPrefs, parsePrefs };
