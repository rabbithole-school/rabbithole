// Re-export seam for the local `hardware-keyboard` native module, mirroring the
// `practicePad.ts` pattern so app/component code imports from `@/lib/*` and the
// module path stays in one place.
export {
  useHardwareKeyboard,
  isHardwareKeyboardConnected,
  type HardwareKeyboardChangeEvent,
} from "../../modules/hardware-keyboard";
