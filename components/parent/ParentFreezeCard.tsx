"use client";

/**
 * The BunnyPad tab's freeze card: freeze the child's BunnyPad now
 * (for a while, or until a time), unfreeze a family freeze, and plan freezes
 * ahead — once, or on days of the week. The parent aide does the same by
 * text; both go through convex/scheduledFreezes.ts and deviceLock.ts's
 * guardian rules. Hidden when the child has no BunnyPad paired.
 */
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Box,
  Button,
  Field,
  Heading,
  HStack,
  Input,
  NativeSelect,
  Stack,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Snowflake } from "@phosphor-icons/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { dayKeyForTimezone } from "@/shared/institutionDay";
import { formatBedtimeClock } from "@/shared/bedtime";
import { serverErrorMessage } from "@/lib/serverErrorMessage";
import { useNow } from "@/hooks/useNow";
import { ParentFormCardShell } from "./ParentFormCardShell";

const LENGTHS = [
  { value: "15", label: "15 minutes" },
  { value: "30", label: "30 minutes" },
  { value: "60", label: "1 hour" },
  { value: "120", label: "2 hours" },
  { value: "until", label: "Until a time" },
];

// Monday first, as a parent reads a week; values are 0 = Sunday.
const DAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

type Repeat = "once" | "weekdays" | "daily" | "custom";

/** "17:33" → 1053, or null. */
function clockMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

type Notice = { ok: boolean; text: string } | null;

export function ParentFreezeCard({
  scholarId,
  childName,
}: {
  scholarId: Id<"users">;
  childName: string;
}) {
  const card = useQuery(api.scheduledFreezes.forParentCard, { scholarId });
  const freezeNow = useMutation(api.scheduledFreezes.freezeNowForScholar);
  const addPlan = useMutation(api.scheduledFreezes.addForScholar);
  const removePlan = useMutation(api.scheduledFreezes.removeForScholar);
  // The freeze end is a boundary; this clock decides when it has passed (T11).
  const now = useNow(30_000);

  const [length, setLength] = useState("60");
  const [untilTime, setUntilTime] = useState("");
  const [planStart, setPlanStart] = useState("18:00");
  const [planEnd, setPlanEnd] = useState("19:00");
  const [repeat, setRepeat] = useState<Repeat>("once");
  const [planDate, setPlanDate] = useState("");
  const [customDays, setCustomDays] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  if (!card) return null;
  const name = childName || "Your child";
  const today = dayKeyForTimezone(now, card.timeZone);

  const frozen = card.devices.filter(
    (d) => d.frozenUntil !== null && d.frozenUntil > now,
  );
  const schoolFrozen = frozen.filter((d) => d.frozenBy === "school");
  const familyFrozen = frozen.filter((d) => d.frozenBy === "family");
  const latest = (rows: typeof frozen) =>
    formatBedtimeClock(Math.max(...rows.map((d) => d.frozenUntil!)), card.timeZone);

  const run = async (action: () => Promise<{ message: string }>, fallback: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const { message } = await action();
      setNotice({ ok: true, text: message });
      return true;
    } catch (error) {
      setNotice({ ok: false, text: serverErrorMessage(error, fallback) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onFreeze = () => {
    if (length === "until") {
      const clock = clockMinutes(untilTime);
      if (clock === null) {
        setNotice({ ok: false, text: "Pick the time the freeze ends." });
        return;
      }
      void run(
        () => freezeNow({ scholarId, frozen: true, untilClockMinutes: clock }),
        "That freeze couldn't be set.",
      );
      return;
    }
    void run(
      () => freezeNow({ scholarId, frozen: true, minutes: Number(length) }),
      "That freeze couldn't be set.",
    );
  };

  const planDays =
    repeat === "weekdays"
      ? [1, 2, 3, 4, 5]
      : repeat === "daily"
        ? [0, 1, 2, 3, 4, 5, 6]
        : repeat === "custom"
          ? customDays
          : [];

  const onAddPlan = async () => {
    const startMinutes = clockMinutes(planStart);
    const endMinutes = clockMinutes(planEnd);
    if (startMinutes === null || endMinutes === null) {
      setNotice({ ok: false, text: "Pick when the freeze starts and ends." });
      return;
    }
    if (repeat === "custom" && customDays.length === 0) {
      setNotice({ ok: false, text: "Pick at least one day." });
      return;
    }
    const added = await run(
      () =>
        addPlan({
          scholarId,
          startMinutes,
          endMinutes,
          ...(repeat === "once"
            ? planDate
              ? { dayKey: planDate }
              : {}
            : { weekdays: planDays }),
        }),
      "That freeze couldn't be planned.",
    );
    if (added) setCustomDays([]);
  };

  return (
    <ParentFormCardShell labelledBy="freeze-heading">
      <Stack direction={{ base: "column", md: "row" }} gap={4} align="flex-start">
        <Box
          flexShrink={0}
          display="inline-flex"
          p={2}
          bg="blue.50"
          borderRadius="lg"
          color="blue.600"
          aria-hidden="true"
        >
          <Snowflake size={24} weight="duotone" />
        </Box>
        <VStack align="stretch" gap={4} flex={1}>
          <Box>
            <Heading id="freeze-heading" size="sm" fontFamily="heading" color="navy.500">
              Freeze
            </Heading>
            <Text fontSize="sm" fontFamily="body" color="charcoal.500" mt={1}>
              {schoolFrozen.length > 0
                ? `The school froze ${name}'s BunnyPad until ${latest(schoolFrozen)}. Only the school can change that.`
                : familyFrozen.length > 0
                  ? `${name}'s BunnyPad is frozen until ${latest(familyFrozen)}.`
                  : `A frozen BunnyPad stays in Rabbithole behind a "frozen" screen until the time you choose. A freeze always ends by the time school starts.`}
            </Text>
          </Box>

          {schoolFrozen.length === 0 && (
            <HStack gap={3} align="flex-end" flexWrap="wrap">
              <Field.Root w="auto">
                <Field.Label fontSize="sm" fontFamily="heading">
                  Freeze for
                </Field.Label>
                <NativeSelect.Root size="sm" w="36">
                  <NativeSelect.Field
                    value={length}
                    onChange={(e) => setLength(e.target.value)}
                  >
                    {LENGTHS.map((l) => (
                      <option key={l.value} value={l.value}>
                        {l.label}
                      </option>
                    ))}
                  </NativeSelect.Field>
                  <NativeSelect.Indicator />
                </NativeSelect.Root>
              </Field.Root>
              {length === "until" && (
                <Field.Root w="auto">
                  <Field.Label fontSize="sm" fontFamily="heading">
                    Ends at
                  </Field.Label>
                  <Input
                    size="sm"
                    type="time"
                    w="32"
                    value={untilTime}
                    onChange={(e) => setUntilTime(e.target.value)}
                  />
                </Field.Root>
              )}
              <Button
                size="sm"
                colorPalette="blue"
                fontFamily="heading"
                loading={busy}
                onClick={onFreeze}
              >
                {familyFrozen.length > 0 ? "Change freeze" : "Freeze now"}
              </Button>
              {familyFrozen.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  fontFamily="heading"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => freezeNow({ scholarId, frozen: false }),
                      "That BunnyPad couldn't be unfrozen.",
                    )
                  }
                >
                  Unfreeze
                </Button>
              )}
            </HStack>
          )}

          <Box borderTopWidth="1px" borderColor="border.default" pt={4}>
            <Heading as="h4" fontSize="sm" fontFamily="heading" color="navy.500">
              Planned freezes
            </Heading>
            {card.plans.length === 0 ? (
              <Text fontSize="sm" fontFamily="body" color="charcoal.400" mt={1}>
                None yet. Plan one for tonight, or for the same time every week.
              </Text>
            ) : (
              <VStack as="ul" align="stretch" gap={1} mt={2} listStyleType="none">
                {card.plans.map((plan) => (
                  <HStack as="li" key={plan.id} justify="space-between" gap={3}>
                    <Text fontSize="sm" fontFamily="body" color="charcoal.600">
                      {plan.text}
                    </Text>
                    <Button
                      size="xs"
                      variant="ghost"
                      fontFamily="heading"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => removePlan({ scheduledFreezeId: plan.id }),
                          "That planned freeze couldn't be removed.",
                        )
                      }
                    >
                      Remove
                    </Button>
                  </HStack>
                ))}
              </VStack>
            )}

            <HStack gap={3} align="flex-end" flexWrap="wrap" mt={3}>
              <Field.Root w="auto">
                <Field.Label fontSize="sm" fontFamily="heading">
                  From
                </Field.Label>
                <Input
                  size="sm"
                  type="time"
                  w="32"
                  value={planStart}
                  onChange={(e) => setPlanStart(e.target.value)}
                />
              </Field.Root>
              <Field.Root w="auto">
                <Field.Label fontSize="sm" fontFamily="heading">
                  To
                </Field.Label>
                <Input
                  size="sm"
                  type="time"
                  w="32"
                  value={planEnd}
                  onChange={(e) => setPlanEnd(e.target.value)}
                />
              </Field.Root>
              <Field.Root w="auto">
                <Field.Label fontSize="sm" fontFamily="heading">
                  Repeat
                </Field.Label>
                <NativeSelect.Root size="sm" w="36">
                  <NativeSelect.Field
                    value={repeat}
                    onChange={(e) => setRepeat(e.target.value as Repeat)}
                  >
                    <option value="once">Just once</option>
                    <option value="weekdays">Every weekday</option>
                    <option value="daily">Every day</option>
                    <option value="custom">Some days</option>
                  </NativeSelect.Field>
                  <NativeSelect.Indicator />
                </NativeSelect.Root>
              </Field.Root>
              {repeat === "once" && (
                <Field.Root w="auto">
                  <Field.Label fontSize="sm" fontFamily="heading">
                    On
                  </Field.Label>
                  <Input
                    size="sm"
                    type="date"
                    w="40"
                    min={today}
                    value={planDate || today}
                    onChange={(e) => setPlanDate(e.target.value)}
                  />
                </Field.Root>
              )}
              <Button
                size="sm"
                variant="outline"
                colorPalette="blue"
                fontFamily="heading"
                loading={busy}
                onClick={() => void onAddPlan()}
              >
                Plan freeze
              </Button>
            </HStack>
            {repeat === "custom" && (
              <HStack gap={1} mt={2} flexWrap="wrap" role="group" aria-label="Days">
                {DAYS.map((day) => {
                  const on = customDays.includes(day.value);
                  return (
                    <Button
                      key={day.value}
                      size="xs"
                      variant={on ? "solid" : "outline"}
                      colorPalette="blue"
                      aria-pressed={on}
                      onClick={() =>
                        setCustomDays((days) =>
                          on ? days.filter((d) => d !== day.value) : [...days, day.value],
                        )
                      }
                    >
                      {day.label}
                    </Button>
                  );
                })}
              </HStack>
            )}
          </Box>

          {notice && (
            <Text
              role="status"
              fontSize="sm"
              fontFamily="body"
              color={notice.ok ? "green.700" : "red.600"}
            >
              {notice.text}
            </Text>
          )}
        </VStack>
      </Stack>
    </ParentFormCardShell>
  );
}
