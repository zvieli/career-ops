// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */
/** @typedef {import('./_types.js').Job} Job */

import { htmlToText } from './_html-to-text.mjs';

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
 * @returns {'ats' | 'employer_careers' | 'email' | 'geektime_form' | 'unknown'}
 */
export function classifyApplicationDestination(link) {
  if (!link || typeof link !== 'string') return 'unknown';
  const l = link.trim();
  if (l.includes('@')) return 'email';
  if (/greenhouse\.io|ashbyhq\.com|lever\.co|workable\.com|smartrecruiters\.com|myworkdayjobs\.com|comeet\.co|comeet\.com/i.test(l)) {
    return 'ats';
  }
  if (/careers|jobs/i.test(l)) return 'employer_careers';
  if (/applynow\.io|insider\.geektime\.co\.il/i.test(l)) return 'geektime_form';
  return 'unknown';
}

/**
 * @param {any} j
 * @returns {Job}
 */
export function parseGeektimeJob(j) {
  const title = (j.title || '').trim();
  const rawCompany = (j.company_name || j.company_slug || '').replace(/&#8211;.*$/, '').replace(/‎/g, '').trim();
  const locInfo = normalizeHebrewLocation(j.city);
  const link = (j.link_to_form || '').trim();
  const destType = classifyApplicationDestination(link);

  const desc = htmlToText(j.job_description || '');
  const reqs = htmlToText(j.job_requirements || '');
  const fullDesc = [desc, reqs].filter(Boolean).join('\n\nRequirements:\n');

  // URL resolution priority:
  // 1. Direct ATS link if available
  // 2. Direct employer careers URL if available
  // 3. Geektime company URL or jobs URL fallback
  let jobUrl = link;
  if (destType === 'email' || !link) {
    jobUrl = j.company_url || `https://insider.geektime.co.il/jobs/`;
  }

  return {
    title,
    company: rawCompany || 'Geektime Employer',
    location: locInfo.normalized_location,
    url: jobUrl,
    description: fullDesc,
    // Note: Geektime all_jobs.json contains no posting timestamp; omitted intentionally
  };
}

/** @type {Provider} */
export default {
  id: 'geektime-insider',

  detect(entry) {
    if (entry.provider === 'geektime-insider') return { url: GEEKTIME_FEED_URL };
    const url = entry.careers_url || entry.api || '';
    if (url.includes('insider.geektime.co.il')) return { url: GEEKTIME_FEED_URL };
    return null;
  },

  async fetch(entry, ctx) {
    const feedUrl = entry.api || GEEKTIME_FEED_URL;
    const json = await ctx.fetchJson(feedUrl, { timeoutMs: 15000 });
    if (!Array.isArray(json)) return [];

    return json
      .filter((j) => j && j.job_status === 'open')
      .map(parseGeektimeJob);
  }
};
