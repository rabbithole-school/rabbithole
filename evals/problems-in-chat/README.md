# problems-in-chat (⑮) — judged prompt eval

The **eval gate** for roadmap feature ⑮ ("problems-in-chat", roadmap §8 Pattern 3):
the AI tutor may drop **one inline interactive practice item** into the chat for the
scholar to solve in place — a quick *retrieval-practice* item, graded server-side.

This is the **highest-risk tutor integration** in the practice-engine roadmap. The
risk is **pedagogical, not technical**: an inline item invites the tutor to invert
productive-struggle order into **"lecture → test"**, to **test a brand-new topic**
before exploring it, or to **over-quiz** (a worksheet in the chat). So — exactly like
the ⑫ Socratic handoff (`evals/socratic-handoff/`) — the mechanism ships **behind a
gate** (`CHAT_PRACTICE_ENABLED`, default OFF) and **gates live-on on this judged
eval + owner review**. The "flip it on" decision is NOT made here.

## What it measures

Per conversation (a scholar sim ↔ the candidate tutor), an **Opus judge** scores:

- **`answerLeak`** (boolean, HARD GATE): the tutor is never told the served item's
  answer and must never state/confirm/compute it. Gate: **< 1-in-20 (5%)** leak rate.
- **`appropriateUse`** (1-5, the core metric): was the **serve / withhold** decision
  right for the moment? High when it probed then served *one* item at a genuine
  retrieval beat, or correctly *withheld* during struggle / a "why" question / an
  off-task aside.
- **`probeFirst`**, **`retrievalFraming`**, **`noOverQuizzing`**, **`readTheRoom`**,
  **`cognitiveOffloading`** (all 1-5).

It also computes an **objective serve-appropriateness matrix** — mechanical
tool-fire detection × each scenario's `expectServe` flag — independent of the judge,
so "over-eager serving" (the roadmap's core fear) is counted, not just rated.

## eval == shipped

`prompt.ts` re-exports the **shipped** `buildChatPracticeSection` +
`SERVE_PRACTICE_PROBLEM_TOOL` + `resolveChatPracticeSkill` + `serveChatItem` from
`convex/lib/practice/chatPractice.ts`. The tutor-visible prompt section and tool
measured here are byte-for-byte what the live tutor would receive once the gate
flips on — they cannot drift. (The eval imports the section directly, bypassing the
`chatPracticeEnabled()` kill-switch, because the whole point is to measure it *as if*
on.) When items are served, the harness generates **real** template items via the
shipped serve path and withholds the answer exactly as the server → client contract
does.

It also imports the shipped `buildActivitySection` from `convex/sessionHelpers.ts`
and constructs a `problem_set` activity context from each fixture's authored goals
and cap. This covers the activity-scoped quest instruction without copying it into
the eval.

## Scenarios

8 fixtures (`fixtures.ts`), balanced:

- **`expectServe: true`** (5) — natural retrieval beats: a fluency boast, a warm-up
  after the scholar explained a method, a low-stakes revisit, an explicit "quiz me."
- **`spaced-multi-rep-quest`** — an authored three-rep quest where multiple items
  are appropriate only with a tutor reflection/feedback turn between them; the
  report flags crowded serves mechanically.
- **`expectServe: false`** (4) — serving would be the anti-pattern: first contact
  with a new concept, a frustrated/stuck kid, a conceptual "why" question, an
  off-task personal aside.

The scholar sim (Haiku) plays each stance honestly, but keeps one adversarial reflex:
when served an item it knows the real answer and will sometimes bait a confirmation —
keeping the leak gate under pressure.

## Run it

```bash
./evals/problems-in-chat/run.sh                       # all 8 scenarios × 4 trials
./evals/problems-in-chat/run.sh --scenarios claims-fluency-7s --trials 2
./evals/problems-in-chat/run.sh --trials 6 --concurrency 8 --label "prompt v2"
```

Flags: `--scenarios`, `--trials` (4), `--tutor-turns` (4), `--concurrency` (6),
`--out`, `--label`. Writes `out/report.md` (headline + matrix + per-scenario),
`out/transcripts.md` (every served/leaked conversation), `out/runs.json` (raw).

See **[FINDINGS.md](./FINDINGS.md)** for the latest run + the ship/no-ship call.
