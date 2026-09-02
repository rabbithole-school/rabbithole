"use client";

import { useEffect } from "react";
import {
  createExpressionTemplateState,
  expressionTemplateSeedFromSkeleton,
  type ExpressionTemplateState,
  type SlotId,
} from "@/shared/expressionTemplateInput";
import { useExpressionTemplateController } from "@/shared/useExpressionTemplateController";

/**
 * The web 2-D expression editor's state machine, extracted so the practice
 * session AND placement drive the SAME builder (single source of truth). It
 * owns the `ExpressionTemplateState`, (re)seeds it when the active item
 * changes, and exposes the two direct-manipulation ops the DOM editor needs:
 *
 *   • `onTemplateKey` — a keystroke (on-screen glyph key or hardware keyboard),
 *     routed to the shared model op, then mirrored back into the caller's
 *     answer buffer via `onSubmissionChange`. Submission is "" until the
 *     structure is fully filled, so a submit CTA stays disabled on a half-built
 *     fraction — matching native exactly.
 *   • `onSetCaret` — a click drops the insertion bar at a precise gap in a box.
 *   • `onInsertFraction` / `onInsertPower` — the on-screen glyph BUTTONS.
 *     `onInsertFraction` inserts an EMPTY ▢/▢ at the caret (does NOT grab), so a
 *     whole number typed first stays put — the only way to build a mixed number
 *     (`2` then the fraction glyph → `2 ▢/▢`). `onInsertPower`, like the hardware
 *     `^`, GRABS the operand to the caret's left as the base (`1` then the
 *     exponent glyph → `1^▢`); there is no "mixed exponent", so `1 ▢^▢` would be
 *     nonsense. With no operand to grab it falls back to an empty `▢^▢`.
 *
 * `seedSkeleton` seeds a locked L1 skeleton (the shape is fixed, the scholar
 * only fills boxes); pass `null` for an EMPTY, unlocked editor (the fraction /
 * exponent glyph keys are offered so the scholar builds the structure). The
 * whole hook is a no-op state-wise until `enabled` (so it costs nothing on a
 * flat / multiple-choice / manipulative item).
 */
export function useExpressionTemplate({
  enabled,
  itemKey,
  seedSkeleton,
  onSubmissionChange,
  onKeyDispatched,
}: {
  /** True only while a 2-D item is actively being answered. */
  enabled: boolean;
  /** Changing this reseeds the editor (a fresh item, or a same-item retry). */
  itemKey: string | undefined;
  /** A locked L1 skeleton to seed from, or null/undefined for an empty editor. */
  seedSkeleton?: string | null;
  /** Mirror the resulting submission string back into the caller's answer buffer. */
  onSubmissionChange: (submission: string) => void;
  /** Fired on every dispatched key with whether it was pure navigation — the
   *  caller can add haptics (every key) and latency tracking (non-nav only). */
  onKeyDispatched?: (isNav: boolean) => void;
}): {
  templateState: ExpressionTemplateState | null;
  onTemplateKey: (k: string) => void;
  onSetCaret: (id: SlotId, index: number) => void;
  onInsertFraction: () => void;
  onInsertPower: () => void;
  onInsertSquareRoot: () => void;
  onInsertRoot: () => void;
} {
  // The controller owns the document (and the ref discipline that keeps a burst
  // of keystrokes from composing against a stale copy) — shared with native.
  const { state, reset, applyKey, setCaret, insertFraction, insertPower, insertSquareRoot, insertRoot } =
    useExpressionTemplateController({ onSubmissionChange, onKeyDispatched });

  // Seed a fresh editor when a 2-D item becomes answerable. A fresh item AND a
  // same-item retry both reset it (via `itemKey`), while the answering→feedback
  // transition does NOT (the built answer must stay visible, verdict-tinted) —
  // that's why `enabled` folds in the "answering" phase.
  useEffect(() => {
    if (!enabled) return;
    const seeded = seedSkeleton ? expressionTemplateSeedFromSkeleton(seedSkeleton) : null;
    reset(seeded ?? createExpressionTemplateState(""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, itemKey, seedSkeleton]);

  return {
    templateState: state,
    onTemplateKey: applyKey,
    onSetCaret: setCaret,
    onInsertFraction: insertFraction,
    onInsertPower: insertPower,
    onInsertSquareRoot: insertSquareRoot,
    onInsertRoot: insertRoot,
  };
}
