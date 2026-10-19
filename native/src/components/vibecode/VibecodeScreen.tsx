/**
 * VibecodeScreen — the native, Lovable-style "describe → generate a live app →
 * iterate" surface for a `sessionMode: "vibecode"` session (vibecode-spec.md).
 *
 * The app IS the session's newest HTML code artifact. We read the artifacts
 * reactively (`api.artifacts.getBySession`), pick the newest whose content looks
 * like HTML, and render it full-screen in a WebView. A bottom chat Drawer drives
 * the build: it reuses the native tutor STREAMING PATH verbatim in mechanism —
 * the same `api.sessions.sendMessage` mutation + `${convexSiteUrl}/session-stream`
 * SSE loop the session screen and SidelineTutorSheet stream through — so whispers,
 * teacher visibility, and observer wiring come for free.
 *
 * EDIT | PLAY (TRA-301, review/teacher-build-flow.html §2/§4). The screen has
 * ONE mode, held here and swapped by the native segmented control in the top
 * bar: Edit talks to the designer and versions the app (History, the saved-at
 * readout, the brief card); Play runs the app and talks to the tutor (Reset app
 * state, a plain "Thinking…" while it answers). The mode selects the thread the
 * chat sheet shows, the composer copy, and the single right-group action —
 * nothing structural forks, exactly as on web (T12). The client's mode is a
 * REQUEST: the server clamps it against the activity's edit policy, and this
 * screen follows that verdict (the `sendMessage` result, the SSE backstop, and
 * a `effectiveEditAccess` that changes mid-session).
 *
 * WEBVIEW NOTE: the app's canonical embedded-web host is `ExternalAppHost`, but
 * it is a URL-based, store-driven keep-alive singleton (`source={{ uri }}`,
 * cookie/session tracking, allowlists) — it has no path to render inline HTML we
 * hold in memory. So the live preview reuses its UNDERLYING WebView pattern (the
 * `WebView as any` + `source={{ html }}` idiom already established in
 * `app/dev-hdr-stars.tsx`) rather than hand-rolling a novel WebView config. The
 * host is keyed on the artifact id plus the Reset nonce; CodeArtifactWebView
 * itself fingerprints the content, so an edit_document str_replace (which
 * mutates the SAME artifact row) and a Restore both reload the preview.
 *
 * ONE APP SURFACE (TRA-519). This screen is the builder for every session that
 * has an app. A builder-primary session (an app activity, an activity-less
 * builder, free play) opens on it; a chat-primary session reaches it through
 * the app card's Open (`?view=builder`) and gets a "Chat" way back. When the
 * app is a side project (the activity's real work is a document, slides, a
 * map) the header carries that work's status and a "Your work" sheet; when the
 * app IS the deliverable, the Check my work footer sits under the preview.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import { fetch as expoFetch } from "expo/fetch";
import * as Haptics from "expo-haptics";
import { Button, Host, Menu } from "@expo/ui/swift-ui";
import { accessibilityLabel, tint } from "@expo/ui/swift-ui/modifiers";
import { SymbolView } from "expo-symbols";
import { useConvex, useMutation, useQuery } from "convex/react";
import { useAuthToken } from "@convex-dev/auth/react";

import { Drawer } from "@/components/ui/Drawer";
import { ChatBubble } from "@/components/ChatBubble";
import { PendingPhotoChip } from "@/components/PhotoAttachment";
import { useImageAttachment } from "@/hooks/useImageAttachment";
import { StreamingText } from "@/components/StreamingText";
import {
  CodeArtifactWebView,
  type CodeArtifactWebViewHandle,
} from "@/components/CodeArtifactWebView";
import { api, convexSiteUrl, type Doc, type Id } from "@/lib/convex";
import { uploadChangedAppSnapshot } from "@/lib/appSnapshot";
import { uploadImageDataUrl } from "@/lib/uploadImage";
import {
  answerNativeRenderCheck,
  RENDER_CHECK_ARTIFACT_WAIT_MS,
  RENDER_CHECK_CLIENT_BUDGET_MS,
  renderCheckLoadBoundary,
  type RenderCheckRequest,
} from "@/lib/renderCheck";
import { chatBubbleStyles, OPENER_SENTINEL } from "@/lib/chatBubbles";
import { composerPayloadKey, createSendLock } from "@/lib/sendLock";
import {
  readTutorSse,
  type TutorStreamEvent,
} from "@/lib/tutorSse";
import { tutorStreamErrorMessage } from "@/lib/tutorStreamError";
import { fonts, useColors } from "@/theme";
import {
  CODE_TOOLS,
  SWITCH_APP_LABEL,
  builderAppChoices,
  builderHtmlArtifact,
  htmlAppIds,
  newlyAddedHtmlApp,
  revisionsForApp,
} from "../../../vendor/vibecode/helpers";
import {
  deriveBuildPreview,
  deriveBuildStage,
  type BuildSignal,
} from "../../../vendor/shared/buildStage";
import { BuildProgress, BuildStopped, buildStageLabel } from "@/components/vibecode/BuildProgress";
import {
  EDIT_MODE_ASK_NOTICE,
  appTutorSendResultFromStatus,
  newestAppTutorAskContext,
  settleAppTutorSend,
  type AppTutorRequest,
  type AppTutorSendResult,
  type AppTutorUpdateBatch,
} from "../../../vendor/shared/appTutorRequest";
import { isQuietAppUpdatePlaceholder } from "../../../vendor/shared/streamRetry";
import { useAppTutorUpdates, useUnreadTutorLine } from "@/hooks/useAppTutorUpdates";
import { TutorLineSlot } from "@/components/TutorLineStrip";
import {
  defaultWorkshopMode,
  editControlFor,
  formatSavedAt,
  messageThread,
  playSurfaceFor,
  threadForMode,
  type EffectiveEditAccess,
  type WorkshopMode,
} from "../../../vendor/shared/workshopMode";
import { AppTextInput } from "@/components/AppTextInput";
import { RecordingBar } from "@/components/RecordingBar";
import { useStreamingDictation } from "@/hooks/useStreamingDictation";
import { appStatusBus } from "@/lib/appStatusBus";
import { getNativeTTS } from "@/lib/nativeTTS";
import {
  VibecodeHistorySheet,
  type HistoryRevision,
} from "@/components/vibecode/VibecodeHistorySheet";
import { VibecodeModeControl } from "@/components/vibecode/VibecodeModeControl";
import {
  ArtifactEditor,
  CodeViewToggle,
  flushPendingArtifactSaves,
  type CodeView,
} from "@/components/DeliverablePanel";
import { ParkingLot } from "@/components/vibecode/ParkingLot";
import { useSavedForLaterActions } from "@/components/MissionDoneBlocks";
import { DeliverableFooter } from "@/components/DeliverableFooter";
import { YourWorkSheet } from "@/components/vibecode/YourWorkSheet";
import { useBuilderDeliverable } from "@/components/vibecode/useBuilderDeliverable";
import { APP_SURFACE_COPY } from "../../../vendor/shared/appSurface";
import { AppPresentControls } from "@/components/vibecode/AppPresentControls";
import { serverRefusal } from "../../../vendor/shared/serverErrorMessage";
import { isTeacherArchived } from "../../../vendor/shared/teacherArchive";
import { TeacherArchivedSession } from "@/components/TeacherArchivedSession";

type VibecodeMessage = {
  id: string;
  role: string;
  content: string;
  stopRequestedAt?: number;
  appSnapshotUrl: string | null;
  /** The scholar attached a photo ("make the art look like this"). */
  hasImage: boolean;
  imageUrl: string | null;
};
/** Present mode: the app alone on the screen, nothing to swipe back from. */
const PRESENT_SCREEN_OPTIONS = { headerShown: false, gestureEnabled: false };
/** How often the saved-at readout re-renders so "just now" can age into a time. */
const SAVED_AT_TICK_MS = 30_000;

/**
 * History → Restore: fetch the chosen revision's html (the list ships metadata
 * only), then roll it forward as a NEW revision through the existing artifact
 * mutation, stamped `restoredFromRevision` so History labels it as a restore.
 * A stale base revision comes back as `{ok: false, conflict: true}` — a no-op
 * the caller must surface, never a silent success.
 *
 * Module scope so the Restore flow (fetch → save → surface the result) is one
 * readable unit that neither React state nor the component's render cycle
 * touches.
 */
async function restoreRevision({
  convex,
  saveArtifact,
  artifact,
  target,
}: {
  convex: ReturnType<typeof useConvex>;
  saveArtifact: (args: {
    artifactId: Id<"artifacts">;
    content: string;
    baseRevision: number;
    restoredFromRevision: number;
  }) => Promise<{ ok: boolean }>;
  artifact: { _id: Id<"artifacts">; revision?: number };
  target: { id: string; version: number };
}): Promise<"ok" | "conflict" | "failed"> {
  try {
    const fetched = await convex.query(
      api.codeArtifactRevisions.getRevisionHtml,
      { revisionId: target.id as Id<"codeArtifactRevisions"> },
    );
    if (!fetched) return "failed";
    const result = await saveArtifact({
      artifactId: artifact._id,
      content: fetched.html,
      baseRevision: artifact.revision ?? 0,
      restoredFromRevision: target.version,
    });
    return result.ok === false ? "conflict" : "ok";
  } catch (error) {
    console.warn("[vibecode] restore failed", error);
    return "failed";
  }
}
type HtmlArtifactVersion = {
  id: string;
  revision: number;
  content: string;
  loadBoundary?: ReturnType<
    CodeArtifactWebViewHandle["currentLoadBoundary"]
  > | null;
};

export function VibecodeScreen({
  sessionId,
  appId,
}: {
  sessionId: Id<"sessions">;
  /** The app to show — the one a chat app card's Open named (route param
   *  `app`). Absent or stale → the session's newest app. */
  appId?: string;
}) {
  const colors = useColors();
  // The canonical chat-turn metrics (shared with the scholar tutor chat) — used
  // for the in-flight streaming bubble; settled turns render via <ChatBubble>.
  const bubbleStyles = useMemo(() => chatBubbleStyles(colors), [colors]);
  const [chatOpen, setChatOpen] = useState(false);
  // The mode the person ASKED for (null = never touched the control, so the
  // derived default applies). The live `mode` below clamps it against the
  // server's verdict, so a locked or hidden Edit can never be the live mode —
  // including when the verdict flips mid-session (a completion lands and the
  // scholar's Edit unlocks, or a teacher's access is withdrawn).
  const [modeRequest, setModeRequest] = useState<WorkshopMode | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [yourWorkOpen, setYourWorkOpen] = useState(false);
  // Present mode (showing the app to the class). The app WebView stays mounted
  // in place; only the chrome around it goes, so the game keeps its state.
  const [presenting, setPresenting] = useState(false);
  // "Check my work" is in flight (the submit and the tutor's check reply).
  const [checkBusy, setCheckBusy] = useState(false);
  // Edit's Preview | Code view of the app (TRA-520), the native twin of the
  // web CodeArtifactViewer toolbar. Play never shows code, so the live view
  // below falls back to Preview whenever the mode is not Edit.
  const [codeViewRequest, setCodeViewRequest] = useState<CodeView>("preview");
  // The thread the in-flight reply belongs to, fixed at send time: the
  // streaming row renders only while that thread is the visible one, so a
  // designer reply never shows up as tutor output after a mid-turn flip.
  const [streamingThread, setStreamingThread] = useState<
    "designer" | "tutor" | null
  >(null);
  // The last autosave failure the teacher was told about (session field, F4).
  const autosaveFailShownRef = useRef<number | null>(null);
  const [restoring, setRestoring] = useState(false);
  // Bumping this remounts CodeArtifactWebView — the second half of "Reset app
  // state" (the first half clears the SERVER-persisted state row).
  const [resetNonce, setResetNonce] = useState(0);
  // A coarse clock so the server-provided saved-at readout can age from "just
  // now" into a wall time without calling Date.now() during render.
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [wantsComposerFocus, setWantsComposerFocus] = useState(false);
  // True while a create_code / edit_document tool is in flight — drives the
  // preview overlay label and the drawer badge.
  const [building, setBuilding] = useState(false);
  // Honest build progress (TRA-319): an ordered list of the stream signals that
  // move the build stage (see vendor/shared/buildStage.ts), plus when the
  // current stream began. Reset at each stream start so the card/line reflect
  // the LIVE build, not a stale one.
  const [buildSignals, setBuildSignals] = useState<BuildSignal[]>([]);
  const [streamStartedAt, setStreamStartedAt] = useState<number | null>(null);
  // The clock origin for a teacher build: passed as the origin at kickoff so the
  // elapsed clock measures one stable interval from when the build was first
  // requested, even across kickoff retries.
  const [openedAt] = useState(() => Date.now());
  // True while a teacher build kickoff stream is being launched or a retry is
  // scheduled — keeps the live card up through the orphan-window wait / relaunch
  // so the settled state only appears once the build has truly stopped.
  const [buildLaunching, setBuildLaunching] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const composerRef = useRef<TextInput>(null);
  const authToken = useAuthToken();
  // Aborts the in-flight tutor stream on Stop / steer. The turn-seq guard keeps
  // an aborted turn's cleanup from clobbering the turn that replaced it.
  const abortRef = useRef<AbortController | null>(null);
  const turnSeqRef = useRef(0);
  // The composer text of the send most recently dispatched — null once the
  // scholar has typed since. handleSend clears the composer synchronously,
  // but `setInput("")` commits on a LATER task, so for a frame the
  // already-rendered submit handler still closes over the old text and a
  // repeated Return would send it again (the duplicate the session screen
  // fixed in #3808). Comparing the submitted text against this stamp makes
  // that resubmit a no-op; typing clears it, so a genuinely retyped identical
  // answer still sends. No in-flight send lock is needed here: the clear is
  // synchronous, so the commit gap is the only window.
  const sentComposerRef = useRef<string | null>(null);
  // The assistant row currently streaming — the requestStop target.
  const liveAssistantIdRef = useRef<string | null>(null);
  // Set by Stop regardless of whether the assistant id is known yet, so a Stop
  // tapped during the pre-mutation window (before sendMessage resolves) is still
  // honored once the row exists, instead of aborting a fetch that never starts.
  const stopRequestedRef = useRef(false);
  const codeArtifactRef = useRef<CodeArtifactWebViewHandle>(null);
  // True while the in-flight turn is an app update (startAppUpdateTurn): it
  // stays invisible until the tutor actually says something.
  const [appUpdateStreaming, setAppUpdateStreaming] = useState(false);
  const streamBusyRef = useRef(false);
  // Held while an app update's startAppUpdateTurn is in flight (sendTutorTurn).
  const appUpdateClaimRef = useRef(createSendLock());
  // The Edit-mode "hints are answered in Play" notice shows once per screen.
  const editAskNoticeShownRef = useRef(false);
  const lastSentSnapshotRef = useRef<{
    sessionId: Id<"sessions">;
    hash: string;
  } | null>(null);
  const activeStreamIdRef = useRef<string | null>(null);
  const activeRenderCheckIdRef = useRef<string | null>(null);
  const artifactBeforeCodeToolRef = useRef<HtmlArtifactVersion | null>(null);
  // Teacher-build kickoff machinery (TRA-319, ported from web's
  // VibecodeWorkshop). One launch per session, one automatic retry on a dropped
  // fetch, then settle into the stopped card. VibecodeScreen owns this now — the
  // session shell skips vibecode sessions (see its activity-kickoff effect).
  const kickoffSessionRef = useRef<string | null>(null);
  const kickoffPendingRef = useRef(false);
  const kickoffRetryReadyRef = useRef(false);
  const kickoffManualRetryRef = useRef(false);
  const kickoffRetryCountRef = useRef(0);
  const kickoffRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [kickoffRetryNonce, bumpKickoffRetry] = useState(0);

  const sendMessage = useMutation(api.sessions.sendMessage);
  // A photo staged in the composer — the session chat's attach pipeline, so a
  // builder can hold up an example ("make the art look like this").
  const image = useImageAttachment();
  const startAppUpdateTurn = useMutation(api.sessions.startAppUpdateTurn);
  const requestStop = useMutation(api.sessions.requestStop);
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const answerRenderCheck = useMutation(api.sessions.answerRenderCheck);
  const saveArtifact = useMutation(api.artifacts.scholarUpdate);
  const clearSessionState = useMutation(api.appStates.clearSessionState);
  const startActivityKickoff = useMutation(api.sessions.startActivityKickoff);
  const submitDeliverable = useMutation(api.deliverables.submit);
  const startRubricCheck = useMutation(api.sessions.startRubricCheck);
  const convex = useConvex();
  const data = useQuery(api.sessions.getWithMessages, { id: sessionId });
  const artifacts = useQuery(api.artifacts.getBySession, { sessionId });
  const me = useQuery(api.users.currentUser, {});
  const ttsEnabled = me?.ttsEnabled !== false;
  // Version metadata (never html — that is fetched on Restore). Held here, not
  // only in the History sheet, so the transcript can render the same version
  // numbers inline as "vN · Restore" markers.
  const sessionRevisions = useQuery(
    api.codeArtifactRevisions.listForSession,
    { sessionId },
  );

  // A free-play session (TRA-489) carries "<activity>: Free play" as its title
  // for lists; the header shows the activity title under a "Free play" tag.
  const isFreePlay = data?.session?.freePlay === true;
  const sessionTitle = data?.session?.title ?? "Build";
  const headerTitle = isFreePlay
    ? sessionTitle.replace(/: Free play$/, "")
    : sessionTitle;
  const router = useRouter();
  const startFreePlay = useMutation(api.sessions.startFreePlay);
  const [startingFreePlay, setStartingFreePlay] = useState(false);
  const handleStartFreePlay = useCallback(async () => {
    Haptics.selectionAsync();
    setStartingFreePlay(true);
    try {
      const result = await startFreePlay({ sessionId });
      router.push({
        pathname: "/session/[id]",
        params: { id: result.sessionId },
      });
    } catch (e) {
      console.warn("[free-play] start failed", e);
      Alert.alert("Couldn't start free play", serverRefusal(e) ?? "Please try again.");
    } finally {
      setStartingFreePlay(false);
    }
  }, [router, sessionId, startFreePlay]);
  const session = data?.session;
  // Whether the builder is this session's primary view (an app activity,
  // an activity-less builder, free play) or opened on demand from the chat,
  // and whether the app is the session's work or a side project.
  const builderPrimary = session?.builderPrimary ?? true;
  const appRole = session?.appRole ?? "work";
  const sessionActivityId = session?.activityId as Id<"activities"> | undefined;
  // The SERVER's edit verdict for THIS caller — rendered, never re-derived.
  // Until the session read resolves it reads "hidden": defaulting to "allowed"
  // would flash the Edit segment (and History) at a coached scholar.
  const effectiveEditAccess: EffectiveEditAccess = session
    ? ((session.effectiveEditAccess ?? "allowed") as EffectiveEditAccess)
    : "hidden";
  const editControl = editControlFor(effectiveEditAccess);
  // A side app (the activity's work is something else) has no Edit/Play: the
  // builder stance is only for an app that IS the work (shared/appSurface.ts),
  // so the app stays editable with History and turns stay in the one chat —
  // the same as web.
  const showModeControl = editControl.showControl && appRole === "work";
  const editUnlocked = editControl.editUnlocked;
  const isBuildSession = session?.teacherBuildKickoff === true;
  const briefText = session?.appRequest ?? null;
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
    hasAppRequest: session?.hasAppRequest === true || hasAppCharacter,
    serverDefault: session?.defaultWorkshopMode,
  });
  // The caller has Edit only because they are staff (scholars on this activity
  // play it, or edit only after finishing) — the server's verdict, TRA-477.
  const teacherEditOverride = session?.teacherEditOverride === true;
  const requestedMode = modeRequest ?? modeDefault;
  const mode: WorkshopMode =
    appRole === "side"
      ? "edit"
      : requestedMode === "edit" && !editUnlocked
        ? "play"
        : requestedMode;
  // `mode` is the app SURFACE's mode: a side app is always editable. The
  // builder STANCE (designer and tutor threads) is only for an app that is the
  // work; a side app keeps the tutor's voice — its title, copy, character
  // reports and unthreaded chat — exactly as web's VibecodeWorkshop does.
  const builderStance = appRole === "work";
  const tutorVoice = !builderStance || mode === "play";
  const codeView: CodeView = mode === "edit" ? codeViewRequest : "preview";
  const savedAt = session?.starterSavedAt ?? null;
  const autosaveFailedAt = session?.appAutosaveFailedAt ?? null;
  const isSessionOwner =
    !!session && !!me && String(session.userId) === String(me._id);
  // The builder's done state (TRA-519 B2): once the activity is complete, the
  // parked ideas carry the done screen's Build it now + Make it a Quest,
  // instead of the generic Start free play. Owner only, never a rehearsal.
  const builderDone =
    isSessionOwner &&
    session?.isTestDrive !== true &&
    !!session?.activityCompletedAt;
  const doneIdeaActions = useSavedForLaterActions({
    sessionId,
    canBuildNow: session?.freePlayEligible === true,
  });
  // A scholar who only plays this app gets no "Reset app state" (it wipes
  // their saved progress in an app they cannot rebuild). Staff and a scholar
  // building their own app keep it; it stays owner-only because
  // appStates.clearSessionState is owner-gated (TRA-317, TRA-477). Native has
  // no viewer chrome to hide, so only the Reset half applies here.
  const { showResetAppState: canResetAppState } = playSurfaceFor({
    mode,
    access: effectiveEditAccess,
    isStaff: !!me && me.role !== "scholar",
    isSessionOwner,
  });

  const htmlArtifact = useMemo(
    () => builderHtmlArtifact(artifacts, appId),
    [artifacts, appId],
  );
  // History and the inline version markers list only this app's versions: a
  // Restore writes into the app on screen.
  const revisions: HistoryRevision[] | undefined = useMemo(
    () => revisionsForApp(sessionRevisions, htmlArtifact?._id),
    [sessionRevisions, htmlArtifact?._id],
  );
  // An app that goes away (a switch, a restore) ends the presentation.
  const presentingApp = presenting && !!htmlArtifact;
  const htmlArtifactRef = useRef(htmlArtifact);
  useEffect(() => {
    htmlArtifactRef.current = htmlArtifact;
  }, [htmlArtifact]);
  // Every turn this builder opens names the app on screen, so the designer
  // or tutor acts on THAT app, never a newer one (TRA-519). Read through the
  // ref so a send captured before a render still names the current app.
  const openAppArg = (): { appArtifactId?: Id<"artifacts"> } => {
    const app = htmlArtifactRef.current;
    return app ? { appArtifactId: app._id } : {};
  };
  // Pinned to an older app (the `app` route param) when the AI makes a
  // brand-new one (create_code): follow it, so the screen shows the app just
  // built — web's VibecodeWorkshop does the same with `?app=`.
  const knownAppIdsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!artifacts) return;
    const fresh = newlyAddedHtmlApp(knownAppIdsRef.current, artifacts);
    knownAppIdsRef.current = htmlAppIds(artifacts);
    if (fresh && appId && String(fresh._id) !== appId) {
      router.setParams({ app: String(fresh._id) });
    }
  }, [artifacts, appId, router]);

  const builderDeliverable = useBuilderDeliverable({
    sessionId,
    activityId: sessionActivityId,
    role: appRole,
    artifacts,
    appArtifactId: htmlArtifact?._id,
    completed: !!session?.activityCompletedAt,
  });
  // The deliverable footer: only when the app IS the deliverable, and only for
  // the scholar who owns the session (submit is owner-only; free play has no
  // deliverable).
  const showDeliverableFooter =
    appRole === "work" &&
    builderDeliverable.kind === "artifact" &&
    !!htmlArtifact &&
    isSessionOwner &&
    !isFreePlay;

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
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      }
      return false;
    },
    [],
  );

  const handleRenderCheck = useCallback(
    async ({ checkId, artifactId }: RenderCheckRequest) => {
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

      const host = codeArtifactRef.current;
      try {
        const capture = await answerNativeRenderCheck({
          sessionId,
          streamId,
          checkId,
          captureSnapshot: host?.captureSnapshot ?? null,
          afterLoad: renderCheckLoadBoundary(baseline, artifactId),
          lastSentHash:
            lastSentSnapshotRef.current?.sessionId === sessionId
              ? lastSentSnapshotRef.current.hash
              : null,
          generateUploadUrl,
          uploadDataUrl: uploadImageDataUrl,
          answerRenderCheck,
          isStillActive: () =>
            activeRenderCheckIdRef.current === checkId &&
            activeStreamIdRef.current === streamId,
          deadlineAt,
          onCaptureError: (error) =>
            console.warn("[vibecode] render-check capture failed", error),
        });
        if (capture?.storageId && capture.hash) {
          lastSentSnapshotRef.current = {
            sessionId,
            hash: capture.hash,
          };
        }
        // The review was answered — the stage holds at "looking" until the model
        // starts an edit (→ fixing) or finishes (→ done). Mirrors web's onEvent.
        setBuildSignals((prev) => [...prev, { type: "renderCheckAnswered" }]);
      } catch (error) {
        console.warn("[vibecode] render-check answer failed", error);
      }
      if (activeRenderCheckIdRef.current === checkId) {
        activeRenderCheckIdRef.current = null;
      }
    },
    [
      answerRenderCheck,
      generateUploadUrl,
      sessionId,
      waitForRenderedArtifact,
    ],
  );

  const messages: VibecodeMessage[] = (data?.messages ?? [])
    .filter((message) => (message as { notebookEntry?: unknown }).notebookEntry === undefined)
    // The hidden opener the client auto-sends is a protocol token, never a bubble.
    .filter((message) => message.content !== OPENER_SENTINEL)
    // Web parity (VibecodeWorkshop): only the two speakers render here. A
    // `role: "tool"` row — a teacher whisper, an instruction — is never thread-
    // stamped, so leaving it in would both misattribute it to the designer and
    // (as today) draw a private whisper in the tutor's own voice.
    .filter((message) => message.role === "user" || message.role === "assistant")
    // An app-update turn that has not spoken (and may stay silent) draws no
    // bubble at all.
    .filter((message) => !isQuietAppUpdatePlaceholder(message))
    // Two threads, one session (TRA-301): Edit shows only designer turns, Play
    // only tutor turns — never both interleaved. A side app has one
    // unthreaded conversation and shows all of it.
    .filter(
      (message) =>
        !builderStance ||
        messageThread(message as { thread?: "designer" | "tutor" | null }) ===
          threadForMode(mode),
    )
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      stopRequestedAt: (message as { stopRequestedAt?: number }).stopRequestedAt,
      appSnapshotUrl: message.appSnapshotUrl,
      hasImage: !!message.imageId,
      imageUrl: message.imageUrl ?? null,
    }));

  // The tutor's newest line while the chat drawer is closed — read from the
  // Play (tutor) thread whatever the current mode, so flipping modes never
  // reads as a new line.
  const tutorLine = useUnreadTutorLine({
    messages: (data?.messages ?? []).filter(
      (message) =>
        message.role === "assistant" &&
        (!builderStance ||
          messageThread(message as { thread?: "designer" | "tutor" | null }) ===
            "tutor"),
    ),
    loaded: data !== undefined,
    chatOpen,
    streaming,
  });

  // Inline version markers: the assistant turn that produced a revision renders
  // "vN · Restore" — the SAME dense numbers History shows — and the newest
  // (index 0, newest first) is the current version, marked "vN · current".
  const revisionByMessageId = useMemo(() => {
    const map = new Map<
      string,
      { id: string; version: number; isCurrent: boolean }
    >();
    (revisions ?? []).forEach((rev, index) => {
      if (rev.messageId) {
        map.set(rev.messageId, {
          id: rev.id,
          version: rev.version,
          isCurrent: index === 0,
        });
      }
    });
    return map;
  }, [revisions]);

  // Coarse clock for the saved-at readout. The first tick is scheduled async so
  // the effect body never calls setState synchronously.
  useEffect(() => {
    const first = setTimeout(() => setNowTick(Date.now()), 0);
    const id = setInterval(() => setNowTick(Date.now()), SAVED_AT_TICK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);

  // Leaving the Code view (to Preview, or to Play, which never shows code)
  // unmounts the editor, so its pending hand edit is flushed first. A save
  // that cannot land — an unresolved "changed somewhere else" conflict —
  // keeps the scholar in the Code view, where that banner is, rather than
  // stranding the edit (the web twin likewise stays in Edit with a notice).
  const leaveCodeView = useCallback(async (): Promise<boolean> => {
    try {
      await flushPendingArtifactSaves();
      return true;
    } catch {
      Alert.alert(
        "Finish saving your code",
        "Choose a code version in the Code view before switching.",
      );
      return false;
    }
  }, []);
  const handleModeChange = useCallback(
    async (next: WorkshopMode): Promise<boolean> => {
      Haptics.selectionAsync();
      if (next !== "edit" && !(await leaveCodeView())) return false;
      setModeRequest(next);
      return true;
    },
    [leaveCodeView],
  );
  const handleCodeViewChange = useCallback(
    async (next: CodeView) => {
      if (next === "preview" && !(await leaveCodeView())) return;
      setCodeViewRequest(next);
    },
    [leaveCodeView],
  );

  // Present: a Code-view hand edit is flushed first (its editor unmounts
  // while presenting), and every sheet closes so only the app is on screen.
  const startPresenting = useCallback(() => {
    Haptics.selectionAsync();
    void leaveCodeView().then((ok) => {
      if (!ok) return;
      setChatOpen(false);
      setHistoryOpen(false);
      setYourWorkOpen(false);
      setPresenting(true);
    });
  }, [leaveCodeView]);
  const stopPresenting = useCallback(() => setPresenting(false), []);

  // "‹ Chat": back to this session's chat view. Leaving unmounts a Code-view
  // editor, so its pending hand edit is flushed first (and a save that cannot
  // land keeps the scholar here, where that banner is).
  const handleBackToChat = useCallback(async () => {
    Haptics.selectionAsync();
    if (!(await leaveCodeView())) return;
    router.setParams({ view: undefined, app: undefined });
  }, [leaveCodeView, router]);

  // A builder-primary session holding more than one app (a teacher's starter
  // plus one the designer made later) switches between them in the header;
  // a chat-primary session reaches each app through its chat card instead.
  // Empty for a single app: no switcher. Labels match web byte for byte.
  const appChoices = useMemo(
    () => (builderPrimary ? builderAppChoices(artifacts) : []),
    [builderPrimary, artifacts],
  );
  const openAppId = htmlArtifact ? String(htmlArtifact._id) : null;
  const openAppLabel =
    appChoices.find((c) => c.id === openAppId)?.label ??
    appChoices[appChoices.length - 1]?.label ??
    null;
  // A native SwiftUI menu: an action sheet presented from the navigation
  // header never appears on iPad.
  const handleSwitchApp = useCallback(
    (picked: string) => {
      if (picked === openAppId) return;
      Haptics.selectionAsync();
      // Switching unmounts a Code-view editor: flush its hand edit first.
      void leaveCodeView().then((ok) => {
        if (ok) router.setParams({ app: picked });
      });
    },
    [openAppId, leaveCodeView, router],
  );

  const handleRestore = useCallback(
    async (target: { id: string; version: number }) => {
      const current = htmlArtifactRef.current;
      if (!current || restoring) return;
      setRestoring(true);
      const outcome = await restoreRevision({
        convex,
        saveArtifact,
        artifact: current,
        target,
      });
      setRestoring(false);
      if (outcome === "ok") {
        setHistoryOpen(false);
        return;
      }
      Alert.alert(
        "Rabbithole",
        outcome === "conflict"
          ? "The app changed — reopen History and try again"
          : "Couldn't restore that revision",
      );
    },
    [convex, restoring, saveArtifact],
  );

  // Play → Reset app state: clear the SERVER-persisted app-state row first (the
  // host re-posts it after every reload, so a bare remount would come straight
  // back to the same state), then remount the WebView to rebuild the current
  // revision from a clean slate.
  const handleResetAppState = useCallback(async () => {
    const current = htmlArtifactRef.current;
    if (current) {
      // Drop the host's debounced patch and wait out in-flight writes first,
      // or the unmount flush after the remount could re-create the state.
      await codeArtifactRef.current?.discardPendingAppState();
      const cleared = await clearSessionState({ artifactId: current._id })
        .then(() => true)
        .catch((error: unknown) => {
          console.warn("[vibecode] reset app state failed", error);
          return false;
        });
      if (!cleared) {
        // No remount will re-arm the paused writer, so resume it here or the
        // still-mounted app can never persist its state again.
        codeArtifactRef.current?.resumeAppStateWrites();
        Alert.alert("Rabbithole", "Couldn't reset the app state");
        return;
      }
    }
    setResetNonce((nonce) => nonce + 1);
  }, [clearSessionState]);

  // Stop the in-flight reply: ask the server to finalize at the current partial,
  // then abort the local reader. The partial stays on screen — the finalized row
  // lands via the reactive query within ≤1.5s.
  const stopStream = () => {
    stopRequestedRef.current = true;
    if (liveAssistantIdRef.current) {
      void requestStop({ sessionId }).catch((e) =>
        console.warn("[vibecode] requestStop failed", e),
      );
    }
    abortRef.current?.abort();
  };

  const onChangeInput = (next: string) => {
    // Any edit means the box is no longer the send just dispatched.
    sentComposerRef.current = null;
    setInput(next);
  };

  // Reset the build signals at the start of each stream. `origin` anchors the
  // elapsed clock: the teacher build kickoff passes `openedAt` so the clock
  // measures one stable interval from when the build was first requested, even
  // across kickoff retries. A genuinely new build — a later user turn — passes
  // nothing and starts a fresh clock.
  const resetBuildSignals = useCallback((origin?: number) => {
    setStreamStartedAt(origin ?? Date.now());
    setBuildSignals([{ type: "streamStart" }]);
  }, []);

  // The shared session-stream reader: run the SSE loop, updating the streaming
  // UI, build signals, and render-check handling. Used by BOTH a user turn and
  // the teacher-build kickoff so the SSE loop lives once. Each caller builds its
  // own fetch (their bodies differ) and hands the response here. Returns true if
  // the reader drained (stream ended, incl. a user Stop), false on a
  // dropped/thrown fetch so the kickoff caller can retry.
  const runProjectStreamFromResponse = useCallback(
    async (
      resp: Awaited<ReturnType<typeof expoFetch>>,
      signal: AbortSignal,
      // An app-update turn is background work: a failure never interrupts
      // the scholar with an alert (the next update or typed turn covers it).
      options?: { quiet?: boolean },
    ): Promise<boolean> => {
      try {
        const reader = resp.body?.getReader();
        let full = "";
        const handleEvent = (ev: TutorStreamEvent) => {
          // Mid-turn backstop for the same clamp the mutation reports: the
          // verdict changed between the mutation and the stream, so follow what
          // actually ran rather than leaving designer chrome over a tutor turn.
          if (ev.workshopMode === "play") setModeRequest("play");
          if (ev.toolStart?.name && ev.toolStart.name !== "generate_image") {
            if (CODE_TOOLS.has(ev.toolStart.name)) {
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
                      codeArtifactRef.current?.currentLoadBoundary() ?? null,
                  }
                : null;
              setBuilding(true);
            }
          }
          if (ev.renderCheck) {
            setBuildSignals((prev) => [...prev, { type: "renderCheck" }]);
            void handleRenderCheck(ev.renderCheck);
          }
          if (
            ev.toolComplete?.name &&
            ev.toolComplete.name !== "generate_image"
          ) {
            if (CODE_TOOLS.has(ev.toolComplete.name)) {
              const toolName = ev.toolComplete.name;
              setBuildSignals((prev) => [
                ...prev,
                { type: "codeToolComplete", name: toolName },
              ]);
              setBuilding(false);
            }
          }
          if (ev.text) {
            full += ev.text;
            setStreamingText(full);
          }
          if (ev.newAssistantMsg) {
            liveAssistantIdRef.current = ev.newAssistantMsg;
            full = "";
          }
          if (ev.error) {
            setBuildSignals((prev) => [...prev, { type: "error" }]);
            if (!options?.quiet) {
              Alert.alert("Rabbithole", tutorStreamErrorMessage(ev.error));
            }
            activeRenderCheckIdRef.current = null;
          }
          if (ev.done) {
            setBuildSignals((prev) => [...prev, { type: "done" }]);
            activeRenderCheckIdRef.current = null;
          }
        };
        // A stream that closes without `done` or `error` (the server died
        // mid-turn) reaches handleEvent as an error event.
        if (reader) await readTutorSse(reader, handleEvent);
        return true;
      } catch (error) {
        // A user Stop aborts the reader: the turn is over, not a dropped fetch
        // to retry. Key this on the SIGNAL, not the error name — expo/fetch
        // surfaces an abort as `Expo.FetchRequestCanceledException`, never a DOM
        // `AbortError` (seen live 2026-09-15: a name check misread a Stop as a
        // dropped fetch and the kickoff silently relaunched the build).
        if (signal.aborted || (error as Error)?.name === "AbortError") {
          return true;
        }
        console.warn("[vibecode] stream failed", error);
        return false;
      }
    },
    [handleRenderCheck],
  );

  // `appUpdate` turns are opened by the app-update queue (useAppTutorUpdates),
  // which only calls this while no reply streams; it learns the mutation's
  // outcome through `onPrepared` and the stream continues on its own.
  const sendTutorTurn = async (
    text: string,
    appUpdate?: {
      batch: AppTutorUpdateBatch;
      onPrepared: (result: AppTutorSendResult) => void;
    },
    spoken = false,
  ): Promise<boolean> => {
    // A staged photo rides the scholar's own turn, typed or spoken, and may be
    // sent alone. An app update is the app talking, never the scholar's photo.
    const imageId = appUpdate ? null : image.imageId;
    if (!text && !appUpdate && !imageId) return false;
    if (!appUpdate && image.uploading) return false;
    const inputModality = appUpdate ? "app" : spoken ? "spoken" : "typed";
    const appContext = appUpdate
      ? newestAppTutorAskContext(appUpdate.batch)
      : undefined;
    // The teacher-build kickoff is launching (its mutation is in flight) but no
    // stream owns the turn slot yet: a send now would race it for `abortRef` /
    // `turnSeqRef` and leave two readers pointing at the wrong controller. Hold
    // the send (the composer keeps its text) — once the kickoff is streaming,
    // the steer path below stops it and takes over cleanly.
    if (kickoffPendingRef.current && !streamBusyRef.current) return false;
    // An untouched composer still holding the send just dispatched is a
    // stale-closure resubmit, not a new turn (see sentComposerRef).
    const composerSnapshot =
      inputModality === "typed" ? composerPayloadKey(text, imageId) : null;
    if (
      composerSnapshot !== null &&
      sentComposerRef.current === composerSnapshot
    ) {
      return false;
    }
    // An app update opens its turn BEFORE touching any streaming state: a
    // refusal (`held` / `busy`) must leave the screen — and the queue's idle
    // signal — exactly as they were, or the queue would re-drain on the flip.
    // While that mutation is in flight it holds the claim, and a typed send
    // waits it out (the composer keeps its text) — otherwise the app update
    // would resume after it, take the turn slot, and its cleanup would wipe the
    // typed reply mid-stream. Same claim as the session screen's (@/lib/sendLock).
    if (!appUpdate && appUpdateClaimRef.current.isLocked()) return false;
    // A hand edit in the Code view must reach the server before the builder
    // reads the app this turn. Flushed BEFORE any streaming state changes, so
    // a save that cannot land leaves the composer, and any live build, exactly
    // as they were — the session screen's order and message.
    if (!appUpdate) {
      try {
        await flushPendingArtifactSaves();
      } catch {
        Alert.alert(
          "Finish saving your code",
          "Choose a code version in the Code view before sending your message.",
        );
        return false;
      }
    }
    let appUpdateTurn: Extract<
      Awaited<ReturnType<typeof startAppUpdateTurn>>,
      { status: "started" }
    > | null = null;
    if (appUpdate) {
      // A typed turn that began after the queue last saw us idle owns the slot.
      if (streamBusyRef.current || !appUpdateClaimRef.current.acquire()) {
        appUpdate.onPrepared("busy");
        return false;
      }
      try {
        const turn = await startAppUpdateTurn({
          sessionId,
          asks: appUpdate.batch.asks,
          ...openAppArg(),
        });
        appUpdate.onPrepared(appTutorSendResultFromStatus(turn.status));
        if (turn.status !== "started") return false;
        appUpdateTurn = turn;
      } catch {
        appUpdate.onPrepared("failed");
        return false;
      } finally {
        appUpdateClaimRef.current.release();
      }
    }
    // Steer: a send while a reply is streaming stops it first, then sends.
    if (streaming && !appUpdate) stopStream();
    const myTurn = ++turnSeqRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    stopRequestedRef.current = false;
    if (inputModality === "typed") {
      setInput("");
      // Synchronous, unlike setInput — this is what closes the commit gap.
      sentComposerRef.current = composerSnapshot;
    }
    streamBusyRef.current = true;
    setAppUpdateStreaming(!!appUpdate);
    setStreaming(true);
    setStreamingText("");
    // A user turn starts a fresh build clock (no origin). Reset here, BEFORE the
    // streaming state renders, so the card/line never flash the previous turn's
    // stage and elapsed during the mutation + snapshot-upload window. An app
    // update is never a build.
    if (!appUpdate) resetBuildSignals();
    let messagePersisted = false;
    // The mode this turn runs in is fixed at send time: the mutation, the
    // stream body, and the thread the turn lands in must all agree even if the
    // control is flipped while the reply streams. An app update is always play
    // (the server opens it in the tutor thread), and never snaps the screen.
    const turnMode = appUpdate ? "play" : mode;
    setStreamingThread(threadForMode(turnMode));
    try {
      const res =
        appUpdateTurn ??
        (await sendMessage({
          sessionId,
          message: text,
          ...(imageId ? { imageId } : {}),
          inputModality: spoken ? "spoken" : "typed",
          mode: turnMode,
          ...openAppArg(),
        }));
      messagePersisted = true;
      // The photo is persisted with this turn; only now is it safe to drop.
      if (imageId) image.clear();
      // The server clamped a requested Edit to Play (the edit policy said no):
      // the turn is ALREADY in the tutor thread, so snap now rather than
      // waiting for the stream, which may never open (a 429/403 returns before
      // any event).
      if (res.workshopMode === "play" && turnMode === "edit") {
        setModeRequest("play");
      }
      liveAssistantIdRef.current = res.assistantMsgId;
      activeStreamIdRef.current = res.streamId;
      // A Stop tapped during the pre-mutation window: the assistant row now
      // exists, so finalize it server-side and skip the (already-aborted) fetch.
      // The finally cleans up this turn as an aborted one.
      if (stopRequestedRef.current || controller.signal.aborted) {
        void requestStop({ sessionId }).catch((e) =>
          console.warn("[vibecode] requestStop failed", e),
        );
        return true;
      }
      let appSnapshot:
        | { storageId: Id<"_storage">; hash: string }
        | null = null;
      // A character-only update adds no user row, so a snapshot would land on
      // the scholar's last typed message instead: send none.
      if (!appUpdate || appUpdate.batch.asks.length > 0) {
        try {
          appSnapshot = await uploadChangedAppSnapshot({
            captureSnapshot:
              codeArtifactRef.current?.captureSnapshot ?? null,
            lastSentHash:
              lastSentSnapshotRef.current?.sessionId === sessionId
                ? lastSentSnapshotRef.current.hash
                : null,
            generateUploadUrl,
            uploadDataUrl: uploadImageDataUrl,
          });
        } catch (error) {
          console.warn("[vibecode] app snapshot upload failed", error);
        }
      }
      if (stopRequestedRef.current || controller.signal.aborted) {
        void requestStop({ sessionId }).catch((e) =>
          console.warn("[vibecode] requestStop failed", e),
        );
        return true;
      }
      if (appSnapshot) {
        lastSentSnapshotRef.current = {
          sessionId,
          hash: appSnapshot.hash,
        };
      }
      const resp = await expoFetch(`${convexSiteUrl}/session-stream`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          sessionId: res.sessionId,
          streamId: res.streamId,
          assistantMsgId: res.assistantMsgId,
          platform: "native",
          supportsRenderCheck: true,
          mode: turnMode,
          ...(appUpdate && appUpdate.batch.asks.length > 0
            ? {
                appRequest: {
                  ...(appContext ? { context: appContext } : {}),
                },
              }
            : {}),
          ...(appSnapshot
            ? { appSnapshotStorageId: appSnapshot.storageId }
            : {}),
        }),
      });
      await runProjectStreamFromResponse(resp, controller.signal, {
        quiet: !!appUpdate,
      });
    } catch (error) {
      // expo/fetch reports an abort as FetchRequestCanceledException, so check
      // the signal rather than the error name.
      if (!controller.signal.aborted) {
        console.warn("[vibecode] stream failed", error);
      }
      // The server refused the turn itself (a locked Quest build step): say
      // why, instead of failing silently.
      if (!messagePersisted) alertRefusal(error);
    } finally {
      // Only the turn that still owns the stream resets shared UI state — a
      // steered-away turn leaves the newer turn's state intact.
      if (turnSeqRef.current === myTurn) {
        streamBusyRef.current = false;
        setAppUpdateStreaming(false);
        setStreaming(false);
        setStreamingText("");
        setBuilding(false);
        liveAssistantIdRef.current = null;
        activeRenderCheckIdRef.current = null;
        activeStreamIdRef.current = null;
        if (abortRef.current === controller) abortRef.current = null;
      }
    }
    return messagePersisted;
  };

  // "Check my work" for a deliverable the builder shows (the app itself): the
  // twin of the session screen's onRubricCheck. Submit the work, then — when it
  // has a rubric — stream the tutor's silent check turn (startRubricCheck
  // persists only the assistant placeholder; the stream injects the
  // instruction, so no message the scholar didn't type reaches the transcript).
  const runRubricCheck = async (
    artifact: Doc<"artifacts">,
    shouldCheck: boolean,
  ): Promise<void> => {
    if (!sessionActivityId || streamBusyRef.current || kickoffPendingRef.current) {
      return;
    }
    try {
      await flushPendingArtifactSaves();
    } catch {
      Alert.alert(
        "Finish saving your code",
        "Choose a code version in the Code view before checking it.",
      );
      return;
    }
    setCheckBusy(true);
    const myTurn = ++turnSeqRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await submitDeliverable({
        sessionId,
        activityId: sessionActivityId,
        artifactId: artifact._id,
        intent: shouldCheck ? "check" : "send",
      });
      if (!shouldCheck) return;
      // The check is a turn of the mode on screen, so a check pressed in Play
      // lands in the tutor thread (a side app has no threads).
      const res = await startRubricCheck({
        sessionId,
        ...(builderStance ? { mode } : {}),
        ...openAppArg(),
      });
      stopRequestedRef.current = false;
      streamBusyRef.current = true;
      setStreaming(true);
      setStreamingText("");
      setStreamingThread(threadForMode(mode));
      liveAssistantIdRef.current = res.assistantMsgId;
      activeStreamIdRef.current = res.streamId;
      const resp = await expoFetch(`${convexSiteUrl}/session-stream`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          sessionId: res.sessionId,
          streamId: res.streamId,
          assistantMsgId: res.assistantMsgId,
          platform: "native",
          supportsRenderCheck: true,
          rubricCheck: { artifactTitle: artifact.title },
        }),
      });
      await runProjectStreamFromResponse(resp, controller.signal, {
        quiet: true,
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        console.warn("[rubric-check] failed", error);
        Alert.alert(
          shouldCheck ? "Couldn't check your work" : "Couldn't send your work",
          "Your work is still saved. Check your connection and try again.",
        );
      }
    } finally {
      setCheckBusy(false);
      if (turnSeqRef.current === myTurn) {
        streamBusyRef.current = false;
        setStreaming(false);
        setStreamingText("");
        liveAssistantIdRef.current = null;
        activeStreamIdRef.current = null;
        if (abortRef.current === controller) abortRef.current = null;
      }
    }
  };
  const handleRetryCriteria = async () => {
    try {
      await builderDeliverable.retryCriteria();
    } catch (error) {
      Alert.alert(
        "Couldn't prepare the check",
        error instanceof Error ? error.message : "Please try again.",
      );
    }
  };

  // App → tutor updates (asks and character/judge events) wait in one queue
  // and go out between replies. Only the owner drains: a teacher opening this
  // session hosts the same app but must not start the scholar's turns.
  const appTutorUpdates = useAppTutorUpdates({
    sessionId,
    enabled: isSessionOwner,
    busy: streaming || buildLaunching,
    send: (batch) =>
      settleAppTutorSend((onPrepared) =>
        sendTutorTurn("", { batch, onPrepared }),
      ),
  });
  // An app-update turn stays invisible until the tutor speaks — and in Edit
  // its reply lands in the (hidden) tutor thread, so it stays invisible there.
  const quietTurn =
    streaming &&
    appUpdateStreaming &&
    (!tutorVoice || !streamingText.trim());
  const visiblyStreaming = streaming && !quietTurn;

  const handleSend = () => {
    appTutorUpdates.clearAppAi();
    tutorLine.markRead();
    return sendTutorTurn(input.trim());
  };
  // The composer's mic — the same recorder and RecordingBar the session
  // screen's chat uses: the bar's check transcribes and sends a "spoken" turn
  // (the tutor sees it labelled [Dictated …]); the composer text is untouched.
  const voice = useStreamingDictation((text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    appTutorUpdates.clearAppAi();
    tutorLine.markRead();
    void sendTutorTurn(trimmed, undefined, true);
  }, sessionId);
  const onMicStart = async () => {
    if (appStatusBus.isMicOwned()) return; // the writing box is dictating — one recorder at a time
    getNativeTTS().stop(); // don't record over the tutor's voice
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await voice.start();
  };
  const onMicStop = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    voice.stop();
  };
  const onMicCancel = () => {
    Haptics.selectionAsync();
    voice.cancel();
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
    // Play thread — say so once, or a builder testing a hint button sees
    // nothing happen. A side app has one conversation, so no notice.
    if (
      builderStance &&
      mode === "edit" &&
      isSessionOwner &&
      !editAskNoticeShownRef.current
    ) {
      editAskNoticeShownRef.current = true;
      Alert.alert("Rabbithole", EDIT_MODE_ASK_NOTICE);
    }
  };

  const toggleChat = useCallback(() => {
    Haptics.selectionAsync();
    setChatOpen((open) => !open);
  }, []);

  // Autosave-to-starter failed on the last designer turn (server marker, F4):
  // tell the teacher once per failure, like web's toast, and clear on success.
  useEffect(() => {
    if (
      autosaveFailedAt != null &&
      autosaveFailShownRef.current !== autosaveFailedAt
    ) {
      autosaveFailShownRef.current = autosaveFailedAt;
      Alert.alert(
        "Couldn't save the latest app to the activity starter",
        "Send another message to retry the save.",
      );
    }
  }, [autosaveFailedAt]);

  useEffect(() => {
    if (!chatOpen || !wantsComposerFocus) return;
    const frame = requestAnimationFrame(() => {
      composerRef.current?.focus();
      setWantsComposerFocus(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [chatOpen, wantsComposerFocus]);

  // On unmount: clear a scheduled kickoff retry and abort whichever stream this
  // screen owns (kickoff or user turn), so an off-screen reader cannot keep
  // dispatching render-check work and state updates. Mirrors web's
  // useAgentStream cleanup; the server finalizes the turn on its own.
  useEffect(() => {
    return () => {
      if (kickoffRetryTimerRef.current) {
        clearTimeout(kickoffRetryTimerRef.current);
      }
      abortRef.current?.abort();
    };
  }, []);

  // The teacher-build kickoff (TRA-319), ported from web's VibecodeWorkshop and
  // now OWNED here (the session shell skips vibecode). A teacher build opens
  // itself: the first assistant-only turn builds the requested first cut through
  // the SAME session-stream path a user turn uses, so its events (render checks,
  // code tools) feed this screen's preview. One launch per session, one
  // automatic retry on a dropped fetch, then the preview settles into the
  // stopped card.
  // The Workshop opens by building on a teacher build hand-off (a test drive)
  // or on a scholar's build-first Quest step (`scholarBuildKickoff`, which the
  // server sets only for the session's owner). Same one-shot launch + retry.
  const opensWithBuild =
    (data?.session.isTestDrive === true &&
      data.session.teacherBuildKickoff === true) ||
    data?.session.scholarBuildKickoff === true;
  useEffect(() => {
    if (
      !data ||
      streaming ||
      kickoffPendingRef.current ||
      !opensWithBuild
    ) {
      return;
    }
    // Same ownership/liveness guard the shell used before it handed this off.
    if (
      data.session.isArchived ||
      isTeacherArchived(data.session) ||
      data.session.isOffline ||
      !me ||
      String(me._id) !== String(data.session.userId)
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
      (hasNoMessages ||
        activeKickoffPlaceholder ||
        kickoffManualRetryRef.current);
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
        const myTurn = ++turnSeqRef.current;
        const controller = new AbortController();
        abortRef.current = controller;
        stopRequestedRef.current = false;
        try {
          const result = await startActivityKickoff({ sessionId });
          if (!result) {
            // Nothing recoverable to relaunch — settle rather than keep a live
            // card ticking forever.
            setBuildLaunching(false);
            return;
          }
          if (result.status === "pending") {
            scheduleRetry(result.retryAfterMs + 50, false);
            return;
          }
          // Set up the live-turn state so Stop and steer work during the kickoff
          // exactly as during a normal turn.
          streamBusyRef.current = true;
          setStreaming(true);
          setStreamingText("");
          setStreamingThread("designer");
          liveAssistantIdRef.current = result.assistantMsgId;
          activeStreamIdRef.current = result.streamId;
          // The kickoff anchors the elapsed clock at openedAt so retries keep
          // one stable clock.
          resetBuildSignals(openedAt);
          const resp = await expoFetch(`${convexSiteUrl}/session-stream`, {
            method: "POST",
            signal: controller.signal,
            headers: {
              "Content-Type": "application/json",
              ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
            },
            body: JSON.stringify({
              sessionId: result.sessionId,
              streamId: result.streamId,
              assistantMsgId: result.assistantMsgId,
              platform: "native",
              supportsRenderCheck: true,
              kickoff: true,
              // A build kickoff (teacher or scholar) builds the app — always Edit.
              mode: "edit",
            }),
          });
          const completed = await runProjectStreamFromResponse(
            resp,
            controller.signal,
          );
          if (!completed) {
            // A dropped fetch (no user stop) — retry once, then settle.
            scheduleRetry(1_000, true);
          } else {
            // The stream ended (finished, or a user Stop that keeps the partial
            // text). Let the preview settle: an app → the live app, no app →
            // the stopped recovery card.
            setBuildLaunching(false);
          }
        } catch (error) {
          if (controller.signal.aborted) {
            // Stop tapped before the fetch returned headers: the fetch itself
            // throws. A user stop settles the build; it is never retried.
            setBuildLaunching(false);
          } else {
            console.warn("[vibecode] teacher build kickoff failed", error);
            scheduleRetry(1_000, true);
          }
        } finally {
          kickoffPendingRef.current = false;
          // Only the turn that still owns the stream resets shared UI state.
          if (turnSeqRef.current === myTurn) {
            streamBusyRef.current = false;
            setStreaming(false);
            setStreamingText("");
            setBuilding(false);
            liveAssistantIdRef.current = null;
            activeRenderCheckIdRef.current = null;
            activeStreamIdRef.current = null;
            if (abortRef.current === controller) abortRef.current = null;
          }
        }
      })();
    }, 0);
  }, [
    data,
    opensWithBuild,
    streaming,
    me,
    sessionId,
    startActivityKickoff,
    runProjectStreamFromResponse,
    resetBuildSignals,
    openedAt,
    authToken,
    kickoffRetryNonce,
  ]);

  // The settled recovery card's "Try again": re-run the SAME teacher-build
  // kickoff via its existing retry machinery (never a second launcher). Arm a
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

  // Honest build progress: the active stage derived from the LIVE stream signals
  // (see vendor/shared/buildStage.ts), and what the preview pane should show.
  const buildStage = useMemo(
    () => deriveBuildStage(buildSignals),
    [buildSignals],
  );
  const buildStartedAt = streamStartedAt ?? openedAt;
  // The designer's turns are builds. A side app's tutor turn becomes one only
  // once it starts writing the app (web's VibecodeWorkshop, same rule).
  const showBuildStages = builderStance
    ? mode === "edit"
    : buildSignals.some((signal) => signal.type === "codeToolStart");
  const buildPreview = deriveBuildPreview({
    hasArtifact: !!htmlArtifact,
    isStreaming: streaming,
    launching: buildLaunching,
    hasBuildRequest: isBuildSession,
    buildStarted: streamStartedAt !== null,
    ended: buildStage.ended,
  });

  const { statusLabel, hasYourWork } = builderDeliverable;
  const openYourWork = useCallback(() => {
    Haptics.selectionAsync();
    setYourWorkOpen(true);
  }, []);

  // The header (a SwiftUI host inside it) is rebuilt only when something it
  // shows changes — never per streamed token: `setStreamingText` re-renders
  // this screen on every SSE chunk, and a fresh `options` object each time
  // would push a header re-layout into React Navigation at token rate.
  const headerOptions = useMemo(
    () => ({
          title: headerTitle,
          // Set explicitly: options merge, so leaving Present must undo it.
          headerShown: true,
          gestureEnabled: true,
          // A chat-primary session's way back to its chat. A builder-primary
          // session keeps the stack's own back chevron.
          ...(builderPrimary
            ? {}
            : {
                headerLeft: () => (
                  <Pressable
                    onPress={() => void handleBackToChat()}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={APP_SURFACE_COPY.backToChat}
                    style={styles.headerGhost}
                  >
                    <SymbolView
                      name="chevron.left"
                      size={16}
                      tintColor={colors.violet}
                    />
                    <Text
                      style={[styles.headerGhostText, { color: colors.violet }]}
                    >
                      {APP_SURFACE_COPY.backToChat}
                    </Text>
                  </Pressable>
                ),
              }),
          headerTitle: () => (
            <View style={styles.headerTitleBlock}>
              {/* The activity title with a small quiet-gray "App" eyebrow —
                  never "App designer · <title>". */}
              <Text style={[styles.headerEyebrow, { color: colors.fgMuted }]}>
                App
                {isFreePlay ? (
                  <Text style={{ color: colors.violet }}> · Free play</Text>
                ) : null}
              </Text>
              <Text
                style={[styles.headerTitleText, { color: colors.fg }]}
                numberOfLines={1}
              >
                {headerTitle}
              </Text>
            </View>
          ),
          headerRight: () => (
            <View style={styles.headerRight}>
              {showModeControl ? (
                <VibecodeModeControl
                  mode={mode}
                  editUnlocked={editUnlocked}
                  teacherEdit={teacherEditOverride}
                  onChange={handleModeChange}
                />
              ) : null}
              {mode === "edit" && isBuildSession ? (
                <Text style={[styles.savedAt, { color: colors.fgMuted }]}>
                  {formatSavedAt(savedAt, nowTick)}
                </Text>
              ) : null}
              {mode === "edit" ? (
                <Pressable
                  onPress={() => {
                    Haptics.selectionAsync();
                    setHistoryOpen(true);
                  }}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="App version history"
                  style={styles.headerGhost}
                >
                  <SymbolView
                    name="clock.arrow.circlepath"
                    size={16}
                    tintColor={colors.violet}
                  />
                  <Text style={[styles.headerGhostText, { color: colors.violet }]}>
                    History
                  </Text>
                </Pressable>
              ) : canResetAppState ? (
                <Pressable
                  onPress={() => {
                    Haptics.selectionAsync();
                    void handleResetAppState();
                  }}
                  disabled={!htmlArtifact}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Reset app state"
                  style={[
                    styles.headerGhost,
                    !htmlArtifact ? styles.headerGhostDisabled : null,
                  ]}
                >
                  <SymbolView
                    name="arrow.clockwise"
                    size={16}
                    tintColor={colors.violet}
                  />
                  <Text style={[styles.headerGhostText, { color: colors.violet }]}>
                    Reset app state
                  </Text>
                </Pressable>
              ) : null}
              {statusLabel ? (
                // A side app: the activity's own work, named with where it
                // stands. Quiet by design; it opens the Your work sheet.
                <Pressable
                  onPress={openYourWork}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={statusLabel}
                  style={[styles.statusChip, { borderColor: colors.border }]}
                >
                  <Text style={[styles.statusChipText, { color: colors.fgMuted }]}>
                    {statusLabel}
                  </Text>
                </Pressable>
              ) : null}
              {/* One entry point: when the status chip names the work, it IS the
                  way in (web does the same). */}
              {hasYourWork && !statusLabel ? (
                <Pressable
                  onPress={openYourWork}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={APP_SURFACE_COPY.yourWork}
                  style={styles.headerGhost}
                >
                  <SymbolView
                    name="doc.text"
                    size={16}
                    tintColor={colors.violet}
                  />
                  <Text style={[styles.headerGhostText, { color: colors.violet }]}>
                    {APP_SURFACE_COPY.yourWork}
                  </Text>
                </Pressable>
              ) : null}
              {htmlArtifact ? (
                <Pressable
                  onPress={startPresenting}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={APP_SURFACE_COPY.presentAccessibility}
                  style={styles.headerGhost}
                >
                  <SymbolView
                    name="rectangle.on.rectangle"
                    size={16}
                    tintColor={colors.violet}
                  />
                  <Text style={[styles.headerGhostText, { color: colors.violet }]}>
                    {APP_SURFACE_COPY.present}
                  </Text>
                </Pressable>
              ) : null}
              {/* The chat sheet is a TOGGLE, not a consequence of the mode:
                  closed by default, opened by this rightmost ghost button in
                  every state. Edit | Play swaps which thread it holds. */}
              <Pressable
                onPress={toggleChat}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={chatOpen ? "Hide chat" : "Chat"}
                style={styles.headerGhost}
              >
                <SymbolView
                  name="bubble.left.and.bubble.right.fill"
                  size={16}
                  tintColor={colors.violet}
                />
                <Text style={[styles.headerGhostText, { color: colors.violet }]}>
                  {chatOpen ? "Hide chat" : "Chat"}
                </Text>
              </Pressable>
            </View>
          ),
    }),
    [
      headerTitle,
      isFreePlay,
      colors,
      showModeControl,
      mode,
      editUnlocked,
      handleModeChange,
      isBuildSession,
      savedAt,
      nowTick,
      htmlArtifact,
      canResetAppState,
      handleResetAppState,
      chatOpen,
      toggleChat,
      teacherEditOverride,
      builderPrimary,
      handleBackToChat,
      statusLabel,
      hasYourWork,
      openYourWork,
      startPresenting,
    ],
  );

  // Until the session read resolves the verdict is "hidden" and the mode is
  // Play — so render nothing mode-specific yet (web returns a spinner here
  // too): otherwise every cold open paints Reset app state, "Tutor", and an
  // empty tutor thread for one round-trip before flipping to Edit.
  if (data === undefined) {
    return (
      <>
        <Stack.Screen options={{ title: headerTitle }} />
        <View style={[styles.root, styles.loading, { backgroundColor: colors.bg }]}>
          <ActivityIndicator color={colors.violet} />
        </View>
      </>
    );
  }

  // Put away by a teacher. The session route catches this before mounting the
  // builder; this covers a builder already open when the archive lands.
  if (isTeacherArchived(data.session)) {
    return <TeacherArchivedSession title={headerTitle} />;
  }

  return (
    <>
      {/* The top bar lives in the expo-router header rather than a second
          in-screen bar: the header already owns that row, and stacking our own
          bar under it would print the activity title twice and eat iPad height.
          The stack's back chevron stays and there is no hamburger — a pushed
          iOS screen with neither would strand the scholar; this deviation from
          ruling 5 is called out in the PR for a ruling. The title block uses
          the SAME headerTitle render-prop idiom the session screen already
          uses for its homework eyebrow. */}
      <Stack.Screen
        options={presentingApp ? PRESENT_SCREEN_OPTIONS : headerOptions}
      />

      {/* The cyan "Rehearse manually" starter strip is gone (TRA-301): autosave
          + History replace its Save, and "Scholars start from" belongs to the
          activity designer. Its web twin (ManualRehearsalBanner) came off the
          same route in PR 2. */}
      <View style={[styles.root, { backgroundColor: colors.bg }]}>
        {htmlArtifact ? (
          // deriveBuildPreview returns "app" exactly when an artifact exists.
          <View style={styles.previewWrap}>
            {!presentingApp && (mode === "edit" || openAppLabel) ? (
              // The app switcher lives here, not in the navigation header:
              // a menu presented from the iOS 26 header toolbar never opens.
              <View style={[styles.appTopRow, { borderBottomColor: colors.border }]}>
                <View style={styles.appTopRowToggle}>
                  {mode === "edit" ? (
                    <CodeViewToggle
                      view={codeView}
                      onChange={(next) => void handleCodeViewChange(next)}
                    />
                  ) : null}
                </View>
                {openAppLabel ? (
                  <View style={styles.appSwitcherWrap}>
                    <Host matchContents>
                      <Menu
                        label={openAppLabel}
                        systemImage="chevron.up.chevron.down"
                        modifiers={[
                          tint(colors.violet),
                          accessibilityLabel(`${SWITCH_APP_LABEL}: ${openAppLabel}`),
                        ]}
                      >
                        {appChoices.map((choice) => (
                          <Button
                            key={choice.id}
                            label={choice.label}
                            systemImage={choice.id === openAppId ? "checkmark" : undefined}
                            onPress={() => handleSwitchApp(choice.id)}
                          />
                        ))}
                      </Menu>
                    </Host>
                  </View>
                ) : null}
              </View>
            ) : null}
            <View style={styles.previewStage}>
              <CodeArtifactWebView
                ref={codeArtifactRef}
                // The reset nonce is the second half of "Reset app state": a new
                // key remounts the host so the app rebuilds from a clean slate.
                key={`${String(htmlArtifact._id)}:${resetNonce}`}
                scope={{ kind: "session", artifactId: htmlArtifact._id }}
                content={htmlArtifact.content}
                onAskTutor={handleAppTutorAsk}
                // An Edit preview is a builder trying their own character, not
                // play the tutor should coach: only Play (or a side app, whose
                // chat is the tutor's) reports character turns.
                onAppAiTurn={tutorVoice ? handleAppAiTurn : undefined}
                // The character and judges answer only the session's owner;
                // anyone else watching gets `unavailable` without a server call.
                appAiEnabled={isSessionOwner}
                style={styles.webView}
              />
              {codeView === "code" && !presentingApp ? (
                // Laid OVER the app rather than replacing it: the WebView stays
                // mounted, so the app keeps its state and the builder's render
                // checks keep a live host while the scholar reads the source.
                <ScrollView
                  style={[styles.codeSheet, { backgroundColor: colors.bg }]}
                  contentContainerStyle={styles.codeSheetContent}
                  keyboardShouldPersistTaps="handled"
                  // The soft keyboard covers the lower half of the source:
                  // inset for it so the line being typed stays in view.
                  automaticallyAdjustKeyboardInsets
                >
                  <ArtifactEditor
                    key={`${String(htmlArtifact._id)}:code`}
                    artifact={htmlArtifact}
                    onSave={(content, baseRevision) =>
                      saveArtifact({
                        artifactId: htmlArtifact._id,
                        content,
                        baseRevision,
                      })
                    }
                    onFocus={() => undefined}
                    code
                  />
                </ScrollView>
              ) : null}
              {building && mode === "edit" && !presentingApp ? (
                // Editing an already-rendered app: one vocabulary — the overlay
                // reads the SAME derived stage label as the card/line (T1).
                <View
                  style={[
                    styles.buildingOverlay,
                    // Over the source, sit at the bottom so the pill never
                    // covers the editor's toolbar or its conflict banner.
                    codeView === "code" && styles.buildingOverlayLow,
                  ]}
                  pointerEvents="none"
                >
                  <View style={[styles.buildingPill, { backgroundColor: colors.violetSolid }]}>
                    <ActivityIndicator size="small" color={colors.white} />
                    <Text style={[styles.buildingText, { color: colors.white }]}>
                      {buildStageLabel(buildStage.stage)}
                    </Text>
                  </View>
                </View>
              ) : null}
            </View>
          </View>
        ) : buildPreview === "live" ? (
          // A build stream is live (or the teacher opened a build link whose
          // kickoff is starting) but there's no app yet: show honest, named
          // progress in place of the "Start building" empty state.
          <View style={[styles.previewCenter, { backgroundColor: colors.bgSubtle }]}>
            <BuildProgress
              variant="card"
              stage={buildStage.stage}
              startedAt={buildStartedAt}
              onStop={streaming ? stopStream : undefined}
            />
          </View>
        ) : buildPreview === "stopped" ? (
          // The build ended (Stop, a rejected fetch, an SSE error, or `done`
          // with no code) without producing an app: settle into a recovery card
          // instead of a progress card that ticks forever.
          <View style={[styles.previewCenter, { backgroundColor: colors.bgSubtle }]}>
            <BuildStopped onRetry={handleRetryBuild} />
          </View>
        ) : (
          <View style={styles.empty}>
            <SymbolView
              name="hammer.fill"
              size={44}
              tintColor={colors.violet}
              style={styles.emptyIcon}
            />
            <Text style={[styles.emptyTitle, { color: colors.fg }]}>
              Describe the app you want to build
            </Text>
            <Text style={[styles.emptyBody, { color: colors.fgMuted }]}>
              Tell the builder your idea — a game, a story, a simulation — and it
              writes a live app right here. Then keep refining it.
            </Text>
            <Pressable
              onPress={() => {
                Haptics.selectionAsync();
                setChatOpen(true);
                setWantsComposerFocus(true);
              }}
              style={[styles.emptyCta, { backgroundColor: colors.violetSolid }]}
              accessibilityRole="button"
            >
              <Text style={[styles.emptyCtaText, { color: colors.white }]}>
                Start building
              </Text>
            </Pressable>
          </View>
        )}
        {/* The chat drawer is closed by default, so a coach line from an
            app-update turn would land out of sight: show it under the app
            until read. The slot is reserved for the whole of Play (empty when
            there is no line), so the app never moves when a line arrives or
            is read (a jump made taps miss, TRA-477). */}
        {isSessionOwner && tutorVoice && htmlArtifact && !presentingApp ? (
          <TutorLineSlot
            line={tutorLine.unread ?? null}
            onOpen={() => setChatOpen(true)}
          />
        ) : null}
        {showDeliverableFooter && htmlArtifact && !presentingApp ? (
          <DeliverableFooter
            kind="text"
            mode={builderDeliverable.mode ?? "manual"}
            flairKey={String(htmlArtifact._id)}
            flairEarned={builderDeliverable.appDeliverable?.flairEarned}
            criteria={builderDeliverable.criteria}
            deliverableId={builderDeliverable.appDeliverable?._id}
            resolved={builderDeliverable.appDeliverable !== undefined}
            criteriaPending={builderDeliverable.criteriaPending}
            criteriaFailed={builderDeliverable.criteriaFailed}
            disabled={streaming || !htmlArtifact.content.trim()}
            busy={checkBusy}
            onCheck={() =>
              void runRubricCheck(
                htmlArtifact,
                builderDeliverable.criteria.length > 0,
              )
            }
            onRetry={() => void handleRetryCriteria()}
          />
        ) : null}
        {presentingApp ? <AppPresentControls onDone={stopPresenting} /> : null}
      </View>

      <YourWorkSheet
        open={yourWorkOpen && !presentingApp}
        onClose={() => setYourWorkOpen(false)}
        sessionId={sessionId}
        activityId={sessionActivityId}
        checkDisabled={streaming}
        onAskCheck={runRubricCheck}
      />

      <Drawer
        open={chatOpen && !presentingApp}
        onClose={() => setChatOpen(false)}
        side="bottom"
        title={tutorVoice ? "Tutor" : "Designer"}
      >
        <View style={styles.chatBody}>
          <ScrollView
            ref={scrollRef}
            style={styles.thread}
            contentContainerStyle={styles.threadBody}
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
          >
            {/* The brief — a muted first card in the DESIGNER thread, rendered
                client-side from the activity's appRequest. Never a persisted
                message, and never present for a scholar (the server withholds
                it). */}
            {mode === "edit" && briefText ? (
              <View style={[styles.briefCard, { borderColor: colors.border }]}>
                <Text style={[styles.briefEyebrow, { color: colors.fgMuted }]}>
                  The brief
                </Text>
                <Text style={[styles.briefBody, { color: colors.fg }]}>
                  {briefText}
                </Text>
              </View>
            ) : null}
            {messages.length === 0 && !(mode === "edit" && briefText) ? (
              <Text style={[styles.chatEmpty, { color: colors.fgMuted }]}>
                {!tutorVoice
                  ? "Describe the app you want to build — the designer writes it and you iterate."
                  : "Talk to the tutor about the app."}
              </Text>
            ) : (
              messages.map((message) => {
                // "vN · Restore" under the designer turn that produced a
                // version; the newest reads "vN · current" with no Restore.
                const marker =
                  mode === "edit" && message.role === "assistant"
                    ? revisionByMessageId.get(message.id)
                    : undefined;
                return (
                  <View key={message.id}>
                    <ChatBubble
                      role={message.role}
                      content={message.content}
                      ttsEnabled={ttsEnabled}
                      stopRequestedAt={message.stopRequestedAt}
                      appSnapshotUrl={message.appSnapshotUrl}
                      hasImage={message.hasImage}
                      imageUrl={message.imageUrl}
                    />
                    {marker ? (
                      <View style={styles.markerRow}>
                        <Text
                          style={[styles.markerText, { color: colors.fgMuted }]}
                        >
                          {marker.isCurrent
                            ? `v${marker.version} · current`
                            : `v${marker.version} ·`}
                        </Text>
                        {marker.isCurrent ? null : (
                          <Pressable
                            onPress={() =>
                              void handleRestore({
                                id: marker.id,
                                version: marker.version,
                              })
                            }
                            disabled={restoring}
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel={`Restore v${marker.version}`}
                          >
                            <Text
                              style={[
                                styles.markerAction,
                                {
                                  color: colors.violet,
                                  opacity: restoring ? 0.5 : 1,
                                },
                              ]}
                            >
                              Restore
                            </Text>
                          </Pressable>
                        )}
                      </View>
                    ) : null}
                  </View>
                );
              })
            )}
            {visiblyStreaming &&
            (!builderStance || streamingThread === threadForMode(mode)) ? (
              <View style={styles.streamRow}>
                <View style={bubbleStyles.tutorBare}>
                  {streamingText ? (
                    <StreamingText
                      content={streamingText}
                      done={false}
                      color={colors.charcoal}
                      style={bubbleStyles.bubbleText}
                    />
                  ) : !showBuildStages ? (
                    <Text style={[bubbleStyles.bubbleText, { color: colors.charcoalSubtle }]}>
                      {/* Play is the TUTOR thread: a question is not a build,
                          so build stages would be a seam. One plain line. */}
                      Thinking…
                    </Text>
                  ) : (
                    // Edit mode is the build thread: the chat line reads the SAME
                    // derived stage as the preview card (T1).
                    <BuildProgress
                      variant="line"
                      stage={buildStage.stage}
                      startedAt={buildStartedAt}
                    />
                  )}
                </View>
              </View>
            ) : null}
          </ScrollView>

          {/* In free play the designer offers the parked ideas in chat. */}
          {!isFreePlay ? (
            <ParkingLot
              ideas={session?.parkingLot}
              onStartFreePlay={
                session?.freePlayEligible ? handleStartFreePlay : undefined
              }
              startingFreePlay={startingFreePlay}
              renderActions={
                builderDone ? doneIdeaActions.renderActions : undefined
              }
            />
          ) : null}
          {!isFreePlay && builderDone ? doneIdeaActions.dialog : null}

          {image.previewUri ? (
            <View style={styles.photoRow}>
              <PendingPhotoChip
                uri={image.previewUri}
                uploading={image.uploading}
                onRemove={image.clear}
              />
            </View>
          ) : null}
          {voice.isConnecting || voice.isRecording || voice.isTranscribing ? (
            <View style={[styles.composer, { borderTopColor: colors.border }]}>
              <RecordingBar
                level={voice.level}
                durationMs={voice.durationMs}
                isTranscribing={voice.isTranscribing}
                isConnecting={voice.isConnecting}
                isMaxed={voice.isMaxed}
                onCancel={onMicCancel}
                onStop={onMicStop}
              />
            </View>
          ) : (
            <View style={[styles.composer, { borderTopColor: colors.border }]}>
              {/* The session chat's attach control: camera or photo library —
                  e.g. an example picture for "make the art look like this". */}
              <Pressable
                onPress={() => image.chooseAndAttach()}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Add a photo"
                style={[styles.attach, { backgroundColor: colors.charcoalSubtle }]}
              >
                <SymbolView name="plus" size={16} tintColor={colors.white} />
              </Pressable>
              <AppTextInput
                ref={composerRef}
                value={input}
                onChangeText={onChangeInput}
                placeholder={
                  !tutorVoice
                    ? "Tell the designer what to change…"
                    : "Talk to the tutor…"
                }
                placeholderTextColor={colors.fgMuted}
                style={[styles.input, { color: colors.fg, borderColor: colors.border }]}
                multiline
                submitBehavior="submit"
                onSubmitEditing={handleSend}
              />
              {/* During a quiet app-update turn this stays Send: sending steers
                  it, and the scholar's turn carries the in-app events instead.
                  An empty box offers the mic in the same slot (the session
                  screen's pattern): tap to talk, tap the check to send. */}
              {!visiblyStreaming && !input.trim() && !image.previewUri ? (
                <Pressable
                  onPress={() => void onMicStart()}
                  accessibilityRole="button"
                  accessibilityLabel="Start recording — tap to talk, tap the check to send"
                  style={[styles.send, { backgroundColor: colors.violetSolid }]}
                >
                  <SymbolView name="mic.fill" size={16} tintColor={colors.white} />
                </Pressable>
              ) : (
                <Pressable
                  onPress={visiblyStreaming ? stopStream : handleSend}
                  accessibilityRole="button"
                  accessibilityLabel={visiblyStreaming ? "Stop generating" : "Send"}
                  style={[styles.send, { backgroundColor: colors.violetSolid }]}
                >
                  {visiblyStreaming ? (
                    <SymbolView name="stop.fill" size={16} tintColor={colors.white} />
                  ) : (
                    <Text style={[styles.sendText, { color: colors.white }]}>Send</Text>
                  )}
                </Pressable>
              )}
            </View>
          )}
        </View>
      </Drawer>

      <VibecodeHistorySheet
        revisions={revisions}
        // History is an Edit-only sheet under the header: it is visible only
        // while the effective mode is Edit, so a tap on Play or a server
        // policy clamp closes it with the header.
        open={historyOpen && mode === "edit" && !presentingApp}
        onClose={() => setHistoryOpen(false)}
        onRestore={(rev) => void handleRestore(rev)}
        restoring={restoring}
      />
    </>
  );
}

/** Show a deliberate server refusal of a turn (a locked Quest build step).
 * Anything else stays a console warning, as before. */
function alertRefusal(error: unknown): void {
  const refusal = serverRefusal(error);
  if (refusal) Alert.alert("Couldn't send", refusal);
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  loading: { alignItems: "center", justifyContent: "center" },

  // Top bar (rendered into the expo-router header).
  headerTitleBlock: { alignItems: "flex-start", maxWidth: 280 },
  headerEyebrow: {
    fontFamily: fonts.semibold,
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  headerTitleText: { fontFamily: fonts.semibold, fontSize: 16 },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 12 },
  savedAt: { fontFamily: fonts.regular, fontSize: 12 },
  headerGhost: { flexDirection: "row", alignItems: "center", gap: 4 },
  headerGhostDisabled: { opacity: 0.4 },
  headerGhostText: { fontFamily: fonts.semibold, fontSize: 13 },
  statusChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  statusChipText: { fontFamily: fonts.medium, fontSize: 12 },

  previewWrap: { flex: 1 },
  appTopRow: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  appTopRowToggle: { flex: 1 },
  appSwitcherWrap: { paddingHorizontal: 12 },
  previewStage: { flex: 1 },
  codeSheet: { ...StyleSheet.absoluteFill },
  codeSheetContent: { padding: 12 },
  previewCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  webView: { flex: 1, backgroundColor: "transparent" },
  buildingOverlay: {
    position: "absolute",
    top: 12,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  buildingOverlayLow: { top: undefined, bottom: 12 },
  buildingPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
  },
  buildingText: { fontFamily: fonts.semibold, fontSize: 13 },

  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 12,
  },
  emptyIcon: { marginBottom: 4 },
  emptyTitle: { fontFamily: fonts.bold, fontSize: 20, textAlign: "center" },
  emptyBody: {
    fontFamily: fonts.regular,
    fontSize: 15,
    lineHeight: 22,
    textAlign: "center",
  },
  emptyCta: {
    marginTop: 8,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 14,
  },
  emptyCtaText: { fontFamily: fonts.semibold, fontSize: 15 },

  // Chat drawer — turns render via the shared <ChatBubble> (canonical navy
  // own-turn bubble, bare tutor voice, shared text scale).
  chatBody: { flex: 1 },
  thread: { flex: 1 },
  threadBody: { paddingVertical: 12, gap: 8 },
  chatEmpty: { fontFamily: fonts.regular, fontSize: 14 },
  briefCard: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 4,
  },
  briefEyebrow: {
    fontFamily: fonts.semibold,
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  briefBody: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20 },
  markerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingTop: 2,
    paddingLeft: 2,
  },
  markerText: { fontFamily: fonts.regular, fontSize: 11 },
  markerAction: { fontFamily: fonts.semibold, fontSize: 11 },
  streamRow: { flexDirection: "row" },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontFamily: fonts.regular,
    fontSize: 14,
    maxHeight: 90,
  },
  send: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12 },
  attach: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  photoRow: { paddingTop: 10 },
  sendText: { fontFamily: fonts.semibold, fontSize: 14 },
});
