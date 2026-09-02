"use client";

// Card on the Scholars tab's overview view that summarizes everything
// this scholar is currently assigned at the Assignments layer: active
// cohort assignments and the current class focus (if they're targeted).
// Deep links into the Schedule tab surface.

import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import {
  Box,
  Flex,
  HStack,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { ClipboardText, Compass, CaretRight } from "@phosphor-icons/react";
import { ActivityModeIcon } from "@/lib/activityMode";
import { assignmentDetailLine, assignmentsHeadingSuffix } from "@/components/scholarAssignmentsRow";

export function ScholarAssignmentsCard({
  scholarId,
}: {
  scholarId: Id<"users">;
}) {
  const data = useQuery(api.users.assignmentsForScholar, { scholarId });
  if (data === undefined) {
    return (
      <Box>
        <HStack mb={3}>
          <Compass color="#AD60BF" />
          <Text
            fontWeight="600"
            fontFamily="heading"
            color="navy.500"
            fontSize="sm"
          >
            Assignments
          </Text>
        </HStack>
        <Flex justify="center" py={4}>
          <Spinner size="sm" color="violet.500" />
        </Flex>
      </Box>
    );
  }
  const { assignments, focus } = data;
  const empty = assignments.length === 0 && !focus;

  return (
    <Box>
      <HStack mb={3} justify="space-between">
        <HStack>
          <Compass color="#AD60BF" />
          <Text
            fontWeight="600"
            fontFamily="heading"
            color="navy.500"
            fontSize="sm"
          >
            Assignments
            {/* Count only the scholar's own assignment rows — the class
                focus below is a different kind of thing (whole-class, not
                this scholar's) and gets its own "Class focus" sublabel
                instead of inflating this count. */}
            {assignmentsHeadingSuffix(assignments.length)}
          </Text>
        </HStack>
      </HStack>

      {empty ? (
        <Text
          fontSize="sm"
          color="charcoal.300"
          fontFamily="heading"
          textAlign="center"
          py={4}
        >
          No active assignments. Use the Schedule tab to assign.
        </Text>
      ) : (
        <Stack gap={2}>
          {assignments.map((assignment) => (
            <Row
              key={assignment.assignmentId}
              icon={
                <span style={{ color: "var(--chakra-colors-violet-500)" }}>
                  <ClipboardText size={16} weight="bold" />
                </span>
              }
              borderColor="violet.300"
              label={assignment.title}
              detail={assignmentDetailLine(assignment)}
              href="/teacher/schedule"
            />
          ))}
          {focus && (
            <Box>
              <Text
                fontSize="2xs"
                fontWeight="700"
                color="charcoal.300"
                fontFamily="heading"
                textTransform="uppercase"
                letterSpacing="0.04em"
                mb={1}
                mt={assignments.length > 0 ? 1 : 0}
              >
                Class focus
              </Text>
              <Row
                icon={
                  <span style={{ color: "var(--chakra-colors-violet-500)" }}>
                    <ActivityModeIcon mode="classFocus" size={16} />
                  </span>
                }
                borderColor="violet.300"
                label="Class focus right now"
                detail={
                  focus.activityTitle
                    ? `${focus.unitTitle ?? "Activity"} — ${focus.activityTitle}`
                    : focus.unitTitle ?? "(active focus)"
                }
                href="/teacher/schedule"
              />
            </Box>
          )}
        </Stack>
      )}
    </Box>
  );
}

function Row({
  icon,
  label,
  detail,
  borderColor,
  href,
}: {
  icon: React.ReactNode;
  label: string;
  detail?: string;
  borderColor: string;
  href: string;
}) {
  return (
    <Link href={href} style={{ textDecoration: "none", display: "block" }}>
      <Flex
        p={3}
        bg="white"
        borderRadius="md"
        borderWidth="1px"
        borderColor={borderColor}
        shadow="xs"
        cursor="pointer"
        _hover={{ shadow: "sm", bg: "gray.50" }}
        align="center"
        gap={3}
      >
        <Box>{icon}</Box>
        <Stack gap={0} flex={1} minW={0}>
          <Text
            fontFamily="heading"
            fontWeight="600"
            color="navy.500"
            fontSize="sm"
          >
            {label}
          </Text>
          {detail && (
            <Text fontSize="xs" color="charcoal.400" fontFamily="heading">
              {detail}
            </Text>
          )}
        </Stack>
        <Box color="charcoal.300">
          <CaretRight size={14} />
        </Box>
      </Flex>
    </Link>
  );
}
