"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import {
  Box,
  Button,
  Flex,
  HStack,
  Link as ChakraLink,
  Skeleton,
  SimpleGrid,
  Spinner,
  Stack,
  Text,
  VisuallyHidden,
} from "@chakra-ui/react";
import {
  ArrowRight,
  ChatCircle,
  CheckCircle,
  Plus,
} from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import { isWithinPrepWindow } from "@/convex/lib/metaBlocks";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";
import { useNow } from "@/hooks/useNow";
import { withInstitutionScope } from "@/lib/institutionLinks";
import { formatTimeAgo } from "@/lib/relativeTime";
import { teacherChatHref } from "@/lib/teacherChat";
import { useAideDock } from "@/components/aide/AideDockProvider";
import { EmptyState } from "@/components/ui/EmptyState";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";
import { Surface } from "@/components/ui/Surface";

type TodayResult = NonNullable<
  ReturnType<typeof useQuery<typeof api.teacherToday.todayForTeacher>>
>;

type LaneRow = {
  key: string;
  text: React.ReactNode;
  href: string;
  verb: string;
};

type BirthdayEntry = TodayResult["birthdays"][number];

/** "Kai Kahale (11th Birthday)" — name + Nth-Birthday age when known. */
function formatBirthday(entry: BirthdayEntry): string {
  return entry.nthLabel ? `${entry.name} (${entry.nthLabel})` : entry.name;
}

export function TeacherToday() {
  const { scopeParam } = useActiveInstitution();
  // Minute-rounded clock — the reactive dependency that re-runs the query
  // across an institution-local midnight so time-derived lanes can't go stale.
  const nowMs = useNow(60_000);
  const today = useQuery(api.teacherToday.todayForTeacher, {
    institutionScope: scopeParam,
    now: nowMs,
  });

  if (today === undefined) {
    return (
      <Flex h="full" align="center" justify="center">
        <Spinner size="lg" color="violet.500" />
      </Flex>
    );
  }

  const { left, right } = laneData(today);
  const allClear = [...left, ...right].every((lane) => lane.rows.length === 0);

  return (
    <Box h="full" overflowY="auto" bg="gray.50" p={{ base: 4, md: 7 }}>
      <Box maxW="1120px" mx="auto">
        <VisuallyHidden as="h1">Today</VisuallyHidden>

        {today.closure && (
          <Box
            mb={4}
            px={5}
            py={4}
            bg="violet.50"
            borderWidth="1px"
            borderColor="violet.200"
            borderRadius="xl"
          >
            <Flex align={{ base: "start", sm: "center" }} gap={2} direction={{ base: "column", sm: "row" }}>
              <Text fontFamily="heading" fontWeight="700" color="violet.700">
                {today.closure.kind === "staffOnly" ? "Staff development day" : "No school today"}
              </Text>
              <Text fontSize="sm" color="charcoal.500">
                {today.closure.label}
              </Text>
            </Flex>
          </Box>
        )}

        {today.birthdays.length > 0 && (
          <Surface p={4} mb={4}>
            <HStack gap={2} align="baseline" flexWrap="wrap">
              <Text fontSize="md" lineHeight="1.2">
                🎂
              </Text>
              <Text fontSize="sm" fontWeight="700" color="navy.600">
                {today.birthdays.length === 1
                  ? "Birthday today:"
                  : "Birthdays today:"}
              </Text>
              <Text fontSize="sm" color="charcoal.500">
                {today.birthdays.map(formatBirthday).join(" · ")}
              </Text>
            </HStack>
          </Surface>
        )}

        <PrepWindowRows
          prepGroups={today.prepGroups}
          scopeParam={scopeParam}
          nowMs={nowMs}
        />

        <SimpleGrid columns={{ base: 1, md: 2 }} gap={4} alignItems="start">
          <Stack gap={4} minW={0}>
            {allClear ? (
              <Surface>
                <EmptyState
                  size="lg"
                  icon={<CheckCircle weight="duotone" />}
                  title="You're all clear."
                  hint="Nothing needs your attention right now."
                />
              </Surface>
            ) : (
              left.map((lane) => (
                <TodayLane
                  key={lane.title}
                  title={lane.title}
                  dotColor={lane.dotColor}
                  rows={lane.rows}
                  scopeParam={scopeParam}
                />
              ))
            )}
          </Stack>

          <Stack gap={4} minW={0}>
            {/* Keep triage ahead of chat history on narrow screens. */}
            <Box order={{ base: 1, md: 0 }}>
              <RecentChats scopeParam={scopeParam} />
            </Box>
            {!allClear &&
              right.map((lane) => (
                <TodayLane
                  key={lane.title}
                  title={lane.title}
                  dotColor={lane.dotColor}
                  rows={lane.rows}
                  scopeParam={scopeParam}
                />
              ))}
          </Stack>
        </SimpleGrid>
      </Box>
    </Box>
  );
}

function RecentChats({ scopeParam }: { scopeParam: string }) {
  const aide = useAideDock();
  const recent = useQuery(api.curriculumAssistant.listRecentChats, { limit: 3 });

  const startNewChat = () => {
    aide.setDockSessionId(null);
    aide.setOpen(true);
  };

  return (
    <Surface overflow="hidden">
      <Flex
        align="center"
        justify="space-between"
        gap={3}
        px={5}
        py={3}
        borderBottomWidth="1px"
        borderColor="gray.100"
      >
        <SectionEyebrow>Recent chats</SectionEyebrow>
        <Button
          size="sm"
          variant="ghost"
          fontFamily="heading"
          fontSize="sm"
          color="violet.600"
          _hover={{ bg: "violet.50" }}
          onClick={startNewChat}
        >
          <Plus size={14} weight="bold" />
          New chat
        </Button>
      </Flex>

      {recent === undefined ? (
        <Box>
          {[0, 1, 2].map((i) => (
            <Flex
              key={i}
              align="center"
              px={5}
              py={3.5}
              borderTopWidth={i === 0 ? "0" : "1px"}
              borderColor="gray.100"
              aria-hidden
            >
              <Skeleton h="16px" w={i === 1 ? "55%" : "70%"} />
            </Flex>
          ))}
        </Box>
      ) : recent.length === 0 ? (
        <EmptyState
          icon={<ChatCircle weight="duotone" />}
          title="No chats yet"
          hint="Ask the bot about a scholar, a unit, or your day."
        />
      ) : (
        <Box>
          {recent.map((chat, index) => (
            <ChakraLink
              key={String(chat._id)}
              asChild
              display="block"
              w="full"
              textDecoration="none"
              borderTopWidth={index === 0 ? "0" : "1px"}
              borderColor="gray.100"
              _hover={{ bg: "gray.50", textDecoration: "none" }}
              _focusVisible={{
                outline: "2px solid",
                outlineColor: "violet.400",
                outlineOffset: "-2px",
              }}
            >
              <Link
                href={teacherChatHref({
                  sessionId: String(chat._id),
                  scopeParam,
                })}
                onClick={(e) => {
                  // Modified clicks follow the href; plain clicks resume in the dock.
                  if (
                    e.metaKey ||
                    e.ctrlKey ||
                    e.shiftKey ||
                    e.altKey ||
                    e.button !== 0
                  ) {
                    return;
                  }
                  e.preventDefault();
                  aide.setDockSessionId(String(chat._id));
                  aide.setOpen(true);
                }}
              >
                <Flex align="center" gap={3} px={5} py={3.5}>
                  <Text
                    flex={1}
                    minW={0}
                    fontFamily="heading"
                    fontSize="sm"
                    fontWeight="600"
                    color="navy.600"
                    lineClamp={1}
                    title={chat.title}
                  >
                    {chat.title}
                  </Text>
                  <Text
                    flexShrink={0}
                    fontFamily="heading"
                    fontSize="xs"
                    color="charcoal.400"
                  >
                    {formatTimeAgo(chat.lastMessageAt)}
                  </Text>
                </Flex>
              </Link>
            </ChakraLink>
          ))}

          <ChakraLink
            asChild
            display="block"
            w="full"
            textDecoration="none"
            borderTopWidth="1px"
            borderColor="gray.100"
            _hover={{ bg: "gray.50", textDecoration: "none" }}
            _focusVisible={{
              outline: "2px solid",
              outlineColor: "violet.400",
              outlineOffset: "-2px",
            }}
          >
            <Link href={teacherChatHref({ sessionId: null, scopeParam })}>
              <Flex align="center" justify="space-between" gap={3} px={5} py={3.5}>
                <HStack
                  gap={1}
                  color="violet.600"
                  fontFamily="heading"
                  fontSize="sm"
                  fontWeight="700"
                >
                  <Text>View all</Text>
                  <ArrowRight size={14} weight="bold" />
                </HStack>
              </Flex>
            </Link>
          </ChakraLink>
        </Box>
      )}
    </Surface>
  );
}

type Lane = {
  title: string;
  dotColor: string;
  rows: LaneRow[];
};

/**
 * The Move 1 prep-window link row: while a group's Scholar's Prep is on, a
 * single count-free link to that group's prep board. The client owns the window
 * math (mirrors the scholar pin — no cron), re-evaluated on a timer. It carries
 * no roster or empty-list count, so it never re-renders the board's numbers (T1).
 */
function PrepWindowRows({
  prepGroups,
  scopeParam,
  nowMs,
}: {
  prepGroups: TodayResult["prepGroups"];
  scopeParam: string;
  /** Driven by the parent's single minute timer so the window edge is shared. */
  nowMs: number;
}) {
  const active = prepGroups.filter((g) => isWithinPrepWindow(g, nowMs));
  if (active.length === 0) return null;
  return (
    <Stack gap={2} mb={4}>
      {active.map((g) => (
        // The prep-window shortcut. `view=tonight` lands on the Scholars tab's
        // HOMEWORK tab, which lists every scholar's tonight/homework — the honest
        // "open the prep board" destination now that the per-card tonight strip
        // became its own tab. The link param is unchanged, so this and every
        // other legacy `view=tonight` link keep resolving.
        <Link
          key={g.groupId}
          href={withInstitutionScope(
            `/teacher/scholars?group=${g.groupId}&view=tonight`,
            scopeParam,
          )}
          style={{ textDecoration: "none" }}
        >
          <Surface
            px={5}
            py={3.5}
            _hover={{ bg: "gray.50" }}
            _focusVisible={{
              outline: "2px solid",
              outlineColor: "violet.400",
              outlineOffset: "-2px",
            }}
          >
            <Flex align="center" gap={3}>
              <Text fontSize="md" lineHeight="1.2">
                🔖
              </Text>
              <Box flex={1} minW={0}>
                <Text
                  fontFamily="heading"
                  fontSize="sm"
                  fontWeight="700"
                  color="navy.600"
                >
                  Scholar&apos;s Prep is on now · {g.name}
                </Text>
                <Text fontFamily="body" fontSize="xs" color="charcoal.400">
                  Open the board to see tonight&apos;s lists
                </Text>
              </Box>
              <HStack
                gap={1}
                color="violet.600"
                flexShrink={0}
                fontFamily="heading"
                fontSize="sm"
                fontWeight="700"
              >
                <Text>Open prep board</Text>
                <ArrowRight size={14} weight="bold" />
              </HStack>
            </Flex>
          </Surface>
        </Link>
      ))}
    </Stack>
  );
}

function laneData(today: TodayResult): { left: Lane[]; right: Lane[] } {
  return {
    left: [
      {
        title: "Needs a look",
        dotColor: "violet.400",
        rows: today.needsALook.map((row) => ({
          key: String(row.scholarId),
          text: (
            <>
              <Text as="span" fontWeight="700" color="navy.600">
                {row.name}
              </Text>
              <Text as="span" color="charcoal.500">
                {" "}
                — {row.reason}
              </Text>
            </>
          ),
          href: `/teacher/scholars/${row.scholarId}`,
          verb: "Open",
        })),
      },
      {
        title: "Today's plan",
        dotColor: "blue.400",
        rows: today.todaysPlan.map((row) => ({
          key: `${row.blockId}-${row.assignmentId}-${row.activityId}`,
          text: (
            <>
              <Text as="span" fontWeight="700" color="navy.600">
                {row.label}
              </Text>
              <Text as="span" color="charcoal.400">
                {" "}
                — {row.startedCount} of {row.totalCount} started
              </Text>
            </>
          ),
          href: row.href,
          verb: row.verb,
        })),
      },
    ],
    right: [
      {
        title: "Waiting on you",
        dotColor: "amber.400",
        rows: today.waitingOnYou.map((row, index) => ({
          key: `${row.kind}-${row.href}-${index}`,
          text: row.label,
          href: row.href,
          verb: row.verb,
        })),
      },
      {
        title: today.overnightTitle,
        dotColor: "green.500",
        rows: today.overnight.map((row, index) => ({
          key: `${row.kind}-${index}`,
          text: row.label,
          href: row.href,
          verb: row.verb,
        })),
      },
    ],
  };
}

function TodayLane({
  title,
  dotColor,
  rows,
  scopeParam,
}: {
  title: string;
  dotColor: string;
  rows: LaneRow[];
  scopeParam: string;
}) {
  return (
    <Surface overflow="hidden">
      <Box px={5} py={4} borderBottomWidth="1px" borderColor="gray.100">
        <SectionEyebrow>{title}</SectionEyebrow>
      </Box>
      {rows.length === 0 ? (
        <EmptyState title="Nothing needs you here." />
      ) : (
        <Box>
          {rows.map((row, index) => (
            <Link
              key={row.key}
              href={withInstitutionScope(row.href, scopeParam)}
              style={{ textDecoration: "none" }}
            >
              <Flex
                align="center"
                gap={3}
                px={5}
                py={3.5}
                borderTopWidth={index === 0 ? "0" : "1px"}
                borderColor="gray.100"
                _hover={{ bg: "gray.50" }}
                _focusVisible={{
                  outline: "2px solid",
                  outlineColor: "violet.400",
                  outlineOffset: "-2px",
                }}
              >
                <Box
                  w={2}
                  h={2}
                  borderRadius="full"
                  bg={dotColor}
                  flexShrink={0}
                />
                <Text
                  flex={1}
                  minW={0}
                  fontFamily="body"
                  fontSize="sm"
                  lineHeight="1.45"
                >
                  {row.text}
                </Text>
                <HStack
                  gap={1}
                  color="violet.600"
                  flexShrink={0}
                  fontFamily="heading"
                  fontSize="sm"
                  fontWeight="700"
                >
                  <Text>{row.verb}</Text>
                  <ArrowRight size={14} weight="bold" />
                </HStack>
              </Flex>
            </Link>
          ))}
        </Box>
      )}
    </Surface>
  );
}
