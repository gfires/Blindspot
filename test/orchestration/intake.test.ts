import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { generateText } from "ai";
import { intake } from "@/lib/orchestration/graph";
import { fallbackBrief } from "@/lib/schemas/brief";
import { MAX_BRIEF_CONSTRAINTS } from "@/lib/params";
import type { ResearchStateT } from "@/lib/schemas/state";
import { fakeGenResult } from "../helpers/mock-ai";

// Only generateText is mocked — Output.object and the rest of "ai" stay real. See mock-ai.ts.
vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateText: vi.fn() };
});

/** The intake node only reads state.topic; a partial cast is enough to drive it. */
function stateOf(topic: string): ResearchStateT {
  return { topic } as ResearchStateT;
}

beforeEach(() => {
  (generateText as Mock).mockReset();
});

describe("intake node", () => {
  it("maps a bare phrase to a survey-shaped brief with empty constraints", async () => {
    (generateText as Mock).mockResolvedValue(
      fakeGenResult(
        {
          subject: "freight brokerage",
          objective: "Survey the opportunity landscape in freight brokerage",
          constraints: [],
        },
        { inputTokens: 40, outputTokens: 20 },
      ),
    );

    const out = await intake(stateOf("freight brokerage"));
    expect(out.researchBrief).toEqual({
      subject: "freight brokerage",
      objective: "Survey the opportunity landscape in freight brokerage",
      constraints: [],
    });
    // The call's usage is threaded onto llmCalls for token rollup.
    expect(out.llmCalls).toHaveLength(1);
    expect(out.llmCalls![0].label).toBe("intake");
  });

  it("extracts objective + constraints from a thesis input", async () => {
    (generateText as Mock).mockResolvedValue(
      fakeGenResult({
        subject: "AI contract review for mid-market law firms",
        objective:
          "Decide go/no-go on building AI-native contract review for mid-market US law firms",
        constraints: ["mid-market firms only", "US jurisdictions", "under $50k ACV"],
      }),
    );

    const out = await intake(
      stateOf(
        "Should we build AI-native contract review for mid-market US law firms under $50k ACV?",
      ),
    );
    expect(out.researchBrief!.subject).toContain("contract review");
    expect(out.researchBrief!.objective).toContain("go/no-go");
    expect(out.researchBrief!.constraints).toEqual([
      "mid-market firms only",
      "US jurisdictions",
      "under $50k ACV",
    ]);
  });

  it("clamps constraints to MAX_BRIEF_CONSTRAINTS in code (schema carries no max)", async () => {
    const many = Array.from({ length: MAX_BRIEF_CONSTRAINTS + 5 }, (_, i) => `c${i}`);
    (generateText as Mock).mockResolvedValue(
      fakeGenResult({ subject: "s", objective: "o", constraints: many }),
    );

    const out = await intake(stateOf("something with lots of criteria"));
    expect(out.researchBrief!.constraints).toHaveLength(MAX_BRIEF_CONSTRAINTS);
    expect(out.researchBrief!.constraints).toEqual(many.slice(0, MAX_BRIEF_CONSTRAINTS));
  });

  it("degrades to fallbackBrief on a thrown LLM error — the run survives, no throw", async () => {
    (generateText as Mock).mockRejectedValue(new Error("provider 500"));

    // intake never throws by design — if it did, this await would reject and fail the test.
    const out = await intake(stateOf("freight brokerage"));

    expect(out.researchBrief).toEqual(fallbackBrief("freight brokerage"));
    // A degraded intake spends no tokens it can account for → no llmCalls appended.
    expect(out.llmCalls).toBeUndefined();
  });
});
