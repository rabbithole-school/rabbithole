/**
 * The Studio's WebView — the entire editor, canvas and program runtime as ONE
 * self-contained HTML document (`shared/studioDocument.generated.ts`). See
 * `StudioScreen`'s header comment for why this is one document instead of
 * split across the bridge, and why the WebView is keyed on the document hash
 * alone (not the level or the source — a remount would blow away every
 * keystroke of the scholar's in-progress editor state).
 */
import {
  forwardRef,
  type ComponentProps,
  type ComponentType,
  type RefAttributes,
} from "react";
import { StyleSheet, View } from "react-native";
import WebView from "react-native-webview";

import { useColors } from "@/theme";

import { RABBITHOLE_APP_STATE_SDK } from "../../../vendor/shared/appStateBridge.mjs";
import { STUDIO_DOCUMENT_HASH, STUDIO_DOCUMENT_HTML } from "../../../vendor/shared/studioDocument.generated";
import type { StudioWebViewHandle } from "./useStudioBridge";

// `source={{ html }}` — the in-memory-HTML idiom
// established in `VibecodeScreen.tsx` (see its header comment for why
// `ExternalAppHost` can't be used for a document that doesn't have a URL).
type CodeWebViewProps = ComponentProps<typeof WebView> &
  RefAttributes<StudioWebViewHandle>;
const CodeWebView =
  WebView as unknown as ComponentType<CodeWebViewProps>;

interface StudioCanvasProps {
  onLoadStart: () => void;
  onMessage: (event: { nativeEvent: { data: string } }) => void;
}


/**
 * Gesture handling mirrors `ExternalAppHost`'s `gestureMode: "interactive"`
 * (used for embedded pages that own their own pointer drags): disabling the
 * WebView's own scroll/bounce is what stops a drag on the canvas from
 * scrolling the page instead of moving the robot/pen. We deliberately do NOT
 * also inject a blanket `touch-action: none` — that would fight the code
 * editor's own internal scrolling. Preventing default on the canvas element
 * itself is the document's own job (it owns pointer handling for its own
 * drag surface); this native layer only needs to get out of the way.
 *
 * Keyboard props (`keyboardDisplayRequiresUserAction`,
 * `hideKeyboardAccessoryView`) have no precedent elsewhere in this codebase —
 * this is the first WebView screen built around a soft-keyboard-heavy text
 * editor. Unverified on a real device/simulator; see the report.
 */
export const StudioCanvas = forwardRef<StudioWebViewHandle, StudioCanvasProps>(
  function StudioCanvas({ onLoadStart, onMessage }, ref) {
    const colors = useColors();
    return (
      <View style={[styles.root, { backgroundColor: colors.bg }]}>
        <CodeWebView
          ref={ref}
          key={STUDIO_DOCUMENT_HASH}
          source={{ html: STUDIO_DOCUMENT_HTML }}
          injectedJavaScriptBeforeContentLoaded={RABBITHOLE_APP_STATE_SDK}
          onLoadStart={onLoadStart}
          onMessage={onMessage}
          originWhitelist={["*"]}
          style={styles.webView}
          javaScriptEnabled
          domStorageEnabled
          // Canvas drags must never scroll/bounce the outer WebView.
          scrollEnabled={false}
          bounces={false}
          overScrollMode="never"
          automaticallyAdjustContentInsets={false}
          contentInsetAdjustmentBehavior="never"
          allowsBackForwardNavigationGestures={false}
          // A kid typing code with the soft keyboard up, on an iPad — the
          // keyboard must appear the instant a text field is focused, with no
          // extra accessory bar eating vertical space from the canvas.
          keyboardDisplayRequiresUserAction={false}
          hideKeyboardAccessoryView
        />
      </View>
    );
  },
);

const styles = StyleSheet.create({
  root: { flex: 1 },
  webView: { flex: 1, backgroundColor: "transparent" },
});
