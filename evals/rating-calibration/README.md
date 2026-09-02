# Rating-Calibration Eval Harness

Measures how well the AI rating-suggester agrees with a **teacher's** hand-
assigned "gold" 1–7 PCM rating. This is the calibration dataset described in
[`review/assessment-and-goals-plan.html`](../../review/assessment-and-goals-plan.html)
§11: the teacher's committed PCM ratings vs. the AI's suggested ratings, per
scholar × reporting period × dimension.

## What it does

```
synthetic evidence binders ──► rating-suggester (Opus) ──► agreement scorer ──► report.md
   │ (fixtures.ts, hand-written                │                  │
   │  binder text + teacher gold)              │                  ├─ mean absolute error (1–7)
   └─ 5 fixtures spanning the whole            │                  └─ within-1-band / exact-band hit rate
      rubric range (Emerging→Exemplary),       │
      incl. one deliberately UNEVEN profile    └─ mirrors convex/courseNarrativeAI.ts's
                                                   suggestRatings prompt + RATING_TOOL schema
```

- **Production fidelity, as far as it can go:** `convex/courseNarrativeAI.ts`
  is a `"use node"` Convex action, so it can't be imported into a plain
  script. [`lib/suggestRatings.ts`](lib/suggestRatings.ts) is a byte-for-byte
  copy of its system prompt + `RATING_TOOL` schema — but it **imports, rather
  than copies**, the one thing that matters most for calibration:
  `convex/lib/pcm.ts`'s `RUBRIC_BANDS` and `PCM_META` (the actual rubric text
  + dimension descriptions the model is rated against). If the rubric changes,
  this harness picks it up automatically; if the prompt/schema in
  `courseNarrativeAI.ts` changes, `lib/suggestRatings.ts` needs a manual
  update to stay in sync (there's no way around that for a `"use node"`
  action — see the comment at the top of that file).
- **Fixtures** ([`fixtures.ts`](fixtures.ts)): 5 hand-written "evidence
  binder" summaries — compact text in the same shape
  `courseNarrativeAI.ts`'s (unexported) `summarizeBinder()` renders for the
  model — each carrying a `goldRatings` block: the TEACHER's own 1–7 rating
  per PCM dimension. They span the whole rubric range (`emerging-a` through
  `exemplary-d`) plus one deliberately **uneven** profile (`mixed-e`: strong
  core/connections, thin practice/identity) to check that the suggester
  tracks the real per-dimension evidence rather than an overall "vibe."
- **Agreement scorer** ([`lib/judge.ts`](lib/judge.ts)): NOT an LLM judge —
  a deterministic comparison of the AI's rating against the teacher's gold
  rating, using the same `RUBRIC_BANDS` / `bandForRating` the app itself
  rates against (`convex/lib/pcm.ts`). Named `judge.ts` to mirror
  `evals/observer/lib/judge.ts`'s role in a harness (the module that scores
  a run), not because it makes a model call.

## Run it

```bash
# Default: Opus (matches prod), 1 run per fixture
./evals/rating-calibration/run.sh

# A few samples per fixture for stabler numbers (LLMs vary)
./evals/rating-calibration/run.sh --runs 3

# Compare a cheaper model against the teacher gold
./evals/rating-calibration/run.sh --model sonnet

# Custom output dir (keep before/after runs side by side)
./evals/rating-calibration/run.sh --out evals/rating-calibration/out/after-rubric-tweak
```

`run.sh` sources `ANTHROPIC_API_KEY` from the parent `CLAUDE.md` if not
already exported (same pattern as
[`evals/observer/run.sh`](../observer/run.sh)). To call the runner directly:
`ANTHROPIC_API_KEY=... npx tsx evals/rating-calibration/run.ts [flags]`.

If `ANTHROPIC_API_KEY` isn't set, the script prints a message and exits 0 —
this harness makes real Anthropic calls, it doesn't mock them.

### Flags

| Flag | Default | Meaning |
|---|---|---|
| `--model m` | `opus` | suggester model (`sonnet`/`opus`/`haiku` or a raw model id) — defaults to `MODELS.OPUS`, matching production |
| `--runs N` | 1 | samples per fixture (LLMs vary — bump for stabler numbers, at Opus cost) |
| `--concurrency N` | 4 | parallel API calls |
| `--out DIR` | `out/` | output directory |

## Output (in `--out`, gitignored)

- `report.md` — headline mean absolute error + within-1-band / exact-band hit
  rate across all fixtures, a per-dimension breakdown, and per-fixture detail
  (gold vs. AI per dimension, plus the AI's rationale).
- `runs.json` — every fixture's raw suggestion + scored agreement.

## Files

| File | Purpose |
|---|---|
| `fixtures.ts` | 5 hand-written evidence-binder fixtures + teacher gold ratings. |
| `lib/suggestRatings.ts` | Calls the mirrored `suggest_ratings` prompt/schema against a binder fixture. |
| `lib/judge.ts` | Deterministic agreement scorer — MAE + within-1-band / exact-band hit rate, using `convex/lib/pcm.ts`'s rubric. |
| `run.ts` / `run.sh` | The orchestrator + shell wrapper. |

## Why mean absolute error AND within-1-band (not just one)

A raw 1–7 MAE can hide a `bandForRating` disagreement even when it looks
small numerically (e.g. gold=3 "Developing", AI=4 "Proficient" is only 1
point off but a full band apart — the difference a teacher would actually
notice reading the calibration view). The within-1-band rate reports
agreement in the unit that matters to a teacher (the labeled band), while
MAE keeps the raw-number signal for tracking incremental drift.
