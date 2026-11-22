/**
 * The schedule on a Run page (`api.assignments.get`) result, from whichever
 * key the backend sends. Web and Convex deploy separately, in either order
 * (TRA-13): the backend sends `schedule` and, for one release, the older
 * `activitySchedule` too. The narrow PR (L6) drops the fallback.
 */
export function runSchedule<T>(data: {
  schedule?: ReadonlyArray<T>;
  activitySchedule?: ReadonlyArray<T>;
}): ReadonlyArray<T> {
  return data.schedule ?? data.activitySchedule ?? [];
}
