const express = require('express');
const router = express.Router();
const net = require('net');
const nodemailer = require('nodemailer');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

// Deep SMTP diagnostic - tests multiple ports and configs
router.post('/full-test', async (req, res) => {
  const { host, username, password } = req.body;
  const results = { host, tests: [], recommendation: null };

  const CONFIGS = [
    { port: 587, secure: false, name: 'Port 587 (STARTTLS)' },
    { port: 465, secure: true,  name: 'Port 465 (SSL)' },
    { port: 25,  secure: false, name: 'Port 25 (Plain)' },
    { port: 2525,secure: false, name: 'Port 2525 (Alt)' },
  ];

  for (const cfg of CONFIGS) {
    const test = { ...cfg, tcpOk: false, smtpOk: false, error: null };

    try {
      await new Promise((resolve, reject) => {
        const sock = new net.Socket();
        sock.setTimeout(8000);
        sock.on('connect', () => { test.tcpOk = true; sock.destroy(); resolve(); });
        sock.on('timeout', () => { test.error = 'TCP timeout - port blocked'; sock.destroy(); reject(); });
        sock.on('error', e => { test.error = e.message; reject(e); });
        sock.connect(cfg.port, host);
      });
    } catch {}

    if (test.tcpOk && username && password) {
      try {
        const t = nodemailer.createTransport({
          host, port: cfg.port, secure: cfg.secure,
          auth: { user: username, pass: password },
          tls: { rejectUnauthorized: false },
          connectionTimeout: 10000,
          greetingTimeout: 10000,
        });
        await t.verify();
        test.smtpOk = true;
      } catch(e) {
        test.error = e.message;
      }
    }
    results.tests.push(test);
  }

  const working = results.tests.find(t => t.smtpOk);
  const tcpOnly = results.tests.find(t => t.tcpOk);

  if (working) {
    results.recommendation = { success: true, port: working.port, secure: working.secure,
      message: '✅ Use port ' + working.port + ' with SSL ' + (working.secure ? 'ON' : 'OFF') };
  } else if (tcpOnly) {
    results.recommendation = { success: false, port: tcpOnly.port,
      message: 'Port ' + tcpOnly.port + ' connects but auth failed — check username/password' };
  } else {
    results.recommendation = { success: false,
      message: 'All ports blocked. Please check your SMTP host settings or contact your email provider.' };
  }

  res.json(results);
});

// Send a real test email using the selected account + sequence step
router.post('/send-test', async (req, res) => {
  try {
    const { email_account_id, to_email, subject, body } = req.body;
    if (!email_account_id || !to_email || !subject || !body)
      return res.status(400).json({ error: 'Missing required fields' });

    const { dbGet } = require('../models/db');
    const { dec } = require('../utils/crypto');

    const account = await dbGet(
      'SELECT * FROM email_accounts WHERE id=? AND user_id=?',
      [email_account_id, req.userId]
    );
    if (!account) return res.status(404).json({ error: 'Email account not found' });

    const transporter = nodemailer.createTransport({
      host: account.host, port: account.port, secure: account.secure === 1,
      auth: { user: account.username, pass: dec(account.password) },
      tls: { rejectUnauthorized: false },
    });

    const cleanBody = body
      .replace(/<img[^>]*\/api\/tracking[^>]*>/gi, '')
      .replace(/href="[^"]*\/api\/tracking[^"]*url=([^"&]+)[^"]*"/g, (m, url) => 'href="' + decodeURIComponent(url) + '"');

    const fromName  = account.from_name  || account.username;
    const fromEmail = account.from_email || account.username;

    await transporter.sendMail({
      from: fromName + ' <' + fromEmail + '>',
      to: to_email,
      subject: '[TEST] ' + subject,
      html: cleanBody,
    });

    res.json({ success: true, message: 'Test email sent to ' + to_email });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
