/**
 * When a "Code it" mission (lib/practice/codeItMissions.ts) unlocks for a
 * scholar on their own, with no teacher in the loop (founder decision,
 * Nov 21 2026; review/code-it-practice-offer-proposal.html).
 *
 * Nothing is stored. A mission is unlocked while all of these hold:
 *
 *  1. the scholar is fluent on the mission's skill by DEMONSTRATED practice:
 *     bare `isFluent(row)` (lib/practice/scheduler.ts), so placement,
 *     accelerated and reprobe credit never unlock one;
 *  2. the scholar's "Coding challenges" switch is on (`users.codeItEnabled`
 *     is `true`). It starts off; the scholar turns it on in their account, or
 *     staff do (`users.setCodeItEnabledForUser`). That switch is the whole
 *     gate: nothing checks whether the scholar has used Python before
 *     (founder decision, Nov 21 2026). A teacher's direct offer of a mission
 *     never reads it;
 *  3. the scholar has not dismissed THIS mission (the × on its Quests row,
 *     `users.codeItDismissedSkills`, questProposals.dismissUnlockedCodeIt).
 *     Only that one stops unlocking, so the next one earned fills its slot;
 *     a teacher can still offer it;
 *  4. no unit of theirs at their current school carries the mission's ideaKey
 *     yet: a teacher's offer (waiting or set aside), or a Quest they already
 *     started from an unlock (still there, or taken off their list).
 *
 * The Quests tab shows at most CODE_IT_UNLOCKED_MAX of them, most recently
 * earned first. Every read here is bounded (indexes and `take`), because
 * `questProposals.forSelf` is a reactive query that runs it on every change.
 * No clock is read (T11).
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { isFluent } from "./practice/scheduler";
import {
  CODE_IT_MISSIONS,
  codeItIdeaKey,
  type CodeItMission,
} from "./practice/codeItMissions";

type DbCtx = Pick<QueryCtx, "db">;

/** At most this many unlocked missions show in the Quests list at once. */
export const CODE_IT_UNLOCKED_MAX = 2;

/** The scholar's mastery row for a skill, when they have one. */
async function masteryRow(
  ctx: DbCtx,
  scholarId: Id<"users">,
  skillKey: string,
): Promise<Doc<"practiceMastery"> | null> {
  return await ctx.db
    .query("practiceMastery")
    .withIndex("by_scholar_skill", (q) =>
      q.eq("scholarId", scholarId).eq("skillKey", skillKey),
    )
    .first();
}

/** When the skill was earned: when it became fluent, else its last practice. */
function earnedAt(row: Doc<"practiceMastery">): number {
  return row.becameFluentAt ?? row.lastAttemptAt ?? row.lastPracticedAt ?? 0;
}

/** Is a mission's skill fluent by demonstrated practice? (Rule 1.) */
export async function codeItSkillEarned(
  ctx: DbCtx,
  scholarId: Id<"users">,
  skillKey: string,
): Promise<{ earnedAt: number } | null> {
  const row = await masteryRow(ctx, scholarId, skillKey);
  if (!row || !isFluent(row)) return null;
  return { earnedAt: earnedAt(row) };
}

/** The missions the scholar dismissed one at a time (rule 3). */
export function codeItDismissedSkills(scholar: Doc<"users">): Set<string> {
  return new Set(scholar.codeItDismissedSkills ?? []);
}

/** The ideaKeys already carried by a unit of the scholar's at this school
 *  (rule 4), whatever state the unit is in and whoever made it. */
function takenIdeaKeys(
  ownedUnits: readonly Doc<"units">[],
  schoolId: Id<"institutions">,
): Set<string> {
  const taken = new Set<string>();
  for (const unit of ownedUnits) {
    const key = unit.questApproval?.ideaKey;
    if (key !== undefined && unit.institutionId === schoolId) taken.add(key);
  }
  return taken;
}

export type UnlockedCodeItMission = CodeItMission & { earnedAt: number };

/**
 * The missions unlocked for this scholar at `schoolId` (their current live
 * school, which the caller has already checked), most recently earned first,
 * at most CODE_IT_UNLOCKED_MAX. Empty for anyone who isn't unlocked at all.
 */
export async function unlockedCodeItMissions(
  ctx: DbCtx,
  scholar: Doc<"users">,
  schoolId: Id<"institutions">,
  ownedUnits: readonly Doc<"units">[],
): Promise<UnlockedCodeItMission[]> {
  if (scholar.codeItEnabled !== true) return [];
  const taken = takenIdeaKeys(ownedUnits, schoolId);
  const dismissed = codeItDismissedSkills(scholar);
  const open = CODE_IT_MISSIONS.filter(
    (mission) =>
      !dismissed.has(mission.skillKey) &&
      !taken.has(codeItIdeaKey(mission.skillKey)),
  );
  if (open.length === 0) return [];
  const earned: UnlockedCodeItMission[] = [];
  for (const mission of open) {
    const skill = await codeItSkillEarned(ctx, scholar._id, mission.skillKey);
    if (skill) earned.push({ ...mission, earnedAt: skill.earnedAt });
  }
  if (earned.length === 0) return [];
  earned.sort((a, b) => b.earnedAt - a.earnedAt);
  return earned.slice(0, CODE_IT_UNLOCKED_MAX);
}

/**
 * Why this one mission is not unlocked for the scholar right now, or null
 * when it is (rules 1 to 4; the two-row cap is the list's, not the
 * mission's). Worded for the scholar.
 */
export async function codeItLockedReason(
  ctx: DbCtx,
  scholar: Doc<"users">,
  schoolId: Id<"institutions">,
  ownedUnits: readonly Doc<"units">[],
  skillKey: string,
): Promise<string | null> {
  if (scholar.codeItEnabled !== true) {
    return "Coding challenges are turned off for you.";
  }
  if (codeItDismissedSkills(scholar).has(skillKey)) {
    return "You took this coding challenge off your list.";
  }
  if (takenIdeaKeys(ownedUnits, schoolId).has(codeItIdeaKey(skillKey))) {
    return "You already have this Quest.";
  }
  if (!(await codeItSkillEarned(ctx, scholar._id, skillKey))) {
    return "This coding challenge unlocks when you're fluent on its skill in practice.";
  }
  return null;
}
