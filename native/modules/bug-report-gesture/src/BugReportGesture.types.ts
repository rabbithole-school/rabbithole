import { NativeModule } from "expo-modules-core";

export type BugReportGesturePhase = "began" | "ended" | "cancelled";

export type BugReportGestureEvent = {
  phase: BugReportGesturePhase;
  sequence: number;
  touches: number;
};

export type BugReportGestureModuleEvents = {
  onGesture: (event: BugReportGestureEvent) => void;
};

export declare class BugReportGestureModule extends NativeModule<BugReportGestureModuleEvents> {}
