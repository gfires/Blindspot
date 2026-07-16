import { describe, it, expect } from "vitest";
import { reduce, initialResearchState } from "@/lib/useResearchStream";
import type { Claim } from "@/lib/schemas/claim";
import type { Question } from "@/lib/schemas/state";

function makeQuestion(id: string): Question {
  return { id, text: `text ${id}`, category: "cat", confidence: 0, resolved: false };
}

function makeClaim(overrides: Partial<Claim> & { agentRole: Claim["agentRole"]; questionId: string }): Claim {
  return {
    id: `claim-${overrides.agentRole}-${overrides.questionId}`,
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

describe("reduce — debateOutcome / debateRounds (board spec §3b)", () => {
  it("decompose:done seeds every question pending with 0 rounds", () => {
    const s = reduce(initialResearchState, {
      type: "decompose:done",
      questions: [makeQuestion("q1"), makeQuestion("q2")],
      usage: { model: "", promptTokens: 0, completionTokens: 0, label: "decompose", costUsd: 0 },
    });
    expect(s.questions.every((q) => q.debateOutcome === "pending" && q.debateRounds === 0)).toBe(true);
  });

  it("debate:begin marks questions in questionIds as debated, others as skipped", () => {
    let s = reduce(initialResearchState, {
      type: "decompose:done",
      questions: [makeQuestion("q1"), makeQuestion("q2")],
      usage: { model: "", promptTokens: 0, completionTokens: 0, label: "decompose", costUsd: 0 },
    });
    s = reduce(s, { type: "debate:begin", loopIteration: 0, questionIds: ["q1"] });

    const q1 = s.questions.find((q) => q.question.id === "q1")!;
    const q2 = s.questions.find((q) => q.question.id === "q2")!;
    expect(q1.debateOutcome).toBe("debated");
    expect(q1.status).toBe("debating");
    expect(q2.debateOutcome).toBe("skipped");
    expect(q2.status).not.toBe("debating");
  });

  it("does not touch an already-resolved question at debate:begin", () => {
    let s = reduce(initialResearchState, {
      type: "decompose:done",
      questions: [makeQuestion("q1")],
      usage: { model: "", promptTokens: 0, completionTokens: 0, label: "decompose", costUsd: 0 },
    });
    s = {
      ...s,
      questions: s.questions.map((q) => ({ ...q, status: "resolved", question: { ...q.question, resolved: true } })),
    };
    s = reduce(s, { type: "debate:begin", loopIteration: 1, questionIds: [] });
    const q1 = s.questions.find((q) => q.question.id === "q1")!;
    expect(q1.status).toBe("resolved");
    expect(q1.debateOutcome).toBe("pending");
  });

  it("debate:claim tracks the max debateRound seen for a question", () => {
    let s = reduce(initialResearchState, {
      type: "decompose:done",
      questions: [makeQuestion("q1")],
      usage: { model: "", promptTokens: 0, completionTokens: 0, label: "decompose", costUsd: 0 },
    });
    s = reduce(s, { type: "debate:claim", claim: makeClaim({ agentRole: "historian", questionId: "q1", debateRound: 0 }) });
    s = reduce(s, { type: "debate:claim", claim: makeClaim({ agentRole: "historian", questionId: "q1", debateRound: 2 }) });
    s = reduce(s, { type: "debate:claim", claim: makeClaim({ agentRole: "operator", questionId: "q1", debateRound: 1 }) });

    const q1 = s.questions.find((q) => q.question.id === "q1")!;
    expect(q1.debateRounds).toBe(2);
  });
});
