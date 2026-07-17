/**
 * evidence/provider.ts — the search/scrape seam: every call site (baseline arm, orchestrated
 * retrieve, the agentic researcher) talks to THIS module, never to a specific vendor's file
 * directly.
 *
 * Search (finding URLs+snippets) and scrape (fetching page content for a URL already selected)
 * are INDEPENDENTLY configurable operations (evidence/config.ts's SEARCH_PROVIDER /
 * SCRAPE_PROVIDER) — a provider only needs to implement the small `SearchOps` / `ScrapeOps`
 * capability interfaces below (`rawSearch` / `scrapeUrl`, each a single bare network call, never
 * cached, never composed) to be pluggable into either role, or both. This module owns the ONE
 * shared, provider-agnostic pipeline that composes those primitives — adapt intents, dedupe,
 * triage, cache, the bounded scrape worker pool, ScanEvent emission — so that logic exists exactly
 * once regardless of which providers are selected. See docs/search-scrape-provider-split-spec.md.
 *
 * The four exported operations mirror what the pre-split firecrawl.ts exposed externally (every
 * real importer, grep-verified):
 *   - explore()        the baseline arm's full search→triage→scrape pipeline
 *   - search()         the orchestrated arm's per-question search+scrape → Evidence[]
 *   - webSearchRaw()    the agentic researcher's snippet-only search (no scrape)
 *   - scrapeOneCached() the agentic researcher's single-URL scrape, cache-aware
 *
 * `firecrawlCalls`/`firecrawlCredits` on ExploreResult and `searchCredits`/`scrapeCredits` (on
 * both ExploreResult and SearchResult) keep their historical names (used pervasively downstream —
 * ResearchState, mechanics.ts, SSE events, the UI) even though they're provider-agnostic in
 * MEANING: "network calls made" / "billing units spent" (see pricing.ts's SEARCH_PROVIDER_PRICING
 * for what a "credit" means per provider).
 */
import type { ScanEvent, TokenUsage } from "../events";
import type { Source } from "../schema";
import type { Intent } from "../intents";
import { domainOf, truncate } from "../format";
import { loadBlocklist, blocklistKey } from "../blocklist";
import { getCache, setCache } from "../scrape-cache";
import { getSearchCache, setSearchCache } from "../search-cache";
import {
  SEARCH_PROVIDER,
  SCRAPE_PROVIDER,
  type SearchProviderId,
  RESULTS_PER_INTENT,
  MAX_SCRAPE,
  QUOTA_FLOOR,
  SEARCH_CANDIDATES_PER_QUESTION,
  SCRAPE_CONCURRENCY,
  TRIAGE_ENABLED,
  MIN_TRIAGE_SCORE,
  MAX_CHARS_PER_PAGE,
} from "./config";
import { makeIntents, scoreCandidates, selectSources, triageModel, type Candidate } from "../triage";
import { dedupeCandidates, capCandidatesPerQuery, selectCandidatesByScore } from "./candidates";
import { type Evidence, contentHash } from "./store";
import { getActiveTrace } from "../orchestration/trace";
import * as firecrawl from "./firecrawl";
import * as exa from "./exa";

/** Monotonic clock injected for testability. Defaults to Date.now in production. */
export type Clock = () => number;

/** Opaque per-run client/session handle a provider may hold across many calls (e.g. an HTTP
 * client instance amortized across a researcher pass). Providers needing no persistent state
 * (stateless HTTP+key) can ignore it — callers always treat it as opaque. */
export type ProviderClient = unknown;

/** A search hit before it's promoted to a citable Source. NEVER carries page content, even if the
 * provider could supply it inline for free (Exa) — content-fetching is always the scrape
 * provider's job (see §7 of the split spec). */
export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
}

export interface SearchOps {
  /** Construct whatever per-run client/session state this provider needs (may be a no-op). */
  createClient(): ProviderClient;
  /** One query -> hits, never content. A live (cache-miss) call bills its provider's
   * creditsPerSearch rate (pricing.ts) whether it succeeds or fails; never throws. */
  rawSearch(query: string, numResults: number, client?: ProviderClient): Promise<{ hits: SearchHit[]; credits: number }>;
}

export interface ScrapeOps {
  /** Construct whatever per-run client/session state this provider needs (may be a no-op). */
  createClient(): ProviderClient;
  /** Fetch one URL's page content, uncached, untruncated by this interface's caller (each
   * implementation applies MAX_CHARS_PER_PAGE itself). A live call bills its provider's
   * creditsPerScrape rate (pricing.ts) whether it succeeds or fails; never throws. */
  scrapeUrl(url: string, client?: ProviderClient): Promise<{ content: string; credits: number }>;
}

/**
 * Named field-by-field, not a blind cast — this is what actually enforces that firecrawl.ts's
 * (and exa.ts's) exports satisfy SearchOps/ScrapeOps at compile time. A cast like
 * `firecrawl as unknown as SearchOps` would compile even with a missing/renamed export and only
 * fail at runtime; this construction fails to compile instead.
 */
const SEARCH_OPS: Record<SearchProviderId, SearchOps> = {
  firecrawl: { createClient: firecrawl.makeFirecrawl, rawSearch: firecrawl.rawSearch },
  exa: { createClient: exa.makeExaClient, rawSearch: exa.rawSearch },
};

const SCRAPE_OPS: Record<SearchProviderId, ScrapeOps> = {
  firecrawl: { createClient: firecrawl.makeFirecrawl, scrapeUrl: firecrawl.scrapeUrl },
  exa: { createClient: exa.makeExaClient, scrapeUrl: exa.scrapeUrl },
};

function getSearchOps(): SearchOps {
  return SEARCH_OPS[SEARCH_PROVIDER];
}

function getScrapeOps(): ScrapeOps {
  return SCRAPE_OPS[SCRAPE_PROVIDER];
}

/** Construct a fresh client for whichever provider is currently SEARCH_PROVIDER / SCRAPE_PROVIDER.
 * Exported so a caller that wants to amortize a client across many calls (e.g. the researcher
 * agent, one call per tool invocation) can create it once per run. Constructing (not importing)
 * is what may throw on a missing API key — selecting a provider for only ONE of search/scrape
 * never requires the other's key to be set. */
export const createSearchClient = (): ProviderClient => getSearchOps().createClient();
export const createScrapeClient = (): ProviderClient => getScrapeOps().createClient();

/** A scraped source: a Source plus the page text fed to the model. */
export interface ScrapedSource extends Source {
  content: string;
}

export interface ExploreResult {
  sources: Source[];
  scraped: ScrapedSource[];
  searchMs: number;
  scrapeMs: number;
  firecrawlCalls: number;
  firecrawlCredits: number;
  searchCredits: number;
  scrapeCredits: number;
}

export interface SearchResult {
  evidence: Evidence[];
  searchCredits: number;
  scrapeCredits: number;
  /** The relevance-triage LLM call's usage, when triage ran (the caller books its cost). */
  triageUsage?: TokenUsage;
}

/**
 * Live progress from inside `search()` — lets a streaming transport show motion during the
 * minutes-long search+scrape phase. Purely observational: emission order and content never
 * affect the returned SearchResult.
 */
export type SearchProgress =
  | { kind: "search"; query: string; hits: number; cached: boolean }
  | { kind: "scrape"; done: number; total: number };

// ---------------------------------------------------------------------------
// cache-aware primitives — provider-agnostic; every pipeline below routes through these instead
// of calling rawSearch/scrapeUrl directly, so caching logic exists exactly once.
// ---------------------------------------------------------------------------

async function cachedSearch(
  query: string,
  numResults: number,
  ops: SearchOps,
  client: ProviderClient | undefined,
): Promise<{ hits: SearchHit[]; credits: number; cached: boolean }> {
  const cachedHits = await getSearchCache(query);
  if (cachedHits) {
    getActiveTrace()?.logFirecrawlCall("search-cache-hit", { query }, cachedHits.length);
    return { hits: cachedHits.map((d) => ({ url: d.url, title: d.title, snippet: d.snippet })), credits: 0, cached: true };
  }
  const { hits, credits } = await ops.rawSearch(query, numResults, client);
  getActiveTrace()?.logFirecrawlCall("search", { query, limit: numResults }, hits.length);
  void setSearchCache(query, hits.map(({ url, title, snippet }) => ({ url, title, snippet })));
  return { hits, credits, cached: false };
}

async function cachedScrape(
  url: string,
  ops: ScrapeOps,
  client: ProviderClient | undefined,
): Promise<{ content: string; credits: number; cached: boolean }> {
  const cachedContent = await getCache(url);
  if (cachedContent !== null) {
    // Defensively truncate on read too, not just on write — a cache entry written by an OLDER
    // build (before this module applied MAX_CHARS_PER_PAGE at write time, or under a since-lowered
    // limit) must not reach a caller oversized. Idempotent for entries already truncated.
    const content = truncate(cachedContent, MAX_CHARS_PER_PAGE);
    getActiveTrace()?.logFirecrawlCall("scrape-cache-hit", { url }, content.length);
    return { content, credits: 0, cached: true };
  }
  const { content, credits } = await ops.scrapeUrl(url, client);
  if (content.length > 0) void setCache(url, content);
  getActiveTrace()?.logFirecrawlCall("scrape", { url, status: content.length > 0 ? "ok" : "empty" }, content.length);
  return { content, credits, cached: false };
}

// ---------------------------------------------------------------------------
// search phase (multi-intent, for explore(); multi-query, for search())
// ---------------------------------------------------------------------------

async function searchAllIntents(
  intents: Intent[],
  onEvent: (e: ScanEvent) => void,
  now: Clock,
  ops: SearchOps,
  client: ProviderClient | undefined,
): Promise<{ hits: (SearchHit & { intent: string })[]; credits: number; apiCalls: number }> {
  let credits = 0;
  let apiCalls = 0;
  const perIntent = await Promise.all(
    intents.map(async (intent) => {
      onEvent({ type: "search:begin", intent: intent.label });
      const t0 = now();
      const { hits, credits: c } = await cachedSearch(intent.query, RESULTS_PER_INTENT, ops, client);
      if (c > 0) {
        credits += c;
        apiCalls += 1;
      }
      onEvent({ type: "search:done", intent: intent.label, count: hits.length, ms: now() - t0 });
      return hits.map((h) => ({ ...h, intent: intent.label }));
    }),
  );
  return { hits: perIntent.flat(), credits, apiCalls };
}

// ---------------------------------------------------------------------------
// scrape phase — bounded worker pool
// ---------------------------------------------------------------------------

/** A ranked source paired with whether its domain is currently blocklisted. */
interface RankedSource {
  source: Source;
  blocked: boolean;
}

/**
 * Scrape one ranked source. Never throws — always resolves to a ScrapedSource (empty content on
 * failure, since the source is still citable from its search snippet). Emits scrape:begin and a
 * scrape:done whose `status` distinguishes the outcomes (ok/blocked/skipped/cached/empty).
 *
 * `blockset` is the SAME Set instance loadBlocklist() returned earlier for this pipeline run — a
 * provider's scrapeUrl (e.g. firecrawl.ts's, on a detected hard block) may call recordBlock()
 * DURING this call, which mutates that same Set in place. Re-checking membership AFTER a live,
 * empty-content call distinguishes "just blocked" from "merely empty/transient" for the emitted
 * event, without ScrapeOps needing to expose that distinction itself.
 */
async function scrapeOneRanked(
  src: Source,
  blocked: boolean,
  onEvent: (e: ScanEvent) => void,
  now: Clock,
  ops: ScrapeOps,
  client: ProviderClient | undefined,
  blockset: Set<string>,
): Promise<{ source: ScrapedSource; credits: number }> {
  if (blocked) {
    onEvent({ type: "scrape:done", id: src.id, domain: src.domain, status: "skipped", chars: 0, ms: 0 });
    return { source: { ...src, content: "" }, credits: 0 };
  }
  if (/\.pdf(\?|#|$)/i.test(src.url)) {
    onEvent({ type: "scrape:done", id: src.id, domain: src.domain, status: "skipped", chars: 0, ms: 0 });
    return { source: { ...src, content: "" }, credits: 0 };
  }

  // Cache hit — no "begin" event, no network call, matching a genuine live attempt's shape.
  // Defensively truncate on read too, not just on write — see cachedScrape's comment.
  const rawCached = await getCache(src.url);
  if (rawCached !== null) {
    const cachedContent = truncate(rawCached, MAX_CHARS_PER_PAGE);
    getActiveTrace()?.logFirecrawlCall("scrape-cache-hit", { url: src.url }, cachedContent.length);
    onEvent({ type: "scrape:done", id: src.id, domain: src.domain, status: "cached", chars: cachedContent.length, ms: 0 });
    return { source: { ...src, content: cachedContent }, credits: 0 };
  }

  onEvent({ type: "scrape:begin", id: src.id, domain: src.domain });
  const t0 = now();
  const { content, credits } = await ops.scrapeUrl(src.url, client);
  if (content.length > 0) void setCache(src.url, content);
  getActiveTrace()?.logFirecrawlCall("scrape", { url: src.url, status: content.length > 0 ? "ok" : "empty" }, content.length);
  const status: "ok" | "blocked" | "empty" =
    content.length > 0 ? "ok" : blockset.has(blocklistKey(src.domain)) ? "blocked" : "empty";
  onEvent({ type: "scrape:done", id: src.id, domain: src.domain, status, chars: content.length, ms: now() - t0 });
  return { source: { ...src, content }, credits };
}

/**
 * Scrape the ranked sources with BOUNDED concurrency (SCRAPE_CONCURRENCY workers pulling from a
 * shared cursor). The true network-in-flight cap is enforced inside each provider's own
 * rawSearch/scrapeUrl (PROVIDER_CONCURRENCY, evidence/config.ts) — this worker pool just overlaps
 * cache lookups and setup ahead of it. Never throws; results preserve input order.
 */
async function scrapeSourcesPool(
  ranked: RankedSource[],
  onEvent: (e: ScanEvent) => void,
  now: Clock,
  ops: ScrapeOps,
  client: ProviderClient | undefined,
  blockset: Set<string>,
): Promise<{ scraped: ScrapedSource[]; credits: number; apiCalls: number }> {
  const results: ScrapedSource[] = new Array(ranked.length);
  let next = 0;
  let credits = 0;
  let apiCalls = 0;

  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= ranked.length) return;
      const r = ranked[i];
      const { source, credits: c } = await scrapeOneRanked(r.source, r.blocked, onEvent, now, ops, client, blockset);
      results[i] = source;
      if (c > 0) {
        credits += c;
        apiCalls += 1;
      }
    }
  };

  const workerCount = Math.min(SCRAPE_CONCURRENCY, ranked.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return { scraped: results, credits, apiCalls };
}

// ---------------------------------------------------------------------------
// public pipelines
// ---------------------------------------------------------------------------

/**
 * The full exploration step (baseline arm), with LLM judgment in the loop:
 *
 *   (a) ADAPT  — makeIntents(industry) designs industry-specific search intents (fallback: static).
 *       SEARCH — run all intents (RESULTS_PER_INTENT results each) in parallel via SEARCH_PROVIDER;
 *                emit per-intent timing.
 *       DEDUPE — collapse to unique candidates, merging the intents that found each URL.
 *   (c) TRIAGE — scoreCandidates() scores each candidate 0–10 before we spend any scrape.
 *       SELECT — selectSources() picks the final set (per-intent quota floor + merit fill), each
 *                carrying its relevanceScore + reason.
 *       SCRAPE — bounded concurrency via SCRAPE_PROVIDER + blocklist skip.
 *
 * Every source is cross-referenced against the running blocklist (lib/blocklist.ts) and flagged
 * `blocked` so the UI shows it as intentionally skipped. Both LLM steps fall back gracefully — a
 * failure never throws, it degrades to today's behavior. Emits phase timings for the UI.
 *
 * @param industry  the raw industry string (intent generation happens here).
 * @param now       Monotonic clock (defaults to Date.now); injected for deterministic tests.
 */
export async function explore(
  industry: string,
  onEvent: (e: ScanEvent) => void,
  now: Clock = () => Date.now(),
): Promise<ExploreResult> {
  const searchOps = getSearchOps();
  const scrapeOps = getScrapeOps();
  const searchClient = searchOps.createClient();
  const scrapeClient = scrapeOps.createClient();
  const maxScrape = MAX_SCRAPE;
  const quotaFloor = QUOTA_FLOOR;

  // --- (a) Adapt intents ---
  const adaptStart = now();
  onEvent({ type: "adapt:begin", model: triageModel() });
  const { intents, adapted, usage: adaptUsage } = await makeIntents(industry);
  onEvent({
    type: "intents",
    intents: intents.map((i) => ({ label: i.label, query: i.query })),
    adapted,
    ms: now() - adaptStart,
    usage: adaptUsage,
  });

  // --- Search + dedupe (blocklist loads in parallel — it's just a file read) ---
  const searchStart = now();
  const [searchResult, blockset] = await Promise.all([
    searchAllIntents(intents, onEvent, now, searchOps, searchClient),
    loadBlocklist(),
  ]);
  const allCandidates = dedupeCandidates(searchResult.hits);
  const searchMs = now() - searchStart;
  const blocked: Candidate[] = [];
  const candidates: Candidate[] = [];
  for (const c of allCandidates) {
    if (blockset.has(blocklistKey(domainOf(c.url))) || /\.pdf(\?|#|$)/i.test(c.url)) blocked.push(c);
    else candidates.push(c);
  }

  // --- (c) Triage: score candidates before scraping ---
  const triageStart = now();
  onEvent({ type: "triage:begin", model: triageModel(), candidates: candidates.length, blocked: blocked.length });
  const { scores, usage: triageUsage } = await scoreCandidates(industry, candidates);
  const sources = selectSources(candidates, scores, maxScrape, quotaFloor);
  onEvent({
    type: "triage:done",
    candidates: candidates.length,
    selected: sources.length,
    blocked: blocked.length,
    adapted,
    ms: now() - triageStart,
    usage: triageUsage,
  });

  const ranked: RankedSource[] = sources.map((source) => ({ source, blocked: false }));

  onEvent({
    type: "sources",
    searchMs,
    sources: ranked.map((r) => ({ ...r.source, blocked: r.blocked })),
  });

  // --- Scrape phase (bounded concurrency; skips blocked domains) ---
  const scrapeStart = now();
  const { scraped, credits: scrapeCredits, apiCalls: scrapeApiCalls } = await scrapeSourcesPool(
    ranked,
    onEvent,
    now,
    scrapeOps,
    scrapeClient,
    blockset,
  );
  const scrapeMs = now() - scrapeStart;

  const searchCredits = searchResult.credits;
  const firecrawlCalls = searchResult.apiCalls + scrapeApiCalls;
  const firecrawlCredits = searchCredits + scrapeCredits;

  return { sources, scraped, searchMs, scrapeMs, firecrawlCalls, firecrawlCredits, searchCredits, scrapeCredits };
}

/**
 * Search for evidence across multiple queries, scrape results, and return typed Evidence[].
 * Each result is tagged with sourceQuery (the query that surfaced it) and loopIteration.
 */
export async function search(
  queries: string[],
  k: number,
  loopIteration: number,
  onProgress?: (p: SearchProgress) => void,
  context = "",
): Promise<SearchResult> {
  const searchOps = getSearchOps();
  const scrapeOps = getScrapeOps();
  const searchClient = searchOps.createClient();
  const scrapeClient = scrapeOps.createClient();
  const now: Clock = () => Date.now();
  const noop = () => {};

  // Track per-URL snippet and the query that surfaced each URL first.
  const metaByUrl = new Map<string, { snippet: string; sourceQuery: string }>();
  const fetchLimit = SEARCH_CANDIDATES_PER_QUESTION;
  let searchCredits = 0;

  const perQuery = await Promise.all(
    queries.map(async (query) => {
      const { hits, credits, cached } = await cachedSearch(query, fetchLimit, searchOps, searchClient);
      searchCredits += credits;
      onProgress?.({ kind: "search", query, hits: hits.length, cached });
      return hits.map((h) => ({ ...h, intent: query }));
    }),
  );

  const hits = perQuery.flat();
  for (const h of hits) {
    if (!metaByUrl.has(h.url)) {
      metaByUrl.set(h.url, { snippet: h.snippet, sourceQuery: h.intent });
    }
  }

  // Select which candidates to scrape BEFORE scraping, so we only pay to scrape pages we'll use.
  // With triage on, one cheap LLM call scores every deduped candidate for relevance to `context`
  // and we keep the top-k per query above MIN_TRIAGE_SCORE; off, fall back to the rank-based cap.
  const deduped = dedupeCandidates(hits);
  let candidates: Candidate[];
  let triageUsage: TokenUsage | undefined;
  if (TRIAGE_ENABLED && deduped.length > 0) {
    const { scores, usage } = await scoreCandidates(context, deduped);
    triageUsage = usage;
    candidates = selectCandidatesByScore(deduped, scores, k, MIN_TRIAGE_SCORE);
    getActiveTrace()?.log("triage", { context, scored: deduped.length, selected: candidates.length });
  } else {
    candidates = capCandidatesPerQuery(deduped, k);
  }
  const blockset = await loadBlocklist();

  const ranked: RankedSource[] = candidates.map((c, i) => ({
    source: {
      id: i,
      url: c.url,
      domain: domainOf(c.url),
      title: c.title,
      intent: c.intents[0] ?? "",
    },
    blocked: blockset.has(blocklistKey(domainOf(c.url))),
  }));

  // Count scrape completions (any status) for live progress; scrapeSourcesPool itself
  // already reports every outcome through its ScanEvent callback.
  let scrapesDone = 0;
  const scrapeProgress = onProgress
    ? (e: ScanEvent) => {
        if (e.type === "scrape:done") {
          onProgress({ kind: "scrape", done: ++scrapesDone, total: ranked.length });
        }
      }
    : noop;
  const { scraped, credits: scrapeCredits } = await scrapeSourcesPool(ranked, scrapeProgress, now, scrapeOps, scrapeClient, blockset);

  const withContent = scraped.filter((s) => s.content.length > 0);

  // Cap per source query so each question gets up to k usable sources.
  const seen = new Map<string, number>();
  const capped = withContent.filter((s) => {
    const query = metaByUrl.get(s.url)?.sourceQuery ?? s.intent;
    const count = seen.get(query) ?? 0;
    if (count >= k) return false;
    seen.set(query, count + 1);
    return true;
  });

  const evidence: Evidence[] = capped.map((s) => {
    const meta = metaByUrl.get(s.url) ?? { snippet: "", sourceQuery: s.intent };
    const hash = contentHash(s.content || s.url);
    return {
      id: hash,
      url: s.url,
      domain: s.domain,
      title: s.title,
      snippet: meta.snippet,
      content: s.content,
      contentHash: hash,
      sourceQuery: meta.sourceQuery,
      loopIteration,
    };
  });

  return { evidence, searchCredits, scrapeCredits, triageUsage };
}

/**
 * Snippet-only web search for the researcher agent's `webSearch` tool — no page content, the
 * agent decides what to read via `scrapeOneCached`. Cache-aware (0 credits on a cache hit).
 */
export async function webSearchRaw(
  query: string,
  client?: ProviderClient,
): Promise<{ hits: SearchHit[]; credits: number }> {
  const ops = getSearchOps();
  const { hits, credits } = await cachedSearch(query, SEARCH_CANDIDATES_PER_QUESTION, ops, client ?? ops.createClient());
  return { hits, credits };
}

/**
 * Scrape a single URL for the researcher agent's `readSource` tool, cache-aware, reporting REAL
 * post-cache credits. A blocklisted domain or a PDF costs 0 with no attempt; a genuine live fetch
 * bills the active SCRAPE_PROVIDER's rate. Never throws.
 */
export async function scrapeOneCached(
  url: string,
  client?: ProviderClient,
): Promise<{ url: string; domain: string; content: string; credits: number }> {
  const domain = domainOf(url);
  const ops = getScrapeOps();
  const blockset = await loadBlocklist();
  const blocked = blockset.has(blocklistKey(domain));
  const isPdf = /\.pdf(\?|#|$)/i.test(url);
  if (blocked || isPdf) return { url, domain, content: "", credits: 0 };

  const { content, credits } = await cachedScrape(url, ops, client ?? ops.createClient());
  return { url, domain, content, credits };
}
