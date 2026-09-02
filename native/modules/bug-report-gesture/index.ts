import { requireOptionalNativeModule } from "expo-modules-core";

import type {
  BugReportGestureEvent,
  BugReportGestureModule,
} from "./src/BugReportGesture.types";

export type {
  BugReportGestureEvent,
  BugReportGesturePhase,
} from "./src/BugReportGesture.types";

const nativeModule =
  requireOptionalNativeModule<BugReportGestureModule>("BugReportGesture");

export function subscribeBugReportGesture(
  listener: (event: BugReportGestureEvent) => void,
): () => void {
  if (!nativeModule) return () => {};
  const subscription = nativeModule.addListener("onGesture", listener);
  return () => subscription.remove();
}
