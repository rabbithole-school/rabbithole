"use client";

// Withdrawn: mark a scholar who has left the school, or undo it. Lives in the
// scholar profile's details card. Nothing is deleted; a withdrawn scholar just
// leaves current-scholar lists (see users.withdrawnOn in convex/schema.ts).

import { useState } from "react";
import { Box, Button, HStack, Input, Text } from "@chakra-ui/react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toaster } from "@/lib/toaster";
import { serverErrorMessage } from "@/lib/serverErrorMessage";
import { formatWithdrawalDate } from "@/shared/scholarWithdrawal";

function localToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function ScholarWithdrawalControl({
  scholarId,
  withdrawnOn,
}: {
  scholarId: Id<"users">;
  withdrawnOn: string | null;
}) {
  const setWithdrawal = useMutation(api.scholars.setWithdrawal);
  const [date, setDate] = useState<string>(localToday);
  const [saving, setSaving] = useState(false);

  const save = async (next: string | null) => {
    setSaving(true);
    try {
      await setWithdrawal({ scholarId, withdrawnOn: next });
    } catch (error) {
      toaster.error({
        title: next
          ? "Couldn't mark as withdrawn"
          : "Couldn't undo the withdrawal",
        description: serverErrorMessage(error) || undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box>
      <Text fontSize="xs" color="charcoal.400" fontFamily="heading" mb={1}>
        Withdrawn
      </Text>
      {withdrawnOn ? (
        <HStack gap={3} wrap="wrap">
          <Text fontSize="sm" fontFamily="body" color="charcoal.500">
            Left the school on {formatWithdrawalDate(withdrawnOn)}
          </Text>
          <Button
            size="sm"
            variant="outline"
            fontFamily="heading"
            fontSize="sm"
            disabled={saving}
            onClick={() => save(null)}
          >
            {saving ? "Saving…" : "Undo withdrawal"}
          </Button>
        </HStack>
      ) : (
        <HStack gap={2} wrap="wrap">
          <Input
            size="sm"
            type="date"
            w="auto"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            fontFamily="body"
            aria-label="Withdrawal date"
          />
          <Button
            size="sm"
            variant="outline"
            fontFamily="heading"
            fontSize="sm"
            disabled={saving || !date}
            onClick={() => save(date)}
          >
            {saving ? "Saving…" : "Mark as withdrawn"}
          </Button>
        </HStack>
      )}
      <Text fontSize="2xs" color="charcoal.300" fontFamily="body" mt={1}>
        For a scholar who has left the school. Their records stay; they drop off
        rosters, form lists and attendance. You can undo this.
      </Text>
    </Box>
  );
}
