/**
 * Pure helpers for the HTTP routes in `convex/http.ts` — chiefly the tutor
 * `/session-stream` route and the `/analyze` route.
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
import type { Interest } from "./lib/interests";
import type { ReadLevel, WriteMode } from "./lib/readingLevels";
import {
  DEFAULT_INSTITUTION_PROMPT_PROFILE,
  type InstitutionPromptProfile,
} from "./lib/institutionPromptProfile";
import {
  normalizeAppTutorContext,
  type AppTutorRequest,
} from "../shared/appTutorRequest";

// ── Mid-stream persistence ──────────────────────────────────────────────

/** Characters of new text between mid-stream content writes. */
export const STREAM_PERSIST_INTERVAL_CHARS = 200;

/**
 * Should the stream write its text to the placeholder row now?
 *
 * Every ~200 characters, AND the moment the placeholder first has visible
 * text. The first-text write is what makes "the stored row is empty" mean
 * "the scholar has seen nothing from it": a stop or steer deletes an empty
 * row and keeps (stamps) a non-empty one (sessions.stampLatestStreamingAssistant).
 * Without it, a reply under 200 characters — a young reader's whole turn — was
 * never stored mid-stream, so Stop deleted words already on the screen
 * (TRA-501). `lastPersistLength` resets to 0 when a tool split opens a new
 * placeholder, so each placeholder gets its own first-text write.
 */
export function shouldPersistStreamContent(
  contentLength: number,
  lastPersistLength: number,
): boolean {
  return (
    contentLength - lastPersistLength > STREAM_PERSIST_INTERVAL_CHARS ||
    (lastPersistLength === 0 && contentLength > 0)
  );
}

// ── SSE formatting ──────────────────────────────────────────────────────

/**
 * Format a payload as a Server-Sent-Events `data:` frame. Every SSE write in
 * `http.ts` goes through this, so the wire shape (`data: <json>\n\n`) is defined
 * and tested in exactly one place.
 */
export function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Convex may end an HTTP action as soon as its response stream closes. Settle
 * the lease release first so the cleanup mutation cannot be abandoned.
 */
export async function releaseLeaseBeforeClosingStream({
  release,
  close,
}: {
  release: () => Promise<void>;
  close: () => void;
}): Promise<void> {
  await release();
  close();
}

// ── Request parsing ─────────────────────────────────────────────────────

/** Pull the fields the `/session-stream` handler needs off the parsed body. */
export function parseSessionStreamBody(body: unknown): {
  sessionId: string;
  assistantMsgId: string;
  platform: "web" | "native";
  supportsRenderCheck?: true;
  appRequest?: Pick<AppTutorRequest, "context">;
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
  /**
   * The App-designer screen mode (Edit | Play). In Play the tutor talks about
   * the running app and MUST NOT rewrite it, so the server drops the code tools
   * (F9). Defaults to "edit" — the tutor keeps its full tool set everywhere
   * else, and a build kickoff is always an edit.
   *
   * This is a REQUEST, not the mode the turn runs in: `/session-stream`
   * derives the effective mode from `activities.editAccess`, the caller's role,
   * and the scholar's completion (`lib/workshopPolicy.ts`, TRA-301) and clamps
   * a forged Edit to Play.
   */
  mode: "edit" | "play";
} {
  const {
    sessionId,
    assistantMsgId,
    platform,
    supportsRenderCheck,
    appRequest,
    rubricCheck,
    kickoff,
    mode,
  } = body as {
    sessionId: string;
    streamId: string;
    assistantMsgId: string;
    platform?: unknown;
    supportsRenderCheck?: unknown;
    appRequest?: { context?: unknown };
    rubricCheck?: { artifactTitle?: string };
    kickoff?: boolean;
    mode?: unknown;
  };
  const normalizedAppContext = normalizeAppTutorContext(appRequest?.context);
  const validAppRequest =
    appRequest !== null &&
    typeof appRequest === "object" &&
    !Array.isArray(appRequest);
  return {
    sessionId,
    assistantMsgId,
    platform: platform === "native" ? "native" : "web",
    supportsRenderCheck:
      supportsRenderCheck === true ? true : undefined,
    appRequest: validAppRequest
      ? {
          ...(normalizedAppContext ? { context: normalizedAppContext } : {}),
        }
      : undefined,
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
    mode: mode === "play" ? "play" : "edit",
  };
}

/**
 * App-designer build tools the tutor holds only in Edit; Play drops them (F9).
 * The character/judge definitions are part of the app, so they go too.
 */
export const WORKSHOP_CODE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "create_code",
  "edit_document",
  "define_character",
  "define_judge",
]);

/**
 * The tool set for a workshop turn: in Play, the tutor watches the running app
 * and must not rewrite it, so the code tools are removed; Edit keeps them all.
 */
export function toolsForWorkshopMode<T extends { name: string }>(
  tools: readonly T[],
  mode: "edit" | "play",
): T[] {
  return mode === "play"
    ? tools.filter((tool) => !WORKSHOP_CODE_TOOL_NAMES.has(tool.name))
    : [...tools];
}

export const RENDER_CHECK_MAX_PER_TURN = 2;
export const RENDER_CHECK_POLL_INTERVAL_MS = 400;
export const RENDER_CHECK_TIMEOUT_MS = 8_000;

const BUILD_TOOL_TRUNCATION_MESSAGE =
  "Your tool call was cut off by the output limit before the code arrived. Build a SMALLER first version now (a working core under roughly 300 lines), then add features with edit_document in later calls.";
const BUILD_TOOL_TRUNCATION_STOP_MESSAGE =
  "Do not call create_code again this turn: reply to the teacher in one short paragraph describing what you will build and ask them to say go.";

type GuardedBuildToolRunResult<T> =
  | {
      blocked: false;
      result: T;
      truncationsThisTurn: number;
    }
  | {
      blocked: true;
      result: string;
      truncationsThisTurn: number;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasNonEmptyString(
  input: Record<string, unknown>,
  key: string,
): boolean {
  const value = input[key];
  return typeof value === "string" && value.trim().length > 0;
}

function editDocumentMutationIsIncomplete(input: unknown): boolean {
  if (!isRecord(input)) return true;
  switch (input.command) {
    // Text documents are always created EMPTY (the scholar writes the words),
    // so a create carries no payload that an output-limit cut could lose.
    case "create":
      return false;
    case "rename":
      return !hasNonEmptyString(input, "title");
    case "str_replace":
      return (
        !hasNonEmptyString(input, "old_str") ||
        typeof input.new_str !== "string"
      );
    case "insert":
      return !hasNonEmptyString(input, "insert_text");
    case "view":
      return false;
    default:
      return true;
  }
}

function isMutatingBuildToolCall(toolName: string, input: unknown): boolean {
  if (toolName === "create_code") return true;
  return (
    toolName === "edit_document" &&
    (!isRecord(input) || input.command !== "view")
  );
}

/**
 * Refuse incomplete build mutations before they reach Convex. The injected
 * runner keeps this helper independent of the HTTP action and easy to test.
 */
export async function runBuildToolWithTruncationGuard<T>({
  toolName,
  input,
  stopReason,
  truncationsThisTurn,
  run,
}: {
  toolName: string;
  input: unknown;
  stopReason?: string | null;
  truncationsThisTurn: number;
  run: () => T | Promise<T>;
}): Promise<GuardedBuildToolRunResult<T>> {
  const missingPayload =
    toolName === "create_code"
      ? !isRecord(input) || !hasNonEmptyString(input, "code")
      : toolName === "edit_document"
        ? editDocumentMutationIsIncomplete(input)
        : false;
  const hitOutputLimit =
    stopReason === "max_tokens" && isMutatingBuildToolCall(toolName, input);

  if (!missingPayload && !hitOutputLimit) {
    return {
      blocked: false,
      result: await run(),
      truncationsThisTurn,
    };
  }

  const nextCount = truncationsThisTurn + 1;
  return {
    blocked: true,
    result:
      nextCount >= 2
        ? `${BUILD_TOOL_TRUNCATION_MESSAGE} ${BUILD_TOOL_TRUNCATION_STOP_MESSAGE}`
        : BUILD_TOOL_TRUNCATION_MESSAGE,
    truncationsThisTurn: nextCount,
  };
}

export function canRequestRenderCheck(renderChecksThisTurn: number): boolean {
  return (
    Number.isInteger(renderChecksThisTurn) &&
    renderChecksThisTurn >= 0 &&
    renderChecksThisTurn < RENDER_CHECK_MAX_PER_TURN
  );
}

export function renderChecksEnabled({
  supportsRenderCheck,
  sessionMode,
}: {
  supportsRenderCheck?: true;
  platform: "web" | "native";
  sessionMode?: "conversation" | "workbench" | "vibecode" | null;
}): boolean {
  return (
    supportsRenderCheck === true &&
    sessionMode === "vibecode"
  );
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
    `celebrate briefly. Before you reply, re-read every earlier ask you made in ` +
    `this conversation about the criterion you are about to probe, and what the ` +
    `scholar did with it. If they did what you asked, it is done — credit it and ` +
    `do not ask for it again in new words. If you told them to leave something as ` +
    `it is, leave it. If the gap you are about to name is something you ` +
    `earlier called enough, your reply MUST ` +
    `open with that admission in its first sentence — "I told you X was ` +
    `enough. I was too quick." — before any question. Do not present it as a ` +
    `part you cannot find: you found it, you accepted it, and you are the ` +
    `one raising the bar now. If their work has not changed since ` +
    `your last ask, a scholar clicking this button again is telling you your last ` +
    `ask did not land — change the move: say what you can actually see in their ` +
    `work, name the part you cannot find, and ask them to point you at it. ` +
    `If their work changed ` +
    `somewhere else, look at THAT part; do not reopen a settled one.]`
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

/** The ephemeral opening instruction for a teacher's app build hand-off. */
export function teacherBuildKickoffInstruction(): string {
  return (
    `[SYSTEM — not a message the teacher typed. The teacher just opened this ` +
    `build session. Build the first working version of the app described in ` +
    `your APP BUILDER MODE lead-in NOW with create_code, then describe what ` +
    `you built and the judgment calls they may want to steer. Do not greet or ` +
    `ask what to build.]`
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
  /** The TALK level (lib/readingLevels.ts). */
  readingLevel: string | null;
  /** READ level and WRITE mode (TRA-503). Optional for offline callers. */
  readLevel?: ReadLevel;
  writeMode?: WriteMode;
  scholarName: string | null;
  sessionMode?: "conversation" | "workbench" | "vibecode" | null;
  vibecodeStarterUsedAt?: number | null;
  /** True on a teacher test-drive session. In a vibecode session it flips the
   *  tutor into the build-partner stance (Move B). Optional so positional/
   *  offline callers default to the scholar stance. */
  isTestDrive?: boolean;
  /** The scholar's screen shows the open-exploration "Wrap up" button (see
   *  getSessionContext). Optional so guest/offline callers default to off. */
  offersWrapUp?: boolean;
  /** Rendered SCHOLAR'S PRIOR WORK IN THIS UNIT section (vibecode only). */
  priorUnitWork?: string | null;
  /** The App designer's parking lot (vibecode; sessions.parkingLot). */
  parkingLot?: ReadonlyArray<{ text: string; reason?: string }> | null;
  /** A free-play session (sessions.freePlay, TRA-489). Optional; offline
   *  callers default to the assignment designer. */
  freePlay?: boolean;
  /** The streaming caller owns the session (set by the stream route). Gates
   *  the contract steering's stay_silent branch. Offline callers default to
   *  true. */
  callerIsSessionOwner?: boolean;
  unitContext: UnitContext | null;
  personaContext: PersonaContext | null;
  perspectiveContext: PerspectiveContext | null;
  processContext: ProcessContext | null;
  processStateData: ProcessStateData | null;
  artifactData: ArtifactData[] | null;
  appStateContext: AppStateContext | null;
  dossierContent: string | null;
  dossierInterests?: Interest[];
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
  /** App designer Play mode: the code tools are not offered this turn, so the
   *  vibecode lead-in collapses to a "switch to Edit" line and the CODE
   *  ARTIFACTS tool section is dropped (G5). Optional; defaults to Edit. Only
   *  the live tutor stream threads it. */
  playMode?: boolean;
};

type TeacherBuildContext = {
  isTestDrive?: boolean;
  lessonActivityContext:
    | Pick<LessonActivityContext, "starterAppId" | "appRequest">
    | null;
};

/** Whether this turn uses the teacher build-partner stance. */
export function isTeacherBuildContext(ctx: TeacherBuildContext): boolean {
  const activity = ctx.lessonActivityContext;
  return (
    ctx.isTestDrive === true &&
    (activity?.starterAppId != null || activity?.appRequest != null)
  );
}

/** Select the model-only opening instruction without changing scholar copy. */
export function kickoffInstructionForContext(
  ctx: TeacherBuildContext,
): string {
  return isTeacherBuildContext(ctx)
    ? teacherBuildKickoffInstruction()
    : kickoffInstruction();
}

/**
 * Map a project context to the tutor system prompt. Wraps `buildSystemPrompt`'s
 * long positional signature in one named place — the empty-array→null
 * conversions for seeds and directives (so their prompt sections are omitted
 * when empty) are the kind of thing that's easy to get wrong inline.
 */
export function buildTutorSystemPrompt(ctx: TutorPromptContext): string {
  const { stable, dynamic, turnContext } = buildTutorSystemPromptParts(ctx);
  return stable + dynamic + "\n\n" + turnContext;
}

/**
 * Cache-split form of {@link buildTutorSystemPrompt}: returns the byte-stable
 * leading run, per-turn-varying system remainder, and minute-varying message
 * suffix separately. The tutor route places the latter after the rolling
 * conversation cache breakpoint.
 */
export function buildTutorSystemPromptParts(ctx: TutorPromptContext): {
  stable: string;
  dynamic: string;
  turnContext: string;
} {
  // Teacher build-partner stance (Move B) turns on ONLY for a teacher
  // test-drive of a COACHED activity — one seeded with a starter app or
  // carrying a hand-off appRequest. A teacher rehearsing a plain kids-build
  // vibecode activity (no starter, no request) keeps the scholar stance so the
  // rehearsal previews exactly what scholars will see. The request travels via
  // the dedicated, never-scholar-facing `appRequest` field, never `description`.
  const activity = ctx.lessonActivityContext;
  const teacherBuild = isTeacherBuildContext(ctx);
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
    ctx.vibecodeStarterUsedAt ?? null,
    teacherBuild,
    teacherBuild ? (activity?.appRequest ?? null) : null,
    ctx.playMode ?? false,
    ctx.dossierInterests ?? null,
    ctx.offersWrapUp ?? false,
    ctx.priorUnitWork ?? null,
    ctx.parkingLot ?? null,
    ctx.callerIsSessionOwner ?? true,
    ctx.freePlay ?? false,
    ctx.readLevel
      ? { read: ctx.readLevel, write: ctx.writeMode ?? "own" }
      : null,
  );
}

export const TURN_CONTEXT_PREFIX =
  "[Turn context from the app, not written by the scholar]\n";

type TurnContextMessage = {
  role: string;
  content: string | Array<{ type: string } & Record<string, unknown>>;
};

/**
 * Append app-authored turn context after the latest user message's cache
 * breakpoint. Returns a new array and leaves the input messages untouched.
 */
export function appendTurnContext<M extends TurnContextMessage>(
  messages: readonly M[],
  turnContext: string,
): M[] {
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser === -1) return [...messages];

  const target = messages[lastUser];
  const originalBlocks =
    typeof target.content === "string"
      ? [{ type: "text", text: target.content }]
      : target.content;
  const content: M["content"] = [
    ...originalBlocks,
    { type: "text", text: TURN_CONTEXT_PREFIX + turnContext },
  ];
  const out = [...messages];
  out[lastUser] = { ...target, content };
  return out;
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

// ── /analyze route: observer result → legacy "detailed" shape ───────────
