// Shared geometry and timing for the one-shot recovery closure charm. Web and
// native render with their own graphics stacks, but the visible arc is identical.

export const RECOVERY_ARC_VIEWBOX = {
  width: 420,
  height: 140,
} as const;

export const RECOVERY_ARC_PATH = "M22 120 Q 210 6 398 74";
export const RECOVERY_ARC_LENGTH = 430;
export const RECOVERY_ARC_DRAW_MS = 760;
export const RECOVERY_ARC_MOTE_MS = 200;

export const RECOVERY_ARC_MOTES = [
  { x: 76, y: 86, r: 4, delayMs: 600 },
  { x: 137, y: 49, r: 3, delayMs: 630 },
  { x: 204, y: 33, r: 4, delayMs: 660 },
  { x: 271, y: 35, r: 3, delayMs: 680 },
  { x: 332, y: 52, r: 4, delayMs: 700 },
  { x: 388, y: 70, r: 3, delayMs: 700 },
] as const;
