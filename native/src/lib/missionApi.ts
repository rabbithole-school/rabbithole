// Scholar-UI helpers for TRA-519 PR3: the server functions the done screen and
// Quest page call, plus defensive readers for the B6 fields `units.get`
// carries. Web and native twins.
import { api } from "@/lib/convex";

/** sessions.startFreePlay({ sessionId, idea? }) — "Build it now". */
export const startFreePlayRef = api.sessions.startFreePlay;

/** sessions.questFromParkedIdea({ sessionId, text }) — "Make it a Quest". */
export const questFromParkedIdeaRef = api.sessions.questFromParkedIdea;

/** quests.appendBuildStep({ unitId }) — the B6 badge-moment unlock. */
export const appendBuildStepRef = api.quests.appendBuildStep;

/** B6 fields `units.get` carries (server lane): `questLocks`, keyed by
 * String(activityId), present only for a scholar's own Quest's locked build
 * steps; and `canUnlockBuild`. */
export type QuestLock = { prerequisiteTitle: string; prerequisiteId?: string };

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

/** `units.get(...).canUnlockBuild`, read defensively. */
export function canUnlockBuildOf(unit: unknown): boolean {
  return (unit as { canUnlockBuild?: unknown } | null)?.canUnlockBuild === true;
}

/**
 * The session header's lock line for an adjacent locked build step, or null.
 * When the step it waits on is the one the scholar is in now, "Unlocks when
 * you finish <this activity>" reads as this activity being locked behind
 * itself; the greyed arrow already says "not yet", and the build step's own
 * row keeps the full line. Older servers send no prerequisiteId: fall back to
 * comparing titles.
 */
export function headerLockLine(
  lock: QuestLock | null,
  current: { id: string; title?: string | null },
): QuestLock | null {
  if (!lock) return null;
  const isCurrent = lock.prerequisiteId
    ? lock.prerequisiteId === current.id
    : !!current.title && lock.prerequisiteTitle === current.title;
  return isCurrent ? null : lock;
}
