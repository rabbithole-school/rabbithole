# Voice offer on the fragment ask — spot-eval findings (TRA-363)

**Question.** PR #3930 added a standalone "when typing is the bottleneck, invite
the mic" Guidelines bullet. In prod it never fired: 0 invitations in 266
tutor messages across the first days after deploy, including sessions with a
habitual typer giving 1–4 word typed answers to "why" questions — the exact
case it was written for. The fragment rule next to it claimed the same moment
("say the whole thing") every time. Does folding the offer INTO the fragment
ask fix that, on today's tutor (Sonnet 5) and on Opus 5.5?

**Change.** The first fragment ask of a session on a typed turn carries the
offer ("that's the right idea — tap the mic and say the whole thing: …"),
later asks and asks to a dictating scholar drop it, and the prompt states the
composer always has a mic button. The old bullet shrinks to dictated-turn
handling.

**Scripts** (authored synthetic, no production wording):
`typed-fragments-invasive.json`, `typed-fragments-calendar.json` (typed 1–4
word causal answers), `dictated-fragments-control.json` (every turn carries the
live `[Dictated …]` label; the tutor must never offer the mic).

**Runs.** `run.ts` A/B (OLD = HEAD~1 prompt), 3 reps per script per model,
using the live tutor's per-model `max_tokens`/effort (`tutorRuntime`). The
first Opus rows ran at effort `high`; the tutor moved to Opus 5.5 at `low`
(TRA-409) mid-review, so the last two rows re-ran at `low`.
Counted = a tutor turn inviting the scholar to use the mic (regex hit, then hand-checked).

| model | wording | typed scripts: runs with an offer | first offer at turn | control: offers |
|---|---|---:|---|---:|
| Sonnet 5 | OLD (#3930) | 0 / 12 | — | 0 |
| Sonnet 5 | offer in the ask | 0 / 12 (two phrasings) | — | 0 |
| Sonnet 5 | + "composer always has a mic button" | 2 / 6 | 3–4 | 0 |
| Opus 5.5 | OLD (#3930) | 10 / 12 | 5–6 | 0 |
| Opus 5.5 | final | 18 / 18 (all three phrasings) | 3–5 | 0 |
| Opus 5.5 @ effort `low` (prod tutor since TRA-409) | OLD (#3930) | 5 / 6 | 5–7 | 0 |
| Opus 5.5 @ effort `low` | final | 5 / 6 | 3–5 | 0 |

Never more than one offer per run.

**Read.**

- OLD on Sonnet reproduces the prod failure exactly: zero offers.
- Sonnet copies the example ask almost verbatim but strips the mic clause
  unless the prompt asserts the button exists. Even then it is 2/6: Sonnet
  is the weak link, and the wording change is a modest improvement there, not
  a fix.
- Opus 5.5 mostly fixes the old wording by itself (10/12), but only after a
  multi-turn pattern builds up (turn 5–6). The final wording makes it 18/18 and
  moves the offer to the FIRST typed fragment — the moment the rule is for.
- At `low` effort both wordings offer in 5/6 runs; the new one still offers
  earlier (the first typed fragment). The one miss under the new wording made
  no fragment ask at all, but mostly as an artifact of the harness: the tutor
  asked narrow either/or questions, and the fixed scholar script replied with
  words that either fully answered them or didn't answer them at all, so no
  reply was a fragment of a reasoning answer. Not evidence of an effort
  problem. The new wording raised fragment asks there too (runs with one:
  3/6 → 5/6).
- Control: no mic offer to a dictating scholar in any run. Opus does sometimes
  mention the mic while checking a possibly mis-transcribed word ("did the mic
  catch something different?") — that is the dictated-turn rule, not an offer.

**Caveats.** Synthetic minimal-context prompt (no dossier/unit), scripted
scholar replies, N=3. It proves the rule now fires; whether scholars then take
the mic is the prod read on TRA-363.
