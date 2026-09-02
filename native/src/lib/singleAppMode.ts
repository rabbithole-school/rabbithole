// Re-export seam for the local `single-app-mode` native module, mirroring the
// `hardwareKeyboard.ts` pattern so app/hook code imports from `@/lib/*` and the
// module path stays in one place. The functions here already degrade to
// false / no-op when the native module is unavailable (Simulator, or a build
// made before the module was added) — see the module's index.ts.
export {
  isSingleAppModeActive,
  enterSingleAppMode,
  exitSingleAppMode,
  setManagedMaximumBrightness,
} from "../../modules/single-app-mode";
