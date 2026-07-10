import { describe, expect, it } from 'vitest';
import { headlineSimilarity, jaccard, shingles } from './similarity.js';

describe('shingles', () => {
  it('produces word-level 3-shingles of the normalized text', () => {
    expect(shingles('alpha beta gamma delta epsilon')).toEqual(
      new Set(['alpha beta gamma', 'beta gamma delta', 'gamma delta epsilon']),
    );
  });

  it('is invariant to case, punctuation, and whitespace noise', () => {
    expect(shingles('Apple  BEATS -- estimates, again!')).toEqual(
      shingles('apple beats estimates again'),
    );
  });

  it('collapses texts shorter than k into a single shingle', () => {
    expect(shingles('apple earnings')).toEqual(new Set(['apple earnings']));
    expect(shingles('apple')).toEqual(new Set(['apple']));
  });

  it('returns an empty set for text that normalizes to nothing', () => {
    expect(shingles('')).toEqual(new Set());
    expect(shingles('!!! ---')).toEqual(new Set());
  });

  it('honors a custom k', () => {
    expect(shingles('alpha beta gamma delta', 2)).toEqual(
      new Set(['alpha beta', 'beta gamma', 'gamma delta']),
    );
  });
});

describe('jaccard', () => {
  it('returns 1 for identical non-empty sets', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
  });

  it('returns 0 for disjoint sets', () => {
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });

  it('computes |intersection| / |union| for partial overlap', () => {
    expect(jaccard(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))).toBe(0.5);
  });

  it('returns 0 when either set is empty (no shared evidence, incl. both empty)', () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
    expect(jaccard(new Set(['a']), new Set())).toBe(0);
  });
});

describe('headlineSimilarity', () => {
  const wire = 'Apple announces record quarterly earnings beating analyst expectations';

  it('returns 1 for the same headline up to case/punctuation noise', () => {
    expect(
      headlineSimilarity(
        wire,
        'APPLE announces record quarterly earnings — beating analyst expectations!',
      ),
    ).toBe(1);
  });

  it('scores a lightly edited echo high', () => {
    // Echo appends two words: 8 shingles vs 6, all 6 shared -> 6/8.
    const echo = `${wire} in Q3`;
    expect(headlineSimilarity(wire, echo)).toBeCloseTo(0.75, 10);
    expect(headlineSimilarity(wire, echo)).toBeGreaterThan(0.5);
  });

  it('scores unrelated headlines at ~0', () => {
    expect(headlineSimilarity(wire, 'Exxon reports oil spill at gulf coast refinery')).toBe(0);
  });

  it('is symmetric', () => {
    const other = 'Apple announces record quarterly earnings in Q3';
    expect(headlineSimilarity(wire, other)).toBe(headlineSimilarity(other, wire));
  });
});
