/**
 * Capture consent gate for pad-grounded hints. Only a Hint tap with real ink may
 * start the model cell; blank paper stays on the deterministic ladder.
 */

export type PadCapture = { uri: string; mime: string };

export function padHintCaptureForTrigger(
  trigger: "hint" | "miss",
  capture: PadCapture | null,
): PadCapture | null {
  return trigger === "hint" && capture ? capture : null;
}
