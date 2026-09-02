# Pad-grounded practice Hint eval

Judged merge gate for the PR-4 image-grounded one-line/step producer.

```bash
ANTHROPIC_API_KEY=... npx tsx evals/practice-pad-hints/run.ts
```

The harness renders fixed arithmetic work into PNGs, calls the shipped
`buildPadHintPrompt`/`PAD_HINT_TOOL`, runs the shipped verifier, then uses the
pinned Opus judge for:

- strict scholar-visible answer leak (`<5%`);
- `groundsInTheirWork` (mean `>=4.0/5`).

It runs identical fixtures through Haiku and Sonnet. Choose the cheapest model
that passes both gates. Generated output lives in `out/`.
