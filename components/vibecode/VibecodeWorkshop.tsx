"use client";

/**
 * VibecodeWorkshop — the WEB twin of the native `VibecodeScreen`.
 * A `sessionMode: "vibecode"` session, rendered PREVIEW-FIRST: the app IS the
 * session's newest HTML code artifact, shown live in a sandboxed iframe
 * center-stage (via the shared `CodeArtifactViewer`), with a chat panel that
 * drives the build.
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
  Portal,
  Spinner,
  Text,
  Textarea,
  VStack,
  useBreakpointValue,
} from "@chakra-ui/react";
import {
  ArrowClockwise,
  ChatCircle,
  ClockCounterClockwise,
  Hammer,
  List,
  Lock,
  PaperPlaneRight,
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
import {
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
import { toaster } from "@/lib/toaster";
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
import { newestHtmlArtifact } from "@/lib/vibecode/helpers";
import { deriveBuildPreview, deriveBuildStage, type BuildSignal } from "@/shared/buildStage";
import { renderCheckLoadBoundary } from "@/shared/renderCheckLoadBoundary";
import { BuildProgress, BuildStopped } from "@/components/vibecode/BuildProgress";
import { CodeArtifactViewer } from "@/components/CodeArtifactViewer";
import { VibecodeHistoryPanel } from "@/components/vibecode/VibecodeHistoryPanel";
import { flushAllArtifactSaves } from "@/components/ArtifactPanel";
import { ImageLightbox } from "@/components/ImageLightbox";
import {
  SessionAssistantMessageBody,
  SessionInputModality,
  useReconciledSessionMessages,
} from "@/components/SessionTranscript";
import { EmptyState } from "@/components/ui/EmptyState";
import { ContextTabs } from "@/components/ui/ContextTabs";

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
  inputModality?: "typed" | "spoken" | "app";
  createdAt: number;
};

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

export function VibecodeWorkshop({
  sessionId,
  onOpenSidebar,
}: {
  sessionId: Id<"sessions">;
  onOpenSidebar?: () => void;
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
  const revisions = useQuery(api.codeArtifactRevisions.listForSession, {
    sessionId,
  });

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
  const { user: currentUser } = useCurrentUser();
  const isSessionOwner =
    !!data?.session &&
    !!currentUser &&
    String(data.session.userId) === String(currentUser._id);
  // A scholar who only plays this app sees the app and nothing else: no
  // "Reset app state" and no viewer chrome. Staff and a scholar building
  // their own app keep both; Reset stays owner-only (TRA-317, TRA-477).
  const { showResetAppState: canResetAppState, showViewerChrome } =
    playSurfaceFor({
      mode,
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

  const isNarrow = useBreakpointValue({ base: true, lg: false }) ?? false;
  const [chatOpen, setChatOpen] = useState(false);
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
  const htmlArtifact = useMemo(
    () => newestHtmlArtifact(artifacts),
    [artifacts],
  );
  const htmlArtifactRef = useRef(htmlArtifact);
  useEffect(() => {
    htmlArtifactRef.current = htmlArtifact;
  }, [htmlArtifact]);

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
    // messageVisibleInMode).
    .filter((m) => messageVisibleInMode(m, mode))
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      stopRequestedAt: m.stopRequestedAt,
      appSnapshotUrl: m.appSnapshotUrl,
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
    mode === "play" ? (appAiTurns ?? []) : [],
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
  ): Promise<boolean> => {
    if (!text && !appUpdate) return false;
    const appContext = appUpdate
      ? newestAppTutorAskContext(appUpdate.batch)
      : undefined;
    // An app update is play: the server opens it in the tutor thread whatever
    // the screen shows, so it never snaps an Edit-mode screen to Play.
    const turnMode = appUpdate ? "play" : mode;
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
          });
          appUpdate.onPrepared(appTutorSendResultFromStatus(result.status));
          return result.status === "started" ? result : null;
        } catch {
          appUpdate.onPrepared("failed");
          return null;
        }
      }
      try {
        const result = await sendMsg({
          sessionId,
          message: text,
          inputModality: "typed",
          mode,
        });
        // The server clamped a requested Edit to Play (policy): the turn is
        // already in the tutor thread, so snap NOW rather than waiting for the
        // stream, which may never open (a 429/403 returns before any event).
        if (result.workshopMode === "play" && mode === "edit") setMode("play");
        setInput("");
        return result;
      } catch (error) {
        console.error("[vibecode] send failed", error);
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
          mode: turnMode,
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
    (mode === "edit" || !streamingContent.trim());

  const handleSend = () => {
    appTutorUpdates.clearAppAi();
    tutorLine.markRead();
    return sendTutorTurn(input.trim());
  };
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
    if (mode === "edit" && isSessionOwner) {
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

  const composerPlaceholder =
    mode === "edit"
      ? "Tell the designer what to change…"
      : "Talk to the tutor…";
  const emptyHint =
    mode === "edit"
      ? "Describe the app you want to build — the designer writes it and you iterate."
      : "Talk to the tutor about the app.";
  // The brief — a muted first card in the designer thread (Edit only), rendered
  // client-side from the activity's appRequest. Never a persisted message.
  const briefCard =
    mode === "edit" && briefText ? (
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
                    if (mode !== "edit") return null;
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
              (mode === "play" ? (
                // Play is the tutor thread: a question is not a build, so the
                // build stages ("Planning the app") would be a seam here.
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
        />
      )}

      <Flex
        px={3}
        py={3}
        gap={2}
        align="flex-end"
        borderTop="1px solid"
        borderColor="gray.200"
        flexShrink={0}
      >
        <Textarea
          ref={composerRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          placeholder={composerPlaceholder}
          rows={1}
          resize="none"
          fontSize="sm"
          maxH="120px"
          bg="white"
          borderColor="gray.300"
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
        ) : (
          // During a quiet app-update turn Send stays live: sending steers it,
          // and the scholar's turn carries the in-app events instead.
          <IconButton
            aria-label="Send"
            colorPalette="violet"
            onClick={() => void handleSend()}
            disabled={(sending && !quietTurn) || !input.trim()}
          >
            <PaperPlaneRight weight="fill" />
          </IconButton>
        )}
      </Flex>
    </Flex>
  );

  const modeControl =
    showModeControl ? (
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
      {modeControl}
      <Box flex={1} />
      {mode === "edit" && isBuildSession && (
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
      {mode === "edit" ? (
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
      {/* The chat pane is a TOGGLE, not a consequence of the mode: closed by
          default, opened by this rightmost ghost button in EVERY state (F14b).
          Narrow uses an icon; wide uses a labelled ghost button. */}
      {isNarrow ? (
        <IconButton
          aria-label={chatOpen ? "Hide chat" : "Show chat"}
          size="xs"
          variant={chatOpen ? "solid" : "outline"}
          colorPalette="violet"
          onClick={() => setChatOpen((open) => !open)}
        >
          <ChatCircle weight={chatOpen ? "fill" : "regular"} />
        </IconButton>
      ) : (
        <Button
          size="xs"
          variant="ghost"
          colorPalette="violet"
          fontFamily="heading"
          onClick={() => setChatOpen((open) => !open)}
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
    <Flex position="relative" flexDir="column" flex={1} minH={0} minW={0} bg="white">
      <CodeArtifactViewer
        key={`${String(htmlArtifact._id)}:${resetNonce}`}
        artifact={htmlArtifact}
        readOnly={mode === "play"}
        appOnly={!showViewerChrome}
        onSave={
          mode === "play"
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
        onAppAiTurn={mode === "play" ? handleAppAiTurn : undefined}
        // The character and judges answer only the session's owner; anyone
        // else watching gets `unavailable` without a server call.
        appAiEnabled={isSessionOwner}
      />
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

  // The chat is closed by default, so a coach line from an app-update turn
  // would land out of sight: show it under the app until read. The slot is
  // reserved for the whole of Play (empty when there is no line), so the app
  // never moves when a line arrives or is read (a jump made taps miss,
  // TRA-477).
  const appPane = (
    <Flex flexDir="column" flex={1} minH={0} minW={0}>
      {preview}
      {isSessionOwner && mode === "play" && !!htmlArtifact && (
        <TutorLineSlot
          line={tutorLine.unread ?? null}
          onOpen={() => setChatOpen(true)}
        />
      )}
    </Flex>
  );

  return (
    <Flex flexDir="column" flex={1} minH={0} minW={0}>
      {header}
      {isNarrow ? (
        <>
          {appPane}
          <Drawer.Root open={chatOpen} onOpenChange={(e) => setChatOpen(e.open)} placement="bottom">
            <Portal>
              <Drawer.Backdrop />
              <Drawer.Positioner>
                <Drawer.Content bg="white" h="70vh" roundedTop="lg">
                  <Flex align="center" px={4} py={2} borderBottom="1px solid" borderColor="gray.200">
                    <Text fontFamily="heading" fontWeight="600" color="navy.500" fontSize="sm" flex={1}>
                      {mode === "edit" ? "Designer" : "Tutor"}
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
        // app pane keeps its full width by default (F14b).
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
      <VibecodeHistoryPanel
        revisions={revisions}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onRestore={(rev) => void handleRestore(rev)}
        restoring={restoring}
      />
    </Flex>
  );
}
