# Blindspot

> Scan any industry for structural bottlenecks, solution gaps, and founder-ready opportunities.
> Type an industry, get an evidence-backed report with scores, an actionable thesis, and
> concrete next steps — all grounded in real sources with direct quotes.

Type an industry — `college athletics`, `construction permitting`, `freight brokerage`,
`dental lab coordination` — and watch the scanner fan out across the web, triage the results,
and produce a diagnostic report: pain scores, existing solution maturity, founder accessibility,
AI suitability, budget signal, an opportunity thesis, and clear next steps. **Every claim
cites its sources with direct quotes.** Export the full report as a PDF.

---

## Quick start

```bash
npm install
cp .env.local.example .env.local   # then add your keys
npm run dev                        # http://localhost:3000
```

You need two keys in `.env.local`:

| Var | Where | Used for |
| --- | --- | --- |
| `FIRECRAWL_API_KEY` | https://firecrawl.dev | web `/search` + `/scrape` |
| `OPENAI_API_KEY` | https://platform.openai.com | intent adaptation, triage scoring, analysis |

---

## How it works

One page, one server entry point, no database, no auth — one-shot execution with persistent
caches. Three LLM calls per scan (two cheap gpt-4o-mini calls for adaptation and triage, one
gpt-4o call for analysis), all streamed live.

### Pipeline

```
industry
   │
   ▼  ADAPT — makeIntents()                            src/lib/triage.ts
   │  gpt-4o-mini designs 8 search intents tailored to this industry, told the 7
   │  report sections so the intents aim at evidence the report actually needs.
   │  Includes the current year so queries stay fresh. Fallback: static templates.
   │
   ▼  SEARCH — searchAllIntents()                      src/lib/firecrawl.ts
   │  8 intents × 8 results each, in parallel via Firecrawl /search = up to 64 raw hits.
   │  Each hit tagged with the intent(s) that surfaced it.
   │  Results are cached (data/search-cache.json) — repeated queries skip Firecrawl.
   │
   ▼  DEDUPE + FILTER — dedupeCandidates()             src/lib/firecrawl.ts
   │  Collapse to ~50–60 unique URLs, merging intent tags.
   │  A page found by 3 intents carries all 3 tags — centrality signal for triage.
   │  Domains on the blocklist (data/blocklist.json) and PDF URLs are removed here,
   │  before triage, so they never waste LLM attention or scrape credits.
   │
   ▼  TRIAGE — scoreCandidates()                       src/lib/triage.ts
   │  ONE gpt-4o-mini call sees all candidates (title, domain, snippet, intent tags)
   │  and scores each 0–10 in a compact [id, score] format. Rewards primary sources,
   │  forums, vendor pages, job boards; penalizes SEO spam, listicles, unrelated content.
   │  Fallback: every candidate gets score 5 ("unscored") → selection degrades to
   │  coverage-only.
   │
   ▼  SELECT — selectSources()                         src/lib/triage.ts
   │  PURE, deterministic, unit-tested. No LLM, no I/O.
   │  1. Quota floor: each intent's top-2 by score (guarantees coverage breadth)
   │  2. Merit fill: highest-scored remaining, globally (fills to 22 total)
   │  Each source carries its relevanceScore for the UI.
   │
   ▼  SCRAPE — scrapeSources()                         src/lib/firecrawl.ts
   │  Bounded concurrency (6 at a time) via Firecrawl /scrape.
   │  Scrape results are cached (data/scrape-cache.json) — repeated URLs skip Firecrawl.
   │  PDF URLs are skipped (safety net). PDF parsing is disabled on the API call.
   │  Domains that hard-block (403/etc.) are auto-added to the blocklist for future scans.
   │
   ▼  ANALYZE — callLLM()                              src/lib/analyze.ts
   │  gpt-4o (temperature 0.2) reads the full scraped corpus. Prompt demands direct
   │  quotes, specific operational details, and evidence that couldn't be guessed without
   │  research. JSON output validated by zod; one repair retry on invalid JSON.
   │
   ▼  ASSEMBLE — assembleReport()                      src/lib/analyze.ts + scoring.ts
   │  Server computes the 0–100 Opportunity Score deterministically from sub-scores,
   │  attaches sources + timestamp.
   │
   ▼  STREAM — Server-Sent Events                      src/app/api/scan/route.ts
   Every step streamed live to the browser → the exploration visualization
```

**Labor split:** the LLM owns quality judgment (which intents? which pages are useful?
what does the evidence say?). Code owns coverage, the cut, and the score formula. Selection
is pure and unit-testable; all three LLM steps fall back gracefully so reliability never
regresses.

### Net LLM calls

| Step | Model | Purpose |
| --- | --- | --- |
| Adapt | gpt-4o-mini | Design 8 industry-specific search intents |
| Triage | gpt-4o-mini | Score ~50–60 candidates 0–10 before scraping |
| Analyze | gpt-4o | Read corpus, produce scored report with direct quotes |

Token usage, Firecrawl credits, and estimated cost are tracked per-call and shown in the
report under **Method & assumptions**.

### The live exploration view

The scan runs inside a **streaming route handler** (`src/app/api/scan/route.ts`) that emits an
event for every step — intents adapting, each search firing/returning, triage scoring, each page
being scraped, the analyze phase — as Server-Sent Events. The client (`src/lib/useScanStream.ts`)
folds those into UI state that `ScanProgress` renders: you watch intents fan out, relevance scores
appear, sources stream in, and pages get read, under a sweeping scan-line.

The phase rail shows six stages: **Adapt → Intents → Search → Triage → Scrape → Analyze**.
Each source in the live view shows its triage score (color-coded) and page title.
The intents panel labels whether they were "adapted" (LLM-generated) or "static" (fallback).

### The report

The report has seven sections, each adding distinct information with no redundancy:

1. **Industry Snapshot** — 2–3 sentence lay of the land
2. **Current Software Ecosystem** — summary of tooling status + named vendors
3. **Bottlenecks** — structural root causes with specific workflow breakdowns, not surface complaints
4. **Underserved Niches** — specific populations or workflow gaps with concrete details
5. **Opportunity Thesis** — a dense, evidence-packed paragraph naming specific products, features, and wedge strategies a founder can run with
6. **Adjacent Markets** — neighboring industries with specific crossover mechanisms (shared data formats, regulations, vendor ecosystems)
7. **Next Steps** — execution-ready instructions: specific communities to engage, tools to evaluate, interviews to conduct

Every evidence item uses **direct quotes** pulled from the scraped sources — the reader
encounters real voices, specific numbers, and named systems, not generic paraphrases. A
specificity test ensures every claim contains details that couldn't be written without the
research. Citations link to the source page.

### Scoring

The **five sub-scores** come from the LLM, each calibrated with anchored examples across the
full 0–10 range to prevent clustering:

| Score | What it measures |
| --- | --- |
| **Pain** | Frustration, friction, unmet need (10 = severe) |
| **Existing Solution Maturity** | How modern existing solutions are — software, hardware, or services (10 = mature market) |
| **Founder Accessibility** | How easy it is for an outsider founder to break in (10 = very accessible) |
| **AI Suitability** | How well manual work maps to what AI can automate today (10 = highly automatable) |
| **Budget Signal** | Evidence that buyers have money and will pay (10 = strong budgets) |

The **headline 0–100 Opportunity Score** is computed deterministically in `src/lib/scoring.ts`
from those sub-scores using equal-ish weights (pain 25%, the rest 15–20% each). Solution maturity
is *inverted* (mature solutions → less opportunity). The formula is transparent so scores are
comparable across scans.

**Color coding:** the opportunity score uses red (0–29) / orange (30–49) / yellow (50–69) /
green (70+). Sub-scores use the same bands at 0–2 / 3–4 / 5–6 / 7+ scale, except Existing
Solution Maturity which is inverted (high maturity = red, since it means less opportunity).

### PDF export

The report can be exported as a PDF via a client-side button (no server round-trip). The PDF
includes the headline score, all five sub-scores with color-coded visual bars, every report
section with inline citations, and the full source appendix with clickable URLs. Built with
jsPDF.

### Caching

Two persistent caches eliminate redundant Firecrawl API calls:

- **`data/search-cache.json`** — maps search query → results array. Repeated queries (same
  industry re-scanned, or overlapping intents across industries) skip Firecrawl entirely.
- **`data/scrape-cache.json`** — maps URL → raw page markdown. Pages that appear across
  multiple scans are never re-scraped. Content is stored pre-truncation so changes to
  `MAX_CHARS_PER_PAGE` take effect without re-scraping.

Both are gitignored. No TTL — entries persist until manually deleted. On a full re-run of the
same industry with the same intents, zero Firecrawl credits are consumed.

### Credit tracking

Firecrawl credits are tracked accurately: 1 credit per search call, 2 credits per scrape call.
Cached and skipped calls are excluded from the count. The UI shows both credits consumed and
raw API calls under **Method & assumptions**.

### Credit management

To keep Firecrawl costs predictable:

- **Search and scrape results are cached** — repeated scans consume zero Firecrawl credits.
- **PDF URLs are filtered out before triage** — they burn excess credits for content that
  rarely adds value over the search snippet.
- **PDF URLs are also skipped at scrape time** as a safety net.
- **`parsePDF: false`** is set on every scrape call.
- Each scrape uses `onlyMainContent: true` and content is truncated to 4500 chars.

### Blocklist

`data/blocklist.json` is a persistent list of scrape-hostile domains. When a scrape fails with
a hard anti-scraping block (401/403/429/451), the domain is recorded so future scans skip it
proactively. Blocked domains and PDF URLs are filtered out **before triage** so they don't
waste scrape slots or LLM scoring attention. The UI shows skipped domains with a reason.

---

## Prompt transparency

The entire prompt lives, readable, in [`src/lib/analyze.ts`](src/lib/analyze.ts) —
`SYSTEM_PROMPT`, `buildPrompt()`, and the shared `SCORE_DEFINITIONS`. The triage and adaptation
prompts are in [`src/lib/triage.ts`](src/lib/triage.ts). The same score definitions are
shown to the user under **Method & assumptions** in the report. Nothing is hidden — the exact
prompt sent to the model is viewable in the exploration trace.

---

## Configuration

All tunables live in [`src/lib/params.ts`](src/lib/params.ts) — one file to adjust everything:

| Parameter | Default | What it does |
| --- | --- | --- |
| `ANALYSIS_MODEL` | `gpt-4o` | Analysis model |
| `TRIAGE_MODEL` | `gpt-4o-mini` | Model for intent adaptation + triage scoring |
| `SEARCH_INTENTS` | `8` | Number of search intents to generate |
| `RESULTS_PER_INTENT` | `8` | Search results per intent from Firecrawl |
| `MAX_SCRAPE` | `22` | Max pages to scrape after triage |
| `QUOTA_FLOOR` | `2` | Min sources per intent guaranteed before merit fill |
| `MAX_CHARS_PER_PAGE` | `4500` | Per-page markdown budget (chars) for the LLM corpus |
| `SCRAPE_TIMEOUT_MS` | `20000` | Per-page scrape timeout |
| `SCRAPE_CONCURRENCY` | `6` | Max simultaneous scrape requests |

---

## Project map

```
src/
  app/
    layout.tsx            fonts + metadata
    page.tsx              the single page: idle → scanning → report
    globals.css           theme + terminal chrome
    api/scan/route.ts     streaming orchestrator (SSE)
  lib/
    params.ts             all tunable parameters in one place
    triage.ts             LLM intelligence layer: adapt intents + triage scoring + selection
    intents.ts            static intent templates (fallback for adaptation)
    firecrawl.ts          explore(): search + dedupe + filter + scrape (emits progress events)
    analyze.ts            analysis prompt + LLM call + report assembly
    scoring.ts            deterministic 0–100 score from sub-scores
    exportPdf.ts          client-side PDF export of the full report
    schema.ts             zod schemas / types — the source of truth for report shape
    events.ts             SSE event union + TokenUsage type (server↔client contract)
    useScanStream.ts      client hook: consume SSE, reduce into UI state (incl. usage tracking)
    blocklist.ts          persistent scrape-hostile domain list
    scrape-cache.ts       persistent URL→content cache
    search-cache.ts       persistent query→results cache
    format.ts             small pure helpers
  components/             ScanInput, ScanProgress, ReportView, Gauge, OpportunityMeter, ...
test/                     vitest unit tests (intents, scoring, schema, blocklist, triage selection)
data/
  blocklist.json          running list of domains that block scrapers
  scrape-cache.json       cached scrape results (gitignored)
  search-cache.json       cached search results (gitignored)
```

Every module has a header comment written **for future agents** explaining its role and the
contracts it participates in. Start with `schema.ts` (report shape) and `events.ts` (wire
protocol) — everything else hangs off those two.

---

## Testing

```bash
npm test          # vitest — pure-logic units (intents, scoring, schema, blocklist, triage)
npx tsc --noEmit  # typecheck
npm run build     # production build
```

`selectSources` (the deterministic selection algorithm) is thoroughly unit-tested: quota floor
guarantees, merit fill ordering, centrality tiebreaking, deduplication, edge cases. The
Firecrawl/OpenAI calls are live and one-shot, so they're covered by manual end-to-end runs.

---

## Assumptions & limitations

- Firecrawl `/search` returns usable titles/snippets; scraping adds depth on the best URLs.
- ~22 scraped pages (truncated to 4500 chars each) fit the token budget and the ~30–60s target.
- `gpt-4o` + JSON mode + zod validation is reliable; there's one repair retry then a clear error.
- `gpt-4o-mini` is fast enough for adaptation (~1–2s) and triage (~2–4s on ~50–60 candidates).
- Blocklist + PDF filtering before triage means all scrape slots go to scrapable HTML pages.
- Sub-scores are LLM-assigned heuristics with calibration anchors; the composite score is a
  deterministic, transparent formula on top of them.
- Caches have no TTL — stale content must be cleared manually if freshness matters.
