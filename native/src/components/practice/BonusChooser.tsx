/**
 * BonusChooser (native) — the single "Keep going?" done-screen bonus set
 * (raise-the-ceiling plan §C-3, "shorter mandatory core + bonus sets"). The
 * web twin is components/practice/BonusChooser.tsx; both replace THREE
 * separately-stacked offer blocks (challenge / more-of-your-pick / tune-up)
 * with ONE bordered chooser presenting up to three tappable bonus cards —
 * each card IS the accept action (tap it, you're in; there's no separate
 * decline button). Skipping the chooser entirely is always fine: the done
 * screen's calm summary/closure is the default path, and "Done" / "Practice
 * again" below it are unaffected.
 *
 * Re-probe ("you're on a roll, jump ahead?") is NOT one of these cards — it's
 * an EARNED offer (the engine detected a likely under-placement), not a bonus
 * a scholar opts into for its own sake, so it keeps its own distinct slot
 * ABOVE this chooser (see practice.tsx).
 *
 * No scores, no streak framing, no pressure copy — matches the scholar-facing
 * lexicon in review/practice/completion-messaging-plan.html and the tune-up /
 * challenge / reprobe cards' existing tone. Even borders on every card
 * (visual-design.md — no edge-only accent stripes); each card gets its own
 * soft, distinct tint so they read as different offers without a left-border
 * stripe trick.
 */

import { Pressable, StyleSheet, Text, View } from "react-native";

import { fonts, useColors } from "@/theme";

export type BonusCardSpec = {
  /** Stable key AND the a11y-visible identity of the card. */
  key: string;
  title: string;
  body: string;
  onAccept: () => void;
  acceptLabel?: string;
  disabled?: boolean;
  /** Soft background/border/text triple — each bonus kind gets its own quiet
   *  tint (mirrors the standalone cards' prior colors: amber for challenge,
   *  green for tune-up, violet for more-of-your-pick). */
  tone: { bg: string; border: string; text: string };
};

export function BonusChooser({ cards }: { cards: BonusCardSpec[] }) {
  const c = useColors();
  const styles = makeStyles(c);
  if (cards.length === 0) return null;
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>Keep going?</Text>
      {/* ONE surface, hairline-separated rows — not filled boxes inside a box
          (visual-design.md: "keep a single outer Surface … remove the INNER
          filled boxes"). Read worst at a single card, where the tint
          distinguished the row from nothing. Each kind keeps its identity hue
          on its title + action instead of as a fill. Mirrors the web twin. */}
      <View style={styles.rows}>
        {cards.map((card, i) => (
          <Pressable
            key={card.key}
            onPress={card.onAccept}
            disabled={card.disabled}
            style={({ pressed }) => [
              styles.row,
              i > 0 && { borderTopWidth: 1, borderTopColor: c.border },
              pressed && !card.disabled && { opacity: 0.6 },
            ]}
            accessibilityRole="button"
          >
            <View style={styles.rowText}>
              <Text style={[styles.rowTitle, { color: card.tone.text }]}>{card.title}</Text>
              <Text style={[styles.rowBody, { color: c.fgMuted }]}>{card.body}</Text>
            </View>
            <Text style={[styles.rowCta, { color: card.tone.text }]}>
              {card.disabled ? "…" : (card.acceptLabel ?? "Let's go")}
              {"  →"}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    card: {
      width: "100%",
      backgroundColor: c.bg,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.border,
      padding: 16,
      gap: 12,
    },
    heading: { fontFamily: fonts.bold, fontSize: 16, color: c.fg },
    rows: { gap: 0 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: 12,
      gap: 10,
    },
    rowText: { flex: 1, gap: 2 },
    rowTitle: { fontFamily: fonts.bold, fontSize: 14 },
    rowBody: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 20.8 },
    rowCta: { fontFamily: fonts.bold, fontSize: 13, flexShrink: 0 },
  });
}
