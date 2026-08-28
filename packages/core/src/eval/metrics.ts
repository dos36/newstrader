/**
 * Per-run trade metrics (roadmap §4.2, `replay_run_metrics`) — the defined
 * output of "compare rules v3 vs v7". Pure: takes closed trades, returns
 * scalars; persistence lives in packages/db/src/trading/run-metrics-repo.ts.
 *
 * Float math on purpose: these are analytics destined for `real` columns.
 * Only the realized-P&L SUM is kept as a decimal string (numeric(18,2)),
 * matching how BacktestResult already reports it.
 */

/** The slice of a closed trade the metrics need (BacktestLedger's ClosedTrade fits). */
export interface MetricsTrade {
  /** Realized P&L for the round trip, USD decimal string (net of exit fee). */
  realizedUsd: string;
  /** Signed quantity (negative = short), decimal string. */
  qty: string;
  entryPrice: string;
  openedAt: Date;
  closedAt: Date;
}

export interface RunMetrics {
  trades: number;
  wins: number;
  losses: number;
  /** wins / trades; null with no trades. Zero-P&L trades count as non-wins. */
  hitRate: number | null;
  /** Mean per-trade return on entry notional, in bps. */
  avgBpsPerTrade: number | null;
  /** Gross wins / |gross losses|; null when there are no losing trades (∞). */
  profitFactor: number | null;
  /**
   * Max peak-to-trough drawdown of the REALIZED equity curve (starting cash +
   * cumulative realized P&L at each close), as a PERCENT of the running peak.
   * Closed-trade granularity: intra-trade excursions are invisible here.
   */
  maxDrawdownPct: number | null;
  /**
   * Realized P&L over time-weighted average capital deployed, as a percent:
   * Σ(entry notional × holding time) / run span is the average exposure, and a
   * strategy that earns the same dollars with half the capital at risk scores
   * twice as high. Null when the run span is zero.
   */
  exposureAdjustedReturnPct: number | null;
  /** Σ realizedUsd, 2 decimal places. */
  realizedUsd: string;
}

export interface RunMetricsOptions {
  /** USD decimal string — the drawdown curve's starting equity. */
  startingCashUsd: string;
}

export function computeRunMetrics(
  trades: readonly MetricsTrade[],
  options: RunMetricsOptions,
): RunMetrics {
  const metrics: RunMetrics = {
    trades: trades.length,
    wins: 0,
    losses: 0,
    hitRate: null,
    avgBpsPerTrade: null,
    profitFactor: null,
    maxDrawdownPct: null,
    exposureAdjustedReturnPct: null,
    realizedUsd: '0.00',
  };
  if (trades.length === 0) return metrics;

  let realized = 0;
  let grossWins = 0;
  let grossLosses = 0;
  let bpsSum = 0;
  let bpsCount = 0;
  let exposureIntegralMs = 0; // Σ notional × holding ms
  for (const trade of trades) {
    const pnl = Number(trade.realizedUsd);
    realized += pnl;
    if (pnl > 0) {
      metrics.wins += 1;
      grossWins += pnl;
    } else if (pnl < 0) {
      metrics.losses += 1;
      grossLosses += -pnl;
    }
    const notional = Math.abs(Number(trade.qty)) * Number(trade.entryPrice);
    if (notional > 0) {
      bpsSum += (pnl / notional) * 10_000;
      bpsCount += 1;
    }
    exposureIntegralMs += notional * (trade.closedAt.getTime() - trade.openedAt.getTime());
  }

  metrics.hitRate = metrics.wins / trades.length;
  metrics.avgBpsPerTrade = bpsCount > 0 ? bpsSum / bpsCount : null;
  metrics.profitFactor = grossLosses > 0 ? grossWins / grossLosses : null;
  metrics.realizedUsd = realized.toFixed(2);

  // Drawdown over the realized-equity curve, in closedAt order.
  const byClose = [...trades].sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime());
  let equity = Number(options.startingCashUsd);
  let peak = equity;
  let maxDrawdown = 0;
  for (const trade of byClose) {
    equity += Number(trade.realizedUsd);
    if (equity > peak) peak = equity;
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }
  metrics.maxDrawdownPct = maxDrawdown * 100;

  const spanStartMs = Math.min(...trades.map((trade) => trade.openedAt.getTime()));
  const spanEndMs = Math.max(...trades.map((trade) => trade.closedAt.getTime()));
  const spanMs = spanEndMs - spanStartMs;
  if (spanMs > 0 && exposureIntegralMs > 0) {
    const avgExposureUsd = exposureIntegralMs / spanMs;
    metrics.exposureAdjustedReturnPct = (realized / avgExposureUsd) * 100;
  }
  return metrics;
}
