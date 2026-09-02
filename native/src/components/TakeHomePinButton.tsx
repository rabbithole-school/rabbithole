import { Pressable, StyleSheet, Text } from "react-native";

import { BookmarkSimpleIcon } from "@/components/BookmarkSimpleIcon";
import { fonts, useColors } from "@/theme";

export function TakeHomePinButton({
  selected,
  busy = false,
  onToggle,
  subject,
}: {
  selected: boolean;
  busy?: boolean;
  onToggle: () => void | Promise<unknown>;
  subject: string;
}) {
  const colors = useColors();
  const label = selected ? "Added" : "Add";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected, disabled: busy }}
      accessibilityLabel={`${selected ? "Remove" : "Add"} ${subject} ${selected ? "from" : "to"} take-home list`}
      disabled={busy}
      onPress={onToggle}
      style={({ pressed }) => [
        styles.button,
        {
          borderColor: colors.violet,
          backgroundColor: selected ? colors.violetSubtle : "transparent",
        },
        pressed && { backgroundColor: colors.violetMuted },
        busy && styles.busy,
      ]}
    >
      <BookmarkSimpleIcon size={19} color={colors.violet} filled={selected} />
      <Text style={[styles.label, { color: colors.violet }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minWidth: 88,
    minHeight: 44,
    paddingHorizontal: 6,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    borderRadius: 9,
    borderWidth: 1,
  },
  label: { fontFamily: fonts.semibold, fontSize: 13 },
  busy: { opacity: 0.55 },
});
