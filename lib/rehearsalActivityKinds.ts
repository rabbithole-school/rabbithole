import type { ActivityKind } from "./activityKinds";

export type RehearsalSurface =
  | "scholar-bot"
  | "vibecode"
  | "simulator"
  | "unavailable";

export function rehearsalSurfaceForActivityKind(
  kind: ActivityKind,
): RehearsalSurface {
  if (kind === "online") return "scholar-bot";
  if (kind === "vibecode") return "vibecode";
  if (kind === "simulator") return "simulator";
  return "unavailable";
}

export function isRehearsableActivityKind(kind: ActivityKind): boolean {
  return rehearsalSurfaceForActivityKind(kind) !== "unavailable";
}
