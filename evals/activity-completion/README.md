# activity-completion eval

Regression guard for the **timing** of `mark_activity_complete` on
conversation-only activities. The PR review asked for exactly this: *"ensure
prompt changes don't cause sessions to get marked as done too soon or too
late."* It drives the **real production tutor prompt** (with the completion tool
bound) through a synthetic scholar and scores WHEN the tutor closes the
activity: **on-time / too-soon / too-late / kept-going / withheld**.

The failure modes it exists to catch:

- **too-soon** — completing before the scholar meaningfully engaged (the
  "hello can never finish an activity" case, mirroring the server-side ≥ 2
  real-scholar-turns guard) or before the activity's goal was genuinely
  reached.
- **too-late** — the goal was reached but the tutor never wraps (the
  "volcano-homework still 1 due forever" bug this PR fixes).
- **kept-going** — the tutor speaks before calling the completion tool, or
  follows completion with another question/task, putting the "Done" handoff
  beside an instruction to continue.

## Two layers — deterministic gate + live eval

1. **Pure timing classifier** (`lib/completionScore.ts`) — no model calls, no
   I/O. Given two numbers (the scholar-turn the tutor marked complete, and the
   scholar-turn the sim first signalled it reached the goal), the verdict is
   objective. This is unit-tested in `__tests__/completionScore.test.ts` and
   **runs in `pnpm test`** — it's what actually guards the too-soon/too-late
   logic in CI.
2. **Model-in-the-loop runner** (`run.ts` + `lib/driver.ts` + `lib/runTutor.ts`)
   — produces those two numbers from a live conversation: an emergent
   [`curriculum-sim`](../curriculum-sim) Scholar Simulator, or a fixed script for
   withhold cases, plays through a conversation-only activity against the real
   tutor prompt, while the driver records when the tutor calls the tool vs. when
   the sim reaches the goal (`[[DONE]]`, or fixture-defined goal-evidence
   patterns when the sim omits its sentinel) and rejects duplicate pre/post-tool
   speech, questions, or fresh tasks on the completion turn. Production still
   asks for tool-first; if the model writes a declarative closing first, the
   stream suppresses a second closing and the UI anchors Done after the
   sentence already shown. This needs a real model for emergent
   fixtures (see below).

The ground-truth "the arc is genuinely finished" signal is the **scholar's**
goal signal or explicit evidence in the scholar's own turn, never the tutor's
opinion — that's what makes "too soon" measurable. A scripted scholar never
emits `[[DONE]]`/`[[STUCK]]`, so the arc is definitionally unfinished and any
completion is too-soon.

## Production fidelity

The tutor system prompt is assembled by the real `buildSystemPrompt` from
[`convex/sessionHelpers.ts`](../../convex/sessionHelpers.ts) with
`conversationCompletionContext` set, so we score the exact
`buildConversationCompletionSection` guidance that ships today (same discipline
as [`evals/tutor-quality`](../tutor-quality) and
[`evals/curriculum-sim`](../curriculum-sim)). The `mark_activity_complete` tool
definition in `lib/runTutor.ts` imports the same name, descriptions, and success
guidance used by [`convex/http.ts`](../../convex/http.ts), so the eval cannot
drift from production. The runner also mirrors the server-side ≥ `MIN_REAL_TURNS` guard from
`activityCompletions.markCompleteFromTool`: an early call is issued but blocked
(nothing is marked) and the conversation continues, exactly as production does.

## Run it

```bash
# Live eval — makes real Anthropic calls; exits non-zero if any fixture's
# timing verdict fails its expectation (so it can gate a prompt change locally).
ANTHROPIC_API_KEY=... ./evals/activity-completion/run.sh

# One fixture only
ANTHROPIC_API_KEY=... ./evals/activity-completion/run.sh --case engaged-reaches-goal

# Wiring/demo only — deterministic stubs, no key, never fails CI
./evals/activity-completion/run.sh --offline

# Flags
./evals/activity-completion/run.sh \
  --case <fixture-id>   # default: all fixtures/*.json
  --max-turns N         # default 10
  --grace N             # scholar turns after the goal the tutor may take
                        # before it's "too late" (default 2)
  --offline             # stubbed tutor; proves the pipeline runs only
```

`--offline` uses deterministic stubs (see `stubTutor` in `lib/runTutor.ts`) that
exercise the whole pipeline without a key — it is NOT a behavior claim about the
real tutor, so it never fails. Only a **live** run scores the real prompt; that's
the model run to do locally.

Use the wrapper rather than bare `npx tsx`: it sets
`NODE_OPTIONS=--conditions=import`, which this import chain needs because
`@convex-dev/auth/server` only publishes an `import` exports condition.

Override the tutor model with `TUTOR_MODEL` (defaults to `MODELS.SONNET`).

## Output

- `out/report.md` — pass count, tutor token usage, a per-fixture verdict table,
  and every full transcript.
- `out/runs.json` — every fixture's observation + score, raw.

`out/` is gitignored (regenerate on demand).

## Fixtures

Each fixture pairs a conversation-only activity with a synthetic scholar and an
`expectation`. By default the scholar is emergent via `curriculum-sim`. A fixture
may instead define `script: string[]`; those scholar turns are replayed verbatim
in order, like the fixed-replay precedent in [`evals/spot-eval`](../spot-eval).
The should-withhold fixtures use scripts because the shared kid-voice prompt
keeps sims engaged and can pull a disengaging profile into reaching the goal,
which makes a withhold scenario drift out from under the eval.

| Fixture | Expectation | Scholar | Guards |
|---|---|---|---|
| `engaged-reaches-goal` | `should-complete` | Emergent sim | An engaged scholar works the goal through; the tutor must close it out (catches **too-late**). |
| `disengages-no-goal` | `should-withhold` | Scripted | Partial engagement, then disengagement and a final "done" claim without the gas-pressure goal; the tutor must NOT complete an unfinished arc (catches **too-soon**). |
| `hello-and-bail` | `should-withhold` | Scripted | A quick hello / "ok I'm done" with no real engagement; a hello can never finish an activity (the pilot/onboarding failure; mirrors the ≥ 2-real-turns guard). |

## Files

| File | Purpose |
|---|---|
| `run.ts` | Orchestrator: loads fixtures, drives each session, scores it, writes the report, gates on live runs. |
| `lib/completionScore.ts` | The **pure** completion classifier (`classifyCompletion` / `scoreCompletion`) + the `MIN_REAL_TURNS` / `DEFAULT_GRACE_TURNS` constants. Scores timing and rejects duplicate pre/post-tool speech, follow-up questions, and fresh tasks on a completion turn. No model calls. |
| `lib/driver.ts` | Alternates the reused Scholar Simulator and the tool-bound tutor; records goal-reached vs. completed turns, with a grace window. |
| `lib/runTutor.ts` | The tutor side — real `buildSystemPrompt` + the mirrored `mark_activity_complete` tool + the mirrored server guard; plus the `--offline` stub. |
| `lib/types.ts` | The fixture (`CompletionCase`) + session-result shapes; re-exports the sim's `ScholarProfile` / `SimActivity` / `SimTurn`. |
| `fixtures/*.json` | The scenarios above. |
| `__tests__/completionScore.test.ts` | Unit tests for the pure classifier (run in `pnpm test`). |
