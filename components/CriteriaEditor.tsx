"use client";

import { Box, Button, HStack, IconButton, Input, Stack, Text, Textarea } from "@chakra-ui/react";
import { Plus, Trash, Star } from "@phosphor-icons/react";

export interface CriterionDraft {
  id: string; // empty string for new criteria — server slugifies from label
  label: string;
  description?: string;
}

interface CriteriaEditorProps {
  value: CriterionDraft[];
  onChange: (next: CriterionDraft[]) => void;
  /** Commit hook — called on blur. Convenient single-place persistence point. */
  onBlur?: () => void;
}

/**
 * Compact editor for a deliverable's rubric criteria. Each criterion is
 * a small block with a short label + a longer description. The teacher
 * can add, remove, and re-order (currently no DnD; keyboard-friendly).
 *
 * Same private shape the AI rubric check sees. After a scholar earns a
 * criterion as flair, its label and description appear in the flair popover.
 */
export function CriteriaEditor({ value, onChange, onBlur }: CriteriaEditorProps) {
  const update = (i: number, patch: Partial<CriterionDraft>) => {
    const next = value.slice();
    next[i] = { ...next[i], ...patch };
    onChange(next);
  };
  const add = () => {
    onChange([...value, { id: "", label: "", description: "" }]);
  };
  const remove = (i: number) => {
    const next = value.slice();
    next.splice(i, 1);
    onChange(next);
    onBlur?.();
  };

  return (
    <Stack gap={2}>
      {value.length === 0 && (
        <Text fontSize="xs" color="charcoal.300" fontStyle="italic">
          No criteria yet. Add at least one (e.g. &ldquo;Specificity: names a specific person or event&rdquo;).
        </Text>
      )}
      {value.map((c, i) => (
        <Box
          key={i}
          borderWidth="1px"
          borderColor="gray.200"
          borderRadius="md"
          p={2.5}
          bg="white"
        >
          <HStack gap={2} mb={1.5} align="center">
            {/* Outline mark mirrors the criteria authoring view — each
                criterion is one piece of flair a scholar can earn. */}
            <Box
              color="charcoal.400"
              minW="16px"
              display="flex"
              alignItems="center"
              justifyContent="center"
              aria-hidden
            >
              <Star size={16} weight="regular" />
            </Box>
            <Input
              value={c.label}
              onChange={(e) => update(i, { label: e.target.value })}
              onBlur={onBlur}
              placeholder="Label (e.g. Specificity)"
              fontSize="xs"
              fontFamily="heading"
              fontWeight="600"
              size="sm"
              borderColor="gray.200"
              _focus={{ borderColor: "violet.400", boxShadow: "none" }}
            />
            <IconButton
              aria-label="Remove criterion"
              size="xs"
              variant="ghost"
              color="charcoal.300"
              _hover={{ color: "red.500", bg: "red.50" }}
              onClick={() => remove(i)}
            >
              <Trash />
            </IconButton>
          </HStack>
          <Textarea
            value={c.description ?? ""}
            onChange={(e) => update(i, { description: e.target.value })}
            onBlur={onBlur}
            placeholder="Concrete standard. State what counts as 'full' and what triggers 'half' or 'not'."
            rows={2}
            fontSize="xs"
            fontFamily="body"
            borderColor="gray.200"
            _focus={{ borderColor: "violet.400", boxShadow: "none" }}
          />
        </Box>
      ))}
      <Button
        size="xs"
        variant="ghost"
        alignSelf="flex-start"
        color="violet.600"
        onClick={() => {
          add();
          onBlur?.();
        }}
      >
        <Plus style={{ marginRight: 4 }} />
        Add criterion
      </Button>
    </Stack>
  );
}
