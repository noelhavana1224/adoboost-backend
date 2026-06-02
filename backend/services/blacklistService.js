/**
 * Blacklist / DNSBL Monitoring
 * ─────────────────────────────────────────────────────────────────────────────
 * Checks each user's sending DOMAIN (and its resolved IP) against the major
 * public DNS blocklists. Results are cached in `blacklist_status` (one row per
 * domain) and refreshed on a schedule + on demand.
 *
 * How a DNSBL check works:
 *   • Domain lists (Spamhaus DBL, SURBL): query  <domain>.<zone>
 *   • IP lists (ZEN, Barracuda, SpamCop, SORBS): reverse the IP octets, query
 *     <reversed-ip>.<zone>
 *   • If the query RESOLVES to an A record → LISTED. NXDOMAIN → clean.
 *     A timeout/other error → "unknown" (we don't punish on transient failures).
 */

const dns = require('dns').promises;
const { dbAll, dbGet, dbRun } = require('../models/db');

// ── Blocklists ──────────────────────────────────────────────────────────────
// Only lists verified to answer reliably from our host (test-point checked).
// Dropped: Spamhaus DBL (resolver returns false-clean here) and SORBS (the
// service shut down in 2024) — we never want to show a misleading "clean".
const DOMAIN_LISTS = [
  { name: 'SURBL',        zone: 'multi.surbl.org' },
];
const IP_LISTS = [
  { name: 'Spamhaus ZEN',  zone: 'zen.spamhaus.org' },
  { name: 'Barracuda',     zone: 'b.barracudacentral.org' },
  { name: 'SpamCop',       zone: 'bl.spamcop.net' },
];

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), ms)),
  ]);
}

// Returns 'listed' | 'clean' | 'unknown'
async function queryDnsbl(query) {
  try {
    const addrs = await withTimeout(dns.resolve4(query), 6000);
    return (addrs && addrs.length) ? 'listed' : 'clean';
  } catch (e) {
    if (e.code === 'ENOTFOUND' || e.code === 'ENODATA') return 'clean';
    return 'unknown'; // timeout / server failure → don't flag
  }
}

function reverseIp(ip) {
  return ip.split('.').reverse().join('.');
}

// ── Check one domain across all lists ──────────────────────────────────────
async function checkDomain(domain) {
  const results = [];
  let ip = null;

  // Resolve the domain's A record (for IP-based lists)
  try { const a = await withTimeout(dns.resolve4(domain), 6000); ip = a?.[0] || null; } catch {}

  // Domain-based lists
  for (const list of DOMAIN_LISTS) {
    const status = await queryDnsbl(`${domain}.${list.zone}`);
    results.push({ list: list.name, type: 'domain', status });
  }

  // IP-based lists (only if we resolved an IP)
  if (ip) {
    const rev = reverseIp(ip);
    for (const list of IP_LISTS) {
      const status = await queryDnsbl(`${rev}.${list.zone}`);
      results.push({ list: list.name, type: 'ip', status });
    }
  }

  const listedCount = results.filter(r => r.status === 'listed').length;
  return { domain, ip, results, listedCount, totalLists: results.length };
}

// ── Persist one domain's result ─────────────────────────────────────────────
async function saveStatus(r) {
  await dbRun(
    `INSERT INTO blacklist_status (domain, ip, results, listed_count, total_lists, checked_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(domain) DO UPDATE SET
       ip=excluded.ip, results=excluded.results, listed_count=excluded.listed_count,
       total_lists=excluded.total_lists, checked_at=excluded.checked_at`,
    [r.domain, r.ip, JSON.stringify(r.results), r.listedCount, r.totalLists, new Date().toISOString()]
  );
}

// Extract unique sending domains from from_email addresses
function domainsFromAccounts(accounts) {
  const set = new Set();
  for (const a of accounts) {
    const dom = (a.from_email || a.username || '').split('@')[1]?.toLowerCase().trim();
    if (dom) set.add(dom);
  }
  return [...set];
}

// ── Refresh ALL domains across all users (cron) ─────────────────────────────
async function refreshAllDomains() {
  try {
    const accounts = await dbAll('SELECT from_email, username FROM email_accounts');
    const domains = domainsFromAccounts(accounts);
    for (const domain of domains) {
      try { await saveStatus(await checkDomain(domain)); }
      catch (e) { console.error(`[blacklist] ${domain}:`, e.message); }
    }
    if (domains.length) console.log(`🛡️ Blacklist scan complete — ${domains.length} domain(s)`);
  } catch (e) { console.error('[blacklist] refreshAll error:', e.message); }
}

// ── Get cached status for a specific user's domains ─────────────────────────
async function getStatusForUser(userId) {
  const accounts = await dbAll('SELECT from_email, username FROM email_accounts WHERE user_id=?', [userId]);
  const domains = domainsFromAccounts(accounts);
  if (!domains.length) return [];
  const rows = [];
  for (const domain of domains) {
    const cached = await dbGet('SELECT * FROM blacklist_status WHERE domain=?', [domain]);
    if (cached) {
      rows.push({
        domain: cached.domain, ip: cached.ip,
        listedCount: cached.listed_count, totalLists: cached.total_lists,
        results: JSON.parse(cached.results || '[]'),
        checkedAt: cached.checked_at,
      });
    } else {
      rows.push({ domain, ip: null, listedCount: 0, totalLists: 0, results: [], checkedAt: null });
    }
  }
  return rows;
}

// ── Fresh check for a user's domains (on demand) ────────────────────────────
async function checkForUser(userId) {
  const accounts = await dbAll('SELECT from_email, username FROM email_accounts WHERE user_id=?', [userId]);
  const domains = domainsFromAccounts(accounts);
  const out = [];
  for (const domain of domains) {
    const r = await checkDomain(domain);
    await saveStatus(r);
    out.push({ ...r, checkedAt: new Date().toISOString() });
  }
  return out;
}

module.exports = { refreshAllDomains, getStatusForUser, checkForUser, checkDomain };
