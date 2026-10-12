# Either/or answer → ask the why — spot-eval findings (TRA-413)

**Question.** The fragment rule asks a scholar for the whole thought when a
reasoning answer comes back clipped. It can't fire when the tutor asked an
either/or question, because a one-word pick is a complete answer. The TRA-413
prod read (2026-09-27 → 2026-10-10, Opus 5.5 at effort `low`) found 7 clear
real sessions where the scholar picked correctly in one word and the tutor then
explained the reasoning itself, against about 6 where it asked for the reason.
Does one added sentence in the fragment bullet flip that, without nagging
"why?" at picks that are the scholar's own creative choice?

**Method: real-prefix next-turn replay.** For 14 real moments (9 targets, 5
controls), the conversation up to the scholar's one-word pick was replayed
verbatim, with dictated turns carrying the live `[Dictated …]` label. Only the
NEXT tutor turn was regenerated, OLD (HEAD~1) vs NEW Guidelines, built the way
`run.ts` builds them, on `claude-opus-5-5` with the tutor's live runtime. This
avoids the scripted-reply problem in `voice-offer-FINDINGS.md`, where fixed
scholar replies don't track the questions. The prefixes are real prod
conversations, so they stay in the session scratchpad and are not committed.
Counted = the turn asks for the scholar's own reason without first stating it
(read by hand). The table covers the 6 target moments every round re-ran, and
the 3 creative-pick controls (a world-building choice, a storyboard choice, a
topic choice).

| wording | targets: asks the why, unexplained | creative-pick controls: asks "why did you pick" |
|---|---:|---:|
| OLD (master) | 7 / 24 | 0 / 12 |
| round 1: the TRA-413 sentence verbatim | 11 / 24 | 4 / 12 |
| round 2: scoped to reasoning picks, creative picks exempt | 19 / 24 | 0 / 12 |
| final (round 2 plus "under the same mic rule") | 9 / 12 | 0 / 6 |

**Read.**

- The verbatim TRA-413 sentence helped on some targets, but it broke one. On a
  "shapes, or something else?" question that OLD handled with a fragment ask
  (4/4), round 1 explained the answer in 4/4 runs. It also asked "why did you
  pick cold?" at a world-building choice in 4/4 runs.
- Scoping fixed both. The sentence now names reasoning picks (a prediction, a
  cause, which is more), exempts the scholar's own creation (which color, what
  to name it), and keeps the first-ask mic offer.
- Unchanged: a debugging moment where the code's behaviour has to be explained
  (both arms explain, which is correct footing), and one case where the tutor
  adds a new fact the scholar couldn't know (both arms state it).
- Multi-turn regression with `run.ts` on Opus 5.5: `typed-fragments-invasive`
  still has exactly one mic offer, at the first typed fragment, in both arms.
  `dictated-fragments-control` has 0 offers. NEW's only mic mention there is a
  "the mic may have jumbled that" check on a dictated turn, which is the
  dictated-turn rule working.

**Caveats.** The prompt is minimal (no dossier or unit), N = 2–4 per case, and
everything was read by hand. The final wording was re-run on 11 of the 14
cases, and the rest ran on round 2, which differs only in the example
parenthetical and the mic clause. Watch on prod with the TRA-413 regex read.
