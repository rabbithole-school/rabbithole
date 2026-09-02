"use client";

import { useQuery } from "convex/react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Box, Flex, Text, HStack, Stack, Button, Splitter } from "@chakra-ui/react";
import { Plus } from "@phosphor-icons/react";
import { HierarchyRow } from "@/components/hierarchy/HierarchyRow";
import { HierarchyListSkeleton } from "@/components/hierarchy/HierarchyRowSkeleton";
import { EmojiPlaceholder } from "@/components/hierarchy/EmojiPlaceholder";
import { AssignmentPanel } from "@/components/AssignmentPanel";
import { ScholarFacepile } from "@/components/ScholarFacepile";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatTimeAgo } from "@/lib/relativeTime";
import { ActivityModeBadge } from "@/lib/activityMode";
import { assignmentIdFromPathname } from "../_components/assignmentsPath";

// ─── Assignments list-detail ─────────────────────────────────────────
//
// Finder-style two-column layout matching the Curriculum tab.
//   Left:  the list of Assignments as HierarchyRow items.
//   Right: gray.50 shoulder containing the embedded AssignmentPanel.
//
// URL selection state: `/teacher/schedule/<assignmentId>` in the path.

export function AssignmentsListDetail({
  onStartAssignment,
}: {
  onStartAssignment: () => void;
}) {
  const rows = useQuery(api.assignments.listForTeacher, {});
  const standingRows = useQuery(api.standingPractice.listForTeacher, {});
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedParam = assignmentIdFromPathname(pathname);

  const selectedHref = (id: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", "list");
    return `/teacher/schedule${id ? `/${id}` : ""}?${params.toString()}`;
  };

  const setSelected = (id: string | null) => {
    router.replace(selectedHref(id), { scroll: false });
  };

  // Default selection: first Assignment if none picked.
  const selected =
    rows && rows.length > 0
      ? selectedParam && rows.find((r) => String(r._id) === selectedParam)
        ? selectedParam
        : String(rows[0]._id)
      : null;

  return (
    <Splitter.Root
      h="full"
      overflow="hidden"
      defaultSize={[24, 76]}
      panels={[
        { id: "list", minSize: 16 },
        { id: "detail", minSize: 50 },
      ]}
    >
      {/* LEFT: filter chips + assignment list */}
      <Splitter.Panel
        id="list"
        h="full"
        overflow="hidden"
        borderRight="1px solid"
        borderColor="gray.200"
        bg="white"
      >
        <Flex direction="column" h="full">
          {/* Column body — the assignments list. */}
          <Box flex={1} overflow="auto">
              {/* List header — section label + labeled create action. */}
              <Flex
                px={3}
                py={1.5}
                align="center"
                justify="space-between"
                borderBottom="1px solid"
                borderColor="gray.100"
                position="sticky"
                top={0}
                bg="white"
                zIndex={1}
              >
                <Text
                  fontSize="2xs"
                  fontFamily="heading"
                  fontWeight="700"
                  letterSpacing="0.04em"
                  textTransform="uppercase"
                  color="charcoal.400"
                >
                  Active assignments
                </Text>
                <Button
                  size="xs"
                  variant="ghost"
                  height="auto"
                  py={1}
                  px={2}
                  color="violet.600"
                  fontFamily="heading"
                  fontWeight="600"
                  fontSize="2xs"
                  _hover={{ bg: "violet.50" }}
                  onClick={onStartAssignment}
                >
                  <Plus size={12} /> Assign
                </Button>
              </Flex>
              {rows === undefined ? (
                <HierarchyListSkeleton rows={6} />
              ) : rows.length === 0 ? (
                <EmptyState
                  title="No assignments yet."
                  hint="Click Assign to assign a unit."
                />
              ) : (
                <Stack gap={0.5} p={1.5}>
                  {rows.map((r) => (
                    <HierarchyRow
                      key={String(r._id)}
                      leading={r.unitEmoji ? r.unitEmoji : <EmojiPlaceholder />}
                      label={r.title ?? r.unitTitle}
                      sublabel={
                        <HStack gap={1.5} mt={0.5} w="full" flexWrap="wrap">
                          <ScholarFacepile
                            scholars={r.facepile}
                            total={r.scholarCount}
                            size="xs"
                            max={4}
                          />
                          {r.classFocusCount > 0 && (
                            <ActivityModeBadge
                              mode="classFocus"
                              variant="soft"
                              count={r.classFocusCount}
                            />
                          )}
                          {r.homeworkCount > 0 && (
                            <ActivityModeBadge
                              mode="homework"
                              variant="soft"
                              count={r.homeworkCount}
                            />
                          )}
                          <Text
                            ml="auto"
                            flexShrink={0}
                            fontSize="2xs"
                            color="charcoal.400"
                            fontFamily="heading"
                            whiteSpace="nowrap"
                          >
                            {formatTimeAgo(r.startedAt)}
                          </Text>
                        </HStack>
                      }
                      selected={String(r._id) === selected}
                      onClick={() => setSelected(String(r._id))}
                      href={selectedHref(String(r._id))}
                      trailing={{ kind: "chevron" }}
                    />
                  ))}
                </Stack>
              )}

              {/* ── Standing practice ─────────────────────────────────
                  Existing rows remain visible and read-only during migration. */}
              <Flex
                px={3}
                py={1.5}
                mt={2}
                align="center"
                justify="space-between"
                borderTop="1px solid"
                borderBottom="1px solid"
                borderColor="gray.100"
              >
                <Text
                  fontSize="2xs"
                  fontFamily="heading"
                  fontWeight="700"
                  letterSpacing="0.04em"
                  textTransform="uppercase"
                  color="charcoal.400"
                >
                  Standing practice
                </Text>
              </Flex>
              {standingRows === undefined ? (
                <HierarchyListSkeleton rows={2} />
              ) : standingRows.length === 0 ? (
                <Box px={3} py={4}>
                  <Text
                    fontSize="xs"
                    color="charcoal.400"
                    fontFamily="heading"
                    fontStyle="italic"
                    textAlign="center"
                  >
                    No standing practice yet.
                  </Text>
                </Box>
              ) : (
                <Stack gap={0.5} p={1.5}>
                  {standingRows.map((s) => (
                    <HierarchyRow
                      key={String(s._id)}
                      leading={<EmojiPlaceholder />}
                      label={s.title ?? "Standing practice"}
                      sublabel={
                        <HStack gap={1.5} mt={0.5} w="full" flexWrap="wrap">
                          <ScholarFacepile
                            scholars={s.facepile}
                            total={s.scholarCount}
                            size="xs"
                            max={4}
                          />
                          {s.dailyGoalMinutes != null && (
                            <Text
                              fontSize="2xs"
                              color="charcoal.400"
                              fontFamily="heading"
                              whiteSpace="nowrap"
                            >
                              {s.dailyGoalMinutes} min/day
                            </Text>
                          )}
                          <Text
                            ml="auto"
                            flexShrink={0}
                            fontSize="2xs"
                            color="charcoal.400"
                            fontFamily="heading"
                            whiteSpace="nowrap"
                          >
                            {formatTimeAgo(s.startedAt)}
                          </Text>
                        </HStack>
                      }
                    />
                  ))}
                </Stack>
              )}
            </Box>
        </Flex>
      </Splitter.Panel>

      <Splitter.ResizeTrigger
        id="list:detail"
        css={{ "--splitter-border-size": "0.5px" }}
      />

      {/* RIGHT: gray.50 shoulder with the selected assignment's Run page */}
      <Splitter.Panel id="detail" h="full" overflow="hidden" bg="gray.50">
        {/* Splitter panels clip overflow; the child must own vertical scrolling. */}
        <Box h="full" overflowY="auto">
          {selected ? (
            <AssignmentPanel assignmentId={selected as Id<"assignments">} embedded />
          ) : (
            <Flex
              direction="column"
              align="center"
              justify="center"
              h="full"
              gap={3}
              px={6}
            >
              <EmptyState
                size="lg"
                title="No assignments yet"
                hint="Click Assign in the left panel to assign a unit. Each assignment becomes a Run surface where you push activities to the class, send homework, and review submissions."
              />
            </Flex>
          )}
        </Box>
      </Splitter.Panel>
    </Splitter.Root>
  );
}
