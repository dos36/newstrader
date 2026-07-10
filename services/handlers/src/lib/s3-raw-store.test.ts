import type { GetObjectCommand } from '@aws-sdk/client-s3';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { parseS3Ref, S3RawStore } from './s3-raw-store.js';

/** In-memory fake honoring the narrow S3ClientLike seam. */
class FakeS3 {
  readonly objects = new Map<string, string>();
  async send(command: PutObjectCommand | GetObjectCommand): Promise<unknown> {
    if (command instanceof PutObjectCommand) {
      const { Bucket, Key, Body } = command.input;
      this.objects.set(`${Bucket}/${Key}`, String(Body));
      return {};
    }
    const { Bucket, Key } = command.input;
    const stored = this.objects.get(`${Bucket}/${Key}`);
    if (stored === undefined) throw new Error(`NoSuchKey: ${Bucket}/${Key}`);
    return { Body: { transformToString: async () => stored } };
  }
}

describe('S3RawStore', () => {
  it('puts under the key prefix and returns an s3:// ref that get() resolves', async () => {
    const fake = new FakeS3();
    const store = new S3RawStore({ bucket: 'raw-bucket', client: fake });
    const payload = { hello: 'world', n: 1 };

    const ref = await store.put('fake_wire/2026-07-10/abc123.json', payload);
    expect(ref).toBe('s3://raw-bucket/raw/fake_wire/2026-07-10/abc123.json');
    expect(fake.objects.has('raw-bucket/raw/fake_wire/2026-07-10/abc123.json')).toBe(true);

    expect(await store.get(ref)).toEqual(payload);
  });

  it('supports a custom and an empty key prefix', async () => {
    const fake = new FakeS3();
    const custom = new S3RawStore({ bucket: 'b', keyPrefix: 'archive/v2', client: fake });
    expect(await custom.put('k.json', 1)).toBe('s3://b/archive/v2/k.json');

    const bare = new S3RawStore({ bucket: 'b', keyPrefix: '', client: fake });
    expect(await bare.put('k.json', 1)).toBe('s3://b/k.json');
  });

  it('stores null payloads as JSON null', async () => {
    const fake = new FakeS3();
    const store = new S3RawStore({ bucket: 'b', client: fake });
    const ref = await store.put('k.json', undefined);
    expect(await store.get(ref)).toBeNull();
  });

  it('rejects unsafe keys', async () => {
    const store = new S3RawStore({ bucket: 'b', client: new FakeS3() });
    await expect(store.put('../escape.json', {})).rejects.toThrow(/Unsafe raw-store key/);
    await expect(store.put('/absolute.json', {})).rejects.toThrow(/Unsafe raw-store key/);
    await expect(store.put('a/../b.json', {})).rejects.toThrow(/Unsafe raw-store key/);
  });

  it('parseS3Ref rejects non-s3 refs', () => {
    expect(parseS3Ref('s3://bucket/some/key.json')).toEqual({
      bucket: 'bucket',
      key: 'some/key.json',
    });
    expect(() => parseS3Ref('/local/path.json')).toThrow(/Not an s3:\/\/ ref/);
    expect(() => parseS3Ref('s3://bucket-only')).toThrow(/Not an s3:\/\/ ref/);
  });
});
