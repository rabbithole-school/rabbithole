"use client";

import {
  Checkbox,
  HStack,
  Menu,
  Stack,
  Text,
} from "@chakra-ui/react";
import { EXTENDED_EDUCATION_LABEL } from "@/shared/scholarGroupRouting";
import type { ScholarParticipationSelection } from "@/shared/scholarParticipation";

export { EXTENDED_EDUCATION_LABEL } from "@/shared/scholarGroupRouting";
export { DEFAULT_SCHOLAR_PARTICIPATION } from "@/shared/scholarParticipation";
export type { ScholarParticipationSelection } from "@/shared/scholarParticipation";

const OPTIONS = [
  { key: "enrolled" as const, label: "Enrolled scholars" },
  { key: "extendedEducation" as const, label: EXTENDED_EDUCATION_LABEL },
];

function optionDisabled(
  selection: ScholarParticipationSelection,
  key: keyof ScholarParticipationSelection,
) {
  const otherKey = key === "enrolled" ? "extendedEducation" : "enrolled";
  return selection[key] && !selection[otherKey];
}

function nextSelection(
  selection: ScholarParticipationSelection,
  key: keyof ScholarParticipationSelection,
) {
  if (optionDisabled(selection, key)) return selection;
  return { ...selection, [key]: !selection[key] };
}

export function ScholarParticipationFilter({
  selection,
  onChange,
  variant = "inline",
}: {
  selection: ScholarParticipationSelection;
  onChange: (selection: ScholarParticipationSelection) => void;
  variant?: "inline" | "menu";
}) {
  if (variant === "menu") {
    return (
      <Menu.ItemGroup>
        <Menu.ItemGroupLabel
          fontSize="2xs"
          textTransform="uppercase"
          letterSpacing="0.04em"
          color="charcoal.300"
          px={2}
          pt={1}
        >
          Participation
        </Menu.ItemGroupLabel>
        {OPTIONS.map(({ key, label }) => (
          <Menu.CheckboxItem
            key={key}
            value={`participation:${key}`}
            checked={selection[key]}
            disabled={optionDisabled(selection, key)}
            closeOnSelect={false}
            cursor="pointer"
            onClick={() => onChange(nextSelection(selection, key))}
          >
            <HStack justify="space-between" w="full">
              <Text>{label}</Text>
              <Menu.ItemIndicator color="violet.600" />
            </HStack>
          </Menu.CheckboxItem>
        ))}
      </Menu.ItemGroup>
    );
  }

  return (
    <Stack gap={1.5}>
      <Text
        fontSize="2xs"
        textTransform="uppercase"
        letterSpacing="0.04em"
        color="charcoal.400"
        fontWeight="700"
      >
        Participation
      </Text>
      <HStack gap={4} flexWrap="wrap">
        {OPTIONS.map(({ key, label }) => (
          <Checkbox.Root
            key={key}
            size="sm"
            checked={selection[key]}
            disabled={optionDisabled(selection, key)}
            onCheckedChange={() => onChange(nextSelection(selection, key))}
          >
            <Checkbox.HiddenInput />
            <Checkbox.Control />
            <Checkbox.Label>{label}</Checkbox.Label>
          </Checkbox.Root>
        ))}
      </HStack>
    </Stack>
  );
}
