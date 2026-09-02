// DEV-ONLY pilot helpers for the compressed blind scholar simulation (never ship to
// prod; this file exists only on the pilot worktree's dev deployment).
// - createPilotScholar: stand up the gifted-2nd-grader test scholar.
// - timeShift: slide a scholar's practice/session timestamps back N days so
//   consecutive pilot "days" run inside one real day but the spaced-repetition
//   clock experiences real day gaps.
// - primeStoryMoment: stage a story-bearing fluency transition for the
//   done-screen integration path without waiting for several practice sessions.
// - probePilotState: read-only invariant evidence for the non-driving watcher.
import { v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { ensureDefaultMembershipForUser } from "./memberships";
import { assertValidUsername } from "./lib/username";
import { seedDefaultAppsForScholar } from "./lib/externalAppsSeed";
import { plantTeacherSeed } from "./lib/seeds";
import { DEFAULT_TIMEZONE, PREP_TIME_KEY, dayKeyForTimezone } from "./lib/metaBlocks";
import { ONBOARDING_UNIT_SLUG, ONBOARDING_SYSTEM_USERNAME } from "./onboardingData";
import { PRACTICE_DOMAINS } from "./lib/practice/domains";
import { FLUENT_REPS } from "./lib/practice/scheduler";

const DAY_MS = 86_400_000;
const PILOT_STANDING_TITLE = "Pilot 6 completion-arbiter block";

async function userByUsername(
  ctx: MutationCtx,
  username: string,
) {
  return await ctx.db
    .query("users")
    .withIndex("by_username", (q) => q.eq("username", username))
    .unique();
}

function shiftNumberField<T extends string>(
  row: Record<string, unknown>,
  patch: Record<string, number>,
  field: T,
  delta: number,
) {
  const value = row[field];
  if (typeof value === "number") patch[field] = value - delta;
}

function shiftOptionalNumber(value: number | undefined, delta: number) {
  return typeof value === "number" ? value - delta : undefined;
}

function sameId(a: unknown, b: unknown) {
  return String(a) === String(b);
}

function slugFor(title: string) {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function ensureWelcomeAssignment(ctx: MutationCtx, userId: Id<"users">) {
  const welcome = await ctx.db
    .query("units")
    .withIndex("by_slug", (q) => q.eq("slug", ONBOARDING_UNIT_SLUG))
    .first();
  const systemUser = await userByUsername(ctx, ONBOARDING_SYSTEM_USERNAME);
  if (!welcome || !systemUser) return false;

  const existingAssignments = await ctx.db
    .query("assignments")
    .withIndex("by_unit", (q) => q.eq("unitId", welcome._id))
    .collect();
  if (existingAssignments.some((a) => a.scholarIds.includes(userId))) {
    return false;
  }

  const lessons = await ctx.db
    .query("lessons")
    .withIndex("by_unit", (q) => q.eq("unitId", welcome._id))
    .collect();
  lessons.sort((a, b) => a.order - b.order);
  let firstActivity: Id<"activities"> | undefined;
  for (const lesson of lessons) {
    const activities = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (q) => q.eq("lessonId", lesson._id))
      .collect();
    const online = activities
      .filter((a) => a.kind === "online")
      .sort((a, b) => a.order - b.order);
    if (online[0]) {
      firstActivity = online[0]._id;
      break;
    }
  }

  const now = Date.now();
  await ctx.db.insert("assignments", {
    teacherId: systemUser._id,
    unitId: welcome._id,
    scholarIds: [userId],
    title: welcome.title,
    startedAt: now,
    selfPaced: true,
    activitySchedule: firstActivity
      ? [{ activityId: firstActivity, mode: "classFocus", setAt: now }]
      : [],
  });
  return true;
}

export const suggestQuest = internalMutation({
  args: {
    username: v.string(),
    teacherUsername: v.string(),
    title: v.string(),
    description: v.string(),
    scholarDescription: v.string(),
    emoji: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scholar = await userByUsername(ctx, args.username);
    const teacher = await userByUsername(ctx, args.teacherUsername);
    if (!scholar || !teacher) throw new Error("missing user");
    const title = args.title.trim();
    const existing = (
      await ctx.db
        .query("units")
        .withIndex("by_authorScholar", (q) =>
          q.eq("authorScholarId", scholar._id),
        )
        .collect()
    ).find((u) => u.title === title);
    const unitId =
      existing?._id ??
      (await ctx.db.insert("units", {
        teacherId: scholar._id,
        title,
        slug: slugFor(title),
        emoji: args.emoji ?? "⚡",
        description: args.description,
        scholarDescription: args.scholarDescription,
        isActive: true,
        authorScholarId: scholar._id,
        authorRole: "inspired",
        badgeOnCompletion: {
          title: `${title} — completed`,
          description: `Earned by completing every activity in "${title}".`,
          icon: "🏆",
        },
      }));
    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", unitId))
      .collect();
    let lessonId = lessons.sort((a, b) => a.order - b.order)[0]?._id;
    if (!lessonId) {
      lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Start here",
        order: 0,
        strand: "connections",
      });
    }
    const activities = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (q) => q.eq("lessonId", lessonId))
      .collect();
    if (activities.length === 0) {
      await ctx.db.insert("activities", {
        lessonId,
        title: `Explore ${title}`,
        description: args.scholarDescription,
        kind: "online",
        order: 0,
        durationMinutes: 20,
        defaultMode: "homework",
        systemPrompt: [
          `Guide a curiosity-first exploration of "${title}".`,
          args.description,
          "Use Socratic questions, name real concepts only after the scholar has reasoned toward them, and end by offering a concrete next trail to pull.",
        ].join("\n\n"),
      });
    }
    await plantTeacherSeed(ctx, {
      scholarId: scholar._id,
      topic: title,
      rationale: args.description,
      scholarInvitation: args.scholarDescription,
      teacherId: teacher._id,
      unitId,
    });
    return { unitId, existed: !!existing };
  },
});

export const createPilotScholar = internalMutation({
  args: {
    username: v.string(),
    name: v.string(),
    gradeLevel: v.optional(v.string()),
    readingLevel: v.optional(v.string()),
    podName: v.optional(v.string()), // add to an existing scholarGroup by name
  },
  handler: async (ctx, args) => {
    assertValidUsername(args.username);
    const existing = await userByUsername(ctx, args.username);
    if (existing) {
      await ensureDefaultMembershipForUser(ctx, existing._id);
      await seedDefaultAppsForScholar(ctx, existing._id);
      if (args.podName) {
        const groups = await ctx.db.query("scholarGroups").collect();
        const pod = groups.find((g) => g.name === args.podName);
        if (pod && !pod.scholarIds.includes(existing._id)) {
          await ctx.db.patch(pod._id, {
            scholarIds: [...pod.scholarIds, existing._id],
          });
        }
      }
      await ensureWelcomeAssignment(ctx, existing._id);
      return { userId: existing._id, existed: true };
    }
    const userId = await ctx.db.insert("users", {
      username: args.username,
      name: args.name,
      role: "scholar",
      gradeLevel: args.gradeLevel,
      readingLevel: args.readingLevel,
    });
    await ensureDefaultMembershipForUser(ctx, userId);
    await seedDefaultAppsForScholar(ctx, userId);
    if (args.podName) {
      const groups = await ctx.db.query("scholarGroups").collect();
      const pod = groups.find((g) => g.name === args.podName);
      if (pod && !pod.scholarIds.includes(userId)) {
        await ctx.db.patch(pod._id, {
          scholarIds: [...pod.scholarIds, userId],
        });
      }
    }
    await ensureWelcomeAssignment(ctx, userId);
    return { userId, existed: false };
  },
});

export const addToAssignmentByUnitTitle = internalMutation({
  args: {
    username: v.string(),
    unitTitle: v.string(),
    teacherUsername: v.optional(v.string()),
    selfPaced: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const user = await userByUsername(ctx, args.username);
    if (!user) throw new Error("no user");
    const teacher = args.teacherUsername
      ? await userByUsername(ctx, args.teacherUsername)
      : null;
    const units = await ctx.db.query("units").collect();
    const unit = units.find((u) => u.title === args.unitTitle);
    if (!unit) throw new Error("no unit");
    const assignments = await ctx.db
      .query("assignments")
      .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
      .collect();
    const live = assignments.filter((a) => !a.archivedAt);
    if (live.length === 0) {
      const teacherId = teacher?._id ?? unit.teacherId;
      await ctx.db.insert("assignments", {
        teacherId,
        unitId: unit._id,
        scholarIds: [user._id],
        title: unit.title,
        startedAt: Date.now(),
        selfPaced: args.selfPaced,
        activitySchedule: [],
      });
      return { updated: 1, created: true };
    }
    for (const a of live) {
      if (!a.scholarIds.includes(user._id)) {
        await ctx.db.patch(a._id, {
          scholarIds: [...a.scholarIds, user._id],
        });
      } else if (args.selfPaced !== undefined && a.selfPaced !== args.selfPaced) {
        await ctx.db.patch(a._id, { selfPaced: args.selfPaced });
      }
    }
    return { updated: live.length, created: false };
  },
});

export const pinStandingPractice = internalMutation({
  args: {
    username: v.string(),
    teacherUsername: v.string(),
    domain: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scholar = await userByUsername(ctx, args.username);
    const teacher = await userByUsername(ctx, args.teacherUsername);
    if (!scholar || !teacher) throw new Error("missing user");
    const domain = args.domain ?? "whole-number-arithmetic";
    const rows = await ctx.db.query("assignments").collect();
    const existing = rows.find(
      (row) =>
        row.practiceMode === "standing" &&
        row.title === PILOT_STANDING_TITLE &&
        row.scholarIds.some((id) => sameId(id, scholar._id)),
    );
    const patch = {
      teacherId: teacher._id,
      scholarIds: [scholar._id],
      title: PILOT_STANDING_TITLE,
      practiceMode: "standing" as const,
      practiceConfig: { domain },
      activitySchedule: [],
      archivedAt: undefined,
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return { assignmentId: existing._id, created: false, domain };
    }
    const assignmentId = await ctx.db.insert("assignments", {
      ...patch,
      startedAt: Date.now(),
    });
    return { assignmentId, created: true, domain };
  },
});

export const clearStandingPractice = internalMutation({
  args: { username: v.string() },
  handler: async (ctx, args) => {
    const scholar = await userByUsername(ctx, args.username);
    if (!scholar) throw new Error(`no user ${args.username}`);
    const rows = await ctx.db.query("assignments").collect();
    const matches = rows.filter(
      (row) =>
        !row.archivedAt &&
        row.practiceMode === "standing" &&
        row.title === PILOT_STANDING_TITLE &&
        row.scholarIds.some((id) => sameId(id, scholar._id)),
    );
    const archivedAt = Date.now();
    for (const row of matches) {
      await ctx.db.patch(row._id, { archivedAt });
    }
    return { archived: matches.length };
  },
});

export const setPrepBlockForGroup = internalMutation({
  args: { groupName: v.string() },
  handler: async (ctx, args) => {
    const groups = await ctx.db.query("scholarGroups").collect();
    const g = groups.find((x) => x.name === args.groupName);
    if (!g) throw new Error("no group");
    await ctx.db.patch(g._id, {
      dailyBlocks: [
        ...(g.dailyBlocks ?? []).filter((block) => block.key !== PREP_TIME_KEY),
        {
          key: PREP_TIME_KEY,
          label: "Scholar’s Prep",
          startLocal: "00:00",
          endLocal: "23:59",
          days: [1, 2, 3, 4, 5, 6, 7],
          timezone: "Pacific/Honolulu",
        },
      ],
    });
    return { group: g.name };
  },
});

export const endLiveFocusForUnit = internalMutation({
  args: { unitTitle: v.string() },
  handler: async (ctx, args) => {
    const units = await ctx.db.query("units").collect();
    const unit = units.find((u) => u.title === args.unitTitle);
    if (!unit) throw new Error("no unit");
    const assignments = await ctx.db
      .query("assignments")
      .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
      .collect();
    const now = Date.now();
    let ended = 0;
    for (const a of assignments) {
      const sched = a.activitySchedule ?? [];
      let changed = false;
      for (const e of sched) {
        if (
          e.mode === "classFocus" &&
          e.setAt &&
          (!e.endsAt || e.endsAt > now)
        ) {
          e.endsAt = now;
          changed = true;
          ended++;
        }
      }
      if (changed) await ctx.db.patch(a._id, { activitySchedule: sched });
    }
    return { ended };
  },
});

export const setFocusWindowForUnit = internalMutation({
  args: { unitTitle: v.string(), minutesFromNow: v.number() },
  handler: async (ctx, args) => {
    const units = await ctx.db.query("units").collect();
    const unit = units.find((u) => u.title === args.unitTitle);
    if (!unit) throw new Error("no unit");
    const assignments = await ctx.db
      .query("assignments")
      .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
      .collect();
    const now = Date.now();
    const endsAt = now + args.minutesFromNow * 60_000;
    let n = 0;
    for (const a of assignments) {
      if (a.archivedAt) continue;
      const sched = a.activitySchedule ?? [];
      let changed = false;
      for (const e of sched) {
        if (e.mode === "classFocus") {
          // Stamp setAt so a merely-PLANNED entry (startsAt only) goes live.
          e.setAt = now;
          e.endsAt = endsAt;
          changed = true;
          n++;
        }
      }
      if (changed) await ctx.db.patch(a._id, { activitySchedule: sched });
    }
    return { n, endsAt };
  },
});

export const pushActivityByUnitTitle = internalMutation({
  args: {
    unitTitle: v.string(),
    mode: v.union(v.literal("classFocus"), v.literal("homework")),
    dueInHours: v.optional(v.number()),
    activityIndex: v.optional(v.number()), // nth activity in unit order, default 0
    preserveExisting: v.optional(v.boolean()),
    plannedStartInMinutes: v.optional(v.number()),
    durationMinutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const units = await ctx.db.query("units").collect();
    const unit = units.find((u) => u.title === args.unitTitle);
    if (!unit) throw new Error("no unit");
    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
      .collect();
    lessons.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const acts: Array<{ _id: Id<"activities"> }> = [];
    for (const l of lessons) {
      const la = await ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", l._id))
        .collect();
      la.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      acts.push(...la);
    }
    const act = acts[args.activityIndex ?? 0];
    if (!act) throw new Error("no activity");
    const assignments = await ctx.db
      .query("assignments")
      .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
      .collect();
    const live = assignments.find((a) => !a.archivedAt);
    if (!live) throw new Error("no assignment");
    const now = Date.now();
    const existingEntry = (live.activitySchedule ?? []).find((entry) =>
      sameId(entry.activityId, act._id),
    );
    if (args.preserveExisting && existingEntry) {
      return {
        pushed: String(act._id),
        mode: existingEntry.mode,
        preserved: true,
      };
    }
    const sched = (live.activitySchedule ?? []).filter(
      (entry) => !sameId(entry.activityId, act._id),
    );
    if (args.plannedStartInMinutes !== undefined) {
      if (args.mode !== "classFocus") {
        throw new Error("plannedStartInMinutes is only supported for classFocus");
      }
      if (args.plannedStartInMinutes < 0 || (args.durationMinutes ?? 0) <= 0) {
        throw new Error("planned focus requires non-negative start and positive duration");
      }
      const startsAt = now + args.plannedStartInMinutes * 60_000;
      sched.push({
        activityId: act._id,
        mode: args.mode,
        startsAt,
        endsAt: startsAt + args.durationMinutes! * 60_000,
      });
    } else {
      sched.push({
        activityId: act._id,
        mode: args.mode,
        setAt: now,
        startsAt: now,
        ...(args.dueInHours
          ? { dueAt: now + args.dueInHours * 3_600_000 }
          : {}),
      });
    }
    await ctx.db.patch(live._id, { activitySchedule: sched });
    return {
      pushed: String(act._id),
      mode: args.mode,
      preserved: false,
      ...(args.plannedStartInMinutes === undefined
        ? {}
        : {
            plannedStartInMinutes: args.plannedStartInMinutes,
            durationMinutes: args.durationMinutes,
          }),
    };
  },
});

export const activateFocusByUnitTitle = internalMutation({
  args: {
    unitTitle: v.string(),
    activityIndex: v.optional(v.number()),
    minutesFromNow: v.number(),
  },
  handler: async (ctx, args) => {
    if (args.minutesFromNow <= 0) throw new Error("minutesFromNow must be positive");
    const units = await ctx.db.query("units").collect();
    const unit = units.find((candidate) => candidate.title === args.unitTitle);
    if (!unit) throw new Error("no unit");
    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
      .collect();
    lessons.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const activities: Array<{ _id: Id<"activities"> }> = [];
    for (const lesson of lessons) {
      const rows = await ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", lesson._id))
        .collect();
      rows.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      activities.push(...rows);
    }
    const activity = activities[args.activityIndex ?? 0];
    if (!activity) throw new Error("no activity");
    const assignments = await ctx.db
      .query("assignments")
      .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
      .collect();
    const live = assignments.find((assignment) => !assignment.archivedAt);
    if (!live) throw new Error("no assignment");
    const schedule = live.activitySchedule ?? [];
    const entry = schedule.find(
      (candidate) =>
        candidate.mode === "classFocus" &&
        sameId(candidate.activityId, activity._id),
    );
    if (!entry) throw new Error("planned class focus not found");
    const now = Date.now();
    entry.setAt = now;
    entry.startsAt = now;
    entry.endsAt = now + args.minutesFromNow * 60_000;
    await ctx.db.patch(live._id, { activitySchedule: schedule });
    return {
      assignmentId: live._id,
      activityId: activity._id,
      setAt: now,
      endsAt: entry.endsAt,
    };
  },
});

export const probeFocus = internalQuery({
  args: { username: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.username))
      .unique();
    if (!user) throw new Error("no user");
    const now = Date.now();
    const all = await ctx.db.query("assignments").collect();
    const out: Array<Record<string, unknown>> = [];
    for (const a of all) {
      if (a.archivedAt) continue;
      const targeted = a.scholarIds.includes(user._id);
      for (const e of a.activitySchedule ?? []) {
        if (e.mode !== "classFocus") continue;
        out.push({
          assignment: String(a._id),
          unitId: a.unitId ? String(a.unitId) : null,
          targeted,
          setAt: e.setAt ?? null,
          startsAt: e.startsAt ?? null,
          endsAt: e.endsAt ?? null,
          liveNow:
            (e.setAt ?? Infinity) <= now && (!e.endsAt || e.endsAt > now),
          activityId: String(e.activityId),
        });
      }
    }
    return { now, out };
  },
});

export const primeStoryMoment = internalMutation({
  args: {
    username: v.string(),
    skillKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scholar = await userByUsername(ctx, args.username);
    if (!scholar) throw new Error(`no user ${args.username}`);

    const skillKey = args.skillKey ?? "lcm";
    const node = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_nodeKey", (q) => q.eq("nodeKey", skillKey))
      .first();
    if (!node) throw new Error(`unknown skill ${skillKey}`);

    const now = Date.now();
    const existing = await ctx.db
      .query("practiceMastery")
      .withIndex("by_scholar_skill", (q) =>
        q.eq("scholarId", scholar._id).eq("skillKey", skillKey),
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        repetition: Math.max(existing.repetition, 3),
        source: "practice",
        becameFluentAt: now,
        lastAttemptAt: now,
        lastPracticedAt: now,
        updatedAt: now,
      });
      return { updated: true, skillKey };
    }

    await ctx.db.insert("practiceMastery", {
      scholarId: scholar._id,
      skillKey,
      domain: node.domain,
      strand: node.strand,
      repetition: 3,
      halfLifeDays: 30,
      lastPracticedAt: now,
      lastAttemptAt: now,
      frontier: false,
      source: "practice",
      updatedAt: now,
      becameFluentAt: now,
    });
    return { updated: false, skillKey };
  },
});

/**
 * Post-placement fixture only: make one story-bearing skill a single honest,
 * unassisted correct answer away from demonstrated fluency. Placement-style
 * access credit is deliberately not a green claim; recordAttemptCore promotes
 * it to source:"practice" and stamps becameFluentAt only after the real answer.
 */
export const primeStoryOneAnswerAway = internalMutation({
  args: {
    username: v.string(),
    skillKey: v.string(),
  },
  handler: async (ctx, args) => {
    const scholar = await userByUsername(ctx, args.username);
    if (!scholar) throw new Error(`no user ${args.username}`);

    const placements = await ctx.db
      .query("practicePlacements")
      .withIndex("by_scholar_domain", (q) => q.eq("scholarId", scholar._id))
      .collect();
    if (!placements.some((placement) => placement.status === "complete")) {
      throw new Error("primeStoryOneAnswerAway requires completed placement");
    }

    const node = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_nodeKey", (q) => q.eq("nodeKey", args.skillKey))
      .first();
    if (!node) throw new Error(`unknown skill ${args.skillKey}`);

    const storyEdges = (
      await ctx.db
        .query("knowledgeNodeEdges")
        .withIndex("by_from", (q) => q.eq("fromKey", args.skillKey))
        .collect()
    ).filter((edge) => edge.story !== undefined);
    if (storyEdges.length === 0) {
      throw new Error(`skill ${args.skillKey} has no story-bearing edge`);
    }

    const now = Date.now();
    const existing = await ctx.db
      .query("practiceMastery")
      .withIndex("by_scholar_skill", (q) =>
        q.eq("scholarId", scholar._id).eq("skillKey", args.skillKey),
      )
      .first();
    const staged = {
      repetition: FLUENT_REPS,
      halfLifeDays: 4,
      lastPracticedAt: now,
      lastAttemptAt: undefined,
      frontier: false,
      source: "placement",
      updatedAt: now,
      becameFluentAt: undefined,
      frontierAdvancedAt: undefined,
    };

    if (existing) {
      await ctx.db.patch(existing._id, {
        ...staged,
        ...(node.strand !== undefined ? { strand: node.strand } : {}),
      });
    } else {
      await ctx.db.insert("practiceMastery", {
        scholarId: scholar._id,
        skillKey: args.skillKey,
        domain: node.domain,
        strand: node.strand,
        ...staged,
      });
    }

    return {
      skillKey: args.skillKey,
      storyEdges: storyEdges.map((edge) => ({
        toKey: edge.toKey,
        hook: edge.story!.hook,
      })),
      updated: existing !== null,
    };
  },
});

/**
 * J1 (pilot9 judgment queue, Option A) demo fixture — DEV ONLY. Stage ONE
 * scholar with BOTH tree-render states in the SAME domain/strand so the Tree map
 * shows them side by side:
 *   • a DEMONSTRATED node (source "practice", becameFluentAt set) → full green
 *   • a PROVISIONAL node (source "placement", becameFluentAt unset) → "placed"
 * Reproducibility fixture for the QB walk; not part of the render fix itself.
 */
export const stageJ1TreeDemo = internalMutation({
  args: {
    username: v.string(),
    demonstratedKey: v.optional(v.string()),
    placedKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scholar = await userByUsername(ctx, args.username);
    if (!scholar) throw new Error(`no user ${args.username}`);
    const scholarId = scholar._id;
    const now = Date.now();

    async function upsert(
      skillKey: string,
      fields: Partial<Doc<"practiceMastery">>,
    ) {
      const node = await ctx.db
        .query("knowledgeNodes")
        .withIndex("by_nodeKey", (q) => q.eq("nodeKey", skillKey))
        .first();
      if (!node) throw new Error(`unknown skill ${skillKey}`);
      const existing = await ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar_skill", (q) =>
          q.eq("scholarId", scholarId).eq("skillKey", skillKey),
        )
        .first();
      const base = {
        repetition: FLUENT_REPS,
        halfLifeDays: 30,
        lastPracticedAt: now,
        frontier: false,
        updatedAt: now,
        ...fields,
      };
      if (existing) {
        await ctx.db.patch(existing._id, base);
      } else {
        await ctx.db.insert("practiceMastery", {
          scholarId,
          skillKey,
          domain: node.domain,
          strand: node.strand,
          ...base,
        } as Doc<"practiceMastery">);
      }
      return { skillKey, domain: node.domain, strand: node.strand ?? null };
    }

    const demonstrated = await upsert(args.demonstratedKey ?? "count_to_10", {
      source: "practice",
      becameFluentAt: now,
      lastAttemptAt: now,
    });
    const placed = await upsert(args.placedKey ?? "count_to_20", {
      source: "placement",
      halfLifeDays: 4,
      becameFluentAt: undefined,
      lastAttemptAt: undefined,
    });
    return { scholar: scholar.username, demonstrated, placed };
  },
});

export const probeStorySkill = internalQuery({
  args: { skillKey: v.string() },
  handler: async (ctx, args) => {
    const node = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_nodeKey", (q) => q.eq("nodeKey", args.skillKey))
      .first();
    if (!node) throw new Error(`unknown skill ${args.skillKey}`);
    const edges = await ctx.db
      .query("knowledgeNodeEdges")
      .withIndex("by_from", (q) => q.eq("fromKey", args.skillKey))
      .collect();
    return {
      skillKey: args.skillKey,
      label: node.label,
      domain: node.domain,
      grade: node.grade ?? null,
      storyEdges: edges
        .filter((edge) => edge.story !== undefined)
        .map((edge) => ({
          toKey: edge.toKey,
          hook: edge.story!.hook,
          provenance: edge.story!.provenance,
        })),
    };
  },
});

export const primeBonusChooser = internalMutation({
  args: {
    username: v.string(),
    domain: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scholar = await userByUsername(ctx, args.username);
    if (!scholar) throw new Error(`no user ${args.username}`);

    const domain = args.domain ?? "whole-number-arithmetic";
    const mastery = (
      await ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar_domain", (q) =>
          q.eq("scholarId", scholar._id).eq("domain", domain),
        )
        .collect()
    )
      .filter((row) => row.repetition >= 3)
      .sort((a, b) => a.skillKey.localeCompare(b.skillKey));
    if (mastery.length < 6) {
      throw new Error(
        `need 6 fluent ${domain} skills for a deterministic bonus; found ${mastery.length}`,
      );
    }

    const stagedAt = Date.now() - 3 * DAY_MS;
    for (const row of mastery.slice(0, 6)) {
      await ctx.db.patch(row._id, {
        repetition: Math.max(row.repetition, 3),
        halfLifeDays: Math.max(row.halfLifeDays, 30),
        lastPracticedAt: stagedAt,
        lastAttemptAt: stagedAt,
        updatedAt: stagedAt,
      });
    }
    return {
      domain,
      eligibleSkills: mastery.slice(0, 6).map((row) => row.skillKey),
    };
  },
});

export const probePilotState = internalQuery({
  args: { username: v.string() },
  handler: async (ctx, args) => {
    const scholar = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.username))
      .unique();
    if (!scholar) throw new Error(`no user ${args.username}`);

    const placements = await ctx.db
      .query("practicePlacements")
      .withIndex("by_scholar_domain", (q) => q.eq("scholarId", scholar._id))
      .collect();
    const attempts = await ctx.db
      .query("practiceAttempts")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholar._id))
      .collect();
    const momentEvents = await ctx.db
      .query("momentEvents")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholar._id))
      .collect();
    const choices = await ctx.db
      .query("practiceChoiceEvents")
      .withIndex("by_scholar_createdAt", (q) =>
        q.eq("scholarId", scholar._id),
      )
      .collect();

    const liveProbes = placements.flatMap((placement) =>
      placement.servedProbe
        ? [{
            domain: placement.domain,
            nodeKey: placement.servedProbe.nodeKey,
            itemId: placement.servedProbe.itemId,
          }]
        : [],
    );

    return {
      registeredDomains: PRACTICE_DOMAINS.map(({ domain, label }) => ({
        domain,
        label,
      })),
      placement: {
        rows: placements.map((placement) => ({
          domain: placement.domain,
          status: placement.status,
          probesAnswered: placement.probesAnswered,
          probeLogEntries: placement.probeLog?.length ?? 0,
        })),
        probesAnswered: placements.reduce(
          (total, placement) => total + placement.probesAnswered,
          0,
        ),
        liveProbeCount: liveProbes.length,
        liveProbes,
      },
      recentAttempts: attempts.slice(-30).map((attempt) => ({
        domain: attempt.domain ?? null,
        nodeKey: attempt.nodeKey,
        lane: attempt.lane ?? null,
        correct: attempt.correct,
        createdAt: attempt.createdAt ?? null,
      })),
      momentEvents: momentEvents.slice(-10).map((event) => ({
        fromKey: event.fromKey,
        toKey: event.toKey,
        offeredAt: event.offeredAt,
        outcome: event.outcome,
        outcomeAt: event.outcomeAt ?? null,
      })),
      recentChoices: choices.slice(-10).map((choice) => ({
        domain: choice.domain,
        strand: choice.strand,
        source: choice.source,
        createdAt: choice.createdAt,
      })),
    };
  },
});

export const timeShift = internalMutation({
  args: {
    username: v.string(),
    days: v.number(), // shift this many days into the past
  },
  handler: async (ctx, args) => {
    const user = await userByUsername(ctx, args.username);
    if (!user) throw new Error(`no user ${args.username}`);
    if (!Number.isFinite(args.days) || args.days < 0) {
      throw new Error("days must be a non-negative finite number");
    }
    const delta = args.days * DAY_MS;
    const touched: Record<string, number> = {};
    const bump = (table: string) => {
      touched[table] = (touched[table] ?? 0) + 1;
    };

    const mastery = await ctx.db
      .query("practiceMastery")
      .withIndex("by_scholar", (q) => q.eq("scholarId", user._id))
      .collect();
    for (const m of mastery) {
      const patch: Record<string, number> = {};
      for (const f of [
        "lastPracticedAt",
        "lastAttemptAt",
        "updatedAt",
        "becameFluentAt",
        "frontierAdvancedAt",
        "lastImplicitAt",
      ] as const) {
        shiftNumberField(m, patch, f, delta);
      }
      if (Object.keys(patch).length) {
        await ctx.db.patch(m._id, patch);
        bump("practiceMastery");
      }
    }

    const momentEvents = await ctx.db
      .query("momentEvents")
      .withIndex("by_scholar", (q) => q.eq("scholarId", user._id))
      .collect();
    for (const event of momentEvents) {
      await ctx.db.patch(event._id, {
        offeredAt: event.offeredAt - delta,
        outcomeAt: shiftOptionalNumber(event.outcomeAt, delta),
      });
      bump("momentEvents");
    }

    const attempts = await ctx.db
      .query("practiceAttempts")
      .withIndex("by_scholar", (q) => q.eq("scholarId", user._id))
      .collect();
    for (const a of attempts) {
      const patch: Partial<Doc<"practiceAttempts">> = {};
      if (typeof a.createdAt === "number") patch.createdAt = a.createdAt - delta;
      // teach-on-miss explanation lifecycle stamps (analytics-only, per-scholar):
      // shift them too so their ordering relative to the attempt is preserved.
      for (const f of [
        "explanationRequestedAt",
        "explanationStartedAt",
        "explanationFinishedAt",
        "explanationErrorAt",
      ] as const) {
        const value = a[f];
        if (typeof value === "number") patch[f] = value - delta;
      }
      if (Object.keys(patch).length) {
        await ctx.db.patch(a._id, patch);
        bump("practiceAttempts");
      }
    }

    const errorEvents = await ctx.db
      .query("practiceErrorEvents")
      .withIndex("by_scholar", (q) => q.eq("scholarId", user._id))
      .collect();
    for (const e of errorEvents) {
      await ctx.db.patch(e._id, { createdAt: e.createdAt - delta });
      bump("practiceErrorEvents");
    }

    const choiceEvents = await ctx.db
      .query("practiceChoiceEvents")
      .withIndex("by_scholar_createdAt", (q) =>
        q.eq("scholarId", user._id),
      )
      .collect();
    for (const choice of choiceEvents) {
      await ctx.db.patch(choice._id, { createdAt: choice.createdAt - delta });
      bump("practiceChoiceEvents");
    }

    const closureLines = (await ctx.db.query("closureLines").collect()).filter(
      (line) => sameId(line.scholarId, user._id),
    );
    for (const line of closureLines) {
      await ctx.db.patch(line._id, { createdAt: line.createdAt - delta });
      bump("closureLines");
    }

    const predictions = await ctx.db
      .query("practicePredictions")
      .withIndex("by_scholar", (q) => q.eq("scholarId", user._id))
      .collect();
    for (const p of predictions) {
      await ctx.db.patch(p._id, { createdAt: p.createdAt - delta });
      bump("practicePredictions");
    }

    const tuneups = await ctx.db
      .query("practiceTuneups")
      .withIndex("by_scholar", (q) => q.eq("scholarId", user._id))
      .collect();
    for (const t of tuneups) {
      await ctx.db.patch(t._id, {
        startedAt: t.startedAt - delta,
        completedAt: shiftOptionalNumber(t.completedAt, delta),
      });
      bump("practiceTuneups");
    }

    const placements = await ctx.db
      .query("practicePlacements")
      .withIndex("by_scholar_domain", (q) => q.eq("scholarId", user._id))
      .collect();
    for (const p of placements) {
      const probeLog = p.probeLog?.map((entry) => ({
        ...entry,
        at: entry.at - delta,
      }));
      const patch: Partial<Doc<"practicePlacements">> = {
        updatedAt: p.updatedAt - delta,
        ...(probeLog ? { probeLog } : {}),
      };
      await ctx.db.patch(p._id, patch);
      bump("practicePlacements");
    }

    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const sessionIds = new Set(sessions.map((s) => String(s._id)));
    for (const s of sessions) {
      const patch: Partial<Doc<"sessions">> = {};
      for (const f of [
        "sessionStartTime",
        "activityCompletedAt",
        "lastMessageAt",
        // reopenedAt (#707): keeps a re-entered completed session on the active
        // plate at the right day so "keep working on this" work stays visible
        // across the shifted pilot week.
        "reopenedAt",
      ] as const) {
        const value = s[f];
        if (typeof value === "number") patch[f] = value - delta;
      }
      if (patch.lastMessageAt === undefined) {
        patch.lastMessageAt = s._creationTime - delta;
      }
      if (s.reflection) {
        patch.reflection = {
          ...s.reflection,
          generatedAt: s.reflection.generatedAt - delta,
        };
      }
      if (Object.keys(patch).length) {
        await ctx.db.patch(s._id, patch);
        bump("sessions");
      }

      const messages = await ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", s._id))
        .collect();
      for (const message of messages) {
        if (typeof message.lastStreamActivityAt !== "number") continue;
        await ctx.db.patch(message._id, {
          lastStreamActivityAt: message.lastStreamActivityAt - delta,
        });
        bump("messages");
      }
    }

    const teachBacks = await ctx.db
      .query("teachBacks")
      .withIndex("by_scholar", (q) => q.eq("scholarId", user._id))
      .collect();
    for (const teachBack of teachBacks) {
      await ctx.db.patch(teachBack._id, {
        createdAt: teachBack.createdAt - delta,
        gradedAt: shiftOptionalNumber(teachBack.gradedAt, delta),
      });
      bump("teachBacks");
    }

    const completions = await ctx.db
      .query("activityCompletions")
      .withIndex("by_scholar", (q) => q.eq("scholarId", user._id))
      .collect();
    for (const c of completions) {
      await ctx.db.patch(c._id, { completedAt: c.completedAt - delta });
      bump("activityCompletions");
    }

    const metaChats = await ctx.db
      .query("metaChats")
      .withIndex("by_scholar_day", (q) => q.eq("scholarId", user._id))
      .collect();
    for (const chat of metaChats) {
      const createdAt = chat.createdAt - delta;
      const lastMessageAt = chat.lastMessageAt - delta;
      await ctx.db.patch(chat._id, {
        createdAt,
        lastMessageAt,
        dayKey: dayKeyForTimezone(createdAt, DEFAULT_TIMEZONE),
      });
      bump("metaChats");

      const metaMessages = await ctx.db
        .query("metaMessages")
        .withIndex("by_chat", (q) => q.eq("chatId", chat._id))
        .collect();
      for (const message of metaMessages) {
        await ctx.db.patch(message._id, {
          createdAt: message.createdAt - delta,
        });
        bump("metaMessages");
      }
    }

    const badges = await ctx.db
      .query("scholarUnitBadges")
      .withIndex("by_scholar", (q) => q.eq("scholarId", user._id))
      .collect();
    for (const badge of badges) {
      await ctx.db.patch(badge._id, { earnedAt: badge.earnedAt - delta });
      bump("scholarUnitBadges");
    }

    const goals = await ctx.db
      .query("weeklyGoals")
      .withIndex("by_scholar", (q) => q.eq("scholarId", user._id))
      .collect();
    for (const goal of goals) {
      await ctx.db.patch(goal._id, {
        createdAt: goal.createdAt - delta,
        updatedAt: shiftOptionalNumber(goal.updatedAt, delta),
        // activatedAt (#694): a scholar-set goal is active-at-creation and this
        // anchors the practice-movement window on the goal card, so it must
        // slide with the rest of the scholar's clock.
        activatedAt: shiftOptionalNumber(goal.activatedAt, delta),
      });
      bump("weeklyGoals");
    }

    const observations = await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar", (q) => q.eq("scholarId", user._id))
      .collect();
    for (const o of observations) {
      await ctx.db.patch(o._id, { observedAt: o.observedAt - delta });
      bump("masteryObservations");
    }

    const granules = await ctx.db
      .query("granuleEvidence")
      .withIndex("by_scholar_unit", (q) => q.eq("scholarId", user._id))
      .collect();
    for (const g of granules) {
      await ctx.db.patch(g._id, { observedAt: g.observedAt - delta });
      bump("granuleEvidence");
    }

    const seeds = await ctx.db
      .query("seeds")
      .withIndex("by_scholar_status", (q) => q.eq("scholarId", user._id))
      .collect();
    for (const seed of seeds) {
      if (typeof seed.completedAt !== "number") continue;
      await ctx.db.patch(seed._id, { completedAt: seed.completedAt - delta });
      bump("seeds");
    }

    const suggestions = await ctx.db
      .query("scholarSuggestions")
      .withIndex("by_scholar", (q) => q.eq("scholarId", user._id))
      .collect();
    for (const suggestion of suggestions) {
      await ctx.db.patch(suggestion._id, {
        createdAt: suggestion.createdAt - delta,
        updatedAt: suggestion.updatedAt - delta,
        responseSeenAt: shiftOptionalNumber(suggestion.responseSeenAt, delta),
        archivedAt: shiftOptionalNumber(suggestion.archivedAt, delta),
        staffResponse: suggestion.staffResponse
          ? {
              ...suggestion.staffResponse,
              at: suggestion.staffResponse.at - delta,
            }
          : undefined,
      });
      bump("scholarSuggestions");
    }

    const graphemeInventories = await ctx.db
      .query("graphemeInventories")
      .withIndex("by_scholar", (q) => q.eq("scholarId", user._id))
      .collect();
    for (const row of graphemeInventories) {
      await ctx.db.patch(row._id, { updatedAt: row.updatedAt - delta });
      bump("graphemeInventories");
    }

    const graphemeHistory = await ctx.db
      .query("graphemeHistory")
      .withIndex("by_scholar", (q) => q.eq("scholarId", user._id))
      .collect();
    for (const row of graphemeHistory) {
      await ctx.db.patch(row._id, { recordedAt: row.recordedAt - delta });
      bump("graphemeHistory");
    }

    const directives = await ctx.db
      .query("teacherDirectives")
      .withIndex("by_scholar", (q) => q.eq("scholarId", user._id))
      .collect();
    for (const row of directives) {
      await ctx.db.patch(row._id, { updatedAt: row.updatedAt - delta });
      bump("teacherDirectives");
    }

    const sessionScopedTables = [
      "sessionSignals",
      "crossDomainConnections",
      "physicalTasks",
      "deliverables",
      "portfolioItems",
      "webActivitySessions",
    ] as const;
    for (const table of sessionScopedTables) {
      const rows = await ctx.db.query(table).collect();
      for (const row of rows) {
        if (
          "sessionId" in row &&
          row.sessionId &&
          !sessionIds.has(String(row.sessionId))
        ) {
          continue;
        }
        if ("scholarId" in row && !sameId(row.scholarId, user._id)) {
          continue;
        }
        const patch: Record<string, number> = {};
        for (const field of [
          "createdAt",
          "updatedAt",
          "startedAt",
          "suggestedAt",
          "completedAt",
          "endedAt",
          "submittedAt",
          "matchedAt",
        ] as const) {
          shiftNumberField(row, patch, field, delta);
        }
        if (Object.keys(patch).length === 0) continue;
        await ctx.db.patch(row._id, patch);
        bump(table);
      }
    }

    return { touched, days: args.days };
  },
});
