/**
 * FloatingChatPanel — a compact chat card that floats over a screen whose own
 * chat is hidden, so the voice key (and its text twin, ⌘/) can talk to the AI
 * without opening the full chat. See src/lib/voiceKey.ts.
 *
 * The builder is the case it exists for: its chat lives in a bottom Drawer that
 * dims and covers most of the app, while the point of talking to the designer is
 * watching the app change. This card leaves the app visible (a clear backdrop,
 * no dim) and sits above the keyboard. A tap anywhere outside the card closes
 * it (Andy, 2026-11-11); that tap does not also reach the app beneath.
 *
 * It owns no conversation. The screen passes its OWN composer row (the same
 * RecordingBar, text field and send path its docked chat uses) and the turns to
 * show, so there is one recorder and one send path per screen. Closing it is
 * the screen's call: ✕, a tap outside, Escape (via the voice-key registry), or "Open chat",
 * which hands the conversation to the full chat.
 */

import { useRef, type ReactNode } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SymbolView } from "expo-symbols";

import { useKeyboardInset } from "@/hooks/useKeyboardInset";
import { fonts, useColors } from "@/theme";

const MAX_WIDTH = 640;
const THREAD_MAX_HEIGHT = 260;

export function FloatingChatPanel({
  open,
  title,
  onClose,
  onExpand,
  thread,
  composer,
}: {
  open: boolean;
  /** Who is listening: "Designer" or "Tutor", as the full chat titles itself. */
  title: string;
  onClose: () => void;
  /** Hand the conversation to the screen's full chat. */
  onExpand?: () => void;
  /** The turns since the panel opened, rendered by the screen. Empty → none. */
  thread?: ReactNode;
  /** The screen's composer row: its RecordingBar or its text field. */
  composer: ReactNode;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { style: keyboardInsetStyle } = useKeyboardInset();
  const scrollRef = useRef<ScrollView>(null);

  if (!open) return null;

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        StyleSheet.absoluteFill,
        styles.layer,
        { marginBottom: insets.bottom + 16 },
        keyboardInsetStyle,
      ]}
    >
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onClose}
        accessibilityLabel="Close chat"
      />
      <Animated.View
        entering={FadeInDown.duration(180)}
        style={[
          styles.card,
          {
            width: Math.min(MAX_WIDTH, width - 32),
            backgroundColor: colors.bg,
            borderColor: colors.border,
          },
        ]}
      >
        <View style={styles.header}>
          <Text style={[styles.title, { color: colors.fgMuted }]}>{title}</Text>
          {onExpand ? (
            <Pressable
              onPress={onExpand}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Open chat"
            >
              <Text style={[styles.action, { color: colors.violet }]}>Open chat</Text>
            </Pressable>
          ) : null}
          <Pressable
            onPress={onClose}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <SymbolView name="xmark.circle.fill" tintColor={colors.gray300} size={22} />
          </Pressable>
        </View>
        {thread ? (
          <ScrollView
            ref={scrollRef}
            style={styles.thread}
            contentContainerStyle={styles.threadBody}
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
          >
            {thread}
          </ScrollView>
        ) : null}
        <View style={[styles.composer, { borderTopColor: colors.border }]}>{composer}</View>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // The card shrinks (its turns scroll) rather than ride up under the
  // screen's header when a soft keyboard leaves little room.
  layer: { justifyContent: "flex-end", alignItems: "center", paddingTop: 12 },
  card: {
    flexShrink: 1,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    // The card floats over a live app, so it needs to read as above it.
    shadowColor: "#000",
    shadowOpacity: 0.16,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 6,
  },
  title: { flex: 1, fontFamily: fonts.semibold, fontSize: 14 },
  action: { fontFamily: fonts.semibold, fontSize: 14 },
  thread: { maxHeight: THREAD_MAX_HEIGHT, flexShrink: 1 },
  threadBody: { paddingHorizontal: 16, paddingVertical: 6, gap: 8 },
  composer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
});
