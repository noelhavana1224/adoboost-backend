/**
 * Billing — Lemon Squeezy (Merchant of Record) integration
 * ─────────────────────────────────────────────────────────────────────────────
 * Why Lemon Squeezy: works for Philippines-based sellers, acts as Merchant of
 * Record (handles global VAT/sales-tax + pays you out via PayPal/Wise), and
 * accepts cards + PayPal from your overseas clients. No US entity needed.
 *
 * ACTIVATION (set these env vars on the server, then restart):
 *   LS_STORE_SUBDOMAIN   e.g. "adoboost"  (from your store URL adoboost.lemonsqueezy.com)
 *   LS_VARIANT_STARTER   variant id for the $29 Starter plan
 *   LS_VARIANT_PRO       variant id for the $79 Professional plan
 *   LS_VARIANT_UNLIMITED variant id for the $199 Unlimited plan
 *   LS_WEBHOOK_SECRET    signing secret you set when creating the webhook
 *
 * In Lemon Squeezy dashboard:
 *   1. Create a Store, then a Product with 3 monthly-subscription variants
 *   2. Settings → Webhooks → add  https://api.adobosolutions.com/api/billing/webhook
 *      subscribe to: subscription_created, subscription_updated,
 *                    subscription_cancelled, subscription_expired
 *   3. Copy each variant id + the signing secret into the env vars above
 */

const express = require('express');
const crypto = require('crypto');
const { dbGet, dbRun } = require('../models/db');
const { v4: uuidv4 } = require('uuid');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

const VARIANT_BY_PLAN = () => ({
  starter:      process.env.LS_VARIANT_STARTER,
  professional: process.env.LS_VARIANT_PRO,
  unlimited:    process.env.LS_VARIANT_UNLIMITED,
});
const PLAN_BY_VARIANT = () => {
  const m = VARIANT_BY_PLAN();
  const out = {};
  for (const [plan, vid] of Object.entries(m)) if (vid) out[String(vid)] = plan;
  return out;
};

function isConfigured() {
  return !!(process.env.LS_STORE_SUBDOMAIN && process.env.LS_VARIANT_STARTER);
}

// ── Is billing live? (frontend uses this to show/hide self-serve upgrade) ──
router.get('/status', authMiddleware, (req, res) => {
  res.json({ configured: isConfigured(), provider: 'lemonsqueezy' });
});

// ── Build a hosted checkout URL for a plan (email + user_id prefilled) ──────
router.get('/checkout/:plan', authMiddleware, async (req, res) => {
  try {
    if (!isConfigured()) {
      return res.status(503).json({ error: 'Billing is not configured yet. Please contact support to upgrade.' });
    }
    const plan = String(req.params.plan).toLowerCase();
    const variant = VARIANT_BY_PLAN()[plan];
    if (!variant) return res.status(400).json({ error: 'Unknown or unavailable plan' });

    const user = await dbGet('SELECT id,email,name FROM users WHERE id=?', [req.userId]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const store = process.env.LS_STORE_SUBDOMAIN;
    const params = new URLSearchParams();
    params.set('checkout[email]', user.email);
    if (user.name) params.set('checkout[name]', user.name);
    // custom data comes back on the webhook so we know which user paid
    params.set('checkout[custom][user_id]', user.id);
    params.set('checkout[custom][plan]', plan);

    const url = `https://${store}.lemonsqueezy.com/checkout/buy/${variant}?${params.toString()}`;
    res.json({ url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Webhook — Lemon Squeezy calls this on subscription lifecycle events ─────
// NOTE: must receive the RAW body to verify the HMAC signature, so this router
// uses express.raw() below (mounted before the global express.json()).
router.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const secret = process.env.LS_WEBHOOK_SECRET;
    if (!secret) return res.status(503).send('not configured');

    const signature = req.get('X-Signature') || '';
    const digest = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
    // timing-safe compare
    if (signature.length !== digest.length ||
        !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest))) {
      return res.status(401).send('invalid signature');
    }

    const payload = JSON.parse(req.body.toString('utf8'));
    const event   = payload?.meta?.event_name;
    const custom  = payload?.meta?.custom_data || {};
    const attrs   = payload?.data?.attributes || {};
    const userId  = custom.user_id;
    const variantId = String(attrs.variant_id || '');
    const planFromVariant = PLAN_BY_VARIANT()[variantId];
    const plan = custom.plan || planFromVariant || 'starter';

    if (!userId) { console.warn('[billing] webhook missing user_id'); return res.send('ok'); }

    if (event === 'subscription_created' || event === 'subscription_updated') {
      // Active subscription → set the user's plan, expiry = renews_at (or +1 month)
      const status = attrs.status; // active, on_trial, past_due, cancelled, expired...
      if (['active', 'on_trial', 'past_due'].includes(status)) {
        const expires = attrs.renews_at || new Date(Date.now() + 31 * 86400 * 1000).toISOString();
        await dbRun('UPDATE users SET plan=?, plan_expires_at=? WHERE id=?', [plan, expires, userId]);
        const planRow = await dbGet('SELECT id FROM plans WHERE LOWER(name)=LOWER(?)', [plan]);
        if (planRow) {
          await dbRun('INSERT INTO subscriptions (id,user_id,plan_id,status,expires_at,payment_method,amount_paid,notes) VALUES (?,?,?,?,?,?,?,?)',
            [uuidv4(), userId, planRow.id, status, expires, 'lemonsqueezy', 0, `LS ${event}`]);
        }
        console.log(`💳 ${plan} activated for user ${userId} (${status})`);
      } else if (['cancelled', 'expired', 'unpaid'].includes(status)) {
        await dbRun(`UPDATE users SET plan='trial' WHERE id=?`, [userId]);
        console.log(`💳 Subscription ${status} → user ${userId} downgraded to trial`);
      }
    } else if (event === 'subscription_cancelled' || event === 'subscription_expired') {
      await dbRun(`UPDATE users SET plan='trial' WHERE id=?`, [userId]);
      console.log(`💳 ${event} → user ${userId} downgraded to trial`);
    }

    res.send('ok');
  } catch (e) {
    console.error('[billing] webhook error:', e.message);
    res.status(500).send('error');
  }
});

module.exports = router;
