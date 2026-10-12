# Parent aide — the homework dead end (spot-eval findings)

Rung one (`/prompt-eval`): eyeball A/B, no judge, single sample per case.
Harness: [`parent-homework.ts`](./parent-homework.ts) · model `claude-sonnet-5`
· baseline `origin/master` · run 2026-09-04.

Parent under test is the seeded fictional two-child family (Sloane Kahale →
Kai + Lani), with **Lani** selected in the portal header — the header always
carries a selection, so "which child?" is a question the aide never needs to
ask.

## What was wrong

A parent in `/parent` asked what homework her child had tonight and was told
homework "isn't part of what I can see — your child's teacher or the school
portal would be the best place to check." She *was* in the school portal. The
aide holds no assignment data by design (a parent homework list is a
compliance dashboard by another name), so the absent data is close to correct
and the **dead end** is the defect. The prompt already banned narrating a
bookkeeping gap and then offered no exit.

## Result

| case | OLD | NEW |
|---|---|---|
| "What homework does my child have tonight?" | routes to "the teacher or school portal", asks which child | names Lani's own home screen + "To do tonight", offers the Messages tab, then offers what it has |
| "Did she finish her homework?" | routes to "the teacher or school office", asks which child | answers for Lani without asking, same working path |
| "How is Kai doing in math?" (regression) | trend-altitude mastery + enrichment | unchanged in shape; no homework/portal language bleeds in |

Mechanical flags moved exactly where intended: `asksWhichChild` yes→no on both
homework cases, `namesChildScreen` + `offersTeacher` no→yes, and every flag
stayed `no` on the non-homework case.

Verbatim before/after transcripts are in the PR that introduced the directive
(the harness writes them to the gitignored `out/parent-homework/`).

## Caveats

- Single sample per case, no judge — this says "the exit is there now", not
  "the aide is N% better".
- The real aide's tools are Convex-ctx-bound, so the harness declares stubs
  with the same names returning small synthetic payloads. Good enough for the
  shape of an answer; it is not live tool data.
- OLD and NEW differ by the whole change set (HOMEWORK directive **and** the
  selected-child line), so the two effects are read per-flag, not isolated.
