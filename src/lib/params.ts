/**
 * params.ts — every tunable parameter in one place.
 *
 * Baseline pipeline params (search → triage → scrape → analyze) are at the top.
 * Orchestration params (decompose → retrieve → debate → gate loop) are below.
 */
// -- Baseline: models --------------------------------------------------------

export const ANALYSIS_MODEL        = "gpt-4o";
export const TRIAGE_MODEL          = "gpt-4o-mini";

// Search/scrape tunables (intents, scrape depth, triage, provider concurrency, and the
// SEARCH_PROVIDER selector) now live in evidence/config.ts — provider-agnostic retrieval
// mechanics, not orchestration/gate policy. Import from there, not here.

// -- Orchestration: intake ---------------------------------------------------

// The intake node reads the raw topic into a ResearchBrief. `constraints` is an LLM-output
// array (no schema max — providers strip it), so we clamp its length here in code.
export const MAX_BRIEF_CONSTRAINTS = 8;

// -- Orchestration: decompose ------------------------------------------------

export const MIN_QUESTIONS         = 3;
// 4 covers a go/no-go's core facets while keeping loop-0 retrieval spend low enough that a second
// loop fits under the Firecrawl budget (5 questions × 2 queries blew the whole budget in one loop).
export const MAX_QUESTIONS         = 4;
// Search query shape (MAX_SEARCH_QUERIES_PER_QUESTION) and retrieve-loop depth
// (RESULTS_PER_QUESTION, RECON_RESULTS_PER_QUESTION, resultsPerQuestionForLoop, triage) now live
// in evidence/config.ts alongside the rest of the retrieval tunables.

// -- Orchestration: gate / budget --------------------------------------------

export const MAX_LOOP_ITERATIONS   = 5;
export const TOTAL_FIRECRAWL_BUDGET = 80;
// Hard USD cap on a run's LLM spend, enforced by the cost tracker (check() before each gated call).
// The final objective-level ANSWER is EXEMPT (it records cost but never gates) — the deliverable is
// non-negotiable and always gets written, even on a run that hit this cap. So a run's total can land
// slightly above this: ~this much deliberation + the exempt answer on top.
export const MAX_RUN_COST_USD      = 0.75;

// LLM-cost headroom required to justify STARTING another retrieve+debate cycle. A cycle that
// begins with less than this remaining under MAX_RUN_COST_USD risks blowing the cap MID-flight —
// and because LangGraph rolls a super-step back when a call throws mid-step, a mid-debate cap hit
// produces ZERO committed claims and ORPHANS the evidence that pass just gathered. So the gate
// converges cleanly BEFORE such a cycle, keeping the last COMPLETE loop's claims for the answer.
// Sized to cover roughly one bounded deliberation cycle: post the per-pass evidence ceiling, a
// retrieve+redebate cycle runs ~$0.15–0.25. Tunable; keep it a small fraction of MAX_RUN_COST_USD
// (here 1/3) so early loops aren't starved while a late, unaffordable loop is still stopped short.
export const MIN_LOOP_COST_HEADROOM_USD = 0.25;

// Output-token ceiling for the synthesis ANSWER call (the final deliverable). Left unset, the AI SDK
// sends the model's 128k default max_tokens; a non-streaming request at that ceiling is the classic
// truncation trap, and on a complex committee input Sonnet 5's adaptive thinking (which cannot be
// budget-capped on this model) can eat the visible answer. This bounds the request generously — far
// above thinking + a full multi-fault-line adjudication (~2k tokens observed) — so the answer always
// completes; answerObjective additionally retries once if the model still reports a length cut.
export const SYNTHESIS_ANSWER_MAX_TOKENS = 16000;

// Budget reservation across the retrieval loop: no single retrieve pass may spend more than this
// fraction of the run's INITIAL Firecrawl budget. The broad first pass has low marginal value per
// credit (you don't yet know what's missing); the gap-targeted passes after a debate have high value
// (the committee named the gap). Without a per-pass ceiling, loop 0 greedily drains the pool and the
// targeted passes — the whole point of the outer loop — never run (observed: a run that reached loop
// 0, produced 7 evidential gaps, then converged on "budget" with zero further retrieval). At the
// default budget this still covers every question at loop 0 while reserving half for the refined passes.
export const MAX_LOOP_SPEND_FRACTION = 0.5;

// A question is in diminishing returns when its most recent retrieval loop raised mean committee
// confidence by no more than this AND did not reduce its named-gap count — more retrieval is futile.
export const LOOP_CONFIDENCE_EPSILON = 0.05;

// -- Orchestration: token efficiency -----------------------------------------

export const MAX_EVIDENCE_CHARS_PER_AGENT = 30_000;
export const MAX_CONCLUSION_CHARS    = 400;

// Per-question evidence digest (L2): a Haiku pass compresses each source to one
// short item before the committee fans out, so each role sees a compact digest
// instead of full page content. DIGEST_ENABLED=false falls back to raw evidence.
export const DIGEST_ENABLED          = true;
export const MAX_DIGEST_SUMMARY_CHARS = 400;

// Committee cache-hit restructure (L3): the 3 Claude roles share a byte-identical system
// prefix so Anthropic can serve it from its prompt cache. cacheControl is only worth
// attaching when the prefix is large enough to matter — below this many chars, skip it.
export const PROMPT_CACHE_MIN_CHARS  = 4500;

// -- Orchestration: debate (inner loop, Wave 3) ------------------------------

// The committee is a real debate, not a poll: round 0 is the independent opening, then
// conversational rounds until positions stop moving or this cap is hit (round 0 excluded). Capped at
// 2 rebuttal rounds — traces show the verdict is stable by round 2; round 3 was mostly churn.
export const MAX_DEBATE_ROUNDS = 2;
// Whether to run the conversational rounds is now a STANCE decision (hasGenuineDisagreement in
// debate.ts) — ≥2 decisive stances or an id-clash — not a confidence-spread threshold, so the old
// DEBATE_CONSENSUS_SPREAD / DEBATE_CONSENSUS_MIN_CONFIDENCE knobs are gone.
// Round-over-round: a confidence move at or below this counts as "no movement" for convergence.
export const DEBATE_CONFIDENCE_EPSILON        = 0.05;

// -- Orchestration: researcher (agentic retrieval) ---------------------------

// The researcher agent runs on Haiku — its job is search PLANNING (pick a query, judge
// snippets, decide what to read), not deep reasoning. This id must exist in eval.ts
// MODEL_COST. Deliberately NOT added to MODEL_CONCURRENCY: it's shared with the committee's
// redebate roles, so a cap there would couple committee throttling — the ≤MAX_QUESTIONS
// per-pass fan-out is self-bounding and every Firecrawl call is already globally capped.
export const RESEARCHER_MODEL_ID   = "claude-haiku-4-5-20251001";
// Per-agent step cap: the researcher's tool-loop stops after at most this many model steps,
// so a search→search agent that never converges can't burn unbounded Haiku calls.
export const MAX_AGENT_STEPS       = 8;
// Web searches a researcher may run PER PASS — the direct analogue of the coded arm's
// MAX_SEARCH_QUERIES_PER_QUESTION=1. One search returns ~10 snippet hits; judging those snippets IS
// the triage ("window-shopping"), and reading the best of them is the point. Reformulating BEFORE
// reading is pure waste (a live run burned 30 searches / 60 credits and read only 4 pages, starving
// whole questions); if evidence is still thin after reading, the OUTER loop re-runs the agent with a
// sharper, gap-informed query. Code-enforced in webSearch (the prompt is only a hint). Default 1.
export const MAX_SEARCHES_PER_PASS = 1;
// Loop-0 recon floor: minimum sources an agent must gather before it may finish on the first
// (reconnaissance) pass. Mirrors the coded RECON_RESULTS_PER_QUESTION grounding floor — thin
// evidence mis-calibrates round-0 claims. Code-enforced (re-drive the agent), never a deadlock:
// the agent still stops on maxSteps / pool exhaustion / no-tool-call regardless (see §11).
export const RECON_FLOOR           = 3;
// The working-memo head the agent sees per readSource result (title + first N chars). The FULL
// page is still stored as Evidence for the committee — this only bounds the agent's context.
export const READSOURCE_HEAD_CHARS = 600;

// -- Orchestration: per-model concurrency + retries (L6) ----------------------

// Global in-flight cap per model id, keyed for models with a known low TPM ceiling; models
// absent here run unlimited. Empty by default post-gpt-4o (its low ceiling was the only reason
// this existed) — repopulate per-model if a new provider proves rate-limit-sensitive under fan-out.
export const MODEL_CONCURRENCY: Record<string, number> = {};
// Retries per LLM call (transient 429/5xx). Applied at every generateText call site.
export const LLM_MAX_RETRIES = 4;
