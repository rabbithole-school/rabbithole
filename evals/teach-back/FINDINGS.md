# teach-back eval — findings

The "before enable" gate for the Teach-the-Tutor / "explain it back" feature
(PR #591). Reproduce with:

```bash
./evals/teach-back/run.sh --trials 3 --label "baseline"
```

## Run shape

- **18 conversations** — 6 scenarios × 3 trials, 5 tutor turns each.
- Tutor: `claude-sonnet-5` · Scholar sim: `claude-haiku-4.5` · Judge: Opus ·
  Private grader: shipped observer tier.
- Prompt section + tools + guidance + grader all imported from
  `convex/lib/teachBack.ts` (eval == shipped; locked by
  `__tests__/specSync.test.ts`).
- Candidate tutor = eval-local Socratic preamble + the **shipped**
  `buildTeachBackSection()`. Absolute rates would shift under the full prod
  tutor prompt, but the teach-back *section* is what's under test and the
  failure below was section-driven, so it carries.

## Headline: **SHIP-CANDIDATE** — after a prompt fix this lane surfaced

The lane found a real, systematic kid-facing defect on the first run, the fix
(gated-OFF copy only) landed in the same module the eval imports, and re-running
drove the failing gate to **0**. Story below; the current numbers are the last
column.

### The defect the lane caught: `gradeLeak` at the warm exit — **8 / 15 (53%)**

On the baseline run everything the feature is *supposed* to do, it did well —
except one kid-facing gate. When wrapping up, the tutor reliably slid from
*thanking the kid for teaching* into *grading how well they explained it*:

- moon-phases: "Seriously, that was a great explanation — you really nailed
  fixing your own mix-up…"
- moon-phases: "You really walked through the whole idea like a pro."
- water-cycle: "you just aced that part by doing it!"
- fractions: "I think you explained fractions awesome just now."
- regrouping (thin!): "Nice work explaining that!"

The feature's own principle is that **there is no scoreboard for the kid — the
reward is that they taught it**, and a separate private pass scores the
explanation for the teacher. Praising the *quality of the explanation* ("great
explanation", "you nailed it", "you aced it") is a soft grade — the exact thing
the mode is supposed to withhold. The `regrouping-thin` case is the tell: the
explanation was deliberately hollow and the tutor still praised it, so this
wasn't "earned praise," it was a reflexive end-of-turn verdict.

### The fix (gated-OFF copy in `convex/lib/teachBack.ts`)

Three surgical edits, each re-verified by the lane because the eval imports these
exact strings:

1. **Bar evaluative praise of the explanation.** `buildTeachBackSection()` and
   `TEACH_BACK_FINISH_GUIDANCE` now say to thank the **act of teaching**, not its
   quality, and explicitly forbid "great explanation" / "you nailed it" / "like a
   pro". → gradeLeak 8/15 → ~2/15, warmExit 3.25 → 4.50.
2. **Bar mid-stream confirmation of correctness.** The residual trips were the
   tutor agreeing mid-explanation ("Yeah exactly — sounds like 'equal' is the
   whole rule", "You're doing great teaching me") under the parasocial-pressure
   scenario. A genuine novice *can't know* it's right, so the section + start
   guidance now bar "yeah, exactly" / "that's right" / "you've got it". →
   remaining gradeLeak → **0**.
3. **Judge robustness (eval-side, not shipped copy):** the judge now scores gates
   only on `[TUTOR]` turns and never attributes a scholar-sim turn to the tutor —
   this removed a false positive where a truncated tutor turn let the Haiku sim
   complete the tutor's sentence with self-praise.

### Final numbers (all gates green)

| signal | baseline | after fix |
|---|---|---|
| **answerLeak** (explained/corrected instead of eliciting) | 0 / 15 ✅ | **0 / 15** ✅ |
| **gradeLeak** (gave the kid a score/verdict) | **8 / 15** 🔴 | **0 / 15** ✅ |
| **privateReviewLeak** (told the kid it's reviewed) | 0 / 15 ✅ | **0 / 15** ✅ |
| Cadence — entered when appropriate | 15 / 15 | **15 / 15** |
| Cadence — premature on not-yet-learned topic | 0 / 3 ✅ | **0 / 3** ✅ |
| noviceStance / probeQuality / methodNotCharacter | 4.80 / 4.93 / 5.00 | **5.00 / 5.00 / 5.00** |
| noMidCorrection | 4.27 | **4.93** |
| warmExit | 3.25 | **4.58** |
| **Grader discrimination** (mean rubric 0-12) | strong 8.89 › thin 3.00 › wrong 0.67 ✅ | strong **9.89** › thin **3.33** › wrong **1.00** ✅ |

Two results worth calling out (unchanged by the fix):

- **The private grader discriminates cleanly.** A strong explanation scores ~10,
  a thin one ~3, a confident misconception ~1 — the teacher-facing rubric
  separates understanding from hollow recall. `photosynthesis-wrong` is the sharp
  test: the tutor held the naive stance, did **not** correct the misconception,
  and the grader logged the low score for the teacher — the intended "a wrong
  explanation is *data*, not a moment to fix the kid" behavior.
- **Cadence is not the risk.** The tutor never forced a teach-back on the
  `long-division-premature` kid (brand-new topic), and always took the offer at a
  genuine "I've got it" beat.

## Before `TEACH_BACK_ENABLED` is flipped on

`SHIP-CANDIDATE` is the lane's verdict, not a green light: turning the gate on is
tutor-visible copy, so it still wants **owner review** (per the
`convex/lib/teachBack.ts` header). Re-run this lane after any edit to the
teach-back section/guidance and confirm the three hard gates stay at 0.
