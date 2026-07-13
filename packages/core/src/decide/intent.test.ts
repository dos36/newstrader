// node:crypto is allowed in TESTS (purity.test.ts constrains only the modules
// under src/decide, never the test files) — here it independently verifies
// our pure-TS sha256 against the platform implementation.
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { OrderIntent } from '../trading/contracts.js';

import {
  CLIENT_ORDER_ID_LENGTH,
  buildCloseOrderIntent,
  buildOrderIntent,
  clientOrderIdFor,
} from './intent.js';
import { sha256Hex } from './sha256.js';

describe('sha256Hex', () => {
  it('matches the FIPS 180-4 known-answer vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('matches node:crypto across lengths, block boundaries, and unicode', () => {
    const samples = [
      'sig_01J:rv_01K:live',
      'a'.repeat(55), // last byte before padding spills a block
      'a'.repeat(56), // first length that forces a second block
      'a'.repeat(64),
      'a'.repeat(1000),
      'naïve — 資產 🚀',
    ];
    for (const sample of samples) {
      expect(sha256Hex(sample)).toBe(createHash('sha256').update(sample, 'utf8').digest('hex'));
    }
  });
});

describe('clientOrderIdFor — the double-order guard', () => {
  it('same decisionKey ALWAYS produces the same clientOrderId', () => {
    const key = 'sig_01HXYZ:rv_01ABC:live';
    expect(clientOrderIdFor(key)).toBe(clientOrderIdFor(key));
  });

  it('is the first 32 hex chars of sha256(decisionKey)', () => {
    const key = 'sig_1:rv_1:live';
    const expected = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32);
    expect(clientOrderIdFor(key)).toBe(expected);
    expect(clientOrderIdFor(key)).toHaveLength(CLIENT_ORDER_ID_LENGTH);
    expect(clientOrderIdFor(key)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('different decisionKeys produce different ids', () => {
    expect(clientOrderIdFor('sig_1:rv_1:live')).not.toBe(clientOrderIdFor('sig_1:rv_2:live'));
    expect(clientOrderIdFor('sig_1:rv_1:live')).not.toBe(clientOrderIdFor('sig_1:rv_1:run_9'));
  });
});

describe('buildOrderIntent', () => {
  const base = {
    decisionKey: 'sig_1:rv_1:live',
    instrumentId: 'ins_1',
    assetClass: 'us_equity' as const,
    qty: '125',
  };

  it('open_long buys, open_short sells; market/day always', () => {
    const long = buildOrderIntent({ ...base, action: 'open_long' });
    expect(long.side).toBe('buy');
    expect(long.orderType).toBe('market');
    expect(long.tif).toBe('day');
    expect(long.qty).toBe('125');
    expect(long.decisionKey).toBe(base.decisionKey);

    const short = buildOrderIntent({ ...base, action: 'open_short' });
    expect(short.side).toBe('sell');
  });

  it('produces a contract-valid OrderIntent (zod round-trip)', () => {
    const intent = buildOrderIntent({ ...base, action: 'open_long' });
    expect(OrderIntent.parse(intent)).toEqual(intent);
  });

  it('the same decision rebuilt after a retry yields the identical intent', () => {
    const a = buildOrderIntent({ ...base, action: 'open_long' });
    const b = buildOrderIntent({ ...base, action: 'open_long' });
    expect(b).toEqual(a);
  });
});

describe('buildCloseOrderIntent', () => {
  const base = {
    decisionKey: 'exit:order_1',
    attempt: 1,
    instrumentId: 'ins_1',
    assetClass: 'crypto' as const,
    qty: '0.5',
  };

  it('closing a long sells; closing a short buys', () => {
    expect(buildCloseOrderIntent({ ...base, positionSide: 'long' }).side).toBe('sell');
    expect(buildCloseOrderIntent({ ...base, positionSide: 'short' }).side).toBe('buy');
  });

  it('derives its clientOrderId from decisionKey:a<attempt>, and decisionKey itself is untouched', () => {
    const intent = buildCloseOrderIntent({ ...base, positionSide: 'long' });
    expect(intent.clientOrderId).toBe(clientOrderIdFor(`${base.decisionKey}:a1`));
    expect(intent.decisionKey).toBe(base.decisionKey);
    expect(OrderIntent.parse(intent)).toEqual(intent);
  });

  it('a different attempt number yields a different clientOrderId but the SAME decisionKey', () => {
    const attempt1 = buildCloseOrderIntent({ ...base, attempt: 1, positionSide: 'long' });
    const attempt2 = buildCloseOrderIntent({ ...base, attempt: 2, positionSide: 'long' });
    expect(attempt1.clientOrderId).not.toBe(attempt2.clientOrderId);
    expect(attempt1.decisionKey).toBe(attempt2.decisionKey);
    expect(attempt2.clientOrderId).toBe(clientOrderIdFor(`${base.decisionKey}:a2`));
  });
});
