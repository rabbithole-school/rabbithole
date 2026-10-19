import { httpRouter, makeFunctionReference } from "convex/server";
import { httpAction, type ActionCtx } from "./_generated/server";
import type {
  BetaRunnableTool,
  BetaToolRunContext,
} from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool.js";
import { internal } from "./_generated/api";
import { PLACEHOLDER_BINDING_ERROR } from "./workshopPolicy";
import { Id } from "./_generated/dataModel";
import { auth } from "./auth";
import { getAuthUserId } from "@convex-dev/auth/server";
import { canAccessSession, READ_ONLY_ACCOUNT_ERROR, VIEWING_AS_READ_ONLY_ERROR } from "./lib/auth";
import { llmBudgetExceeded, llmBudgetMessage } from "./llmBudget";
import { acquireLlmLease } from "./lib/llmLease";
import { TEACHER_ARCHIVE_COPY } from "../shared/teacherArchive";
import { levelsPromptLine } from "./lib/readingLevels";
import { APP_UPDATE_LLM_SURFACE, LLM_BUSY_MESSAGE } from "./lib/llmLimiter";
import {
  sseEvent,
  shouldPersistStreamContent,
  parseSessionStreamBody,
  toolsForWorkshopMode,
  buildTutorSystemPrompt,
  buildTutorSystemPromptParts,
  layoutTutorRequest,
  injectPendingWhisper,
  rubricCheckInstruction,
  kickoffInstructionForContext,
  isTeacherBuildContext,
  releaseLeaseBeforeClosingStream,
  canRequestRenderCheck,
  renderChecksEnabled,
  runBuildToolWithTruncationGuard,
  RENDER_CHECK_POLL_INTERVAL_MS,
  RENDER_CHECK_TIMEOUT_MS,
} from "./sessionStreamHelpers";
import { ROLES, isStaffRole, isTeacherRole } from "./lib/roles";
import { MODELS } from "./lib/models";
import {
  TUTOR_REFUSAL_FALLBACK_BETA,
  resolveTutorModel,
  supportsMidConversationSystem,
  tutorRuntime,
} from "./lib/tutorModel";
import { hasAnthropicApiKey, requireAnthropicApiKey } from "./lib/anthropic";
import { isLocalRunnerDeployment } from "./lib/deploymentSafety";
import { TUTOR_KEY_PATH, TUTOR_NEEDS_KEY_MESSAGE } from "../shared/tutorKey";
import { isPrintRelayClaimConflict } from "./lib/printRelayHttp";
import {
  buildGameHandoffPrompt,
  buildHandoffPrompt,
  buildManipulativeHandoffPrompt,
  deriveHandoffItem,
  GAME_HANDOFF_PROMPT_VERSION,
  handoffDedupKey,
  HANDOFF_MAX_ASSISTANT_TURNS,
  HANDOFF_EMPTY_FALLBACK,
  HANDOFF_PROMPT_VERSION,
  MANIPULATIVE_HANDOFF_PROMPT_VERSION,
  type HandoffEntryMode,
  type ScholarCoachContext,
} from "./lib/practice/handoff";
import {
  buildStretchDialoguePrompt,
  buildDialogueJudgeUser,
  dialogueDedupKey,
  parseDialogueVerdict,
  DIALOGUE_JUDGE_SYSTEM,
  DIALOGUE_JUDGE_TOOL,
  DIALOGUE_MAX_ASSISTANT_TURNS,
} from "./lib/practice/dialogueStretch";
import {
  chatPracticeEnabled,
  buildChatPracticeSection,
} from "./lib/practice/chatPractice";
import { buildChatInstructionSection } from "./lib/practice/chatInstruction";
import { teachBackEnabled, buildTeachBackSection } from "./lib/teachBack";
import {
  buildStoryOpenPrompt,
  storyOpenTurnState,
  storyOpenEndsAfterReply,
  storyOpenDedupKey,
  STORY_OPEN_MAX_TOKENS,
  STORY_OPEN_PROMPT_VERSION,
  STORY_OPEN_CLOSE,
  STORY_OPEN_EMPTY_FALLBACK,
  type StoryOpenPacket,
} from "./lib/practice/storyOpen";
import { resolveAideModel, aideMaxTokens } from "./lib/aideModel";
import { focusScholarAllowed, aideLensScope } from "./lib/aideFocus";
import {
  imageUrlToContentPart,
  attachScratchImageToLastTurn,
  SCRATCH_IMAGE_SYSTEM_NOTE,
  sniffImageMime,
  bytesToBase64,
  base64ToBytes,
  toStorageBlob,
  type ImageContentPart,
} from "./lib/imageBytes";
import {
  appendAppSnapshotToLatestUserMessage,
  appSnapshotBytesToContentPart,
  buildRenderCheckToolResult,
  renderCheckTimeoutToolResult,
} from "./lib/appSnapshot";
import { assembleProjectStreamApiMessages } from "./lib/projectStreamMessages";
import {
  STAY_SILENT_TOOL_NAME,
  appUpdateInstruction,
  heldTextFateAtTool,
} from "./lib/appUpdateTools";
import { buildCharacterOnStageSection } from "./sessionHelpers";
import { buildUnitDesignerResponse } from "./unitDesignerStream";
// questDesignerStream removed in the kill-quests refactor.
import { makeScholarReadTools } from "./lib/scholarReadTools";
import { buildParentAideSystemPrompt, resolveSelectedChildName } from "./lib/parentAidePrompt";
import { verifyMetaSignature } from "./lib/parentMessageChannels";
import { geminiGenerateImage, type GeminiPart } from "./lib/gemini";
import {
  assembleCurriculumTools,
  staffHoldsCurriculumGrant,
} from "./lib/aideTools";
import { CUSTOM_APPS_SYSTEM_PROMPT_SECTION } from "./lib/customAppTools";
import { SUGGESTION_SYSTEM_PROMPT_SECTION } from "./lib/suggestionTools";
import { appBaseUrlOrNull } from "./lib/deploymentConfig";
import {
  checkGuestTranscript,
  guestClientIp,
  guestKickoffInstruction,
  guestTopicById,
  guestTurnInstruction,
  guestTutorAllowsLocalhost,
  hashGuestIp,
  isGuestOriginAllowed,
  isGuestTutorEnabled,
  logGuestTurn,
  GUEST_CAPTION,
  GUEST_CLOSING_LINE,
  GUEST_MAX_TURNS,
  GUEST_RATE_LIMITED_MESSAGE,
  GUEST_TOPICS,
} from "./lib/guestTutor";
import {
  CODE_EXPLORER_MAX_ITERATIONS,
  guardCodeToolArguments,
  makeScholarCodeTools,
  protectedTermsFromNames,
} from "./lib/scholarCodeTools";

/** See the parent-chat-stream `maxIterations` comment. */
const PARENT_AIDE_MAX_ITERATIONS = 8;
import {
  isIdeaConvosEnabled,
  ideaConvosLoopConfig,
  makeIdeaConvoTools,
} from "./lib/scholarIdeaTools";
import {
  formattingGuidance,
  linkBaseFor,
  schoolTimeLabel,
  wallClockUtcIdentity,
} from "./lib/channels";
import {
  STAFF_SCHOLAR_RECORDS_SECTION,
  GROUNDED_CLAIMS_DOCTRINE,
} from "./lib/staffRecordsDoctrine";
import {
  AUDIENCE_DISCLOSURE_DOCTRINE,
  MULTI_PARTY_ETIQUETTE,
  audienceContextLine,
} from "./lib/aideAudience";
import {
  type InstitutionPromptProfile,
  DEFAULT_INSTITUTION_PROMPT_PROFILE,
  longClockClause,
} from "./lib/institutionPromptProfile";
import {
  createStreamStopPredicate,
  runAideStream,
  cachedSystem,
  stopRequestedFromPersistResult,
  withConversationCacheBreakpoint,
  type AideEmit,
} from "./lib/aideStream";
import {
  aideMessageHasFiles,
  buildAideUserContent,
} from "./lib/aideAttachments";
import { recordAnthropicUsage, recordImageUsage, recordUnitUsage, recordUsage } from "./usage";
import { createCacheDiagnosticsTracker } from "./lib/cacheDiagnostics";
import { emptyUsage, addStartUsage, addDeltaOutput } from "./lib/usage";
import {
  createScholarVisibleTextFilter,
  sanitizeScholarVisibleText,
  type ScholarSafeTextPattern,
} from "./lib/scholarSafeText";

import { buildMetaSystemPrompt } from "./metaPrompts";
import { validateMetaStreamRequest } from "./lib/metaBlocks";
import {
  SCHOLAR_PRONOUN_GUIDANCE,
  scholarNamePronounHint,
} from "./lib/scholarPronouns";
import { verifySlackSignature } from "./lib/slackSignature";
import { parseInteractivityBody } from "./lib/slackInteractivity";
import {
  extractEmailAddress,
  extractNewReply,
  findThreadReplyAddress,
  htmlToPlainText,
  retrieveReceivedEmail,
  verifyResendWebhook,
} from "./lib/resendInbound";
import {
  MARK_ACTIVITY_COMPLETE_TOOL_NAME,
  isValidActivityCompletionClosing,
} from "./lib/activityCompletionTool";
import { makeStaySilentTool } from "./lib/staySilentTool";
import {
  missionToolOffer,
  makeDesignerTools,
} from "./lib/designerTools";
import {
  APP_BUILD_TOOL_NAMES,
  CHARACTER_DIRECTOR_TOOL_NAMES,
  makeTutorSessionTools,
  type TutorToolSessionState,
} from "./lib/tutorSessionTools";
import {
  clientToolName,
  CODE_EDITOR_TOOL_NAME,
  requestedArtifactIdFromToolInput,
} from "./lib/tutorCodeEditor";
import { academicCalendarIcs } from "../shared/academicCalendarIcs";
import {
  authorizeGoogleEventsPush,
  parseGoogleEventsEnvelope,
} from "./lib/googleEventsPush";

// TRA-161: text-free drop counter for the scholar-safe-text guard. Fire-and-
// forget — a telemetry failure must never touch the scholar's stream, and the
// segment text itself is never forwarded (only its pattern name and length).
function scholarSafeDropReporter(
  ctx: { runMutation: ActionCtx["runMutation"] },
  source: "tutor" | "story-open" | "practice-handoff" | "practice-dialogue",
  sessionId?: Id<"sessions">,
) {
  return ({ pattern, length }: { pattern: ScholarSafeTextPattern; length: number }) => {
    console.warn(`[scholarSafeText] dropped ${pattern} (${length} chars) source=${source}`);
    void ctx
      .runMutation(internal.scholarSafeTextDrops.record, {
        source,
        pattern,
        segmentLength: length,
        sessionId,
      })
      .catch((error) => console.error("[scholarSafeText] drop telemetry failed:", error));
  };
}

/**
 * The HTTP counterpart of assertWritableAction (convex/lib/auth.ts): every
 * authenticated route that writes on the caller's behalf (streams that store
 * turns, uploads, handoffs) refuses a read-only identity (TRA-494).
 */
async function isReadOnlyCaller(ctx: ActionCtx): Promise<boolean> {
  return await ctx.runQuery(internal.users.isSessionOwnerReadOnly, {});
}

const http = httpRouter();

// Cross-origin headers for the SSE endpoints. The web app runs on a different
// origin (localhost:<port>, the configured web origin, or the deployment's web
// host) than the Convex HTTP
// action host (*.convex.site), so EVERY response the browser reads — including
// the 429 busy refusal and any error — needs `Access-Control-Allow-Origin`, or
// the browser reports it as a CORS-blocked "Failed to fetch" (no status, no
// headers). `Retry-After` must additionally be listed in
// `Access-Control-Expose-Headers` for `res.headers.get("Retry-After")` to be
// readable cross-origin. Matches the 200 SSE responses' `*` origin.
const SSE_ERROR_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "Retry-After",
};


// Register @convex-dev/auth HTTP routes (OIDC discovery, JWKS, sign-in endpoints)
auth.addHttpRoutes(http);

/**
 * Public school-calendar subscription feed (no auth — families paste this URL
 * into Apple/Google Calendar).
 *
 *   GET /calendar.ics                  → the primary institution's calendar
 *   GET /calendar.ics?school=<slug>    → that institution's calendar
 *
 * The `?school=` selector is what keeps this multi-tenant-safe: one school per
 * URL, and an unknown or suspended slug 404s instead of quietly serving the
 * home school's calendar to another school's families.
 */
http.route({
  path: "/calendar.ics",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const slug =
      new URL(request.url).searchParams.get("school")?.trim() || undefined;
    const calendar = await ctx.runQuery(
      internal.academicCalendar.publicCalendarEvents,
      { slug },
    );
    if (!calendar) {
      return new Response("No calendar for that school.\n", {
        status: 404,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }
    return new Response(
      academicCalendarIcs(
        { name: calendar.calendarName, timeZone: calendar.timeZone },
        calendar.events,
      ),
      {
        headers: {
          // Calendar clients poll on their own schedule (Apple ~15 min, Google
          // hourly+). An hour of shared caching absorbs that without making a
          // closure change feel stale.
          "Cache-Control": "public, max-age=3600",
          "Content-Disposition": 'inline; filename="school-calendar.ics"',
          "Content-Type": "text/calendar; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }),
});

/**
 * Session streaming endpoint.
 * Called by the frontend after sendMessage mutation returns a streamId.
 * Reads session context, calls Claude API via beta tool runner,
 * streams tokens back via SSE, and periodically persists content to DB.
 */
const sessionStreamHandler = httpAction(async (ctx, request) => {
    const body = await request.json();
    const rawStreamId = (body as { streamId?: unknown }).streamId;
    const streamId = typeof rawStreamId === "string" ? rawStreamId : "";
    const rawAppSnapshotStorageId = (
      body as { appSnapshotStorageId?: unknown }
    ).appSnapshotStorageId;
    if (
      rawAppSnapshotStorageId !== undefined &&
      typeof rawAppSnapshotStorageId !== "string"
    ) {
      return new Response(sseEvent({ error: "Invalid app snapshot" }), {
        status: 400,
        headers: SSE_ERROR_HEADERS,
      });
    }
    const appSnapshotStorageId =
      typeof rawAppSnapshotStorageId === "string" &&
      rawAppSnapshotStorageId
        ? rawAppSnapshotStorageId
        : null;
    const {
      sessionId,
      assistantMsgId: initialAssistantMsgId,
      platform,
      supportsRenderCheck,
      appRequest,
      rubricCheck,
      kickoff,
      mode: requestedWorkshopMode,
    } = parseSessionStreamBody(body);
    let assistantMsgId = initialAssistantMsgId;

    // ── AUTH ──────────────────────────────────────────────────────────
    // Authenticate the caller before any DB/AI work. (Previously this
    // endpoint trusted the sessionId from the body with no auth, so anyone
    // could stream any scholar's tutor session.)
    const callerUserId = await getAuthUserId(ctx);
    if (!callerUserId) {
      return new Response(
        sseEvent({ error: "Not authenticated" }),
        { status: 401, headers: SSE_ERROR_HEADERS }
      );
    }
    if (await isReadOnlyCaller(ctx)) {
      return new Response(
        sseEvent({ error: READ_ONLY_ACCOUNT_ERROR }),
        { status: 403, headers: SSE_ERROR_HEADERS }
      );
    }

    // Fetch session and related data from DB
    const session = await ctx.runQuery(
      internal.sessionHelpers.getSessionContext,
      {
        sessionId: sessionId as Id<"sessions">,
        // The placeholder carries the app the builder had open (TRA-519);
        // getSessionContext trusts it only for a placeholder of this session.
        ...(assistantMsgId ? { assistantMsgId: String(assistantMsgId) } : {}),
      }
    );

    if (!session) {
      return new Response(
        sseEvent({ error: "Session not found" }),
        { status: 404, headers: SSE_ERROR_HEADERS }
      );
    }

    // Authorize: only the session owner (scholar) or a teacher/admin
    // (remote view-as / test-drive) may stream this session. session.scholarId
    // is the owner (session.userId) — getSessionContext never swaps it.
    const caller = await ctx.runQuery(internal.users.getByIdInternal, {
      id: callerUserId,
    });
    if (!caller || !canAccessSession(caller, session.scholarId)) {
      return new Response(
        sseEvent({ error: "Forbidden" }),
        { status: 403, headers: SSE_ERROR_HEADERS }
      );
    }
    if (caller._id === session.scholarId) {
      try {
        await ctx.runQuery(
          internal.accessGuards.requireActiveLearnerSessionByUserId,
          {
            userId: caller._id,
            sessionId: sessionId as Id<"sessions">,
          },
        );
      } catch {
        return new Response(
          sseEvent({ error: "This learning community is paused." }),
          { status: 403, headers: SSE_ERROR_HEADERS },
        );
      }
    }
    if (session.accessScholarId && caller._id !== session.accessScholarId) {
      try {
        await ctx.runQuery(
          internal.accessGuards.requireActiveScholarAccessByUserId,
          {
            userId: caller._id,
            scholarId: session.accessScholarId,
          },
        );
      } catch {
        return new Response(
          sseEvent({ error: "Forbidden" }),
          { status: 403, headers: SSE_ERROR_HEADERS },
        );
      }
    }
    // ── Teacher archive ───────────────────────────────────────────────
    // An app a teacher put away takes no tutor turns, for anyone, until it
    // is restored. sendMessage and every placeholder path already refuse;
    // this catches a stream POSTed after the archive landed (a stale tab, or
    // a placeholder minted just before it). Refused before any lease is
    // taken, so there is nothing to release.
    if (session.teacherArchivedAt != null) {
      return new Response(
        sseEvent({ error: TEACHER_ARCHIVE_COPY.refusal }),
        { status: 403, headers: SSE_ERROR_HEADERS },
      );
    }
    // ── App designer: the EFFECTIVE mode (TRA-301) ────────────────────
    // The body's `mode` is a request. The server derives the mode this turn
    // actually runs in from the activity's scholar edit policy, the caller's
    // role, and the scholar's completion (lib/workshopPolicy.ts) — so a scholar
    // forging `mode: "edit"` under `never` / a locked `afterCompletion` gets a
    // Play turn: no code tools, Play prompt, no version, tutor thread. The
    // assistant turn is stamped with the thread it actually ran in; the client
    // is told when its request was clamped so the UI snaps to Play.
    // The mutation that opened the turn stamped its thread from the same
    // derivation; the stream honors that stamp as the turn's mode of record
    // (so the user row and the assistant row can never land in different
    // threads) and derives only for an unstamped placeholder. A turn with no
    // builder thread has no Play: it runs as Edit (lib/workshopPolicy.ts).
    const turnPolicy = await ctx
      .runQuery(internal.workshopPolicy.resolveTurnModeForStream, {
        sessionId: sessionId as Id<"sessions">,
        callerUserId: caller._id,
        requestedMode: requestedWorkshopMode,
        streamId,
        assistantMsgId: assistantMsgId as Id<"messages">,
      })
      .catch((error: unknown) => {
        // Only the binding failure is the client's fault (a placeholder that is
        // not this session's live assistant row — see resolveTurnModeForStream).
        // Fail closed before the stream attaches, patches, deletes, or finalizes
        // any row. Anything else is a server error and must surface as one.
        if (
          error instanceof Error &&
          error.message.includes(PLACEHOLDER_BINDING_ERROR)
        ) {
          console.warn(
            "[project-stream] turn placeholder binding rejected:",
            error,
          );
          return null;
        }
        throw error;
      });
    if (!turnPolicy) {
      return new Response(
        sseEvent({
          error: "Turn placeholder does not belong to this stream",
        }),
        { status: 400, headers: SSE_ERROR_HEADERS },
      );
    }

    // ── No Anthropic key on this deployment (TRA-536) ──────────────────
    // Say so plainly instead of failing mid-stream. Checked after auth so it
    // can't be probed anonymously. Only the local runner names the page where
    // the key can be added; elsewhere the chat just shows the message.
    if (!hasAnthropicApiKey()) {
      // Drop the still-empty placeholder without a trace (no preview, no
      // recency): nothing will ever fill it, and a live-looking placeholder
      // would keep every client showing "thinking" until the orphan reap.
      // Checked once the placeholder is proven this stream's (above) and
      // before the turn writes anything (snapshot attach, thread stamp).
      await ctx.runMutation(internal.sessionHelpers.discardEmptyTurnPlaceholder, {
        messageId: assistantMsgId as Id<"messages">,
        sessionId: sessionId as Id<"sessions">,
      });
      return new Response(
        sseEvent({
          error: TUTOR_NEEDS_KEY_MESSAGE,
          ...(isLocalRunnerDeployment() ? { addKeyPath: TUTOR_KEY_PATH } : {}),
        }),
        { status: 503, headers: SSE_ERROR_HEADERS },
      );
    }

    let appSnapshotImagePart: ImageContentPart | null = null;
    if (appSnapshotStorageId) {
      try {
        if (!streamId) {
          throw new Error("App snapshot request is missing its stream id");
        }
        const blob = await ctx.storage.get(
          appSnapshotStorageId as Id<"_storage">,
        );
        if (!blob) throw new Error("App snapshot is unavailable");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        appSnapshotImagePart = appSnapshotBytesToContentPart(bytes);
        const attached = await ctx.runMutation(
          internal.sessions.attachAppSnapshotToTurn,
          {
            sessionId: sessionId as Id<"sessions">,
            streamId,
            assistantMsgId: assistantMsgId as Id<"messages">,
            appSnapshotStorageId: appSnapshotStorageId as Id<"_storage">,
            verifiedMimeType: appSnapshotImagePart.source.media_type,
            verifiedSizeBytes: bytes.byteLength,
          },
        );
        // Not attached (a zero-ask app update has no turn of its own to carry
        // it): the model must not see it pinned to an older message either.
        if (!attached) appSnapshotImagePart = null;
      } catch (error) {
        appSnapshotImagePart = null;
        console.warn(
          "[project-stream] app snapshot unavailable; continuing without it:",
          error,
        );
      }
    }
    const tutorInstitutionId = await ctx.runQuery(
      internal.usage.resolveInstitution,
      { userId: session.scholarId, principal: "scholar" },
    );

    const workshopMode = turnPolicy.mode;
    // A turn opened by in-app events (sessions.startAppUpdateTurn). Read from
    // the server-stamped placeholder, never from the body. With no app asks
    // to answer, the tutor may choose silence (stay_silent).
    const isAppUpdate = turnPolicy.streamTrigger === "appUpdate";
    const offerStaySilent = isAppUpdate && turnPolicy.appUpdateAskCount === 0;
    // Clamped only where the turn runs in a builder thread (Edit/Play exists).
    const workshopModeClamped =
      turnPolicy.thread !== null && workshopMode !== requestedWorkshopMode;
    if (turnPolicy.stampNeeded && turnPolicy.thread) {
      await ctx.runMutation(internal.sessions.stampTurnThread, {
        sessionId: sessionId as Id<"sessions">,
        streamId,
        assistantMsgId: assistantMsgId as Id<"messages">,
        thread: turnPolicy.thread,
      });
    }

    // ── Cost circuit breaker (public test server only) ─────────────────
    // Inert unless LLM_DAILY_BUDGET_USD is set (never on prod). Checked after
    // auth so it can't be probed anonymously; before any Anthropic call.
    const tutorOverBudget = await llmBudgetExceeded(ctx);
    if (tutorOverBudget !== null) {
      return new Response(
        sseEvent({ error: llmBudgetMessage(tutorOverBudget) }),
        { status: 429, headers: SSE_ERROR_HEADERS },
      );
    }

    // Build system prompt (includes artifact data + dossier + directives + mastery context)
    // Thread the parsed workshop mode so a Play turn's prompt matches the tools
    // actually offered — Play drops the code tools, so the prompt must not
    // advertise them (G5). `workshopMode` is "edit" for any non-Play request;
    // the Play lead-in only renders under the builder stance anyway.
    // callerIsSessionOwner: stay_silent is offered only to the session owner
    // (missionToolOffer below), so the prompt's silence branch must agree.
    const promptContext = {
      ...session,
      playMode: workshopMode === "play",
      callerIsSessionOwner: callerUserId === session.scholarId,
    };
    // Cache-split form, ordered by volatility: the stable prefix (cached with
    // the tools array before it), the turn-1-only remainder, the documents
    // (cached in their own block), and the per-turn context that rides after
    // the rolling message breakpoint. See buildTutorSystemPromptParts /
    // layoutTutorRequest.
    const systemParts = buildTutorSystemPromptParts(promptContext);

    const encoder = new TextEncoder();

    const tutorLease = await acquireLlmLease(ctx, {
      userId: callerUserId,
      // A zero-ask app update spends its own start window, never the typed
      // turns' (lib/llmLimiter.ts APP_UPDATE_LLM_SURFACE). One with asks is a
      // scholar's tap and stays on the tutor's surface.
      surface: offerStaySilent ? APP_UPDATE_LLM_SURFACE : "project-stream",
      ...(tutorInstitutionId ? { institutionId: tutorInstitutionId } : {}),
      // An earlier turn whose action died never released its lease; with
      // this, the next turn (or its busy retry) takes the slot back.
      sessionStream: {
        sessionId: sessionId as Id<"sessions">,
        assistantMsgId: assistantMsgId as Id<"messages">,
      },
    });
    if (!tutorLease.ok) {
      // Keep the placeholder alive across EVERY client's retry: stamp its
      // liveness before returning the 429, so another tab / device doesn't
      // declare the turn dead (and offer a racing retry) while this client is
      // legitimately still waiting out the busy window. See streamRetry.ts.
      try {
        await ctx.runMutation(internal.sessionHelpers.touchStreamActivity, {
          messageId: assistantMsgId as Id<"messages">,
        });
      } catch (err) {
        console.error("[project-stream] busy-429 liveness stamp failed:", err);
      }
      return new Response(sseEvent({ error: LLM_BUSY_MESSAGE }), {
        status: 429,
        headers: {
          ...SSE_ERROR_HEADERS,
          "Retry-After": String(tutorLease.retryAfterSec),
        },
      });
    }

    // Teacher rehearsals and build sessions (isTestDrive) run the same model
    // scholars will get on this activity, so what a teacher rehearses is what
    // scholars see. (Until 2026-10 they were pinned to Fable, TRA-288.)
    const selectedTutorModel = resolveTutorModel(
      session.lessonActivityContext?.tutorModel,
    );
    const {
      maxTokens: tutorMaxTokens,
      effort: tutorEffort,
      refusalFallback: tutorRefusalFallback,
    } = tutorRuntime(selectedTutorModel, {
      appBuild: session.appContext.builderFeatures,
    });
    // A teacher rehearsing an activity (isTestDrive) is staff spend, not the
    // scholar tutor's: bill it under its own source and the caller's real role,
    // so the usage report buckets it with Teachers / Platform-admin instead of
    // inflating the Tutor row.
    const tutorUsageSource = session.isTestDrive ? "tutor-test-drive" : "tutor";
    const tutorUsageRole = session.isTestDrive ? caller.role : ROLES.SCHOLAR;
    // Server-side refusal fallback (see lib/tutorModel.tutorRefusalFallback).
    // `fallbacks` postdates the pinned SDK's types, so it is sent as a plain
    // body field; the beta header travels as a request header so the same
    // options work on both the beta tool runner and the plain stream below.
    const tutorFallbackBody = tutorRefusalFallback
      ? ({ fallbacks: "default" } as Record<string, unknown>)
      : {};
    const tutorFallbackOptions = tutorRefusalFallback
      ? { headers: { "anthropic-beta": TUTOR_REFUSAL_FALLBACK_BETA } }
      : undefined;
    // Cache diagnostics: every request of this turn names the previous turn's
    // last response, and the turn's usage row records where the prompt prefix
    // diverged (lib/cacheDiagnostics.ts). Like `fallbacks`, a plain body field.
    const tutorCacheDiagnostics = createCacheDiagnosticsTracker(
      await ctx.runQuery(internal.usage.tutorPreviousResponseId, {
        sessionId: sessionId as Id<"sessions">,
      }),
    );

    let cancelled = false;
    let activeMessageStream: { abort: () => void } | null = null;
    const stream = new ReadableStream({
      async start(controller) {
        // Every SSE write goes through here. After the client disconnects
        // (`cancel`), the turn keeps generating and finalizes into the
        // database (see cancel below), so writes become no-ops instead of
        // throwing on a cancelled stream mid-reply.
        const enqueue = (chunk: Uint8Array) => {
          if (cancelled) return;
          try {
            controller.enqueue(chunk);
          } catch {
            // The client went away between the check and the write.
          }
        };
        let fullContent = "";
        let model = "";
        let tokensUsed = 0;
        const tutorUsage = emptyUsage();
        const projId = sessionId as Id<"sessions">;
        const safeText = createScholarVisibleTextFilter(
          scholarSafeDropReporter(ctx, "tutor", projId),
        );
        const flushSafeText = () => {
          const safeDelta = safeText.finish();
          if (!safeDelta) return;
          fullContent += safeDelta;
          if (!cancelled) {
            enqueue(
              encoder.encode(
                sseEvent({ text: safeDelta })
              )
            );
          }
        };
        let finalized = false;
        let stopped = false;
        // An app update whose placeholder was never split (no text segment or
        // tool row went out). With no text either, finalize leaves no trace.
        const isSilentAppUpdate = () =>
          isAppUpdate && assistantMsgId === initialAssistantMsgId;
        // Tell the client up front when its requested mode was clamped by the
        // scholar edit policy, so the Workshop snaps to Play before any text.
        if (workshopModeClamped) {
          enqueue(
            encoder.encode(sseEvent({ workshopMode })),
          );
        }
        // Pre-turn app baseline for the App designer version recorder, captured
        // once tools are built (below). Declared out here — not inside the try —
        // so the error path can also record/autosave the turn (G4). Null until
        // captured, and null means "treat any current app as changed".
        let turnAppBaseline: {
          artifactId: Id<"artifacts">;
          revision: number;
        } | null = null;
        // create_code ran this turn (TRA-519): a chat session's first app is
        // recorded as a version too. Out here with the baseline so the error
        // path records it as well.
        let createdCodeArtifact = false;
        const stopPredicate = createStreamStopPredicate({
          // A client disconnect is NOT a stop: the scholar's Stop button and a
          // steering send both stop through the database (requestStop /
          // sendMessage stamp stopRequestedAt). Aborting on disconnect
          // persisted whatever had streamed so far, e.g. an opener cut off
          // mid-list at "…dinosaurs 🦕, or" when an iPad slept (TRA-501).
          // A quiet app update still ends on disconnect (see cancel).
          isLocallyStopped: () => stopped || (cancelled && isAppUpdate),
          isStopRequested: () =>
            ctx.runQuery(internal.sessionHelpers.isStopRequested, {
              messageId: assistantMsgId as Id<"messages">,
            }),
        });
        const checkStop = async (force = false) => {
          if (!(await stopPredicate(force))) return false;
          stopped = true;
          return true;
        };
        // Guard against recording this tutor turn's usage twice: the success
        // path records once, but enqueue/close/clearPendingWhisper can still
        // throw afterwards and drop into catch — which must NOT record again
        // (recordUsage is fire-and-forget, so a second call silently
        // double-counts the tokens).
        let usageRecorded = false;
        // Proof-of-life for the WHOLE turn, not just its content ticks. Liveness
        // is otherwise stamped only at message_start and on >200-char persists,
        // so a turn that sits inside a slow tool (generate_image, a code or map
        // tool) with nothing new persisted goes quiet past
        // STREAM_ORPHAN_REAP_AGE_MS. Another tab or a reload then reads the
        // still-live placeholder as dead, and "Try again" (retryAssistantTurn)
        // or the next send's reap deletes it out from under this stream: two
        // turns, two leases, and this turn's text lost when its split/finalize
        // hits the missing row. Reads `assistantMsgId` live, so it follows
        // each split.
        const streamHeartbeat = setInterval(() => {
          void ctx
            .runMutation(internal.sessionHelpers.touchStreamActivity, {
              messageId: assistantMsgId as Id<"messages">,
            })
            .catch((error) =>
              console.error("[project-stream] liveness heartbeat failed:", error),
            );
        }, 5_000);

        try {
          const { Anthropic } = await import("@anthropic-ai/sdk");
          const anthropic = new Anthropic({
            apiKey: requireAnthropicApiKey(),
          });
          let lastPersistLength = 0;
          // Content is persisted every ~200 chars, and the FIRST visible text
          // of every placeholder at once, so an empty stored placeholder
          // reliably means the scholar has seen nothing from it. A stop or
          // steer always STAMPS the row (sessions.stampLatestStreamingAssistant;
          // only an empty quiet app-update placeholder is deleted outright);
          // an empty stopped row is deleted later by
          // sessions.reapDeadStoppedPlaceholder once its liveness heartbeat is
          // stale (TRA-501). Without the first-text write a young reader's
          // ~40-word reply was never stored mid-stream, so Stop deleted text
          // the child was reading.
          const shouldPersistContent = () =>
            shouldPersistStreamContent(fullContent.length, lastPersistLength);
          let renderChecksThisTurn = 0;
          let buildToolTruncationsThisTurn = 0;
          let currentAssistantStopReason: string | null = null;
          const canUseRenderChecks = renderChecksEnabled({
            supportsRenderCheck,
            platform,
            builderFeatures: session.appContext.builderFeatures,
          });

          // Gated tutor-prompt add-ons. Each is OFF by default (env kill-switch)
          // so the live tutor is byte-identical to today; enabling one still
          // requires owner review, while its runtime state is captured in
          // messages.promptVersion. Collected here in two buckets: STATIC
          // sections (constant text, env-gated only) extend the cached `stable`
          // prefix — they are session-stable by construction, so leaving them
          // in per-turn context would re-bill them every turn; sections keyed on
          // per-scholar state extend the per-turn context after the rolling
          // conversation breakpoint (layoutTutorRequest), so a change in them
          // never invalidates the cached documents or history.
          const stableExtraSections: string[] = [];
          const dynamicExtraSections: string[] = [];
          stableExtraSections.push(buildChatInstructionSection());
          // Problems-in-chat (⑮, roadmap §8 Pattern 3): the tutor may drop an
          // inline practice item. Section omitted when the scholar has no
          // known skills to serve; its skill labels move as practice
          // progresses, so it stays in the dynamic half.
          const chatPracticeOn =
            chatPracticeEnabled() && !session.storyThreadContext;
          if (chatPracticeOn) {
            const section = buildChatPracticeSection(
              session.practiceSkillsContext,
            );
            if (section) dynamicExtraSections.push(section);
          }
          // Teach-back mode (Feynman inversion): the tutor may invite the scholar
          // to TEACH a concept to it (see lib/teachBack.ts). Static section.
          const teachBackOn = teachBackEnabled();
          if (teachBackOn) stableExtraSections.push(buildTeachBackSection());
          // The app's AI character, beside the app state (dynamic: it changes
          // with the standing direction). Absent without a character.
          if (session.characterContext) {
            dynamicExtraSections.push(
              buildCharacterOnStageSection(session.characterContext),
            );
          }
          // Build messages for API (with image support).
          let apiMessages = await assembleProjectStreamApiMessages({
            chatHistory: session.chatHistory,
            appRequest,
            appAiTurns:
              session.characterContext?.turns ??
              session.appJudgeContext?.turns,
            characterName: session.characterContext?.name ?? null,
            appAssetPhotos: session.appContext.builderFeatures,
            resolveImagePart: async (imageId) => {
              const imageUrl = await ctx.runQuery(
                internal.files.getUrlInternal,
                { storageId: imageId as Id<"_storage"> },
              );
              return imageUrl
                ? await imageUrlToContentPart(imageUrl)
                : null;
            },
          });
          if (appSnapshotImagePart) {
            apiMessages = appendAppSnapshotToLatestUserMessage(
              apiMessages,
              appSnapshotImagePart,
            );
          }
          if (session.instructionHandback) {
            apiMessages.push({
              role: "user",
              content: session.instructionHandback,
            });
          }

          // ── Inject pending whisper before last user message ──────────
          // Not on an app update: it records no whisper row (it adds no
          // messages beyond its asks), and a silent turn would spend the
          // whisper unseen. The next scholar turn carries it.
          if (!isAppUpdate) {
            injectPendingWhisper(apiMessages, session.pendingWhisper);
          }

          // ── Rubric check trigger ("Check my work") ────────────────────────
          // The scholar clicked the button, which starts a stream with NO
          // persisted user message (see sessions.startRubricCheck). Append an
          // ephemeral, model-visible-only instruction so the tutor re-scores
          // the rubric now. It is never written to the DB or rendered, so no
          // fabricated scholar turn enters the transcript. Consecutive user
          // turns are fine (whisper injection relies on the same).
          if (rubricCheck) {
            apiMessages.push({
              role: "user",
              content: rubricCheckInstruction(rubricCheck.artifactTitle, {
                // The app builder's check only: a Quest's learning steps
                // (a prediction, an essay) keep the usual tutoring check.
                ownQuest:
                  session.mission?.ownQuest === true &&
                  session.appContext.builderStance,
              }),
            });
          }

          // New activity kickoff: the mutation persisted only the assistant
          // placeholder, so this model-only user turn starts the Anthropic
          // message list without fabricating a scholar transcript entry.
          if (kickoff) {
            apiMessages.push({
              role: "user",
              content: kickoffInstructionForContext(session),
            });
          }

          // App update (sessions.startAppUpdateTurn): the new in-app turns and
          // any app asks are already in the history above; this model-only
          // turn tells the tutor it is directing, and may stay silent. The
          // conversation breakpoint goes on the last durable message BEFORE
          // it: the instruction is never replayed, so a marker on it writes a
          // cache entry the next app update can never read.
          const breakpointPlaced = isAppUpdate;
          if (isAppUpdate) {
            apiMessages = withConversationCacheBreakpoint(apiMessages);
            apiMessages.push({
              role: "user",
              content: appUpdateInstruction({
                hasAsks: turnPolicy.appUpdateAskCount > 0,
                hasCharacter: !!session.characterContext,
                canStaySilent: offerStaySilent,
                ownQuest: session.mission?.ownQuest === true,
              }),
            });
          }

          // Volatility-ordered request (layoutTutorRequest): tools → stable
          // system [breakpoint] → turn-1-only text → DOCUMENTS [breakpoint] →
          // history [rolling breakpoint on the last user message, TRA-185] →
          // per-turn context (learning record, app state, clock, pacing)
          // appended after it. A turn that edits nothing reads the app code and
          // the history from cache; only the newest exchange and the per-turn
          // context are new input. Every breakpoint uses the default 5m TTL
          // (TRA-407: 91% of tutor turn gaps are under five minutes). Must run
          // AFTER every apiMessages.push above so the marker lands on the last
          // model-visible user message (an app update placed it before its
          // instruction, above).
          const tutorRequest = layoutTutorRequest({
            stable:
              stableExtraSections.length > 0
                ? `${systemParts.stable}\n${stableExtraSections.join("\n")}`
                : systemParts.stable,
            dynamic: systemParts.dynamic,
            documents: systemParts.documents,
            turnSystem:
              dynamicExtraSections.length > 0
                ? `${systemParts.turnSystem}\n${dynamicExtraSections.join("\n")}`
                : systemParts.turnSystem,
            turnContext: systemParts.turnContext,
            messages: apiMessages,
            conversationBreakpointPlaced: breakpointPlaced,
            midConversationSystem:
              supportsMidConversationSystem(selectedTutorModel),
          });
          const systemPromptForRun = tutorRequest.system;
          // The trailing role:"system" message postdates the pinned SDK's
          // MessageParam type; the API accepts it on every tutor model
          // (lib/tutorModel.supportsMidConversationSystem).
          const messagesForRun = tutorRequest.messages as typeof apiMessages;

          // Split the assistant message at a tool boundary: finalize the text
          // streamed so far into its own bubble, drop a tool chip, and open a
          // fresh placeholder for the post-tool text. Without this, text the
          // tutor streams BEFORE a tool call and text it streams AFTER both
          // accumulate into the same `fullContent` and render as one run-on
          // message (e.g. "…what you've got!That gutter…"). The write tools
          // inline this same dance; read-ish tools (view/rename) use this
          // helper. `splitStream` deletes the current placeholder when no text
          // was streamed yet, so a bare tool call won't leave an empty bubble.
          const splitAfterTool = async (
            toolAction: string,
            marksActivityCompletion = false,
            completionAnchorCurrentMessage = false,
          ) => {
            const newId = await ctx.runMutation(internal.sessionHelpers.splitStream, {
              currentMessageId: assistantMsgId as Id<"messages">,
              sessionId: projId,
              contentSoFar: fullContent,
              toolAction,
              marksActivityCompletion,
              completionAnchorCurrentMessage,
            });
            assistantMsgId = newId;
            fullContent = "";
            lastPersistLength = 0;
            enqueue(
              encoder.encode(sseEvent({ newAssistantMsg: String(newId) }))
            );
          };

          // ── Tool-gating flags ────────────────────────────────────────
          // The actual tool definitions (run callbacks, schemas) now live in
          // the makeTutorSessionTools factory (convex/lib/tutorSessionTools.ts);
          // these flags decide which of that factory's tools are offered.

          const hasProcess = session.processContext && session.processStateData;

          // ── Rubric scoring tool ─────────────────────────────────────
          // Available when the session's activity has a deliverable
          // (rubric). The tutor uses this to update per-criterion
          // verdicts directly — analogous to how processStepTool moves
          // the workflow forward — instead of the scholar clicking a
          // separate "Check my work" button.
          // …except for a PHOTO deliverable, which the tutor does not score:
          // the scholar's own Check runs a multimodal read of the image
          // (deliverableAssess). The tutor never sees that image, and the tool
          // has no document to hang a photo verdict on — called without an
          // artifact_id it falls through to the session's newest TEXT artifact
          // and scores the wrong work against the photo's rubric. Withholding
          // the tool is what actually enforces that; the prompt saying "never
          // call it" competes with the tool's own description.
          const hasScorableDeliverable =
            !!session.standaloneDeliverableContext &&
            session.standaloneDeliverableContext.kind !== "photo";
          const hasRubric =
            hasScorableDeliverable || !!session.advanceRubricContext;
          const activityWasAlreadyComplete =
            !!session.standaloneDeliverableContext?.isComplete ||
            !!session.advanceRubricContext?.isComplete;

          // ── Conversation-completion tool ─────────────────────────────
          // Offered for an online activity without an advance rubric (see
          // conversationCompletionContext in getSessionContext). A deliverable
          // rubric records quality but does not complete the activity; the tutor
          // closes the learning arc through this normal completion path.
          // The mutation re-validates the whole gate server-side and returns a
          // STRUCTURED refusal (never a raw throw) so a tool error can't reach
          // the scholar.
          const hasConversationCompletion =
            !!session.conversationCompletionContext;
          let completionHadPreToolText = false;
          let rubricHadPreToolText = false;
          let completionPreToolClosingIsValid = false;
          let rubricPreToolClosingIsValid = false;
          let suppressCompletionFollowUp = false;
          let activityCompletedThisStream = false;
          // stay_silent ran this turn. ONE tool of that name per turn: an app
          // update with no asks offers lib/staySilentTool.ts, a scholar's
          // builder-stance Edit turn under a contract offers lib/designerTools.ts's,
          // never both (see the tool assembly below). Until the model's first
          // tool decision, its text is HELD rather than streamed: if that
          // decision is stay_silent the held text is dropped, so nothing
          // written before the call reaches the scholar; any other tool, or
          // the end of the message, releases it. Once silenced, later text is
          // dropped and the turn ends.
          let silenced = false;
          let heldText = "";
          // Liveness while text is held: nothing streams or persists, so
          // stamp lastStreamActivityAt directly (as streamed text's persists
          // do) or a long held first message reads as dead to the retry
          // affordance (retryAssistantTurn). At most every HELD_TEXT_STAMP_MS.
          const HELD_TEXT_STAMP_MS = 5_000;
          let lastHeldStampAt = Date.now();
          const releaseHeldText = () => {
            const held = heldText;
            heldText = "";
            if (!held) return;
            const safeDelta = safeText.push(held);
            if (!safeDelta) return;
            fullContent += safeDelta;
            if (!cancelled) {
              enqueue(encoder.encode(sseEvent({ text: safeDelta })));
            }
          };

          // ── Activity-angle tool (per-activity jigsaw) ─────────────
          // When an activity has `hasScholarAngles: true`, the tutor
          // captures the scholar's chosen angle and writes it to
          // scholarActivityAngles. Replaces the old `set_quest_angle`.
          const hasAngles = !!session.activityContext?.hasScholarAngles;
          const angleAlreadySet =
            !!session.activityContext?.scholarAngleTitle;
          const isAngleKickoff = hasAngles && !angleAlreadySet;

          // ── IS Unit co-design tools (planning tutor) ──────────────
          // Active only when the session's unit is the scholar's own
          // Independent Study unit (session.unitContext.isOwnIsUnit).
          // Gated server-side by requireUnitEditAccess in each wrapped
          // mutation, so a malicious caller can't use these against
          // someone else's unit even if they slipped past the gate
          // here. See review/scholar-IS-codesign.md.
          const isOwnIsUnit = !!session.unitContext?.isOwnIsUnit;
          const ownIsUnitId = session.unitContext?.unitId ?? null;

          // ── Physical task tool (Phase 2) ────────────────────────────
          // Available whenever the scholar's school has tutor-suggestable
          // equipment (same condition that renders the PHYSICAL ENVIRONMENT
          // prompt section). Turns an invitation into a persistent "Go do this"
          // card + a physicalTasks record for teacher visibility. Reference gear
          // by the NAME shown in that section.
          const hasPhysicalEnv = !!session.physicalEnvironmentContext;
          const hasActivityResources =
            (session.activityResourceContext?.length ?? 0) > 0;

          // ── Tool assembly ────────────────────────────────────────────
          // The full scholar-session toolset (process/rubric/completion/
          // angle/IS-unit-codesign/documents/code/map/physical-task/
          // resource/dossier/check-work/image, plus the gated problems-in-
          // chat and teach-back pairs) is assembled by the factory in
          // convex/lib/tutorSessionTools.ts — same tool definitions, same
          // gates, same order as before this extraction. `emit` replaces the
          // old direct enqueue(encoder.encode(sseEvent(...)))
          // calls inside each tool body; `toolState` proxies this handler's
          // own stream-local mutable state (assistantMsgId/fullContent/
          // lastPersistLength + the completion/rubric pre-tool-text flags)
          // so a write from inside a tool's `run` callback is immediately
          // visible to the post-tool-loop code below, which reads/writes the
          // SAME underlying locals.
          const emit: AideEmit = (data) =>
            enqueue(encoder.encode(sseEvent(data)));
          const toolState: TutorToolSessionState = {
            get assistantMsgId() { return assistantMsgId; },
            set assistantMsgId(v) { assistantMsgId = v; },
            get fullContent() { return fullContent; },
            set fullContent(v) { fullContent = v; },
            get lastPersistLength() { return lastPersistLength; },
            set lastPersistLength(v) { lastPersistLength = v; },
            get completionHadPreToolText() { return completionHadPreToolText; },
            set completionHadPreToolText(v) { completionHadPreToolText = v; },
            get rubricHadPreToolText() { return rubricHadPreToolText; },
            set rubricHadPreToolText(v) { rubricHadPreToolText = v; },
            get completionPreToolClosingIsValid() { return completionPreToolClosingIsValid; },
            set completionPreToolClosingIsValid(v) { completionPreToolClosingIsValid = v; },
            get rubricPreToolClosingIsValid() { return rubricPreToolClosingIsValid; },
            set rubricPreToolClosingIsValid(v) { rubricPreToolClosingIsValid = v; },
            get suppressCompletionFollowUp() { return suppressCompletionFollowUp; },
            set suppressCompletionFollowUp(v) { suppressCompletionFollowUp = v; },
            get activityCompletedThisStream() { return activityCompletedThisStream; },
            set activityCompletedThisStream(v) { activityCompletedThisStream = v; },
            get createdCodeArtifact() { return createdCodeArtifact; },
            set createdCodeArtifact(v) { createdCodeArtifact = v; },
          };
          const tools = await makeTutorSessionTools(ctx, emit, {
            session,
            projId,
            callerUserId,
            callerRole: caller.role,
            institutionId: tutorInstitutionId,
            state: toolState,
            splitAfterTool,
            hasProcess,
            hasRubric,
            activityWasAlreadyComplete,
            preserveSubmittedArtifactSnapshot: !!rubricCheck,
            hasConversationCompletion,
            hasActivityResources,
            hasPhysicalEnv,
            isAngleKickoff,
            isOwnIsUnit,
            ownIsUnitId,
            instructionPlatform: platform,
            chatPracticeOn,
            teachBackOn,
          });

          const readTextArtifacts = async () => {
            const artifacts = await ctx.runQuery(
              internal.artifacts.aiGetContent,
              { sessionId: projId },
            );
            return Array.isArray(artifacts)
              ? artifacts
              : artifacts
                ? [artifacts]
                : [];
          };
          const changedHtmlArtifact = (
            before: Awaited<ReturnType<typeof readTextArtifacts>>,
            after: Awaited<ReturnType<typeof readTextArtifacts>>,
            input: unknown,
          ) => {
            const beforeById = new Map(
              before.map((artifact) => [String(artifact._id), artifact]),
            );
            const changed = after.filter((artifact) => {
              const previous = beforeById.get(String(artifact._id));
              return (
                (artifact.type === "code" || artifact.language === "html") &&
                (!previous || previous.content !== artifact.content)
              );
            });
            // edit_document names a document_id; the app editor a path.
            const requestedId = requestedArtifactIdFromToolInput(input);
            return (
              (requestedId
                ? changed.find(
                    (artifact) => String(artifact._id) === requestedId,
                  )
                : undefined) ??
              changed[0] ??
              null
            );
          };
          const waitForRenderCheckAnswer = async (
            messageId: Id<"messages">,
            checkId: string,
            isCancelled: () => boolean,
          ) => {
            const deadline = Date.now() + RENDER_CHECK_TIMEOUT_MS;
            while (!isCancelled()) {
              const answer = await ctx.runQuery(
                internal.sessions.getRenderCheckAnswer,
                {
                  sessionId: projId,
                  streamId,
                  messageId,
                  checkId,
                },
              );
              if (isCancelled()) return null;
              if (answer) return answer;
              const remaining = deadline - Date.now();
              if (remaining <= 0) return null;
              await new Promise((resolve) =>
                setTimeout(
                  resolve,
                  Math.min(RENDER_CHECK_POLL_INTERVAL_MS, remaining),
                ),
              );
            }
            return null;
          };
          const withRenderCheck = (
            tool: BetaRunnableTool,
          ): BetaRunnableTool => {
            if (
              tool.name !== "create_code" &&
              tool.name !== "edit_document" &&
              tool.name !== CODE_EDITOR_TOOL_NAME
            ) {
              return tool;
            }
            const run = tool.run;
            return {
              ...tool,
              run: async (input, context?: BetaToolRunContext) => {
                const canCheck =
                  canUseRenderChecks &&
                  canRequestRenderCheck(renderChecksThisTurn);
                let before: Awaited<
                  ReturnType<typeof readTextArtifacts>
                > = [];
                const guarded = await runBuildToolWithTruncationGuard({
                  toolName: tool.name,
                  input,
                  stopReason: currentAssistantStopReason,
                  truncationsThisTurn: buildToolTruncationsThisTurn,
                  run: async () => {
                    before = canCheck ? await readTextArtifacts() : [];
                    return run(input, context);
                  },
                });
                buildToolTruncationsThisTurn =
                  guarded.truncationsThisTurn;
                if (guarded.blocked) return guarded.result;

                const result = guarded.result;
                if (!canCheck || typeof result !== "string") return result;

                const artifact = changedHtmlArtifact(
                  before,
                  await readTextArtifacts(),
                  input,
                );
                if (!artifact) return result;

                renderChecksThisTurn += 1;
                const checkId = crypto.randomUUID();
                const messageId = assistantMsgId as Id<"messages">;
                await ctx.runMutation(internal.sessions.requestRenderCheck, {
                  sessionId: projId,
                  streamId,
                  messageId,
                  checkId,
                });
                if (!cancelled) {
                  emit({
                    renderCheck: {
                      checkId,
                      artifactId: String(artifact._id),
                    },
                  });
                }

                const answer = await waitForRenderCheckAnswer(
                  messageId,
                  checkId,
                  () => cancelled,
                );
                if (!answer) return renderCheckTimeoutToolResult(result);

                let imagePart: ImageContentPart | null = null;
                if (answer.snapshotStorageId) {
                  const blob = await ctx.storage.get(
                    answer.snapshotStorageId,
                  );
                  if (blob) {
                    try {
                      imagePart = appSnapshotBytesToContentPart(
                        new Uint8Array(await blob.arrayBuffer()),
                      );
                    } catch (error) {
                      console.warn(
                        "[project-stream] render-check snapshot unavailable; continuing without it:",
                        error,
                      );
                    }
                  }
                }
                return buildRenderCheckToolResult(
                  result,
                  answer,
                  imagePart,
                );
              },
            };
          };
          const runnableTools: readonly BetaRunnableTool[] =
            toolsForWorkshopMode(tools, workshopMode);
          const toolsForRun = runnableTools.map(withRenderCheck);
          // Mission steering (TRA-519 B1, lib/designerTools.ts):
          // park_idea / unpark_idea on any turn of a session with a MISSION —
          // tutor stance, or builder stance in Edit — the condition the
          // prompt's MISSION section / contract steering renders under; and
          // stay_silent only on a builder-stance app activity, for the
          // session owner, with allowSilence (the prompt's silence branch uses
          // the same owner test via promptContext.callerIsSessionOwner).
          // Appended after the factory's tools so the factory's tool order
          // (and cache prefix) is unchanged.
          const designerOffer = missionToolOffer({
            hasMission: session.mission != null,
            builderStance: session.appContext.builderStance,
            workshopMode,
            teacherBuild: isTeacherBuildContext(session),
            appActivity: session.lessonActivityContext?.kind === "vibecode",
            allowSilence: session.lessonActivityContext?.allowSilence === true,
            callerIsSessionOwner: callerUserId === session.scholarId,
            freePlay: session.freePlay === true,
          });
          // One stay_silent per turn (the SDK rejects duplicate tool names):
          // an app update offers its own below, so the designer's is withheld
          // on every app-update turn.
          const designerStaySilent = designerOffer.staySilent && !isAppUpdate;
          toolsForRun.push(
            ...(await makeDesignerTools({
              offer: { ...designerOffer, staySilent: designerStaySilent },
              parkIdea: (idea) =>
                ctx.runMutation(internal.sessions.parkIdea, {
                  sessionId: projId,
                  text: idea.text,
                  ...(idea.reason ? { reason: idea.reason } : {}),
                }),
              unparkIdea: (text) =>
                ctx.runMutation(internal.sessions.unparkIdea, {
                  sessionId: projId,
                  text,
                }),
              onSilence: () => {
                silenced = true;
              },
            })),
          );
          // An app update with no asks: this branch's stay_silent. Appended
          // (not part of the factory's cached tool order) so every other
          // turn's tool list — and its prompt-cache prefix — is unchanged.
          if (offerStaySilent) {
            toolsForRun.push(
              await makeStaySilentTool(() => {
                silenced = true;
              }),
            );
          }
          // A builder's Edit turn holds EVERY message's text until that
          // message's tool decision, and an app build tool drops it: the
          // model writes "Now the lava rules: ..." between edits whatever the
          // prompt says, and each tool's stream split would show it as its
          // own bubble. The reply after the last edit ends without a tool and
          // is released whole.
          const holdBuildNarration =
            session.appContext.builderStance && workshopMode !== "play";
          const buildToolNames: ReadonlySet<string> = holdBuildNarration
            ? APP_BUILD_TOOL_NAMES
            : new Set();
          // The designer's hold covers the turn's FIRST message only (later
          // messages stream as usual); an app update or a builder's Edit turn
          // re-arms it on every message (below).
          let holdingText =
            designerStaySilent || offerStaySilent || holdBuildNarration;

          // App designer: capture the pre-turn app baseline so the stream
          // commit path can record a version only when THIS turn changed the
          // app (server-side recording + autosave — F3/F4/F11). Any session
          // with an app (TRA-519), Edit only — Play never records or
          // autosaves (F9). A session with no app yet has no baseline: a
          // create_code this turn records from nothing.
          if (session.appContext.hasApp && workshopMode !== "play") {
            turnAppBaseline = await ctx.runQuery(
              internal.codeArtifactRevisions.newestCodeArtifactBaseline,
              {
                sessionId: projId,
                ...(session.focusAppId
                  ? { focusArtifactId: session.focusAppId }
                  : {}),
              },
            );
          }

          // ── Stream with tool runner ──────────────────────────────────

          if (toolsForRun.length > 0) {
            // Use beta tool runner for automatic multi-turn handling
            const runner = anthropic.beta.messages.toolRunner({
              model: selectedTutorModel,
              max_tokens: tutorMaxTokens,
              system: systemPromptForRun,
              messages: messagesForRun,
              tools: toolsForRun,
              stream: true,
              tool_choice: {
                type: "auto",
                disable_parallel_tool_use: true,
              },
              ...(tutorEffort
                ? { output_config: { effort: tutorEffort } }
                : {}),
              ...tutorFallbackBody,
              ...tutorCacheDiagnostics.requestBody,
            }, tutorFallbackOptions);

            // Nested iteration: outer = turns, inner = streaming events.
            // A stop exits both before the SDK can advance to another tool turn.
            try {
              streamLoop: for await (const messageStream of runner) {
                activeMessageStream = messageStream;
                let toolBlockOpen = false;
                if (await checkStop()) {
                  messageStream.abort();
                  break;
                }
                // stay_silent ran: end the turn rather than generate a reply
                // to its tool result.
                if (silenced) {
                  messageStream.abort();
                  break;
                }
                // An app update holds each message's text until that
                // message's first tool decision.
                if (offerStaySilent || holdBuildNarration) holdingText = true;
                try {
                  for await (const event of messageStream) {
                    if (await checkStop()) {
                      messageStream.abort();
                      break streamLoop;
                    }
                    if (
                      event.type === "content_block_start" &&
                      event.content_block?.type === "tool_use"
                    ) {
                      const toolName = (
                        event.content_block as { name?: string }
                      ).name;
                      // Decide the held text before the stop check, so a stop
                      // here still drops narration (and keeps a real line).
                      if (holdingText) {
                        holdingText = false;
                        if (
                          heldTextFateAtTool(toolName, {
                            quietAppUpdate: offerStaySilent,
                            directorToolNames: CHARACTER_DIRECTOR_TOOL_NAMES,
                            buildToolNames,
                          }) === "drop"
                        ) {
                          heldText = "";
                        } else releaseHeldText();
                      }
                      if (await checkStop(true)) {
                        messageStream.abort();
                        break streamLoop;
                      }
                      toolBlockOpen = true;
                      flushSafeText();
                      if (toolName === MARK_ACTIVITY_COMPLETE_TOOL_NAME) {
                        completionHadPreToolText = !!fullContent.trim();
                        completionPreToolClosingIsValid =
                          completionHadPreToolText &&
                          isValidActivityCompletionClosing(fullContent);
                      } else if (toolName === "update_rubric_score") {
                        rubricHadPreToolText = !!fullContent.trim();
                        rubricPreToolClosingIsValid =
                          rubricHadPreToolText &&
                          isValidActivityCompletionClosing(fullContent);
                      }
                      // A direction to the app's character, or a decision to stay
                      // silent, must leave no trace on the scholar's screen.
                      if (
                        !CHARACTER_DIRECTOR_TOOL_NAMES.has(toolName ?? "") &&
                        toolName !== STAY_SILENT_TOOL_NAME
                      ) {
                        enqueue(
                          encoder.encode(
                            // The app editor goes out as edit_document,
                            // the name both clients already know.
                            sseEvent({ toolStart: { name: clientToolName(toolName) } }),
                          ),
                        );
                      }
                    } else if (
                      event.type === "content_block_stop" &&
                      toolBlockOpen
                    ) {
                      if (await checkStop(true)) {
                        messageStream.abort();
                        break streamLoop;
                      }
                      toolBlockOpen = false;
                    } else if (event.type === "message_start") {
                      currentAssistantStopReason = null;
                      model = event.message.model;
                      addStartUsage(tutorUsage, event.message.usage);
                      tutorCacheDiagnostics.observe(event.message);
                      // Backstop: never glue two model messages into one row.
                      // `fullContent` is a closure variable that survives across
                      // toolRunner iterations, and each tool's run() is expected
                      // to split the stream (finalize the pre-tool text, open a
                      // fresh placeholder) and reset it. Several tool return
                      // paths don't — mark_activity_complete's structured
                      // refusal and its catch path, update_rubric_score's catch
                      // path and its conversation-rubric alreadyComplete /
                      // rejectedCompletion early returns. When one of those
                      // runs, the NEXT message's text is appended to the
                      // previous message's text with no separator, and one
                      // stored row reads like two glued replies — the first
                      // reply's closing sentence runs straight into the next
                      // reply's opening one with no space between them. So if a new model
                      // message is starting while text is still buffered, split
                      // it off silently here: a blank toolAction persists no
                      // tool chip, and splitStream deletes an empty placeholder,
                      // so this is a no-op whenever the tool already split.
                      // Backstop only — tools still own their own splits.
                      flushSafeText();
                      if (fullContent.trim()) {
                        await splitAfterTool("");
                      }
                      // Heartbeat: a turn started. If this turn does a long tool
                      // call (e.g. generate_image) or thinking-pause before any
                      // text, no content persist fires for a while — so stamp the
                      // liveness signal now so the orphan-reap doesn't wrongly kill
                      // this still-live placeholder.
                      await ctx.runMutation(
                        internal.sessionHelpers.touchStreamActivity,
                        { messageId: assistantMsgId as Id<"messages"> },
                      );
                    } else if (event.type === "content_block_delta") {
                      const delta = event.delta;
                      if ("text" in delta) {
                        if (suppressCompletionFollowUp || silenced) continue;
                        if (holdingText) {
                          heldText += delta.text;
                          if (Date.now() - lastHeldStampAt >= HELD_TEXT_STAMP_MS) {
                            lastHeldStampAt = Date.now();
                            await ctx.runMutation(
                              internal.sessionHelpers.touchStreamActivity,
                              { messageId: assistantMsgId as Id<"messages"> },
                            );
                          }
                          continue;
                        }
                        const safeDelta = safeText.push(delta.text);
                        if (!safeDelta) continue;
                        fullContent += safeDelta;
                        enqueue(
                          encoder.encode(sseEvent({ text: safeDelta })),
                        );
                        if (shouldPersistContent()) {
                          lastPersistLength = fullContent.length;
                          const persistResult = await ctx.runMutation(
                            internal.sessionHelpers.updateStreamContent,
                            {
                              messageId: assistantMsgId as Id<"messages">,
                              content: fullContent,
                            },
                          );
                          if (
                            stopRequestedFromPersistResult(persistResult)
                          ) {
                            stopped = true;
                            messageStream.abort();
                            break streamLoop;
                          }
                        }
                      }
                    } else if (event.type === "message_delta") {
                      currentAssistantStopReason =
                        event.delta.stop_reason ??
                        currentAssistantStopReason;
                      if (event.usage) {
                        tokensUsed += event.usage.output_tokens;
                        addDeltaOutput(tutorUsage, event.usage.output_tokens);
                      }
                    }
                  }
                  // The message ended without a tool decision: the model chose
                  // to speak, so its held text goes out.
                  if (holdingText && !silenced) releaseHeldText();
                  holdingText = false;
                  if (await checkStop(true)) {
                    break streamLoop;
                  }
                } finally {
                  if (activeMessageStream === messageStream) {
                    activeMessageStream = null;
                  }
                }
              }
            } catch (error) {
              // A silenced turn aborts its follow-up request on purpose.
              if (!cancelled && !stopped && !silenced) throw error;
            } finally {
              activeMessageStream = null;
            }
            // A stop or cancel leaves the loop before a held message reaches
            // its tool decision or its end. What it said so far was speech, not
            // narration (no build tool followed), so keep it, as a streamed
            // reply keeps its partial text on a stop.
            if (holdingText && !silenced) releaseHeldText();
            holdingText = false;
          } else {
            // No tools: simple streaming (no tool runner needed)
            const anthropicStream = anthropic.messages.stream({
              model: selectedTutorModel,
              max_tokens: tutorMaxTokens,
              system: systemPromptForRun,
              messages: messagesForRun,
              ...(tutorEffort
                ? { output_config: { effort: tutorEffort } }
                : {}),
              ...tutorFallbackBody,
              ...tutorCacheDiagnostics.requestBody,
            }, tutorFallbackOptions);

            activeMessageStream = anthropicStream;
            try {
              if (await checkStop()) {
                anthropicStream.abort();
              } else {
                for await (const event of anthropicStream) {
                  if (await checkStop()) {
                    anthropicStream.abort();
                    break;
                  }
                  if (event.type === "message_start") {
                    model = event.message.model;
                    addStartUsage(tutorUsage, event.message.usage);
                    tutorCacheDiagnostics.observe(event.message);
                    // Heartbeat: proof-of-life before any text streams (see the
                    // tools-path message_start above and the reap in sendMessage).
                    await ctx.runMutation(
                      internal.sessionHelpers.touchStreamActivity,
                      { messageId: assistantMsgId as Id<"messages"> },
                    );
                  } else if (event.type === "content_block_delta") {
                    const delta = event.delta;
                    if ("text" in delta) {
                      const safeDelta = safeText.push(delta.text);
                      if (!safeDelta) continue;
                      fullContent += safeDelta;
                      enqueue(
                        encoder.encode(sseEvent({ text: safeDelta })),
                      );
                      if (shouldPersistContent()) {
                        lastPersistLength = fullContent.length;
                        const persistResult = await ctx.runMutation(
                          internal.sessionHelpers.updateStreamContent,
                          {
                            messageId: assistantMsgId as Id<"messages">,
                            content: fullContent,
                          },
                        );
                        if (
                          stopRequestedFromPersistResult(persistResult)
                        ) {
                          stopped = true;
                          anthropicStream.abort();
                          break;
                        }
                      }
                    }
                  } else if (event.type === "message_delta") {
                    if (event.usage) {
                      tokensUsed += event.usage.output_tokens;
                      addDeltaOutput(tutorUsage, event.usage.output_tokens);
                    }
                  }
                }
              }
            } catch (error) {
              if (!cancelled && !stopped) throw error;
            } finally {
              activeMessageStream = null;
            }
          }

          flushSafeText();
          // A turn that showed nothing — stay_silent (either version), or an
          // app update that never split its placeholder: the placeholder goes,
          // and the session's preview, recency and observer are left untouched.
          const silentTurn =
            (silenced || isSilentAppUpdate()) && !fullContent.trim();

          // Finalize: save full content, clear stream ID, update session
          await ctx.runMutation(internal.sessionHelpers.finalizeStream, {
            messageId: assistantMsgId as Id<"messages">,
            sessionId: projId,
            content: fullContent,
            model,
            tokensUsed,
            ...(silentTurn ? { silent: true } : {}),
          });
          finalized = true;
          await recordUsage(ctx, {
            source: tutorUsageSource,
            role: tutorUsageRole,
            institutionId: tutorInstitutionId,
            model: model || selectedTutorModel,
            usage: tutorUsage,
            sessionId: projId,
            cacheMissAt: tutorCacheDiagnostics.cacheMissAt,
            responseId: tutorCacheDiagnostics.lastResponseId,
          });
          usageRecorded = true;

          // Clear pending whisper after it's been consumed (an app update
          // never consumes it — see the injection above; a silent turn showed
          // nothing, so the next turn carries it)
          if (session.pendingWhisper && !isAppUpdate && !silentTurn) {
            await ctx.runMutation(
              internal.sessionHelpers.clearPendingWhisper,
              { sessionId: projId }
            );
          }

          if (!cancelled) {
            enqueue(
              encoder.encode(
                sseEvent({
                  done: true,
                  messageId: assistantMsgId,
                  ...(stopped ? { stopped: true } : {}),
                  // Additive: the turn left nothing in the transcript.
                  ...(silentTurn ? { silent: true } : {}),
                }),
              ),
            );
          }

          // App designer: record one version for this designer turn if it
          // changed the app, and (teacher build session) autosave the app to
          // the activity starter — all SERVER-SIDE, so a closed tab or a native
          // build never drops a version or a save (F3/F4/F11). Runs after the
          // `done` event so the client isn't blocked on the blob-copying save;
          // the Workshop's saved-at reads customApps.updatedAt reactively. The
          // Stop path (client abort → `stopped`) reaches here too — it unwinds
          // through this normal block, not the catch. `recordWorkshopTurn`
          // never throws.
          await ctx.runAction(
            internal.vibecodeStarterActions.recordWorkshopTurn,
            {
              sessionId: projId,
              messageId: assistantMsgId as Id<"messages">,
              callerUserId: session.scholarId,
              // TRA-519: any session with an app, or one whose create_code ran
              // this turn, records its app versions.
              appBuild:
                session.appContext.builderFeatures || createdCodeArtifact,
              workshopMode,
              ...(turnAppBaseline
                ? { baselineArtifactId: turnAppBaseline.artifactId }
                : {}),
              baselineRevision: turnAppBaseline?.revision ?? -1,
              ...(session.focusAppId
                ? { focusArtifactId: session.focusAppId }
                : {}),
            },
          );

          await releaseLeaseBeforeClosingStream({
            release: tutorLease.release,
            close: () => {
              if (!cancelled) controller.close();
            },
          });
        } catch (error) {
          console.error("Stream error:", error);
          // Finalize the stuck message so it doesn't show an infinite spinner
          if (!finalized) {
            try {
              await ctx.runMutation(internal.sessionHelpers.finalizeStream, {
                messageId: assistantMsgId as Id<"messages">,
                sessionId: projId,
                content: fullContent || "",
                model,
                tokensUsed,
                silent: isSilentAppUpdate(),
              });
            } catch (finalizeErr) {
              console.error("Failed to finalize stream on error:", finalizeErr);
            }
          }
          if (!usageRecorded) {
            usageRecorded = true;
            await recordUsage(ctx, {
              source: tutorUsageSource,
              role: tutorUsageRole,
              institutionId: tutorInstitutionId,
              model: model || selectedTutorModel,
              usage: tutorUsage,
              sessionId: projId,
              cacheMissAt: tutorCacheDiagnostics.cacheMissAt,
              responseId: tutorCacheDiagnostics.lastResponseId,
            });
          }
          if (!cancelled) {
            enqueue(
              encoder.encode(
                sseEvent({ error: "Stream error" })
              )
            );
          }
          // A code tool that SUCCEEDED before this error must still leave a
          // revision + autosave (G4). Idempotent with the normal path, so a
          // late error after that path already recorded is a no-op here.
          // Never throws, so the lease release + stream close below always run.
          await ctx.runAction(
            internal.vibecodeStarterActions.recordWorkshopTurn,
            {
              sessionId: projId,
              messageId: assistantMsgId as Id<"messages">,
              callerUserId: session.scholarId,
              // TRA-519: any session with an app, or one whose create_code ran
              // this turn, records its app versions.
              appBuild:
                session.appContext.builderFeatures || createdCodeArtifact,
              workshopMode,
              ...(turnAppBaseline
                ? { baselineArtifactId: turnAppBaseline.artifactId }
                : {}),
              baselineRevision: turnAppBaseline?.revision ?? -1,
              ...(session.focusAppId
                ? { focusArtifactId: session.focusAppId }
                : {}),
            },
          );
          await releaseLeaseBeforeClosingStream({
            release: tutorLease.release,
            close: () => {
              if (!cancelled) controller.close();
            },
          });
        } finally {
          clearInterval(streamHeartbeat);
          await tutorLease.release();
        }
      },
      async cancel() {
        cancelled = true;
        // Only a quiet app update is cut off here. Any other turn finishes
        // generating and finalizes, so the reply is whole when the scholar
        // comes back (TRA-501; proven live: the action keeps running after
        // Convex logs "Client disconnected"). That turn still holds its LLM
        // lease, so it is released by start() — before the stream closes and
        // in its finally — never here, or a disconnect would let the scholar
        // start a second concurrent model call past the TRA-98 cap.
        if (isAppUpdate) {
          activeMessageStream?.abort();
          await tutorLease.release();
        }
        // A disconnect can end this action before start() finalizes, which
        // would strand a quiet app update's empty placeholder. Best effort;
        // the next turn's reap is the backstop.
        if (isAppUpdate) {
          try {
            await ctx.runMutation(
              internal.sessionHelpers.discardEmptyAppUpdatePlaceholder,
              { messageId: assistantMsgId as Id<"messages"> },
            );
          } catch (error) {
            console.error(
              "[project-stream] quiet placeholder discard failed:",
              error,
            );
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      },
    });
  });

http.route({
  path: "/session-stream",
  method: "POST",
  handler: sessionStreamHandler,
});

const sessionStreamCorsHandler = httpAction(async () => {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
});

// CORS preflight for session-stream
http.route({
  path: "/session-stream",
  method: "OPTIONS",
  handler: sessionStreamCorsHandler,
});

// ── ⑫ Socratic handoff: the "Talk it through" scratch session ───────────────
// A kid who missed the SAME practice item twice taps "Talk it through". The
// tutor (companion direction — see convex/lib/practice/handoff.ts) is a warm
// thinking partner: it gets ONLY the task + their own tries (re-derived
// server-side from the item id), and the correct answer never enters the prompt.
// Works for BOTH a template item (stem + wrong answers) and a MANIPULATIVE item
// (its no-leak concept/prompt/task + a description of the board the kid built —
// U-4); a manipulative has no answer string at all, so there is nothing to leak.
// A game "Stuck?" opens the same coach with server-derived round evidence as
// grounding: its session id is authorized against the caller, and the client
// cannot forge evidence.
// We deliberately do NOT redact a reply that states a step the kid reasoned to:
// it's intended, and it's a mastery no-op (the chat is ungraded; fluency is
// earned later on a fresh variant). The transcript IS persisted (for
// RETROSPECTIVE weekly quality judging — the replacement for the removed runtime
// leak backstop), keyed by a server-side hash with no scholarId. See
// convex/handoffTranscripts.ts + the qualityPulseSamples `surface:"handoff"` path.
http.route({
  path: "/practice-image-upload",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const CORS = {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json",
    };
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: CORS });
    const callerId = await getAuthUserId(ctx);
    if (!callerId) return json({ error: "Not authenticated" }, 401);
    if (await isReadOnlyCaller(ctx)) return json({ error: READ_ONLY_ACCOUNT_ERROR }, 403);

    const url = new URL(request.url);
    const scholarId = url.searchParams.get("scholarId") as Id<"users"> | null;
    const itemId = url.searchParams.get("itemId")?.trim() ?? "";
    const rawSource = url.searchParams.get("source");
    const source =
      rawSource === "hint" ||
      rawSource === "miss" ||
      rawSource === "handoff" ||
      rawSource === "dialogue"
        ? rawSource
        : null;
    if (!scholarId || !itemId || !source) {
      return json({ error: "Missing practice image context" }, 400);
    }

    try {
      await ctx.runQuery(internal.practiceWorkImages.authorizeUpload, {
        callerId,
        scholarId,
      });
    } catch {
      return json({ error: "Forbidden" }, 403);
    }

    const contentType = request.headers.get("content-type")?.split(";")[0] ?? "";
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(contentType)) {
      return json({ error: "Unsupported image type" }, 415);
    }
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024) {
      return json({ error: "Image must be between 1 byte and 8 MB" }, 413);
    }

    const storageId = await ctx.storage.store(
      new Blob([bytes], { type: contentType }),
    );
    try {
      await ctx.runMutation(internal.practiceWorkImages.recordOwnedImage, {
        scholarId,
        itemId,
        storageId,
        source,
      });
    } catch (error) {
      await ctx.storage.delete(storageId);
      throw error;
    }
    return json({ storageId });
  }),
});
http.route({
  path: "/practice-image-upload",
  method: "OPTIONS",
  handler: httpAction(async () =>
    new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    }),
  ),
});
http.route({
  path: "/practice-handoff",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const CORS = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
    const json = (
      b: unknown,
      status = 200,
      extraHeaders: Record<string, string> = {},
    ) =>
      new Response(JSON.stringify(b), {
        status,
        headers: { ...CORS, ...extraHeaders },
      });

    const callerUserId = await getAuthUserId(ctx);
    if (!callerUserId) return json({ error: "Not authenticated" }, 401);
    if (await isReadOnlyCaller(ctx)) return json({ error: READ_ONLY_ACCOUNT_ERROR }, 403);
    // Template and manipulative handoffs are auth-gated but not bound to a
    // scholarId: their context is derived from an item id, not per-scholar data.
    // Game handoffs ARE bound below because their round evidence belongs to the
    // session's scholar. No correct answer is ever computed or returned.

    let body: {
      itemId?: unknown;
      gameSessionId?: unknown;
      wrongAnswers?: unknown;
      messages?: unknown;
      imageId?: unknown;
      scholarId?: unknown;
      entryMode?: unknown;
    };
    try {
      body = await request.json();
    } catch {
      return json({ error: "Bad request" }, 400);
    }
    const itemId = typeof body.itemId === "string" ? body.itemId : "";
    const gameSessionId =
      typeof body.gameSessionId === "string" ? body.gameSessionId.trim() : "";
    const scholarId =
      typeof body.scholarId === "string" ? body.scholarId : "";
    // The game path's mode is a server-known fact, not a client claim.
    const entryMode = gameSessionId
      ? ("game" as const)
      : body.entryMode === "stuck" ||
          body.entryMode === "spiral" ||
          body.entryMode === "ladder"
        ? body.entryMode
        : undefined;
    // Optional scratchpad: a storage id for a PNG the scholar drew of their own
    // work on this problem. It's the kid's thinking (answer-safe), so we let the
    // tutor SEE it — attached to their latest turn below.
    const scratchImageId = typeof body.imageId === "string" ? body.imageId : "";
    // Image-ownership subject: when the client names a scholar (teacher-driven
    // flows), ownership binds to that scholar; otherwise the caller drives
    // themselves and owns their own captures. Distinct from `scholarId` above,
    // whose empty default deliberately gates the coach-context attach.
    const imageOwnerScholarId: Id<"users"> =
      scholarId !== "" ? (scholarId as Id<"users">) : callerUserId;
    const wrongAnswers = Array.isArray(body.wrongAnswers)
      ? body.wrongAnswers.filter((a): a is string => typeof a === "string")
      : [];
    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter(
        (m): m is { role: "user" | "assistant"; content: string } =>
          !!m &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string",
      )
      .map((m) => ({ role: m.role, content: m.content }));

    // A game path resolves ONLY the authorized session's server-owned event log.
    // Otherwise re-derive the item server-side from the itemId. Two item kinds:
    //   • TEMPLATE (skillKey#seed) → deriveHandoffItem gives the {stem, skillKey}.
    //   • MANIPULATIVE (gen#<id>)  → manipulativeHandoffContext resolves the row's
    //     spec to a no-leak {concept, prompt, task, boardState} (U-4). A
    //     manipulative has NO answer to compute or leak — the goal IS the visible
    //     task — so, like the template path, nothing here ever puts an answer in
    //     the prompt, the reply, or the log. For a manipulative the kid's
    //     `wrongAnswers` are their submitted board STATES (opaque JSON); we ground
    //     the opener in the most recent one via describeState, never dumping raw
    //     JSON into the prompt. Whether the tutor over-helps is judged
    //     retrospectively by the weekly quality pulse.
    // A malformed session id fails the internal query's arg validator; treat
    // that exactly like an unauthorized one (the clean 400 below), not a 500.
    const game = gameSessionId
      ? await ctx
          .runQuery(internal.games.handoffContext, {
            sessionId: gameSessionId as Id<"gameSessions">,
            callerUserId,
          })
          .catch(() => null)
      : null;
    const item = gameSessionId ? null : deriveHandoffItem(itemId);
    const manip = gameSessionId || item
      ? null
      : await ctx.runQuery(internal.practiceSkills.manipulativeHandoffContext, {
          itemId,
          // The most-recent submitted board is the last wrong "answer" (a stateJson).
          ...(wrongAnswers.length > 0 ? { stateJson: wrongAnswers[wrongAnswers.length - 1] } : {}),
        });
    if (!game && !item && !manip) {
      return json({ error: "This one can't be talked through — try another." }, 400);
    }
    const handoffScholarId =
      game || !scholarId ? callerUserId : (scholarId as Id<"users">);
    const handoffInstitutionId = await ctx.runQuery(
      internal.usage.resolveInstitution,
      { userId: handoffScholarId, principal: "scholar" },
    );
    let scholarContext: ScholarCoachContext | undefined = entryMode
      ? { entryMode }
      : undefined;
    if (scholarId) {
      try {
        scholarContext = await ctx.runQuery(
          internal.practiceSkills.scholarCoachContext,
          {
            callerUserId,
            scholarId: scholarId as Id<"users">,
            // Games have no single skill; the resolver's skillKey is optional.
            ...(manip
              ? { skillKey: manip.skillKey }
              : item
                ? { skillKey: item.skillKey }
                : {}),
            entryMode: entryMode as HandoffEntryMode | undefined,
            now: Date.now(),
          },
        );
      } catch {
        return json({ error: "Forbidden" }, 403);
      }
    }

    // Turn cap (roadmap §8: 2–4 turns, then hand back to a fresh variant). At the
    // cap, wrap up without another model call.
    const assistantTurns = messages.filter((m) => m.role === "assistant").length;
    if (assistantTurns >= HANDOFF_MAX_ASSISTANT_TURNS) {
      return json({ reply: "Nice thinking that through — give it another go →", ended: true });
    }
    if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
      return json({ error: "Tell me what you're thinking and we'll dig in." }, 400);
    }

    // This reply is the LAST one before the turn cap closes the composer, so the
    // tutor must land the plane (wrap up, no new question) rather than ask
    // something the kid has no way to answer. Same formula as the `ended` flag
    // returned below — they must agree, or the model asks a question the UI has
    // already hidden the reply box for.
    const isFinalTurn = assistantTurns + 1 >= HANDOFF_MAX_ASSISTANT_TURNS;

    // The tutor gets only server-derived grounding — same-round evidence for a
    // game, the task + the kid's own tries for a practice item — never a
    // correct answer. All three builders share the coach context.
    const system = game
      ? buildGameHandoffPrompt(game, scholarContext)
      : manip
        ? buildManipulativeHandoffPrompt(
          {
            concept: manip.concept,
            prompt: manip.prompt,
            task: manip.task,
            ...(manip.boardState ? { boardState: manip.boardState } : {}),
            wrongAttemptCount: wrongAnswers.length,
          },
          scholarContext,
          { finalTurn: isFinalTurn },
        )
        : buildHandoffPrompt(
            { stem: item!.stem, wrongAnswers },
            entryMode,
            scholarContext,
            { finalTurn: isFinalTurn },
          );

    // If the scholar drew their work on the scratchpad, attach that PNG to their
    // latest turn (image block via the shared builder) so the tutor reasons about
    // what they ACTUALLY wrote — same no-answer-reveal posture. Text-only fallback
    // if the image can't be loaded.
    let systemPrompt = system;
    let modelMessages: { role: "user" | "assistant"; content: string | (ImageContentPart | { type: "text"; text: string })[] }[] =
      messages;
    if (scratchImageId && !game) {
      let imageOwned = false;
      try {
        const ownership = await ctx.runQuery(
          internal.practiceWorkImages.ownedImage,
          {
            callerId: callerUserId,
            scholarId: imageOwnerScholarId,
            itemId,
            storageId: scratchImageId as Id<"_storage">,
          },
        );
        imageOwned = ownership.owned;
      } catch {
        imageOwned = false;
      }
      if (!imageOwned) {
        return json({ error: "That image does not belong to this practice item." }, 403);
      }
      const imageUrl = await ctx.runQuery(internal.files.getUrlInternal, {
        storageId: scratchImageId as Id<"_storage">,
      });
      const imagePart = imageUrl ? await imageUrlToContentPart(imageUrl) : null;
      if (imagePart) {
        modelMessages = attachScratchImageToLastTurn(messages, imagePart);
        systemPrompt += SCRATCH_IMAGE_SYSTEM_NOTE;
      }
    }

    const handoffLease = await acquireLlmLease(ctx, {
      userId: callerUserId,
      surface: "practice-handoff",
      ...(handoffInstitutionId ? { institutionId: handoffInstitutionId } : {}),
    });
    if (!handoffLease.ok) {
      return json(
        { error: LLM_BUSY_MESSAGE },
        429,
        { "Retry-After": String(handoffLease.retryAfterSec) },
      );
    }

    let reply: string;
    try {
      const { Anthropic } = await import("@anthropic-ai/sdk");
      const anthropic = new Anthropic({ apiKey: requireAnthropicApiKey() });
      const resp = await anthropic.messages.create({
        model: MODELS.SONNET,
        max_tokens: 400,
        system: systemPrompt,
        messages: modelMessages,
      });
      await recordAnthropicUsage(ctx, {
        source: "practice-handoff",
        role: ROLES.SCHOLAR,
        institutionId: handoffInstitutionId,
        model: MODELS.SONNET,
        usage: resp.usage,
      });
      reply = sanitizeScholarVisibleText(
        resp.content
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("")
          .trim(),
        scholarSafeDropReporter(ctx, "practice-handoff"),
      );
    } catch (e) {
      console.error("handoff model error:", e);
      return json({ error: "Something hiccuped — give it another go →", ended: true });
    } finally {
      await handoffLease.release();
    }

    // No answer-leak redaction (companion direction): a confirmation the kid
    // earned is intended, and it's a mastery no-op anyway. Only guard a
    // degenerate empty reply with a neutral nudge.
    if (!reply) {
      reply = HANDOFF_EMPTY_FALLBACK;
    }

    // Persist the running transcript for RETROSPECTIVE quality judging (the
    // weekly Quality Pulse) — this is the agreed safety net that replaced the
    // removed runtime answer-leak backstop. Best-effort + backend-only: keyed by
    // a server-derived hash (no scholarId is ever stored), UPSERTED each turn so
    // the growing chat is one row (partials included), and wrapped so a capture
    // failure never breaks the kid's chat. See convex/handoffTranscripts.ts.
    try {
      const firstUserMessage =
        messages.find((m) => m.role === "user")?.content ?? "";
      // Dedup hashes the round's session id (per-round dedup, and the hash is
      // one-way); the STORED itemId for a game is `game#<gameId>` — the
      // handoffTranscripts table is anonymous by design, and a stored
      // gameSessions row id would be a join path back to the scholar.
      const dedupKey = handoffDedupKey(
        callerUserId,
        gameSessionId || itemId,
        firstUserMessage,
      );
      const transcriptItemId = game ? `game#${game.gameId}` : itemId;
      await ctx.runMutation(internal.handoffTranscripts.recordHandoffTranscript, {
        dedupKey,
        itemId: transcriptItemId,
        skillKey: game ? "game" : manip ? manip.skillKey : item!.skillKey,
        // The persisted "stem" is a human-readable anchor for the retrospective
        // judge — the game title, template stem, or manipulative task restatement.
        stem: game ? game.gameTitle : manip ? manip.task : item!.stem,
        wrongAnswers,
        promptVersion: game
          ? GAME_HANDOFF_PROMPT_VERSION
          : manip
            ? MANIPULATIVE_HANDOFF_PROMPT_VERSION
            : HANDOFF_PROMPT_VERSION,
        transcript: [...messages, { role: "assistant" as const, content: reply }],
      });
    } catch (e) {
      console.error("handoff transcript persist failed (non-fatal):", e);
    }

    const ended = isFinalTurn;
    return json({ reply, ended });
  }),
});
http.route({
  path: "/practice-handoff",
  method: "OPTIONS",
  handler: httpAction(async () =>
    new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    }),
  ),
});

// ── Stretch DIALOGUE — the rubric'd-chat stretch vessel ─────────────────────
// (review/beast-academy-lessons.html §8.) Same message-array protocol as
// /practice-handoff, plus a "grade" phase: the scholar talks the insight
// through, then taps "Check my thinking"; an LLM judge grades the transcript
// against the item's SERVER-ONLY rubric and a pass writes the stretch_dialogue
// depth observation (convex/practiceDialogue.ts). The tutor prompt here is the
// handoff's INVERSE: this chat IS the evidence, so the insight is withheld —
// see lib/practice/dialogueStretch.ts.
http.route({
  path: "/practice-dialogue",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const CORS = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
    const json = (
      b: unknown,
      status = 200,
      extraHeaders: Record<string, string> = {},
    ) =>
      new Response(JSON.stringify(b), {
        status,
        headers: { ...CORS, ...extraHeaders },
      });

    const callerUserId = await getAuthUserId(ctx);
    if (!callerUserId) return json({ error: "Not authenticated" }, 401);
    if (await isReadOnlyCaller(ctx)) return json({ error: READ_ONLY_ACCOUNT_ERROR }, 403);

    let body: {
      itemId?: unknown;
      message?: unknown;
      phase?: unknown;
      sessionToken?: unknown;
      imageId?: unknown;
      scholarId?: unknown;
    };
    try {
      body = await request.json();
    } catch {
      return json({ error: "Bad request" }, 400);
    }
    const itemId = typeof body.itemId === "string" ? body.itemId : "";
    // Optional scratchpad photo of the scholar's own work on this problem — the
    // kid's thinking (answer-safe), attached to their latest turn for the tutor
    // to SEE. Mirrors /practice-handoff; only used in the "chat" phase below.
    const scratchImageId = typeof body.imageId === "string" ? body.imageId : "";
    const scholarId =
      typeof body.scholarId === "string"
        ? (body.scholarId as Id<"users">)
        : callerUserId;
    const phase =
      body.phase === "start" ? "start" : body.phase === "grade" ? "grade" : "chat";

    // Resolve the dialogue item server-side. The rubric NEVER leaves the server.
    const item = await ctx.runQuery(internal.practiceDialogue.dialogueContext, { itemId });
    if (!item) return json({ error: "This one can't be talked through — try another." }, 400);
    const dialogueInstitutionId = await ctx.runQuery(
      internal.usage.resolveInstitution,
      { userId: scholarId, principal: "scholar" },
    );

    if (phase === "start") {
      const sessionToken = crypto.randomUUID();
      const dedupKey = dialogueDedupKey(callerUserId, itemId, sessionToken);
      await ctx.runMutation(internal.practiceDialogue.startDialogueTranscript, {
        dedupKey,
        itemId,
        skillKey: item.skillKey,
        stem: item.stem,
      });
      return json({ sessionToken });
    }

    const sessionToken =
      typeof body.sessionToken === "string" ? body.sessionToken : "";
    if (!sessionToken) return json({ error: "Start this dialogue again." }, 400);
    const dedupKey = dialogueDedupKey(callerUserId, itemId, sessionToken);
    const grounded = await ctx.runQuery(internal.practiceDialogue.dialogueTranscript, {
      dedupKey,
      itemId,
    });
    if (!grounded) return json({ error: "Start this dialogue again." }, 400);
    const messages = grounded.transcript;

    if (phase === "grade") {
      if (!messages.some((m) => m.role === "user")) {
        return json({ error: "Say your idea first — then I can check it." }, 400);
      }
      const dialogueLease = await acquireLlmLease(ctx, {
        userId: callerUserId,
        surface: "practice-dialogue",
        ...(dialogueInstitutionId
          ? { institutionId: dialogueInstitutionId }
          : {}),
      });
      if (!dialogueLease.ok) {
        return json(
          { error: LLM_BUSY_MESSAGE },
          429,
          { "Retry-After": String(dialogueLease.retryAfterSec) },
        );
      }
      try {
        const { Anthropic } = await import("@anthropic-ai/sdk");
        const anthropic = new Anthropic({ apiKey: requireAnthropicApiKey() });
        const resp = await anthropic.messages.create({
          model: MODELS.SONNET,
          max_tokens: 700,
          system: DIALOGUE_JUDGE_SYSTEM,
          tools: [DIALOGUE_JUDGE_TOOL],
          tool_choice: { type: "tool", name: DIALOGUE_JUDGE_TOOL.name },
          messages: [
            {
              role: "user",
              content: buildDialogueJudgeUser({
                stem: item.stem,
                rubricCriteria: item.rubricCriteria,
                transcript: messages,
              }),
            },
          ],
        });
        await recordAnthropicUsage(ctx, {
          source: "practice-dialogue-judge",
          role: ROLES.SCHOLAR,
          institutionId: dialogueInstitutionId,
          model: MODELS.SONNET,
          usage: resp.usage,
        });
        const toolUse = resp.content.find((b) => b.type === "tool_use");
        const verdict = parseDialogueVerdict(
          toolUse && toolUse.type === "tool_use" ? toolUse.input : undefined,
          item.rubricCriteria.length,
        );
        // Record for the CALLER only, and only when the caller is a scholar —
        // a teacher rehearsing gets the verdict with no learning-record write.
        const caller = await ctx.runQuery(internal.users.getByIdInternal, { id: callerUserId });
        let observationWritten = false;
        if (caller?.role === ROLES.SCHOLAR) {
          const rec = await ctx.runMutation(internal.practiceDialogue.recordDialogueOutcome, {
            dedupKey,
            scholarId: callerUserId,
            itemId,
            skillKey: item.skillKey,
            skillLabel: item.skillLabel,
            domain: item.domain,
            ...(item.bloomLevel !== undefined ? { bloomLevel: item.bloomLevel } : {}),
            ...(item.technique !== undefined ? { technique: item.technique } : {}),
            passed: verdict.passed,
            metCount: verdict.metCount,
            total: verdict.total,
            note: verdict.note,
            bestQuote: verdict.bestQuote,
          });
          observationWritten = rec.observationWritten;
        } else {
          await ctx.runMutation(internal.practiceDialogue.completeDialogueTranscript, {
            dedupKey,
            itemId,
          });
        }
        return json({
          passed: verdict.passed,
          metCount: verdict.metCount,
          total: verdict.total,
          observationWritten,
        });
      } catch (e) {
        console.error("dialogue judge error:", e);
        return json({ error: "The check hiccuped — try again in a moment." }, 500);
      } finally {
        await dialogueLease.release();
      }
    }

    // ── chat phase ──
    const message =
      typeof body.message === "string" ? body.message.trim().slice(0, 4_000) : "";
    if (!message) {
      return json({ error: "Tell me what you notice and we'll dig in." }, 400);
    }
    const assistantTurns = messages.filter((m) => m.role === "assistant").length;
    if (assistantTurns >= DIALOGUE_MAX_ASSISTANT_TURNS) {
      const reply = "You've done the thinking — tap \"Check my thinking\" and let's see it.";
      try {
        await ctx.runMutation(internal.practiceDialogue.appendDialogueTurn, {
          dedupKey,
          itemId,
          turn: { role: "user", content: message },
        });
      } catch (e) {
        console.error("dialogue scholar turn persist failed:", e);
        return json({ error: "That turn didn't save — try it once more." }, 409);
      }
      await ctx.runMutation(internal.practiceDialogue.appendDialogueTurn, {
        dedupKey,
        itemId,
        turn: { role: "assistant", content: reply },
      });
      return json({
        reply,
        ended: true,
      });
    }

    const dialogueLease = await acquireLlmLease(ctx, {
      userId: callerUserId,
      surface: "practice-dialogue",
      ...(dialogueInstitutionId
        ? { institutionId: dialogueInstitutionId }
        : {}),
    });
    if (!dialogueLease.ok) {
      return json(
        { error: LLM_BUSY_MESSAGE },
        429,
        { "Retry-After": String(dialogueLease.retryAfterSec) },
      );
    }

    try {
      let chatMessages: { role: "user" | "assistant"; content: string }[];
      try {
        const appended = await ctx.runMutation(
          internal.practiceDialogue.appendDialogueTurn,
          {
            dedupKey,
            itemId,
            turn: { role: "user", content: message },
          },
        );
        chatMessages = appended.transcript;
      } catch (e) {
        console.error("dialogue scholar turn persist failed:", e);
        return json({ error: "That turn didn't save — try it once more." }, 409);
      }

      // Attach the scholar's scratchpad photo (if any) to their latest turn so
      // the tutor reasons about what they actually wrote — same shared builder +
      // answer-safe note as /practice-handoff. Text-only fallback on load failure.
      let dialogueSystem = buildStretchDialoguePrompt({
        stem: item.stem,
        ...(item.technique !== undefined ? { technique: item.technique } : {}),
      });
      let modelMessages: {
        role: "user" | "assistant";
        content: string | (ImageContentPart | { type: "text"; text: string })[];
      }[] = chatMessages;
      if (scratchImageId) {
        let imageOwned = false;
        try {
          const ownership = await ctx.runQuery(
            internal.practiceWorkImages.ownedImage,
            {
              callerId: callerUserId,
              scholarId,
              itemId,
              storageId: scratchImageId as Id<"_storage">,
            },
          );
          imageOwned = ownership.owned;
        } catch {
          imageOwned = false;
        }
        if (!imageOwned) {
          return json(
            { error: "That image does not belong to this practice item." },
            403,
          );
        }
        const imageUrl = await ctx.runQuery(internal.files.getUrlInternal, {
          storageId: scratchImageId as Id<"_storage">,
        });
        const imagePart = imageUrl ? await imageUrlToContentPart(imageUrl) : null;
        if (imagePart) {
          modelMessages = attachScratchImageToLastTurn(chatMessages, imagePart);
          dialogueSystem += SCRATCH_IMAGE_SYSTEM_NOTE;
        }
      }
      const { Anthropic } = await import("@anthropic-ai/sdk");
      const anthropic = new Anthropic({ apiKey: requireAnthropicApiKey() });
      const resp = await anthropic.messages.create({
        model: MODELS.SONNET,
        max_tokens: 350,
        system: dialogueSystem,
        messages: modelMessages,
      });
      await recordAnthropicUsage(ctx, {
        source: "practice-dialogue",
        role: ROLES.SCHOLAR,
        institutionId: dialogueInstitutionId,
        model: MODELS.SONNET,
        usage: resp.usage,
      });
      const reply = sanitizeScholarVisibleText(
        resp.content
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("")
          .trim(),
        scholarSafeDropReporter(ctx, "practice-dialogue"),
      );
      const visibleReply = reply || "Keep going — what happens next?";
      await ctx.runMutation(internal.practiceDialogue.appendDialogueTurn, {
        dedupKey,
        itemId,
        turn: { role: "assistant", content: visibleReply },
      });
      const ended = assistantTurns + 1 >= DIALOGUE_MAX_ASSISTANT_TURNS;
      return json({ reply: visibleReply, ended });
    } catch (e) {
      console.error("dialogue model error:", e);
      const reply = "I hit a snag there — say that thought once more.";
      try {
        await ctx.runMutation(internal.practiceDialogue.appendDialogueTurn, {
          dedupKey,
          itemId,
          turn: { role: "assistant", content: reply },
        });
      } catch (persistError) {
        console.error("dialogue error turn persist failed:", persistError);
      }
      return json({ reply, error: "Something hiccuped — give it another go →", ended: false }, 500);
    } finally {
      await dialogueLease.release();
    }
  }),
});
http.route({
  path: "/practice-dialogue",
  method: "OPTIONS",
  handler: httpAction(async () =>
    new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    }),
  ),
});

// ── Moments: /story-open — the Socratic conversation behind a world-connection story ──
// A scholar hits a fluency moment; a story card serves a verified world-connection
// story (`knowledgeNodeEdges.story`) with an "Ask the tutor why" action. This
// endpoint backs that action: a short, wonder-opening Socratic chat grounded ONLY
// in the story (prompt: convex/lib/practice/storyOpen.ts). Sibling of
// /practice-handoff — same message-array protocol, a per-turn turn cap (6, roomier
// than the handoff's 4 because this is open exploration, not un-stucking), and a
// non-fatal ANONYMOUS transcript capture (`tutorTranscripts`, no scholarId) for
// retrospective quality judging — but STREAMED (SSE), since it's a conversation the
// kid watches unfold. Server-authoritative: the client sends {scholarId, fromKey,
// toKey, messages}; the server auth-gates (self / teacher), loads the edge story by
// keys SERVER-SIDE (404 if the edge carries no story), builds the prompt, and never
// trusts client-supplied story text. The scholarId is used ONLY for the auth gate —
// no per-scholar data enters the prompt (a structural redaction boundary). Model =
// MODELS.SONNET.
http.route({
  path: "/story-open",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const CORS = { "Access-Control-Allow-Origin": "*" };
    const jsonErr = (b: unknown, status: number) =>
      new Response(JSON.stringify(b), {
        status,
        headers: { ...CORS, "Content-Type": "application/json" },
      });

    const callerUserId = await getAuthUserId(ctx);
    if (!callerUserId) return jsonErr({ error: "Not authenticated" }, 401);
    if (await isReadOnlyCaller(ctx)) return jsonErr({ error: READ_ONLY_ACCOUNT_ERROR }, 403);

    let body: { scholarId?: unknown; fromKey?: unknown; toKey?: unknown; messages?: unknown };
    try {
      body = await request.json();
    } catch {
      return jsonErr({ error: "Bad request" }, 400);
    }
    const scholarId = typeof body.scholarId === "string" ? (body.scholarId as Id<"users">) : null;
    const fromKey = typeof body.fromKey === "string" ? body.fromKey : "";
    const toKey = typeof body.toKey === "string" ? body.toKey : "";
    if (!scholarId || !fromKey || !toKey) return jsonErr({ error: "Bad request" }, 400);

    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .filter(
        (m): m is { role: "user" | "assistant"; content: string } =>
          !!m &&
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string",
      )
      .map((m) => ({ role: m.role, content: m.content }));

    // Resolve server-side: auth gate (self/teacher) + edge-story load by keys +
    // plain labels + reading level. A gate failure throws → 403; a story-less edge
    // → null → 404 (there is nothing to talk about).
    let packet: StoryOpenPacket | null;
    try {
      packet = await ctx.runQuery(internal.edgeStories.storyOpenContext, {
        callerUserId,
        scholarId,
        fromKey,
        toKey,
      });
    } catch {
      return jsonErr({ error: "Forbidden" }, 403);
    }
    if (!packet) return jsonErr({ error: "No story for this connection." }, 404);
    const storyPacket = packet;
    const storyInstitutionId = await ctx.runQuery(
      internal.usage.resolveInstitution,
      { userId: scholarId, principal: "scholar" },
    );

    const headers = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    };
    const encoder = new TextEncoder();

    // Turn cap (roomier than the handoff's — this is exploration). At the cap, hand
    // the door back with a warm close, no model call.
    const { assistantTurns, atCap } = storyOpenTurnState(messages);
    if (atCap) {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(sseEvent({ text: STORY_OPEN_CLOSE })));
            controller.enqueue(encoder.encode(sseEvent({ done: true, ended: true })));
            controller.close();
          },
        }),
        { headers },
      );
    }

    // The client always sends the kid's turn last; a malformed array is a client bug.
    if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
      return jsonErr({ error: "Tell me what you're wondering and we'll dig in." }, 400);
    }

    const system = buildStoryOpenPrompt(storyPacket);

    const storyLease = await acquireLlmLease(ctx, {
      userId: callerUserId,
      surface: "story-open",
      ...(storyInstitutionId ? { institutionId: storyInstitutionId } : {}),
    });
    if (!storyLease.ok) {
      return new Response(sseEvent({ error: LLM_BUSY_MESSAGE }), {
        status: 429,
        headers: {
          ...headers,
          // Expose Retry-After cross-origin so the browser client can read it
          // (the SSE 200 headers above set ACAO but not the expose list).
          "Access-Control-Expose-Headers": "Retry-After",
          "Retry-After": String(storyLease.retryAfterSec),
        },
      });
    }

    const stream = new ReadableStream({
      async start(controller) {
        let full = "";
        const safeText = createScholarVisibleTextFilter(
          scholarSafeDropReporter(ctx, "story-open"),
        );
        try {
          const { Anthropic } = await import("@anthropic-ai/sdk");
          const anthropic = new Anthropic({ apiKey: requireAnthropicApiKey() });
          const modelStream = anthropic.messages.stream({
            model: MODELS.SONNET,
            max_tokens: STORY_OPEN_MAX_TOKENS,
            system,
            messages,
          });
          for await (const event of modelStream) {
            if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta" &&
              event.delta.text
            ) {
              const safeDelta = safeText.push(event.delta.text);
              if (!safeDelta) continue;
              full += safeDelta;
              controller.enqueue(encoder.encode(sseEvent({ text: safeDelta })));
            }
          }
          const finalMsg = await modelStream.finalMessage();
          await recordAnthropicUsage(ctx, {
            source: "story-open",
            role: ROLES.SCHOLAR,
            institutionId: storyInstitutionId,
            model: MODELS.SONNET,
            usage: finalMsg.usage,
          });
          const tail = safeText.finish();
          if (tail) {
            full += tail;
            controller.enqueue(encoder.encode(sseEvent({ text: tail })));
          }
          full = full.trim();
          if (!full) {
            // Degenerate empty reply — keep the door open without inventing anything.
            full = STORY_OPEN_EMPTY_FALLBACK;
            controller.enqueue(encoder.encode(sseEvent({ text: full })));
          }

          const ended = storyOpenEndsAfterReply(assistantTurns);

          // Persist the running transcript for RETROSPECTIVE quality judging.
          // Best-effort + backend-only: keyed by a server-derived hash (no
          // scholarId is ever stored), UPSERTED each turn so the growing chat is
          // one row, and wrapped so a capture failure never breaks the kid's chat.
          // See convex/tutorTranscripts.ts.
          try {
            const firstUserMessage = messages.find((m) => m.role === "user")?.content ?? "";
            const dedupKey = storyOpenDedupKey(callerUserId, fromKey, toKey, firstUserMessage);
            await ctx.runMutation(internal.tutorTranscripts.recordTutorTranscript, {
              surface: "storyOpen",
              anchor: {
                kind: "storyOpen",
                fromKey,
                toKey,
                hook: storyPacket.hook,
              },
              dedupKey,
              promptVersion: STORY_OPEN_PROMPT_VERSION,
              transcript: [...messages, { role: "assistant" as const, content: full }],
            });
          } catch (e) {
            console.error("story-open transcript persist failed (non-fatal):", e);
          }

          controller.enqueue(encoder.encode(sseEvent({ done: true, ended })));
          await releaseLeaseBeforeClosingStream({
            release: storyLease.release,
            close: () => controller.close(),
          });
        } catch (e) {
          console.error("story-open model error:", e);
          // The client degrades gracefully on an error event.
          controller.enqueue(encoder.encode(sseEvent({ error: "story-open-failed" })));
          await releaseLeaseBeforeClosingStream({
            release: storyLease.release,
            close: () => controller.close(),
          });
        } finally {
          await storyLease.release();
        }
      },
      async cancel() {
        await storyLease.release();
      },
    });
    return new Response(stream, { headers });
  }),
});
http.route({
  path: "/story-open",
  method: "OPTIONS",
  handler: httpAction(async () =>
    new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    }),
  ),
});

// ── Curriculum Assistant streaming endpoint ─────────────────────────────────

// NOTE: the in-app aide is always one-to-one today, so the audience below is
// hardcoded `private`. When in-app group threads ship, make it a parameter —
// the doctrine it pairs with is already here, so that day is a one-line change
// rather than a rediscovery of the disclosure rules (see lib/aideAudience.ts).
export const buildCurriculumAssistantSystemPrompt = (
  profile: InstitutionPromptProfile = DEFAULT_INSTITUTION_PROMPT_PROFILE,
): string => `You are a curriculum design assistant for teachers at ${profile.schoolName}, a gifted elementary school${
  profile.observerLocation ? ` in ${profile.observerLocation}` : ""
}.

Your job: help teachers design, adapt, and differentiate curriculum for their scholars. You have tools to look up scholar profiles, mastery data, learning signals, and existing units.

${SCHOLAR_PRONOUN_GUIDANCE}

Use tools proactively when asked about a specific scholar or when designing curriculum. Always ground suggestions in actual student data.

**Assessing how a scholar (or an activity) is doing — read the real work.** \`get_scholar_sessions\` lists a scholar's sessions with an \`origin\` on each: \`assigned\` (part of a teacher cohort assignment) or \`selfInitiated\` (a Quest — independent study — the scholar chose by following their own curiosity). NEVER call a self-initiated session "assigned"; the \`origin\`/\`originLabel\` fields tell you which it is, so check them before you characterize it. When asked how a session or activity is GOING or PERFORMING, whether a scholar is getting VALUE, or what they're actually exploring, call \`get_session_transcript\` and read the actual conversation — the session list only gives you a title and a 120-char preview, which is not enough to judge depth or engagement. Crucially, assess on the right terms: a self-initiated Quest is NOT graded against an assignment's bar — judge whether the scholar is following genuine curiosity, going deep, struggling productively, and getting real value (${profile.shortName} raises the ceiling; a kid deep in a self-chosen rabbithole is the goal, not a deviation). For assigned work, you can also weigh it against the activity's deliverable + rubric (both returned by the transcript tool). Don't cop out with "there's no formal assignment so I can't assess it" — read the transcript and give a thoughtful, specific read.

When a teacher names a cohort ("make a lesson for the Seals", "how are the Geckos doing?"), call \`list_scholar_groups\` to resolve who is in it, then use the member names with the per-scholar tools. A scholar group is a saved set of scholars, not an assignment — don't say you can't see a group; that tool is how you look them up.

You can \`web_search\` the web when a lesson or answer depends on current events or facts past your training cutoff (e.g. a unit built around a recent discovery, election, or news story). Use it when freshness matters; don't reach for it on evergreen curriculum questions. When a teacher gives you a specific link (an article, a standards page, a resource), use \`web_fetch\` to read that exact page and ground the work in its real content.

${STAFF_SCHOLAR_RECORDS_SECTION}

${GROUNDED_CLAIMS_DOCTRINE}

${AUDIENCE_DISCLOSURE_DOCTRINE}

${MULTI_PARTY_ETIQUETTE}

${audienceContextLine("private")}

**You can ACT on a scholar's record, not just read it — the same things a teacher does on the scholar page.** \`add_scholar_observation\` covers praise/concern/suggestion/intervention plus neutral notes; add the optional Whole Child category tag when the take is about executive function, social-emotional growth, collaboration & character, or passions & quests. \`add_scholar_report\` adds a dated narrative note (also folded into the dossier), \`update_scholar_dossier\` appends a note or replaces the whole thing, \`set_scholar_reading_level\` sets the talk, read and write levels a teacher has decided on, and \`update_scholar_profile\` changes display name / date of birth. When a teacher says a scholar passed the calculator test or asks to give them the calculator license, call \`grant_calculator_license\` directly if the name resolves to exactly one scholar (ask which scholar if it's ambiguous); confirm before \`revoke_calculator_license\` or a \`rerecord\`, since re-recording reprints the card. For account recovery: \`reset_scholar_password\` (returns a one-time PIN), \`reset_scholar_passkeys\`. And \`delete_scholar\` PERMANENTLY removes a scholar and ALL their data. **You are a SCRIBE on the record, not an author.** The observation/report/dossier tools write the TEACHER's words and judgment, in the teacher's voice — only ever record what the teacher tells you to or explicitly approves. NEVER compose, infer, editorialize, or volunteer your OWN observation, report, or dossier note, and never proactively "log what you noticed." Your own read of a scholar is not a teacher observation — it has its own separate observer channel and must never land in this human-authored record. If you think something is worth noting, SUGGEST it to the teacher and let them decide; don't write it yourself. **Confirmation discipline:** for a routine observation the teacher dictated, just do it if their ask is unambiguous; but for anything that touches credentials, identity, or is destructive — password/passkey reset, a dossier REPLACE, a profile rename, and ESPECIALLY delete_scholar — echo back exactly what you're about to do (and to whom) and get an explicit yes first. Never call delete_scholar speculatively.

**Attached files.** A teacher can attach a file to their message with the "+" button (a scanned worksheet, a cognitive assessment PDF, a photo). When they do, you can SEE images and PDFs inline. To file it on a scholar's record: \`upload_scholar_document\` for sensitive adult-facing source material (cognitive/neuropsych assessments → kind "assessment", IEP/504 → "iep", parent emails, written observations) — this kicks an automatic extract→redact→summarize pipeline and lands on the scholar's Documents tab; or \`add_portfolio_item\` for the kid's OWN work (worksheets, drawings, project artifacts). Both use the file attached to the current message. Before filing a sensitive document, confirm the resolved scholar + file name + document kind.

When designing units, include: title, description, system prompt (instructions for the AI tutor), rubric, and target Bloom's level.

To author from scratch in one go: \`create_unit\` → \`create_scholar_lesson\` (give it the unitId you just got) → \`create_scholar_activity\` (give it the lessonId). When you finish, LINK each thing you made using the \`url\` each tool returns — especially the activity, which is what the teacher will actually open and run.

**Which unit tool — \`create_unit\` is the default.** Classroom work, a cohort's arc, a pod/group's unit, "build me a unit on X" — all of that is GENERAL curriculum, so it starts with \`create_unit\`. Swap in \`create_scholar_quest\` at the top of the chain ONLY when the teacher explicitly asks for a Quest (independent study) belonging to ONE named scholar. That tool hands the unit to the scholar as personal property — it is hidden from every other scholar's unit picker, shows up on their Home and on the teacher Quests board as theirs, and mints them a completion badge — so it is the wrong container for anything more than one scholar will do. Neither "I'm looking at this scholar's page" nor "this is for the Seals" is a request for it; a cohort is many scholars, so a per-scholar unit is never the right container for one. Despite the names, \`create_scholar_lesson\` and \`create_scholar_activity\` are NOT scholar-scoped — they fill in whichever unitId you hand them, so the same two steps finish either kind of unit. If you realize you created the wrong kind, say so and fix it with \`delete_empty_unit\` before building on top of it; don't leave the stray unit sitting on a child's Quests board.

**A new unit is unpublished.** What \`create_unit\` makes is visible to teachers only: scholars do not see it in Start a Quest and cannot start it. Assigning it (\`assign_unit\`, or placing it on a schedule) publishes it automatically. If the teacher wants scholars to find it on their own without an assignment, call \`publish_unit\`; tell the teacher which state the unit is in when you hand it back.

**Activity kind.** \`create_scholar_activity\` takes a \`kind\`: \`online\` (default — an AI-tutor session), \`offline\` (a teacher-run classroom task), or \`app\` (an app activity: an online activity with app settings, where the scholar directs an AI builder to make a live web app in the full-screen app builder — its \`systemPrompt\` is the BUILD BRIEF, not a tutor prompt, and the app is its deliverable; \`vibecode\` is the older name). Reach for \`kind:"app"\` whenever the teacher wants scholars to make/build/"vibecode" something interactive — don't default it to a generic online chat. Any online activity's tutor can also build a side app on request, so an app activity is for when the app IS the work.

**On deliverables (READ THIS):** an ONLINE \`create_scholar_activity\` REQUIRES exactly one evaluation shape: a \`deliverable\` when the scholar produces a document/product, OR an \`advanceRubric\` when readiness is demonstrated in conversation with no document. A deliverable's \`criteria\` array is a private quality map for the tutor, NOT a scholar checklist or a completion gate. The AI gives each criterion a "not"/"half"/"full" verdict; a full criterion permanently awards it as scholar-visible flair, with its label and description shown together, while half/not-full verdicts remain private. Advance-rubric all-full still completes the activity. Criteria written only into systemPrompt are decorative — they cannot award flair or complete an advance rubric. Use 3-6 concrete DIMENSIONAL criteria, each with { label, description }.

Make criteria DIMENSIONAL (specificity, length, structure, evidence, voice) — NOT procedural (drafted, revised, published). Procedural lives in the process pipeline, not the rubric. Never write a criterion about spelling, punctuation, capitalization, handwriting or typing unless the activity is explicitly about spelling or typing (scholars may dictate, and dictated work earns full credit). Give each a short label. Be concrete in each description: state what counts as "full" and what triggers "half" or "not". State failure modes explicitly so the private verdict can distinguish them.

${profile.shortName} philosophy: Socratic inquiry, multiple perspectives (makawalu), depth over breadth, follow the child's curiosity.

Be concise and practical. Speak as a colleague.

${formattingGuidance("web")}`;

// ── Unified staff aide stream ───────────────────────────────────────────────
// One endpoint for the global Curriculum Assistant AND the unit-scoped
// Curriculum Bot — they share the same storage layer (curriculumMessages /
// chats, curriculumAssistant.updateStreamContent / finalizeStream) and
// the same staff auth gate. The request is dispatched on `unitId`: present →
// unit-designer scope; absent → global curriculum scope. (The parent aide
// stays a separate endpoint — different table + guardianship security model.)
http.route({
  path: "/aide-stream",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    const { assistantMsgId, sessionId, scholarId, threadLabel, unitId, scope, focusScholarId, focusSwitched, practiceContext } =
      body as {
        streamId: string;
        assistantMsgId: string;
        sessionId?: string;
        // Legacy fields kept for backward compat during transition
        scholarId?: string;
        threadLabel?: string;
        // Unit-designer scope (presence routes to the Curriculum Bot)
        unitId?: string;
        selectedLessonId?: string | null;
        selectedActivityId?: string | null;
        testDriveProjectId?: string | null;
        // Active institution lens (the ?inst= control) from the web client.
        // Present (even "") → scope the scholar-read tools to that lens;
        // absent → unscoped (Slack/MCP/legacy clients). See below.
        scope?: string;
        // Practice-studio focus (Skills-tab dock) — the domain/node the teacher
        // is currently viewing. Label-only, scholar-agnostic; injected into the
        // system prompt so "this node"/"these" resolve without restating.
        practiceContext?: {
          domain?: string | null;
          domainLabel?: string | null;
          nodeKey?: string | null;
          nodeLabel?: string | null;
        } | null;
        // EPHEMERAL "currently viewing" focus — the scholar the teacher is
        // looking at RIGHT NOW in the docked chat. NOT bound to the thread:
        // the same persistent general thread re-contextualizes as the teacher
        // navigates between scholars. Lens-gated below; never trusted for auth.
        focusScholarId?: string;
        // The teacher SWITCHED the focus scholar mid-thread (a different
        // scholar than the previous send). Hardens the focus wording + injects
        // a transcript-only context turn so the model doesn't anchor a bare
        // pronoun to the previously-discussed scholar.
        focusSwitched?: boolean;
      };

    // ── AUTH ──────────────────────────────────────────────────────────
    // Authenticate the caller from the session token; NEVER trust an id
    // from the request body (the old behavior let anyone stream any
    // scholar's data). The aide runs as the authenticated user, and its
    // tools are scoped to that user's role below.
    const callerUserId = await getAuthUserId(ctx);
    if (!callerUserId) {
      return new Response(
        sseEvent({ error: "Not authenticated" }),
        { status: 401, headers: { "Content-Type": "text/event-stream" } }
      );
    }
    if (await isReadOnlyCaller(ctx)) {
      return new Response(
        sseEvent({ error: READ_ONLY_ACCOUNT_ERROR }),
        { status: 403, headers: { "Content-Type": "text/event-stream" } }
      );
    }
    // "Viewing as" another user is read-only app-wide, but getAuthUserId
    // above is the REAL admin, so without this the aide would act with the
    // admin's tools behind the viewed user's screen.
    if (await ctx.runQuery(internal.users.isSessionImpersonating, {})) {
      return new Response(
        sseEvent({ error: VIEWING_AS_READ_ONLY_ERROR }),
        { status: 403, headers: { "Content-Type": "text/event-stream" } }
      );
    }
    const caller = await ctx.runQuery(internal.users.getByIdInternal, {
      id: callerUserId,
    });
    if (!caller || !isStaffRole(caller.role)) {
      return new Response(
        sseEvent({ error: "Forbidden" }),
        { status: 403, headers: { "Content-Type": "text/event-stream" } }
      );
    }
    const aideInstitutionId = await ctx.runQuery(
      internal.usage.resolveInstitution,
      { userId: callerUserId, principal: "staff" },
    );

    // ── Cost circuit breaker (public test server only) ─────────────────
    // Inert unless LLM_DAILY_BUDGET_USD is set (never on prod). Guards the aide
    // AND the unitId → Curriculum Bot branch below, before any Anthropic call.
    const aideOverBudget = await llmBudgetExceeded(ctx);
    if (aideOverBudget !== null) {
      return new Response(
        sseEvent({ error: llmBudgetMessage(aideOverBudget) }),
        { status: 429, headers: { "Content-Type": "text/event-stream" } },
      );
    }

    // Per-staff aide model preference ("vote with your feet") — resolves
    // the caller's users.aideModel over the fleet default. See
    // lib/aideModel.ts.
    const aideModel = resolveAideModel(caller.aideModel);

    // Unit scope → the Curriculum Bot. teacherId is the VERIFIED caller
    // (closes the old body-teacherId trust gap in the unit stream).
    if (unitId) {
      const ub = body as {
        selectedLessonId?: string | null;
        selectedActivityId?: string | null;
        testDriveProjectId?: string | null;
      };
      return buildUnitDesignerResponse(ctx, {
        callerUserId,
        role: caller.role,
        model: aideModel,
        unitId,
        assistantMsgId,
        selectedLessonId: ub.selectedLessonId,
        selectedActivityId: ub.selectedActivityId,
        testDriveProjectId: ub.testDriveProjectId,
        sessionId,
      });
    }
    // A base staff account with a school:operations grant gets a deliberately
    // thin, ACL-scoped aide: no sensitive scholar-data tools, no curriculum
    // read/write tools.
    // Scholar-record tools (directives, seeds, scholar-scoped units, and the
    // scholar-read set) are teacher/admin only. curriculum_designers design
    // general curriculum (in the unit designer) and must NOT reach scholar
    // records — roster, mastery, or the per-scholar write tools, all of which
    // resolve a scholar by name and would expose the roster.
    const canSeeScholarData = isTeacherRole(caller.role);
    // Designing GENERAL curriculum (create_unit + lesson/activity authoring)
    // is open to the broader teacher/admin/curriculum_designer set, plus base
    // staff holding a `curriculum:edit` grant — it writes no scholar data.
    // Mirrors the same gate in lib/aideTools.
    const canDesignCurriculum =
      isTeacherRole(caller.role) ||
      caller.role === ROLES.CURRICULUM_DESIGNER ||
      (await staffHoldsCurriculumGrant(ctx, caller.role, callerUserId));

    // Prefer session-based context; fall back to legacy scholarId-based context
    const context = sessionId
      ? await ctx.runQuery(
          internal.curriculumAssistant.getContextForChat,
          { sessionId: sessionId as Id<"chats">, callerUserId }
        )
      : await ctx.runQuery(
          internal.curriculumAssistant.getContext,
          {
            teacherId: callerUserId,
            scholarId: scholarId ? (scholarId as Id<"users">) : undefined,
            threadLabel,
          }
        );

    if (!context) {
      return new Response(
        sseEvent({ error: "Context not found" }),
        { status: 404, headers: { "Content-Type": "text/event-stream" } }
      );
    }

    const { Anthropic } = await import("@anthropic-ai/sdk");

    const anthropic = new Anthropic({
      apiKey: requireAnthropicApiKey(),
    });

    // Shared emit function — set once the ReadableStream starts
    let emitSSE: AideEmit = () => {};

    // Files the teacher attached to the most recent USER turn (via the chat
    // composer's "+" button). Offered to the upload tools so the teacher can
    // say "add this to Kai's file". Find the last user message with
    // attachments (most turns have none).
    const lastUserWithFiles = [...context.messages]
      .reverse()
      .find((m) => m.role === "user" && m.attachments.length > 0);
    const attachedFiles = (lastUserWithFiles?.attachments ?? []).map((a) => ({
      storageId: a.storageId,
      fileName: a.fileName,
      mimeType: a.mimeType ?? undefined,
      sizeBytes: a.sizeBytes ?? undefined,
    }));

    // Assemble the aide's toolset from the single ACL→tools layer
    // (lib/aideTools): scholar-read + scholar-write + general unit reads +
    // scholar-scoped writes + tag_session, all gated on the caller's role +
    // whether a session is in scope. The in-app aide is a private teacher
    // session, so surface="private" (the default) — the credential/
    // destructive/upload tools are available here. The emit wrapper defers
    // to the latest emitSSE (reassigned once the ReadableStream starts).

    // Institution-lens scoping (platform admins narrowing to one school via
    // the ?inst= control). The web client sends its active `scope` (even "" =
    // home) in the body; resolve it server-side to the set of scholars visible
    // under that lens and scope the aide's scholar-read tools to it. NEVER
    // trust the slug beyond what resolveInstitutionLens enforces (it only
    // honors institutions the caller may see). When `scope` is absent (MCP /
    // legacy clients) OR resolves unrestricted (an admin's "all" lens),
    // leave the tools unscoped — byte-identical to the pre-lens behavior.
    let allowedScholarIds: Set<Id<"users">> | undefined;
    let lensLabel: string | null = null;
    // Track the lens outcome separately for the focus-injection gate below:
    // `lensResolved` = a lens was actually resolved for this caller. It is now
    // unconditionally true because resolution no longer depends on the client
    // sending anything (see below), so the downstream fail-closed branch keyed
    // on it is defense in depth for any future caller rather than a live gate.
    // `lensUnrestricted` = an admin's "all" lens (sees everyone), where
    // `allowedScholarIds` is intentionally left undefined.
    // The lens is ALWAYS resolved server-side from the authenticated caller.
    // The client's `scope` may only NARROW it (and even then only to an
    // institution resolveInstitutionLens confirms the caller may see) — it can
    // never widen or omit the boundary. Previously an omitted `scope` skipped
    // resolution entirely, so any client that simply left the field off got an
    // unlensed toolset; a boundary that depends on the client sending a field
    // is not a boundary.
    const lensResolved = true;
    let lensUnrestricted = false;
    let hasSchoolOperationsAccess = false;
    let hasHealthManagementAccess = false;
    if (caller.role === ROLES.STAFF) {
      const operations = await ctx.runQuery(
        internal.curriculumAssistant.schoolOperationsScopeForUser,
        { callerUserId },
      );
      hasSchoolOperationsAccess = operations.institutionIds.length > 0;
      // A staff operator never inherits the UI's broad staff lens. Their only
      // name resolution is the scholars inside their active grants.
      allowedScholarIds = new Set(operations.scholarIds);
      lensLabel = "your granted school operations institutions";
    } else {
      const lens = await ctx.runQuery(
        internal.curriculumAssistant.resolveAideScholarLens,
        // An absent scope means "home" (""), NOT "no lens".
        { callerUserId, scope: aideLensScope(scope) },
      );
      if (lens.unrestricted) {
        lensUnrestricted = true;
      } else {
        allowedScholarIds = new Set(lens.scholarIds ?? []);
        lensLabel = lens.lensLabel;
      }
    }
    if (caller.role === ROLES.STAFF) {
      const healthInstitutions = await ctx.runQuery(
        internal.users.healthInstitutionIdsInternal,
        { id: callerUserId },
      );
      hasHealthManagementAccess =
        healthInstitutions === "all" || healthInstitutions.length > 0;
    }

    const tools = await assembleCurriculumTools(ctx, (data) => emitSSE(data), {
      role: caller.role,
      callerUserId,
      sessionId: sessionId ? (sessionId as Id<"chats">) : null,
      surface: "private",
      guardianFormAnswersSurface: "private",
      attachedFiles,
      allowedScholarIds,
      scholarLensResolved: lensResolved,
      lensLabel,
      institutionScope: typeof scope === "string" ? scope : undefined,
      institutionId: aideInstitutionId ?? undefined,
      hasSchoolOperationsAccess,
      hasHealthManagementAccess,
      // Names this transport in device audit lines. Runs as the REAL session
      // owner (getAuthUserId ignores a view-as overlay), so the device writes
      // themselves refuse while that session is impersonating.
      transport: "app",
    });


    // Build the system prompt. When the current thread is scoped to a scholar,
    // pre-load the scholar's redacted context so the AI doesn't need to tool-
    // call on every turn to remember who we're talking about.
    // Resolve the aide's identity from the staff member's active-membership
    // institution — byte-identical to the old hardcoded primary-school prompt.
    const aideProfile = await ctx.runQuery(
      internal.institutions.promptProfile,
      { institutionId: aideInstitutionId },
    );
    const curriculumAssistantSystemPrompt =
      buildCurriculumAssistantSystemPrompt(aideProfile);
    const systemPromptSections: string[] = [curriculumAssistantSystemPrompt];
    // Role override for callers without scholar-data access (curriculum_designer).
    // The base prompt above assumes a teacher and leans hard on scholar lookups;
    // those tools aren't wired for this caller, so tell the model plainly to drop
    // that framing instead of promising lookups it can't perform.
    if (!canSeeScholarData && caller.role !== ROLES.STAFF) {
      systemPromptSections.push(
        [
          "",
          "## Your role here: curriculum design only",
          "You are working with a CURRICULUM DESIGNER, not a teacher. You have NO access to scholar records — no roster, profiles, mastery, signals, seeds, observations, or documents, and no tools to look any of that up. Disregard every instruction above about looking up scholars or grounding work in student data.",
          "Do not offer to pull up a scholar and do not claim you can. If asked about a specific scholar, say that scholar data lives in the teacher tools and isn't available in the design assistant.",
          `Your curriculum tools find units (list_units, get_unit_details), create a new general unit (create_unit), and fill it with lessons and activities (create_scholar_lesson, move_lesson, create_scholar_activity and the dedicated activity-kind tools) — always by unitId or lessonId, never by scholar name. Help with general curriculum design — units, lessons, activities, building blocks, Bloom's levels, rubrics, and ${aideProfile.shortName} pedagogy. Quests (a scholar's own independent study) are teacher-only.`,
        ].join("\n"),
      );
    }
    // Generative unit creation — every curriculum-capable caller (teacher /
    // admin / curriculum_designer). This is the Curriculum landing's entry
    // point: a teacher describes a unit and the bot builds a real one.
    if (canDesignCurriculum) {
      systemPromptSections.push(
        [
          "",
          "## Building a unit from a description",
          "When a teacher describes a unit they want (\"build me a unit on tide pools for 3rd grade\", \"I need something on fractions\"), use `create_unit` to make a REAL general curriculum unit — don't just outline it in chat. Translate their description into the unit's fields: a clear title, an emoji, a short description, the big idea, 2-4 essential questions, 2-4 enduring understandings, and the subject + grade level when you can infer them.",
          "A unit starts as an empty container. After creating it, either follow up with `create_scholar_lesson` (pass the returned unitId) to add its first lessons, or tell the teacher the unit is ready and point them to open it (the unit's own Curriculum Bot designs lessons + activities in depth). Always confirm what you created and include the returned unit link so they can jump in.",
          "Ask a brief clarifying question first ONLY if the request is too thin to make a sensible unit (no topic at all). Otherwise make reasonable choices and create it — the teacher can refine from there.",
        ].join("\n"),
      );
    }
    // Practice-studio focus (the Skills-tab dock passes the domain/node the
    // teacher is currently viewing). Tell the bot what "this node" / "these"
    // refers to and point it at the practice item-pool tools, so a docked chat
    // is grounded in the on-screen node without the teacher restating it.
    if (canDesignCurriculum && practiceContext && (practiceContext.domain || practiceContext.nodeKey)) {
      const focusLines = ["", "## Skills Practice — what's on screen"];
      if (practiceContext.domainLabel || practiceContext.domain) {
        focusLines.push(
          `The teacher is viewing Skills Practice, focused on the **${practiceContext.domainLabel ?? practiceContext.domain}** domain (\`${practiceContext.domain}\`).`,
        );
      }
      if (practiceContext.nodeKey) {
        focusLines.push(
          `The selected skill node is **${practiceContext.nodeLabel ?? practiceContext.nodeKey}** (nodeKey \`${practiceContext.nodeKey}\`). When they say "this node", "these items", or "here", assume they mean this node unless they name another.`,
        );
      } else {
        focusLines.push(
          `No single node is selected yet — they're surveying the domain. "These nodes" means this domain's pools.`,
        );
      }
      focusLines.push(
        `Use the practice item-pool tools to answer and act: \`list_practice_nodes\` (survey a domain's coverage / find pool holes), \`get_practice_item_pool\` (read a node's template samples + stored items), and the author/edit/delete/generate tools for changes. Confirm before any write.`,
      );
      systemPromptSections.push(focusLines.join("\n"));
    }
    // Assignment-scheduling tools (teacher/admin). Explain the cohort
    // model + the bulk-shift recipe, and inject the current time so the
    // model can reason about "this week" / "next week" without guessing.
    if (canSeeScholarData) {
      const nowMs = Date.now();
      // The aide's institution clock (Pacific/Honolulu for the primary, where
      // this renders exactly the old fixed-HST text). The same resolver the
      // assignment tools label with — the active membership behind
      // aideInstitutionId — so the prompt's clock and the labels agree.
      const aideTimeZone = await ctx.runQuery(
        internal.institutions.staffTimeZone,
        { userId: callerUserId },
      );
      const nowLabel = schoolTimeLabel(nowMs, aideTimeZone, { withYear: true });
      systemPromptSections.push(
        [
          "",
          "## Running assignments (read + schedule + act now)",
          "You can read and run the teacher's classroom directly. Create: `assign_unit` (assign a unit to a cohort — see below). Reads: `list_assignments`, `get_schedule`, `get_assignment`, `get_assignment_progress`. Plan-ahead: `schedule_activity`, `reschedule_activity`, `clear_activity`. Act now: `push_activity_now`. Roster + lifecycle: `set_assignment_scholars`, `add_assignment_scholars`, `archive_assignment`.",
          "",
          "**An assignment IS a cohort.** Each assignment runs one unit for a FIXED set of scholars (its roster). To act on \"a class\" or \"these kids,\" find the assignment whose roster matches — there is no separate scholar argument, and scheduling an activity reaches everyone on that roster. Two assignments can run the same unit for different cohorts; tell them apart by roster (from `list_assignments` / `get_assignment`).",
          "",
          "**Create one (assign a unit to a cohort).** `assign_unit` makes a NEW assignment in one step — pass the unit title plus EITHER a `groupName` (a saved scholar group, e.g. \"the Geckos\") OR explicit `scholarNames`. It plans the whole unit (nothing goes live until you `push_activity_now`/`schedule_activity`) and REUSES an existing active assignment for the same unit + exact roster instead of duplicating. When a teacher says \"assign <unit> to <group/kids>\" and no assignment exists yet, do this directly — don't send them to the UI.",
          "",
          "**\"How's it going?\" / \"who hasn't started?\" / \"how many submissions for X?\" / \"open Kai's project\"** → `get_assignment_progress`. It returns the roster (with each scholar's started-status + a `sessionUrl` deep link) and a per-activity roll-up (completed N/total + who's left, submissions in + not/half/full verdicts). `get_schedule` also now carries a quick `completedCount`/`scholarCount` per item.",
          "",
          "**Start something NOW vs plan it.** THREE tools live here, and picking the wrong one puts work in front of kids at the wrong time. `push_activity_now` makes an activity LIVE immediately on an EXISTING assignment (\"put the Tide Pool activity up\", \"set focus to X\"). `assign_activity_now` CREATES the cohort assignment AND goes live in one call. `schedule_activity` only PLANS a future push (goes live at `startsAtMs`). Don't use schedule_activity with a past/now time to start something — use push_activity_now.",
          "After dispatching or pushing a class focus, confirm how long it will stay, explain that it fades after today unless the teacher asked for longer, and invite a correction.",
          "",
          "**A stated time means PLAN it, even when the request sounds casual.** \"Now\", \"put it up\", \"set focus\" mean live. Anything carrying a when — \"today at 2:20\", \"this afternoon\", \"for tomorrow\", \"in second period\" — means PLAN: `assign_unit` (nothing goes live), then `get_assignment` for the activityId, then `schedule_activity` at that time. There is deliberately no one-call create-and-schedule tool, so this is three calls; take them. Do NOT reach for `assign_activity_now` just because it is one call — it is live-only, and a bare \"today\" is a day, not a permission to start now. When the teacher names no time at all, ASK before making work appear.",
          "",
          "**If a time turns up AFTER something is already live, treat it as a correction, not trivia.** A teacher saying \"they'll be doing this at 2:20\" about work you already pushed is telling you it went live too early. Say so and offer to hold it: `clear_activity` (this clears a LIVE push, not just a planned one) then `schedule_activity` at the stated time. `reschedule_activity` alone is NOT enough — on a live item it only moves the agenda position and does not un-push it. (Observed 2026-08-18: a reflection went live at 12:58 for work the teacher said would happen at 14:20, and the correction two minutes later was read as background information.)",
          "",
          "**Roster + lifecycle.** `set_assignment_scholars` REPLACES the roster (anyone unlisted leaves); `add_assignment_scholars` only adds. `archive_assignment` ends an assignment (clears its pushes). All take scholar NAMES, resolved for you — but confirm the resolved names/assignment with the teacher before a roster change or archive.",
          "",
          `**Time.** All times are epoch milliseconds${longClockClause(aideProfile)}. Right now it is ${nowLabel} (${nowMs} ms). One day = 86400000 ms; one week = 604800000 ms. Each schedule item comes back with a human \`whenLabel\` so you can confirm you've got the right one.`,
          "",
          `**Converting a wall-clock time to ms is error-prone — don't trust your first arithmetic.** Anchor off the current time above (e.g. \"this coming Monday 9am\" = step forward from now), and a useful identity is: ${wallClockUtcIdentity(nowMs, aideTimeZone)}. After ANY schedule_activity / reschedule_activity call, READ the returned \`startsAtLabel\` and check it matches the time the teacher asked for. If it's off, recompute and call again BEFORE telling the teacher it's done — don't narrate a guess as if it were confirmed.`,
          "",
          "**Bulk shifts** (e.g. \"push everything in the week of Jun 8 back by 1 week\"): call `get_schedule`, read each item's `whenLabel` to find the ones in that window, then call `reschedule_activity` once per item with `startsAtMs = agendaAtMs + 604800000`. Rescheduling a LIVE item only moves its agenda position; a PLANNED item also moves when it goes live.",
          "",
          "Before any schedule edit, make sure you have the real `assignmentId` + `activityId` from a tool call (never invent ids). After editing, briefly confirm what changed (which activities, old → new time).",
        ].join("\n"),
      );
    }
    // Custom-app install tools — teacher roles only (installing an app for a
    // student is a teaching action), the same gate makeCustomAppTools checks.
    // Push the section only when the tools are present so the prompt never
    // describes a capability this caller lacks.
    if (isTeacherRole(caller.role)) {
      systemPromptSections.push(CUSTOM_APPS_SYSTEM_PROMPT_SECTION);
    }
    // Workshop staff tools (scholar-idea queue + reply) — teacher+ only, the
    // same gate makeSuggestionTools checks. No env flag: the Workshop is an
    // independent feature. Push only when the tools are present so the
    // prompt never describes a capability this caller lacks.
    if (canSeeScholarData) {
      systemPromptSections.push(SUGGESTION_SYSTEM_PROMPT_SECTION);
    }
    // Defense-in-depth: the context loaders already return a null
    // scholarContext for operations-only staff, but never inject it here either.
    if (context.scholarContext) {
      const sc = context.scholarContext;
      const lines: string[] = [];
      lines.push("");
      lines.push(
        `## Current scholar: ${sc.scholarName} ${scholarNamePronounHint(sc.pronouns)}`,
      );
      lines.push("");
      lines.push(
        `This chat thread is scoped to one specific scholar. Assume every question is about ${sc.scholarName} unless stated otherwise. The context below is pre-loaded — you do NOT need to call get_scholar_dossier / get_scholar_seeds / get_scholar_observations for this scholar (but you may still call get_scholar_mastery and get_scholar_signals if useful).`
      );
      lines.push("");
      if (sc.readingLevel) {
        lines.push(levelsPromptLine(sc.readingLevel) ?? "");
        lines.push("");
      }
      lines.push(`Date of birth: ${sc.dateOfBirth ?? "(not recorded)"}`);
      lines.push(
        `Current age: ${sc.currentAge ?? "(unavailable)"} (server-derived as of ${sc.currentAgeAsOf})`,
      );
      lines.push("");
      lines.push(`### Dossier`);
      lines.push(sc.dossier);
      lines.push("");
      if (sc.directives.length > 0) {
        lines.push(`### Active teacher directives (${sc.directives.length})`);
        for (const d of sc.directives) {
          lines.push(`- **${d.label}** — ${d.content}`);
        }
        lines.push("");
      } else {
        lines.push(`### Active teacher directives`);
        lines.push(`(none yet)`);
        lines.push("");
      }
      if (sc.seeds.length > 0) {
        lines.push(`### Active exploration seeds (${sc.seeds.length})`);
        for (const s of sc.seeds) {
          let line = `- "${s.topic}"`;
          if (s.domain) line += ` (${s.domain})`;
          line += ` — ${s.rationale}`;
          if (s.approachHint) line += ` [approach: ${s.approachHint}]`;
          lines.push(line);
        }
        lines.push("");
      }
      if (sc.recentObservations.length > 0) {
        lines.push(
          `### Recent teacher observations (last ${sc.recentObservations.length})`
        );
        for (const o of sc.recentObservations) {
          lines.push(`- [${o.type}] ${o.note}`);
        }
        lines.push("");
      }
      lines.push(
        `When suggesting new directives or seeds for this scholar, use the tools (upsert_teacher_directive, create_scholar_seed) and default scholarName to "${sc.scholarName}". This focus does NOT make curriculum requests scholar-owned: a unit still starts with \`create_unit\` unless the teacher explicitly asks for a Quest (independent study) that belongs to ${sc.scholarName} alone.`
      );
      systemPromptSections.push(lines.join("\n"));
    }
    // EPHEMERAL "currently viewing" focus — the docked chat is a single
    // persistent thread that follows the teacher as they navigate. When the
    // thread itself isn't bound to a scholar (no context.scholarContext) but
    // the teacher is looking at one right now, pre-load that scholar so
    // ambiguous references ("they", "this scholar", "how are they doing") resolve
    // to them WITHOUT binding the thread. Lens-gated (fail CLOSED — see
    // focusScholarAllowed): only inject when the focus scholar is provably
    // within the caller's visible universe. Operations-only staff +
    // curriculum_designers never get this (canSeeScholarData gate). Body id is
    // NEVER trusted for auth — the internal query re-checks the caller's role.
    // Set when the teacher SWITCHED scholars mid-thread — used to inject a
    // transcript-only context turn before the new user message (FIX 1).
    let focusSwitchName: string | null = null;
    if (
      !context.scholarContext &&
      focusScholarId &&
      canSeeScholarData &&
      focusScholarAllowed({
        scopeProvided: lensResolved,
        lensUnrestricted,
        allowedScholarIds,
        focusScholarId: focusScholarId as Id<"users">,
      })
    ) {
      const focus = await ctx.runQuery(
        internal.curriculumAssistant.getScholarFocusContext,
        { scholarId: focusScholarId as Id<"users">, callerUserId },
      );
      if (focus) {
        if (focusSwitched) focusSwitchName = focus.scholarName;
        const lines: string[] = [];
        lines.push("");
        lines.push(
          `## Currently viewing: ${focus.scholarName} ${scholarNamePronounHint(focus.pronouns)}`,
        );
        lines.push("");
        if (focusSwitched) {
          // The teacher just SWITCHED to a different scholar mid-thread — the
          // most recent turns discussed someone else, so a bare pronoun would
          // anchor to the WRONG scholar. Override that referent hard.
          lines.push(
            `The teacher has SWITCHED to viewing ${focus.scholarName}. From now on ambiguous references such as "they" or "this scholar" mean ${focus.scholarName}, even though earlier turns discussed someone else; do NOT continue about the previously-discussed scholar unless the teacher names them. This is NOT a scholar-scoped thread — it's a general chat that follows what the teacher is viewing. The context below is pre-loaded — you do NOT need to call get_scholar_dossier / get_scholar_seeds / get_scholar_observations for ${focus.scholarName} (but you may still call get_scholar_mastery and get_scholar_signals if useful).`
          );
        } else {
          lines.push(
            `The teacher is looking at ${focus.scholarName}'s records right now. This is NOT a scholar-scoped thread — it's a general chat that follows what the teacher is viewing. Interpret ambiguous references ("they", "this scholar", "how are they doing") as ${focus.scholarName} unless the teacher names someone else; if they switch to talking about a different scholar, follow them. The context below is pre-loaded — you do NOT need to call get_scholar_dossier / get_scholar_seeds / get_scholar_observations for ${focus.scholarName} (but you may still call get_scholar_mastery and get_scholar_signals if useful).`
          );
        }
        lines.push("");
        if (focus.readingLevel) {
          lines.push(levelsPromptLine(focus.readingLevel) ?? "");
          lines.push("");
        }
        lines.push(`Date of birth: ${focus.dateOfBirth ?? "(not recorded)"}`);
        lines.push(
          `Current age: ${focus.currentAge ?? "(unavailable)"} (server-derived as of ${focus.currentAgeAsOf})`,
        );
        lines.push("");
        lines.push(`### Dossier`);
        lines.push(focus.dossier);
        lines.push("");
        if (focus.directives.length > 0) {
          lines.push(`### Active teacher directives (${focus.directives.length})`);
          for (const d of focus.directives) {
            lines.push(`- **${d.label}** — ${d.content}`);
          }
          lines.push("");
        }
        if (focus.seeds.length > 0) {
          lines.push(`### Active exploration seeds (${focus.seeds.length})`);
          for (const s of focus.seeds) {
            let line = `- "${s.topic}"`;
            if (s.domain) line += ` (${s.domain})`;
            line += ` — ${s.rationale}`;
            if (s.approachHint) line += ` [approach: ${s.approachHint}]`;
            lines.push(line);
          }
          lines.push("");
        }
        if (focus.recentObservations.length > 0) {
          lines.push(
            `### Recent teacher observations (last ${focus.recentObservations.length})`
          );
          for (const o of focus.recentObservations) {
            lines.push(`- [${o.type}] ${o.note}`);
          }
          lines.push("");
        }
        lines.push(
          `When suggesting new directives or seeds for this scholar, use the tools (upsert_teacher_directive, create_scholar_seed) and default scholarName to "${focus.scholarName}". Merely having this scholar on screen does NOT make a curriculum request scholar-owned: a unit still starts with \`create_unit\` unless the teacher explicitly asks for a Quest (independent study) that belongs to ${focus.scholarName} alone.`
        );
        systemPromptSections.push(lines.join("\n"));
      }
    }
    // Cache the static assistant prompt + the (large) tools array; the
    // per-request role override / scholar context sits after the breakpoint.
    const dynamicSystemSuffix = systemPromptSections.slice(1).join("\n");

    // Build the Anthropic message list. User turns with files become content
    // blocks so Claude can see supported uploads and linked Drive docs; turns
    // without files stay plain strings.
    const apiMessages = await Promise.all(
      context.messages
        .filter(
          (m) =>
            m.content.trim() !== "" || aideMessageHasFiles(m),
        )
        .map(async (m) => {
          if (m.role === "user" && aideMessageHasFiles(m)) {
            return {
              role: "user" as const,
              content: await buildAideUserContent(ctx, callerUserId, m),
            };
          }
          return { role: m.role as "user" | "assistant", content: m.content };
        }),
    );

    // FIX 1 — when the teacher switched scholars mid-thread, inject a
    // transcript-only user turn immediately BEFORE the new (last) user message.
    // This sits in the message list only (never persisted to curriculumMessages),
    // and gives the model an unmissable, in-conversation marker that the
    // referent changed — reinforcing the hardened system-prompt wording so a
    // bare pronoun resolves to the newly-viewed scholar, not the previous one.
    if (
      focusSwitchName &&
      apiMessages.length > 0 &&
      apiMessages[apiMessages.length - 1].role === "user"
    ) {
      apiMessages.splice(apiMessages.length - 1, 0, {
        role: "user",
        content: `[Context: the teacher switched to viewing ${focusSwitchName}. Any pronoun or "this scholar" below refers to ${focusSwitchName}.]`,
      });
    }

    return runAideStream({
      anthropic,
      model: aideModel,
      maxTokens: aideMaxTokens(aideModel, 4096),
      system: cachedSystem(curriculumAssistantSystemPrompt, dynamicSystemSuffix),
      messages: apiMessages,
      tools,
      bindEmit: (emit) => {
        emitSSE = emit;
      },
      persist: (content) =>
        ctx.runMutation(internal.curriculumAssistant.updateStreamContent, {
          messageId: assistantMsgId as Id<"curriculumMessages">,
          content,
        }),
      isStopRequested: () =>
        ctx.runQuery(internal.curriculumAssistant.isStopRequested, {
          messageId: assistantMsgId as Id<"curriculumMessages">,
        }),
      finalize: ({ content, model, tokensUsed }) =>
        ctx.runMutation(internal.curriculumAssistant.finalizeStream, {
          messageId: assistantMsgId as Id<"curriculumMessages">,
          content,
          model,
          tokensUsed,
        }),
      onComplete: async ({ content }) => {
        // Auto-name session after first exchange
        if (sessionId && content.trim()) {
          const firstExchange = await ctx.runQuery(
            internal.curriculumAssistant.getSessionFirstExchange,
            { sessionId: sessionId as Id<"chats"> }
          );
          if (
            firstExchange.firstUserMessage &&
            firstExchange.firstAssistantMessage
          ) {
            await ctx.scheduler.runAfter(
              0,
              internal.chatTitles.autoNameChat,
              { sessionId: sessionId as Id<"chats"> }
            );
          }
        }
      },
      onUsage: (usage, model) =>
        recordUsage(ctx, {
          source: "aide-chat",
          role: caller.role,
          institutionId: aideInstitutionId,
          model,
          usage,
        }),
      label: "curriculum",
      // Staff surface: stream the reasoning inline as a collapsible accordion.
      streamThinking: true,
    });
  }),
});

// CORS preflight for aide-stream
http.route({
  path: "/aide-stream",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }),
});

// ── Text-to-Speech (OpenAI TTS) ──────────────────────────────────────────────

http.route({
  path: "/tts",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    const { text, voice, instructions } = body as {
      text?: string;
      voice?: string;
      instructions?: string;
    };

    if (!text || text.trim().length === 0) {
      return new Response(JSON.stringify({ error: "text is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
    if (text.length > 4096) {
      return new Response(JSON.stringify({ error: "text must be 4096 chars or fewer" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "OPENAI_API_KEY not configured" }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // `instructions` (delivery: quiet, distracted, warm...) needs a style-capable
    // model; tts-1 ignores it. Only switch models when a caller actually asks for
    // a style, so every existing caller keeps the voice it already has.
    const styled = typeof instructions === "string" && instructions.trim().length > 0;
    const speechBody: Record<string, unknown> = {
      model: styled ? "gpt-4o-mini-tts" : "tts-1",
      voice: voice || "nova",
      input: text,
      response_format: "mp3",
    };
    let usedModel = speechBody.model as string;
    if (styled) speechBody.instructions = instructions.trim().slice(0, 1000);

    let openaiRes = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(speechBody),
    });
    if (!openaiRes.ok && styled) {
      // Never let a styling request cost us the speech itself: fall back to the
      // plain model rather than returning silence to a kiosk speaker.
      console.error("TTS styled call failed; falling back to tts-1");
      openaiRes = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "tts-1", voice: voice || "nova", input: text,
          response_format: "mp3",
        }),
      });
      usedModel = "tts-1";
    }

    if (!openaiRes.ok) {
      const err = await openaiRes.text();
      console.error("OpenAI TTS error:", err);
      return new Response(JSON.stringify({ error: "TTS generation failed" }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // Kick off usage recording without blocking the first audio byte —
    // /tts is on the voice loop's latency-critical path. The action stays
    // alive while the stream pumps, and the pump's close awaits the write
    // so it can't be dropped when the action ends.
    const usageRecorded = recordUnitUsage(ctx, {
      source: "tts",
      model: usedModel,
      characters: text.length,
    });

    // Manually pump the OpenAI stream into a new ReadableStream so the
    // Convex HTTP action stays alive until all audio data is forwarded.
    // Direct passthrough via `new Response(openaiRes.body)` doesn't work
    // because Convex closes the external fetch when the handler returns.
    const reader = openaiRes.body!.getReader();
    const stream = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          await usageRecorded;
          controller.close();
        } else {
          controller.enqueue(value);
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }),
});

// CORS preflight for tts
http.route({
  path: "/tts",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }),
});

// /unit-designer-stream merged into /aide-stream (dispatched on unitId).
// /quest-designer-stream removed in the kill-quests refactor.

// ── Google OAuth callback ───────────────────────────────────────────────
// The "start" half of the flow is `googleAccounts.beginOAuth` (an action
// in `googleAccountsActions.ts`) — the client calls it, gets back a
// pre-signed authorization URL, and navigates the browser to it. The
// callback below runs on the Convex domain without any session cookie:
// trust comes from the HMAC-signed `state` parameter and, for the personal
// link, a single-use nonce stored by beginOAuth (googleOAuthNonces).

http.route({
  path: "/google/oauth/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    if (error) {
      return new Response(`Google OAuth error: ${error}`, { status: 400 });
    }
    if (!code || !state) {
      return new Response("Missing code or state", { status: 400 });
    }

    const {
      exchangeCodeForTokens,
      fetchDriveUserInfo,
      fetchUserInfo,
      INSTITUTION_DRIVE_SYNC_SCOPES,
      normalizeGoogleScopes,
      readOAuthConfig,
      readStateSecret,
      verifyState,
    } = await import("./lib/google");
    const { clientId, clientSecret, redirectUri } = readOAuthConfig();
    const stateSecret = readStateSecret();

    const verified = await verifyState<{
      userId: string;
      returnTo: string;
      nonce: string;
      institutionId?: string;
      // Personal-link purposes ("default", "admissions") take the per-user
      // branch below; only the scanner/bot purposes are institution-owned.
      purpose?: "scanner" | "docs_bot" | "workspace_bot" | "default" | "admissions";
    }>(state, stateSecret);
    if (!verified) {
      return new Response("Invalid state", { status: 400 });
    }
    const isWorkspacePurpose =
      verified.purpose === "docs_bot" || verified.purpose === "workspace_bot";
    const isInstitutionPurpose =
      verified.purpose === "scanner" || isWorkspacePurpose;
    if (isInstitutionPurpose && !verified.institutionId) {
      return new Response("Invalid institution Google state", { status: 400 });
    }
    // Personal link (default/Drive or admissions): the state's nonce must be
    // one beginOAuth stored for this user and purpose, and is consumed here,
    // so a captured or replayed state is refused. Checked before the code
    // exchange so a refused state spends nothing.
    let personalUserEmail: string | null = null;
    if (!isInstitutionPurpose) {
      const personalPurpose = verified.purpose ?? "default";
      const consumed =
        typeof verified.nonce === "string" && verified.nonce.length > 0
          ? await ctx.runMutation(internal.googleAccounts.consumeOAuthNonceInternal, {
              nonce: verified.nonce,
              userId: verified.userId as Id<"users">,
              purpose: personalPurpose,
            })
          : { ok: false as const };
      if (!consumed.ok) {
        return new Response(
          "This Google sign-in link has expired or was already used. Go back to Rabbithole and start the connection again.",
          { status: 400 },
        );
      }
      personalUserEmail = consumed.userEmail;
    }
    if (isInstitutionPurpose) {
      const authorized = await ctx.runQuery(
        internal.driveSyncState.canManageInstitutionGoogleCredentialInternal,
        {
          userId: verified.userId as Id<"users">,
          institutionId: verified.institutionId as Id<"institutions">,
        },
      );
      if (!authorized) {
        return new Response(
          "You no longer have permission to connect this school's Google identity.",
          { status: 403 },
        );
      }
    }

    const tokens = await exchangeCodeForTokens({
      code,
      clientId,
      clientSecret,
      redirectUri,
    });
    if (verified.purpose === "scanner") {
      const grantedScopes = normalizeGoogleScopes([tokens.scope]);
      if (
        grantedScopes.length !== INSTITUTION_DRIVE_SYNC_SCOPES.length ||
        INSTITUTION_DRIVE_SYNC_SCOPES.some(
          (requiredScope) => !grantedScopes.includes(requiredScope),
        )
      ) {
        return new Response(
          "The scanner account returned broader Google access than Drive read-only. Use a dedicated scanner account or revoke Rabbithole access in Google, then reconnect.",
          { status: 400 },
        );
      }
    }
    let profile: { email: string; name?: string; sub?: string };
    if (verified.purpose === "scanner") {
      try {
        profile = await fetchDriveUserInfo(tokens.access_token);
      } catch {
        return new Response(
          "Google could not confirm the scanner account. Reconnect it and try again.",
          { status: 502 },
        );
      }
    } else if (isWorkspacePurpose) {
      try {
        profile = await fetchUserInfo(tokens.access_token);
      } catch {
        return new Response(
          "Google could not confirm the Workspace bot account. Reconnect the bot and try again.",
          { status: 502 },
        );
      }
    } else {
      const info = await fetchUserInfo(tokens.access_token);
      profile = info;
      // Admissions reads and drafts mail as this account, so it must be the
      // Rabbithole user's own Google account (verified, same address).
      if (verified.purpose === "admissions") {
        const { normalizeEmail } = await import("./lib/email");
        const googleEmail = info.email ? normalizeEmail(info.email) : "";
        if (
          !personalUserEmail ||
          info.email_verified === false ||
          googleEmail !== personalUserEmail
        ) {
          // Best-effort: drop the grant we were just given.
          try {
            await fetch(
              `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokens.refresh_token ?? tokens.access_token)}`,
              { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } },
            );
          } catch {
            // Silent.
          }
          return new Response(
            personalUserEmail
              ? `Connect the Google account for ${personalUserEmail}. You signed in to Google with a different account. Go back to Rabbithole and connect again with ${personalUserEmail}.`
              : "Your Rabbithole account has no email address, so Admissions can't confirm which Google account is yours. Ask an administrator to add your email.",
            { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } },
          );
        }
      }
    }

    // Redirect back to the canonical Next.js app. We're on the Convex domain,
    // so a relative path won't work — SITE_URL must be an absolute URL.
    // Falling back to the Origin header would silently break here:
    // top-level browser navigations from accounts.google.com don't carry
    // one, so we'd emit a path-only Location and the browser would land
    // on accounts.google.com/teacher. Fail loudly instead.
    const appBase = appBaseUrlOrNull();
    if (!appBase || !/^https?:\/\//.test(appBase)) {
      return new Response(
        "Server misconfigured: SITE_URL must be set to an absolute URL " +
          "(e.g. http://localhost:1041) in the Convex dashboard.",
        { status: 500 }
      );
    }
    const safeReturnTo =
      verified.returnTo.startsWith("/") && !verified.returnTo.startsWith("//")
        ? verified.returnTo
        : "/teacher";
    const baseUrl = `${appBase.replace(/\/$/, "")}${safeReturnTo}`;

    // Try to persist the tokens. If the same Google account is already
    // bound to a different Rabbithole user, redirect with a query param
    // the app can show a friendly message for instead of bubbling a
    // raw 500 from the Convex domain (which strands the user on a page
    // they can't navigate back from).
    try {
      if (isInstitutionPurpose) {
        await ctx.runMutation(internal.driveSyncState.upsertCredentialInternal, {
          institutionId: verified.institutionId as Id<"institutions">,
          purpose:
            verified.purpose === "docs_bot" || verified.purpose === "workspace_bot"
              ? verified.purpose
              : undefined,
          identityType: "google_oauth",
          email: profile.email,
          scopes: tokens.scope.split(" "),
          connectedBy: verified.userId as Id<"users">,
          googleSub: profile.sub,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          preserveRefreshToken: verified.purpose !== "scanner",
          expiresAt: Date.now() + tokens.expires_in * 1000,
        });
      } else {
        if (!profile.sub) {
          return new Response("Google account identity was incomplete", {
            status: 502,
          });
        }
        await ctx.runMutation(internal.googleAccounts.upsertInternal, {
          userId: verified.userId as Id<"users">,
          googleSub: profile.sub,
          email: profile.email,
          googleDisplayName: profile.name,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: Date.now() + tokens.expires_in * 1000,
          scopes: tokens.scope.split(" "),
        });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const code =
        message.includes("already linked") ? "already_linked" : "google_link_failed";
      const sep = baseUrl.includes("?") ? "&" : "?";
      return Response.redirect(
        `${baseUrl}${sep}googleError=${encodeURIComponent(code)}`,
        302
      );
    }
    return Response.redirect(baseUrl, 302);
  }),
});

// ── Google Drive push-notification webhook ──────────────────────────────
// Google pings the configured verified domain, which forwards here. The ping
// carries NO file info — it just means "the
// watched drive changed" — so we validate the channel token and schedule a
// folder re-sync. See `driveSync.ts` for the listing/ingest logic.
//
// Always return 2xx: a non-2xx makes Google retry with backoff and
// eventually drop the channel. We swallow auth failures into a 200 (logged)
// rather than leak whether a channelId is valid.
http.route({
  path: "/drive-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const channelId = request.headers.get("X-Goog-Channel-ID");
    const channelToken = request.headers.get("X-Goog-Channel-Token");
    const resourceState = request.headers.get("X-Goog-Resource-State");

    // Handshake ping fired right after watch creation — acknowledge, do nothing.
    if (resourceState === "sync") {
      return new Response(null, { status: 200 });
    }
    if (!channelId) {
      return new Response(null, { status: 200 });
    }

    const state = await ctx.runQuery(
      internal.driveSyncState.getByChannelInternal,
      { channelId }
    );
    if (!state || !state.channelToken || state.channelToken !== channelToken) {
      console.warn(
        `[drive-webhook] rejected ping: channelId=${channelId} valid=${!!state && state.channelToken === channelToken}`
      );
      return new Response(null, { status: 200 });
    }

    // Resolve the institution this channel belongs to and sync only its inbox,
    // never the ambient default — a ping for School A must not sync School B.
    await ctx.scheduler.runAfter(0, internal.driveSync.syncFolder, {
      institutionId: state.institutionId ?? undefined,
    });
    return new Response(null, { status: 200 });
  }),
});

// ── Parent aide stream ──────────────────────────────────────────────────
// The parent-facing AI chat. Authenticates the parent from the session
// token (never trusts the body), scopes the SHARED scholar-read tools to
// the parent's OWN children (tier-1 only: mastery/signals/seeds), and
// streams Claude. Session storage is isolated in parentChatMessages.
http.route({
  path: "/parent-chat-stream",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // SSE responses are cross-origin (app domain → *.convex.site), so every
    // response (success AND error) needs CORS or the browser reports an
    // opaque "Failed to fetch". Mirrors the other stream endpoints.
    const sseHeaders = {
      "Content-Type": "text/event-stream",
      "Access-Control-Allow-Origin": "*",
    };
    const body = await request.json();
    const { assistantMsgId, selectedChildId } = body as {
      assistantMsgId: string;
      selectedChildId?: string;
    };

    const callerUserId = await getAuthUserId(ctx);
    if (!callerUserId) {
      return new Response(
        sseEvent({ error: "Not authenticated" }),
        { status: 401, headers: sseHeaders },
      );
    }
    if (await isReadOnlyCaller(ctx)) {
      return new Response(
        sseEvent({ error: READ_ONLY_ACCOUNT_ERROR }),
        { status: 403, headers: sseHeaders },
      );
    }
    const caller = await ctx.runQuery(internal.users.getByIdInternal, {
      id: callerUserId,
    });
    // Authorize on GUARDIANSHIP, not role, so a staff/admin guardian can use
    // their own parent aide. The tools are still tier-1 parent-scoped and
    // id-limited to this user's children (below).
    const isGuardian = await ctx.runQuery(
      internal.parents.hasGuardianshipsInternal,
      { userId: callerUserId },
    );
    if (!caller || (caller.role !== ROLES.PARENT && !isGuardian)) {
      return new Response(
        sseEvent({ error: "Forbidden" }),
        { status: 403, headers: sseHeaders },
      );
    }

    // The assistant row to stream into comes from the body — verify it
    // actually belongs to THIS parent before writing/deleting it, or a
    // parent could clobber another parent's chat row by passing its id.
    const ownerId = await ctx.runQuery(internal.parentChat.getMessageOwner, {
      messageId: assistantMsgId as Id<"parentChatMessages">,
    });
    if (ownerId !== callerUserId) {
      return new Response(
        sseEvent({ error: "Forbidden" }),
        { status: 403, headers: sseHeaders },
      );
    }

    const context = await ctx.runQuery(internal.parentChat.getContext, {
      parentUserId: callerUserId,
    });
    if (!context) {
      return new Response(
        sseEvent({ error: "Context not found" }),
        { status: 404, headers: sseHeaders },
      );
    }

    const { Anthropic } = await import("@anthropic-ai/sdk");
    const anthropic = new Anthropic({ apiKey: requireAnthropicApiKey() });

    // SCOPE: the tool resolver may only see this parent's children.
    const allowedScholarIds = new Set(context.children.map((c) => c.id));
    const childNames = context.children.map((c) => c.name);
    const parentInstitutionId = await ctx.runQuery(
      internal.usage.resolveSharedScholarInstitution,
      { userIds: context.children.map((child) => child.id) },
    );
    // Identity resolves from the child's institution (byte-identical to the old
    // primary-school wording when that's the primary / children disagree).
    const parentProfile = await ctx.runQuery(
      internal.institutions.promptProfile,
      { institutionId: parentInstitutionId },
    );

    let emitSSE: AideEmit = () => {};

    // Same shared tool set as the teacher aide, role-filtered to tier-1 and
    // id-scoped to this parent's children (lib/scholarReadTools) — plus the
    // scholar Code Explorer (lib/scholarCodeTools): read-only, public-mirror
    // reads so "how does Rabbithole decide what's on her frontier?" gets a
    // true answer from the real code instead of a "can't see that" deflection
    // (2026-09-16: three of the first nine free-typed parent questions on prod
    // were about how the engine works, and all three were refused). The
    // explorer carries no scholar data, so it needs no guardianship scoping.
    const scholarReadTools = await makeScholarReadTools(
      ctx,
      (data) => emitSSE(data),
      ROLES.PARENT,
      allowedScholarIds,
    );
    // Guarded: the model picks the explorer's arguments AFTER seeing the
    // child's data, so a child's or parent's name in a path/query would reach
    // GitHub's request logs — refuse those at the boundary
    // (lib/scholarCodeTools.guardCodeToolArguments).
    const codeTools = guardCodeToolArguments(
      await makeScholarCodeTools((data) => emitSSE(data), ctx),
      protectedTermsFromNames([...childNames, context.parentName]),
    );
    const tools = [...scholarReadTools, ...codeTools];

    const childList =
      childNames.length > 0 ? childNames.join(", ") : "(no children linked yet)";
    // The portal header's current selection, resolved ONLY against this
    // parent's guardianship-derived children — an id for anyone else falls
    // back to no selection rather than naming a child they can't see.
    const selectedChildName = resolveSelectedChildName(
      context.children,
      selectedChildId,
    );
    const systemPrompt = buildParentAideSystemPrompt({
      profile: parentProfile,
      parentName: context.parentName,
      childList,
      childCount: childNames.length,
      selectedChildName,
    });

    const apiMessages = context.messages
      .filter((m) => m.content.trim() !== "")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    return runAideStream({
      anthropic,
      model: MODELS.SONNET,
      maxTokens: 2048,
      system: cachedSystem(systemPrompt),
      messages: apiMessages,
      tools,
      // Cost cap on the tool loop now that the explorer is here. Looser than
      // the scholar Workshop's CODE_EXPLORER_MAX_ITERATIONS (5) because the
      // scholar-read tools ran uncapped before and a turn that reads two
      // children's practice + seeds and then opens a source file is already
      // four rounds; the SDK stops silently at the cap and the partial text
      // is finalized as the answer, so the cap must never bite a normal turn.
      maxIterations: PARENT_AIDE_MAX_ITERATIONS,
      bindEmit: (emit) => {
        emitSSE = emit;
      },
      persist: (content) =>
        ctx.runMutation(internal.parentChat.updateStreamContent, {
          messageId: assistantMsgId as Id<"parentChatMessages">,
          content,
        }),
      isStopRequested: () =>
        ctx.runQuery(internal.parentChat.isStopRequested, {
          messageId: assistantMsgId as Id<"parentChatMessages">,
        }),
      finalize: ({ content }) =>
        ctx.runMutation(internal.parentChat.finalizeStream, {
          messageId: assistantMsgId as Id<"parentChatMessages">,
          content,
        }),
      onUsage: (usage, model) =>
        recordUsage(ctx, {
          source: "parent-chat",
          role: ROLES.PARENT,
          institutionId: parentInstitutionId,
          model,
          usage,
        }),
      label: "parent chat",
    });
  }),
});

// CORS preflight for parent-chat-stream
http.route({
  path: "/parent-chat-stream",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }),
});

// ── The Workshop reflection chat (/meta-stream) ──────────────────────────
// Cloned from the aide streams: auth the scholar (their own Convex-auth
// identity — the same getAuthUserId the scholar-facing /session-stream uses),
// verify the metaChat + assistant row belong to the caller (via the extracted
// pure validator), run runAideStream, and finalize the assistant row
// (finalizeStream schedules the meta-observer, exactly where sessions schedule
// the main observer). See review/scholar-meta-prep-time-plan.html §8.
//
// TOOLS (all context is injected deterministically):
//   - Code Explorer — ALWAYS ON for both purposes: three read-only,
//     public-only, unauthenticated repo-reading tools (lib/scholarCodeTools.ts,
//     CODE_EXPLORER_SPEC.md). A scholar asking how Rabbithole is built needs
//     the real code to get a true answer. (The parent aide above carries the
//     same three tools for the same reason.)
//   - WORKSHOP_IDEA_CONVOS_ENABLED (always on for Ask Rabbithole) → the
//     send_idea_to_teacher write tool + the thinking-partner prompt
//     (lib/scholarIdeaTools.ts, IDEA_CONVOS_SPEC.md).
// A small iteration cap applies (the larger of the two tool sets' caps).
http.route({
  path: "/meta-stream",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const sseHeaders = {
      "Content-Type": "text/event-stream",
      "Access-Control-Allow-Origin": "*",
    };
    const body = await request.json();
    const { chatId, assistantMsgId } = body as {
      chatId?: string;
      assistantMsgId?: string;
    };

    const callerUserId = await getAuthUserId(ctx);

    // Ownership facts for the pure validator. Only query when both ids are
    // present; a malformed id is treated as a bad request.
    let facts: {
      chatScholarId: string | null;
      assistantChatId: string | null;
      assistantRole: string | null;
    } = { chatScholarId: null, assistantChatId: null, assistantRole: null };
    if (typeof chatId === "string" && chatId && typeof assistantMsgId === "string" && assistantMsgId) {
      try {
        facts = await ctx.runQuery(internal.metaChat.getStreamValidation, {
          chatId: chatId as Id<"metaChats">,
          assistantMsgId: assistantMsgId as Id<"metaMessages">,
        });
      } catch {
        return new Response(sseEvent({ error: "Invalid request" }), {
          status: 400,
          headers: sseHeaders,
        });
      }
    }

    const check = validateMetaStreamRequest({
      callerUserId: callerUserId ?? null,
      chatId,
      assistantMsgId,
      chatScholarId: facts.chatScholarId,
      assistantChatId: facts.assistantChatId,
      assistantRole: facts.assistantRole,
    });
    if (!check.ok) {
      return new Response(sseEvent({ error: check.error }), {
        status: check.status,
        headers: sseHeaders,
      });
    }
    if (await isReadOnlyCaller(ctx)) {
      return new Response(sseEvent({ error: READ_ONLY_ACCOUNT_ERROR }), {
        status: 403,
        headers: sseHeaders,
      });
    }

    const context = await ctx.runQuery(internal.metaChat.getContext, {
      chatId: chatId as Id<"metaChats">,
    });
    if (!context) {
      return new Response(sseEvent({ error: "Context not found" }), {
        status: 404,
        headers: sseHeaders,
      });
    }
    const metaInstitutionId = await ctx.runQuery(
      internal.usage.resolveInstitution,
      { userId: context.scholarId, principal: "scholar" },
    );

    const ideaConvosEnabled =
      context.purpose === "introspection" || isIdeaConvosEnabled();
    const systemPrompt = buildMetaSystemPrompt({
      purpose: context.purpose,
      firstName: context.firstName,
      readingLevel: context.readingLevel,
      todaySessions: context.todaySessions,
      todayRecord: context.todayRecord,
      weeklyGrowth: context.weeklyGrowth,
      openIdeas: context.openIdeas,
      ideaUpdates: context.ideaUpdates,
      credits: context.credits,
      // Workshop idea conversations — the SAME flag swaps the Workshop/listening
      // section for the thinking-partner contract AND wires the
      // send_idea_to_teacher tool below (IDEA_CONVOS_SPEC.md §2/§1).
      ideaConvosEnabled,
    });

    // Stamp credit moments delivered at PROMPT-BUILD time — the moment a
    // credit is woven into the chat it's delivered (at-most-once, §8).
    if (
      context.purpose === "reflection" &&
      context.creditDeliverIds.length > 0
    ) {
      await ctx.runMutation(internal.changelog.markCreditDelivered, {
        entryIds: context.creditDeliverIds,
        scholarId: context.scholarId,
        at: Date.now(),
      });
    }

    const { Anthropic } = await import("@anthropic-ai/sdk");
    const anthropic = new Anthropic({ apiKey: requireAnthropicApiKey() });

    const apiMessages = context.messages
      // Drop empties AND any stray persisted "<start>" sentinel (sendMessage
      // refuses to persist it, but a historical row must never reach the
      // model — the meta prompt, unlike the tutor's, has no <start> bullet).
      .filter((m) => m.content.trim() !== "" && m.content.trim() !== "<start>")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    // Empty thread → the day-aware OPENER. Anthropic needs a turn to answer, so
    // materialize a synthetic first user turn using the tutor's `<start>` marker
    // convention. The "don't echo it" instruction rides a dynamic system block
    // (kept OUT of the verbatim QB prompt, which stays the cached static prefix).
    let systemDynamic: string | null = null;
    if (apiMessages.length === 0) {
      apiMessages.push({ role: "user", content: "<start>" });
      systemDynamic =
        context.purpose === "reflection"
          ? 'The scholar just opened Today\'s reflection and hasn\'t written anything yet — their first message is the marker "<start>". Deliver your opening line now (per "Reflection" above), and do NOT mention or repeat "<start>".'
          : 'The scholar just opened Ask Rabbithole and hasn\'t written anything yet — their first message is the marker "<start>". Briefly invite them to ask how Rabbithole works, why it behaves a certain way, or what could be better. Do NOT mention or repeat "<start>".';
    }

    // Workshop tool wiring:
    //   - Code Explorer: read-only repo tools, always wired.
    //   - Idea conversations (WORKSHOP_IDEA_CONVOS_ENABLED, always on for Ask
    //     Rabbithole): the send_idea_to_teacher write tool.
    // A cost cap applies (the larger of the two caps). The tools close over a
    // late-bound emit (reassigned once the ReadableStream starts), the same
    // dance the other aide streams use.
    let emitSSE: AideEmit = () => {};
    const ideaCfg = ideaConvosLoopConfig(ideaConvosEnabled);
    // Guarded with the scholar's own first name: with code search credentialed,
    // a query travels to GitHub under our App token, so a kid typing their own
    // name must not put it there (same boundary as the parent aide).
    const codeTools = guardCodeToolArguments(
      await makeScholarCodeTools((data) => emitSSE(data), ctx),
      protectedTermsFromNames([context.firstName]),
    );
    // The idea tool's capture writes for the CHAT'S OWN scholar (context
    // .scholarId === the authenticated caller, enforced by
    // validateMetaStreamRequest) — never a model-supplied id, so it can't file
    // on another kid's behalf. At the open-ideas cap the mutation returns
    // `at_cap` and the tool relays a "help them prioritize" line (no throw).
    const ideaTools = ideaCfg.withTools
      ? await makeIdeaConvoTools(
          (data) => emitSSE(data),
          (a) =>
            ctx.runMutation(internal.scholarSuggestions.captureFromChat, {
              scholarId: context.scholarId,
              sourceChatId: chatId as Id<"metaChats">,
              title: a.title,
              scholarWords: a.scholarWords,
              refined: a.refined,
            }),
        )
      : [];
    const tools = [...codeTools, ...ideaTools];
    const withTools = tools.length > 0;
    const maxIterations = Math.max(
      CODE_EXPLORER_MAX_ITERATIONS,
      ideaCfg.maxIterations ?? 0,
    );

    return runAideStream({
      anthropic,
      model: MODELS.SONNET,
      maxTokens: 2048,
      system: cachedSystem(systemPrompt, systemDynamic),
      messages: apiMessages,
      tools,
      maxIterations,
      bindEmit: withTools
        ? (emit) => {
            emitSSE = emit;
          }
        : undefined,
      persist: (content) =>
        ctx.runMutation(internal.metaChat.updateStreamContent, {
          messageId: assistantMsgId as Id<"metaMessages">,
          content,
        }),
      isStopRequested: () =>
        ctx.runQuery(internal.metaChat.isStopRequested, {
          messageId: assistantMsgId as Id<"metaMessages">,
        }),
      finalize: ({ content, model, tokensUsed }) =>
        ctx.runMutation(internal.metaChat.finalizeStream, {
          messageId: assistantMsgId as Id<"metaMessages">,
          content,
          model,
          tokensUsed,
        }),
      onUsage: (usage, model) =>
        recordUsage(ctx, {
          source: "meta-chat",
          role: facts.assistantRole ?? undefined,
          institutionId: metaInstitutionId,
          model,
          usage,
        }),
      label: "meta chat",
    });
  }),
});

// CORS preflight for meta-stream
http.route({
  path: "/meta-stream",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }),
});

// ── Slack Events API (the Rabbithole Slack bot) ──────────────────────────
// Slack POSTs every subscribed event here (see review/slack-bot-plan.md).
// Contract: verify the HMAC signature BEFORE trusting anything, answer the
// one-time url_verification challenge, dedupe on event_id (Slack retries),
// and ack 200 inside Slack's 3-second budget — the real work happens in the
// scheduled internal.slackBot.handleEvent action.
http.route({
  path: "/slack/events",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const signingSecret = process.env.SLACK_SIGNING_SECRET;
    if (!signingSecret) {
      return new Response("Slack not configured", { status: 503 });
    }

    const rawBody = await request.text();
    const valid = await verifySlackSignature({
      signingSecret,
      timestampHeader: request.headers.get("x-slack-request-timestamp"),
      signatureHeader: request.headers.get("x-slack-signature"),
      rawBody,
    });
    if (!valid) {
      return new Response("Invalid signature", { status: 401 });
    }

    let payload: {
      type?: string;
      challenge?: string;
      event_id?: string;
    };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return new Response("Bad payload", { status: 400 });
    }

    // One-time handshake when the request URL is saved in the Slack app config.
    if (payload.type === "url_verification") {
      return new Response(JSON.stringify({ challenge: payload.challenge }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (payload.type === "event_callback" && payload.event_id) {
      // Never 500 past this point: a non-200 makes Slack RETRY the event,
      // and under load those retries amplify the very contention that
      // caused the failure (the 2026-06-13 prod storm). Once the signature
      // checks out, dropping one event beats a retry feedback loop.
      try {
        const { fresh } = await ctx.runMutation(internal.slackBot.claimEvent, {
          eventId: payload.event_id,
        });
        if (fresh) {
          await ctx.scheduler.runAfter(0, internal.slackBot.handleEvent, {
            payload,
          });
        }
      } catch (err) {
        console.error("Slack event intake failed (acked anyway):", err);
      }
    }

    return new Response("", { status: 200 });
  }),
});

// ── Slack interactivity (button clicks, modal submits) ───────────────────
// Same contract as /slack/events: verify the signature over the RAW body
// (form-encoded `payload=<json>`), ack an empty 200 inside Slack's 3-second
// budget, and do the work in the scheduled internal action.
http.route({
  path: "/slack/interactivity",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const signingSecret = process.env.SLACK_SIGNING_SECRET;
    if (!signingSecret) {
      return new Response("Slack not configured", { status: 503 });
    }
    const rawBody = await request.text();
    const valid = await verifySlackSignature({
      signingSecret,
      timestampHeader: request.headers.get("x-slack-request-timestamp"),
      signatureHeader: request.headers.get("x-slack-signature"),
      rawBody,
    });
    if (!valid) return new Response("Invalid signature", { status: 401 });

    const parsed = parseInteractivityBody(rawBody);
    if (!parsed.ok) return new Response("Bad payload", { status: 400 });

    try {
      await ctx.scheduler.runAfter(0, internal.slackInteractivity.handleInteraction, {
        payload: parsed.payload,
      });
    } catch (err) {
      console.error("Slack interactivity intake failed (acked anyway):", err);
    }
    return new Response("", { status: 200 });
  }),
});

// Google Workspace Events publishes Drive comment CloudEvents to Pub/Sub; its
// push subscription calls this endpoint. Auth is two-factor at the transport
// boundary: an unguessable configured URL plus Google's signed OIDC token.
http.route({
  path: "/google/events",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const authorization = await authorizeGoogleEventsPush(
      request,
      process.env.GOOGLE_EVENTS_PUSH_SECRET,
      process.env.GOOGLE_EVENTS_PUSH_SA,
    );
    if (!authorization.ok) {
      return new Response(authorization.message, {
        status: authorization.status,
      });
    }

    let event;
    try {
      event = parseGoogleEventsEnvelope(await request.json());
    } catch {
      // Authenticated but structurally unusable payloads cannot become valid on
      // retry, so ACK them rather than creating a Pub/Sub redelivery loop.
      return new Response("ignored bad payload", { status: 200 });
    }

    try {
      await ctx.runMutation(internal.googleDocsEvents.claimEvent, event);
    } catch (error) {
      console.error("Google Docs event intake failed; requesting redelivery:", error);
      return new Response("temporary intake failure", { status: 500 });
    }
    return new Response("", { status: 200 });
  }),
});



// ── Inbound parent reply email (reply-by-email → a chat message) ──────────
// Resend POSTs signed email.received metadata here. The body is then fetched
// from the Receiving API; ingest fails closed unless the sender matches the
// thread's parent and deduplicates Resend's at-least-once webhook delivery.
http.route({
  path: "/parent-message-inbound",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (!secret) {
      return new Response("inbound not configured", { status: 503 });
    }
    const rawBody = await request.text();
    const verified = await verifyResendWebhook({
      webhookSecret: secret,
      id: request.headers.get("svix-id"),
      timestamp: request.headers.get("svix-timestamp"),
      signature: request.headers.get("svix-signature"),
      payload: rawBody,
    });
    if (!verified) {
      return new Response("unauthorized", { status: 401 });
    }
    let payload: {
      type?: string;
      data?: { email_id?: string };
    };
    try {
      payload = JSON.parse(rawBody) as typeof payload;
    } catch {
      return new Response("bad json", { status: 400 });
    }
    if (payload.type !== "email.received") {
      return new Response("ignored", { status: 200 });
    }
    const emailId = payload.data?.email_id;
    if (!emailId) {
      return new Response("missing fields", { status: 400 });
    }
    let email;
    try {
      email = await retrieveReceivedEmail(emailId);
    } catch (error) {
      console.error("[parent-message] inbound email retrieval failed:", error);
      return new Response("email retrieval failed", { status: 503 });
    }
    const toAddress = findThreadReplyAddress(email);
    const fromEmail = extractEmailAddress(email.from);
    const body = extractNewReply(
      email.text ?? htmlToPlainText(email.html ?? ""),
    );
    if (!toAddress || !fromEmail || !body) {
      return new Response("missing fields", { status: 400 });
    }
    const res = await ctx.runMutation(
      internal.parentMessages.ingestInboundEmail,
      {
        toAddress,
        fromEmail,
        body,
        providerMessageId: `resend:${email.id}`,
      },
    );
    return new Response(JSON.stringify(res), {
      status: res.ok ? 200 : 202,
      headers: { "content-type": "application/json" },
    });
  }),
});

// ── Inbound WhatsApp (Meta Cloud API) ────────────────────────────────────
// Meta calls /wa-inbound two ways:
//   GET  — the one-time verification handshake (hub.mode/verify_token/challenge)
//          when you save the Callback URL in the app's WhatsApp config.
//   POST — webhook events as JSON. We verify X-Hub-Signature-256 (HMAC-SHA256 of
//          the RAW body keyed by WHATSAPP_APP_SECRET), then handle:
//            value.messages[] → inbound texts → ingestInboundPhone (opt-in
//              tokens, STOP, ordinary messages; fail-closed for unmapped).
//            value.statuses[] → delivery receipts → advance the delivery status.
// Must return 200 quickly or Meta retries.
type WaWebhook = {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{
          id?: string;
          from?: string;
          type?: string;
          text?: { body?: string };
        }>;
        statuses?: Array<{
          id?: string;
          status?: string;
          errors?: Array<{ code?: number | string }>;
        }>;
      };
    }>;
  }>;
};

http.route({
  path: "/wa-inbound",
  method: "GET",
  handler: httpAction(async (_ctx, request) => {
    const url = new URL(request.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
    if (mode === "subscribe" && verifyToken && token === verifyToken) {
      return new Response(challenge ?? "", { status: 200 });
    }
    return new Response("forbidden", { status: 403 });
  }),
});

http.route({
  path: "/wa-inbound",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const raw = await request.text();
    const sig = request.headers.get("x-hub-signature-256");
    if (!(await verifyMetaSignature(raw, sig))) {
      return new Response("unauthorized", { status: 401 });
    }
    let payload: WaWebhook;
    try {
      payload = JSON.parse(raw) as WaWebhook;
    } catch {
      return new Response("bad json", { status: 400 });
    }
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        // Inbound parent messages (text only for v1). Each item is wrapped so a
        // single mutation failure can't make us return non-200 and force Meta to
        // re-deliver the WHOLE batch (which would duplicate already-processed
        // items); ingestInboundPhone is itself idempotent on the message id.
        for (const m of value.messages ?? []) {
          const fromNumber = typeof m.from === "string" ? m.from : "";
          const messageId = typeof m.id === "string" ? m.id.trim() : "";
          const body =
            m.type === "text" && typeof m.text?.body === "string"
              ? m.text.body
              : "";
          if (!fromNumber) continue;
          try {
            await ctx.runMutation(
              internal.parentMessages.ingestInboundPhone,
              {
                channel: "whatsapp",
                fromNumber,
                body,
                messageId: messageId || undefined,
              },
            );
          } catch (e) {
            console.error("[wa-inbound] ingest failed", e);
          }
        }
        // Delivery-status receipts (sent/delivered/read/failed) — idempotent.
        for (const s of value.statuses ?? []) {
          const providerId = typeof s.id === "string" ? s.id : "";
          const status = typeof s.status === "string" ? s.status : "";
          if (!providerId || !status) continue;
          const errorCode =
            s.errors?.[0]?.code != null ? String(s.errors[0].code) : undefined;
          try {
            await ctx.runMutation(
              internal.parentMessageSend.updateDeliveryStatusByProvider,
              { providerId, twilioStatus: status, errorCode },
            );
          } catch (e) {
            console.error("[wa-inbound] status update failed", e);
          }
        }
      }
    }
    // Always 200 so Meta doesn't retry a well-formed, authenticated event.
    return new Response("", { status: 200 });
  }),
});


// ── /f REMOVED (2026-08-02) ───────────────────────────────────────────────


// ── GUEST MODE ────────────────────────────────────────────────────────────
// The unauthenticated "try it" exchange, embedded by iframe from the school
// marketing site (`app/embed/try`). Policy + topics: convex/lib/guestTutor.ts.
//
// Nothing below reads a scholar row or writes a scholar table, and no message
// text is stored or logged. The gate order is deliberate and every step is
// cheap-before-expensive: flag → origin → shape → rate limit → budget → model.

/**
 * CORS for guest mode's own (error) responses, echoed only to an allowlisted
 * caller. The 200 streaming path goes through `runAideStream`, whose
 * SSE_HEADERS hardcode `Access-Control-Allow-Origin: *` for every aide stream
 * — harmless here (the endpoint carries no cookies or auth to steal, and the
 * origin check has already run) but worth knowing before you read the echo
 * below as the whole policy.
 */
function guestCorsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    // The allowlist is per-origin, so caches must not serve one embedder's
    // response to another.
    Vary: "Origin",
  };
}

const GUEST_JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
} as const;

/**
 * What the Next page asks before rendering: is guest mode on for THIS Convex
 * deployment, and what are the three topics?
 *
 * Serving the catalog from here (rather than importing it into the page) means
 * the flag and the topics have exactly one home, so the embed can never render
 * a topic the stream would refuse. Uncached on purpose: flipping the env var
 * should take effect on the next page load, with no web redeploy.
 */
http.route({
  path: "/guest-tutor/config",
  method: "GET",
  handler: httpAction(async () => {
    // 404, not `{"enabled": false}`. A dark deployment should not advertise
    // that there is something here to turn on — and the page already treats
    // any non-ok response as off, so this costs nothing.
    if (!isGuestTutorEnabled()) {
      return new Response("Not found", {
        status: 404,
        headers: { "Cache-Control": "no-store" },
      });
    }
    return new Response(
      JSON.stringify({
        enabled: true,
        maxTurns: GUEST_MAX_TURNS,
        closingLine: GUEST_CLOSING_LINE,
        caption: GUEST_CAPTION,
        topics: GUEST_TOPICS.map((topic) => ({
          id: topic.id,
          title: topic.title,
        })),
      }),
      {
        status: 200,
        headers: { ...GUEST_JSON_HEADERS, "Access-Control-Allow-Origin": "*" },
      },
    );
  }),
});

http.route({
  path: "/guest-tutor-stream",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, request) => {
    const origin = request.headers.get("Origin");
    if (
      !isGuestTutorEnabled() ||
      !isGuestOriginAllowed(origin, {
        allowLocalhost: guestTutorAllowsLocalhost(),
      })
    ) {
      // No CORS headers at all — the browser turns this into the network
      // error it should be, and a disallowed embedder learns nothing.
      return new Response(null, { status: 403 });
    }
    return new Response(null, {
      status: 204,
      headers: {
        ...guestCorsHeaders(origin!),
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
      },
    });
  }),
});

/**
 * One guest turn.
 *
 * Stateless by design: the client posts the whole transcript every time and we
 * persist none of it, so closing the tab is the delete. The turn cap is
 * enforced from that posted transcript (a client that lies is refused), and
 * the per-IP cap bounds how often lying is worth trying.
 *
 * TODO(captcha) — deliberately out of scope for the preview. What stands
 * between this endpoint and a scripted caller today is the per-request rate
 * limits; the `Origin` check is NOT part of that argument, because a script
 * sets that header with one flag. The limits bound the bill and turn away
 * casual abuse, but a determined attacker driving a browser is not stopped.
 *
 * When we want one, this is the hook: take a `captchaToken` off the body here
 * and verify it server-side against the provider. Every turn claims a
 * rate-limit slot now, so the natural place to demand a token is the OPENING
 * turn — the one a human actually performs — with continuations carrying the
 * verified token forward. Nothing else in this file has to change.
 */
http.route({
  path: "/guest-tutor-stream",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const startedAt = Date.now();
    const origin = request.headers.get("Origin");

    // 1. Flag. A deployment that has not opted in behaves as if the route does
    //    not exist — no hint that there is something here to turn on.
    if (!isGuestTutorEnabled()) {
      return new Response("Not found", { status: 404 });
    }

    // 2. Origin. This refuses another SITE's page calling the endpoint
    //    directly. It cannot police who framed us — the request comes from the
    //    iframe document, which we serve, so the header is always our own
    //    origin. `frame-ancestors` is that control. Not authentication: a
    //    script sets this header with one flag.
    if (
      !isGuestOriginAllowed(origin, {
        allowLocalhost: guestTutorAllowsLocalhost(),
      })
    ) {
      return new Response(sseEvent({ error: "Forbidden" }), {
        status: 403,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    const cors = guestCorsHeaders(origin!);
    const errorHeaders = {
      "Content-Type": "text/event-stream",
      ...cors,
    };

    // 3. Shape: a known topic and a transcript that validates.
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(sseEvent({ error: "Bad request." }), {
        status: 400,
        headers: errorHeaders,
      });
    }
    const { topic: topicId, messages: rawMessages } = (body ?? {}) as {
      topic?: unknown;
      messages?: unknown;
    };
    const topic =
      typeof topicId === "string" ? guestTopicById(topicId) : null;
    if (!topic) {
      return new Response(sseEvent({ error: "Bad request." }), {
        status: 400,
        headers: errorHeaders,
      });
    }
    const transcript = checkGuestTranscript(rawMessages ?? []);
    if (!transcript.ok) {
      return new Response(sseEvent({ error: transcript.error }), {
        status: 400,
        headers: errorHeaders,
      });
    }
    const isOpening = transcript.turns.length === 0;
    const turnsLeft = GUEST_MAX_TURNS - transcript.guestTurnsUsed;

    // 4. Rate limits, claimed on EVERY request. Claiming only on the opening
    //    turn was the original bug: the conversation lives in the client, so a
    //    caller who never posts an empty transcript never takes that branch
    //    and skips every cap. Both scopes are checked and charged in one
    //    serializable mutation, so a race can't oversell the last slot.
    const ipHash = await hashGuestIp(
      guestClientIp(request.headers),
      process.env.GUEST_TUTOR_IP_SALT ?? process.env.CONVEX_CLOUD_URL ?? "rh",
    );
    const claim = await ctx.runMutation(internal.guestTutor.claimGuestTurn, {
      ipHash,
      topic: topic.id,
      isOpening,
      nowMs: startedAt,
    });
    if (!claim.ok) {
      // The hop COUNT, never the addresses. `guestClientIp` takes the LAST
      // x-forwarded-for entry, which is the real client only when exactly one
      // proxy appends. More than one hop would mean every visitor shares a
      // bucket — silently — so it is worth being able to see.
      console.log(
        `[guest-tutor] refused cap=${claim.reason} xff_hops=${
          request.headers.get("x-forwarded-for")?.split(",").length ?? 0
        }`,
      );
      return new Response(sseEvent({ error: GUEST_RATE_LIMITED_MESSAGE }), {
        status: 429,
        headers: errorHeaders,
      });
    }

    // 5. The shared cost circuit breaker, after the caps so it can't be probed
    //    for free. Inert unless LLM_DAILY_BUDGET_USD is set.
    const overBudget = await llmBudgetExceeded(ctx);
    if (overBudget !== null) {
      return new Response(
        sseEvent({ error: GUEST_RATE_LIMITED_MESSAGE }),
        { status: 429, headers: errorHeaders },
      );
    }

    // 6. The tutor. The system prompt is the PUBLISHED one, unchanged: an
    //    all-null context yields exactly the base + soul sections (every
    //    per-scholar section has no data and drops out), and the capabilities
    //    are declared honestly as none, because guest mode hands the model no
    //    tools. The guest framing rides in an ephemeral user-role instruction,
    //    the same device `kickoffInstruction()` uses for a real activity — so
    //    nobody has to maintain a second, quietly-diverging tutor prompt.
    const systemPrompt = buildTutorSystemPrompt({
      teacherWhisper: null,
      readingLevel: null,
      scholarName: null,
      unitContext: null,
      personaContext: null,
      perspectiveContext: null,
      processContext: null,
      processStateData: null,
      artifactData: null,
      appStateContext: null,
      dossierContent: null,
      documentNotes: null,
      seeds: [],
      masteryContext: null,
      signalContext: null,
      timingContext: null,
      lessonContext: null,
      teacherDirectives: [],
      goals: [],
      weeklyGoals: [],
      lessonActivityContext: null,
      priorActivityContext: null,
      gameRoundContexts: null,
      activityContext: null,
      standaloneDeliverableContext: null,
      currentVerdictsContext: null,
      advanceRubricContext: null,
      conversationCompletionContext: null,
      practiceSkillsContext: null,
      isFirstTurn: isOpening,
      isFirstSession: true,
      lastSessionAt: null,
      webPracticeContext: null,
      granuleStatusContext: null,
      activityRecipe: null,
      baselineEvidenceContext: null,
      seedOriginContext: null,
      physicalEnvironmentContext: null,
      runtimeCapabilities: {
        canShareResources: false,
        canScoreRubrics: false,
        canMarkActivityComplete: false,
      },
    });

    // The kickoff instruction leads EVERY request, not just the opening one.
    // A continuation's transcript starts with the tutor's opening question, and
    // a message list whose first entry is an assistant turn is at best
    // unsupported by the Messages API; leading with the same user-role
    // instruction also keeps the topic (and the council seed) in view for the
    // whole exchange rather than only its first turn.
    const apiMessages = [
      { role: "user" as const, content: guestKickoffInstruction(topic) },
      ...transcript.turns.map((turn) => ({
        role: turn.role,
        content: turn.content,
      })),
      ...(isOpening
        ? []
        : [
            {
              role: "user" as const,
              content: guestTurnInstruction(turnsLeft),
            },
          ]),
    ];

    const { Anthropic } = await import("@anthropic-ai/sdk");
    const anthropic = new Anthropic({ apiKey: requireAnthropicApiKey() });

    const turnIndex = transcript.guestTurnsUsed;
    return runAideStream({
      anthropic,
      model: MODELS.SONNET,
      // A guest turn is a question, not an essay. The cap is a floor under
      // cost and a nudge toward the brevity the prompt already asks for.
      maxTokens: 700,
      system: cachedSystem(systemPrompt),
      messages: apiMessages,
      tools: [],
      // Nothing to persist: the transcript lives in the visitor's tab and
      // nowhere else. These are the "no persistence beyond the session" clause,
      // expressed as code rather than a promise in a doc.
      persist: async () => undefined,
      finalize: async () => undefined,
      onComplete: async () => {
        logGuestTurn({
          topic: topic.id,
          turnIndex,
          ms: Date.now() - startedAt,
          outcome: "ok",
        });
      },
      onUsage: (usage, model) =>
        // No role and no institution: a guest belongs to no school, and
        // guessing the primary one would put marketing spend on a tenant's
        // ledger. `source` alone makes the cost legible.
        recordUsage(ctx, { source: "guest-tutor", model, usage }),
      label: "guest tutor",
    });
  }),
});

export default http;
