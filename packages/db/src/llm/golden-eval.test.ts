/**
 * Golden-set eval — the ONLY test that calls the real Anthropic API, and the
 * mandatory manual gate for ANY prompt change (there is no CI in this repo;
 * the roadmap's "golden set in CI" lands when CI does).
 *
 * Opt-in: RUN_GOLDEN_EVAL=1 + ANTHROPIC_API_KEY set. Cost ≈ 15 calls ≈ $0.15.
 *
 * API TRANSPORT ONLY, deliberately. The dev CLI transport (cli-client.ts) can
 * set neither effort nor max_tokens and appends the prompt to a harness prompt
 * this repo does not version, so its accuracies would not be comparable to any
 * baseline entry — which is the one thing this file exists to compare.
 *
 *   RUN_GOLDEN_EVAL=1 pnpm vitest run golden-eval
 *
 * Workflow for a prompt change:
 *   1. Mint the new prompt version in core/interpret/registry.ts (never edit
 *      a published version — the hash-pin test enforces this).
 *   2. Run this eval; compare the logged per-field accuracy against the
 *      previous version's entry in __fixtures__/golden-baseline.json.
 *   3. If not worse, record the new version's accuracies in the baseline file
 *      (a reviewed, deliberate commit — that file is the evidence).
 *
 * Grading: only the fields present in a row's `expected` are graded — rows
 * deliberately leave ambiguous fields ungraded (see GOLDEN-README.md).
 * Content-level failures (refusal/parse) count as a miss on every graded
 * field of that row.
 */
import { readFileSync } from 'node:fs';

import { buildUserPrompt, CURRENT_PROMPT_VERSION, getPromptDefinition } from '@newstrader/core';
import type { InterpretContext } from '@newstrader/core';
import { describe, expect, it } from 'vitest';

import { anthropicLlmClient } from './anthropic-client.js';

interface GoldenRow {
  id: string;
  reviewed: boolean;
  note: string;
  context: InterpretContext;
  expected: {
    event_type?: string;
    direction?: string;
    already_expected?: boolean;
  };
}

const GRADED_FIELDS = ['event_type', 'direction', 'already_expected'] as const;

/** Accuracy may drop this much vs the recorded baseline before the eval fails. */
const REGRESSION_TOLERANCE = 0.1;

const optedIn =
  process.env['RUN_GOLDEN_EVAL'] === '1' &&
  (process.env['ANTHROPIC_API_KEY'] ?? '').trim().length > 0;

describe.skipIf(!optedIn)('golden-set eval (REAL API, opt-in)', () => {
  it(`prompt ${CURRENT_PROMPT_VERSION}: per-field accuracy vs recorded baseline`, async () => {
    const rows = readFileSync(new URL('./__fixtures__/golden-set.jsonl', import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as GoldenRow);
    expect(rows.length).toBeGreaterThan(0);

    const prompt = getPromptDefinition(CURRENT_PROMPT_VERSION);
    const client = anthropicLlmClient(process.env);

    const totals: Record<string, { correct: number; graded: number }> = {};
    const misses: Array<{ id: string; field: string; expected: unknown; got: unknown }> = [];

    // Sequential on purpose: 15 calls, kind to rate limits, order-stable logs.
    for (const row of rows) {
      const outcome = await client.interpret({
        systemPrompt: prompt.systemPrompt,
        userPrompt: buildUserPrompt(row.context),
        modelId: prompt.modelId,
        maxTokens: prompt.maxTokens,
        effort: prompt.effort,
      });

      for (const field of GRADED_FIELDS) {
        const expected = row.expected[field];
        if (expected === undefined) continue;
        const bucket = (totals[field] ??= { correct: 0, graded: 0 });
        bucket.graded += 1;
        const got =
          outcome.interpretation === null ? '<content failure>' : outcome.interpretation[field];
        if (got === expected) bucket.correct += 1;
        else misses.push({ id: row.id, field, expected, got });
      }
    }

    const accuracy: Record<string, number> = {};
    for (const [field, bucket] of Object.entries(totals)) {
      accuracy[field] = bucket.correct / bucket.graded;
    }
    console.log(
      JSON.stringify(
        { msg: 'golden_eval', promptVersion: CURRENT_PROMPT_VERSION, accuracy, totals, misses },
        null,
        2,
      ),
    );

    const baselines = JSON.parse(
      readFileSync(new URL('./__fixtures__/golden-baseline.json', import.meta.url), 'utf8'),
    ) as Record<string, Record<string, number>>;
    const baseline = baselines[CURRENT_PROMPT_VERSION];
    if (baseline === undefined) {
      console.warn(
        `[golden-eval] no baseline recorded for ${CURRENT_PROMPT_VERSION} — review the ` +
          'accuracies above and add them to __fixtures__/golden-baseline.json in a ' +
          'deliberate commit.',
      );
      return;
    }
    for (const [field, floor] of Object.entries(baseline)) {
      const measured = accuracy[field];
      expect(
        measured,
        `${field}: no graded rows but a baseline exists — golden set shrank?`,
      ).toBeDefined();
      expect(
        measured as number,
        `${field} regressed: ${String(measured)} vs baseline ${floor}`,
      ).toBeGreaterThanOrEqual(floor - REGRESSION_TOLERANCE);
    }
  }, 600_000);
});
