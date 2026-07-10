import type { Db } from '@newstrader/db';

/**
 * The M0 KPI report (architecture §10, M0 verification gate): how much comes
 * in per source, and how hard clustering collapses echoes. The items→clusters
 * ratio is the number that decides the LLM stage shape (Sonnet-only vs a
 * triage tier at >~500 novel clusters/day).
 *
 * Read-only, plain SQL over the pg pool (see ingest.ts header for why raw SQL
 * instead of drizzle operators). All day bucketing is UTC.
 */

type ItemsPerDayRow = { day: string; source_key: string; n: number };
type TotalsRow = { items: number; clusters: number };
type TopClusterRow = { headline: string; items: number; sources: number; first_seen: string };
type ClustersPerDayRow = { day: string; new_clusters: number };

export async function printStats(db: Db): Promise<void> {
  const [itemsPerDay, totals, topClusters, clustersPerDay] = await Promise.all([
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
