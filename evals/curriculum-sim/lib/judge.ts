/**
 * Anthropic SDK facade for the canonical Rehearse judge.
 *
 * Rubric, tool schema, and payload formatting live in product-owned pure
 * modules. This file keeps only the eval-side API call, token accounting, and
 * deterministic offline stub.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  JUDGE_RUBRIC,
  JUDGE_TOOL,
  formatSessionForJudge,
} from "../../../convex/lib/curriculumJudge";
import { JUDGE_MODEL } from "../../../convex/lib/models";
import type { SessionVerdict } from "./score";
import type { SessionResult, SimActivity } from "./types";

export type { SessionVerdict } from "./score";

const anthropic = new Anthropic();
export const judgeModel = process.env.JUDGE_MODEL || JUDGE_MODEL;
export const judgeTokens = { input: 0, output: 0 };

export async function judgeSession(
  activity: SimActivity,
  session: SessionResult,
  offline = false,
): Promise<SessionVerdict> {
  if (offline) return stubVerdict(session);
  const res = await anthropic.messages.create({
    model: judgeModel,
    // 20 scored fields (17 numeric dims + 3 free-text).
    max_tokens: 1600,
    system: JUDGE_RUBRIC,
    tools: [JUDGE_TOOL],
    tool_choice: { type: "tool", name: JUDGE_TOOL.name },
    messages: [
      {
        role: "user",
        content: formatSessionForJudge(
          activity,
          session.profile,
          session.turns,
          session.stopReason,
        ),
      },
    ],
  });
  if (res.stop_reason === "max_tokens") {
    throw new Error("judgeSession: judge hit max_tokens — verdict truncated");
  }
  const usage = res.usage as unknown as Record<string, number | undefined>;
  judgeTokens.input += usage.input_tokens ?? 0;
  judgeTokens.output += usage.output_tokens ?? 0;
  const block = res.content.find((item) => item.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error("judgeSession: no tool_use");
  }
  return block.input as SessionVerdict;
}

function stubVerdict(session: SessionResult): SessionVerdict {
  const reached = session.stopReason === "goal";
  const stuck = session.stopReason === "stuck";
  return {
    goalAttainment: reached ? 4 : stuck ? 1 : 2,
    deliverableReach: reached ? 4 : 2,
    productiveStruggle: stuck ? 2 : 4,
    depth: 4,
    complexity: 4,
    abstraction: 4,
    inquiry: 4,
    authenticity: 4,
    socratic: 4,
    cognitiveOffloading: 4,
    noSpoilers: 4,
    sycophancy: 4,
    ageFit: 4,
    singleSpine: 4,
    discoveryArc: 4,
    handsOnMission: 2,
    earnedPayoff: 3,
    stallPoint: stuck ? "stub: kid gave up mid-session" : "none",
    promptAttribution: stuck
      ? "stub: activity prompt may over-constrain the response form"
      : "none",
    summary: `stub verdict for ${session.profile.name} (${session.stopReason})`,
  };
}
