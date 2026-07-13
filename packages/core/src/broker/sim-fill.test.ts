import { describe, expect, it } from 'vitest';
import type { OrderIntent } from '../trading/contracts.js';
import { SIM_FEE_BPS, SIM_SLIPPAGE_BPS, simulateFill } from './sim-fill.js';

const NOW = new Date('2026-07-10T14:30:00.000Z');

function intent(overrides: Partial<OrderIntent> = {}): OrderIntent {
  return {
    clientOrderId: 'co-test-1',
    decisionKey: 'sig-1:rv-1:live',
    instrumentId: 'inst-1',
    assetClass: 'us_equity',
    side: 'buy',
    qty: '10',
    orderType: 'market',
    tif: 'day',
    ...overrides,
  };
}

describe('simulateFill — slippage direction', () => {
  it('buys pay UP: reference × (1 + bps/10000)', () => {
    const fill = simulateFill({ intent: intent(), referencePrice: '100', now: NOW });
    expect(fill.fillPrice).toBe('100.05'); // default 5 bps
    expect(fill.fillQty).toBe('10');
    expect(fill.filledAt).toBe(NOW);
  });

  it('sells receive LESS: reference × (1 − bps/10000)', () => {
    const fill = simulateFill({
      intent: intent({ side: 'sell' }),
      referencePrice: '100',
      now: NOW,
    });
    expect(fill.fillPrice).toBe('99.95');
  });

  it('honors an explicit slippage override, including zero', () => {
    const zero = simulateFill({
      intent: intent(),
      referencePrice: '250.123456',
      slippageBps: 0,
      now: NOW,
    });
    expect(zero.fillPrice).toBe('250.123456');
    const wide = simulateFill({
      intent: intent({ side: 'sell' }),
      referencePrice: '200',
      slippageBps: 50,
      now: NOW,
    });
    expect(wide.fillPrice).toBe('199'); // 200 × 0.995
  });

  it('rounds the fill price to 6dp half-away-from-zero', () => {
    // 0.123456 × 1.0005 = 0.1235177280 → 0.123518
    const fill = simulateFill({ intent: intent(), referencePrice: '0.123456', now: NOW });
    expect(fill.fillPrice).toBe('0.123518');
  });
});

describe('simulateFill — fees', () => {
  it('us_equity defaults to zero fee', () => {
    const fill = simulateFill({ intent: intent(), referencePrice: '100', now: NOW });
    expect(fill.fee).toBe('0');
    expect(SIM_FEE_BPS.us_equity).toBe(0);
  });

  it('crypto defaults to 26 bps of fill notional', () => {
    const fill = simulateFill({
      intent: intent({ assetClass: 'crypto', qty: '0.1' }),
      referencePrice: '50000',
      now: NOW,
    });
    // fillPrice = 50000 × 1.0005 = 50025; fee = 50025 × 0.1 × 0.0026 = 13.0065
    expect(fill.fillPrice).toBe('50025');
    expect(fill.fee).toBe('13.0065');
    expect(SIM_FEE_BPS.crypto).toBe(26);
  });

  it('rounds the fee to 6dp half-away-from-zero', () => {
    // price 1 (slippage 0) × qty 0.001 × 5bps = 0.0000005 → 0.000001
    const fill = simulateFill({
      intent: intent({ qty: '0.001' }),
      referencePrice: '1',
      slippageBps: 0,
      feeBps: 5,
      now: NOW,
    });
    expect(fill.fee).toBe('0.000001');
  });

  it('fee uses the SLIPPED fill notional, not the reference notional', () => {
    const fill = simulateFill({
      intent: intent({ qty: '1' }),
      referencePrice: '10000',
      slippageBps: 100, // fill at 10100
      feeBps: 10,
      now: NOW,
    });
    expect(fill.fillPrice).toBe('10100');
    expect(fill.fee).toBe('10.1'); // 10100 × 0.001
  });
});

describe('simulateFill — quantity and purity', () => {
  it('fills the full intent quantity, rounded to the 8dp column scale', () => {
    const fill = simulateFill({
      intent: intent({ qty: '0.123456789' }),
      referencePrice: '100',
      now: NOW,
    });
    expect(fill.fillQty).toBe('0.12345679');
  });

  it('stamps filledAt from the injected now (no internal clock)', () => {
    const later = new Date('2030-01-01T00:00:00.000Z');
    expect(simulateFill({ intent: intent(), referencePrice: '1', now: later }).filledAt).toBe(
      later,
    );
  });

  it('exports the documented default slippage', () => {
    expect(SIM_SLIPPAGE_BPS).toBe(5);
  });
});

describe('simulateFill — input validation', () => {
  it('rejects non-positive quantities (including sub-scale dust)', () => {
    expect(() =>
      simulateFill({ intent: intent({ qty: '0' }), referencePrice: '100', now: NOW }),
    ).toThrow(/must be positive/);
    expect(() =>
      simulateFill({ intent: intent({ qty: '0.000000001' }), referencePrice: '100', now: NOW }),
    ).toThrow(/must be positive/);
  });

  it('rejects non-positive or malformed reference prices', () => {
    expect(() => simulateFill({ intent: intent(), referencePrice: '0', now: NOW })).toThrow(
      /must be positive/,
    );
    expect(() => simulateFill({ intent: intent(), referencePrice: '-1', now: NOW })).toThrow(
      /must be positive/,
    );
    expect(() => simulateFill({ intent: intent(), referencePrice: '1e3', now: NOW })).toThrow(
      /invalid decimal string/,
    );
  });

  it('rejects negative slippage/fee and a sell slipped to zero', () => {
    expect(() =>
      simulateFill({ intent: intent(), referencePrice: '100', slippageBps: -1, now: NOW }),
    ).toThrow(/negative slippageBps/);
    expect(() =>
      simulateFill({ intent: intent(), referencePrice: '100', feeBps: -1, now: NOW }),
    ).toThrow(/negative feeBps/);
    expect(() =>
      simulateFill({
        intent: intent({ side: 'sell' }),
        referencePrice: '100',
        slippageBps: 10_000,
        now: NOW,
      }),
    ).toThrow(/non-positive sell fill price/);
  });
});
