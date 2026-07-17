# Spec — Debate only genuine disagreement; route agreement to action

**Status:** reviewed + locked (2026-07-15). Self-contained: a fresh orchestrator can execute this
without prior conversation. Build order is **A → B → C**, one phase at a time, **tests-first**, with a
`npx tsc --noEmit` + `npx vitest run` + commit gate between phases.

Baseline before you start: `tsc` clean, **337 vitest tests green**. Do not regress either.

---

## 0. Context (read once)

Blindspot is an adaptive multi-agent research system (Next.js/TypeScript, LangGraph.js). A manager
decomposes a topic into 3–4 questions; for each unresolved question a **committee** of four
persona-roles (Historian, Operator, Investor on Claude Sonnet 5; Skeptic on GPT-4o) holds a **real
debate** over a **frozen evidence snapshot**: round 0 is the independent **blind** opening (each role
renders one Claim without seeing the others — so cross-role agreement is real signal), then, *if the
openings disagree*, the roles read the transcript and revise across conversational rounds until
positions stop moving. A VOI **gate** then routes surviving disagreements (interpretive → reported as a
fault line; evidential/named-gap → more retrieval) and loops retrieve→debate→gate until convergence or
budget. Retrieval is agentic (one Haiku researcher agent per question); the committee is **not** agentic
and the frozen snapshot is the core innovation — do not touch either.

Full system reference: `CLAUDE.md`, `STATUS.md`, `README.md`. Design principles you MUST hold
(`CLAUDE.md`): **enforce in code not prompts**; **no `.min()`/`.max()` on any Zod schema passed to an
LLM** (providers strip them → run-killing validation errors; steer with `.describe()`, clamp in code);
**no vibe floats** (no made-up 0–1 scores; compute from real signals); **all prompt WORDING lives in
`src/lib/prompts.ts`**; disregard dev time — pick the most correct/elegant solution.

### Why this change (the finding that motivates it)

A live agentic run cost ~$0.75 (hit the LLM cap). Cost breakdown showed **deliberation
(committee + debate) = ~76% of spend**, and reading the transcript revealed the crux: **much of the
debate resolved nothing.** Example — question q1 ("market size / TAM"): all four roles independently
concluded "no data, can't assess" at confidence 0.10–0.35, and we ran a 4-role, multi-round Sonnet
debate over **two loops** to produce four restatements of "there's no TAM in the sources." The stance
mix across the run was ~29 "extend" vs 8 "rebut" — mostly co-signing, not resolving. Value was
concentrated in the ~2 questions with genuine disagreement (q3/q4, which became the answer's fault
lines). **We were paying full committee price to debate questions where the roles already agreed.**

The product principle this enforces: **the committee debates to resolve disagreement; agreement is a
trigger to ACT, not a dead end.** If the roles agree they need more data, the system is empowered to go
get it (retrieve); if that data proves unfindable, it's noted as a limitation, not chased forever.

### Why confidence spread can't detect disagreement (justifies the `stance` field)

In the same run, q4's roles split by **direction** (Historian `supports` at 0.48; Investor/Skeptic
`oppose` at 0.42/0.32) at *near-identical confidence*. A confidence-spread heuristic would wrongly skip
q4 — a genuine fault line. So disagreement must be detected from an explicit **position (stance)**, not
from confidence.

### Extensibility tenet (locked)

A "stance" is a role's **position** on the question. Today's committee is a thesis-adjudicator *by
construction* (each Claim is a position + confidence on the opportunity), so a categorical stance just
makes explicit the lean the roles already hold. **Write the disagreement detector over positions
generally** (≥2 distinct decisive positions), so a future richer taxonomy only grows the enum — the
detector and gate need no change. The 3-value enum below is the opportunity-analysis *instantiation*,
not a hardcoded binary.

---

## 1. Current architecture this touches (file : function pointers)

- `src/lib/schemas/claim.ts` — `ClaimOutputSchema` (the fields the LLM emits) and `Claim` (adds
  system-owned fields `id`/`questionId`/`agentRole`/`loopIteration` in code). Also `DebateResponse` /
  `DebateTurnOutput` (`stance` here is the debate-turn rebut/concede/extend — **different** from the new
  claim stance; don't confuse them).
- `src/lib/orchestration/committee.ts` — `runCommittee()` (blind round-0 opening), `runDebate()`
  (round 0 → `roundOneConsensus` fast-path → conversational rounds → movement stop → returns final-round
  claims + transcript), and the spot where a parsed LLM output becomes a `Claim`.
- `src/lib/orchestration/debate.ts` — pure logic: `roundOneConsensus`, `debateMovement`,
  `extractContentions` (note its internal **`idClash`** — supporting∩contradicting evidence-id overlap
  between two roles — works on blind round-0 claims because it needs no debate responses),
  `contentionRoute`, `renderTranscript`. `Contention` type (`type: "evidential" | "interpretive"`).
- `src/lib/orchestration/gate.ts` — `allocateBudget()` (contention routing at zero LLM cost +
  LLM VOI classifier scoring on `gapCount`/`confidenceSpread`), `gateShortCircuit()`
  (budget / max-loops / no-progress / cost-headroom), and **`diminishingReturns`** (compares a
  question's latest loop: confidence rise ≤ `LOOP_CONFIDENCE_EPSILON` AND named-gap count not reduced).
- `src/lib/orchestration/graph.ts` — `debate` node, `gate` node, `routeAfterGate`, the retrieve→debate→
  gate loop. `missionForQuestion` builds each researcher's loop-≥1 mission from contested gaps.
- `src/lib/orchestration/mechanics.ts` — `computeRunMechanics(entries, state, tokens)` +
  `formatMechanicsReport` (the per-run report printed by `scripts/run-arm.ts` / `compare-arms.ts` and
  stored on `ArmResult.mechanics`). `deliberation` section currently reports rounds/moves/
  concessions/contentions/stanceMix/confidence.
- `src/lib/prompts.ts` — committee opening + debate prompt builders, `ROLE_SYSTEM_PROMPTS`,
  `CONFIDENCE_CALIBRATION`. All wording lives here.
- `src/lib/params.ts` — `DEBATE_CONSENSUS_*`, `LOOP_CONFIDENCE_EPSILON`, loop/budget knobs.

Test harnesses to reuse: `test/orchestration/debate-logic.test.ts`, `run-debate.test.ts`,
`committee-*.test.ts`, `gate.test.ts`, `diminishing-returns.test.ts`, `mechanics.test.ts`,
`graph.test.ts`, and `test/helpers/mock-ai.ts` (the `vi.mock("ai", …)` + `fakeGenResult` pattern for
node-level tests that would otherwise call an LLM). Prior vitest learning: **brace any `beforeEach`
body that calls `mockReset()`** (an arrow returning the mock misbehaves).

---

## 2. Locked decisions

1. **Stance values:** `"supports" | "opposes" | "insufficient"` — the opportunity-analysis instantiation
   of a general "position". Abstention value = `"insufficient"`. Extensible: the detector must not
   hardwire the binary.
2. **Round-running decision is FULLY replaced:** `hasGenuineDisagreement(round0Claims)` supersedes
   `roundOneConsensus` as the decision to run conversational rounds. Delete `roundOneConsensus` from the
   decision path; remove it entirely if nothing else references it.
3. **`supports+insufficient` and `opposes+insufficient` both collapse to overall `"insufficient"`** —
   one-sided lean with any abstention is "not enough to call". Only a *unanimous decisive* lean with **no
   abstention** is a confident answer.
4. **Structural-exit patience = 1:** an `insufficient` question with a named gap always retrieves on
   first encounter (always try once); **one** loop of no progress (`diminishingReturns` true) →
   declare the gap unfindable → resolve as a noted limitation. Never chase a third time.
5. **Frozen snapshot + blind round-0 opening are untouched.** Only conversational rounds (1+) are gated.

---

## 3. Phase A — stance + skip rounds when there's no genuine disagreement

**Files:** `schemas/claim.ts`, `prompts.ts`, `committee.ts`, `debate.ts`.

- **`claim.ts`:** add `stance: z.enum(["supports","opposes","insufficient"]).describe("your lean on the
  OPPORTUNITY based on THIS question's evidence: 'supports' = evidence points toward the opportunity
  being real/attractive, 'opposes' = points against it, 'insufficient' = evidence can't support a
  directional call yet")` to `ClaimOutputSchema`, and `stance` to the `Claim` type. Document it as the
  opportunity instantiation of a general position.
- **`committee.ts`:** thread the LLM's `stance` onto the assembled `Claim`, clamping in code
  (missing/invalid → `"insufficient"`). No schema min/max.
- **`prompts.ts`:** committee-opening + debate prompts instruct the role to state its stance. Wording
  here only.
- **`debate.ts`** — three pure, exported, unit-tested helpers, written generally:
  - `decisiveStances(claims)` → `Set<string>` of stances present **excluding** the abstention value
    `"insufficient"`.
  - `hasGenuineDisagreement(claims)` → **`decisiveStances(claims).size >= 2` OR an `idClash`** exists
    among the claims (extract/reuse the `idClash` sub-logic from `extractContentions`). *For the current
    enum this equals "supports and opposes both present"; an N-way enum needs no edit.*
  - `committeeStance(claims)` → `"contested" | "supports" | "opposes" | "insufficient"`:
    `decisiveStances.size >= 2` → `"contested"`; else if any claim is `"insufficient"` →
    `"insufficient"`; else the single decisive stance; else (`empty`) `"insufficient"`.
- **`committee.ts` `runDebate`:** the decision to run conversational rounds is now
  `hasGenuineDisagreement(round0Claims)`. No disagreement → return the round-0 claims as final with a
  single-round transcript (exactly as the old consensus fast-path returned). Preserve: blind opening,
  historian-first stagger (L3 cache), in-round movement-based early stop, returned shape.

**Do NOT** touch the gate, `graph.ts` routing, `mechanics.ts`, or round-0's blind opening in Phase A.

**Tests-first (write, watch fail, then implement):**
- `decisiveStances` / `hasGenuineDisagreement` / `committeeStance` truth tables, including:
  `{supports,opposes,insufficient,insufficient}` → disagreement + `"contested"`;
  `{supports,supports,insufficient,insufficient}` → no disagreement + `"insufficient"` (decision 3);
  `{opposes,insufficient,…}` → `"insufficient"`; `{supports,supports,supports,supports}` → `"supports"`;
  all-`insufficient` → no disagreement + `"insufficient"`; an id-clash with agreeing stances → still
  disagreement; **a synthetic 4-value stance set with ≥2 decisive → disagreement** (proves generality).
- `runDebate` (reuse the run-debate mock harness): agreeing round-0 openings → conversational rounds
  SKIPPED (assert the model isn't called for rounds); a `supports`+`opposes` split → rounds RUN.
- `claim`/`committee`: a parsed output with missing/invalid `stance` clamps to `"insufficient"`; a valid
  stance flows onto the `Claim`.
- Update existing debate/committee/consensus tests that now need a `stance` on synthetic claims.

---

## 4. Phase B — route the skipped questions (where "go get it" lives)

**Files:** `gate.ts` (primary), `graph.ts` (only if the retrieve-list plumbing needs it).

**Problem:** a skipped (agreeing) question has no debate responses → `extractContentions` = 0 → today's
`contentionRoute` would **resolve** it, silently turning "agree → go get it" into "agree → give up."
The gate must route on `committeeStance` + the named gap, per unresolved question:

| `committeeStance` | condition | route |
|---|---|---|
| `contested` | (debated) | existing routing: interpretive → resolve + report fault line; evidential → retrieve under budget |
| `supports` / `opposes` | unanimous, no abstention → confident answer | **resolve** (settled) |
| `insufficient` | has a named gap, **no failed retrieval attempt yet** (not `diminishingReturns`) | **retrieve** (go get it) |
| `insufficient` | named gap **survived one retrieval loop with no progress** (`diminishingReturns` true) | **structural → resolve + note as limitation** |
| `insufficient` | no named gap | resolve (nothing to fetch) |

- **Patience = 1** via the existing `diminishingReturns` (`LOOP_CONFIDENCE_EPSILON`): first encounter
  always retrieves; one no-progress loop → structural → resolve. On loop 0 there is no prior loop, so
  `diminishingReturns` is false → always try once.
- Keep `retrieve` the sole budget writer; the gate writes no budget delta. Respect the existing
  `gateShortCircuit` stops (budget / max-loops / no-progress / cost-headroom) and the affordability
  guard.
- The zero-LLM-cost contention routing stays for genuinely `contested` questions; the LLM VOI classifier
  still scores questions that reach it.

**Tests-first:**
- skipped `insufficient` + fresh named gap (loop 0) → routed to **retrieve**;
- same gap unimproved after one loop (`diminishingReturns` true) → **resolve** (structural, noted);
- unanimous `supports` (no gap) → **resolve**;
- `contested` interpretive split → resolve + reported as fault line;
- **regression: a coded-arm run's routing is byte-unchanged** (the coded path doesn't skip debates the
  same way — verify its gate decisions don't drift).

---

## 5. Phase C — make wasted debate impossible to hide (harness)

**Files:** `mechanics.ts`, its test.

Extend `RunMechanics.deliberation` with:
- `questionsDebated` vs `questionsSkipped` (rounds ran vs skipped on agreement), with the
  `committeeStance` breakdown of the skipped (e.g. how many `insufficient`→retrieve vs agreed-answer).
- `productiveQuestions` = debated **and** (a role's `stance` changed between its round-0 and final claim,
  OR a contention was resolved). Purely mechanical — no invented score.

`formatMechanicsReport` prints, e.g.:
`debated 2 · skipped 2 (1 insufficient→retrieve, 1 agreed)` and flags `⚠ debated but unanimous` when
rounds ran yet no stance moved and no contention resolved.

**Tests-first:** over synthetic `entries`+`state` fixtures assert the skipped/debated/productive counts
and the ⚠ flag; empty inputs don't throw.

---

## 6. Sequencing, gates, build & check

Sequential **A → B → C** (they thread debate → gate → report and share those files — no safe parallel
split). After each phase: `npx tsc --noEmit` clean, `npx vitest run` green (count only goes up), then
**commit** before starting the next.

```
npx tsc --noEmit        # typecheck — must stay clean
npx vitest run          # tests — must stay green (337 baseline)
```

`tsc` + `vitest` are the only zero-cost checks. Paid/live verification (the human runs it):

```
npm run run-arm -- agentic "software for freight brokerage vendor management and verification"
```

After this change, that run should show (in the printed RUN MECHANICS): q1-style questions **skipped**
(no rounds), deliberation cost down, `debated N · skipped M` with no `⚠ debated but unanimous`, and the
answer quality unchanged (the fault lines come from the genuinely-contested questions).

## 7. Do NOT

- Do not give committee roles tools or break the frozen snapshot / blind round-0 opening.
- Do not add `.min()`/`.max()` to any LLM-output Zod schema (`stance` is a bare `z.enum` — fine).
- Do not hardwire the binary supports/opposes into the disagreement detector — keep it position-general.
- Do not put prompt wording anywhere but `prompts.ts`.
- Do not change the coded (`retrievalMode:"coded"`) arm's behavior — it's the permanent eval control.
