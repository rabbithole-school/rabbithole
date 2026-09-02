/**
 * Native seam for the shared expression-editor state controller — the twin of
 * `@/lib/expressionTemplateInput`. The implementation lives in the vendored
 * cross-surface copy so web and iPad share ONE definition of "a keystroke
 * applies to the latest document" (see the module's own comment for the
 * stale-closure bug this exists to prevent).
 */
export {
  useExpressionTemplateController,
  isNavKey,
} from "../../vendor/shared/useExpressionTemplateController";
export type { ExpressionTemplateController } from "../../vendor/shared/useExpressionTemplateController";
