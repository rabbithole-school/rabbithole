/**
 * Native App Launcher — scholar home grid of standing External Apps
 * (external practice apps & friends). Mirrors the web AppLauncher squircle grid
 * but native-shaped: large tap targets, landscape-friendly, no WebView
 * dependency. Tapping opens the root-mounted keep-alive WebView host.
 *
 * Query: api.scholarApps.listForLauncher — identical to the web launcher.
 */

import { isUnlockManagedApp } from "@/lib/asam/managedAppSchemes";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";

import { api, type Id } from "@/lib/convex";
import { openExternalApp } from "@/lib/externalAppHost";
import { AppTileMark } from "@/components/AppTileMark";
import { useNativeAppLauncher } from "@/hooks/useNativeAppLauncher";
import { useNow } from "@/hooks/useNow";
import { useSmoothedQuery } from "@/hooks/useSmoothedQuery";
import { colors, fonts } from "@/theme";
import { useConvexAuth } from "@convex-dev/auth/react";

type LauncherTile = {
  // Null for a tile the scholar gets purely via an audience grant (no
  // per-scholar row); tiles are keyed by appId, which is always present.
  scholarAppId: Id<"scholarApps"> | null;
  appId: Id<"externalApps">;
  name: string;
  webUrl: string;
  webAllowedHosts: string[] | null;
  iconUrl: string | null;
  iconEmoji: string | null;
  color: string | null;
  // When set, this catalog app is also launchable as an INSTALLED native iOS
  // app; tapping opens it via URL scheme instead of the locked webview.
  nativeUrlScheme: string | null;
  // Set instead of a scheme for a managed native app that registers none. The
  // tile still takes the native path — readiness, allowlist, ASAM release —
  // and then hands off to the Home Screen. Falling through to the webview here
  // would open the app's marketing page instead of the app.
  nativeBundleId: string | null;
};

// Landscape iPad: 6 columns fits comfortably at the default tile width.
const TILE_SIZE = 80;
const TILE_RADIUS = TILE_SIZE * 0.22; // squircle — matches web "borderRadius: 22%"

export function AppLauncher({
  scholarId,
  minuteNow: minuteNowProp,
}: {
  scholarId?: Id<"users">;
  /** The parent's minute bucket — see the web AppLauncher for why sharing it
   *  matters (one Convex subscription instead of two drifting ones). */
  minuteNow?: number;
}) {
  const { isAuthenticated } = useConvexAuth();
  // Re-arms the subscription across institution-local midnight, when a live
  // push stops showing with no database write — see `listForLauncher`.
  const ownMinuteNow = Math.floor(useNow(60_000) / 60_000) * 60_000;
  const minuteNow = minuteNowProp ?? ownMinuteNow;
  const apps = useSmoothedQuery(
    api.scholarApps.listForLauncher,
    isAuthenticated
      ? scholarId
        ? { scholarId, now: minuteNow }
        : { now: minuteNow }
      : "skip",
  ) as LauncherTile[] | undefined;

  // Reserve the row's height while the apps query loads, so it doesn't pop in
  // ~100ms late and shove the rest of Home down (layout-shift fix).
  if (apps === undefined) return <View style={styles.placeholder} />;
  if (apps.length === 0) return null;

  return (
    <View style={styles.root}>
      <Text style={styles.heading}>APPS</Text>
      <View style={styles.grid}>
        {apps.map((app) => (
          <AppTile key={app.appId} app={app} />
        ))}
      </View>
    </View>
  );
}

function AppTile({ app }: { app: LauncherTile }) {
  const launchNativeApp = useNativeAppLauncher();

  const open = () => {
    Haptics.selectionAsync();
    // A catalog app with a native URL scheme opens the INSTALLED native app
    // (releasing ASAM for the switch, re-arming on return); otherwise it opens
    // the keep-alive locked webview overlay (state survives reopen).
    //
    // The tile does NOT ask for access. On a managed iPad the app's place in
    // the device allowlist is a projection of the teacher's grant — the same
    // grant that put this tile on screen — so by the time a scholar can tap it,
    // the app is normally already open-able. The launcher only waits, briefly,
    // when the device has not caught up yet.
    // A bundle id alone routes here only when the backend MANAGES that app.
    // Gating on "has a bundle id" would send any unknown id down the native
    // path, where there is nothing to open and no readiness contract.
    if (app.nativeUrlScheme || isUnlockManagedApp(app)) {
      void launchNativeApp({
        nativeUrlScheme: app.nativeUrlScheme ?? null,
        nativeBundleId: app.nativeBundleId ?? null,
        appName: app.name,
        externalAppId: String(app.appId),
        iconUrl: app.iconUrl,
        iconEmoji: app.iconEmoji,
        color: app.color,
      });
      return;
    }
    openExternalApp({
      appId: app.appId,
      name: app.name,
      url: app.webUrl,
      webAllowedHosts: app.webAllowedHosts,
    });
  };

  return (
    <Pressable
      onPress={open}
      style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
      accessibilityRole="button"
      accessibilityLabel={`Open ${app.name}`}
    >
      {/* One chain, shared with web: image → emoji → initial, on the app's
          tint — including when a remote logo fails to load here. The Pressable
          above already announces the app, so the mark itself stays silent. */}
      <AppTileMark
        name={app.name}
        iconUrl={app.iconUrl}
        iconEmoji={app.iconEmoji}
        color={app.color}
        markFontSize={28}
        decorative
        style={styles.icon}
      />
      <Text style={styles.label} numberOfLines={2}>
        {app.name}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    gap: 12,
  },
  placeholder: {
    height: 124, // ≈ heading + one tile row + label; keeps Home from shifting
  },
  heading: {
    fontSize: 12.5,
    letterSpacing: 1.2,
    fontFamily: fonts.bold,
    color: colors.charcoalMuted,
    marginLeft: 4,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 18,
  },
  tile: {
    width: TILE_SIZE,
    alignItems: "center",
    gap: 7,
  },
  tilePressed: {
    opacity: 0.75,
  },
  icon: {
    width: TILE_SIZE,
    height: TILE_SIZE,
    borderRadius: TILE_RADIUS,
    // Drop shadow lifts the white squircle off the gray home (iOS; Android: elevation)
    shadowColor: colors.navy,
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 7,
    // Hairline edge so a white tile keeps a crisp border on white-ish bg
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(20,24,55,0.08)",
    overflow: "visible",
  },
  label: {
    fontSize: 12,
    fontFamily: fonts.semibold,
    color: colors.charcoal,
    textAlign: "center",
    lineHeight: 16,
  },
});
