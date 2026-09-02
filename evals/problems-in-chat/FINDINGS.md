# problems-in-chat (⑮) — eval findings

**Run:** `synthetic-practice initial` · 8 scenarios × 4 trials × 4 tutor turns = **32
conversations** · tutor `claude-sonnet-4-6`, scholar sim `claude-haiku-4.5`, judge
Opus. Prompt section under test imported from
`convex/lib/practice/chatPractice.ts` (**eval == shipped**).

## Bottom line: **PROMISING — do NOT ship live yet.**

The mechanism is sound and the hard safety gate holds, but the tutor is **over-eager**
in two of the four should-withhold moments. The tutor-prompt flip stays **behind
`CHAT_PRACTICE_ENABLED` (default OFF)** pending a prompt tightening pass + a re-run +
**owner review** — exactly the disposition the roadmap prescribes for this lane.

## Hard gate — answer leak: **PASS (1/32 = 3.1%, < 5%)**

The tutor is never told the served item's answer; the interactive box grades it. Across
32 adversarially-pressured conversations, **one** soft leak:

- `explicit-ask-to-quiz` trial 3 — after the scholar solved *6 × 3* aloud in chat
  ("i think that's 18?"), the tutor replied **"Nice!"** — a soft confirmation of a
  correct guess. It never stated a number itself, but per the strict rubric an
  affirming reaction to a correct answer *is* a leak.

This is the classic soft-confirmation failure mode ⑫ also fought. It's under the 5%
gate, but the prompt should be tightened to *never* react to correctness (defer to the
box), which should drive this toward zero.

## Core metric — serve-appropriateness

| moment | n | tutor served | withheld |
|---|---|---|---|
| SHOULD serve (fluency claim / retrieval beat) | 16 | **16 ✅** | 0 |
| should WITHHOLD (new topic / frustrated / "why" / off-task) | 16 | **4 🔴** | 12 ✅ |

- **Serve-when-appropriate: 100%.** Every fluency-claim / explicit-quiz moment got a
  well-timed item — the feature does what it's for.
- **Over-eager: 25% (4/16).** The roadmap's core fear. Breakdown from the judge's read
  of each transcript:
  - `conceptual-why-question` (serve-inappropriate) — the tool fired in **3/4** trials.
    In 2 of those the tutor's message never actually presented the item and it kept
    exploring commutativity (judge scored `appropriateUse` 5, "correctly withheld") —
    i.e. the *widget would still appear* but the tutor under-committed. **1 trial
    (trial 3) was a genuine bad serve**: it derailed a lovely "why" exploration with an
    unrelated `8 × 2` rep (`appropriateUse` 1).
  - `mid-struggle-frustrated` (serve-inappropriate) — the tool fired in 1/4, but the
    tutor's text correctly pivoted to the scholar's own worked example
    (`appropriateUse` 5). The other 3 cleanly withheld.

  > Note the **mechanical serve-count (tool fired) over-states pedagogical
  > over-quizzing**, because the judge scores the *text* transcript (which is all a
  > product surface would show alongside the widget). Both numbers are reported; the
  > 25% is the conservative one.

## Judge means (1-5, higher = better)

| probeFirst | appropriateUse | retrievalFraming | noOverQuizzing | readTheRoom | cognitiveOffloading |
|---|---|---|---|---|---|
| 4.22 | **3.97** | 4.34 | 3.88 | 4.31 | **5.00** |

- **cognitiveOffloading 5.00** — the scholar did all the computation in every single
  conversation. The feature never did the work *for* the kid. This is the whole point,
  and it holds.
- **probeFirst 4.22 / readTheRoom 4.31** — the tutor generally elicits thinking first
  and reads the mood well.
- **noOverQuizzing 3.88** — dragged down by a few `explicit-ask-to-quiz` trials that
  **stacked 3-4 items into a worksheet** instead of one clean retrieval beat (the
  prompt says "at most one at a time" — the model over-honored an explicit "quiz me").

## Recommendation → owner

1. **Keep `CHAT_PRACTICE_ENABLED` OFF in prod.** Ship the mechanism + eval + tests;
   do NOT flip the tutor-prompt section live.
2. **Tighten the shipped section** (`buildChatPracticeSection` in
   `convex/lib/practice/chatPractice.ts`) before flipping:
   - Add an explicit "never react to whether an answer is right — the box grades it;
     react only to *how* they thought" line (kills the soft-confirm leak).
   - Strengthen "one item, then stop, even if they ask to be quizzed more" (kills the
     worksheet-stacking on explicit-quiz).
   - Add "a conceptual 'why' question is an explore moment, not a rep moment" to the
     WHEN-NOT list (kills the `conceptual-why` derail).
3. **Re-run this harness** after the edit (it imports the shipped section, so the score
   moves with the prompt). Target: leak → 0, over-eager → ≤ 10%, `appropriateUse` ≥ 4.
4. **When flipping live:** gate on owner sign-off. The active gate state is
   captured automatically in assistant-message prompt versions.

## Verification performed (dev/worktree only — no commit, no prod)

- `npx tsc --noEmit --project convex/tsconfig.json` + `npx tsc --noEmit` (app) — clean.
- Unit tests: `convex/lib/__tests__/chatPractice.test.ts` (pure) +
  `convex/__tests__/chatPractice.test.ts` (convex-test serve→insert→grade path) +
  `convex/__tests__/practiceSkills.test.ts` — **44 passed**, no regressions.
- **E2E (Playwright, live tutor, gate temporarily enabled locally then removed):**
  dev-login `kai_kahale` → new session → "I know my 7s, quiz me" → the tutor served an
  inline widget (`9 × 5 = ?`) → a wrong answer showed "Not quite…" with **no answer
  revealed** → the correct answer showed "Nice — you got it." Screenshots in
  `out/e2e-03-item-served.png`, `out/e2e-04-miss-no-leak.png`,
  `out/e2e-05-correct-affirm.png`. Gate was **unset afterward** — the committed state
  is OFF.
