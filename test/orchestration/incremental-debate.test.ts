import { describe, it, expect } from "vitest";
import { questionsNeedingDebate } from "@/lib/orchestration/graph";
import { splitEvidence, buildUserPrompt } from "@/lib/orchestration/committee";
import type { Question } from "@/lib/schemas/state";
import type { Evidence } from "@/lib/schemas/evidence";
import type { Claim } from "@/lib/schemas/claim";

function q(id: string, overrides: Partial<Question> = {}): Question {
  return { id, text: `q ${id}`, category: "cat", confidence: 0, resolved: false, ...overrides };
}

function ev(sourceQuery: string, loopIteration = 0, id?: string): Evidence {
  return {
    id: id ?? `e-${sourceQuery}-${loopIteration}`,
    url: "https://example.com",
    domain: "example.com",
    title: `title ${sourceQuery}`,
    snippet: `snippet ${sourceQuery}`,
    content: `FULL CONTENT for ${sourceQuery} — should not appear in a re-debate index`,
    sourceQuery,
    loopIteration,
    contentHash: `h-${sourceQuery}-${loopIteration}`,
  };
}

function claim(questionId: string, overrides: Partial<Claim> = {}): Claim {
  return {
    id: `${questionId}:c`,
    questionId,
    agentRole: "historian",
    conclusion: "prior conclusion text",
    confidence: 0.42,
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    missingEvidence: ["need pricing data"],
    loopIteration: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// questionsNeedingDebate
// ---------------------------------------------------------------------------

describe("questionsNeedingDebate", () => {
  it("includes a never-debated question (no claims yet)", () => {
    const questions = [q("q1")];
    const result = questionsNeedingDebate(questions, new Map(), [], 0);
    expect(result.map((x) => x.id)).toEqual(["q1"]);
  });

  it("includes a claimed question that gained fresh evidence this loop", () => {
    const questions = [q("q1")];
    const byQ = new Map<string, Evidence[]>([["q1", [ev("a", 0), ev("b", 1)]]]);
    const result = questionsNeedingDebate(questions, byQ, [claim("q1")], 1);
    expect(result.map((x) => x.id)).toEqual(["q1"]);
  });

  it("excludes a claimed question whose evidence is all stale (no fresh this loop)", () => {
    const questions = [q("q1")];
    const byQ = new Map<string, Evidence[]>([["q1", [ev("a", 0)]]]);
    const result = questionsNeedingDebate(questions, byQ, [claim("q1")], 1);
    expect(result).toEqual([]);
  });

  it("excludes a resolved question even if it has fresh evidence", () => {
    const questions = [q("q1", { resolved: true })];
    const byQ = new Map<string, Evidence[]>([["q1", [ev("a", 1)]]]);
    const result = questionsNeedingDebate(questions, byQ, [claim("q1")], 1);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// splitEvidence
// ---------------------------------------------------------------------------

describe("splitEvidence", () => {
  it("partitions by loopIteration relative to the current loop", () => {
    const evidence = [ev("a", 0), ev("b", 1), ev("c", 1), ev("d", 2)];
    const { fresh, prior } = splitEvidence(evidence, 1);
    expect(fresh.map((e) => e.sourceQuery)).toEqual(["b", "c"]);
    expect(prior.map((e) => e.sourceQuery)).toEqual(["a", "d"]);
  });

  it("puts everything in fresh at loop 0 when all evidence is loop 0", () => {
    const evidence = [ev("a", 0), ev("b", 0)];
    const { fresh, prior } = splitEvidence(evidence, 0);
    expect(fresh).toHaveLength(2);
    expect(prior).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildUserPrompt
// ---------------------------------------------------------------------------

describe("buildUserPrompt", () => {
  const BLOCK = "[e-1] Title (example.com)\n  digest summary line";

  it("no prior claim: passes the evidence block through, no prior-claim block", () => {
    const prompt = buildUserPrompt(q("q1"), BLOCK);
    expect(prompt).toContain("EVIDENCE — cite only by the bracketed id");
    expect(prompt).toContain(BLOCK);
    expect(prompt).toContain("Render your Claim now");
    expect(prompt).not.toContain("YOUR PRIOR CLAIM");
    expect(prompt).not.toContain("UPDATED Claim");
  });

  it("re-debate: keeps the evidence block and adds the role's prior claim to update", () => {
    const prior = claim("q1", { loopIteration: 0 });
    const prompt = buildUserPrompt(q("q1"), BLOCK, prior);

    expect(prompt).toContain(BLOCK);
    // Prior-claim block with the instruction to update it, not restate it.
    expect(prompt).toContain("YOUR PRIOR CLAIM");
    expect(prompt).toContain("prior conclusion text");
    expect(prompt).toContain("0.42");
    expect(prompt).toContain("need pricing data");
    expect(prompt).toContain("Render your UPDATED Claim now");
  });
});
