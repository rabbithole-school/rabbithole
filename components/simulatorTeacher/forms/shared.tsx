"use client";

/**
 * UI primitives shared by every World template Form (see registry.ts). Kept
 * template-agnostic so a new template's Form only has to import from here,
 * never duplicate them.
 */

import { Box, Input, Switch, Text } from "@chakra-ui/react";
import { COMPILED_POLICY_INTERPRETER_ID, type SimulatorSpec } from "@/lib/simulator/contract";

export const selectStyle: React.CSSProperties = {
  fontSize: "13px",
  padding: "6px 8px",
  borderRadius: "6px",
  border: "1px solid #e2e8f0",
  fontFamily: "var(--chakra-fonts-heading)",
  background: "white",
};

export function Label({ children }: { children: React.ReactNode }) {
  return (
    <Text
      fontSize="2xs"
      fontWeight="700"
      letterSpacing="0.05em"
      textTransform="uppercase"
      color="charcoal.400"
      fontFamily="heading"
      mb={1}
    >
      {children}
    </Text>
  );
}

export function InterpreterField({
  interpreter,
  onChange,
}: {
  interpreter: SimulatorSpec["interpreter"];
  onChange: (interpreter: SimulatorSpec["interpreter"]) => void;
}) {
  return (
    <Box>
      <Label>Interpreter</Label>
      <select
        aria-label="Automaton interpreter"
        style={selectStyle}
        value={interpreter.kind}
        onChange={(event) =>
          onChange(
            event.target.value === "scripted"
              ? {
                  kind: "scripted",
                  interpreterId: COMPILED_POLICY_INTERPRETER_ID,
                }
              : { kind: "llm", role: "AUTOMATON" },
          )
        }
      >
        <option value="scripted">Compiled policy (fast)</option>
        <option value="llm">Live Haiku each tick</option>
      </select>
      <Text fontSize="2xs" color="charcoal.400" mt={1} maxW="360px">
        Compiled turns the saved Species prompts into inspectable rules. Live
        Haiku keeps model interpretation variable from tick to tick.
      </Text>
    </Box>
  );
}

export function NumField({
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  w = "110px",
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  step?: number;
  min?: number;
  max?: number;
  w?: string;
}) {
  return (
    <Box w={w}>
      <Label>{label}</Label>
      <Input
        aria-label={label}
        size="sm"
        type="number"
        step={step}
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
        fontFamily="heading"
        fontSize="sm"
        borderColor="gray.200"
        _focus={{ borderColor: "violet.400", boxShadow: "none" }}
      />
    </Box>
  );
}

export function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box borderWidth="1px" borderColor="gray.200" borderRadius="lg" bg="white" p={4}>
      <Text fontFamily="heading" fontWeight="800" fontSize="sm" color="navy.500" mb={3}>
        {title}
      </Text>
      {children}
    </Box>
  );
}

export function MicroWorldSwitch({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Box>
      <Label>Micro-world</Label>
      <Switch.Root
        checked={checked}
        onCheckedChange={(d) => onCheckedChange(!!d.checked)}
        colorPalette="violet"
        size="sm"
      >
        <Switch.HiddenInput />
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
        <Switch.Label fontSize="xs" color="charcoal.500">
          {checked ? "On — hypothesis optional" : "Off"}
        </Switch.Label>
      </Switch.Root>
    </Box>
  );
}
