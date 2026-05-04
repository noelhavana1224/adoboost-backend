const nodemailer = require('nodemailer');
const Handlebars = require('handlebars');
const { dbAll, dbRun, dbGet } = require('../models/db');
const { v4: uuidv4 } = require('uuid');

const BASE_URL = () => process.env.BASE_URL || 'http://localhost:3001';

function personalize(template, contact) {
  try {
    const custom = JSON.parse(contact.custom_fields || '{}');
    const data = {
      first_name: contact.first_name || '',
      last_name: contact.last_name || '',
      full_name: [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email,
      email: contact.email,
      company: contact.company || '',
      title: contact.title || '',
      website: contact.website || '',
      ...custom,
    };
    return Handlebars.compile(template)(data);
  } catch { return template; }
}

function buildBody(html, sendId, trackClicks, trackOpens, canSpamFooter) {
  let body = html;
  if (trackClicks) {
    body = body.replace(/href="(https?:\/\/[^"]+)"/g, (_, url) =>
      `href="${BASE_URL()}/api/tracking/click/${sendId}?url=${encodeURIComponent(url)}"`);
  }
  if (canSpamFooter) {
    body += `<br><br><div style="font-size:11px;color:#999;border-top:1px solid #eee;padding-top:10px;">
      You received this email as part of a business outreach. 
      <a href="${BASE_URL()}/api/tracking/unsubscribe/${sendId}" style="color:#999;">Unsubscribe</a>
    </div>`;
  } else {
    body += `<br><br><small><a href="${BASE_URL()}/api/tracking/unsubscribe/${sendId}">Unsubscribe</a></small>`;
  }
  if (trackOpens) {
    body += `<img src="${BASE_URL()}/api/tracking/open/${sendId}" width="1" height="1" style="display:none" />`;
  }
  return body;
}

async function processPendingSends() {
  const now = new Date().toISOString();
  const pending = await dbAll(`
    SELECT s.*,
      c.email,c.first_name,c.last_name,c.company,c.title,c.website,c.custom_fields,
      seq.subject,seq.body,
      camp.track_opens,camp.track_clicks,camp.status as campaign_status,
      ea.host,ea.port,ea.secure,ea.username,ea.password as smtp_pass,
      ea.from_name,ea.from_email,ea.daily_limit as acc_limit,ea.sent_today,
      u.can_spam_footer
    FROM sends s
    JOIN contacts c ON s.contact_id=c.id
    JOIN sequences seq ON s.sequence_id=seq.id
    JOIN campaigns camp ON s.campaign_id=camp.id
    JOIN email_accounts ea ON s.email_account_id=ea.id
    JOIN users u ON camp.user_id=u.id
    WHERE s.status='pending' AND s.scheduled_at<=?
    AND camp.status='active'
    AND c.unsubscribed=0 AND c.bounced=0
    ORDER BY s.scheduled_at ASC LIMIT 50`, [now]);

  for (const send of pending) {
    if (send.sent_today >= send.acc_limit) continue;
    try {
      const subject = personalize(send.subject, send);
      const rawBody = personalize(send.body, send);
      const finalBody = buildBody(rawBody, send.id, send.track_clicks, send.track_opens, send.can_spam_footer);
      const transporter = nodemailer.createTransport({
        host: send.host, port: send.port, secure: send.secure===1,
        auth: { user: send.username, pass: send.smtp_pass },
        tls: { rejectUnauthorized: false }
      });
      const info = await transporter.sendMail({
        from: `"${send.from_name}" <${send.from_email}>`,
        to: send.email, subject, html: finalBody,
        text: rawBody.replace(/<[^>]*>/g, ''),
      });
      await dbRun(`UPDATE sends SET status='sent',sent_at=?,message_id=? WHERE id=?`, [new Date().toISOString(), info.messageId, send.id]);
      await dbRun(`UPDATE email_accounts SET sent_today=sent_today+1 WHERE id=?`, [send.email_account_id]);
    } catch (err) {
      await dbRun(`UPDATE sends SET status='failed',error_message=? WHERE id=?`, [err.message, send.id]);
    }
  }
}

async function resetDailyCounters() {
  const today = new Date().toISOString().split('T')[0];
  await dbRun(`UPDATE email_accounts SET sent_today=0,last_reset=? WHERE last_reset IS NULL OR last_reset<?`, [today, today]);
}

module.exports = { processPendingSends, resetDailyCounters };
