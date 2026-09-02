/**
 * NativeManipulativeHost — mounted once at the app root (next to
 * `ExternalAppHost`). It renders the currently-requested manipulative practice
 * item (see `openNativeManipulativeItem` in lib/nativeManipulativeHost.ts) in a
 * sheet. The item card inside decides everything else: render the kind INLINE
 * with native chrome + server grading, or hand off to the WebView embed for a
 * kind without a native renderer.
 *
 * This is the minimal "item card host" — one item in a sheet, not a practice
 * playlist. A native practice-serving surface, once it exists, just calls
 * `openNativeManipulativeItem({ itemId, scholarId })`.
 */
import { useCallback, useMemo } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SymbolView } from "expo-symbols";

import { fonts, useColors } from "@/theme";
import { makePracticeShellStyles } from "@/lib/practiceShell";
import {
  closeNativeManipulativeItem,
  useNativeManipulativeRequest,
} from "@/lib/nativeManipulativeHost";
import { NativeManipulativeItem } from "./NativeManipulativeItem";

export function NativeManipulativeHost() {
  const request = useNativeManipulativeRequest();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  // The single-item host renders into the SAME shared practice shell the
  // in-playlist screen uses, so a manipulative launched standalone looks
  // identical to one inside a run (centered stage, corner stamp, pinned lane).
  const shell = useMemo(() => makePracticeShellStyles(colors), [colors]);

  const close = useCallback(() => closeNativeManipulativeItem(), []);

  const visible = request != null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={close}
    >
      <View style={[styles.container, { backgroundColor: colors.bgSubtle }]}>
        <View style={[styles.header, { paddingTop: insets.top ? 8 : 12, borderBottomColor: colors.border }]}>
          <Text style={[styles.title, { color: colors.navy }]}>Practice</Text>
          <Pressable
            onPress={close}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.6 }]}
            hitSlop={10}
          >
            <SymbolView name="xmark.circle.fill" size={26} tintColor={colors.charcoalSubtle} />
          </Pressable>
        </View>
        {request ? (
          <NativeManipulativeItem
            key={`${request.scholarId}:${request.itemId}`}
            itemId={request.itemId}
            scholarId={request.scholarId}
            shell={shell}
            isLast
            onRequestClose={close}
          />
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontFamily: fonts.bold, fontSize: 18 },
  closeBtn: { padding: 2 },
});
