# PCM-dimension tagging gate

A focused, fast gate for the observer's OPTIONAL `pcmDimension` tag — the
calibration loop described in `review/assessment-and-goals-plan.html` §11
(teacher-committed PCM ratings vs. the AI's suggested ratings) depends on
evidence being reliably tagged with the right dimension so it briefs the
right part of a teacher's course narrative. Same shape as its siblings
`rigor-check.ts` / `fluency-check.ts`, just a narrower question:
**does the observer tag evidence with the PCM dimension it obviously belongs
to?**

Not linked from the main `README.md` (this file is intentionally standalone)
— see `pcm-dimension-check.ts`'s top-of-file comment for the full design
notes.

## What it checks

Four fixtures under `fixtures/`, each hand-engineered to clearly exercise
exactly ONE PCM dimension (per the tagging guidance in `convex/prompts.ts`):

| Fixture | Dimension | Why |
|---|---|---|
| `11-pcm-core-demonstration` | `core` | unprompted, straight demonstration of essential knowledge (photosynthesis) — no cross-domain link, no revision, no identity framing |
| `12-pcm-connections-unprompted` | `connections` | an unprompted interdisciplinary link (Fibonacci across biology/math/art) |
| `13-pcm-practice-revised-hypothesis` | `practice` | designed an investigation, revised the conclusion when the data disagreed, cited a source |
| `14-pcm-identity-harder-path` | `identity` | chose the harder path, named the kind of thinker they want to be |

Each fixture carries a `pcmGold: { expectedDimension }` block (the same
shape as `rigor-check.ts`'s `rigorGold`).

It runs the PRODUCTION observer via `evals/observer/lib/runObserver.ts` — the
real `OBSERVER_SYSTEM_PROMPT`, `OBSERVER_TOOL` schema, and
`parseObserverResponse`, so this gate cannot drift from what actually ships —
`RUNS` times per fixture, and checks whether the expected `pcmDimension` shows
up on ANY observation / sessionSignal / crossDomainConnection the observer
emits that run. Before making any API calls, `assertSchemaInSync()` fails
loudly if `convex/lib/pcm.ts`'s `PCM_DIMENSIONS` ever drifts from the
`pcmDimension` enum baked into `OBSERVER_TOOL`.

## Run it

```bash
./evals/observer/pcm-dimension-check.sh                 # sonnet, the live observer model
MODEL=opus RUNS=5 ./evals/observer/pcm-dimension-check.sh
# or directly:
ANTHROPIC_API_KEY=... npx tsx evals/observer/pcm-dimension-check.ts
```

Env vars: `MODEL` (`sonnet` default / `opus` / `haiku` / a raw model id),
`RUNS` (samples per fixture, default 3 — LLMs vary).

## Output

Prints a pass/miss table to stderr — one row per fixture with the hit rate
(fraction of runs where the expected dimension was tagged somewhere) and
every distinct `kind:dimension` tag actually seen, followed by a per-run MISS
note for any run that didn't tag the expected dimension. Exits non-zero if
any fixture's hit rate falls below 50% (majority) across `RUNS` samples — a
gate you can wire into CI or run by hand after editing the observer prompt's
PCM section.

If `ANTHROPIC_API_KEY` isn't set, the script prints a message and exits 0 —
this harness makes real Anthropic calls, it doesn't mock them.
