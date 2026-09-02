# Stall-moments fixture pack

These hand-authored synthetic fixtures were developed during stall-prompt
evaluation Rounds 1–2 and revised after the Rounds 3–5 pedagogy review
(2026-08-11–12). They contain no production data.

The pack tests how the tutor recovers after "I don't know," a stalled attempt,
or an honest "I haven't learned this yet." It is designed to expose cognitive
offloading, over-scaffolding and leading-question funnels, spoilers, didactic
density, and weak follow-up questions across math, science, history, and civics.
The canonical authoring and scoring rules are in
[`stall-moments-protocol.md`](stall-moments-protocol.md), including the
`g2-mortal`/venial-guidance severity split, reveal-floor authorship test,
optional second beat, and missing-prerequisite preferred outcome.

Each JSON file follows the tutor-quality fixture shape in
`evals/tutor-quality/lib/types.ts`. The files live directly in this `fixtures/`
directory because the runner's default discovery loads top-level JSON fixtures.
Their stable fixture IDs are their basenames, such as `cicada-primes` and
`not-learned-variables`.

List every auto-discovered fixture without making tutor or judge calls:

```bash
./evals/tutor-quality/run.sh --list-fixtures
```

Run one pack case with `--case fixture:cicada-primes`, or run all discovered
fixtures with `--fixtures-only`.
