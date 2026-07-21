# Contributing to Blindspot

Thanks for considering a contribution. This project is licensed under
[Apache 2.0](LICENSE) — by submitting a change you agree it's contributed under those terms.

## Getting started

```bash
npm install
cp .env.local.example .env.local   # add your keys — see README's Quick Start
npm run dev
```

Read [README.md](README.md) first for the motivation and architecture, and
[CLAUDE.md](CLAUDE.md) for a file-by-file map of the codebase and the project's design
principles. Both are kept accurate on purpose — if you find them stale, that's a bug worth a PR
on its own.

## Before opening a PR

Zero-cost checks (no API spend) — these must pass:

```bash
npx tsc --noEmit
npx vitest run
```

If your change touches retrieval, the committee, or the gate, a live run is the real functional
test (spends a small amount of API credit):

```bash
npm run run-arm agentic "freight brokerage"
```

Add or update unit tests for any new pure logic — most of the interesting behavior in this
codebase (`debate.ts`, `gate.ts`'s routing, `board.ts`'s cell derivation) is deliberately
pure and cheaply testable without hitting a model.

## Design principles

These aren't style preferences — they're the reason the system is auditable and cheap to run.
Changes that violate them will get pushed back in review:

- **Enforce in code, not prompts.** If a constraint can be checked or clamped programmatically,
  do it — don't rely on an LLM obeying an instruction. Budget caps, enum membership, ID
  validation, range clamping: all code, never a prompt hint alone.
- **No hard caps in LLM output schemas.** Never put `.min()`/`.max()` on a Zod schema passed to
  `generateText`/`Output.object` — providers strip unsupported JSON-schema keywords, so the model
  never sees the limit, and a slightly-long response turns into a run-killing error. Steer with
  `.describe()` hints; clamp in code after generation where the bound actually matters.
- **No vibe floats.** Don't ask an LLM for a made-up 0–1 score (confidence, tractability,
  sensitivity) and then do math on it — the precision is fake. Prefer binary/categorical
  decisions from the model and compute quantitative signals from real data (gap counts,
  confidence spreads, evidence counts, cited-id sets).
- **One file owns each concern.** Prompt wording lives in `prompts.ts`, committee persona +
  model assignment lives in `roles.ts`, pricing lives in `pricing.ts`, tunables live in
  `params.ts`/`evidence/config.ts`. Don't reintroduce an inline prompt string, model id, or
  pricing number in an orchestration node — import it from the file that owns it. Prompt/config
  transparency is a product requirement here, not a nice-to-have.
- **Provider-agnostic call sites.** Search and scrape go through `evidence/provider.ts`; a call
  site should never import a specific vendor's module (`firecrawl.ts`/`exa.ts`) directly.

## Reporting issues

Open a GitHub issue with what you ran, what you expected, and — if the run completed — the
`trace-output/*.trace.json` file it produced (traces are gitignored and can be large; only
attach the relevant excerpt if it's big). For a live-run bug, the trace's `final_state` and
`gate:converged` entries usually pinpoint the failure faster than a description alone.
