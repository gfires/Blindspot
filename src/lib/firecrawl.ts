/**
 * firecrawl.ts — the exploration layer: search across intents, then scrape the best pages.
 *
 * FOR FUTURE AGENTS: This module talks to Firecrawl and is the source of the live-progress
 * events. It does NOT know about SSE — instead it takes an `onEvent(ScanEvent)` callback, so
 * the transport (app/api/scan/route.ts) owns streaming while this module owns exploration.
 * That separation keeps this unit-testable and lets you reuse it from a script or a test.
 *
 * Pipeline:
 *   1. searchAllIntents() — fire all intent queries in parallel, tagging each result with the
 *      intent that surfaced it, emitting search:begin/done (with per-intent latency) as they resolve.
 *   2. rankSources()     — dedupe by URL, prefer diversity across intents, cap the count, and
 *      flag any source whose domain is on the known-blocker list (lib/blocklist.ts).
 *   3. scrapeSources()   — scrape via a BOUNDED worker pool (see SCRAPE_CONCURRENCY). Blocklisted
 *      domains are skipped without a request; hard-block failures (403/etc.) are recorded back to
 *      the blocklist so we never repeat them. Timing is emitted for every page.
 *
 * Timing: latency is measured with an injected `now()` clock (defaults to Date.now) so the
 * module stays deterministic under test.
 */
import FirecrawlApp from "@mendable/firecrawl-js";
import type { ScanEvent } from "./events";
import type { Source } from "./schema";
import type { Intent } from "./intents";
import { domainOf, truncate } from "./format";
import { loadBlocklist, blocklistKey, isHardBlock, recordBlock } from "./blocklist";

/** Per-page markdown budget (chars). Keeps the LLM prompt within token limits. */
const MAX_CHARS_PER_PAGE = 3500;

/**
 * Per-page scrape timeout (ms). This is per REQUEST, not the whole phase.
 *
 * WHY 20s: pages that take 1–5s to scrape in isolation balloon to 8–15s when many scrape
 * requests contend for Firecrawl bandwidth at once. Measured directly (see git history / the
 * investigation): firing all sources simultaneously pushed healthy pages past a 15s timeout,
 * causing false failures. We solve the ROOT cause with bounded concurrency (SCRAPE_CONCURRENCY
 * below) and keep this timeout as a safety net for genuinely hung pages.
 */
const SCRAPE_TIMEOUT_MS = 20_000;

/**
 * Max simultaneous scrape requests. Bounded so each request gets enough Firecrawl bandwidth to
 * finish in its natural 2–5s instead of collapsing under congestion. 6 keeps the scrape phase
 * fast (~5 batches of 28 sources) while avoiding the timeout-inducing pile-up. Sites that
 * hard-block scrapers (Reddit/LinkedIn/Indeed → 403) still fail; that's correct and expected.
 */
const SCRAPE_CONCURRENCY = 6;

/** A search hit before it's promoted to a citable Source. */
interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  intent: string; // the intent label that surfaced this hit
}

/** A scraped source: a Source plus the page text we'll feed the model. */
export interface ScrapedSource extends Source {
  content: string;
}

/** Read tuning knobs from env with sensible defaults. */
function config() {
  return {
    resultsPerIntent: Number(process.env.SCAN_RESULTS_PER_INTENT ?? 5),
    maxScrape: Number(process.env.SCAN_MAX_SCRAPE ?? 28),
  };
}

/** Construct the Firecrawl client. Throws a clear error if the key is missing. */
export function makeFirecrawl(): FirecrawlApp {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not set. Copy .env.local.example to .env.local.");
  return new FirecrawlApp({ apiKey });
}

/** Monotonic clock injected for testability. Defaults to Date.now in production. */
type Clock = () => number;

/**
 * Run every intent's search query in parallel. Emits search:begin/done per intent, each
 * carrying that intent's latency (ms). Failures on individual intents are swallowed (that
 * intent contributes no hits) so one flaky query can't fail the whole scan.
 */
async function searchAllIntents(
  app: FirecrawlApp,
  intents: Intent[],
  onEvent: (e: ScanEvent) => void,
  now: Clock,
): Promise<SearchHit[]> {
  const { resultsPerIntent } = config();

  const perIntent = await Promise.all(
    intents.map(async (intent) => {
      onEvent({ type: "search:begin", intent: intent.label });
      const t0 = now();
      try {
        const res = await app.search(intent.query, { limit: resultsPerIntent });
        const hits: SearchHit[] = (res.data ?? [])
          .filter((d) => d.url)
          .map((d) => ({
            url: d.url as string,
            title: d.metadata?.title || d.title || domainOf(d.url as string),
            snippet: d.description || d.metadata?.description || "",
            intent: intent.label,
          }));
        onEvent({ type: "search:done", intent: intent.label, count: hits.length, ms: now() - t0 });
        return hits;
      } catch {
        onEvent({ type: "search:done", intent: intent.label, count: 0, ms: now() - t0 });
        return [];
      }
    }),
  );

  return perIntent.flat();
}

/**
 * Dedupe and rank search hits into the final citable Source list.
 *
 * Ranking goal: DIVERSITY across intents. We interleave hits round-robin by intent so the
 * scraped set represents software, jobs, complaints, forums, etc. rather than 28 pages that
 * all came from one dominant query. Sources are assigned stable [N] ids in final order.
 */
export function rankSources(hits: SearchHit[], maxScrape: number): Source[] {
  // Dedupe by normalized URL, keeping the first (highest-ranked) occurrence.
  const seen = new Set<string>();
  const byIntent = new Map<string, SearchHit[]>();
  for (const h of hits) {
    const key = h.url.replace(/[#?].*$/, "").replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    if (!byIntent.has(h.intent)) byIntent.set(h.intent, []);
    byIntent.get(h.intent)!.push(h);
  }

  // Round-robin interleave across intents for diversity.
  const buckets = [...byIntent.values()];
  const ordered: SearchHit[] = [];
  for (let i = 0; ordered.length < maxScrape; i++) {
    let advanced = false;
    for (const bucket of buckets) {
      if (bucket[i]) {
        ordered.push(bucket[i]);
        advanced = true;
        if (ordered.length >= maxScrape) break;
      }
    }
    if (!advanced) break; // all buckets exhausted
  }

  return ordered.map((h, idx) => ({
    id: idx + 1, // 1-based [N] citation ids
    url: h.url,
    domain: domainOf(h.url),
    title: h.title,
    intent: h.intent,
  }));
}

/** Wrap a promise with a timeout so a single hung scrape can't stall the pipeline. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("scrape timeout")), ms)),
  ]);
}

/**
 * Scrape one source. Never throws — always resolves to a ScrapedSource (empty content on
 * failure, since the source is still citable from its search snippet). Emits scrape:begin and a
 * scrape:done whose `status` distinguishes the four outcomes (ok/blocked/skipped/empty) and
 * carries latency. On a HARD block (403/etc.) it records the domain to the running blocklist via
 * `recordBlock`, so subsequent scans skip it — this is the "learn from failures" loop.
 *
 * @param blocked  Whether this domain was already on the blocklist at rank time (→ skip, no request).
 * @param now      Monotonic clock for latency.
 * @param nowIso   ISO timestamp used when recording a newly-discovered blocker.
 */
async function scrapeOne(
  app: FirecrawlApp,
  src: Source,
  blocked: boolean,
  onEvent: (e: ScanEvent) => void,
  now: Clock,
  nowIso: string,
): Promise<ScrapedSource> {
  // Proactive skip: don't spend a request on a domain we already know blocks scrapers.
  if (blocked) {
    onEvent({ type: "scrape:done", id: src.id, domain: src.domain, status: "skipped", chars: 0, ms: 0 });
    return { ...src, content: "" };
  }

  onEvent({ type: "scrape:begin", id: src.id, domain: src.domain });
  const t0 = now();
  try {
    const res = await withTimeout(
      app.scrapeUrl(src.url, { formats: ["markdown"], onlyMainContent: true }),
      SCRAPE_TIMEOUT_MS,
    );
    const md = "markdown" in res ? (res.markdown ?? "") : "";
    const content = truncate(md, MAX_CHARS_PER_PAGE);
    onEvent({
      type: "scrape:done",
      id: src.id,
      domain: src.domain,
      status: content.length > 0 ? "ok" : "empty",
      chars: content.length,
      ms: now() - t0,
    });
    return { ...src, content };
  } catch (err) {
    // Distinguish a hard anti-scraping block (→ remember it) from a transient failure (→ don't).
    const e = err as { statusCode?: number; message?: string };
    const hardBlock = isHardBlock(e.statusCode, e.message);
    if (hardBlock) {
      // Fire-and-forget: recording must not delay or fail the scan.
      void recordBlock(src.domain, `auto: hard-block (${e.statusCode ?? "?"}) scraping ${src.url}`, nowIso);
    }
    onEvent({
      type: "scrape:done",
      id: src.id,
      domain: src.domain,
      status: hardBlock ? "blocked" : "empty",
      chars: 0,
      ms: now() - t0,
    });
    return { ...src, content: "" };
  }
}

/** A ranked source paired with whether its domain is currently blocklisted. */
interface RankedSource {
  source: Source;
  blocked: boolean;
}

/**
 * Scrape the ranked sources with BOUNDED concurrency.
 *
 * WHY A WORKER POOL (not Promise.all over everything): Firecrawl throttles concurrent requests,
 * so firing all ~28 scrapes at once makes each one contend for bandwidth — pages that scrape in
 * 2–5s alone balloon to 10–15s and cross the timeout, producing FALSE failures (measured; see
 * SCRAPE_TIMEOUT_MS). Instead, exactly SCRAPE_CONCURRENCY workers pull from a shared cursor
 * (`next`) into the `ranked` array; each worker grabs the next index, scrapes it to completion,
 * then grabs another, until the queue drains. That caps in-flight requests at SCRAPE_CONCURRENCY
 * so each gets enough bandwidth to finish in its natural time, while still overlapping work.
 * Total scrape wall-clock ≈ ceil(N / SCRAPE_CONCURRENCY) × typical-page-latency.
 *
 * Never throws; results preserve input order (worker writes to results[i]).
 */
async function scrapeSources(
  app: FirecrawlApp,
  ranked: RankedSource[],
  onEvent: (e: ScanEvent) => void,
  now: Clock,
  nowIso: string,
): Promise<ScrapedSource[]> {
  const results: ScrapedSource[] = new Array(ranked.length);
  let next = 0; // shared cursor: the next index no worker has claimed yet

  // Each worker loops: claim an index, scrape it fully, repeat until the queue is drained.
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= ranked.length) return;
      results[i] = await scrapeOne(app, ranked[i].source, ranked[i].blocked, onEvent, now, nowIso);
    }
  };

  const workerCount = Math.min(SCRAPE_CONCURRENCY, ranked.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

/**
 * The full exploration step. Given intents, returns the scraped corpus + the Source list
 * (emitted mid-way via the `sources` event so the UI can render it before scraping starts).
 *
 * Also cross-references each ranked source against the running blocklist (lib/blocklist.ts):
 * blocklisted domains are flagged `blocked: true` in the `sources` event (shown in the UI as
 * "skipped — known blocker") and are not scraped. Emits phase timings (searchMs) for the UI.
 *
 * @param now     Monotonic clock (defaults to Date.now); injected for deterministic tests.
 * @param nowIso  ISO time used when a newly-discovered blocker is recorded.
 */
export async function explore(
  intents: Intent[],
  onEvent: (e: ScanEvent) => void,
  now: Clock = () => Date.now(),
  nowIso: string = new Date().toISOString(),
): Promise<{ sources: Source[]; scraped: ScrapedSource[]; searchMs: number; scrapeMs: number }> {
  const app = makeFirecrawl();
  const { maxScrape } = config();

  // --- Search phase ---
  const searchStart = now();
  const hits = await searchAllIntents(app, intents, onEvent, now);
  const sources = rankSources(hits, maxScrape);
  const searchMs = now() - searchStart;

  // Flag blocklisted domains so the UI can show them as intentionally skipped.
  const blockset = await loadBlocklist();
  const ranked: RankedSource[] = sources.map((source) => ({
    source,
    blocked: blockset.has(blocklistKey(source.domain)),
  }));

  onEvent({
    type: "sources",
    searchMs,
    sources: ranked.map((r) => ({ ...r.source, blocked: r.blocked })),
  });

  // --- Scrape phase (bounded concurrency; skips blocked domains) ---
  const scrapeStart = now();
  const scraped = await scrapeSources(app, ranked, onEvent, now, nowIso);
  const scrapeMs = now() - scrapeStart;

  return { sources, scraped, searchMs, scrapeMs };
}
