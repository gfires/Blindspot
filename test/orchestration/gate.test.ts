import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import { gateShortCircuit, allocateBudget } from "@/lib/orchestration/gate";
import { routeAfterGate } from "@/lib/orchestration/graph";
import { MAX_LOOP_ITERATIONS, MIN_LOOP_COST_HEADROOM_USD } from "@/lib/params";
import { runWithCostTracker, getActiveCostTracker } from "@/lib/orchestration/cost-tracker";
import type { AnnotatedUsage } from "@/lib/orchestration/eval";
import type { ResearchStateT, Question } from "@/lib/schemas/state";
import { fallbackBrief } from "@/lib/schemas/brief";
import { fakeGenResult, assertNoLlmCalls } from "../helpers/mock-ai";

/**
 * Build an AnnotatedUsage whose gpt-4o completion tokens estimate to ~`costUsd` (output
 * bills at $10/M). `record()` recomputes the cost from these token fields, so this is
 * what actually moves `getRemaining()`.
 */
function spendUsage(costUsd: number): AnnotatedUsage {
  const completionTokens = Math.ceil((costUsd / 10) * 1_000_000);
  return { model: "gpt-4o", promptTokens: 0, completionTokens, label: "test", costUsd };
}

// Only generateText is mocked — see test/helpers/mock-ai.ts. The no-progress path must
// NEVER reach it, so the mock is present purely to assert it stays uncalled.
vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateText: vi.fn() };
});

function q(id: string, overrides: Partial<Question> = {}): Question {
  return { id, text: `q ${id}`, category: "cat", confidence: 0, resolved: false, ...overrides };
}

/** Full ResearchStateT literal — the gate only reads a handful of fields. */
function stateOf(over: Partial<ResearchStateT>): ResearchStateT {
  return {
    topic: "widgets market",
    researchBrief: fallbackBrief("widgets market"),
    questions: [q("q1")],
    evidence: [],
    claims: [],
    loopIteration: 0,
    newEvidenceCount: -1,
    budgetRemaining: 50,
    budgetSpent: 0,
    firecrawlCalls: 0,
    firecrawlCredits: 0,
    converged: false,
    llmCalls: [],
    searchedQueries: [],
    gateScores: [],
    digests: {},
    debateTranscripts: {},
    retrievalMode: "coded",
    answer: "",
    ...over,
  };
}

describe("gateShortCircuit", () => {
  it("returns 'no-progress' when a past-loop-0 iteration added no evidence", () => {
    expect(gateShortCircuit(stateOf({ loopIteration: 2, newEvidenceCount: 0 }))).toBe("no-progress");
  });

  it("exempts loop 0 from the no-progress check (returns null)", () => {
    // newEvidenceCount is only meaningful once a retrieve has run; loop 0 is exempt.
    expect(gateShortCircuit(stateOf({ loopIteration: 0, newEvidenceCount: 0 }))).toBeNull();
  });

  it("returns 'budget' when no budget remains, taking priority over other checks", () => {
    expect(gateShortCircuit(stateOf({ budgetRemaining: 0, loopIteration: 2, newEvidenceCount: 0 }))).toBe("budget");
  });

  it("returns 'max-loops' at the loop-iteration cap", () => {
    expect(gateShortCircuit(stateOf({ loopIteration: MAX_LOOP_ITERATIONS, newEvidenceCount: 5 }))).toBe("max-loops");
  });

  it("returns null when there is budget, loops remain, and progress was made", () => {
    expect(gateShortCircuit(stateOf({ loopIteration: 1, newEvidenceCount: 4 }))).toBeNull();
  });

  // A state that would otherwise CONTINUE: Firecrawl budget remains, under the loop cap, and the
  // last loop added evidence. Only the cost-headroom guard should stop it.
  const continuableState = stateOf({ loopIteration: 1, newEvidenceCount: 4, budgetRemaining: 50 });

  it("returns 'cost-headroom' when remaining LLM headroom is below the minimum", async () => {
    await runWithCostTracker(async () => {
      // Spend down to $0.10 remaining under a $1.00 cap — below the headroom floor.
      getActiveCostTracker()!.record(spendUsage(0.9));
      expect(getActiveCostTracker()!.getRemaining()).toBeLessThan(MIN_LOOP_COST_HEADROOM_USD);
      expect(gateShortCircuit(continuableState)).toBe("cost-headroom");
    }, 1.0);
  });

  it("does NOT fire cost-headroom when ample LLM headroom remains", async () => {
    await runWithCostTracker(async () => {
      getActiveCostTracker()!.record(spendUsage(0.1)); // $0.90 remaining under a $1.00 cap
      expect(getActiveCostTracker()!.getRemaining()).toBeGreaterThan(MIN_LOOP_COST_HEADROOM_USD);
      expect(gateShortCircuit(continuableState)).toBeNull();
    }, 1.0);
  });

  it("treats a missing tracker as infinite headroom (guard inert, no active tracker)", () => {
    // No runWithCostTracker wrapper → getActiveCostTracker() is null → remaining is undefined →
    // the guard must NOT fire. This is exactly how the pure tests above call gateShortCircuit.
    expect(gateShortCircuit(continuableState)).toBeNull();
  });

  it("Firecrawl 'budget' still wins over 'cost-headroom' when both hold", async () => {
    await runWithCostTracker(async () => {
      getActiveCostTracker()!.record(spendUsage(0.9)); // low headroom
      expect(gateShortCircuit(stateOf({ budgetRemaining: 0, loopIteration: 1, newEvidenceCount: 4 }))).toBe("budget");
    }, 1.0);
  });
});

describe("allocateBudget — short-circuit before any LLM call", () => {
  it("a no-progress state converges with continueLoop:false and never calls the LLM", async () => {
    const { generateText } = await import("ai");
    (generateText as Mock).mockResolvedValue(fakeGenResult({ decisions: [] }));

    const result = await allocateBudget(stateOf({ loopIteration: 2, newEvidenceCount: 0 }));

    expect(result.continueLoop).toBe(false);
    expect(result.state.converged).toBe(true);
    expect(result.usage).toEqual([]);
    expect(result.gateScores).toEqual([]);
    assertNoLlmCalls();
  });

  it("a cost-headroom short-circuit converges (converged:true) → routeAfterGate returns 'recommend'", async () => {
    const { generateText } = await import("ai");
    (generateText as Mock).mockResolvedValue(fakeGenResult({ decisions: [] }));

    await runWithCostTracker(async () => {
      getActiveCostTracker()!.record(spendUsage(0.9)); // remaining $0.10 < headroom floor
      // State would otherwise continue: Firecrawl budget remains, under the loop cap, evidence added.
      const result = await allocateBudget(
        stateOf({ loopIteration: 1, newEvidenceCount: 4, budgetRemaining: 50 }),
      );

      expect(result.continueLoop).toBe(false);
      expect(result.state.converged).toBe(true);
      // routeAfterGate reads `converged` — the new reason sets it, so the run heads to recommend.
      expect(routeAfterGate(result.state)).toBe("recommend");
      assertNoLlmCalls();
    }, 1.0);
  });
});
