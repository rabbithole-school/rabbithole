import { useMemo } from "react";
import { useConvex, useMutation, useQuery } from "convex/react";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";

import { api, type Id } from "@/lib/convex";
import { openWebActivity } from "@/lib/externalAppHost";
import { openGameActivity } from "@/lib/gameHost";
import { webEmbedUrlError } from "@/lib/webEmbedConfig";
import { fonts, palette, useColors } from "@/theme";
import {
  ResourceShareCard,
  type ResourceShare,
} from "@/components/ResourceShareCard";

const COLUMN_MAX_WIDTH = 720;

type LessonRow = {
  _id: Id<"lessons">;
  title: string;
  order: number;
  durationMinutes: number | null;
};

type ActivityRowData = {
  _id: Id<"activities">;
  lessonId?: Id<"lessons"> | null;
  title: string;
  description: string | null;
  kind:
    | "online"
    | "offline"
    | "shareBack"
    | "web"
    | "problem_set"
    | "game"
    | "simulator"
    | "vibecode";
  durationMinutes: number | null;
  order: number;
  resources: Array<ResourceShare & { _id: Id<"activityResources"> }>;
};

type ActivityState = "done" | "current" | "not-started";

function stateMeta(c: ReturnType<typeof useColors>): Record<
  ActivityState,
  {
    icon: SymbolViewProps["name"];
    label: string;
    tint: string;
    background: string;
    border: string;
  }
> {
  return {
    done: {
      icon: "checkmark.circle.fill",
      label: "Done",
      tint: c.green,
      background: palette.green[50],
      border: palette.green[200],
    },
    current: {
      icon: "arrow.right.circle.fill",
      label: "Current",
      tint: c.violet,
      background: c.violetSubtle,
      border: palette.violet[200],
    },
    "not-started": {
      icon: "circle",
      label: "Not started",
      tint: c.gray300,
      background: c.bg,
      border: c.border,
    },
  };
}

type ActivityItem = {
  activity: ActivityRowData;
  state: ActivityState;
};

type LessonSection = {
  lesson: LessonRow;
  activities: ActivityItem[];
};

function kindLabel(kind: ActivityRowData["kind"]): string {
  switch (kind) {
    case "online":
      return "Rabbithole";
    case "offline":
      return "Hands-on";
    case "shareBack":
      return "Share back";
    case "web":
      return "Web";
    case "problem_set":
      return "Problem set";
    case "game":
      return "Game";
    case "simulator":
      return "Simulator";
    case "vibecode":
      return "Vibecode";
  }
}

export default function UnitProgressScreen() {
  const router = useRouter();
  const convex = useConvex();
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { unitId: unitIdParam, title, assignmentId: assignmentIdParam } =
    useLocalSearchParams<{
      unitId?: string;
      title?: string;
      assignmentId?: string;
    }>();
  const unitId = unitIdParam ? (unitIdParam as Id<"units">) : null;
  const assignmentId = assignmentIdParam
    ? (assignmentIdParam as Id<"assignments">)
    : null;

  const unit = useQuery(api.units.get, unitId ? { id: unitId } : "skip");
  const lessons = useQuery(
    api.lessons.listByUnitPublic,
    unitId ? { unitId } : "skip",
  );
  const activities = useQuery(
    api.activities.listByUnitPublic,
    unitId
      ? {
          unitId,
          assignmentId: assignmentId ?? undefined,
          includeResources: true,
        }
      : "skip",
  );
  const completions = useQuery(
    api.activityCompletions.listForScholarInUnit,
    unitId ? { unitId, assignmentId: assignmentId ?? undefined } : "skip",
  );
  const activeSessions = useQuery(
    api.sessions.list,
    unitId ? { asLearner: true } : "skip",
  );
  const createSession = useMutation(api.sessions.create);

  const completedSet = useMemo(() => {
    const set = new Set<string>();
    for (const completion of completions ?? []) {
      set.add(String(completion.activityId));
    }
    return set;
  }, [completions]);

  const outline = useMemo<LessonSection[]>(() => {
    if (!lessons || !activities) return [];

    const activitiesByLesson = new Map<string, ActivityRowData[]>();
    for (const activity of activities as ActivityRowData[]) {
      if (!activity.lessonId) continue;
      const key = String(activity.lessonId);
      const list = activitiesByLesson.get(key);
      if (list) list.push(activity);
      else activitiesByLesson.set(key, [activity]);
    }

    for (const list of activitiesByLesson.values()) {
      list.sort((a, b) => a.order - b.order);
    }

    let markedCurrent = false;
    return (lessons as LessonRow[])
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((lesson) => {
        const lessonActivities = activitiesByLesson.get(String(lesson._id)) ?? [];
        return {
          lesson,
          activities: lessonActivities.map((activity) => {
            let state: ActivityState;
            if (completedSet.has(String(activity._id))) {
              state = "done";
            } else if (!markedCurrent) {
              state = "current";
              markedCurrent = true;
            } else {
              state = "not-started";
            }
            return { activity, state };
          }),
        };
      })
      .filter((section) => section.activities.length > 0);
  }, [activities, completedSet, lessons]);

  const activityTotal = outline.reduce(
    (sum, section) => sum + section.activities.length,
    0,
  );
  const completedCount = outline.reduce(
    (sum, section) =>
      sum + section.activities.filter((item) => item.state === "done").length,
    0,
  );
  const progressPct =
    activityTotal > 0 ? Math.round((completedCount / activityTotal) * 100) : 0;
  const progressLabel =
    activityTotal === 0
      ? "No activities yet"
      : completedCount === activityTotal
        ? "Unit complete"
        : `${completedCount} of ${activityTotal} done`;
  const nextLaunchable = outline
    .flatMap((section) => section.activities)
    .find(
      (item) =>
        (item.activity.kind === "online" ||
          item.activity.kind === "simulator" ||
          item.activity.kind === "vibecode" ||
          item.activity.kind === "web" ||
          item.activity.kind === "game") &&
        !completedSet.has(String(item.activity._id)),
    );
  const openWebActivityRow = async (activity: ActivityRowData) => {
    Haptics.selectionAsync();
    try {
      const detail = await convex.query(api.activities.getPublic, {
        id: activity._id,
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
        activityId: activity._id,
        ...(assignmentId ? { assignmentId } : {}),
        title: detail?.title ?? activity.title,
        url: webUrl,
        allowedHosts: detail?.webAllowedHosts ?? null,
        externalAppId: detail?.externalAppId ?? null,
        gestureMode: "page",
      });
    } catch (e) {
      console.warn("[web-activity] launch failed", e);
      Alert.alert(
        "Couldn’t open this activity",
        "Check your connection and try again.",
      );
    }
  };
  const openGameActivityRow = (activity: ActivityRowData) => {
    Haptics.selectionAsync();
    openGameActivity({
      activityId: activity._id,
      ...(assignmentId ? { assignmentId } : {}),
      activityTitle: activity.title,
    });
  };
  const openNextLaunchable = async () => {
    if (!nextLaunchable) return;
    if (nextLaunchable.activity.kind === "web") {
      await openWebActivityRow(nextLaunchable.activity);
      return;
    }
    if (nextLaunchable.activity.kind === "game") {
      openGameActivityRow(nextLaunchable.activity);
      return;
    }
    const existing = (activeSessions ?? []).find(
      (s) =>
        s.activityId &&
        String(s.activityId) === String(nextLaunchable.activity._id) &&
        (assignmentId
          ? String(s.assignmentId ?? "") === String(assignmentId)
          : s.assignmentId === undefined),
    );
    if (existing?.id) {
      router.push({
        pathname: "/session/[id]",
        params: {
          id: existing.id as Id<"sessions">,
          title: nextLaunchable.activity.title,
        },
      });
      return;
    }
    try {
      const result = await createSession({
        activityId: nextLaunchable.activity._id,
        ...(assignmentId ? { assignmentId } : {}),
      });
      if (result?.id) {
        router.push({
          pathname: "/session/[id]",
          params: { id: result.id, title: nextLaunchable.activity.title },
        });
      }
    } catch (error) {
      console.warn("[unit-progress] activity launch failed", error);
      Alert.alert(
        "Couldn't start that activity",
        "Please try again.",
      );
    }
  };
  const screenTitle = unit?.title ?? title ?? "Unit progress";
  const loading =
    !!unitId &&
    (unit === undefined ||
      lessons === undefined ||
      activities === undefined ||
      completions === undefined);

  if (!unitId) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Unit progress" }} />
        <Text style={styles.emptyTitle}>Unit not found</Text>
        <Text style={styles.emptyBody}>
          Go back to Home and open progress from a unit card.
        </Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: screenTitle }} />
        <ActivityIndicator size="large" color={colors.violet} />
      </View>
    );
  }

  if (unit === null) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Unit progress" }} />
        <Text style={styles.emptyTitle}>Unit not found</Text>
        <Text style={styles.emptyBody}>
          This unit may have moved. Go back to Home and try again.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Stack.Screen options={{ title: screenTitle }} />

      <View style={styles.headerCard}>
        <View style={styles.headerTop}>
          <View style={styles.emojiBadge}>
            <Text style={styles.emoji}>{unit?.emoji ?? "🧭"}</Text>
          </View>
          <View style={styles.headerText}>
            <Text style={styles.eyebrow}>WHERE YOU ARE</Text>
            <Text style={styles.title} numberOfLines={2}>
              {screenTitle}
            </Text>
          </View>
        </View>
        <View style={styles.progressRow}>
          <Text style={styles.progressLabel}>{progressLabel}</Text>
          {activityTotal > 0 && (
            <Text style={styles.progressPercent}>{progressPct}%</Text>
          )}
        </View>
        <View style={styles.progressTrack}>
          <View
            style={[
              styles.progressFill,
              { width: `${progressPct}%` as `${number}%` },
            ]}
          />
        </View>
        {nextLaunchable ? (
          <View style={styles.nextUpBlock}>
            <Text style={styles.nextUpLabel}>UP NEXT</Text>
            <Text style={styles.nextUpTitle} numberOfLines={2}>
              {nextLaunchable.activity.title}
            </Text>
            <Pressable
              onPress={openNextLaunchable}
              accessibilityRole="button"
              accessibilityLabel={`Continue to ${nextLaunchable.activity.title}`}
              style={({ pressed }) => [
                styles.continueButton,
                pressed && styles.buttonPressed,
              ]}
            >
              <Text style={styles.continueButtonText}>Continue</Text>
            </Pressable>
          </View>
        ) : activityTotal > 0 && completedCount >= activityTotal ? (
          <Text style={styles.unitCompleteText}>
            Unit complete — every activity is done.
          </Text>
        ) : null}
      </View>

      {outline.length === 0 ? (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyEmoji}>🚧</Text>
          <Text style={styles.emptyTitle}>
            {`${screenTitle} doesn't have activities yet`}
          </Text>
          <Text style={styles.emptyBody}>
            {"Your teacher hasn't added the activity ladder for this unit yet."}
          </Text>
        </View>
      ) : (
        <View style={styles.outlineCard}>
          {outline.map((section, sectionIndex) => {
            const lessonCompleted = section.activities.filter(
              (item) => item.state === "done",
            ).length;
            return (
              <View
                key={String(section.lesson._id)}
                style={[
                  styles.lessonBlock,
                  sectionIndex > 0 && styles.lessonBlockDivider,
                ]}
              >
                <View style={styles.lessonHeader}>
                  <Text style={styles.lessonTitle} numberOfLines={1}>
                    {section.lesson.title}
                  </Text>
                  <View style={styles.lessonBadge}>
                    <Text style={styles.lessonBadgeText}>
                      {lessonCompleted}/{section.activities.length}
                    </Text>
                  </View>
                </View>
                {section.activities.map((item) => (
                  <ActivityProgressRow
                    key={String(item.activity._id)}
                    item={item}
                    onOpenWeb={openWebActivityRow}
                    onOpenGame={openGameActivityRow}
                  />
                ))}
              </View>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

function ActivityProgressRow({
  item,
  onOpenWeb,
  onOpenGame,
}: {
  item: ActivityItem;
  onOpenWeb: (activity: ActivityRowData) => void;
  onOpenGame: (activity: ActivityRowData) => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const meta = stateMeta(colors)[item.state];
  const detail = [
    kindLabel(item.activity.kind),
    item.activity.durationMinutes ? `${item.activity.durationMinutes} min` : null,
  ].filter(Boolean) as string[];

  const isWeb = item.activity.kind === "web";
  const isGame = item.activity.kind === "game";
  const openable = isWeb || isGame;
  return (
    <View>
      <Pressable
        onPress={
          isWeb
            ? () => onOpenWeb(item.activity)
            : isGame
              ? () => onOpenGame(item.activity)
              : undefined
        }
        disabled={!openable}
        accessibilityRole={openable ? "button" : undefined}
        accessibilityLabel={openable ? `Open ${item.activity.title}` : undefined}
        style={({ pressed }) => [
          styles.activityRow,
          { backgroundColor: meta.background, borderColor: meta.border },
          item.state === "current" && styles.currentRow,
          pressed && openable && styles.buttonPressed,
        ]}
      >
        <View style={styles.stateIconWrap}>
          <SymbolView name={meta.icon} size={22} tintColor={meta.tint} />
        </View>
        <View style={styles.activityText}>
          <View style={styles.activityTitleRow}>
            <Text
              style={[
                styles.activityTitle,
                item.state === "done" && styles.doneTitle,
              ]}
              numberOfLines={2}
            >
              {item.activity.title}
            </Text>
            <Text style={[styles.stateLabel, { color: meta.tint }]}>
              {meta.label}
            </Text>
          </View>
          {item.activity.description && (
            <Text style={styles.activityDescription} numberOfLines={2}>
              {item.activity.description}
            </Text>
          )}
          {detail.length > 0 && (
            <Text style={styles.activityMeta}>{detail.join(" · ")}</Text>
          )}
        </View>
        {isWeb ? <Text style={styles.webOpen}>Open ›</Text> : null}
      </Pressable>
      {item.activity.resources.length > 0 ? (
        <View style={styles.activityResources}>
          {item.activity.resources.map((resource) => (
            <ResourceShareCard
              key={String(resource._id)}
              resource={resource}
              compact
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
  flex: { flex: 1, backgroundColor: c.bgSubtle },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.bgSubtle,
    padding: 24,
  },
  content: {
    width: "100%",
    maxWidth: COLUMN_MAX_WIDTH,
    alignSelf: "center",
    paddingHorizontal: 24,
    paddingVertical: 22,
  },
  activityResources: {
    gap: 6,
    paddingLeft: 44,
    paddingRight: 8,
    paddingBottom: 8,
  },
  headerCard: {
    backgroundColor: c.white,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: c.border,
    padding: 20,
    marginBottom: 16,
    shadowColor: c.navy,
    shadowOpacity: 0.06,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
  },
  headerTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    marginBottom: 18,
  },
  emojiBadge: {
    width: 54,
    height: 54,
    borderRadius: 16,
    backgroundColor: c.violetSubtle,
    alignItems: "center",
    justifyContent: "center",
  },
  emoji: { fontSize: 28 },
  headerText: { flex: 1, minWidth: 0 },
  eyebrow: {
    fontSize: 12,
    letterSpacing: 1.15,
    fontFamily: fonts.bold,
    color: c.violet,
    marginBottom: 3,
  },
  title: {
    fontSize: 24,
    lineHeight: 30,
    fontFamily: fonts.bold,
    color: c.navy,
  },
  progressRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 8,
  },
  progressLabel: {
    fontSize: 15,
    fontFamily: fonts.semibold,
    color: c.charcoal,
  },
  progressPercent: {
    fontSize: 13,
    fontFamily: fonts.semibold,
    color: c.fgMuted,
  },
  progressTrack: {
    height: 7,
    borderRadius: 999,
    overflow: "hidden",
    backgroundColor: c.gray200,
  },
  progressFill: {
    height: "100%",
    borderRadius: 999,
    backgroundColor: c.violet,
  },
  nextUpBlock: {
    marginTop: 18,
  },
  nextUpLabel: {
    fontSize: 11,
    letterSpacing: 1.1,
    fontFamily: fonts.bold,
    color: c.fgMuted,
    marginBottom: 3,
  },
  nextUpTitle: {
    fontSize: 15,
    lineHeight: 20,
    fontFamily: fonts.semibold,
    color: c.charcoal,
  },
  continueButton: {
    alignSelf: "flex-start",
    marginTop: 12,
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 20,
    backgroundColor: c.violet,
  },
  continueButtonText: {
    fontSize: 14.5,
    fontFamily: fonts.semibold,
    color: c.white,
  },
  buttonPressed: { opacity: 0.78 },
  unitCompleteText: {
    marginTop: 14,
    fontSize: 14.5,
    lineHeight: 21,
    fontFamily: fonts.semibold,
    color: c.green,
  },
  outlineCard: {
    backgroundColor: c.white,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: c.border,
    overflow: "hidden",
  },
  lessonBlock: { padding: 14, gap: 10 },
  lessonBlockDivider: { borderTopWidth: 1, borderTopColor: c.border },
  lessonHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 4,
  },
  lessonTitle: {
    flex: 1,
    fontSize: 15,
    fontFamily: fonts.bold,
    color: c.navy,
  },
  lessonBadge: {
    borderRadius: 999,
    backgroundColor: c.gray100,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  lessonBadgeText: {
    fontSize: 12,
    fontFamily: fonts.semibold,
    color: c.charcoalMuted,
  },
  activityRow: {
    flexDirection: "row",
    gap: 12,
    borderRadius: 15,
    borderWidth: 1,
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginTop: 8,
  },
  currentRow: {
    shadowColor: c.violet,
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  stateIconWrap: {
    width: 26,
    alignItems: "center",
    paddingTop: 1,
  },
  activityText: { flex: 1, minWidth: 0, gap: 4 },
  activityTitleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
  },
  activityTitle: {
    flex: 1,
    fontSize: 16,
    lineHeight: 21,
    fontFamily: fonts.semibold,
    color: c.charcoal,
  },
  doneTitle: { color: c.charcoalMuted },
  stateLabel: {
    fontSize: 12,
    fontFamily: fonts.bold,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: 2,
  },
  activityDescription: {
    fontSize: 14,
    lineHeight: 20,
    fontFamily: fonts.regular,
    color: c.charcoalMuted,
  },
  activityMeta: {
    fontSize: 12.5,
    fontFamily: fonts.medium,
    color: c.charcoalSubtle,
  },
  webOpen: {
    marginLeft: 12,
    alignSelf: "center",
    fontSize: 14,
    fontFamily: fonts.semibold,
    color: c.violet,
  },
  emptyCard: {
    alignItems: "center",
    backgroundColor: c.white,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: c.border,
    padding: 26,
  },
  emptyEmoji: { fontSize: 30, marginBottom: 8 },
  emptyTitle: {
    fontSize: 18,
    lineHeight: 24,
    fontFamily: fonts.bold,
    color: c.navy,
    textAlign: "center",
    marginBottom: 6,
  },
  emptyBody: {
    maxWidth: 420,
    fontSize: 15,
    lineHeight: 22,
    fontFamily: fonts.regular,
    color: c.fgMuted,
    textAlign: "center",
  },
});
}
