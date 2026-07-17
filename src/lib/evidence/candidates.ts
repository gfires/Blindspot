/**
 * evidence/candidates.ts — pure, provider-agnostic candidate selection helpers.
 *
 * Dedupe/cap/score-select operate on plain SearchHit/Candidate data, never touch a network or a
 * specific vendor's SDK, and are shared by every pipeline in evidence/provider.ts (explore(),
 * search()) regardless of which SearchOps/ScrapeOps are currently selected. Moved out of
 * firecrawl.ts (where they originated) so provider.ts's shared pipelines don't import
 * pipeline-support helpers from one specific vendor's file.
 */
import type { SearchHit } from "./provider";
import { type Candidate, type TriageScore, UNSCORED } from "../triage";

/**
 * Dedupe search hits into unique triage candidates, MERGING the intents that surfaced each URL.
 *
 * A URL found by both "complaints" and "forum" becomes one candidate tagged with both intents —
 * that intent-count is a centrality signal the triage LLM sees (triage.ts). Selection (which used
 * to be blind round-robin here) now happens downstream in `selectSources` using triage scores.
 */
export function dedupeCandidates(hits: (SearchHit & { intent: string })[]): Candidate[] {
  const byUrl = new Map<string, Candidate>();
  for (const h of hits) {
    // Normalize away fragments/queries/trailing slash so near-identical URLs collapse.
    const key = h.url.replace(/[#?].*$/, "").replace(/\/$/, "");
    const existing = byUrl.get(key);
    if (existing) {
      if (!existing.intents.includes(h.intent)) existing.intents.push(h.intent);
      // Prefer a non-empty snippet/title if the first occurrence lacked one.
      if (!existing.snippet && h.snippet) existing.snippet = h.snippet;
      continue;
    }
    byUrl.set(key, { url: h.url, title: h.title, snippet: h.snippet, intents: [h.intent] });
  }
  return [...byUrl.values()];
}

/**
 * Cap candidates to the top `perQuery` per source query BEFORE scraping, so we don't pay to scrape
 * pages we would only discard afterwards. The old flow scraped EVERY deduped candidate and then kept
 * just the top-k per query (a POST-scrape cap), wasting up to one scrape per dropped candidate. Order
 * is preserved (search rank), and each candidate is grouped under its FIRST intent — the query that
 * surfaced it — matching the downstream per-sourceQuery evidence cap. Pure/deterministic; exported
 * for testing.
 */
export function capCandidatesPerQuery(candidates: Candidate[], perQuery: number): Candidate[] {
  const seen = new Map<string, number>();
  const out: Candidate[] = [];
  for (const c of candidates) {
    const q = c.intents[0] ?? "";
    const n = seen.get(q) ?? 0;
    if (n >= perQuery) continue;
    seen.set(q, n + 1);
    out.push(c);
  }
  return out;
}

/**
 * Choose which scored candidates to scrape: per source query, the top `perQuery` by triage score,
 * DROPPING any below `minScore` (so a query that surfaced only off-topic junk scrapes fewer — or none
 * — rather than filling its quota with low-relevance pages the committee would read as "no evidence").
 * Grouped by first intent, like capCandidatesPerQuery; ties break by original (rank) order. When triage
 * is unavailable every candidate is UNSCORED (score 5), so with minScore below that this degrades to
 * the pure rank-based top-k. Pure/deterministic; exported for testing.
 */
export function selectCandidatesByScore(
  candidates: Candidate[],
  scores: Map<string, TriageScore>,
  perQuery: number,
  minScore: number,
): Candidate[] {
  const scoreOf = (c: Candidate) => scores.get(c.url)?.score ?? UNSCORED.score;
  const byQuery = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const q = c.intents[0] ?? "";
    const arr = byQuery.get(q);
    if (arr) arr.push(c);
    else byQuery.set(q, [c]);
  }
  const out: Candidate[] = [];
  const chosen = new Set<string>();
  for (const list of byQuery.values()) {
    // Stable sort by score desc — preserve encounter (rank) order within equal scores.
    const ranked = list
      .map((c, i) => ({ c, i }))
      .sort((a, b) => scoreOf(b.c) - scoreOf(a.c) || a.i - b.i)
      .map((x) => x.c);
    let taken = 0;
    for (const c of ranked) {
      if (taken >= perQuery) break;
      if (scoreOf(c) < minScore) break; // sorted desc → everything after is also below the bar
      if (chosen.has(c.url)) continue;
      chosen.add(c.url);
      out.push(c);
      taken += 1;
    }
  }
  return out;
}
