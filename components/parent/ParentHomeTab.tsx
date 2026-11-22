"use client";

/**
 * The parent portal's Home tab: what a family needs this week, in one
 * screen. Andy's call on the parent portal decision board (2026-11-18): the
 * portal opens here instead of on Records.
 *
 * Every block reuses a read another tab already makes and links out to that
 * tab, so nothing is drawn a second way (T1): forms (Records), unread
 * messages (Messages), this week's homework drawn by the Homework tab's own
 * week block, the next day off (Calendar), and the BunnyPad's freeze
 * (BunnyPad). A staff preview shows only the blocks it may read.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { Box, Heading, HStack, Text, VStack } from "@chakra-ui/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Surface } from "@/components/ui/Surface";
import { useNow } from "@/hooks/useNow";
import { formatBedtimeClock } from "@/shared/bedtime";
import { ParentHomeworkThisWeek } from "./ParentHomeworkTab";
import { rangeLabel } from "./ParentCalendarTab";

function LinkRow({
  label,
  detail,
  href,
  action,
}: {
  label: string;
  detail?: string | null;
  href: string;
  action: string;
}) {
  return (
    <HStack justify="space-between" align="center" gap={3} px={4} py={3}>
      <Box minW={0}>
        <Text fontFamily="heading" fontWeight="600" fontSize="sm" color="charcoal.700">
          {label}
        </Text>
        {detail && (
          <Text fontFamily="body" fontSize="sm" color="charcoal.500" lineClamp={2}>
            {detail}
          </Text>
        )}
      </Box>
      <Link href={href} style={{ flexShrink: 0 }}>
        <Text as="span" fontFamily="heading" fontSize="sm" fontWeight="600" color="violet.600">
          {action} ›
        </Text>
      </Link>
    </HStack>
  );
}

function SectionHeading({
  children,
  href,
  action,
}: {
  children: ReactNode;
  href: string;
  action: string;
}) {
  return (
    <HStack justify="space-between" px={4} pt={3} pb={1}>
      <Heading as="h2" fontSize="sm" fontFamily="heading" color="navy.500">
        {children}
      </Heading>
      <Link href={href}>
        <Text as="span" fontFamily="heading" fontSize="sm" fontWeight="600" color="violet.600">
          {action} ›
        </Text>
      </Link>
    </HStack>
  );
}

export function ParentHomeTab({
  scholarId,
  childName,
  hrefQuery,
  preview,
  formsBanner,
  pictureNote,
}: {
  scholarId: Id<"users">;
  childName: string;
  /** `?child=…` (or `?remote=…` in a staff preview), carried on every link. */
  hrefQuery: string;
  preview: boolean;
  /** The Records forms banner, which shows itself only when forms need the
   *  family. Passed in so school-only form code stays with the dashboard. */
  formsBanner?: ReactNode;
  /** The portal's standing "part of the picture" note, under the heading. */
  pictureNote?: ReactNode;
}) {
  const now = useNow(30_000);
  const tabHref = (tab: string) => `/parent/${tab}${hrefQuery}`;
  const calendar = useQuery(api.academicCalendar.upcomingForScholar, { scholarId });
  // Guardian-only reads; a staff preview skips them.
  const threads = useQuery(
    api.parentMessages.listMyGuardianThreads,
    preview ? "skip" : {},
  );
  const bunnyPad = useQuery(
    api.scheduledFreezes.forParentCard,
    preview ? "skip" : { scholarId },
  );

  const firstName = childName.split(" ")[0] || "Your child";
  const unread = (threads ?? []).filter(
    (thread) =>
      thread.hasUnread &&
      (thread.scholarName === null || thread.scholarName === childName),
  );
  const nextDayOff = calendar?.upcoming[0] ?? null;

  let bunnyPadLine: { label: string; detail: string | null } | null = null;
  if (bunnyPad) {
    const frozen = bunnyPad.devices.filter(
      (d) => d.frozenUntil !== null && d.frozenUntil > now,
    );
    const until = (rows: typeof frozen) =>
      formatBedtimeClock(Math.max(...rows.map((d) => d.frozenUntil!)), bunnyPad.timeZone);
    const school = frozen.filter((d) => d.frozenBy === "school");
    const nextPlan = bunnyPad.plans[0]?.text ?? null;
    bunnyPadLine =
      school.length > 0
        ? { label: `Frozen by the school until ${until(school)}`, detail: null }
        : frozen.length > 0
          ? { label: `Frozen until ${until(frozen)}`, detail: nextPlan && `Planned: ${nextPlan}` }
          : { label: "Not frozen", detail: nextPlan ? `Planned: ${nextPlan}` : null };
  }

  return (
    <VStack align="stretch" gap={4}>
      <Heading as="h1" size="lg" fontFamily="heading" color="navy.500">
        {firstName}&apos;s week
      </Heading>

      {formsBanner}

      {pictureNote}

      {unread.length > 0 && (
        <Surface p={0} overflow="hidden">
          {unread.slice(0, 3).map((thread, index) => (
            <Box key={thread._id} borderTopWidth={index === 0 ? 0 : "1px"} borderColor="gray.100">
              <LinkRow
                label={`New message from ${thread.lastMessageAuthorName ?? thread.teacherName ?? "the school"}`}
                detail={thread.lastPreview || null}
                href={tabHref("messages")}
                action="Read"
              />
            </Box>
          ))}
        </Surface>
      )}

      <Surface p={0} overflow="hidden">
        <SectionHeading href={tabHref("homework")} action="Whole month">
          Homework
        </SectionHeading>
        <ParentHomeworkThisWeek scholarId={scholarId} />
      </Surface>

      {(calendar || bunnyPadLine) && (
        <Surface p={0} overflow="hidden">
          {calendar && (
            <LinkRow
              label={nextDayOff ? `No school: ${nextDayOff.label}` : "No days off coming up"}
              detail={nextDayOff ? rangeLabel(nextDayOff.startDayKey, nextDayOff.endDayKey) : null}
              href={tabHref("calendar")}
              action="Calendar"
            />
          )}
          {bunnyPadLine && (
            <Box borderTopWidth={calendar ? "1px" : 0} borderColor="gray.100">
              <LinkRow
                label={`BunnyPad: ${bunnyPadLine.label}`}
                detail={bunnyPadLine.detail}
                href={tabHref("bunnypad")}
                action="BunnyPad"
              />
            </Box>
          )}
        </Surface>
      )}
    </VStack>
  );
}
