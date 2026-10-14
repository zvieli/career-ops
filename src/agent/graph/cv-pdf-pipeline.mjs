import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateTailoringPatch } from '../domain/candidate/cv-tailoring-engine.mjs';
import { applyLatexPatch } from '../infrastructure/documents/latex-patcher.mjs';
import { extractLatexBullets } from '../domain/candidate/cv-tailoring-engine.mjs';
import { validatePdf, validatePdfArtifact } from '../infrastructure/documents/pdf-validator.mjs';
import { verifyFacts } from '../../../verify-cv-facts.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const POLICY_VERSION = 'reorder-only-v1';

function readRequired(path, label) {
  if (!existsSync(path)) throw new Error(`Required canonical CV source is unavailable: ${label}.`);
  return readFileSync(path, 'utf8');
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
  const configPath = join(root, 'config', 'cv-facts.json');
  const sourcePaths = () => [markdownPath, ...(existsSync(articlePath) ? [articlePath] : [])];

  return Object.freeze({
    generate({ jdText = '' } = {}) {
      const cvMarkdown = readRequired(markdownPath, 'cv.md');
      const sourceTex = readRequired(texPath, 'cv/lior_zvieli_cv.tex');
      const originalBullets = extractLatexBullets(sourceTex);
      if (!originalBullets.length) throw new Error('Canonical LaTeX CV has no supported bullet list to tailor.');

      // JD content influences ordering only. No JD phrase, keyword, or evaluation
      // output is ever inserted into candidate-facing content.
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
      const articleContent = existsSync(articlePath) ? readFileSync(articlePath) : null;
      const sourcePathsAtGeneration = sourcePaths();
      const factuality = verifySourceText(tex, sourcePathsAtGeneration, configPath);
      const sourceHashes = {
        markdown: sha256(cvMarkdown), latex: sha256(sourceTex),
        article: articleContent === null ? null : sha256(articleContent)
      };
      if (sha256(readFileSync(markdownPath)) !== sourceHashes.markdown
        || sha256(readFileSync(texPath)) !== sourceHashes.latex
        || (existsSync(articlePath) ? sha256(readFileSync(articlePath)) : null) !== sourceHashes.article) {
        throw new Error('Canonical CV sources changed during tailoring; refusing a mixed-source artifact.');
      }
      const fingerprint = sha256(JSON.stringify({ jd_hash: sha256(jdText), sourceHashes, policy: POLICY_VERSION, output: sha256(tex) }));
      return { tex, fingerprint, sourceHashes, policyVersion: POLICY_VERSION, factuality,
        bulletCount: tailoredBullets.length, changedOrder: originalBullets.map((item) => item.raw).join('\n') !== tailoredBullets.map((item) => item.raw).join('\n') };
    },

    validateArtifact({ pdfPath: inputPath } = {}) {
      return validatePdfArtifact(inputPath, { sourcePaths: sourcePaths(), configPath });
    },

    async validate({ texPath: inputPath } = {}) {
      if (typeof inputPath !== 'string' || !existsSync(inputPath)) throw new Error('Persisted tailored CV artifact is unavailable for PDF validation.');
      const outputDir = mkdtempSync(join(tmpdir(), 'career-ops-pdf-'));
      try {
        const result = await validatePdfImpl(inputPath, {
          outputDir,
          factualityMode: 'source-backed',
          sourcePaths: sourcePaths(),
          configPath,
          cvMdPath: markdownPath
        });
        if (!result?.success || !result.pdfPath || !existsSync(result.pdfPath)) {
          throw new Error(`PDF validation failed: ${(result?.errors || []).join('; ') || 'validation did not produce a PDF'}`);
        }
        const pdfBytes = readFileSync(result.pdfPath);
        if (!pdfBytes.length) throw new Error('PDF validation produced an empty artifact.');
        return { pdfBytes, pageCount: result.pageCount, textCharCount: result.textCharCount,
          factuality: result.factuality };
      } finally {
        rmSync(outputDir, { recursive: true, force: true });
      }
    }
  });
}
