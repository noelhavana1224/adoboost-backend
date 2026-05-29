const nodemailer = require('nodemailer');

// ── System mailer (noreply@adobosolutions.com) ───
// Hardcoded fallbacks so emails work even if .env is wiped by Hostinger
const SYSTEM_SMTP = {
  host: process.env.SYSTEM_SMTP_HOST || 'smtp.hostinger.com',
  port: parseInt(process.env.SYSTEM_SMTP_PORT || '465'),
  user: process.env.SYSTEM_SMTP_USER || 'noreply@adobosolutions.com',
  // IMPORTANT: Update this password if you change noreply@adobosolutions.com password
  pass: process.env.SYSTEM_SMTP_PASS,
};

function createSystemMailer() {
  return nodemailer.createTransport({
    host: SYSTEM_SMTP.host,
    port: SYSTEM_SMTP.port,
    secure: true,
    auth: {
      user: SYSTEM_SMTP.user,
      pass: SYSTEM_SMTP.pass,
    },
    tls: { rejectUnauthorized: false },
  });
}

const BASE_URL = () => process.env.FRONTEND_URL || 'https://app.adobosolutions.com';
const FROM     = '"AdoBoost" <noreply@adobosolutions.com>';

// ── Email templates ──────────────────────────────
function welcomeEmail(name, email) {
  return {
    from: FROM,
    to: email,
    subject: '🚀 Welcome to AdoBoost!',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#f8fafc;padding:32px 20px">
        <div style="background:#0D47A1;borderRadius:12px;padding:28px;text-align:center;margin-bottom:24px">
          <div style="font-family:Georgia,serif;font-size:28px;font-weight:800;color:#fff">ado<span style="color:#FCD116">boost</span></div>
          <div style="font-size:11px;color:rgba(255,255,255,0.6);letter-spacing:3px;margin-top:4px">BY ADOBO SOLUTIONS</div>
        </div>
        <div style="background:#fff;border-radius:12px;padding:28px;border:1px solid #e2e8f0">
          <h2 style="color:#1a202c;font-size:22px;margin:0 0 12px">Welcome, ${name}! 👋</h2>
          <p style="color:#4a5568;line-height:1.7;margin:0 0 16px">Your AdoBoost account is ready. Start sending cold email campaigns, track replies, and grow your pipeline.</p>
          <a href="${BASE_URL()}/dashboard" style="display:inline-block;background:#0D47A1;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;margin:8px 0 20px">
            🚀 Go to Dashboard
          </a>
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0"/>
          <p style="color:#718096;font-size:13px;margin:0">
            Logged in as: <strong>${email}</strong><br/>
            Need help? Reply to this email or visit <a href="${BASE_URL()}/support/ticket" style="color:#0D47A1">Support</a>.
          </p>
        </div>
        <p style="text-align:center;font-size:11px;color:#a0aec0;margin-top:20px">AdoBoost by Adobo Solutions · <a href="${BASE_URL()}" style="color:#a0aec0">adobosolutions.com</a></p>
      </div>
    `,
  };
}

function resetPasswordEmail(name, email, token) {
  const resetUrl = `${BASE_URL()}/reset-password?token=${token}`;
  return {
    from: FROM,
    to: email,
    subject: '🔑 Reset Your AdoBoost Password',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#f8fafc;padding:32px 20px">
        <div style="background:#0D47A1;border-radius:12px;padding:28px;text-align:center;margin-bottom:24px">
          <div style="font-family:Georgia,serif;font-size:28px;font-weight:800;color:#fff">ado<span style="color:#FCD116">boost</span></div>
        </div>
        <div style="background:#fff;border-radius:12px;padding:28px;border:1px solid #e2e8f0">
          <h2 style="color:#1a202c;font-size:22px;margin:0 0 12px">Password Reset Request 🔑</h2>
          <p style="color:#4a5568;line-height:1.7;margin:0 0 16px">Hi ${name}, we received a request to reset your password. Click the button below to set a new one.</p>
          <a href="${resetUrl}" style="display:inline-block;background:#dc2626;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;margin:8px 0 20px">
            🔑 Reset My Password
          </a>
          <div style="background:#fef3c7;border-radius:8px;padding:12px 16px;margin:16px 0;border:1px solid #fcd34d">
            <p style="color:#92400e;font-size:13px;margin:0">⚠️ This link expires in <strong>1 hour</strong>. If you didn't request this, you can safely ignore this email.</p>
          </div>
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0"/>
          <p style="color:#718096;font-size:12px;margin:0">Or copy this link:<br/><span style="color:#0D47A1;word-break:break-all">${resetUrl}</span></p>
        </div>
        <p style="text-align:center;font-size:11px;color:#a0aec0;margin-top:20px">AdoBoost by Adobo Solutions</p>
      </div>
    `,
  };
}

function teamInviteEmail(inviterName, memberName, email, password, isAdmin = false) {
  return {
    from: FROM,
    to: email,
    subject: `🎉 You've been invited to AdoBoost${isAdmin ? ' (Admin Access)' : ''}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#f8fafc;padding:32px 20px">
        <div style="background:#0D47A1;border-radius:12px;padding:28px;text-align:center;margin-bottom:24px">
          <div style="font-family:Georgia,serif;font-size:28px;font-weight:800;color:#fff">ado<span style="color:#FCD116">boost</span></div>
        </div>
        <div style="background:#fff;border-radius:12px;padding:28px;border:1px solid #e2e8f0">
          <h2 style="color:#1a202c;font-size:22px;margin:0 0 12px">You're Invited! 🎉</h2>
          <p style="color:#4a5568;line-height:1.7;margin:0 0 16px">
            <strong>${inviterName}</strong> has invited you to join <strong>AdoBoost</strong>${isAdmin ? ' as an Admin' : ' as a Team Member'}.
          </p>
          <div style="background:#f0fff4;border:1px solid #86efac;border-radius:8px;padding:16px;margin:16px 0">
            <p style="color:#166534;font-size:13px;margin:0 0 8px;font-weight:700">🔐 Your Login Credentials:</p>
            <p style="color:#166534;font-size:13px;margin:0">Email: <strong>${email}</strong></p>
            <p style="color:#166534;font-size:13px;margin:4px 0 0">Temporary Password: <strong>${password}</strong></p>
          </div>
          <a href="${BASE_URL()}/login" style="display:inline-block;background:#0D47A1;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;margin:8px 0 20px">
            🚀 Log In Now
          </a>
          <div style="background:#fef3c7;border-radius:8px;padding:12px 16px;margin:16px 0;border:1px solid #fcd34d">
            <p style="color:#92400e;font-size:13px;margin:0">⚠️ Please change your password after first login in <strong>Settings → User Settings</strong>.</p>
          </div>
        </div>
        <p style="text-align:center;font-size:11px;color:#a0aec0;margin-top:20px">AdoBoost by Adobo Solutions</p>
      </div>
    `,
  };
}

// ── Admin new-user alert ─────────────────────────
function newUserAlertEmail(name, email, plan, totalUsers) {
  const now = new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila', dateStyle: 'full', timeStyle: 'short' });
  return {
    from: FROM,
    to: 'noel@adobosolutions.com',
    subject: `🎉 New AdoBoost signup — ${name}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#f8fafc;padding:32px 20px">
        <div style="background:#0D47A1;border-radius:12px;padding:28px;text-align:center;margin-bottom:24px">
          <div style="font-family:Georgia,serif;font-size:28px;font-weight:800;color:#fff">ado<span style="color:#FCD116">boost</span></div>
          <div style="font-size:11px;color:rgba(255,255,255,0.6);letter-spacing:3px;margin-top:4px">BY ADOBO SOLUTIONS</div>
        </div>
        <div style="background:#fff;border-radius:12px;padding:28px;border:1px solid #e2e8f0">
          <h2 style="color:#1a202c;font-size:22px;margin:0 0 16px">🎉 New user just signed up!</h2>
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr style="border-bottom:1px solid #f1f5f9">
              <td style="padding:10px 0;color:#64748b;width:130px">Name</td>
              <td style="padding:10px 0;font-weight:700;color:#0f172a">${name}</td>
            </tr>
            <tr style="border-bottom:1px solid #f1f5f9">
              <td style="padding:10px 0;color:#64748b">Email</td>
              <td style="padding:10px 0;font-weight:700;color:#2563eb"><a href="mailto:${email}" style="color:#2563eb;text-decoration:none">${email}</a></td>
            </tr>
            <tr style="border-bottom:1px solid #f1f5f9">
              <td style="padding:10px 0;color:#64748b">Plan</td>
              <td style="padding:10px 0"><span style="background:#f0fdf4;color:#16a34a;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:700;border:1px solid #86efac">${plan.toUpperCase()}</span></td>
            </tr>
            <tr style="border-bottom:1px solid #f1f5f9">
              <td style="padding:10px 0;color:#64748b">Signed up</td>
              <td style="padding:10px 0;color:#0f172a">${now} (Manila)</td>
            </tr>
            <tr>
              <td style="padding:10px 0;color:#64748b">Total users</td>
              <td style="padding:10px 0;font-weight:700;color:#0f172a">${totalUsers}</td>
            </tr>
          </table>
          <div style="margin-top:24px">
            <a href="https://app.adobosolutions.com/admin/users" style="display:inline-block;background:#0D47A1;color:#fff;padding:11px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px">
              View in Admin Panel →
            </a>
          </div>
        </div>
        <p style="text-align:center;font-size:11px;color:#a0aec0;margin-top:20px">AdoBoost Admin Alerts · <a href="${BASE_URL()}/admin" style="color:#a0aec0">Admin Panel</a></p>
      </div>
    `,
  };
}

// ── Send helpers ─────────────────────────────────

async function sendSystemEmail({ to, subject, html, text }) {
  try {
    const mailer = createSystemMailer();
    await mailer.sendMail({ from: FROM, to, subject, html, text });
    console.log(`✅ System email sent to ${to}`);
  } catch (e) {
    console.error(`❌ System email failed to ${to}:`, e.message);
    throw e;
  }
}
async function sendWelcomeEmail(name, email) {
  try {
    const mailer = createSystemMailer();
    await mailer.sendMail(welcomeEmail(name, email));
    console.log(`✅ Welcome email sent to ${email}`);
  } catch (e) { console.error(`❌ Welcome email failed:`, e.message); }
}

async function sendResetEmail(name, email, token) {
  try {
    const mailer = createSystemMailer();
    await mailer.sendMail(resetPasswordEmail(name, email, token));
    console.log(`✅ Reset email sent to ${email}`);
  } catch (e) { console.error(`❌ Reset email failed:`, e.message); throw e; }
}

async function sendTeamInviteEmail(inviterName, memberName, email, password, isAdmin = false) {
  try {
    const mailer = createSystemMailer();
    await mailer.sendMail(teamInviteEmail(inviterName, memberName, email, password, isAdmin));
    console.log(`✅ Invite email sent to ${email}`);
  } catch (e) { console.error(`❌ Invite email failed:`, e.message); }
}

async function sendNewUserAlert(name, email, plan, totalUsers) {
  try {
    const mailer = createSystemMailer();
    await mailer.sendMail(newUserAlertEmail(name, email, plan, totalUsers));
    console.log(`✅ New-user alert sent to noel@adobosolutions.com (${email} just signed up)`);
  } catch (e) { console.error(`❌ New-user alert failed:`, e.message); }
}

// ── iCal generator ──────────────────────────────────────────────────────────
function generateICS({ id, summary, description, location, startDT, endDT, organizerName, organizerEmail, attendeeName, attendeeEmail }) {
  const esc = (s) => String(s || '').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
  // '2026-05-29T14:00:00' → '20260529T140000'
  const fmtDt = (dt) => (dt || '').replace(/[-:]/g, '').substring(0, 15);
  const now = fmtDt(new Date().toISOString().replace(/\.\d{3}/, '').replace('Z', '')) + 'Z';

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AdoBoost//Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:booking-${id}@adoboost.com`,
    `DTSTAMP:${now}`,
    `DTSTART:${fmtDt(startDT)}`,
    `DTEND:${fmtDt(endDT)}`,
    `SUMMARY:${esc(summary)}`,
    `DESCRIPTION:${esc(description)}`,
    location ? `LOCATION:${esc(location)}` : null,
    `ORGANIZER;CN="${esc(organizerName)}":mailto:${organizerEmail || 'noreply@adobosolutions.com'}`,
    `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN="${esc(attendeeName)}":mailto:${attendeeEmail}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
}

// ── Booking confirmation — sent to the person who booked ─────────────────
async function sendBookingConfirmation(bookerName, bookerEmail, calendarName, hostName, startDT, endDT, timezone, meetingLink, locationType, bookingId) {
  try {
    const mailer = createSystemMailer();
    const fmtTime = (dt) => {
      try { return new Date(dt).toLocaleString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:true }); }
      catch { return dt; }
    };

    const locationHTML = meetingLink
      ? `<a href="${meetingLink}" style="color:#0D47A1;font-weight:600">${locationType === 'zoom' ? '🎥 Join Zoom' : locationType === 'teams' ? '💼 Join Teams' : locationType === 'meet' ? '🟢 Join Google Meet' : '🔗 Join Meeting'}</a>`
      : `<span style="color:#718096">Will be sent separately</span>`;

    const icsContent = generateICS({
      id: bookingId || Date.now().toString(),
      summary: `Meeting: ${calendarName}`,
      description: `Your meeting with ${hostName} is confirmed.\nDate: ${fmtTime(startDT)}\nTimezone: ${timezone}`,
      location: meetingLink || '',
      startDT, endDT,
      organizerName: hostName,
      organizerEmail: 'noreply@adobosolutions.com',
      attendeeName: bookerName,
      attendeeEmail: bookerEmail,
    });

    await mailer.sendMail({
      from: FROM,
      to: bookerEmail,
      subject: `✅ Meeting confirmed: ${calendarName}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#f8fafc;padding:32px 20px">
          <div style="background:#0D47A1;border-radius:12px;padding:28px;text-align:center;margin-bottom:24px">
            <div style="font-family:Georgia,serif;font-size:28px;font-weight:800;color:#fff">ado<span style="color:#FCD116">boost</span></div>
            <div style="font-size:11px;color:rgba(255,255,255,0.6);letter-spacing:3px;margin-top:4px">BOOKING CONFIRMED</div>
          </div>
          <div style="background:#fff;border-radius:12px;padding:28px;border:1px solid #e2e8f0">
            <div style="text-align:center;margin-bottom:20px">
              <div style="font-size:48px">✅</div>
              <h2 style="color:#1a202c;font-size:22px;margin:8px 0 4px">You're booked!</h2>
              <p style="color:#718096;margin:0">${calendarName} with ${hostName}</p>
            </div>
            <div style="background:#f0f9ff;border-radius:10px;padding:20px;margin:20px 0;border-left:4px solid #0D47A1">
              <table style="width:100%;border-collapse:collapse">
                <tr><td style="color:#718096;font-size:13px;padding:4px 0">📅 Date &amp; Time</td><td style="font-weight:600;font-size:13px;text-align:right">${fmtTime(startDT)}</td></tr>
                <tr><td style="color:#718096;font-size:13px;padding:4px 0">🕐 Timezone</td><td style="font-weight:600;font-size:13px;text-align:right">${timezone}</td></tr>
                <tr><td style="color:#718096;font-size:13px;padding:4px 0">🔗 Meeting Link</td><td style="font-size:13px;text-align:right">${locationHTML}</td></tr>
              </table>
            </div>
            <p style="color:#4a5568;font-size:13px;line-height:1.6;margin:0">A calendar invite is attached to this email. Add it to your calendar to get a reminder.</p>
          </div>
          <p style="text-align:center;font-size:11px;color:#a0aec0;margin-top:20px">Powered by AdoBoost · <a href="${BASE_URL()}" style="color:#a0aec0">adobosolutions.com</a></p>
        </div>
      `,
      attachments: [{
        filename: 'meeting.ics',
        content: icsContent,
        contentType: 'text/calendar; charset=utf-8; method=REQUEST',
      }],
    });
    console.log(`✅ Booking confirmation sent to ${bookerEmail}`);
  } catch (e) { console.error(`❌ Booking confirmation failed:`, e.message); throw e; }
}

// ── Booking alert — sent to the host's forward email ─────────────────────
async function sendBookingAlert(forwardEmail, hostName, bookerName, bookerEmail, bookerPhone, calendarName, startDT, endDT, timezone, meetingLink, locationType, answers, customQuestions, bookingId) {
  try {
    const mailer = createSystemMailer();
    const fmtTime = (dt) => {
      try { return new Date(dt).toLocaleString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:true }); }
      catch { return dt; }
    };

    const answersHTML = customQuestions.length > 0
      ? customQuestions.map(q => {
          const ans = answers[q.id] || answers[q.label] || '—';
          return `<tr><td style="color:#718096;font-size:13px;padding:4px 0">${q.label}</td><td style="font-weight:600;font-size:13px;text-align:right">${ans}</td></tr>`;
        }).join('')
      : '';

    const icsContent = generateICS({
      id: bookingId || Date.now().toString(),
      summary: `Meeting: ${bookerName} × ${calendarName}`,
      description: `${bookerName} (${bookerEmail}${bookerPhone ? ', ' + bookerPhone : ''}) booked ${calendarName}`,
      location: meetingLink || '',
      startDT, endDT,
      organizerName: hostName,
      organizerEmail: forwardEmail,
      attendeeName: bookerName,
      attendeeEmail: bookerEmail,
    });

    await mailer.sendMail({
      from: FROM,
      to: forwardEmail,
      subject: `📅 New booking: ${bookerName} booked "${calendarName}"`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#f8fafc;padding:32px 20px">
          <div style="background:#0D47A1;border-radius:12px;padding:28px;text-align:center;margin-bottom:24px">
            <div style="font-family:Georgia,serif;font-size:28px;font-weight:800;color:#fff">ado<span style="color:#FCD116">boost</span></div>
            <div style="font-size:11px;color:rgba(255,255,255,0.6);letter-spacing:3px;margin-top:4px">NEW BOOKING</div>
          </div>
          <div style="background:#fff;border-radius:12px;padding:28px;border:1px solid #e2e8f0">
            <h2 style="color:#1a202c;font-size:20px;margin:0 0 4px">📅 New meeting booked!</h2>
            <p style="color:#718096;margin:0 0 20px">${bookerName} just booked <strong>${calendarName}</strong></p>
            <div style="background:#f8fafc;border-radius:10px;padding:20px;border:1px solid #e2e8f0;margin-bottom:16px">
              <table style="width:100%;border-collapse:collapse">
                <tr><td style="color:#718096;font-size:13px;padding:4px 0">👤 Name</td><td style="font-weight:600;font-size:13px;text-align:right">${bookerName}</td></tr>
                <tr><td style="color:#718096;font-size:13px;padding:4px 0">📧 Email</td><td style="font-size:13px;text-align:right"><a href="mailto:${bookerEmail}" style="color:#0D47A1">${bookerEmail}</a></td></tr>
                ${bookerPhone ? `<tr><td style="color:#718096;font-size:13px;padding:4px 0">📞 Phone</td><td style="font-weight:600;font-size:13px;text-align:right">${bookerPhone}</td></tr>` : ''}
                <tr><td style="color:#718096;font-size:13px;padding:4px 0">📅 Date &amp; Time</td><td style="font-weight:600;font-size:13px;text-align:right">${fmtTime(startDT)}</td></tr>
                <tr><td style="color:#718096;font-size:13px;padding:4px 0">🕐 Timezone</td><td style="font-weight:600;font-size:13px;text-align:right">${timezone}</td></tr>
                ${meetingLink ? `<tr><td style="color:#718096;font-size:13px;padding:4px 0">🔗 Meeting</td><td style="font-size:13px;text-align:right"><a href="${meetingLink}" style="color:#0D47A1">${meetingLink.substring(0,40)}${meetingLink.length>40?'…':''}</a></td></tr>` : ''}
                ${answersHTML}
              </table>
            </div>
            <a href="${BASE_URL()}/booking-calendar" style="display:inline-block;background:#0D47A1;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">
              📅 View in AdoBoost
            </a>
          </div>
          <p style="text-align:center;font-size:11px;color:#a0aec0;margin-top:20px">The .ics calendar invite is attached — accept it to add this meeting to your calendar.</p>
        </div>
      `,
      attachments: [{
        filename: 'meeting.ics',
        content: icsContent,
        contentType: 'text/calendar; charset=utf-8; method=REQUEST',
      }],
    });
    console.log(`✅ Booking alert sent to ${forwardEmail}`);
  } catch (e) { console.error(`❌ Booking alert failed:`, e.message); throw e; }
}

module.exports = { sendWelcomeEmail, sendResetEmail, sendTeamInviteEmail, sendSystemEmail, sendNewUserAlert, sendBookingConfirmation, sendBookingAlert };
