# Wave 3 brief — Real Committee Debate, Phases D0 → D6

> **STATUS (read first):**
> - **D0 is already implemented and committed** (branch `wave-3-debate`, commit `D0: debate schemas,
>   transcript channel, params`). Do NOT redo it — start at **D1**. Your base branch already contains
>   D0's schemas/state/params; treat them as fixed contracts and build on them.
> - **Scope this engagement is D1 → D5.** **D6 (streaming / UI / report / eval harness) is OUT OF
>   SCOPE** — it will be done separately later (there is parallel debate-arena UI work on another
>   branch). Do not touch `research-events.ts`, `graph-stream.ts`, `useResearchStream.ts`,
>   `AgentPanel.tsx`, or the report view. Stop after D5 with tsc/vitest green and report.

You are implementing Wave 3 on the Blindspot repo (adaptive multi-agent research system;
Next.js/TypeScript; LangGraph.js), building on the Wave 2 token-efficiency work
(now merged into `visualization`; your base branch is `wave-3-debate`). Read `CLAUDE.md` and
`STATUS.md` first.

**The point of this wave:** turn the committee from a *parallel poll of four independent claims*
into a *real debate* — agents read each other's positions and respond (rebut / concede / extend),
across rounds, until positions stop moving. A poll of four monologues doesn't earn four agents;
the synthesis-through-disagreement is the core product innovation. High-quality preserved
disagreement is a first-class output — far more informative than a false forced consensus.

## HARD CONSTRAINTS (violating any fails the task)
1. **NEVER run anything that spends API credits or makes live LLM/Firecrawl/Supabase network
   calls.** Do NOT run `scripts/run-arm.ts`, `scripts/compare-arms.ts`, `npm run compare`,
   `npm run dev`, or any live research. Verification is ONLY `npx tsc --noEmit` and `npx vitest run`.
   (The human runs all live/cost verification themselves.)
2. Repo design rules: NO `.min()/.max()` on any Zod schema passed to `generateText`/`Output.object`
   (providers strip them; steer with `.describe()`, clamp in code). NO made-up 0–1 "vibe" float
   scores — every debate signal (movement, consensus, contention type) is computed mechanically
   from REAL data the committee already produces (confidences, cited-id sets, response stances).
   Reporting on that current state is fine; casting qualitative→quantitative via an LLM is not.
   Enforce constraints in code, not prompts.
3. **Every round-count / threshold is a param in `params.ts`.** No magic numbers in logic.
4. **Preserve the L3 prompt cache.** The shared system prefix must stay byte-identical across the
   three Claude roles within a round. Anything per-role (directed challenges, a role's own prior
   turn) goes in the USER message. This is a hard invariant with a dedicated test.
5. Match surrounding code style/naming/comment density.

## Execution protocol
- Phases are a **strict sequential chain** (shared `claim.ts`/`state.ts`/`committee.ts`/`graph.ts`/
  `gate.ts`/`params.ts`, each consuming the prior's new symbols). Do them **in order**, one at a time.
- Per phase: implement → add the listed tests → `npx tsc --noEmit` clean → `npx vitest run` green →
  **commit** (message ending with the repo's Co-Authored-By trailer) → then **pause and report a
  short diff summary before starting the next phase.**
- Watch for cross-phase test breaks (a later phase changing a shape a prior test asserts).

---

## The architecture being built

**Two nested loops. Evidence is FROZEN during a debate; only the retrieval loop changes it.**

```
RETRIEVE ──► DIGEST ──► DEBATE ──► GATE ──► (REFINE ──► RETRIEVE) ──► …
                        └── inner debate loop lives entirely inside the DEBATE node ──┘
```

- **Debate loop (inner, NEW):** runs over a fixed evidence snapshot. Round 0 = today's independent
  opening claims (blind — preserves the historian-confabulation fix). Rounds 1..N = each role sees
  the full prior-round transcript + the challenges aimed at it, and revises (concede/hold). No
  Firecrawl, no budget spend, no new evidence mid-debate. Exits when positions stop moving
  (mechanical movement signal) or `MAX_DEBATE_ROUNDS`. Skips entirely on round-0 consensus.
- **Retrieval loop (outer, existing):** the ONLY thing that adds evidence. One `loopIteration` =
  retrieve → digest → debate-to-convergence → gate. Budget spent only here.

**Agents never fetch. Debate PRODUCES targeted evidence requests; the outer loop fulfils them under
budget.** A role that says "I'd concede X if we had a non-vendor source" produces a `missingEvidence`
gap on a contested claim → gate decides if it's worth budget → refine turns *contested* gaps into
queries → retrieve → next debate sees the new evidence.

**What crosses the retrieval boundary:** within a loop the full transcript is live context; across
loops only each role's FINAL claim survives (as its `priorClaim` seed via the existing B2/L1
incremental-debate path). Transcript resets each evidence snapshot; claims are the durable carrier.

**Marginal-utility shut-offs (enforced hard, both loops):**
- Debate exits on low round-over-round movement; hard cap `MAX_DEBATE_ROUNDS`; skip on consensus.
- Gate: a contention that names NO missing evidence is *interpretive* — retrieving is futile →
  resolve and report the disagreement. Only *evidential* contentions (a named gap that would settle
  it) + budget trigger retrieval. Plus the existing budget / MAX_LOOP / no-progress kills.

**Model mix (heavy models sparingly):** round 0 = Sonnet trio + gpt-4o skeptic. Rounds ≥1 (refinements,
declining marginal value) = Haiku trio; skeptic stays gpt-4o through `DEBATE_SKEPTIC_STRONG_ROUNDS`
then drops to gpt-4o-mini. Movement/contention detection is pure code = free. Moderator summary (if
enabled) = one Haiku call per question.

**Quality guard (anti-sycophancy):** three roles share Sonnet, so peer views induce agreement. Every
role is instructed to **concede only to evidence, never to consensus — if you move, cite the id that
moved you.** Skeptic stays cross-family. We MEASURE it: track flips that cite no new id.

---

## Grounding — current post-Wave-2 symbols (build on these, don't redo)
- `committee.ts`: `runCommittee(question, evidence, priorClaims=[], digestItems=[])`;
  `buildCommitteeMessages(role, question, evidenceBlock, currentLoop, priorClaim?)` (system = shared
  prefix w/ cacheControl guarded by `PROMPT_CACHE_MIN_CHARS`, user = persona + anchor + task);
  `splitEvidence(evidence, currentLoop)`; `ROLE_SYSTEM_PROMPTS`, `CONFIDENCE_CALIBRATION`, `ROLES`;
  staggered historian-first + `Promise.all` rest; each role wrapped in `limiterForModel(id)` + `maxRetries`.
- `claim.ts`: `ClaimSchema` (internal, has `.min/.max` — fine, not an LLM schema), `ClaimOutputSchema`
  (LLM output, no min/max), `AgentRole`/`AgentRoleT`.
- `state.ts`: `ResearchState` w/ `claims` (append), `digests` (+`mergeDigests`), `newEvidenceCount`,
  budget channels; `Question`.
- `gate.ts`: `allocateBudget(state)`, `gateShortCircuit(state)`.
- `graph.ts`: debate node (digests fresh evidence, runs `runCommittee`), `questionsNeedingDebate`,
  `scopeEvidenceToQuestions`, retrieve node sets `newEvidenceCount`, `synthesizeReport`.
- `provider.ts`: `modelForRole(role, loopIteration=0)` (resolves `ROLE_MODEL_IDS`/`REDEBATE_ROLE_MODEL_IDS`),
  `digestModel`.
- `limiter.ts`: `createLimiter(n)`, `limiterForModel(id)`; `eval.ts`: `toAnnotatedUsage`, `MODEL_COST`.
- `test/helpers/mock-ai.ts`: `fakeGenResult(output, usage?)`, `assertNoLlmCalls()`, hoisted `vi.mock("ai")`.

---

## Phase D0 — schemas, state channel, params (no behavior change)
`claim.ts`:
- `ResponseStance = z.enum(["rebut","concede","extend"])`; `DebateResponseSchema = z.object({
  targetRole: AgentRole, stance: ResponseStance, point: z.string().describe("one sentence: what you
  dispute/concede/extend and why — cite the evidence id that grounds it") })`; export types.
- `DebateTurnOutputSchema = ClaimOutputSchema.extend({ responses: z.array(DebateResponseSchema)
  .describe("your direct responses to the peers who challenged you — concede only to evidence") })`.
  (round-≥1 LLM output shape; NO min/max.)
- Extend `ClaimSchema` with `debateRound: z.number().int()` (0 = opening, ≥1 conversational) and
  `responses: z.array(DebateResponseSchema)` ([] for round 0). Update the single Claim constructor in
  `committee.ts` to set `debateRound: 0, responses: []` (behavior-neutral) and any Claim test fixtures.
`debate.ts` (NEW, types only this phase): `DebateRound { round: number; claims: Claim[] }`;
  `Contention { questionId: string; roles: [AgentRoleT, AgentRoleT]; type: "evidential"|"interpretive";
  note: string }`.
`state.ts`: exported `mergeTranscripts(prev, next)` = replace-per-questionId (`{...prev, ...next}` —
  transcript is ephemeral to one evidence snapshot); channel
  `debateTranscripts: Annotation<Record<string, DebateRound[]>>({ reducer: mergeTranscripts, default: () => ({}) })`.
`params.ts` (all thresholds live here): `MAX_DEBATE_ROUNDS=3`, `DEBATE_SKEPTIC_STRONG_ROUNDS=2`,
  `DEBATE_CONSENSUS_SPREAD=0.2`, `DEBATE_CONSENSUS_MIN_CONFIDENCE=0.6`, `DEBATE_CONFIDENCE_EPSILON=0.05`.
**Tests** (`test/schemas/debate.test.ts`): `DebateResponseSchema` rejects a bad stance; `DebateTurnOutputSchema`
parses a claim+responses (incl. empty responses) and carries no length caps; `ClaimSchema` round-trips a
round-0 claim (`debateRound:0, responses:[]`); `mergeTranscripts` replaces one question's rounds and leaves
others untouched.

## Phase D1 — pure debate logic (no LLM)
`debate.ts` pure fns, all TDD-first:
- `roundOneConsensus(claims, {spread, minConfidence}): boolean` — true iff no role has a non-empty
  `contradictingEvidenceIds`, confidence spread (max−min) < `DEBATE_CONSENSUS_SPREAD`, AND min
  confidence ≥ `DEBATE_CONSENSUS_MIN_CONFIDENCE` (genuine agreement, not shared uncertainty).
- `debateMovement(prev, next, epsilon): { moved: number; newRebuttals: number; converged: boolean }` —
  `moved` = # roles whose confidence moved > epsilon OR whose supporting/contradicting id-set changed;
  `newRebuttals` = # `(fromRole→targetRole, stance:"rebut")` pairs in `next` absent from `prev` (compare
  pair identity only — NEVER fuzzy-match `point` text); `converged = moved===0 && newRebuttals===0`.
- `directedChallenges(latestRound, role): DebateResponse[]` — all responses in the latest round whose
  `targetRole === role` (what this role must answer next).
- `renderTranscript(rounds): string` — compact `[role] (conf X): conclusion — support[ids]/contra[ids]`
  + `→ stance @target: point` lines; deterministic ordering (by round then `ROLES` order).
- `extractContentions(questionId, finalClaims): Contention[]` — a role pair is in contention when, in the
  final round, one `rebut`s the other with no matching `concede`, OR one lists an id in
  `contradictingEvidenceIds` that the other lists in `supportingEvidenceIds`. `type = "evidential"` if
  either contested claim names any `missingEvidence`, else `"interpretive"`.
**Tests** (`test/orchestration/debate-logic.test.ts`): consensus true/false cases (contradiction, wide
spread, low-confidence-agreement all → false); movement converged when nothing moves, non-converged on a
confidence jump / id-set change / fresh rebuttal; `directedChallenges` filters by target; `extractContentions`
classifies evidential vs interpretive and pairs the right roles.

## Phase D2 — debate message builder (cache-preserving)
`committee.ts`: `buildDebateMessages(role, question, evidenceBlock, transcript, priorTurn, currentLoop): ModelMessage[]`:
- **system** = shared prefix (question + evidence/digest block + `renderTranscript(priorRounds)` +
  `CONFIDENCE_CALIBRATION`), byte-identical across the 3 Claude roles, `cacheControl` guarded by
  `PROMPT_CACHE_MIN_CHARS` (skeptic/OpenAI gets none).
- **user** = persona + a "CHALLENGES AIMED AT YOU" block from `directedChallenges(latestRound, role)`
  ("[investor] disputes your position (rebut): <point>") + this role's prior turn + task: "respond to
  EACH challenge — concede (cite the id that moves you) or hold (cite why the evidence backs you); you
  may only concede to evidence, never to consensus. Then render your updated Claim and your `responses`."
**Tests** (`test/orchestration/debate-messages.test.ts`): transcript present in system and byte-identical
across the 3 Claude roles; directed challenges appear in the user message and NOT in system; skeptic carries
no anthropic providerOptions; `cacheControl` only above threshold.

## Phase D3 — model policy for debate rounds
`provider.ts`: `modelForDebateRound(role, debateRound)` — `debateRound===0` → `modelForRole(role, loopIteration)`
(unchanged opening); `debateRound≥1` → constructive roles `claude-haiku-4-5-20251001`; skeptic `gpt-4o`
while `debateRound <= DEBATE_SKEPTIC_STRONG_ROUNDS` else `gpt-4o-mini`. Every id must exist in `eval.ts`
`MODEL_COST` (add `gpt-4o-mini` if missing). Round 0 keeps the existing loop-aware mix via `modelForRole`.
**Tests** (extend `test/orchestration/*`): role×round → expected model id (constructive→Haiku at round 1;
skeptic gpt-4o at round ≤2, gpt-4o-mini at round 3); round 0 delegates to `modelForRole`.

## Phase D4 — `runDebate` orchestration (replaces the single committee pass)
`committee.ts`: `runDebate(question, evidence, priorClaims=[], digestItems=[]): { claims: Claim[]; rounds: DebateRound[]; usage: AnnotatedUsage[] }`:
1. **Round 0** — existing independent opening (reuse `runCommittee` internals / `buildCommitteeMessages`),
   `debateRound:0, responses:[]`, models via `modelForRole(role, loopIteration)`.
2. **Consensus fast-path** — `roundOneConsensus(round0)` → return round 0 only (no debate).
3. **Rounds 1..MAX_DEBATE_ROUNDS** — build `renderTranscript` of all prior rounds; per role
   `buildDebateMessages` + `generateText(Output.object({ schema: DebateTurnOutputSchema }))` via
   `limiterForModel(modelForDebateRound(role, r).modelId)` + `maxRetries`; **stagger historian first
   (cache write) then Promise.all rest** (identical to round 0, keeps caching); compute
   `debateMovement(prev, this)`, break on `converged`.
4. Return the FINAL round's claims (durable), the full `rounds` transcript, and all usages.
`graph.ts` debate node: after digesting fresh evidence, call `runDebate` (not `runCommittee`); return
`{ claims: finalClaims, debateTranscripts: { [q.id]: rounds }, digests }`.
**Tests** (`test/orchestration/run-debate.test.ts`, mocked via `mock-ai`): converges & stops early when a
round doesn't move; caps at `MAX_DEBATE_ROUNDS`; skips debate on round-0 consensus (only 4 calls); round-1
uses Haiku for constructive roles (assert model ids on the mocked call log); returns final-round claims +
full transcript. No live calls.

## Phase D5 — gate contention routing + graph/state/trace wiring
`gate.ts`: before the LLM gate, compute `extractContentions` per unresolved question from the transcript;
pure `contentionRoute(contentions): "retrieve" | "resolve" | null` — all-interpretive (or none) → resolve;
any evidential → let the existing gate LLM decide under budget. Fold the resolve short-circuit in beside
`gateShortCircuit` (zero LLM cost for resolved questions). Refine (`graph.ts`) draws queries from the
*contested* `missingEvidence` gaps. State: debate node already returns `debateTranscripts`. Trace: log each
`debate:round` (round, movement) and `debate:contentions` (per question); `final_state` gains debate stats
(rounds run, contentions evidential/interpretive counts, concessions).
**Tests**: `contentionRoute` interpretive-only→resolve, evidential→retrieve, empty→resolve; gate mocked on a
resolve state returns no-retrieve with `assertNoLlmCalls()` for that question.

## Phase D6 — streaming, UI, report, eval harness — ⛔ OUT OF SCOPE (do not implement this engagement)
_Kept here for reference only. It will be built separately (parallel arena-UI work exists). Your D5
trace logging uses `TraceLogger.log(...)` in `trace.ts` — that is in scope; the SSE `debate:round`
event below is NOT. Stop after D5._
`research-events.ts`: `debate:round` `{ questionId, round, turns: {role, conclusion, confidence, responses}[] }`
and `debate:contention` `{ questionId, roles, type, note }`; `researchPhaseFor` → "debate"; exhaustive switch.
`graph-stream.ts`: emit per round + contentions. `useResearchStream.ts`: reducer builds the conversation.
`AgentPanel.tsx`: render the DEBATE (turns, who-challenged-whom, concede/hold) not four static cards.
`ResearchReportView` / `synthesizeReport`: surface **unresolved contentions as a first-class question
outcome** ("committee could not agree — here's the fault line"), distinct from resolved.
`scripts/`: an eval harness casting poll-vs-debate over a transcript — concession rate, position-change
rate (round 0 → final), post-debate spread vs round-0 spread, contention counts, and flips-without-a-new-id
(sycophancy signal). Pure over a saved transcript; the human runs the live A/B.
**Tests**: reducer handles `debate:round`/`debate:contention` (exhaustive switch); harness metrics pure over a
fixture transcript.

## When D1–D5 are done (D6 is out of scope — stop here)
Report final `tsc`/`vitest` status + per-phase commit list. Do NOT run live verification — hand the human
the protocol: `run-arm --budget=50` on a contested topic (must exercise ≥1 debate round AND ≥1 second
retrieval loop), then inspect the newest `trace-output/*.trace.json` for the debate rounds, per-round
movement, and contentions logged via `TraceLogger`, and confirm the historian still cites evidence. UI
verification is deferred with D6.
