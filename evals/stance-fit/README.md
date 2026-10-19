# Stance-fit eval

This judged harness measures whether each tutor move fits the scholar's state at
that moment. It is aimed at the failure mode where guided discovery becomes
question-only tutoring: diagnose before teaching, distinguish impatience from a
genuine stall, shift among guided discovery, direct explanation, and parallel
worked examples, and stop when understanding is demonstrated.

## Run

The default output directory is `evals/stance-fit/out`. The repository's root
`.gitignore` ignores every directory named `out/`, including this default.
`data/` and `verdicts/` contain real scholar transcripts and derived judgments:
**never commit them**. Keep any custom `--out` path in an ignored location.

Export the three service-account variables in your shell; do not put credentials
in the repository:

```bash
node evals/stance-fit/fetch.mjs \
  --days 30 \
  --min-messages 8 \
  --limit 40 \
  --out evals/stance-fit/out

node_modules/.bin/tsx evals/stance-fit/classify.ts \
  --out evals/stance-fit/out

node_modules/.bin/tsx evals/stance-fit/report.ts \
  --out evals/stance-fit/out
```

`fetch.mjs` authenticates with `RABBITHOLE_PROD_URL`,
`RABBITHOLE_PROD_USERNAME`, and `RABBITHOLE_PROD_PASSWORD`, then performs only
read queries. It samples recent, non-test-drive conversation sessions
round-robin across scholars. It redacts the roster display name from persisted
titles and messages because names add no stance signal.

Use `--limit-sessions N` to bound classification. Use `--dry-run` to load every
selected transcript and build every pending prompt without making API calls:

```bash
node_modules/.bin/tsx evals/stance-fit/classify.ts \
  --out evals/stance-fit/out \
  --limit-sessions 5 \
  --dry-run
```

The smoke fixture is synthetic. To exercise prompt construction, copy it into an
output directory's `data/` folder before running `classify.ts --dry-run`.

## Labels

### Scholar state

- `has_footing`: engaged and has shown the pieces needed for guided discovery.
- `cold`: the question relies on a premise the scholar has never encountered.
  This requires positive evidence; one wrong guess is not enough.
- `stuck_repeating`: repeats the same wrong idea, says "I have no idea," cannot
  act after a probe, or begins shutting down.
- `impatient_push`: asks to be told while engaged and holding the needed pieces.
- `fading`: attention or effort is ebbing without clear evidence of a hard stall.
- `factual_ask`: asks for a fact, definition, or quick confirmation.
- `topic_ask`: asks for a broad topic, overview, phenomenon, or contested issue.
- `procedure_ask`: asks how to perform a new multi-step skill.
- `demonstrated`: correctly explains, applies, transfers, or completes the idea.
- `other`: none of the above is supported.

### Tutor move

- `probe_question`: a diagnostic, open, reflective, or retrieval question.
- `narrowing_hint`: a clue or partial step that narrows the space but leaves
  meaningful work.
- `direct_explanation`: states and explains a concept, rule, or procedure.
- `worked_example_parallel`: solves a different but structurally parallel
  example, narrating the method for transfer.
- `answer_given`: supplies the requested fact, conclusion, or exact answer.
- `closure_summary`: names the goal as met and summarizes or closes.
- `redirect_nonacademic`: redirects safety, wellbeing, integrity, or another
  nonacademic concern.
- `logistics_other`: setup, tool use, scheduling, acknowledgments, or another
  non-pedagogical move.

### Stance fit

- `matched`: the move fits the state evidenced in the transcript.
- `over_socratic`: a scholar needing a foothold, explanation, worked example,
  or direct answer receives another question.
- `over_didactic`: the tutor gives substantially more than needed when the
  scholar has footing and should do the thinking.
- `funnel`: the turn participates in a chain of narrowing guess-questions aimed
  at an answer the tutor already holds.
- `missed_closure`: the scholar demonstrated understanding, but the tutor keeps
  probing instead of naming the work done.
- `not_applicable`: the move is logistical/nonacademic or fit cannot be judged.

Verdict keys are zero-based message indexes from the source transcript. A
session's first assistant reply to a literal `<start>` message is not judged.
The report's stall latency is `0` when the response to the first cold/stuck turn
teaches immediately. Its declarative-teaching metric is deliberately mechanical:
it counts non-question sentence-like spans of at least three words and does not
reuse the classifier's semantic `teachingSentences` count.

## Decision-point replay (prompt A/B)

`replay/` measures how the tutor's **next move** changes under a prompt change,
without the confound of replaying fixed scholar turns after the tutor has
diverged. For each entry in `<out>/decision-points.json`
(`{ sessionId, scholarIndex, tutorIndex, state, originalMove, originalFit }`)
it truncates the transcript after `scholarIndex`, regenerates only the next
tutor turn through `evals/tutor-quality/lib/runTutor.ts` (the real
`buildSystemPromptParts`, shipped tutor model/effort/max_tokens), and judges
that one turn with the same stance-fit prompt as `classify.ts`. The prompt
under test is whatever `convex/` holds in the working tree, so run A before
applying the prompt change and B after; each run records the git SHA, a hash
of the uncommitted `convex/` diff, and a per-entry system-prompt SHA-256.

```bash
export NODE_OPTIONS="--conditions=import"   # same reason as tutor-quality/run.sh
set -a; source ~/code/.env.local; set +a
node_modules/.bin/tsx evals/stance-fit/replay/run.ts --out <dir> --label baseline --samples 2 --dry-run
node_modules/.bin/tsx evals/stance-fit/replay/run.ts --out <dir> --label baseline --samples 2
# …apply the prompt change in convex/…
node_modules/.bin/tsx evals/stance-fit/replay/run.ts --out <dir> --label candidate --samples 2
node_modules/.bin/tsx evals/stance-fit/replay/compare.ts --out <dir> --a baseline --b candidate
```

Cost: per decision point × sample, one tutor call plus one judge call. Runs are
resumable and refuse to append to a label written at a different SHA/diff or
with a different judge. `--states a,b` and `--limit K` bound a run.

**What the replay does not carry** (the main validity caveat): the tutor sees
reading level, the wrap-up note (inferred as "no activity"), and the text
history only. Unit/lesson/activity context, teacher whispers and directives,
dossier, mastery, signals, seeds, practice skills, goals, deliverable/rubric,
artifacts, timing (`lastSessionAt`), and the institution profile all fall to
runTutor's defaults; tools are not offered, the clock in the turn context is
"now", and the scholar's name is null (fetch.mjs redacts it). Compare A and B
against each other, not against the shipped turn — the "original" column is a
reference, not a control. The synthetic fixture in `replay/fixtures/synthetic`
is fictional; copy it into a scratch directory before a real run.
