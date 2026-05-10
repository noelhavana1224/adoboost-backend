const nodemailer = require('nodemailer');

// ── System mailer (noreply@adobosolutions.com) ───
function createSystemMailer() {
  return nodemailer.createTransport({
    host: process.env.SYSTEM_SMTP_HOST || 'smtp.hostinger.com',
    port: parseInt(process.env.SYSTEM_SMTP_PORT || '465'),
    secure: true,
    auth: {
      user: process.env.SYSTEM_SMTP_USER || 'noreply@adobosolutions.com',
      pass: process.env.SYSTEM_SMTP_PASS || 'Havana1224!',
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

// ── Send helpers ─────────────────────────────────
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

module.exports = { sendWelcomeEmail, sendResetEmail, sendTeamInviteEmail };
