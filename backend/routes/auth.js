const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../models/db');
const { JWT_SECRET, authMiddleware } = require('../middleware/auth');
const { sendWelcomeEmail, sendNewUserAlert, sendVerificationEmail } = require('../services/emailSystem');
const router = express.Router();

// ── Anti-abuse: block disposable / throwaway email providers on signup ──────
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com','guerrillamail.com','10minutemail.com','tempmail.com','temp-mail.org',
  'throwawaymail.com','yopmail.com','getnada.com','trashmail.com','sharklasers.com',
  'guerrillamailblock.com','dispostable.com','maildrop.cc','fakeinbox.com','mailnesia.com',
  'tempinbox.com','mintemail.com','mohmal.com','emailondeck.com','spamgourmet.com',
  'mailcatch.com','tempr.email','moakt.com','luxusmail.org','inboxbear.com','emailfake.com',
]);
function isDisposableEmail(email) {
  const domain = (email.split('@')[1] || '').toLowerCase().trim();
  return DISPOSABLE_DOMAINS.has(domain);
}

router.post('/register', async (req, res) => {
  try {
    // New double-opt-in flow: sign up with name + email only. The user sets
    // their password when they click the verification link. No dashboard access
    // until verified.
    const { name, email, password } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });
    const cleanEmail = email.toLowerCase().trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) return res.status(400).json({ error: 'Please enter a valid email address' });
    if (isDisposableEmail(cleanEmail)) return res.status(400).json({ error: 'Disposable email addresses are not allowed. Please use a real work email.' });
    const existing = await dbGet('SELECT id, email_verified FROM users WHERE LOWER(email)=?', [cleanEmail]);
    if (existing) {
      // If they signed up but never verified, resend instead of erroring
      if (existing.email_verified === 0) {
        const newToken = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
        await dbRun('UPDATE users SET verification_token=?, verification_sent_at=? WHERE id=?', [newToken, new Date().toISOString(), existing.id]);
        sendVerificationEmail(name, cleanEmail, newToken).catch(() => {});
        return res.json({ pending: true, email: cleanEmail, message: 'We re-sent your verification email.' });
      }
      return res.status(409).json({ error: 'Email already registered. Please sign in.' });
    }

    const id = uuidv4();
    const apiKey = 'ab_' + uuidv4().replace(/-/g, '');
    const userCount = (await dbGet('SELECT COUNT(*) as c FROM users', [])).c;
    const planExpiry = new Date();
    planExpiry.setFullYear(planExpiry.getFullYear() + 10);

    // First user ever = admin bootstrap (auto-verified, password required immediately)
    if (userCount === 0) {
      if (!password || password.length < 6) return res.status(400).json({ error: 'Set a password (min 6 chars) for the admin account' });
      const hashed = await bcrypt.hash(password, 10);
      await dbRun('INSERT INTO users (id,email,password,name,role,plan,plan_expires_at,api_key,email_verified) VALUES (?,?,?,?,?,?,?,?,1)',
        [id, cleanEmail, hashed, name, 'admin', 'unlimited', planExpiry.toISOString(), apiKey]);
      const token = jwt.sign({ userId: id }, JWT_SECRET, { expiresIn: '7d' });
      return res.json({ token, user: { id, email: cleanEmail, name, role: 'admin', plan: 'unlimited', email_verified: 1 } });
    }

    // Public signup — unverified, password set at verification time
    const placeholder = await bcrypt.hash(uuidv4(), 10); // unusable until they set a real one
    const verifyToken = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
    await dbRun('INSERT INTO users (id,email,password,name,role,plan,plan_expires_at,api_key,email_verified,verification_token,verification_sent_at) VALUES (?,?,?,?,?,?,?,?,0,?,?)',
      [id, cleanEmail, placeholder, name, 'user', 'trial', planExpiry.toISOString(), apiKey, verifyToken, new Date().toISOString()]);
    const totalUsers = (await dbGet('SELECT COUNT(*) as c FROM users', [])).c;
    sendVerificationEmail(name, cleanEmail, verifyToken).catch(() => {});
    sendNewUserAlert(name, cleanEmail, 'trial', totalUsers).catch(() => {});
    // No token returned → cannot enter the dashboard until verified
    res.json({ pending: true, email: cleanEmail, message: 'Check your email to verify your address and set your password.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password: rawPassword } = req.body;
    const password = (rawPassword || '').trim(); // trim whitespace from copy-paste

    // Check main users table first
    let user = await dbGet('SELECT * FROM users WHERE LOWER(email)=?', [email.toLowerCase().trim()]);

    if (user) {
      // Regular user login
      if (user.is_suspended) return res.status(403).json({ error: 'Account suspended. Contact support.' });
      // Block dashboard access until email is verified (password is set at verification)
      if (user.email_verified === 0) {
        return res.status(403).json({ error: 'Please verify your email first. Check your inbox for the verification link to set your password and activate your account.', email_unverified: true, email: user.email });
      }
      const valid = await bcrypt.compare(password, user.password);
      if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
      await dbRun('UPDATE users SET last_login=? WHERE id=?', [new Date().toISOString(), user.id]);
      const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
      return res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role, plan: user.plan, email_verified: user.email_verified ?? 1 } });
    }

    // Check team_members table — fetch ALL rows with this email (same person can be on multiple accounts)
    // Try each one and use the first whose password hash matches.
    const members = await dbAll('SELECT * FROM team_members WHERE LOWER(email)=?', [email.toLowerCase().trim()]);
    if (members.length > 0) {
      let matched = null;
      for (const m of members) {
        if (m.status === 'inactive') continue; // skip deactivated
        const valid = await bcrypt.compare(password, m.password);
        if (valid) { matched = m; break; }
      }
      if (!matched) {
        const anyActive = members.some(m => m.status !== 'inactive');
        if (!anyActive) return res.status(403).json({ error: 'Your account has been deactivated. Contact your account owner.' });
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      // Get owner info for plan
      const owner = await dbGet('SELECT plan FROM users WHERE id=?', [matched.owner_id]);
      // Parse permissions
      let permissions = {};
      try { permissions = JSON.parse(matched.permissions || '{}'); } catch {}
      const mustChangePassword = matched.must_change_password === 1;
      const token = jwt.sign({ userId: matched.id, isTeamMember: true, ownerId: matched.owner_id }, JWT_SECRET, { expiresIn: '7d' });
      return res.json({
        token,
        mustChangePassword,
        user: {
          id: matched.id,
          email: matched.email,
          name: matched.name,
          role: 'team_member',
          plan: owner?.plan || 'trial',
          permissions,
          owner_id: matched.owner_id,
          mustChangePassword,
        }
      });
    }

    return res.status(401).json({ error: 'Invalid credentials' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Check a verification token is valid (verify page loads it first) ────────
router.get('/verify-token', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.json({ valid: false });
    const user = await dbGet('SELECT email, name FROM users WHERE verification_token=?', [token]);
    if (!user) return res.json({ valid: false });
    res.json({ valid: true, email: user.email, name: user.name });
  } catch { res.json({ valid: false }); }
});

// ── Verify email + set password (from the link), then auto-login ────────────
router.post('/verify-email', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token) return res.status(400).json({ error: 'Missing token' });
    const user = await dbGet('SELECT id, name, email, role, plan, email_verified FROM users WHERE verification_token=?', [token]);
    if (!user) return res.status(400).json({ error: 'Invalid or expired verification link' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'Please set a password (at least 6 characters)' });

    const hashed = await bcrypt.hash(password, 10);
    await dbRun('UPDATE users SET email_verified=1, verification_token=NULL, password=?, last_login=? WHERE id=?',
      [hashed, new Date().toISOString(), user.id]);
    // Welcome email now that they're fully set up
    sendWelcomeEmail(user.name, user.email).catch(() => {});
    // Auto-login
    const jwtToken = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      success: true,
      token: jwtToken,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, plan: user.plan, email_verified: 1 },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Resend verification email (public — by email, anti-enumeration) ─────────
router.post('/resend-verification', async (req, res) => {
  try {
    const email = (req.body.email || '').toLowerCase().trim();
    if (!email) return res.status(400).json({ error: 'Email required' });
    const user = await dbGet('SELECT id, name, email, email_verified, verification_sent_at FROM users WHERE LOWER(email)=?', [email]);
    // Always respond OK to avoid leaking which emails exist
    if (!user || user.email_verified) return res.json({ success: true });
    // Throttle: at most once per 60s
    if (user.verification_sent_at && Date.now() - new Date(user.verification_sent_at).getTime() < 60000) {
      return res.json({ success: true });
    }
    const verifyToken = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
    await dbRun('UPDATE users SET verification_token=?, verification_sent_at=? WHERE id=?', [verifyToken, new Date().toISOString(), user.id]);
    sendVerificationEmail(user.name, user.email, verifyToken).catch(() => {});
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/me', authMiddleware, async (req, res) => {
  try {
    // Try users table first
    let user = await dbGet('SELECT id,email,name,role,plan,plan_expires_at,email_verified,timezone,notify_replies,can_spam_footer,custom_unsubscribe_text,company,country,city,api_key,created_at,last_login FROM users WHERE id=?', [req.userId]);
    if (user) return res.json(user);
    // Try team_members table
    const member = await dbGet('SELECT * FROM team_members WHERE id=?', [req.userId]);
    if (member) {
      const owner = await dbGet('SELECT plan FROM users WHERE id=?', [member.owner_id]);
      let permissions = {};
      try { permissions = JSON.parse(member.permissions || '{}'); } catch {}
      return res.json({
        id: member.id, email: member.email, name: member.name,
        role: 'team_member', plan: owner?.plan || 'trial',
        permissions, owner_id: member.owner_id,
        mustChangePassword: member.must_change_password === 1,
      });
    }
    res.status(404).json({ error: 'User not found' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/settings', authMiddleware, async (req, res) => {
  try {
    const { name, company, country, city, address, zip, timezone, notify_replies, can_spam_footer, custom_unsubscribe_text, notify_email, password } = req.body;
    if (password) {
      const hashed = await bcrypt.hash(password, 10);
      await dbRun('UPDATE users SET password=? WHERE id=?', [hashed, req.userId]);
    }
    // Use COALESCE so fields not sent by the caller (e.g. UserPreferences only sends
    // notify_replies/can_spam_footer) don't overwrite existing values with NULL,
    // which would break the NOT NULL constraint on name.
    await dbRun(`UPDATE users SET
      name=COALESCE(?,name),
      company=COALESCE(?,company),
      country=COALESCE(?,country),
      city=COALESCE(?,city),
      address=COALESCE(?,address),
      zip=COALESCE(?,zip),
      timezone=COALESCE(?,timezone),
      notify_replies=?,
      can_spam_footer=?,
      custom_unsubscribe_text=?,
      notify_email=COALESCE(?,notify_email)
      WHERE id=?`,
      [name||null, company||null, country||null, city||null, address||null, zip||null, timezone||null,
       notify_replies ? 1 : 0, can_spam_footer ? 1 : 0, custom_unsubscribe_text ?? '',
       notify_email||null, req.userId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
