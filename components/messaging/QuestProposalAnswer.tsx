"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { Box, Button, HStack, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { serverErrorMessage } from "@/lib/serverErrorMessage";

/**
 * Approve / Not this one, under a Quest proposal in a teacher's Messages
 * (TRA-689; review/quests-rebuilt-proposal.html, "Conversations live in
 * Messages"). Slack's button writes through the same mutation.
 *
 * `proposal` is `questProposals.forStaff`: null for anyone who may not answer
 * (no buttons, nothing shown), otherwise the state and the revision the
 * buttons carry. The server refuses a stale revision in plain words; the
 * query has already moved to the new revision by then, so showing the message
 * is the whole recovery.
 */
export function QuestProposalAnswer({
  unitId,
  proposal,
}: {
  unitId: Id<"units">;
  proposal: {
    state: "waiting" | "approved" | "declined";
    revision: number;
    answeredByName: string | null;
  } | null;
}) {
  const answer = useMutation(api.questProposals.answerProposal);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!proposal) return null;

  if (proposal.state !== "waiting") {
    const who = proposal.answeredByName ?? "a teacher";
    return (
      <Text
        fontFamily="body"
        fontSize="xs"
        color="charcoal.500"
        data-testid="quest-proposal-answered"
      >
        {proposal.state === "approved"
          ? `Approved by ${who}`
          : `Marked not this one by ${who}`}
      </Text>
    );
  }

  const send = async (choice: "approve" | "decline") => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await answer({
        unitId,
        answer: choice,
        expectedRevision: proposal.revision,
      });
    } catch (e) {
      setError(serverErrorMessage(e, "That didn't go through. Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box data-testid="quest-proposal-answer">
      <HStack gap={2}>
        <Button
          size="xs"
          bg="violet.500"
          color="white"
          _hover={{ bg: "violet.600" }}
          fontFamily="heading"
          disabled={busy}
          onClick={() => void send("approve")}
        >
          Approve
        </Button>
        <Button
          size="xs"
          variant="outline"
          borderColor="gray.200"
          color="charcoal.600"
          fontFamily="heading"
          disabled={busy}
          onClick={() => void send("decline")}
        >
          Not this one
        </Button>
      </HStack>
      {error && (
        <Text fontFamily="body" fontSize="xs" color="red.500" mt={1.5}>
          {error}
        </Text>
      )}
    </Box>
  );
}
