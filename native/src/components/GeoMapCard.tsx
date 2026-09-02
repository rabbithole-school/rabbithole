import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { useMutation, useQuery } from "convex/react";

import { api, type Doc, type Id } from "@/lib/convex";
import { openInteractiveWebContent } from "@/lib/externalAppHost";
import { allowedHostsForUrl, geomapEmbedUrl } from "@/lib/webEmbedConfig";
import { fonts, useColors } from "@/theme";
import { GeoMapNative } from "./GeoMapNative";
import { FlairChips } from "./FlairChips";
import type {
  LngLat,
  ScholarPin,
  StoredMapArtifact,
} from "../../vendor/geomap/types";

// The public Mapbox runtime token (inlined at bundle time from native/.env,
// projected from NEXT_PUBLIC_MAPBOX_TOKEN by the worktree env sync). Present ⇒
// the inline @rnmapbox/maps renderer; absent ⇒ the webview launcher fallback.
const MAPBOX_TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN?.trim() || null;

// Stable empty-pins identity so an unparsed/pin-less map never re-renders the
// child on every query tick.
const EMPTY_PINS: ScholarPin[] = [];

function newPinId(): string {
  return `pin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseStored(content: string | undefined): StoredMapArtifact | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as StoredMapArtifact;
    if (!parsed || typeof parsed !== "object" || !parsed.spec) return null;
    if (!Array.isArray(parsed.scholarPins)) parsed.scholarPins = [];
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The scholar session-screen MAP card (native, webview path).
 *
 * When the session carries a `type: "map"` artifact (the tutor's `show_map`
 * tool created one), this renders a single full-width invitation card. Tapping
 * "Open the map" opens the Rabbithole-hosted `/embed/geomap` page inside the
 * keep-alive ExternalAppHost, handing this app's identity over with the PROD
 * one-shot embed-session token (`authHandoff: true`, minted by the host — the
 * same bridge the manipulative / Tree embeds use). The web embed owns the real
 * cartography (mapbox-gl) and the friendly no-token/offline state.
 *
 * One-map rule (plan §8): a session has at most one map artifact, so we render
 * at most one card. Reactivity: when the tutor updates the artifact (e.g. moves
 * the camera) the query re-runs and the card's title stays fresh, but the card
 * NEVER auto-opens or steals focus — an already-open embed updates itself live
 * via its own Convex subscription.
 *
 * Today's default is the inline @rnmapbox/maps renderer (GeoMapNative) when a
 * Mapbox token is configured (EXPO_PUBLIC_MAPBOX_TOKEN); the webview launcher
 * below is the no-token / offline fallback — it opens the Rabbithole-hosted
 * `/embed/geomap` page inside the keep-alive ExternalAppHost, handing this
 * app's identity over with the PROD one-shot embed-session token
 * (`authHandoff: true`, minted by the host — the same bridge the manipulative /
 * Tree embeds use). See the SDK spike notes in .lane-reports/lane-m.md.
 */
export function GeoMapCard({
  sessionId,
  activityId,
  onCommit,
  onAskCheck,
  commitBusy = false,
}: {
  sessionId: Id<"sessions">;
  activityId?: Id<"activities">;
  /** Send a scholar-voice turn so the tutor reacts to the current pins. Reuses
   *  the session screen's send+stream path. */
  onCommit?: (text: string) => void;
  /** Reuse the ordinary deliverable Check/Send flow when this map is the
   * activity's configured deliverable. */
  onAskCheck?: (
    artifact: Doc<"artifacts">,
    shouldCheck: boolean,
  ) => void | Promise<void>;
  /** A turn is already in flight — disable the commit button. */
  commitBusy?: boolean;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [actionBusy, setActionBusy] = useState(false);
  const [setupRepairFailed, setSetupRepairFailed] = useState(false);

  const artifacts = useQuery(api.artifacts.getBySession, { sessionId });
  const mapArtifact = useMemo(
    () => (artifacts ?? []).find(isMapArtifact) ?? null,
    [artifacts],
  );
  const setPins = useMutation(api.artifacts.scholarSetMapPins);
  const activity = useQuery(
    api.activities.getPublic,
    activityId ? { id: activityId } : "skip",
  );
  const snapshot = useQuery(
    api.sessions.getDeliverableSnapshot,
    activityId ? { sessionId } : "skip",
  );
  const deliverable = useQuery(
    api.deliverables.getForSessionActivity,
    activityId && mapArtifact
      ? { sessionId, activityId, artifactId: mapArtifact._id }
      : "skip",
  );
  const retrySetup = useMutation(api.sessions.ensureActivitySetup);

  // Parsed once — a map artifact's content is `{ v, spec, scholarPins }`.
  const stored = useMemo(
    () => (mapArtifact ? parseStored(mapArtifact.content) : null),
    [mapArtifact],
  );
  const scholarPins = stored?.scholarPins ?? EMPTY_PINS;
  const mapDeliverable =
    activity?.deliverable?.kind === "map" ? activity.deliverable : null;
  const criteria =
    mapDeliverable?.mode === "auto"
      ? snapshot?.status === "ready"
        ? (snapshot.criteria ?? [])
        : []
      : (mapDeliverable?.criteria ?? []);
  const criteriaPending =
    mapDeliverable?.mode === "auto" &&
    snapshot?.status !== "ready" &&
    snapshot?.status !== "error" &&
    !setupRepairFailed;
  const criteriaFailed =
    mapDeliverable?.mode === "auto" &&
    (snapshot?.status === "error" || setupRepairFailed);

  useEffect(() => {
    if (
      mapDeliverable?.mode !== "auto" ||
      snapshot?.status !== null
    ) {
      return;
    }
    void retrySetup({ sessionId }).catch(() => {
      setSetupRepairFailed(true);
    });
  }, [mapDeliverable?.mode, retrySetup, sessionId, snapshot?.status]);

  // Persist the kid's pins via the owner-only mutation. Controlled model: we
  // write, `getBySession` re-runs, GeoMapNative re-renders with the echoed pins.
  const persistPins = useCallback(
    (next: ScholarPin[]) => {
      const id = mapArtifact?._id;
      if (!id) return;
      void setPins({
        artifactId: id,
        pins: next.map((p) => ({
          id: p.id,
          lngLat: [p.lngLat[0], p.lngLat[1]],
          ...(p.label !== undefined ? { label: p.label } : {}),
        })),
      }).catch(() => {});
    },
    [mapArtifact?._id, setPins],
  );
  const handlePinDrop = useCallback(
    (lngLat: LngLat) => persistPins([...scholarPins, { id: newPinId(), lngLat }]),
    [persistPins, scholarPins],
  );
  const handlePinRemove = useCallback(
    (pinId: string) => persistPins(scholarPins.filter((p) => p.id !== pinId)),
    [persistPins, scholarPins],
  );
  const handlePinsClear = useCallback(() => persistPins([]), [persistPins]);

  if (!mapArtifact) return null;

  const title = mapArtifact.title?.trim() || "Your map";

  // The commit affordance (shared by the inline renderer AND the webview
  // fallback card): a task map asks the tutor to CHECK the answer; an explore
  // map just shares the pins. Same scholar-voice send path either way.
  const hasTask = !!stored?.spec.task;
  const commitLabel = mapDeliverable
    ? criteriaFailed
      ? "Try preparing check again"
      : criteriaPending
        ? "Preparing check…"
        : mapDeliverable.mode === "none"
          ? "Send it"
          : "Check my work"
    : hasTask
      ? "Check my answer"
      : "Share my pins with my tutor";
  const commitUtterance = hasTask
    ? "I placed my answer on the map — can you check it?"
    : "I dropped my pins on the map — take a look.";
  const noPins = scholarPins.length === 0;
  const commitDisabled =
    actionBusy ||
    commitBusy ||
    criteriaPending ||
    (!criteriaFailed && noPins);
  const showCommit = mapDeliverable ? !!onAskCheck : !!onCommit;
  const handleCommit = async () => {
    if (commitDisabled || !mapArtifact) return;
    void Haptics.selectionAsync();
    setActionBusy(true);
    try {
      if (criteriaFailed) {
        await retrySetup({ sessionId, retryErroredCriteria: true });
        setSetupRepairFailed(false);
      } else if (mapDeliverable) {
        await onAskCheck?.(mapArtifact, criteria.length > 0);
      } else {
        onCommit?.(commitUtterance);
      }
    } catch (error) {
      Alert.alert(
        "Couldn't check your work",
        error instanceof Error ? error.message : "Please try again.",
      );
    } finally {
      setActionBusy(false);
    }
  };
  const commitFooter = showCommit ? (
    <View style={styles.commitFooter}>
      {mapDeliverable ? (
        <FlairChips
          flairEarned={deliverable?.flairEarned}
          criteria={criteria}
          deliverableId={deliverable?._id}
          resolved={deliverable !== undefined}
        />
      ) : null}
      <Pressable
        onPress={() => void handleCommit()}
        disabled={commitDisabled}
        accessibilityRole="button"
        accessibilityLabel={commitLabel}
        accessibilityState={{ disabled: commitDisabled }}
        style={({ pressed }) => [
          styles.commitButton,
          commitDisabled && styles.commitButtonDisabled,
          pressed && !commitDisabled && styles.commitButtonPressed,
        ]}
      >
        {actionBusy || criteriaPending ? (
          <ActivityIndicator color={colors.white} />
        ) : null}
        <Text style={styles.commitButtonText}>{commitLabel}</Text>
      </Pressable>
    </View>
  ) : null;

  // The native renderer can only fully render specs whose overlay data it can
  // resolve: the checked-in registry datasets are NOT vendored into the app
  // (15 MB), so a spec with a registry-sourced layer (e.g. the Oʻahu quest's
  // wind-direction + rainfall overlays) would render with those layers silently
  // MISSING — worse than the webview, which shares the web renderer and shows
  // everything. Prefer native only when the spec is fully renderable natively;
  // otherwise the webview launcher keeps full fidelity. (Follow-up if inline-
  // native matters for these: vendor a trimmed registry or serve datasets via
  // a Convex query.)
  const specFullyNativeRenderable =
    !!stored &&
    !(stored.spec.layers ?? []).some((l) => "registry" in l.source);

  // The SDK path: with a Mapbox token configured, render the map INLINE via
  // @rnmapbox/maps (native gestures + native pins). The webview launcher below
  // is the no-token / offline / registry-overlay fallback (COMMON: the
  // tokenless state is what renders when EXPO_PUBLIC_MAPBOX_TOKEN is absent).
  if (MAPBOX_TOKEN && stored && specFullyNativeRenderable) {
    return (
      <View style={styles.inlineCard}>
        <View style={styles.inlineHeader}>
          <Text style={styles.eyebrow}>MAP</Text>
          <Text style={styles.inlineTitle} numberOfLines={1}>
            {title}
          </Text>
        </View>
        <View style={styles.mapWrap}>
          <GeoMapNative
            spec={stored.spec}
            scholarPins={scholarPins}
            onPinDrop={handlePinDrop}
            onPinRemove={handlePinRemove}
            onPinsClear={handlePinsClear}
            token={MAPBOX_TOKEN}
          />
        </View>
        {commitFooter}
      </View>
    );
  }

  const open = () => {
    Haptics.selectionAsync();
    const url = geomapEmbedUrl({ artifactId: mapArtifact._id });
    openInteractiveWebContent({
      id: `geomap:${mapArtifact._id}`,
      title,
      subtitle: "Real places, real maps — explore it your way.",
      url,
      allowedHosts: allowedHostsForUrl(url),
      gestureMode: "interactive",
      authHandoff: true,
    });
  };

  return (
    <View style={styles.fallbackWrap}>
      <Pressable
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel={`Open the map: ${title}`}
        accessibilityHint="Opens the map in Rabbithole without leaving the app."
        style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      >
        <View style={styles.iconWrap}>
          <Text style={styles.emoji}>🗺️</Text>
        </View>
        <View style={styles.textWrap}>
          <Text style={styles.eyebrow}>MAP</Text>
          <Text style={styles.title} numberOfLines={2}>
            {title}
          </Text>
          <Text style={styles.subtitle} numberOfLines={2}>
            Tap in and look around — zoom, pan, and find things for yourself.
          </Text>
        </View>
        <Text style={styles.cta}>Open the map ›</Text>
      </Pressable>
      {commitFooter}
    </View>
  );
}

/**
 * A map artifact is flagged by `type: "map"`. The generated union may not yet
 * carry "map" (that field widening lands with the backend lane), so widen the
 * access rather than compare against the current literal union.
 */
function isMapArtifact(artifact: Doc<"artifacts">): boolean {
  return (artifact.type as string | undefined) === "map";
}

type ColorSet = ReturnType<typeof useColors>;

function makeStyles(colors: ColorSet) {
  return StyleSheet.create({
    inlineCard: {
      borderRadius: 22,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.bg,
      marginBottom: 12,
      overflow: "hidden",
      shadowColor: colors.navy,
      shadowOpacity: 0.06,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 4 },
    },
    inlineHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 10,
    },
    inlineTitle: {
      flex: 1,
      minWidth: 0,
      fontSize: 16,
      fontFamily: fonts.bold,
      color: colors.navy,
    },
    mapWrap: {
      height: 360,
      width: "100%",
      backgroundColor: colors.bgSubtle,
    },
    commitFooter: {
      flexDirection: "row",
      justifyContent: "flex-end",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    commitButton: {
      backgroundColor: colors.teal,
      paddingHorizontal: 18,
      paddingVertical: 10,
      borderRadius: 14,
    },
    commitButtonPressed: { opacity: 0.8 },
    commitButtonDisabled: { opacity: 0.45 },
    commitButtonText: {
      fontSize: 15,
      fontFamily: fonts.semibold,
      color: colors.white,
    },
    card: {
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.bg,
      paddingVertical: 14,
      paddingHorizontal: 16,
      shadowColor: colors.navy,
      shadowOpacity: 0.06,
      shadowRadius: 14,
      shadowOffset: { width: 0, height: 4 },
    },
    cardPressed: { opacity: 0.78 },
    fallbackWrap: {
      marginBottom: 12,
    },
    iconWrap: {
      width: 48,
      height: 48,
      borderRadius: 16,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.bgSubtle,
    },
    emoji: { fontSize: 26 },
    textWrap: { flex: 1, minWidth: 0 },
    eyebrow: {
      fontSize: 11.5,
      letterSpacing: 1.1,
      fontFamily: fonts.bold,
      color: colors.teal,
      marginBottom: 2,
    },
    title: {
      fontSize: 17,
      lineHeight: 21,
      fontFamily: fonts.bold,
      color: colors.navy,
    },
    subtitle: {
      marginTop: 3,
      fontSize: 13.5,
      lineHeight: 18,
      fontFamily: fonts.regular,
      color: colors.fgMuted,
    },
    cta: {
      fontSize: 15,
      fontFamily: fonts.semibold,
      color: colors.teal,
    },
  });
}
