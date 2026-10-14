/**
 * lib/cv-tailoring-engine.mjs — Generates a structured JSON tailoring patch
 * from canonical cv.md, cv/lior_zvieli_cv.tex, and evaluated JD requirements.
 *
 * Core Invariant: The tailoring engine may re-rank, re-phrase, and highlight keywords.
 * It may NEVER fabricate dates, companies, metrics, or technologies.
 *
 * Structured Tailoring Patch schema:
 * {
 *   tailoring_id?: string,
 *   headline_override: string | null,
 *   summary_emphasis: string[],
 *   bullet_priority_order: number[],
 *   keywords_to_surface: string[]
 * }
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

/**
 * Extract bullets from LaTeX itemize environment
 * @param {string} tex
 * @returns {Array<{ index: number, title: string, text: string, raw: string }>}
 */
export function extractLatexBullets(tex) {
  const startTag = '\\begin{itemize}';
  const endTag = '\\end{itemize}';
  const startIdx = tex.indexOf(startTag);
  const endIdx = tex.indexOf(endTag, startIdx);
  if (startIdx === -1 || endIdx === -1) return [];

  const inside = tex.slice(startIdx + startTag.length, endIdx);
  const rawItems = inside.split(/\\item\s+/).map(s => s.trim()).filter(Boolean);

  return rawItems.map((raw, idx) => {
    // Check if item has \textbf{Title:} format
    const match = raw.match(/^\\textbf\{([^}]+)\}:?\s*(.*)$/s);
    const title = match ? match[1].replace(/\\&/g, '&') : '';
    const text = match ? match[2] : raw;
    return {
      index: idx + 1, // 1-indexed as in standard documentation [4, 1, 5, 2, 3, 6, 7]
      title,
      text,
      raw: `\\item ${raw}`
    };
  });
}

/**
 * Score a bullet based on JD requirements keywords and topics
 */
function scoreBullet(bullet, keywords = []) {
  let score = 0;
  const content = (bullet.title + ' ' + bullet.text).toLowerCase();
  for (const kw of keywords) {
    const k = kw.toLowerCase().trim();
    if (!k) continue;
    if (content.includes(k)) score += 3;
    // Word boundary or token check
    const words = k.split(/\s+/);
    for (const w of words) {
      if (w.length > 2 && content.includes(w)) score += 1;
    }
  }
  return score;
}

/**
 * Generates a structured JSON tailoring patch.
 *
 * @param {string|object} cvSource - canonical cv.md content or path
 * @param {string} texSource - cv/lior_zvieli_cv.tex content or path
 * @param {string|object} jdRequirements - Evaluated JD requirements (object or text string)
 * @returns {object} Structured tailoring patch
 */
export function generateTailoringPatch(cvSource, texSource, jdRequirements = {}) {
  const cvText = typeof cvSource === 'string' && existsSync(cvSource)
    ? readFileSync(cvSource, 'utf-8')
    : (typeof cvSource === 'string' ? cvSource : '');

  const texText = typeof texSource === 'string' && existsSync(texSource)
    ? readFileSync(texSource, 'utf-8')
    : (typeof texSource === 'string' ? texSource : '');

  // Normalize JD requirements input
  let reqs = {};
  if (typeof jdRequirements === 'string') {
    if (existsSync(jdRequirements)) {
      try {
        reqs = JSON.parse(readFileSync(jdRequirements, 'utf-8'));
      } catch {
        reqs = { rawText: readFileSync(jdRequirements, 'utf-8') };
      }
    } else {
      try {
        reqs = JSON.parse(jdRequirements);
      } catch {
        reqs = { rawText: jdRequirements };
      }
    }
  } else if (jdRequirements && typeof jdRequirements === 'object') {
    reqs = { ...jdRequirements };
  }

  // 1. Headline override
  let headline_override = null;
  if (reqs.headline_override) {
    headline_override = reqs.headline_override;
  } else if (reqs.headline_target) {
    headline_override = reqs.headline_target;
  } else if (reqs.target_role || reqs.role) {
    const role = reqs.target_role || reqs.role;
    headline_override = `Applied AI Engineer — ${role}`;
  } else if (reqs.role_focus === 'backend' || (reqs.rawText && /backend/i.test(reqs.rawText))) {
    headline_override = 'Applied AI Engineer — Backend Systems Focus';
  }

  // 2. Summary emphasis
  let summary_emphasis = [];
  if (Array.isArray(reqs.summary_emphasis)) {
    summary_emphasis = reqs.summary_emphasis;
  } else if (Array.isArray(reqs.summary_emphasis_themes)) {
    summary_emphasis = reqs.summary_emphasis_themes;
  } else {
    // Default tailored themes anchored in cv.md truth
    summary_emphasis = [
      'Highlight B.Sc. CS graduation (GPA 85)',
      'Emphasize distributed asynchronous data ingestion and Azure Durable Functions'
    ];
  }

  // 3. Bullet priority order
  let bullet_priority_order = [];
  const bullets = extractLatexBullets(texText);
  const totalBullets = bullets.length || 7;

  if (Array.isArray(reqs.bullet_priority_order) && reqs.bullet_priority_order.length > 0) {
    bullet_priority_order = reqs.bullet_priority_order;
  } else {
    // Rank bullets by matching against keywords or JD text
    const keywords = [
      ...(Array.isArray(reqs.keywords_to_surface) ? reqs.keywords_to_surface : []),
      ...(Array.isArray(reqs.priority_keywords) ? reqs.priority_keywords : []),
      ...(reqs.rawText ? reqs.rawText.split(/[\n,;]+/) : [])
    ].filter(Boolean);

    if (keywords.length > 0 && bullets.length > 0) {
      const scored = bullets.map(b => ({
        index: b.index,
        score: scoreBullet(b, keywords)
      }));
      // Sort descending by score, tie-break by original index
      scored.sort((a, b) => b.score - a.score || a.index - b.index);
      bullet_priority_order = scored.map(s => s.index);
    } else {
      // Default recommended prioritization for backend/asynchronous focus
      // Bullet 4: Distributed Ingestion & Structured Extraction (Azure Durable Functions)
      // Bullet 1: System Architecture & Agentic Workflows
      // Bullet 5: Reliability & AI Evaluation
      // Bullet 2: Hybrid Retrieval & Graph Reasoning
      // Bullet 3: Entity Resolution & Investigative Graphs
      // Bullet 6: Testing, Security & Observability
      // Bullet 7: Full-Stack Product Delivery
      bullet_priority_order = [4, 1, 5, 2, 3, 6, 7];
    }
  }

  // Ensure all bullet indices 1..totalBullets are present exactly once
  const existingSet = new Set(bullet_priority_order);
  for (let i = 1; i <= totalBullets; i++) {
    if (!existingSet.has(i)) {
      bullet_priority_order.push(i);
    }
  }
  bullet_priority_order = bullet_priority_order.slice(0, totalBullets);

  // 4. Keywords to surface
  let keywords_to_surface = [];
  if (Array.isArray(reqs.keywords_to_surface) && reqs.keywords_to_surface.length > 0) {
    keywords_to_surface = [...reqs.keywords_to_surface];
  } else if (Array.isArray(reqs.priority_keywords) && reqs.priority_keywords.length > 0) {
    keywords_to_surface = [...reqs.priority_keywords];
  } else {
    keywords_to_surface = [
      'CI/CD',
      'Asynchronous Systems',
      'Clean Code',
      'Pydantic',
      'REST APIs'
    ];
  }

  const tailoringPatch = {
    tailoring_id: reqs.tailoring_id || 'cv-tailoring-patch',
    headline_override,
    summary_emphasis,
    bullet_priority_order,
    keywords_to_surface
  };

  return tailoringPatch;
}
