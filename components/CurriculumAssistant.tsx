"use client";

import { useState, useEffect, useMemo, useRef, useCallback, Fragment } from "react";
import { useRouter, usePathname } from "next/navigation";
import NextLink from "next/link";
import {
  Box,
  Flex,
  VStack,
  Text,
  Textarea,
  IconButton,
  Button,
  Spinner,
  Badge,
  Menu,
  Portal,
  Tooltip,
  Dialog,
} from "@chakra-ui/react";
import {
  PaperPlaneTilt,
  Plus,
  Paperclip,
  Camera,
  X,
  DotsThreeVertical,
  PencilSimple,
  Trash,
  PushPin,
  Robot,
  SlackLogo,
  Stop,
  ThumbsUp,
  ThumbsDown,
  GoogleDriveLogoIcon,
} from "@phosphor-icons/react";
import { MAX_FLAG_SNIPPET_LEN } from "@/lib/manualRehearsalFlags";
import { UNIT_BOT_SUGGESTIONS } from "@/lib/curriculumBotPrompts";
import ReactMarkdown from "react-markdown";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";
import {
  selectedListRowLabelColor,
  selectedListRowProps,
} from "@/lib/listRowStyles";
import { StreamRegistryProvider, useStreamRegistry } from "@/hooks/useStreamRegistry";
import { StreamingTurn } from "./StreamingTurn";
import { DictationMicButton } from "./DictationMicButton";
import { ScopeChip } from "./ScopeChip";
import AideModelPicker from "./AideModelPicker";
import { GoogleAccountConnect } from "./GoogleAccountConnect";
import { needsGoogleReconsent } from "./googleConsentStatus";
import { GooglePickerButton } from "./GooglePickerButton";
import { CameraCaptureDialog } from "./CameraCaptureDialog";
import { aideMarkdownComponents, aideRemarkPlugins } from "./AideThread";
import { formatTimeAgo } from "@/lib/relativeTime";
import { openExternal } from "@/lib/native";
import { teacherChatHref } from "@/lib/teacherChat";
import { convexSiteUrl } from "@/lib/convexUrls";
import { EmptyState } from "@/components/ui/EmptyState";
import { toaster } from "@/lib/toaster";
import { uploadMessageAttachment } from "@/lib/uploadMessageAttachment";
import {
  MESSAGE_ATTACHMENT_ACCEPT,
  MESSAGE_ATTACHMENT_MAX_BYTES,
  type MessageAttachment,
} from "@/shared/messageAttachments";
// markdown link rendering is shared via AideThread's aideMarkdownComponents.

/** Extract the active chat id from a `/teacher/chat/<chatId>`
 *  pathname (null on the bare `/teacher/chat` route). The standalone Chat
 *  tab's active thread lives in the path so it's shareable / back-navigable. */
function chatIdFromPathname(pathname: string): string | null {
  const m = pathname.match(/^\/teacher\/chat\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}


// A file the teacher attaches to a chat message via the "+" button. Mirrors
// the `attachments` shape on curriculumMessages / sendSessionMessage.
type ChatAttachment = MessageAttachment<Id<"_storage">>;

type DriveAttachment = {
  driveFileId: string;
  url: string;
  name: string;
  mimeType: string;
  thumbnailUrl?: string;
};

// formatRelativeTime dropped — use formatTimeAgo from lib/relativeTime

function StreamingDot() {
  return (
    <>
      <style>{`@keyframes rbhChatPulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(1.5)}}`}</style>
      <Box
        w="7px"
        h="7px"
        borderRadius="full"
        bg="violet.500"
        flexShrink={0}
        style={{ animation: "rbhChatPulse 1.4s ease-in-out infinite" }}
      />
    </>
  );
}

// A subtle "via Slack" provenance badge for sessions that originated from a
// Slack thread.
function SlackBadge() {
  return (
    <Flex align="center" gap={1} color="charcoal.300" flexShrink={0}>
      <SlackLogo size={12} weight="fill" />
      <Text as="span" fontFamily="heading" fontSize="2xs" fontWeight="500">
        via Slack
      </Text>
    </Flex>
  );
}

// The assistant's gray markdown bubble — shared by finalized messages AND the
// live streaming turn (StreamingTurn renders each text run through this), so
// inline tool rows sit between bubbles styled identically to history.
const assistantBubbleCss = {
  "& p": { marginBottom: "0.5em" },
  "& p:last-child": { marginBottom: 0 },
  "& ul, & ol": { paddingLeft: "1.5em", marginBottom: "0.5em" },
  "& li": { marginBottom: "0.25em" },
  "& code": { background: "var(--chakra-colors-gray-200)", padding: "0.1em 0.3em", borderRadius: "4px", fontSize: "0.9em" },
  "& pre": { background: "var(--chakra-colors-gray-200)", padding: "0.75em", borderRadius: "8px", overflowX: "auto", marginBottom: "0.5em" },
  "& pre code": { background: "none", padding: 0 },
  "& h1, & h2, & h3, & h4": { fontFamily: "var(--chakra-fonts-heading)", fontWeight: 600, marginTop: "0.5em", marginBottom: "0.25em" },
  "& strong": { fontWeight: 600 },
  "& table": { borderCollapse: "collapse", width: "100%", marginBottom: "0.5em", fontSize: "0.85em" },
  "& th, & td": { border: "1px solid var(--chakra-colors-gray-300)", padding: "0.35em 0.65em", textAlign: "left" },
  "& th": { background: "var(--chakra-colors-gray-200)", fontWeight: 600 },
  "& tr:nth-of-type(even)": { background: "var(--chakra-colors-gray-50)" },
} as const;

function AssistantMarkdownBubble({ content }: { content: string }) {
  return (
    <Box alignSelf="flex-start">
      <Box
        bg="gray.100"
        color="charcoal.500"
        px={4}
        py={3}
        borderRadius="xl"
        borderBottomLeftRadius="sm"
        maxW="100%"
        shadow="sm"
        css={assistantBubbleCss}
      >
        <Text fontFamily="body" fontSize="sm" as="div">
          <ReactMarkdown remarkPlugins={aideRemarkPlugins} components={aideMarkdownComponents}>
            {content}
          </ReactMarkdown>
        </Text>
      </Box>
    </Box>
  );
}

// ── Inner component (uses registry from context) ──────────────────────────────

export interface CurriculumAssistantProps {
  /**
   * Slim layout (no session sidebar) — the aide dock. In this mode the
   * assistant is SELF-CONTAINED: it tracks the active session in local state
   * instead of the `/teacher/chat/<chatId>` URL and never navigates, so it
   * stays put wherever the dock is open (Assignments, Curriculum landing,
   * Messages…). `onOpenAllChats` is the escape hatch to the full-screen chat
   * route.
   */
  compact?: boolean;
  /** When set, the slim dock renders a close affordance in its header. */
  onClose?: () => void;
  /**
   * Soft-navigate to the full-screen chat route (dock only) — behind the
   * header's labelled "All chats" link. The dock owns the mechanism (it also
   * closes itself), and receives the very `href` the anchor carries, so the
   * link and the click can't resolve to different places. The href deep-links
   * the dock's active thread when that thread is one the generic route can own
   * (never a unit-design thread) and carries the institution lens; see
   * `lib/teacherChat.ts`.
   */
  onOpenAllChats?: (href: string) => void;
  /**
   * EPHEMERAL "currently viewing" focus (dock only) — the scholar the teacher
   * is looking at right now. NOT bound to the thread: the same persistent dock
   * thread follows the teacher across scholars, and this only re-contextualizes
   * replies (sent per-request to /aide-stream). A fresh thread comes from "New
   * chat", never from navigating. Ignored when the thread is already scoped to
   * a specific scholar (a legacy scholar-bound session).
   */
  focusScholarId?: Id<"users"> | null;
  /**
   * Lifted dock thread id (FIX 3). The dock's active (global/scholar) session
   * lives in <AideDockProvider>, ABOVE the <AideDock> that unmounts on close /
   * on the Chat tab / on unit scope — so the one persistent thread survives
   * close→reopen, a Chat-tab roundtrip, and scholar→unit→scholar. When these
   * are omitted (the full Chat tab), the compact mode falls back to local
   * state. Ignored when not `compact`.
   */
  dockSessionId?: string | null;
  onDockSessionChange?: (id: string | null) => void;
  /**
   * One-shot PREFILL of the composer (FIX 5) — the Curriculum landing's "Ask
   * the bot to draft one" door seeds the describe-a-unit request here without
   * auto-sending. Consumed once (the teacher edits/confirms before sending).
   */
  pendingComposerSeed?: { text: string; nonce: number } | null;
  onConsumeComposerSeed?: () => void;
  /**
   * Practice-studio focus context (the Skills-tab dock). When present, the
   * currently-viewed practice domain / node is forwarded to the aide so it
   * knows what "this node" / "these" refers to without the teacher restating
   * it. Label-only (scholar-agnostic catalog data) — no learner records.
   * Ephemeral, like `focusScholarId`: sent per-message, never binds the thread.
   */
  practiceContext?: {
    domain?: string | null;
    domainLabel?: string | null;
    nodeKey?: string | null;
    nodeLabel?: string | null;
  } | null;
  /**
   * Unit-designer scope (the Curriculum Bot). When present, this same chat
   * body routes to the per-unit session list + the unit-designer Convex
   * functions (`sendUnitSessionMessage` → the `/aide-stream` `unitId` branch)
   * instead of the general-assistant path, and renders the unit-specific UX
   * (a "Designing unit …" note, the "Review this unit" quick-actions, the
   * test-drive 👍/👎 flag chips, and the pending-flag "tell the bot why"
   * prompt). Mutually exclusive with `focusScholarId` / `practiceContext`.
   */
  unitContext?: {
    unitId: Id<"units">;
    /** Soft outline-selection context forwarded to the bot (not a hard filter). */
    selectedLessonId?: Id<"lessons"> | null;
    selectedActivityId?: Id<"activities"> | null;
    /** Set when opened from a live test drive — the bot pulls that transcript. */
    testDriveProjectId?: Id<"sessions"> | null;
    /** Just-flagged tutor messages awaiting a "why" note from the teacher. */
    pendingFlags?: Array<{
      messageId: string;
      kind: "good" | "bad";
      snippet: string;
    }>;
    onAttachNoteToFlags?: (note: string) => void;
    onDismissPendingFlag?: (messageId: string) => void;
  } | null;
  /**
   * Imperative prompt push into the active UNIT thread (e.g. the activity
   * editor's "Generate slides" button, via `useAideDock().send()`). Consumed
   * once per nonce — auto-sends when it targets this unit. Only meaningful
   * alongside `unitContext`. Mirrors `pendingComposerSeed`, but SENDS instead
   * of prefilling.
   */
  pendingSend?: { prompt: string; nonce: number; unitId: Id<"units"> | null } | null;
  onConsumePendingSend?: () => void;
}

function CurriculumAssistantInner({
  compact = false,
  onClose,
  onOpenAllChats,
  focusScholarId = null,
  dockSessionId: controlledDockSessionId,
  onDockSessionChange,
  pendingComposerSeed = null,
  onConsumeComposerSeed,
  practiceContext,
  unitContext = null,
  pendingSend = null,
  onConsumePendingSend,
}: CurriculumAssistantProps) {
  const router = useRouter();
  const pathname = usePathname();
  // Unit-designer scope routes to the per-unit session list + unit-designer
  // Convex functions; everything below forks on this flag.
  const isUnit = !!unitContext;
  // The dock (compact) is self-contained: it owns the active session in state
  // (it has no URL to read and must not navigate away). That state is LIFTED to
  // <AideDockProvider> when the dock passes it in (so the thread survives the
  // dock unmounting); otherwise it falls back to local state. The full Chat tab
  // reads the active thread from its `/teacher/chat/<chatId>` path segment
  // (shareable / back-navigable).
  const [localDockSessionId, setLocalDockSessionId] = useState<string | null>(null);
  const dockControlled = onDockSessionChange !== undefined;
  const dockSessionId = dockControlled
    ? controlledDockSessionId ?? null
    : localDockSessionId;
  const setDockSessionId = onDockSessionChange ?? setLocalDockSessionId;
  const rawSession = compact ? dockSessionId : chatIdFromPathname(pathname);
  const sessionId = rawSession && rawSession.length > 0 ? (rawSession as Id<"chats">) : null;

  // The slim, no-sidebar layout — the aide dock (compact).
  const slim = compact;

  const { user } = useCurrentUser();
  // The active institution lens (?inst=). Sent to /aide-stream so the aide's
  // scholar universe (roster + named lookups) matches the Scholars roster
  // under the same lens. scopeParam is "" at home, "all", or an institution
  // slug — resolved + enforced server-side (never trusted as-is).
  const { scopeParam } = useActiveInstitution();
  // The dock header's "All chats" destination: this thread's own full-screen
  // URL while an ORDINARY thread is active (the context worth preserving — the
  // surface reads its active thread from that path segment), the bare thread
  // library otherwise. A unit-design thread is never deep-linked: the generic
  // route has no unitContext, so continuing it there would drop the unit
  // tools/prompt and the unitId attribution. Built once and used for BOTH the
  // anchor's href and the soft-nav push, so the two can never resolve
  // differently.
  const allChatsHref = teacherChatHref({
    sessionId,
    scopeParam,
    unitScoped: isUnit,
  });
  // Session list: per-unit in unit scope; otherwise this teacher's ordinary
  // threads (listSessions excludes unit-design chats — they belong to their
  // unit, which is the only place they can be continued).
  const generalSessions =
    useQuery(api.curriculumAssistant.listSessions, isUnit ? "skip" : {}) ?? [];
  const unitSessions =
    useQuery(
      api.curriculumAssistant.listSessionsForUnit,
      unitContext ? { unitId: unitContext.unitId } : "skip",
    ) ?? [];
  const sessions = isUnit ? unitSessions : generalSessions;
  const messagesResult = useQuery(
    api.curriculumAssistant.getChatMessages,
    sessionId ? { sessionId } : "skip"
  );
  const messages = useMemo(() => messagesResult ?? [], [messagesResult]);
  const googleStatus = useQuery(api.googleAccounts.status);
  const googleLinked = !!(
    googleStatus?.connected &&
    !needsGoogleReconsent(googleStatus, "drive")
  );

  // Unit title for the "Designing unit …" note + empty state (unit scope only).
  const unit = useQuery(
    api.units.get,
    unitContext ? { id: unitContext.unitId } : "skip",
  );
  const unitTitle = unit?.title ?? "this unit";

  const createChat = useMutation(api.curriculumAssistant.createChat);
  const createUnitSession = useMutation(api.curriculumAssistant.createUnitSession);
  const sendSessionMessage = useMutation(api.curriculumAssistant.sendSessionMessage);
  const sendUnitSessionMessage = useMutation(
    api.curriculumAssistant.sendUnitSessionMessage,
  );
  const markMessageStopped = useMutation(
    api.curriculumAssistant.markMessageStopped,
  );
  const generateUploadUrl = useMutation(api.curriculumAssistant.generateUploadUrl);
  const renameChat = useMutation(api.curriculumAssistant.renameChat);
  const togglePin = useMutation(api.curriculumAssistant.togglePin);
  const deleteSession = useMutation(api.curriculumAssistant.deleteSession);

  const [input, setInput] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // Files the teacher has attached (via the "+" button) but not yet sent.
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [pendingDriveAttachments, setPendingDriveAttachments] = useState<
    DriveAttachment[]
  >([]);
  const [driveConnectOpen, setDriveConnectOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Camera capture — the shared CameraCaptureDialog overlay routes its JPEG
  // through handleFilesSelected, exactly like a picked file.
  const [showCamera, setShowCamera] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The Drive picker stays mounted (so its Google scripts preload) but is
  // triggered from the "+" menu; renderTrigger stashes its open handler here.
  const drivePickerOpenRef = useRef<() => void>(() => {});

  // FIX 1 — pronoun anchoring on focus switch. Track the focus scholar used on
  // the LAST send of each dock thread; when a send's focus differs mid-thread,
  // tell the server (focusSwitched) to override the recent conversational
  // referent, and drop an EPHEMERAL in-thread "Now viewing <Name>" divider at
  // the switch point (client-state only — fine that it disappears on reload).
  const lastSendFocusRef = useRef<Record<string, string | null>>({});
  const [switchDividers, setSwitchDividers] = useState<
    Record<string, Array<{ index: number; scholarId: string | null; name: string }>>
  >({});

  const { startStream, stopStream, getStreamState, streamingSessionIds } = useStreamRegistry();

  // Per-session stream state for the currently-viewed session
  const currentStreamState = getStreamState(sessionId ? String(sessionId) : "");
  const { isStreaming, streamingContent, streamingMsgId, toolActivity, thinkingActivity, isThinking } = currentStreamState;

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const activeSession = sessions.find((s) => String(s._id) === rawSession) ?? null;
  const scopedScholar = useQuery(
    api.scholars.getProfile,
    activeSession?.scholarId ? { scholarId: activeSession.scholarId } : "skip"
  );
  const scholarName = scopedScholar?.scholar?.name ?? null;

  // Ephemeral "currently viewing" focus (dock) — resolve its name for the
  // placeholder + the in-thread scope note. Only relevant when the thread
  // isn't already bound to a scholar (scholarName). See the prop doc.
  const focusScholarProfile = useQuery(
    api.scholars.getProfile,
    focusScholarId && !activeSession?.scholarId ? { scholarId: focusScholarId } : "skip"
  );
  const focusScholarName = focusScholarProfile?.scholar?.name ?? null;
  // The scholar this thread is effectively about right now: a bound scholar
  // wins (legacy scoped session), else the ephemeral focus.
  const contextScholarName = scholarName ?? focusScholarName;

  const pinnedSessions = sessions.filter((s) => s.pinned);
  const recentSessions = sessions.filter((s) => !s.pinned);

  // A session shows the in-progress dot if it's streaming in this tab (client registry)
  // OR if the DB shows an active streamId (covers other tabs / page reload edge cases)
  const isSessionStreaming = useCallback(
    (sid: string, dbActiveStreamId?: string) => {
      return streamingSessionIds.includes(sid) || !!dbActiveStreamId;
    },
    [streamingSessionIds]
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [input]);

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  // Auto-focus textarea when switching to a session
  useEffect(() => {
    if (sessionId) {
      textareaRef.current?.focus();
    }
  }, [sessionId]);

  // Unit scope defaults to the most-recent unit session (mirrors the old
  // UnitChat) so the designer lands on the latest thread rather than a blank
  // "no thread" state. General/scholar scope deliberately starts empty (a
  // fresh "Ask me anything") — so this is unit-only.
  useEffect(() => {
    if (!isUnit) return;
    if (dockSessionId) return;
    if (sessions.length === 0) return;
    setDockSessionId(String(sessions[0]._id));
  }, [isUnit, dockSessionId, sessions, setDockSessionId]);

  // FIX 5 — consume a one-shot composer seed (the Curriculum landing's "Ask the
  // bot to draft one" door): prefill the composer + focus it, but do NOT send.
  const seedNonce = pendingComposerSeed?.nonce;
  useEffect(() => {
    if (!pendingComposerSeed) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- consumes a nonce-keyed one-shot composer command into the local input.
    setInput(pendingComposerSeed.text);
    onConsumeComposerSeed?.();
    // Focus after the value is staged so the caret lands at the end.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by nonce
  }, [seedNonce]);

  // Switch the active session. The dock (compact) keeps it local; the full
  // Chat tab writes the URL so the thread is shareable / back-navigable.
  const goToSession = useCallback(
    (id: string | null) => {
      if (compact) {
        setDockSessionId(id);
        return;
      }
      if (id) {
        router.push(`/teacher/chat/${id}`, { scroll: false });
      }
    },
    [compact, router, setDockSessionId],
  );

  const handleNewChat = useCallback(async () => {
    const newSessionId = unitContext
      ? await createUnitSession({ unitId: unitContext.unitId })
      : await createChat({});
    goToSession(String(newSessionId));
  }, [unitContext, createUnitSession, createChat, goToSession]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    // Allow an attachment-only turn (e.g. "here's the file") — send if there's
    // text OR at least one attached file. Block if THIS session is streaming.
    if (
      (!text &&
        pendingAttachments.length === 0 &&
        pendingDriveAttachments.length === 0) ||
      isStreaming ||
      !user
    )
      return;

    setInput("");
    const attachments = pendingAttachments;
    const driveAttachments = pendingDriveAttachments;
    setPendingAttachments([]);
    setPendingDriveAttachments([]);

    let activeSessionId = sessionId;
    const isNewThread = !activeSessionId;
    if (!activeSessionId) {
      const newId = await createChat({});
      goToSession(String(newId));
      activeSessionId = newId as Id<"chats">;
    }
    const sessionKey = String(activeSessionId);

    // FIX 1 — did the focus scholar change since this thread's last send? The
    // effective focus is null when the thread is bound to a scholar (then the
    // ephemeral focus is ignored) or when we're global (no scholar in view).
    const effectiveFocus =
      focusScholarId && !activeSession?.scholarId ? String(focusScholarId) : null;
    const prevFocus = lastSendFocusRef.current[sessionKey];
    // A mid-thread switch worth reaffirming: an existing thread whose new focus
    // is a real scholar AND differs from the prior send's focus. Drives the
    // SERVER override (focusSwitched) so pronouns re-anchor to the new scholar.
    // (Switches to "no scholar" don't get a divider.)
    const focusSwitched =
      !isNewThread &&
      effectiveFocus !== null &&
      prevFocus !== undefined &&
      prevFocus !== effectiveFocus;
    // The thread's FIRST message, sent while viewing a scholar, also earns a
    // divider — start-of-thread counts as a focus change (a global start does
    // not). "First message" = an empty thread (messages.length === 0), which
    // covers BOTH a brand-new thread created on send AND one pre-created by
    // "New chat" (where sessionId is already set, so isNewThread is false). No
    // server override there: with no prior turns there's no referent to
    // correct, so the normal focusScholarId injection is enough. (We only drop
    // it for a genuinely empty thread — never before a new message in an
    // already-populated thread whose earlier focus we can't know, e.g. after a
    // reload — to avoid a misleading mid-thread divider.)
    const initialFocus =
      messages.length === 0 && prevFocus === undefined && effectiveFocus !== null;
    lastSendFocusRef.current[sessionKey] = effectiveFocus;
    if (focusSwitched || initialFocus) {
      // Snapshot the name for the divider, but ALSO store the scholarId so the
      // renderer can resolve the live name if the profile query hadn't resolved
      // yet at send time (else the divider would freeze as "this scholar").
      const name = focusScholarName ?? "this scholar";
      // The new user message lands at the current end of the loaded list
      // (index 0 for a fresh thread).
      const atIndex = messages.length;
      setSwitchDividers((prev) => ({
        ...prev,
        [sessionKey]: [
          ...(prev[sessionKey] ?? []),
          { index: atIndex, scholarId: effectiveFocus, name },
        ],
      }));
    }

    try {
      const result = await sendSessionMessage({
        sessionId: activeSessionId,
        message: text,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(driveAttachments.length > 0 ? { driveAttachments } : {}),
      });

      const convexUrl = convexSiteUrl();
      await startStream(
        String(activeSessionId),
        `${convexUrl}/aide-stream`,
        {
          teacherId: String(user._id),
          streamId: result.streamId,
          assistantMsgId: result.assistantMsgId,
          sessionId: String(activeSessionId),
          // Active institution lens — scopes the aide's scholar universe.
          scope: scopeParam,
          // Ephemeral "currently viewing" focus — re-contextualizes replies to
          // the scholar the teacher is looking at, without binding the thread.
          // Only sent when the thread isn't already scoped to a scholar.
          ...(effectiveFocus ? { focusScholarId: effectiveFocus } : {}),
          // The teacher switched scholars mid-thread — override the recent
          // conversational referent server-side (FIX 1).
          ...(focusSwitched ? { focusSwitched: true } : {}),
          // Practice-studio focus (Skills-tab dock) — which domain/node the
          // teacher is currently viewing, so the aide can resolve "this node".
          ...(practiceContext && (practiceContext.domain || practiceContext.nodeKey)
            ? { practiceContext }
            : {}),
        },
        result.assistantMsgId,
      );
    } catch (error) {
      console.error("Error sending message:", error);
      // Put the attachments back so the teacher can retry rather than lose them.
      setPendingAttachments((prev) => [...attachments, ...prev]);
      setPendingDriveAttachments((prev) => [...driveAttachments, ...prev]);
    }
  }, [input, pendingAttachments, pendingDriveAttachments, isStreaming, user, sessionId, createChat, goToSession, sendSessionMessage, startStream, scopeParam, focusScholarId, activeSession?.scholarId, focusScholarName, messages.length, practiceContext]);

  // ── Unit-designer scope send path ──────────────────────────────────────
  // Routes to sendUnitSessionMessage → the /aide-stream `unitId` branch
  // (unit-designer prompt + tools + test-drive context), carrying the outline
  // selection, any test-drive project, and the teacher's 👍/👎 flag snapshots.
  const sendUnit = useCallback(
    async (
      rawText: string,
      attachments: ChatAttachment[],
      driveAttachments: DriveAttachment[] = [],
    ) => {
      const text = rawText.trim();
      if (
        (!text && attachments.length === 0 && driveAttachments.length === 0) ||
        isStreaming ||
        !user ||
        !unitContext
      )
        return;

      let activeSessionId = sessionId;
      if (!activeSessionId) {
        const newId = await createUnitSession({ unitId: unitContext.unitId });
        goToSession(String(newId));
        activeSessionId = newId as Id<"chats">;
      }

      // Snapshot the pending flags onto this user turn, and hand the typed note
      // back to the caller so it lands on every flag in the stack.
      const pending = unitContext.pendingFlags ?? [];
      const flagSnapshots = pending.map((f) => ({ kind: f.kind, snippet: f.snippet }));
      if (pending.length > 0) unitContext.onAttachNoteToFlags?.(text);

      try {
        const result = await sendUnitSessionMessage({
          sessionId: activeSessionId,
          unitId: unitContext.unitId,
          message: text,
          ...(flagSnapshots.length > 0 ? { flagSnapshots } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(driveAttachments.length > 0 ? { driveAttachments } : {}),
        });

        const convexUrl = convexSiteUrl();
        await startStream(
          String(activeSessionId),
          `${convexUrl}/aide-stream`,
          {
            // No teacherId — /aide-stream authenticates the caller from the
            // session token and ignores any body-supplied id.
            unitId: String(unitContext.unitId),
            sessionId: String(activeSessionId),
            streamId: result.streamId,
            assistantMsgId: result.assistantMsgId,
            selectedLessonId: unitContext.selectedLessonId
              ? String(unitContext.selectedLessonId)
              : null,
            selectedActivityId: unitContext.selectedActivityId
              ? String(unitContext.selectedActivityId)
              : null,
            testDriveProjectId: unitContext.testDriveProjectId
              ? String(unitContext.testDriveProjectId)
              : null,
          },
          result.assistantMsgId,
        );
      } catch (error) {
        console.error("Error sending message:", error);
        setPendingAttachments((prev) => [...attachments, ...prev]);
        setPendingDriveAttachments((prev) => [...driveAttachments, ...prev]);
      }
    },
    [
      isStreaming,
      user,
      unitContext,
      sessionId,
      createUnitSession,
      goToSession,
      sendUnitSessionMessage,
      startStream,
    ],
  );

  // Compose + send from the input box (unit scope).
  const handleSendUnit = useCallback(async () => {
    const text = input.trim();
    if (
      !text &&
      pendingAttachments.length === 0 &&
      pendingDriveAttachments.length === 0
    )
      return;
    setInput("");
    const attachments = pendingAttachments;
    const driveAttachments = pendingDriveAttachments;
    setPendingAttachments([]);
    setPendingDriveAttachments([]);
    await sendUnit(text, attachments, driveAttachments);
  }, [input, pendingAttachments, pendingDriveAttachments, sendUnit]);

  // Stop the active stream (unit scope) — abort the client read AND mark the
  // half-written assistant message stopped server-side (mirrors old UnitChat).
  const handleStopUnit = useCallback(async () => {
    if (!isStreaming || !sessionId) return;
    const stoppedMsgId = streamingMsgId;
    stopStream(String(sessionId));
    if (stoppedMsgId) {
      try {
        await markMessageStopped({
          messageId: stoppedMsgId as Id<"curriculumMessages">,
        });
      } catch (err) {
        console.error("Failed to mark message stopped:", err);
      }
    }
  }, [isStreaming, sessionId, streamingMsgId, stopStream, markMessageStopped]);

  // Imperative auto-send (unit scope) — the activity editor's "Generate slides"
  // button pushes a prompt via useAideDock().send(); consume it once per nonce,
  // and only when it targets THIS unit (guards a cross-unit misfire).
  const pendingSendNonce = pendingSend?.nonce;
  useEffect(() => {
    if (!pendingSend || !unitContext) return;
    const targetsThisUnit =
      pendingSend.unitId !== null &&
      String(pendingSend.unitId) === String(unitContext.unitId);
    if (targetsThisUnit) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- dispatches a nonce-keyed pending send once into its matching unit chat.
      void sendUnit(pendingSend.prompt, [], []);
    }
    // Consume regardless — a send that no longer targets this unit must drop,
    // not fire later into the wrong unit's chat.
    onConsumePendingSend?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by nonce
  }, [pendingSendNonce]);

  // Upload picked files to Convex storage, then stage them on the next message.
  // Accepts a FileList (from the hidden <input>) or a File[] (e.g. a captured
  // photo) — Array.from handles both.
  const handleFilesSelected = useCallback(
    async (files: FileList | File[] | null) => {
      if (!files || files.length === 0) return;
      setUploading(true);
      try {
        const failedFiles: string[] = [];
        for (const file of Array.from(files)) {
          if (file.size > MESSAGE_ATTACHMENT_MAX_BYTES) {
            failedFiles.push(file.name);
            continue;
          }
          try {
            const attachment = await uploadMessageAttachment<Id<"_storage">>(
              file,
              generateUploadUrl,
            );
            setPendingAttachments((prev) => [
              ...prev,
              attachment,
            ]);
          } catch (error) {
            console.error(`Failed to upload ${file.name}:`, error);
            failedFiles.push(file.name);
          }
        }
        if (failedFiles.length > 0) {
          toaster.error({
            title:
              failedFiles.length === 1
                ? `Couldn't attach ${failedFiles[0]}`
                : `${failedFiles.length} files couldn't be attached`,
            description: "Try those files again.",
          });
        }
      } finally {
        setUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [generateUploadUrl],
  );

  const removePendingAttachment = useCallback((storageId: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.storageId !== storageId));
  }, []);

  const removePendingDriveAttachment = useCallback((driveFileId: string) => {
    setPendingDriveAttachments((prev) =>
      prev.filter((a) => a.driveFileId !== driveFileId),
    );
  }, []);

  const handleDrivePicked = useCallback(
    (doc: { id: string; name?: string; url?: string; mimeType?: string }) => {
      setPendingDriveAttachments((prev) => [
        ...prev,
        {
          driveFileId: doc.id,
          url: doc.url ?? "",
          name: doc.name ?? "Drive file",
          mimeType:
            doc.mimeType ?? "application/vnd.google-apps.document",
        },
      ]);
    },
    [],
  );

  // The active composer submit — unit scope routes to the unit-designer path.
  const submit = isUnit ? handleSendUnit : handleSend;
  const allowUploads = true;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const startRename = (s: { _id: Id<"chats">; title: string }) => {
    setRenamingId(String(s._id));
    setRenameValue(s.title);
  };

  const commitRename = async () => {
    if (!renamingId || !renameValue.trim()) { setRenamingId(null); return; }
    await renameChat({ sessionId: renamingId as Id<"chats">, title: renameValue.trim() });
    setRenamingId(null);
  };

  const selectSession = (id: string, e?: React.MouseEvent) => {
    // cmd/middle-click opens the thread in a standalone tab.
    if (e && (e.metaKey || e.ctrlKey || e.button === 1)) {
      e.preventDefault();
      openExternal(`/teacher/chat/${id}`);
      return;
    }
    goToSession(id);
  };

  const introHeadingText = isUnit
    ? `Design \u201C${unitTitle}\u201D`
    : contextScholarName
    ? `Ask me about ${contextScholarName} — or anything else`
    : "Ask me anything — or select a past chat";
  const introBodyText = isUnit
    ? "Describe lessons you want, and I\u2019ll create them with appropriate processes, Bloom\u2019s levels, and prompts."
    : contextScholarName
    ? `You're viewing ${contextScholarName}. I can pull up their profile, mastery, and learning signals, suggest directives or seeds, or help with curriculum — and I'll follow along as you move between scholars.`
    : "I can look up student profiles, mastery data, learning signals, and help you design or adapt units.";
  const placeholderText = isUnit
    ? "Describe lessons, ask for prompts..."
    : contextScholarName
    ? `Ask about ${contextScholarName} — directives, seeds, next steps…`
    : "Ask about scholars, mastery data, or curriculum design...";
  const pendingFlags = unitContext?.pendingFlags ?? [];

  // Ephemeral "Now viewing <Name>" dividers for the active thread (FIX 1).
  const activeDividers = sessionId
    ? switchDividers[String(sessionId)] ?? []
    : [];

  // Unit-scope quick-actions ("Review this unit" etc.) — discoverable starting
  // points shown in the empty state, firing the exact canonical prompt.
  const unitSuggestionChips =
    isUnit && UNIT_BOT_SUGGESTIONS.length > 0 ? (
      <Flex gap={2} wrap="wrap" justify="center" pt={1}>
        {UNIT_BOT_SUGGESTIONS.map((s) => (
          <Button
            key={s.id}
            size="xs"
            fontFamily="heading"
            variant="outline"
            borderColor="violet.200"
            color="violet.600"
            _hover={{ bg: "violet.50", borderColor: "violet.300" }}
            onClick={() => sendUnit(s.prompt, [], [])}
            disabled={isStreaming}
          >
            <Robot size={13} weight="duotone" style={{ marginRight: 5 }} />
            {s.label}
          </Button>
        ))}
      </Flex>
    ) : null;

  return (
    <Flex flex={1} direction="row" overflow="hidden">
      {/* ── Sidebar (hidden in the slim dock layout) ── */}
      {!slim && (
      <Flex
        direction="column"
        w="280px"
        minW="280px"
        borderRight="1px solid"
        borderColor="gray.200"
        bg="white"
        overflow="hidden"
      >
        <Box p={3}>
          <Button
            size="sm"
            w="full"
            bg="violet.500"
            color="white"
            fontFamily="heading"
            fontWeight="600"
            _hover={{ bg: "violet.600" }}
            onClick={handleNewChat}
          >
            <Plus style={{ marginRight: "6px" }} />
            New Chat
          </Button>
        </Box>

        <Box flex={1} overflowY="auto" px={2} pb={2}>
          {sessions.length === 0 && (
            <Text fontFamily="body" fontSize="xs" color="charcoal.300" px={2} py={4} textAlign="center">
              No chats yet
            </Text>
          )}

          {pinnedSessions.length > 0 && (
            <>
              <Text fontFamily="heading" fontSize="2xs" fontWeight="700" color="charcoal.400" px={2} pt={2} pb={1} textTransform="uppercase" letterSpacing="0.05em">
                Pinned
              </Text>
              {pinnedSessions.map((s) => (
                <SessionRow
                  key={String(s._id)}
                  session={s}
                  isActive={String(s._id) === rawSession}
                  isStreaming={isSessionStreaming(String(s._id), s.activeStreamId)}
                  isRenaming={renamingId === String(s._id)}
                  renameValue={renameValue}
                  renameInputRef={renameInputRef}
                  onSelect={(e) => selectSession(String(s._id), e)}
                  onStartRename={() => startRename(s)}
                  onRenameChange={setRenameValue}
                  onRenameCommit={commitRename}
                  onRenameKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setRenamingId(null); }}
                  onTogglePin={() => togglePin({ sessionId: s._id })}
                  onDelete={() => deleteSession({ sessionId: s._id })}
                />
              ))}
            </>
          )}

          {recentSessions.length > 0 && (
            <>
              {pinnedSessions.length > 0 && (
                <Text fontFamily="heading" fontSize="2xs" fontWeight="700" color="charcoal.400" px={2} pt={3} pb={1} textTransform="uppercase" letterSpacing="0.05em">
                  Recent
                </Text>
              )}
              {recentSessions.map((s) => (
                <SessionRow
                  key={String(s._id)}
                  session={s}
                  isActive={String(s._id) === rawSession}
                  isStreaming={isSessionStreaming(String(s._id), s.activeStreamId)}
                  isRenaming={renamingId === String(s._id)}
                  renameValue={renameValue}
                  renameInputRef={renameInputRef}
                  onSelect={(e) => selectSession(String(s._id), e)}
                  onStartRename={() => startRename(s)}
                  onRenameChange={setRenameValue}
                  onRenameCommit={commitRename}
                  onRenameKeyDown={(e) => { if (e.key === "Enter") commitRename(); if (e.key === "Escape") setRenamingId(null); }}
                  onTogglePin={() => togglePin({ sessionId: s._id })}
                  onDelete={() => deleteSession({ sessionId: s._id })}
                />
              ))}
            </>
          )}
        </Box>
      </Flex>
      )}

      {/* ── Main panel ── */}
      <Flex flex={1} direction="column" overflow="hidden" bg="white" minW={0}>
        {/* The slim dock layout has no sidebar, so it gets a slim
            bar with a New-chat affordance + the streaming/scope indicators. */}
        {slim && (
          <Box borderBottom="1px solid" borderColor="gray.200" bg="white">
            <Flex px={3} pt={2} pb={1} align="center" gap={2}>
              <Box flex={1} minW={0}>
                <Text fontFamily="heading" fontWeight="600" fontSize="sm" color="navy.500" overflow="hidden" style={{ whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                  {activeSession?.title ?? "Chat"}
                </Text>
              </Box>
              {activeSession?.source === "slack" && <SlackBadge />}
              {isStreaming && (
                <Badge bg="violet.50" color="violet.600" fontFamily="heading" fontSize="2xs" px={2} py={0.5} borderRadius="md" display="flex" alignItems="center" gap={1}>
                  <StreamingDot />
                  {isThinking ? "Thinking deeply…" : "Thinking…"}
                </Badge>
              )}
              {isUnit && isStreaming && (
                <Button
                  size="xs"
                  variant="ghost"
                  fontFamily="heading"
                  color="charcoal.400"
                  _hover={{ color: "red.500", bg: "red.50" }}
                  onClick={handleStopUnit}
                  flexShrink={0}
                >
                  <Stop size={12} weight="fill" style={{ marginRight: 4 }} />
                  Stop
                </Button>
              )}
              {/* No scope chip in the docked aide — the thread's own empty state
                  / composer placeholder affirm scope. The chip stays in the
                  full Chat tab's non-slim header (the library view, where a
                  thread can be out-of-context). */}
              <AideModelPicker />
              {onOpenAllChats && (
                // "All chats" — the dock's door to the full-screen chat route
                // (an ordinary active thread's own URL, otherwise — and always
                // in unit scope — the thread library), institution lens intact.
                // Labelled rather than an expand glyph: it is a destination,
                // and a tooltip is not an affordance. A REAL link, so
                // cmd/ctrl/middle-click opens it in a new tab and right-click
                // copies the URL; a plain left-click is the primary interaction
                // and soft-navigates via the dock (which also closes the
                // now-redundant dock).
                <Button
                  asChild
                  size="sm"
                  px={2}
                  variant="ghost"
                  fontFamily="heading"
                  fontWeight="600"
                  fontSize="xs"
                  color="charcoal.500"
                  _hover={{ color: "violet.500", bg: "violet.50" }}
                  flexShrink={0}
                  whiteSpace="nowrap"
                >
                  <NextLink
                    href={allChatsHref}
                    onClick={(e) => {
                      if (
                        e.metaKey ||
                        e.ctrlKey ||
                        e.shiftKey ||
                        e.altKey ||
                        e.button !== 0
                      ) {
                        return;
                      }
                      e.preventDefault();
                      onOpenAllChats(allChatsHref);
                    }}
                  >
                    All chats
                  </NextLink>
                </Button>
              )}
              <Tooltip.Root openDelay={400} closeDelay={0}>
                <Tooltip.Trigger asChild>
                  <IconButton
                    aria-label="New chat"
                    size="sm"
                    variant="ghost"
                    color="charcoal.500"
                    _hover={{ color: "violet.500", bg: "violet.50" }}
                    onClick={handleNewChat}
                  >
                    <Plus size={16} />
                  </IconButton>
                </Tooltip.Trigger>
                <Portal>
                  <Tooltip.Positioner>
                    <Tooltip.Content fontFamily="heading" fontSize="xs">
                      New chat
                    </Tooltip.Content>
                  </Tooltip.Positioner>
                </Portal>
              </Tooltip.Root>
              {onClose && (
                <IconButton
                  aria-label="Close chat"
                  title="Close"
                  size="xs"
                  variant="ghost"
                  color="charcoal.400"
                  _hover={{ bg: "gray.100" }}
                  onClick={onClose}
                >
                  <X size={15} />
                </IconButton>
              )}
            </Flex>
            {/* Subtle scope affirmation (replaces the ScopeChip): the docked
                chat follows what the teacher is viewing, so name the scholar
                it's currently about — but only when the thread isn't itself
                bound to a scholar (then the title already carries that). It
                gets its OWN full-width row (below the title/actions) so the
                whole "Viewing <Name>" shows instead of truncating to "Viewi…"
                when the action buttons crowd the top row. The row is ALWAYS
                mounted (a non-breaking space when there's no focus scholar) so
                navigating scholar↔global never changes the header height / jumps
                the thread; the reserved-empty state reads as header padding. */}
            <Box px={3} pb={2}>
              {(() => {
                // Unit scope: a steady "Designing <unit>" affirmation. Otherwise
                // the ephemeral "Viewing <scholar>" focus hint (or a reserved
                // blank row so the header height never jumps scholar↔global).
                if (isUnit) {
                  return (
                    <Text
                      fontFamily="heading"
                      fontSize="2xs"
                      color="violet.500"
                      overflow="hidden"
                      style={{ whiteSpace: "nowrap", textOverflow: "ellipsis" }}
                    >
                      Designing &ldquo;{unitTitle}&rdquo;
                    </Text>
                  );
                }
                const showViewing = !!contextScholarName && !activeSession?.scholarId;
                return (
                  <Text
                    fontFamily="heading"
                    fontSize="2xs"
                    color="violet.500"
                    overflow="hidden"
                    aria-hidden={!showViewing}
                    style={{ whiteSpace: "nowrap", textOverflow: "ellipsis" }}
                  >
                    {showViewing ? `Viewing ${contextScholarName}` : "\u00A0"}
                  </Text>
                );
              })()}
            </Box>
          </Box>
        )}
        {!slim && sessionId && (
          <Flex px={6} py={3} borderBottom="1px solid" borderColor="gray.200" align="center" gap={3} bg="white">
            <Text fontFamily="heading" fontWeight="600" fontSize="md" color="navy.500" flex={1} overflow="hidden" style={{ whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
              {activeSession?.title ?? "Chat"}
            </Text>
            {activeSession?.source === "slack" && <SlackBadge />}
            {isStreaming && (
              <Badge bg="violet.50" color="violet.600" fontFamily="heading" fontSize="2xs" px={2} py={0.5} borderRadius="md" display="flex" alignItems="center" gap={1}>
                <StreamingDot />
                {isThinking ? "Thinking deeply…" : "Thinking…"}
              </Badge>
            )}
            <ScopeChip
              scholarId={activeSession?.scholarId}
              unitId={activeSession?.unitId}
              chatId={activeSession?._id}
            />
            <AideModelPicker />
          </Flex>
        )}

        {!sessionId ? (
          <Flex flex={1} align="center" justify="center" px={6}>
            {isUnit ? (
              <VStack gap={3} color="charcoal.300" maxW="md" textAlign="center">
                <Robot size={48} weight="duotone" />
                <Text fontFamily="heading" fontSize="md" color="charcoal.400">
                  {introHeadingText}
                </Text>
                <Text fontFamily="body" fontSize="sm" color="charcoal.300">
                  {introBodyText}
                </Text>
                {unitSuggestionChips}
              </VStack>
            ) : (
              <EmptyState
                size="lg"
                icon={<Robot weight="duotone" />}
                title={introHeadingText}
                hint={introBodyText}
              />
            )}
          </Flex>
        ) : (
          <Box flex={1} overflowY="auto" px={6} py={4}>
            <VStack gap={4} maxW="3xl" mx="auto" align="stretch">
              {messages.length === 0 && !streamingContent && (
                <VStack py={12} gap={3} color="charcoal.300">
                  <Robot size={48} weight="duotone" />
                  {isUnit ? (
                    <>
                      <Text fontFamily="heading" fontSize="md" textAlign="center">{introHeadingText}</Text>
                      <Text fontFamily="body" fontSize="sm" color="charcoal.300" textAlign="center" maxW="md">
                        {introBodyText}
                      </Text>
                      {unitSuggestionChips}
                    </>
                  ) : scholarName ? (
                    <>
                      <Text fontFamily="heading" fontSize="md" color="violet.700">
                        No messages yet in this thread.
                      </Text>
                      <Text fontFamily="body" fontSize="sm" color="charcoal.400" textAlign="center" maxW="md">
                        Ask about {scholarName}&rsquo;s dossier, directives, recent sessions, or what to plan next.
                      </Text>
                    </>
                  ) : (
                    <>
                      <Text fontFamily="heading" fontSize="md" textAlign="center">{introHeadingText}</Text>
                      <Text fontFamily="body" fontSize="sm" color="charcoal.300" textAlign="center" maxW="md">
                        {introBodyText}
                      </Text>
                    </>
                  )}
                </VStack>
              )}

              {messages
                .map((m, idx) => {
                  // Skip the live-streaming assistant turn (rendered separately
                  // below) but keep its index so the divider markers — computed
                  // from messages.length at send time — still align.
                  if (streamingMsgId && String(m._id) === streamingMsgId) {
                    return null;
                  }
                  const divider = activeDividers.find((d) => d.index === idx);
                  // Resolve the divider's name LIVE: if it names the scholar
                  // currently in focus and the profile query has since resolved,
                  // prefer that (fixes the case where the send fired before
                  // focusScholarProfile loaded and froze "this scholar"); else
                  // fall back to the name snapshotted at send time.
                  const dividerName =
                    divider &&
                    divider.scholarId &&
                    divider.scholarId === (focusScholarId ? String(focusScholarId) : null) &&
                    focusScholarName
                      ? focusScholarName
                      : divider?.name;
                  const dividerEl = divider ? (
                    <Flex
                      key={`divider-${idx}`}
                      align="center"
                      gap={2}
                      my={1}
                      color="charcoal.300"
                    >
                      <Box flex={1} h="1px" bg="gray.200" />
                      <Text
                        fontFamily="heading"
                        fontSize="2xs"
                        fontWeight="600"
                        color="charcoal.400"
                        whiteSpace="nowrap"
                      >
                        Now viewing {dividerName}
                      </Text>
                      <Box flex={1} h="1px" bg="gray.200" />
                    </Flex>
                  ) : null;

                  if (m.role === "user") {
                    return (
                      <Fragment key={String(m._id)}>
                        {dividerEl}
                        <Box alignSelf="flex-end" maxW="100%">
                        {m.speakerName && (
                          <Text
                            fontSize="xs"
                            fontWeight="600"
                            fontFamily="heading"
                            color="charcoal.400"
                            mb={1}
                            textAlign="right"
                          >
                            {m.speakerName}
                          </Text>
                        )}
                        {isUnit && (m.flagSnapshots?.length ?? 0) > 0 && (
                          <VStack mb={1} gap={1} align="stretch">
                            {m.flagSnapshots!.map((snap, i) => (
                              <Flex
                                key={`${m._id}-flag-${i}`}
                                px={2}
                                py={1}
                                align="center"
                                gap={1.5}
                                borderRadius="md"
                                bg={snap.kind === "good" ? "cyan.50" : "red.50"}
                                border="1px solid"
                                borderColor={snap.kind === "good" ? "cyan.200" : "red.200"}
                              >
                                <Box
                                  flexShrink={0}
                                  color={snap.kind === "good" ? "cyan.600" : "red.500"}
                                  display="flex"
                                  alignItems="center"
                                >
                                  {snap.kind === "good" ? (
                                    <ThumbsUp size={12} weight="fill" />
                                  ) : (
                                    <ThumbsDown size={12} weight="fill" />
                                  )}
                                </Box>
                                <Text fontSize="2xs" fontFamily="body" color="charcoal.500" truncate css={{ fontStyle: "italic" }}>
                                  &ldquo;{snap.snippet}
                                  {snap.snippet.length >= MAX_FLAG_SNIPPET_LEN ? "…" : ""}
                                  &rdquo;
                                </Text>
                              </Flex>
                            ))}
                          </VStack>
                        )}
                        <Box bg="navy.500" color="white" px={4} py={3} borderRadius="xl" borderBottomRightRadius="sm" maxW="100%" shadow="sm">
                          {m.content && (
                            <Text fontFamily="body" fontSize="sm" whiteSpace="pre-wrap">{m.content}</Text>
                          )}
                          {m.attachments && m.attachments.length > 0 && (
                            <Flex mt={m.content ? 2 : 0} gap={1.5} wrap="wrap">
                              {m.attachments.map((a) => (
                                <Flex
                                  key={a.storageId}
                                  align="center"
                                  gap={1}
                                  bg="whiteAlpha.300"
                                  borderRadius="md"
                                  px={2}
                                  py={1}
                                  maxW="200px"
                                >
                                  <Paperclip size={12} weight="bold" />
                                  <Text fontSize="xs" lineClamp={1} title={a.fileName}>
                                    {a.fileName}
                                  </Text>
                                </Flex>
                              ))}
                            </Flex>
                          )}
                          {m.driveAttachments && m.driveAttachments.length > 0 && (
                            <Flex
                              mt={
                                m.content ||
                                (m.attachments && m.attachments.length > 0)
                                  ? 2
                                  : 0
                              }
                              gap={1.5}
                              wrap="wrap"
                            >
                              {m.driveAttachments.map((a, i) => (
                                <Flex
                                  key={`${a.driveFileId}-${i}`}
                                  align="center"
                                  gap={1}
                                  bg="whiteAlpha.300"
                                  borderRadius="md"
                                  px={2}
                                  py={1}
                                  maxW="220px"
                                >
                                  {a.thumbnailUrl ? (
                                    // eslint-disable-next-line @next/next/no-img-element -- Google Drive thumbnail URL cannot use the Next image proxy
                                    <img
                                      src={a.thumbnailUrl}
                                      alt=""
                                      style={{
                                        width: 16,
                                        height: 16,
                                        objectFit: "cover",
                                        borderRadius: 3,
                                        flexShrink: 0,
                                      }}
                                    />
                                  ) : (
                                    <GoogleDriveLogoIcon size={12} weight="bold" />
                                  )}
                                  <Text fontSize="xs" lineClamp={1} title={a.name}>
                                    {a.name}
                                  </Text>
                                </Flex>
                              ))}
                            </Flex>
                          )}
                        </Box>
                        </Box>
                      </Fragment>
                    );
                  }

                  return (
                    <Fragment key={String(m._id)}>
                      {dividerEl}
                      <AssistantMarkdownBubble content={m.content} />
                    </Fragment>
                  );
                })}

              {/* Live streaming turn — text + tool calls interleaved inline
                  (tools render where the model fired them, not in a log below). */}
              {isStreaming &&
                (streamingContent || toolActivity.length > 0 || thinkingActivity.length > 0) && (
                <StreamingTurn
                  content={streamingContent}
                  toolActivity={toolActivity}
                  thinkingActivity={thinkingActivity}
                  isStreaming={isStreaming}
                  renderText={(text) => <AssistantMarkdownBubble content={text} />}
                />
              )}
              {isStreaming &&
                !streamingContent &&
                toolActivity.length === 0 &&
                thinkingActivity.length === 0 && (
                <Box alignSelf="flex-start" bg="gray.100" px={4} py={3} borderRadius="xl" borderBottomLeftRadius="sm">
                  <Spinner size="sm" color="violet.500" />
                </Box>
              )}
              <div ref={messagesEndRef} />
            </VStack>
          </Box>
        )}

        {/* Input — disabled only when this session is streaming (not globally) */}
        <Box px={4} py={3} borderTop="1px solid" borderColor="gray.200" bg="gray.50">
          {/* Unit scope: pending 👍/👎 flags awaiting a "why" note before the
              next send (ported from the retired UnitChat). */}
          {isUnit && pendingFlags.length > 0 && (
            <VStack maxW="3xl" mx="auto" mb={2} gap={1} align="stretch">
              {pendingFlags.length > 1 && (
                <Text fontSize="2xs" fontFamily="heading" color="charcoal.400" px={1}>
                  tell the bot why ({pendingFlags.length} flagged)
                </Text>
              )}
              {pendingFlags.map((pf) => (
                <Flex
                  key={pf.messageId}
                  px={2.5}
                  py={1.5}
                  align="center"
                  gap={2}
                  borderRadius="md"
                  bg={pf.kind === "good" ? "cyan.50" : "red.50"}
                  border="1px solid"
                  borderColor={pf.kind === "good" ? "cyan.200" : "red.200"}
                >
                  <Box
                    flexShrink={0}
                    color={pf.kind === "good" ? "cyan.600" : "red.500"}
                    display="flex"
                    alignItems="center"
                  >
                    {pf.kind === "good" ? (
                      <ThumbsUp size={14} weight="fill" />
                    ) : (
                      <ThumbsDown size={14} weight="fill" />
                    )}
                  </Box>
                  <Text fontSize="xs" fontFamily="body" color="charcoal.500" flex={1} truncate css={{ fontStyle: "italic" }}>
                    &ldquo;{pf.snippet}
                    {pf.snippet.length >= MAX_FLAG_SNIPPET_LEN ? "…" : ""}&rdquo;
                  </Text>
                  {pendingFlags.length === 1 && (
                    <Text fontSize="2xs" fontFamily="heading" color="charcoal.400" flexShrink={0}>
                      tell the bot why
                    </Text>
                  )}
                  <IconButton
                    aria-label="Dismiss flag note prompt"
                    size="2xs"
                    variant="ghost"
                    color="charcoal.400"
                    _hover={{ bg: "white" }}
                    onClick={() => unitContext?.onDismissPendingFlag?.(pf.messageId)}
                    flexShrink={0}
                  >
                    <X size={12} />
                  </IconButton>
                </Flex>
              ))}
            </VStack>
          )}
          {/* Staged attachments (added via the "+" / Drive buttons, not yet sent) */}
          {(pendingAttachments.length > 0 ||
            pendingDriveAttachments.length > 0 ||
            uploading) && (
            <Flex maxW="3xl" mx="auto" mb={2} gap={2} wrap="wrap" align="center">
              {pendingAttachments.map((a) => (
                <Flex
                  key={a.storageId}
                  align="center"
                  gap={1.5}
                  bg="white"
                  border="1px solid"
                  borderColor="gray.300"
                  borderRadius="lg"
                  pl={2.5}
                  pr={1.5}
                  py={1}
                  maxW="220px"
                >
                  <Paperclip size={14} weight="bold" color="var(--chakra-colors-charcoal-400)" />
                  <Text fontSize="xs" color="charcoal.600" lineClamp={1} title={a.fileName}>
                    {a.fileName}
                  </Text>
                  <IconButton
                    aria-label={`Remove ${a.fileName}`}
                    size="2xs"
                    variant="ghost"
                    color="charcoal.300"
                    _hover={{ color: "charcoal.600" }}
                    onClick={() => removePendingAttachment(a.storageId)}
                  >
                    <X size={12} weight="bold" />
                  </IconButton>
                </Flex>
              ))}
              {pendingDriveAttachments.map((a, i) => (
                <Flex
                  key={`${a.driveFileId}-${i}`}
                  align="center"
                  gap={1.5}
                  bg="white"
                  border="1px solid"
                  borderColor="gray.300"
                  borderRadius="lg"
                  pl={2.5}
                  pr={1.5}
                  py={1}
                  maxW="240px"
                >
                  {a.thumbnailUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- Google Drive thumbnail URL cannot use the Next image proxy
                    <img
                      src={a.thumbnailUrl}
                      alt=""
                      style={{
                        width: 18,
                        height: 18,
                        objectFit: "cover",
                        borderRadius: 4,
                        flexShrink: 0,
                      }}
                    />
                  ) : (
                    <GoogleDriveLogoIcon
                      size={14}
                      weight="bold"
                      color="var(--chakra-colors-charcoal-400)"
                    />
                  )}
                  <Text fontSize="xs" color="charcoal.600" lineClamp={1} title={a.name}>
                    {a.name}
                  </Text>
                  <IconButton
                    aria-label={`Remove ${a.name}`}
                    size="2xs"
                    variant="ghost"
                    color="charcoal.300"
                    _hover={{ color: "charcoal.600" }}
                    onClick={() => removePendingDriveAttachment(a.driveFileId)}
                  >
                    <X size={12} weight="bold" />
                  </IconButton>
                </Flex>
              ))}
              {uploading && (
                <Flex align="center" gap={1.5} color="charcoal.400">
                  <Spinner size="xs" color="violet.500" />
                  <Text fontSize="xs">Uploading…</Text>
                </Flex>
              )}
            </Flex>
          )}
          {allowUploads && (
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={MESSAGE_ATTACHMENT_ACCEPT}
              hidden
              onChange={(e) => handleFilesSelected(e.target.files)}
            />
          )}
          {allowUploads && (
            <CameraCaptureDialog
              open={showCamera}
              onClose={() => setShowCamera(false)}
              onCapture={(file) => void handleFilesSelected([file])}
              overlayPosition="fixed"
            />
          )}
          <Flex maxW="3xl" mx="auto" gap={2} align="flex-end">
            {allowUploads && (
              <>
                {/* Keep the Drive picker mounted even while the menu is closed
                    so its Google scripts preload; the menu item opens it via
                    drivePickerOpenRef. */}
                {googleLinked && (
                  <GooglePickerButton
                    mode="drive"
                    onPicked={handleDrivePicked}
                    renderTrigger={({ onClick }) => {
                      drivePickerOpenRef.current = onClick;
                      return null;
                    }}
                  />
                )}
                <Menu.Root positioning={{ placement: "top-start" }}>
                  <Menu.Trigger asChild>
                    <IconButton
                      aria-label="Add an attachment"
                      title="Add an attachment"
                      size="md"
                      variant="outline"
                      borderColor="gray.300"
                      color="charcoal.500"
                      bg="white"
                      _hover={{ bg: "gray.100" }}
                      _disabled={{ opacity: 0.4, cursor: "not-allowed" }}
                      borderRadius="xl"
                      disabled={isStreaming || uploading}
                    >
                      <Plus weight="bold" />
                    </IconButton>
                  </Menu.Trigger>
                  <Portal>
                    <Menu.Positioner>
                      <Menu.Content
                        minW="220px"
                        shadow="md"
                        borderRadius="lg"
                        border="1px solid"
                        borderColor="gray.200"
                      >
                        <Menu.Item
                          value="upload"
                          fontFamily="heading"
                          fontSize="sm"
                          onClick={() => fileInputRef.current?.click()}
                        >
                          <Paperclip size={16} style={{ marginRight: "8px" }} />
                          Upload file…
                        </Menu.Item>
                        <Menu.Item
                          value="drive"
                          fontFamily="heading"
                          fontSize="sm"
                          onClick={() =>
                            googleLinked
                              ? drivePickerOpenRef.current()
                              : setDriveConnectOpen(true)
                          }
                        >
                          <GoogleDriveLogoIcon
                            size={16}
                            style={{ marginRight: "8px" }}
                          />
                          Select from Google Drive
                        </Menu.Item>
                        <Menu.Item
                          value="camera"
                          fontFamily="heading"
                          fontSize="sm"
                          onClick={() => setShowCamera(true)}
                        >
                          <Camera size={16} style={{ marginRight: "8px" }} />
                          Capture Photo
                        </Menu.Item>
                      </Menu.Content>
                    </Menu.Positioner>
                  </Portal>
                </Menu.Root>
              </>
            )}
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholderText}
              resize="none"
              rows={1}
              overflow="hidden"
              bg="white"
              border="1px solid"
              borderColor="gray.300"
              borderRadius="xl"
              _focus={{ borderColor: "violet.400", boxShadow: "none", outline: "none" }}
              _focusVisible={{ boxShadow: "none", outline: "none" }}
              _placeholder={{ color: "charcoal.300" }}
              fontFamily="body"
              fontSize="sm"
              py={2.5}
              px={4}
              disabled={isStreaming}
            />
            <DictationMicButton
              size="md"
              borderRadius="xl"
              disabled={isStreaming}
              onTranscript={(text) =>
                setInput((prev) => (prev ? `${prev.trimEnd()} ${text}` : text))
              }
            />
            <IconButton
              aria-label="Send message"
              size="md"
              bg="violet.500"
              color="white"
              _hover={{ bg: "violet.600" }}
              _disabled={{ opacity: 0.4, cursor: "not-allowed" }}
              borderRadius="xl"
              onClick={() => submit()}
              disabled={
                (!input.trim() &&
                  pendingAttachments.length === 0 &&
                  pendingDriveAttachments.length === 0) ||
                isStreaming
              }
            >
              <PaperPlaneTilt />
            </IconButton>
          </Flex>
          <Dialog.Root
            open={driveConnectOpen}
            onOpenChange={(e) => setDriveConnectOpen(e.open)}
            placement="center"
          >
            <Portal>
              <Dialog.Backdrop />
              <Dialog.Positioner>
                <Dialog.Content
                  bg="white"
                  borderRadius="2xl"
                  shadow="2xl"
                  maxW="md"
                  w="calc(100vw - 32px)"
                >
                  <Dialog.Header px={6} pt={5} pb={2}>
                    <Dialog.Title
                      fontFamily="heading"
                      fontSize="lg"
                      color="navy.500"
                      flex={1}
                    >
                      Link your Google account
                    </Dialog.Title>
                    <Dialog.CloseTrigger asChild>
                      <IconButton
                        aria-label="Close Google link dialog"
                        size="sm"
                        variant="ghost"
                        color="charcoal.400"
                        _hover={{ bg: "gray.100" }}
                      >
                        <X />
                      </IconButton>
                    </Dialog.CloseTrigger>
                  </Dialog.Header>
                  <Dialog.Body px={6} pb={6} pt={2}>
                    <VStack align="stretch" gap={4}>
                      <Text fontFamily="body" fontSize="sm" color="charcoal.500">
                        Link your Google account to attach Drive documents.
                      </Text>
                      <Box>
                        <GoogleAccountConnect
                          returnTo={pathname}
                          compact
                          hideLabel
                          textSize="sm"
                          requiredAccess="drive"
                        />
                      </Box>
                    </VStack>
                  </Dialog.Body>
                </Dialog.Content>
              </Dialog.Positioner>
            </Portal>
          </Dialog.Root>
        </Box>
      </Flex>
    </Flex>
  );
}

// ── Root export (provides registry context) ───────────────────────────────────

export default function CurriculumAssistant(
  props: CurriculumAssistantProps = {},
) {
  return (
    <StreamRegistryProvider>
      <CurriculumAssistantInner {...props} />
    </StreamRegistryProvider>
  );
}

// ── Session row ───────────────────────────────────────────────────────────────

interface SessionRowProps {
  session: { _id: Id<"chats">; title: string; pinned: boolean; lastMessageAt: number; source?: "slack" };
  isActive: boolean;
  isStreaming: boolean;
  isRenaming: boolean;
  renameValue: string;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  onSelect: (e: React.MouseEvent) => void;
  onStartRename: () => void;
  onRenameChange: (v: string) => void;
  onRenameCommit: () => void;
  onRenameKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onTogglePin: () => void;
  onDelete: () => void;
}

function SessionRow({
  session, isActive, isStreaming, isRenaming, renameValue, renameInputRef,
  onSelect, onStartRename, onRenameChange, onRenameCommit, onRenameKeyDown,
  onTogglePin, onDelete,
}: SessionRowProps) {
  return (
    <Flex
      align="center"
      px={2}
      py={1.5}
      borderRadius="lg"
      cursor="pointer"
      gap={1}
      role="group"
      onClick={onSelect}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        onSelect(e);
      }}
      {...selectedListRowProps(isActive)}
    >
      <Box flex={1} minW={0}>
        {isRenaming ? (
          <input
            ref={renameInputRef as React.RefObject<HTMLInputElement>}
            value={renameValue}
            onChange={(e) => onRenameChange(e.target.value)}
            onBlur={onRenameCommit}
            onKeyDown={onRenameKeyDown}
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              background: "white",
              border: "1px solid var(--chakra-colors-violet-400)",
              borderRadius: "6px",
              padding: "2px 6px",
              fontFamily: "var(--chakra-fonts-heading)",
              fontSize: "14px",
              fontWeight: 600,
              outline: "none",
            }}
          />
        ) : (
          <>
            <Flex align="flex-start" gap={1.5} minW={0}>
              {/* Fixed-width gutter — title and timestamp both sit in the column to the right */}
              <Box w="9px" flexShrink={0} display="flex" alignItems="center" justifyContent="center" pt="2px">
                {isStreaming && <StreamingDot />}
              </Box>
              <Box flex={1} minW={0}>
                <Text
                  fontFamily="heading"
                  fontSize="sm"
                  fontWeight="600"
                  color={selectedListRowLabelColor(isActive)}
                  lineClamp={1}
                  title={session.title}
                >
                  {session.title}
                </Text>
                <Flex align="center" gap={2}>
                  <Text fontFamily="heading" fontSize="xs" color="charcoal.400">
                    {formatTimeAgo(session.lastMessageAt)}
                  </Text>
                  {session.source === "slack" && <SlackBadge />}
                </Flex>
              </Box>
            </Flex>
          </>
        )}
      </Box>

      {/* Pin icon */}
      <IconButton
        aria-label={session.pinned ? "Unpin" : "Pin"}
        size="xs"
        variant="ghost"
        color={session.pinned ? "violet.500" : "charcoal.300"}
        opacity={session.pinned ? 1 : 0}
        css={session.pinned ? undefined : { "[role=group]:hover &": { opacity: 0.8 } }}
        _hover={{ color: "violet.500", bg: "transparent", opacity: "1 !important" }}
        onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
      >
        <PushPin size={14} weight={session.pinned ? "fill" : "regular"} />
      </IconButton>

      {/* "..." menu */}
      <Menu.Root>
        <Menu.Trigger asChild>
          <IconButton
            aria-label="Chat options"
            size="xs"
            variant="ghost"
            color="charcoal.300"
            opacity={0}
            css={{ "[role=group]:hover &": { opacity: 0.8 } }}
            _hover={{ color: "charcoal.500", bg: "transparent", opacity: "1 !important" }}
            onClick={(e) => e.stopPropagation()}
          >
            <DotsThreeVertical size={12} />
          </IconButton>
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content minW="140px" shadow="md" borderRadius="lg" border="1px solid" borderColor="gray.200">
              <Menu.Item
                value="rename"
                fontFamily="heading"
                fontSize="xs"
                onClick={(e) => { e.stopPropagation(); onStartRename(); }}
              >
                <PencilSimple size={12} style={{ marginRight: "8px" }} />
                Rename
              </Menu.Item>
              <Menu.Item
                value="pin"
                fontFamily="heading"
                fontSize="xs"
                onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
              >
                <PushPin
                  size={14}
                  weight={session.pinned ? "fill" : "regular"}
                  style={{ marginRight: "8px" }}
                />
                {session.pinned ? "Unpin" : "Pin"}
              </Menu.Item>
              <Menu.Item
                value="delete"
                fontFamily="heading"
                fontSize="xs"
                color="red.500"
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
              >
                <Trash size={12} style={{ marginRight: "8px" }} />
                Delete
              </Menu.Item>
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
    </Flex>
  );
}
