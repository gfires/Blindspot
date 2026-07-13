import { describe, it, expect } from "vitest";
import {
  roundOneConsensus,
  debateMovement,
  directedChallenges,
  renderTranscript,
  extractContentions,
  type DebateRound,
} from "@/lib/orchestration/debate";
import { DEBATE_CONSENSUS_SPREAD, DEBATE_CONSENSUS_MIN_CONFIDENCE, DEBATE_CONFIDENCE_EPSILON } from "@/lib/params";
import type { AgentRoleT, Claim, DebateResponse } from "@/lib/schemas/claim";

function claim(role: AgentRoleT, overrides: Partial<Claim> = {}): Claim {
  return {
    id: `q1:${role}:0`,
    questionId: "q1",
    agentRole: role,
    conclusion: `${role} conclusion`,
    confidence: 0.7,
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    missingEvidence: [],
    loopIteration: 0,
    debateRound: 0,
    responses: [],
    ...overrides,
  };
}

function resp(targetRole: AgentRoleT, stance: DebateResponse["stance"], point = "p"): DebateResponse {
  return { targetRole, stance, point };
}

const opts = { spread: DEBATE_CONSENSUS_SPREAD, minConfidence: DEBATE_CONSENSUS_MIN_CONFIDENCE };

describe("roundOneConsensus", () => {
  it("true when confidences are tight, above the floor, and nobody contradicts", () => {
    const claims = [
      claim("historian", { confidence: 0.7 }),
      claim("operator", { confidence: 0.75 }),
      claim("investor", { confidence: 0.72 }),
      claim("skeptic", { confidence: 0.68 }),
    ];
    expect(roundOneConsensus(claims, opts)).toBe(true);
  });

  it("false when any role flags a contradiction", () => {
    const claims = [
      claim("historian", { confidence: 0.7 }),
      claim("operator", { confidence: 0.72 }),
      claim("investor", { confidence: 0.71 }),
      claim("skeptic", { confidence: 0.7, contradictingEvidenceIds: ["e9"] }),
    ];
    expect(roundOneConsensus(claims, opts)).toBe(false);
  });

  it("false on a wide confidence spread even with no contradiction", () => {
    const claims = [
      claim("historian", { confidence: 0.9 }),
      claim("operator", { confidence: 0.62 }),
      claim("investor", { confidence: 0.88 }),
      claim("skeptic", { confidence: 0.61 }),
    ];
    expect(roundOneConsensus(claims, opts)).toBe(false);
  });

  it("false on low-confidence agreement (shared uncertainty, not consensus)", () => {
    const claims = [
      claim("historian", { confidence: 0.3 }),
      claim("operator", { confidence: 0.32 }),
      claim("investor", { confidence: 0.31 }),
      claim("skeptic", { confidence: 0.29 }),
    ];
    expect(roundOneConsensus(claims, opts)).toBe(false);
  });

  it("false when there are no claims", () => {
    expect(roundOneConsensus([], opts)).toBe(false);
  });
});

describe("debateMovement", () => {
  const round = (r: number, claims: Claim[]): DebateRound => ({ round: r, claims });

  it("converged when nothing moves and no fresh rebuttal appears", () => {
    const prev = round(1, [claim("historian", { confidence: 0.7, supportingEvidenceIds: ["e1"] })]);
    const next = round(2, [claim("historian", { confidence: 0.72, supportingEvidenceIds: ["e1"] })]);
    const m = debateMovement(prev, next, DEBATE_CONFIDENCE_EPSILON);
    expect(m).toEqual({ moved: 0, newRebuttals: 0, converged: true });
  });

  it("non-converged on a confidence jump beyond epsilon", () => {
    const prev = round(1, [claim("historian", { confidence: 0.5 })]);
    const next = round(2, [claim("historian", { confidence: 0.8 })]);
    const m = debateMovement(prev, next, DEBATE_CONFIDENCE_EPSILON);
    expect(m.moved).toBe(1);
    expect(m.converged).toBe(false);
  });

  it("non-converged on an evidence id-set change with flat confidence", () => {
    const prev = round(1, [claim("operator", { confidence: 0.7, supportingEvidenceIds: ["e1"] })]);
    const next = round(2, [claim("operator", { confidence: 0.7, supportingEvidenceIds: ["e1", "e2"] })]);
    const m = debateMovement(prev, next, DEBATE_CONFIDENCE_EPSILON);
    expect(m.moved).toBe(1);
    expect(m.converged).toBe(false);
  });

  it("non-converged on a fresh rebuttal pair, counting by pair identity", () => {
    const prev = round(1, [claim("investor", { responses: [] })]);
    const next = round(2, [claim("investor", { responses: [resp("skeptic", "rebut", "different words")] })]);
    const m = debateMovement(prev, next, DEBATE_CONFIDENCE_EPSILON);
    expect(m.newRebuttals).toBe(1);
    expect(m.converged).toBe(false);
  });

  it("does not count a rebuttal pair that already existed (ignores changed point text)", () => {
    const prev = round(1, [claim("investor", { responses: [resp("skeptic", "rebut", "old text")] })]);
    const next = round(2, [claim("investor", { responses: [resp("skeptic", "rebut", "reworded text")] })]);
    const m = debateMovement(prev, next, DEBATE_CONFIDENCE_EPSILON);
    expect(m.newRebuttals).toBe(0);
  });
});

describe("directedChallenges", () => {
  it("returns only the responses aimed at the given role", () => {
    const latest: DebateRound = {
      round: 1,
      claims: [
        claim("historian", { responses: [resp("skeptic", "rebut"), resp("investor", "extend")] }),
        claim("operator", { responses: [resp("skeptic", "concede")] }),
        claim("skeptic", { responses: [resp("historian", "rebut")] }),
      ],
    };
    const forSkeptic = directedChallenges(latest, "skeptic");
    expect(forSkeptic).toHaveLength(2);
    expect(forSkeptic.every((r) => r.targetRole === "skeptic")).toBe(true);
  });
});

describe("renderTranscript", () => {
  it("renders rounds and claims deterministically in canonical role order", () => {
    const rounds: DebateRound[] = [
      {
        round: 0,
        claims: [
          // deliberately out of canonical order to prove sorting
          claim("skeptic", { confidence: 0.4, contradictingEvidenceIds: ["e2"] }),
          claim("historian", { confidence: 0.6, supportingEvidenceIds: ["e1"] }),
        ],
      },
      {
        round: 1,
        claims: [claim("historian", { confidence: 0.65, responses: [resp("skeptic", "rebut", "cite e1")] })],
      },
    ];
    const text = renderTranscript(rounds);
    expect(text).toContain("Round 0:");
    expect(text).toContain("Round 1:");
    // historian sorts before skeptic within round 0
    expect(text.indexOf("[historian]")).toBeLessThan(text.indexOf("[skeptic]"));
    expect(text).toContain("support[e1]/contra[]");
    expect(text).toContain("→ rebut @skeptic: cite e1");
    // byte-stable across calls
    expect(renderTranscript(rounds)).toBe(text);
  });
});

describe("extractContentions", () => {
  it("pairs an unresolved rebuttal and classifies it interpretive when no gap is named", () => {
    const finalClaims = [
      claim("historian", { responses: [resp("skeptic", "rebut", "precedent holds")] }),
      claim("skeptic", { responses: [] }), // no concede back → unresolved
    ];
    const cs = extractContentions("q1", finalClaims);
    expect(cs).toHaveLength(1);
    expect(cs[0].roles).toEqual(["historian", "skeptic"]);
    expect(cs[0].type).toBe("interpretive");
  });

  it("does not pair a rebuttal that the other role conceded", () => {
    const finalClaims = [
      claim("historian", { responses: [resp("skeptic", "rebut")] }),
      claim("skeptic", { responses: [resp("historian", "concede")] }),
    ];
    expect(extractContentions("q1", finalClaims)).toEqual([]);
  });

  it("pairs an evidence id-clash and marks it evidential when a gap is named", () => {
    const finalClaims = [
      claim("operator", { supportingEvidenceIds: ["e5"], missingEvidence: ["need vendor-independent source"] }),
      claim("investor", { contradictingEvidenceIds: ["e5"] }),
    ];
    const cs = extractContentions("q1", finalClaims);
    expect(cs).toHaveLength(1);
    expect(cs[0].roles).toEqual(["operator", "investor"]);
    expect(cs[0].type).toBe("evidential");
    expect(cs[0].note).toContain("e5");
  });

  it("returns nothing when the committee agrees", () => {
    const finalClaims = [
      claim("historian", { supportingEvidenceIds: ["e1"] }),
      claim("operator", { supportingEvidenceIds: ["e1"] }),
    ];
    expect(extractContentions("q1", finalClaims)).toEqual([]);
  });
});
