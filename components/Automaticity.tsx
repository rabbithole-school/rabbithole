"use client";

/**
 * Automaticity — the "how effortless / how fast" axis the Bloom depth can't
 * carry, drawn as LIGHTNING bolts (1 = effortful, 2 = fluent, 3 = automatic):
 * lightning reads as speed, which is exactly what automaticity is. Honesty-
 * gated: renders NOTHING when there's no fluency signal (the common case), so
 * most cells/nodes show no bolts and they light up only where a real reading
 * exists. NEUTRAL by design — colour is reserved for the four-stop mastery
 * scale, so automaticity reads in charcoal: source-trust shows as ink weight (a
 * teacher reading is solid dark bolts, an opportunistic one is muted).
 *
 * Lightning is used for automaticity and NOWHERE else in the app (it means
 * "fast" exclusively).
 */

import { Flex } from "@chakra-ui/react";
import { Lightning } from "@phosphor-icons/react";
import { fluencyTitleLabel } from "@/shared/masteryLexicon";

// High-trust (teacher) vs. opportunistic (observer / external practice site / other) —
// distinguished by ink weight, not hue (neutral charcoal either way).
function fillFor(source?: string): string {
  return source === "teacher" ? "#3a4250" : "#9aa3b2";
}

export function Automaticity({
  level,
  source,
  size = 9,
}: {
  level?: number | null;
  source?: string;
  size?: number;
}) {
  if (!level || level < 1) return null; // honesty gate: no signal → no bolts
  const lvl = Math.min(3, Math.max(1, Math.round(level)));
  const fill = fillFor(source);
  const label = `Automaticity: ${fluencyTitleLabel(lvl) ?? lvl}${source ? ` · ${source}` : ""}`;
  return (
    <Flex
      gap="0"
      align="center"
      title={label}
      aria-label={label}
      data-testid="automaticity"
      data-fluency={lvl}
      data-fluency-source={source ?? ""}
    >
      {[1, 2, 3].map((i) => (
        <Lightning
          key={i}
          size={size}
          weight={i <= lvl ? "fill" : "regular"}
          color={i <= lvl ? fill : "#cdd6d6"}
        />
      ))}
    </Flex>
  );
}
