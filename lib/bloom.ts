// Bloom's-taxonomy depth helpers — the single mapping from a 0–5 mastery level
// (the observer's Bloom float) to a named level + a Chakra colour palette.
// Shared by every surface that surfaces depth (the Mastery tab and the
// Knowledge Tree drill-down), so "Analyze" reads the same colour everywhere.
//
// Bloom's ladder: Remember → Understand → Apply → Analyze → Evaluate → Create.

export const MASTERY_MAX = 5;

export const BLOOM_LEVELS = [
  "Remember",
  "Understand",
  "Apply",
  "Analyze",
  "Evaluate",
  "Create",
] as const;

export function bloomLabel(level: number): string {
  if (level >= 4.5) return "Create";
  if (level >= 3.5) return "Evaluate";
  if (level >= 2.5) return "Analyze";
  if (level >= 1.5) return "Apply";
  if (level >= 0.5) return "Understand";
  return "Remember";
}

export function bloomColor(level: number): string {
  if (level >= 4.5) return "purple";
  if (level >= 3.5) return "violet";
  if (level >= 2.5) return "teal";
  if (level >= 1.5) return "cyan";
  if (level >= 0.5) return "blue";
  return "gray";
}

// The Knowledge Tree carries a cell/node's depth as a mastery PERCENT
// (avg masteryLevel / MASTERY_MAX × 100). Recover the 0–5 Bloom level from it
// so the drill-down can show the named depth the coarse cell colour can't.
export function bloomLevelFromPct(pct: number): number {
  return (pct / 100) * MASTERY_MAX;
}
