/**
 * provider-credit-split.test.ts — the search/scrape provider split spec's §6 worked example,
 * asserted literally: "suppose we switched the search provider from firecrawl to exa. the
 * accounting should then go from 2 firecrawl credits per search to 1 exa credit per search."
 *
 * Both branches run through the SAME evidence/provider.ts code path (webSearchRaw); only
 * evidence/config.ts's SEARCH_PROVIDER flips between them — no hardcoded credit literal lives in
 * provider.ts itself (see pricing.ts's SEARCH_PROVIDER_PRICING, the one place the rate lives).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@mendable/firecrawl-js", () => ({
  default: class MockFirecrawl {
    async search() {
      return { data: [{ url: "https://ex.com/a", title: "Title A", description: "Snippet A" }] };
    }
    async scrapeUrl() {
      return { markdown: "body" };
    }
  },
}));
vi.mock("@/lib/search-cache", () => ({ getSearchCache: async () => null, setSearchCache: async () => {} }));
vi.mock("@/lib/scrape-cache", () => ({ getCache: async () => null, setCache: async () => {} }));
vi.mock("@/lib/blocklist", async (orig) => {
  const actual = await orig<typeof import("@/lib/blocklist")>();
  return { ...actual, loadBlocklist: async () => new Set<string>(), recordBlock: async () => {} };
});

const originalFetch = global.fetch;

beforeEach(() => {
  process.env.FIRECRAWL_API_KEY = "test-key";
  process.env.EXA_API_KEY = "test-exa-key";
  vi.resetModules();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("evidence/provider — search credit accounting (split spec §6 worked example)", () => {
  it("SEARCH_PROVIDER=firecrawl → a live search reports 2 credits", async () => {
    vi.doMock("@/lib/evidence/config", async (orig) => ({
      ...(await orig<typeof import("@/lib/evidence/config")>()),
      SEARCH_PROVIDER: "firecrawl",
    }));
    const { webSearchRaw } = await import("@/lib/evidence/provider");
    const { credits, hits } = await webSearchRaw("freight brokerage");
    expect(credits).toBe(2);
    expect(hits).toHaveLength(1);
  });

  it("SEARCH_PROVIDER=exa → the SAME call reports 1 credit, no code change but the config flip", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ results: [{ url: "https://ex.com/a", title: "Title A", highlights: ["hi"] }] }),
    })) as unknown as typeof fetch;

    vi.doMock("@/lib/evidence/config", async (orig) => ({
      ...(await orig<typeof import("@/lib/evidence/config")>()),
      SEARCH_PROVIDER: "exa",
    }));
    const { webSearchRaw } = await import("@/lib/evidence/provider");
    const { credits, hits } = await webSearchRaw("freight brokerage");
    expect(credits).toBe(1);
    expect(hits).toHaveLength(1);
  });
});
