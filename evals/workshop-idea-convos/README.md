# Workshop idea-conversations eval

Rung-2 (spot-eval-style, **no judge** — see
[`.agents/skills/prompt-eval/SKILL.md`](../../.agents/skills/prompt-eval/SKILL.md)).
This is documentation-by-transcript: it replays scripted scholar turns through
the **real** Workshop system prompt (idea-conversations flag ON) and the **real**
`send_idea_to_teacher` tool schema, then writes transcripts you read with your
eyes.

It answers one question: **when a kid has an idea about Rabbithole, is the bot a
thinking partner (never a gate) — and does the kid's idea always reach the
teacher, in the kid's own words, the moment they want it sent?**

## What this exercises

- The real prompt: `buildMetaSystemPrompt({ …, ideaConvosEnabled: true })` from
  [`convex/metaPrompts.ts`](../../convex/metaPrompts.ts) — the same builder
  `/meta-stream` uses, with the thinking-partner Workshop section.
- The real tool: `send_idea_to_teacher` from
  [`convex/lib/scholarIdeaTools.ts`](../../convex/lib/scholarIdeaTools.ts)
  (`makeIdeaConvoTools`), run through the Anthropic SDK `toolRunner` with the
  same `max_iterations` cost cap.
- **Stubbed capture:** the tool's DB write is injected as an *echo* — it records
  exactly what the model chose to send (`scholarWords` / `refined`) and returns a
  `captured` result, so no Convex/deployment is needed and the transcript shows
  precisely what reaches the teacher.

## Run

```bash
ANTHROPIC_API_KEY=... npx tsx evals/workshop-idea-convos/run.ts
```

| Flag | Default | Meaning |
|---|---|---|
| `--script <path>` | every `scripts/*.json` | run one scenario |
| `--out <dir>` | `evals/workshop-idea-convos/out` | output dir (git-ignored) |
| `--model <id>` | `MODELS.SONNET` | model override |

Output: `out/<scenario>.md` (eyeball) + `out/<scenario>.json` (raw events + the
`sent` list). `out/` is git-ignored; the curated
[`examples/`](./examples) transcripts ARE committed — they're the documentation
of how this feels. Each `.md` opens with a **"What reached the teacher"** summary.

## The scenarios (`scripts/`)

Three kids, three points on the proportionality curve:

1. **`candy-for-right-answers`** — an extrinsic-reward idea (touches how learning
   works) → a warm, two-question conversation → a **refined** idea sent WITH the
   kid's consent, carrying BOTH her original words and the framing she agreed to.
2. **`leaderboard-just-send-mine`** — a competition idea → one pedagogy question →
   the kid INSISTS ("just send mine") → the tool fires with `scholarWords` only,
   **no `refined`**, no pushback. **This is the guardrail proof.**
3. **`night-mode`** — a cosmetic idea → near-zero discussion → offer → send as-is.

## What "good" looks like

Read the transcript against the QB guardrails:

- **Thinking partner, NOT a gate.** The kid can ALWAYS send — original and
  unrefined — the moment they want. "just send it" → it sends it, no pushback,
  no "improve it first," no implying the idea isn't good enough.
- **Proportionality.** Cosmetic ideas get an offer and a move-on; only ideas
  about how learning works (rewards, competition, shortcuts, answer-giving) earn
  one or two questions — never a seminar, never a leading-question funnel.
- **The kid's words survive.** `scholarWords` is always the kid's own phrasing;
  `refined` rides along ONLY when a conversation reshaped the idea and the kid
  agreed. The teacher sees both.
- **Ceiling held.** "I'll send this to your teachers" — never a build promise.

The three files in [`examples/`](./examples) each carry a short "what to notice"
note over the raw run; `leaderboard-just-send-mine.md` is the guardrail proof.

## Tuning notes (this run)

On the first real run (`claude-sonnet-5`), all three scenarios behaved to spec
with **no prompt tuning required** — including the critical case (b): the model
sent the kid's original words with no `refined` field the moment they said "just
send my idea the way i said it," and correctly reported it *already sent* on the
repeat rather than double-filing.

## Native surface

`/meta-stream` has a native (Expo RN) surface
([`native/src/hooks/useReflectionChat.ts`](../../native/src/hooks/useReflectionChat.ts))
whose SSE reader consumes only `ev.text` and ignores other event types, so
turning the flag on is native-safe with no native code change: while the tool
runs the kid sees a brief pause, then the streamed reply. A nicer native
"sending your idea…" affordance is possible later but isn't required to ship the
experiment. **Scholar-facing parity note:** the composer-card UI change (below)
and any native affordance are UI follow-ups deliberately **not** built in this
run — see the PR report.
