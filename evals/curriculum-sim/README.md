# curriculum-sim — self-improving curricula (harness prototype)

A runnable, testable prototype of the **self-improving curricula** loop
(`review/self-improving-curricula-plan.md`): simulate a cast of synthetic
scholars *playing through* an activity against the **real production tutor**,
judge the transcripts, propose activity edits, and hill-climb to keep what wins
— with a sim-to-real calibration check.

This is the research engine, in eval-harness form (like `evals/spot-eval` and
`evals/tutor-quality`). The product version (Convex actions + schema + teacher
UI) is described in the plan doc; this is what proves the idea and tunes the
prompts before any of that gets built.

## The four phases (each its own runner)

| Phase | Runner | What it does |
|---|---|---|
| 1 — analyze | `run.ts` | Simulate + judge a cast through an activity. Report: transcripts, fitness, where kids stall. **No edits.** |
| 2 — propose | `propose.ts` | + Improver proposes ONE revised systemPrompt; re-simulates; reports before/after delta + diff + promote/hold decision. |
| 3 — loop | `improve.ts` | Hill-climb: K candidates/generation, keep the best that clears the protected-dim gate, stop on plateau/budget. |
| 4 — ground | `ground.ts` | Judge REAL prod transcripts; calibrate sim vs reality; warn if the sim is too optimistic to promote off of. |

## Run

```bash
# Phase 1 — analyze
ANTHROPIC_API_KEY=... npx tsx evals/curriculum-sim/run.ts \
  --activity evals/curriculum-sim/scripts/halving-shapes.json \
  --cast evals/curriculum-sim/scripts/cast.json --judge

# Phase 2 — propose one edit (measured)
ANTHROPIC_API_KEY=... npx tsx evals/curriculum-sim/propose.ts \
  --activity .../halving-shapes.json --cast .../cast.json

# Phase 3 — the loop
ANTHROPIC_API_KEY=... npx tsx evals/curriculum-sim/improve.ts \
  --activity .../halving-shapes.json --cast .../cast.json \
  --generations 3 --variants 2 --max-evals 8

# Phase 4 — calibrate against real prod transcripts (read-only; needs prod creds)
set -a; source ~/.claude/rabbithole-prod.env; set +a
npx tsx evals/curriculum-sim/ground.ts \
  --activity .../halving-shapes.json --projects p1,p2,p3 \
  --sim evals/curriculum-sim/out/sessions.json

# Any runner: --offline uses deterministic stubs (no API key) — wiring/demo only.
```

Output lands in `out/` (gitignored): `report.md` / `propose.md` / `improve.md` /
`ground.md` + matching `.json`. Models via env: `TUTOR_MODEL` (Sonnet, the live
tutor), `SIM_MODEL` (Haiku, the kids), `JUDGE_MODEL` / `IMPROVER_MODEL` (Opus).

## Design notes

- **The new primitive is `scholarSimulator.ts`** — an LLM roleplaying a kid that
  reacts to the real tutor turn-by-turn (emergent, not replayed). It signals
  `[[DONE]]`/`[[STUCK]]` (stripped before the tutor sees it) so sessions resolve
  to `goal`/`stuck`. Everything else is wiring around it.
- **The tutor is the real one** — `runTutor.ts` calls production `buildSystemPrompt`
  with the activity under test + the synthetic dossier. We improve what ships.
- **The reward-hacking guard is in `score.ts`** — fitness is ONLY the
  curriculum-fit dims; a candidate must also clear the **protected-dim gate**
  (socratic / absence-of offloading-spoilers-sycophancy / ageFit may not regress
  past tolerance). So a variant can't "win" by making the tutor dump answers or
  flatter — that's the most important thing to keep correct, and it's the most
  heavily tested.
- **The Investigation bar (design) is measured, not gating.** These four 1–5
  dimensions are recorded and reported separately. They do not affect fitness,
  `isBetter`, protected-dimension regressions, or any pass/fail gate:
  - `singleSpine` — Does every activity visibly advance ONE conceptual
    through-line? 5 = one spine, each activity a step on it; 1 = a grab-bag tour
    of subtopics.
  - `discoveryArc` — Does the scholar DERIVE the central idea (from data,
    pattern, or failed prediction) BEFORE it is named/explained? 5 = name arrives
    as payoff after derivation; 1 = concept stated up front, then practiced.
  - `handsOnMission` — Does the quest include a real away-from-screen mission
    (measure/count/build/tally with real objects) whose results feed later work?
    5 = mission present, results load-bearing; 3 = gestured at but optional /
    results unused; 1 = fully screen-bound.
  - `earnedPayoff` — Is there an engineered surprise (inversion, hidden
    identity, data overruling intuition) that the design sets up
    (gap/bet/prediction first)? 5 = gap opened early, payoff lands; 1 = no gap,
    no surprise, praise as ending.

To evaluate a prompt-side quality change, run seed-bake before/after on the same
topics and compare the Investigation-bar section.

## Tests

```bash
npx vitest run evals/curriculum-sim
```

The pure decision logic is unit-tested (no model calls): aggregation + the gate
(`score.test.ts`, incl. "hit the goal by offloading/flattery must lose"), the
diff (`diff.test.ts`), the hill-climb control flow with fakes (`optimizer.test.ts`,
incl. plateau/budget/gate-blocks-promotion), and sim-to-real calibration
(`ground.test.ts`).

## Verified vs. not (this container)

- ✅ Typechecks against the real `convex/projectHelpers` signature; 20 vitest
  cases green; every runner executes end-to-end in `--offline` mode.
- ⚠️ **Not run against live models** — this container has no `ANTHROPIC_API_KEY`,
  so the offline stubs only prove wiring/types, not that simulated kids read like
  real kids or that the judge/improver produce good output. That's the first
  thing to check with a key (Phase 1). Phase 4 additionally needs prod creds.

## Not built here (product layer — see plan doc)

The Convex tables (`curriculumVariants`, `curriculumExperiments`,
`syntheticScholarProfiles`, `simulatedSessions`), the `"use node"` actions, the
async progress streaming, and the teacher-facing "Auto-improve this activity" UI.
The harness is the portable core those would call into.

The in-product judge twin deliberately does not include the Investigation-bar
dimensions yet; keeping it aligned is a follow-up after this harness measurement
is established.
