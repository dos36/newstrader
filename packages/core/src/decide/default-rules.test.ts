import { describe, expect, it } from 'vitest';

import type { DecideFeatures, QuoteSnapshot, SignalInput } from '../trading/contracts.js';
import { RulesConfig } from '../trading/contracts.js';

import { decide } from './decide.js';
import { DEFAULT_RULES_LABEL, DEFAULT_RULES_V1 } from './default-rules.js';

describe('DEFAULT_RULES_V1', () => {
  it('validates against the RulesConfig contract', () => {
    expect(RulesConfig.parse(DEFAULT_RULES_V1)).toEqual(DEFAULT_RULES_V1);
  });

  it('carries the agreed v1 values', () => {
    expect(DEFAULT_RULES_LABEL).toBe('v1-conservative');
    expect(DEFAULT_RULES_V1).toEqual({
      gates: {
        minConfidence: 0.75,
        rejectAlreadyExpected: true,
        rejectCalendarMatch: true,
        eventTypeWhitelist: [],
        staleMoveMaxBps: 300,
        minMedianDollarVolume: 5_000_000,
        maxConcurrentPositions: 10,
        allowShorts: false,
      },
      sizing: {
        riskBpsOfEquity: 50,
        atrLookbackDays: 14,
        atrStopMultiple: 2,
        maxPositionNotionalPct: 0.1,
      },
      exits: {
        defaultTimeStopHorizon: '3d',
        stopAtrMultiple: 2,
        takeProfitAtrMultiple: null,
      },
    });
  });

  it('trades NOTHING by default: a perfect signal skips on the empty whitelist', () => {
    const signal: SignalInput = {
      id: 'sig_1',
      clusterId: 'clu_1',
      instrumentId: 'ins_1',
      assetClass: 'us_equity',
      eventType: 'earnings_surprise',
      direction: 'bullish',
      expectedMoveBps: 400,
      horizon: '3d',
      alreadyExpected: false,
      materiality: 0.9,
      confidence: 0.99,
      anchorTs: '2026-07-10T14:00:00.000Z',
    };
    const features: DecideFeatures = {
      clusterItemCount: 5,
      distinctSourceCount: 3,
      itemsPerHour: 2,
      calendarMatch: false,
      priceMoveSinceAnchorBps: 20,
      medianDollarVolume: 50_000_000,
      atr: '2.00000000',
      openPositionsCount: 0,
      hasOpenPositionForInstrument: false,
      paperEquityUsd: '100000.00',
      engineVersion: 'test',
    };
    const quote: QuoteSnapshot = {
      price: '50.000000',
      ts: '2026-07-10T14:05:00.000Z',
      source: 'massive_delayed',
      spreadBps: null,
    };

    const result = decide(signal, features, quote, DEFAULT_RULES_V1);
    expect(result.action).toBe('skip');
    expect(result.skipReason).toBe('event_type_whitelist');
    // Every other screening gate passed — only the un-earned whitelist blocks.
    expect(result.gates.filter((g) => !g.pass).map((g) => g.gate)).toEqual([
      'event_type_whitelist',
    ]);
  });
});
