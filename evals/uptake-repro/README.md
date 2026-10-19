# Uptake reproduction

Can an LLM judge, given a published human coding instrument, label classroom
exchanges as well as the expert raters agree with each other? This eval tests
the "borrow a validated codebook" method on public data before any teacher time
goes into labeling Rabbithole sessions. Results: [FINDINGS.md](FINDINGS.md).

`funneling/` repeats the test for the same instrument's focusing-vs-funneling item, against the Alic et al. (2022) labels: `./funneling/fetch-data.sh`, then `node funneling/run-judge.mjs claude-opus-5-5 funneling/data/sample.json funneling/results/claude-opus-5-5.jsonl funneling/judge-prompt.md`, then `python3 funneling/analyze.py funneling/results/claude-opus-5-5.jsonl`.

`ours-vs-experts/` scores the same funneling sample with our own `evals/tutor-quality` per-turn judge, unchanged, to check its pedagogy scores against the experts. After the funneling fetch: `NODE_OPTIONS=--conditions=import npx tsx evals/uptake-repro/ours-vs-experts/run.ts` (from the repo root), then `python3 evals/uptake-repro/ours-vs-experts/analyze.py evals/uptake-repro/ours-vs-experts/results/claude-fable-5-1.jsonl evals/uptake-repro/funneling/results/claude-opus-5-5.jsonl`.

It uses only the public NCTE uptake dataset (anonymized grade 4–5 math
classrooms, 2010–2013). No Rabbithole or scholar data.

## Run

```bash
./fetch-data.sh                                  # pinned upstream commit, sha256-checked, into data/ (gitignored)
node run-judge.mjs claude-opus-5-5 400 8         # needs ANTHROPIC_API_KEY; resumable, appends to results/<model>.jsonl
python3 analyze.py results/claude-opus-5-5.jsonl     # numpy only; AMBIG=012 for the sensitivity run
```

The 400-item sample is a seeded shuffle, so a rerun scores the same items.

## Files

- `judge-prompt.md`: the system prompt. It's the original coding instrument (validity items, active-listening levels and examples, rater FAQ), reformatted, with the follow-up-type section dropped because the dataset doesn't label it.
- `run-judge.mjs`: scores exchanges via the Anthropic API with JSON-schema output (label plus a low/mid/high probability).
- `analyze.py`: rebuilds each item's human ratings from the published aggregates and reports leave-one-out agreement, Krippendorff's α, pairwise agreement, and a confusion matrix.
- `results/`: the committed judge outputs for Sonnet 5.5 and Opus 5.5, and their reports.

## Attribution

Data and coding instrument: Demszky, D., Liu, J., Mancenido, Z., Cohen, J.,
Hill, H., Jurafsky, D., & Hashimoto, T. (2021). *Measuring Conversational
Uptake: A Case Study on Student-Teacher Interactions.* ACL 2021.
Dataset: <https://github.com/ddemszky/conversational-uptake> (MIT), fetched at
commit `67fb30cf7c3ea6f619487e33d2f99692dca107d0`, not vendored. The coding
instrument is linked from that repository's README; `judge-prompt.md` adapts it.

Focusing/funneling labels: Alic, S., Demszky, D., Mancenido, Z., Liu, J., Hill, H., & Jurafsky, D. (2022). *Computationally Identifying Funneling and Focusing Questions in Classroom Discourse.* BEA workshop, NAACL 2022.
Dataset: <https://github.com/sterlingalic/funneling-focusing> (MIT), fetched at
commit `0bcda55da92853c3e26b1d6b2b62f3577094a097`, not vendored.
