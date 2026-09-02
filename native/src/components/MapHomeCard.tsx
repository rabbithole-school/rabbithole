import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import Svg, { Circle, Line } from "react-native-svg";

import { fonts, palette, useColors } from "@/theme";
import { HomeSection } from "@/components/HomeSection";
import { InvitationCard } from "@/components/InvitationCard";
import { TreeDial, EDGE_REST, FRONTIER_GOLD } from "@/components/tree/treeGlyphs";
import { useMapHomeState } from "@/hooks/useMapHomeState";
import {
  MAP_HOME_MOVEMENT_HEADING,
  mapHomeAccess,
  mapHomeCopy,
  mapHomeSlot,
  type MapHomeSlot,
  type MapKind,
} from "../../vendor/shared/mapHomeCard";
import {
  RECAP_DIAL_STATE,
  type RecapLine,
} from "../../vendor/shared/dailyRecapLines";
import type { MasteryState } from "../../vendor/shared/treeMapLayout";
import { MASTERY_DOT_COLOR } from "../../vendor/shared/masteryDialPalette";

/**
 * MapHomeCard — the scholar Home's ONE card for a map, native twin of
 * components/MapHomeCard.tsx on web.
 *
 * It replaces three adjacent surfaces that all rendered the same object to the
 * same destination (Andy, 2026-07-26: "feels like these are all 3 different
 * flavors of the same thing"): the once-ever reveal card, the persistent
 * Frontier doorway, and the daily "your map changed today" receipt. The state
 * ladder — and every word of copy — lives in shared/mapHomeCard.ts so web and
 * native cannot drift; this file is only the pixels. Design:
 * review/tree-signal-reconciliation-plan.html.
 *
 * TWO Home positions, never both: `slot="elevated"` sits in the content, above
 * the day's work (it carries anything time-bound — the milestone, or today's
 * movement); `slot="quiet"` sits in the footer as the standing doorway. They
 * are mutually exclusive by construction because the ladder resolves to exactly
 * one state, and each slot asks whether that state is its own.
 *
 * Home-only (f21 / Andy's ruling, 2026-07-15): the reveal state surfaces ONLY
 * on the scholar home screen — never in-session, where it would compete with
 * the completion flow's own CTA. Full-width (f21 addendum): the card fills its
 * parent's column with no maxWidth of its own, like every other Home card.
 *
 * A render is never an acknowledgement, and neither is a CTA press: the reveal
 * is consumed on ARRIVAL at the map (native/src/app/sky.tsx), which flips
 * `revealPending` false and drops this card to its next rung.
 */

// The per-frontend access instruction for a gesture-reached map. Deliberately
// NOT in shared/: native opens the Sky by pulling DOWN on the Quests tab, web
// by tapping "Your Map" in the title bar — one sentence cannot be true of both.
// Only gesture maps appear here (see mapHomeAccess).
const GESTURE_HOW: Partial<Record<MapKind, string>> = {
  sky: "Pull down on this screen to open it.",
};

const EMOJI: Record<MapKind, string> = { sky: "🌌", tree: "🌳" };

// The reveal band has no dot state of its own — see RECAP_DIAL_STATE.
const DIAL_STATE: Record<RecapLine["mastery"], MasteryState> = RECAP_DIAL_STATE;

export function MapHomeCard({
  map,
  slot,
  welcomeActive = false,
}: {
  map: MapKind;
  slot: MapHomeSlot;
  /** The scholar is still in the welcome sequence (onboarding pin non-null).
   *  Defers the once-ever reveal until welcome is done — see
   *  shared/mapHomeCard.ts resolveMapHomeState. */
  welcomeActive?: boolean;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { state, lines } = useMapHomeState(map, welcomeActive);

  // Latch the pending unlock for this mount so a reactive refresh cannot make
  // the card flicker. Native Stack keeps Home mounted under /sky, so the latch
  // must also CLEAR once the reveal is recorded on arrival — otherwise coming
  // back home would replay a moment the scholar already had.
  const pending = state === "unlock";
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (pending && !revealed) {
      // Syncing a "seen once" latch to the external (Convex) reveal state —
      // the accepted subscribe-to-external-system case for setState-in-effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRevealed(true);
    } else if (!pending && revealed) {
      setRevealed(false);
    }
  }, [pending, revealed]);

  const copy = mapHomeCopy(map, state);
  if (mapHomeSlot(state) !== slot || !copy) return null;
  if (state === "unlock" && !revealed) return null;

  const openMap = () =>
    map === "tree"
      ? router.push({ pathname: "/sky", params: { view: "tree" } })
      : router.push("/sky");

  // ── The once-ever unlock: the loudest rung, and the only filled surface.
  if (state === "unlock") {
    const access = mapHomeAccess(map);

    // A GESTURE-reached map (Sky) — its milestone pixels now come from the
    // InvitationCard family (surface="night"), so a Sky-ready milestone reads as
    // the same object as the other Home invitations. No CTA; it teaches the
    // pull-to-open gesture. Sky carries no daily movement rows (only the Tree
    // has a recap), so there is nothing to nest.
    if (access === "gesture") {
      return (
        // `hidden` guards the null-eyebrow case structurally: a state without a
        // heading renders bare rather than claiming a section's extra space.
        <HomeSection label={copy.eyebrow ?? ""} hidden={!copy.eyebrow}>
          <InvitationCard
            surface="night"
            align="center"
            emoji={EMOJI[map]}
            title={copy.title}
            body={copy.body}
            accessHint={
              // A quiet inset panel, NOT the violet outline — that treatment is
              // reserved for the selected state (Andy, 2026-07-26).
              <View style={styles.how}>
                <Text style={styles.howArrow}>↓</Text>
                <Text style={styles.howText}>{GESTURE_HOW[map] ?? ""}</Text>
              </View>
            }
          />
        </HomeSection>
      );
    }

    // A map whose standing Home access IS this card (Tree) keeps its ordinary
    // CTA in the unlock state. The reveal is still consumed on arrival, never by
    // this press. The dark milestone pixels come from the InvitationCard family
    // (surface="night"), the same one definition the Sky card uses — the CTA and
    // the day's-movement rows nest under the hero via the card's nested slot.
    return (
      <HomeSection label={copy.eyebrow ?? ""} hidden={!copy.eyebrow}>
        <InvitationCard
          surface="night"
          align="center"
          emoji={EMOJI[map]}
          title={copy.title}
          body={copy.body}
          nestedContent={
            <>
              <Pressable
                onPress={openMap}
                accessibilityRole="button"
                accessibilityLabel={copy.cta ?? "Open your map"}
                hitSlop={8}
                style={({ pressed }) => [
                  styles.unlockCta,
                  pressed && { opacity: 0.85 },
                ]}
              >
                <Text style={styles.unlockCtaText}>{copy.cta} →</Text>
              </Pressable>
              {/* Two clocks, one card: when the map ALSO moved today, the day's
                  rows nest under the milestone rather than becoming a second
                  card — so they say which clock they are on. Same row grammar as
                  the daily receipt (dial · name · tag), on the night surface. */}
              {lines.length > 0 ? (
                <View style={styles.nested}>
                  <Text style={styles.nestedHeading}>
                    {MAP_HOME_MOVEMENT_HEADING.toUpperCase()}
                  </Text>
                  {lines.map((line) => (
                    <View key={line.key} style={styles.nestedRow}>
                      <View style={styles.dial} accessible={false}>
                        <TreeDial
                          size={18}
                          mastery={DIAL_STATE[line.mastery]}
                          automaticity={0}
                          depth={0}
                          surface="night"
                        />
                      </View>
                      <Text style={styles.nestedRowLabel} numberOfLines={1}>
                        {line.text}
                      </Text>
                      <Text style={styles.nestedRowTag} numberOfLines={1}>
                        {line.label}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}
            </>
          }
        />
      </HomeSection>
    );
  }

  // ── Today's movement: a receipt, not a celebration.
  if (state === "daily") {
    return (
      <HomeSection
        label={copy.eyebrow ?? ""}
        hidden={!copy.eyebrow}
        tint={colors.teal}
      >
        <RecapCard
          title={copy.title}
          cta={copy.cta}
          lines={lines}
          onPressCta={openMap}
          styles={styles}
          colors={colors}
        />
      </HomeSection>
    );
  }

  // ── The standing doorway. No eyebrow: an ordinary sibling card.
  return (
    <Pressable
      onPress={openMap}
      accessibilityRole="button"
      accessibilityLabel={copy.cta ?? copy.title}
      style={({ pressed }) => [styles.quietCard, pressed && { opacity: 0.85 }]}
    >
      <View style={styles.glyphWrap} accessible={false}>
        <MiniTree />
      </View>
      <View style={styles.quietText}>
        <Text style={styles.quietTitle}>{copy.title}</Text>
        {copy.body ? <Text style={styles.quietBody}>{copy.body}</Text> : null}
        <Text style={styles.quietCta}>{copy.cta} →</Text>
      </View>
    </Pressable>
  );
}

/**
 * The day's movement as a hairline-divided receipt — the SAME row geometry as
 * the sibling "Today's Math Playlists" card (PracticePlaylistCard, f26): a
 * leading status dot, the skill name as the row's main text, and the
 * proficiency word as a quiet right-aligned tag. Web twin:
 * components/DailyRecapCard.tsx (which stays standalone there because the
 * teacher's remote view renders it outside this card).
 *
 * Portrait, not report card (review/anti-parasocial-design.md): no scores, no
 * counts, no streaks, no comparisons. Delta is self-vs-self only, and a day
 * with no movement never reaches here — the ladder resolves elsewhere.
 */
function RecapCard({
  title,
  cta,
  lines,
  onPressCta,
  styles,
  colors,
}: {
  title: string;
  cta: string | null;
  lines: RecapLine[];
  onPressCta: () => void;
  styles: ReturnType<typeof makeStyles>;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <Animated.View entering={FadeIn.duration(300)} style={styles.recapCard}>
      <View style={styles.strip}>
        <SymbolView name="map" size={20} tintColor={colors.charcoalMuted} />
        <Text style={styles.stripTitle}>{title}</Text>
      </View>

      {lines.map((line) => (
        <View key={line.key} style={styles.row}>
          <View style={styles.dial} accessible={false}>
            <TreeDial
              size={18}
              mastery={DIAL_STATE[line.mastery]}
              automaticity={0}
              depth={0}
            />
          </View>
          <Text style={styles.rowLabel} numberOfLines={1}>
            {line.text}
          </Text>
          <Text style={styles.rowTag} numberOfLines={1}>
            {line.label}
          </Text>
        </View>
      ))}

      {cta ? (
        <View style={styles.ctaWrap}>
          <Pressable
            onPress={onPressCta}
            hitSlop={8}
            style={styles.recapCta}
            accessibilityRole="button"
            accessibilityLabel={cta}
          >
            <Text style={styles.recapCtaText}>{cta} →</Text>
          </Pressable>
        </View>
      ) : null}
    </Animated.View>
  );
}

// A miniature of the Tree Map's own vocabulary: fluent-green nodes growing up
// to a single gold frontier tip. Static (not data-driven) by design — this is a
// doorway thumbnail, not the map. The full, live tree lives behind the CTA.
const FLUENT_GREEN = MASTERY_DOT_COLOR.fluent;
const HALO_GOLD = MASTERY_DOT_COLOR.frontier;

// Drawn growing bottom→top, then rotated 90° clockwise so it reads left→right —
// echoing the real Tree Map's growth direction (base left, frontier right).
function MiniTree() {
  return (
    <Svg width={64} height={68} style={{ transform: [{ rotate: "90deg" }] }}>
      {/* edges (drawn first, under the nodes) */}
      <Line x1={32} y1={60} x2={32} y2={40} stroke={EDGE_REST} strokeWidth={2} />
      <Line x1={32} y1={40} x2={17} y2={26} stroke={EDGE_REST} strokeWidth={2} />
      <Line x1={32} y1={40} x2={47} y2={26} stroke={EDGE_REST} strokeWidth={2} />
      <Line
        x1={32}
        y1={40}
        x2={32}
        y2={14}
        stroke={FRONTIER_GOLD}
        strokeWidth={2}
        opacity={0.55}
      />
      {/* nodes */}
      <Circle cx={32} cy={60} r={5} fill={FLUENT_GREEN} />
      <Circle cx={32} cy={40} r={5} fill={FLUENT_GREEN} />
      <Circle cx={17} cy={26} r={4.5} fill={FLUENT_GREEN} />
      <Circle cx={47} cy={26} r={4.5} fill={FLUENT_GREEN} />
      {/* frontier tip — haloed gold */}
      <Circle cx={32} cy={14} r={11} fill={HALO_GOLD} opacity={0.18} />
      <Circle cx={32} cy={14} r={6} fill={FRONTIER_GOLD} />
    </Svg>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    // ── unlock (CTA + nested rows nest inside InvitationCard surface="night") ─
    how: {
      marginTop: 6,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 14,
      backgroundColor: palette.navy[800],
      borderWidth: 1,
      borderColor: palette.navy[700],
    },
    howArrow: { color: palette.navy[200], fontSize: 18, fontFamily: fonts.bold },
    howText: {
      color: palette.navy[100],
      fontSize: 15,
      fontFamily: fonts.semibold,
      textAlign: "center",
      flexShrink: 1,
    },
    unlockCta: {
      marginTop: 6,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 14,
      backgroundColor: palette.navy[800],
      borderWidth: 1,
      borderColor: palette.navy[700],
    },
    unlockCtaText: {
      color: c.white,
      fontSize: 15,
      fontFamily: fonts.semibold,
    },
    nested: {
      marginTop: 6,
      width: "100%",
      gap: 8,
      paddingTop: 12,
      borderTopWidth: 1,
      borderTopColor: palette.navy[700],
    },
    nestedHeading: {
      color: palette.navy[200],
      fontSize: 11.5,
      letterSpacing: 1.2,
      fontFamily: fonts.bold,
    },
    // Same three-part grammar as the daily receipt's rows (dial · name · tag),
    // restated for the night surface. Rhythm is gap-owned, so these rows need
    // no separators of their own — the block already has its top divider.
    nestedRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    nestedRowLabel: {
      flex: 1,
      minWidth: 0,
      fontFamily: fonts.bold,
      fontSize: 14,
      color: palette.navy[50],
    },
    nestedRowTag: {
      flexShrink: 0,
      fontFamily: fonts.regular,
      fontSize: 12,
      color: palette.navy[200],
      textAlign: "right",
    },

    // ── daily receipt ─────────────────────────────────────────────────────
    recapCard: {
      backgroundColor: c.bg,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 16,
      overflow: "hidden",
    },
    // The header strip — same padding/divider as the row list below (and the
    // sibling PracticePlaylistCard's `strip`), so the icon column lines up
    // with the row dots.
    strip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 11,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    stripTitle: { fontFamily: fonts.bold, fontSize: 15, color: c.navy },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderTopWidth: 1,
      borderTopColor: c.gray100,
    },
    dial: { flexShrink: 0 },
    rowLabel: {
      flex: 1,
      minWidth: 0,
      fontFamily: fonts.bold,
      fontSize: 14,
      color: c.navy,
    },
    rowTag: {
      flexShrink: 0,
      fontFamily: fonts.regular,
      fontSize: 12,
      color: c.charcoalSubtle,
      textAlign: "right",
    },
    ctaWrap: {
      paddingHorizontal: 14,
      paddingVertical: 12,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    recapCta: { alignSelf: "flex-start" },
    recapCtaText: {
      fontFamily: fonts.semibold,
      fontSize: 14,
      color: c.charcoalMuted,
    },

    // ── quiet doorway ─────────────────────────────────────────────────────
    quietCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      backgroundColor: c.bg,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 16,
      paddingVertical: 16,
      paddingHorizontal: 16,
    },
    glyphWrap: {
      width: 64,
      height: 68,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
    quietText: { flex: 1, minWidth: 0, gap: 4 },
    quietTitle: { fontFamily: fonts.bold, fontSize: 16, color: c.navy },
    quietBody: {
      fontFamily: fonts.regular,
      fontSize: 13.5,
      lineHeight: 19,
      color: c.charcoalMuted,
    },
    quietCta: {
      marginTop: 4,
      fontFamily: fonts.semibold,
      fontSize: 14,
      color: c.violet,
    },
  });
}
