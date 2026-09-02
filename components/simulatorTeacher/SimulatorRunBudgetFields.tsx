"use client";

/**
 * The ONE controlled budget-field primitive for a World assignment (review:
 * "unify the duplicated budget fields into one controlled shared component with
 * both consumers actually using it"). Pure and stateless — value in, onChange
 * out; no mutation, no query. Both consumers use it:
 *   - StartAssignmentDialog (set at Assign time), and
 *   - SimulatorAssignControls on the Run page (adjust live).
 * The server (setAssignmentWorldBudget / launchRun) owns the invariants; this
 * only shapes the inputs and shows a validity hint.
 */

import { Box, HStack, Input, Text } from "@chakra-ui/react";

export interface SimulatorRunBudgetValue {
  perBlock: number;
  perWeek: number;
  /** null = use the World spec's own season length. */
  seasonTicks: number | null;
}

export function isSimulatorRunBudgetValid(v: SimulatorRunBudgetValue): boolean {
  return (
    Number.isInteger(v.perBlock) &&
    Number.isInteger(v.perWeek) &&
    v.perBlock >= 1 &&
    v.perWeek >= v.perBlock &&
    (v.seasonTicks === null || (Number.isInteger(v.seasonTicks) && v.seasonTicks >= 1))
  );
}

function num(label: string, value: number | null, placeholder: string, onChange: (n: number | null) => void, w = "90px") {
  return (
    <Box>
      <Text as="label" fontSize="2xs" color="charcoal.400" mb={0.5} display="block">
        {label}
      </Text>
      <Input
        size="sm"
        type="number"
        min={1}
        w={w}
        aria-label={label}
        value={value === null ? "" : value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        fontFamily="heading"
        borderColor="gray.200"
      />
    </Box>
  );
}

export function SimulatorRunBudgetFields({
  value,
  onChange,
  showSeason = true,
}: {
  value: SimulatorRunBudgetValue;
  onChange: (next: SimulatorRunBudgetValue) => void;
  showSeason?: boolean;
}) {
  const valid = isSimulatorRunBudgetValid(value);
  return (
    <Box>
      <HStack gap={3} align="flex-end" wrap="wrap">
        {num("Runs / block", value.perBlock, "3", (n) => onChange({ ...value, perBlock: n ?? 0 }))}
        {num("Runs / week", value.perWeek, "12", (n) => onChange({ ...value, perWeek: n ?? 0 }))}
        {showSeason &&
          num(
            "Season ticks",
            value.seasonTicks,
            "world default",
            (n) => onChange({ ...value, seasonTicks: n }),
            "120px",
          )}
      </HStack>
      {!valid && (
        <Text fontSize="2xs" color="red.500" mt={1}>
          Week must be ≥ block, block ≥ 1, and season a positive whole number (or blank for the
          World default).
        </Text>
      )}
    </Box>
  );
}
