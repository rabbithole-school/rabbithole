/**
 * The expression-editor answer-box geometry floors live in the cross-surface
 * core (`shared/expressionEditorBoxMetrics.ts`) so the native 2-D editor and the
 * web `components/practice/ExpressionEditor` size their boxes from the EXACT
 * same rule — never a hand-maintained drift copy. Native vendors it for Metro
 * (native/vendor/shared, via scripts/sync-vendor.js); this thin seam keeps the
 * `@/lib/expressionEditorBoxMetrics` import path stable.
 */
export {
  EXPR_BOX_BORDER,
  EXPR_BOX_MARGIN_X,
  EXPR_BOX_MIN,
  EXPR_BOX_PAD_X,
  EXPR_BOX_PAD_Y,
  EXPR_DIGIT_ADVANCE_EM,
  EXPR_GLYPH_BASELINE_EM,
  EXPR_GLYPH_LINE_HEIGHT,
  expressionBoxBaselineOffset,
  expressionBoxChrome,
  expressionBoxMinSize,
  expressionRadicandFloorSize,
} from "../../vendor/shared/expressionEditorBoxMetrics";
