/**
 * Secret encryption at rest (AES-256-GCM)
 * ─────────────────────────────────────────────────────────────────────────────
 * Encrypts SMTP / IMAP passwords so a database leak can't expose clients'
 * real email credentials.
 *
 * SAFETY-FIRST DESIGN (critical for a live system):
 *   • If SMTP_ENC_KEY is NOT set → enc() is a no-op (returns plaintext).
 *     This means deploying the code changes NOTHING until you set the key.
 *   • dec() NEVER throws. Given an encrypted value → decrypts. Given legacy
 *     plaintext (or anything it can't parse) → returns it unchanged.
 *   • Stored format:  enc:v1:<ivB64>:<tagB64>:<cipherB64>
 *
 * Rollout:
 *   1. Deploy this code (no behaviour change — key not set yet)
 *   2. Set SMTP_ENC_KEY (64 hex chars) in the server env
 *   3. New writes get encrypted automatically; old plaintext still readable
 *   4. POST /api/admin/security/encrypt-secrets → migrates existing rows
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PREFIX = 'enc:v1:';

// Persistent key file — lives in DATA_DIR (survives app redeploys, unlike the
// app-dir .env). This guarantees the key is never lost, which would make all
// encrypted passwords permanently unrecoverable.
const DATA_DIR = process.env.DATA_DIR || '/home/u346663333/adoboost-data';
const KEY_FILE = path.join(DATA_DIR, '.smtp_enc_key');

let _cachedRaw = null;
function getRawKey() {
  if (_cachedRaw) return _cachedRaw;
  // 1. Prefer env var
  if (process.env.SMTP_ENC_KEY) { _cachedRaw = process.env.SMTP_ENC_KEY.trim(); return _cachedRaw; }
  // 2. Fall back to persistent key file
  try {
    if (fs.existsSync(KEY_FILE)) {
      const v = fs.readFileSync(KEY_FILE, 'utf8').trim();
      if (v) { _cachedRaw = v; return _cachedRaw; }
    }
  } catch {}
  return null;
}

function getKey() {
  const raw = getRawKey();
  if (!raw) return null;
  // Accept 64-hex (32 bytes) or any string (hashed to 32 bytes)
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw).digest();
}

function isEncrypted(val) {
  return typeof val === 'string' && val.startsWith(PREFIX);
}

/** Encrypt a secret. No-op (returns input) if no key set or value is empty/already encrypted. */
function enc(plain) {
  try {
    if (plain == null || plain === '') return plain;
    if (isEncrypted(plain)) return plain;       // already encrypted
    const key = getKey();
    if (!key) return plain;                      // no key → store plaintext (no-op)
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
  } catch (e) {
    console.error('[crypto.enc] failed, storing plaintext:', e.message);
    return plain;
  }
}

/** Decrypt a secret. Returns plaintext unchanged if not encrypted or on any error. */
function dec(stored) {
  try {
    if (!isEncrypted(stored)) return stored;     // legacy plaintext → passthrough
    const key = getKey();
    if (!key) return stored;                      // can't decrypt without key
    const [, , ivB64, tagB64, ctB64] = stored.split(':');
    const iv  = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ct  = Buffer.from(ctB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) {
    console.error('[crypto.dec] failed, returning raw:', e.message);
    return stored;
  }
}

module.exports = { enc, dec, isEncrypted };
