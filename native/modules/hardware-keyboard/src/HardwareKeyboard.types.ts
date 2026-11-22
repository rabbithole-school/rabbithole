import { NativeModule } from "expo-modules-core";

export type HardwareKeyboardChangeEvent = {
  /** True when a physical (hardware) keyboard is currently connected. */
  connected: boolean;
};

/** A watched key went down or up (GameController channel, raw HID usage). */
export type WatchedKeyEvent = {
  hid: number;
  phase: "down" | "up";
  /** Another key went down while this one was held (Option+E, Shift+Option…). */
  chorded: boolean;
  /** On "up": how long the key was held. */
  heldMs?: number;
};

/** A watched system button with no key code went down or up (UIKit channel). */
export type WatchedPressEvent = {
  /** UIPress.PressType raw value; the Folio mic key is 504. */
  type: number;
  phase: "down" | "up" | "cancelled" | "changed" | "other";
};

/** A watched app-wide key command fired (UIKeyCommand; the key is consumed). */
export type WatchedCommandEvent = {
  /** The chord as it was registered, e.g. "cmd+/". */
  chord: string;
};

/** Dev-only probe: every key, from either delivery channel. */
export type KeyProbeEvent = {
  channel: "gc" | "uikit";
  phase: string;
  hid?: number;
  chars?: string;
  mods?: number;
  pressType?: number;
  firstResponder?: string;
};

export type HardwareKeyboardModuleEvents = {
  onChange: (event: HardwareKeyboardChangeEvent) => void;
  onWatchedKey: (event: WatchedKeyEvent) => void;
  onWatchedPress: (event: WatchedPressEvent) => void;
  onWatchedCommand: (event: WatchedCommandEvent) => void;
  onKeyProbe: (event: KeyProbeEvent) => void;
};

// Declared class shape (the Expo Modules convention, e.g. expo-clipboard):
// extending the `NativeModule` class is what provides `addListener`/`removeListener`.
export declare class HardwareKeyboardModule extends NativeModule<HardwareKeyboardModuleEvents> {
  /** Point-in-time check: is a hardware keyboard connected right now? */
  isConnected(): boolean;
  /** Present only in dev clients built with the voice-key spike. */
  supportsKeyEvents?(): boolean;
  setWatchedKeys?(hidUsages: number[]): void;
  supportsPressEvents?(): boolean;
  setWatchedPressTypes?(pressTypes: number[]): void;
  supportsPressClaims?(): boolean;
  setClaimedPressTypes?(pressTypes: number[]): void;
  supportsCommandEvents?(): boolean;
  setWatchedCommands?(chords: string[]): void;
  isEditingText?(): Promise<boolean>;
  endEditing?(): Promise<void>;
  setProbe?(enabled: boolean): void;
}
