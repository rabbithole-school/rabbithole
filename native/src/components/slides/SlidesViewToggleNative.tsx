import { Pressable, StyleSheet, Text, View } from "react-native";

import { fonts, useColors } from "@/theme";

export type SlidesViewMode = "grid" | "slide";

export function SlidesViewToggleNative({
  value,
  onChange,
}: {
  value: SlidesViewMode;
  onChange: (value: SlidesViewMode) => void;
}) {
  const colors = useColors();

  return (
    <View style={[styles.root, { backgroundColor: colors.bgSubtle }]}>
      {(["grid", "slide"] as const).map((mode) => {
        const selected = value === mode;
        return (
          <Pressable
            key={mode}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => onChange(mode)}
            style={[
              styles.option,
              selected && { backgroundColor: colors.bg },
            ]}
          >
            <Text
              style={{
                color: selected ? colors.fg : colors.fgMuted,
                fontFamily: fonts.medium,
                fontSize: 15,
              }}
            >
              {mode === "grid" ? "Grid" : "Slide"}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection: "row",
    borderRadius: 12,
    padding: 3,
  },
  option: {
    minWidth: 68,
    minHeight: 34,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
});
