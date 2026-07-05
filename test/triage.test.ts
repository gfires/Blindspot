import { describe, it, expect } from "vitest";
import { selectSources, UNSCORED, type Candidate, type TriageScore } from "@/lib/triage";

function cand(url: string, intents: string[], title = url): Candidate {
  return { url, title, snippet: "", intents };
}

function scores(entries: [string, number, string?][]): Map<string, TriageScore> {
  const m = new Map<string, TriageScore>();
  for (const [url, score, reason] of entries) {
    m.set(url, { score, reason: reason ?? "" });
  }
  return m;
}

describe("selectSources", () => {
  it("respects maxScrape cap", () => {
    const candidates = Array.from({ length: 20 }, (_, i) => cand(`https://a.com/${i}`, ["x"]));
    const sc = scores(candidates.map((c) => [c.url, 8]));
    const result = selectSources(candidates, sc, 5, 1);
    expect(result).toHaveLength(5);
  });

  it("assigns 1-based ids", () => {
    const candidates = [cand("https://a.com", ["x"]), cand("https://b.com", ["x"])];
    const sc = scores(candidates.map((c) => [c.url, 7]));
    const result = selectSources(candidates, sc, 10, 1);
    expect(result.map((s) => s.id)).toEqual([1, 2]);
  });

  it("quota floor guarantees each intent's top-N", () => {
    const c1 = cand("https://intent-a-best.com", ["a"]);
    const c2 = cand("https://intent-a-second.com", ["a"]);
    const c3 = cand("https://intent-b-best.com", ["b"]);
    const c4 = cand("https://intent-b-second.com", ["b"]);
    const c5 = cand("https://global-best.com", ["a"]);

    const sc = scores([
      [c1.url, 9],
      [c2.url, 6],
      [c3.url, 8],
      [c4.url, 5],
      [c5.url, 10],
    ]);

    const result = selectSources([c1, c2, c3, c4, c5], sc, 28, 2);
    const urls = result.map((s) => s.url);

    // Each intent's top-2 must be present
    expect(urls).toContain(c1.url); // a top-1
    expect(urls).toContain(c2.url); // a top-2 (c5 scores higher but is also intent a)
    expect(urls).toContain(c3.url); // b top-1
    expect(urls).toContain(c4.url); // b top-2
    expect(urls).toContain(c5.url); // highest global
  });

  it("merit fill picks highest-scored remaining after quota", () => {
    const candidates = [
      cand("https://low.com", ["a"]),
      cand("https://high.com", ["b"]),
      cand("https://mid.com", ["c"]),
    ];
    const sc = scores([
      ["https://low.com", 2],
      ["https://high.com", 9],
      ["https://mid.com", 5],
    ]);

    // quotaFloor=1: each intent gets 1 guaranteed slot (3 total), then merit fill
    const result = selectSources(candidates, sc, 3, 1);
    expect(result).toHaveLength(3);
    // All three fit within maxScrape so all are included
    const urls = result.map((s) => s.url);
    expect(urls).toContain("https://low.com");
    expect(urls).toContain("https://high.com");
    expect(urls).toContain("https://mid.com");
  });

  it("attaches relevanceScore and reason from scores map", () => {
    const candidates = [cand("https://a.com", ["x"])];
    const sc = scores([["https://a.com", 8, "primary source"]]);
    const result = selectSources(candidates, sc, 10, 1);
    expect(result[0].relevanceScore).toBe(8);
    expect(result[0].reason).toBe("primary source");
  });

  it("uses undefined relevanceScore when scores map has no entry", () => {
    const candidates = [cand("https://a.com", ["x"])];
    const result = selectSources(candidates, new Map(), 10, 1);
    expect(result[0].relevanceScore).toBeUndefined();
  });

  it("deduplicates across intent quota floors", () => {
    // Same URL found by two intents — should appear only once
    const c = cand("https://shared.com", ["a", "b"]);
    const sc = scores([[c.url, 7]]);
    const result = selectSources([c], sc, 10, 2);
    expect(result).toHaveLength(1);
  });

  it("breaks ties by centrality (intent count)", () => {
    const multi = cand("https://multi.com", ["a", "b", "c"]);
    const single = cand("https://single.com", ["a"]);
    // Same score — multi-intent candidate should rank higher
    const sc = scores([
      [multi.url, 7],
      [single.url, 7],
    ]);
    const result = selectSources([multi, single], sc, 2, 0);
    expect(result[0].url).toBe("https://multi.com");
  });

  it("fallback path: all UNSCORED degrades to coverage-based selection", () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      cand(`https://site${i}.com`, [`intent${i % 3}`])
    );
    const sc = new Map<string, TriageScore>();
    for (const c of candidates) sc.set(c.url, UNSCORED);

    const result = selectSources(candidates, sc, 6, 2);
    expect(result).toHaveLength(6);
    // Each of the 3 intents should have at least its floor of 2
    const intentCounts = new Map<string, number>();
    for (const s of result) {
      intentCounts.set(s.intent, (intentCounts.get(s.intent) ?? 0) + 1);
    }
    for (const count of intentCounts.values()) {
      expect(count).toBeGreaterThanOrEqual(2);
    }
  });

  it("handles intent with fewer candidates than quotaFloor", () => {
    const c1 = cand("https://only-one.com", ["rare"]);
    const c2 = cand("https://common1.com", ["common"]);
    const c3 = cand("https://common2.com", ["common"]);
    const c4 = cand("https://common3.com", ["common"]);
    const sc = scores([
      [c1.url, 6],
      [c2.url, 7],
      [c3.url, 8],
      [c4.url, 5],
    ]);

    // quotaFloor=2 but "rare" only has 1 candidate — should not crash
    const result = selectSources([c1, c2, c3, c4], sc, 4, 2);
    expect(result).toHaveLength(4);
    expect(result.map((s) => s.url)).toContain(c1.url);
  });

  it("empty candidates returns empty", () => {
    const result = selectSources([], new Map(), 28, 2);
    expect(result).toEqual([]);
  });
});
