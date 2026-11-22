// Re-export seam for the local `hardware-keyboard` native module, mirroring the
// `practicePad.ts` pattern so app/component code imports from `@/lib/*` and the
// module path stays in one place.
export {
  useHardwareKeyboard,
  isHardwareKeyboardConnected,
  watchHardwareKeys,
  watchHardwarePresses,
  claimHardwarePresses,
  watchKeyCommands,
  isEditingText,
  endEditing,
  probeHardwareKeys,
  hardwareKeyEventsAvailable,
  type HardwareKeyboardChangeEvent,
  type WatchedKeyEvent,
  type WatchedPressEvent,
  type WatchedCommandEvent,
  type KeyProbeEvent,
} from "../../modules/hardware-keyboard";
