import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { fonts, useColors } from "@/theme";

import { byThing, type WorldRule } from "./RuleCards";

/**
 * The World tab: every thing in the scholar's app with its rules; a tap opens
 * that thing's own rule card in the app.
 */

export function WorldPanel({
  rules,
  onOpenRule,
}: {
  rules: WorldRule[];
  onOpenRule: (thing: string) => void;
}) {
  const colors = useColors();

  if (!rules.length) {
    return (
      <View style={styles.empty}>
        <Text style={[styles.emptyText, { color: colors.fgMuted }]}>
          Your world’s rules show up here once your app has some.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.grid}>
        {[...byThing(rules)].map(([thing, thingRules]) => (
          <Pressable
            key={thing}
            onPress={() => onOpenRule(thing)}
            accessibilityRole="button"
            accessibilityLabel={`${thing} rules. Opens its card.`}
            style={({ pressed }) => [
              styles.card,
              {
                borderColor: colors.border,
                backgroundColor: colors.white,
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            <Text style={[styles.heading, { color: colors.fg }]} numberOfLines={2}>
              {thing}
            </Text>
            {thingRules.map((rule) => (
              <View key={rule.name} style={styles.row}>
                <Text style={[styles.name, { color: colors.fg }]} numberOfLines={2}>
                  {rule.name}
                </Text>
                <Text style={[styles.value, { color: colors.fg }]} numberOfLines={1}>
                  {rule.value}
                </Text>
                <View
                  style={[
                    styles.pill,
                    rule.by === "scholar"
                      ? { backgroundColor: colors.violetSolid, borderColor: colors.violetSolid }
                      : { borderColor: colors.border },
                  ]}
                >
                  <Text
                    style={[
                      styles.pillText,
                      { color: rule.by === "scholar" ? colors.white : colors.fgMuted },
                    ]}
                  >
                    {rule.by === "scholar" ? "yours" : "I picked this"}
                  </Text>
                </View>
              </View>
            ))}
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 12 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  card: {
    width: "48%",
    flexGrow: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  heading: { fontFamily: fonts.bold, fontSize: 16 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { flex: 1, fontFamily: fonts.regular, fontSize: 15 },
  value: { fontFamily: fonts.semibold, fontSize: 15 },
  pill: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  pillText: { fontFamily: fonts.medium, fontSize: 11 },
  empty: { padding: 24 },
  emptyText: { fontFamily: fonts.regular, fontSize: 15 },
});
