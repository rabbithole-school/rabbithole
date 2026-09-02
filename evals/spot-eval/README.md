# Spot-eval — scripted-scholar A/B harness

For quickly A/B-ing a tutor prompt change against a real (or hand-authored)
scholar conversation. Holds the model + scholar messages constant; only the
tutor's system prompt varies.

When to use this vs. the other eval harnesses:

- **`evals/observer/`** — observer model outputs (mastery, signals, seeds).
  Hand-authored fixtures + real dev transcripts, judged by Opus.
- **`evals/non-human-intro/`** — one specific tutor behavior (first-session AI
  disclosure), graded by Opus across N samples per case.
- **`evals/spot-eval/`** (this one) — eyeball-level A/B of a single prompt
  change on a single conversation. Cheap, no judge, structural metrics
  (length, `?` count, bold/bullet usage, affirmation openers). Use it when
  you want to *see* what a prompt change actually does turn-by-turn, not
  produce a rigorous score.

## Run

```bash
ANTHROPIC_API_KEY=... npx tsx evals/spot-eval/run.ts
```

Flags:

| Flag | Default | Meaning |
|---|---|---|
| `--script <path>` | `evals/spot-eval/scripts/pomegranate.json` | scholar script |
| `--out <dir>` | `evals/spot-eval/out` | output dir |
| `--model <id>` | `MODELS.SONNET` | model override |

Output:

- `out/runs.json` — both transcripts + per-turn metrics
- `out/report.md` — side-by-side markdown, eyeball-ready

## How it works

1. Reads the NEW Guidelines block from `convex/prompts.ts` at HEAD.
2. Reads the OLD Guidelines block from `git show HEAD~1:convex/prompts.ts`.
3. Builds two minimal system prompts (no dossier, no mastery, no unit — just
   the base prompt rendered with `scholarName`).
4. Runs the scholar script through both branches in parallel, sequential
   within each branch.
5. Computes structural metrics per response.
6. Renders a markdown report with collapsed OLD / expanded NEW per turn.

## Reconstructing a production failure safely

When a production conversation reveals a failure mode, inspect it only in the
approved private workflow. Match assistant timestamps to deployment history to
identify the actual code revision, then write a **new synthetic script** that
preserves the behavior under test without copying learner words, names, session
IDs, family details, or educational records. Never commit a verbatim or lightly
edited production transcript. Use the stored `promptVersion` only inside the
private analysis to group equivalent prompt configurations. For conversations
that predate runtime stamps, use the frozen [`../../PROMPT_HISTORY.md`](../../PROMPT_HISTORY.md)
archive. Never use an observer reanalysis as a prompt-version fallback: a later
analysis can stamp newer observer metadata onto an older conversation. The
harness's OLD baseline is whatever is at HEAD~1 of
`convex/prompts.ts`, which may not match the original production prompt.

## Caveats

- Both branches see the SAME scholar messages. We do not re-roleplay the
  scholar per branch because that lets the scholar's reactions covary with
  the tutor's response, confounding the A/B.
- The OLD baseline is `HEAD~1` of `convex/prompts.ts`. If you want to A/B a
  different baseline, swap the `git show HEAD~1:...` line in `run.ts`.
- Production tutor responses depend on a lot more context (dossier, mastery,
  unit/lesson, persona, prior topics) that this harness omits. Absolute
  response lengths here will be shorter than prod; trust the *deltas*, not
  the absolutes.

## Adding a script

Drop a JSON file under `scripts/`:

```json
{
  "scholarName": "Scholar A",
  "_source": "Synthetic scenario; no production transcript text or identifiers.",
  "messages": ["<start>", "first message", "second message", "..."]
}
```

Use `scripts/pomegranate.json` as the pattern: preserve the conversational
failure shape, not the source learner's record.
