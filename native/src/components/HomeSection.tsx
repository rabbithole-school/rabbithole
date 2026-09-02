import { useMemo, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

import { fonts, useColors } from "@/theme";
import { HOME_GAP, HOME_LABEL_GAP, HOME_SECTION_TOPUP } from "@/lib/homeRhythm";

/**
 * HomeSection — an eyebrow label + the card(s) it introduces, as ONE block.
 *
 * Every labeled group on the scholar Home renders through this, so there is a
 * single canonical rendering of "a section" (CLASS FOCUS, DUE TODAY, TODAY,
 * WELCOME, SOMETHING NEW, and the live timetable block) instead of each card
 * hand-rolling a <Text> plus its own spacing.
 *
 * Why a card OWNS its heading rather than the parent wrapping it: nearly every
 * Home card self-gates to `null` on its own data. If the parent rendered the
 * heading, the heading would outlive its card and leave a label pointing at
 * nothing. Keeping the two in one component makes the gating atomic by
 * construction — no card, no heading, no gap.
 *
 * Spacing: the section inherits HOME_GAP from the stack that owns it and tops
 * that up to HOME_SECTION_GAP; the heading→body step is HOME_LABEL_GAP, and the
 * body's own children fall back to the card rhythm. Callers should not add
 * margins on either side. See lib/homeRhythm.ts.
 */
export function HomeSection({
  label,
  detail,
  tint,
  trailing,
  hidden,
  children,
}: {
  label: string;
  /** Subordinate context under the label, e.g. "until 9:40 · with Ms. Rivera". */
  detail?: string | null;
  /** Label colour. Defaults to the muted charcoal used by CLASS FOCUS. */
  tint?: string;
  /** Optional control rendered opposite the label (e.g. a "see all" link). */
  trailing?: ReactNode;
  /**
   * Render `children` bare — no heading, no section top-up. For cards that take
   * an OPTIONAL eyebrow: without one they are an ordinary sibling in the stack
   * and must not claim a section's extra space.
   */
  hidden?: boolean;
  children: ReactNode;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  if (hidden) return <>{children}</>;
  return (
    <View style={styles.section}>
      <HomeSectionHead
        label={label}
        detail={detail}
        tint={tint}
        trailing={trailing}
      />
      <View style={styles.body}>{children}</View>
    </View>
  );
}

/**
 * The heading half of a section — the eyebrow, its optional detail line, and an
 * optional trailing control. Split out so the SectionList's own section headers
 * (separate list CELLS, which therefore cannot wrap their children) render the
 * identical label as the in-stack <HomeSection>s.
 */
export function HomeSectionHead({
  label,
  detail,
  icon,
  tint,
  trailing,
}: {
  label: string;
  detail?: string | null;
  icon?: ReactNode;
  tint?: string;
  trailing?: ReactNode;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.head}>
      <View style={styles.headText}>
        <View style={styles.labelRow}>
          {icon ? (
            <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              {icon}
            </View>
          ) : null}
          <Text style={[styles.label, { color: tint ?? colors.charcoalMuted }]}>
            {label.toUpperCase()}
          </Text>
        </View>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      </View>
      {trailing}
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    section: { paddingTop: HOME_SECTION_TOPUP, gap: HOME_LABEL_GAP },
    // The section's own children are ordinary sibling cards, so they get the
    // card rhythm — only the heading→body step is HOME_LABEL_GAP.
    body: { gap: HOME_GAP },
    head: {
      marginLeft: 4,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    headText: { flexShrink: 1, gap: 3 },
    labelRow: { flexDirection: "row", alignItems: "center", gap: 8 },
    label: { fontSize: 12.5, letterSpacing: 1.2, fontFamily: fonts.bold },
    detail: {
      fontSize: 13,
      fontFamily: fonts.medium,
      color: c.charcoalMuted,
    },
  });
}
