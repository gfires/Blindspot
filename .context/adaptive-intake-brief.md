# Wave 4 brief — Adaptive Intake, Phases A1 → A5

> **STATUS (read first):**
> - Wave 3 (real committee debate, D1–D5) is merged/branch `visualization-v1`. This wave builds on it.
> - **Scope is A1 → A5.** Any UI work (rendering the objective/answer, a multiline input, relabeling
>   the "Industry Scan"/"Deep Research" toggle) is OUT OF SCOPE — same boundary as D6. Backend only.
> - Verification is `npx tsc --noEmit` and `npx vitest run` ONLY. No live/paid runs (the human does those).

## The point of this wave

Make the pipeline **input-structure-agnostic**. Today it silently assumes one shape — *broad industry,
open survey* — and imposes it on every input. We want one pipeline that reads the shape of whatever came
in (broad industry · sharper niche · specific thesis · investment decision · anything in that realm) and
adapts its **decomposition** and **synthesis altitude** to it, while running the *same* committee, debate,
gate, and retrieval machinery underneath.

The input varies on two axes: **breadth** (industry → niche → single question) and **posture** (open
survey → pointed decision). The fix is to stop hardcoding one point on both axes at the three seams that
currently do:
1. `decompose` (`graph.ts`) — a fixed facet list ("market, customers, competition, economics, risks").
2. committee personas (`committee.ts`) — every role framed "evaluating a business opportunity", and the
   roles never see *what was actually asked*, only the decomposed question.
3. `synthesizeReport` (`graph.ts`) — a generic per-question rollup, same output shape regardless of ask.

## HARD CONSTRAINTS (violating any fails the task)

1. **Committee nature is INVARIANT.** The four roles and their opinionated incentives (Historian→precedent,
   Operator→friction, Investor→returns, Skeptic→failure), the debate mechanics, the gate/contention routing,
   and the evidence retrieval loop are UNCHANGED. We add versatility at intake and synthesis ONLY. Threading
   the objective into the committee is **added context that points the existing roles at the real ask** — it
   must NOT rewrite a persona or soften a role's incentive. If a change would turn this into a general-purpose
   research agent or dilute the business-opportunity lens, it is out of scope. This is the whole balance.
2. **Bare-phrase input must behave as today.** "freight brokerage" is one point in the input space, not a
   special case — it flows through the same new code path and yields an industry-survey brief that decomposes
   and synthesizes essentially as it does now. A regression here fails the task; it has a dedicated test.
3. **No live/paid calls.** tsc + vitest only.
4. **No `.min()/.max()` on any LLM output schema** (`ResearchBriefSchema`, the synthesis schema) — providers
   strip them and they crash generation. Steer with `.describe()`, clamp in code.
5. **No vibe floats, no rigid taxonomy.** `objective` and `answer` are real LLM-inferred *text*, never a
   made-up 0–1 score. Do NOT introduce an `intent`/`posture` enum unless code actually branches on it — an
   enum just moves the hardcoding we are removing. (Current design branches on nothing, so: no enum.)
6. **Preserve the L3 prompt cache.** The objective added to the committee's shared system prefix is
   topic-level and identical across the three Claude roles, so the byte-identical-across-roles invariant
   still holds. Dedicated test.
7. Every new threshold / model id is a param (`params.ts`) or a provider export. Match surrounding style.

## Execution protocol

- Strict sequential chain (schema → state → intake node → decompose → committee → synthesis), each phase
  consuming the prior's symbols. Do them in order, one at a time.
- Per phase: implement → add the listed tests → `npx tsc --noEmit` clean → `npx vitest run` green → commit
  (Co-Authored-By trailer) → pause and report a short diff summary before the next phase.
- Watch for cross-phase test breaks (a later phase changing a shape a prior test asserts).

---

## The architecture

One extra node at the front and one string threaded through three consumers. No branching on input type.

```
START ─► INTAKE ─► DECOMPOSE ─► RETRIEVE ─► DIGEST ─► DEBATE ─► GATE ─► (REFINE ─► …) ─► RECOMMEND ─► END
          │            │                                 │                                  │
          └─ emits ResearchBrief ──────────────────────────────────── objective threads to ┘
             { subject, objective, constraints[] }        committee prefix + synthesis
```

**`ResearchBrief`** — small, general, empty-friendly. Free-form, `.describe()`-steered, no enum:
- `subject: string` — the entity/space under study (what to search about).
- `objective: string` — one statement of *what output would satisfy this input* (a coverage map, a
  comparison, a go/no-go, a verdict). This is the load-bearing field; everything downstream reads it.
- `constraints: string[]` — explicit scope boundaries / requirements / decision criteria stated in the
  input. Empty for a bare phrase. Clamp count in code.

For "freight brokerage": `subject≈"freight brokerage"`, `objective≈"survey the opportunity landscape…"`,
`constraints=[]` — and the run behaves as today. For a thesis paragraph: subject/objective/constraints are
the extracted ask. **One code path, both ends of the spectrum.**

---

## Phase A1 — ResearchBrief schema + state channel (no behavior change)

`src/lib/schemas/brief.ts` (NEW): `ResearchBriefSchema` (LLM output shape — `subject`, `objective`,
`constraints: z.array(z.string())`, all `.describe()`-steered, NO min/max) and `ResearchBrief` type. Provide
`EMPTY_BRIEF` / a `fallbackBrief(topic)` helper = `{ subject: topic, objective: "Assess the opportunity in "+topic, constraints: [] }`
(the degrade path when intake fails — a run must never die on a bad brief).
`state.ts`: add channel `researchBrief: Annotation<ResearchBrief>({ reducer: (_prev, next) => next, default: () => fallbackBrief("") })`
(manager owns full replacement, like `questions`).
**Tests** (`test/schemas/brief.test.ts`): schema parses a full brief and one with empty constraints; carries
no length caps (long objective / many constraints still parse); `fallbackBrief` shape; state reducer replaces.

## Phase A2 — intake node (topic → ResearchBrief)

`graph.ts`: new `intake` node — ONE manager LLM call (`managerModel`, Haiku) that reads `state.topic` and
emits a `ResearchBrief`. The prompt keeps the **product mandate** (this is opportunity/market analysis, not
open-ended research): infer the subject, state the objective in the product's terms, and pull out any
constraints/criteria the input stated. A bare phrase yields a survey objective + empty constraints; a thesis
yields the extracted ask. On failure, return `fallbackBrief(topic)` (never throw — mirror digest's degrade).
Clamp `constraints` length in code. Wire `START → intake → decompose` (was `START → decompose`); update
`computeRecursionLimit` if the fixed-superstep count changes. Trace `intake` (the brief). Route/run-arm pass
`topic.trim()` unchanged.
**Tests** (`test/orchestration/intake.test.ts`, mocked via `mock-ai`): bare phrase → survey-shaped brief with
empty constraints; a thesis input → objective + constraints populated (assert the node returns them in
`researchBrief`); a thrown LLM error → `fallbackBrief` (run survives, `assert` no throw).

## Phase A3 — objective-driven decompose

`graph.ts` `decompose`: consume `state.researchBrief` instead of the hardcoded facet list. The prompt is
rewritten to "generate the 3–5 questions whose answers would satisfy the OBJECTIVE, respecting the
CONSTRAINTS", staying opinionated toward actionable market/opportunity analysis (do NOT go generic). The
generic facets survive only as a fallback hint for a bare survey objective, so **bare-phrase decomposition is
unchanged in spirit** (regression guard). `MAX_QUESTIONS` still clamps count in code.
**Tests** (extend `test/orchestration/*` decompose coverage, mocked): decompose prompt includes the objective
and constraints; a decision-shaped objective is passed through to the manager (assert prompt text); a
bare-phrase brief still drives industry-coverage questions (the run shape matches today).

## Phase A4 — thread the objective into the committee (cache-preserving)

`committee.ts`: `buildCommitteeMessages` and `buildDebateMessages` gain an `objective` param and prepend a
short **"RESEARCH OBJECTIVE"** block to the SHARED system prefix (topic-level, identical across the 3 Claude
roles — the L3 invariant holds). `runCommittee` / `runDebate` accept the objective and pass it through; the
`debate` node reads `state.researchBrief.objective`. **Role personas (`ROLE_SYSTEM_PROMPTS`) are byte-for-byte
UNCHANGED** — the objective is context that points the existing roles at the real ask (the skeptic can now
attack the actual bet), not a redefinition. cacheControl guard and skeptic-no-anthropic-options unchanged.
**Tests** (extend `test/orchestration/committee-messages.test.ts` + `debate-messages.test.ts`): objective
appears in the system prefix and is byte-identical across historian/operator/investor; personas still live in
the user message and are unchanged; skeptic carries no anthropic providerOptions; cacheControl only above
threshold. Add a guard test asserting `ROLE_SYSTEM_PROMPTS` text is untouched.

## Phase A5 — objective-level synthesis (adaptive altitude)

`graph.ts`: `synthesizeReport` STAYS pure (structural report). The `recommend` node gains an `answerObjective`
step — ONE LLM call (`gateModel`/Sonnet for quality; a param) grounded STRICTLY in the per-question claims and
the surviving contentions already in state (NO new evidence, NO new retrieval) — that writes a natural-language
`answer` at the objective's altitude: a landscape map for a survey, a graded go/no-go + the fault lines for a
decision, and an explicit "committee split here (evidential/interpretive)" when contentions survived. Degrades
to the pure rollup on failure (never kill a run). `ResearchReport` gains `objective: string` and `answer: string`.
Trace `synthesis:answer`; `final_state` notes whether an answer was produced.
**Tests** (`test/orchestration/synthesis.test.ts`, mocked): `answer` generated from claims + contentions and
attached with the objective; a thrown LLM error falls back to the pure report (answer empty, run survives);
`synthesizeReport` remains pure (no LLM) — `assertNoLlmCalls()` against it directly.

## When A1–A5 are done

Report tsc/vitest status + per-phase commit list. Hand the human the live protocol: run-arm on (a) a bare
phrase — confirm the brief is survey-shaped and the report matches today; (b) a thesis paragraph — confirm the
objective/constraints are extracted, the questions serve the ask, the committee prefix carries the objective,
and the `answer` adjudicates the bet (verdict + fault lines). Inspect the newest trace for `intake`,
`synthesis:answer`, and that the committee personas + debate behavior are unchanged. UI (rendering the answer,
multiline input, toggle relabel) is deferred.
```
