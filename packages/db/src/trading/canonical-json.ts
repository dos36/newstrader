import { createHash } from 'node:crypto';

/**
 * Canonical JSON for rules_versions.config_hash: recursively sorted object
 * keys so semantically identical configs hash identically regardless of key
 * insertion order. Arrays keep their order (order is semantic — e.g.
 * eventTypeWhitelist). Undefined object values are dropped, matching
 * JSON.stringify semantics, so the canonical form equals what a jsonb
 * round-trip preserves.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new Error(`canonicalJson: unserializable value of type ${typeof value}`);
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item ?? null)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

/** sha256 hex of the canonical JSON form — the rules_versions.config_hash. */
export function configHash(config: unknown): string {
  return createHash('sha256').update(canonicalJson(config)).digest('hex');
}
