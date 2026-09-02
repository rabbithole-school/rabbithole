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
import { GeoMapCard } from "@/components/GeoMapCard";
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
import { CHAT_COMPOSER_INPUT } from "@/lib/chatType";
import { chatBubbleStyles, OPENER_SENTINEL } from "@/lib/chatBubbles";
import { friendlyToolName } from "@/lib/toolLabels";
import { fonts, palette, useColors } from "@/theme";
import { FlairMark } from "@/components/FlairChips";
import { FLAIR_MOTION, flairNoticeDelayMs } from "../../../vendor/shared/flairMotion";
import { useFlairArrivals } from "../../../vendor/shared/useFlairArrivals";
import type { GraphemeSpan } from "../../../vendor/shared/graphemeSegments";
import { pickLockingFocus } from "../../../vendor/shared/focusLock";
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
const COLUMN_MAX_WIDTH = 720;

type Bubble = {
  key: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  messageId?: Id<"messages">;
  gotItWrong?: boolean;
  imageId?: Id<"_storage">;
  // A tutor-generated illustration (`generate_image`), which rides on a TOOL
  // row alongside its receipt label. Kept separate from `imageId` (a scholar's
  // photo attachment) because the two render differently: a photo is a square
  // thumbnail, an illustration is content whose labels have to stay readable.
  generatedImage?: { imageId: Id<"_storage">; altText?: string };
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
};

type FlairAward = {
  criterionId: string;
  label: string;
};

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
  const toggleWrong = useMutation(api.messageFlags.toggle);
  const createSession = useMutation(api.sessions.create);
  // Kicks off a rubric re-check with NO fabricated user turn — creates only an
  // assistant placeholder; the stream injects an ephemeral, non-persisted
  // instruction (convex/http.ts). Matches the web "Check my work" flow.
  const startRubricCheck = useMutation(api.sessions.startRubricCheck);
  const submitDeliverable = useMutation(api.deliverables.submit);
  const startActivityKickoff = useMutation(api.sessions.startActivityKickoff);
  const activeSessions = useQuery(api.sessions.list, { asLearner: true });
  const currentFocus = useQuery(api.assignments.currentClassFocusForMe, {
    asLearner: true,
  });
  const homeworkForMe = useQuery(api.assignments.homeworkForMe, {
    asLearner: true,
  });
  // The caller's own reading-ramp inventory (`{ team, stage }[]`, or `[]` when
  // none). Folded once into a `team → stage` map; an empty map is the plain-text
  // fast path (no GraphemeText anywhere). Only pre-reader scholars have an
  // inventory, so this is empty for everyone else. See buildStageMap.
  const graphemeInventory = useQuery(api.graphemeInventory.mine);
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
  const [navigatingNext, setNavigatingNext] = useState(false);
  // The transient tool/thinking/image status for the in-flight turn (mirrors the
  // web SessionInterface's tool-activity indicator + "Generating image…" — see
  // ChatActivityRow). Null when the tutor is idle or just streaming text.
  const [activity, setActivity] = useState<ChatActivity | null>(null);
  // The just-created assistant placeholder row — filtered out of the persisted
  // list while we render its live streaming text instead (avoids a dupe).
  const [liveAssistantId, setLiveAssistantId] = useState<string | null>(null);
  const activeKickoffPlaceholder =
    data?.messages.length === 1 &&
    data.messages[0].role === "assistant" &&
    data.messages[0].content.trim() === "" &&
    !!data.messages[0].streamId &&
    data.messages[0].streamTrigger === "activityKickoff"
      ? data.messages[0]
      : null;
  const tutorBusy =
    streaming || kickoffPending || activeKickoffPlaceholder !== null;


  const headerTitle = data?.session?.title ?? title ?? "Session";
  const sessionActivityId = data?.session?.activityId as Id<"activities"> | undefined;
  const sessionUnitId = data?.session?.unitId as Id<"units"> | undefined;
  const activityCompletedAt = data?.session?.activityCompletedAt ?? null;
  const activityCompletionMessageId =
    data?.session?.activityCompletionMessageId ?? null;
  const progress = useUnitProgress({
    unitId: sessionUnitId,
    activityId: sessionActivityId,
    assignmentId: data?.session?.assignmentId,
    enabled: !!sessionUnitId,
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
  const isHomeworkSession =
    !!sessionAssignmentId &&
    !!sessionActivityIdForHomework &&
    (homeworkForMe ?? []).some(
      (h) =>
        String(h.assignmentId) === sessionAssignmentId &&
        String(h.activityId) === sessionActivityIdForHomework,
    );
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

  // Room Layer — a teacher's live cue reaching this open session (see
  // convex/roomCues.ts). Native has no teacher test-drive/remote-view, so the
  // only gate is that this screen is actually showing a real session.
  const roomCues = useActiveRoomCues(!!sessionId);

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
                    imageId: display.imageId,
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
        graphemeSpans: m.graphemeSpans,
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
  const invertedBubbles = completionTimeline.reverse();

  // Streams the tutor's reply for an already-created assistant placeholder.
  // Shared by onSend (normal message) and onRubricCheck (silent rubric check).
  // Does NOT own the `streaming` flag — callers guard + reset their own state.
  // A failure here is not message loss: the row is already persisted and the
  // reactive query still shows the finished reply.
  const runTutorStream = useCallback(
    async (body: Record<string, unknown>, assistantMsgId: string) => {
      setLiveAssistantId(assistantMsgId);
      let completed = false;
      let failed = false;
      try {
        const resp = await expoFetch(`${convexSiteUrl}/project-stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          body: JSON.stringify({ ...body, platform: "native" }),
        });

        const reader = resp.body?.getReader();
        const decoder = new TextDecoder();
        let full = "";
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const line of decoder.decode(value).split("\n")) {
              if (!line.startsWith("data: ")) continue;
              try {
                const ev = JSON.parse(line.slice(6));
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
                if (ev.done) {
                  completed = true;
                }
                if (ev.error) {
                  failed = true;
                }
              } catch {
                // ignore non-JSON keepalive lines
              }
            }
          }
        }
        // Let the wet-ink reveal finish AND the persisted row catch up before the
        // handoff to the settled Markdown render, so the swap is seamless (no jump
        // from held-back text or a momentarily-stale DB row).
        await new Promise((r) => setTimeout(r, 320));
        return completed && !failed;
      } catch (streamErr) {
        console.warn("[stream] failed", streamErr);
        return false;
      }
    },
    [authToken],
  );

  const runInstructionHandback = useCallback(
    async (handback: InstructionHandbackStart) => {
      if (streaming) throw new Error("The tutor is already responding");
      setStreaming(true);
      setStreamingText("");
      setActivity(null);
      const completed = await runTutorStream(
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
      if (!completed) throw new Error("The tutor handback did not finish");
    },
    [runTutorStream, streaming],
  );

  const onSend = useCallback(async (
    overrideText?: string,
    inputModality: "typed" | "spoken" = "typed",
  ) => {
    // overrideText is the "send this exact text" path (voice dictation); the
    // typed path reads the composer input. We never stuff the transcript into
    // the input box — tapping ✓ on a recording sends it in one step.
    const usingOverride = overrideText !== undefined;
    const text = (overrideText ?? input).trim();
    const imageId = image.imageId;
    // Allow sending an image with no text (web allows image-only).
    if (
      (!text && !imageId) ||
      streaming ||
      kickoffPendingRef.current ||
      activeKickoffPlaceholder ||
      image.uploading
    ) {
      return;
    }
    voiceMark("sendMessage");
    try {
      await flushPendingArtifactSaves();
    } catch {
      Alert.alert(
        "Finish saving your document",
        "Choose a document version or retry its save before sending your message.",
      );
      return;
    }
    setStreaming(true);
    setStreamingText("");
    setActivity(null);
    try {
      const res = await sendMessage({
        sessionId,
        message: text,
        ...(imageId ? { imageId } : {}),
        ...(text !== OPENER_SENTINEL ? { inputModality } : {}),
      });
      // The message is now persisted — only NOW is it safe to clear the
      // composer. Clearing optimistically (before the await) would silently
      // discard the scholar's text + image if the mutation rejected. Only the
      // typed path clears the input box; the voice path never wrote to it, so
      // clearing there could wipe text the scholar had already typed.
      if (!usingOverride) setInput("");
      image.clear();

      // Tutor runs + streams via the HTTP action (shared SSE reader). A failure
      // in the stream is NOT message loss — the message is already saved and the
      // reactive query still shows the tutor's reply once the server finishes.
      await runTutorStream(
        {
          sessionId: res.sessionId,
          streamId: res.streamId,
          assistantMsgId: res.assistantMsgId,
        },
        res.assistantMsgId,
      );

    } catch (e) {
      // The mutation itself failed → the message was NOT saved. The composer
      // still holds the scholar's text + image (we never cleared), so nothing is
      // lost; tell them so they can retry.
      console.warn("[send] failed", e);
      Alert.alert(
        "Couldn't send",
        "Your message wasn't sent. Check your connection and try again.",
      );
    } finally {
      setStreaming(false);
      setStreamingText("");
      setLiveAssistantId(null);
      setActivity(null);
      // Keep the composer focused so the scholar can keep typing (HW keyboard).
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [
    input,
    streaming,
    activeKickoffPlaceholder,
    image,
    sendMessage,
    sessionId,
    runTutorStream,
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
        const res = await startRubricCheck({ sessionId });
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
          const completed = await runTutorStream(
            {
              sessionId: res.sessionId,
              streamId: res.streamId,
              assistantMsgId: res.assistantMsgId,
              kickoff: true,
            },
            res.assistantMsgId,
          );
          if (!completed) {
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
        }
      })();
      return;
    }

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
  ]);

  // Voice dictation. The mic button starts recording; the RecordingBar's ✓
  // button finishes → transcribe → send in one step (the kid decides when
  // they're done, then it goes). No text is dropped into the input box to
  // review, and there's no silence auto-stop — nothing fires until they tap ✓.
  const onMicStart = useCallback(async () => {
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
  const nextIncomplete = completed ? progress.nextIncompleteOnlineActivity : null;
  const unitComplete =
    completed &&
    !!unitId &&
    progress.activityTotal > 0 &&
    progress.completedCount >= progress.activityTotal &&
    !nextIncomplete;
  // Current activity done, no forward next, but the unit isn't fully complete —
  // an EARLIER activity is still a hole. The in-session Continue CTA is
  // forward-only (see ../../vendor/shared/nextIncompleteActivity.ts), so hand
  // off to Home, which owns routing back to earlier incomplete beats.
  const earlierHole =
    completed &&
    !!unitId &&
    progress.activityTotal > 0 &&
    !nextIncomplete &&
    !unitComplete;

  const openNextIncomplete = async () => {
    const target = nextIncomplete?.activity;
    if (!target || navigatingNext) return;
    Haptics.selectionAsync();
    setNavigatingNext(true);
    try {
      const existing = (activeSessions ?? []).find(
        (s) =>
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
  const isLandscape = width > height;
  const showPanelLayout = isLandscape && !!activityId;

  const canSend =
    (input.trim().length > 0 || !!image.imageId) &&
    !tutorBusy &&
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
          ListHeaderComponent={
            <View>
              <GeoMapCard
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
              <ManipulativeCard sessionId={sessionId} />
              {!showPanelLayout && activityId ? (
                <DeliverableCard
                  sessionId={sessionId}
                  activityId={activityId}
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
            if (item.completion) {
              return (
                <View>
                  <SessionRecapCard sessionId={sessionId} isComplete />
                  <CompletionHandoffCard
                    visible={
                      !!nextIncomplete ||
                      unitComplete ||
                      earlierHole ||
                      (data.dispatchCompleted?.length ?? 0) > 0
                    }
                    nextTitle={nextIncomplete?.activity.title ?? null}
                    unitComplete={unitComplete}
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
                    imageId={item.generatedImage.imageId}
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
          const isStreaming =
            streaming && !!item.messageId && item.messageId === liveAssistantId;
          const displayContent = isStreaming ? streamingText : item.content;
          const empty = displayContent.length === 0;
          // The "…" is the WAITING signal — the tutor has been asked and nothing
          // has come back yet. It belongs to the live turn (or the not-yet-
          // streaming activity-kickoff placeholder) and nothing else: an empty
          // bubble that isn't pending is a finished or abandoned turn, and
          // leaving an ellipsis on it made the transcript reflow the moment the
          // stream ended.
          const isPendingTurn =
            isStreaming ||
            (!!item.messageId &&
              item.messageId === activeKickoffPlaceholder?.id);
          const hasImage = !!item.imageId;
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
            !(mine && hasImage && empty) && !(empty && !isPendingTurn);
          return (
            <View style={[styles.row, mine ? styles.rowMine : styles.rowTutor]}>
              <View style={mine ? styles.colMine : styles.colTutor}>
                {hasImage && <ImageBubble imageId={item.imageId!} />}
                {showText && (
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
                      {empty ? (
                        // Waiting on the first token: show the live
                        // tool/thinking/image status if the tutor is working,
                        // else a plain "…".
                        activity ? (
                          <ChatActivityRow activity={activity} />
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
                        <Markdown content={item.content} color={colors.charcoal} />
                      )}
                    </View>
                  </SpeakableBubble>
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
              disabled={tutorBusy}
              accessibilityRole="button"
              accessibilityLabel="Add a photo"
            >
              <SymbolView
                name="plus.circle.fill"
                size={32}
                tintColor={tutorBusy ? colors.gray300 : colors.charcoalSubtle}
              />
            </Pressable>

            <View style={styles.inputWrap}>
              <AppTextInput
                ref={inputRef}
                style={styles.input}
                value={input}
                onChangeText={setInput}
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
                editable={!tutorBusy}
              />
              {/* Mic when there's nothing to send yet; send button otherwise.
                  Both are big filled violet circles so an empty composer clearly
                  reads "tap the mic to talk" — tap it, then tap ✓ to send. */}
              {!canSend && !image.imageId ? (
                <Pressable
                  onPress={onMicStart}
                  hitSlop={8}
                  style={styles.micBtn}
                  disabled={tutorBusy}
                  accessibilityRole="button"
                  accessibilityLabel="Start recording — tap to talk, tap the check to send"
                >
                  <SymbolView
                    name="mic.circle.fill"
                    size={38}
                    tintColor={tutorBusy ? colors.gray300 : colors.violet}
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
      {showTurnBanner && !unitComplete && !earlierHole ? (
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
      {showPanelLayout ? (
        // ── LANDSCAPE with deliverable: side-by-side chat + panel ──
        // The keyboard inset is applied inside chatPane (Animated.View wrapping
        // the list + composer) — the panel manages its own keyboard via
        // KeyboardAvoidingView internally.
        <View style={styles.landscapeRow}>
          <View style={styles.flex}>
            {chatPane}
          </View>
          <DeliverablePanel
            sessionId={sessionId}
            activityId={activityId}
            checkDisabled={tutorBusy}
            onAskCheck={(artifact, shouldCheck) =>
              onRubricCheck(artifact._id, artifact.title, shouldCheck)
            }
          />
        </View>
      ) : (
        // ── PORTRAIT (or no activity): stacked layout unchanged ──
        // Earned flair renders inline inside DeliverableCard (in the chat
        // header); there's no separate goal-criteria bar — scholar surfaces
        // show earned flair only, never a rubric checklist.
        <View style={styles.flex}>
          {/* The list + composer share ONE animated bottom inset, so they track
              the keyboard in lockstep (no desync between the bar and the scroll). */}
          {chatPane}
        </View>
      )}
      <WhereAmIPanel
        visible={whereOpen}
        onClose={() => setWhereOpen(false)}
        sessionId={sessionId}
        unitId={unitId}
        activityId={activityId}
        assignmentId={data.session?.assignmentId}
        activityCompleted={completed}
        title={headerTitle}
      />
    </>
  );
}


function CompletionHandoffCard({
  visible,
  nextTitle,
  unitComplete,
  earlierHole,
  dispatchCompleted,
  loading,
  onUpNext,
  onBackToHome,
}: {
  visible: boolean;
  nextTitle: string | null;
  unitComplete: boolean;
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
  const showHome = (unitComplete || earlierHole) && !!onBackToHome;

  return (
    <View style={styles.completionCard}>
      <View style={styles.completionMainRow}>
        <SymbolView
          name={unitComplete ? "checkmark.seal.fill" : "checkmark.circle.fill"}
          size={30}
          tintColor={colors.green}
        />
        <View style={styles.completionCopy}>
          <Text style={styles.completionTitle}>
            {unitComplete ? "Unit complete!" : "Nice work — this one's done!"}
          </Text>
          <Text style={styles.completionBody} numberOfLines={2}>
            {unitComplete
              ? "You finished every activity in this unit."
              : nextTitle
                ? `Up next: ${nextTitle}`
                : earlierHole
                  ? "This part is done — head home to see what is left."
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

// Renders an attached photo in a chat bubble. The message carries the storage
// id; we resolve it to a URL via files.getUrl and show it with expo-image.
function ImageBubble({ imageId }: { imageId: Id<"_storage"> }) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const url = useQuery(api.files.getUrl, { storageId: imageId });
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
  imageId,
  altText,
}: {
  imageId: Id<"_storage">;
  altText?: string;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const url = useQuery(api.files.getUrl, { storageId: imageId });
  // Squarish until the real dimensions land, so the row doesn't jump far.
  const [aspectRatio, setAspectRatio] = useState(1);
  if (!url) {
    return (
      <View
        style={[styles.generatedImage, { aspectRatio }, styles.imageLoading]}
      >
        <ActivityIndicator color={colors.gray300} />
      </View>
    );
  }
  return (
    <Image
      source={{ uri: url }}
      style={[styles.generatedImage, { aspectRatio }]}
      contentFit="contain"
      alt={altText || "Illustration from your tutor"}
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
