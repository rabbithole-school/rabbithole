"use client";

/**
 * Summary tab of the unit surface — the read view + the unit's maturity
 * timeline (the relocated, verticalized rail: Draft → Reviewed → Rehearsed
 * → Assigned → Debriefed). Status lives where its altitude is — a coarse
 * dot on the outline node + this fuller timeline on the Summary. See
 * review/curriculum-rehearse-and-maturity.md.
 *
 * What it deliberately does NOT carry:
 *  - the "Edit in designer" button — editing is the Edit *tab*.
 *  - Archive / Delete — the shared header overflow menu owns those.
 *  - Assignments — they moved to the **Assign** tab (AssignPane).
 */
import { useQuery } from "convex/react";
import type { ReactNode } from "react";
import { Box, Flex, HStack, Skeleton, Stack, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";
import { ReadinessInline } from "@/components/curriculumDoc/ReadinessGate";
import { SessionsInline } from "@/components/curriculumDoc/SessionsSignal";
import { EMPTY_SESSIONS } from "@/convex/lib/activitySessions";
import { useCurrentUser } from "@/hooks/useCurrentUser";

export function UnitSummary({
  unitId,
  actions,
}: {
  unitId: Id<"units">;
  actions?: ReactNode;
}) {
  const { user: currentUser } = useCurrentUser();
  // Readiness (the green preflight gate) + Sessions (the violet field record)
  // are curriculum concepts; both queries require unit-edit access, so skip
  // them for a scholar viewing their own IS unit (they'd hit the access check).
  const showMaturity = !!currentUser && currentUser.role !== "scholar";
  const unit = useQuery(api.units.get, { id: unitId });
  const counts = useQuery(api.units.structureCounts, { id: unitId });
  const nodeStatuses = useQuery(
    api.unitMaturity.getNodeStatuses,
    showMaturity ? { unitId } : "skip",
  );
  const sessionsData = useQuery(
    api.activitySessions.getForUnit,
    showMaturity ? { unitId } : "skip",
  );
  const readiness = nodeStatuses?.readiness.unit;
  const sessions = sessionsData?.unit ?? EMPTY_SESSIONS;

  if (unit === undefined || counts === undefined) {
    // Skeleton shaped like the real summary (emoji + title + description +
    // the maturity card) so the center pane reads as solid while it loads,
    // instead of a lone spinner.
    return (
      <Box h="full" overflowY="auto">
        <Stack gap={6} px={8} pt={2} pb={8} maxW="900px" aria-hidden>
          <Flex gap={4} align="flex-start">
            <Skeleton boxSize="48px" borderRadius="md" flexShrink={0} />
            <Stack gap={2} flex={1} minW={0}>
              <Skeleton height="28px" w="55%" maxW="360px" borderRadius="md" />
              <Skeleton height="14px" w="92%" maxW="620px" borderRadius="sm" />
              <Skeleton height="14px" w="76%" maxW="540px" borderRadius="sm" />
              <Skeleton height="12px" w="40%" maxW="240px" borderRadius="sm" mt={1} />
            </Stack>
          </Flex>
          {showMaturity && (
            <Stack gap={3}>
              <Skeleton height="10px" w="64px" borderRadius="sm" />
              <Box maxW="420px">
                <Stack gap={4}>
                  {[0, 1, 2, 3, 4].map((i) => (
                    <Flex key={i} gap={3} align="center">
                      <Skeleton boxSize="18px" borderRadius="full" flexShrink={0} />
                      <Stack gap={1.5} flex={1}>
                        <Skeleton height="11px" w="38%" borderRadius="sm" />
                        <Skeleton height="9px" w="56%" borderRadius="sm" />
                      </Stack>
                    </Flex>
                  ))}
                </Stack>
              </Box>
            </Stack>
          )}
        </Stack>
      </Box>
    );
  }
  if (unit === null) {
    return (
      <Flex h="full" align="center" justify="center">
        <Text fontSize="sm" color="charcoal.400">
          Unit not found
        </Text>
      </Flex>
    );
  }

  const lessonCount = counts.lessonCount;
  const totalActivities = counts.activityCount;

  // Subtitle line beneath the description — folds unit structure + badge +
  // author into a single low-key strip instead of a hero stats row.
  const subtitleParts: React.ReactNode[] = [];
  if (lessonCount > 0) {
    subtitleParts.push(
      <span key="l">
        {lessonCount} lesson{lessonCount === 1 ? "" : "s"}
      </span>,
    );
  }
  if (totalActivities > 0) {
    subtitleParts.push(
      <span key="a">
        {totalActivities} activit{totalActivities === 1 ? "y" : "ies"}
      </span>,
    );
  }
  if (unit.badgeOnCompletion) {
    subtitleParts.push(
      <span key="b">
        {unit.badgeOnCompletion.icon ?? "🏅"} {unit.badgeOnCompletion.title}
      </span>,
    );
  }
  if (counts.teacherName) {
    const isMine = !!currentUser && counts.teacherId === currentUser._id;
    // "Authored by" overstates a scholar who merely STARTED a teacher-offered
    // (or AI-baked) quest. Only a from-scratch Custom Quest is truly authored;
    // otherwise the scholar is the spark → "Inspired by". (authorRole unset
    // defaults to "inspired".) Regular teacher curriculum has no
    // authorScholarId and stays "Authored by {teacher}".
    const verb =
      unit.authorScholarId && unit.authorRole !== "author"
        ? "Inspired by"
        : "Authored by";
    subtitleParts.push(
      <span key="auth">
        {verb} {isMine ? "me" : counts.teacherName}
      </span>,
    );
  }

  return (
    <Box h="full" overflowY="auto">
      <Stack gap={6} px={8} pt={2} pb={8} maxW="900px">
        <PageHeader
          leading={
            <Box fontSize="4xl" lineHeight="1">
              {unit.emoji ?? "📘"}
            </Box>
          }
          title={unit.title}
          rightSlot={actions}
          subtitle={
            <Stack gap={1}>
              {unit.description && (
                <Text
                  fontSize="sm"
                  color="charcoal.500"
                  fontFamily="body"
                  maxW="640px"
                >
                  {unit.description}
                </Text>
              )}
              {subtitleParts.length > 0 && (
                <HStack gap={2} mt={0.5} flexWrap="wrap">
                  {subtitleParts.map((part, i) => (
                    <HStack key={i} gap={2}>
                      {i > 0 && (
                        <Text fontSize="xs" color="charcoal.300">
                          ·
                        </Text>
                      )}
                      <Text
                        fontSize="xs"
                        color="charcoal.500"
                        fontFamily="heading"
                        fontWeight="600"
                      >
                        {part}
                      </Text>
                    </HStack>
                  ))}
                </HStack>
              )}
            </Stack>
          }
        />

        {/* MATURITY — the two independent signals (PR #1072 §8): the green
            Readiness preflight gate (Built → Heuristic review → Scholar-bot
            rehearsal → Ready) and the violet Sessions field record. Both roll
            up their per-activity state to the unit here. */}
        {readiness && (
          <Stack gap={3}>
            <SectionEyebrow>Readiness</SectionEyebrow>
            <Box maxW="420px">
              <ReadinessInline readiness={readiness} w="180px" />
            </Box>
            <SectionEyebrow>Sessions</SectionEyebrow>
            <Box maxW="420px">
              <SessionsInline sessions={sessions} />
            </Box>
          </Stack>
        )}
      </Stack>
    </Box>
  );
}
