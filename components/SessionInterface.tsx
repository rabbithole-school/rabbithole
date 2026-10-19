"use client";

import { memo, useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  Box,
  Button,
  Drawer,
  Flex,
  VStack,
  Text,
  Textarea,
  IconButton,
  Menu,
  Spinner,
  Splitter,
  Tooltip,
  Portal,
} from "@chakra-ui/react";
import { ThumbsUp, ThumbsDown, ArrowRight, ArrowUp, CheckSquare, Clock, PencilSimple, House, Lock, Microphone, Square, SpeakerHigh, Pause, Play, Waveform, X } from "@phosphor-icons/react";
import { RemoteLink } from "./RemoteLink";
import { DispatchCompletionReceipt } from "./DispatchCompletionReceipt";
import { useStreamingDictation, type DictationState } from "@/hooks/useStreamingDictation";
import { DICTATION_CONNECTING_LABEL } from "@/lib/realtimeTranscriptionProtocol";
import { usePendingImage } from "@/hooks/usePendingImage";
import {
  type CaptureAppSnapshot,
  uploadChangedAppSnapshot,
} from "@/hooks/useAppStateIframeBridge";
import { useQuery as useRetainedQuery } from "convex-helpers/react/cache";
import { useCachedQuery } from "@/hooks/useCachedQuery";
import type { DispatchCompletionReceipt as DispatchCompletionReceiptData } from "@/shared/dispatchCompletionReceipt";
import { getTTSEngine, useTTSQueue } from "@/hooks/useTTSQueue";
import { composerMicButtonStyle, composerStopRecordingStyle } from "@/components/composerMicStyles";
import {
  SentenceAccumulator,
  stripMarkdownForSpeech,
} from "@/lib/sentenceStream";
import { busyRetryCopy } from "@/shared/llmLimiter";
import { isTutorNeedsKeyError, TUTOR_NEEDS_KEY_MESSAGE } from "@/shared/tutorKey";
import { tutorKeyHref } from "@/lib/tutorKeyReturn";
import {
  beginnerAlphabet,
  checkDecodable,
  conversationTextSteps,
  readsAlong,
  partSpans,
  splitYourTurn,
  withoutYourTurn,
  YourTurnSpeechFilter,
  yourTurnCue,
  type DecodableAlphabet,
} from "@/shared/beginnerReading";
import { BeginnerReplyWeb } from "@/components/BeginnerReplyWeb";
import { voiceMark } from "@/lib/voicePerf";
import { useTimeLimit } from "@/hooks/useTimeLimit";
import { TimeLimitModal } from "./TimeLimitModal";
import {
  type MessageInputModality,
  SessionAssistantMessageBody,
  SessionInputModality,
  SessionStreamStatus,
  TutorTurnFailedNotice,
  useReconciledSessionMessages,
} from "@/components/SessionTranscript";
import { SessionHeader } from "./SessionHeader";
import {
  useSessionActivityNav,
  ProjectTitleMenu,
  ProjectActivityNavModal,
} from "./SessionActivityNav";
import { ArtifactPanel, flushAllArtifactSaves } from "./ArtifactPanel";
import { clearAllArtifactSaves } from "./artifactSaveRegistry";
import {
  ResourceShareCard,
  type ResourceShare,
} from "./ResourceShareCard";
import { ScholarAngleBanner } from "./ScholarAngleBanner";
import { TeachBacksCard } from "./TeachBacksCard";
import { ProcessThumbnail } from "./ProcessThumbnail";
import { CurriculumBotDrawer } from "./CurriculumBotDrawer";
import { ReflectionDrawer } from "./ReflectionDrawer";
import { ManualRehearsalBanner } from "./ManualRehearsalBanner";
import { OfflineSessionView } from "./OfflineSessionView";
import { BadgeCelebration } from "./BadgeCelebration";
import { QuestBuildUnlockOffer } from "./QuestBuildUnlockOffer";
import { SavedForLaterBlock } from "./SavedForLaterBlock";
import type { ParkedIdea } from "./ParkedIdeaList";
import { SessionRecapCard } from "./SessionRecapCard";
import { toaster } from "@/lib/toaster";
import { haptic, keepAwake, isLikelyMuted } from "@/lib/native";
import { ImageLightbox } from "@/components/ImageLightbox";
import { ComposerAttachMenu } from "@/components/ComposerAttachMenu";
import {
  ChatPracticeItem,
  type ChatPracticePayload,
} from "@/components/practice/ChatPracticeItem";
import {
  InstructionChatCard,
  type InstructionHandbackStart,
  type InstructionChatPayload,
} from "@/components/practice/InstructionChatCard";
import { useSwipeDismiss } from "@/hooks/useSwipeGesture";
import { MAX_FLAG_SNIPPET_LEN } from "@/lib/manualRehearsalFlags";
import { pickAdmonishment } from "@/lib/admonishments";
import { useNow } from "@/hooks/useNow";
import { dueStatus } from "@/shared/institutionDay";
import {
  HOMEWORK_DONE_CONFIRMED,
  HOMEWORK_DONE_LABEL,
  HOMEWORK_DONE_UNDO,
  homeworkEyebrow,
} from "@/shared/homeworkFraming";
import { ErrorBoundary } from "./ErrorBoundary";
import { PhysicalTaskCard } from "./PhysicalTaskCard";
import {
  FlairAwardNotice,
  type FlairAward,
} from "./FlairAwardNotice";
import { useFlairArrivals } from "@/shared/useFlairArrivals";
import { useQuestBakeHold } from "@/shared/questBakeHold";
import { DimensionOption } from "./DimensionPicker";
import { useActiveRoomCues } from "@/hooks/useActiveRoomCues";
import { RoomCueBanner } from "@/components/RoomCueBanner";
import { RestOverlay } from "@/components/RestOverlay";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id, Doc } from "@/convex/_generated/dataModel";
import { useAgentStream } from "@/hooks/useAgentStream";
import type { StreamEvent } from "@/hooks/useAgentStream";
import { deriveServerTurnState } from "@/shared/streamRetry";
import {
  appTutorSendResultFromStatus,
  newestAppTutorAskContext,
  settleAppTutorSend,
  type AppTutorSendResult,
  type AppTutorUpdateBatch,
} from "@/shared/appTutorRequest";
import { useAppTutorUpdates } from "@/hooks/useAppTutorUpdates";
import {
  AppAiTurnRow,
  appCharacterNamesFrom,
  type AppCharacterNames,
} from "@/components/AppAiTurnRow";
import type { AppAiTurnView } from "@/convex/appAi";
import { isTeacherRole } from "@/convex/lib/roles";
import { serverRefusal } from "@/lib/serverErrorMessage";
import { TeacherArchivedAppNotice } from "@/components/TeacherArchivedApp";
import { isTeacherArchived } from "@/shared/teacherArchive";

const NO_APP_AI_TURNS: AppAiTurnView[] = [];
const NO_APP_CHARACTER_NAMES: AppCharacterNames = {};
import { useSendLock } from "@/hooks/useSendLock";
import { useManualRehearsalReplay } from "@/hooks/useManualRehearsalReplay";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { convexSiteUrl } from "@/lib/convexUrls";
import { GraphemeText } from "@/components/GraphemeText";
import { buildStageMap } from "@/lib/graphemeStageMap";
import { pickLockingFocus } from "@/lib/focusLock";
import { useSessionDeliverable } from "@/hooks/useSessionDeliverable";
import { newestHtmlArtifact } from "@/lib/vibecode/helpers";
import { composerAfterPersistedSend } from "@/lib/composerAfterSend";
import type { GraphemeSpan, GraphemeStages } from "@/shared/graphemeSegments";
import {
  focusMismatchBannerText,
  formatRoomTurnTime,
  liveFocusLine,
  roomClockForFocus,
  TURNED_BANNER_TEXT,
  WINDING_DOWN_BANNER_TEXT,
} from "@/shared/roomTurn";
import { toolRowDisplay } from "@/shared/toolActivity";
import { useRoomTurnPhase } from "@/hooks/useRoomTurnPhase";
import { useRoomTurnAwareness } from "@/hooks/useRoomTurnAwareness";

const CHAT_INITIAL_WINDOW = 80;
const CHAT_WINDOW_INCREMENT = 80;

interface ProjectInterfaceProps {
  sessionId: string;
  onSessionUpdate?: () => void;
  onOpenSidebar?: () => void;
  onSignOut?: () => void;
  onNewSession?: () => void;
  isTestMode?: boolean;
  isRemoteMode?: boolean;
  scholarName?: string | null;
  scholarImage?: string | null;
  remoteUserId?: string | null;
  onBack?: () => void;
  /** Open this session's app full screen in the builder (the app card's Open). */
  /** Open the full-screen builder on the app with this artifact id. */
  onOpenBuilder?: (appId: string) => void;
}

export function SessionInterface({
  sessionId,
  onSessionUpdate,
  onSignOut,
  onNewSession,
  isTestMode,
  isRemoteMode,
  scholarName,
  remoteUserId,
  onBack,
  onOpenBuilder,
}: ProjectInterfaceProps) {
  useEffect(() => () => clearAllArtifactSaves(), [sessionId]);
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const welcomeSentRef = useRef<string | null>(null);
  const kickoffPendingRef = useRef(false);
  const kickoffRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [kickoffPending, setKickoffPending] = useState(false);
  const [, bumpKickoffRetry] = useState(0);
  // The deployment has no Anthropic key (TRA-536). Set by the stream's refusal
  // event so the kickoff can tell it apart from an ordinary failure: that
  // kickoff is held (no automatic retry loop) and the chat says why, with a
  // Try again that re-runs the kickoff once a key is added.
  const streamNeededKeyRef = useRef(false);
  const [kickoffHeldForKey, setKickoffHeldForKey] = useState(false);
  const [whisperInput, setWhisperInput] = useState("");
  // Shared web image-attachment pipeline (staged File + preview + upload).
  // Same hook the practice "talk me through it" chat uses, so the two composers
  // can't drift.
  const { pendingImage, setPendingImage, clear: clearPendingImage, upload: uploadPendingImage } =
    usePendingImage();

  // Audio feature flags (teacher-controlled per scholar)
  const { user: currentUser } = useCurrentUser();
  const ttsEnabled = currentUser?.ttsEnabled !== false;
  const sttEnabled = currentUser?.sttEnabled !== false;

  // ── Voice-first mode ──────────────────────────────────────────────────
  // When on: tutor replies are spoken sentence-by-sentence AS THEY STREAM
  // (latency-to-first-audio ≈ one short TTS call), and when the voice
  // finishes, listening auto-resumes — a hands-free conversation loop.
  // voiceModeRef mirrors the state for the stream-event callback.
  const [voiceMode, setVoiceModeState] = useState(false);
  const voiceModeRef = useRef(false);
  const voiceAccRef = useRef(new SentenceAccumulator());
  // A beginner's "your turn" line (TRA-504) is for the child to read, so the
  // voice never speaks it.
  const voiceTurnFilterRef = useRef(new YourTurnSpeechFilter());
  // A beginner's alphabet once their inventory has loaded (null otherwise):
  // a reply whose your-turn line the box will show ends with a spoken cue.
  const beginnerCueAlphabetRef = useRef<DecodableAlphabet | null>(null);

  // Activity nav (eyebrow breadcrumb + Mark Complete button + modal). The
  // modal lives below the header; the eyebrow + button are slotted into
  // SessionHeader so the layout stays single-row.
  const activityNav = useSessionActivityNav(
    sessionId as Id<"sessions">,
    (isRemoteMode && remoteUserId
      ? (remoteUserId as Id<"users">)
      : (currentUser?._id ?? null)) as Id<"users"> | null,
    remoteUserId ?? null,
    !isTestMode && !isRemoteMode,
  );

  // Active artifact tab (declared early so onEvent can reference it)
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  // Default to closed. The auto-open effect below flips it on when
  // actual content materializes (an artifact, or a video embed). A
  // project with just a deliverable but no documents yet shouldn't
  // pre-open the panel — the doc will be created when needed (the
  // AI does it via tool call) and the panel will pop open then.
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [reflectionOpen, setReflectionOpen] = useState(false);

  // Shared streaming hook
  const onStreamEvent = useCallback((data: StreamEvent) => {
    if (isTutorNeedsKeyError(data.error)) streamNeededKeyRef.current = true;
    if (data.newArtifactId) {
      setActiveArtifactId(data.newArtifactId);
      setRightPanelOpen(true);
      haptic("medium"); // something arrived — the artifact panel just opened
    }
    if (data.generatedImage) {
      haptic("medium");
    }
    if (data.text) {
      voiceMark("firstText"); // no-op unless rh.voiceDebug=1 + cycle armed
    }
    // Voice mode: speak completed sentences as the reply streams in.
    if (data.text && voiceModeRef.current) {
      const engine = getTTSEngine();
      const speakable = voiceTurnFilterRef.current.push(data.text);
      for (const s of voiceAccRef.current.push(speakable)) {
        engine?.enqueue(stripMarkdownForSpeech(s));
      }
    }
    if (data.done) {
      if (voiceModeRef.current) {
        const engine = getTTSEngine();
        const tail = voiceAccRef.current.push(
          voiceTurnFilterRef.current.flush(),
        );
        for (const s of tail) engine?.enqueue(stripMarkdownForSpeech(s));
        const rest = voiceAccRef.current.flush();
        if (rest) engine?.enqueue(stripMarkdownForSpeech(rest));
        // The line itself is never spoken; a short cue points the child at
        // its box — only when the box will show it (TRA-504, iPad parity).
        const lines = voiceTurnFilterRef.current.lines;
        const line = lines[lines.length - 1];
        const alphabet = beginnerCueAlphabetRef.current;
        const cue =
          line && alphabet && checkDecodable(line, alphabet).ok
            ? yourTurnCue(line)
            : null;
        if (cue) engine?.enqueue(cue);
        if (!rest && !cue && tail.length === 0 && engine?.state === "idle") {
          // Everything was already spoken before done arrived — the
          // engine won't fire another onIdle, so resume listening here.
          maybeAutoListenRef.current();
        }
      }
      // Each reply gets a fresh filter, so its lines are its own.
      voiceTurnFilterRef.current = new YourTurnSpeechFilter();
      onSessionUpdate?.();
    }
  }, [onSessionUpdate]);

  const stream = useAgentStream({ onEvent: onStreamEvent });
  // Every tutor stream goes through here so streamNeededKeyRef describes THIS
  // send only: a user turn that failed for want of a key must not make a later
  // kickoff, failing for some other reason, read as held for a key.
  const streamSend = stream.send;
  const sendTutorStream = useCallback(
    (...args: Parameters<typeof streamSend>) => {
      streamNeededKeyRef.current = false;
      return streamSend(...args);
    },
    [streamSend],
  );
  const { isStreaming, streamingContent, streamingMsgId, toolActivity, generatingImage } = stream;
  const runWithSendLock = useSendLock();

  // The inline "Didn't go through — try again" affordance is for FAILED SCHOLAR
  // (user) turns only. This flag is set when a user-turn send exhausts its retry
  // budget (or hard-errors) in THIS tab; silent turns (activity kickoff / rubric
  // check) never set it. Reset when a user send starts. (A dead user placeholder
  // after a reload / in another tab is derived from server truth below.)
  const [userTurnFailed, setUserTurnFailed] = useState(false);

  // Convex queries for dimension options (reactive, auto-updating)
  // Dimension lists ride the perceived-speed cache — they're stable
  // curriculum data, ideal for instant cold-start rendering.
  const dimensionCacheSuffix = currentUser?._id ?? "anon";
  const unitsRaw = useCachedQuery(
    api.units.list,
    { asLearner: !isTestMode && !isRemoteMode },
    `units.${dimensionCacheSuffix}.${isTestMode || isRemoteMode ? "staff" : "learner"}`,
  );
  const units = useMemo(() => unitsRaw ?? [], [unitsRaw]);
  const processes =
    useCachedQuery(
      api.processes.list,
      { asLearner: !isTestMode && !isRemoteMode },
      `processes.${dimensionCacheSuffix}.${isTestMode || isRemoteMode ? "staff" : "learner"}`,
    ) ?? [];
  const personasRaw = useCachedQuery(
    api.personas.list,
    { asLearner: !isTestMode && !isRemoteMode },
    `personas.${dimensionCacheSuffix}.${isTestMode || isRemoteMode ? "staff" : "learner"}`,
  );
  const personas = useMemo(() => personasRaw ?? [], [personasRaw]);

  // Focus lock from teacher — array of per-activity classFocus pushes; take the
  // first SOLO-STARTABLE one as the headline. A focus the scholar can't
  // complete on their own (e.g. a card-sort done together in class) must NOT
  // drive the read-only wall (policy b, PR #707).
  const currentFocus = useQuery(api.assignments.currentClassFocusForMe, {
    asLearner: !isTestMode,
  });
  // Homework pushes targeting this scholar — used to gate the
  // "your teacher can read this" admonishment line to at-home work.
  const homeworkForMe = useQuery(api.assignments.homeworkForMe, {
    asLearner: !isTestMode,
  });
  const graphemeInventory = useQuery(api.graphemeInventory.mine);
  const graphemeStages = useMemo(
    () => buildStageMap(graphemeInventory),
    [graphemeInventory],
  );
  const hasGraphemeStages = Object.keys(graphemeStages).length > 0;
  const firstFocus = pickLockingFocus(currentFocus);
  const focusLock = firstFocus
    ? {
        unitId: firstFocus.unitId ? String(firstFocus.unitId) : null,
        lessonId: firstFocus.lessonId ? String(firstFocus.lessonId) : null,
        lessonTitle: firstFocus.lessonTitle ?? null,
        // Most-specific name for the copy — the thing the class is on right now.
        label:
          firstFocus.activityTitle ??
          firstFocus.lessonTitle ??
          firstFocus.unitTitle ??
          null,
        // "The turn, not the bell" — when (+ in what timezone) this class
        // focus wraps, so the banners can render a soft local time instead
        // of a bare "paused until then".
        // Block end vs. a teacher-given lifetime — only a block end is
        // the room's clock (shared/roomTurn.ts).
        ...roomClockForFocus(firstFocus),
        timeZone: firstFocus.timeZone,
      }
    : null;

  const unitOptions: DimensionOption[] = useMemo(
    () => units.map((u) => ({
      id: u._id,
      title: u.title,
      emoji: u.emoji ?? undefined,
    })),
    [units],
  );

  // Persona options for message bubble labels (still need persona list for historical snapshots)
  const personaOptions: DimensionOption[] = useMemo(
    () => personas.map((p) => ({
      id: p._id,
      title: p.title,
      emoji: p.emoji,
    })),
    [personas],
  );

  // Convex query for project + messages (reactive, auto-updating). Uses the
  // retained-subscription useQuery so navigating away and back renders the
  // conversation instantly from the warm client cache. Deliberately NOT
  // snapshotted to localStorage — see hooks/useCachedQuery.ts.
  const sessionData = useRetainedQuery(
    api.sessions.getWithMessages,
    { id: sessionId as Id<"sessions"> }
  );

  // Listeners (read level `listener`, TRA-503 — usually age ~4–6) can't work a
  // toggle and roam devices, so voice mode defaults ON from the session's
  // EFFECTIVE read level (server-resolved the way the tutor prompt resolves it
  // — a teacher's per-session read override counts, TRA-492; the iPad keys on
  // the same field) rather than localStorage. Never for a teacher watching a
  // scholar's session remotely. An explicit "off" ("0") still wins; an
  // explicit "on" ("1") still forces it for anyone.
  const isListenerSession =
    sessionData?.session?.readLevel === "listener" && !isRemoteMode;
  // Beginner readers (TRA-504) are read to by default too, but the mic does
  // NOT reopen on its own: they're looking at the words and answer with the
  // tap-to-talk mic (native: usePreReaderVoice `autoListen`).
  const isBeginnerSession =
    sessionData?.session?.readLevel === "beginner" && !isRemoteMode;
  const isBeginnerSessionRef = useRef(isBeginnerSession);
  // Listeners and beginners get the cleaned read-along reply (the word
  // highlight and tap-a-word are iPad-only for now) and larger conversation
  // text; only a beginner gets the your-turn box.
  const isReadAlongSession =
    readsAlong(sessionData?.session?.readLevel) && !isRemoteMode;
  const textSteps = isRemoteMode
    ? 0
    : conversationTextSteps(sessionData?.session?.readLevel);
  // What a beginner can decode; null until the inventory query resolves, so
  // the your-turn box and its cue wait for the real teams (iPad parity).
  const decodableAlphabet = useMemo(
    () =>
      graphemeInventory === undefined
        ? null
        : beginnerAlphabet(
            graphemeInventory.map((t) => t.team),
            // what a linked Mentava level has taught (TRA-507); null = none
            sessionData?.session?.beginnerSpellings,
          ),
    [graphemeInventory, sessionData?.session?.beginnerSpellings],
  );
  useEffect(() => {
    isBeginnerSessionRef.current = isBeginnerSession;
    beginnerCueAlphabetRef.current = isBeginnerSession ? decodableAlphabet : null;
  }, [isBeginnerSession, decodableAlphabet]);
  useEffect(() => {
    // Hydrate the persisted preference (deferred past SSR).
    const stored = localStorage.getItem("rabbithole.voiceMode");
    const defaultOn =
      ttsEnabled &&
      (stored === "1" ||
        (stored !== "0" && (isListenerSession || isBeginnerSession)));
    if (defaultOn) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only preference hydration
      setVoiceModeState(true);
      voiceModeRef.current = true;
    }
  }, [ttsEnabled, isListenerSession, isBeginnerSession]);

  const messages = useMemo(
    () => sessionData?.messages ?? [],
    [sessionData?.messages]
  );
  const activeKickoffPlaceholder =
    messages.length === 1 &&
    messages[0].role === "assistant" &&
    messages[0].content.trim() === "" &&
    !!messages[0].streamId &&
    messages[0].streamTrigger === "activityKickoff"
      ? messages[0]
      : null;
  // A quest launched before its activity exists holds its opening turn until the
  // background bake lands (shared/questBakeHold.ts). It is the same state the
  // kickoff flag already models — the opening turn has not happened yet — so it
  // blocks sending through the same path rather than a parallel one.
  const questBakeHolding = useQuestBakeHold(sessionData?.session);
  const kickoffBlocksSending =
    kickoffPending || activeKickoffPlaceholder !== null || questBakeHolding;
  const activeSession = sessionData?.session
    ? {
        title: sessionData.session.title,
        unitId: sessionData.session.unitId
          ? String(sessionData.session.unitId)
          : null,
      }
    : {
        title: "New Session",
        unitId: null,
      };

  // Resolve building blocks from the active unit
  const activeUnit = activeSession.unitId
    ? units.find((u) => u._id === activeSession.unitId)
    : null;

  // The scholar who OWNS this session — the identity a chat practice item
  // (⑮) is graded/recorded against. For a scholar this is themselves; in a
  // remote/teacher view it's the session owner (the widget is read-only then).
  const practiceScholarId =
    (sessionData?.session?.userId as string | undefined) ??
    (remoteUserId ?? currentUser?._id) ??
    null;

  // Is THIS session an at-home (homework) push? Match the session's
  // assignment + activity against the scholar's live homework list. Drives the
  // homework-only "your teacher can read this" admonishment line, the header
  // eyebrow, and the footer "I'm done with this" control.
  const sessionAssignmentId = sessionData?.session?.assignmentId
    ? String(sessionData.session.assignmentId)
    : null;
  const sessionActivityIdForHomework = sessionData?.session?.activityId
    ? String(sessionData.session.activityId)
    : null;
  // The homework row itself, not just the boolean — it already carries the
  // deadline and the teacher who set it, which the tonight list renders and
  // the session view used to drop the moment the scholar opened the work.
  const homeworkForThisSession =
    sessionAssignmentId && sessionActivityIdForHomework
      ? ((homeworkForMe ?? []).find(
          (h) =>
            String(h.assignmentId) === sessionAssignmentId &&
            String(h.activityId) === sessionActivityIdForHomework,
        ) ?? null)
      : null;
  const isHomeworkSession = !!homeworkForThisSession;

  // The homework framing line for the header eyebrow. Ticks at 60s so the
  // deadline re-derives across institution midnight while the session is open
  // (T11) — a scholar who leaves the tab up overnight must not still be told
  // the work is "due today".
  const nowMs = useNow(60_000);
  const homeworkEyebrowText = homeworkForThisSession
    ? homeworkEyebrow(
        dueStatus(
          homeworkForThisSession.dueAt,
          nowMs,
          homeworkForThisSession.timeZone,
        )?.phrase,
        homeworkForThisSession.teacherName,
      )
    : null;

  // Seed-spawned independent exploration: the scholar started this themselves
  // by clicking "Explore" on a seed, so it has NO unit/lesson/activity anchor
  // and its title (the seed topic) reads just like an assigned lesson. Without
  // a label, scholars mistake it for assigned work and expect the tutor to
  // "see the lesson" (it can't — there isn't one). See the matching SESSION
  // FOCUS block in convex/sessionHelpers.ts.
  //
  // TEMPORARY: this lightweight eyebrow is a stopgap. The in-progress Star
  // Chart surface will own how self-directed exploration is framed for the
  // scholar and should subsume this label when it lands.
  const isSeedExploration =
    !!sessionData?.session?.seedId &&
    !sessionData?.session?.activityId &&
    !sessionData?.session?.unitId;

  // Process state (reactive query, updates when AI tool fires)
  // Always query — returns null if no process is active for this project.
  // processState stores the canonical processId (set by backend from lesson or unit).
  const processState = useQuery(
    api.processState.getBySession,
    { sessionId: sessionId as Id<"sessions"> }
  );

  // Look up the full process definition from processState's own processId
  // (handles both unit-level and lesson-level process assignments)
  const activeProcessDef = processState?.processId
    ? processes.find((p) => p._id === String(processState.processId))
    : null;

  // Artifacts (reactive query, returns array)
  const artifacts = useQuery(
    api.artifacts.getBySession,
    { sessionId: sessionId as Id<"sessions"> }
  ) ?? [];
  // Staff reading a session with an app see its in-app AI turns inline. No
  // subscription for chats without an app, nor for the scholar (the app
  // already shows them the scene).
  const sessionHasApp = artifacts.some((a) => a.type === "code");
  // Whether the session has an app the full-screen builder can show; each
  // app card's Open names its own app (builderHtmlArtifact).
  const builderApp = newestHtmlArtifact(artifacts);
  const appAiTurns = useQuery(
    api.appAi.listForSession,
    isRemoteMode && sessionHasApp && isTeacherRole(currentUser?.role)
      ? { sessionId: sessionId as Id<"sessions"> }
      : "skip",
  );
  const appCharacterNames = appCharacterNamesFrom(artifacts);

  // Deliverable context for the per-document Check buttons, resolved by the
  // same hook the full-screen app builder uses (one resolution, one submit
  // path for both views of a session) and passed into ArtifactPanel.
  const {
    activity: activityForDeliverable,
    deliverableContext: resolvedDeliverableContext,
    prepareSubmit: prepareDeliverableSubmit,
  } = useSessionDeliverable({
    sessionId: sessionId as Id<"sessions">,
    session: sessionData?.session,
  });
  const saveArtifact = useMutation(api.artifacts.scholarUpdate);
  const createArtifact = useMutation(api.artifacts.scholarCreate);
  const deleteArtifactMut = useMutation(api.artifacts.deleteArtifact);
  const [artifactSynced, setArtifactSynced] = useState(true);

  // Auto-select last artifact when artifacts change
  useEffect(() => {
    if (artifacts.length > 0) {
      const currentStillExists = artifacts.some((a) => a._id === activeArtifactId);
      if (!currentStillExists) {
        // Sync selection with the externally-driven artifacts list (Convex query result).
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setActiveArtifactId(artifacts[artifacts.length - 1]._id);
      }
    } else {
      setActiveArtifactId(null);
    }
  }, [artifacts]); // eslint-disable-line react-hooks/exhaustive-deps

  // Right panel state
  const hasProcess = !!(activeProcessDef && processState);
  const hasArtifacts = artifacts.length > 0;
  // We could thread "has deliverable" through here too, but the
  // DeliverableStatusCard is keyed on the project's activityId, which
  // we have directly. Cheap proxy: if there's an activityId, assume
  // the panel might want to open. The card itself short-circuits to
  // null when the activity has no deliverable.
  const hasDeliverableActivity = !!sessionData?.session?.activityId;
  const hasRightPanelContent =
    hasProcess ||
    hasArtifacts ||
    hasDeliverableActivity ||
    !!activeUnit?.youtubeUrl;

  // Auto-open ONLY when there's something to look at: an artifact
  // or a video. Not when there's merely a deliverable spec — that
  // alone produces a "No documents yet" panel which the scholar
  // doesn't need to see until a doc actually exists. The toggle
  // button still surfaces (gated on hasRightPanelContent) so the
  // scholar can manually open the panel to add a doc by hand.
  //
  // Exception: a PHOTO deliverable's panel IS its capture surface
  // ("Take Photo" / "Upload"), so auto-open it — there's no artifact
  // that would ever trip the hasArtifacts branch for a photo kind.
  const isPhotoDeliverable =
    activityForDeliverable?.deliverable?.kind === "photo";
  const hasOpenableContent =
    hasArtifacts || !!activeUnit?.youtubeUrl || isPhotoDeliverable;
  useEffect(() => {
    if (hasOpenableContent) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRightPanelOpen(true);
    }
  }, [hasOpenableContent]);

  const showRightPanel = rightPanelOpen && hasRightPanelContent;

  // Mobile detection
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  useEffect(() => {
    // One-time read of browser/window APIs unavailable during SSR.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsTouchDevice("ontouchstart" in window || navigator.maxTouchPoints > 0);
  }, []);

  // Viewport width decides the LAYOUT; touch decides only ergonomics
  // (type sizes, tap targets, swipe-dismiss). A wide viewport gets the
  // side-by-side chat + doc-editor layout — mirroring the native iPad
  // landscape layout — whether or not the screen happens to be touchable
  // (a touchscreen laptop is not a phone). Only narrow viewports get the
  // bottom drawer. Live-tracked so it flips on rotation/resize.
  const [isNarrowViewport, setIsNarrowViewport] = useState(false);
  useEffect(() => {
    // matchMedia is a browser API unavailable during SSR.
    const mq = window.matchMedia("(max-width: 899px)");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsNarrowViewport(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setIsNarrowViewport(e.matches);
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, []);

  const useDrawerLayout = isNarrowViewport;

  // Mobile drawer for right panel
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  // Leaving drawer mode (rotating to landscape) force-closes the drawer via
  // its `open` prop. Also clear the flag itself, so rotating back to narrow
  // doesn't surprise-reopen a drawer the user left open minutes ago.
  useEffect(() => {
    if (!useDrawerLayout) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- discard drawer-only state when the viewport leaves the drawer layout.
      setMobileDrawerOpen(false);
    }
  }, [useDrawerLayout]);
  // Touch: swipe down on the drawer's grab region dismisses it.
  const attachmentsSwipeClose = useSwipeDismiss(
    () => setMobileDrawerOpen(false),
    "down",
  );

  // Curriculum Bot drawer — opened from the cyan banner in manual-rehearsal
  // mode and from the Robot icon in the SessionHeader in remote mode.
  // Stays mounted so chat / streaming state isn't lost when closed.
  const [botDrawerOpen, setBotDrawerOpen] = useState(false);

  // Pending manual-rehearsal flags — when the teacher hits 👍 / 👎 on a tutor
  // message, the flag is saved server-side immediately, AND we surface
  // the message snippet above the bot drawer's input so the teacher can
  // type a "why" note before sending. Multiple flags accumulate (the
  // teacher might 👍 / 👎 several messages then send once); cleared per
  // entry on dismiss, or all on send.
  //
  // Snippet length cap is shared across the in-input chip (UnitChat),
  // the persisted-history chip (UnitChat), and the truncation render
  // logic — keep them in sync via this constant.
  const [pendingFlags, setPendingFlags] = useState<
    Array<{
      messageId: string;
      kind: "good" | "bad";
      snippet: string;
    }>
  >([]);
  const rightPanelItemCount =
    artifacts.length +
    (hasProcess ? 1 : 0) +
    (activeUnit?.youtubeUrl ? 1 : 0);

  // Convex mutation for updating project dimensions
  const updateSession = useMutation(api.sessions.update);

  const startActivityKickoff = useMutation(api.sessions.startActivityKickoff);
  // User-initiated stop: stamps stopRequestedAt on the session's in-flight
  // assistant row so the running server loop stops and finalizes the partial.
  const requestStop = useMutation(api.sessions.requestStop);
  const generateAppSnapshotUploadUrl = useMutation(
    api.files.generateUploadUrl,
  );
  const appSnapshotCaptureRef = useRef<CaptureAppSnapshot | null>(null);
  const startAppUpdateTurn = useMutation(api.sessions.startAppUpdateTurn);
  // The assistant row of an in-flight app-update turn: invisible until the
  // tutor actually says something (it may stay silent).
  const [appUpdateMsgId, setAppUpdateMsgId] = useState<string | null>(null);
  const [lastSentAppSnapshot, setLastSentAppSnapshot] = useState<{
    sessionId: string;
    hash: string;
  } | null>(null);
  const handleAppSnapshotCaptureReady = useCallback(
    (capture: CaptureAppSnapshot | null) => {
      appSnapshotCaptureRef.current = capture;
    },
    [],
  );

  // Convex mutation for sending messages
  // Optimistic update: the scholar's bubble appears the instant they hit
  // send, not after the mutation round-trip. Convex swaps in the server
  // copy (and reverts on failure) automatically.
  const sendMsg = useMutation(api.sessions.sendMessage).withOptimisticUpdate(
    (localStore, args) => {
      const current = localStore.getQuery(api.sessions.getWithMessages, {
        id: args.sessionId,
      });
      if (!current) return;
      // eslint-disable-next-line react-hooks/purity -- callback runs at mutation time, not during render
      const now = Date.now();
      const optimisticId = `optimistic-${now}` as unknown as Id<"messages">;
      localStore.setQuery(
        api.sessions.getWithMessages,
        { id: args.sessionId },
        {
          ...current,
          messages: [
            ...current.messages,
            {
              _id: optimisticId,
              _creationTime: now,
              id: optimisticId,
              createdAt: now,
              sessionId: args.sessionId,
              role: "user" as const,
              content: args.message,
              inputModality: args.inputModality,
              flagged: false,
              resourceShare: null,
              gotItWrong: false,
              gotItWrongReason: undefined,
              // The server copy brings the photo's URL; the optimistic bubble
              // shows the text until then.
              imageUrl: null,
              appSnapshotUrl: null,
              ...(args.imageId ? { imageId: args.imageId } : {}),
            },
          ],
        },
      );
    },
  );

  // Manual-rehearsal flags (phase 3): teacher 👍/👎 on tutor messages so
  // Curriculum Bot can use them as a steer when refining the activity's
  // systemPrompt. Skipped outside manual-rehearsal sessions.
  const isManualRehearsalSessionForFlags = !!sessionData?.session?.isTestDrive;

  // Room Layer — a teacher's live cue reaching THIS scholar's open session.
  // Scoped to a genuine scholar session only: never subscribed during
  // teacher manual rehearsal, remote-view, or self-preview (see
  // convex/roomCues.ts — the query is scholar-only by design).
  const roomCues = useActiveRoomCues(
    !isTestMode && !isRemoteMode && !isManualRehearsalSessionForFlags,
  );
  const testDriveFlags = useQuery(
    api.testDriveFlags.listForSession,
    isManualRehearsalSessionForFlags
      ? { sessionId: sessionId as Id<"sessions"> }
      : "skip",
  );
  const flagMessage = useMutation(api.testDriveFlags.toggle);
  // Map for O(1) lookup of a tutor message's current flag in the chat
  // list. Memo'd on the flags array so we don't rebuild every render.
  const flagsByMessageId = useMemo(() => {
    const m = new Map<string, "good" | "bad">();
    if (testDriveFlags) {
      for (const f of testDriveFlags) m.set(String(f.messageId), f.kind);
    }
    return m;
  }, [testDriveFlags]);
  // The messages array is captured here so we can grab the snippet of
  // the just-flagged tutor message for the pending-flag chip.
  const messagesRef = useRef<typeof messages>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const handleToggleFlag = useCallback(
    async (messageId: string, kind: "good" | "bad") => {
      try {
        haptic("light");
        const result = await flagMessage({
          messageId: messageId as Id<"messages">,
          kind,
        });
        if (result.kind) {
          // Flag was set or replaced — open the bot drawer so the teacher
          // can type a "why" note. Add (or update) the entry in the
          // pending stack; replace if the same message is re-flagged with
          // a different kind, otherwise append.
          const target = messagesRef.current.find((m) => m.id === messageId);
          const snippet = (target?.content ?? "")
            .slice(0, MAX_FLAG_SNIPPET_LEN)
            .trim();
          setPendingFlags((prev) => {
            const without = prev.filter((p) => p.messageId !== messageId);
            return [...without, { messageId, kind: result.kind!, snippet }];
          });
          setBotDrawerOpen(true);
        } else {
          // Flag was toggled OFF — drop any matching pending chip so we
          // don't leave a stale prompt above the input.
          setPendingFlags((prev) => prev.filter((p) => p.messageId !== messageId));
        }
      } catch (err) {
        console.error("Failed to toggle manual-rehearsal flag:", err);
      }
    },
    [flagMessage, setBotDrawerOpen],
  );

  // Scholar "Rabbithole got this wrong" flag. Available on the scholar's own
  // live session (not manual-rehearsal, not a teacher's remote view). Catching the
  // AI out is celebrated in the moment and recorded for the teacher.
  const flagWrong = useMutation(api.messageFlags.toggle);
  const canFlagWrong = !isRemoteMode && !isManualRehearsalSessionForFlags;
  const handleFlagWrong = useCallback(
    async (messageId: string, currentlyFlagged: boolean) => {
      try {
        haptic(currentlyFlagged ? "light" : "success");
        const result = await flagWrong({
          messageId: messageId as Id<"messages">,
        });
        if (result.flagged) {
          toaster.create({
            title: "🎯 Good catch!",
            description:
              "You flagged this for your teacher. Questioning the AI is exactly right.",
            type: "success",
            duration: 4000,
          });
        }
      } catch (err) {
        console.error("Failed to flag message as wrong:", err);
        toaster.create({
          title: "Couldn't save that flag",
          description: "Please try again in a moment.",
          type: "error",
        });
      }
    },
    [flagWrong],
  );
  const setNoteOnFlag = useMutation(api.testDriveFlags.setNote);
  const handleAttachNoteToFlags = useCallback(
    async (note: string) => {
      if (pendingFlags.length === 0) return;
      // Attach the same "why" note to every pending flag — when the
      // teacher flags multiple things and types one explanation, that
      // explanation generally applies to the cluster, not to one
      // specific flag. Bot reads them all and triangulates.
      try {
        await Promise.all(
          pendingFlags.map((f) =>
            setNoteOnFlag({
              messageId: f.messageId as Id<"messages">,
              note,
            }),
          ),
        );
      } catch (err) {
        console.error("Failed to attach flag notes:", err);
        // Surface to the teacher — the message still went to the bot
        // (their snapshot is on the user message), but the inline flag
        // note that the bot uses on its NEXT turn won't be there. They
        // can re-flag and resend if they want the bot to see the rationale.
        toaster.create({
          title: "Couldn't attach your note to the flag",
          description:
            "The bot still saw your message, but won't see this as a flag note. Try flagging again if you'd like the bot to use it as a strong signal.",
          type: "warning",
        });
      } finally {
        setPendingFlags([]);
      }
    },
    [pendingFlags, setNoteOnFlag],
  );
  const dismissPendingFlag = useCallback(
    (messageId: string) =>
      setPendingFlags((prev) => prev.filter((p) => p.messageId !== messageId)),
    [],
  );

  const sendMessageRef = useRef<
    (
      text: string,
      inputModality: MessageInputModality,
      options?: { readingYourTurn?: boolean },
    ) => void
  >(() => {});
  // Set when a take was started from a your-turn box's mic (TRA-504), so its
  // transcript goes to the tutor marked as the child reading the line aloud.
  const readingYourTurnRef = useRef(false);
  // Lets handleSend tell the replay driver a manual turn was sent (so the
  // strip retires when the teacher takes over) without a use-before-decl on
  // the replay hook, which is set up further down.
  const replayNotifyRef = useRef<() => void>(() => {});

  const { state: dictationState, error: dictationError, isTooLoud, hasSpeech, isMicBusy, toggleRecording, startRecording, stopRecording, cancelRecording } =
    useStreamingDictation((text) => {
      const readingYourTurn = readingYourTurnRef.current;
      readingYourTurnRef.current = false;
      sendMessageRef.current(
        text,
        "spoken",
        readingYourTurn ? { readingYourTurn } : undefined,
      );
    }, sessionId as Id<"sessions">);
  // The your-turn box's mic: the ordinary dictation (silence ends the take),
  // marked as the child reading the line aloud.
  const onReadYourTurn = useCallback(() => {
    readingYourTurnRef.current = true;
    getTTSEngine()?.stop(); // don't record over the tutor's voice
    void startRecording({ latched: true });
  }, [startRecording]);
  // The composer's own mic starts an ordinary take, never a read-aloud.
  const composerToggleRecording = useCallback(() => {
    if (dictationState === "idle") readingYourTurnRef.current = false;
    return toggleRecording();
  }, [dictationState, toggleRecording]);
  const composerCancelRecording = useCallback(() => {
    readingYourTurnRef.current = false;
    cancelRecording();
  }, [cancelRecording]);

  // Voice-first loop plumbing. The engine's onIdle fires when the spoken
  // reply drains; if the stream is also done, listening resumes (latched,
  // silence auto-stop) and the transcript auto-sends — a conversation.
  const isStreamingRef = useRef(isStreaming);
  // eslint-disable-next-line react-hooks/refs -- mirror for the engine's onIdle callback
  isStreamingRef.current = isStreaming;
  const maybeAutoListen = useCallback(() => {
    if (!voiceModeRef.current || !sttEnabled) return;
    if (isBeginnerSessionRef.current) return; // read to, answers by tap-to-talk
    if (isStreamingRef.current) return; // more sentences may still arrive
    if (document.visibilityState === "hidden") return;
    // Eyes-free "your turn" cue — kids docked in the Folio can't feel the
    // haptic, so the mic opening gets an audible blip too.
    getTTSEngine()?.playListeningCue();
    void startRecording({ latched: true, auto: true });
  }, [sttEnabled, startRecording]);
  const maybeAutoListenRef = useRef(maybeAutoListen);
  // eslint-disable-next-line react-hooks/refs, react-hooks/immutability -- latest callback for engine onIdle + stream done
  maybeAutoListenRef.current = maybeAutoListen;
  useEffect(() => {
    const engine = getTTSEngine();
    if (!engine) return;
    engine.onIdle = () => maybeAutoListenRef.current();
    return () => {
      engine.onIdle = null;
      engine.stop();
      keepAwake(false);
    };
  }, []);

  // Background hygiene: leaving the app (home bar, app switcher, tab switch)
  // stops the mic and the tutor's voice immediately — no recording or
  // playback conceptually running while backgrounded, no weird resume state.
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState !== "hidden") return;
      cancelRecording();
      getTTSEngine()?.stop();
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => document.removeEventListener("visibilitychange", onHidden);
  }, [cancelRecording]);

  const setVoiceMode = useCallback(
    (on: boolean) => {
      setVoiceModeState(on);
      voiceModeRef.current = on;
      try {
        localStorage.setItem("rabbithole.voiceMode", on ? "1" : "0");
      } catch {
        // private mode etc. — preference just won't persist
      }
      const engine = getTTSEngine();
      // Hold the screen-sleep lock while voice mode is on — a kid listening
      // to a long reply isn't touching the screen.
      keepAwake(on);
      if (on) {
        haptic("light");
        engine?.unlock(); // user gesture — lets iOS start the AudioContext
        maybeAutoListenRef.current(); // kid expects to talk right away
      } else {
        engine?.stop();
        cancelRecording();
      }
    },
    [cancelRecording],
  );

  // Time limit mode
  const timeLimit = useTimeLimit(
    sessionId,
    sessionData?.session?.sessionTimeLimit,
    sessionData?.session?.sessionStartTime,
  );
  const [isTimeLimitModalOpen, setIsTimeLimitModalOpen] = useState(false);

  // Loading state: sessionData is undefined while the query is loading
  const isLoading = sessionData === undefined;

  const scrollFrameRef = useRef<number | null>(null);
  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current);
    }
    // Late layout (markdown rendering, async image/artifact loads, queries
    // settling right after mount) keeps growing the transcript for well over a
    // second after the messages arrive — so a single scroll (or a short fixed
    // burst) fires while the content is still short and lands near the TOP, then
    // never re-pins. Keep re-pinning to the bottom until the scroll height stops
    // changing (content settled) or a ~2s safety cap, so we land AND stay at the
    // latest message. Only the first pin honors the requested behavior; the
    // corrections are instant (a smooth animation every frame would fight itself).
    let tries = 0;
    let lastHeight = -1;
    let stableFrames = 0;
    const pin = () => {
      scrollFrameRef.current = null;
      const anchor = messagesEndRef.current;
      if (!anchor) return;
      anchor.scrollIntoView({ behavior: tries === 0 ? behavior : "auto", block: "end" });
      // Track the scroll container's height; once it holds steady for a few
      // frames, the transcript has finished laying out and we can stop.
      const scroller = anchor.closest<HTMLElement>("[data-scroll-region]");
      const height = scroller ? scroller.scrollHeight : 0;
      if (height === lastHeight) stableFrames += 1;
      else {
        stableFrames = 0;
        lastHeight = height;
      }
      tries += 1;
      if (stableFrames < 4 && tries < 120) {
        scrollFrameRef.current = requestAnimationFrame(pin);
      }
    };
    scrollFrameRef.current = requestAnimationFrame(pin);
  }, []);

  // On first load, jump to the latest message instantly (no smooth-scroll
  // animation from the top); on subsequent new messages, follow smoothly.
  const didInitialScrollRef = useRef(false);
  useEffect(() => {
    if (messages.length === 0) return;
    scrollToBottom(didInitialScrollRef.current ? "smooth" : "auto");
    didInitialScrollRef.current = true;
  }, [messages, scrollToBottom]);

  useEffect(() => {
    if (streamingContent) scrollToBottom("auto");
  }, [streamingContent, scrollToBottom]);

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
      }
    };
  }, []);

  // Auto-focus textarea when project changes or finishes loading
  useEffect(() => {
    if (!isLoading && textareaRef.current) {
      textareaRef.current.focus({ preventScroll: true });
    }
  }, [isLoading, sessionId]);

  // Focus mismatch: the class is on a different unit/lesson than this session.
  // INFORMATIONAL ONLY since the hard focus gate was removed (shared/
  // focusLock.ts) — teachers found the read-only wall too rigid, so this now
  // drives a soft "right now your class is with X" banner and nothing else.
  // Homework sessions never show it (policy a, PR #707): required,
  // independently-scheduled work isn't "off the class's focus".
  const isFocusMismatch = !isTestMode && !isHomeworkSession && focusLock?.unitId != null && (
    String(sessionData?.session?.unitId ?? "") !== focusLock.unitId ||
    (focusLock.lessonId != null &&
      String(sessionData?.session?.lessonId ?? "") !== focusLock.lessonId)
  );

  // "The turn, not the bell": the scholar is INSIDE the live class-focus
  // session itself (the exact inverse of the mismatch above) — the surface
  // that gets the winding-down cue (item 2) and the at-the-turn choice
  // (item 3), never a lock.
  const isFocusMatch =
    !isTestMode && !isHomeworkSession && focusLock?.unitId != null && !isFocusMismatch;
  // A lifetime ("through Friday") is not the room's clock: no "your class is
  // elsewhere" banner and no turn memory for it — only the plate line below.
  const focusHasRoomClock = focusLock?.lifetimeEndsAt == null;
  const roomPhase = useRoomTurnPhase(focusLock?.endsAt ?? null);
  const { showTurnBanner } = useRoomTurnAwareness(
    isFocusMatch && focusHasRoomClock,
    roomPhase,
    focusLock?.label ?? null,
    focusLock?.endsAt ?? null,
  );
  // Current activity done with NO forward next: this session is over, so the
  // card hands off to Home. What it deliberately does NOT claim is that the
  // UNIT is finished. These counts come from `activities.listByUnitPublic`,
  // which is scoped to what THIS assignment made live, so "nothing in front of
  // me" is not "I finished the unit" — a homework session carrying one
  // activity out of a multi-lesson unit satisfied the old
  // `completedCount >= total` test and announced "Unit complete!" to a scholar
  // who had barely started. Home owns the real unit picture; the card's only
  // job is to get the scholar there.
  const completionHandsOffToHome =
    activityNav.hasActivityContext &&
    activityNav.isCurrentDone &&
    !activityNav.nextOnlineActivity &&
    // Requires the activity list to be loaded (count > 0) so a still-loading or
    // genuinely empty unit falls through to the generic complete state rather
    // than a premature "head home".
    activityNav.unitOnlineActivityCount > 0;
  // The one thing this list CAN prove: activities visible in this session are
  // still incomplete, and they are all behind us (the in-session Continue CTA
  // is forward-only — see shared/nextIncompleteActivity.ts). Home owns routing
  // back to those earlier beats; the card just says there is more left.
  const completionEarlierHole =
    completionHandsOffToHome &&
    activityNav.unitCompletedOnlineCount < activityNav.unitOnlineActivityCount;
  const completionHandoffOwnsNavigation = completionHandsOffToHome;
  const focusTimeLabel =
    focusLock?.endsAt != null && focusLock.timeZone
      ? formatRoomTurnTime(focusLock.endsAt, focusLock.timeZone)
      : null;

  // Pending whisper from project data (reactive)
  const pendingWhisper = sessionData?.session?.pendingWhisper ?? null;

  // Mastery observations for this project (teacher only, for inline debug display)
  const sessionObservations = useQuery(
    api.masteryObservations.bySession,
    isRemoteMode ? { sessionId: sessionId as Id<"sessions"> } : "skip"
  ) ?? [];

  // Send whisper via project update mutation
  const handleSendWhisper = async () => {
    const text = whisperInput.trim();
    if (!text) return;
    await updateSession({
      id: sessionId as Id<"sessions">,
      pendingWhisper: text,
    });
    setWhisperInput("");
  };

  const handleClearWhisper = async () => {
    await updateSession({
      id: sessionId as Id<"sessions">,
      pendingWhisper: null,
    });
  };

  // Send message via Convex mutation + HTTP streaming
  // Returns true if a message was actually dispatched, false if it no-op'd
  // (empty input or a stream already in flight). The replay driver
  // (useManualRehearsalReplay) relies on this to avoid advancing past an
  // undispatched turn. Once we pass the no-op guard the message IS created, so
  // even a streaming error returns true (retrying would duplicate the turn).
  // App → tutor updates (askTutor taps, character/judge events) wait in one
  // queue and go out between replies as one app-update turn. Only the owner's
  // client drains: a teacher in remote mode hosts the same app but must never
  // start tutor turns in the scholar's session.
  const isSessionOwner =
    !isRemoteMode &&
    !!currentUser &&
    !!sessionData?.session &&
    String(sessionData.session.userId) === String(currentUser._id);
  const appTutorUpdates = useAppTutorUpdates({
    sessionId,
    enabled: isSessionOwner,
    busy: isStreaming || kickoffBlocksSending,
    send: (batch) =>
      settleAppTutorSend((onPrepared) =>
        handleSend(undefined, "app", { appUpdate: { batch, onPrepared } }),
      ),
  });

  // `appUpdate` turns are opened by the queue above, which calls this only
  // while no reply streams; it learns the mutation's outcome via `onPrepared`
  // and the stream continues on its own.
  const handleSend = async (
    directText?: string,
    inputModality: MessageInputModality = "typed",
    options?: {
      /** A spoken read-aloud of the last reply's your-turn line (TRA-504). */
      readingYourTurn?: boolean;
      appUpdate?: {
        batch: AppTutorUpdateBatch;
        onPrepared: (result: AppTutorSendResult) => void;
      };
    },
  ): Promise<boolean> => {
    const appUpdate = options?.appUpdate;
    const isAppRequest = appUpdate !== undefined;
    const rawMessage = isAppRequest ? "" : directText?.trim() || input.trim();
    // Allow sending with just an image (use placeholder text)
    const userMessage =
      rawMessage ||
      (!isAppRequest && pendingImage ? "What do you see in this image?" : "");
    if (
      (!userMessage && !isAppRequest) ||
      kickoffPendingRef.current ||
      activeKickoffPlaceholder
    ) {
      return false;
    }
    voiceMark("sendMessage"); // no-op unless a voice-perf cycle is armed

    // Steering: submitting while the tutor streams stops the current reply and
    // replaces it with this turn. Stop the server loop + abort the local fetch
    // BEFORE taking the send lock — the aborted stream (which now runs OUTSIDE
    // the lock) releases it, so this new turn isn't blocked.
    if (isStreaming && !isAppRequest) {
      void requestStop({ sessionId: sessionId as Id<"sessions"> });
      void stream.stop();
    }

    // The lock guards only the mutation (artifact flush + message insert), not
    // the whole stream, so a later steer can always acquire it.
    const prepared = await runWithSendLock(async () => {
      // A non-<start> send the teacher initiated retires any pending replay
      // strip (no-op during a replayed turn — the driver checks its own run
      // flag). Skip the synthetic greeting kick.
      if (!isAppRequest && rawMessage !== "<start>") replayNotifyRef.current();

      // Upload image if attached
      let imageId: string | null = null;
      if (!isAppRequest && pendingImage) {
        try {
          imageId = await uploadPendingImage();
        } catch (err) {
          console.error("Image upload failed:", err);
        }
      }

      // Flush any debounced artifact saves before kicking off the stream.
      // A conflict is a deliberate no-send: preserve the composer and tell the
      // scholar which visible document action unblocks it.
      try {
        await flushAllArtifactSaves();
      } catch (error) {
        console.error("Error saving document before message:", error);
        // A background app update stays queued and retries; only the
        // scholar's own send needs telling.
        if (!isAppRequest) {
          toaster.error({
            title: "Finish saving your document",
            description:
              "Choose a document version or retry its save before sending your message.",
          });
        }
        return null;
      }

      if (appUpdate) {
        try {
          const result = await startAppUpdateTurn({
            sessionId: sessionId as Id<"sessions">,
            asks: appUpdate.batch.asks,
          });
          appUpdate.onPrepared(appTutorSendResultFromStatus(result.status));
          return result.status === "started" ? result : null;
        } catch {
          appUpdate.onPrepared("failed");
          return null;
        }
      }

      try {
        // Send message via Convex mutation (creates user msg + placeholder assistant msg)
        const result = await sendMsg({
          sessionId: sessionId as Id<"sessions">,
          message: userMessage,
          ...(imageId ? { imageId: imageId as Id<"_storage"> } : {}),
          ...(userMessage !== "<start>" ? { inputModality } : {}),
          ...(options?.readingYourTurn ? { readingYourTurn: true } : {}),
        });
        // Both the artifact flush and message mutation succeeded. Keep the
        // composer intact when a revision conflict blocks either operation.
        // Only a send that read the composer clears it: the <start> opener
        // persisting must not erase a first question typed meanwhile (TRA-527).
        setInput((composer) =>
          composerAfterPersistedSend(composer, { directText, isAppRequest }),
        );
        clearPendingImage();
        // This turn carries the app's character/judge events to the tutor.
        appTutorUpdates.clearAppAi();
        haptic("light");
        return result;
      } catch (error) {
        console.error("Error sending message:", error);
        // A deliberate refusal (e.g. a teacher put this app away while the
        // tab was open) says why instead of failing silently.
        const refusal = serverRefusal(error);
        if (refusal && userMessage !== "<start>") {
          toaster.error({ title: "Couldn't send", description: refusal });
        }
        return null;
      }
    });

    if (!prepared) return false;

    let appSnapshot:
      | { storageId: Id<"_storage">; hash: string }
      | null = null;
    // A character-only update adds no user row, so a snapshot would land on
    // the scholar's last typed message instead: send none.
    if (
      userMessage !== "<start>" &&
      (!appUpdate || appUpdate.batch.asks.length > 0)
    ) {
      try {
        appSnapshot = await uploadChangedAppSnapshot({
          captureSnapshot: appSnapshotCaptureRef.current,
          lastSentHash:
            lastSentAppSnapshot?.sessionId === sessionId
              ? lastSentAppSnapshot.hash
              : null,
          generateUploadUrl: generateAppSnapshotUploadUrl,
        });
      } catch (error) {
        console.error("[session] app snapshot upload failed", error);
      }
    }

    // Stream OUTSIDE the lock. useAgentStream.send() self-serializes (a steer
    // preempts any run still settling), so overlapping turns can't interleave.
    const convexUrl = convexSiteUrl();
    if (!isAppRequest) setUserTurnFailed(false);
    // The scholar wrote first: the held opener is no longer needed.
    if (!isAppRequest) setKickoffHeldForKey(false);
    if (appSnapshot) {
      setLastSentAppSnapshot({
        sessionId,
        hash: appSnapshot.hash,
      });
    }
    const appContext = appUpdate
      ? newestAppTutorAskContext(appUpdate.batch)
      : undefined;
    if (appUpdate) setAppUpdateMsgId(prepared.assistantMsgId);
    const completed = await sendTutorStream(
      `${convexUrl}/session-stream`,
      {
        sessionId: prepared.sessionId,
        streamId: prepared.streamId,
        assistantMsgId: prepared.assistantMsgId,
        platform: "web",
        ...(appSnapshot
          ? { appSnapshotStorageId: appSnapshot.storageId }
          : {}),
        ...(appUpdate && appUpdate.batch.asks.length > 0
          ? { appRequest: { ...(appContext ? { context: appContext } : {}) } }
          : {}),
      },
      prepared.assistantMsgId,
    );
    if (appUpdate) {
      setAppUpdateMsgId(null);
      // An app update is not the scholar's turn: it never shows the
      // "didn't go through" retry (the next update or typed turn covers it).
      return true;
    }
    // A user turn that never completed (busy budget spent / hard error) keeps
    // its message visible with the inline retry affordance.
    if (!completed) setUserTurnFailed(true);
    return true;
  };

  // An app-update turn that has not spoken yet is invisible: no typing dots,
  // no Stop control, a live composer (sending steers it). Once text arrives
  // it renders as an ordinary tutor reply.
  const quietTurn =
    isStreaming &&
    appUpdateMsgId !== null &&
    streamingMsgId === appUpdateMsgId &&
    !streamingContent.trim();
  const tutorVisiblyStreaming = isStreaming && !quietTurn;

  // The composer's Stop control: stop the server loop (finalizes the partial
  // and stops it "popping back") AND abort the local fetch, keeping the partial
  // text on screen. Never marks the turn failed and never toasts.
  const handleStopStream = useCallback(() => {
    void requestStop({ sessionId: sessionId as Id<"sessions"> });
    void stream.stop();
  }, [requestStop, sessionId, stream]);

  // Re-run a FAILED SCHOLAR (user) turn without persisting a second scholar
  // message. retryAssistantTurn inserts a fresh placeholder server-side, and
  // refuses (returns null) unless the trailing turn is a genuinely-dead scholar
  // user turn — so a silent turn (kickoff / rubric check) can never be retried
  // through here. Silent turns own their own recovery (kickoff self-recovers;
  // "Check my work" re-runs the rubric), and the affordance is never shown for
  // them, so this path is user-turn-only.
  const retryAssistantTurn = useMutation(api.sessions.retryAssistantTurn);
  // Release a kickoff held for a missing key; the kickoff effect runs it again.
  const retryHeldKickoff = useCallback(() => {
    setKickoffHeldForKey(false);
    welcomeSentRef.current = null;
    bumpKickoffRetry((n) => n + 1);
  }, []);
  const handleRetryTurn = useCallback(async () => {
    if (isStreaming) return;
    // Hold the lock only around the placeholder mutation, then stream OUTSIDE
    // it (like handleSend) so a steer submitted mid-retry can acquire the lock
    // and isn't silently dropped.
    const prepared = await runWithSendLock(async () => {
      try {
        const result = await retryAssistantTurn({
          sessionId: sessionId as Id<"sessions">,
        });
        if (!result) {
          // The server refused (e.g. a user turn that streamed text before a
          // tool split — the partial reply stays visible). Clear the affordance
          // so the button doesn't linger. Matches native.
          setUserTurnFailed(false);
          return null;
        }
        setUserTurnFailed(false);
        return result;
      } catch (error) {
        console.error("Error retrying turn:", error);
        return null;
      }
    });
    // undefined = lock was held (a concurrent send); null = server refused /
    // errored. Either way there is nothing to stream.
    if (!prepared) return;
    const convexUrl = convexSiteUrl();
    const completed = await sendTutorStream(
      `${convexUrl}/session-stream`,
      {
        sessionId: prepared.sessionId,
        streamId: prepared.streamId,
        assistantMsgId: prepared.assistantMsgId,
        platform: "web",
      },
      prepared.assistantMsgId,
    );
    if (!completed) setUserTurnFailed(true);
  }, [isStreaming, retryAssistantTurn, runWithSendLock, sessionId, sendTutorStream]);

  const handleInstructionHandback = useCallback(
    async (handback: InstructionHandbackStart) => {
      if (isStreaming) {
        throw new Error("The tutor is already responding");
      }
      // The handback data is already prepared server-side; the lock only claims
      // the send slot. Acquire-and-release it, then stream OUTSIDE the lock (as
      // handleSend does) so a steer isn't blocked for the whole stream.
      const acquired = await runWithSendLock(async () => true);
      if (!acquired) throw new Error("The tutor is already responding");
      const convexUrl = convexSiteUrl();
      await sendTutorStream(
        `${convexUrl}/session-stream`,
        {
          sessionId: handback.sessionId,
          streamId: handback.streamId,
          assistantMsgId: handback.assistantMsgId,
          platform: "web",
        },
        handback.assistantMsgId,
      );
    },
    [isStreaming, runWithSendLock, sendTutorStream],
  );

  // Re-score the deliverable against its rubric ("Check my work"). Unlike a
  // normal send, this persists NO user message — an ephemeral
  // instruction is injected server-side (convex/http.ts) so the transcript
  // never shows a message the scholar didn't type. The tutor still streams its
  // reply + calls update_rubric_score, so the stars update as before.
  const handleSubmitArtifact = async (
    artifactId: Id<"artifacts">,
    artifactTitle: string,
    shouldCheck: boolean,
  ): Promise<void> => {
    if (
      isStreaming ||
      kickoffPendingRef.current ||
      activeKickoffPlaceholder
    ) {
      return;
    }
    // Hold the lock only around the deliverable submit + rubric-check
    // preparation; stream OUTSIDE it (like handleSend) so a steer submitted
    // mid-check can acquire the lock instead of being silently dropped.
    const prepared = await runWithSendLock(() =>
      prepareDeliverableSubmit({ artifactId, shouldCheck }),
    );
    // undefined = lock held; null = send-only / flush conflict / error. Nothing
    // to stream in any of those cases.
    if (!prepared) return;
    // A new silent turn supersedes any lingering failed-user-turn state.
    setUserTurnFailed(false);
    const convexUrl = convexSiteUrl();
    await sendTutorStream(
      `${convexUrl}/session-stream`,
      {
        sessionId: prepared.sessionId,
        streamId: prepared.streamId,
        assistantMsgId: prepared.assistantMsgId,
        platform: "web",
        rubricCheck: { artifactTitle },
      },
      prepared.assistantMsgId,
    );
  };

  // Keep ref in sync so dictation callback can call latest handleSend
  // eslint-disable-next-line react-hooks/refs
  sendMessageRef.current = handleSend;

  // Manual-rehearsal "Reset & replay": when a fresh rehearsal carries a staged
  // scholar script (see projects.resetTestDrive), this driver re-sends
  // those turns against the edited prompt so the teacher watches instead of
  // re-typing. handleSend resolves when the tutor's stream completes, so
  // the driver is a plain sequential await loop. The strip lives in the
  // cyan ManualRehearsalBanner (which owns the manual-rehearsal chrome).
  const clearReplayMut = useMutation(api.sessions.clearReplayScript);
  const replay = useManualRehearsalReplay({
    session: sessionData?.session as Doc<"sessions"> | undefined,
    sendText: handleSend,
    getIsStreaming: () => isStreamingRef.current,
    getGreetingLanded: () => messages.some((m) => m.role === "assistant"),
    clearReplay: () => {
      void clearReplayMut({ sessionId: sessionId as Id<"sessions"> }).catch(
        (err) => console.error("Failed to clear replay script:", err),
      );
    },
  });
  // eslint-disable-next-line react-hooks/refs -- mirror for handleSend (defined above)
  replayNotifyRef.current = replay.notifyManualSend;

  useEffect(() => {
    return () => {
      if (kickoffRetryTimerRef.current) {
        clearTimeout(kickoffRetryTimerRef.current);
      }
    };
  }, []);

  // Activity sessions open with an honest, assistant-only kickoff. A durable
  // trigger on its placeholder lets an interrupted blank turn wait out the
  // server liveness window, then safely replace and retry it. Independent study
  // keeps the existing hidden <start> path.
  useEffect(() => {
    if (!sessionData || isStreaming || kickoffPendingRef.current) return;
    // An opener refused for want of a key leaves only its hidden <start>: the
    // stream discards the empty placeholder (TRA-536), so nothing marks the
    // turn dead and the chat would sit blank. On a fresh mount (back from
    // /tutor-key, or a reload) ask for that reply again, once per mount. A
    // key still missing fails the same way and shows the notice; welcomeSentRef
    // stays set, so it never loops.
    const onlyMessage =
      sessionData.messages.length === 1 ? sessionData.messages[0] : null;
    if (
      onlyMessage?.role === "user" &&
      onlyMessage.content === "<start>" &&
      !sessionData.session.activityId &&
      !sessionData.session.isArchived &&
      currentUser &&
      String(currentUser._id) === String(sessionData.session.userId)
    ) {
      if (welcomeSentRef.current === sessionId) return;
      welcomeSentRef.current = sessionId;
      void handleRetryTurn();
      return;
    }
    const hasNoMessages = sessionData.messages.length === 0;
    if (!hasNoMessages && !activeKickoffPlaceholder) {
      if (kickoffRetryTimerRef.current) {
        clearTimeout(kickoffRetryTimerRef.current);
        kickoffRetryTimerRef.current = null;
      }
      return;
    }
    if (welcomeSentRef.current === sessionId) return;

    const session = sessionData.session;
    // A teacher-archived app never opens a turn (the server refuses anyway);
    // the scholar sees the archived pane, a teacher reads the transcript.
    if (isTeacherArchived(session)) return;
    if (session.activityId) {
      if (
        session.isArchived ||
        session.isOffline ||
        !currentUser ||
        String(currentUser._id) !== String(session.userId)
      ) {
        return;
      }
      if (kickoffRetryTimerRef.current) {
        clearTimeout(kickoffRetryTimerRef.current);
        kickoffRetryTimerRef.current = null;
      }
      welcomeSentRef.current = sessionId;
      kickoffPendingRef.current = true;
      void (async () => {
        setKickoffPending(true);
        try {
          const result = await startActivityKickoff({
            sessionId: sessionId as Id<"sessions">,
          });
          if (!result) return;
          if (result.status === "pending") {
            kickoffRetryTimerRef.current = setTimeout(() => {
              kickoffRetryTimerRef.current = null;
              welcomeSentRef.current = null;
              bumpKickoffRetry((n) => n + 1);
            }, result.retryAfterMs + 50);
            return;
          }
          // A new silent turn supersedes any lingering failed-user-turn state.
          setUserTurnFailed(false);
          const convexUrl = convexSiteUrl();
          const completed = await sendTutorStream(
            `${convexUrl}/session-stream`,
            {
              sessionId: result.sessionId,
              streamId: result.streamId,
              assistantMsgId: result.assistantMsgId,
              platform: "web",
              kickoff: true,
            },
            result.assistantMsgId,
          );
          if (!completed) {
            // No key: hold the kickoff (welcomeSentRef stays set, so this
            // effect won't refire) until the scholar taps Try again.
            if (streamNeededKeyRef.current) setKickoffHeldForKey(true);
            else welcomeSentRef.current = null;
          }
        } catch (error) {
          console.error("Error starting activity kickoff:", error);
          kickoffRetryTimerRef.current = setTimeout(() => {
            kickoffRetryTimerRef.current = null;
            welcomeSentRef.current = null;
            bumpKickoffRetry((n) => n + 1);
          }, 1_000);
        } finally {
          kickoffPendingRef.current = false;
          setKickoffPending(false);
        }
      })();
      return;
    }

    // No activity yet, but one is being designed right now: hold the opener
    // rather than ad-libbing the topic and abandoning it when the real task
    // lands mid-conversation. The effect re-runs on both exits — the activity
    // arriving (sessionData) and the wait capping out (questBakeHolding) — so
    // one of the two branches above always ends up opening the session.
    if (questBakeHolding) return;

    welcomeSentRef.current = sessionId;
    void handleSend("<start>");
  }, [sessionData, isStreaming, sessionId, currentUser, activeKickoffPlaceholder, questBakeHolding, kickoffHeldForKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle keyboard
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(
        textareaRef.current.scrollHeight,
        200
      )}px`;
    }
  }, [input]);

  // Artifact callbacks
  const handleCreateArtifact = useCallback(async () => {
    const newId = await createArtifact({
      sessionId: sessionId as Id<"sessions">,
    });
    setActiveArtifactId(newId);
    setRightPanelOpen(true);
  }, [sessionId, createArtifact]);

  const handleDeleteArtifact = useCallback(async (id: string) => {
    await deleteArtifactMut({ artifactId: id as Id<"artifacts"> });
  }, [deleteArtifactMut]);

  const handleSaveArtifact = useCallback(
    async (
      artifactId: string,
      updates: { content?: string; title?: string; baseRevision?: number },
    ) => {
      return await saveArtifact({
        artifactId: artifactId as Id<"artifacts">,
        ...updates,
      });
    },
    [saveArtifact],
  );

  if (isLoading) {
    return (
      <Flex flex={1} align="center" justify="center">
        <Spinner size="lg" color="violet.500" />
      </Flex>
    );
  }

  // Offline session: no chat thread — it's a container for scanned
  // deliverables. Render the read-only scan view instead of the chat UI.
  if (sessionData?.session?.isOffline) {
    return (
      <OfflineSessionView
        sessionId={sessionData.session._id as Id<"sessions">}
        onBack={onBack}
      />
    );
  }

  const isManualRehearsalSession = !!sessionData?.session?.isTestDrive;

  return (
    <Flex flex={1} flexDir="column" overflow="hidden" bg="white">
      {/* Room Layer — a teacher's live cue reaching this open session. Rest
          overlays the WHOLE screen (fixed positioning) without touching
          anything underneath; message/transition are a dismissible strip,
          same idea as the manual-rehearsal banner below but scholar-facing. */}
      {roomCues.rest && <RestOverlay returnAt={roomCues.rest.returnAt} />}
      {roomCues.message && (
        <RoomCueBanner cue={roomCues.message} onDismiss={roomCues.dismiss} />
      )}
      {roomCues.transition && (
        <RoomCueBanner cue={roomCues.transition} onDismiss={roomCues.dismiss} />
      )}
      {/* manual-rehearsal banner — sits ABOVE the project header so the cyan
          stripe is the very first thing the teacher sees. Cyan so it
          doesn't compete with violet (curriculum bot) or other purple UI.
          The View as picker, Reset, and Curriculum Bot triggers all live
          in this banner so the manual-rehearsal surface owns its controls. */}
      {isManualRehearsalSession && sessionData?.session && (
        <ManualRehearsalBanner
          session={sessionData.session as Doc<"sessions">}
          scholarTurnCount={
            messages.filter(
              (m) => m.role === "user" && m.content !== "<start>",
            ).length
          }
          replay={replay}
          onOpenBot={
            sessionData.session.unitId
              ? () => setBotDrawerOpen(true)
              : undefined
          }
        />
      )}

      {/* Quest context — used to be a full-width purple banner above
          the header. Now an `eyebrow` sliver above the project title
          inside the compass button (see SessionHeader). The Big
          Picture drawer carries the rest of the framing (mission,
          angle, activities, badges) so we don't need to repeat it as
          ambient chrome on every quest project. */}

      {/* Project Header with dimension selectors */}
      <SessionHeader
        // Lead with the ACTIVITY (where you actually are), not the unit.
        // The unit is the breadcrumb (compassEyebrow below). For a session
        // with no specific activity (seed exploration, ad-lib), fall back
        // to the session's own title.
        sessionTitle={
          // On homework the eyebrow below carries the framing instead of the
          // unit name, so the unit's emoji rides the title to keep the session
          // recognisable as the same "🍕 pizza one" from the tonight list.
          homeworkEyebrowText && activityNav.activity
            ? `${activityNav.unit?.emoji ? `${activityNav.unit.emoji} ` : ""}${activityNav.activity.title}`
            : (activityNav.activity?.title ?? activeSession.title)
        }
        unitId={activeSession.unitId}
        unitOptions={unitOptions}
        // The hamburger is retired for scholar projects — the
        // compass / Big-picture button (onOpenReflection) carries
        // the "go home" + "where am I" jobs now. Keep the legacy
        // onMenuClick wiring only for manual-rehearsal (teachers may
        // still want their normal sidebar there) when the
        // reflection drawer isn't appropriate.
        onMenuClick={undefined}
        onOpenReflection={
          isManualRehearsalSession ? undefined : () => setReflectionOpen(true)
        }
        // Compass-button eyebrow — the UNIT breadcrumb above the activity
        // title: emoji + unit name (no "Unit ·" prefix, no lesson label —
        // the lesson category is teacher-facing only). Only shown when
        // there's a distinct activity headline, so the unit never appears
        // twice. The Big Picture drawer carries the rest of the framing.
        // For a seed-spawned exploration there's no unit, so label it as
        // self-started so the scholar doesn't read it as an assigned lesson.
        //
        // HOMEWORK TAKES THE SLOT. At 7pm at the kitchen table the load-
        // bearing facts are that this is homework, when it's due, and who
        // set it — the unit name is the one thing on this line a parent
        // never asks about, and it still names itself in the Big picture
        // drawer and the unit navigator. Same `dueStatus()` phrasing as the
        // tonight list that sent the scholar here.
        compassEyebrow={
          homeworkEyebrowText
            ? homeworkEyebrowText
            : activityNav.activity && activityNav.unit
              ? `${activityNav.unit.emoji ? `${activityNav.unit.emoji} ` : ""}${activityNav.unit.title}`
              : isSeedExploration
                ? "Quest · you started this"
                : null
        }
        isSynced={hasArtifacts ? artifactSynced : undefined}
        isTestMode={isTestMode}
        onSignOut={onSignOut}
        showRightPanel={showRightPanel}
        onToggleRightPanel={useDrawerLayout
          ? undefined  // Hide the desktop toggle only in drawer mode
          : hasRightPanelContent ? () => setRightPanelOpen((v) => !v) : undefined
        }
        mobileAttachmentCount={useDrawerLayout ? rightPanelItemCount : undefined}
        onMobileAttachmentClick={useDrawerLayout && hasRightPanelContent ? () => setMobileDrawerOpen(true) : undefined}
        isMobile={isTouchDevice}
        isRemoteMode={isRemoteMode}
        remoteUserId={remoteUserId}
        onUnitChipClick={
          activityNav.hasActivityContext ? activityNav.open : undefined
        }
        // In test drive (no onOpenReflection wired), fall back to a plain
        // title — Rename / Mark complete don't make sense on a throwaway
        // project. In scholar mode the compass button itself carries the
        // project title; the Rename / Mark complete actions live inside
        // the Big Picture drawer instead of a header menu.
        titleSlot={
          isManualRehearsalSession
            ? undefined
            : (
                <ProjectTitleMenu
                  data={activityNav}
                  sessionTitle={activeSession.title}
                  onRename={
                    isRemoteMode
                      ? undefined
                      : (next) =>
                          updateSession({
                            id: sessionId as Id<"sessions">,
                            title: next,
                          })
                  }
                />
              )
        }
        // Curriculum Bot trigger in the project header — used by remote
        // mode only. Manual rehearsal renders its own bot button in the cyan
        // banner above so the manual-rehearsal surface owns its controls.
        //
        // The `!isManualRehearsalSession` check is defensive: manual rehearsal and
        // remote-mode are mutually exclusive in normal flows (manual rehearsals
        // navigate to /scholar/[id] without `?remote=`), but a hand-crafted
        // URL with both could trip a double-trigger UI. Cheap to guard.
        onOpenBot={
          isRemoteMode &&
          !isManualRehearsalSession &&
          sessionData?.session?.unitId
            ? () => setBotDrawerOpen(true)
            : undefined
        }
      />
      <ProjectActivityNavModal data={activityNav} />
      {isRemoteMode &&
        isTeacherRole(currentUser?.role) &&
        sessionData?.session &&
        isTeacherArchived(sessionData.session) && (
          <TeacherArchivedAppNotice
            sessionId={sessionData.session._id as Id<"sessions">}
          />
        )}

      {/* "Your class is elsewhere" notice — informational only. The hard focus
          gate is gone (shared/focusLock.ts), so this session stays fully
          usable; the banner just says where the room is, with a shortcut home
          for a scholar who wants to join it. */}
      {isFocusMismatch && focusHasRoomClock && (() => {
        const focusUnit = units.find((u) => String(u._id) === focusLock?.unitId);
        const focusName =
          focusLock?.label ??
          (focusUnit
            ? `${focusUnit.emoji ? `${focusUnit.emoji} ` : ""}${focusUnit.title}${focusLock?.lessonTitle ? ` — ${focusLock.lessonTitle}` : ""}`
            : null);
        return (
          <Flex
            px={4}
            py={2}
            bg="violet.50"
            borderBottom="1px solid"
            borderColor="violet.100"
            align="center"
            gap={3}
          >
            <Clock size={14} color="var(--chakra-colors-violet-400)" />
            <Text fontSize="xs" fontFamily="heading" color="violet.600" flex={1}>
              {focusMismatchBannerText(roomPhase, focusName, focusTimeLabel)}
            </Text>
            <RemoteLink href="/scholar" style={{ textDecoration: "none" }}>
              <Box
                as="button"
                px={3}
                py={1}
                bg="white"
                color="violet.700"
                borderWidth="1px"
                borderColor="violet.300"
                borderRadius="lg"
                fontFamily="heading"
                fontWeight="600"
                fontSize="xs"
                _hover={{ bg: "violet.100" }}
                cursor="pointer"
                display="flex"
                alignItems="center"
                gap={1.5}
              >
                <House size={14} />
                Go Home
              </Box>
            </RemoteLink>
          </Flex>
        );
      })()}

      {/* "The turn, not the bell" — the scholar is INSIDE the live class
          focus session itself. No lock, ever — just a soft, ambient sense of
          when the room turns, which softens as it winds down, then a gentle
          choice once it moves on. Nothing here disables the composer or the
          session — the work stays open throughout. */}
      {isFocusMatch && roomPhase === "withClass" && (
        <Flex
          px={4}
          py={2}
          bg="violet.50"
          borderBottom="1px solid"
          borderColor="violet.100"
          align="center"
          gap={3}
        >
          <Clock size={14} color="var(--chakra-colors-violet-400)" />
          <Text fontSize="xs" fontFamily="heading" color="violet.600" flex={1}>
            {liveFocusLine(roomPhase, focusLock ?? {})}
          </Text>
        </Flex>
      )}
      {isFocusMatch && roomPhase === "windingDown" && !showTurnBanner && (
        <Flex
          px={4}
          py={3}
          bg="violet.50"
          borderBottom="1px solid"
          borderColor="violet.200"
          align="center"
          gap={3}
        >
          <Clock size={16} color="var(--chakra-colors-violet-500)" />
          <Text fontSize="sm" fontFamily="heading" color="violet.700" flex={1}>
            {WINDING_DOWN_BANNER_TEXT}
          </Text>
        </Flex>
      )}
      {showTurnBanner && !completionHandoffOwnsNavigation && (
        <Flex
          px={4}
          py={3}
          bg="violet.50"
          borderBottom="1px solid"
          borderColor="violet.200"
          align="center"
          gap={3}
        >
          <Clock size={16} color="var(--chakra-colors-violet-500)" />
          <Text fontSize="sm" fontFamily="heading" color="violet.700" flex={1}>
            {TURNED_BANNER_TEXT}
          </Text>
          <RemoteLink href="/scholar" style={{ textDecoration: "none" }}>
            <Box
              as="button"
              px={3}
              py={1.5}
              bg="white"
              color="violet.700"
              borderWidth="1px"
              borderColor="violet.300"
              borderRadius="lg"
              fontFamily="heading"
              fontWeight="600"
              fontSize="sm"
              _hover={{ bg: "violet.100" }}
              cursor="pointer"
              display="flex"
              alignItems="center"
              gap={1.5}
            >
              <House size={14} />
              Done here → back to home
            </Box>
          </RemoteLink>
        </Flex>
      )}

      {/* Main content area with optional right panel */}
      {(() => {
        const chatProps: ChatColumnProps = {
          messages,
          streamingContent,
          streamingMsgId,
          personaOptions,
          graphemeStages,
          hasGraphemeStages,
          isStreaming: tutorVisiblyStreaming,
          sendBlocked: kickoffBlocksSending,
          questBakeHolding,
          // A kickoff held for a missing key shows the same failed-turn
          // notice; its Try again re-runs the kickoff.
          userTurnFailed: userTurnFailed || kickoffHeldForKey,
          onRetryTurn: kickoffHeldForKey ? retryHeldKickoff : handleRetryTurn,
          // A busy server's honest wait, said in kid words (busyRetryCopy).
          // A deployment with no Anthropic key says so (TRA-536).
          failedTurnNote: stream.needsKey
            ? TUTOR_NEEDS_KEY_MESSAGE
            : stream.busyRetryAfterSec !== undefined
              ? busyRetryCopy(stream.busyRetryAfterSec)
              : null,
          // Same tab, back to this chat after the save: the fresh mount runs
          // the opening turn again with the key set.
          failedTurnAddKeyHref:
            stream.needsKey?.addKeyPath && typeof window !== "undefined"
              ? tutorKeyHref(
                  stream.needsKey.addKeyPath,
                  window.location.pathname + window.location.search,
                )
              : null,
          input,
          setInput,
          handleKeyDown,
          handleSend,
          textareaRef,
          messagesEndRef,
          dictationState,
          dictationError,
          isMicBusy,
          toggleRecording: composerToggleRecording,
          startRecording,
          stopRecording,
          cancelRecording: composerCancelRecording,
          beginner: isReadAlongSession
            ? {
                // A listener gets no alphabet, so no your-turn box.
                alphabet: isBeginnerSession ? decodableAlphabet : null,
                onReadAloud: isBeginnerSession && sttEnabled ? onReadYourTurn : undefined,
                readAloudDisabled: dictationState !== "idle" || isStreaming,
                textSteps,
              }
            : null,
          isRemoteMode,
          remoteScholarName: scholarName ?? null,
          voiceMode,
          onToggleVoiceMode: ttsEnabled
            ? async () => {
                const next = !voiceModeRef.current;
                // Turning voice mode ON when the iPad's volume is muted would
                // be silent with no explanation — nudge the kid to turn it up.
                if (next && (await isLikelyMuted())) {
                  toaster.error({
                    title: "Turn up the iPad volume",
                    description:
                      "Voice mode reads answers aloud, but this iPad's volume is all the way down.",
                  });
                  return;
                }
                setVoiceMode(next);
              }
            : undefined,
          whisperInput,
          setWhisperInput,
          pendingWhisper,
          onSendWhisper: handleSendWhisper,
          onClearWhisper: handleClearWhisper,
          observations: sessionObservations,
          appAiTurns: appAiTurns ?? undefined,
          appCharacterNames,
          isTooLoud,
          hasSpeech,
          generatingImage,
          timeLimit,
          isTimeLimitModalOpen,
          onToggleTimeLimitModal: () => setIsTimeLimitModalOpen((v) => !v),
          pendingImage,
          setPendingImage,
          onClearImage: () => setPendingImage(null),
          sessionActivityId:
            sessionData?.session?.activityId ?? undefined,
          admonishmentIsHomework: isHomeworkSession,
          // Homework only, and only where mark-complete already applies
          // (online activities) — the same state the Big picture drawer
          // toggles, no second completion mechanism.
          homeworkDone: activityNav.isCurrentDone,
          onToggleHomeworkDone:
            isHomeworkSession &&
            !isManualRehearsalSession &&
            activityNav.activity?.kind === "online"
              ? activityNav.toggleComplete
              : undefined,
          isTouchDevice,
          onStopStream: handleStopStream,
          toolActivity,
          ttsEnabled,
          sttEnabled,
          showFlags: isManualRehearsalSessionForFlags,
          getFlag: (id: string) => flagsByMessageId.get(id) ?? null,
          onToggleFlag: handleToggleFlag,
          canFlagWrong,
          onFlagWrong: handleFlagWrong,
          sessionId: sessionId as Id<"sessions">,
          practiceScholarId: practiceScholarId as Id<"users"> | null,
          onInstructionHandback: handleInstructionHandback,
          activityCompletedAt: sessionData?.session?.activityCompletedAt ?? null,
          activityCompletionMessageId:
            sessionData?.session?.activityCompletionMessageId ?? null,
          completedUnitId: sessionData?.session?.unitId ?? null,
          onNewSession: isManualRehearsalSession ? undefined : onNewSession,
          // Process thumbnail data — rendered as a sticky one-liner
          // at the top of the chat scroll. The full pipeline is in a
          // popover.
          process: hasProcess
            ? {
                title: activeProcessDef!.title,
                emoji: activeProcessDef!.emoji ?? null,
                steps: activeProcessDef!.steps,
              }
            : null,
          processCurrentStep: hasProcess ? processState!.currentStep : undefined,
          processSteps: hasProcess ? processState!.steps : undefined,
          nextQuestActivity:
            activityNav.isCurrentDone && activityNav.nextOnlineActivity
              ? {
                  activityId: String(activityNav.nextOnlineActivity._id),
                  title: activityNav.nextOnlineActivity.title,
                }
              : null,
          onContinueToNextActivity:
            activityNav.isCurrentDone && activityNav.nextOnlineActivity
              ? activityNav.continueToNext
              : undefined,
          completionHandsOffToHome,
          completionEarlierHole,
          dispatchCompleted: isRemoteMode
            ? []
            : (sessionData?.dispatchCompleted ?? []),
          // TRA-519 B2: parked ideas come back on the done screen — only for
          // the scholar who owns the session, never in a rehearsal.
          savedForLater:
            !isRemoteMode &&
            !isManualRehearsalSession &&
            !!currentUser &&
            sessionData?.session?.userId === currentUser._id &&
            (sessionData?.session?.parkingLot?.length ?? 0) > 0
              ? {
                  ideas: sessionData.session.parkingLot ?? [],
                  canBuildNow: sessionData.session.freePlayEligible === true,
                }
              : null,
        };

        // Rubric is now per-document — each artifact carries its own
        // Check pill (and verdict) next to its title, so the top-of-
        // panel thumbnail is gone. Multi-draft scholars get
        // independent rubric results, one per artifact.
        const rubricThumbnailElement = null;

        const artifactPanelElement = (
          <ErrorBoundary fallbackMessage="Something went wrong in the document panel">
            <ArtifactPanel
              artifacts={artifacts}
              activeArtifactId={activeArtifactId}
              // Map pin edits go through the owner-only scholarSetMapPins, so
              // a non-owner viewer (teacher remote mode) must not see the
              // pin affordances — they'd throw Forbidden. Read-only unless
              // the viewer IS the session owner.
              mapReadOnly={
                !currentUser ||
                !sessionData?.session?.userId ||
                String(currentUser._id) !== String(sessionData.session.userId)
              }
              onSelectArtifact={setActiveArtifactId}
              onSave={handleSaveArtifact}
              onCreateArtifact={handleCreateArtifact}
              onDeleteArtifact={handleDeleteArtifact}
              onSyncChange={setArtifactSynced}
              onSnapshotCaptureReady={handleAppSnapshotCaptureReady}
              onAskTutor={appTutorUpdates.onAskTutor}
              onAppAiTurn={appTutorUpdates.onAppAiTurn}
              // The real stream state, quiet turns included: Check starts its
              // own turn and handleSubmitArtifact refuses while one streams.
              isStreaming={isStreaming}
              // Commit affordance on the map: the scholar taps a button that
              // sends a normal typed turn so the tutor reacts to their pins.
              // Reuses the existing send+stream path (no new turn mechanic).
              onMapCommit={(text) => {
                sendMessageRef.current(text, "typed");
              }}
              kickoffBlocksSending={kickoffBlocksSending}
              // A teacher watching live never gets the entrance: the award is
              // the scholar's event, and their transcript notice is inert too.
              animateFlairArrivals={!isRemoteMode}
              isAiCheckingRubric={
                isStreaming &&
                toolActivity.some(
                  (t) => t.name === "update_rubric_score" && t.status === "running",
                )
              }
              onSubmitArtifact={async (a, shouldCheck) => {
                await handleSubmitArtifact(
                  a._id as Id<"artifacts">,
                  a.title,
                  shouldCheck,
                );
              }}
              youtubeUrl={activeUnit?.youtubeUrl}
              // Process is no longer rendered inside the artifact
              // panel — it lives as a sticky thumbnail at the top
              // of the chat column instead. Keep null props for
              // back-compat with ArtifactPanel's signature.
              process={null}
              deliverableContext={resolvedDeliverableContext}
              appBuilder={
                onOpenBuilder && builderApp
                  ? {
                      sessionId: sessionId as Id<"sessions">,
                      onOpen: onOpenBuilder,
                    }
                  : undefined
              }
            />
          </ErrorBoundary>
        );

        // Narrow viewports: full-width chat + bottom drawer for the right
        // panel. Wide viewports get the splitter layout, mirroring the
        // native iPad landscape layout.
        //
        // The Drawer.Root stays MOUNTED across the layout flip: unmounting
        // an open Ark drawer never releases its body scroll/pointer lock
        // (verified live — the page goes dead to clicks), so a resize past
        // the breakpoint must close it via `open` on a still-mounted
        // drawer. Its content is gated on drawer mode so the doc editor is
        // never mounted twice (its pending-save flusher is keyed by
        // artifact id).
        return (
          <>
            {useDrawerLayout || !showRightPanel ? (
              <Flex flex={1} overflow="hidden">
                <ChatColumn {...chatProps} />
              </Flex>
            ) : (
              <Splitter.Root
                flex={1}
                overflow="hidden"
                defaultSize={[70, 30]}
                panels={[
                  { id: "chat", minSize: 40 },
                  { id: "side", minSize: 25 },
                ]}
              >
                <Splitter.Panel id="chat">
                  <ChatColumn {...chatProps} />
                </Splitter.Panel>
                <Splitter.ResizeTrigger id="chat:side" css={{ "--splitter-border-size": "0.5px" }} />
                <Splitter.Panel id="side">
                  {/* Whole right panel is a single vertical scroll. Card
                      on top, artifact panel below. `flex="1 0 auto"` on
                      the artifact wrapper means: take natural height
                      when content is short (no clipping), but ALSO grow
                      to fill remaining panel height so we never end up
                      with a transparent gap below the artifact list.
                      When the combined height exceeds the panel, the
                      outer `overflow="auto"` kicks in. */}
                  <Flex h="full" flexDir="column" overflow="auto" bg="gray.50">
                    {rubricThumbnailElement}
                    <Box flex="1 0 auto" display="flex" flexDir="column" minH={0}>
                      {artifactPanelElement}
                    </Box>
                  </Flex>
                </Splitter.Panel>
              </Splitter.Root>
            )}
            {hasRightPanelContent && (
                <Drawer.Root
                  open={useDrawerLayout && mobileDrawerOpen}
                  onOpenChange={(e) => setMobileDrawerOpen(e.open)}
                  placement="bottom"
                  size="xl"
                >
                  <Drawer.Backdrop />
                  <Drawer.Positioner>
                    <Drawer.Content
                      borderTopRadius="2xl"
                      bg="gray.50"
                      maxH="85vh"
                      display="flex"
                      flexDirection="column"
                    >
                      {/* Grab region: handle + header. Swipe down anywhere on
                          it to dismiss (drawer body below stays scrollable). */}
                      <Box {...attachmentsSwipeClose} flexShrink={0}>
                        <Box
                          w="36px"
                          h="4px"
                          borderRadius="full"
                          bg="gray.300"
                          mx="auto"
                          mt={2}
                        />
                        <Flex
                          px={4}
                          pt={2}
                          pb={2}
                          align="center"
                          justify="space-between"
                        >
                          <Text fontSize="sm" fontFamily="heading" fontWeight="600" color="navy.500">
                            Attachments
                          </Text>
                          <Drawer.CloseTrigger asChild>
                            <IconButton
                              aria-label="Close"
                              size="xs"
                              variant="ghost"
                              color="charcoal.400"
                            >
                              <X />
                            </IconButton>
                          </Drawer.CloseTrigger>
                        </Flex>
                      </Box>
                      {useDrawerLayout && (
                        <Box flex={1} minH={0} overflowY="auto" px={4} pb={4}>
                          {rubricThumbnailElement && (
                            <Box mb={3}>{rubricThumbnailElement}</Box>
                          )}
                          {artifactPanelElement}
                        </Box>
                      )}
                    </Drawer.Content>
                  </Drawer.Positioner>
                </Drawer.Root>
              )}
          </>
        );
      })()}

      {/* Curriculum Bot drawer — phase 2.
          Visible in manual-rehearsal mode (banner button opens it) and in remote
          mode (header icon button opens it). Always requires a unitId since
          the bot is unit-scoped. Mounted while the gate is true so chat /
          streaming state isn't reset when the teacher closes the drawer.

          When opened from a manual-rehearsal session, we forward the project id
          so Curriculum Bot can pull the manual-rehearsal transcript + flags as
          context (phase 3) — grounds prompt-refinement suggestions in the
          actual conversation that just happened. */}
      {/* Big-picture reflection drawer — compass button in the
          header opens this. Always mounted while we have a project. */}
      {sessionData?.session && (
        <ReflectionDrawer
          sessionId={sessionData.session._id as Id<"sessions">}
          open={reflectionOpen}
          onClose={() => setReflectionOpen(false)}
          sessionTitle={activeSession.title}
          onRename={
            isRemoteMode || isManualRehearsalSession
              ? undefined
              : (next) =>
                  updateSession({
                    id: sessionId as Id<"sessions">,
                    title: next,
                  })
          }
          onToggleComplete={
            isManualRehearsalSession ? undefined : activityNav.toggleComplete
          }
          isCurrentDone={activityNav.isCurrentDone}
          canMarkComplete={
            !!activityNav.activity && activityNav.activity.kind === "online"
          }
        />
      )}

      {(sessionData?.session?.isTestDrive || isRemoteMode) &&
        sessionData?.session?.unitId && (
          <CurriculumBotDrawer
            open={botDrawerOpen}
            onClose={() => setBotDrawerOpen(false)}
            unitId={sessionData.session.unitId}
            selectedLessonId={sessionData.session.lessonId ?? null}
            selectedActivityId={sessionData.session.activityId ?? null}
            testDriveProjectId={
              sessionData.session.isTestDrive
                ? (sessionId as Id<"sessions">)
                : null
            }
            pendingFlags={pendingFlags}
            onAttachNoteToFlags={handleAttachNoteToFlags}
            onDismissPendingFlag={dismissPendingFlag}
          />
        )}
    </Flex>
  );
}

// Chat column extracted to avoid duplication between splitter/non-splitter layouts
interface ChatColumnProps {
  /**
   * The session is waiting on its background quest bake, so the empty chat can
   * say so. Distinct from `sendBlocked`, which is also true during an ordinary
   * activity kickoff — that wait is seconds and is not a quest being built.
   */
  questBakeHolding?: boolean;
  messages: MessageData[];
  streamingContent: string;
  streamingMsgId: string | null;
  personaOptions: DimensionOption[];
  graphemeStages: GraphemeStages;
  hasGraphemeStages: boolean;
  isStreaming: boolean;
  sendBlocked?: boolean;
  /** A FAILED scholar (user) turn in this tab (busy budget spent / hard error). */
  userTurnFailed?: boolean;
  /** Re-run the trailing failed user turn (no new user message). */
  onRetryTurn?: () => void;
  /** Why the last turn failed, when worth saying (a busy server's wait). */
  failedTurnNote?: string | null;
  /** Where to add the tutor's Anthropic key, when the turn failed for want of
   *  one and this deployment (the local runner) takes it from the app. */
  failedTurnAddKeyHref?: string | null;
  /** A listener's or beginner's own session (TRA-504): cleaned replies and
   *  larger text; a beginner's also gets the your-turn box and its mic. Null
   *  for everyone else. */
  beginner?: BeginnerBubbleProps | null;
  input: string;
  setInput: (v: string) => void;
  handleKeyDown: (e: React.KeyboardEvent) => void;
  handleSend: (text?: string) => void;
  textareaRef: React.Ref<HTMLTextAreaElement>;
  messagesEndRef: React.Ref<HTMLDivElement>;
  dictationState: DictationState;
  dictationError: string | null;
  /** True only when a DIFFERENT recorder (writing box, practice handoff) holds
   *  the mic — mirrors DictationMicButton/PracticeSession's use of the same
   *  micOwner registry. Never true while this composer is itself recording. */
  isMicBusy?: boolean;
  toggleRecording: () => void;
  startRecording: () => void;
  stopRecording: () => void;
  cancelRecording: () => void;
  isRemoteMode?: boolean;
  remoteScholarName?: string | null;
  whisperInput?: string;
  setWhisperInput?: (v: string) => void;
  pendingWhisper?: string | null;
  onSendWhisper?: () => void;
  onClearWhisper?: () => void;
  observations?: ObservationData[];
  /** Staff only: the app's in-app AI turns, interleaved by time. */
  appAiTurns?: AppAiTurnView[];
  appCharacterNames?: AppCharacterNames;
  isTooLoud?: boolean;
  hasSpeech?: boolean;
  generatingImage?: boolean;
  timeLimit?: {
    isActive: boolean;
    secondsRemaining: number;
    totalSeconds: number;
    isExpired: boolean;
    display: string;
    setLimit: (minutes: number, password: string) => Promise<void>;
    clearLimit: (password: string) => Promise<void>;
  };
  isTimeLimitModalOpen?: boolean;
  onToggleTimeLimitModal?: () => void;
  pendingImage?: { file: File; preview: string } | null;
  setPendingImage?: (img: { file: File; preview: string } | null) => void;
  onClearImage?: () => void;
  /** Activity id this project is rooted in — used to render the
   *  ScholarAngleBanner when the activity has hasScholarAngles. */
  sessionActivityId?: Id<"activities">;
  /** When true, this session is a homework push — surfaces the
   *  homework-only "your teacher can read this" admonishment line. */
  admonishmentIsHomework?: boolean;
  /** Homework only: the same `activityCompletions` state the Big picture
   *  drawer toggles, surfaced where the scholar can actually see it. Undefined
   *  (or a non-online activity) hides the control entirely. */
  homeworkDone?: boolean;
  onToggleHomeworkDone?: () => void | Promise<void>;
  isTouchDevice?: boolean;
  onStopStream?: () => void;
  toolActivity?: import("@/hooks/useAgentStream").ToolActivity[];
  ttsEnabled?: boolean;
  sttEnabled?: boolean;
  /** Voice-first mode: spoken replies + hands-free listening loop. */
  voiceMode?: boolean;
  onToggleVoiceMode?: () => void;
  /** Manual-rehearsal flag UI — when true, tutor messages render 👍 / 👎 buttons.
   *  Only set in manual-rehearsal mode. */
  showFlags?: boolean;
  getFlag?: (messageId: string) => "good" | "bad" | null;
  onToggleFlag?: (messageId: string, kind: "good" | "bad") => void;
  canFlagWrong?: boolean;
  onFlagWrong?: (messageId: string, currentlyFlagged: boolean) => void;
  /** Current session id — used by the session-end recap query. */
  sessionId: Id<"sessions">;
  /** The scholar who owns this session — the identity an inline chat
   *  practice item (⑮) is graded/recorded against. */
  practiceScholarId?: Id<"users"> | null;
  onInstructionHandback: (
    handback: InstructionHandbackStart,
  ) => Promise<void>;
  /** When set, the session is marked done. */
  activityCompletedAt?: number | null;
  /** Post-tool tutor message after which the completion milestone belongs. */
  activityCompletionMessageId?: Id<"messages"> | null;
  /** The unit this session belongs to (if any) — drives the badge
   *  celebration shown when the completion earned a unit badge. */
  completedUnitId?: Id<"units"> | null;
  /** Click handler for the celebration CTA → opens the new-project
   *  picker. Provided by the parent. */
  onNewSession?: () => void;
  /** When this project's activity is "done" inside a quest (kickoff
   *  + angle set, or rubric-passed), the chat surfaces a sticky CTA
   *  banner that creates a project on the next activity and
   *  navigates. Null/undefined hides the banner. */
  nextQuestActivity?: { activityId: string; title: string } | null;
  onContinueToNextActivity?: () => void;
  /** Current activity is done and there is NO forward next activity in this
   *  session's list, so the card hands off to Home. Says nothing about whether
   *  the unit is finished — the list is assignment-scoped. */
  completionHandsOffToHome?: boolean;
  /** Handing off to Home AND activities visible in this session are still
   *  incomplete behind us. The in-session Continue CTA is forward-only (see
   *  shared/nextIncompleteActivity.ts), so Home owns routing back to them. */
  completionEarlierHole?: boolean;
  dispatchCompleted?: DispatchCompletionReceiptData[];
  /** Parked ideas to bring back on the done screen (null = don't show). */
  savedForLater?: SavedForLater | null;
  /** Process pipeline for the sticky thumbnail at top of chat. */
  process?: {
    title: string;
    emoji: string | null;
    steps: Array<{
      key: string;
      title: string;
      description?: string;
    }>;
  } | null;
  processCurrentStep?: string;
  processSteps?: Array<{
    key: string;
    status: "not_started" | "in_progress" | "completed";
    commentary?: string;
  }>;
}

function CompletionMilestone({
  sessionId,
  completedUnitId,
  completionHandsOffToHome,
  completionEarlierHole,
  nextQuestActivity,
  onContinueToNextActivity,
  onNewSession,
  dispatchCompleted,
  savedForLater,
}: {
  sessionId: Id<"sessions">;
  completedUnitId: Id<"units"> | null;
  completionHandsOffToHome: boolean;
  completionEarlierHole: boolean;
  nextQuestActivity?: { activityId: string; title: string } | null;
  onContinueToNextActivity?: () => void;
  onNewSession?: () => void;
  dispatchCompleted: readonly DispatchCompletionReceiptData[];
  savedForLater: SavedForLater | null;
}) {
  return (
    <>
      {/* Keyed by session: a fresh session must start undismissed. A `key`
           rather than a reset effect — `dismissed` is this card's ONLY state,
           so remounting discards exactly what the effect used to clear. */}
      <SessionRecapCard key={sessionId} sessionId={sessionId} isComplete />
      {completedUnitId && <BadgeCelebration unitId={completedUnitId} />}
      {/* B6 badge moment: a finished Quest with no build step offers one.
          Renders nothing unless units.get says canUnlockBuild. */}
      {completedUnitId && <QuestBuildUnlockOffer unitId={completedUnitId} />}
      <Box
        as="section"
        aria-label="Activity complete"
        alignSelf="center"
        maxW="md"
        w="full"
        my={4}
        p={6}
        bg="green.50"
        borderWidth="1px"
        borderColor="green.300"
        borderRadius="2xl"
        textAlign="center"
        shadow="sm"
      >
        <Box color="green.600" mb={3} display="flex" justifyContent="center">
          <CheckSquare size={48} strokeWidth={2.5} />
        </Box>
        <Text
          fontFamily="heading"
          fontWeight="700"
          fontSize="lg"
          color="green.700"
          mb={1}
        >
          {"Nice work — this one's done!"}
        </Text>
        <Text
          fontSize="sm"
          color="charcoal.500"
          fontFamily="body"
          mb={dispatchCompleted.length > 0 ? 0 : 4}
        >
          {nextQuestActivity
            ? "Ready when you are — your next activity is up next."
            : completionEarlierHole
              ? "This part is done — head home to see what is left."
              : completionHandsOffToHome
                ? "Head back when you're ready."
                : "Your session is marked complete. Keep the momentum going — pick what's next."}
        </Text>
        {dispatchCompleted.length > 0 && (
          <Box mb={4}>
            <DispatchCompletionReceipt
              receipts={dispatchCompleted}
              kind="work"
            />
          </Box>
        )}
        {nextQuestActivity && onContinueToNextActivity ? (
          <Button
            bg="green.500"
            color="white"
            _hover={{ bg: "green.600" }}
            onClick={onContinueToNextActivity}
            fontFamily="heading"
            fontWeight="600"
            size="md"
            gap={1.5}
          >
            <Text as="span" fontWeight="500" opacity={0.85}>
              Up next →
            </Text>
            <Text as="span">{nextQuestActivity.title}</Text>
            <ArrowRight size={14} />
          </Button>
        ) : completionHandsOffToHome ? (
          <RemoteLink href="/scholar" style={{ textDecoration: "none" }}>
            <Button
              bg="green.500"
              color="white"
              _hover={{ bg: "green.600" }}
              fontFamily="heading"
              fontWeight="600"
              size="md"
            >
              Back to home
            </Button>
          </RemoteLink>
        ) : (
          onNewSession && (
            <Button
              bg="green.500"
              color="white"
              _hover={{ bg: "green.600" }}
              onClick={onNewSession}
              fontFamily="heading"
              fontWeight="600"
              size="md"
            >
              Start a new session →
            </Button>
          )
        )}
      </Box>
      {savedForLater ? (
        <SavedForLaterBlock
          sessionId={sessionId}
          ideas={savedForLater.ideas}
          canBuildNow={savedForLater.canBuildNow}
        />
      ) : null}
    </>
  );
}

type SavedForLater = {
  ideas: readonly ParkedIdea[];
  canBuildNow: boolean;
};

function ChatColumn({
  messages,
  streamingContent,
  streamingMsgId,
  personaOptions,
  graphemeStages,
  hasGraphemeStages,
  isStreaming,
  sendBlocked = false,
  questBakeHolding = false,
  userTurnFailed = false,
  onRetryTurn,
  failedTurnNote = null,
  failedTurnAddKeyHref = null,
  beginner = null,
  input,
  setInput,
  handleKeyDown,
  handleSend,
  textareaRef,
  messagesEndRef,
  dictationState,
  dictationError,
  isMicBusy = false,
  toggleRecording,
  startRecording,
  stopRecording,
  cancelRecording,
  isRemoteMode,
  remoteScholarName,
  whisperInput,
  setWhisperInput,
  pendingWhisper,
  onSendWhisper,
  onClearWhisper,
  observations = [],
  appAiTurns = NO_APP_AI_TURNS,
  appCharacterNames = NO_APP_CHARACTER_NAMES,
  isTooLoud = false,
  hasSpeech = false,
  generatingImage = false,
  timeLimit,
  isTimeLimitModalOpen = false,
  onToggleTimeLimitModal,
  pendingImage,
  setPendingImage,
  onClearImage,
  sessionActivityId,
  admonishmentIsHomework = false,
  homeworkDone = false,
  onToggleHomeworkDone,
  isTouchDevice = false,
  onStopStream,
  toolActivity = [],
  ttsEnabled = true,
  sttEnabled = true,
  voiceMode = false,
  onToggleVoiceMode,
  showFlags = false,
  getFlag,
  onToggleFlag,
  canFlagWrong = false,
  onFlagWrong,
  sessionId,
  practiceScholarId = null,
  onInstructionHandback,
  activityCompletedAt = null,
  activityCompletionMessageId = null,
  completedUnitId = null,
  onNewSession,
  process: chatProcess,
  processCurrentStep: chatProcessCurrentStep,
  processSteps: chatProcessSteps,
  nextQuestActivity,
  onContinueToNextActivity,
  completionHandsOffToHome = false,
  completionEarlierHole = false,
  dispatchCompleted = [],
  savedForLater = null,
}: ChatColumnProps) {
  const micBtnRef = useRef<HTMLButtonElement>(null);
  const tabHeldRef = useRef(false);
  const tabTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // "I'm done with this" (homework). The mutation can legitimately reject
  // (offline, a lesson-less activity), and this button is CHILD-facing — an
  // unhandled rejection is exactly the raw-error-to-a-nine-year-old failure
  // this change exists to remove. Swallow to the console and leave the button
  // in its previous state; the Big picture drawer remains the fallback.
  const [homeworkDoneSaving, setHomeworkDoneSaving] = useState(false);
  const handleToggleHomeworkDone = async () => {
    if (!onToggleHomeworkDone || homeworkDoneSaving) return;
    setHomeworkDoneSaving(true);
    try {
      await onToggleHomeworkDone();
    } catch (error) {
      console.warn("[session] homework completion change failed", error);
    } finally {
      setHomeworkDoneSaving(false);
    }
  };
  // Engine state for the voice-mode toggle's "speaking" pulse.
  const { state: ttsState } = useTTSQueue();

  const reconciledMessages = useReconciledSessionMessages({
    messages,
    streamingMsgId,
    streamingContent,
    keepActiveMessageWhenEmpty: generatingImage,
  });
  const reconciledMessagesById = new Map(
    reconciledMessages.map((message) => [message.message.id, message]),
  );

  // Turn state. Two sources, by design (see streamRetry.ts + finding 7):
  //   • THIS tab's local `isStreaming` / `userTurnFailed` is authoritative for
  //     the tab that owns the fetch — while its connection is open it shows
  //     pending even if the server heartbeat briefly lapses (a genuinely hung
  //     open connection resolves via the fetch's own error → userTurnFailed).
  //   • The server-derived state governs OTHER tabs and after a reload, where
  //     there is no local fetch: a live placeholder → pending, a dead scholar
  //     placeholder → the retry affordance (silent turns excluded).
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const [nowTick, setNowTick] = useState(() => Date.now());
  const serverTurnState = deriveServerTurnState(
    lastMessage
      ? {
          role: lastMessage.role,
          content: lastMessage.content ?? "",
          streamId: lastMessage.streamId ?? null,
          createdAt: lastMessage.createdAt,
          lastStreamActivityAt: lastMessage.lastStreamActivityAt ?? null,
          // A quiet app-update placeholder reads "idle" (no dots, no retry).
          streamTrigger: lastMessage.streamTrigger ?? null,
        }
      : null,
    nowTick,
  );
  // This tab's own USER-turn retry loop gave up (busy budget spent or a hard
  // error). The placeholder may already be deleted/finalized server-side, so we
  // anchor to client state, not to a specific assistant row.
  const clientFailedHere = userTurnFailed && !isStreaming;
  // Server-derived dead SCHOLAR turn (governs a reload / another tab, where this
  // tab has no local fetch): the trailing placeholder is dead, is NOT a silent
  // turn (no streamTrigger — a kickoff placeholder is streamTrigger:
  // "activityKickoff"), and the message before it (skipping tool rows) is a
  // scholar `user` message (a rubric-check placeholder is preceded by an
  // assistant message, so it is excluded). A dead silent turn gets NO
  // affordance — kickoff self-recovers, and "Check my work" is the rubric retry.
  const deadScholarTurn =
    serverTurnState === "dead" &&
    !!lastMessage &&
    lastMessage.role === "assistant" &&
    !lastMessage.streamTrigger &&
    (() => {
      for (let i = messages.length - 2; i >= 0; i--) {
        if (messages[i].role === "tool") continue;
        return messages[i].role === "user";
      }
      return false;
    })();
  const isTurnPending =
    !clientFailedHere && (isStreaming || serverTurnState === "pending");
  const isTurnDead = !isStreaming && (clientFailedHere || deadScholarTurn);
  const pendingSince =
    isTurnPending && lastMessage ? lastMessage.createdAt : null;
  // Tick once a second only while a turn is pending, to advance the escalating
  // "thinking" copy and to cross the dead threshold on a stuck turn.
  useEffect(() => {
    if (!isTurnPending && serverTurnState !== "pending") return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isTurnPending, serverTurnState]);

  // Hold-the-mic push-to-talk (touch-first twin of Tab-to-talk): press and
  // hold ≥250ms records while held; release stops & sends. A quick tap keeps
  // the tap-to-latch toggle. The release listener lives on window because the
  // mic button unmounts when the composer swaps to its recording UI.
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressMicClickRef = useRef(false);
  // stopRecording's identity changes with dictation state; the window
  // listener needs whatever is current at release time.
  const stopRecordingRef = useRef(stopRecording);
  // eslint-disable-next-line react-hooks/refs -- keep latest callback for the window-level release listener
  stopRecordingRef.current = stopRecording;
  const handleMicPointerDown = () => {
    if (dictationState !== "idle") return;
    // Interrupt on contact rather than waiting for click/pointerup.
    getTTSEngine()?.stop();
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      suppressMicClickRef.current = true;
      void startRecording();
      const release = () => {
        window.removeEventListener("pointerup", release);
        window.removeEventListener("pointercancel", release);
        stopRecordingRef.current();
      };
      window.addEventListener("pointerup", release);
      window.addEventListener("pointercancel", release);
    }, 250);
  };
  const handleMicPointerUp = () => {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };
  // After a keyboard-initiated send, the textarea is disabled while the
  // tutor streams (losing focus); give focus back when streaming ends so
  // the scholar can just keep typing. Keyboard-only on purpose — refocusing
  // after a touch send would pop the on-screen keyboard uninvited.
  const sentViaKeyboardRef = useRef(false);
  const prevStreamingRef = useRef(isStreaming);
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming && sentViaKeyboardRef.current) {
      sentViaKeyboardRef.current = false;
      // textareaRef is a Ref<> prop — narrow past the callback-ref form.
      if (textareaRef && typeof textareaRef === "object") {
        textareaRef.current?.focus({ preventScroll: true });
      }
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming, textareaRef]);

  // Remote-mode whisper toggle. When on, the floating input card tints
  // orange and the same textarea / send button drive a whisper rather
  // than a chat message — so the teacher never sees two input fields
  // at once.
  const [whisperToggled, setWhisperMode] = useState(false);
  // Whisper only applies in remote mode, so derive the effective value
  // rather than resetting state via an effect: leaving remote mode
  // silently disables it without a cascading render.
  const whisperMode = whisperToggled && isRemoteMode;

  // Refocus the chat input every time a stream completes. The
  // textarea is `disabled` while isStreaming === true; the browser
  // blurs disabled elements, so the scholar's caret would otherwise
  // vanish each turn and they'd have to click the input again to
  // keep typing. Tracking the prior value lets us focus exactly on
  // the true → false transition (not when the page first loads).
  const wasStreamingRef = useRef(isStreaming);
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) {
      if (
        typeof textareaRef === "object" &&
        textareaRef !== null &&
        "current" in textareaRef &&
        textareaRef.current
      ) {
        textareaRef.current.focus({ preventScroll: true });
      }
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming, textareaRef]);

  // Recording timer (count-up)
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  useEffect(() => {
    if (dictationState !== "recording") {
      // Reset the timer when recording stops/idles.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRecordingSeconds(0);
      return;
    }
    const interval = setInterval(() => {
      setRecordingSeconds((s) => s + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [dictationState]);
  const timerDisplay = `${Math.floor(recordingSeconds / 60)}:${String(recordingSeconds % 60).padStart(2, "0")}`;

  // Walkie-talkie: Tab hold → record, Tab release → stop & send
  // Quick tap (<200ms) is a no-op so normal Tab usage isn't hijacked
  // Disabled when teacher has turned off STT for this scholar
  // NOT gated on isTouchDevice: the school's standard scholar hardware is an
  // iPad WITH a Magic Keyboard Folio — touch and hardware keys at once. A
  // device with no physical keyboard simply never emits Tab (the on-screen
  // keyboard has none), so the listener is inert there; touch-only users
  // have the mic button.
  useEffect(() => {
    if (!sttEnabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      // Don't hijack Tab when user is in an input/textarea that isn't ours
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (target?.isContentEditable) return;
      e.preventDefault();
      if (e.repeat) return;
      if (!tabHeldRef.current && !isStreaming && dictationState === "idle") {
        tabHeldRef.current = true;
        tabTimerRef.current = setTimeout(() => {
          tabTimerRef.current = null;
          if (tabHeldRef.current) startRecording();
        }, 200);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      e.preventDefault();
      if (tabHeldRef.current) {
        tabHeldRef.current = false;
        // Released before 200ms threshold — cancel, don't record
        if (tabTimerRef.current) {
          clearTimeout(tabTimerRef.current);
          tabTimerRef.current = null;
        } else {
          stopRecording();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      if (tabTimerRef.current) clearTimeout(tabTimerRef.current);
    };
  }, [isStreaming, dictationState, startRecording, stopRecording, sttEnabled]);

  // Ripple center from the send-recording button (visible during recording)
  const sendRecBtnRef = useRef<HTMLButtonElement>(null);
  const [rippleCenter, setRippleCenter] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (dictationState === "recording" && sendRecBtnRef.current) {
      const rect = sendRecBtnRef.current.getBoundingClientRect();
      setRippleCenter({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    } else {
      setRippleCenter(null);
    }
  }, [dictationState]);

  const timelineItems = useMemo(() => {
    const filteredMsgs = messages
      .filter((m) => m.role !== "system")
      .filter((m) => !(m.role === "user" && m.content === "<start>"))
      .filter((m) => isRemoteMode || m.toolAction !== "whisper");

    type TimelineItem =
      | { kind: "message"; data: MessageData; time: number }
      | { kind: "observation"; data: ObservationData; time: number }
      | { kind: "appAi"; data: AppAiTurnView; time: number }
      | { kind: "completion"; time: number };

    const timeline: TimelineItem[] = filteredMsgs.map((m) => ({
      kind: "message" as const,
      data: m,
      time: m.createdAt,
    }));

    if (isRemoteMode && observations.length > 0) {
      for (const obs of observations) {
        timeline.push({
          kind: "observation" as const,
          data: obs,
          time: obs.observedAt,
        });
      }
    }

    // Same staff-only interleave as observations: the record of what the
    // app's character and judges said, beside the chat it happened in.
    if (isRemoteMode) {
      for (const turn of appAiTurns) {
        timeline.push({ kind: "appAi" as const, data: turn, time: turn.createdAt });
      }
    }

    timeline.sort((a, b) => a.time - b.time);
    if (activityCompletedAt) {
      const anchoredMessageIndex = activityCompletionMessageId
        ? timeline.findIndex(
            (item) =>
              item.kind === "message" &&
              item.data.id === String(activityCompletionMessageId),
          )
        : -1;
      const firstPostCompletionMessageIndex = timeline.findIndex(
        (item) =>
          item.kind === "message" &&
          item.data.createdAt >= activityCompletedAt,
      );
      const fallbackIndex =
        firstPostCompletionMessageIndex < 0
          ? timeline.length
          : timeline[firstPostCompletionMessageIndex].kind === "message" &&
              timeline[firstPostCompletionMessageIndex].data.role === "assistant"
            ? firstPostCompletionMessageIndex + 1
            : firstPostCompletionMessageIndex;
      timeline.splice(
        anchoredMessageIndex >= 0 ? anchoredMessageIndex + 1 : fallbackIndex,
        0,
        { kind: "completion", time: activityCompletedAt },
      );
    }
    return timeline;
  }, [
    activityCompletedAt,
    activityCompletionMessageId,
    appAiTurns,
    isRemoteMode,
    messages,
    observations,
  ]);
  const [visibleTimelineCount, setVisibleTimelineCount] = useState(CHAT_INITIAL_WINDOW);
  const timelineResetKey =
    messages[0]?.id ?? observations[0]?._id ?? "empty";
  // Reset the chat window when the timeline identity changes (e.g. switching
  // sessions). React's recommended "adjust state during render" pattern — resets
  // synchronously before paint, no effect / cascading render.
  const prevTimelineResetKey = useRef(timelineResetKey);
  if (prevTimelineResetKey.current !== timelineResetKey) {
    prevTimelineResetKey.current = timelineResetKey;
    setVisibleTimelineCount(CHAT_INITIAL_WINDOW);
  }
  const hiddenTimelineCount = Math.max(0, timelineItems.length - visibleTimelineCount);
  // Seed from the whole message snapshot rather than what happens to be mounted,
  // so delayed subscription catch-up can animate but history and window expansion
  // cannot replay a notice. Switching sessions re-baselines with the timeline.
  const arrivingFlairRowIds = useFlairArrivals(
    messages.length > 0
      ? messages
          .filter((message) => message.flairAwards?.length)
          .map((message) => message.id)
      : undefined,
    timelineResetKey,
  );
  const claimedFlairRows = useMemo(
    () => ({ resetKey: timelineResetKey, ids: new Set<string>() }),
    [timelineResetKey],
  );
  const visibleTimelineItems = useMemo(
    () => timelineItems.slice(hiddenTimelineCount),
    [timelineItems, hiddenTimelineCount],
  );
  const observerMessageCount = messages.filter(
    (message) =>
      message.role !== "system" &&
      (message.role !== "tool" || !!message.imageId) &&
      (message.content.trim() !== "" ||
        (!!message.imageId &&
          (message.role === "user" || message.role === "tool"))),
  ).length;

  return (
    <Flex flex={1} flexDir="column" overflow="hidden" h="full" position="relative">
      {/* Recording ripples — concentric circles emanating from the dot */}
      {dictationState === "recording" && rippleCenter && (
        <>
          <style>{`
            @keyframes rippleGrow {
              0% { transform: translate(-50%, -50%) scale(0); opacity: 0.5; }
              100% { transform: translate(-50%, -50%) scale(1); opacity: 0; }
            }
          `}</style>
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                position: "fixed",
                left: rippleCenter.x,
                top: rippleCenter.y,
                width: "250vmax",
                height: "250vmax",
                borderRadius: "50%",
                border: "4px solid rgba(229, 62, 62, 0.9)",
                pointerEvents: "none",
                zIndex: 9998,
                willChange: "transform, opacity",
                animation: `rippleGrow 15s linear infinite ${-i * 5}s`,
              }}
            />
          ))}
        </>
      )}

      {/* The padding creates enough scroll range for the floating composer;
          matching scroll padding makes scrollIntoView stop above it instead
          of aligning the end marker underneath it. */}
      <Box
        data-scroll-region
        flex={1}
        overflowY="auto"
        overflowX="hidden"
        px={6}
        pt={4}
        pb="140px"
        scrollPaddingBottom="140px"
        position="relative"
      >
        {/* Teach-backs (scholar-as-teacher vivas) — TEACHER-ONLY, so only in
            remote (teacher-viewing-as-scholar) mode. The query is skipped and
            the card renders nothing for a scholar in their own session. */}
        {isRemoteMode && (
          <Box mb={3}>
            <TeachBacksCard sessionId={sessionId} enabled={isRemoteMode} />
          </Box>
        )}
        {/* Per-scholar angle banner — visible only when the activity
            has hasScholarAngles + the scholar has set one. */}
        {sessionActivityId && (
          <Box mb={3}>
            <ScholarAngleBanner activityId={sessionActivityId} />
          </Box>
        )}
        {/* Process thumbnail — frosty pill that floats at the top of
            the chat pane. Sticky-positioned inside the scroll so it
            stays visible as the scholar scrolls; the pill itself
            carries a translucent + backdrop-blur background so chat
            content blurs through it rather than being covered by an
            opaque wash. */}
        {chatProcess && chatProcessCurrentStep && chatProcessSteps && (
          <Box
            position="sticky"
            top={0}
            zIndex={5}
            w="full"
            display="flex"
            justifyContent="center"
            mb={3}
            pointerEvents="none"
          >
            <Box pointerEvents="auto">
              <ProcessThumbnail
                process={chatProcess}
                currentStep={chatProcessCurrentStep}
                steps={chatProcessSteps}
              />
            </Box>
          </Box>
        )}

        {/* Continue-to-next CTA — appears when the current quest
            activity is "done" (kickoff angle set, or rubric-passed)
            AND a next activity exists. Click creates the next
            project and navigates. Same sticky-top slot as the
            Process pill but below it when both are present. */}
        {!activityCompletedAt && nextQuestActivity && onContinueToNextActivity && (
          <Box
            position="sticky"
            top={chatProcess ? 12 : 0}
            zIndex={4}
            w="full"
            display="flex"
            justifyContent="center"
            mb={3}
            pointerEvents="none"
          >
            <Button
              pointerEvents="auto"
              size="sm"
              bg="violet.500"
              color="white"
              _hover={{ bg: "violet.600" }}
              shadow="0 4px 16px rgba(0,0,0,0.10), 0 1px 2px rgba(0,0,0,0.06)"
              borderRadius="full"
              px={4}
              gap={1.5}
              fontFamily="heading"
              fontWeight="600"
              fontSize="sm"
              onClick={onContinueToNextActivity}
            >
              <Text as="span" fontWeight="500" opacity={0.85}>
                Up next →
              </Text>
              <Text as="span">{nextQuestActivity.title}</Text>
              <ArrowRight size={14} />
            </Button>
          </Box>
        )}

        <VStack gap={4} maxW="3xl" mx="auto" align="stretch">
          {messages.length === 0 && !streamingContent && !isTurnDead && (
            <Flex py={12} justify="center" direction="column" align="center" gap={3}>
              <Spinner size="lg" color="violet.500" />
              {/* The bake runs into the minutes. A bare spinner for that long
                  reads as broken, and the scholar has no way to know anything is
                  being made for them — say what is happening. */}
              {questBakeHolding && (
                <VStack gap={0.5}>
                  <Text fontFamily="heading" color="charcoal.600">
                    Building your quest…
                  </Text>
                  <Text fontSize="sm" color="charcoal.400">
                    This takes a minute. Your first task will be here when it&rsquo;s ready.
                  </Text>
                </VStack>
              )}
            </Flex>
          )}

          {hiddenTimelineCount > 0 && (
            <Flex justify="center" py={1}>
              <Button
                size="xs"
                variant="ghost"
                color="charcoal.400"
                fontFamily="heading"
                onClick={() =>
                  setVisibleTimelineCount((count) => count + CHAT_WINDOW_INCREMENT)
                }
              >
                Show {Math.min(CHAT_WINDOW_INCREMENT, hiddenTimelineCount)} earlier messages
              </Button>
            </Flex>
          )}

          {visibleTimelineItems.map((item) => {
              if (item.kind === "completion") {
                return (
                  <CompletionMilestone
                    key="activity-completion"
                    sessionId={sessionId}
                    completedUnitId={completedUnitId}
                    completionHandsOffToHome={completionHandsOffToHome}
                    completionEarlierHole={completionEarlierHole}
                    nextQuestActivity={nextQuestActivity}
                    onContinueToNextActivity={onContinueToNextActivity}
                    onNewSession={onNewSession}
                    dispatchCompleted={dispatchCompleted}
                    savedForLater={savedForLater}
                  />
                );
              }

              if (item.kind === "appAi") {
                return (
                  <AppAiTurnRow
                    key={`app-ai-${item.data._id}`}
                    turn={item.data}
                    characterNames={appCharacterNames}
                  />
                );
              }

              if (item.kind === "observation") {
                const obs = item.data;
                const bloomLabel = obs.masteryLevel >= 4.5 ? "Create"
                  : obs.masteryLevel >= 3.5 ? "Evaluate"
                  : obs.masteryLevel >= 2.5 ? "Analyze"
                  : obs.masteryLevel >= 1.5 ? "Apply"
                  : obs.masteryLevel >= 0.5 ? "Understand"
                  : "Remember";
                return (
                  <Flex
                    key={`obs-${obs._id}`}
                    justify="center"
                    py={1}
                    gap={1.5}
                    align="center"
                    opacity={obs.isSuperseded ? 0.4 : 1}
                  >
                    <Text fontSize="xs" color="teal.500" fontFamily="heading" fontWeight="600">
                      {obs.studentInitiated ? "★" : "◆"} {obs.conceptLabel}
                    </Text>
                    <Text fontSize="xs" color="teal.600" fontFamily="body">
                      {obs.domain} · {bloomLabel} ({obs.masteryLevel.toFixed(1)}) · conf {(obs.confidenceScore * 100).toFixed(0)}%
                    </Text>
                    <Text fontSize="xs" color="teal.400" fontFamily="body" fontStyle="italic" truncate maxW="300px">
                      {obs.evidenceSummary}
                    </Text>
                  </Flex>
                );
              }

              const message = item.data;
              if (message.role === "tool") {
                if (message.resourceShare) {
                  return (
                    <ResourceShareCard
                      key={message.id}
                      resource={message.resourceShare}
                    />
                  );
                }
                if (message.toolAction === "resource_share") return null;
                if (message.flairAwards?.length) {
                  const animateFlairNotice =
                    !isRemoteMode &&
                    arrivingFlairRowIds.includes(message.id) &&
                    !claimedFlairRows.ids.has(message.id);
                  return (
                    <FlairAwardNotice
                      key={message.id}
                      awards={message.flairAwards}
                      sessionId={sessionId as Id<"sessions">}
                      // The arrival baseline suppresses history and remounts;
                      // remote teacher views stay deliberately inert.
                      animate={animateFlairNotice}
                      onAnimationClaim={
                        animateFlairNotice
                          ? () => claimedFlairRows.ids.add(message.id)
                          : undefined
                      }
                    />
                  );
                }
                if (message.chatPractice) {
                  // Problems-in-chat (⑮): the tutor served an inline item.
                  // The scholar answers in place; a teacher reading remotely
                  // sees it read-only. Grading is scoped to the session owner.
                  return (
                    <ChatPracticeItem
                      key={message.id}
                      scholarId={practiceScholarId as Id<"users">}
                      sessionId={sessionId as Id<"sessions">}
                      item={message.chatPractice}
                      interactive={!isRemoteMode && !!practiceScholarId}
                    />
                  );
                }
                if (message.instruction && practiceScholarId) {
                  return (
                    <InstructionChatCard
                      key={message.id}
                      messageId={message.id as Id<"messages">}
                      sessionId={sessionId as Id<"sessions">}
                      scholarId={practiceScholarId as Id<"users">}
                      instruction={message.instruction}
                      onHandback={onInstructionHandback}
                      interactive={!isRemoteMode}
                    />
                  );
                }
                if (message.toolAction === "whisper") {
                  return (
                    <Flex
                      key={message.id}
                      justify="center"
                      py={1}
                      gap={1.5}
                      align="center"
                    >
                      <Text
                        fontSize="xs"
                        color="orange.500"
                        fontFamily="heading"
                        fontWeight="600"
                      >
                        Whisper:
                      </Text>
                      <Text
                        fontSize="xs"
                        color="orange.600"
                        fontFamily="body"
                        fontStyle="italic"
                      >
                        {message.content}
                      </Text>
                    </Flex>
                  );
                }
                // A tutor-suggested hands-on task: render the rich "Go do this"
                // card. `content` carries the physicalTasks id.
                if (message.toolAction === "physical_task" && message.content) {
                  return (
                    <PhysicalTaskCard
                      key={message.id}
                      physicalTaskId={message.content}
                      readOnly={!!isRemoteMode}
                    />
                  );
                }
                // Whatever is left: the illustration the tutor generated and/or
                // the receipt line naming what it just did. `toolRowDisplay` is
                // the one answer both frontends read — a row can carry both, and
                // treating them as alternatives is how iPad lost the picture.
                const toolDisplay = toolRowDisplay<string>(message);
                return (
                  <Box key={message.id} textAlign="center" py={1}>
                    {toolDisplay.imageId && message.imageUrl && (
                      <GeneratedImage url={message.imageUrl} />
                    )}
                    {toolDisplay.label && (
                      <Text
                        fontSize="xs"
                        color="fg.muted"
                        fontFamily="heading"
                        textAlign="center"
                      >
                        {toolDisplay.label}
                      </Text>
                    )}
                  </Box>
                );
              }

              const reconciledMessage = reconciledMessagesById.get(message.id);
              if (!reconciledMessage) return null;
              return (
                <MessageBubble
                  key={message.id}
                  message={reconciledMessage.message}
                  personaOptions={personaOptions}
                  isStreaming={reconciledMessage.isActiveStream && !!streamingContent}
                  generatingImage={reconciledMessage.isActiveStream && generatingImage}
                  ttsEnabled={ttsEnabled}
                  graphemeStages={graphemeStages}
                  hasGraphemeStages={hasGraphemeStages}
                  showFlags={showFlags}
                  flag={getFlag ? getFlag(message.id) : null}
                  onToggleFlag={onToggleFlag}
                  canFlagWrong={canFlagWrong}
                  onFlagWrong={onFlagWrong}
                  showInputModality={!!isRemoteMode}
                  beginner={
                    beginner
                      ? {
                          ...beginner,
                          onReadAloud:
                            message.id === messages[messages.length - 1]?.id
                              ? beginner.onReadAloud
                              : undefined,
                        }
                      : null
                  }
                />
              );
            })}

          {!sessionActivityId && !activityCompletedAt && (
            <SessionRecapCard
              key={`wrap-${sessionId}`}
              sessionId={sessionId}
              isComplete={false}
              canRequest={
                !isRemoteMode &&
                !isStreaming &&
                !showFlags &&
                observerMessageCount >= 2
              }
            />
          )}

          <SessionStreamStatus
            isStreaming={isStreaming}
            streamingContent={streamingContent}
            generatingImage={generatingImage}
            toolActivity={toolActivity}
            scholarSafe={!isRemoteMode}
            pending={isTurnPending}
            pendingSince={pendingSince}
          />

          {isTurnDead && onRetryTurn && (
            <TutorTurnFailedNotice
              onRetry={onRetryTurn}
              note={failedTurnNote}
              addKeyHref={failedTurnAddKeyHref}
            />
          )}

          <div ref={messagesEndRef} />
        </VStack>
      </Box>

      {/* Whisper Bar moved inside the floating input card (search
          for "Whisper row" below). Was previously a separate
          full-width bar sitting between the messages list and the
          (now floating) input — the float overlapped it. */}

      {/* Time Limit Modal */}
      {timeLimit && (
        <TimeLimitModal
          isOpen={isTimeLimitModalOpen}
          onClose={() => onToggleTimeLimitModal?.()}
          isActive={timeLimit.isActive}
          display={timeLimit.display}
          onSetLimit={timeLimit.setLimit}
          onClearLimit={timeLimit.clearLimit}
        />
      )}

      {/* Input Area — floating frosty card centered in the chat
          pane. Was previously a full-width gray bar that visually
          fused with the gray right-panel chrome; the floating card
          makes the chat and the document panel feel like distinct
          surfaces. Backdrop-filter blurs whatever chat content
          scrolls beneath it. */}
      <Box
        position="absolute"
        bottom={4}
        left={0}
        right={0}
        display="flex"
        justifyContent="center"
        pointerEvents="none"
        zIndex={10}
        px={4}
      >
        <Box
          pointerEvents="auto"
          maxW="3xl"
          w="full"
          py={3}
          px={isTouchDevice ? 2 : 3}
          bg={
            whisperMode
              ? "rgba(255,237,213,0.92)" // orange.100 with alpha
              : timeLimit?.isExpired
                ? "rgba(254,226,226,0.92)"
                : "rgba(255,255,255,0.82)"
          }
          backdropFilter="blur(16px) saturate(180%)"
          borderRadius="2xl"
          borderWidth="1px"
          borderColor={whisperMode ? "orange.300" : "gray.200"}
          shadow="0 8px 32px rgba(0,0,0,0.10), 0 2px 8px rgba(0,0,0,0.04)"
        >
        {/* Queued-whisper pill — when a whisper has been sent and is
            waiting to inject into the tutor's next turn. Edit reopens
            it in the toggled input; clear cancels. Whisper authoring
            itself happens via the toggle on the left of the +
            attachment button (see "Whisper toggle" below). */}
        {isRemoteMode && pendingWhisper && (
          <Flex
            gap={2}
            align="center"
            px={3}
            py={1.5}
            mb={2}
            bg="orange.50"
            border="1px solid"
            borderColor="orange.200"
            borderRadius="lg"
          >
            <Lock size={11} color="var(--chakra-colors-orange-600)" />
            <Text
              fontSize="xs"
              fontFamily="heading"
              color="orange.600"
              fontWeight="600"
              whiteSpace="nowrap"
            >
              Whisper queued:
            </Text>
            <Text
              fontSize="sm"
              fontFamily="body"
              color="orange.700"
              flex={1}
              overflow="hidden"
              textOverflow="ellipsis"
              whiteSpace="nowrap"
            >
              {pendingWhisper}
            </Text>
            <IconButton
              aria-label="Edit whisper"
              size="xs"
              variant="ghost"
              color="orange.500"
              _hover={{ bg: "orange.100" }}
              onClick={() => {
                setWhisperInput?.(pendingWhisper ?? "");
                setWhisperMode(true);
                onClearWhisper?.();
              }}
            >
              <PencilSimple />
            </IconButton>
            <IconButton
              aria-label="Clear whisper"
              size="xs"
              variant="ghost"
              color="orange.500"
              _hover={{ bg: "orange.100" }}
              onClick={onClearWhisper}
            >
              <X />
            </IconButton>
          </Flex>
        )}
        {/* Pending image preview */}
        {pendingImage && (
          <Flex maxW="3xl" mx="auto" mb={2} position="relative" display="inline-flex">
            <Box
              borderRadius="lg"
              overflow="hidden"
              border="1px solid"
              borderColor="gray.200"
              position="relative"
              maxH="120px"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- dynamic blob/data-URL preview; next/image can't optimize it */}
              <img
                src={pendingImage.preview}
                alt="Upload preview"
                style={{ maxHeight: "120px", objectFit: "cover", borderRadius: "8px" }}
              />
              <IconButton
                aria-label="Remove image"
                size="xs"
                variant="solid"
                bg="blackAlpha.600"
                color="white"
                _hover={{ bg: "blackAlpha.800" }}
                position="absolute"
                top={1}
                right={1}
                borderRadius="full"
                onClick={onClearImage}
              >
                <X size={12} />
              </IconButton>
            </Box>
          </Flex>
        )}
        {/* Timer countdown bar */}
        {timeLimit?.isActive && !timeLimit.isExpired && (
          <Flex maxW="3xl" mx="auto" mb={2} align="center" gap={2}>
            <Clock size={14} color={timeLimit.secondsRemaining <= 60 ? "#E53E3E" : "#DD6B20"} />
            <Text
              fontSize="sm"
              fontFamily="heading"
              fontWeight="600"
              color={timeLimit.secondsRemaining <= 60 ? "red.500" : "orange.500"}
            >
              {timeLimit.display}
            </Text>
            <Box flex={1} h="3px" bg="gray.200" borderRadius="full" overflow="hidden">
              <Box
                h="full"
                bg={timeLimit.secondsRemaining <= 60 ? "red.400" : "orange.400"}
                borderRadius="full"
                transition="width 1s linear"
                style={{
                  width: `${Math.max(0, (timeLimit.secondsRemaining / (timeLimit.totalSeconds || 1)) * 100)}%`,
                }}
              />
            </Box>
          </Flex>
        )}
        {/* Time's up message */}
        {timeLimit?.isExpired && (
          <Flex maxW="3xl" mx="auto" mb={2} justify="center">
            <Text fontSize="lg" fontFamily="heading" fontWeight="700" color="red.500">
              Time&apos;s up!
            </Text>
          </Flex>
        )}
        <Flex maxW="3xl" mx="auto" gap={isTouchDevice? 1 : 3} align="center">
          {dictationState === "recording" || dictationState === "connecting" ? (
            <>
              {/* Cancel recording — discard audio, nothing sends */}
              <IconButton
                aria-label="Cancel recording"
                variant="ghost"
                color="charcoal.400"
                _hover={{ bg: "red.50" }}
                borderRadius="full"
                size="md"
                onClick={cancelRecording}
              >
                <X />
              </IconButton>
              {/* Listening indicator — textarea hidden behind for stable height */}
              <Box flex={1} position="relative">
                <Textarea
                  resize="none"
                  rows={1}
                  overflow="hidden"
                  borderRadius="xl"
                  fontFamily="body"
                  fontSize={isTouchDevice ? "md" : "xl"}
                  py={3}
                  px={isTouchDevice ? 3 : 4}
                  style={{ visibility: "hidden" }}
                  readOnly
                />
                {dictationState === "connecting" ? (
                  // Audio isn't reaching the transcriber yet — never show the
                  // red listening state here, or the first words are lost.
                  <Flex
                    position="absolute"
                    inset={0}
                    align="center"
                    justify="center"
                    bg="gray.50"
                    border="0.5px solid"
                    borderColor="gray.300"
                    borderRadius="xl"
                    gap={3}
                    role="status"
                  >
                    <Spinner size="sm" color="charcoal.400" />
                    <Text
                      fontFamily="heading"
                      fontWeight="600"
                      fontSize={isTouchDevice ? "md" : "xl"}
                      color="charcoal.400"
                    >
                      {DICTATION_CONNECTING_LABEL}
                    </Text>
                  </Flex>
                ) : (
                <Flex
                  position="absolute"
                  inset={0}
                  align="center"
                  justify="center"
                  bg="red.50"
                  border="0.5px solid"
                  borderColor={isTooLoud ? "red.400" : "red.300"}
                  borderRadius="xl"
                  gap={3}
                >
                  <Box
                    w="10px"
                    h="10px"
                    borderRadius="full"
                    bg={isTooLoud ? "red.500" : "red.400"}
                    flexShrink={0}
                    className="animate-pulse-soft"
                  />
                  <Text
                    fontFamily="heading"
                    fontWeight="600"
                    fontSize={isTouchDevice ? "md" : "xl"}
                    color={isTooLoud ? "red.600" : "red.500"}
                    fontVariantNumeric="tabular-nums"
                  >
                    {isTooLoud ? "Too loud!" : timerDisplay}
                  </Text>
                </Flex>
                )}
              </Box>
              {/* Stop recording — transcribe + send in one tap. Big and red so
                  it's the obvious "I'm done, send it" action. Nothing to send
                  until audio is flowing. */}
              <IconButton
                ref={sendRecBtnRef}
                aria-label="Stop and send recording"
                {...composerStopRecordingStyle(hasSpeech)}
                onClick={stopRecording}
                disabled={dictationState === "connecting"}
              >
                <ArrowUp />
              </IconButton>
            </>
          ) : (
            <>
              {/* Whisper toggle — remote mode only. Sits LEFT of +.
                  Flips the whole input card into whisper mode
                  (orange tint, textarea binds to whisperInput,
                  send fires onSendWhisper). One field, two modes. */}
              {isRemoteMode && (
                <Button
                  aria-label={
                    whisperMode ? "Switch back to chat" : "Switch to whisper"
                  }
                  title={
                    whisperMode
                      ? "Switch back to chat"
                      : "Whisper (private guidance to the AI)"
                  }
                  variant="ghost"
                  color={whisperMode ? "white" : "charcoal.500"}
                  bg={whisperMode ? "orange.500" : "transparent"}
                  _hover={{
                    bg: whisperMode ? "orange.600" : "gray.100",
                  }}
                  borderRadius="xl"
                  size="md"
                  fontFamily="heading"
                  fontWeight="600"
                  fontSize="sm"
                  px={3}
                  onClick={() => setWhisperMode((v) => !v)}
                >
                  Whisper
                </Button>
              )}
              {/* Add photo — left of input. Hidden in whisper mode
                  because whispers are text-only. Shared attach control (same
                  one the practice "talk me through it" chat uses). */}
              {!whisperMode && (
                <ComposerAttachMenu
                  onPick={(img) => setPendingImage?.(img)}
                  disabled={sendBlocked || timeLimit?.isExpired}
                >
                  {!isRemoteMode && onToggleTimeLimitModal && (
                    <Menu.Item
                      value="time-limit"
                      cursor="pointer"
                      onClick={onToggleTimeLimitModal}
                      color={timeLimit?.isActive ? "orange.600" : "inherit"}
                    >
                      <Clock />
                      {timeLimit?.isActive ? `Timer: ${timeLimit.display}` : "Time Limit"}
                    </Menu.Item>
                  )}
                </ComposerAttachMenu>
              )}
              {/* Text input — same control, two modes. In whisper
                  mode it drives whisperInput + Enter sends a
                  whisper; otherwise normal chat behavior. */}
              <Textarea
                ref={textareaRef}
                value={
                  whisperMode
                    ? whisperInput ?? ""
                    : timeLimit?.isExpired
                      ? ""
                      : input
                }
                onChange={(e) =>
                  whisperMode
                    ? setWhisperInput?.(e.target.value)
                    : setInput(e.target.value)
                }
                onKeyDown={(e) => {
                  if (whisperMode) {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (whisperInput?.trim()) {
                        onSendWhisper?.();
                        setWhisperMode(false);
                      }
                    }
                    return;
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    sentViaKeyboardRef.current = true;
                  }
                  handleKeyDown(e);
                }}
                maxLength={4000}
                // iOS on-screen keyboard: a blue Send return key, like
                // Messages (Enter already sends; Shift+Enter = newline).
                enterKeyHint="send"
                autoCapitalize="sentences"
                placeholder={
                  whisperMode
                    ? "Private guidance for the AI — only the tutor sees this"
                    : timeLimit?.isExpired
                      ? "Session ended"
                      : isRemoteMode && remoteScholarName
                        ? `Chat as ${remoteScholarName}…`
                        : "Type a message or question…"
                }
                resize="none"
                rows={1}
                overflow="hidden"
                bg="white"
                border="0.5px solid"
                borderColor={
                  whisperMode
                    ? "orange.300"
                    : timeLimit?.isExpired
                      ? "red.300"
                      : "gray.400"
                }
                borderRadius="xl"
                _focus={{
                  borderColor: whisperMode
                    ? "orange.400"
                    : timeLimit?.isExpired
                      ? "red.300"
                      : "violet.400",
                  boxShadow: "none",
                  outline: "none",
                }}
                _focusVisible={{
                  boxShadow: "none",
                  outline: "none",
                }}
                _placeholder={{
                  color: whisperMode
                    ? "orange.400"
                    : timeLimit?.isExpired
                      ? "red.300"
                      : "gray.400",
                }}
                fontFamily="body"
                fontSize={isTouchDevice ? "md" : "xl"}
                py={3}
                px={isTouchDevice ? 3 : 4}
                disabled={
                  whisperMode
                    ? false
                    : sendBlocked || timeLimit?.isExpired
                }
              />
              {/* Voice-first mode toggle — spoken replies + hands-free
                  listening. Sits left of the action slot so it's always
                  reachable. Hidden when TTS is teacher-disabled. */}
              {onToggleVoiceMode && !whisperMode && (
                <Tooltip.Root openDelay={400} closeDelay={0}>
                  <Tooltip.Trigger asChild>
                    <IconButton
                      aria-label={voiceMode ? "Turn off voice mode" : "Turn on voice mode"}
                      variant={voiceMode ? "solid" : "ghost"}
                      bg={voiceMode ? "violet.500" : undefined}
                      color={voiceMode ? "white" : "charcoal.400"}
                      _hover={voiceMode ? { bg: "violet.600" } : { bg: "gray.100" }}
                      borderRadius="xl"
                      size="md"
                      // Pulse while the tutor's voice is playing — shows WHY
                      // the mic isn't listening yet.
                      css={
                        voiceMode && ttsState === "speaking"
                          ? { animation: "tts-pulse 2s ease-in-out infinite" }
                          : undefined
                      }
                      onClick={onToggleVoiceMode}
                    >
                      <Waveform />
                    </IconButton>
                  </Tooltip.Trigger>
                  <Portal>
                    <Tooltip.Positioner>
                      <Tooltip.Content fontSize="xs">
                        {voiceMode
                          ? "Voice mode is on — replies are spoken, mic listens after"
                          : "Voice mode: hear replies and talk back, hands-free"}
                      </Tooltip.Content>
                    </Tooltip.Positioner>
                  </Portal>
                </Tooltip.Root>
              )}
              {/* Right slot: in whisper mode → Send-whisper.
                  Otherwise: Stop (streaming) / Mic (empty input) /
                  Send (has input). */}
              {whisperMode ? (
                <IconButton
                  aria-label="Send whisper"
                  bg="orange.500"
                  color="white"
                  _hover={{ bg: "orange.600" }}
                  _disabled={{ opacity: 0.5, cursor: "not-allowed" }}
                  borderRadius="xl"
                  size="md"
                  onClick={() => {
                    if (!whisperInput?.trim()) return;
                    onSendWhisper?.();
                    setWhisperMode(false);
                  }}
                  disabled={!whisperInput?.trim()}
                >
                  <ArrowUp />
                </IconButton>
              ) : isStreaming ? (
                <IconButton
                  aria-label="Stop generating"
                  variant="ghost"
                  color="charcoal.400"
                  _hover={{ bg: "gray.100" }}
                  borderRadius="xl"
                  size="md"
                  onClick={onStopStream}
                >
                  <Square />
                </IconButton>
              ) : (!input.trim() && !pendingImage && sttEnabled) ? (
                <IconButton
                  ref={micBtnRef}
                  aria-label={
                    dictationState === "transcribing"
                      ? "Transcribing…"
                      : "Start recording — tap to talk, tap again to send"
                  }
                  // Big, obvious, primary affordance: a solid violet circle
                  // (matches the Send button so an empty box reads "the mic is
                  // how you talk"). Tap to start an open recording; tap the stop
                  // button to send. Hold still works for push-to-talk.
                  {...composerMicButtonStyle}
                  onPointerDown={handleMicPointerDown}
                  onPointerUp={handleMicPointerUp}
                  onPointerLeave={handleMicPointerUp}
                  onClick={() => {
                    // A completed hold already recorded; swallow the
                    // synthetic click that follows pointerup.
                    if (suppressMicClickRef.current) {
                      suppressMicClickRef.current = false;
                      return;
                    }
                    getTTSEngine()?.stop(); // don't record over the tutor's voice
                    void toggleRecording();
                  }}
                  disabled={dictationState === "transcribing" || timeLimit?.isExpired || isMicBusy}
                >
                  {dictationState === "transcribing" ? (
                    <Spinner size="sm" />
                  ) : (
                    <Microphone weight="fill" />
                  )}
                </IconButton>
              ) : (
                <IconButton
                  aria-label="Send message"
                  bg="violet.500"
                  color="white"
                  _hover={{ bg: "violet.700" }}
                  _disabled={{ opacity: 0.5, cursor: "not-allowed" }}
                  borderRadius="xl"
                  size="md"
                  onClick={() => handleSend()}
                  // A server-derived pending turn (isTurnPending, not a live
                  // local stream) must NOT disable Send: a click steers exactly
                  // like the Enter path (handleKeyDown → handleSend), whose
                  // send mutation stamps the in-flight row. Only the real
                  // guards remain (empty input / sendBlocked / time limit); the
                  // streaming case is handled by the Stop control above.
                  disabled={(!input.trim() && !pendingImage) || sendBlocked || timeLimit?.isExpired}
                >
                <ArrowUp />
              </IconButton>
              )}
            </>
          )}
        </Flex>
        {dictationError && (
          <Text fontSize="xs" color="red.500" textAlign="center" mt={1} fontFamily="heading">
            {dictationError}
          </Text>
        )}
        {/* Anti-parasocial chat chrome. Exactly ONE line under the composer,
            shown on every surface — including touch, the kid's primary device,
            which used to get only a weak data line. Ordinary chat always shows
            the third-person, tool-framed relational line; homework precedence
            lives in lib/admonishments.ts.

            On homework the "I'm done with this" control sits on this same
            line: the caption already establishes that a teacher is on the
            other end, so this is where "tell them I've finished" belongs.
            It is the SAME `activityCompletions` toggle the Big picture drawer
            offers — given a place a child can see, not a second way to
            finish (review/homework-flow-plan.html barred that). */}
        <Box mt={2}>
          <Flex align="center" justify="center" gap={2} wrap="wrap">
            <Text
              fontSize="xs"
              color="fg.muted"
              textAlign="center"
              fontFamily="heading"
            >
              {onToggleHomeworkDone && homeworkDone
                ? HOMEWORK_DONE_CONFIRMED
                : pickAdmonishment({
                    isHomework: admonishmentIsHomework,
                  })}
            </Text>
            {onToggleHomeworkDone && (
              <Button
                size="xs"
                variant={homeworkDone ? "ghost" : "outline"}
                fontFamily="heading"
                fontWeight="600"
                color={homeworkDone ? "charcoal.400" : "navy.500"}
                borderColor="gray.300"
                loading={homeworkDoneSaving}
                onClick={handleToggleHomeworkDone}
              >
                {homeworkDone ? HOMEWORK_DONE_UNDO : HOMEWORK_DONE_LABEL}
              </Button>
            )}
          </Flex>
        </Box>
        </Box>
      </Box>
    </Flex>
  );
}

// Message type matching what Convex getWithMessages returns
interface MessageData {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  createdAt: number;
  personaId?: string | null;
  unitId?: string | null;
  perspectiveId?: string | null;
  toolAction?: string | null;
  flairAwards?: FlairAward[];
  imageId?: string | null;
  appSnapshotStorageId?: string | null;
  // Served by getWithMessages behind its session gate.
  imageUrl?: string | null;
  appSnapshotUrl?: string | null;
  chatPractice?: ChatPracticePayload | null;
  instruction?: InstructionChatPayload | null;
  resourceShare?: ResourceShare | null;
  inputModality?: MessageInputModality;
  gotItWrong?: boolean;
  gotItWrongReason?: string | null;
  graphemeSpans?: readonly GraphemeSpan[];
  // Streaming placeholder fields (present on the raw messages row) — used to
  // derive server-truth pending/failed turn state.
  streamId?: string | null;
  lastStreamActivityAt?: number | null;
  streamTrigger?: "activityKickoff" | "appUpdate";
  // Set (and never cleared) when the user cut this reply short. Drives the
  // muted "Stopped" caption under a finalized assistant bubble.
  stopRequestedAt?: number | null;
}

interface ObservationData {
  _id: string;
  conceptLabel: string;
  domain: string;
  masteryLevel: number;
  confidenceScore: number;
  evidenceSummary: string;
  evidenceType: string;
  studentInitiated: boolean;
  isSuperseded: boolean;
  observedAt: number;
}

/** Strip markdown formatting for TTS. */
// Generated Image Component (for AI-generated illustrations in tool messages)
function GeneratedImage({ url }: { url: string }) {
  const [zoomed, setZoomed] = useState(false);
  return (
    <Box my={2} mx="auto" maxW="400px" borderRadius="xl" overflow="hidden">
      {/* eslint-disable-next-line @next/next/no-img-element -- dynamic remote AI-generated image URL; next/image needs per-domain config */}
      <img
        src={url}
        alt="AI-generated illustration"
        style={{ width: "100%", borderRadius: "12px", cursor: "zoom-in" }}
        onClick={() => setZoomed(true)}
      />
      {zoomed && (
        <ImageLightbox src={url} alt="AI-generated illustration" onClose={() => setZoomed(false)} />
      )}
    </Box>
  );
}

/** What a listener's or beginner's message bubbles need (TRA-504). */
type BeginnerBubbleProps = {
  /** Null for a listener (and while a beginner's inventory loads). */
  alphabet: DecodableAlphabet | null;
  onReadAloud?: () => void;
  readAloudDisabled: boolean;
  /** `conversationTextSteps`: listener 2, beginner 1. */
  textSteps: number;
};

/** One young-reader step is one notch on Chakra's font-size scale. */
const CONVERSATION_FONT_SIZES = ["lg", "xl", "2xl"] as const;
const YOUR_TURN_FONT_SIZES = ["3xl", "4xl", "5xl"] as const;

// Message Bubble Component
const MessageBubble = memo(function MessageBubble({
  message,
  personaOptions = [],
  isStreaming = false,
  generatingImage = false,
  ttsEnabled = true,
  graphemeStages,
  hasGraphemeStages = false,
  showFlags = false,
  flag = null,
  onToggleFlag,
  canFlagWrong = false,
  onFlagWrong,
  showInputModality = false,
  beginner = null,
}: {
  beginner?: BeginnerBubbleProps | null;
  message: MessageData;
  personaOptions?: DimensionOption[];
  isStreaming?: boolean;
  generatingImage?: boolean;
  ttsEnabled?: boolean;
  graphemeStages?: GraphemeStages;
  hasGraphemeStages?: boolean;
  showFlags?: boolean;
  flag?: "good" | "bad" | null;
  onToggleFlag?: (messageId: string, kind: "good" | "bad") => void;
  canFlagWrong?: boolean;
  onFlagWrong?: (messageId: string, currentlyFlagged: boolean) => void;
  showInputModality?: boolean;
}) {
  const isUser = message.role === "user";
  const tts = useTTSQueue();

  // Look up persona from message snapshot
  const messagePersona = message.personaId
    ? personaOptions.find((p) => p.id === message.personaId)
    : null;

  const assistantLabel = messagePersona
    ? `${messagePersona.emoji} ${messagePersona.title}`
    : "AI";
  const useGrapheme =
    message.role === "assistant" &&
    !isStreaming &&
    hasGraphemeStages &&
    !!graphemeStages &&
    !!message.graphemeSpans &&
    message.graphemeSpans.length > 0;

  const imageUrl = message.imageUrl ?? null;
  const appSnapshotUrl = message.appSnapshotUrl ?? null;
  const [snapshotZoomed, setSnapshotZoomed] = useState(false);

  if (isUser) {
    return (
      <Box
        className="message-bubble user animate-fade-in"
        alignSelf="flex-end"
      >
        {appSnapshotUrl && (
          <>
            <Box
              as="button"
              display="block"
              ml="auto"
              mb={2}
              overflow="hidden"
              borderRadius="lg"
              borderWidth="1px"
              borderColor="border.subtle"
              bg="bg.subtle"
              onClick={() => setSnapshotZoomed(true)}
              aria-label="Open app snapshot"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- dynamic Convex storage URL */}
              <img
                src={appSnapshotUrl}
                alt="App snapshot of the running app"
                style={{
                  width: "120px",
                  height: "68px",
                  objectFit: "cover",
                  display: "block",
                }}
              />
              <Text
                px={2}
                py={1}
                fontSize="2xs"
                color="fg.muted"
                textAlign="left"
              >
                📸 App snapshot
              </Text>
            </Box>
            {snapshotZoomed && (
              <ImageLightbox
                src={appSnapshotUrl}
                alt="App snapshot of the running app"
                onClose={() => setSnapshotZoomed(false)}
              />
            )}
          </>
        )}
        {imageUrl && (
          <Box mb={2} borderRadius="lg" overflow="hidden" maxW="300px" ml="auto">
            {/* eslint-disable-next-line @next/next/no-img-element -- dynamic remote image URL; next/image needs per-domain config */}
            <img
              src={imageUrl}
              alt="Uploaded image"
              style={{ maxWidth: "100%", borderRadius: "8px" }}
            />
          </Box>
        )}
        <Box
          bg="navy.500"
          color="white"
          px={4}
          py={3}
          borderRadius="xl"
          borderBottomRightRadius="sm"
          maxW="100%"
          shadow="sm"
        >
          <Text
            fontFamily="body"
            fontSize={CONVERSATION_FONT_SIZES[beginner?.textSteps ?? 0]}
            whiteSpace="pre-wrap"
          >
            {message.content}
          </Text>
        </Box>
        <Flex mt={1} justify="flex-end" align="center" gap={2}>
          <Text
            fontSize="xs"
            color="fg.muted"
            textAlign="right"
            fontFamily="heading"
          >
            You
          </Text>
          {showInputModality && (
            <SessionInputModality modality={message.inputModality} />
          )}
        </Flex>
      </Box>
    );
  }

  // Assistant message
  return (
    <Box
      className="message-bubble assistant animate-fade-in"
      alignSelf="flex-start"
    >
      <Flex
        css={{ "&:hover .tts-btn": { opacity: 1 } }}
      >
        <Box
          bg="gray.100"
          color="charcoal.500"
          px={4}
          py={3}
          borderRadius="xl"
          borderBottomLeftRadius="sm"
          maxW="100%"
          shadow="sm"
          flex="1"
          minW={0}
        >
          <SessionAssistantMessageBody
            fontSize={CONVERSATION_FONT_SIZES[beginner?.textSteps ?? 0]}
            content={message.content}
            isStreaming={isStreaming}
            generatingImage={generatingImage}
            settled={
              beginner && message.content ? (
                <BeginnerReplyWeb
                  content={message.content}
                  spans={message.graphemeSpans}
                  stages={graphemeStages ?? {}}
                  alphabet={beginner.alphabet}
                  onReadAloud={beginner.onReadAloud}
                  readAloudDisabled={beginner.readAloudDisabled}
                  yourTurnFontSize={YOUR_TURN_FONT_SIZES[beginner.textSteps]}
                />
              ) : useGrapheme ? (
                <Box as="span" whiteSpace="pre-wrap">
                  {/* Per part, so a beginner's `<your-turn>` tags never show
                      (TRA-504) while the spans still land on their letters. */}
                  {splitYourTurn(message.content).map((part) => (
                    <GraphemeText
                      key={part.start}
                      text={part.text}
                      spans={partSpans(part, message.graphemeSpans!)}
                      stages={graphemeStages}
                    />
                  ))}
                </Box>
              ) : undefined
            }
          />
        </Box>
        {/* Sticky side-track of message controls. Renders when EITHER the TTS
            button OR the scholar "got this wrong" control should show, so the
            thumbs-down appears (stacked under the speaker) even when TTS is
            disabled. */}
        {!isStreaming && message.content &&
          (ttsEnabled || (canFlagWrong && onFlagWrong)) && (
          <Box flexShrink={0} w="44px" ml={1} pt={1.5}>
            <Flex
              direction="column"
              align="center"
              gap={1}
              position="sticky"
              top="-12px"
            >
              {ttsEnabled && (
                <Tooltip.Root openDelay={400} closeDelay={0} positioning={{ placement: "right" }}>
                  <Tooltip.Trigger asChild>
                    {tts.state === "speaking" ? (
                      <IconButton
                        className="tts-btn"
                        aria-label="Pause reading"
                        size="xs"
                        variant="solid"
                        bg="violet.500"
                        color="white"
                        borderRadius="full"
                        _hover={{ bg: "violet.600" }}
                        _active={{ transform: "scale(0.9)" }}
                        css={{ animation: "tts-pulse 2s ease-in-out infinite" }}
                        onClick={() => {
                          tts.pause();
                        }}
                      >
                        <Pause size={10} weight="fill" />
                      </IconButton>
                    ) : tts.state === "paused" ? (
                      <IconButton
                        className="tts-btn"
                        aria-label="Resume reading"
                        size="xs"
                        variant="solid"
                        bg="violet.500"
                        color="white"
                        borderRadius="full"
                        _hover={{ bg: "violet.600" }}
                        _active={{ transform: "scale(0.9)" }}
                        onClick={() => {
                          tts.resume();
                        }}
                      >
                        <Play size={10} weight="fill" />
                      </IconButton>
                    ) : (
                      <IconButton
                        className="tts-btn"
                        aria-label="Read aloud"
                        size="xs"
                        variant="ghost"
                        color="charcoal.300"
                        _hover={{ color: "violet.600", bg: "violet.50" }}
                        _active={{ transform: "scale(0.9)" }}
                        opacity={0}
                        transition="opacity 0.15s"
                        onClick={async () => {
                          // iPad muted → "Read aloud" would play nothing with no
                          // feedback. Tell the kid to turn the volume up instead.
                          if (await isLikelyMuted()) {
                            toaster.error({
                              title: "Turn up the iPad volume",
                              description:
                                "Rabbithole is ready to read aloud, but this iPad's volume is all the way down.",
                            });
                            return;
                          }
                          tts.toggle(withoutYourTurn(message.content));
                        }}
                      >
                        <SpeakerHigh size={14} />
                      </IconButton>
                    )}
                  </Tooltip.Trigger>
                  <Portal>
                    <Tooltip.Positioner>
                      <Tooltip.Content fontSize="xs">
                        {tts.state === "speaking"
                          ? "Pause"
                          : tts.state === "paused"
                            ? "Resume"
                            : "Read aloud"}
                      </Tooltip.Content>
                    </Tooltip.Positioner>
                  </Portal>
                </Tooltip.Root>
              )}
              {/* Scholar "Rabbithole got this wrong" control — icon-only, the
                  pro-skepticism signal. Only on the scholar's own live session
                  (not manual-rehearsal / remote), on final tutor messages. Catching
                  the AI out is a WIN: flagged for the teacher + celebrated in
                  the moment (toast + the acknowledgment box below). The caught
                  state reads as an icon change (filled amber thumbs-down), no
                  text label. */}
              {canFlagWrong && onFlagWrong && (
                <Tooltip.Root openDelay={300} closeDelay={0} positioning={{ placement: "right" }}>
                  <Tooltip.Trigger asChild>
                    <IconButton
                      aria-label={
                        message.gotItWrong
                          ? "Flagged as wrong — tap to undo"
                          : "Got this wrong?"
                      }
                      size="xs"
                      variant="ghost"
                      color={message.gotItWrong ? "amber.700" : "charcoal.300"}
                      bg={message.gotItWrong ? "amber.100" : undefined}
                      borderRadius="full"
                      _hover={{ color: "amber.700", bg: "amber.50" }}
                      onClick={() =>
                        onFlagWrong(message.id, !!message.gotItWrong)
                      }
                    >
                      <ThumbsDown
                        size={14}
                        weight={message.gotItWrong ? "fill" : "regular"}
                      />
                    </IconButton>
                  </Tooltip.Trigger>
                  <Portal>
                    <Tooltip.Positioner>
                      <Tooltip.Content fontSize="xs" maxW="220px" textAlign="center">
                        {message.gotItWrong
                          ? "Flagged for your teacher — tap to undo"
                          : "Think Rabbithole got this wrong? Flag it for your teacher. Catching the AI is a win."}
                      </Tooltip.Content>
                    </Tooltip.Positioner>
                  </Portal>
                </Tooltip.Root>
              )}
            </Flex>
          </Box>
        )}
      </Flex>
      <Flex align="center" gap={2} mt={1}>
        <Text
          fontSize="xs"
          color="fg.muted"
          textAlign="left"
          fontFamily="heading"
        >
          {assistantLabel}
        </Text>
        {/* The user cut this reply short — a quiet, iconless caption. */}
        {!isStreaming && message.stopRequestedAt && (
          <Text fontSize="xs" color="fg.muted" fontFamily="heading">
            Stopped
          </Text>
        )}
        {/* Manual-rehearsal flags: 👍 / 👎 on the tutor's own messages, only when
            the parent session is a manual rehearsal. Lets the teacher tag good /
            bad responses; flags surface to Curriculum Bot when the bot
            drawer is opened (phase 3). Streaming messages don't get flags
            since the response isn't final yet. */}
        {showFlags && !isStreaming && message.content && onToggleFlag && (
          <Flex gap={0.5} align="center">
            <Tooltip.Root openDelay={300} closeDelay={0}>
              <Tooltip.Trigger asChild>
                <IconButton
                  aria-label={flag === "good" ? "Remove good flag" : "Mark as a good response"}
                  size="2xs"
                  variant="ghost"
                  color={flag === "good" ? "cyan.600" : "charcoal.300"}
                  _hover={{ color: "cyan.600", bg: "cyan.50" }}
                  onClick={() => onToggleFlag(message.id, "good")}
                >
                  <ThumbsUp size={14} weight={flag === "good" ? "fill" : "regular"} />
                </IconButton>
              </Tooltip.Trigger>
              <Portal>
                <Tooltip.Positioner>
                  <Tooltip.Content fontSize="xs">
                    {flag === "good" ? "Flagged 👍" : "Mark as a good response"}
                  </Tooltip.Content>
                </Tooltip.Positioner>
              </Portal>
            </Tooltip.Root>
            <Tooltip.Root openDelay={300} closeDelay={0}>
              <Tooltip.Trigger asChild>
                <IconButton
                  aria-label={flag === "bad" ? "Remove bad flag" : "Mark as a bad response"}
                  size="2xs"
                  variant="ghost"
                  color={flag === "bad" ? "red.500" : "charcoal.300"}
                  _hover={{ color: "red.500", bg: "red.50" }}
                  onClick={() => onToggleFlag(message.id, "bad")}
                >
                  <ThumbsDown size={14} weight={flag === "bad" ? "fill" : "regular"} />
                </IconButton>
              </Tooltip.Trigger>
              <Portal>
                <Tooltip.Positioner>
                  <Tooltip.Content fontSize="xs">
                    {flag === "bad" ? "Flagged 👎" : "Mark as a bad response"}
                  </Tooltip.Content>
                </Tooltip.Positioner>
              </Portal>
            </Tooltip.Root>
          </Flex>
        )}
      </Flex>
      {/* In-the-moment celebration of skepticism. Persists while flagged
          (reversible). Reinforces "you're the boss, I'm just a tool." */}
      {canFlagWrong && message.gotItWrong && (
        <Flex
          mt={1.5}
          px={3}
          py={2}
          bg="amber.50"
          borderWidth="1px"
          borderColor="amber.200"
          borderRadius="lg"
          align="flex-start"
          gap={2}
          maxW="100%"
        >
          <Text fontSize="md" lineHeight="1.2" aria-hidden>
            🎯
          </Text>
          <Box>
            <Text
              fontSize="xs"
              fontFamily="heading"
              fontWeight="700"
              color="amber.800"
            >
              Good catch — you&apos;re the boss, I&apos;m just a tool.
            </Text>
            <Text fontSize="xs" fontFamily="body" color="amber.700" mt={0.5}>
              Questioning my answers is exactly the right instinct. Your teacher
              will see this.
            </Text>
          </Box>
        </Flex>
      )}
    </Box>
  );
});
