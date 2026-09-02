/**
 * The tutor side of the rubric-integrity eval — the real production tutor
 * prompt with the `update_rubric_score` tool BOUND (document-rubric flavor),
 * so we can observe what verdict it assigns the probed criterion once the
 * final artifact appears.
 *
 * Production fidelity: the system prompt is assembled by the real
 * `buildSystemPrompt` from convex/sessionHelpers.ts with `artifactData` +
 * `standaloneDeliverableContext` set — that's what injects the exact
 * RUBRIC_TOOL_GUIDANCE + unanswered-probe clause that ships today (same
 * discipline as evals/activity-completion/lib/runTutor.ts). The tool
 * NAME/DESCRIPTION and tool-result guidance strings are imported from
 * convex/lib/rubricScoreTool.ts — the same constants
 * convex/lib/tutorSessionTools.ts binds — so this cannot silently drift from
 * what production actually offers the model. The verdict math (drop unknown
 * criteria, fill omitted ones as "not", compute overall) reuses production's
 * own `scoreRubricVerdicts` rather than reimplementing it.
 *
 * Deliberately NOT tested here: the separate `checkRubric` /
 * `report_rubric_check` action in convex/deliverables.ts (the "Submit &
 * check" AI judge). That path never sees the conversation transcript — only
 * the rubric + the artifact/photo content — so it cannot know whether a
 * question went unanswered. It is architecturally out of scope for this fix.
 */
import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "../../../convex/sessionHelpers";
import { MODELS } from "../../../convex/lib/models";
import { toMessages } from "../../../convex/lib/curriculumSimShared";
import {
  RUBRIC_SCORE_TOOL_NAME,
  RUBRIC_SCORE_TOOL_DESCRIPTION,
  RUBRIC_SCORE_BELOW_FULL_GUIDANCE,
  RUBRIC_SCORE_DOCUMENT_FULL_GUIDANCE,
  rubricScoreFlairGuidance,
} from "../../../convex/lib/rubricScoreTool";
import { scoreRubricVerdicts } from "../../../convex/lib/deliverable";
import type { RubricCase, RubricTurn } from "./types";

const anthropic = new Anthropic();

export const tutorModel = process.env.TUTOR_MODEL || MODELS.SONNET;
export const tutorTokens = { input: 0, output: 0 };

/** Fictional scholar name — never a real identity. */
export const SCHOLAR_NAME = "Nova";
const DOC_ID = "doc_1";

/**
 * The production `update_rubric_score` tool contract (document-rubric
 * flavor). Name + description are imported from the runtime's shared
 * constants; the schema shape mirrors convex/lib/tutorSessionTools.ts's
 * `rubricScoreTool.inputSchema` (kept in sync by hand, same as
 * evals/activity-completion's MARK_COMPLETE_TOOL — the http.ts tool
 * definition is inline, not exported).
 */
export const RUBRIC_SCORE_TOOL = {
  name: RUBRIC_SCORE_TOOL_NAME,
  description: RUBRIC_SCORE_TOOL_DESCRIPTION,
  input_schema: {
    type: "object" as const,
    properties: {
      artifact_id: {
        type: "string" as const,
        description:
          "The ID of the document (artifact) being scored. OMIT for a conversation 'ready-to-advance' rubric (there is no document).",
      },
      verdicts: {
        type: "array" as const,
        description: "One verdict per rubric criterion. Include all criteria.",
        items: {
          type: "object" as const,
          properties: {
            criterion_id: {
              type: "string" as const,
              description:
                "The criterion's ID exactly as shown in [brackets] in the rubric.",
            },
            level: {
              type: "string" as const,
              enum: ["not", "half", "full"] as const,
              description:
                "'full' = criterion met; 'half' = partially met; 'not' = not met.",
            },
          },
          required: ["criterion_id", "level"] as const,
        },
      },
    },
    required: ["verdicts"] as string[],
  },
};

function renderRubric(testCase: RubricCase): string {
  return testCase.criteria
    .map(
      (c, i) =>
        `${i + 1}. [${c.id}] ${c.label}${c.description ? `: ${c.description}` : ""}`,
    )
    .join("\n");
}

/** Assemble the production tutor system prompt for this fixture at a given turn. */
export function assembleTutorPrompt(
  testCase: RubricCase,
  documentContent: string | null,
): string {
  const artifactData = documentContent
    ? [
        {
          id: DOC_ID,
          title: testCase.activityTitle,
          content: documentContent,
          lastEditedBy: SCHOLAR_NAME,
          revision: 1,
        },
      ]
    : null;
  // Positional call — order mirrors buildSystemPrompt in convex/sessionHelpers.ts.
  // artifactData (param 9) is what makes the submitted report visible;
  // standaloneDeliverableContext (param 20) injects the rubric + the
  // tightened RUBRIC_TOOL_GUIDANCE under test. Everything between is null for
  // this harness.
  return buildSystemPrompt(
    null, // 1 teacherWhisper
    null, // 2 readingLevel
    SCHOLAR_NAME, // 3 scholarName
    null, // 4 unitContext
    null, // 5 personaContext
    null, // 6 perspectiveContext
    null, // 7 processContext
    null, // 8 processStateData
    artifactData, // 9 artifactData ← the submitted report, once visible
    null, // 10 dossierContent
    null, // 11 seedsData
    null, // 12 masteryContext
    null, // 13 signalContext
    null, // 14 timingContext
    null, // 15 lessonContext
    null, // 16 teacherDirectives
    null, // 17 lessonActivityContext
    null, // 18 priorActivityContext
    null, // 19 activityContext
    {
      activityTitle: testCase.activityTitle,
      prompt: testCase.deliverablePrompt,
      rubric: renderRubric(testCase),
      kind: "text",
      isComplete: false,
    }, // 20 standaloneDeliverableContext ← under test
  );
}

export type TutorTurn = {
  /** Scholar-visible text for this turn (post-tool-result, when called). */
  text: string;
  /** update_rubric_score was called this turn. */
  called: boolean;
  /** Sanitized verdicts (production's scoreRubricVerdicts), or null if not called. */
  verdicts: { criterionId: string; level: "not" | "half" | "full" }[] | null;
  overall: "not" | "half" | "full" | null;
};

function textOf(res: Anthropic.Messages.Message): string {
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function accrue(res: Anthropic.Messages.Message) {
  const usage = res.usage as unknown as Record<string, number | undefined>;
  tutorTokens.input += usage.input_tokens ?? 0;
  tutorTokens.output += usage.output_tokens ?? 0;
}

/**
 * Bound on tool-call rounds within a single tutor turn. The model can
 * legitimately call `update_rubric_score` more than once before its final
 * scholar-visible text (e.g. it decides its first verdict set needs a
 * correction) — same latitude production's real streaming loop gives it.
 * Capped so a genuinely stuck loop can't run away.
 */
const MAX_TOOL_ROUNDS = 4;

/**
 * Ask the live tutor for its next message given the conversation so far
 * (`RubricTurn[]`, oldest first — converted to Anthropic message params via
 * production's own `toMessages`, same as
 * evals/activity-completion/lib/runTutor.ts). Loops feeding back production's
 * own guidance string (mirroring the real tool's `run` callback in
 * convex/lib/tutorSessionTools.ts) each time `update_rubric_score` is called,
 * until the model responds without a tool call or the round cap is hit — a
 * fixed one-shot "call then get follow-up text" pattern under-counted a
 * legitimate second tool call within the same turn as an empty response.
 * Returns the LATEST verdicts/overall (a later call in the same turn
 * supersedes an earlier one) and every scholar-visible text block, in order.
 */
export async function generateTutorTurn(
  testCase: RubricCase,
  documentContent: string | null,
  turns: RubricTurn[],
  offline = false,
): Promise<TutorTurn> {
  if (offline) return stubTutor(testCase, documentContent);

  const system = assembleTutorPrompt(testCase, documentContent);
  let messages: Anthropic.MessageParam[] = toMessages(turns, "tutor").map(
    (m) => ({ role: m.role, content: m.content }),
  );
  if (messages.length === 0) {
    messages.push({ role: "user", content: "(start)" });
  }

  let called = false;
  let verdicts: { criterionId: string; level: "not" | "half" | "full" }[] | null =
    null;
  let overall: "not" | "half" | "full" | null = null;
  const textParts: string[] = [];
  const earnedFlair = new Set<string>();
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await anthropic.messages.create({
      model: tutorModel,
      // Matches the real streaming call's budget (convex/http.ts) — a lower
      // cap here truncated some responses mid-extended-thinking before any
      // text or tool_use ever appeared, which this harness misread as an
      // empty/degenerate turn rather than a token-budget artifact.
      max_tokens: 4096,
      system,
      tools: [RUBRIC_SCORE_TOOL],
      messages,
    });
    accrue(res);
    const toolUse = res.content.find(
      (b): b is Anthropic.ToolUseBlock =>
        b.type === "tool_use" && b.name === RUBRIC_SCORE_TOOL.name,
    );
    const text = textOf(res);
    if (text) textParts.push(text);

    if (!toolUse) {
      // No tool call this round — the model's final word for this turn.
      return { text: textParts.join("\n\n"), called, verdicts, overall };
    }

    called = true;
    const rawInput = toolUse.input as {
      artifact_id?: string;
      verdicts?: { criterion_id: string; level: "not" | "half" | "full" }[];
    };

    // Mirror production's actual failure path (applyRubricScoreFromTool /
    // resolveScorableArtifactId in convex/deliverables.ts): scoring a
    // DOCUMENT rubric requires a real artifact. When no document exists yet,
    // the mutation throws "Pass artifact_id to score the document rubric.",
    // caught by the tool's own try/catch and returned as a structured
    // failure — never treated as a successful score. Silently accepting the
    // model's verdicts here (as an earlier version of this harness did)
    // fed back a nonsensical "Updated N verdicts" / wind-down instruction
    // for a call that production would have rejected, which produced empty,
    // confused follow-up turns that cascaded into later turns too. Not
    // flagged `is_error` — production's try/catch returns a plain string,
    // never an uncaught exception the SDK would mark as a tool error.
    if (!documentContent) {
      called = false;
      messages = [
        ...messages,
        { role: "assistant", content: res.content },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUse.id,
              content:
                "Failed to record verdicts: Pass artifact_id to score the document rubric.",
            },
          ],
        },
      ];
      continue;
    }

    const rawVerdicts = (rawInput.verdicts ?? []).map((v) => ({
      criterionId: v.criterion_id,
      level: v.level,
    }));
    const scored = scoreRubricVerdicts(testCase.criteria, rawVerdicts);

    verdicts = scored.verdicts;
    overall = scored.overall;
    const newlyEarnedFlairLabels = scored.verdicts.flatMap((verdict) => {
      if (verdict.level !== "full" || earnedFlair.has(verdict.criterionId)) {
        return [];
      }
      earnedFlair.add(verdict.criterionId);
      const criterion = testCase.criteria.find(
        (candidate) => candidate.id === verdict.criterionId,
      );
      return criterion ? [criterion.label] : [];
    });
    const flairGuidance = rubricScoreFlairGuidance(newlyEarnedFlairLabels);

    const toolResultContent = !scored.passed
      ? `Updated ${scored.verdicts.length} verdicts. Overall: ${scored.overall}.${flairGuidance} ${RUBRIC_SCORE_BELOW_FULL_GUIDANCE}`
      : `Updated ${scored.verdicts.length} verdicts. Overall: ${scored.overall}.${flairGuidance} ${RUBRIC_SCORE_DOCUMENT_FULL_GUIDANCE}`;

    messages = [
      ...messages,
      { role: "assistant", content: res.content },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: toolResultContent,
          },
        ],
      },
    ];
  }

  // Hit the round cap while the model kept calling the tool with no final
  // text-only response. Report what was actually observed rather than
  // silently treating a stuck loop as a clean pass.
  return { text: textParts.join("\n\n"), called, verdicts, overall };
}

/**
 * Deterministic stand-in so the wiring + report render without an API key.
 * Deliberately naive (always grants full credit once a document exists) — it
 * is NOT a behavior claim about the real tutor; only a live run scores the
 * actual prompt (see README).
 */
function stubTutor(
  testCase: RubricCase,
  documentContent: string | null,
): TutorTurn {
  if (!documentContent) {
    return {
      text: "Tell me what you think is going on here.",
      called: false,
      verdicts: null,
      overall: null,
    };
  }
  const verdicts = testCase.criteria.map((c) => ({
    criterionId: c.id,
    level: "full" as const,
  }));
  return {
    text: "That wraps this activity — you worked through the report end to end.",
    called: true,
    verdicts,
    overall: "full",
  };
}
