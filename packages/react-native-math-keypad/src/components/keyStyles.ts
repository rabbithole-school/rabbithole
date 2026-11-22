import { StyleSheet } from "react-native";

import type { MathKeypadTheme } from "../theme";

/**
 * Key and field geometry from Rabbithole's practice screen (native/src/app/
 * practice.tsx), where it was passed down as a `styles` prop. Sized for an
 * 11-inch iPad in landscape: 58pt-tall keys in a three-column grid (each
 * 31.5% wide), 10pt gaps, 12pt corner radius — big, forgiving targets for
 * children's fingers, roomy enough that a mis-tap on a neighbour is rare.
 */
export function makeKeyStyles(theme: MathKeypadTheme) {
  const c = theme.colors;
  return StyleSheet.create({
    padWrap: { width: "100%", gap: 10 },
    padGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "space-between",
      rowGap: 10,
    },
    padKey: {
      width: "31.5%",
      height: 58,
      borderRadius: 12,
      backgroundColor: c.keyBackground,
      borderWidth: 1,
      borderColor: c.keyBorder,
      alignItems: "center",
      justifyContent: "center",
    },
    padKeyHidden: { opacity: 0, borderWidth: 0, backgroundColor: "transparent" },
    padKeyPressed: { backgroundColor: c.keyPressed, transform: [{ scale: 0.96 }] },
    padKeyText: {
      fontFamily: theme.fonts.key,
      fontWeight: theme.fonts.key ? undefined : "600",
      fontSize: 22,
      color: c.keyText,
    },
    padWide: {
      height: 50,
      borderRadius: 12,
      backgroundColor: c.keyBackground,
      borderWidth: 1,
      borderColor: c.keyBorder,
      alignItems: "center",
      justifyContent: "center",
    },
    glyphGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      justifyContent: "space-between",
    },
    glyphKey: { width: "48%" },
    keyboardHint: {
      color: c.hint,
      fontFamily: theme.fonts.hint,
      fontSize: 14,
      textAlign: "center",
      paddingVertical: 4,
    },
    inputBox: {
      minHeight: 56,
      borderWidth: 2,
      borderColor: c.accent,
      borderRadius: 12,
      backgroundColor: c.accentSubtle,
      paddingHorizontal: 16,
      paddingVertical: 10,
      alignItems: "center",
      justifyContent: "center",
    },
    inputText: {
      fontFamily: theme.fonts.editor,
      fontWeight: theme.fonts.editor ? undefined : "700",
      fontSize: 26,
      color: c.keyText,
    },
  });
}

export type KeyStyles = ReturnType<typeof makeKeyStyles>;
