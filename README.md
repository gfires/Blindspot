# Blindspot

Ask an LLM "is there a business here?" and you get a fluent, generic, unfalsifiable answer —
no sourcing, no acknowledgment of what it doesn't know, and no visible reasoning to check.
Blindspot is a research system that answers the same question with **empirical, cited, and
adversarially-tested** evidence instead: it goes and reads real sources, runs a committee that
actually argues about what they mean, and hands back a verdict you can trace claim-by-claim
back to a URL — including an honest account of what the evidence couldn't settle.

Type an industry or topic, get a report with a scored thesis, cited claims, and a named list of
what's still unknown.

## The idea

A single LLM call optimizes for a plausible-sounding answer, not a correct one — it can't
cite anything it didn't actually retrieve, and it has no mechanism to disagree with itself.
Blindspot fixes both:

1. **Go get real evidence.** A manager agent decomposes the topic into a handful of concrete
   research questions, then searches (Exa) and scrapes (Firecrawl) the web for each one —
   cached in Supabase so repeat runs are free.
2. **Argue about it, don't just answer it.** For each question, a four-role committee reads the
   *same* evidence and independently forms a claim — no LLM sees the others' opinions yet, so
   agreement is real signal, not herding. If they disagree, they debate: read each other's
   points, rebut or concede *only when a source forces it*, across a few rounds until positions
   stop moving.
3. **Only retrieve when it would change the answer.** A gate reads the committee's verdict and
   decides: unanimous agreement is a settled answer (stop). A genuine, evidence-shaped
   disagreement sends the system back to fetch exactly the evidence that could resolve it. A
   disagreement that's just a difference of *interpretation* is reported as a fault line — more
   searching can't fix that, so the system doesn't waste budget pretending it can.
4. **Show your work.** Every claim in the final answer is cited back to a source id. Every run
   writes a full trace — every prompt, every response, every dollar spent, every retrieval —
   so the reasoning is auditable, not a black box.

The result: instead of "this seems like a good market," you get "the historian found two prior
attempts that died on distribution [S3, S7]; the investor and operator agree there's a fundable
wedge; the skeptic couldn't be talked out of the regulatory risk — here's the fault line,
unresolved, because no public source settles it."

## The committee

Four role-agents, deliberately built to disagree rather than converge to a bland consensus.
Each has its own incentive and its own model — including one model family (Gemini) that's
never talked to the others, so its skepticism isn't contaminated by peer pressure:

| Role | Incentive | Model (opening → re-debate) |
| --- | --- | --- |
| **Historian** | Precedent — has this been tried, and how did it die? | gpt-5.4-mini |
| **Operator** | Reality on the ground — what actually breaks day to day? | gpt-5.4-mini |
| **Investor** | Return — is there a fundable business, not just a real pain point? | Claude Sonnet 5 → Haiku 4.5 |
| **Skeptic** | Disconfirmation — actively hunts for the strongest reason this fails | Gemini 3.1 Flash-Lite |

Round 0 is a **blind opening**: each role sees the same evidence but not each other, and states
a claim plus a categorical stance (`supports` / `opposes` / `insufficient`). Conversational
rounds only run if the openings show genuine disagreement (two conflicting stances, or a clash
over the same source) — a unanimous opening skips straight to the answer at zero extra cost.
Every "did they actually disagree," "did anyone move," and "is this contention resolvable by
more evidence" decision is computed mechanically from the committee's own output (confidences,
cited-source-ids, stances) — never a self-reported, made-up score.

## Two arms, one graph

Two research pipelines run side by side for direct comparison:

- **Baseline** — the original single-prompt pipeline: search → triage → scrape → one big LLM
  analysis call. Fast, cheap, no debate.
- **Orchestrated** (LangGraph) — decompose → retrieve → debate → gate → loop-or-answer. This is
  the real system described above. Two retrieval strategies plug into the same graph:
  - `coded` — deterministic search/triage/scrape, tuned per question.
  - `agentic` — a bounded Haiku researcher agent per open question, searching and reading for
    itself instead of following a fixed pipeline. Evidence *volume* is pinned equal to the coded
    arm by construction, so the two arms are an apples-to-apples eval of retrieval *strategy*,
    not evidence quantity.

`npm run compare` runs all three arms on the same topic and writes cost/quality/timing
side by side.

## Budget is a hard constraint, not a suggestion

Every run is capped on two independent axes, enforced in code (not by asking the LLM nicely):

- **Retrieval credits** (`TOTAL_RETRIEVAL_BUDGET`, default 80) — Exa search + Firecrawl scrape
  credits. No single retrieval pass can spend more than half the budget, so an early broad pass
  can't starve the later gap-targeted ones.
- **LLM spend** (`MAX_RUN_COST_USD`, default $0.75) — a real-time USD cap checked before every
  LLM call. If it's hit mid-run, the system doesn't fail — it synthesizes a partial report from
  whatever the committee had settled so far and says so.

Debate itself is bounded too: `MAX_DEBATE_ROUNDS` (2) caps conversational rounds, and a round
that moves no position ends the debate immediately — there's no reward for arguing past the
point of new information. Retrieval loops similarly stop the moment a pass returns no new
evidence, rather than repeating a search that already came up empty.

## Traceability

Every orchestrated run writes a full trace: every prompt and response (with token/cache usage),
every search and scrape call (live vs. cache hit), every debate round's transcript, and why the
run stopped when it did (budget, cost cap, no progress, or a converged committee). The frontend
question board (`QuestionBoard`) renders the live run as one swimlane per question — recon,
opening stances, debate, gate decision, retrieval — and a saved run can be replayed byte-for-byte
from its event log with no API keys and no cost. Nothing about the reasoning is opaque.

---

## Quick start

```bash
npm install
cp .env.local.example .env.local   # then add your keys
npm run dev                        # http://localhost:3000
```

Keys needed in `.env.local`:

| Var | Used for |
| --- | --- |
| `EXA_API_KEY` | web search (default search provider) |
| `FIRECRAWL_API_KEY` | scrape (default scrape provider) — needed alongside Exa, not instead of it |
| `OPENAI_API_KEY` | historian + operator committee roles |
| `ANTHROPIC_API_KEY` | manager, investor committee role, digest, researcher agent, final answer |
| `GOOGLE_GENERATIVE_AI_API_KEY` | skeptic committee role — a free-tier AI Studio key works ($0, rate-limited) |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | search/scrape/blocklist cache (optional but recommended — see [Caching](#caching)) |

```bash
npm run compare -- "freight brokerage"                       # all three arms, side by side
npm run run-arm agentic "freight brokerage"                  # one arm: baseline | orchestrated | agentic
npm run run-arm agentic "freight brokerage" --budget=50 --usd-budget=0.25   # override both budgets ($flag=N, not a space)
```

`--budget` (retrieval credits) and `--usd-budget` (LLM dollars) are two independent caps —
either can run out first. Neither applies to `baseline` (no graph, no cost tracker).
`compare` lands output in `compare-output/<topic>-<timestamp>.json`.

---

## Architecture

### Orchestrated pipeline

```
topic
   │
   ▼ DECOMPOSE      manager breaks the topic into 3–4 research questions + a search query each
   ▼ RETRIEVE        coded search/triage/scrape, or the agentic researcher swarm — see below
   ▼ DIGEST          one cheap pass compresses each source to a ~400-char item (keeps committee context small)
   ▼ DEBATE          committee blind opening → (if genuinely contested) conversational rounds
   ▼ GATE            route on committee stance: settle / report fault line / retrieve the named gap
   ├─(gap found, budget left)─► back to RETRIEVE
   ▼ ANSWER          cited, per-question-confidence report; exempt from the cost cap so it always completes
```

Retrieval loops back only when the committee named a **specific, evidence-shaped gap** and
budget remains; everything else routes straight to the answer. `MAX_LOOP_ITERATIONS` (5),
zero-new-evidence, and the cost cap all independently stop the loop.

### Debate, in detail

```
question + frozen evidence snapshot
   │
   ▼ Round 0 (blind)   each role claims independently: conclusion, confidence, stance
   ▼ hasGenuineDisagreement?  (≥2 conflicting stances, or a clash over the same source)
        no  → skip straight to the gate (agreement is a signal to act, not a stalemate to poll)
        yes → Round 1..N: each role sees the full transcript + challenges aimed at it,
              and rebuts / concedes / extends — conceding only when a source forces it
   ▼ stop the instant a round moves no position, or at the round cap
```

Evidence is **frozen** for the duration of a debate — only the outer retrieval loop can add new
evidence. Constructive roles drop to a cheaper model on re-debate rounds (declining marginal
value of a full-strength model reviewing its own prior claim); the skeptic holds its stronger
tier longer, since a cross-family adversarial check is the point.

### Agentic retrieval

The `agentic` arm swaps the coded retrieve node for a swarm of bounded researcher agents (Haiku),
one per open question, each running a tool loop (`webSearch` → `readSource`) against a shared
credit pool, first-come-first-served. It stops on hitting its step cap, the pool running dry, the
cost check firing, or the model deciding it has enough. Evidence volume per question is pinned
equal to the coded arm, so the only variable between arms is retrieval *judgment*, not evidence
quantity — the actual thing being evaluated.

### Token/cost efficiency

The debate is engineered to spend as little as possible without losing signal: a digest pass
shrinks raw pages before the committee ever sees them; the three Claude roles share one
prompt-cache-eligible system prefix per round; re-debate rounds run on a cheaper model tier;
LLM calls are concurrency-capped per model so a fan-out can't trip a provider's rate limit; and a
loop that adds zero new evidence kills itself instead of re-running an identical debate.

---

## Project map

```
src/lib/
  roles.ts                 committee role catalog — persona + model, per role, single source of truth
  pricing.ts                model $/1M pricing + search/scrape credit rates
  params.ts                  orchestration tunables (budgets, loop caps, debate rounds)
  prompts.ts                  all non-persona LLM prompt wording
  evidence/
    provider.ts               provider-agnostic search/scrape pipeline (dedupe, triage, cache, scrape pool)
    config.ts                  SEARCH_PROVIDER (Exa) / SCRAPE_PROVIDER (Firecrawl) + retrieval tunables
    firecrawl.ts / exa.ts       the two vendor implementations
  orchestration/
    graph.ts                   LangGraph StateGraph: decompose → retrieve → debate → gate → answer
    committee.ts                blind opening + full debate loop
    debate.ts                   pure debate logic: disagreement, movement, contention — no LLM calls
    researcher.ts                agentic retrieve: the researcher agent + shared credit pool
    gate.ts                      stance routing + retrieval gate
    cost-tracker.ts               per-run USD cap
    trace.ts                     exhaustive run trace writer
  research/
    board.ts, arena.ts            pure data helpers for the live question-board UI
src/components/research/
  QuestionBoard.tsx              swimlane-per-question live UI, drill-down router
  DebateArena.tsx, AgentSwimlane.tsx   deliberation drill-downs
scripts/
  compare-arms.ts / run-arm.ts    A/B/C comparison harness + single-arm runner
supabase/schema.sql               cache + blocklist schema
```

---

## Testing

Zero-cost checks (no API spend):

```bash
npx tsc --noEmit         # typecheck
npx vitest run            # unit tests
npm run smoke:supabase   # verify the Supabase cache round-trips (live but free)
```

Paid/live checks (spend API credits — the real functional test of the pipeline):

```bash
npm run run-arm agentic "freight brokerage"
npm run compare -- "freight brokerage"
```

---

## Caching

Search results, scraped pages, and a scraper blocklist are cached in Supabase (`blindspot`
schema, shared across processes and both arms) so repeat topics cost nothing on the parts
already fetched. If Supabase is unreachable, a run degrades gracefully — it warns once and
proceeds uncached rather than failing. Set up: create the schema from
[`supabase/schema.sql`](supabase/schema.sql), add `blindspot` to the project's Exposed
schemas, then run `npm run smoke:supabase`.

---

See [STATUS.md](STATUS.md) for the current build status and changelog, and [CLAUDE.md](CLAUDE.md)
for the full file-by-file reference.
