/**
 * Persistent secrets loader
 * ─────────────────────────────────────────────────────────────────────────────
 * The app-directory .env is NOT reliable on this host (Hostinger panel actions
 * have wiped it), which silently reverted JWT_SECRET to a weak default. This
 * loads critical secrets from the PERSISTENT data dir (same place as the DB,
 * which survives redeploys) and force-sets them into process.env BEFORE any
 * route/middleware captures them.
 *
 * If a secret file doesn't exist yet, a strong one is generated and saved.
 * We deliberately ignore any panel-injected value so a weak/leftover env var
 * can never win.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || '/home/u346663333/adoboost-data';

function ensure(fileName, envName, generate) {
  const file = path.join(DATA_DIR, fileName);
  let val = null;
  try { if (fs.existsSync(file)) val = fs.readFileSync(file, 'utf8').trim(); } catch {}
  if (!val) {
    val = generate();
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(file, val, { mode: 0o600 });
      console.log(`🔐 Generated and persisted ${envName} → ${file}`);
    } catch (e) { console.error(`[loadSecrets] could not write ${file}:`, e.message); }
  }
  process.env[envName] = val; // force-set (overrides any weak panel value)
}

module.exports = function loadSecrets() {
  ensure('.jwt_secret',   'JWT_SECRET',   () => crypto.randomBytes(48).toString('hex'));
  ensure('.smtp_enc_key', 'SMTP_ENC_KEY', () => crypto.randomBytes(32).toString('hex'));
};
