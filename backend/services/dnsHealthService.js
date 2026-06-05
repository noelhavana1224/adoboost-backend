/**
 * DNS / Domain health checker
 * ─────────────────────────────────────────────────────────────────────────────
 * Checks the email-authentication setup for a sending domain:
 *   • MX      — can the domain receive mail?
 *   • SPF     — TXT record authorizing senders (v=spf1)
 *   • DMARC   — _dmarc TXT policy (v=DMARC1)
 *   • DKIM    — tries common selectors at <selector>._domainkey.<domain>
 *
 * Returns a structured report with pass/warn/fail per check plus plain-English
 * guidance, so users can fix deliverability problems before they send.
 */
const dns = require('dns').promises;

// Common DKIM selectors used by major providers / ESPs
const DKIM_SELECTORS = [
  'google',        // Google Workspace
  'selector1', 'selector2', // Microsoft 365
  'k1', 'k2', 'k3',          // Mailchimp / Mandrill
  'dkim', 'default', 'mail', 's1', 's2',
  'smtp', 'mxvault', 'zoho', 'sig1', 'scph0', 'pm',
  'hostingermail-a', 'hostingermail-b', 'hostingermail-c', // Hostinger
  'protonmail', 'protonmail2', 'protonmail3',              // Proton
  'fm1', 'fm2', 'fm3',                                     // Fastmail
];

async function safe(fn) { try { return await fn(); } catch { return null; } }

function domainFromEmail(input) {
  if (!input) return '';
  const s = String(input).trim().toLowerCase();
  return s.includes('@') ? s.split('@')[1] : s.replace(/^https?:\/\//, '').split('/')[0];
}

async function checkMx(domain) {
  const recs = await safe(() => dns.resolveMx(domain));
  if (recs && recs.length) {
    const hosts = recs.sort((a, b) => a.priority - b.priority).map(r => r.exchange);
    return { id: 'mx', label: 'MX records', status: 'pass',
      detail: `${recs.length} mail server(s): ${hosts.slice(0, 3).join(', ')}`,
      records: hosts };
  }
  return { id: 'mx', label: 'MX records', status: 'fail',
    detail: 'No MX records found — this domain cannot receive replies or bounces.',
    fix: 'Add MX records pointing to your mail provider (e.g. Google, Microsoft 365, or your host).' };
}

async function checkSpf(domain) {
  const txt = await safe(() => dns.resolveTxt(domain));
  const flat = (txt || []).map(parts => parts.join(''));
  const spf = flat.find(r => /^v=spf1/i.test(r));
  if (!spf) {
    return { id: 'spf', label: 'SPF', status: 'fail',
      detail: 'No SPF record found.',
      fix: 'Add a TXT record like "v=spf1 include:_spf.google.com ~all" listing who may send for your domain.' };
  }
  const multiple = flat.filter(r => /^v=spf1/i.test(r)).length > 1;
  if (multiple) {
    return { id: 'spf', label: 'SPF', status: 'warn',
      detail: 'Multiple SPF records found — only one is allowed and extras break SPF.',
      records: [spf], fix: 'Merge all SPF rules into a single TXT record.' };
  }
  const soft = /~all/.test(spf), hard = /-all/.test(spf);
  return { id: 'spf', label: 'SPF', status: 'pass',
    detail: hard ? 'Valid SPF with strict -all.' : soft ? 'Valid SPF (soft ~all).' : 'SPF record present.',
    records: [spf] };
}

async function checkDmarc(domain) {
  const txt = await safe(() => dns.resolveTxt(`_dmarc.${domain}`));
  const flat = (txt || []).map(parts => parts.join(''));
  const dmarc = flat.find(r => /^v=DMARC1/i.test(r));
  if (!dmarc) {
    return { id: 'dmarc', label: 'DMARC', status: 'fail',
      detail: 'No DMARC record found.',
      fix: 'Add a TXT record at _dmarc.' + domain + ' like "v=DMARC1; p=none; rua=mailto:you@' + domain + '" then tighten to p=quarantine over time.' };
  }
  const policy = (dmarc.match(/p=([a-z]+)/i) || [])[1] || 'none';
  if (policy === 'none') {
    return { id: 'dmarc', label: 'DMARC', status: 'warn',
      detail: 'DMARC present but policy is p=none (monitor only).',
      records: [dmarc], fix: 'Once you confirm SPF/DKIM align, move to p=quarantine or p=reject for real protection.' };
  }
  return { id: 'dmarc', label: 'DMARC', status: 'pass',
    detail: `DMARC enforced with p=${policy}.`, records: [dmarc] };
}

async function checkDkim(domain) {
  const found = [];
  await Promise.all(DKIM_SELECTORS.map(async sel => {
    const host = `${sel}._domainkey.${domain}`;
    const txt = await safe(() => dns.resolveTxt(host));
    if (txt && txt.length) {
      const flat = txt.map(p => p.join(''));
      if (flat.some(r => /v=DKIM1|p=|k=rsa/i.test(r))) found.push(sel);
    }
    // CNAME-based DKIM (common with ESPs) also counts
    if (!txt) {
      const cname = await safe(() => dns.resolveCname(host));
      if (cname && cname.length) found.push(sel);
    }
  }));
  if (found.length) {
    return { id: 'dkim', label: 'DKIM', status: 'pass',
      detail: `DKIM found for selector(s): ${found.join(', ')}.`, records: found };
  }
  return { id: 'dkim', label: 'DKIM', status: 'warn',
    detail: 'No DKIM record found at common selectors (it may use a custom selector).',
    fix: 'Enable DKIM signing in your mail provider and publish the key. We checked common selectors only.' };
}

async function checkDomainHealth(input) {
  const domain = domainFromEmail(input);
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    return { domain: input, error: 'Enter a valid domain or email address.' };
  }
  const [mx, spf, dmarc, dkim] = await Promise.all([
    checkMx(domain), checkSpf(domain), checkDmarc(domain), checkDkim(domain),
  ]);
  const checks = [mx, spf, dkim, dmarc];
  const score = Math.round(
    checks.reduce((s, c) => s + (c.status === 'pass' ? 25 : c.status === 'warn' ? 12 : 0), 0)
  );
  const grade = score >= 90 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : score >= 25 ? 'D' : 'F';
  return { domain, score, grade, checks, checked_at: new Date().toISOString() };
}

module.exports = { checkDomainHealth, domainFromEmail };
