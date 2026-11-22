/**
 * The tutor's proposal card in a chat (TRA-690 the card, TRA-695 this screen;
 * review/quests-rebuilt-proposal.html, "Proposing a Quest", figure 4). The RN
 * twin of the web card (TRA-694); its words come from shared/questRows.ts
 * (vendored), the same ones web says.
 *
 * The card is a `role: "tool"` message carrying `questProposalCard`
 * (convex/lib/questProposalCard.ts): the scholar's own words, a one-line
 * mission the tutor drafted, and the kind of thing it will be. The scholar can
 * change the mission and the kind, then taps Propose, which is the one write:
 * `questProposals.propose` with the chat it came from and the card itself
 * (`cardMessageId`). Then the Quest's thread opens in Messages, where the
 * proposal is the first message, and the card turns calm: "Proposed · Waiting
 * for a teacher" (or "Proposed · Advisor: Ms. Rivera" once approved) with a
 * View link to that thread.
 *
 * A card proposes once: the server stamps `proposedUnitId` on the card and a
 * repeat tap returns the same Quest. The tap is also guarded while it is in
 * flight, so a double tap sends one call. The proposed state, mission and kind
 * are read back from `questProposals.forSelf`, not remembered here. The rocket marks Propose, as it
 * marks every control that makes or starts a Quest (Phosphor RocketLaunch,
 * never the emoji).
 */

import { useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { RocketLaunchIcon } from "phosphor-react-native";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";

import { AppTextInput } from "@/components/AppTextInput";
import { api, type Id } from "@/lib/convex";
import { useContainedQuery } from "@/hooks/useContainedQuery";
import { fonts, useColors, type Colors } from "@/theme";
import {
  QUEST_COPY,
  QUEST_KINDS,
  questKindLabel,
  type QuestKind,
} from "../../vendor/shared/questRows";
import { serverErrorMessage } from "../../vendor/shared/serverErrorMessage";

/** The mission limit `questProposals.propose` enforces
 *  (QUEST_PROPOSAL_CARD_LIMITS.maxMission). */
const MISSION_MAX_CHARS = 140;
const TOUCH = 44;

export type QuestProposalCardPayload = {
  scholarWords: string;
  mission: string;
  kind: QuestKind;
  title?: string;
  /** The Quest this card became, once the scholar tapped Propose. */
  proposedUnitId?: Id<"units">;
};

export function QuestProposalCard({
  messageId,
  sessionId,
  card,
  canPropose,
}: {
  messageId: Id<"messages">;
  sessionId: Id<"sessions">;
  card: QuestProposalCardPayload;
  /** The chat's owner, at the keyboard. Anyone else sees the card and no
   *  Propose (a teacher reading the chat). */
  canPropose: boolean;
}) {
  const router = useRouter();
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const propose = useMutation(api.questProposals.propose);
  const [mission, setMission] = useState(card.mission);
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<QuestKind>(card.kind);
  const [proposing, setProposing] = useState(false);
  // Synchronous: a second tap can land before the state above re-renders.
  const tappedRef = useRef(false);

  const missionText = mission.trim();
  const proposedUnitId = card.proposedUnitId ? String(card.proposedUnitId) : null;
  const proposed = proposedUnitId !== null;
  // The Quest the card became, as it stands now: a waiting proposal the kid
  // may have edited in Messages, or an approved Quest with its advisor.
  const { data: mine } = useContainedQuery(
    api.questProposals.forSelf,
    proposedUnitId && canPropose ? {} : "skip",
  );
  const waitingQuest = mine?.waiting.find((q) => String(q.unitId) === proposedUnitId);
  const approvedQuest = mine?.approved.find((q) => String(q.unitId) === proposedUnitId);
  const quest = waitingQuest ?? approvedQuest ?? null;
  const proposedStatus = approvedQuest
    ? approvedQuest.advisorName?.trim()
      ? QUEST_COPY.advisor(approvedQuest.advisorName.trim())
      : QUEST_COPY.advisorUnnamed
    : waitingQuest
      ? QUEST_COPY.waiting
      : null;
  const locked = proposing || proposed || !canPropose;
  const shownMission = quest?.mission || missionText || card.mission;
  const shownKind = quest?.kind ?? kind;

  const openThread = (threadId: string | null) => {
    Haptics.selectionAsync().catch(() => {});
    router.push(
      threadId
        ? { pathname: "/messages", params: { thread: threadId } }
        : { pathname: "/messages" },
    );
  };

  // A promise chain, not try/catch: the React Compiler bails out on a try
  // statement in a component (native's compiler baseline is checked).
  const submit = () => {
    if (tappedRef.current || locked || !missionText) return;
    tappedRef.current = true;
    setEditing(false);
    setProposing(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    propose({
      scholarWords: card.scholarWords,
      mission: missionText,
      kind,
      ...(card.title ? { title: card.title } : {}),
      fromSessionId: sessionId,
      cardMessageId: messageId,
    })
      .then(
        ({ threadId }) => {
          // The proposal is the first message of the Quest's thread. The card
          // turns to its proposed state when the server stamps it.
          openThread(threadId ? String(threadId) : null);
        },
        (error: unknown) => {
          tappedRef.current = false;
          console.warn("[quest-proposal] propose failed", error);
          Alert.alert(
            serverErrorMessage(error, "Couldn't send your proposal"),
            "Please try again.",
          );
        },
      )
      .finally(() => setProposing(false));
  };

  return (
    <View style={styles.card} accessibilityLabel={QUEST_COPY.cardTitle}>
      <Text style={styles.eyebrow}>{QUEST_COPY.cardTitle}</Text>
      <Text style={styles.words}>{`“${card.scholarWords}”`}</Text>

      <View style={styles.block}>
        <Text style={styles.label}>{QUEST_COPY.cardMission}</Text>
        {editing ? (
          <View style={styles.editRow}>
            <AppTextInput
              style={styles.missionInput}
              value={mission}
              onChangeText={(text) => setMission(text.replace(/\s*\n\s*/g, " "))}
              maxLength={MISSION_MAX_CHARS}
              multiline
              autoFocus
              returnKeyType="done"
              submitBehavior="blurAndSubmit"
              onSubmitEditing={() => setEditing(false)}
              accessibilityLabel={QUEST_COPY.cardMission}
            />
            <Pressable
              accessibilityRole="button"
              onPress={() => setEditing(false)}
              hitSlop={8}
              style={({ pressed }) => [styles.textButton, pressed && styles.pressed]}
            >
              <Text style={styles.link}>{QUEST_COPY.cardMissionDone}</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.missionRow}>
            <Text style={styles.mission}>{shownMission}</Text>
            {!locked ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${QUEST_COPY.cardChangeMission}: ${QUEST_COPY.cardMission}`}
                onPress={() => setEditing(true)}
                hitSlop={8}
                style={({ pressed }) => [styles.textButton, pressed && styles.pressed]}
              >
                <Text style={styles.link}>{QUEST_COPY.cardChangeMission}</Text>
              </Pressable>
            ) : null}
          </View>
        )}
      </View>

      <View style={styles.block}>
        <Text style={styles.label}>{QUEST_COPY.cardKindPrompt}</Text>
        <View style={styles.kinds} accessibilityRole="radiogroup">
          {QUEST_KINDS.map((option) => {
            const selected = option === shownKind;
            return (
              <Pressable
                key={option}
                accessibilityRole="radio"
                accessibilityState={{ selected, disabled: locked }}
                disabled={locked}
                onPress={() => {
                  Haptics.selectionAsync().catch(() => {});
                  setKind(option);
                }}
                style={({ pressed }) => [
                  styles.kind,
                  selected && styles.kindSelected,
                  pressed && styles.pressed,
                  locked && !selected && styles.kindLocked,
                ]}
              >
                <Text style={[styles.kindText, selected && styles.kindTextSelected]}>
                  {questKindLabel(option)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {proposed ? (
        <View style={styles.proposedRow}>
          <RocketLaunchIcon size={18} color={colors.charcoalMuted} />
          <Text style={styles.proposedText}>
            {proposedStatus
              ? `${QUEST_COPY.cardProposed} · ${proposedStatus}`
              : QUEST_COPY.cardProposed}
          </Text>
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`${QUEST_COPY.view}: ${QUEST_COPY.cardTitle}`}
            onPress={() => openThread(quest?.threadId ? String(quest.threadId) : null)}
            hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
            style={({ pressed }) => [styles.textButton, pressed && styles.pressed]}
          >
            <Text style={styles.link}>{QUEST_COPY.view}</Text>
          </Pressable>
        </View>
      ) : canPropose ? (
        <View style={styles.proposeRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={QUEST_COPY.cardPropose}
            accessibilityState={{ busy: proposing, disabled: locked || !missionText }}
            disabled={locked || !missionText}
            onPress={submit}
            style={({ pressed }) => [
              styles.propose,
              (pressed || proposing) && styles.pressed,
              !missionText && styles.disabled,
            ]}
          >
            {proposing ? (
              <ActivityIndicator size="small" color={colors.white} />
            ) : (
              <>
                <RocketLaunchIcon size={18} color={colors.white} weight="fill" />
                <Text style={styles.proposeText}>{QUEST_COPY.cardPropose}</Text>
              </>
            )}
          </Pressable>
          <Text style={styles.hint}>{QUEST_COPY.cardProposeHint}</Text>
        </View>
      ) : null}
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    card: {
      width: "100%",
      backgroundColor: c.bg,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 18,
      padding: 18,
      gap: 14,
    },
    eyebrow: {
      color: c.charcoalMuted,
      fontFamily: fonts.semibold,
      fontSize: 12,
      letterSpacing: 0.7,
      textTransform: "uppercase",
    },
    words: {
      color: c.navy,
      fontFamily: fonts.semibold,
      fontSize: 17,
      lineHeight: 24,
    },
    block: { gap: 6 },
    label: {
      color: c.charcoalMuted,
      fontFamily: fonts.semibold,
      fontSize: 13,
    },
    missionRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 12,
    },
    mission: {
      flex: 1,
      color: c.charcoal,
      fontFamily: fonts.regular,
      fontSize: 16,
      lineHeight: 22,
    },
    editRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
    missionInput: {
      flex: 1,
      minHeight: TOUCH,
      borderWidth: 1,
      borderColor: c.violet,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      color: c.charcoal,
      fontFamily: fonts.regular,
      fontSize: 16,
      lineHeight: 22,
    },
    textButton: {
      minHeight: TOUCH,
      justifyContent: "center",
    },
    link: {
      color: c.violet,
      fontFamily: fonts.semibold,
      fontSize: 15,
    },
    kinds: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    kind: {
      minHeight: TOUCH,
      justifyContent: "center",
      borderRadius: 999,
      borderWidth: 1,
      borderColor: c.gray300,
      backgroundColor: c.bg,
      paddingHorizontal: 14,
    },
    kindSelected: { borderColor: c.violet, backgroundColor: c.violetSubtle },
    kindLocked: { opacity: 0.5 },
    kindText: {
      color: c.charcoal,
      fontFamily: fonts.medium,
      fontSize: 15,
    },
    kindTextSelected: { color: c.violet, fontFamily: fonts.semibold },
    proposeRow: {
      flexDirection: "row",
      alignItems: "center",
      flexWrap: "wrap",
      gap: 12,
    },
    propose: {
      minHeight: TOUCH,
      minWidth: 132,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      borderRadius: 12,
      backgroundColor: c.violetSolid,
      paddingHorizontal: 18,
    },
    proposeText: {
      color: c.white,
      fontFamily: fonts.bold,
      fontSize: 16,
    },
    hint: {
      color: c.charcoalMuted,
      fontFamily: fonts.regular,
      fontSize: 14,
    },
    proposedRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    proposedText: {
      color: c.charcoalMuted,
      fontFamily: fonts.medium,
      fontSize: 15,
    },
    pressed: { opacity: 0.8 },
    disabled: { opacity: 0.5 },
  });
}
