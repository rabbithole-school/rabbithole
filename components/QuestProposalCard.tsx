"use client";

/**
 * The tutor's proposal card in a chat (TRA-694; review/quests-rebuilt-
 * proposal.html, "Proposing a Quest", figure 4). The tutor puts it in the
 * chat when a kid says they want to make something (convex/lib/
 * questProposalCard.ts, a `role: "tool"` row carrying `questProposalCard`).
 *
 * It shows the kid's own words once, the drafted one-line mission (the kid
 * can change it), and what it will be ("An app" / "A presentation" / "A
 * Python program", switchable). "Propose" is the one solid button and
 * carries the rocket: it calls `questProposals.propose` with the card's
 * fields, the chat it came from and the card itself (`cardMessageId`), then
 * opens the Quest's thread in Messages. Nothing is proposed before that tap,
 * and a card proposes once: the server stamps `proposedUnitId` on it and a
 * repeat tap returns the same Quest.
 *
 * Once proposed (`proposedUnitId`), the card reads "Proposed · Waiting for a
 * teacher" (or "Proposed · Advisor: Ms. Rivera" once approved) with a "View"
 * link to the Quest's thread, and shows the mission and kind as they now
 * stand, from `questProposals.forSelf`.
 *
 * Read-only in a teacher's remote view: the words, the mission and the kind,
 * no controls.
 *
 * Words: shared/questRows.ts (`QUEST_COPY`), shared with the BunnyPad twin.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { Box, Button, Flex, HStack, Input, Stack, Text } from "@chakra-ui/react";
import { Check, RocketLaunch } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useContainedQuery } from "@/hooks/useContainedQuery";
import { serverErrorMessage } from "@/lib/serverErrorMessage";
import { toaster } from "@/lib/toaster";
import {
  QUEST_COPY,
  QUEST_KINDS,
  questKindLabel,
  type QuestKind,
} from "@/shared/questRows";

/** The card as the tool row stores it (`messages.questProposalCard`). */
export type QuestProposalCardData = {
  scholarWords: string;
  mission: string;
  kind: QuestKind;
  title?: string;
  /** The Quest this card became, once the kid tapped Propose. */
  proposedUnitId?: Id<"units">;
};

/** The mission limit `propose` enforces (QUEST_PROPOSAL_CARD_LIMITS). */
const MISSION_MAX = 140;

export function QuestProposalCard({
  messageId,
  sessionId,
  card,
  interactive,
}: {
  messageId: Id<"messages">;
  sessionId: Id<"sessions">;
  card: QuestProposalCardData;
  interactive: boolean;
}) {
  const router = useRouter();
  const propose = useMutation(api.questProposals.propose);
  const [mission, setMission] = useState(card.mission);
  const [editingMission, setEditingMission] = useState(false);
  const [kind, setKind] = useState<QuestKind>(card.kind);
  const [proposing, setProposing] = useState(false);

  // The Quest the card became, as it stands now: a waiting proposal the kid
  // may have edited in Messages, or an approved Quest with its advisor.
  const proposedUnitId = card.proposedUnitId ? String(card.proposedUnitId) : null;
  const { data: mine } = useContainedQuery(
    api.questProposals.forSelf,
    proposedUnitId && interactive ? {} : "skip",
  );
  const waiting = mine?.waiting.find((q) => String(q.unitId) === proposedUnitId);
  const approved = mine?.approved.find((q) => String(q.unitId) === proposedUnitId);
  const quest = waiting ?? approved ?? null;
  const proposedStatus = approved
    ? approved.advisorName?.trim()
      ? QUEST_COPY.advisor(approved.advisorName.trim())
      : QUEST_COPY.advisorUnnamed
    : waiting
      ? QUEST_COPY.waiting
      : null;

  const openThread = (threadId: string | null) => {
    router.push(threadId ? `/scholar/messages?thread=${threadId}` : "/scholar/messages");
  };

  const submit = async () => {
    if (!interactive || proposing || proposedUnitId) return;
    const line = mission.trim();
    if (!line) {
      setEditingMission(true);
      return;
    }
    setProposing(true);
    try {
      const { threadId } = await propose({
        scholarWords: card.scholarWords,
        mission: line,
        kind,
        ...(card.title ? { title: card.title } : {}),
        fromSessionId: sessionId,
        cardMessageId: messageId,
      });
      openThread(threadId ? String(threadId) : null);
      // Navigation unmounts the card; `proposing` stays up until it does.
    } catch (error) {
      console.error("[quest-proposal] propose failed", error);
      toaster.error({ title: serverErrorMessage(error, "Couldn't send that proposal") });
      setProposing(false);
    }
  };

  const proposed = proposedUnitId !== null;
  const locked = !interactive || proposing || proposed;
  const shownMission = quest?.mission || mission;
  const shownKind = quest?.kind ?? kind;

  return (
    <Flex justify="flex-start" py={1}>
      <Box
        w="full"
        maxW="560px"
        bg="white"
        borderWidth="1px"
        borderColor="gray.200"
        borderRadius="xl"
        px={{ base: 4, md: 5 }}
        py={4}
      >
        <Stack gap={3}>
          <Text fontFamily="heading" fontWeight="700" fontSize="md" color="navy.500">
            {QUEST_COPY.cardTitle}
          </Text>
          <Box
            bg="gray.50"
            borderRadius="lg"
            px={3.5}
            py={2.5}
            fontFamily="body"
            fontSize="sm"
            lineHeight="1.45"
            color="navy.500"
          >
            “{card.scholarWords}”
          </Box>

          <Stack gap={1}>
            <Text
              fontFamily="heading"
              fontSize="xs"
              fontWeight="600"
              letterSpacing="wide"
              textTransform="uppercase"
              color="charcoal.400"
            >
              {QUEST_COPY.cardMission}
            </Text>
            {editingMission && !locked ? (
              <HStack gap={2}>
                <Input
                  value={mission}
                  onChange={(event) => setMission(event.target.value.slice(0, MISSION_MAX))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      if (mission.trim()) setEditingMission(false);
                    }
                  }}
                  aria-label={QUEST_COPY.cardMission}
                  autoFocus
                  size="sm"
                  // 16px keeps iOS Safari from zooming into the field.
                  fontSize="16px"
                  fontFamily="body"
                  maxLength={MISSION_MAX}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  colorPalette="violet"
                  fontFamily="heading"
                  disabled={!mission.trim()}
                  onClick={() => setEditingMission(false)}
                >
                  {QUEST_COPY.cardMissionDone}
                </Button>
              </HStack>
            ) : (
              <Flex align="baseline" justify="space-between" gap={3}>
                <Text fontFamily="body" fontSize="sm" lineHeight="1.45" color="navy.500">
                  {shownMission}
                </Text>
                {!locked && (
                  <Box
                    as="button"
                    flexShrink={0}
                    fontFamily="heading"
                    fontSize="sm"
                    fontWeight="600"
                    color="violet.600"
                    textDecoration="underline"
                    cursor="pointer"
                    onClick={() => setEditingMission(true)}
                  >
                    {QUEST_COPY.cardChangeMission}
                  </Box>
                )}
              </Flex>
            )}
          </Stack>

          <Flex align="center" gap={2} wrap="wrap">
            <Text fontFamily="heading" fontSize="sm" color="charcoal.500">
              {QUEST_COPY.cardKindPrompt}
            </Text>
            {locked ? (
              <Text fontFamily="heading" fontSize="sm" fontWeight="600" color="navy.500">
                {questKindLabel(shownKind)}
              </Text>
            ) : (
              <HStack
                role="radiogroup"
                aria-label={QUEST_COPY.cardKindPrompt}
                gap={0.5}
                p={0.5}
                bg="gray.100"
                borderRadius="lg"
                wrap="wrap"
              >
                {QUEST_KINDS.map((option) => {
                  const on = option === kind;
                  return (
                    <Box
                      key={option}
                      as="button"
                      role="radio"
                      aria-checked={on}
                      display="inline-flex"
                      alignItems="center"
                      gap={1}
                      px={3}
                      py={1}
                      borderRadius="md"
                      fontFamily="heading"
                      fontSize="sm"
                      fontWeight="600"
                      whiteSpace="nowrap"
                      cursor="pointer"
                      bg={on ? "white" : "transparent"}
                      color={on ? "violet.700" : "charcoal.500"}
                      boxShadow={on ? "0 1px 2px rgba(16, 24, 40, 0.14)" : undefined}
                      onClick={() => setKind(option)}
                    >
                      {on && <Check size={12} weight="bold" />}
                      {questKindLabel(option)}
                    </Box>
                  );
                })}
              </HStack>
            )}
          </Flex>

          <Box borderTopWidth="1px" borderColor="gray.100" />

          {proposed ? (
            <Flex align="center" gap={3} wrap="wrap">
              <Text fontFamily="heading" fontSize="sm" color="charcoal.500">
                {proposedStatus
                  ? `${QUEST_COPY.cardProposed} · ${proposedStatus}`
                  : QUEST_COPY.cardProposed}
              </Text>
              {interactive && (
                <Button
                  size="sm"
                  variant="ghost"
                  colorPalette="gray"
                  fontFamily="heading"
                  fontWeight="600"
                  onClick={() => openThread(quest?.threadId ? String(quest.threadId) : null)}
                >
                  {QUEST_COPY.view}
                </Button>
              )}
            </Flex>
          ) : interactive ? (
            <Flex align="center" gap={4} wrap="wrap">
              <Button
                size="sm"
                minH="40px"
                variant="solid"
                colorPalette="violet"
                fontFamily="heading"
                fontWeight="600"
                loading={proposing}
                disabled={proposing || (editingMission && !mission.trim())}
                onClick={() => void submit()}
              >
                <RocketLaunch size={16} weight="fill" />
                {QUEST_COPY.cardPropose}
              </Button>
              <Text fontFamily="heading" fontSize="xs" color="charcoal.400">
                {QUEST_COPY.cardProposeHint}
              </Text>
            </Flex>
          ) : null}
        </Stack>
      </Box>
    </Flex>
  );
}
