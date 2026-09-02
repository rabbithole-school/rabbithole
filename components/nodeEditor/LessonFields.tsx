"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import {
  Box,
  Button,
  Flex,
  HStack,
  Input,
  Menu,
  Portal,
  Text,
} from "@chakra-ui/react";
import { CaretDown, Check } from "@phosphor-icons/react";
import { STRAND_CONFIG, STRAND_ORDER, type Strand } from "@/lib/constants";
import { NodeActionsMenu } from "@/components/NodeActionsMenu";
import {
  ConfirmDeleteDialog,
  Field,
  Scroll,
  SegmentedButtonGroup,
  SectionHeader,
} from "./shared";
import { NodeEditorSkeleton } from "./NodeEditorSkeleton";

export function LessonFields({
  lessonId,
  onAfterDelete,
  onAfterDuplicate,
}: {
  lessonId: Id<"lessons">;
  onAfterDelete?: () => void;
  onAfterDuplicate?: (lessonId: Id<"lessons">) => void;
}) {
  const lesson = useQuery(api.lessons.get, { id: lessonId }) as
    | (Doc<"lessons"> | null)
    | undefined;
  const updateLesson = useMutation(api.lessons.update);
  const removeLesson = useMutation(api.lessons.remove);
  const duplicateLesson = useMutation(api.lessons.duplicate);

  const [confirmOpen, setConfirmOpen] = useState(false);

  if (lesson === null)
    return (
      <Flex h="full" align="center" justify="center" color="charcoal.400">
        <Text fontSize="sm">Lesson not found.</Text>
      </Flex>
    );
  // Loading: render the layout-matching skeleton instead of null so
  // we don't flash an empty panel between selections.
  if (lesson === undefined) return <NodeEditorSkeleton kind="lesson" />;

  const handleConfirmDelete = async () => {
    await removeLesson({ id: lessonId });
    onAfterDelete?.();
  };

  const handleDuplicate = async () => {
    const copyId = await duplicateLesson({ lessonId });
    onAfterDuplicate?.(copyId);
  };

  const currentStrand: Strand | null = (
    STRAND_ORDER as readonly string[]
  ).includes(lesson.strand ?? "")
    ? (lesson.strand as Strand)
    : null;
  const currentCfg = currentStrand ? STRAND_CONFIG[currentStrand] : null;
  const setStrand = (next: Strand | null) =>
    updateLesson({ id: lessonId, strand: next });
  const selectionMode: "sequence" | "choice" =
    lesson.selectionMode === "choice" ? "choice" : "sequence";

  return (
    <Scroll>
      <SectionHeader
        title={lesson.title}
        subtitle="Lesson"
        placeholder="Untitled lesson"
        onTitleChange={(next) => updateLesson({ id: lessonId, title: next })}
        rightSlot={
          <NodeActionsMenu
            kind="lesson"
            onDuplicate={handleDuplicate}
            onDelete={() => setConfirmOpen(true)}
          />
        }
      />
      <Flex gap={3}>
        <Field label="Strand" flex={1}>
          <Menu.Root positioning={{ placement: "bottom-start" }}>
            <Menu.Trigger asChild>
              <Button
                size="sm"
                variant="outline"
                w="full"
                justifyContent="space-between"
                fontFamily="heading"
                fontWeight="500"
                fontSize="sm"
                color={currentCfg ? "charcoal.600" : "charcoal.400"}
                borderColor="gray.200"
                _hover={{ borderColor: "gray.300", bg: "gray.50" }}
              >
                {currentCfg ? (
                  <HStack gap={2}>
                    <currentCfg.icon size={14} weight="bold" />
                    {currentCfg.label}
                  </HStack>
                ) : (
                  "— Untagged —"
                )}
                <CaretDown size={12} />
              </Button>
            </Menu.Trigger>
            <Portal>
              <Menu.Positioner>
                <Menu.Content
                  minW="200px"
                  shadow="md"
                  borderRadius="lg"
                  border="1px solid"
                  borderColor="gray.200"
                >
                  <Menu.Item value="" onClick={() => setStrand(null)} py={2}>
                    <Box flex={1} color="charcoal.400" fontFamily="heading" fontSize="sm">
                      — Untagged —
                    </Box>
                    {!currentStrand && <Check size={12} weight="bold" />}
                  </Menu.Item>
                  {STRAND_ORDER.map((s) => {
                    const cfg = STRAND_CONFIG[s];
                    const Icon = cfg.icon;
                    return (
                      <Menu.Item
                        key={s}
                        value={s}
                        onClick={() => setStrand(s)}
                        py={2}
                      >
                        <HStack gap={2} flex={1}>
                          <Icon size={14} weight="bold" color="var(--chakra-colors-charcoal-400)" />
                          <Text fontFamily="heading" fontSize="sm" color="charcoal.600">
                            {cfg.label}
                          </Text>
                        </HStack>
                        {currentStrand === s && <Check size={12} weight="bold" />}
                      </Menu.Item>
                    );
                  })}
                </Menu.Content>
              </Menu.Positioner>
            </Portal>
          </Menu.Root>
        </Field>
        <Field label="Duration (min)" flex={1}>
          <Input
            size="sm"
            type="number"
            value={lesson.durationMinutes ?? ""}
            onChange={(e) => {
              const v = e.target.value ? parseInt(e.target.value) : null;
              updateLesson({ id: lessonId, durationMinutes: v });
            }}
            placeholder="e.g., 60"
            fontFamily="heading"
            fontSize="sm"
            borderColor="gray.200"
            _focus={{ borderColor: "violet.400", boxShadow: "none" }}
          />
        </Field>
      </Flex>
      <Flex gap={3} align="flex-start">
        <Field
          label="Selection"
          hint="Sequence = scholars do the activities in order; Choice = scholars pick from these activities (a menu)."
          flex={1}
        >
          <SegmentedButtonGroup
            value={selectionMode}
            options={[
              { value: "sequence", label: "Sequence" },
              { value: "choice", label: "Choice" },
            ]}
            onChange={(next) =>
              updateLesson({ id: lessonId, selectionMode: next })
            }
          />
        </Field>
        {selectionMode === "choice" && (
          <Box w="140px">
            <Field label="Pick count">
              <Input
                size="sm"
                type="number"
                min={1}
                value={lesson.choicePickCount ?? 1}
                onChange={(e) => {
                  const next = Math.max(1, parseInt(e.target.value, 10) || 1);
                  updateLesson({ id: lessonId, choicePickCount: next });
                }}
                fontFamily="heading"
                fontSize="sm"
                borderColor="gray.200"
                _focus={{ borderColor: "violet.400", boxShadow: "none" }}
              />
            </Field>
          </Box>
        )}
      </Flex>
      <ConfirmDeleteDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete lesson?"
        message={`Delete lesson "${lesson.title}" and all its activities? This cannot be undone.`}
        confirmLabel="Delete lesson"
        onConfirm={handleConfirmDelete}
      />
    </Scroll>
  );
}
