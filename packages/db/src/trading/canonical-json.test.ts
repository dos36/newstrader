import { describe, expect, it } from 'vitest';

import { canonicalJson, configHash } from './canonical-json.js';

describe('canonicalJson', () => {
  it('sorts object keys recursively so key order never changes the hash', () => {
    const a = {
      gates: { minConfidence: 0.6, allowShorts: false },
      sizing: { atrLookbackDays: 14 },
    };
    const b = {
      sizing: { atrLookbackDays: 14 },
      gates: { allowShorts: false, minConfidence: 0.6 },
    };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(configHash(a)).toBe(configHash(b));
    expect(canonicalJson(a)).toBe(
      '{"gates":{"allowShorts":false,"minConfidence":0.6},"sizing":{"atrLookbackDays":14}}',
    );
  });

  it('keeps array order (order is semantic, e.g. eventTypeWhitelist)', () => {
    expect(canonicalJson({ list: ['b', 'a'] })).toBe('{"list":["b","a"]}');
    expect(configHash({ list: ['b', 'a'] })).not.toBe(configHash({ list: ['a', 'b'] }));
  });

  it('handles primitives, null, and nested arrays of objects', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(3.5)).toBe('3.5');
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson([{ b: 1, a: [true, null] }])).toBe('[{"a":[true,null],"b":1}]');
  });

  it('drops undefined object values (matches JSON.stringify / jsonb round-trips)', () => {
    expect(canonicalJson({ a: 1, gone: undefined })).toBe('{"a":1}');
    expect(configHash({ a: 1, gone: undefined })).toBe(configHash({ a: 1 }));
  });

  it('a changed value changes the hash', () => {
    expect(configHash({ a: 1 })).not.toBe(configHash({ a: 2 }));
  });
});
