# Status

Running log of what's built and what's left. Stable reference (architecture, key files, build commands, design principles) lives in [CLAUDE.md](CLAUDE.md).

## What this is

Adaptive multi-agent research system on top of a Next.js/TypeScript Firecrawl app ("Blindspot"). A manager decomposes a topic into questions, a committee (Historian, Operator, Investor on Claude Sonnet 5; Skeptic on GPT-4o) debates structured claims, and a VOI gate allocates further retrieval budget. Orchestration is LangGraph.js. Two arms (baseline single-prompt vs orchestrated graph) run side-by-side.

## Done

- **Four core branches merged**: `evidence` (`search()` + Evidence store), `committee` (`runCommittee()` four-role deliberation), `eval` (baseline arm + A/B compare), `graph` (LangGraph StateGraph: decompose → retrieve → debate → gate → recommend).
- **Gate prompt**: summarizes each unresolved question's claims (role, conclusion, confidence, evidence counts, gaps) so the gate scores disagreement, sensitivity, tractability.
- **Token tracking**: `ResearchState.llmCalls` threads through every structured-output LLM call; `runGraph()` rolls up into `ArmResult.tokens`.
- **Params consolidation**: orchestration tunables in `src/lib/params.ts`.
- **Single-arm runner**: `scripts/run-arm.ts` (baseline or orchestrated); both scripts accept `--budget`.
- **Real-time visualization**: SSE from LangGraph nodes (`graph-stream.ts` + `/api/research/orchestrated`), `useResearchStream` hook + reducer. Live UI: pipeline graph, question tracker, 4-agent panel, evidence feed, gate table, cost counter. Landing-page mode toggle: "Industry Scan" vs "Deep Research".
- **Budget concurrency**: `CostTracker` moved from a module singleton to `AsyncLocalStorage` (per-run via `runWithCostTracker`) so concurrent runs don't clobber each other's spend; cost recorded from exact `usage`, no pre-call estimate (bounded one-wave overshoot accepted). `budgetRemaining`/`budgetSpent` use an additive reducer (`accumulate`) over signed deltas — `retrieve` is the sole writer, `gate` writes no budget — so same-super-step updates can't be lost.
- **Schema-crash fix**: root-caused the intermittent "No object generated: response did not match schema" that killed orchestrated runs. Zod `.min()`/`.max()` caps in LLM output schemas (`ClaimOutputSchema` conclusion ≤400 chars etc.) are stripped by providers before generation and only validated client-side — the model exceeded them ~1 in 7 committee calls, and one bad call rejected the whole `Promise.all`. Removed the caps from `ClaimOutputSchema`, `DecompositionSchema`, `RefineSchema` (steering stays in `.describe()` hints); bounds that matter downstream are clamped in code (confidence → [0,1] and `missingEvidence` → 3 in `committee.ts`; questions → `MAX_QUESTIONS` in `decompose`; search queries → 3 in `refine`).
- **Live streaming progress**: fixed the UI freezing for minutes during `retrieve`. `graph-stream.ts` now emits each node's `begin` event eagerly on its predecessor's completion (successors are deterministic; the post-gate choice mirrors `routeAfterGate` including the budget condition), instead of waiting for `streamMode: "updates"` node-completion. Stream mode is now `["updates", "custom"]`: the retrieve node forwards per-query search results and a scrape counter from `search()` (new optional `onProgress` callback, `SearchProgress` type) through LangGraph's `config.writer`, surfaced as the new `retrieve:progress` SSE event and rendered in the trace feed (scrape counter lines coalesce). Verified live: first `begin` at ~0s, 17 progress events across a 67s retrieve.
- **AI SDK v7 migration**: replaced deprecated `generateObject` with `generateText` + `Output.object({ schema })` at all four call sites (`committee.ts`, `gate.ts`, `graph.ts` decompose/refine). Usage shape unchanged (`inputTokens`/`outputTokens`), so cost tracking and tracing flow through as before. Note: schema-validation failures now throw `NoOutputGeneratedError` (was `NoObjectGeneratedError`).

## Remaining

- End-to-end eval run on "freight brokerage" (crash + freeze blockers above are fixed; a full orchestrated run on "dog walking apps" completed cleanly at budget 8).
- Tune `VOI_THRESHOLD` and budget constants from real output.
- First multi-loop UI run: the refine → retrieve second-pass begin-event path mirrors verified logic but hasn't been exercised live (test run converged in one loop).
- `TraceLogger` only demonstrably writes traces from script runs; confirm the SSE route path produces `trace-output/` files too (the pre-fix UI failures left no trace to autopsy).

## Open issues

- None currently blocking. (Previous schema-crash and silent-retrieve issues resolved — see Done.)
