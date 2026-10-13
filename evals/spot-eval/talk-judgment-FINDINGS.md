# Observer talk judgment — spot-eval findings (TRA-515)

**Question.** Is the observer's new per-session `talkLevel` calibrated well enough to drive the profile's "Sessions suggest grade N · Use / Keep" line? That line fires when the median of the last 5 judged sessions is at least a full grade off the teacher's setting. T6 requires calibration before a threshold ships. **Target:** |mean signed error| ≤ 0.5 grade, and at least 80% of answered runs within ±1 grade of the expected grade.

**Change.** `talkLevel` on `OBSERVER_TOOL` plus section 7b of the observer system prompt.

**Scripts.** `talk-judgment.ts` holds 10 authored synthetic transcripts (no production wording) spanning K–8:
- spoken-only, typed-only, mixed, and heavily misspelled;
- one gifted 6-year-old carrying an infinity idea in plain words.

Each script's `expected` grade (K = 0) is committed in the script. The expected grades were written down before the reframed prompt was run, and judge the language alone.

**Runs.** The script calls the real observer:
- `claude-sonnet-5`, real system prompt, tool schema and transcript builder;
- `validTalkJudgment` with the 100-word floor counted by `scholarWordCount`;
- 3 runs per script, so 30 runs per row.

"Signed error" is grade − expected over the runs that gave a grade. Omitted runs are counted separately.

| prompt | answered | mean signed error | within ±1 | target |
|---|---:|---:|---:|---|
| v1 "grade of the ideas and vocabulary", 4 scripts (pre-widening) | 1 / 12 | — | — | — |
| v2 + "fill it in" + spoken carve-out, 4 scripts | 8 / 12 | ≈ +1.5 (4 vs 1–2, 8 vs 5–7) | — | no |
| **v3** "grade a typical child would produce this LANGUAGE", band snippets, 10 scripts | 19 / 30 | +0.58 | 89% | no |
| **v4** = v3 + `talkLevel` required + "when torn, the lower" + whole grades — run A | 30 / 30 | +0.45 | 90% | met |
| v4 run B | 30 / 30 | +0.48 | 90% | met |
| v4 run C (bare-number answers now coerced) | 29 / 30 | +0.53 | 83% | no |
| v5 = v4 + "a long and-then chain is still K–2" (reverted: no gain) | 27 / 30 | +0.43 | 85% | met |

Per script, v4 runs A–C pooled (expected → grades):

| script | expected | grades | spread per run | scholar words | stored (≥100) |
|---|---|---|---|---|---|
| k-spoken-short | K–1 (0.5) | 1,1,2 · 1,2,1 · 2,2,1 | ≤1 | 29 | 0 |
| gifted-6yo-big-idea-plain-words | 1–2 (1.5) | 3,2,3 · 3,2,2 · 3,3,2 | ≤1 | 86 | 0 |
| young-long-dictation | 2 | 3,3,3 · 3,3,4 · 3,4,3 | ≤1 | 105 | all |
| g2-typed-misspelled | 2 | 2,2,2 · 2,2,3 · 3,2,2 | ≤1 | 74 | 0 |
| g3-mixed | 3 | 4,4,4 · 4,4,4 · 4,4,4 | 0 | 80 | 0 |
| g4-typed | 4 | 5,5,4 · 5,5,4 · 4,—,5 | ≤1 | 106 | all |
| g5-spoken | 5 | 5,5,5 ×3 | 0 | 123 | all |
| g5-typed-misspelled | 5 | 5,5,5 · 5,5,6 · 5,5,5 | ≤1 | 95 | 0 |
| g6-7-typed-fluent | 6–7 (6.5) | 6,6,6 · 6,6,6 · 7,6,6 | ≤1 | 149 | all |
| g8-typed-argument | 8 | 8,9,8 · 8,8,8 · 8,8,8 | ≤1 | 129 | all |

## Reading it

- **Reframing to language fixed most of the bias.** v2 judged ideas and ran about 1.5 grades high. v3/v4 judge the language and run about +0.5. Grades 5–8 are now on target. Misspelling no longer moves the grade.
- **The remaining bias sits exactly where it matters.**
  - At K–3 the judgment runs about **+0.8 grade high**: every young or gifted script lands one grade above expected, run after run.
  - At 5–8 it is about **0**.
  - The overall mean straddles the target (+0.45, +0.48, +0.53, +0.43) only because the older scripts pull it down.
  - With a full-grade gate, a young scholar set at their true talk level would sit right on the edge of a "suggest higher" prompt. That is the reverse of the August failure.
- **The v5 tweak didn't move it.** I added "a long chain of and-then clauses is still K–2". It did not change the young-band bias (+0.43 overall, same K–3 pattern), so I reverted it.
- **Omission is fixed.** Making `talkLevel` required took answered runs from about 63% to about 100%. Thin samples are already set aside by the 100-word floor.
- **The 100-word floor excludes short sessions.** Of the 10 scripts, only the 5 longest clear it (105–149 words). The short young sessions (29–86 words) never store a judgment. In production the floor counts over the observer's last-30-message window, so longer sessions clear it more easily. How often it is met on real sessions is still unmeasured.
- **Stored judgments skew toward longer sessions.** The floor keeps only sessions with 100+ scholar words, and long, talkative sessions are also where the observer graded highest (`young-long-dictation`: 3–4 vs 2). So the stored series over-represents a scholar's most fluent sessions, which would bias it upward even after the K–3 fix.

## Decision

**Not shipped as a suggestion.** The overall target is borderline: it was met on 2 of 3 v4 runs. The miss is concentrated at K–3, in the direction of pushing young scholars' talk levels up. So the PR takes the fallback:

- the observer keeps judging, and the judgment is stored and plotted in the growth chart's Talk lane — on a fixed K–8 scale with **no grade numbers** in the caption or hovers;
- the **"Sessions suggest · Use / Keep" line is not built**: the suggestion rule, Keep mutation and its user field are removed;
- TRA-521 restores the numbers and the line once the judgment is calibrated. The removed design is shelved on the issue: median of the last 5 judged sessions, a full-grade gap, Use through `updateReadingLevel`, Keep until the evidence moves.

**What would calibrate it:** expected grades set by teachers (or a language-level rubric) on real, consented-for-eval young sessions, not my synthetic labels. With those, either correct the prompt's K–3 anchors or subtract a measured young-band offset before comparing against the setting.
