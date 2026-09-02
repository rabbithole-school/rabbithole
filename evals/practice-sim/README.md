# Practice sim

Deterministic simulated-scholar harness for the practice engine. It imports the
real pure scheduler, placement, session, implicit-credit functions, and seed
graphs; it uses no Convex runtime, network, or LLM.

Run:

```bash
npx tsx evals/practice-sim/run.ts --days 28 --scholars 20 --seed 7 --domain whole-number-arithmetic
npx tsx evals/practice-sim/run.ts --compare baseline,banded
npx tsx evals/practice-sim/run.ts --compare phase1,phase2
```

Output includes Markdown tables plus a `METRICS_JSON` / `COMPARE_JSON` line for
copying into PRs. Every scheduler PR should carry a before/after sim run in the
description so review-share, calibration, off-band rate, and frontier movement
change visibly with the code.

`baseline` mirrors the original daily caller shape (`nextPractice` with mix
floor, review compression, and inferred-credit confirmation lane). `phase1`
freezes the Phase 1 upgrade knobs, while `phase2` adds per-skill retention
targets, speed-gated FIRe, upward negative evidence, and frontier review
compression.
