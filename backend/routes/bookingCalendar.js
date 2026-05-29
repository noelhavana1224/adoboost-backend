const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../models/db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// ── Logo upload setup ─────────────────────────────────────────────────────
const LOGO_DIR = path.join(process.env.DATA_DIR || '/home/u346663333/adoboost-data', 'uploads', 'logos');
const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(LOGO_DIR)) fs.mkdirSync(LOGO_DIR, { recursive: true });
    cb(null, LOGO_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    cb(null, `logo_${req.userId}_${Date.now()}${ext}`);
  },
});
const logoUpload = multer({
  storage: logoStorage,
  limits: { fileSize: 3 * 1024 * 1024 }, // 3 MB max
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg','image/png','image/gif','image/webp','image/svg+xml'].includes(file.mimetype);
    cb(null, ok);
  },
});

const DEFAULT_AVAILABILITY = {
  mon: { enabled: true, start: '09:00', end: '17:00' },
  tue: { enabled: true, start: '09:00', end: '17:00' },
  wed: { enabled: true, start: '09:00', end: '17:00' },
  thu: { enabled: true, start: '09:00', end: '17:00' },
  fri: { enabled: true, start: '09:00', end: '17:00' },
  sat: { enabled: false, start: '09:00', end: '17:00' },
  sun: { enabled: false, start: '09:00', end: '17:00' },
};

function safeJson(str, fallback) {
  try { return typeof str === 'string' ? JSON.parse(str) : str; } catch { return fallback; }
}

// All routes require auth
router.use(authMiddleware);

// ── List user's booking calendars ─────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const cals = await dbAll(
      `SELECT bc.*,
        (SELECT COUNT(*) FROM bookings b WHERE b.calendar_id=bc.id AND b.status='confirmed') as booking_count
       FROM booking_calendars bc WHERE bc.user_id=? ORDER BY bc.created_at DESC`,
      [req.userId]
    );
    res.json(cals.map(c => ({
      ...c,
      custom_questions: safeJson(c.custom_questions, []),
      availability: safeJson(c.availability, DEFAULT_AVAILABILITY),
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Get all bookings for user (across all calendars) ──────────────────────
router.get('/bookings/all', async (req, res) => {
  try {
    const { status, from, to } = req.query;
    let where = ['b.user_id=?'];
    const params = [req.userId];
    if (status) { where.push('b.status=?'); params.push(status); }
    if (from)   { where.push("b.start_time >= ?"); params.push(from); }
    if (to)     { where.push("b.start_time <= ?"); params.push(to); }

    const bookings = await dbAll(
      `SELECT b.*, bc.name as calendar_name, bc.slug, bc.accent_color, bc.duration, bc.timezone as cal_timezone
       FROM bookings b JOIN booking_calendars bc ON b.calendar_id=bc.id
       WHERE ${where.join(' AND ')} ORDER BY b.start_time DESC LIMIT 500`,
      params
    );
    res.json(bookings.map(b => ({ ...b, custom_answers: safeJson(b.custom_answers, {}) })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Cancel a booking ──────────────────────────────────────────────────────
router.delete('/bookings/:bookingId', async (req, res) => {
  try {
    const booking = await dbGet('SELECT id FROM bookings WHERE id=? AND user_id=?', [req.params.bookingId, req.userId]);
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    await dbRun("UPDATE bookings SET status='cancelled' WHERE id=?", [req.params.bookingId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Upload logo image ─────────────────────────────────────────────────────
router.post('/upload-logo', logoUpload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file or unsupported format (jpg/png/gif/webp/svg only, max 3 MB)' });
  const apiBase = process.env.API_URL || 'https://api.adobosolutions.com';
  const url = `${apiBase}/uploads/logos/${req.file.filename}`;
  res.json({ url });
});

// ── Test custom SMTP ─────────────────────────────────────────────────────
router.post('/test-smtp', async (req, res) => {
  try {
    const nodemailer = require('nodemailer');
    const { smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from_email, smtp_from_name, smtp_secure } = req.body;
    if (!smtp_host || !smtp_user || !smtp_pass) return res.status(400).json({ error: 'Host, username and password required' });

    const transporter = nodemailer.createTransport({
      host: smtp_host, port: smtp_port || 587,
      secure: !!smtp_secure,
      auth: { user: smtp_user, pass: smtp_pass },
      tls: { rejectUnauthorized: false },
    });

    await transporter.verify();
    res.json({ success: true, message: 'SMTP connection successful!' });
  } catch (err) { res.status(400).json({ error: 'SMTP test failed: ' + err.message }); }
});

// ── Create calendar ───────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { name, description, duration, buffer_time, timezone, location_type, location_url, forward_email,
            custom_questions, availability, accent_color,
            logo_url, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from_name, smtp_from_email, smtp_secure } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'booking';
    const suffix = Math.random().toString(36).substring(2, 7);
    const slug = `${base}-${suffix}`;

    const id = uuidv4();
    await dbRun(
      `INSERT INTO booking_calendars (id, user_id, name, slug, description, duration, buffer_time, timezone, location_type, location_url, forward_email, custom_questions, availability, accent_color, logo_url, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from_name, smtp_from_email, smtp_secure)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.userId, name, slug,
       description || '', duration || 30, buffer_time || 0, timezone || 'UTC',
       location_type || 'custom', location_url || '', forward_email || '',
       JSON.stringify(custom_questions || []),
       JSON.stringify(availability || DEFAULT_AVAILABILITY),
       accent_color || '#1d4ed8',
       logo_url || '', smtp_host || '', smtp_port || 587, smtp_user || '', smtp_pass || '',
       smtp_from_name || '', smtp_from_email || '', smtp_secure ? 1 : 0]
    );

    const cal = await dbGet('SELECT * FROM booking_calendars WHERE id=?', [id]);
    res.json({ ...cal, custom_questions: safeJson(cal.custom_questions, []), availability: safeJson(cal.availability, DEFAULT_AVAILABILITY), booking_count: 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Update calendar ───────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const cal = await dbGet('SELECT id FROM booking_calendars WHERE id=? AND user_id=?', [req.params.id, req.userId]);
    if (!cal) return res.status(404).json({ error: 'Not found' });

    const { name, description, duration, buffer_time, timezone, location_type, location_url, forward_email,
            custom_questions, availability, accent_color, is_active,
            logo_url, smtp_host, smtp_port, smtp_user, smtp_pass, smtp_from_name, smtp_from_email, smtp_secure } = req.body;

    await dbRun(
      `UPDATE booking_calendars SET name=?, description=?, duration=?, buffer_time=?, timezone=?, location_type=?, location_url=?, forward_email=?, custom_questions=?, availability=?, accent_color=?, is_active=?, logo_url=?, smtp_host=?, smtp_port=?, smtp_user=?, smtp_pass=?, smtp_from_name=?, smtp_from_email=?, smtp_secure=? WHERE id=?`,
      [name, description || '', duration || 30, buffer_time || 0, timezone || 'UTC',
       location_type || 'custom', location_url || '', forward_email || '',
       JSON.stringify(custom_questions || []),
       JSON.stringify(availability || DEFAULT_AVAILABILITY),
       accent_color || '#1d4ed8',
       is_active !== undefined ? (is_active ? 1 : 0) : 1,
       logo_url || '', smtp_host || '', smtp_port || 587, smtp_user || '', smtp_pass || '',
       smtp_from_name || '', smtp_from_email || '', smtp_secure ? 1 : 0,
       req.params.id]
    );

    const updated = await dbGet('SELECT * FROM booking_calendars WHERE id=?', [req.params.id]);
    const bookingCount = await dbGet("SELECT COUNT(*) as c FROM bookings WHERE calendar_id=? AND status='confirmed'", [req.params.id]);
    res.json({ ...updated, custom_questions: safeJson(updated.custom_questions, []), availability: safeJson(updated.availability, DEFAULT_AVAILABILITY), booking_count: bookingCount?.c || 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Delete calendar ───────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const cal = await dbGet('SELECT id FROM booking_calendars WHERE id=? AND user_id=?', [req.params.id, req.userId]);
    if (!cal) return res.status(404).json({ error: 'Not found' });
    await dbRun('DELETE FROM bookings WHERE calendar_id=?', [req.params.id]);
    await dbRun('DELETE FROM booking_calendars WHERE id=?', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
