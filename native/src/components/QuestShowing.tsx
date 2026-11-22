/**
 * "I'm ready to show": how a kid says their Quest is ready (TRA-684;
 * review/quests-rebuilt-proposal.html, figure 8), the RN twin of web's
 * components/QuestShowing.tsx. Since TRA-720 it is the session header's action
 * pill, the same pill, paper plane and place as homework's "I'm done with
 * this", on every Quest maker screen (the chat with its bench or deck, and the
 * app builder). Words: shared/questRows.ts QUEST_SHOWING_COPY (vendored), the
 * same ones web says.
 *
 * `QuestShowingProvider` wraps the session route: it looks the Quest up once
 * from `questProposals.forSelf` by the session's unit, owns the sheet, and
 * hands both down (lib/questSession.ts). The screens put `useQuestReadyPill()`
 * in their header; the hand-ins read `useQuestSession()` and step aside.
 *
 * A kid who isn't ready leaves the pill alone. Tapping it opens a small sheet,
 * "How does it work? Say it in your own words" (one or two sentences, typed
 * or said); Send calls `questShowing.markReadyToShow`. Afterwards the pill
 * shows a checkmark and "Ready to show", and tapping it reopens the sheet on
 * the words they sent, with when; sending again updates them. Once the Quest
 * is shown the pill is gone (the Quests tab's row is a gold star by then).
 */

import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useMutation } from "convex/react";
import * as Haptics from "expo-haptics";
import { MicrophoneIcon, StopIcon } from "phosphor-react-native";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppTextInput } from "@/components/AppTextInput";
import { Modal } from "@/components/FreezableModal";
import {
  HeaderPillButton,
  TEACHER_HANDOFF_ICON,
} from "@/components/HeaderPillButton";
import { useContainedQuery } from "@/hooks/useContainedQuery";
import { useNow } from "@/hooks/useNow";
import { useStreamingDictation } from "@/hooks/useStreamingDictation";
import { api, type Id } from "@/lib/convex";
import {
  QuestSessionContext,
  type ApprovedQuest,
  type QuestSession,
} from "@/lib/questSession";
import { palette, fonts, useColors, type Colors } from "@/theme";
import { status } from "../../vendor/shared/brand";
import {
  QUEST_SHOWING_COPY as COPY,
  QUEST_SHOWING_LIMITS,
  checkInMyWords,
  isShownQuest,
  questForSession,
  readyToShowWhen,
} from "../../vendor/shared/questRows";
import { serverErrorMessage } from "../../vendor/shared/serverErrorMessage";

const TOUCH = 44;

/** The session's Quest, once, for the whole route: the approved Quest whose
 *  maker activity this session is (shared/questRows.ts `questForSession`).
 *  `unitId` is undefined while the session loads and null on a session
 *  without a unit. A failed read counts as "not a Quest": the session keeps
 *  its ordinary hand-in. */
export function QuestShowingProvider({
  sessionId,
  unitId,
  activityId,
  children,
}: {
  sessionId: Id<"sessions">;
  unitId: Id<"units"> | null | undefined;
  activityId: Id<"activities"> | null | undefined;
  children: React.ReactNode;
}) {
  const { data, error } = useContainedQuery(
    api.questProposals.forSelf,
    unitId ? {} : "skip",
  );
  const quest =
    unitId === undefined
      ? undefined
      : !unitId || error
        ? null
        : data === undefined
          ? undefined
          : questForSession(data.approved, { unitId, activityId });
  const [open, setOpen] = useState(false);
  // Each opening is a fresh sheet, starting from the words they sent (empty
  // the first time); it stays mounted while it fades out.
  const [openings, setOpenings] = useState(0);
  const openReadyToShow = useCallback(() => {
    Haptics.selectionAsync().catch(() => {});
    setOpenings((n) => n + 1);
    setOpen(true);
  }, []);
  const value = useMemo<QuestSession>(
    () => ({ quest, openReadyToShow }),
    [quest, openReadyToShow],
  );
  return (
    <QuestSessionContext.Provider value={value}>
      {children}
      {quest && !isShownQuest(quest) ? (
        <ReadyToShowSheet
          key={`${String(quest.unitId)}:${openings}`}
          open={open}
          onClose={() => setOpen(false)}
          sessionId={sessionId}
          quest={quest}
        />
      ) : null}
    </QuestSessionContext.Provider>
  );
}

/**
 * The header's "I'm ready to show" pill for a Quest not yet shown, else null.
 * An element with plain props, so it works in a native-stack header item,
 * which renders outside this screen's React tree (no context there).
 */
export function useQuestReadyPill(): React.ReactElement | null {
  const { quest, openReadyToShow } = useContext(QuestSessionContext);
  const showing = !!quest && !isShownQuest(quest);
  const ready = !!quest && quest.readyToShowAt != null;
  return useMemo(
    () =>
      showing ? (
        <HeaderPillButton
          icon={ready ? "checkmark.circle.fill" : TEACHER_HANDOFF_ICON}
          label={ready ? COPY.rowReady : COPY.readyToShow}
          onPress={openReadyToShow}
        />
      ) : null,
    [showing, ready, openReadyToShow],
  );
}

function ReadyToShowSheet({
  open,
  onClose,
  sessionId,
  quest,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: Id<"sessions">;
  quest: ApprovedQuest;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const markReady = useMutation(api.questShowing.markReadyToShow);
  const now = useNow(60_000);
  const sentWords = quest.inMyWords ?? "";
  const readyToShowAt = quest.readyToShowAt;
  const [text, setText] = useState(sentWords);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dictation = useStreamingDictation((said) => {
    setText((current) => (current.trim() ? `${current.trim()} ${said.trim()}` : said.trim()));
  }, sessionId);
  const listening = dictation.state !== "idle";
  const { cancelRecording } = dictation;
  useEffect(() => {
    if (!open) cancelRecording();
  }, [open, cancelRecording]);

  const checked = checkInMyWords(text);
  const send = () => {
    if (!checked.ok || sending) return;
    setSending(true);
    setError(null);
    markReady({ unitId: quest.unitId, inMyWords: checked.words })
      .then(
        () => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          onClose();
        },
        (e: unknown) => {
          console.warn("[quest-showing] send failed", e);
          setError(serverErrorMessage(e, "Couldn't send that"));
        },
      )
      .finally(() => setSending(false));
  };

  // No way out while it sends (backdrop, Cancel or the system's dismiss): a
  // reopening would be a fresh sheet that could send again, and this send's
  // completion would close it.
  const dismiss = () => {
    if (!sending) onClose();
  };

  const problem = error ?? (!checked.ok ? checked.reason : null) ?? dictation.error;

  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      supportedOrientations={["landscape", "landscape-left", "landscape-right"]}
      onRequestClose={dismiss}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={[styles.overlay, { paddingBottom: Math.max(insets.bottom, 16) }]}
      >
        <Pressable style={styles.backdrop} onPress={dismiss} />
        <View style={styles.sheet}>
          <Text style={styles.title}>{COPY.sheetTitle}</Text>
          <Text style={styles.hint}>{COPY.sheetHint}</Text>
          <AppTextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            placeholder={COPY.sheetPlaceholder}
            multiline
            autoFocus
            maxLength={QUEST_SHOWING_LIMITS.maxInMyWords + 200}
            accessibilityLabel={COPY.sheetTitle}
          />
          {problem ? <Text style={styles.problem}>{problem}</Text> : null}
          {readyToShowAt != null ? (
            <Text style={styles.readyText}>
              {COPY.readyAt(readyToShowWhen(readyToShowAt, now))}
            </Text>
          ) : null}
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              onPress={() => void dictation.toggleRecording()}
              style={({ pressed }) => [styles.mic, pressed && styles.pressed]}
            >
              {listening ? (
                <StopIcon size={16} weight="fill" color={colors.violet} />
              ) : (
                <MicrophoneIcon size={16} weight="fill" color={colors.violet} />
              )}
              <Text style={styles.link}>{listening ? COPY.micStop : COPY.mic}</Text>
            </Pressable>
            <View style={styles.actionsRight}>
              <Pressable
                accessibilityRole="button"
                onPress={dismiss}
                disabled={sending}
                style={({ pressed }) => [styles.quiet, pressed && styles.pressed]}
              >
                <Text style={styles.quietText}>{COPY.cancel}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: !checked.ok || listening, busy: sending }}
                disabled={!checked.ok || listening || sending}
                onPress={send}
                style={({ pressed }) => [
                  styles.send,
                  (!checked.ok || listening) && styles.sendOff,
                  pressed && styles.pressed,
                ]}
              >
                {sending ? (
                  <ActivityIndicator size="small" color={colors.white} />
                ) : (
                  <Text style={styles.sendText}>
                    {readyToShowAt != null ? COPY.update : COPY.send}
                  </Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    readyText: { color: c.charcoalMuted, fontFamily: fonts.bold, fontSize: 13 },
    quiet: {
      minHeight: TOUCH,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 14,
    },
    quietText: { color: c.charcoalMuted, fontFamily: fonts.bold, fontSize: 14 },
    link: { color: c.violet, fontFamily: fonts.bold, fontSize: 14 },
    pressed: { opacity: 0.7 },
    overlay: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 24,
      paddingTop: 24,
    },
    backdrop: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: "rgba(8, 13, 30, 0.42)",
    },
    sheet: {
      width: "100%",
      maxWidth: 520,
      borderRadius: 22,
      padding: 22,
      gap: 10,
      backgroundColor: c.bg,
      borderWidth: 1,
      borderColor: c.border,
      shadowColor: palette.navy[900],
      shadowOpacity: 0.22,
      shadowRadius: 30,
      shadowOffset: { width: 0, height: 14 },
    },
    title: { color: c.navy, fontFamily: fonts.bold, fontSize: 20 },
    hint: { color: c.charcoalMuted, fontFamily: fonts.regular, fontSize: 14 },
    input: {
      minHeight: 96,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 14,
      padding: 12,
      color: c.navy,
      fontFamily: fonts.regular,
      fontSize: 16,
      textAlignVertical: "top",
    },
    problem: { color: status.red, fontFamily: fonts.regular, fontSize: 13 },
    actions: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    actionsRight: { flexDirection: "row", alignItems: "center", gap: 4 },
    mic: { minHeight: TOUCH, flexDirection: "row", alignItems: "center", gap: 6 },
    send: {
      minHeight: TOUCH,
      minWidth: 88,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 999,
      backgroundColor: c.violetSolid,
      paddingHorizontal: 18,
    },
    sendOff: { opacity: 0.4 },
    sendText: { color: c.white, fontFamily: fonts.bold, fontSize: 15 },
  });
}
