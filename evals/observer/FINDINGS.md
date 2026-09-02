# Observer Eval — Findings & Decisions

_Eval run 2026-06-01. 14 cases (6 gold fixtures + 8 real dev transcripts) × {Sonnet 4.6, Opus 4.8}, judged blind by Opus 4.8. Full report: `out/baseline/report.md`._

## TL;DR

1. **Keep the observer on Sonnet 4.6. Do not switch to Opus.** Sonnet won the blind
   pairwise **9–5** and scored higher overall (4.57 vs 4.43 / 5). Opus was *worse* on
   the dimensions that matter most for this job — granularity, mastery calibration,
   misconception handling, seed quality — and occasionally dropped `pulseScore`
   entirely from its structured output. Opus's only clear win was signal usefulness.
   The cost/quality case for Opus here is negative, so the live observer stays on
   Sonnet (now flippable via the `OBSERVER_MODEL` env var if that ever changes).
2. **The real wins are in the prompt, not the model.** The judge flagged the *same*
   systematic errors under both models — proof they're prompt issues. I tuned
   `OBSERVER_SYSTEM_PROMPT` against the six highest-frequency ones (below).
3. **The observer is already decent** (4.5+/5 on most dimensions). This was a
   tuning pass, not a rescue. Misconception handling (3.8 Sonnet / 3.3 Opus) was the
   clear weak spot and got the most attention.

## Model comparison (rubric averages, 1–5)

| Dimension | Sonnet | Opus |
|---|---|---|
| concept_transferability | 4.54 | 4.69 |
| granularity_discipline | **4.79** | 4.64 |
| mastery_calibration | **4.54** | 4.38 |
| misconception_handling | **3.80** | 3.33 |
| evidence_grounding | 4.64 | 4.71 |
| signal_usefulness | 4.36 | 4.21 |
| seed_quality | **4.92** | 4.43 |
| pulse_accuracy | **4.71** | 4.57 |
| **overall** | **4.57** | 4.43 |

Operationally Opus was actually *faster* on this run (19s vs 45s avg — Sonnet 4.6
latency was high under load) and produced slightly more observations (2.43 vs 2.00),
i.e. it leans more granular — which is the wrong direction for this task.

## Systematic prompt failure modes (ranked by frequency across all 28 runs)

1. **Misconceptions folded into other observations instead of standing alone.** The
   single most common error. A genuine wrong idea ("tiny bubbles let fish breathe",
   a confabulated plot point, an arithmetic sign error) kept getting buried in a
   `direct_demonstration` observation's `evidenceSummary` instead of emitted as its
   own `misconception_signal` at ~Remember(1) / high confidence. This is exactly the
   "misconceptions are gold" principle being under-applied. → **Fix:** rewrote the
   misconception rule into its own subsection demanding a discrete observation.
2. **Scaffolding not discounted + internal flag/prose contradictions.** Mastery
   inflated when the tutor handed the answer ("water vapor" rated Analyze 3.5 after
   the tutor nearly said it); `evidenceType: direct_demonstration` paired with
   `studentInitiated: false` while the prose claimed the student acted "without
   prompting." → **Fix:** strengthened the scaffolding rule and added an explicit
   internal-consistency rule tying `evidenceType` / `studentInitiated` / prose
   together.
3. **Pulse `topics` use moment-specific labels** ("submarine acoustics", "cavitation",
   "sensor design") while `conceptLabel`s correctly stay transferable. → **Fix:**
   applied the broad/transferable rule to `topics` too.
4. **Curriculum drift not surfaced.** Sessions titled "Multiplication Models" that
   wandered into primes/exponents kept `onTaskScore` ~0.85 with no concern flag —
   even positive drift is teacher-useful to know. → **Fix:** added drift guidance to
   the pulse/onTask section.
5. **`inferredReadingLevel` asserted on thin evidence.** Levels assigned off two
   terse, lowercase chat messages with no real writing sample. → **Fix:** tightened
   section 7 to require genuine writing evidence and omit otherwise.
6. **Signal redundancy & tutor-quote excerpts.** Two signals describing the same
   behavior from the same quote (self_direction ≈ intellectual_intensity), and at
   least one signal whose `transcriptExcerpt` quoted the *tutor's* praise rather than
   the student. → **Fix:** added a one-signal-per-behavior rule and required excerpts
   be the scholar's own words.

A seventh, lower-frequency issue (seed `currentBloomsLevel`/`targetBloomsLevel`
pointing the wrong direction or inconsistently present) also got a one-line rule.

## Before / after

Same 14 cases, Sonnet, judged by Opus. `out/baseline/` (pre-tuning) vs `out/tuned/`
(post-tuning). The gains land squarely on the dimensions the edits targeted:

| Dimension | Baseline | Tuned | Δ |
|---|---|---|---|
| concept_transferability | 4.54 | 4.54 | = |
| granularity_discipline | 4.79 | 4.86 | +0.07 |
| mastery_calibration | 4.54 | 4.85 | **+0.31** |
| misconception_handling | 3.80 | 4.40 | **+0.60** |
| evidence_grounding | 4.64 | 4.86 | +0.21 |
| signal_usefulness | 4.36 | 4.50 | +0.14 |
| seed_quality | 4.92 | 4.85 | −0.08 |
| pulse_accuracy | 4.71 | 4.93 | +0.21 |
| **overall** | **4.57** | **4.79** | **+0.21** |

Total judge-flagged errors: 36 → 33. Misconception handling — the weakest dimension
and the #1 prompt fix — improved the most (+0.60). The lone regression (seed_quality
−0.08) is a single-case swing within noise; worth a glance next pass but not a
blocker. No dimension regressed materially, so the edits didn't rob Peter to pay Paul.

## Seed dedup — `refreshesSeedId` (fixture 15, added 2026-07-03)

Observer seeds are deduped by the observer declaring `refreshesSeedId` on a seed
that's the same thread as one already pending on the scholar's sky (the
supersession pattern applied to seeds — the fuzzy Jaccard heuristic that used to
guess this was removed). Fixture `15-seed-refresh-duplicate.json` baits it: two
pending seeds are supplied (a bat food-sharing star + an unrelated echolocation
star), and the transcript is a vampire-bat blood-sharing session — the SAME
thread as the food-sharing star. The `pendingSeeds` are now threaded through
`runObserver` into `buildObserverUserMessage` and shown to the judge, and the
`seed_quality` rubric dimension scores refresh-target correctness (duplicate
without `refreshesSeedId` / wrong target / spurious link on a new direction).

**First live run (Sonnet, judged by Opus):** the fixture discriminates. Sonnet
correctly planted the human-cooperation leap as a NEW seed (no `refreshesSeedId`)
— but also planted a bat "what if cheaters invade the colony" `depth_probe` as a
fresh star with NO `refreshesSeedId`, a semantic duplicate of the pending
food-sharing seed. The judge caught it exactly (`seed_quality` 2/5, overall 4/5).
So the mechanism is wired end-to-end, but Sonnet doesn't yet reliably reach for
`refreshesSeedId` on a same-thread *depth_probe* (as opposed to a verbatim
re-suggest). That's a prompt-tuning lead, not a code bug — the eval exists to
track it. (The depth_probe is a borderline "deepen vs. duplicate" call; the
rubric treats a same-thread star without a refresh link as the failure.)

## How to reproduce / iterate

`evals/observer/README.md`. The fixtures double as a regression suite; add one
whenever a new failure mode shows up in real transcripts. Run just the seed-dedup
case with `--only seed-refresh` (the new `--only <id-substring>` filter).
