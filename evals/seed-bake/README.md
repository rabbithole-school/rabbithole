# seed-bake — does baking a unit beat ad-lib? (the ship gate)

The decision harness for **bake a seed → real unit on launch**
(`review/seed-to-unit-bake-plan.md`). The hypothesis: when a scholar launches a
quest from a *topic* seed, designing a small real unit on the fly (the **bake**)
gives a higher-quality tutoring experience than the current **ad-lib** (the
tutor just riffs on the topic). This eval is the gate: **we only ship the bake
if it's a clear quality win, net of the bake's latency.**

## How it works

For each exploration topic, the SAME synthetic scholars (from
`../curriculum-sim/scripts/cast.json`) work toward the SAME topic-level learning
goal under two tutors — the only difference is the tutor's system prompt:

| Arm | Tutor prompt |
|---|---|
| **ad-lib** | production `buildSystemPrompt` with `seedOriginContext` set, **no activity** — exactly what a topic-seed launch produces today |
| **baked** | production `buildSystemPrompt` driven by the **real** baked activity's `systemPrompt` + deliverable |

The baked arm calls the **real** bake (`internal.bakeEval.bakeTopicForEval` via
`npx convex run`, server-side) — the exact code path the launch flow schedules —
and times it. Both transcripts are judged by the **curriculum-sim rubric**
(curriculum-fit + gifted lens + protected tutor dims + the measured
Investigation bar, Opus judge), then
`isBetter` (from `curriculum-sim/lib/score.ts`) decides: baked must beat ad-lib
**fitness** by more than the noise floor **and** not regress any protected/gifted
dim. The bake's wall-clock latency is reported alongside.

The **Investigation bar (design)** is a separate measured-not-gating section.
Its four 1–5 dimensions do not change fitness, `isBetter`, protected-dimension
regressions, or any pass/fail gate:

- `singleSpine` — Does every activity visibly advance ONE conceptual
  through-line? 5 = one spine, each activity a step on it; 1 = a grab-bag tour
  of subtopics.
- `discoveryArc` — Does the scholar DERIVE the central idea (from data, pattern,
  or failed prediction) BEFORE it is named/explained? 5 = name arrives as payoff
  after derivation; 1 = concept stated up front, then practiced.
- `handsOnMission` — Does the quest include a real away-from-screen mission
  (measure/count/build/tally with real objects) whose results feed later work?
  5 = mission present, results load-bearing; 3 = gestured at but optional /
  results unused; 1 = fully screen-bound.
- `earnedPayoff` — Is there an engineered surprise (inversion, hidden identity,
  data overruling intuition) that the design sets up (gap/bet/prediction first)?
  5 = gap opened early, payoff lands; 1 = no gap, no surprise, praise as ending.

These design dimensions mainly characterize the baked arm; the ad-lib arm has
no unit design by construction and will usually score poorly. To evaluate a
prompt-side quality change, run seed-bake before/after on the same topics and
compare the Investigation-bar section.

Everything reusable — the scholar simulator, the judge, the scoring/gate — is
imported from `evals/curriculum-sim`; this harness only adds the two prompt arms
+ the real-bake driver + the report.

## Run

```bash
# Wiring smoke test — stubbed models + stubbed bake, no API key, no backend:
./evals/seed-bake/run.sh --offline

# Live — real bake (needs a provisioned worktree) + live judge (needs ANTHROPIC_API_KEY):
./evals/seed-bake/run.sh --scholars 2 --max-turns 8

# Custom topics:
./evals/seed-bake/run.sh --topics evals/seed-bake/scripts/topics.json
```

Flags: `--offline`, `--scholars N` (synthetic scholars per topic, default 2),
`--max-turns N` (per session, default 8), `--topics <file>`, `--cast <file>`.

Output: `evals/seed-bake/out/report.md` (the verdict + per-dimension deltas +
latency) and `out/verdicts.json` (raw judged verdicts).

## Reading the result

- **Quality verdict** = `isBetter(baked, adLib)`. ✅ means baked cleared the gate
  (fitness gain over the noise floor, no protected/gifted regression).
- **Latency cost** = mean bake wall-clock. The bake runs in the background while
  the scholar is already in the ad-lib session, so latency is *hidden* — but a
  marginal quality gain may still not be worth a ~1–2 min bake. That trade-off is
  the human call the report frames.

## Caveats

- Live mode hits Anthropic for the tutor (Sonnet), scholar-sim (Haiku), and
  judge (Opus), and runs N real bakes — it costs tokens and minutes.
- The bake creates throwaway scholars/seeds/units in the **dev** deployment
  (disposable worktree backend). Don't point it at prod.
- A handful of topics × a couple scholars is a directional signal, not a
  publication-grade number — widen the cast/topics before a final ship call.
- The in-product judge twin deliberately remains unchanged in this pass; adding
  the Investigation bar there is follow-up work.
