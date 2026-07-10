# NewsTrader

A personal research system that measures whether LLM news interpretation has a tradeable edge —
profit is the hypothesis, not the assumption. Paper-trading only. The full design is in
[docs/newstrader-architecture.md](docs/newstrader-architecture.md); read it before changing anything.

**Current state: milestone 0** — ingestion + clustering only. Zero LLM spend, no broker code, no
price bars. Pollers pull SEC EDGAR, Massive (ex-Polygon) news, and RSS feeds into an immutable raw
store + Postgres, and a deterministic clusterer collapses echoes of the same story into clusters.

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

## Quickstart

```bash
pnpm install
pnpm db:up          # docker compose: postgres:16 on localhost:5433
pnpm db:migrate     # drizzle migrations (tables + pg_trgm)
cp .env.example .env   # then fill in at least EDGAR_USER_AGENT ("Name email@example.com")

pnpm cli sources:seed     # register sources for every adapter your .env enables
pnpm cli db:ping          # connectivity smoke test
pnpm cli poll --loop 60   # poll all enabled sources every 60s (ctrl-c to stop)
pnpm cli process          # cluster everything not yet clustered
pnpm cli stats            # the M0 KPI report
```

Without any keys in `.env` the four RSS presets (GlobeNewswire, CoinDesk, Cointelegraph, The Block)
still work. `EDGAR_USER_AGENT` enables the four EDGAR adapters; `MASSIVE_API_KEY` enables Massive
news. Raw payloads land under `./data/raw/` locally (S3 when deployed).

### CLI commands

| Command                                  | What it does                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm cli sources:seed`                  | Upsert `news_sources` rows for every enabled adapter, print the table                    |
| `pnpm cli poll [sourceKey] [--loop <s>]` | One poll cycle (or forever with `--loop`): cursor → fetch → raw store → `raw_news_items` |
| `pnpm cli process [--batch <n>]`         | Attach all unclustered items to clusters (oldest first), close 48h-silent clusters       |
| `pnpm cli stats`                         | Items/day by source, dedup ratio, top 10 clusters, clusters/day                          |
| `pnpm cli db:ping`                       | Connect + `SELECT 1`                                                                     |

## Repo layout

| Path                | Contents                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/`             | The approved architecture (the contract everything must match)                                                                                                      |
| `packages/core`     | Zod message contracts (`RawItemV1`), ids/hashing, pure similarity helpers — zero AWS imports                                                                        |
| `packages/db`       | Drizzle schema, migrations, advisory-locked clustering repo                                                                                                         |
| `packages/adapters` | `SourceAdapter` implementations (EDGAR, Massive, RSS) + `FsRawStore`                                                                                                |
| `services/handlers` | Lambda entries (`poll.ts`, `process.ts`) and `lib/` — the shared ingest core both the CLI and Lambdas run, plus `S3RawStore` and a minimal SigV4/SSM/Secrets client |
| `services/cli`      | `newstrader` CLI (`main.ts`) + the end-to-end fixture test                                                                                                          |
| `infra/`            | CDK stacks: data (RDS/S3), ingest (schedulers → pollers → SQS → process), ops (alarms, budget, kill switch)                                                         |

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

## Deploying (optional for M0)

The CDK app in `infra/` deploys the pollers on 1–2 min schedules. One-time prerequisites: create
the two SSM SecureStrings (`/newstrader/edgar-user-agent`, `/newstrader/massive-api-key`) and pass
the `DbAllowlistCidr` / `AlertEmail` parameters — see the comments in `infra/lib/*.ts`. Lambdas
assemble `DATABASE_URL` from the RDS secret at cold start; it is never stored in Lambda env.
