"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ApplyField } from "@/lib/apply/extract";
import type { ApplyIssue } from "@/lib/apply/issue";
import { resolveLateSession } from "@/lib/apply/exit.mjs";
type Meta = { needsConfirmation?: boolean };
type Status = "idle" | "opening" | "prefilling" | "ready" | "error";

type ApplyCtx = {
  status: Status;
  url: string;
  title: string;
  company: string;
  /** Tracker row this session was opened for, "" when opened from a pasted URL. */
  n: string;
  /** Path the session was opened from, so the page has somewhere to go back to. */
  from: string;
  fields: ApplyField[];
  answers: Record<string, string>;
  meta: Record<string, Meta>;
  shots: string[];
  prefillLog: string[];
  issues: ApplyIssue[];
  error: string;
  open: (url: string, opts?: { prefill?: boolean; company?: string; n?: string; from?: string }) => Promise<void>;
  prefill: () => Promise<void>;
  setAnswer: (idOrLabel: string, value: string) => void;
  reset: () => void;
};

const Ctx = createContext<ApplyCtx | null>(null);
export function useApply(): ApplyCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useApply must be used within <ApplyProvider>");
  return c;
}

/** Release the headless browser behind a session id. Fire-and-forget: the page
 *  is usually navigating away as this goes out, hence keepalive. */
function closeSession(id: string) {
  void fetch("/api/apply/close", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: id }), keepalive: true }).catch(() => {});
}

const CONFIG_KEY = "career-ops:config";
function cliId(): string | null {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}").cliId || null;
  } catch {
    return null;
  }
}

export function ApplyProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("idle");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [company, setCompany] = useState("");
  const [n, setN] = useState("");
  const [from, setFrom] = useState("");
  const [fields, setFields] = useState<ApplyField[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [meta, setMeta] = useState<Record<string, Meta>>({});
  const [shots, setShots] = useState<string[]>([]);
  const [prefillLog, setPrefillLog] = useState<string[]>([]);
  const [issues, setIssues] = useState<ApplyIssue[]>([]);
  const [error, setError] = useState("");
  const sessionId = useRef<string | null>(null);
  const companyRef = useRef<string>("");
  // Mirrors `n` for the async fetch below, same reason as companyRef: the
  // fetch fires after state may have moved on, so a plain closure over `n`
  // could send a stale (or, worse, the NEXT session's) report identity.
  const nRef = useRef<string>("");
  const fieldsRef = useRef<ApplyField[]>([]);
  fieldsRef.current = fields;
  const answersRef = useRef<Record<string, string>>({});
  answersRef.current = answers;
  // Bumped every time a session is abandoned or replaced. Leaving the page is
  // reachable while a request or stream is still in flight, and none of them can
  // be recalled, so each one carries the generation it started in and drops its
  // results if that generation is no longer current.
  const generation = useRef(0);
  // When a session opens with {prefill:true}, auto-fire prefill once fields are
  // ready — driven by an effect (not a fragile setTimeout) so it can't race the
  // session response or a navigation.
  const pendingPrefill = useRef(false);

  const open = useCallback(async (u: string, opts?: { prefill?: boolean; company?: string; n?: string; from?: string }) => {
    const gen = ++generation.current;
    // Opening a second form abandons the first one's browser exactly the way
    // leaving the page does, so it is released here too.
    if (sessionId.current) closeSession(sessionId.current);
    sessionId.current = null;
    setStatus("opening");
    setError("");
    setFields([]);
    setAnswers({});
    setMeta({});
    setShots([]);
    setIssues([]);
    setUrl(u);
    setCompany(opts?.company ?? "");
    companyRef.current = opts?.company ?? "";
    setN(opts?.n ?? "");
    nRef.current = opts?.n ?? "";
    setFrom(opts?.from ?? "");
    pendingPrefill.current = false;
    try {
      const r = await fetch("/api/apply/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: u, cliId: cliId() }) });
      const d = await r.json();
      // The user can leave while this is in flight, and the request can't be
      // recalled — a session that lands after they left is closed here or its
      // headless browser runs forever, unreferenced.
      const late = resolveLateSession({ stale: generation.current !== gen, sessionId: d.id });
      if (late !== "apply") {
        if (late === "close") closeSession(d.id);
        return;
      }
      if (d.error) {
        setError(d.error);
        setStatus("error");
        return;
      }
      sessionId.current = d.id;
      setTitle(d.title);
      setShots(d.shots ?? []);
      pendingPrefill.current = !!opts?.prefill;
      setFields(d.fields);
      setIssues(d.issues ?? []);
      setStatus("ready");
    } catch {
      if (generation.current !== gen) return; // left while it was opening
      setError("Could not open the form.");
      setStatus("error");
    }
  }, []);

  const prefill = useCallback(async () => {
    if (!sessionId.current) return;
    const gen = generation.current;
    if (!cliId()) {
      setError("Configure a CLI in Config first, then pre-fill from your CV.");
      return;
    }
    setStatus("prefilling");
    setError("");
    setPrefillLog([]);
    const applyAnswers = (raw: Record<string, { value?: string; needs_confirmation?: boolean }>) => {
      const a: Record<string, string> = {};
      const m: Record<string, Meta> = {};
      for (const [id, v] of Object.entries(raw)) {
        a[id] = v?.value ?? "";
        m[id] = { needsConfirmation: !!v?.needs_confirmation };
      }
      setAnswers(a);
      setMeta(m);
    };
    try {
      // Keep identity with the pre-fill request so the intended application's
      // candidate-specific source is resolved, without routing to a live form.
      const r = await fetch("/api/apply/prefill", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: sessionId.current, cliId: cliId(), company: companyRef.current, application: nRef.current }) });
      if (generation.current !== gen) return; // left mid-prefill
      if (!r.body) {
        setError("Couldn't pre-fill — no response stream.");
        setStatus("ready");
        return;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let got = false;
      let sawError = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (generation.current !== gen) return; // left mid-prefill
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev: { t?: string; m?: string; el?: number; raw?: string; answers?: Record<string, { value?: string; needs_confirmation?: boolean }>; count?: number; truncated?: boolean };
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.t === "log") {
            setPrefillLog((p) => [...p, `+${((ev.el ?? 0) / 1000).toFixed(1)}s  ${ev.m}`]);
          } else if (ev.t === "done") {
            got = true;
            applyAnswers(ev.answers ?? {});
            if ((ev.count ?? 0) === 0) setError("The planner returned 0 answers — see the diagnostics log below.");
            else if (ev.truncated) setError("The planner was cut off — some fields were recovered, others may be blank. See diagnostics.");
          } else if (ev.t === "error") {
            sawError = true;
            setError(ev.m ? `Couldn't pre-fill: ${ev.m}` : "Couldn't pre-fill from your CV.");
            setPrefillLog((p) => [...p, `✗ ${ev.m ?? "error"}${ev.raw ? ` — raw tail: ${ev.raw.slice(0, 160)}` : ""}`]);
          }
        }
      }
      if (generation.current !== gen) return; // left mid-prefill
      if (!got && !sawError) setError("Pre-fill ended without answers — see the diagnostics log below.");
      setStatus("ready");
    } catch (e) {
      if (generation.current !== gen) return; // left mid-prefill
      setError(`Couldn't pre-fill from your CV: ${e instanceof Error ? e.message : "stream error"}. See diagnostics.`);
      setStatus("ready");
    }
  }, []);

  // Auto-prefill exactly once after the fields are ready.
  useEffect(() => {
    if (status === "ready" && pendingPrefill.current) {
      pendingPrefill.current = false;
      void prefill();
    }
  }, [status, prefill]);

  const setAnswer = useCallback((idOrLabel: string, value: string) => {
    const fs = fieldsRef.current;
    const key = idOrLabel.toLowerCase();
    const f =
      fs.find((x) => x.id === idOrLabel) ||
      fs.find((x) => x.label.toLowerCase().includes(key)) ||
      fs.find((x) => key.includes(x.label.toLowerCase()) && x.label.length > 2);
    if (f) setAnswers((prev) => ({ ...prev, [f.id]: value }));
  }, []);

  const reset = useCallback(() => {
    // Invalidate anything still in flight before clearing state, so a response
    // that lands after this can't repopulate the page the user just left.
    generation.current += 1;
    if (sessionId.current) closeSession(sessionId.current);
    sessionId.current = null;
    companyRef.current = "";
    nRef.current = "";
    pendingPrefill.current = false;
    setStatus("idle");
    setUrl("");
    setTitle("");
    setCompany("");
    setN("");
    setFrom("");
    setFields([]);
    setAnswers({});
    setMeta({});
    setShots([]);
    setPrefillLog([]);
    setIssues([]);
    setError("");
  }, []);

  const value = useMemo(
    () => ({ status, url, title, company, n, from, fields, answers, meta, shots, prefillLog, issues, error, open, prefill, setAnswer, reset }),
    [status, url, title, company, n, from, fields, answers, meta, shots, prefillLog, issues, error, open, prefill, setAnswer, reset],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
