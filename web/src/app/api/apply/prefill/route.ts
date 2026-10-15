import { cliSubstitutionNotice, cliUnavailableError, resolveCliOrFallback } from "@/lib/clis";
import { careerOpsRoot, readMemory } from "@/lib/career-ops";
import { getSession } from "@/lib/apply/session";
import { resolveSessionCv } from "@/lib/apply/cv";
import { applyCvSource } from "@/lib/apply/cv-source.mjs";
import { buildAnswerPrompt } from "@/lib/apply/answer-prompt.mjs";
import { runPlanner } from "@/lib/apply/planner";
import { extractJsonObject } from "@/lib/extract-json-object.mjs";
import { readJsonObject } from "@/lib/json-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 320;

// AI pre-fill (STREAMING NDJSON). The user's BYO CLI (read-only PLANNER — no
// browser access) drafts an answer per field from primary candidate sources.
// Diagnostics stream to the current operator only; candidate/model output is
// not persisted to a debug log.
export async function POST(req: Request) {
  const body = await readJsonObject<{ sessionId?: string; cliId?: string; company?: string; application?: string }>(req);
  if (!body) return Response.json({ error: "bad json" }, { status: 400 });
  const { sessionId, cliId: requestedCliId, company, application } = body;
  // Same two identifiers the fill route takes, validated the same way: they
  // reach a filesystem resolver, so a non-string is refused before it gets there.
  if (company !== undefined && typeof company !== "string") {
    return Response.json({ error: "company must be a string" }, { status: 400 });
  }
  if (application !== undefined && typeof application !== "string") {
    return Response.json({ error: "application must be a string" }, { status: 400 });
  }
  const t0 = Date.now();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          /* client gone */
        }
      };
      const log = (m: string) => {
        const el = Date.now() - t0;
        emit({ t: "log", m, el });
      };
      // Idempotent, like the `closed` guard the sibling routes carry. fail() closes
      // the controller, and there is more than one path to it: a fencing refusal
      // reports through fail() and then resolves with an empty buffer, which the
      // empty-output branch below reports through fail() a second time. Closing an
      // already-closed controller throws "Invalid state", and that throw escapes
      // the async start() as an unhandled rejection — a worse failure than the one
      // being reported.
      let failed = false;
      const fail = (m: string, raw?: string) => {
        if (failed) return;
        failed = true;
        log(`ERROR: ${m}`);
        emit({ t: "error", m, raw });
        controller.close();
      };
      const s = sessionId ? getSession(sessionId) : undefined;
      if (!s) return fail("apply session not found (it may have expired)");
      const resolved = requestedCliId ? resolveCliOrFallback(requestedCliId) : null;
      if (!resolved) return fail(cliUnavailableError(requestedCliId ?? "").error);
      const { spec, binPath } = resolved;
      // The CLI actually running: the planner's fencing and argv are keyed on it.
      const cliId = spec.id;
      const substitution = cliSubstitutionNotice(resolved);
      if (substitution) log(substitution);

      const mem = readMemory().trim();
      // Draft from the SAME tailored CV the fill route uploads to this form,
      // resolved through the one shared call so the answers and the resume
      // stapled to them cannot describe different documents.
      const cvPath = await resolveSessionCv({ company, application, title: s.title });
      const cvSource = cvPath ? applyCvSource(careerOpsRoot(), cvPath) : null;
      const prompt = buildAnswerPrompt({ title: s.title, fields: s.fields, memory: mem, cvSource });

      log(`Form: "${s.title}" · ${s.fields.length} fields · prompt ${prompt.length} chars · memory ${mem.length} chars`);
      log(`CV source: ${cvSource ?? "none found — answers will come from cv.md"}`);
      log(`Planner: ${cliId} (${binPath})`);
      const result = await runPlanner({
        cliId,
        spec,
        binPath,
        prompt,
        fieldCount: s.fields.length,
        cwd: careerOpsRoot(),
        t0,
        log,
      });

      // Fencing refused to start the planner (#2507): runPlanner already logged
      // the reason; report it as THE error, before the empty-output branch below
      // turns it into an unrelated "produced no output".
      if (result.refused) return fail(result.refused);

      log(`Planner exited code=${result.code} signal=${result.signal} · ${result.buf.length} chars total`);

      if (!result.buf.trim()) {
        return fail(result.signal ? "planner was killed before producing any output (try again / smaller form)" : "planner produced no output (check the CLI works in this folder)");
      }

      const { obj, truncated } = extractJsonObject(result.buf);
      if (!obj) {
        return fail(
          result.signal ? "planner was killed mid-answer (form too large/slow) — couldn't recover any fields" : "couldn't parse the planner's answer as JSON",
          result.buf.slice(-300),
        );
      }
      const count = Object.keys(obj).length;
      log(`Parsed ${count} answers${truncated ? " (RECOVERED from truncated output — some fields may be missing)" : ""}`);
      emit({ t: "done", answers: obj, truncated, count });
      controller.close();
    },
  });

  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
