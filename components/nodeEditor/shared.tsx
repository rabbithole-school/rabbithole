"use client";

import { useEffect, useState } from "react";
import {
  Box,
  Button,
  ButtonGroup,
  Dialog,
  Flex,
  HStack,
  IconButton,
  Input,
  Menu,
  Portal,
  Stack,
  Text,
  VStack,
} from "@chakra-ui/react";
import { CaretDown, Plus, X } from "@phosphor-icons/react";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { ACTIVITY_KIND, type ActivityKind } from "@/lib/activityKinds";
import { ActivityKindIcon } from "../ActivityKindIcon";
import { toaster } from "@/lib/toaster";

export function Scroll({ children }: { children: React.ReactNode }) {
  return (
    <Box
      position="relative"
      h="full"
      overflowY="auto"
      px={8}
      pt={2}
      pb={8}
    >
      <Box
        position="relative"
        maxW="900px"
        bg="white"
        borderWidth="1px"
        borderColor="gray.200"
        borderRadius="lg"
        p={6}
      >
        <VStack align="stretch" gap={4}>
          {children}
        </VStack>
      </Box>
    </Box>
  );
}

export function SectionHeader({
  emoji,
  title,
  subtitle,
  rightSlot,
  onTitleChange,
  placeholder,
}: {
  emoji?: string;
  title: string;
  subtitle?: string;
  rightSlot?: React.ReactNode;
  onTitleChange?: (next: string) => void | Promise<unknown>;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  useEffect(() => {
    // Reset draft to remote title when not actively editing.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!editing) setDraft(title);
  }, [title, editing]);

  const commit = async () => {
    setEditing(false);
    const next = draft.trim();
    if (!onTitleChange) return;
    if (!next || next === title) {
      setDraft(title);
      return;
    }
    await onTitleChange(next);
  };

  return (
    <Flex align="center" gap={3} pb={3} borderBottom="1px solid" borderColor="gray.100">
      {emoji && <Text fontSize="xl">{emoji}</Text>}
      <VStack align="start" gap={0} flex={1} minW={0}>
        {editing && onTitleChange ? (
          <Input
            size="sm"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setDraft(title);
                setEditing(false);
              }
            }}
            autoFocus
            placeholder={placeholder}
            fontFamily="heading"
            fontWeight="600"
            fontSize="md"
            color="navy.500"
          />
        ) : (
          <Text
            fontFamily="heading"
            fontWeight="600"
            fontSize="md"
            color={title ? "navy.500" : "charcoal.300"}
            truncate
            w="full"
            cursor={onTitleChange ? "pointer" : "default"}
            _hover={onTitleChange ? { color: "violet.500" } : undefined}
            onClick={onTitleChange ? () => setEditing(true) : undefined}
          >
            {title || placeholder || "Untitled"}
          </Text>
        )}
        {subtitle && (
          <Text fontSize="2xs" color="charcoal.400" textTransform="uppercase" letterSpacing="wider">
            {subtitle}
          </Text>
        )}
      </VStack>
      {rightSlot}
    </Flex>
  );
}

export function Field({
  label,
  hint,
  children,
  flex,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  flex?: number;
}) {
  return (
    <Box flex={flex}>
      <Text fontSize="2xs" color="charcoal.400" fontFamily="heading" letterSpacing="wider" textTransform="uppercase" mb={1}>
        {label}
      </Text>
      {children}
      {hint && (
        <Text fontSize="2xs" color="charcoal.400" mt={1}>
          {hint}
        </Text>
      )}
    </Box>
  );
}

export function SegmentedButtonGroup<T extends string | null>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: ReadonlyArray<{
    value: T;
    label: string;
    icon?: React.ReactNode;
  }>;
  onChange: (value: T) => void | Promise<unknown>;
}) {
  return (
    <ButtonGroup attached>
      {options.map((opt) => {
        const selected = value === opt.value;
        return (
          <Button
            key={String(opt.value)}
            size="xs"
            variant="outline"
            bg={selected ? "violet.500" : "white"}
            color={selected ? "white" : "charcoal.500"}
            borderColor={selected ? "violet.500" : "gray.300"}
            _hover={
              selected
                ? { bg: "violet.600" }
                : { borderColor: "violet.400", color: "violet.500" }
            }
            fontFamily="heading"
            onClick={() => onChange(opt.value)}
          >
            {opt.icon}
            {opt.label}
          </Button>
        );
      })}
    </ButtonGroup>
  );
}

export function PillRow({ text, onRemove }: { text: string; onRemove: () => void }) {
  return (
    <Flex
      align="center"
      gap={2}
      px={1}
      py={1.5}
      borderBottom="1px solid"
      borderColor="gray.100"
    >
      <Text fontSize="sm" fontFamily="body" color="charcoal.500" flex={1}>
        {text}
      </Text>
      <IconButton
        aria-label="Remove"
        size="xs"
        variant="ghost"
        color="charcoal.300"
        _hover={{ color: "red.500" }}
        onClick={onRemove}
      >
        <X size={12} />
      </IconButton>
    </Flex>
  );
}

export function AddRow({
  value,
  onChange,
  onAdd,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onAdd: () => void;
  placeholder: string;
}) {
  return (
    <Flex gap={1}>
      <Input
        size="sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onAdd();
        }}
        placeholder={placeholder}
        fontSize="sm"
        fontFamily="body"
        borderColor="gray.200"
        _focus={{ borderColor: "violet.400", boxShadow: "none" }}
      />
      <IconButton
        aria-label="Add"
        size="sm"
        variant="ghost"
        color="violet.500"
        onClick={onAdd}
        disabled={!value.trim()}
      >
        <Plus size={14} />
      </IconButton>
    </Flex>
  );
}

/**
 * Activity kind picker. A compact Chakra Menu (same pattern as the
 * deliverable kind picker) — the trigger collapses to a single row
 * showing the current kind, and each kind teaches itself in the menu
 * via its description.
 */
const KIND_ORDER = ["online", "offline", "shareBack", "web", "game", "simulator", "vibecode"] as const;

export function KindToggle({
  value,
  onChange,
}: {
  value: ActivityKind;
  onChange: (k: ActivityKind) => void;
}) {
  return (
    <Menu.Root
      positioning={{ placement: "bottom-start" }}
      onSelect={(d) => onChange(d.value as ActivityKind)}
    >
      <Menu.Trigger asChild>
        <Button
          variant="outline"
          size="sm"
          h="auto"
          px={3}
          py={2}
          bg="white"
          borderColor="gray.300"
          borderRadius="md"
          minW="200px"
          _hover={{ borderColor: "violet.400", bg: "white" }}
        >
          <HStack gap={2} w="full">
            <ActivityKindIcon kind={value} size={14} />
            <Text
              fontFamily="heading"
              fontWeight="600"
              fontSize="sm"
              color="navy.500"
              flex={1}
              textAlign="left"
            >
              {ACTIVITY_KIND[value].label}
            </Text>
            <CaretDown
              size={14}
              color="var(--chakra-colors-charcoal-400)"
            />
          </HStack>
        </Button>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          {/* Fixed width so the long per-kind descriptions wrap instead of
              forcing a wide max-content menu. */}
          <Menu.Content w="300px" maxW="90vw">
            {KIND_ORDER.map((k) => {
              const selected = value === k;
              return (
                <Menu.Item key={k} value={k} cursor="pointer">
                  <Box mt="2px">
                    <ActivityKindIcon kind={k} size={14} />
                  </Box>
                  <Stack gap={0.5} flex={1} minW={0} ml={2}>
                    <HStack gap={1.5}>
                      <Text
                        fontFamily="heading"
                        fontWeight={selected ? "700" : "500"}
                        fontSize="sm"
                        color={selected ? "violet.600" : "navy.500"}
                      >
                        {ACTIVITY_KIND[k].label}
                      </Text>
                      {selected && (
                        <Text fontSize="sm" color="violet.500">
                          ✓
                        </Text>
                      )}
                    </HStack>
                    <Box
                      fontSize="2xs"
                      color="charcoal.400"
                      lineHeight="1.4"
                      whiteSpace="normal"
                    >
                      {ACTIVITY_KIND[k].description}
                    </Box>
                  </Stack>
                </Menu.Item>
              );
            })}
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  title,
  message,
  confirmLabel = "Delete",
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleConfirm = async () => {
    setIsSubmitting(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      toaster.error({
        title: "Delete failed",
        description: err instanceof Error ? err.message : "Something went wrong. Please try again.",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => onOpenChange(e.open)}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent>
            <Dialog.Header px={6} pt={5} pb={2}>
              <Dialog.Title fontFamily="heading" fontSize="lg" color="navy.500">
                {title}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body px={6} py={3}>
              <Text fontSize="sm" fontFamily="body" color="charcoal.500">
                {message}
              </Text>
            </Dialog.Body>
            <Dialog.Footer px={6} pb={5} pt={2} gap={2}>
              <Button
                size="sm"
                variant="ghost"
                fontFamily="heading"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
                autoFocus
              >
                Cancel
              </Button>
              <Button
                size="sm"
                bg="red.500"
                color="white"
                _hover={{ bg: "red.600" }}
                fontFamily="heading"
                onClick={handleConfirm}
                disabled={isSubmitting}
              >
                {isSubmitting ? "Deleting..." : confirmLabel}
              </Button>
            </Dialog.Footer>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
