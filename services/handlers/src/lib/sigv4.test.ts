import { describe, expect, it } from 'vitest';
import { signRequest } from './sigv4.js';

/**
 * Vectors from the official AWS Signature V4 test suite (as vendored in
 * botocore: tests/unit/auth/aws4_testsuite/*), fetched and pinned 2026-07-10.
 * Shared fixture: credential AKIDEXAMPLE, region us-east-1, service "service",
 * time 2015-08-30T12:36:00Z, host example.amazonaws.com.
 */

const CREDENTIALS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};
const DATE = new Date('2015-08-30T12:36:00Z');
const BASE = {
  service: 'service',
  region: 'us-east-1',
  credentials: CREDENTIALS,
  date: DATE,
};

describe('signRequest (AWS SigV4 test suite vectors)', () => {
  it('get-vanilla', () => {
    const headers = signRequest({
      ...BASE,
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      body: '',
    });
    expect(headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
    expect(headers['x-amz-date']).toBe('20150830T123600Z');
    expect(headers['host']).toBe('example.amazonaws.com');
  });

  it('post-header-key-sort (extra header is lower-cased and sorted into the signature)', () => {
    const headers = signRequest({
      ...BASE,
      method: 'POST',
      url: new URL('https://example.amazonaws.com/'),
      headers: { 'My-Header1': 'value1' },
      body: '',
    });
    expect(headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;my-header1;x-amz-date, Signature=c5410059b04c1ee005303aed430f6e6645f61f4dc9e1461ec8f8916fdf18852c',
    );
  });

  it('post-vanilla-query (query string is canonicalized)', () => {
    const headers = signRequest({
      ...BASE,
      method: 'POST',
      url: new URL('https://example.amazonaws.com/?Param1=value1'),
      body: '',
    });
    expect(headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, Signature=28038455d6de14eafc1f9222cf5aa6f1a96197d7deb8263271d420d138af7f11',
    );
  });

  it('post-x-www-form-urlencoded (body is hashed; content-type is signed)', () => {
    const headers = signRequest({
      ...BASE,
      method: 'POST',
      url: new URL('https://example.amazonaws.com/'),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'Param1=value1',
    });
    expect(headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=content-type;host;x-amz-date, Signature=ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a',
    );
  });

  it('includes the session token as a signed header when present', () => {
    const headers = signRequest({
      ...BASE,
      credentials: { ...CREDENTIALS, sessionToken: 'THE-TOKEN' },
      method: 'GET',
      url: new URL('https://example.amazonaws.com/'),
      body: '',
    });
    expect(headers['x-amz-security-token']).toBe('THE-TOKEN');
    expect(headers['authorization']).toContain(
      'SignedHeaders=host;x-amz-date;x-amz-security-token,',
    );
  });
});
