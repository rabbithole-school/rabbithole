"use client";

/**
 * The scholar's Homework section on the Now tab (web), TRA-581: one surface,
 * split by quiet subheadings — This week, Late, Next week, Later, No date —
 * each left out when empty, so a typical week reads "Homework → This week →
 * one row". The grouping lives in shared/homeworkList.ts and the due wording
 * ("due this week") in shared/homeworkWeek.ts; this file only draws them.
 *
 * Every row has one shape (RowLayout): glyph · title + "Subject · with
 * Teacher" · pill · CTA, the pill on the right just left of the quiet CTA
 * (Start / Continue / Open). In Next week and Later a row with nothing to
 * open yet keeps an empty CTA slot and no click target; started work and
 * open-until work open now keep their CTA (`homeworkRowCta`). The only
 * orange is a late DueChip.
 *
 * The same component draws "Open from class" (TRA-724): the page passes its
 * heading and the one-list week from `buildOpenFromClass`, whose section has
 * no subheading.
 *
 * Native twin: HomeworkSectionNative in native/src/app/index.tsx.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { Box, Flex, HStack, Stack, Text, chakra } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { PlateRow } from "@/components/ScholarPlate";
import { ActivityCardCta } from "@/components/ui/ActivityCard";
import { DueChip, StatusChip } from "@/components/ui/DueChip";
import { ScholarHomeSectionHeader } from "@/components/ui/ScholarHomeSectionHeader";
import { Surface } from "@/components/ui/Surface";
import { GameCapabilityNotice } from "@/components/GameCapabilityNotice";
import { WebAssignmentDoneDialog } from "@/components/WebAssignmentDoneDialog";
import { useGameActivity } from "@/hooks/useGameActivity";
import { useRemote } from "@/hooks/useRemote";
import { useWebAssignment } from "@/hooks/useWebAssignment";
import { toaster } from "@/lib/toaster";
import {
  HOMEWORK_SECTION_HEADING,
  homeworkListRowMeta,
  homeworkRowCta,
  opensOfflinePage,
  showsHomeworkDueChip,
  type HomeworkCta,
  type HomeworkClosures,
  type HomeworkWeek,
} from "@/shared/homeworkList";
import { openUntilPhrase } from "@/shared/openUntil";

const FOCUS_RING = {
  outline: "2px solid",
  outlineColor: "violet.400",
  outlineOffset: "2px",
} as const;

export function HomeworkSection({
  heading = HOMEWORK_SECTION_HEADING,
  week,
  closures,
  nowMs,
  timeZone,
}: {
  /** The section's header: Homework, or Open from class. */
  heading?: string;
  week: HomeworkWeek<PlateRow>;
  closures: HomeworkClosures;
  nowMs: number;
  timeZone: string;
}) {
  const webAssignment = useWebAssignment();
  const gameActivity = useGameActivity();
  const launchers: Launchers = { webAssignment, gameActivity };
  const rowProps = { nowMs, timeZone, closures };

  return (
    <Stack gap={3}>
      <ScholarHomeSectionHeader>{heading}</ScholarHomeSectionHeader>
      <Surface p={0} overflow="hidden">
        {week.sections.map((section, index) => (
          <Box
            key={section.key}
            borderTopWidth={index > 0 ? "1px" : 0}
            borderColor="gray.100"
          >
            {section.heading != null && (
              <HStack px={4} pt={3} pb={1} gap={2} align="baseline">
                <Text fontFamily="heading" fontWeight="700" fontSize="xs" color="charcoal.500">
                  {section.heading}
                </Text>
                {section.range && (
                  <Text fontFamily="heading" fontSize="xs" color="charcoal.400">
                    {section.range}
                  </Text>
                )}
              </HStack>
            )}
            {section.items.map((row) => {
              const cta = homeworkRowCta(row, {
                isOffline: opensOfflinePage(row),
                forecast: !section.actionable,
                nowMs,
              });
              return cta ? (
                <HomeworkRow
                  key={rowKey(row)}
                  row={row}
                  cta={cta}
                  launchers={launchers}
                  {...rowProps}
                />
              ) : (
                <Box key={rowKey(row)} px={4} py={3}>
                  <RowLayout row={row} status={rowStatus(row, rowProps)} cta={null} />
                </Box>
              );
            })}
          </Box>
        ))}
      </Surface>
      <WebAssignmentDoneDialog
        prompt={webAssignment.donePrompt}
        onResolve={webAssignment.resolveDonePrompt}
      />
      <GameCapabilityNotice
        prompt={gameActivity.prompt}
        onDismiss={gameActivity.dismiss}
      />
    </Stack>
  );
}

const rowKey = (row: PlateRow) =>
  `${row.assignmentId ?? ""}-${row.activityId ?? ""}-${row.sessionId ?? ""}`;

const rowMeta = (row: PlateRow) =>
  homeworkListRowMeta({
    // `?? row.subject`: an older backend's row (deploy skew) has no label.
    subject: row.subjectLabel ?? row.subject,
    teacherName: row.teacherName,
    isOffline: row.activityKind === "offline",
  });

/** The row's status: the DueChip ("due this week" on the week's last school
 *  day), or the open-until pill. Reopened work past its date shows none. */
function RowStatus({
  row,
  nowMs,
  timeZone,
  closures,
}: {
  row: PlateRow;
  nowMs: number;
  timeZone: string;
  closures: HomeworkClosures;
}) {
  if (row.openUntil != null) {
    // Open-until work says so on every row: it leaves the list when the day
    // ends instead of going late (shared/openUntil.ts).
    return <StatusChip>{openUntilPhrase(row.openUntil, timeZone, nowMs)}</StatusChip>;
  }
  if (!showsHomeworkDueChip(row, nowMs, timeZone)) return null;
  return <DueChip dueAt={row.dueAt} nowMs={nowMs} timeZone={timeZone} closures={closures} />;
}

/** The row's status node, or null when the row shows none. */
function rowStatus(
  row: PlateRow,
  props: { nowMs: number; timeZone: string; closures: HomeworkClosures },
): React.ReactNode {
  if (row.openUntil == null && !showsHomeworkDueChip(row, props.nowMs, props.timeZone)) {
    return null;
  }
  return <RowStatus row={row} {...props} />;
}

/** Width of the CTA slot: fits "Continue ›", so the pill to its left sits in
 *  the same column on every row, CTA or not. */
const CTA_SLOT_W = "96px";
/** The title's line height; the pill and CTA center on this line. */
const TITLE_LINE = "20px";

/**
 * One homework row: glyph · title + "Subject · with Teacher" · pill · CTA.
 * The pill sits on the right, centered on the title line, immediately left
 * of the CTA slot; a row with no CTA keeps the same empty slot, so every
 * pill lines up. Below `sm` the pill drops under the meta on every row.
 * Native twin: HomeworkListNativeRow in native/src/app/index.tsx.
 */
function RowLayout({
  row,
  status,
  cta,
}: {
  row: PlateRow;
  status: React.ReactNode;
  cta: React.ReactNode;
}) {
  const meta = rowMeta(row);
  return (
    <Flex align="flex-start" gap={3}>
      {/* Two columns: the emoji hangs in its own fixed column and the
          title and meta share one left edge. 16px row padding + 18px
          column + 8px gap = 42px, the same text column as the From today
          cards (14px padding + 18px emoji column + 10px gap). */}
      <HStack gap={2} align="flex-start" flex={1} minW={0}>
        <Text
          w="18px"
          flexShrink={0}
          fontSize="sm"
          lineHeight={TITLE_LINE}
          textAlign="center"
          aria-hidden
        >
          {row.unitEmoji ?? ""}
        </Text>
        <Stack gap={0.5} flex={1} minW={0}>
          <Text
            fontFamily="heading"
            fontWeight="600"
            fontSize="sm"
            lineHeight={TITLE_LINE}
            color="charcoal.600"
            lineClamp={2}
          >
            {row.title}
          </Text>
          {meta && (
            <Text fontSize="xs" color="charcoal.400" fontFamily="heading">
              {meta}
            </Text>
          )}
          {status && (
            <Box display={{ base: "block", sm: "none" }} alignSelf="flex-start" mt={1}>
              {status}
            </Box>
          )}
        </Stack>
      </HStack>
      <HStack flexShrink={0} gap={2} h={TITLE_LINE} align="center">
        {status && <Box display={{ base: "none", sm: "flex" }}>{status}</Box>}
        <Flex w={CTA_SLOT_W} justify="flex-end">
          {cta}
        </Flex>
      </HStack>
    </Flex>
  );
}

type Launchers = {
  webAssignment: ReturnType<typeof useWebAssignment>;
  gameActivity: ReturnType<typeof useGameActivity>;
};

function HomeworkRow({
  row,
  cta,
  nowMs,
  timeZone,
  closures,
  launchers,
}: {
  row: PlateRow;
  cta: HomeworkCta;
  nowMs: number;
  timeZone: string;
  closures: HomeworkClosures;
  launchers: Launchers;
}) {
  const router = useRouter();
  const { stamp } = useRemote();
  const createSession = useMutation(api.sessions.create);
  const openOfflineHomework = useMutation(api.sessions.openOfflineHomework);
  const [starting, setStarting] = useState(false);

  const isOffline = opensOfflinePage(row);

  // Each kind opens through the same shell the rest of the web app uses:
  // websites through useWebAssignment, games through useGameActivity (which
  // shows the capability notice on web), practice sets on the practice page,
  // offline work as its read-only page, and everything else as a session.
  const open = async () => {
    if (starting) return;
    if (!row.activityId) {
      if (row.sessionId) router.push(stamp(`/scholar/${row.sessionId}`));
      return;
    }
    if (row.activityKind === "web") {
      await launchers.webAssignment.launch({
        activityId: row.activityId,
        assignmentId: row.assignmentId,
        title: row.title,
      });
      return;
    }
    if (row.activityKind === "game") {
      await launchers.gameActivity.launch({
        activityId: row.activityId,
        title: row.title,
      });
      return;
    }
    if (row.activityKind === "problem_set" && row.practiceSkillKey) {
      router.push(
        stamp(`/scholar/practice?skill=${encodeURIComponent(row.practiceSkillKey)}`),
      );
      return;
    }
    if (!isOffline && row.sessionId) {
      router.push(stamp(`/scholar/${row.sessionId}`));
      return;
    }
    setStarting(true);
    try {
      if (isOffline) {
        if (!row.assignmentId) return;
        const result = await openOfflineHomework({
          activityId: row.activityId,
          assignmentId: row.assignmentId,
        });
        router.push(stamp(`/scholar/${result.id}`));
        return;
      }
      const result = await createSession({
        activityId: row.activityId,
        ...(row.assignmentId ? { assignmentId: row.assignmentId } : {}),
      });
      if (result) router.push(stamp(`/scholar/${result.id}`));
    } catch (err) {
      console.error("HomeworkRow: failed to open", err);
      toaster.error({
        title: "Couldn't open that",
        description: "Please try again.",
      });
    } finally {
      setStarting(false);
    }
  };

  const actionLabel = cta;
  // No Archive control here: archiving a started homework session would hide
  // live, unfinished work from its only home. Homework leaves the section when
  // the scholar finishes it.
  return (
    <Box
      role="group"
      className="group"
      position="relative"
      px={4}
      py={3}
      opacity={starting ? 0.7 : 1}
      _hover={{ bg: "gray.50" }}
    >
      <RowLayout
        row={row}
        status={rowStatus(row, { nowMs, timeZone, closures })}
        cta={
          <ActivityCardCta loading={starting} showCaret>
            {actionLabel}
          </ActivityCardCta>
        }
      />
      <chakra.button
        type="button"
        position="absolute"
        inset={0}
        cursor="pointer"
        aria-label={`${actionLabel} ${row.title}`}
        onClick={() => void open()}
        _focusVisible={FOCUS_RING}
      />
    </Box>
  );
}
