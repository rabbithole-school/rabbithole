"use client";

/**
 * The core golden-set labeler: a transcript walker where each tutor turn gets a
 * scoring card (core dimensions by default; "Show all dimensions" adds the
 * rest). Scores save optimistically on every tap (one mutation per turn-save).
 * Ends with a whole-transcript overall score + note and a Done state.
 * WEB-ONLY (staff tool) — the native app is scholar-facing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Box,
  Button,
  Flex,
  HStack,
  Spinner,
  Switch,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import { ArrowLeft, Check } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  CORE_LABELING_DIMENSIONS,
  PER_TURN_DIMENSIONS,
} from "@/shared/tutorQualityRubric";
import { Surface } from "@/components/ui/Surface";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";
import { toaster } from "@/lib/toaster";
import { TurnScoreCard, type TurnLabelState } from "./TurnScoreCard";

type LabelMap = Record<string, TurnLabelState>;

function emptyTurn(): TurnLabelState {
  return { dims: {}, cantJudge: [], note: "" };
}

function turnHasContent(state: TurnLabelState | undefined): boolean {
  if (!state) return false;
  return Object.keys(state.dims).length > 0 || state.cantJudge.length > 0;
}

export function TranscriptLabeler({
  sessionId,
  onBack,
  scrollToMessageId,
}: {
  sessionId: Id<"sessions">;
  onBack: () => void;
  scrollToMessageId?: string;
}) {
  const data = useQuery(api.qualityLabeling.getLabelingSession, { sessionId });
  const saveTurn = useMutation(api.qualityLabeling.saveTurnLabel);
  const saveTranscript = useMutation(api.qualityLabeling.saveTranscriptLabel);

  const [showAll, setShowAll] = useState(false);
  const [labels, setLabels] = useState<LabelMap>({});
  const [overall, setOverall] = useState<number | undefined>(undefined);
  const [overallNote, setOverallNote] = useState("");
  const seededSession = useRef<string | null>(null);

  // Seed local state from the server ONCE per session (subsequent reactive
  // re-runs reflect our own optimistic saves; we don't re-clobber local edits).
  useEffect(() => {
    if (!data) return;
    if (seededSession.current === String(sessionId)) return;
    seededSession.current = String(sessionId);
    const seeded: LabelMap = {};
    for (const [msgId, l] of Object.entries(data.myTurnLabels)) {
      seeded[msgId] = {
        dims: { ...l.dims },
        cantJudge: [...l.cantJudge],
        note: l.note ?? "",
      };
    }
    setLabels(seeded);
    setOverall(data.myTranscriptLabel?.overall ?? undefined);
    setOverallNote(data.myTranscriptLabel?.note ?? "");
  }, [data, sessionId]);

  const dimensions = showAll ? PER_TURN_DIMENSIONS : CORE_LABELING_DIMENSIONS;

  const persistTurn = useCallback(
    (messageId: string, state: TurnLabelState) => {
      void saveTurn({
        sessionId,
        messageId: messageId as Id<"messages">,
        dims: state.dims,
        note: state.note.trim() ? state.note.trim() : undefined,
        cantJudge: state.cantJudge.length ? state.cantJudge : undefined,
      }).catch((e) => {
        toaster.error({ title: "Couldn't save score", description: String(e) });
      });
    },
    [saveTurn, sessionId],
  );

  const mutateTurn = useCallback(
    (messageId: string, fn: (prev: TurnLabelState) => TurnLabelState, persist = true) => {
      setLabels((prev) => {
        const current = prev[messageId] ?? emptyTurn();
        const next = fn(current);
        if (persist) persistTurn(messageId, next);
        return { ...prev, [messageId]: next };
      });
    },
    [persistTurn],
  );

  const onScore = useCallback(
    (messageId: string, dimKey: string, score: number) => {
      mutateTurn(messageId, (prev) => ({
        ...prev,
        dims: { ...prev.dims, [dimKey]: score },
        cantJudge: prev.cantJudge.filter((k) => k !== dimKey),
      }));
    },
    [mutateTurn],
  );

  const onCantJudge = useCallback(
    (messageId: string, dimKey: string) => {
      mutateTurn(messageId, (prev) => {
        const isCant = prev.cantJudge.includes(dimKey);
        const dims = { ...prev.dims };
        delete dims[dimKey];
        return {
          ...prev,
          dims,
          cantJudge: isCant
            ? prev.cantJudge.filter((k) => k !== dimKey)
            : [...prev.cantJudge, dimKey],
        };
      });
    },
    [mutateTurn],
  );

  const onClear = useCallback(
    (messageId: string, dimKey: string) => {
      mutateTurn(messageId, (prev) => {
        const dims = { ...prev.dims };
        delete dims[dimKey];
        return {
          ...prev,
          dims,
          cantJudge: prev.cantJudge.filter((k) => k !== dimKey),
        };
      });
    },
    [mutateTurn],
  );

  const onNoteChange = useCallback(
    (messageId: string, note: string) => {
      // Local only; committed on blur to avoid a mutation per keystroke.
      mutateTurn(messageId, (prev) => ({ ...prev, note }), false);
    },
    [mutateTurn],
  );

  const onNoteCommit = useCallback(
    (messageId: string) => {
      setLabels((prev) => {
        const state = prev[messageId];
        if (state) persistTurn(messageId, state);
        return prev;
      });
    },
    [persistTurn],
  );

  const persistTranscript = useCallback(
    (nextOverall: number | undefined, nextNote: string) => {
      void saveTranscript({
        sessionId,
        overall: nextOverall,
        note: nextNote.trim() ? nextNote.trim() : undefined,
      }).catch((e) => {
        toaster.error({ title: "Couldn't save overall", description: String(e) });
      });
    },
    [saveTranscript, sessionId],
  );

  // Scroll to a specific turn when arriving from the agreement report.
  useEffect(() => {
    if (!scrollToMessageId || !data) return;
    const el = document.getElementById(`turn-${scrollToMessageId}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [scrollToMessageId, data]);

  const tutorMessages = useMemo(
    () => (data?.messages ?? []).filter((m) => m.role === "assistant"),
    [data],
  );
  // 1-based tutor-turn number per assistant message (computed, not mutated
  // during render — keeps the transcript walker pure).
  const turnNumberById = useMemo(() => {
    const map: Record<string, number> = {};
    tutorMessages.forEach((m, i) => {
      map[String(m.id)] = i + 1;
    });
    return map;
  }, [tutorMessages]);
  const scoredCount = useMemo(
    () =>
      tutorMessages.filter((m) => turnHasContent(labels[String(m.id)])).length,
    [tutorMessages, labels],
  );
  const totalTurns = data?.tutorTurnCount ?? 0;
  const allDone = totalTurns > 0 && scoredCount === totalTurns;

  if (data === undefined) {
    return (
      <Flex justify="center" py={20}>
        <Spinner size="lg" color="violet.500" />
      </Flex>
    );
  }

  return (
    <Box maxW="820px" mx="auto" px={{ base: 4, md: 6 }} py={6}>
      <Button size="xs" variant="ghost" color="charcoal.500" mb={3} onClick={onBack}>
        <ArrowLeft size={13} style={{ marginRight: 4 }} />
        Back to queue
      </Button>

      <PageHeader
        eyebrow={data.unitTitle ? `${data.unitEmoji ?? ""} ${data.unitTitle}`.trim() : "Independent study"}
        title={data.title}
        subtitle={`${scoredCount} of ${totalTurns} tutor turns scored`}
      />

      <Flex justify="space-between" align="center" mt={4} mb={4} gap={3} wrap="wrap">
        <Text fontSize="xs" color="charcoal.400" maxW="520px">
          Score each tutor turn 1–5 (5 = healthy/desired). Hover a dimension for its
          definition. Use “?” when you genuinely can’t judge a dimension on that turn.
        </Text>
        <Switch.Root
          checked={showAll}
          onCheckedChange={(e) => setShowAll(e.checked)}
          colorPalette="violet"
        >
          <Switch.HiddenInput />
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Switch.Label>
            <Text fontSize="xs" fontFamily="heading" fontWeight="600" color="charcoal.500">
              Show all dimensions
            </Text>
          </Switch.Label>
        </Switch.Root>
      </Flex>

      <VStack gap={3} align="stretch">
        {data.messages.map((m) => {
          const key = String(m.id);
          if (m.role === "user") {
            return (
              <Box
                key={key}
                bg="white"
                borderWidth="1px"
                borderColor="gray.200"
                borderRadius="lg"
                p={3}
                ml={{ base: 0, md: 8 }}
              >
                <SectionEyebrow>Scholar</SectionEyebrow>
                <Text fontSize="sm" color="charcoal.600" lineHeight="1.5" whiteSpace="pre-wrap" mt={1}>
                  {m.content}
                </Text>
              </Box>
            );
          }
          const state = labels[key] ?? emptyTurn();
          return (
            <Box key={key} id={`turn-${key}`}>
              <TurnScoreCard
                turnNumber={turnNumberById[key]}
                tutorContent={m.content}
                dimensions={dimensions}
                label={state}
                scored={turnHasContent(state)}
                onScore={(dimKey, s) => onScore(key, dimKey, s)}
                onCantJudge={(dimKey) => onCantJudge(key, dimKey)}
                onClear={(dimKey) => onClear(key, dimKey)}
                onNoteChange={(note) => onNoteChange(key, note)}
                onNoteCommit={() => onNoteCommit(key)}
              />
            </Box>
          );
        })}
      </VStack>

      {/* Transcript-level overall */}
      <Surface p={4} mt={5}>
        <SectionEyebrow>Whole-transcript overall</SectionEyebrow>
        <Text fontSize="xs" color="charcoal.400" mt={1} mb={3}>
          Across the whole conversation: would you want a gifted kid talking to this
          tutor for an hour? (1 = no, 5 = yes.)
        </Text>
        <HStack gap={1} mb={3}>
          {[1, 2, 3, 4, 5].map((s) => (
            <Box
              key={s}
              as="button"
              aria-label={`Overall score ${s}`}
              aria-pressed={overall === s}
              minW="36px"
              h="36px"
              borderWidth="1px"
              borderRadius="md"
              cursor="pointer"
              fontFamily="heading"
              fontWeight="700"
              bg={overall === s ? "violet.500" : "white"}
              color={overall === s ? "white" : "charcoal.500"}
              borderColor={overall === s ? "violet.500" : "gray.200"}
              _hover={overall === s ? undefined : { bg: "gray.50" }}
              onClick={() => {
                const next = overall === s ? undefined : s;
                setOverall(next);
                persistTranscript(next, overallNote);
              }}
            >
              {s}
            </Box>
          ))}
        </HStack>
        <Textarea
          value={overallNote}
          onChange={(e) => setOverallNote(e.target.value)}
          onBlur={() => persistTranscript(overall, overallNote)}
          placeholder="Optional: a sentence on the overall pattern."
          size="sm"
          rows={2}
          resize="vertical"
          bg="white"
          borderColor="gray.200"
        />
      </Surface>

      <Flex
        justify="space-between"
        align="center"
        position="sticky"
        bottom="0"
        zIndex={1}
        bg="gray.50"
        borderTopWidth="1px"
        borderColor="gray.200"
        py={3}
        mt={5}
      >
        <HStack gap={2} color={allDone ? "green.600" : "charcoal.400"}>
          {allDone && <Check size={16} weight="bold" />}
          <Text fontSize="sm" fontFamily="heading" fontWeight="600">
            {allDone
              ? "All tutor turns scored"
              : `${scoredCount} of ${totalTurns} tutor turns scored`}
          </Text>
        </HStack>
        <Button colorPalette="violet" onClick={onBack}>
          <Check size={15} style={{ marginRight: 6 }} />
          Done — back to queue
        </Button>
      </Flex>
    </Box>
  );
}
