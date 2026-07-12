# Wave 2 brief — Token-Efficiency Overhaul, Phases 2 → 3 → 4b → 5

You are implementing Wave 2 of the "Token Efficiency + Run-Reliability Overhaul" on the
**`visualization`** branch of the Blindspot repo (adaptive multi-agent research system;
Next.js/TypeScript; LangGraph.js). Read `CLAUDE.md` first.

## HARD CONSTRAINTS (violating any fails the task)
1. **NEVER run anything that spends API credits or makes live LLM/Firecrawl/Supabase network
   calls.** Do NOT run `scripts/run-arm.ts`, `scripts/compare-arms.ts`, `npm run compare`,
   `npm run dev`, or any live research. Verification is ONLY `npx tsc --noEmit` and `npx vitest run`.
   (The human runs all live/cost verification themselves.)
2. Repo design rules: NO `.min()/.max()` on any Zod schema passed to `generateText`/`Output.object`
   (providers strip them; steer with `.describe()`, clamp in code). NO made-up 0–1 "vibe" float
   scores. Enforce constraints in code, not prompts.
3. Match surrounding code style/naming/comment density.

## Execution protocol
- These four phases are a **strict sequential chain** (shared `committee.ts`/`graph.ts`/`params.ts`
  + each consumes the prior's new symbols). Do them **in order**, one at a time. Do NOT parallelize.
- Per phase: implement → add the listed tests → `npx tsc --noEmit` clean → `npx vitest run` green →
  **commit** (message ending with the Co-Authored-By trailer used in the repo's recent commits) →
  then **pause and report a short diff summary before starting the next phase.**
- Watch for cross-phase test breaks (e.g. a later phase changing a shape a prior test asserts) — the
  per-phase `vitest` gate exists to catch these.

## Grounding — Wave 1 is already landed on this branch (build on it, don't redo)
- `eval.ts`: `estimateCostUsd`/`toAnnotatedUsage` are already **cache-aware** (`CacheAwareUsage`,
  `cachedPromptTokens`/`cacheCreationTokens`, per-model `cacheReadMult`/`cacheWriteMult`, warn-once
  on unknown model). `MODEL_COST` already includes `claude-haiku-4-5-20251001` at $1/$5.
- `graph.ts` exports `computeRecursionLimit` and `scopeEvidenceToQuestions`; runners already degrade
  on `GraphRecursionError` and always write the trace.
- `warn-once.ts` exists (`warnOnce`); the Supabase cache files already warn-once on failure.
- `test/helpers/mock-ai.ts` exists: `fakeGenResult(output, usage?)` + `assertNoLlmCalls()`, with a
  per-file hoisted `vi.mock("ai", …)` pattern. Use it for any node-level mocked tests.
- Call sites use `const { output: object, usage } = await generateText({ …, output: Output.object({ schema }) })`
  — in `committee.ts`, `graph.ts` (decompose ~:123, refine ~:306), `gate.ts` (~:70).
- `committee.ts`: `buildUserPrompt(question, evidence)` is currently **private**; `runCommittee(question, evidence)`.
- `provider.ts`: `modelForRole(role)` has **no** loopIteration param yet.
- `params.ts` holds tunables (`MAX_LOOP_ITERATIONS`, `MAX_EVIDENCE_CHARS_PER_AGENT`, `RESULTS_PER_QUESTION`, `MAX_RUN_COST_USD`, `VOI_THRESHOLD`, …).
- Evidence carries a `loopIteration` tag; the gate increments `loopIteration` AFTER debate, so fresh
  evidence carries the current loop number during debate.
- Leave `gate.ts`'s `buildGatePrompt` TODO stub as-is (out of scope, per the human).

---

## Phase 2 — B2 + L1: kill zero-progress loops + incremental debate
**2a. New state channel** — `src/lib/schemas/state.ts`:
`newEvidenceCount: Annotation<number>({ reducer: (_p, next) => next, default: () => -1 })`
(-1 = no retrieve yet; replace-reducer, per-loop signal). In `graph.ts` retrieve node, **every**
return path sets it: early returns `{ newEvidenceCount: 0 }`, normal path `newEvidenceCount: evidence.length`.

**2b. Gate short-circuit (zero LLM cost)** — `src/lib/orchestration/gate.ts`, exported pure fn:
`gateShortCircuit(state): "budget" | "max-loops" | "no-progress" | null`.
"no-progress" when `loopIteration > 0 && newEvidenceCount === 0` (loop 0 exempt). Fold in the existing
budget/max-loop checks. `allocateBudget` calls it FIRST and returns a converged decision before any `generateText`.

**2c. Incremental debate** — `src/lib/orchestration/graph.ts`, exported pure fn (mirror `scopeEvidenceToQuestions` style):
`questionsNeedingDebate(questions, evidenceByQuestion, claims, currentLoop): Question[]` —
needs debate iff unresolved AND (no claims yet OR any scoped evidence has `loopIteration === currentLoop`).
In the debate node, filter with it; if empty → return `{}` (gate then short-circuits via `newEvidenceCount === 0`).

**2d. Committee: prior-claim context + evidence delta** — `src/lib/orchestration/committee.ts`:
- `runCommittee(question, evidence, priorClaims: Claim[] = [])`; debate node passes `state.claims.filter(c => c.questionId === q.id)`.
- Exported pure `splitEvidence(evidence, currentLoop): { fresh, prior }` (partition by loopIteration).
- Rework + **export** `buildUserPrompt`: loop-0/no-prior-claim → unchanged full evidence. Re-debate →
  full text for `fresh` only; `prior` rendered as an id-index (`[id] title — url — snippet` one-liners,
  ids stay citable); plus the same role's prior claim (conclusion/confidence/missingEvidence) with an
  instruction to UPDATE it against the new evidence. Keep `MAX_EVIDENCE_CHARS_PER_AGENT` cap on the fresh block.
- `graph-stream.ts`: the eager `debate:begin` currently sends all unresolved ids — mirror the graph:
  accumulate `allEvidence`/`allClaims` from node outputs and compute
  `questionsNeedingDebate(currentQuestions, scopeEvidenceToQuestions(...), allClaims, currentLoopIteration)`
  for the payload (both helpers pure + exported).

**Tests** (`test/orchestration/incremental-debate.test.ts` + gate tests):
never-debated in; fresh evidence in; stale-only+claimed out; resolved out. `splitEvidence` partitions by loop.
`buildUserPrompt` re-debate contains prior-claim block + id-index (not full prior content); loop-0 shape unchanged.
`gateShortCircuit`: `{loop:2, newEvidence:0}`→no-progress; loop-0→null; budget 0→budget.
Mocked: `allocateBudget` on a no-progress state returns `continueLoop:false` with `assertNoLlmCalls()`.

## Phase 3 — L2: per-question evidence digest (Haiku) — also fixes the gpt-4o TPM crash structurally
New `src/lib/orchestration/digest.ts`: types `DigestItem { evidenceId, summary }`, `QuestionDigest`;
`DigestOutputSchema` (zod, items `{ evidenceId: z.string(), summary: z.string().describe("<=400 chars: concrete facts, numbers, named entities, dates") }` — NO `.min()/.max()`);
pure `buildDigestPrompt(question, evidence)` (compress each source to one item keyed by its EXACT bracketed id; preserve numbers/names/quotes; flag off-topic);
pure `clampDigest(raw, validIds)` (drop invented ids, truncate to `MAX_DIGEST_SUMMARY_CHARS`, dedupe by id);
`digestEvidence(question, freshEvidence)` — one `generateText` on `digestModel`, `costTracker.check()/record()`,
`trace.logLlmCall("digest:"+q.id, …)`; **on throw return an empty digest** (caller falls back to raw evidence — a digest failure must never kill a run);
pure `formatDigestForCommittee(evidence, items)` (`[id] title (domain)` header + digest summary; snippet fallback for undigested ids).
Provider/params: `provider.ts` `export const digestModel = anthropic("claude-haiku-4-5-20251001")`;
`params.ts` `DIGEST_ENABLED = true`, `MAX_DIGEST_SUMMARY_CHARS = 400`.
State: `state.ts` `digests: Annotation<Record<string, DigestItem[]>>` with exported reducer `mergeDigests` (append per questionId).
Wiring: `graph.ts` debate node — before committee fan-out, `Promise.all` of `digestEvidence(q, freshOnly)` per
question needing debate (never re-digest old evidence; prior items come from `state.digests[q.id]`); pass digests
into `runCommittee`; return `{ digests }` delta. `committee.ts` evidence block = `formatDigestForCommittee(...)`
when digests provided, else raw `formatEvidence` fallback (digest failure or `DIGEST_ENABLED=false`).
SSE/UI: `research-events.ts` add `{ type: "debate:digest"; questionId; loopIteration; evidenceCount; usage }`
(`researchPhaseFor` → "debate"; exhaustive switch); `graph-stream.ts` emit `debate:digest` for usages whose label
starts with `digest:`; `useResearchStream.ts` handle the new event (trace-feed line; exhaustive reducer switch).
**Tests** (`test/orchestration/digest.test.ts`): `clampDigest` drops invented ids/truncates/dedupes;
`buildDigestPrompt` includes every evidence id exactly once; `formatDigestForCommittee` snippet fallback + every `[id]` present;
`mergeDigests` appends without dropping other questions; mocked `digestEvidence` happy path + throw→empty-digest fallback.

## Phase 4b — L3: committee restructure for cache hits (guarded)
`committee.ts`: pure `buildCommitteeMessages(role, question, evidenceBlock, currentLoop, priorClaim?)` returning AI SDK messages:
`system` = shared prefix (question + evidence/digest block + CONFIDENCE_CALIBRATION), **byte-identical across the 3
Claude roles**, with `providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } }`; `user` = role persona
(moved OUT of system) + task instructions. **Guard:** attach `cacheControl` only when prefix length > `PROMPT_CACHE_MIN_CHARS`
(`params.ts`, ~4500). **Stagger for hits:** run historian first (cache write), then operator + investor + skeptic in
`Promise.all`. Skeptic (OpenAI): no anthropic providerOptions; unchanged shape. (4a accounting already lands the cached-token math.)
**Tests:** identical prefix across the 3 Claude roles; `cacheControl` only above threshold; persona in the user message, absent from system.

## Phase 5 — L4 + L6: model mix + per-model concurrency limiter/retries
L4: `params.ts` `ROLE_MODEL_IDS` (current mix) + `REDEBATE_ROLE_MODEL_IDS` overriding historian/operator/investor →
`claude-haiku-4-5-20251001` for `loopIteration > 0`; skeptic gpt-4o everywhere. `provider.ts`
`modelForRole(role, loopIteration = 0)` resolves from params (all ids must exist in `MODEL_COST`). `committee.ts` passes
the loop iteration it already derives. (Model switch invalidates the Anthropic cache across loops — fine, re-debate prefixes are delta-sized.)
L6: new `src/lib/orchestration/limiter.ts` — `createLimiter(maxConcurrent)` FIFO promise semaphore (no deps) +
`limiterForModel(modelId)` map seeded from params. `params.ts` `MODEL_CONCURRENCY = { "gpt-4o": 2 }`, `LLM_MAX_RETRIES = 4`.
`committee.ts` wraps each role's `generateText` in `limiterForModel(model.modelId)(...)` + `maxRetries: LLM_MAX_RETRIES`.
Add `maxRetries` to the other call sites too: `gate.ts`, `graph.ts` decompose + refine, `digest.ts`.
**Tests** (`test/orchestration/limiter.test.ts`, pure w/ deferred promises): in-flight never exceeds N; FIFO; rejection
releases a slot. `modelForRole(role,0)` vs `(role,1)` → Sonnet vs Haiku for the 3 Claude roles; skeptic constant.

## When all four are done
Report the final `tsc`/`vitest` status and a per-phase commit list. Do NOT run live verification — hand the human the
plan's verification protocol (run-arm at `--budget=20`, inspect newest `trace-output/*.trace.json`, forced-failure at
`--budget=2`, UI check). Full plan reference lives with the human (the original overhaul plan doc).
