/**
 * The SHARED "no-shift feedback" SHELL for a practice item — the centered
 * scrolling stage, the correctness ring + un-rotated corner stamp, the
 * absolutely-anchored under-card note, and the bottom-pinned CTA lane. Every
 * item type wears this same shell so a scholar sees the Done button, the verdict
 * stamp, and the feedback note in the SAME place regardless of whether the item
 * is typed, multiple-choice, or a manipulative.
 *
 * Extracted here (not forked per surface) so the in-playlist practice screen
 * (`app/practice.tsx`) and the manipulative item card
 * (`components/manipulatives/NativeManipulativeItem.tsx`) — which grades itself
 * but must render into the identical shell — can never drift. Sibling to
 * `chatBubbles.ts`: one source of truth for how a graded practice item looks.
 *
 * Returned as plain style objects (NOT `StyleSheet.create`'d) so each screen can
 * spread them straight into its own `StyleSheet.create({ ... })` alongside its
 * screen-specific styles, exactly like `chatBubbleStyles`.
 */
import type { TextStyle, ViewStyle } from "react-native";

import { fonts, type Colors } from "@/theme";

export interface PracticeShellStyles {
  /** The vertically-centered scroll container (flex host + centered content). */
  stageScrollFlex: ViewStyle;
  stageScroll: ViewStyle;
  /** Correctness RING on the stem card (border colour + soft glow, no reflow). */
  stemBoxCorrect: ViewStyle;
  stemBoxMiss: ViewStyle;
  /** The un-rotated corner verdict stamp overhanging the card's top-right. */
  stamp: ViewStyle;
  stampCorrect: ViewStyle;
  stampMiss: ViewStyle;
  stampTextCorrect: TextStyle;
  stampTextMiss: TextStyle;
  /** The feedback note, anchored ABSOLUTELY at the column's bottom (top:100%). */
  noteAnchor: ViewStyle;
  noteBlock: ViewStyle;
  noteMiss: TextStyle;
  /** The bottom-pinned action lane (constant height → the card never moves). */
  ctaLane: ViewStyle;
  /** The primary action button (Done / Next / Finish). */
  primaryBtn: ViewStyle;
  primaryBtnDisabled: ViewStyle;
  primaryBtnText: TextStyle;
  /** The reserved "I haven't learned this yet" skip slot below the CTA (space
   *  held via opacity so hiding it never moves the primary action) + the shared
   *  ghost text-link used for it. Shared so a manipulative item's skip link sits
   *  in the SAME place with the SAME styling as every typed/MC item (U-4 parity). */
  skipSlot: ViewStyle;
  skipSlotHidden: ViewStyle;
  linkBtn: ViewStyle;
  linkBtnText: TextStyle;
}

export function makePracticeShellStyles(c: Colors): PracticeShellStyles {
  return {
    stageScrollFlex: { flex: 1 },
    stageScroll: {
      flexGrow: 1,
      justifyContent: "center",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 12,
    },
    stemBoxCorrect: {
      borderColor: c.green,
      shadowColor: c.green,
      shadowOpacity: 0.3,
      shadowRadius: 9,
      shadowOffset: { width: 0, height: 0 },
    },
    stemBoxMiss: {
      borderColor: c.orange,
      shadowColor: c.orange,
      shadowOpacity: 0.32,
      shadowRadius: 9,
      shadowOffset: { width: 0, height: 0 },
    },
    stamp: {
      position: "absolute",
      top: -12,
      right: -6,
      borderRadius: 999,
      paddingHorizontal: 13,
      paddingVertical: 6,
      shadowColor: "#000",
      shadowOpacity: 0.18,
      shadowRadius: 6,
      shadowOffset: { width: 0, height: 3 },
    },
    stampCorrect: { backgroundColor: c.green },
    stampMiss: { backgroundColor: c.orange },
    stampTextCorrect: { fontFamily: fonts.bold, fontSize: 13, color: c.white },
    stampTextMiss: { fontFamily: fonts.bold, fontSize: 13, color: "#3a2a08" },
    noteAnchor: { position: "absolute", top: "100%", left: 0, right: 0, marginTop: 14 },
    noteBlock: { width: "100%", gap: 8, alignItems: "center" },
    noteMiss: { fontFamily: fonts.regular, fontSize: 14, color: c.orange, textAlign: "center" },
    ctaLane: {
      paddingHorizontal: 16,
      paddingTop: 10,
      paddingBottom: 16,
      gap: 6,
      backgroundColor: c.bgSubtle,
    },
    primaryBtn: {
      minHeight: 52,
      borderRadius: 12,
      backgroundColor: c.navy,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 18,
    },
    primaryBtnDisabled: { opacity: 0.45 },
    primaryBtnText: { fontFamily: fonts.bold, fontSize: 16, color: c.white },
    // Kept byte-identical to app/practice.tsx's local skipSlot/linkBtn so the
    // manipulative card's "I haven't learned this yet" link renders in the exact
    // same place with the exact same styling as the pad items' link.
    skipSlot: { minHeight: 34, alignItems: "center", justifyContent: "center" },
    skipSlotHidden: { opacity: 0 },
    linkBtn: { alignItems: "center", justifyContent: "center", paddingVertical: 8 },
    linkBtnText: { fontFamily: fonts.semibold, fontSize: 14, color: c.violet },
  };
}
