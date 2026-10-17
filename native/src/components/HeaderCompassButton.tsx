import { Pressable, StyleSheet, View } from "react-native";
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

/** The session header's compass item (stable identity, see above). */
export function compassHeaderRight() {
  return <HeaderCompassButton onPress={() => compassPress?.()} />;
}

const styles = StyleSheet.create({
  wrap: { flexDirection: "row", alignItems: "center", gap: 16 },
});
