/**
 * FocusStrip — native twin of components/FocusStrip.tsx (web). What the
 * teacher has put in front of the room RIGHT NOW: an app, a video, a link,
 * or an activity, for a bounded window (see convex/pushes.ts).
 *
 * Distinct from RoomCueBanner, which passes through the teacher's WORDS.
 * This strip passes through a teacher's POINTER — every card is something
 * the scholar can open. Both surfaces read their copy from
 * shared/pushCopy.ts so the words can never drift between web and native.
 *
 * Opening an app goes through the SAME path AppLauncher uses (native URL
 * scheme when the catalog app has one, otherwise the keep-alive locked
 * webview) rather than a second launch mechanism — a focus card and a
 * launcher tile must behave identically for the same app.
 */

import { isUnlockManagedApp } from "@/lib/asam/managedAppSchemes";
import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useMutation } from "convex/react";
import { useSmoothedQuery } from "@/hooks/useSmoothedQuery";
import { useConvexAuth } from "@convex-dev/auth/react";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";

import { api, type Id } from "@/lib/convex";
import {
  openExternalApp,
  openEmbeddedWebContent,
  openYouTubeVideo,
} from "@/lib/externalAppHost";
import { AppTileMark } from "@/components/AppTileMark";
import { useNativeAppLauncher } from "@/hooks/useNativeAppLauncher";
import { fonts, palette } from "@/theme";
import {
  pushActionLabel,
  pushGlyph,
  pushMetaLine,
  type PushTargetKind,
} from "../../vendor/shared/pushCopy";
import { openUntilPhrase } from "../../vendor/shared/openUntil";

type LivePush = {
  _id: Id<"pushes">;
  kind: PushTargetKind;
  title: string;
  subtitle?: string;
  url?: string;
  iconUrl?: string;
  iconEmoji?: string;
  color?: string;
  media?: "video" | "page";
  activityId?: Id<"activities">;
  externalAppId?: Id<"externalApps">;
  webAllowedHosts?: string[];
  nativeUrlScheme?: string;
  /** Identity for a managed native app with no URL scheme. */
  nativeBundleId?: string;
  note?: string;
  blocking: boolean;
  endsAt: number | null;
  /** Set for an "Open until a date" give: when its window closes. The Home
   *  draws it under "Open from class" (convex/pushes.ts `HydratedPush`). */
  openUntil?: number | null;
};

/** The minute re-arm for the live read. The row shows its end as a time,
 *  so nothing on it ticks. */
function useNow(active: boolean, intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

/** The scholar's live pushes. The Home reads them once, so the class
 *  section knows whether to show. */
export function useLivePushes(enabled: boolean): LivePush[] {
  const { isAuthenticated } = useConvexAuth();
  const active = enabled && isAuthenticated;
  const now = useNow(active);
  const minuteNow = Math.floor(now / 60_000) * 60_000;
  // Smoothed so the minute re-arm doesn't blank the rows for a round-trip.
  const pushes = useSmoothedQuery(
    api.pushes.livePushesForMe,
    active ? { now: minuteNow } : "skip",
  ) as LivePush[] | undefined;
  return pushes ?? [];
}

/**
 * The pushes as rows at the top of the class section ("In class now" /
 * "From class today"), above its activity rows, in the same row grid and
 * emoji column. There is no separate heading. Web twin: PushRows in
 * components/FocusStrip.tsx.
 */
export function PushRows({
  pushes,
  timeZone,
  nowMs,
}: {
  pushes: LivePush[];
  timeZone: string;
  /** The Home's clock, so an open-until give's "Open until Fri" reads like
   *  the rows beside it. */
  nowMs: number;
}) {
  if (pushes.length === 0) return null;
  return (
    <View style={styles.root}>
      {pushes.map((push) => (
        <FocusCard
          key={String(push._id)}
          push={push}
          timeZone={timeZone}
          nowMs={nowMs}
        />
      ))}
    </View>
  );
}

function FocusCard({
  push,
  timeZone,
  nowMs,
}: {
  push: LivePush;
  timeZone: string;
  nowMs: number;
}) {
  const launchNativeApp = useNativeAppLauncher();
  const router = useRouter();
  const createSession = useMutation(api.sessions.create);
  const meta = pushMetaLine(
    { note: push.note ?? null, endsAt: push.endsAt },
    timeZone,
    push.openUntil != null
      ? openUntilPhrase(push.openUntil, timeZone, nowMs)
      : null,
  );

  const open = () => {
    void Haptics.selectionAsync();
    if (push.kind === "activity") {
      // Same launch path unit-progress uses, so a focused activity and a
      // tapped one land in the identical session.
      if (!push.activityId) return;
      const activityId = push.activityId;
      void (async () => {
        try {
          const result = await createSession({ activityId });
          if (result?.id) {
            router.push({
              pathname: "/session/[id]",
              params: { id: result.id, title: push.title },
            });
          }
        } catch (error) {
          console.warn("[FocusStrip] activity launch failed", error);
          Alert.alert(
            "Couldn't start that",
            "Please try again in a moment.",
          );
        }
      })();
      return;
    }
    if (push.kind === "app" && push.externalAppId) {
      // Managed-only, same reasoning as AppLauncher: an unknown bundle id
      // must not reach the native path and release ASAM.
      if (push.nativeUrlScheme || isUnlockManagedApp(push)) {
        void launchNativeApp({
          nativeUrlScheme: push.nativeUrlScheme ?? null,
          nativeBundleId: push.nativeBundleId ?? null,
          appName: push.title,
          externalAppId: String(push.externalAppId),
          iconUrl: push.iconUrl ?? null,
          iconEmoji: push.iconEmoji ?? null,
          color: push.color ?? null,
        });
        return;
      }
      openExternalApp({
        appId: push.externalAppId,
        name: push.title,
        url: push.url ?? "",
        webAllowedHosts: push.webAllowedHosts ?? null,
      });
      return;
    }
    if (push.url) {
      // A YouTube link plays in the SAME sandboxed player video resources use
      // (nocookie embed, locked hosts, no related / Shorts / search) rather
      // than a host-locked WebView on youtube.com. Non-YouTube links fall
      // through to the generic locked overlay.
      if (openYouTubeVideo({ url: push.url, title: push.title })) return;
      // A link/resource push opens in the same locked webview overlay an
      // app does — a scholar never leaves the managed surface.
      openEmbeddedWebContent({
        kind: "interactive",
        title: push.title,
        url: push.url,
        allowedHosts: null,
        gestureMode: "page",
      });
    }
  };

  return (
    <Pressable
      onPress={open}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      accessibilityRole="button"
      accessibilityLabel={`${pushActionLabel(push)} ${push.title}`}
    >
      {/* The class rows' emoji column, so a push's glyph or app tile lines
          up with the activity rows' emoji. */}
      <View style={styles.glyphCol}>
        {push.kind === "app" ? (
          // An app's mark resolves through the ONE shared chain the launcher
          // tile and the unlock modal use — logo → the staff-chosen emoji →
          // the initial, on the app's own tint. The Pressable already names it.
          <AppTileMark
            name={push.title}
            iconUrl={push.iconUrl ?? null}
            iconEmoji={push.iconEmoji ?? null}
            color={push.color ?? null}
            markFontSize={11}
            decorative
            style={styles.icon}
          />
        ) : (
          // A video, link or activity has no catalog tile: its glyph names
          // the KIND of thing (shared/pushCopy.ts).
          <Text style={styles.iconGlyph}>{pushGlyph(push)}</Text>
        )}
      </View>
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>
          {push.title}
        </Text>
        {meta ? (
          <Text style={styles.note} numberOfLines={2}>
            {meta}
          </Text>
        ) : null}
      </View>
      <Text style={styles.action}>{pushActionLabel(push)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { gap: 8 },
  card: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: palette.gray[200],
    backgroundColor: palette.white,
  },
  cardPressed: { opacity: 0.75 },
  glyphCol: { width: 22, alignItems: "center", paddingTop: 1 },
  icon: {
    width: 22,
    height: 22,
    borderRadius: 5,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  iconGlyph: {
    color: palette.violet[500],
    fontFamily: fonts.semibold,
    fontSize: 17,
  },
  body: { flex: 1, gap: 2 },
  title: {
    color: palette.navy[800],
    fontFamily: fonts.semibold,
    fontSize: 16,
  },
  note: {
    color: palette.navy[600],
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 18,
  },
  action: {
    color: palette.violet[700],
    fontFamily: fonts.semibold,
    fontSize: 14,
    alignSelf: "center",
  },
});
