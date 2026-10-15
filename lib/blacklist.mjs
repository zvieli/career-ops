import { normalizeTextKey as normalizeCompany } from '../tracker-parse.mjs';

function normalizeBlacklistDomain(domain) {
  return String(domain || '').trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Parse the user's do-not-apply list (data/blacklist.md, user layer, opt-in).
 *
 * The file is a small markdown table the user owns:
 * `| Company | Since | Scope | Reason |`. Nothing here ever creates or writes
 * it — an absent file means no filtering. Companies are keyed with the same
 * normalization every tracker writer shares (normalizeCompany, #1460), so a
 * blacklist row "Acme Corp." still catches an ATS feed that says "acme corp".
 *
 * @param {string} text - Raw data/blacklist.md content.
 * @returns {Map<string, {company: string, since: string, scope: 'company'|'domain', reason: string}>}
 *          Normalized company key or domain:<hostname> → entry. First row wins on duplicate keys.
 */
export function parseBlacklist(text) {
  const entries = new Map();
  for (const line of String(text ?? '').replace(/\r/g, '').split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map(s => s.trim());
    const company = cells[1] || '';
    if (!company || /^[-: ]+$/.test(company)) continue; // separator row
    if (company.toLowerCase() === 'company') continue;  // header row
    const scope = (cells[3] || 'company').toLowerCase();
    const value = scope === 'domain' ? normalizeBlacklistDomain(company) : normalizeCompany(company);
    const key = scope === 'domain' ? `domain:${value}` : value;
    if (!value || entries.has(key)) continue;
    entries.set(key, {
      company,
      since: cells[2] || '',
      // A blank or unsupported scope keeps the long-standing company-name
      // behavior. Only the documented `domain` value enables host matching.
      scope: scope === 'domain' ? 'domain' : 'company',
      reason: cells[4] || '',
    });
  }
  return entries;
}

/**
 * Find the blacklist entry that applies to one posting.
 *
 * `company` is the established default: compare the feed's company label with
 * the normalized table value. `domain` is opt-in: the table's Company cell is
 * a hostname suffix, so `ibm.com` matches `jobs.ibm.com` but not `notibm.com`.
 * This deliberately does not infer parent/subsidiary ownership from a URL.
 *
 * @param {Map<string, {company: string, since: string, scope?: string, reason: string}>} blacklist
 * @param {string} company - Feed-provided company label.
 * @param {string} url - Posting URL.
 * @returns {{company: string, since: string, scope?: string, reason: string}|null}
 */
export function findBlacklistEntry(blacklist, company, url) {
  if (!blacklist || blacklist.size === 0) return null;

  const companyEntry = blacklist.get(normalizeCompany(company || ''));
  if (companyEntry && companyEntry.scope !== 'domain') return companyEntry;

  let hostname;
  try {
    hostname = normalizeBlacklistDomain(new URL(url).hostname);
  } catch {
    return null;
  }

  for (const entry of blacklist.values()) {
    if (entry.scope !== 'domain') continue;
    const suffix = normalizeBlacklistDomain(entry.company);
    if (suffix && (hostname === suffix || hostname.endsWith(`.${suffix}`))) return entry;
  }
  return null;
}

