const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbRun } = require('../models/db');
const { JWT_SECRET, authMiddleware } = require('../middleware/auth');
const { sendWelcomeEmail } = require('../services/emailSystem');
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
    sendWelcomeEmail(name, email).catch(() => {});
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

    // Check team_members table
    const member = await dbGet('SELECT * FROM team_members WHERE LOWER(email)=?', [email.toLowerCase().trim()]);
    if (member) {
      if (member.status === 'inactive') return res.status(403).json({ error: 'Your account has been deactivated. Contact your account owner.' });
      const valid = await bcrypt.compare(password, member.password);
      if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
      // Get owner info for plan
      const owner = await dbGet('SELECT plan FROM users WHERE id=?', [member.owner_id]);
      // Parse permissions
      let permissions = {};
      try { permissions = JSON.parse(member.permissions || '{}'); } catch {}
      const token = jwt.sign({ userId: member.id, isTeamMember: true, ownerId: member.owner_id }, JWT_SECRET, { expiresIn: '7d' });
      return res.json({
        token,
        user: {
          id: member.id,
          email: member.email,
          name: member.name,
          role: 'team_member',
          plan: owner?.plan || 'trial',
          permissions,
          owner_id: member.owner_id,
        }
      });
    }

    return res.status(401).json({ error: 'Invalid credentials' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/me', authMiddleware, async (req, res) => {
  try {
    // Try users table first
    let user = await dbGet('SELECT id,email,name,role,plan,plan_expires_at,timezone,notify_replies,can_spam_footer,company,country,city,api_key,created_at,last_login FROM users WHERE id=?', [req.userId]);
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
      });
    }
    res.status(404).json({ error: 'User not found' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/settings', authMiddleware, async (req, res) => {
  try {
    const { name, company, country, city, address, zip, timezone, notify_replies, can_spam_footer, password } = req.body;
    if (password) {
      const hashed = await bcrypt.hash(password, 10);
      await dbRun('UPDATE users SET password=? WHERE id=?', [hashed, req.userId]);
    }
    await dbRun('UPDATE users SET name=?,company=?,country=?,city=?,address=?,zip=?,timezone=?,notify_replies=?,can_spam_footer=? WHERE id=?',
      [name, company, country, city, address, zip, timezone, notify_replies ? 1 : 0, can_spam_footer ? 1 : 0, req.userId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
