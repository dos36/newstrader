import { createHash } from 'node:crypto';
import { ulid } from 'ulid';

/** Time-sortable id; no DB coordination needed. */
export function newId(): string {
  return ulid();
}

/**
 * Normalization used for content hashing and similarity input.
 * Deliberately aggressive: dedup must survive whitespace/punctuation/case noise
 * introduced by different outlets republishing the same wire text.
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}$%.]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function contentHash(headline: string, body?: string): string {
  const normalized = normalizeText(`${headline} ${body ?? ''}`);
  return createHash('sha256').update(normalized).digest('hex');
}
