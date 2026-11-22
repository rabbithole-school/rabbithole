import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { router, useLocalSearchParams } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/lib/convex";
import { YOUR_SKY_COLORS } from "../../vendor/shared/yourSkyModel";
import { palette } from "@/theme";
import { YourSky } from "@/components/sky/YourSky";
import { TreeMapNative } from "@/components/tree/TreeMapNative";
import { useMapGates } from "@/hooks/useMapGates";

// The map screen, one lens at a time:
//   - Sky (the default): the kid's own sky (components/sky/YourSky.tsx,
//     TRA-699), opened by the Quests tab's pull-down. It is the kid's own
//     record and opens for them always; an empty sky says how a first star
//     arrives. Web's twin is /scholar/map's Sky lens.
//   - Tree (`?view=tree`): the Math Skills Tree, opened from the Math tab's
//     "View your frontier" card and the daily-recap card.

const SPACE = YOUR_SKY_COLORS.space;
// Header height BELOW the safe-area inset: the top bar's own height and where
// the Tree's content starts, so the bar never overlaps it.
const HEADER_H = 54;

type SkyViewMode = "sky" | "tree";

export default function SkyScreen() {
  const insets = useSafeAreaInsets();
  const { view } = useLocalSearchParams<{ view?: string }>();
  const me = useQuery(api.users.currentUser, {});
  const [viewMode, setViewMode] = useState<SkyViewMode>(view === "tree" ? "tree" : "sky");
  // Milestone reveals (f6) still gate the Tree: a deep link to a Tree that has
  // no data yet falls to the Sky.
  const gates = useMapGates();
  useEffect(() => {
    if (gates.isLoading || me === undefined) return;
    if (viewMode === "tree" && !gates.tree) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- a deep-linked lens with no data must fall to the one that always opens.
      setViewMode("sky");
    }
  }, [gates.isLoading, gates.tree, viewMode, me]);
  // Consume a lens's one-time reveal on genuine ARRIVAL at it (J10(b)): the
  // Home reveal card teaches the way here and retires itself once the kid
  // arrives, once per lens.
  const acknowledgeReveal = useMutation(api.mapGates.acknowledgeReveal);
  const consumedRef = useRef<Set<SkyViewMode>>(new Set());
  useEffect(() => {
    if (gates.isLoading) return;
    const m = viewMode;
    const unlocked = m === "sky" ? gates.sky : gates.tree;
    const pending = m === "sky" ? gates.skyRevealPending : gates.treeRevealPending;
    if (!unlocked || !pending || consumedRef.current.has(m)) return;
    consumedRef.current.add(m);
    void acknowledgeReveal({ map: m });
  }, [
    gates.isLoading,
    gates.sky,
    gates.tree,
    gates.skyRevealPending,
    gates.treeRevealPending,
    viewMode,
    acknowledgeReveal,
  ]);
  // One Sky-open event each time the Sky lens comes into view (skyOpens.record,
  // TRA-669; web twin app/scholar/map/page.tsx). A Tree-only visit (the Math
  // tab's frontier card) is not a Sky open. The ref keeps a re-render, or
  // React's dev double-run of effects, from counting one open twice. Self
  // only, and a no-op for anyone but a scholar, so no role check here.
  const recordSkyOpen = useMutation(api.skyOpens.record);
  const skyShowing = me !== undefined && viewMode === "sky";
  const skyShowingRef = useRef(false);
  useEffect(() => {
    if (skyShowing && !skyShowingRef.current) {
      recordSkyOpen({}).catch((error: unknown) => {
        console.warn("[sky] open not recorded", error);
      });
    }
    skyShowingRef.current = skyShowing;
  }, [skyShowing, recordSkyOpen]);

  const topBarH = insets.top + HEADER_H;

  return (
    <View style={[styles.root, { backgroundColor: SPACE }]}>
      {viewMode === "sky" && <YourSky topInset={topBarH} />}

      {/* The fully native Math Skills Tree, below the top bar, with its own
          pinch and pan. */}
      {viewMode === "tree" && (
        <View style={[styles.treeWrap, { top: topBarH }]}>
          <TreeMapNative />
        </View>
      )}

      {/* Top bar: Done, and the lens's name. */}
      <View
        style={[
          styles.topBar,
          { paddingTop: insets.top, height: topBarH },
          viewMode === "tree" && { backgroundColor: SPACE },
        ]}
        pointerEvents="box-none"
      >
        <Text
          style={[styles.topBarTitle, { top: insets.top, lineHeight: HEADER_H }]}
          pointerEvents="none"
          accessibilityRole="header"
        >
          {viewMode === "tree" ? "Math Skills Tree" : "Your sky"}
        </Text>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={styles.close}
          accessibilityRole="button"
        >
          <Text style={styles.closeText}>Done</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
  },
  close: { minWidth: 56, minHeight: 44, justifyContent: "center" },
  topBarTitle: {
    position: "absolute",
    left: 0,
    right: 0,
    textAlign: "center",
    color: "#eaf0ff",
    fontSize: 17,
    fontFamily: "HankenGrotesk_600SemiBold",
  },
  closeText: {
    color: palette.violet[300],
    fontSize: 17,
    fontFamily: "HankenGrotesk_600SemiBold",
  },
  treeWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: SPACE,
  },
});
