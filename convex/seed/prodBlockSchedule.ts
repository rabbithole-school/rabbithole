// Operator-run, dry-run-first production roster and timetable reconciliation.
// Roster data is intentionally passed at runtime; do not put a real roster here.

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { Id, Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { ensureDefaultsInner, PRIMARY_SLUG } from "../institutions";
import { ensureMembership } from "../memberships";
import { ROLES } from "../lib/roles";
import {
  bareRecurringShadowKey,
  exactSchedulePlacementKey,
} from "../lib/schedulePlacementIdentity";

const weekdays = [1, 2, 3, 4, 5];
const DEFAULT_BARE_SHADOW_BATCH_SIZE = 25;
const MAX_BARE_SHADOW_BATCH_SIZE = 25;
const MAX_BARE_SHADOW_GROUP_ROWS = 256;
const person = v.object({
  key: v.string(),
  name: v.string(),
  username: v.string(),
  role: v.union(v.literal(ROLES.TEACHER), v.literal(ROLES.SCHOLAR)),
});

/**
 * Dry-run-first repair for legacy dated bare rows that exactly shadow a
 * recurring bare placement. It intentionally ignores shelves and all linked
 * work. Each call handles one bounded page; repeat with `nextCursor` until
 * `isDone`. Candidate dated rows look up their group's recurring rows through
 * by_period_group, so recurring and dated twins can land on different pages.
 * A group is the bounded unit: an oversized group fails rather than silently
 * producing an unreliable complete result.
 */
export const cleanupBareRecurringShadows = internalMutation({
  args: {
    periodId: v.id("reportingPeriods"),
    groupId: v.optional(v.id("scholarGroups")),
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const batchSize = args.batchSize ?? DEFAULT_BARE_SHADOW_BATCH_SIZE;
    if (
      !Number.isInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > MAX_BARE_SHADOW_BATCH_SIZE
    ) {
      throw new Error(
        `batchSize must be an integer from 1 through ${MAX_BARE_SHADOW_BATCH_SIZE}`,
      );
    }
    const page = args.groupId == null
      ? await ctx.db
        .query("schedulePlacements")
        .withIndex("by_period", (q) => q.eq("periodId", args.periodId))
        .paginate({ cursor: args.cursor ?? null, numItems: batchSize })
      : await ctx.db
        .query("schedulePlacements")
        .withIndex("by_period_group", (q) =>
          q.eq("periodId", args.periodId).eq("groupId", args.groupId!),
        )
        .paginate({ cursor: args.cursor ?? null, numItems: batchSize });
    const barePlacedRows = page.page.filter(
      (row) =>
        row.weekday != null &&
        row.blockId != null &&
        row.assignmentId == null &&
        row.activityId == null,
    );
    const recurringIds = new Set<Id<"schedulePlacements">>();
    for (const row of barePlacedRows) {
      if (row.weekStartMs != null) continue;
      const key = bareRecurringShadowKey(row);
      if (key == null) continue;
      recurringIds.add(row._id);
    }

    const candidateGroupIds = new Set<Id<"scholarGroups">>();
    for (const row of barePlacedRows) {
      if (row.weekStartMs != null && bareRecurringShadowKey(row) != null) {
        candidateGroupIds.add(row.groupId);
      }
    }
    const recurringKeysByGroup = new Map<
      Id<"scholarGroups">,
      Set<string>
    >();
    for (const groupId of candidateGroupIds) {
      const groupRows = await ctx.db
        .query("schedulePlacements")
        .withIndex("by_period_group", (q) =>
          q.eq("periodId", args.periodId).eq("groupId", groupId),
        )
        .take(MAX_BARE_SHADOW_GROUP_ROWS + 1);
      if (groupRows.length > MAX_BARE_SHADOW_GROUP_ROWS) {
        throw new Error(
          `Group ${groupId} exceeds the ${MAX_BARE_SHADOW_GROUP_ROWS}-row bare-shadow cleanup limit; use a targeted repair before marking this migration complete.`,
        );
      }
      const recurringKeys = new Set<string>();
      for (const row of groupRows) {
        if (row.weekStartMs != null) continue;
        const key = bareRecurringShadowKey(row);
        if (key == null) continue;
        recurringIds.add(row._id);
        recurringKeys.add(key);
      }
      recurringKeysByGroup.set(groupId, recurringKeys);
    }

    const candidateClusters = new Set<string>();
    const deleteIds: Id<"schedulePlacements">[] = [];
    for (const row of barePlacedRows) {
      if (row.weekStartMs == null) continue;
      const key = bareRecurringShadowKey(row);
      if (key == null || !recurringKeysByGroup.get(row.groupId)?.has(key)) continue;
      candidateClusters.add(key);
      deleteIds.push(row._id);
    }

    if (!dryRun) {
      for (const id of deleteIds) await ctx.db.delete(id);
    }
    return {
      dryRun,
      scope: {
        periodId: args.periodId,
        groupId: args.groupId ?? null,
      },
      batchSize,
      scannedRows: page.page.length,
      recurringRows: recurringIds.size,
      candidateClusters: candidateClusters.size,
      candidateDatedRows: deleteIds.length,
      deletedRows: dryRun ? 0 : deleteIds.length,
      nextCursor: page.isDone ? null : page.continueCursor,
      isDone: page.isDone,
    };
  },
});
const group = v.object({
  name: v.string(),
  emoji: v.optional(v.string()),
  type: v.optional(v.string()),
  scholarKeys: v.array(v.string()),
  ownerKey: v.optional(v.string()),
  creatorKey: v.optional(v.string()),
});

function unique<T>(rows: T[], description: string): T {
  if (rows.length !== 1) throw new Error(`${description}: expected exactly one, found ${rows.length}`);
  return rows[0]!;
}

async function currentPeriodForPrimary(
  ctx: MutationCtx,
  institutionId: Id<"institutions">,
) {
  const institutionPeriods = await ctx.db
    .query("reportingPeriods")
    .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
    .collect();
  const currentPeriods = institutionPeriods.filter(
    (period) => period.startsAt <= Date.now() && period.endsAt >= Date.now(),
  );
  if (currentPeriods.length > 1) {
    throw new Error(
      `current reporting period: expected at most one, found ${currentPeriods.length}`,
    );
  }
  return (
    currentPeriods[0] ??
    unique(
      institutionPeriods.filter(
        (candidate) =>
          candidate.status === "open" || candidate.status === "writing",
      ),
      "active/open reporting period",
    )
  );
}

async function namedTargetGroup(
  ctx: MutationCtx,
  institutionId: Id<"institutions">,
  name: string,
  groupsSnapshot?: Doc<"scholarGroups">[],
) {
  const groups = groupsSnapshot ?? await ctx.db.query("scholarGroups").collect();
  const candidates: Doc<"scholarGroups">[] = [];
  for (const candidateGroup of groups.filter((candidate) => candidate.name === name)) {
    if (candidateGroup.institutionId === institutionId) {
      candidates.push(candidateGroup);
      continue;
    }
    if (
      candidateGroup.institutionId !== undefined ||
      candidateGroup.scholarIds.length === 0
    ) {
      continue;
    }
    const scholars = await Promise.all(
      candidateGroup.scholarIds.map((scholarId) => ctx.db.get(scholarId)),
    );
    if (scholars.every(
      (scholar) =>
        scholar?.role === ROLES.SCHOLAR &&
        scholar.institutionId === institutionId,
    )) {
      candidates.push(candidateGroup);
    }
  }
  return unique(candidates, `group "${name}"`);
}

async function namedTargetGroups(
  ctx: MutationCtx,
  institutionId: Id<"institutions">,
  geckosName: string,
  sealsName: string,
) {
  const groups = await ctx.db.query("scholarGroups").collect();
  const [geckos, seals] = await Promise.all([
    namedTargetGroup(ctx, institutionId, geckosName, groups),
    namedTargetGroup(ctx, institutionId, sealsName, groups),
  ]);
  return new Map([["geckos", geckos], ["seals", seals]]);
}

async function primary(ctx: MutationCtx, dryRun: boolean) {
  const primaryInstitutions = (await ctx.db.query("institutions").collect()).filter(
    (institution) => institution.isPrimary,
  );
  if (primaryInstitutions.length > 1) {
    throw new Error(
      `Primary institution is ambiguous: found ${primaryInstitutions.length}.`,
    );
  }
  if (primaryInstitutions[0]) {
    return primaryInstitutions[0]._id;
  }
  if (dryRun) {
    throw new Error(
      "Primary institution does not exist; dry-run cannot create it.",
    );
  }
  return (await ensureDefaultsInner(ctx))[PRIMARY_SLUG];
}

/**
 * Creates only synthetic, operator-supplied dev accounts. It is deliberately
 * internal: production operators invoke it explicitly after reviewing dryRun.
 */
export const importDevRoster = internalMutation({
  args: { people: v.array(person), groups: v.array(group), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? false;
    const institutionId = await primary(ctx, dryRun);
    const keys = new Set<string>();
    const usernames = new Set<string>();
    for (const p of args.people) {
      if (!p.key.trim() || !p.username.trim() || !p.name.trim()) throw new Error("People require non-empty key, name, and username.");
      if (keys.has(p.key)) throw new Error(`Duplicate person key "${p.key}".`);
      if (usernames.has(p.username)) throw new Error(`Duplicate username "${p.username}".`);
      keys.add(p.key); usernames.add(p.username);
    }
    const byKey = new Map(args.people.map((p) => [p.key, p]));
    const groupNames = new Set<string>();
    for (const g of args.groups) {
      if (!g.name.trim() || groupNames.has(g.name)) throw new Error(`Duplicate or empty group name "${g.name}".`);
      groupNames.add(g.name);
      for (const key of g.scholarKeys) {
        const p = byKey.get(key);
        if (!p) throw new Error(`Group "${g.name}" references missing scholar key "${key}".`);
        if (p.role !== ROLES.SCHOLAR) throw new Error(`Group "${g.name}" key "${key}" is not a scholar.`);
      }
      for (const key of [g.ownerKey, g.creatorKey]) {
        if (key && !byKey.has(key)) throw new Error(`Group "${g.name}" references missing staff key "${key}".`);
        if (key && byKey.get(key)!.role !== ROLES.TEACHER) throw new Error(`Group "${g.name}" key "${key}" is not a teacher.`);
      }
    }

    let usersCreated = 0, usersReused = 0, membershipsCreated = 0, groupsCreated = 0, groupsUpdated = 0;
    const plan: string[] = [];
    const resolved = new Map<string, Id<"users"> | null>();
    for (const p of args.people) {
      const matches = await ctx.db.query("users").withIndex("by_username", q => q.eq("username", p.username)).collect();
      if (matches.length > 1) throw new Error(`Ambiguous username "${p.username}".`);
      const existing = matches[0];
      if (existing && existing.role !== p.role) throw new Error(`Username "${p.username}" has role "${existing.role}", not "${p.role}".`);
      if (
        existing?.role === ROLES.SCHOLAR &&
        existing.institutionId !== undefined &&
        existing.institutionId !== institutionId
      ) {
        throw new Error(
          `Scholar username "${p.username}" belongs to another institution.`,
        );
      }
      if (existing) {
        usersReused++; resolved.set(p.key, existing._id); plan.push(`reuse user:${p.username}`);
      } else {
        usersCreated++; plan.push(`create user:${p.username}`);
        resolved.set(p.key, dryRun ? null : await ctx.db.insert("users", {
          name: p.name, username: p.username, externalId: p.username, role: p.role,
          ...(p.role === ROLES.SCHOLAR ? { institutionId } : {}),
        }));
      }
      const membershipExists = existing && (await ctx.db.query("memberships")
        .withIndex("by_user_role", q => q.eq("userId", existing._id).eq("role", p.role))
        .collect()).some(m => m.institutionId === institutionId);
      if (!membershipExists) membershipsCreated++;
      if (!dryRun && resolved.get(p.key)) {
        const id = resolved.get(p.key)!;
        if (p.role === ROLES.SCHOLAR && existing?.institutionId === undefined) await ctx.db.patch(id, { institutionId });
        await ensureMembership(ctx, { userId: id, role: p.role, institutionId });
      }
    }
    for (const g of args.groups) {
      const matches = (await ctx.db.query("scholarGroups").withIndex("by_institution", q => q.eq("institutionId", institutionId)).collect())
        .filter(row => row.name === g.name);
      if (matches.length > 1) throw new Error(`Ambiguous group "${g.name}" in primary institution.`);
      const scholarIds = g.scholarKeys.map(key => resolved.get(key)!);
      const ownerId = g.ownerKey ? resolved.get(g.ownerKey)! : undefined;
      const creatorId = g.creatorKey ? resolved.get(g.creatorKey)! : ownerId;
      const existing = matches[0];
      if (!existing && !g.creatorKey && !g.ownerKey) throw new Error(`Group "${g.name}" needs ownerKey or creatorKey when being created.`);
      const same = existing && JSON.stringify(existing.scholarIds.map(String).sort()) === JSON.stringify(scholarIds.map(String).sort())
        && existing.emoji === g.emoji && existing.type === g.type && String(existing.ownerId ?? "") === String(ownerId ?? "");
      if (existing) {
        if (!same) { groupsUpdated++; plan.push(`update group:${g.name}`); }
        if (!dryRun && !same) await ctx.db.patch(existing._id, { scholarIds: scholarIds as Id<"users">[], emoji: g.emoji, type: g.type, ownerId });
      } else {
        groupsCreated++; plan.push(`create group:${g.name}`);
        if (!dryRun) await ctx.db.insert("scholarGroups", { institutionId, teacherId: creatorId!, ownerId, name: g.name, emoji: g.emoji, type: g.type, scholarIds: scholarIds as Id<"users">[] });
      }
    }
    return { dryRun, usersCreated, usersReused, membershipsCreated, groupsCreated, groupsUpdated, plan };
  },
});

const blockSpecs = [
  ["morning-circle", "Morning Circle", "08:00", "08:30", "class", 1],
  ["block-a", "Block A", "08:30", "09:40", "class", 1],
  ["block-b", "Block B", "09:40", "10:50", "class", 1],
  ["recess-a", "Recess A", "10:50", "11:05", "recess", 2],
  ["block-c", "Block C", "11:10", "12:20", "class", 1],
  ["lunch", "Lunch / Recess", "12:20", "13:00", "lunch", 2],
  ["block-d", "Block D", "13:00", "14:10", "class", 1],
  ["recess-b", "Recess B", "14:10", "14:25", "recess", 2],
  ["scholar-practice-lab", "Scholar’s Prep", "14:30", "15:00", "prep", 1],
] as const;
const aliases: Record<string, string[]> = {
  "morning-circle": ["block.morning-circle"], "block-a": ["block.a"], "block-b": ["block.b"],
  "block-c": ["block.c"], "block-d": ["block.d"],
};
type Desired = { group: string; day: number; block: string; subject: string; teacher?: "humanities" | "science" | "pe" ; spanBlocks?: number };

function desired(): Desired[] {
  const rows: Desired[] = [];
  for (const day of weekdays) {
    rows.push({ group: "geckos", day, block: "morning-circle", subject: "Morning Circle", teacher: "humanities" });
    rows.push({ group: "seals", day, block: "morning-circle", subject: "Morning Circle", teacher: "science" });
    const mw = day === 1 || day === 3, tt = day === 2 || day === 4;
    rows.push({ group: "geckos", day, block: "block-a", subject: day === 5 ? "Humanities" : "Math Workshop", teacher: "humanities" });
    rows.push({ group: "seals", day, block: "block-a", subject: day === 5 ? "Science" : "Math Workshop", teacher: "science" });
    rows.push({ group: "geckos", day, block: "block-b", subject: mw ? "Humanities" : "Science", teacher: mw ? "humanities" : "science" });
    rows.push({ group: "seals", day, block: "block-b", subject: mw ? "Japanese Cooking Enrichment Cluster" : tt ? "LA Workshop" : "Humanities", teacher: tt || day === 5 ? "humanities" : undefined });
    rows.push({ group: "geckos", day, block: "block-c", subject: mw ? "Japanese Cooking Enrichment Cluster" : tt ? "LA Workshop" : "Holoholo", teacher: tt ? "humanities" : undefined, spanBlocks: day === 5 ? 5 : undefined });
    rows.push({ group: "seals", day, block: "block-c", subject: mw ? "Humanities" : tt ? "Art" : "Holoholo", teacher: mw ? "humanities" : undefined, spanBlocks: day === 5 ? 5 : undefined });
    if (day !== 5) {
      rows.push({ group: "geckos", day, block: "block-d", subject: mw ? "Physical Education" : "Art", teacher: mw ? "pe" : undefined });
      rows.push({ group: "seals", day, block: "block-d", subject: mw ? "Science" : "Physical Education", teacher: mw ? "science" : "pe" });
    }
  }
  return rows;
}

export const reconcileBlockSchedule = internalMutation({
  args: {
    humanitiesStaffName: v.string(), scienceStaffName: v.string(), physicalEducationStaffName: v.string(),
    geckosGroupName: v.optional(v.string()), sealsGroupName: v.optional(v.string()), dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? false, institutionId = await primary(ctx, dryRun);
    const period = await currentPeriodForPrimary(ctx, institutionId);
    const geckosName = args.geckosGroupName ?? "Geckos", sealsName = args.sealsGroupName ?? "Seals";
    const targetGroups = await namedTargetGroups(ctx, institutionId, geckosName, sealsName);
    const groupsStamped = [...targetGroups.values()].filter(
      (group) => group.institutionId === undefined,
    );
    if (!dryRun) {
      for (const group of groupsStamped) {
        await ctx.db.patch(group._id, { institutionId });
      }
    }
    const teacherMemberships = (await ctx.db
      .query("memberships")
      .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
      .collect()).filter((membership) => membership.role === ROLES.TEACHER);
    const teacherIds = new Map<string, Id<"users">>();
    for (const membership of teacherMemberships) {
      teacherIds.set(String(membership.userId), membership.userId);
    }
    const teachers = (await Promise.all(
      [...teacherIds.values()].map((userId) => ctx.db.get(userId)),
    )).filter((user): user is Doc<"users"> => user !== null);
    const staff = new Map<string, Id<"users">>();
    for (const [kind, name] of [["humanities", args.humanitiesStaffName], ["science", args.scienceStaffName], ["pe", args.physicalEducationStaffName]] as const) {
      const users = teachers.filter((user) => user.name === name);
      staff.set(kind, unique(users, `teacher "${name}" in primary institution`)._id);
    }
    const blocks = await ctx.db.query("scheduleBlocks").withIndex("by_period", q => q.eq("periodId", period._id)).collect();
    const canonical = new Map<string, Doc<"scheduleBlocks">>();
    let blocksCreated = 0, blocksUpdated = 0, placementsCreated = 0, placementsDeleted = 0, blockEDeleted = false;
    for (let order = 0; order < blockSpecs.length; order++) {
      const [key, label, startLocal, endLocal, kind, staffNeed] = blockSpecs[order]!;
      const candidates = blocks.filter(b => !b.groupId && (b.key === key || aliases[key]?.includes(b.key) || (b.label === label && b.startLocal === startLocal && b.endLocal === endLocal)));
      if (candidates.length > 1) throw new Error(`Ambiguous shared schedule block "${key}".`);
      let block = candidates[0];
      if (!block) {
        blocksCreated++;
        if (!dryRun) block = await ctx.db.insert("scheduleBlocks", { periodId: period._id, key, label, startLocal, endLocal, weekdays, order, kind, staffNeed }).then(id => ctx.db.get(id)) as Doc<"scheduleBlocks">;
      } else if (block.key !== key || block.label !== label || block.startLocal !== startLocal || block.endLocal !== endLocal || block.order !== order || block.kind !== kind || block.staffNeed !== staffNeed || JSON.stringify(block.weekdays) !== JSON.stringify(weekdays)) {
        blocksUpdated++;
        if (!dryRun) await ctx.db.patch(block._id, { key, label, startLocal, endLocal, weekdays, order, kind, staffNeed });
      }
      if (block) canonical.set(key, block);
    }
    const blockE = blocks.filter(b => !b.groupId && (b.key === "block-e" || b.key === "block.e" || b.label === "Block E"));
    if (blockE.length > 1) throw new Error("Ambiguous shared Block E.");
    const placements = await ctx.db
      .query("schedulePlacements")
      .withIndex("by_period", (q) => q.eq("periodId", period._id))
      .collect();
    if (blockE[0]) {
      const occupied = placements.filter(p => p.blockId === blockE[0]!._id);
      if (occupied.length) throw new Error(`Shared Block E is occupied by ${occupied.length} placement(s); refusing to remove it.`);
      blockEDeleted = true; if (!dryRun) await ctx.db.delete(blockE[0]!._id);
    }
    const targetIds = new Set([...targetGroups.values()].map(g => String(g._id)));
    const canonById = new Map([...canonical.entries()].map(([key, b]) => [String(b._id), key]));
    const desiredRows = desired();
    // A dry run has no minted block ids. Stable canonical keys are sufficient
    // to calculate the exact same plan without writing placeholder documents.
    const blockToken = (key: string) => {
      const block = canonical.get(key);
      return block ? String(block._id) : key;
    };
    const groupToken = (key: string) => String(targetGroups.get(key)!._id);
    const desiredBySlot = new Map(desiredRows.map(r => [
      `${groupToken(r.group)}|${r.day}|${blockToken(r.block)}`, r,
    ]));
    const recurring = placements.filter(p => targetIds.has(String(p.groupId)) && p.periodId === period._id && p.weekStartMs == null);
    for (const p of recurring) {
      const key = canonById.get(String(p.blockId));
      if (!key) continue;
      const slot = `${p.groupId}|${p.weekday}|${p.blockId}`;
      const wanted = desiredBySlot.get(slot);
      if (p.assignmentId || p.activityId) {
        if (wanted) throw new Error(`Work-linked placement ${p._id} occupies a managed desired slot; refusing to replace it.`);
        continue;
      }
      const exact = wanted && p.subject === wanted.subject
        && String(p.teacherId ?? "") === String(wanted.teacher ? staff.get(wanted.teacher)! : "")
        && (p.spanBlocks ?? undefined) === wanted.spanBlocks;
      if (!exact && (wanted || ["morning-circle", "block-a", "block-b", "block-c", "block-d"].includes(key))) {
        placementsDeleted++; if (!dryRun) await ctx.db.delete(p._id);
      }
    }
    // Add only missing desired rows. Exact recurring bare rows survive a rerun.
    for (const row of desiredRows) {
      const slot = `${groupToken(row.group)}|${row.day}|${blockToken(row.block)}`;
      const exists = recurring.some(p => p.assignmentId == null && p.activityId == null
        && `${p.groupId}|${p.weekday}|${p.blockId}` === slot && p.subject === row.subject
        && String(p.teacherId ?? "") === String(row.teacher ? staff.get(row.teacher)! : "")
        && (p.spanBlocks ?? undefined) === row.spanBlocks);
      if (exists) continue;
      placementsCreated++;
      if (!dryRun) await ctx.db.insert("schedulePlacements", {
        periodId: period._id, groupId: targetGroups.get(row.group)!._id, weekday: row.day, blockId: canonical.get(row.block)!._id,
        subject: row.subject, teacherId: row.teacher ? staff.get(row.teacher)! : undefined, spanBlocks: row.spanBlocks,
      });
    }
    return {
      dryRun,
      periodId: period._id,
      groupsStamped: groupsStamped.length,
      blocksCreated,
      blocksUpdated,
      blockEDeleted,
      placementsCreated,
      placementsDeleted,
      managedPlacements: desiredRows.length,
    };
  },
});

function exactDuplicateKey(row: Doc<"schedulePlacements">) {
  return exactSchedulePlacementKey(row);
}

/**
 * Dry-run-first cleanup for exact, already-placed duplicate schedule rows in the
 * two managed groups. The key deliberately distinguishes recurring structure
 * shells from week-specific activity chips, as well as every user-visible or
 * execution-affecting placement field. It never invokes schedule reconciliation:
 * linked duplicate rows share one assignment activitySchedule entry, which must
 * remain untouched while only the redundant plan row is removed.
 */
export const cleanupExactScheduleDuplicates = internalMutation({
  args: {
    geckosGroupName: v.optional(v.string()),
    sealsGroupName: v.optional(v.string()),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const institutionId = await primary(ctx, dryRun);
    const period = await currentPeriodForPrimary(ctx, institutionId);
    const targetGroups = await namedTargetGroups(
      ctx,
      institutionId,
      args.geckosGroupName ?? "Geckos",
      args.sealsGroupName ?? "Seals",
    );
    const targetIds = new Set([...targetGroups.values()].map((group) => String(group._id)));
    const rows = (
      await ctx.db
        .query("schedulePlacements")
        .withIndex("by_period", (q) => q.eq("periodId", period._id))
        .collect()
    ).filter(
      (row) =>
        targetIds.has(String(row.groupId)) &&
        row.weekday != null &&
        row.blockId != null,
    );

    // Validate the entire candidate set before calculating or writing any cleanup,
    // so malformed links cannot turn a partial repair into data loss.
    const linkState = new Map<
      string,
      { assignmentExists: boolean; activityExists: boolean; activityActive: boolean }
    >();
    for (const row of rows) {
      if ((row.assignmentId == null) !== (row.activityId == null)) {
        throw new Error(`Placement ${row._id} has a partial assignment/activity link; refusing cleanup.`);
      }
      if (!row.assignmentId || !row.activityId) continue;
      const linkKey = `${row.assignmentId}|${row.activityId}`;
      if (linkState.has(linkKey)) continue;
      const [assignment, activity] = await Promise.all([
        ctx.db.get(row.assignmentId),
        ctx.db.get(row.activityId),
      ]);
      if (!assignment || !activity) {
        throw new Error(`Placement ${row._id} has a missing linked assignment or activity; refusing cleanup.`);
      }
      linkState.set(linkKey, {
        assignmentExists: true,
        activityExists: true,
        activityActive: !activity.archivedAt,
      });

    }

    const clusters = new Map<string, Doc<"schedulePlacements">[]>();
    for (const row of rows) {
      const key = exactDuplicateKey(row);
      const cluster = clusters.get(key) ?? [];
      cluster.push(row);
      clusters.set(key, cluster);
    }

    const duplicateClusters = [...clusters.values()].filter((cluster) => cluster.length > 1);
    const deleteIds: Id<"schedulePlacements">[] = [];
    for (const cluster of duplicateClusters) {
      const ranked = [...cluster].sort((a, b) => {
        const aState = a.assignmentId && a.activityId
          ? linkState.get(`${a.assignmentId}|${a.activityId}`)
          : undefined;
        const bState = b.assignmentId && b.activityId
          ? linkState.get(`${b.assignmentId}|${b.activityId}`)
          : undefined;
        const aPreferred = aState?.assignmentExists && aState.activityExists && aState.activityActive ? 1 : 0;
        const bPreferred = bState?.assignmentExists && bState.activityExists && bState.activityActive ? 1 : 0;
        if (aPreferred !== bPreferred) return bPreferred - aPreferred;
        return (
          a._creationTime - b._creationTime ||
          String(a._id).localeCompare(String(b._id))
        );
      });
      deleteIds.push(...ranked.slice(1).map((row) => row._id));
    }

    if (!dryRun) {
      for (const id of deleteIds) await ctx.db.delete(id);
    }
    return {
      dryRun,
      periodId: period._id,
      scannedPlacedRows: rows.length,
      duplicateClusters: duplicateClusters.length,
      duplicateRows: deleteIds.length,
      deleted: dryRun ? 0 : deleteIds.length,
      plan:
        deleteIds.length === 0
          ? []
          : [`Remove ${deleteIds.length} exact duplicate row(s) in ${duplicateClusters.length} cluster(s).`],
    };
  },
});

function sameIdSet(left: Id<"users">[], right: Id<"users">[]) {
  const a = new Set(left.map(String));
  const b = new Set(right.map(String));
  return a.size === b.size && [...a].every((id) => b.has(id));
}

/**
 * Archive one proven-redundant assignment using the normal archive invariant:
 * dead cohorts retain their assignment row but have no active schedule entries.
 * This is intentionally parameter-heavy: it is an operator-reviewed repair for
 * one known overlap, not a general assignment merge.
 */
export const archiveRedundantAssignmentSchedule = internalMutation({
  args: {
    canonicalAssignmentId: v.id("assignments"),
    redundantAssignmentId: v.id("assignments"),
    expectedUnitId: v.id("units"),
    expectedGroupName: v.string(),
    expectedPlacementCount: v.number(),
    expectedPlannedEntryCount: v.number(),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    if (args.canonicalAssignmentId === args.redundantAssignmentId) {
      throw new Error("Canonical and redundant assignments must be distinct.");
    }
    const [canonical, redundant] = await Promise.all([
      ctx.db.get(args.canonicalAssignmentId),
      ctx.db.get(args.redundantAssignmentId),
    ]);
    if (!canonical || !redundant) throw new Error("Both assignments must exist.");
    if (
      canonical.unitId !== args.expectedUnitId ||
      redundant.unitId !== args.expectedUnitId
    ) {
      throw new Error("Assignments do not both belong to the expected unit.");
    }
    if (!sameIdSet(canonical.scholarIds, redundant.scholarIds)) {
      throw new Error("Assignments do not have the same scholar roster.");
    }
    if (canonical.archivedAt) throw new Error("Canonical assignment is archived.");

    const institutionId = await primary(ctx, dryRun);
    const period = await currentPeriodForPrimary(ctx, institutionId);
    const targetGroup = await namedTargetGroup(
      ctx,
      institutionId,
      args.expectedGroupName,
    );
    if (!sameIdSet(targetGroup.scholarIds, canonical.scholarIds)) {
      throw new Error("Target group roster does not match the assignment roster.");
    }

    const [canonicalSessions, redundantSessions, placements] = await Promise.all([
      ctx.db
        .query("sessions")
        .withIndex("by_assignment", (q) => q.eq("assignmentId", canonical._id))
        .collect(),
      ctx.db
        .query("sessions")
        .withIndex("by_assignment", (q) => q.eq("assignmentId", redundant._id))
        .collect(),
      ctx.db
        .query("schedulePlacements")
        .withIndex("by_assignment", (q) => q.eq("assignmentId", redundant._id))
        .collect(),
    ]);
    if (canonicalSessions.length < 1) {
      throw new Error("Canonical assignment has no sessions; refusing archive.");
    }

    // A successful prior apply is the only relaxed path. Its core identity and
    // roster checks above still protect a retry with copied or mistyped ids.
    if (redundant.archivedAt && placements.length === 0) {
      return {
        dryRun,
        alreadyApplied: true,
        plannedPlacementDeletes: 0,
        plannedActivityEntries: redundant.activitySchedule?.length ?? 0,
        archived: false,
      };
    }

    if (redundant.archivedAt) throw new Error("Redundant assignment is already archived.");
    if (redundantSessions.length !== 0) {
      throw new Error("Redundant assignment has sessions; refusing archive.");
    }
    if (placements.length !== args.expectedPlacementCount) {
      throw new Error("Redundant assignment placement count does not match the expected count.");
    }
    if ((redundant.activitySchedule ?? []).length !== args.expectedPlannedEntryCount) {
      throw new Error("Redundant assignment planned-entry count does not match the expected count.");
    }
    for (const entry of redundant.activitySchedule ?? []) {
      if (
        entry.setAt != null ||
        entry.scheduledFnId != null ||
        (entry.startsAt != null && entry.startsAt >= Date.now())
      ) {
        throw new Error("Redundant assignment has a live, scheduled, or future activity entry.");
      }
    }
    for (const placement of placements) {
      if (
        placement.periodId !== period._id ||
        placement.groupId !== targetGroup._id ||
        placement.weekStartMs == null ||
        placement.weekday == null ||
        placement.blockId == null ||
        !placement.assignmentId ||
        !placement.activityId
      ) {
        throw new Error("Redundant assignment has a placement outside the approved concrete linked schedule shape.");
      }
    }

    if (!dryRun) {
      for (const placement of placements) await ctx.db.delete(placement._id);
      await ctx.db.patch(redundant._id, {
        archivedAt: Date.now(),
        activitySchedule: [],
      });
    }
    return {
      dryRun,
      alreadyApplied: false,
      plannedPlacementDeletes: placements.length,
      plannedActivityEntries: (redundant.activitySchedule ?? []).length,
      archived: !dryRun,
    };
  },
});
