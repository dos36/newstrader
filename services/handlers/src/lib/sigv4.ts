import { createHash, createHmac } from 'node:crypto';

/**
 * Minimal AWS Signature V4 request signer.
 *
 * Why hand-rolled: the handlers need exactly two AWS JSON API calls at cold
 * start (SSM GetParameter, Secrets Manager GetSecretValue), and neither
 * @aws-sdk/client-ssm nor @aws-sdk/client-secrets-manager is a declared
 * dependency of this package — and the shared lockfile cannot be touched
 * while parallel agents build. SigV4 over Node's global fetch needs only
 * node:crypto. Verified against four vectors from the official AWS SigV4
 * test suite (see sigv4.test.ts). Swap for the official SDK clients whenever
 * the deps get added — only aws-api.ts touches this module.
 */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
}

export interface SignRequestInput {
  method: string;
  url: URL;
  /** Extra headers to sign (content-type, x-amz-target, …). host, x-amz-date and x-amz-security-token are added automatically. */
  headers?: Record<string, string>;
  body: string;
  service: string;
  region: string;
  credentials: AwsCredentials;
  /** Injectable for tests; defaults to now. */
  date?: Date;
}

/** Sign a request; returns the complete header set (lower-cased names) including authorization. */
export function signRequest(input: SignRequestInput): Record<string, string> {
  const amzDate = toAmzDate(input.date ?? new Date());
  const dateStamp = amzDate.slice(0, 8);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  headers['host'] = input.url.host;
  headers['x-amz-date'] = amzDate;
  if (input.credentials.sessionToken !== undefined) {
    headers['x-amz-security-token'] = input.credentials.sessionToken;
  }

  const sortedHeaders = Object.entries(headers).sort(([a], [b]) => (a < b ? -1 : 1));
  const signedHeaders = sortedHeaders.map(([name]) => name).join(';');
  const canonicalHeaders = sortedHeaders
    .map(([name, value]) => `${name}:${value.trim().replace(/\s+/g, ' ')}\n`)
    .join('');

  const canonicalQuery = [...input.url.searchParams.entries()]
    .map(([key, value]) => [rfc3986Encode(key), rfc3986Encode(value)] as const)
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : 1) : ak < bk ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(input.url.pathname),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    sha256Hex(input.body),
  ].join('\n');

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${input.credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** 20150830T123600Z */
function toAmzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '');
}

/** Normalize-then-encode each path segment per RFC 3986 (our calls all use "/"). */
function canonicalUri(pathname: string): string {
  if (pathname === '' || pathname === '/') return '/';
  return pathname
    .split('/')
    .map((segment) => rfc3986Encode(safeDecode(segment)))
    .join('/');
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** encodeURIComponent plus the RFC 3986 reserved set it misses. */
function rfc3986Encode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}
