import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allAdapters, FsRawStore } from '@newstrader/adapters';
import {
  CURRENT_PROMPT_VERSION,
  DEFAULT_RULES_LABEL,
  decide,
  formatDec,
  getMacroPromptDefinition,
  getPromptDefinition,
  mul,
  parseDec,
  roundTo,
  sub,
} from '@newstrader/core';
import type { RawStore, SourceAdapter } from '@newstrader/core';
import {
  anthropicLlmClient,
  anthropicTriageClient,
  claudeCliTriageClient,
  triageSweep,
  backfillEventWindows,
  runBacktest,
  claudeCliLlmClient,
  closeStaleClusters,
  compareRuns,
  createDb,
  createReplayRun,
  decideSignals,
  defaultCalendarDeps,
  documentSweep,
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
  interpretSweep,
  macroInterpretSweep,
  LIVE_RUN,
  loadResolverDictionary,
  MEASURER_VERSION,
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
  LlmClient,
  LlmTransport,
  TriageLlmClient,
  MassiveBarsOptions,
  RecordSnapshotDeps,
  ResolveCursor,
} from '@newstrader/db';
import { Command } from 'commander';
import dotenv from 'dotenv';
import {
  ensureSource,
  loadUnclusteredItems,
  NYT_SOURCE_KEYS,
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
import { DEFAULT_LATENCY_OPTIONS, printLatencyPricing } from './eval-latency.js';
import {
  EVAL_HORIZONS,
  printEvalSignals,
  SESSION_BUCKETS,
  type EvalHorizon,
  type SessionBucket,
} from './eval-signals.js';
import { collectWeeklyData, renderWeeklyReport } from './report-weekly.js';
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
    'NewsTrader: ingest -> cluster -> resolve -> interpret (M2, claude-sonnet-5) -> decide -> ' +
      'paper-trade (venue SIM only). LLM spend is capped per UTC day and kill-switch-guarded.',
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
  .command('resolve:triage')
  .option('--batch <n>', 'items per pass', '50')
  .option('--until-empty', 'keep taking batches until no candidates remain')
  .option('--from <iso>', 'received_at window start')
  .option('--to <iso>', 'received_at window end')
  .option('--item-ids-file <path>', 'restrict to these item ids (one per line, # comments)')
  .option('--dry-run', 'assemble candidates and print the first prompt; no API calls, no writes')
  .option(
    '--mode <api|cli>',
    "transport: 'api' = SDK + ANTHROPIC_API_KEY (the only production mode); " +
      "'cli' = the Claude Code CLI on your subscription, DEV-ONLY. Defaults to " +
      'LLM_TRANSPORT, else api.',
  )
  .description(
    'Resolver r2 triage: one claude-haiku-4-5 call per vendor-tagged item, confirming which ' +
      "source_hint candidates the article is materially about. Confirmed candidates get 'llm_ner' " +
      'links (0.9, above the interpretation gate); every verdict lands in item_triage. Requires ' +
      'ANTHROPIC_API_KEY (except --dry-run and --mode cli). Shares the kill switch and ' +
      'LLM_DAILY_SPEND_USD_CAP with interpret.',
  )
  .action(
    async (options: {
      batch: string;
      untilEmpty?: boolean;
      from?: string;
      to?: string;
      itemIdsFile?: string;
      dryRun?: boolean;
      mode?: string;
    }) => {
      const batch = parsePositiveInt(options.batch, '--batch');
      const dryRun = options.dryRun === true;
      const from = options.from === undefined ? undefined : parseIsoDate(options.from, '--from');
      const to = options.to === undefined ? undefined : parseIsoDate(options.to, '--to');
      const itemIds =
        options.itemIdsFile === undefined ? undefined : readIdsFile(options.itemIdsFile);
      const dailySpendCapUsd = parseSpendCapEnv();
      const mode = parseTransportMode(options.mode ?? process.env['LLM_TRANSPORT']);
      if (mode === 'cli' && !dryRun) {
        console.warn(
          '[resolve:triage] mode=cli — DEV ONLY. item_triage rows are stamped transport=cli; ' +
            'their cost_usd is inflated by the Claude Code harness prompt. Use --mode api ' +
            'with ANTHROPIC_API_KEY for the deployed path.',
        );
      }
      const llm: TriageLlmClient = dryRun
        ? {
            transport: mode,
            triage: (): never => {
              throw new Error('dry-run must never reach the LLM');
            },
          }
        : mode === 'cli'
          ? claudeCliTriageClient(process.env)
          : anthropicTriageClient(process.env);

      await withDb(async (db) => {
        const store = new FsRawStore(
          process.env['RAW_STORE_DIR'] ?? path.join(REPO_ROOT, 'data', 'raw'),
        );
        for (;;) {
          const killSwitch = await cliKillSwitch();
          const result = await triageSweep(
            db,
            { llm, auditStore: store, payloadStore: store, killSwitchHalted: killSwitch.halted },
            {
              batch,
              dryRun,
              ...(from !== undefined ? { from } : {}),
              ...(to !== undefined ? { to } : {}),
              ...(itemIds !== undefined ? { itemIds } : {}),
              ...(dailySpendCapUsd !== undefined ? { dailySpendCapUsd } : {}),
            },
          );
          if (dryRun) {
            console.log(
              result.samplePrompt === null
                ? '[resolve:triage] dry run: no candidates'
                : `\n----- first triage prompt -----\n${result.samplePrompt}\n-------------------------------`,
            );
          }
          console.table([
            {
              examined: result.examined,
              triaged: result.triaged,
              'with relevant': result.withRelevant,
              'links written': result.linksWritten,
              failures: result.failures,
              'spend cap hit': result.spendCapReached,
              'spent today $': Number(result.spentTodayUsd.toFixed(4)),
              'kill switch': result.halted ? 'HALTED' : 'run',
              'transport error': result.transportError ?? '—',
            },
          ]);
          const done =
            dryRun ||
            options.untilEmpty !== true ||
            result.halted ||
            result.spendCapReached ||
            result.transportError !== null ||
            result.examined === 0;
          if (done) return;
        }
      });
    },
  );

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
  .option(
    '--backfill-from <yyyy-mm-dd>',
    'also upsert past events from this UTC day, stamped meta.backfilled=true ' +
      '(analytics ground truth only; Finnhub free tier serves ~30 days back)',
  )
  .description(
    'Sync scheduled_events from the macro calendars (FOMC/CPI/NFP/GDP/PCE) and — when ' +
      'FINNHUB_API_KEY is set — the Finnhub earnings calendar for current S&P 500 members. ' +
      'Feeds the deterministic already_expected / calendar_match feature.',
  )
  .action(async (options: { horizonDays: string; backfillFrom?: string }) => {
    const horizonDays = parsePositiveInt(options.horizonDays, '--horizon-days');
    await withDb(async (db) => {
      const counts = await syncCalendar(db, defaultCalendarDeps(process.env), {
        horizonDays,
        ...(options.backfillFrom !== undefined ? { backfillFromDay: options.backfillFrom } : {}),
      });
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
  .command('edgar:documents')
  .option('--batch <n>', 'filings per pass', '100')
  .option(
    '--loop <seconds>',
    'run as a standing service: repeat forever with this many seconds between passes, ' +
      'idling when the queue is empty (new 8-Ks arrive all day)',
  )
  .option(
    '--until-empty',
    'with --loop, stop once the queue drains instead of idling — the backfill form',
  )
  .option(
    '--form-types <list>',
    "comma-separated meta.formType values to fetch (default '8-K,8-K/A')",
  )
  .option(
    '--refetch',
    're-fetch filings that already have stored text (use after the extractor improves); ' +
      'blobs are keyed per item so a refetch overwrites in place',
  )
  .option(
    '--refetch-stale',
    'with --refetch, re-fetch ONLY filings stored by an older fetcher version that a ' +
      'cap trimmed — the form to use after raising the caps. Converges: each filing is ' +
      'revisited at most once per version bump',
  )
  .description(
    'Fetch SEC filing bodies + press-release exhibits for EDGAR items and store them for ' +
      'the interpreter. Without this an 8-K reaches the model as a form type and item codes ' +
      'only — its stored Atom summary is filing metadata (median 57 chars). Re-run to ' +
      'continue; oldest first, idempotent per item. --loop runs it as a standing service; ' +
      'add --until-empty to drain and exit. Requires EDGAR_USER_AGENT.',
  )
  .action(
    async (options: {
      batch: string;
      loop?: string;
      formTypes?: string;
      untilEmpty?: boolean;
      refetch?: boolean;
      refetchStale?: boolean;
    }) => {
      const batch = parsePositiveInt(options.batch, '--batch');
      const loopSeconds =
        options.loop === undefined ? undefined : parsePositiveInt(options.loop, '--loop');
      const untilEmpty = options.untilEmpty === true;
      if (untilEmpty && loopSeconds === undefined) {
        throw new Error('edgar:documents: --until-empty only means something with --loop');
      }
      const refetch = options.refetch === true || options.refetchStale === true;
      if (options.refetchStale === true && options.refetch !== true) {
        console.log('[edgar:documents] --refetch-stale implies --refetch');
      }
      const userAgent = process.env['EDGAR_USER_AGENT']?.trim();
      if (userAgent === undefined || userAgent === '') {
        // SEC 403s requests without a contact string; fail loudly rather than
        // burn the queue's attempts on a wall of 403s.
        throw new Error(
          'edgar:documents requires EDGAR_USER_AGENT ("Name email@example.com") — SEC ' +
            'rejects requests without a contact string.',
        );
      }
      const formTypes = options.formTypes
        ?.split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

      await withDb(async (db) => {
        const store = new FsRawStore(
          process.env['RAW_STORE_DIR'] ?? path.join(REPO_ROOT, 'data', 'raw'),
        );
        for (;;) {
          const result = await documentSweep(
            db,
            { store, userAgent },
            {
              batch,
              ...(formTypes !== undefined && formTypes.length > 0 ? { formTypes } : {}),
              ...(refetch ? { refetch: true } : {}),
              ...(options.refetchStale === true ? { refetchStaleOnly: true } : {}),
            },
          );
          console.table([
            {
              examined: result.examined,
              stored: result.stored,
              'no documents': result.empty,
              failed: result.failed,
              truncated: result.truncated,
              'chars stored': result.charsStored,
              'left to fetch': result.remaining,
            },
          ]);
          if (loopSeconds === undefined) return;
          if (result.examined === 0) {
            // --loop is a standing service (same contract as poll/process): new
            // 8-Ks arrive all day, so an empty queue means "caught up", not
            // "finished". Only --until-empty treats it as a stop condition.
            if (untilEmpty) {
              console.log('[edgar:documents] queue empty — done');
              return;
            }
            console.log(
              `[edgar:documents] caught up — next check in ${loopSeconds}s (ctrl-c to stop)`,
            );
          } else {
            console.log(`[edgar:documents] sleeping ${loopSeconds}s (ctrl-c to stop)`);
          }
          await sleep(loopSeconds * 1000);
        }
      });
    },
  );

program
  .command('interpret')
  .option('--batch <n>', 'cluster×instrument pairs per pass', '25')
  .option('--loop <seconds>', 'repeat forever with this many seconds between passes')
  .option('--lookback-hours <n>', 'live window over cluster first_received_at', '24')
  .option(
    '--retrospective-from <iso>',
    'backfill window start — rows are stamped retrospective=true and NEVER reach the live decide queue',
  )
  .option('--retrospective-to <iso>', 'backfill window end (required with --retrospective-from)')
  .option(
    '--backfill',
    'work the whole backlog oldest-first: a retrospective window covering every ' +
      'cluster older than the live lookback. Re-run the SAME command to keep going — ' +
      'each pass takes the next --batch pairs and written rows leave the queue. Done ' +
      'when examined is 0.',
  )
  .option('--dry-run', 'assemble candidates and print the first prompt; no API calls, no writes')
  .option(
    '--prompt-version <v>',
    'registry version to run (default: the current version). Experiment arms ' +
      '(v3-nofiling, v4a, ...) live here; each version keys its own signal rows.',
  )
  .option(
    '--pairs-file <path>',
    'restrict the run to the clusterId:instrumentId pairs listed in this file ' +
      '(one per line, # comments allowed) — the sampling hook for prompt ' +
      'experiments. Requires a retrospective window (--backfill or --retrospective-*).',
  )
  .option(
    '--mode <api|cli>',
    "transport: 'api' = SDK + ANTHROPIC_API_KEY (the only production mode); " +
      "'cli' = the Claude Code CLI on your subscription, DEV-ONLY. Defaults to " +
      'LLM_TRANSPORT, else api.',
  )
  .description(
    'M2: interpret novel clusters carrying an instrument link (confidence >= 0.75) into ' +
      'llm_signals via claude-sonnet-5 structured output. One call per cluster×instrument pair; ' +
      'idempotent on signal_key. Requires ANTHROPIC_API_KEY (except --dry-run and --mode cli). ' +
      'Guarded by the kill switch and LLM_DAILY_SPEND_USD_CAP (default $5/UTC-day).',
  )
  .action(
    async (options: {
      batch: string;
      loop?: string;
      lookbackHours: string;
      retrospectiveFrom?: string;
      retrospectiveTo?: string;
      dryRun?: boolean;
      mode?: string;
      backfill?: boolean;
      promptVersion?: string;
      pairsFile?: string;
    }) => {
      const batch = parsePositiveInt(options.batch, '--batch');
      const lookbackHours = parsePositiveInt(options.lookbackHours, '--lookback-hours');
      const loopSeconds =
        options.loop === undefined ? undefined : parsePositiveInt(options.loop, '--loop');
      const dryRun = options.dryRun === true;
      const retrospective =
        options.backfill === true
          ? backfillWindow(options.retrospectiveFrom, options.retrospectiveTo, lookbackHours)
          : parseRetrospectiveWindow(options.retrospectiveFrom, options.retrospectiveTo);
      if (retrospective !== undefined && loopSeconds !== undefined) {
        throw new Error('interpret: a retrospective backfill is one-shot — drop --loop');
      }
      // Validate the version against the registry HERE so a typo fails before
      // any window math or client construction, with the registered list shown.
      if (options.promptVersion !== undefined) getPromptDefinition(options.promptVersion);
      const samplePairs =
        options.pairsFile === undefined ? undefined : readPairsFile(options.pairsFile);
      if (samplePairs !== undefined && retrospective === undefined) {
        throw new Error(
          'interpret: --pairs-file is an experiment hook and requires a retrospective window — add --backfill or --retrospective-from/--retrospective-to',
        );
      }
      const dailySpendCapUsd = parseSpendCapEnv();
      const mode = parseTransportMode(options.mode ?? process.env['LLM_TRANSPORT']);
      if (mode === 'cli' && !dryRun) {
        // Loud on purpose: these rows cost ~25.7k harness tokens each, ignore
        // the prompt version's effort/max_tokens, and are not replayable.
        console.warn(
          '[interpret] mode=cli — DEV ONLY. Rows are stamped transport=cli with a ' +
            ':cli signal_key, and must be excluded from calibration and golden evals. ' +
            'Use --mode api with ANTHROPIC_API_KEY for anything you intend to measure.',
        );
      }

      // Dry runs must work before any key exists; the sweep never calls the
      // client on that path, so a throwing stub keeps the contract honest. The
      // stub still carries the resolved transport: it decides the signal key,
      // and therefore which candidates a dry run reports.
      const llm: LlmClient = dryRun
        ? {
            transport: mode,
            interpret: (): never => {
              throw new Error('dry-run must never reach the LLM');
            },
          }
        : mode === 'cli'
          ? claudeCliLlmClient(process.env)
          : anthropicLlmClient(process.env);

      await withDb(async (db) => {
        // One FsRawStore serves both roles locally: payload refs are absolute
        // paths written at ingest; audit blobs land under <root>/llm/....
        const store = new FsRawStore(
          process.env['RAW_STORE_DIR'] ?? path.join(REPO_ROOT, 'data', 'raw'),
        );
        for (;;) {
          try {
            const killSwitch = await cliKillSwitch();
            const result = await interpretSweep(
              db,
              {
                llm,
                auditStore: store,
                payloadStore: store,
                killSwitchHalted: killSwitch.halted,
              },
              {
                batch,
                lookbackHours,
                dryRun,
                // Only the operator-driven backfill pays for the extra COUNT.
                countRemaining: options.backfill === true,
                ...(retrospective !== undefined ? { retrospective } : {}),
                ...(dailySpendCapUsd !== undefined ? { dailySpendCapUsd } : {}),
                ...(options.promptVersion !== undefined
                  ? { promptVersion: options.promptVersion }
                  : {}),
                ...(samplePairs !== undefined ? { samplePairs } : {}),
              },
            );
            if (dryRun) {
              console.log(
                result.samplePrompt === null
                  ? '[interpret] dry run: no candidates in the window'
                  : `\n----- first user prompt -----\n${result.samplePrompt}\n-----------------------------`,
              );
            }
            // remaining is null when the pass never reached the queue (kill
            // switch halted) — say nothing rather than claim an empty backlog.
            if (options.backfill === true && result.remaining !== null) {
              console.log(
                result.remaining === 0
                  ? '[interpret] backlog empty — every pair older than the live window is done'
                  : `[interpret] ${result.remaining} pairs left to process — re-run the same command to continue`,
              );
            }
            console.table([
              {
                mode: result.transport,
                examined: result.examined,
                'left to process': result.remaining ?? '—',
                interpreted: result.interpreted,
                duplicates: result.duplicates,
                failures: result.failures,
                'spend cap hit': result.spendCapReached,
                'spent today $': Number(result.spentTodayUsd.toFixed(4)),
                'kill switch': result.halted ? 'HALTED' : 'run',
                'transport error': result.transportError ?? '—',
              },
            ]);
          } catch (error) {
            if (loopSeconds === undefined) throw error;
            // Same tolerance as `process --loop`: a failed pass is logged and
            // the next tick retries — candidates are still candidates, and
            // every write path is idempotent on signal_key.
            console.error(
              `[interpret] cycle FAILED: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          if (loopSeconds === undefined) return;
          console.log(`[interpret] sleeping ${loopSeconds}s (ctrl-c to stop)`);
          await sleep(loopSeconds * 1000);
        }
      });
    },
  );

program
  .command('interpret:macro')
  .option('--batch <n>', 'clusters per pass', '25')
  .option('--lookback-hours <n>', 'live window over cluster first_received_at', '24')
  .option(
    '--retrospective-from <iso>',
    'backfill window start — rows are stamped retrospective=true and NEVER reach the live decide queue',
  )
  .option('--retrospective-to <iso>', 'backfill window end (required with --retrospective-from)')
  .option(
    '--backfill',
    'work the whole unlinked backlog oldest-first. Re-run the SAME command to keep going; ' +
      'done when examined is 0.',
  )
  .option(
    '--sources <list>',
    "comma-separated news_sources.source_key values to scope the queue ('nyt' expands to " +
      'every NYT feed plus the archive) — far cheaper than interpreting the whole unlinked ' +
      'backlog to evaluate one source',
  )
  .option('--dry-run', 'assemble candidates and print the first prompt; no API calls, no writes')
  .option('--prompt-version <v>', 'macro registry version (default: the current macro version)')
  .description(
    'MACRO interpretation: clusters carrying NO instrument link (the class `interpret` discards, ' +
      '~87% of everything clustered). The current version (v2m, contract=discovery) picks up to ' +
      '3 differentially-exposed companies from the point-in-time candidate universe and writes ' +
      "ordinary scope='company' llm_signals rows — measurable and evaluable by the existing " +
      'measure/eval:signals machinery. A "no market mechanism" judgment writes no row (the ' +
      'expected majority answer — read the "no mechanism" count, not just rows written), and ' +
      'symbols from outside the shown universe are dropped and counted under "unknown symbols". ' +
      'v1m (contract=sector) stays runnable via --prompt-version. Requires ANTHROPIC_API_KEY: ' +
      'these contracts are api-only. Guarded by the kill switch and LLM_DAILY_SPEND_USD_CAP ' +
      '(default $5/UTC-day), which it SHARES with `interpret`.',
  )
  .action(
    async (options: {
      batch: string;
      lookbackHours: string;
      retrospectiveFrom?: string;
      retrospectiveTo?: string;
      backfill?: boolean;
      sources?: string;
      dryRun?: boolean;
      promptVersion?: string;
    }) => {
      const batch = parsePositiveInt(options.batch, '--batch');
      const lookbackHours = parsePositiveInt(options.lookbackHours, '--lookback-hours');
      const dryRun = options.dryRun === true;
      const retrospective =
        options.backfill === true
          ? backfillWindow(options.retrospectiveFrom, options.retrospectiveTo, lookbackHours)
          : parseRetrospectiveWindow(options.retrospectiveFrom, options.retrospectiveTo);
      // Validated against the registry before any window math, so a typo fails
      // with the registered list rather than after client construction.
      if (options.promptVersion !== undefined) getMacroPromptDefinition(options.promptVersion);
      const sources = expandSourceKeys(splitList(options.sources));
      const dailySpendCapUsd = parseSpendCapEnv();

      // Dry runs must work before any key exists. The stub throws on ALL
      // methods: the sweep checks for the active contract's method up front,
      // so a stub missing one would fail the dry run with a misleading
      // transport error.
      const llm: LlmClient = dryRun
        ? {
            transport: 'api',
            interpret: (): never => {
              throw new Error('dry-run must never reach the LLM');
            },
            interpretMacro: (): never => {
              throw new Error('dry-run must never reach the LLM');
            },
            interpretDiscovery: (): never => {
              throw new Error('dry-run must never reach the LLM');
            },
          }
        : anthropicLlmClient(process.env);

      await withDb(async (db) => {
        const store = new FsRawStore(
          process.env['RAW_STORE_DIR'] ?? path.join(REPO_ROOT, 'data', 'raw'),
        );
        const killSwitch = await cliKillSwitch();
        const result = await macroInterpretSweep(
          db,
          {
            llm,
            auditStore: store,
            payloadStore: store,
            killSwitchHalted: killSwitch.halted,
          },
          {
            batch,
            lookbackHours,
            dryRun,
            ...(retrospective !== undefined ? { retrospective } : {}),
            ...(dailySpendCapUsd !== undefined ? { dailySpendCapUsd } : {}),
            ...(options.promptVersion !== undefined
              ? { promptVersion: options.promptVersion }
              : {}),
            ...(sources !== undefined ? { sourceKeys: sources } : {}),
          },
        );
        if (dryRun) {
          console.log(
            result.samplePrompt === null
              ? '[interpret:macro] dry run: no unlinked candidates in the window'
              : `\n----- first macro user prompt -----\n${result.samplePrompt}\n-----------------------------------`,
          );
        }
        console.table([
          {
            mode: result.transport,
            examined: result.examined,
            interpreted: result.interpreted,
            'rows written': result.rowsWritten,
            'no mechanism': result.noMechanism,
            'unknown symbols': result.unknownSymbols,
            duplicates: result.duplicates,
            failures: result.failures,
            'spend cap hit': result.spendCapReached,
            'spent today $': Number(result.spentTodayUsd.toFixed(4)),
            'kill switch': result.halted ? 'HALTED' : 'run',
            'transport error': result.transportError ?? '—',
          },
        ]);
      });
    },
  );

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
  .command('backtest')
  .requiredOption('--rules <label>', 'rules version label to trade under')
  .option('--from <iso>', 'earliest cluster anchor to consider')
  .option('--to <iso>', 'latest cluster anchor to consider')
  .option('--prompt-versions <list>', 'comma-separated prompt versions (default: current)')
  .option(
    '--transports <list>',
    "comma-separated transports (default 'api'; 'cli' rows did not honour their " +
      "prompt version's effort or max_tokens)",
  )
  .option('--equity <usd>', 'starting paper cash', '100000.00')
  .option(
    '--pipeline-lag-minutes <n>',
    'assumed minutes from news arrival to decision (interpret sweep + decide sweep). ' +
      'Lower is more optimistic and less true',
    '10',
  )
  .option('--slippage-bps <n>', 'override the sim fill slippage')
  .option('--no-persist', 'report only; write no replay_runs or decisions rows')
  .option('--trades', 'print the closed-trade log')
  .description(
    'Backtest the decision engine over historical signals that never had a live decision. ' +
      'Reconstructs every decision input as of the moment the pipeline could have decided ' +
      '(anchor + pipeline lag) — quote, velocity, ATR, liquidity, portfolio — runs the real ' +
      'engine, simulates fills with the production fill model, and reports P&L. Read the ' +
      'as-of contract and limitations in packages/db/src/backtest/backtest.ts before ' +
      'trusting a number.',
  )
  .action(
    async (options: {
      rules: string;
      from?: string;
      to?: string;
      promptVersions?: string;
      transports?: string;
      equity: string;
      pipelineLagMinutes: string;
      slippageBps?: string;
      persist?: boolean;
      trades?: boolean;
    }) => {
      const lagMinutes = parsePositiveInt(options.pipelineLagMinutes, '--pipeline-lag-minutes');
      const promptVersions = splitList(options.promptVersions);
      const transports = splitList(options.transports);
      for (const transport of transports ?? []) {
        if (transport !== 'api' && transport !== 'cli') {
          throw new Error(
            `backtest: --transports entries must be "api" or "cli", got "${transport}"`,
          );
        }
      }
      await withDb(async (db) => {
        const result = await runBacktest(
          db,
          { decide, engineVersion: resolveEngineVersion() },
          {
            rulesLabel: options.rules,
            ...(options.from !== undefined ? { from: parseIsoDate(options.from, '--from') } : {}),
            ...(options.to !== undefined ? { to: parseIsoDate(options.to, '--to') } : {}),
            ...(promptVersions !== undefined ? { promptVersions } : {}),
            ...(transports !== undefined ? { transports: transports as Array<'api' | 'cli'> } : {}),
            startingCashUsd: options.equity,
            pipelineLagMs: lagMinutes * 60_000,
            ...(options.persist === false ? { persist: false } : {}),
            ...(options.slippageBps !== undefined
              ? { slippageBps: parsePositiveInt(options.slippageBps, '--slippage-bps') }
              : {}),
          },
        );
        console.table([
          {
            rules: result.rulesLabel,
            signals: result.examined,
            opens: result.opens,
            skips: result.skips,
            trades: result.trades,
            'win/loss': `${result.wins}/${result.losses}`,
            'realized $': result.realizedUsd,
            'fees $': result.feesUsd,
            'ending equity $': result.endingEquityUsd,
            'still open': result.stillOpen,
          },
        ]);
        if (result.skipReasons.length > 0) {
          console.log('\nwhere the funnel stops:');
          console.table(result.skipReasons);
        }
        if (options.trades === true && result.closedTrades.length > 0) {
          console.table(
            result.closedTrades.map((trade) => ({
              signal: trade.signalId.slice(-8),
              side: trade.side,
              qty: trade.qty,
              entry: trade.entryPrice,
              exit: trade.exitPrice,
              'P&L $': trade.realizedUsd,
              reason: trade.exitReason,
              opened: trade.openedAt.toISOString(),
              closed: trade.closedAt.toISOString(),
            })),
          );
        }
        if (result.examined === 0) {
          console.log(
            '\n[backtest] no signals matched. Interpret some first, and note the default ' +
              "transport filter is 'api' — cli rows are excluded.",
          );
        }
      });
    },
  );

program
  .command('replay')
  .requiredOption('--rules <label>', 'rules version to replay under')
  .option('--from <iso>', 'signals window start (analyzed_at, inclusive)')
  .option('--to <iso>', 'signals window end (inclusive)')
  .option('--notes <text>', 'free-form note stored on the replay run')
  .option(
    '--mode <a|b>',
    "'a' (default) re-executes from live snapshots verbatim — the bit-for-bit regression " +
      "mode, only sound under the SAME rules label. 'b' simulates this run's OWN portfolio " +
      '(world features reused, portfolio features recomputed from simulated fills) and ' +
      'writes a replay_run_metrics row — the counterfactual mode for comparing labels.',
    'a',
  )
  .option('--equity <usd>', 'mode b: starting paper cash', '100000.00')
  .option('--slippage-bps <n>', 'mode b: override the sim fill slippage')
  .description(
    'Replay the stored signal log under a rules version, re-executing decide() from each ' +
      "signal's snapshotted features/quote (never live queries). Mode A: replaying the LIVE " +
      'rules version must reproduce live decisions bit-for-bit. Mode B: counterfactual ' +
      'portfolio simulation with per-run metrics (hit rate, profit factor, drawdown).',
  )
  .action(
    async (options: {
      rules: string;
      from?: string;
      to?: string;
      notes?: string;
      mode: string;
      equity: string;
      slippageBps?: string;
    }) => {
      const mode = options.mode.trim().toLowerCase();
      if (mode !== 'a' && mode !== 'b') {
        throw new Error(`replay: --mode must be "a" or "b", got "${options.mode}"`);
      }
      const slippageBps =
        options.slippageBps === undefined
          ? undefined
          : parsePositiveInt(options.slippageBps, '--slippage-bps');
      await withDb(async (db) => {
        const run = await createReplayRun(db, {
          rulesLabel: options.rules,
          from: options.from === undefined ? null : parseIsoDate(options.from, '--from'),
          to: options.to === undefined ? null : parseIsoDate(options.to, '--to'),
          notes: options.notes ?? null,
          params: {
            mode,
            ...(mode === 'b'
              ? {
                  startingCashUsd: options.equity,
                  ...(slippageBps !== undefined ? { slippageBps } : {}),
                }
              : {}),
          },
        });
        const totals = await runReplay(
          db,
          { decide },
          {
            replayRunId: run.id,
            ...(mode === 'b'
              ? {
                  simulatePortfolio: {
                    startingCashUsd: options.equity,
                    ...(slippageBps !== undefined ? { slippageBps } : {}),
                  },
                }
              : {}),
          },
        );
        console.log(`replay run: ${run.id} (mode ${mode.toUpperCase()})`);
        const { simulated, ...counts } = totals;
        console.table([counts]);
        if (simulated !== null) {
          console.log('-- simulated portfolio (replay_run_metrics row written) --');
          console.table([
            {
              trades: simulated.metrics.trades,
              'win/loss': `${simulated.metrics.wins}/${simulated.metrics.losses}`,
              'hit rate': simulated.metrics.hitRate?.toFixed(3) ?? '—',
              'avg bps/trade': simulated.metrics.avgBpsPerTrade?.toFixed(1) ?? '—',
              'profit factor': simulated.metrics.profitFactor?.toFixed(2) ?? '∞/—',
              'max DD %': simulated.metrics.maxDrawdownPct?.toFixed(2) ?? '—',
              'exp-adj ret %': simulated.metrics.exposureAdjustedReturnPct?.toFixed(2) ?? '—',
              'realized $': simulated.metrics.realizedUsd,
              'fees $': simulated.feesUsd,
              'ending equity $': simulated.endingEquityUsd,
              'still open': simulated.stillOpen,
            },
          ]);
        }
        if (totals.modeBUnsoundPortfolioFeatures) {
          console.log(
            "WARNING: this run's rules label differs from the label that produced the live " +
              'decisions it reused, and the portfolio was NOT simulated: portfolio features ' +
              '(openPositionsCount / paperEquityUsd) were copied from the LIVE run. Re-run ' +
              'with --mode b for a sound cross-label comparison.',
          );
        }
        console.log(`compare with: pnpm cli replay:compare --a live --b ${run.id}`);
      });
    },
  );

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
  .command('eval:signals')
  .option(
    '--versions <list>',
    `comma-separated prompt versions (default: current, ${CURRENT_PROMPT_VERSION}); with 2+ ` +
      'versions, rows are restricted to the intersection of answered pairs and a paired ' +
      'direction-flip/confidence-delta comparison is printed',
  )
  .option(
    '--transports <list>',
    "comma-separated transports (default 'api'; 'cli' rows ignored their prompt contract)",
  )
  .option('--measurer <version>', 'reaction_measurements measurer_version', MEASURER_VERSION)
  .option(
    '--include-retrospective',
    'include backfilled (retrospective=true) signals — only sound for prompt versions that ' +
      'reconstruct their inputs at the observation lag (v2+)',
  )
  .option('--from <iso>', 'cluster anchor window start')
  .option('--to <iso>', 'cluster anchor window end')
  .option(
    '--split <iso>',
    'tune/holdout split over cluster first_received_at: default reports the TUNE side (< split)',
  )
  .option('--holdout', 'with --split: report the holdout side (>= split) instead')
  .option('--session <bucket>', `filter every table to one session: ${SESSION_BUCKETS.join('|')}`)
  .option('--event-types <list>', 'comma-separated event types to include')
  .option(
    '--sources <list>',
    'comma-separated news_sources.source_key values; keeps signals whose cluster contains at ' +
      "least one item from them (shorthand 'nyt' expands to every NYT feed plus the archive)",
  )
  .option(
    '--sources-exclusive',
    'with --sources: require the cluster to contain NOTHING but those sources — the honest cut ' +
      'for "what is this source worth alone", since a shared cluster otherwise credits a source ' +
      'for a story a wire also carried',
  )
  .option(
    '--cost-bps <n>',
    'assumed round-trip cost for the whitelist-bridge verdict (spread + slippage + fees)',
    '20',
  )
  .option('--horizons <list>', 'whitelist-bridge horizons (comma-separated)', '30m,1h,1d,3d,5d')
  .description(
    'M5 calibration & quality report: confidence deciles vs directional hit rate (Wilson CIs, ' +
      'ECE), materiality/expected-move rank correlations, per-event-type hit rates, neutral ' +
      'scoring, reaction speed + capture ratios, NY-session cuts, the event-study → whitelist ' +
      'bridge, the already_expected × calendar_match cross-table, and the next-open reaction ' +
      'for off-hours anchors. Joins llm_signals × reaction_measurements (default measurer ' +
      `'${MEASURER_VERSION}'); needs \`interpret\` and \`measure\` to have run.`,
  )
  .action(
    async (options: {
      versions?: string;
      transports?: string;
      measurer: string;
      includeRetrospective?: boolean;
      from?: string;
      to?: string;
      split?: string;
      holdout?: boolean;
      session?: string;
      eventTypes?: string;
      sources?: string;
      sourcesExclusive?: boolean;
      costBps: string;
      horizons: string;
    }) => {
      if (options.holdout === true && options.split === undefined) {
        throw new Error('eval:signals: --holdout only means something with --split');
      }
      const session = parseSession(options.session);
      const horizons = (splitList(options.horizons) ?? []).map(parseEvalHorizon);
      const eventTypes = splitList(options.eventTypes);
      const sources = expandSourceKeys(splitList(options.sources));
      if (options.sourcesExclusive === true && sources === undefined) {
        throw new Error('eval:signals: --sources-exclusive only means something with --sources');
      }
      await withDb(async (db) => {
        await printEvalSignals(db, {
          versions: splitList(options.versions) ?? [CURRENT_PROMPT_VERSION],
          transports: splitList(options.transports) ?? ['api'],
          measurer: options.measurer,
          includeRetrospective: options.includeRetrospective === true,
          holdout: options.holdout === true,
          costBps: parsePositiveInt(options.costBps, '--cost-bps'),
          bridgeHorizons: horizons,
          ...(options.from !== undefined ? { from: parseIsoDate(options.from, '--from') } : {}),
          ...(options.to !== undefined ? { to: parseIsoDate(options.to, '--to') } : {}),
          ...(options.split !== undefined ? { split: parseIsoDate(options.split, '--split') } : {}),
          ...(session !== undefined ? { session } : {}),
          ...(eventTypes !== undefined ? { eventTypes } : {}),
          ...(sources !== undefined ? { sources } : {}),
          ...(options.sourcesExclusive === true ? { sourcesExclusive: true } : {}),
        });
      });
    },
  );

program
  .command('eval:latency')
  .option('--measurer <version>', 'received-clock measurer version', MEASURER_VERSION)
  .option(
    '--source-horizon <h>',
    'horizon for the per-source cut',
    DEFAULT_LATENCY_OPTIONS.sourceHorizon,
  )
  .option('--from <iso>', 'anchor window start')
  .option('--to <iso>', 'anchor window end')
  .description(
    'Ingestion-latency pricing (roadmap §4.7): per-pair delta between the publication-anchored ' +
      `('${MEASURER_VERSION}-pub') and received-anchored ('${MEASURER_VERSION}') abnormal-return ` +
      'curves, per horizon and per first source — the measured bps cost of our ingest latency, ' +
      'and the evidence for/against the Benzinga add-on.',
  )
  .action(
    async (options: { measurer: string; sourceHorizon: string; from?: string; to?: string }) => {
      await withDb(async (db) => {
        await printLatencyPricing(db, {
          measurer: options.measurer,
          pubMeasurer: `${options.measurer}-pub`,
          sourceHorizon: options.sourceHorizon,
          ...(options.from !== undefined ? { from: parseIsoDate(options.from, '--from') } : {}),
          ...(options.to !== undefined ? { to: parseIsoDate(options.to, '--to') } : {}),
        });
      });
    },
  );

program
  .command('report:weekly')
  .option('--to <iso>', 'window end (default: now)')
  .option('--days <n>', 'window length in days', '7')
  .option(
    '--versions <list>',
    `prompt versions for the analytics joins (default ${CURRENT_PROMPT_VERSION})`,
  )
  .option('--measurer <version>', 'reaction measurer version', MEASURER_VERSION)
  .option('--out <file>', 'also write the markdown to this file')
  .description(
    'M5 weekly markdown report: paper P&L, decision funnel with rejected-signal counts by ' +
      'gate, hit rate by event type, the calibration table, and best/worst closed trades ' +
      "with the LLM's reasoning. Prints to stdout; --out also writes a file.",
  )
  .action(
    async (options: {
      to?: string;
      days: string;
      versions?: string;
      measurer: string;
      out?: string;
    }) => {
      const to = options.to === undefined ? new Date() : parseIsoDate(options.to, '--to');
      const from = new Date(to.getTime() - parsePositiveInt(options.days, '--days') * DAY_MS);
      await withDb(async (db) => {
        const data = await collectWeeklyData(db, {
          from,
          to,
          measurer: options.measurer,
          versions: splitList(options.versions) ?? [CURRENT_PROMPT_VERSION],
          transports: ['api'],
        });
        const markdown = renderWeeklyReport(data);
        console.log(markdown);
        if (options.out !== undefined) {
          await writeFile(options.out, markdown, 'utf8');
          console.error(`[report:weekly] written to ${options.out}`);
        }
      });
    },
  );

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

/**
 * A pairs file is one `clusterId:instrumentId` per line; blank lines and
 * `#`-comment lines are skipped. Fails loudly on malformed lines — a silently
 * dropped pair would make an experiment sample smaller than its design says.
 */
function readPairsFile(filePath: string): string[] {
  const lines = readFileSync(filePath, 'utf8').split('\n');
  const pairs: string[] = [];
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    if (!/^[^:\s]+:[^:\s]+$/.test(line)) {
      throw new Error(
        `--pairs-file ${filePath}:${index + 1}: expected "clusterId:instrumentId", got "${line}"`,
      );
    }
    pairs.push(line);
  }
  if (pairs.length === 0) {
    throw new Error(`--pairs-file ${filePath}: no pairs found`);
  }
  return pairs;
}

/** One id per line; blank lines and `#` comments skipped. Loud on empty. */
function readIdsFile(filePath: string): string[] {
  const ids = readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  if (ids.length === 0) throw new Error(`--item-ids-file ${filePath}: no ids found`);
  return ids;
}

function parseIsoDate(value: string, flag: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${flag} must be an ISO date/time, got "${value}"`);
  }
  return parsed;
}

/** Both retrospective bounds or neither; a backfill window is always explicit. */
/**
 * The whole-backlog window: everything from before records began up to the
 * live lookback's lower edge.
 *
 * The upper bound is `now - lookbackHours`, NOT midnight or `now`. It has to
 * tile exactly with the live sweep's window or one of two things goes wrong.
 * Stop earlier and a band of clusters belongs to neither pass. Stop later and
 * the backfill claims clusters the live sweep would have taken, stamping them
 * retrospective=true — and since signal_key does not include that flag, those
 * pairs could then never produce a live decision. Quarantining fresh news is
 * the more expensive mistake, which is why the bound is the live edge.
 *
 * `from` is the epoch rather than a MIN(first_received_at) query: the window is
 * only a lower bound on the candidate join, so the earliest cluster is found
 * without asking, and the command stays deterministic.
 */
function backfillWindow(
  fromRaw: string | undefined,
  toRaw: string | undefined,
  lookbackHours: number,
): { from: Date; to: Date } {
  if (fromRaw !== undefined || toRaw !== undefined) {
    throw new Error(
      'interpret: --backfill sets the window itself — drop --retrospective-from/--retrospective-to',
    );
  }
  return { from: new Date(0), to: new Date(Date.now() - lookbackHours * 3_600_000) };
}

function parseRetrospectiveWindow(
  fromRaw: string | undefined,
  toRaw: string | undefined,
): { from: Date; to: Date } | undefined {
  if (fromRaw === undefined && toRaw === undefined) return undefined;
  if (fromRaw === undefined || toRaw === undefined) {
    throw new Error('interpret: --retrospective-from and --retrospective-to must be set together');
  }
  const from = parseIsoDate(fromRaw, '--retrospective-from');
  const to = parseIsoDate(toRaw, '--retrospective-to');
  if (from.getTime() > to.getTime()) {
    throw new Error('interpret: --retrospective-from must be at or before --retrospective-to');
  }
  return { from, to };
}

/** LLM_DAILY_SPEND_USD_CAP override; undefined defers to the sweep's default ($5). */
/**
 * 'api' unless explicitly asked for 'cli'. Unrecognized values throw rather
 * than defaulting: a typo must not silently pick a transport, in either
 * direction (the same fail-closed reasoning as the kill switch parser).
 */
/** Comma-separated option → trimmed list, or undefined when absent/empty. */
function splitList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries : undefined;
}

/**
 * Expand `--sources` shorthands into real `source_key` values.
 *
 * `nyt` becomes every NYT feed plus the archive, read from the ingest layer's
 * own name table rather than typed out here. A hand-listed set would silently
 * go stale the moment a feed is added, and a report that quietly dropped a feed
 * would still print as though it covered the source.
 */
function expandSourceKeys(raw: string[] | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const expanded = new Set<string>();
  for (const entry of raw) {
    if (entry.toLowerCase() === 'nyt') {
      for (const key of NYT_SOURCE_KEYS) expanded.add(key);
    } else {
      expanded.add(entry);
    }
  }
  return expanded.size > 0 ? [...expanded] : undefined;
}

function parseSession(raw: string | undefined): SessionBucket | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase();
  const match = SESSION_BUCKETS.find((bucket) => bucket === value);
  if (match === undefined) {
    throw new Error(`--session must be one of ${SESSION_BUCKETS.join('|')}, got "${raw}"`);
  }
  return match;
}

function parseEvalHorizon(raw: string): EvalHorizon {
  const match = EVAL_HORIZONS.find((horizon) => horizon === raw);
  if (match === undefined) {
    throw new Error(`--horizons entries must be one of ${EVAL_HORIZONS.join('|')}, got "${raw}"`);
  }
  return match;
}

function parseTransportMode(raw: string | undefined): LlmTransport {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '') return 'api';
  if (value === 'api' || value === 'cli') return value;
  throw new Error(`interpret: --mode must be "api" or "cli", got "${raw ?? ''}"`);
}

function parseSpendCapEnv(): number | undefined {
  const raw = process.env['LLM_DAILY_SPEND_USD_CAP'];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`LLM_DAILY_SPEND_USD_CAP must be a positive number, got "${raw}"`);
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
