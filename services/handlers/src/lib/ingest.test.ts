import { describe, expect, it } from 'vitest';
import { parseRawItemRecord, resolveReceivedAt, sourceDisplayName } from './ingest.js';

/**
 * Network-free unit tests for the pure parts of the shared ingest core.
 * The DB-backed poll/process paths are covered end-to-end by
 * services/cli/src/e2e.test.ts (skipped without TEST_DATABASE_URL).
 */

const VALID_MESSAGE = {
  v: 1,
  itemId: '01J0000000000000000000000',
  sourceKey: 'edgar_8k',
  externalId: '0001645460-26-000123',
  headline: '8-K - Acme Corp (0001645460) (Filer)',
  payloadRef: 's3://bucket/raw/edgar_8k/2026-07-10/abc.json',
  contentHash: 'a'.repeat(64),
  publishedAt: '2026-07-10T12:00:00.000Z',
  receivedAt: '2026-07-10T12:01:30.000Z',
  symbolsHint: ['ACME'],
  meta: { itemCodes: ['2.02'] },
};

describe('parseRawItemRecord', () => {
  it('parses a valid RawItemV1 pointer message', () => {
    const parsed = parseRawItemRecord(JSON.stringify(VALID_MESSAGE));
    expect(parsed).not.toBeNull();
    expect(parsed?.itemId).toBe(VALID_MESSAGE.itemId);
    expect(parsed?.symbolsHint).toEqual(['ACME']);
  });

  it('applies contract defaults for optional collections', () => {
    const rest: Record<string, unknown> = { ...VALID_MESSAGE };
    delete rest['symbolsHint'];
    delete rest['meta'];
    const parsed = parseRawItemRecord(JSON.stringify(rest));
    expect(parsed?.symbolsHint).toEqual([]);
    expect(parsed?.meta).toEqual({});
  });

  it('returns null for non-JSON bodies (poison pill, not a throw)', () => {
    expect(parseRawItemRecord('not json at all')).toBeNull();
  });

  it('returns null for JSON that is not a RawItemV1', () => {
    expect(parseRawItemRecord(JSON.stringify({ hello: 'world' }))).toBeNull();
    expect(parseRawItemRecord(JSON.stringify({ ...VALID_MESSAGE, v: 2 }))).toBeNull();
    expect(
      parseRawItemRecord(JSON.stringify({ ...VALID_MESSAGE, receivedAt: 'yesterday' })),
    ).toBeNull();
  });
});

describe('sourceDisplayName', () => {
  it('maps known source keys to readable names and falls back to the key', () => {
    expect(sourceDisplayName('edgar_8k')).toBe('SEC EDGAR 8-K filings');
    expect(sourceDisplayName('massive_news')).toBe('Massive (ex-Polygon) news API');
    expect(sourceDisplayName('some_future_source')).toBe('some_future_source');
  });
});

/**
 * The `received_at` gate. This is where invariant 3 is enforced in code rather
 * than in prose: only an adapter that declares `backfill === true` may place
 * its own rows on the timeline, and everything else gets our clock.
 */
describe('resolveReceivedAt', () => {
  const NOW = new Date('2026-08-31T15:00:00.000Z');
  const now = (): Date => NOW;
  const HISTORICAL = '2016-03-04T09:30:00.000Z';

  it('uses our clock for a live adapter with no override', () => {
    expect(resolveReceivedAt({ sourceKey: 'nyt_world' }, { externalId: 'a' }, now)).toEqual(NOW);
  });

  it('uses our clock for a backfill adapter that supplies no override', () => {
    expect(
      resolveReceivedAt({ sourceKey: 'nyt_archive', backfill: true }, { externalId: 'a' }, now),
    ).toEqual(NOW);
  });

  it('honours the override only for a declared backfill adapter', () => {
    expect(
      resolveReceivedAt(
        { sourceKey: 'nyt_archive', backfill: true },
        { externalId: 'a', receivedAtOverride: HISTORICAL },
        now,
      ),
    ).toEqual(new Date(HISTORICAL));
  });

  it('IGNORES the override on a live adapter, however it got there', () => {
    // The whole point of the flag. A live adapter that sets this — through a
    // bug, or because a feed it parses was manipulated — must not be able to
    // backdate arrival times, because the trading path reads received_at.
    for (const backfill of [undefined, false] as const) {
      expect(
        resolveReceivedAt(
          { sourceKey: 'nyt_world', ...(backfill !== undefined ? { backfill } : {}) },
          { externalId: 'a', receivedAtOverride: HISTORICAL },
          now,
        ),
      ).toEqual(NOW);
    }
  });

  it('throws on an unparseable override rather than falling back to now()', () => {
    // A silent fallback would drop a 2016 article into today's clustering
    // window, corrupting the timeline in a way no later query could detect.
    expect(() =>
      resolveReceivedAt(
        { sourceKey: 'nyt_archive', backfill: true },
        { externalId: 'item-42', receivedAtOverride: 'last Tuesday' },
        now,
      ),
    ).toThrow(/nyt_archive.*item-42/s);
  });
});
