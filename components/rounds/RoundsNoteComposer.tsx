"use client";

/**
 * The team note composer — the one thing Rounds actually writes for a scholar
 * each week. Used inline on the week board and again, larger, in the
 * per-scholar pane.
 *
 * Concurrency is the interesting part. Several people type into the same
 * meeting at once, so every save carries the `noteVersion` it was read at and
 * a stale write is REFUSED by the server rather than merged. When that
 * happens we keep the writer's words on screen, show the note that landed
 * first, and make them choose. Nothing is ever silently overwritten.
 */

import { useState } from "react";
import { Box, Button, HStack, Stack, Text, Textarea } from "@chakra-ui/react";
import { useMutation } from "convex/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

import {
  MAX_NOTE_LEN,
  NOTE_BUDGET_VISIBLE_AT,
  resolveNoteDraft,
  roundsDateTime,
  roundsWriteFailure,
  type StoredNoteDraft,
} from "./roundsEvidence";

export interface RoundsNoteComposerProps {
  /** Meeting identity — the note materializes the meeting server-side, so the
   *  composer never needs a pre-existing entryId. */
  periodId: string;
  weekKey: string | null;
  scholarId: string;
  scholarName: string;
  note: string | null;
  noteVersion: number | null;
  discussedAt: number | null;
  discussedByName: string | null;
  scope?: string;
  /** Which cadence's meeting this note belongs to. The server refuses a note
   *  written against the wrong cadence, so an SEL row must send "sel". */
  cadence?: "academic" | "sel";
  /** The pane gives the note more room and a heading; the board runs tight. */
  size?: "board" | "pane";
  /**
   * The lifted draft for this entry, when the parent owns it. On the board the
   * composer is unmounted the moment its row collapses, so the board holds the
   * draft (keyed by entryId) and passes it in here; the composer becomes
   * controlled for the draft text + version. When omitted (the pane, which
   * never collapses) the composer keeps its own local draft state.
   */
  draft?: StoredNoteDraft | null;
  onDraftChange?: (draft: StoredNoteDraft) => void;
  onDraftDiscard?: () => void;
}

export function RoundsNoteComposer({
  periodId,
  weekKey,
  scholarId,
  scholarName,
  note,
  noteVersion,
  discussedAt,
  discussedByName,
  scope,
  cadence,
  size = "board",
  draft,
  onDraftChange,
  onDraftDiscard,
}: RoundsNoteComposerProps) {
  const saveNote = useMutation(api.rounds.saveNote);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  // The draft (text + the version it was started from) lives in the PARENT when
  // the parent supplies `onDraftChange` — that is what keeps an unsaved note
  // alive across the row collapsing/unmounting. Otherwise it lives here, keyed
  // by nothing because the pane mounts exactly one composer.
  const controlled = onDraftChange !== undefined;
  const [localDraft, setLocalDraft] = useState<StoredNoteDraft | null>(null);
  const stored = controlled ? (draft ?? null) : localDraft;
  const writeDraft = (next: StoredNoteDraft) => {
    if (controlled) onDraftChange?.(next);
    else setLocalDraft(next);
  };
  const clearDraft = () => {
    if (controlled) onDraftDiscard?.();
    else setLocalDraft(null);
  };

  // Clean → follow the server; dirty → hold the writer's words and the version
  // they started from. Derived, so a note someone else saved appears without a
  // reload and no reconciliation effect is needed.
  const { text: draftText, dirty, baseVersion } = resolveNoteDraft(
    stored,
    note,
    noteVersion,
  );

  const theirs = note ?? "";
  const incomingChanged = dirty && noteVersion !== baseVersion;

  // The server stores at most MAX_NOTE_LEN characters and refuses the write
  // outright above it — and it measures the TRIMMED note, so we do too. Someone
  // typing live in a meeting must see the budget coming rather than lose a
  // paragraph to a rejection they never anticipated. Silent until it is close.
  const noteLength = draftText.trim().length;
  const overBudget = noteLength > MAX_NOTE_LEN;
  const showBudget = noteLength >= NOTE_BUDGET_VISIBLE_AT;
  const budgetText = `${noteLength.toLocaleString("en-GB")} of ${MAX_NOTE_LEN.toLocaleString("en-GB")} characters`;

  async function submit(expectedVersion: number | null) {
    if (!weekKey) return;
    if (draftText.trim().length > MAX_NOTE_LEN) {
      // Refuse locally with the same sentence the server would produce, so the
      // writer's words stay on screen and nothing round-trips to be rejected.
      setError(roundsWriteFailure(new Error("Keep the note under"), scholarName));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await saveNote({
        periodId: periodId as Id<"reportingPeriods">,
        weekKey,
        scholarId: scholarId as Id<"users">,
        note: draftText,
        expectedVersion,
        cadence,
        scope,
      });
      clearDraft();
      setConflict(false);
    } catch (e) {
      const message = roundsWriteFailure(e, scholarName);
      setError(message);
      setConflict(/changed while you were writing/.test(String(e)));
    } finally {
      setSaving(false);
    }
  }

  // The note materializes the meeting on write, so the editor is always enabled
  // once we know which week it is (the pane only mounts the composer with a
  // resolved week).
  const disabled = !weekKey;

  return (
    <Stack gap={2}>
      {size === "pane" ? (
        <Stack gap={0.5}>
          <Text fontFamily="heading" fontSize="md" fontWeight="700" color="charcoal.600">
            Staff note
          </Text>
          <Text fontFamily="heading" fontSize="sm" color="charcoal.400">
            Staff only · the tutor never sees this
          </Text>
        </Stack>
      ) : null}

      <Textarea
        value={draftText}
        onChange={(e) => {
          // Capture the version the edit is based on at the FIRST keystroke,
          // then keep it, so a later concurrent save is still detected.
          writeDraft({
            text: e.target.value,
            baseVersion: stored?.baseVersion ?? noteVersion,
          });
        }}
        disabled={disabled || saving}
        rows={size === "pane" ? 5 : 3}
        resize="vertical"
        bg={disabled ? "gray.50" : "gray.50"}
        borderColor="gray.200"
        borderWidth="1px"
        borderRadius="md"
        fontFamily="body"
        fontSize="sm"
        lineHeight="1.5"
        color="charcoal.600"
        _placeholder={{ color: "charcoal.300" }}
        placeholder={`What did the team decide about ${scholarName}?`}
        aria-label={`Staff note for ${scholarName}`}
      />

      {showBudget ? (
        <Text
          fontFamily="heading"
          fontSize="sm"
          color={overBudget ? "orange.600" : "charcoal.400"}
        >
          {overBudget
            ? `${budgetText} — too long to save. Trim it and the note will go through.`
            : `${budgetText} — Rounds stops there.`}
        </Text>
      ) : null}

      <HStack gap={3} flexWrap="wrap">
        <Button
          size="sm"
          colorPalette="gray"
          variant="solid"
          onClick={() => void submit(baseVersion)}
          disabled={disabled || saving || !dirty || overBudget}
          fontFamily="heading"
        >
          {saving ? "Saving…" : "Save note"}
        </Button>
        {dirty && !saving ? (
          <Button
            size="sm"
            variant="ghost"
            colorPalette="gray"
            fontFamily="heading"
            onClick={() => {
              clearDraft();
              setError(null);
              setConflict(false);
            }}
          >
            Discard my edit
          </Button>
        ) : null}
        {discussedAt && !dirty ? (
          <Text fontFamily="heading" fontSize="sm" color="charcoal.300">
            Saved {roundsDateTime(discussedAt)}
            {discussedByName ? ` by ${discussedByName}` : ""}
          </Text>
        ) : null}
      </HStack>

      {incomingChanged && !conflict ? (
        <Box
          borderWidth="1px"
          borderColor="orange.300"
          borderRadius="md"
          bg="orange.50"
          px={3}
          py={2}
        >
          <Text fontFamily="body" fontSize="sm" color="charcoal.600">
            Someone else in the meeting just saved a note for {scholarName}.
            Saving now will refuse rather than overwrite it.
          </Text>
        </Box>
      ) : null}

      {error ? (
        <Box
          borderWidth="1px"
          borderColor="orange.300"
          borderRadius="md"
          bg="orange.50"
          px={3}
          py={2}
        >
          <Text fontFamily="body" fontSize="sm" color="charcoal.600">
            {error}
          </Text>
          {conflict ? (
            <Stack gap={2} mt={2}>
              <Box
                borderWidth="1px"
                borderColor="gray.200"
                borderRadius="md"
                bg="white"
                px={3}
                py={2}
              >
                <Text fontFamily="heading" fontSize="sm" color="charcoal.400">
                  Saved first
                  {discussedByName ? ` by ${discussedByName}` : ""}
                </Text>
                <Text fontFamily="body" fontSize="sm" color="charcoal.600" mt={1}>
                  {theirs || "(empty)"}
                </Text>
              </Box>
              <HStack gap={2} flexWrap="wrap">
                <Button
                  size="sm"
                  variant="outline"
                  colorPalette="gray"
                  fontFamily="heading"
                  onClick={() => {
                    clearDraft();
                    setError(null);
                    setConflict(false);
                  }}
                >
                  Keep theirs
                </Button>
                <Button
                  size="sm"
                  variant="solid"
                  colorPalette="gray"
                  fontFamily="heading"
                  onClick={() => void submit(noteVersion)}
                  disabled={saving || overBudget}
                >
                  Replace with mine
                </Button>
              </HStack>
            </Stack>
          ) : null}
        </Box>
      ) : null}
    </Stack>
  );
}
