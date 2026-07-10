import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { RawStore } from '@newstrader/core';

/**
 * S3-backed RawStore for the deployed pollers/process Lambda — the counterpart
 * of packages/adapters' FsRawStore (whose S3RawStoreConfig stub fixed this
 * shape). Key layout matches the architecture (§4.4 S3 layout):
 * s3://{bucket}/{keyPrefix}/{source}/{yyyy-mm-dd}/{hash}.json. The returned
 * ref is the full s3:// URI, stored on raw_news_items.payload_ref.
 */

/** Narrow client seam so tests can fake S3 without network or credentials. */
export interface S3ClientLike {
  send(command: PutObjectCommand | GetObjectCommand): Promise<unknown>;
}

export interface S3RawStoreOptions {
  bucket: string;
  /** Defaults to 'raw' (architecture bucket layout). Pass '' for none. */
  keyPrefix?: string;
  client?: S3ClientLike;
}

export class S3RawStore implements RawStore {
  private readonly bucket: string;
  private readonly keyPrefix: string;
  private readonly client: S3ClientLike;

  constructor(options: S3RawStoreOptions) {
    if (options.bucket.length === 0) throw new Error('S3RawStore: bucket must not be empty');
    this.bucket = options.bucket;
    this.keyPrefix = options.keyPrefix ?? 'raw';
    this.client = options.client ?? new S3Client({});
  }

  static fromEnv(env: NodeJS.ProcessEnv): S3RawStore {
    const bucket = env['RAW_BUCKET'];
    if (bucket === undefined || bucket.length === 0) {
      throw new Error('RAW_BUCKET is not set — required for S3RawStore');
    }
    const keyPrefix = env['RAW_STORE_PREFIX'];
    return new S3RawStore({ bucket, ...(keyPrefix !== undefined ? { keyPrefix } : {}) });
  }

  async put(key: string, payload: unknown): Promise<string> {
    assertSafeKey(key);
    const fullKey = this.keyPrefix.length > 0 ? `${this.keyPrefix}/${key}` : key;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: fullKey,
        Body: JSON.stringify(payload ?? null, null, 2),
        ContentType: 'application/json',
      }),
    );
    return `s3://${this.bucket}/${fullKey}`;
  }

  async get(ref: string): Promise<unknown> {
    const { bucket, key } = parseS3Ref(ref);
    const response = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = (response as { Body?: unknown }).Body;
    if (!hasTransformToString(body)) {
      throw new Error(`S3 GetObject(${ref}) returned no readable body`);
    }
    return JSON.parse(await body.transformToString('utf-8')) as unknown;
  }
}

/** s3://bucket/key/parts.json → { bucket, key }. The ref is authoritative (may name another bucket). */
export function parseS3Ref(ref: string): { bucket: string; key: string } {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(ref);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error(`Not an s3:// ref: ${ref}`);
  }
  return { bucket: match[1], key: match[2] };
}

function assertSafeKey(key: string): void {
  if (key.length === 0 || key.startsWith('/') || key.split('/').includes('..')) {
    throw new Error(`Unsafe raw-store key: ${key}`);
  }
}

function hasTransformToString(
  body: unknown,
): body is { transformToString(encoding?: string): Promise<string> } {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { transformToString?: unknown }).transformToString === 'function'
  );
}
