"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Box,
  Button,
  IconButton,
  Input,
  Popover,
  Portal,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";

/**
 * Teacher manual-grading control for a single deliverable — a compact menu on
 * the verdict pip. Sets a three-state verdict (Not yet / Partial / Full) via
 * `deliverables.teacherSetCheck`. The primary use is scanned/offline work
 * (which a rubric check can't read), but it works on any deliverable, so a
 * teacher can also override an AI verdict.
 *
 * The pip glyph + color mirror the read-only display elsewhere:
 *   ✓ full (green) · ~ half (orange) · ✗ not (red) · · ungraded (gray)
 */
type Overall = "not" | "half" | "full";

const PIP: Record<Overall | "none", { glyph: string; color: string; label: string }> = {
  full: { glyph: "✓", color: "green.600", label: "Full" },
  half: { glyph: "~", color: "orange.600", label: "Partial" },
  not: { glyph: "✗", color: "red.600", label: "Not yet" },
  none: { glyph: "·", color: "charcoal.400", label: "Not graded" },
};

export function DeliverableGradeControl({
  deliverableId,
  overall,
  rubricFeedback,
  size = "md",
}: {
  deliverableId: Id<"deliverables">;
  overall: Overall | null;
  rubricFeedback?: string;
  size?: "sm" | "md";
}) {
  const setCheck = useMutation(api.deliverables.teacherSetCheck);
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingOverall, setPendingOverall] = useState<Exclude<Overall, "full"> | null>(
    null,
  );
  const [note, setNote] = useState("");
  const [initialNote, setInitialNote] = useState("");
  const current = PIP[overall ?? "none"];
  const fontSize = size === "sm" ? "sm" : "md";

  const saveGrade = async (next: Overall, feedback?: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await setCheck({ deliverableId, overall: next, feedback });
      setMenuOpen(false);
      setPendingOverall(null);
    } finally {
      setBusy(false);
    }
  };

  const chooseGrade = (next: Overall) => {
    if (busy) return;
    if (next === "full") {
      if (next !== overall) {
        void saveGrade(next);
      } else {
        setMenuOpen(false);
      }
      return;
    }
    const existing = rubricFeedback ?? "";
    setPendingOverall(next);
    setNote(existing);
    setInitialNote(existing);
  };

  const submitNote = () => {
    if (!pendingOverall) return;
    // An untouched (or untouched-after-trim) note means "grade only": send
    // no feedback so the backend preserves the existing reason + verdicts.
    // An edited note replaces it; an emptied note explicitly clears it.
    const trimmed = note.trim();
    void saveGrade(
      pendingOverall,
      trimmed === initialNote.trim() ? undefined : trimmed,
    );
  };

  // One overlay scope: the pip opens a single popover holding the three grade
  // options, plus the note form once Partial/Not yet is picked. (A Menu nested
  // inside a controlled Popover shares one trigger node between two Zag
  // machines — merged handlers double-fire and the menu loses its anchor rect.)
  return (
    <Popover.Root
      open={menuOpen}
      onOpenChange={(details) => {
        setMenuOpen(details.open);
        if (!details.open) setPendingOverall(null);
      }}
      positioning={{ placement: "bottom-start" }}
    >
      <Popover.Trigger asChild>
        <IconButton
          aria-label={`Grade — currently ${current.label}`}
          title={`Grade — ${current.label}`}
          size="2xs"
          variant="ghost"
          minW="20px"
          h="20px"
          color={current.color}
          fontWeight="700"
          fontSize={fontSize}
          _hover={{ bg: "gray.100" }}
        >
          {busy ? <Spinner size="xs" /> : current.glyph}
        </IconButton>
      </Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <Popover.Content
            w={pendingOverall ? "340px" : "10rem"}
            shadow="lg"
            borderRadius="lg"
          >
            <Popover.Body p={2}>
              <Stack gap={0}>
                {(["full", "half", "not"] as const).map((opt) => (
                  <Button
                    key={opt}
                    variant={opt === pendingOverall ? "subtle" : "ghost"}
                    size="sm"
                    justifyContent="flex-start"
                    fontFamily="heading"
                    fontWeight={opt === overall ? "700" : "500"}
                    onClick={() => chooseGrade(opt)}
                    disabled={busy}
                  >
                    <Box as="span" color={PIP[opt].color} fontWeight="700" w="14px">
                      {PIP[opt].glyph}
                    </Box>
                    {PIP[opt].label}
                  </Button>
                ))}
                {pendingOverall && (
                  <Stack
                    as="form"
                    gap={2}
                    pt={2}
                    mt={1}
                    px={2}
                    pb={2}
                    borderTopWidth="1px"
                    borderColor="gray.200"
                    onSubmit={(event) => {
                      event.preventDefault();
                      submitNote();
                    }}
                  >
                    <Input
                      autoFocus
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      placeholder="What's missing, and the one next step? The scholar sees this."
                      size="sm"
                      disabled={busy}
                    />
                    <Text fontSize="xs" color="charcoal.400" lineHeight="1.4">
                      Optional — but a lowered grade with no reason lands as
                      unexplained. Say the standard, not just the score.
                    </Text>
                    <Button
                      type="submit"
                      size="sm"
                      fontFamily="heading"
                      colorPalette="violet"
                      alignSelf="flex-end"
                      disabled={busy}
                    >
                      {busy && <Spinner size="xs" />}
                      Save grade
                    </Button>
                  </Stack>
                )}
              </Stack>
            </Popover.Body>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}
