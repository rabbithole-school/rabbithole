import type { StyleProp, ViewStyle } from "react-native";

export type KeyCaptureViewProps = {
  /** While true, the off-screen view becomes first responder and captures. */
  active: boolean;
  /**
   * A normalized editor key: a digit, "x", "/", "^", "⌫", "Tab" / "ShiftTab",
   * or "ArrowLeft" / "ArrowRight" / "ArrowUp" / "ArrowDown". Route it straight
   * into `expressionTemplateApplyKey` (or the controller's `applyKey`).
   */
  onKey: (key: string) => void;
  /** Return / Enter. */
  onSubmit?: () => void;
  style?: StyleProp<ViewStyle>;
};
