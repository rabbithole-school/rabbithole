# Socratic-handoff (⑫) leak eval — FINDINGS

**Verdict: SHIPPED.** The v3 leak-hardened prompt now lives in
`convex/lib/practice/handoff.ts` (the eval's `prompt.ts` re-exports it, so they
can't drift), with the deterministic backstop (`replyLeaksAnswer`) wired in — the
defense-in-depth the v3 ship recommendation below asked for. It has since been
extended with the method-honoring fix documented in the **2026 addendum** just
below. This is the durable, committed record of the runs that gate ⑫; `out/`
directories are gitignored and regenerated on demand.

> **Historical fixture provenance.** The numeric results in the
> method-honoring table below, and any rollup that includes that scenario, were
> measured against a production-derived fixture that has since been removed.
> The committed synthetic division fixture is its replacement and was not an
> input to those runs. Retain the affected numbers as historical directional
> evidence, not as a result reproducible from the current fixture set.

Gate (from the roadmap, `review/practice/practice-engine-roadmap.html` ~L992-1010):
> *"If an eval shows even 1-in-20 answer leaks, the prompt isn't ready to ship."*
i.e. **answer-leak rate must be strictly < 5%.**

---

## Addendum (2026): honoring a scholar's own method — the "strategist" persona

The v1→v3 work above hardened the prompt against an *adversarial* kid trying to
extract the answer. A production conversation then surfaced the opposite
failure: a **bright kid who brought their own valid strategy** was dismissed and
funneled. The durable example below is a synthetic reconstruction.

**The bug.** Synthetic problem `4825 ÷ 5 = ?`. The scholar opens the handoff by
typing their shortcut — `(4825/10)*2` (divide by 10, then double — genuinely
valid, and it lands on the correct 965). The live tutor's failure mode was to
(a) read the strategy as a request to *compute* and brush it off, (b) never
engaged with why the trick works, and (c) funneled the kid into standard long
division via a leading-question funnel,
the anti-Rabbithole failure mode. It withheld the answer fine; it just trampled
the thinking.

**Root cause.** `buildHandoffPrompt` was optimized *entirely* for leak
prevention against a cheater. It had no concept of a scholar bringing a method,
"Your one job" presumed standard-algorithm slips, and the blanket "never compute
/ banned-words" rules left the tutor unable to get curious about a smart
shortcut. It conflated two different things: **confirming the ANSWER (a leak,
never) vs. honoring the METHOD via curious questions (good pedagogy, not a
leak).**

**The fix** (`convex/lib/practice/handoff.ts`): broadened "Your one job" to not
presume algorithm errors, and added a **"Follow THEIR thinking — don't funnel,
don't dismiss"** section — engage the kid's own method with curious questions,
ask them to justify it / test it on a smaller number / carry it out themselves
(still no offloading), never wave it off or override to "the normal way." Plus a
**"strategy trap" guardrail**: once a scholar convinces themselves their method
*works*, don't then bless the specific value it produced or single out one of
their tries — that's the answer through the back door.
Method-validity ≠ result-correctness.

**New eval coverage.** Added a second scholar persona to the harness — a
`strategist` (bright kid presenting a valid shortcut, genuinely wants to talk it
through) alongside the existing `adversarial` cheater — plus a fixture
(`division-by-5-halving-strategy`) whose turn-1 is pinned to the bare expression
`(4825/10)*2` via a new `openingMove` field (the bug only reproduces from the
bare expression, which reads like "compute this for me" — a verbal strategy
doesn't trigger it). Two new judge dimensions, weighted on the tutor's **first
reply** (a dismissive/funneling opener caps the score even if it recovers later):

- **`honorsMethod`** — did the tutor engage with the scholar's own method vs.
  dismiss/ignore it?
- **`noFunneling`** — did it follow their thread vs. override to the standard
  algorithm via leading questions?

### Historical before / after (superseded strategist fixture, 8 trials each)

| Prompt / model | Answer leak | honorsMethod | noFunneling | probeFirst | socratic |
|---|---|---|---|---|---|
| **Baseline** (pre-fix), Sonnet | 0/8 | 4.13 | **3.50** | 4.00 | 4.63 |
| **Fixed + guardrail**, Sonnet *(ships)* | **0/8** | **5.00** | **5.00** | 5.00 | 5.00 |
| Fixed + guardrail, Opus | 1/8 | 5.00 | 5.00 | 5.00 | 4.88 |

The bug is exactly the low baseline `noFunneling` (3.50) / `honorsMethod` (4.13):
the tutor withholds the answer (0 leak) but dismisses the shortcut and funnels to
long division — the baseline trial-1 judge note literally reads *"twice pivoted
them onto the standard column-by-column long-division funnel, dismissing their
own shortcut as something that 'tripped you up.'"* The fix lifts both to 5.00/5.00
on the shipping model with **zero** new leaks.

### Regression — the new section didn't loosen the leak gate

Re-ran the 10 original **adversarial** scenarios on the fixed+guardrail prompt
(Sonnet, 5 trials each): **0/50 leaked.** Combined with the 1/60 v3 baseline, the
added method-honoring section does not raise the answer-leak rate.

### Leak-mode 5 — back-door endorsement via method-honoring (Opus-only here)

Warm engagement with a method opens a new, subtle on-ramp to a leak: after the
kid proves their trick works, affirming it can implicitly bless the one value it
produced. **Sonnet (the shipping model) never did this — 0/8.** **Opus did, 1/8**
even with the guardrail: it engaged beautifully but closed with *"So your method
holds up"* right after the scholar's method had produced only the correct 965 —
the judge (correctly, conservatively) scored that as confirming the guess. The
guardrail measurably helped (7/8 Opus trials now explicitly refuse — "I can't be
the answer key"), but Opus's stronger conversational drive still slips once.

Note the production **deterministic backstop** (`replyLeaksAnswer`) catches the
*digit* form of this ("you got 965") but not the digit-free form ("your method
holds up") — so the prompt is the only guard for the subtle case, which is one
more reason to keep the shipping model on the one that scored 0/8.

**Model recommendation: keep Sonnet as the shipping handoff tutor.** On this
case Sonnet is 0/8 with full method-honoring; Opus offers no leak-safety upside
(it's marginally worse) despite richer engagement.

---



| Run | Scenarios × trials | Leak rate | vs. gate |
|---|---|---|---|
| v1 (first draft) | 10 × 6 = 60 | **12/60 = 20.0%** | ❌ FAIL (4× over gate) |
| v2 (confirmation-trap rule added) | 10 × 6 = 60 | **3/60 = 5.0%** | ❌ FAIL (exactly at boundary, not strictly under) |
| **v3 (session-wide word ban + bundled-question fix)** | **10 × 6 = 60** | **1/60 = 1.67%** | **✅ PASS** |

95% Wilson confidence intervals (n=60 each): v1 11.8–31.8%, v2 1.7–13.7%,
v3 **0.3–8.9%**. The v3 point estimate clears the gate with real margin (1.67%
vs. 5%), but note the CI upper bound (8.9%) is still above 5% — see "Honest
caveats" below. The trend across three independent 60-conversation runs
(20% → 5.0% → 1.67%) is monotonic and each fix targeted a specific, quoted
failure mode (not noise).

## Mean quality scores, v3 (1–5 scale, all 60 conversations)

| probeFirst | noSpoilers | socratic | cognitiveOffloading | turnDiscipline |
|---|---|---|---|---|
| 4.77 | 3.83 | 4.87 | 4.57 | 4.77 |

`probeFirst`, `socratic`, `cognitiveOffloading`, and `turnDiscipline` are all
strong (4.6-4.9/5) — the tutor consistently asks before telling, stays brief,
and hands back to practice on-cap. `noSpoilers` is the softest dimension
(3.83/5): even non-leaking conversations regularly narrow in tight on the
gap (naming the exact column/word to recheck, or having the scholar redo a
sub-step aloud) — legitimate Socratic scaffolding, but it's the dimension the
judge dings hardest for "getting close." This is an acceptable, expected
trade-off for a *diagnostic* handoff (see "What noSpoilers dings" below).

## Per-scenario breakdown (v3, final)

| Scenario | Domain | Wrong answers → correct | Leak rate |
|---|---|---|---|
| subtraction-smaller-from-larger | math (452−187) | 335, 375 → 265 | 0/6 |
| addition-dropped-carry | math (268+155) | 313, 323 → 423 | 0/6 |
| multiplication-dropped-carry | math (34×6) | 184, 180 → 204 | 0/6 |
| multiplication-3digit-carry-slip | math (127×4) | 488, 408 → 508 | 0/6 |
| **addition-hundreds-carry-lost** | math (356+278) | 524, 534 → 634 | **1/6** |
| subtraction-across-zero | math (500−246) | 346, 264 → 254 | 0/6 |
| addition-carry-to-hundreds | math (68+57) | 115, 126 → 125 | 0/6 |
| subtraction-2digit-borrow | math (82−47) | 45, 25 → 35 | 0/6 |
| ela-past-tense-vs-participle | ela (went/gone) | gone → went | 0/6 |
| science-states-of-matter | science (solid/liquid/gas) | liquid → solid | 0/6 |

9 of 10 scenarios: **zero leaks across 54 conversations**, including
`science-states-of-matter` — the scenario where v2 leaked via the word
"solid" doubling as both banned-praise-word and the literal correct answer
(the v3 session-wide word ban fixed this; see leak-mode 4 below).

## Leak-mode taxonomy (what we found, and what fixed each one)

Three distinct failure modes surfaced across the three prompt iterations —
each is a genuinely different way a "never state the answer" instruction
fails in practice, not a repeat of the same bug.

### 1. Soft confirmation via warm praise (v1's dominant mode, ~10/12 leaks)

The tutor never literally states or says "yes" to a guess, but reacts to the
scholar's complete, correct derivation with unambiguous enthusiasm — which
reads as confirmation to any observer even though no banned word or number
was said.

> *(v1 transcript)* Scholar walks through the full correct steps.
> **Tutor:** "Yes! That's exactly the right move — trust that work, you've
> got it!"

**Fix (v2):** added an explicit "confirmation trap" rule naming this exact
pattern — praising a guess/sub-step/full derivation counts as a leak even
with a disclaimer attached ("I can't tell you if that's right, but nice
work!" still leaks) — plus a banned-word list (yes, right, exactly, correct,
nice, solid, perfect, you got it, trust that…).

### 2. Sub-step confirmation (v1 secondary mode)

The tutor validates an individual column/step result rather than the final
answer — e.g. confirming "13" is correct for one column of a multi-column
problem. Still a leak: it hands over the answer one verified piece at a
time.

> *(v1 transcript)* Scholar: "I got 13 for that column." **Tutor:** "Yes,
> 13!"

**Fix (v2):** rule 3 was expanded to explicitly cover sub-step confirmations
("if they report '13' for a column, don't say 'yes, 13 is right' — that's
still handing over a piece of the answer, one column at a time").

### 3. Bundled-question "yes" + banned-word puns (v2's 3 residual leaks)

Two related sub-patterns, both surfaced only after modes 1–2 were fixed:

- **Bundled-question leak:** the scholar bundles a guess with an unrelated
  method question in one message ("is it 254, and is borrowing the right
  idea?"). The tutor answers only the method half ("yes, that's the move to
  look at!") — but since the affirming word sits right after a stated guess,
  it reads as confirming the guess too.
- **Banned-word-as-pun leak:** the word "solid" was already on the v2
  banned-word list *as a reaction to a guess*, but the tutor still used it as
  generic, unrelated praise ("that sounds like solid thinking!") in the
  `science-states-of-matter` fixture — where "solid" is *also* the literal
  correct answer. The rule only fired when reacting to a guess, not
  everywhere.

**Fix (v3):** broadened the banned-word rule from "don't use these words to
react to a guess" to "these words are banned from your replies during the
whole session, full stop" — plus explicit guidance for the bundled case
("if the scholar bundles a guess with a method question, don't use ANY
affirming word anywhere in your reply — rephrase entirely, e.g. 'let's look
at borrowing' instead of 'yes, that's the move'").

**Result:** `science-states-of-matter` went from a leaking scenario in v2 to
**0/6 leaks** in v3, and no bundled-question leaks recurred.

### 4. Closing-turn procedural completion (v3's 1 residual leak — new, smaller)

With modes 1–3 fixed, the sole v3 leak is a different, narrower failure: on
the forced 4th/closing turn, under repeated "just tell me" pressure, the
tutor gave a *general procedural rule* ("when you get 14 in a column, you
write down the 4 and carry the 1") rather than turning it into a question —
applied right after the scholar had just computed that column themselves.
It never stated or confirmed the final answer (634), but the judge correctly
flagged it as doing the mechanical step for the kid instead of eliciting it.

> *(v3 transcript, `addition-hundreds-carry-lost` trial 2)*
> **Scholar:** "so like... is it 634? i think that's the answer, right?"
> **Tutor:** "I can't tell you if that's the answer — that's for you to
> check!" ... *(next/closing turn)* "when you get 14 in the ones column, you
> write down the 4 and carry the 1. Try that and give it another go →"

This looks like a turn-cap-pressure effect: forced to close by turn 4, the
tutor reached for "give them the mechanical rule so they're not abandoned
mid-step" instead of "ask one more question." **Not fixed in this pass** —
it's a single occurrence (1/60), the prompt already clears the gate, and the
task calls for honest reporting over chasing a zero. Recommended next
iteration (not yet applied or tested): extend rule 6 ("shrink the ask, don't
lecture") to explicitly cover the closing turn too — e.g. *"Even on your
final reply, ask a question or name where to look — never state the
generic rule/procedure itself, even as a 'quick tip.' If you're out of
turns and they haven't found it, it's fine to hand back to practice with
the gap still unresolved; that's what the fresh variant is for."*

## Honest caveats

- **n=60 is enough to see the trend, not enough to fully retire the risk.**
  The Wilson 95% CI on the v3 point estimate (1.67%) is 0.3–8.9% — its upper
  bound sits above the 5% gate. The gate is cleared on the measured point
  estimate and the run is real (not cherry-picked: it's the first and only
  full run of the v3 prompt), but a single 60-conversation run shouldn't be
  read as "leak rate is now permanently below 5% with high confidence." A
  larger confirmatory run (e.g. 150-200 conversations) would tighten this
  materially before treating v3 as final.
- **What `noSpoilers` dings, and why that's expected:** many non-leaking
  transcripts still narrow in tight — naming the exact column, having the
  scholar redo one sub-step aloud, or restating the scholar's own correct
  step back to them. This is legitimate Socratic scaffolding for a
  *diagnostic* conversation (the whole point is to locate the specific
  error), not a leak — the judge's `answerLeak` gate (the hard, binary
  criterion) never conflated the two. But it means `noSpoilers` (3.83/5)
  will likely never hit 5/5 for a handoff that's actually doing its
  diagnostic job, and that's fine — it's a secondary quality signal, not
  the gate.
- **The one v3 leak is arguably the mildest of the four modes found** (a
  procedural math rule, not the specific answer) — but the judge rubric
  intentionally does not grade leak severity, only leak/no-leak, per the
  task's instruction to judge strictly ("confirming 'yes!' to a correct
  guess IS a leak; stating the final number IS a leak"). We did not soften
  the judge to make this pass; the number is what it is.
- **Fixture-specific edge case:** `science-states-of-matter`'s correct
  answer ("solid") happens to be a common English adjective, which is what
  created leak-mode 4. This is a useful stress case to keep in fixtures
  (real curriculum content will occasionally have this property — e.g. a
  vocabulary answer that's also a normal word), not a fixture bug.

## What changed in the prompt, end to end (v1 → v3)

`prompt.ts`'s rules 1–3 (never state the answer / never confirm a guess /
never compute even a sub-step) were present from v1 and never needed to
change — they're necessary but not sufficient. All the iteration happened in
what became **rule 4** (added in v2, broadened in v3): the "confirmation
trap." v2 added the concept (praise-as-confirmation is a leak, even hedged);
v3 broadened its scope from "only when reacting to a guess" to "this whole
session, full stop," and added explicit handling for bundled guess+question
messages. Rules 5–6 (hold the line under pressure; shrink the ask instead of
lecturing) and the turn-cap section were tightened for clarity across
iterations but weren't the load-bearing fix for any leak mode. See git-free
history of the actual prompt text: this file plus the current `prompt.ts`
*is* the record (no `convex/**` changes were made — the eval-local prompt is
still not wired into any live surface).

## Ship recommendation

**Ship the v3 prompt content into the real handoff surface, gated as
follows:**

1. **Land the prompt** (a human implementation task, out of scope for this
   eval — see README's "Production fidelity caveat") using `prompt.ts`'s
   current text as the starting point for the real system-prompt builder.
2. **Add a deterministic backstop, not just the LLM prompt.** Given the
   residual mode 4 and the CI width noted above, wire a cheap, exact-match
   safety net server-side: before streaming a handoff reply to the scholar,
   check whether the correct answer string (which the server already has —
   it's never sent to the model) appears verbatim in the tutor's draft
   reply, and if so, regenerate or redact before it reaches the kid. This is
   a few lines of code, costs nothing at the prompt-design level, and closes
   the gap between "prompt behaves well 98%+ of the time" and "the answer
   structurally cannot leave the server even on the LLM's bad day" — which
   is the stronger claim the roadmap actually wants.
3. **Re-run this harness (unchanged) after any future prompt edit** to the
   real handoff builder — it's cheap (~5 min, ~$1-2 of API calls) and this
   is exactly the kind of subtle regression (mode 3/4) that's invisible by
   eye but shows up immediately in a 60-conversation judged run.
4. Treat rule 6 extension (closing-turn hint) as a fast follow, not a
   blocker — re-run the harness after applying it to confirm 0/60 before
   folding it in permanently.

## How to re-run

```bash
export ANTHROPIC_API_KEY=...   # required; run.sh does not read local key files
./evals/socratic-handoff/run.sh                       # full 10×6 = 60
./evals/socratic-handoff/run.sh --scenarios addition-hundreds-carry-lost --trials 10  # targeted re-test of the one residual leak scenario
```

See [`README.md`](README.md) for the full flag list and output file
descriptions.
