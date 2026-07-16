/**
 * exa.ts — the Exa implementation of evidence/provider.ts's SearchOps/ScrapeOps: two small,
 * provider-specific primitives (`rawSearch`, `scrapeUrl`) plus `makeExaClient`. ALL pipeline
 * orchestration (intents, dedupe, triage, caching, the scrape worker pool, ScanEvent emission)
 * lives in evidence/provider.ts now, generalized over whichever SearchOps/ScrapeOps
 * evidence/config.ts's SEARCH_PROVIDER/SCRAPE_PROVIDER select. This module owns ONLY the
 * Exa-specific network mechanics.
 *
 * Exa's POST /search can return page content INLINE (`contents: { text: true }`) in the same call
 * that returns hits — but `rawSearch` here deliberately NEVER requests it, even when Exa is also
 * the SCRAPE_PROVIDER: under the search/scrape split, search must stay a pure, swappable operation
 * whose behavior doesn't depend on which provider happens to be doing scrape (see
 * docs/search-scrape-provider-split-spec.md §7). That forgoes a real efficiency optimization in
 * the exa+exa case — an accepted, explicit trade-off for architectural clarity, not an oversight.
 *
 * CREDIT ACCOUNTING: Exa bills in real dollars (`costDollars.total`), not Firecrawl's discrete
 * "N credits per call" convention this codebase's budget tracking assumes. Approximation used
 * throughout this file: charge SEARCH_PROVIDER_PRICING.exa's rate (pricing.ts) per live
 * (cache-miss) /search API call, regardless of `numResults` — this codebase's own accounting
 * convention, not a real Exa-published rate (see pricing.ts's comment).
 */
import { domainOf, truncate } from "../format";
import { MAX_CHARS_PER_PAGE } from "./config";
import { SEARCH_PROVIDER_PRICING } from "../pricing";
import { createLimiter } from "../orchestration/limiter";
import { PROVIDER_CONCURRENCY } from "./config";
import type { SearchHit, ProviderClient } from "./provider";

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
 * (or a function that defaults to calling this) does, so selecting Firecrawl for both
 * operations never requires an EXA_API_KEY to be set. */
export function makeExaClient(): ExaClient {
  const apiKey = process.env.EXA_API_KEY;
  if (!apiKey) throw new Error("EXA_API_KEY is not set. Copy .env.local.example to .env.local.");
  return { apiKey };
}

function asClient(client: ProviderClient | undefined): ExaClient {
  return (client as ExaClient | undefined) ?? makeExaClient();
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
 * an exception.
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

/**
 * One query -> hits. NEVER requests or returns page content (SearchOps contract, and see the
 * module comment on why search never uses Exa's free inline content). Requests `highlights`
 * (short excerpts) for the snippet. A live call bills SEARCH_PROVIDER_PRICING.exa.creditsPerSearch
 * whether it succeeds or fails.
 */
export async function rawSearch(
  query: string,
  numResults: number,
  client?: ProviderClient,
): Promise<{ hits: SearchHit[]; credits: number }> {
  const c = asClient(client);
  const credits = SEARCH_PROVIDER_PRICING.exa.creditsPerSearch;
  const res = await exaFetch(c, {
    query,
    type: "auto",
    numResults,
    contents: { text: false, highlights: true },
  });
  if (res === null) return { hits: [], credits };
  const results = res.results ?? [];
  const hits: SearchHit[] = results
    .filter((r) => r.url)
    .map((r) => ({
      url: r.url,
      title: r.title || domainOf(r.url),
      snippet: (r.highlights ?? []).join(" ").slice(0, 240),
    }));
  return { hits, credits };
}

/**
 * Fetch one URL's page content via Exa's URL-as-query trick (issue a /search call with the URL
 * itself as the query and numResults: 1 — Exa has no dedicated "fetch by URL" endpoint). Never
 * throws (exaFetch never throws). A live call bills SEARCH_PROVIDER_PRICING.exa.creditsPerScrape
 * whether it finds a match or not.
 */
export async function scrapeUrl(
  url: string,
  client?: ProviderClient,
): Promise<{ content: string; credits: number }> {
  const c = asClient(client);
  const credits = SEARCH_PROVIDER_PRICING.exa.creditsPerScrape;
  const res = await exaFetch(c, {
    query: url,
    type: "auto",
    numResults: 1,
    contents: { text: { maxCharacters: MAX_CHARS_PER_PAGE } },
  });
  const results = res?.results ?? [];
  const match = results.find((r) => r.url === url) ?? results[0];
  const text = match?.text ?? "";
  return { content: truncate(text, MAX_CHARS_PER_PAGE), credits };
}
