"use client";

/**
 * The BunnyPad tab's bedtime card (TRA-625): the nightly window the
 * child's BunnyPad sleeps, and a guardian's way to make it stricter. The
 * bounds and copy live in shared/bedtime.ts; the write in
 * convex/scholarBedtimes.ts. The parent aide can set the same thing by text.
 */
import { useState } from "react";
import { useMutation } from "convex/react";
import {
  Box,
  Button,
  Field,
  Heading,
  HStack,
  NativeSelect,
  Stack,
  Text,
  VStack,
} from "@chakra-ui/react";
import { MoonStars } from "@phosphor-icons/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  BEDTIME_END_MINUTES,
  BEDTIME_START_MINUTES,
  EARLIEST_FAMILY_BEDTIME_MINUTES,
  FAMILY_BEDTIME_STEP_MINUTES,
  LATEST_FAMILY_WAKE_MINUTES,
  bedtimeClockText,
  type BedtimeWindow,
} from "@/shared/bedtime";
import { serverErrorMessage } from "@/lib/serverErrorMessage";
import { ParentFormCardShell } from "./ParentFormCardShell";

export type ParentBedtimeStatus = BedtimeWindow & {
  setByFamily: boolean;
  text: string;
};

function steps(from: number, to: number): number[] {
  const out: number[] = [];
  for (let m = from; m <= to; m += FAMILY_BEDTIME_STEP_MINUTES) out.push(m);
  return out;
}

const BEDTIME_CHOICES = steps(EARLIEST_FAMILY_BEDTIME_MINUTES, BEDTIME_START_MINUTES);
const WAKE_CHOICES = steps(BEDTIME_END_MINUTES, LATEST_FAMILY_WAKE_MINUTES);

export function ParentBedtimeCard({
  scholarId,
  childName,
  status,
}: {
  scholarId: Id<"users">;
  childName: string;
  /** From `scholarBedtimes.forParent`. */
  status: ParentBedtimeStatus;
}) {
  const setBedtime = useMutation(api.scholarBedtimes.setForScholar);
  // Null until the parent changes a time, so another guardian's change shows
  // here as it lands.
  const [draft, setDraft] = useState<BedtimeWindow | null>(null);
  const [saving, setSaving] = useState(false);
  // A success notice names the window it saved, so it hides once the bedtime
  // changes some other way (the aide, the other guardian).
  const [notice, setNotice] = useState<{
    ok: boolean;
    text: string;
    savedFor?: BedtimeWindow;
  } | null>(null);
  const noticeShown =
    notice &&
    (!notice.savedFor ||
      (notice.savedFor.startMinutes === status.startMinutes &&
        notice.savedFor.endMinutes === status.endMinutes))
      ? notice
      : null;
  const shown = draft ?? {
    startMinutes: status.startMinutes,
    endMinutes: status.endMinutes,
  };
  const dirty =
    draft !== null &&
    (draft.startMinutes !== status.startMinutes ||
      draft.endMinutes !== status.endMinutes);

  const change = (next: Partial<BedtimeWindow>) => {
    setNotice(null);
    setDraft({ ...shown, ...next });
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const result = await setBedtime({ scholarId, ...draft });
      setDraft(null);
      setNotice({ ok: true, text: result.message, savedFor: draft });
    } catch (error) {
      setNotice({
        ok: false,
        text: serverErrorMessage(error, "That bedtime couldn't be saved."),
      });
    } finally {
      setSaving(false);
    }
  };

  const name = childName || "Your child";
  return (
    <ParentFormCardShell labelledBy="bedtime-heading">
      <Stack direction={{ base: "column", md: "row" }} gap={4} align="flex-start">
        <Box
          flexShrink={0}
          display="inline-flex"
          p={2}
          bg="violet.50"
          borderRadius="lg"
          color="violet.600"
          aria-hidden="true"
        >
          <MoonStars size={24} weight="duotone" />
        </Box>
        <VStack align="stretch" gap={3} flex={1}>
          <Box>
            <Heading
              id="bedtime-heading"
              size="sm"
              fontFamily="heading"
              color="navy.500"
            >
              Bedtime
            </Heading>
            <Text fontSize="sm" fontFamily="body" color="charcoal.500" mt={1}>
              {status.setByFamily
                ? `${name}'s BunnyPad sleeps from ${status.text} every night, the bedtime your family chose.`
                : `${name}'s BunnyPad sleeps from ${status.text} every night, the school's bedtime. You can make it earlier.`}
            </Text>
          </Box>
          <HStack gap={3} align="flex-end" flexWrap="wrap">
            <Field.Root w="auto">
              <Field.Label fontSize="sm" fontFamily="heading">
                Bedtime
              </Field.Label>
              <NativeSelect.Root size="sm" w="32">
                <NativeSelect.Field
                  value={shown.startMinutes}
                  onChange={(e) =>
                    change({ startMinutes: Number(e.target.value) })
                  }
                >
                  {BEDTIME_CHOICES.map((m) => (
                    <option key={m} value={m}>
                      {bedtimeClockText(m)}
                    </option>
                  ))}
                </NativeSelect.Field>
                <NativeSelect.Indicator />
              </NativeSelect.Root>
            </Field.Root>
            <Field.Root w="auto">
              <Field.Label fontSize="sm" fontFamily="heading">
                Wakes up
              </Field.Label>
              <NativeSelect.Root size="sm" w="32">
                <NativeSelect.Field
                  value={shown.endMinutes}
                  onChange={(e) =>
                    change({ endMinutes: Number(e.target.value) })
                  }
                >
                  {WAKE_CHOICES.map((m) => (
                    <option key={m} value={m}>
                      {bedtimeClockText(m)}
                    </option>
                  ))}
                </NativeSelect.Field>
                <NativeSelect.Indicator />
              </NativeSelect.Root>
            </Field.Root>
            {dirty && (
              <HStack gap={2}>
                <Button
                  size="sm"
                  colorPalette="violet"
                  fontFamily="heading"
                  loading={saving}
                  onClick={() => void save()}
                >
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  fontFamily="heading"
                  disabled={saving}
                  onClick={() => setDraft(null)}
                >
                  Cancel
                </Button>
              </HStack>
            )}
          </HStack>
          <Text fontSize="sm" fontFamily="body" color="charcoal.400">
            An earlier bedtime also ends homework time on the BunnyPad.
          </Text>
          {noticeShown && (
            <Text
              role="status"
              fontSize="sm"
              fontFamily="body"
              color={noticeShown.ok ? "green.700" : "red.600"}
            >
              {noticeShown.text}
            </Text>
          )}
        </VStack>
      </Stack>
    </ParentFormCardShell>
  );
}
