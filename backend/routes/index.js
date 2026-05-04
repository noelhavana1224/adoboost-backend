// ═══════════════════════════════════════════════
//  EMAIL ACCOUNTS
// ═══════════════════════════════════════════════
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../models/db');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');
const nodemailer = require('nodemailer');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const bcrypt = require('bcryptjs');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Email Accounts ──────────────────────────────
const emailAccountsRouter = express.Router();
emailAccountsRouter.use(authMiddleware);

emailAccountsRouter.get('/', async (req, res) => {
  try {
    const accounts = await dbAll('SELECT id,name,type,host,port,username,from_name,from_email,daily_limit,sent_today,warmup_enabled,warmup_days,status,tags,created_at FROM email_accounts WHERE user_id=? ORDER BY created_at DESC', [req.userId]);
    res.json(accounts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

emailAccountsRouter.post('/', async (req, res) => {
  try {
    const { name, type='smtp', host, port, secure, username, password, from_name, from_email, daily_limit } = req.body;
    if (!username || !password || !from_email) return res.status(400).json({ error: 'username, password, from_email required' });
    const id = uuidv4();
    await dbRun(`INSERT INTO email_accounts (id,user_id,name,type,host,port,secure,username,password,from_name,from_email,daily_limit) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, req.userId, name||from_email, type, host||'', port||587, secure?1:0, username, password, from_name||'', from_email, daily_limit||100]);
    const acc = await dbGet('SELECT id,name,type,host,port,username,from_name,from_email,daily_limit,status FROM email_accounts WHERE id=?', [id]);
    res.json(acc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

emailAccountsRouter.post('/:id/test', async (req, res) => {
  try {
    const acc = await dbGet('SELECT * FROM email_accounts WHERE id=? AND user_id=?', [req.params.id, req.userId]);
    if (!acc) return res.status(404).json({ error: 'Not found' });
    const t = nodemailer.createTransport({ host: acc.host, port: acc.port, secure: acc.secure===1, auth: { user: acc.username, pass: acc.password }, tls: { rejectUnauthorized: false } });
    await t.verify();
    res.json({ success: true, message: 'Connection successful!' });
  } catch (e) { res.status(400).json({ success: false, error: e.message }); }
});

emailAccountsRouter.delete('/:id', async (req, res) => {
  try {
    const r = await dbRun('DELETE FROM email_accounts WHERE id=? AND user_id=?', [req.params.id, req.userId]);
    if (r.changes===0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

emailAccountsRouter.put('/:id', async (req, res) => {
  try {
    const { name, from_name, from_email, daily_limit, warmup_enabled, tags } = req.body;
    await dbRun('UPDATE email_accounts SET name=?,from_name=?,from_email=?,daily_limit=?,warmup_enabled=?,tags=? WHERE id=? AND user_id=?',
      [name, from_name, from_email, daily_limit, warmup_enabled?1:0, JSON.stringify(tags||[]), req.params.id, req.userId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Contacts ────────────────────────────────────
const contactsRouter = express.Router();
contactsRouter.use(authMiddleware);

contactsRouter.get('/lists', async (req, res) => {
  try {
    const lists = await dbAll(`SELECT l.*,
      COUNT(c.id) as total_contacts,
      SUM(CASE WHEN c.is_good=1 AND c.unsubscribed=0 THEN 1 ELSE 0 END) as good_contacts,
      SUM(CASE WHEN c.is_good=0 OR c.bounced=1 THEN 1 ELSE 0 END) as bad_contacts
      FROM lists l LEFT JOIN contacts c ON l.id=c.list_id WHERE l.user_id=? GROUP BY l.id ORDER BY l.created_at DESC`, [req.userId]);
    res.json(lists);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

contactsRouter.post('/lists', async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const id = uuidv4();
    await dbRun('INSERT INTO lists (id,user_id,name,description) VALUES (?,?,?,?)', [id, req.userId, name, description||'']);
    res.json(await dbGet('SELECT * FROM lists WHERE id=?', [id]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

contactsRouter.delete('/lists/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM contacts WHERE list_id=? AND user_id=?', [req.params.id, req.userId]);
    const r = await dbRun('DELETE FROM lists WHERE id=? AND user_id=?', [req.params.id, req.userId]);
    if (r.changes===0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

contactsRouter.get('/', async (req, res) => {
  try {
    const { list_id, search, page=1, limit=50 } = req.query;
    const offset = (page-1)*limit;
    let where = ['c.user_id=?']; const params = [req.userId];
    if (list_id) { where.push('c.list_id=?'); params.push(list_id); }
    if (search) { where.push('(c.email LIKE ? OR c.first_name LIKE ? OR c.company LIKE ?)'); const s=`%${search}%`; params.push(s,s,s); }
    const w = 'WHERE ' + where.join(' AND ');
    const contacts = await dbAll(`SELECT c.* FROM contacts c ${w} ORDER BY c.created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, params);
    const total = (await dbGet(`SELECT COUNT(*) as n FROM contacts c ${w}`, params)).n;
    res.json({ contacts, total, page: Number(page) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

contactsRouter.post('/', async (req, res) => {
  try {
    const { email, first_name, last_name, company, title, phone, website, list_id, custom_fields } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const id = uuidv4();
    await dbRun('INSERT INTO contacts (id,user_id,list_id,email,first_name,last_name,company,title,phone,website,custom_fields) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [id, req.userId, list_id||null, email.toLowerCase().trim(), first_name||'', last_name||'', company||'', title||'', phone||'', website||'', JSON.stringify(custom_fields||{})]);
    res.json(await dbGet('SELECT * FROM contacts WHERE id=?', [id]));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Email exists' });
    res.status(500).json({ error: e.message });
  }
});

contactsRouter.post('/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { list_id } = req.body;
    const records = parse(req.file.buffer.toString('utf-8'), { columns: true, skip_empty_lines: true, trim: true });
    let imported=0, skipped=0;
    for (const row of records) {
      const email = (row.email||row.Email||row.EMAIL||'').toLowerCase().trim();
      if (!email || !email.includes('@')) { skipped++; continue; }
      const { email:_e, Email:_E, EMAIL:_EE, first_name, First_Name, last_name, Last_Name, company, Company, title, Title, phone, Phone, website, Website, ...rest } = row;
      try {
        const id = uuidv4();
        await dbRun('INSERT OR IGNORE INTO contacts (id,user_id,list_id,email,first_name,last_name,company,title,phone,website,custom_fields) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          [id, req.userId, list_id||null, email, first_name||First_Name||'', last_name||Last_Name||'', company||Company||'', title||Title||'', phone||Phone||'', website||Website||'', JSON.stringify(rest)]);
        imported++;
      } catch { skipped++; }
    }
    res.json({ imported, skipped, total: records.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

contactsRouter.delete('/:id', async (req, res) => {
  try {
    const r = await dbRun('DELETE FROM contacts WHERE id=? AND user_id=?', [req.params.id, req.userId]);
    if (r.changes===0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Campaigns ───────────────────────────────────
const campaignsRouter = express.Router();
campaignsRouter.use(authMiddleware);

campaignsRouter.get('/', async (req, res) => {
  try {
    const campaigns = await dbAll(`SELECT c.*,
      (SELECT COUNT(*) FROM sends WHERE campaign_id=c.id AND status='sent') as sent_count,
      (SELECT COUNT(*) FROM sends WHERE campaign_id=c.id AND opened_at IS NOT NULL) as opened_count,
      (SELECT COUNT(*) FROM sends WHERE campaign_id=c.id AND clicked_at IS NOT NULL) as clicked_count,
      (SELECT COUNT(*) FROM sends WHERE campaign_id=c.id AND replied=1) as replied_count,
      (SELECT COUNT(*) FROM sends WHERE campaign_id=c.id AND bounced=1) as bounced_count,
      l.name as list_name, ea.from_email as account_email
      FROM campaigns c
      LEFT JOIN lists l ON c.list_id=l.id
      LEFT JOIN email_accounts ea ON c.email_account_id=ea.id
      WHERE c.user_id=? ORDER BY c.created_at DESC`, [req.userId]);
    res.json(campaigns);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

campaignsRouter.get('/:id', async (req, res) => {
  try {
    const c = await dbGet(`SELECT c.*,l.name as list_name,ea.from_email as account_email FROM campaigns c LEFT JOIN lists l ON c.list_id=l.id LEFT JOIN email_accounts ea ON c.email_account_id=ea.id WHERE c.id=? AND c.user_id=?`, [req.params.id, req.userId]);
    if (!c) return res.status(404).json({ error: 'Not found' });
    const sequences = await dbAll('SELECT * FROM sequences WHERE campaign_id=? ORDER BY step_number', [req.params.id]);
    res.json({ ...c, sequences });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

campaignsRouter.post('/', async (req, res) => {
  try {
    const { name, email_account_id, list_id, schedule_type, scheduled_at, daily_limit, track_opens, track_clicks, sequences } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const id = uuidv4();
    await dbRun('INSERT INTO campaigns (id,user_id,name,email_account_id,list_id,schedule_type,scheduled_at,daily_limit,track_opens,track_clicks) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [id, req.userId, name, email_account_id||null, list_id||null, schedule_type||'immediate', scheduled_at||null, daily_limit||50, track_opens!==false?1:0, track_clicks!==false?1:0]);
    if (sequences?.length) {
      for (let i=0; i<sequences.length; i++) {
        const s=sequences[i];
        await dbRun('INSERT INTO sequences (id,campaign_id,step_number,subject,body,delay_days,delay_hours) VALUES (?,?,?,?,?,?,?)',
          [uuidv4(), id, i+1, s.subject, s.body, s.delay_days||0, s.delay_hours||0]);
      }
    }
    res.json(await dbGet('SELECT * FROM campaigns WHERE id=?', [id]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

campaignsRouter.put('/:id', async (req, res) => {
  try {
    const c = await dbGet('SELECT * FROM campaigns WHERE id=? AND user_id=?', [req.params.id, req.userId]);
    if (!c) return res.status(404).json({ error: 'Not found' });
    if (c.status==='active') return res.status(400).json({ error: 'Cannot edit active campaign' });
    const { name, email_account_id, list_id, schedule_type, scheduled_at, daily_limit, track_opens, track_clicks, sequences } = req.body;
    await dbRun('UPDATE campaigns SET name=?,email_account_id=?,list_id=?,schedule_type=?,scheduled_at=?,daily_limit=?,track_opens=?,track_clicks=? WHERE id=? AND user_id=?',
      [name, email_account_id, list_id, schedule_type, scheduled_at, daily_limit, track_opens?1:0, track_clicks?1:0, req.params.id, req.userId]);
    if (sequences) {
      await dbRun('DELETE FROM sequences WHERE campaign_id=?', [req.params.id]);
      for (let i=0; i<sequences.length; i++) {
        const s=sequences[i];
        await dbRun('INSERT INTO sequences (id,campaign_id,step_number,subject,body,delay_days,delay_hours) VALUES (?,?,?,?,?,?,?)',
          [uuidv4(), req.params.id, i+1, s.subject, s.body, s.delay_days||0, s.delay_hours||0]);
      }
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

campaignsRouter.post('/:id/launch', async (req, res) => {
  try {
    const c = await dbGet('SELECT * FROM campaigns WHERE id=? AND user_id=?', [req.params.id, req.userId]);
    if (!c) return res.status(404).json({ error: 'Not found' });
    if (!c.email_account_id) return res.status(400).json({ error: 'Select an email account first' });
    if (!c.list_id) return res.status(400).json({ error: 'Select a contact list first' });
    const seqs = await dbAll('SELECT * FROM sequences WHERE campaign_id=? ORDER BY step_number', [c.id]);
    if (!seqs.length) return res.status(400).json({ error: 'Add at least one email sequence' });
    const contacts = await dbAll('SELECT * FROM contacts WHERE list_id=? AND unsubscribed=0 AND bounced=0 AND user_id=?', [c.list_id, req.userId]);
    if (!contacts.length) return res.status(400).json({ error: 'No active contacts in list' });
    const now = new Date();
    let count=0;
    for (const contact of contacts) {
      let base = new Date(now);
      for (const seq of seqs) {
        const sched = new Date(base);
        sched.setDate(sched.getDate()+(seq.delay_days||0));
        sched.setHours(sched.getHours()+(seq.delay_hours||0));
        await dbRun('INSERT INTO sends (id,campaign_id,sequence_id,contact_id,email_account_id,status,scheduled_at) VALUES (?,?,?,?,?,?,?)',
          [uuidv4(), c.id, seq.id, contact.id, c.email_account_id, 'pending', sched.toISOString()]);
        base = new Date(sched);
        count++;
      }
    }
    await dbRun(`UPDATE campaigns SET status='active', started_at=? WHERE id=?`, [now.toISOString(), c.id]);
    res.json({ success: true, scheduled: count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

campaignsRouter.post('/:id/pause', async (req, res) => {
  try { await dbRun(`UPDATE campaigns SET status='paused' WHERE id=? AND user_id=?`, [req.params.id, req.userId]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

campaignsRouter.post('/:id/resume', async (req, res) => {
  try { await dbRun(`UPDATE campaigns SET status='active' WHERE id=? AND user_id=?`, [req.params.id, req.userId]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

campaignsRouter.delete('/:id', async (req, res) => {
  try {
    const c = await dbGet('SELECT * FROM campaigns WHERE id=? AND user_id=?', [req.params.id, req.userId]);
    if (!c) return res.status(404).json({ error: 'Not found' });
    await dbRun('DELETE FROM sends WHERE campaign_id=?', [req.params.id]);
    await dbRun('DELETE FROM sequences WHERE campaign_id=?', [req.params.id]);
    await dbRun('DELETE FROM campaigns WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

campaignsRouter.get('/:id/sends', async (req, res) => {
  try {
    const sends = await dbAll(`SELECT s.*,c.email,c.first_name,c.last_name,seq.subject,seq.step_number FROM sends s JOIN contacts c ON s.contact_id=c.id JOIN sequences seq ON s.sequence_id=seq.id WHERE s.campaign_id=? ORDER BY s.scheduled_at DESC LIMIT 200`, [req.params.id]);
    res.json(sends);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Messages ────────────────────────────────────
const messagesRouter = express.Router();
messagesRouter.use(authMiddleware);

messagesRouter.get('/inbox', async (req, res) => {
  try {
    const { search, status, page=1, limit=20 } = req.query;
    const offset = (page-1)*limit;
    let where=['m.user_id=?','m.is_auto_reply=0']; const params=[req.userId];
    if (search) { where.push('(m.from_email LIKE ? OR m.subject LIKE ?)'); const s=`%${search}%`; params.push(s,s); }
    if (status) { where.push('m.status=?'); params.push(status); }
    const w='WHERE '+where.join(' AND ');
    const messages = await dbAll(`SELECT m.*,c.name as campaign_name FROM messages m LEFT JOIN campaigns c ON m.campaign_id=c.id ${w} ORDER BY m.received_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, params);
    const total = (await dbGet(`SELECT COUNT(*) as n FROM messages m ${w}`, params)).n;
    res.json({ messages, total, page: Number(page) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

messagesRouter.get('/auto-replies', async (req, res) => {
  try {
    const { search, page=1, limit=20 } = req.query;
    const offset = (page-1)*limit;
    let where=['m.user_id=?','m.is_auto_reply=1']; const params=[req.userId];
    if (search) { where.push('(m.from_email LIKE ? OR m.subject LIKE ?)'); const s=`%${search}%`; params.push(s,s); }
    const w='WHERE '+where.join(' AND ');
    const messages = await dbAll(`SELECT m.*,c.name as campaign_name FROM messages m LEFT JOIN campaigns c ON m.campaign_id=c.id ${w} ORDER BY m.received_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, params);
    const total = (await dbGet(`SELECT COUNT(*) as n FROM messages m ${w}`, params)).n;
    res.json({ messages, total, page: Number(page) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Exclusions ──────────────────────────────────
const exclusionsRouter = express.Router();
exclusionsRouter.use(authMiddleware);

exclusionsRouter.get('/', async (req, res) => {
  try {
    const { search, type, page=1, limit=10 } = req.query;
    const offset = (page-1)*limit;
    let where=['user_id=?']; const params=[req.userId];
    if (search) { where.push('value LIKE ?'); params.push(`%${search}%`); }
    if (type) { where.push('type=?'); params.push(type); }
    const w='WHERE '+where.join(' AND ');
    const items = await dbAll(`SELECT * FROM exclusions ${w} ORDER BY created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, params);
    const total = (await dbGet(`SELECT COUNT(*) as n FROM exclusions ${w}`, params)).n;
    res.json({ items, total, page: Number(page) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

exclusionsRouter.post('/', async (req, res) => {
  try {
    const { value, type='email' } = req.body;
    if (!value) return res.status(400).json({ error: 'Value required' });
    const id = uuidv4();
    await dbRun('INSERT OR IGNORE INTO exclusions (id,user_id,value,type) VALUES (?,?,?,?)', [id, req.userId, value.toLowerCase().trim(), type]);
    res.json(await dbGet('SELECT * FROM exclusions WHERE id=?', [id]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

exclusionsRouter.post('/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const lines = req.file.buffer.toString('utf-8').split('\n').map(l => l.trim()).filter(Boolean);
    let imported=0;
    for (const line of lines) {
      const value = line.split(',')[0].trim().toLowerCase();
      if (value) { const id=uuidv4(); await dbRun('INSERT OR IGNORE INTO exclusions (id,user_id,value,type) VALUES (?,?,?,?)', [id,req.userId,value,'email']); imported++; }
    }
    res.json({ imported });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

exclusionsRouter.delete('/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM exclusions WHERE id=? AND user_id=?', [req.params.id, req.userId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

exclusionsRouter.get('/unsubscribes', async (req, res) => {
  try {
    const { page=1, limit=10 } = req.query;
    const offset = (page-1)*limit;
    const items = await dbAll(`SELECT u.*,c.name as campaign_name FROM unsubscribes u LEFT JOIN campaigns c ON u.campaign_id=c.id WHERE u.user_id=? ORDER BY u.created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, [req.userId]);
    const total = (await dbGet('SELECT COUNT(*) as n FROM unsubscribes WHERE user_id=?', [req.userId])).n;
    res.json({ items, total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Templates ───────────────────────────────────
const templatesRouter = express.Router();
templatesRouter.use(authMiddleware);

templatesRouter.get('/', async (req, res) => {
  try {
    const { search } = req.query;
    let where=['user_id=?']; const params=[req.userId];
    if (search) { where.push('name LIKE ?'); params.push(`%${search}%`); }
    const items = await dbAll(`SELECT * FROM templates WHERE ${where.join(' AND ')} ORDER BY created_at DESC`, params);
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

templatesRouter.post('/', async (req, res) => {
  try {
    const { name, subject, body, category } = req.body;
    if (!name || !body) return res.status(400).json({ error: 'Name and body required' });
    const id = uuidv4();
    await dbRun('INSERT INTO templates (id,user_id,name,subject,body,category) VALUES (?,?,?,?,?,?)', [id, req.userId, name, subject||'', body, category||'general']);
    res.json(await dbGet('SELECT * FROM templates WHERE id=?', [id]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

templatesRouter.put('/:id', async (req, res) => {
  try {
    const { name, subject, body, category } = req.body;
    await dbRun('UPDATE templates SET name=?,subject=?,body=?,category=? WHERE id=? AND user_id=?', [name, subject, body, category, req.params.id, req.userId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

templatesRouter.delete('/:id', async (req, res) => {
  try {
    await dbRun('DELETE FROM templates WHERE id=? AND user_id=?', [req.params.id, req.userId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Support Tickets ─────────────────────────────
const ticketsRouter = express.Router();
ticketsRouter.use(authMiddleware);

ticketsRouter.post('/', async (req, res) => {
  try {
    const { name, email, phone, subject, message } = req.body;
    if (!subject || !message) return res.status(400).json({ error: 'Subject and message required' });
    const id = uuidv4();
    await dbRun('INSERT INTO tickets (id,user_id,name,email,phone,subject,message) VALUES (?,?,?,?,?,?,?)',
      [id, req.userId, name||'', email||'', phone||'', subject, message]);
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

ticketsRouter.get('/', async (req, res) => {
  try {
    const tickets = await dbAll('SELECT * FROM tickets WHERE user_id=? ORDER BY created_at DESC', [req.userId]);
    res.json(tickets);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Analytics ───────────────────────────────────
const analyticsRouter = express.Router();
analyticsRouter.use(authMiddleware);

analyticsRouter.get('/summary', async (req, res) => {
  try {
    const { range='7' } = req.query;
    const totalCampaigns = (await dbGet('SELECT COUNT(*) as c FROM campaigns WHERE user_id=?', [req.userId])).c;
    const activeCampaigns = (await dbGet(`SELECT COUNT(*) as c FROM campaigns WHERE user_id=? AND status='active'`, [req.userId])).c;
    const totalContacts = (await dbGet('SELECT COUNT(*) as c FROM contacts WHERE user_id=?', [req.userId])).c;
    const stats = await dbGet(`SELECT
      SUM(CASE WHEN s.status='sent' THEN 1 ELSE 0 END) as total_sent,
      SUM(CASE WHEN s.opened_at IS NOT NULL THEN 1 ELSE 0 END) as total_opened,
      SUM(CASE WHEN s.clicked_at IS NOT NULL THEN 1 ELSE 0 END) as total_clicked,
      SUM(CASE WHEN s.replied=1 THEN 1 ELSE 0 END) as total_replied,
      SUM(CASE WHEN s.bounced=1 THEN 1 ELSE 0 END) as total_bounced
      FROM sends s JOIN campaigns c ON s.campaign_id=c.id WHERE c.user_id=?`, [req.userId]);
    const dailySends = await dbAll(`SELECT DATE(s.sent_at) as date,COUNT(*) as count FROM sends s JOIN campaigns c ON s.campaign_id=c.id WHERE c.user_id=? AND s.status='sent' AND s.sent_at>=date('now','-${Number(range)} days') GROUP BY DATE(s.sent_at) ORDER BY date`, [req.userId]);
    const topCampaigns = await dbAll(`SELECT c.id,c.name,c.status,
      SUM(CASE WHEN s.status='sent' THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN s.opened_at IS NOT NULL THEN 1 ELSE 0 END) as opened,
      SUM(CASE WHEN s.replied=1 THEN 1 ELSE 0 END) as replied
      FROM campaigns c LEFT JOIN sends s ON c.id=s.campaign_id WHERE c.user_id=? GROUP BY c.id ORDER BY sent DESC LIMIT 5`, [req.userId]);
    const recentActivity = await dbAll(`SELECT s.sent_at,s.status,c2.email as contact_email,seq.subject,c.name as campaign_name FROM sends s JOIN contacts c2 ON s.contact_id=c2.id JOIN sequences seq ON s.sequence_id=seq.id JOIN campaigns c ON s.campaign_id=c.id WHERE c.user_id=? AND s.status='sent' ORDER BY s.sent_at DESC LIMIT 10`, [req.userId]);
    res.json({ totalCampaigns, activeCampaigns, totalContacts, ...stats, dailySends, topCampaigns, recentActivity });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

analyticsRouter.get('/campaigns/:id', async (req, res) => {
  try {
    const campaign = await dbGet('SELECT * FROM campaigns WHERE id=? AND user_id=?', [req.params.id, req.userId]);
    if (!campaign) return res.status(404).json({ error: 'Not found' });
    const bySequence = await dbAll(`SELECT seq.step_number,seq.subject,
      COUNT(s.id) as total, SUM(CASE WHEN s.status='sent' THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN s.opened_at IS NOT NULL THEN 1 ELSE 0 END) as opened,
      SUM(CASE WHEN s.clicked_at IS NOT NULL THEN 1 ELSE 0 END) as clicked,
      SUM(CASE WHEN s.replied=1 THEN 1 ELSE 0 END) as replied,
      SUM(CASE WHEN s.bounced=1 THEN 1 ELSE 0 END) as bounced
      FROM sequences seq LEFT JOIN sends s ON seq.id=s.sequence_id WHERE seq.campaign_id=? GROUP BY seq.id ORDER BY seq.step_number`, [req.params.id]);
    res.json({ campaign, bySequence });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Tracking ─────────────────────────────────────
const trackingRouter = express.Router();
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
const BASE_URL = () => process.env.BASE_URL || 'http://localhost:3001';

trackingRouter.get('/open/:sendId', async (req, res) => {
  try {
    const s = await dbGet('SELECT * FROM sends WHERE id=?', [req.params.sendId]);
    if (s && !s.opened_at) await dbRun('UPDATE sends SET opened_at=? WHERE id=?', [new Date().toISOString(), s.id]);
  } catch {}
  res.set('Content-Type','image/gif').set('Cache-Control','no-store').send(PIXEL);
});

trackingRouter.get('/click/:sendId', async (req, res) => {
  const { url } = req.query;
  try {
    const s = await dbGet('SELECT * FROM sends WHERE id=?', [req.params.sendId]);
    if (s && !s.clicked_at) await dbRun('UPDATE sends SET clicked_at=? WHERE id=?', [new Date().toISOString(), s.id]);
  } catch {}
  if (url) return res.redirect(url);
  res.send('OK');
});

trackingRouter.get('/unsubscribe/:sendId', async (req, res) => {
  try {
    const s = await dbGet('SELECT * FROM sends WHERE id=?', [req.params.sendId]);
    if (s) {
      await dbRun('UPDATE sends SET unsubscribed=1 WHERE id=?', [s.id]);
      await dbRun('UPDATE contacts SET unsubscribed=1 WHERE id=?', [s.contact_id]);
      const send = await dbGet('SELECT * FROM sends WHERE id=?', [s.id]);
      const contact = await dbGet('SELECT * FROM contacts WHERE id=?', [s.contact_id]);
      if (contact) {
        const campaign = await dbGet('SELECT user_id FROM campaigns WHERE id=?', [s.campaign_id]);
        if (campaign) await dbRun('INSERT INTO unsubscribes (id,user_id,campaign_id,email) VALUES (?,?,?,?)', [uuidv4(), campaign.user_id, s.campaign_id, contact.email]);
      }
      await dbRun(`UPDATE sends SET status='cancelled' WHERE campaign_id=? AND contact_id=? AND status='pending'`, [s.campaign_id, s.contact_id]);
    }
  } catch {}
  res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:80px;background:#f8f9fa"><div style="max-width:400px;margin:0 auto;background:#fff;padding:40px;border-radius:16px;box-shadow:0 4px 20px rgba(0,0,0,0.1)"><h2 style="color:#1a1a2e">Unsubscribed</h2><p style="color:#666">You've been removed from this mailing list.</p></div></body></html>`);
});

// ── Admin ───────────────────────────────────────
const adminRouter = express.Router();
adminRouter.use(authMiddleware, adminMiddleware);

adminRouter.get('/stats', async (req, res) => {
  try {
    const totalUsers = (await dbGet(`SELECT COUNT(*) as c FROM users WHERE role!='admin'`, [])).c;
    const activeToday = (await dbGet(`SELECT COUNT(*) as c FROM users WHERE date(last_login)=date('now')`, [])).c;
    const paidUsers = (await dbGet(`SELECT COUNT(*) as c FROM users WHERE plan!='trial' AND role!='admin'`, [])).c;
    const trialUsers = (await dbGet(`SELECT COUNT(*) as c FROM users WHERE plan='trial' AND role!='admin'`, [])).c;
    const suspended = (await dbGet(`SELECT COUNT(*) as c FROM users WHERE is_suspended=1`, [])).c;
    const totalCampaigns = (await dbGet(`SELECT COUNT(*) as c FROM campaigns`, [])).c;
    const totalEmails = (await dbGet(`SELECT COUNT(*) as c FROM sends WHERE status='sent'`, [])).c;
    const totalContacts = (await dbGet(`SELECT COUNT(*) as c FROM contacts`, [])).c;
    const openTickets = (await dbGet(`SELECT COUNT(*) as c FROM tickets WHERE status='open'`, [])).c;
    const newUsersWeek = await dbAll(`SELECT date(created_at) as date,COUNT(*) as count FROM users WHERE created_at>=date('now','-7 days') GROUP BY date(created_at) ORDER BY date`, []);
    const planBreakdown = await dbAll(`SELECT plan,COUNT(*) as count FROM users WHERE role!='admin' GROUP BY plan`, []);
    const recentUsers = await dbAll(`SELECT u.id,u.name,u.email,u.plan,u.is_suspended,u.created_at,u.last_login, (SELECT COUNT(*) FROM campaigns WHERE user_id=u.id) as campaigns FROM users u WHERE role!='admin' ORDER BY created_at DESC LIMIT 10`, []);
    res.json({ totalUsers, activeToday, paidUsers, trialUsers, suspended, totalCampaigns, totalEmails, totalContacts, openTickets, newUsersWeek, planBreakdown, recentUsers });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

adminRouter.get('/users', async (req, res) => {
  try {
    const { search, plan, status, page=1, limit=20 } = req.query;
    const offset = (page-1)*limit;
    let where=[`role!='admin'`]; const params=[];
    if (search) { where.push('(name LIKE ? OR email LIKE ?)'); const s=`%${search}%`; params.push(s,s); }
    if (plan) { where.push('plan=?'); params.push(plan); }
    if (status==='suspended') where.push('is_suspended=1');
    if (status==='active') where.push('is_suspended=0');
    const w='WHERE '+where.join(' AND ');
    const users = await dbAll(`SELECT u.id,u.name,u.email,u.plan,u.plan_expires_at,u.is_suspended,u.suspension_reason,u.created_at,u.last_login, (SELECT COUNT(*) FROM campaigns WHERE user_id=u.id) as campaigns, (SELECT COUNT(*) FROM contacts WHERE user_id=u.id) as contacts, (SELECT COUNT(*) FROM sends s JOIN campaigns c ON s.campaign_id=c.id WHERE c.user_id=u.id AND s.status='sent') as emails_sent FROM users u ${w} ORDER BY u.created_at DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, params);
    const total = (await dbGet(`SELECT COUNT(*) as c FROM users ${w}`, params)).c;
    res.json({ users, total, page: Number(page) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

adminRouter.get('/users/:id', async (req, res) => {
  try {
    const user = await dbGet('SELECT id,name,email,plan,plan_expires_at,is_suspended,suspension_reason,created_at,last_login,company,country FROM users WHERE id=?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'Not found' });
    const campaigns = await dbAll('SELECT id,name,status,created_at FROM campaigns WHERE user_id=? ORDER BY created_at DESC LIMIT 10', [req.params.id]);
    const subscriptions = await dbAll('SELECT s.*,p.name as plan_name FROM subscriptions s JOIN plans p ON s.plan_id=p.id WHERE s.user_id=? ORDER BY s.created_at DESC', [req.params.id]);
    const stats = await dbGet(`SELECT (SELECT COUNT(*) FROM contacts WHERE user_id=?) as contacts,(SELECT COUNT(*) FROM campaigns WHERE user_id=?) as campaigns,(SELECT COUNT(*) FROM sends s JOIN campaigns c ON s.campaign_id=c.id WHERE c.user_id=? AND s.status='sent') as sent`, [req.params.id,req.params.id,req.params.id]);
    res.json({ ...user, campaigns, subscriptions, stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

adminRouter.put('/users/:id/plan', async (req, res) => {
  try {
    const { plan, expires_at, notes } = req.body;
    await dbRun('UPDATE users SET plan=?,plan_expires_at=? WHERE id=?', [plan, expires_at||null, req.params.id]);
    const planRow = await dbGet('SELECT id FROM plans WHERE LOWER(name)=LOWER(?)', [plan]);
    if (planRow) await dbRun('INSERT INTO subscriptions (id,user_id,plan_id,expires_at,notes) VALUES (?,?,?,?,?)', [uuidv4(), req.params.id, planRow.id, expires_at||null, notes||'']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

adminRouter.post('/users/:id/suspend', async (req, res) => {
  try { await dbRun('UPDATE users SET is_suspended=1,suspension_reason=? WHERE id=?', [req.body.reason||'Suspended by admin', req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

adminRouter.post('/users/:id/unsuspend', async (req, res) => {
  try { await dbRun('UPDATE users SET is_suspended=0,suspension_reason=NULL WHERE id=?', [req.params.id]); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

adminRouter.post('/users/:id/reset-password', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'Min 6 characters' });
    await dbRun('UPDATE users SET password=? WHERE id=?', [await bcrypt.hash(password, 10), req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

adminRouter.delete('/users/:id', async (req, res) => {
  try {
    const user = await dbGet('SELECT * FROM users WHERE id=?', [req.params.id]);
    if (!user || user.role==='admin') return res.status(400).json({ error: 'Cannot delete this user' });
    const campaigns = await dbAll('SELECT id FROM campaigns WHERE user_id=?', [req.params.id]);
    for (const c of campaigns) { await dbRun('DELETE FROM sends WHERE campaign_id=?', [c.id]); await dbRun('DELETE FROM sequences WHERE campaign_id=?', [c.id]); }
    await dbRun('DELETE FROM campaigns WHERE user_id=?', [req.params.id]);
    await dbRun('DELETE FROM contacts WHERE user_id=?', [req.params.id]);
    await dbRun('DELETE FROM lists WHERE user_id=?', [req.params.id]);
    await dbRun('DELETE FROM email_accounts WHERE user_id=?', [req.params.id]);
    await dbRun('DELETE FROM templates WHERE user_id=?', [req.params.id]);
    await dbRun('DELETE FROM exclusions WHERE user_id=?', [req.params.id]);
    await dbRun('DELETE FROM unsubscribes WHERE user_id=?', [req.params.id]);
    await dbRun('DELETE FROM tickets WHERE user_id=?', [req.params.id]);
    await dbRun('DELETE FROM subscriptions WHERE user_id=?', [req.params.id]);
    await dbRun('DELETE FROM users WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

adminRouter.get('/plans', async (req, res) => {
  try { res.json(await dbAll('SELECT * FROM plans ORDER BY price_monthly', [])); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

adminRouter.put('/plans/:id', async (req, res) => {
  try {
    const { name, price_monthly, max_contacts, max_campaigns, max_emails_per_day, max_email_accounts, features } = req.body;
    await dbRun('UPDATE plans SET name=?,price_monthly=?,max_contacts=?,max_campaigns=?,max_emails_per_day=?,max_email_accounts=?,features=? WHERE id=?',
      [name, price_monthly, max_contacts, max_campaigns, max_emails_per_day, max_email_accounts, JSON.stringify(features), req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

adminRouter.get('/tickets', async (req, res) => {
  try {
    const tickets = await dbAll(`SELECT t.*,u.name as user_name,u.email as user_email FROM tickets t JOIN users u ON t.user_id=u.id ORDER BY t.created_at DESC`, []);
    res.json(tickets);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

adminRouter.put('/tickets/:id', async (req, res) => {
  try {
    const { status, admin_reply } = req.body;
    await dbRun('UPDATE tickets SET status=?,admin_reply=? WHERE id=?', [status, admin_reply, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = { emailAccountsRouter, contactsRouter, campaignsRouter, messagesRouter, exclusionsRouter, templatesRouter, ticketsRouter, analyticsRouter, trackingRouter, adminRouter };
