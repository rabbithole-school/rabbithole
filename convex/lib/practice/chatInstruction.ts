import type { InstructionPlatform } from "../../instruction";

export const CHAT_INSTRUCTION_NO_CONTENT_GUIDANCE =
  "No authored segment covers that named gap on this platform. Teach it yourself in the current spirit, without mentioning the missing segment.";

export const CHAT_INSTRUCTION_ALREADY_COMPLETED_GUIDANCE =
  "the scholar already completed this segment — coach the specific stuck point in conversation instead; do not re-offer the card.";

export const INSTRUCTION_COMPLETION_ACTION_PREFIX =
  "instruction_completed:";

export function instructionCompletionAction(messageId: string): string {
  return `${INSTRUCTION_COMPLETION_ACTION_PREFIX}${messageId}`;
}

export function isInstructionCompletionAction(
  toolAction: string | undefined,
): boolean {
  return toolAction?.startsWith(INSTRUCTION_COMPLETION_ACTION_PREFIX) ?? false;
}

export function chatInstructionSuccessGuidance(title: string): string {
  return `The authored segment "${title}" is now in the chat. Add at most one short line inviting the scholar to work through it, then stop. Do NOT re-teach or summarize the segment. After the completion handback arrives on a later turn, return the scholar to their original problem.`;
}

export function chatInstructionFailureGuidance(message: string): string {
  return `Couldn't offer the authored segment (${message}). Teach the named gap yourself in the current spirit, without mentioning the tool failure.`;
}

export function instructionCompletionHandback(title: string): string {
  return `[System handback — not scholar speech] The scholar completed the authored segment "${title}". Return them to their original problem now. Do NOT re-teach or summarize the segment.`;
}

export function instructionServedMarker(title: string): string {
  return `[System record — not scholar speech] The scholar was offered the authored instruction segment: ${title}.`;
}

export function instructionCompletedMarker(title: string): string {
  return `[System record — not scholar speech] The scholar completed the authored instruction segment: ${title}.`;
}

export type InstructionAnchorSearchEntry = {
  domain: string;
  strand: string;
  title: string;
  subtitle?: string;
};

const GAP_SEARCH_STOPWORDS = new Set([
  "a",
  "about",
  "an",
  "and",
  "been",
  "do",
  "does",
  "have",
  "how",
  "i",
  "in",
  "is",
  "it",
  "learn",
  "learned",
  "learning",
  "me",
  "mean",
  "my",
  "not",
  "of",
  "on",
  "or",
  "really",
  "the",
  "this",
  "to",
  "taught",
  "what",
  "yet",
]);

function gapTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      if (token.endsWith("ies") && token.length > 4) {
        return `${token.slice(0, -3)}y`;
      }
      if (token.endsWith("s") && token.length > 4) {
        return token.slice(0, -1);
      }
      return token;
    })
    .filter((token) => !GAP_SEARCH_STOPWORDS.has(token));
}

/**
 * Match a named gap against authored anchor metadata, never scholar mastery.
 * Rare shared terms carry more weight than generic math words. A score below
 * the calibrated floor or within the ambiguity margin returns null.
 */
export function resolveInstructionAnchor(
  query: string,
  anchors: readonly InstructionAnchorSearchEntry[],
): InstructionAnchorSearchEntry | null {
  const queryTokenList = gapTokens(query);
  const queryTokens = new Set(queryTokenList);
  if (queryTokens.size === 0 || anchors.length === 0) return null;

  const searchable = anchors.map((anchor) => {
    const tokens = new Set(
      gapTokens(
        `${anchor.strand.replaceAll("-", " ")} ${anchor.title} ${anchor.subtitle ?? ""}`,
      ),
    );
    return { anchor, tokens };
  });
  const documentFrequency = new Map<string, number>();
  for (const { tokens } of searchable) {
    for (const token of tokens) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  const ranked = searchable
    .map(({ anchor, tokens }) => {
      let score = 0;
      const strandTokens = new Set(
        gapTokens(anchor.strand.replaceAll("-", " ")),
      );
      for (const token of queryTokens) {
        if (!tokens.has(token)) continue;
        const frequency = documentFrequency.get(token) ?? anchors.length;
        score += frequency === 1 ? 3 : frequency <= 3 ? 2 : 1;
        if (frequency === 1 && strandTokens.has(token)) score += 2;
      }
      const strandPhrase = [...strandTokens].join(" ");
      const queryPhrase = queryTokenList.join(" ");
      if (strandPhrase && queryPhrase.includes(strandPhrase)) score += 4;
      const anchorTokenList = gapTokens(
        `${anchor.title} ${anchor.subtitle ?? ""}`,
      );
      const hasAuthoredBigram = anchorTokenList.some((token, index) => {
        const next = anchorTokenList[index + 1];
        return next ? queryPhrase.includes(`${token} ${next}`) : false;
      });
      if (hasAuthoredBigram) score += 3;
      return { anchor, score };
    })
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  const runnerUp = ranked[1];
  if (!best || best.score < 4) return null;
  if (runnerUp && best.score - runnerUp.score < 2) return null;
  return best.anchor;
}

export const OFFER_INSTRUCTION_TOOL = {
  name: "offer_instruction",
  description:
    "Serve ONE authored math instructional segment inline. NAMED-GAP ONLY: use this tool only when the scholar explicitly named a gap in their own words, such as “I haven't learned decimals” or “nobody taught me coordinates.” Never infer a missing prerequisite, never offer because the scholar is merely wrong or stuck, and never turn this into lecture-then-test. ASK FIRST in a separate turn, describe it honestly as a quick show-and-do on the named idea, and wait for the scholar to explicitly accept before calling this tool. Never promise a fixed duration or a hardcoded number of minutes because the authored segment's atoms determine its actual shape. Pass the named math idea in plain words. If no authored segment matches, the tool returns fallback guidance. After serving, stop teaching while the scholar uses the card; after completion, return to the original problem and do not re-teach the segment.",
  inputSchema: {
    type: "object" as const,
    properties: {
      skill: {
        type: "string" as const,
        description:
          "The explicitly named math gap, in the scholar's own plain words. Do not pass an inferred prerequisite.",
      },
    },
    required: ["skill"] as const,
  },
};

export function buildChatInstructionSection(): string {
  return [
    `\nAUTHORED INSTRUCTION IN CHAT (an agency-preserving handoff, not an automatic lesson):`,
    `You have an offer_instruction tool that can place an authored math show-and-do directly in the chat.`,
    ``,
    `WHEN to offer it:`,
    `  - NAMED-GAP ONLY. The scholar must explicitly say they have not learned or been taught a specific math idea. Their own words must name the gap.`,
    `  - Never infer a missing prerequisite from a wrong answer, hesitation, or your own diagnosis.`,
    `  - If the named gap BLOCKS the current activity's work, you may ask first and serve the accepted segment mid-activity.`,
    `  - If the named gap is adjacent but does NOT block the current activity, acknowledge it and defer it. “We can come back to that after this activity” is fine; do not interrupt the current work with a card.`,
    ``,
    `ASK FIRST:`,
    `  - Offer the segment in ordinary sentence case, then wait for the scholar's explicit yes before calling the tool on a later turn.`,
    `  - Keep the offer honest: “Want a quick show-and-do on decimals?” is good. Never promise “two minutes” or any fixed duration; you do not know the authored segment's exact atom count before it is served.`,
    ``,
    `AFTER acceptance and serving:`,
    `  - Let the card teach. Do not paraphrase, summarize, or add a second explanation around it.`,
    `  - If the tool reports no authored segment, teach the named gap yourself in the current spirit and do not mention the tool failure.`,
    `  - When the completion handback arrives, return to the scholar's original problem. Do NOT re-teach the segment; the scholar should apply the idea.`,
  ].join("\n");
}

export type ChatInstructionPlatform = InstructionPlatform;
