# Blindspot

> Attention is all you need. But what evidence is worth your attention?

Ask an LLM "is there a business here?" and you get a fluent, generic, unfalsifiable answer — no
sourcing, no acknowledgment of what it doesn't know, and no mechanism to disagree with itself.
Blindspot answers the same question with **empirical, cited, and adversarially-tested** evidence
instead: it goes and reads real sources, runs a committee that actually argues about what they
mean, spends a hard-capped budget only where more evidence could change the answer, and hands
back a verdict you can trace claim-by-claim back to a URL — including an honest account of what
the evidence couldn't settle.

Type an industry or topic, get a report with a scored thesis, cited claims, and a named list of
what's still unknown.

---

## Why this exists

### A single LLM call can't tell you what it doesn't know

A transformer's whole computation is "which tokens deserve attention, given what I've already
seen." That's a good model of reading — it's a bad model of *research*. A single-shot answer has
no mechanism to go check a fact, no way to flag "I'm guessing here," and every token it emits is
optimized to sound plausible, not to be falsifiable. You cannot audit a paragraph of confident
prose against the sources it didn't cite, because it didn't cite any.

Blindspot inverts the question. Instead of asking a model to *recall* an answer, it asks: **out
of everything findable on the open web, what specific evidence is worth reading, and what does
it actually establish?** That's a retrieval-and-attention allocation problem, not a knowledge
problem — and it's one you can build real guarantees around: budgets, citations, adversarial
checks, and a record of exactly what was read and why.

### Assessing a market is a search problem, not a lookup

"Is there a business in freight-brokerage vendor management?" isn't answered by one fact — it
depends on precedent (has this been tried, how did it die), operational reality (what actually
breaks day to day), market structure (is there a fundable business here), and the strongest
reason it fails. Each of those lives in different corners of the web, phrased differently, and
most search queries you'd try come back with marketing copy, adjacent-but-wrong results, or
nothing useful at all. A broad market scan is inherently a **high-fan-out, mostly-fruitless
search problem**: you need to cast a wide net across many angles, expect most of it to miss, and
know which of the hits actually deserve to be read closely, remembered, and argued over before
you can synthesize an answer. Blindspot is built around that reality rather than pretending one
or two queries will do — retrieval, triage, and budget allocation are first-class system
components, not an afterthought bolted onto an LLM call.

### Disagreement is signal, not noise

A panel that's told to agree will agree — and that agreement is worthless, because you can't
tell if it's real consensus or four models converging on the same plausible-sounding guess.
Blindspot's committee forms opinions **blind**, independently, before anyone sees anyone else's
view, so cross-role agreement is a genuine signal and disagreement is preserved and reported
rather than smoothed away. When the committee can't agree because two readings of the evidence
are both defensible, the report says so — "here's the fault line, and here's why more searching
can't resolve it" is a more honest and more useful answer than a forced consensus.

---

## How it works

### The committee — adversarial debate, not a poll

Four role-agents, deliberately built to disagree rather than converge to a bland consensus. Each
has its own incentive, and one of them runs on a model family that never talks to the others, so
its skepticism isn't contaminated by peer pressure:

| Role | Incentive | Model (opening → re-debate) |
| --- | --- | --- |
| **Historian** | Precedent — has this been tried, and how did it die? | gpt-5.4-mini |
| **Operator** | Reality on the ground — what actually breaks day to day? | gpt-5.4-mini |
| **Investor** | Return — is there a fundable business, not just a real pain point? | Claude Sonnet 5 → Haiku 4.5 |
| **Skeptic** | Disconfirmation — actively hunts for the strongest reason this fails | Gemini 3.1 Flash-Lite |

**Blind openings.** Round 0 shows every role the *same* evidence but not each other's answers.
Each states a claim: a conclusion, a calibrated confidence, and a categorical **stance**
(`supports` / `opposes` / `insufficient`). This isn't just procedural fairness — an earlier
version let roles see the discussion as they wrote, and one role learned to claim "no evidence
was given" even when it had cited that same evidence moments earlier, an artifact of herding
toward what it expected to be asked. Blind openings make cross-role agreement real signal instead
of an echo, and give the debate an honest starting position to argue from.

**Debate only when it's genuine.** Conversational rounds run *only* when the openings show real
disagreement — at least two conflicting stances, or two roles citing the same source to opposite
conclusions. A unanimous opening skips straight to the gate at zero extra cost; polling four
models that already agree and then paying for a multi-round debate to restate the agreement is
pure waste, and early traces showed exactly that pattern before this check existed. When rounds
do run, each role sees the full transcript and the challenges aimed at it, and may rebut,
concede, or extend — **conceding only when a cited source forces it, never to consensus**. Every
role is explicitly instructed that agreement is not evidence. The debate stops the instant a
round moves no position (confidence shift below `DEBATE_CONFIDENCE_EPSILON = 0.05` and no new
cited-id changes count as no movement) or hits the `MAX_DEBATE_ROUNDS = 2` cap.

**Nothing is a self-reported score.** Whether the committee genuinely disagrees, whether a role
moved, and whether a surviving disagreement is resolvable by more evidence are all computed
mechanically from the committee's own structured output — stances, cited-source-id sets,
confidence deltas — in `src/lib/orchestration/debate.ts`, a pure, unit-tested module with no LLM
calls of its own. The system never asks a model to grade its own certainty on a made-up 0–1 scale
and then does math on the result.

### Preserve disagreement; retrieve only where it pays

A gate reads the committee's verdict on every question and routes it, with **no LLM call at
all** for most cases:

- **Unanimous lean** (`supports`/`opposes`) → settled. Done.
- **Contested, interpretive** (both sides argue from the *same* evidence, no one names a missing
  fact) → resolved as a reported **fault line**. More retrieval can't fix a disagreement about
  what evidence *means* — spending budget chasing it would be pure waste, so the system doesn't.
- **Contested or unresolved, with a named evidential gap** → this is where retrieval earns its
  keep. Only a *specific, named* missing fact routes back to the retrieval loop, targeted at that
  gap specifically. This is retrieval-on-value-of-information: the system doesn't search more
  because it's uncertain in general, it searches more because a role named the exact fact that
  would change the answer.
- A gap that survives one more retrieval pass without narrowing is noted as a **structural
  limitation** in the final report, not chased a third time (patience = 1) — some data (private
  ARR figures, internal churn) is genuinely not on the public web, and the system says so instead
  of burning budget pretending otherwise.

Only after this zero-cost routing does a cheap LLM classifier (`gpt-4o-mini`) score any
remaining ambiguous questions on computed signals — named-gap count, confidence spread — never a
vibe-check. If it asks for more retrieval than the remaining budget allows, the system clamps to
the highest-value questions by gap count rather than either overspending or picking arbitrarily.

### Agent orchestration — a graph, not a chat loop

Orchestration is a [LangGraph.js](https://langchain-ai.github.io/langgraphjs/) `StateGraph`, not
an open-ended agent loop:

```
topic
   │
   ▼ DECOMPOSE     manager breaks the topic into 3–4 concrete research questions + a search query each
   ▼ RETRIEVE       search + scrape for each open question (coded pipeline, or an agentic researcher swarm)
   ▼ DIGEST         compress each fresh source into a short evidence item before the committee reads it
   ▼ DEBATE         blind opening → conversational rounds only on genuine disagreement
   ▼ GATE           route each question: settle / report fault line / retrieve the named gap
   ├─(gap named, budget left)─► back to RETRIEVE
   ▼ ANSWER         cited, per-question report — exempt from the cost cap so it always completes
```

State moves through the graph via **reducers**, not last-write-wins assignment. Budget is
tracked as `budgetRemaining`/`budgetSpent`, and every node that touches it returns a *signed
delta* that an additive reducer accumulates — never an absolute value. That makes budget updates
order-independent: two nodes writing budget in the same LangGraph super-step can't silently
clobber each other the way a replace-style reducer would (`retrieve` is the sole writer; `gate`
writes none). Debate transcripts use a replace-per-question reducer instead, since a fresh loop's
transcript should fully supersede the last one for that question, not merge with it. Every graph
run also checkpoints its full state history (LangGraph `MemorySaver`), so a run is inspectable
step by step, not just at the end.

The graph loops back to `RETRIEVE` only when the gate found a named gap *and* budget remains —
capped independently by a hard iteration ceiling, a zero-new-evidence kill switch (a pass that
retrieves nothing new can't possibly change the debate, so the loop ends instead of re-running an
identical argument), and the cost cap below.

### Budget is a hard constraint, enforced in code

Every run is capped on two independent axes, checked before every spend — not by asking an LLM
to behave:

- **Retrieval credits** (`TOTAL_RETRIEVAL_BUDGET = 80`) — one combined search+scrape credit pool.
  No single retrieval pass may spend more than half of it (`MAX_LOOP_SPEND_FRACTION = 0.5`), so
  an early broad pass can't drain the pool before the gap-targeted passes — the actual point of
  the outer loop — ever get to run.
- **LLM spend** (`MAX_RUN_COST_USD = 0.75`) — a real-time USD ceiling checked before every gated
  call via an `AsyncLocalStorage`-scoped cost tracker (so concurrent runs never clobber each
  other's spend). Before starting a fresh retrieve+debate cycle, the gate also checks it can
  *finish* the cycle it's about to start (`LOOP_COST_PER_QUESTION_USD × unresolved-question-count`
  of headroom required) — because a cap hit mid-debate makes LangGraph roll the whole super-step
  back, discarding freshly-gathered evidence and committing nothing. Converging cleanly one loop
  early beats starting a cycle that orphans its own work. If the cap is still hit, the run
  degrades gracefully: it synthesizes a partial report from whatever the committee had already
  settled. The final answer call itself is **exempt** from the cap — the deliverable always
  completes, even on a run that otherwise blew its budget.

### Knowing what deserves your attention

Retrieval finds far more candidate pages than are worth reading, and every source that does get
read costs both a scrape credit and committee context. Two layers decide what actually earns
attention:

- **Triage before scrape.** A cheap relevance-scoring pass ranks every deduplicated search hit
  before anything is scraped, so an off-topic result never costs a scrape credit or reaches the
  committee.
- **Digest before debate.** A per-question compression pass turns each fresh source into a short,
  id-keyed evidence item before the committee fans out — the four roles reason over compact
  digests, not raw page text, which keeps a wall of scraped HTML out of every role's context
  while preserving exactly enough for a role to cite a specific source.

Together with the VOI-driven gate above (retrieve only for a *named* gap), this is the same idea
applied at every layer: don't spend retrieval, context, or reasoning budget on evidence that
isn't going to move the answer.

### Traceability and citations

Every claim in the final answer is threaded back to a `[S#]` citation tag mapped to a real
evidence id — an earlier version let the answer prose float free of its sources, and it cited
nothing despite the committee having sourced most of its claims; the answer builder now requires
citation and tags each claim with the sources that support it.

Beyond the final report, every orchestrated run writes an exhaustive trace file: every prompt and
response (with cache read/write token counts), every search and scrape call (live vs. cache hit),
every debate round's transcript, and the exact reason the run stopped when it did
(`budget` / `cost-headroom` / `max-loops` / `no-progress` / a converged committee). The frontend
**question board** renders a live run as one swimlane per question — recon, opening stances,
debate, gate decision, retrieval — over SSE, and any saved run can be replayed byte-for-byte from
its event log at `/replay`, scrubbable, with no API keys and no cost. Nothing about the reasoning
is a black box.

### Configurability — swap providers and models without touching call sites

Search and scrape are **independently** selectable operations (`SEARCH_PROVIDER` / `SCRAPE_PROVIDER`
in `src/lib/evidence/config.ts` — defaults: Exa for search, Firecrawl for scrape), resolved
through one provider-agnostic pipeline in `evidence/provider.ts`. Every call site imports from
that seam, never a specific vendor's module, so adding a third search or scrape provider is a
matter of implementing `SearchOps`/`ScrapeOps` once, not hunting down every caller.

Every model assignment is equally centralized and swappable: each committee role's model (both
its round-0 and re-debate tier) lives in `src/lib/roles.ts` alongside its persona, and every
non-committee model (manager, gate classifier, digest, researcher agent, final answer) is a named
constant in `src/lib/params.ts`. Pricing for every model and provider lives in one catalog
(`src/lib/pricing.ts`), which cost tracking and the frontend cost display both read from — change
a model id in one place and correctness, cost accounting, and the UI all follow automatically.

### Caching and convergence

- **Result caching.** Search results, scraped pages, and a scraper blocklist are cached in
  Supabase, shared across processes and both research arms — a repeated query or URL costs
  nothing on a later run. If Supabase is unreachable, a run degrades gracefully to uncached
  rather than failing.
- **Prompt caching.** The three Claude committee roles share a byte-identical system-message
  prefix (question + evidence + calibration text) per round, above a minimum size
  (`PROMPT_CACHE_MIN_CHARS = 4500`), so Anthropic serves repeat reads of it from its prompt cache
  instead of re-billing full price.
- **Convergence thresholds, not open-ended looping.** A debate round counts as "moved" only if a
  role's confidence shifts past `DEBATE_CONFIDENCE_EPSILON = 0.05` or its cited-evidence set
  changes; a retrieval loop counts as diminishing once it raises mean confidence by less than
  `LOOP_CONFIDENCE_EPSILON = 0.05` **and** closes no named gap. Both are small, explicit epsilons
  chosen so the system stops arguing/searching the moment it stops learning, rather than running
  to a hard cap by default.

### Two arms, one graph

Two research pipelines run side by side for direct comparison, with `npm run compare` running
all of them on the same topic and writing cost/quality/timing side by side:

- **Baseline** — the original single-prompt pipeline: search → triage → scrape → one big LLM
  analysis call. No debate, for comparison against the orchestrated system's actual value-add.
- **Orchestrated** (LangGraph) — the full system described above. Two interchangeable retrieval
  strategies plug into the same graph:
  - `coded` — deterministic search → triage → scrape, tuned per question.
  - `agentic` — a bounded researcher agent (Haiku) per open question, searching and reading for
    itself instead of following a fixed pipeline. Evidence *volume* per question is pinned equal
    to the coded arm by construction, so the two arms are an apples-to-apples eval of retrieval
    *judgment*, not evidence quantity.

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

`--budget` (retrieval credits) and `--usd-budget` (LLM dollars) are two independent caps — either
can run out first. Neither applies to `baseline` (no graph, no cost tracker). `compare` lands
output in `compare-output/<topic>-<timestamp>.json`.

---

## Project map

```
src/lib/
  roles.ts                 committee role catalog — persona + model, per role, single source of truth
  pricing.ts                model $/1M pricing + search/scrape credit rates
  params.ts                  orchestration tunables (budgets, loop caps, debate rounds, epsilons)
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
    gate.ts                      stance routing + VOI retrieval gate
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

Full file-by-file reference: [CLAUDE.md](CLAUDE.md). Changelog and current status: [STATUS.md](STATUS.md).

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
schema, shared across processes and both arms) so repeat topics cost nothing on the parts already
fetched. If Supabase is unreachable, a run degrades gracefully — it warns once and proceeds
uncached rather than failing. Set up: create the schema from
[`supabase/schema.sql`](supabase/schema.sql), add `blindspot` to the project's Exposed schemas,
then run `npm run smoke:supabase`.

---

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, the project's
design principles, and how to open a PR.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
