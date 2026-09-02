/**
 * The two arms of the baked-vs-ad-lib comparison, plus the conversation driver.
 *
 * Both arms run the SAME synthetic scholar working toward the SAME topic-level
 * learning goal — the only thing that differs is the TUTOR's system prompt:
 *
 *   - ad-lib arm  → the production tutor prompt with `seedOriginContext` set and
 *                   NO activity (exactly what a topic-seed launch produces today).
 *   - baked arm   → the production tutor prompt driven by the real baked
 *                   activity's systemPrompt + deliverable.
 *
 * Both prompts come from the production `buildSystemPrompt`, so we're comparing
 * real scholar experiences, not fictions. The simulator + judge are reused
 * wholesale from evals/curriculum-sim.
 */
import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "../../../convex/sessionHelpers";
import { MODELS } from "../../../convex/lib/models";
import { assembleTutorPrompt } from "../../curriculum-sim/lib/runTutor";
import { generateScholarTurn } from "../../curriculum-sim/lib/scholarSimulator";
import { sanitizeToolText } from "../../curriculum-sim/lib/toolText";
import type {
  ScholarProfile,
  SessionResult,
  SimActivity,
  SimTurn,
} from "../../curriculum-sim/lib/types";

const anthropic = new Anthropic();
export const tutorModel = process.env.TUTOR_MODEL || MODELS.SONNET;
export const armTutorTokens = { input: 0, output: 0 };

export type Topic = {
  /** Short id for the report. */
  id: string;
  topic: string;
  domain?: string;
  rationale?: string;
  connectionTo?: string;
  /** The target understanding — SAME for both arms (the fairness anchor). */
  learningGoal: string;
  readingLevel?: string;
};

export type BakedDesign = {
  title: string;
  description: string | null;
  systemPrompt: string | null;
  bigIdea: string | null;
  essentialQuestions: string[];
  enduringUnderstandings: string[];
  lessons: {
    title: string;
    systemPrompt: string | null;
    durationMinutes: number | null;
    activities: {
      title: string;
      description: string | null;
      kind: "online" | "offline" | "shareBack" | "web" | "problem_set";
      systemPrompt: string | null;
      durationMinutes: number | null;
      deliverable: {
        kind: "photo" | "artifact" | "slides" | "text" | "audio" | "map";
        mode: "manual" | "auto" | "none";
        prompt: string;
        notes: string | null;
        criteria: { label: string; description: string | null }[];
      } | null;
    }[];
  }[];
};

/** Baked activity and full unit design returned by `internal.bakeEval.bakeTopicForEval`. */
export type BakedActivity = {
  title: string;
  systemPrompt: string | null;
  deliverablePrompt: string | null;
  durationMinutes?: number | null;
  design: BakedDesign;
};

/** The activity object the simulator + judge see for each arm. */
export function adLibActivity(topic: Topic): SimActivity {
  return {
    title: topic.topic,
    kind: "online",
    systemPrompt: null,
    learningGoal: topic.learningGoal,
    deliverablePrompt: null,
    unitDesign: "(none — ad-lib arm)",
  };
}

export function bakedSimActivity(topic: Topic, baked: BakedActivity): SimActivity {
  return {
    title: baked.title,
    kind: "online",
    systemPrompt: baked.systemPrompt,
    learningGoal: topic.learningGoal, // same anchor as the ad-lib arm
    deliverablePrompt: baked.deliverablePrompt,
    durationMinutes: baked.durationMinutes ?? null,
    unitDesign: JSON.stringify(baked.design, null, 2),
  };
}

/**
 * The ad-lib tutor system prompt: production `buildSystemPrompt` with
 * `seedOriginContext` set (positional arg 29) and no activity — the exact prompt
 * a topic-seed launch assembles today.
 */
export function assembleAdLibPrompt(
  profile: ScholarProfile,
  topic: Topic,
  isFirstTurn: boolean,
): string {
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
    null, // 17 lessonActivityContext
    null, // 18 priorActivityContext
    null, // 19 activityContext
    null, // 20 standaloneDeliverableContext
    null, // 21 currentVerdictsContext
    isFirstTurn, // 22 isFirstTurn
    true, // 23 isFirstSession
    null, // 24 lastSessionAt
    null, // 25 webPracticeContext
    null, // 26 granuleStatusContext
    null, // 27 activityRecipe
    null, // 28 baselineEvidenceContext
    {
      // 29 seedOriginContext — anchorless, ad-lib (the current behavior)
      topic: topic.topic,
      domain: topic.domain ?? null,
      rationale: topic.rationale ?? null,
      approachHint: null,
      connectionTo: topic.connectionTo ?? null,
      hasStructure: false,
    },
  );
}

/** tutor→assistant, scholar→user; coalesce + trim to a valid message array. */
function toMessages(turns: SimTurn[]) {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const t of turns) {
    const role = t.role === "scholar" ? "user" : "assistant";
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content += `\n\n${t.content}`;
    else messages.push({ role, content: t.content });
  }
  while (messages.length && messages[0].role === "assistant") messages.shift();
  while (messages.length && messages[messages.length - 1].role === "assistant") {
    messages.pop();
  }
  return messages;
}

async function tutorTurnWithSystem(
  system: string,
  turns: SimTurn[],
  offline: boolean,
  profile: ScholarProfile,
  activity: SimActivity,
): Promise<string> {
  if (offline) {
    if (turns.length === 0) {
      return `Hi ${profile.name}! I'm a computer helper, not a real person. Let's dig into ${activity.title.toLowerCase()}. What do you already wonder about it?`;
    }
    const lastScholar = [...turns].reverse().find((t) => t.role === "scholar");
    return `Good thinking. Instead of me telling you — what would you try next? (re: "${lastScholar?.content.slice(0, 40) ?? ""}")`;
  }
  const messages = toMessages(turns);
  if (messages.length === 0) messages.push({ role: "user", content: "(start)" });
  const res = await anthropic.messages.create({
    model: tutorModel,
    max_tokens: 1024,
    system,
    messages,
  });
  const usage = res.usage as unknown as Record<string, number | undefined>;
  armTutorTokens.input += usage.input_tokens ?? 0;
  armTutorTokens.output += usage.output_tokens ?? 0;
  const raw = res.content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
  // The harness binds no tools, so the tutor sometimes emits a tool call as
  // text — normalize it to a neutral artifact marker so it doesn't pollute the
  // next turn or read as broken output to the judge (esp. the baked arm, whose
  // activities lean on visuals). See curriculum-sim/lib/toolText.ts.
  return sanitizeToolText(raw);
}

/**
 * Run one arm's session: the tutor opens, then the synthetic scholar + tutor
 * alternate until the kid signals goal/stuck or the turn cap hits. `buildSystem`
 * yields the tutor's system prompt for the arm (it gets isFirstTurn).
 */
export async function runArmSession(
  profile: ScholarProfile,
  activity: SimActivity,
  buildSystem: (isFirstTurn: boolean) => string,
  opts: { maxTurns?: number; offline?: boolean } = {},
): Promise<SessionResult> {
  const maxTurns = opts.maxTurns ?? 10;
  const offline = opts.offline ?? false;
  const turns: SimTurn[] = [];

  turns.push({
    role: "tutor",
    content: await tutorTurnWithSystem(buildSystem(true), [], offline, profile, activity),
  });

  for (let i = 0; i < maxTurns; i++) {
    const reply = await generateScholarTurn(profile, activity, turns, offline);
    turns.push({ role: "scholar", content: reply.text });
    if (reply.stop) return { profile, turns, stopReason: reply.stop };
    turns.push({
      role: "tutor",
      content: await tutorTurnWithSystem(buildSystem(false), turns, offline, profile, activity),
    });
  }
  return { profile, turns, stopReason: "maxTurns" };
}

/** Ad-lib arm: anchorless seed-origin prompt. */
export function runAdLibArm(
  profile: ScholarProfile,
  topic: Topic,
  opts: { maxTurns?: number; offline?: boolean },
): Promise<SessionResult> {
  return runArmSession(
    profile,
    adLibActivity(topic),
    (first) => assembleAdLibPrompt(profile, topic, first),
    opts,
  );
}

/** Baked arm: the real baked activity drives the tutor. */
export function runBakedArm(
  profile: ScholarProfile,
  topic: Topic,
  baked: BakedActivity,
  opts: { maxTurns?: number; offline?: boolean },
): Promise<SessionResult> {
  const activity = bakedSimActivity(topic, baked);
  return runArmSession(
    profile,
    activity,
    (first) => assembleTutorPrompt(profile, activity, first, true),
    opts,
  );
}
