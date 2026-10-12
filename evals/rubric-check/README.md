# rubric-check eval

Measures **`checkRubric`** ([`convex/deliverables.ts`](../../convex/deliverables.ts))
— the "Check my work" / Submit-and-check batch judge. It sees the rubric and
the raw submitted document and **no transcript at all**, which makes it the
least-context grading surface in the product and the one most likely to
misread a young scholar's writing. Until this eval, nothing evaluated it:
[`evals/rubric-integrity`](../rubric-integrity) reaches only the tutor's
mid-conversation `update_rubric_score` tool and its README explicitly puts
`checkRubric` out of scope.

## What it actually drives

The point of this harness is that it grades through **production's own code
path**, not a paraphrase of it (the repo's standing lesson: an ad-hoc probe
that differs from the shipped path manufactures phantom results).

| Piece | Where it comes from |
|---|---|
| System prompt | `buildRubricSystemPrompt` — [`convex/lib/rubricCheckPrompt.ts`](../../convex/lib/rubricCheckPrompt.ts), the exact function `checkRubric` calls |
| User turn (activity framing, reading-level calibration line, numbered `[id]` rubric, submission) | `buildRubricCheckUserMessage` — same module, same assembly |
| Rubric rendering | production's `renderCriteriaForRubricCheck` |
| Tool schema | `RUBRIC_TOOL` imported from `convex/deliverables.ts` — literally the object production binds |
| Model + call shape | `MODELS.SONNET`, `max_tokens: 2048`, forced `tool_choice` — same as the action |
| Verdict sanitization | production's shared `scoreRubricVerdicts` |

Those two prompt builders were **extracted verbatim** out of the `checkRubric`
handler so the eval could import them; the system-prompt string was verified
byte-identical to the pre-extraction version, and every literal in the user
message is unchanged. Nothing about how production grades changed.

Deliberately not reproduced: the Convex plumbing around the call (deliverable
lookup, usage metering, writing the result back). None of it reaches the model.

`scoreRubricVerdicts` stands in for the near-duplicate sanitizer written inline
in the handler. The two agree on every **level** (drop unknown ids, first
duplicate wins, omitted criterion → `not`) and differ only in the placeholder
note text and array order, neither of which this eval reads.

## Two layers

1. **Pure scorer** (`lib/scoreRubricCheck.ts`) — no model calls, no I/O.
   Unit-tested in `__tests__/` and runs in `pnpm test`.
2. **Live runner** (`run.ts` + `lib/runCheckRubric.ts` + `lib/runTutorArm.ts`) —
   grades each fixture `--reps` times against the real model.

Same split as `evals/rubric-integrity`.

## The tutor-path comparison arm

Fixtures marked `compareTutorPath` are **also** graded through the tutor's
`update_rubric_score` path on the identical document, by reusing
[`evals/rubric-integrity/lib/runRubricTutor.ts`](../rubric-integrity/lib/runRubricTutor.ts)'s
`generateTutorTurn` rather than forking a second copy of the tutor side. (It
does not use that eval's `lib/driver.ts` — this arm needs one grading turn,
not a scripted session.) The conversation is a single neutral scholar turn
handing the document over, on purpose: anything more would leak evidence the
document itself does not carry, and holding the document constant is the whole
point.

> ⚠️ **Known asymmetry, load-bearing when reading the numbers.** That
> harness's `assembleTutorPrompt` passes `readingLevel: null` to
> `buildSystemPrompt`, so the tutor arm always grades with **no reading-level
> line**. Compare it against the `*-no-reading-level` fixtures for
> apples-to-apples. That is why this eval ships a no-reading-level twin of
> both the invented-spelling case and its control.

## Repetition and noise

Every fixture is graded `--reps` times (default 5). A three-point judged scale
is noisy, and one sample is an anecdote — the report gives `n`, mean,
min–max and population sd for each fixture's focus criterion, plus the raw
level histogram. Expectations are stated as **allowed level sets**, not point
predictions, because the honest claim for most fixtures is a floor
("must not be scored `not`") or a ceiling ("must not be scored `full`").

The gate is the **focus-criterion** pass rate only. A grader that emits a
malformed `overall` is reported separately and loudly, so a schema defect can
never be mistaken for a misreading of a scholar's writing.

## Run it

```bash
# Live — real Anthropic calls. Exits non-zero if any fixture's focus-criterion
# pass rate falls below --min-pass-rate (default 0.5).
ANTHROPIC_API_KEY=... ./evals/rubric-check/run.sh

ANTHROPIC_API_KEY=... ./evals/rubric-check/run.sh --reps 8 --case invented-spelling
ANTHROPIC_API_KEY=... ./evals/rubric-check/run.sh --no-tutor    # skip the comparison arm

./evals/rubric-check/run.sh --offline    # wiring only, no key, never gates
```

`--offline` uses a deterministic always-full stub. It exercises the pipeline
and is **not** a behavior claim — note that it correctly *fails* the two
generosity guards, which is the cheapest proof those guards bite.

Use the wrapper rather than bare `npx tsx`: it sets
`NODE_OPTIONS=--conditions=import`, needed because the import chain reaches
`@convex-dev/auth/server`, which only publishes an `import` exports condition.

Override the model with `CHECK_MODEL` (defaults to `MODELS.SONNET`);
`TUTOR_MODEL` still controls the comparison arm.

No API key in your shell? The worktree's own dev deployment has one:
`export ANTHROPIC_API_KEY="$(npx convex env get ANTHROPIC_API_KEY)"`.

## Output

- `out/report.md` — per-fixture spread table, the checkRubric-vs-tutor
  comparison, the `overall`-field defect table, and for each fixture the
  submission, the exact prompt sent, every rep's grader note, and the
  scholar-facing feedback.
- `out/runs.json` — every grading, raw. `out/judgments.json` — the aggregates.

`out/` is gitignored (regenerate on demand).

## Fixtures

All seven share one activity ("Bug Watch") and one three-criterion rubric —
`colors`, `prediction`, `two-sentences` — so the only variable across rows is
the submitted document and the reading level. The focus criterion is
`prediction` throughout. Every identity is fictional; submission strings are
unattributed fixture text.

| Fixture | reading level | Expectation on `prediction` | Guards |
|---|---|---|---|
| `invented-spelling` | `1` | `half` or `full` | **The motivating case.** A document whose final clause is a reasoned prediction written in invented spelling, stopping one word short of its noun. Scoring it `not` ("not met at all") is the misjudgement under test — the scholar *did* state a prediction. `half` is defensible; `not` is not. |
| `invented-spelling-no-reading-level` | unset | `half` or `full` | Same document with `users.readingLevel` unset — a very common production state, and the condition that drops the CALIBRATE line from the prompt entirely. Also the apples-to-apples comparator for the tutor arm. |
| `conventional-spelling-twin` | `1` | `half` or `full` | **Control.** Identical content and the identical missing noun, conventional spelling and punctuation. If this scores higher than the invented-spelling row, the harness has isolated a *spelling* penalty rather than a content judgement — and spelling is not what `prediction` asks for. |
| `conventional-spelling-twin-no-reading-level` | unset | `half` or `full` | The control's no-reading-level twin, so the spelling contrast reads at both conditions and against the tutor arm. |
| `missing-prediction` | `1` | `not` or `half`, overall not `full` | **Generosity guard, and the row that makes the invented-spelling result mean anything.** Same invented spelling, same length, same voice — but genuinely no prediction anywhere in it. A grader that credits this is not reading *through* invented spelling, it is just being lenient. |
| `nonsubmission-claim` | `1` | `not`, overall `not` | **Generosity guard.** A claim of having done the work rather than the work. Nothing here can earn a criterion. |
| `plainly-complete` | `3` | `full`, overall `full` | The plainly-complete case. If this does not pass, the grader or the harness is broken and no other row means anything. |

## Files

| File | Purpose |
|---|---|
| `run.ts` | Orchestrator: loads fixtures, fans every (fixture × rep × arm) grading through one pool, aggregates, writes the report, gates. |
| `lib/runCheckRubric.ts` | The `checkRubric` arm — production's prompt builders + tool + model. |
| `lib/runTutorArm.ts` | The comparison arm — the same document through `update_rubric_score`. |
| `lib/scoreRubricCheck.ts` | The **pure** scorer + spread/histogram helpers. No model calls. |
| `lib/types.ts` | Fixture + observation shapes. |
| `fixtures/*.json` | The seven scenarios above. |
| `__tests__/scoreRubricCheck.test.ts` | Unit tests for the pure layer (run in `pnpm test`). |
