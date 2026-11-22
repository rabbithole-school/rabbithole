# Designer steer — replay, simulation and judge for the App designer

Plays scholar lines through the REAL App designer on a private dev deployment
(`sessions.sendMessage` in Edit mode, then `/session-stream`, the real designer
prompt and tools), records every turn, and has a model judge the run. The web
client is never driven, but the app itself runs in headless Chromium
(`appRunner.mjs`) unless `--no-app` is passed. Built to compare the designer
BEFORE and AFTER a steering change (the
model contract, parking, questions with consequences, `allowSilence`) on the
same inputs. The contract fields are described where they live:
`activities.buildContract` / `allowSilence` in `convex/schema.ts`.

`replay.mjs` reads the deployment from `.env.local`, refuses production, signs
in with the dev-login secret (never printed), and needs the seeded dev cast
(`pnpm db:seed`). `sim` and `judge` need `ANTHROPIC_API_KEY`
(`set -a; source ~/code/.env.local; set +a`; it also reads that file itself).

```bash
H=evals/designer-steer/replay.mjs
node $H setup  --brief <file> [--contract <json>] [--allow-silence] [--name <n>] [--tutor-model fable]
node $H replay --setup <n> --lines <file> [--scholar test-scholar-001] [--prior <file>] [--run <id>] [--limit N]
node $H sim    --setup <n> --persona <file> [--turns 12] [--scholar …] [--prior <file>] [--run <id>]
node $H judge  --run <id>
```

- `setup` creates or reuses (by title) a unit `Designer steer eval: <title>`,
  a lesson, and a vibecode activity whose build brief is the file, owned by
  `test-teacher-001`. Re-running it makes the activity match the flags exactly:
  no `--contract` clears a contract, no `--allow-silence` sets it false. It
  prints the ids and saves them as `<RUNS_DIR>/setups/<name>.json`.
- `replay` assigns and pushes the activity to the scholar as a teacher does,
  archives their open session of it, opens a fresh one, and sends each line in
  order, waiting for the turn to end (300 s cap; a 429 busy is retried after
  `Retry-After`, as the client does). Per turn it records the streamed reply,
  the tools called (`create_code`, `edit_document` with its result, e.g.
  `Viewed …`, `park_idea`, `stay_silent`, …), the app's HTML when it changed,
  the session's parking lot, and the elapsed time. A turn that finishes with
  no text is `SILENT`, not an error. Lines file: one message per line; a line
  that is a JSON string is decoded, so multi-line messages survive.
- `--free-play <prelude lines>` (replay and sim) measures building AFTER
  "Finish and send", where most building hours go. It replays the prelude
  lines in the assignment session (they must build an app), makes sure the
  parking lot holds an idea (when the designer parked nothing, it parks
  `--idea <text>` through the dev CLI, since `sessions:parkIdea` is internal),
  marks the activity complete as the scholar, and calls
  `sessions.startFreePlay`, the done screen's "Build it now". Since one-session
  building that returns the SAME session (the contract stays, its gate counts
  as met), so a `--contract` on `setup` now applies here too; on a deployment
  from before, it returned a contract-free copy. The prelude's turns go to
  `prelude.jsonl`; only the turns after it land in `turns.jsonl` and are
  judged, with the app as it stood as `version@turn0`. The persona opens on
  that app.
- `--prior <file>` first gives the scholar an earlier online activity in the
  same unit (`Earlier: my design and questions`) and submits the file's text
  as its deliverable, so the run exercises prior-work loading.
- `sim` lets `claude-sonnet-5-5` play the scholar from a persona file. The
  persona sees only what a child sees: the designer's replies (nothing on a
  silent turn) and the app's visible text and buttons when it changes. It
  writes kid-length lines and acts out its listed habits, including ignoring
  questions, "idk", ALL CAPS and "get rid of all this".
- `judge` sends the brief, the contract, every turn and every app version to
  `claude-sonnet-5-5` and writes `judge.json` and `debrief.md`: whether the
  gate model was built AND run before cosmetics, learning questions asked
  (alone or appended to a build), answered, builds that went past an
  unanswered question, parked ideas, domain-twin offers, false claims about
  the app checked against its HTML, and a 0–10 academic value with a
  paragraph. Without a contract the judge derives the gate from the brief.
  It also counts who makes the world's rules: rule decisions in the child's
  own words (set or changed, after a run or not, with a reason or not)
  against scenery requests (`ruleShare`), rule choices the designer offered
  and how many were answered, quizzes and how many were answered, builds
  held for an answer, problems the designer added on its own, and the rules
  a child can see and change on screen at the end, split by what the screen
  says about who set each one (`rulesOnScreenGuess`, `rulesOnScreenScholar`,
  `rulesOnScreenUnmarked`). It also counts the designer's picks the child
  changed (`guessesEdited`), scenery requests whose reply still asked
  something (`sceneryQuestions`, which should be 0), and whether the questions
  read as nagging (`nagging`).

Runs live in `<RUNS_DIR>/<runId>/` (`meta.json`, `turns.jsonl`,
`artifacts/turn-NN.html`, `log.md`, `judge.json`, `debrief.md`).
`RUNS_DIR` defaults to `.steer-runs/` at the repo root (gitignored); set
`STEER_RUNS_DIR` to move it. One command per run id at a time (lock file).

## Before and after on the same lines

```bash
# BEFORE: today's designer (no contract = the legacy path, verbatim)
node $H setup  --brief brief.txt --name cmp
node $H replay --setup cmp --lines lines.txt --run before
node $H judge  --run before

# AFTER: same brief and lines, the activity now carries a contract
node $H setup  --brief brief.txt --name cmp --contract contract.json --allow-silence
node $H replay --setup cmp --lines lines.txt --run after
node $H judge  --run after
# compare before/debrief.md with after/debrief.md
```

Replayed lines are fixed, so once the designer behaves differently they no
longer answer what it says: a replay measures what the designer does with the
same pressure, a `sim` measures the conversation. Run both. Use the same
scholar and `--tutor-model` on both sides, and run a sim three times before
trusting a difference; one run is an anecdote.

## Scripts

`scripts/` holds FICTIONAL inputs only. Subject 1, seed dispersal:
`seed-dispersal-brief.txt` and `seed-dispersal-contract.json`. Subject 2, bridge
load: `bridge-load-brief.txt` and `bridge-load-contract.json`. Personas, each
with a `howIUseTheApp` field describing how the child presses buttons and reads
results: `persona-maple-kid.json` (the reluctant one: wants a maple-seed game,
skips school-like questions, drifts toward lasers, a coin shop and 3D),
`persona-cooperative-kid.json` (answers in a sentence with a reason, reports
what she sees, still wants a race mode and a pet bird but takes a good offer)
and `persona-bridge-kid.json` (a bridge-load builder who drifts toward
explosions and a destruction mode). Free play (`--free-play`): subject 3, a
town, `town-brief.txt` with the prelude `town-prelude.txt`, the replay lines
`town-lines.txt` and `persona-scenery-kid.json` (keeps ordering buildings and machines, skips
questions whose answer is an explanation, answers choices about his own
things with a build, and gets exact about numbers in things that move);
subject 4, a race, `race-brief.txt` with `race-prelude.txt` and
`persona-tuner-kid.json` (races his own characters, reads the results and
rebalances their numbers, ignores prediction questions); subject 5, an island
harbor on `town-brief.txt`, with the preludes `harbor-prelude.txt` (2D) and
`harbor-prelude-3d.txt` (first person), the replay lines
`harbor-carrier-lines.txt` (a carrier, a jet, rooms, portholes, an elevator,
a pause key) and two personas: `persona-decorator-kid.json` (asks only for
looks and skips every question) and `persona-order-giver-kid.json` (adds
machines as orders and sets exact numbers on the ones it can see). A real scholar's lines or brief never go
in the repo; keep them in the session scratchpad.

## Where it differs from the browser

- No render check: the stream is opened without `supportsRenderCheck`, so the
  designer cannot ask the browser to screenshot the app.
- No app snapshot or app state is sent with a turn, and the app now runs for real in headless Chromium (evals/designer-steer/appRunner.mjs): the child may act in it up to three times a turn (<act>click N</act>, <act>set N = value</act>, <act>type N = text</act>), sees the real visible text and state before typing, and the state is published to the session with the web client's own mutation, so the designer and the judge see it. --no-app turns the runner off. Per-turn records gain kidActions, appState, visibleText, controls, a screenshot and appBroken. A gate that depends on
  the scholar pressing Run is judged from the code and the conversation.
- Each line waits for the previous turn to end. A real scholar can type while
  a build streams, which stops it and replaces it.
- The persona reads the app as text, not pixels.

## Measuring depth honestly

For free-play lawmaker work, `closedLoops` is the headline measure: the
child sees a result in their app, changes a rule because of it, and then
reports what that rule now does. `loopAttempts` also counts changes the
child never checked, and `kidWhyQuestions` counts questions about their
app's behavior. Raw `kidRuleDecisions` and `ruleShare` are secondary: they
also count size multipliers and reasserted resets, and `reassertedRules`
flags a designer bug. The judge is noisy: the same transcript judged twice
can differ by two or three on a count, so read the listed loops, not only
the numbers.

- Matrix: three personas x two subjects (the personas fit their own subject;
  cross them with the other subject's brief where it makes sense), 40 turns
  each, three runs per cell.
- Judge counts (questions asked, answered, parked ideas) are noisy from run to
  run. Read the `debrief.md` and the turns themselves; do not average the
  counts and call it a result.
- The app now runs for real: the simulated child presses the app's buttons and
  sees real results rather than reading its HTML as text. The runner's
  mechanics are documented with `replay.mjs`.
- Before and after must be the same persona, the same subject, the same
  scholar and the same `--tutor-model`. A single run is an anecdote; three
  runs that agree are a signal.
- What the bench still cannot see: a real child's affect (boredom,
  frustration, delight), and the teacher in the room who would step in, which
  the designer is built to rely on.

## Known artifacts

- The reluctant persona's flat "idk" can look like a designer failure when it
  is the persona being unhelpful; check whether the question was fair.
- Short sessions (a dozen turns) rarely reach the second MUST BE TRUE item, so
  they cannot show whether the arc repeats.
- One judge, one model: it shares blind spots with the designer. Spot-read
  the transcripts.
