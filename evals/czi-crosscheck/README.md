# CZI cross-check (`evals/czi-crosscheck`)

An **external, second-opinion lens** on tutor turns, built from
[Learning Commons](https://learningcommons.org) (Chan Zuckerberg Initiative)
open evaluators. It is deliberately **separate** from our own Opus tutor-quality
judge (`evals/tutor-quality`): different authorship, different scoring
philosophy (binary learning-science criteria vs our 1–5 rubric), so it's a
cross-**provenance** sanity check, never a merge gate.

Grew out of the spike write-up in
[`review/czi-learning-commons-evaluation.html`](../../review/czi-learning-commons-evaluation.html)
(§10 "do-now"). This module ships items (a) + (b); item (c) — a math
standards-alignment Preflight — is a deferred follow-up (see below).

## Two lenses

1. **Coaching answer-dump detector** — the vendored `manageable` and
   `acknowledges-strength` productive-coaching criteria. The load-bearing signal
   is **`manageable = 0`**: the tutor gave too much at once (a long list, many
   suggestions), i.e. our **cognitive-offloading / answer-dump** failure mode.
   `acknowledges-strength = 0` means the tutor named no genuine strength in the
   scholar's work before pushing on.

2. **Grade-level calibration gauge** — the vendored
   `grade-level-appropriateness` rubric measures the grade **band** of the
   tutor's own language; we compare it to the scholar's stated reading level
   (`drift = bandFloor − readingLevel`). Because gifted learners work **above**
   grade level, drift is **reported**, and only *flagged* past a threshold
   (default +2) — the case that matters is a **low-reading-level** scholar being
   pitched too high.

## Design choices

- **Vendored prompts, not the SDK.** We copy the specific rubric prompt bundles
  (`rubrics/`) rather than depend on `@learning-commons/evaluators`. The SDK
  defaults telemetry **on** (phones home to `api.learningcommons.org`) and pulls
  in the graph-coupled math evaluator. Vendoring is telemetry-proof by
  construction and adds **no new dependency**. Provenance + licences:
  [`ATTRIBUTION.md`](./ATTRIBUTION.md); checksums: `rubrics/MANIFEST.json`.
- **Runs on OUR models, telemetry-free.** The lens reuses the tutor-quality
  judge seam (`../tutor-quality/lib/judgeEngine` → `runStructuredJudge`), so it
  honours `JUDGE_ENGINE` (`anthropic` | `copilot`) and `JUDGE_MODEL`
  (`convex/lib/models.ts`). Nothing leaves our infra.
- **The vendored JSON output schema drives a forced tool.** `lib/rubrics.ts`
  dereferences the schema's local `$ref`s inline (the Anthropic tool API doesn't
  follow `$ref`) and hands it to the judge as the tool contract.

## Running (the live pass — NOT in CI)

```bash
# All synthetic fixtures:
./evals/czi-crosscheck/run.sh

# One fixture / a saved (redacted) transcript file of TutorCase objects:
./evals/czi-crosscheck/run.sh --case fixture:answer-dump
./evals/czi-crosscheck/run.sh --transcripts /path/to/redacted-transcripts.json

# Coaching only (skip the grade-level calls):
./evals/czi-crosscheck/run.sh --no-grade-level
```

Writes `out/{report.md,runs.json}` (git-ignored). `run.sh` supplies Node 22 +
`ANTHROPIC_API_KEY`. Transcripts consumed are the SAME `TutorCase` shape the
tutor-quality harness uses, so a transcript pulled for one feeds the other.

## What runs in CI

Only the **offline** tests in `__tests__/` (`pnpm test`, no network):

- `rubrics.test.ts` — the vendored files match their pinned sha256
  (drift guard), each schema dereferences to a flat, `$ref`-free tool schema,
  and placeholder assembly is exhaustive.
- `lens.test.ts` — the pure scoring/mapping: `manageable=0 ⇒ answer-dump
  concern`, band-vs-reading-level drift, and turn pairing.

The live LLM pass (`run.ts`) is manual, like `evals/tutor-quality/run.ts`.

## Caveats (read before trusting a score)

- **Fit is imperfect.** These coaching rubrics were written to grade **written
  teacher feedback on student writing**, not conversational Socratic tutoring.
  `acknowledges-strength` in particular can read a good withholding question as
  "no strength named". Treat `manageable` as the high-signal dimension.
- **Model swap.** CZI's reference model is `gpt-5.4`; we run our `JUDGE_MODEL`.
  Scores are indicative, not identical to CZI's published behaviour.
- **Single-turn.** Each turn is judged with its immediate predecessor, without
  full conversation history — so "anchored"-style provenance checks are out of
  scope here (hence we ship only `manageable` + `acknowledges-strength`).

## Follow-up (deferred)

- **(c) Math standards-alignment Preflight.** CZI's math evaluator needs their
  Knowledge Graph (private beta). The spike shimmed it and mapped CZI learning
  components ~1:1 onto our `knowledgeNodes`; turning that into a curriculum
  **Preflight** ("does this activity actually measure its standard?") is a
  product surface, not a tutor eval, so it's tracked separately.
