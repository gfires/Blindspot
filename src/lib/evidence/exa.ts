/**
 * exa.ts — Exa implementation of the SearchProvider interface (evidence/provider.ts), a drop-in
 * alternative to firecrawl.ts. Flip SEARCH_PROVIDER="exa" in evidence/config.ts to select it.
 *
 * Implemented against Exa's documented /search API shape; not yet verified against a live API
 * key or real traffic.
 *
 * SHAPE DIFFERENCE FROM FIRECRAWL: Exa's POST /search returns page content INLINE (via
 * `contents: { text: true }`) in the SAME call that returns hits — there is no separate
 * search-then-scrape round trip. Everywhere firecrawl.ts does "search (snippets only) → pick
 * candidates → scrape each candidate", this module instead requests content up front for every
 * hit a live search returns, and the later "scrape phase" is mostly just pulling that content
 * out of an in-memory map (`contentByUrl`) plus caching it — a genuinely new network call only
 * happens when a candidate's content wasn't part of the original search response (e.g. the
 * search hit itself came from the search-cache, which stores only title/url/snippet, not body
 * text). In that fallback case we fetch the URL's content the same way scrapeOneCached does:
 * issue a /search call with the URL itself as the query and numResults: 1.
 *
 * CREDIT ACCOUNTING: Exa bills in real dollars (`costDollars.total`), not Firecrawl's discrete
 * "2 credits per search / 1 credit per scrape" convention that the rest of this codebase's
 * budget tracking assumes. Approximation used throughout this file: charge 1 credit per live
 * (cache-miss) /search API call, regardless of `numResults` or whether `contents.text` was
 * requested. A single Exa search call already does the work of a Firecrawl search AND scrape
 * (content comes back inline), so 1 credit — not 2 — is charged per live call. A cache hit
 * (search-cache or scrape-cache) costs 0, same as firecrawl.ts.
 */
import type { ScanEvent, TokenUsage } from "../events";
import type { Source } from "../schema";
import type { Intent } from "../intents";
import { domainOf, truncate } from "../format";
import { loadBlocklist, blocklistKey } from "../blocklist";
import { getCache, setCache } from "../scrape-cache";
import { getSearchCache, setSearchCache } from "../search-cache";
import {
  MAX_CHARS_PER_PAGE,
  RESULTS_PER_INTENT,
  MAX_SCRAPE,
  QUOTA_FLOOR,
  SEARCH_CANDIDATES_PER_QUESTION,
  PROVIDER_CONCURRENCY,
  TRIAGE_ENABLED,
  MIN_TRIAGE_SCORE,
} from "./config";
import { makeIntents, scoreCandidates, selectSources, triageModel, type Candidate } from "../triage";
import {
  dedupeCandidates,
  capCandidatesPerQuery,
  selectCandidatesByScore,
  type ScrapedSource,
  type SearchResult,
  type SearchProgress,
} from "./firecrawl";
import { type Evidence, contentHash } from "./store";
import { createLimiter } from "../orchestration/limiter";
import type { Clock, ExploreResult } from "./provider";

const EXA_API_URL = "https://api.exa.ai/search";

/** One shared FIFO queue for every Exa network call, mirroring firecrawlLimiter in firecrawl.ts.
 * Exa's true per-account ceiling is unverified (see PROVIDER_CONCURRENCY.exa's comment); this
 * just keeps bursts from all landing on the wire at once. */
const exaLimiter = createLimiter(PROVIDER_CONCURRENCY.exa);

/** Lightweight per-run client: just the validated API key. Exa's API is stateless HTTP, so
 * there's no session/connection to amortize — this only exists to mirror makeFirecrawl()'s
 * "throw early if misconfigured" contract. */
export interface ExaClient {
  apiKey: string;
}

/** Construct the Exa client. Throws a clear error if the key is missing (mirrors
 * firecrawl.ts's makeFirecrawl()). Importing this module never throws — only calling this
 * (or a function that defaults to calling this) does, so selecting "firecrawl" via
 * SEARCH_PROVIDER never requires an EXA_API_KEY to be set. */
export function makeExaClient(): ExaClient {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) throw new Error("EXA_API_KEY is not set. Copy .env.local.example to .env.local.");
  return { apiKey };
}

/** One hit from Exa's /search results array. Only the fields this module reads. */
interface ExaResultItem {
  title?: string | null;
  url: string;
  id?: string;
  text?: string;
  highlights?: string[];
}

interface ExaSearchResponse {
  requestId?: string;
  searchType?: string;
  results?: ExaResultItem[];
  costDollars?: { total: number };
}

/**
 * POST to Exa's /search endpoint. Never throws — returns null on any network error, non-OK
 * status, or malformed JSON, so every caller degrades to "no results" rather than propagating
 * an exception (mirrors the never-throw contract every public export in this file upholds).
 */
async function exaFetch(client: ExaClient, body: Record<string, unknown>): Promise<ExaSearchResponse | null> {
  try {
    const res = await exaLimiter(() =>
      fetch(EXA_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": client.apiKey,
        },
        body: JSON.stringify(body),
      }),
    );
    if (!res.ok) return null;
    return (await res.json()) as ExaSearchResponse;
  } catch {
    return null;
  }
}

/** A search hit before it's promoted to a citable Source — same shape firecrawl.ts's internal
 * SearchHit uses (so dedupeCandidates/capCandidatesPerQuery accept it structurally), plus the
 * inline page content Exa hands back for free with a live search. */
interface ExaHit {
  url: string;
  title: string;
  snippet: string;
  intent: string;
  content?: string;
}

/**
 * Run every intent's search query against Exa in parallel, requesting inline content
 * (`contents.text`) so the later "scrape" phase can usually skip a second network call. Emits
 * search:begin/done per intent, mirroring firecrawl.ts's searchAllIntents. A cached intent query
 * (search-cache stores only title/url/snippet) yields hits with no `content` — those fall back
 * to a live per-URL fetch during the scrape phase. Never throws; a failed intent contributes no
 * hits.
 */
async function searchAllIntentsExa(
  client: ExaClient,
  intents: Intent[],
  onEvent: (e: ScanEvent) => void,
  now: Clock,
): Promise<{ hits: ExaHit[]; apiCalls: number }> {
  let apiCalls = 0;

  const perIntent = await Promise.all(
    intents.map(async (intent) => {
      onEvent({ type: "search:begin", intent: intent.label });
      const t0 = now();
      try {
        const cached = await getSearchCache(intent.query);
        if (cached) {
          const hits: ExaHit[] = cached.map((d) => ({ ...d, intent: intent.label }));
          onEvent({ type: "search:done", intent: intent.label, count: hits.length, ms: now() - t0 });
          return hits;
        }

        apiCalls++;
        const res = await exaFetch(client, {
          query: intent.query,
          type: "auto",
          numResults: RESULTS_PER_INTENT,
          contents: { text: { maxCharacters: MAX_CHARS_PER_PAGE } },
        });
        const results = res?.results ?? [];
        const hits: ExaHit[] = results
          .filter((r) => r.url)
          .map((r) => ({
            url: r.url,
            title: r.title || domainOf(r.url),
            snippet: (r.text ?? "").slice(0, 240),
            intent: intent.label,
            content: r.text ?? "",
          }));
        void setSearchCache(intent.query, hits.map(({ url, title, snippet }) => ({ url, title, snippet })));
        for (const h of hits) if (h.content) void setCache(h.url, h.content);
        onEvent({ type: "search:done", intent: intent.label, count: hits.length, ms: now() - t0 });
        return hits;
      } catch {
        onEvent({ type: "search:done", intent: intent.label, count: 0, ms: now() - t0 });
        return [];
      }
    }),
  );

  return { hits: perIntent.flat(), apiCalls };
}

/**
 * Resolve a URL's page content, cache-aware, never throwing. Used both by explore()'s scrape
 * phase (when a selected source's content wasn't already returned inline by the intent search)
 * and by scrapeOneCached(). `blocked` short-circuits to empty content with no network attempt
 * (mirrors firecrawl.ts's scrapeOne's proactive blocklist skip). PDFs are skipped the same way
 * firecrawl.ts skips them (Firecrawl and Exa alike don't productively scrape PDF binaries here).
 *
 * `live` reports whether a live Exa call was ATTEMPTED (true even if it failed/returned no
 * match) — Exa bills for the request whether it succeeds or not, mirroring firecrawl.ts's
 * webSearchRaw()/scrapeOneCached() credit convention of billing attempts, not just successes.
 */
async function scrapeUrlContent(
  client: ExaClient,
  url: string,
  blocked: boolean,
): Promise<{ content: string; live: boolean }> {
  if (blocked || /\.pdf(\?|#|$)/i.test(url)) return { content: "", live: false };

  const cached = await getCache(url);
  if (cached !== null) return { content: truncate(cached, MAX_CHARS_PER_PAGE), live: false };

  try {
    const res = await exaFetch(client, {
      query: url,
      type: "auto",
      numResults: 1,
      contents: { text: { maxCharacters: MAX_CHARS_PER_PAGE } },
    });
    const results = res?.results ?? [];
    const match = results.find((r) => r.url === url) ?? results[0];
    const text = match?.text ?? "";
    const content = truncate(text, MAX_CHARS_PER_PAGE);
    if (content.length > 0) void setCache(url, text);
    return { content, live: true };
  } catch {
    return { content: "", live: true };
  }
}

/**
 * The baseline arm's full pipeline, mirroring firecrawl.ts's explore(): adapt intents → search
 * (Exa, with inline content) → triage → "scrape" (mostly free, see module comment). Field names
 * (`sources`, `scraped`, `firecrawlCalls`, `firecrawlCredits`, ...) are kept identical to
 * firecrawl.ts's ExploreResult even though this isn't Firecrawl — see provider.ts's comment on
 * why those names are historical, not vendor-specific.
 */
export async function explore(
  industry: string,
  onEvent: (e: ScanEvent) => void,
  now: Clock = () => Date.now(),
  nowIso: string = new Date().toISOString(),
): Promise<ExploreResult> {
  const client = makeExaClient();
  const maxScrape = MAX_SCRAPE;
  const quotaFloor = QUOTA_FLOOR;

  // --- Adapt intents (provider-agnostic; same helper firecrawl.ts uses) ---
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

  // --- Search + dedupe ---
  const searchStart = now();
  const [searchResult, blockset] = await Promise.all([
    searchAllIntentsExa(client, intents, onEvent, now),
    loadBlocklist(),
  ]);
  const contentByUrl = new Map<string, string>();
  for (const h of searchResult.hits) if (h.content) contentByUrl.set(h.url, h.content);

  const allCandidates = dedupeCandidates(searchResult.hits);
  const searchMs = now() - searchStart;
  const blocked: Candidate[] = [];
  const candidates: Candidate[] = [];
  for (const c of allCandidates) {
    if (blockset.has(blocklistKey(domainOf(c.url))) || /\.pdf(\?|#|$)/i.test(c.url)) blocked.push(c);
    else candidates.push(c);
  }

  // --- Triage: score candidates before "scraping" (mostly already-fetched content) ---
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

  onEvent({
    type: "sources",
    searchMs,
    sources: sources.map((s) => ({ ...s, blocked: false })),
  });

  // --- "Scrape" phase: pull inline content where available, fall back to a live fetch ---
  const scrapeStart = now();
  let scrapeApiCalls = 0;
  const scraped: ScrapedSource[] = await Promise.all(
    sources.map(async (src: Source) => {
      onEvent({ type: "scrape:begin", id: src.id, domain: src.domain });
      const t0 = now();
      const inline = contentByUrl.get(src.url);
      let content: string;
      if (inline !== undefined) {
        content = truncate(inline, MAX_CHARS_PER_PAGE);
        if (content.length > 0) void setCache(src.url, inline);
      } else {
        const result = await scrapeUrlContent(client, src.url, false);
        content = result.content;
        if (result.live) scrapeApiCalls++;
      }
      onEvent({
        type: "scrape:done",
        id: src.id,
        domain: src.domain,
        status: content.length > 0 ? "ok" : "empty",
        chars: content.length,
        ms: now() - t0,
      });
      return { ...src, content };
    }),
  );
  const scrapeMs = now() - scrapeStart;
  void nowIso; // reserved for blocklist-recording parity with firecrawl.ts; Exa gives no distinct hard-block signal to record here.

  const firecrawlCalls = searchResult.apiCalls + scrapeApiCalls;
  // 1 credit per live Exa /search call — see module-level comment on the credit approximation.
  const firecrawlCredits = searchResult.apiCalls + scrapeApiCalls;

  return { sources, scraped, searchMs, scrapeMs, firecrawlCalls, firecrawlCredits };
}

/**
 * The orchestrated arm's per-question search+scrape → Evidence[], mirroring firecrawl.ts's
 * search(). Each query is searched against Exa (cache-first) with inline content requested; a
 * relevance-triage pass (when enabled) then narrows candidates before content is resolved
 * (usually already in hand from the search call — see module comment) and packaged as Evidence.
 */
export async function search(
  queries: string[],
  k: number,
  loopIteration: number,
  onProgress?: (p: SearchProgress) => void,
  context = "",
): Promise<SearchResult> {
  const client = makeExaClient();

  const metaByUrl = new Map<string, { snippet: string; sourceQuery: string }>();
  const contentByUrl = new Map<string, string>();
  const fetchLimit = SEARCH_CANDIDATES_PER_QUESTION;
  let searchCredits = 0;

  const perQuery = await Promise.all(
    queries.map(async (query) => {
      try {
        const cached = await getSearchCache(query);
        const raw = cached
          ? cached
          : await (async () => {
              searchCredits += 1;
              const res = await exaFetch(client, {
                query,
                type: "auto",
                numResults: fetchLimit,
                contents: { text: { maxCharacters: MAX_CHARS_PER_PAGE } },
              });
              const results = res?.results ?? [];
              const hits = results
                .filter((r) => r.url)
                .map((r) => ({
                  url: r.url,
                  title: r.title || domainOf(r.url),
                  snippet: (r.text ?? "").slice(0, 240),
                }));
              for (const r of results) if (r.url && r.text) contentByUrl.set(r.url, r.text);
              void setSearchCache(query, hits);
              return hits;
            })();
        onProgress?.({ kind: "search", query, hits: raw.length, cached: !!cached });
        return raw.map((h) => ({ ...h, intent: query }));
      } catch {
        onProgress?.({ kind: "search", query, hits: 0, cached: false });
        return [];
      }
    }),
  );

  const hits = perQuery.flat();
  for (const h of hits) {
    if (!metaByUrl.has(h.url)) metaByUrl.set(h.url, { snippet: h.snippet, sourceQuery: h.intent });
  }

  // Select which candidates to keep BEFORE resolving content, same rationale as firecrawl.ts:
  // only pay (in the rare live-fallback case) for candidates we'll actually use.
  const deduped = dedupeCandidates(hits);
  let candidates: Candidate[];
  let triageUsage: TokenUsage | undefined;
  if (TRIAGE_ENABLED && deduped.length > 0) {
    const { scores, usage } = await scoreCandidates(context, deduped);
    triageUsage = usage;
    candidates = selectCandidatesByScore(deduped, scores, k, MIN_TRIAGE_SCORE);
  } else {
    candidates = capCandidatesPerQuery(deduped, k);
  }
  const blockset = await loadBlocklist();

  const ranked = candidates.map((c, i) => ({
    source: {
      id: i,
      url: c.url,
      domain: domainOf(c.url),
      title: c.title,
      intent: c.intents[0] ?? "",
    } as Source,
    blocked: blockset.has(blocklistKey(domainOf(c.url))),
  }));

  let scrapesDone = 0;
  let scrapeCredits = 0;
  const scraped: ScrapedSource[] = await Promise.all(
    ranked.map(async (r) => {
      const inline = contentByUrl.get(r.source.url);
      let content: string;
      if (r.blocked) {
        content = "";
      } else if (inline !== undefined) {
        content = truncate(inline, MAX_CHARS_PER_PAGE);
        if (content.length > 0) void setCache(r.source.url, inline);
      } else {
        const result = await scrapeUrlContent(client, r.source.url, false);
        content = result.content;
        if (result.live) scrapeCredits++;
      }
      onProgress?.({ kind: "scrape", done: ++scrapesDone, total: ranked.length });
      return { ...r.source, content };
    }),
  );

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
 * Snippet-only search for the researcher agent's `webSearch` tool — no full page content. We
 * request `highlights` (short excerpts) but explicitly withhold `text` so we don't pay for/
 * receive full page bodies here (the agent decides what to read via `scrapeOneCached`). Credit
 * accounting mirrors firecrawl.ts's webSearchRaw: a live (cache-miss) query bills 1 credit
 * (Exa's approximation — see module comment) whether it succeeds or fails; a cache hit costs 0.
 * Never throws.
 */
export async function webSearchRaw(
  query: string,
  client: ExaClient = makeExaClient(),
): Promise<{ hits: { title: string; url: string; snippet: string }[]; credits: number }> {
  const cached = await getSearchCache(query);
  if (cached) {
    return { hits: cached.map((d) => ({ title: d.title, url: d.url, snippet: d.snippet })), credits: 0 };
  }

  try {
    const res = await exaFetch(client, {
      query,
      type: "auto",
      numResults: SEARCH_CANDIDATES_PER_QUESTION,
      contents: { text: false, highlights: true },
    });
    if (res === null) return { hits: [], credits: 1 };
    const results = res.results ?? [];
    const hits = results
      .filter((r) => r.url)
      .map((r) => ({
        url: r.url,
        title: r.title || domainOf(r.url),
        snippet: (r.highlights ?? []).join(" ").slice(0, 240),
      }));
    void setSearchCache(query, hits);
    return { hits, credits: 1 };
  } catch {
    return { hits: [], credits: 1 };
  }
}

/**
 * Scrape a single URL for the researcher agent's `readSource` tool, cache-aware, reporting
 * REAL post-cache credits. Mirrors firecrawl.ts's scrapeOneCached: a blocklisted domain or a
 * cache hit costs 0; a genuine live Exa fetch (via scrapeUrlContent's URL-as-query approach —
 * see module comment) bills 1. Never throws.
 */
export async function scrapeOneCached(
  url: string,
  client: ExaClient = makeExaClient(),
): Promise<{ url: string; domain: string; content: string; credits: number }> {
  const domain = domainOf(url);
  try {
    const blockset = await loadBlocklist();
    const blocked = blockset.has(blocklistKey(domain));
    const result = await scrapeUrlContent(client, url, blocked);
    return { url, domain, content: result.content, credits: result.live ? 1 : 0 };
  } catch {
    return { url, domain, content: "", credits: 0 };
  }
}
