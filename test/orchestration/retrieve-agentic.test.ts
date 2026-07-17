/**
 * retrieve-agentic.test.ts — P4 regression coverage for the agentic `retrieve` node and its
 * dispatcher. `runResearcher` is mocked (PassPool stays REAL, per the plan) so each scripted mock
 * charges the shared pool and returns scripted evidence+usage; `search` (the coded path) is mocked
 * to prove the dispatcher never touches it under "agentic" and never touches runResearcher under
 * "coded". Rows map to spec §7.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

// Mock runResearcher but keep PassPool (and everything else) real, so the mock can charge the pool
// the node passes it — the node's sole-writer reconciliation is exactly what we're testing.
vi.mock("@/lib/orchestration/researcher", async (orig) => ({
  ...(await orig<typeof import("@/lib/orchestration/researcher")>()),
  runResearcher: vi.fn(),
}));
// The coded path calls search(); stub it so the "coded does not call runResearcher" test never hits
// the network and we can assert it WAS consulted.
vi.mock("@/lib/evidence/provider", async (orig) => ({
  ...(await orig<typeof import("@/lib/evidence/provider")>()),
  search: vi.fn(async () => ({ evidence: [], searchCredits: 0, scrapeCredits: 0, triageUsage: undefined })),
}));

import { runResearcher, PassPool } from "@/lib/orchestration/researcher";
import { search } from "@/lib/evidence/provider";
import { retrieve, retrieveAgentic } from "@/lib/orchestration/graph";
import { fallbackBrief } from "@/lib/schemas/brief";
import type { ResearchStateT, Question, RetrievalMode } from "@/lib/schemas/state";
import type { Evidence } from "@/lib/schemas/evidence";
import type { AnnotatedUsage } from "@/lib/orchestration/eval";

function q(id: string, o: Partial<Question> = {}): Question {
  return { id, text: `q ${id}`, category: "cat", confidence: 0, resolved: false, searchQueries: [`kw-${id}`], ...o };
}

function ev(hash: string, o: Partial<Evidence> = {}): Evidence {
  return {
    id: hash, url: `https://ex.com/${hash}`, domain: "ex.com", title: `t-${hash}`, snippet: "s",
    content: "c", contentHash: hash, sourceQuery: "kw", loopIteration: 0, ...o,
  };
}

const usage: AnnotatedUsage = { model: "m", promptTokens: 1, completionTokens: 1, costUsd: 0, label: "researcher:q" };

function stateOf(over: Partial<ResearchStateT> = {}): ResearchStateT {
  return {
    topic: "t",
    researchBrief: fallbackBrief("t"),
    questions: [q("q1"), q("q2")],
    claims: [],
    debateTranscripts: {},
    loopIteration: 0,
    evidence: [],
    answer: "",
    searchedQueries: [],
    budgetRemaining: 80,
    budgetSpent: 0,
    retrievalMode: "agentic" as RetrievalMode,
    ...over,
  } as ResearchStateT;
}

beforeEach(() => {
  (runResearcher as Mock).mockReset();
  (search as Mock).mockClear();
});

describe("retrieveAgentic — sole-writer budget delta [REGRESSION]", () => {
  it("returns ONE signed delta = the pool's total credits, no double-count", async () => {
    // Two agents (loop-0 recon → both get a mission), each charges the SHARED pool 5.
    (runResearcher as Mock).mockImplementation(
      async (question: Question, _m: string, _l: number, _s: Set<string>, pool: PassPool) => {
        pool.chargeSearch(2);
        pool.chargeScrape(3);
        return {
          evidence: question.id === "q1" ? [ev("a"), ev("b")] : [ev("b"), ev("c")], // shared "b"
          usage,
        };
      },
    );

    const out = await retrieveAgentic(stateOf());

    expect(out.budgetRemaining).toBe(-10); // one signed delta = -(5+5)
    expect(out.budgetSpent).toBe(10);
    expect(out.firecrawlCredits).toBe(10);
    // Split accounting (search-scrape-provider-split-spec.md §6): one combined budget delta, but
    // the node also reports the search-vs-scrape breakdown from the pool's separated counters.
    expect(out.searchCredits).toBe(4); // 2 agents × chargeSearch(2)
    expect(out.scrapeCredits).toBe(6); // 2 agents × chargeScrape(3)
    // Dedupe across agents by contentHash: {a,b,c} → 3.
    expect(out.newEvidenceCount).toBe(3);
    expect(out.evidence).toHaveLength(3);
    expect((out.llmCalls ?? []).length).toBe(2);
  });

  it("firecrawlCalls reflects only billable (non-cache) charges via PassPool.calls", async () => {
    (runResearcher as Mock).mockImplementation(
      async (_q: Question, _m: string, _l: number, _s: Set<string>, pool: PassPool) => {
        pool.charge(2); // billable
        pool.charge(0); // cache hit → not a call
        return { evidence: [ev("z")], usage };
      },
    );
    const out = await retrieveAgentic(stateOf({ questions: [q("q1")] }));
    expect(out.firecrawlCalls).toBe(1); // one billable charge, cache hit not counted
    expect(out.firecrawlCredits).toBe(2);
  });
});

describe("retrieveAgentic — newEvidenceCount on every path [REGRESSION]", () => {
  it("zero unresolved questions → { newEvidenceCount: 0 }, no agents run", async () => {
    const out = await retrieveAgentic(stateOf({ questions: [q("q1", { resolved: true })] }));
    expect(out).toEqual({ newEvidenceCount: 0 });
    expect(runResearcher).not.toHaveBeenCalled();
  });

  it("all missions empty (loop >= 1, no named gaps) → { newEvidenceCount: 0 }, no agents run", async () => {
    // loop 1 + no claims/transcripts → missionForQuestion returns "" for every question.
    const out = await retrieveAgentic(stateOf({ loopIteration: 1, claims: [], debateTranscripts: {} }));
    expect(out).toEqual({ newEvidenceCount: 0 });
    expect(runResearcher).not.toHaveBeenCalled();
  });
});

describe("retrieve — dispatcher routing [REGRESSION: coded path untouched]", () => {
  it("retrievalMode 'agentic' calls runResearcher and NOT the coded search()", async () => {
    (runResearcher as Mock).mockResolvedValue({ evidence: [ev("a")], usage });
    await retrieve(stateOf({ retrievalMode: "agentic" }));
    expect(runResearcher).toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("retrievalMode 'coded' (default) calls search() and NOT runResearcher", async () => {
    await retrieve(stateOf({ retrievalMode: "coded" }));
    expect(search).toHaveBeenCalled();
    expect(runResearcher).not.toHaveBeenCalled();
  });
});
