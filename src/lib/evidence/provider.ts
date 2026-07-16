/**
 * evidence/provider.ts — the SearchProvider seam: every call site (baseline arm, orchestrated
 * retrieve, the agentic researcher) talks to THIS module, never to a specific vendor's file
 * directly. Swapping search/scrape backends (Firecrawl → Exa, or a future provider) means writing
 * one new file that implements SearchProvider and flipping SEARCH_PROVIDER in evidence/config.ts —
 * no call site changes.
 *
 * The four operations mirror what firecrawl.ts already exposed externally (grep-verified against
 * every real importer before this was written — no speculative surface):
 *   - explore()        the baseline arm's full search→triage→scrape pipeline
 *   - search()         the orchestrated arm's per-question search+scrape → Evidence[]
 *   - webSearchRaw()    the agentic researcher's snippet-only search (no scrape)
 *   - scrapeOneCached() the agentic researcher's single-URL scrape, cache-aware
 *
 * `firecrawlCalls`/`firecrawlCredits` on ExploreResult and `searchCredits`/`scrapeCredits` on
 * SearchResult keep their historical names (used pervasively downstream — ResearchState,
 * mechanics.ts, SSE events, the UI) even though they're now provider-agnostic in MEANING: "network
 * calls made" / "billing units spent". A provider whose billing model doesn't map cleanly onto
 * Firecrawl's 2-credits-per-search/1-per-scrape convention should report its best-effort
 * equivalent — see evidence/exa.ts's comment on this for the approximation it makes.
 */
import type { ScanEvent } from "../events";
import type { Source } from "../schema";
import { SEARCH_PROVIDER, type SearchProviderId } from "./config";
import * as firecrawl from "./firecrawl";
import * as exa from "./exa";
// Canonical definitions stay in firecrawl.ts (where they originated); re-exported here so this
// interface's signatures and callers importing from this module use the SAME type, not a second
// independently-maintained copy that could drift.
export type { ScrapedSource, SearchProgress, SearchResult } from "./firecrawl";
import type { ScrapedSource, SearchProgress, SearchResult } from "./firecrawl";

/** Monotonic clock injected for testability. Defaults to Date.now in production. */
export type Clock = () => number;

/** A search hit before it's promoted to a citable Source. */
export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
}

export interface ExploreResult {
  sources: Source[];
  scraped: ScrapedSource[];
  searchMs: number;
  scrapeMs: number;
  firecrawlCalls: number;
  firecrawlCredits: number;
}

/** Opaque per-run client/session handle a provider may hold across many calls (e.g. an HTTP
 * client instance amortized across a researcher pass). Providers needing no persistent state
 * (stateless HTTP+key) can ignore it — callers always treat it as opaque. */
export type ProviderClient = unknown;

export interface SearchProvider {
  /** Construct whatever per-run client/session state this provider needs (may be a no-op). */
  createClient(): ProviderClient;
  /** The baseline arm's full pipeline: adapt intents → search → triage → scrape. */
  explore(industry: string, onEvent: (e: ScanEvent) => void, now?: Clock, nowIso?: string): Promise<ExploreResult>;
  /** The orchestrated arm's per-question search+triage+scrape → Evidence[]. */
  search(
    queries: string[],
    k: number,
    loopIteration: number,
    onProgress?: (p: SearchProgress) => void,
    context?: string,
  ): Promise<SearchResult>;
  /** The agentic researcher's snippet-only search (no scrape) — the `webSearch` tool. */
  webSearchRaw(query: string, client?: ProviderClient): Promise<{ hits: SearchHit[]; credits: number }>;
  /** The agentic researcher's single-URL scrape, cache-aware — the `readSource` tool. */
  scrapeOneCached(
    url: string,
    client?: ProviderClient,
  ): Promise<{ url: string; domain: string; content: string; credits: number }>;
}

/**
 * Named field-by-field, not a blind cast — this is what actually enforces that firecrawl.ts's
 * (and exa.ts's) exported functions satisfy SearchProvider at compile time. A cast like
 * `firecrawl as unknown as SearchProvider` would compile even with a missing/renamed export and
 * only fail at runtime; this construction fails to compile instead.
 */
const firecrawlProvider: SearchProvider = {
  createClient: firecrawl.makeFirecrawl,
  explore: firecrawl.explore,
  search: firecrawl.search,
  webSearchRaw: firecrawl.webSearchRaw,
  scrapeOneCached: firecrawl.scrapeOneCached,
};

// Assembled the same way (named field-by-field, not a blind cast) in evidence/exa.ts and
// imported directly. Constructing the client / making a call is what may throw on a missing API
// key (mirrors firecrawl.ts's makeFirecrawl()) — importing this module never does, so selecting
// "firecrawl" via SEARCH_PROVIDER never requires an EXA_API_KEY to be set.
const exaProvider: SearchProvider = {
  createClient: exa.makeExaClient,
  explore: exa.explore,
  search: exa.search,
  webSearchRaw: exa.webSearchRaw,
  scrapeOneCached: exa.scrapeOneCached,
};

const PROVIDERS: Record<SearchProviderId, SearchProvider> = {
  firecrawl: firecrawlProvider,
  exa: exaProvider,
};

export function getSearchProvider(): SearchProvider {
  return PROVIDERS[SEARCH_PROVIDER];
}

// Free-function re-exports so call sites barely change (still `import { explore } from
// ".../evidence/provider"` instead of "...evidence/firecrawl") — they just resolve through
// whichever provider SEARCH_PROVIDER selects instead of being hardwired to Firecrawl.
export const createClient: SearchProvider["createClient"] = (...args) =>
  getSearchProvider().createClient(...args);
export const explore: SearchProvider["explore"] = (...args) => getSearchProvider().explore(...args);
export const search: SearchProvider["search"] = (...args) => getSearchProvider().search(...args);
export const webSearchRaw: SearchProvider["webSearchRaw"] = (...args) => getSearchProvider().webSearchRaw(...args);
export const scrapeOneCached: SearchProvider["scrapeOneCached"] = (...args) =>
  getSearchProvider().scrapeOneCached(...args);
