# Uptake reproduction: can an LLM judge, given the human codebook, match expert raters?

2026-10-18. Public data only (Demszky et al. 2021, NCTE grade 4–5 math classrooms). No Rabbithole or scholar data.

## Setup

- **Data:** `ddemszky/conversational-uptake`, 2,246 student→teacher exchanges, 1,998 with an uptake label (low 0 / mid 1 / high 2). Each item was assigned to three expert raters. Some items ended up with one or two ratings, apparently because raters who marked an exchange off-task skipped uptake.
- **Judge prompt:** `judge-prompt.md` is the original coding instrument (validity, the active-listening levels with all their examples, and the FAQ), lightly reformatted. Nothing was tuned: v0 is the first and only prompt run, so there is no test-set overfitting. The judge sees only the exchange pair. The human raters also saw the two preceding utterances and the lesson topic.
- **Sample:** 400 labeled exchanges (seeded shuffle), scored once each by Sonnet 5.5 and by Opus 5.5. Output is JSON with a label plus a low/mid/high probability; "expected value" is the probability-weighted score.
- **Reconstructing ratings:** the CSV publishes only the mean, the number of raters who agreed, and the majority. On a 0–2 scale those pin down each item's rating multiset uniquely, except for one pattern: mean 1.0 with no agreement, which fits {1}, {0,2} or {0,1,2}. The analysis is run twice, dropping those items and treating them as {0,1,2}. Conclusions hold either way.

## Results (drop-ambiguous run; the {0,1,2} run is in parentheses)

The headline test treats the judge as a fourth rater. Hold out one human, take the mean of the other two, and compare how well the held-out human tracks that mean against how well the judge tracks the same mean. The test uses three-rater items: 321 of them (340 in the {0,1,2} run).

| Leave-one-out Spearman vs. the other two raters' mean | Sonnet 5.5 | Opus 5.5 |
|---|---|---|
| A held-out human | 0.46 (0.42) | 0.46 (0.41) |
| Judge label | 0.50 (0.51), gap 95% CI [−0.07, +0.14] | **0.56 (0.56)**, gap CI [+0.01, +0.18] |
| Judge expected value | 0.61 (0.61), gap CI [+0.05, +0.24] | **0.67 (0.67)**, gap CI [+0.13, +0.29] |

| Other views | Sonnet 5.5 | Opus 5.5 |
|---|---|---|
| Spearman with the dataset's 3-rater z-score (the paper's target) | 0.66 (expected value) | 0.72 (expected value) |
| Exact agreement with a single rater (human–human is 61%) | 64% | 67% |
| Krippendorff's α, interval (humans alone 0.46) | 0.47 with the judge swapped in | 0.50 with the judge swapped in |
| Matches the majority label | 70% | 72% |
| On-task validity, agreement with the majority | 94–95% | 96% |

The paper reports, for reference: human leave-out Spearman ρ = .474 on z-scored ratings (our unscaled 0.41–0.46 is consistent), a 13-rater pilot upper bound of ρ = .539, and its purpose-trained pJSD BERT model at ρ = .540 against the z-score. The judge here, with zero training, reaches 0.66–0.72 on a 400-item subsample. That isn't a like-for-like comparison: it's a different sample, and pJSD scores every item.

**Reading:** with no tuning, an LLM given the published codebook agrees with the expert raters at least as well as they agree with each other, and Opus 5.5 clearly better. The probability-weighted score beats the hard label for both models, so use it.

## Where the judge disagrees

- **Opus over-calls "high"** (55% of labels against 49% for humans). It reads demonstrations and problem restatements as engagement where raters said "mid" or "low." Of the 180 items humans rated mid, 64 were scored high.
- Only 7 of 400 items are off by more than 1.33 points. Most are long teacher turns that drift, or teacher actions like "[Counting]" that need context the judge lacks.

## Caveats

1. **Contamination is possible.** The dataset has been public on GitHub since 2021. Memorizing per-item labels seems unlikely, but this can't rule it out. The real test is on data no model has seen: our own sessions.
2. **Uptake is a teacher-side code.** It measures whether the *teacher* (or tutor) took up the student's idea, not whether the student did the thinking. This run tests the *method* (borrow a validated codebook, check judge agreement against the human raters' agreement with each other). It does not test the learner-side construct the project needs.
3. Human agreement is low in absolute terms (α ≈ 0.4–0.46). "As good as a human" is a modest bar.

## Second codebook: focusing vs. funneling (Alic et al. 2022)

The same coding instrument has a "type of follow-up" item: is the teacher's prompt **focusing** (asks the student to explain or develop their own idea), **funneling** (leads them to a predetermined answer or procedure), or **no follow-up**? Alic et al. published expert labels for it on 2,348 NCTE exchanges (three raters each; majority label and averaged z-score released). Funneling is the leading-question pattern a Socratic tutor drifts into, so this item, more than uptake, targets a known tutor failure.

The judge prompt (`funneling/judge-prompt.md`) is the instrument's follow-up section, untuned. Opus 5.5 scored a seeded sample of 400 exchanges.

| | Judge (Opus 5.5) | Paper's reference points |
|---|---|---|
| Three-way (none < funneling < focusing) Spearman vs. 3-rater z-score | **0.73** (expected value) | Best trained model (RoBERTa) ≈ 0.76; human leave-out 0.64 |
| Funneling vs. focusing only, Spearman vs. filtered z-score | **0.63** | Human leave-out 0.32 |
| Exact match with the majority label | 71% | |

The human leave-out numbers compare one rater with the other two, so they are a floor for agreement with the 3-rater average, not a like-for-like bar. The comparison that is like-for-like is the trained model: with no training, the judge comes within 0.03 of a model fine-tuned on this dataset.

**Its one clear bias:** it under-calls focusing. Experts labeled 23% of the sample focusing; the judge said 16%, and it moved 35 of 85 expert-focusing items to funneling. Among exchanges that have a prompt, experts call 42% focusing and the judge 26%. Read the judge's focusing rate as a lower bound.

Same caveats as above: the dataset is public, so contamination is possible, and the judge sees only the exchange pair.

## Our own tutor-quality judge against the same expert labels

`evals/tutor-quality` scores every tutor turn on our own pedagogy dimensions, and until now nobody had checked it against human labels. Its `socratic` and `overScaffolding` rubrics both describe the leading-question funnel, so the focusing/funneling labels give it a partial check. `ours-vs-experts/run.ts` runs the shipped `judgeTurn` unchanged, on its default model (Fable 5.1), over the same 400 exchanges. The test uses the 290 exchanges that have a follow-up prompt: does each score rank expert-focusing replies above expert-funneling ones?

| Score | Spearman vs. expert z-score | AUC, focusing > funneling (0.5 = chance) |
|---|---|---|
| Codebook judge (`funneling/`, Opus 5.5) | **0.63** | **0.88** |
| Ours: `overScaffolding` | 0.37 | 0.70 |
| Ours: `noviceStance` (79 scored) | 0.21 | 0.71 |
| Ours: `cognitiveOffloading` | 0.28 | 0.67 |
| Ours: `noSpoilers` | 0.25 | 0.65 |
| Ours: `followUpQuality` (236 scored) | 0.32 | 0.63 |
| Ours: `socratic` | 0.28 | 0.62 |

**Reading:** every one of our scores points the right way, but weakly. As a funneling detector, our headline `socratic` score is barely better than chance. It rates 14% of expert-funneling replies 4–5, against 31% of expert-focusing ones, and its means are 2.5 vs. 2.9. The codebook judge, run on the same exchanges with the same lack of context, separates them far better.

**Caveats:** our judge was written for a one-on-one AI tutor, not classroom teacher talk, and `socratic` deliberately bundles more than funneling. So this tests one claim only: that our scores catch funneling. On that claim, the published codebook wins clearly. The rest of our rubric (sycophancy, parasocial reliance, age fit, safety) has no public expert labels and is still unvalidated.

### Judge model: Opus 5.5 does as well as Fable 5.1 here

The same run with `JUDGE_MODEL=claude-opus-5-5` (`ours-vs-experts/results/claude-opus-5-5.jsonl`):

| Score | AUC, Fable 5.1 | AUC, Opus 5.5 |
|---|---|---|
| `socratic` | 0.62 | 0.65 |
| `overScaffolding` | 0.70 | 0.70 |
| `cognitiveOffloading` | 0.67 | 0.67 |
| `noSpoilers` | 0.65 | 0.65 |
| `followUpQuality` | 0.63 | 0.61 |

Turn by turn, the two judges agree within one point on 96–100% of the 400 turns for every dimension: exact agreement runs from 54% (`overScaffolding`) to 92% (`sycophancy`), and the dimension means differ by at most 0.27. This is classroom data, so the relational and safety dimensions barely vary here; the comparison says little about them. Opus 5.5 is the same rank as the tutor model, so the harness's judge-not-weaker check still passes.

## What this means for the plan

- The borrow-the-codebook method works on a public benchmark, at low cost: about 1.3M cached input tokens per model for 400 items.
- **Next:** do the same with a learner-side codebook. Demszky's student-reasoning labels (NCTE, behind the request form) or TalkMoves' student talk moves are the candidates, and they test the construct we actually want. Then step 2 of the handoff: two teachers label ~30 pseudonymized Rabbithole sessions. That is the unseen-data test that also answers the contamination caveat.
- Two tutor-side judges now exist with public validation: uptake ("did the tutor take up what the kid said?") and follow-up type ("focusing or funneling?"). Both can score Rabbithole tutor turns without a new rubric. Results on real sessions stay out of this repo.

## Files

See [README.md](README.md) for how to re-run. Raw judge outputs are in `results/*.jsonl`; the two analysis runs are in `results/report-*.txt`.
