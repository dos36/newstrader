import { signRequest } from './sigv4.js';
import type { AwsCredentials } from './sigv4.js';

/**
 * Tiny SSM / Secrets Manager clients over fetch + SigV4 (see sigv4.ts for why
 * the official SDK clients are not used here). Both services speak the same
 * awsJson-1.1 protocol: POST / with an X-Amz-Target header.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface AwsCallOptions {
  /** Injectable env (tests). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: FetchLike;
}

/**
 * Thrown by awsJsonCall on a non-2xx response. `awsErrorType` is the AWS
 * error shorthand (e.g. "ParameterNotFound", "AccessDeniedException") parsed
 * from the awsJson-1.1 error body's `__type`, when the body is shaped that
 * way — undefined for a body that isn't parseable JSON or lacks `__type`
 * (e.g. an API Gateway/network error page). Callers that need to distinguish
 * "this resource legitimately doesn't exist yet" from "we're not allowed to
 * read it" (optionalSsmParameter in boot.ts) branch on this instead of
 * guessing from the message text.
 */
export class AwsJsonError extends Error {
  readonly awsErrorType: string | undefined;

  constructor(message: string, awsErrorType: string | undefined) {
    super(message);
    this.name = 'AwsJsonError';
    this.awsErrorType = awsErrorType;
  }
}

/** GetParameter with decryption — reads the SecureString operator secrets. */
export async function getSsmParameter(name: string, options?: AwsCallOptions): Promise<string> {
  const response = await awsJsonCall({
    service: 'ssm',
    target: 'AmazonSSM.GetParameter',
    request: { Name: name, WithDecryption: true },
    ...options,
  });
  const value = stringAtPath(response, ['Parameter', 'Value']);
  if (value === undefined) {
    throw new Error(`SSM GetParameter(${name}) response had no Parameter.Value`);
  }
  return value;
}

/**
 * PutParameter with Overwrite — the ONLY write this module performs, used by the
 * kill-switch setter to trip trading to `halt`.
 *
 * Deliberately types the value as a plain `String` parameter (matching the
 * manually-created kill switch) and always overwrites: tripping an
 * already-tripped switch must be a harmless no-op so a duplicated notification
 * cannot fail the invocation.
 */
export async function putSsmParameter(
  name: string,
  value: string,
  options?: AwsCallOptions,
): Promise<void> {
  await awsJsonCall({
    service: 'ssm',
    target: 'AmazonSSM.PutParameter',
    request: { Name: name, Value: value, Type: 'String', Overwrite: true },
    ...options,
  });
}

/** GetSecretValue — reads the RDS-generated credentials secret. */
export async function getSecretString(secretId: string, options?: AwsCallOptions): Promise<string> {
  const response = await awsJsonCall({
    service: 'secretsmanager',
    target: 'secretsmanager.GetSecretValue',
    request: { SecretId: secretId },
    ...options,
  });
  const value = stringAtPath(response, ['SecretString']);
  if (value === undefined) {
    throw new Error(`Secrets Manager GetSecretValue(${secretId}) response had no SecretString`);
  }
  return value;
}

export interface AwsJsonCallInput extends AwsCallOptions {
  service: 'ssm' | 'secretsmanager';
  target: string;
  request: Record<string, unknown>;
}

export async function awsJsonCall(input: AwsJsonCallInput): Promise<unknown> {
  const env = input.env ?? process.env;
  const region = env['AWS_REGION'] ?? env['AWS_DEFAULT_REGION'];
  if (region === undefined || region === '') {
    throw new Error('AWS_REGION is not set (expected in the Lambda runtime environment)');
  }
  const url = new URL(`https://${input.service}.${region}.amazonaws.com/`);
  const body = JSON.stringify(input.request);
  const headers = signRequest({
    method: 'POST',
    url,
    body,
    service: input.service,
    region,
    credentials: envCredentials(env),
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': input.target,
    },
  });

  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(url.toString(), { method: 'POST', headers, body });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new AwsJsonError(
      `${input.service} ${input.target} failed: HTTP ${response.status} ${text.slice(0, 300)}`,
      extractAwsErrorType(text),
    );
  }
  return response.json() as Promise<unknown>;
}

/**
 * Parse the awsJson-1.1 error body's `__type` down to its shorthand name:
 * "com.amazonaws.ssm#ParameterNotFound" → "ParameterNotFound",
 * "AccessDeniedException" (already bare) → unchanged. Undefined when the
 * body isn't JSON-shaped-with-`__type` at all.
 */
function extractAwsErrorType(bodyText: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const type = (parsed as Record<string, unknown>)['__type'];
  return typeof type === 'string' ? type.split('#').pop() : undefined;
}

function envCredentials(env: NodeJS.ProcessEnv): AwsCredentials {
  const accessKeyId = env['AWS_ACCESS_KEY_ID'];
  const secretAccessKey = env['AWS_SECRET_ACCESS_KEY'];
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    throw new Error(
      'AWS credentials missing (expected Lambda-provided AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the environment)',
    );
  }
  return { accessKeyId, secretAccessKey, sessionToken: env['AWS_SESSION_TOKEN'] };
}

function stringAtPath(value: unknown, path: readonly string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : undefined;
}
