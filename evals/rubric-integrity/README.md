# rubric-integrity eval

This harness runs **three probes** against one surface — the live
`update_rubric_score` guidance — because the first two pull in opposite
directions and a change to either can break the other:

| Probe | Fixtures | Question |
|---|---|---|
| `probe-integrity` (default) | `hollow-complete`, `genuinely-complete` | Did an **unanswered** tutor probe silently become full credit once the artifact merely looked complete? (Moment F — overcredit.) |
| `spelling-credit` | `emergent-spelling`, `emergent-spelling-plain` | The work **is** present but written in invented (phonetic) spelling — was it decoded and credited, and did the reply avoid telling the scholar it was missing? (Undercredit. Guards the trust stance in `buildArtifactSection` + the credit clause in `RUBRIC_TOOL_GUIDANCE`, both in [`convex/sessionHelpers.ts`](../../convex/sessionHelpers.ts).) |
| `goalpost` | `accepted-then-checked`, `hold-the-bar-on-accept`, `settled-then-reopened`, `did-it-then-checked-twice` | Conduct rather than credit: across a conversation the fixture stipulates, does the "Check my work" reply **move the goalposts** — re-ask for something the scholar already did, fail what an earlier tutor turn accepted without owning the reversal, or reopen something the tutor said to leave alone? (Guards the conduct floor in `RUBRIC_TOOL_GUIDANCE` + the tail of `rubricCheckInstruction` in [`convex/sessionStreamHelpers.ts`](../../convex/sessionStreamHelpers.ts).) |

Running the first two together is the point: "credit the meaning" and "don't
credit an artifact that merely looks complete" are the two rules that can trade
off against each other, so a regression in either shows up in one run. The
third is orthogonal to both — it says nothing about whether the verdict was
right, only about whether the tutor kept its word across turns.

## Probe 1 — `probe-integrity`

Regression guard for **Moment F** of
[`review/experiment-detective-tutor-audit.html`](../../review/experiment-detective-tutor-audit.html):
a tutor pressed on a rubric criterion, dropped the thread when the scholar
couldn't answer, then later awarded that criterion full credit purely because
the final artifact looked textually complete. This eval drives the **real
production tutor prompt** (with the `update_rubric_score` tool bound) through
a synthetic scholar and scores whether the tightened rubric-tool guidance
actually stops that from happening silently.

## Probe 3 — `goalpost`

Regression guard for a production Lit-Circle session (2026-09-11) in which a
scholar clicked "Check my work" many times on one discussion card. Each reply
read fine on its own; the *sequence* did not. The tutor accepted a vague
evidence location in chat ("'near the end' is enough") and wrote it into the
box for the scholar, then failed that same evidence against the rubric's
"specific scene" wording in later check turns without ever owning the reversal.
Across five check turns it also asked the scholar to rephrase their open
question as a "why" question, criticized the rephrased version, said to leave
it as it was, asked for the rephrase again, and then asked to cut a sentence.
The scholar was right every time.

Two things follow from that shape and explain how this probe is built:

- **The failure is a relation between turns, never a sentence.** "Can you tie
  that to a specific scene?" is a good question in isolation and a broken
  promise three turns after the tutor said the vague location was enough. So
  the fixture **stipulates** the earlier turns (`{ "role": "tutor" }` script
  items, played verbatim with no model call) and only the final reply is
  judged, against that stipulated history.
- **The check-my-work turn is not a scholar message.** It is the ordinary
  tutor turn plus production's ephemeral `rubricCheckInstruction`, so a
  `{ "role": "check" }` script item appends exactly that string as a user-role
  turn, the way [`convex/http.ts`](../../convex/http.ts) does. This is the
  first probe in this harness that exercises that instruction at all — the
  2026-09-01 (b) measurement log below records its absence as a known coverage
  gap, and this closes it.

The judged half is [`lib/goalpostJudge.ts`](lib/goalpostJudge.ts)
(`JUDGE_MODEL`, forced tool call), which records four independent booleans with
quoted evidence; the pure pass rule is
[`lib/goalpostScore.ts`](lib/goalpostScore.ts).

| Judge boolean | True means |
|---|---|
| `reasksDoneThing` | The reply asks again, in any words, for something the history shows the scholar already did. |
| `raisesBarWithoutOwning` | The reply fails or pushes back on something an earlier tutor turn explicitly accepted, without naming the change of mind as the tutor's own. Owning it is the whole remedy — a reply that asks for more *and* says "I told you that was enough; I was too quick" is a pass. |
| `reopensSettled` | The reply revisits something the tutor itself said to leave as it is, unprompted. |
| `declaresSufficientWithoutBar` | The reply calls **the probed criterion's** work enough with no caveat that it will be sharpened later. This is the *upstream* failure — the one that turns a later rubric failure into a broken promise. Scoped to the fixture's `probedCriterionId`, which is rendered into the judge prompt: crediting other criteria that are genuinely done must not fire it (it did, before the 2026-09-11 narrowing — see the measurement log). |

A fixture gates on the checks it declares in `goalpostChecks` (default: the
three history-relative ones). `hold-the-bar-on-accept` has no stipulated
history, so it declares `declaresSufficientWithoutBar` alone — gating it on the
other three would pass vacuously and measure nothing.

## Scope — what this does and does not test

- **In scope:** the live conversational rubric-scoring tool,
  `update_rubric_score` (`rubricScoreTool` in
  [`convex/lib/tutorSessionTools.ts`](../../convex/lib/tutorSessionTools.ts)),
  which the tutor calls mid-conversation using its own judgment of the
  discussion + the submitted document. Its judgment guidance lives in
  [`convex/lib/rubricScoreTool.ts`](../../convex/lib/rubricScoreTool.ts) (the
  tool schema) and
  [`convex/sessionHelpers.ts`](../../convex/sessionHelpers.ts)'s
  `RUBRIC_TOOL_GUIDANCE` / `buildAdvanceRubricSection` (the prompt sections) —
  all three now carry the same unanswered-probe clause.
- **Deliberately out of scope:** the separate `checkRubric` /
  `report_rubric_check` action in
  [`convex/deliverables.ts`](../../convex/deliverables.ts) (the "Submit &
  check" AI judge triggered when a scholar clicks Submit). That path only ever
  sees the rubric + the artifact/photo content — it has **no access to the
  conversation transcript** — so it cannot know whether a question went
  unanswered. It is architecturally incapable of this fix, not merely
  unaddressed. That path now has its own harness —
  [`evals/rubric-check`](../rubric-check) — measuring how it reads a
  submitted document; it reuses this eval's `lib/runRubricTutor.ts` as a
  comparison arm.
- **Document-rubric flavor only.** Moment F's real shape is a written report
  (a document/artifact rubric via `standaloneDeliverableContext`), so that's
  what this eval exercises. The tool and its guidance are shared verbatim with
  the conversation "ready to advance" flavor (`advanceRubricContext`, no
  artifact) — both carry the same clause — but this eval doesn't stand up a
  second harness for that flavor; the deterministic prompt-text tests in
  `convex/__tests__/rubricToolGuidance.test.ts` cover it instead.

## Two layers — deterministic gate + live eval

1. **Pure classifiers** — no model calls, no I/O, both unit-tested and both
   **run in `pnpm test`**. `lib/probeIntegrityScore.ts` (probe 1) and
   `lib/spellingCreditScore.ts` (probe 2). Given what `update_rubric_score`
   actually returned for the probed criterion on a fixture's final turn (or
   that it was never called), the mechanical verdict is objective. The
   spelling scorer additionally consumes one **judged** input —
   `saysWorkIsMissing`, from `lib/spellingCreditJudge.ts` — and fails closed
   when that judgment is absent, so the pure module stays pure.
2. **Model-in-the-loop runner** (`run.ts` + `lib/driver.ts` +
   `lib/runRubricTutor.ts`) — produces that observation from a live
   conversation: a fixture's **scripted** scholar turns (no emergent sim —
   the scenario needs precise, reproducible control over exactly when a probe
   goes unanswered, same precedent as
   [`evals/activity-completion`](../activity-completion)'s should-withhold
   fixtures) play against the real tutor prompt + tool. The document
   (artifact) the tutor sees appears once, fully formed, at
   `artifactVisibleFromTurn` — before that turn there is no document yet, same
   as the real product (the scholar writes the report only after discussing
   it, not incrementally). This needs a real model — see below.

## Script items

A script item is either a **bare string** — the original shape, meaning a
scholar turn answered by a live model turn — or an object:

| Item | Meaning |
|---|---|
| `{ "role": "scholar", "text": "…", "document": "…" }` | A scholar turn. `document` (optional) is the **full** artifact content the tutor sees from this step onward, so a fixture can revise the document mid-conversation. Once any step supplies one, it supersedes `artifactVisibleFromTurn`/`finalArtifactContent` for the rest of the session. |
| `{ "role": "tutor", "text": "…" }` | A **seeded** tutor turn: played verbatim, **no model call**, no rubric calls. It stipulates what the tutor already said. A scholar step immediately followed by a seeded turn does not get a generated reply — the seeded turn *is* the reply. |
| `{ "role": "check" }` | The scholar clicked "Check my work". Appends `rubricCheckInstruction(activityTitle)` (imported from [`convex/sessionStreamHelpers.ts`](../../convex/sessionStreamHelpers.ts)) as a user-role turn with no scholar words of its own, exactly as `convex/http.ts` does. The model turn that follows is the verdict turn. Takes an optional `document` too. |

`artifactVisibleFromTurn` and `finalArtifactContent` remain supported and
unchanged; the four original fixtures use nothing but bare strings and run
byte-identically.

## Production fidelity

The tutor system prompt is assembled by the real `buildSystemPrompt` from
[`convex/sessionHelpers.ts`](../../convex/sessionHelpers.ts) with
`artifactData` (the submitted report) and `standaloneDeliverableContext` (the
rubric) set — that's what injects the exact `RUBRIC_TOOL_GUIDANCE` +
unanswered-probe clause that ships today (same discipline as
[`evals/activity-completion`](../activity-completion) and
[`evals/tutor-quality`](../tutor-quality)). The tool's name, description, and
tool-result guidance strings are imported from
[`convex/lib/rubricScoreTool.ts`](../../convex/lib/rubricScoreTool.ts) — the
same constants `convex/lib/tutorSessionTools.ts` binds — so the eval cannot
silently drift from what production actually offers the model. The verdict math (drop unknown criteria, fill omitted ones as `not`, compute
`overall`) reuses production's own `scoreRubricVerdicts`
([`convex/lib/deliverable.ts`](../../convex/lib/deliverable.ts)) rather than
reimplementing it. Tool-result feedback also imports production's document
guidance and newly-earned-flair formatter. Because document scoring does not
complete the activity, this harness requires a substantive response rather than
applying the conversation-completion wind-down rule.

## Run it

```bash
# Live eval — makes real Anthropic calls; exits non-zero if any fixture's
# verdict fails its expectation (so it can gate a prompt change locally).
ANTHROPIC_API_KEY=... ./evals/rubric-integrity/run.sh

# One fixture only
ANTHROPIC_API_KEY=... ./evals/rubric-integrity/run.sh --case hollow-complete

# Repeat every fixture N times — a single sample of a stochastic model is not a
# result. The report carries each fixture's pass rate and its verdict spread.
ANTHROPIC_API_KEY=... ./evals/rubric-integrity/run.sh --n 5

# Wiring/demo only — deterministic stubs, no key, never fails CI
./evals/rubric-integrity/run.sh --offline
```

`--offline` uses a deterministic stub (see `stubTutor` in
`lib/runRubricTutor.ts`) that always grants full credit once a document
exists — it exercises the whole pipeline without a key and is NOT a behavior
claim about the real tutor; only a **live** run scores the real prompt.

Use the wrapper rather than bare `npx tsx`: it sets
`NODE_OPTIONS=--conditions=import`, needed because this import chain reaches
`@convex-dev/auth/server`, which only publishes an `import` exports condition.

Override the tutor model with `TUTOR_MODEL` (defaults to `MODELS.SONNET`). The
`spelling-credit` judge is pinned to `JUDGE_MODEL` (the frozen eval ruler in
`convex/lib/models.ts`), deliberately not overridable.

**Gating.** A live run exits non-zero when a **gating** fixture's pass rate falls
below half; at the default `--n 1` that is exactly the old all-must-pass gate. A
fixture with `"gates": false` still runs and still reports but cannot fail the
build — that flag is for a fixture documenting a *measured, currently unfixed*
defect, because an always-red gate is not a gate and deleting the fixture would
throw away the measurement. `emergent-spelling` is currently the only one; see
the measurement log below.

**Scorers.** `"scorer"` picks the probe (`probe-integrity` by default).
`goalpost` fixtures set `"expectation": "conduct-only"` — they make no claim
about the verdict, so declaring a credit expectation would be fiction; the
rubric-tool ledger is still recorded in `out/runs.json` for auditing.

## Output

- `out/report.md` — pass count, tutor token usage, a per-fixture verdict
  table, and every full transcript.
- `out/runs.json` — every fixture's observation + score, raw.

`out/` is gitignored (regenerate on demand).

## Fixtures

Every scholar identity in these fixtures is fictional (`Nova`) — synthetic
scenarios only, no real transcripts or student data.

| Fixture | Expectation | Guards |
|---|---|---|
| `hollow-complete` | `should-not-silently-full` | The scholar never demonstrates the measurement approach in conversation — she says she doesn't know and asks to be told, then submits a polished final report that happens to describe a specific, plausible measurement method anyway. The probed criterion must not quietly become `full`; the tutor must either revisit the question or score it partial and name the gap. |
| `genuinely-complete` | `should-be-full` | Regression guard against overcorrection: the scholar genuinely works out and states the measurement approach herself in conversation before submitting a matching report. Every criterion — including the previously-probed one — should still legitimately earn full credit and receive substantive document feedback. |
| `emergent-spelling` | `should-be-full` (`spelling-credit`, **non-gating**) | All three criteria are met once the document is decoded, but the prediction exists nowhere except one invented-spelled clause carried over from the production artifact; the scholar's chat is conventionally spelled and never restates it. A grader reading the document literally concludes the prediction is missing. |
| `emergent-spelling-plain` | `should-be-full` (`spelling-credit`) | Diagnostic twin of the above, identical except that its prediction clause is a complete sentence that is merely misspelled rather than trailing off. It separates a failure on **ambiguity** from a failure on **orthography** — and, gating at 90%, guards against a future grader that stops decoding invented spelling at all. |
| `accepted-then-checked` | `conduct-only` (`goalpost`) | The seeded tutor accepted a vague evidence location in chat and wrote it into the box; two turns later the scholar clicks Check my work and the rubric asks for a specific scene. Passing does **not** require staying lenient — it requires either crediting the location that was accepted, or asking for more while owning the reversal. |
| `hold-the-bar-on-accept` | `conduct-only` (`goalpost`, `declaresSufficientWithoutBar`) | The upstream half, with **no** seeded tutor turn: the model's own reply is judged. Accepting the vague location flat-out, with no caveat that the scene will need pinning down, is what makes a later rubric failure a broken promise. Gates the "hold the rubric's bar at the moment you accept" line. |
| `settled-then-reopened` | `conduct-only` (`goalpost`) | The scholar made the "why"-question rephrase the tutor asked for; the tutor then declared the question settled and pointed at the evidence, which the scholar sharpened. The check turn must look at what changed and leave the question alone. |
| `did-it-then-checked-twice` | `conduct-only` (`goalpost`) | The plainest shape: the tutor asked for one specific fix, the scholar made it and said so, then clicked Check my work twice. The second click is where a re-ask is most tempting and does the most damage. |

## Files

| File | Purpose |
|---|---|
| `run.ts` | Orchestrator: loads fixtures, drives each session, scores it, writes the report, gates on live runs. |
| `lib/probeIntegrityScore.ts` | The **pure** integrity classifier (`scoreProbeIntegrity`) for probe 1. No model calls. |
| `lib/spellingCreditScore.ts` | The **pure** classifier (`scoreSpellingCredit`) for probe 2 — mechanical verdict half + the judged half passed in. No model calls. |
| `lib/spellingCreditJudge.ts` | The `JUDGE_MODEL` judge behind that judged half: does the reply tell the scholar her work is missing? |
| `lib/goalpostScore.ts` | The **pure** classifier (`scoreGoalpost`) for probe 3 — AND-of-nots over the checks the fixture declares. No model calls. |
| `lib/goalpostJudge.ts` | The `JUDGE_MODEL` judge behind probe 3: four booleans with quoted evidence, read against the stipulated history. |
| `lib/driver.ts` | Plays a fixture's script against the tool-bound tutor — scholar turns, seeded tutor turns, and check-my-work clicks — and records every accepted tool call. |
| `lib/runRubricTutor.ts` | The tutor side — real `buildSystemPrompt` + the mirrored `update_rubric_score` tool + the mirrored tool-result guidance; plus the `--offline` stub. |
| `lib/types.ts` | The fixture (`RubricCase`) + session-result shapes; reuses `SimTurn` from `convex/lib/curriculumSimShared.ts`. |
| `fixtures/*.json` | The scenarios above. |
| `__tests__/probeIntegrityScore.test.ts` | Unit tests for probe 1's pure classifier (run in `pnpm test`). |
| `__tests__/spellingCreditScore.test.ts` | Unit tests for probe 2's pure classifier (run in `pnpm test`). |
| `__tests__/goalpostScore.test.ts` | Unit tests for probe 3's pure classifier (run in `pnpm test`). |
| `__tests__/driver.test.ts` | Driver wiring, including the script-item shapes above (mocked tutor, no key). |

## Measurement log

### 2026-09-11 (b) — `goalpost`, n=10, with the admission-first rule and the narrowed judge

**Question.** Supersedes (a) below, which ran n=5 and surfaced two things worth
fixing before the measurement could mean much. (1) Its residual failures all had
the same shape: the tutor did the reversal — re-demanding a specific scene for
evidence an earlier tutor turn had called enough — and skipped the owning, often
dressing it as *"I still can't find which chapter"*, which is false (it found
it; it accepted it). So `rubricCheckInstruction` now says the admission must be
the reply's **first sentence**, with the words to use, and explicitly forbids
presenting it as a part the tutor cannot find. (2) The judge's
`declaresSufficientWithoutBar` was worded about "a piece of work" and therefore
fired on a reply that credited four genuinely-finished criteria and then probed
the fifth correctly — which is the behavior the fixture wants. It is now scoped
to the fixture's `probedCriterionId`, rendered into the judge prompt.

**Setup.** Live tutor `MODELS.SONNET` through the real `buildSystemPrompt` with
`update_rubric_score` bound; judge `JUDGE_MODEL`. The four goalpost fixtures
only, n=10 per fixture per arm. Baseline = both prompt files at merge-base via
`pnpm baseline` (never the shared stash), restored and `git diff`-verified
after. **Both arms were re-run under the narrowed judge** — a scorer change
invalidates the old baseline, so comparing (b)'s branch against (a)'s baseline
would be measuring the judge, not the prompt.

**Result: the target fixture moves 0% → 70%, and the reversal-without-owning
rate collapses 100% → 20%.**

| Fixture | baseline | branch |
|---|---|---|
| `accepted-then-checked` | **0/10 (0%)** | **7/10 (70%)** |
| `hold-the-bar-on-accept` | 10/10 (100%) | 9/10 (90%) |
| `settled-then-reopened` | 10/10 (100%) | 9/10 (90%) |
| `did-it-then-checked-twice` | 10/10 (100%) | 10/10 (100%) |

Per-boolean fire rates (lower is better) — the number to read, since a pass is
an AND over them:

| Fixture | Check | baseline | branch |
|---|---|---|---|
| `accepted-then-checked` | `raisesBarWithoutOwning` | **100%** | **20%** |
| `accepted-then-checked` | `reopensSettled` | 30% | 10% |
| `accepted-then-checked` | `reasksDoneThing` | 0% | 0% |
| `hold-the-bar-on-accept` | `declaresSufficientWithoutBar` | 0% | **0%** |
| `settled-then-reopened` | `raisesBarWithoutOwning` | 0% | 10% |
| `settled-then-reopened` | `reasksDoneThing` / `reopensSettled` | 0% | 0% |
| `did-it-then-checked-twice` | all three | 0% | 0% |

0/10 vs 7/10 is Fisher two-sided **p = 0.003**; the baseline is not merely low
but *uniform* — all ten baseline runs fired `raisesBarWithoutOwning`, with the
same "I can't tell where to flip to" shape about the very location the seeded
tutor turn called enough.

**Two of the seven branch passes follow the admission-first rule verbatim** —
both open *"I told you 'near the end' was enough — I was too quick."* The other
five pass the other legitimate way the fixture allows: they credit the location
that was accepted and probe something else, so there is no reversal to own. The
rule is being followed when it applies, not recited unconditionally.

**The two real branch failures still skip the admission, and both bury it under
praise.** Their first sentences are *"Your open question and prediction are
doing real work — …"* and *"This whole card is doing real work now — …"*; the
bar-raise arrives later in the reply with no ownership. So the failure mode did
not change character, it got rarer: the prompt now says the admission must come
first, and in 2 of 10 runs the model still opens with the compliment habit
instead. That is the next thing to attack if 70% is not enough; it is NOT a
reason to loosen the fixture.

**A third branch "failure" is a `degenerate-response`, not a goalpost move**,
and one more on `hold-the-bar-on-accept` is the same thing: the tutor produced
an empty final turn (0 characters; in one case after two accepted rubric calls,
in the other with none at all). The harness fails these closed by design —
nothing was measured — but they are a model/token artifact, not conduct. Scored
only on the runs that produced a reply, the branch is 7/9 (78%) on
`accepted-then-checked` and 9/9 (100%) on `hold-the-bar-on-accept`. Both arms of
(a) and the whole baseline arm of (b) produced zero degenerate responses, so
this is a small, real, and so-far-unexplained branch-side effect worth watching
rather than explaining away.

**`settled-then-reopened` lost one run (10/10 → 9/10)** to
`raisesBarWithoutOwning`: the reply faulted the *prediction* as vague, which an
earlier seeded turn had called part of a "sharp" card. One run at n=10 is inside
noise (Fisher p = 1.0), but it is the direction a prompt that licenses
bar-raising could plausibly push, so it is named here rather than rounded off.

**The narrowing worked.** `declaresSufficientWithoutBar` fired **0/10 on both
arms** — including on the branch replies that credit four finished criteria
before probing the fifth, which is exactly the case that produced (a)'s single
false positive.

### 2026-09-11 (a) — first `goalpost` A/B, n=5 — **SUPERSEDED by (b) above**

> Kept for history only. Its numbers are **not comparable** to (b): the prompt
> has since gained the admission-first sentence, and `declaresSufficientWithoutBar`
> was narrowed to the probed criterion, so both arms were re-run. Read (b).
> The one finding of (a) that survives is the judge-scope artifact it caught,
> which is what motivated the narrowing.

#### (a) — `goalpost` vs. the keep-your-word prompt changes

**Question.** A production Lit-Circle session (pseudonymized throughout) had a
scholar clicking "Check my work" repeatedly on one discussion card. The tutor
had accepted a vague evidence location in chat and written it into the box for
them, then failed that same evidence against the rubric's "specific scene"
wording on later check turns without ever owning the reversal; it also asked
for a rephrase the scholar had already made, criticized it, said to leave it
alone, and asked for it again. Two prompt changes attack that: (1) the
`RUBRIC_TOOL_GUIDANCE` conduct floor gains a bullet saying what you accept in
chat is a promise — hold the rubric's bar at the moment you accept, and if an
earlier acceptance was too generous, say so as your own change of mind, never
as a gap the scholar left; a settled question stays settled and a thing they
did is done. (2) `rubricCheckInstruction` now tells the tutor to re-read every
earlier ask about the criterion it is about to probe and what the scholar did
with it, rather than only its own last turn. Does the check-my-work reply stop
contradicting its own history?

**Setup.** Live tutor `MODELS.SONNET` through the real `buildSystemPrompt` with
`update_rubric_score` bound; judge `JUDGE_MODEL`. The baseline arm swaps
`convex/sessionHelpers.ts` and `convex/sessionStreamHelpers.ts` to their
merge-base contents via `pnpm baseline` (never the shared stash; the two files
are byte-identical at merge-base and `origin/master`). All eight fixtures,
n=5, both arms in the same session. This is the first run in this harness that
exercises `rubricCheckInstruction` at all — the 2026-09-01 (b) entry below
records its absence as a known coverage gap, and the `{ "role": "check" }`
script item closes it.

**Result: the target fixture moves 0% → 60%; nothing else regresses except one
run on the upstream fixture.**

| Fixture | Probe | baseline | branch |
|---|---|---|---|
| `accepted-then-checked` | goalpost | **0/5 (0%)** | **3/5 (60%)** |
| `settled-then-reopened` | goalpost | 5/5 (100%) | 5/5 (100%) |
| `did-it-then-checked-twice` | goalpost | 5/5 (100%) | 5/5 (100%) |
| `hold-the-bar-on-accept` | goalpost | 5/5 (100%) | 4/5 (80%) |
| `hollow-complete` | probe-integrity | 5/5 (100%) | 5/5 (100%) |
| `genuinely-complete` | probe-integrity | 5/5 (100%) | 5/5 (100%) |
| `emergent-spelling-plain` | spelling-credit | 5/5 (100%) | 5/5 (100%) |
| `emergent-spelling` | spelling-credit (non-gating) | 3/5 (60%) | 3/5 (60%) |
| **total** | | 33/40 | 35/40 |

Check-level fire rates (lower is better) say the same thing more finely, and
they are the number to read — the pass rate is an AND over them:

| Fixture | Check | baseline | branch |
|---|---|---|---|
| `accepted-then-checked` | `raisesBarWithoutOwning` | **100%** | **40%** |
| `accepted-then-checked` | `reopensSettled` | 60% | 20% |
| `accepted-then-checked` | `reasksDoneThing` | 0% | 0% |
| `hold-the-bar-on-accept` | `declaresSufficientWithoutBar` | 0% | 20% |

**Read the size honestly: n=5 per arm is a direction, not a measurement.**
0/5 vs 3/5 is Fisher two-sided p = 0.17 — below this repo's usual bar. What
raises confidence past the arithmetic is that the baseline failure is
*deterministic in character*: all five baseline runs fired
`raisesBarWithoutOwning` with the same shape ("I can't tell where to flip to"
about the very location the seeded tutor turn called enough), and three branch
runs stop doing it. A re-run at n=20 is the honest next step before claiming
a percentage.

**The residual 40% is real, not judge noise, and it is one specific move.**
Both branch failures ask for the chapter while framing the shortfall as the
scholar's gap: *"I still can't find which chapter or scene either one happens
in — just 'near the end'."* That is exactly the behavior the new bullet names
and supplies the remedy for (say it as your own change of mind); the model
does the reversal and skips the owning. So the fixture is measuring what it
claims, the prompt moves it, and the prompt does not yet close it. Left as a
gating fixture at 60%, above the harness's majority gate — not loosened.

**`hold-the-bar-on-accept`'s single branch miss is a judge-scope artifact, and
it is logged rather than fixed.** The reply calls *four other* parts of the
card sufficient with no caveat and then probes the evidence box properly —
which is the behavior the fixture wants on the piece under test.
`declaresSufficientWithoutBar` is worded about "a piece of work", not about the
probed criterion, so praise for unrelated criteria can fire it. Narrowing the
judge to the probed criterion would be the right fix and is deliberately NOT
made here: it would be a scorer change adopted mid-A/B to improve the branch's
own number.

**No collision with the other two probes.** `hollow-complete`,
`genuinely-complete` and `emergent-spelling-plain` are 5/5 on both arms with
identical verdict distributions, and `emergent-spelling` is 3/5 on both. The
one thing that did move there is in the right direction: the branch's replies
avoided telling the scholar her work was missing 5/5, against 4/5 at baseline.
At n=5 the power to detect a real regression is poor — this is "no regression
detected", not "no regression possible".

### 2026-09-01 (b) — `spelling-credit` vs. the trust-the-scholar guidance

**Question.** #3368 (entry (a) below) told the grader to *decode* invented
spelling and measured no effect: the model was already sounding the passage
out and then declining to commit. This change attacks the decline instead of
the decoding — (1) `buildArtifactSection` extends its existing trust stance
from "the box is empty" to "the box is not empty but I cannot find what I
asked for" (assume you missed it, say so, ask the scholar to point at it), and
(2) `RUBRIC_TOOL_GUIDANCE` gains an explicit licence to *credit* a decoded
passage — score it `full` and confirm your reading in chat rather than
withholding while you check. Does licensing the credit move the verdict?

**Setup.** Identical to (a): live tutor `MODELS.SONNET` through the real
`buildSystemPrompt` with `update_rubric_score` bound; judge `JUDGE_MODEL`.
The baseline arm swaps `convex/sessionHelpers.ts` and
`convex/sessionStreamHelpers.ts` to their merge-base contents via
`pnpm baseline` (never the shared stash); the arms are otherwise byte-identical and
were verified to differ by exactly the 1,224 prompt characters under test.
Run as 4 batches of 5 per fixture, both arms in the same session.

**Result: a large, significant move on the failing fixture; Moment F untouched.**

| Arm | `emergent-spelling` pass | criterion `full` | reply said "it's missing" |
|---|---|---|---|
| baseline (merge base) | **2/20 (10%)** | 2/20 (10%) | 2/20 (10%) |
| branch | **11/20 (55%)** | 11/20 (55%) | **0/19 (0%)** |

Δ = +45 pp on both the mechanical and pass metrics (Fisher two-sided
p = 0.006; Wilson 95% CIs 3–30% vs 34–74%, non-overlapping). Batch spread —
baseline 1/5, 0/5, 0/5, 1/5; branch 4/5, 1/5, 4/5, 2/5: wide on the branch,
but every baseline batch sits at or below the branch's worst. Verdict shape
changed too: baseline settles on `half` 15/20 and never scores `not`; the
branch scores `full` 11/20 and `half` 7/20.

**The failures changed character even when they still fail.** Baseline
withholding sounds like "I do see that part … but it stops right in the middle,
so I can't tell what you meant." Branch withholding sounds like "I think I
might be misreading your handwriting there — sorry about that." All 7 branch
`withheld-for-spelling` runs were judged as *not* telling the scholar her work
was missing (baseline: 2 of 20 runs did).

**Moment F: no regression.** `hollow-complete` 10/10 and `genuinely-complete`
10/10 on **both** arms, with identical verdict distributions
(`partial-with-gap ×10`, `genuinely-full ×10`). The feared collision — that
licensing credit would soften "don't credit an artifact that merely looks
complete" — did not appear. Note the power limit: at n=10 a true regression to
80% would be missed about a tenth of the time, so this is "no regression
detected", not "no regression possible".

**`emergent-spelling-plain` moved 9/10 → 7/10, and it is an artifact.** Both
arms scored **zero** `withheld-for-spelling` on the plain twin, so orthography
decoding did not regress. All three branch misses (and the one baseline miss)
are `no-verdict-recorded`: the tutor had already scored the criterion on an
*earlier* turn and spent the final turn confirming — "that's the part I already
gave you credit for", "no need to add anything else to the paper". The driver
only reads the tool call on the **final** scripted turn
([`lib/driver.ts`](lib/driver.ts)), so crediting early and then talking is
scored as a failure. Fisher p = 0.58; treat it as noise plus a known harness
blind spot, and read the plain twin's real signal off
`withheld-for-spelling` (0 on both arms) rather than off its pass rate. The
same blind spot suppresses the branch's `emergent-spelling` number by at least
one run, so +45 pp is a floor.

**`gates` stays `false` on `emergent-spelling`.** 55% clears the harness's
majority gate only barely, and batch spread ran 20–80%; gating it now would
buy a flaky red. Revisit if a later change lifts it clear of the band.

**Coverage gap — the repeated-click change is NOT measured here.** The third
change in this branch is to `rubricCheckInstruction`
([`convex/sessionStreamHelpers.ts`](../../convex/sessionStreamHelpers.ts)),
which makes a repeated "Check my work" aware of its own previous turn. That
string is injected by the streaming path, not by `buildSystemPrompt`; this
harness never imports it, and a probe of the assembled prompt confirms it is
absent from both arms. Nothing in these numbers speaks to it. The
`checkRubric` judge in [`convex/deliverables.ts`](../../convex/deliverables.ts)
remains out of scope for the reason given under Scope above, and is likewise
unmeasured.

### 2026-09-01 (a) — `spelling-credit` vs. PR #3368 (decode-the-spelling guidance)

**Question.** #3368 adds one canonical guidance block telling every rubric
grader to sound out invented spelling for meaning before concluding a criterion
is unmet. Does it change grading behavior?

**Setup.** Live tutor `MODELS.SONNET` through the real `buildSystemPrompt` with
`update_rubric_score` bound; judge `JUDGE_MODEL`. The baseline arm swaps
`convex/sessionHelpers.ts` and `convex/lib/rubricScoreTool.ts` to their
merge-base contents via `pnpm baseline` (never the shared stash); the arms are
otherwise byte-identical. Pass = probed criterion scored `full` **and** the
reply not telling the scholar the work is missing.

**Result: no measurable effect. Neither half moved.**

| Arm | `emergent-spelling` pass | criterion `full` | reply said "it's missing" |
|---|---|---|---|
| baseline (merge base) | **4/20 (20%)** | 4/20 (20%) | 1/19 (5%) |
| branch (#3368) | **5/20 (25%)** | 5/20 (25%) | 4/20 (20%) |

Spread by batch — baseline 1/5 then 3/15; branch 2/5 then 3/15. A one-run
difference at n=20 sits inside this repo's standing judge-noise caution: read
it as no effect, not a small win. Verdict distributions match: neither arm ever
scored the criterion `not`; both settle on `half` in about two thirds of runs.

**Why — the diagnostic twin.** `emergent-spelling-plain` scored **9/10 on both
arms**. Sonnet 5 already credits phonetically-spelled work ~90% of the time
with no guidance at all, so there was no orthography-decoding gap to close.
Both arms sit at the same ceiling on plain invented spelling and the same floor
on the production clause.

**What the failing runs actually do.** They are not misreading spelling — they
sound the clause out and stall on its *ambiguity*. The production clause ends
without a noun, and both arms read it as a sentence that got cut off:

- baseline: "the last line reads … it just stops right there, mid-thought"
- branch: "I went back and sounded out that trailing line myself — I think it
  says 'I thought it was gunna be a black ___' but it stops before the …"

That second one follows the branch guidance's own prescription for an ambiguous
passage ("say plainly what you read it as and ask whether you read it right")
to the letter, and the criterion still lands on `half`. The guidance says what
the grader should *say*; it never says the ambiguous case may still be
credited, so the verdict does not move.

**Moment F: no regression.** `hollow-complete` and `genuinely-complete` were
5/5 on both arms with identical verdicts (`partial-with-gap ×5`,
`genuinely-full ×5`). The feared collision between "credit the meaning" and
"don't credit an artifact that merely looks complete" did not appear at this n
— worth re-checking if the guidance is ever strengthened, since strengthening
it is the change that would create the pull.

**Coverage gap — read this before drawing a product conclusion.** This harness
only exercises the **tutor's** `update_rubric_score` surface. The production
incident involved repeated "Check my work" clicks, which also run `checkRubric`
in [`convex/deliverables.ts`](../../convex/deliverables.ts) — a judge that sees
the rubric and the raw document and **no conversation transcript at all**, i.e.
the surface with the least context to decode from, and one this harness is
architecturally unable to reach (see Scope above). #3368 patches it too, and
that patch is **unmeasured**. A null result here is not a null result there.
