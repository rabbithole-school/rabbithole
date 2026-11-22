/**
 * The algebra pad's two text-based key faces, which need the app's own fonts
 * (the italic and semibold Hanken Grotesk faces). The shape faces — fraction,
 * power, square root, n-th root — come from the keypad package's Glyphs.tsx
 * (vendored), which carries no theme.
 */

import { StyleSheet, Text, View } from "react-native";

import { fonts } from "@/theme";

/** `x²`: an italic x with its small raised 2 — the shortcut it types. */
export function GlyphSquare({ color }: { color: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
      <Text style={{ fontFamily: fonts.italic, fontSize: 22, lineHeight: 28, color }}>x</Text>
      <Text style={{ fontFamily: fonts.semibold, fontSize: 13, lineHeight: 16, color, marginLeft: 1 }}>2</Text>
    </View>
  );
}

/** `log` with an empty box lowered as its base. */
export function GlyphLog({ color }: { color: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
      <Text style={{ fontFamily: fonts.semibold, fontSize: 19, lineHeight: 26, color }}>log</Text>
      <View style={[styles.baseBox, { borderColor: color }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  // The package's mini box (Glyphs.tsx), a size smaller, lowered as a base.
  baseBox: { width: 10, height: 9, borderWidth: 1.5, borderRadius: 3, marginTop: 14, marginLeft: 1 },
});
