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
import {
  TileSessionMenu,
  useTileSessions,
} from "@/components/vibecode/TileSessionMenu";
import { fetch as expoFetch } from "expo/fetch";
import * as Haptics from "expo-haptics";
import { Button, Host, Menu } from "@expo/ui/swift-ui";
import { accessibilityLabel, tint } from "@expo/ui/swift-ui/modifiers";
import { SymbolView } from "expo-symbols";
import { useConvex, useMutation, useQuery } from "convex/react";
import { useAuthToken } from "@convex-dev/auth/react";

import { Drawer } from "@/components/ui/Drawer";
import {
  HeaderPillButton,
  TEACHER_HANDOFF_ICON,
} from "@/components/HeaderPillButton";
import { ChatBubble } from "@/components/ChatBubble";
import { PendingPhotoChip } from "@/components/PhotoAttachment";
import { useImageAttachment } from "@/hooks/useImageAttachment";
import { StreamingText } from "@/components/StreamingText";
import {
  CodeArtifactWebView,
  type CodeArtifactWebViewHandle,
} from "@/components/CodeArtifactWebView";
import { api, convexSiteUrl, type Doc, type Id } from "@/lib/convex";
import { useQuestReadyPill } from "@/components/QuestShowing";
import { useQuestSession } from "@/lib/questSession";
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
  parseWorldRules,
  RuleChips,
  ruleCardEvents,
  type RuleCardEvent,
  type WorldRule,
} from "@/components/vibecode/RuleCards";
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
import {
  THREAD_LOAD_EARLIER_DISTANCE,
  earlierThreadPin,
  resolveThreadWindow,
  type ThreadWindowPin,
} from "../../../vendor/shared/threadWindow";
import { useAppTutorUpdates, useUnreadTutorLine } from "@/hooks/useAppTutorUpdates";
import { TutorLineSlot } from "@/components/TutorLineStrip";
import {
  defaultWorkshopMode,
  editControlFor,
  formatSavedAt,
  canResetAppState as canResetAppStateFor,
  messageThread,
  type EffectiveEditAccess,
  type WorkshopMode,
} from "../../../vendor/shared/workshopMode";
import { AppTextInput } from "@/components/AppTextInput";
import { RecordingBar } from "@/components/RecordingBar";
import { FloatingChatPanel } from "@/components/FloatingChatPanel";
import { useStreamingDictation } from "@/hooks/useStreamingDictation";
import { appStatusBus } from "@/lib/appStatusBus";
import { useVoiceKeyTarget } from "@/lib/voiceKey";
import { getNativeTTS } from "@/lib/nativeTTS";
import {
  VibecodeHistorySheet,
  type HistoryRevision,
} from "@/components/vibecode/VibecodeHistorySheet";
import {
  ArtifactEditor,
  flushPendingArtifactSaves,
  type CodeView,
} from "@/components/DeliverablePanel";
import { ParkedIdeaList } from "@/components/ParkedIdeaList";
import { DrawerTabs, type DrawerTabId } from "@/components/vibecode/DrawerTabs";
import { FlairPanel } from "@/components/vibecode/FlairPanel";
import { WorldPanel } from "@/components/vibecode/WorldPanel";
import { TeacherHandoffSheet } from "@/components/TeacherHandoffSheet";
import { useSavedForLaterActions } from "@/components/MissionDoneBlocks";
import { YourWorkSheet } from "@/components/vibecode/YourWorkSheet";
import { CHAT_COMPOSER_INPUT } from "@/lib/chatType";
import { useBuilderDeliverable } from "@/components/vibecode/useBuilderDeliverable";
import { APP_SURFACE_COPY } from "../../../vendor/shared/appSurface";
import { AppTalkSession } from "@/components/vibecode/AppTalkSession";
import { chooseHowToPresent, type PresentChoice } from "@/components/talk/presentChoice";
import { serverRefusal } from "../../../vendor/shared/serverErrorMessage";
import { isTeacherArchived } from "../../../vendor/shared/teacherArchive";
import { TeacherArchivedSession } from "@/components/TeacherArchivedSession";
import { AppCodeReader, type AppRule } from "@/components/vibecode/AppCodeReader";
import { APP_STATE_DEFAULTS_KEY } from "../../../vendor/shared/appStateDefaults";
import { getArtifactDraft } from "../../../vendor/shared/artifactDraftStore";

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
// How close (pt) to the end of the chat still counts as reading the end.
const CHAT_FOLLOW_SLOP = 64;
/** A chat message's stable key, which the thread window pins. */
const chatMessageKey = (message: VibecodeMessage) => message.id;

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
/** An app host refusal, keyed to the app version it was reported for. */
type HostFailure = {
  artifactId: string;
  content: string;
  resetNonce: number;
  message: string;
};

/** The failure's message when it is about the app on screen, else null. */
function hostFailureFor(
  failure: HostFailure | null,
  artifact: { _id: Id<"artifacts">; content: string } | null | undefined,
  resetNonce: number,
): string | null {
  if (!failure || !artifact) return null;
  return failure.artifactId === String(artifact._id) &&
    failure.content === artifact.content &&
    failure.resetNonce === resetNonce
    ? failure.message
    : null;
}

type HtmlArtifactVersion = {
  id: string;
  revision: number;
  content: string;
  loadBoundary?: ReturnType<
    CodeArtifactWebViewHandle["currentLoadBoundary"]
  > | null;
};

/**
 * A hand edit not yet saved, or one that conflicts with a newer version, lives
 * only in ArtifactEditor's draft. The Code view opens on the editor while one
 * exists, so the scholar sees their own code and its conflict banner rather
 * than the server copy in the reader.
 */
function hasPendingCodeDraft(artifactId: string, serverContent: string): boolean {
  const draft = getArtifactDraft(artifactId);
  return !!draft && (draft.conflict || draft.content !== serverContent);
}

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
  // The oldest message the open chat draws (shared/threadWindow.ts): a long
  // thread opens on its newest page and draws older pages as the scholar
  // scrolls up. Each opening clears it, so the chat opens at the newest.
  const [threadPin, setThreadPin] = useState<ThreadWindowPin>(null);
  const [threadPinChatOpen, setThreadPinChatOpen] = useState(false);
  // Which tab the drawer shows under the mission title.
  const [drawerTab, setDrawerTab] = useState<DrawerTabId>("chat");
  // The provocation last seen in the Flair tab; a new one dots the tab.
  const [seenProvocation, setSeenProvocation] = useState<string | null>(null);
  // The Send to teacher sheet (top bar pill).
  const [sendSheetOpen, setSendSheetOpen] = useState(false);
  // When this screen last sent the app to the teacher (a quiet chat line).
  const [sentToTeacherAt, setSentToTeacherAt] = useState<number | null>(null);
  // The floating chat panel: the voice key or ⌘/ with the chat drawer closed
  // (src/lib/voiceKey.ts). It shows the turns after `afterId`, so the card
  // holds only this exchange; `via` is the key that opened it, so cancelling
  // the mic before anything was said also closes it.
  const [floating, setFloating] = useState<{
    afterId: string | null;
    via: "voice" | "text";
  } | null>(null);
  const [floatingFocusRequest, setFloatingFocusRequest] = useState(0);
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
  const [presenting, setPresenting] = useState<PresentChoice | null>(null);
  // "Check my work" is in flight (the submit and the tutor's check reply).
  const [checkBusy, setCheckBusy] = useState(false);
  // Edit's Preview | Code view of the app (TRA-520), the native twin of the
  // web CodeArtifactViewer toolbar. Play never shows code, so the live view
  // below falls back to Preview whenever the mode is not Edit.
  const [codeViewRequest, setCodeViewRequest] = useState<CodeView>("preview");
  // The Code view opens as a reader (AppCodeReader: the app's parts, rules
  // open, setup folded); "Edit code" swaps in the plain editor.
  const [codeEditing, setCodeEditing] = useState(false);
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
  // The chat follows new content only while the scholar is reading its end.
  // Scrolled up, or with a finger on the list, it stays where they put it: a
  // reply streaming in used to yank it back down mid-drag, which made the
  // iOS scroll thumb impossible to use. Their own new turn always jumps down.
  const chatAtEndRef = useRef(true);
  const chatFingerDownRef = useRef(false);
  // Older pages load on the scholar's own scroll only, never on a scroll event
  // the drawer fires while it lays out at the top before following to the end.
  const chatDraggedRef = useRef(false);
  // The content height an older page was last asked for at: a scroll event
  // still on its way from before that page went in must not ask again.
  const revealedAtHeightRef = useRef(0);
  const followChatToEnd = () => {
    chatAtEndRef.current = true;
    // Not animated: an animated scroll reports in-between offsets that would
    // read as "scrolled away from the end" and stop the follow.
    scrollRef.current?.scrollToEnd({ animated: false });
  };
  const composerRef = useRef<TextInput>(null);
  const floatingComposerRef = useRef<TextInput>(null);
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
  // The host refused the app (an asset it will not serve, a sandbox it could
  // not build). Shown over the empty page, and reported to the tutor's
  // render check so it stops rebuilding the same HTML. Keyed to the app it
  // was reported for, so a rebuild starts clean and the host reports again
  // if it still fails. The ref is the render check's copy (handlers only).
  const [hostFailure, setHostFailure] = useState<HostFailure | null>(null);
  const hostFailureRef = useRef<HostFailure | null>(null);
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
  const session = data?.session;
  // Whether the builder is this session's primary view (an app activity,
  // an activity-less builder, free play) or opened on demand from the chat,
  // and whether the app is the session's work or a side project.
  const builderPrimary = session?.builderPrimary ?? true;
  // A first-party tile opened this session (convex/lib/tileSessions.ts): the
  // title is a pull-down over the scholar's sessions of that app and Back
  // goes Home. The read is null for anyone else (a teacher reading the
  // session), who keeps the plain title. The chat already opens closed here.
  const tileExternalAppId =
    session?.tileSession === true ? session.sourceExternalAppId : undefined;
  const tileSessions = useTileSessions(tileExternalAppId);
  // Memoized: the header options below rebuild only when this changes.
  const tileMenu = useMemo(
    () =>
      tileExternalAppId && tileSessions
        ? { ...tileSessions, externalAppId: tileExternalAppId }
        : null,
    [tileExternalAppId, tileSessions],
  );
  const openTileSession = useCallback(
    (id: Id<"sessions">) =>
      router.replace({ pathname: "/session/[id]", params: { id } }),
    [router],
  );
  const goHome = useCallback(() => router.dismissTo("/"), [router]);
  const appRole = session?.appRole ?? "work";
  const sessionActivityId = session?.activityId as Id<"activities"> | undefined;
  // A Quest's session (app or Python bench) hands in with the header's "I'm
  // ready to show" (TRA-720), looked up once for the route.
  const questSession = useQuestSession();
  const questPill = useQuestReadyPill();
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
    hasAppRequest: session?.hasAppRequest === true,
    hasAppCharacter,
    // A coached session not handed the starter has nothing to play yet and
    // opens in Edit, where its app gets built (the server's rule too). Set
    // when the session is made, so it never flips once the first build lands.
    openedOnStarter: session
      ? session.vibecodeStarterUsedAt != null
      : undefined,
    serverDefault: session?.defaultWorkshopMode,
  });
  const requestedMode = modeRequest ?? modeDefault;
  const mode: WorkshopMode =
    appRole === "side"
      ? "edit"
      : requestedMode === "edit" && !editUnlocked
        ? "play"
        : requestedMode;
  // Opening the sheet, or Edit | Play swapping its thread, starts at the end.
  useEffect(() => {
    if (!chatOpen) return;
    chatAtEndRef.current = true;
    chatDraggedRef.current = false;
    revealedAtHeightRef.current = 0;
  }, [chatOpen, mode]);
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
  // parked ideas carry the done screen's Build it now + Make it a Quest.
  // Owner only, never a rehearsal.
  const builderDone =
    isSessionOwner &&
    session?.isTestDrive !== true &&
    session?.activityDone === true;
  // Build it now continues in this session (one app, one session): open Edit
  // and put the idea in the composer for the scholar to send.
  const doneIdeaActions = useSavedForLaterActions({
    sessionId,
    // Edit must be open here, or the idea would go to the tutor instead.
    canBuildNow: session?.freePlayEligible === true && editUnlocked,
    onBuildHere: (idea) => {
      setDrawerTab("chat");
      setModeRequest("edit");
      setInput(idea.text);
    },
  });
  // A scholar who only plays this app gets no "Reset app state" (it wipes
  // their saved progress in an app they cannot rebuild). Staff and a scholar
  // building their own app keep it; it stays owner-only because
  // appStates.clearSessionState is owner-gated (TRA-317, TRA-477). It shows
  // with Allow edits on or off: the switch only decides what the next chat
  // message may do.
  const canResetAppState = canResetAppStateFor({
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
  const presentingApp = presenting !== null && !!htmlArtifact;
  const htmlArtifactRef = useRef(htmlArtifact);
  useEffect(() => {
    htmlArtifactRef.current = htmlArtifact;
  }, [htmlArtifact]);
  // The app's published rules, for the reader's rule chips. Same subscription
  // the app host already holds, so Convex serves it from one query.
  const codeAppState = useQuery(
    api.appStates.getSessionState,
    codeView === "code" && htmlArtifact && !codeEditing
      ? { artifactId: htmlArtifact._id }
      : "skip",
  );
  // The rules now, and as the app's code first wrote them: the app-state SDK
  // keeps boot-time values under __rhDefaults, which is how the reader finds
  // each rule's starting value in the source without help from the builder.
  // Keyed on the rules' text, not the snapshot: a running game saves its
  // state a few times a second, and the reader should only re-parse when a
  // rule actually changed.
  const codeDoc = codeAppState?.doc as
    | { rules?: unknown; [APP_STATE_DEFAULTS_KEY]?: { rules?: unknown } }
    | undefined;
  const codeRulesJson = JSON.stringify(codeDoc?.rules ?? null);
  const codeStartingRulesJson = JSON.stringify(codeDoc?.[APP_STATE_DEFAULTS_KEY]?.rules ?? null);
  const { codeRules, codeStartingRules } = useMemo(() => {
    const list = (json: string) => {
      const v: unknown = JSON.parse(json);
      return Array.isArray(v) ? (v as AppRule[]) : undefined;
    };
    return { codeRules: list(codeRulesJson), codeStartingRules: list(codeStartingRulesJson) };
  }, [codeRulesJson, codeStartingRulesJson]);
  const hostError = hostFailureFor(hostFailure, htmlArtifact, resetNonce);
  const reportHostFailure = useCallback(
    (message: string) => {
      const current = htmlArtifactRef.current;
      if (!current) return;
      const failure: HostFailure = {
        artifactId: String(current._id),
        content: current.content,
        resetNonce,
        message,
      };
      hostFailureRef.current = failure;
      setHostFailure(failure);
    },
    [resetNonce],
  );
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

  // The teacher's mission, the chat drawer's title (null = open build).
  const missionTitle = session?.missionTitle ?? null;
  const builderDeliverable = useBuilderDeliverable({
    sessionId,
    activityId: sessionActivityId,
    role: appRole,
    artifacts,
    appArtifactId: htmlArtifact?._id,
    completed: !!session?.activityCompletedAt,
  });
  // The top bar's Send to teacher: only when the app IS the deliverable, and
  // only for the scholar who owns the session (submit is owner-only; free play
  // has no deliverable). Never on a Quest's session, nor while that is still
  // being looked up: "I'm ready to show" stands in its place.
  const canSendToTeacher =
    appRole === "work" &&
    builderDeliverable.kind === "artifact" &&
    !!htmlArtifact &&
    isSessionOwner &&
    !isFreePlay &&
    questSession === null;

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

      // The host may still be resolving the new HTML's assets, or be a frame
      // from remounting (Reset app state). Wait that out, bounded by the
      // check's budget (a missing host by a short grace); a refusal is then
      // answered as the reason, which the tutor can act on, instead of a
      // blank capture it cannot.
      const hostGraceUntil = performance.now() + 1_000;
      let host = codeArtifactRef.current;
      while (
        (host === null
          ? performance.now() < hostGraceUntil
          : host.hostStatus() === "preparing") &&
        performance.now() < deadlineAt &&
        activeRenderCheckIdRef.current === checkId
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        host = codeArtifactRef.current;
      }
      if (
        activeRenderCheckIdRef.current !== checkId ||
        activeStreamIdRef.current !== streamId
      ) {
        return;
      }
      if (host?.hostStatus() === "failed") {
        const reason =
          hostFailureFor(
            hostFailureRef.current,
            htmlArtifactRef.current,
            resetNonce,
          ) ?? "the app could not be prepared";
        try {
          await answerRenderCheck({
            sessionId,
            streamId,
            checkId,
            consoleLines: [
              `[render-check] the app host refused this app, so nothing is on screen: ${reason}`.slice(
                0,
                500,
              ),
            ],
            stateJson: "{}",
          });
        } catch (error) {
          console.warn("[vibecode] render-check answer failed", error);
        }
        return;
      }
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
      resetNonce,
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
    // One thread: the Allow edits switch decides what the NEXT message may
    // do, and the designer's and the tutor's turns both stay visible.
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      stopRequestedAt: (message as { stopRequestedAt?: number }).stopRequestedAt,
      appSnapshotUrl: message.appSnapshotUrl,
      hasImage: !!message.imageId,
      imageUrl: message.imageUrl ?? null,
    }));
  // A long thread draws only its newest page, and older pages as the scholar
  // scrolls up (shared/threadWindow.ts): drawing all 560 turns of one
  // free-play game held the drawer shut for ~10 s. Each opening starts at the
  // newest page. The pin holds through the close slide, so the thread does not
  // jump while it leaves.
  if (threadPinChatOpen !== chatOpen) {
    setThreadPinChatOpen(chatOpen);
    if (chatOpen) setThreadPin(null);
  }
  const threadWindow = resolveThreadWindow(
    messages,
    chatMessageKey,
    threadPin,
    "thread",
  );
  if (chatOpen && threadWindow.pin !== threadPin) {
    setThreadPin(threadWindow.pin);
  }
  const earlierHidden = threadWindow.start > 0;
  const shownMessages = messages.slice(threadWindow.start);
  const revealEarlier = () =>
    setThreadPin(
      earlierThreadPin(messages, chatMessageKey, threadWindow.start, "thread"),
    );

  // INLINE RULE CARDS: whenever the app's published rules (APP STATE `rules`)
  // gain or change a thing's rules, drop a card for that thing into the chat,
  // after the message the scholar was on when it happened. The first look at
  // an app records every thing's current rules once.
  const appStateSnapshot = useQuery(
    api.appStates.getSessionState,
    htmlArtifact ? { artifactId: htmlArtifact._id } : "skip",
  );
  const worldRules = useMemo(
    () => parseWorldRules(appStateSnapshot?.doc),
    [appStateSnapshot?.doc],
  );
  const [ruleEvents, setRuleEvents] = useState<Array<RuleCardEvent & { appId: string }>>([]);
  const lastRulesRef = useRef<{ artifactId: string; rules: WorldRule[] } | null>(null);
  const ruleStampRef = useRef(0);
  const lastMessageId = messages.length ? messages[messages.length - 1].id : null;
  useEffect(() => {
    if (!htmlArtifact || appStateSnapshot === undefined) return;
    const artifactId = String(htmlArtifact._id);
    const prev =
      lastRulesRef.current?.artifactId === artifactId ? lastRulesRef.current.rules : null;
    lastRulesRef.current = { artifactId, rules: worldRules };
    if (!worldRules.length) return;
    ruleStampRef.current += 1;
    const events = ruleCardEvents(
      prev,
      worldRules,
      lastMessageId,
      `${artifactId}:${ruleStampRef.current}`,
    );
    // One chip per thing per message: a later change to the same thing after
    // the same message updates that chip in place instead of adding another.
    if (events.length) {
      setRuleEvents((existing) => {
        const next = existing.filter(
          (old) =>
            !events.some(
              (e) =>
                old.appId === artifactId &&
                e.thing === old.thing &&
                e.afterMessageId === old.afterMessageId,
            ),
        );
        return [...next, ...events.map((event) => ({ ...event, appId: artifactId }))];
      });
    }
    // Re-runs on every snapshot or message; ruleCardEvents returns nothing
    // unless a rule actually changed since the last run for this app.
  }, [htmlArtifact, appStateSnapshot, worldRules, lastMessageId]);
  const visibleMessageIds = new Set(messages.map((m) => m.id));
  const currentRuleEvents = ruleEvents.filter(
    (event) => event.appId === String(htmlArtifact?._id),
  );
  // The newest chip per thing, in first-seen order: a thing never shows twice
  // in one spot, however often its rules changed there.
  const latestPerThing = (events: RuleCardEvent[]) => {
    const byThing = new Map<string, RuleCardEvent>();
    for (const e of events) byThing.set(e.thing, e);
    return [...byThing.values()];
  };
  // Chips whose message is not in this thread fold into the LAST message's
  // row, so they never stack as a second row right under it.
  const unanchoredRuleEvents = currentRuleEvents.filter(
    (e) => !e.afterMessageId || !visibleMessageIds.has(e.afterMessageId),
  );
  const lastBuilderMessageId =
    [...messages].reverse().find((m) => m.role === "assistant")?.id ?? null;
  const ruleEventsAfter = (messageId: string) =>
    latestPerThing([
      ...currentRuleEvents.filter((e) => e.afterMessageId === messageId),
      ...(messageId === lastBuilderMessageId ? unanchoredRuleEvents : []),
    ]);
  const trailingRuleEvents = lastBuilderMessageId
    ? []
    : latestPerThing(unanchoredRuleEvents);
  // A chip opens the thing's own card in the app: close the chat so the app,
  // and its card, is what the scholar sees.
  function openRuleCard(thing: string) {
    if (codeView === "code") void handleCodeViewChange("preview");
    setChatOpen(false);
    codeArtifactRef.current?.openRuleCard(thing);
  }

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
      // Opening Code always lands on the reader, never a stale editor.
      if (next === "code") setCodeEditing(false);
      setCodeViewRequest(next);
    },
    [leaveCodeView],
  );

  // Present: a Code-view hand edit is flushed first (its editor unmounts
  // while presenting), and every sheet closes so only the app is on screen.
  // Present or Rehearse first, as slides offer: both can record takes and be
  // filmed from the back of the room (AppTalkSession).
  const startPresenting = useCallback(() => {
    Haptics.selectionAsync();
    void (async () => {
      const choice = await chooseHowToPresent("Present app", APP_SURFACE_COPY.present);
      if (!choice) return;
      const ok = await leaveCodeView();
      if (!ok) return;
      setChatOpen(false);
      setHistoryOpen(false);
      setYourWorkOpen(false);
      setPresenting(choice);
    })();
  }, [leaveCodeView]);
  const stopPresenting = useCallback(() => setPresenting(null), []);

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
    // A canned ask from a button (the Flair tab's Say more / End experiment):
    // typed, but it never takes the composer's draft or staged photo, and the
    // composer's resubmit guard does not apply to it.
    canned = false,
  ): Promise<boolean> => {
    // A staged photo rides the scholar's own turn, typed or spoken, and may be
    // sent alone. An app update is the app talking, never the scholar's photo.
    const imageId = appUpdate || canned ? null : image.imageId;
    if (!text && !appUpdate && !imageId) return false;
    if (!appUpdate && !canned && image.uploading) return false;
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
      inputModality === "typed" && !canned
        ? composerPayloadKey(text, imageId)
        : null;
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
    if (composerSnapshot !== null) {
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
    // The scholar's own turn always brings the chat to the end.
    if (!appUpdate) followChatToEnd();
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
      // A voice turn replaces the draft it was sent over, now that it is
      // saved. Anything typed while it was saving stays.
      if (spoken && input) {
        const replaced = input;
        setInput((current) => (current === replaced ? "" : current));
        // Synchronous, like the typed path: until the clear commits, the
        // rendered Return handler still holds the replaced draft.
        sentComposerRef.current = composerPayloadKey(replaced.trim(), imageId);
      }
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
          supportsAppScripts: true,
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
        builderDeliverable.missionApp && !shouldCheck
          ? "Choose a code version in the Code view before sending it."
          : "Choose a code version in the Code view before checking it.",
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
      followChatToEnd();
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
          supportsAppScripts: true,
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
  // Send to teacher: a snapshot of the app as it is now. Play goes on; the
  // sheet shows the error when this throws.
  const handleSendToTeacher = async (): Promise<void> => {
    if (!htmlArtifact || !sessionActivityId) throw new Error("Nothing to send yet");
    await flushPendingArtifactSaves();
    await submitDeliverable({
      sessionId,
      activityId: sessionActivityId,
      artifactId: htmlArtifact._id,
      intent: "send",
    });
    setSentToTeacherAt(Date.now());
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
  // Asks from the Flair tab go back to Chat and wait there until the Allow
  // edits switch matches what they need, then send once. End experiment needs
  // edits on (the builder takes the panel out of the app); Say more goes with
  // edits on when the scholar may edit, so the experiment they then describe
  // can be built (the prompt holds that turn to talk only), and off otherwise.
  // The pending ask lives in a ref. It goes out from askFromFlair when the
  // switch already matches, else from the effect below once the mode flips
  // and any reply in flight ends. A send the screen refuses (another turn
  // holds the slot) keeps the ask and retries once the mode or the stream
  // changes; a second tap while one is sending is ignored.
  const flairAskRef = useRef<{
    text: string;
    mode: WorkshopMode;
    sending: boolean;
    refusedAt: { mode: WorkshopMode; streaming: boolean } | null;
  } | null>(null);
  const sendFlairAsk = (ask: NonNullable<typeof flairAskRef.current>) => {
    ask.sending = true;
    appTutorUpdates.clearAppAi();
    tutorLine.markRead();
    void sendTutorTurn(ask.text, undefined, false, true).then((sent) => {
      if (flairAskRef.current !== ask) return;
      if (sent) {
        flairAskRef.current = null;
      } else {
        ask.sending = false;
        ask.refusedAt = { mode, streaming };
      }
    });
  };
  const askFromFlair = (text: string, wantMode: WorkshopMode) => {
    if (flairAskRef.current?.sending) return;
    Haptics.selectionAsync();
    setDrawerTab("chat");
    const ask = { text, mode: wantMode, sending: false, refusedAt: null };
    flairAskRef.current = ask;
    if (mode !== wantMode) void handleModeChange(wantMode);
    else if (!streaming) sendFlairAsk(ask);
  };
  const handleSayMore = (question: string | null) => {
    if (!question) return;
    askFromFlair(`Say more about this: "${question}"`, editUnlocked ? "edit" : "play");
  };
  const handleEndExperiment = () => {
    if (!editUnlocked) return;
    askFromFlair("End the experiment and take it out of my app.", "edit");
  };
  useEffect(() => {
    const ask = flairAskRef.current;
    if (!ask || ask.sending || mode !== ask.mode || streaming) return;
    if (ask.refusedAt?.mode === mode && ask.refusedAt.streaming === streaming) return;
    sendFlairAsk(ask);
  });
  // The composer's mic — the same recorder and RecordingBar the session
  // screen's chat uses: the bar's check transcribes and sends a "spoken" turn
  // (the tutor sees it labelled [Dictated …]). Once saved, it replaces the
  // draft it was sent over (sendTutorTurn), so typed text never has to hold
  // the mic back (Andy, 2026-11-14).
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
    // The mic key opened the floating panel and nothing was said: put it away.
    if (floating?.via === "voice" && floatingTurns.length === 0 && !streaming) {
      setFloating(null);
    }
  };
  // The voice key and ⌘/ (src/lib/voiceKey.ts). The mic key is this
  // composer's mic button, under the button's own gates. With the chat drawer
  // closed, both open the floating chat panel instead, so the app stays in
  // view while the scholar talks to the designer; while presenting to the
  // class neither does anything.
  const chatVisible = chatOpen && !presentingApp;
  // Where the card's exchange starts: after the newest settled turn. While a
  // reply is in flight its row is already in `messages`, so the card starts
  // before it and keeps it once it settles.
  const floatingAnchor = () => {
    const last = messages.length - 1;
    const anchor = streaming && messages[last]?.role === "assistant" ? last - 1 : last;
    return messages[anchor]?.id ?? null;
  };
  const voiceOpen = voice.isConnecting || voice.isRecording || voice.isTranscribing;
  if (floating && (chatVisible || presentingApp)) {
    // Opening the full chat (any of its doors) or presenting retires the
    // card, so it can't come back over a conversation that has moved on. One
    // thread, so flipping Allow edits keeps it.
    setFloating(null);
  } else if (!floating && voiceOpen && !chatVisible && !presentingApp) {
    // The drawer closed mid-take: the card adopts it, so the RecordingBar
    // (and the reply) stay on screen.
    setFloating({ afterId: floatingAnchor(), via: "voice" });
  }
  const floatingOpen = !!floating && !chatVisible && !presentingApp;
  const anchorIndex =
    floating?.afterId != null
      ? messages.findIndex((message) => message.id === floating.afterId)
      : -1;
  const floatingTurns = floating
    ? floating.afterId != null && anchorIndex < 0
      ? []
      : messages.slice(anchorIndex + 1)
    : [];
  const openFloating = (via: "voice" | "text") => {
    if (!floatingOpen) setFloating({ afterId: floatingAnchor(), via });
  };
  const closeFloating = () => {
    // ✕ / Escape discards a take still in progress (transcribing included),
    // or the card would only re-adopt it on the next render.
    if (voiceOpen) voice.cancel();
    setFloating(null);
  };
  useVoiceKeyTarget(
    {
      state: voice.isConnecting
        ? "connecting"
        : voice.isRecording
          ? "recording"
          : voice.isTranscribing || visiblyStreaming || image.previewUri
            ? "busy"
            : "idle",
      start: () => {
        if (!chatVisible) openFloating("voice");
        void onMicStart();
      },
      confirm: onMicStop,
      cancel: onMicCancel,
      compose: () => {
        if (chatVisible) {
          setWantsComposerFocus(true);
          return;
        }
        openFloating("text");
        setFloatingFocusRequest((n) => n + 1);
      },
      dismiss: floatingOpen ? closeFloating : undefined,
    },
    // Presenting to the class: neither key does anything (and a take in
    // progress is cancelled as the target leaves).
    !presentingApp,
  );
  useEffect(() => {
    if (floatingFocusRequest === 0) return;
    const frame = requestAnimationFrame(() => floatingComposerRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [floatingFocusRequest]);
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
    // The full chat holds the whole conversation, the floating card's included.
    setFloating(null);
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
              supportsAppScripts: true,
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
          // No edge-swipe back: it fired from drags on the app's surface.
          // The header's back button stays.
          gestureEnabled: false,
          // A chat-primary session's way back to its chat. A builder-primary
          // session keeps the stack's own back chevron, unless nothing is
          // behind it: a cold start straight into the session from a link
          // has no chevron and nothing to swipe back to, so it gets the Home
          // pill too. It must never be a dead end.
          ...(tileMenu || (builderPrimary && !router.canGoBack())
            ? {
                headerLeft: () => (
                  <HeaderPillButton
                    icon="chevron.left"
                    label="Home"
                    onPress={goHome}
                  />
                ),
              }
            : builderPrimary
            ? {}
            : {
                headerLeft: () => (
                  <HeaderPillButton
                    icon="chevron.left"
                    label={APP_SURFACE_COPY.backToChat}
                    onPress={() => void handleBackToChat()}
                  />
                ),
              }),
          headerTitle: () => (
            <View style={styles.headerTitleBlock}>
              {/* The activity title with a small quiet-gray "App" eyebrow —
                  never "App designer · <title>". */}
              <Text style={[styles.headerEyebrow, { color: colors.fgMuted }]}>
                {tileMenu ? tileMenu.appName : "App"}
                {isFreePlay || tileMenu ? (
                  <Text style={{ color: colors.violet }}> · Free play</Text>
                ) : null}
              </Text>
              {tileMenu ? (
                <TileSessionMenu
                  sessionId={sessionId}
                  externalAppId={tileMenu.externalAppId}
                  title={headerTitle}
                  sessions={tileMenu}
                  onOpenSession={openTileSession}
                  onHome={goHome}
                />
              ) : (
                <Text
                  style={[styles.headerTitleText, { color: colors.fg }]}
                  numberOfLines={1}
                >
                  {headerTitle}
                </Text>
              )}
            </View>
          ),
          // One custom item with iOS 26's shared glass background hidden: the
          // system capsule merged every button into what read as one button.
          // Each button draws its own pill instead (HeaderPillButton).
          unstable_headerRightItems: () => [
            {
              type: "custom" as const,
              hidesSharedBackground: true,
              element: (
            <View style={styles.headerRight}>
              {mode === "edit" && isBuildSession ? (
                <Text style={[styles.savedAt, { color: colors.fgMuted }]}>
                  {formatSavedAt(savedAt, nowTick)}
                </Text>
              ) : null}
              {canSendToTeacher && htmlArtifact ? (
                <HeaderPillButton
                  icon={TEACHER_HANDOFF_ICON}
                  label="Send to teacher"
                  onPress={() => {
                    Haptics.selectionAsync();
                    setSendSheetOpen(true);
                  }}
                  disabled={streaming || hostError !== null}
                />
              ) : null}
              {questPill}
              {mode === "edit" && htmlArtifact ? (
                // The app's source, laid over it; tap again for the app.
                <HeaderPillButton
                  icon="chevron.left.forwardslash.chevron.right"
                  label="Code"
                  onPress={() => {
                    Haptics.selectionAsync();
                    void handleCodeViewChange(codeView === "code" ? "preview" : "code");
                  }}
                  selected={codeView === "code"}
                />
              ) : null}
              {mode === "edit" ? (
                <HeaderPillButton
                  icon="clock.arrow.circlepath"
                  label="History"
                  accessibilityLabel="App version history"
                  onPress={() => {
                    Haptics.selectionAsync();
                    setHistoryOpen(true);
                  }}
                />
              ) : null}
              {canResetAppState ? (
                <HeaderPillButton
                  icon="arrow.clockwise"
                  label="Reset app state"
                  onPress={() => {
                    Haptics.selectionAsync();
                    void handleResetAppState();
                  }}
                  disabled={!htmlArtifact}
                />
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
                <HeaderPillButton
                  icon="doc.text"
                  label={APP_SURFACE_COPY.yourWork}
                  onPress={openYourWork}
                />
              ) : null}
              {htmlArtifact ? (
                <HeaderPillButton
                  icon="rectangle.on.rectangle"
                  label={APP_SURFACE_COPY.present}
                  accessibilityLabel={APP_SURFACE_COPY.presentAccessibility}
                  onPress={startPresenting}
                />
              ) : null}
              {/* The chat sheet is a TOGGLE, not a consequence of the mode:
                  closed by default, opened by this rightmost ghost button in
                  every state, and "Chat" whether open or closed: an open panel
                  shows as the button's selected state. */}
              {/* A spinner while a reply is on its way, so a closed chat
                  still says it is working. */}
              <HeaderPillButton
                icon="bubble.left.and.bubble.right.fill"
                label="Chat"
                onPress={toggleChat}
                selected={chatOpen}
                busy={streaming}
              />
            </View>
              ),
            },
          ],
    }),
    [
      headerTitle,
      isFreePlay,
      colors,
      mode,
      isBuildSession,
      savedAt,
      nowTick,
      htmlArtifact,
      canResetAppState,
      handleResetAppState,
      chatOpen,
      toggleChat,
      builderPrimary,
      handleBackToChat,
      tileMenu,
      sessionId,
      openTileSession,
      goHome,
      router,
      statusLabel,
      hasYourWork,
      openYourWork,
      startPresenting,
      canSendToTeacher,
      questPill,
      streaming,
      hostError,
      codeView,
      handleCodeViewChange,
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

  // The drawer's tabs: Chat always; the rest once there is an app to hold.
  const savedIdeas = isFreePlay ? [] : (session?.parkingLot ?? []);
  const provocation =
    (session as { provocation?: string | null } | undefined)?.provocation ?? null;
  // Check my work on the Flair tab: an app graded by a teacher's checklist
  // (no mission lines) earns its flair only from a check. A mission app earns
  // flair while it builds, and Send to teacher hands either one in.
  const offersCheck =
    canSendToTeacher &&
    !builderDeliverable.missionApp &&
    !!htmlArtifact &&
    (builderDeliverable.criteria.length > 0 ||
      builderDeliverable.criteriaPending ||
      builderDeliverable.criteriaFailed);
  const experimentRunning = !!htmlArtifact?.content.includes("EXPERIMENT START");
  // Flair shows whenever there is an app: any app can earn spotted flair,
  // and the tab's empty state says how flair arrives.
  const drawerTabs: Array<{ id: DrawerTabId; label: string; dot?: boolean }> = htmlArtifact
    ? [
        { id: "chat", label: "Chat" },
        {
          id: "flair",
          label: "Flair",
          dot: !!provocation && provocation !== seenProvocation,
        },
        { id: "world", label: "World" },
        ...(isFreePlay
          ? []
          : [
              {
                id: "saved" as const,
                label: savedIdeas.length ? `Saved · ${savedIdeas.length}` : "Saved",
              },
            ]),
      ]
    : [{ id: "chat", label: "Chat" }];
  const activeDrawerTab: DrawerTabId = drawerTabs.some((t) => t.id === drawerTab)
    ? drawerTab
    : "chat";
  const renderMessage = (message: VibecodeMessage) => {
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
        <RuleChips events={ruleEventsAfter(message.id)} onOpen={openRuleCard} />
      </View>
    );
  };
  // One thread: the reply in flight shows whichever turn the switch sent.
  const streamingRow = visiblyStreaming ? (
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
    ) : null;
  // One composer, two homes: the chat drawer, and the floating card the voice
  // key and ⌘/ open while the drawer is closed. Same recorder, same send path.
  const renderComposer = (home: "docked" | "floating") => {
    const rowStyle =
      home === "docked"
        ? [styles.composer, { borderTopColor: colors.border }]
        : styles.floatingComposer;
    return (
      voice.isConnecting || voice.isRecording || voice.isTranscribing ? (
        <View style={rowStyle}>
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
        <View style={rowStyle}>
          {/* The session chat's attach control: camera or photo library —
              e.g. an example picture for "make the art look like this".
              The floating card stays a quick ask, so photos are the drawer's. */}
          {home === "docked" ? (
            <Pressable
              onPress={() => image.chooseAndAttach()}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Add a photo"
              style={[styles.attach, { backgroundColor: colors.charcoalSubtle }]}
            >
              <SymbolView name="plus" size={16} tintColor={colors.white} />
            </Pressable>
          ) : null}
          <AppTextInput
            ref={home === "docked" ? composerRef : floatingComposerRef}
            value={input}
            onChangeText={onChangeInput}
            placeholder={
              !tutorVoice
                ? "Tell the designer what to change…"
                : builderStance
                  ? "Ask about your app. Nothing in it will change…"
                  : "Talk to the tutor…"
            }
            placeholderTextColor={colors.fgMuted}
            style={[styles.input, { color: colors.fg, borderColor: colors.border }]}
            multiline
            submitBehavior="submit"
            onSubmitEditing={handleSend}
          />
          {/* Allow edits: what THIS message may do. On, the designer can
              change the app; off, the tutor talks about it and nothing
              changes. Replaces the Edit | Play control (one thread now). The
              floating card stays a quick ask, so the switch is the drawer's. */}
          {home === "docked" && showModeControl ? (
            <Pressable
              onPress={() =>
                editUnlocked || mode === "edit"
                  ? handleModeChange(mode === "edit" ? "play" : "edit")
                  : undefined
              }
              disabled={!editUnlocked && mode !== "edit"}
              accessibilityRole="switch"
              accessibilityState={{ checked: mode === "edit", disabled: !editUnlocked && mode !== "edit" }}
              accessibilityLabel="Allow edits"
              hitSlop={6}
              style={[styles.allowEdits, { opacity: !editUnlocked && mode !== "edit" ? 0.5 : 1 }]}
            >
              <View
                style={[
                  styles.allowTrack,
                  { backgroundColor: mode === "edit" ? colors.violetSolid : colors.border },
                ]}
              >
                <View
                  style={[
                    styles.allowKnob,
                    { backgroundColor: colors.white },
                    mode === "edit" ? styles.allowKnobOn : null,
                  ]}
                />
              </View>
              <Text style={[styles.allowLabel, { color: colors.fg }]}>Allow edits</Text>
            </Pressable>
          ) : null}
          {/* During a quiet app-update turn this stays Send: sending steers
              it, and the scholar's turn carries the in-app events instead.
              The mic is always there, typed text or not; Send sits beside it
              and wakes up once there is something to send. */}
          <Pressable
            onPress={() => void onMicStart()}
            disabled={visiblyStreaming}
            accessibilityRole="button"
            accessibilityLabel="Start recording — tap to talk, tap the check to send"
            style={[
              styles.headerGhost,
              styles.composerSecondary,
              { opacity: visiblyStreaming ? 0.4 : 1 },
            ]}
          >
            <SymbolView name="mic.fill" size={16} tintColor={colors.violet} />
          </Pressable>
          <Pressable
            onPress={visiblyStreaming ? stopStream : handleSend}
            disabled={!visiblyStreaming && !input.trim() && !image.previewUri}
            accessibilityRole="button"
            accessibilityLabel={visiblyStreaming ? "Stop generating" : "Send"}
            style={[
              styles.send,
              {
                backgroundColor: colors.violetSolid,
                opacity:
                  !visiblyStreaming && !input.trim() && !image.previewUri ? 0.4 : 1,
              },
            ]}
          >
            {visiblyStreaming ? (
              <SymbolView name="stop.fill" size={16} tintColor={colors.white} />
            ) : (
              <Text style={[styles.sendText, { color: colors.white }]}>Send</Text>
            )}
          </Pressable>
        </View>
      )
    );
  };

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
            {!presentingApp && openAppLabel ? (
              // The app switcher lives here, not in the navigation header:
              // a menu presented from the iOS 26 header toolbar never opens.
              // Preview | Code is the top bar's Code pill.
              <View style={[styles.appTopRow, { borderBottomColor: colors.border }]}>
                <View style={styles.appTopRowSpacer} />
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
                onError={reportHostFailure}
                style={styles.webView}
              />
              {hostError && !presentingApp ? (
                <View style={styles.hostErrorVeil} pointerEvents="none">
                  <View
                    style={[
                      styles.hostErrorCard,
                      { backgroundColor: colors.bg, borderColor: colors.border },
                    ]}
                  >
                    <Text style={[styles.hostErrorTitle, { color: colors.fg }]}>
                      This app couldn’t load
                    </Text>
                    <Text style={[styles.hostErrorText, { color: colors.fgMuted }]}>
                      {hostError}
                    </Text>
                    <Text style={[styles.hostErrorText, { color: colors.fgMuted }]}>
                      Tell the builder what you see and it can change the app.
                    </Text>
                  </View>
                </View>
              ) : null}
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
                  {codeEditing ||
                  !(htmlArtifact.content ?? "").trim() ||
                  hasPendingCodeDraft(String(htmlArtifact._id), htmlArtifact.content ?? "") ? (
                    <>
                      {(htmlArtifact.content ?? "").trim() ? (
                        <Pressable
                          // Save the hand edit before the reader shows the
                          // saved code, as switching to Preview does; a failed
                          // save keeps the editor (and its conflict banner) up.
                          onPress={() =>
                            void leaveCodeView().then((ok) => {
                              if (ok) setCodeEditing(false);
                            })
                          }
                          style={styles.codeReadLink}
                          accessibilityRole="button"
                        >
                          <Text style={[styles.codeReadLinkText, { color: colors.violet }]}>
                            ‹ Back to reading
                          </Text>
                        </Pressable>
                      ) : null}
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
                        // Typing into an empty app must not flip to the
                        // reader once the first save lands: a focused editor
                        // stays the editor until "Back to reading".
                        onFocus={() => setCodeEditing(true)}
                        code
                      />
                    </>
                  ) : (
                    <AppCodeReader
                      source={htmlArtifact.content ?? ""}
                      rules={codeRules}
                      startingRules={codeStartingRules}
                      onEdit={() => setCodeEditing(true)}
                    />
                  )}
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
        ) : artifacts === undefined ? (
          // The session's apps haven't loaded yet. Painting "Start building"
          // here read as if the app was gone, and a finished teacher build
          // would show build progress (its kickoff flag never clears), so
          // loading comes before every no-app state.
          <View
            style={styles.previewCenter}
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel="Loading the app"
          >
            <ActivityIndicator color={colors.violet} />
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
        {presentingApp && htmlArtifact && presenting ? (
          <AppTalkSession
            appKey={htmlArtifact._id}
            title={htmlArtifact.title}
            mode={presenting}
            onDone={stopPresenting}
          />
        ) : null}
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
        title={missionTitle ?? (tutorVoice ? "Tutor" : "Designer")}
        eyebrow={missionTitle ? "Mission" : undefined}
        // Swipe down, a tap on the app behind it, or Hide chat closes it.
        hideClose
        // Mission (eyebrow + title) on the left, tabs on the right: one row.
        headerTrailing={
          <DrawerTabs
            tabs={drawerTabs}
            active={activeDrawerTab}
            onChange={(id) => {
              Haptics.selectionAsync();
              if (id === "flair") setSeenProvocation(provocation);
              setDrawerTab(id);
            }}
          />
        }
      >
        {activeDrawerTab === "flair" ? (
          <FlairPanel
            key={htmlArtifact ? String(htmlArtifact._id) : "none"}
            flairEarned={builderDeliverable.appDeliverable?.flairEarned}
            criteria={builderDeliverable.criteria}
            deliverableId={builderDeliverable.appDeliverable?._id}
            sessionId={sessionId}
            missionLines={builderDeliverable.missionLines}
            provocation={provocation}
            onSayMore={() => handleSayMore(provocation)}
            experimentRunning={experimentRunning}
            onEndExperiment={editUnlocked ? handleEndExperiment : undefined}
            check={
              offersCheck && htmlArtifact
                ? {
                    onCheck: () => {
                      // The check's reply streams into the chat.
                      setDrawerTab("chat");
                      void runRubricCheck(htmlArtifact, true);
                    },
                    onRetry: () => {
                      void builderDeliverable.retryCriteria().catch((error) =>
                        Alert.alert(
                          "Couldn't prepare the check",
                          error instanceof Error ? error.message : "Please try again.",
                        ),
                      );
                    },
                    busy: checkBusy,
                    preparing: builderDeliverable.criteriaPending,
                    failed: builderDeliverable.criteriaFailed,
                    disabled:
                      streaming || !htmlArtifact.content.trim() || hostError !== null,
                  }
                : null
            }
          />
        ) : activeDrawerTab === "world" ? (
          <WorldPanel rules={worldRules} onOpenRule={openRuleCard} />
        ) : activeDrawerTab === "saved" ? (
          <ScrollView contentContainerStyle={styles.savedTab}>
            {savedIdeas.length ? (
              <ParkedIdeaList
                ideas={savedIdeas}
                renderActions={builderDone ? doneIdeaActions.renderActions : undefined}
              />
            ) : (
              <Text style={[styles.chatEmpty, { color: colors.fgMuted }]}>
                Ideas you save for later show up here.
              </Text>
            )}
          </ScrollView>
        ) : null}
        {/* The chat stays mounted under the other tabs, so its scroll and
            draft survive a trip to World and back. */}
        <View style={[styles.chatBody, activeDrawerTab !== "chat" && styles.hidden]}>
          <ScrollView
            ref={scrollRef}
            style={styles.thread}
            contentContainerStyle={styles.threadBody}
            scrollEventThrottle={32}
            // iOS's tap-the-top scroll-to-top waits out a double tap, so on the
            // simulator the tap on Chat itself set it off once the thread had
            // mounted, carrying a just-opened thread from its end to the top
            // (2026-11-14). A thread that drew slower than that hid it.
            scrollsToTop={false}
            // An older page drawn above the scholar keeps the line they were
            // on in place, in the same frame, even mid-fling. Index 0 is the
            // "Show earlier messages" row, which stays put while the page goes
            // in below it, so the anchor is the first message under it.
            maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
            onScroll={(e) => {
              const { contentOffset, contentSize, layoutMeasurement } =
                e.nativeEvent;
              chatAtEndRef.current =
                contentSize.height - (contentOffset.y + layoutMeasurement.height) <
                CHAT_FOLLOW_SLOP;
              if (
                earlierHidden &&
                chatDraggedRef.current &&
                contentOffset.y < THREAD_LOAD_EARLIER_DISTANCE &&
                contentSize.height !== revealedAtHeightRef.current
              ) {
                revealedAtHeightRef.current = contentSize.height;
                revealEarlier();
              }
            }}
            onScrollBeginDrag={() => {
              chatFingerDownRef.current = true;
              chatDraggedRef.current = true;
            }}
            onScrollEndDrag={() => {
              chatFingerDownRef.current = false;
            }}
            onContentSizeChange={() => {
              if (chatAtEndRef.current && !chatFingerDownRef.current) {
                followChatToEnd();
              }
            }}
          >
            {/* Scrolling up draws the next older page; the row does the same
                where the page is too short to scroll. */}
            {earlierHidden ? (
              <Pressable
                onPress={revealEarlier}
                style={styles.earlierRow}
                accessibilityRole="button"
                hitSlop={8}
              >
                <Text style={[styles.earlierText, { color: colors.violet }]}>
                  Show earlier messages
                </Text>
              </Pressable>
            ) : null}
            {/* The brief — a muted first card in the DESIGNER thread, rendered
                client-side from the activity's appRequest. Never a persisted
                message, and never present for a scholar (the server withholds
                it). It opens the thread, so it waits for its first page. */}
            {mode === "edit" && briefText && !earlierHidden ? (
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
              shownMessages.map(renderMessage)
            )}
            <RuleChips events={trailingRuleEvents} onOpen={openRuleCard} />
            {sentToTeacherAt ? (
              <Text style={[styles.sentLine, { color: colors.fgMuted }]}>
                Sent to your teacher
              </Text>
            ) : null}
            {streamingRow}
          </ScrollView>

          {image.previewUri ? (
            <View style={styles.photoRow}>
              <PendingPhotoChip
                uri={image.previewUri}
                uploading={image.uploading}
                onRemove={image.clear}
              />
            </View>
          ) : null}
          {renderComposer("docked")}
        </View>
      </Drawer>

      {/* Send to teacher hands the teacher a snapshot of the app. It never
          ends play. */}
      <TeacherHandoffSheet
        open={sendSheetOpen && !presentingApp}
        onClose={() => setSendSheetOpen(false)}
        title="Send to your teacher"
        body="Your teacher gets a copy of your app as it is right now. You can keep building after."
        secondary={{ label: "Cancel" }}
        primary={{ label: "Send", busyLabel: "Sending…", onPress: handleSendToTeacher }}
        failedText="Couldn’t send. Try again."
      />

      <FloatingChatPanel
        open={floatingOpen}
        title={tutorVoice ? "Tutor" : "Designer"}
        onClose={closeFloating}
        onExpand={() => {
          setFloating(null);
          setChatOpen(true);
        }}
        thread={
          floatingTurns.length > 0 || streamingRow || image.previewUri ? (
            <>
              {floatingTurns.map(renderMessage)}
              {streamingRow}
              {image.previewUri ? (
                <PendingPhotoChip
                  uri={image.previewUri}
                  uploading={image.uploading}
                  onRemove={image.clear}
                />
              ) : null}
            </>
          ) : null
        }
        composer={renderComposer("floating")}
      />

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

  // Top bar (rendered into the expo-router header). The APP eyebrow and the
  // title share a left edge.
  headerTitleBlock: { alignItems: "flex-start", maxWidth: 280 },
  headerEyebrow: {
    fontFamily: fonts.semibold,
    fontSize: 10,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  headerTitleText: {
    fontFamily: fonts.semibold,
    fontSize: 16,
  },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  savedAt: { fontFamily: fonts.regular, fontSize: 12 },
  // Header actions are HeaderPillButton pills, spaced by styles.headerRight's
  // gap. The composer's mic button borrows the same pill shape.
  headerGhost: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    height: 34,
    borderRadius: 17,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(31,36,66,0.14)",
    backgroundColor: "rgba(255,255,255,0.9)",
  },
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
  appTopRowSpacer: { flex: 1 },
  appSwitcherWrap: { paddingHorizontal: 12 },
  previewStage: { flex: 1 },
  hostErrorVeil: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  hostErrorCard: {
    maxWidth: 420,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 16,
    gap: 6,
  },
  hostErrorTitle: { fontSize: 17, fontWeight: "600" },
  hostErrorText: { fontSize: 14, lineHeight: 20 },
  codeSheet: { ...StyleSheet.absoluteFill },
  codeSheetContent: { padding: 12 },
  codeReadLink: { alignSelf: "flex-start", paddingVertical: 6, marginBottom: 4 },
  codeReadLinkText: { fontFamily: fonts.semibold, fontSize: 15 },
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
  hidden: { display: "none" },
  sentLine: { fontFamily: fonts.regular, fontSize: 14, textAlign: "center", marginVertical: 8 },
  savedTab: { paddingVertical: 4, gap: 8 },
  thread: { flex: 1 },
  threadBody: { paddingVertical: 12, gap: 8 },
  chatEmpty: { fontFamily: fonts.regular, fontSize: 14 },
  earlierRow: { alignSelf: "center", paddingVertical: 8, marginBottom: 4 },
  earlierText: { fontFamily: fonts.semibold, fontSize: 15 },
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
    // Room for iPadOS's minimized-keyboard pill (the glass "A" key badge).
    // With a hardware keyboard attached — the fleet's Folio posture — iPadOS
    // floats it in the bottom-RIGHT screen corner whenever a field is
    // focused, which is exactly where this full-width sheet's Send/mic button
    // lands, and AppTextInput's `disableKeyboardShortcuts` no longer removes
    // it. Measured off a device photo: the pill spans ~20–100pt in from the
    // screen's right edge, level with this row; the sheet body already pads
    // 18pt, so this keeps the button clear with a little air. Reserved always,
    // not on focus, so the button never jumps sideways when the field is
    // tapped. Both composer rows (text and RecordingBar) share it.
    paddingRight: 92,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontFamily: fonts.regular,
    // The shared composer size, matching the 18pt chat text.
    ...CHAT_COMPOSER_INPUT,
    maxHeight: 110,
  },
  // Send (primary) and the mic (secondary, styled like the header's
  // History/Present pills) share one 38pt height with Allow edits, so the
  // composer row's controls line up.
  send: {
    paddingHorizontal: 16,
    height: 38,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  composerSecondary: { height: 38, borderRadius: 19, paddingHorizontal: 14 },
  // Same 38pt box as Send and the attach button: the row aligns its items to
  // the bottom (the text box grows upward), so a shorter switch sat low.
  allowEdits: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 4,
    height: 38,
  },
  allowTrack: { width: 40, height: 24, borderRadius: 12, padding: 2, justifyContent: "center" },
  allowKnob: { width: 20, height: 20, borderRadius: 10 },
  allowKnobOn: { alignSelf: "flex-end" },
  allowLabel: { fontFamily: fonts.semibold, fontSize: 14 },
  attach: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  photoRow: { paddingTop: 10 },
  // The floating card pads its own composer slot and sits clear of iPadOS's
  // keyboard pill, so this row needs none of the drawer row's insets.
  floatingComposer: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  sendText: { fontFamily: fonts.semibold, fontSize: 14 },
});
