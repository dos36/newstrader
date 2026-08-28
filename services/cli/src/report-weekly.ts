import { derivePortfolio } from '@newstrader/db';
import type { Db } from '@newstrader/db';

import { loadSimPortfolioFills, simBrokerFromEnv } from '../../handlers/src/lib/trading.js';
import {
  calibrationReport,
  eventTypeReport,
  fmtCi,
  fmtNum,
  fmtPct,
  loadEvalRows,
  type CalibrationReport,
  type EventTypeReportRow,
} from './eval-signals.js';

/**
 * `report:weekly` — the M5 weekly markdown report (roadmap §4.5): P&L, the
 * decision funnel, hit rate by event type, the calibration table, and the
 * best/worst closed trades with the LLM's own reasoning. Rendering is a pure
 * function of the collected data so it is testable without a database.
 */

export interface WeeklyTradeRow {
  symbol: string;
  side: 'long' | 'short';
  qty: string;
  entryPrice: string;
  exitPrice: string;
  openedAt: Date;
  closedAt: Date;
  /** Net of both legs' fees, USD. */
  netUsd: number;
  eventType: string | null;
  direction: string | null;
  confidence: number | null;
  reasoning: string | null;
}

export interface WeeklyReportData {
  from: Date;
  to: Date;
  portfolio: {
    cashUsd: string;
    equityUsd: string;
    realizedPnlUsd: string;
    feesUsd: string;
    openPositions: number;
  };
  decisions: Array<{ action: string; decisions: number; suppressed: number }>;
  skipReasons: Array<{ skipReason: string; skips: number }>;
  trades: WeeklyTradeRow[];
  eventTypes: EventTypeReportRow[];
  calibration: CalibrationReport;
  evalRowCount: number;
  measurer: string;
  versions: string[];
}

export interface CollectWeeklyOptions {
  from: Date;
  to: Date;
  measurer: string;
  versions: string[];
  transports: string[];
}

interface DecisionActionRow {
  action: string;
  decisions: number;
  suppressed: number;
}
interface SkipReasonRow {
  skip_reason: string;
  skips: number;
}
interface TradeQueryRow {
  instrument_id: string;
  symbol: string;
  open_side: 'buy' | 'sell';
  fill_qty: string;
  entry_price: string;
  exit_price: string;
  opened_at: Date;
  closed_at: Date;
  net_usd: number;
  event_type: string | null;
  direction: string | null;
  confidence: number | null;
  reasoning: string | null;
}

export async function collectWeeklyData(
  db: Db,
  options: CollectWeeklyOptions,
): Promise<WeeklyReportData> {
  const [actions, skipReasons, trades] = await Promise.all([
    db.$client.query<DecisionActionRow>(
      `select action,
              count(*)::int as decisions,
              count(*) filter (where suppressed)::int as suppressed
         from decisions
        where replay_run_id is null
          and decided_at between $1 and $2
        group by action
        order by action`,
      [options.from, options.to],
    ),
    db.$client.query<SkipReasonRow>(
      `select coalesce(skip_reason, '(none)') as skip_reason, count(*)::int as skips
         from decisions
        where replay_run_id is null
          and action = 'skip'
          and decided_at between $1 and $2
        group by 1
        order by 2 desc`,
      [options.from, options.to],
    ),
    // Closed round trips in the window: each close fill paired with the LATEST
    // open fill for the same instrument at-or-before it — sound because the
    // engine enforces one position per instrument and v1 orders fill exactly
    // once. Net = signed qty × (exit − entry) − both legs' fees.
    db.$client.query<TradeQueryRow>(
      `with f as (
         select fl.fill_qty, fl.fill_price, fl.fee, fl.filled_at,
                o.side, o.instrument_id, d.action, d.signal_id
           from fills fl
           join orders o on o.id = fl.order_id
           join decisions d on d.id = o.decision_id
          where d.replay_run_id is null
       )
       select c.instrument_id,
              i.symbol,
              op.side as open_side,
              op.fill_qty,
              op.fill_price as entry_price,
              c.fill_price as exit_price,
              op.filled_at as opened_at,
              c.filled_at as closed_at,
              ((case when op.side = 'buy' then 1 else -1 end)
                 * op.fill_qty::float8
                 * (c.fill_price::float8 - op.fill_price::float8)
                 - c.fee::float8 - op.fee::float8) as net_usd,
              s.event_type, s.direction, s.confidence, s.reasoning
         from f c
         cross join lateral (
           select * from f op
            where op.instrument_id = c.instrument_id
              and op.action in ('open_long', 'open_short')
              and op.filled_at <= c.filled_at
            order by op.filled_at desc
            limit 1
         ) op
         left join llm_signals s on s.id = op.signal_id
         join instruments i on i.id = c.instrument_id
        where c.action = 'close'
          and c.filled_at between $1 and $2
        order by net_usd desc`,
      [options.from, options.to],
    ),
  ]);

  const broker = simBrokerFromEnv(db);
  const account = await broker.getAccountState();
  const positions = await broker.getPositions();
  const portfolio = derivePortfolio(await loadSimPortfolioFills(db));

  const evalRows = await loadEvalRows(db, {
    versions: options.versions,
    transports: options.transports,
    measurer: options.measurer,
    includeRetrospective: false,
    from: options.from,
    to: options.to,
    holdout: false,
  });

  return {
    from: options.from,
    to: options.to,
    portfolio: {
      cashUsd: account.cashUsd,
      equityUsd: account.equityUsd,
      realizedPnlUsd: portfolio.realizedPnlUsd,
      feesUsd: portfolio.feesUsd,
      openPositions: positions.length,
    },
    decisions: actions.rows,
    skipReasons: skipReasons.rows.map((row) => ({
      skipReason: row.skip_reason,
      skips: row.skips,
    })),
    trades: trades.rows.map((row) => ({
      symbol: row.symbol,
      side: row.open_side === 'buy' ? 'long' : 'short',
      qty: row.fill_qty,
      entryPrice: row.entry_price,
      exitPrice: row.exit_price,
      openedAt: row.opened_at,
      closedAt: row.closed_at,
      netUsd: row.net_usd,
      eventType: row.event_type,
      direction: row.direction,
      confidence: row.confidence,
      reasoning: row.reasoning,
    })),
    eventTypes: eventTypeReport(evalRows),
    calibration: calibrationReport(evalRows),
    evalRowCount: evalRows.length,
    measurer: options.measurer,
    versions: options.versions,
  };
}

// -------------------------------------------------------------- rendering --

const TOP_TRADES = 3;

/** Pure renderer — everything the markdown says arrives in `data`. */
export function renderWeeklyReport(data: WeeklyReportData): string {
  const day = (date: Date): string => date.toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`# NewsTrader weekly report — ${day(data.from)} → ${day(data.to)}`);
  lines.push('');
  lines.push('Venue: **sim only** (paper). All hit rates use 1d abnormal returns under');
  lines.push(
    `measurer \`${data.measurer}\`, prompt version(s) \`${data.versions.join(', ')}\`, ` +
      `transport api, retrospective rows excluded.`,
  );

  lines.push('', '## P&L (paper account, all time)', '');
  lines.push(
    mdTable(
      ['equity USD', 'cash USD', 'realized P&L', 'fees paid', 'open positions'],
      [
        [
          data.portfolio.equityUsd,
          data.portfolio.cashUsd,
          data.portfolio.realizedPnlUsd,
          data.portfolio.feesUsd,
          String(data.portfolio.openPositions),
        ],
      ],
    ),
  );

  lines.push('', '## Decision funnel (live, this window)', '');
  if (data.decisions.length === 0) {
    lines.push('_No live decisions in the window._');
  } else {
    lines.push(
      mdTable(
        ['action', 'decisions', 'suppressed (kill switch)'],
        data.decisions.map((row) => [row.action, String(row.decisions), String(row.suppressed)]),
      ),
    );
  }

  lines.push('', '### Rejected signals by gate', '');
  if (data.skipReasons.length === 0) {
    lines.push('_No skips in the window._');
  } else {
    lines.push(
      mdTable(
        ['gate (first failure)', 'skips'],
        data.skipReasons.map((row) => [row.skipReason, String(row.skips)]),
      ),
    );
  }

  lines.push('', `## Hit rate by event type (n=${String(data.evalRowCount)} joined pairs)`, '');
  if (data.eventTypes.length === 0) {
    lines.push('_No signal × reaction joins in the window (interpret + measure must both run)._');
  } else {
    lines.push(
      mdTable(
        ['event type', 'n', 'non-neutral', 'hit %', '95% CI', 'median |abn 1d| bps', 'big-move %'],
        data.eventTypes.map((row) => [
          row.eventType,
          String(row.n),
          fmtPct(row.nonNeutralShare),
          fmtPct(row.hit.rate),
          fmtCi(row.hit.ci),
          fmtNum(row.medianAbsAbn1d, 1),
          fmtPct(row.bigMoveShare),
        ]),
      ),
    );
  }

  lines.push('', '## Calibration (confidence decile vs 1d directional hit rate)', '');
  const buckets = data.calibration.buckets.filter((bucket) => bucket.n > 0);
  if (buckets.length === 0) {
    lines.push('_No non-neutral joined signals in the window._');
  } else {
    lines.push(
      mdTable(
        ['confidence', 'n', 'hit %', '95% CI'],
        buckets.map((bucket) => [
          `${bucket.lo.toFixed(1)}–${bucket.hi.toFixed(1)}`,
          String(bucket.n),
          fmtPct(bucket.hitRate),
          fmtCi(bucket.ci),
        ]),
      ),
    );
    lines.push('', `ECE: **${fmtNum(data.calibration.ece, 3)}**`);
  }

  lines.push('', '## Best and worst closed trades', '');
  if (data.trades.length === 0) {
    lines.push('_No closed trades in the window._');
  } else {
    const best = data.trades.slice(0, TOP_TRADES);
    const worst = data.trades.slice(-TOP_TRADES).reverse();
    lines.push('### Best');
    for (const trade of best) lines.push(...tradeLines(trade));
    lines.push('', '### Worst');
    for (const trade of worst) lines.push(...tradeLines(trade));
  }

  lines.push('');
  return lines.join('\n');
}

function tradeLines(trade: WeeklyTradeRow): string[] {
  const sign = trade.netUsd >= 0 ? '+' : '−';
  const head =
    `- **${trade.symbol} ${trade.side} ${sign}$${Math.abs(trade.netUsd).toFixed(2)}** — ` +
    `${trade.qty} @ ${trade.entryPrice} → ${trade.exitPrice}, ` +
    `${trade.openedAt.toISOString()} → ${trade.closedAt.toISOString()}` +
    (trade.eventType !== null
      ? ` · signal: ${trade.direction ?? '?'} ${trade.eventType}` +
        (trade.confidence !== null ? ` (conf ${trade.confidence.toFixed(2)})` : '')
      : ' · exit decision (no originating signal)');
  const lines = [head];
  if (trade.reasoning !== null && trade.reasoning.trim() !== '') {
    lines.push(`  - _${trade.reasoning.trim()}_`);
  }
  return lines;
}

function mdTable(headers: string[], rows: string[][]): string {
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}
