// Scholar-UI helpers for TRA-519 PR3: the server functions the done screen and
// Quest page call, plus defensive readers for the B6 fields `units.get`
// carries. Web and native twins.
import { api } from "@/convex/_generated/api";
import { effectiveActivityKind } from "@/shared/appSurface";

/** sessions.startFreePlay({ sessionId, idea? }) — "Build it now". */
export const startFreePlayRef = api.sessions.startFreePlay;

/** sessions.questFromParkedIdea({ sessionId, text }) — "Make it a Quest". */
export const questFromParkedIdeaRef = api.sessions.questFromParkedIdea;

/** quests.appendBuildStep({ unitId }) — the B6 badge-moment unlock. */
export const appendBuildStepRef = api.quests.appendBuildStep;

/** B6 fields `units.get` carries (server lane): `questLocks`, keyed by
 * String(activityId), present only for a scholar's own Quest's locked build
 * steps; and `canUnlockBuild`. */
export type QuestLock = { prerequisiteTitle: string };

/** The lock on one activity of `unit` (a `units.get` result), read
 * defensively so an older backend (no `questLocks`) reads as unlocked. */
export function questLockOf(
  unit: unknown,
  activityId: string | null | undefined,
): QuestLock | null {
  if (!activityId) return null;
  const locks = (unit as { questLocks?: unknown } | null | undefined)
    ?.questLocks;
  if (!locks || typeof locks !== "object") return null;
  const lock = (locks as Record<string, QuestLock | undefined>)[
    String(activityId)
  ];
  return lock && typeof lock.prerequisiteTitle === "string" ? lock : null;
}

/**
 * The activities the in-session "Up next" walks, in unit order: every one that
 * opens a session here — online activities AND app activities (a Quest's build
 * step; the iPad's useUnitProgress counts them too). A build step still locked
 * by a learning step other than `current` is dropped; one that `current`'s
 * completion unlocks stays, since Continue completes `current` first. The
 * current activity is always kept, so its index anchors the forward scan.
 */
export function upNextCandidates<
  A extends { _id: string; title: string; kind: string; appActivity?: boolean | null },
>(ordered: readonly A[], current: { _id: string; title: string }, unit: unknown): A[] {
  return ordered.filter((a) => {
    const kind = effectiveActivityKind(a);
    if (kind !== "online" && kind !== "vibecode") return false;
    if (a._id === current._id) return true;
    const lock = questLockOf(unit, a._id);
    return !lock || lock.prerequisiteTitle === current.title;
  });
}

/** `units.get(...).canUnlockBuild`, read defensively. */
export function canUnlockBuildOf(unit: unknown): boolean {
  return (unit as { canUnlockBuild?: unknown } | null)?.canUnlockBuild === true;
}
