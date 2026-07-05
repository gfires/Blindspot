# Opportunity MRI

> Scan any industry for structural inefficiencies, labor shortages, software gaps, and AI-native
> business opportunities. A playful exploration engine that makes you feel like you're seeing the
> hidden shape of a market.

Type an industry — `college athletics`, `construction permitting`, `insurance claims`,
`industrial ergonomics` — and watch Opportunity MRI fan out across the web, read the results live,
and render a Bloomberg-terminal-style diagnostic: pain scores, software maturity, labor scarcity,
AI opportunities, underserved niches, and a set of tongue-in-cheek stats. **Every score and claim
cites its sources with direct quotes.**

This is a **fun exploration tool**, not lead-gen and not a research assistant. **All scores are
heuristic.**

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

One page, one server entry point, no database, no auth, no persistence — one-shot execution.
Three LLM calls per scan (two cheap gpt-4o-mini calls for adaptation and triage, one gpt-4o call
for analysis), all streamed live.

### Pipeline

```
industry
   │
   ▼  ADAPT — makeIntents()                            src/lib/triage.ts
   │  gpt-4o-mini designs 10 search intents tailored to this industry, told the 8
   │  report sections so the intents aim at evidence the report actually needs.
   │  Fallback: static templates from intents.ts (if the LLM call fails).
   │
   ▼  SEARCH — searchAllIntents()                      src/lib/firecrawl.ts
   │  10 intents × 8 results each, in parallel via Firecrawl /search = up to 80 raw hits.
   │  Each hit tagged with the intent(s) that surfaced it.
   │
   ▼  DEDUPE — dedupeCandidates()                      src/lib/firecrawl.ts
   │  Collapse to ~50–70 unique URLs, merging intent tags.
   │  A page found by 3 intents carries all 3 tags — centrality signal for triage.
   │  Domains on the blocklist (data/blocklist.json) are removed here, before triage,
   │  so they never waste LLM attention or scrape slots.
   │
   ▼  TRIAGE — scoreCandidates()                       src/lib/triage.ts
   │  ONE gpt-4o-mini call sees all candidates (title, domain, snippet, intent tags)
   │  and scores each 0–10 with a one-line reason. Rewards primary sources, forums,
   │  vendor pages, job boards; penalizes SEO spam, listicles, unrelated content.
   │  Fallback: every candidate gets score 5 ("unscored") → selection degrades to
   │  coverage-only, matching pre-triage behavior.
   │
   ▼  SELECT — selectSources()                         src/lib/triage.ts
   │  PURE, deterministic, unit-tested. No LLM, no I/O.
   │  1. Quota floor: each intent's top-2 by score (guarantees coverage breadth)
   │  2. Merit fill: highest-scored remaining, globally (fills to 28 total)
   │  Each source carries its relevanceScore + reason for the UI.
   │
   ▼  SCRAPE — scrapeSources()                         src/lib/firecrawl.ts
   │  Bounded concurrency (6 at a time) via Firecrawl /scrape.
   │  Domains that hard-block (403/etc.) are auto-added to the blocklist for future scans.
   │
   ▼  ANALYZE — callLLM()                              src/lib/analyze.ts
   │  gpt-4o reads the full scraped corpus. Prompt demands direct quotes and specific
   │  evidence — the report should read like a briefing with real voices, not a summary.
   │  JSON output validated by zod; one repair retry on invalid JSON, then a clear error.
   │
   ▼  ASSEMBLE — assembleReport()                      src/lib/analyze.ts + scoring.ts
   │  Server computes the 0–100 Opportunity Score deterministically from sub-scores,
   │  guarantees baseline playful stats, attaches sources + timestamp.
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
| Adapt | gpt-4o-mini | Design 10 industry-specific search intents |
| Triage | gpt-4o-mini | Score ~60 candidates 0–10 before scraping |
| Analyze | gpt-4o | Read corpus, produce scored report with direct quotes |

Token usage and estimated cost are tracked per-call and shown in the report under
**Method & assumptions**.

### The live exploration view

The scan runs inside a **streaming route handler** (`src/app/api/scan/route.ts`) that emits an
event for every step — intents adapting, each search firing/returning, triage scoring, each page
being scraped, the analyze phase — as Server-Sent Events. The client (`src/lib/useScanStream.ts`)
folds those into UI state that `ScanProgress` renders: you watch intents fan out, relevance scores
appear, sources stream in, and pages get read, under a sweeping "MRI" scan-line.

The phase rail shows six stages: **Adapt → Intents → Search → Triage → Scrape → Analyze**.
Each source in the live view shows its triage score (color-coded) with the reason on hover.
The intents panel labels whether they were "adapted" (LLM-generated) or "static" (fallback).

### The report

Every evidence item uses **direct quotes** pulled from the scraped sources — the reader
encounters real voices, specific numbers, and named systems, not generic paraphrases. Citations
link to the source page.

The source appendix shows each source's triage relevance score and the one-line reason it was
selected, so you can see exactly why each page was included.

### Scoring

The **five sub-scores** (Pain, Software Maturity, Labor Scarcity, AI Suitability, Budget Signal)
come from the LLM, each grounded in cited sources. The **headline 0–100 Opportunity Score** is
computed deterministically in `src/lib/scoring.ts` from those sub-scores — so the big number is
explainable, not a black box. Software maturity is *inverted* (mature software → less opportunity).

### Blocklist

`data/blocklist.json` is the app's only persistent state. When a scrape fails with a hard
anti-scraping block (401/403/429/451), the domain is recorded so future scans skip it
proactively. Blocked domains are filtered out **before triage** so they don't waste scrape slots
or LLM scoring attention. The UI shows skipped domains with a reason.

---

## Prompt transparency

The entire prompt lives, readable, in [`src/lib/analyze.ts`](src/lib/analyze.ts) —
`SYSTEM_PROMPT`, `buildPrompt()`, and the shared `SCORE_DEFINITIONS`. The triage and adaptation
prompts are in [`src/lib/triage.ts`](src/lib/triage.ts). The same score definitions are
shown to the user under **Method & assumptions** in the report. Nothing is hidden — the exact
prompt sent to the model is viewable in the exploration trace.

---

## Configuration

All tunables have sensible defaults. Set in `.env.local` to override:

| Var | Default | What it does |
| --- | --- | --- |
| `OPENAI_MODEL` | `gpt-4o` | Analysis model |
| `SCAN_TRIAGE_MODEL` | `gpt-4o-mini` | Model for intent adaptation + triage scoring |
| `SCAN_INTENTS` | `10` | Number of search intents to generate |
| `SCAN_RESULTS_PER_INTENT` | `8` | Search results per intent from Firecrawl |
| `SCAN_MAX_SCRAPE` | `28` | Max pages to scrape after triage |
| `SCAN_QUOTA_FLOOR` | `2` | Min sources per intent guaranteed before merit fill |

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
    triage.ts             LLM intelligence layer: adapt intents + triage scoring + selection
    intents.ts            static intent templates (fallback for adaptation)
    firecrawl.ts          explore(): search + dedupe + scrape (emits progress events)
    analyze.ts            analysis prompt + LLM call + report assembly
    scoring.ts            deterministic 0–100 score + playful stats
    schema.ts             zod schemas / types — the source of truth for report shape
    events.ts             SSE event union + TokenUsage type (server↔client contract)
    useScanStream.ts      client hook: consume SSE, reduce into UI state (incl. usage tracking)
    blocklist.ts          persistent scrape-hostile domain list
    format.ts             small pure helpers
  components/             ScanInput, ScanProgress, ReportView, Gauge, OpportunityMeter, …
test/                     vitest unit tests (intents, scoring, schema, blocklist, triage selection)
data/
  blocklist.json          running list of domains that block scrapers
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
- ~28 scraped pages (truncated per page) fit the token budget and the ~30–60s target.
- `gpt-4o` + JSON mode + zod validation is reliable; there's one repair retry then a clear error.
- `gpt-4o-mini` is fast enough for adaptation (~1–2s) and triage (~2–4s on ~60 candidates).
- Blocklist filtering before triage means all 28 scrape slots go to actually-scrapable pages.
- **Scores are heuristic and playful.** This is a provocation to explore an industry, not a
  verdict on it.
