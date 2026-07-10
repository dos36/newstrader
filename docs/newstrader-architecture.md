# NewsTrader — Architecture (v1, Canada-adjusted)

_Status: approved design, 2026-07-10. All prices/limits/availability claims were verified against live vendor sources on 2026-07-10 unless marked **[re-check at build]**. The user is a Canadian resident — this shapes the broker and data-vendor choices throughout._

---

## 0. Purpose and design stance

**NewsTrader measures whether LLM news interpretation has a tradeable edge — profit is the hypothesis, not the assumption.** Every design decision favors auditability and honest evaluation over cleverness. The system paper-trades only; going live requires code changes, not configuration.

**The LLM reads; deterministic code handles money.** The LLM appears in exactly one place: converting a novel news story into a typed, structured signal. Everything downstream — gating, sizing, execution, exits, risk, accounting — is deterministic TypeScript that can be unit-tested and replayed.

**Facts are append-only; analytics are derived.** Raw news, signals, decisions, orders, and prices are immutable rows (state changes are new rows, never UPDATEs). Any new analytics question becomes a new batch job over existing facts — no migrations, no re-collection.

**Solo-developer, boring infrastructure.** Scheduled Lambdas, one queue pair, one small Postgres, S3. No Kubernetes, no streaming infra, no VPC gymnastics. The one stateful exception (IBKR connectivity) is isolated behind an interface and possibly avoidable entirely.

---

## 1. System overview

```
EventBridge Scheduler (1–5 min crons)
  └─► poller Lambdas (per source family: edgar / massive-news / rss / finnhub / calendars)
        │  write raw payload → S3 raw/          enqueue pointer → q-items
        ▼
q-items ──► process Lambda:
              1. dedup/cluster        (deterministic: hash → similarity, advisory-locked)
              2. entity resolution    (deterministic dictionary; CIK for filings)
              3. LLM interpretation   (Anthropic API, structured output → llm_signals)
              4. decide()             (pure function: gates + sizing → decisions)
        │                                       enqueue intents → q-orders
        ▼
q-orders ──► execute Lambda: kill-switch check → active BrokerAdapter
              (SimBroker in v1 → IBKR-paper pre-live → IBKR/Kraken live)

Scheduled jobs:
  bars-recorder (1 min)       Massive full-market snapshot → price_bars_1m; Kraken REST for crypto
  position-manager (5–15 min) evaluates exits → decisions(action=close) → q-orders
  reconciler (15 min)         broker state vs local state; drift → kill switch
  nightly                     reaction/recovery measurements, source reliability, daily bars
  weekly                      markdown report
```

Both queues are SQS Standard with DLQs and alarms. Exactly-once behavior comes from Postgres unique constraints, not queue semantics (§4.2).

---

## 2. Sources

### 2.1 V1 sources (build in this order)

| #   | Source                                              | Cost   | Latency                  | Tickers tagged                              | Notes                                                                                                                                                                                                                                                                                |
| --- | --------------------------------------------------- | ------ | ------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **SEC EDGAR** `getcurrent` Atom feed                | $0     | ~1–2 min (verified live) | No — CIK; map via `company_tickers.json`    | The equities backbone. Filing types: **8-K** (P0), Form 4, 13D/G (P1). ≤10 req/s, mandatory User-Agent with contact email (403 without it — verified). Poll every 1 min; sub-minute polling buys nothing at an hours horizon.                                                        |
| 2   | **Massive (ex-Polygon) news API** — Stocks Starter  | $29/mo | minutes to ~1 hour       | Yes + sentiment                             | The Benzinga-via-Alpaca replacement (Alpaca is not available as a broker to Canadians). Unlimited API calls; archive to 2016. Honest caveat: slower than Benzinga's wire — acceptable at hours horizon; the $99/mo Benzinga add-on on Massive is the priced, no-code-change upgrade. |
| 3   | **Finnhub free**                                    | $0     | minutes                  | Yes (company-news)                          | Breaking-news side feed (60 req/min) + earnings calendar. Free tier is personal-use; do NOT use for price bars (candles endpoint 403s on free keys — verified).                                                                                                                      |
| 4   | **Macro calendars** (Fed FOMC page, BLS, BEA)       | $0     | scheduled                | n/a                                         | Static pages refreshed monthly. Feed the deterministic `calendar_match` decision feature (§6).                                                                                                                                                                                       |
| 5   | **GlobeNewswire RSS**                               | $0     | ~1–5 min                 | No — regex `(NYSE\|Nasdaq): XYZ` works ~95% | Redundancy + wire-vs-aggregator latency yardstick for source-reliability analytics.                                                                                                                                                                                                  |
| 6   | **Crypto RSS** — CoinDesk, Cointelegraph, The Block | $0     | minutes                  | No — trivial for a 3-coin universe          | Alpha is modest; primary value is measuring crypto news reaction.                                                                                                                                                                                                                    |

**8-K item codes route deterministically — no LLM triage needed for filings.** The Atom feed carries item codes inline (verified). High-signal codes: 2.02 (earnings results), 5.02 (CEO/CFO departure), 4.02 (restatement/non-reliance), 1.03 (bankruptcy), 2.01 (M&A completion), 2.05 (restructuring), 2.06 (impairment), 3.01 (delisting), 1.01/1.02 (material agreements), 7.01/8.01 (Reg FD grab-bag — these DO go to the LLM).

**Expected volume (to be measured in milestone 0, not assumed):** ~50–150 S&P-500-relevant filings/day + ~300–800 tagged articles/day. Post-clustering novel-story volume is the load-bearing unknown; the ingest-only skeleton measures it before any LLM spend is committed.

### 2.2 V2 sources (deferred, priced)

- **Benzinga add-on on Massive, $99/mo** — restores newsroom latency and 2001-era archive; single biggest quality jump, same vendor, no code change.
- **X/Twitter pay-per-use** — $0.005/post read is the ONLY self-serve option since Feb 2026 (free/Basic/Pro all closed to new signups — verified). A 15-account watchlist ≈ $120–225/mo reads + ~$45–90/mo LLM overhead. Two billing details are unverified (whether empty polls bill a minimum; whether timeline endpoints are included) — run a **~$10 one-week billing probe** before committing. Decision rule: buy X only if 3 months of source-reliability data shows market-moving clusters where X would have led by useful margin.
- **Bluesky Jetstream** ($0, but needs a persistent websocket consumer), **Reddit sentiment** (free non-commercial tier, gray zone), **Whale Alert** ($30/mo).

### 2.3 Avoid (with reasons)

NewsAPI.org (24-h delayed free tier, $449/mo paid, no tickers) · scraping X or Business Wire (ToS violation; litigious owners; gray-market resellers vanish overnight) · Stocktwits (API registrations closed — verified) · Tiingo as news backbone (3-month news lookback on standard plans) · SEC PDS / Bloomberg-class feeds (100–1000× overpriced for this system) · Upbit/Binance listing feeds (listing pumps are a minutes-level trade on tokens outside our universe).

**Accepted v1 coverage gap, stated explicitly:** analyst upgrades/downgrades — a major hours-level mover class — arrive only via the aggregator feeds. They are tagged as their own `event_type` so source-reliability analytics can measure whether coverage is adequate or a dedicated source is needed.

---

## 3. Universe

- **Equities: S&P 500 with point-in-time membership.** Backfill history from the free `fja05680/sp500` dataset (constituents since 1996); maintain forward by daily-diffing a constituents source. Every universe query goes through `index_membership` with an `asOf` — never "current S&P 500" (survivorship-bias guard).
- **Sector codes:** official GICS is licensed; use Wikipedia's sector/sub-industry columns as the free approximation, noted in `instruments`.
- **Crypto: BTC, ETH, SOL** vs USD (and CAD pairs exist on Kraken — verified live via the public AssetPairs API).

---

## 4. Runtime architecture (AWS + TypeScript)

### 4.1 Compute model

**Everything is a scheduled or queue-triggered Lambda; there are no long-running processes in v1.** Pollers run on EventBridge Scheduler crons (1–5 min — free tier covers this volume ~100×). At an hours-to-days horizon, a 1–2 minute polling delay is noise; websocket consumers (Fargate) are a minutes-migration concern, not a v1 one.

**Pollers do exactly three things:** fetch since their cursor (cursor in Postgres), write the raw payload to S3 (`raw/{source}/{yyyy-mm-dd}/{contentHash}-{externalId hash}.json` — externalId is part of the key so same-text items with different identities never clobber each other's verbatim payload), enqueue a pointer message. They never parse, never dedup, never call the LLM — this keeps them trivially re-runnable and makes S3 the immutable replay source of truth.

**One `process` Lambda runs dedup → resolve → interpret → decide in sequence** (reserved concurrency ~5 so a news burst cannot stampede Anthropic rate limits; backpressure is free — messages age harmlessly in-queue). A separate `execute` Lambda consumes order intents. Splitting further into per-stage Lambdas/queues is deliberate non-design: at ≤2,500 items/day there is no throughput reason, and every queue boundary would add a schema version, DLQ, alarm set, and local-dev shim. The idempotency keys (below) make that refactor safe later if a stage ever needs independent scaling.

### 4.2 Idempotency (exactly-once from Postgres, not the queue)

SQS Standard is at-least-once with reordering; consumers are idempotent instead:

| Stage         | Idempotency key                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Raw ingest    | unique `(source_id, external_id)` — `INSERT … ON CONFLICT DO NOTHING`                                                          |
| LLM interpret | unique `(cluster_id, target, prompt_version, model_id)` — completed row short-circuits; at most one LLM call per key           |
| Decide        | unique `(signal_id, rules_version_id, replay_run_id)`                                                                          |
| Execute       | deterministic `client_order_id = ulid-from-hash(decision_id)` passed to the broker — a redelivered message cannot double-order |

Queue config: batch 1–5, visibility timeout ≥ 6× Lambda timeout, `maxReceiveCount` 3–5 → DLQ. A message in a DLQ is a bug, not noise — every DLQ alarm pages immediately.

### 4.3 LLM interpretation stage

- **Anthropic API direct** (`@anthropic-ai/sdk`) — not Bedrock: better SDK ergonomics, first access to structured outputs / prompt caching / Batches API (50% off — useful later for re-interpreting stored stories under a new prompt version). Structured output constrained by a zod-derived JSON schema so parsing never fails; a parse failure is a poison pill → DLQ, never retried past the redrive count.
- **Sonnet-only to start.** A Haiku triage stage is added ONLY if milestone-0 measurement shows >~500 novel clusters/day. Rationale: triage adds a second prompt to version, a second failure mode, and its cost estimate collapsed under scrutiny (triage needs headline+tickers, ~200 tokens, not full articles). 8-K filings bypass any triage via item-code routing.
- **Prompt caching on the fixed system prompt** (~90% off cached input tokens).
- **Cost controls:** per-day LLM spend circuit breaker wired to the kill switch. Earnings season concentrates ~55–70% of volume into ~6 weeks/quarter with 3–5× peak days — the breaker, not the average, is the safety net. Budget band: **~$40–90/mo**.
- **Every call persisted:** parsed fields in `llm_signals`; full prompt + raw response in S3 (`llm/{date}/{signal_id}.json`); tokens/cost/latency columns on the row. This is the replay asset.

### 4.4 Database and networking

- **RDS Postgres `db.t4g.micro` single-AZ (~$12/mo + ~$2 storage), publicly accessible with TLS required + strict security-group allowlist.** Consequence: every Lambda runs OUTSIDE any VPC → $0 networking. This deliberately avoids the NAT-gateway trap ($33/mo + $0.045/GB) and the interface-endpoint alternative ($22/mo) — for a paper-trading system whose DB holds no secrets of value, private networking is cost without threat-model justification. If that trade ever feels wrong: the split-VPC topology (internet Lambdas outside, DB Lambdas inside with S3 gateway + 3 interface endpoints) is the documented alternative at +$22/mo.
- **Sizing:** v1 write load without streaming (~a few hundred K rows/day incl. bars) is far inside micro's envelope; upsize on CPU-credit alarms, not speculation.
- **Secrets: SSM Parameter Store SecureString ($0)** — not Secrets Manager. **Kill switch: SSM parameter** (`/newstrader/kill-switch`) read by `decide` and `execute` each invocation (≤30 s cache). Trip paths: CLI, AWS-Budget-100% alarm → SNS → setter Lambda, reconciler drift, execute-DLQ alarm, daily LLM spend breach. When tripped, `decide` keeps recording decisions flagged `suppressed=true` — research data never stops.
- **S3 layout:** `raw/` (immutable fetch payloads; lifecycle → IA at 30 d, Glacier at 180 d), `llm/` (prompt/response audit), `backfill/` (flat-file imports). Nightly `pg_dump` to S3 is the backup story; Parquet/DuckDB exports are deferred until a real query is actually slow (<10 GB/yr does not need a lake).

### 4.5 IBKR connectivity — the one stateful wart

Canada makes IBKR unavoidable (it is both the only credible API broker for Canadians and the chosen go-live venue). Two integration paths, tried in order:

1. **Web API with OAuth 1.0a (self-service portal) — try first.** Officially positioned as institutional, but verified working for individual accounts including paper (ibind project documentation; an IBKR API agent confirmed no technical limitation). Pure HTTPS → Lambda-friendly, **no gateway container at all**. Activation takes 24 h–2 weeks; it is semi-official and could be closed — hence the fallback. **[re-check at build]**
2. **IB Gateway + IBC in a container** (`gnzsnz/ib-gateway-docker`) on a small EC2/ECS (~$15/mo). Key verified fact: **paper accounts are not enrolled in 2FA** — paper-credential gateways run genuinely unattended (community-verified, incl. the docker image maintainer). The weekly Sunday-1am-ET 2FA ritual only begins with live credentials at go-live — by which time IBKR's retail OAuth 2.0 (announced as "being considered") should be re-checked.

**CIRO carve-out (verified):** IBKR Canada prohibits client applications from submitting API orders for _Canadian-exchange_ products. Irrelevant here — the universe is US-listed only.

### 4.6 Repo layout and local development

```
newstrader/                     # pnpm workspace
  infra/                        # CDK (TypeScript), stacks split by deploy frequency
    data-stack.ts               #   RDS, S3, SSM params        (deploy ~never)
    ingest-stack.ts             #   schedules + pollers + q-items
    pipeline-stack.ts           #   process/execute Lambdas + q-orders + DLQs
    ops-stack.ts                #   alarms, budget, kill switch
  services/*/                   # one thin Lambda entry per handler
  packages/core/                # zod message contracts (RawItem v1, Signal v1, OrderIntent v1),
                                #   pure decide(), SimBroker fill model — ZERO AWS imports
  packages/db/                  # drizzle schema + migrations
  packages/adapters/            # SourceAdapter impls, BrokerAdapter impls, MarketDataProvider impls
```

- **Local dev:** docker-compose with a single `postgres:16`; every stage is a pure handler `handle(msgs, deps)` callable from a CLI runner over checked-in fixtures; real Anthropic/Massive/IBKR-paper keys via `.env.local`. No LocalStack (fidelity tax, no payoff).
- **Alarms (minimum set):** every DLQ >0 for 5 min; oldest-message age >15 min on both queues; per-Lambda error rate; RDS storage + CPU-credit; a `no-signals-in-6h` dead-pipeline heartbeat; AWS Budget at $200 with 50/80/100% notifications, 100% wired to the kill switch.

### 4.7 Minutes-level migration (designed for, not built)

**What changes:** pollers → Fargate websocket consumers emitting the same zod `RawItem`; Kraken WS v2 replaces REST polling; Massive→Benzinga add-on (or faster feed); a live quote cache; SNS fan-out between decide and execute. **What is locked in NOW to make that a re-wire, not a rewrite:** versioned message contracts, the `SourceAdapter` interface (`fetchSince(cursor) → RawItem[]` — a push adapter is just another implementation), content-derived idempotency keys (safe poll/push coexistence during cutover), and the pure decision engine.

**Trigger — the analytics produce their own migration evidence:** migrate when `reaction_summary` shows the median `time_to_half_of_1d_move` for _traded_ event types dropping below realistic entry latency (i.e., measured alpha decay beats the system to the trade). Cost delta ≈ +$100–120/mo.

---

## 5. Data model

Conventions: ULID primary keys (time-sortable, no coordination), `timestamptz` UTC everywhere, `jsonb` only for open-ended versioned blobs — never for columns the engine filters on. Facts are append-only.

### 5.1 Ingestion and clustering

```sql
news_sources (id, kind rss|newsapi|sec_edgar|exchange_notice, name, handle_or_url, base_trust, active)

raw_news_items (                         -- immutable; one row per item PER source
  id, source_id, external_id,            -- UNIQUE(source_id, external_id) = idempotent ingest
  url, headline,                         -- body lives in S3
  payload_s3_key, content_hash,          -- sha256(normalized text)
  published_at,                          -- what the source CLAIMS (analytics only)
  received_at,                           -- our clock — the ONLY clock the trading path may use
  lang, ingest_run_id
)

news_clusters (                          -- one row per distinct story
  id, canonical_headline,
  first_item_id, first_source_id,        -- who broke it → scoop-rate analytics
  first_received_at,                     -- anchor for ALL reaction measurements
  item_count, distinct_source_count, last_item_at,   -- denormalized popularity counters
  status open|closed                     -- close after 48h silence
)

news_cluster_items (cluster_id, item_id, similarity, lag_from_first_ms)
```

**Clustering algorithm (deterministic, no embeddings, no extra API):**

1. Exact `content_hash` match → attach immediately.
2. Else candidate block = clusters sharing ≥1 resolved instrument within a 48 h window; similarity = normalized headline+lede trigram (`pg_trgm`) or MinHash, threshold ≈ 0.7.
3. **Serialize attach per block with a Postgres advisory lock** — two concurrent Lambdas processing echoes of the same story must not mint duplicate clusters (that would silently corrupt popularity and scoop stats).
4. Embeddings (Voyage `voyage-3.5-lite`, $0.02/MTok) are added only if trigram demonstrably mis-clusters — measurable, because raw items are kept forever.

Cluster velocity (`items_per_hour`, distinct sources in trailing window) is computed at decision time from `news_cluster_items` and snapshotted into the decision row — no separate time-series table.

### 5.2 Instruments and point-in-time universe

```sql
instruments (id, symbol, asset_class equity|crypto, exchange, cik, name,
             sector_approx, first_listed_at, delisted_at)   -- delisted rows kept forever
index_membership (instrument_id, index_code, valid_from, valid_to)   -- NULL valid_to = current
instrument_aliases (instrument_id, alias, alias_kind, valid_from, valid_to)  -- tickers get reused
item_instrument_links (item_id, instrument_id, method cik_exact|ticker_exact|alias_dict|llm_ner,
                       confidence, resolver_version)
```

"Universe as of T" = `valid_from <= T AND (valid_to IS NULL OR valid_to > T)`. The data-access layer takes an `asOf` and refuses rows with `received_at > asOf` — look-ahead protection enforced in code, not convention.

### 5.3 LLM signals and fan-out

```sql
llm_signals (
  id, cluster_id,
  scope company|sector|macro, instrument_id NULL, sector_code NULL,
  event_type, direction bullish|bearish|neutral, expected_move_bps,
  horizon intraday|1d|3d|5d, already_expected bool, materiality, confidence,   -- typed columns
  model_id, prompt_version,
  prompt_s3_key, response_s3_key, input_tokens, output_tokens, cost_usd, latency_ms,
  cluster_item_count_at_analysis,        -- what the LLM "knew" about popularity, frozen
  analyzed_at, retrospective bool DEFAULT false,
  UNIQUE (cluster_id, coalesce(instrument_id, sector_code), prompt_version, model_id)
)

signal_fanout (id, signal_id, instrument_id, fanout_rules_version, weight, universe_as_of, replay_run_id NULL)
```

- **Re-prompting inserts new rows under a new `prompt_version`; old signals are never touched** — prompt A/B on identical clusters is a join.
- **Sector scope** fans out deterministically (code, not LLM) over point-in-time membership. **Macro scope is record-only in v1** — no fan-out trading (an optional SPY-proxy rule later is a replayable `fanout_rules_version` choice). Crypto "sector" news fans to all three coins uniformly.
- `analyzed_at − received_at` is stored: signal-quality metrics are valid **only for forward-collected signals** (small gap). Any backtest run of the LLM over old news is flagged `retrospective=true` and excluded from reliability stats — the model may already "know" the outcome (training-data leakage; the single most invalidating trap in LLM-trading backtests).

### 5.4 Rules, decisions, replay

```sql
rules_versions (id, version_label, config jsonb, config_hash, parent_version_id, created_at)
  -- immutable once referenced; config holds gate thresholds, sizing params, exit policy, fanout weights

replay_runs (id, rules_version_id, signal_time_range, params jsonb, created_at, notes)
  -- params includes: slippage model, and signal_filter {prompt_version, model_id}
  --   (a signal log with two prompt versions must not double-feed the engine)

decisions (                              -- one row per evaluation, INCLUDING skips
  id, signal_id NULL, fanout_id NULL,    -- exactly one non-null
  instrument_id, rules_version_id,
  replay_run_id NULL,                    -- NULL = live decision; live and replay share ONE schema
  decided_at, action open_long|open_short|close|skip, skip_reason,
  gates jsonb,        -- [{gate, pass, observed, threshold}, …] — every gate, pass or fail
  features jsonb,     -- everything else the engine read, each tagged "world" | "portfolio"
  quote_snapshot jsonb,  -- {bid, ask, last, spread_bps, quote_ts, quote_source}
  sized_qty, sized_notional, suppressed bool DEFAULT false
)

orders (id, decision_id, instrument_id, side, qty, order_type, limit_price, tif,
        venue sim|ibkr_paper|ibkr|kraken, client_order_id, broker_order_id, status, submitted_at)
order_events (order_id, event, payload jsonb, at)       -- transitions appended, never overwritten
fills (id, order_id, fill_qty, fill_price, fee, filled_at, is_simulated)
-- positions and P&L are VIEWS over fills; no mutable positions table
```

**The replay contract:**

- `decide(signal, features, quote_snapshot, rulesConfig)` is a **pure function** in `packages/core`; `features._engine_git_sha` is recorded because config versioning does not protect against code drift.
- **Mode A (regression):** re-run the _live_ rules version over stored inputs verbatim → must reproduce live decisions **bit-for-bit**. This is a CI test.
- **Mode B (counterfactual):** process signals chronologically per run; reuse stored `world` features and `quote_snapshot`, but **recompute `portfolio`-tagged features (exposure, open positions) from the run's own simulated fills** — under a different rules version, earlier decisions differ, so the live portfolio state would be an internally inconsistent counterfactual. Fills simulated by the same SimBroker fill/slippage code used in live paper mode (§7).
- `replay_run_metrics` (batch job + view): hit rate, avg bps/trade, profit factor, max drawdown, exposure-adjusted return per run — "compare rules v3 vs v7" has a defined output, not just raw rows.

**Exit management (signal-driven pipelines forget exits — this one doesn't):** the scheduled position-manager evaluates every open position against the exit policy in `rules_versions.config` — time-exit at the signal's `horizon` (mandatory), stop-loss bps, close-on-opposing-signal — writing `action=close` decision rows, so **exits are replayable under the same versioning machinery**. A protective stop is additionally placed at entry where the venue supports brackets. **Off-hours news: queue-for-open** (market-on-open) in v1; the intended session is recorded so analytics separate overnight-gap reactions from intraday ones.

### 5.5 Prices

**Decision answered: prices are stored locally, from day one.** Three reasons: decision-time bid/ask is not reconstructible from any affordable historical source; reaction analytics run constantly and shouldn't depend on vendor rate limits or entitlement windows; vendor terms drift (Polygon rebranded to Massive mid-2025 — exactly the dependency risk an immutable local record removes).

```sql
price_bars_1m (instrument_id, ts, o, h, l, c, volume, vwap, source, PRIMARY KEY (instrument_id, ts))
  PARTITION BY RANGE (ts)   -- monthly partitions
price_bars_1d (…)            -- small, kept forever; feeds beta/benchmarks
```

- **Equities recorder:** a 1-min Lambda calls Massive's **full-market snapshot** — one call returns every US ticker's latest minute bar (verified included on Starter; 15-min delayed, which is fine — reaction jobs are batch, not execution). Nightly reconciliation against Massive **flat files** (daily full-market minute CSVs, included in Starter, no rate limits) makes the canonical record.
- **Crypto recorder:** Kraken public REST OHLC every ~15 min (the endpoint returns the most recent 720 candles ≈ 12 h of 1-min — comfortable margin; no account needed). WS v2 replaces this at minutes-migration.
- **Backfill:** 2 years of equity minute bars from Massive flat files ($0 marginal — Starter includes 5 yr history); Kraken history from their downloadable CSVs or paginated Trades endpoint (**not** the OHLC endpoint — 720-candle cap makes it useless for backfill); Databento's $125 free credit is the insurance option.
- **Volume math:** ~500 sym × 390 bars/day + 3 × 1440 ≈ 55 M rows/yr ≈ <10 GB incl. indexes — trivially fine on micro-class Postgres with monthly partitions. Parquet compaction is a year-2 problem.
- **Decision-time quotes:** `quote_source='massive_delayed'` until IBKR NBBO flows (once the IBKR connection exists for market data), then `'ibkr_nbbo'`. **Spread-sensitive gates stay untuned until NBBO flows** — 15-min-delayed spreads are directional only.

### 5.6 Derived analytics (nightly batch; facts in, answers out)

Only `reaction_measurements` is materialized from day one (it feeds decision gates); everything else starts life as a SQL view and is materialized when actually slow.

```sql
reaction_measurements (cluster_id, instrument_id, horizon,   -- +5m +15m +30m +1h +4h +1d +3d +5d
  anchor_ts,                              -- cluster.first_received_at, NEVER published_at
  raw_return_bps, abnormal_return_bps,    -- beta-adjusted vs SPY (equities) / BTC (alts)
  benchmark, beta_used, bars_source, measurer_version)

reaction_summary (cluster_id, instrument_id,
  peak_abnormal_move_bps, time_to_peak_minutes,
  time_to_half_of_1d_move_minutes,        -- THE "how fast does the market react" scalar
  direction_1d)

recovery_measurements (cluster_id, instrument_id,            -- negative events only
  trough_bps, time_to_trough_hours,
  time_to_half_reversion_hours, time_to_full_reversion_hours,  -- NULL = never recovered in window
  window_days)

source_reliability_stats (source_id, period_month,
  items_total, clusters_first_in, scoop_rate, median_lag_from_first_ms,
  covered_cluster_direction_hit_rate_1d, avg_abs_abnormal_return_1d_bps, dup_only_rate)

news_bursts (VIEW: instrument_id, rolling window → n_signals, n_positive, n_negative,
             sum_materiality_signed, distinct_clusters)
```

---

## 6. How the schema answers each analytics question

1. **"Which source is not reliable?"** — `source_reliability_stats` separates three failure modes: never first (`scoop_rate`), always late (`median_lag_from_first_ms`), covers things that don't move markets (`avg_abs_abnormal_return_1d_bps`), or is a pure echo chamber (`dup_only_rate`). Echo contamination is designed against: a source that only republishes still "covers" moving clusters, which is why scoop rate and lag are separated from hit rate.
2. **"Duplicates mean popularity — how do we weight that?"** — popularity is `item_count`, `distinct_source_count`, and trailing items-per-hour, entering the pipeline **only as decision-engine features** (snapshotted into `decisions.features`; never fed to the LLM beyond the frozen count). Re-weighting popularity is therefore a `rules_versions` change — replayable over the whole signal history without a single new LLM call.
3. **"How fast does the market act — minutes/hours/days?"** — the `reaction_measurements` ladder at 8 horizons, anchored on `first_received_at`, sliceable by event_type/materiality/sector/source. `time_to_half_of_1d_move` is the scalar answer — and it doubles as the minutes-migration trigger (§4.7).
4. **"Multiple bad/good news in a week?"** — `news_bursts` counts signed signals per instrument per rolling window; the engine reads `signals_same_instrument_7d` as a feature, so "compounding bad news" can be a gate or a boost — a rules choice, replayable.
5. **"How fast does a stock recover from bad news?"** — `recovery_measurements` gives trough depth, time-to-trough, time-to-half/full reversion; grouped by event_type × sector it teaches, e.g., "guidance cuts half-revert in days; restatements don't."
6. **"Sector-level news affecting many stocks?"** — the LLM tags `scope=sector`; deterministic fan-out expands over point-in-time membership with per-instrument weights; every constituent gets its own decision and reaction rows, so propagation uniformity is itself measurable and `fanout_rules_version` is tunable empirically.
7. **"Other?"** — facts are append-only and versioned (`resolver_version`, `prompt_version`, `rules_version`, `measurer_version`, `fanout_rules_version`); a new question is a new batch job. Nothing upstream migrates.

**Calibration loop:** every signal (traded or skipped) joins to realized forward returns; a monthly calibration report buckets `confidence` by decile vs realized directional hit rate. `already_expected` is measured against the deterministic `calendar_match` feature — LLM judgment vs ground truth, per event type.

---

## 7. Broker & execution layer (Canada-adjusted)

**Three execution backends behind one interface, activated in sequence:**

1. **SimBroker (v1 default, stocks AND crypto).** Internal fill simulator: market orders fill at recorded ask/bid ± the explicit slippage model; limit/stop orders rest against the recorded quote stream and bar highs/lows. Deterministic, replayable, serverless — and **it is the same fill code replay Mode B uses**, so live-paper results and backtests are directly comparable by construction. External paper venues cannot offer that (their fill engines are a third, uncontrolled semantics).
2. **IBKR paper (pre-live integration stage).** Exercises the real order lifecycle, contract resolution, and error codes — the bug class SimBroker can never surface. Unattended-safe: paper credentials have no 2FA (verified). Reached via OAuth Web API if activation succeeds, else the gateway container.
3. **Live: IBKR (stocks) + Kraken (crypto)** — a config swap behind the same interface.

**The Kraken adapter is developed early and run continuously in `validate=true` mode** — verified as Kraken's official substitute for the missing spot sandbox: the full order is validated without touching the matching engine. Before go-live, a **dust-size live calibration phase** (~CA$5–15 orders; minimums verified: 0.00005 BTC / 0.001 ETH / 0.06 SOL, costmin CA$1; ≈4¢ taker fee per trade) measures real fills against the slippage model.

```ts
type CanonicalSymbol = { assetClass: 'us_equity' | 'crypto'; symbol: string };
type OrderIntent = {
  clientOrderId: string; // ULID — idempotency key, survives retries/restarts
  symbol: CanonicalSymbol;
  side: 'buy' | 'sell';
  qty: { type: 'shares' | 'notional'; value: string }; // decimal strings, never floats
  orderType: 'market' | 'limit' | 'stop' | 'stop_limit';
  limitPrice?: string;
  stopPrice?: string;
  tif: 'day' | 'gtc' | 'ioc';
  session: 'regular' | 'queue_for_open';
};

interface BrokerAdapter {
  placeOrder(intent: OrderIntent): Promise<OrderAck>;
  cancelOrder(brokerOrderId: string): Promise<void>;
  replaceOrder(brokerOrderId: string, patch: OrderPatch): Promise<OrderAck>;
  getOrder(ref: { brokerOrderId?: string; clientOrderId?: string }): Promise<OrderState>;
  listOpenOrders(): Promise<OrderState[]>;
  getPositions(): Promise<Position[]>;
  getAccountState(): Promise<AccountState>;
  getClock(): Promise<{ isOpen: boolean; nextOpen: string; nextClose: string }>;
  getSnapshot(symbols: CanonicalSymbol[]): Promise<Snapshot[]>; // execution-grade pre-trade check
  streamOrderUpdates(onEvent: (e: OrderEvent) => void): Promise<Unsubscribe>;
  capabilities(): BrokerCapabilities; // { fractional, notional, brackets, shorting, tifs, assetClasses }
  toVenueSymbol(s: CanonicalSymbol): string;
  fromVenueSymbol(v: string): CanonicalSymbol;
}

interface MarketDataProvider {
  // deliberately separate — data and execution venues diverge
  getBars(symbol, tf, from, to): Promise<Bar[]>;
  getQuote(symbol, asOf?): Promise<Quote>;
}
```

`capabilities()` is load-bearing with three venues of differing order-type support; strategy code must never assume venue-isms. The strategy layer never imports a broker SDK.

**Venue specifics (verified 2026-07-10):**

- **IBKR Canada:** IBKR Pro pricing only (Lite is US-only); paper account arrives automatically with an approved live account — so the live account is opened and modestly funded up front (market-data fees bill to it and are **shared to paper** after enabling sharing, ~24 h). Data: US Securities Snapshot bundle US$10/mo (waived at $30/mo commissions) + Streaming add-on US$4.50/mo for streaming NBBO. **No spot crypto for Canadian clients** (ETPs/futures only). TS client: `@stoqey/ib` (gateway path) or hand-rolled REST (OAuth path). Historical-data API pacing (60 req/10 min) disqualifies IBKR as a bulk bar source — event-window gap-filler at most.
- **Kraken Canada:** restricted dealer (Payward Canada, OSC principal regulator, all provinces/territories, April 2025); CAD funding via Interac. **Adapter constraints:** never send margin/leverage params (Canadians ineligible; futures too); SOL carries a CAD 30k rolling-12-month net-buy cap in non-exempt provinces (exempt: AB/BC/MB/QC/SK) — irrelevant at paper/dust scale, flagged for scale-up. Fees 0.25%/0.40% base, falling with volume. TS client: `kraken-api` (tiagosiebler/sieblyio suite); WS v2 order entry + `executions` channel at go-live.
- **Fallback broker if IBKR becomes untenable:** moomoo Canada — the only other real order-placement API for US stocks available to Canadians (OpenD local gateway daemon; retail-grade docs). Questrade blocks retail API orders (partner-only); Webull CA has no official API; tastytrade left Canada (June 2025).
- **Alpaca, for the record:** live brokerage is unavailable to Canadians (no CSA registration — verified); paper/data keys are technically obtainable, but order logic against a venue that can never go live is throwaway work — deliberately excluded.

---

## 8. Bias traps — enforced rules, not guidelines

1. **Look-ahead via timestamps.** `published_at` is source-claimed and frequently backdated (SEC filings especially). The trading path keys off `received_at` exclusively; reaction anchors use `first_received_at`; the data-access layer takes `asOf` and refuses newer rows.
2. **Survivorship.** No query joins "current S&P 500" — all universe access goes through point-in-time `index_membership`.
3. **LLM training-data leakage.** Signal-quality metrics count only forward-collected signals (`analyzed_at − received_at` small). Retrospective LLM runs are flagged and quarantined from reliability stats. Rule-replay over the stored signal log is always clean — the LLM ran live; only deterministic code re-executes. This is a core reason the signal log exists.
4. **Replay drift.** Spreads/prices/portfolio state are snapshotted at decision time; Mode B recomputes only portfolio-tagged features, from its own simulated fills. Engine git SHA is recorded per decision.
5. **Paper-fill optimism.** SimBroker fills are as honest as the slippage model; IBKR paper fills are top-of-book simulations. Paper P&L validates plumbing, not alpha — the calibration report and replay metrics are the evaluation surface.
6. **Delayed-quote distortion.** Until IBKR NBBO flows, `quote_source='massive_delayed'` marks every snapshot; spread-sensitive gates stay untuned.

---

## 9. Costs (USD/mo, verified 2026-07-10)

| Line                                                     | $/mo          | Notes                                              |
| -------------------------------------------------------- | ------------- | -------------------------------------------------- |
| RDS `db.t4g.micro` + 20 GB gp3                           | ~$14          | upsize on credit alarms only                       |
| Lambda + SQS + S3 + CloudWatch                           | ~$5–15        | mostly free tier; log retention 30 d               |
| EC2 for IB Gateway                                       | $0 or ~$15    | only if the OAuth path fails                       |
| Massive Stocks Starter                                   | $29           | news + snapshot + flat files + 5 yr minute history |
| IBKR market data (snapshot bundle + streaming add-on)    | $14.50        | $10 of it waived at $30/mo commissions once live   |
| LLM (Sonnet-only, prompt caching, ~300–900 clusters/day) | ~$40–90       | per-day spend breaker; earnings-season peaks 3–5×  |
| **Total v1**                                             | **~$100–185** | ≈ CA$135–250                                       |

Priced contingencies: Benzinga-on-Massive +$99 · X pay-per-use ≈$165–315 true cost (reads + LLM overhead) · Databento backfill $0 (within $125 credit) · minutes-migration ≈ +$100–120. AWS Budget alarm at $200 → kill switch.

---

## 10. Build order — milestones with verification gates

Do not start a milestone before the previous one's verification passes.

**M0 — Setup + ingest-only skeleton (week 1).**
Open the IBKR Canada account NOW (approval takes days; paper arrives automatically; submit the OAuth 1.0a self-service request in parallel — 24 h–2 wk activation). Subscribe Massive Starter. Build EDGAR + Massive-news + RSS pollers → S3/Postgres + clustering. **Zero LLM spend.**
_Verified when:_ 5 trading days of data collected; items→clusters ratio measured (this decides Sonnet-only vs triage); ~50 clusters hand-checked for correct echo-collapse.

**M1 — Entity resolution + point-in-time universe.**
Aliases, CIK mapping, membership backfill from fja05680/sp500, forward daily diff.
_Verified when:_ a ~100-item hand-labeled sample hits target precision/recall; a membership query for a random 2019 date matches known history.

**M2 — LLM signals.**
Sonnet structured outputs, `prompt_version` discipline, S3 audit trail, ~100-item golden set in CI (prompt changes are measured, never vibes).
_Verified when:_ golden-set accuracy passes; a live week of signals reads sane; daily cost inside budget.

**M3 — Price recording + reaction analytics.**
Massive snapshot recorder + nightly flat-file reconcile + Kraken poller + 2-yr backfill; `reaction_measurements` / `recovery_measurements` / `reaction_summary` jobs.
_Verified when:_ jobs reproduce known stylized facts (e.g., positive earnings-surprise drift) on our own collected events; bar row counts match expected market minutes.

**M4 — Decision engine, record-only.**
`rules_versions`, gates, feature+quote snapshots, decisions including skips; replay Mode A.
_Verified when:_ Mode A reproduces live decisions bit-for-bit in CI; skip-reason distribution is sensible (neither ~0% nor ~100% traded).

**M5 — Execution via SimBroker + safety rail.**
Order queue, execute Lambda, kill switch, reconciler, position-manager exits; Kraken adapter running `validate=true`.
_Verified when:_ a live news item flows end-to-end into a simulated position and out through an exit; kill-switch drill halts entries; injected position drift is caught; a duplicated queue message does not double-order.

**M6 — Replay Mode B + evaluation.**
`replay_run_metrics`, source-reliability rollup, `news_bursts`, calibration report, weekly report.
_Verified when:_ two rule versions replay over the same history into a comparable metrics report generated from real logged data.

**M7 — Pre-live stage (entered only when metrics justify).**
IBKR paper integration behind the same adapter; Kraken dust-size calibration phase; live cutover is a config swap gated on a human decision.

Rough solo effort: M0–M2 ≈ a focused week each; M3–M6 ≈ 1–2 weeks each — ~2–3 months part-time, with real analytics arriving from M3.

---

## 11. Risk register (epistemic and operational)

- **LLM look-ahead leakage** — the trap that invalidates most published LLM-trading backtests; mitigated by forward-collection discipline (§8.3).
- **Single-vendor concentration on Massive** — news + bars + backfill on one $29 subscription; mid-rebrand vendor. Mitigation: `SourceAdapter` seam, raw payloads owned in S3, Finnhub as live secondary, Tiingo/$29-class alternates priced.
- **IBKR OAuth path is semi-official** — could be closed; gateway container is the tested fallback; moomoo CA is the fallback broker.
- **Massive Starter snapshot field population** (whether `lastQuote`/`lastTrade` populate on delayed entitlement) **[re-check at build — test in month 1]**.
- **IBKR paper no-2FA** is community-verified, not documented by IBKR **[re-check at account setup]**.
- **Paper-fill optimism** — addressed by explicit slippage modeling + the dust-size live calibration phase.
- **Free-tier ToS drift** (Finnhub personal-use; Massive terms) — quarterly review, alternates priced.
- **Market efficiency itself** — the null hypothesis is that no exploitable edge exists at this latency; the system is built to establish that answer cheaply and honestly.
