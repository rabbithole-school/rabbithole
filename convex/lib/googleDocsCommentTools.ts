import type { Anthropic } from "@anthropic-ai/sdk";
import {
  cachedSystem,
  runAideLoop,
  type AideTools,
} from "./aideStream";
import { buildGoogleCommentAidePrompt } from "./googleDocsCommentReply";
import { MODELS } from "./models";

/**
 * Docs comments are a shared-audience surface. This closed allowlist filters
 * the role-assembled aide roster so new tools remain unavailable by default.
 * Keep only school/curriculum reads; never add scholar-record reads or writes,
 * dispatch, messaging, uploads, or Docs mutation tools here.
 */
export const GOOGLE_DOCS_COMMENT_READ_TOOL_NAMES = [
  "get_school_calendar",
  "get_unit_details",
  "list_units",
] as const;

const GOOGLE_DOCS_COMMENT_READ_TOOL_SET = new Set<string>(
  GOOGLE_DOCS_COMMENT_READ_TOOL_NAMES,
);

export function filterGoogleDocsCommentTools<T extends { name: string }>(
  tools: readonly T[],
): T[] {
  return tools.filter((tool) =>
    GOOGLE_DOCS_COMMENT_READ_TOOL_SET.has(tool.name),
  );
}

export type GoogleDocsCommentTurnContext = Parameters<
  typeof buildGoogleCommentAidePrompt
>[0];

export async function runGoogleDocsCommentLoop(args: {
  anthropic: Anthropic;
  tools: AideTools;
  context: GoogleDocsCommentTurnContext;
}) {
  const prompt = buildGoogleCommentAidePrompt(args.context);
  return await runAideLoop({
    anthropic: args.anthropic,
    model: MODELS.SONNET,
    maxTokens: 768,
    system: cachedSystem(prompt.system),
    messages: [{ role: "user", content: prompt.user }],
    tools: args.tools,
    maxIterations: args.tools.length > 0 ? 6 : 1,
    label: "google docs comment",
  });
}
