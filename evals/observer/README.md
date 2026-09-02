# Observer Eval Harness

Measures the quality of the Learning Observer (`convex/observer.ts`) — the model
call that produces mastery observations, session signals, seeds, pulse scores, and
the teacher-facing Progress view. Use it to (a) judge whether the observer output
is actually accurate and useful, and (b) compare models (Sonnet vs Opus) before
committing to one.

## What it does

```
transcripts ──► observer (per model) ──► LLM judge ──► report.md
   │                                          │
   ├─ hand-authored fixtures                  ├─ absolute rubric (8 dims, 1–5)
   │  (gold expectations + known traps)       └─ blind A/B pairwise (Opus vs Sonnet)
   └─ N real dev transcripts (exported)
```

- **Production fidelity:** the harness imports the *exact* system prompt
  (`convex/prompts.ts → OBSERVER_SYSTEM_PROMPT`), tool schema, and user-message
  builder (`convex/lib/observerShared.ts`) that the live observer uses. There is no
  second copy to drift out of sync.
- **Two transcript sources:**
  - `fixtures/*.json` — hand-authored sessions, each engineered around a specific
    observer failure mode (misconception capture, fact-vs-mastery, over-granularity,
    heavy scaffolding, gifted asynchrony, off-task, PCM-dimension tagging, and
    seed-dedup via `refreshesSeedId`). Each carries `expectations` (what a perfect
    observer does) and `traps`, which are fed to the judge as a gold rubric — so
    these cases are NOT graded on the judge's vibes alone. A fixture may also
    supply prior state — `currentObservations` (supersession realism) and
    `pendingSeeds` (the `refreshesSeedId` dedup targets already on the sky).
  - `data/dev-transcripts.json` — real transcripts exported from the **dev** Convex
    deployment (never prod). Regenerate with the command below.
- **Judge:** `claude-opus-4-8`. Its rubric encodes the same philosophy the observer
  prompt commits to, so a high score means "faithful to its instructions," not
  generic praise. Per the project model-cost guidance, Opus is fine in eval.

## Run

```bash
# Full comparison (Sonnet vs Opus, fixtures + dev, blind pairwise)
./evals/observer/run.sh --models sonnet,opus --with-dev

# Fast iteration while tuning the prompt (fixtures only, one model, no pairwise)
./evals/observer/run.sh --fixtures-only --models sonnet --no-pairwise

# Custom output dir (lets you keep before/after runs side by side)
./evals/observer/run.sh --models sonnet,opus --out evals/observer/out/after-prompt-v2
```

`run.sh` sets Node 22 (the Convex/SDK toolchain needs it) and reads
`ANTHROPIC_API_KEY` from the parent `CLAUDE.md` if not already exported. To call the
runner directly: `ANTHROPIC_API_KEY=... npx tsx evals/observer/run.ts [flags]`.

### Flags

| Flag | Default | Meaning |
|---|---|---|
| `--models a,b` | `sonnet,opus` | models to run (`sonnet`/`opus`/`haiku` or a raw id) |
| `--fixtures-only` | off | skip dev transcripts |
| `--with-dev` | auto | include dev transcripts if the data file exists |
| `--dev-limit N` | 8 | cap on real dev cases |
| `--no-pairwise` | off | skip blind A/B (saves judge calls) |
| `--concurrency N` | 4 | parallel API calls |
| `--out DIR` | `out/` | output directory |

### Outputs (in `--out`)

- `report.md` — per-model rubric averages, operational stats (latency/tokens/output
  size), blind pairwise tally, and per-case detail with the judge's errors quoted.
- `runs.json` — raw observer outputs per (case, model).
- `judgments.json` — raw judge scores + pairwise verdicts.

## Regenerate dev transcripts

```bash
export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH"
CONVEX_DEPLOYMENT=<development-deployment> \
  npx convex run evalExport:transcripts '{"minMessages":6,"limit":30}' \
  > evals/observer/data/dev-transcripts.json
```

`evalExport:transcripts` (`convex/evalExport.ts`) is an internal, dev-only query.
It also snapshots what production already wrote for each project, so you can compare
"what shipped" against "what the eval models produce." **Never run it against prod.**

## Tuning workflow

1. Run the baseline, read `report.md`, note the recurring errors the judge flags.
2. Edit `OBSERVER_SYSTEM_PROMPT` in `convex/prompts.ts`.
3. Re-run into a fresh `--out` dir and diff the rubric averages + error lists.
4. When satisfied, push to dev (`CONVEX_DEPLOYMENT=dev:... npx convex dev --once`).

To switch the live observer's model, set the `OBSERVER_MODEL` env var in the Convex
dashboard to a model id (e.g. `claude-opus-4-8`); it defaults to Sonnet. No code
change or redeploy required.

## Fixtures are the regression suite

The fixtures double as regression tests: a prompt edit that fixes one failure mode
shouldn't silently regress another. Add a new fixture whenever you discover a fresh
failure mode in real transcripts — copy an existing file's shape, write tight
`expectations`/`traps`, and it's picked up automatically.

## Focused gates (fast, no judge)

Two hard pass/fail gates run the production observer on a few fixtures and check
ONE behaviour each against numeric thresholds — no LLM judge, so they're cheap and
deterministic enough to run after every observer-prompt edit:

- **`fluency-check.sh`** — the §7.5 automaticity gate (recall moments earn a
  `fluencyLevel`, deep reasoning does not).
- **`rigor-check.sh`** — the mastery-CALIBRATION gate. Runs the
  "modest-expectation" fixtures (scaffolded / fact-collection / directed-build /
  a pre-existing duplicate pile) and checks the observer stays LOW and FEW and
  CONSOLIDATES: granularity, Analyze+ rate, per-fixture mastery ceilings,
  misconception capture, within-run dedup, and consolidation pile-ons. Each fixture
  declares its ceilings in a `rigorGold` block. Motivation + before/after:
  `FINDINGS-rigor.md`.

```bash
evals/observer/rigor-check.sh             # sonnet (the live observer model)
MODEL=opus RUNS=3 evals/observer/rigor-check.sh
```
