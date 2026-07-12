# NewsTrader

A personal research system that measures whether LLM news interpretation has a tradeable edge —
profit is the hypothesis, not the assumption. Paper-trading only. The full design is in
[docs/newstrader-architecture.md](docs/newstrader-architecture.md); read it before changing anything.

**Current state: milestone 3** — ingestion + clustering + entity resolution + price recording +
reaction analytics + scheduled-event calendars. Zero LLM spend, no broker code. Pollers pull SEC
EDGAR, Massive (ex-Polygon) news, and RSS feeds into an immutable raw store + Postgres; a
deterministic clusterer collapses echoes of the same story into clusters; a deterministic resolver
links each item to the instruments it is about (S&P 500 point-in-time universe + BTC/ETH/SOL);
price bars are recorded/backfilled around every clustered story; and a nightly measurer turns
(cluster, instrument) pairs into abnormal-return ladders, alpha-decay summaries, and recovery
metrics.

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

**Calendars feed the deterministic `already_expected` feature (architecture §6).** `calendar:sync`
scrapes FOMC / BLS (CPI, NFP) / BEA (GDP, PCE) release schedules — throwing on any format drift —
and, once `FINNHUB_API_KEY` is set, the Finnhub earnings calendar for current S&P 500 members,
into `scheduled_events`. The pure `isScheduledEvent` matcher gives decide() (M4) its ground truth
for calibrating the LLM's `already_expected` judgment.

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
pnpm cli stats            # the KPI report (ingest, resolution, reaction, calendar)
```

Without any keys in `.env` the four RSS presets (GlobeNewswire, CoinDesk, Cointelegraph, The Block)
still work. `EDGAR_USER_AGENT` enables the four EDGAR adapters; `MASSIVE_API_KEY` enables Massive
news. Raw payloads land under `./data/raw/` locally (S3 when deployed).

### CLI commands

| Command                                       | What it does                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `pnpm cli sources:seed`                       | Upsert `news_sources` rows for every enabled adapter, print the table                           |
| `pnpm cli universe:sync`                      | Sync instruments (S&P 500 + crypto), point-in-time SPX membership, alias dictionary             |
| `pnpm cli poll [sourceKey] [--loop <s>]`      | One poll cycle (or forever with `--loop`): cursor → fetch → raw store → `raw_news_items`        |
| `pnpm cli process [--batch <n>]`              | Attach unclustered items to clusters + resolve them to instruments, close stale clusters        |
| `pnpm cli resolve [--batch <n>]`              | Backfill `item_instrument_links` for every raw item without an r1 link                          |
| `pnpm cli bars:record [--loop <s>]`           | One bars-recorder tick: Massive full-market snapshot + Kraken OHLC → `price_bars_1m`            |
| `pnpm cli bars:backfill [--from/--to/--days]` | Benchmarks + daily bars (beta window) + event-window minute bars via aggregates                 |
| `pnpm cli calendar:sync [--horizon-days <n>]` | Macro + earnings calendars → `scheduled_events` (90d forward window by default)                 |
| `pnpm cli measure [--since-hours <n>]`        | Reaction ladder / summary / recovery for clusters first seen in the window (default 168h)       |
| `pnpm cli stats`                              | Items/day, dedup ratio, clusters, resolution coverage, reaction + alpha-decay medians, calendar |
| `pnpm cli db:ping`                            | Connect + `SELECT 1`                                                                            |

## Repo layout

| Path                | Contents                                                                                                                                                                                                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/`             | The approved architecture (the contract everything must match)                                                                                                                                                                                                                                                                          |
| `packages/core`     | Zod message contracts (`RawItemV1`), ids/hashing, pure similarity helpers — zero AWS imports                                                                                                                                                                                                                                            |
| `packages/db`       | Drizzle schema, migrations, advisory-locked clustering repo, `universe/` (S&P 500 + SEC + aliases sync), `resolver/` (dictionary matcher + link persistence), `bars/` (Massive/Kraken clients + immutable bar repo), `reaction/` (abnormal-return math + measurer), `calendar/` (macro/earnings schedules + `already_expected` matcher) |
| `packages/adapters` | `SourceAdapter` implementations (EDGAR, Massive, RSS) + `FsRawStore`                                                                                                                                                                                                                                                                    |
| `services/handlers` | Lambda entries (`poll.ts`, `process.ts`, `bars-record.ts`, `calendar-sync.ts`, `measure.ts`, `universe-sync.ts`, `resolve-sweep.ts`) and `lib/` — the shared ingest core both the CLI and Lambdas run, plus `S3RawStore` and a minimal SigV4/SSM/Secrets client                                                                         |
| `services/cli`      | `newstrader` CLI (`main.ts`) + the end-to-end fixture test                                                                                                                                                                                                                                                                              |
| `infra/`            | CDK stacks: data (RDS/S3), ingest (schedulers → pollers → SQS → process), analytics (bars/calendar/measure/universe/resolve schedules), ops (alarms, budget, kill switch)                                                                                                                                                               |

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
hourly. One-time prerequisites: create the SSM SecureStrings (`/newstrader/edgar-user-agent`,
`/newstrader/massive-api-key`, and optionally `/newstrader/finnhub-api-key` — until it exists the
calendar sync warn-skips earnings) and pass the `DbAllowlistCidr` / `AlertEmail` parameters — see
the comments in `infra/lib/*.ts`. Lambdas assemble `DATABASE_URL` from the RDS secret at cold
start; it is never stored in Lambda env.

**Known entitlement gap:** the Massive full-market snapshot endpoint needs the Stocks Starter
subscription active on the key. Until it is, every bars-record tick fails loudly (status
`NOT_AUTHORIZED`) and its error-rate alarm fires — deliberately not swallowed. Minute bars still
arrive via the nightly measure job's aggregates backfill, which works on the current key.
