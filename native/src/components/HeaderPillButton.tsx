import { ActivityIndicator, Pressable, StyleSheet, Text } from "react-native";
import { SymbolView, type SymbolViewProps } from "expo-symbols";

import { fonts, useColors } from "@/theme";

/**
 * The icon for handing work to the teacher: the app builder's Send to teacher
 * and homework's "I'm done with this" both tell the teacher "this is ready to
 * look at", so they share one glyph.
 */
export const TEACHER_HANDOFF_ICON: SymbolViewProps["name"] = "paperplane";

/**
 * The navigation header's action pill: an SF Symbol and a short label in its
 * own rounded pill. One component so every header action reads the same —
 * the app builder's Send to teacher, Code, History and Chat, and a homework
 * session's "I'm done with this".
 *
 * On iOS 26 render it as a `unstable_headerRightItems` custom item with
 * `hidesSharedBackground: true`: the system's shared Liquid Glass capsule
 * otherwise merges neighbouring items into what reads as one button, and this
 * pill draws its own background instead.
 */
export function HeaderPillButton({
  icon,
  label,
  onPress,
  disabled = false,
  selected,
  busy = false,
  accessibilityLabel,
  testID,
}: {
  icon: SymbolViewProps["name"];
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** A toggle's on state: a filled pill. Leave undefined for a plain button. */
  selected?: boolean;
  /** Work in flight: a spinner stands in for the icon. */
  busy?: boolean;
  /** Defaults to `label`. */
  accessibilityLabel?: string;
  testID?: string;
}) {
  const colors = useColors();
  const tint = selected ? colors.white : colors.violet;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={
        selected === undefined ? { disabled } : { disabled, selected }
      }
      testID={testID}
      style={[
        styles.pill,
        selected
          ? { backgroundColor: colors.violetSolid, borderColor: colors.violetSolid }
          : null,
        disabled ? styles.disabled : null,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={tint} />
      ) : (
        <SymbolView name={icon} size={16} tintColor={tint} />
      )}
      <Text style={[styles.label, { color: tint }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    height: 34,
    borderRadius: 17,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(31,36,66,0.14)",
    backgroundColor: "rgba(255,255,255,0.9)",
  },
  disabled: { opacity: 0.4 },
  label: { fontFamily: fonts.semibold, fontSize: 13 },
});
