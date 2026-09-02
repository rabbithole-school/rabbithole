# Workshop Code Explorer eval

Rung-2 (spot-eval-style, **no judge** — see
[`.agents/skills/prompt-eval/SKILL.md`](../../.agents/skills/prompt-eval/SKILL.md)).
This is documentation-by-transcript: it replays scripted, coding-curious
scholar turns through the **real** Workshop system prompt (flag ON) and the two
Code Explorer tools, then writes transcripts you read with your eyes.

It answers one question: **when a kid asks how Rabbithole works, does the chat
stay a tour guide — translating, not dumping — or does it turn into a code
firehose?**

## What this exercises

- The real prompt: `buildMetaSystemPrompt({ …, codeExplorerEnabled: true })`
  from [`convex/metaPrompts.ts`](../../convex/metaPrompts.ts) — the same builder
  `/meta-stream` uses.
- The real tools: `list_rabbithole_files` + `read_rabbithole_file` +
  `search_rabbithole_code` from
  [`convex/lib/scholarCodeTools.ts`](../../convex/lib/scholarCodeTools.ts), run
  through the Anthropic SDK `toolRunner` with the same `max_iterations` cost cap.
- The real fetch: every tool call hits the **public** repo over the network,
  **unauthenticated** — no forked fetch logic, exactly like production.

## Run

```bash
ANTHROPIC_API_KEY=... npx tsx evals/workshop-code-explorer/run.ts
```

| Flag | Default | Meaning |
|---|---|---|
| `--script <path>` | every `scripts/*.json` | run one scenario |
| `--out <dir>` | `evals/workshop-code-explorer/out` | output dir (git-ignored) |
| `--model <id>` | `MODELS.SONNET` | model override |

Output: `out/<scenario>.md` (eyeball) + `out/<scenario>.json` (raw events,
incl. tool calls/results). `out/` is git-ignored; the curated
[`examples/`](./examples) transcripts ARE committed — they're the documentation
of how this feels.

## The scenarios (`scripts/`)

Three python-curious kids with basic CS knowledge (misspellings and all):

1. **`how-do-you-decide`** — "how do you decide what to say to me" → "can i see
   the file with your instructions" → "is that python?" → "what does the
   `${...}` thing do".
2. **`the-sky`** — "how does the star map get drawn" → "show me the real code" →
   "i know a little python, how different is this" → "which line makes the stars
   twinkle".
3. **`could-i-code-here`** — "could i write code for rabbithole one day" → "what's
   the easiest file a kid could understand" → "if i wanted shooting stars where
   would that go" (ends in a consent-gated Workshop idea).

## What "good" looks like

Read the transcript and check the tour-guide register held:

- **Translation, not dumping** — quotes ≤ ~10 short lines, then explains in
  plain language. No walls of code.
- **Thinking questions** — sometimes asks what a line does *before* telling.
- **Honest limits** — reads public code but says plainly it can't run it, change
  it, or see anything private; **lists files to find a path rather than guessing**,
  and never fabricates code when a lookup fails.
- **Idea capture** — "it should work differently" becomes a consent-gated
  Workshop idea ("want me to pass that along?"), never a promise to build it.
- **Kid-safe failures** — a rate-limited / unavailable tool returns a warm line,
  never an error dump.

The three files in [`examples/`](./examples) each carry a short "what to notice"
note over the raw run.

## Known limitation observed in the runs

GitHub's `/search/code` REST endpoint **requires a sign-in**, so an
unauthenticated `search_rabbithole_code` returns 401 → the friendly
"pivot to a file" message. **Discovery is handled by `list_rabbithole_files`
instead** — GitHub's public git-trees API works unauthenticated (~60 req/hr),
so the model lists the real paths under a folder prefix and then opens what it
finds, rather than blind-guessing. `read_rabbithole_file` (fully public via
`raw.githubusercontent.com`) does the actual reading. Unauthenticated +
public-only is a deliberate architecture decision (nothing to leak into a kid
surface); `search_rabbithole_code` is kept as a best-effort bonus for if/when a
credential-free search path exists.

## Native surface (verified)

`/meta-stream` **does** have a native (Expo RN) surface:
[`native/src/hooks/useReflectionChat.ts`](../../native/src/hooks/useReflectionChat.ts)
streams it. Its SSE reader consumes **only `ev.text`** and silently ignores
every other event type (`toolStart`, `toolComplete`, `thinking`, …). So turning
the flag on is **native-safe with no native code change**: while the tour tools
run, the kid simply sees a pause, then the streamed reply — the tool-progress
events the web UI could render are harmlessly dropped. (A nicer native
"looking through the code…" affordance is possible later but is not required to
ship the experiment.)
