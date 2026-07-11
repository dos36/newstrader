import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allAdapters, FsRawStore } from '@newstrader/adapters';
import type { RawStore, SourceAdapter } from '@newstrader/core';
import {
  closeStaleClusters,
  createDb,
  fetchSecTickerMap,
  fetchSp500FromWikipedia,
  loadResolverDictionary,
  resolveUnlinkedItems,
  syncUniverse,
} from '@newstrader/db';
import type { Db, ResolveCursor } from '@newstrader/db';
import { Command } from 'commander';
import dotenv from 'dotenv';
import {
  ensureSource,
  loadUnclusteredItems,
  runPoll,
  runProcess,
} from '../../handlers/src/lib/ingest.js';
import { printStats } from './stats.js';

/**
 * NewsTrader milestone-0/1 CLI: run the same ingest core the Lambdas run, but
 * locally — FsRawStore instead of S3, a direct DATABASE_URL instead of the
 * Secrets Manager secret, and `process` finds work by query instead of SQS.
 * M1 adds the universe/dictionary layer: `universe:sync` maintains
 * instruments/membership/aliases, `process` resolves items as it clusters
 * them, and `resolve` backfills items ingested before the dictionary existed.
 * Config comes from .env via dotenv (see .env.example).
 */

// `pnpm cli …` runs with cwd = services/cli, so load .env from the cwd first
// (dotenv never overrides real env) and then from the repo root, where the
// quickstart puts it.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
dotenv.config();
dotenv.config({ path: path.join(REPO_ROOT, '.env') });

const program = new Command();

program
  .name('newstrader')
  .description('NewsTrader M0: ingestion + clustering (zero LLM spend, no trading)');

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
  .description(
    'Cluster every raw item not yet in news_cluster_items (oldest first), then close stale clusters',
  )
  .action(async (options: { batch: string }) => {
    const batchSize = parsePositiveInt(options.batch, '--batch');
    await withDb(async (db) => {
      // One dictionary snapshot for the whole run — items arriving mid-run
      // are resolved against it; the next run (or `resolve`) picks up any
      // universe changes made meanwhile.
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
    });
  });

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
  .command('stats')
  .description('M0 KPIs: items/day by source, dedup ratio, top clusters, clusters/day')
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

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
