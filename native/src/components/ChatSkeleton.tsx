import { useEffect, useMemo } from "react";
import { Animated, StyleSheet, useAnimatedValue, View } from "react-native";

import { useColors } from "@/theme";

const COLUMN_MAX_WIDTH = 720;

// Placeholder bubbles that mirror the real chat layout (alternating sides,
// varied widths/heights) so the loading→loaded transition doesn't jump and
// there's no spinner pop. A gentle opacity pulse reads as "content arriving,"
// which feels more native-solid than a centered ActivityIndicator.
const ROWS: { mine: boolean; width: `${number}%`; height: number }[] = [
  { mine: true, width: "55%", height: 54 },
  { mine: false, width: "78%", height: 96 },
  { mine: true, width: "44%", height: 44 },
  { mine: false, width: "70%", height: 74 },
  { mine: true, width: "82%", height: 84 },
];

export function ChatSkeleton() {
  const colors = useColors();
  const pulse = useAnimatedValue(0.5);

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 700,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.5,
          duration: 700,
          useNativeDriver: true,
        }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [pulse]);

  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <View style={styles.container}>
      {ROWS.map((r, i) => (
        <View
          key={i}
          style={[styles.row, r.mine ? styles.rowMine : styles.rowTutor]}
        >
          <Animated.View
            style={[
              styles.bubble,
              { width: r.width, height: r.height, opacity: pulse },
            ]}
          />
        </View>
      ))}
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    container: {
      flex: 1,
      width: "100%",
      maxWidth: COLUMN_MAX_WIDTH,
      alignSelf: "center",
      paddingHorizontal: 20,
      paddingVertical: 18,
      gap: 12,
      backgroundColor: c.bgSubtle,
    },
    row: { flexDirection: "row" },
    rowMine: { justifyContent: "flex-end" },
    rowTutor: { justifyContent: "flex-start" },
    bubble: { borderRadius: 22, backgroundColor: c.gray200 },
  });
}
