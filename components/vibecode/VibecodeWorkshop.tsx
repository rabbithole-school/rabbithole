"use client";

/**
 * VibecodeWorkshop — the WEB twin of the native `VibecodeScreen`.
 * A `sessionMode: "vibecode"` session, rendered PREVIEW-FIRST: the app IS the
 * session's newest HTML code artifact, shown live in a sandboxed iframe
 * center-stage (via the shared `CodeArtifactViewer`), with a chat panel that
 * drives the build.
 *
 * One app surface (TRA-519): the same builder also opens for ANY session's
 * app — a chat session's app card → Open → `?view=builder` on the same route
 * — with a Chat control back, the session's other work in a Your work drawer,
 * and the builder stance (Edit | Play, the designer) only when the app is the
 * session's work (`shared/appSurface.ts`).
 *
 * DRY / reuse: the chat reuses the SAME tutor streaming path as the scholar
 * session — `api.sessions.sendMessage` + `${convexSiteUrl}/session-stream` via
 * `useAgentStream` — so whispers, teacher visibility, and observer wiring come
 * for free, exactly as `SessionInterface` and native `VibecodeScreen` stream.
 * The only sanctioned difference from native is the surface skin (DOM iframe +
 * Chakra here vs react-native-webview + sheets there — the two-frontends split).
 *
 * Scholar sessions still start from the empty-state prompt. A teacher build
 * hand-off (`isTestDrive` + activity `appRequest`) opens itself: the first
 * assistant-only turn builds the requested first cut without requiring the
 * teacher to restate the brief.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  Drawer,
  Flex,
  IconButton,
  Menu,
  Portal,
  Spinner,
  Text,
  Textarea,
  VStack,
  useBreakpointValue,
} from "@chakra-ui/react";
import {
  ArrowClockwise,
  ArrowUp,
  CaretDown,
  CaretLeft,
  ChatCircle,
  Check,
  ClockCounterClockwise,
  Hammer,
  List,
  Lock,
  Microphone,
  PaperPlaneRight,
  ProjectorScreen,
  Square,
  X,
} from "@phosphor-icons/react";
import { useConvex, useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAgentStream, type StreamEvent } from "@/hooks/useAgentStream";
import { useWorkshopMode } from "@/hooks/useWorkshopMode";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useStreamingDictation } from "@/hooks/useStreamingDictation";
import { DICTATION_CONNECTING_LABEL } from "@/lib/realtimeTranscriptionProtocol";
import { composerMicButtonStyle, composerStopRecordingStyle } from "@/components/composerMicStyles";
import {
  defaultChatOpen,
  defaultWorkshopMode,
  editControlFor,
  formatSavedAt,
  messageVisibleInMode,
  playSurfaceFor,
  switchToPlayMode,
  type EffectiveEditAccess,
  type WorkshopMode,
} from "@/shared/workshopMode";
import { useSendLock } from "@/hooks/useSendLock";
import {
  type AppSnapshotLoadBoundary,
  type CaptureAppSnapshot,
  uploadChangedAppSnapshot,
} from "@/hooks/useAppStateIframeBridge";
import { convexSiteUrl } from "@/lib/convexUrls";
import { ParkingLot } from "./ParkingLot";
import { useSavedForLaterActions } from "../SavedForLaterBlock";
import { toaster } from "@/lib/toaster";
import { serverRefusal } from "@/lib/serverErrorMessage";
import {
  enterFullscreen,
  exitFullscreen,
  fullscreenElementOf,
} from "@/lib/fullscreen";
import {
  EDIT_MODE_ASK_NOTICE,
  appTutorSendResultFromStatus,
  newestAppTutorAskContext,
  settleAppTutorSend,
  type AppTutorRequest,
  type AppTutorSendResult,
  type AppTutorUpdateBatch,
} from "@/shared/appTutorRequest";
import { useAppTutorUpdates, useUnreadTutorLine } from "@/hooks/useAppTutorUpdates";
import { TutorLineSlot } from "@/components/TutorLineStrip";
import {
  AppAiTurnRow,
  appCharacterNamesFrom,
  interleaveAppAiTurns,
} from "@/components/AppAiTurnRow";
import { isStaffRole, isTeacherRole } from "@/convex/lib/roles";
import {
  SWITCH_APP_LABEL,
  builderAppChoices,
  builderHtmlArtifact,
  htmlAppIds,
  newlyAddedHtmlApp,
  revisionsForApp,
} from "@/lib/vibecode/helpers";
import { deriveBuildPreview, deriveBuildStage, type BuildSignal } from "@/shared/buildStage";
import { renderCheckLoadBoundary } from "@/shared/renderCheckLoadBoundary";
import { BuildProgress, BuildStopped } from "@/components/vibecode/BuildProgress";
import { CodeArtifactViewer } from "@/components/CodeArtifactViewer";
import { VibecodeHistoryPanel } from "@/components/vibecode/VibecodeHistoryPanel";
import { flushAllArtifactSaves } from "@/components/ArtifactPanel";
import { ImageLightbox } from "@/components/ImageLightbox";
import { ComposerAttachMenu } from "@/components/ComposerAttachMenu";
import { usePendingImage } from "@/hooks/usePendingImage";
import {
  SessionAssistantMessageBody,
  SessionInputModality,
  useReconciledSessionMessages,
} from "@/components/SessionTranscript";
import { EmptyState } from "@/components/ui/EmptyState";
import { ContextTabs } from "@/components/ui/ContextTabs";
import { ArtifactDeliverableButton } from "@/components/ArtifactDeliverableButton";
import { useSessionDeliverable } from "@/hooks/useSessionDeliverable";
import {
  APP_SURFACE_COPY,
  YOUR_WORK_LABEL,
  deliverableStatusFor,
  sessionAppContextFor,
} from "@/shared/appSurface";
import { YourWorkDrawer } from "./YourWorkDrawer";

/** Tools whose in-flight state means "the app is rebuilding". */
const CODE_TOOLS = new Set(["create_code", "edit_document"]);
/** The hidden protocol token a tutor session can auto-send; never a bubble. */
const OPENER = "<start>";
const RENDER_CHECK_CLIENT_BUDGET_MS = 6_500;
const RENDER_CHECK_ARTIFACT_WAIT_MS = 2_000;

type VibecodeMessage = {
  id: string;
  role: string;
  content: string;
  stopRequestedAt?: number | null;
  appSnapshotUrl?: string | null;
  /** A photo the scholar attached to this turn ("make it look like this"). */
  imageUrl?: string | null;
  inputModality?: "typed" | "spoken" | "app";
  createdAt: number;
};

/** Whether a document is the scholar having started the deliverable's work. */
function countsAsWork(
  artifact: { type?: string; content: string },
  deliverableKind: string,
): boolean {
  if (deliverableKind === "text") {
    return (artifact.type ?? "text") === "text" && artifact.content.trim() !== "";
  }
  return artifact.type === deliverableKind;
}

type HtmlArtifactVersion = {
  id: string;
  revision: number;
  content: string;
  loadBoundary: AppSnapshotLoadBoundary | null;
};

function VibecodeAppSnapshot({ url }: { url?: string | null }) {
  const [open, setOpen] = useState(false);
  if (!url) return null;
  return (
    <>
      <Box
        as="button"
        display="block"
        ml="auto"
        mb={1.5}
        overflow="hidden"
        borderRadius="md"
        borderWidth="1px"
        borderColor="whiteAlpha.400"
        bg="blackAlpha.300"
        onClick={() => setOpen(true)}
        aria-label="Open app snapshot"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- dynamic Convex storage URL */}
        <img
          src={url}
          alt="App snapshot of the running app"
          style={{
            width: "112px",
            height: "64px",
            objectFit: "cover",
            display: "block",
          }}
        />
        <Text px={2} py={1} fontSize="2xs" color="white" textAlign="left">
          📸 App snapshot
        </Text>
      </Box>
      {open && (
        <ImageLightbox
          src={url}
          alt="App snapshot of the running app"
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** A photo the scholar attached to a turn, in their bubble; tap to enlarge. */
function VibecodePhoto({ url }: { url?: string | null }) {
  const [open, setOpen] = useState(false);
  if (!url) return null;
  return (
    <>
      <Box
        as="button"
        display="block"
        ml="auto"
        mb={1.5}
        overflow="hidden"
        borderRadius="md"
        onClick={() => setOpen(true)}
        aria-label="Open attached photo"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- dynamic Convex storage URL */}
        <img
          src={url}
          alt="Uploaded image"
          style={{ maxWidth: "220px", maxHeight: "220px", display: "block" }}
        />
      </Box>
      {open && (
        <ImageLightbox
          src={url}
          alt="Uploaded image"
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

export function VibecodeWorkshop({
  sessionId,
  onOpenSidebar,
  onBackToChat,
  appId,
  onShowApp,
}: {
  sessionId: Id<"sessions">;
  /** The app to show — the one a chat app card's Open named (`?app=`).
   *  Absent or stale → the session's newest app. */
  appId?: string | null;
  /** Show a different app (replaces `?app=`) — used to follow a brand-new
   *  app the AI built while an older one was open. */
  onShowApp?: (appId: string) => void;
  onOpenSidebar?: () => void;
  /** Back to this session's chat — present only when the chat is the
   *  session's primary view and the builder was opened for its app. */
  onBackToChat?: () => void;
}) {
  const data = useQuery(api.sessions.getWithMessages, { id: sessionId });
  const artifacts = useQuery(api.artifacts.getBySession, { sessionId });
  const sendMsg = useMutation(api.sessions.sendMessage);
  const startAppUpdateTurn = useMutation(api.sessions.startAppUpdateTurn);
  const startActivityKickoff = useMutation(api.sessions.startActivityKickoff);
  const requestStop = useMutation(api.sessions.requestStop);
  const saveArtifact = useMutation(api.artifacts.scholarUpdate);
  const clearSessionState = useMutation(api.appStates.clearSessionState);
  const convex = useConvex();
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const answerRenderCheck = useMutation(api.sessions.answerRenderCheck);
  // App-designer version History — metadata only (html is fetched on Restore).
  // Fetched here (not only in the drawer) so the transcript can render inline
  // "vN · Restore" markers on the turns that produced a version (Ruling 9).
  const sessionRevisions = useQuery(
    api.codeArtifactRevisions.listForSession,
    { sessionId },
  );

  // A free-play session (TRA-489) carries "<activity>: Free play" as its title
  // for lists; the header shows the activity title under a "Free play" tag.
  const isFreePlay = data?.session?.freePlay === true;
  const sessionTitle = data?.session?.title ?? "Build";
  const title = isFreePlay
    ? sessionTitle.replace(/: Free play$/, "")
    : sessionTitle;
  const router = useRouter();
  const startFreePlay = useMutation(api.sessions.startFreePlay);
  const [startingFreePlay, setStartingFreePlay] = useState(false);
  const handleStartFreePlay = useCallback(async () => {
    setStartingFreePlay(true);
    try {
      const result = await startFreePlay({ sessionId });
      router.push(`/scholar/${result.sessionId}`);
    } catch {
      toaster.error({ title: "Couldn't start free play" });
      setStartingFreePlay(false);
    }
  }, [router, sessionId, startFreePlay]);
  // A teacher build hand-off drives the auto-kickoff, staged progress card, and
  // autosave-to-starter. `appRequest` (the activity's brief) is a separate
  // signal: it exists for coached scholar sessions too, and drives the brief
  // card + the default screen mode.
  const isBuildSession = data?.session?.teacherBuildKickoff === true;
  // `activityHasAppRequest` is the SAFE boolean projection (true for coached
  // scholar sessions too) that picks the default screen mode; `briefText` (the
  // actual brief) is teacher-build-only — never present for a scholar (F1).
  const activityHasAppRequest =
    (data?.session as { hasAppRequest?: boolean } | undefined)
      ?.hasAppRequest === true;
  const briefText =
    (data?.session as { appRequest?: string | null } | undefined)?.appRequest ??
    null;

  // The Edit | Play screen mode (review/teacher-build-flow.html §2/§4). The
  // policy is the SERVER's verdict (`effectiveEditAccess`, derived from the
  // activity's `editAccess`, the caller's role, and the scholar's completion)
  // — the client only renders it into the two booleans the bar needs, never
  // re-derives it. Computed early (before `onEvent`/`stream`, below) so the
  // stream's `workshopMode` clamp can call `setMode` without a forward
  // reference.
  // Until the session read resolves, render NO control: defaulting to
  // "allowed" would flash the Edit segment (and History) at a `never` scholar
  // on first paint.
  const effectiveEditAccess: EffectiveEditAccess = data?.session
    ? (data.session.effectiveEditAccess ?? "allowed")
    : "hidden";
  const { showControl: showModeControl, editUnlocked } = editControlFor(
    effectiveEditAccess,
  );
  // An app with a character opens the scholar in Play too, even without a
  // brief: in Edit the tutor hears none of the exchanges and shows no strip.
  // Only the scholar-facing artifact read carries `hasAppCharacter`, so a
  // teacher's own flows keep their default.
  const hasAppCharacter = (artifacts ?? []).some(
    (artifact) =>
      (artifact as { hasAppCharacter?: boolean }).hasAppCharacter === true,
  );
  const modeDefault = defaultWorkshopMode({
    teacherBuildKickoff: isBuildSession,
    hasAppRequest: activityHasAppRequest || hasAppCharacter,
    serverDefault: data?.session?.defaultWorkshopMode,
  });
  // The caller has Edit only because they are staff (scholars on this activity
  // play it, or edit only after finishing) — the server's verdict, TRA-477.
  const teacherEditOverride = data?.session?.teacherEditOverride === true;
  const [mode, setMode] = useWorkshopMode({
    fallback: modeDefault,
    editSelectable: editUnlocked,
  });
  const { user: currentUser, isLoading: currentUserLoading } =
    useCurrentUser();
  const isSessionOwner =
    !!data?.session &&
    !!currentUser &&
    String(data.session.userId) === String(currentUser._id);
  // The builder's done state (TRA-519 B2): once the activity is complete, the
  // parked ideas carry the done screen's Build it now + Make it a Quest,
  // instead of the generic Start free play. Owner only, never a rehearsal.
  const builderDone =
    isSessionOwner &&
    data?.session?.isTestDrive !== true &&
    data?.session?.activityCompletedAt != null;
  const doneIdeaActions = useSavedForLaterActions({
    sessionId,
    canBuildNow: data?.session?.freePlayEligible === true,
  });
  // One app surface (TRA-519): how this session relates to its app, from the
  // same shared derivation the server's prompt and tools use. The builder
  // STANCE (Edit | Play, designer and tutor threads) is only for a session
  // whose app is the work. A side app — one built beside a writing, slides
  // or map activity — keeps the tutor's stance: no mode control, one
  // unthreaded conversation, and the app stays editable with its History.
  const appContext = sessionAppContextFor({
    sessionMode: data?.session?.sessionMode,
    role: data?.session?.appRole ?? "work",
    hasApp: (artifacts ?? []).some((a) => a.type === "code"),
  });
  const builderStance = appContext.builderStance;
  // The mode the app pane renders in: the scholar's Edit | Play choice under
  // the builder stance; always editable for a side app.
  const surfaceMode: WorkshopMode = builderStance ? mode : "edit";
  // Whether the conversation on screen is the tutor's (Play, or any side app)
  // rather than the designer's.
  const tutorVoice = !builderStance || mode === "play";
  // A scholar who only plays this app sees the app and nothing else: no
  // "Reset app state" and no viewer chrome. Staff and a scholar building
  // their own app keep both; Reset stays owner-only (TRA-317, TRA-477).
  const { showResetAppState: canResetAppState, showViewerChrome } =
    playSurfaceFor({
      mode: surfaceMode,
      access: effectiveEditAccess,
      isStaff: isStaffRole(currentUser?.role),
      isSessionOwner,
    });
  // A POLICY-driven Edit → Play (the verdict flipped while this viewer was in
  // Edit) bypasses `handleModeChange`, the only path that flushes a pending
  // code draft before the viewer goes read-only. Flush here too, so the draft
  // is never stranded; a failed flush surfaces the same save-resolution toast.
  const editUnlockedRef = useRef(editUnlocked);
  useEffect(() => {
    const was = editUnlockedRef.current;
    editUnlockedRef.current = editUnlocked;
    if (was && !editUnlocked) {
      flushAllArtifactSaves().catch((error: unknown) => {
        console.error("[vibecode] draft flush on policy lock failed", error);
        toaster.error({
          title: "Finish saving your app",
          description:
            "Edit just locked with an unsaved change — reopen the app version to retry its save.",
        });
      });
    }
  }, [editUnlocked]);

  // Switching to Play makes the CodeArtifactViewer read-only (no `onSave`).
  // A pending Edit draft reaching that read-only viewer can strand the global
  // save drain (N1), so flush any pending draft through the still-live Edit
  // `onSave` BEFORE flipping the mode. If that flush FAILS (e.g. an unresolved
  // conflict or a network error), stay in Edit and surface the same
  // save-resolution error the tutor-send path uses — entering Play would let
  // the read-only viewer silently discard the teacher's unsaved edit.
  const handleModeChange = useCallback(
    (next: WorkshopMode) => {
      if (next !== "play") {
        setMode(next);
        return;
      }
      void switchToPlayMode({
        flush: flushAllArtifactSaves,
        setPlay: () => setMode("play"),
        onFlushError: (error) => {
          console.error("[vibecode] draft flush before Play failed", error);
          toaster.error({
            title: "Finish saving your app",
            description:
              "Choose an app version or retry its save before switching to Play.",
          });
        },
      });
    },
    [setMode],
  );

  // Present mode (showing the app to the class): the app's own container goes
  // full screen IN PLACE — moving an iframe in the DOM reloads it, so the
  // game keeps its state only because nothing is re-parented or remounted.
  // A pending code edit is flushed first, exactly as Edit → Play does, since
  // the viewer is read-only while presenting.
  const [presenting, setPresenting] = useState(false);
  const presentRef = useRef<HTMLDivElement>(null);
  const startPresenting = useCallback(() => {
    flushAllArtifactSaves().then(
      () => {
        setPresenting(true);
        if (presentRef.current) void enterFullscreen(presentRef.current);
      },
      (error: unknown) => {
        console.error("[vibecode] draft flush before Present failed", error);
        toaster.error({
          title: "Finish saving your app",
          description:
            "Choose an app version or retry its save before presenting.",
        });
      },
    );
  }, []);
  const stopPresenting = useCallback(() => {
    setPresenting(false);
    void exitFullscreen(document);
  }, []);
  useEffect(() => {
    if (!presenting) return;
    // Esc (or the browser's own exit) leaves full screen: end Present with it.
    const onFullscreenChange = () => {
      if (fullscreenElementOf(document) === null) setPresenting(false);
    };
    // Where the browser has no Fullscreen API, Present only covers the
    // window, so Esc has to be ours.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") stopPresenting();
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [presenting, stopPresenting]);

  const isNarrow = useBreakpointValue({ base: true, lg: false }) ?? false;
  // The chat pane is a toggle that starts closed (F14b), except beside a
  // Play-only character app the scholar is playing (`defaultChatOpen`). That
  // default is latched ONCE, when the session, artifact, and viewer reads
  // first resolve, so a later re-render never reopens a pane the scholar
  // closed; any toggle is the scholar's choice and wins from then on. A narrow
  // screen never auto-opens: its chat is a bottom drawer that covers the app.
  const [chatChoice, setChatChoice] = useState<boolean | null>(null);
  const [chatAutoOpen, setChatAutoOpen] = useState<boolean | null>(null);
  if (
    chatAutoOpen === null &&
    data !== undefined &&
    artifacts !== undefined &&
    !currentUserLoading
  ) {
    setChatAutoOpen(
      defaultChatOpen({
        access: effectiveEditAccess,
        hasAppCharacter,
        isSessionOwner,
        isTestDrive: data?.session?.isTestDrive === true,
      }),
    );
  }
  const chatOpen = chatChoice ?? (!isNarrow && chatAutoOpen === true);
  const setChatOpen = setChatChoice;
  // App-designer version History (Edit) and app-state Reset (Play).
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  // Bumping this remounts the app iframe, discarding runtime state — the
  // "Reset app state" action in Play (rebuilds the srcDoc from the current
  // revision).
  const [resetNonce, setResetNonce] = useState(0);
  // A coarse clock so the server-provided saved-at readout ages "just now" → a
  // wall time without calling Date.now() during render (impure).
  const [nowTick, setNowTick] = useState(0);
  const [input, setInput] = useState("");
  // Honest build progress: an ordered list of the stream signals that move the
  // build stage (see shared/buildStage.ts), plus when the current stream began.
  // Reset at each send so the card/line reflect the LIVE build, not a stale one.
  const [buildSignals, setBuildSignals] = useState<BuildSignal[]>([]);
  const [streamStartedAt, setStreamStartedAt] = useState<number | null>(null);
  const [openedAt] = useState(() => Date.now());
  // Reset the build signals at the start of each stream. `origin` anchors the
  // elapsed clock: the teacher build kickoff passes `openedAt` so the clock
  // measures one stable interval from when the build was first requested, even
  // across kickoff retries (the orphan-window wait, a re-launch). A genuinely
  // new build — a later user turn — passes nothing and starts a fresh clock.
  const resetBuildSignals = useCallback((origin?: number) => {
    setStreamStartedAt(origin ?? Date.now());
    setBuildSignals([{ type: "streamStart" }]);
  }, []);
  // True while a teacher build kickoff stream is being launched or a retry is
  // scheduled — keeps the live card up through the orphan-window wait / relaunch
  // so the settled state only appears once the build has truly stopped.
  const [buildLaunching, setBuildLaunching] = useState(false);
  const [sending, setSending] = useState(false);
  const [wantsComposerFocus, setWantsComposerFocus] = useState(false);
  const runWithSendLock = useSendLock();
  const threadRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // The composer's mic — the same recorder the main scholar chat uses
  // (SessionInterface): a take auto-sends as a "spoken" turn, which the tutor
  // sees labelled [Dictated …]. The prompt promises every scholar composer a
  // mic (convex/prompts.ts, "Saying it counts as writing it").
  const sendSpokenRef = useRef<(text: string) => void>(() => {});
  // A photo staged in the composer — the main chat's attach pipeline, so a
  // builder can hold up an example ("make the art look like this").
  const {
    pendingImage,
    setPendingImage,
    clear: clearPendingImage,
    upload: uploadPendingImage,
  } = usePendingImage();
  const dictation = useStreamingDictation(
    (text) => sendSpokenRef.current(text),
    sessionId,
  );
  const snapshotCaptureRef = useRef<CaptureAppSnapshot | null>(null);
  // The assistant row of an in-flight app-update turn (startAppUpdateTurn):
  // it stays invisible until the tutor actually says something.
  const [appUpdateMsgId, setAppUpdateMsgId] = useState<string | null>(null);
  const activeStreamIdRef = useRef<string | null>(null);
  const activeRenderCheckIdRef = useRef<string | null>(null);
  const artifactBeforeCodeToolRef = useRef<HtmlArtifactVersion | null>(null);
  const kickoffSessionRef = useRef<string | null>(null);
  const kickoffPendingRef = useRef(false);
  const kickoffRetryReadyRef = useRef(false);
  const kickoffManualRetryRef = useRef(false);
  const kickoffRetryCountRef = useRef(0);
  const kickoffRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [kickoffRetryNonce, bumpKickoffRetry] = useState(0);
  const [lastSentSnapshot, setLastSentSnapshot] = useState<{
    sessionId: Id<"sessions">;
    hash: string;
  } | null>(null);
  const handleSnapshotCaptureReady = useCallback(
    (capture: CaptureAppSnapshot | null) => {
      snapshotCaptureRef.current = capture;
    },
    [],
  );

  // Reactive: create_code inserts and edit_document updates both flow through
  // the same selector used by the rehearsal banner and native vendor copy.
  // The app the chat's card opened (`appId`), else the newest.
  const htmlArtifact = useMemo(
    () => builderHtmlArtifact(artifacts, appId),
    [artifacts, appId],
  );
  const htmlArtifactRef = useRef(htmlArtifact);
  useEffect(() => {
    htmlArtifactRef.current = htmlArtifact;
  }, [htmlArtifact]);
  // Pinned to an older app (`appId`) when the AI makes a brand-new one
  // (create_code): follow it, so the screen shows the app just built.
  const knownAppIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!artifacts) return;
    const fresh = newlyAddedHtmlApp(knownAppIdsRef.current, artifacts);
    knownAppIdsRef.current = htmlAppIds(artifacts);
    if (fresh && appId && String(fresh._id) !== appId) {
      onShowApp?.(String(fresh._id));
    }
  }, [artifacts, appId, onShowApp]);
  // Every turn this builder opens names the app on screen, so the designer
  // or tutor acts on THAT app, never a newer one (TRA-519). Read through the
  // ref so a send captured before a render still names the current app.
  const openAppArg = (): { appArtifactId?: Id<"artifacts"> } => {
    const app = htmlArtifactRef.current;
    return app ? { appArtifactId: app._id as Id<"artifacts"> } : {};
  };
  // A builder-primary session holding more than one app (a teacher's starter
  // plus one the designer made later) switches between them in the header;
  // a chat-primary session reaches each app through its chat card instead.
  // Empty for a single app: no switcher.
  const appChoices = useMemo(
    () => (onBackToChat ? [] : builderAppChoices(artifacts)),
    [onBackToChat, artifacts],
  );
  const openAppLabel =
    appChoices.find((c) => c.id === String(htmlArtifact?._id))?.label ??
    appChoices[appChoices.length - 1]?.label;
  // History and the inline version markers list only this app's versions: a
  // Restore writes into the app on screen.
  const revisions = useMemo(
    () => revisionsForApp(sessionRevisions, htmlArtifact?._id),
    [sessionRevisions, htmlArtifact?._id],
  );

  const waitForRenderedArtifact = useCallback(
    async (
      artifactId: string,
      baseline: HtmlArtifactVersion | null,
      checkId: string,
      deadlineAt: number,
    ) => {
      const deadline = Math.min(
        deadlineAt,
        performance.now() + RENDER_CHECK_ARTIFACT_WAIT_MS,
      );
      while (
        activeRenderCheckIdRef.current === checkId &&
        performance.now() < deadline
      ) {
        const current = htmlArtifactRef.current;
        const currentVersion = current
          ? {
              id: String(current._id),
              revision: current.revision ?? 0,
              content: current.content,
            }
          : null;
        const matchesArtifact = currentVersion?.id === artifactId;
        const hasExpectedVersion =
          matchesArtifact &&
          (!baseline ||
            baseline.id !== artifactId ||
            baseline.revision !== currentVersion.revision ||
            baseline.content !== currentVersion.content);
        if (hasExpectedVersion) {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() =>
              requestAnimationFrame(() => resolve()),
            ),
          );
          return true;
        }
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      return false;
    },
    [],
  );

  const handleRenderCheck = useCallback(
    async ({
      checkId,
      artifactId,
    }: {
      checkId: string;
      artifactId: string;
    }) => {
      const streamId = activeStreamIdRef.current;
      if (!streamId) return;
      const deadlineAt =
        performance.now() + RENDER_CHECK_CLIENT_BUDGET_MS;
      activeRenderCheckIdRef.current = checkId;
      const baseline = artifactBeforeCodeToolRef.current;
      const rendered = await waitForRenderedArtifact(
        artifactId,
        baseline,
        checkId,
        deadlineAt,
      );
      if (
        !rendered ||
        activeRenderCheckIdRef.current !== checkId ||
        activeStreamIdRef.current !== streamId
      ) {
        return;
      }

      let capture:
        | {
            storageId: Id<"_storage"> | null;
            hash: string | null;
            consoleLines: string[];
            stateJson: string;
          }
        | null = null;
      try {
        const captureSnapshot = snapshotCaptureRef.current;
        capture = await uploadChangedAppSnapshot({
          captureSnapshot,
          lastSentHash:
            lastSentSnapshot?.sessionId === sessionId
              ? lastSentSnapshot.hash
              : null,
          generateUploadUrl,
          force: true,
          afterLoad: renderCheckLoadBoundary(baseline, artifactId),
          deadlineAt,
          returnCaptureOnUploadSkip: true,
        });
      } catch (error) {
        console.error("[vibecode] render-check capture failed", error);
      }
      if (
        activeRenderCheckIdRef.current !== checkId ||
        activeStreamIdRef.current !== streamId
      ) {
        return;
      }
      if (capture?.storageId && capture.hash) {
        setLastSentSnapshot({ sessionId, hash: capture.hash });
      }
      try {
        await answerRenderCheck({
          sessionId,
          streamId,
          checkId,
          snapshotStorageId: capture?.storageId ?? undefined,
          consoleLines: capture?.consoleLines ?? [],
          stateJson: capture?.stateJson ?? "{}",
        });
        setBuildSignals((prev) => [...prev, { type: "renderCheckAnswered" }]);
      } catch (error) {
        console.error("[vibecode] render-check answer failed", error);
      } finally {
        if (activeRenderCheckIdRef.current === checkId) {
          activeRenderCheckIdRef.current = null;
        }
      }
    },
    [
      answerRenderCheck,
      generateUploadUrl,
      lastSentSnapshot,
      sessionId,
      waitForRenderedArtifact,
    ],
  );

  const onEvent = useCallback(
    (ev: StreamEvent) => {
      const renderCheck = (
        ev as StreamEvent & {
          renderCheck?: { checkId: string; artifactId: string };
        }
      ).renderCheck;
      if (ev.toolStart?.name && CODE_TOOLS.has(ev.toolStart.name)) {
        const toolName = ev.toolStart.name;
        setBuildSignals((prev) => [
          ...prev,
          { type: "codeToolStart", name: toolName },
        ]);
        const current = htmlArtifactRef.current;
        artifactBeforeCodeToolRef.current = current
          ? {
              id: String(current._id),
              revision: current.revision ?? 0,
              content: current.content,
              loadBoundary:
                snapshotCaptureRef.current?.currentLoadBoundary() ?? null,
            }
          : null;
      }
      if (renderCheck) {
        setBuildSignals((prev) => [...prev, { type: "renderCheck" }]);
        void handleRenderCheck(renderCheck);
      }
      if (ev.toolComplete?.name && CODE_TOOLS.has(ev.toolComplete.name)) {
        const toolName = ev.toolComplete.name;
        setBuildSignals((prev) => [
          ...prev,
          { type: "codeToolComplete", name: toolName },
        ]);
      }
      if (ev.done || ev.error) {
        setBuildSignals((prev) => [
          ...prev,
          { type: ev.error ? "error" : "done" },
        ]);
        activeRenderCheckIdRef.current = null;
      }
      // The server clamped a requested Edit to Play (the verdict changed
      // between the mutation and the stream, e.g. a completion landed
      // mid-turn) — follow it so the client's mode matches what actually ran.
      if (ev.workshopMode === "play" && mode === "edit") setMode("play");
    },
    [handleRenderCheck, mode, setMode],
  );
  const stream = useAgentStream({ onEvent });
  const {
    streamingContent,
    streamingMsgId,
    isStreaming,
    send: sendStream,
  } = stream;

  // The session's deliverable, resolved and submitted exactly as the chat
  // view does it (hooks/useSessionDeliverable.ts, TRA-519).
  const deliverable = useSessionDeliverable({
    sessionId,
    session: data?.session,
  });
  const deliverableSpec = deliverable.activity?.deliverable ?? null;
  // A side app's header reports the real work's progress. A photo (or any
  // handed-in file) lives on the deliverable row, not as an artifact, so the
  // row counts as work too — as the native builder reads it
  // (native/src/components/vibecode/useBuilderDeliverable.ts).
  const sideWorkActivityId =
    appContext.role === "side" &&
    deliverableSpec &&
    deliverableSpec.kind !== "artifact"
      ? data?.session?.activityId
      : undefined;
  const sideWorkRow = useQuery(
    api.deliverables.getForSessionActivity,
    sideWorkActivityId
      ? { sessionId, activityId: sideWorkActivityId as Id<"activities"> }
      : "skip",
  );
  const [yourWorkOpen, setYourWorkOpen] = useState(false);
  const isAiCheckingRubric =
    isStreaming &&
    stream.toolActivity.some(
      (t) => t.name === "update_rubric_score" && t.status === "running",
    );
  // Check my work / Send: submit the work, then stream the rubric-check turn
  // the server opened (no user message is persisted for it). The lock guards
  // only the preparation, as it does for a send, so a steer can follow.
  const handleSubmitWork = async (
    artifact: { _id: string; title: string },
    shouldCheck: boolean,
  ): Promise<void> => {
    if (isStreaming || buildLaunching) return;
    const prepared = await runWithSendLock(() =>
      deliverable.prepareSubmit({
        artifactId: artifact._id as Id<"artifacts">,
        shouldCheck,
        // The check is a turn of the mode on screen (a side app has none).
        ...(builderStance ? { mode } : {}),
        ...openAppArg(),
      }),
    );
    if (!prepared) return;
    activeStreamIdRef.current = prepared.streamId;
    try {
      await sendStream(
        `${convexSiteUrl()}/session-stream`,
        {
          sessionId: prepared.sessionId,
          streamId: prepared.streamId,
          assistantMsgId: prepared.assistantMsgId,
          platform: "web",
          supportsRenderCheck: true,
          rubricCheck: { artifactTitle: artifact.title },
        },
        prepared.assistantMsgId,
      );
    } catch (error) {
      console.error("[vibecode] rubric check stream failed", error);
    } finally {
      if (activeStreamIdRef.current === prepared.streamId) {
        activeStreamIdRef.current = null;
      }
      activeRenderCheckIdRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      if (kickoffRetryTimerRef.current) {
        clearTimeout(kickoffRetryTimerRef.current);
      }
    };
  }, []);

  // Coarse clock for the saved-at readout (see nowTick). The first tick is
  // scheduled async (not a synchronous setState in the effect body).
  useEffect(() => {
    const first = setTimeout(() => setNowTick(Date.now()), 0);
    const id = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    if (
      !data ||
      isStreaming ||
      kickoffPendingRef.current ||
      data.session.isTestDrive !== true ||
      data.session.teacherBuildKickoff !== true
    ) {
      return;
    }

    const sessionKey = String(sessionId);
    // Unfiltered by thread deliberately: this recovery check is about whether
    // the KICKOFF ITSELF landed a placeholder, before any thread split matters.
    const hasNoMessages = data.messages.length === 0;
    const activeKickoffPlaceholder =
      data.messages.length === 1 &&
      data.messages[0].role === "assistant" &&
      data.messages[0].content.trim() === "" &&
      !!data.messages[0].streamId &&
      data.messages[0].streamTrigger === "activityKickoff";
    const startingFresh =
      hasNoMessages && kickoffSessionRef.current !== sessionKey;
    const retrying =
      kickoffSessionRef.current === sessionKey &&
      kickoffRetryReadyRef.current &&
      (hasNoMessages || activeKickoffPlaceholder || kickoffManualRetryRef.current);
    if (!startingFresh && !retrying) return;

    if (startingFresh) {
      kickoffRetryCountRef.current = 0;
    }
    kickoffManualRetryRef.current = false;
    kickoffSessionRef.current = sessionKey;
    kickoffPendingRef.current = true;
    kickoffRetryReadyRef.current = false;
    setBuildLaunching(true);
    if (kickoffRetryTimerRef.current) {
      clearTimeout(kickoffRetryTimerRef.current);
    }

    // Deferred so useAgentStream's state updates do not run synchronously in
    // the effect body. The refs above make the launch one-shot per session.
    kickoffRetryTimerRef.current = setTimeout(() => {
      kickoffRetryTimerRef.current = null;
      if (kickoffSessionRef.current !== sessionKey) {
        kickoffPendingRef.current = false;
        setBuildLaunching(false);
        return;
      }
      const scheduleRetry = (delayMs: number, countFailure: boolean) => {
        if (countFailure) {
          if (kickoffRetryCountRef.current >= 1) {
            // Retries exhausted — let the build settle into the stopped state.
            setBuildLaunching(false);
            return;
          }
          kickoffRetryCountRef.current += 1;
        }
        setBuildLaunching(true);
        kickoffRetryTimerRef.current = setTimeout(() => {
          kickoffRetryTimerRef.current = null;
          if (kickoffSessionRef.current !== sessionKey) return;
          kickoffRetryReadyRef.current = true;
          bumpKickoffRetry((count) => count + 1);
        }, delayMs);
      };

      void (async () => {
        let kickoffStreamId: string | null = null;
        try {
          const result = await startActivityKickoff({ sessionId });
          if (!result) {
            // Nothing recoverable to relaunch (e.g. a non-empty placeholder) —
            // settle rather than keep a live card ticking forever.
            setBuildLaunching(false);
            return;
          }
          if (result.status === "pending") {
            scheduleRetry(result.retryAfterMs + 50, false);
            return;
          }
          kickoffStreamId = result.streamId;
          activeStreamIdRef.current = result.streamId;
          resetBuildSignals(openedAt);
          const completed = await sendStream(
            `${convexSiteUrl()}/session-stream`,
            {
              sessionId: result.sessionId,
              streamId: result.streamId,
              assistantMsgId: result.assistantMsgId,
              platform: "web",
              supportsRenderCheck: true,
              kickoff: true,
              // The teacher build kickoff builds the app — always Edit.
              mode: "edit",
            },
            result.assistantMsgId,
          );
          if (!completed) {
            // A dropped fetch (no user stop) — retry once, then settle.
            scheduleRetry(1_000, true);
          } else {
            // The stream ended (finished, or a user Stop that keeps the partial
            // text). It is no longer live, so let the preview settle: an app →
            // the live app, no app → the stopped recovery card.
            setBuildLaunching(false);
          }
        } catch (error) {
          console.error("[vibecode] teacher build kickoff failed", error);
          scheduleRetry(1_000, true);
        } finally {
          if (activeStreamIdRef.current === kickoffStreamId) {
            activeStreamIdRef.current = null;
            activeRenderCheckIdRef.current = null;
          }
          kickoffPendingRef.current = false;
        }
      })();
    }, 0);
  }, [data, isStreaming, sendStream, sessionId, startActivityKickoff, resetBuildSignals, openedAt, kickoffRetryNonce]);

  const buildStage = useMemo(
    () => deriveBuildStage(buildSignals),
    [buildSignals],
  );
  const buildStartedAt = streamStartedAt ?? openedAt;
  // The designer's turns are builds. A side app's tutor turn becomes one only
  // once it starts writing the app.
  const showBuildStages = builderStance
    ? mode === "edit"
    : buildSignals.some((signal) => signal.type === "codeToolStart");
  const htmlArtifactPresent = !!htmlArtifact;
  // What the preview pane shows, derived from the LIVE build signals (never the
  // durable teacherBuildKickoff alone): a stopped/errored first build with no
  // artifact settles into a recovery card instead of a card that ticks forever.
  const buildPreview = deriveBuildPreview({
    hasArtifact: htmlArtifactPresent,
    isStreaming,
    launching: buildLaunching,
    hasBuildRequest: isBuildSession,
    buildStarted: streamStartedAt !== null,
    ended: buildStage.ended,
  });

  // Autosave + version history now run SERVER-SIDE at the end of each designer
  // turn (convex/http.ts) — a closed tab, a native build, or an aide write can
  // no longer drop a version or a save (F3/F4/F11). The Workshop only READS the
  // results: `starterSavedAt` (from customApps.updatedAt, the server clock) and
  // an autosave-failure signal it surfaces as a toast.
  const savedAt =
    (data?.session as { starterSavedAt?: number | null } | undefined)
      ?.starterSavedAt ?? null;
  const autosaveFailedAt =
    (data?.session as { appAutosaveFailedAt?: number | null } | undefined)
      ?.appAutosaveFailedAt ?? null;
  const autosaveFailInitRef = useRef(false);
  const lastAutosaveFailShownRef = useRef<number | null>(null);
  useEffect(() => {
    // Skip the value present on first load; only toast a NEW failure so a stale
    // marker doesn't nag on every mount.
    if (!autosaveFailInitRef.current) {
      autosaveFailInitRef.current = true;
      lastAutosaveFailShownRef.current = autosaveFailedAt;
      return;
    }
    if (
      autosaveFailedAt != null &&
      lastAutosaveFailShownRef.current !== autosaveFailedAt
    ) {
      lastAutosaveFailShownRef.current = autosaveFailedAt;
      toaster.error({
        title: "Couldn't save the latest app to the activity starter",
        description: "Send another message to retry the save.",
      });
    }
  }, [autosaveFailedAt]);

  const messages: VibecodeMessage[] = (data?.messages ?? [])
    .filter((m) => (m as { notebookEntry?: unknown }).notebookEntry === undefined)
    .filter((m) => m.role === "user" || m.role === "assistant")
    .filter((m) => m.content !== OPENER)
    // Two threads, one session (TRA-301): Edit shows designer turns, Play
    // shows tutor turns — never both interleaved. An unstamped legacy turn
    // (pre-`thread`) stays visible in BOTH so flipping a live activity to
    // `never` never disappears a scholar's earlier turns (see
    // messageVisibleInMode). A side app has one conversation, unfiltered.
    .filter((m) => !builderStance || messageVisibleInMode(m, mode))
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      stopRequestedAt: m.stopRequestedAt,
      appSnapshotUrl: m.appSnapshotUrl,
      imageUrl: m.imageUrl,
      inputModality: m.inputModality,
      createdAt: m.createdAt,
    }));
  const reconciledMessages = useReconciledSessionMessages({
    messages,
    streamingMsgId,
    streamingContent,
  });
  // Staff reading a scholar's session see the app's in-app AI turns inline in
  // the Play (tutor) thread. Never the owner's view: the app already shows
  // the scholar the scene.
  const appAiTurns = useQuery(
    api.appAi.listForSession,
    !isSessionOwner && !!htmlArtifact && isTeacherRole(currentUser?.role)
      ? { sessionId }
      : "skip",
  );
  const appCharacterNames = useMemo(
    () => appCharacterNamesFrom(artifacts ?? []),
    [artifacts],
  );
  const threadItems = interleaveAppAiTurns(
    reconciledMessages,
    tutorVoice ? (appAiTurns ?? []) : [],
    (item) => item.message.createdAt,
  );

  // The tutor's newest line while the chat is closed (Play's thread, read
  // whatever the current mode, so flipping modes never reads as a new line).
  const tutorLine = useUnreadTutorLine({
    messages: (data?.messages ?? []).filter(
      (m) => m.role === "assistant" && messageVisibleInMode(m, "play"),
    ),
    loaded: data !== undefined,
    chatOpen,
    streaming: isStreaming,
  });

  // Keep the thread pinned to the newest turn as content streams in.
  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [messages.length, streamingContent, isStreaming]);

  useEffect(() => {
    if (!chatOpen || !wantsComposerFocus) return;
    const frame = requestAnimationFrame(() => {
      composerRef.current?.focus();
      setWantsComposerFocus(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [chatOpen, wantsComposerFocus]);

  // Inline version markers (Ruling 9): map each producing assistant message to
  // the version it created, so the designer turn renders "vN · Restore" — the
  // SAME dense numbers History shows. The newest revision (index 0, newest
  // first) is the current version and shows "vN · current" with no Restore.
  const revisionByMessageId = useMemo(() => {
    const map = new Map<
      string,
      { id: string; version: number; revision: number; isCurrent: boolean }
    >();
    (revisions ?? []).forEach((rev, index) => {
      if (rev.messageId) {
        map.set(rev.messageId, {
          id: rev.id,
          version: rev.version,
          revision: rev.revision,
          isCurrent: index === 0,
        });
      }
    });
    return map;
  }, [revisions]);

  // `appUpdate` turns are opened by the app-update queue (useAppTutorUpdates),
  // which only calls this while no reply is streaming; it learns the mutation's
  // outcome through `onPrepared` and the stream continues on its own.
  const sendTutorTurn = async (
    text: string,
    appUpdate?: {
      batch: AppTutorUpdateBatch;
      onPrepared: (result: AppTutorSendResult) => void;
    },
    inputModality: "typed" | "spoken" = "typed",
  ): Promise<boolean> => {
    // A staged photo rides the scholar's own turn, typed or spoken, and may be
    // sent alone. An app update is the app talking, never the scholar's photo.
    const withImage = !appUpdate && !!pendingImage;
    if (!text && !appUpdate && !withImage) return false;
    const appContext = appUpdate
      ? newestAppTutorAskContext(appUpdate.batch)
      : undefined;
    // An app update is play: the server opens it in the tutor thread whatever
    // the screen shows, so it never snaps an Edit-mode screen to Play. A side
    // app has no threads, so its turns carry no mode at all.
    const turnMode = !builderStance ? undefined : appUpdate ? "play" : mode;
    // Steering: sending while a reply streams stops it (server loop + local
    // fetch) and replaces it with this turn. Stop BEFORE the lock — the
    // aborted stream runs outside the lock, so this turn can acquire it.
    if (isStreaming && !appUpdate) {
      void requestStop({ sessionId });
      void stream.stop();
    }
    // The lock guards only the artifact flush + message insert, not the whole
    // stream, so a later steer can always acquire it.
    const prepared = await runWithSendLock(async () => {
      try {
        await flushAllArtifactSaves();
      } catch (error) {
        console.error("[vibecode] document save blocked send", error);
        // A background app update stays queued and retries; only the
        // scholar's own send needs telling.
        if (!appUpdate) {
          toaster.error({
            title: "Finish saving your app",
            description:
              "Choose an app version or retry its save before sending your message.",
          });
        }
        return null;
      }
      if (appUpdate) {
        try {
          const result = await startAppUpdateTurn({
            sessionId,
            asks: appUpdate.batch.asks,
            ...openAppArg(),
          });
          appUpdate.onPrepared(appTutorSendResultFromStatus(result.status));
          return result.status === "started" ? result : null;
        } catch {
          appUpdate.onPrepared("failed");
          return null;
        }
      }
      let imageId: Id<"_storage"> | null = null;
      if (withImage) {
        try {
          imageId = await uploadPendingImage();
        } catch (error) {
          console.error("[vibecode] photo upload failed", error);
          toaster.error({
            title: "Couldn't add that photo",
            description: "Please try again.",
          });
          return null;
        }
      }
      try {
        const result = await sendMsg({
          sessionId,
          message: text,
          ...(imageId ? { imageId } : {}),
          inputModality,
          ...(builderStance ? { mode } : {}),
          ...openAppArg(),
        });
        // The server clamped a requested Edit to Play (policy): the turn is
        // already in the tutor thread, so snap NOW rather than waiting for the
        // stream, which may never open (a 429/403 returns before any event).
        if (result.workshopMode === "play" && mode === "edit") setMode("play");
        // A dictated turn never touches the box: whatever is typed there stays.
        if (inputModality === "typed") setInput("");
        // The photo is persisted with this turn; only now is it safe to drop.
        if (imageId) clearPendingImage();
        return result;
      } catch (error) {
        console.error("[vibecode] send failed", error);
        // A deliberate refusal (a locked Quest build step) says why.
        const refusal = serverRefusal(error);
        if (refusal) toaster.error({ title: "Couldn't send", description: refusal });
        return null;
      }
    });

    if (!prepared) return false;

    let appSnapshot:
      | { storageId: Id<"_storage">; hash: string }
      | null = null;
    // A character-only update adds no user row, so a snapshot would land on
    // the scholar's last typed message instead: send none.
    if (!appUpdate || appUpdate.batch.asks.length > 0) {
      try {
        appSnapshot = await uploadChangedAppSnapshot({
          captureSnapshot: snapshotCaptureRef.current,
          lastSentHash:
            lastSentSnapshot?.sessionId === sessionId
              ? lastSentSnapshot.hash
              : null,
          generateUploadUrl,
        });
      } catch (error) {
        console.error("[vibecode] app snapshot upload failed", error);
      }
    }

    try {
      setSending(true);
      if (appSnapshot?.storageId && appSnapshot.hash) {
        setLastSentSnapshot({ sessionId, hash: appSnapshot.hash });
      }
      activeStreamIdRef.current = prepared.streamId;
      if (appUpdate) setAppUpdateMsgId(prepared.assistantMsgId);
      else resetBuildSignals();
      await stream.send(
        `${convexSiteUrl()}/session-stream`,
        {
          sessionId: prepared.sessionId,
          streamId: prepared.streamId,
          assistantMsgId: prepared.assistantMsgId,
          supportsRenderCheck: true,
          ...(turnMode ? { mode: turnMode } : {}),
          ...(appUpdate && appUpdate.batch.asks.length > 0
            ? {
                appRequest: {
                  ...(appContext ? { context: appContext } : {}),
                },
              }
            : {}),
          ...(appSnapshot?.storageId
            ? { appSnapshotStorageId: appSnapshot.storageId }
            : {}),
        },
        prepared.assistantMsgId,
      );
    } catch (error) {
      console.error("[vibecode] stream failed", error);
    } finally {
      if (activeStreamIdRef.current === prepared.streamId) {
        activeStreamIdRef.current = null;
      }
      activeRenderCheckIdRef.current = null;
      if (appUpdate) setAppUpdateMsgId(null);
      setSending(false);
    }
    return true;
  };

  // App → tutor updates (asks and character/judge events) wait in one queue
  // and go out between replies. Only the owner drains: a teacher reading this
  // session remotely hosts the same app but must not start the scholar's turns.
  const appTutorUpdates = useAppTutorUpdates({
    sessionId,
    enabled: isSessionOwner,
    busy: isStreaming || sending || buildLaunching,
    send: (batch) =>
      settleAppTutorSend((onPrepared) =>
        sendTutorTurn("", { batch, onPrepared }),
      ),
  });
  // An app-update turn stays invisible until the tutor speaks — and in Edit
  // its reply lands in the (hidden) tutor thread, so it stays invisible there.
  const quietTurn =
    isStreaming &&
    appUpdateMsgId !== null &&
    streamingMsgId === appUpdateMsgId &&
    ((builderStance && mode === "edit") || !streamingContent.trim());

  const handleSend = () => {
    appTutorUpdates.clearAppAi();
    tutorLine.markRead();
    return sendTutorTurn(input.trim());
  };
  const handleSendSpoken = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    appTutorUpdates.clearAppAi();
    tutorLine.markRead();
    void sendTutorTurn(trimmed, undefined, "spoken");
  };
  // eslint-disable-next-line react-hooks/refs -- the dictation callback reads the latest send
  sendSpokenRef.current = handleSendSpoken;
  // Talking to the app's character is the scholar carrying on: the tutor's
  // last line has had its moment and must not come back after the update
  // turn this queues (which may well end in silence).
  const handleAppAiTurn = () => {
    tutorLine.markRead();
    appTutorUpdates.onAppAiTurn();
  };
  const handleAppTutorAsk = (request: AppTutorRequest) => {
    tutorLine.markRead();
    appTutorUpdates.onAskTutor(request);
    // In Edit the ask still goes to the tutor, whose reply lands in the hidden
    // Play thread — say so, or a builder testing a hint button sees nothing.
    // A fixed id keeps repeated taps to one toast.
    if (builderStance && mode === "edit" && isSessionOwner) {
      toaster.create({
        id: "workshop-edit-ask",
        type: "info",
        title: EDIT_MODE_ASK_NOTICE,
      });
    }
  };

  // The composer's Stop control: stop the server loop AND abort the local
  // fetch, keeping the partial text on screen.
  const handleStop = () => {
    activeRenderCheckIdRef.current = null;
    void requestStop({ sessionId });
    void stream.stop();
  };

  // The settled recovery card's "Try again": re-run the SAME teacher-build
  // kickoff via its existing retry machinery (not a second launcher). Arm a
  // fresh retry budget and nudge the kickoff effect to relaunch.
  const handleRetryBuild = useCallback(() => {
    if (kickoffRetryTimerRef.current) {
      clearTimeout(kickoffRetryTimerRef.current);
      kickoffRetryTimerRef.current = null;
    }
    kickoffRetryCountRef.current = 0;
    kickoffPendingRef.current = false;
    kickoffManualRetryRef.current = true;
    kickoffRetryReadyRef.current = true;
    setBuildLaunching(true);
    bumpKickoffRetry((count) => count + 1);
  }, []);

  // History / inline marker → Restore: fetch the chosen revision's html on
  // click (listForSession no longer ships html — F5), then roll it forward as
  // a NEW revision through the existing artifact-update mutation, stamped with
  // `restoredFromRevision` so History labels it as a restore (F13). On a
  // teacher build session the server (`artifacts.scholarUpdate`) autosaves the
  // rolled-forward app to the activity starter (G3).
  const handleRestore = useCallback(
    async (target: { id: string; version: number }) => {
      const current = htmlArtifactRef.current;
      if (!current || restoring) return;
      setRestoring(true);
      try {
        const fetched = await convex.query(
          api.codeArtifactRevisions.getRevisionHtml,
          { revisionId: target.id as Id<"codeArtifactRevisions"> },
        );
        if (!fetched) {
          toaster.error({ title: "Couldn't restore that revision" });
          return;
        }
        const result = await saveArtifact({
          artifactId: current._id,
          content: fetched.html,
          baseRevision: current.revision ?? 0,
          restoredFromRevision: target.version,
        });
        // scholarUpdate does NOT throw on a stale base revision — it returns
        // {ok:false, conflict:true} and no-ops. Surface that instead of
        // silently closing the drawer on a success path (F7).
        if (result.ok === false) {
          toaster.error({
            title: "The app changed — reopen History and try again",
          });
          return;
        }
        setHistoryOpen(false);
      } catch (error) {
        console.error("[vibecode] restore failed", error);
        toaster.error({ title: "Couldn't restore that revision" });
      } finally {
        setRestoring(false);
      }
    },
    [restoring, saveArtifact, convex],
  );

  // Play → Reset app state: clear the SERVER-persisted app-state document
  // first (the host re-posts it after every iframe reload, so a bare remount
  // would come straight back to the same state — F10), then remount the iframe
  // to rebuild the current revision's srcDoc from a clean slate.
  const handleResetAppState = useCallback(async () => {
    const current = htmlArtifactRef.current;
    if (current) {
      try {
        await clearSessionState({ artifactId: current._id });
      } catch (error) {
        console.error("[vibecode] reset app state failed", error);
        toaster.error({ title: "Couldn't reset the app state" });
        return;
      }
    }
    setResetNonce((nonce) => nonce + 1);
  }, [clearSessionState]);

  if (data === undefined) {
    return (
      <Flex
        flex={1}
        align="center"
        justify="center"
        bg="gray.50"
        role="status"
        aria-label="Loading the workshop"
      >
        <Spinner size="xl" color="violet.500" />
      </Flex>
    );
  }

  // Your work: everything the session holds besides its app — the drawer
  // hosts the chat's own document panel for it.
  const workArtifacts = (artifacts ?? []).filter((a) => a.type !== "code");
  const workKind = deliverableSpec?.kind ?? null;
  // A side app's header names the activity's real work and how far along it
  // is; the label is also the way into it, so it replaces the plain button.
  const workStatus =
    appContext.role === "side" && workKind && workKind !== "artifact"
      ? deliverableStatusFor({
          completed: data.session.activityCompletedAt != null,
          hasWork:
            !!sideWorkRow ||
            workArtifacts.some((a) => countsAsWork(a, workKind)),
        })
      : null;
  const showYourWork = workStatus !== null || workArtifacts.length > 0;
  // When the app IS the deliverable, its Check my work and flair sit under
  // the app. Any other deliverable is checked in Your work. Free play has no
  // deliverable to submit (the server refuses it), so it shows neither.
  const appDeliverableContext =
    builderStance && !isFreePlay && workKind === "artifact" && htmlArtifact
      ? deliverable.deliverableContext
      : undefined;

  const sttEnabled = currentUser?.sttEnabled !== false;
  const isRecording = dictation.state === "recording";
  // Tapped but audio not flowing yet: the take exists (cancel, read-only box)
  // but nothing may claim to listen.
  const isConnecting = dictation.state === "connecting";
  const inTake = isRecording || isConnecting;
  const composerPlaceholder = !tutorVoice
    ? "Tell the designer what to change…"
    : "Talk to the tutor…";
  const emptyHint = !tutorVoice
    ? "Describe the app you want to build — the designer writes it and you iterate."
      : "Talk to the tutor about the app.";
  // The brief — a muted first card in the designer thread (Edit only), rendered
  // client-side from the activity's appRequest. Never a persisted message.
  const briefCard =
    surfaceMode === "edit" && briefText ? (
      <Box
        borderRadius="lg"
        borderWidth="1px"
        borderColor="gray.200"
        bg="gray.50"
        px={3.5}
        py={3}
      >
        <Text
          fontSize="2xs"
          fontFamily="heading"
          fontWeight="700"
          letterSpacing="0.06em"
          color="charcoal.400"
          textTransform="uppercase"
          mb={1}
        >
          The brief
        </Text>
        <Text fontSize="sm" color="charcoal.600" whiteSpace="pre-wrap">
          {briefText}
        </Text>
      </Box>
    ) : null;

  const thread = (
    <Flex flexDir="column" h="100%" minH={0}>
      <Box ref={threadRef} flex={1} minH={0} overflowY="auto" px={4} py={4}>
        <VStack align="stretch" gap={3}>
          {briefCard}
          {/* Count what the thread draws: a quiet app-update turn's empty
              placeholder is no message, and its stream no reply. */}
          {reconciledMessages.length === 0 &&
            (!isStreaming || quietTurn) &&
            !briefCard && (
            <Text fontSize="sm" fontFamily="heading" color="charcoal.400" px={1}>
              {emptyHint}
            </Text>
          )}
          {threadItems.map((entry) => {
              if (entry.kind === "appAi") {
                return (
                  <AppAiTurnRow
                    key={`app-ai-${entry.turn._id}`}
                    turn={entry.turn}
                    characterNames={appCharacterNames}
                  />
                );
              }
              const { message: m, isActiveStream } = entry.item;
              return m.role === "user" ? (
                <Flex key={m.id} justify="flex-end">
                  <Box
                    maxW="85%"
                    bg="navy.500"
                    color="white"
                    px={3.5}
                    py={2}
                    borderRadius="lg"
                    borderBottomRightRadius="sm"
                    fontSize="sm"
                    whiteSpace="pre-wrap"
                    wordBreak="break-word"
                  >
                    <VibecodeAppSnapshot url={m.appSnapshotUrl} />
                    <VibecodePhoto url={m.imageUrl} />
                    {m.inputModality === "app" && (
                      <SessionInputModality modality="app" />
                    )}
                    {m.content}
                  </Box>
                </Flex>
              ) : (
                <Box key={m.id} px={1} color="charcoal.600">
                  <SessionAssistantMessageBody
                    content={m.content}
                    isStreaming={isActiveStream && !!streamingContent}
                    fontSize="sm"
                    stopRequestedAt={m.stopRequestedAt}
                  />
                  {(() => {
                    // Inline version marker on the turn that produced a
                    // revision (Edit only) — "vN · Restore", or "vN · current"
                    // on the newest with no Restore (Ruling 9).
                    if (surfaceMode !== "edit") return null;
                    const marker = revisionByMessageId.get(m.id);
                    if (!marker) return null;
                    return (
                      <Flex align="center" gap={1} mt={1}>
                        <Text
                          fontSize="2xs"
                          fontFamily="heading"
                          color="charcoal.400"
                        >
                          {`v${marker.version} · ${
                            marker.isCurrent ? "current" : ""
                          }`}
                        </Text>
                        {!marker.isCurrent && (
                          <Button
                            variant="plain"
                            height="auto"
                            minW={0}
                            p={0}
                            fontSize="2xs"
                            fontFamily="heading"
                            fontWeight="600"
                            color="violet.500"
                            disabled={restoring}
                            _hover={{ textDecoration: "underline" }}
                            onClick={() =>
                              void handleRestore({
                                id: marker.id,
                                version: marker.version,
                              })
                            }
                          >
                            Restore
                          </Button>
                        )}
                      </Flex>
                    );
                  })()}
                </Box>
              );
            })}
            {isStreaming && !quietTurn &&
              (!showBuildStages ? (
                // The tutor's turn: a question is not a build, so the build
                // stages ("Planning the app") would be a seam here.
                <Flex align="center" gap={2} alignSelf="flex-start" role="status">
                  <Spinner size="xs" color="violet.500" />
                  <Text fontSize="sm" fontFamily="heading" color="charcoal.400">
                    Thinking…
                  </Text>
                </Flex>
              ) : (
                <BuildProgress
                  variant="line"
                  stage={buildStage.stage}
                  startedAt={buildStartedAt}
                />
              ))}
          </VStack>
      </Box>

      {/* In free play the designer offers the parked ideas in chat instead. */}
      {!isFreePlay && (
        <ParkingLot
          ideas={data?.session?.parkingLot}
          onStartFreePlay={
            data?.session?.freePlayEligible ? handleStartFreePlay : undefined
          }
          startingFreePlay={startingFreePlay}
          renderActions={builderDone ? doneIdeaActions.renderActions : undefined}
        />
      )}
      {!isFreePlay && builderDone ? doneIdeaActions.dialog : null}

      {pendingImage && (
        <Flex px={3} pt={3} borderTop="1px solid" borderColor="gray.200">
          <Box position="relative" borderRadius="lg" overflow="hidden">
            {/* eslint-disable-next-line @next/next/no-img-element -- dynamic blob preview; next/image can't optimize it */}
            <img
              src={pendingImage.preview}
              alt="Upload preview"
              style={{ maxHeight: "96px", objectFit: "cover", display: "block" }}
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
              onClick={clearPendingImage}
            >
              <X size={12} />
            </IconButton>
          </Box>
        </Flex>
      )}
      <Flex
        px={3}
        py={3}
        gap={2}
        align="flex-end"
        borderTop={pendingImage ? undefined : "1px solid"}
        borderColor="gray.200"
        flexShrink={0}
      >
        {!inTake && (
          // The main chat's attach control: Take Photo, Quick Sketch, Upload
          // File — e.g. an example picture for "make the art look like this".
          // A narrow pane, so the camera covers the whole window.
          <ComposerAttachMenu
            onPick={(img) => setPendingImage(img)}
            overlayPosition="fixed"
          />
        )}
        {inTake && (
          // Cancel the take — discard the audio, nothing sends (main chat's X).
          <IconButton
            aria-label="Cancel recording"
            variant="ghost"
            color="charcoal.400"
            _hover={{ bg: "red.50" }}
            borderRadius="full"
            size="lg"
            onClick={dictation.cancelRecording}
          >
            <X />
          </IconButton>
        )}
        <Textarea
          ref={composerRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (inTake) return;
              void handleSend();
            }
          }}
          placeholder={
            isConnecting
              ? DICTATION_CONNECTING_LABEL
              : isRecording
                ? "Listening…"
                : composerPlaceholder
          }
          readOnly={inTake}
          rows={1}
          resize="none"
          fontSize="sm"
          maxH="120px"
          minH="48px"
          px={4}
          py={3}
          // Rounded corners, matching the main chat's composer field (Andy,
          // 2026-10-12: "match main").
          borderRadius="xl"
          bg={isRecording ? "red.50" : "white"}
          border="0.5px solid"
          borderColor={isRecording ? "red.300" : "gray.400"}
          _focus={{ borderColor: isRecording ? "red.300" : "violet.400" }}
        />
        {isStreaming && !quietTurn ? (
          <IconButton
            aria-label="Stop generating"
            variant="ghost"
            color="charcoal.400"
            onClick={handleStop}
          >
            <Square weight="fill" />
          </IconButton>
        ) : inTake ? (
          // Stop the take and send it — a dictated turn, like the main chat.
          <IconButton
            aria-label="Stop and send recording"
            {...composerStopRecordingStyle(dictation.hasSpeech)}
            onClick={() => void dictation.stopRecording()}
            disabled={isConnecting}
          >
            <ArrowUp />
          </IconButton>
        ) : sttEnabled &&
          ((!input.trim() && !pendingImage) ||
            dictation.state === "transcribing") ? (
          // An empty box offers the mic where Send sits (main chat's pattern):
          // tap to talk, tap again to send.
          <IconButton
            aria-label={
              dictation.state === "transcribing"
                ? "Transcribing…"
                : "Start recording — tap to talk, tap again to send"
            }
            {...composerMicButtonStyle}
            onClick={() => void dictation.toggleRecording()}
            disabled={
              dictation.state === "transcribing" ||
              dictation.isMicBusy ||
              (sending && !quietTurn)
            }
          >
            {dictation.state === "transcribing" ? (
              <Spinner size="sm" />
            ) : (
              <Microphone weight="fill" />
            )}
          </IconButton>
        ) : (
          // During a quiet app-update turn Send stays live: sending steers it,
          // and the scholar's turn carries the in-app events instead.
          <IconButton
            aria-label="Send"
            colorPalette="violet"
            onClick={() => void handleSend()}
            disabled={(sending && !quietTurn) || (!input.trim() && !pendingImage)}
          >
            <PaperPlaneRight weight="fill" />
          </IconButton>
        )}
      </Flex>
      {(dictation.error || (isRecording && dictation.isTooLoud)) && (
        <Text
          fontSize="xs"
          color="red.500"
          textAlign="center"
          pb={2}
          px={3}
          fontFamily="heading"
        >
          {dictation.error ?? "Too loud!"}
        </Text>
      )}
    </Flex>
  );

  const modeControl =
    showModeControl && builderStance ? (
      <ContextTabs<WorkshopMode>
        value={mode}
        onChange={handleModeChange}
        ariaLabel="App mode"
        items={[
          editUnlocked
            ? teacherEditOverride
              ? {
                  // Scholars never see this segment (or not yet): name it as
                  // the teacher's own affordance so the rehearsal reads as
                  // "what scholars see, plus my fix-it switch" (TRA-477).
                  value: "edit",
                  label: "Teacher edit",
                  tooltip:
                    data?.session?.editAccess === "afterCompletion"
                      ? "Scholars can edit once they finish the activity."
                      : "Scholars only play this app.",
                }
              : { value: "edit", label: "Edit" }
            : {
                // A locked Edit segment keeps its word, greyed by `disabled`,
                // with a small lock in front of it so what is locked is named
                // on the control itself (Andy, 2026-10-11: a bare lock beside
                // "Play" read as a mystery icon). The unlock sentence survives
                // as a hover tooltip.
                value: "edit",
                label: (
                  <Flex as="span" align="center" gap={1} aria-label="Edit locked">
                    <Lock size={12} weight="fill" aria-hidden />
                    Edit
                  </Flex>
                ),
                disabled: true,
                tooltip: "Edit unlocks when you finish the activity.",
              },
          { value: "play", label: "Play" },
        ]}
      />
    ) : null;

  // An app that goes away (a switch, a restore) ends the presentation.
  const presentingApp = presenting && !!htmlArtifact;

  const header = (
    <Flex
      align="center"
      gap={2}
      px={3}
      py={2}
      borderBottom="1px solid"
      borderColor="gray.200"
      bg="white"
      flexShrink={0}
    >
      {/* A chat-primary session opened its app here: Chat leads, back to the
          same session's conversation (TRA-519). */}
      {onBackToChat && (
        <Button
          size="sm"
          variant="ghost"
          colorPalette="violet"
          fontFamily="heading"
          px={2}
          onClick={onBackToChat}
        >
          <CaretLeft />
          {APP_SURFACE_COPY.backToChat}
        </Button>
      )}
      {onOpenSidebar && (
        <IconButton
          aria-label="Open menu"
          variant="ghost"
          size="sm"
          color="charcoal.500"
          onClick={onOpenSidebar}
        >
          <List />
        </IconButton>
      )}
      <Hammer weight="duotone" color="var(--chakra-colors-violet-500)" />
      {/* The bar shows the ACTIVITY TITLE with a small quiet-gray "App"
          eyebrow above it — never "App designer · <title>" (F14a). */}
      <Box minW={0}>
        <Text
          fontSize="2xs"
          fontFamily="heading"
          fontWeight="700"
          letterSpacing="0.06em"
          color="charcoal.400"
          textTransform="uppercase"
          lineHeight="1"
        >
          App
          {isFreePlay && (
            <Box as="span" color="violet.500" ml={1.5}>
              · Free play
            </Box>
          )}
        </Text>
        <Text
          fontFamily="heading"
          fontWeight="600"
          color="navy.500"
          fontSize="sm"
          lineClamp={1}
        >
          {title}
        </Text>
      </Box>
      {appChoices.length > 0 && (
        <Menu.Root positioning={{ placement: "bottom-start" }}>
          <Menu.Trigger asChild>
            <Button
              size="xs"
              variant="outline"
              colorPalette="gray"
              fontFamily="heading"
              aria-label={`${SWITCH_APP_LABEL}: ${openAppLabel}`}
              minW={0}
              maxW="200px"
              flexShrink={1}
            >
              <Text as="span" color="navy.500" truncate>
                {openAppLabel}
              </Text>
              <CaretDown size={10} style={{ marginLeft: 3, flexShrink: 0 }} />
            </Button>
          </Menu.Trigger>
          <Portal>
            <Menu.Positioner>
              <Menu.Content minW="200px">
                {appChoices.map((choice) => (
                  <Menu.Item
                    key={choice.id}
                    value={choice.id}
                    onClick={() => {
                      if (choice.id !== String(htmlArtifact?._id)) {
                        onShowApp?.(choice.id);
                      }
                    }}
                  >
                    <Text flex={1} fontFamily="heading" fontSize="xs" truncate>
                      {choice.label}
                    </Text>
                    {choice.id === String(htmlArtifact?._id) && (
                      <Check size={12} weight="bold" />
                    )}
                  </Menu.Item>
                ))}
              </Menu.Content>
            </Menu.Positioner>
          </Portal>
        </Menu.Root>
      )}
      {modeControl}
      <Box flex={1} />
      {showYourWork && (
        <Button
          size="sm"
          variant="outline"
          colorPalette="gray"
          fontFamily="heading"
          minW={0}
          flexShrink={1}
          onClick={() => setYourWorkOpen(true)}
        >
          {workStatus && workKind ? (
            <>
              <Text as="span" color="navy.500" truncate>
                {YOUR_WORK_LABEL[workKind] ?? APP_SURFACE_COPY.yourWork}
              </Text>
              <Text as="span" color="charcoal.400" flexShrink={0}>
                {`· ${workStatus}`}
              </Text>
            </>
          ) : (
            APP_SURFACE_COPY.yourWork
          )}
        </Button>
      )}
      {surfaceMode === "edit" && isBuildSession && (
        <Text
          fontSize="xs"
          fontFamily="heading"
          color="charcoal.400"
          flexShrink={0}
          display={{ base: "none", md: "block" }}
        >
          {formatSavedAt(savedAt, nowTick)}
        </Text>
      )}
      {surfaceMode === "edit" ? (
        <Button
          size="xs"
          variant="outline"
          colorPalette="violet"
          fontFamily="heading"
          onClick={() => setHistoryOpen(true)}
        >
          <ClockCounterClockwise style={{ marginRight: 4 }} />
          History
        </Button>
      ) : canResetAppState ? (
        <Button
          size="xs"
          variant="outline"
          colorPalette="violet"
          fontFamily="heading"
          onClick={() => void handleResetAppState()}
          disabled={!htmlArtifact}
        >
          <ArrowClockwise style={{ marginRight: 4 }} />
          Reset app state
        </Button>
      ) : null}
      {htmlArtifact &&
        (isNarrow ? (
          <IconButton
            aria-label={APP_SURFACE_COPY.presentAccessibility}
            size="xs"
            variant="outline"
            colorPalette="violet"
            onClick={startPresenting}
          >
            <ProjectorScreen />
          </IconButton>
        ) : (
          <Button
            size="xs"
            variant="ghost"
            colorPalette="violet"
            fontFamily="heading"
            aria-label={APP_SURFACE_COPY.presentAccessibility}
            onClick={startPresenting}
          >
            <ProjectorScreen style={{ marginRight: 4 }} />
            {APP_SURFACE_COPY.present}
          </Button>
        ))}
      {/* The chat pane is a TOGGLE, not a consequence of the mode: closed by
          default, opened by this rightmost ghost button in EVERY state (F14b).
          One exception to the closed default: a scholar playing their own
          Play-only app that has a character starts with it open on wide
          screens (`defaultChatOpen`). Narrow uses an icon; wide uses a
          labelled ghost button. */}
      {isNarrow ? (
        <IconButton
          aria-label={chatOpen ? "Hide chat" : "Show chat"}
          size="xs"
          variant={chatOpen ? "solid" : "outline"}
          colorPalette="violet"
          onClick={() => setChatOpen(!chatOpen)}
        >
          <ChatCircle weight={chatOpen ? "fill" : "regular"} />
        </IconButton>
      ) : (
        <Button
          size="xs"
          variant="ghost"
          colorPalette="violet"
          fontFamily="heading"
          onClick={() => setChatOpen(!chatOpen)}
        >
          <ChatCircle
            weight={chatOpen ? "fill" : "regular"}
            style={{ marginRight: 4 }}
          />
          {chatOpen ? "Hide chat" : "Chat"}
        </Button>
      )}
    </Flex>
  );

  const preview = htmlArtifact ? (
    // Must be a flex COLUMN: CodeArtifactViewer's root is `flex={1}`, which
    // collapses to content height inside a plain block Box — the "app cut
    // off at ~400px" bug. ArtifactPanel mounts the same viewer in a flex
    // parent for the same reason.
    //
    // Present restyles THIS container (fixed over the window, and full screen
    // where the browser allows) instead of rendering the app anywhere else.
    <Flex
      ref={presentRef}
      position={presentingApp ? "fixed" : "relative"}
      inset={presentingApp ? 0 : undefined}
      zIndex={presentingApp ? "modal" : undefined}
      flexDir="column"
      flex={1}
      minH={0}
      minW={0}
      bg="white"
    >
      <CodeArtifactViewer
        key={`${String(htmlArtifact._id)}:${resetNonce}`}
        artifact={htmlArtifact}
        readOnly={surfaceMode === "play" || presentingApp}
        appOnly={!showViewerChrome || presentingApp}
        onSave={
          surfaceMode === "play"
            ? undefined
            : (updates) =>
                saveArtifact({
                  artifactId: htmlArtifact._id,
                  ...updates,
                  baseRevision:
                    updates.baseRevision ?? htmlArtifact.revision ?? 0,
                })
        }
        onSnapshotCaptureReady={handleSnapshotCaptureReady}
        onAskTutor={handleAppTutorAsk}
        // An Edit preview is a builder trying their own character, not play
        // the tutor should coach, so only Play reports character turns.
        onAppAiTurn={tutorVoice ? handleAppAiTurn : undefined}
        // The character and judges answer only the session's owner; anyone
        // else watching gets `unavailable` without a server call.
        appAiEnabled={isSessionOwner}
      />
      {presentingApp && (
        <Button
          position="absolute"
          top={3}
          right={3}
          size="xs"
          rounded="full"
          bg="blackAlpha.500"
          color="white"
          fontFamily="heading"
          _hover={{ bg: "blackAlpha.700" }}
          onClick={stopPresenting}
        >
          {APP_SURFACE_COPY.stopPresenting}
        </Button>
      )}
    </Flex>
  ) : buildPreview === "live" ? (
    // A build stream is live (or the teacher opened a build link whose kickoff
    // is starting) but there's no app yet: show honest, named progress in place
    // of the "Start building" empty state — the kickoff already IS the start.
    <Flex flex={1} minH={0} align="center" justify="center" bg="gray.50" p={8}>
      <BuildProgress
        variant="card"
        stage={buildStage.stage}
        startedAt={buildStartedAt}
        onStop={isStreaming ? handleStop : undefined}
      />
    </Flex>
  ) : buildPreview === "stopped" ? (
    // The build ended (Stop, a rejected fetch, an SSE error, or `done` with no
    // code) without producing an app: settle into a recovery card instead of a
    // progress card that keeps ticking with a Stop that no longer does anything.
    <Flex flex={1} minH={0} align="center" justify="center" bg="gray.50" p={8}>
      <BuildStopped onRetry={handleRetryBuild} />
    </Flex>
  ) : (
    <Flex flex={1} minH={0} align="center" justify="center" bg="gray.50" p={8}>
      <VStack gap={4} maxW="380px" textAlign="center">
        <EmptyState
          size="lg"
          icon={<Hammer weight="duotone" />}
          title="Describe the app you want to build"
          hint="Tell the builder your idea — a game, a story, a simulation — and it writes a live app right here. Then keep refining it."
        />
        <Button
          colorPalette="violet"
          onClick={() => {
            setChatOpen(true);
            setWantsComposerFocus(true);
          }}
        >
          Start building
        </Button>
      </VStack>
    </Flex>
  );

  // While the chat is closed, a coach line from an app-update turn would land
  // out of sight: show it under the app until read. The slot is reserved for
  // as long as the chat stays closed (empty when there is no line), so the app
  // never moves when a line arrives or is read (a jump made taps miss,
  // TRA-477). With the thread open beside the app on a wide screen the line
  // is already on screen, so the slot would be a blank white band under the
  // app; it comes back when the scholar hides the chat. The narrow layout
  // keeps it always: its chat is a drawer over the app, never beside it.
  const chatBesideApp = chatOpen && !isNarrow;
  const appPane = (
    <Flex flexDir="column" flex={1} minH={0} minW={0}>
      {preview}
      {isSessionOwner &&
        tutorVoice &&
        !!htmlArtifact &&
        !chatBesideApp &&
        !presentingApp && (
        <TutorLineSlot
          line={tutorLine.unread ?? null}
          onOpen={() => setChatOpen(true)}
        />
      )}
      {appDeliverableContext && htmlArtifact && !presentingApp && (
        // The app is the deliverable: the chat panel's own submit-and-check
        // control and flair, bound to the app the builder shows.
        <Flex
          justify="center"
          px={3}
          py={2}
          bg="white"
          borderTop="1px solid"
          borderColor="gray.200"
          flexShrink={0}
        >
          <ArtifactDeliverableButton
            sessionId={appDeliverableContext.sessionId}
            activityId={appDeliverableContext.activityId}
            artifactId={htmlArtifact._id}
            deliverableSpec={appDeliverableContext.deliverableSpec}
            onSubmit={
              isSessionOwner
                ? () =>
                    handleSubmitWork(
                      htmlArtifact,
                      appDeliverableContext.deliverableSpec.criteria.length > 0,
                    )
                : undefined
            }
            checkDisabled={isStreaming || buildLaunching}
            isAiCheckingRubric={isAiCheckingRubric}
            animateFlairArrivals={isSessionOwner}
          />
        </Flex>
      )}
    </Flex>
  );

  return (
    <Flex flexDir="column" flex={1} minH={0} minW={0}>
      {header}
      {isNarrow ? (
        <>
          {appPane}
          <Drawer.Root
            open={chatOpen && !presentingApp}
            onOpenChange={(e) => setChatOpen(e.open)}
            placement="bottom"
          >
            <Portal>
              <Drawer.Backdrop />
              <Drawer.Positioner>
                <Drawer.Content bg="white" h="70vh" roundedTop="lg">
                  <Flex align="center" px={4} py={2} borderBottom="1px solid" borderColor="gray.200">
                    <Text fontFamily="heading" fontWeight="600" color="navy.500" fontSize="sm" flex={1}>
                      {tutorVoice ? "Tutor" : "Designer"}
                    </Text>
                    <IconButton
                      aria-label="Close chat"
                      variant="ghost"
                      size="sm"
                      onClick={() => setChatOpen(false)}
                    >
                      <X />
                    </IconButton>
                  </Flex>
                  <Box flex={1} minH={0}>
                    {thread}
                  </Box>
                </Drawer.Content>
              </Drawer.Positioner>
            </Portal>
          </Drawer.Root>
        </>
      ) : (
        // The chat pane is a toggle, NOT a consequence of the mode: the thread
        // sits beside the app only when the teacher/scholar opens it, so the
        // app pane keeps its full width by default (F14b). The one exception:
        // a scholar (session owner, not a teacher rehearsal) playing a
        // Play-only app (`effectiveEditAccess === "hidden"`) that has a
        // character starts with the thread open here, so the tutor's questions
        // sit on screen beside the character (`defaultChatOpen`). It is only
        // the initial value; the toggle still closes it and the choice sticks.
        <Flex flex={1} minH={0}>
          {appPane}
          {chatOpen && (
            <Box
              w="380px"
              flexShrink={0}
              borderLeft="1px solid"
              borderColor="gray.200"
              minH={0}
              bg="white"
            >
              {thread}
            </Box>
          )}
        </Flex>
      )}
      <YourWorkDrawer
        open={yourWorkOpen && !presentingApp}
        onClose={() => setYourWorkOpen(false)}
        sessionId={sessionId}
        artifacts={workArtifacts}
        // An app deliverable is checked under the app, never against a
        // document in here.
        deliverableContext={
          workKind !== "artifact" ? deliverable.deliverableContext : undefined
        }
        readOnly={!isSessionOwner}
        isStreaming={isStreaming}
        isAiCheckingRubric={isAiCheckingRubric}
        onSubmitArtifact={handleSubmitWork}
      />
      <VibecodeHistoryPanel
        revisions={revisions}
        open={historyOpen && !presentingApp}
        onClose={() => setHistoryOpen(false)}
        onRestore={(rev) => void handleRestore(rev)}
        restoring={restoring}
      />
    </Flex>
  );
}
