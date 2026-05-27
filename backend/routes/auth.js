const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../models/db');
const { JWT_SECRET, authMiddleware } = require('../middleware/auth');
const { sendWelcomeEmail, sendNewUserAlert } = require('../services/emailSystem');
const router = express.Router();

router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });
    const existing = await dbGet('SELECT id FROM users WHERE email=?', [email]);
    if (existing) return res.status(409).json({ error: 'Email already registered' });
    const hashed = await bcrypt.hash(password, 10);
    const id = uuidv4();
    const apiKey = 'ab_' + uuidv4().replace(/-/g, '');
    const userCount = (await dbGet('SELECT COUNT(*) as c FROM users', [])).c;
    const role = userCount === 0 ? 'admin' : 'user';
    const plan = userCount === 0 ? 'unlimited' : 'trial';
    const planExpiry = new Date();
    planExpiry.setFullYear(planExpiry.getFullYear() + 10); // 10 years for admin
    await dbRun('INSERT INTO users (id,email,password,name,role,plan,plan_expires_at,api_key) VALUES (?,?,?,?,?,?,?,?)',
      [id, email, hashed, name, role, plan, planExpiry.toISOString(), apiKey]);
    const token = jwt.sign({ userId: id }, JWT_SECRET, { expiresIn: '7d' });
    const totalUsers = (await dbGet('SELECT COUNT(*) as c FROM users', [])).c;
    sendWelcomeEmail(name, email).catch(() => {});
    sendNewUserAlert(name, email, plan, totalUsers).catch(() => {});
    res.json({ token, user: { id, email, name, role, plan: 'trial' } });
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
      const valid = await bcrypt.compare(password, user.password);
      if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
      await dbRun('UPDATE users SET last_login=? WHERE id=?', [new Date().toISOString(), user.id]);
      const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
      return res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role, plan: user.plan } });
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

router.get('/me', authMiddleware, async (req, res) => {
  try {
    // Try users table first
    let user = await dbGet('SELECT id,email,name,role,plan,plan_expires_at,timezone,notify_replies,can_spam_footer,custom_unsubscribe_text,company,country,city,api_key,created_at,last_login FROM users WHERE id=?', [req.userId]);
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
