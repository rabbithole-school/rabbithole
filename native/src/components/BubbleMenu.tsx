import { type ReactNode, useCallback, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import * as Haptics from "expo-haptics";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import { fonts, palette, useColors } from "@/theme";

type Anchor = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type MaybePromise = void | Promise<void>;

export type BubbleMenuAlign = "left" | "right" | "center";

export type BubbleMenuProps = {
  children: ReactNode;
  onCopy: () => MaybePromise;
  onFlag?: () => MaybePromise;
  flagged?: boolean;
  disabled?: boolean;
  align?: BubbleMenuAlign;
  delayLongPress?: number;
  hitSlop?: PressableProps["hitSlop"];
  style?: StyleProp<ViewStyle>;
  previewStyle?: StyleProp<ViewStyle>;
  /**
   * Optional single-tap action on the wrapped bubble. The long-press context
   * menu (Copy/Flag) is unaffected — a tap fires this, a long-press opens the
   * menu. Kept generic: the caller owns the tap's meaning (the session screen
   * uses it for tap-to-read-aloud). When present the wrapper reads as a button.
   */
  onPress?: PressableProps["onPress"];
  /** a11y hint describing the `onPress` action (e.g. "Reads this message aloud"). */
  accessibilityHint?: string;
};

const MENU_WIDTH = 260;
const ROW_HEIGHT = 50;
const MENU_GAP = 10;
const SCREEN_MARGIN = 12;

// Snappy spring that matches iOS UIContextMenu's spring feel
const OPEN_SPRING = { damping: 22, stiffness: 380, mass: 0.8 };
const CLOSE_MS = 140;

/**
 * Chat-bubble context menu without adding a native module: long-press the wrapped
 * bubble, lift a preview in place, and show the actions anchored to that bubble.
 * A true UIContextMenu can replace this wrapper later with the same callback API.
 */
export function BubbleMenu({
  children,
  onCopy,
  onFlag,
  flagged = false,
  disabled = false,
  align = "center",
  delayLongPress = 300,
  hitSlop,
  style,
  previewStyle,
  onPress,
  accessibilityHint,
}: BubbleMenuProps) {
  const anchorRef = useRef<View>(null);
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  const progress = useSharedValue(0);
  // 1 = menu rendered below bubble, -1 = above; drives the entry-slide direction
  const menuDir = useSharedValue(1);

  const show = useCallback(() => {
    if (disabled) return;
    anchorRef.current?.measureInWindow((x, y, width, height) => {
      if (width <= 0 || height <= 0) return;

      // Heavy impact = iOS UIContextMenu activation feel (stronger than selectionAsync)
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});

      const actionCount = onFlag ? 2 : 1;
      const menuHeight = actionCount * ROW_HEIGHT;
      const pos = positionMenu({ x, y, width, height }, screenWidth, screenHeight, menuHeight, align);
      // Set direction BEFORE the animation frame so the worklet reads the correct value
      menuDir.set(pos.above ? -1 : 1);

      setAnchor({ x, y, width, height });
      setOpen(true);
      progress.set(0);
      progress.set(withSpring(1, OPEN_SPRING));
    });
  }, [disabled, progress, menuDir, onFlag, screenWidth, screenHeight, align]);

  const hide = useCallback(
    (then?: () => MaybePromise) => {
      progress.set(withTiming(0, {
        duration: CLOSE_MS,
        easing: Easing.in(Easing.cubic),
      }));
      setTimeout(() => {
        setOpen(false);
        setAnchor(null);
        void then?.();
      }, CLOSE_MS - 10);
    },
    [progress],
  );

  const runCopy = () => hide(onCopy);
  const runFlag = () =>
    hide(() => {
      // Warning haptic fires as the destructive action triggers, not on open
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      return onFlag?.();
    });

  // Backdrop fades to an atmospheric dark that makes the lifted bubble pop
  const backdropAnim = useAnimatedStyle(() => ({
    opacity: progress.get(),
  }));

  // Preview lifts off: scales slightly above 1 at full open, shadow punches
  const previewAnim = useAnimatedStyle(() => ({
    opacity: 1,
    transform: [{ scale: 0.97 + progress.get() * 0.055 }],
  }));

  // Menu springs in from the bubble edge: large-to-normal scale + directional slide
  const menuAnim = useAnimatedStyle(() => ({
    opacity: progress.get(),
    transform: [
      // Scale from 0.8 → 1.0 so the spring-in is clearly visible
      { scale: 0.8 + progress.get() * 0.2 },
      // Slide from the bubble toward final position (direction-aware)
      { translateY: (1 - progress.get()) * 10 * menuDir.get() },
    ],
  }));

  const actionCount = onFlag ? 2 : 1;
  const menuHeight = actionCount * ROW_HEIGHT;
  const menuPos = anchor
    ? positionMenu(anchor, screenWidth, screenHeight, menuHeight, align)
    : { left: SCREEN_MARGIN, top: SCREEN_MARGIN, above: false };

  return (
    <>
      <View ref={anchorRef} collapsable={false} style={style}>
        <Pressable
          disabled={disabled}
          delayLongPress={delayLongPress}
          hitSlop={hitSlop}
          onPress={onPress}
          onLongPress={show}
          accessibilityRole={onPress ? "button" : undefined}
          accessibilityHint={onPress ? accessibilityHint : undefined}
          style={({ pressed }) =>
            // Pressed feedback only when the bubble is tappable (read-aloud);
            // matches the repo's native opacity press idiom. Long-press-only
            // bubbles keep their exact prior (feedback-free) behavior.
            pressed && onPress ? styles.bubblePressed : undefined
          }
          accessibilityActions={[
            { name: "copy", label: "Copy" },
            ...(onFlag
              ? [
                  {
                    name: "flag",
                    label: flagged
                      ? 'Remove "got this wrong"'
                      : "Rabbithole got this wrong",
                  },
                ]
              : []),
          ]}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === "copy") void onCopy();
            if (event.nativeEvent.actionName === "flag") {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(
                () => {},
              );
              void onFlag?.();
            }
          }}
        >
          {children}
        </Pressable>
      </View>

      <Modal
        visible={open && !!anchor}
        transparent
        animationType="none"
        supportedOrientations={["landscape", "landscape-left", "landscape-right"]}
        onRequestClose={() => hide()}
      >
        <View style={StyleSheet.absoluteFill}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => hide()}>
            <Animated.View style={[styles.scrim, backdropAnim]} />
          </Pressable>

          {anchor && (
            <Animated.View
              pointerEvents="none"
              style={[
                styles.preview,
                {
                  left: anchor.x,
                  top: anchor.y,
                  width: anchor.width,
                  minHeight: anchor.height,
                },
                previewAnim,
                previewStyle,
              ]}
            >
              {children}
            </Animated.View>
          )}

          <Animated.View
            style={[
              styles.menu,
              { left: menuPos.left, top: menuPos.top, width: MENU_WIDTH },
              menuAnim,
            ]}
          >
            <Pressable onPress={() => {}}>
              <MenuAction
                icon="doc.on.doc"
                label="Copy"
                last={!onFlag}
                onPress={runCopy}
              />
              {onFlag && (
                <MenuAction
                  icon={flagged ? "flag.slash" : "flag.fill"}
                  label={flagged ? 'Remove "got this wrong"' : "Rabbithole got this wrong"}
                  danger={!flagged}
                  last
                  onPress={runFlag}
                />
              )}
            </Pressable>
          </Animated.View>
        </View>
      </Modal>
    </>
  );
}

function positionMenu(
  anchor: Anchor,
  screenWidth: number,
  screenHeight: number,
  menuHeight: number,
  align: BubbleMenuAlign,
) {
  const left =
    align === "left"
      ? anchor.x
      : align === "right"
        ? anchor.x + anchor.width - MENU_WIDTH
        : anchor.x + anchor.width / 2 - MENU_WIDTH / 2;

  const above = anchor.y >= menuHeight + MENU_GAP + SCREEN_MARGIN;
  const top = above
    ? anchor.y - menuHeight - MENU_GAP
    : anchor.y + anchor.height + MENU_GAP;

  return {
    left: clamp(left, SCREEN_MARGIN, screenWidth - MENU_WIDTH - SCREEN_MARGIN),
    top: clamp(top, SCREEN_MARGIN, screenHeight - menuHeight - SCREEN_MARGIN),
    above,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function MenuAction({
  icon,
  label,
  onPress,
  danger = false,
  last = false,
}: {
  icon: SymbolViewProps["name"];
  label: string;
  onPress: () => void;
  danger?: boolean;
  last?: boolean;
}) {
  const c = useColors();
  const tint = danger ? c.statusRed : c.charcoal;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        !last && styles.actionBorder,
        pressed && styles.actionPressed,
      ]}
    >
      <SymbolView
        name={icon}
        size={19}
        tintColor={danger ? c.statusRed : c.charcoalMuted}
      />
      <Text style={[styles.actionLabel, { color: tint }]}>{label}</Text>
    </Pressable>
  );
}

export default BubbleMenu;

const styles = StyleSheet.create({
  // Atmospheric dark dim — much denser than before so the lifted bubble reads clearly
  scrim: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.42)",
  },
  // Preview inherits bubble's own background; shadow punches on open
  preview: {
    position: "absolute",
    shadowColor: palette.navy[900] ?? "#000",
    shadowOpacity: 0.28,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
  },
  // iOS system-gray tint (UITableView grouped) approximates frosted glass without blur
  menu: {
    position: "absolute",
    backgroundColor: "rgba(242,242,247,0.97)",
    borderRadius: 14,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.26,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 12 },
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(0,0,0,0.10)",
  },
  action: {
    minHeight: ROW_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  // True hairline (0.33px on 3× screens) matching iOS separator
  actionBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(0,0,0,0.14)",
  },
  // Subtle dark overlay on press (neutral, works on any bubble color)
  actionPressed: { backgroundColor: "rgba(0,0,0,0.07)" },
  // Whole-bubble press feedback for the tap-to-read action (opacity idiom).
  bubblePressed: { opacity: 0.6 },
  actionLabel: {
    flex: 1,
    fontSize: 15,
    fontFamily: fonts.medium,
  },
});
