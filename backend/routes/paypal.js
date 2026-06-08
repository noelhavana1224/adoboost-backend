/**
 * Billing — PayPal Subscriptions integration
 * ─────────────────────────────────────────────────────────────────────────────
 * AdoBoost acts as its OWN merchant of record via PayPal (works for PH sellers,
 * supports recurring subscriptions, accepts cards + PayPal balance worldwide).
 *
 * ACTIVATION (set these on the server in DATA_DIR/.env-style secrets, then restart):
 *   PAYPAL_ENV            "live" (default) or "sandbox"
 *   PAYPAL_CLIENT_ID      REST app client id  (PayPal Dashboard → Apps & Credentials)
 *   PAYPAL_SECRET         REST app secret
 *   PAYPAL_WEBHOOK_ID     id of the webhook you create (for signature verification)
 *   PAYPAL_PLAN_STARTER   billing plan id for Starter  (P-xxxxxxxx)
 *   PAYPAL_PLAN_PRO       billing plan id for Professional
 *   PAYPAL_PLAN_AGENCY    billing plan id for Agency
 *
 * In the PayPal dashboard (business account):
 *   1. Create a Product, then 3 monthly subscription Plans (Starter/Pro/Agency).
 *   2. Apps & Credentials → create a REST app → copy client id + secret.
 *   3. Add a webhook → URL https://api.adobosolutions.com/api/paypal/webhook
 *      subscribe to: BILLING.SUBSCRIPTION.ACTIVATED, BILLING.SUBSCRIPTION.CANCELLED,
 *      BILLING.SUBSCRIPTION.EXPIRED, BILLING.SUBSCRIPTION.SUSPENDED,
 *      PAYMENT.SALE.COMPLETED  → copy the Webhook ID.
 */

const express = require('express');
const { dbGet, dbRun } = require('../models/db');
const { v4: uuidv4 } = require('uuid');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const API_BASE = () => (process.env.PAYPAL_ENV === 'sandbox')
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

// Map every PayPal plan id (monthly OR annual) → our plan slug.
const PLAN_BY_PAYPAL = () => {
  const out = {};
  const add = (id, slug) => { if (id) out[id] = slug; };
  add(process.env.PAYPAL_PLAN_STARTER,        'starter');
  add(process.env.PAYPAL_PLAN_PRO,            'professional');
  add(process.env.PAYPAL_PLAN_AGENCY,         'unlimited');
  add(process.env.PAYPAL_PLAN_STARTER_ANNUAL, 'starter');
  add(process.env.PAYPAL_PLAN_PRO_ANNUAL,     'professional');
  add(process.env.PAYPAL_PLAN_AGENCY_ANNUAL,  'unlimited');
  return out;
};
const PAYPAL_BY_PLAN = () => ({
  starter:      process.env.PAYPAL_PLAN_STARTER,
  professional: process.env.PAYPAL_PLAN_PRO,
  unlimited:    process.env.PAYPAL_PLAN_AGENCY,
});
const PAYPAL_BY_PLAN_ANNUAL = () => ({
  starter:      process.env.PAYPAL_PLAN_STARTER_ANNUAL,
  professional: process.env.PAYPAL_PLAN_PRO_ANNUAL,
  unlimited:    process.env.PAYPAL_PLAN_AGENCY_ANNUAL,
});

function isConfigured() {
  return !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET && process.env.PAYPAL_PLAN_STARTER);
}

// ── PayPal REST helpers ──────────────────────────────────────────────────────
async function getAccessToken() {
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString('base64');
  const r = await fetch(`${API_BASE()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error('PayPal auth failed: ' + r.status);
  return (await r.json()).access_token;
}

async function getSubscription(subId, token) {
  const t = token || await getAccessToken();
  const r = await fetch(`${API_BASE()}/v1/billing/subscriptions/${subId}`, {
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
  });
  if (!r.ok) throw new Error('PayPal get subscription failed: ' + r.status);
  return r.json();
}

// Apply a confirmed PayPal subscription to a user (single source of truth).
async function applySubscription(sub) {
  const status   = sub.status; // ACTIVE, APPROVAL_PENDING, SUSPENDED, CANCELLED, EXPIRED
  const planId   = sub.plan_id;
  const userId   = sub.custom_id; // we set this to the AdoBoost user id at create time
  const plan     = PLAN_BY_PAYPAL()[planId];
  if (!userId || !plan) { console.warn('[paypal] sub missing user/plan map', sub.id); return; }

  if (status === 'ACTIVE') {
    const expires = sub.billing_info?.next_billing_time || new Date(Date.now() + 31 * 86400 * 1000).toISOString();
    await dbRun('UPDATE users SET plan=?, plan_expires_at=?, paypal_subscription_id=? WHERE id=?',
      [plan, expires, sub.id, userId]);
    const planRow = await dbGet('SELECT id FROM plans WHERE LOWER(name)=LOWER(?)', [plan]);
    if (planRow) {
      await dbRun('INSERT INTO subscriptions (id,user_id,plan_id,status,expires_at,payment_method,amount_paid,notes) VALUES (?,?,?,?,?,?,?,?)',
        [uuidv4(), userId, planRow.id, status, expires, 'paypal', 0, `PayPal ${sub.id}`]);
    }
    // In-app confirmation
    try {
      const { createNotification } = require('../services/notify');
      createNotification(userId, 'feature', { title: '🎉 Subscription active', body: `Your ${plan} plan is now active. Thanks for upgrading!`, link: '/settings/billing', icon: 'megaphone' });
    } catch {}
    console.log(`💳 PayPal ${plan} ACTIVE for user ${userId}`);
  } else if (['CANCELLED', 'EXPIRED', 'SUSPENDED'].includes(status)) {
    await dbRun(`UPDATE users SET plan='trial' WHERE id=? AND paypal_subscription_id=?`, [userId, sub.id]);
    console.log(`💳 PayPal sub ${status} → user ${userId} downgraded to trial`);
  }
}

// ── Frontend config: client id + plan ids (safe to expose) + current state ──
router.get('/config', authMiddleware, async (req, res) => {
  const annual = PAYPAL_BY_PLAN_ANNUAL();
  const annualAvailable = !!(annual.starter || annual.professional || annual.unlimited);
  res.json({
    configured:      isConfigured(),
    client_id:       process.env.PAYPAL_CLIENT_ID || null,
    env:             process.env.PAYPAL_ENV === 'sandbox' ? 'sandbox' : 'live',
    plans:           PAYPAL_BY_PLAN(),
    plans_annual:    annual,
    annual_available: annualAvailable,
  });
});

// ── Activate immediately after the buyer approves (don't wait for webhook) ──
router.post('/activate', authMiddleware, express.json(), async (req, res) => {
  try {
    if (!isConfigured()) return res.status(503).json({ error: 'Billing not configured' });
    const { subscription_id } = req.body;
    if (!subscription_id) return res.status(400).json({ error: 'subscription_id required' });
    const sub = await getSubscription(subscription_id);
    // Security: only honor if this subscription's custom_id matches the caller
    if (sub.custom_id && sub.custom_id !== req.userId) {
      return res.status(403).json({ error: 'Subscription does not belong to this account' });
    }
    if (!sub.custom_id) sub.custom_id = req.userId; // fallback
    await applySubscription(sub);
    res.json({ success: true, status: sub.status });
  } catch (e) { console.error('[paypal] activate:', e.message); res.status(500).json({ error: e.message }); }
});

// ── Cancel the active subscription ──────────────────────────────────────────
router.post('/cancel', authMiddleware, express.json(), async (req, res) => {
  try {
    const u = await dbGet('SELECT paypal_subscription_id FROM users WHERE id=?', [req.userId]);
    if (!u?.paypal_subscription_id) return res.status(400).json({ error: 'No active PayPal subscription' });
    const token = await getAccessToken();
    const r = await fetch(`${API_BASE()}/v1/billing/subscriptions/${u.paypal_subscription_id}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Customer requested cancellation' }),
    });
    if (!r.ok && r.status !== 204) return res.status(502).json({ error: 'PayPal cancel failed' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Webhook — verify with PayPal, then refetch the subscription as source of truth ──
router.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    if (!isConfigured()) return res.status(503).send('not configured');
    const event = JSON.parse(req.body.toString('utf8'));

    // Verify authenticity via PayPal's verify-webhook-signature endpoint
    if (process.env.PAYPAL_WEBHOOK_ID) {
      const token = await getAccessToken();
      const verifyRes = await fetch(`${API_BASE()}/v1/notifications/verify-webhook-signature`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auth_algo:         req.get('paypal-auth-algo'),
          cert_url:          req.get('paypal-cert-url'),
          transmission_id:   req.get('paypal-transmission-id'),
          transmission_sig:  req.get('paypal-transmission-sig'),
          transmission_time: req.get('paypal-transmission-time'),
          webhook_id:        process.env.PAYPAL_WEBHOOK_ID,
          webhook_event:     event,
        }),
      });
      const v = await verifyRes.json();
      if (v.verification_status !== 'SUCCESS') {
        console.warn('[paypal] webhook verification failed');
        return res.status(401).send('invalid');
      }
    }

    const type = event.event_type;
    const resource = event.resource || {};
    // Subscription lifecycle → refetch the canonical subscription and apply
    if (type && type.startsWith('BILLING.SUBSCRIPTION.')) {
      const subId = resource.id;
      if (subId) { try { await applySubscription(await getSubscription(subId)); } catch (e) { console.error('[paypal] apply:', e.message); } }
    } else if (type === 'PAYMENT.SALE.COMPLETED' && resource.billing_agreement_id) {
      try { await applySubscription(await getSubscription(resource.billing_agreement_id)); } catch {}
    }
    res.send('ok');
  } catch (e) {
    console.error('[paypal] webhook error:', e.message);
    res.status(500).send('error');
  }
});

module.exports = router;
