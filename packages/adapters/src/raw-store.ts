import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { RawStore } from '@newstrader/core';

/**
 * Filesystem RawStore for local development: JSON files under RAW_STORE_DIR
 * (default ./data/raw), key layout `{source}/{yyyy-mm-dd}/{hash}.json`.
 * The returned ref is the resolved file path (stored on raw_news_items.payload_ref).
 */
export class FsRawStore implements RawStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  static fromEnv(env: Record<string, string | undefined>): FsRawStore {
    return new FsRawStore(env['RAW_STORE_DIR'] ?? './data/raw');
  }

  async put(key: string, payload: unknown): Promise<string> {
    assertSafeKey(key);
    const path = join(this.rootDir, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(payload ?? null, null, 2), 'utf8');
    return path;
  }

  async get(ref: string): Promise<unknown> {
    const text = await readFile(ref, 'utf8');
    return JSON.parse(text) as unknown;
  }
}

/**
 * Canonical raw-store key: `{source}/{yyyy-mm-dd}/{contentHash}-{externalId hash}.json`
 * (UTC date of receipt). externalId is part of the key because two same-source
 * items can share normalized text but differ in identity (a re-issued press
 * release with a new guid) — content hash alone would clobber the first item's
 * verbatim payload, and raw/ must stay the immutable replay source of truth.
 * Re-puts of the SAME item stay overwrite-idempotent.
 */
export function rawStoreKey(
  sourceKey: string,
  receivedAt: Date,
  contentHash: string,
  externalId: string,
): string {
  const day = receivedAt.toISOString().slice(0, 10);
  const idHash = createHash('sha256').update(externalId).digest('hex').slice(0, 12);
  return `${sourceKey}/${day}/${contentHash}-${idHash}.json`;
}

function assertSafeKey(key: string): void {
  if (key.length === 0 || key.startsWith('/') || key.split('/').includes('..')) {
    throw new Error(`Unsafe raw-store key: ${key}`);
  }
}

/**
 * TODO(deploy): S3RawStore — same key layout under s3://{bucket}/{keyPrefix ?? 'raw'}/…,
 * ref = the s3:// URI. Implementation lands with the CDK ingest stack; only the
 * config shape is fixed here so wiring code can reference it.
 */
export type S3RawStoreConfig = {
  bucket: string;
  keyPrefix?: string;
};
