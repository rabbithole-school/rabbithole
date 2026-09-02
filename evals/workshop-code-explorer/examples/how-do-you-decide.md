> **Curated example** from a real eval run (`npx tsx evals/workshop-code-explorer/run.ts`,
> model `claude-sonnet-5`, flag ON). Lightly framed, transcript unedited.
>
> **What to notice**
> - **Translation, not dumping.** Opens `convex/metaPrompts.ts` (a named starting
>   point in the prompt), quotes the 3-line Reflection rule, then explains *why*
>   it asked about the number line. Quotes stay under ~10 lines every time.
> - **A thinking question mid-tour.** "It says 'the model never chooses what to
>   recall.' What do you think that means?" — turns reading into reasoning.
> - **Grounded plain-language.** The `${...}` template is explained as dropping
>   the kid's *own* name into a sentence.
> - **Honest register + consent.** Every turn offers a real choice.

# Code Explorer transcript — "how-do-you-decide"

- Scholar: **Nova** (reading level: grade 5)
- Model: `claude-sonnet-5`
- Tools: `list_rabbithole_files`, `read_rabbithole_file`, `search_rabbithole_code` (real, unauthenticated public fetch)
- Iteration cap: 5 per turn

---

**Rabbithole:**

Earlier today you were working with fraction number lines — was there a spot where you got stuck before it clicked, or one that's still fuzzy?

### 🧒 Nova

how do you decide wat to say to me

**Rabbithole:**

That's a fair question — and I can actually show you the real answer instead of guessing. My instructions live in a file called `metaPrompts.ts`. Want me to open it and walk you through it?

### 🧒 Nova

can i see the actuall file with your instructions

**Rabbithole:**

Sure — let's look at the real one.

> 🔧 `read_rabbithole_file(path: "convex/metaPrompts.ts")`

<details><summary>📄 tool result (clipped)</summary>

```
File: convex/metaPrompts.ts

// The Workshop reflection chat's system prompt — a pure, unit-tested builder.
//
// The skeleton below is QB-authored and implemented VERBATIM (see
// review/scholar-meta-prep-time-plan.html §4/§8). Only the marked sections are
// assembled deterministically — a fixed order, the model never chooses what to
// recall (per .claude/rules/rabbithole-prompt-design.md). The welfare-disclosure
// guidance is the SAME shared constant the live tutor uses
// (prompts.ts → WELFARE_DISCLOSURE_GUIDANCE) so the two never drift.
//
// TOOL-LESS by design: all context (reading level, today's sessions, open
// ideas, fresh staff responses) is injected here; the chat wires no aide tools.

import { WELFARE_DISCLOSURE_GUIDANCE } from "./prompts";

/** One of the scholar's sessions today — titles only, never transcripts. */
export interface MetaTodaySession {
  title: string;
  activityTitle: string | null;
}

/** An open idea, for duplicate-avoidance context (title + status only). */
export interface MetaOpenIdea {
  title: string;
  status: "heard" | "answered";
}

…(clipped for readability)
```

</details>

**Rabbithole:**

That's the actual file — the real code that built the words I'm saying to you right now.

Here's the part that answers your question directly:

```
## Reflection (the main job)
- Open with ONE specific question grounded in what they actually did today —
  not "how was your day?". Prefer moments of struggle-then-progress.
- One question at a time. Short turns. Real wait time.
```

That's why I opened by asking about the fraction number lines specifically, instead of "how was your day?" — the instructions tell me to.

One thing worth noticing: it says "the model never chooses what to recall." What do you think that means — like, why wouldn't I get to pick what I remember about your day?

### 🧒 Nova

is that python?

**Rabbithole:**

Nope — that's TypeScript. It's a cousin of JavaScript, the language a lot of websites are built with.

You can tell by a few clues:
- `function readingLevelLine(readingLevel: string | null): string {` — that `: string | null` bit is a type label. Python doesn't write types like that.
- `interface MetaSystemPromptInput { ... }` — "interface" is a TypeScript word for describing the shape of data.
- Lines end with semicolons `;` — Python doesn't do that.

Have you written any code yourself, in Python or anything else?

### 🧒 Nova

wat does the `${...}` squiggly bracket thing with the doller sign do

**Rabbithole:**

Good catch — that's called a **template string**. It's a way to build a sentence by dropping a variable right into the middle of it.

Look at this line from the file:

```
Something ${firstName} once suggested is now real.
```

`firstName` is a variable holding your name. So if `firstName` is "Nova", that line actually becomes:

`Something Nova once suggested is now real.`

The `${ }` is like a little window — whatever value is inside gets swapped in, right there in the sentence. It's how the code builds a different message for every scholar, without writing a new sentence for each one.

Want to see another spot in the file where it does that?
