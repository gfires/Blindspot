/**
 * params.ts — every tunable parameter in one place.
 */

// -- Models ------------------------------------------------------------------

export const ANALYSIS_MODEL        = "gpt-4o";
export const TRIAGE_MODEL          = "gpt-4o-mini";

// -- Search ------------------------------------------------------------------

export const SEARCH_INTENTS        = 8;
export const RESULTS_PER_INTENT    = 8;

// -- Triage / selection ------------------------------------------------------

export const MAX_SCRAPE            = 22;
export const QUOTA_FLOOR           = 2;

// -- Scrape ------------------------------------------------------------------

export const MAX_CHARS_PER_PAGE    = 4500;
export const SCRAPE_TIMEOUT_MS     = 20_000;
export const SCRAPE_CONCURRENCY    = 6;
