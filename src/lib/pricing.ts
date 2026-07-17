/**
 * pricing.ts — THE pricing catalog: single source of truth for every model id AND every
 * search/scrape provider's credit rate any call site may reference.
 *
 * LLM models: To add or swap a model, add/edit its entry here, then point a role (roles.ts) or a
 * direct model constant (models/provider.ts) at its id — no other file needs a code change.
 * eval.ts's estimateCostUsd() and models/provider.ts's modelFromId() both read this catalog
 * exclusively; an id absent here prices at $0 (with a console warning) and throws on model
 * resolution, so a typo fails loud, not silently. The frontend cost display
 * (components/ReportView.tsx) also reads straight from this table — no separate, driftable copy.
 *
 * Search/scrape providers: SEARCH_PROVIDER_PRICING holds each provider's credit rate for a live
 * rawSearch/scrapeUrl call (evidence/provider.ts, evidence/firecrawl.ts, evidence/exa.ts) — see
 * its own comment below for what "credit" means per provider.
 */
import type { SearchProviderId } from "./evidence/config";

/** SDK provider client a model id resolves through (models/provider.ts routes purely off this
 * field — no per-provider `if` branches need touching when a model is added, removed, or swapped). */
export type ModelProviderT = "anthropic" | "openai" | "google";

export interface ModelCatalogEntry {
  provider: ModelProviderT;
  /** USD per 1,000,000 tokens. */
  input: number;
  output: number;
  /** Prompt-cache multipliers (fraction of `input`); eval.ts applies its defaults when absent. */
  cacheReadMult?: number;
  cacheWriteMult?: number;
}

/**
 * "gpt-4o" / "gpt-4o-mini" are kept for cost-model test fixtures and historical trace replay
 * (test/fixtures/replay-events.json records real spend against them) even though no committee
 * role points at them anymore — gpt-4o is retired from the mix entirely (2026-07).
 *
 * Every published Anthropic/OpenAI rate below (2026-07 pricing pages) lands EXACTLY on this
 * codebase's DEFAULT_CACHE_READ_MULT (0.1×) / DEFAULT_CACHE_WRITE_MULT (1.25×, the 5-minute cache
 * tier — this codebase's `cacheControl: { type: "ephemeral" }` never sets a 1h ttl, see
 * committee.ts) — so none of these entries need a per-model cacheReadMult/cacheWriteMult
 * override; the file-level defaults in eval.ts already match every provider's real ratio.
 * Only claude-sonnet-5 and claude-haiku-4-5-20251001 (roles.ts's investor) and gpt-5.4-mini
 * (historian/operator) are wired to a committee role today — everything else here is reference
 * pricing for a future model swap, not currently on any call path.
 */
export const MODEL_CATALOG: Record<string, ModelCatalogEntry> = {
  // --- Anthropic — active tier ---
  "claude-fable-5":               { provider: "anthropic", input: 10.00, output: 50.00 },
  "claude-mythos-5":              { provider: "anthropic", input: 10.00, output: 50.00 }, // limited availability
  "claude-opus-4-8":              { provider: "anthropic", input:  5.00, output: 25.00 },
  "claude-opus-4-7":              { provider: "anthropic", input:  5.00, output: 25.00 },
  "claude-opus-4-6":              { provider: "anthropic", input:  5.00, output: 25.00 },
  "claude-opus-4-5":              { provider: "anthropic", input:  5.00, output: 25.00 },
  // Committee role (investor, roles.ts). Rate holds THROUGH 2026-08-31; bumps to
  // input $3.00/output $15.00 (still 0.1x/1.25x cache ratios) starting 2026-09-01 — update then.
  "claude-sonnet-5":              { provider: "anthropic", input:  2.00, output: 10.00 },
  "claude-sonnet-4-6":            { provider: "anthropic", input:  3.00, output: 15.00 },
  "claude-sonnet-4-5":            { provider: "anthropic", input:  3.00, output: 15.00 },
  // Committee role (investor's redebate/digest tier, roles.ts).
  "claude-haiku-4-5-20251001":    { provider: "anthropic", input:  1.00, output:  5.00 },
  // --- Anthropic — deprecated/retired (reference pricing only; still billable where available) ---
  "claude-opus-4-1":              { provider: "anthropic", input: 15.00, output: 75.00 }, // deprecated
  "claude-opus-4":                { provider: "anthropic", input: 15.00, output: 75.00 }, // retired except Bedrock/Google Cloud
  "claude-sonnet-4":              { provider: "anthropic", input:  3.00, output: 15.00 }, // retired except Bedrock/Google Cloud
  "claude-haiku-3-5":             { provider: "anthropic", input:  0.80, output:  4.00 }, // retired except Bedrock/Google Cloud

  // --- OpenAI ---
  "gpt-5.6-sol":                  { provider: "openai",    input:  5.00, output: 30.00 },
  "gpt-5.6-terra":                { provider: "openai",    input:  2.50, output: 15.00 },
  "gpt-5.6-luna":                 { provider: "openai",    input:  1.00, output:  6.00 },
  "gpt-5.5":                      { provider: "openai",    input:  5.00, output: 30.00 },
  "gpt-5.5-pro":                  { provider: "openai",    input: 30.00, output: 180.00 },
  "gpt-5.4":                      { provider: "openai",    input:  2.50, output: 15.00 },
  // Committee role (historian + operator, roles.ts).
  "gpt-5.4-mini":                 { provider: "openai",    input:  0.75, output:  4.50 },
  "gpt-5.4-nano":                 { provider: "openai",    input:  0.20, output:  1.25 },
  "gpt-5.4-pro":                  { provider: "openai",    input: 30.00, output: 180.00 },

  // --- Google ---
  // Committee role (skeptic, roles.ts). Free tier (AI Studio, no billing account linked) —
  // rate-limited (~1,500 req/day on the Flash-Lite family) but genuinely $0, not a promotional
  // credit. Re-price this the moment the project moves to a billed/paid-tier key.
  "gemini-3.1-flash-lite":        { provider: "google",    input:  0,    output:  0 },

  // Legacy / test-fixture only — see comment above.
  "gpt-4o":                       { provider: "openai",    input: 2.50, output: 10.00 },
  "gpt-4o-mini":                  { provider: "openai",    input: 0.15, output:  0.60 },
};

// -- Search/scrape providers -----------------------------------------------------

export interface SearchProviderRates {
  /** Credits charged per LIVE (cache-miss) rawSearch call. */
  creditsPerSearch: number;
  /** Credits charged per LIVE (cache-miss) scrapeUrl call. */
  creditsPerScrape: number;
}

/**
 * Firecrawl charges these as real, documented per-call credits. Exa bills in actual dollars
 * (`costDollars.total`), not a discrete-credit model — `exa: { creditsPerSearch: 1,
 * creditsPerScrape: 1 }` is THIS CODEBASE'S OWN ACCOUNTING CONVENTION (both a live Exa search
 * call and a live Exa content-fetch call cost "1 credit" here, both being one HTTP call to the
 * same /search endpoint), not a real Exa-published rate. The retrieval budget (params.ts's
 * TOTAL_RETRIEVAL_BUDGET) is a discrete-credit pool, not a $ cap — Exa's real dollar cost isn't
 * tracked against it today (MAX_RUN_COST_USD is LLM-only and separate).
 */
export const SEARCH_PROVIDER_PRICING: Record<SearchProviderId, SearchProviderRates> = {
  firecrawl: { creditsPerSearch: 2, creditsPerScrape: 1 },
  exa:       { creditsPerSearch: 1, creditsPerScrape: 1 },
};
