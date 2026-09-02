/**
 * The expression-template input MODEL (a pure-TS slot tree + edit ops) now lives
 * in the cross-surface core (`shared/expressionTemplateInput.ts`) so the native
 * 2-D editor and the web `components/practice/ExpressionEditor` build on the EXACT
 * same state machine — never a hand-maintained drift copy. Native vendors it for
 * Metro (native/vendor/shared, via scripts/sync-vendor.js); this thin seam keeps
 * the `@/lib/expressionTemplateInput` import path stable for `ExpressionEditor` +
 * `NativePracticeControls`.
 */
export {
  createExpressionTemplateState,
  expressionTemplateInsertToken,
  expressionTemplateInsertFraction,
  expressionTemplateInsertExponent,
  expressionTemplateInsertEmptyFraction,
  expressionTemplateBackspace,
  expressionTemplateApplyKey,
  expressionTemplateNextSlot,
  expressionTemplateToLatex,
  expressionTemplateIsComplete,
  expressionTemplateToSubmission,
  expressionTemplateSlotIsEmpty,
  expressionTemplateSetActiveSlot,
  expressionTemplateSetCaret,
  expressionTemplateSeedFromSkeleton,
} from "../../vendor/shared/expressionTemplateInput";
export type {
  SlotId,
  TokenItem,
  FractionItem,
  PowerItem,
  Item,
  Slot,
  ExpressionTemplateState,
} from "../../vendor/shared/expressionTemplateInput";
