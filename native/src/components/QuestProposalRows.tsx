/**
 * The scholar's proposed Quests on the BunnyPad's Quests tab (TRA-695), the RN
 * twin of web's (TRA-694); review/quests-rebuilt-proposal.html, "Proposing a
 * Quest", the Quests-tab figure and figure 12. Words: shared/questRows.ts
 * (vendored), the same ones web says.
 *
 *   - ProposeQuestButton: "Propose a Quest", with the rocket, beside Your
 *     Quests where "+ Start a Quest" was. It opens a chat through the same
 *     way the "I wonder…" box does: a new chat of the kid's own
 *     (`sessions.create`) with their first turn handed over
 *     (lib/wonderChat.ts), without saving a wonder. That first turn says
 *     they want to propose a Quest, so the tutor asks what they want to make
 *     and then offers its proposal card (components/QuestProposalCard).
 *   - QuestProposalList: `questProposals.forSelf` drawn as the one row
 *     (ui/ListRow). An approved Quest has its rocket launched, "An app ·
 *     Advisor: Ms. Rivera" and "Start building", or "Continue" once begun:
 *     both open the Quest's one maker activity (`sessions.create` returns the
 *     session already there). A teacher's offer sits after them (TRA-698):
 *     the rocket on the ground, "An app · Picked for you by Ms. Rivera" and an
 *     outline "Start building" that starts the offer then opens its maker.
 *     A waiting proposal has its rocket on the
 *     ground, "An app · Waiting for a teacher" and a quiet "View" that opens
 *     its thread in Messages. "Ms. Rivera replied" ends either meta line and
 *     opens the same thread. After them come the "Code it" missions that
 *     unlocked on their own: "A Python program · Unlocked by your practice"
 *     and an outline "Start building" that starts one
 *     (`startUnlockedCodeIt`) then opens its maker. Every row ends in the
 *     same quiet × (ListRow `onDismiss`); what it does is the row's
 *     (shared/questRows.ts `questDismissal`). The row leaves at once and
 *     comes back with an alert if the write fails, as a wonder row does
 *     (WonderLists.tsx). A started Quest asks first.
 */

import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { RocketLaunchIcon } from "phosphor-react-native";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text } from "react-native";

import { QueueSurface } from "@/components/QuestionQueue";
import { ListRow } from "@/components/ui/ListRow";
import { api, type Id } from "@/lib/convex";
import { wonderChatRoute } from "@/lib/wonderChat";
import { fonts, useColors, type Colors } from "@/theme";
import {
  QUEST_COPY,
  QUEST_DISMISS_CONFIRM,
  approvedActiveFirst,
  questDismissal,
  approvedQuestRow,
  offeredQuestRow,
  unlockedQuestRow,
  waitingQuestRow,
  type ApprovedQuestInput,
  type OfferedQuestInput,
  type QuestDismissal,
  type UnlockedQuestInput,
  type WaitingQuestInput,
} from "../../vendor/shared/questRows";
import { serverErrorMessage } from "../../vendor/shared/serverErrorMessage";

const TOUCH = 44;

/** A `forSelf` approved Quest, as this list opens it. */
export type ApprovedQuest = ApprovedQuestInput & {
  activityId: Id<"activities">;
  threadId: Id<"parentThreads"> | null;
};

/** A `forSelf` offered Quest (a teacher's offer), as this list starts it. */
export type OfferedQuest = OfferedQuestInput;

/** A `forSelf` unlocked "Code it" mission, as this list starts it. */
export type UnlockedMission = UnlockedQuestInput;

/** A `forSelf` waiting proposal, as this list opens it. */
export type WaitingProposal = WaitingQuestInput & {
  threadId: Id<"parentThreads"> | null;
};

export function ProposeQuestButton({ disabled }: { disabled: boolean }) {
  const router = useRouter();
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const createSession = useMutation(api.sessions.create);
  const [opening, setOpening] = useState(false);
  const inert = disabled || opening;

  const open = () => {
    if (inert) return;
    setOpening(true);
    Haptics.selectionAsync().catch(() => {});
    const opener = QUEST_COPY.proposeOpener;
    createSession({})
      .then(
        (result) => {
          if (!result?.id) return;
          router.push(wonderChatRoute(result.id, opener, "typed"));
        },
        (error: unknown) => {
          console.warn("[propose-quest] open failed", error);
          Alert.alert(serverErrorMessage(error, "Couldn't open that"), "Please try again.");
        },
      )
      .finally(() => setOpening(false));
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={QUEST_COPY.proposeAQuest}
      accessibilityState={{ disabled: inert, busy: opening }}
      disabled={inert}
      onPress={open}
      style={({ pressed }) => [
        styles.propose,
        pressed && !inert && styles.pressed,
        disabled && styles.locked,
      ]}
    >
      {opening ? (
        <ActivityIndicator size="small" color={colors.violet} />
      ) : (
        <RocketLaunchIcon size={16} color={colors.violet} weight="bold" />
      )}
      <Text style={styles.proposeText}>{QUEST_COPY.proposeAQuest}</Text>
    </Pressable>
  );
}

export function QuestProposalList({
  approved = [],
  offered = [],
  waiting = [],
  unlocked = [],
}: {
  approved?: readonly ApprovedQuest[];
  offered?: readonly OfferedQuest[];
  waiting?: readonly WaitingProposal[];
  unlocked?: readonly UnlockedMission[];
}) {
  const router = useRouter();
  const createSession = useMutation(api.sessions.create);
  const startOffer = useMutation(api.questProposals.startOfferedQuest);
  const startUnlocked = useMutation(api.questProposals.startUnlockedCodeIt);
  const dismissQuest = useMutation(api.questProposals.dismissQuest);
  const dismissUnlocked = useMutation(api.questProposals.dismissUnlockedCodeIt);
  const [startingUnit, setStartingUnit] = useState<string | null>(null);
  // Dismissed this visit, by row key: hidden at once, before the read
  // catches up, and shown again if the write fails.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());

  const openThread = (threadId: string) => {
    Haptics.selectionAsync().catch(() => {});
    router.push({ pathname: "/messages", params: { thread: threadId } });
  };

  // The approved Quest's one activity: "Start building" makes its session,
  // "Continue" lands on the one already there (sessions.create returns it).
  const startQuest = (quest: ApprovedQuest) => {
    if (startingUnit) return;
    setStartingUnit(String(quest.unitId));
    Haptics.selectionAsync().catch(() => {});
    createSession({ activityId: quest.activityId })
      .then(
        (result) => {
          if (!result?.id) return;
          router.push({
            pathname: "/session/[id]",
            params: { id: result.id, title: quest.title },
          });
        },
        (error: unknown) => {
          console.warn("[quest-proposals] start failed", error);
          Alert.alert(
            serverErrorMessage(error, "Couldn't open that Quest"),
            "Please try again.",
          );
        },
      )
      .finally(() => setStartingUnit(null));
  };

  // A teacher's offer: start it (a second tap gets the same maker activity),
  // then open it the way an approved Quest opens.
  const startOffered = (quest: OfferedQuest) => {
    if (startingUnit) return;
    setStartingUnit(String(quest.unitId));
    Haptics.selectionAsync().catch(() => {});
    startOffer({ unitId: quest.unitId as Id<"units"> })
      .then(({ activityId }) => createSession({ activityId }))
      .then(
        (result) => {
          if (!result?.id) return;
          router.push({
            pathname: "/session/[id]",
            params: { id: result.id, title: quest.title },
          });
        },
        (error: unknown) => {
          console.warn("[quest-proposals] start offer failed", error);
          Alert.alert(
            serverErrorMessage(error, "Couldn't open that Quest"),
            "Please try again.",
          );
        },
      )
      .finally(() => setStartingUnit(null));
  };

  // An unlocked mission: start it (a second tap gets the same Quest), then
  // open it the way an approved Quest opens. Its busy key is the row's.
  const startUnlockedMission = (mission: UnlockedMission) => {
    if (startingUnit) return;
    const key = `unlock:${mission.skillKey}`;
    setStartingUnit(key);
    Haptics.selectionAsync().catch(() => {});
    startUnlocked({ skillKey: mission.skillKey })
      .then(({ activityId }) => createSession({ activityId }))
      .then(
        (result) => {
          if (!result?.id) return;
          router.push({
            pathname: "/session/[id]",
            params: { id: result.id, title: mission.title },
          });
        },
        (error: unknown) => {
          console.warn("[quest-proposals] start unlocked failed", error);
          Alert.alert(
            serverErrorMessage(error, "Couldn't open that Quest"),
            "Please try again.",
          );
        },
      )
      .finally(() => setStartingUnit(null));
  };

  // The row's ×. A started Quest asks first; the others go at once.
  const dismiss = (key: string, what: QuestDismissal) => {
    const go = () => {
      Haptics.selectionAsync().catch(() => {});
      setDismissed((prev) => new Set(prev).add(key));
      const write =
        what.mutation === "dismissUnlockedCodeIt"
          ? dismissUnlocked({ skillKey: what.skillKey })
          : dismissQuest({ unitId: what.unitId as Id<"units"> });
      write.catch((error: unknown) => {
        console.warn("[quest-proposals] dismiss not recorded", error);
        setDismissed((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
        Alert.alert(serverErrorMessage(error, QUEST_COPY.dismissFailed));
      });
    };
    if (!what.confirm) {
      go();
      return;
    }
    Alert.alert(QUEST_DISMISS_CONFIRM.title, QUEST_DISMISS_CONFIRM.body, [
      { text: QUEST_DISMISS_CONFIRM.cancel, style: "cancel" },
      { text: QUEST_DISMISS_CONFIRM.confirm, style: "destructive", onPress: go },
    ]);
  };

  const shown = <T,>(keyOf: (item: T) => string) => (item: T) => !dismissed.has(keyOf(item));
  const approvedLeft = approved.filter(shown((quest) => `quest:${quest.unitId}`));
  const offeredLeft = offered.filter(shown((quest) => `offer:${quest.unitId}`));
  const waitingLeft = waiting.filter(shown((proposal) => `proposal:${proposal.unitId}`));
  const unlockedLeft = unlocked.filter(shown((mission) => `unlock:${mission.skillKey}`));

  if (
    approvedLeft.length + offeredLeft.length + waitingLeft.length + unlockedLeft.length ===
    0
  ) {
    return null;
  }
  // Quests already shown stay in the list, below the rest.
  const { active, shown: alreadyShown } = approvedActiveFirst(approvedLeft);
  const approvedRow = (quest: ApprovedQuest, divided: boolean) => (
    <ListRow
      key={`quest:${quest.unitId}`}
      row={approvedQuestRow(quest)}
      divided={divided}
      busy={startingUnit === String(quest.unitId)}
      disabled={startingUnit !== null && startingUnit !== String(quest.unitId)}
      onPress={() => startQuest(quest)}
      onReplyPress={openThread}
      onDismiss={() =>
        dismiss(`quest:${quest.unitId}`, questDismissal({ status: "approved", quest }))
      }
    />
  );
  return (
    <QueueSurface>
      {active.map((quest, index) => approvedRow(quest, index > 0))}
      {offeredLeft.map((quest, index) => (
        <ListRow
          key={`offer:${quest.unitId}`}
          row={offeredQuestRow(quest)}
          divided={active.length > 0 || index > 0}
          busy={startingUnit === String(quest.unitId)}
          disabled={startingUnit !== null && startingUnit !== String(quest.unitId)}
          onDismiss={() =>
            dismiss(`offer:${quest.unitId}`, questDismissal({ status: "offered", quest }))
          }
          onPress={() => startOffered(quest)}
          onReplyPress={openThread}
        />
      ))}
      {waitingLeft.map((proposal, index) => {
        const threadId = proposal.threadId;
        return (
          <ListRow
            key={`proposal:${proposal.unitId}`}
            row={waitingQuestRow(proposal)}
            divided={active.length + offeredLeft.length > 0 || index > 0}
            disabled={!threadId}
            onPress={() => {
              if (threadId) openThread(threadId);
            }}
            onReplyPress={openThread}
            onDismiss={() =>
              dismiss(
                `proposal:${proposal.unitId}`,
                questDismissal({ status: "waiting", quest: proposal }),
              )
            }
          />
        );
      })}
      {unlockedLeft.map((mission, index) => {
        const key = `unlock:${mission.skillKey}`;
        return (
          <ListRow
            key={key}
            row={unlockedQuestRow(mission)}
            divided={
              active.length + offeredLeft.length + waitingLeft.length > 0 || index > 0
            }
            busy={startingUnit === key}
            disabled={startingUnit !== null && startingUnit !== key}
            onDismiss={() =>
              dismiss(key, questDismissal({ status: "unlocked", quest: mission }))
            }
            onPress={() => startUnlockedMission(mission)}
            onReplyPress={openThread}
          />
        );
      })}
      {alreadyShown.map((quest, index) =>
        approvedRow(
          quest,
          active.length + offeredLeft.length + waitingLeft.length + unlockedLeft.length > 0 ||
            index > 0,
        ),
      )}
    </QueueSurface>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    propose: {
      minHeight: TOUCH,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      borderWidth: 1,
      borderColor: c.violet,
      // The same corners as the rows' verb buttons below it (ListRow's 10),
      // and web's outline Button.
      borderRadius: 10,
      backgroundColor: c.bg,
      paddingHorizontal: 14,
    },
    proposeText: {
      color: c.violet,
      fontFamily: fonts.bold,
      fontSize: 14,
    },
    pressed: { opacity: 0.8 },
    locked: { opacity: 0.45 },
  });
}
