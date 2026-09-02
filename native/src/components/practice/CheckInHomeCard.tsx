/**
 * CheckInHomeCard (native) — the RN twin of web
 * components/practice/CheckInHomeCard.tsx (finish-the-check-in SURFACES, PR2,
 * Surface 1).
 *
 * The always-on path is the daily playlist's own "· mapping" band (PR1) —
 * ≤2 unplaced-domain probes folded into the ordinary daily set, no scholar
 * action required. This card is the OPTIONAL accelerator for a scholar who
 * wants to power through the rest of the map in one sitting: "Math check-in ·
 * N of M domains mapped → Continue check-in", routing to the revived
 * multi-domain orchestrator (`?checkin=all`).
 *
 * An accelerator, not a fixture (rule 5): renders ONLY while
 * `mapProgressForScholar.hasServable` is true and the map isn't complete yet,
 * and disappears PERMANENTLY the moment every eligible domain has converged —
 * `showCheckInHomeCard` (shared/checkInMapCopy.ts, vendored) is the single
 * predicate both frontends read, so this can't drift from web's twin.
 *
 * Self-contained (native has no page-level lift, mirrors PracticePlaylistCard):
 * resolves its own scholar id via `api.users.currentUser` rather than taking
 * one as a prop — native's Home has no teacher/remote view to thread through
 * (unlike web's `checkInScholarId`).
 *
 * It DOES have to reproduce the other half of web's `checkInScholarId`, though:
 * the card is **auto-blend only**. A teacher-pinned scholar (`standing !== null`)
 * has no cross-domain check-in concept at all — pinning IS the single-domain
 * override — so there is nothing to accelerate, and web skips the query
 * entirely (app/scholar/page.tsx, `checkInScholarId = autoBlend ? … :
 * undefined`). That gate was missed when this twin was written, because the
 * prop web threaded carried BOTH the remote-scholar resolution (genuinely
 * native-irrelevant) and the auto-blend gate (not); dropping the prop dropped
 * both. A pinned scholar on iPad therefore saw a card web deliberately
 * suppresses — a scholar-facing parity gap, which is a defect, not a follow-up.
 */

import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Svg, { Line, Rect } from "react-native-svg";
import { useConvexAuth, useQuery } from "convex/react";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";

import { api } from "@/lib/convex";
import { fonts, useColors } from "@/theme";
import {
  CHECK_IN_HOME_TITLE,
  checkInHomeCta,
  checkInHomeSubtitle,
  showCheckInHomeCard,
} from "../../../vendor/shared/checkInMapCopy";

// ── The survey-plot progress strip ─────────────────────────────────────────
// The RN twin of web's strip (components/practice/CheckInHomeCard.tsx): a
// decorative row of rounded-square "map plots" beside the "N of M domains
// mapped" subtitle, one per eligible domain, so the fraction is also SEEN.
// Spec: math-skills-mapping-mark-spike.html §"Scholar home — the check-in
// card" (the amended survey-plot family, VIOLET on every surface; the teal CTA
// stays teal as brand chrome). Filled = mapped · half-drawn (two sides solid)
// = in progress · dotted = not yet. Purely decorative (the subtitle text
// carries the meaning), so the strip is hidden from the accessibility tree.
// Drawn with react-native-svg to get the two-sides-solid look RN's single
// `borderStyle` can't express per side. Byte-for-byte the same derivation +
// hue + geometry as web, for parity.
const MAP_VIOLET = "#7c3aed";

type PlotState = "mapped" | "inflight" | "notyet";

/** Per-eligible-domain plot states derived from the SAME data the subtitle
 *  uses (`mapProgressForScholar` → mapped/eligible/started). Only COUNTS reach
 *  this card, not per-domain status, so a single "in progress" plot is inferred
 *  from `started` (the scholar has answered a probe but not finished the map);
 *  the remainder are "not yet." Mapped plots fill from the left. */
function mapPlotStates(mapped: number, eligible: number, started: boolean): PlotState[] {
  const filled = Math.max(0, Math.min(mapped, eligible));
  const inflight = started && filled < eligible ? 1 : 0;
  const notYet = Math.max(0, eligible - filled - inflight);
  return [
    ...Array<PlotState>(filled).fill("mapped"),
    ...Array<PlotState>(inflight).fill("inflight"),
    ...Array<PlotState>(notYet).fill("notyet"),
  ];
}

function MapPlot({ state }: { state: PlotState }) {
  if (state === "mapped") {
    return (
      <Svg width={10} height={10} viewBox="0 0 12 12">
        <Rect x={1} y={1} width={10} height={10} rx={2.5} fill={MAP_VIOLET} />
      </Svg>
    );
  }
  return (
    <Svg width={10} height={10} viewBox="0 0 12 12">
      <Rect
        x={1.5}
        y={1.5}
        width={9}
        height={9}
        rx={2.5}
        fill="none"
        stroke={MAP_VIOLET}
        strokeWidth={1.5}
        strokeDasharray="1.6 1.6"
      />
      {state === "inflight" ? (
        <>
          <Line x1={1.5} y1={4} x2={1.5} y2={10.5} stroke={MAP_VIOLET} strokeWidth={1.5} strokeLinecap="round" />
          <Line x1={4} y1={10.5} x2={10.5} y2={10.5} stroke={MAP_VIOLET} strokeWidth={1.5} strokeLinecap="round" />
        </>
      ) : null}
    </Svg>
  );
}

const MAPSTRIP_STYLE = { flexDirection: "row" as const, alignItems: "center" as const, gap: 4 };

function MapProgressStrip({
  mapped,
  eligible,
  started,
}: {
  mapped: number;
  eligible: number;
  started: boolean;
}) {
  const plots = mapPlotStates(mapped, eligible, started);
  if (plots.length === 0) return null;
  return (
    <View style={MAPSTRIP_STYLE} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {plots.map((state, i) => (
        <MapPlot key={i} state={state} />
      ))}
    </View>
  );
}

export function CheckInHomeCard() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { isAuthenticated } = useConvexAuth();
  const me = useQuery(api.users.currentUser, isAuthenticated ? {} : "skip");
  const scholarId = me?._id;
  // Auto-blend only — see the header. `undefined` while the query is in flight
  // means "not yet known", so we wait for `null` (no pin) rather than flashing
  // the card at a pinned scholar for a frame. Same args as
  // PracticePlaylistCard's own `standing` subscription, so convex/react shares
  // ONE subscription rather than opening a second.
  const standing = useQuery(
    api.standingPractice.myActiveStanding,
    isAuthenticated ? {} : "skip",
  );
  const autoBlend = standing === null;
  const progress = useQuery(
    api.practiceSkills.mapProgressForScholar,
    autoBlend && scholarId ? { scholarId } : "skip",
  );

  if (!showCheckInHomeCard(progress)) return null;
  // showCheckInHomeCard already narrowed `progress` to a defined, servable,
  // unmapped state — but TS can't see through the helper, so re-assert here.
  if (!progress) return null;

  return (
    <View style={styles.card}>
      <View style={styles.glyphWrap} accessible={false}>
        <SymbolView name="map" size={22} tintColor={colors.charcoalMuted} />
      </View>
      <View style={styles.text}>
        <Text style={styles.title}>{CHECK_IN_HOME_TITLE}</Text>
        <View style={styles.subtitleRow}>
          <MapProgressStrip
            mapped={progress.mapped}
            eligible={progress.eligible}
            started={progress.started}
          />
          <Text style={styles.subtitle}>
            {checkInHomeSubtitle(progress.mapped, progress.eligible)}
          </Text>
        </View>
      </View>
      <Pressable
        onPress={() => router.push("/practice?checkin=all")}
        accessibilityRole="button"
        accessibilityLabel={checkInHomeCta(progress.started)}
        hitSlop={8}
        style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }]}
      >
        <Text style={styles.ctaText}>{checkInHomeCta(progress.started)}  →</Text>
      </Pressable>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    card: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      backgroundColor: c.bg,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 16,
      paddingVertical: 14,
      paddingHorizontal: 16,
    },
    glyphWrap: { flexShrink: 0 },
    text: { flex: 1, minWidth: 0, gap: 2 },
    subtitleRow: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1 },
    title: { fontFamily: fonts.bold, fontSize: 15, color: c.navy },
    subtitle: { fontFamily: fonts.regular, fontSize: 13, color: c.charcoalMuted },
    cta: {
      flexShrink: 0,
      backgroundColor: c.teal,
      borderRadius: 12,
      paddingVertical: 8,
      paddingHorizontal: 14,
    },
    ctaText: { fontFamily: fonts.semibold, fontSize: 13.5, color: c.white },
  });
}
