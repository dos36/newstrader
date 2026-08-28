import { MEASURER_VERSION, PUB_MEASURER_VERSION } from '@newstrader/db';
import type { Db } from '@newstrader/db';

import { fmtNum } from './eval-signals.js';

/**
 * `eval:latency` — ingestion-latency pricing (roadmap §4.7). The measurer
 * writes every pair under TWO clocks: received (our clock — what we could have
 * traded) and published (the market's clock — what happened once the news
 * existed). For pairs measured under both, the per-horizon difference between
 * the two abnormal-return curves IS the cost of our ingestion latency in bps:
 * a positive |pub| − |recv| at short horizons means part of the move was over
 * before we received the story. This number is the evidence that decides
 * whether the $99/mo Benzinga add-on pays.
 */

interface HorizonRow {
  horizon: string;
  pairs: number;
  median_latency_s: number | null;
  median_abs_delta_bps: number | null;
  median_signed_delta_bps: number | null;
}

interface SourceRow {
  source_key: string;
  pairs: number;
  median_latency_s: number | null;
  median_abs_delta_bps: number | null;
}

export interface EvalLatencyOptions {
  measurer: string;
  pubMeasurer: string;
  /** Horizon for the per-source cut. */
  sourceHorizon: string;
  from?: Date;
  to?: Date;
}

export const DEFAULT_LATENCY_OPTIONS = {
  measurer: MEASURER_VERSION,
  pubMeasurer: PUB_MEASURER_VERSION,
  /**
   * 30m for the per-source cut: long enough that both clocks usually have a
   * settled price, short enough that latency still dominates the difference.
   */
  sourceHorizon: '30m',
} as const;

export async function printLatencyPricing(db: Db, options: EvalLatencyOptions): Promise<void> {
  const params: unknown[] = [options.measurer, options.pubMeasurer];
  let filters = '';
  if (options.from !== undefined) {
    params.push(options.from);
    filters += ` and recv.anchor_ts >= $${String(params.length)}`;
  }
  if (options.to !== undefined) {
    params.push(options.to);
    filters += ` and recv.anchor_ts <= $${String(params.length)}`;
  }

  const pairSql = `
    select recv.cluster_id, recv.instrument_id, recv.horizon,
           recv.abnormal_return_bps as abn_recv,
           pub.abnormal_return_bps as abn_pub,
           extract(epoch from (recv.anchor_ts - pub.anchor_ts)) as latency_s
      from reaction_measurements recv
      join reaction_measurements pub
        on pub.cluster_id = recv.cluster_id
       and pub.instrument_id = recv.instrument_id
       and pub.horizon = recv.horizon
       and pub.measurer_version = $2
     where recv.measurer_version = $1${filters}`;

  const [byHorizon, bySource] = await Promise.all([
    db.$client.query<HorizonRow>(
      `with pairs as (${pairSql})
       select horizon,
              count(*)::int as pairs,
              round((percentile_cont(0.5) within group (order by latency_s))::numeric, 0)::float8
                as median_latency_s,
              percentile_cont(0.5) within group (order by abs(abn_pub) - abs(abn_recv))
                as median_abs_delta_bps,
              percentile_cont(0.5) within group (order by abn_pub - abn_recv)
                as median_signed_delta_bps
         from pairs
        group by horizon
        order by case horizon
          when '5m' then 1 when '15m' then 2 when '30m' then 3 when '1h' then 4
          when '4h' then 5 when '1d' then 6 when '3d' then 7 else 8 end`,
      params,
    ),
    db.$client.query<SourceRow>(
      `with pairs as (${pairSql})
       select ns.source_key,
              count(*)::int as pairs,
              round((percentile_cont(0.5) within group (order by p.latency_s))::numeric, 0)::float8
                as median_latency_s,
              percentile_cont(0.5) within group (order by abs(p.abn_pub) - abs(p.abn_recv))
                as median_abs_delta_bps
         from pairs p
         join news_clusters c on c.id = p.cluster_id
         join news_sources ns on ns.id = c.first_source_id
        where p.horizon = $${String(params.length + 1)}
        group by ns.source_key
        order by ns.source_key`,
      [...params, options.sourceHorizon],
    ),
  ]);

  console.log(
    `\n== ingestion-latency pricing: ${options.pubMeasurer} vs ${options.measurer} ` +
      `(per-pair curve delta) ==`,
  );
  if (byHorizon.rows.length === 0) {
    console.log(
      '(no pairs measured under both clocks — the publication anchor needs a credible ' +
        'published_at claim; run `measure` over a window with such items)',
    );
    return;
  }
  console.log(
    'reading: |pub|−|recv| > 0 at short horizons = the move started before we received ' +
      'the story — that many bps is what our ingestion latency costs.',
  );
  console.table(
    byHorizon.rows.map((row) => ({
      horizon: row.horizon,
      pairs: row.pairs,
      'median latency s': row.median_latency_s ?? '—',
      'median |pub|−|recv| bps': fmtNum(row.median_abs_delta_bps, 1),
      'median pub−recv bps': fmtNum(row.median_signed_delta_bps, 1),
    })),
  );
  if (bySource.rows.length > 0) {
    console.log(`-- by first source, horizon ${options.sourceHorizon} --`);
    console.table(
      bySource.rows.map((row) => ({
        source: row.source_key,
        pairs: row.pairs,
        'median latency s': row.median_latency_s ?? '—',
        'median |pub|−|recv| bps': fmtNum(row.median_abs_delta_bps, 1),
      })),
    );
  }
}
