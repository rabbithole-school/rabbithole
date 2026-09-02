# cross-family-verify — second-family verification on promotion candidates

**What / why (Finding 2).** The `evals/curriculum-sim/` self-improving-curricula
loop uses **Opus as both the judge and the improver**. Shared model weights share
quirks, so the improver can learn to *please the judge* rather than help the child
(review/sim-realism-lessons.html §4 Finding 2). Splitting the whole loop across
model families isn't worth the infrastructure yet. This is the **cheap version**:
before a teacher ever sees **"promote"**, re-judge the winning variant's simulated
transcripts with a **GPT-family** judge and report whether a *second model family
agrees* — cross-family verification at the decision boundary only.

It re-judges with the **exact same rubric, tool schema, and unit-design payload**
the curriculum judge used (imported from the canonical pure product modules), so
the two families' 1–5 scores are directly comparable. Output is a per-dimension Anthropic-vs-GPT agreement report,
a headline agree/disagree, and any dimensions where the families disagree
**materially** (|Δ| > 1 point).

Read the deltas as **directional evidence for a teacher**, not truth: absolute 1–5
model scores are noisy (Finding 3), so we only flag gaps larger than a full point.

## Usage

```bash
# Keyless structure demo — no API call, deterministic stub (great for CI / a first look):
npx tsx evals/cross-family-verify/run.ts \
  --transcripts evals/cross-family-verify/fixtures/sample-run.json --dry-run

# Real second-family re-judge (requires an OpenAI key):
OPENAI_API_KEY=sk-... npx tsx evals/cross-family-verify/run.ts \
  --transcripts evals/curriculum-sim/out/sessions.json

# Point at a specific GPT model, and save the report:
OPENAI_API_KEY=sk-... OPENAI_JUDGE_MODEL=gpt-4o \
  npx tsx evals/cross-family-verify/run.ts \
  --transcripts evals/curriculum-sim/out/sessions.json --out evals/cross-family-verify/out
```

### Flags

| Flag | Meaning |
|---|---|
| `--transcripts <file>` (alias `--run`) | A curriculum-sim run output JSON (see shape below). **Required.** |
| `--dry-run` | Skip the API; use a deterministic second-family stub. Runs with **no key**. |
| `--model <id>` | GPT-family model id (default `gpt-4o`, or `OPENAI_JUDGE_MODEL`). |
| `--out <dir>` | Also write `agreement.md` + `agreement.json` there. |

### Env

- `OPENAI_API_KEY` — **required** unless `--dry-run`. New OpenAI usage is confined to
  `evals/`; `convex/` is untouched.
- `OPENAI_JUDGE_MODEL` — override the default GPT judge model (`gpt-4o`). Pick a
  *different family* from the Anthropic curriculum judge — that's the whole point.

## Input shape (`--transcripts`)

Exactly what `evals/curriculum-sim/run.ts` writes to `out/sessions.json`:

```jsonc
{
  "activity":  { "title": "...", "kind": "online", "learningGoal": "...", "systemPrompt": "..." },
  "sessions":  [ { "profile": {...}, "turns": [ { "role": "tutor|scholar", "content": "..." } ], "stopReason": "goal|stuck|maxTurns" } ],
  "verdicts":  [ { "goalAttainment": 5, /* ...20 fields, the ANTHROPIC judge */ } ],
  "aggregate": null,            // optional; ignored (recomputed here)
  "judgeModel": "claude-opus-4-8" // optional; used only for the report label
}
```

`verdicts` must be present and parallel to `sessions` (run curriculum-sim with
`--judge`). `verdicts[i]` and `sessions[i]` describe the same session. A tiny
fixture lives in `fixtures/sample-run.json`.

## How it reads

- **Cross-family agreement: AGREE / DISAGREE** — AGREE means no dimension differs by
  more than a full point.
- **Fitness (promotion scalar)** — the mean of the maximized curriculum-fit dims
  (`goalAttainment`, `deliverableReach`, `productiveStruggle`). If the second family
  scores the "winner" materially lower here, that's the strongest reason to hold.
- **Material disagreements (|Δ| > 1)** — the dimensions to eyeball, worst first. A
  disagreement on a *fitness* or *protected* dim is load-bearing; *gifted* and
  diagnosis-only *design* gaps are softer notes and never change promotion.

The recommendation is tuned for the promotion boundary: this only runs on a variant
the Anthropic loop already picked, so the question is narrowly "does a different model
family confirm before the teacher promotes?"

The comparison derives all 17 numeric dimensions and their lens groups from
`convex/lib/curriculumDimensions.ts`, preventing judge-family drift.
