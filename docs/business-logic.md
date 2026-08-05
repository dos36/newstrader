# NewsTrader — Business Logic and the Reasons Behind It

_Verified against the code on 2026-07-24. Every value in the parameter registry (§9) was read out of
the source, not remembered. Where the code carries a rationale comment, this doc reproduces the
reasoning rather than inventing a new one._

**This is the "why" document.** For structure and file locations see
[`codebase-guide.md`](codebase-guide.md); for what is still unbuilt see [`roadmap.md`](roadmap.md).

---

## 1. The thesis, and why the whole design follows from it

**The system exists to answer one question honestly: does interpreting news produce a tradeable
edge after costs?** Profit is the hypothesis under test, not the goal being pursued. Almost every
otherwise-odd design choice is downstream of that: we would rather have a system that tells us
"no edge here" cheaply and credibly than one that appears profitable for reasons we cannot audit.

Three consequences worth internalizing before changing anything:

- **We are not trying to be fast.** Professional systems react to headlines in microseconds and
  scheduled news is priced within seconds. Competing on latency is unwinnable for a solo developer,
  so the design targets an **hours-to-days** horizon where interpretation quality, not speed, is the
  plausible edge. This is why a 15-minute-delayed price feed is acceptable and why polling every
  minute is enough.
- **We assume our own results are wrong until they survive scrutiny.** Hence: replayable rules,
  bit-for-bit regression, snapshotted decision inputs, adversarial review of every money-path
  change, and an explicit list of bias traps (§8) enforced in code rather than by intention.
- **The null hypothesis is respected.** The default configuration **trades nothing**. An event type
  earns the right to be traded only when measured evidence says its post-news drift beats costs.

## 2. The one rule that shapes the architecture: the LLM reads, deterministic code handles money

**The LLM's entire job is converting unstructured text into a typed, structured claim.** It emits
event type, direction, expected move, horizon, an "already expected" judgment, materiality, and
confidence. It never sizes a position, never sees account state, never calls a broker, and never
sets a threshold.

**Why the boundary is absolute:** everything downstream of that JSON must be unit-testable and
re-runnable. If an LLM sat anywhere in the money path, we could never replay a decision, never
prove a rule change caused a P&L change, and never distinguish "the model got better" from "the
model got luckier." The boundary is what makes the research question answerable at all.

**Practical corollary:** the LLM stage can be missing entirely and the rest of the system still
works — which is exactly the situation today. Everything except interpretation is built, and
`llm_signals` is simply empty.

---

## 3. Stage by stage: what each part decides, and why it works that way

### 3.1 Ingestion — collect immutably, trust nothing

**Pollers do exactly three things: fetch since a cursor, write the raw payload verbatim, enqueue a
pointer.** They never parse, dedup, or interpret. That keeps them trivially re-runnable and makes
the raw store the replay source of truth.

**The write ordering is deliberate and crash-safe:** raw payload first, database row second, queue
pointer third, cursor last. Every prefix of that sequence is recoverable — a crash after the payload
write re-writes the same bytes, a crash before the cursor save re-fetches and the unique constraint
absorbs the duplicate. **Duplicates are cheap; silent skips are not**, so every ambiguous case is
resolved in favor of re-fetching.

**Cursor loss was treated as a first-class threat, because a skipped item is invisible.** Two real
defenses came out of adversarial review:

- **SEC EDGAR** pages backwards through the feed with `&start=` until it finds its cursor, because
  Form 4 filings burst past 100/minute after the 4pm close and a single page would silently drop the
  overflow. When the cursor still is not found, it logs a structured warning rather than pretending.
- **Massive news** re-queries from five minutes _before_ its cursor and follows `next_url`
  pagination, because articles indexed late by the vendor would otherwise fall permanently below the
  watermark. The duplicate re-reads cost nothing; the unique constraint discards them.

**Timestamp discipline starts here and never bends.** `received_at` is our clock and the only clock
the trading path may use. `published_at` is what the source _claims_ — frequently backdated,
especially by SEC filings — so it is analytics-only.

### 3.2 Clustering — because duplicates are the popularity signal

**The same story arrives many times from many outlets, and that repetition is information, not
noise.** Collapsing echoes into one cluster does two jobs: it stops us paying for the same LLM call
fifty times, and it turns "how many outlets picked this up, how fast" into a measurable feature.

**The algorithm is deliberately deterministic — no embeddings, no extra API:**

1. Exact normalized-content-hash match attaches immediately.
2. Otherwise, the best open cluster from the last 48 hours whose normalized headline exceeds a
   trigram-similarity threshold wins.
3. Otherwise a new cluster is minted, anchored on this item's `received_at`.

**Every attach runs inside one transaction under a global advisory lock.** Two Lambdas processing
echoes of the same story concurrently would otherwise mint duplicate clusters, which silently
corrupts both the popularity counters and the "who broke it first" statistics — a data-integrity bug
that would be nearly undetectable after the fact.

**The similarity threshold is 0.5, deliberately lower than the architecture's 0.7 sketch**, because
the shipped implementation compares headlines only, and wire echoes rewrite headlines more than they
rewrite bodies. The trade is explicit: a lower bar over-merges rather than under-merges, and
over-merging is the cheaper error while raw items are kept forever and can be re-clustered.

**One performance subtlety worth preserving:** the candidate query filters with the `%` operator
under a transaction-scoped `pg_trgm.similarity_threshold`, because a bare `similarity()` call cannot
use the trigram index and would sequential-scan every open cluster forever.

### 3.3 Entity resolution — precision over recall, with the confidence recorded

**Each item is linked to the instruments it is _about_, deterministically, with a confidence that
records how it was found.** Method precedence, highest first:

| Method                                | Confidence | Why it ranks there                                         |
| ------------------------------------- | ---------- | ---------------------------------------------------------- |
| `cik_exact` — SEC filing's own CIK    | 1.00       | The filer identifies itself; there is nothing to guess     |
| `source_hint` — vendor's ticker tags  | 0.95       | A human/vendor pipeline already made the call              |
| `ticker_exact` — "(NYSE: XYZ)" prefix | 0.90       | An explicit exchange-qualified mention                     |
| `ticker_exact` — `$XYZ` cashtag       | 0.85       | Deliberate tagging, but by anyone                          |
| `alias_dict` — crypto keyword         | 0.80       | Three-coin universe makes "Bitcoin" unambiguous            |
| `alias_dict` — company-name scan      | 0.70       | Genuinely ambiguous; **measured ~40% false-positive rate** |

**Filings resolve by CIK or not at all.** An 8-K names counterparties, auditors, and acquirers
constantly, so text-scanning a filing would link it to every company it mentions. The gate keys off
any filing marker in the item's metadata — not just a successfully parsed CIK — because a filing
whose title regex failed would otherwise fall through into the text scan, which is exactly the bug
adversarial review caught.

**Bare ticker strings are never scanned as words.** Tickers only match through a vendor hint, an
exchange prefix, or a cashtag, and one-to-two-character tickers (A, IT, V) require the explicit
forms even then — otherwise ordinary prose resolves to random companies.

**The known weakness is documented rather than hidden:** name-based matches produce false positives
like "Nasdaq Listing Rule" → NDAQ and "Coca-Cola Consolidated" → KO. That is why they carry 0.70,
why measurement admits only links at 0.75 or above, and why the eventual LLM stage — which reads the
whole story — is the real fix.

**The backfill sweep uses a keyset cursor, not "oldest unlinked first."** Unresolvable items stay
unlinked by design, so once a few hundred permanently-unresolvable filings accumulated at the head
of the queue, a naive sweep re-examined the same window forever and never reached newer items. The
cursor advances past them.

### 3.4 The universe — point-in-time or it is a lie

**Every universe query goes through dated membership intervals, never "the current S&P 500."**
Asking today's index membership about a 2019 event silently deletes every company that has since
been removed, which flatters any backtest — the textbook survivorship bias.

**Instruments are never deleted and identity is never quietly reassigned.** When a symbol arrives
with a different CIK than the one on file, the sync **refuses the whole transaction** rather than
updating in place: that pattern is ticker reuse, and overwriting would silently reattribute a
delisted company's entire history to a new one.

**SEC wins CIK conflicts over Wikipedia**, since it is the authoritative registry — a rule that
earned its keep immediately by catching a real disagreement on XOM.

### 3.5 Price recording — local, immutable, two pipes

**Prices are stored locally from day one rather than fetched on demand.** Three reasons: reaction
analytics run constantly and should not depend on vendor rate limits; decision-time prices are not
reconstructible later; and vendor terms drift (this vendor renamed itself from Polygon to Massive
mid-flight).

**Bars are immutable facts — a recorded minute is never overwritten.** Writes are conflict-do-nothing
and the `source` column records which pipe produced the row, so a delayed snapshot bar and a
consolidated backfill bar are distinguishable instead of silently overwriting each other.

**Crypto is recorded first, equities second.** Kraken serves only ~12 hours of minute history, so an
un-recorded crypto minute is **gone forever**, while equity bars remain re-fetchable from Massive for
years. When the equity leg fails, crypto bars are already persisted before the error propagates.

**Event windows reach 72 hours _before_ each anchor.** Off-hours news is the norm rather than the
exception — late-Friday 8-Ks, weekend crypto stories — and the anchor price for such an event is the
prior session's close, which can be three days back across a long weekend. The original one-hour
window left every weekend-anchored event permanently unmeasurable.

### 3.6 Reaction measurement — the analytics payoff, and two clocks

**This is where the project's original questions get answered:** how fast the market reacts, how far
it moves, and how quickly it recovers. For each (cluster, instrument) pair the measurer computes an
abnormal-return ladder at eight horizons from five minutes to five days, beta-adjusted against SPY
for equities and BTC for alt-coins.

**A horizon that cannot be measured is left absent, never zero.** Absence means "not measurable";
a fabricated zero would look like "the market did not react," and those are opposite claims.

**The "settled bar" rule is subtle and load-bearing.** A stale price is accepted as a horizon price
only when a _later_ bar exists to prove the gap was non-trading (a weekend, an overnight, a halt)
rather than simply the end of our data. Without that proof, a Friday-evening event would produce a
"1-day return" the moment the data ran out, which is a partial-day answer frozen permanently by the
conflict-do-nothing write.

**Two measurer versions answer two different questions, and both are legitimate:**

- **`m1` anchors on `received_at`** — the tradeable view, and the only honest clock for anything
  trading-related, because we cannot trade news we have not received.
- **`m1-pub` anchors on the earliest _credible_ `published_at`** — what the market did once the news
  existed at all, which is exact regardless of our fetch cadence because bars carry exchange
  timestamps. Credibility is enforced: the claim must be present, no more than two minutes after our
  receipt (clock skew), and no more than 24 hours before it.

**The delta between those two curves is the measured cost of our own ingestion latency** — and
therefore the evidence that decides whether paying for a faster news feed is worth it. This is a
better answer than any vendor's marketing claim about latency.

**Only links at 0.75 confidence or above are measured.** The threshold is set precisely between the
crypto-keyword tier (0.80, admitted) and the company-name tier (0.70, excluded), because feeding
40%-false-positive links into the reaction ladder would poison the very statistics meant to earn
event types their place in the trading whitelist.

**Beta excludes the anchor day itself.** Including it leaks the event's own move into the
"normal relationship" estimate — a genuine look-ahead bias caught in review.

### 3.7 Scheduled events — ground truth for "already priced in"

**Macro release schedules and earnings dates exist to give the system a deterministic answer to
"was this expected?"** A story about CPI on CPI day is not new information, and the calendar knows
that without asking a model.

**This also becomes a free, permanent test of the LLM's judgment.** The model emits its own
`already_expected` opinion; the calendar provides ground truth; comparing them per event type
measures whether the model actually understands "priced in."

**The parsers throw on any format drift.** These are scraped government pages, and a silently
mis-parsed calendar would mean the system believes nothing is scheduled — which is worse than a
loud failure.

### 3.8 The decision engine — nine gates, every one recorded

**`decide()` is a pure function of (signal, features, quote, config)** with no clock, no randomness,
and no I/O. Purity is enforced by a test that forbids `node:` imports in the engine, because purity
is precisely what makes replay bit-for-bit reproducible.

**Gates evaluate in a fixed order, and every gate is recorded even after one fails.** A row that
stopped at the first failure would make the skip-reason distribution un-analyzable; we want to know
that a signal failed confidence _and_ would also have failed liquidity.

| #   | Gate                       | Rejects when                                   | Reasoning                                                                    |
| --- | -------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | `direction_actionable`     | neutral, or bearish while long-only            | Shorting needs borrow semantics the simulator cannot honestly model          |
| 2   | `min_confidence`           | confidence < 0.75                              | Trade only high-conviction reads; loosening must be earned by calibration    |
| 3   | `already_expected`         | the LLM says priced-in                         | Anticipated news has no edge at an hours horizon                             |
| 4   | `calendar_match`           | a scheduled release matches the anchor         | Deterministic ground truth for the same idea as gate 3                       |
| 5   | `event_type_whitelist`     | event type not on the list                     | **Empty by default** — evidence admits event types, not optimism             |
| 6   | `stale_move`               | price already moved > 300 bps since the anchor | The market beat us; chasing is a different strategy. Unmeasurable also fails |
| 7   | `liquidity`                | 20-day median dollar volume < $5M              | Keeps paper fills honest for sizes we might eventually trade                 |
| 8   | `max_concurrent_positions` | already at 10 open                             | Caps blast radius, keeps per-position risk meaningful                        |
| 9   | `no_existing_position`     | already holding this instrument                | One position per name; avoids accidental pyramiding                          |

**Unmeasurable inputs fail closed.** A null price move or unknown liquidity is a _rejection_, not a
pass — we never trade on the absence of information.

**Position sizing is fixed-fractional and volatility-scaled**, deliberately _not_ proportional to
LLM confidence. Risk 50 bps of equity per position, divide by a 2×ATR stop distance to get quantity,
and cap any single name at 10% of equity. Confidence-weighted sizing is a plausible improvement, so
the architecture asks us to _log what it would have done_ and adopt it only on evidence — that
shadow-logging is still unbuilt.

**All sizing arithmetic is fixed-point BigInt over decimal strings.** Floats would make a replay
diverge from the original run in the last decimal place, which destroys the bit-for-bit guarantee
that everything else rests on.

**Exits are decided by the same versioned rules and recorded as decisions.** Signal-driven systems
classically forget exits; here the position manager writes `action=close` decision rows, so exits are
replayable under the same machinery as entries. Priority is stop-loss, then take-profit, then time
stop, with the time stop mandatory at the signal's horizon.

### 3.9 Execution — simulated, idempotent, derived

**The only venue is an internal simulator, enforced by a database CHECK constraint.** Going live
must be a code change, not a configuration flip. The simulator fills market orders at the latest
recorded bar close with 5 bps of adverse slippage — buys pay up, sells receive less — plus fees of
0 bps for equities and 26 bps for crypto.

**The same fill code is intended to serve replay**, so live-paper results and backtests are
comparable by construction. An external paper venue could never offer that, because its fill engine
would be a third, uncontrolled set of semantics.

**Double-ordering is structurally impossible, not merely unlikely.** The client order id is a hash
of the decision key, so a retried CLI command, a redelivered queue message, and two concurrent
Lambdas all converge on the same id and the same unique constraint. The simulator additionally
refuses any intent whose decision turns out to be a replay row rather than a live one.

**Positions and P&L are always derived from the append-only fills** — there is no mutable positions
table to drift out of sync with reality.

**Exit keys are reason-independent** (`exit:<openingOrderId>`, with the reason stored in the
features). Two evaluators racing to different verdicts on one position can therefore mint at most one
close order; a reason-scoped key would have allowed two closes to both fill and flip the position
short. Rejected closes retry under attempt-suffixed ids up to three times, then log a structured
error and wait for a human rather than looping.

### 3.10 The kill switch — halts trading, never research

**When tripped, decisions are still recorded with `suppressed=true` and no order is emitted.**
Research data never stops; only money movement does. It is checked independently at decide, at
execute, and at exit evaluation — three places, because a single check is a single point of failure.

**It fails closed — with one deliberate, local-only exception.** Any _unrecognized_ value halts
(`'running'`, `'true'`, `'1'` all halt), because a typo'd or corrupted parameter must never quietly
mean "keep trading." Every deployed path injects an SSM reader that throws on a read failure, which
crashes the invocation before an order can be placed, and the CLI's SSM path catches that same
failure and returns `halt` explicitly.

**The exception:** an _absent or empty_ value reads as "run." That is the not-yet-provisioned default
and it is only reachable through the bare env-var reader — i.e. local development. This is precisely
why operating the CLI against a **deployed** database requires `KILL_SWITCH_SSM_PARAM`: without it,
the CLI reads a local variable that is probably unset and will happily trade while production is
halted.

**The parameter is deliberately not CloudFormation-managed.** A managed resource would silently
re-set a manual `halt` back to `run` on the next unrelated deploy — the operator creates it once by
hand.

**One automated trip path is wired: a 100% monthly-budget breach.** It publishes to a dedicated
kill-switch topic (separate from the alarm topic, so joining it is always an explicit decision) and a
Lambda scoped to `ssm:PutParameter` on that one parameter writes `halt`. It never writes `run` —
clearing a halt is a human action, because the reason for the halt is the first thing a human should
look at. Cost is the broadest available safety net: every runaway this system can have (an LLM retry
storm, a poller loop, a per-call vendor charge) shows up as spend before it shows up anywhere else.

**Suppressed entries never fire late; suppressed exits do re-fire** on the first pass after the
switch clears. That asymmetry is intentional: a stale entry signal is worthless, while an open
position still needs closing.

### 3.11 Replay — the reason rules are data

**Thresholds live in immutable `rules_versions` rows, not in code.** Changing a rule means inserting
a new version; re-registering a label with different content throws. This is what makes "would rule
set B have done better than A over the same history?" a question with an answer.

**Mode A (built) is a regression guarantee:** re-running the _same_ rules version over the stored
snapshots must reproduce the live decisions bit-for-bit, and CI enforces it with the real engine.

**One case is reproduced verbatim rather than re-decided:** a live decision that skipped because no
price existed (`no_quote`) is copied straight into the replay run without calling the engine at all.
The absence of a quote is a **data fact, not a rules outcome** — no rules version could have traded
it, so re-deciding it would invent a difference that never existed.

**Comparing runs is scoped to one rules version on the `live` side.** Live decisions span every rules
version that ever decided a signal, so an unscoped comparison could silently mix them; `compareRuns`
therefore _requires_ a live rules version and reports divergences as action changes, size changes, or
skip-reason changes, with size equality compared after numeric canonicalization (`'1.5'` stored in a
`numeric(20,8)` column reads back as `'1.50000000'`).

**Mode B (not built) is the counterfactual**, and the honest blocker is documented rather than
papered over: decision features are not yet tagged as "world" versus "portfolio," so a different
rules version would inherit a portfolio trajectory it never would have produced. Until that is
fixed, `replay` prints a visible `mode_b_unsound_portfolio_features` warning instead of presenting
such results as trustworthy.

---

## 4. Invariants, and what breaks without each

| Invariant                                 | What breaks if violated                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------- |
| No real-money path (`sim` only, DB CHECK) | A bug becomes a financial loss instead of a bad log line                          |
| LLM never touches money                   | Decisions stop being replayable; rule changes and model changes become confounded |
| `received_at` is the trading clock        | Look-ahead bias: backdated timestamps let the system "trade" on the past          |
| Facts append-only; positions derived      | History becomes unreproducible; positions drift from fills                        |
| Point-in-time universe                    | Survivorship bias inflates every historical result                                |
| All decisions recorded, skips included    | Skip-reason distribution is unknowable, so the engine cannot be tuned honestly    |
| Rules immutable and versioned             | "Which change caused this?" becomes unanswerable                                  |
| Deterministic idempotency keys            | Retries double-order; measurements double-count                                   |
| Kill switch fails closed                  | The one control that must work when everything else is broken, doesn't            |
| Per-suite test databases                  | Tests corrupt real research data (this actually happened — see §7)                |

---

## 5. What the measurements say so far

**Measured over 14 days of continuous collection (2026-07-10 → 2026-07-25 UTC).** Recorded here so a
future agent knows what has and has not been established. Query the database for current numbers;
these are a snapshot, not a contract.

**Correction (2026-08-05 audit):** raw volume figures below overstate real news. EDGAR's `type=`
parameter prefix-matches, so the "Form 4" feed also ingested 424B*/497*/485*/425/40-* filings —
about two-thirds of that feed — until the adapter gained a form-family filter. The junk never
resolved to instruments (the CIK gate correctly refused it), so clustering quality, resolution
precision, reaction measurements, and the Sonnet-only triage decision (which counted only LINKED
clusters) are all unaffected. Raw items/day, clusters/day (~719), and the Form 4 share are the
numbers to distrust for the pre-fix window.

- **Ingestion: 18,248 raw items from 9 sources.** Form 4 filings alone are 53% of volume (9,745),
  then 8-Ks (2,611), GlobeNewswire (3,223), Massive news (1,905), crypto RSS (~250 each).
  `edgar_13g` has registered but never yielded a single item.
- **Dedup is doing heavy lifting: 18,248 items collapse to 10,059 clusters** — 1.81 items per
  cluster, a **44.9% echo-collapse rate**. This validates clustering as both a cost control and a
  popularity signal.
- **Resolution links 13.3% of items** (2,419 of 18,248). This is _expected and correct_: raw filing
  flow is dominated by microcaps and SPACs that the S&P 500 dictionary rightly declines to link.
  By method: `source_hint` 1,994 links (vendor tags, ~2.3 instruments/item), `cik_exact` 993 (exactly
  one filer per filing), `alias_dict` 732, and `ticker_exact` **just 1** — the exchange-prefix /
  cashtag channel is correct but contributes almost nothing at this volume.
- **The LLM's real workload is far smaller than raw volume suggests — and this settles the triage
  question.** Only clusters carrying a link at ≥0.75 confidence have a tradeable target: **1,348
  clusters (~96/day), forming 2,512 cluster×instrument pairs (~179/day)**. That is well under the
  ≈500/day threshold that would justify a cheap-model triage tier, so **Sonnet-only is correct**, at
  an estimated **≈$50–75/month** with prompt caching — inside the budgeted $40–90 band.
- **Price and analytics coverage:** 2,005,847 minute bars, 36,399 daily bars, 27,315 reaction
  measurements (13,733 under `m1` / 13,582 under `m1-pub`), 4,499 reaction summaries, 915 recovery
  measurements. The ~1% shortfall in `m1-pub` is items whose `published_at` failed the credibility
  window — working as designed.
- **Name-based resolution false-positive rate: ~40%** on a hand-checked sample of equity
  `alias_dict` links (the reason for the 0.75 measurement-admission threshold).
- **Alpha decay is measurable but not yet trustworthy.** The first readout (medians of ~515 minutes
  for RSS, ~1,592 for Massive news, ~3,203 for SEC filings) was taken when most anchors landed
  outside market hours, and the clock runs through closed hours — a Saturday filing whose move
  happens at Monday's open reads as "36 hours." With two full trading weeks now collected, this
  should be **re-measured restricted to market-hours anchors** before anyone draws a conclusion.
  Even distorted, the direction is consistent with news not being fully priced within minutes at
  this horizon — which is the premise the project exists to test.

---

## 6. Economics and the upgrade triggers

**Current actual spend is ~$29/month** (Massive Stocks Starter), since nothing is deployed and no
LLM calls are being made. The designed steady state is **~$100–185/month**, dominated by the LLM
stage (≈$40–90) plus AWS (~$20–30) and IBKR market data (≈$14.50) once live.

**Every upgrade is gated on evidence the system produces itself**, which is the point of building
the analytics first:

| Upgrade                            | Cost         | Trigger                                                                   |
| ---------------------------------- | ------------ | ------------------------------------------------------------------------- |
| Faster news feed (Benzinga add-on) | +$99/mo      | The `m1` vs `m1-pub` gap shows ingestion latency costs real basis points  |
| Cheap-model triage tier            | small        | Measured novel-cluster volume exceeds ~500/day after cheaper levers       |
| Real-time market data              | +$70/mo      | Only if moving to minutes-level trading                                   |
| Minutes-level trading              | +$100–120/mo | Measured alpha decay for traded event types beats our entry latency       |
| Social sources (X)                 | ~$165–315/mo | Three months of source-reliability data shows X leading on moving stories |

---

## 7. Two incidents worth remembering

**Both are why certain code looks paranoid.** Neither was hypothetical.

- **A test suite corrupted the development database.** The universe-sync integration tests ran
  against the shared database with a mocked clock and a fixture constituent list. Because the
  membership diff is _global_ by design, it closed all 503 real point-in-time membership rows with a
  backdated timestamp and deleted live crypto alias history. Result: every DB-backed suite now
  creates its own database, and the schema gained a partial unique index plus an interval CHECK so
  inverted intervals are unrepresentable.
- **Reformatting a fixture silently disabled two tests.** A prettier pass changed the exact HTML
  substring that two format-drift tests mutated, turning both into tautologies that passed while
  testing nothing. Result: `__fixtures__/` is prettier-ignored, and those tests now assert that
  their mutation actually changed the input.

---

## 8. Bias traps and their enforcement

**These are enforced mechanisms, not good intentions.**

| Trap                      | Enforcement                                                                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Look-ahead via timestamps | Trading path keys off `received_at`; reaction anchors use `first_received_at`; beta excludes the anchor day                                              |
| Survivorship              | Dated membership intervals; instruments never deleted; identity changes refused                                                                          |
| LLM training-data leakage | Only forward-collected signals count toward quality metrics; retrospective runs must be flagged and quarantined (**column still missing — see roadmap**) |
| Replay drift              | Inputs snapshotted at decision time; engine version stamped per decision; Mode A CI-gated                                                                |
| Paper-fill optimism       | Explicit slippage/fee model; paper P&L validates plumbing, not alpha                                                                                     |
| Delayed-quote distortion  | Every snapshot records its source; `spreadBps` is null and spread-sensitive gates stay untuned                                                           |
| Fabricated measurements   | Unmeasurable horizons are absent rather than zero; unmeasurable decision inputs fail the gate                                                            |

---

## 9. Parameter registry

**Every tunable value, its home, and the reason for it.** Values read from source on 2026-07-24.
Engine parameters (the `rules_versions` block) are **data** — change them by shipping a new rules
version, never by editing the default in place.

### Engine config — `packages/core/src/decide/default-rules.ts` (label `v1-conservative`)

| Parameter                | Value     | Why this value                                                                |
| ------------------------ | --------- | ----------------------------------------------------------------------------- |
| `minConfidence`          | 0.75      | High-conviction only; the calibration report earns any loosening              |
| `rejectAlreadyExpected`  | true      | Priced-in news has no edge at an hours horizon                                |
| `rejectCalendarMatch`    | true      | Deterministic version of the same idea                                        |
| `eventTypeWhitelist`     | **`[]`**  | Trades nothing until event-study evidence earns entries                       |
| `staleMoveMaxBps`        | 300       | Beyond ~3% the market beat us; chasing is a different strategy                |
| `minMedianDollarVolume`  | 5,000,000 | Keeps paper fills honest for eventual live sizes                              |
| `maxConcurrentPositions` | 10        | Caps blast radius; keeps per-position risk meaningful on small equity         |
| `allowShorts`            | false     | Borrow/locate semantics the simulator cannot honestly model                   |
| `riskBpsOfEquity`        | 50        | 0.5% risk per position survives long losing streaks while measuring edge      |
| `atrLookbackDays`        | 14        | Standard ATR window, matches the analytics volatility framing                 |
| `atrStopMultiple`        | 2         | Outside normal daily noise; doubles as the sizing denominator                 |
| `maxPositionNotionalPct` | 0.10      | No single name exceeds 10% of equity even when a tiny ATR implies a huge size |
| `defaultTimeStopHorizon` | `'3d'`    | Middle of the measured reaction ladder; fallback when a signal carries none   |
| `stopAtrMultiple`        | 2         | Risk taken equals risk budgeted                                               |
| `takeProfitAtrMultiple`  | null      | No truncation — analytics should observe the full drift                       |

### Pipeline constants (code-level; changing these is a code change)

| Constant                          | Value               | Where                           | Why                                                                         |
| --------------------------------- | ------------------- | ------------------------------- | --------------------------------------------------------------------------- |
| `HEADLINE_SIMILARITY_THRESHOLD`   | 0.5                 | `clustering-repo.ts`            | Headline-only comparison; over-merge is the cheaper error                   |
| `CANDIDATE_WINDOW_HOURS`          | 48                  | `clustering-repo.ts`            | Story lifetime before a follow-up is genuinely new                          |
| `RESOLVER_VERSION`                | `'r1'`              | `resolver/match.ts`             | Stamped on links; a bump re-resolves everything                             |
| `CONFIDENCE.*`                    | 1.0 → 0.7           | `resolver/match.ts`             | Per-method reliability (see §3.3)                                           |
| `MIN_SOURCE_HINT_TICKER_LENGTH`   | 3                   | `resolver/match.ts`             | 1–2 char tickers collide with English words                                 |
| `MIN_NAME_ALIAS_LENGTH`           | 4                   | `resolver/match.ts`             | Shorter names are prose collisions (digit-bearing names like "3M" excepted) |
| `MIN_LINK_CONFIDENCE`             | 0.75                | `shared-constants.ts`           | Admits crypto keywords (0.8), excludes 40%-FP name matches (0.7)            |
| `EVENT_WINDOW_BEFORE_MS`          | 72 h                | `bars/windows.ts`               | Off-hours anchors need the prior session's close, up to a long weekend      |
| `EVENT_WINDOW_AFTER_MS`           | 5 d                 | `bars/windows.ts`               | The longest reaction horizon                                                |
| `MEASURER_VERSION`                | `'m1'`              | `reaction/measure-repo.ts`      | Received-clock (tradeable) measurements                                     |
| `PUB_MEASURER_VERSION`            | `'m1-pub'`          | `reaction/measure-repo.ts`      | Publication-clock measurements (latency pricing)                            |
| `PUB_MAX_CLOCK_SKEW_MS`           | 2 min               | `reaction/measure-repo.ts`      | Tolerates skew without accepting future-dated claims                        |
| `PUB_MAX_STALENESS_MS`            | 24 h                | `reaction/measure-repo.ts`      | Rejects implausibly backdated publication claims                            |
| `DEFAULT_PRICE_STALENESS_MINUTES` | 30                  | `reaction/math.ts`              | Freshness bound before the "later bar proves it" rule applies               |
| `HORIZON_FALLBACK_CAP_MS`         | 3 d                 | `reaction/math.ts`              | Next-session fallback for daily horizons over weekends                      |
| `MIN_BETA_OVERLAP_DAYS`           | 30                  | `reaction/math.ts`              | Below this, beta is noise — degrade to raw returns                          |
| `FLAT_1D_THRESHOLD_BPS`           | 10                  | `reaction/math.ts`              | Below this the 1-day move is "flat"; time-to-half is meaningless            |
| `RECOVERY_TRIGGER_BPS`            | −50                 | `reaction/math.ts`              | Only genuinely negative events get recovery metrics                         |
| `DEFAULT_RECOVERY_WINDOW_DAYS`    | 30                  | `reaction/math.ts`              | Long enough for reversion, short enough to conclude                         |
| `BETA_LOOKBACK_DAYS`              | 90                  | `reaction/measure-repo.ts`      | Enough daily closes for a stable beta                                       |
| `SIM_SLIPPAGE_BPS`                | 5                   | `broker/sim-fill.ts`            | Adverse-direction fill assumption; sensitivity-testable                     |
| `SIM_FEE_BPS`                     | 0 / 26              | `broker/sim-fill.ts`            | Commission-free equities; Kraken-taker-like crypto                          |
| `HORIZON_DURATION_MS`             | 6.5 h / 1 / 3 / 5 d | `decide/exit-rules.ts`          | Intraday is one session; the rest are calendar days                         |
| `MAX_CLOSE_ATTEMPTS`              | 3                   | `execution/position-manager.ts` | Bounded retries, then a human — never an infinite loop                      |
| `DECIMAL_SCALE` / `SCALE`         | 8 / 1e8             | `decide/decimal.ts`             | Fixed-point precision for replay-stable arithmetic                          |
| `CLIENT_ORDER_ID_LENGTH`          | 32                  | `decide/intent.ts`              | Hash prefix length for deterministic order ids                              |
| `CALENDAR_TOLERANCE_MINUTES`      | 60                  | `trading/features.ts`           | Window around the anchor for a scheduled-event match                        |
| `DOLLAR_VOLUME_LOOKBACK_DAYS`     | 20                  | `trading/features.ts`           | Daily bars used for the liquidity median                                    |
| `MIN_DOLLAR_VOLUME_ROWS`          | 10                  | `trading/features.ts`           | Below this the median is untrustworthy → liquidity unknown → gate fails     |
| `QUOTE_MAX_AGE_MS`                | 24 h                | `trading/decide-repo.ts`        | Older than this, no quote exists → `no_quote` skip                          |
| `REFERENCE_PRICE_MAX_AGE_MS`      | 24 h                | `execution/sim-broker.ts`       | Stale reference close → order rejected rather than filled at a fiction      |
| `EXIT_REFERENCE_MAX_AGE_MS`       | 24 h                | `execution/position-manager.ts` | No fresh bar → skip the position entirely, do not consume a close attempt   |
| `DEFAULT_PAPER_EQUITY_USD`        | `'100000'`          | `execution/sim-broker.ts`       | Starting paper cash (`PAPER_EQUITY_USD` overrides)                          |
| `COST_APPORTION_SCALE`            | 8                   | `execution/positions.ts`        | Partial-close cost slices, matching the qty column scale                    |
| `AVG_ENTRY_PRICE_SCALE`           | 6                   | `execution/positions.ts`        | Average entry reported at the price columns' scale                          |
| `FILL_PRICE/QTY/FEE_SCALE`        | 6 / 8 / 6           | `broker/sim-fill.ts`            | Rounding targets matching the `fills` columns exactly                       |

**Every value above that changes behavior now carries its reasoning in the code**, including why the
three 24-hour liveness bounds must be equal to each other (a stricter execution bound than decide
bound would produce intents that can never fill — a silent trading halt). The only values left
without a written rationale are mechanical: chunk sizes, HTTP timeouts, pool size, and constants that
exist purely to mirror a column's precision.

### Where each parameter actually lives at runtime

- **Engine config** (`rules_versions.config`) — change by inserting a new rules version. Replayable.
- **Code constants** (the table above) — change by editing code; **bump the relevant `*_version`**
  (`RESOLVER_VERSION`, `MEASURER_VERSION`) if the change alters recorded outputs, so old rows stay
  comparable instead of silently mixing methodologies.
- **Environment** — `DATABASE_URL`, `EDGAR_USER_AGENT`, `MASSIVE_API_KEY`, `MASSIVE_BASE_URL`,
  `RAW_STORE_DIR`, `FINNHUB_API_KEY` (optional), `PAPER_EQUITY_USD` (optional),
  `NEWSTRADER_KILL_SWITCH` / `KILL_SWITCH_SSM_PARAM`, `ENGINE_VERSION` (falls back to the git SHA).
