// The Workshop's idea conversations — the SCHOLAR-facing tool that lets the
// reflection chat (/meta-stream) carry an idea to the people who build
// Rabbithole. See IDEA_CONVOS_SPEC.md.
//
// This is the meta chat's first WRITE tool. Andy's intent: rather than a dumb
// suggestion box, the scholar discusses ideas freely with Rabbithole and gets
// thoughtful feedback, so the idea that reaches the teacher (via
// `send_idea_to_teacher`) is higher quality — but the bot is a THINKING PARTNER,
// never a quality gate.
//
// QB guardrails (design law), enforced by construction here:
//   - The kid can ALWAYS send their idea — original and unrefined — the moment
//     they want. The tool NEVER refuses and never requires a refinement: the
//     model just calls it. `refined` is OPTIONAL and only rides along when a
//     conversation reshaped the idea and the scholar agreed to it.
//   - The kid's OWN words are mandatory (`scholarWords`, verbatim-ish); the
//     backing mutation records both scholarWords and refined so staff see both.
//   - At the open-ideas cap the tool returns a friendly "help them prioritize"
//     result (mirroring the composer's cap message) instead of erroring — the
//     conversation continues, nothing is a hard wall.
//
// Gating: the WHOLE feature is behind the WORKSHOP_IDEA_CONVOS_ENABLED
// deployment env var (absent = OFF). `isIdeaConvosEnabled()` gates BOTH the
// tool wiring + prompt section in http.ts AND the meta-observer's suggestion-
// distillation arm (metaChat.ts → applyMetaAnalysis), so when the tool owns
// capture there's no double-capture, and the two never drift. Default off
// everywhere — this ships dark.
//
// NEVER register this on a staff aide surface (assembleCurriculumTools) — it is
// scholar-facing and used ONLY by /meta-stream. Staff file/answer ideas through
// their own teacher-gated tools (lib/suggestionTools.ts).
//
// The tool takes an injected `capture` callback (not a Convex ctx) so the eval
// harness can build the SAME tool — real schema, real result-message logic —
// with the DB write stubbed to echo, mirroring how scholarCodeTools splits its
// pure helpers out for the eval.

import type { AideEmit } from "./aideStream";

// ─── Flag ────────────────────────────────────────────────────────────────
/**
 * The idea-conversations kill-switch. Absent/garbage → OFF (ships dark).
 * Accepts the same truthy spellings as the Code Explorer flag so a deployment
 * can flip it with `npx convex env set WORKSHOP_IDEA_CONVOS_ENABLED true`.
 */
export function isIdeaConvosEnabled(): boolean {
  const raw = (process.env.WORKSHOP_IDEA_CONVOS_ENABLED ?? "")
    .trim()
    .toLowerCase();
  return raw === "true" || raw === "on" || raw === "1";
}

/**
 * Cost-sanity cap on the /meta-stream tool loop when idea conversations are on.
 * `send_idea_to_teacher` is a single write call in practice, so a small cap is
 * plenty; it also composes with the Code Explorer's cap (the caller takes the
 * max) when both flags are on. Only applied when the flag is on.
 */
export const IDEA_CONVOS_MAX_ITERATIONS = 5;

/**
 * The /meta-stream loop knobs, derived from the flag. Pure so a test can prove
 * the OFF path is a behavioral no-op — no tool wired and no iteration cap, i.e.
 * exactly today's tool-less behavior. ON → wire the idea tool + the cost cap.
 * Mirrors codeExplorerLoopConfig; the caller merges the two.
 */
export function ideaConvosLoopConfig(enabled: boolean): {
  withTools: boolean;
  maxIterations: number | undefined;
} {
  return enabled
    ? { withTools: true, maxIterations: IDEA_CONVOS_MAX_ITERATIONS }
    : { withTools: false, maxIterations: undefined };
}

// ─── Capture seam (real mutation in prod; echo stub in the eval) ───────────
/** The model-supplied args the tool passes through to capture. */
export interface CaptureIdeaArgs {
  title: string;
  scholarWords: string;
  refined?: string;
}

/**
 * Discriminated result of a capture attempt — mirrors
 * scholarSuggestions.CaptureFromChatResult so the prod wiring can return the
 * mutation result verbatim, and the eval can synthesize the same shape.
 */
export type CaptureIdeaResult =
  | { status: "captured"; title: string }
  | { status: "at_cap"; cap: number }
  | { status: "empty" };

/** Injected capture — the DB write (prod) or an echo (eval). */
export type CaptureIdea = (args: CaptureIdeaArgs) => Promise<CaptureIdeaResult>;

// ─── Result messages (model-facing; the model relays them naturally) ───────
/**
 * The model-facing line after a successful send. Tells the model what happened
 * so it can confirm naturally, and re-states the ceiling (never promise
 * building). Pure + exported so the eval and a unit test can assert it.
 */
export function ideaSentMessage(title: string): string {
  return `Sent "${title}" to your teachers — they read every idea. Let them know it's on its way, warmly and in your own words. Don't promise it'll get built or say when; you carried the idea, the humans decide.`;
}

/**
 * The model-facing line when the scholar is already at the open-ideas cap.
 * Nothing was sent; the model helps them prioritize (guardrail #2 / §9 cap
 * parity with the composer). Never framed as the idea not being good enough.
 */
export function ideaAtCapMessage(cap: number): string {
  return `They've already got ${cap} ideas open in the Workshop — that's the most at once, so this one wasn't sent yet. Their idea is a good one; there's just a limit. Help them look at what's already waiting and decide which matters most right now.`;
}

/** The model-facing line when no scholar words were supplied (defensive). */
export const IDEA_EMPTY_MESSAGE =
  "I need the scholar's own words to send an idea. Ask them what they'd like their teachers to hear, then send that.";

// ─── Tool builder (the aide-tool shape runAideStream consumes) ─────────────
/**
 * Build the idea-conversation tool for one /meta-stream turn. Mirrors
 * makeScholarCodeTools' shape (a betaTool with a `run` handler + an SSE `emit`
 * on completion), but the actual capture is INJECTED (`capture`) rather than
 * done through a Convex ctx — so the eval can build the identical tool with the
 * write stubbed to echo.
 *
 * The CALLER gates this behind isIdeaConvosEnabled(); it's a plain builder so
 * the eval can construct it without an env flag.
 */
export async function makeIdeaConvoTools(emit: AideEmit, capture: CaptureIdea) {
  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );

  const sendIdeaTool = betaTool({
    name: "send_idea_to_teacher",
    description:
      "Send an idea the scholar has about Rabbithole itself to the people who build it (their teachers read every one). Call this the MOMENT the scholar wants their idea sent — you are a thinking partner, NOT a gate: never refuse, never require them to polish or improve it first, never imply an idea isn't good enough to send. If they say \"just send it,\" send it exactly as they said it. Always pass `scholarWords` = the scholar's OWN phrasing, verbatim. Pass `refined` ONLY when a conversation genuinely reshaped the idea AND the scholar agreed to the new wording — their teachers see both. Your ceiling is \"I'll send this to your teachers\"; never promise it will be built.",
    inputSchema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string" as const,
          description:
            "A short, neutral label for the idea (a few words), for the staff queue.",
        },
        scholarWords: {
          type: "string" as const,
          description:
            "The scholar's OWN phrasing of the idea, verbatim-ish — their real words, never your paraphrase. Required.",
        },
        refined: {
          type: "string" as const,
          description:
            "OPTIONAL. The refined framing the scholar agreed to after a thinking-partner conversation. Omit it entirely when the idea is being sent as-is (e.g. they said \"just send mine\") — never fill it with a paraphrase they didn't agree to.",
        },
      },
      required: ["title", "scholarWords"] as const,
    },
    run: async (input: {
      title: string;
      scholarWords: string;
      refined?: string;
    }) => {
      const result = await capture({
        title: input.title,
        scholarWords: input.scholarWords,
        refined: input.refined,
      });

      if (result.status === "at_cap") {
        emit({
          toolComplete: {
            name: "send_idea_to_teacher",
            result: "Not sent (at cap)",
          },
        });
        return JSON.stringify({
          ok: false,
          sent: false,
          message: ideaAtCapMessage(result.cap),
        });
      }
      if (result.status === "empty") {
        emit({
          toolComplete: {
            name: "send_idea_to_teacher",
            result: "Not sent (no words)",
          },
        });
        return JSON.stringify({
          ok: false,
          sent: false,
          message: IDEA_EMPTY_MESSAGE,
        });
      }

      emit({
        toolComplete: {
          name: "send_idea_to_teacher",
          result: `Sent: ${result.title}`,
        },
      });
      return JSON.stringify({
        ok: true,
        sent: true,
        message: ideaSentMessage(result.title),
      });
    },
  });

  return [sendIdeaTool];
}
