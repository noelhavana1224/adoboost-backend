/**
 * AI Routes  —  /api/ai/*
 * ─────────────────────────────────────────────────────────────────────────────
 * All routes are auth-gated. Credits are checked inside aiService before each
 * OpenAI call. HTTP 402 is returned when credits are exhausted.
 */

const express  = require('express');
const router   = express.Router();
const {
  rewriteEmail,
  generateSubjectLines,
  analyzeSpam,
  generateSequence,
  suggestReplies,
  getCreditsStatus,
} = require('../services/aiService');

// ── Auth middleware (reuse the same pattern as other routes) ─────────────────
const { dbGet } = require('../models/db');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'adoboost-secret-2024';

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId || payload.id;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Resolve effective user (supports team-member sub-users)
async function effectiveUserMiddleware(req, res, next) {
  try {
    const user = await dbGet('SELECT * FROM users WHERE id=?', [req.userId]);
    if (user) {
      req.effectiveUserId = user.id;
      req.effectiveUser   = user;
      return next();
    }
    // Check team_members table
    const member = await dbGet('SELECT * FROM team_members WHERE id=?', [req.userId]);
    if (member) {
      req.effectiveUserId = member.owner_id;
      req.effectiveUser   = await dbGet('SELECT * FROM users WHERE id=?', [member.owner_id]);
      return next();
    }
    return res.status(401).json({ error: 'User not found' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

// Wrap every handler so NO_CREDITS becomes a clean 402
function ai(fn) {
  return async (req, res) => {
    try {
      const result = await fn(req, res);
      if (result !== undefined) res.json(result);
    } catch (e) {
      if (e.code === 'NO_CREDITS') {
        return res.status(402).json({
          error: e.message,
          code:  'NO_CREDITS',
          used:  e.used,
          limit: e.limit,
        });
      }
      if (e.status === 401 || (e.message || '').includes('API key')) {
        return res.status(503).json({ error: 'AI service unavailable — check OPENAI_API_KEY.' });
      }
      console.error('AI route error:', e.message);
      res.status(500).json({ error: e.message || 'AI request failed' });
    }
  };
}

// Apply auth to all routes
router.use(authMiddleware, effectiveUserMiddleware);

// ── GET /api/ai/credits ───────────────────────────────────────────────────────
router.get('/credits', ai(async (req) => {
  return getCreditsStatus(req.effectiveUserId);
}));

// ── POST /api/ai/rewrite ──────────────────────────────────────────────────────
// Body: { body: string, tone?: 'human'|'shorter'|'professional'|'softer_cta' }
router.post('/rewrite', ai(async (req) => {
  const { body, tone = 'human' } = req.body;
  if (!body?.trim()) return { error: 'body is required' };
  const rewritten = await rewriteEmail(req.effectiveUserId, body, tone);
  return { rewritten };
}));

// ── POST /api/ai/subject-lines ────────────────────────────────────────────────
// Body: { body: string }
router.post('/subject-lines', ai(async (req) => {
  const { body } = req.body;
  if (!body?.trim()) return { error: 'body is required' };
  const lines = await generateSubjectLines(req.effectiveUserId, body);
  return { lines };
}));

// ── POST /api/ai/spam-score ───────────────────────────────────────────────────
// Body: { subject?: string, body: string }
router.post('/spam-score', ai(async (req) => {
  const { subject = '', body } = req.body;
  if (!body?.trim()) return { error: 'body is required' };
  const result = await analyzeSpam(req.effectiveUserId, subject, body);
  return result;
}));

// ── POST /api/ai/sequence ─────────────────────────────────────────────────────
// Body: { audience: string, offer: string, niche: string }
router.post('/sequence', ai(async (req) => {
  const { audience, offer, niche } = req.body;
  if (!audience || !offer || !niche) {
    return { error: 'audience, offer, and niche are required' };
  }
  const steps = await generateSequence(req.effectiveUserId, audience, offer, niche);
  return { steps };
}));

// ── POST /api/ai/suggest-reply ────────────────────────────────────────────────
// Body: { thread: string }
router.post('/suggest-reply', ai(async (req) => {
  const { thread } = req.body;
  if (!thread?.trim()) return { error: 'thread is required' };
  const replies = await suggestReplies(req.effectiveUserId, thread);
  return { replies };
}));

module.exports = router;
