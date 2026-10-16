# modes/

The English workflow source of truth for career-ops: Markdown prompt files
loaded by the shared Agent Skill router. Pi and OpenCode are the supported
repository harnesses; product CLI adapters remain separate.

## Purpose

Each mode file defines one workflow (evaluate, apply, scan, ...). The agent
reads the mode plus the shared context and your user files, then executes it.
Routing — which user request triggers which mode — lives in the Skill Modes
table in `AGENTS.md`.

## Mode catalog

| File | Mode | Purpose |
|---|---|---|
| `oferta.md` | `job` | Full A-G evaluation of a single offer |
| `ofertas.md` | `jobs` | Multi-job comparison |
| `auto-pipeline.md` | auto | Full automatic pipeline (evaluate + PDF + tracker) on a pasted JD/URL |
| `pipeline.md` | `pipeline` | Process the URL inbox (`data/pipeline.md`) |
| `scan.md` | `scan` | Portal scanner (job discovery) |
| `batch.md` | `batch` | Mass processing with headless workers |
| `apply.md` | `apply` | Application answer drafts only; the user reviews, enters answers manually, and submits |
| `pdf.md` | `pdf` | ATS-optimized PDF generation |
| `latex.md` | `latex` | LaTeX/Overleaf CV export |
| `text.md` | `text` | Tailored markdown CV (no PDF) |
| `cover.md` | `cover` | Cover letter generator |
| `email.md` | `email` | Application email drafts (draft-only) |
| `contacto.md` | `contacto` | LinkedIn outreach messages |
| `deep.md` | `deep` | Deep company-research prompt |
| `interview.md` | `interview` | Interactive profile & CV onboarding |
| `master-profile.md` | `master-profile` | Source-backed Master Career Profile import and review |
| `interview-prep.md` | `interview-prep` | Company-specific interview intelligence |
| `interview-redflag.md` | `interview-redflag` | Company red-flag detector |
| `offer-prep.md` | `offer-prep` | Contract reading companion (offer stage) |
| `followup.md` | `followup` | Follow-up cadence tracker |
| `reply-watch.md` | `reply-watch` | Classify employer replies, reconcile tracker |
| `outcome.md` | `outcome` | Record application outcome & archive artifacts |
| `tracker.md` | `tracker` | Applications tracker overview |
| `patterns.md` | `patterns` | Rejection pattern detector |
| `calibrate.md` | `calibrate` | Advisory report: do your evaluation scores predict your real outcomes? Reads `/outcome` data; never changes scoring |
| `titles.md` | `titles` | Adjacent job-title suggestions |
| `training.md` | `training` | Training & course evaluation |
| `project.md` | `project` | Portfolio project evaluation |
| `add.md` | `add` | Add a project, paper, or role to the CV (confirm-before-write) |
| `agent-inbox.md` | `agent-inbox` | Queue requests for the next session |
| `update.md` | `update` | Interactive system update |

## Shared context and user customization

| File | Role |
|---|---|
| `_shared.md` | System context shared across modes: scoring system, global rules, source-of-truth boundary. System-owned — never put personal data here |
| `_profile.template.md` | Seed for your `modes/_profile.md` (archetypes, narrative, negotiation scripts) |
| `_custom.template.md` | Seed for your `modes/_custom.md` (house rules, procedural preferences) |

Your copies (`_profile.md`, `_custom.md`) are user-layer files: gitignored
and never touched by `update-system.mjs` (see
[DATA_CONTRACT.md](../DATA_CONTRACT.md)).

## Subdirectories

| Dir | Contents |
|---|---|
| `interview/` | Reusable interview skills: prep planner, practice interviewer, post-interview debrief (see [interview/README.md](interview/README.md)) |
| `heuristics/` | Shared candidate-facing writing heuristics loaded by other modes — `recruiter-side.md` governs PDF summaries, bullets, cover letters, form answers, and outreach |
| `pdf/` | Opt-in passes inside the `pdf` flow, not routable modes — `hm-audit.md` is the hiring-manager read of a tailored CV, run between the fact gate and PDF render when `--hm-audit` is passed |
| `regional/` | Market calibration modes — `eu-swe.md` calibrates applications for European SWE roles (advisory only) |
| `il/` | Supplemental Israeli market context only; not a translated mode implementation |

## Conventions

- One file = one mode; the h1 is `# Mode: <name> — <purpose>`.
- Underscore prefix = shared context or template, not a routable mode.
- Human-facing output language is controlled by `language.output`; it does not select a translated mode tree. The only shipped market supplement is `modes/il/`, when explicitly configured (see `AGENTS.md`).
- Mode files are system-layer: edits belong upstream. User personalization
  goes in `_profile.md` / `_custom.md`, never in the mode files themselves.
