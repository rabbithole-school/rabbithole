import type { KeyCaptureViewProps } from "./KeyCapture.types";

// Web has no hardware-key first responder to install (and the web app drives the
// same shared editor model from its own `useExpressionTemplateKeyboard` DOM
// hook), so the native KeyCapture view is a no-op here.
export const isKeyCaptureAvailable = false;
export const isKeyCaptureChordAvailable = false;

export function KeyCaptureView(
  _props: KeyCaptureViewProps,
) {
  return null;
}
