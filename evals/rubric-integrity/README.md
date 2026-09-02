# rubric-integrity eval

Regression guard for **Moment F** of
[`review/experiment-detective-tutor-audit.html`](../../review/experiment-detective-tutor-audit.html):
a tutor pressed on a rubric criterion, dropped the thread when the scholar
couldn't answer, then later awarded that criterion full credit purely because
the final artifact looked textually complete. This eval drives the **real
production tutor prompt** (with the `update_rubric_score` tool bound) through
a synthetic scholar and scores whether the tightened rubric-tool guidance
actually stops that from happening silently.

## Scope — what this does and does not test

- **In scope:** the live conversational rubric-scoring tool,
  `update_rubric_score` (`rubricScoreTool` in
  [`convex/lib/tutorSessionTools.ts`](../../convex/lib/tutorSessionTools.ts)),
  which the tutor calls mid-conversation using its own judgment of the
  discussion + the submitted document. Its judgment guidance lives in
  [`convex/lib/rubricScoreTool.ts`](../../convex/lib/rubricScoreTool.ts) (the
  tool schema) and
  [`convex/sessionHelpers.ts`](../../convex/sessionHelpers.ts)'s
  `RUBRIC_TOOL_GUIDANCE` / `buildAdvanceRubricSection` (the prompt sections) —
  all three now carry the same unanswered-probe clause.
- **Deliberately out of scope:** the separate `checkRubric` /
  `report_rubric_check` action in
  [`convex/deliverables.ts`](../../convex/deliverables.ts) (the "Submit &
  check" AI judge triggered when a scholar clicks Submit). That path only ever
  sees the rubric + the artifact/photo content — it has **no access to the
  conversation transcript** — so it cannot know whether a question went
  unanswered. It is architecturally incapable of this fix, not merely
  unaddressed.
- **Document-rubric flavor only.** Moment F's real shape is a written report
  (a document/artifact rubric via `standaloneDeliverableContext`), so that's
  what this eval exercises. The tool and its guidance are shared verbatim with
  the conversation "ready to advance" flavor (`advanceRubricContext`, no
  artifact) — both carry the same clause — but this eval doesn't stand up a
  second harness for that flavor; the deterministic prompt-text tests in
  `convex/__tests__/rubricToolGuidance.test.ts` cover it instead.

## Two layers — deterministic gate + live eval

1. **Pure integrity classifier** (`lib/probeIntegrityScore.ts`) — no model
   calls, no I/O. Given what `update_rubric_score` actually returned for the
   probed criterion on a fixture's final turn (or that it was never called),
   the verdict is objective. Unit-tested in
   `__tests__/probeIntegrityScore.test.ts` and **runs in `pnpm test`**.
2. **Model-in-the-loop runner** (`run.ts` + `lib/driver.ts` +
   `lib/runRubricTutor.ts`) — produces that observation from a live
   conversation: a fixture's **scripted** scholar turns (no emergent sim —
   the scenario needs precise, reproducible control over exactly when a probe
   goes unanswered, same precedent as
   [`evals/activity-completion`](../activity-completion)'s should-withhold
   fixtures) play against the real tutor prompt + tool. The document
   (artifact) the tutor sees appears once, fully formed, at
   `artifactVisibleFromTurn` — before that turn there is no document yet, same
   as the real product (the scholar writes the report only after discussing
   it, not incrementally). This needs a real model — see below.

## Production fidelity

The tutor system prompt is assembled by the real `buildSystemPrompt` from
[`convex/sessionHelpers.ts`](../../convex/sessionHelpers.ts) with
`artifactData` (the submitted report) and `standaloneDeliverableContext` (the
rubric) set — that's what injects the exact `RUBRIC_TOOL_GUIDANCE` +
unanswered-probe clause that ships today (same discipline as
[`evals/activity-completion`](../activity-completion) and
[`evals/tutor-quality`](../tutor-quality)). The tool's name, description, and
tool-result guidance strings are imported from
[`convex/lib/rubricScoreTool.ts`](../../convex/lib/rubricScoreTool.ts) — the
same constants `convex/lib/tutorSessionTools.ts` binds — so the eval cannot
silently drift from what production actually offers the model. The verdict math (drop unknown criteria, fill omitted ones as `not`, compute
`overall`) reuses production's own `scoreRubricVerdicts`
([`convex/lib/deliverable.ts`](../../convex/lib/deliverable.ts)) rather than
reimplementing it. Tool-result feedback also imports production's document
guidance and newly-earned-flair formatter. Because document scoring does not
complete the activity, this harness requires a substantive response rather than
applying the conversation-completion wind-down rule.

## Run it

```bash
# Live eval — makes real Anthropic calls; exits non-zero if any fixture's
# verdict fails its expectation (so it can gate a prompt change locally).
ANTHROPIC_API_KEY=... ./evals/rubric-integrity/run.sh

# One fixture only
ANTHROPIC_API_KEY=... ./evals/rubric-integrity/run.sh --case hollow-complete

# Wiring/demo only — deterministic stubs, no key, never fails CI
./evals/rubric-integrity/run.sh --offline
```

`--offline` uses a deterministic stub (see `stubTutor` in
`lib/runRubricTutor.ts`) that always grants full credit once a document
exists — it exercises the whole pipeline without a key and is NOT a behavior
claim about the real tutor; only a **live** run scores the real prompt.

Use the wrapper rather than bare `npx tsx`: it sets
`NODE_OPTIONS=--conditions=import`, needed because this import chain reaches
`@convex-dev/auth/server`, which only publishes an `import` exports condition.

Override the tutor model with `TUTOR_MODEL` (defaults to `MODELS.SONNET`).

## Output

- `out/report.md` — pass count, tutor token usage, a per-fixture verdict
  table, and every full transcript.
- `out/runs.json` — every fixture's observation + score, raw.

`out/` is gitignored (regenerate on demand).

## Fixtures

Every scholar identity in these fixtures is fictional (`Nova`) — synthetic
scenarios only, no real transcripts or student data.

| Fixture | Expectation | Guards |
|---|---|---|
| `hollow-complete` | `should-not-silently-full` | The scholar never demonstrates the measurement approach in conversation — she says she doesn't know and asks to be told, then submits a polished final report that happens to describe a specific, plausible measurement method anyway. The probed criterion must not quietly become `full`; the tutor must either revisit the question or score it partial and name the gap. |
| `genuinely-complete` | `should-be-full` | Regression guard against overcorrection: the scholar genuinely works out and states the measurement approach herself in conversation before submitting a matching report. Every criterion — including the previously-probed one — should still legitimately earn full credit and receive substantive document feedback. |

## Files

| File | Purpose |
|---|---|
| `run.ts` | Orchestrator: loads fixtures, drives each session, scores it, writes the report, gates on live runs. |
| `lib/probeIntegrityScore.ts` | The **pure** integrity classifier (`scoreProbeIntegrity`). No model calls. |
| `lib/driver.ts` | Plays a fixture's scripted scholar turns against the tool-bound tutor; records the final turn's tool call outcome. |
| `lib/runRubricTutor.ts` | The tutor side — real `buildSystemPrompt` + the mirrored `update_rubric_score` tool + the mirrored tool-result guidance; plus the `--offline` stub. |
| `lib/types.ts` | The fixture (`RubricCase`) + session-result shapes; reuses `SimTurn` from `convex/lib/curriculumSimShared.ts`. |
| `fixtures/*.json` | The scenarios above. |
| `__tests__/probeIntegrityScore.test.ts` | Unit tests for the pure classifier (run in `pnpm test`). |
