import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useAuthToken } from "@convex-dev/auth/react";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { fetch as expoFetch } from "expo/fetch";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { FlatList } from "react-native-gesture-handler";
import Animated, { Keyframe, useReducedMotion } from "react-native-reanimated";
import { SymbolView } from "expo-symbols";
import { Image } from "expo-image";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";

import { ChatSkeleton } from "@/components/ChatSkeleton";
import { AppSnapshotBubble } from "@/components/AppSnapshotBubble";
import type { CodeArtifactWebViewHandle } from "@/components/CodeArtifactWebView";
import { Markdown } from "@/components/Markdown";
import { StreamingText } from "@/components/StreamingText";
import { OfflineSessionView } from "@/components/OfflineSessionView";
import { WorkbenchScreen } from "@/components/workbench/WorkbenchScreen";
import { VibecodeScreen } from "@/components/vibecode/VibecodeScreen";
import { RecordingBar } from "@/components/RecordingBar";
import { GlassBar } from "@/components/Glass";
import { WhereAmIPanel } from "@/components/WhereAmIPanel";
import { appStatusBus } from "@/lib/appStatusBus";
import { SessionActivityNav } from "@/components/SessionActivityNav";
import { SpeakableBubble } from "@/components/SpeakableBubble";
import { DeliverableCard } from "@/components/DeliverableCard";
import { GeoMapCard, isMapArtifact } from "@/components/GeoMapCard";
import { ManipulativeCard } from "@/components/ManipulativeCard";
import { SessionRecapCard } from "@/components/SessionRecapCard";
import { DispatchCompletionReceipt } from "@/components/DispatchCompletionReceipt";
import {
  clearPendingArtifactSaves,
  DeliverablePanel,
  flushPendingArtifactSaves,
} from "@/components/DeliverablePanel";
import { PhysicalTaskCard } from "@/components/PhysicalTaskCard";
import {
  ResourceShareCard,
  type ResourceShare,
} from "@/components/ResourceShareCard";
import { GraphemeText } from "@/components/GraphemeText";
import { ChatActivityRow, type ChatActivity } from "@/components/ChatActivityRow";
import {
  ChatPracticeItem,
  type ChatPracticePayload,
} from "@/components/practice/ChatPracticeItem";
import { InstructionChatCard, type InstructionChatPayload, type InstructionHandbackStart } from "@/components/practice/InstructionChatCard";
import { ManipulativeScrollContext } from "@/components/manipulatives/kit";
import { useStreamingDictation } from "@/hooks/useStreamingDictation";
import { useImageAttachment } from "@/hooks/useImageAttachment";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";
import { useUnitProgress } from "@/hooks/useUnitProgress";
import { useRoomTurnPhase } from "@/hooks/useRoomTurnPhase";
import { useRoomTurnAwareness } from "@/hooks/useRoomTurnAwareness";
import { useActiveRoomCues } from "@/hooks/useActiveRoomCues";
import { RoomCueBanner } from "@/components/RoomCueBanner";
import { RestOverlay } from "@/components/RestOverlay";
import { buildStageMap } from "@/lib/graphemeStageMap";
import { getNativeTTS } from "@/lib/nativeTTS";
import { voiceMark } from "@/lib/voicePerf";
import { api, convexSiteUrl, type Id } from "@/lib/convex";
import { isTextArtifact } from "../../../vendor/shared/textArtifacts";
import { uploadChangedAppSnapshot } from "@/lib/appSnapshot";
import { uploadImageDataUrl } from "@/lib/uploadImage";
import { shouldSkipLearnerQueries } from "@/lib/sessionLearnerQueries";
import { CHAT_COMPOSER_INPUT } from "@/lib/chatType";
import { chatBubbleStyles, OPENER_SENTINEL } from "@/lib/chatBubbles";
import { composerPayloadKey, createSendLock } from "@/lib/sendLock";
import { friendlyToolName } from "@/lib/toolLabels";
import { isTutorBusyError } from "@/lib/tutorStreamError";
import {
  parseTutorSseText,
  readTutorSse,
  type TutorStreamEvent,
} from "@/lib/tutorSse";
import {
  deriveServerTurnState,
  parseRetryAfterSeconds,
  pendingTurnLabel,
  planStreamRetry,
} from "../../../vendor/shared/streamRetry";
import {
  appTutorSendResultFromStatus,
  newestAppTutorAskContext,
  settleAppTutorSend,
  type AppTutorSendResult,
  type AppTutorUpdateBatch,
} from "../../../vendor/shared/appTutorRequest";
import { useAppTutorUpdates } from "@/hooks/useAppTutorUpdates";
import { fonts, palette, useColors } from "@/theme";
import { FlairMark } from "@/components/FlairChips";
import { FLAIR_MOTION, flairNoticeDelayMs } from "../../../vendor/shared/flairMotion";
import { useFlairArrivals } from "../../../vendor/shared/useFlairArrivals";
import type { GraphemeSpan } from "../../../vendor/shared/graphemeSegments";
import { pickLockingFocus } from "../../../vendor/shared/focusLock";
import { useQuestBakeHold } from "../../../vendor/shared/questBakeHold";
import {
  classFocusPlateLine,
  focusMismatchBannerText,
  formatRoomTurnTime,
  TURNED_BANNER_TEXT,
  WINDING_DOWN_BANNER_TEXT,
} from "../../../vendor/shared/roomTurn";
import { AppTextInput } from "@/components/AppTextInput";
import {
  hasToolRowDisplay,
  toolRowDisplay,
} from "../../../vendor/shared/toolActivity";
import { dueStatus } from "../../../vendor/shared/institutionDay";
import {
  HOMEWORK_DONE_CONFIRMED,
  HOMEWORK_DONE_LABEL,
  HOMEWORK_DONE_UNDO,
  homeworkEyebrow,
} from "../../../vendor/shared/homeworkFraming";
import { useNow } from "@/hooks/useNow";
const COLUMN_MAX_WIDTH = 720;
// How long a pending turn must run before the Stop control arms with no text
// yet on screen (the escape hatch for a busy-backend wait). See stopArmed.
const STOP_ARM_DELAY_MS = 2000;

/** Wait `ms`, resolving true on timeout or false the moment `signal` aborts. */
function sleepAbortable(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * A failed turn never evaporates: the scholar's message stays visible and this
 * calm inline row offers a one-tap retry that re-runs the same turn (no
 * retyping, no duplicate message). The native twin of web's TutorTurnFailedNotice.
 */
function TutorTurnFailedRow({ onRetry }: { onRetry: () => void }) {
  const colors = useColors();
  return (
    <View
      style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 }}
    >
      <Text
        style={{
          fontSize: 14,
          lineHeight: 20,
          fontFamily: fonts.regular,
          color: colors.charcoalSubtle,
        }}
      >
        Didn&apos;t go through
      </Text>
      <Pressable
        onPress={onRetry}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Try again"
        style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
      >
        <SymbolView name="arrow.clockwise" size={13} tintColor={colors.violet} />
        <Text style={{ fontSize: 14, fontFamily: fonts.medium, color: colors.violet }}>
          Try again
        </Text>
      </Pressable>
    </View>
  );
}

type Bubble = {
  key: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  messageId?: Id<"messages">;
  gotItWrong?: boolean;
  imageId?: Id<"_storage">;
  // URLs are served beside the row by getWithMessages (never minted client-side).
  imageUrl?: string | null;
  appSnapshotUrl?: string | null;
  // A tutor-generated illustration (`generate_image`), which rides on a TOOL
  // row alongside its receipt label. Kept separate from `imageId` (a scholar's
  // photo attachment) because the two render differently: a photo is a square
  // thumbnail, an illustration is content whose labels have to stay readable.
  generatedImage?: { url: string | null; altText?: string };
  // Tool-row payload for the tutor-suggested "Go try this" card.
  physicalTaskId?: string;
  // A plain receipt line naming what the tutor just did, for tool rows with no
  // rich payload of their own (see isToolActivityLabel).
  toolActivity?: string;
  resourceShare?: ResourceShare;
  completion?: boolean;
  chatPractice?: ChatPracticePayload;
  instruction?: InstructionChatPayload;
  flairAwards?: FlairAward[];
  // Reading-ramp grapheme spans (young-learners-plan.html §10). Present (post-
  // stream) only for a pre-reader scholar's tutor replies — the annotator writes
  // them ONLY for scholars with an active grapheme inventory, so their mere
  // existence is the gate; no client-side reading-level check is needed. Drives
  // the GraphemeText render when the caller also has a non-empty stage map.
  graphemeSpans?: readonly GraphemeSpan[];
  // A synthetic trailing row that hosts the "didn't go through — try again"
  // affordance for a failed turn whose placeholder may already be gone.
  failed?: boolean;
  // Set (never cleared) when the user cut this reply short — drives the muted
  // "Stopped" caption under the finalized bubble.
  stopRequestedAt?: number | null;
};

type FlairAward = {
  criterionId: string;
  label: string;
};

// A tutor stream ends one of three ways: it finished, the user aborted it (Stop
// or steer or unmount — never a failure), or it genuinely failed (busy budget
// exhausted / hard error → the caller shows the inline retry affordance).
type TutorStreamResult = "completed" | "aborted" | "failed";

export default function SessionScreen() {
  // `title` is passed from the home card so the nav bar shows the real title
  // INSTANTLY (no "Session" placeholder) even while messages load.
  const router = useRouter();
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
  const sessionId = id as Id<"sessions">;
  useEffect(() => () => clearPendingArtifactSaves(), [sessionId]);
  const { width, height } = useWindowDimensions();
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  useFocusEffect(
    useCallback(() => {
      appStatusBus.setSessionRoute(`/session/${sessionId}`, sessionId);
      return () => appStatusBus.clearSession(sessionId);
    }, [sessionId]),
  );

  const data = useQuery(api.sessions.getWithMessages, { id: sessionId });
  const sendMessage = useMutation(api.sessions.sendMessage);
  const startAppUpdateTurn = useMutation(api.sessions.startAppUpdateTurn);
  // The SAME completion toggle the Big picture drawer (WhereAmIPanel) uses —
  // surfaced on the composer so a child can actually find it. Not a second
  // completion mechanism.
  const markActivityComplete = useMutation(api.activityCompletions.markComplete);
  const unmarkActivityComplete = useMutation(
    api.activityCompletions.unmarkComplete,
  );
  const [homeworkDoneSaving, setHomeworkDoneSaving] = useState(false);
  const requestStopMut = useMutation(api.sessions.requestStop);
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const retryAssistantTurn = useMutation(api.sessions.retryAssistantTurn);
  const toggleWrong = useMutation(api.messageFlags.toggle);
  const createSession = useMutation(api.sessions.create);
  // Kicks off a rubric re-check with NO fabricated user turn — creates only an
  // assistant placeholder; the stream injects an ephemeral, non-persisted
  // instruction (convex/http.ts). Matches the web "Check my work" flow.
  const startRubricCheck = useMutation(api.sessions.startRubricCheck);
  const submitDeliverable = useMutation(api.deliverables.submit);
  const startActivityKickoff = useMutation(api.sessions.startActivityKickoff);
  const skipLearnerQueries = shouldSkipLearnerQueries(data);
  const loadLearnerContext = !skipLearnerQueries;
  const activeSessions = useQuery(
    api.sessions.list,
    loadLearnerContext ? { asLearner: true } : "skip",
  );
  const currentFocus = useQuery(
    api.assignments.currentClassFocusForMe,
    loadLearnerContext ? { asLearner: true } : "skip",
  );
  const homeworkForMe = useQuery(
    api.assignments.homeworkForMe,
    loadLearnerContext ? { asLearner: true } : "skip",
  );
  // The caller's own reading-ramp inventory (`{ team, stage }[]`, or `[]` when
  // none). Folded once into a `team → stage` map; an empty map is the plain-text
  // fast path (no GraphemeText anywhere). Only pre-reader scholars have an
  // inventory, so this is empty for everyone else. See buildStageMap.
  const graphemeInventory = useQuery(
    api.graphemeInventory.mine,
    loadLearnerContext ? {} : "skip",
  );
  // Whether the scholar has read-aloud on — same gate as web + SpeakableLabel.
  // A tutor bubble is tappable-to-read only when this is true (default on).
  const me = useQuery(api.users.currentUser, {});
  const memberships = useQuery(api.memberships.myMemberships, {});
  const hasLearnerContext =
    me?.role === "scholar" ||
    memberships?.some((membership) => membership.role === "scholar") === true;
  const ttsEnabled = me?.ttsEnabled !== false;
  const graphemeStages = useMemo(
    () => buildStageMap(graphemeInventory),
    [graphemeInventory],
  );
  const hasGraphemeStages = Object.keys(graphemeStages).length > 0;
  const [whereOpen, setWhereOpen] = useState(false);
  const authToken = useAuthToken();
  const inputRef = useRef<TextInput>(null);
  const chatScrollRef = useRef(null);
  const welcomeSentRef = useRef<string | null>(null);
  const kickoffPendingRef = useRef(false);
  const kickoffRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Aborts an in-flight tutor stream (and any busy-retry wait) on unmount, so a
  // scholar who leaves the session mid-retry never has a stray POST land or a
  // setState fire on the unmounted screen. Web's useAgentStream does the same
  // via its own AbortController; this is the native twin.
  const streamAbortRef = useRef<AbortController | null>(null);
  // Monotonic turn id. A steered-away or stopped turn's cleanup only runs when
  // it still owns the latest id, so an aborted turn never clobbers the turn that
  // replaced it. See onStop / onSend's steering branch.
  const turnSeqRef = useRef(0);
  // Set by Stop regardless of whether the assistant id is known yet, so a Stop
  // tapped during the pre-mutation window (before sendMessage resolves) is
  // honored once the row exists — finalize it server-side instead of firing a
  // fetch that would abort instantly and orphan the placeholder row.
  const stopRequestedRef = useRef(false);
  // Single-flight claim over a send's claim+persist phase. Claimed
  // synchronously at the top of onSend and released the moment sendMessage
  // settles, so a second submit inside the pre-resolve window (double Return,
  // Return + a tap on the send arrow, a hardware-keyboard key repeat) can't
  // persist the same text twice — while a later steer, which happens once the
  // tutor is actually streaming, is untouched. See @/lib/sendLock.
  const sendLockRef = useRef(createSendLock());
  // What the composer held for the send we most recently persisted — null once
  // the scholar has touched the box since. The send claim cannot cover this on
  // its own: `setInput("")` is a React state update that commits on a LATER
  // task, so for a frame after a send the ALREADY-RENDERED submit handler still
  // closes over the old text, and by then the claim has (correctly) been
  // released so a steer can take it. Comparing the submitted payload against
  // this ref makes that stale resubmit a no-op, while a genuinely retyped
  // identical answer ("yes", "3") still sends — typing clears the ref.
  const sentComposerRef = useRef<string | null>(null);
  const codeArtifactRef = useRef<CodeArtifactWebViewHandle>(null);
  // True while the in-flight turn is an app update (startAppUpdateTurn): it
  // stays invisible until the tutor actually says something.
  const [appUpdateStreaming, setAppUpdateStreaming] = useState(false);
  // The app-update queue's handle, for onSend (declared before the hook that
  // owns the queue, which itself sends through onSend).
  const appTutorUpdatesRef = useRef<{ clearAppAi: () => void } | null>(null);
  const lastSentSnapshotRef = useRef<{
    sessionId: Id<"sessions">;
    hash: string;
  } | null>(null);
  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort();
    };
  }, []);
  const image = useImageAttachment();
  // ONE animated inset drives both the list shrink AND the composer rise in
  // lockstep with the keyboard. See useKeyboardInset for why this is not
  // Reanimated's useAnimatedKeyboard.
  const { style: keyboardInsetStyle } = useKeyboardInset();

  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [kickoffPending, setKickoffPending] = useState(false);
  const [, bumpKickoffRetry] = useState(0);
  const [streamingText, setStreamingText] = useState("");
  // On a user-initiated Stop we hold the last partial for that assistant row so
  // it stays on screen until the server-finalized row lands (≤1.5 s), instead of
  // flashing empty while the persisted content catches up. Cleared at the start
  // of the next turn; harmless once the row's own content is non-empty.
  const [stoppedPartial, setStoppedPartial] = useState<{
    id: string;
    text: string;
  } | null>(null);
  const [navigatingNext, setNavigatingNext] = useState(false);
  // The transient tool/thinking/image status for the in-flight turn (mirrors the
  // web SessionInterface's tool-activity indicator + "Generating image…" — see
  // ChatActivityRow). Null when the tutor is idle or just streaming text.
  const [activity, setActivity] = useState<ChatActivity | null>(null);
  // The just-created assistant placeholder row — filtered out of the persisted
  // list while we render its live streaming text instead (avoids a dupe).
  const [liveAssistantId, setLiveAssistantId] = useState<string | null>(null);
  // The inline "Didn't go through — try again" affordance is for FAILED SCHOLAR
  // (user) turns only. This flag is set when a user-turn send exhausts its retry
  // budget (or hard-errors) in THIS tab; silent turns (kickoff / rubric check)
  // never set it. A dead user placeholder after a remount is derived from server
  // truth below.
  const [userTurnFailed, setUserTurnFailed] = useState(false);
  // When the in-flight turn began (ms) — clock for the escalating pending copy.
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  // Ticks once a second while a turn is pending, to advance that copy and to
  // cross the dead-placeholder threshold on a stuck turn.
  const [nowTick, setNowTick] = useState(() => Date.now());
  const activeKickoffPlaceholder =
    data?.messages.length === 1 &&
    data.messages[0].role === "assistant" &&
    data.messages[0].content.trim() === "" &&
    !!data.messages[0].streamId &&
    data.messages[0].streamTrigger === "activityKickoff"
      ? data.messages[0]
      : null;
  // A quest launched before its activity exists holds its opening turn until
  // the background bake lands (vendor/shared/questBakeHold.ts). Same state the
  // kickoff flag already models — the opening turn has not happened yet — so it
  // rides the same busy flag rather than a parallel one.
  const questBakeHolding = useQuestBakeHold(data?.session);
  const tutorBusy =
    streaming ||
    kickoffPending ||
    activeKickoffPlaceholder !== null ||
    questBakeHolding;
  // An app-update turn that has not spoken yet is invisible: no "…" bubble,
  // no Stop control (sending steers it). Once text arrives it is an ordinary
  // tutor reply.
  const quietTurn = streaming && appUpdateStreaming && !streamingText.trim();
  const visiblyStreaming = streaming && !quietTurn;

  // Server-truth pending/failed turn (mirrors web SessionInterface). The
  // trailing empty assistant placeholder with a streamId means a turn is in
  // flight — even after a remount, or across a busy wait-and-retry. Once it is
  // older than the orphan-reap window (or this client gave up), it is "dead":
  // the composer re-enables and an inline retry appears, so a stuck turn never
  // locks the composer forever.
  const lastMessage =
    data?.messages && data.messages.length > 0
      ? data.messages[data.messages.length - 1]
      : null;
  const serverTurnState = deriveServerTurnState(
    lastMessage
      ? {
          role: lastMessage.role,
          content: lastMessage.content ?? "",
          streamId: lastMessage.streamId ?? null,
          createdAt: lastMessage.createdAt,
          lastStreamActivityAt: lastMessage.lastStreamActivityAt ?? null,
          // A quiet app-update placeholder reads "idle" (no "…", no retry).
          streamTrigger: lastMessage.streamTrigger ?? null,
        }
      : null,
    nowTick,
  );
  // Turn state — same two-source model as web (see streamRetry.ts + finding 7):
  // this tab's local `streaming` / `userTurnFailed` is authoritative for the tab
  // that owns the fetch; the server-derived state governs OTHER views / after a
  // remount.
  const clientFailedHere = userTurnFailed && !streaming;
  // Server-derived dead SCHOLAR turn: the trailing placeholder is dead, is NOT a
  // silent turn (no streamTrigger — a kickoff placeholder carries
  // streamTrigger: "activityKickoff"), and the message before it (skipping tool
  // rows) is a scholar `user` message (a rubric-check placeholder is preceded by
  // an assistant message, so it is excluded). A dead silent turn gets NO
  // affordance — kickoff self-recovers, and "Check my work" is the rubric retry.
  const deadScholarTurn =
    serverTurnState === "dead" &&
    !!lastMessage &&
    lastMessage.role === "assistant" &&
    !lastMessage.streamTrigger &&
    (() => {
      const msgs = data?.messages ?? [];
      for (let i = msgs.length - 2; i >= 0; i--) {
        if (msgs[i].role === "tool") continue;
        return msgs[i].role === "user";
      }
      return false;
    })();
  const isDeadTurn = !streaming && (clientFailedHere || deadScholarTurn);
  const isServerPending =
    !isDeadTurn && !streaming && serverTurnState === "pending";
  // Composer is disabled while a turn is pending (client OR server truth), but
  // re-enables the moment the placeholder is dead. NOTE: local `streaming` is
  // deliberately NOT a blocker — the composer stays editable so a submit can
  // steer (stop the in-flight reply and send the new turn); the other guards
  // (kickoff, quest-bake hold, server-pending) still block.
  const composerBusy =
    ((kickoffPending ||
      activeKickoffPlaceholder !== null ||
      questBakeHolding ||
      isServerPending) &&
      !isDeadTurn);
  // Clock for the escalating "thinking" copy: the live turn's start for an
  // active stream, else the placeholder's creation time (survives a remount).
  const pendingSince = streaming
    ? (turnStartedAt ?? lastMessage?.createdAt ?? null)
    : isServerPending
      ? (lastMessage?.createdAt ?? null)
      : null;
  const pendingLabel =
    pendingSince != null ? pendingTurnLabel(nowTick - pendingSince) : null;
  // The Stop control is ARMED only once stopping would preserve something: the
  // first text has arrived, or the turn has been pending long enough that an
  // escape hatch matters (a busy-backend wait, a long tool call). Before that,
  // the slot shows an inert Send so a second tap on Send — a young scholar's
  // "did it go?" — cannot cancel the reply at zero tokens and strand the turn
  // as an empty "Stopped" bubble. Seen twice in prod (one scholar, both
  // session-ending, stop 0.5–0.9 s after send). Deliberately NOT keyed on
  // `activity`: the "thinking" chip lands well inside the window with nothing
  // to preserve. nowTick advances once a second while a turn is pending, so
  // the time gate resolves on its own.
  const stopArmed =
    streaming &&
    (streamingText.length > 0 ||
      (pendingSince != null && nowTick - pendingSince >= STOP_ARM_DELAY_MS));

  useEffect(() => {
    if (!streaming && !isServerPending) return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [streaming, isServerPending]);

  const headerTitle = data?.session?.title ?? title ?? "Session";
  const sessionActivityId = data?.session?.activityId as Id<"activities"> | undefined;
  const sessionUnitId = data?.session?.unitId as Id<"units"> | undefined;
  // The tutor can create a document in ANY session, so a session with no
  // activity still needs the work surface once it holds one (TRA-463). Same
  // subscription the panel/card make, so Convex dedupes it.
  const sessionArtifacts = useQuery(api.artifacts.getBySession, { sessionId });
  const hasTextArtifacts = (sessionArtifacts ?? []).some(isTextArtifact);
  const hasMapArtifact = (sessionArtifacts ?? []).some(isMapArtifact);
  const activityCompletedAt = data?.session?.activityCompletedAt ?? null;
  const activityCompletionMessageId =
    data?.session?.activityCompletionMessageId ?? null;
  const progress = useUnitProgress({
    unitId: sessionUnitId,
    activityId: sessionActivityId,
    assignmentId: data?.session?.assignmentId,
    enabled: loadLearnerContext && !!sessionUnitId,
  });
  const firstFocus = pickLockingFocus(currentFocus);
  const focusLock = firstFocus
    ? {
        unitId: firstFocus.unitId ? String(firstFocus.unitId) : null,
        lessonId: firstFocus.lessonId ? String(firstFocus.lessonId) : null,
        lessonTitle: firstFocus.lessonTitle ?? null,
        label:
          firstFocus.activityTitle ??
          firstFocus.lessonTitle ??
          firstFocus.unitTitle ??
          null,
        // "The turn, not the bell" — when (+ in what timezone) this class
        // focus wraps, so the banners render a soft local time instead of a
        // bare "paused until then".
        endsAt: firstFocus.endsAt ?? null,
        timeZone: firstFocus.timeZone,
      }
    : null;
  const sessionAssignmentId = data?.session?.assignmentId
    ? String(data.session.assignmentId)
    : null;
  const sessionActivityIdForHomework = data?.session?.activityId
    ? String(data.session.activityId)
    : null;
  // The homework row itself, not just the boolean — it already carries the
  // deadline and the teacher who set it, which the tonight list on the home
  // screen renders and this screen used to drop the moment a scholar tapped in.
  const homeworkForThisSession =
    sessionAssignmentId && sessionActivityIdForHomework
      ? ((homeworkForMe ?? []).find(
          (h) =>
            String(h.assignmentId) === sessionAssignmentId &&
            String(h.activityId) === sessionActivityIdForHomework,
        ) ?? null)
      : null;
  const isHomeworkSession = !!homeworkForThisSession;
  // Ticks at 60s so the deadline re-derives across institution midnight while
  // the app sits open on the iPad overnight.
  const homeworkNowMs = useNow(60_000);
  const homeworkEyebrowText = homeworkForThisSession
    ? homeworkEyebrow(
        dueStatus(
          homeworkForThisSession.dueAt,
          homeworkNowMs,
          homeworkForThisSession.timeZone,
        )?.phrase,
        homeworkForThisSession.teacherName,
      )
    : null;
  // The class is on a different unit/lesson than this session. INFORMATIONAL
  // ONLY since the hard focus gate was removed (vendor/shared/focusLock.ts):
  // it drives a soft "right now your class is with X" banner and nothing else.
  const isFocusMismatch = !isHomeworkSession && focusLock?.unitId != null && (
    String(data?.session?.unitId ?? "") !== focusLock.unitId ||
    (focusLock.lessonId != null &&
      String(data?.session?.lessonId ?? "") !== focusLock.lessonId)
  );
  // "The turn, not the bell": the scholar is INSIDE the live class-focus
  // session itself — the exact inverse of the mismatch above. Gets the
  // winding-down cue (item 2) and the at-the-turn choice (item 3); like the
  // mismatch banner it never disables the composer or the session.
  const isFocusMatch = !isHomeworkSession && focusLock?.unitId != null && !isFocusMismatch;
  const roomPhase = useRoomTurnPhase(focusLock?.endsAt ?? null);
  const { showTurnBanner } = useRoomTurnAwareness(
    isFocusMatch,
    roomPhase,
    focusLock?.label ?? null,
    focusLock?.endsAt ?? null,
  );
  const focusTimeLabel =
    focusLock?.endsAt != null && focusLock.timeZone
      ? formatRoomTurnTime(focusLock.endsAt, focusLock.timeZone)
      : null;

  // Room cues are learner-only; a teacher-owned manual rehearsal routes through
  // this shell before VibecodeScreen takes over and must not subscribe as a
  // learner on the way there.
  const roomCues = useActiveRoomCues(loadLearnerContext && !!sessionId);

  const persisted: Bubble[] = (data?.messages ?? [])
    .filter(
      (m) =>
        (m.role === "user" && m.content !== OPENER_SENTINEL) ||
        m.role === "assistant" ||
        // Scholar-visible tool rows render as inline cards, or — when the tool
        // carries no rich payload — as a plain activity line naming what the
        // tutor just did ("Wrote down your words"), matching web.
        (m.role === "tool" &&
          ((m.toolAction === "physical_task" && !!m.content) ||
            !!m.flairAwards?.length ||
            !!m.resourceShare ||
            !!m.chatPractice ||
            !!m.instruction ||
            // A tool row's illustration and its receipt label are independent;
            // `generate_image` writes both onto one row. See toolRowDisplay.
            hasToolRowDisplay(m))),
    )
    .map((m) => {
      if (m.role === "tool") {
        if (m.flairAwards?.length) {
          return {
            key: m.id,
            role: "assistant" as const,
            content: "",
            createdAt: m.createdAt,
            flairAwards: m.flairAwards,
          };
        }
        if (m.resourceShare) {
          return {
            key: m.id,
            role: "assistant" as const,
            content: "",
            createdAt: m.createdAt,
            resourceShare: m.resourceShare,
          };
        }
        if (m.chatPractice) {
          return {
            key: m.id,
            role: "assistant" as const,
            content: "",
            createdAt: m.createdAt,
            chatPractice: m.chatPractice,
          };
        }
        if (m.instruction) {
          return {
            key: m.id,
            role: "assistant" as const,
            content: "",
            createdAt: m.createdAt,
            messageId: m.id as Id<"messages">,
            instruction: m.instruction,
          };
        }
        const display = toolRowDisplay<Id<"_storage">>(m);
        if (display.imageId || display.label) {
          return {
            key: m.id,
            role: "assistant" as const,
            content: "",
            createdAt: m.createdAt,
            toolActivity: display.label ?? undefined,
            // The tutor's illustration. `content` on an image tool row is its
            // alt text (see finalizeAndSplit), not scholar-facing prose.
            ...(display.imageId
              ? {
                  generatedImage: {
                    url: m.imageUrl,
                    altText: m.content || undefined,
                  },
                }
              : {}),
          };
        }
        return {
          key: m.id,
          role: "assistant" as const,
          content: "",
          createdAt: m.createdAt,
          physicalTaskId: m.content,
        };
      }
      return {
        key: m.id,
        role: m.role as "user" | "assistant",
        content: m.content,
        createdAt: m.createdAt,
        messageId: m.id as Id<"messages">,
        gotItWrong: m.gotItWrong,
        imageId: (m as { imageId?: Id<"_storage"> }).imageId,
        imageUrl: m.imageUrl,
        appSnapshotUrl: m.appSnapshotUrl,
        graphemeSpans: m.graphemeSpans,
        stopRequestedAt: (m as { stopRequestedAt?: number | null }).stopRequestedAt,
      };
    });
  const observerMessageCount = (data?.messages ?? []).filter(
    (message) =>
      message.role !== "system" &&
      (message.role !== "tool" || !!message.imageId) &&
      (message.content.trim() !== "" ||
        (!!message.imageId &&
          (message.role === "user" || message.role === "tool"))),
  ).length;

  // Seed from the whole message snapshot rather than what the inverted list has
  // mounted, so delayed subscription catch-up can animate but history and list
  // recycling cannot replay a notice. The screen remounts per route.
  const arrivingFlairRowIds = useFlairArrivals(
    data?.messages
      ? data.messages
          .filter((message) => message.flairAwards?.length)
          .map((message) => message.id)
      : undefined,
  );
  const claimedFlairRows = useMemo(
    () => ({ resetKey: sessionId, ids: new Set<string>() }),
    [sessionId],
  );

  // The live assistant reply stays ONE list item across its whole life: while its
  // real row is still propagating from Convex we render a placeholder under the
  // SAME key (its message id), so when the persisted row arrives React reconciles
  // it in place — no unmount/remount, no end-of-stream flash. renderItem paints it
  // from `streamingText` (the SSE text, ahead of the DB) while `streaming`.
  const liveInList = liveAssistantId
    ? persisted.some((b) => b.messageId === liveAssistantId)
    : false;
  const bubbles: Bubble[] =
    streaming && liveAssistantId && !liveInList
      ? [
          ...persisted,
          {
            key: liveAssistantId,
            role: "assistant",
            content: "",
            // Persisted rows carry their real creation time. A live placeholder
            // is always the newest row unless its message id is the explicit
            // completion anchor, so a stable sentinel preserves both cases.
            createdAt: Number.MAX_SAFE_INTEGER,
            messageId: liveAssistantId as Id<"messages">,
          },
        ]
      : persisted;

  // Inverted FlatList is natively bottom-anchored — the newest message stays
  // pinned to the bottom and content grows upward, with no scrollToEnd faking
  // (which desynced from the keyboard animation). Data is newest-first.
  const completionTimeline = [...bubbles];
  if (activityCompletedAt) {
    const anchoredMessageIndex = activityCompletionMessageId
      ? completionTimeline.findIndex(
          (bubble) =>
            bubble.messageId &&
            String(bubble.messageId) === String(activityCompletionMessageId),
        )
      : -1;
    const firstPostCompletionMessageIndex = completionTimeline.findIndex(
      (bubble) => bubble.createdAt >= activityCompletedAt,
    );
    const fallbackIndex =
      firstPostCompletionMessageIndex < 0
        ? completionTimeline.length
        : completionTimeline[firstPostCompletionMessageIndex].role === "assistant"
          ? firstPostCompletionMessageIndex + 1
          : firstPostCompletionMessageIndex;
    completionTimeline.splice(
      anchoredMessageIndex >= 0 ? anchoredMessageIndex + 1 : fallbackIndex,
      0,
      {
        key: "activity-completion",
        role: "assistant",
        content: "",
        createdAt: activityCompletedAt,
        completion: true,
      },
    );
  }
  // A failed turn gets a synthetic trailing row hosting the retry affordance,
  // whether or not its placeholder still exists (a hard error deletes it). One
  // canonical place, matching web's standalone TutorTurnFailedNotice.
  if (isDeadTurn) {
    completionTimeline.push({
      key: "turn-failed",
      role: "assistant",
      content: "",
      createdAt: Number.MAX_SAFE_INTEGER,
      failed: true,
    });
  }
  const invertedBubbles = completionTimeline.reverse();

  // Streams the tutor's reply for an already-created assistant placeholder.
  // Shared by onSend (normal message) and onRubricCheck (silent rubric check).
  // Does NOT own the `streaming` flag — callers guard + reset their own state.
  // A failure here is not message loss: the row is already persisted and the
  // reactive query still shows the finished reply.
  //
  // A busy backend (HTTP 429 + LLM_BUSY_MESSAGE) is WAITED OUT and RETRIED — the
  // same POST, same placeholder — up to a bounded budget (shared/streamRetry.ts),
  // never toasted or Alert-ed. During the wait the scholar keeps seeing the
  // pending "thinking" state; only if the budget is exhausted does the caller
  // surface the calm inline "didn't go through" affordance.
  const runTutorStream = useCallback(
    async (
      body: Record<string, unknown>,
      assistantMsgId: string,
    ): Promise<TutorStreamResult> => {
      setLiveAssistantId(assistantMsgId);

      // Fresh AbortController for this turn (aborted on unmount, see the ref's
      // cleanup effect). Any prior turn's controller is replaced.
      const controller = new AbortController();
      streamAbortRef.current = controller;

      type AttemptOutcome =
        | { kind: "completed" }
        | { kind: "busy"; retryAfterSec: number | null }
        | { kind: "error" }
        | { kind: "aborted" };

      const runAttempt = async (): Promise<AttemptOutcome> => {
        let full = "";
        try {
          const resp = await expoFetch(`${convexSiteUrl}/session-stream`, {
            method: "POST",
            signal: controller.signal,
            headers: {
              "Content-Type": "application/json",
              ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
            },
            body: JSON.stringify({ ...body, platform: "native" }),
          });

          // Busy refusal: 429 + a one-line SSE error body + Retry-After. Read it
          // whole rather than entering the token loop.
          if (resp.status === 429) {
            let errorMessage: unknown = "";
            try {
              const text = await resp.text();
              for (const ev of parseTutorSseText(text)) {
                if (ev.error) errorMessage = ev.error;
              }
            } catch {
              /* body consumed */
            }
            if (isTutorBusyError(errorMessage)) {
              const header =
                typeof resp.headers?.get === "function"
                  ? resp.headers.get("Retry-After")
                  : null;
              return { kind: "busy", retryAfterSec: parseRetryAfterSeconds(header) };
            }
            return { kind: "error" };
          }

          const reader = resp.body?.getReader();
          const handleEvent = (ev: TutorStreamEvent) => {
            // Tutor tool activity → the quiet inline status row. `generate_image`
            // is excluded here; it drives the dedicated "Making a picture…"
            // state via generatingImage instead (matching the web split).
            if (ev.thinking) {
              setActivity({ kind: "thinking" });
            }
            if (ev.toolStart?.name && ev.toolStart.name !== "generate_image") {
              setActivity({
                kind: "tool",
                label: friendlyToolName(ev.toolStart.name),
              });
            }
            if (ev.toolComplete?.name && ev.toolComplete.name !== "generate_image") {
              // The tool finished — drop its row (text or the next tool follows).
              // We intentionally IGNORE ev.toolComplete.result here: it can be a
              // raw developer failure string ("Failed: …") and a scholar must
              // never see one. The web chat redacts the same string behind a
              // quiet marker (ToolActivityIndicator scholarSafe); native simply
              // never surfaces it.
              setActivity((a) => (a && a.kind === "tool" ? null : a));
            }
            if (ev.generatingImage === "started") {
              setActivity({ kind: "image" });
            }
            if (ev.generatedImage) {
              setActivity((a) => (a && a.kind === "image" ? null : a));
            }
            if (ev.text) {
              voiceMark("firstText");
              full += ev.text;
              setStreamingText(full);
              setActivity((a) => (a ? null : a));
            }
            if (ev.newAssistantMsg) {
              setLiveAssistantId(ev.newAssistantMsg);
              full = "";
              setStreamingText("");
            }
            return ev.done === true;
          };
          // Only a `done` event completes the turn. A mid-stream error (the
          // lease was already granted, so not a busy refusal we can cleanly
          // re-POST) and a stream that closed without either (the server died
          // mid-turn) both surface as a failed turn, never a modal.
          if (reader && (await readTutorSse(reader, handleEvent))) {
            return { kind: "completed" };
          }
          return { kind: "error" };
        } catch (streamErr) {
          if ((streamErr as Error)?.name === "AbortError") {
            return { kind: "aborted" };
          }
          console.warn("[stream] failed", streamErr);
          return { kind: "error" };
        }
      };

      const startedAt = Date.now();
      try {
        for (;;) {
          if (controller.signal.aborted) return "aborted";
          // Reset the visible per-attempt state but keep liveAssistantId set so the
          // pending indicator stays up across a wait+retry.
          setStreamingText("");
          setActivity(null);
          const outcome = await runAttempt();
          if (outcome.kind === "completed") {
            // Let the wet-ink reveal finish AND the persisted row catch up before
            // the handoff to the settled Markdown render, so the swap is seamless.
            await sleepAbortable(320, controller.signal);
            return "completed";
          }
          if (outcome.kind === "aborted") {
            return "aborted";
          }
          if (outcome.kind === "busy") {
            const plan = planStreamRetry({
              busy: true,
              elapsedMs: Date.now() - startedAt,
              retryAfterSec: outcome.retryAfterSec,
            });
            if (plan.retry) {
              const waited = await sleepAbortable(plan.delayMs, controller.signal);
              if (!waited) return "aborted"; // unmounted / stopped mid-wait
              continue;
            }
            return "failed"; // budget exhausted → caller shows inline retry
          }
          return "failed"; // hard error → caller shows inline retry
        }
      } finally {
        if (streamAbortRef.current === controller) {
          streamAbortRef.current = null;
        }
      }
    },
    [authToken],
  );

  // Stop the in-flight reply: ask the server to finalize at the current partial,
  // then abort the local reader. We deliberately do NOT clear streamingText /
  // liveAssistantId here — the partial stays on screen until the server-finalized
  // row lands via the reactive query (≤1.5s). The turn's own cleanup keeps the
  // partial too (its result is "aborted"; see onSend's finally).
  const onStop = useCallback(() => {
    stopRequestedRef.current = true;
    // Bridge the partial: keep the current live text on screen for this row so
    // it doesn't blink empty while the server finalizes it (≤1.5 s).
    if (liveAssistantId) {
      setStoppedPartial({ id: liveAssistantId, text: streamingText });
    }
    void requestStopMut({ sessionId }).catch((e) =>
      console.warn("[stop] failed", e),
    );
    streamAbortRef.current?.abort();
  }, [requestStopMut, sessionId, liveAssistantId, streamingText]);

  const captureChangedAppSnapshot = useCallback(async () => {
    try {
      return await uploadChangedAppSnapshot({
        captureSnapshot: codeArtifactRef.current?.captureSnapshot ?? null,
        lastSentHash:
          lastSentSnapshotRef.current?.sessionId === sessionId
            ? lastSentSnapshotRef.current.hash
            : null,
        generateUploadUrl,
        uploadDataUrl: uploadImageDataUrl,
      });
    } catch (error) {
      console.warn("[session] app snapshot upload failed", error);
      return null;
    }
  }, [generateUploadUrl, sessionId]);

  const runInstructionHandback = useCallback(
    async (handback: InstructionHandbackStart) => {
      if (streaming) throw new Error("The tutor is already responding");
      setStreaming(true);
      setStreamingText("");
      setActivity(null);
      // Own start time, like every other turn path — otherwise pendingSince
      // falls back to an older transcript row and Stop arms immediately.
      setTurnStartedAt(Date.now());
      const result = await runTutorStream(
        {
          sessionId: handback.sessionId,
          streamId: handback.streamId,
          assistantMsgId: handback.assistantMsgId,
        },
        handback.assistantMsgId,
      );
      setStreaming(false);
      setStreamingText("");
      setLiveAssistantId(null);
      setActivity(null);
      setTurnStartedAt(null);
      if (result !== "completed") throw new Error("The tutor handback did not finish");
    },
    [runTutorStream, streaming],
  );

  // Any edit means the box is no longer the send we just persisted, so a
  // resubmit of it is a real turn again.
  const onChangeInput = useCallback((next: string) => {
    sentComposerRef.current = null;
    setInput(next);
  }, []);

  // `appUpdate` turns are opened by the app-update queue (useAppTutorUpdates),
  // which calls this only while no reply streams; it learns the mutation's
  // outcome through `onPrepared` and the stream continues on its own.
  const onSend = useCallback(async (
    overrideText?: string,
    inputModality: "typed" | "spoken" | "app" = "typed",
    options?: {
      appUpdate?: {
        batch: AppTutorUpdateBatch;
        onPrepared: (result: AppTutorSendResult) => void;
      };
    },
  ): Promise<boolean | void> => {
    // overrideText is the "send this exact text" path (voice dictation); the
    // typed path reads the composer input. We never stuff the transcript into
    // the input box — tapping ✓ on a recording sends it in one step.
    const appUpdate = options?.appUpdate;
    const isAppRequest = appUpdate !== undefined;
    const appContext = appUpdate
      ? newestAppTutorAskContext(appUpdate.batch)
      : undefined;
    const usingOverride = overrideText !== undefined;
    const text = isAppRequest ? "" : (overrideText ?? input).trim();
    const imageId = isAppRequest ? null : image.imageId;
    // Allow sending an image with no text (web allows image-only). NOTE:
    // `streaming` is deliberately NOT a blocker — a submit while the tutor is
    // replying STEERS (stop the in-flight reply, then send the new turn).
    if (
      (!text && !imageId && !isAppRequest) ||
      kickoffPendingRef.current ||
      activeKickoffPlaceholder ||
      (!isAppRequest && image.uploading)
    ) {
      return false;
    }
    // An untouched composer still holding the send we just persisted is a
    // stale-closure resubmit, not a new turn. Checked before the claim so it
    // costs nothing and never consumes one. Typed path only: a voice send
    // never reads the composer, and nothing would clear the ref for it.
    const composerSnapshot = composerPayloadKey(text, imageId);
    if (
      !isAppRequest &&
      !usingOverride &&
      sentComposerRef.current === composerSnapshot
    ) {
      return false;
    }
    // Claim the send SYNCHRONOUSLY, before the first await. The composer is
    // cleared only after sendMessage resolves (so a rejected send never loses
    // text) and stays editable while the tutor streams (so a submit can steer),
    // which leaves a window where a second submit would re-read the SAME text
    // and persist it twice. App asks enter through this same claim, so they
    // cannot interleave their persistence with a typed or spoken send. The
    // claim is released as soon as that text has been persisted and stamped
    // (or the mutation has rejected), so steering with new text and retrying a
    // failed send both still work; sentComposerRef above covers the frame after
    // the release, until the clear commits.
    if (!sendLockRef.current.acquire()) return;
    // Release exactly once per claim. `release()` frees whatever claim is
    // outstanding, so a second call after a LATER onSend has taken the lock
    // would hand that send's window away — hence the flag. The happy path
    // releases as soon as the composer is clear; the `finally` below is the
    // safety net for every early return or throw before that point, because a
    // leaked claim wedges the composer for the rest of the mount (strictly
    // worse than the duplicate this guards against).
    let claimHeld = true;
    const releaseSendClaim = () => {
      if (!claimHeld) return;
      claimHeld = false;
      sendLockRef.current.release();
    };
    // -1 until this send has claimed a turn, so a bail-out before that point
    // never matches turnSeqRef and never resets another turn's stream state.
    let myTurn = -1;
    try {
      voiceMark("sendMessage");
      try {
        await flushPendingArtifactSaves();
      } catch {
        // A background app update stays queued and retries; only the
        // scholar's own send needs telling.
        if (!isAppRequest) {
          Alert.alert(
            "Finish saving your document",
            "Choose a document version or retry its save before sending your message.",
          );
        }
        return false;
      }
      // An app update opens its turn BEFORE touching any streaming state: a
      // refusal (`held` / `busy`) must leave the screen — and the queue's idle
      // signal — exactly as they were, or the queue would re-drain on the flip.
      let appUpdateTurn: Extract<
        Awaited<ReturnType<typeof startAppUpdateTurn>>,
        { status: "started" }
      > | null = null;
      if (appUpdate) {
        try {
          const turn = await startAppUpdateTurn({
            sessionId,
            asks: appUpdate.batch.asks,
          });
          appUpdate.onPrepared(appTutorSendResultFromStatus(turn.status));
          if (turn.status !== "started") return false;
          appUpdateTurn = turn;
        } catch {
          appUpdate.onPrepared("failed");
          return false;
        }
      }
      // Steer + claim this turn. The abort → seq-bump runs with no `await` between
      // them, so the pre-empted turn's runTutorStream (which resolves on a later
      // microtask) sees the bumped seq and its finally skips the reset — it can't
      // clobber this new turn's streaming state. A steer discards the old partial
      // (no bridge); the server finalizes that row to its own "Stopped" bubble.
      if (!isAppRequest && streaming) {
        void requestStopMut({ sessionId }).catch((e) =>
          console.warn("[stop] failed", e),
        );
        streamAbortRef.current?.abort();
      }
      myTurn = ++turnSeqRef.current;
      stopRequestedRef.current = false;
      setStoppedPartial(null);
      setAppUpdateStreaming(isAppRequest);
      setStreaming(true);
      setStreamingText("");
      setActivity(null);
      if (!isAppRequest) setUserTurnFailed(false);
      setTurnStartedAt(Date.now());
      const res =
        appUpdateTurn ??
        (await sendMessage({
          sessionId,
          message: text,
          ...(imageId ? { imageId } : {}),
          ...(text !== OPENER_SENTINEL ? { inputModality } : {}),
        }));
      // A scholar's own turn carries the app's character/judge events to the
      // tutor, so a queued character-only update is now redundant.
      if (!isAppRequest && text !== OPENER_SENTINEL) {
        appTutorUpdatesRef.current?.clearAppAi();
      }
      // The message is now persisted — only NOW is it safe to clear the
      // composer. Clearing optimistically (before the await) would silently
      // discard the scholar's text + image if the mutation rejected. Only the
      // typed path clears the input box; the voice path never wrote to it, so
      // clearing there could wipe text the scholar had already typed.
      if (!usingOverride && !isAppRequest) {
        setInput("");
        // Synchronous, unlike setInput — this is what closes the frame-wide
        // window between the clear and its commit.
        sentComposerRef.current = composerSnapshot;
      }
      if (!isAppRequest) image.clear();
      // This text is now spoken for — stamped above and on its way out of the
      // composer — so free the claim before the (long) stream, leaving it
      // available for a genuine steer. Releasing any earlier, while the text
      // was still the composer's, would reopen the duplicate window.
      releaseSendClaim();

      // A Stop tapped during the pre-mutation window (before sendMessage
      // resolved): the assistant row now exists, so finalize it server-side and
      // skip the fetch. Firing it with the already-aborted controller would
      // abort instantly and orphan the placeholder row. The finally resets this
      // turn as an aborted one.
      if (stopRequestedRef.current) {
        void requestStopMut({ sessionId }).catch((e) =>
          console.warn("[stop] failed", e),
        );
        return true;
      }

      // A character-only update adds no user row, so a snapshot would land on
      // the scholar's last typed message instead: send none.
      const appSnapshot =
        !appUpdate || appUpdate.batch.asks.length > 0
          ? await captureChangedAppSnapshot()
          : null;
      if (stopRequestedRef.current) {
        void requestStopMut({ sessionId }).catch((e) =>
          console.warn("[stop] failed", e),
        );
        return true;
      }
      if (appSnapshot) {
        lastSentSnapshotRef.current = {
          sessionId,
          hash: appSnapshot.hash,
        };
      }

      // Tutor runs + streams via the HTTP action (shared SSE reader). A failure
      // in the stream is NOT message loss — the message is already saved and the
      // reactive query still shows the tutor's reply once the server finishes.
      // A busy backend is waited-out inside runTutorStream; only a real failure
      // (not a user stop / steer / unmount) surfaces the calm inline retry.
      const result = await runTutorStream(
        {
          sessionId: res.sessionId,
          streamId: res.streamId,
          assistantMsgId: res.assistantMsgId,
          ...(appSnapshot
            ? { appSnapshotStorageId: appSnapshot.storageId }
            : {}),
          ...(appUpdate && appUpdate.batch.asks.length > 0
            ? {
                appRequest: {
                  ...(appContext ? { context: appContext } : {}),
                },
              }
            : {}),
        },
        res.assistantMsgId,
      );
      // An app update is not the scholar's turn: it never shows the "didn't
      // go through" retry (the next update or typed turn covers it).
      if (
        turnSeqRef.current === myTurn &&
        result === "failed" &&
        !isAppRequest
      ) {
        setUserTurnFailed(true);
      }
      return true;
    } catch (e) {
      // The mutation itself failed → the message was NOT saved. The composer
      // still holds the scholar's text + image (we never cleared), so nothing is
      // lost; tell them so they can retry.
      console.warn("[send] failed", e);
      if (!isAppRequest) {
        Alert.alert(
          "Couldn't send",
          "Your message wasn't sent. Check your connection and try again.",
        );
      }
      return false;
    } finally {
      // A claim still held here means we bailed out (or threw) before the
      // composer was cleared — never leave it locked.
      releaseSendClaim();
      // Only the turn that still owns the stream resets shared state — a
      // pre-empted (steered-away) turn must not clobber the turn that replaced
      // it. A user Stop keeps its partial on screen via `stoppedPartial`, so
      // clearing streamingText here is safe.
      if (turnSeqRef.current === myTurn) {
        setAppUpdateStreaming(false);
        setStreaming(false);
        setStreamingText("");
        setLiveAssistantId(null);
        setActivity(null);
        setTurnStartedAt(null);
        // Keep the composer focused so the scholar can keep typing (HW keyboard).
        if (!isAppRequest) {
          requestAnimationFrame(() => inputRef.current?.focus());
        }
      }
    }
  }, [
    input,
    streaming,
    activeKickoffPlaceholder,
    image,
    sendMessage,
    startAppUpdateTurn,
    sessionId,
    runTutorStream,
    requestStopMut,
    captureChangedAppSnapshot,
  ]);

  // App → tutor updates (askTutor taps, character/judge events) wait in one
  // queue and go out between replies as one app-update turn. Only the owner
  // drains: anyone else opening this session hosts the same app but must not
  // start the scholar's turns.
  const isSessionOwner =
    !!me && !!data?.session && String(me._id) === String(data.session.userId);
  const appTutorUpdates = useAppTutorUpdates({
    sessionId,
    enabled: isSessionOwner,
    busy: tutorBusy,
    send: (batch) =>
      settleAppTutorSend((onPrepared) =>
        onSend(undefined, "app", { appUpdate: { batch, onPrepared } }),
      ),
  });
  useEffect(() => {
    appTutorUpdatesRef.current = appTutorUpdates;
  }, [appTutorUpdates]);

  // Re-run a FAILED SCHOLAR (user) turn without persisting a second scholar
  // message. retryAssistantTurn refuses unless the trailing turn is a
  // genuinely-dead scholar user turn, so a silent turn (kickoff / rubric check)
  // can never be retried here — and the affordance is never shown for one.
  const onRetryTurn = useCallback(async () => {
    if (streaming) return;
    stopRequestedRef.current = false;
    setStreaming(true);
    setStreamingText("");
    setActivity(null);
    setUserTurnFailed(false);
    setTurnStartedAt(Date.now());
    try {
      const res = await retryAssistantTurn({ sessionId });
      if (!res) return; // nothing to retry (already replied / still live)
      const appSnapshot = await captureChangedAppSnapshot();
      if (stopRequestedRef.current) {
        void requestStopMut({ sessionId }).catch((e) =>
          console.warn("[stop] failed", e),
        );
        return;
      }
      if (appSnapshot) {
        lastSentSnapshotRef.current = {
          sessionId,
          hash: appSnapshot.hash,
        };
      }
      const result = await runTutorStream(
        {
          sessionId: res.sessionId,
          streamId: res.streamId,
          assistantMsgId: res.assistantMsgId,
          ...(appSnapshot
            ? { appSnapshotStorageId: appSnapshot.storageId }
            : {}),
        },
        res.assistantMsgId,
      );
      if (result === "failed") setUserTurnFailed(true);
    } catch (e) {
      console.warn("[retry] failed", e);
      setUserTurnFailed(true);
    } finally {
      setStreaming(false);
      setStreamingText("");
      setLiveAssistantId(null);
      setActivity(null);
      setTurnStartedAt(null);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [
    streaming,
    retryAssistantTurn,
    sessionId,
    runTutorStream,
    captureChangedAppSnapshot,
    requestStopMut,
  ]);

  const onVoiceTranscript = useCallback(
    (text: string) => {
      void onSend(text, "spoken");
    },
    [onSend],
  );
  const voice = useStreamingDictation(onVoiceTranscript, sessionId);

  // "Check my work" — re-score the deliverable against its
  // rubric WITHOUT faking a user turn. startRubricCheck persists only the
  // assistant placeholder; the stream injects an ephemeral instruction so the
  // transcript never shows a message the scholar didn't type. The tutor streams
  // its reply + calls update_rubric_score, so the stars update as before.
  const onRubricCheck = useCallback(
    async (
      artifactId: Id<"artifacts">,
      artifactTitle: string,
      shouldCheck: boolean,
    ) => {
      if (
        streaming ||
        kickoffPendingRef.current ||
        activeKickoffPlaceholder
      ) {
        return;
      }
      try {
        await flushPendingArtifactSaves();
      } catch {
        Alert.alert(
          "Finish saving your work",
          "Choose a saved version or retry the save before checking it.",
        );
        return;
      }
      try {
        await submitDeliverable({
          sessionId,
          activityId: sessionActivityId!,
          artifactId,
          intent: shouldCheck ? "check" : "send",
        });
        if (!shouldCheck) return;
        setStreaming(true);
        setStreamingText("");
        setActivity(null);
        setUserTurnFailed(false);
        setTurnStartedAt(Date.now());
        const res = await startRubricCheck({ sessionId });
        // A rubric check is a SILENT turn — it sets no failed state (the "Check
        // my work" button is its own retry). Match pre-PR behavior on failure.
        await runTutorStream(
          {
            sessionId: res.sessionId,
            streamId: res.streamId,
            assistantMsgId: res.assistantMsgId,
            rubricCheck: { artifactTitle },
          },
          res.assistantMsgId,
        );
      } catch (e) {
        console.warn("[rubric-check] failed", e);
        Alert.alert(
          shouldCheck ? "Couldn't check your work" : "Couldn't send your work",
          "Your work is still saved. Check your connection and try again.",
        );
      } finally {
        setStreaming(false);
        setStreamingText("");
        setLiveAssistantId(null);
        setActivity(null);
        setTurnStartedAt(null);
      }
    },
    [
      streaming,
      activeKickoffPlaceholder,
      submitDeliverable,
      startRubricCheck,
      sessionId,
      sessionActivityId,
      runTutorStream,
    ],
  );

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
    if (data === undefined) return;
    // Vibecode sessions own their teacher-build kickoff inside VibecodeScreen
    // (TRA-319): running it here would stream through this shell (no
    // supportsRenderCheck, events VibecodeScreen never sees) and strand the
    // preview on its empty state. VibecodeScreen kicks off instead.
    if (data.session?.sessionMode === "vibecode") return;
    const hasNoMessages = (data.messages ?? []).length === 0;
    if (!hasNoMessages && !activeKickoffPlaceholder) {
      if (kickoffRetryTimerRef.current) {
        clearTimeout(kickoffRetryTimerRef.current);
        kickoffRetryTimerRef.current = null;
      }
      return;
    }
    if (streaming || kickoffPendingRef.current) return;
    if (welcomeSentRef.current === sessionId) return;

    const session = data.session;
    if (session.activityId) {
      if (
        session.isArchived ||
        session.isOffline ||
        !me ||
        String(me._id) !== String(session.userId)
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
        setStreamingText("");
        setActivity(null);
        try {
          const res = await startActivityKickoff({ sessionId });
          if (!res) return;
          if (res.status === "pending") {
            kickoffRetryTimerRef.current = setTimeout(() => {
              kickoffRetryTimerRef.current = null;
              welcomeSentRef.current = null;
              bumpKickoffRetry((n) => n + 1);
            }, res.retryAfterMs + 50);
            return;
          }
          setStreaming(true);
          setUserTurnFailed(false);
          setTurnStartedAt(Date.now());
          // A kickoff is a SILENT turn — it sets no failed state (it
          // self-recovers through startActivityKickoff's recoverable branch on
          // the next effect run). Match pre-PR behavior on failure.
          const completed = await runTutorStream(
            {
              sessionId: res.sessionId,
              streamId: res.streamId,
              assistantMsgId: res.assistantMsgId,
              kickoff: true,
            },
            res.assistantMsgId,
          );
          if (completed !== "completed") {
            welcomeSentRef.current = null;
          }
        } catch (e) {
          console.warn("[activity-kickoff] failed", e);
          kickoffRetryTimerRef.current = setTimeout(() => {
            kickoffRetryTimerRef.current = null;
            welcomeSentRef.current = null;
            bumpKickoffRetry((n) => n + 1);
          }, 1_000);
        } finally {
          kickoffPendingRef.current = false;
          setKickoffPending(false);
          setStreaming(false);
          setStreamingText("");
          setLiveAssistantId(null);
          setActivity(null);
          setTurnStartedAt(null);
        }
      })();
      return;
    }

    // No activity yet, but one is being designed right now: hold the opener
    // rather than ad-libbing the topic and abandoning it when the real task
    // lands mid-conversation. The effect re-runs on both exits — the activity
    // arriving (data) and the wait capping out (questBakeHolding) — so one of
    // the two branches above always ends up opening the session.
    if (questBakeHolding) return;

    // Fire synchronously (matching web): a cancellable setTimeout + cleanup
    // could be cleared by a re-render in the same tick, and the ref guard
    // would then block the re-run from ever rescheduling the opener.
    welcomeSentRef.current = sessionId;
    queueMicrotask(() => void onSend(OPENER_SENTINEL));
  }, [
    data,
    streaming,
    activeKickoffPlaceholder,
    sessionId,
    onSend,
    me,
    startActivityKickoff,
    runTutorStream,
    questBakeHolding,
  ]);

  // Voice dictation. The mic button starts recording; the RecordingBar's ✓
  // button finishes → transcribe → send in one step (the kid decides when
  // they're done, then it goes). No text is dropped into the input box to
  // review, and there's no silence auto-stop — nothing fires until they tap ✓.
  const onMicStart = useCallback(async () => {
    if (appStatusBus.isMicOwned()) return; // the writing box is dictating — one recorder at a time
    getNativeTTS().stop(); // don't record over the tutor's voice (web parity)
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await voice.start();
  }, [voice]);

  const onMicStop = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    voice.stop();
  }, [voice]);

  const onMicCancel = useCallback(() => {
    Haptics.selectionAsync();
    voice.cancel();
  }, [voice]);

  // Attach: iOS action sheet → camera or photo library.
  const onAttach = useCallback(() => {
    Haptics.selectionAsync();
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ["Cancel", "Take Photo", "Choose Photo"],
        cancelButtonIndex: 0,
      },
      (i) => {
        if (i === 1) image.attach("camera");
        else if (i === 2) image.attach("library");
      },
    );
  }, [image]);

  if (data === undefined) {
    return (
      <>
        <Stack.Screen options={{ title: headerTitle }} />
        <ChatSkeleton />
      </>
    );
  }

  // ── Offline / scanned-work sessions: no tutor chat, just the scans ──
  if (data.session?.isOffline) {
    return (
      <>
        <Stack.Screen options={{ title: headerTitle }} />
        <OfflineSessionView sessionId={sessionId} />
      </>
    );
  }

  // ── World Workbench sessions: the tactile bench renderer, not the chat
  // scaffold (plan §12; same early-return shape as offline above). Branched on
  // the session's own `sessionMode` — already on the loaded doc, so no extra
  // query for the 99% chat case. The bench IS this session; the deep link
  // /session/[id] stays stable (WorkbenchScreen lives in components/, not a new
  // app/ route).
  if (data.session?.sessionMode === "workbench") {
    return (
      <>
        <Stack.Screen options={{ title: headerTitle }} />
        <WorkbenchScreen sessionId={sessionId} />
      </>
    );
  }

  // ── Vibecode sessions: the Lovable-style live-preview builder (vibecode-spec.md).
  // Same early-return shape as workbench above; VibecodeScreen owns its own
  // Stack.Screen (title + chat toggle).
  if (data.session?.sessionMode === "vibecode") {
    return <VibecodeScreen sessionId={sessionId} />;
  }

  const activityId = sessionActivityId;
  const unitId = sessionUnitId;
  const completed = !!activityCompletedAt;
  // S3: homework gets a visible way to say "I'm done" — the same
  // `activityCompletions` toggle the Big picture drawer (WhereAmIPanel) has
  // always offered, on online activities only, where mark-complete applies.
  const canShowHomeworkDone =
    isHomeworkSession &&
    !!activityId &&
    progress.currentActivity?.activity.kind === "online";
  // Same truth the Big picture drawer reads (WhereAmIPanel): the completions
  // ledger OR the session's own stamp. `activityCompletedAt` alone lags the
  // ledger, which would leave the button saying "I'm done with this" straight
  // after a tap.
  const homeworkDone = progress.currentActivityCompleted || completed;
  const toggleHomeworkDone = async () => {
    if (!activityId || homeworkDoneSaving) return;
    setHomeworkDoneSaving(true);
    try {
      if (homeworkDone) {
        await unmarkActivityComplete({ activityId, sessionId });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      } else {
        await markActivityComplete({ activityId, sessionId });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch (error) {
      console.warn("[session] homework completion change failed", error);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } finally {
      setHomeworkDoneSaving(false);
    }
  };
  const nextIncomplete = completed ? progress.nextIncompleteOnlineActivity : null;
  // Current activity done with NO forward next: this session is over, so the
  // card hands off to Home. It deliberately does NOT claim the UNIT is
  // finished — `useUnitProgress` counts what THIS assignment made live
  // (`activities.listByUnitPublic`), so "nothing in front of me" is not "I
  // finished the unit". A homework session carrying one activity out of a
  // multi-lesson unit used to satisfy `completedCount >= activityTotal` and
  // announce "Unit complete!". Home owns the real unit picture.
  const handsOffToHome =
    completed && !!unitId && progress.activityTotal > 0 && !nextIncomplete;
  // The one thing this list CAN prove: activities visible in this session are
  // still incomplete, and they are all behind us (the in-session Continue CTA
  // is forward-only — see ../../vendor/shared/nextIncompleteActivity.ts), so
  // Home owns routing back to them.
  const earlierHole =
    handsOffToHome && progress.completedCount < progress.activityTotal;

  const openNextIncomplete = async () => {
    const target = nextIncomplete?.activity;
    if (!target || navigatingNext) return;
    Haptics.selectionAsync();
    setNavigatingNext(true);
    try {
      const existing = (activeSessions ?? []).find(
        (s) =>
          !s.freePlay &&
          s.activityId &&
          String(s.activityId) === String(target._id) &&
          (data.session?.assignmentId
            ? String(s.assignmentId ?? "") === String(data.session.assignmentId)
            : s.assignmentId === undefined),
      );
      if (existing?.id) {
        // Replace, don't push: advancing between activities swaps the current
        // activity on the stack rather than nesting home > act1 > act2 > act3,
        // so a back-swipe from any activity lands on home.
        router.replace({
          pathname: "/session/[id]",
          params: { id: existing.id as Id<"sessions">, title: target.title },
        });
        return;
      }
      const result = await createSession({
        activityId: target._id,
        ...(data.session?.assignmentId ? { assignmentId: data.session.assignmentId } : {}),
      });
      if (result?.id) {
        router.replace({
          pathname: "/session/[id]",
          params: { id: result.id, title: target.title },
        });
      }
    } catch (e) {
      console.warn("[up-next] navigation failed", e);
      Alert.alert(
        "Couldn't start that activity",
        "Please try again.",
      );
    } finally {
      setNavigatingNext(false);
    }
  };

  // Landscape layout: chat left + DeliverablePanel right (iPad in landscape).
  // Portrait: stacked layout with DeliverableCard inline in the chat header.
  // Mounted for any activity (the panel/card render nothing when it has no
  // deliverable and no documents) and for any session holding a document.
  const isLandscape = width > height;
  const mountsWorkSurface = !!activityId || hasTextArtifacts;
  // A map the tutor opened also earns the panel in landscape: inline in the
  // inverted chat list it rendered as the list header, i.e. pinned directly
  // above the composer at full height, squeezing the tutor's latest text.
  const showPanelLayout = isLandscape && (mountsWorkSurface || hasMapArtifact);

  const mapCard = (fill: boolean) => (
    <GeoMapCard
      fill={fill}
      sessionId={sessionId}
      activityId={activityId ?? undefined}
      commitBusy={tutorBusy}
      onCommit={(text) => {
        void onSend(text, "typed");
      }}
      onAskCheck={(artifact, shouldCheck) =>
        onRubricCheck(artifact._id, artifact.title, shouldCheck)
      }
    />
  );

  const canSend =
    (input.trim().length > 0 || !!image.imageId) &&
    !composerBusy &&
    !image.uploading;
  const focusName = focusLock?.label ?? null;

  // The chat pane — used in both portrait and landscape. In landscape the
  // DeliverableCard is hidden (it moves into the panel).
  const chatPane = (
    <Animated.View style={[styles.flex, keyboardInsetStyle]}>
      <ManipulativeScrollContext.Provider value={chatScrollRef}>
        <FlatList
          ref={chatScrollRef}
          inverted
          data={invertedBubbles}
          keyExtractor={(b) => b.key}
          contentContainerStyle={styles.list}
          keyboardDismissMode="interactive"
          ListEmptyComponent={
            /* The bake runs into the minutes. A silent empty chat for that long
               reads as broken, and the scholar has no way to know anything is
               being made for them — say what is happening. Web parity:
               components/SessionInterface.tsx. */
            questBakeHolding ? (
              <View style={styles.bakeWait}>
                <ActivityIndicator color={colors.violet} />
                <Text style={styles.bakeWaitTitle}>Building your quest…</Text>
                <Text style={styles.bakeWaitBody}>
                  This takes a minute. Your first task will be here when it’s
                  ready.
                </Text>
              </View>
            ) : null
          }
          ListHeaderComponent={
            <View>
              {showPanelLayout ? null : mapCard(false)}
              <ManipulativeCard sessionId={sessionId} />
              {!showPanelLayout && mountsWorkSurface ? (
                <DeliverableCard
                  sessionId={sessionId}
                  activityId={activityId}
                  codeArtifactRef={codeArtifactRef}
                  onAskTutor={appTutorUpdates.onAskTutor}
                  onAppAiTurn={appTutorUpdates.onAppAiTurn}
                  appAiEnabled={isSessionOwner}
                  checkDisabled={tutorBusy}
                  onAskCheck={(a, shouldCheck) =>
                    onRubricCheck(a._id, a.title, shouldCheck)
                  }
                />
              ) : null}
              {!activityId && !completed ? (
                <SessionRecapCard
                  key={`wrap-${sessionId}`}
                  sessionId={sessionId}
                  isComplete={false}
                  canRequest={
                    hasLearnerContext &&
                    !data.session?.isTestDrive &&
                    !tutorBusy &&
                    observerMessageCount >= 2
                  }
                />
              ) : null}
            </View>
          }
          renderItem={({ item }) => {
            if (item.failed) {
              // A failed turn's standalone retry affordance (its placeholder may
              // be gone). Left-aligned like a tutor row.
              return (
                <View style={[styles.row, styles.rowTutor]}>
                  <View style={styles.colTutor}>
                    <View style={styles.tutorBare}>
                      <TutorTurnFailedRow onRetry={onRetryTurn} />
                    </View>
                  </View>
                </View>
              );
            }
            if (item.completion) {
              return (
                <View>
                  <SessionRecapCard sessionId={sessionId} isComplete />
                  <CompletionHandoffCard
                    visible={
                      !!nextIncomplete ||
                      handsOffToHome ||
                      (data.dispatchCompleted?.length ?? 0) > 0
                    }
                    nextTitle={nextIncomplete?.activity.title ?? null}
                    handsOffToHome={handsOffToHome}
                    earlierHole={earlierHole}
                    dispatchCompleted={data.dispatchCompleted ?? []}
                    loading={navigatingNext}
                    onUpNext={nextIncomplete ? openNextIncomplete : undefined}
                    onBackToHome={() =>
                      router.canDismiss() ? router.dismissAll() : router.replace("/")
                    }
                  />
                </View>
              );
            }
            if (item.chatPractice) {
              return (
                <ChatPracticeItem
                  scholarId={data.session!.userId}
                  sessionId={sessionId}
                  item={item.chatPractice}
                />
              );
            }
            if (item.instruction && item.messageId) {
              return (
                <InstructionChatCard
                  messageId={item.messageId}
                  sessionId={sessionId}
                  scholarId={data.session!.userId}
                  instruction={item.instruction}
                  onHandback={runInstructionHandback}
                />
              );
            }
            if (item.resourceShare) {
              return <ResourceShareCard resource={item.resourceShare} />;
            }
            if (item.flairAwards?.length) {
              const animateFlairNotice =
                arrivingFlairRowIds.includes(item.key) &&
                !claimedFlairRows.ids.has(item.key);
              return (
                <FlairAwardNotice
                  awards={item.flairAwards}
                  sessionId={sessionId}
                  // The arrival baseline suppresses history and remounts.
                  animate={animateFlairNotice}
                  onAnimationClaim={
                    animateFlairNotice
                      ? () => claimedFlairRows.ids.add(item.key)
                      : undefined
                  }
                />
              );
            }
          // Tutor-suggested hands-on task → the inline "Go try this" card.
          if (item.physicalTaskId) {
            return <PhysicalTaskCard physicalTaskId={item.physicalTaskId} />;
          }
          // A plain receipt naming what the tutor just did, and/or the
          // illustration the tutor generated. Web renders the image above its
          // receipt line; native has to match (scholar-facing parity).
          if (item.toolActivity || item.generatedImage) {
            return (
              <View style={styles.toolActivityRow}>
                {item.generatedImage && (
                  <GeneratedImageCard
                    url={item.generatedImage.url}
                    altText={item.generatedImage.altText}
                  />
                )}
                {!!item.toolActivity && (
                  <Text style={styles.toolActivityText}>{item.toolActivity}</Text>
                )}
              </View>
            );
          }
          const mine = item.role === "user";
          // The live streaming reply is the assistant row whose id matches
          // liveAssistantId; paint it from `streamingText` (ahead of the DB row).
          // A quiet app-update turn is not painted at all until it speaks.
          const isStreaming =
            visiblyStreaming &&
            !!item.messageId &&
            item.messageId === liveAssistantId;
          // On a user Stop, keep the held partial visible for this row until its
          // server-finalized content lands (the row's own content wins the
          // moment it's non-empty), so the reply never blinks empty.
          const bridgedStop =
            !isStreaming &&
            stoppedPartial &&
            item.messageId === stoppedPartial.id &&
            !item.content
              ? stoppedPartial.text
              : "";
          const displayContent = isStreaming
            ? streamingText
            : item.content || bridgedStop;
          const empty = displayContent.length === 0;
          // Server-truth pending for the trailing placeholder, so a remount (or
          // a busy wait-and-retry) still shows the thinking state. A DEAD turn's
          // retry affordance is rendered as a standalone synthetic row (see the
          // `item.failed` branch) — not inside this bubble — so it shows even
          // when a hard error deleted the placeholder.
          const isLastPlaceholder =
            !!item.messageId && lastMessage?.id === item.messageId;
          const isServerPendingBubble =
            !streaming && isServerPending && isLastPlaceholder;
          // The "…" is the WAITING signal — the tutor has been asked and nothing
          // has come back yet. It belongs to the live turn (or the not-yet-
          // streaming activity-kickoff placeholder) and nothing else: an empty
          // bubble that isn't pending is a finished or abandoned turn, and
          // leaving an ellipsis on it made the transcript reflow the moment the
          // stream ended.
          const isPendingTurn =
            !isDeadTurn &&
            (isStreaming ||
              (!!item.messageId &&
                item.messageId === activeKickoffPlaceholder?.id) ||
              isServerPendingBubble);
          const hasImage = !!item.imageId;
          const hasAppSnapshot = mine && !!item.appSnapshotUrl;
          const isTutor = item.role === "assistant" && !!item.messageId;
          // Reading ramp (§10): a SETTLED tutor bubble whose message carries
          // annotator spans renders through GraphemeText (color-coded grapheme
          // teams) instead of Markdown. Spans exist ONLY for pre-reader scholars
          // with an active inventory (the annotator's gating) and ONLY post-
          // stream, so this needs no client reading-level check and never fires
          // on the in-flight streaming bubble. An empty stage map (every other
          // scholar) short-circuits to the plain Markdown path.
          const useGrapheme =
            isTutor &&
            !isStreaming &&
            hasGraphemeStages &&
            !!item.graphemeSpans &&
            item.graphemeSpans.length > 0;
          // A photo-only user message shouldn't render an empty text bubble —
          // and neither should a settled turn that never produced any text.
          const showText =
            !(mine && hasImage && empty) &&
            !(empty && !isPendingTurn);
          const showBubble = showText || hasAppSnapshot;
          return (
            <View style={[styles.row, mine ? styles.rowMine : styles.rowTutor]}>
              <View style={mine ? styles.colMine : styles.colTutor}>
                {hasImage && <ImageBubble url={item.imageUrl ?? null} />}
                {showBubble && (
                  <SpeakableBubble
                    content={displayContent}
                    speakable={isTutor && !isStreaming && !empty}
                    ttsEnabled={ttsEnabled}
                    onCopy={() => {
                      Clipboard.setStringAsync(displayContent);
                    }}
                    onFlag={
                      isTutor
                        ? () => {
                            toggleWrong({ messageId: item.messageId! });
                          }
                        : undefined
                    }
                    flagged={!!item.gotItWrong}
                    disabled={!displayContent}
                    align={mine ? "right" : "left"}
                  >
                    <View
                      style={[
                        mine ? [styles.bubble, styles.mine] : styles.tutorBare,
                        hasImage && { marginTop: 6 },
                      ]}
                    >
                      {hasAppSnapshot ? (
                        <AppSnapshotBubble url={item.appSnapshotUrl ?? null} />
                      ) : null}
                      {showText ? (
                        empty ? (
                        // Waiting on the first token: the live tool/thinking/
                        // image status, else the escalating "thinking" copy
                        // (which reads as patience across a busy wait-and-retry),
                        // else a plain "…". (A dead turn's retry is a standalone
                        // row, not shown here.)
                        activity ? (
                          <ChatActivityRow activity={activity} />
                        ) : pendingLabel ? (
                          // Words, not the "…" glyph: `styles.thinking` is
                          // sized (22pt, wide tracking) for the bare ellipsis,
                          // so the escalation copy rendered huge. It is status
                          // text, so it gets the status row's treatment.
                          <ChatActivityRow
                            activity={{ kind: "waiting", label: pendingLabel }}
                          />
                        ) : (
                          <Text style={[styles.bubbleText, styles.thinking]}>…</Text>
                        )
                      ) : mine ? (
                        <Text style={[styles.bubbleText, styles.textMine]}>
                          {item.content}
                        </Text>
                      ) : isStreaming ? (
                        // Live tutor tokens get the wet-ink trailing edge (buffered
                        // + released char-by-char, each drying to solid). Plain text,
                        // not markdown: re-parsing markdown every token janks; the
                        // settled bubble renders rich (same list item, in place). A
                        // tool fired mid-reply (or an image being generated) shows a
                        // quiet status row below the text, matching the web.
                        <>
                          <StreamingText
                            content={streamingText}
                            done={false}
                            color={colors.charcoal}
                            fadeMs={420}
                            style={styles.bubbleText}
                          />
                          {activity ? (
                            <View style={{ marginTop: 6 }}>
                              <ChatActivityRow activity={activity} />
                            </View>
                          ) : null}
                        </>
                      ) : useGrapheme ? (
                        // Reading ramp: the same styles.bubbleText metrics (18/26,
                        // fonts.regular, charcoal) as the Markdown branch, so the
                        // reactive swap when spans land post-stream doesn't shift
                        // layout. GraphemeText inherits this style and overrides
                        // only per-team color/weight on active grapheme runs.
                        <GraphemeText
                          text={item.content}
                          spans={item.graphemeSpans!}
                          stages={graphemeStages}
                          style={styles.bubbleText}
                        />
                      ) : (
                        <Markdown content={displayContent} color={colors.charcoal} />
                      )
                      ) : null}
                    </View>
                  </SpeakableBubble>
                )}
                {/* The user cut this reply short — a quiet, iconless caption
                    under the finalized (non-streaming) tutor bubble. */}
                {isTutor && !isStreaming && item.stopRequestedAt != null && (
                  <Text style={styles.stopped}>Stopped</Text>
                )}
                {item.gotItWrong && (
                  <View style={styles.flagRow}>
                    <SymbolView
                      name="flag.fill"
                      size={12}
                      tintColor={colors.orange}
                    />
                    <Text style={styles.flagText}>You flagged this</Text>
                  </View>
                )}
              </View>
            </View>
          );
          }}
        />
      </ManipulativeScrollContext.Provider>

      {/* Chat input bar — Liquid Glass (iOS 26) over the scrolling chat. The
          bar keeps symmetric top/bottom padding around the input; the
          home-indicator clearance is the collapsing spacer at the bottom. */}
      <GlassBar edge="top" style={styles.composer}>
        {/* S3 — "I'm done with this". The same `activityCompletions` toggle
            the Big picture drawer offers, given a place a child can see, so
            they can close the loop instead of leaving homework open (reads as
            delinquent) or chatting on to make something happen. */}
        {canShowHomeworkDone && (
          <View style={styles.homeworkDoneRow}>
            {homeworkDone ? (
              <>
                <Text style={styles.homeworkDoneConfirmedText}>
                  {HOMEWORK_DONE_CONFIRMED}
                </Text>
                <Pressable
                  onPress={toggleHomeworkDone}
                  disabled={homeworkDoneSaving}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={HOMEWORK_DONE_UNDO}
                >
                  <Text style={styles.homeworkDoneUndoText}>
                    {HOMEWORK_DONE_UNDO}
                  </Text>
                </Pressable>
              </>
            ) : (
              <Pressable
                onPress={toggleHomeworkDone}
                disabled={homeworkDoneSaving}
                style={styles.homeworkDoneBtn}
                accessibilityRole="button"
                accessibilityLabel={HOMEWORK_DONE_LABEL}
              >
                <SymbolView
                  name="checkmark.circle"
                  size={16}
                  tintColor={colors.navy}
                />
                <Text style={styles.homeworkDoneBtnText}>
                  {HOMEWORK_DONE_LABEL}
                </Text>
              </Pressable>
            )}
          </View>
        )}
        {image.previewUri && (
          <View style={styles.previewRow}>
            <View style={styles.previewChip}>
              <Image source={{ uri: image.previewUri }} style={styles.previewImg} alt="Attached photo" />
              {image.uploading && (
                <View style={styles.previewOverlay}>
                  <ActivityIndicator color={colors.white} />
                </View>
              )}
              <Pressable
                onPress={image.clear}
                hitSlop={8}
                style={styles.previewRemove}
                accessibilityRole="button"
                accessibilityLabel="Remove photo"
              >
                <SymbolView name="xmark.circle.fill" size={22} tintColor={colors.charcoal} />
              </Pressable>
            </View>
          </View>
        )}

        {voice.isRecording || voice.isTranscribing ? (
          <View style={styles.composerRow}>
            <RecordingBar
              level={voice.level}
              durationMs={voice.durationMs}
              isTranscribing={voice.isTranscribing}
              onCancel={onMicCancel}
              onStop={onMicStop}
            />
          </View>
        ) : (
          <View style={styles.composerRow}>
            {/* Attach (camera / photo library) */}
            <Pressable
              onPress={onAttach}
              hitSlop={8}
              style={styles.attachBtn}
              disabled={composerBusy}
              accessibilityRole="button"
              accessibilityLabel="Add a photo"
            >
              <SymbolView
                name="plus.circle.fill"
                size={32}
                tintColor={composerBusy ? colors.gray300 : colors.charcoalSubtle}
              />
            </Pressable>

            <View style={styles.inputWrap}>
              <AppTextInput
                ref={inputRef}
                style={styles.input}
                value={input}
                onChangeText={onChangeInput}
                placeholder="Message your tutor…"
                placeholderTextColor={colors.charcoalSubtle}
                multiline
                // AppTextInput already kills the floating assistant-bar pill for
                // every field. This one field needs the SECOND prop as well: iOS
                // floats an "AutoFill" credential callout over the transcript when
                // a scholar taps the EMPTY composer, and that rides the system edit
                // menu, not the assistant bar — tested on the iPad 2026-08-13, with
                // the pill already gone and the callout still appearing.
                // (`textContentType="none"` + `autoComplete="off"` don't touch it
                // either; it vanishes the instant a character is typed and never
                // shows up in the app's accessibility tree.)
                //
                // The cost is this field's whole edit menu — Cut/Copy/Paste/Select
                // All, ⌘A included — which Andy chose over the callout. Not free: a
                // tutor message has a Copy action, so copy-a-line → paste-to-quote
                // no longer works here. Everything else a scholar could paste from
                // is out of reach anyway; these iPads are ASAM-kiosked to this app.
                contextMenuHidden
                // Hardware keyboard (Magic Keyboard): autofocus + refocus after
                // send so the scholar can just keep typing without re-tapping.
                // With a HW keyboard no soft keyboard pops; on touch-only it
                // shows the keyboard, which is the expected "ready to type".
                autoFocus
                // Return sends, without inserting a newline or blurring.
                submitBehavior="submit"
                onSubmitEditing={() => onSend()}
                editable={!composerBusy}
              />
              {/* Mic when there's nothing to send yet; send button otherwise.
                  Both are big filled violet circles so an empty composer clearly
                  reads "tap the mic to talk" — tap it, then tap ✓ to send. While
                  the tutor is replying the control becomes Stop (finalizes the
                  partial server-side); the composer stays editable so Return can
                  steer (stop + send the new turn). */}
              {visiblyStreaming && stopArmed ? (
                <Pressable
                  onPress={onStop}
                  hitSlop={8}
                  style={styles.sendBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Stop generating"
                >
                  <SymbolView
                    name="stop.circle.fill"
                    size={38}
                    tintColor={colors.violet}
                  />
                </Pressable>
              ) : visiblyStreaming ? (
                // Pre-token: an inert Send in the same slot (see stopArmed).
                <View
                  style={styles.sendBtn}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: true }}
                  accessibilityLabel="Sending"
                >
                  <SymbolView
                    name="arrow.up.circle.fill"
                    size={38}
                    tintColor={colors.gray300}
                  />
                </View>
              ) : !canSend && !image.imageId ? (
                <Pressable
                  onPress={onMicStart}
                  hitSlop={8}
                  style={styles.micBtn}
                  disabled={composerBusy}
                  accessibilityRole="button"
                  accessibilityLabel="Start recording — tap to talk, tap the check to send"
                >
                  <SymbolView
                    name="mic.circle.fill"
                    size={38}
                    tintColor={composerBusy ? colors.gray300 : colors.violet}
                  />
                </Pressable>
              ) : (
                <Pressable
                  onPress={() => onSend()}
                  disabled={!canSend}
                  hitSlop={8}
                  style={styles.sendBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Send message"
                >
                  <SymbolView
                    name="arrow.up.circle.fill"
                    size={38}
                    tintColor={canSend ? colors.violet : colors.gray300}
                  />
                </Pressable>
              )}
            </View>
          </View>
        )}
      </GlassBar>
    </Animated.View>
  );

  return (
    <>
      <Stack.Screen
        options={{
          title: headerTitle,
          // HOMEWORK SAYS IT IS HOMEWORK. Web parity (SessionInterface's
          // compass eyebrow): at 7pm at the kitchen table the load-bearing
          // facts are that this is homework, when it's due, and who set it —
          // the same `dueStatus()` phrasing as the tonight list that sent the
          // scholar here. Plain title otherwise.
          ...(homeworkEyebrowText
            ? {
                headerTitle: () => (
                  <View style={styles.homeworkHeaderTitle}>
                    <Text style={styles.homeworkHeaderEyebrow} numberOfLines={1}>
                      {homeworkEyebrowText}
                    </Text>
                    <Text style={styles.homeworkHeaderTitleText} numberOfLines={1}>
                      {headerTitle}
                    </Text>
                  </View>
                ),
              }
            : null),
          headerRight:
            activityId || unitId
              ? () => (
                <View style={styles.headerActions}>
                  <Pressable
                    onPress={() => setWhereOpen(true)}
                    hitSlop={10}
                    accessibilityRole="button"
                    accessibilityLabel="Where you are in this unit"
                  >
                    <SymbolView
                      name="location.circle"
                      size={27}
                      tintColor={colors.violet}
                    />
                  </Pressable>
                </View>
              )
              : undefined,
        }}
      />
      <SessionActivityNav
        sessionId={sessionId}
        unitId={unitId}
        activityId={activityId}
        assignmentId={data.session?.assignmentId}
        skipLearnerQueries={skipLearnerQueries}
      />
      {roomCues.rest && <RestOverlay returnAt={roomCues.rest.returnAt} />}
      {roomCues.message && (
        <RoomCueBanner cue={roomCues.message} onDismiss={roomCues.dismiss} />
      )}
      {roomCues.transition && (
        <RoomCueBanner cue={roomCues.transition} onDismiss={roomCues.dismiss} />
      )}
      {/* "Your class is elsewhere" — informational only; the session below
          stays fully usable (web parity: SessionInterface). */}
      {isFocusMismatch ? (
        <View style={styles.roomTurnBannerAmbient}>
          <SymbolView name="clock" size={14} tintColor={colors.violet} />
          <Text style={styles.roomTurnBannerAmbientText}>
            {focusMismatchBannerText(roomPhase, focusName, focusTimeLabel)}
          </Text>
        </View>
      ) : null}
      {/* "The turn, not the bell" — the scholar is INSIDE the live class
          focus session itself. No lock, ever — just a soft, ambient sense of
          when the room turns, which softens as it winds down, then a gentle
          choice once it moves on. Nothing here disables the composer or the
          session — the work stays open throughout. */}
      {isFocusMatch && roomPhase === "withClass" ? (
        <View style={styles.roomTurnBannerAmbient}>
          <SymbolView name="clock" size={14} tintColor={colors.violet} />
          <Text style={styles.roomTurnBannerAmbientText}>
            {classFocusPlateLine(roomPhase, focusTimeLabel)}
          </Text>
        </View>
      ) : null}
      {isFocusMatch && roomPhase === "windingDown" && !showTurnBanner ? (
        <View style={styles.roomTurnBanner}>
          <SymbolView name="clock" size={16} tintColor={colors.violet} />
          <Text style={styles.roomTurnBannerText}>
            {WINDING_DOWN_BANNER_TEXT}
          </Text>
        </View>
      ) : null}
      {showTurnBanner && !handsOffToHome ? (
        <View style={styles.roomTurnBanner}>
          <SymbolView name="clock" size={16} tintColor={colors.violet} />
          <Text style={styles.roomTurnBannerText}>{TURNED_BANNER_TEXT}</Text>
          <Pressable
            onPress={() => router.push("/")}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Done here, back to home"
          >
            <Text style={styles.roomTurnBannerAction}>Done here ›</Text>
          </Pressable>
        </View>
      ) : null}
      {/* ONE fixed tree position for the chat pane in every layout: the row
          wrapper always renders and only the panel beside it is conditional.
          Swapping the chat's parent (bare View ↔ row > View) when the panel
          appears — e.g. the tutor's first document in a no-activity session,
          mid-stream — remounted the whole pane (list, cards, composer) and
          dropped focus, scroll, and draft text (TRA-463 review). With no
          panel the single flex:1 child fills the row, so width is unchanged.
          The keyboard inset is applied inside chatPane (Animated.View wrapping
          the list + composer); the panel manages its own keyboard inset.
          In portrait, earned flair renders inline inside DeliverableCard (in
          the chat header) — scholar surfaces show earned flair only, never a
          rubric checklist. */}
      <View style={styles.landscapeRow}>
        <View style={styles.flex}>{chatPane}</View>
        {showPanelLayout ? (
          <DeliverablePanel
            sessionId={sessionId}
            activityId={activityId}
            codeArtifactRef={codeArtifactRef}
            onAskTutor={appTutorUpdates.onAskTutor}
            onAppAiTurn={appTutorUpdates.onAppAiTurn}
            appAiEnabled={isSessionOwner}
            checkDisabled={tutorBusy}
            onAskCheck={(artifact, shouldCheck) =>
              onRubricCheck(artifact._id, artifact.title, shouldCheck)
            }
            map={hasMapArtifact ? mapCard(true) : undefined}
          />
        ) : null}
      </View>
      <WhereAmIPanel
        visible={whereOpen}
        onClose={() => setWhereOpen(false)}
        sessionId={sessionId}
        unitId={unitId}
        activityId={activityId}
        assignmentId={data.session?.assignmentId}
        activityCompleted={completed}
        title={headerTitle}
        skipLearnerQueries={skipLearnerQueries}
      />
    </>
  );
}


function CompletionHandoffCard({
  visible,
  nextTitle,
  handsOffToHome,
  earlierHole,
  dispatchCompleted,
  loading,
  onUpNext,
  onBackToHome,
}: {
  visible: boolean;
  nextTitle: string | null;
  handsOffToHome: boolean;
  earlierHole: boolean;
  dispatchCompleted: Array<{ assignmentId: string; teacherName: string }>;
  loading: boolean;
  onUpNext?: () => void;
  onBackToHome?: () => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  if (!visible) return null;
  const hasNext = !!(nextTitle && onUpNext);
  const showHome = handsOffToHome && !!onBackToHome;

  return (
    <View style={styles.completionCard}>
      <View style={styles.completionMainRow}>
        <SymbolView
          name="checkmark.circle.fill"
          size={30}
          tintColor={colors.green}
        />
        <View style={styles.completionCopy}>
          <Text style={styles.completionTitle}>
            {"Nice work — this one's done!"}
          </Text>
          <Text style={styles.completionBody} numberOfLines={2}>
            {nextTitle
              ? `Up next: ${nextTitle}`
              : earlierHole
                ? "This part is done — head home to see what is left."
                : handsOffToHome
                  ? "Head back when you're ready."
                  : dispatchCompleted.length > 0
                    ? "Your session is marked complete."
                    : "Ready when you are — your next activity is up next."}
          </Text>
        </View>
        {hasNext ? (
          <View style={styles.completionActions}>
            <Pressable
              onPress={onUpNext}
              disabled={loading}
              accessibilityRole="button"
              accessibilityLabel={`Continue to ${nextTitle}`}
              style={({ pressed }) => [
                styles.upNextCardButton,
                (pressed || loading) && { opacity: 0.78 },
              ]}
            >
              {loading ? (
                <ActivityIndicator color={colors.white} />
              ) : (
                <Text style={styles.upNextCardText} numberOfLines={1}>
                  Continue
                </Text>
              )}
            </Pressable>
          </View>
        ) : showHome ? (
          <View style={styles.completionActions}>
            <Pressable
              onPress={onBackToHome}
              accessibilityRole="button"
              accessibilityLabel="Back to home"
              style={({ pressed }) => [
                styles.upNextCardButton,
                pressed && { opacity: 0.78 },
              ]}
            >
              <Text style={styles.upNextCardText} numberOfLines={1}>
                Back to home
              </Text>
            </Pressable>
          </View>
        ) : null}
      </View>
      <DispatchCompletionReceipt
        receipts={dispatchCompleted}
        kind="work"
      />
    </View>
  );
}

/**
 * The transcript notice's entrance — the web `rhFlairNoticeRise` /
 * `rhFlairNoticeEmoji` keyframes, expressed as Reanimated keyframes so the whole
 * thing runs on the UI thread. Built per row, because `.delay()` mutates the
 * instance it is called on.
 */
function noticeRowEntrance(delayMs: number) {
  return new Keyframe({
    0: { opacity: 0, transform: [{ translateY: 4 }] },
    100: { opacity: 1, transform: [{ translateY: 0 }] },
  })
    .duration(FLAIR_MOTION.noticeRiseMs)
    .delay(delayMs);
}

/** The mark's settle, inside the row that is already rising. */
function noticeMarkEntrance(delayMs: number) {
  return new Keyframe({
    0: { transform: [{ scale: 0.82 }] },
    62: { transform: [{ scale: 1.04 }] },
    100: { transform: [{ scale: 1 }] },
  })
    .duration(FLAIR_MOTION.noticeEmojiMs)
    .delay(delayMs);
}

function FlairAwardNotice({
  awards,
  sessionId,
  animate = false,
  onAnimationClaim,
}: {
  awards: FlairAward[];
  sessionId: Id<"sessions">;
  /**
   * True only for a flair row this client has just seen arrive — the caller's
   * arrival baseline decides that, and a remote teacher view passes false so an
   * observer never sees the scholar's moment replayed as their own.
   *
   * Deliberately NOT gated on a live stream: Convex subscription catch-up can
   * land after the SSE connection closes, which would drop the entrance on a
   * genuinely new award. Read once, at mount, because the caller's `arriving`
   * list settles while the entrance may still be running and re-reading it
   * would restart the row.
   */
  animate?: boolean;
  /** Marks this arrival consumed while the mounted notice finishes locally. */
  onAnimationClaim?: () => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const reduceMotion = useReducedMotion();
  const [entering] = useState(() => animate && !reduceMotion);
  useEffect(() => {
    if (entering) onAnimationClaim?.();
  }, [entering, onAnimationClaim]);
  const art = useQuery(api.flairArt.forSession, { sessionId });
  const artByCriterionId = new Map(
    (art ?? []).map((item) => [item.criterionId, item]),
  );

  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={`Earned flair. ${awards.map((award) => award.label).join(". ")}`}
      style={styles.flairAwardNotice}
    >
      {awards.map((award, index) => {
        const delay = flairNoticeDelayMs(index);
        const generated = artByCriterionId.get(award.criterionId);
        return (
          <Animated.View
            key={award.criterionId}
            entering={entering ? noticeRowEntrance(delay) : undefined}
            style={styles.flairAwardRow}
          >
            {/* The mark settles inside the row that is already rising, so the
                wrapper — not FlairMark itself — carries the scale. Its art
                swaps in underneath whenever the generated image finishes. */}
            <Animated.View
              entering={entering ? noticeMarkEntrance(delay) : undefined}
            >
              <FlairMark
                imageUrl={generated?.imageUrl ?? null}
                initial={generated?.initial ?? flairInitial(award.label)}
                label={award.label}
              />
            </Animated.View>
            <View style={styles.flairAwardCopy}>
              <Text style={styles.flairAwardLabel}>Earned flair</Text>
              <Text style={styles.flairAwardTitle}>{award.label}</Text>
            </View>
          </Animated.View>
        );
      })}
    </View>
  );
}

function flairInitial(label: string): string {
  return Array.from(label.trim())[0]?.toLocaleUpperCase() ?? "?";
}

// Renders an attached photo in a chat bubble. The URL is served beside the
// message row by getWithMessages; we show it with expo-image.
function ImageBubble({ url }: { url: string | null }) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  if (!url) {
    return (
      <View style={[styles.imageBubble, styles.imageLoading]}>
        <ActivityIndicator color={colors.gray300} />
      </View>
    );
  }
  return (
    <Image source={{ uri: url }} style={styles.imageBubble} contentFit="cover" alt="Attached photo" />
  );
}

// A tutor-generated illustration (the `generate_image` tool). Unlike a
// scholar's photo attachment this is teaching content, not a thumbnail: it
// renders at column width and keeps the image's own aspect ratio, because a
// cropped diagram loses exactly the labels it was generated to show.
function GeneratedImageCard({
  url,
  altText,
}: {
  url: string | null;
  altText?: string;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  // Squarish until the real dimensions land, so the row doesn't jump far.
  const [aspectRatio, setAspectRatio] = useState(1);
  // A picture that never decodes used to leave an empty frame under its
  // caption, with nothing to tap — the turn-level "Try again" retries the
  // TUTOR's turn, not this image. `attempt` remounts the <Image> with a fresh
  // recycling key, so one retry really re-fetches (a dropped connection). If
  // that fails too, the stored bytes are the problem and no retry can fix
  // them, so stop offering one and point at what does work: a fresh search.
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  if (!url) {
    return (
      <View
        style={[styles.generatedImage, { aspectRatio }, styles.imageLoading]}
      >
        <ActivityIndicator color={colors.gray300} />
      </View>
    );
  }
  if (failed && attempt > 0) {
    return (
      <View style={[styles.generatedImage, styles.imageFailed]}>
        <Text style={styles.imageFailedText}>This picture couldn’t be shown</Text>
        <Text style={styles.imageFailedText}>
          Ask your tutor to find a different one
        </Text>
      </View>
    );
  }
  if (failed) {
    return (
      <Pressable
        onPress={() => {
          setFailed(false);
          setAttempt((count) => count + 1);
        }}
        accessibilityRole="button"
        accessibilityLabel="Reload this picture"
        style={[styles.generatedImage, styles.imageFailed]}
      >
        <Text style={styles.imageFailedText}>This picture didn’t load</Text>
        <Text style={styles.imageFailedAction}>Tap to try again</Text>
      </Pressable>
    );
  }
  return (
    <Image
      key={attempt}
      recyclingKey={`${url}:${attempt}`}
      source={{ uri: url }}
      style={[styles.generatedImage, { aspectRatio }]}
      contentFit="contain"
      alt={altText || "Illustration from your tutor"}
      onError={() => setFailed(true)}
      onLoad={(event) => {
        const { width, height } = event.source ?? {};
        if (width && height) setAspectRatio(width / height);
      }}
    />
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
  ...chatBubbleStyles(c),
  flex: { flex: 1, backgroundColor: c.bgSubtle },
  landscapeRow: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: c.bgSubtle,
  },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 16 },
  // "The turn, not the bell" — calm, non-alarming violet: nothing here is
  // locked, just a soft heads-up.
  roomTurnBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: palette.violet[200],
    backgroundColor: palette.violet[50],
  },
  roomTurnBannerText: {
    flex: 1,
    color: palette.violet[700],
    fontFamily: fonts.semibold,
    fontSize: 13.5,
    lineHeight: 19,
  },
  roomTurnBannerAction: {
    color: palette.violet[700],
    fontFamily: fonts.semibold,
    fontSize: 13.5,
  },
  // The quiet "with the class" ambient line — smaller + lighter than the
  // windingDown/turned banners since it's not asking for any attention.
  roomTurnBannerAmbient: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 18,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: palette.violet[100],
    backgroundColor: palette.violet[50],
  },
  roomTurnBannerAmbientText: {
    flex: 1,
    color: palette.violet[600],
    fontFamily: fonts.regular,
    fontSize: 12,
    lineHeight: 16,
  },
  list: {
    width: "100%",
    maxWidth: COLUMN_MAX_WIDTH,
    alignSelf: "center",
    paddingHorizontal: 20,
    paddingVertical: 20,
    gap: 20,
  },
  bakeWait: {
    // The list is inverted, so an empty-state child renders upside down
    // without this — the scaleY flip cancels the list's own.
    transform: [{ scaleY: -1 }],
    alignItems: "center",
    gap: 8,
    paddingVertical: 48,
  },
  bakeWaitTitle: {
    fontFamily: fonts.semibold,
    fontSize: 17,
    color: c.charcoal,
  },
  bakeWaitBody: {
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
    color: c.charcoalSubtle,
  },
  flairAwardNotice: {
    alignSelf: "stretch",
    alignItems: "flex-start",
    gap: 8,
  },
  flairAwardRow: {
    flexDirection: "row",
    alignItems: "center",
    maxWidth: "88%",
    gap: 8,
  },
  flairAwardCopy: {
    flexShrink: 1,
    minWidth: 0,
  },
  flairAwardLabel: {
    fontFamily: fonts.regular,
    fontSize: 12,
    lineHeight: 16,
    // Same gray as every other transcript system line (`toolActivityText`).
    color: c.charcoalMuted,
  },
  flairAwardTitle: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    lineHeight: 16,
    color: c.charcoalMuted,
  },
  row: { flexDirection: "row" },
  rowMine: { justifyContent: "flex-end" },
  rowTutor: { justifyContent: "flex-start" },
  colMine: { maxWidth: "80%", alignItems: "flex-end" },
  colTutor: { maxWidth: "80%", alignItems: "flex-start" },
  flagRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginTop: 5,
    marginLeft: 6,
  },
  flagText: {
    fontSize: 12.5,
    fontFamily: fonts.semibold,
    color: c.orange,
  },
  // The user cut this reply short — a muted, sentence-case caption under the
  // finished bubble (matches the web transcript's "Stopped").
  stopped: {
    marginTop: 3,
    marginLeft: 6,
    fontSize: 12,
    fontFamily: fonts.regular,
    color: c.charcoalSubtle,
  },
  completionCard: {
    marginBottom: 14,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: palette.green[200],
    backgroundColor: palette.green[50],
    paddingVertical: 16,
    paddingHorizontal: 18,
  },
  completionMainRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  completionCopy: { flex: 1, minWidth: 0, gap: 3 },
  completionTitle: {
    fontSize: 17,
    fontFamily: fonts.bold,
    color: c.green,
  },
  completionBody: {
    fontSize: 14,
    lineHeight: 20,
    fontFamily: fonts.regular,
    color: c.charcoalMuted,
  },
  upNextCardButton: {
    maxWidth: 220,
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: c.green,
  },
  upNextCardText: {
    fontSize: 14,
    fontFamily: fonts.semibold,
    color: c.white,
  },
  completionActions: {
    alignItems: "flex-end",
    gap: 8,
    flexShrink: 0,
  },
  imageBubble: {
    width: 220,
    height: 220,
    borderRadius: 20,
    backgroundColor: c.gray100,
  },
  imageLoading: { alignItems: "center", justifyContent: "center" },
  imageFailed: {
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 22,
    paddingHorizontal: 18,
  },
  imageFailedText: {
    fontSize: 14,
    fontFamily: fonts.regular,
    color: c.charcoalSubtle,
    textAlign: "center",
  },
  imageFailedAction: {
    fontSize: 14,
    fontFamily: fonts.medium,
    color: c.violet,
    textAlign: "center",
  },
  generatedImage: {
    width: "100%",
    maxWidth: 420,
    marginBottom: 6,
    borderRadius: 20,
    backgroundColor: c.gray100,
  },
  composer: {
    paddingTop: 10,
    paddingBottom: 10,
    paddingHorizontal: 16,
  },
  // S2 header framing + S3 done control (homework sessions only).
  homeworkHeaderTitle: { alignItems: "center", justifyContent: "center" },
  homeworkHeaderEyebrow: {
    fontSize: 11,
    fontFamily: fonts.medium,
    color: c.fgMuted,
    maxWidth: 420,
  },
  homeworkHeaderTitleText: {
    fontSize: 17,
    fontFamily: fonts.semibold,
    color: c.fg,
    maxWidth: 420,
  },
  homeworkDoneRow: {
    width: "100%",
    maxWidth: COLUMN_MAX_WIDTH,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingBottom: 8,
  },
  homeworkDoneBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 999,
    paddingVertical: 7,
    paddingHorizontal: 14,
  },
  homeworkDoneBtnText: {
    fontSize: 14,
    fontFamily: fonts.semibold,
    color: c.navy,
  },
  homeworkDoneConfirmedText: {
    fontSize: 13,
    fontFamily: fonts.medium,
    color: c.fgMuted,
  },
  homeworkDoneUndoText: {
    fontSize: 13,
    fontFamily: fonts.semibold,
    color: c.fgMuted,
    textDecorationLine: "underline",
  },
  inputWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
    backgroundColor: c.bg + "b3", // bg at ~70% opacity for the text-input pill
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 24,
    paddingLeft: 18,
    paddingRight: 6,
    paddingVertical: 6,
  },
  composerRow: {
    width: "100%",
    maxWidth: COLUMN_MAX_WIDTH,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
  },
  attachBtn: { paddingBottom: 8 },
  micBtn: { paddingBottom: 2 },
  toolActivityRow: {
    width: "100%",
    maxWidth: COLUMN_MAX_WIDTH,
    alignSelf: "center",
    alignItems: "center",
    paddingVertical: 4,
  },
  toolActivityText: {
    fontSize: 13,
    fontFamily: fonts.semibold,
    color: c.charcoalMuted,
    textAlign: "center",
  },
  previewRow: {
    width: "100%",
    maxWidth: COLUMN_MAX_WIDTH,
    alignSelf: "center",
    marginBottom: 8,
  },
  previewChip: {
    width: 88,
    height: 88,
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: c.gray100,
  },
  previewImg: { width: "100%", height: "100%" },
  previewOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.3)",
  },
  previewRemove: {
    position: "absolute",
    top: 2,
    right: 2,
    backgroundColor: c.white,
    borderRadius: 11,
  },
  input: {
    flex: 1,
    ...CHAT_COMPOSER_INPUT,
    fontFamily: fonts.regular,
    color: c.charcoal,
    paddingVertical: 8,
    maxHeight: 140,
  },
  sendBtn: { paddingBottom: 2 },
  });
}
