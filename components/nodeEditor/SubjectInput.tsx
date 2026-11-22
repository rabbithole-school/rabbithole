"use client";

import { useRef, useState } from "react";
import { Box, Input, Text } from "@chakra-ui/react";
import { FieldSelect } from "@/components/ui/FieldSelect";
import { subjectPickerState } from "@/lib/subjects";

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

/** The quiet line under a subject that is not one of the school's classes. */
export const OFF_LIST_SUBJECT_HINT =
  "Not one of the school's classes. Pick the class this unit belongs to.";

/**
 * The Subject picker (TRA-723): a unit's subject is one of the school's
 * classes, chosen here, never typed. A unit already filed under something
 * else keeps showing it, as-is, with a quiet prompt; nothing changes until a
 * teacher picks. "No subject" stays a choice.
 */
export function SubjectPicker({
  subject,
  options,
  onPick,
}: {
  /** The unit's saved subject. */
  subject: string | null | undefined;
  /** The unit's school's class names (`useSchoolSubjectOptions`): non-empty,
   *  or `undefined` while they load (disabled, current value shown). */
  options: readonly string[] | undefined;
  onPick: (next: string | null) => void;
}) {
  const loading = options === undefined;
  const state = subjectPickerState(options ?? [], subject);
  const selected = state.selected;
  // While loading, the current value is shown without the off-list prompt.
  const offList = loading ? null : state.offList;
  return (
    <Box>
      <FieldSelect
        value={selected}
        disabled={loading}
        onChange={(next) => {
          if (next !== selected) onPick(next || null);
        }}
        fieldProps={{ "aria-label": "Subject" }}
      >
        {loading && selected && <option value={selected}>{selected}</option>}
        <option value="">No subject</option>
        {offList && <option value={offList}>{offList}</option>}
        {(options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </FieldSelect>
      {offList && (
        <Text mt={1} fontSize="xs" color="charcoal.400" fontFamily="body">
          {OFF_LIST_SUBJECT_HINT}
        </Text>
      )}
    </Box>
  );
}
