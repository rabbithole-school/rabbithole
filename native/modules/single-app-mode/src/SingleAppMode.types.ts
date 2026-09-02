import { NativeModule } from "expo-modules-core";

// This module is request/response only — it emits no events.
type SingleAppModeModuleEvents = Record<never, never>;

// Declared class shape (the Expo Modules convention, e.g. expo-clipboard):
// extending the `NativeModule` class is what the JS runtime provides at runtime;
// the methods below mirror the Swift `Function`/`AsyncFunction` definitions.
export declare class SingleAppModeModule extends NativeModule<SingleAppModeModuleEvents> {
  /** Point-in-time read of `UIAccessibility.isGuidedAccessEnabled`. */
  isActive(): boolean;
  /**
   * requestGuidedAccessSession(enabled: true). Resolves the OS success flag
   * (false when the app isn't MDM-permitted for ASAM). Never rejects.
   */
  enter(): Promise<boolean>;
  /**
   * requestGuidedAccessSession(enabled: false). Resolves the OS success flag.
   * Never rejects.
   */
  exit(): Promise<boolean>;
  /** Controls maximum brightness for the managed-app lifetime. */
  setManagedMaximumBrightness?(enabled: boolean): Promise<void>;
  /** Compatibility with dev clients built before setManagedMaximumBrightness. */
  setBrightnessPinned?(pinned: boolean): Promise<void>;
}
