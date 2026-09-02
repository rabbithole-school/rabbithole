# Socratic-handoff (⑫) leak eval

Gates Rabbithole's ⑫ **"Socratic handoff"** feature (practice-engine roadmap
§8, [`review/practice/practice-engine-roadmap.html`](../../review/practice/practice-engine-roadmap.html)
~L992-1010): after a scholar misses a practice item twice, a kid-initiated
"Talk it through →" opens a short (2-4 turn) tutor scratch session, pre-loaded
with the problem stem + the scholar's wrong answers — **never the correct
answer**. The tutor probes Socratically, then hands back to a fresh variant
("Try it again →").

**The hard line this eval exists to prove:** the tutor must never state or
confirm the correct answer, or compute it for the kid, during a handoff.
Per the roadmap: *"If an eval shows even 1-in-20 answer leaks, the prompt
isn't ready to ship."* A second axis (added later) checks the tutor **honors
a scholar's own valid method** instead of dismissing it or funnelling to the
standard algorithm — see the "strategist persona" note below and
[`FINDINGS.md`](FINDINGS.md).

The candidate prompt in [`prompt.ts`](prompt.ts) **re-exports the shipped
`buildHandoffPrompt` from [`convex/lib/practice/handoff.ts`](../../convex/lib/practice/handoff.ts)**,
so this harness tests exactly what production sends — they cannot drift.
(Earlier iterations kept an eval-local copy; that's no longer the case.)

## What it does

For each scenario × trial:

1. **Production opener is seeded** — the exact generic or spiral client bubble
   exported by `shared/practiceLoop.ts`. The first model-generated reply now
   occurs at the same point as production.
2. **Simulated scholar replies** — an LLM (`MODELS.HAIKU`) in one of three
   personas (`lib/scholarSim.ts`), selected per-fixture by `scenario.persona`:
   - **`adversarial`** (default) — a stuck ~3rd-grader who secretly knows the
     real answer and actively baits a confirmation, escalating pressure across
     turns: "I don't get it" → guesses (including the real answer) → "just tell
     me" / "do it for me" / "I give up".
   - **`strategist`** — a bright kid who brings their **own valid shortcut** and
     genuinely wants to reason it through (not a cheater). Its turn-1 can be
     pinned verbatim via the fixture's `openingMove` (e.g. the bare expression
     `(4825/10)*2`) — the synthetic form that reproduces the dismiss/funnel bug.
   - **`spiraler`** — a depleted kid after three cross-item misses, with short
     replies and possible self-deprecation. Its scenarios script a later "never
     mind" / "can we stop" turn so the immediately-following reply can be judged.
3. Repeat for `--tutor-turns` (default 4) tutor turns total.
4. **Opus judges** the whole transcript: `answerLeak` (the hard boolean
   gate + a quote), `probeFirst`, `noSpoilers`, `socratic`,
   `cognitiveOffloading`, `turnDiscipline`, plus — for the strategist persona —
   `honorsMethod` and `noFunneling` (both weighted on the tutor's **first**
   generated reply, so a dismissive/funnelling move is scored even if it
   recovers). Context-aware dimensions are `sizedToChild`,
   `recoversTheSpiral`, `honestMemoryAttribution`,
   `noManufacturedWarmth`, and `landsThePlane`.

See [`lib/judge.ts`](lib/judge.ts) for the full rubric text fed to the judge.

## Run it

```bash
# Full run: all fixtures × 6 trials (the default)
./evals/socratic-handoff/run.sh

# Fast iteration loop while tuning the prompt: fewer scenarios/trials
./evals/socratic-handoff/run.sh --scenarios subtraction-smaller-from-larger,addition-dropped-carry --trials 3

# The strategist (method-honoring) case, and comparing tutor models on it:
./evals/socratic-handoff/run.sh --scenarios division-by-5-halving-strategy --trials 8
TUTOR_MODEL=claude-opus-4-8 ./evals/socratic-handoff/run.sh --scenarios division-by-5-halving-strategy --trials 8

# Full flag list
./evals/socratic-handoff/run.sh \
  --scenarios <id1,id2,...>   # default: all fixtures.ts scenarios
  --trials N                  # default 6
  --tutor-turns N             # default 4 (the roadmap's 2-4 turn cap)
  --concurrency N             # default 6 parallel conversations
  --out DIR                   # default evals/socratic-handoff/out
  --label STR                 # free text stamped into report.md (e.g. "v2: hold-the-line rule added")
```

`TUTOR_MODEL` (default `MODELS.SONNET`, the shipping model) overrides just the
tutor — used above to compare Sonnet vs Opus on method-honoring.
Requires `ANTHROPIC_API_KEY` (the wrapper sources it the same way
[`evals/tutor-quality/run.sh`](../tutor-quality/run.sh) does). Every run
makes real Anthropic API calls — that's the eval; there's no mocked mode.

## Output

- `out/report.md` — headline answer-leak rate vs. the <1-in-20 gate, means
  across all conversations, and a per-scenario breakdown table.
- `out/leaked-transcripts.md` — the full transcript of every leaking
  conversation, so you can read exactly how it leaked.
- `out/runs.json` — every conversation + verdict, raw.

`out/` is gitignored (regenerate on demand). The durable, committed report
of the run that gated shipping is [`FINDINGS.md`](FINDINGS.md) — it's a
snapshot, not regenerated automatically; re-run and update it by hand after
a prompt change.

## Files

| File | Purpose |
|---|---|
| `prompt.ts` | Re-exports the **shipped** `buildHandoffPrompt` from `convex/lib/practice/handoff.ts` — the eval tests exactly what production sends. |
| `fixtures.ts` | Context-bearing adversarial, strategist, and spiraler scenarios, including scripted stop turns. |
| `lib/types.ts` | Shared `Scenario` / `Turn` types — including `ScholarCoachContext`, entry mode, and scripted turns. |
| `lib/tutor.ts` | Seeds the production client opener and calls the shipped prompt for generated replies; `TUTOR_MODEL` overrides the model. |
| `lib/scholarSim.ts` | Haiku scholar simulation: adversarial, strategist, or depleted spiraler. |
| `lib/judge.ts` | Opus judge — unchanged hard leak gate plus pedagogy/context/plane-landing dimensions. |
| `lib/util.ts` | Bounded-concurrency `pool()` + `withRetry()` (mirrors `evals/observer/run.ts`'s pool helper). |
| `run.ts` / `run.sh` | The orchestrator + shell wrapper. |
| `FINDINGS.md` | The committed report: measured leak rate, leak modes found, prompt iterations, ship/no-ship verdict. |

## Why an adversarial scholar (not a cooperative one)

A leak-rate eval that only tests a well-behaved kid understates the real
risk — real stuck kids bargain, guess, and beg. The scholar sim in
`lib/scholarSim.ts` is deliberately given the real answer and instructed to
use it as bait (stating it as a guess to see if the tutor confirms), because
"confirming a correct guess" is one of the most natural ways a tutor leaks
without ever typing the number itself.

## Production fidelity

This harness imports the **live** handoff prompt builder
(`convex/lib/practice/handoff.ts :: buildHandoffPrompt`) via `prompt.ts`, so a
prompt change in `convex/` is reflected here with no copy to keep in sync — the
eval and production cannot drift. It still does NOT reconstruct the full
`serve_practice_problem` plumbing (it feeds the builder a scenario's stem,
wrong answers, and low-cardinality context directly), and it exercises the
**prompt** layer, not the
server-side deterministic backstop (`replyLeaksAnswer`) that redacts a leaked
answer string before it reaches the scholar — that backstop is a second line of
defense the eval intentionally measures around, so the prompt's own leak rate is
visible.
