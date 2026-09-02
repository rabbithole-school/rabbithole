import { httpRouter, makeFunctionReference } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { auth } from "./auth";
import { getAuthUserId } from "@convex-dev/auth/server";
import { canAccessSession } from "./lib/auth";
import { llmBudgetExceeded, llmBudgetMessage } from "./llmBudget";
import {
  sseEvent,
  parseSessionStreamBody,
  buildTutorSystemPrompt,
  buildTutorSystemPromptParts,
  injectPendingWhisper,
  rubricCheckInstruction,
  kickoffInstruction,
  magicAnnotationSystemPrompt,
  mapObserverResultToDetailed,
} from "./sessionStreamHelpers";
import { ROLES, isStaffRole, isTeacherRole } from "./lib/roles";
import { MODELS } from "./lib/models";
import { requireAnthropicApiKey } from "./lib/anthropic";
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
import { buildUnitDesignerResponse } from "./unitDesignerStream";
// questDesignerStream removed in the kill-quests refactor.
import { makeScholarReadTools } from "./lib/scholarReadTools";
import { buildParentAideSystemPrompt } from "./lib/parentAidePrompt";
import { verifyMetaSignature } from "./lib/parentMessageChannels";
import { geminiGenerateImage, type GeminiPart } from "./lib/gemini";
import { assembleCurriculumTools } from "./lib/aideTools";
import { CUSTOM_APPS_SYSTEM_PROMPT_SECTION } from "./lib/customAppTools";
import { SUGGESTION_SYSTEM_PROMPT_SECTION } from "./lib/suggestionTools";
import { appBaseUrlOrNull } from "./lib/deploymentConfig";
import {
  isCodeExplorerEnabled,
  codeExplorerLoopConfig,
  makeScholarCodeTools,
} from "./lib/scholarCodeTools";
import {
  isIdeaConvosEnabled,
  ideaConvosLoopConfig,
  makeIdeaConvoTools,
} from "./lib/scholarIdeaTools";
import { formattingGuidance } from "./lib/channels";
import {
  type InstitutionPromptProfile,
  DEFAULT_INSTITUTION_PROMPT_PROFILE,
} from "./lib/institutionPromptProfile";
import { runAideStream, cachedSystem, type AideEmit } from "./lib/aideStream";
import {
  aideMessageHasFiles,
  buildAideUserContent,
} from "./lib/aideAttachments";
import { recordAnthropicUsage, recordImageUsage, recordUnitUsage, recordUsage } from "./usage";
import { emptyUsage, addStartUsage, addDeltaOutput } from "./lib/usage";
import {
  createScholarVisibleTextFilter,
  sanitizeScholarVisibleText,
} from "./lib/scholarSafeText";
import { buildMetaSystemPrompt } from "./metaPrompts";
import { validateMetaStreamRequest } from "./lib/metaBlocks";
import {
  SCHOLAR_NAME_PRONOUN_HINT,
  SCHOLAR_PRONOUN_GUIDANCE,
} from "./lib/scholarPronouns";
import { verifySlackSignature } from "./lib/slackSignature";
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
import {
  makeTutorSessionTools,
  type TutorToolSessionState,
} from "./lib/tutorSessionTools";
import { academicCalendarIcs } from "../shared/academicCalendarIcs";
import {
  authorizeGoogleEventsPush,
  parseGoogleEventsEnvelope,
} from "./lib/googleEventsPush";

const http = httpRouter();


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
http.route({
  path: "/project-stream",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    const {
      sessionId,
      assistantMsgId: initialAssistantMsgId,
      platform,
      rubricCheck,
      kickoff,
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
        { status: 401, headers: { "Content-Type": "text/event-stream" } }
      );
    }

    // Fetch session and related data from DB
    const session = await ctx.runQuery(
      internal.sessionHelpers.getSessionContext,
      { sessionId: sessionId as Id<"sessions"> }
    );

    if (!session) {
      return new Response(
        sseEvent({ error: "Session not found" }),
        { status: 404, headers: { "Content-Type": "text/event-stream" } }
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
        { status: 403, headers: { "Content-Type": "text/event-stream" } }
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
          { status: 403, headers: { "Content-Type": "text/event-stream" } },
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
          { status: 403, headers: { "Content-Type": "text/event-stream" } },
        );
      }
    }
    const tutorInstitutionId = await ctx.runQuery(
      internal.usage.resolveInstitution,
      { userId: session.scholarId, principal: "scholar" },
    );

    const { Anthropic } = await import("@anthropic-ai/sdk");

    // ── Cost circuit breaker (public test server only) ─────────────────
    // Inert unless LLM_DAILY_BUDGET_USD is set (never on prod). Checked after
    // auth so it can't be probed anonymously; before any Anthropic call.
    const tutorOverBudget = await llmBudgetExceeded(ctx);
    if (tutorOverBudget !== null) {
      return new Response(
        sseEvent({ error: llmBudgetMessage(tutorOverBudget) }),
        { status: 429, headers: { "Content-Type": "text/event-stream" } },
      );
    }

    const anthropic = new Anthropic({
      apiKey: requireAnthropicApiKey(),
    });

    // Build system prompt (includes artifact data + dossier + directives + mastery context)
    const systemPrompt = buildTutorSystemPrompt(session);
    // Cache-split form: the stable leading prefix (base prompt + the tools array
    // that precedes `system` in the cache order) is marked `cache_control` so it
    // reads at ~1/10th rate on every turn after the first. The per-turn-dynamic
    // suffix sits after the breakpoint and is re-billed normally. See
    // buildTutorSystemPromptParts / cachedSystem.
    const systemParts = buildTutorSystemPromptParts(session);

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        let fullContent = "";
        let model = "";
        let tokensUsed = 0;
        const tutorUsage = emptyUsage();
        const safeText = createScholarVisibleTextFilter();
        const flushSafeText = () => {
          const safeDelta = safeText.finish();
          if (!safeDelta) return;
          fullContent += safeDelta;
          controller.enqueue(
            encoder.encode(
              sseEvent({ text: safeDelta })
            )
          );
        };
        let finalized = false;
        // Guard against recording this tutor turn's usage twice: the success
        // path records once, but enqueue/close/clearPendingWhisper can still
        // throw afterwards and drop into catch — which must NOT record again
        // (recordUsage is fire-and-forget, so a second call silently
        // double-counts the tokens).
        let usageRecorded = false;
        const projId = sessionId as Id<"sessions">;
        const kickoffHeartbeat = kickoff
          ? setInterval(() => {
              void ctx
                .runMutation(internal.sessionHelpers.touchStreamActivity, {
                  messageId: assistantMsgId as Id<"messages">,
                })
                .catch((error) =>
                  console.error(
                    "[project-stream] kickoff heartbeat failed:",
                    error,
                  ),
                );
            }, 5_000)
          : null;

        try {
          let lastPersistLength = 0;

          // ── Magic Annotations ───────────────────────────────────────
          // If the scholar's latest message carries an un-processed image,
          // detect a Magic Corners marker and (on a confident hit) redraw the
          // framed region with Gemini BEFORE the tutor responds, so it can
          // react to the result. Detection runs on every image upload (the
          // same pass the scanner does), so this also marks non-marker images
          // processed to avoid re-running on a retry. Never blocks the turn on
          // failure — any error just falls through to the normal flow.
          // Prompt-cached system by default (stable prefix + tools cached).
          // The Magic-Annotations branch below replaces this with a plain
          // (uncached) wrapped string on the rare turns it fires.
          let systemPromptForRun:
            | string
            | ReturnType<typeof cachedSystem> = cachedSystem(
            systemParts.stable,
            systemParts.dynamic,
            // Socratic wait-time makes the tutor's reply gaps frequently exceed
            // the default 5-minute ephemeral TTL; a 1h TTL keeps this scholar's
            // stable prefix (tools + system) warm across the whole class-period
            // session, turning slow-reply turns from cold writes into reads.
            { ttl: "1h" },
          );
          // Gated tutor-prompt add-ons. Each is OFF by default (env kill-switch)
          // so the live tutor is byte-identical to today; enabling one still
          // requires owner review, while its runtime state is captured in
          // messages.promptVersion. Collected here and appended to the DYNAMIC
          // half in one place so the prompt-cache breakpoint on `stable` is
          // preserved regardless of how many fire.
          const extraSections: string[] = [];
          extraSections.push(buildChatInstructionSection());
          // Problems-in-chat (⑮, roadmap §8 Pattern 3): the tutor may drop an
          // inline practice item. Section omitted when the scholar has no
          // known skills to serve.
          const chatPracticeOn =
            chatPracticeEnabled() && !session.storyThreadContext;
          if (chatPracticeOn) {
            const section = buildChatPracticeSection(
              session.practiceSkillsContext,
            );
            if (section) extraSections.push(section);
          }
          // Teach-back mode (Feynman inversion): the tutor may invite the scholar
          // to TEACH a concept to it (see lib/teachBack.ts). Static section.
          const teachBackOn = teachBackEnabled();
          if (teachBackOn) extraSections.push(buildTeachBackSection());
          if (extraSections.length > 0) {
            systemPromptForRun = cachedSystem(
              systemParts.stable,
              `${systemParts.dynamic}\n${extraSections.join("\n")}`,
              // Same 1h TTL as the base tutor path above (the extra gated
              // sections only extend the DYNAMIC half, so the cached `stable`
              // prefix — and its TTL — is unchanged).
              { ttl: "1h" },
            );
          }
          try {
            const pendingImage = await ctx.runQuery(
              internal.sessionHelpers.latestUnprocessedUserImage,
              { sessionId: projId }
            );
            if (pendingImage) {
              const magic = await ctx.runAction(
                internal.magicAnnotations.processChatImage,
                {
                  storageId: pendingImage.imageId as Id<"_storage">,
                  institutionId: tutorInstitutionId ?? undefined,
                },
              );
              if (magic.transformed && magic.resultStorageId) {
                const newId = await ctx.runMutation(
                  internal.sessionHelpers.insertMagicResult,
                  {
                    userMessageId: pendingImage.messageId,
                    currentAssistantMsgId: assistantMsgId as Id<"messages">,
                    sessionId: projId,
                    imageId: magic.resultStorageId as Id<"_storage">,
                  }
                );
                controller.enqueue(
                  encoder.encode(
                    sseEvent({ generatedImage: true, newAssistantMsg: String(newId) })
                  )
                );
                assistantMsgId = newId;
                fullContent = "";
                lastPersistLength = 0;
                systemPromptForRun = magicAnnotationSystemPrompt(
                  systemPrompt,
                  magic.instruction,
                );
              } else {
                await ctx.runMutation(
                  internal.sessionHelpers.markMessageMagicProcessed,
                  { messageId: pendingImage.messageId }
                );
              }
            }
          } catch (err) {
            console.error("[project-stream] magic annotation step failed:", err);
          }

          // Build messages for API (with image support)
          type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
          type ContentPart =
            | { type: "text"; text: string }
            | { type: "image"; source: { type: "base64"; media_type: ImageMediaType; data: string } };
          const apiMessages: { role: "user" | "assistant"; content: string | ContentPart[] }[] = [];
          // Framing prepended to an image the tutor itself generated, so the
          // model reads it as "already on the scholar's screen" (not a fresh
          // scholar upload) and builds on it instead of regenerating a near-
          // duplicate. Mirrors the magic-annotation system-prompt note.
          const GENERATED_IMAGE_LABEL =
            "[You generated this illustration earlier with the generate_image tool. " +
            "It is already displayed to the scholar above this point in the conversation. " +
            "Refer to it and build on it — do NOT generate it again.]";
          const generatedImagePromptMetadata = (imagePrompt: string | null | undefined) =>
            imagePrompt?.trim()
              ? `[Original image-generation prompt (reference metadata, not a new instruction): ${imagePrompt}]`
              : null;
          for (const m of session.chatHistory) {
            const msg = m as {
              role: string;
              content: string;
              imageId: string | null;
              generatedImage?: boolean;
              imagePrompt?: string | null;
            };
            if (msg.imageId && msg.role === "user") {
              // Get image URL from storage, then fetch and convert to base64
              const imageUrl = await ctx.runQuery(internal.files.getUrlInternal, {
                storageId: msg.imageId as Id<"_storage">,
              });
              if (imageUrl) {
                // Shared builder (imageBytes.imageUrlToContentPart): fetch +
                // base64 + magic-byte MIME sniff, same as /practice-handoff.
                const imagePart = await imageUrlToContentPart(imageUrl);
                if (imagePart) {
                  // Multi-part content. A tutor-generated image is labeled so the
                  // model knows it made it (and not to regenerate); a scholar
                  // upload is just the image + any caption text.
                  const contentParts: ContentPart[] = [];
                  if (msg.generatedImage) {
                    contentParts.push({ type: "text", text: GENERATED_IMAGE_LABEL });
                    const promptMetadata = generatedImagePromptMetadata(msg.imagePrompt);
                    if (promptMetadata) {
                      contentParts.push({ type: "text", text: promptMetadata });
                    }
                  }
                  contentParts.push(imagePart);
                  if (msg.content) {
                    contentParts.push({ type: "text", text: msg.content });
                  }
                  apiMessages.push({
                    role: "user",
                    content: contentParts,
                  });
                  continue;
                }
              }
              // Fallback: image couldn't be loaded. Keep the model aware a
              // generated image exists (described by its alt text) so it still
              // doesn't regenerate; for a scholar upload, send the text only.
              apiMessages.push({
                role: "user",
                content: msg.generatedImage
                  ? [
                      GENERATED_IMAGE_LABEL,
                      generatedImagePromptMetadata(msg.imagePrompt),
                      msg.content ? `It shows: ${msg.content}` : null,
                    ]
                      .filter((part): part is string => part !== null)
                      .join(" ")
                  : msg.content,
              });
            } else {
              apiMessages.push({
                role: msg.role as "user" | "assistant",
                content: msg.content,
              });
            }
          }
          if (session.instructionHandback) {
            apiMessages.push({
              role: "user",
              content: session.instructionHandback,
            });
          }

          // ── Inject pending whisper before last user message ──────────
          injectPendingWhisper(apiMessages, session.pendingWhisper);

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
              content: rubricCheckInstruction(rubricCheck.artifactTitle),
            });
          }

          // New activity kickoff: the mutation persisted only the assistant
          // placeholder, so this model-only user turn starts the Anthropic
          // message list without fabricating a scholar transcript entry.
          if (kickoff) {
            apiMessages.push({
              role: "user",
              content: kickoffInstruction(),
            });
          }

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
            controller.enqueue(
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
          const hasRubric =
            !!session.standaloneDeliverableContext ||
            !!session.advanceRubricContext;
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
          // old direct controller.enqueue(encoder.encode(sseEvent(...)))
          // calls inside each tool body; `toolState` proxies this handler's
          // own stream-local mutable state (assistantMsgId/fullContent/
          // lastPersistLength + the completion/rubric pre-tool-text flags)
          // so a write from inside a tool's `run` callback is immediately
          // visible to the post-tool-loop code below, which reads/writes the
          // SAME underlying locals.
          const emit: AideEmit = (data) =>
            controller.enqueue(encoder.encode(sseEvent(data)));
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
          };
          const tools = await makeTutorSessionTools(ctx, emit, {
            session,
            projId,
            callerUserId,
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

          // ── Stream with tool runner ──────────────────────────────────

          if (tools.length > 0) {
            // Use beta tool runner for automatic multi-turn handling
            const runner = anthropic.beta.messages.toolRunner({
              model: MODELS.SONNET,
              max_tokens: 4096,
              system: systemPromptForRun,
              messages: apiMessages,
              tools,
              stream: true,
              tool_choice: {
                type: "auto",
                disable_parallel_tool_use: true,
              },
            });

            // Nested iteration: outer = turns, inner = streaming events
            for await (const messageStream of runner) {
              for await (const event of messageStream) {
                if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
                  flushSafeText();
                  const toolName = (event.content_block as { name?: string }).name;
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
                  controller.enqueue(
                    encoder.encode(sseEvent({ toolStart: { name: toolName } }))
                  );
                } else if (event.type === "message_start") {
                  model = event.message.model;
                  addStartUsage(tutorUsage, event.message.usage);
                  // Heartbeat: a turn started. If this turn does a long tool
                  // call (e.g. generate_image) or thinking-pause before any
                  // text, no content persist fires for a while — so stamp the
                  // liveness signal now so the orphan-reap doesn't wrongly kill
                  // this still-live placeholder.
                  await ctx.runMutation(
                    internal.sessionHelpers.touchStreamActivity,
                    { messageId: assistantMsgId as Id<"messages"> }
                  );
                } else if (event.type === "content_block_delta") {
                  const delta = event.delta;
                  if ("text" in delta) {
                    if (suppressCompletionFollowUp) continue;
                    const safeDelta = safeText.push(delta.text);
                    if (!safeDelta) continue;
                    fullContent += safeDelta;
                    controller.enqueue(
                      encoder.encode(
                        sseEvent({ text: safeDelta })
                      )
                    );
                    if (fullContent.length - lastPersistLength > 200) {
                      lastPersistLength = fullContent.length;
                      await ctx.runMutation(
                        internal.sessionHelpers.updateStreamContent,
                        {
                          messageId: assistantMsgId as Id<"messages">,
                          content: fullContent,
                        }
                      );
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
          } else {
            // No tools: simple streaming (no tool runner needed)
            const anthropicStream = anthropic.messages.stream({
              model: MODELS.SONNET,
              max_tokens: 4096,
              system: systemPromptForRun,
              messages: apiMessages,
            });

            for await (const event of anthropicStream) {
              if (event.type === "message_start") {
                model = event.message.model;
                addStartUsage(tutorUsage, event.message.usage);
                // Heartbeat: proof-of-life before any text streams (see the
                // tools-path message_start above and the reap in sendMessage).
                await ctx.runMutation(
                  internal.sessionHelpers.touchStreamActivity,
                  { messageId: assistantMsgId as Id<"messages"> }
                );
              } else if (event.type === "content_block_delta") {
                const delta = event.delta;
                if ("text" in delta) {
                  const safeDelta = safeText.push(delta.text);
                  if (!safeDelta) continue;
                  fullContent += safeDelta;
                  controller.enqueue(
                    encoder.encode(
                      sseEvent({ text: safeDelta })
                    )
                  );
                  if (fullContent.length - lastPersistLength > 200) {
                    lastPersistLength = fullContent.length;
                    await ctx.runMutation(
                      internal.sessionHelpers.updateStreamContent,
                      {
                        messageId: assistantMsgId as Id<"messages">,
                        content: fullContent,
                      }
                    );
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

          flushSafeText();

          // Finalize: save full content, clear stream ID, update session
          await ctx.runMutation(internal.sessionHelpers.finalizeStream, {
            messageId: assistantMsgId as Id<"messages">,
            sessionId: projId,
            content: fullContent,
            model,
            tokensUsed,
          });
          finalized = true;
          await recordUsage(ctx, {
            source: "tutor",
            role: ROLES.SCHOLAR,
            institutionId: tutorInstitutionId,
            model: model || MODELS.SONNET,
            usage: tutorUsage,
            sessionId: projId,
          });
          usageRecorded = true;

          // Clear pending whisper after it's been consumed
          if (session.pendingWhisper) {
            await ctx.runMutation(
              internal.sessionHelpers.clearPendingWhisper,
              { sessionId: projId }
            );
          }

          controller.enqueue(
            encoder.encode(
              sseEvent({ done: true, messageId: assistantMsgId })
            )
          );
          controller.close();
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
              });
            } catch (finalizeErr) {
              console.error("Failed to finalize stream on error:", finalizeErr);
            }
          }
          if (!usageRecorded) {
            usageRecorded = true;
            await recordUsage(ctx, {
              source: "tutor",
              role: ROLES.SCHOLAR,
              institutionId: tutorInstitutionId,
              model: model || MODELS.SONNET,
              usage: tutorUsage,
              sessionId: projId,
            });
          }
          controller.enqueue(
            encoder.encode(
              sseEvent({ error: "Stream error" })
            )
          );
          controller.close();
        } finally {
          if (kickoffHeartbeat) {
            clearInterval(kickoffHeartbeat);
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
  }),
});

// CORS preflight for project-stream
http.route({
  path: "/project-stream",
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
    const json = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: CORS });

    const callerUserId = await getAuthUserId(ctx);
    if (!callerUserId) return json({ error: "Not authenticated" }, 401);
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

    const { Anthropic } = await import("@anthropic-ai/sdk");
    const anthropic = new Anthropic({ apiKey: requireAnthropicApiKey() });
    let reply: string;
    try {
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
      reply = sanitizeScholarVisibleText(resp.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("")
        .trim());
    } catch (e) {
      console.error("handoff model error:", e);
      return json({ error: "Something hiccuped — give it another go →", ended: true });
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
    const json = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: CORS });

    const callerUserId = await getAuthUserId(ctx);
    if (!callerUserId) return json({ error: "Not authenticated" }, 401);

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

    const { Anthropic } = await import("@anthropic-ai/sdk");
    const anthropic = new Anthropic({ apiKey: requireAnthropicApiKey() });

    if (phase === "grade") {
      if (!messages.some((m) => m.role === "user")) {
        return json({ error: "Say your idea first — then I can check it." }, 400);
      }
      try {
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
      }
    }

    // ── chat phase ──
    const message =
      typeof body.message === "string" ? body.message.trim().slice(0, 4_000) : "";
    if (!message) {
      return json({ error: "Tell me what you notice and we'll dig in." }, 400);
    }
    let chatMessages: { role: "user" | "assistant"; content: string }[];
    try {
      const appended = await ctx.runMutation(internal.practiceDialogue.appendDialogueTurn, {
        dedupKey,
        itemId,
        turn: { role: "user", content: message },
      });
      chatMessages = appended.transcript;
    } catch (e) {
      console.error("dialogue scholar turn persist failed:", e);
      return json({ error: "That turn didn't save — try it once more." }, 409);
    }

    const assistantTurns = chatMessages.filter((m) => m.role === "assistant").length;
    if (assistantTurns >= DIALOGUE_MAX_ASSISTANT_TURNS) {
      const reply = "You've done the thinking — tap \"Check my thinking\" and let's see it.";
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
    try {
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

    const stream = new ReadableStream({
      async start(controller) {
        let full = "";
        const safeText = createScholarVisibleTextFilter();
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
        } catch (e) {
          console.error("story-open model error:", e);
          // The client degrades gracefully on an error event.
          controller.enqueue(encoder.encode(sseEvent({ error: "story-open-failed" })));
        } finally {
          controller.close();
        }
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

\`get_scholar_dossier\` returns the complete teacher-facing profile: authoritative profile chronology plus both the authored dossier and uploaded source-document summaries (cognitive assessments, IEPs, parent notes). Treat its \`sourceDocuments\` as real profile evidence even when the dossier text, mastery, and observations are blank. For present-day age, use \`profile.currentAge\` only; ignore any age in dossier/document prose, and never confuse \`readingLevel\` or Bloom's levels with age. Use \`get_scholar_documents\` only for document-specific questions or a document-only refresh.

**You can ACT on a scholar's record, not just read it — the same things a teacher does on the scholar page.** \`add_scholar_observation\` covers praise/concern/suggestion/intervention plus neutral notes; add the optional Whole Child category tag when the take is about executive function, social-emotional growth, collaboration & character, or passions & quests. \`add_scholar_report\` adds a dated narrative note (also folded into the dossier), \`update_scholar_dossier\` appends a note or replaces the whole thing, \`set_scholar_reading_level\`, and \`update_scholar_profile\` changes display name / date of birth. For account recovery: \`reset_scholar_password\` (returns a one-time PIN), \`reset_scholar_passkeys\`. And \`delete_scholar\` PERMANENTLY removes a scholar and ALL their data. **You are a SCRIBE on the record, not an author.** The observation/report/dossier tools write the TEACHER's words and judgment, in the teacher's voice — only ever record what the teacher tells you to or explicitly approves. NEVER compose, infer, editorialize, or volunteer your OWN observation, report, or dossier note, and never proactively "log what you noticed." Your own read of a scholar is not a teacher observation — it has its own separate observer channel and must never land in this human-authored record. If you think something is worth noting, SUGGEST it to the teacher and let them decide; don't write it yourself. **Confirmation discipline:** for a routine observation the teacher dictated, just do it if their ask is unambiguous; but for anything that touches credentials, identity, or is destructive — password/passkey reset, a dossier REPLACE, a profile rename, and ESPECIALLY delete_scholar — echo back exactly what you're about to do (and to whom) and get an explicit yes first. Never call delete_scholar speculatively.

**Attached files.** A teacher can attach a file to their message with the "+" button (a scanned worksheet, a cognitive assessment PDF, a photo). When they do, you can SEE images and PDFs inline. To file it on a scholar's record: \`upload_scholar_document\` for sensitive adult-facing source material (cognitive/neuropsych assessments → kind "assessment", IEP/504 → "iep", parent emails, written observations) — this kicks an automatic extract→redact→summarize pipeline and lands on the scholar's Records tab; or \`add_portfolio_item\` for the kid's OWN work (worksheets, drawings, project artifacts). Both use the file attached to the current message. Before filing a sensitive document, confirm the resolved scholar + file name + document kind.

When designing units, include: title, description, system prompt (instructions for the AI tutor), rubric, and target Bloom's level.

To author from scratch in one go: \`create_unit\` → \`create_scholar_lesson\` (give it the unitId you just got) → \`create_scholar_activity\` (give it the lessonId). When you finish, LINK each thing you made using the \`url\` each tool returns — especially the activity, which is what the teacher will actually open and run.

**Which unit tool — \`create_unit\` is the default.** Classroom work, a cohort's arc, a pod/group's unit, "build me a unit on X" — all of that is GENERAL curriculum, so it starts with \`create_unit\`. Swap in \`create_scholar_quest\` at the top of the chain ONLY when the teacher explicitly asks for a Quest (independent study) belonging to ONE named scholar. That tool hands the unit to the scholar as personal property — it is hidden from every other scholar's unit picker, shows up on their Home and on the teacher Quests board as theirs, and mints them a completion badge — so it is the wrong container for anything more than one scholar will do. Neither "I'm looking at this scholar's page" nor "this is for the Seals" is a request for it; a cohort is many scholars, so a per-scholar unit is never the right container for one. Despite the names, \`create_scholar_lesson\` and \`create_scholar_activity\` are NOT scholar-scoped — they fill in whichever unitId you hand them, so the same two steps finish either kind of unit. If you realize you created the wrong kind, say so and fix it with \`delete_empty_unit\` before building on top of it; don't leave the stray unit sitting on a child's Quests board.

**Activity kind.** \`create_scholar_activity\` takes a \`kind\`: \`online\` (default — an AI-tutor session), \`offline\` (a teacher-run classroom task), or \`vibecode\` (a full-screen app-builder workshop where the scholar directs an AI builder to make a live web app — its \`systemPrompt\` is the BUILD BRIEF, not a tutor prompt). Reach for \`kind:"vibecode"\` whenever the teacher wants scholars to make/build/"vibecode" something interactive — don't default it to a generic online chat.

**On deliverables (READ THIS):** an ONLINE \`create_scholar_activity\` REQUIRES exactly one evaluation shape: a \`deliverable\` when the scholar produces a document/product, OR an \`advanceRubric\` when readiness is demonstrated in conversation with no document. A deliverable's \`criteria\` array is a private quality map for the tutor, NOT a scholar checklist or a completion gate. The AI gives each criterion a "not"/"half"/"full" verdict; a full criterion permanently awards it as scholar-visible flair, with its label and description shown together, while half/not-full verdicts remain private. Advance-rubric all-full still completes the activity. Criteria written only into systemPrompt are decorative — they cannot award flair or complete an advance rubric. Use 3-6 concrete DIMENSIONAL criteria, each with { label, description }.

Make criteria DIMENSIONAL (specificity, length, structure, mechanics, evidence, voice) — NOT procedural (drafted, revised, published). Procedural lives in the process pipeline, not the rubric. Give each a short label. Be concrete in each description: state what counts as "full" and what triggers "half" or "not". State failure modes explicitly so the private verdict can distinguish them.

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
    // Designing GENERAL curriculum (the create_unit tool) is open to the
    // broader teacher/admin/curriculum_designer set — it writes no scholar
    // data. Mirrors the same gate in lib/aideTools.
    const canDesignCurriculum =
      isTeacherRole(caller.role) || caller.role === ROLES.CURRICULUM_DESIGNER;

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
          `Your tools are list_units, get_unit_details, and create_unit (create a new general curriculum unit). Help with general curriculum design — units, lessons, activities, building blocks, Bloom's levels, rubrics, and ${aideProfile.shortName} pedagogy. Per-scholar authoring happens in the unit designer.`,
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
      // HST = UTC-10, no DST — format off UTC parts of (now - 10h).
      const hd = new Date(nowMs - 10 * 60 * 60 * 1000);
      const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const MO = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      let hh = hd.getUTCHours();
      const ap = hh < 12 ? "AM" : "PM";
      hh = hh % 12 || 12;
      const nowLabel = `${WD[hd.getUTCDay()]}, ${MO[hd.getUTCMonth()]} ${hd.getUTCDate()}, ${hd.getUTCFullYear()}, ${hh}:${String(hd.getUTCMinutes()).padStart(2, "0")} ${ap} HST`;
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
          "",
          "**A stated time means PLAN it, even when the request sounds casual.** \"Now\", \"put it up\", \"set focus\" mean live. Anything carrying a when — \"today at 2:20\", \"this afternoon\", \"for tomorrow\", \"in second period\" — means PLAN: `assign_unit` (nothing goes live), then `get_assignment` for the activityId, then `schedule_activity` at that time. There is deliberately no one-call create-and-schedule tool, so this is three calls; take them. Do NOT reach for `assign_activity_now` just because it is one call — it is live-only, and a bare \"today\" is a day, not a permission to start now. When the teacher names no time at all, ASK before making work appear.",
          "",
          "**If a time turns up AFTER something is already live, treat it as a correction, not trivia.** A teacher saying \"they'll be doing this at 2:20\" about work you already pushed is telling you it went live too early. Say so and offer to hold it: `clear_activity` (this clears a LIVE push, not just a planned one) then `schedule_activity` at the stated time. `reschedule_activity` alone is NOT enough — on a live item it only moves the agenda position and does not un-push it. (Observed 2026-08-18: a reflection went live at 12:58 for work the teacher said would happen at 14:20, and the correction two minutes later was read as background information.)",
          "",
          "**Roster + lifecycle.** `set_assignment_scholars` REPLACES the roster (anyone unlisted leaves); `add_assignment_scholars` only adds. `archive_assignment` ends an assignment (clears its pushes). All take scholar NAMES, resolved for you — but confirm the resolved names/assignment with the teacher before a roster change or archive.",
          "",
          `**Time.** All times are epoch milliseconds in Hawaii time (HST, UTC-10, no daylight saving). Right now it is ${nowLabel} (${nowMs} ms). One day = 86400000 ms; one week = 604800000 ms. Each schedule item comes back with a human \`whenLabel\` so you can confirm you've got the right one.`,
          "",
          `**Converting a wall-clock time to ms is error-prone — don't trust your first arithmetic.** Anchor off the current time above (e.g. \"this coming Monday 9am\" = step forward from now), and a useful identity is: 9:00 AM HST on a date = that date at 19:00 UTC. After ANY schedule_activity / reschedule_activity call, READ the returned \`startsAtLabel\` and check it matches the time the teacher asked for. If it's off, recompute and call again BEFORE telling the teacher it's done — don't narrate a guess as if it were confirmed.`,
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
        `## Current scholar: ${sc.scholarName} ${SCHOLAR_NAME_PRONOUN_HINT}`,
      );
      lines.push("");
      lines.push(
        `This chat thread is scoped to one specific scholar. Assume every question is about ${sc.scholarName} unless stated otherwise. The context below is pre-loaded — you do NOT need to call get_scholar_dossier / get_scholar_seeds / get_scholar_observations for this scholar (but you may still call get_scholar_mastery and get_scholar_signals if useful).`
      );
      lines.push("");
      if (sc.readingLevel) {
        lines.push(`Reading level: ${sc.readingLevel}`);
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
          `## Currently viewing: ${focus.scholarName} ${SCHOLAR_NAME_PRONOUN_HINT}`,
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
          lines.push(`Reading level: ${focus.readingLevel}`);
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

/**
 * Analyze a session endpoint.
 * Runs unified observer (writes mastery observations, signals, seeds, etc. to DB).
 * Returns a backward-compatible "detailed" shape for SessionViewer.
 */
http.route({
  path: "/analyze",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    const { sessionId } = body as { sessionId: string };

    // ── AUTH ──────────────────────────────────────────────────────────
    // Observer analysis writes mastery/signals/seeds to a scholar's record
    // and burns a Claude call, so gate it: owner or teacher/admin only.
    const jsonHeaders = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    };
    const callerUserId = await getAuthUserId(ctx);
    if (!callerUserId) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }
    const [caller, ownership] = await Promise.all([
      ctx.runQuery(internal.users.getByIdInternal, { id: callerUserId }),
      ctx.runQuery(internal.sessionHelpers.getSessionOwnership, {
        sessionId: sessionId as Id<"sessions">,
      }),
    ]);
    if (!ownership) {
      return new Response(JSON.stringify({ error: "Session not found" }), {
        status: 404,
        headers: jsonHeaders,
      });
    }
    if (!caller || !canAccessSession(caller, ownership.userId)) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: jsonHeaders,
      });
    }
    if (
      ownership.accessScholarId &&
      caller._id !== ownership.accessScholarId
    ) {
      try {
        await ctx.runQuery(
          internal.accessGuards.requireActiveScholarAccessByUserId,
          {
            userId: caller._id,
            scholarId: ownership.accessScholarId,
          },
        );
      } catch {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: jsonHeaders,
        });
      }
    }

    // ── Cost circuit breaker (public test server only) ─────────────────
    // Inert unless LLM_DAILY_BUDGET_USD is set (never on prod).
    const analyzeOverBudget = await llmBudgetExceeded(ctx);
    if (analyzeOverBudget !== null) {
      return new Response(
        JSON.stringify({ error: llmBudgetMessage(analyzeOverBudget) }),
        { status: 429, headers: jsonHeaders },
      );
    }

    try {
      const result = await ctx.runAction(internal.observer.analyzeSession, {
        sessionId: sessionId as Id<"sessions">,
      });

      // Map observer result to legacy "detailed" shape for SessionViewer. A
      // degraded-pulse run maps to null (no pulse to render), same as no result.
      const detailed = mapObserverResultToDetailed(result);

      return new Response(
        JSON.stringify({ observer: result?.pulse ?? null, detailed }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    } catch (error) {
      console.error("Analysis error:", error);
      return new Response(
        JSON.stringify({ error: "Analysis failed" }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }
  }),
});

// CORS preflight for analyze
http.route({
  path: "/analyze",
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
// trust comes entirely from the HMAC-signed `state` parameter.

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
      purpose?: "scanner" | "docs_bot" | "workspace_bot";
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
      profile = await fetchUserInfo(tokens.access_token);
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
            verified.purpose === "scanner" ? undefined : verified.purpose,
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
    const { assistantMsgId } = body as { assistantMsgId: string };

    const callerUserId = await getAuthUserId(ctx);
    if (!callerUserId) {
      return new Response(
        sseEvent({ error: "Not authenticated" }),
        { status: 401, headers: sseHeaders },
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
    // id-scoped to this parent's children (lib/scholarReadTools).
    const tools = await makeScholarReadTools(
      ctx,
      (data) => emitSSE(data),
      ROLES.PARENT,
      allowedScholarIds,
    );

    const childList =
      childNames.length > 0 ? childNames.join(", ") : "(no children linked yet)";
    const systemPrompt = buildParentAideSystemPrompt({
      profile: parentProfile,
      parentName: context.parentName,
      childList,
      childCount: childNames.length,
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
      bindEmit: (emit) => {
        emitSSE = emit;
      },
      persist: (content) =>
        ctx.runMutation(internal.parentChat.updateStreamContent, {
          messageId: assistantMsgId as Id<"parentChatMessages">,
          content,
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
// identity — the same getAuthUserId the scholar-facing /project-stream uses),
// verify the metaChat + assistant row belong to the caller (via the extracted
// pure validator), run runAideStream, and finalize the assistant row
// (finalizeStream schedules the meta-observer, exactly where sessions schedule
// the main observer). See review/scholar-meta-prep-time-plan.html §8.
//
// TOOLS: tool-less by default (all context is injected deterministically).
// Two INDEPENDENT flag-gated tool sets, each off by default:
//   - WORKSHOP_CODE_EXPLORER_ENABLED → two read-only, public-only,
//     unauthenticated repo-reading tools (lib/scholarCodeTools.ts,
//     CODE_EXPLORER_SPEC.md).
//   - WORKSHOP_IDEA_CONVOS_ENABLED → the send_idea_to_teacher write tool +
//     the thinking-partner prompt (lib/scholarIdeaTools.ts, IDEA_CONVOS_SPEC.md).
// A small iteration cap applies whenever any tool is wired (the larger of the
// two caps). Both flags off → byte-identical to the tool-less v1.
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
      // Workshop Code Explorer — the SAME flag gates the prompt section and the
      // tools below, so they can never drift (CODE_EXPLORER_SPEC.md §3/§2).
      codeExplorerEnabled: isCodeExplorerEnabled(),
      // Workshop idea conversations — the SAME flag swaps the Workshop/listening
      // section for the thinking-partner contract AND wires the
      // send_idea_to_teacher tool below (IDEA_CONVOS_SPEC.md §2/§1).
      ideaConvosEnabled,
    });

    // Stamp the surfaced staff responses seen at PROMPT-BUILD time (§5.6) —
    // when the chat actually shows them, not at observer time.
    if (
      context.purpose === "reflection" &&
      context.updateSuggestionIds.length > 0
    ) {
      await ctx.runMutation(internal.metaChat.markResponsesSeen, {
        suggestionIds: context.updateSuggestionIds,
        at: Date.now(),
      });
    }

    // Stamp credit moments delivered at PROMPT-BUILD time too — the moment a
    // credit is woven into the chat it's delivered (at-most-once, §8), the same
    // idea as markResponsesSeen above.
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

    // Workshop tool wiring. Two INDEPENDENT flags, each off by default:
    //   - Code Explorer (WORKSHOP_CODE_EXPLORER_ENABLED): read-only repo tools.
    //   - Idea conversations (WORKSHOP_IDEA_CONVOS_ENABLED): the
    //     send_idea_to_teacher write tool.
    // Both OFF → withTools=false, maxIterations undefined: exactly today's
    // tool-less v1 (behavioral no-op). Either/both ON → their tools + a cost cap
    // (the larger of the two caps). The tools close over a late-bound emit
    // (reassigned once the ReadableStream starts), the same dance the other aide
    // streams use.
    let emitSSE: AideEmit = () => {};
    const codeCfg = codeExplorerLoopConfig(isCodeExplorerEnabled());
    const ideaCfg = ideaConvosLoopConfig(ideaConvosEnabled);
    const codeTools = codeCfg.withTools
      ? await makeScholarCodeTools((data) => emitSSE(data))
      : [];
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
    const maxIterations = withTools
      ? Math.max(codeCfg.maxIterations ?? 0, ideaCfg.maxIterations ?? 0)
      : undefined;

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

export default http;
