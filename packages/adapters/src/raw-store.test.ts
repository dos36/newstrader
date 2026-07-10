import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsRawStore, rawStoreKey } from './raw-store.js';

describe('rawStoreKey', () => {
  it('builds the {source}/{yyyy-mm-dd}/{contentHash}-{idHash}.json layout from the UTC receipt date', () => {
    const receivedAt = new Date('2026-07-10T23:59:59.999Z');
    const key = rawStoreKey('edgar_8k', receivedAt, 'abc123', 'acc-001');
    expect(key).toMatch(/^edgar_8k\/2026-07-10\/abc123-[0-9a-f]{12}\.json$/);
  });

  it('is deterministic for the same item (overwrite-idempotent re-puts)', () => {
    const receivedAt = new Date('2026-07-10T12:00:00Z');
    expect(rawStoreKey('s', receivedAt, 'h', 'ext')).toBe(rawStoreKey('s', receivedAt, 'h', 'ext'));
  });

  it('separates same-content items with different external ids (no payload clobbering)', () => {
    const receivedAt = new Date('2026-07-10T12:00:00Z');
    const a = rawStoreKey('globenewswire', receivedAt, 'samehash', 'guid-original');
    const b = rawStoreKey('globenewswire', receivedAt, 'samehash', 'guid-reissue');
    expect(a).not.toBe(b);
  });
});

describe('FsRawStore', () => {
  let dir: string;
  let store: FsRawStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'newstrader-raw-'));
    store = new FsRawStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a payload and returns the file path as ref', async () => {
    const payload = { headline: 'hello', nested: { n: 1 }, tags: ['a', 'b'] };
    const key = rawStoreKey('massive_news', new Date('2026-07-10T12:00:00Z'), 'deadbeef', 'art-1');

    const ref = await store.put(key, payload);

    expect(ref).toContain(`massive_news${sep}2026-07-10${sep}deadbeef-`);
    await expect(store.get(ref)).resolves.toEqual(payload);
  });

  it('creates nested date directories on demand', async () => {
    const ref1 = await store.put('src/2026-07-10/h1.json', 'one');
    const ref2 = await store.put('src/2026-07-11/h2.json', 'two');

    await expect(store.get(ref1)).resolves.toBe('one');
    await expect(store.get(ref2)).resolves.toBe('two');
  });

  it('stores string payloads (raw XML) verbatim through JSON', async () => {
    const xml = '<feed><entry>&amp; escaped</entry></feed>';
    const ref = await store.put('rssfeed/2026-07-10/x.json', xml);
    await expect(store.get(ref)).resolves.toBe(xml);
  });

  it('rejects path-traversal and absolute keys', async () => {
    await expect(store.put('../escape.json', {})).rejects.toThrow(/Unsafe raw-store key/);
    await expect(store.put('a/../../escape.json', {})).rejects.toThrow(/Unsafe raw-store key/);
    await expect(store.put('/abs.json', {})).rejects.toThrow(/Unsafe raw-store key/);
  });

  it('fromEnv honors RAW_STORE_DIR', async () => {
    const envStore = FsRawStore.fromEnv({ RAW_STORE_DIR: dir });
    const ref = await envStore.put('s/2026-07-10/h.json', { ok: true });
    expect(ref.startsWith(dir)).toBe(true);
  });
});
