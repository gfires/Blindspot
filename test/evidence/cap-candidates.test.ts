import { describe, it, expect } from "vitest";
import { capCandidatesPerQuery } from "@/lib/evidence/firecrawl";
import type { Candidate } from "@/lib/triage";

function c(url: string, intents: string[]): Candidate {
  return { url, title: url, snippet: "", intents };
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
