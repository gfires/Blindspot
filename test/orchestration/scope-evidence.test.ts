import { describe, it, expect } from "vitest";
import { scopeEvidenceToQuestions, queriesToSearch } from "@/lib/orchestration/graph";
import type { Question } from "@/lib/schemas/state";
import type { Evidence } from "@/lib/schemas/evidence";

function q(id: string, overrides: Partial<Question> = {}): Question {
  return { id, text: `q ${id}`, category: "cat", confidence: 0, resolved: false, ...overrides };
}

function ev(sourceQuery: string, loopIteration = 0, id?: string): Evidence {
  return {
    id: id ?? `e-${sourceQuery}-${loopIteration}`,
    url: "https://example.com",
    domain: "example.com",
    title: "t",
    snippet: "s",
    content: "",
    sourceQuery,
    loopIteration,
    contentHash: `h-${sourceQuery}-${loopIteration}`,
  };
}

// ---------------------------------------------------------------------------
// scopeEvidenceToQuestions
// ---------------------------------------------------------------------------

describe("scopeEvidenceToQuestions", () => {
  it("loop-0 fallback: matches evidence by q.text when no searchQueries", () => {
    const questions = [q("q1")];
    const evidence = [ev("q q1")];
    const result = scopeEvidenceToQuestions(questions, evidence);
    expect(result.get("q1")).toEqual([evidence[0]]);
  });

  it("refined queries: matches by searchQueries, not q.text", () => {
    const questions = [q("q1", { searchQueries: ["a", "b"] })];
    const evidence = [ev("b"), ev("a")];
    const result = scopeEvidenceToQuestions(questions, evidence);
    expect(result.get("q1")).toHaveLength(2);
    expect(result.get("q1")!.map((e) => e.sourceQuery)).toContain("a");
    expect(result.get("q1")!.map((e) => e.sourceQuery)).toContain("b");
  });

  it("many-to-many: shared query surfaces evidence in both questions", () => {
    const questions = [
      q("q1", { searchQueries: ["shared", "only-q1"] }),
      q("q2", { searchQueries: ["shared", "only-q2"] }),
    ];
    const sharedEvidence = ev("shared", 0, "e-shared");
    const evidence = [sharedEvidence, ev("only-q1"), ev("only-q2")];
    const result = scopeEvidenceToQuestions(questions, evidence);
    expect(result.get("q1")!.map((e) => e.id)).toContain("e-shared");
    expect(result.get("q2")!.map((e) => e.id)).toContain("e-shared");
    expect(result.get("q1")!.map((e) => e.sourceQuery)).toContain("only-q1");
    expect(result.get("q2")!.map((e) => e.sourceQuery)).toContain("only-q2");
  });

  it("three-loop accumulation: all loops resolve into the bucket", () => {
    const questions = [q("q1", { searchQueries: ["q q1", "loop1q", "loop2q"] })];
    const evidence = [ev("q q1", 0), ev("loop1q", 1), ev("loop2q", 2)];
    const result = scopeEvidenceToQuestions(questions, evidence);
    expect(result.get("q1")).toHaveLength(3);
  });

  it("orphan safety: unmatched evidence appears in no bucket", () => {
    const questions = [q("q1", { searchQueries: ["a"] })];
    const evidence = [ev("a"), ev("orphan-query")];
    const result = scopeEvidenceToQuestions(questions, evidence);
    expect(result.get("q1")).toHaveLength(1);
    const allValues = [...result.values()].flat();
    expect(allValues.map((e) => e.sourceQuery)).not.toContain("orphan-query");
  });

  it("empty question bucket: question with queries but no matching evidence yields no entry", () => {
    const questions = [q("q1", { searchQueries: ["a"] })];
    const evidence = [ev("b")];
    const result = scopeEvidenceToQuestions(questions, evidence);
    expect(result.has("q1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// queriesToSearch
// ---------------------------------------------------------------------------

describe("queriesToSearch", () => {
  it("loop 0: returns all queries deduped, text fallback when no searchQueries", () => {
    const questions = [q("q1"), q("q2", { searchQueries: ["specific"] })];
    const result = queriesToSearch(questions, []);
    expect(result).toContain("q q1");
    expect(result).toContain("specific");
    expect(result).toHaveLength(2);
  });

  it("loop 1+: excludes already-searched queries", () => {
    const questions = [q("q1", { searchQueries: ["old", "new"] })];
    const result = queriesToSearch(questions, ["old"]);
    expect(result).toEqual(["new"]);
  });

  it("zero-yield query still excluded from re-search", () => {
    const questions = [q("q1", { searchQueries: ["yielded-nothing", "fresh"] })];
    const result = queriesToSearch(questions, ["yielded-nothing"]);
    expect(result).toEqual(["fresh"]);
  });

  it("nothing new: all candidates already searched returns empty", () => {
    const questions = [q("q1", { searchQueries: ["a", "b"] })];
    const result = queriesToSearch(questions, ["a", "b"]);
    expect(result).toEqual([]);
  });

  it("dedup: same query from two questions appears once", () => {
    const questions = [
      q("q1", { searchQueries: ["shared"] }),
      q("q2", { searchQueries: ["shared"] }),
    ];
    const result = queriesToSearch(questions, []);
    expect(result).toEqual(["shared"]);
  });
});
