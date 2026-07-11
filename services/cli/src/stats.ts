import type { Db } from '@newstrader/db';

/**
 * The M0/M1 KPI report (architecture §10 verification gates): how much comes
 * in per source, how hard clustering collapses echoes, and how much of it
 * entity resolution can attribute to instruments. The items→clusters ratio is
 * the number that decides the LLM stage shape (Sonnet-only vs a triage tier
 * at >~500 novel clusters/day); resolution coverage per source is the M1
 * precision/recall smoke signal.
 *
 * Read-only, plain SQL over the pg pool (see ingest.ts header for why raw SQL
 * instead of drizzle operators). All day bucketing is UTC.
 */

type ItemsPerDayRow = { day: string; source_key: string; n: number };
type TotalsRow = { items: number; clusters: number };
type TopClusterRow = { headline: string; items: number; sources: number; first_seen: string };
type ClustersPerDayRow = { day: string; new_clusters: number };
type CoverageRow = { source_key: string; items: number; linked: number };
type MethodRow = { method: string; links: number };
type TopInstrumentRow = { symbol: string; items: number };

export async function printStats(db: Db): Promise<void> {
  const [itemsPerDay, totals, topClusters, clustersPerDay, coverage, methods, topInstruments] =
    await Promise.all([
      db.$client.query<ItemsPerDayRow>(
        `select to_char(date_trunc('day', r.received_at at time zone 'UTC'), 'YYYY-MM-DD') as day,
                s.source_key,
                count(*)::int as n
           from raw_news_items r
           join news_sources s on s.id = r.source_id
          where r.received_at >= now() - interval '7 days'
          group by 1, 2
          order by 1 desc, 2`,
      ),
      db.$client.query<TotalsRow>(
        `select (select count(*)::int from raw_news_items) as items,
                (select count(*)::int from news_clusters) as clusters`,
      ),
      db.$client.query<TopClusterRow>(
        `select left(canonical_headline, 88) as headline,
                item_count::int as items,
                distinct_source_count::int as sources,
                to_char(first_received_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as first_seen
           from news_clusters
          order by item_count desc, first_received_at desc
          limit 10`,
      ),
      db.$client.query<ClustersPerDayRow>(
        `select to_char(date_trunc('day', first_received_at at time zone 'UTC'), 'YYYY-MM-DD') as day,
                count(*)::int as new_clusters
           from news_clusters
          where first_received_at >= now() - interval '7 days'
          group by 1
          order by 1 desc`,
      ),
      db.$client.query<CoverageRow>(
        `select s.source_key,
                count(*)::int as items,
                count(*) filter (where exists (
                  select 1 from item_instrument_links l where l.item_id = r.id))::int as linked
           from raw_news_items r
           join news_sources s on s.id = r.source_id
          where r.received_at >= now() - interval '7 days'
          group by 1
          order by 1`,
      ),
      db.$client.query<MethodRow>(
        `select l.method, count(*)::int as links
           from item_instrument_links l
           join raw_news_items r on r.id = l.item_id
          where r.received_at >= now() - interval '7 days'
          group by 1
          order by 2 desc`,
      ),
      db.$client.query<TopInstrumentRow>(
        `select i.symbol, count(distinct l.item_id)::int as items
           from item_instrument_links l
           join instruments i on i.id = l.instrument_id
           join raw_news_items r on r.id = l.item_id
          where r.received_at >= now() - interval '7 days'
          group by i.id, i.symbol
          order by 2 desc, 1
          limit 10`,
      ),
    ]);

  console.log('\n== Items per day by source (last 7 days, UTC) ==');
  if (itemsPerDay.rows.length === 0) {
    console.log('(no items in the last 7 days — run `poll` first)');
  } else {
    console.table(pivotItemsPerDay(itemsPerDay.rows));
  }

  const totalsRow = totals.rows[0] ?? { items: 0, clusters: 0 };
  console.log('== Dedup ratio (all time) ==');
  console.log(formatDedupRatio(totalsRow));

  console.log('\n== Top 10 clusters by item count ==');
  if (topClusters.rows.length === 0) {
    console.log('(no clusters yet — run `process` after polling)');
  } else {
    console.table(topClusters.rows);
  }

  console.log('== New clusters per day (last 7 days, UTC) ==');
  if (clustersPerDay.rows.length === 0) {
    console.log('(none)');
  } else {
    console.table(clustersPerDay.rows);
  }

  console.log('== Resolution (last 7d) ==');
  if (coverage.rows.length === 0) {
    console.log('(no items in the last 7 days — run `poll` first)');
  } else {
    console.table(coverageTable(coverage.rows));
  }
  if (methods.rows.length === 0) {
    console.log('(no instrument links yet — run `universe:sync`, then `process` or `resolve`)');
  } else {
    console.log('-- links by method --');
    console.table(methods.rows);
    console.log('-- top 10 instruments by linked items --');
    console.table(topInstruments.rows);
  }
}

/** One console.table row per day, one column per source key. */
export function pivotItemsPerDay(
  rows: readonly ItemsPerDayRow[],
): Record<string, string | number>[] {
  const sourceKeys = [...new Set(rows.map((r) => r.source_key))].sort();
  const byDay = new Map<string, Record<string, string | number>>();
  for (const row of rows) {
    let dayRow = byDay.get(row.day);
    if (dayRow === undefined) {
      dayRow = { day: row.day };
      for (const key of sourceKeys) dayRow[key] = 0;
      byDay.set(row.day, dayRow);
    }
    dayRow[row.source_key] = row.n;
  }
  return [...byDay.values()];
}

export function formatDedupRatio(totals: TotalsRow): string {
  if (totals.items === 0) return 'items=0 clusters=0 (nothing ingested yet)';
  if (totals.clusters === 0)
    return `items=${totals.items} clusters=0 (nothing processed yet — run \`process\`)`;
  const ratio = totals.items / totals.clusters;
  const collapse = (1 - totals.clusters / totals.items) * 100;
  return (
    `items=${totals.items} clusters=${totals.clusters} → ` +
    `${ratio.toFixed(2)} items/cluster (echo-collapse ${collapse.toFixed(1)}%)`
  );
}

/** Per-source coverage rows plus an ALL summary row, with a formatted percent. */
export function coverageTable(rows: readonly CoverageRow[]): Record<string, string | number>[] {
  const toRow = (
    label: string,
    items: number,
    linked: number,
  ): Record<string, string | number> => ({
    source: label,
    items,
    linked,
    'linked %': items === 0 ? '—' : `${((linked / items) * 100).toFixed(1)}%`,
  });
  const out = rows.map((row) => toRow(row.source_key, row.items, row.linked));
  const items = rows.reduce((sum, row) => sum + row.items, 0);
  const linked = rows.reduce((sum, row) => sum + row.linked, 0);
  out.push(toRow('ALL', items, linked));
  return out;
}
