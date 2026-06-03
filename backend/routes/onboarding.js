/**
 * Onboarding — getting-started checklist status
 * Computes the user's progress toward their first launched campaign so the
 * dashboard can show a guided wizard. Team members share their owner's progress.
 */
const express = require('express');
const { dbGet } = require('../models/db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);
const uid = (req) => req.ownerId || req.userId;

router.get('/status', async (req, res) => {
  try {
    const id = uid(req);
    const count = async (sql) => (await dbGet(sql, [id]))?.n || 0;

    const accounts  = await count('SELECT COUNT(*) n FROM email_accounts WHERE user_id=?');
    const contacts  = await count('SELECT COUNT(*) n FROM contacts WHERE user_id=?');
    const campaigns = await count('SELECT COUNT(*) n FROM campaigns WHERE user_id=?');
    const launched  = await count("SELECT COUNT(*) n FROM campaigns WHERE user_id=? AND status IN ('active','sending','scheduled','completed','paused')");

    const dismissedRow = await dbGet('SELECT onboarding_dismissed FROM users WHERE id=?', [id]);
    const dismissed = (dismissedRow?.onboarding_dismissed === 1);

    const steps = [
      { key: 'inbox',    label: 'Connect your sending inbox', done: accounts > 0,  cta: 'Connect inbox',    link: '/email-accounts' },
      { key: 'contacts', label: 'Import your contacts',       done: contacts > 0,  cta: 'Add contacts',     link: '/contacts' },
      { key: 'campaign', label: 'Create your first campaign', done: campaigns > 0, cta: 'Create campaign',  link: '/campaigns/new' },
      { key: 'launch',   label: 'Launch it & start sending',  done: launched > 0,  cta: 'Launch campaign',  link: '/campaigns' },
    ];
    const doneCount = steps.filter(s => s.done).length;

    res.json({
      steps,
      doneCount,
      total: steps.length,
      completed: doneCount === steps.length,
      dismissed,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/dismiss', async (req, res) => {
  try {
    const { dbRun } = require('../models/db');
    await dbRun('UPDATE users SET onboarding_dismissed=1 WHERE id=?', [uid(req)]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
