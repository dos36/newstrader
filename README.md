# NewsTrader

> Financial news → LLM-structured signal → deterministic decision → **paper** trade.

A personal research system that measures whether LLM news interpretation has a tradeable edge —
profit is the hypothesis, not the assumption.

![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)
![Postgres](https://img.shields.io/badge/Postgres-16-4169e1?logo=postgresql&logoColor=white)
![AWS CDK](https://img.shields.io/badge/AWS-CDK-ff9900?logo=amazonaws&logoColor=white)
![Venue](https://img.shields.io/badge/venue-SIM%20only-critical)

> [!IMPORTANT]
> **Paper-trading only.** The only venue is an internal fill simulator over recorded bars, enforced
> by a database CHECK constraint. There is no real-money code path, and the LLM never touches money
> — gating, sizing, execution, exits, and accounting are deterministic, unit-tested code.

## Contents

- [How it works](#how-it-works)
- [Current state](#current-state)
- [Documentation](#documentation)
- [Quickstart](#quickstart)
- [CLI reference](#cli-reference)
- [Backfilling old days](#backfilling-old-days)
- [SEC filing text](#sec-filing-text)
- [Interpret transports: api vs cli](#interpret-transports-api-vs-cli)
- [Repo layout](#repo-layout)
- [Tests](#tests)
- [Deploying](#deploying)

## How it works

```mermaid
flowchart LR
    A[SEC EDGAR<br/>Massive news<br/>RSS] -->|poll| B[(Raw store<br/>+ Postgres)]
    B --> C[Cluster<br/>echoes]
    C --> D[Resolve to<br/>instruments]
    D --> E[LLM interpret<br/>→ llm_signals]
    E --> F["decide()<br/>pure engine"]
    F --> G[SimBroker<br/>paper fills]
    G --> H[Position manager<br/>exits]
    D -.-> I[Price bars +<br/>reaction analytics]
    I -.-> J[Evaluation<br/>& reports]
    E -.-> J
```

1. **Ingest** — pollers pull SEC EDGAR, Massive (ex-Polygon) news, and RSS feeds into an immutable
   raw store + Postgres.
2. **Cluster** — a deterministic clusterer collapses echoes of the same story into one cluster.
3. **Resolve** — a deterministic resolver links each item to the instruments it is about (S&P 500
   point-in-time universe + BTC/ETH/SOL).
4. **Interpret** — the LLM turns each novel (cluster × instrument) pair into a structured signal.
5. **Decide & execute** — the pure `decide()` engine turns signals into fully recorded decisions
   (skips included), sim orders, and replayable exits.
6. **Measure** — price bars are recorded around every story; a nightly measurer computes
   abnormal-return ladders, alpha decay, and recovery; `eval:signals` checks whether the LLM's
   output means anything.

## Current state

Milestones **M0–M5 are built**: ingestion, clustering, entity resolution, price recording, reaction
analytics, scheduled-event calendars, LLM interpretation, the decision engine with SimBroker paper
execution and replay, and evaluation/reporting. IBKR paper trading and any go-live (M6/M7) are not
started and are gated on measured results.

What each milestone added and why → [`docs/milestones.md`](docs/milestones.md). Live status and
remaining work → [`docs/roadmap.md`](docs/roadmap.md).

## Documentation

**New here (human or agent)? Start with [`docs/README.md`](docs/README.md)** — it is the index and
prescribes a reading order. This file is the operator runbook.

| Document                                                             | What it covers                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------ |
| [`docs/codebase-guide.md`](docs/codebase-guide.md)                   | How the code is organized                                    |
| [`docs/business-logic.md`](docs/business-logic.md)                   | _Why_ every rule and threshold is what it is                 |
| [`docs/milestones.md`](docs/milestones.md)                           | What each built milestone added, and the reasoning behind it |
| [`docs/roadmap.md`](docs/roadmap.md)                                 | What is left to do                                           |
| [`docs/newstrader-architecture.md`](docs/newstrader-architecture.md) | The approved design plus all the verified vendor research    |

## Quickstart

**Prerequisites:** Node ≥ 20, pnpm, Docker.

```bash
pnpm install
pnpm db:up             # docker compose: postgres:16 on localhost:5433
pnpm db:migrate        # drizzle migrations (tables + pg_trgm)
cp .env.example .env   # then fill in at least EDGAR_USER_AGENT ("Name email@example.com")
```

Then run the pipeline stage by stage:

```bash
pnpm cli sources:seed     # register sources for every adapter your .env enables
pnpm cli db:ping          # connectivity smoke test
pnpm cli universe:sync    # S&P 500 + crypto instruments, SPX membership, alias dictionary
pnpm cli poll --loop 60   # poll all enabled sources every 60s (ctrl-c to stop)
pnpm cli process          # cluster + resolve everything not yet clustered
pnpm cli resolve          # backfill instrument links for items ingested before the sync
pnpm cli bars:backfill    # benchmarks + daily bars + minute bars around recent stories (3d default)
pnpm cli calendar:sync    # FOMC/CPI/NFP/GDP/PCE (+ earnings with FINNHUB_API_KEY) → scheduled_events
pnpm cli measure          # reaction ladder + summaries + recovery over recent clusters
pnpm cli interpret        # LLM-interpret novel linked clusters → llm_signals (needs ANTHROPIC_API_KEY)
pnpm cli rules:init       # seed the v1-conservative rules version (trades nothing by design)
pnpm cli decide           # decide every undecided signal
pnpm cli positions        # derived open positions + paper account state
pnpm cli stats            # the KPI report (ingest, resolution, reaction, calendar, trading)
```

> [!TIP]
> No `ANTHROPIC_API_KEY` yet? `pnpm cli interpret --mode cli` runs the same sweep on your Claude
> subscription — **dev only**, never for measurement. See
> [Interpret transports](#interpret-transports-api-vs-cli).

`calendar:sync --backfill-from YYYY-MM-DD` recovers past events for analytics (rows get
`meta.backfilled=true`; Finnhub free serves ~30 days back).

**Which keys enable what:**

| `.env` key          | Enables                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| _(none)_            | The four RSS presets: GlobeNewswire, CoinDesk, Cointelegraph, The Block |
| `EDGAR_USER_AGENT`  | The four EDGAR adapters, `universe:sync`, `edgar:documents`             |
| `MASSIVE_API_KEY`   | Massive news + price bars                                               |
| `FINNHUB_API_KEY`   | The earnings calendar                                                   |
| `ANTHROPIC_API_KEY` | `interpret --mode api`                                                  |

Raw payloads land under `./data/raw/` locally (S3 when deployed).

## CLI reference

All commands run as `pnpm cli <command>`.

### Ingestion and universe

| Command                                                   | What it does                                                                                                                                             |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sources:seed`                                            | Upsert `news_sources` rows for every enabled adapter, print the table                                                                                    |
| `universe:sync`                                           | Sync instruments (S&P 500 + crypto), point-in-time SPX membership, alias dictionary                                                                      |
| `poll [sourceKey] [--loop <s>]`                           | One poll cycle (or forever with `--loop`): cursor → fetch → raw store → `raw_news_items`                                                                 |
| `process [--batch <n>] [--loop <s>]`                      | Attach unclustered items to clusters + resolve them to instruments, close stale clusters (`--loop` = the local stand-in for the deployed process Lambda) |
| `resolve [--batch <n>]`                                   | Backfill `item_instrument_links` for every raw item without an r1 link                                                                                   |
| `edgar:documents [--batch/--loop/--form-types/--refetch]` | Fetch SEC filing bodies + press-release exhibits so the interpreter reads what the filing says — see [SEC filing text](#sec-filing-text)                 |

### Prices, calendars, reactions

| Command                              | What it does                                                                                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bars:record [--loop <s>]`           | One bars-recorder tick: Massive full-market snapshot + Kraken OHLC → `price_bars_1m`                                                                     |
| `bars:backfill [--from/--to/--days]` | Benchmarks + daily bars (beta window) + event-window minute bars via aggregates                                                                          |
| `calendar:sync [--horizon-days <n>]` | Macro + earnings calendars → `scheduled_events` (90d forward window by default)                                                                          |
| `measure [--since-hours <n>]`        | Reaction ladder / summary / recovery for clusters first seen in the window. Default **216h** (~9 days) so 3d/5d horizons spanning a weekend still settle |

### LLM interpretation

| Command                                                                   | What it does                                                                                                                                                |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interpret [--batch/--loop/--lookback-hours/--dry-run/--mode/--backfill]` | One claude-sonnet-5 structured call per novel cluster × instrument pair (link ≥ 0.75) → `llm_signals` + full audit blob; kill-switch- and spend-cap-guarded |

Notable `interpret` flags:

- `--dry-run` — print the first prompt, make zero calls.
- `--backfill` — work the whole backlog oldest-first; safe to re-run. See
  [Backfilling old days](#backfilling-old-days).
- `--retrospective-from/-to <iso>` — backfill one explicit window with `retrospective=true`
  (quarantined from the live decide queue).
- `--mode cli` — swap the API key for your Claude subscription (dev only).

### Trading (SIM only)

| Command                                                                 | What it does                                                                                                            |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `rules:init`                                                            | Seed the shipped default rules version (long-only, empty whitelist — trades nothing)                                    |
| `decide [--rules/--batch/--execute]`                                    | Engine over undecided signals → `decisions` rows; `--execute` places pending intents (sim)                              |
| `positions`                                                             | Derived positions, account state, unrealized + realized P&L (from sim fills)                                            |
| `manage [--rules <label>]`                                              | One position-manager pass: exit evaluation → replayable `action=close` decisions                                        |
| `replay --rules <label> [--from/--to] [--mode a\|b]`                    | Replay the stored signal log under a rules version (modes below)                                                        |
| `replay:compare --a <run\|live> --b <run\|live> [--live-rules <label>]` | Per-signal divergence report between two runs (`--live-rules` scopes a `live` side; defaults to the other side's label) |

Replay modes:

- **Mode A** (default) — replaying the live label reproduces the live decisions bit-for-bit; warns
  on a cross-label reuse.
- **Mode B** (`--mode b [--equity/--slippage-bps]`) — simulates the run's own portfolio and writes
  `replay_run_metrics` (hit rate, profit factor, max drawdown, exposure-adjusted return).

### Evaluation and reporting

| Command                                                               | What it does                                                                                                                                                                                                                         |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `eval:signals [--versions/--measurer/--session/--split/--cost-bps/…]` | Calibration & quality report: confidence deciles + Wilson CIs + ECE, materiality Spearman, per-event-type hit rates, session cuts, the whitelist bridge — see [Milestone 5](docs/milestones.md#milestone-5-evaluation-and-reporting) |
| `eval:latency [--source-horizon <h>]`                                 | Per-pair `m2-pub` − `m2` abnormal-return delta per horizon and per first source — the bps our ingest delay costs (the Benzinga evidence)                                                                                             |
| `report:weekly [--days <n>] [--out <file>]`                           | Weekly markdown report: paper P&L, decision funnel + rejected-signal counts by gate, hit rate by event type, calibration, best/worst trades with the LLM's reasoning                                                                 |
| `stats`                                                               | Items/day, dedup ratio, clusters, resolution coverage, reaction + alpha-decay medians, calendar, trading                                                                                                                             |
| `db:ping`                                                             | Connect + `SELECT 1`                                                                                                                                                                                                                 |

## Backfilling old days

The live sweep only looks at the last 24 hours. Anything older needs a retrospective window, and
those rows are stamped `retrospective=true` so they can never drive a live decision — they are for
measurement only.

**1. Fetch the filing text first** — an 8-K without it reaches the model as a form type and item
codes only (see [SEC filing text](#sec-filing-text)):

```bash
pnpm cli edgar:documents --batch 200 --loop 5
```

**2. Then one re-runnable command works the whole backlog, oldest first:**

```bash
pnpm cli interpret --backfill --batch 50
```

Each pass prints how many pairs are left (`left to process`), so you know when to stop. Run it
again to take the next 50. Each pass takes the oldest un-interpreted (cluster × instrument) pairs,
and a written row leaves the queue — so re-running never redoes work. The backlog is empty when
`examined` reports 0.

`--backfill` picks the window itself: everything from before your records begin up to the live
lookback's lower edge (`now - 24h`). That bound tiles exactly with the live sweep, so no cluster
falls between the two passes and the backfill never claims one the live sweep should have.

To count first, without calling or writing:

```bash
pnpm cli interpret --backfill --dry-run --batch 5000
```

An explicit window still works when you want one specific day:

```bash
pnpm cli interpret --batch 500 --retrospective-from 2026-07-10T00:00:00Z --retrospective-to 2026-07-11T00:00:00Z
```

> [!NOTE]
> Watch the `spent today $` column: the per-UTC-day cap (`LLM_DAILY_SPEND_USD_CAP`) stops a pass
> mid-window, and the next run picks up where it stopped. `--loop` is refused with any
> retrospective window — a backfill is one-shot by design, so you drive the repetition.

## SEC filing text

An EDGAR item's stored payload is the `getcurrent` Atom entry, and its summary is filing
**metadata** — `Filed: 2026-08-21 AccNo: … Size: 11 KB`. Measured over 900 sampled cluster items,
the median extracted text per source is 456 characters for Massive articles, 167 for RSS, and **57
for EDGAR**. So the highest-signal source in the pipeline reached the model with no statement of
what happened.

`pnpm cli edgar:documents` fixes that. Per filing it makes two requests — `index.json` for the
archive directory, then each content document — strips the HTML, and stores the flattened text for
the interpreter. Measured on the first 5 real filings: **23,000 characters each**, against 57
before.

It keeps the **exhibits** as well as the primary document. For an Item 2.02 earnings 8-K the primary
document often just says "see Exhibit 99.1", and Exhibit 99.1 is the press release with the numbers.

- **Idempotent per item.** A filing is fetched once and reused by every prompt version and re-run.
  Re-run the command to continue; it walks oldest-first and prints `left to fetch`.
- **8-K only by default.** Form 4 and the 424B/497 prospectus families carry no interpretable event;
  `--form-types` overrides.
- **Failures retry up to 3 times, then leave the queue** — one unreachable filing cannot stall it.
  A listing with no content documents is terminal, not retried.
- **`--refetch`** re-fetches filings that already have text, for when the extractor improves. Blobs
  are keyed per item, so it overwrites in place.
- **Requires `EDGAR_USER_AGENT`** ("Name email@example.com") — SEC 403s requests without a contact
  string. The fetcher paces itself well under SEC's 10 req/s ceiling.

Prompt version `v3` tells the model that filing text may be present and may be truncated. v1 and v2
never see it.

## Interpret transports: api vs cli

`pnpm cli interpret` can reach the model two ways. Only one of them produces rows you may measure.

|                              | `--mode api` (default)        | `--mode cli`                                                           |
| ---------------------------- | ----------------------------- | ---------------------------------------------------------------------- |
| Auth                         | `ANTHROPIC_API_KEY`           | your Claude subscription, via the `claude` CLI                         |
| Sets `effort` / `max_tokens` | yes                           | **no** — the CLI exposes neither                                       |
| Schema enforced              | yes, at the API               | no — the reply is scraped and re-validated locally, with one re-ask    |
| System prompt                | exactly the registered prompt | the registered prompt **appended** to Claude Code's own harness prompt |
| Overhead per call            | none                          | **~25.7k harness tokens**, measured                                    |
| Replayable                   | yes                           | no — the harness prompt is not versioned by us                         |
| Deployed                     | yes (interpret-sweep Lambda)  | refused — the client throws when `AWS_LAMBDA_FUNCTION_NAME` is set     |

> [!WARNING]
> Use `--mode cli` to iterate on the prompt before you have a key. **Do not use it for anything you
> intend to measure.**

Every `cli` row is marked so it stays separable:

- `llm_signals.transport = 'cli'` (a CHECK constraint keeps the column to `api`/`cli`);
- the `signal_key` gains a `:cli` suffix, so a dev call never occupies the slot the real API call
  will want — the same pair stays a candidate for `--mode api`;
- the audit blob records `contractDivergence` (what was requested vs what actually applied).

**`cost_usd` on a `cli` row over-states the interpretation.** A measured local run billed **$0.15**
for one call (39,717 cache-creation tokens) where the same call over the API bills under a cent.
The harness prefix is counted on purpose: the per-day spend breaker must over-estimate, never under.
It also means `input_tokens`/`output_tokens` on `cli` rows are near-meaningless — the CLI reports
almost everything as cache creation.

Exclude dev rows from any analysis with `WHERE transport = 'api'`.

## Repo layout

```text
newstrader/
├── docs/                 architecture, business logic, codebase guide, milestones, roadmap
├── packages/
│   ├── core/             pure: contracts, decision engine, SimBroker fill model, prompt registry
│   ├── db/               Drizzle schema + migrations and every I/O-backed module
│   └── adapters/         SourceAdapter implementations (EDGAR, Massive, RSS) + FsRawStore
├── services/
│   ├── handlers/         Lambda entries + the shared ingest/trading cores
│   └── cli/              the `newstrader` CLI + end-to-end fixture tests
└── infra/                CDK stacks
```

<details>
<summary><b>What lives in each package</b></summary>

- **`packages/core`** — Zod message contracts (`RawItemV1`), M4 trading contracts, ids/hashing, pure
  similarity helpers, `decide/` (the pure decision engine: gates, fixed-point sizing, exit rules),
  `broker/` (the pure SimBroker fill model), `interpret/` (event taxonomy, output schema, versioned
  prompt registry). Zero AWS imports, zero I/O in the engine.
- **`packages/db`** — Drizzle schema, migrations, advisory-locked clustering repo, plus:
  - `universe/` — S&P 500 + SEC + aliases sync
  - `resolver/` — dictionary matcher + link persistence
  - `bars/` — Massive/Kraken clients + immutable bar repo
  - `reaction/` — abnormal-return math + measurer
  - `calendar/` — macro/earnings schedules + `already_expected` matcher
  - `trading/` — signals/rules repos, decide driver, replay
  - `execution/` — SimBrokerAdapter, derived positions, position manager, kill switch
  - `llm/` — Anthropic client seam, lede extraction, interpret sweep + spend breaker, audit trail,
    golden-set eval
- **`packages/adapters`** — `SourceAdapter` implementations (EDGAR, Massive, RSS) + `FsRawStore`.
- **`services/handlers`** — Lambda entries (`poll`, `process`, `bars-record`, `calendar-sync`,
  `measure`, `universe-sync`, `resolve-sweep`, `interpret-sweep`, `decide-sweep`, `execute`,
  `position-manager`) and `lib/` — the shared ingest/trading cores both the CLI and Lambdas run,
  plus `S3RawStore` and a minimal SigV4/SSM/Secrets client.
- **`services/cli`** — the `newstrader` CLI (`main.ts`) + the end-to-end fixture tests
  (ingest→measure and signal→decide→fill→close).
- **`infra/`** — CDK stacks: data (RDS/S3), ingest (schedulers → pollers → SQS → process), analytics
  (bars/calendar/measure/universe/resolve schedules), trading (decide-sweep → q-orders → execute +
  position-manager; SIM venue only), ops (alarms, budget, kill switch).

</details>

**One flow, two runners:** EventBridge → poller Lambda → S3 + Postgres → SQS → process Lambda in
AWS; the CLI runs the exact same `runPoll`/`runProcess` core against the local filesystem and DB.

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

Every DB-backed suite creates its own scratch database (e.g. `newstrader_cli_e2e`) so parallel test
files never race on truncation; the connection user needs `CREATEDB` (the docker-compose superuser
has it).

## Deploying

The CDK app in `infra/` deploys everything on schedules. All trading is sim-venue only, with
DLQ/staleness/error alarms on the ops topic and `ENGINE_VERSION` stamped from the git SHA at synth.

| Job              | Schedule      | Notes                                                                                                                   |
| ---------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Pollers          | every 1–2 min |                                                                                                                         |
| bars-record      | every minute  | 24/7 — crypto trades weekends; off-hours equity snapshots no-op on the conflict-do-nothing upsert                       |
| universe-sync    | daily         |                                                                                                                         |
| calendar-sync    | daily         | Warn-skips earnings until the Finnhub key exists                                                                        |
| measure          | nightly       |                                                                                                                         |
| resolve-sweep    | hourly        |                                                                                                                         |
| interpret-sweep  | every 5 min   | Novel linked clusters → claude-sonnet-5 → `llm_signals`, audit blobs to the LLM bucket; warn-skips until its key exists |
| decide-sweep     | every 5 min   | → q-orders → execute (batch 5, partial batch failures, kill switch re-checked at execution)                             |
| position-manager | every 15 min  |                                                                                                                         |

### One-time prerequisites

1. **Create the SSM SecureStrings:**
   - `/newstrader/edgar-user-agent`
   - `/newstrader/massive-api-key`
   - `/newstrader/finnhub-api-key` _(optional — until it exists the calendar sync warn-skips earnings)_
   - `/newstrader/anthropic-api-key` _(optional — until it exists interpret-sweep warn-skips, zero LLM spend)_
2. **Create the kill-switch parameter:**

   ```bash
   aws ssm put-parameter --name /newstrader/kill-switch --value run --type String
   ```

   It is deliberately **not** CDK-managed (see the OpsStack comment): a managed `StringParameter`
   would silently un-trip a manual halt on every unrelated redeploy.

3. **Pass the `DbAllowlistCidr` / `AlertEmail` parameters** — see the comments in `infra/lib/*.ts`.

Lambdas assemble `DATABASE_URL` from the RDS secret at cold start; it is never stored in Lambda env.

### Kill switch

The kill switch halts orders, never research: decisions are still recorded (with `suppressed=true`)
but nothing is enqueued or placed. Unrecognized values halt (fail-closed).

Trip it manually:

```bash
aws ssm put-parameter --name /newstrader/kill-switch --value halt --overwrite
```

Or let the one automated path do it: a **100% monthly-budget breach** publishes to a dedicated
kill-switch SNS topic whose setter Lambda writes `halt` (50%/80% remain informational email). That
Lambda can only write that one parameter, and it never writes `run` — **clearing a halt is
deliberately a human action.** The topic is exported from the ops stack so future trip paths
(execute-DLQ alarm, reconciler drift, LLM spend breach) attach explicitly rather than by inheriting
every alarm.

> [!CAUTION]
> Operating the CLI (`pnpm cli decide` / `pnpm cli manage`) against the **deployed** database — as
> opposed to local dev, which reads `NEWSTRADER_KILL_SWITCH` — requires
> `KILL_SWITCH_SSM_PARAM=/newstrader/kill-switch` in the environment, so the CLI reads the same SSM
> parameter the Lambdas do with the same fail-closed guarantee (any read failure halts).

### Massive entitlement

**Resolved 2026-07-13:** the full-market snapshot endpoint requires an active Stocks Starter
subscription on the key, and it is now live — one snapshot call returns all ~504 universe tickers'
latest minute bar, and aggregates accept sustained bursts without rate-limiting.

If a key ever loses the entitlement the recorder fails loudly (`NOT_AUTHORIZED`) and its error-rate
alarm fires — deliberately not swallowed, because silently missing bars would corrupt every
downstream reaction measurement. Starter data is 15-minute delayed, which is by design: reaction
measurement is a batch job over historical aggregates (not delayed), and the trading horizon is
hours-to-days, so a delayed decision price is noise relative to the holding period.
