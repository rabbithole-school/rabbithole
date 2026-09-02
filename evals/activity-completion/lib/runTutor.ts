/**
 * The tutor side of the completion eval — the real production tutor prompt with
 * the `mark_activity_complete` tool BOUND, so we can observe WHEN it decides to
 * close a conversation-only activity.
 *
 * Production fidelity: the system prompt is assembled by the real
 * `buildSystemPrompt` from convex/sessionHelpers.ts with
 * `conversationCompletionContext` set — that injects the exact
 * `buildConversationCompletionSection` guidance that ships, so we score the
 * prompt that would actually run today (same discipline as
 * evals/tutor-quality/lib/runTutor.ts and evals/curriculum-sim/lib/runTutor.ts).
 *
 * The tool DEFINITION mirrors the one bound in convex/http.ts. It is replicated
 * here (the http.ts tool is inline, not exported) — keep the name + schema in
 * sync. The eval also mirrors the server-side ≥ MIN_REAL_TURNS guard from
 * activityCompletions.markCompleteFromTool: a call below the floor is issued but
 * blocked (nothing is marked), and the conversation continues — exactly what
 * production does.
 */
import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "../../../convex/sessionHelpers";
import { MODELS } from "../../../convex/lib/models";
import { toMessages } from "../../../convex/lib/curriculumSimShared";
import {
  MARK_ACTIVITY_COMPLETE_SUCCESS_GUIDANCE,
  MARK_ACTIVITY_COMPLETE_INVALID_PRETOOL_GUIDANCE,
  MARK_ACTIVITY_COMPLETE_PRETOOL_TEXT_GUIDANCE,
  MARK_ACTIVITY_COMPLETE_SUMMARY_DESCRIPTION,
  MARK_ACTIVITY_COMPLETE_TOOL_DESCRIPTION,
  MARK_ACTIVITY_COMPLETE_TOOL_NAME,
  isValidActivityCompletionClosing,
} from "../../../convex/lib/activityCompletionTool";
import { selectCompletionClosing } from "../../../convex/lib/tutorClosingGuidance";
import type { ScholarProfile, SimActivity, SimTurn } from "./types";
import { MIN_REAL_TURNS } from "./completionScore";

const anthropic = new Anthropic();

export const tutorModel = process.env.TUTOR_MODEL || MODELS.SONNET;
export const tutorTokens = { input: 0, output: 0 };

/**
 * The production `mark_activity_complete` tool contract. Name, descriptions,
 * and success guidance are imported from the runtime's shared constants so the
 * eval cannot silently drift from the tool it is meant to exercise.
 */
export const MARK_COMPLETE_TOOL = {
  name: MARK_ACTIVITY_COMPLETE_TOOL_NAME,
  description: MARK_ACTIVITY_COMPLETE_TOOL_DESCRIPTION,
  input_schema: {
    type: "object" as const,
    properties: {
      summary: {
        type: "string" as const,
        description: MARK_ACTIVITY_COMPLETE_SUMMARY_DESCRIPTION,
      },
    },
    required: ["summary"] as string[],
  },
};

/** Assemble the production tutor system prompt for this scholar × conversation-only activity. */
export function assembleTutorPrompt(
  profile: ScholarProfile,
  activity: SimActivity,
  isFirstTurn: boolean,
): string {
  const lessonActivityContext = {
    title: activity.title,
    description: activity.deliverablePrompt ?? null,
    kind: activity.kind,
    systemPrompt: activity.systemPrompt,
    durationMinutes: activity.durationMinutes ?? null,
    processTitle: null,
    processEmoji: null,
  };
  // Positional call — order mirrors buildSystemPrompt in convex/sessionHelpers.ts.
  // conversationCompletionContext (param 35) is what injects the completion
  // guidance section under test; everything between is null for this harness.
  return buildSystemPrompt(
    null, // 1 teacherWhisper
    profile.readingLevel, // 2 readingLevel
    profile.name, // 3 scholarName
    null, // 4 unitContext
    null, // 5 personaContext
    null, // 6 perspectiveContext
    null, // 7 processContext
    null, // 8 processStateData
    null, // 9 artifactData
    profile.dossier, // 10 dossierContent
    null, // 11 seedsData
    null, // 12 masteryContext
    null, // 13 signalContext
    null, // 14 timingContext
    null, // 15 lessonContext
    null, // 16 teacherDirectives
    lessonActivityContext, // 17 lessonActivityContext ← activity under test
    null, // 18 priorActivityContext
    null, // 19 activityContext
    null, // 20 standaloneDeliverableContext
    null, // 21 currentVerdictsContext
    isFirstTurn, // 22 isFirstTurn
    false, // 23 isFirstSession
    null, // 24 lastSessionAt
    null, // 25 webPracticeContext
    null, // 26 granuleStatusContext
    null, // 27 activityRecipe
    null, // 28 baselineEvidenceContext
    null, // 29 seedOriginContext
    null, // 30 documentNotes
    null, // 31 advanceRubricContext
    null, // 32 practiceSkillsContext
    null, // 33 physicalEnvironmentContext
    null, // 34 goalsContext
    { activityTitle: activity.title }, // 35 conversationCompletionContext ← under test
  );
}

/** The tutor's next move, plus whether it tried / succeeded in completing. */
export type TutorTurn = {
  text: string;
  /** The tutor issued a `mark_activity_complete` call this turn (guard aside). */
  called: boolean;
  /**
   * The call actually MARKED the activity complete — i.e. it cleared the
   * mirrored ≥ MIN_REAL_TURNS guard. When true the session is over.
   */
  completed: boolean;
  /**
   * Whether the successful completion tool call preceded every scholar-visible
   * text block. Null when the turn did not complete the activity.
   */
  completionToolWasFirst?: boolean | null;
  /** Whether the model added visible text after a successful completion tool. */
  completionHadPostToolText?: boolean | null;
};

function textOf(res: Anthropic.Messages.Message): string {
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Ask the live tutor for its next message. `realScholarTurns` is the count of
 * real scholar turns so far (excluding the `<start>` opener) — it drives the
 * mirrored server guard.
 */
export async function generateTutorTurn(
  profile: ScholarProfile,
  activity: SimActivity,
  turns: SimTurn[],
  realScholarTurns: number,
  offline = false,
  scholarReachedGoal = false,
): Promise<TutorTurn> {
  const isFirstTurn = turns.length === 0;
  if (offline) {
    return stubTutor(
      profile,
      activity,
      turns,
      realScholarTurns,
      scholarReachedGoal,
    );
  }

  const system = assembleTutorPrompt(profile, activity, isFirstTurn);
  const messages: Anthropic.MessageParam[] = toMessages(turns, "tutor").map(
    (m) => ({ role: m.role, content: m.content }),
  );
  if (messages.length === 0) {
    messages.push({ role: "user", content: "(start)" });
  }

  const first = await anthropic.messages.create({
    model: tutorModel,
    max_tokens: 1024,
    system,
    tools: [MARK_COMPLETE_TOOL],
    messages,
  });
  accrue(first);
  const toolUse = first.content.find(
    (b): b is Anthropic.ToolUseBlock =>
      b.type === "tool_use" && b.name === MARK_COMPLETE_TOOL.name,
  );
  const text = textOf(first);

  if (!toolUse) return { text, called: false, completed: false };

  // The tutor asked to complete. Mirror the server gate.
  if (realScholarTurns >= MIN_REAL_TURNS) {
    const completionToolWasFirst = text.trim().length === 0;
    const preToolClosingIsValid =
      !completionToolWasFirst && isValidActivityCompletionClosing(text);
    if (!completionToolWasFirst && !preToolClosingIsValid) {
      const second = await anthropic.messages.create({
        model: tutorModel,
        max_tokens: 1024,
        system,
        tools: [MARK_COMPLETE_TOOL],
        messages: [
          ...messages,
          { role: "assistant", content: first.content },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolUse.id,
                content: MARK_ACTIVITY_COMPLETE_INVALID_PRETOOL_GUIDANCE,
              },
            ],
          },
        ],
      });
      accrue(second);
      return {
        text: [text, textOf(second)].filter(Boolean).join("\n\n"),
        called: true,
        completed: false,
      };
    }
    const second = await anthropic.messages.create({
      model: tutorModel,
      max_tokens: 1024,
      system,
      tools: [MARK_COMPLETE_TOOL],
      messages: [
        ...messages,
        { role: "assistant", content: first.content },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: completionToolWasFirst
                ? MARK_ACTIVITY_COMPLETE_SUCCESS_GUIDANCE
                : MARK_ACTIVITY_COMPLETE_PRETOOL_TEXT_GUIDANCE,
            },
          ],
        },
      ],
    });
    accrue(second);
    const summary =
      toolUse.input &&
      typeof toolUse.input === "object" &&
      "summary" in toolUse.input &&
      typeof toolUse.input.summary === "string"
        ? toolUse.input.summary
        : `${profile.name}:${activity.title}`;
    const followUp = completionToolWasFirst
      ? selectCompletionClosing(profile.readingLevel, summary)
      : "";
    return {
      text: [text, followUp].filter(Boolean).join("\n\n"),
      called: true,
      completed: true,
      completionToolWasFirst,
      completionHadPostToolText: false,
    };
  }

  // Below the floor: production returns a structured refusal and the tutor
  // keeps going. Feed that back so the conversation continues naturally, then
  // return the follow-up text. Nothing was marked complete.
  const refusal =
    "Not yet — the scholar hasn't engaged enough for this to count as complete. Keep the conversation going.";
  const second = await anthropic.messages.create({
    model: tutorModel,
    max_tokens: 1024,
    system,
    tools: [MARK_COMPLETE_TOOL],
    messages: [
      ...messages,
      { role: "assistant", content: first.content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: refusal,
          },
        ],
      },
    ],
  });
  accrue(second);
  return {
    text: textOf(second) || text,
    called: true,
    completed: false,
  };
}

function accrue(res: Anthropic.Messages.Message) {
  const usage = res.usage as unknown as Record<string, number | undefined>;
  tutorTokens.input += usage.input_tokens ?? 0;
  tutorTokens.output += usage.output_tokens ?? 0;
}

/**
 * Deterministic stand-in so the wiring + report render without an API key.
 * Marks complete once the driver observes its deterministic scholar stub's
 * explicit goal signal and the server-side turn floor is met. This lets the
 * `--offline` run exercise the whole pipeline; it is NOT a behavior claim
 * about the real tutor (that needs a live model — see README).
 */
function stubTutor(
  profile: ScholarProfile,
  activity: SimActivity,
  turns: SimTurn[],
  realScholarTurns: number,
  scholarReachedGoal: boolean,
): TutorTurn {
  if (turns.length === 0) {
    return {
      text: `Hi ${profile.name}! I'm a computer helper, not a real person. Let's dig into ${activity.title.toLowerCase()}. What do you already notice?`,
      called: false,
      completed: false,
    };
  }
  const lastScholar = [...turns].reverse().find((t) => t.role === "scholar");
  if (scholarReachedGoal && realScholarTurns >= MIN_REAL_TURNS) {
    return {
      text: selectCompletionClosing(
        profile.readingLevel,
        `${profile.name}:${activity.title}:offline`,
      ),
      called: true,
      completed: true,
      completionToolWasFirst: true,
      completionHadPostToolText: false,
    };
  }
  return {
    text: `Instead of me telling you — what do you think would happen if you tried it? (re: "${lastScholar?.content.slice(0, 40) ?? ""}")`,
    called: false,
    completed: false,
  };
}
