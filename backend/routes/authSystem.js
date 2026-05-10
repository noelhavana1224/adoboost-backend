const express = require('express');
const router  = express.Router();
const { dbGet, dbRun } = require('../models/db');
const { v4: uuidv4 }   = require('uuid');
const crypto           = require('crypto');
const bcrypt           = require('bcryptjs');
const { sendResetEmail } = require('../services/emailSystem');

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const user = await dbGet('SELECT * FROM users WHERE LOWER(email)=?', [email.toLowerCase()]);
    // Always return success — prevents email enumeration attacks
    if (!user) return res.json({ success: true });
    // Generate secure token
    const token   = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
    await dbRun('INSERT INTO reset_tokens (id,user_id,token,expires_at) VALUES (?,?,?,?)',
      [uuidv4(), user.id, token, expires]);
    await sendResetEmail(user.name || user.email, user.email, token);
    res.json({ success: true });
  } catch(e) {
    console.error('Forgot password error:', e.message);
    res.status(500).json({ error: 'Failed to send reset email. Please try again.' });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const resetToken = await dbGet(
      'SELECT * FROM reset_tokens WHERE token=? AND used=0 AND expires_at>?',
      [token, new Date().toISOString()]
    );
    if (!resetToken) return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
    const hashed = await bcrypt.hash(password, 10);
    await dbRun('UPDATE users SET password=? WHERE id=?', [hashed, resetToken.user_id]);
    await dbRun('UPDATE reset_tokens SET used=1 WHERE id=?', [resetToken.id]);
    res.json({ success: true, message: 'Password reset successfully! You can now log in.' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/auth/verify-reset-token?token=xxx
router.get('/verify-reset-token', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ valid: false });
    const resetToken = await dbGet(
      'SELECT * FROM reset_tokens WHERE token=? AND used=0 AND expires_at>?',
      [token, new Date().toISOString()]
    );
    res.json({ valid: !!resetToken });
  } catch(e) {
    res.status(500).json({ valid: false });
  }
});

module.exports = router;
