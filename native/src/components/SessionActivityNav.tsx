import { useState } from "react";
import { useConvex, useMutation, useQuery } from "convex/react";
import { useRouter } from "expo-router";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";

import { useUnitProgress } from "@/hooks/useUnitProgress";
import { api, type Id } from "@/lib/convex";
import { openWebActivity } from "@/lib/externalAppHost";
import { openGameActivity } from "@/lib/gameHost";
import { webEmbedUrlError } from "@/lib/webEmbedConfig";
import { colors, fonts } from "@/theme";

type Props = {
  sessionId: Id<"sessions">;
  unitId?: Id<"units"> | null;
  activityId?: Id<"activities"> | null;
  assignmentId?: Id<"assignments"> | null;
};

/**
 * Compact in-session activity navigator — "Activity N of M" + prev/next
 * chevrons. Lets a scholar step between the activities of a unit without
 * returning to the home screen.
 *
 * Renders nothing when the unit has ≤1 activity, or when unitId is absent.
 */
export function SessionActivityNav({
  unitId,
  activityId,
  assignmentId,
}: Props) {
  const router = useRouter();
  const convex = useConvex();
  const createSession = useMutation(api.sessions.create);
  const [navigating, setNavigating] = useState<"prev" | "next" | null>(null);

  const progress = useUnitProgress({
    unitId,
    activityId,
    assignmentId,
    enabled: !!unitId,
  });

  // Load active sessions so we can jump to an existing session for an adjacent
  // activity instead of always creating a new one.
  const activeSessions = useQuery(api.sessions.list, { asLearner: true });

  const { flatActivities } = progress;

  // Don't render for single-activity units or when there's no unit context.
  if (!unitId || flatActivities.length <= 1) return null;

  const currentIdx = flatActivities.findIndex(
    (item) => activityId && String(item.activity._id) === String(activityId),
  );
  if (currentIdx === -1) return null;

  const currentItem = flatActivities[currentIdx];
  const prevItem = currentIdx > 0 ? flatActivities[currentIdx - 1] : null;
  const nextItem = currentItem.isCompleted
    ? progress.nextIncompleteOnlineActivity
    : currentIdx < flatActivities.length - 1
      ? flatActivities[currentIdx + 1]
      : null;
  const showUpNext = currentItem.isCompleted && !!progress.nextIncompleteOnlineActivity;

  // activityId → sessionId map from the scholar's existing sessions.
  const sessionByActivity = new Map<string, Id<"sessions">>();
  for (const s of activeSessions ?? []) {
    const sameAssignment = assignmentId
      ? String(s.assignmentId ?? "") === String(assignmentId)
      : s.assignmentId === undefined;
    if (s.activityId && sameAssignment) {
      // list returns `{ ...session, id: session._id }` — use `id` as the Id.
      sessionByActivity.set(String(s.activityId), s.id as Id<"sessions">);
    }
  }

  const goTo = async (
    targetActivity: (typeof flatActivities)[number]["activity"],
    direction: "prev" | "next",
  ) => {
    if (navigating) return;
    Haptics.selectionAsync();
    setNavigating(direction);
    try {
      if (targetActivity.kind === "web") {
        const detail = await convex.query(api.activities.getPublic, {
          id: targetActivity._id,
        });
        const webUrl = detail?.webUrl;
        if (!webUrl) {
          Alert.alert(
            "No website yet",
            "Ask your teacher to add the website URL for this activity.",
          );
          return;
        }
        const urlError = webEmbedUrlError(webUrl);
        if (urlError) {
          Alert.alert("Couldn’t open this activity", urlError);
          return;
        }
        openWebActivity({
          activityId: targetActivity._id,
          ...(assignmentId ? { assignmentId } : {}),
          title: detail?.title ?? targetActivity.title,
          url: webUrl,
          allowedHosts: detail?.webAllowedHosts ?? null,
          externalAppId: detail?.externalAppId ?? null,
          gestureMode: "page",
        });
        return;
      }
      if (targetActivity.kind === "game") {
        openGameActivity({
          activityId: targetActivity._id,
          ...(assignmentId ? { assignmentId } : {}),
          activityTitle: targetActivity.title,
        });
        return;
      }
      const existing = sessionByActivity.get(String(targetActivity._id));
      if (existing) {
        // Replace, don't push: stepping between a unit's activities swaps the
        // current one on the stack instead of nesting home > act1 > act2, so a
        // back-swipe from any activity returns to home (both directions).
        router.replace({ pathname: "/session/[id]", params: { id: existing } });
      } else {
        const result = await createSession({
          activityId: targetActivity._id,
          ...(assignmentId ? { assignmentId } : {}),
        });
        if (result?.id) {
          router.replace({
            pathname: "/session/[id]",
            params: { id: result.id },
          });
        }
      }
    } catch (e) {
      console.warn("[activity-nav] navigation failed", e);
      Alert.alert(
        "Couldn’t open this activity",
        "Check your connection and try again.",
      );
    } finally {
      setNavigating(null);
    }
  };

  const position = currentIdx + 1;
  const total = flatActivities.length;

  return (
    <View style={styles.wrap}>
      <View style={styles.bar}>
      <Pressable
        onPress={() => prevItem && goTo(prevItem.activity, "prev")}
        disabled={!prevItem || !!navigating}
        hitSlop={12}
        style={styles.chevron}
      >
        {navigating === "prev" ? (
          <ActivityIndicator size="small" color={colors.violet} />
        ) : (
          <SymbolView
            name="chevron.left"
            size={18}
            tintColor={prevItem ? colors.violet : colors.gray300}
          />
        )}
      </Pressable>

      <Text style={styles.label}>
        Activity {position} of {total}
      </Text>

      <Pressable
        onPress={() => nextItem && goTo(nextItem.activity, "next")}
        disabled={!nextItem || !!navigating}
        hitSlop={12}
        style={styles.chevron}
      >
        {navigating === "next" ? (
          <ActivityIndicator size="small" color={colors.violet} />
        ) : (
          <SymbolView
            name="chevron.right"
            size={18}
            tintColor={nextItem ? colors.violet : colors.gray300}
          />
        )}
      </Pressable>
      </View>
      {showUpNext && progress.nextIncompleteOnlineActivity ? (
        <View style={styles.upNextRow}>
          <View style={styles.upNextInfo}>
            <Text style={styles.upNextLabel}>UP NEXT</Text>
            <Text style={styles.upNextTitle} numberOfLines={1}>
              {progress.nextIncompleteOnlineActivity.activity.title}
            </Text>
          </View>
          <Pressable
            onPress={() =>
              goTo(progress.nextIncompleteOnlineActivity!.activity, "next")
            }
            disabled={!!navigating}
            accessibilityRole="button"
            accessibilityLabel={`Continue to ${progress.nextIncompleteOnlineActivity.activity.title}`}
            style={({ pressed }) => [
              styles.continueButton,
              (pressed || !!navigating) && styles.continueButtonPressed,
            ]}
          >
            {navigating === "next" ? (
              <ActivityIndicator size="small" color={colors.white} />
            ) : (
              <Text style={styles.continueButtonText}>Continue</Text>
            )}
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.white,
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    paddingVertical: 9,
    paddingHorizontal: 20,
    backgroundColor: colors.white,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  chevron: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
  },
  upNextRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginHorizontal: 20,
    marginBottom: 9,
  },
  upNextInfo: { flex: 1, minWidth: 0 },
  upNextLabel: {
    fontSize: 11,
    letterSpacing: 1.1,
    fontFamily: fonts.bold,
    color: colors.fgMuted,
    marginBottom: 2,
  },
  upNextTitle: {
    fontSize: 14,
    fontFamily: fonts.semibold,
    color: colors.charcoal,
  },
  continueButton: {
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 18,
    minWidth: 96,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.violet,
  },
  continueButtonPressed: { opacity: 0.78 },
  continueButtonText: {
    fontSize: 14,
    fontFamily: fonts.semibold,
    color: colors.white,
  },
  label: {
    fontSize: 14,
    fontFamily: fonts.semibold,
    color: colors.charcoal,
    letterSpacing: 0.1,
  },
});
