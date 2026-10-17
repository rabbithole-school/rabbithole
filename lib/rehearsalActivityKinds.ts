import type { ActivityKind } from "./activityKinds";
import { effectiveActivityKind } from "../shared/appSurface";

export type RehearsalSurface =
  | "scholar-bot"
  | "vibecode"
  | "simulator"
  | "unavailable";

/** A bare kind, or an activity (either app-activity shape, TRA-519). Pass the
 * activity whenever you have it: a bare "online" can't tell an app activity
 * ({ kind: "online", appActivity: true }) from a chat one. */
export type RehearsalActivityInput =
  | ActivityKind
  | { kind: ActivityKind; appActivity?: boolean | null };

export function rehearsalSurfaceForActivityKind(
  input: RehearsalActivityInput,
): RehearsalSurface {
  const kind =
    typeof input === "string" ? input : effectiveActivityKind(input);
  if (kind === "online") return "scholar-bot";
  if (kind === "vibecode") return "vibecode";
  if (kind === "simulator") return "simulator";
  return "unavailable";
}

export function isRehearsableActivityKind(
  input: RehearsalActivityInput,
): boolean {
  return rehearsalSurfaceForActivityKind(input) !== "unavailable";
}
