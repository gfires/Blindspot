import { describe, it, expect } from "vitest";
import { capCandidatesPerQuery, selectCandidatesByScore } from "@/lib/evidence/firecrawl";
import type { Candidate, TriageScore } from "@/lib/triage";

function c(url: string, intents: string[]): Candidate {
  return { url, title: url, snippet: "", intents };
}
function scoreMap(entries: Record<string, number>): Map<string, TriageScore> {
  return new Map(Object.entries(entries).map(([url, score]) => [url, { score, reason: "" }]));
}

describe("capCandidatesPerQuery", () => {
  it("keeps only the top `perQuery` candidates per source query, preserving rank order", () => {
    const cands = [
      c("a1", ["qA"]), c("a2", ["qA"]), c("a3", ["qA"]), // qA has 3
      c("b1", ["qB"]), c("b2", ["qB"]),                   // qB has 2
    ];
    const out = capCandidatesPerQuery(cands, 2);
    // qA capped to its top 2 (a1, a2 — a3 dropped); qB untouched.
    expect(out.map((x) => x.url)).toEqual(["a1", "a2", "b1", "b2"]);
  });

  it("groups a multi-intent candidate under its FIRST intent only", () => {
    const cands = [
      c("a1", ["qA"]), c("a2", ["qA"]),
      c("x", ["qA", "qB"]), // counts under qA (first intent), which is already full at perQuery=2
    ];
    const out = capCandidatesPerQuery(cands, 2);
    expect(out.map((x) => x.url)).toEqual(["a1", "a2"]); // x dropped — qA already at cap
  });

  it("is a no-op when every query is under the cap", () => {
    const cands = [c("a1", ["qA"]), c("b1", ["qB"])];
    expect(capCandidatesPerQuery(cands, 6)).toHaveLength(2);
  });

  it("handles an empty candidate list", () => {
    expect(capCandidatesPerQuery([], 6)).toEqual([]);
  });
});

describe("selectCandidatesByScore (triage relevance)", () => {
  it("keeps the top `perQuery` per query by score (not rank), highest first", () => {
    const cands = [c("lo", ["qA"]), c("hi", ["qA"]), c("mid", ["qA"])];
    const out = selectCandidatesByScore(cands, scoreMap({ lo: 3, hi: 9, mid: 6 }), 2, 1);
    expect(out.map((x) => x.url)).toEqual(["hi", "mid"]); // top 2 by score, lo dropped
  });

  it("drops candidates below minScore — a junk-only query yields fewer (or none)", () => {
    const cands = [c("j1", ["qJunk"]), c("j2", ["qJunk"]), c("good", ["qGood"])];
    const out = selectCandidatesByScore(cands, scoreMap({ j1: 2, j2: 3, good: 8 }), 6, 4);
    // qJunk's candidates are all below the bar → dropped entirely; qGood keeps its on-topic hit.
    expect(out.map((x) => x.url)).toEqual(["good"]);
  });

  it("degrades to rank-based top-k when triage is unavailable (all UNSCORED = 5)", () => {
    const cands = [c("a1", ["qA"]), c("a2", ["qA"]), c("a3", ["qA"])];
    // Empty score map → every candidate scores UNSCORED (5); minScore 4 keeps all, capped to 2 by rank.
    const out = selectCandidatesByScore(cands, new Map(), 2, 4);
    expect(out.map((x) => x.url)).toEqual(["a1", "a2"]);
  });

  it("breaks score ties by original rank order (stable)", () => {
    const cands = [c("first", ["qA"]), c("second", ["qA"])];
    const out = selectCandidatesByScore(cands, scoreMap({ first: 7, second: 7 }), 1, 1);
    expect(out.map((x) => x.url)).toEqual(["first"]);
  });
});
