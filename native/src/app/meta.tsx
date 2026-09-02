import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { router, Redirect } from "expo-router";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";

import { Markdown } from "@/components/Markdown";
import { StreamingText } from "@/components/StreamingText";
import { RecordingBar } from "@/components/RecordingBar";
import { ChatActivityRow } from "@/components/ChatActivityRow";
import { useReflectionChat, type ReflectionBubble } from "@/hooks/useReflectionChat";
import { useVoiceDictation } from "@/hooks/useVoiceDictation";
import { isWithinPrepTime, formatLocalTimeLabel } from "@/lib/prepTime";
import { api } from "@/lib/convex";
import { CHAT_COMPOSER_INPUT } from "@/lib/chatType";
import { chatBubbleStyles } from "@/lib/chatBubbles";
import { fonts, palette, useColors } from "@/theme";
import {
  workshopMissionLine,
  WORKSHOP_INVITE_EYEBROW,
  WORKSHOP_INVITE_LEAD,
  WORKSHOP_SPARK_CHIPS,
} from "../../vendor/shared/workshopSparks";
import { TEACHER_LINE } from "../../vendor/shared/admonishments";
import { AppTextInput } from "@/components/AppTextInput";

// The Workshop (code name: `meta`) — this module now DEFINES the two reusable
// activity views (the end-of-day REFLECTION CHAT + the "My ideas"/Workshop
// BOARD) and shares them with the split Scholar's-Prep surfaces:
//   /reflection → <ReflectionChat> alone (app/reflection.tsx)
//   /workshop   → <IdeasBoard> alone (app/workshop.tsx)
// The `/meta` route itself is now just a legacy redirect to Home, so old deep
// links do not strand a scholar. Reflection and the Workshop are two things a kid
// CHOOSES during Scholar’s Prep. review/prep-time-chooser.html; the board/chat
// internals are unchanged from review/scholar-meta-prep-time-plan.html §§3,4,5,7,8.

const MAXW = 720;

/** Convex wraps a thrown Error's message ("… Uncaught Error: <message> at …");
 * pull the human sentence back out so the cap message can show inline. */
function serverMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const m = raw.match(/Uncaught (?:Convex)?Error:\s*([\s\S]*?)(?:\n\s*at\s|\n\s*$|$)/);
  return (m?.[1] ?? raw).trim();
}

/** Short relative date for a What's-new entry (mirrors StarDrawer's helper —
 * native has no date-fns). */
function relativeDate(ts: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/** The mission line — a Workshop-LEVEL subhead spanning the whole surface,
 *  above both columns (never a right-panel zone). Quiet register.
 *  COLUMN_BUILD_SPEC.md. */
export function MissionSubhead({ styles }: { styles: ReturnType<typeof makeStyles> }) {
  // Multi-tenant: name the mission line to the scholar's OWN school (product-
  // neutral when none resolves), mirroring the web Workshop page. Same query
  // both surfaces read, so the copy can't drift between iPad and web.
  const activeInstitution = useQuery(api.memberships.resolveActiveInstitution, {});
  return (
    <View style={styles.missionBar}>
      <Text style={styles.missionText}>
        {workshopMissionLine(activeInstitution?.institutionName)}
      </Text>
    </View>
  );
}

/**
 * Legacy `/meta` route → Home. The combined side-by-side screen was split into
 * /reflection + /workshop; this keeps old deep links from becoming dead ends.
 */
export default function MetaRedirect() {
  return <Redirect href="/" />;
}

// ── The reflection chat ─────────────────────────────────────────────────────

export function ReflectionChat({
  chat,
  seed,
  purpose = "reflection",
  colors,
  styles,
}: {
  chat: ReturnType<typeof useReflectionChat>;
  seed: { text: string; nonce: number } | null;
  purpose?: "reflection" | "introspection";
  colors: ReturnType<typeof useColors>;
  styles: ReturnType<typeof makeStyles>;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const scrollToEnd = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, []);

  // Prep Time eyebrow — the window CONFIG comes from the server; the client
  // decides whether *now* is inside the window (block's tz), re-checked on a
  // ~60s tick. Mirrors the web wrap-up header. No block / outside → no eyebrow.
  const block = useQuery(
    api.metaChat.myPrepTimeBlock,
    purpose === "reflection" ? {} : "skip",
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const withinWindow = isWithinPrepTime(block ?? null, now);

  const transcript = (
    <View style={styles.transcript}>
      {chat.canLoadMore ? (
        <Pressable
          accessibilityRole="button"
          onPress={chat.loadMore}
          style={({ pressed }) => [
            styles.loadEarlierButton,
            pressed && { opacity: 0.7 },
          ]}
        >
          <Text style={styles.loadEarlierText}>Load earlier messages</Text>
        </Pressable>
      ) : null}
      {chat.loading || !chat.ready ? (
        <ActivityIndicator color={colors.violet} style={{ marginVertical: 20 }} />
      ) : chat.bubbles.length === 0 && !chat.streaming ? (
        // The opener fires automatically on an empty thread; this shows only in
        // the brief gap before it lands.
        <ActivityIndicator color={colors.violet} style={{ marginVertical: 20 }} />
      ) : (
        chat.bubbles.map((b) => (
          <ChatBubble
            key={b.key}
            bubble={b}
            live={chat.streaming && isLiveBubble(b, chat.liveAssistantId)}
            streamingText={chat.streamingText}
            activity={chat.activity}
            colors={colors}
            styles={styles}
          />
        ))
      )}
    </View>
  );

  const header =
    withinWindow && block ? (
      <View style={styles.chatHeader}>
        <Text style={styles.chatEyebrow}>
          Scholar’s Prep · ends {formatLocalTimeLabel(block.endLocal)}
        </Text>
      </View>
    ) : null;
  const footer = <Text style={styles.chatFooter}>{TEACHER_LINE}</Text>;
  const composer = (
    <ChatComposer
      disabled={chat.streaming || !chat.ready}
      streaming={chat.streaming}
      onSend={chat.send}
      seed={seed}
      placeholder={
        purpose === "reflection"
          ? "Type or talk…"
          : "Ask about Rabbithole…"
      }
      colors={colors}
      styles={styles}
    />
  );

  // The chat always owns its scroll: header fixed, transcript scrolls, composer
  // + footer pinned. The parent (landscape column / portrait chat region) gives
  // it a bounded height, so the transcript scrolls internally and never overflows.
  return (
    <View style={styles.flex}>
      {header}
      <ScrollView
        ref={scrollRef}
        style={styles.flex}
        contentContainerStyle={styles.chatScrollContent}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={scrollToEnd}
      >
        {transcript}
      </ScrollView>
      {composer}
      {footer}
    </View>
  );
}

/** A bubble is "live" (paint from streamingText) when it's the assistant row
 * being streamed — matched by id, or by its still-set streamId before the id
 * resolves. */
function isLiveBubble(b: ReflectionBubble, liveAssistantId: string | null): boolean {
  if (b.role !== "assistant") return false;
  return b.key === liveAssistantId || !!b.streamId;
}

function ChatBubble({
  bubble,
  live,
  streamingText,
  activity,
  colors,
  styles,
}: {
  bubble: ReflectionBubble;
  live: boolean;
  streamingText: string;
  activity: ReturnType<typeof useReflectionChat>["activity"];
  colors: ReturnType<typeof useColors>;
  styles: ReturnType<typeof makeStyles>;
}) {
  const mine = bubble.role === "user";
  const displayContent = live ? streamingText : bubble.content;
  const empty = displayContent.length === 0;
  // The "…" is the WAITING signal, so it belongs only to a bubble whose reply
  // is still pending. An empty settled bubble renders nothing at all — an
  // ellipsis that vanishes when the stream ends reflows the transcript.
  if (empty && !live) return null;

  return (
    <View style={[styles.bubbleRow, mine ? styles.rowMine : styles.rowTutor]}>
      <View style={mine ? styles.colMine : styles.colTutor}>
        <View style={mine ? [styles.bubble, styles.mine] : styles.tutorBare}>
          {empty ? (
            // Waiting on the first token: show the current tool/thinking
            // activity (quiet), or a plain "…" when there's nothing to say
            // about it yet.
            activity ? (
              <ChatActivityRow activity={activity} />
            ) : (
              <Text style={[styles.bubbleText, styles.thinking]}>…</Text>
            )
          ) : mine ? (
            <Text style={[styles.bubbleText, styles.textMine]}>{bubble.content}</Text>
          ) : live ? (
            <StreamingText
              content={streamingText}
              done={false}
              color={colors.charcoal}
              fadeMs={420}
              style={styles.bubbleText}
            />
          ) : (
            <Markdown content={bubble.content} color={colors.charcoal} />
          )}
        </View>
      </View>
    </View>
  );
}

// The chat composer — a text input with the SAME voice affordance as the
// session composer (mic → RecordingBar → transcribe → edit before send). No
// photo attach (the reflection chat doesn't need it). Disabled while streaming.
function ChatComposer({
  disabled,
  streaming,
  onSend,
  seed,
  placeholder,
  colors,
  styles,
}: {
  disabled: boolean;
  streaming: boolean;
  onSend: (text: string) => Promise<void>;
  seed: { text: string; nonce: number } | null;
  placeholder: string;
  colors: ReturnType<typeof useColors>;
  styles: ReturnType<typeof makeStyles>;
}) {
  const [input, setInput] = useState("");
  const inputRef = useRef<TextInput>(null);
  const voice = useVoiceDictation();

  // A spark chip was tapped: pre-fill the composer with its phrase so the kid
  // finishes the thought and sends (never auto-sent — a spark is a
  // sentence-starter). React's documented "adjust state when a prop changes"
  // pattern — compare against the last-applied nonce (state, not a ref) and set
  // during render — so tapping the same chip re-seeds without a cascading-render
  // effect.
  const [seenSparkNonce, setSeenSparkNonce] = useState<number | undefined>(undefined);
  if (seed && seed.nonce !== seenSparkNonce) {
    setSeenSparkNonce(seed.nonce);
    setInput(seed.text);
  }

  // Focus the field after a spark seed so the cursor lands ready to type.
  useEffect(() => {
    if (!seed) return;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [seed?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const canSend = input.trim().length > 0 && !disabled;

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || disabled) return;
    setInput("");
    try {
      await onSend(text);
    } catch {
      // Send failed — restore the text so nothing is lost.
      setInput(text);
    } finally {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [input, disabled, onSend]);

  const onMicStart = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await voice.start();
  }, [voice]);

  const onMicStop = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const text = await voice.stop();
    if (text) {
      setInput((prev) => (prev.trim() ? prev.trim() + " " : "") + text);
    }
  }, [voice]);

  const onMicCancel = useCallback(() => {
    Haptics.selectionAsync();
    voice.cancel();
  }, [voice]);

  if (voice.isRecording || voice.isTranscribing) {
    return (
      <View style={styles.chatComposer}>
        <RecordingBar
          level={voice.level}
          durationMs={voice.durationMs}
          isTranscribing={voice.isTranscribing}
          isMaxed={voice.isMaxed}
          onCancel={onMicCancel}
          onStop={onMicStop}
        />
      </View>
    );
  }

  return (
    <View style={styles.chatComposer}>
      <View style={styles.inputWrap}>
        <AppTextInput
          ref={inputRef}
          style={styles.chatInput}
          value={input}
          onChangeText={setInput}
          placeholder={placeholder}
          placeholderTextColor={colors.charcoalSubtle}
          multiline
          submitBehavior="submit"
          onSubmitEditing={handleSend}
          editable={!streaming}
        />
        {!canSend ? (
          <Pressable
            onPress={onMicStart}
            hitSlop={8}
            style={styles.micBtn}
            disabled={disabled}
          >
            <SymbolView
              name="mic.fill"
              size={24}
              tintColor={disabled ? colors.gray300 : colors.violet}
            />
          </Pressable>
        ) : (
          <Pressable onPress={handleSend} disabled={!canSend} hitSlop={8} style={styles.sendBtn}>
            <SymbolView
              name="arrow.up.circle.fill"
              size={38}
              tintColor={canSend ? colors.violet : colors.gray300}
            />
          </Pressable>
        )}
      </View>
    </View>
  );
}

// ── The Workshop right-column zones (Behind the curtain · You know best · My
//    ideas · What's new) + the flag-OFF idea composer ─────────────────────────

/** The element type of a scholar's own idea list (title + whether they put it
 *  away + the single staff reply + resolved responder name). */
type MyIdea = {
  _id: string;
  title: string;
  archivedAt?: number;
  responderName: string | null;
  staffResponse?: { body: string } | null;
};

/** A row of tappable pills that seed the reflection chat's composer (mechanism
 *  a). Shared by Behind the curtain + You know best. */
function SeedChips({
  chips,
  onSpark,
  styles,
}: {
  chips: readonly string[];
  onSpark: (phrase: string) => void;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.sparkChips}>
      {chips.map((chip) => (
        <Pressable
          key={chip}
          accessibilityRole="button"
          accessibilityLabel={chip}
          onPress={() => onSpark(chip)}
          style={({ pressed }) => [styles.sparkChip, pressed && { opacity: 0.7 }]}
        >
          <Text style={styles.sparkChipText}>{chip}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** One idea = a self-contained card, separated from its neighbors by SPACING
 *  (never a hairline). An Answered idea collapses to title + chip + chevron;
 *  tapping expands its staff reply as a recessed, indented sub-panel INSIDE the
 *  same card — one click deep. A Sent idea is inert. */
function IdeaCard({
  idea,
  colors,
  styles,
  onSetArchived,
}: {
  idea: MyIdea;
  colors: ReturnType<typeof useColors>;
  styles: ReturnType<typeof makeStyles>;
  onSetArchived: (id: string, archived: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // "Answered" == a staff reply exists, NOT status === "answered". A staffer
  // replying in the Slack thread deliberately does not close the idea, and the
  // kid must still be able to read what they wrote. Parity with
  // components/WorkshopView.tsx.
  const answered = !!idea.staffResponse;
  const canExpand = answered;
  const archived = !!idea.archivedAt;

  const head = (
    <View style={styles.ideaHead}>
      <Text style={styles.ideaTitle}>{idea.title}</Text>
      <View style={styles.ideaHeadRight}>
        <View style={[styles.chip, answered ? styles.chipAnswered : styles.chipHeard]}>
          <Text
            style={[
              styles.chipText,
              answered ? styles.chipTextAnswered : styles.chipTextHeard,
            ]}
          >
            {answered ? "Answered" : "Sent"}
          </Text>
        </View>
        {canExpand ? (
          <SymbolView
            name={expanded ? "chevron.up" : "chevron.down"}
            size={13}
            tintColor={colors.charcoalSubtle}
          />
        ) : null}
      </View>
    </View>
  );

  return (
    <View style={styles.ideaCard}>
      {canExpand ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((v) => !v)}
          style={({ pressed }) => (pressed ? { opacity: 0.85 } : undefined)}
        >
          {head}
        </Pressable>
      ) : (
        head
      )}
      {canExpand && expanded && idea.staffResponse ? (
        <View style={styles.responseBlock}>
          <Text style={styles.responseFrom}>
            From {idea.responderName ?? "the Rabbithole team"}
          </Text>
          <Text style={styles.responseBody}>{idea.staffResponse.body}</Text>
        </View>
      ) : null}

      {/* The scholar's own lever: the five-open limit is a prioritization
          lesson pointed at THEM, so they decide when a slot frees. Quiet, and
          LAST in the card — it never competes with the reply. Archive/Restore
          is the house pair for a scholar; parity with
          components/WorkshopView.tsx. */}
      <View style={styles.ideaFoot}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={archived ? "Restore" : "Archive"}
          onPress={() => onSetArchived(idea._id, !archived)}
          hitSlop={8}
          style={({ pressed }) => (pressed ? { opacity: 0.6 } : undefined)}
        >
          <Text style={styles.ideaFootAction}>
            {archived ? "Restore" : "Archive"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

export function IdeasBoard({
  onSpark,
  colors,
  styles,
}: {
  onSpark: (phrase: string) => void;
  colors: ReturnType<typeof useColors>;
  styles: ReturnType<typeof makeStyles>;
}) {
  const ideas = useQuery(api.scholarSuggestions.listMine, {});
  const whatsNew = useQuery(api.changelog.listRecent, {});
  const flags = useQuery(api.metaChat.workshopFlags, {});
  const createMine = useMutation(api.scholarSuggestions.createMine);
  const setArchived = useMutation(api.scholarSuggestions.setArchivedMine);

  // When idea conversations are on, the reflection chat above owns idea capture,
  // so the standalone composer here is redundant — hide it (flag-gated,
  // server-authored). Fail-open: only hide when we affirmatively know the flag
  // is on, so a slow/absent flag never breaks the flag-OFF submit path.
  const hideComposer = flags?.ideaConvosEnabled === true;

  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  // Archive/Restore lives in the ideas zone, NOT the composer — and the
  // composer is hidden entirely when idea conversations are on. A refusal
  // routed to the composer's `error` would be invisible exactly when the
  // scholar needs it. Parity with components/WorkshopView.tsx.
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const trimmed = text.trim();

  const handleSetArchived = async (suggestionId: string, archived: boolean) => {
    setArchiveError(null);
    try {
      await setArchived({
        suggestionId: suggestionId as Parameters<
          typeof setArchived
        >[0]["suggestionId"],
        archived,
      });
    } catch (e) {
      // Restoring one can hit the five-open limit — the server's message names
      // the number and what to do, so show it verbatim.
      setArchiveError(serverMessage(e));
    }
  };

  // The board shows what's still on the kid's plate; what they've archived
  // lives in its own quiet section below it, never mixed in.
  const openIdeas = (ideas ?? []).filter((i) => !i.archivedAt);
  const archivedIdeas = (ideas ?? []).filter((i) => !!i.archivedAt);

  const handleSubmit = async () => {
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await createMine({ text: trimmed });
      setText("");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (e) {
      setError(serverMessage(e));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    } finally {
      setSubmitting(false);
    }
  };

  const myIdeas = (
    <>
      <Text style={styles.sectionLabel}>My ideas</Text>
      {archiveError ? (
        <Text style={[styles.errorText, styles.archiveError]}>{archiveError}</Text>
      ) : null}
      {ideas === undefined ? (
        <ActivityIndicator color={colors.violet} style={{ marginVertical: 16 }} />
      ) : ideas.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>No ideas yet.</Text>
          <Text style={styles.emptyBody}>
            {hideComposer
              ? "This is where your ideas land. Talk one through with Rabbithole in the chat and send it our way — we read every idea, and we write back."
              : "This is where you help us build Rabbithole. Something get in your way, or something you wish it could do? Send it in above — we read every idea, and we write back."}
          </Text>
        </View>
      ) : (
        <>
          {openIdeas.map((idea) => (
            <IdeaCard
              key={idea._id}
              idea={idea}
              colors={colors}
              styles={styles}
              onSetArchived={handleSetArchived}
            />
          ))}
          {archivedIdeas.length > 0 ? (
            <View style={styles.archivedSection}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: showArchived }}
                onPress={() => setShowArchived((v) => !v)}
                hitSlop={8}
                style={({ pressed }) => (pressed ? { opacity: 0.6 } : undefined)}
              >
                <Text style={styles.archivedToggle}>
                  {showArchived ? "Hide" : "Show"} archived (
                  {archivedIdeas.length})
                </Text>
              </Pressable>
              {showArchived
                ? archivedIdeas.map((idea) => (
                    <View key={idea._id} style={styles.archivedItem}>
                      <IdeaCard
                        idea={idea}
                        colors={colors}
                        styles={styles}
                        onSetArchived={handleSetArchived}
                      />
                    </View>
                  ))
                : null}
            </View>
          ) : null}
        </>
      )}
    </>
  );

  // What's new — the class-visible changelog. Quiet when empty: one friendly
  // line, never a hole. No badges/counts. Keep the credit line.
  const whatsNewZone = (
    <>
      <Text style={styles.sectionLabel}>What&apos;s new</Text>
      {whatsNew === undefined ? (
        <ActivityIndicator color={colors.violet} style={{ marginVertical: 16 }} />
      ) : whatsNew.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyBody}>
            Nothing new yet. When we change Rabbithole, you&apos;ll see it here
            first.
          </Text>
        </View>
      ) : (
        whatsNew.map((entry) => (
          <View key={entry._id} style={styles.ideaCard}>
            <View style={styles.ideaHead}>
              <Text style={styles.ideaTitle}>{entry.title}</Text>
              <Text style={styles.whatsNewDate}>{relativeDate(entry.createdAt)}</Text>
            </View>
            <Text style={styles.whatsNewBody}>{entry.kidBody}</Text>
            {entry.creditLine ? (
              <Text style={styles.creditLine}>{entry.creditLine}</Text>
            ) : null}
          </View>
        ))
      )}
    </>
  );

  const howItWorksZone = (
    <>
      <Text style={styles.sectionLabel}>How it works</Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => router.push("/how-it-works")}
        style={({ pressed }) => [
          styles.howRow,
          pressed && { opacity: 0.75 },
        ]}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.howTitle}>Read how it works</Text>
          <Text style={styles.howSub}>The plain-language tour</Text>
        </View>
        <SymbolView
          name="chevron.right"
          size={14}
          tintColor={colors.charcoalSubtle}
        />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        onPress={() => router.push("/workshop-ask")}
        style={({ pressed }) => [
          styles.howRow,
          pressed && { opacity: 0.75 },
        ]}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.howTitle}>Ask Rabbithole</Text>
          <Text style={styles.howSub}>
            A standing conversation about the app
          </Text>
        </View>
        <SymbolView
          name="chevron.right"
          size={14}
          tintColor={colors.charcoalSubtle}
        />
      </Pressable>
    </>
  );

  return (
    <View style={styles.boardInner}>
      {hideComposer ? (
        <>
          {/* YOU KNOW BEST. The invite: an open door, never pressure —
              no counts/badges, nothing escalates if ignored. Tapping a chip
              pre-fills Ask Rabbithole so the kid finishes the
              thought in their own words. */}
          <Text style={styles.sectionLabel}>{WORKSHOP_INVITE_EYEBROW}</Text>
          <View style={styles.sparkCard}>
            <Text style={styles.inviteLead}>{WORKSHOP_INVITE_LEAD}</Text>
            <SeedChips chips={WORKSHOP_SPARK_CHIPS} onSpark={onSpark} styles={styles} />
          </View>

          {myIdeas}
          {whatsNewZone}
        </>
      ) : (
        <>
          <Text style={styles.sectionLabel}>{WORKSHOP_INVITE_EYEBROW}</Text>
          <View style={styles.composer}>
            <Text style={styles.composerTitle}>Got an idea?</Text>
            <Text style={styles.composerHelp}>
              We read every idea, and we always write back.
            </Text>
            <View style={styles.ideaInputWrap}>
              <AppTextInput
                value={text}
                onChangeText={(t) => {
                  setText(t);
                  if (error) setError(null);
                }}
                placeholder="What should we do differently?"
                placeholderTextColor={colors.charcoalSubtle}
                multiline
                style={styles.ideaInput}
              />
              {submitting ? (
                <ActivityIndicator color={colors.violet} style={styles.ideaSendBtn} />
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Send it to us"
                  disabled={!trimmed}
                  onPress={handleSubmit}
                  hitSlop={8}
                  style={styles.ideaSendBtn}
                >
                  <SymbolView
                    name="arrow.up.circle.fill"
                    size={34}
                    tintColor={trimmed ? colors.violet : colors.gray300}
                  />
                </Pressable>
              )}
            </View>
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
          </View>

          {myIdeas}
          {whatsNewZone}
        </>
      )}
      {howItWorksZone}
    </View>
  );
}

export function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    ...chatBubbleStyles(c),
    flex: { flex: 1, backgroundColor: c.bgSubtle },
    // Portrait: two bounded flex regions stacked — chat (own scroll) on top,
    // ideas board (own scroll) below — centered at the reading width.
    portraitStack: {
      flex: 1,
      width: "100%",
      maxWidth: MAXW,
      alignSelf: "center",
    },
    portraitChat: { flex: 1.5 },
    portraitBoard: { flex: 1 },
    boardScrollContent: {
      paddingHorizontal: 24,
      paddingTop: 6,
      paddingBottom: 12,
      gap: 12,
    },
    sectionDivider: {
      height: 1,
      backgroundColor: c.border,
      marginVertical: 18,
      marginHorizontal: 24,
    },
    // Landscape split
    landscapeRow: {
      flex: 1,
      flexDirection: "row",
      width: "100%",
      maxWidth: 1100,
      alignSelf: "center",
    },
    chatColumn: {
      flex: 1.5,
      borderRightWidth: 1,
      borderRightColor: c.border,
    },
    boardColumn: { flex: 1 },
    boardContent: {
      paddingHorizontal: 20,
      paddingVertical: 18,
      gap: 12,
    },
    // ── Reflection chat ──
    // Wrap-up header: compact title (+ Prep Time eyebrow when active) stacked
    // tight, a hairline divider, then the transcript snug beneath. Left edge
    // aligns with the transcript content grid (paddingHorizontal 20). Shared
    // treatment with the web wrap-up header.
    chatHeader: {
      paddingHorizontal: 20,
      paddingTop: 8,
      paddingBottom: 8,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    chatEyebrow: {
      fontSize: 13,
      fontFamily: fonts.regular,
      color: c.charcoalSubtle,
    },
    chatScrollContent: { paddingHorizontal: 20, paddingBottom: 12 },
    transcript: { gap: 4, paddingTop: 4 },
    loadEarlierButton: {
      alignSelf: "center",
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    loadEarlierText: {
      color: c.violet,
      fontSize: 13,
      fontFamily: fonts.semibold,
    },
    chatFooter: {
      fontSize: 12.5,
      lineHeight: 18,
      fontFamily: fonts.regular,
      color: c.charcoalSubtle,
      textAlign: "center",
      paddingTop: 8,
      paddingBottom: 4,
    },
    bubbleRow: { flexDirection: "row", marginVertical: 6 },
    rowMine: { justifyContent: "flex-end" },
    rowTutor: { justifyContent: "flex-start" },
    colMine: { maxWidth: "86%", alignItems: "flex-end" },
    colTutor: { maxWidth: "94%", alignItems: "flex-start" },
    // Chat composer
    chatComposer: {
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 6,
    },
    inputWrap: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 8,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 20,
      backgroundColor: c.bg,
      paddingLeft: 16,
      paddingRight: 6,
      paddingVertical: 4,
    },
    chatInput: {
      flex: 1,
      minHeight: 40,
      maxHeight: 120,
      color: c.fg,
      ...CHAT_COMPOSER_INPUT,
      fontFamily: fonts.regular,
      paddingVertical: 9,
    },
    micBtn: { paddingBottom: 8, paddingRight: 6 },
    sendBtn: { paddingBottom: 3 },
    // ── Ideas board ──
    boardInner: { gap: 12 },
    // Mission subhead — a quiet, full-width strip under the screen title,
    // spanning above both columns (never a right-panel zone). COLUMN_BUILD_SPEC.md.
    missionBar: {
      paddingHorizontal: 24,
      paddingVertical: 10,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      backgroundColor: c.bgSubtle,
    },
    missionText: {
      fontSize: 14,
      lineHeight: 20,
      fontFamily: fonts.regular,
      color: c.charcoalSubtle,
    },
    // The invite's lead line (You know best) — body register, sits under the
    // eyebrow, above the spark chips.
    inviteLead: {
      fontSize: 16,
      lineHeight: 23,
      fontFamily: fonts.regular,
      color: c.charcoalMuted,
    },
    // All four eyebrows share this treatment — flush-left (no indent), uppercase.
    sectionLabel: {
      color: c.charcoalSubtle,
      fontSize: 12.5,
      letterSpacing: 1.2,
      fontFamily: fonts.bold,
      textTransform: "uppercase",
      marginTop: 18,
      marginBottom: 2,
      marginLeft: 0,
    },
    composer: {
      backgroundColor: c.bg,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: c.border,
      padding: 18,
      gap: 4,
    },
    // Spark invitation card — same white-surface treatment as the composer it
    // replaces; invitation line + a row of tappable pill chips.
    sparkCard: {
      backgroundColor: c.bg,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: c.border,
      padding: 18,
    },
    sparkChips: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      marginTop: 12,
    },
    sparkChip: {
      backgroundColor: c.violetSubtle,
      borderWidth: 1,
      borderColor: c.violetMuted,
      borderRadius: 999,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    sparkChipText: {
      fontSize: 14,
      fontFamily: fonts.semibold,
      color: c.violetSolid,
    },
    composerTitle: { fontSize: 18, fontFamily: fonts.bold, color: c.navy },
    composerHelp: {
      fontSize: 14,
      lineHeight: 20,
      fontFamily: fonts.regular,
      color: c.charcoalMuted,
      marginBottom: 6,
    },
    // Compact idea composer: a single-line field that grows as you type, Send
    // inline (right) — matches the reflection chat's send affordance.
    ideaInputWrap: {
      flexDirection: "row",
      alignItems: "flex-end",
      gap: 6,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 16,
      backgroundColor: c.bgSubtle,
      paddingLeft: 14,
      paddingRight: 4,
      paddingVertical: 3,
    },
    ideaInput: {
      flex: 1,
      minHeight: 40,
      maxHeight: 120,
      color: c.fg,
      fontSize: 16,
      fontFamily: fonts.regular,
      paddingVertical: 9,
    },
    ideaSendBtn: { paddingBottom: 3, paddingLeft: 2 },
    errorText: {
      color: c.statusRed,
      fontSize: 13,
      lineHeight: 19,
      fontFamily: fonts.semibold,
      marginTop: 8,
    },
    emptyCard: {
      backgroundColor: c.bg,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.border,
      padding: 18,
      gap: 6,
    },
    emptyTitle: { fontSize: 17, fontFamily: fonts.bold, color: c.navy },
    emptyBody: {
      fontSize: 15,
      lineHeight: 22,
      fontFamily: fonts.regular,
      color: c.charcoalMuted,
    },
    ideaCard: {
      backgroundColor: c.bg,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.border,
      padding: 18,
      gap: 6,
    },
    ideaHead: {
      flexDirection: "row",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: 12,
    },
    // The right cluster of an idea's head: the status chip + (for Answered) the
    // expand chevron.
    ideaHeadRight: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      flexShrink: 0,
    },
    ideaTitle: {
      flex: 1,
      fontSize: 17,
      fontFamily: fonts.semibold,
      color: c.navy,
    },
    chip: {
      borderRadius: 999,
      paddingHorizontal: 10,
      paddingVertical: 3,
      flexShrink: 0,
    },
    // The card's foot: the scholar's archive / restore lever. Right-aligned
    // and quiet — present on every card, loud on none.
    ideaFoot: { flexDirection: "row", justifyContent: "flex-end", marginTop: 8 },
    ideaFootAction: {
      fontSize: 12.5,
      fontFamily: fonts.bold,
      color: c.charcoalSubtle,
    },
    archiveError: { marginBottom: 12 },
    archivedSection: { marginTop: 16 },
    archivedToggle: {
      fontSize: 12.5,
      letterSpacing: 0.4,
      fontFamily: fonts.bold,
      color: c.charcoalSubtle,
      marginBottom: 12,
    },
    // Archived ideas read as set down, not gone.
    archivedItem: { opacity: 0.75, marginBottom: 12 },
    chipHeard: { backgroundColor: c.gray100 },
    chipAnswered: { backgroundColor: palette.green[100] },
    chipText: { fontSize: 12, fontFamily: fonts.bold },
    chipTextHeard: { color: c.charcoalMuted },
    chipTextAnswered: { color: palette.green[700] },
    // The staff reply — a recessed, indented sub-panel INSIDE the idea card
    // (revealed by tapping an Answered idea). Recessed (subtle fill + hairline)
    // and indented, so it reads as one-click-deep, never a floating sibling.
    responseBlock: {
      marginTop: 12,
      marginLeft: 12,
      backgroundColor: c.bgSubtle,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    responseFrom: {
      fontSize: 12.5,
      letterSpacing: 0.4,
      fontFamily: fonts.bold,
      color: c.charcoalSubtle,
      marginBottom: 4,
    },
    responseBody: {
      fontSize: 15,
      lineHeight: 22,
      fontFamily: fonts.regular,
      color: c.charcoalMuted,
    },
    // ── What's new ──
    whatsNewDate: {
      fontSize: 12.5,
      fontFamily: fonts.regular,
      color: c.charcoalSubtle,
      flexShrink: 0,
      marginTop: 2,
    },
    whatsNewBody: {
      fontSize: 15,
      lineHeight: 22,
      fontFamily: fonts.regular,
      color: c.charcoalMuted,
      marginTop: 4,
    },
    creditLine: {
      fontSize: 14.5,
      fontFamily: fonts.semibold,
      color: c.violet,
      marginTop: 10,
    },
    // ── How it works row ── (slim: leads the board, less padding than a card)
    howRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      backgroundColor: c.bg,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: 18,
      paddingVertical: 13,
      marginTop: 10,
    },
    howTitle: { fontSize: 17, fontFamily: fonts.bold, color: c.navy },
    howSub: {
      fontSize: 14,
      lineHeight: 20,
      fontFamily: fonts.regular,
      color: c.charcoalMuted,
      marginTop: 2,
    },
  });
}
