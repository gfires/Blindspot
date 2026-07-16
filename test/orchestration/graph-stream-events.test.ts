/**
 * transcriptToEvents — the debate node's transcripts → the board's debate:opening/debate:round
 * SSE events (question-board-spec.md §3c). Pure and unit-testable without a live LangGraph run.
 */
import { describe, it, expect } from "vitest";
import { transcriptToEvents } from "@/lib/orchestration/graph-stream";
import type { DebateRound } from "@/lib/orchestration/debate";
import type { Claim } from "@/lib/schemas/claim";

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

describe("transcriptToEvents", () => {
  it("emits one debate:opening per round-0 claim", () => {
    const rounds: DebateRound[] = [
      {
        round: 0,
        claims: [
          makeClaim({ agentRole: "historian", debateRound: 0 }),
          makeClaim({ agentRole: "operator", debateRound: 0 }),
        ],
      },
    ];
    const events = transcriptToEvents("q1", rounds);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.type === "debate:opening")).toBe(true);
  });

  it("emits one debate:round per conversational round, in ascending order", () => {
    const rounds: DebateRound[] = [
      { round: 1, claims: [makeClaim({ agentRole: "historian", debateRound: 1 })] },
      { round: 0, claims: [makeClaim({ agentRole: "historian", debateRound: 0 })] },
      { round: 2, claims: [makeClaim({ agentRole: "historian", debateRound: 2 })] },
    ];
    const events = transcriptToEvents("q1", rounds);
    expect(events.map((e) => e.type)).toEqual(["debate:opening", "debate:round", "debate:round"]);
    const roundEvents = events.filter((e) => e.type === "debate:round") as Extract<
      (typeof events)[number],
      { type: "debate:round" }
    >[];
    expect(roundEvents.map((e) => e.round)).toEqual([1, 2]);
    expect(roundEvents.every((e) => e.questionId === "q1")).toBe(true);
  });

  it("returns nothing for an empty transcript", () => {
    expect(transcriptToEvents("q1", [])).toEqual([]);
  });
});
