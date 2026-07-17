import { describe, it, expect } from "vitest";
import { StateGraph, START, END } from "@langchain/langgraph";
import { ResearchBriefSchema, fallbackBrief, EMPTY_BRIEF } from "@/lib/schemas/brief";
import { ResearchState } from "@/lib/schemas/state";
import type { ResearchBrief } from "@/lib/schemas/brief";

describe("ResearchBriefSchema", () => {
  it("parses a full brief (subject + objective + populated constraints)", () => {
    const brief = {
      subject: "AI contract review for mid-market law firms",
      objective: "Decide whether to build an AI-native contract review product for this segment",
      constraints: ["mid-market only", "US jurisdictions", "sub-$50k ACV"],
    };
    const parsed = ResearchBriefSchema.parse(brief);
    expect(parsed).toEqual(brief);
  });

  it("parses a brief with empty constraints (the bare-phrase shape)", () => {
    const brief = {
      subject: "freight brokerage",
      objective: "Survey the opportunity landscape in freight brokerage",
      constraints: [],
    };
    expect(ResearchBriefSchema.parse(brief).constraints).toEqual([]);
  });

  it("carries NO length caps — a long objective and many constraints still parse", () => {
    // Guards the hard constraint: no .min()/.max() on the LLM-output schema. If a cap were
    // present, one of these would throw. Steering is via .describe(); clamping is in code.
    const longObjective = "assess ".repeat(500); // ~3.5k chars
    const manyConstraints = Array.from({ length: 50 }, (_, i) => `constraint ${i}`);
    const parsed = ResearchBriefSchema.parse({
      subject: "x",
      objective: longObjective,
      constraints: manyConstraints,
    });
    expect(parsed.objective.length).toBeGreaterThan(3000);
    expect(parsed.constraints).toHaveLength(50);
  });

  it("rejects a missing objective (the load-bearing field is required)", () => {
    expect(() => ResearchBriefSchema.parse({ subject: "x", constraints: [] })).toThrow();
  });
});

describe("fallbackBrief / EMPTY_BRIEF", () => {
  it("builds a survey-shaped brief from the topic with no constraints", () => {
    const brief = fallbackBrief("freight brokerage");
    expect(brief).toEqual({
      subject: "freight brokerage",
      objective: "Assess the opportunity in freight brokerage",
      constraints: [],
    });
    // The fallback must itself be a valid brief (it's the degrade path).
    expect(() => ResearchBriefSchema.parse(brief)).not.toThrow();
  });

  it("EMPTY_BRIEF is the empty-subject fallback", () => {
    expect(EMPTY_BRIEF).toEqual({ subject: "", objective: "Assess the opportunity in ", constraints: [] });
  });
});

describe("researchBrief state channel", () => {
  // Drive the channel through a real compiled StateGraph — the public contract — rather than
  // reaching into LangGraph's internal channel objects.
  const next: ResearchBrief = {
    subject: "freight brokerage",
    objective: "Survey the landscape",
    constraints: ["US only"],
  };

  it("defaults to the empty fallback brief when no node writes it", async () => {
    const g = new StateGraph(ResearchState)
      .addNode("noop", () => ({}))
      .addEdge(START, "noop")
      .addEdge("noop", END)
      .compile();
    const out = await g.invoke({ topic: "x" });
    expect(out.researchBrief).toEqual(EMPTY_BRIEF);
  });

  it("replaces wholesale — manager owns full replacement, prior value discarded", async () => {
    const g = new StateGraph(ResearchState)
      .addNode("set", () => ({ researchBrief: next }))
      .addEdge(START, "set")
      .addEdge("set", END)
      .compile();
    // Seed a different brief; the node's write must fully replace it, not merge.
    const out = await g.invoke({ topic: "x", researchBrief: fallbackBrief("old topic") });
    expect(out.researchBrief).toEqual(next);
  });
});
