"use client";

/**
 * Guidance — the standing instructions the tutor reads to THIS scholar at the
 * start of every session. Rounds is where they get their weekly hearing: the
 * room looks at what is running, decides whether it still earns its place, and
 * either keeps it, makes it standing, ends it, or brings a lapsed one back.
 *
 * Guidance is per-scholar. That is the core idea of Rounds — the meeting is a
 * walk through children, not through topics, and what comes out of each stop
 * is guidance for that one child.
 *
 * ⚠️ There is deliberately NO affordance here for pulling text out of the
 * evidence column. No copy button, no click-to-insert, no "quote this". The
 * observer writes teacher-facing analysis that can carry clinical framing;
 * guidance is read verbatim by the model to a child. Whoever writes guidance
 * types it themselves, in words meant for the child to hear.
 */

import { useState } from "react";
import {
  Box,
  Button,
  HStack,
  Input,
  Stack,
  Text,
  Textarea,
} from "@chakra-ui/react";
import { useMutation } from "convex/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

import { roundsDate } from "./roundsEvidence";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface GuidanceRow {
  _id: string;
  label: string;
  content: string;
  expiresAt: number | null;
  isActive?: boolean;
  fromThisMeeting?: boolean;
  updatedAt: number;
}

function lifecycleLine(row: GuidanceRow, nowMs: number): string {
  if (row.expiresAt === null || row.expiresAt === undefined) {
    return "Standing · no end date";
  }
  if (row.expiresAt <= nowMs) {
    return `Ended ${roundsDate(row.expiresAt)}`;
  }
  return `Ends ${roundsDate(row.expiresAt)}`;
}

function VerbButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      size="sm"
      variant="outline"
      colorPalette="green"
      fontFamily="heading"
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </Button>
  );
}

function GuidanceItem({
  row,
  nowMs,
  meetingId,
  busy,
  onSetExpiry,
}: {
  row: GuidanceRow;
  nowMs: number;
  meetingId: string | null;
  busy: boolean;
  onSetExpiry: (id: string, expiresAt: number | null) => void;
}) {
  const [dateDraft, setDateDraft] = useState("");
  const ended = row.expiresAt !== null && row.expiresAt !== undefined && row.expiresAt <= nowMs;

  return (
    <Box
      borderWidth="1px"
      borderColor="green.200"
      borderRadius="md"
      bg={ended ? "gray.50" : "white"}
      px={4}
      py={3}
    >
      <HStack justify="space-between" align="flex-start" gap={3} flexWrap="wrap">
        <Stack gap={0.5} flex="1" minW="12rem">
          <Text fontFamily="heading" fontSize="lg" fontWeight="700" color="charcoal.600">
            {row.label}
          </Text>
          <Text fontFamily="heading" fontSize="sm" color="charcoal.400">
            {lifecycleLine(row, nowMs)}
            {row.fromThisMeeting ? " · written in this meeting" : ""}
          </Text>
        </Stack>
      </HStack>

      <Text fontFamily="body" fontSize="md" color="charcoal.600" mt={2} lineHeight="1.55">
        {row.content}
      </Text>

      <HStack gap={2} mt={3} flexWrap="wrap">
        {ended ? (
          <VerbButton
            disabled={busy || !meetingId}
            onClick={() => onSetExpiry(row._id, nowMs + 7 * DAY_MS)}
          >
            Bring it back
          </VerbButton>
        ) : (
          <>
            <VerbButton
              disabled={busy || !meetingId}
              onClick={() => onSetExpiry(row._id, nowMs + 7 * DAY_MS)}
            >
              Keep another week
            </VerbButton>
            <VerbButton
              disabled={busy || !meetingId}
              onClick={() => onSetExpiry(row._id, null)}
            >
              Make it standing
            </VerbButton>
            <VerbButton
              disabled={busy || !meetingId}
              onClick={() => onSetExpiry(row._id, nowMs)}
            >
              End now
            </VerbButton>
          </>
        )}
      </HStack>

      <HStack gap={2} mt={2} flexWrap="wrap" align="center">
        <Text fontFamily="heading" fontSize="sm" color="charcoal.400">
          Give it an end date
        </Text>
        <Input
          type="date"
          size="sm"
          maxW="11rem"
          value={dateDraft}
          onChange={(e) => setDateDraft(e.target.value)}
          borderColor="gray.200"
          fontFamily="heading"
          fontSize="sm"
          aria-label={`End date for ${row.label}`}
        />
        <Button
          size="sm"
          variant="ghost"
          colorPalette="green"
          fontFamily="heading"
          disabled={busy || !meetingId || !dateDraft}
          onClick={() => {
            const parsed = Date.parse(`${dateDraft}T23:59:59`);
            if (!Number.isFinite(parsed)) return;
            onSetExpiry(row._id, parsed);
            setDateDraft("");
          }}
        >
          Set
        </Button>
      </HStack>
    </Box>
  );
}

export function RoundsGuidanceCard({
  scholarId,
  scholarName,
  guidance,
  meetingId,
  nowMs,
}: {
  scholarId: string;
  scholarName: string;
  guidance: GuidanceRow[];
  /** Null until this week's Rounds meeting exists (it materializes when the
   *  first staff note of the week is written). Guidance attaches to it. */
  meetingId: string | null;
  nowMs: number;
}) {
  const setExpiry = useMutation(api.teacherDirectives.setExpiry);
  const upsert = useMutation(api.teacherDirectives.upsertByTeacher);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [content, setContent] = useState("");

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box
      borderWidth="1px"
      borderColor="green.300"
      borderRadius="lg"
      bg="green.50"
      p={5}
    >
      <Stack gap={1} mb={4}>
        <Text fontFamily="heading" fontSize="xl" fontWeight="700" color="charcoal.600">
          Guidance for {scholarName}
        </Text>
        <HStack gap={2} align="center">
          <Box w="0.55rem" h="0.55rem" borderRadius="full" bg="green.500" aria-hidden />
          <Text fontFamily="heading" fontSize="md" fontWeight="600" color="green.700">
            The tutor reads this at the start of every session
          </Text>
        </HStack>
      </Stack>

      {!meetingId ? (
        <Text fontFamily="body" fontSize="md" color="charcoal.500" mb={3}>
          Write this week&rsquo;s staff note first to start Rounds — guidance then
          attaches to that meeting.
        </Text>
      ) : null}

      <Stack gap={3}>
        {guidance.length === 0 ? (
          <Text fontFamily="body" fontSize="md" color="charcoal.400">
            Nothing is running for {scholarName} right now.
          </Text>
        ) : (
          guidance.map((row) => (
            <GuidanceItem
              key={row._id}
              row={row}
              nowMs={nowMs}
              meetingId={meetingId}
              busy={busy}
              onSetExpiry={(id, expiresAt) =>
                void run(() =>
                  setExpiry({
                    id: id as Id<"teacherDirectives">,
                    expiresAt,
                    sourceMeetingId: meetingId
                      ? (meetingId as Id<"scholarReviewMeetings">)
                      : undefined,
                  }),
                )
              }
            />
          ))
        )}
      </Stack>

      <Box
        borderWidth="1px"
        borderColor="green.200"
        borderRadius="md"
        bg="white"
        px={4}
        py={3}
        mt={4}
      >
        <Text fontFamily="heading" fontSize="md" fontWeight="700" color="charcoal.600">
          Write new guidance
        </Text>
        <Text fontFamily="heading" fontSize="sm" color="charcoal.400" mb={2}>
          In words meant for {scholarName} to hear.
        </Text>
        <Stack gap={2}>
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="What is it called? e.g. Slow the first answer down"
            borderColor="gray.200"
            fontFamily="heading"
            fontSize="md"
            aria-label="Guidance label"
          />
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={4}
            resize="vertical"
            borderColor="gray.200"
            fontFamily="body"
            fontSize="md"
            lineHeight="1.5"
            placeholder="What should the tutor do differently?"
            aria-label="Guidance text"
          />
          <HStack gap={3} flexWrap="wrap">
            <Button
              size="sm"
              colorPalette="green"
              variant="solid"
              fontFamily="heading"
              disabled={busy || !meetingId || !label.trim() || !content.trim()}
              onClick={() =>
                void run(async () => {
                  await upsert({
                    scholarId: scholarId as Id<"users">,
                    label: label.trim(),
                    content: content.trim(),
                    expiresAt: nowMs + 7 * DAY_MS,
                    sourceMeetingId: meetingId
                      ? (meetingId as Id<"scholarReviewMeetings">)
                      : undefined,
                  });
                  setLabel("");
                  setContent("");
                })
              }
            >
              Add for a week
            </Button>
            <Button
              size="sm"
              colorPalette="green"
              variant="outline"
              fontFamily="heading"
              disabled={busy || !meetingId || !label.trim() || !content.trim()}
              onClick={() =>
                void run(async () => {
                  await upsert({
                    scholarId: scholarId as Id<"users">,
                    label: label.trim(),
                    content: content.trim(),
                    expiresAt: null,
                    sourceMeetingId: meetingId
                      ? (meetingId as Id<"scholarReviewMeetings">)
                      : undefined,
                  });
                  setLabel("");
                  setContent("");
                })
              }
            >
              Add as standing
            </Button>
          </HStack>
        </Stack>
      </Box>

      {error ? (
        <Box
          borderWidth="1px"
          borderColor="orange.300"
          borderRadius="md"
          bg="orange.50"
          px={3}
          py={2}
          mt={3}
        >
          <Text fontFamily="body" fontSize="md" color="charcoal.600">
            {error}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
