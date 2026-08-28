# Golden set — hand-labeled interpretation ground truth

`golden-set.jsonl`: one JSON row per line —
`{id, reviewed, note, context, expected}` where `context` is exactly the
`InterpretContext` the sweep would build (real clusters, real ledes, price
context deliberately null so grading is text-only and deterministic), and
`expected` holds ONLY the fields worth grading for that row:

- `event_type` — graded when one taxonomy value is clearly right.
- `direction` — graded when a careful human would not argue.
- `already_expected` — graded when the scheduled/anticipated status is clear.

Leaving a field out is deliberate: an ambiguous label graded anyway measures
label noise, not prompt quality. Mis-link rows (`event_type: "other"`,
`direction: "neutral"`) are load-bearing — they test the escape hatch that
keeps bad resolver links from becoming confident signals.

## Status: STARTER SET — needs review

The initial 15 rows were machine-drafted from live clusters on 2026-08-09 and
are flagged `reviewed: false`. **Oleh: review each label, fix what's wrong,
flip `reviewed` to true.** The roadmap target is ~100 hand-labeled rows;
append new lines as interesting clusters appear (the generation recipe lives
in the M2 build notes — context comes from `loadClusterItemsForPrompt` +
`extractLede`).

## Running

```
RUN_GOLDEN_EVAL=1 pnpm vitest run golden-eval
```

Needs `ANTHROPIC_API_KEY`; ~15 real calls ≈ $0.15. Baseline discipline is
described in golden-eval.test.ts — record accuracies per prompt version in
`golden-baseline.json` only from reviewed runs.
