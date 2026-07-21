# Status

Running log of what's built and what's left. Stable reference (architecture, key files, build
commands, design principles) lives in [CLAUDE.md](CLAUDE.md); the full conceptual pitch and
architecture walkthrough lives in [README.md](README.md). This file is a changelog index, not a
narrative — for the "why" behind any entry, read the commit(s) on the branch named.

## What this is

Adaptive multi-agent research system on top of a Next.js/TypeScript app. A manager decomposes a
topic into questions; for each question a four-role committee (Historian, Operator on
gpt-5.4-mini; Investor on Claude Sonnet 5; Skeptic on Gemini 3.1 Flash-Lite) debates over a
frozen evidence snapshot — a blind round-0 opening, then conversational rounds only when the
openings genuinely disagree. A gate routes each question on its committee stance: settle a
unanimous lean, resolve a fault line, or send a named evidential gap back to retrieval.
Orchestration is LangGraph.js. Two arms (baseline single-prompt vs. orchestrated graph) run
side by side; the orchestrated arm supports two retrieval strategies (coded, agentic).

## Built

- **Core system** (`evidence` / `committee` / `eval` / `graph` branches) — `search()` + Evidence
  store; `runCommittee()` (four independent role claims); baseline arm + A/B compare harness;
  LangGraph `StateGraph` (decompose → retrieve → debate → gate → recommend).
- **Wave 2 — token efficiency**: per-question Haiku digest before the committee (L2); Anthropic
  prompt-cache split so the three Claude roles share a byte-identical system prefix (L3);
  loop-aware model mix, dropping constructive roles to Haiku on re-debates (L4); per-model FIFO
  concurrency caps + retries (L6); zero-progress loop kill; caches moved to Supabase.
- **Wave 3 — real committee debate**: pure, unit-tested debate logic (`debate.ts`) — genuine
  disagreement, movement, contentions — computed from real committee output, never a self-report;
  cache-preserving multi-round debate messages; declining-model-tier debate rounds; gate routes
  interpretive contentions to a reported fault line at zero LLM cost, evidential contentions to
  targeted retrieval.
- **Adaptive economics + deliverable quality**: cross-round prompt-cache breakpoint; debate exits
  the instant a round moves nothing; per-pass retrieval-budget reservation (no single pass can
  drain the pool); reconnaissance-depth loop 0; $0.75 LLM cost cap with the final answer exempt so
  the deliverable always completes; answer threads real `[S#]` citations back to evidence; all
  prompt wording centralized to `prompts.ts`.
- **Agentic retrieval** (`retrievalMode: "agentic"`) — the coded retrieve node's alternative: a
  bounded Haiku researcher agent per open question (search → read tool loop) drawing from a
  shared credit pool. Evidence volume per question is pinned equal to the coded arm by
  construction, so the two retrieval strategies are an apples-to-apples eval of retrieval
  *judgment*, not evidence quantity. A third `compare-arms` eval arm measures it against `coded`.
- **Stance-based disagreement routing** — every claim carries a categorical `stance`
  (`supports`/`opposes`/`insufficient`); conversational debate rounds run only on genuine
  disagreement (≥2 conflicting stances or a source clash), and unanimous-but-`insufficient`
  questions route to retrieval instead of being silently resolved as agreement. Run mechanics
  surface debated-vs-skipped and flag rounds that ran but moved nothing.
- **Question board UI** — question-centric swimlane board (Recon → Openings → Deliberation →
  Gate → Loop) replacing the old stage-centric dashboard; live SSE-driven and byte-for-byte
  replayable from a saved event log (`/replay`, no keys, no cost); terminal run-mechanics receipt.
- **Replay coherence + single-source cost accounting** — one `drainUsages()` cursor over the cost
  tracker's ledger replaces six per-node cost-event emitters that had silently dropped ~23% of
  real spend from the live ticker; the gate now reports *why* a run converged
  (`cost-headroom`/`no-progress`/`max-loops`/`budget`/`gate-decided`); a question with a
  budget-truncated (but unpursued) gap is flagged distinctly from a genuine fault line, live and
  in replay alike, including a backfill for traces recorded before these fields existed.

All of the above: `tsc` clean, 470 vitest tests green.

## Open issues

- None blocking.
- **Prompt caching is modest in practice** (~12% of input served from cache) — re-debates run on
  Haiku (below Anthropic's cache-write floor once digested) and the debate stall-exit removes
  most round-2s, capping the cross-round win. Not worth chasing: the digest and the Haiku tier
  each already save more than the forfeited cache.
- **Structural ceiling**: decision-critical B2B data (competitor ARR/churn, WTP, procurement
  specifics) is often not public. Calibration steers the committee to reason from proxies instead
  of chasing unfindable gaps, but a truly authoritative unit-economics answer needs proprietary
  data sources — a known boundary of the tool, not a bug.
