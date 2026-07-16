# Search/scrape provider split + unified pricing — spec

Status: **not implemented — spec only.** Written for a clean hand-off to another agent. The
prerequisite work this spec builds on (the `SearchProvider` interface, `evidence/config.ts`,
`evidence/exa.ts`, `models/pricing.ts`, `roles.ts`) is implemented and committed as of this spec's
authoring — see git log. This spec describes the NEXT increment, not yet started.

## 1. Goal

Today `SEARCH_PROVIDER` (one config constant, `evidence/config.ts`) selects ONE provider that
handles both search (finding URLs) and scrape (fetching page content) for a run. The target
end-state: **search and scrape are independently configurable operations**, each pluggable to any
provider that implements it, and their credit costs are separately tracked. Default configuration:
**Exa for search, Firecrawl for scrape.**

Concretely: `SEARCH_PROVIDER="exa"`, `SCRAPE_PROVIDER="firecrawl"` — genuinely decoupled config
values (not two names for the same selector). Explore/search pipelines call the SEARCH provider
to discover URLs+snippets, then call the SCRAPE provider to fetch content for the URLs selected
after triage — regardless of whether the search provider could have returned content inline for
free (Exa can; that optimization is intentionally forgone in this design so search and scrape stay
strictly separable operations — see §7 for why).

## 2. Current state (as of this spec)

- `src/lib/evidence/provider.ts` defines one `SearchProvider` interface with 5 methods
  (`createClient`, `explore`, `search`, `webSearchRaw`, `scrapeOneCached`) — each a FULL pipeline
  (search AND scrape) owned entirely by one provider module.
- `src/lib/evidence/firecrawl.ts` and `src/lib/evidence/exa.ts` each implement that full interface
  independently — meaning the triage/dedupe/pipeline-composition logic is **duplicated** between
  them (a real cost of the current design this spec also fixes).
- `evidence/config.ts` has one `SEARCH_PROVIDER: SearchProviderId` selector and a
  `PROVIDER_CONCURRENCY` map.
- Credit rates are hardcoded inline per provider module: Firecrawl charges 2 credits/live-search +
  1/live-scrape (in `firecrawl.ts`'s `search()`/`explore()`/`scrapeOneCached()`); Exa charges 1
  credit per live call (documented approximation in `exa.ts`'s header comment) for both its
  search-with-inline-content call and its URL-as-query content-fetch fallback.
- `src/lib/models/pricing.ts` holds `MODEL_CATALOG` (LLM token pricing) only.

## 3. New interface shape — split `SearchOps` / `ScrapeOps`

Replace the one monolithic `SearchProvider` interface with two small capability interfaces in
`evidence/provider.ts`:

```ts
export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
}

export interface SearchOps {
  createClient(): ProviderClient;
  /** One query -> hits. NEVER returns page content, even if the provider could supply it inline
   * for free (Exa) — content-fetching is always the scrape provider's job, so search stays a pure,
   * swappable operation independent of which provider ends up doing the scrape. */
  rawSearch(
    query: string,
    numResults: number,
    client?: ProviderClient,
  ): Promise<{ hits: SearchHit[]; credits: number }>;
}

export interface ScrapeOps {
  createClient(): ProviderClient;
  scrapeUrl(
    url: string,
    client?: ProviderClient,
  ): Promise<{ content: string; credits: number }>;
}
```

`firecrawl.ts` and `exa.ts` shrink to implementing ONLY these two small interfaces — no more
`explore()`/`search()`/`webSearchRaw()`/`scrapeOneCached()` inside them. Each module keeps its
provider-specific mechanics (Firecrawl: `FirecrawlApp` client, `app.search`/`app.scrapeUrl`; Exa:
`fetch` against `/search`, the URL-as-query fallback for content-by-URL) but exposes only
`createClient`, `rawSearch`, `scrapeUrl`.

**The compound pipelines move into `evidence/provider.ts` itself**, as provider-agnostic
orchestration that composes whichever `SearchOps`/`ScrapeOps` are currently selected:

```ts
function getSearchOps(): SearchOps { return SEARCH_OPS[SEARCH_PROVIDER]; }
function getScrapeOps(): ScrapeOps { return SCRAPE_OPS[SCRAPE_PROVIDER]; }

export async function explore(industry, onEvent, now?, nowIso?): Promise<ExploreResult> {
  // adapt intents (triage.ts, unchanged, provider-agnostic)
  // -> getSearchOps().rawSearch(query, RESULTS_PER_INTENT) per intent
  // -> dedupeCandidates / scoreCandidates / selectSources (triage.ts + the pure helpers
  //    currently exported from firecrawl.ts — MOVE those pure helpers, e.g. dedupeCandidates,
  //    capCandidatesPerQuery, selectCandidatesByScore, into provider.ts or a new
  //    evidence/candidates.ts, since they're provider-agnostic and both explore()/search() need
  //    them from their new home in provider.ts, not from firecrawl.ts)
  // -> getScrapeOps().scrapeUrl(url) per selected source
  // -> assemble ExploreResult
}

export async function search(queries, k, loopIteration, onProgress?, context?): Promise<SearchResult> {
  // same shape, orchestrated-arm version
}

export async function webSearchRaw(query, client?) {
  return getSearchOps().rawSearch(query, SEARCH_CANDIDATES_PER_QUESTION, client);
}

export async function scrapeOneCached(url, client?) {
  // blocklist check, then getScrapeOps().scrapeUrl(url, client)
}
```

This also **removes the duplication** between `firecrawl.ts`'s and `exa.ts`'s current pipeline
implementations — there is exactly one `explore()`/`search()` implementation now, in
`provider.ts`, working against whichever two providers are configured.

**Provider selection tables** (`evidence/provider.ts`):

```ts
const SEARCH_OPS: Record<SearchProviderId, SearchOps> = { firecrawl: firecrawlSearchOps, exa: exaSearchOps };
const SCRAPE_OPS: Record<SearchProviderId, ScrapeOps> = { firecrawl: firecrawlScrapeOps, exa: exaScrapeOps };
```

Both Firecrawl and Exa must implement BOTH `SearchOps` and `ScrapeOps` (even though the default
config only uses Firecrawl for scrape and Exa for search) — so any combination
(`exa`+`exa`, `firecrawl`+`firecrawl`, `exa`+`firecrawl`, `firecrawl`+`exa`) is valid and
swappable purely via config, per the "everything configurable" requirement.

## 4. Config surface (`evidence/config.ts`)

```ts
export const SEARCH_PROVIDER: SearchProviderId = "exa";
export const SCRAPE_PROVIDER: SearchProviderId = "firecrawl";
```

Two independent constants, not one. `PROVIDER_CONCURRENCY` stays as-is (keyed by provider id,
already correct for this — a provider's rate limit doesn't depend on which operation it's doing).

**Unchanged, per explicit instruction — do not touch these values:**
`SEARCH_CANDIDATES_PER_QUESTION = 10` (this is the "search results to return" constant referred
to). `RESULTS_PER_INTENT = 8` (baseline arm's separate per-intent count) is a different constant
and is also unchanged — flagging the distinction since both are plausible readings of "search
results," and neither should move as part of this work.

## 5. Unified pricing file

Move `src/lib/models/pricing.ts` → **`src/lib/pricing.ts`** (top-level, sibling to `params.ts`,
`prompts.ts`, `roles.ts` — the "single file" the instruction asked for). It now holds two catalogs:

```ts
// -- LLM models (unchanged content, moved from models/pricing.ts) --------------
export type ModelProviderT = "anthropic" | "openai" | "google";
export interface ModelCatalogEntry { provider: ModelProviderT; input: number; output: number; ... }
export const MODEL_CATALOG: Record<string, ModelCatalogEntry> = { ... };

// -- Search/scrape providers ----------------------------------------------------
export interface SearchProviderRates {
  /** Credits charged per LIVE (cache-miss) rawSearch call. */
  creditsPerSearch: number;
  /** Credits charged per LIVE (cache-miss) scrapeUrl call. */
  creditsPerScrape: number;
}

export const SEARCH_PROVIDER_PRICING: Record<SearchProviderId, SearchProviderRates> = {
  firecrawl: { creditsPerSearch: 2, creditsPerScrape: 1 },
  exa:       { creditsPerSearch: 1, creditsPerScrape: 1 },
};
```

`exa.creditsPerScrape: 1` is this codebase's own accounting convention (a live Exa content-fetch
call costs the same "1 credit" unit as a live Exa search call — both are one HTTP call to the same
`/search` endpoint) — **not** a real Exa-published rate; Exa bills in actual dollars
(`costDollars.total`), which this codebase does not track for the retrieval budget today (that
budget is a discrete-credit pool, not a `$` cap — see `MAX_RUN_COST_USD`, which is LLM-only and
separate). Flag this clearly in the file's comment so nobody mistakes it for Exa's real pricing.

`firecrawl.ts`/`exa.ts`'s `rawSearch`/`scrapeUrl` implementations must read their own credit cost
from `SEARCH_PROVIDER_PRICING[thisProviderId]` rather than hardcoding a literal `2`/`1` inline, so
the rate is genuinely centralized and editable in one place.

**Update every import** of `MODEL_CATALOG`/`ModelCatalogEntry`/`ModelProviderT` from
`../models/pricing` to `../pricing` (or the correct relative depth): `models/provider.ts`,
`orchestration/eval.ts`, `components/ReportView.tsx`. Delete the now-empty `models/pricing.ts`
(or leave a one-line re-export if a slower migration is preferred — recommend deleting outright,
this codebase does not carry backward-compat shims per its own stated conventions).

## 6. Credit accounting — the worked example

> "suppose we switched the search provider from firecrawl to exa. the accounting should then go
> from 2 firecrawl credits per search to 1 exa credit per search and that should go in the budget."

This must hold **without any code change other than flipping `SEARCH_PROVIDER`**. Concretely:
`firecrawlSearchOps.rawSearch()` returns `credits: SEARCH_PROVIDER_PRICING.firecrawl.creditsPerSearch`
(2) per live call; `exaSearchOps.rawSearch()` returns `credits: SEARCH_PROVIDER_PRICING.exa.creditsPerSearch`
(1) per live call. Whatever budget pool consumes these numbers (`PassPool.charge()` in
`researcher.ts`, and the equivalent accumulation in `provider.ts`'s `explore()`/`search()`) must
already be summing whatever `rawSearch`/`scrapeUrl` report — it must NOT hardcode "2" or "1"
anywhere itself. Grep for literal `2` / `credits: 1` in the retrieval path before considering this
done; any hardcoded literal there is a bug this spec is meant to eliminate.

**Separate search-credit and scrape-credit accounting**, per the instruction. Concretely:

- `ExploreResult` and `SearchResult` (in `evidence/provider.ts`) already have `searchCredits` and
  `scrapeCredits` as distinct fields on `SearchResult` — keep and rely on that split; `ExploreResult`
  currently only exposes a combined `firecrawlCredits` — **add `searchCredits`/`scrapeCredits`
  fields there too**, mirroring `SearchResult`, so both pipelines report the breakdown, not just one.
- `PassPool` (`researcher.ts`) currently tracks one combined `remaining`/`spentCredits` counter —
  **add separate `spentSearchCredits`/`spentScrapeCredits`** (or two sibling counters) so a pass's
  spend is inspectable by kind, not just as one number. `charge()` should take a `kind: "search" |
  "scrape"` parameter (or two separate `chargeSearch()`/`chargeScrape()` methods) so callers are
  explicit about which they're booking.
- `mechanics.ts`'s `RunMechanics.retrieval` section should surface the search/scrape split (it
  already tracks `searchOps`/`scrapeOps` counts from trace entries — extend it to also report
  credits, not just call counts, split the same way).

**Open decision — flag this explicitly to the user/next agent, do not decide silently:**
should the run's overall retrieval budget (`TOTAL_FIRECRAWL_BUDGET` in `params.ts` — rename to
something provider-neutral, e.g. `TOTAL_RETRIEVAL_BUDGET`, while touching this) remain **one
combined cap** that both search-credits and scrape-credits draw down together (closest to today's
behavior, just with correct per-provider rates and better reporting), or become **two independent
caps** (`TOTAL_SEARCH_BUDGET` / `TOTAL_SCRAPE_BUDGET`) so a run can't overspend on search even if
scrape still has headroom, and vice versa? Two independent caps is a bigger change — it means a
retrieval pass can be "search-exhausted but scrape-solvent" (or the reverse), which needs new gate
logic (`gate.ts`, `PassPool.exhausted`) to decide what "exhausted" means when only one side is out.
**Recommendation: start with one combined cap + separated reporting** (smaller, lower-risk change
that satisfies "separate in our budgeting" as separated *accounting*, not separated *caps*) and
treat two independent caps as a follow-up if the combined-cap behavior turns out to hide a real
problem (e.g. cheap Exa search starves an expensive Firecrawl scrape budget within one pass). This
recommendation should be confirmed with the user before implementation, not assumed.

## 7. Why search never uses a provider's free inline content

Exa's `/search` can return page text inline (`contents.text`) in the same call — the current
`exa.ts` (pre-this-spec) exploits that to skip a second network call when Exa is used end-to-end.
Under the new split, `rawSearch` must NOT request or return content, even from Exa, even when
`SCRAPE_PROVIDER` also happens to be `"exa"` — because search and scrape are now independently
selected operations, and conflating them (making search's behavior depend on which scrape provider
happens to be configured) reintroduces the coupling this spec removes. This does forgo a real
efficiency optimization in the `exa`+`exa` case; that's an accepted, explicit trade-off for
architectural clarity, not an oversight. (A future optimization, if ever wanted: special-case
`SEARCH_PROVIDER === SCRAPE_PROVIDER === "exa"` to reuse inline content — call this out as
explicitly out of scope for this spec if raised later.)

## 8. File-by-file task list

1. `src/lib/models/pricing.ts` → move to `src/lib/pricing.ts`; add `SearchProviderRates` +
   `SEARCH_PROVIDER_PRICING`. Update `models/provider.ts`, `orchestration/eval.ts`,
   `components/ReportView.tsx` imports.
2. `src/lib/evidence/config.ts` — split `SEARCH_PROVIDER` into `SEARCH_PROVIDER` +
   `SCRAPE_PROVIDER`, both defaulting per §4.
3. `src/lib/evidence/provider.ts` — replace `SearchProvider` with `SearchOps`/`ScrapeOps`; move
   `explore()`/`search()`/`webSearchRaw()`/`scrapeOneCached()` pipeline logic here (provider-
   agnostic orchestration); add `searchCredits`/`scrapeCredits` to `ExploreResult`.
4. `src/lib/evidence/firecrawl.ts` — shrink to `createClient`, `rawSearch`, `scrapeUrl` only; read
   its credit rate from `SEARCH_PROVIDER_PRICING.firecrawl`; move its pure helpers
   (`dedupeCandidates`, `capCandidatesPerQuery`, `selectCandidatesByScore`) to `provider.ts` (or a
   new `evidence/candidates.ts`) since `provider.ts`'s new pipeline code needs them and they're
   provider-agnostic — don't leave `provider.ts` importing pipeline-support helpers from one
   specific vendor's file.
5. `src/lib/evidence/exa.ts` — same shrink; read its credit rate from
   `SEARCH_PROVIDER_PRICING.exa`; drop its own `explore()`/`search()` (now redundant with
   `provider.ts`'s shared implementation).
6. `src/lib/orchestration/researcher.ts` — `PassPool` gets separated search/scrape counters (§6);
   `runResearcher`'s `webSearch`/`readSource` tools charge via the right one.
7. `src/lib/params.ts` — `TOTAL_FIRECRAWL_BUDGET` → `TOTAL_RETRIEVAL_BUDGET` (or confirm the open
   decision in §6 first — if two independent caps are chosen instead, this becomes two constants).
8. `src/lib/orchestration/mechanics.ts` — extend the retrieval section to report the search/scrape
   credit split, not just call counts.
9. `.env.local.example` / `.env.local` — no new keys needed (`FIRECRAWL_API_KEY` + `EXA_API_KEY`
   are both already documented and now both genuinely required simultaneously in the default
   config, rather than "alternates" — update the comment wording to reflect that).
10. Tests: `test/evidence/*` (firecrawl-concurrency, cap-candidates, firecrawl-cache-roundtrip,
    firecrawl-tools) will need updates wherever they currently assert against the now-removed
    `explore()`/`search()` methods on `firecrawl.ts` directly — repoint to `provider.ts`, or add
    unit coverage for the new `rawSearch`/`scrapeUrl` primitives directly. `test/orchestration/
    researcher.test.ts` needs coverage for `PassPool`'s new separated counters. Add a test
    asserting the §6 worked example literally: construct a run with `SEARCH_PROVIDER="firecrawl"`,
    assert a live search reports `credits: 2`; flip to `"exa"`, assert `credits: 1` — same code
    path, both branches, no hardcoded literal anywhere in between.

## 9. Verification

`npx tsc --noEmit` and `npx vitest run` clean, as always. Additionally: manually trace one
`explore()` call in each of the 4 provider combinations (firecrawl/firecrawl, exa/exa,
exa/firecrawl [default], firecrawl/exa) and confirm `ExploreResult.searchCredits`/`scrapeCredits`
match `SEARCH_PROVIDER_PRICING` for whichever providers were configured — this is the single
behavior this whole spec exists to guarantee.
