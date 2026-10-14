import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateTailoringPatch, extractLatexBullets } from '../domain/candidate/cv-tailoring-engine.mjs';
import { applyLatexPatch } from '../infrastructure/documents/latex-patcher.mjs';
import { hasCanonicalPdfQuality, validatePdf, validatePdfArtifact } from '../infrastructure/documents/pdf-validator.mjs';
import { stripMarkup, verifyFacts } from '../../../verify-cv-facts.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const POLICY_VERSION = 'reorder-only-v1';
const LATEX_ESCAPE = String.fromCharCode(92);

function readRequired(path, label) {
  if (!existsSync(path)) throw new Error(`Required canonical CV source is unavailable: ${label}.`);
  return readFileSync(path, 'utf8');
}

function normalizedVisibleText(text) {
  return stripMarkup(String(text ?? '').split(`${LATEX_ESCAPE}&`).join('&'))
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function latexVisibleTextBlocks(tex) {
  const startMarker = `${LATEX_ESCAPE}begin{document}`;
  const endMarker = `${LATEX_ESCAPE}end{document}`;
  const start = tex.indexOf(startMarker);
  const end = tex.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error('Canonical LaTeX source has no supported document body.');
  let body = tex.slice(start + startMarker.length, end);
  const commands = [...body.matchAll(/\\([A-Za-z]+)\*?/g)].map((match) => match[1]);
  const allowed = new Set(['begin', 'end', 'section', 'fontsize', 'selectfont', 'textbf', 'textit', 'textbar', 'href', 'mbox', 'vspace', 'item', 'quad', 'hfill', 'times', 'LARGE', 'large']);
  if (commands.some((command) => !allowed.has(command))) throw new Error('Canonical LaTeX source uses unsupported visible-text markup.');
  const environments = [...body.matchAll(/\\(?:begin|end)\{([^}]+)\}/g)].map((match) => match[1]);
  if (environments.some((environment) => !['center', 'itemize'].includes(environment))) {
    throw new Error('Canonical LaTeX source uses an unsupported content environment.');
  }
  body = body.replace(/\\href\{([^{}]*)\}\{([^{}]*)\}/g, '\n$2\n$1\n');
  if (body.includes(`${LATEX_ESCAPE}href`)) throw new Error('Canonical LaTeX source has an unsupported hyperlink shape.');
  body = body
    .replace(/\\(?:begin|end)\{(?:center|itemize)\}/g, '\n')
    .replace(/\\item\b/g, '\n')
    .replace(/\\(?:quad|hfill|textbar)\b/g, '\n')
    .replace(/\\vspace(?:\[[^\]]*\])?\{[^{}]*\}|\\fontsize\{[^{}]*\}\{[^{}]*\}|\\selectfont/g, '\n')
    .replace(/\\\\(?:\[[^\]]*\])?/g, '\n')
    .replace(/\$\\[a-zA-Z]+\$/g, ' ');
  return stripMarkup(body, { keepLineBreaks: true }).split(/\n+/).map(normalizedVisibleText).filter(Boolean);
}

function assertLatexContentBacked(tex, sourcePaths) {
  const approvedSources = sourcePaths.filter((path) => existsSync(path)).map((path) => readFileSync(path, 'utf8'));
  if (!approvedSources.length) throw new Error('Source-backed CV generation requires canonical Markdown or article evidence.');
  const sourceBlocks = approvedSources.flatMap((source) => source.split(/\n\s*\n/).map(normalizedVisibleText));
  if (latexVisibleTextBlocks(tex).some((block) => !sourceBlocks.some((source) => source.includes(block)))) {
    throw new Error('Canonical LaTeX content is not backed by approved CV sources.');
  }
  return true;
}

function verifySourceText(text, sourcePaths, configPath) {
  const result = verifyFacts(text, { sourcePaths, configPath });
  if (result.verdict === 'block') throw new Error('Source-backed CV fact gate blocked unsupported or invented claims.');
  return result;
}

/** Production, deterministic CV/PDF stages. Tailoring is deliberately reorder-only. */
export function createCvPdfPipeline({ dataRoot, validatePdfImpl = validatePdf } = {}) {
  const root = resolve(dataRoot || process.cwd());
  const markdownPath = join(root, 'cv.md');
  const texPath = join(root, 'cv', 'lior_zvieli_cv.tex');
  const articlePath = join(root, 'article-digest.md');
  const factConfigPath = join(root, 'config', 'cv-facts.json');
  const sourcePaths = () => [markdownPath, ...(existsSync(articlePath) ? [articlePath] : [])];

  return Object.freeze({
    generate({ jdText = '' } = {}) {
      const cvMarkdown = readRequired(markdownPath, 'cv.md');
      const sourceTex = readRequired(texPath, 'cv/lior_zvieli_cv.tex');
      const originalBullets = extractLatexBullets(sourceTex);
      if (!originalBullets.length) throw new Error('Canonical LaTeX CV has no supported bullet list to tailor.');

      const sourcePathsAtGeneration = sourcePaths();
      const articleContent = existsSync(articlePath) ? readFileSync(articlePath) : null;
      const configContent = existsSync(factConfigPath) ? readFileSync(factConfigPath) : null;
      assertLatexContentBacked(sourceTex, sourcePathsAtGeneration);
      // JD content affects ordering only; no JD language or skills are inserted.
      const patch = generateTailoringPatch(cvMarkdown, sourceTex, { rawText: jdText });
      const tex = applyLatexPatch(sourceTex, {
        headline_override: null,
        summary_emphasis: [],
        bullet_priority_order: patch.bullet_priority_order,
        keywords_to_surface: []
      });
      const tailoredBullets = extractLatexBullets(tex);
      const before = originalBullets.map((item) => item.raw).sort();
      const after = tailoredBullets.map((item) => item.raw).sort();
      if (before.length !== after.length || before.some((item, index) => item !== after[index])) {
        throw new Error('Reorder-only tailoring changed or dropped canonical CV bullet content.');
      }
      assertLatexContentBacked(tex, sourcePathsAtGeneration);
      const factuality = verifySourceText(tex, sourcePathsAtGeneration, factConfigPath);
      const sourceHashes = {
        markdown: sha256(cvMarkdown), latex: sha256(sourceTex),
        article: articleContent === null ? null : sha256(articleContent),
        factConfig: configContent === null ? null : sha256(configContent)
      };
      if (sha256(readFileSync(markdownPath)) !== sourceHashes.markdown
        || sha256(readFileSync(texPath)) !== sourceHashes.latex
        || (existsSync(articlePath) ? sha256(readFileSync(articlePath)) : null) !== sourceHashes.article
        || (existsSync(factConfigPath) ? sha256(readFileSync(factConfigPath)) : null) !== sourceHashes.factConfig) {
        throw new Error('Canonical CV sources or fact policy changed during tailoring; refusing a mixed-source artifact.');
      }
      const fingerprint = sha256(JSON.stringify({ jd_hash: sha256(jdText), sourceHashes, policy: POLICY_VERSION, output: sha256(tex) }));
      return { tex, fingerprint, sourceHashes, policyVersion: POLICY_VERSION, factuality,
        bulletCount: tailoredBullets.length, changedOrder: originalBullets.map((item) => item.raw).join('\n') !== tailoredBullets.map((item) => item.raw).join('\n') };
    },

    validateArtifact({ pdfPath: inputPath } = {}) {
      return validatePdfArtifact(inputPath, { sourcePaths: sourcePaths(), configPath: factConfigPath });
    },

    async validate({ texPath: inputPath } = {}) {
      if (typeof inputPath !== 'string' || !existsSync(inputPath)) throw new Error('Persisted tailored CV artifact is unavailable for PDF validation.');
      const outputDir = mkdtempSync(join(tmpdir(), 'career-ops-pdf-'));
      try {
        const result = await validatePdfImpl(inputPath, {
          outputDir,
          factualityMode: 'source-backed',
          sourcePaths: sourcePaths(),
          configPath: factConfigPath,
          cvMdPath: markdownPath
        });
        if (!result?.success || !result.pdfPath || !existsSync(result.pdfPath)
          || !hasCanonicalPdfQuality(result.pageCount, result.textCharCount)) {
          throw new Error(`PDF validation failed: ${(result?.errors || []).join('; ') || 'PDF must be exactly one page with more than 1000 extractable characters'}`);
        }
        const pdfBytes = readFileSync(result.pdfPath);
        if (!pdfBytes.length) throw new Error('PDF validation produced an empty artifact.');
        return { pdfBytes, pageCount: result.pageCount, textCharCount: result.textCharCount, factuality: result.factuality };
      } finally {
        rmSync(outputDir, { recursive: true, force: true });
      }
    }
  });
}
