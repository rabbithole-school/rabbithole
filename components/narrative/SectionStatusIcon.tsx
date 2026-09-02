"use client";

/**
 * The per-subtab status glyph for a report section, borrowing the curriculum
 * builder's dot iconography (MaturityStatusDot / DashedStatusCircle) so the two
 * surfaces read the same. Three states:
 *   • empty   — nothing written → hollow dotted circle
 *   • content — something written, not yet signed off → filled gray circle
 *   • done    — the author marked it done → green check-circle
 *
 * "content" deliberately does NOT read as complete — writing a sentence isn't
 * the same as being finished, which the old bare checkmark conflated.
 */
import { Box } from "@chakra-ui/react";
import { CheckCircle } from "@phosphor-icons/react";
import { DashedStatusCircle } from "@/components/MaturityStatusDot";

export type SectionState = "empty" | "content" | "done";

export function sectionState(hasContent: boolean, done: boolean): SectionState {
  return done ? "done" : hasContent ? "content" : "empty";
}

export function SectionStatusIcon({ state, size = 14 }: { state: SectionState; size?: number }) {
  if (state === "done") {
    return <CheckCircle size={size + 2} weight="fill" color="var(--chakra-colors-green-500)" />;
  }
  if (state === "content") {
    return (
      <Box
        w={`${size}px`}
        h={`${size}px`}
        borderRadius="full"
        bg="gray.300"
        borderWidth="1px"
        borderColor="gray.300"
        flexShrink={0}
      />
    );
  }
  return <DashedStatusCircle size={size} color="var(--chakra-colors-gray-400)" />;
}
