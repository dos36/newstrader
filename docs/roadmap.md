# NewsTrader — Roadmap, Open Work, and Idea Parking Lot

_Last updated: 2026-08-28, after the M5 build (all seven §4 build-list items).
This is the **forward-looking** doc: what is left, what was deliberately deferred, and every idea we
do not want to lose._

**Companion docs:** [`business-logic.md`](business-logic.md) (why the rules are what they are) ·
[`codebase-guide.md`](codebase-guide.md) (how the code is organized) ·
[`newstrader-architecture.md`](newstrader-architecture.md) (the original approved design and all
verified vendor research) · [`../README.md`](../README.md) (operator runbook).

---

## 0. How to use this doc

Three rules for whoever picks this up next:

1. **Nothing here is "just an idea I had."** Every item is either a promise the architecture doc
   made that the code has not kept yet, a decision we deliberately postponed with a stated trigger,
   or a limitation we measured and accepted. Deleting an item is a decision, not cleanup.
2. **Check §2 before planning anything.** Several items are blocked on data that is still
   accumulating, or on a human/vendor step that only Oleh can do.
3. **The milestone numbering in the architecture doc §10 is historical.** It described a plan;
   the build diverged (see §1). Use the table in §1 as the source of truth for what exists.

---

## 1. Where the build actually stands

| Milestone (as built)                  | Status | Notes                                                                                                                                                                                                                                                              |
| ------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M0 — ingest + clustering              | ✅     | 9 sources live; dedup/clustering running; volume being measured                                                                                                                                                                                                    |
| M1 — entity resolution + PIT universe | ✅     | 503 S&P members + 3 coins; r1 resolver; membership **history backfill still missing**                                                                                                                                                                              |
| M3 — prices + reaction analytics      | ✅     | Bars recorder + backfill; reaction/recovery/summary; two measurer clocks (`m1`, `m1-pub`)                                                                                                                                                                          |
| M4 — decision engine + SimBroker      | ✅     | Pure `decide()`, rules-as-data, SimBroker, replay **Mode A only**, kill switch, exits                                                                                                                                                                              |
| M2 — LLM interpretation               | ✅     | **Built 2026-08-09** — sweep + CLI + Lambda (see §3); golden-set labeling is the human rest                                                                                                                                                                        |
| **M5 — evaluation & reporting**       | ✅     | **Built 2026-08-28** — Mode B, `replay_run_metrics`, whitelist bridge, calibration (`eval:signals`), weekly report, session-cut alpha decay, latency pricing (`eval:latency`). Still open from the §4 question table: `source_reliability_stats` and `news_bursts` |
| M6/M7 — IBKR paper, Kraken, go-live   | ❌     | Human-gated on metrics; IBKR OAuth keys generated, activation not complete                                                                                                                                                                                         |

**The numbering mismatch, explained once:** the architecture doc planned M4 = decision engine
_record-only_ and M5 = execution. We built both together as "M4" because SimBroker execution is
pure code with no external venue and splitting them would have meant two review passes over the
same money path. The doc's M6 (Mode B + evaluation) is what this doc calls M5.

---

## 2. Blocked / human-only tasks (do these first — they gate everything else)

| Task                      | Why it blocks                                                                                        | Status                                                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deploy to AWS**         | Local three-terminal operation loses crypto minute bars (Kraken keeps only ~12 h) and stops on sleep | Ready — stacks synth clean; needs AWS creds + one-time SSM params                                                                                                                                        |
| **IBKR OAuth activation** | 24 h–2 weeks of vendor lead time; blocks all of M6                                                   | Keypairs generated in `secrets/ibkr/`; registration not confirmed. **Decision 2026-08-09: deliberately deferred** — kick off registration when M5 metrics start looking real; nothing before M6 needs it |

Resolved since the last update, for the record:

- **`FINNHUB_API_KEY` is set and the earnings calendar is live (2026-08-09).** The forward window
  is synced and the collection window is backfilled from 2026-07-10 via the new
  `calendar:sync --backfill-from` — backfilled rows carry `meta.backfilled: true` so M5 analytics
  can tell after-the-fact ground truth from knowledge the live path actually had. Two measured
  free-tier traps are now handled in code (details in the architecture doc's vendor table): the
  earnings endpoint **silently caps responses at 1,500 rows keeping the latest dates** — the first
  naive 90-day sync got only the last ~9 days, which is why the fetcher now chunks requests and
  halves any chunk that comes back at the cap — and **history is served only ~30 days back**
  (rolling), which is why the backfill floor is 2026-07-10 and why waiting longer would have
  permanently lost earnings ground truth for the collected news window.

- **The Massive Stocks Starter entitlement works** (snapshot + unlimited aggregates verified live),
  which unblocked equity bar recording and the AWS deploy.
- **The "need a clean trading week" blocker is closed.** ~14 days of continuous collection now
  exists (18,248 items → 10,059 clusters, 2.0M minute bars). It answered the M2 triage question
  (§3) and makes the alpha-decay re-measurement possible.

---

## 3. M2 — LLM interpretation (BUILT 2026-08-09)

**Shipped.** `pnpm cli interpret` (+ `--loop`) locally; `interpret-sweep` Lambda every 5 min in
the trading stack (warn-skips until `/newstrader/anthropic-api-key` exists). One
`claude-sonnet-5` structured call per novel cluster × instrument pair (link ≥ 0.75), idempotent
on `signal_key`, written via `persistSignal()`; decide-sweep picks the rows up unchanged.

How the build list landed (deviations noted, none silent):

1. **Interpreter** — `@anthropic-ai/sdk` behind a narrow `LlmClient` seam
   (`packages/db/src/llm/`), structured output constrained by the zod schema in
   `packages/core/src/interpret/` (closed 19-value event taxonomy — free text would fragment the
   M5 whitelist bridge). Input: headline + per-source LEDE from the raw store (bodies are not
   stored anywhere — headline+lede was the roadmap's own cost lever), instrument context, and
   move-since-anchor computed by the SAME decide-repo helpers the stale-move gate uses, with a
   prompt rule forbidding its use for direction.
2. **Prompt registry** — versions are immutable data: registry entry = system text + model +
   effort + max_tokens; a sha256 hash-pin test fails the build if a published version's text is
   edited instead of minting a new one.
3. **Audit trail** — one blob per ATTEMPT (successes and failures) with full system+user prompt,
   raw response, usage: `llm/{date}/{sha16(signal_key)}.json` via the RawStore seam (FsRawStore
   locally, the previously-unwired `LlmAuditBucket` deployed). Ref lands in both
   `prompt_ref`/`response_ref`; token/cost/latency columns populated.
4. **Golden set** — harness shipped as an opt-in eval (`RUN_GOLDEN_EVAL=1`, real API, ~$0.15) with
   per-field accuracy vs a committed per-prompt-version baseline. **There is no CI in this repo**
   (all "in CI" doc mentions were aspirational), so this is the documented manual gate for prompt
   changes until CI exists. 15 machine-drafted starter rows from live clusters are committed
   flagged `reviewed: false` — **Oleh: review labels** (`packages/db/src/llm/__fixtures__/GOLDEN-README.md`);
   growing to ~100 labeled rows stays the human task.
5. **Spend safety** — per-UTC-day cap over SUM(cost_usd) (`LLM_DAILY_SPEND_USD_CAP`, default $5:
   ~2.5× the expected average day, so only an earnings-season 3–5× peak or a runaway trips it),
   plus the interpreter reads the kill switch exactly like decide/execute (halt ⇒ zero calls).
   The deployed spend-breach → kill-switch SNS wiring still attaches at deploy time (ops topic is
   exported for exactly that).
6. **`retrospective` column** — migration 0007, enforced BOTH directions: the live sweep only
   sees a bounded lookback window (24 h default; older needs an explicit
   `--retrospective-from/-to` which stamps the flag), and `loadUndecidedSignals` now EXCLUDES
   retrospective rows — before this, a backfilled signal would have reached the money path (the
   query had no freshness filter at all).
7. **Item-code routing** — moot as routing (Sonnet-only, no triage tier to skip), but
   `meta.itemCodes`/`formType` ride into the prompt with deterministic taxonomy hints
   (2.02→earnings_result etc.; 7.01/8.01 deliberately unhinted).

Also landed, unplanned: `llm_attempts` (migration 0007) — the poison-pill cap. A content-level
failure (refusal/truncation/schema) burns one of 3 attempts per signal_key and never writes a
signal row; TRANSPORT errors abort the pass without burning attempts, so an Anthropic outage
cannot poison healthy candidates. A new prompt_version resets the budget by construction.

### The triage decision — ANSWERED by 14 days of data: Sonnet-only, no triage tier

**Measured 2026-07-24 over the full collection window.** The architecture rule was: Sonnet-only
unless volume exceeds ~500 novel clusters/day. Raw cluster volume looks alarming at **~719
clusters/day**, but that is the wrong denominator — **a cluster with no resolved instrument has no
tradeable target and must never reach the LLM.** Filtering to clusters carrying a link at ≥0.75
confidence:

| Metric                                    | Measured             |
| ----------------------------------------- | -------------------- |
| All clusters                              | 10,059 (~719/day)    |
| Clusters with a tradeable instrument link | 1,348 (**~96/day**)  |
| Cluster × instrument pairs (= LLM calls)  | 2,512 (**~179/day**) |

**~179 calls/day is roughly a fifth of the triage threshold.** Estimated cost at Sonnet pricing with
~2,500 input / ≈400 output tokens per call and prompt caching on the fixed system prompt:
**≈$50–75/month**, inside the budgeted $40–90 band. **Decision: ship Sonnet-only.** Do not add a
second model, a second prompt to version, and a second failure mode for a problem the data says we
do not have. Re-check if the universe expands or the link threshold is lowered.

**Keep these cost levers regardless, in this order:**

- Interpret only clusters with ≥1 instrument link at ≥0.75 — this _is_ the gate above, and it
  discards ~87% of clusters. Enforce it explicitly in the M2 query rather than relying on luck.
- Route 8-Ks by item code (free, deterministic; codes already arrive in `meta.itemCodes`).
- Prompt caching on the fixed system prompt (~90% off the cached portion).
- Headline + lede rather than full bodies on the first pass.

### Open questions for M2 — all three RESOLVED at build time (2026-08-09)

- **Price action in the prompt: yes, fenced.** The move since anchor is rendered under an explicit
  "for already_expected ONLY — never for direction" header, and the system prompt repeats the
  prohibition. Same helpers as the stale-move gate, so interpret and decide can never disagree
  about the price.
- **Sector and macro scope: company-only in v1, as decided.** The interpreter only ever emits
  `scope='company'` rows; `signal_fanout` still does not exist and macro remains record-only.
  Nothing new to decide — revisit with M5 evidence.
- **Reasoning summary: a real column.** `llm_signals.reasoning` (migration 0007), ≤2 sentences
  enforced by the output schema — queryable for the calibration review and the weekly report,
  with the full blob still in the audit trail.

---

## 4. M5 — evaluation and reporting (the payoff milestone)

This is where the questions from the very first conversation get answered. **Two of them are still
completely unbuilt**, and they were the user's original asks — do not let them slip:

| Original question                            | What is needed                                                                                                      | Status |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------ |
| "Which source is not reliable?"              | `source_reliability_stats` rollup: scoop rate, median lag from first, direction hit rate, `dup_only_rate`           | ❌     |
| "Multiple bad/good news in a week?"          | `news_bursts` view + a `signals_same_instrument_7d` decide feature (the feature does not exist in `DecideFeatures`) | ❌     |
| "How fast does the market react?"            | `reaction_summary` — **built**, needs a clean week to be honest                                                     | ✅     |
| "How fast does it recover?"                  | `recovery_measurements` — **built**                                                                                 | ✅     |
| "Duplicates = popularity, how to weight it?" | Cluster velocity features — **built and snapshotted**; the weighting is a rules change, replayable                  | ✅     |
| "Sector news affecting many stocks"          | Needs `signal_fanout` (see §3)                                                                                      | ❌     |

### Build list — ALL SEVEN BUILT 2026-08-28

1. ✅ **Replay Mode B (counterfactual).** `DecideFeatures` is now tagged
   (`WORLD_FEATURE_KEYS` / `PORTFOLIO_FEATURE_KEYS` in core's trading contracts, with a partition
   test that fails when a new feature is added untagged). `replay --mode b` reuses world features
   from each live snapshot, recomputes the portfolio slice from the run's OWN simulated fills
   (BacktestLedger + the shared exit walker in `packages/db/src/backtest/exits.ts`), and is
   deterministic on re-run. A cross-label Mode A replay still warns
   (`mode_b_unsound_portfolio_features`) instead of pretending to be sound.
2. ✅ **`replay_run_metrics`** (migration 0011) — hit rate, avg bps/trade, profit factor, max
   drawdown, exposure-adjusted return per run; pure math in `packages/core/src/eval/metrics.ts`,
   written by Mode B replays AND backtests (conflict-do-nothing; a rerun keeps the original row).
3. ✅ **The event-study → whitelist bridge** — the `eval:signals` whitelist-bridge table:
   direction-signed mean/median abnormal drift, hit rate, and n per event type × horizon, with a
   "beats costs?" verdict (`--cost-bps`, default 20 bps; YES additionally requires n ≥ 20).
4. ✅ **Calibration report** — `eval:signals`: confidence deciles vs directional hit rate with
   Wilson 95% CIs and ECE (plus cluster-deduped robustness columns), materiality deciles and
   Spearman correlations, neutral signals scored separately, and the `already_expected` ×
   `calendar_match` cross-table per event type. Prompt A/B via `--versions` (intersection of
   answered pairs + paired flip/confidence-delta table); tune/holdout via `--split/--holdout`.
5. ✅ **Weekly markdown report** — `report:weekly` (pure renderer + SQL collector): P&L, decision
   funnel with rejected-signal counts by gate, hit rate by event type, calibration table,
   best/worst trades with the LLM's reasoning.
6. ✅ **Market-hours alpha decay** — every `eval:signals` table carries a NY-session cut
   (weekend/pre/rth/post/overnight computed in SQL); `--session rth` is the undistorted
   minutes-migration trigger series. Also new: a next-open reaction metric for off-hours anchors
   (anchor close → first RTH bar ≥ next 09:30 ET, beta/SPY-adjusted, with gap_capture) —
   query-level, promote to an `m3` measurer only if it proves useful.
7. ✅ **Ingestion-latency pricing** — `eval:latency`: per-pair delta between the `m2-pub` and `m2`
   abnormal-return curves per horizon and per first source, plus median latency seconds — the
   Benzinga evidence.

---

## 5. Safety and correctness work before real money

None of this is needed while the venue is SIM, all of it is needed before a live dollar.

1. **The reconciler does not exist.** The architecture specifies a 15-minute job diffing broker
   positions/open orders against local state, tripping the kill switch on drift. It was specified
   in v1 precisely because it should be built while stakes are zero. **Highest-priority safety gap.**
2. **Portfolio risk gates specified but not built:** max sector exposure (30%) and a 2% daily
   drawdown kill switch. Built today: max concurrent positions, one position per instrument.
3. **`asOf` data-access guard.** The architecture requires the data-access layer to take an `asOf`
   and _refuse_ rows with `received_at > asOf` — look-ahead protection enforced in code, not
   convention. Today the discipline is honored by hand in each query. A guard would make
   look-ahead structurally impossible.
4. **Close-on-opposing-signal exit** — specified, not built (only time stop + ATR stop + optional
   take-profit).
5. **Shadow-log confidence-proportional sizing.** Specified: keep fixed-fractional sizing, but log
   what confidence-weighted sizing _would_ have done, so the upgrade is evidence-based.
6. **`RISKS.md`** was a named deliverable and never written. The risk register lives in
   architecture §11 — either promote it to its own file or formally drop the requirement.

### Two schema constraints that are deliberate booby traps — they MUST be dropped at go-live

Both exist to make v1 mistakes impossible, and both will cause confusing failures the moment a real
broker appears. Whoever does the IBKR/Kraken work needs to know they are there:

- **`fills_order_id_unique`** enforces exactly one fill per order, which holds only because SimBroker
  always fills market orders completely. **A real venue produces partial fills**, and the second fill
  on an order will violate this index. Drop it in the same migration that adds the first real
  `BrokerAdapter`, and test position derivation against multi-fill orders before doing so.
- **`orders_venue_sim_ck`** restricts `orders.venue` to `'sim'`. This constraint is what makes "no
  real-money code path" a database guarantee rather than a promise. **Dropping it is the moment that
  safety property ends**, so it deserves its own migration, in its own commit, with the go-live
  decision recorded in the message.

---

## 6. Data-quality and coverage debt (measured, accepted for now)

| Item                                                                                                                                                                             | Severity            | Where to fix                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Equity `alias_dict` links are ~40% false-positive** (measured): "Nasdaq Listing Rule" → NDAQ, "Coca-Cola Consolidated" → KO                                                    | Medium              | M2 (the LLM reads the whole story) or a resolver `r2`                                                                                                                                                                                                                                                                                                                                                   |
| **Partially-resolved items are never re-examined** — the r1 sweep only picks up ZERO-link items                                                                                  | Medium              | Needs a `resolver_version` bump to re-resolve                                                                                                                                                                                                                                                                                                                                                           |
| **Clustering blocks on nothing** — architecture specified shared-instrument candidate blocks + headline **+ lede** at ~0.7; built: global advisory lock, headline-only, 0.5      | Medium              | Revisit with measured mis-cluster rate                                                                                                                                                                                                                                                                                                                                                                  |
| **S&P membership history is not backfilled** (`fja05680/sp500`) — any backtest before our recording start has survivorship bias                                                  | Medium              | One-off import job                                                                                                                                                                                                                                                                                                                                                                                      |
| **Kraken minute bars: ~12 h of depth only** — un-recorded crypto minutes are gone forever                                                                                        | High until deployed | Deploy the recorder; deep history via Trades endpoint/CSV                                                                                                                                                                                                                                                                                                                                               |
| **No nightly flat-file reconciliation** — architecture makes Massive flat files the canonical bar record; we only have snapshot + aggs                                           | Low                 | Nightly job, Starter includes flat files                                                                                                                                                                                                                                                                                                                                                                |
| **No 2-year bar backfill** — Starter includes 5 yr of minute history at $0 marginal                                                                                              | Low                 | One-off, enables pre-collection backtests                                                                                                                                                                                                                                                                                                                                                               |
| **Delayed quotes** — Starter is 15-min delayed, so `spreadBps` is null and spread-sensitive gates stay untuned until IBKR NBBO flows                                             | Accepted            | Documented in business-logic.md                                                                                                                                                                                                                                                                                                                                                                         |
| **Analyst upgrades/downgrades have no dedicated source** — a major hours-level mover class, arriving only via aggregator feeds                                                   | Accepted            | Tagged as its own `event_type` to measure the gap                                                                                                                                                                                                                                                                                                                                                       |
| **`price_bars_1m` is not partitioned** and has no `vwap` column (architecture sketched both)                                                                                     | Low                 | Partition when the table actually hurts                                                                                                                                                                                                                                                                                                                                                                 |
| ~~`edgar_13g` has produced 0 items in 14 days~~ — **investigated 2026-07-24, not a bug**                                                                                         | Closed              | The identical code path captured 3 `SC 13D` items, and a live check returns 0 entries for BOTH 13D and 13G, so the form-type query works and 13G is simply sparse in `getcurrent`'s short retention window (13Gs also cluster around the mid-February annual deadline). Re-check in Q1 if still zero.                                                                                                   |
| **~13,600 junk EDGAR items ingested before 2026-08-05** — EDGAR's `type=` param prefix-matches, so the Form 4 feed swept in 424B*/497*/485*/425/40-* filings (~66% of that feed) | Fixed forward       | Adapter now filters to each form family (with tests). Existing junk left in place: append-only discipline, zero instrument links (the CIK gate correctly refused them), so analytics are unaffected — but raw per-source volume stats for `edgar_form4` before 2026-08-05 are inflated ~3×, and the '~719 clusters/day' figure counted junk clusters. An optional purge script is a decision for later. |

### Stale comments and small inconsistencies (verified 2026-07-24)

None of these break anything; all of them will mislead the next reader.

1. ~~`process --loop` has no per-cycle error handling.~~ **FIXED** — it now logs a failed cycle and retries on the next tick, matching `poll --loop` / `bars:record --loop`.
2. ~~`process.ts` claims the deployed stack has no scheduled resolve/universe job.~~ **FIXED** — comment corrected; both are deployed.
3. ~~The CLI program description still says "M0".~~ **FIXED** — it now describes the full pipeline and the SIM-only venue.
4. ~~The ingest-stack process description is stale.~~ **FIXED**.
5. ~~The AWS-Budget-100% → kill-switch wiring is deferred.~~ **FIXED** — a dedicated
   `killSwitchTopic` now receives the 100% budget breach and a narrowly-scoped setter Lambda writes
   `halt`. 50%/80% stay informational email. The topic is exported so the execute-DLQ alarm and the
   future reconciler/LLM-spend breaches can attach deliberately rather than by accident.
6. ~~`bin/newstrader.ts` recommends declaring esbuild.~~ **FIXED** — comment now records that it is declared and the shim is belt-and-braces.
7. **`prettier --check .` was failing on 3 files** (two drizzle-generated `migrations/meta/*.json`
   plus `kraken-bars.test.ts`). Fixed: `migrations/meta/` is now in `.prettierignore` and the repo is
   formatted clean, so `--check` is safe to add to CI.
8. **`rules_versions`'s column is `version_label`, not `label`** — the repo layer maps between them,
   so hand-written SQL against `label` will fail.
9. ~~`reaction_measurements.anchor_ts`'s comment claims `first_received_at` for all rows.~~ **FIXED**
   — the table comment now documents both clocks and the column says which anchor belongs to which
   `measurer_version`.
10. ~~The measurer's summary log stamps only `measurerVersion: 'm1'`.~~ **FIXED** — it stamps both
    versions and states which counter group belongs to which.
11. ~~`sizedNotional` rounding is asymmetric between the live and replay paths.~~ **FIXED** — the
    rounding helper is exported and both paths call it, so they cannot drift.
12. ~~Fetch/read window asymmetry is undocumented.~~ **FIXED** — confirmed intentional and documented:
    the recorder fills bars forward continuously, so settling-proof bars exist without an event window
    asking for them. It matters only for a pure historical backfill with no recorder running.
13. ~~`rules_versions.parent_version_id` has no foreign key.~~ **FIXED** — self-referencing FK added in
    migration `0006_rules_lineage_fk.sql`.
14. **Constant rationales — mostly FIXED.** The eleven values that actually change behavior now carry
    their reasoning: the three 24-hour liveness bounds (and why they must equal each other), the
    20-day/10-row liquidity pair, the 60-minute calendar tolerance, the 30-minute staleness bound, the
    30-day beta minimum, the 10-bp flat band, the −50-bp recovery trigger, the 30-day recovery window,
    and the 3-attempt close bound. Left undocumented deliberately: mechanical values whose reason is
    self-evident from context — chunk sizes (500), HTTP timeouts (30 s), pool size (5), and the scale
    constants that exist only to mirror a column's precision.

---

## 7. Deferred by design — with the trigger that revives each

Nothing here is forgotten; each has a condition that makes it worth doing.

| Deferred                                                             | Cost               | Revive when                                                                                                                                                     |
| -------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Benzinga add-on on Massive**                                       | +$99/mo            | The `m1` vs `m1-pub` delta shows our ingestion latency is costing real basis points                                                                             |
| **X/Twitter (pay-per-use)**                                          | ~$165–315/mo true  | 3 months of source-reliability data shows market-moving clusters where X led usefully. Run a ~$10 one-week billing probe first (two billing details unverified) |
| **Minutes-level trading**                                            | +$100–120/mo       | `reaction_summary` median `time_to_half_of_1d_move` for _traded_ event types drops below realistic entry latency                                                |
| **Embeddings for clustering** (Voyage `voyage-3.5-lite`, $0.02/MTok) | ~$0                | Trigram demonstrably mis-clusters — measurable, because raw items are kept forever                                                                              |
| **Haiku (or cheaper) triage tier**                                   | small              | Measured novel-cluster volume >~500/day after the cheaper levers in §3                                                                                          |
| **Parquet/DuckDB analytics tier**                                    | ~$0                | A real query is actually slow (<10 GB/yr does not need a lake)                                                                                                  |
| **Shorting execution**                                               | —                  | Backtests over logged bearish signals justify it (signals are already generated/logged)                                                                         |
| **Bluesky Jetstream / Reddit / Whale Alert**                         | $0–30/mo           | Only after the free-tier sources are proven insufficient                                                                                                        |
| **Split-VPC networking**                                             | +$22/mo            | The public-RDS-with-TLS threat model ever feels wrong                                                                                                           |
| **Databento backfill**                                               | $0 (within credit) | Massive flat files disappoint                                                                                                                                   |
| **moomoo Canada as fallback broker**                                 | —                  | IBKR becomes untenable (Questrade blocks retail API orders; Webull CA has no API; tastytrade left Canada)                                                       |

---

## 8. Operational notes for whoever runs this next

**Local operation needs three loops plus a nightly command** (this is exactly what the AWS deploy
replaces):

```bash
caffeinate -i pnpm cli poll --loop 60          # ingest
caffeinate -i pnpm cli process --loop 300      # cluster + resolve
caffeinate -i pnpm cli bars:record --loop 60   # prices (crypto bars are lost if this stops)
pnpm cli measure                                # each evening; late horizons settle over ~9 days
```

- A `cycle FAILED` line in any `--loop` mode is **tolerated by design** — logged, next tick
  supersedes, no state to repair. Bars and raw items are immutable facts.
- `pnpm cli stats` is the single health readout: per-source volumes, dedup ratio, resolution
  coverage, reaction/alpha-decay medians, ingest latency per source (also a poller-outage
  detector), calendar, trading.
- Kill switch locally is `NEWSTRADER_KILL_SWITCH=halt`; against a deployed DB you must set
  `KILL_SWITCH_SSM_PARAM=/newstrader/kill-switch` so the CLI reads the same parameter the Lambdas
  do, with the same fail-closed behavior.

---

## 9. Idea parking lot

Ideas raised during design that are neither scheduled nor rejected. Kept so they are not
re-discovered from scratch.

- **Batches API for re-interpretation at 50% off** — when a new `prompt_version` should be applied
  to the whole stored cluster history, this is the cheap path (and inherently `retrospective=true`).
- **Cross-source scoop racing as a source-quality metric** — `lag_from_first_ms` is already stored
  per cluster item, so "who breaks stories first" is a query away, no new collection needed.
- **Wire-vs-aggregator latency yardstick** — GlobeNewswire RSS was added partly to measure how far
  behind the aggregator feeds run; the ingest-latency stats section now makes this visible.
- **`already_expected` as an LLM-quality probe** — comparing the LLM's judgment against the
  deterministic calendar match is a free, ongoing test of whether it understands "priced in."
- **Dust-size live calibration phase** before any real size: ~CA$5–15 Kraken orders (verified
  minimums 0.00005 BTC / 0.001 ETH / 0.06 SOL, ~4¢ taker fee) to measure real fills against the
  slippage model.
- **Kraken adapter in `validate=true` mode, run continuously** — Kraken's official substitute for
  the missing spot sandbox; exercises the real API without touching the matching engine.
- **IBKR retail OAuth 2.0** — announced as "being considered"; re-check at go-live, it would remove
  the gateway-container fallback entirely.
- **Reasoning-summary mining** — once signals exist, the LLM's own ≤2-sentence rationales on the
  best and worst trades are the fastest qualitative read on what it is getting right.
- **Per-source trust weighting** (`news_sources.base_trust` exists and is unused) — once
  `source_reliability_stats` lands, this column could feed the decision engine as a feature.
- **Sector-relative benchmarks** — reaction math currently uses SPY for all equities; a sector ETF
  benchmark would sharpen abnormal returns for sector-wide moves.

---

## 10. Constraints that must never be silently relaxed

Repeated here because they are the project's spine, and a future agent under time pressure is
exactly who would relax them:

1. **No real-money code path.** Venue is `sim` only, enforced by a DB CHECK constraint. Going live
   is a deliberate code change, not a config flag.
2. **The LLM never touches money.** It converts text to a structured signal. Gating, sizing,
   execution, exits, and accounting are deterministic, unit-tested code.
3. **`received_at` is the only clock the trading path may use.** `published_at` is source-claimed
   and frequently backdated; it is analytics-only (and the `m1-pub` measurer is analytics).
4. **Facts are append-only.** New rows, never UPDATEs on facts. Positions are derived from fills.
5. **Point-in-time universe access only** — never "current S&P 500."
6. **Every decision is recorded, including skips and suppressions**, with every gate's
   pass/observed/threshold. An engine that only logs trades cannot be evaluated.
7. **Rules are immutable data.** A changed threshold is a new `rules_versions` row, so history stays
   replayable.
