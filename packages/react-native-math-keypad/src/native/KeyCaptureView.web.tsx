import type { KeyCaptureViewProps } from "./KeyCapture.types";

// Web has no UIKit first responder to install; a DOM host drives the same model
// from a keydown listener instead. The view is a no-op here.
export type { KeyCaptureViewProps } from "./KeyCapture.types";
export const isKeyCaptureAvailable = false;

export function KeyCaptureView(_props: KeyCaptureViewProps) {
  return null;
}
