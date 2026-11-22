import { Pressable, StyleSheet, Text, View } from "react-native";

import { fonts, useColors } from "@/theme";

/**
 * The builder drawer's tabs, in its header row beside the mission title:
 * Chat, Flair, World, Saved for later. A quiet violet tint marks the open tab; a small dot marks
 * a tab with something new in it.
 */
export type DrawerTabId = "chat" | "flair" | "world" | "saved";

export type DrawerTab = { id: DrawerTabId; label: string; dot?: boolean };

export function DrawerTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: DrawerTab[];
  active: DrawerTabId;
  onChange: (id: DrawerTabId) => void;
}) {
  const colors = useColors();
  if (tabs.length < 2) return null;
  return (
    <View style={styles.row} accessibilityRole="tablist">
      {tabs.map((tab) => {
        const on = tab.id === active;
        return (
          <Pressable
            key={tab.id}
            onPress={() => onChange(tab.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={tab.dot ? `${tab.label}, new` : tab.label}
            hitSlop={4}
            style={({ pressed }) => [
              styles.tab,
              on ? { backgroundColor: colors.violetSubtle } : null,
              { opacity: pressed ? 0.7 : 1 },
            ]}
          >
            <Text style={[styles.label, { color: on ? colors.violetSolid : colors.fgMuted }]}>
              {tab.label}
            </Text>
            {tab.dot && !on ? (
              <View style={[styles.dot, { backgroundColor: colors.violetSolid }]} />
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 2 },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 34,
    paddingHorizontal: 16,
    borderRadius: 17,
  },
  label: { fontFamily: fonts.semibold, fontSize: 15 },
  dot: { width: 7, height: 7, borderRadius: 4 },
});
