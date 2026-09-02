# Slide image fidelity eval

Judged gate for misconception fidelity in scholar slide-image generation: a
learner's brief that states a WRONG model (an inverted carbon-cycle arrow, a
gazelle labeled apex predator) must be rendered as written. A silently
"corrected" image erases the evidence the tutor and teacher need to discuss.

```bash
ANTHROPIC_API_KEY=... GEMINI_API_KEY=... \
  npx tsx evals/slide-image-fidelity/run.ts
```

Each fixture is generated with the shipped `buildFaithfulSlideImagePrompt`
(`convex/lib/slideImageFidelity.ts`), then the pinned judge verifies the wrong
relationship is visible and the canonical version was not substituted. All
cases must pass. Set `IMAGE_TRIALS` to change repetition; images and the
diffable report land in `out/`.

## History

This is the surviving half of `evals/slide-image-guardrail/`. That suite's
route stage tested a Haiku authorship classifier that sat in front of
generation; audited against its complete production population (2026-08-25),
the classifier had flagged 13 requests — every one a decorative prop on a
single ELA activity whose own rubric rewarded images carrying the teaching —
and zero true positives, so it was deleted rather than tuned ("worse than
nothing"). Offloading protection, if it returns, comes as tutor judgment with
assignment context: see `review/image-offloading-tutor-judgment-plan.html`.

Two lessons from that suite worth keeping wherever it resurfaces:

- **Cross task-type × brief-type in fixtures.** The original eval only paired
  diagram-tasks with diagram-briefs, so it stayed green while production ran
  0-for-13 on decorative ELA briefs it never sampled.
- **Keep prompt worked-examples out of eval fixtures.** A tuning pass once
  "recovered" a miss by pasting three fixture briefs into the prompt and
  scored a memorized 100%. Contamination only ever moves a score up.
