import { describe, expect, it } from 'vitest';

import {
  coalesceWindows,
  EVENT_WINDOW_AFTER_MS,
  EVENT_WINDOW_BEFORE_MS,
  eventWindow,
  type WindowMs,
} from './windows.js';

const w = (fromMs: number, toMs: number): WindowMs => ({ fromMs, toMs });

describe('eventWindow', () => {
  it('spans anchor − 72 h to anchor + 5 d (pre-window reaches a prior session close across long weekends)', () => {
    const anchor = new Date('2026-07-06T14:30:00.000Z');
    expect(eventWindow(anchor)).toEqual({
      fromMs: anchor.getTime() - 72 * 60 * 60 * 1000,
      toMs: anchor.getTime() + 5 * 24 * 60 * 60 * 1000,
    });
    expect(EVENT_WINDOW_BEFORE_MS).toBe(259_200_000);
    expect(EVENT_WINDOW_AFTER_MS).toBe(432_000_000);
  });
});

describe('coalesceWindows', () => {
  it('returns an empty list for no windows', () => {
    expect(coalesceWindows([])).toEqual([]);
  });

  it('keeps disjoint windows separate, sorted ascending', () => {
    expect(coalesceWindows([w(100, 200), w(400, 500)])).toEqual([w(100, 200), w(400, 500)]);
    expect(coalesceWindows([w(400, 500), w(100, 200)])).toEqual([w(100, 200), w(400, 500)]);
  });

  it('merges overlapping windows', () => {
    expect(coalesceWindows([w(100, 300), w(200, 500)])).toEqual([w(100, 500)]);
  });

  it('merges touching windows — inclusive bar ranges would double-fetch the boundary', () => {
    expect(coalesceWindows([w(100, 200), w(200, 300)])).toEqual([w(100, 300)]);
  });

  it('merges a window fully contained in another without shrinking the outer one', () => {
    expect(coalesceWindows([w(100, 1000), w(300, 400)])).toEqual([w(100, 1000)]);
    expect(coalesceWindows([w(300, 400), w(100, 1000)])).toEqual([w(100, 1000)]);
  });

  it('chains transitively: A∪B∪C merge even when only neighbors overlap', () => {
    expect(coalesceWindows([w(500, 700), w(100, 350), w(300, 550)])).toEqual([w(100, 700)]);
  });

  it('handles the realistic burst shape: clustered anchors merge, an old anchor stays apart', () => {
    const day = 86_400_000;
    const t0 = Date.parse('2026-07-06T14:00:00Z');
    const anchors = [
      new Date(t0),
      new Date(t0 + 2 * 60 * 60 * 1000), // 2 h later — inside the first window
      new Date(t0 + 3 * day), // 3 d later — still inside anchor+5d
      new Date(t0 - 30 * day), // a month earlier — disjoint
    ];
    const merged = coalesceWindows(anchors.map(eventWindow));
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual(eventWindow(new Date(t0 - 30 * day)));
    expect(merged[1]).toEqual({
      fromMs: t0 - EVENT_WINDOW_BEFORE_MS,
      toMs: t0 + 3 * day + EVENT_WINDOW_AFTER_MS,
    });
  });

  it('does not mutate its input', () => {
    const input = [w(200, 500), w(100, 300)];
    const snapshot = input.map((x) => ({ ...x }));
    coalesceWindows(input);
    expect(input).toEqual(snapshot);
  });

  it('collapses duplicate windows (same anchor from two clusters)', () => {
    expect(coalesceWindows([w(100, 200), w(100, 200)])).toEqual([w(100, 200)]);
  });

  it('treats zero-length windows correctly', () => {
    expect(coalesceWindows([w(100, 100), w(100, 200)])).toEqual([w(100, 200)]);
    expect(coalesceWindows([w(100, 100), w(300, 300)])).toEqual([w(100, 100), w(300, 300)]);
  });

  it('throws on an inverted window instead of silently fixing caller corruption', () => {
    expect(() => coalesceWindows([w(200, 100)])).toThrow(/inverted/);
  });
});
