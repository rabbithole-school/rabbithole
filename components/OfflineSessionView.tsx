"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Box,
  Flex,
  Heading,
  HStack,
  SimpleGrid,
  Spinner,
  Text,
  Badge,
  IconButton,
  Stack,
  VStack,
  Button,
} from "@chakra-ui/react";
import { ArrowLeft, ArrowSquareOut, CheckCircle, FileText } from "@phosphor-icons/react";
import { DeliverableGradeControl } from "@/components/DeliverableGradeControl";
import { AssessScanButton } from "@/components/AssessScanButton";
import {
  offlineHomeworkContext,
  offlineHomeworkDueText,
  offlineHomeworkFinishCopy,
  offlineHomeworkMarkedText,
} from "@/shared/offlineHomework";
import { toaster } from "@/lib/toaster";
import { ResourceShareCard } from "@/components/ResourceShareCard";

/**
 * Read-only view of an offline session — a session with no chat thread that
 * holds a scholar's scanned deliverable(s) for an offline activity (see
 * convex/portfolioMaterialize.ts). There's nothing to converse with here, so
 * we render the scans + their grading instead of SessionInterface's chat.
 *
 * This is the drill-in target when a teacher opens an offline session (e.g.
 * from a Share Back highlight). The richer per-scan triage still lives in the
 * scanner inbox; this is a clean "show me the work" surface.
 */
export function OfflineSessionView({
  sessionId,
  onBack,
}: {
  sessionId: Id<"sessions">;
  onBack?: () => void;
}) {
  const data = useQuery(api.portfolio.offlineSessionView, { sessionId });

  if (data === undefined) {
    return (
      <Flex flex={1} align="center" justify="center">
        <Spinner size="lg" color="violet.500" />
      </Flex>
    );
  }
  if (data === null) {
    return (
      <Flex flex={1} align="center" justify="center" p={8}>
        <Text color="charcoal.400" fontFamily="body">
          This session is no longer available.
        </Text>
      </Flex>
    );
  }

  const context = offlineHomeworkContext(data);
  const dueText = offlineHomeworkDueText(data.dueAt, data.timeZone);
  // The finish block replaces the big paper cue with one quiet line: some
  // offline homework is a worksheet, but most of it (a read-aloud) has no
  // paper at all, and the old cue was the only thing on the page.
  const showFinish =
    !data.viewerCanGrade && (data.canMarkDone || data.selfMark != null);
  const finishCopy = offlineHomeworkFinishCopy(data.teacherName);

  return (
    <Flex flex={1} flexDir="column" overflow="hidden" bg="white">
      <HStack
        px={5}
        py={4}
        borderBottom="1px solid"
        borderColor="gray.200"
        gap={3}
      >
        {onBack && (
          <IconButton
            aria-label="Back"
            size="sm"
            variant="ghost"
            color="charcoal.400"
            onClick={onBack}
          >
            <ArrowLeft />
          </IconButton>
        )}
        <Heading as="h1" size="md" color="navy.500" fontFamily="heading">
          {data.title}
        </Heading>
        {data.items.length > 0 && (
          <Badge bg="gray.100" color="charcoal.500" fontFamily="heading" fontSize="2xs">
            Scanned work
          </Badge>
        )}
      </HStack>

      <Box flex={1} overflowY="auto" p={5}>
        <Stack gap={2} maxW="3xl" mb={6}>
          {context && (
            <Text color="charcoal.500" fontFamily="heading" fontSize="sm">
              {context}
            </Text>
          )}
          {data.isHomework && (
            <Text color="charcoal.400" fontFamily="heading" fontSize="sm">
              {dueText}
            </Text>
          )}
          {data.description && (
            <Stack gap={1.5}>
              <Heading as="h2" size="sm" color="navy.500" fontFamily="heading">
                What to do
              </Heading>
              <Text
                color="charcoal.600"
                fontFamily="body"
                fontSize="md"
                lineHeight="1.6"
                whiteSpace="pre-wrap"
                userSelect="text"
              >
                {data.description}
              </Text>
            </Stack>
          )}
          {data.resources.length > 0 && (
            <Stack gap={1.5} mt={2}>
              <Heading as="h2" size="sm" color="navy.500" fontFamily="heading">
                Materials
              </Heading>
              <Stack gap={1}>
                {data.resources.map((resource) => (
                  <ResourceShareCard
                    key={resource._id}
                    resource={resource}
                    compact
                  />
                ))}
              </Stack>
            </Stack>
          )}
          {showFinish && data.assignmentId && data.activityId && (
            <OfflineHomeworkFinishBlock
              assignmentId={data.assignmentId}
              activityId={data.activityId}
              selfMark={data.selfMark}
              markedText={
                data.selfMark
                  ? offlineHomeworkMarkedText(
                      data.selfMark.completedAt,
                      data.timeZone,
                      data.teacherName,
                    )
                  : null
              }
              prompt={finishCopy.prompt}
              detail={finishCopy.detail}
            />
          )}
        </Stack>
        {data.items.length === 0 && showFinish ? (
          data.selfMark ? null : (
            <Text color="charcoal.400" fontFamily="body" fontSize="sm" maxW="3xl">
              {finishCopy.paperLine}
            </Text>
          )
        ) : data.items.length === 0 ? (
          data.viewerCanGrade ? (
            <Text color="charcoal.400" fontFamily="body" fontSize="sm">
              No scans filed to this activity.
            </Text>
          ) : data.description || data.resources.length === 0 ? (
            <VStack align="start" gap={2} maxW="sm">
              <HStack gap={2} color="violet.500">
                <FileText size={18} weight="fill" />
                <Text fontFamily="heading" fontWeight="600" color="navy.500" fontSize="sm">
                  This one&apos;s on paper
                </Text>
              </HStack>
              <Text color="charcoal.500" fontFamily="body" fontSize="sm" lineHeight="1.5">
                Do this work on paper, then hand it to your teacher — they&apos;ll
                scan it in so it shows up right here.
              </Text>
            </VStack>
          ) : null
        ) : (
          <>
            {!data.viewerCanGrade && (
              <Text
                color="charcoal.500"
                fontFamily="body"
                fontSize="sm"
                mb={4}
                lineHeight="1.5"
              >
                📄 This is your paper work — your teacher scanned it in.
              </Text>
            )}
            <SimpleGrid columns={{ base: 1, sm: 2, md: 3 }} gap={4}>
            {data.items.map((item) => {
              const verdict =
                item.rubricPassed === true
                  ? { label: "Passed", color: "green" }
                  : item.overall === "half"
                    ? { label: "Partial", color: "orange" }
                    : item.overall === "not"
                      ? { label: "Not yet", color: "red" }
                      : null;
              const checked = item.checkedAt != null || item.overall != null;
              return (
                <Box
                  key={item.deliverableId}
                  borderWidth="1px"
                  borderColor="gray.200"
                  borderRadius="lg"
                  overflow="hidden"
                  bg="white"
                  shadow="xs"
                >
                  <Box
                    as={item.fileUrl ? "a" : "div"}
                    {...(item.fileUrl
                      ? {
                          href: item.fileUrl,
                          target: "_blank",
                          rel: "noopener noreferrer",
                        }
                      : {})}
                    display="block"
                    h="180px"
                    bg="gray.50"
                    position="relative"
                    cursor={item.fileUrl ? "pointer" : "default"}
                  >
                    {item.thumbUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.thumbUrl}
                        alt=""
                        style={{
                          width: "100%",
                          height: "100%",
                          objectFit: "cover",
                        }}
                      />
                    ) : (
                      <Flex h="full" align="center" justify="center">
                        <FileText size={40} color="#AD60BF" />
                      </Flex>
                    )}
                    {item.fileUrl && (
                      <Box
                        position="absolute"
                        top={2}
                        right={2}
                        bg="whiteAlpha.800"
                        borderRadius="md"
                        p={1}
                        color="charcoal.500"
                      >
                        <ArrowSquareOut size={14} />
                      </Box>
                    )}
                  </Box>
                  <Box p={3}>
                    <HStack justify="space-between" gap={2} mb={1}>
                      <Text
                        fontFamily="heading"
                        fontWeight="600"
                        color="navy.500"
                        fontSize="sm"
                        truncate
                      >
                        {item.title}
                      </Text>
                      <HStack gap={1} flexShrink={0}>
                        {data.viewerCanGrade ? (
                          <>
                            {verdict && (
                              <Badge
                                colorPalette={verdict.color}
                                fontFamily="heading"
                                fontSize="2xs"
                              >
                                {verdict.label}
                              </Badge>
                            )}
                            <DeliverableGradeControl
                              deliverableId={item.deliverableId}
                              overall={
                                item.rubricPassed === true
                                  ? "full"
                                  : item.overall
                              }
                              rubricFeedback={
                                item.teacherFeedback ?? undefined
                              }
                            />
                          </>
                        ) : (
                          checked && (
                            <HStack gap={1} color="green.600" flexShrink={0}>
                              <CheckCircle size={14} weight="fill" />
                              <Text
                                fontFamily="heading"
                                fontWeight="600"
                                fontSize="2xs"
                                whiteSpace="nowrap"
                              >
                                Checked by your teacher
                              </Text>
                            </HStack>
                          )
                        )}
                      </HStack>
                    </HStack>
                    {item.caption && (
                      <Text fontSize="xs" color="charcoal.500" fontFamily="body" lineClamp={3}>
                        {item.caption}
                      </Text>
                    )}
                    {!data.viewerCanGrade && item.teacherFeedback && (
                      <Box
                        mt={2}
                        bg="green.50"
                        borderRadius="md"
                        px={2}
                        py={1}
                      >
                        <Text
                          fontSize="2xs"
                          color="charcoal.400"
                          fontFamily="heading"
                          fontWeight="600"
                        >
                          {item.checkedBy === "teacher"
                            ? "Note from your teacher"
                            : "Rabbithole note"}
                        </Text>
                        <Text
                          fontSize="xs"
                          color="charcoal.600"
                          fontFamily="body"
                          lineHeight="1.5"
                        >
                          {item.teacherFeedback}
                        </Text>
                      </Box>
                    )}
                    {data.viewerCanGrade && (
                      <HStack mt={2} gap={2}>
                        <AssessScanButton deliverableId={item.deliverableId} />
                      </HStack>
                    )}
                  </Box>
                </Box>
              );
            })}
          </SimpleGrid>
          </>
        )}
      </Box>
    </Flex>
  );
}

/**
 * "I did it" for offline homework (TRA-458). One tap, no confirm: the undo sits
 * where the tap happened and is cheaper than an "Are you sure?" on every mark.
 * The block flips in place from the live query, so it survives a reload.
 */
function OfflineHomeworkFinishBlock({
  assignmentId,
  activityId,
  selfMark,
  markedText,
  prompt,
  detail,
}: {
  assignmentId: Id<"assignments">;
  activityId: Id<"activities">;
  selfMark: {
    completionId: Id<"activityCompletions">;
    completedAt: number;
    canUndo: boolean;
  } | null;
  markedText: string | null;
  prompt: string;
  detail: string;
}) {
  const markDone = useMutation(api.activityCompletions.markHomeworkDoneForSelf);
  const undo = useMutation(api.activityCompletions.undoHomeworkDoneForSelf);
  const [busy, setBusy] = useState(false);

  const run = async (
    write: () => Promise<{ ok: true } | { ok: false; message: string }>,
  ) => {
    setBusy(true);
    const result = await write().catch(() => null);
    setBusy(false);
    if (!result) toaster.error({ title: "Couldn't save that. Try again." });
    else if (!result.ok) toaster.error({ title: result.message });
  };

  if (selfMark) {
    return (
      <HStack
        mt={4}
        p={4}
        gap={3}
        borderWidth="1px"
        borderColor="green.200"
        bg="green.50"
        borderRadius="xl"
        align="center"
      >
        <Box color="green.600" flexShrink={0}>
          <CheckCircle size={22} weight="fill" />
        </Box>
        <Stack gap={0} flex={1} minW={0}>
          <Text fontFamily="heading" fontWeight="600" color="navy.500" fontSize="md">
            You marked this done
          </Text>
          {markedText && (
            <Text fontFamily="body" color="charcoal.500" fontSize="sm">
              {markedText}
            </Text>
          )}
        </Stack>
        {selfMark.canUndo && (
          <Button
            size="sm"
            variant="ghost"
            color="charcoal.500"
            fontFamily="heading"
            loading={busy}
            onClick={() =>
              void run(() => undo({ completionId: selfMark.completionId }))
            }
          >
            Undo
          </Button>
        )}
      </HStack>
    );
  }

  return (
    <Stack
      mt={4}
      p={4}
      gap={3}
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="xl"
      align="flex-start"
    >
      <Stack gap={1}>
        <Text fontFamily="heading" fontWeight="600" color="navy.500" fontSize="md">
          {prompt}
        </Text>
        <Text fontFamily="body" color="charcoal.500" fontSize="sm" lineHeight="1.5">
          {detail}
        </Text>
      </Stack>
      <Button
        colorPalette="violet"
        fontFamily="heading"
        loading={busy}
        onClick={() => void run(() => markDone({ assignmentId, activityId }))}
      >
        I did it
      </Button>
    </Stack>
  );
}
