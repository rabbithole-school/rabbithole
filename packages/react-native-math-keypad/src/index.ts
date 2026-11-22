// react-native-math-keypad — public surface.
//
// Three layers, usable separately:
//   1. the MODEL (pure TypeScript, no React): flat pad rules + the 2-D builder
//   2. the CONTROLLER (one React hook) that keeps fast typing from losing keys
//   3. the COMPONENTS (React Native + react-native-svg) and the optional iOS
//      hardware-keyboard modules

// ── Model: flat answers ─────────────────────────────────────────────────────
export {
  applyKey,
  applyKeyToInputBuffer,
  applyUnitKey,
  isPadAnswerType,
  padAcceptsFraction,
  padGridKeys,
  padOpKey,
  padShowFraction,
  padShowRemainder,
  padShowSign,
  sanitizePadInput,
  setInputBuffer,
  superscriptExponents,
  unitKeyFamily,
  type InputBuffer,
  type PadAnswerType,
} from "./model/flatPad";

// ── Model: the 2-D builder ──────────────────────────────────────────────────
export {
  createAlgebraTemplateState,
  createExpressionTemplateState,
  expressionTemplateInsertGroup,
  expressionTemplateInsertLog,
  expressionTemplateInsertSquare,
  itemSlots,
  type ExpressionEditorMode,
  type GroupFn,
  type GroupItem,
  type LogItem,
  expressionTemplateApplyKey,
  expressionTemplateBackspace,
  expressionTemplateInsertEmptyFraction,
  expressionTemplateInsertExponent,
  expressionTemplateInsertFraction,
  expressionTemplateInsertRoot,
  expressionTemplateInsertSquareRoot,
  expressionTemplateInsertToken,
  expressionTemplateIsComplete,
  expressionTemplateMoveDown,
  expressionTemplateMoveLeft,
  expressionTemplateMoveRight,
  expressionTemplateMoveUp,
  expressionTemplateNextSlot,
  expressionTemplatePrevSlot,
  expressionTemplateSeedFromSkeleton,
  expressionTemplateSetActiveSlot,
  expressionTemplateSetCaret,
  expressionTemplateSlotIsEmpty,
  expressionTemplateToLatex,
  expressionTemplateToSubmission,
  rootIndexValue,
  type ExpressionTemplateState,
  type FractionItem,
  type Item,
  type PowerItem,
  type RootItem,
  type Slot,
  type SlotId,
  type TokenItem,
} from "./model/expressionTemplate";
export { parseRootIndex, rootIndexName } from "./model/rootIndex";
export * from "./model/boxMetrics";
export * from "./model/radicalGeometry";

// ── Controller ──────────────────────────────────────────────────────────────
export {
  isNavKey,
  useExpressionTemplateController,
  type ExpressionTemplateController,
} from "./useExpressionTemplateController";

// ── Components ──────────────────────────────────────────────────────────────
export {
  BuilderAnswerInput,
  FlatAnswerInput,
  MathAnswerInput,
  type BuilderAnswerInputProps,
  type FlatAnswerInputProps,
  type MathAnswerInputProps,
} from "./components/MathAnswerInput";
export { ExpressionEditor } from "./components/ExpressionEditor";
export {
  BUILDER_GRID,
  GlyphFraction,
  GlyphIndexedRoot,
  GlyphPower,
  GlyphSquareRoot,
  NumberPad,
  StructureKeys,
  UnitKeys,
  type NumberPadProps,
  type StructureKeysProps,
} from "./components/Keypads";
export { PadKey, padKeyLabel, useReduceMotion } from "./components/PadKey";
export { makeKeyStyles, type KeyStyles } from "./components/keyStyles";
export {
  MathKeypadThemeProvider,
  darkTheme,
  lightTheme,
  mergeTheme,
  useMathKeypadTheme,
  type MathKeypadTheme,
  type MathKeypadThemeOverride,
} from "./theme";

// ── Hardware keyboard (optional iOS native modules; safe no-ops without them) ─
export {
  isHardwareKeyboardConnected,
  isHardwareKeyboardDetectionAvailable,
  useHardwareKeyboard,
} from "./native/hardwareKeyboard";
export { KeyCaptureView, isKeyCaptureAvailable, type KeyCaptureViewProps } from "./native/KeyCaptureView";
export { HardwareReturnAdvance, TextKeyCapture } from "./native/TextKeyCapture";
