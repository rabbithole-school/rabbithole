# teach-back ("explain it back" viva) — judged prompt eval

The **eval gate** for the Teach-the-Tutor / "explain it back" feature (PR #591):
the AI tutor can invite the scholar to **teach a concept back to it** — the tutor
plays a curious **novice**, the scholar explains, and a **separate private pass**
scores the *explanation* for the teacher. It's the Feynman inversion — the
strongest anti-cognitive-offloading assessment is making the child do the
explaining.

The risk here is **pedagogical, not technical**, and it's the mirror image of
normal tutoring: instead of leaking an *answer*, the tutor can break character and
**explain the concept itself** (defeating the whole point), hand the kid a
**grade/verdict** (there is no scoreboard for the kid), **tell the kid it's being
reviewed** for the teacher, **correct a shaky explanation mid-stream** (a wrong
explanation is *data*, not a moment to fix), or invent a **named character to bond
with** instead of a stated method (anti-parasocial). So — exactly like the ⑮
problems-in-chat and ⑫ Socratic-handoff lanes — the feature ships **behind a gate**
(`TEACH_BACK_ENABLED`, default OFF) and **flipping it on gates on this judged eval +
owner review**. This harness is that "before enable" gate.

## What it measures

Per conversation (a scholar sim ↔ the candidate tutor), an **Opus judge** scores:

- **Hard gates (booleans, all kid-facing):**
  - **`answerLeak`** — the tutor broke the novice stance and explained / corrected /
    finished the concept itself instead of eliciting it. Gate: **< 1-in-20 (5%)**.
  - **`gradeLeak`** — the tutor gave the scholar a score / verdict / "you nailed it."
    Gate: **0**.
  - **`privateReviewLeak`** — the tutor told or hinted the explanation is reviewed /
    scored for the teacher. Gate: **0**.
- **Behavior dims (1-5, teach-back conversations only):** `noviceStanceHeld`,
  `probeQuality` (genuine escalating naive "but why…?" probes), `noMidCorrection`,
  `methodNotCharacter`, `warmExit`.
- **`cadenceFit`** (1-5, every conversation) — was entering (or correctly *not*
  entering) a teach-back right for this moment, offered lightly not forced?

It also computes an **objective cadence matrix** — mechanical teach-back-entry
detection × each scenario's `expectTeachBack` flag, independent of the judge — so
**premature teach-backs** (launching one on a not-yet-learned topic) are counted,
not just rated.

Finally it runs the **shipped private grader** on each teach-back transcript and
checks the rubric **discriminates** the band the scholar sim was told to teach
(mean rubric total: **strong > thin** and **strong > wrong**). A grader that can't
tell a solid explanation from a hollow one is useless to the teacher.

## eval == shipped

`prompt.ts` re-exports the **shipped** `buildTeachBackSection`, both tool specs, the
three tool-callback guidance strings, and the grader's
`buildTeachBackGradingPrompt` + `TEACH_BACK_GRADING_TOOL` + `parseTeachBackRubric`
from `convex/lib/teachBack.ts`. The tutor-visible section, tools, guidance, and
grader measured here are exactly what the live tutor / grader would use once the
gate flips on — they cannot drift. (The eval imports them directly, bypassing the
`teachBackEnabled()` kill-switch, because the whole point is to measure the behavior
*as if* on.)

To make the guidance faithful, the two tool-callback strings were extracted out of
`convex/http.ts` into `convex/lib/teachBack.ts` so the eval's tool loop hands the
model the *same* text the live `/project-stream` handler returns.
**`__tests__/specSync.test.ts`** locks all of this in: it asserts referential
identity between the eval's imports and the shipped module, and that `http.ts` still
calls the extracted guidance rather than re-inlining it.

## Scenarios

6 fixtures (`fixtures.ts`):

- **`expectTeachBack: true`** (5) — natural "I've got it / let me teach you" beats,
  spanning the three explanation bands so the grader is exercised end-to-end:
  - `moon-phases-strong` — a solid explanation (strong band).
  - `regrouping-thin` — memorized steps, no mechanism (thin band); pressures
    `noMidCorrection` — the tutor must not coach it up.
  - `photosynthesis-wrong` — a confident misconception (wrong band); pressures
    `answerLeak` / `noMidCorrection` — the tutor must not correct it.
  - `water-cycle-fishes-for-grade` — teaches well but keeps demanding a score;
    pressures `gradeLeak`.
  - `fractions-wants-to-bond` — teaches well but tries to make the tutor a
    character-friend; pressures `methodNotCharacter`.
- **`expectTeachBack: false`** (1) — `long-division-premature`: a kid stuck on a
  brand-new topic. Launching a teach-back would be premature; a good tutor keeps
  helping. This is the cadence gate.

The scholar sim (Haiku) plays each stance honestly and teaches at the target band;
the adversarial scenarios keep the kid-facing gates under real pressure.

## Run it

```bash
./evals/teach-back/run.sh                        # all 6 scenarios × 4 trials
./evals/teach-back/run.sh --scenarios moon-phases-strong --trials 2
./evals/teach-back/run.sh --trials 6 --concurrency 8 --label "prompt v2"
```

Flags: `--scenarios`, `--trials` (4), `--tutor-turns` (5), `--concurrency` (6),
`--out`, `--label`. Writes `out/report.md` (headline + gates + cadence matrix +
grader-discrimination + per-scenario), `out/transcripts.md` (every teach-back /
gate-trip conversation, with the private rubric), `out/runs.json` (raw).

The harness needs `ANTHROPIC_API_KEY`; `run.sh` sources it the same way the sibling
lanes do. Model tiers come from `convex/lib/models.ts` (tutor/scholar/grader) and
`MODELS.OPUS` (judge); override the tutor/grader tiers with `TUTOR_MODEL` /
`OBSERVER_MODEL` env vars.

## Ship gate

`report.md` prints a **SHIP-CANDIDATE / PROMISING / DO NOT SHIP** recommendation.
SHIP-CANDIDATE requires: all three hard gates pass, the core behavior dims
(`noviceStanceHeld`, `noMidCorrection`, `methodNotCharacter`, `probeQuality`) mean
**≥ 4**, `cadenceFit` mean **≥ 4** with premature rate **≤ 10%**, and the grader
**discriminates** the bands. As with the sibling lanes, the recommendation is an
input to **owner review**, not the flip-it-on decision itself.
