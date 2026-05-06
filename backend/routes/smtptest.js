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
    
    // TCP test
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

    // SMTP auth test (only if TCP works)
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

  // Find best working config
  const working = results.tests.find(t => t.smtpOk);
  const tcpOnly = results.tests.find(t => t.tcpOk);
  
  if (working) {
    results.recommendation = {
      success: true,
      port: working.port,
      secure: working.secure,
      message: `✅ Use port ${working.port} with SSL ${working.secure ? 'ON' : 'OFF'}`,
    };
  } else if (tcpOnly) {
    results.recommendation = {
      success: false,
      port: tcpOnly.port,
      message: `Port ${tcpOnly.port} connects but auth failed — check username/password`,
    };
  } else {
    results.recommendation = {
      success: false,
      message: 'All ports blocked. Please check your SMTP host settings or contact your email provider.',
    };
  }

  res.json(results);
});

module.exports = router;
