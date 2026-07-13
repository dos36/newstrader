import { describe, expect, it } from 'vitest';
import { derivePortfolio } from './positions.js';
import type { PortfolioFill } from './positions.js';

const T0 = new Date('2026-01-05T15:00:00.000Z');
const minutesAfter = (n: number) => new Date(T0.getTime() + n * 60_000);

let seq = 0;
function fill(input: {
  side: 'buy' | 'sell';
  qty: string;
  price: string;
  fee?: string;
  instrumentId?: string;
  at?: Date;
  id?: string;
}): PortfolioFill {
  seq += 1;
  return {
    id: input.id ?? `f${String(seq).padStart(4, '0')}`,
    instrumentId: input.instrumentId ?? 'inst-1',
    side: input.side,
    qty: input.qty,
    price: input.price,
    fee: input.fee ?? '0',
    filledAt: input.at ?? minutesAfter(seq),
  };
}

describe('derivePortfolio — lot method (net-position weighted average)', () => {
  it('partial close: buy 10 @100, sell 4 @110 → qty 6, avg 100, realized 40', () => {
    const p = derivePortfolio([
      fill({ side: 'buy', qty: '10', price: '100' }),
      fill({ side: 'sell', qty: '4', price: '110' }),
    ]);
    expect(p.positions).toEqual([
      { instrumentId: 'inst-1', qty: '6', avgEntryPrice: '100', openCostUsd: '600' },
    ]);
    expect(p.realizedPnlUsd).toBe('40');
    expect(p.feesUsd).toBe('0');
    expect(p.cashDeltaUsd).toBe('-560'); // −1000 + 440
  });

  it('adds shift the weighted average; a later partial close realizes against it', () => {
    const p = derivePortfolio([
      fill({ side: 'buy', qty: '10', price: '100' }),
      fill({ side: 'buy', qty: '10', price: '110' }), // avg now 105
      fill({ side: 'sell', qty: '5', price: '120' }),
    ]);
    expect(p.positions).toEqual([
      { instrumentId: 'inst-1', qty: '15', avgEntryPrice: '105', openCostUsd: '1575' },
    ]);
    expect(p.realizedPnlUsd).toBe('75'); // (120 − 105) × 5
  });

  it('full close goes exactly flat (no rounding residue) and drops the position', () => {
    const p = derivePortfolio([
      fill({ side: 'buy', qty: '3', price: '10.000001' }),
      fill({ side: 'sell', qty: '3', price: '12' }),
    ]);
    expect(p.positions).toEqual([]);
    expect(p.realizedPnlUsd).toBe('5.999997'); // 36 − 30.000003
    expect(p.cashDeltaUsd).toBe('5.999997');
  });

  it('crossing through zero closes the lot then reopens the remainder at the fill price', () => {
    const p = derivePortfolio([
      fill({ side: 'buy', qty: '5', price: '100' }),
      fill({ side: 'sell', qty: '8', price: '110' }),
    ]);
    expect(p.positions).toEqual([
      { instrumentId: 'inst-1', qty: '-3', avgEntryPrice: '110', openCostUsd: '330' },
    ]);
    expect(p.realizedPnlUsd).toBe('50'); // (110 − 100) × 5 on the closed long
  });

  it('short lots realize inverted P&L: sell 5 @100, buy 5 @90 → +50, flat', () => {
    const p = derivePortfolio([
      fill({ side: 'sell', qty: '5', price: '100' }),
      fill({ side: 'buy', qty: '5', price: '90' }),
    ]);
    expect(p.positions).toEqual([]);
    expect(p.realizedPnlUsd).toBe('50');
    expect(p.cashDeltaUsd).toBe('50'); // +500 − 450
  });

  it('proportional cost slices round at 8dp on mixed-entry partial closes', () => {
    const p = derivePortfolio([
      fill({ side: 'buy', qty: '1', price: '10' }),
      fill({ side: 'buy', qty: '2', price: '11' }), // openCost 32, qty 3
      fill({ side: 'sell', qty: '1', price: '12' }), // closedCost = 32/3 → 10.66666667
    ]);
    expect(p.realizedPnlUsd).toBe('1.33333333');
    expect(p.positions).toEqual([
      {
        instrumentId: 'inst-1',
        qty: '2',
        avgEntryPrice: '10.666667', // 21.33333333 / 2, 6dp
        openCostUsd: '21.33333333',
      },
    ]);
  });
});

describe('derivePortfolio — cash, fees, ordering, multi-instrument', () => {
  it('fees reduce cash and accumulate, but never touch realized P&L', () => {
    const p = derivePortfolio([
      fill({ side: 'buy', qty: '2', price: '100', fee: '0.52' }),
      fill({ side: 'sell', qty: '2', price: '101', fee: '0.5252' }),
    ]);
    expect(p.realizedPnlUsd).toBe('2');
    expect(p.feesUsd).toBe('1.0452');
    expect(p.cashDeltaUsd).toBe('0.9548'); // 202 − 200 − fees
  });

  it('sorts by filledAt then id — out-of-order input derives identically', () => {
    const inOrder = [
      fill({ side: 'buy', qty: '5', price: '100', at: minutesAfter(1), id: 'a' }),
      fill({ side: 'sell', qty: '5', price: '110', at: minutesAfter(2), id: 'b' }),
    ];
    const shuffled = [inOrder[1], inOrder[0]] as PortfolioFill[];
    expect(derivePortfolio(shuffled)).toEqual(derivePortfolio(inOrder));
    // Same timestamp: id decides (a buy must precede its same-minute close).
    const sameTs = derivePortfolio([
      fill({ side: 'sell', qty: '5', price: '110', at: minutesAfter(1), id: '02' }),
      fill({ side: 'buy', qty: '5', price: '100', at: minutesAfter(1), id: '01' }),
    ]);
    expect(sameTs.realizedPnlUsd).toBe('50');
    expect(sameTs.positions).toEqual([]);
  });

  it('tracks instruments independently', () => {
    const p = derivePortfolio([
      fill({ side: 'buy', qty: '1', price: '100', instrumentId: 'aaa' }),
      fill({ side: 'sell', qty: '2', price: '50', instrumentId: 'bbb' }),
    ]);
    expect(p.positions).toHaveLength(2);
    expect(p.positions.find((x) => x.instrumentId === 'aaa')?.qty).toBe('1');
    expect(p.positions.find((x) => x.instrumentId === 'bbb')?.qty).toBe('-2');
  });

  it('empty input → empty portfolio with zero totals', () => {
    expect(derivePortfolio([])).toEqual({
      positions: [],
      realizedPnlUsd: '0',
      feesUsd: '0',
      cashDeltaUsd: '0',
    });
  });

  it('rejects corrupt fills loudly (money path fails, never guesses)', () => {
    expect(() => derivePortfolio([fill({ side: 'buy', qty: '0', price: '100' })])).toThrow(
      /non-positive qty/,
    );
    expect(() => derivePortfolio([fill({ side: 'buy', qty: '1', price: '0' })])).toThrow(
      /non-positive price/,
    );
    expect(() =>
      derivePortfolio([fill({ side: 'buy', qty: '1', price: '100', fee: '-0.01' })]),
    ).toThrow(/negative fee/);
  });
});
