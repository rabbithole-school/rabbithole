import { useCallback, useMemo, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import { fonts, useColors } from "@/theme";

export type SessionsView = "active" | "archived";

const LABELS: Record<SessionsView, string> = {
  active: "Active Sessions",
  // "archived" is the internal view key; the surface now also holds completed
  // class-focus work the plate has dropped, so it reads "Finished" (parity with
  // the web "📦 Finished" section).
  archived: "Finished",
};

/**
 * The Home nav title as a pull-down (the iOS title-menu pattern, à la Files /
 * Mail mailbox switcher): tapping "Active Sessions ▾" drops a 2-row menu to
 * switch the screen in place between the active plate and the archived list.
 * Makes the header real-estate work harder than a static title.
 */
export function SessionsTitleSwitcher({
  view,
  onSelect,
  activeCount,
  archivedCount,
  variant = "title",
}: {
  view: SessionsView;
  onSelect: (v: SessionsView) => void;
  activeCount: number | null;
  archivedCount: number | null;
  /**
   * "title" (default): the nav-title pull-down (text + chevron, centered).
   * "filter": a compact icon button for the header's top-left slot — the
   * menu drops from the left. Filled/violet when a non-default filter
   * ("Finished") is applied.
   */
  variant?: "title" | "filter";
}) {
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const anim = useSharedValue(0);
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const show = useCallback(() => {
    Haptics.selectionAsync();
    setOpen(true);
    anim.set(withSpring(1, { damping: 18, stiffness: 320, mass: 0.7 }));
  }, [anim]);
  const hide = useCallback(
    (then?: () => void) => {
      anim.set(withTiming(0, { duration: 120, easing: Easing.in(Easing.cubic) }));
      setTimeout(() => {
        setOpen(false);
        then?.();
      }, 115);
    },
    [anim],
  );

  const menuStyle = useAnimatedStyle(() => ({
    opacity: anim.get(),
    transform: [{ scale: 0.93 + anim.get() * 0.07 }, { translateY: (1 - anim.get()) * -8 }],
  }));

  const pick = (v: SessionsView) => hide(() => v !== view && onSelect(v));
  const count = (v: SessionsView) => (v === "active" ? activeCount : archivedCount);

  // Left-anchored drop for the compact filter button; centered for the title.
  const menuPos =
    variant === "filter"
      ? { top: insets.top + 44, alignSelf: "flex-start" as const, marginLeft: insets.left + 12 }
      : { top: insets.top + 44, alignSelf: "center" as const };

  return (
    <>
      {variant === "filter" ? (
        <Pressable
          onPress={show}
          hitSlop={12}
          style={styles.filterTrigger}
          accessibilityRole="button"
          accessibilityLabel="Filter sessions"
        >
          <SymbolView
            name={
              view === "archived"
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle"
            }
            size={22}
            tintColor={view === "archived" ? colors.violet : colors.navy}
          />
        </Pressable>
      ) : (
        <Pressable onPress={show} hitSlop={12} style={styles.trigger}>
          <Text style={styles.title}>{LABELS[view]}</Text>
          <SymbolView name="chevron.down" size={13} tintColor={colors.navy} />
        </Pressable>
      )}

      <Modal
        visible={open}
        transparent
        animationType="none"
        supportedOrientations={["landscape", "landscape-left", "landscape-right"]}
        onRequestClose={() => hide()}
      >
        <Pressable style={styles.backdrop} onPress={() => hide()}>
          <Animated.View style={[styles.menu, menuPos, menuStyle]}>
            <Pressable onPress={() => {}}>
              {(["active", "archived"] as SessionsView[]).map((v, i) => (
                <Pressable
                  key={v}
                  onPress={() => pick(v)}
                  style={({ pressed }) => [
                    styles.row,
                    i === 0 && styles.rowBorder,
                    pressed && { backgroundColor: colors.gray100 },
                  ]}
                >
                  <View style={styles.check}>
                    {view === v && (
                      <SymbolView name="checkmark" size={15} tintColor={colors.violet} />
                    )}
                  </View>
                  <Text style={[styles.rowLabel, view === v && styles.rowLabelOn]}>
                    {LABELS[v]}
                  </Text>
                  {count(v) != null && <Text style={styles.rowCount}>{count(v)}</Text>}
                </Pressable>
              ))}
            </Pressable>
          </Animated.View>
        </Pressable>
      </Modal>
    </>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
  trigger: { flexDirection: "row", alignItems: "center", gap: 5 },
  filterTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 4,
    paddingRight: 6,
  },
  title: { fontSize: 17, fontFamily: fonts.bold, color: c.navy },
  backdrop: { flex: 1 },
  menu: {
    position: "absolute",
    width: 240,
    backgroundColor: c.bg === "#ffffff" ? "rgba(252,252,253,0.98)" : "rgba(35,43,55,0.98)",
    borderRadius: 15,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.22,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    borderWidth: 0.5,
    borderColor: c.border,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  rowBorder: { borderBottomWidth: 0.5, borderBottomColor: c.gray100 },
  check: { width: 18, alignItems: "center" },
  rowLabel: { flex: 1, fontSize: 15, fontFamily: fonts.medium, color: c.charcoal },
  rowLabelOn: { fontFamily: fonts.semibold, color: c.navy },
  rowCount: { fontSize: 13, fontFamily: fonts.semibold, color: c.charcoalSubtle },
  });
}
