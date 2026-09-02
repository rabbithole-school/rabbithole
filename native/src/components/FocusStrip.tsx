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

import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useMutation, useQuery } from "convex/react";
import { useConvexAuth } from "@convex-dev/auth/react";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";

import { api, type Id } from "@/lib/convex";
import { openExternalApp, openEmbeddedWebContent } from "@/lib/externalAppHost";
import { AppTileMark } from "@/components/AppTileMark";
import { useNativeAppLauncher } from "@/hooks/useNativeAppLauncher";
import { colors, fonts, palette } from "@/theme";
import {
  FOCUS_STRIP_HEADING,
  pushActionLabel,
  pushGlyph,
  pushTimeLeftLabel,
  type PushTargetKind,
} from "../../vendor/shared/pushCopy";

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
  note?: string;
  blocking: boolean;
  endsAt: number | null;
};

/** The countdown has to tick on its own — nothing refetches every minute. */
function useNow(active: boolean, intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

export function FocusStrip() {
  const { isAuthenticated } = useConvexAuth();
  const pushes = useQuery(
    api.pushes.livePushesForMe,
    isAuthenticated ? {} : "skip",
  ) as LivePush[] | undefined;

  const now = useNow(!!pushes && pushes.length > 0);

  if (!pushes || pushes.length === 0) return null;

  return (
    <View style={styles.root}>
      <Text style={styles.heading}>{FOCUS_STRIP_HEADING.toUpperCase()}</Text>
      {pushes.map((push) => (
        <FocusCard key={String(push._id)} push={push} now={now} />
      ))}
    </View>
  );
}

function FocusCard({ push, now }: { push: LivePush; now: number }) {
  const launchNativeApp = useNativeAppLauncher();
  const router = useRouter();
  const createSession = useMutation(api.sessions.create);
  const timeLeft = pushTimeLeftLabel(push.endsAt, now);

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
      if (push.nativeUrlScheme) {
        void launchNativeApp({
          nativeUrlScheme: push.nativeUrlScheme,
          appName: push.title,
          appId: push.externalAppId,
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
      {push.kind === "app" ? (
        // An app's mark resolves through the ONE shared chain the launcher
        // tile and the unlock modal use — logo → the staff-chosen emoji → the
        // initial, on the app's own tint — so the same app cannot look like
        // two different things on one screen. The Pressable already names it.
        <AppTileMark
          name={push.title}
          iconUrl={push.iconUrl ?? null}
          iconEmoji={push.iconEmoji ?? null}
          color={push.color ?? null}
          // 16 on a 44pt tile is the same mark:tile ratio the launcher (28 on
          // 80) and the unlock modal use, so the initial is the same weight
          // wherever a scholar meets this app — and it matches web's card.
          markFontSize={16}
          decorative
          style={styles.icon}
        />
      ) : (
        // A video, link or activity has no catalog tile: its glyph names the
        // KIND of thing, and shared/pushCopy.ts owns that word so the web and
        // iPad strips can't drift. Only an app carries a catalog `color`, so
        // this square is always the strip's own violet.
        <View style={[styles.icon, styles.kindIcon]}>
          <Text style={styles.iconGlyph}>{pushGlyph(push)}</Text>
        </View>
      )}
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>
          {push.title}
        </Text>
        {push.note ? (
          <Text style={styles.note} numberOfLines={2}>
            {push.note}
          </Text>
        ) : null}
      </View>
      <View style={styles.trailing}>
        <Text style={styles.action}>{pushActionLabel(push)}</Text>
        {timeLeft ? <Text style={styles.timeLeft}>{timeLeft}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 4,
    gap: 8,
  },
  heading: {
    color: palette.navy[500],
    fontFamily: fonts.semibold,
    fontSize: 11,
    letterSpacing: 1.2,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: palette.violet[200],
    backgroundColor: palette.violet[50],
  },
  cardPressed: { opacity: 0.75 },
  icon: {
    width: 44,
    height: 44,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  kindIcon: { backgroundColor: palette.violet[500] },
  iconGlyph: {
    color: colors.white,
    fontFamily: fonts.semibold,
    fontSize: 20,
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
  trailing: { alignItems: "flex-end", gap: 2 },
  action: {
    color: palette.violet[700],
    fontFamily: fonts.semibold,
    fontSize: 14,
  },
  timeLeft: {
    color: palette.navy[500],
    fontFamily: fonts.regular,
    fontSize: 12,
  },
});
