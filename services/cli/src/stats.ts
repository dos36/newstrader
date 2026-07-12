import { MIN_LINK_CONFIDENCE } from '@newstrader/db';
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
type ReactionOverviewRow = {
  measured_pairs: number;
  median_abs_1d_abnormal_bps: number | null;
};
type AlphaDecayRow = {
  source_kind: string;
  summaries: number;
  median_half_move_min: number | null;
};
type UnmeasuredRow = { pairs_unmeasured: number };
type CalendarRow = { kind: string; events: number; next_at: string };

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

  // M3 sections. Separate Promise.all: these tables may be empty pre-M3 runs,
  // and grouping keeps the query list readable.
  const [reactionOverview, alphaDecay, unmeasured, calendar] = await Promise.all([
    db.$client.query<ReactionOverviewRow>(
      `select count(distinct (cluster_id, instrument_id))::int as measured_pairs,
              percentile_cont(0.5) within group (order by abs(abnormal_return_bps))
                filter (where horizon = '1d') as median_abs_1d_abnormal_bps
         from reaction_measurements
        where anchor_ts >= now() - interval '7 days'`,
    ),
    // The alpha-decay readout (architecture §6 Q3): median minutes until half
    // of the 1d move was realized, sliced by the kind of the source that broke
    // the story. This is the minutes-migration trigger series (§4.7).
    db.$client.query<AlphaDecayRow>(
      `select s.kind as source_kind,
              count(*)::int as summaries,
              percentile_cont(0.5) within group (order by rs.time_to_half_of_1d_move_minutes)
                as median_half_move_min
         from reaction_summary rs
         join news_clusters c on c.id = rs.cluster_id
         join news_sources s on s.id = c.first_source_id
        where rs.anchor_ts >= now() - interval '7 days'
        group by s.kind
        order by s.kind`,
    ),
    // Qualifying (cluster, instrument) pairs with no measurement row yet —
    // missing bars or horizons not yet settled (mirrors measureReactions'
    // skippedNoBars, but queryable after the fact).
    db.$client.query<UnmeasuredRow>(
      `select count(*)::int as pairs_unmeasured from (
         select distinct nci.cluster_id, l.instrument_id
           from news_clusters c
           join news_cluster_items nci on nci.cluster_id = c.id
           join item_instrument_links l on l.item_id = nci.item_id
          where c.first_received_at >= now() - interval '7 days'
            and l.confidence >= $1
            and not exists (
              select 1 from reaction_measurements m
               where m.cluster_id = nci.cluster_id and m.instrument_id = l.instrument_id)
       ) q`,
      [MIN_LINK_CONFIDENCE],
    ),
    db.$client.query<CalendarRow>(
      `select kind,
              count(*)::int as events,
              to_char(min(scheduled_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as next_at
         from scheduled_events
        where scheduled_at between now() and now() + interval '7 days'
        group by kind
        order by kind`,
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

  console.log('\n== Reaction (last 7d) ==');
  const overview = reactionOverview.rows[0];
  const unmeasuredCount = unmeasured.rows[0]?.pairs_unmeasured ?? 0;
  if (overview === undefined || overview.measured_pairs === 0) {
    console.log(
      `(no measurements yet — run \`bars:backfill\` then \`measure\`; ` +
        `${unmeasuredCount} linked pair(s) awaiting bars)`,
    );
  } else {
    console.log(formatReactionOverview(overview, unmeasuredCount));
    if (alphaDecay.rows.length > 0) {
      console.log('-- alpha decay: median minutes to half of the 1d move, by first source kind --');
      console.table(alphaDecayTable(alphaDecay.rows));
    }
  }

  console.log('== Calendar (next 7d) ==');
  if (calendar.rows.length === 0) {
    console.log('(no upcoming scheduled events — run `calendar:sync`)');
  } else {
    console.table(calendar.rows);
  }
}

/** One line: measured pairs, the 1d abnormal-move median, and the not-yet-measured backlog. */
export function formatReactionOverview(
  overview: { measured_pairs: number; median_abs_1d_abnormal_bps: number | null },
  pairsUnmeasured: number,
): string {
  const median =
    overview.median_abs_1d_abnormal_bps === null
      ? 'n/a (no 1d horizons settled)'
      : `${overview.median_abs_1d_abnormal_bps.toFixed(1)} bps`;
  return (
    `measured pairs=${overview.measured_pairs} median |1d abnormal|=${median} ` +
    `unmeasured linked pairs (missing/unsettled bars)=${pairsUnmeasured}`
  );
}

/** Round the medians for display; null = no summary had a half-move time. */
export function alphaDecayTable(rows: readonly AlphaDecayRow[]): Record<string, string | number>[] {
  return rows.map((row) => ({
    'source kind': row.source_kind,
    summaries: row.summaries,
    'median min to half-move':
      row.median_half_move_min === null ? '—' : row.median_half_move_min.toFixed(1),
  }));
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
