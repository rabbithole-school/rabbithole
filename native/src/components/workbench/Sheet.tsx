/**
 * The Workbench's native sheet — Deck / Inspector / Notebook / Tutor all present
 * through this one primitive.
 *
 * TWO modes:
 *  · default (overlay): a THIN wrapper over the shared `Drawer` (`@/components/ui`),
 *    so the Workbench sheets move exactly like the sky map (StarDrawer) and tree
 *    map (NodeSheet) — one mechanism, no bespoke variant (DRY). Deck is a bottom
 *    sheet; Tutor/Notebook pass `side="right"`. All are swipe-to-dismiss.
 *  · `docked`: the SAME children rendered INLINE, filling their parent column —
 *    used by the landscape two-column bench (WorkbenchPanel), where the deck,
 *    runs, and history live in a persistent right panel instead of overlays.
 *    `open` toggles visibility (kept mounted so edit/scroll state survives a tab
 *    switch); the tab bar supplies the label, so the heavy title chrome is
 *    dropped for a slim eyebrow line.
 */

import { type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

import { Drawer } from "@/components/ui/Drawer";
import { fonts, useColors } from "@/theme";

export function Sheet({
  open,
  onClose,
  title,
  eyebrow,
  children,
  side,
  heightFraction,
  widthFraction,
  docked,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  eyebrow?: string;
  children: ReactNode;
  side?: "bottom" | "right";
  heightFraction?: number;
  widthFraction?: number;
  docked?: boolean;
}) {
  const colors = useColors();

  if (docked) {
    return (
      <View style={[styles.docked, { display: open ? "flex" : "none" }]}>
        {eyebrow ? (
          <Text style={[styles.dockedEyebrow, { color: colors.fgMuted, borderBottomColor: colors.border }]}>
            {eyebrow}
          </Text>
        ) : null}
        <View style={styles.dockedBody}>{children}</View>
      </View>
    );
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={title}
      eyebrow={eyebrow}
      side={side}
      heightFraction={heightFraction}
      widthFraction={widthFraction}
    >
      {children}
    </Drawer>
  );
}

const styles = StyleSheet.create({
  docked: { flex: 1 },
  dockedBody: { flex: 1 },
  dockedEyebrow: {
    fontFamily: fonts.medium,
    fontSize: 10.5,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
