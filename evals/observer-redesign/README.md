# Observer-redesign spot eval (teacher-judged)

A/B the **current** observer (Bloom's 0–5 mastery floats) against the **proposed
portrait** (Think/Care/Learn notes · emerging/developing/secure readiness on Think
only · sparks) on the SAME real transcripts, under the SAME model. No LLM judge —
**the teacher is the judge** (Andy + Carl). See the design in
[`review/observer-assessment-redesign.md`](../../review/observer-assessment-redesign.md).

```
real transcripts ──► current observer  (convex/prompts.ts, shipping)   ┐
       (prod)    └─► proposed observer  (lib/redesignPrompt.ts, new)    ├─► report.md
                     same model both sides ─────────────────────────────┘   (side by side)
```

## What it produces

`out/report.md` — per kid, two blocks side by side (order randomized to reduce
primacy bias; **neutral-labeled, not blind** — the formats are obviously
different). Each proposed block renders two views off one record:

- **🧭 Teacher view** — Think notes by readiness, misconceptions flagged, and
  `gatesNext` ("close before X") for not-yet-secure prerequisites.
- **🌱 Family view** — strengths + within-session growth + sparks as "next
  adventures." No gap/deficit language, no decimals.

Then two checkboxes per kid: does the teacher view flag the right "needs secure
next"? would you show the family view to the parent/kid?

## Run

```bash
# 1. Pull real transcripts (READ-ONLY service account; creds outside any repo).
set -a; source ~/.claude/rabbithole-prod.env; set +a
node evals/observer-redesign/fetch-transcripts.mjs        # → data/transcripts.json (gitignored)

# 2. Run the A/B (reads ANTHROPIC_API_KEY from env or the parent CLAUDE.md).
ANTHROPIC_API_KEY=... npx tsx evals/observer-redesign/run.ts --model sonnet --limit 6
```

Node 22 is required (Convex/SDK toolchain). Outputs land in `out/`.

## Honest limitations

- **Growth is under-tested.** "You couldn't a month ago, now you can" needs
  longitudinal data across sessions; one transcript can only show *within-session*
  movement (`withinSessionGrowth`). Cross-session growth is a follow-up — feed the
  observer prior readiness states and diff.
- **Not blind.** A number system and a portrait are visually distinguishable, so
  labels are shown (order randomized). Judge on the two questions, not on which
  "looks newer."
- **Prod is read-only.** `fetch-transcripts.mjs` calls queries only, as the
  `claude-readonly` teacher account. `data/` and `out/` are gitignored (PII).
- **Single model, single sample.** This is a spot eval for direction, not a
  statistical claim. If the direction holds, the judged `evals/observer/` harness
  is where a defensible number would come from.
