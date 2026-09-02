/**
 * FrontierMovedReveal (native) — the calm "⛰ your frontier moved" moment after a
 * scholar CLEARS an above-band challenge round on the iPad. The web twin is
 * components/practice/FrontierMovedReveal.tsx; both name the above-band skills she
 * tested into (via the shared `challengeFrontierMove` trigger — honest "I haven't
 * learned this yet" flags never disqualify).
 *
 * A growth-PORTRAIT line, not a score-flash: no count, no streak, no confetti, no
 * gradient/glow — an even-bordered amber card matching the established re-probe
 * "frontier moved" reveal (native reprobeCard) so the two surfaces read as one
 * idea, at the native practice type scale.
 */

import { StyleSheet, Text, View } from "react-native";

import { fonts, useColors } from "@/theme";
import { superscriptExponents } from "../../../vendor/shared/mathNotation";

export function FrontierMovedReveal({ skills }: { skills: string[] }) {
  const c = useColors();
  if (skills.length === 0) return null;
  const styles = makeStyles(c);
  return (
    <View style={styles.card}>
      <Text style={styles.title}>⛰ Your frontier moved</Text>
      <Text style={styles.body}>You reached past your usual work and showed you&apos;ve got:</Text>
      <View style={styles.skills}>
        {/* Bullet in its own column so a wrapping skill name keeps a hanging
            indent (RN has no list-style; the web twin uses a real <ul>). */}
        {skills.map((label) => (
          <View key={label} style={styles.skillRow}>
            <Text style={[styles.skill, styles.bullet]}>•</Text>
            <Text style={[styles.skill, styles.skillText]}>{superscriptExponents(label)}</Text>
          </View>
        ))}
      </View>
      <Text style={styles.footnote}>Your next practice builds from here.</Text>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    card: {
      width: "100%",
      backgroundColor: c.orangeSubtle,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.orange,
      padding: 16,
      gap: 8,
    },
    title: { fontFamily: fonts.bold, fontSize: 16, color: c.fg },
    body: { fontFamily: fonts.regular, fontSize: 14.5, lineHeight: 21, color: c.fgMuted },
    skills: { gap: 3, paddingLeft: 2 },
    skillRow: { flexDirection: "row", alignItems: "flex-start" },
    skill: { fontFamily: fonts.semibold, fontSize: 15, lineHeight: 22, color: c.fg },
    bullet: { width: 16 },
    skillText: { flex: 1 },
    footnote: { fontFamily: fonts.regular, fontSize: 13, color: c.fgMuted },
  });
}
