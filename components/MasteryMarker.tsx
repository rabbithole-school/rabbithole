"use client";

/**
 * MasteryMarker — the feed/learning-record marker for a mastery observation.
 *
 * A mastery observation is a learning-record signal with real structure, not a
 * status event — so it wears the Knowledge Tree's language: a rounded SQUARE
 * (the Tree cell/node shape, distinct from every circular status/avatar dot) coloured
 * by the four-stop "Beyond" scale (the ONLY colour scale in this system), with
 * a Phosphor check inside. This ends the green-orb collision in the feed (the
 * old 🟢 emoji read like a live status pip and the 🎯 AI-catch).
 *
 *   notyet      → gray square, dash (Minus)            — no evidence yet
 *   approaching → yellow square, tilde (Tilde)         — demonstrated, below bar
 *   met         → green square, single check (Check)   — met the standard
 *   beyond      → blue square, double-check (Checks)   — past the standard's bar
 *   (unmapped)  → green square, single check           — mastered, no standard bar
 *   misconception → rose square, Warning               — a held wrong idea
 *
 * Stops mirror convex/lib/bloomRigor + the AccelerationView/CellDetailView
 * palette so the feed and the Tree speak one colour language.
 */

import { Flex } from "@chakra-ui/react";
import { Check, Checks, Minus, Tilde, Warning, type Icon } from "@phosphor-icons/react";

export type MasteryStop = "notyet" | "approaching" | "met" | "beyond";
export type MarkerKind = "mastery" | "misconception";

const STOP_STYLE: Record<MasteryStop, { bg: string; border: string; fg: string }> = {
  notyet: { bg: "#f1f3f6", border: "#dfe4ea", fg: "#9aa3af" },
  approaching: { bg: "#fbf4dd", border: "#e3c07a", fg: "#8a6d1c" },
  met: { bg: "#d8efe1", border: "#7cc49b", fg: "#1f7a52" },
  beyond: { bg: "#dff1f0", border: "#5fb6b0", fg: "#16707e" },
};
const MISCONCEPTION = { bg: "#fbe7e7", border: "#e7a9a9", fg: "#b23b3b" };

// Each stop's glyph: not-yet = a dash (no claim yet), approaching = a tilde
// (~ "getting there"), met = a single check, beyond = a double check.
const STOP_GLYPH: Record<MasteryStop, Icon> = {
  notyet: Minus,
  approaching: Tilde,
  met: Check,
  beyond: Checks,
};

export function MasteryMarker({
  kind = "mastery",
  stop = null,
  size = 38,
}: {
  kind?: MarkerKind;
  /**
   * Four-stop position vs the standard's bar. null = a demonstrated mastery
   * with NO standard mapping (e.g. "vampire-bat reciprocity"): no bar to be
   * met/beyond against, but it IS mastered — so it reads as a plain green
   * single-check ("met"), not a separate neutral state.
   */
  stop?: MasteryStop | null;
  size?: number;
}) {
  const isMis = kind === "misconception";
  // Unmapped mastery (stop null) borrows the "met" look: green, single check.
  const effectiveStop: MasteryStop = stop ?? "met";
  const style = isMis ? MISCONCEPTION : STOP_STYLE[effectiveStop];
  const icon = size * 0.5;
  const Glyph = isMis ? Warning : STOP_GLYPH[effectiveStop];
  const label = isMis
    ? "Misconception"
    : stop
      ? `Mastery · ${stop}`
      : "Mastery";
  return (
    <Flex
      align="center"
      justify="center"
      flexShrink={0}
      w={`${size}px`}
      h={`${size}px`}
      borderRadius="11px"
      borderWidth="1.5px"
      borderStyle="solid"
      bg={style.bg}
      borderColor={style.border}
      title={label}
      aria-label={label}
      data-testid="mastery-marker"
      data-kind={kind}
      data-stop={stop ?? ""}
    >
      <Glyph size={icon} weight="bold" color={style.fg} />
    </Flex>
  );
}
