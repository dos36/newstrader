import { newId } from '@newstrader/core';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Db } from '../client.js';
import { indexMembership, instrumentAliases, instruments } from '../schema.js';
import { aliasKey, CRYPTO_SEEDS, equityAliases, type AliasSpec } from './aliases.js';
import { lookupSecTicker, type SecTickerMap } from './sec-tickers.js';
import type { Sp500Row } from './wikipedia.js';

/**
 * Universe sync — architecture §3 / §5.2.
 *
 * One run: (a) upsert equity instruments from the fetched S&P 500 list (never
 * deletes — delisted rows are the survivorship guard); (b) maintain 'SPX'
 * index_membership point-in-time (new member → valid_from=now, member absent
 * from the fetched list → close its open row with valid_to=now); (c) seed the
 * BTC/ETH/SOL crypto instruments; (d) rebuild instrument_aliases point-in-time
 * by diffing the desired alias set against the open rows — unchanged aliases
 * keep their original valid_from, so re-running on the same list is a no-op.
 *
 * CIK authority: SEC's company_tickers.json wins over Wikipedia when both know
 * the ticker (lookup tolerates SEC's dash form for Wikipedia's dot form).
 *
 * Alias scope: only instruments in THIS run (fetched equities + crypto seeds)
 * are diffed. An instrument that dropped out of the index keeps its open
 * aliases — leaving the S&P 500 does not change what a company is called; its
 * dictionary entries close only when a later list re-assigns them.
 *
 * The whole run is ONE transaction under an advisory lock: concurrent syncs
 * (cron overlap, manual + cron) must not double-insert membership or alias
 * rows. All valid_from/valid_to writes in a run share a single `now` snapshot.
 */

export const SPX_INDEX_CODE = 'SPX';

export interface SyncUniverseDeps {
  /** e.g. () => fetchSp500FromWikipedia(...) — injected for network-free tests. */
  fetchSp500: () => Promise<Sp500Row[]>;
  /** e.g. () => fetchSecTickerMap(...) — SEC wins CIK conflicts. */
  fetchSecTickers: () => Promise<SecTickerMap>;
  /** Injectable clock (tests). Every valid_from/valid_to in the run comes from here. */
  now?: () => Date;
}

export interface SyncUniverseCounts {
  /** Equity rows in the fetched list (all upserted). */
  equities: number;
  cryptoSeeded: number;
  membersAdded: number;
  membersClosed: number;
  aliasesInserted: number;
  aliasesClosed: number;
}

export async function syncUniverse(db: Db, deps: SyncUniverseDeps): Promise<SyncUniverseCounts> {
  const [sp500, secTickers] = await Promise.all([deps.fetchSp500(), deps.fetchSecTickers()]);
  const now = (deps.now ?? (() => new Date()))();

  const counts = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('newstrader_universe_sync'))`);

    // (a) + (c): upsert instruments; collect id + desired aliases per instrument.
    const desiredBy = new Map<string, AliasSpec[]>();

    // Identity guard: an existing symbol arriving with a DIFFERENT CIK is
    // ticker reuse (a delisted company's symbol re-assigned to a new one).
    // Silently upserting would rewrite the old instrument's identity in place,
    // reattributing all its historical links and memberships to the new
    // company. Refuse instead: the transaction rolls back and an operator
    // decides (data correction → update instruments.cik manually and re-run;
    // true reuse → needs the symbol-liveness schema change tracked for M1+).
    const existingEquities = await tx
      .select({ symbol: instruments.symbol, cik: instruments.cik })
      .from(instruments)
      .where(eq(instruments.assetClass, 'us_equity'));
    const existingCikBySymbol = new Map(existingEquities.map((row) => [row.symbol, row.cik]));

    const equityIds: string[] = [];
    for (const row of sp500) {
      // SEC wins over Wikipedia on CIK conflicts.
      const cik = lookupSecTicker(secTickers, row.symbol)?.cik ?? row.cik;
      const existingCik = existingCikBySymbol.get(row.symbol);
      if (existingCik !== undefined && existingCik !== null && existingCik !== cik) {
        throw new Error(
          `universe:sync refused: CIK change for symbol ${row.symbol} ` +
            `(stored ${existingCik} → fetched ${cik}). If this is ticker reuse, the old ` +
            `instrument must be delisted first; if it is a data correction, update ` +
            `instruments.cik manually and re-run.`,
        );
      }
      const upserted = await tx
        .insert(instruments)
        .values({
          id: newId(),
          symbol: row.symbol,
          assetClass: 'us_equity',
          cik,
          name: row.security,
          sectorApprox: row.sector,
        })
        .onConflictDoUpdate({
          target: [instruments.symbol, instruments.assetClass],
          set: { cik, name: row.security, sectorApprox: row.sector },
        })
        .returning({ id: instruments.id });
      const instrumentId = requireRow(upserted, `instruments upsert for ${row.symbol}`).id;
      equityIds.push(instrumentId);
      desiredBy.set(instrumentId, equityAliases({ symbol: row.symbol, name: row.security, cik }));
    }

    for (const seed of CRYPTO_SEEDS) {
      const upserted = await tx
        .insert(instruments)
        .values({
          id: newId(),
          symbol: seed.symbol,
          assetClass: 'crypto',
          exchange: seed.exchange,
          name: seed.name,
        })
        .onConflictDoUpdate({
          target: [instruments.symbol, instruments.assetClass],
          set: { name: seed.name },
        })
        .returning({ id: instruments.id });
      const instrumentId = requireRow(upserted, `instruments upsert for ${seed.symbol}`).id;
      desiredBy.set(instrumentId, seed.aliases);
    }

    // (b): point-in-time SPX membership diff against the open rows.
    const openMembers = await tx
      .select({ instrumentId: indexMembership.instrumentId })
      .from(indexMembership)
      .where(and(eq(indexMembership.indexCode, SPX_INDEX_CODE), isNull(indexMembership.validTo)));
    const openIds = new Set(openMembers.map((m) => m.instrumentId));
    const fetchedIds = new Set(equityIds);

    const toAdd = equityIds.filter((id) => !openIds.has(id));
    const toClose = [...openIds].filter((id) => !fetchedIds.has(id));

    if (toAdd.length > 0) {
      await tx.insert(indexMembership).values(
        toAdd.map((instrumentId) => ({
          instrumentId,
          indexCode: SPX_INDEX_CODE,
          validFrom: now,
        })),
      );
    }
    if (toClose.length > 0) {
      await tx
        .update(indexMembership)
        .set({ validTo: now })
        .where(
          and(
            inArray(indexMembership.instrumentId, toClose),
            eq(indexMembership.indexCode, SPX_INDEX_CODE),
            isNull(indexMembership.validTo),
          ),
        );
    }

    // (d): alias diff — close open rows no longer desired, insert new ones,
    // leave unchanged rows untouched (their valid_from is history).
    const instrumentIds = [...desiredBy.keys()];
    const openAliases = await tx
      .select({
        instrumentId: instrumentAliases.instrumentId,
        alias: instrumentAliases.alias,
        aliasKind: instrumentAliases.aliasKind,
      })
      .from(instrumentAliases)
      .where(
        and(
          inArray(instrumentAliases.instrumentId, instrumentIds),
          isNull(instrumentAliases.validTo),
        ),
      );

    const openByInstrument = new Map<string, Map<string, AliasSpec>>();
    for (const row of openAliases) {
      const forInstrument = openByInstrument.get(row.instrumentId) ?? new Map<string, AliasSpec>();
      forInstrument.set(aliasKey(row), { alias: row.alias, aliasKind: row.aliasKind });
      openByInstrument.set(row.instrumentId, forInstrument);
    }

    const inserts: (typeof instrumentAliases.$inferInsert)[] = [];
    let aliasesClosed = 0;
    for (const [instrumentId, desired] of desiredBy) {
      const open = openByInstrument.get(instrumentId) ?? new Map<string, AliasSpec>();
      const desiredKeys = new Set(desired.map(aliasKey));

      for (const spec of desired) {
        if (!open.has(aliasKey(spec))) {
          inserts.push({ instrumentId, ...spec, validFrom: now });
        }
      }
      for (const [key, spec] of open) {
        if (desiredKeys.has(key)) continue;
        await tx
          .update(instrumentAliases)
          .set({ validTo: now })
          .where(
            and(
              eq(instrumentAliases.instrumentId, instrumentId),
              eq(instrumentAliases.alias, spec.alias),
              eq(instrumentAliases.aliasKind, spec.aliasKind),
              isNull(instrumentAliases.validTo),
            ),
          );
        aliasesClosed += 1;
      }
    }
    for (const chunk of chunks(inserts, 500)) {
      await tx.insert(instrumentAliases).values(chunk);
    }

    return {
      equities: sp500.length,
      cryptoSeeded: CRYPTO_SEEDS.length,
      membersAdded: toAdd.length,
      membersClosed: toClose.length,
      aliasesInserted: inserts.length,
      aliasesClosed,
    };
  });

  console.log(JSON.stringify({ level: 'info', msg: 'universe_sync', ...counts }));
  return counts;
}

// ---------------------------------------------------------------- internals --

function requireRow<T>(rows: T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`${what} returned no row`);
  return row;
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}
