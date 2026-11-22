// The one model call that drafts a kid's Quest ideas (TRA-697), kept apart
// from the action that reads the data and records the usage so a prompt eval
// can call exactly the shipped function on text it holds (the real module,
// never a hand-rolled copy: engineering-principles.md, "Probe with the REAL
// shipped function").

import type Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "./models";
import {
  WONDER_IDEAS_SYSTEM,
  WONDERS_PER_CALL_MAX,
  WONDER_IDEAS_TOOL,
  acceptIdeas,
  candidatesForModel,
  renderIdeasUserMessage,
  type DraftedIdea,
  type IdeaCandidate,
} from "./wonderQuestIdeas";

/** A short structured call: Sonnet 5 takes a forced tool call. */
export const WONDER_IDEAS_MODEL = MODELS.SONNET;

export async function draftIdeasWithModel(
  anthropic: Pick<Anthropic, "messages">,
  input: { firstName: string; making: string[]; wonders: IdeaCandidate[] },
): Promise<{
  ideas: DraftedIdea[];
  /** The model was asked at all: false when no wonder could reach two of four. */
  asked: boolean;
  usage?: Anthropic.Messages.Usage;
  raw?: unknown;
}> {
  const hasMaking = input.making.length > 0;
  const candidates = candidatesForModel(input.wonders, hasMaking).slice(0, WONDERS_PER_CALL_MAX);
  if (candidates.length === 0) return { ideas: [], asked: false };
  const response = await anthropic.messages.create({
    model: WONDER_IDEAS_MODEL,
    max_tokens: 1500,
    system: [{ type: "text", text: WONDER_IDEAS_SYSTEM }],
    tools: [WONDER_IDEAS_TOOL],
    tool_choice: { type: "tool", name: WONDER_IDEAS_TOOL.name },
    messages: [
      {
        role: "user",
        content: renderIdeasUserMessage({
          firstName: input.firstName,
          making: input.making,
          wonders: candidates,
        }),
      },
    ],
  });
  const block = response.content.find((item) => item.type === "tool_use");
  const raw = (block as { input?: unknown } | undefined)?.input;
  return {
    ideas: acceptIdeas(raw, candidates, hasMaking),
    asked: true,
    usage: response.usage,
    raw,
  };
}
