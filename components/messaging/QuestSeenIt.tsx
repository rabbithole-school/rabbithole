"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { Box, Button, HStack, Input, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { serverErrorMessage } from "@/lib/serverErrorMessage";
import { QUEST_SHOWING_LIMITS } from "@/shared/questRows";

/**
 * "Award badge", under a scholar's "ready to show" line in a teacher's
 * Messages (TRA-684, step 7 as Andy revised it; it was "Seen it" in
 * review/quests-rebuilt-proposal.html). The same button as the advisor's
 * Slack message: it asks for the badge's name, prefilled with a suggestion
 * (the Quest's title) the teacher can accept, and awards through
 * `questShowing.awardBadge`, the core Slack's button shares.
 *
 * Shown only while `questProposals.forStaff` says the Quest waits to be seen
 * (null for anyone who may not award). After the award the thread carries the
 * award line and the read drops the button. The prompt is inline, not a
 * Dialog, so it can't leak a body lock (engineering-principles).
 */
export function QuestSeenIt({
  unitId,
  title,
}: {
  unitId: Id<"units">;
  title: string;
}) {
  const award = useMutation(api.questShowing.awardBadge);
  const max = QUEST_SHOWING_LIMITS.maxBadgeName;
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const open = () => {
    setName(title.trim().replace(/\s+/g, " ").slice(0, max).trim());
    setError("");
    setNaming(true);
  };

  const send = async () => {
    const badgeName = name.trim();
    if (busy || !badgeName) return;
    setBusy(true);
    setError("");
    try {
      await award({ unitId, badgeName });
      setNaming(false);
    } catch (e) {
      setError(serverErrorMessage(e, "That didn't go through. Try again."));
    } finally {
      setBusy(false);
    }
  };

  if (!naming) {
    return (
      <Button
        size="xs"
        bg="violet.500"
        color="white"
        _hover={{ bg: "violet.600" }}
        fontFamily="heading"
        onClick={open}
        data-testid="quest-seen-it"
      >
        Award badge
      </Button>
    );
  }

  return (
    <Box maxW="sm" data-testid="quest-seen-it-name">
      <Text fontFamily="heading" fontWeight="700" fontSize="xs" color="navy.500" mb={1}>
        Name the badge
      </Text>
      <Input
        size="sm"
        value={name}
        maxLength={max}
        autoFocus
        aria-label="Badge name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void send();
          if (e.key === "Escape") setNaming(false);
        }}
      />
      <HStack gap={2} mt={2}>
        <Button
          size="xs"
          bg="violet.500"
          color="white"
          _hover={{ bg: "violet.600" }}
          fontFamily="heading"
          disabled={busy || !name.trim()}
          onClick={() => void send()}
        >
          Award badge
        </Button>
        <Button
          size="xs"
          variant="outline"
          borderColor="gray.200"
          color="charcoal.600"
          fontFamily="heading"
          disabled={busy}
          onClick={() => setNaming(false)}
        >
          Cancel
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
