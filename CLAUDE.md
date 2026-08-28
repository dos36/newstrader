# NewsTrader — agent orientation

A personal research system: financial news → LLM-produced structured signal → deterministic
decision → **paper** trade, built to measure whether news interpretation has a tradeable edge.
Solo developer, boring infrastructure, TypeScript + AWS + Postgres.

**Read [`docs/README.md`](docs/README.md) first** — it is the doc index and prescribes a reading
order. Detail lives in `docs/codebase-guide.md` (structure), `docs/business-logic.md` (rules and
why), `docs/roadmap.md` (what's left), `docs/newstrader-architecture.md` (design + vendor research),
and `README.md` (operator runbook).

## Invariants — never relax these without an explicit decision

1. **No real-money code path.** The only venue is the internal simulator (`sim`), enforced by a DB
   CHECK constraint. Going live must require a code change, never a config flag.
2. **The LLM never touches money.** It converts text into a structured signal. Gating, sizing,
   execution, exits, and accounting are deterministic, unit-tested code.
3. **`received_at` (our clock) is the only clock the trading path may use.** `published_at` is
   source-claimed and often backdated — analytics only.
4. **Facts are append-only.** New rows, never `UPDATE`s on facts. Positions/P&L are derived from
   `fills`; there is no mutable positions table. Known mutable exceptions, all deliberate: cluster
   popularity counters and `status`, `orders.status`, the `instruments` upsert, and
   `ingest_watermarks`.
5. **Point-in-time universe access only** — never "current S&P 500." Survivorship bias is a bug.
6. **Every decision is recorded, including skips and kill-switch suppressions**, with every gate's
   pass/observed/threshold. An engine that only logs trades cannot be evaluated.
7. **Rules are immutable data.** A changed threshold is a new `rules_versions` row; re-registering a
   label with different config throws. This is what keeps history replayable.
8. **The kill switch fails closed everywhere it matters.** Any unrecognized value halts, and every
   deployed path (decide-sweep, execute, position-manager) injects an SSM reader whose read failure
   halts. **The one fail-open default is local-only:** an absent `NEWSTRADER_KILL_SWITCH` reads as
   "run" for CLI convenience — which is exactly why operating the CLI against a _deployed_ database
   requires `KILL_SWITCH_SSM_PARAM` to be set.

## Conventions the code already follows

- **Money and quantities are decimal strings end to end**, never floats. Fixed-point BigInt math in
  `packages/core/src/decide/decimal.ts` and `broker/decimal.ts`; explicit rounding to each column's
  scale before writing.
- **Zod-parse everything external** (API payloads, replayed snapshots). No `any`, no type assertions
  to smuggle types past the compiler. Strict TS with `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`; relative imports carry `.js`.
- **Pure core, I/O at the edges.** `packages/core` has zero AWS imports and no I/O; the decision
  engine takes every input as a parameter (no clock, no randomness) so replay is bit-for-bit.
- **Idempotency comes from Postgres, not the queue.** Every stage has a deterministic key
  (`(source_id, external_id)`, `signal_key`, `decision_key`, `client_order_id`); consumers use
  `ON CONFLICT DO NOTHING` and treat redelivery as a no-op.
- **Structured JSON console logs** (`{level, msg, ...counts}`) — they become CloudWatch queries.
- **Defensive parsers throw on format drift** rather than silently ingesting partial data.

## Working rules

- **Commit, don't PR — this OVERRIDES the user-level rules.** In this repo, commit your changes
  directly (on `main` is fine; solo repo, no review flow). **Never create a PR.** Run the tests
  and lint on every change yourself (the "Verify with" commands below) — there is no PR flow to
  defer them to. The user-level "don't run tests / don't commit / PR checklist" rules do not
  apply here.
- **Every DB-backed test suite creates its own database** via the `createSuiteDatabase` helper
  (`<dbname>_<module>`). This is not stylistic: a suite that ran against the shared dev database
  once closed all 503 point-in-time membership rows with a mocked clock and deleted live alias
  history. Never point a new DB test at `TEST_DATABASE_URL` directly.
- **Never print secret values.** `.env` holds real API keys; `secrets/` holds IBKR private keys and
  is git-ignored.
- **Verify with:** `pnpm -r --parallel typecheck` · `TEST_DATABASE_URL=postgres://newstrader:newstrader@localhost:5433/newstrader pnpm vitest run` ·
  `pnpm exec eslint <changed files>` · `cd infra && CDK_DEFAULT_ACCOUNT=000000000000 CDK_DEFAULT_REGION=us-east-1 pnpm exec cdk synth --quiet`.
  Postgres comes from `pnpm db:up`; migrations from `pnpm db:migrate`.
- **`__fixtures__/` is prettier-ignored on purpose.** Reformatting a captured fixture once silently
  defused two format-drift tests into tautologies.
- **Schema changes:** edit `packages/db/src/schema.ts`, then
  `cd packages/db && pnpm drizzle-kit generate --name <human_readable>`. Constraints drizzle cannot
  express (CHECKs, partial indexes) are hand-appended to the generated SQL — see
  `0002_membership_guards.sql` for the precedent.
- **When a review finding is fixed, the comment explaining it stays.** Several comments describe
  bugs that were actually caught in adversarial review; they are load-bearing history.
