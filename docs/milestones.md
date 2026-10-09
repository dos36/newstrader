# NewsTrader — Milestones

What each built milestone added, how it behaves, and why. Moved out of the top-level
[`README.md`](../README.md), which is now the operator runbook only.

**Companion docs:** [`roadmap.md`](roadmap.md) (status table, what is left — its §1 explains why the
numbering skips and reorders: M2 was built after M4) · [`business-logic.md`](business-logic.md)
(every rule and threshold with its reason) · [`codebase-guide.md`](codebase-guide.md) (where the code
lives).

| Milestone                                                   | What it added                                                  |
| ----------------------------------------------------------- | -------------------------------------------------------------- |
| [M0](#milestone-0-what-it-measures-and-why)                 | Ingestion + clustering; measures volume and echo ratio         |
| [M1](#milestone-1-the-universe-and-entity-resolution)       | Point-in-time S&P 500 universe + deterministic entity resolver |
| M2                                                          | LLM interpretation — see [`roadmap.md`](roadmap.md) §3         |
| [M3](#milestone-3-prices-reaction-analytics-calendars)      | Price bars, reaction analytics, scheduled-event calendars      |
| [M4](#milestone-4-the-decision-engine-simbroker-and-replay) | Pure decision engine, SimBroker paper execution, replay        |
| [M5](#milestone-5-evaluation-and-reporting)                 | Signal calibration, latency pricing, weekly report             |

---

## Milestone 0: what it measures, and why

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
the SAME label the live decisions were produced under (Mode A, the default) must reproduce them
bit-for-bit (CI-gated, including one real-engine assertion in the CLI e2e suite — not just the
stub engine in the DB package's own regression test). Replaying a DIFFERENT label needs Mode B:
`replay --mode b` keeps every WORLD feature (velocity, calendar, prices, liquidity) from the live
snapshot but recomputes the PORTFOLIO features (open positions, equity) from the run's OWN
simulated fills — production fill model, exits walked over recorded bars between decisions — and
writes a `replay_run_metrics` row (hit rate, avg bps/trade, profit factor, max drawdown,
exposure-adjusted return). The world/portfolio split is tagged in
`packages/core/src/trading/contracts.ts` (`WORLD_FEATURE_KEYS` / `PORTFOLIO_FEATURE_KEYS`) and a
test fails if a new feature is added untagged. Running a cross-label replay WITHOUT `--mode b`
still prints the `mode_b_unsound_portfolio_features` warning rather than presenting
reused-portfolio results as trustworthy. `replay:compare --a <run|live> --b <run|live>` diffs any
two runs (action / size / skip-reason changes); a `live` side is scoped to one rules version via
`--live-rules <label>` (defaults to the other side's own label).

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

## Milestone 5: evaluation and reporting

**`eval:signals` answers "does the LLM's output mean anything".** It joins `llm_signals` to
`reaction_measurements` (pinned to one `measurer_version`, default `m2`) and prints: confidence
deciles vs 1d directional hit rate with Wilson 95% CIs and the Expected Calibration Error;
materiality deciles vs median |1d abnormal| plus Spearman rank correlations for materiality and
`expected_move_bps`; per-event-type hit rates and big-move shares; neutral signals scored
separately (`hit = |abn 1d| < 100 bps`, with 50/150 sensitivity); reaction speed (median minutes
to half the 1d move) and capture ratios `abn_h/abn_1d`; and the **event-study → whitelist bridge**
— direction-signed drift per event type × horizon with a "beats costs?" verdict (`--cost-bps`,
default 20; a YES additionally requires n ≥ 20). Every table can be cut to one NY-session bucket
(`--session weekend|pre|rth|post|overnight`, computed in SQL from the anchor at
`America/New_York`) — the `rth` cut is the market-hours-only alpha-decay number the
minutes-migration decision needs. Hygiene defaults: transport `api` only, retrospective rows
excluded (`--include-retrospective` to override, e.g. for a v2+ prompt that reconstructs inputs at
the observation lag), and every table carries a cluster-deduped robustness column (max-confidence
pair per cluster). `--versions a,b` compares prompt versions side by side on the intersection of
answered pairs, with a paired direction-flip/confidence-delta table; `--split <iso> [--holdout]`
gives a tune/holdout discipline. The report also prints a **next-open reaction** table for
off-hours anchors: anchor settled close → close of the first RTH bar at/after the next 09:30 ET,
beta/SPY-adjusted, with `gap_capture = next-open abnormal / 1d abnormal` (query-level; promote to
a `m3` measurer only if it proves useful).

**`eval:latency` prices our ingestion delay in bps.** The measurer writes every pair under two
clocks (`m2` = received, `m2-pub` = published); the per-pair, per-horizon difference between the
two abnormal-return curves is what latency costs — the evidence that decides whether the $99/mo
Benzinga add-on pays (roadmap §7).

**`report:weekly` renders the operator's markdown digest** — paper P&L, the decision funnel with
rejected-signal counts by gate, hit rate by event type, the calibration table, and the best/worst
closed trades with the LLM's own ≤2-sentence reasoning attached (`--out <file>` writes it to
disk).
