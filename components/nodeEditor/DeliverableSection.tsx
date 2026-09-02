"use client";

/**
 * Deliverable spec editor — extracted from ActivityFields into a
 * collapsed-by-default summary chip + click-through modal so the
 * editor doesn't burn 600+ vertical px just to show the deliverable
 * + rubric every time the teacher opens an activity. Mirrors the
 * ProcessPicker pattern (small in-form trigger → full modal).
 *
 * Surfaces:
 *   - Form: a STATIC summary of the configured deliverable
 *     ("Document · 3 criteria · Manual" + the prompt) with a single
 *     Edit action, or an "Add deliverable" button when none is set.
 *     Deliberately not a live kind dropdown: a deliverable's kind
 *     determines the shape of the work scholars submit (artifact vs.
 *     file vs. text — see the `deliverables` table), so an
 *     always-armed type switcher on the summary row implies a
 *     conversion the product cannot perform.
 *   - Modal: the ONE canonical place to configure the kind, plus the
 *     scholar-facing prompt + rubric (manual criteria list OR
 *     auto-mode notes) and removal. Fields persist on blur.
 *
 * TODO: when we add a Components drawer (Personas / Perspectives /
 * Processes already live there), pull the modal body out into a
 * reusable <DeliverableEditor /> so the drawer can host the same
 * surface. Deferred until the Components drawer actually grows a
 * "Deliverables" tab — premature abstraction otherwise.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Button,
  CloseButton,
  Dialog,
  Flex,
  HStack,
  Portal,
  Stack,
  Text,
  Textarea,
} from "@chakra-ui/react";
import { Plus } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DeliverableKindIcon } from "@/components/DeliverableKindIcon";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { CriteriaEditor } from "../CriteriaEditor";
import { Field } from "./shared";

type DeliverableKind =
  | "text"
  | "artifact"
  | "photo"
  | "slides"
  | "audio"
  | "map";
type DeliverableMode = "manual" | "auto" | "none";

const KIND_OPTIONS: Array<{ value: DeliverableKind; label: string }> = [
  { value: "text", label: "Document" },
  { value: "artifact", label: "Artifact" },
  { value: "photo", label: "Photo" },
  { value: "slides", label: "Slides" },
  { value: "audio", label: "Audio" },
  { value: "map", label: "Map" },
];

const kindLabel = (kind: DeliverableKind) =>
  KIND_OPTIONS.find((o) => o.value === kind)?.label ?? "Deliverable";

export function DeliverableSection({
  activityId,
}: {
  activityId: Id<"activities">;
}) {
  const activity = useQuery(api.activities.get, { id: activityId });

  const deliverable = activity?.deliverable ?? null;
  const enabled = !!deliverable;
  const kind = (deliverable?.kind ?? "text") as DeliverableKind;

  // Rubric half of the summary line.
  const summary = (() => {
    const m = deliverable?.mode ?? "manual";
    if (m === "none") return "No rubric";
    if (m === "auto") return "Auto rubric · per scholar";
    const n = deliverable?.criteria?.length ?? 0;
    return `Manual rubric · ${n} criteri${n === 1 ? "on" : "a"}`;
  })();

  const [open, setOpen] = useState(false);

  return (
    <>
      <Field
        label="Deliverable"
        hint={
          enabled
            ? deliverable?.mode === "none"
              ? "Scholar sends this work; completion stays separate."
              : "Scholar can check this work as they go. Full criteria become flair; completion stays separate."
            : "Activity is done when the scholar (or you) say so."
        }
      >
        {enabled ? (
          // Static summary of what's configured. The kind lives in the
          // editor, not here — see the file header.
          <Flex
            align="center"
            gap={3}
            px={3}
            py={2.5}
            bg="violet.50"
            borderWidth="1px"
            borderColor="violet.200"
            borderRadius="md"
          >
            <DeliverableKindIcon kind={kind} color="navy.500" />
            <Stack gap={0.5} flex={1} minW={0}>
              <HStack gap={1.5} minW={0}>
                <Text
                  fontFamily="heading"
                  fontWeight="700"
                  fontSize="sm"
                  color="navy.500"
                >
                  {kindLabel(kind)}
                </Text>
                <Text fontSize="2xs" color="charcoal.400" fontFamily="heading">
                  · {summary}
                </Text>
              </HStack>
              <Text
                fontSize="2xs"
                color="charcoal.500"
                fontFamily="body"
                overflow="hidden"
                textOverflow="ellipsis"
                whiteSpace="nowrap"
              >
                {deliverable?.prompt?.trim() || "No prompt yet"}
              </Text>
            </Stack>
            <Button
              size="xs"
              variant="outline"
              colorPalette="violet"
              fontFamily="heading"
              flexShrink={0}
              aria-label={`Edit ${kindLabel(kind).toLowerCase()} deliverable`}
              onClick={() => setOpen(true)}
            >
              Edit
            </Button>
          </Flex>
        ) : (
          <Button
            size="sm"
            variant="outline"
            colorPalette="violet"
            fontFamily="heading"
            alignSelf="flex-start"
            onClick={() => setOpen(true)}
          >
            <Plus size={14} weight="bold" />
            Add deliverable
          </Button>
        )}
      </Field>

      {open && (
        <DeliverableEditorModal
          activityId={activityId}
          isNew={!enabled}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

// ── Modal body ────────────────────────────────────────────────────

function DeliverableEditorModal({
  activityId,
  isNew,
  onClose,
}: {
  activityId: Id<"activities">;
  /** No deliverable configured yet — the kind is still an open choice. */
  isNew: boolean;
  onClose: () => void;
}) {
  const activity = useQuery(api.activities.get, { id: activityId });
  const update = useMutation(api.activities.update);
  const deliverable = activity?.deliverable ?? null;

  // Local draft state mirrors the inline editor's local state — load
  // from the activity, flush on blur of each field.
  const initialKind = (deliverable?.kind ?? "text") as DeliverableKind;
  const [kind, setKind] = useState<DeliverableKind>(initialKind);
  // The kind picker is open by default only while creating. On an
  // existing deliverable it takes a deliberate "Change kind" — the
  // kind decides the shape of what scholars submit, so switching it
  // is a re-spec of the activity, not a display toggle.
  const [pickingKind, setPickingKind] = useState(isNew);
  const [mode, setMode] = useState<DeliverableMode>(
    deliverable?.mode ?? "none",
  );
  const [prompt, setPrompt] = useState(deliverable?.prompt ?? "");
  const [notes, setNotes] = useState(deliverable?.notes ?? "");
  const [criteria, setCriteria] = useState<
    Array<{ id: string; label: string; description?: string }>
  >(
    deliverable?.criteria?.map((c) => ({
      id: c.id,
      label: c.label,
      description: c.description,
    })) ?? [],
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  // Re-sync draft when activity changes underneath us.
  useEffect(() => {
    if (!deliverable) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setKind(deliverable.kind as DeliverableKind);
    setMode(deliverable.mode as DeliverableMode);
    setPrompt(deliverable.prompt);
    setNotes(deliverable.notes ?? "");
    setCriteria(
      deliverable.criteria?.map((c) => ({
        id: c.id,
        label: c.label,
        description: c.description,
      })) ?? [],
    );
  }, [deliverable]);

  const persist = async (
    overrides: Partial<{
      kind: DeliverableKind;
      prompt: string;
      criteria: typeof criteria;
      mode: DeliverableMode;
      notes: string;
    }> = {},
    reportValidation = false,
  ): Promise<boolean> => {
    const k = overrides.kind ?? kind;
    const p = overrides.prompt ?? prompt;
    const c = overrides.criteria ?? criteria;
    const m = overrides.mode ?? mode;
    const n = overrides.notes ?? notes;
    // Manual needs at least one labeled criterion; auto + none need
    // nothing beyond the prompt. Server-side normalize will strip
    // criteria + notes when mode === "none".
    const criteriaOk =
      m === "manual" ? c.length > 0 && c.every((x) => x.label.trim()) : true;
    if (!p.trim()) {
      if (reportValidation) setSaveError("Add a deliverable prompt.");
      return false;
    }
    if (!criteriaOk) {
      if (reportValidation) {
        setSaveError(
          "Add at least one criterion, or choose Auto or No rubric.",
        );
      }
      return false;
    }
    setSaveError(null);
    try {
      await update({
        id: activityId,
        deliverable: {
          kind: k,
          prompt: p,
          mode: m,
          notes: n.trim() ? n : undefined,
          criteria: c.map((x) => ({
            id: x.id,
            label: x.label,
            description: x.description,
          })),
        },
      });
      return true;
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "Couldn’t save deliverable.",
      );
      return false;
    }
  };

  const handleDone = async () => {
    if (saving) return;
    // Opened "Add deliverable", touched nothing — treat Done / close
    // as "never mind" instead of blocking on validation for a spec
    // that was never started.
    const untouched =
      !prompt.trim() &&
      !notes.trim() &&
      criteria.length === 0 &&
      kind === initialKind;
    if (isNew && !deliverable && untouched) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      if (await persist({}, true)) onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    if (saving || removing) return;
    if (
      !confirm(
        "Remove this deliverable? The activity goes back to being done when you (or the scholar) say so. Work scholars already submitted isn’t deleted.",
      )
    ) {
      return;
    }
    setRemoving(true);
    try {
      await update({ id: activityId, deliverable: null });
      onClose();
    } catch (error) {
      setSaveError(
        error instanceof Error
          ? error.message
          : "Couldn’t remove deliverable.",
      );
    } finally {
      setRemoving(false);
    }
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(d) => {
        if (!d.open) {
          void handleDone();
        }
      }}
      placement="center"
      motionPreset="slide-in-bottom"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="3xl">
            <Dialog.Header px={6} pt={5} pb={2}>
              <Dialog.Title
                fontFamily="heading"
                fontWeight="700"
                color="navy.500"
                fontSize="lg"
                flex={1}
              >
                {isNew ? "Add deliverable" : "Deliverable"}
              </Dialog.Title>
              <Dialog.CloseTrigger asChild>
                <CloseButton size="sm" color="charcoal.400" />
              </Dialog.CloseTrigger>
            </Dialog.Header>
            <Dialog.Body
              px={6}
              py={3}
              maxH="70vh"
              overflowY="auto"
            >
              <Stack gap={4}>
                <Field
                  label="Kind"
                  hint="What the scholar produces. Document = writing in Rabbithole; Artifact = code / interactive; Map = pins on a tutor-opened map; Photo / Slides / Audio = media."
                >
                  {pickingKind ? (
                    <Stack gap={2}>
                      <HStack
                        gap={1.5}
                        wrap="wrap"
                        role="radiogroup"
                        aria-label="Deliverable kind"
                      >
                        {KIND_OPTIONS.map((opt) => {
                          const active = kind === opt.value;
                          return (
                            <Button
                              key={opt.value}
                              role="radio"
                              aria-checked={active}
                              size="xs"
                              borderRadius="full"
                              variant={active ? "solid" : "outline"}
                              colorPalette="violet"
                              fontFamily="heading"
                              onClick={() => {
                                setKind(opt.value);
                                if (!isNew) {
                                  setPickingKind(false);
                                  void persist({ kind: opt.value });
                                }
                              }}
                            >
                              <DeliverableKindIcon
                                kind={opt.value}
                                size={14}
                                color={active ? "white" : "charcoal.500"}
                              />
                              {opt.label}
                            </Button>
                          );
                        })}
                      </HStack>
                      {!isNew && (
                        <Text
                          fontSize="2xs"
                          color="charcoal.400"
                          fontFamily="body"
                          lineHeight="1.4"
                        >
                          Work scholars have already submitted keeps the
                          form it was made in &mdash; changing the kind
                          only applies to submissions from here on.
                        </Text>
                      )}
                    </Stack>
                  ) : (
                    <HStack gap={2}>
                      <DeliverableKindIcon kind={kind} color="navy.500" />
                      <Text
                        fontFamily="heading"
                        fontWeight="600"
                        fontSize="sm"
                        color="navy.500"
                      >
                        {kindLabel(kind)}
                      </Text>
                      <Button
                        size="xs"
                        variant="ghost"
                        colorPalette="violet"
                        fontFamily="heading"
                        onClick={() => setPickingKind(true)}
                      >
                        Change kind
                      </Button>
                    </HStack>
                  )}
                </Field>

                <Field
                  label="Deliverable prompt"
                  hint="Scholar-facing description of what they should produce. 1-2 sentences, address the scholar directly."
                >
                  <Textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onBlur={() => void persist()}
                    rows={3}
                    fontSize="sm"
                    fontFamily="body"
                    borderColor="gray.200"
                    _focus={{ borderColor: "violet.400", boxShadow: "none" }}
                    placeholder="e.g. Write a short story about your weekend — what happened, who was there, why it mattered to you."
                  />
                </Field>

                <Field
                  label="Rubric"
                  hint="Manual: you write the criteria yourself, same for every scholar. Auto: the AI generates 3–5 criteria per scholar at session start, calibrated to their reading level. No rubric: the scholar gets the document to fill in but no AI grading."
                >
                  <HStack gap={1} mb={2}>
                    {(
                      [
                        { value: "manual", label: "Manual criteria" },
                        { value: "auto", label: "Auto (per scholar)" },
                        { value: "none", label: "No rubric" },
                      ] as const
                    ).map(({ value: m, label }) => {
                      const active = mode === m;
                      return (
                        <button
                          key={m}
                          type="button"
                          onClick={() => {
                            setMode(m);
                            void persist({ mode: m });
                          }}
                          style={{
                            padding: "6px 12px",
                            borderRadius: "999px",
                            border: `1px solid var(--chakra-colors-${active ? "violet-500" : "gray-200"})`,
                            background: active
                              ? "var(--chakra-colors-violet-500)"
                              : "white",
                            color: active
                              ? "white"
                              : "var(--chakra-colors-charcoal-500)",
                            fontSize: "0.75rem",
                            fontFamily: "var(--font-heading)",
                            fontWeight: 600,
                            cursor: "pointer",
                            transition: "all 0.15s",
                          }}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </HStack>
                  {mode === "none" ? (
                    <Text
                      fontSize="2xs"
                      color="charcoal.400"
                      fontFamily="body"
                      lineHeight="1.4"
                    >
                      The scholar opens the document so they know they
                      need to fill it in, but the AI tutor won&apos;t
                      grade it. Mark the activity complete from the
                      teacher dashboard (or have the scholar mark it
                      done themselves) when the work&apos;s in.
                    </Text>
                  ) : mode === "manual" ? (
                    <CriteriaEditor
                      value={criteria}
                      onChange={(next) => setCriteria(next)}
                      onBlur={() => void persist()}
                    />
                  ) : (
                    <Stack gap={1.5}>
                      <Text
                        fontSize="2xs"
                        color="charcoal.400"
                        fontFamily="body"
                        lineHeight="1.4"
                      >
                        Optional notes for the AI rubric generator.
                        Describe the quality bar, what dimensions matter,
                        any pitfalls. The AI calibrates per scholar &mdash;
                        a 1st-grader and a 5th-grader doing this activity
                        will see different bars for length and mechanics
                        but the same bar for specificity / structure.
                      </Text>
                      <Textarea
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        onBlur={() => void persist()}
                        rows={4}
                        fontSize="sm"
                        fontFamily="body"
                        borderColor="gray.200"
                        _focus={{
                          borderColor: "violet.400",
                          boxShadow: "none",
                        }}
                        placeholder="e.g. Look for a clear narrative arc, specific details (a named person or moment), grade-appropriate mechanics. Avoid 'I had fun' style summaries."
                      />
                    </Stack>
                  )}
                </Field>
              </Stack>
            </Dialog.Body>
            <Dialog.Footer
              px={6}
              pb={5}
              pt={3}
              borderTop="1px solid"
              borderColor="gray.100"
            >
              <HStack gap={3} mr="auto" minW={0}>
                {!isNew && (
                  <Button
                    size="sm"
                    variant="ghost"
                    colorPalette="red"
                    fontFamily="heading"
                    onClick={() => void handleRemove()}
                    disabled={saving || removing}
                  >
                    Remove deliverable
                  </Button>
                )}
                {saveError && (
                  <Text fontSize="sm" color="red.600" role="alert">
                    {saveError}
                  </Text>
                )}
              </HStack>
              <Button
                size="sm"
                colorPalette="violet"
                fontFamily="heading"
                onClick={() => void handleDone()}
                disabled={saving || removing}
              >
                Done
              </Button>
            </Dialog.Footer>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
