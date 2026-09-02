"use client";

import { useRef, useState } from "react";
import { Box, Input } from "@chakra-ui/react";

/**
 * Free-text Subject input with autocomplete. Stays a plain text field
 * — you can type a brand-new subject — but actively suggests subjects
 * that already exist across the teacher's units so "ELA" and "English
 * Language Arts" don't both get created by accident.
 *
 * Commit semantics match the rest of the unit editor: the parent
 * commits on blur (via onCommit). Picking a suggestion commits that
 * exact value immediately.
 */
export function SubjectInput({
  value,
  onChange,
  onCommit,
  suggestions,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Commit the current (or an explicitly-passed) value to the unit. */
  onCommit: (value?: string) => void;
  suggestions: string[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const folded = value.trim().toLowerCase();
  const matches = suggestions
    .filter((s) => {
      const sf = s.toLowerCase();
      // Hide an exact match (nothing to suggest) but show prefix /
      // substring matches and — when the field is empty — everything.
      if (sf === folded) return false;
      if (folded === "") return true;
      return sf.includes(folded);
    })
    .slice(0, 8);

  const pick = (s: string) => {
    if (blurTimer.current) clearTimeout(blurTimer.current);
    onChange(s);
    onCommit(s);
    setOpen(false);
  };

  return (
    <Box position="relative">
      <Input
        size="sm"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Defer so an onMouseDown pick can fire first.
          blurTimer.current = setTimeout(() => setOpen(false), 120);
          onCommit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Escape") {
            setOpen(false);
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder={placeholder}
        fontFamily="heading"
        fontSize="sm"
        borderColor="gray.200"
        _focus={{ borderColor: "violet.400", boxShadow: "none" }}
        autoComplete="off"
      />
      {open && matches.length > 0 && (
        <Box
          position="absolute"
          top="calc(100% + 4px)"
          left={0}
          right={0}
          zIndex={20}
          bg="white"
          borderWidth="1px"
          borderColor="gray.200"
          borderRadius="md"
          shadow="md"
          maxH="200px"
          overflowY="auto"
          py={1}
        >
          {matches.map((s) => (
            <Box
              key={s}
              as="button"
              w="full"
              textAlign="left"
              px={3}
              py={1.5}
              fontSize="sm"
              fontFamily="body"
              color="charcoal.600"
              cursor="pointer"
              _hover={{ bg: "violet.50", color: "violet.700" }}
              // onMouseDown (not onClick) so the pick fires before the
              // input's onBlur tears down the dropdown.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
            >
              {s}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
