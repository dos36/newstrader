import { describe, expect, it } from 'vitest';
import { AwsJsonError, getSecretString, getSsmParameter } from './aws-api.js';
import type { FetchLike } from './aws-api.js';

/** Fake Lambda runtime env — never process.env, tests stay hermetic. */
const ENV: NodeJS.ProcessEnv = {
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  AWS_SESSION_TOKEN: 'the-session-token',
};

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(status: number, payload: unknown, captured: Captured[]): FetchLike {
  return async (url, init) => {
    captured.push({ url, init });
    return new Response(JSON.stringify(payload), { status });
  };
}

describe('getSsmParameter', () => {
  it('POSTs a signed awsJson-1.1 GetParameter call and returns Parameter.Value', async () => {
    const captured: Captured[] = [];
    const value = await getSsmParameter('/newstrader/edgar-user-agent', {
      env: ENV,
      fetchImpl: fakeFetch(
        200,
        { Parameter: { Value: 'NewsTrader bot me@example.com' } },
        captured,
      ),
    });

    expect(value).toBe('NewsTrader bot me@example.com');
    const request = captured[0];
    expect(request?.url).toBe('https://ssm.us-east-1.amazonaws.com/');
    expect(request?.init?.method).toBe('POST');
    expect(request?.init?.body).toBe(
      JSON.stringify({ Name: '/newstrader/edgar-user-agent', WithDecryption: true }),
    );

    const headers = request?.init?.headers as Record<string, string>;
    expect(headers['x-amz-target']).toBe('AmazonSSM.GetParameter');
    expect(headers['content-type']).toBe('application/x-amz-json-1.1');
    expect(headers['x-amz-security-token']).toBe('the-session-token');
    expect(headers['authorization']).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/ssm\/aws4_request, SignedHeaders=.*x-amz-target.*, Signature=[0-9a-f]{64}$/,
    );
  });

  it('throws a descriptive error when the value is missing', async () => {
    await expect(
      getSsmParameter('/missing', { env: ENV, fetchImpl: fakeFetch(200, { Parameter: {} }, []) }),
    ).rejects.toThrow(/no Parameter.Value/);
  });

  it('throws on non-2xx responses', async () => {
    await expect(
      getSsmParameter('/denied', {
        env: ENV,
        fetchImpl: fakeFetch(400, { __type: 'AccessDeniedException' }, []),
      }),
    ).rejects.toThrow(/HTTP 400/);
  });

  it('throws an AwsJsonError carrying the parsed __type', async () => {
    const error: unknown = await getSsmParameter('/denied', {
      env: ENV,
      fetchImpl: fakeFetch(400, { __type: 'AccessDeniedException' }, []),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AwsJsonError);
    expect((error as AwsJsonError).awsErrorType).toBe('AccessDeniedException');
  });

  it('parses a namespaced __type ("com.amazonaws.ssm#ParameterNotFound") down to its shorthand name', async () => {
    const error: unknown = await getSsmParameter('/missing-param', {
      env: ENV,
      fetchImpl: fakeFetch(400, { __type: 'com.amazonaws.ssm#ParameterNotFound' }, []),
    }).catch((e: unknown) => e);
    expect((error as AwsJsonError).awsErrorType).toBe('ParameterNotFound');
  });

  it('has an undefined awsErrorType when the error body is not the expected shape', async () => {
    const error: unknown = await getSsmParameter('/opaque', {
      env: ENV,
      fetchImpl: fakeFetch(500, 'internal server error', []),
    }).catch((e: unknown) => e);
    expect((error as AwsJsonError).awsErrorType).toBeUndefined();
  });
});

describe('getSecretString', () => {
  it('calls secretsmanager.GetSecretValue and returns SecretString', async () => {
    const captured: Captured[] = [];
    const secret = await getSecretString('arn:aws:secretsmanager:us-east-1:123:secret:db', {
      env: ENV,
      fetchImpl: fakeFetch(200, { SecretString: '{"username":"u"}' }, captured),
    });

    expect(secret).toBe('{"username":"u"}');
    expect(captured[0]?.url).toBe('https://secretsmanager.us-east-1.amazonaws.com/');
    const headers = captured[0]?.init?.headers as Record<string, string>;
    expect(headers['x-amz-target']).toBe('secretsmanager.GetSecretValue');
  });

  it('fails fast without a region', async () => {
    await expect(
      getSecretString('arn', {
        env: { ...ENV, AWS_REGION: undefined },
        fetchImpl: fakeFetch(200, {}, []),
      }),
    ).rejects.toThrow(/AWS_REGION/);
  });
});
