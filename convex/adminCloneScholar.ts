/**
 * Clone and purge a throwaway scholar learning record from the CLI.
 *
 * `deleteUserCore` and `devPurge` cover broad account/session cleanup, but not
 * the practice-engine tables this short-lived production dry-run tool mirrors.
 */
import { v } from "convex/values";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type DatabaseReader,
  type MutationCtx,
} from "./_generated/server";
import { seedDefaultAppsForScholar } from "./lib/externalAppsSeed";
import { assertValidUsername } from "./lib/username";
import { ensureDefaultMembershipForUser } from "./memberships";
import {
  assertCheckpointGroupMembershipAvailable,
  checkpointRowsForGroup,
} from "./lib/practice/checkpointFocus";
import {
  institutionForRoster,
  RosterInstitutionError,
} from "./scholarGroups";
import { recheckUnlocksForRemovedMembers } from "./lib/scholarGroupUnlocks";
import { scheduleClaimDecommissionLocksForScholar } from "./lib/deviceAppUnlockScheduling";
import { isBreakerCountedAttempt } from "./lib/practice/spiralBreaker";

const DEFAULT_ATTEMPT_CAP = 500;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

type ReadCtx = { db: DatabaseReader };
type SystemFields = "_id" | "_creationTime";

function withoutSystemFields<T extends { _id: unknown; _creationTime: number }>(
  row: T,
): Omit<T, SystemFields> {
  const { _id, _creationTime, ...fields } = row;
  void _id;
  void _creationTime;
  return fields;
}

async function collectScholarRows(
  ctx: ReadCtx,
  scholarId: Id<"users">,
  attemptCap?: number,
) {
  const attemptsQuery = ctx.db
    .query("practiceAttempts")
    .withIndex("by_scholar_createdAt", (q) => q.eq("scholarId", scholarId))
    .order("desc");
  const practiceAttempts =
    attemptCap === undefined
      ? await attemptsQuery.collect()
      : attemptCap === 0
        ? []
        : await attemptsQuery.take(attemptCap);

  return {
    practiceMastery: await ctx.db
      .query("practiceMastery")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect(),
    practicePlacements: await ctx.db
      .query("practicePlacements")
      .withIndex("by_scholar_domain", (q) => q.eq("scholarId", scholarId))
      .collect(),
    practiceAttempts,
    practiceErrorEvents: await ctx.db
      .query("practiceErrorEvents")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect(),
    practiceChoiceEvents: await ctx.db
      .query("practiceChoiceEvents")
      .withIndex("by_scholar_createdAt", (q) => q.eq("scholarId", scholarId))
      .collect(),
    practiceTuneups: await ctx.db
      .query("practiceTuneups")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect(),
    practicePredictions: await ctx.db
      .query("practicePredictions")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect(),
    nodeReveals: await ctx.db
      .query("nodeReveals")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect(),
    mapReveals: await ctx.db
      .query("mapReveals")
      .withIndex("by_scholar_map", (q) => q.eq("scholarId", scholarId))
      .collect(),
    momentEvents: await ctx.db
      .query("momentEvents")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect(),
    instructionEvents: await ctx.db
      .query("instructionEvents")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect(),
    closureLines: await ctx.db
      .query("closureLines")
      .withIndex("by_scholar_kind_hash", (q) => q.eq("scholarId", scholarId))
      .collect(),
    scholarDossiers: await ctx.db
      .query("scholarDossiers")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect(),
    weeklyGoals: await ctx.db
      .query("weeklyGoals")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect(),
    scholarUnitBadges: await ctx.db
      .query("scholarUnitBadges")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect(),
    scholarActivityAngles: await ctx.db
      .query("scholarActivityAngles")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect(),
    masteryObservations: await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect(),
    teacherMasteryOverrides: await ctx.db
      .query("teacherMasteryOverrides")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect(),
    scholarGoals: await ctx.db
      .query("scholarGoals")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect(),
    goalCheckins: await ctx.db
      .query("goalCheckins")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect(),
    seeds: await ctx.db
      .query("seeds")
      .withIndex("by_scholar_status", (q) => q.eq("scholarId", scholarId))
      .collect(),
    observations: await ctx.db
      .query("observations")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect(),
  };
}

type ScholarRows = Awaited<ReturnType<typeof collectScholarRows>>;

function rowCounts(rows: ScholarRows): Record<keyof ScholarRows, number> {
  return {
    practiceMastery: rows.practiceMastery.length,
    practicePlacements: rows.practicePlacements.length,
    practiceAttempts: rows.practiceAttempts.length,
    practiceErrorEvents: rows.practiceErrorEvents.length,
    practiceChoiceEvents: rows.practiceChoiceEvents.length,
    practiceTuneups: rows.practiceTuneups.length,
    practicePredictions: rows.practicePredictions.length,
    nodeReveals: rows.nodeReveals.length,
    mapReveals: rows.mapReveals.length,
    momentEvents: rows.momentEvents.length,
    instructionEvents: rows.instructionEvents.length,
    closureLines: rows.closureLines.length,
    scholarDossiers: rows.scholarDossiers.length,
    weeklyGoals: rows.weeklyGoals.length,
    scholarUnitBadges: rows.scholarUnitBadges.length,
    scholarActivityAngles: rows.scholarActivityAngles.length,
    masteryObservations: rows.masteryObservations.length,
    teacherMasteryOverrides: rows.teacherMasteryOverrides.length,
    scholarGoals: rows.scholarGoals.length,
    goalCheckins: rows.goalCheckins.length,
    seeds: rows.seeds.length,
    observations: rows.observations.length,
  };
}

export const findScholar = internalQuery({
  args: { search: v.string() },
  handler: async (ctx, args) => {
    const search = args.search.toLowerCase();
    const scholars = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", "scholar"))
      .collect();
    return scholars
      .filter(
        (user) =>
          user.username?.toLowerCase().includes(search) ||
          user.name?.toLowerCase().includes(search),
      )
      .slice(0, 10)
      .map((user) => ({
        userId: user._id,
        username: user.username ?? null,
        name: user.name ?? null,
        gradeLevel: user.gradeLevel ?? null,
        institutionId: user.institutionId ?? null,
      }));
  },
});

export const inspectSource = internalQuery({
  args: { sourceUserId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.sourceUserId);
    if (!user) return null;
    const rows = await collectScholarRows(ctx, args.sourceUserId);
    return {
      source: {
        userId: user._id,
        username: user.username ?? null,
        name: user.name ?? null,
        gradeLevel: user.gradeLevel ?? null,
        institutionId: user.institutionId ?? null,
      },
      copiedUserFields: {
        readingLevel: user.readingLevel ?? null,
        preferredFont: user.preferredFont ?? null,
        ttsEnabled: user.ttsEnabled ?? null,
        sttEnabled: user.sttEnabled ?? null,
      },
      counts: rowCounts(rows),
    };
  },
});

export const cloneScholar = internalMutation({
  args: {
    sourceUserId: v.id("users"),
    targetUsername: v.string(),
    targetName: v.string(),
    gradeLevel: v.optional(v.string()),
    attemptCap: v.optional(v.number()),
    mirrorGroups: v.optional(v.boolean()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const attemptCap = args.attemptCap ?? DEFAULT_ATTEMPT_CAP;
    if (!Number.isInteger(attemptCap) || attemptCap < 0) {
      throw new Error("attemptCap must be a non-negative integer");
    }
    // Same gate as every other user-creating path: a clone mints a real
    // sign-in-able scholar, so its username has to survive the profile URL
    // and the `<username>@local` password lookup too.
    assertValidUsername(args.targetUsername);

    const existing = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.targetUsername))
      .first();

    const sourceUser = await ctx.db.get(args.sourceUserId);
    if (!sourceUser) {
      throw new Error(`Source user ${args.sourceUserId} not found`);
    }
    if (sourceUser.role !== "scholar") {
      throw new Error("Source user must have role scholar");
    }
    if (existing?._id === args.sourceUserId) {
      throw new Error("Source and target scholar must be different users");
    }

    if (existing) {
      if (existing.role !== "scholar") {
        throw new Error(
          `Existing target "${args.targetUsername}" must have role scholar`,
        );
      }
      const targetRows = await collectScholarRows(ctx, existing._id);
      const occupiedTables = Object.entries(rowCounts(targetRows))
        .filter(([, count]) => count > 0)
        .map(([table, count]) => `${table} (${count})`);
      if (occupiedTables.length > 0) {
        throw new Error(
          `Existing target "${args.targetUsername}" already has learning data: ${occupiedTables.join(", ")}`,
        );
      }
    }

    const sourceRows = await collectScholarRows(
      ctx,
      args.sourceUserId,
      attemptCap,
    );
    const groups = (await ctx.db.query("scholarGroups").collect()).filter(
      (group) => group.scholarIds.includes(args.sourceUserId),
    );
    const candidateMirroredGroups =
      args.mirrorGroups === false ? [] : groups.map((group) => group.name);

    if (args.dryRun) {
      return {
        targetUserId: null,
        counts: rowCounts(sourceRows),
        mirroredGroups: candidateMirroredGroups,
        existedTarget: existing !== null,
      };
    }

    let targetUserId: Id<"users">;
    if (existing) {
      targetUserId = existing._id;
      await ctx.db.patch(targetUserId, {
        readingLevel: sourceUser.readingLevel,
        preferredFont: sourceUser.preferredFont,
        ttsEnabled: sourceUser.ttsEnabled,
        sttEnabled: sourceUser.sttEnabled,
        ...(args.gradeLevel === undefined
          ? {}
          : { gradeLevel: args.gradeLevel }),
      });
    } else {
      targetUserId = await ctx.db.insert("users", {
        username: args.targetUsername,
        name: args.targetName,
        role: "scholar",
        gradeLevel: args.gradeLevel ?? "3",
        readingLevel: sourceUser.readingLevel,
        preferredFont: sourceUser.preferredFont,
        ttsEnabled: sourceUser.ttsEnabled,
        sttEnabled: sourceUser.sttEnabled,
      });
    }
    await ensureDefaultMembershipForUser(ctx, targetUserId);
    await seedDefaultAppsForScholar(ctx, targetUserId);

    for (const row of sourceRows.practiceMastery) {
      await ctx.db.insert("practiceMastery", {
        ...withoutSystemFields(row),
        scholarId: targetUserId,
      });
    }
    for (const row of sourceRows.practicePlacements) {
      await ctx.db.insert("practicePlacements", {
        ...withoutSystemFields(row),
        scholarId: targetUserId,
      });
    }
    for (const row of sourceRows.practiceAttempts) {
      await ctx.db.insert("practiceAttempts", {
        ...withoutSystemFields(row),
        scholarId: targetUserId,
        breakerEligible:
          row.breakerEligible ?? isBreakerCountedAttempt(row),
      });
    }
    for (const row of sourceRows.practiceErrorEvents) {
      await ctx.db.insert("practiceErrorEvents", {
        ...withoutSystemFields(row),
        scholarId: targetUserId,
      });
    }
    for (const row of sourceRows.practiceChoiceEvents) {
      await ctx.db.insert("practiceChoiceEvents", {
        ...withoutSystemFields(row),
        scholarId: targetUserId,
      });
    }
    for (const row of sourceRows.practiceTuneups) {
      await ctx.db.insert("practiceTuneups", {
        ...withoutSystemFields(row),
        scholarId: targetUserId,
      });
    }
    for (const row of sourceRows.practicePredictions) {
      await ctx.db.insert("practicePredictions", {
        ...withoutSystemFields(row),
        scholarId: targetUserId,
      });
    }
    for (const row of sourceRows.nodeReveals) {
      await ctx.db.insert("nodeReveals", {
        ...withoutSystemFields(row),
        scholarId: targetUserId,
      });
    }
    for (const row of sourceRows.mapReveals) {
      await ctx.db.insert("mapReveals", {
        ...withoutSystemFields(row),
        scholarId: targetUserId,
      });
    }
    for (const row of sourceRows.momentEvents) {
      await ctx.db.insert("momentEvents", {
        ...withoutSystemFields(row),
        scholarId: targetUserId,
      });
    }
    for (const row of sourceRows.instructionEvents) {
      await ctx.db.insert("instructionEvents", {
        ...withoutSystemFields(row),
        scholarId: targetUserId,
      });
    }
    for (const row of sourceRows.closureLines) {
      await ctx.db.insert("closureLines", {
        ...withoutSystemFields(row),
        scholarId: targetUserId,
      });
    }
    for (const row of sourceRows.scholarDossiers) {
      await ctx.db.insert("scholarDossiers", {
        ...withoutSystemFields(row),
        scholarId: targetUserId,
      });
    }
    for (const row of sourceRows.weeklyGoals) {
      await ctx.db.insert("weeklyGoals", {
        ...withoutSystemFields(row),
        scholarId: targetUserId,
      });
    }
    for (const row of sourceRows.scholarUnitBadges) {
      await ctx.db.insert("scholarUnitBadges", {
        ...withoutSystemFields(row),
        scholarId: targetUserId,
      });
    }
    for (const row of sourceRows.scholarActivityAngles) {
      await ctx.db.insert("scholarActivityAngles", {
        ...withoutSystemFields(row),
        scholarId: targetUserId,
      });
    }

    const observationIds = new Map<
      Id<"masteryObservations">,
      Id<"masteryObservations">
    >();
    for (const row of sourceRows.masteryObservations) {
      const clonedId = await ctx.db.insert("masteryObservations", {
        ...withoutSystemFields(row),
        scholarId: targetUserId,
        supersedesId: undefined,
        sessionId: undefined,
        metaChatId: undefined,
        // Same rule as the other anchors: a clone must not point at the SOURCE
        // scholar's scan (deleting that scan would otherwise tear down the
        // clone's row too — portfolioAssess's by_portfolioItem teardown).
        portfolioItemId: undefined,
        excerptMessageIds: undefined,
      });
      observationIds.set(row._id, clonedId);
    }
    for (const row of sourceRows.masteryObservations) {
      if (!row.supersedesId) continue;
      const clonedId = observationIds.get(row._id);
      const clonedSupersedesId = observationIds.get(row.supersedesId);
      if (clonedId && clonedSupersedesId) {
        await ctx.db.patch(clonedId, { supersedesId: clonedSupersedesId });
      }
    }
    for (const row of sourceRows.teacherMasteryOverrides) {
      const observationId = observationIds.get(row.observationId);
      if (!observationId) {
        throw new Error(
          `Cannot clone teacher override ${row._id}: observation is not in source record`,
        );
      }
      await ctx.db.insert("teacherMasteryOverrides", {
        ...withoutSystemFields(row),
        scholarId: targetUserId,
        observationId,
      });
    }

    const goalIds = new Map<Id<"scholarGoals">, Id<"scholarGoals">>();
    for (const row of sourceRows.scholarGoals) {
      const clonedId = await ctx.db.insert("scholarGoals", {
        ...withoutSystemFields(row),
        scholarId: targetUserId,
      });
      goalIds.set(row._id, clonedId);
    }
    for (const row of sourceRows.goalCheckins) {
      const goalId = goalIds.get(row.goalId);
      if (!goalId) {
        throw new Error(
          `Cannot clone goal check-in ${row._id}: goal is not in source record`,
        );
      }
      await ctx.db.insert("goalCheckins", {
        ...withoutSystemFields(row),
        scholarId: targetUserId,
        goalId,
      });
    }

    for (const row of sourceRows.seeds) {
      await ctx.db.insert("seeds", {
        ...withoutSystemFields(row),
        scholarId: targetUserId,
        sessionId: undefined,
      });
    }
    for (const row of sourceRows.observations) {
      await ctx.db.insert("observations", {
        ...withoutSystemFields(row),
        scholarId: targetUserId,
        sessionId: undefined,
      });
    }

    const mirroredGroups: string[] = [];
    if (args.mirrorGroups !== false) {
      for (const group of groups) {
        if (group.scholarIds.includes(targetUserId)) {
          mirroredGroups.push(group.name);
          continue;
        }
        const scholarIds = [...group.scholarIds, targetUserId];
        let institutionId: Id<"institutions"> | undefined;
        try {
          institutionId = await institutionForRoster(
            ctx,
            scholarIds,
            group.institutionId,
          );
        } catch (error) {
          if (!(error instanceof RosterInstitutionError)) throw error;
          console.warn(
            `[adminCloneScholar] Skipping group "${group.name}" for clone "${args.targetUsername}": ${error.message}`,
          );
          continue;
        }
        // Preserve the one-checkpoint-group invariant on this membership-write
        // path too: only a checkpoint-bearing group is constrained, and adding
        // the clone target to a second one throws (rolling back the whole clone).
        if ((await checkpointRowsForGroup(ctx, group._id)).length > 0) {
          await assertCheckpointGroupMembershipAvailable(ctx, group._id, [
            targetUserId,
          ]);
        }
        await ctx.db.patch(group._id, {
          scholarIds,
          ...(institutionId ? { institutionId } : {}),
        });
        mirroredGroups.push(group.name);
      }
    }

    return {
      targetUserId,
      counts: rowCounts(sourceRows),
      mirroredGroups,
      existedTarget: existing !== null,
    };
  },
});

async function deleteRows<T extends TableNames>(
  ctx: MutationCtx,
  table: T,
  rows: Doc<T>[],
  counts: Record<string, number>,
): Promise<void> {
  for (const row of rows) await ctx.db.delete(row._id);
  counts[table] = (counts[table] ?? 0) + rows.length;
}

export const purgeCloneScholar = internalMutation({
  args: {
    userId: v.id("users"),
    confirmUsername: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error(`User ${args.userId} not found`);
    if (user.username !== args.confirmUsername) {
      throw new Error("confirmUsername does not exactly match the user");
    }

    const [guardianships, passkeys, sessions] = await Promise.all([
      ctx.db
        .query("guardianships")
        .withIndex("by_scholar", (q) =>
          q.eq("scholarUserId", args.userId),
        )
        .collect(),
      ctx.db
        .query("passkeys")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .collect(),
      ctx.db
        .query("sessions")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .collect(),
    ]);

    const reasons: string[] = [];
    if (user.role !== "scholar") reasons.push(`role is ${user.role ?? "unset"}`);
    if (guardianships.length > 0) {
      reasons.push(`${guardianships.length} guardianship row(s)`);
    }
    if (passkeys.length > 0) reasons.push(`${passkeys.length} passkey row(s)`);
    const oldSessions = sessions.filter(
      (session) => session._creationTime < Date.now() - SEVEN_DAYS_MS,
    );
    if (oldSessions.length > 0) {
      reasons.push(`${oldSessions.length} session(s) older than 7 days`);
    }
    if (reasons.length > 0) {
      throw new Error(`Refusing to purge clone scholar: ${reasons.join("; ")}`);
    }

    const counts: Record<string, number> = {};
    const rows = await collectScholarRows(ctx, args.userId);

    /**
     * Schema ownership inventory:
     * - Every table with an exact `userId`/`scholarId` owner and a leading
     *   user/scholar index is purged below, through `collectScholarRows`, or
     *   through the session cascade.
     * - `passkeys` and `guardianships` are refusal gates above, not cascades.
     * - `documentAccessLog` is an audit trail and deliberately outlives both
     *   the accessed document and user.
     * - `chats`/`curriculumMessages` are teacher-owned conversation history;
     *   their optional `scholarId` is thread scope, not ownership.
     * - `parentThreads` are parent-owned conversation history; `scholarId` is
     *   the subject and explicitly not an access grant.
     */
    const [
      webauthnChallenges,
      embedSessionTokens,
      mcpSessions,
      mcpOauthConsents,
      notificationPrefs,
      googleAccounts,
    ] = await Promise.all([
      ctx.db
        .query("webauthnChallenges")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .collect(),
      ctx.db
        .query("embedSessionTokens")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .collect(),
      ctx.db
        .query("mcpSessions")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .collect(),
      ctx.db
        .query("mcpOauthConsents")
        .withIndex("by_user_client", (q) => q.eq("userId", args.userId))
        .collect(),
      ctx.db
        .query("notificationPrefs")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .collect(),
      ctx.db
        .query("googleAccounts")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .collect(),
    ]);
    const [
      factFluency,
      scholarCheckpointOverrides,
      practiceHintReveals,
      practiceGameOffers,
      practiceWorkImages,
      practicePadHints,
      graphemeInventories,
      graphemeHistory,
    ] = await Promise.all([
      ctx.db
        .query("factFluency")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
        .collect(),
      ctx.db
        .query("scholarCheckpointOverride")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
        .collect(),
      ctx.db
        .query("practiceHintReveals")
        .withIndex("by_scholar_item_createdAt", (q) =>
          q.eq("scholarId", args.userId),
        )
        .collect(),
      ctx.db
        .query("practiceGameOffers")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
        .collect(),
      ctx.db
        .query("practiceWorkImages")
        .withIndex("by_scholar_item_createdAt", (q) =>
          q.eq("scholarId", args.userId),
        )
        .collect(),
      ctx.db
        .query("practicePadHints")
        .withIndex("by_scholar_item_createdAt", (q) =>
          q.eq("scholarId", args.userId),
        )
        .collect(),
      ctx.db
        .query("graphemeInventories")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
        .collect(),
      ctx.db
        .query("graphemeHistory")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
        .collect(),
    ]);
    const [
      simulatorBenches,
      simulatorRuns,
      gameSessions,
      gameSessionDigests,
      scholarDocuments,
      documentProposals,
      portfolioItems,
      courseNarratives,
      wholeChildNarratives,
      scholarHealthRecords,
      scholarHealthRecordDrafts,
      healthRecordFiles,
      medicalClearanceRequests,
    ] = await Promise.all([
      ctx.db
        .query("simulatorBenches")
        .withIndex("by_scholar_activity", (q) =>
          q.eq("scholarId", args.userId),
        )
        .collect(),
      ctx.db
        .query("simulatorRuns")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
        .collect(),
      ctx.db
        .query("gameSessions")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
        .collect(),
      ctx.db
        .query("gameSessionDigests")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
        .collect(),
      ctx.db
        .query("scholarDocuments")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
        .collect(),
      ctx.db
        .query("documentProposals")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
        .collect(),
      ctx.db
        .query("portfolioItems")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
        .collect(),
      ctx.db
        .query("courseNarratives")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
        .collect(),
      ctx.db
        .query("wholeChildNarratives")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
        .collect(),
      ctx.db
        .query("scholarHealthRecords")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
        .collect(),
      ctx.db
        .query("scholarHealthRecordDrafts")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
        .collect(),
      ctx.db
        .query("healthRecordFiles")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
        .collect(),
      ctx.db
        .query("medicalClearanceRequests")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
        .collect(),
    ]);

    await deleteRows(ctx, "factFluency", factFluency, counts);
    await deleteRows(
      ctx,
      "scholarCheckpointOverride",
      scholarCheckpointOverrides,
      counts,
    );
    await deleteRows(
      ctx,
      "practiceHintReveals",
      practiceHintReveals,
      counts,
    );
    await deleteRows(ctx, "practiceGameOffers", practiceGameOffers, counts);
    await deleteRows(ctx, "practiceWorkImages", practiceWorkImages, counts);
    await deleteRows(ctx, "practicePadHints", practicePadHints, counts);
    await deleteRows(ctx, "graphemeInventories", graphemeInventories, counts);
    await deleteRows(ctx, "graphemeHistory", graphemeHistory, counts);

    for (const run of simulatorRuns) {
      const chunks = await ctx.db
        .query("simulatorRunChunks")
        .withIndex("by_run_startTick", (q) => q.eq("runId", run._id))
        .collect();
      await deleteRows(ctx, "simulatorRunChunks", chunks, counts);
    }
    await deleteRows(ctx, "simulatorRuns", simulatorRuns, counts);
    await deleteRows(ctx, "simulatorBenches", simulatorBenches, counts);

    for (const gameSession of gameSessions) {
      const events = await ctx.db
        .query("gameEvents")
        .withIndex("by_session_seq", (q) =>
          q.eq("sessionId", gameSession._id),
        )
        .collect();
      await deleteRows(ctx, "gameEvents", events, counts);
    }
    await deleteRows(ctx, "gameSessionDigests", gameSessionDigests, counts);
    await deleteRows(ctx, "gameSessions", gameSessions, counts);
    await deleteRows(ctx, "courseNarratives", courseNarratives, counts);
    await deleteRows(ctx, "wholeChildNarratives", wholeChildNarratives, counts);
    await deleteRows(ctx, "documentProposals", documentProposals, counts);
    await deleteRows(ctx, "scholarDocuments", scholarDocuments, counts);
    await deleteRows(ctx, "portfolioItems", portfolioItems, counts);
    await deleteRows(
      ctx,
      "medicalClearanceRequests",
      medicalClearanceRequests,
      counts,
    );
    await deleteRows(
      ctx,
      "scholarHealthRecordDrafts",
      scholarHealthRecordDrafts,
      counts,
    );
    await deleteRows(ctx, "scholarHealthRecords", scholarHealthRecords, counts);
    await deleteRows(ctx, "healthRecordFiles", healthRecordFiles, counts);

    await deleteRows(ctx, "webauthnChallenges", webauthnChallenges, counts);
    await deleteRows(ctx, "embedSessionTokens", embedSessionTokens, counts);
    await deleteRows(ctx, "mcpSessions", mcpSessions, counts);
    await deleteRows(ctx, "mcpOauthConsents", mcpOauthConsents, counts);
    await deleteRows(ctx, "notificationPrefs", notificationPrefs, counts);
    await deleteRows(ctx, "googleAccounts", googleAccounts, counts);

    await deleteRows(
      ctx,
      "teacherMasteryOverrides",
      rows.teacherMasteryOverrides,
      counts,
    );
    await deleteRows(
      ctx,
      "masteryObservations",
      rows.masteryObservations,
      counts,
    );
    await deleteRows(ctx, "goalCheckins", rows.goalCheckins, counts);
    await deleteRows(ctx, "scholarGoals", rows.scholarGoals, counts);
    await deleteRows(ctx, "practiceMastery", rows.practiceMastery, counts);
    await deleteRows(
      ctx,
      "practicePlacements",
      rows.practicePlacements,
      counts,
    );
    await deleteRows(ctx, "practiceAttempts", rows.practiceAttempts, counts);
    await deleteRows(
      ctx,
      "practiceErrorEvents",
      rows.practiceErrorEvents,
      counts,
    );
    await deleteRows(
      ctx,
      "practiceChoiceEvents",
      rows.practiceChoiceEvents,
      counts,
    );
    await deleteRows(ctx, "practiceTuneups", rows.practiceTuneups, counts);
    await deleteRows(
      ctx,
      "practicePredictions",
      rows.practicePredictions,
      counts,
    );
    await deleteRows(ctx, "nodeReveals", rows.nodeReveals, counts);
    await deleteRows(ctx, "mapReveals", rows.mapReveals, counts);
    await deleteRows(ctx, "momentEvents", rows.momentEvents, counts);
    await deleteRows(
      ctx,
      "instructionEvents",
      rows.instructionEvents,
      counts,
    );
    await deleteRows(ctx, "closureLines", rows.closureLines, counts);
    await deleteRows(ctx, "scholarDossiers", rows.scholarDossiers, counts);
    await deleteRows(ctx, "weeklyGoals", rows.weeklyGoals, counts);
    await deleteRows(
      ctx,
      "scholarUnitBadges",
      rows.scholarUnitBadges,
      counts,
    );
    await deleteRows(
      ctx,
      "scholarActivityAngles",
      rows.scholarActivityAngles,
      counts,
    );
    await deleteRows(ctx, "seeds", rows.seeds, counts);

    const activityCompletions = await ctx.db
      .query("activityCompletions")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
      .collect();
    await deleteRows(
      ctx,
      "activityCompletions",
      activityCompletions,
      counts,
    );
    const deliverables = await ctx.db
      .query("deliverables")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
      .collect();
    await deleteRows(ctx, "deliverables", deliverables, counts);
    const observations = await ctx.db
      .query("observations")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
      .collect();
    await deleteRows(ctx, "observations", observations, counts);
    const sessionSignals = await ctx.db
      .query("sessionSignals")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
      .collect();
    await deleteRows(ctx, "sessionSignals", sessionSignals, counts);
    const crossDomainConnections = await ctx.db
      .query("crossDomainConnections")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
      .collect();
    await deleteRows(
      ctx,
      "crossDomainConnections",
      crossDomainConnections,
      counts,
    );
    const metaChats = await ctx.db
      .query("metaChats")
      .withIndex("by_scholar_day", (q) => q.eq("scholarId", args.userId))
      .collect();
    for (const chat of metaChats) {
      const metaMessages = await ctx.db
        .query("metaMessages")
        .withIndex("by_chat", (q) => q.eq("chatId", chat._id))
        .collect();
      await deleteRows(ctx, "metaMessages", metaMessages, counts);
      const metaObserverRuns = await ctx.db
        .query("metaObserverRuns")
        .withIndex("by_chat_range", (q) => q.eq("chatId", chat._id))
        .collect();
      await deleteRows(ctx, "metaObserverRuns", metaObserverRuns, counts);
    }
    await deleteRows(ctx, "metaChats", metaChats, counts);
    const teachBacks = await ctx.db
      .query("teachBacks")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
      .collect();
    await deleteRows(ctx, "teachBacks", teachBacks, counts);
    const granuleEvidence = await ctx.db
      .query("granuleEvidence")
      .withIndex("by_scholar_unit", (q) => q.eq("scholarId", args.userId))
      .collect();
    await deleteRows(ctx, "granuleEvidence", granuleEvidence, counts);
    const webActivitySessions = await ctx.db
      .query("webActivitySessions")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
      .collect();
    await deleteRows(
      ctx,
      "webActivitySessions",
      webActivitySessions,
      counts,
    );
    const scholarSuggestions = await ctx.db
      .query("scholarSuggestions")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
      .collect();
    await deleteRows(
      ctx,
      "scholarSuggestions",
      scholarSuggestions,
      counts,
    );
    const readingLevelHistory = await ctx.db
      .query("readingLevelHistory")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
      .collect();
    await deleteRows(
      ctx,
      "readingLevelHistory",
      readingLevelHistory,
      counts,
    );
    const teacherDirectives = await ctx.db
      .query("teacherDirectives")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
      .collect();
    await deleteRows(ctx, "teacherDirectives", teacherDirectives, counts);
    const alerts = await ctx.db
      .query("alerts")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
      .collect();
    await deleteRows(ctx, "alerts", alerts, counts);

    const scholarApps = await ctx.db
      .query("scholarApps")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.userId))
      .collect();
    await deleteRows(ctx, "scholarApps", scholarApps, counts);
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    await deleteRows(ctx, "memberships", memberships, counts);
    const enrollmentTokens = await ctx.db
      .query("enrollmentTokens")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    await deleteRows(ctx, "enrollmentTokens", enrollmentTokens, counts);

    const authSessions = await ctx.db
      .query("authSessions")
      .filter((q) => q.eq(q.field("userId"), args.userId))
      .collect();
    for (const session of authSessions) {
      const refreshTokens = await ctx.db
        .query("authRefreshTokens")
        .filter((q) => q.eq(q.field("sessionId"), session._id))
        .collect();
      await deleteRows(ctx, "authRefreshTokens", refreshTokens, counts);
    }
    await deleteRows(ctx, "authSessions", authSessions, counts);

    const authAccounts = await ctx.db
      .query("authAccounts")
      .filter((q) => q.eq(q.field("userId"), args.userId))
      .collect();
    for (const account of authAccounts) {
      const verificationCodes = await ctx.db
        .query("authVerificationCodes")
        .filter((q) => q.eq(q.field("accountId"), account._id))
        .collect();
      await deleteRows(ctx, "authVerificationCodes", verificationCodes, counts);
    }
    await deleteRows(ctx, "authAccounts", authAccounts, counts);

    for (const session of sessions) {
      const analyses = await ctx.db
        .query("analyses")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .collect();
      await deleteRows(ctx, "analyses", analyses, counts);
      const artifacts = await ctx.db
        .query("artifacts")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .collect();
      await deleteRows(ctx, "artifacts", artifacts, counts);
      const processStates = await ctx.db
        .query("processState")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .collect();
      await deleteRows(ctx, "processState", processStates, counts);
      const physicalTasks = await ctx.db
        .query("physicalTasks")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .collect();
      await deleteRows(ctx, "physicalTasks", physicalTasks, counts);
      const messageFlags = await ctx.db
        .query("messageFlags")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .collect();
      await deleteRows(ctx, "messageFlags", messageFlags, counts);
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .collect();
      await deleteRows(ctx, "messages", messages, counts);
    }
    for (const table of [
      "analyses",
      "artifacts",
      "processState",
      "physicalTasks",
      "messageFlags",
      "messages",
    ]) {
      counts[table] ??= 0;
    }
    await deleteRows(ctx, "sessions", sessions, counts);

    const groups = await ctx.db.query("scholarGroups").collect();
    for (const group of groups) {
      if (!group.scholarIds.includes(args.userId)) continue;
      await ctx.db.patch(group._id, {
        scholarIds: group.scholarIds.filter((id) => id !== args.userId),
      });
      // This may be the scholar's sole route to a managed-native tile's
      // authorization (via an appAudiences group grant) — schedule the same
      // force-close recheck scholarGroups.ts itself uses, so purging the
      // clone can't leave a stale device unlock open past deletion.
      await recheckUnlocksForRemovedMembers(ctx, group._id, [args.userId]);
    }
    const assignments = await ctx.db.query("assignments").collect();
    for (const assignment of assignments) {
      if (!assignment.scholarIds.includes(args.userId)) continue;
      await ctx.db.patch(assignment._id, {
        scholarIds: assignment.scholarIds.filter((id) => id !== args.userId),
      });
    }

    // A directly owned managed-device claim (not routed through a group
    // grant) is the scholar's own credential — deleting the user must not
    // leave its device relocked-never. scholarApps direct grants are purged
    // above, but nothing else tells an already-unlocked device to re-lock.
    await scheduleClaimDecommissionLocksForScholar(ctx, args.userId);
    await ctx.db.delete(args.userId);
    counts.users = 1;
    return { counts };
  },
});
