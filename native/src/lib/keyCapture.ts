// Re-export seam for the local `key-capture` native module, mirroring the
// `hardwareKeyboard.ts` pattern so app/component code imports from `@/lib/*` and
// the module path stays in one place.
export {
  KeyCaptureView,
  isKeyCaptureAvailable,
  isKeyCaptureChordAvailable,
  type KeyCaptureChord,
  type KeyCaptureViewProps,
} from "../../modules/key-capture";
