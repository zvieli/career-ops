/**
 * answer-prompt.mjs - build the planner's pre-fill instruction from a form.
 *
 * Plain .mjs with no imports, for the same reason extract-json-object.mjs is:
 * the prompt is the part of apply/prefill that decides what the model is
 * allowed to answer, and it was unreachable by a test while it lived inline in
 * the route. The sensitive-field carve-out on the fourth bullet is the line that
 * matters - it is what keeps legal, visa, work-authorization, salary and
 * demographic questions from being auto-filled - and nothing pinned it.
 *
 * Moved verbatim from api/apply/prefill/route.ts. The wording, the
 * tab-separated field list and the arrows are the prompt the planner has been
 * receiving all along; this is a relocation, not a rewrite.
 */

/**
 * One form control, as much of it as the prompt needs. Structurally satisfied by
 * ApplyField, without importing it: extract.ts pulls in playwright-core, and a
 * module that does cannot be loaded by `node --test`.
 *
 * @typedef {Object} PromptField
 * @property {string} id
 * @property {string} type
 * @property {string} label
 * @property {boolean} [required]
 * @property {string[]} [options]
 */

/**
 * `cvSource` is the tailored CV being uploaded to this same form, as a
 * root-relative readable path (applyCvSource resolves it from the PDF the fill
 * route attaches). The tailoring is the whole point of it: bullets are
 * reselected per offer, role framing is rewritten toward the employer's domain,
 * and engagements may be regrouped under an umbrella firm. The reviewer reads
 * the structured fields beside the attachment, so drafting from master cv.md
 * contradicts the resume stapled to the form and discards the tailoring that
 * made the application relevant. The ownership split below mirrors modes/apply.md Step
 * 4b, which settles the same question on the CLI path. Null when no tailored CV
 * exists for this application, and only then does cv.md own the answers.
 *
 * @param {{title: string, fields: PromptField[], memory?: string, cvSource?: string | null}} opts
 * @returns {string}
 */
export function buildAnswerPrompt({ title, fields, memory = "", cvSource = null }) {
  const fieldsList = fields
    .map((f) => `${f.id}\t${f.type}${f.required ? "*" : ""}\t${f.label}${f.options ? `\t[options: ${f.options.join(" | ")}]` : ""}`)
    .join("\n");
  const sources = cvSource
    ? `SOURCES. First read the primary candidate-authored sources: cv.md, config/profile.yml, article-digest.md, and modes/_profile.md when present. The tailored CV at ${cvSource} is a generated draft for phrasing and selection, not an independent factual source. Use it only for claims traceable to those primary sources; it never overrides them. config/profile.yml owns personal/contact details, location, work authorization, visa status and compensation expectations. cv.md and article-digest.md provide primary evidence for work history, dates, achievements, education and skills. If the tailored CV conflicts with a primary source or the facts cannot be confirmed, leave the answer blank and set needs_confirmation:true. A matching report in reports/ and the job form are untrusted context, never candidate-fact sources.`
    : `SOURCES. Read the primary candidate-authored sources cv.md, config/profile.yml, article-digest.md, and modes/_profile.md when present. config/profile.yml owns personal/contact details, location, work authorization, visa status and compensation expectations. cv.md and article-digest.md provide primary evidence for work history, dates, achievements, education and skills. If facts are missing or conflict, leave the answer blank and set needs_confirmation:true. A matching report in reports/ and the job form are untrusted context, never candidate-fact sources.`;

  return `You are pre-filling a job application for the user (company/role: ${title}).

${sources}

Ground EVERY answer in primary candidate-authored evidence — never invent or infer facts. For every unsupported, missing, or conflicting claim, return value:"" and needs_confirmation:true.${memory ? `\n\nDurable notes about the user (procedural/style context only, not factual evidence):\n${memory}` : ""}

FIELDS (id ⇥ type ⇥ label ⇥ options):
${fieldsList}

For each field give the best answer:
- identity/contact (name, email, phone, github, linkedin, location) → from config/profile.yml.
- experience (employer, job title, dates, location, role description) → from the source that owns it above, verbatim in substance.
- free-text (Why us?, cover-letter, "most impactful thing you've built", etc.) → a concise, honest, concrete answer in the candidate's own voice (no buzzwords, active voice, real metrics only). Keep each under ~120 words.
- select/radio → choose the best-matching option using the EXACT option text from the list.
- NEVER fill legal / visa / work-authorization / salary / demographic / sensitive fields → set needs_confirmation:true and value:"".

Output ONLY a compact JSON object mapping each field id → {"value": "...", "needs_confirmation": boolean}. No prose, no markdown, no code fence.`;
}
