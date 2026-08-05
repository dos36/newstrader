# NewsTrader — Codebase Guide

_Verified against the tree on 2026-07-24 (581 tests across 49 files passing; 5 CDK stacks synth
clean). This is the **structural** doc: what exists, where it lives, and how to change it. For why
the rules are what they are, read [`business-logic.md`](business-logic.md). For what is missing, read
[`roadmap.md`](roadmap.md)._

---

## 1. The mental model, in one page

**News comes in, becomes a story, gets attached to companies, gets interpreted, becomes a decision,
becomes a simulated trade — and every step is recorded as an immutable fact so the whole thing can be
re-run.**

```
                    ┌── SEC EDGAR (8-K / Form 4 / 13D / 13G)
  poll  ────────────┼── Massive (ex-Polygon) news API              → raw store (S3 or local fs)
  (1–2 min)         └── RSS (GlobeNewswire, CoinDesk, Cointelegraph, The Block)
                                    │  writes raw_news_items, then enqueues a pointer
                                    ▼
  process ──► 1. cluster   (exact hash → trigram similarity, advisory-locked)  → news_clusters
              2. resolve   (CIK / vendor tags / cashtags / name dictionary)    → item_instrument_links
                                    │
                                    ▼
  [M2 — NOT BUILT]  interpret (Anthropic Sonnet, structured output)            → llm_signals
                                    │
                                    ▼
  decide-sweep ──► decide()  pure: 9 gates + ATR sizing                        → decisions (+ skips)
              │                                                                   ↓ order intents
              ▼
  execute ──► SimBroker (venue 'sim' only)                                     → orders / fills
  position-manager ──► exit rules → action=close decisions                     → orders / fills

  bars-record (1 min) ──► Massive snapshot + Kraken OHLC                       → price_bars_1m
  measure (nightly)  ──► abnormal-return ladder, summaries, recovery           → reaction_*
  calendar-sync      ──► FOMC/CPI/NFP/GDP/PCE (+ earnings)                     → scheduled_events
  universe-sync      ──► S&P 500 + CIKs + aliases, point-in-time               → instruments, membership
  resolve-sweep      ──► backfill links for items the dictionary missed
```

**Two runners execute the same cores.** In AWS these are Lambdas on EventBridge schedules and SQS;
locally the CLI calls the identical functions against docker Postgres and the local filesystem. That
is why `services/handlers/src/lib/` exists — it is the shared core, not Lambda glue.

---

## 2. The workspace and its one hard dependency rule

Five pnpm workspace packages:

| Package             | Role                                                                   | May import                       |
| ------------------- | ---------------------------------------------------------------------- | -------------------------------- |
| `packages/core`     | Pure contracts + pure logic. **Zero AWS imports, zero I/O, no clock.** | zod, ulid only                   |
| `packages/adapters` | Source adapters (news feeds) + local raw store                         | core                             |
| `packages/db`       | Drizzle schema + every repository and batch job                        | core                             |
| `services/handlers` | Lambda entries + the shared ingest/trading cores                       | core, db, adapters, AWS SDK      |
| `services/cli`      | The `newstrader` CLI + end-to-end tests                                | core, db, adapters, handlers/lib |
| `infra`             | CDK stacks                                                             | aws-cdk-lib                      |

**The rule that matters: purity flows one direction.** `core` never learns about the database, the
network, or AWS. `db` never imports `adapters` (which is why `universe/`, `bars/`, and `calendar/`
each carry their own tiny `http.ts` fetch seam — deliberate duplication to protect the boundary).
The decision engine takes every input as a parameter so replay is bit-for-bit reproducible.

---

## 3. File map

### `packages/core` — pure contracts and pure logic

| File                       | Purpose                                                                                                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contracts.ts`             | Ingest contracts: `SourceAdapter`, `RawStore`, `FetchedItem` (pre-persistence, carries the payload), `RawItemV1` (the queue pointer)                                                                                                                          |
| `trading/contracts.ts`     | The decision-path coupling point: `RulesConfig`, `SignalInput`, `DecideFeatures`, `QuoteSnapshot`, `GateResult`, `DecideResult`, `OrderIntent`, `BrokerAdapter`. **Everything here must survive a jsonb round-trip**, because decisions snapshot their inputs |
| `ids.ts`                   | `newId()` (ULID), `normalizeText()`, `contentHash()` — the normalization that dedup depends on                                                                                                                                                                |
| `clustering/similarity.ts` | Word-shingle Jaccard helpers (a sanity check, _not_ a reproduction of pg_trgm scores)                                                                                                                                                                         |
| `decide/decide.ts`         | The nine gates, in order, all recorded. Exports `GATE_ORDER`                                                                                                                                                                                                  |
| `decide/sizing.ts`         | ATR-scaled fixed-fractional sizing, plus the `atr_available` / `position_too_small` gates                                                                                                                                                                     |
| `decide/exit-rules.ts`     | Exit evaluation; priority stop-loss → take-profit → time stop; `HORIZON_DURATION_MS`                                                                                                                                                                          |
| `decide/intent.ts`         | Deterministic `clientOrderId` (hash of the decision key) and intent construction                                                                                                                                                                              |
| `decide/default-rules.ts`  | `v1-conservative` — the shipped default that trades nothing, with a rationale comment per value                                                                                                                                                               |
| `decide/decimal.ts`        | Fixed-scale (1e8) BigInt decimal math, truncating — conservative for position sizes                                                                                                                                                                           |
| `decide/sha256.ts`         | Hand-rolled SHA-256, only because `node:crypto` would violate engine purity                                                                                                                                                                                   |
| `broker/sim-fill.ts`       | The pure fill model: adverse slippage, fees, rounding to column scales                                                                                                                                                                                        |
| `broker/decimal.ts`        | Variable-scale decimal math, rounding half-away-from-zero to match Postgres `numeric`                                                                                                                                                                         |

### `packages/adapters` — where news comes from

| File                 | Purpose                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `edgar.ts`           | Four adapters (8-K, Form 4, 13D, 13G) over the `getcurrent` Atom feed; deep-pages with `&start=` to chase its cursor; requires a contact `User-Agent` |
| `massive-news.ts`    | Massive news API; cursor is max `published_utc` with a 5-minute overlap re-fetch plus `next_url` paging                                               |
| `rss.ts`             | RSS 2.0 + Atom in one path; four presets; cursor is a capped guid set (noise reduction, not idempotency)                                              |
| `raw-store.ts`       | `FsRawStore` + the canonical key layout `{source}/{date}/{contentHash}-{externalIdHash}.json`                                                         |
| `http.ts` / `xml.ts` | Injectable fetch seam; XML parsing with raised entity-expansion caps (busy EDGAR pages tripped the default)                                           |
| `index.ts`           | `allAdapters(env)` — nine adapters when fully configured; skips EDGAR/Massive with a warning if keys are absent                                       |

### `packages/db` — schema, repositories, batch jobs

| Area       | Files                                                                                                                                  | Purpose                                                                                                            |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Schema     | `schema.ts`, `migrate.ts`, `client.ts`, `drizzle.config.ts`, `migrations/`                                                             | All 22 tables; migrations `0000`–`0005`                                                                            |
| Clustering | `clustering-repo.ts`                                                                                                                   | The advisory-locked 3-step attach + `closeStaleClusters`                                                           |
| Universe   | `universe/wikipedia.ts`, `sec-tickers.ts`, `aliases.ts`, `sync.ts`                                                                     | S&P 500 constituents, CIK cross-check (SEC wins), alias generation, point-in-time diff                             |
| Resolution | `resolver/match.ts`, `resolve-repo.ts`                                                                                                 | Pure matcher (`r1`) + dictionary loading, link persistence, keyset-cursor backfill sweep                           |
| Prices     | `bars/massive-bars.ts`, `kraken-bars.ts`, `bars-repo.ts`, `benchmarks.ts`, `windows.ts`, `decimal.ts`                                  | Snapshot + aggregates + Kraken OHLC clients, immutable bar writes, SPY/BTC seeding, event-window math              |
| Analytics  | `reaction/math.ts`, `measure-repo.ts`                                                                                                  | Abnormal-return ladder, settled-bar logic, beta, summaries, recovery; the `m1` and `m1-pub` clocks                 |
| Calendars  | `calendar/macro.ts`, `finnhub-earnings.ts`, `et-time.ts`, `match.ts`, `calendar-repo.ts`                                               | Government schedule parsers, DST-correct ET→UTC, the pure `isScheduledEvent` matcher                               |
| Trading    | `trading/signals-repo.ts`, `rules-repo.ts`, `features.ts`, `decide-repo.ts`, `replay-repo.ts`, `canonical-json.ts`, `default-rules.ts` | Signal writes, rules-as-data with hash-guarded immutability, feature assembly, the decide driver, replay + compare |
| Execution  | `execution/sim-broker.ts`, `positions.ts`, `position-manager.ts`, `kill-switch.ts`                                                     | The only broker (venue `sim`), fills-derived positions, exit evaluation, fail-closed switch                        |
| Shared     | `shared-constants.ts`                                                                                                                  | `MIN_LINK_CONFIDENCE` — needed by both bars and reaction, so it lives outside both                                 |

### `services/handlers` — Lambda entries and the shared cores

**The `lib/` directory is the important part** — it is what the CLI and the Lambdas share.

| File                             | Purpose                                                                                                                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/ingest.ts`                  | `runPoll` and `runProcess` — the crash-safe ordering (raw store → DB row → enqueue → watermark) lives here                                                                                           |
| `lib/trading.ts`                 | SimBroker construction, engine-version resolution, pending-intent loading, the CLI's SSM kill-switch reader                                                                                          |
| `lib/boot.ts`                    | `lazyAsync` cold-start memoization, env contract helpers, the resolver-dictionary TTL cache                                                                                                          |
| `lib/queue.ts`                   | SQS batch enqueue; throws on any reported per-entry failure so producers re-emit                                                                                                                     |
| `lib/aws-api.ts`, `lib/sigv4.ts` | Minimal hand-rolled SSM/Secrets/S3 access — avoids pulling large AWS SDK clients into every bundle                                                                                                   |
| `lib/s3-raw-store.ts`            | The deployed `RawStore` implementation                                                                                                                                                               |
| Lambda entries                   | `poll.ts`, `process.ts`, `bars-record.ts`, `calendar-sync.ts`, `measure.ts`, `universe-sync.ts`, `resolve-sweep.ts`, `decide-sweep.ts`, `execute.ts`, `position-manager.ts`, `kill-switch-setter.ts` |

### `services/cli` — the local runner

`main.ts` registers every command; `stats.ts` is the health/KPI report. `e2e.test.ts` holds nine
end-to-end scenarios (see §7).

### `infra` — five CDK stacks, split by deploy frequency

| Stack                | Contents                                                                                                                          | Changes   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `data-stack.ts`      | RDS Postgres (`t4g.micro`, public + TLS-required + SG allowlist), S3 raw + LLM-audit buckets                                      | ~never    |
| `ingest-stack.ts`    | Poller Lambdas on 1–2 min schedules, `q-items` + DLQ, the process Lambda                                                          | rarely    |
| `analytics-stack.ts` | bars-record `rate(1 min)`, universe-sync daily 05:45, calendar-sync daily 10:15, measure nightly 07:05, resolve-sweep hourly      | sometimes |
| `trading-stack.ts`   | decide-sweep every 5 min → `q-orders` + DLQ → execute (batch 5), position-manager every 15 min. **SIM venue only**                | often     |
| `ops-stack.ts`       | SNS alarm topic, DLQ/staleness/error alarms, $200 monthly budget, and the kill-switch trip path (dedicated topic + setter Lambda) | rarely    |

**Networking is deliberately absent:** no VPC, no NAT. Lambdas run outside any VPC and reach a
publicly-accessible-but-TLS-required RDS instance, which saves ~$33–55/month for a database holding
no secrets of value. `DATABASE_URL` is assembled from the RDS secret at cold start, never stored in
Lambda env.

---

## 4. The database, grouped by pipeline stage

22 tables. Idempotency keys are the load-bearing design element — every consumer is safe to re-run.

| Stage     | Tables                                                               | Idempotency key                                                               |
| --------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Ingest    | `news_sources`, `raw_news_items`, `ingest_watermarks`                | unique `(source_id, external_id)`                                             |
| Cluster   | `news_clusters`, `news_cluster_items`                                | one membership row per item; advisory-locked attach                           |
| Universe  | `instruments`, `index_membership`, `instrument_aliases`              | partial unique index: one **open** membership row per (instrument, index)     |
| Resolve   | `item_instrument_links`                                              | PK `(item_id, instrument_id, resolver_version)`                               |
| Prices    | `price_bars_1m`, `price_bars_1d`                                     | PK `(instrument_id, ts)`, conflict-do-nothing (bars are immutable)            |
| Analytics | `reaction_measurements`, `reaction_summary`, `recovery_measurements` | PK includes `measurer_version` (and `horizon`) — new methodology, new version |
| Calendars | `scheduled_events`                                                   | unique `event_key` = `kind:symbol-or-macro:ISO`                               |
| Signals   | `llm_signals` _(empty — M2)_                                         | unique `signal_key` = `cluster:target:prompt_version:model_id`                |
| Rules     | `rules_versions`, `replay_runs`                                      | unique `version_label`, immutable once referenced (hash-guarded)              |
| Decisions | `decisions`                                                          | unique `decision_key` = `signal:rules_version:live-or-replay-run`             |
| Execution | `orders`, `order_events`, `fills`                                    | unique `client_order_id`; **one fill row per order**; venue CHECK = `sim`     |

**Structural guards worth knowing**, because they encode incidents rather than taste: the partial
unique index and interval CHECK on `index_membership` (a test once wrote inverted intervals), the
one-fill-per-order unique index, and the `orders.venue = 'sim'` CHECK that makes a real-money path
impossible without a migration.

**`positions` does not exist as a table** — positions and P&L are always derived from `fills`.

---

## 5. One flow, two runners

| Pipeline step     | CLI command                     | Lambda / schedule                            |
| ----------------- | ------------------------------- | -------------------------------------------- |
| Ingest            | `poll [--loop <s>]`             | `poll.ts` — 1–2 min per source family        |
| Cluster + resolve | `process [--loop <s>]`          | `process.ts` — SQS `q-items` consumer        |
| Backfill links    | `resolve`                       | `resolve-sweep.ts` — hourly                  |
| Universe          | `universe:sync`                 | `universe-sync.ts` — daily 05:45 UTC         |
| Prices (live)     | `bars:record [--loop <s>]`      | `bars-record.ts` — every minute, 24/7        |
| Prices (history)  | `bars:backfill`                 | folded into the nightly measure job          |
| Calendars         | `calendar:sync`                 | `calendar-sync.ts` — daily 10:15 UTC         |
| Analytics         | `measure`                       | `measure.ts` — nightly 07:05 UTC             |
| Rules             | `rules:init`                    | — (operator action)                          |
| Decide            | `decide [--execute]`            | `decide-sweep.ts` — every 5 min → `q-orders` |
| Execute           | (via `decide --execute`)        | `execute.ts` — SQS `q-orders` consumer       |
| Exits             | `manage`                        | `position-manager.ts` — every 15 min         |
| Replay            | `replay`, `replay:compare`      | — (analysis only)                            |
| Health            | `stats`, `positions`, `db:ping` | —                                            |

**Running locally requires three loops plus a nightly command** — see [`roadmap.md`](roadmap.md) §8.
Deploying replaces all of it.

---

## 6. Conventions you must follow

1. **Decimal strings for all money and quantities.** Parse explicitly, compute in fixed-point BigInt,
   round to the column's scale before writing. A float in this path breaks replay determinism.
2. **Zod-parse everything external**, including features and quotes read _back_ from jsonb during
   replay. No `any`; no assertions to dodge the compiler.
3. **Purity in `core`.** No `Date.now()`, no randomness, no I/O. Clocks and dependencies are injected
   (`deps.now`, `fetchImpl`, injected evaluators). A test enforces the absence of `node:` imports in
   the engine.
4. **Idempotency by construction.** New writes need a deterministic key and a conflict-do-nothing
   path before they are correct — not after a bug proves it.
5. **Structured JSON logs** (`{level, msg, ...counts}`), because they become CloudWatch queries.
6. **Defensive parsers throw on drift.** Scraped pages and vendor payloads get bounds checks and
   explicit errors, never best-effort partial ingestion.
7. **Comments explain _why_, especially when they record a caught bug.** Do not delete those; they
   are the reason the code looks the way it does.

---

## 7. Testing

**579 tests across 48 files.** Pure tests need nothing; DB-backed suites are gated on
`TEST_DATABASE_URL` and skip silently without it.

```bash
pnpm db:up && pnpm db:migrate
TEST_DATABASE_URL=postgres://newstrader:newstrader@localhost:5433/newstrader pnpm vitest run
```

**Every DB-backed suite creates and migrates its own scratch database.** This is mandatory, not
stylistic — a suite that once ran against the shared dev database destroyed live point-in-time data.
The nine suites and their databases: `clustering-repo` → `newstrader_clustering_repo`, `reaction`,
`calendar`, `bars`, `execution`, `universe_sync`, `trading`, `resolver`, and the CLI e2e →
`newstrader_cli_e2e`. The connection user needs `CREATEDB`.

**The e2e suite (`services/cli/src/e2e.test.ts`) is the highest-value regression net** — nine
scenarios over fixtures:

- ingest → 3 items → 2 clusters with correct counters; redelivery changes nothing; resolution via two
  channels; and reaction measurement end to end under both measurer clocks.
- signal → decide → intent → fill → position → time-stop close → P&L.
- **Mode A bit-for-bit replay** with the real engine (the determinism gate).
- the decide-sweep cutoff-ordering regression.
- the shipped default rules trading **nothing**.
- the kill switch recording a suppressed decision while emitting zero orders.

**Full verification set:**

```bash
pnpm -r --parallel typecheck
TEST_DATABASE_URL=postgres://newstrader:newstrader@localhost:5433/newstrader pnpm vitest run
pnpm lint
pnpm exec prettier --check .
cd infra && CDK_DEFAULT_ACCOUNT=000000000000 CDK_DEFAULT_REGION=us-east-1 pnpm exec cdk synth --quiet
```

The synth account/region must be exactly those dummy values — `cdk.context.json` carries a synthetic
default-VPC entry keyed to account `000000000000` so offline synth works without AWS credentials, and
a real deploy produces a different context key and does a real lookup.

---

## 8. "I want to change X" — where to go

| Goal                                   | Where                                                                                                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a news source                      | New `SourceAdapter` in `packages/adapters/src/`, register in `index.ts`, add to `POLLER_SOURCES`                                                           |
| Change a gate threshold or sizing rule | **Do not edit code** — create a new `rules_versions` row (`rules-repo.ts`). Defaults live in `decide/default-rules.ts`                                     |
| Add a gate                             | `decide/decide.ts` (add to `GATE_ORDER`), extend `RulesConfig` + `DecideFeatures` in `trading/contracts.ts`, assemble the feature in `trading/features.ts` |
| Add a decision input (feature)         | `trading/contracts.ts` → `trading/features.ts` → snapshotted automatically into `decisions.features`                                                       |
| Change reaction math or add a horizon  | `reaction/math.ts` + `REACTION_HORIZONS`; **bump `MEASURER_VERSION`** rather than overwriting rows                                                         |
| Change resolution behavior             | `resolver/match.ts`; **bump `RESOLVER_VERSION`** so old links stay comparable                                                                              |
| Add a table or column                  | `packages/db/src/schema.ts`, then `cd packages/db && pnpm drizzle-kit generate --name <readable>`; hand-append CHECKs/partial indexes to the generated SQL |
| Add a scheduled job                    | Handler in `services/handlers/src/`, schedule in `infra/lib/analytics-stack.ts` (or trading), CLI command for local parity                                 |
| Add a CLI command                      | `services/cli/src/main.ts` + the table in `README.md`                                                                                                      |
| Change the fill model                  | `core/src/broker/sim-fill.ts` (pure) — note replay is intended to share it                                                                                 |
| Add a broker (go-live)                 | Implement `BrokerAdapter` from `trading/contracts.ts`; the interface will need to grow (see roadmap)                                                       |

---

## 9. Traps that will bite you

1. **`bars:record` is the only source of crypto minute bars, and Kraken forgets after ~12 hours.**
   Stopping it loses data permanently. Equity bars are re-fetchable; crypto is not.
2. **`process` is a separate command from `poll`.** Locally, ingestion without `process --loop` builds
   an unprocessed backlog — this actually happened and hid 2,000 items for two days.
3. **`measure` defaults to a 216-hour window on purpose.** Anything shorter permanently strands 3d/5d
   horizons that need a weekend to settle.
4. **Reformatting `__fixtures__/` breaks tests silently.** It is prettier-ignored because a reformat
   once turned two format-drift assertions into tautologies.
5. **A `cycle FAILED` line in a `--loop` command is tolerated by design** for `poll` and
   `bars:record` — logged, next tick supersedes. **`process --loop` does not yet do this** (roadmap).
6. **`rules_versions`'s column is `version_label`**, not `label`, in raw SQL.
7. **Never point a new DB test at `TEST_DATABASE_URL` directly** — use the `createSuiteDatabase`
   helper. See §7 for why.
8. **Operating the CLI against a deployed database needs `KILL_SWITCH_SSM_PARAM`**, or it will read a
   local env var that is probably unset and therefore trade while production is halted.
9. **`decide` reporting `examined=0` is correct today** — `llm_signals` is empty until M2 exists.
10. **EDGAR's `getcurrent` `type=` parameter prefix-matches.** `type=4` returns 424B2 prospectuses,
    497* fund docs, and everything else starting with "4". The adapter filters to each form family
    (`ACCEPTED_FORM_TYPES` in `edgar.ts`); any new EDGAR form type needs its own accept predicate.
