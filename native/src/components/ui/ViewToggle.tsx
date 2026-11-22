import { Pressable, StyleSheet, Text, View } from "react-native";

import { fonts, useColors, type Colors } from "@/theme";

/**
 * A lens or view toggle: the same content shown a different way, one option
 * on at a time. The native twin of the web's components/ui/ViewToggle.tsx:
 * a rounded track with the chosen option as a raised pill. `colors` forces a
 * color set, for a screen that is always dark whatever the system setting.
 */
export function ViewToggle<T extends string>({
  options,
  value,
  onChange,
  colors: forced,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  colors?: Colors;
}) {
  const system = useColors();
  const colors = forced ?? system;
  return (
    <View accessibilityRole="tablist" style={[styles.track, { backgroundColor: colors.bgSubtle }]}>
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(option.value)}
            style={[styles.option, selected && { backgroundColor: colors.bg }]}
          >
            <Text
              style={[
                styles.label,
                { color: selected ? colors.fg : colors.fgMuted, fontFamily: fonts.medium },
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: "row", borderRadius: 12, padding: 3 },
  option: {
    minWidth: 68,
    minHeight: 34,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  label: { fontSize: 15 },
});
