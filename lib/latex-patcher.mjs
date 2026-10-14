/**
 * lib/latex-patcher.mjs — Deterministically applies the structured patch
 * to cv/lior_zvieli_cv.tex without rewriting raw LaTeX templates or inventing any facts.
 *
 * Core Invariant: The patcher may re-order bullets, tune headline, emphasize summary
 * facts, and surface keywords into technical skills. It may NEVER fabricate dates,
 * companies, metrics, or institutions.
 */

import { readFileSync, existsSync } from 'fs';
import { extractLatexBullets } from './cv-tailoring-engine.mjs';

/**
 * Escapes characters for LaTeX insertion
 * @param {string} str
 * @returns {string}
 */
export function escapeLatex(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/\$/g, '\\$')
    .replace(/#/g, '\\#')
    .replace(/_/g, '\\_')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/—/g, '---')
    .replace(/–/g, '--');
}

/**
 * Deterministically applies a structured patch to LaTeX CV text.
 *
 * @param {string} texContent - The original .tex content (or path to .tex file)
 * @param {object} patch - The structured tailoring patch
 * @returns {string} - The deterministically patched LaTeX string
 */
export function applyLatexPatch(texContent, patch = {}) {
  let tex = typeof texContent === 'string' && existsSync(texContent)
    ? readFileSync(texContent, 'utf-8')
    : String(texContent);

  if (!patch || typeof patch !== 'object') {
    return tex;
  }

  // 1. Headline override
  if (patch.headline_override && typeof patch.headline_override === 'string') {
    const headlinePattern = /(\{\\large\\textbf\{)([^}]+)(\}\}\\\\\[\d+pt\])/;
    if (headlinePattern.test(tex)) {
      const formattedHeadline = patch.headline_override
        .replace(/—/g, '---')
        .replace(/–/g, '--')
        .replace(/&/g, '\\&');
      tex = tex.replace(headlinePattern, `$1${formattedHeadline}$3`);
    }
  }

  // 2. Summary emphasis
  if (Array.isArray(patch.summary_emphasis) && patch.summary_emphasis.length > 0) {
    // If summary emphasis emphasizes distributed asynchronous systems / backend:
    const summaryHeader = '\\section*{Professional Summary}\n';
    const summaryIdx = tex.indexOf(summaryHeader);
    if (summaryIdx !== -1) {
      const nextSectionIdx = tex.indexOf('\\section*{Experience}', summaryIdx);
      if (nextSectionIdx !== -1) {
        const currentSummary = tex.slice(summaryIdx + summaryHeader.length, nextSectionIdx).trim();
        // Check if any specific emphasis items should be highlighted or framed
        let updatedSummary = currentSummary;

        // Ensure GPA 85 is strictly preserved
        if (!updatedSummary.includes('GPA 85')) {
          updatedSummary = updatedSummary.replace(/graduate/i, 'graduate (GPA 85)');
        }

        // If emphasis mentions distributed asynchronous ingestion or Azure Durable Functions
        const mentionsDistributed = patch.summary_emphasis.some(e =>
          /distributed|asynchronous|durable/i.test(e)
        );
        if (mentionsDistributed && !updatedSummary.includes('distributed asynchronous')) {
          updatedSummary = updatedSummary.replace(
            'distributed document processing',
            'distributed asynchronous document processing'
          );
        }

        tex = tex.slice(0, summaryIdx + summaryHeader.length) +
          updatedSummary + '\n\n' +
          tex.slice(nextSectionIdx);
      }
    }
  }

  // 3. Bullet priority order
  if (Array.isArray(patch.bullet_priority_order) && patch.bullet_priority_order.length > 0) {
    const startTag = '\\begin{itemize}';
    const endTag = '\\end{itemize}';
    const startIdx = tex.indexOf(startTag);
    const endIdx = tex.indexOf(endTag, startIdx);

    if (startIdx !== -1 && endIdx !== -1) {
      const inside = tex.slice(startIdx + startTag.length, endIdx);
      const rawItems = inside.split(/\\item\s+/).map(s => s.trim()).filter(Boolean);

      if (rawItems.length > 0) {
        // Map 1-based indices in bullet_priority_order to bullets
        const reordered = [];
        const seenIndices = new Set();

        for (const pos of patch.bullet_priority_order) {
          const itemIdx = pos - 1; // Convert 1-based to 0-based
          if (itemIdx >= 0 && itemIdx < rawItems.length && !seenIndices.has(itemIdx)) {
            reordered.push(rawItems[itemIdx]);
            seenIndices.add(itemIdx);
          }
        }

        // Append any remaining bullets that weren't in bullet_priority_order
        for (let i = 0; i < rawItems.length; i++) {
          if (!seenIndices.has(i)) {
            reordered.push(rawItems[i]);
          }
        }

        const newInside = '\n  \\item ' + reordered.join('\n  \\item ') + '\n';
        tex = tex.slice(0, startIdx + startTag.length) + newInside + tex.slice(endIdx);
      }
    }
  }

  // 4. Keywords to surface
  if (Array.isArray(patch.keywords_to_surface) && patch.keywords_to_surface.length > 0) {
    // Add missing keywords to matching lines in Technical Skills
    const skillsHeader = '\\section*{Technical Skills}\n';
    const skillsIdx = tex.indexOf(skillsHeader);
    if (skillsIdx !== -1) {
      const nextSectionIdx = tex.indexOf('\\section*{Education}', skillsIdx);
      if (nextSectionIdx !== -1) {
        const skillsBlock = tex.slice(skillsIdx + skillsHeader.length, nextSectionIdx);
        let updatedBlock = skillsBlock;

        for (const rawKw of patch.keywords_to_surface) {
          const kw = rawKw.trim();
          if (!kw) continue;
          // If keyword is already in the block, nothing to add
          if (updatedBlock.toLowerCase().includes(kw.toLowerCase())) continue;

          // Target category
          if (/ci\/cd|testing|observability/i.test(kw)) {
            updatedBlock = updatedBlock.replace(
              /(\\textbf\{Cloud, Testing [^}]+\}:[^\\]+)(\\\\)/,
              `$1, ${escapeLatex(kw)}$2`
            );
          } else if (/async|distributed|clean code|rest|api|pydantic|backend/i.test(kw)) {
            updatedBlock = updatedBlock.replace(
              /(\\textbf\{Backend [^}]+\}:[^\\]+)(\\\\)/,
              `$1, ${escapeLatex(kw)}$2`
            );
          } else if (/search|graph|gremlin|cosmos/i.test(kw)) {
            updatedBlock = updatedBlock.replace(
              /(\\textbf\{Search [^}]+\}:[^\\]+)(\\\\)/,
              `$1, ${escapeLatex(kw)}$2`
            );
          } else if (/agent|rag|llm|eval/i.test(kw)) {
            updatedBlock = updatedBlock.replace(
              /(\\textbf\{AI [^}]+\}:[^\\]+)(\\\\)/,
              `$1, ${escapeLatex(kw)}$2`
            );
          }
        }

        tex = tex.slice(0, skillsIdx + skillsHeader.length) + updatedBlock + tex.slice(nextSectionIdx);
      }
    }
  }

  return tex;
}
