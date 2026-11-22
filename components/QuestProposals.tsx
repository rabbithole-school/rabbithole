"use client";

/**
 * A kid's own proposals on the Quests tab (TRA-694; review/quests-rebuilt-
 * proposal.html, "Proposing a Quest", the Quests-tab figure, figure 12):
 *
 *   - ProposeQuestButton: "Propose a Quest", with the rocket, beside the
 *     tab's Quests heading where "+ Custom Quest" was. It opens a new chat of
 *     the kid's own and sends "I want to propose a Quest." as its first turn
 *     (the same in-memory handover the "I wonder…" box uses,
 *     lib/wonderFirstTurn.ts), so the tutor asks what they want to make and
 *     then offers the proposal card (components/QuestProposalCard.tsx).
 *   - QuestProposalRows: the kid's approved Quests, then a teacher's offers
 *     ("Picked for you by Ms. Rivera": "Start building" starts the offer, then
 *     opens its maker like an approved Quest's, TRA-698), then the proposals
 *     still waiting for a teacher (`questProposals.forSelf`), each drawn with the
 *     one row (components/ui/ListRow). An approved Quest's "Start building" /
 *     "Continue" opens its maker activity's session (`sessions.create` finds
 *     the one already begun); a waiting proposal's "View", and any row's
 *     "Ms. Rivera replied", open the Quest's thread in Messages. Last come
 *     the "Code it" missions that unlocked on their own ("Unlocked by your
 *     practice"): "Start building" starts one (`startUnlockedCodeIt`) and
 *     opens its maker. Every row ends in the same quiet ×; what it does is
 *     the row's (shared/questRows.ts `questDismissal`). The row leaves at
 *     once and comes back with a toast if the write fails, as a wonder row
 *     does (WonderLists.tsx). A started Quest asks first.
 *
 * The page reads `forSelf` once (`useQuestProposals`) and passes it here and
 * to the older Quest lists, which leave these units out (shared/questRows.ts
 * `proposalUnitIds`), so no Quest shows twice.
 *
 * Words: shared/questRows.ts, shared with the BunnyPad twin.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { Button } from "@chakra-ui/react";
import { RocketLaunch } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { ListRow } from "@/components/ui/ListRow";
import { Surface } from "@/components/ui/Surface";
import { useContainedQuery } from "@/hooks/useContainedQuery";
import { serverErrorMessage } from "@/lib/serverErrorMessage";
import { toaster } from "@/lib/toaster";
import { setWonderFirstTurn } from "@/lib/wonderFirstTurn";
import {
  QUEST_COPY,
  QUEST_DISMISS_CONFIRM,
  proposalRows,
  questDismissal,
} from "@/shared/questRows";

export type QuestProposalsRead = FunctionReturnType<typeof api.questProposals.forSelf>;

/** The kid's proposals, or null while loading, off the Quests tab, or when
 *  the read fails (contained: the tab still draws its other lists). */
export function useQuestProposals(enabled: boolean): QuestProposalsRead | null {
  const { data } = useContainedQuery(api.questProposals.forSelf, enabled ? {} : "skip");
  return enabled && data ? data : null;
}

export function ProposeQuestButton() {
  const router = useRouter();
  const createSession = useMutation(api.sessions.create);
  const [opening, setOpening] = useState(false);
  const open = async () => {
    if (opening) return;
    setOpening(true);
    try {
      const { id } = await createSession({});
      setWonderFirstTurn(String(id), { text: QUEST_COPY.proposeOpener, inputModality: "typed" });
      router.push(`/scholar/${id}`);
      // Navigation unmounts the button; `opening` stays up until it does.
    } catch (error) {
      console.error("[propose-quest] couldn't open the chat", error);
      toaster.error({ title: serverErrorMessage(error, "Couldn't start a proposal") });
      setOpening(false);
    }
  };
  return (
    <Button
      size="xs"
      variant="outline"
      colorPalette="violet"
      fontFamily="heading"
      fontWeight="600"
      loading={opening}
      onClick={() => void open()}
    >
      <RocketLaunch size={14} weight="fill" />
      {QUEST_COPY.proposeAQuest}
    </Button>
  );
}

export function QuestProposalRows({ read }: { read: QuestProposalsRead }) {
  const router = useRouter();
  const createSession = useMutation(api.sessions.create);
  const startOffer = useMutation(api.questProposals.startOfferedQuest);
  const startUnlocked = useMutation(api.questProposals.startUnlockedCodeIt);
  const dismissQuest = useMutation(api.questProposals.dismissQuest);
  const dismissUnlocked = useMutation(api.questProposals.dismissUnlockedCodeIt);
  // The row being opened, by its key (an unlocked mission has no unit yet).
  const [startingKey, setStartingKey] = useState<string | null>(null);
  // Dismissed this visit, by row key: hidden at once, before the read
  // catches up, and shown again if the write fails.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const rows = proposalRows(read).filter((entry) => !dismissed.has(entry.row.key));
  if (rows.length === 0) return null;

  const openThread = (threadId: string | null) =>
    router.push(threadId ? `/scholar/messages?thread=${threadId}` : "/scholar/messages");

  // Opens the Quest's maker activity once `activity` resolves it: finds the
  // session already begun on the activity, or starts it.
  const openMaker = async (key: string, activity: () => Promise<Id<"activities">>) => {
    if (startingKey) return;
    setStartingKey(key);
    try {
      const activityId = await activity();
      const { id } = await createSession({ activityId });
      router.push(`/scholar/${id}`);
    } catch (error) {
      console.error("[quest-proposals] couldn't open the Quest", error);
      toaster.error({ title: serverErrorMessage(error, "Couldn't open that Quest") });
      setStartingKey(null);
    }
  };

  // A teacher's offer, or an unlocked mission: start it (the server returns
  // the same maker activity for a second tap), then open it the way an
  // approved Quest opens.
  const startOffered = (key: string, unitId: string) =>
    openMaker(key, async () =>
      (await startOffer({ unitId: unitId as Id<"units"> })).activityId,
    );
  const startUnlockedMission = (key: string, skillKey: string) =>
    openMaker(key, async () => (await startUnlocked({ skillKey })).activityId);

  // The row's ×. A started Quest asks first; the others go at once.
  const dismiss = (entry: (typeof rows)[number]) => {
    const key = entry.row.key;
    const what = questDismissal(entry);
    if (
      what.confirm &&
      !window.confirm(`${QUEST_DISMISS_CONFIRM.title}\n\n${QUEST_DISMISS_CONFIRM.body}`)
    ) {
      return;
    }
    setDismissed((prev) => new Set(prev).add(key));
    const write =
      what.mutation === "dismissUnlockedCodeIt"
        ? dismissUnlocked({ skillKey: what.skillKey })
        : dismissQuest({ unitId: what.unitId as Id<"units"> });
    write.catch((error: unknown) => {
      console.error("[quest-proposals] dismiss not recorded", error);
      setDismissed((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      toaster.error({ title: serverErrorMessage(error, QUEST_COPY.dismissFailed) });
    });
  };

  return (
    <Surface p={0} overflow="hidden">
      {rows.map((entry, index) => {
        const key = entry.row.key;
        const onPress = () => {
          switch (entry.status) {
            case "approved": {
              const activityId = entry.quest.activityId;
              void openMaker(key, async () => activityId);
              return;
            }
            case "offered":
              void startOffered(key, String(entry.quest.unitId));
              return;
            case "unlocked":
              void startUnlockedMission(key, entry.quest.skillKey);
              return;
            case "waiting":
              openThread(entry.quest.threadId);
              return;
          }
        };
        return (
          <ListRow
            key={key}
            row={entry.row}
            divided={index > 0}
            busy={startingKey === key}
            disabled={startingKey !== null}
            onReplyPress={(threadId) => openThread(threadId)}
            onDismiss={() => dismiss(entry)}
            onPress={onPress}
          />
        );
      })}
    </Surface>
  );
}
