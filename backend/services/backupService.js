/**
 * Automated Database Backup Service
 * ─────────────────────────────────────────────────────────────────────────────
 * Uses SQLite's `VACUUM INTO` — the only safe way to copy a live WAL-mode DB.
 * It produces a transactionally-consistent snapshot even while the app is
 * actively reading/writing (no torn pages, no lock contention).
 *
 * Strategy:
 *   • Nightly snapshot → /adoboost-data/backups/adoboost-YYYY-MM-DD_HHmm.db
 *   • Keep the last KEEP_DAILY snapshots, prune older ones
 *   • Checkpoint the WAL first so the snapshot is compact & current
 *
 * Restore (manual): stop app → copy a backup over adoboost.db → delete -wal/-shm
 * → start app.
 */

const fs   = require('fs');
const path = require('path');
const { getDb, dbRun } = require('../models/db');

const DATA_DIR   = process.env.DATA_DIR || '/home/u346663333/adoboost-data';
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP_DAILY = parseInt(process.env.BACKUP_KEEP || '14', 10); // keep last 14

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function runBackup() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

    // 1. Checkpoint WAL so the snapshot is fully up to date and compact
    try { await dbRun('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {
      console.warn('[backup] WAL checkpoint warning:', e.message);
    }

    // 2. Consistent snapshot via VACUUM INTO
    const dest = path.join(BACKUP_DIR, `adoboost-${ts()}.db`);
    await dbRun(`VACUUM INTO ?`, [dest]);

    const sizeMB = (fs.statSync(dest).size / 1024 / 1024).toFixed(2);
    console.log(`💾 Backup created: ${path.basename(dest)} (${sizeMB} MB)`);

    // 3. Rotate — keep only the newest KEEP_DAILY backups
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('adoboost-') && f.endsWith('.db'))
      .map(f => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);

    const toDelete = files.slice(KEEP_DAILY);
    for (const { f } of toDelete) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch {}
    }
    if (toDelete.length) console.log(`🧹 Backup rotation: removed ${toDelete.length} old backup(s)`);

    return { success: true, file: path.basename(dest), sizeMB, kept: Math.min(files.length, KEEP_DAILY) };
  } catch (e) {
    console.error('[backup] FAILED:', e.message);
    return { success: false, error: e.message };
  }
}

function listBackups() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('adoboost-') && f.endsWith('.db'))
      .map(f => {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return { file: f, sizeMB: (st.size / 1024 / 1024).toFixed(2), created: st.mtime.toISOString() };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));
  } catch { return []; }
}

module.exports = { runBackup, listBackups, BACKUP_DIR };
