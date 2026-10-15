// Extracted pure location matching logic shared with the scanner. No provider/browser imports.
export function normalizeKeywordList(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .filter(k => typeof k === 'string')
    .map(k => k.toLowerCase().trim())
    .filter(Boolean);
}

// Compile a location keyword into a word-boundary matcher.
//
// Plain String.includes() is wrong for location keywords because country and
// city names are prefixes of unrelated US place names. The motivating bug:
// blocking "india" also rejected "Indian Head, MD", "Indiana", and
// "Indianapolis" — real US locations, silently dropped from every scan.
// Likewise "china" would swallow "Chinatown" and "uk -" would swallow "Truck -".
//
// Lookarounds rather than \b so keywords that begin or end with punctuation
// (", IND", "UK -") still anchor correctly — \b is defined relative to word
// characters and behaves surprisingly at a punctuation edge.
// Letters, combining marks and numbers form words in every script; ASCII-only
// boundaries let "al," match inside "Montréal," (including decomposed accents).
// Note: distinct from compileKeyword() above, which serves the *title* filter and
// only boundary-anchors 2-3 letter acronyms. Location keywords need boundaries on
// every keyword, so they get their own compiler rather than changing title-matching
// behaviour. Returns a predicate, mirroring compileKeyword()'s shape.
// Edges are tested one code point at a time against a fully anchored class:
// V8 in Node 26 returns false for /[\p{L}]$/u against an astral letter at
// end-of-string (#4478), so "𐐀" lost its trailing boundary and matched "𐐀x".
const LOCATION_WORD_CP = /^[\p{L}\p{M}\p{N}]$/u;

function compileLocationKeyword(keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const codePoints = [...keyword];
  const startsWord = LOCATION_WORD_CP.test(codePoints[0] ?? '');
  const endsWord = LOCATION_WORD_CP.test(codePoints.at(-1) ?? '');
  const prefix = startsWord ? '(?<![\\p{L}\\p{M}\\p{N}])' : '';
  const suffix = endsWord ? '(?![\\p{L}\\p{M}\\p{N}])' : '';
  const re = new RegExp(`${prefix}${escaped}${suffix}`, 'u');
  return (lower) => re.test(lower);
}

function compileLocationKeywordList(value) {
  return normalizeKeywordList(value).map(compileLocationKeyword);
}

// Frozen USPS state-name + abbreviation table. Not a world gazetteer: only
// consulted when always_allow already names the United States as a country,
// so EU-targeted configs (no US token) keep their previous semantics.
const US_COUNTRY_ALWAYS_ALLOW = new Set(['united states', 'usa', 'u.s.', 'u.s.a.']);
const USPS_STATES = Object.freeze([
  Object.freeze(['alabama', 'al']),
  Object.freeze(['alaska', 'ak']),
  Object.freeze(['arizona', 'az']),
  Object.freeze(['arkansas', 'ar']),
  Object.freeze(['california', 'ca']),
  Object.freeze(['colorado', 'co']),
  Object.freeze(['connecticut', 'ct']),
  Object.freeze(['delaware', 'de']),
  Object.freeze(['florida', 'fl']),
  Object.freeze(['georgia', 'ga']),
  Object.freeze(['hawaii', 'hi']),
  Object.freeze(['idaho', 'id']),
  Object.freeze(['illinois', 'il']),
  Object.freeze(['indiana', 'in']),
  Object.freeze(['iowa', 'ia']),
  Object.freeze(['kansas', 'ks']),
  Object.freeze(['kentucky', 'ky']),
  Object.freeze(['louisiana', 'la']),
  Object.freeze(['maine', 'me']),
  Object.freeze(['maryland', 'md']),
  Object.freeze(['massachusetts', 'ma']),
  Object.freeze(['michigan', 'mi']),
  Object.freeze(['minnesota', 'mn']),
  Object.freeze(['mississippi', 'ms']),
  Object.freeze(['missouri', 'mo']),
  Object.freeze(['montana', 'mt']),
  Object.freeze(['nebraska', 'ne']),
  Object.freeze(['nevada', 'nv']),
  Object.freeze(['new hampshire', 'nh']),
  Object.freeze(['new jersey', 'nj']),
  Object.freeze(['new mexico', 'nm']),
  Object.freeze(['new york', 'ny']),
  Object.freeze(['north carolina', 'nc']),
  Object.freeze(['north dakota', 'nd']),
  Object.freeze(['ohio', 'oh']),
  Object.freeze(['oklahoma', 'ok']),
  Object.freeze(['oregon', 'or']),
  Object.freeze(['pennsylvania', 'pa']),
  Object.freeze(['rhode island', 'ri']),
  Object.freeze(['south carolina', 'sc']),
  Object.freeze(['south dakota', 'sd']),
  Object.freeze(['tennessee', 'tn']),
  Object.freeze(['texas', 'tx']),
  Object.freeze(['utah', 'ut']),
  Object.freeze(['vermont', 'vt']),
  Object.freeze(['virginia', 'va']),
  Object.freeze(['washington', 'wa']),
  Object.freeze(['west virginia', 'wv']),
  Object.freeze(['wisconsin', 'wi']),
  Object.freeze(['wyoming', 'wy']),
]);

// 2-letter codes: comma-state (", OH" / ",OH, USA") or a trailing token
// ("Dublin OH", Workday URL hint "dublin oh"). Not a generic word-boundary —
// English "in"/"or"/"me" in "Remote, Belgium or France" must not impersonate
// Indiana/Oregon/Maine. State *names* still use compileLocationKeyword.
// Unicode letters and marks are part of the token: "Montréal" is not "AL".
function compileUsStateAbbrev(abbr) {
  const escaped = abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:,\\s*${escaped}(?![\\p{L}\\p{M}\\p{N}])|(?:^|[^\\p{L}\\p{M}\\p{N}])${escaped}[^\\p{L}\\p{M}\\p{N}]*$)`, 'u');
  return (lower) => re.test(withoutCountryCodeSlot(lower));
}

// "City, Region, CC" ends in an ISO country code, and several of those are
// also USPS codes: "Bengaluru, Karnataka, IN" read as Indiana and "Toronto,
// ON, CA" as California, so always_allow beat the user's own block entry.
// A two-letter last part after two or more parts is the country slot, never
// a state. "Austin, TX, US" still keeps TX.
function withoutCountryCodeSlot(lower) {
  const parts = lower.split(',');
  if (parts.length < 3 || !/^\s*\p{L}{2}\s*$/u.test(parts.at(-1))) return lower;
  return parts.slice(0, -1).join(',');
}

const US_STATE_ALWAYS_ALLOW_MATCHERS = USPS_STATES.flatMap(([name, abbr]) => [
  compileLocationKeyword(name),
  compileUsStateAbbrev(abbr),
]);

// Some providers report a rolled-up display string ("5 Locations", "2 Locations")
// while the canonical URL still names the real primary location. Workday is the
// common case: .../job/Hyderabad-Telangana-India/Network-Engineer_R-65193-1 shows
// up as "5 Locations", so no `block` keyword can ever match the location field.
// Recover that signal by reading the path segment right after `/job/`.
//
// Deliberately narrow: only the post-`/job/` segment is inspected, never the whole
// URL. Scanning the full URL would match company slugs and ATS subdomains by
// accident (a "china" or "india" substring inside an unrelated path). Providers
// without the Workday hostname convention yield no hint and keep their previous
// behaviour exactly, even if their own routes also contain `/job/{id}`.
export function locationHintFromUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return '';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  if (!parsed.hostname.toLowerCase().endsWith('.myworkdayjobs.com')) return '';
  const segments = parsed.pathname.split('/').filter(Boolean);
  const jobIdx = segments.lastIndexOf('job');
  // Workday also emits /job/{Title}_{ReqId}; a location needs a title after it.
  if (jobIdx === -1 || segments.length - jobIdx - 1 < 2) return '';
  let segment = segments[jobIdx + 1];
  try {
    segment = decodeURIComponent(segment);
  } catch {
    // Malformed percent-encoding — fall back to the raw segment.
  }
  // "Hyderabad-Telangana-India" → "hyderabad telangana india" so multi-word
  // block keywords like "united arab emirates" can still match.
  return segment.replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Some ATSs report the hiring office as the location even when the role is
// remote, and state the remoteness in the TITLE instead: Radancy/TalentBrew
// tenants return bare "City, State" strings, so
//   "Program Manager - Remote"  ->  location "Las Vegas, Nevada"
// An `allow` list written in country/region terms ("united states", "remote")
// then rejects a genuinely remote US role. Live measurement on
// careers.unitedhealthgroup.com: 14 PM-family postings, 0 passed `allow`,
// 5 of them said "Remote" outright in the title.
//
// Only an unambiguous work-arrangement marker counts. A bare /remote/ test
// would admit domain compounds — "Remote Sensing Program Manager" is an
// on-site GIS role, and Esri (a tracked company) posts exactly those. So
// "remote" must be followed by end-of-string, a non-letter (")", ",", "-"),
// or " in …" as in "Remote in MO" — never by another word, which is what makes
// "remote sensing" / "remote monitoring" compounds.
export const REMOTE_TITLE_RE = /(?<![a-z])remote(?=$|\s*[^a-z\s]|\s+in\b)/;

// …and a negation before the word has to lose, which the marker regex alone
// cannot see: in "Non-Remote" / "Not Remote" the delimiter clears the lookbehind
// and the trailing position clears the lookahead, so an explicitly on-site role
// would bypass a non-empty `allow` list — the exact opposite of the intent.
// The separator class must be at least as broad as the marker's own delimiter
// lookahead, or the guard is trivially sidestepped. An ASCII-only `[\s-]*` let
// every non-ASCII dash through — "Non–Remote" (en dash), "Non‑Remote"
// (non-breaking hyphen), em dash, figure dash and minus all still read as
// remote. `[^a-z]*` matches the marker's breadth: it spans any run of
// non-letters, so no punctuation variant can slip between the negation and the
// word.
// It cannot over-reach, because it never crosses a letter: in "Nonprofit
// Program Manager - Remote" the run after "non" starts with "profit", so the
// negation cannot reach "remote". Same for "Not-for-Profit … - Remote",
// "Nordic … - Remote", "Notary … - Remote".
// A negation anywhere in the title disqualifies it. Over-rejecting here is the
// safe direction: this tier only ever *rescues* a posting, so a false negative
// restores the previous behavior while a false positive admits an on-site role.
export const REMOTE_NEGATED_RE = /\b(?:non|not|no)[^a-z]*remote/;

/** @param {unknown} title @returns {boolean} whether the title marks the role remote. */
export function titleSignalsRemote(title) {
  if (typeof title !== 'string' || title.trim() === '') return false;
  const lower = title.toLowerCase();
  if (REMOTE_NEGATED_RE.test(lower)) return false;
  return REMOTE_TITLE_RE.test(lower);
}

// `url` and `title` are optional. Callers that omit them get the original
// location-only semantics, which is what the existing unit tests exercise.
export function buildLocationFilter(locationFilter) {
  if (!locationFilter) return () => true;
  const alwaysAllowKeywords = normalizeKeywordList(locationFilter.always_allow);
  const alwaysAllow = alwaysAllowKeywords.map(compileLocationKeyword);
  // US-targeted configs list the country in always_allow and foreign cities
  // in block. "Dublin, OH" does not contain "United States", so without this
  // expansion block: [Dublin] rejects a real US job. Opt-in on the country
  // token — configs with no US always_allow entry are unchanged.
  if (alwaysAllowKeywords.some(k => US_COUNTRY_ALWAYS_ALLOW.has(k))) {
    alwaysAllow.push(...US_STATE_ALWAYS_ALLOW_MATCHERS);
  }
  const allow = compileLocationKeywordList(locationFilter.allow);
  const block = compileLocationKeywordList(locationFilter.block);
  const blockHard = compileLocationKeywordList(locationFilter.block_hard);
  // Opt-in: fail closed when there is nothing to judge on. Only meaningful when
  // a restricting tier is configured — `{ strict: true }` alone restricts
  // nothing and must not reject every location-less posting (#3276).
  const strict = locationFilter.strict === true
    && (allow.length > 0 || block.length > 0 || blockHard.length > 0);

  return (location, url, title) => {
    const lower = typeof location === 'string' ? location.trim().toLowerCase() : '';
    const hint = locationHintFromUrl(url);
    // Nothing to judge on either field → pass (don't penalize missing data),
    // unless the config opted into strict mode: a location-restricted sweep
    // against a provider that never returns a location would otherwise let
    // every out-of-region posting through (#3276).
    if (lower === '' && hint === '') return !strict;
    const matches = (m) => (lower !== '' && m(lower)) || (hint !== '' && m(hint));
    // `block_hard` is the ONE tier always_allow cannot override. It exists because
    // a European city name can be a whole word inside a non-European location, so
    // word-boundary matching (#2087) does not catch it and always_allow's
    // unconditional win silently discards the user's own block entry:
    //
    //   "Porto Alegre, Rio Grande do Sul, Brazil"  always_allow "Porto" beats block "Brazil"
    //   "USA - New York - Malta"                   always_allow "Malta" beats block "USA"
    //
    // Both configs already listed the country under `block`. Plain `block` cannot
    // be promoted wholesale — always_allow was added in #650 precisely so a
    // multi-location posting survives one blocked city ("Stockholm · London ·
    // Madrid" must not die on a London entry) — so the user marks the entries
    // that are country-level and therefore never a false rejection. Opt-in and
    // additive: a config without `block_hard` behaves exactly as before.
    if (blockHard.length > 0 && blockHard.some(matches)) return false;
    // always_allow still wins over block, and may be satisfied by either field:
    // a genuinely US role whose display string says "United States" is never
    // rejected because of what its URL happens to contain.
    if (alwaysAllow.length > 0 && alwaysAllow.some(matches)) return true;
    if (block.length > 0 && block.some(matches)) return false;
    if (allow.length === 0) return true;
    if (allow.some(matches)) return true;
    // Last resort only. Deliberately placed AFTER `block` so a remote title can
    // never rescue a blocked location — "Program Manager - Remote" in Bengaluru
    // stays rejected. This widens `allow`, never `block`.
    return titleSignalsRemote(title);
  };
}
