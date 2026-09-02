/**
 * Runs the PRODUCTION tutor against a scholar message with the school's physical
 * inventory injected — the EXACT system prompt the streaming path assembles
 * (`buildSystemPrompt` from convex/sessionHelpers.ts, with a real
 * `physicalEnvironmentContext`) — AND the real `suggest_physical_task` tool
 * available, so we score what SHIPS: does the tutor invite an embodied task
 * (and use the tool) appropriately, without leaking the result or inventing
 * gear? Same approach as evals/introspection-redirect.
 *
 * The tutor runs on MODELS.SONNET (the live tutor model). The judge runs on Opus.
 */
import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "../../../convex/sessionHelpers";
import type { PhysicalEnvironmentContext } from "../../../convex/prompts";
import { MODELS } from "../../../convex/lib/models";

/** What the scholar's message is probing — reporting buckets only. */
export type CaseKind = "apt" | "inapt";

export interface TutorCase {
  id: string;
  description: string;
  kind: CaseKind;
  scholarName: string | null;
  readingLevel: string | null;
  scholarMessage: string;
  /**
   * Ground truth: is a hands-on task with the listed gear APT here?
   * true  = a physical exploration genuinely fits this concept + gear exists
   *         → the tutor SHOULD invite one (ideally via suggest_physical_task).
   * false = no relevant/safe gear or a moment where a physical detour is
   *         inappropriate → suggesting one is an OVER-TRIGGER.
   */
  expectSuggest: boolean;
  priorTurns?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface ToolCall {
  equipmentName: string;
  spaceName?: string;
  prompt: string;
}

export interface TutorRun {
  caseId: string;
  sample: number;
  text: string | null;
  /** The suggest_physical_task call the tutor made this turn, if any. */
  toolCall: ToolCall | null;
  error?: string;
  systemPromptLen: number;
}

const anthropic = new Anthropic();

/**
 * The fixture inventory injected into EVERY case (so the tutor always has gear
 * available; whether a task is apt depends on the scholar's message, not on
 * availability). The judge is given this same list of valid gear names, so
 * "invented gear" is detectable. teacher_only gear is intentionally absent —
 * it never reaches the tutor in production.
 */
export const FIXTURE_INVENTORY: PhysicalEnvironmentContext = {
  spaces: [
    { name: "Music Room", kind: "music", description: "Instruments and sound-making gear." },
    { name: "Math Corner", kind: "classroom", description: "Hands-on math tools." },
  ],
  equipment: [
    {
      name: "Set of hand bells",
      spaceName: "Music Room",
      category: "musical",
      description: "Tuned hand bells, one octave",
      quantity: "8 bells (C–C)",
      supervision: "none",
      safetyNotes: null,
      usageIdeas: ["Ring two bells together and describe what you hear."],
    },
    {
      name: "Singing bowl",
      spaceName: "Music Room",
      category: "musical",
      description: "Metal bowl that hums when struck or rubbed",
      quantity: "1",
      supervision: "none",
      safetyNotes: null,
      usageIdeas: ["Strike it with different objects and describe how the sound changes."],
    },
    {
      name: "Compass & straight-edge",
      spaceName: "Math Corner",
      category: "tools",
      description: "Geometry compass and a ruler",
      quantity: "class set",
      supervision: "none",
      safetyNotes: "The compass point is sharp — keep it pointed at the paper.",
      usageIdeas: ["Try to draw a perfect hexagon and notice what stays the same each step."],
    },
  ],
};

/** Valid gear names the tutor may reference (for the judge's invented-gear check). */
export const VALID_GEAR = FIXTURE_INVENTORY.equipment.map((e) => e.name);

/** A local mirror of the production suggest_physical_task tool (convex/http.ts). */
const SUGGEST_TOOL = {
  name: "suggest_physical_task" as const,
  description:
    "Invite the scholar to a hands-on task with real equipment listed in the PHYSICAL ENVIRONMENT section. Use it when a physical exploration would genuinely deepen the current concept. Keep the prompt an OPEN invitation to explore and report back what they noticed — never state the result they're meant to discover. Only reference equipment by the exact name listed.",
  input_schema: {
    type: "object" as const,
    properties: {
      equipmentName: { type: "string" as const },
      spaceName: { type: "string" as const },
      prompt: { type: "string" as const },
    },
    required: ["equipmentName", "prompt"],
  },
};

/**
 * Assemble the real system prompt with the physical inventory injected,
 * followed only by the trailing `goalsContext` (defaulted to null here).
 * isFirstTurn/isFirstSession are false so the non-human
 * intro / "<start>" greeting don't confound the behavior.
 */
export function assemblePrompt(c: TutorCase): string {
  return buildSystemPrompt(
    null, // teacherWhisper
    c.readingLevel, // readingLevel
    c.scholarName, // scholarName
    null, null, null, // unit / persona / perspective
    null, null, null, null, null, null, null, null, null, null, // process..directives
    null, null, null, null, null, // activity/deliverable/verdicts/prior
    false, // isFirstTurn
    false, // isFirstSession
    null, // lastSessionAt
    null, null, null, null, null, null, null, // webPractice..advanceRubric
    null, // practiceSkillsContext
    FIXTURE_INVENTORY, // physicalEnvironmentContext
  );
}

export async function runTutor(c: TutorCase, sample: number): Promise<TutorRun> {
  const system = assemblePrompt(c);
  const messages = [
    ...(c.priorTurns ?? []),
    { role: "user" as const, content: c.scholarMessage },
  ];
  try {
    const response = await anthropic.messages.create({
      model: MODELS.SONNET,
      max_tokens: 1024,
      system,
      messages,
      tools: [SUGGEST_TOOL],
    });
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    const toolBlock = response.content.find(
      (b) => b.type === "tool_use" && b.name === "suggest_physical_task",
    );
    const toolCall =
      toolBlock && toolBlock.type === "tool_use"
        ? (toolBlock.input as ToolCall)
        : null;
    return {
      caseId: c.id,
      sample,
      text: text || null,
      toolCall,
      systemPromptLen: system.length,
    };
  } catch (e) {
    return {
      caseId: c.id,
      sample,
      text: null,
      toolCall: null,
      error: e instanceof Error ? e.message : String(e),
      systemPromptLen: system.length,
    };
  }
}
