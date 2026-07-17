/**
 * provider-default-config.test.ts — proves evidence/provider.ts's DEFAULT config (SEARCH_PROVIDER
 * = "exa", SCRAPE_PROVIDER = "firecrawl", evidence/config.ts) actually cross-wires two DIFFERENT
 * providers through the shared search()/explore() pipeline: search goes to Exa, the selected
 * candidate then gets scraped via Firecrawl — the exact default combination
 * docs/search-scrape-provider-split-spec.md §9 asks to verify, not just each primitive in
 * isolation (see provider-credit-split.test.ts for the primitive-level per-provider credit check).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => ({ firecrawlSearchCalls: 0, firecrawlScrapeCalls: 0 }));

vi.mock("@mendable/firecrawl-js", () => ({
  default: class MockFirecrawl {
    async search() {
      h.firecrawlSearchCalls++;
      throw new Error("firecrawl.search() must not be called — SEARCH_PROVIDER is exa by default");
    }
    async scrapeUrl(url: string) {
      h.firecrawlScrapeCalls++;
      return { markdown: `body of ${url}` };
    }
  },
}));
vi.mock("@/lib/search-cache", () => ({ getSearchCache: async () => null, setSearchCache: async () => {} }));
vi.mock("@/lib/scrape-cache", () => ({ getCache: async () => null, setCache: async () => {} }));
vi.mock("@/lib/blocklist", async (orig) => {
  const actual = await orig<typeof import("@/lib/blocklist")>();
  return { ...actual, loadBlocklist: async () => new Set<string>(), recordBlock: async () => {} };
});

import { search } from "@/lib/evidence/provider";

const originalFetch = global.fetch;

beforeEach(() => {
  process.env.FIRECRAWL_API_KEY = "test-key";
  process.env.EXA_API_KEY = "test-exa-key";
  h.firecrawlSearchCalls = 0;
  h.firecrawlScrapeCalls = 0;
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("evidence/provider — default config (search=exa, scrape=firecrawl) wired end to end", () => {
  it("search() finds hits via Exa and scrapes their content via Firecrawl", async () => {
    let exaFetchCalls = 0;
    global.fetch = vi.fn(async () => {
      exaFetchCalls++;
      return {
        ok: true,
        json: async () => ({
          results: [{ url: "https://ex.com/a", title: "Title A", highlights: ["a relevant snippet"] }],
        }),
      };
    }) as unknown as typeof fetch;

    const { evidence, searchCredits, scrapeCredits } = await search(["widgets market"], 3, 0);

    expect(exaFetchCalls).toBeGreaterThan(0); // the search leg went through Exa...
    expect(h.firecrawlSearchCalls).toBe(0); // ...never Firecrawl's search
    expect(h.firecrawlScrapeCalls).toBe(1); // the scrape leg went through Firecrawl
    expect(searchCredits).toBe(1); // Exa's creditsPerSearch rate (pricing.ts)
    expect(scrapeCredits).toBe(1); // Firecrawl's creditsPerScrape rate (pricing.ts)
    expect(evidence).toHaveLength(1);
    expect(evidence[0].url).toBe("https://ex.com/a");
    expect(evidence[0].content).toBe("body of https://ex.com/a");
  });
});
