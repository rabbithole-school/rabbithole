import { NativeModule } from "expo-modules-core";

export type HardwareKeyboardChangeEvent = {
  /** True when a physical (hardware) keyboard is currently connected. */
  connected: boolean;
};

export type HardwareKeyboardModuleEvents = {
  onChange: (event: HardwareKeyboardChangeEvent) => void;
};

// Declared class shape (the Expo Modules convention, e.g. expo-clipboard):
// extending the `NativeModule` class is what provides `addListener`/`removeListener`.
export declare class HardwareKeyboardModule extends NativeModule<HardwareKeyboardModuleEvents> {
  /** Point-in-time check: is a hardware keyboard connected right now? */
  isConnected(): boolean;
}
