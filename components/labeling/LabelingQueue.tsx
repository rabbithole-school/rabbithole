"use client";

/**
 * The labeling queue view: the curated sessions to score (with THIS rater's
 * progress) + an "Add sessions" panel listing recent real candidates. Landing
 * surface for the /teacher/labeling activity — the empty state explains it in
 * two sentences because teachers arrive here cold at the meeting. WEB-ONLY.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Box,
  Button,
  Checkbox,
  Flex,
  HStack,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Plus, Trash, CaretRight, ChatCircleText } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Surface } from "@/components/ui/Surface";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";
import { toaster } from "@/lib/toaster";

function ProgressBar({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const complete = total > 0 && done >= total;
  return (
    <HStack gap={2} minW="150px" flex={1}>
      <Box flex={1} h="6px" bg="gray.100" borderRadius="full" overflow="hidden">
        <Box
          h="full"
          w={`${pct}%`}
          bg={complete ? "green.500" : "violet.500"}
          transition="width 0.2s"
        />
      </Box>
      <Text fontSize="2xs" color="charcoal.400" fontFamily="heading" fontWeight="600" minW="46px" textAlign="right">
        {done}/{total}
      </Text>
    </HStack>
  );
}

function UnitChip({ title, emoji }: { title: string | null; emoji: string | null }) {
  if (!title) {
    return (
      <Text fontSize="2xs" color="charcoal.300" fontFamily="heading" fontWeight="600">
        Independent study
      </Text>
    );
  }
  return (
    <Text fontSize="2xs" color="charcoal.400" fontFamily="heading" fontWeight="600">
      {emoji ? `${emoji} ` : ""}
      {title}
    </Text>
  );
}

function AddCandidatesPanel({ onClose }: { onClose: () => void }) {
  const candidates = useQuery(api.qualityLabeling.addRecentCandidates, {});
  const addToQueue = useMutation(api.qualityLabeling.addToQueue);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const addSelected = async () => {
    setAdding(true);
    try {
      for (const id of selected) {
        await addToQueue({ sessionId: id as Id<"sessions"> });
      }
      toaster.success({ title: `Added ${selected.size} session${selected.size === 1 ? "" : "s"}` });
      setSelected(new Set());
      onClose();
    } catch (e) {
      toaster.error({ title: "Couldn't add sessions", description: String(e) });
    } finally {
      setAdding(false);
    }
  };

  return (
    <Surface p={4} mb={4}>
      <Flex justify="space-between" align="center" mb={3}>
        <SectionEyebrow>Recent sessions</SectionEyebrow>
        <Button size="xs" variant="ghost" color="charcoal.500" onClick={onClose}>
          Close
        </Button>
      </Flex>

      {candidates === undefined ? (
        <Flex justify="center" py={6}>
          <Spinner size="sm" color="violet.500" />
        </Flex>
      ) : candidates.length === 0 ? (
        <Text fontSize="sm" color="charcoal.400" py={4}>
          No recent sessions with enough conversation to label yet.
        </Text>
      ) : (
        <VStack gap={0} align="stretch">
          {candidates.map((c, i) => (
            <Flex
              key={String(c.sessionId)}
              align="center"
              gap={3}
              py={2.5}
              borderTopWidth={i === 0 ? "0" : "1px"}
              borderColor="gray.100"
              opacity={c.alreadyQueued ? 0.5 : 1}
            >
              <Checkbox.Root
                checked={selected.has(String(c.sessionId))}
                disabled={c.alreadyQueued}
                onCheckedChange={() => toggle(String(c.sessionId))}
                colorPalette="violet"
              >
                <Checkbox.HiddenInput />
                <Checkbox.Control />
              </Checkbox.Root>
              <Box flex={1} minW={0}>
                <Text fontSize="sm" fontWeight="600" color="charcoal.700" truncate>
                  {c.title}
                </Text>
                <HStack gap={2}>
                  <UnitChip title={c.unitTitle} emoji={c.unitEmoji} />
                  <Text fontSize="2xs" color="charcoal.300" fontFamily="heading">
                    · {c.tutorTurns} tutor turn{c.tutorTurns === 1 ? "" : "s"}
                  </Text>
                </HStack>
              </Box>
              {c.alreadyQueued && (
                <Text fontSize="2xs" color="charcoal.300" fontFamily="heading" fontWeight="600">
                  In queue
                </Text>
              )}
            </Flex>
          ))}
        </VStack>
      )}

      {selected.size > 0 && (
        <Flex
          justify="space-between"
          align="center"
          gap={3}
          position="sticky"
          bottom="0"
          zIndex={1}
          bg="white"
          mx={-4}
          mb={-4}
          mt={3}
          px={4}
          py={3}
          borderTopWidth="1px"
          borderColor="gray.200"
          borderBottomRadius="lg"
        >
          <Text fontSize="xs" color="charcoal.400" fontFamily="heading" fontWeight="600">
            {selected.size} selected
          </Text>
          <Button size="sm" colorPalette="violet" disabled={adding} onClick={addSelected}>
            {adding ? <Spinner size="xs" /> : <Plus size={14} style={{ marginRight: 6 }} />}
            Add {selected.size} to queue
          </Button>
        </Flex>
      )}
    </Surface>
  );
}

export function LabelingQueue({
  onSelect,
}: {
  onSelect: (sessionId: Id<"sessions">) => void;
}) {
  const queue = useQuery(api.qualityLabeling.listQueue, {});
  const removeFromQueue = useMutation(api.qualityLabeling.removeFromQueue);
  const [showAdd, setShowAdd] = useState(false);

  const isEmpty = queue !== undefined && queue.length === 0;
  const totals = useMemo(() => {
    if (!queue) return { done: 0, total: 0 };
    return queue.reduce(
      (acc, q) => ({
        done: acc.done + q.labeledTurns,
        total: acc.total + q.totalTurns,
      }),
      { done: 0, total: 0 },
    );
  }, [queue]);

  return (
    <Box maxW="820px" mx="auto" px={{ base: 4, md: 6 }} py={6}>
      <PageHeader
        title="Labeling queue"
        subtitle={
          queue && queue.length > 0
            ? `${queue.length} session${queue.length === 1 ? "" : "s"} · ${totals.done}/${totals.total} turns scored`
            : undefined
        }
        rightSlot={
          <Button colorPalette="violet" size="sm" onClick={() => setShowAdd((v) => !v)}>
            <Plus size={15} style={{ marginRight: 6 }} />
            Add sessions
          </Button>
        }
      />

      <Box mt={5}>
        {showAdd && <AddCandidatesPanel onClose={() => setShowAdd(false)} />}

        {queue === undefined ? (
          <Flex justify="center" py={16}>
            <Spinner size="lg" color="violet.500" />
          </Flex>
        ) : isEmpty ? (
          <Surface p={8}>
            <VStack gap={3} textAlign="center" maxW="440px" mx="auto">
              <Box color="violet.400">
                <ChatCircleText size={30} weight="duotone" />
              </Box>
              <Text fontSize="sm" color="charcoal.600" lineHeight="1.6">
                This is a shared, blind scoring pass on real tutor conversations — you
                rate each tutor turn on the same rubric our AI judge uses, without seeing
                anyone else’s scores. Click <b>Add sessions</b> to pull in recent
                conversations, then open one to start labeling.
              </Text>
            </VStack>
          </Surface>
        ) : (
          <VStack gap={2.5} align="stretch">
            {queue.map((q) => (
              <Surface key={String(q.queueId)} p={4}>
                <Flex align="center" gap={4} wrap={{ base: "wrap", md: "nowrap" }}>
                  <Box flex={1} minW={0}>
                    <Text fontSize="sm" fontWeight="700" color="navy.600" truncate fontFamily="heading">
                      {q.title}
                    </Text>
                    <HStack gap={2} mt={0.5}>
                      <UnitChip title={q.unitTitle} emoji={q.unitEmoji} />
                      {q.overallScored && (
                        <Text fontSize="2xs" color="green.600" fontFamily="heading" fontWeight="700">
                          · overall set
                        </Text>
                      )}
                    </HStack>
                  </Box>

                  <ProgressBar done={q.labeledTurns} total={q.totalTurns} />

                  <HStack gap={1} flexShrink={0}>
                    <Button size="sm" colorPalette="violet" variant="subtle" onClick={() => onSelect(q.sessionId)}>
                      {q.labeledTurns > 0 ? "Continue" : "Label"}
                      <CaretRight size={13} style={{ marginLeft: 4 }} />
                    </Button>
                    <Box
                      as="button"
                      aria-label="Remove from queue"
                      p={2}
                      borderRadius="md"
                      color="charcoal.300"
                      cursor="pointer"
                      _hover={{ color: "red.500", bg: "gray.50" }}
                      onClick={() => {
                        void removeFromQueue({ queueId: q.queueId }).catch((e) =>
                          toaster.error({ title: "Couldn't remove", description: String(e) }),
                        );
                      }}
                    >
                      <Trash size={15} />
                    </Box>
                  </HStack>
                </Flex>
              </Surface>
            ))}
          </VStack>
        )}
      </Box>
    </Box>
  );
}
