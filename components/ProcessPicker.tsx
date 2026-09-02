"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Box,
  Flex,
  HStack,
  VStack,
  Text,
  Button,
  Dialog,
  IconButton,
  Portal,
  Spinner,
  Badge,
} from "@chakra-ui/react";
import { CaretDown, Plus, X } from "@phosphor-icons/react";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { DimensionEditModal } from "./DimensionEditModal";

interface ProcessPickerProps {
  value: Id<"processes"> | null;
  onChange: (next: Id<"processes"> | null) => void;
  /** Defaults to true. When false, the "None" / clear option is hidden. */
  allowNone?: boolean;
  /** Disable picker (read-only display). */
  disabled?: boolean;
  placeholder?: string;
}

/**
 * Reusable process picker. Click opens a modal showing every available
 * process with its full step preview. Pick one, clear, or create a new
 * process via the embedded DimensionEditModal.
 */
export function ProcessPicker({
  value,
  onChange,
  allowNone = true,
  disabled,
  placeholder = "Choose a process",
}: ProcessPickerProps) {
  const processes = useQuery(api.processes.list, {});
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const current = useMemo(
    () => processes?.find((p) => String(p._id) === String(value)) ?? null,
    [processes, value],
  );

  return (
    <>
      <Flex
        as="button"
        align="center"
        gap={2}
        w="full"
        px={3}
        py={2}
        bg="white"
        borderWidth="1px"
        borderColor="gray.300"
        borderRadius="md"
        cursor={disabled ? "not-allowed" : "pointer"}
        opacity={disabled ? 0.6 : 1}
        _hover={disabled ? undefined : { borderColor: "violet.400" }}
        transition="border-color 0.12s"
        onClick={disabled ? undefined : () => setOpen(true)}
        textAlign="left"
      >
        {current ? (
          <>
            {current.emoji && <Text fontSize="md">{current.emoji}</Text>}
            <Text fontFamily="heading" fontSize="sm" color="navy.500" flex={1}>
              {current.title}
            </Text>
          </>
        ) : (
          <Text fontFamily="heading" fontSize="sm" color="charcoal.300" flex={1}>
            {placeholder}
          </Text>
        )}
        <CaretDown size={14} color="var(--chakra-colors-charcoal-400)" />
      </Flex>

      <Dialog.Root
        open={open}
        onOpenChange={(d) => {
          if (!d.open) setOpen(false);
        }}
        placement="center"
        motionPreset="slide-in-bottom"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <StyledDialogContent maxW="2xl">
              <Dialog.Header px={6} pt={5} pb={2}>
                <Dialog.Title
                  fontFamily="heading"
                  fontWeight="700"
                  color="navy.500"
                  fontSize="lg"
                  flex={1}
                >
                  Choose a process
                </Dialog.Title>
                <Dialog.CloseTrigger asChild>
                  <IconButton
                    aria-label="Close"
                    size="sm"
                    variant="ghost"
                    color="charcoal.400"
                    _hover={{ bg: "gray.100" }}
                  >
                    <X />
                  </IconButton>
                </Dialog.CloseTrigger>
              </Dialog.Header>
              <Dialog.Body px={6} py={3}>
                {processes === undefined ? (
                  <Flex py={8} justify="center">
                    <Spinner color="violet.500" />
                  </Flex>
                ) : processes.length === 0 ? (
                  <Text fontSize="sm" color="charcoal.400" textAlign="center" py={6}>
                    No processes yet. Create one below.
                  </Text>
                ) : (
                  <VStack
                    gap={2}
                    align="stretch"
                    maxH="55vh"
                    overflowY="auto"
                    pr={1}
                  >
                    {allowNone && (
                      <ProcessCard
                        emoji="∅"
                        title="None"
                        description="No process — the AI runs the activity freeform."
                        steps={[]}
                        selected={value === null}
                        onClick={() => {
                          onChange(null);
                          setOpen(false);
                        }}
                      />
                    )}
                    {processes.map((p) => (
                      <ProcessCard
                        key={String(p._id)}
                        emoji={p.emoji ?? "📋"}
                        title={p.title}
                        description={p.description ?? null}
                        steps={p.steps.map((s) => s.title)}
                        selected={String(p._id) === String(value)}
                        onClick={() => {
                          onChange(p._id as Id<"processes">);
                          setOpen(false);
                        }}
                      />
                    ))}
                  </VStack>
                )}
              </Dialog.Body>
              <Dialog.Footer px={6} pb={5} pt={3} borderTop="1px solid" borderColor="gray.100">
                <Button
                  variant="outline"
                  fontFamily="heading"
                  size="sm"
                  w="full"
                  onClick={() => {
                    setOpen(false);
                    setCreateOpen(true);
                  }}
                >
                  <Plus style={{ marginRight: 6 }} /> Create new process
                </Button>
              </Dialog.Footer>
            </StyledDialogContent>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      <DimensionEditModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        dimensionType="process"
        data={null}
      />
    </>
  );
}

function ProcessCard({
  emoji,
  title,
  description,
  steps,
  selected,
  onClick,
}: {
  emoji: string;
  title: string;
  description: string | null;
  steps: string[];
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <Flex
      as="button"
      direction="column"
      align="stretch"
      gap={2}
      p={3}
      borderRadius="lg"
      borderWidth="1px"
      borderColor={selected ? "violet.400" : "gray.200"}
      bg={selected ? "violet.50" : "white"}
      cursor="pointer"
      _hover={{ borderColor: "violet.300", bg: selected ? "violet.50" : "gray.50" }}
      transition="all 0.12s"
      onClick={onClick}
      textAlign="left"
    >
      <HStack gap={3} align="start">
        <Text fontSize="xl" flexShrink={0} lineHeight="1">
          {emoji}
        </Text>
        <Box flex={1} minW={0}>
          <Text
            fontFamily="heading"
            fontWeight="600"
            color="navy.500"
            fontSize="sm"
          >
            {title}
          </Text>
          {description && (
            <Text fontSize="xs" color="charcoal.500" mt={0.5} lineHeight="1.4">
              {description}
            </Text>
          )}
        </Box>
        {selected && (
          <Badge bg="violet.100" color="violet.700" fontSize="2xs" flexShrink={0}>
            Selected
          </Badge>
        )}
      </HStack>
      {steps.length > 0 && (
        <Flex gap={1} wrap="wrap" pl={9}>
          {steps.map((s, i) => (
            <HStack key={`${s}-${i}`} gap={1}>
              <Box
                px={2}
                py={0.5}
                bg="gray.100"
                borderRadius="md"
                fontFamily="heading"
                fontSize="2xs"
                color="charcoal.600"
                fontWeight="500"
              >
                {s}
              </Box>
              {i < steps.length - 1 && (
                <Text fontSize="2xs" color="charcoal.300">
                  →
                </Text>
              )}
            </HStack>
          ))}
        </Flex>
      )}
    </Flex>
  );
}
