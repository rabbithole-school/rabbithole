"use client";

/**
 * ActivityReadBody — the shared read-only activity detail body, extracted from
 * ActivitySummary so the schedule's placement detail drawer can render the SAME
 * canonical depiction (kind + duration badges, description, the locked maturity
 * renderings, tutor prompt, deliverable) without forking a second one.
 *
 * Contract:
 *  - Parents own the title, padding, and scrolling — this renders no heading
 *    and no scroll container.
 *  - `unitId: null` (an assignment-less / unit-less placement) omits the
 *    maturity section entirely (the unit-wide status query is skipped).
 *  - `longText: "snippet"` clamps the tutor prompt + deliverable to ~3 lines
 *    with no expander — the Curriculum link is the click-through to full text.
 *    `"full"` renders them whole (the classic Summary tab).
 *  - Self-querying (activities.get + unitMaturity.getNodeStatuses), fired only
 *    while mounted — the drawer pays per-open, never per-grid-cell.
 *  - Unit-less (`unitId: null`) reads go through activities.getDetailForTeacher
 *    instead of activities.get: scholar-scoped / ad-hoc-dispatched activities
 *    have no lesson, and activities.get's unit gate returns null for those. The
 *    teacher read has no unit gate; it carries the TEACHER-facing description
 *    (this is a teacher surface, so it must NOT use the scholar-facing getPublic)
 *    and omits the tutor prompt, which is exactly the plan's partial-detail
 *    state for unit-less placements.
 */
import { useQuery } from "convex/react";
import { Badge, Box, Flex, HStack, Spinner, Stack, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";
import { ActivityKindIcon } from "@/components/ActivityKindIcon";
import { ACTIVITY_KIND, type ActivityKind } from "@/lib/activityKinds";
import { ReadinessInline } from "@/components/curriculumDoc/ReadinessGate";
import { SessionsInline } from "@/components/curriculumDoc/SessionsSignal";
import { EMPTY_SESSIONS } from "@/convex/lib/activitySessions";

function kindLabel(kind: string): string {
  return ACTIVITY_KIND[kind as ActivityKind]?.label ?? kind;
}

export function ActivityReadBody({
  unitId,
  activityId,
  longText,
}: {
  unitId: Id<"units"> | null;
  activityId: Id<"activities">;
  longText: "full" | "snippet";
}) {
  // Unit-linked → the full designer read (incl. tutor prompt). Unit-less →
  // an ungated-by-unit TEACHER read (lessonless activities make activities.get
  // return null; the drawer is a teacher surface, so we must NOT fall through to
  // the scholar-facing getPublic, whose `description` is now the scholar blurb).
  const full = useQuery(api.activities.get, unitId ? { id: activityId } : "skip");
  const teacherDetail = useQuery(
    api.activities.getDetailForTeacher,
    unitId ? "skip" : { id: activityId },
  );
  const activity = unitId ? full : teacherDetail;
  const nodeStatuses = useQuery(
    api.unitMaturity.getNodeStatuses,
    unitId ? { unitId } : "skip",
  );
  const sessionsData = useQuery(
    api.activitySessions.getForUnit,
    unitId ? { unitId } : "skip",
  );

  if (activity === undefined) {
    return (
      <Flex align="center" justify="center" py={8}>
        <Spinner size="md" color="violet.500" />
      </Flex>
    );
  }
  if (activity === null) {
    return (
      <Text fontSize="sm" color="charcoal.400" py={2}>
        Activity not found
      </Text>
    );
  }

  const isOnline = activity.kind === "online";
  // The public read carries no tutor prompt (partial detail, by design).
  const systemPrompt =
    "systemPrompt" in activity ? (activity.systemPrompt ?? null) : null;
  const status = nodeStatuses?.activities[String(activityId)];
  const readiness = nodeStatuses?.readiness.activities[String(activityId)];
  const sessions = sessionsData?.activities[String(activityId)] ?? EMPTY_SESSIONS;
  const deliverablePrompt = activity.deliverable?.prompt;
  const snippet = longText === "snippet";
  // Reserve space while the unit-wide statuses resolve so the maturity block's
  // late arrival can't shift content (e.g. the drawer's Remove button) under
  // the pointer. unitId null (or the activity not found under that unit —
  // pre-existing bad ancestry) → no maturity section at all.
  const maturityLoading = unitId !== null && nodeStatuses === undefined;

  return (
    <Stack gap={6}>
      {/* META — kind + duration badges, then the description. Parents render
          the title (drawer: as its own section heading; Summary tab: above). */}
      <Stack gap={2}>
        <HStack gap={2} flexWrap="wrap">
          <Badge
            bg="gray.100"
            color="charcoal.500"
            fontFamily="heading"
            fontSize="2xs"
            display="inline-flex"
            alignItems="center"
            gap={1}
          >
            <ActivityKindIcon kind={activity.kind} size={12} color="charcoal.500" />
            {kindLabel(activity.kind)}
          </Badge>
          {typeof activity.durationMinutes === "number" && (
            <Badge bg="gray.100" color="charcoal.500" fontFamily="heading" fontSize="2xs">
              {activity.durationMinutes} min
            </Badge>
          )}
        </HStack>
        {activity.description && (
          <Text fontSize="sm" color="charcoal.500" fontFamily="body" maxW="640px">
            {activity.description}
          </Text>
        )}
      </Stack>

      {/* MATURITY — the two signals (PR #1072 §8). Online activities carry a
          green Readiness preflight gate (Built → Heuristic review →
          Scholar-bot rehearsal) plus a violet Sessions field record. Non-online
          activities don't rehearse (their quality is judged at the unit's
          heuristic review), so they get an honest one-line note + their grey
          outline dot, NOT a meter. */}
      {maturityLoading ? (
        <Stack gap={3}>
          <SectionEyebrow>Maturity</SectionEyebrow>
          <Box
            bg="white"
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="lg"
            p={5}
            maxW="420px"
            minH="120px"
          />
        </Stack>
      ) : (
        status &&
        (isOnline ? (
          <Stack gap={3}>
            <SectionEyebrow>Readiness</SectionEyebrow>
            <Box maxW="420px">
              {readiness && <ReadinessInline readiness={readiness} w="180px" />}
            </Box>
            <SectionEyebrow>Sessions</SectionEyebrow>
            <Box maxW="420px">
              <SessionsInline sessions={sessions} />
            </Box>
          </Stack>
        ) : (
          <Stack gap={3}>
            <SectionEyebrow>Maturity</SectionEyebrow>
            <HStack gap={2.5} align="center" maxW="480px">
              <Text fontSize="sm" color="charcoal.500" fontFamily="body">
                {kindLabel(activity.kind)} activity — quality is judged at the
                unit&apos;s heuristic review.
              </Text>
            </HStack>
          </Stack>
        ))
      )}

      {/* PROMPT — the heart of an online activity (what the AI tutor runs).
          Read-only here; edit it in Curriculum. Snippet mode clamps with no
          expander — "Open in Curriculum" is the click-through. */}
      {isOnline && systemPrompt?.trim() && (
        <Stack gap={3}>
          <SectionEyebrow>Tutor prompt</SectionEyebrow>
          <Box
            bg="white"
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="lg"
            p={4}
            maxW="720px"
          >
            <Text
              fontSize="sm"
              color="charcoal.600"
              fontFamily="body"
              whiteSpace="pre-wrap"
              lineHeight="1.6"
              lineClamp={snippet ? 3 : undefined}
            >
              {systemPrompt}
            </Text>
          </Box>
        </Stack>
      )}

      {/* DELIVERABLE — what the scholar is asked to produce, if set. */}
      {deliverablePrompt?.trim() && (
        <Stack gap={3}>
          <SectionEyebrow>Deliverable</SectionEyebrow>
          <Box
            bg="white"
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="lg"
            p={4}
            maxW="720px"
          >
            <Text
              fontSize="sm"
              color="charcoal.600"
              fontFamily="body"
              whiteSpace="pre-wrap"
              lineHeight="1.6"
              lineClamp={snippet ? 3 : undefined}
            >
              {deliverablePrompt}
            </Text>
          </Box>
        </Stack>
      )}
    </Stack>
  );
}
