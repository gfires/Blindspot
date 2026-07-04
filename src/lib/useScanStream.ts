/**
 * useScanStream.ts — client hook that runs a scan and reduces the SSE stream into UI state.
 *
 * FOR FUTURE AGENTS: This is the client counterpart to app/api/scan/route.ts. It POSTs the
 * industry, reads the `data: {json}` SSE frames off the response body, and folds each ScanEvent
 * into a `ScanState`. The live exploration UI (ScanProgress) renders straight off this state:
 * intents, per-intent search status, the streaming source list, and per-source scrape status.
 *
 * Everything the "watch it explore" experience needs is in `state.trace`.
 */
"use client";

import { useCallback, useRef, useState } from "react";
import type { ScanEvent, ScanPhase } from "./events";
import { phaseFor } from "./events";
import type { ScanReport } from "./schema";
import { fmtMs } from "./format";

/** Live status of a single search intent, including the exact query sent to Firecrawl. */
export interface IntentStatus {
  label: string;
  query: string;
  status: "pending" | "searching" | "done";
  count: number;
  ms: number; // search latency for this intent (0 until done)
}

/** The exact prompt sent to the model, surfaced for full transparency. */
export interface PromptTrace {
  model: string;
  systemPrompt: string;
  userPrompt: string;
}

/**
 * Live status of a single source as it moves through scraping. `scrape` states:
 *   queued   — selected, not yet reached
 *   scraping — request in flight
 *   ok       — content retrieved
 *   blocked  — hard anti-scraping block (403/etc.); domain just added to the blocklist
 *   skipped  — not attempted; domain was already a known blocker
 *   empty    — transient failure (timeout/404/5xx); no content, not blocklisted
 * `ms` is that page's scrape latency (0 for skipped).
 */
export interface SourceStatus {
  id: number;
  url: string;
  domain: string;
  title: string;
  intent: string;
  blocked: boolean; // was on the blocklist at rank time
  scrape: "queued" | "scraping" | "ok" | "blocked" | "skipped" | "empty";
  chars: number;
  ms: number;
}

/** Per-phase and end-to-end latencies (ms), filled in as the scan progresses. */
export interface Timing {
  searchMs: number | null;
  scrapeMs: number | null;
  analyzeMs: number | null;
  totalMs: number | null;
}

/** The full reduced state the UI renders from. */
export interface ScanState {
  phase: ScanPhase | "idle";
  industry: string;
  intents: IntentStatus[];
  sources: SourceStatus[];
  /** Human-readable log lines, newest last — feeds the terminal-style activity feed. */
  trace: string[];
  /** The exact prompt sent to the model, once analysis begins. */
  prompt: PromptTrace | null;
  /** Phase + total latencies, for the "path taken" transparency. */
  timing: Timing;
  report: ScanReport | null;
  error: string | null;
  running: boolean;
}

const initialState: ScanState = {
  phase: "idle",
  industry: "",
  intents: [],
  sources: [],
  trace: [],
  prompt: null,
  timing: { searchMs: null, scrapeMs: null, analyzeMs: null, totalMs: null },
  report: null,
  error: null,
  running: false,
};

/** Pure reducer: fold one ScanEvent into the state. Exported for testing. */
export function reduce(state: ScanState, ev: ScanEvent): ScanState {
  const phase = phaseFor(ev.type);
  switch (ev.type) {
    case "start":
      return { ...state, phase, industry: ev.industry, trace: [`Initializing MRI scan for “${ev.industry}”…`] };

    case "intents":
      return {
        ...state,
        phase,
        intents: ev.intents.map((i) => ({ label: i.label, query: i.query, status: "pending", count: 0, ms: 0 })),
        trace: [...state.trace, `Generated ${ev.intents.length} search intents.`],
      };

    case "search:begin":
      return {
        ...state,
        phase,
        intents: state.intents.map((i) => (i.label === ev.intent ? { ...i, status: "searching" } : i)),
      };

    case "search:done":
      return {
        ...state,
        phase,
        intents: state.intents.map((i) =>
          i.label === ev.intent ? { ...i, status: "done", count: ev.count, ms: ev.ms } : i,
        ),
        trace: [...state.trace, `↳ “${ev.intent}” → ${ev.count} result${ev.count === 1 ? "" : "s"} (${fmtMs(ev.ms)})`],
      };

    case "sources": {
      const blocked = ev.sources.filter((s) => s.blocked).length;
      return {
        ...state,
        phase,
        sources: ev.sources.map((s) => ({ ...s, scrape: s.blocked ? "skipped" : "queued", chars: 0, ms: 0 })),
        timing: { ...state.timing, searchMs: ev.searchMs },
        trace: [
          ...state.trace,
          `Ranked ${ev.sources.length} sources in ${fmtMs(ev.searchMs)}` +
            (blocked > 0 ? ` — skipping ${blocked} known blocker${blocked === 1 ? "" : "s"} up front.` : "."),
        ],
      };
    }

    case "scrape:begin":
      return {
        ...state,
        phase,
        sources: state.sources.map((s) => (s.id === ev.id ? { ...s, scrape: "scraping" } : s)),
      };

    case "scrape:done": {
      // Surface newly-discovered blockers in the activity feed — the "learn from failures" moment.
      const extraTrace =
        ev.status === "blocked"
          ? [...state.trace, `⛔ ${ev.domain} blocked scraping — added to blocklist for next time.`]
          : state.trace;
      return {
        ...state,
        phase,
        sources: state.sources.map((s) =>
          s.id === ev.id ? { ...s, scrape: ev.status, chars: ev.chars, ms: ev.ms } : s,
        ),
        trace: extraTrace,
      };
    }

    case "analyze:begin":
      return {
        ...state,
        phase,
        prompt: { model: ev.model, systemPrompt: ev.systemPrompt, userPrompt: ev.userPrompt },
        timing: { ...state.timing, scrapeMs: ev.scrapeMs },
        trace: [...state.trace, `Scraped corpus in ${fmtMs(ev.scrapeMs)}. Running inference on ${ev.model}…`],
      };

    case "report":
      return {
        ...state,
        phase: "done",
        running: false,
        report: ev.report,
        timing: { ...state.timing, analyzeMs: ev.analyzeMs, totalMs: ev.totalMs },
        trace: [...state.trace, `Inference done in ${fmtMs(ev.analyzeMs)}. Scan complete in ${fmtMs(ev.totalMs)}.`],
      };

    case "error":
      return { ...state, phase: "done", running: false, error: ev.message };
  }
}

/**
 * Hook API: `{ state, start, reset }`. `start(industry)` kicks off the scan and streams updates.
 */
export function useScanStream() {
  const [state, setState] = useState<ScanState>(initialState);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(async (industry: string) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState({ ...initialState, running: true, phase: "intents", industry });

    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ industry }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`Scan request failed (${res.status}).`);

      // Parse the SSE stream frame by frame. Frames are separated by a blank line.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const json = line.slice(5).trim();
          if (!json) continue;
          const ev = JSON.parse(json) as ScanEvent;
          setState((prev) => reduce(prev, ev));
        }
      }
    } catch (err) {
      if (ctrl.signal.aborted) return; // user reset — ignore
      const message = err instanceof Error ? err.message : "Scan failed.";
      setState((prev) => ({ ...prev, running: false, phase: "done", error: message }));
    }
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState(initialState);
  }, []);

  return { state, start, reset };
}
