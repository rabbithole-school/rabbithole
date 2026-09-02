/**
 * Pure, framework-free helpers for the SimulatorViewport — extracted so the
 * truth-preserving invariants (Finding 1) can be unit-tested without a DOM.
 *
 * THE INVARIANT (plan §7.5 / review Finding 1): decoration may never displace
 * recorded truth. Projection owns the recorded position; `automatonLayout`
 * returns only the additive bob timing and sprite radius.
 */

import { AMBIENT_BOB_CYCLE_MS } from "@/lib/simulator/helpers";

export interface AutomatonLayout {
  /** Inner layer: ambient bob, keyed on stable identity (not position, so it
   *  does not restart when the automaton moves — review Finding 4). */
  bob: { delaySeconds: number; durationSeconds: number };
  radius: number;
}

/** Deterministic 0..1 hash of a stable id → a stable bob phase. */
export function stablePhase(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // >>> 0 to unsigned, scale to [0,1)
  return ((hash >>> 0) % 1000) / 1000;
}

export function automatonLayout(entity: {
  id: string;
  size?: number;
}): AutomatonLayout {
  const size = entity.size ?? 0.7;
  return {
    bob: {
      // Phase from identity, so movement never restarts the loop.
      delaySeconds: (-stablePhase(entity.id) * AMBIENT_BOB_CYCLE_MS) / 1000,
      durationSeconds: AMBIENT_BOB_CYCLE_MS / 1000,
    },
    radius: size / 2,
  };
}

/**
 * The neutral invalid-action label (plan §4.3 / review Finding 6). A bare fact,
 * never a diagnosis. Exported so a regression test can prove it stays neutral.
 */
export const INVALID_ACTION_LABEL = "⚠ invalid action this day";

/** Words the scholar-facing surface must never use to explain an outcome. */
export const BANNED_DIAGNOSIS_WORDS = [
  "unclear",
  "confused",
  "confusing",
  "confusion",
  "your fault",
  "mistake",
  "wrong",
  "bad prompt",
  "should have",
];

export function isNeutralLabel(text: string): boolean {
  const lower = text.toLowerCase();
  return !BANNED_DIAGNOSIS_WORDS.some((word) => lower.includes(word));
}

export {
  predictionGateDecision as launchGateDecision,
  type PredictionGateDecision as GateDecision,
} from "@/lib/simulator/helpers";

// Word-level prompt diff (Compare deck diff, plan §7.3 / review Finding 3) now
// lives in `lib/simulator/helpers.ts` (shared with native) — re-exported so
// `InspectorPanel.tsx` and the viewport tests keep importing from here.
export { wordDiff, type DiffToken } from "@/lib/simulator/helpers";

/** Pixels of pointer travel before a press becomes a pan (not a click). */
export const PAN_THRESHOLD_PX = 4;

export interface ViewBoxRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ViewBoxSize {
  width: number;
  height: number;
}

/**
 * Convert a client point through SVG's `xMidYMid meet` transform. Both pan and
 * selection use this exact helper and the same SVG rect, so centered letterbox
 * margins can never make their coordinate spaces diverge.
 */
export function clientPointToViewBox(
  point: { x: number; y: number },
  rect: ViewBoxRect,
  viewBox: ViewBoxSize,
): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0 || viewBox.width <= 0 || viewBox.height <= 0) {
    return null;
  }
  const scale = Math.min(rect.width / viewBox.width, rect.height / viewBox.height);
  const contentWidth = viewBox.width * scale;
  const contentHeight = viewBox.height * scale;
  const contentLeft = rect.left + (rect.width - contentWidth) / 2;
  const contentTop = rect.top + (rect.height - contentHeight) / 2;
  return {
    x: (point.x - contentLeft) / scale,
    y: (point.y - contentTop) / scale,
  };
}

/**
 * True when a viewBox-space point falls inside the rendered content region
 * (0..width, 0..height inclusive). A click in the centered `xMidYMid meet`
 * letterbox margins maps to a negative / out-of-range viewBox point; the
 * inverse isometric projection can still fold such a point back onto an
 * in-bounds edge cell, so selection must reject it BEFORE hit-testing or a
 * margin click can incorrectly pick an edge automaton.
 */
export function isPointInViewBox(
  point: { x: number; y: number },
  viewBox: ViewBoxSize,
): boolean {
  return (
    point.x >= 0 &&
    point.y >= 0 &&
    point.x <= viewBox.width &&
    point.y <= viewBox.height
  );
}

export function clientDragToViewBox(
  start: { x: number; y: number },
  current: { x: number; y: number },
  rect: ViewBoxRect,
  viewBox: ViewBoxSize,
): { dx: number; dy: number } | null {
  const startPoint = clientPointToViewBox(start, rect, viewBox);
  const currentPoint = clientPointToViewBox(current, rect, viewBox);
  if (!startPoint || !currentPoint) return null;
  return { dx: currentPoint.x - startPoint.x, dy: currentPoint.y - startPoint.y };
}

/**
 * Pointer-drag → camera-pan decision (QB walkthrough W1). A press that has not
 * yet traveled past the threshold must NOT pan: panning on a 1px click jitter
 * shifts the scene out from under the pointer, so `pointerup` lands on empty
 * water and the browser never synthesizes a `click` on the automaton. Only once
 * the drag clearly engages do we pan (and, thereafter, suppress the trailing
 * select). Pure so the invariant is unit-tested without a DOM.
 */
export function pointerPan(input: { dx: number; dy: number; moved: boolean }): {
  moved: boolean;
  pan: boolean;
} {
  const engaged = input.moved || Math.abs(input.dx) + Math.abs(input.dy) > PAN_THRESHOLD_PX;
  return { moved: engaged, pan: engaged };
}
