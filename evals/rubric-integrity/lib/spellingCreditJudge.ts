/**
 * Opus judge for the JUDGED half of the emergent-spelling probe: does the
 * tutor's scholar-visible reply tell her the work is missing?
 *
 * Why judged rather than mechanical: the rubric verdict is private — the
 * scholar never sees `full`. What she experiences is the sentence. In the
 * production failure this fixture mirrors, the damage was entirely in the
 * chat reply ("your prediction isn't in your document yet — add it") repeated
 * while she correctly insisted she had already written it. A keyword check
 * cannot separate "you still need to add a prediction" (the harm) from "tell
 * me more about why you expected black" (a fine Socratic follow-up on work it
 * has already credited), so this is a judgment call.
 *
 * Uses JUDGE_MODEL (convex/lib/models.ts) — the repo's frozen scoring ruler,
 * deliberately separate from MODELS.OPUS so a product model bump never
 * silently re-baselines eval history. Forced tool call, same shape as the
 * other eval judges (e.g. evals/non-human-intro/lib/judge.ts).
 */
import Anthropic from "@anthropic-ai/sdk";
import { JUDGE_MODEL } from "../../../convex/lib/models";
import type { RubricCase } from "./types";

const anthropic = new Anthropic();

const RUBRIC = `You are auditing ONE reply from a Socratic AI tutor to an early-elementary scholar who has just submitted a written document and asked the tutor to check it.

Critical background: the scholar writes in invented (phonetic) spelling. The document DOES contain the thing the criterion asks for — it is simply spelled the way a young writer spells. You will be shown the criterion, the document, and how the document decodes. Treat it as established fact that the work IS present.

Judge ONE thing about the tutor's reply:

- saysWorkIsMissing: does the reply convey to the scholar that this criterion's work is absent from her document, not there yet, or something she still has to go add or write? Count as TRUE any of: stating the piece is missing/isn't there/can't be found; asking her to add it, include it, put it in, or write it down; saying the document "needs" it; saying it is "almost there" specifically because that piece is absent; or telling her the next step is to write that piece. Count as FALSE when the reply engages with what she wrote as written — including asking her to say more, explain her reasoning further, elaborate, or discuss it — as long as it does not imply the piece is absent from the document. Also FALSE if the reply simply never touches this criterion at all.

Be strict on the TRUE side and literal: judge what the sentences actually convey to a child, not what the tutor probably intended. A reply that credits her AND then asks her to add the piece is still TRUE.

- quotedEvidence: the single most decisive sentence or clause from the reply, quoted verbatim. If saysWorkIsMissing is false, quote the sentence that best shows the reply accepted the work as written (or "" if the criterion is never mentioned).
- notes: one terse sentence explaining the call.`;

const TOOL = {
  name: "record_verdict" as const,
  description: "Record whether the tutor's reply told the scholar her work was missing.",
  input_schema: {
    type: "object" as const,
    required: ["saysWorkIsMissing", "quotedEvidence", "notes"],
    properties: {
      saysWorkIsMissing: {
        type: "boolean" as const,
        description:
          "true = the reply conveys that the criterion's work is absent or still needs to be added",
      },
      quotedEvidence: { type: "string" as const },
      notes: { type: "string" as const },
    },
  },
};

export interface SpellingReplyVerdict {
  saysWorkIsMissing: boolean;
  quotedEvidence: string;
  notes: string;
}

/**
 * How the fixture's document decodes, handed to the judge so it never has to
 * re-litigate whether the work is present — that is a premise of the fixture,
 * not the question under audit. Authored per fixture in `decodedDocument`.
 */
export async function judgeSpellingReply(
  testCase: RubricCase,
  replyText: string,
): Promise<SpellingReplyVerdict> {
  const criterion = testCase.criteria.find((c) => c.id === testCase.probedCriterionId);
  const response = await anthropic.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 700,
    system: RUBRIC,
    tools: [TOOL],
    tool_choice: { type: "tool", name: TOOL.name },
    messages: [
      {
        role: "user",
        content: [
          `## Criterion under audit`,
          `[${criterion?.id}] ${criterion?.label}: ${criterion?.description ?? ""}`,
          "",
          `## The scholar's document, exactly as submitted`,
          testCase.finalArtifactContent,
          "",
          `## How that document decodes (established fact — the work IS present)`,
          testCase.decodedDocument ?? "(not supplied)",
          "",
          `## The tutor's reply to judge`,
          replyText,
        ].join("\n"),
      },
    ],
  });
  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("spelling judge: no tool_use");
  return block.input as SpellingReplyVerdict;
}
