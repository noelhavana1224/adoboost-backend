const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../models/db');

const router = express.Router();

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
  try { return typeof str === 'string' ? JSON.parse(str) : (str || fallback); } catch { return fallback; }
}

function generateSlots(availability, date, duration, buffer = 0) {
  try {
    const avail = safeJson(availability, DEFAULT_AVAILABILITY);
    const d = new Date(date + 'T12:00:00');
    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const dow = days[d.getDay()];
    const dayAvail = avail[dow];
    if (!dayAvail || !dayAvail.enabled) return [];

    const [sh, sm] = dayAvail.start.split(':').map(Number);
    const [eh, em] = dayAvail.end.split(':').map(Number);
    let cur = sh * 60 + sm;
    const endMin = eh * 60 + em;
    const slots = [];
    while (cur + duration <= endMin) {
      const h = Math.floor(cur / 60);
      const m = cur % 60;
      slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
      cur += duration + buffer;
    }
    return slots;
  } catch { return []; }
}

// ── GET /api/public/book/:slug — calendar info + available slots ──────────
router.get('/book/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const { date } = req.query; // YYYY-MM-DD

    const cal = await dbGet("SELECT * FROM booking_calendars WHERE slug=? AND is_active=1", [slug]);
    if (!cal) return res.status(404).json({ error: 'Booking page not found' });

    const host = await dbGet('SELECT name FROM users WHERE id=?', [cal.user_id]);

    const response = {
      id: cal.id,
      name: cal.name,
      description: cal.description || '',
      duration: cal.duration,
      timezone: cal.timezone,
      location_type: cal.location_type,
      custom_questions: safeJson(cal.custom_questions, []),
      availability: safeJson(cal.availability, DEFAULT_AVAILABILITY),
      accent_color: cal.accent_color || '#1d4ed8',
      host_name: host?.name || '',
    };

    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const allSlots = generateSlots(cal.availability, date, cal.duration, cal.buffer_time);
      const booked = await dbAll(
        "SELECT start_time FROM bookings WHERE calendar_id=? AND status='confirmed' AND start_time LIKE ?",
        [cal.id, `${date}T%`]
      );
      const bookedSet = new Set(booked.map(b => b.start_time.substring(11, 16)));
      response.slots = allSlots.filter(s => !bookedSet.has(s));
      response.date = date;
    }

    res.json(response);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/public/book/:slug — create a booking ───────────────────────
router.post('/book/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const { name, email, phone, date, time, timezone, answers, notes } = req.body;

    if (!name || !email || !date || !time) {
      return res.status(400).json({ error: 'Name, email, date and time are required' });
    }

    const cal = await dbGet("SELECT * FROM booking_calendars WHERE slug=? AND is_active=1", [slug]);
    if (!cal) return res.status(404).json({ error: 'Booking page not found' });

    // Race-condition guard — check slot still free
    const existing = await dbGet(
      "SELECT id FROM bookings WHERE calendar_id=? AND status='confirmed' AND start_time LIKE ?",
      [cal.id, `${date}T${time}%`]
    );
    if (existing) return res.status(409).json({ error: 'This slot was just taken. Please pick another time.' });

    // Calculate end time
    const [h, m] = time.split(':').map(Number);
    const totalMin = h * 60 + m + Number(cal.duration);
    const endH = Math.floor(totalMin / 60) % 24;
    const endM = totalMin % 60;
    const startDT = `${date}T${time}:00`;
    const endDT   = `${date}T${String(endH).padStart(2,'0')}:${String(endM).padStart(2,'0')}:00`;

    // Match existing contact
    const contact = await dbGet(
      'SELECT id FROM contacts WHERE user_id=? AND LOWER(email)=? LIMIT 1',
      [cal.user_id, email.toLowerCase().trim()]
    );

    const id = uuidv4();
    await dbRun(
      `INSERT INTO bookings (id, calendar_id, user_id, contact_id, booker_name, booker_email, booker_phone, start_time, end_time, timezone, custom_answers, notes, meeting_link)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, cal.id, cal.user_id, contact?.id || null,
       name.trim(), email.trim().toLowerCase(), (phone || '').trim(),
       startDT, endDT, timezone || cal.timezone,
       JSON.stringify(answers || {}), (notes || '').trim(), cal.location_url || '']
    );

    // Non-blocking email notifications
    setImmediate(async () => {
      try {
        const { sendBookingConfirmation, sendBookingAlert } = require('../services/emailSystem');
        const nodemailer = require('nodemailer');
        const hostUser = await dbGet('SELECT name FROM users WHERE id=?', [cal.user_id]);

        // Build custom mailer if client configured their own SMTP
        let customMailer = null;
        let fromName  = '';
        let fromEmail = '';
        if (cal.smtp_host && cal.smtp_user && cal.smtp_pass) {
          try {
            customMailer = nodemailer.createTransport({
              host: cal.smtp_host,
              port: cal.smtp_port || 587,
              secure: !!cal.smtp_secure,
              auth: { user: cal.smtp_user, pass: cal.smtp_pass },
              tls: { rejectUnauthorized: false },
            });
            fromName  = cal.smtp_from_name  || hostUser?.name || '';
            fromEmail = cal.smtp_from_email || cal.smtp_user;
          } catch (e) {
            console.error('[booking] Custom SMTP setup failed:', e.message);
            customMailer = null;
          }
        }

        const brandingOpts = {
          customMailer,
          fromName:  fromName  || hostUser?.name || '',
          fromEmail: fromEmail || '',
          logoUrl:   cal.logo_url || '',
        };

        await sendBookingConfirmation(
          name, email, cal.name, hostUser?.name || '',
          startDT, endDT, cal.timezone || 'UTC', cal.location_url, cal.location_type, id, brandingOpts
        ).catch(() => {});

        if (cal.forward_email) {
          await sendBookingAlert(
            cal.forward_email, hostUser?.name || '', name, email, phone,
            cal.name, startDT, endDT, cal.timezone || 'UTC',
            cal.location_url, cal.location_type,
            answers || {}, safeJson(cal.custom_questions, []), id, brandingOpts
          ).catch(() => {});
        }
      } catch (e) { console.error('[booking] notification error:', e.message); }
    });

    res.json({
      success: true,
      booking_id: id,
      start_time: startDT,
      end_time: endDT,
      duration: cal.duration,
      meeting_link: cal.location_url || '',
      location_type: cal.location_type || 'custom',
      timezone: timezone || cal.timezone,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
