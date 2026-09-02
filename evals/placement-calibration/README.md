# Placement Calibration Harness (`evals/placement-calibration/`)

> **Founder-ruled lane J9 (Option A): MEASURE the adaptive placement search, tune
> nothing.** This harness quantifies how the production placement path behaves for
> a grid of synthetic scholars. It changes **no** placement constant. See
> `review/pilot9/FINDINGS_SYNTHESIS_PILOT9.md` finding #6 (the day-3 geometry run
> that opened with formal angle language for a grade-2 kid, hit two honest IDKs in
> the first four questions, oscillated, and took 15 probes to land at grade 2).

## What it does

It drives the **real** production placement path —
`api.practiceSkills.submitPlacementAnswer` — through
[`convex-test`](https://www.npmjs.com/package/convex-test), exactly the way
[`convex/__tests__/impliesPlacement.test.ts`](../../convex/__tests__/impliesPlacement.test.ts)
does. It is **not** a parallel reimplementation of the search: the harness only
supplies a scholar's answers and reads back what the server actually served,
graded, and credited (`practicePlacements.probeLog`, `practiceMastery`).

Each synthetic scholar is an **oracle** whose true knowledge is a rule:

- **knows every graph node at/below a true frontier grade `G`** in the domain, and
  nothing above it;
- answers a probe with the item's true answer when it knows the node, or an honest
  **"I haven't learned this yet"** (IDK) when it doesn't;
- optional noise: `p(slip)` — a careless wrong answer on a *known* node; and
  `p(guess-correct)` — a lucky right answer on an *unknown* multiple-choice node.

## The grid

`profiles × domains × entry-kinds × noise` (see [`grid.ts`](./grid.ts)):

| axis | values |
| --- | --- |
| **true-frontier grade `G`** | 2, 3, 4, 5, 6 |
| **domain** | all 7 registered practice domains (`PRACTICE_DOMAINS`) |
| **entry kind** | `default-foundational` and `you-pick` |
| **noise** | `clean`, `slip15` (`p(slip)=0.15`), `guess25` (`p(guess)=0.25`) |

**Entry kinds** model how the scholar reached the single-domain placement:

- **`default-foundational`** — the system knows the scholar's grade and passes it
  as a prior (`gradeLevel = G`); the affect-safe first probe is grade-anchored.
  Models a domain entered with an accurate prior.
- **`you-pick`** — the scholar picked the domain **cold**, with no grade prior
  (`gradeLevel` unset → the first probe defaults to ~1/3 up each strand). This is
  the pilot's geometry case (Nova chose Area & Perimeter with no prior).

Clean cells are deterministic (one seed); each noisy cell is sampled over
`NOISE_SEEDS` seeds and averaged.

## Metrics (measured per run)

| metric | definition |
| --- | --- |
| **probes** | probes to converge (`probeLog` length) |
| **IDK burden** | honest IDKs the kid eats (server `unknown` outcomes) |
| **overshoot (grades)** | how far ABOVE the true frontier the first probe of each strand opens — max & mean, in grades. The pilot's "formal angle language for a grade-2 kid." |
| **oscillation** | direction changes in served difficulty — global (served grade-rank sequence) and mean per-strand (served topo index) |
| **over-credit / under-credit** | credited-vs-true frontier error, counted **separately**: over = nodes credited but not known; under = known nodes not credited |
| **grade-error** | rank(told grade) − rank(the *ideal* grade for this oracle). Measured vs. the ideal label (`derivePlacedThroughGrade` of the true known set) so a domain with no content at/below `G` scores 0, not a spurious deficit |

## How to run

Everything runs under **Vitest** — convex-test needs Vitest's
`import.meta.glob` function-module map and the repo's `edge-runtime` test
environment (this is why the harness is Vitest-driven, not `npx tsx`; every
convex-test harness in this repo runs the same way). **No Convex deployment is
needed** — convex-test runs the backend in-process against the committed
`convex/_generated`, so no provisioned backend is needed.

**Fast assertions (part of `pnpm test`).** A small deterministic sub-grid with
invariant checks; runs in seconds and keeps the full suite unaffected:

```bash
npx vitest run evals/placement-calibration/calibration.test.ts
```

**Regenerate the full report.** Gated behind an env flag so it is **skipped** in
the normal suite (it runs the whole grid, ~40s):

```bash
PLACEMENT_CALIBRATION_FULL=1 npx vitest run evals/placement-calibration/report.test.ts
```

This writes [`CALIBRATION_REPORT.md`](./CALIBRATION_REPORT.md) — the distributions
(tables), the 3 worst cells, and the knob each bad cell implicates.

## Determinism

A run is deterministic given `(cell, seed)`: a seeded `mulberry32` PRNG drives all
noise, and the server-side item seed is pinned (`PLACEMENT_ITEM_SEED`). With a
zero-noise oracle the run is seed-invariant (the search path depends only on the
oracle's grade-truthful answers). The report is regenerated, never hand-edited.

## Files

| file | role |
| --- | --- |
| [`harness.ts`](./harness.ts) | oracle, the real-path driver (`runCell`), metric extraction — the only Convex-touching module |
| [`grid.ts`](./grid.ts) | grid axes, per-cell aggregation, composite `badness`, and the **knob attribution** (analysis only) |
| [`report.ts`](./report.ts) | pure Markdown rendering of the results |
| [`calibration.test.ts`](./calibration.test.ts) | fast invariant assertions (runs in `pnpm test`) |
| [`report.test.ts`](./report.test.ts) | gated full-grid generator → `CALIBRATION_REPORT.md` |
| [`CALIBRATION_REPORT.md`](./CALIBRATION_REPORT.md) | the generated report (measurement + knob analysis) |

## The rule of this lane

**No constant is tuned here.** The knob attribution in the report
(`start-prior` / `step-size` / `convergence-rule`) is a **diagnosis** pointing a
human at the right lever — the start prior (`affectSafeFirstProbeIndex` /
`firstProbeTargets` / grade ring), the binary-search step + cross-strand
round-robin, or the convergence rule (per-strand / global probe caps, trust-upward
monotonicity, the placed-through-grade label). Acting on it is a separate,
approved change.
