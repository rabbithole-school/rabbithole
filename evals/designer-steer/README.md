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
explosions and a destruction mode). A real scholar's lines or brief never go
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
