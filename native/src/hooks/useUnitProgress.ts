import { useMemo } from "react";
import { useQuery } from "convex/react";

import { api, type Id } from "@/lib/convex";
import { pickNextIncompleteAfter } from "../../vendor/shared/nextIncompleteActivity";

export type UnitProgressLesson = {
  _id: Id<"lessons">;
  title: string;
  order: number;
  durationMinutes: number | null;
};

export type UnitProgressActivity = {
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
};

export type UnitProgressActivityState = "done" | "current" | "not-started";

export type UnitProgressActivityItem = {
  activity: UnitProgressActivity;
  state: UnitProgressActivityState;
  isCompleted: boolean;
  isCurrent: boolean;
  position: number;
};

export type UnitProgressLessonSection = {
  lesson: UnitProgressLesson;
  activities: UnitProgressActivityItem[];
};

export function kindLabel(kind: UnitProgressActivity["kind"]): string {
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

export function useUnitProgress({
  unitId,
  activityId,
  assignmentId,
  enabled = true,
}: {
  unitId?: Id<"units"> | null;
  activityId?: Id<"activities"> | null;
  assignmentId?: Id<"assignments"> | null;
  enabled?: boolean;
}) {
  const shouldQuery = enabled && !!unitId;
  const unit = useQuery(api.units.get, shouldQuery ? { id: unitId } : "skip");
  const lessons = useQuery(
    api.lessons.listByUnitPublic,
    shouldQuery ? { unitId } : "skip",
  );
  const activities = useQuery(
    api.activities.listByUnitPublic,
    shouldQuery
      ? { unitId, assignmentId: assignmentId ?? undefined }
      : "skip",
  );
  const completions = useQuery(
    api.activityCompletions.listForScholarInUnit,
    shouldQuery
      ? { unitId, assignmentId: assignmentId ?? undefined }
      : "skip",
  );

  const completedActivityIds = useMemo(() => {
    const set = new Set<string>();
    for (const completion of completions ?? []) {
      set.add(String(completion.activityId));
    }
    return set;
  }, [completions]);

  const outline = useMemo<UnitProgressLessonSection[]>(() => {
    if (!lessons || !activities) return [];

    const activitiesByLesson = new Map<string, UnitProgressActivity[]>();
    for (const activity of activities as UnitProgressActivity[]) {
      if (!activity.lessonId) continue;
      const key = String(activity.lessonId);
      const list = activitiesByLesson.get(key);
      if (list) {
        list.push(activity);
      } else {
        activitiesByLesson.set(key, [activity]);
      }
    }

    for (const list of activitiesByLesson.values()) {
      list.sort((a, b) => a.order - b.order);
    }

    let fallbackCurrentMarked = false;
    let position = 0;
    return (lessons as UnitProgressLesson[])
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((lesson) => {
        const lessonActivities = activitiesByLesson.get(String(lesson._id)) ?? [];
        return {
          lesson,
          activities: lessonActivities.map((activity) => {
            position += 1;
            const isCompleted = completedActivityIds.has(String(activity._id));
            const isExplicitCurrent =
              !!activityId && String(activity._id) === String(activityId);
            const isFallbackCurrent =
              !activityId && !isCompleted && !fallbackCurrentMarked;
            const isCurrent = isExplicitCurrent || isFallbackCurrent;
            if (isFallbackCurrent) fallbackCurrentMarked = true;
            const state: UnitProgressActivityState = isCurrent
              ? "current"
              : isCompleted
                ? "done"
                : "not-started";

            return {
              activity,
              state,
              isCompleted,
              isCurrent,
              position,
            };
          }),
        };
      })
      .filter((section) => section.activities.length > 0);
  }, [activities, activityId, completedActivityIds, lessons]);

  const flatActivities = useMemo(
    () => outline.flatMap((section) => section.activities),
    [outline],
  );
  const onlineActivities = flatActivities.filter(
    (item) =>
      item.activity.kind === "online" ||
      item.activity.kind === "simulator" ||
      item.activity.kind === "vibecode" ||
      item.activity.kind === "web" ||
      item.activity.kind === "game",
  );
  const activityTotal = onlineActivities.length;
  const completedCount = onlineActivities.filter((item) => item.isCompleted).length;
  const progressPct =
    activityTotal > 0 ? Math.round((completedCount / activityTotal) * 100) : 0;
  const progressLabel =
    activityTotal === 0
      ? "No activities yet"
      : completedCount === activityTotal
        ? "Unit complete"
        : `${completedCount} of ${activityTotal} done`;
  const currentActivity =
    flatActivities.find((item) => item.isCurrent) ??
    (activityId
      ? flatActivities.find((item) => String(item.activity._id) === String(activityId))
      : null) ??
    null;
  const currentLesson = currentActivity
    ? (outline.find((section) =>
        section.activities.some(
          (item) => String(item.activity._id) === String(currentActivity.activity._id),
        ),
      )?.lesson ?? null)
    : null;
  const currentActivityCompleted = activityId
    ? completedActivityIds.has(String(activityId))
    : false;
  const currentOnlineIndex = activityId
    ? onlineActivities.findIndex(
        (item) => String(item.activity._id) === String(activityId),
      )
    : -1;
  // Forward-only: never wrap backward to an earlier incomplete activity (see
  // ../../vendor/shared/nextIncompleteActivity.ts). Home owns routing to
  // earlier holes.
  const nextIncompleteOnlineActivity = pickNextIncompleteAfter(
    onlineActivities,
    currentOnlineIndex,
    (item) => item.isCompleted,
  );
  const loading =
    shouldQuery &&
    (unit === undefined ||
      lessons === undefined ||
      activities === undefined ||
      completions === undefined);

  return {
    unit,
    lessons,
    activities,
    completions,
    completedActivityIds,
    outline,
    flatActivities,
    onlineActivities,
    activityTotal,
    completedCount,
    progressPct,
    progressLabel,
    currentActivity,
    currentLesson,
    currentActivityCompleted,
    nextIncompleteOnlineActivity,
    loading,
  };
}
