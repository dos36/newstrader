import { afterEach, describe, expect, it } from 'vitest';
import type { FetchLike } from './aws-api.js';
import { AwsJsonError } from './aws-api.js';
import { optionalSsmParameter } from './boot.js';

/** Fake Lambda runtime env — never process.env, tests stay hermetic (mirrors aws-api.test.ts). */
const ENV: NodeJS.ProcessEnv = {
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};

function fakeFetch(status: number, payload: unknown): FetchLike {
  return async () => new Response(JSON.stringify(payload), { status });
}

/**
 * optionalSsmParameter reads the parameter NAME from a real process.env var
 * (by design — see boot.ts); these tests stash/restore it around each case
 * rather than injecting it, consistent with requireEnv's own env contract.
 */
describe('optionalSsmParameter', () => {
  const TEST_ENV_NAME = 'TEST_OPTIONAL_SSM_PARAM_NAME';

  afterEach(() => {
    delete process.env[TEST_ENV_NAME];
  });

  it('returns undefined when the naming env var is unset', async () => {
    expect(await optionalSsmParameter(TEST_ENV_NAME)).toBeUndefined();
  });

  it('returns undefined when the naming env var is blank', async () => {
    process.env[TEST_ENV_NAME] = '   ';
    expect(await optionalSsmParameter(TEST_ENV_NAME)).toBeUndefined();
  });

  it('swallows ParameterNotFound — the operator secret is not provisioned yet', async () => {
    process.env[TEST_ENV_NAME] = '/newstrader/not-provisioned';
    const value = await optionalSsmParameter(TEST_ENV_NAME, {
      env: ENV,
      fetchImpl: fakeFetch(400, { __type: 'ParameterNotFound', message: 'not found' }),
    });
    expect(value).toBeUndefined();
  });

  it('rethrows AccessDenied instead of silently returning undefined', async () => {
    process.env[TEST_ENV_NAME] = '/newstrader/no-permission';
    await expect(
      optionalSsmParameter(TEST_ENV_NAME, {
        env: ENV,
        fetchImpl: fakeFetch(400, { __type: 'AccessDeniedException', message: 'nope' }),
      }),
    ).rejects.toThrow(AwsJsonError);
  });

  it('rethrows a throttling error instead of silently returning undefined', async () => {
    process.env[TEST_ENV_NAME] = '/newstrader/throttled';
    await expect(
      optionalSsmParameter(TEST_ENV_NAME, {
        env: ENV,
        fetchImpl: fakeFetch(400, { __type: 'ThrottlingException', message: 'slow down' }),
      }),
    ).rejects.toThrow(AwsJsonError);
  });

  it('returns the value on success', async () => {
    process.env[TEST_ENV_NAME] = '/newstrader/present';
    const value = await optionalSsmParameter(TEST_ENV_NAME, {
      env: ENV,
      fetchImpl: fakeFetch(200, { Parameter: { Value: 'the-secret-value' } }),
    });
    expect(value).toBe('the-secret-value');
  });
});
