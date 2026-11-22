import { Fragment, type ReactElement } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type {
  NativeStackHeaderItem,
  NativeStackHeaderItemCustom,
} from "expo-router";
import { SymbolView } from "expo-symbols";

import { useColors } from "@/theme";

/**
 * The session header's "Where you are in this unit" compass. One component so
 * the route's first frame, the loading view and the live screen draw the SAME
 * header item: iPadOS 26 animates a Liquid Glass bar button in when it is
 * inserted or replaced, which read as the compass jumping on every ← / →.
 * Without `onPress` it is an inert stand-in.
 */
export function HeaderCompassButton({ onPress }: { onPress?: () => void }) {
  const colors = useColors();
  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={onPress}
        disabled={!onPress}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Where you are in this unit"
      >
        <SymbolView name="location.circle" size={27} tintColor={colors.violet} />
      </Pressable>
    </View>
  );
}

// The header item is ONE module-level function, so its identity never
// changes as sessions swap in place; whichever session is showing registers
// what a tap opens.
let compassPress: (() => void) | null = null;

/** Register the showing session's handler; returns the unregister. */
export function setCompassHandler(fn: () => void): () => void {
  compassPress = fn;
  return () => {
    if (compassPress === fn) compassPress = null;
  };
}

// One compass element for every screen that shows it. It is always the LAST
// right item, which iOS draws first (react-navigation reverses the list), so
// it keeps the same native slot whether or not an action pill sits beside it.
const COMPASS_ITEM: NativeStackHeaderItemCustom = {
  type: "custom",
  element: <HeaderCompassButton onPress={() => compassPress?.()} />,
};

/**
 * The session header's right items: the compass alone (stable identity, see
 * above). Every screen that draws the compass uses header ITEMS, never
 * `headerRight` — on iOS items win over `headerRight`, and switching between
 * the two remounts the compass, the jump this file exists to prevent.
 */
export function compassHeaderItems(): NativeStackHeaderItem[] {
  return [COMPASS_ITEM];
}

/**
 * The compass with action pills to its left (HeaderPillButtons), in the order
 * given: one, or two when a Quest is also homework (TRA-720). The pills hide
 * iOS 26's shared Liquid Glass background and draw their own, as the app
 * builder's header pills do; sharing it merged them into what read as one
 * button. A fresh function per render is fine: react-navigation keys right
 * items by index, and the compass stays at index 0 after its reversal, so new
 * options re-render the items in place rather than remounting the compass.
 */
export function compassHeaderItemsWith(
  ...actions: ReactElement[]
): () => NativeStackHeaderItem[] {
  const element =
    actions.length === 1 ? (
      actions[0]
    ) : (
      <View style={styles.actions}>
        {actions.map((action, index) => (
          <Fragment key={index}>{action}</Fragment>
        ))}
      </View>
    );
  return () => [
    { type: "custom", hidesSharedBackground: true, element },
    COMPASS_ITEM,
  ];
}

const styles = StyleSheet.create({
  wrap: { flexDirection: "row", alignItems: "center", gap: 16 },
  // The app builder's header spacing (VibecodeScreen styles.headerRight).
  actions: { flexDirection: "row", alignItems: "center", gap: 10 },
});
