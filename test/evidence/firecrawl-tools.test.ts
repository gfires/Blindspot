import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// Mutable per-test hooks the mocked modules read, so individual tests can steer the
// caches/blocklist/SDK behavior without re-mocking. Reset in beforeEach.
const h = vi.hoisted(() => ({
  searchCacheValue: null as { url: string; title: string; snippet: string }[] | null,
  scrapeCacheValue: null as string | null,
  blocklist: new Set<string>(),
  searchCalls: 0,
  scrapeCalls: 0,
  searchThrows: false,
  scrapeThrows: false,
  setSearchCacheCalls: 0,
  setCacheCalls: 0,
}));

vi.mock("@mendable/firecrawl-js", () => ({
  default: class MockFirecrawl {
    async search(query: string) {
      h.searchCalls++;
      if (h.searchThrows) throw new Error("search boom");
      return {
        data: [
          { url: `https://ex.com/${encodeURIComponent(query)}/a`, title: "Title A", description: "Snippet A" },
          { url: `https://ex.com/${encodeURIComponent(query)}/b`, title: "Title B", description: "Snippet B" },
        ],
      };
    }
    async scrapeUrl(url: string) {
      h.scrapeCalls++;
      if (h.scrapeThrows) throw new Error("scrape boom");
      return { markdown: `body of ${url}` };
    }
  },
}));

vi.mock("@/lib/search-cache", () => ({
  getSearchCache: async () => h.searchCacheValue,
  setSearchCache: async () => {
    h.setSearchCacheCalls++;
  },
}));
vi.mock("@/lib/scrape-cache", () => ({
  getCache: async () => h.scrapeCacheValue,
  setCache: async () => {
    h.setCacheCalls++;
  },
}));
vi.mock("@/lib/blocklist", async () => {
  const actual = await vi.importActual<typeof import("@/lib/blocklist")>("@/lib/blocklist");
  return { ...actual, loadBlocklist: async () => h.blocklist, recordBlock: async () => {} };
});

import { webSearchRaw, scrapeOneCached } from "@/lib/evidence/firecrawl";
import { blocklistKey } from "@/lib/blocklist";
import { domainOf } from "@/lib/format";

beforeAll(() => {
  process.env.FIRECRAWL_API_KEY = "test-key";
});

beforeEach(() => {
  h.searchCacheValue = null;
  h.scrapeCacheValue = null;
  h.blocklist = new Set<string>();
  h.searchCalls = 0;
  h.scrapeCalls = 0;
  h.searchThrows = false;
  h.scrapeThrows = false;
  h.setSearchCacheCalls = 0;
  h.setCacheCalls = 0;
});

describe("webSearchRaw", () => {
  it("(a) cache miss → maps hits from SDK data, charges 2 credits, caches", async () => {
    const { hits, credits } = await webSearchRaw("freight brokerage");

    expect(credits).toBe(2);
    expect(h.searchCalls).toBe(1);
    expect(h.setSearchCacheCalls).toBe(1);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      url: "https://ex.com/freight%20brokerage/a",
      title: "Title A",
      snippet: "Snippet A",
    });
  });

  it("(b) cache hit → hits from cache, 0 credits, SDK search NOT called", async () => {
    h.searchCacheValue = [{ url: "https://cached.com/x", title: "Cached", snippet: "from cache" }];

    const { hits, credits } = await webSearchRaw("anything");

    expect(credits).toBe(0);
    expect(h.searchCalls).toBe(0);
    expect(hits).toEqual([{ url: "https://cached.com/x", title: "Cached", snippet: "from cache" }]);
  });

  it("(c) SDK search throws → { hits: [], credits: 2 }, no throw", async () => {
    h.searchThrows = true;

    const { hits, credits } = await webSearchRaw("boom");

    expect(hits).toEqual([]);
    expect(credits).toBe(2);
  });
});

describe("scrapeOneCached", () => {
  const url = "https://ex.com/page";

  it("(a) live scrape → content from SDK markdown, 1 credit, setCache called", async () => {
    const { content, credits, domain } = await scrapeOneCached(url);

    expect(content).toBe(`body of ${url}`);
    expect(credits).toBe(1);
    expect(domain).toBe(domainOf(url));
    expect(h.scrapeCalls).toBe(1);
    expect(h.setCacheCalls).toBe(1);
  });

  it("(b) cache hit → cached content, 0 credits, SDK scrapeUrl NOT called", async () => {
    h.scrapeCacheValue = "cached body";

    const { content, credits } = await scrapeOneCached(url);

    expect(content).toBe("cached body");
    expect(credits).toBe(0);
    expect(h.scrapeCalls).toBe(0);
  });

  it("(c) PDF url → empty content, 0 credits, no scrape", async () => {
    const { content, credits } = await scrapeOneCached("https://ex.com/x.pdf");

    expect(content).toBe("");
    expect(credits).toBe(0);
    expect(h.scrapeCalls).toBe(0);
  });

  it("(d) blocked domain → empty content, 0 credits, no scrape", async () => {
    h.blocklist = new Set<string>([blocklistKey(domainOf(url))]);

    const { content, credits } = await scrapeOneCached(url);

    expect(content).toBe("");
    expect(credits).toBe(0);
    expect(h.scrapeCalls).toBe(0);
  });

  it("(e) SDK scrapeUrl throws → empty content, no throw; credits reflect the live attempt (1)", async () => {
    // A live scrape that throws is still a billed Firecrawl request — scrapeSources() charges it
    // via the pre-scrape `isLive` flag (apiCalls++ ignores scrapeOne's caught error), and
    // webSearchRaw charges the same way on search errors. We replicate that rule exactly, so a
    // caught scrape error over-reports (safe) rather than under-reporting. content is empty.
    h.scrapeThrows = true;

    const { content, credits } = await scrapeOneCached(url);

    expect(content).toBe("");
    expect(credits).toBe(1);
  });
});
