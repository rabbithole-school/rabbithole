# Spot-eval — manipulative Socratic handoff prompt (U-4)

Structured spot-eval (no judge), per [`rabbithole-prompt-evals.md`](../../.agents/skills/prompt-eval/SKILL.md), gating the new
`buildManipulativeHandoffPrompt` (`convex/lib/practice/handoff.ts`). Single-branch: there is no
OLD manipulative handoff prompt to A/B against (it is brand-new for U-4), so we run the NEW
prompt over synthetic manipulative-MISS cases and check the two things that gate the change:
**(1) zero solution-leak** and **(2) a board-grounded Socratic opener**.

- Model: `claude Sonnet (MODELS.SONNET)`
- Reproduce: `ANTHROPIC_API_KEY=... npx tsx evals/spot-eval/manipulative-handoff.ts`
  (this run was driven server-side via the deployment key; the committed harness is the tsx runner).
- The `task`/`board` handed to the prompt are the pure describers (`goalText`/`describeState`),
  already proven no-leak in `lib/manipulative/__tests__/describers.test.ts`.

## Verdicts

| Case | Solution leak? | Socratic (asks `?`) | Board-grounded | Verdict |
|---|---|---|---|---|
| distributor — remainder confusion (17 ÷ 5) | no | yes | yes | ✅ PASS |
| dotBlaster — wrong split (group of 10 from 13) | no | yes | yes | ✅ PASS |
| protractor — off-by-30 misread (measure 70°) | no | yes | yes | ✅ PASS |
| balance — pans unequal (mystery block = 4) | no | yes | yes | ✅ PASS |

**Result: 4/4 PASS.** Every opener stayed off the derived answer, asked about the
kid’s own board/thinking, and named what was actually on the board — the U-4 gate is met.

## Transcripts

### distributor — remainder confusion (17 ÷ 5)

- **Task handed to tutor** (`goalText`): Deal all 17 counters onto 5 equal plates, dealing as many full rounds as you can so every plate holds the same amount.
- **Board handed to tutor** (`describeState`): Each of the 5 plates holds 2 counters right now, and 7 counters are still in the leftover pile.
- **Wrong attempts:** 2
- **Derived answer** (never given to the model): 3 on each plate, remainder 2
- **Scholar opener:** “i keep getting it wrong. i put 2 on each plate but it says not yet”

**Tutor reply:**

> Okay, let's look at this together! You've got 2 on each of the 5 plates, and 7 counters just sitting in the leftover pile.
> 
> Here's the question I'd ask you: does that leftover pile still have enough counters to give every plate another one?
> 
> Try it out — see what happens if you deal one more round to those 5 plates.

_Flags: leaked=false, askedQuestion=true, groundedInBoard=true → PASS_

### dotBlaster — wrong split (group of 10 from 13)

- **Task handed to tutor** (`goalText`): Blast the 13 dots into two groups so that ONE group holds exactly 10 dots.
- **Board handed to tutor** (`describeState`): The laser has 7 dots on the left and 6 on the right.
- **Wrong attempts:** 2
- **Derived answer** (never given to the model): 10 on one side, 3 on the other
- **Scholar opener:** “i split them but its not right”

**Tutor reply:**

> Hey, no worries! You've got 7 on one side and 6 on the other — that's all 13 dots, nice counting.
> 
> So let's check: is one of those piles exactly 10 dots? Look at the left pile with 7 — is that 10? And the right with 6 — is that 10?
> 
> What do you think needs to happen to make one side land right on 10?

_Flags: leaked=false, askedQuestion=true, groundedInBoard=true → PASS_

### protractor — off-by-30 misread (measure 70°)

- **Task handed to tutor** (`goalText`): Slide the reading marker around the protractor to MEASURE the angle that's already drawn on the page.
- **Board handed to tutor** (`describeState`): The reading marker is reading 40° right now.
- **Wrong attempts:** 2
- **Derived answer** (never given to the model): 70°
- **Scholar opener:** “i think its 40 degrees but it says im wrong”

**Tutor reply:**

> Okay, so your marker says 40° — let's look at *why* it says that. Can you tell me: which line of the angle did you line the marker up with, the bottom one or the top one?
> 
> Also, take a peek at the protractor itself — does it have two rows of numbers on it (one going one way, one going the other way)? Sometimes there's a 40 on one side and a different number right across from it on the same spot.
> 
> Check that and tell me what you find!

_Flags: leaked=false, askedQuestion=true, groundedInBoard=true → PASS_

### balance — pans unequal (mystery block = 4)

- **Task handed to tutor** (`goalText`): Add or remove unit weights until the two pans balance — one pan hides a mystery block, so figure out how heavy it must be.
- **Board handed to tutor** (`describeState`): The left pan holds 2 and the right pan holds 1 (the right pan also hides a mystery block); the beam tips down on the right right now.
- **Wrong attempts:** 1
- **Derived answer** (never given to the model): left pan needs 5 (the mystery block is worth 4)
- **Scholar opener:** “its still tipping and i dont know why”

**Tutor reply:**

> Hey, let's look at it together. Right now: left pan has 2 units, right pan has 1 unit plus the hidden block — and the right side is dropping down. What does it mean when a pan drops down like that, heavy or light?

_Flags: leaked=false, askedQuestion=true, groundedInBoard=true → PASS_
