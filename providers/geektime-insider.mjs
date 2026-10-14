// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
/** @typedef {import('./_types.js').Job} Job */

import { htmlToText } from './_html-to-text.mjs';
import { isIP } from 'node:net';

// Geektime Insider provider — hits the public, unauthenticated static feed.
// Used as a DISCOVERY_SOURCE for Israeli tech companies.
// URL: https://insider.geektime.co.il/wp-content/uploads/all_jobs.json

const ALLOWED_GEEKTIME_HOSTS = new Set(['insider.geektime.co.il']);
export const GEEKTIME_FEED_URL = 'https://insider.geektime.co.il/wp-content/uploads/all_jobs.json';

/**
 * Hebrew location normalizer for common Israeli localities encountered in Geektime
 * @param {string} raw
 * @returns {{ raw_location: string, normalized_location: string }}
 */
export function normalizeHebrewLocation(raw) {
  const rawLoc = String(raw || '').trim();
  let normalized = rawLoc;

  // Exact mappings for observed values
  if (/תל אביב|ת"א/i.test(rawLoc)) normalized = 'Tel Aviv';
  else if (/רמת גן|ר"ג/i.test(rawLoc)) normalized = 'Ramat Gan';
  else if (/כפר סבא/i.test(rawLoc)) normalized = 'Kfar Saba';
  else if (/רעננה/i.test(rawLoc)) normalized = 'Ra\'anana';
  else if (/רחובות/i.test(rawLoc)) normalized = 'Rehovot';
  else if (/הרצליה/i.test(rawLoc)) normalized = 'Herzliya';
  else if (/פתח תקוה|פתח תקווה|פ"ת/i.test(rawLoc)) normalized = 'Petah Tikva';
  else if (/נתניה/i.test(rawLoc)) normalized = 'Netanya';
  else if (/חולון/i.test(rawLoc)) normalized = 'Holon';
  else if (/ראשון לציון|ראשל"צ/i.test(rawLoc)) normalized = 'Rishon LeZion';
  else if (/חיפה/i.test(rawLoc)) normalized = 'Haifa';
  else if (/ירושלים/i.test(rawLoc)) normalized = 'Jerusalem';
  else if (/מרכז/i.test(rawLoc)) normalized = 'Central District';
  else if (/היברידי|מרחוק/i.test(rawLoc)) normalized = 'Hybrid / Remote';

  return {
    raw_location: rawLoc,
    normalized_location: normalized
  };
}

/**
 * Classifies the destination of Geektime's link_to_form field
 * @param {string} link
 * @param {string} [companyUrl]
 * @returns {'ats' | 'employer_careers' | 'email' | 'geektime_form' | 'unknown'}
 */
export function classifyApplicationDestination(link, companyUrl = '') {
  if (!link || typeof link !== 'string') return 'unknown';
  const value = link.trim();
  if (/^[^\s@]+@[^\s@]+$/.test(value)) return 'email';
  let url;
  try { url = new URL(value); } catch { return 'unknown'; }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || isIP(url.hostname)) return 'unknown';
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'insider.geektime.co.il' || host.endsWith('.insider.geektime.co.il') || host === 'applynow.io' || host.endsWith('.applynow.io')) return 'geektime_form';
  const atsDomains = ['greenhouse.io', 'ashbyhq.com', 'lever.co', 'workable.com', 'smartrecruiters.com', 'myworkdayjobs.com', 'comeet.co', 'comeet.com'];
  if (atsDomains.some(domain => host === domain || host.endsWith(`.${domain}`))) return 'ats';
  let employerHost = '';
  try { employerHost = new URL(companyUrl).hostname.toLowerCase().replace(/\.$/, ''); } catch { /* no first-party host evidence */ }
  if (employerHost && (host === employerHost || host.endsWith(`.${employerHost}`)) && /careers|jobs/i.test(url.pathname)) return 'employer_careers';
  return 'unknown';
}

/**
 * @param {any} j
 * @returns {Job}
 */
export function parseGeektimeJob(j) {
  const title = typeof j?.title === 'string' ? j.title.trim() : '';
  const rawCompany = (typeof j?.company_name === 'string' ? j.company_name : typeof j?.company_slug === 'string' ? j.company_slug : '').replace(/&#8211;.*$/, '').replace(/‎/g, '').trim();
  const locInfo = normalizeHebrewLocation(typeof j?.city === 'string' ? j.city : '');
  const link = typeof j?.link_to_form === 'string' ? j.link_to_form.trim() : '';
  const destType = classifyApplicationDestination(link, typeof j?.company_url === 'string' ? j.company_url : '');

  const desc = htmlToText(j.job_description || '');
  const reqs = htmlToText(j.job_requirements || '');
  const fullDesc = [desc, reqs].filter(Boolean).join('\n\nRequirements:\n');

  // URL resolution priority:
  // 1. Direct ATS link if available
  // 2. Direct employer careers URL if available
  // 3. Geektime company URL or jobs URL fallback
  // Only a validated HTTPS ATS/employer destination can serve as the scanner's
  // canonical URL. Geektime forms and unknown destinations are discovery leads,
  // not verified employer job URLs, so fail closed rather than inventing identity.
  const jobUrl = ['ats', 'employer_careers'].includes(destType) ? link : '';

  return {
    title,
    company: rawCompany,
    location: locInfo.normalized_location,
    rawLocation: locInfo.raw_location,
    url: jobUrl,
    ...(j.id !== undefined && j.id !== null && String(j.id).trim() ? { externalId: String(j.id).trim() } : {}),
    description: fullDesc,
    // Note: Geektime all_jobs.json contains no posting timestamp; omitted intentionally
  };
}

/** @type {Provider} */
export default {
  id: 'geektime-insider',
  capabilities: {
    discovery: 'supported', hydration: 'partial', liveness: 'unsupported',
    canonicalization: 'partial', fixtureTested: true, livePublic: true,
    authentication: 'none', sourceTrust: 'structured_job_board', region: ['IL']
  },

  detect(entry) {
    if (entry.provider === 'geektime-insider') return { url: GEEKTIME_FEED_URL };
    const url = entry.careers_url || entry.api || '';
    if (url.includes('insider.geektime.co.il')) return { url: GEEKTIME_FEED_URL };
    return null;
  },

  async fetch(entry, ctx) {
    const feedUrl = entry.api || GEEKTIME_FEED_URL;
    const json = await ctx.fetchJson(feedUrl, { timeoutMs: 15000 });
    if (!Array.isArray(json)) throw new Error('Geektime Insider invalid feed: expected a JSON array');

    return json
      .filter((j) => j && j.job_status === 'open')
      .map(parseGeektimeJob)
      .filter((job) => job.title && job.company && job.url);
  }
};
