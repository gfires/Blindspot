import { describe, it, expect } from "vitest";
import {
  reconCount,
  openingResolution,
  latestGateScoreFor,
  gateVerdict,
  scopeGateDecisionsToQuestion,
} from "@/lib/research/board";
import type { Claim } from "@/lib/schemas/claim";
import type { Evidence } from "@/lib/schemas/evidence";
import type { GateDecision } from "@/lib/useResearchStream";

function makeClaim(overrides: Partial<Claim> & { agentRole: Claim["agentRole"] }): Claim {
  return {
    id: `claim-${overrides.agentRole}`,
    questionId: "q1",
    conclusion: "conclusion",
    confidence: 0.5,
    stance: "insufficient",
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    missingEvidence: [],
    loopIteration: 0,
    debateRound: 0,
    responses: [],
    ...overrides,
  };
}

function makeEvidence(id: string, loopIteration: number): Evidence {
  return {
    id,
    url: `https://example.com/${id}`,
    domain: "example.com",
    title: id,
    snippet: "snippet",
    content: "content",
    contentHash: `hash-${id}`,
    sourceQuery: "query",
    loopIteration,
  };
}

describe("reconCount", () => {
  it("counts only loop-0 evidence", () => {
    const evidence = [makeEvidence("a", 0), makeEvidence("b", 0), makeEvidence("c", 1)];
    expect(reconCount(evidence)).toBe(2);
  });

  it("is zero for no evidence", () => {
    expect(reconCount([])).toBe(0);
  });
});

describe("openingResolution", () => {
  it("is pending with no claims", () => {
    expect(openingResolution([])).toBe("pending");
  });

  it("is agree when the committee unanimously leans one way", () => {
    const claims = [
      makeClaim({ agentRole: "historian", stance: "supports" }),
      makeClaim({ agentRole: "operator", stance: "supports" }),
    ];
    expect(openingResolution(claims)).toBe("agree");
  });

  it("is split on a genuine disagreement (2+ decisive stances)", () => {
    const claims = [
      makeClaim({ agentRole: "historian", stance: "supports" }),
      makeClaim({ agentRole: "skeptic", stance: "opposes" }),
    ];
    expect(openingResolution(claims)).toBe("split");
  });
});

describe("latestGateScoreFor / gateVerdict", () => {
  const decisions: GateDecision[] = [
    {
      loopIteration: 0,
      gateScores: [{ questionId: "q1", retrieve: true, gapCount: 1, confidenceSpread: 0.1, reason: "needs more" }],
      resolvedIds: [],
      unresolvedIds: ["q1"],
      continueLoop: true,
    },
    {
      loopIteration: 1,
      gateScores: [{ questionId: "q1", retrieve: false, gapCount: 0, confidenceSpread: 0, reason: "settled" }],
      resolvedIds: ["q1"],
      unresolvedIds: [],
      continueLoop: false,
    },
  ];

  it("finds the most recent score for a question", () => {
    const score = latestGateScoreFor(decisions, "q1");
    expect(score?.reason).toBe("settled");
  });

  it("returns undefined for a question with no score", () => {
    expect(latestGateScoreFor(decisions, "q9")).toBeUndefined();
  });

  it("verdict is pending with no score", () => {
    expect(gateVerdict(undefined, "supports")).toBe("pending");
  });

  it("verdict is retrieve when the gate wants more evidence", () => {
    expect(gateVerdict({ questionId: "q1", retrieve: true, gapCount: 1, confidenceSpread: 0, reason: "" }, "insufficient")).toBe(
      "retrieve",
    );
  });

  it("verdict is fault-line for a resolved but contested stance", () => {
    expect(gateVerdict({ questionId: "q1", retrieve: false, gapCount: 0, confidenceSpread: 0, reason: "" }, "contested")).toBe(
      "fault-line",
    );
  });

  it("verdict is settled for a resolved unanimous stance", () => {
    expect(gateVerdict({ questionId: "q1", retrieve: false, gapCount: 0, confidenceSpread: 0, reason: "" }, "supports")).toBe(
      "settled",
    );
  });
});

describe("scopeGateDecisionsToQuestion", () => {
  it("filters gateScores/resolvedIds/unresolvedIds down to one question", () => {
    const decisions: GateDecision[] = [
      {
        loopIteration: 0,
        gateScores: [
          { questionId: "q1", retrieve: true, gapCount: 1, confidenceSpread: 0, reason: "a" },
          { questionId: "q2", retrieve: false, gapCount: 0, confidenceSpread: 0, reason: "b" },
        ],
        resolvedIds: ["q2"],
        unresolvedIds: ["q1"],
        continueLoop: true,
      },
    ];
    const scoped = scopeGateDecisionsToQuestion(decisions, "q1");
    expect(scoped[0].gateScores).toHaveLength(1);
    expect(scoped[0].gateScores[0].questionId).toBe("q1");
    expect(scoped[0].resolvedIds).toEqual([]);
    expect(scoped[0].unresolvedIds).toEqual(["q1"]);
  });
});
