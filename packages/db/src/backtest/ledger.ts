import {
  add,
  formatDec,
  mul,
  parseDec,
  roundTo,
  simulateFill,
  sub,
  type BrokerAccountState,
  type BrokerPosition,
  type OrderIntent,
} from '@newstrader/core';

/**
 * The backtest's portfolio, held in memory for the length of one run.
 *
 * Why not SimBrokerAdapter: that adapter writes `orders`, `order_events` and
 * `fills` — the rows live P&L is derived from. A backtest that wrote there
 * would mix simulated history into the account the operator reads, and the
 * schema has no run column on those tables to separate them. So the ledger is
 * ephemeral: the run persists its DECISIONS (tagged with a replay run id) and
 * reports its P&L, and no fact table is touched.
 *
 * The fill model is the production one (`simulateFill`, core/broker) — same
 * slippage and fee treatment, same fixed-point rounding — so a backtest and a
 * paper trade of the same intent at the same reference price agree to the cent.
 */

export interface LedgerPosition {
  instrumentId: string;
  /** Signed: negative = short. */
  qty: string;
  avgEntryPrice: string;
  openedAt: Date;
  /** ATR frozen at entry, so exits use the value sizing used. */
  atrAtEntry: string | null;
  horizon: 'intraday' | '1d' | '3d' | '5d';
  /** The decision that opened it, for attribution in the trade log. */
  signalId: string;
}

export interface ClosedTrade {
  instrumentId: string;
  signalId: string;
  side: 'long' | 'short';
  qty: string;
  entryPrice: string;
  exitPrice: string;
  openedAt: Date;
  closedAt: Date;
  /** Realized P&L net of both legs' fees (USD, decimal string). */
  realizedUsd: string;
  feesUsd: string;
  exitReason: string;
}

export interface LedgerOptions {
  startingCashUsd: string;
  slippageBps?: number;
  feeBpsByAssetClass?: Partial<Record<OrderIntent['assetClass'], number>>;
}

export class BacktestLedger {
  private cash: string;
  private readonly open = new Map<string, LedgerPosition>();
  private readonly closed: ClosedTrade[] = [];
  private feesPaid = '0';

  constructor(private readonly options: LedgerOptions) {
    this.cash = options.startingCashUsd;
  }

  /** BrokerAdapter-shaped read, so the shared feature assembler works unchanged. */
  positions(): BrokerPosition[] {
    return [...this.open.values()].map((position) => ({
      instrumentId: position.instrumentId,
      qty: position.qty,
      avgEntryPrice: position.avgEntryPrice,
    }));
  }

  openPosition(instrumentId: string): LedgerPosition | undefined {
    return this.open.get(instrumentId);
  }

  openPositions(): LedgerPosition[] {
    return [...this.open.values()];
  }

  /**
   * Equity = cash + mark-to-market of open positions. Marks come from the
   * caller so the ledger never queries prices itself; a missing mark falls back
   * to the entry price, which under-states a winner rather than inventing one.
   */
  accountState(marks: Map<string, string>): BrokerAccountState {
    let equity = parseDec(this.cash);
    for (const position of this.open.values()) {
      const mark = marks.get(position.instrumentId) ?? position.avgEntryPrice;
      equity = add(equity, mul(parseDec(position.qty), parseDec(mark)));
    }
    return { cashUsd: this.cash, equityUsd: formatDec(roundTo(equity, 2)) };
  }

  /**
   * Fill an opening intent at `referencePrice`. Cash moves by the signed
   * notional plus the fee, exactly as a real fill would.
   */
  fillOpen(input: {
    intent: OrderIntent;
    referencePrice: string;
    at: Date;
    signalId: string;
    horizon: LedgerPosition['horizon'];
    atrAtEntry: string | null;
  }): { fillPrice: string; qty: string; fee: string } {
    const fill = simulateFill({
      intent: input.intent,
      referencePrice: input.referencePrice,
      now: input.at,
      ...(this.options.slippageBps !== undefined ? { slippageBps: this.options.slippageBps } : {}),
      ...(this.options.feeBpsByAssetClass?.[input.intent.assetClass] !== undefined
        ? { feeBps: this.options.feeBpsByAssetClass[input.intent.assetClass] }
        : {}),
    });
    const signedQty = input.intent.side === 'buy' ? fill.fillQty : `-${fill.fillQty}`;
    const notional = mul(parseDec(signedQty), parseDec(fill.fillPrice));
    // Buying spends cash; shorting credits it. Fees always debit.
    this.cash = formatDec(roundTo(sub(sub(parseDec(this.cash), notional), parseDec(fill.fee)), 2));
    this.feesPaid = formatDec(add(parseDec(this.feesPaid), parseDec(fill.fee)));

    this.open.set(input.intent.instrumentId, {
      instrumentId: input.intent.instrumentId,
      qty: signedQty,
      avgEntryPrice: fill.fillPrice,
      openedAt: input.at,
      atrAtEntry: input.atrAtEntry,
      horizon: input.horizon,
      signalId: input.signalId,
    });
    return { fillPrice: fill.fillPrice, qty: signedQty, fee: fill.fee };
  }

  /** Flatten a position at `referencePrice`, recording the realized trade. */
  fillClose(input: {
    instrumentId: string;
    assetClass: OrderIntent['assetClass'];
    referencePrice: string;
    at: Date;
    reason: string;
  }): ClosedTrade | null {
    const position = this.open.get(input.instrumentId);
    if (position === undefined) return null;

    const qty = parseDec(position.qty);
    const isLong = qty.units > 0n;
    const closeQty = formatDec(isLong ? qty : mul(qty, parseDec('-1')));
    const fill = simulateFill({
      intent: {
        decisionKey: `backtest-close:${input.instrumentId}:${String(input.at.getTime())}`,
        clientOrderId: `backtest-close:${input.instrumentId}:${String(input.at.getTime())}`,
        instrumentId: input.instrumentId,
        assetClass: input.assetClass,
        side: isLong ? 'sell' : 'buy',
        qty: closeQty,
        orderType: 'market',
        tif: 'day',
      },
      referencePrice: input.referencePrice,
      now: input.at,
      ...(this.options.slippageBps !== undefined ? { slippageBps: this.options.slippageBps } : {}),
      ...(this.options.feeBpsByAssetClass?.[input.assetClass] !== undefined
        ? { feeBps: this.options.feeBpsByAssetClass[input.assetClass] }
        : {}),
    });

    // Closing reverses the signed notional: selling a long credits cash.
    const proceeds = mul(qty, parseDec(fill.fillPrice));
    this.cash = formatDec(roundTo(add(sub(parseDec(this.cash), parseDec(fill.fee)), proceeds), 2));
    this.feesPaid = formatDec(add(parseDec(this.feesPaid), parseDec(fill.fee)));

    const gross = mul(qty, sub(parseDec(fill.fillPrice), parseDec(position.avgEntryPrice)));
    const trade: ClosedTrade = {
      instrumentId: input.instrumentId,
      signalId: position.signalId,
      side: isLong ? 'long' : 'short',
      qty: position.qty,
      entryPrice: position.avgEntryPrice,
      exitPrice: fill.fillPrice,
      openedAt: position.openedAt,
      closedAt: input.at,
      // Entry fee is already out of cash; charge only this leg's fee here so
      // summing realizedUsd across trades reconciles with cash movement.
      realizedUsd: formatDec(roundTo(sub(gross, parseDec(fill.fee)), 2)),
      feesUsd: fill.fee,
      exitReason: input.reason,
    };
    this.closed.push(trade);
    this.open.delete(input.instrumentId);
    return trade;
  }

  trades(): ClosedTrade[] {
    return [...this.closed];
  }

  cashUsd(): string {
    return this.cash;
  }

  totalFeesUsd(): string {
    return this.feesPaid;
  }
}
