import { v } from "convex/values";
import { scholarAdminQuery, scholarAdminMutation } from "./lib/customFunctions";
import { isStaffRole } from "./lib/roles";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  requireScholarsAccessible,
  resolveActiveMembership,
} from "./lib/access";
import {
  hasScholarMembership,
  scholarInstitutionId as resolveScholarInstitutionId,
} from "./lib/scholarEnrollment";
import {
  institutionIdInLens,
  resolveInstitutionLens,
} from "./lib/institutionLens";
import {
  assertCheckpointGroupMembershipAvailable,
  checkpointRowsForGroup,
} from "./lib/practice/checkpointFocus";
import { isProgramGuest } from "./lib/enrollmentStanding";
import {
  EXTENDED_EDUCATION_LABEL,
  includesProgramGuests,
  SCHOLAR_GROUP_PARTICIPATION,
  type ScholarGroupParticipation,
} from "../shared/scholarGroupRouting";
import {
  activityHasScholarWork,
  deleteActivityCascade,
} from "./lib/activityCascade";
import { settlePlacementAppPush } from "./masterSchedule";
// The revocation-recheck primitive lives in its own module so call sites
// OUTSIDE scholarGroups.ts (enrollment transfer, scholar deletion) can reuse
// it too without an import cycle — see lib/scholarGroupUnlocks.ts.
import { recheckUnlocksForRemovedMembers } from "./lib/scholarGroupUnlocks";

async function hasLiveAssignmentsForGroup(
  ctx: MutationCtx,
  groupId: Id<"scholarGroups">,
) {
  const now = Date.now();
  const assignments = await ctx.db
    .query("assignments")
    .withIndex("by_scholar_group", (q) => q.eq("scholarGroupId", groupId))
    .collect();
  return assignments.some(
    (assignment) =>
      !assignment.archivedAt &&
      (assignment.activitySchedule ?? []).some(
        (entry) =>
          entry.setAt !== undefined &&
          entry.setAt !== null &&
          (!entry.endsAt || entry.endsAt > now),
      ),
  );
}

/**
 * Program Handouts are lesson-less, offline ad-hoc activities. A group teardown
 * may hard-delete one only when it has never received scholar work and no other
 * assignment owns its schedule entry; otherwise the normal archive path keeps
 * history resolvable.
 */
async function deleteOwnedOrphanProgramHandouts(
  ctx: MutationCtx,
  assignmentId: Id<"assignments">,
) {
  const assignment = await ctx.db.get(assignmentId);
  if (!assignment) return;
  for (const entry of assignment.activitySchedule ?? []) {
    const activity = await ctx.db.get(entry.activityId);
    if (
      !activity ||
      activity.lessonId ||
      activity.kind !== "offline" ||
      (await activityHasScholarWork(ctx, activity._id))
    ) {
      continue;
    }
    const owners = (await ctx.db.query("assignments").collect()).filter((candidate) =>
      (candidate.activitySchedule ?? []).some(
        (candidateEntry) => candidateEntry.activityId === activity._id,
      ),
    );
    if (owners.length === 1 && owners[0]._id === assignmentId) {
      await deleteActivityCascade(ctx, activity._id);
    }
  }
}

// Named groups of scholars (geckos / honu / etc.). Roster-wide: any
// teacher sees and can edit any group. `teacherId` only records the
// creator. See schema.ts and the scholar-groups TODO item.

/**
 * List all groups (roster-wide), each with its scholarIds. Sorted by
 * name. Membership is returned raw — the picker resolves it against the
 * live scholar list (a scholar deleted out from under a group is simply
 * absent there).
 *
 * Deliberately UNFILTERED by `teacherId`: `scholarAdminQuery` already gates
 * on `isScholarAdminRole` (teacher, school_admin, platform_admin,
 * operations staff), and every one of those roles gets the SAME in-institution roster —
 * including a platform/school admin or operations staff who owns no groups of
 * their own. This is what lets the Math Skills studio's group-scope
 * picker (and every checkpoint-flag / mode-marker / roll-up surface that
 * lives in group scope) reach every group, not just ones the caller
 * created. See the "roster-wide" test coverage below.
 */
export const list = scholarAdminQuery({
  args: { institutionScope: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const lens = await resolveInstitutionLens(
      ctx,
      ctx.user,
      args.institutionScope,
    );
    const groups = (await ctx.db.query("scholarGroups").collect()).filter((group) =>
      institutionIdInLens(lens, group.institutionId),
    );
    groups.sort((a, b) => a.name.localeCompare(b.name));
    return groups.map((g) => ({
      _id: g._id,
      name: g.name,
      emoji: g.emoji ?? null,
      scholarIds: g.scholarIds,
      teacherId: g.teacherId,
      type: g.type ?? null,
      participation:
        g.participation ?? SCHOLAR_GROUP_PARTICIPATION.ENROLLED_ONLY,
      ownerId: g.ownerId ?? null,
    }));
  },
});

async function assertProgramParticipationChange(
  ctx: MutationCtx,
  group: Doc<"scholarGroups">,
  nextParticipation: ScholarGroupParticipation | undefined,
) {
  if (
    !includesProgramGuests(group) ||
    nextParticipation !== "enrolled_only"
  ) {
    return;
  }
  const station = await ctx.db
    .query("captureStations")
    .withIndex("by_group", (q) => q.eq("scholarGroupId", group._id))
    .first();
  if (station) {
    throw new Error(
      "A group with a capture station must remain an Extended education group.",
    );
  }
  if (await hasLiveAssignmentsForGroup(ctx, group._id)) {
    throw new Error(
      "End this program's available activities before changing its participation.",
    );
  }
}

/**
 * Create a group. Optionally seed it with members.
 */
export const create = scholarAdminMutation({
  args: {
    name: v.string(),
    emoji: v.optional(v.string()),
    scholarIds: v.optional(v.array(v.id("users"))),
    type: v.optional(v.string()),
    participation: v.optional(
      v.union(
        v.literal("enrolled_only"),
        v.literal("includes_program_guests"),
      ),
    ),
    ownerId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const name = args.name.trim();
    if (!name) throw new Error("Group name is required.");
    if (args.ownerId) await assertStaffOwner(ctx, args.ownerId);
    await requireScholarsAccessible(ctx, ctx.user, args.scholarIds ?? []);
    const scholarIds = await sanitizeScholarIds(ctx, args.scholarIds ?? []);
    const type = normalizeGroupType(args.type);
    await assertProgramGuestMembership(ctx, scholarIds, args.participation);
    const institutionId =
      (await institutionForRoster(ctx, scholarIds)) ??
      (scholarIds.length === 0
        ? (await resolveActiveMembership(ctx, ctx.user))?.institutionId
        : undefined);
    return await ctx.db.insert("scholarGroups", {
      teacherId: ctx.user._id,
      institutionId,
      name,
      emoji: normalizeEmoji(args.emoji),
      scholarIds,
      type,
      participation: args.participation,
      ownerId: args.ownerId,
    });
  },
});

/**
 * Update a group's display fields, routing type, and/or owner.
 */
export const update = scholarAdminMutation({
  args: {
    groupId: v.id("scholarGroups"),
    name: v.optional(v.string()),
    emoji: v.optional(v.string()),
    type: v.optional(v.union(v.string(), v.null())),
    participation: v.optional(
      v.union(
        v.literal("enrolled_only"),
        v.literal("includes_program_guests"),
      ),
    ),
    // `null` clears the owner (the group stops being anyone's default scope).
    ownerId: v.optional(v.union(v.id("users"), v.null())),
  },
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupId);
    if (!group) throw new Error("Group not found.");
    await requireGroupInstitutionAccess(ctx, group);
    const patch: {
      name?: string;
      emoji?: string | undefined;
      type?: string | undefined;
      participation?: ScholarGroupParticipation;
      ownerId?: Id<"users"> | undefined;
    } = {};
    if (args.name !== undefined) {
      const name = args.name.trim();
      if (!name) throw new Error("Group name cannot be empty.");
      patch.name = name;
    }

    if (args.emoji !== undefined) {
      patch.emoji = normalizeEmoji(args.emoji);
    }
    if (args.type !== undefined) {
      patch.type = normalizeGroupType(args.type);
    }
    if (args.participation !== undefined) {
      await assertProgramGuestMembership(ctx, group.scholarIds, args.participation);
      await assertProgramParticipationChange(ctx, group, args.participation);
      patch.participation = args.participation;
    }
    if (args.ownerId !== undefined) {
      // Only a CHANGE of owner is validated. The dialog round-trips the
      // stored ownerId on every save, so if the owner was deleted or demoted
      // since, asserting on the unchanged value would make unrelated renames
      // fail with an owner error the caller never touched.
      if (args.ownerId && args.ownerId !== group.ownerId) {
        await assertStaffOwner(ctx, args.ownerId);
      }
      patch.ownerId = args.ownerId ?? undefined;
    }
    await ctx.db.patch(args.groupId, patch);
  },
});

/**
 * Replace the full membership of a group.
 */
export const setScholars = scholarAdminMutation({
  args: {
    groupId: v.id("scholarGroups"),
    scholarIds: v.array(v.id("users")),
    participation: v.optional(
      v.union(
        v.literal("enrolled_only"),
        v.literal("includes_program_guests"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupId);
    if (!group) throw new Error("Group not found.");
    await requireGroupInstitutionAccess(ctx, group);
    await requireScholarsAccessible(ctx, ctx.user, args.scholarIds);
    const scholarIds = await sanitizeScholarIds(ctx, args.scholarIds);
    const participation = args.participation ?? group.participation;
    await assertProgramGuestMembership(ctx, scholarIds, participation);
    await assertProgramParticipationChange(ctx, group, participation);
    const institutionId = await institutionForRoster(
      ctx,
      scholarIds,
      group.institutionId,
    );
    if ((await checkpointRowsForGroup(ctx, args.groupId)).length > 0) {
      await assertCheckpointGroupMembershipAvailable(
        ctx,
        args.groupId,
        scholarIds,
      );
    }
    await ctx.db.patch(args.groupId, {
      scholarIds,
      ...(args.participation !== undefined ? { participation } : {}),
      ...(institutionId ? { institutionId } : {}),
    });
    // BOTH directions. A device's allowlist is a projection of group-derived
    // grants and pushes, so an ADDED member gains apps exactly as a removed
    // one loses them; the lease model only ever needed the removals.
    const removed = group.scholarIds.filter((id) => !scholarIds.includes(id));
    const added = scholarIds.filter((id) => !group.scholarIds.includes(id));
    await recheckUnlocksForRemovedMembers(ctx, args.groupId, [
      ...removed,
      ...added,
    ]);
  },
});

/**
 * Add a single scholar to a group (idempotent).
 */
export const addScholar = scholarAdminMutation({
  args: {
    groupId: v.id("scholarGroups"),
    scholarId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupId);
    if (!group) throw new Error("Group not found.");
    await requireGroupInstitutionAccess(ctx, group);
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || !(await hasScholarMembership(ctx, args.scholarId))) {
      throw new Error("Not a scholar.");
    }
    await requireScholarsAccessible(ctx, ctx.user, [args.scholarId]);
    const alreadyPresent = group.scholarIds.includes(args.scholarId);
    const scholarIds = alreadyPresent
      ? group.scholarIds
      : [...group.scholarIds, args.scholarId];
    await assertProgramGuestMembership(ctx, scholarIds, group.participation);
    const institutionId = await institutionForRoster(
      ctx,
      scholarIds,
      group.institutionId,
    );
    if (alreadyPresent && institutionId === group.institutionId) return;
    if ((await checkpointRowsForGroup(ctx, args.groupId)).length > 0) {
      await assertCheckpointGroupMembershipAvailable(ctx, args.groupId, [
        args.scholarId,
      ]);
    }
    await ctx.db.patch(args.groupId, {
      scholarIds,
      ...(institutionId ? { institutionId } : {}),
    });
    // Joining a group grants every app the group grants or pushes, so this
    // opening edge nudges the member's device projection the same way leaving
    // nudges it. Idempotent re-adds return above and never reach here.
    if (!alreadyPresent) {
      await recheckUnlocksForRemovedMembers(ctx, args.groupId, [args.scholarId]);
    }
  },
});

/**
 * Remove a single scholar from a group (idempotent).
 */
export const removeScholar = scholarAdminMutation({
  args: {
    groupId: v.id("scholarGroups"),
    scholarId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupId);
    if (!group) throw new Error("Group not found.");
    await requireGroupInstitutionAccess(ctx, group);
    const wasPresent = group.scholarIds.includes(args.scholarId);
    await ctx.db.patch(args.groupId, {
      scholarIds: group.scholarIds.filter((id) => id !== args.scholarId),
    });
    if (wasPresent) {
      await recheckUnlocksForRemovedMembers(ctx, args.groupId, [
        args.scholarId,
      ]);
    }
  },
});

/**
 * Delete a group. Also scrubs the id out of every teacher's affinity
 * groupIds so we don't leave dangling references.
 */
export const remove = scholarAdminMutation({
  args: { groupId: v.id("scholarGroups") },
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupId);
    if (!group) return;
    await requireGroupInstitutionAccess(ctx, group);
    const captureStation = await ctx.db
      .query("captureStations")
      .withIndex("by_group", (q) => q.eq("scholarGroupId", args.groupId))
      .unique();
    if (captureStation) {
      throw new Error(
        "This group has a capture station and can't be deleted.",
      );
    }
    const programAssignments = await ctx.db
      .query("assignments")
      .withIndex("by_scholar_group", (q) =>
        q.eq("scholarGroupId", args.groupId),
      )
      .collect();
    const archivedAt = Date.now();
    for (const listedAssignment of programAssignments) {
      // Delete only unworked, exclusively-owned Handouts. The cascade removes
      // their resources and schedule state; anything with scholar work follows
      // the archival lifecycle below instead.
      await deleteOwnedOrphanProgramHandouts(ctx, listedAssignment._id);
      const assignment = await ctx.db.get(listedAssignment._id);
      if (!assignment) continue;
      const activitySchedule: NonNullable<
        Doc<"assignments">["activitySchedule"]
      > = [];
      for (const entry of assignment.activitySchedule ?? []) {
        if (entry.scheduledFnId) {
          await ctx.scheduler.cancel(entry.scheduledFnId);
        }
        const entryWithoutJob = { ...entry };
        delete entryWithoutJob.scheduledFnId;
        activitySchedule.push({
          ...entryWithoutJob,
          ...(entry.setAt &&
          (!entry.endsAt || entry.endsAt > archivedAt)
            ? { endsAt: archivedAt }
            : {}),
        });
      }
      // Linked chips are execution state, never class structure. Delete them
      // before unlinking the group so reconciliation cannot recreate schedule
      // entries against an archived assignment; recurring bare shells survive.
      const placements = await ctx.db
        .query("schedulePlacements")
        .withIndex("by_assignment", (q) => q.eq("assignmentId", assignment._id))
        .collect();
      for (const placement of placements) {
        // assignmentId-scoped, mutually exclusive with an app-target
        // placement's externalAppId — provably a no-op here, called anyway
        // so every schedulePlacements deletion path routes through the one
        // shared settle helper (masterSchedule.settlePlacementAppPush).
        await settlePlacementAppPush(ctx, placement);
        await ctx.db.delete(placement._id);
      }
      await ctx.db.patch(assignment._id, {
        archivedAt,
        scholarGroupId: undefined,
        activitySchedule,
      });
    }
    const affinities = await ctx.db
      .query("teacherAffinities")
      .filter((q) => q.neq(q.field("groupIds"), undefined))
      .collect();
    for (const aff of affinities) {
      if (aff.groupIds.includes(args.groupId)) {
        await ctx.db.patch(aff._id, {
          groupIds: aff.groupIds.filter((id) => id !== args.groupId),
        });

      }
    }
    for (const checkpoint of await checkpointRowsForGroup(ctx, args.groupId)) {
      await ctx.db.delete(checkpoint._id);
    }
    const capabilityGrants = await ctx.db
      .query("staffCapabilityGrants")
      .withIndex("by_group_capability", (q) =>
        q.eq("scholarGroupId", args.groupId),
      )
      .collect();
    for (const grant of capabilityGrants) {
      await ctx.db.delete(grant._id);
    }
    // Unlike assignment archive, deleting the group also removes its bare class
    // shells: they cannot outlive their owning cohort.
    const remainingPlacements = (await ctx.db.query("schedulePlacements").collect()).filter(
      (placement) => placement.groupId === args.groupId,
    );
    for (const placement of remainingPlacements) {
      // Unlike the assignment-scoped loop above, this one is NOT filtered
      // to activity-linked rows — a group's recurring standing-assignment
      // app placement (e.g. Robotics' Block E → LEGO SPIKE) lives here, and
      // deleting the group must not leave its push (and scheduled activate/
      // clear jobs) running for an audience that no longer exists.
      await settlePlacementAppPush(ctx, placement);
      await ctx.db.delete(placement._id);
    }
    // The group's own roster is what any `appAudiences` group-grant resolves
    // membership against (lib/appAudiences.ts); deleting the group removes
    // that roster for every current member in one shot, so all of them are
    // candidates for a device-unlock recheck — same as removing them one at
    // a time via removeScholar/setScholars.
    await recheckUnlocksForRemovedMembers(ctx, args.groupId, group.scholarIds);
    await ctx.db.delete(args.groupId);
  },
});

// ── helpers ──────────────────────────────────────────────────────────

/**
 * Groups are roster-wide within an institution, never across institutions.
 * Mutations do not carry a URL scope, so accept any institution where the
 * caller has staff membership; platform admins retain their global reach.
 */
async function requireGroupInstitutionAccess(
  ctx: MutationCtx & { user: Doc<"users"> },
  group: Doc<"scholarGroups">,
): Promise<void> {
  const lens = await resolveInstitutionLens(ctx, ctx.user, "all");
  if (!institutionIdInLens(lens, group.institutionId)) {
    throw new Error("Forbidden: group is not in your institution");
  }
}

function normalizeEmoji(emoji: string | undefined): string | undefined {
  const trimmed = emoji?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeGroupType(type: string | null | undefined): string | undefined {
  const trimmed = type?.trim();
  return trimmed ? trimmed : undefined;
}

async function assertProgramGuestMembership(
  ctx: MutationCtx,
  scholarIds: Id<"users">[],
  participation: ScholarGroupParticipation | undefined,
): Promise<void> {
  if (includesProgramGuests({ participation })) return;
  for (const scholarId of scholarIds) {
    if (isProgramGuest(await ctx.db.get(scholarId))) {
      throw new Error(
        `${EXTENDED_EDUCATION_LABEL} scholars can only belong to an ${EXTENDED_EDUCATION_LABEL} group.`,
      );
    }
  }
}

/**
 * A group's owner has to be a staff member — ownership is what makes the
 * group somebody's default teaching scope, and a scholar or parent can never
 * hold that. Not an ACL: the owner gets no rights the roster-wide model
 * doesn't already give every teacher.
 */
async function assertStaffOwner(
  ctx: Pick<MutationCtx, "db">,
  ownerId: Id<"users">,
): Promise<void> {
  const owner = await ctx.db.get(ownerId);
  if (!owner || !isStaffRole(owner.role)) {
    throw new Error("A group owner must be a staff member.");
  }
}

export class RosterInstitutionError extends Error {}

export async function institutionForRoster(
  ctx: Pick<MutationCtx, "db">,
  scholarIds: Id<"users">[],
  groupInstitutionId?: Id<"institutions">,
): Promise<Id<"institutions"> | undefined> {
  let institutionId = groupInstitutionId;
  let hasUnassignedScholar = false;

  for (const scholarId of scholarIds) {
    const scholar = await ctx.db.get(scholarId);
    if (!scholar || !(await hasScholarMembership(ctx, scholarId))) continue;
    const scholarInstitutionId = await resolveScholarInstitutionId(ctx, scholarId);
    if (!scholarInstitutionId) {
      hasUnassignedScholar = true;
      continue;
    }
    if (institutionId && scholarInstitutionId !== institutionId) {
      throw new RosterInstitutionError(
        "Cannot add a scholar from a different institution to this group.",
      );
    }
    institutionId = scholarInstitutionId;
  }

  if (institutionId && hasUnassignedScholar) {
    throw new RosterInstitutionError(
      "Every scholar must belong to the group's institution before being added.",
    );
  }
  return institutionId;
}

/**
 * Dedupe and drop any ids that aren't real scholars. Keeps group
 * membership honest without making the mutation reject the whole batch
 * for one stale id.
 */
async function sanitizeScholarIds(
  ctx: Pick<MutationCtx, "db">,
  ids: Id<"users">[],
): Promise<Id<"users">[]> {
  const seen = new Set<string>();
  const out: Id<"users">[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (await hasScholarMembership(ctx, id)) out.push(id);
  }
  return out;
}
