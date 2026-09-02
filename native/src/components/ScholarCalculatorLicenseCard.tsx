import { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Image } from "expo-image";
import { router, useFocusEffect } from "expo-router";
import * as Haptics from "expo-haptics";
import { useQuery } from "convex/react";

import { api } from "@/lib/convex";
import { fonts, useColors, type Colors } from "@/theme";
import {
  calculatorLicenseCardPresentation,
  type CalculatorLicenseChipTone,
} from "../../vendor/shared/calculatorLicense";
import {
  automaticityLabel,
  type AutomaticityState,
} from "../../vendor/shared/masteryLexicon";
import {
  dialHollowFill,
  MASTERY_DOT_COLOR,
} from "../../vendor/shared/masteryDialPalette";

type FactOp = "add" | "sub" | "mul";
type FastMathFact = {
  factKey: string;
  op: FactOp;
  a: number;
  b: number;
  label: string;
  state: AutomaticityState;
  seenCount?: number;
  correctCount?: number;
};

const OP_ORDER: FactOp[] = ["mul", "add", "sub"];
const OP_LABEL: Record<FactOp, string> = {
  mul: "Multiplication",
  add: "Addition",
  sub: "Subtraction",
};
const OP_GLYPH: Record<FactOp, string> = {
  mul: "×",
  add: "+",
  sub: "−",
};
const FACT_GLYPH: Partial<Record<AutomaticityState, string>> = {
  effortful: "•",
  fluent: "✓",
  automatic: "✦",
};

function MiniFactGrid({
  facts,
  styles,
}: {
  facts: FastMathFact[];
  styles: ReturnType<typeof makeStyles>;
}) {
  const defaultOp = useMemo(
    () =>
      OP_ORDER.reduce((best, candidate) => {
        const bestTouched = facts.filter(
          (fact) => fact.op === best && fact.state !== "unseen",
        ).length;
        const candidateTouched = facts.filter(
          (fact) => fact.op === candidate && fact.state !== "unseen",
        ).length;
        return candidateTouched > bestTouched ? candidate : best;
      }, OP_ORDER[0]),
    [facts],
  );
  const [selectedOp, setSelectedOp] = useState<FactOp | null>(null);
  const [selectedFact, setSelectedFact] = useState<FastMathFact | null>(null);
  const activeOp = selectedOp ?? defaultOp;
  const opFacts = useMemo(
    () => facts.filter((fact) => fact.op === activeOp),
    [activeOp, facts],
  );
  const byCoordinate = useMemo(
    () => new Map(opFacts.map((fact) => [`${fact.a}:${fact.b}`, fact])),
    [opFacts],
  );
  const maxOperand = opFacts.reduce(
    (max, fact) => Math.max(max, fact.a, fact.b),
    0,
  );
  const operands = Array.from({ length: maxOperand + 1 }, (_, index) => index);

  return (
    <View style={styles.factMap} accessibilityLabel="Your fast math facts">
      <View style={styles.factOperationRow}>
        {OP_ORDER.map((op) => {
          const selected = op === activeOp;
          return (
            <Pressable
              key={op}
              onPress={() => {
                setSelectedOp(op);
                setSelectedFact(null);
              }}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              style={[
                styles.factOperation,
                selected
                  ? styles.factOperationSelected
                  : styles.factOperationUnselected,
              ]}
            >
              <Text
                style={[
                  styles.factOperationText,
                  selected
                    ? styles.factOperationTextSelected
                    : styles.factOperationTextUnselected,
                ]}
              >
                {OP_LABEL[op]}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <View style={styles.factGrid}>
          <View style={styles.factGridRow}>
            <Text style={styles.factAxis}>{OP_GLYPH[activeOp]}</Text>
            {operands.map((operand) => (
              <Text key={operand} style={styles.factAxis}>
                {operand}
              </Text>
            ))}
          </View>
          {operands.map((row) => (
            <View key={row} style={styles.factGridRow}>
              <Text style={styles.factAxis}>{row}</Text>
              {operands.map((column) => {
                const fact = byCoordinate.get(`${row}:${column}`);
                if (!fact) {
                  return <View key={column} style={styles.factCellSlot} />;
                }
                const label = `${fact.label} — ${automaticityLabel(fact.state)}${
                  (fact.seenCount ?? 0) > 0
                    ? `, ${fact.correctCount ?? 0} of ${fact.seenCount} correct`
                    : ""
                }`;
                return (
                  <Pressable
                    key={column}
                    onPress={() => setSelectedFact(fact)}
                    accessibilityRole="button"
                    accessibilityLabel={label}
                    accessibilityHint="Shows this fact below the grid"
                    style={styles.factCellSlot}
                  >
                    <View
                      style={[
                        styles.factCell,
                        fact.state === "automatic" && styles.factAutomatic,
                        fact.state === "fluent" && styles.factFluent,
                        fact.state === "practicing" && styles.factPracticing,
                        fact.state === "effortful" && styles.factEffortful,
                        fact.state === "unseen" && styles.factUnseen,
                      ]}
                    >
                      {FACT_GLYPH[fact.state] ? (
                        <Text
                          style={[
                            styles.factGlyph,
                            fact.state === "effortful"
                              ? styles.factGlyphDark
                              : styles.factGlyphLight,
                          ]}
                        >
                          {FACT_GLYPH[fact.state]}
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>
      </ScrollView>
      <Text style={styles.factSelection} accessibilityLiveRegion="polite">
        {selectedFact
          ? `${selectedFact.label} — ${automaticityLabel(selectedFact.state)}`
          : "Tap a square to see the fact."}
      </Text>
    </View>
  );
}

/**
 * ScholarCalculatorLicenseCard (native) — the RN twin of
 * components/practice/ScholarCalculatorLicenseCard.tsx, mounted on the scholar
 * Home's Math tab beside the practice playlist.
 *
 * ONE paper card in every state, with the same fixed slot order as web so the
 * two surfaces can only differ in pixels, never in grammar:
 *   Fast math eyebrow · license chip
 *   Calculator license                (constant title)
 *   68% · 284 of 418 facts automatic   (the scholar's OWN reading)
 *   16px per-fact automaticity map
 *   a short contextual explanation
 *   "Your own practice progress"      (the self-reference cue)
 *   Issued / Proctor                  (only while the credential is durable)
 *   Practice fast math              (bottom slot, always in the same spot)
 *
 * The state → words mapping lives in shared/calculatorLicense.ts (vendored), so
 * the states can only change the message and the chip — never the frame, the
 * alignment, the action's weight, or which slots exist. Gone with it: the old
 * invitation shell, the dark credential card, and the centered "ready" variant,
 * which made a licensed scholar's card a different object from a practicing
 * scholar's.
 *
 * What this surface refuses to be: a score, a threshold, a peer comparison, a
 * streak, a red "behind" state, or an in-app version of the Calculator License
 * Test. The test is offline and teacher-proctored. Badge art stays a small
 * decorative celebration next to the title — never a second credential UI.
 */

function formatIssuedDate(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(value);
}

function StatusChip({
  label,
  tone,
  styles,
}: {
  label: string;
  tone: CalculatorLicenseChipTone;
  styles: ReturnType<typeof makeStyles>;
}) {
  const on = tone === "on";
  return (
    <View style={[styles.chip, on ? styles.chipOn : styles.chipNeutral]}>
      <Text style={[styles.chipText, on ? styles.chipTextOn : styles.chipTextNeutral]}>
        {label}
      </Text>
    </View>
  );
}

function CredentialField({
  label,
  value,
  styles,
}: {
  label: string;
  value: string;
  styles: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label.toUpperCase()}</Text>
      <Text style={styles.fieldValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

/** Celebration art only, and only once there is a credential to celebrate. */
function BadgeMark({
  badge,
  styles,
}: {
  badge: { imageUrl: string | null; artStatus: string; icon: string };
  styles: ReturnType<typeof makeStyles>;
}) {
  const generating = badge.artStatus === "generating";
  return (
    <View
      style={styles.badgeMark}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
    >
      {badge.imageUrl ? (
        <Image
          source={{ uri: badge.imageUrl }}
          style={styles.badgeImage}
          contentFit="contain"
          alt=""
        />
      ) : generating ? (
        <ActivityIndicator size="small" />
      ) : (
        <Text style={styles.badgeEmoji}>{badge.icon}</Text>
      )}
    </View>
  );
}

export function ScholarCalculatorLicenseCard() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const status = useQuery(api.calculatorLicenses.myLicenseStatus, {});
  // Busy is BUTTON-LOCAL: a tap never becomes a new card state, and it never
  // says anything about the offline, teacher-proctored test.
  const [starting, setStarting] = useState(false);
  // Home stays mounted under /practice on native, so the button has to stop
  // saying "starting" when the scholar comes back. Still button-local: the
  // card's state, chip, and words never depended on this flag.
  useFocusEffect(
    useCallback(() => {
      setStarting(false);
    }, []),
  );

  // Loading (undefined) and "not a scholar" (null) both render nothing rather
  // than guessing a license chip that could flip a moment later.
  if (status === undefined || status === null) return null;

  const card = calculatorLicenseCardPresentation({
    license: status.license
      ? {
          issuedAt: status.license.issuedAt,
          issuedByName: status.license.issuedByName,
        }
      : null,
    fastMath: status.fastMath,
  });
  const badge = status.license?.badge ?? null;

  const openQuickFacts = () => {
    if (starting) return;
    setStarting(true);
    Haptics.selectionAsync().catch(() => {});
    // The dedicated Quick-facts run, not an ordinary practice session — the
    // same entry the web card's href requests.
    router.push({ pathname: "/practice", params: { quickFacts: "1" } });
  };

  return (
    // Deliberately NOT `accessible` at the root: collapsing the card into one
    // element would hide the action below from VoiceOver.
    <View style={styles.card}>
      <View style={styles.headRow}>
        <Text style={styles.eyebrow}>{card.eyebrow}</Text>
        <StatusChip label={card.chip.label} tone={card.chip.tone} styles={styles} />
      </View>

      <View style={styles.titleRow}>
        {badge ? <BadgeMark badge={badge} styles={styles} /> : null}
        <Text style={styles.title} accessibilityRole="header">
          {card.title}
        </Text>
      </View>

      <View style={styles.statusRow}>
        <Text style={styles.statusValue}>{card.status.value}</Text>
        <Text style={styles.statusDetail}>{card.status.detail}</Text>
      </View>

      {status.fastMath.facts?.length ? (
        <MiniFactGrid facts={status.fastMath.facts} styles={styles} />
      ) : null}

      <Text style={styles.body}>{card.body}</Text>

      <Text style={styles.cue}>{card.cue}</Text>

      {card.showCredentialFields && status.license ? (
        <View style={styles.fields}>
          <CredentialField
            label="Issued"
            value={formatIssuedDate(status.license.issuedAt)}
            styles={styles}
          />
          {status.license.issuedByName ? (
            <CredentialField
              label="Proctor"
              value={status.license.issuedByName}
              styles={styles}
            />
          ) : null}
        </View>
      ) : null}

      <Pressable
        onPress={openQuickFacts}
        disabled={starting}
        accessibilityRole="button"
        accessibilityLabel={card.action.label}
        accessibilityState={{ disabled: starting, busy: starting }}
        hitSlop={8}
        style={({ pressed }) => [
          styles.ctaWrap,
          pressed && !starting && styles.ctaPressed,
        ]}
      >
        <View style={styles.cta}>
          {starting ? (
            <ActivityIndicator size="small" color={colors.teal} />
          ) : null}
          <Text style={styles.ctaText}>
            {starting ? card.action.busyLabel : card.action.label}
          </Text>
        </View>
      </Pressable>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    // One paper frame in EVERY state — left-aligned, same borders, same place
    // on the Math tab. Matches the playlist card it sits beside.
    card: {
      backgroundColor: c.bg,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: 14,
      paddingVertical: 14,
      gap: 8,
      alignItems: "stretch",
    },
    headRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 12,
    },
    // Same size and tracking as the sibling "Today's Math Playlists" strip
    // title (PracticePlaylistCard) — these two card headers sit one above the
    // other on the Math tab and read as one family.
    eyebrow: {
      flexShrink: 1,
      fontFamily: fonts.bold,
      fontSize: 12,
      letterSpacing: 0.3,
      color: c.charcoalMuted,
    },
    chip: {
      flexShrink: 0,
      borderRadius: 999,
      borderWidth: 1,
      paddingHorizontal: 9,
      paddingVertical: 3,
    },
    chipOn: { borderColor: c.teal, backgroundColor: c.cyanSubtle },
    chipNeutral: { borderColor: c.border, backgroundColor: c.gray50 },
    chipText: { fontFamily: fonts.bold, fontSize: 11.5, lineHeight: 16 },
    chipTextOn: { color: c.teal },
    chipTextNeutral: { color: c.charcoalMuted },
    titleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    badgeMark: {
      width: 36,
      height: 36,
      flexShrink: 0,
      borderRadius: 18,
      overflow: "hidden",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.gray50,
    },
    badgeImage: { width: 36, height: 36 },
    badgeEmoji: { fontSize: 20, lineHeight: 26 },
    title: {
      flexShrink: 1,
      fontFamily: fonts.bold,
      fontSize: 19,
      lineHeight: 24,
      color: c.navy,
    },
    // The scholar's own reading — a self-relative number, never a score and
    // never a threshold, so it gets no bar, no tint, and no comparison.
    statusRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "baseline",
      gap: 8,
    },
    statusValue: {
      fontFamily: fonts.bold,
      fontSize: 26,
      lineHeight: 30,
      color: c.navy,
    },
    statusDetail: {
      flexShrink: 1,
      fontFamily: fonts.regular,
      fontSize: 13,
      lineHeight: 18,
      color: c.charcoalMuted,
    },
    factMap: {
      gap: 7,
      alignItems: "stretch",
    },
    factOperationRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 6,
    },
    factOperation: {
      minHeight: 36,
      justifyContent: "center",
      borderRadius: 8,
      borderWidth: 1,
      paddingHorizontal: 9,
      paddingVertical: 5,
    },
    factOperationSelected: {
      backgroundColor: c.charcoal,
      borderColor: c.charcoal,
    },
    factOperationUnselected: {
      backgroundColor: c.gray50,
      borderColor: c.border,
    },
    factOperationText: {
      fontFamily: fonts.bold,
      fontSize: 13,
      lineHeight: 18,
    },
    factOperationTextSelected: { color: c.white },
    factOperationTextUnselected: { color: c.charcoalMuted },
    factGrid: {
      gap: 2,
      paddingBottom: 2,
    },
    factGridRow: {
      flexDirection: "row",
      gap: 2,
      minHeight: 18,
      alignItems: "center",
    },
    factAxis: {
      width: 18,
      fontFamily: fonts.bold,
      fontSize: 8,
      lineHeight: 12,
      textAlign: "center",
      color: c.charcoalMuted,
    },
    factCellSlot: {
      width: 18,
      height: 18,
      alignItems: "center",
      justifyContent: "center",
    },
    factCell: {
      width: 16,
      height: 16,
      borderRadius: 3,
      borderWidth: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    factAutomatic: {
      backgroundColor: MASTERY_DOT_COLOR.overlearned,
      borderColor: MASTERY_DOT_COLOR.overlearned,
    },
    factFluent: {
      backgroundColor: MASTERY_DOT_COLOR.fluent,
      borderColor: MASTERY_DOT_COLOR.fluent,
    },
    factPracticing: {
      backgroundColor: dialHollowFill(),
      borderColor: MASTERY_DOT_COLOR.fluent,
      borderWidth: 2,
    },
    factEffortful: {
      backgroundColor: MASTERY_DOT_COLOR.frontier,
      borderColor: MASTERY_DOT_COLOR.frontier,
    },
    factUnseen: {
      backgroundColor: dialHollowFill(),
      borderColor: MASTERY_DOT_COLOR.locked,
      borderStyle: "dashed",
    },
    factGlyph: {
      fontFamily: fonts.bold,
      fontSize: 8,
      lineHeight: 10,
    },
    factGlyphLight: { color: c.white },
    factGlyphDark: { color: c.charcoal },
    factSelection: {
      minHeight: 16,
      fontFamily: fonts.regular,
      fontSize: 12,
      lineHeight: 16,
      color: c.charcoalMuted,
    },
    body: {
      fontFamily: fonts.regular,
      fontSize: 13.5,
      lineHeight: 19,
      color: c.charcoal,
    },
    cue: {
      fontFamily: fonts.regular,
      fontSize: 12,
      lineHeight: 16,
      color: c.charcoalMuted,
    },
    fields: {
      flexDirection: "row",
      flexWrap: "wrap",
      columnGap: 24,
      rowGap: 8,
    },
    field: { minWidth: 110, flexShrink: 1 },
    fieldLabel: {
      fontFamily: fonts.bold,
      fontSize: 10,
      lineHeight: 13,
      letterSpacing: 0.8,
      color: c.charcoalMuted,
    },
    fieldValue: {
      marginTop: 2,
      fontFamily: fonts.bold,
      fontSize: 13.5,
      lineHeight: 18,
      color: c.navy,
    },
    // Full-width and always secondary: the Math tab's primary CTA is the card
    // above (check-in / playlist), and quick-facts practice is the adjacent
    // optional path in every license state.
    ctaWrap: { marginTop: 2, alignSelf: "stretch" },
    ctaPressed: { opacity: 0.85 },
    cta: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      minHeight: 44,
      borderRadius: 12,
      borderWidth: 1,
      paddingHorizontal: 18,
      paddingVertical: 11,
      backgroundColor: "transparent",
      borderColor: c.teal,
    },
    ctaText: {
      fontFamily: fonts.bold,
      fontSize: 15,
      lineHeight: 20,
      color: c.teal,
    },
  });
}
