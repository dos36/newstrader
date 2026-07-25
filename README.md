# NewsTrader

A personal research system that measures whether LLM news interpretation has a tradeable edge —
profit is the hypothesis, not the assumption. Paper-trading only.

**New here (human or agent)? Start with [`docs/README.md`](docs/README.md)** — it is the index and
prescribes a reading order. The short version: this file is the operator runbook,
[`docs/codebase-guide.md`](docs/codebase-guide.md) explains how the code is organized,
[`docs/business-logic.md`](docs/business-logic.md) explains _why_ every rule is what it is,
[`docs/roadmap.md`](docs/roadmap.md) is what is left to do, and
[`docs/newstrader-architecture.md`](docs/newstrader-architecture.md) is the approved design plus all
the verified vendor research behind it.

**Current state: milestone 4** — ingestion + clustering + entity resolution + price recording +
reaction analytics + scheduled-event calendars + the deterministic decision engine with SimBroker
paper execution and replay. Zero LLM spend (`llm_signals` stays empty until M2 populates it), and
**venue is SIM ONLY** — the only broker is an internal fill simulator over recorded bars; there is
no real-money code path. Pollers pull SEC EDGAR, Massive (ex-Polygon) news, and RSS feeds into an
immutable raw store + Postgres; a deterministic clusterer collapses echoes of the same story into
clusters; a deterministic resolver links each item to the instruments it is about (S&P 500
point-in-time universe + BTC/ETH/SOL); price bars are recorded/backfilled around every clustered
story; a nightly measurer turns (cluster, instrument) pairs into abnormal-return ladders,
alpha-decay summaries, and recovery metrics; and the pure `decide()` engine turns signals into
fully-recorded decisions, sim orders, and replayable exits.

## What milestone 0 measures, and why

**The items→clusters ratio is the load-bearing unknown.** Expected volume (~50–150 relevant
filings/day + ~300–800 tagged articles/day) is an assumption until measured. After ~5 trading days
of collection, `stats` answers:

- how many items arrive per source per day, and how much of it is duplicate wire echo;
- how many _novel stories_ (clusters) that collapses into per day.

That novel-cluster count decides the shape of the LLM stage (M2): Sonnet-only if under ~500
clusters/day, a triage tier only if above. The M0 exit gate also includes hand-checking ~50
clusters for correct echo-collapse (see architecture §10).

**Timestamp discipline starts here.** `published_at` is whatever the source claims — analytics
only. `received_at` is our clock and the only clock the trading path may ever use.

## Milestone 1: the universe and entity resolution

**The pipeline gains one stage.** After an item is attached to its cluster, the process stage
resolves it against a dictionary of instruments and writes `item_instrument_links` rows stamped
`resolver_version = 'r1'`. Resolution is deterministic and LLM-free, with per-method confidence:
EDGAR filings resolve by CIK only (`cik_exact`, 1.0 — filings name counterparties constantly, so
their text is never scanned), vendor ticker tags resolve via `symbols_hint` (`source_hint`, 0.95),
"(NYSE: XYZ)" prefixes and $cashtags resolve via `ticker_exact` (0.9 / 0.85), and company-name /
crypto-keyword scans over the headline resolve via `alias_dict` (0.7 / 0.8).

**The dictionary comes from `universe:sync`.** It fetches the current S&P 500 constituents from
Wikipedia, cross-checks CIKs against SEC's `company_tickers.json` (SEC wins conflicts), upserts
`instruments` (never deletes — survivorship guard), maintains point-in-time `SPX` membership in
`index_membership`, seeds the BTC/ETH/SOL crypto instruments, and diffs `instrument_aliases`
point-in-time. Requires `EDGAR_USER_AGENT` in `.env` (SEC rejects anonymous clients).

**Items that resolve to nothing stay unlinked and retryable.** There is no "no match" marker in
r1: rerunning `resolve` after a universe change retroactively links old ZERO-link items — the
sweep walks a keyset cursor over every unlinked item, so unresolvable items cannot starve it.
One documented r1 limit remains: partially-resolved items (linked one company, missed another) are
not re-examined without a resolver_version bump. `process` resolves new items inline; the deployed
stack runs the sweep hourly and the universe sync daily (analytics stack). Historical membership
backfill (fja05680/sp500) is tracked separately within M1.

## Milestone 3: prices, reaction analytics, calendars

**Prices are local, immutable facts (architecture §5.5).** `bars:record` takes one Massive
full-market snapshot per tick (every US ticker's latest minute bar in one call — requires the
Stocks Starter snapshot entitlement; the recorder fails loudly on `NOT_AUTHORIZED`) plus one
Kraken OHLC call per coin, and `bars:backfill` fetches Massive aggregates around every clustered
story (event windows anchor−1h … anchor+5d, coalesced per instrument). All writes are
`ON CONFLICT DO NOTHING` — a bar, once recorded, is never overwritten; the `source` column says
which pipe won. SPY (equity benchmark) and BTC (crypto benchmark) are seeded idempotently and
recorded alongside the universe.

**Reaction measurement is anchored on `first_received_at` — never `published_at`.** The nightly
`measure` job writes the abnormal-return ladder (8 horizons, +5m … +5d, beta-adjusted vs SPY/BTC
when ≥30 aligned daily closes exist), the one-day summary (peak move, `time_to_half_of_1d_move` —
the alpha-decay scalar that doubles as the minutes-migration trigger), and recovery metrics for
negative events (1d abnormal ≤ −50 bps). Horizons fill in per-horizon as bars settle, so re-runs
are cheap no-ops and late horizons (3d/5d over weekends) arrive on later nights — which is why the
measure window is ~9 days, not one.

**Two clocks, two questions.** The identical ladder/summary/recovery math runs under two measurer
versions. `m1` anchors on `first_received_at` — the tradeable view, and the only honest clock for
anything trading-related. `m1-pub` anchors on the cluster's earliest _credible_ `published_at`
(present, ≤ 2 min after our receipt to allow clock skew, ≥ 24 h before it) and answers what the
market did once the news existed at all — exact regardless of our fetch cadence, because bars carry
exchange timestamps. **The per-pair difference between the two curves is the measured cost of our
ingestion latency**, which is the evidence that decides whether a faster (paid) news feed pays for
itself. `stats` also reports received−published latency per source, which doubles as a
poller-outage detector.

**Calendars feed the deterministic `already_expected` feature (architecture §6).** `calendar:sync`
scrapes FOMC / BLS (CPI, NFP) / BEA (GDP, PCE) release schedules — throwing on any format drift —
and, once `FINNHUB_API_KEY` is set, the Finnhub earnings calendar for current S&P 500 members,
into `scheduled_events`. The pure `isScheduledEvent` matcher gives decide() (M4) its ground truth
for calibrating the LLM's `already_expected` judgment.

## Milestone 4: the decision engine, SimBroker, and replay

**The engine is a pure function; everything it read is snapshotted (architecture §5.4).**
`decide(signal, features, quote, config)` lives in `packages/core/src/decide` with no I/O, no
clock, and no randomness — every input arrives as a parameter, and the decide driver
(`packages/db/src/trading`) writes the full features/quote/gates snapshot onto each `decisions`
row, skips included. Every signal in a batch also sees whatever the SAME batch has already
opened — not just the broker snapshot from batch start — so two same-instrument signals (or N
signals across instruments) in one pass can never jointly evade the `no_existing_position` /
`maxConcurrentPositions` gates.

**Replay Mode A vs Mode B.** `replay --rules <label>` re-executes the engine from the
features/quote_snapshot stored on each signal's LIVE decision, never from live queries; replaying
the SAME label the live decisions were produced under (Mode A) must reproduce them bit-for-bit
(CI-gated, including one real-engine assertion in the CLI e2e suite — not just the stub engine
in the DB package's own regression test). Replaying a DIFFERENT label (Mode B) reuses the SAME
portfolio features (open positions, equity) the live run actually saw, which a different rules
version's own trajectory would NOT have produced — `replay` prints a visible warning
(`mode_b_unsound_portfolio_features`) when this applies, rather than presenting Mode-B results as
trustworthy. `replay:compare --a <run|live> --b <run|live>` diffs any two runs (action / size /
skip-reason changes); a `live` side is scoped to one rules version via `--live-rules <label>`
(defaults to the other side's own label).

**The default rules trade NOTHING — on purpose.** `rules:init` seeds `v1-conservative`: long-only,
with an EMPTY event-type whitelist. Entries into the whitelist are earned by event-study evidence
from the reaction analytics (§6), shipped as NEW immutable `rules_versions` rows — re-registering
a label with a different config throws.

**Execution is SIM ONLY and idempotent end to end.** The SimBroker fills market orders at the
latest recorded bar close ± 5 bps adverse slippage (fees: 0 bps equities, 26 bps crypto), and
positions/P&L are always DERIVED from the append-only `fills` — no mutable positions table.
`clientOrderId` is a hash of the decision key, so a redelivered queue message or a re-run CLI
command can never double-order; the broker also refuses (throws on) any intent whose decision
turns out to be a replay row, not a live one. The scheduled position manager evaluates every open
position against the exit policy (time stop at the signal's horizon, stop-loss in ATR multiples)
and records exits as replayable `action=close` decisions under a REASON-independent key
(`exit:<openingOrderId>`, the reason lives in `features.exitReason`) — two evaluators racing to
different verdicts on the same position can mint at most one close order, never two that could
both fill and flip the position short. A rejected close retries under a new attempt-suffixed
`clientOrderId` (same sha256 namespace as entries) up to 3 attempts before the position manager
logs a structured error and waits for a human.

**The kill switch halts orders, never research.** `decide`, `execute`, and `position-manager` read
it independently (SSM `/newstrader/kill-switch` in Lambdas with a ≤30 s cache, `NEWSTRADER_KILL_SWITCH`
locally); when halted, decisions are still recorded with `suppressed=true` and nothing is enqueued
or placed. Unrecognized values halt (fail-closed). Suppressed entries never fire later; suppressed
exits re-fire on the first pass after the switch clears. Operating the CLI against a DEPLOYED
database requires `KILL_SWITCH_SSM_PARAM=/newstrader/kill-switch` in the environment — with it
set, `decide`/`manage` read the real SSM parameter instead of the local `NEWSTRADER_KILL_SWITCH`
env var, and ANY read failure (network, IAM, missing parameter) halts rather than falling through
to "just trade". The parameter itself is NOT CDK-managed (a template change would otherwise
silently un-trip a manual `halt` on every redeploy) — create it once:
`aws ssm put-parameter --name /newstrader/kill-switch --value run --type String`.

## Quickstart

```bash
pnpm install
pnpm db:up          # docker compose: postgres:16 on localhost:5433
pnpm db:migrate     # drizzle migrations (tables + pg_trgm)
cp .env.example .env   # then fill in at least EDGAR_USER_AGENT ("Name email@example.com")

pnpm cli sources:seed     # register sources for every adapter your .env enables
pnpm cli db:ping          # connectivity smoke test
pnpm cli universe:sync    # S&P 500 + crypto instruments, SPX membership, alias dictionary
pnpm cli poll --loop 60   # poll all enabled sources every 60s (ctrl-c to stop)
pnpm cli process          # cluster + resolve everything not yet clustered
pnpm cli resolve          # backfill instrument links for items ingested before the sync
pnpm cli bars:backfill    # benchmarks + daily bars + minute bars around recent stories (3d default)
pnpm cli calendar:sync    # FOMC/CPI/NFP/GDP/PCE (+ earnings with FINNHUB_API_KEY) → scheduled_events
pnpm cli measure          # reaction ladder + summaries + recovery over the last 7d of clusters
pnpm cli rules:init       # seed the v1-conservative rules version (trades nothing by design)
pnpm cli decide           # decide every undecided signal (expect examined=0 until M2 lands)
pnpm cli positions        # derived open positions + paper account state
pnpm cli stats            # the KPI report (ingest, resolution, reaction, calendar, trading)
```

Without any keys in `.env` the four RSS presets (GlobeNewswire, CoinDesk, Cointelegraph, The Block)
still work. `EDGAR_USER_AGENT` enables the four EDGAR adapters; `MASSIVE_API_KEY` enables Massive
news. Raw payloads land under `./data/raw/` locally (S3 when deployed).

### CLI commands

| Command                                                                          | What it does                                                                                                                                                                                               |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm cli sources:seed`                                                          | Upsert `news_sources` rows for every enabled adapter, print the table                                                                                                                                      |
| `pnpm cli universe:sync`                                                         | Sync instruments (S&P 500 + crypto), point-in-time SPX membership, alias dictionary                                                                                                                        |
| `pnpm cli poll [sourceKey] [--loop <s>]`                                         | One poll cycle (or forever with `--loop`): cursor → fetch → raw store → `raw_news_items`                                                                                                                   |
| `pnpm cli process [--batch <n>] [--loop <s>]`                                    | Attach unclustered items to clusters + resolve them to instruments, close stale clusters (`--loop` = the local stand-in for the deployed process Lambda)                                                   |
| `pnpm cli resolve [--batch <n>]`                                                 | Backfill `item_instrument_links` for every raw item without an r1 link                                                                                                                                     |
| `pnpm cli bars:record [--loop <s>]`                                              | One bars-recorder tick: Massive full-market snapshot + Kraken OHLC → `price_bars_1m`                                                                                                                       |
| `pnpm cli bars:backfill [--from/--to/--days]`                                    | Benchmarks + daily bars (beta window) + event-window minute bars via aggregates                                                                                                                            |
| `pnpm cli calendar:sync [--horizon-days <n>]`                                    | Macro + earnings calendars → `scheduled_events` (90d forward window by default)                                                                                                                            |
| `pnpm cli measure [--since-hours <n>]`                                           | Reaction ladder / summary / recovery for clusters first seen in the window (default **216h** — ~9 days, so 3d/5d horizons spanning a weekend still settle; a shorter window would strand them permanently) |
| `pnpm cli rules:init`                                                            | Seed the shipped default rules version (long-only, empty whitelist — trades nothing)                                                                                                                       |
| `pnpm cli decide [--rules/--batch/--execute]`                                    | Engine over undecided signals → decisions rows; `--execute` places pending intents (sim)                                                                                                                   |
| `pnpm cli positions`                                                             | Derived positions, account state, unrealized + realized P&L (from sim fills)                                                                                                                               |
| `pnpm cli manage [--rules <label>]`                                              | One position-manager pass: exit evaluation → replayable `action=close` decisions                                                                                                                           |
| `pnpm cli replay --rules <label> [--from/--to]`                                  | Replay the stored signal log under a rules version (Mode A: live label ⇒ bit-for-bit; warns on Mode B)                                                                                                     |
| `pnpm cli replay:compare --a <run\|live> --b <run\|live> [--live-rules <label>]` | Per-signal divergence report between two runs (`--live-rules` scopes a `live` side; defaults to the other side's label)                                                                                    |
| `pnpm cli stats`                                                                 | Items/day, dedup ratio, clusters, resolution coverage, reaction + alpha-decay medians, calendar, trading                                                                                                   |
| `pnpm cli db:ping`                                                               | Connect + `SELECT 1`                                                                                                                                                                                       |

## Repo layout

| Path                | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/`             | The approved architecture (the contract everything must match)                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/core`     | Zod message contracts (`RawItemV1`), M4 trading contracts, ids/hashing, pure similarity helpers, `decide/` (the pure decision engine: gates, fixed-point sizing, exit rules), `broker/` (the pure SimBroker fill model) — zero AWS imports, zero I/O in the engine                                                                                                                                                                                                                  |
| `packages/db`       | Drizzle schema, migrations, advisory-locked clustering repo, `universe/` (S&P 500 + SEC + aliases sync), `resolver/` (dictionary matcher + link persistence), `bars/` (Massive/Kraken clients + immutable bar repo), `reaction/` (abnormal-return math + measurer), `calendar/` (macro/earnings schedules + `already_expected` matcher), `trading/` (signals/rules repos, decide driver, replay), `execution/` (SimBrokerAdapter, derived positions, position manager, kill switch) |
| `packages/adapters` | `SourceAdapter` implementations (EDGAR, Massive, RSS) + `FsRawStore`                                                                                                                                                                                                                                                                                                                                                                                                                |
| `services/handlers` | Lambda entries (`poll.ts`, `process.ts`, `bars-record.ts`, `calendar-sync.ts`, `measure.ts`, `universe-sync.ts`, `resolve-sweep.ts`, `decide-sweep.ts`, `execute.ts`, `position-manager.ts`) and `lib/` — the shared ingest/trading cores both the CLI and Lambdas run, plus `S3RawStore` and a minimal SigV4/SSM/Secrets client                                                                                                                                                    |
| `services/cli`      | `newstrader` CLI (`main.ts`) + the end-to-end fixture tests (ingest→measure and signal→decide→fill→close)                                                                                                                                                                                                                                                                                                                                                                           |
| `infra/`            | CDK stacks: data (RDS/S3), ingest (schedulers → pollers → SQS → process), analytics (bars/calendar/measure/universe/resolve schedules), trading (decide-sweep → q-orders → execute + position-manager; SIM venue only), ops (alarms, budget, kill switch)                                                                                                                                                                                                                           |

One flow, two runners: EventBridge → poller Lambda → S3 + Postgres → SQS → process Lambda in AWS;
the CLI runs the exact same `runPoll`/`runProcess` core against the local filesystem and DB.

## Tests

```bash
pnpm test        # pure tests only — no network, no DB (fixture-driven)
pnpm typecheck   # strict TS across all packages
```

DB-backed tests (clustering integration + the CLI e2e) are skipped unless `TEST_DATABASE_URL` is
set:

```bash
pnpm db:up && pnpm db:migrate
TEST_DATABASE_URL=postgres://newstrader:newstrader@localhost:5433/newstrader pnpm test
```

The CLI e2e creates its own scratch database (`newstrader_cli_e2e`) so parallel test files never
race on truncation; the connection user needs `CREATEDB` (the docker-compose superuser has it).

## Deploying

The CDK app in `infra/` deploys the pollers on 1–2 min schedules plus the analytics jobs:
bars-record every minute (24/7 — crypto trades weekends; off-hours equity snapshots no-op on the
conflict-do-nothing upsert), universe-sync and calendar-sync daily, measure nightly, resolve-sweep
hourly. The trading stack adds decide-sweep every 5 min → q-orders → execute (batch 5, partial
batch failures, kill switch re-checked at execution) and the position manager every 15 min — all
sim-venue only, with DLQ/staleness/error alarms on the ops topic and `ENGINE_VERSION` stamped
from the git SHA at synth. One-time prerequisites: create the SSM SecureStrings
(`/newstrader/edgar-user-agent`, `/newstrader/massive-api-key`, and optionally
`/newstrader/finnhub-api-key` — until it exists the calendar sync warn-skips earnings), create the
kill-switch parameter (`aws ssm put-parameter --name /newstrader/kill-switch --value run --type String` —
NOT CDK-managed, see the OpsStack comment: a managed `StringParameter` would silently un-trip a
manual halt on every unrelated redeploy), and pass the `DbAllowlistCidr` / `AlertEmail` parameters
— see the comments in `infra/lib/*.ts`. Lambdas assemble `DATABASE_URL` from the RDS secret at cold
start; it is never stored in Lambda env. Trip the kill switch manually with
`aws ssm put-parameter --name /newstrader/kill-switch --value halt --overwrite`, or let the one
automated path do it: a **100% monthly-budget breach** publishes to a dedicated kill-switch SNS topic
whose setter Lambda writes `halt` (50%/80% remain informational email). That Lambda can only write
that one parameter, and it never writes `run` — clearing a halt is deliberately a human action. The
topic is exported from the ops stack so future trip paths (execute-DLQ alarm, reconciler drift, LLM
spend breach) attach explicitly rather than by inheriting every alarm.

Operating the CLI (`pnpm cli decide` / `pnpm cli manage`) against the DEPLOYED database — as
opposed to local dev, which reads `NEWSTRADER_KILL_SWITCH` — requires
`KILL_SWITCH_SSM_PARAM=/newstrader/kill-switch` in the environment so the CLI reads the same SSM
parameter the Lambdas do, with the same fail-closed guarantee (any read failure halts).

**Massive entitlement (resolved 2026-07-13):** the full-market snapshot endpoint requires an active
Stocks Starter subscription on the key, and it is now live — one snapshot call returns all ~504
universe tickers' latest minute bar, and aggregates accept sustained bursts without rate-limiting.
If a key ever loses the entitlement the recorder fails loudly (`NOT_AUTHORIZED`) and its error-rate
alarm fires — deliberately not swallowed, because silently missing bars would corrupt every
downstream reaction measurement. Starter data is 15-minute delayed, which is by design: reaction
measurement is a batch job over historical aggregates (not delayed), and the trading horizon is
hours-to-days, so a delayed decision price is noise relative to the holding period.
