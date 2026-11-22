# Spotted flair back-test

Offline, text-only **structured spot eval**, with human labels, not an automated
judge. Uses the production system prompt, multimodal message builder, request
builder/model/effort, no-tool retry, parser, grounding, text cleanup and
corroboration helpers. It never connects to Convex or writes awards.

## Run

With `ANTHROPIC_API_KEY` already in your environment (never put it in a command
or file), run from the repo root:

```sh
npx tsx evals/spotted-flair/backtest.ts /private/scratch/sessions.json --out /private/scratch/run --concurrency 2
npx tsx evals/spotted-flair/labelsheet.ts /private/scratch/run/results.json --out /private/scratch/run/labelsheet.html
npx tsx evals/spotted-flair/score.ts /private/scratch/run/results.json /private/scratch/teacher-a.json /private/scratch/teacher-b.json --out /private/scratch/run/report.md
```

Input is a JSON array, one entry per session:

```json
[{
  "id": "fictional-session",
  "scholarId": "fictional-robot",
  "date": "2026-11-01T10:00:00Z",
  "title": "Garden builder",
  "chatHistory": [
    {"id": "turn-1", "role": "user", "content": "Make a garden game."},
    {"id": "turn-2", "role": "assistant", "content": "What will grow?"}
  ],
  "deliverableCriteria": [{"id": "goal-1", "label": "Plant a seed", "description": "A seed grows."}],
  "buildContract": {"gate": "Build a garden.", "invariants": ["Harvesting adds a point."]}
}]
```

Criteria and build contract are optional; export the **resolved** criteria
(session override or activity fallback), not just an empty session override.
Messages use the observer/`evalExport` shape: role + content, optional id,
sourceRole, createdAt, inputModality, byStaff and image metadata. Missing ids
are assigned stable per-session ids; sourceRole defaults to role. Preserve
sourceRole/modality when exporting: tool/app turns are not scholar evidence.
Dates accept ISO dates or timestamps with timezone. Duplicate ids fail.

This replays one end-of-session pass with `spottedFlairOpen: true`, no prior
observations/seeds/signals, generic scholar identity, no unit/app state, and
the production last-30-turn window. It refuses scholar image uploads in that
window rather than silently pretending to see them. It does not reconstruct
each live pass or test-drive eligibility. Only use eligible, non-rehearsal
sessions. No prompt or cap is changed.

Results contain the raw decision/reason/proposed text, the step-10b gate
outcome, and every grounded, corroborated, unawarded scholar turn with its
connection/direct-demonstration excerpts. Multiple rows for one turn yield
one candidate. `awarded` means **would pass step 10b with caps open**, not a
database write. API/parser failures are not converted to negative examples.

Rerun the same command to resume. Successful sessions are atomically saved
after each response; only missing sessions are called. Input/request hashes
and a code fingerprint prevent mixing changed transcripts, prompts or gates.
Appending sessions is allowed; removing/changing completed sessions is not.
Concurrency defaults to 2 (1–8). There is no model override. On a failure,
new calls stop, in-flight calls finish, and the process exits nonzero. After a
hard interruption, remove `backtest.lock` **only after checking the previous
process has stopped**. Use a new output directory for a fresh eval.

## Blind labeling and scoring

Give both teachers the **same generated HTML**, not results.json. It embeds
Hanken Grotesk, works offline, and makes no network requests. All awarded
turns plus an equal-sized random sample of unawarded corroborated turns are
shuffled, without decisions, reasons, proposed labels/notes or identifiable
session ids. Both groups show the same full scholar turn, up to two turns on
each side, and the supplied goals. `--seed name` gives a reproducible shuffle.
Insufficient controls (or zero awards) fail explicitly; add sessions rather
than duplicate controls.

Each teacher enters a name, answers yes/no/unsure with optional notes, and
clicks **Export answers** to copy JSON from the textarea into a private file.
Use separate browser profiles/devices and only each teacher's latest export.
Partial labels are supported; unanswered is not no. Browser localStorage is
per sheet; a storage failure is visible and manual export still works.

The report gives per-rater and pooled precision, a **miss-rate recall proxy**
(yes among sampled unawarded candidates, **not** true recall), three-category
pairwise agreement and Cohen's kappa, and per-scholar-week award counts.
Unsure is included in the main labeled denominator; decisive-only is separate.
It rejects mixed sheets, mismatched datasets and duplicate labelers.

Cap calibration simulates the production inclusive rolling 7-day limit,
using each session's date as award time and only accepted awards as history.
It picks the smallest positive cap that blocks an award in **strictly less
than 20%** of observed active scholar-weeks (Monday UTC, zero-award weeks
included). Complete scholar-week sampling and preceding 7-day history are
needed for a meaningful real estimate; calendar-week totals alone miss
Sunday/Monday bursts. Fictional sessions and fake labels prove plumbing only.

## Fictional proof and tests

`fixtures/builders.json` contains six invented robot-builder sessions:
unprompted sunlight/signal-delay ideas and a self-discovered exploit fix;
polish requests, a listed inflation goal and a tutor-supplied idea as negatives.
These are qualitative expectations, not teacher labels or calibrated scores.
To combine them with all observer fixtures, without copying gold expectations
into the model prompt:

```sh
mkdir -p evals/spotted-flair/out
node --input-type=module -e '
import fs from "node:fs";
const dir = "evals/observer/fixtures";
const cases = fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort().map((f, i) => {
  const c = JSON.parse(fs.readFileSync(dir + "/" + f, "utf8"));
  return {id:c.id, scholarId:"fictional-fixture-" + i, date:"2026-11-01T10:00:00Z", title:c.title, chatHistory:c.transcript};
});
const builders = JSON.parse(fs.readFileSync("evals/spotted-flair/fixtures/builders.json", "utf8"));
fs.writeFileSync("evals/spotted-flair/out/sessions.json", JSON.stringify([...cases, ...builders], null, 2));
'
npx tsx evals/spotted-flair/backtest.ts evals/spotted-flair/out/sessions.json --out evals/spotted-flair/out --concurrency 2
npx tsx evals/spotted-flair/labelsheet.ts evals/spotted-flair/out/results.json --out evals/spotted-flair/out/labelsheet.html
npx vitest run evals/spotted-flair/lib.test.ts
```

## Privacy

**Real transcripts, results, labeling HTML, filled label files and reports stay
in a private scratch directory outside the repo and are never committed.**
Production export and model processing require separate human approval; this
harness grants neither and includes no data-fetch command. Do not serve real
label sheets publicly or use external font/CDN assets. Clear browser storage
after exporting. Only code and explicitly fictional inputs belong in git.
The in-repo ignored `out/` path above is for **fictional proof only**.
