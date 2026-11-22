import { NativeModule } from "expo-modules-core";

// This module is request/response only — it emits no events.
type SingleAppModeModuleEvents = Record<never, never>;

// Declared class shape (the Expo Modules convention, e.g. expo-clipboard):
// extending the `NativeModule` class is what the JS runtime provides at runtime;
// the methods below mirror the Swift `Function`/`AsyncFunction` definitions.
export declare class SingleAppModeModule extends NativeModule<SingleAppModeModuleEvents> {
  /**
   * `UIAccessibility.isGuidedAccessEnabled`, as last read on the main thread
   * (UIKit is main-thread-only; this is called from the JS thread).
   */
  isActive(): boolean;
  /**
   * requestGuidedAccessSession(enabled: true), queued behind any transition in
   * flight. Resolves true once the lock holds (immediately if it already does);
   * false when the app isn't MDM-permitted for ASAM. Never rejects.
   */
  enter(): Promise<boolean>;
  /**
   * requestGuidedAccessSession(enabled: false), queued the same way. Resolves
   * true once released (immediately if already released). Never rejects.
   */
  exit(): Promise<boolean>;
}
