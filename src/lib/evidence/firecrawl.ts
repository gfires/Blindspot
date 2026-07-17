/**
 * firecrawl.ts — the Firecrawl implementation of evidence/provider.ts's SearchOps/ScrapeOps: two
 * small, provider-specific primitives (`rawSearch`, `scrapeUrl`) plus `makeFirecrawl` (the shared
 * client constructor for both). ALL pipeline orchestration — intents, dedupe, triage, caching,
 * the scrape worker pool, ScanEvent emission — lives in evidence/provider.ts now, generalized over
 * whichever SearchOps/ScrapeOps evidence/config.ts's SEARCH_PROVIDER/SCRAPE_PROVIDER select. This
 * module owns ONLY the Firecrawl-specific network mechanics.
 *
 * CREDIT ACCOUNTING: both functions charge Firecrawl's real per-call rate (SEARCH_PROVIDER_PRICING.
 * firecrawl, pricing.ts) on every LIVE attempt — success or failure alike, since Firecrawl bills the
 * request whether it succeeds or throws. Never throws.
 */
import FirecrawlApp from "@mendable/firecrawl-js";
import { domainOf, truncate } from "../format";
import { isHardBlock, recordBlock } from "../blocklist";
import { MAX_CHARS_PER_PAGE, SCRAPE_TIMEOUT_MS, PROVIDER_CONCURRENCY } from "./config";
import { SEARCH_PROVIDER_PRICING } from "../pricing";
import { createLimiter } from "../orchestration/limiter";
import type { SearchHit, ProviderClient } from "./provider";

/**
 * One shared FIFO queue for EVERY Firecrawl network call — searches and scrapes alike, across all
 * questions and both arms. Firecrawl throttles to ~PROVIDER_CONCURRENCY.firecrawl simultaneous
 * requests per account; funnelling every call through this limiter keeps us under that ceiling so
 * bursts don't turn into 429s / timeouts. Module-level so concurrent runs share the one
 * account-wide budget.
 */
const firecrawlLimiter = createLimiter(PROVIDER_CONCURRENCY.firecrawl);

/** Construct the Firecrawl client. Throws a clear error if the key is missing. */
export function makeFirecrawl(): FirecrawlApp {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not set. Copy .env.local.example to .env.local.");
  return new FirecrawlApp({ apiKey });
}

function asClient(client: ProviderClient | undefined): FirecrawlApp {
  return (client as FirecrawlApp | undefined) ?? makeFirecrawl();
}

/** Wrap a promise with a timeout so a single hung scrape can't stall the pipeline. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("scrape timeout")), ms)),
  ]);
}

/**
 * One query -> hits. Never returns page content (SearchOps contract) — a live call bills
 * SEARCH_PROVIDER_PRICING.firecrawl.creditsPerSearch whether it succeeds or throws.
 */
export async function rawSearch(
  query: string,
  numResults: number,
  client?: ProviderClient,
): Promise<{ hits: SearchHit[]; credits: number }> {
  const app = asClient(client);
  const credits = SEARCH_PROVIDER_PRICING.firecrawl.creditsPerSearch;
  try {
    const res = await firecrawlLimiter(() => app.search(query, { limit: numResults }));
    const hits: SearchHit[] = (res.data ?? [])
      .filter((d) => d.url)
      .map((d) => ({
        url: d.url as string,
        title: d.metadata?.title || d.title || domainOf(d.url as string),
        snippet: d.description || d.metadata?.description || "",
      }));
    return { hits, credits };
  } catch {
    return { hits: [], credits };
  }
}

/**
 * Fetch one URL's page content. Never returns truncated/cached content (that's provider.ts's
 * job) — this is the bare live fetch. On a HARD block (403/etc.) records the domain to the
 * running blocklist (lib/blocklist.ts) so subsequent runs skip it proactively; provider.ts's
 * shared scrape step re-checks the SAME blocklist Set (mutated in place by recordBlock) right
 * after this call to distinguish "just blocked" from "merely empty" for its ScanEvent status,
 * without this interface needing to expose that distinction itself. A live call bills
 * SEARCH_PROVIDER_PRICING.firecrawl.creditsPerScrape whether it succeeds or throws.
 */
export async function scrapeUrl(
  url: string,
  client?: ProviderClient,
): Promise<{ content: string; credits: number }> {
  const app = asClient(client);
  const credits = SEARCH_PROVIDER_PRICING.firecrawl.creditsPerScrape;
  try {
    // onlyMainContent:false + waitFor/timeout (origin/main "wait for js") let JS-rendered pages
    // finish rendering before Firecrawl scrapes them, instead of capturing an empty/incomplete shell.
    const res = await firecrawlLimiter(() =>
      withTimeout(
        app.scrapeUrl(url, {
          formats: ["markdown"],
          onlyMainContent: false,
          parsePDF: false,
          waitFor: 2000,
          timeout: 15000,
        }),
        SCRAPE_TIMEOUT_MS,
      ),
    );
    const md = "markdown" in res ? (res.markdown ?? "") : "";
    return { content: truncate(md, MAX_CHARS_PER_PAGE), credits };
  } catch (err) {
    const e = err as { statusCode?: number; message?: string };
    if (isHardBlock(e.statusCode, e.message)) {
      // Fire-and-forget: recording must not delay or fail the scrape.
      void recordBlock(domainOf(url), `auto: hard-block (${e.statusCode ?? "?"}) scraping ${url}`, new Date().toISOString());
    }
    return { content: "", credits };
  }
}
