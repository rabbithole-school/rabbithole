"use node";

/**
 * Studio's generous fixer, stage 2 — the Haiku model fallback.
 *
 * Stage 1 (`shared/studioFix.ts`, owned by another agent) runs inside the
 * WebView with zero latency and handles the common slips deterministically.
 * This action is invoked ONLY when stage 1 gives up and the program still
 * doesn't parse. See `shared/studioContract.ts` for the full contract
 * (`StudioFix`, `StudioFixResult`, `STUDIO_VOCABULARY`) this backs.
 *
 * The prompt-building, tool schema, and response-verification below are
 * exported as plain functions/constants so tests can exercise them directly
 * with no network call and no Convex test harness — the same split the repo
 * uses elsewhere for a "use node" action file (e.g.
 * `convex/activityResourceActions.ts`'s `ACTIVITY_RESOURCE_STORED_TEXT_CHARS`
 * is imported straight into its test). Calling `action(...)` at module scope
 * is harmless to import outside Convex; it just builds a descriptor.
 */

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { MODELS } from "./lib/models";
import { requireAnthropicApiKey } from "./lib/anthropic";
import { recordAnthropicUsage } from "./usage";
import { ROLES } from "./lib/roles";
import { STUDIO_VOCABULARY, type StudioFix, type StudioFixResult } from "../shared/studioContract";

const VOCAB_LIST = STUDIO_VOCABULARY.join(", ");

/**
 * The whole product decision lives in this string: repair syntax, and ONLY
 * syntax. A fixer that also straightens out a wrong loop bound or a flipped
 * comparison steals the lesson and makes the machine look arbitrary to a kid
 * who was actually doing fine.
 */
export const STUDIO_FIXER_SYSTEM_PROMPT =
  "You are the LAST-RESORT syntax fixer for a coding editor built for gifted " +
  "grade 4-8 scholars who are brand new to typed JavaScript. They are writing " +
  "tiny programs that drive a grid robot or a drawing pen. A fast, rule-based " +
  "fixer already ran and could not make sense of the program below — you are " +
  "the model fallback, so keep it quick and don't overthink it.\n\n" +
  "SCOPE — you may repair SYNTAX ONLY: wrong capitalization (Forward() -> " +
  "forward()), a missing or mismatched paren/bracket/brace, smart/curly " +
  'quotes ("red" with curly marks -> "red" with straight ones), a missing ' +
  "`let` before a variable's first use, and leftover words from another " +
  "language the scholar may have seen before (Python/Scratch-ish `end`, " +
  "`elif`, `AND`, `OR` -> JavaScript's `}`, `else if`, `&&`, `||`). The only " +
  "real commands this robot understands are: " +
  VOCAB_LIST +
  ". If a word is close to one of these, correct it toward the real command; " +
  "never invent a command that isn't in that list.\n\n" +
  "NEVER SCOPE — you must NOT change the scholar's ALGORITHM: never touch a " +
  "loop bound, a number, a comparison operator, which branch an `if`/`while` " +
  "takes, or the order of calls, and never invent a command or add a step the " +
  "scholar didn't write. A wrong algorithm is the scholar's lesson to learn — " +
  "fixing it for them steals it and makes the machine look arbitrary. If you " +
  "cannot repair the syntax without guessing what the scholar meant to do, " +
  "return the ORIGINAL program completely unchanged with an empty fixes list " +
  "— do not guess.\n\n" +
  "Every fix you make needs a one-sentence `note` a nine-year-old can read: " +
  'plain and kind, never jargon, never scolding. Say "JavaScript is fussy ' +
  'about capital letters", never "unexpected token".\n\n' +
  "Respond ONLY by calling the tool.";

/** Truncated so a huge parser error message can't blow up the prompt. */
const MAX_ERROR_MESSAGE_LENGTH = 500;

export function buildStudioFixerUserMessage(args: {
  source: string;
  error: string;
  line?: number;
}): string {
  const lineNote = args.line ? ` (near line ${args.line})` : "";
  const error = args.error.slice(0, MAX_ERROR_MESSAGE_LENGTH);
  return (
    `This program fails to parse${lineNote}. The parser's complaint: ${error}\n\n` +
    "PROGRAM:\n```js\n" +
    args.source +
    "\n```"
  );
}

export const STUDIO_FIX_TOOL = {
  name: "emit_studio_fix" as const,
  description:
    "Return the repaired program and, for each change, a plain-language note a young scholar can read.",
  input_schema: {
    type: "object" as const,
    properties: {
      source: {
        type: "string" as const,
        description:
          "The FULL repaired program. Equal to the input when no safe syntax fix exists.",
      },
      fixes: {
        type: "array" as const,
        description:
          "Every syntax repair made, in order. Empty when the program could not be safely repaired without guessing the scholar's algorithm.",
        items: {
          type: "object" as const,
          properties: {
            line: {
              type: "integer" as const,
              description: "1-based line number in the ORIGINAL program.",
            },
            was: {
              type: "string" as const,
              description: 'The exact original text that was wrong, e.g. "Forward()".',
            },
            now: {
              type: "string" as const,
              description: 'What it was changed to, e.g. "forward()".',
            },
            note: {
              type: "string" as const,
              description:
                "One short, kind sentence a nine-year-old can read. No jargon, no scolding.",
            },
          },
          required: ["line", "was", "now", "note"],
        },
      },
    },
    required: ["source", "fixes"],
  },
};

/** Beginner syntax slips come in ones and twos; this is a generous cap against
 *  a model that starts inventing a long list of "fixes". */
const MAX_FIXES = 20;

/** Kid-facing note length cap — long enough for a real sentence, short enough
 *  that it can never smuggle in an essay. */
const MAX_NOTE_LENGTH = 200;

/** Reject anything absurdly large before it ever reaches the model — a huge
 *  paste isn't a syntax slip, and it isn't worth a Haiku call either. */
const MAX_FIXER_SOURCE_LENGTH = 20_000;

function isValidFix(raw: unknown): raw is StudioFix {
  if (typeof raw !== "object" || raw === null) return false;
  const f = raw as Record<string, unknown>;
  return (
    typeof f.line === "number" &&
    Number.isInteger(f.line) &&
    f.line >= 1 &&
    typeof f.was === "string" &&
    f.was.trim().length > 0 &&
    typeof f.now === "string" &&
    typeof f.note === "string" &&
    f.note.trim().length > 0 &&
    f.note.length <= MAX_NOTE_LENGTH
  );
}

/**
 * A repaired program must still be syntactically valid JS — never hand back a
 * mangled one. `new Function` PARSES the body without ever calling it, which
 * is exactly the check we want: catch a syntax error, run nothing.
 */
export function sourceParses(source: string): boolean {
  try {
    new Function(source);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate + verify the model's raw tool input against the ORIGINAL source.
 * Trust nothing here: this is scholar input that went to a model and is about
 * to land back in an editor. Any malformed shape, any silent (unnoted) change,
 * or any repair that still doesn't parse degrades to
 * `{ source: original, fixes: [], ok: false }` — it must never throw and must
 * never hand back a mangled program.
 */
export function verifyStudioFixOutput(
  originalSource: string,
  raw: unknown,
): StudioFixResult {
  const fallback: StudioFixResult = { source: originalSource, fixes: [], ok: false };
  if (typeof raw !== "object" || raw === null) return fallback;

  const { source, fixes } = raw as { source?: unknown; fixes?: unknown };
  if (typeof source !== "string") return fallback;
  if (!Array.isArray(fixes) || fixes.length > MAX_FIXES) return fallback;
  if (!fixes.every(isValidFix)) return fallback;
  // A change with nothing disclosed is exactly the silent-rewrite failure
  // mode the fixer exists to avoid — reject rather than trust it.
  if (fixes.length === 0 && source !== originalSource) return fallback;
  if (!sourceParses(source)) return fallback;

  return { source, fixes: fixes as StudioFix[], ok: true };
}

/**
 * The stage-2 fixer. Never throws to the caller — any failure (auth aside)
 * degrades to `{ source: <original>, fixes: [], ok: false }` so a scholar
 * always gets SOMETHING back rather than a broken Run button.
 */
export const fix = action({
  args: {
    source: v.string(),
    error: v.string(),
    line: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<StudioFixResult> => {
    const fallback: StudioFixResult = { source: args.source, fixes: [], ok: false };

    const scholarId = await getAuthUserId(ctx);
    if (!scholarId) throw new Error("Not authenticated");

    if (args.source.length > MAX_FIXER_SOURCE_LENGTH) return fallback;

    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const anthropic = new Anthropic({ apiKey: requireAnthropicApiKey() });
      const response = await anthropic.messages.create(
        {
          model: MODELS.HAIKU,
          max_tokens: 1024,
          system: STUDIO_FIXER_SYSTEM_PROMPT,
          tools: [STUDIO_FIX_TOOL],
          tool_choice: { type: "tool", name: STUDIO_FIX_TOOL.name },
          messages: [
            {
              role: "user",
              content: buildStudioFixerUserMessage(args),
            },
          ],
        },
        { timeout: 10_000 },
      );

      const institutionId = await ctx.runQuery(internal.usage.resolveInstitution, {
        userId: scholarId,
        principal: "scholar",
      });
      await recordAnthropicUsage(ctx, {
        source: "studio-fixer",
        role: ROLES.SCHOLAR,
        model: MODELS.HAIKU,
        usage: response.usage,
        institutionId,
      });

      const block = response.content.find((part) => part.type === "tool_use");
      if (!block || block.type !== "tool_use") return fallback;
      return verifyStudioFixOutput(args.source, block.input);
    } catch (err) {
      console.error("[studioFixer] generation failed:", err);
      return fallback;
    }
  },
});
