# Closure-line eval — anti-parasocial gate

The growth-framed **closure line** that leads the practice done-screen and the
daily "Look what you did today" recap is LLM-generated under the same governed
pattern as the observer → `masteryObservations`: a model writes the line from an
**already-redacted signal**, we store it (`closureLines` table), it's
teacher-inspectable, and the UI renders it deterministically with an instant
fallback. Design: [`review/practice/completion-messaging-plan.html`](../../review/practice/completion-messaging-plan.html).

Because "the model wrote it" must never smuggle in the chrome the design forbids
(trait/caliber praise, a simulated "I", scores/streaks, learner-vs-learner
comparison), every generated line passes a deterministic **anti-parasocial
guard** — [`shared/closureGuard.ts`](../../shared/closureGuard.ts) — before it's
ever stored. A rejected line is dropped and the deterministic builder
([`shared/closureLines.ts`](../../shared/closureLines.ts)) renders instead.

## Two layers

1. **CI gate (deterministic, always runs):**
   [`shared/closureGuard.test.ts`](../../shared/closureGuard.test.ts) asserts the
   guard rejects parasocial / numeric / comparison / first-person lines and
   passes on-brand growth lines. This is the contract that runs in production.
   ```
   npx vitest run shared/closureGuard.test.ts shared/closureLines.test.ts
   ```

2. **Live-generation spot-check (this harness, needs a key):** feeds the REAL
   production prompt (`convex/lib/closureLinePrompt.ts`) a spread of redacted
   signal fixtures, samples each a few times, and runs every generated line
   through the same guard — catching a prompt regression that starts leaking
   off-contract lines.
   ```
   ANTHROPIC_API_KEY=... npx tsx evals/closure-line/run.ts [--samples N]
   ```
   Reports a pass rate and prints any dropped line. Exits non-zero if the prompt
   has regressed badly enough that <80% of lines pass the guard.

## When to re-run

- After any change to `CLOSURE_SYSTEM` / `buildClosureUserMessage`
  (`convex/lib/closureLinePrompt.ts`) — bump `CLOSURE_PROMPT_VERSION`.
- After any change to the guard rules (`shared/closureGuard.ts`).
