// Re-export seam for the local `key-capture` native module, mirroring the
// `hardwareKeyboard.ts` pattern so app/component code imports from `@/lib/*` and
// the module path stays in one place.
//
// The seam also doubles as a PRESENCE WITNESS. The root view's capture-phase
// touch handler feeds the device-activity presence clock, but hardware-keyboard
// input produces no touch — so a scholar driving the expression editor or the
// slides editor entirely from the keyboard would look idle and stop being
// counted as present. Wrapping here covers every KeyCaptureView consumer at
// once (NativePracticeControls, SlidesEditorNative) without asking each of them
// to remember. See PRESENCE_IDLE_TIMEOUT_MS in `deviceActivityQueue.ts`.

import { recordInteraction } from "@/lib/deviceActivityQueue";
import {
  KeyCaptureView as NativeKeyCaptureView,
  type KeyCaptureViewProps,
} from "../../modules/key-capture";

export {
  isKeyCaptureAvailable,
  isKeyCaptureChordAvailable,
  type KeyCaptureChord,
  type KeyCaptureViewProps,
} from "../../modules/key-capture";

export function KeyCaptureView({
  onKey,
  onSubmit,
  onChord,
  ...rest
}: KeyCaptureViewProps) {
  return (
    <NativeKeyCaptureView
      {...rest}
      onKey={(key) => {
        recordInteraction();
        onKey(key);
      }}
      onSubmit={() => {
        recordInteraction();
        onSubmit?.();
      }}
      {...(onChord
        ? {
            onChord: (chord: Parameters<NonNullable<typeof onChord>>[0]) => {
              recordInteraction();
              onChord(chord);
            },
          }
        : {})}
    />
  );
}
