import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allAdapters, FsRawStore } from '@newstrader/adapters';
import {
  DEFAULT_RULES_LABEL,
  decide,
  formatDec,
  mul,
  parseDec,
  roundTo,
  sub,
} from '@newstrader/core';
import type { RawStore, SourceAdapter } from '@newstrader/core';
import {
  backfillEventWindows,
  closeStaleClusters,
  compareRuns,
  createDb,
  createReplayRun,
  decideSignals,
  defaultCalendarDeps,
  derivePortfolio,
  ensureBenchmarks,
  ensureDailyBars,
  ensureDefaultRules,
  evaluateOpenPositions,
  fetchAggsBars,
  fetchKrakenOhlc,
  fetchSecTickerMap,
  fetchSnapshotMinuteBars,
  fetchSp500FromWikipedia,
  getReplayRunRulesLabel,
  getRulesVersion,
  LIVE_RUN,
  loadResolverDictionary,
  measureReactions,
  recordSnapshot,
  resolveUnlinkedItems,
  runReplay,
  syncCalendar,
  syncUniverse,
} from '@newstrader/db';
import type {
  BackfillDeps,
  Db,
  DecideSignalsTotals,
  EnsureDailyBarsDeps,
  MassiveBarsOptions,
  RecordSnapshotDeps,
  ResolveCursor,
} from '@newstrader/db';
import { Command } from 'commander';
import dotenv from 'dotenv';
import {
  ensureSource,
  loadUnclusteredItems,
  runPoll,
  runProcess,
} from '../../handlers/src/lib/ingest.js';
import {
  cliKillSwitch,
  engineExitEvaluator,
  loadPendingOpenIntents,
  loadSimPortfolioFills,
  resolveEngineVersion,
  simBrokerFromEnv,
} from '../../handlers/src/lib/trading.js';
import { printStats } from './stats.js';

/**
 * NewsTrader CLI: run the same cores the Lambdas run, but locally — FsRawStore
 * instead of S3, a direct DATABASE_URL instead of the Secrets Manager secret,
 * work found by query instead of SQS, and the kill switch read from the
 * NEWSTRADER_KILL_SWITCH env var instead of SSM.
 * M1 adds the universe/dictionary layer: `universe:sync` maintains
 * instruments/membership/aliases, `process` resolves items as it clusters
 * them, and `resolve` backfills items ingested before the dictionary existed.
 * M4 adds the trading path (VENUE IS SIM ONLY): `rules:init`/`decide`/
 * `positions`/`manage` drive the pure engine + SimBroker, `replay`/
 * `replay:compare` re-execute the stored signal log under any rules version.
 * Config comes from .env via dotenv (see .env.example).
 */

// `pnpm cli …` runs with cwd = services/cli, so load .env from the cwd first
// (dotenv never overrides real env) and then from the repo root, where the
// quickstart puts it.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
dotenv.config();
dotenv.config({ path: path.join(REPO_ROOT, '.env') });

// Declared before parseAsync: command actions run synchronously during parse,
// i.e. before any `const` below the parseAsync call leaves its TDZ.
const DAY_MS = 86_400_000;

const program = new Command();

program
  .name('newstrader')
  .description(
    'NewsTrader: ingest -> cluster -> resolve -> measure -> decide -> paper-trade (venue SIM only). ' +
      'Zero LLM spend until M2 populates llm_signals.',
  );

program
  .command('sources:seed')
  .description(
    'Upsert news_sources rows for every adapter enabled by the current env ' +
      '(EDGAR/Massive sources appear once their env keys are set; pollers also self-register on first poll)',
  )
  .action(async () => {
    await withDb(async (db) => {
      for (const adapter of adaptersFromEnv()) {
        await ensureSource(db, adapter);
      }
      const sources = await db.$client.query<{
        source_key: string;
        kind: string;
        name: string;
        active: boolean;
      }>('select source_key, kind, name, active from news_sources order by source_key');
      console.table(sources.rows);
    });
  });

program
  .command('poll')
  .argument('[sourceKey]', 'poll a single source (default: all enabled adapters)')
  .option('--loop <seconds>', 'repeat forever with this many seconds between cycles')
  .description('Run one poll cycle: cursor → fetch → raw store → raw_news_items → cursor')
  .action(async (sourceKey: string | undefined, options: { loop?: string }) => {
    const adapters = selectAdapters(sourceKey);
    const loopSeconds =
      options.loop === undefined ? undefined : parsePositiveInt(options.loop, '--loop');
    await withDb(async (db) => {
      // Default the raw store to <repo root>/data/raw regardless of cwd;
      // an explicit RAW_STORE_DIR (from .env or the environment) wins.
      const rawStore = new FsRawStore(
        process.env['RAW_STORE_DIR'] ?? path.join(REPO_ROOT, 'data', 'raw'),
      );
      for (;;) {
        const failed = await pollCycle(db, rawStore, adapters);
        if (loopSeconds === undefined) {
          if (failed > 0) throw new Error(`poll: ${failed} adapter(s) failed`);
          return;
        }
        console.log(`[poll] sleeping ${loopSeconds}s (ctrl-c to stop)`);
        await sleep(loopSeconds * 1000);
      }
    });
  });

program
  .command('process')
  .option('--batch <n>', 'items per clustering batch', '500')
  .option('--loop <seconds>', 'repeat forever with this many seconds between drain cycles')
  .description(
    'Cluster every raw item not yet in news_cluster_items (oldest first), then close stale ' +
      'clusters. With --loop, keeps draining on an interval — the local stand-in for the ' +
      'deployed process Lambda (run it alongside `poll --loop`).',
  )
  .action(async (options: { batch: string; loop?: string }) => {
    const batchSize = parsePositiveInt(options.batch, '--batch');
    const loopSeconds =
      options.loop === undefined ? undefined : parsePositiveInt(options.loop, '--loop');
    await withDb(async (db) => {
      for (;;) {
        try {
          await drainProcessBacklog(db, batchSize);
        } catch (error) {
          if (loopSeconds === undefined) throw error;
          // Loop mode mirrors `poll --loop` / `bars:record --loop`: a failed
          // cycle is logged and the next tick retries it. Nothing needs
          // repairing — an item that failed to cluster is still unclustered, so
          // the next drain picks it up, and both attach and link persistence are
          // idempotent. Without this, one transient DB blip ended the loop.
          console.error(
            `[process] cycle FAILED: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (loopSeconds === undefined) return;
        console.log(`[process] sleeping ${loopSeconds}s (ctrl-c to stop)`);
        await sleep(loopSeconds * 1000);
      }
    });
  });

/** One full drain: cluster+resolve every unclustered item, then close stale clusters. */
async function drainProcessBacklog(db: Db, batchSize: number): Promise<void> {
  // One dictionary snapshot per drain cycle — items arriving mid-cycle are
  // resolved against it; the next cycle (or `resolve`) picks up any universe
  // changes made meanwhile.
  const dictionary = await loadResolverDictionary(db);
  const totals = {
    processed: 0,
    newClusters: 0,
    attachedExisting: 0,
    itemsLinked: 0,
    linksWritten: 0,
  };
  for (;;) {
    const items = await loadUnclusteredItems(db, batchSize);
    if (items.length === 0) break;
    const counts = await runProcess(db, items, dictionary);
    totals.processed += counts.processed;
    totals.newClusters += counts.newClusters;
    totals.attachedExisting += counts.attachedExisting;
    totals.itemsLinked += counts.itemsLinked;
    totals.linksWritten += counts.linksWritten;
    console.log(
      `[process] batch: processed=${counts.processed} newClusters=${counts.newClusters} ` +
        `attachedExisting=${counts.attachedExisting} itemsLinked=${counts.itemsLinked} ` +
        `linksWritten=${counts.linksWritten}`,
    );
  }
  const closed = await closeStaleClusters(db);
  console.log(
    `[process] done: processed=${totals.processed} newClusters=${totals.newClusters} ` +
      `attachedExisting=${totals.attachedExisting} itemsLinked=${totals.itemsLinked} ` +
      `linksWritten=${totals.linksWritten} staleClustersClosed=${closed}`,
  );
}

program
  .command('universe:sync')
  .description(
    'Sync the instrument universe: S&P 500 from Wikipedia (CIKs cross-checked against SEC), ' +
      'SPX point-in-time membership diff, crypto seeds, and the alias dictionary. ' +
      'Requires EDGAR_USER_AGENT (SEC rejects anonymous clients).',
  )
  .action(async () => {
    const userAgent = process.env['EDGAR_USER_AGENT'];
    await withDb(async (db) => {
      const counts = await syncUniverse(db, {
        fetchSp500: () => fetchSp500FromWikipedia({ userAgent }),
        fetchSecTickers: () => fetchSecTickerMap({ userAgent }),
      });
      console.table([
        {
          equities: counts.equities,
          'crypto seeded': counts.cryptoSeeded,
          'members added': counts.membersAdded,
          'members closed': counts.membersClosed,
          'aliases inserted': counts.aliasesInserted,
          'aliases closed': counts.aliasesClosed,
        },
      ]);
    });
  });

program
  .command('resolve')
  .option('--batch <n>', 'items per resolution batch', '500')
  .description(
    'Backfill entity resolution: link every unlinked raw item to instruments via the ' +
      'dictionary matcher (r1). `process` resolves new items inline; this catches items ' +
      'ingested before the dictionary knew their instruments.',
  )
  .action(async (options: { batch: string }) => {
    const batchSize = parsePositiveInt(options.batch, '--batch');
    await withDb(async (db) => {
      const totals = { passes: 0, processed: 0, linked: 0, linksWritten: 0 };
      // One full sweep over every unlinked item: the keyset cursor (lastKey →
      // after) advances past unresolvable items too, so a head-of-queue block
      // of never-resolvable items (the majority class: non-S&P filings) cannot
      // starve the sweep. Drained when a pass examined fewer than a full batch.
      let after: ResolveCursor | undefined;
      for (;;) {
        const counts = await resolveUnlinkedItems(db, {
          batch: batchSize,
          ...(after !== undefined ? { after } : {}),
        });
        totals.passes += 1;
        totals.processed += counts.processed;
        totals.linked += counts.linked;
        totals.linksWritten += counts.linksWritten;
        console.log(
          `[resolve] batch: processed=${counts.processed} linked=${counts.linked} ` +
            `linksWritten=${counts.linksWritten}`,
        );
        if (counts.processed < batchSize || counts.lastKey === null) break;
        after = counts.lastKey;
      }
      console.log(
        `[resolve] done: passes=${totals.passes} itemsExamined=${totals.processed} ` +
          `linked=${totals.linked} linksWritten=${totals.linksWritten}`,
      );
    });
  });

program
  .command('bars:record')
  .option('--loop <seconds>', 'repeat forever with this many seconds between cycles')
  .description(
    'One bars-recorder tick (architecture §5.5): Massive full-market snapshot for the equity ' +
      'universe + benchmarks, Kraken OHLC per coin → price_bars_1m (first-write-wins). ' +
      'Requires MASSIVE_API_KEY with the Stocks Starter snapshot entitlement.',
  )
  .action(async (options: { loop?: string }) => {
    const loopSeconds =
      options.loop === undefined ? undefined : parsePositiveInt(options.loop, '--loop');
    await withDb(async (db) => {
      // SPY/BTC must exist before the first tick or the snapshot silently
      // misses the abnormal-return baseline; idempotent, so safe every run.
      await ensureBenchmarks(db);
      for (;;) {
        try {
          const counts = await recordSnapshot(db, snapshotDeps());
          console.log(
            `[bars:record] equities=${counts.equitySymbols} equityBars=${counts.equityBarsUpserted} ` +
              `cryptoInstruments=${counts.cryptoInstruments} cryptoBars=${counts.cryptoBarsUpserted}`,
          );
        } catch (error) {
          if (loopSeconds === undefined) throw error;
          // Loop mode mirrors poll --loop: a failed cycle is logged, the next
          // tick supersedes it (bars are immutable facts; no state to repair).
          console.error(
            `[bars:record] cycle FAILED: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        if (loopSeconds === undefined) return;
        console.log(`[bars:record] sleeping ${loopSeconds}s (ctrl-c to stop)`);
        await sleep(loopSeconds * 1000);
      }
    });
  });

program
  .command('bars:backfill')
  .option('--from <iso>', 'range start over cluster first_received_at (inclusive)')
  .option('--to <iso>', 'range end (default: now)')
  .option('--days <n>', 'shorthand when --from is omitted: from = to − n days', '3')
  .option(
    '--throttle-ms <n>',
    'delay between sequential Massive calls (default 250 ≈ 4 req/s for Starter; ' +
      'a key still on free-tier stocks limits needs ~13000 ≈ 5 req/min or every call 429s)',
  )
  .description(
    'Seed benchmarks, top up daily bars (beta window), then backfill minute bars around every ' +
      'clustered story in the range via Massive aggregates / Kraken OHLC (event windows ' +
      'anchor−72h … anchor+5d, coalesced per instrument).',
  )
  .action(async (options: { from?: string; to?: string; days: string; throttleMs?: string }) => {
    const to = options.to === undefined ? new Date() : parseIsoDate(options.to, '--to');
    const from =
      options.from === undefined
        ? new Date(to.getTime() - parsePositiveInt(options.days, '--days') * DAY_MS)
        : parseIsoDate(options.from, '--from');
    if (from.getTime() > to.getTime()) throw new Error('--from must not be after --to');
    const throttleMs =
      options.throttleMs === undefined
        ? undefined
        : parsePositiveInt(options.throttleMs, '--throttle-ms');
    await withDb(async (db) => {
      const benchmarks = await ensureBenchmarks(db);
      // Daily lookback: the beta estimator wants 90 d of dailies BEFORE the
      // earliest anchor in the range, plus margin for non-trading days.
      const lookbackDays = Math.ceil((Date.now() - from.getTime()) / DAY_MS) + 100;
      const daily = await ensureDailyBars(
        db,
        { ...dailyBarsDeps(), ...(throttleMs !== undefined ? { throttleMs } : {}) },
        { lookbackDays },
      );
      const backfill = await backfillEventWindows(
        db,
        { ...backfillDeps(), ...(throttleMs !== undefined ? { throttleMs } : {}) },
        { from, to },
      );
      console.table([
        {
          'benchmarks seeded': benchmarks.inserted,
          'daily bars': daily.barsUpserted,
          clusters: backfill.clusters,
          instruments: backfill.instruments,
          'windows (coalesced)': `${backfill.windowsRequested} (${backfill.windowsCoalesced})`,
          'minute bars': backfill.barsUpserted,
          'crypto gap windows': backfill.cryptoGapWindows,
        },
      ]);
    });
  });

program
  .command('calendar:sync')
  .option('--horizon-days <n>', 'forward window for scheduled events', '90')
  .description(
    'Sync scheduled_events from the macro calendars (FOMC/CPI/NFP/GDP/PCE) and — when ' +
      'FINNHUB_API_KEY is set — the Finnhub earnings calendar for current S&P 500 members. ' +
      'Feeds the deterministic already_expected / calendar_match feature.',
  )
  .action(async (options: { horizonDays: string }) => {
    const horizonDays = parsePositiveInt(options.horizonDays, '--horizon-days');
    await withDb(async (db) => {
      const counts = await syncCalendar(db, defaultCalendarDeps(process.env), { horizonDays });
      console.table([
        {
          ...counts.inserted,
          duplicates: counts.duplicates,
          'outside window': counts.outsideWindow,
          'earnings skipped': counts.earningsSymbolsSkipped,
        },
      ]);
    });
  });

program
  .command('measure')
  .option(
    '--since-hours <n>',
    'measure clusters first seen in the last N hours',
    '216', // matches services/handlers/src/measure.ts's MEASURE_SINCE_HOURS default (5d horizons need ~9d of window)
  )
  .description(
    'Run the reaction/recovery measurer over recent clusters: abnormal-return ladder per ' +
      '(cluster, instrument, horizon), one-day summary, recovery metrics for negative events. ' +
      'Anchored on first_received_at; idempotent (conflict-do-nothing per horizon).',
  )
  .action(async (options: { sinceHours: string }) => {
    const sinceHours = parsePositiveInt(options.sinceHours, '--since-hours');
    await withDb(async (db) => {
      const totals = await measureReactions(db, { sinceHours });
      console.table([totals]);
    });
  });

program
  .command('rules:init')
  .description(
    "Seed the shipped v1 default rules version ('v1-conservative': long-only, EMPTY event-type " +
      'whitelist — trades NOTHING until evidence earns entries). Idempotent; a drifted default ' +
      'under the same label throws (rules are immutable — ship changes as a new label).',
  )
  .action(async () => {
    await withDb(async (db) => {
      const record = await ensureDefaultRules(db);
      console.log(
        `rules version ${record.created ? 'created' : 'already present'}: ` +
          `label=${record.label} hash=${record.configHash} id=${record.id}`,
      );
    });
  });

program
  .command('decide')
  .option('--rules <label>', 'rules version label', DEFAULT_RULES_LABEL)
  .option('--batch <n>', 'signals per pass', '200')
  .option('--execute', 'place pending open intents through the SimBroker (venue: sim ONLY)')
  .description(
    'Run the pure decision engine over every undecided llm_signals row (recording one decisions ' +
      'row per signal, skips included), then list the open intents still awaiting an order. ' +
      'Kill switch: NEWSTRADER_KILL_SWITCH=halt records decisions suppressed and emits nothing ' +
      '(or, with KILL_SWITCH_SSM_PARAM set, the deployed SSM parameter — any read failure halts).',
  )
  .action(async (options: { rules: string; batch: string; execute?: boolean }) => {
    const batch = parsePositiveInt(options.batch, '--batch');
    await withDb(async (db) => {
      if (options.rules === DEFAULT_RULES_LABEL) await ensureDefaultRules(db);
      const broker = simBrokerFromEnv(db);
      const killSwitch = await cliKillSwitch(); // env-backed locally, or SSM when KILL_SWITCH_SSM_PARAM is set
      const engineVersion = resolveEngineVersion();

      const totals: Omit<DecideSignalsTotals, 'intents'> = {
        examined: 0,
        decided: 0,
        opens: 0,
        skips: 0,
        suppressed: 0,
      };
      for (;;) {
        const pass = await decideSignals(
          db,
          { decide, broker, killSwitchHalted: killSwitch.halted, engineVersion },
          { rulesLabel: options.rules, batch },
        );
        totals.examined += pass.examined;
        totals.decided += pass.decided;
        totals.opens += pass.opens;
        totals.skips += pass.skips;
        totals.suppressed += pass.suppressed;
        if (pass.examined < batch) break; // drained: every decided signal leaves the set
      }
      console.table([{ ...totals, 'kill switch': killSwitch.state, engine: engineVersion }]);

      if (killSwitch.halted) {
        console.log('kill switch HALTED: decisions recorded suppressed; no intents emitted.');
        return;
      }
      const rules = await getRulesVersion(db, options.rules);
      const intents = await loadPendingOpenIntents(db, {
        rulesVersionId: rules.id,
        now: new Date(),
      });
      if (intents.length === 0) {
        console.log('no pending open intents (every open decision already has an order).');
        return;
      }
      console.log(`-- ${intents.length} pending open intent(s) --`);
      console.table(
        intents.map((intent) => ({
          clientOrderId: intent.clientOrderId,
          instrument: intent.instrumentId,
          side: intent.side,
          qty: intent.qty,
        })),
      );
      if (options.execute !== true) {
        console.log('(dry run — pass --execute to place these through the SimBroker)');
        return;
      }
      // Execution re-checks the switch independently of decide (architecture §4.4).
      if ((await cliKillSwitch()).halted) {
        console.log('kill switch HALTED at execution time: no orders placed.');
        return;
      }
      for (const intent of intents) {
        const ack = await broker.placeOrder(intent);
        console.log(
          `[execute] ${intent.side} ${intent.qty} ${intent.instrumentId}: ${ack.status}` +
            `${ack.reason !== undefined ? ` (${ack.reason})` : ''} order=${ack.brokerOrderId}`,
        );
      }
    });
  });

program
  .command('positions')
  .description(
    'Derived open positions (from sim fills — no mutable positions table), account state, ' +
      'unrealized P&L per position, and realized P&L / fees across all closed quantity',
  )
  .action(async () => {
    await withDb(async (db) => {
      const broker = simBrokerFromEnv(db);
      const positions = await broker.getPositions();
      const account = await broker.getAccountState();
      const portfolio = derivePortfolio(await loadSimPortfolioFills(db));
      if (positions.length === 0) {
        console.log('no open positions.');
      } else {
        const rows = [];
        for (const position of positions) {
          const mark = await latestCloseFor(db, position.instrumentId);
          // Signed qty × (mark − avg entry) marks longs and shorts correctly.
          const unrealized =
            mark === null
              ? '—'
              : formatDec(
                  roundTo(
                    mul(
                      parseDec(position.qty),
                      sub(parseDec(mark), parseDec(position.avgEntryPrice)),
                    ),
                    2,
                  ),
                );
          rows.push({
            instrument: await symbolFor(db, position.instrumentId),
            qty: position.qty,
            'avg entry': position.avgEntryPrice,
            mark: mark ?? '—',
            'unrealized P&L': unrealized,
          });
        }
        console.table(rows);
      }
      console.table([
        {
          'cash USD': account.cashUsd,
          'equity USD': account.equityUsd,
          'realized P&L': portfolio.realizedPnlUsd,
          'fees paid': portfolio.feesUsd,
        },
      ]);
    });
  });

program
  .command('manage')
  .option(
    '--rules <label>',
    'rules version the close decisions are recorded under',
    DEFAULT_RULES_LABEL,
  )
  .description(
    'One position-manager pass: evaluate every open position against the exit policy ' +
      '(time stop at the signal horizon, stop-loss/take-profit in ATR multiples) and close ' +
      'through the SimBroker. Exits are recorded as replayable action=close decisions. ' +
      'Kill switch: NEWSTRADER_KILL_SWITCH, or KILL_SWITCH_SSM_PARAM for the deployed SSM parameter.',
  )
  .action(async (options: { rules: string }) => {
    await withDb(async (db) => {
      if (options.rules === DEFAULT_RULES_LABEL) await ensureDefaultRules(db);
      const rules = await getRulesVersion(db, options.rules);
      const result = await evaluateOpenPositions(db, {
        broker: simBrokerFromEnv(db),
        rules: rules.config,
        rulesVersionId: rules.id,
        now: new Date(),
        evaluateExit: engineExitEvaluator,
        checkHalted: async () => (await cliKillSwitch()).halted,
      });
      console.table([
        {
          evaluated: result.evaluated,
          closed: result.closed,
          suppressed: result.suppressed,
          skipped: result.skipped,
        },
      ]);
      if (result.details.length > 0) console.table(result.details);
    });
  });

program
  .command('replay')
  .requiredOption('--rules <label>', 'rules version to replay under')
  .option('--from <iso>', 'signals window start (analyzed_at, inclusive)')
  .option('--to <iso>', 'signals window end (inclusive)')
  .option('--notes <text>', 'free-form note stored on the replay run')
  .description(
    'Replay the stored signal log under a rules version, re-executing decide() from each ' +
      "signal's snapshotted features/quote (never live queries). Replaying the LIVE rules " +
      'version must reproduce live decisions bit-for-bit (Mode A).',
  )
  .action(async (options: { rules: string; from?: string; to?: string; notes?: string }) => {
    await withDb(async (db) => {
      const run = await createReplayRun(db, {
        rulesLabel: options.rules,
        from: options.from === undefined ? null : parseIsoDate(options.from, '--from'),
        to: options.to === undefined ? null : parseIsoDate(options.to, '--to'),
        notes: options.notes ?? null,
      });
      const totals = await runReplay(db, { decide }, { replayRunId: run.id });
      console.log(`replay run: ${run.id}`);
      console.table([totals]);
      if (totals.modeBUnsoundPortfolioFeatures) {
        console.log(
          "WARNING: this run's rules label differs from the label that produced the live " +
            'decisions it reused. Portfolio features (openPositionsCount / paperEquityUsd) were ' +
            'copied from the LIVE run, not recomputed for this label — this replay is Mode B and ' +
            'its results may not reflect what this rules version would actually have done. ' +
            'See the mode_b_unsound_portfolio_features log line above for the labels involved.',
        );
      }
      console.log(`compare with: pnpm cli replay:compare --a live --b ${run.id}`);
    });
  });

program
  .command('replay:compare')
  .requiredOption('--a <run>', "replay run id, or 'live' for live paper decisions")
  .requiredOption('--b <run>', "replay run id, or 'live'")
  .option(
    '--live-rules <label>',
    "rules label to scope the 'live' side to when comparing against it " +
      "(default: the OTHER side's own rules label)",
  )
  .description(
    'Per-signal join of two runs: matched counts plus every divergence ' +
      '(action / size / skip-reason changes)',
  )
  .action(async (options: { a: string; b: string; liveRules?: string }) => {
    await withDb(async (db) => {
      let liveRulesVersionId: string | undefined;
      if (options.a === LIVE_RUN || options.b === LIVE_RUN) {
        const otherRun = options.a === LIVE_RUN ? options.b : options.a;
        const label =
          options.liveRules ??
          (otherRun === LIVE_RUN ? undefined : await getReplayRunRulesLabel(db, otherRun));
        if (label === undefined) {
          throw new Error(
            'replay:compare: --live-rules is required when comparing live against live ' +
              '(there is no other run to default the label from)',
          );
        }
        liveRulesVersionId = (await getRulesVersion(db, label)).id;
      }
      const result = await compareRuns(db, {
        runA: options.a,
        runB: options.b,
        ...(liveRulesVersionId !== undefined ? { liveRulesVersionId } : {}),
      });
      console.table([result.summary]);
      if (result.divergences.length === 0) {
        console.log('no divergences.');
        return;
      }
      const MAX_ROWS = 50;
      console.table(
        result.divergences.slice(0, MAX_ROWS).map((divergence) => ({
          signal: divergence.signalId,
          reasons: divergence.reasons.join(','),
          'a action': divergence.a.action,
          'b action': divergence.b.action,
          'a skip': divergence.a.skipReason ?? '—',
          'b skip': divergence.b.skipReason ?? '—',
          'a qty': divergence.a.sizedQty ?? '—',
          'b qty': divergence.b.sizedQty ?? '—',
        })),
      );
      if (result.divergences.length > MAX_ROWS) {
        console.log(`(+${result.divergences.length - MAX_ROWS} more divergences not shown)`);
      }
    });
  });

program
  .command('stats')
  .description(
    'KPIs: items/day by source, dedup ratio, top clusters, clusters/day, resolution coverage, ' +
      'reaction ladder + alpha-decay medians (last 7d), upcoming calendar events, and the ' +
      'trading section (decisions by action, open positions, paper equity, realized P&L)',
  )
  .action(async () => {
    await withDb(printStats);
  });

program
  .command('db:ping')
  .description('Connectivity smoke test: connect and SELECT 1')
  .action(async () => {
    await withDb(async (db) => {
      const result = await db.$client.query<{ ok: number }>('select 1 as ok');
      if (result.rows[0]?.ok !== 1) throw new Error('SELECT 1 did not return 1');
      console.log('db: ok');
    });
  });

// The root `pnpm cli` script forwards args as `start -- <args>`; pnpm passes
// the `--` through literally, which commander would treat as end-of-commands.
// Drop it when it is the first forwarded token.
const argv = process.argv.filter((arg, index) => !(index === 2 && arg === '--'));

program.parseAsync(argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

// ------------------------------------------------------------------ helpers --

async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const db = createDb();
  try {
    return await fn(db);
  } finally {
    await db.$client.end();
  }
}

function adaptersFromEnv(): SourceAdapter[] {
  const adapters = allAdapters(process.env);
  if (adapters.length === 0) throw new Error('No adapters enabled — check your .env');
  return adapters;
}

function selectAdapters(sourceKey: string | undefined): SourceAdapter[] {
  const adapters = adaptersFromEnv();
  if (sourceKey === undefined) return adapters;
  const match = adapters.filter((adapter) => adapter.sourceKey === sourceKey);
  if (match.length === 0) {
    const available = adapters.map((adapter) => adapter.sourceKey).join(', ');
    throw new Error(`Unknown source "${sourceKey}". Enabled sources: ${available}`);
  }
  return match;
}

/** One cycle over all selected adapters; per-adapter failures don't stop the rest. */
async function pollCycle(
  db: Db,
  rawStore: RawStore,
  adapters: readonly SourceAdapter[],
): Promise<number> {
  let failed = 0;
  for (const adapter of adapters) {
    try {
      const counts = await runPoll({ db, rawStore }, adapter);
      console.log(
        `[poll] ${counts.sourceKey}: fetched=${counts.fetched} inserted=${counts.inserted} ` +
          `duplicates=${counts.duplicates}`,
      );
    } catch (error) {
      failed += 1;
      console.error(
        `[poll] ${adapter.sourceKey} FAILED: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return failed;
}

/** Latest recorded bar close for the instrument (any age — honest paper mark). */
async function latestCloseFor(db: Db, instrumentId: string): Promise<string | null> {
  const result = await db.$client.query<{ close: string }>(
    'select close from price_bars_1m where instrument_id = $1 order by ts desc limit 1',
    [instrumentId],
  );
  return result.rows[0]?.close ?? null;
}

async function symbolFor(db: Db, instrumentId: string): Promise<string> {
  const result = await db.$client.query<{ symbol: string }>(
    'select symbol from instruments where id = $1',
    [instrumentId],
  );
  return result.rows[0]?.symbol ?? instrumentId;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

function parseIsoDate(value: string, flag: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${flag} must be an ISO date/time, got "${value}"`);
  }
  return parsed;
}

// ------------------------------------------------------------- bars deps --
// Composition per the doc comments on RecordSnapshotDeps / BackfillDeps /
// EnsureDailyBarsDeps: Massive key from .env (Bearer header, never a URL
// param), Kraken public (no auth). Kraken bars-deps note: the OHLC endpoint
// only serves ~720 candles, so crypto backfill is best-effort by design.

function massiveOptions(): MassiveBarsOptions {
  return {
    apiKey: process.env['MASSIVE_API_KEY'],
    baseUrl: process.env['MASSIVE_BASE_URL'],
  };
}

function snapshotDeps(): RecordSnapshotDeps {
  const massive = massiveOptions();
  return {
    fetchEquitySnapshot: (symbols) => fetchSnapshotMinuteBars(massive, symbols),
    fetchCryptoMinuteBars: (symbol) => fetchKrakenOhlc({}, { symbol, interval: 1 }),
  };
}

function backfillDeps(): BackfillDeps {
  const massive = massiveOptions();
  return {
    fetchEquityMinuteBars: (symbol, fromMs, toMs) =>
      fetchAggsBars(massive, { symbol, timespan: 'minute', fromMs, toMs }),
    fetchCryptoMinuteBars: (symbol) => fetchKrakenOhlc({}, { symbol, interval: 1 }),
  };
}

function dailyBarsDeps(): EnsureDailyBarsDeps {
  const massive = massiveOptions();
  return {
    fetchEquityDailyBars: (symbol, fromMs, toMs) =>
      fetchAggsBars(massive, { symbol, timespan: 'day', fromMs, toMs }),
    fetchCryptoDailyBars: (symbol) => fetchKrakenOhlc({}, { symbol, interval: 1440 }),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
