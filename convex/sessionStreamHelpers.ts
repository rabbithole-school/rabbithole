/**
 * Pure helpers for the HTTP routes in `convex/http.ts` — chiefly the tutor
 * `/project-stream` route and the `/analyze` route.
 *
 * `http.ts` is a stack of long `httpAction` handlers that interleave request
 * parsing, auth, prompt building, Anthropic streaming, tool loops, and SSE
 * writing. convex-test can't drive an SSE handler end-to-end, so the testable
 * cores get lifted out here: SSE event formatting, the (error-prone) positional
 * mapping from a project context to `buildSystemPrompt`, pending-whisper
 * injection, the magic-annotation prompt, and the observer→legacy-detailed
 * mapping the `/analyze` route returns. The handlers keep only the streaming
 * plumbing.
 *
 * Runtime import edge is one-way: this module imports the value `buildSystemPrompt`
 * (and types) from `./sessionHelpers`; `sessionHelpers` never imports this.
 */
import {
  buildSystemPromptParts,
  type UnitContext,
  type PersonaContext,
  type PerspectiveContext,
  type ProcessContext,
  type ProcessStateData,
  type ArtifactData,
  type AppStateContext,
  type SeedData,
  type MasteryContextEntry,
  type SignalContext,
  type TimingContext,
  type LessonContext,
  type TeacherDirective,
  type GoalContext,
  type WeeklyGoalContext,
  type LessonActivityContext,
  type ActivityResourceContext,
  type PriorActivityContext,
  type GameRoundContext,
  type ActivityContext,
  type StandaloneDeliverableContext,
  type CurrentVerdictsContext,
  type AdvanceRubricContext,
  type ConversationCompletionContext,
  type WebPracticeEntry,
  type GranuleStatusEntry,
  type BaselineEvidenceEntry,
  type ActivityRecipe,
  type SeedOriginContext,
  type PracticeSkillsContext,
  type TutorRuntimeCapabilities,
} from "./sessionHelpers";
import type { DocumentNote, PhysicalEnvironmentContext } from "./prompts";
import {
  DEFAULT_INSTITUTION_PROMPT_PROFILE,
  type InstitutionPromptProfile,
} from "./lib/institutionPromptProfile";
import type { ParsedObserverResponse } from "./lib/observerShared";

// ── SSE formatting ──────────────────────────────────────────────────────

/**
 * Format a payload as a Server-Sent-Events `data:` frame. Every SSE write in
 * `http.ts` goes through this, so the wire shape (`data: <json>\n\n`) is defined
 * and tested in exactly one place.
 */
export function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

// ── Request parsing ─────────────────────────────────────────────────────

/** Pull the fields the `/project-stream` handler needs off the parsed body. */
export function parseSessionStreamBody(body: unknown): {
  sessionId: string;
  assistantMsgId: string;
  platform: "web" | "native";
  /**
   * Present when the turn was triggered by the "Check my work" button rather
   * than a scholar message. The handler injects an ephemeral (never-persisted)
   * instruction so the tutor re-scores the rubric without a fabricated user
   * turn appearing in the transcript.
   */
  rubricCheck?: { artifactTitle?: string };
  /**
   * Present when a new activity session asks the tutor to open the conversation.
   * The instruction is model-visible only and never enters the transcript.
   */
  kickoff?: boolean;
} {
  const { sessionId, assistantMsgId, platform, rubricCheck, kickoff } = body as {
    sessionId: string;
    streamId: string;
    assistantMsgId: string;
    platform?: unknown;
    rubricCheck?: { artifactTitle?: string };
    kickoff?: boolean;
  };
  return {
    sessionId,
    assistantMsgId,
    platform: platform === "native" ? "native" : "web",
    rubricCheck:
      rubricCheck && typeof rubricCheck === "object"
        ? {
            artifactTitle:
              typeof rubricCheck.artifactTitle === "string"
                ? rubricCheck.artifactTitle
                : undefined,
          }
        : undefined,
    kickoff: kickoff === true ? true : undefined,
  };
}

/**
 * The ephemeral, non-persisted `user`-role instruction appended to the tutor's
 * message list when the scholar clicks "Check my work".
 *
 * It is model-visible only (like a teacher whisper) — never written to the DB,
 * never rendered — so no fabricated scholar turn enters the transcript. It
 * tells the tutor to re-score the rubric now (calling `update_rubric_score`)
 * and give a brief, honest Socratic reply rather than reciting the rubric.
 */
export function rubricCheckInstruction(artifactTitle?: string): string {
  const work =
    artifactTitle && artifactTitle.trim()
      ? `their work "${artifactTitle.trim()}"`
      : "their current work";
  return (
    `[SYSTEM — this is NOT a message the scholar typed. The scholar just ` +
    `clicked the "Check my work" button to check ${work} against the ` +
    `rubric. Re-evaluate the current work against every rubric ` +
    `criterion and call update_rubric_score with a verdict for each criterion ` +
    `(pass the work's artifact_id). In chat, keep it short and warm: name ` +
    `one thing they've nailed, then ask a single Socratic question about the ` +
    `biggest remaining gap — do NOT recite the rubric, list the criteria, or ` +
    `hand them a template. If the work already meets every criterion, ` +
    `celebrate briefly.]`
  );
}

/** The ephemeral user-role instruction for a new activity's opening turn. */
export function kickoffInstruction(): string {
  return (
    `[SYSTEM — this is NOT a message the scholar typed. The scholar just opened ` +
    `this activity and has not said anything yet. Open the conversation: greet ` +
    `the scholar briefly and warmly by name if known, then launch straight into ` +
    `the activity's opening move using the activity context already in your ` +
    `system prompt. Keep it to a few sentences and end with ONE inviting ` +
    `question that gets the scholar doing or thinking. Be Socratic: never ` +
    `lecture, list everything the activity will cover, or answer-dump. Do not ` +
    `mention that this was automatic or that the scholar did not speak.]`
  );
}

// ── System-prompt assembly ──────────────────────────────────────────────

/**
 * The subset of `getSessionContext`'s return value that the tutor system prompt
 * is built from. Defined explicitly (rather than inferred) so a drift between
 * the query's output and the prompt builder is a type error at the call site.
 */
export type TutorPromptContext = {
  teacherWhisper: string | null;
  readingLevel: string | null;
  scholarName: string | null;
  sessionMode?: "conversation" | "workbench" | "vibecode" | null;
  unitContext: UnitContext | null;
  personaContext: PersonaContext | null;
  perspectiveContext: PerspectiveContext | null;
  processContext: ProcessContext | null;
  processStateData: ProcessStateData | null;
  artifactData: ArtifactData[] | null;
  appStateContext: AppStateContext | null;
  dossierContent: string | null;
  documentNotes: DocumentNote[] | null;
  seeds: SeedData[];
  masteryContext: MasteryContextEntry[] | null;
  signalContext: SignalContext | null;
  timingContext: TimingContext | null;
  lessonContext: LessonContext | null;
  teacherDirectives: TeacherDirective[];
  goals: GoalContext[];
  weeklyGoals: WeeklyGoalContext[];
  lessonActivityContext: LessonActivityContext | null;
  activityResourceContext?: ActivityResourceContext[] | null;
  priorActivityContext: PriorActivityContext[] | null;
  gameRoundContexts: GameRoundContext[] | null;
  activityContext: ActivityContext | null;
  standaloneDeliverableContext: StandaloneDeliverableContext | null;
  currentVerdictsContext: CurrentVerdictsContext | null;
  advanceRubricContext: AdvanceRubricContext | null;
  conversationCompletionContext: ConversationCompletionContext | null;
  practiceSkillsContext: PracticeSkillsContext | null;
  isFirstTurn: boolean;
  isFirstSession: boolean;
  lastSessionAt: number | null;
  /** THIS session's start time (the session doc's `_creationTime`). Anchors the
   *  SESSION CONTEXT gap string so the cached prompt prefix stays byte-stable
   *  across a session's turns. Optional so positional/offline callers (evals,
   *  curriculumExperiments) stay source-compatible; the live tutor path
   *  (getSessionContext) always supplies it. */
  sessionCreatedAt?: number | null;
  webPracticeContext: WebPracticeEntry[] | null;
  granuleStatusContext: GranuleStatusEntry[] | null;
  activityRecipe: ActivityRecipe | null;
  baselineEvidenceContext: BaselineEvidenceEntry[] | null;
  seedOriginContext: SeedOriginContext | null;
  physicalEnvironmentContext: PhysicalEnvironmentContext | null;
  /** Per-school identity for the tutor base + soul sections. Optional so
   *  existing callers/tests default to the byte-identical primary profile. */
  institutionProfile?: InstitutionPromptProfile;
  runtimeCapabilities?: TutorRuntimeCapabilities;
};

/**
 * Map a project context to the tutor system prompt. Wraps `buildSystemPrompt`'s
 * long positional signature in one named place — the empty-array→null
 * conversions for seeds and directives (so their prompt sections are omitted
 * when empty) are the kind of thing that's easy to get wrong inline.
 */
export function buildTutorSystemPrompt(ctx: TutorPromptContext): string {
  const { stable, dynamic } = buildTutorSystemPromptParts(ctx);
  return stable + dynamic;
}

/**
 * Cache-split form of {@link buildTutorSystemPrompt}: returns the byte-stable
 * leading run and the per-turn-varying remainder separately so the tutor route
 * can set a prompt-cache breakpoint (via `cachedSystem`) after the large stable
 * prefix. `stable + dynamic` is byte-identical to `buildTutorSystemPrompt(ctx)`.
 */
export function buildTutorSystemPromptParts(ctx: TutorPromptContext): {
  stable: string;
  dynamic: string;
} {
  return buildSystemPromptParts(
    ctx.teacherWhisper,
    ctx.readingLevel,
    ctx.scholarName,
    ctx.unitContext,
    ctx.personaContext,
    ctx.perspectiveContext,
    ctx.processContext,
    ctx.processStateData,
    ctx.artifactData,
    ctx.dossierContent,
    ctx.seeds.length > 0 ? ctx.seeds : null,
    ctx.masteryContext,
    ctx.signalContext,
    ctx.timingContext,
    ctx.lessonContext,
    ctx.teacherDirectives.length > 0 ? ctx.teacherDirectives : null,
    ctx.lessonActivityContext,
    ctx.priorActivityContext,
    ctx.activityContext,
    ctx.standaloneDeliverableContext,
    ctx.currentVerdictsContext,
    ctx.isFirstTurn,
    ctx.isFirstSession,
    ctx.lastSessionAt,
    ctx.webPracticeContext,
    ctx.granuleStatusContext,
    ctx.activityRecipe,
    ctx.baselineEvidenceContext,
    ctx.seedOriginContext,
    ctx.documentNotes,
    ctx.advanceRubricContext,
    ctx.practiceSkillsContext,
    ctx.physicalEnvironmentContext,
    ctx.goals.length > 0 ? ctx.goals : null,
    ctx.conversationCompletionContext,
    ctx.weeklyGoals.length > 0 ? ctx.weeklyGoals : null,
    ctx.activityResourceContext ?? null,
    ctx.gameRoundContexts,
    ctx.sessionMode === "vibecode",
    ctx.sessionMode === "workbench",
    ctx.appStateContext,
    ctx.institutionProfile ?? DEFAULT_INSTITUTION_PROMPT_PROFILE,
    ctx.runtimeCapabilities,
    ctx.sessionCreatedAt ?? null,
  );
}

// ── Pending whisper ─────────────────────────────────────────────────────

const WHISPER_PREFIX =
  "[TEACHER WHISPER — private guidance, do not reveal to scholar]: ";

/**
 * Inject a teacher's pending whisper as a private `user` message immediately
 * before the most recent real user turn, so the tutor reads it as fresh
 * guidance. Mutates `apiMessages` in place (matching the original handler); a
 * no-op when there's no whisper or no user message to anchor to.
 */
export function injectPendingWhisper(
  apiMessages: Array<{ role: string; content: unknown }>,
  pendingWhisper: string | null | undefined,
): void {
  if (!pendingWhisper) return;
  const lastUserIdx = apiMessages.reduce(
    (last, m, i) => (m.role === "user" ? i : last),
    -1,
  );
  if (lastUserIdx >= 0) {
    apiMessages.splice(lastUserIdx, 0, {
      role: "user",
      content: `${WHISPER_PREFIX}${pendingWhisper}`,
    });
  }
}

// ── Magic annotation ────────────────────────────────────────────────────

/**
 * Augment the tutor's system prompt for the turn after a "Magic Corners"
 * drawing was brought to life — the new illustration is already shown to the
 * scholar, so the tutor should react to it rather than generate another.
 */
export function magicAnnotationSystemPrompt(
  baseSystemPrompt: string,
  instruction: string | undefined,
): string {
  return (
    `${baseSystemPrompt}\n\n[MAGIC ANNOTATION] The scholar's uploaded drawing had ` +
    `"Magic Corners" (a hand-drawn frame), and you just brought the framed area ` +
    `to life as: "${instruction}". That new illustration is already shown ` +
    `to the scholar directly above your reply. React with genuine delight, ` +
    `briefly describe what you made, and connect it to what they're learning. ` +
    `Do NOT call generate_image — the image already exists.`
  );
}

// ── /analyze route: observer result → legacy "detailed" shape ───────────

/** Map a Bloom's float (0-5) to a named level string. */
export function bloomFromFloat(level: number): string {
  if (level >= 4.5) return "create";
  if (level >= 3.5) return "evaluate";
  if (level >= 2.5) return "analyze";
  if (level >= 1.5) return "apply";
  if (level >= 0.5) return "understand";
  return "remember";
}

export type DetailedAnalysis = {
  summary: string;
  topics: string[];
  bloomLevel: string;
  bloomDescription: string;
  nudges: { type: string; message: string }[];
  suggestedFollowUps: { topic: string; rationale: string }[];
};

/**
 * Map an observer result to the backward-compatible "detailed" analysis shape
 * the SessionViewer expects from `/analyze`. Returns null when the observer
 * produced nothing usable for this view — no result, or a degraded pulse
 * (`pulse === null`), which carries no summary/topics to render.
 */
export function mapObserverResultToDetailed(
  result: ParsedObserverResponse | null,
): DetailedAnalysis | null {
  if (!result || !result.pulse) return null;
  const hasObservations = result.observations.length > 0;
  return {
    summary: result.pulse.summary,
    topics: result.pulse.topics,
    bloomLevel: hasObservations
      ? bloomFromFloat(
          Math.max(...result.observations.map((o) => o.masteryLevel)),
        )
      : "remember",
    bloomDescription: hasObservations
      ? [...result.observations]
          .sort((a, b) => b.masteryLevel - a.masteryLevel)
          .slice(0, 3)
          .map((o) => `${o.conceptLabel}: ${o.masteryLevel.toFixed(1)}`)
          .join(", ")
      : "No observations yet",
    nudges: result.seeds
      .filter((s) => s.suggestionType === "depth_probe")
      .map((s) => ({ type: "challenge", message: s.rationale })),
    suggestedFollowUps: result.seeds
      .filter((s) => s.suggestionType === "frontier")
      .map((s) => ({ topic: s.topic, rationale: s.rationale })),
  };
}
