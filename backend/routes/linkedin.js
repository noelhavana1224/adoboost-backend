const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../models/db');
const { authMiddleware } = require('../middleware/auth');
const { testCookies } = require('../services/linkedinService');
const { enc, dec } = require('../utils/crypto');
const router = express.Router();
router.use(authMiddleware);

// ── LinkedIn Accounts ─────────────────────────────────────────────────────

router.get('/accounts', async (req, res) => {
  try {
    const accounts = await dbAll(
      `SELECT id, name, daily_limit, sent_today, status, created_at FROM linkedin_accounts WHERE user_id=? ORDER BY created_at DESC`,
      [req.userId]
    );
    res.json(accounts);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/accounts', async (req, res) => {
  try {
    const { name, li_at, jsessionid, daily_limit } = req.body;
    if (!name || !li_at || !jsessionid) return res.status(400).json({ error: 'Name, li_at cookie, and JSESSIONID are required' });
    const id = uuidv4();
    await dbRun(
      `INSERT INTO linkedin_accounts (id, user_id, name, li_at, jsessionid, daily_limit) VALUES (?,?,?,?,?,?)`,
      [id, req.userId, name, enc(li_at), enc(jsessionid), daily_limit || 20]
    );
    const account = await dbGet(`SELECT id, name, daily_limit, sent_today, status, created_at FROM linkedin_accounts WHERE id=?`, [id]);
    res.json(account);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/accounts/:id/test', async (req, res) => {
  try {
    const account = await dbGet(`SELECT * FROM linkedin_accounts WHERE id=? AND user_id=?`, [req.params.id, req.userId]);
    if (!account) return res.status(404).json({ error: 'Not found' });

    // Validate cookie format locally — LinkedIn blocks server-side API calls from data center IPs
    const li_at = dec(account.li_at);
    const jsessionid = dec(account.jsessionid);
    if (!li_at || li_at.length < 20) {
      await dbRun(`UPDATE linkedin_accounts SET status='error' WHERE id=?`, [account.id]);
      return res.status(400).json({ error: 'li_at cookie appears empty or invalid — re-copy your cookies and try again' });
    }
    const rawSession = jsessionid.replace(/^["']|["']$/g, '');
    if (!rawSession.includes('ajax:')) {
      await dbRun(`UPDATE linkedin_accounts SET status='error' WHERE id=?`, [account.id]);
      return res.status(400).json({ error: 'JSESSIONID looks wrong — expected format like ajax:1234567890. Re-copy your cookies.' });
    }

    await dbRun(`UPDATE linkedin_accounts SET status='active' WHERE id=?`, [account.id]);
    res.json({ ok: true, name: 'LinkedIn User' });
  } catch (err) {
    await dbRun(`UPDATE linkedin_accounts SET status='error' WHERE id=?`, [req.params.id]).catch(() => {});
    res.status(400).json({ error: err.message });
  }
});

router.delete('/accounts/:id', async (req, res) => {
  try {
    await dbRun(`DELETE FROM linkedin_accounts WHERE id=? AND user_id=?`, [req.params.id, req.userId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── LinkedIn Campaigns ────────────────────────────────────────────────────

router.get('/campaigns', async (req, res) => {
  try {
    const campaigns = await dbAll(`
      SELECT lc.*,
        la.name as account_name,
        l.name as list_name,
        (SELECT COUNT(*) FROM linkedin_sends ls WHERE ls.campaign_id = lc.id) as total,
        (SELECT COUNT(*) FROM linkedin_sends ls WHERE ls.campaign_id = lc.id AND ls.status='sent') as sent_count,
        (SELECT COUNT(*) FROM linkedin_sends ls WHERE ls.campaign_id = lc.id AND ls.status='pending') as pending_count,
        (SELECT COUNT(*) FROM linkedin_sends ls WHERE ls.campaign_id = lc.id AND ls.status='failed') as failed_count,
        (SELECT COUNT(*) FROM linkedin_sends ls WHERE ls.campaign_id = lc.id AND ls.status='skipped') as skipped_count
      FROM linkedin_campaigns lc
      LEFT JOIN linkedin_accounts la ON lc.linkedin_account_id = la.id
      LEFT JOIN lists l ON lc.list_id = l.id
      WHERE lc.user_id=? ORDER BY lc.created_at DESC`,
      [req.userId]
    );
    res.json(campaigns);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/campaigns', async (req, res) => {
  try {
    const { name, linkedin_account_id, list_id, connection_note, daily_limit } = req.body;
    if (!name) return res.status(400).json({ error: 'Campaign name is required' });
    const id = uuidv4();
    await dbRun(
      `INSERT INTO linkedin_campaigns (id, user_id, name, linkedin_account_id, list_id, connection_note, daily_limit) VALUES (?,?,?,?,?,?,?)`,
      [id, req.userId, name, linkedin_account_id || null, list_id || null, connection_note || '', daily_limit || 20]
    );
    const campaign = await dbGet(`SELECT * FROM linkedin_campaigns WHERE id=?`, [id]);
    res.json(campaign);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/campaigns/:id', async (req, res) => {
  try {
    const { name, linkedin_account_id, list_id, connection_note, daily_limit } = req.body;
    const camp = await dbGet(`SELECT * FROM linkedin_campaigns WHERE id=? AND user_id=?`, [req.params.id, req.userId]);
    if (!camp) return res.status(404).json({ error: 'Not found' });
    if (camp.status === 'active') return res.status(400).json({ error: 'Cannot edit an active campaign' });
    await dbRun(
      `UPDATE linkedin_campaigns SET name=?, linkedin_account_id=?, list_id=?, connection_note=?, daily_limit=? WHERE id=?`,
      [name, linkedin_account_id || null, list_id || null, connection_note || '', daily_limit || 20, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/campaigns/:id/launch', async (req, res) => {
  try {
    const camp = await dbGet(`SELECT * FROM linkedin_campaigns WHERE id=? AND user_id=?`, [req.params.id, req.userId]);
    if (!camp) return res.status(404).json({ error: 'Not found' });
    if (!camp.linkedin_account_id) return res.status(400).json({ error: 'No LinkedIn account selected' });
    if (!camp.list_id) return res.status(400).json({ error: 'No contact list selected' });

    const contacts = await dbAll(`
      SELECT c.* FROM contacts c
      WHERE c.list_id=? AND c.user_id=? AND c.unsubscribed=0 AND c.bounced=0
      AND c.linkedin IS NOT NULL AND c.linkedin != ''
    `, [camp.list_id, req.userId]);

    if (contacts.length === 0)
      return res.status(400).json({
        error: 'No contacts with LinkedIn URLs found in this list. Edit your contacts and add their LinkedIn profile URLs first.',
      });

    const now = new Date();
    for (let i = 0; i < contacts.length; i++) {
      const sendTime = new Date(now.getTime() + i * 120000); // 2 min apart
      await dbRun(
        `INSERT INTO linkedin_sends (id, campaign_id, contact_id, linkedin_account_id, linkedin_profile_url, status, scheduled_at) VALUES (?,?,?,?,?,?,?)`,
        [uuidv4(), camp.id, contacts[i].id, camp.linkedin_account_id, contacts[i].linkedin, 'pending', sendTime.toISOString()]
      );
    }

    await dbRun(`UPDATE linkedin_campaigns SET status='active', started_at=? WHERE id=?`, [now.toISOString(), camp.id]);
    res.json({ success: true, scheduled: contacts.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/campaigns/:id/pause', async (req, res) => {
  try {
    await dbRun(`UPDATE linkedin_campaigns SET status='paused' WHERE id=? AND user_id=?`, [req.params.id, req.userId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/campaigns/:id/resume', async (req, res) => {
  try {
    await dbRun(`UPDATE linkedin_campaigns SET status='active' WHERE id=? AND user_id=?`, [req.params.id, req.userId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/campaigns/:id', async (req, res) => {
  try {
    const camp = await dbGet(`SELECT * FROM linkedin_campaigns WHERE id=? AND user_id=?`, [req.params.id, req.userId]);
    if (!camp) return res.status(404).json({ error: 'Not found' });
    await dbRun(`DELETE FROM linkedin_sends WHERE campaign_id=?`, [camp.id]);
    await dbRun(`DELETE FROM linkedin_campaigns WHERE id=?`, [camp.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/campaigns/:id/sends', async (req, res) => {
  try {
    const sends = await dbAll(`
      SELECT ls.*, c.first_name, c.last_name, c.linkedin
      FROM linkedin_sends ls
      JOIN contacts c ON ls.contact_id = c.id
      WHERE ls.campaign_id=? ORDER BY ls.scheduled_at DESC LIMIT 200
    `, [req.params.id]);
    res.json(sends);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── LinkedIn Connection Activity (inbox) ──────────────────────────────────

router.get('/inbox', async (req, res) => {
  try {
    const { account_id, status } = req.query;
    let where = `la.user_id = ?`;
    const params = [req.userId];
    if (account_id) { where += ` AND ls.linkedin_account_id = ?`; params.push(account_id); }
    if (status) { where += ` AND ls.status = ?`; params.push(status); }
    const sends = await dbAll(`
      SELECT ls.*,
             c.first_name, c.last_name, c.company, c.linkedin, c.linkedin_connected_via,
             la.name as account_name,
             COALESCE(lc.name, ec.name, 'Campaign') as campaign_name
      FROM linkedin_sends ls
      JOIN contacts c ON ls.contact_id = c.id
      JOIN linkedin_accounts la ON ls.linkedin_account_id = la.id
      LEFT JOIN linkedin_campaigns lc ON ls.campaign_id = lc.id AND ls.email_campaign_id IS NULL
      LEFT JOIN campaigns ec ON ls.email_campaign_id = ec.id
      WHERE ${where}
      ORDER BY COALESCE(ls.sent_at, ls.scheduled_at) DESC
      LIMIT 300
    `, params);
    res.json(sends);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
