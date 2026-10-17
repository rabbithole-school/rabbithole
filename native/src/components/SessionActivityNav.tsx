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
import { findActivitySession } from "@/lib/activitySession";
import { api, type Id } from "@/lib/convex";
import { openWebActivity } from "@/lib/externalAppHost";
import { openGameActivity } from "@/lib/gameHost";
import { webEmbedUrlError } from "@/lib/webEmbedConfig";
import { serverRefusal } from "../../vendor/shared/serverErrorMessage";
import { questBuildLockLabel } from "../../vendor/shared/missionCopy";
import { headerLockLine, questLockOf } from "@/lib/missionApi";
import {
  parseActivityNavPosition,
  type ActivityNavPosition,
} from "@/lib/activityNavPosition";

export { parseActivityNavPosition, type ActivityNavPosition };
import { colors, fonts } from "@/theme";

/** Why opening an activity failed: a deliberate refusal (a locked Quest build
 * step) says why; anything else is most likely the network. Module-level so
 * the component's catch holds no value block (React Compiler). */
function openFailureMessage(error: unknown): string {
  return serverRefusal(error) ?? "Check your connection and try again.";
}

type Props = {
  sessionId: Id<"sessions">;
  unitId?: Id<"units"> | null;
  activityId?: Id<"activities"> | null;
  assignmentId?: Id<"assignments"> | null;
  /**
   * The session screen's `shouldSkipLearnerQueries` verdict. `sessions.list`
   * with `asLearner` throws "A learner membership is required" for staff, so a
   * teacher's test drive must not mount it (TRA-321).
   */
  skipLearnerQueries: boolean;
  /** Where the arrow that opened this session was headed ("Activity N of
   * M"), so the bar is drawn at once instead of popping in when the unit's
   * progress arrives. */
  pending?: ActivityNavPosition | null;
};

/**
 * The bar's exact frame, drawn while the session or the unit's progress
 * loads: same height and label, arrows idle. The real bar replaces it in
 * place, so nothing below shifts.
 */
export function ActivityNavPlaceholder({ position, total }: ActivityNavPosition) {
  return (
    <View style={styles.wrap}>
      <View style={styles.bar}>
        <View style={styles.chevron}>
          <SymbolView name="chevron.left" size={18} tintColor={colors.gray300} />
        </View>
        <Text style={styles.label}>
          Activity {position} of {total}
        </Text>
        <View style={styles.chevron}>
          <SymbolView name="chevron.right" size={18} tintColor={colors.gray300} />
        </View>
      </View>
    </View>
  );
}

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
  skipLearnerQueries,
  pending,
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
  // activity instead of always creating a new one. Skipped with no unit (the
  // nav renders nothing) and wherever the session screen skips its own
  // learner-only queries.
  const activeSessions = useQuery(
    api.sessions.list,
    unitId && !skipLearnerQueries ? { asLearner: true } : "skip",
  );

  const { flatActivities } = progress;

  // Don't render for single-activity units or when there's no unit context.
  // While the unit's progress is still loading, hold the bar's frame.
  if (!unitId) return null;
  if (flatActivities.length === 0) {
    return pending ? <ActivityNavPlaceholder {...pending} /> : null;
  }
  if (flatActivities.length <= 1) return null;

  const currentIdx = flatActivities.findIndex(
    (item) => activityId && String(item.activity._id) === String(activityId),
  );
  if (currentIdx === -1) {
    return pending ? <ActivityNavPlaceholder {...pending} /> : null;
  }

  const currentItem = flatActivities[currentIdx];
  const prevItem = currentIdx > 0 ? flatActivities[currentIdx - 1] : null;
  const nextItem = currentItem.isCompleted
    ? progress.nextIncompleteOnlineActivity
    : currentIdx < flatActivities.length - 1
      ? flatActivities[currentIdx + 1]
      : null;
  const showUpNext = currentItem.isCompleted && !!progress.nextIncompleteOnlineActivity;
  // B6: a locked Quest build step is never a tap target here; its unlock line
  // shows instead (the same words as the Quest page's locked row).
  const prevLock = prevItem
    ? questLockOf(progress.unit, String(prevItem.activity._id))
    : null;
  const nextLock = nextItem
    ? questLockOf(progress.unit, String(nextItem.activity._id))
    : null;
  // No line when the lock waits on the step the scholar is in (see
  // headerLockLine); the greyed arrow carries "not yet".
  const lockLine = headerLockLine(nextLock ?? prevLock, {
    id: String(currentItem.activity._id),
    title: currentItem.activity.title,
  });
  const prevOpen = !!prevItem && !prevLock;
  const nextOpen = !!nextItem && !nextLock;

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
      // What the next screen draws before its own data arrives: its title and
      // the bar's "Activity N of M", so neither pops in.
      const targetIdx = flatActivities.findIndex(
        (item) => String(item.activity._id) === String(targetActivity._id),
      );
      const arrival = {
        title: targetActivity.title,
        ...(targetIdx >= 0
          ? {
              navPos: String(targetIdx + 1),
              navTotal: String(flatActivities.length),
            }
          : {}),
      };
      const existing = findActivitySession(
        activeSessions,
        targetActivity._id,
        assignmentId,
      );
      // Swap the session IN PLACE (this route's params), not a new screen: a
      // screen transition makes iPadOS 26 morph every header item. The stack
      // stays home > activity, so a back-swipe from any activity returns home.
      if (existing) {
        // Replace, don't push: stepping between a unit's activities swaps the
        // current one on the stack instead of nesting home > act1 > act2, so a
        // back-swipe from any activity returns to home (both directions).
        // In place, not a new screen: the header stays put (see the session
        // route). Clear the builder params a previous session may have set.
        router.setParams({
          id: existing,
          navDir: direction,
          view: undefined,
          app: undefined,
          ...arrival,
        });
      } else {
        const result = await createSession({
          activityId: targetActivity._id,
          ...(assignmentId ? { assignmentId } : {}),
        });
        if (result?.id) {
          router.setParams({
            id: result.id,
            navDir: direction,
            view: undefined,
            app: undefined,
            ...arrival,
          });
        }
      }
    } catch (e) {
      console.warn("[activity-nav] navigation failed", e);
      Alert.alert("Couldn’t open this activity", openFailureMessage(e));
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
        onPress={() => prevOpen && prevItem && goTo(prevItem.activity, "prev")}
        disabled={!prevOpen || !!navigating}
        hitSlop={12}
        style={styles.chevron}
      >
        {navigating === "prev" ? (
          <ActivityIndicator size="small" color={colors.violet} />
        ) : (
          <SymbolView
            name="chevron.left"
            size={18}
            tintColor={prevOpen ? colors.violet : colors.gray300}
          />
        )}
      </Pressable>

      <Text style={styles.label}>
        Activity {position} of {total}
      </Text>

      <Pressable
        onPress={() => nextOpen && nextItem && goTo(nextItem.activity, "next")}
        disabled={!nextOpen || !!navigating}
        hitSlop={12}
        style={styles.chevron}
      >
        {navigating === "next" ? (
          <ActivityIndicator size="small" color={colors.violet} />
        ) : (
          <SymbolView
            name="chevron.right"
            size={18}
            tintColor={nextOpen ? colors.violet : colors.gray300}
          />
        )}
      </Pressable>
      </View>
      {lockLine ? (
        <Text style={styles.lockLine} numberOfLines={2}>
          {questBuildLockLabel(lockLine.prerequisiteTitle)}
        </Text>
      ) : null}
      {showUpNext && !nextLock && progress.nextIncompleteOnlineActivity ? (
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
  lockLine: {
    fontSize: 13,
    fontFamily: fonts.regular,
    color: colors.fgMuted,
    textAlign: "center",
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
});
