/**
 * AdoBoost AI Service
 * ─────────────────────────────────────────────────────────────────────────────
 * Supports two providers (auto-detected from env vars):
 *   GROQ_API_KEY    → Groq (free tier) — Llama 3 models
 *   OPENAI_API_KEY  → OpenAI (paid)    — GPT-4o-mini
 * Groq is checked first so free testing works out-of-the-box.
 *
 * All features are credit-gated (monthly allowance per plan).
 * Plans:     trial=10  starter=100  professional=1000  unlimited=9999
 * Features:  rewrite=1  subject_lines=1  spam_score=1  sequence=5  suggest_reply=1
 */

const OpenAI  = require('openai');
const { dbGet, dbRun } = require('../models/db');
const { v4: uuidv4 }   = require('uuid');

// ── Plan monthly credit allowances ──────────────────────────────────────────
const PLAN_CREDITS = {
  trial:        25,
  starter:      250,
  professional: 1000,
  unlimited:    5000,   // Agency — capped (not unlimited) to protect AI margin
};

// ── Credits consumed per feature ────────────────────────────────────────────
const FEATURE_COSTS = {
  rewrite:       1,
  subject_lines: 1,
  spam_score:    1,
  sequence:      5,
  suggest_reply: 1,
};

// ── AI provider — lazy singleton ─────────────────────────────────────────────
// Priority: GROQ_API_KEY (free) → OPENAI_API_KEY (paid)
// Models:
//   Groq  quality → llama-3.3-70b-versatile  (best free model for complex tasks)
//   Groq  fast    → llama-3.1-8b-instant      (fastest free model)
//   OpenAI        → gpt-4o-mini               (cheapest paid model)
let _aiClient = null;
let _modelQuality = null;
let _modelFast    = null;

function getClient() {
  if (_aiClient) return { ai: _aiClient, mq: _modelQuality, mf: _modelFast };

  if (process.env.GROQ_API_KEY) {
    _aiClient     = new OpenAI({
      apiKey:  process.env.GROQ_API_KEY,
      baseURL: 'https://api.groq.com/openai/v1',
    });
    _modelQuality = 'llama-3.3-70b-versatile';
    _modelFast    = 'llama-3.1-8b-instant';
    console.log('[AI] Provider: Groq (free tier)');
  } else if (process.env.OPENAI_API_KEY) {
    _aiClient     = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    _modelQuality = process.env.AI_MODEL_QUALITY || 'gpt-4o-mini';
    _modelFast    = process.env.AI_MODEL_FAST    || 'gpt-4o-mini';
    console.log('[AI] Provider: OpenAI');
  } else {
    throw new Error(
      'No AI provider configured. Set GROQ_API_KEY (free) or OPENAI_API_KEY in environment variables.'
    );
  }

  return { ai: _aiClient, mq: _modelQuality, mf: _modelFast };
}

// ── Credit helpers ───────────────────────────────────────────────────────────
async function getMonthlyUsed(userId) {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const row = await dbGet(
    `SELECT COALESCE(SUM(credits_used), 0) AS total FROM ai_usage_logs
     WHERE user_id=? AND created_at>=?`,
    [userId, monthStart.toISOString()]
  );
  return Number(row?.total) || 0;
}

async function getPlanCreditLimit(slug) {
  // Try to read the admin-configured limit from the plans table first
  const planRow = await dbGet(
    `SELECT max_ai_credits FROM plans WHERE LOWER(name)=? AND max_ai_credits > 0`,
    [slug]
  );
  // Fall back to hard-coded defaults if the column isn't seeded yet
  return planRow?.max_ai_credits ?? (PLAN_CREDITS[slug] ?? PLAN_CREDITS.trial);
}

async function checkCredits(userId, feature) {
  const user  = await dbGet('SELECT plan FROM users WHERE id=?', [userId]);
  const slug  = (user?.plan || 'trial').toLowerCase();
  const limit = await getPlanCreditLimit(slug);
  const cost  = FEATURE_COSTS[feature] || 1;
  const used  = await getMonthlyUsed(userId);

  if (used + cost > limit) {
    const err  = new Error(
      `AI credits exhausted. You've used ${used} of ${limit} this month. Upgrade your plan for more.`
    );
    err.code   = 'NO_CREDITS';
    err.used   = used;
    err.limit  = limit;
    throw err;
  }
  return { used, limit, cost };
}

async function logUsage(userId, feature, cost, model, inputTokens, outputTokens) {
  await dbRun(
    `INSERT INTO ai_usage_logs
       (id, user_id, feature, credits_used, model, input_tokens, output_tokens, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), userId, feature, cost, model, inputTokens || 0, outputTokens || 0, new Date().toISOString()]
  );
}

// ── 1. Rewrite email ─────────────────────────────────────────────────────────
const TONE_INSTRUCTIONS = {
  human:        'more human and conversational — remove any corporate or robotic language',
  shorter:      'significantly shorter (2-3 sentences max) while keeping the core message',
  professional: 'more professional and polished while still sounding natural, not stiff',
  softer_cta:   'with a softer, less pushy call-to-action that feels like a genuine ask',
};

async function rewriteEmail(userId, emailBody, tone = 'human') {
  await checkCredits(userId, 'rewrite');
  const instr = TONE_INSTRUCTIONS[tone] || TONE_INSTRUCTIONS.human;
  const { ai, mq } = getClient();

  const res = await ai.chat.completions.create({
    model: mq,
    max_tokens: 700,
    temperature: 0.7,
    messages: [
      {
        role: 'system',
        content:
`You are an expert cold email copywriter who specialises in deliverability-optimised outreach.

Your rewrites must be:
- Human and conversational (never corporate-sounding)
- Free of spam trigger words (guaranteed, free, act now, limited offer, click here, etc.)
- Short and punchy — respect the reader's time
- Have a soft, natural CTA that does not feel pushy

CRITICAL: Keep all Handlebars variables ({{first_name}}, {{company}}, {{title}}, etc.) exactly as-is.
Return ONLY the rewritten email body. No explanation, no labels, no preamble.`,
      },
      {
        role: 'user',
        content: `Rewrite this cold email to be ${instr}:\n\n${emailBody}`,
      },
    ],
  });

  const result = res.choices[0].message.content.trim();
  await logUsage(userId, 'rewrite', FEATURE_COSTS.rewrite, mq,
    res.usage?.prompt_tokens, res.usage?.completion_tokens);
  return result;
}

// ── 2. Generate subject lines ────────────────────────────────────────────────
async function generateSubjectLines(userId, emailBody) {
  await checkCredits(userId, 'subject_lines');
  const { ai, mf } = getClient();

  const res = await ai.chat.completions.create({
    model: mf,
    max_tokens: 450,
    temperature: 0.85,
    messages: [
      {
        role: 'system',
        content:
`You are an expert cold email subject line writer.

Rules:
- Sound like a real human, NOT marketing copy
- No ALL CAPS, no excessive punctuation (!!!, ???)
- Vary approaches: question, statement, curiosity, direct, conversational, value-based
- Under 52 characters where possible
- NEVER use spam words: free, guaranteed, act now, limited time, urgent, exclusive deal

Return ONLY a numbered list of 10 subject lines. No preamble, no labels, no explanation.`,
      },
      {
        role: 'user',
        content: `Generate 10 natural cold email subject lines for this email:\n\n${emailBody}`,
      },
    ],
  });

  const raw   = res.choices[0].message.content.trim();
  const lines = raw
    .split('\n')
    .filter(l => /^\d+[\.\)]/.test(l))
    .map(l => l.replace(/^\d+[\.\)]\s*/, '').replace(/^["']|["']$/g, '').trim())
    .filter(Boolean)
    .slice(0, 10);

  await logUsage(userId, 'subject_lines', FEATURE_COSTS.subject_lines, mf,
    res.usage?.prompt_tokens, res.usage?.completion_tokens);
  return lines;
}

// ── 3. Spam score analysis ───────────────────────────────────────────────────
async function analyzeSpam(userId, subject, body) {
  await checkCredits(userId, 'spam_score');
  const { ai, mq } = getClient();  // use quality model — needs reliable JSON output

  const cleanBody = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

  const res = await ai.chat.completions.create({
    model: mq,
    max_tokens: 700,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content:
`You are an email deliverability expert. Analyse cold emails for spam signals.

Return VALID JSON only — no markdown, no code fence, no explanation:
{
  "score": <0-100>,
  "grade": <"A"|"B"|"C"|"D"|"F">,
  "verdict": <"inbox"|"promotions"|"spam">,
  "summary": "<one sentence>",
  "issues": [
    { "type": "<spam_word|aggressive_tone|formatting|excessive_links|selling_language>",
      "text": "<exact problematic phrase>",
      "suggestion": "<concise fix>" }
  ]
}

Score guide: 0-20=A (clean), 21-40=B (minor), 41-60=C (needs work), 61-80=D (risky), 81-100=F (spam)`,
      },
      {
        role: 'user',
        content: `Subject: ${subject || '(none)'}\n\n${cleanBody}`,
      },
    ],
  });

  let result;
  try {
    result = JSON.parse(res.choices[0].message.content.trim());
  } catch {
    result = { score: 0, grade: 'A', verdict: 'inbox', summary: 'Looks clean.', issues: [] };
  }

  await logUsage(userId, 'spam_score', FEATURE_COSTS.spam_score, mq,
    res.usage?.prompt_tokens, res.usage?.completion_tokens);
  return result;
}

// ── 4. Generate full multi-channel sequence ──────────────────────────────────
async function generateSequence(userId, audience, offer, niche) {
  await checkCredits(userId, 'sequence');
  const { ai, mq } = getClient();

  const res = await ai.chat.completions.create({
    model: mq,
    max_tokens: 2000,
    temperature: 0.75,
    messages: [
      {
        role: 'system',
        content:
`You are an expert B2B lead generation strategist who builds high-converting multi-channel outreach sequences combining LinkedIn and email.

Generate a 5-step sequence mixing LinkedIn touchpoints and emails for maximum response rates.

Rules:
- Use {{first_name}} and {{company}} naturally
- LinkedIn notes: max 280 chars, conversational, no selling
- Emails: 3-5 sentences max, human tone, zero spam words, one soft CTA
- Timing: space touches realistically (people need time)

Recommended cadence:
- Step 1 (day 0): LinkedIn View Profile — warm them up silently
- Step 2 (day 1): LinkedIn Connection with a short personal note
- Step 3 (day 3): Initial Email — intro + value prop + soft CTA
- Step 4 (day 7): Follow-up Email — different angle, insight or social proof
- Step 5 (day 14): Breakup Email — graceful, give them an easy out

Return VALID JSON array only — no markdown, no code fence, no extra text.
For linkedin_view steps: subject and body can be empty strings.
For linkedin_connect steps: put the connection note in linkedin_note, subject and body empty.
For email steps: fill subject and body normally.

[
  {"step":1,"step_type":"linkedin_view","subject":"","body":"","linkedin_note":"","delay_days":0,"delay_hours":0},
  {"step":2,"step_type":"linkedin_connect","subject":"","body":"","linkedin_note":"Hi {{first_name}}, noticed you work at {{company}}...","delay_days":1,"delay_hours":0},
  {"step":3,"step_type":"email","subject":"Quick question for {{first_name}}","body":"Hi {{first_name}},\\n\\n...","linkedin_note":"","delay_days":3,"delay_hours":0},
  {"step":4,"step_type":"email","subject":"...","body":"...","linkedin_note":"","delay_days":7,"delay_hours":0},
  {"step":5,"step_type":"email","subject":"...","body":"...","linkedin_note":"","delay_days":14,"delay_hours":0}
]`,
      },
      {
        role: 'user',
        content: `Generate a 5-step multi-channel outreach sequence:\n- Target audience: ${audience}\n- Offer / product: ${offer}\n- Niche / industry: ${niche}`,
      },
    ],
  });

  let sequences = [];
  try {
    const raw = res.choices[0].message.content.trim();
    sequences  = JSON.parse(raw);
    if (!Array.isArray(sequences)) sequences = [];
  } catch { sequences = []; }

  await logUsage(userId, 'sequence', FEATURE_COSTS.sequence, mq,
    res.usage?.prompt_tokens, res.usage?.completion_tokens);
  return sequences;
}

// ── 5. Suggest replies ───────────────────────────────────────────────────────
async function suggestReplies(userId, threadContext) {
  await checkCredits(userId, 'suggest_reply');
  const { ai, mq } = getClient();

  const res = await ai.chat.completions.create({
    model: mq,
    max_tokens: 550,
    temperature: 0.7,
    messages: [
      {
        role: 'system',
        content:
`You help B2B salespeople respond naturally to cold email replies.

Return VALID JSON array only — no markdown, no code fence:
[
  {"tone":"warm",         "label":"Enthusiastic", "text":"..."},
  {"tone":"professional", "label":"Professional",  "text":"..."},
  {"tone":"brief",        "label":"Short & casual","text":"..."}
]

Each reply: 1-3 sentences, sound like a real human, no corporate-speak.`,
      },
      {
        role: 'user',
        content: `Email thread:\n${threadContext}\n\nSuggest 3 reply options.`,
      },
    ],
  });

  let replies = [];
  try {
    replies = JSON.parse(res.choices[0].message.content.trim());
  } catch { replies = []; }

  await logUsage(userId, 'suggest_reply', FEATURE_COSTS.suggest_reply, mq,
    res.usage?.prompt_tokens, res.usage?.completion_tokens);
  return replies;
}

// ── AI reply categorization (automatic lead-flagging) ───────────────────────
// Runs automatically on incoming replies — NOT credit-gated (it's a system
// feature, uses the cheap/fast model with a tiny output).
const REPLY_CATEGORIES = ['interested', 'positive', 'not_now', 'not_interested', 'ooo', 'other'];

async function categorizeReply(text) {
  try {
    if (!process.env.GROQ_API_KEY && !process.env.OPENAI_API_KEY) return null;
    const snippet = String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200);
    if (!snippet) return null;
    const { ai, mf } = getClient();
    const res = await ai.chat.completions.create({
      model: mf,
      max_tokens: 6,
      temperature: 0,
      messages: [
        { role: 'system', content:
`Classify a reply to a cold sales email into ONE category. Output ONLY the category key — no punctuation, no explanation.
interested = wants to talk, asks for a call/pricing/more info, clear buying intent
positive = friendly or curious but not committed yet
not_now = interested later, busy, "circle back", "reach out next quarter"
not_interested = no, not a fit, unsubscribe, stop, remove me
ooo = out-of-office / automatic reply / on vacation
other = referral to someone else, wrong person, unrelated question` },
        { role: 'user', content: snippet },
      ],
    });
    const out = (res.choices[0]?.message?.content || '').trim().toLowerCase().replace(/[^a-z_]/g, '');
    return REPLY_CATEGORIES.includes(out) ? out : 'other';
  } catch { return null; }
}

// Batch-classify recent uncategorized inbound replies (called by cron).
async function categorizeInboxMessages(limit = 25) {
  if (!process.env.GROQ_API_KEY && !process.env.OPENAI_API_KEY) return 0;
  const { dbAll } = require('../models/db');
  // Auto-replies → 'ooo' instantly (no AI needed)
  await dbRun(`UPDATE messages SET ai_category='ooo' WHERE is_auto_reply=1 AND ai_category IS NULL`);
  // Real inbound replies (not warmup, not our own sends) → AI classify
  const rows = await dbAll(`
    SELECT id, body FROM messages
    WHERE (is_warmup=0 OR is_warmup IS NULL)
      AND (is_auto_reply=0 OR is_auto_reply IS NULL)
      AND status != 'sent'
      AND ai_category IS NULL
      AND (deleted=0 OR deleted IS NULL)
    ORDER BY received_at DESC LIMIT ?`, [limit]);
  let done = 0;
  for (const m of rows) {
    const cat = await categorizeReply(m.body);
    await dbRun('UPDATE messages SET ai_category=? WHERE id=?', [cat || 'other', m.id]);
    done++;
  }
  if (done) console.log(`🏷️  AI categorized ${done} reply(ies)`);
  return done;
}

// ── Credits status (for frontend display) ───────────────────────────────────
async function getCreditsStatus(userId) {
  const user  = await dbGet('SELECT plan FROM users WHERE id=?', [userId]);
  const slug  = (user?.plan || 'trial').toLowerCase();
  const limit = await getPlanCreditLimit(slug);
  const used  = await getMonthlyUsed(userId);

  const nextMonth = new Date();
  nextMonth.setMonth(nextMonth.getMonth() + 1);
  nextMonth.setDate(1);
  nextMonth.setHours(0, 0, 0, 0);

  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    plan: slug,
    resets_at: nextMonth.toISOString(),
    feature_costs: FEATURE_COSTS,
  };
}

module.exports = {
  rewriteEmail,
  generateSubjectLines,
  analyzeSpam,
  generateSequence,
  suggestReplies,
  categorizeReply,
  categorizeInboxMessages,
  getCreditsStatus,
  PLAN_CREDITS,
  FEATURE_COSTS,
};
