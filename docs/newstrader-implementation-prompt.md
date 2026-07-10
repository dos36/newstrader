# Implementation prompt: NewsTrader v1 (TypeScript / AWS / Canada)

*Version 2 — supersedes the earlier Python-stack draft. Companion document: `newstrader-architecture.md` (same folder) — where this prompt and the architecture doc disagree, the architecture doc wins.*

---

You are a senior software engineer with quant-research experience. Build **NewsTrader**, an event-driven research and paper-trading system. It ingests financial news, uses an LLM to interpret each novel story into a structured signal, decides trades with deterministic rules, and executes them against simulated/paper backends.

The primary goal is **measurement, not profit**: the system must let us rigorously determine whether LLM news interpretation produces a tradeable edge after costs. Favor auditability and honest evaluation over cleverness, everywhere.

Ask clarifying questions before coding if any requirement below is ambiguous or conflicts.

## 1. Hard constraints

- **Language:** TypeScript (Node 22), pnpm workspace monorepo. **Infra:** AWS via CDK (TypeScript). **DB:** Postgres (drizzle ORM + migrations).
- **Owner is a Canadian resident.** Brokers: IBKR Canada (stocks, paper first), Kraken (crypto, live later). Alpaca must NOT appear anywhere — it is unavailable to Canadians as a broker.
- **Paper trading only. There must be no real-money code path in v1** — going live must require a code change, not a config flag.
- **Direction:** long-only execution in v1. Short signals ARE still generated, logged, and evaluated so backtests can decide whether shorting is worth enabling.
- **The LLM boundary is non-negotiable:** the LLM converts news text into a structured signal and does nothing else. It never sizes positions, never calls broker APIs, never sets risk parameters, never sees account state. All money decisions are deterministic, unit-tested code.
- **Facts are append-only.** Raw items, signals, decisions, orders, fills, bars: immutable rows; state transitions are new rows (`order_events`), never UPDATEs. Positions/P&L are SQL views.
- **Milestone discipline:** build in the order of §8; do not start a milestone before the previous one's verification gate passes.

## 2. Pipeline (target shape)

```
EventBridge Scheduler (1–5 min) ─► poller Lambdas ─► S3 raw/ + SQS q-items
q-items ─► process Lambda: dedup/cluster → entity-resolve → LLM interpret → decide() ─► q-orders
q-orders ─► execute Lambda: kill-switch check → active BrokerAdapter (SimBroker in v1)
Scheduled: bars-recorder (1m) · position-manager (5–15m exits) · reconciler (15m)
         · nightly analytics jobs · weekly report
```

- **Pollers do three things only:** fetch since cursor (cursor in Postgres), write raw payload to S3 (`raw/{source}/{date}/{hash}.json`), enqueue a pointer. No parsing, no LLM.
- **Idempotency comes from Postgres unique constraints, not the queue** (SQS Standard everywhere): `(source_id, external_id)` on raw items; `(cluster_id, target, prompt_version, model_id)` on signals; `(signal_id, rules_version_id, replay_run_id)` on decisions; deterministic `client_order_id` (ULID derived from decision id) at the broker. Every queue has a DLQ with an alarm; a DLQ message is a bug.
- **No VPC.** RDS `db.t4g.micro` publicly accessible with TLS required + strict security-group allowlist; all Lambdas outside any VPC (avoids NAT/endpoint costs). Secrets in SSM Parameter Store SecureString. Reserved concurrency ~5 on the process Lambda.
- **Kill switch:** SSM param `/newstrader/kill-switch` checked by decide + execute (≤30s cache). Trip paths: CLI, AWS Budget 100% alarm, reconciler drift, execute-DLQ alarm, daily LLM spend breach. Tripped ⇒ decide keeps recording decisions flagged `suppressed=true`; execute emits nothing.

## 3. Sources (v1)

| Source | Access | Notes |
|---|---|---|
| SEC EDGAR | `getcurrent` Atom poller, 1-min cron | 8-K first (route deterministically by item code — 2.02, 5.02, 4.02, 1.03, 2.01, 2.05, 2.06, 3.01, 1.01/1.02; 7.01/8.01 go to the LLM), then Form 4, 13D/G. ≤10 req/s, mandatory User-Agent with contact email. CIK→ticker via `company_tickers.json`. |
| Massive (ex-Polygon) news API | REST poll 1–2 min, Stocks Starter ($29/mo) | Primary tagged news feed. Store their ticker tags + sentiment as source-provided hints, not truth. |
| Finnhub free | REST | Breaking-news side feed + earnings calendar (feeds `calendar_match`). Never use it for price bars. |
| Macro calendars | monthly scrape of Fed/BLS/BEA schedules | Deterministic `calendar_match` decision feature. |
| GlobeNewswire RSS | poll 1–5 min | Redundancy + latency yardstick. |
| Crypto RSS (CoinDesk/Cointelegraph/The Block) | poll 2–5 min | 3-coin universe makes entity resolution trivial. |

No X/Twitter in v1. No Alpaca anywhere. Design `SourceAdapter` (`fetchSince(cursor) → RawItem[]`) so push-based sources drop in later.

## 4. Data model (implement exactly; see architecture doc §5 for column-level detail)

**Facts:** `news_sources` · `raw_news_items` (payload in S3; `content_hash`; **`published_at` = claimed, `received_at` = our clock — the ONLY clock the trading path may use**) · `news_clusters` + `news_cluster_items` (dedup: exact hash → pg_trgm/MinHash ~0.7 blocked by shared-instrument ∩ 48h window; **advisory lock per block** so concurrent consumers can't mint duplicate clusters) · `instruments` / `index_membership` (**point-in-time S&P 500**; backfill fja05680/sp500) / `instrument_aliases` (point-in-time) / `item_instrument_links` (method, confidence, `resolver_version`) · `llm_signals` (typed columns: event_type, scope company|sector|macro, direction, expected_move_bps, horizon, already_expected, materiality, confidence; model_id, prompt_version; prompt/response S3 keys; token cost; `cluster_item_count_at_analysis`; `retrospective` flag) · `signal_fanout` (deterministic sector fan-out; macro = record-only v1) · `rules_versions` (immutable jsonb config + hash) · `decisions` (one row per evaluation INCLUDING skips: `gates` jsonb with every gate's pass/observed/threshold; `features` jsonb with each feature tagged `world`|`portfolio`; `quote_snapshot` with `quote_source`; `replay_run_id` NULL = live; `suppressed`) · `orders`/`order_events`/`fills` (venue: sim|ibkr_paper|ibkr|kraken) · `price_bars_1m` (monthly partitions) / `price_bars_1d`.

**Derived (nightly jobs; only the first is materialized up front, rest are views):** `reaction_measurements` (abnormal return, beta-adjusted vs SPY/BTC, at +5m/+15m/+30m/+1h/+4h/+1d/+3d/+5d, anchored on `first_received_at`) · `reaction_summary` (time_to_peak, time_to_half_of_1d_move) · `recovery_measurements` (trough, time-to-half/full reversion) · `source_reliability_stats` (scoop rate, median lag, hit rate, dup_only_rate) · `news_bursts` view (signed signal counts per instrument per rolling week).

**Prices are recorded locally from day one:** equities via a 1-min Lambda calling Massive's full-market snapshot (one call, all tickers' latest minute bar, 15-min delayed — fine, analytics are batch), reconciled nightly against Massive flat files; crypto via Kraken public REST OHLC every ~15 min (720-candle window). Backfill 2 years from Massive flat files. Decision-time `quote_snapshot` captured on every decision (`quote_source='massive_delayed'` until IBKR NBBO is available).

## 5. LLM stage

- **Anthropic API direct** (`@anthropic-ai/sdk`), **Sonnet-only** with structured outputs validated by zod; a parse failure is a poison pill → DLQ. Add a Haiku triage stage ONLY if milestone-0 measurement shows >~500 novel clusters/day.
- Prompt caching on the fixed system prompt. Persist every call: parsed fields to `llm_signals`, full prompt + raw response to S3, tokens/cost/latency columns.
- One call per **novel cluster × resolved target** — never per raw item (dedup runs first). Input: article text + ticker context (sector, recent move since `first_received_at`). Output: the signal schema above, plus ≤2-sentence reasoning summary.
- Per-day spend circuit breaker (SSM-config threshold) wired to the kill switch.
- `prompt_version` is stamped on every signal; re-prompting inserts new rows, never updates.

## 6. Decision engine, risk, and exits (all deterministic, all in `packages/core`, zero AWS imports)

- `decide(signal, features, quote_snapshot, rulesConfig) → decision` is a **pure function**. Every gate records pass/fail + observed + threshold, even after the first failure. Skips are recorded with `skip_reason`.
- **V1 gates (thresholds in `rules_versions.config`, all replayable):** direction bullish (long-only) · `already_expected=false` · confidence ≥ 0.7 · event_type in the whitelist populated by the event-study data (an event type qualifies only when its measured post-news drift beats assumed costs) · stale-move check (price moved < X% since `first_received_at`; default 3%) · liquidity floor (20-day median dollar volume) · market-session policy (off-hours news ⇒ `queue_for_open`, recorded) · burst feature available as a gate/boost (`signals_same_instrument_7d`).
- **Sizing:** fixed-fractional (25–50 bps of paper equity at risk per trade), volatility-scaled (20-day ATR). No confidence-proportional sizing in v1 — log what it *would* have done.
- **Exits:** scheduled position-manager — time-exit at signal `horizon` (mandatory), stop-loss bps, close-on-opposing-signal — writing `action=close` decision rows (exits replayable). Protective stop placed at entry where the venue supports brackets.
- **Portfolio limits:** max 10 concurrent positions, 1 per ticker, max 30% per sector; 2% daily drawdown kill switch.
- **Reconciler:** every 15 min, diff broker/sim positions + open orders vs local state; any drift → kill switch + alert.

## 7. Execution backends (`BrokerAdapter` in `packages/adapters`)

Implement the `BrokerAdapter` + `MarketDataProvider` interfaces from the architecture doc (§7) — canonical types, `clientOrderId` idempotency, `capabilities()`, decimal strings, strategy layer never imports a venue SDK.

1. **SimBroker (v1 default, stocks + crypto):** fills against recorded quote snapshots/bars + an explicit slippage model. **The same fill code is used by replay Mode B** — one implementation, imported by both.
2. **IBKR paper (pre-live, milestone 7):** try the OAuth 1.0a Web API self-service path first (works for individual paper accounts; pure HTTPS, no container); fallback `gnzsnz/ib-gateway-docker` + IBC on small EC2 (paper credentials have no 2FA). US-listed products only.
3. **Kraken (crypto, live later):** build the adapter early and run it in **`validate=true`** mode continuously (Kraken's official sandbox substitute). NEVER send margin/leverage params (Canadians ineligible). TS client: `kraken-api` (tiagosiebler suite).

## 8. Build order — milestones with verification gates

0. **Setup + ingest-only skeleton (week 1).** IBKR account opened (human task, flag it); Massive Starter subscribed. EDGAR + Massive + RSS pollers → S3/Postgres + clustering. ZERO LLM spend. *Gate:* 5 trading days collected; items→clusters ratio measured; ~50 clusters hand-checked.
1. **Entity resolution + PIT universe.** *Gate:* ~100-item hand-check precision/recall; a 2019 membership query matches history.
2. **LLM signals + golden set.** ~100 hand-labeled items in CI; prompt changes must not regress. *Gate:* golden set passes; a live week of signals reads sane; cost in budget.
3. **Price recording + reaction analytics.** Recorder, backfill, reaction/recovery jobs. *Gate:* known stylized facts reproduce (e.g., positive earnings-surprise drift) on own data.
4. **Decision engine, record-only.** No orders yet. Replay **Mode A**: re-running the live rules version over stored inputs reproduces live decisions **bit-for-bit** (CI test). *Gate:* Mode A passes; skip-reason distribution sensible.
5. **Execution via SimBroker + safety rail.** Kill switch, reconciler, position-manager, Kraken validate-mode adapter. *Gate:* live news → simulated position → exit end-to-end; kill-switch drill; injected drift caught; duplicate message doesn't double-order.
6. **Replay Mode B + evaluation.** Counterfactual replay (chronological, per-run simulated portfolio; `world` features reused, `portfolio` features recomputed from the run's own fills; `signal_filter {prompt_version, model_id}` respected), `replay_run_metrics` (hit rate, bps/trade, profit factor, max drawdown), source-reliability rollup, calibration report (confidence deciles vs realized hit rate), weekly markdown report. *Gate:* two rule versions produce a comparable metrics report from real data.
7. **Pre-live (human-gated):** IBKR paper behind the same adapter; Kraken dust-size calibration; live cutover is a config swap plus a code change removing the paper-only guard.

## 9. Testing requirements

- Unit tests for ALL deterministic logic: every gate, sizing math, exit policy, dedup thresholds, advisory-lock clustering, as-of data access (must refuse `received_at > asOf`), idempotency conflict paths.
- Golden-set LLM eval in CI; fail the build on accuracy regression vs the previous prompt version.
- Replay Mode A bit-for-bit determinism test in CI.
- One end-to-end test: fixture article → mocked LLM → expected order intent, exercising the full pipeline in-process.
- Every stage runnable locally: docker-compose `postgres:16`, pure handlers, CLI runner over fixtures. No LocalStack.

## 10. Non-goals for v1

No real money, no shorting execution, no options/futures, no margin, no X/Twitter, no websocket/streaming consumers, no Fargate, no VPC, no fine-tuning, no embeddings (trigram clustering first), no Parquet/lake, no web UI (CLI + markdown reports).

## 11. Deliverables

- The pnpm workspace per the architecture doc §4.6 (infra / services / packages/core / packages/db / packages/adapters).
- README runbook: setup, deploy, run each stage locally, run a replay, read the weekly report, trip/reset the kill switch.
- `.env.example`, docker-compose, Makefile (or pnpm scripts) for the common commands.
- `RISKS.md` mirroring the architecture doc's risk register (LLM look-ahead leakage, vendor concentration on Massive, IBKR OAuth semi-official status, paper-fill optimism, delayed-quote distortion, survivorship, free-tier ToS drift).
