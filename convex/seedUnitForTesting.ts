// Internal seed for unit progress dashboard testing. Creates:
// - A regular unit "Aviation 101 (test)" with 2 lessons × 2 activities each
// - A focus targeting that unit (for Class sub-tab verification)
// - A scholar-scoped IS unit "Independent Aviation (test)" for the
//   named scholar with 1 lesson × 2 activities
// - One activity completion for the scholar in the regular unit (so the
//   dashboard has something to display)
//
// Idempotent — re-running upserts.

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { DEFAULT_BADGE_STYLE, DEFAULT_BADGE_COLORWAY } from "./lib/badgeArt";
import type { Id } from "./_generated/dataModel";

export const seedUnitProgressForTesting = internalMutation({
  args: {
    teacherUsername: v.string(),
    scholarUsername: v.string(),
  },
  handler: async (ctx, args) => {
    const teacher = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.teacherUsername))
      .first();
    if (!teacher) throw new Error(`Teacher not found`);
    const scholar = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.scholarUsername))
      .first();
    if (!scholar) throw new Error(`Scholar not found`);

    async function upsertUnit(title: string) {
      const existing = await ctx.db
        .query("units")
        .withIndex("by_teacher", (q) => q.eq("teacherId", teacher!._id))
        .filter((q) => q.eq(q.field("title"), title))
        .first();
      if (existing) return existing._id;
      return await ctx.db.insert("units", {
        teacherId: teacher!._id,
        title,
        emoji: "✈️",
        isActive: true,
      });
    }

    async function upsertLesson(
      unitId: Id<"units">,
      title: string,
      order: number,
    ) {
      const existing = await ctx.db
        .query("lessons")
        .withIndex("by_unit", (q) => q.eq("unitId", unitId))
        .filter((q) => q.eq(q.field("title"), title))
        .first();
      if (existing) return existing._id;
      return await ctx.db.insert("lessons", {
        unitId,
        title,
        order,
      });
    }

    async function upsertActivity(
      lessonId: Id<"lessons">,
      title: string,
      order: number,
      scholarDescription: string,
    ) {
      const existing = await ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", lessonId))
        .filter((q) => q.eq(q.field("title"), title))
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, { scholarDescription });
        return existing._id;
      }
      return await ctx.db.insert("activities", {
        lessonId,
        title,
        kind: "online" as const,
        systemPrompt: "Help the scholar.",
        order,
        scholarDescription,
      });
    }

    // Regular unit
    const unitId = await upsertUnit("Aviation 101 (test)");
    const lessonAId = await upsertLesson(unitId, "Lesson A — Lift", 0);
    const lessonBId = await upsertLesson(unitId, "Lesson B — Drag", 1);
    const aa1 = await upsertActivity(
      lessonAId,
      "How wings work",
      0,
      "You'll investigate how wings lift a plane.",
    );
    const aa2 = await upsertActivity(
      lessonAId,
      "Paper plane test",
      1,
      "You'll test a paper plane and notice what changes its flight.",
    );
    const ba1 = await upsertActivity(
      lessonBId,
      "What slows a plane",
      0,
      "You'll explore the forces that slow a plane down.",
    );
    const ba2 = await upsertActivity(
      lessonBId,
      "Reduce drag",
      1,
      "You'll try ideas for helping a plane move smoothly through the air.",
    );

    // Two scholar-authored IS Units (post-unification: one Unit per
    // independent study, with one Lesson + one Activity scaffolded).
    const makeIsUnit = async (title: string) => {
      const u = await ctx.db.insert("units", {
        teacherId: scholar._id,
        title,
        emoji: "⚡",
        isActive: true,
        authorScholarId: scholar._id,
      });
      const l = await ctx.db.insert("lessons", {
        unitId: u,
        title: "My exploration",
        order: 0,
      });
      const a = await ctx.db.insert("activities", {
        lessonId: l,
        title,
        kind: "online" as const,
        order: 0,
        scholarDescription: "You'll explore a question that matters to you.",
      });
      return { unitId: u, activityId: a };
    };
    const { activityId: isa1 } = await makeIsUnit("IS Activity 1");
    const { activityId: isa2 } = await makeIsUnit("IS Activity 2");

    // Seed an Assignment for the regular unit with the scholar in
    // the cohort, marked as class focus. Reuses any existing one for
    // this (teacher, unit) so the script is idempotent.
    const existingAssignment = (
      await ctx.db
        .query("assignments")
        .withIndex("by_teacher", (q) => q.eq("teacherId", teacher._id))
        .collect()
    ).find((a) => a.unitId === unitId && !a.archivedAt);
    if (existingAssignment) {
      await ctx.db.patch(existingAssignment._id, {
        scholarIds: Array.from(
          new Set([...existingAssignment.scholarIds, scholar._id]),
        ),
      });
    } else {
      await ctx.db.insert("assignments", {
        teacherId: teacher._id,
        unitId,
        scholarIds: [scholar._id],
        startedAt: Date.now(),
      });
    }

    // A completion for the scholar (so dashboard shows something)
    const existingCompletion = await ctx.db
      .query("activityCompletions")
      .withIndex("by_scholar_activity", (q) =>
        q.eq("scholarId", scholar._id).eq("activityId", aa1),
      )
      .first();
    if (!existingCompletion) {
      await ctx.db.insert("activityCompletions", {
        scholarId: scholar._id,
        activityId: aa1,
        lessonId: lessonAId,
        unitId,
        completedAt: Date.now(),
        note: "(test seed) Completed as part of dashboard verification.",
      });
    }

    // Also: a project for the scholar in this unit so the dashboard
    // can show "current activity" / live-pulse fields.
    const existingProj = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", scholar._id))
      .filter((q) => q.eq(q.field("unitId"), unitId))
      .first();
    if (!existingProj) {
      await ctx.db.insert("sessions", {
        userId: scholar._id,
        unitId,
        lessonId: lessonAId,
        activityId: aa2,
        title: "Aviation 101 (test) — work",
        isArchived: false,
        lastMessageAt: Date.now() - 30_000,
        lastMessageRole: "user",
        lastMessagePreview:
          "I think the wing shape makes the air go faster on top...",
        pulseScore: 3.8,
        analysisSummary: "Engaged; explaining lift in their own words.",
      });
    }

    return {
      unitId,
      lessonAId,
      lessonBId,
      activityIds: [aa1, aa2, ba1, ba2],
      isActivityIds: [isa1, isa2],
    };
  },
});

// Seed earned unit-completion badges for a scholar so the Badges
// surfaces (scholar home + /scholar/profile) have something to show.
// Attaches a `badgeOnCompletion` config to a few seeded units and
// inserts the matching `scholarUnitBadges` rows. Idempotent — skips
// any (scholar, unit) badge that already exists.
export const seedEarnedBadgesForTesting = internalMutation({
  args: { scholarUsername: v.string() },
  handler: async (ctx, args) => {
    const scholar = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.scholarUsername))
      .first();
    if (!scholar) throw new Error(`Scholar not found: ${args.scholarUsername}`);

    // Pick the first few active, teacher-authored units from the seed.
    const units = (
      await ctx.db
        .query("units")
        .withIndex("by_active", (q) => q.eq("isActive", true))
        .collect()
    )
      .filter((u) => !u.authorScholarId)
      .slice(0, 3);
    if (units.length === 0) throw new Error("No seeded units to badge");

    const awarded: string[] = [];
    for (const unit of units) {
      const badge = {
        title: `${unit.title} — completed`,
        description: `Earned by completing every activity in "${unit.title}".`,
        icon: unit.emoji ?? "🏆",
      };
      // Attach the badge config to the unit if it has none yet.
      if (!unit.badgeOnCompletion) {
        await ctx.db.patch(unit._id, { badgeOnCompletion: badge });
      }
      const existing = await ctx.db
        .query("scholarUnitBadges")
        .withIndex("by_scholar_unit", (q) =>
          q.eq("scholarId", scholar._id).eq("unitId", unit._id),
        )
        .first();
      if (existing) continue;
      const badgeId = await ctx.db.insert("scholarUnitBadges", {
        scholarId: scholar._id,
        unitId: unit._id,
        earnedAt: Date.now() - awarded.length * 86_400_000, // stagger days
        badgeSnapshot: unit.badgeOnCompletion ?? badge,
        style: DEFAULT_BADGE_STYLE,
        colorway: DEFAULT_BADGE_COLORWAY,
        artStatus: "generating",
        rerollsUsed: 0,
      });
      await ctx.scheduler.runAfter(0, internal.badgeArtActions.generateBadgeArt, {
        badgeId,
      });
      awarded.push(unit.title);
    }
    return { scholar: scholar.username, awarded };
  },
});

// Stages the badge-completion celebration for a scholar: takes their most
// recent session that belongs to a unit, attaches a badge to that unit (if
// none), awards it (scheduling art), and marks the session complete — so
// loading /scholar/<sessionId> renders the BadgeCelebration. Idempotent.
export const stageBadgeCelebrationForTesting = internalMutation({
  args: { scholarUsername: v.string() },
  handler: async (ctx, args) => {
    const scholar = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.scholarUsername))
      .first();
    if (!scholar) throw new Error(`Scholar not found: ${args.scholarUsername}`);

    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", scholar._id))
      .collect();
    const session = sessions
      .filter((s) => s.unitId)
      .sort((a, b) => b._creationTime - a._creationTime)[0];
    if (!session?.unitId) {
      throw new Error("No session with a unit for this scholar");
    }
    const unit = await ctx.db.get(session.unitId);
    if (!unit) throw new Error("Unit not found");

    const badgeConfig = unit.badgeOnCompletion ?? {
      title: `${unit.title} — completed`,
      description: `Earned by completing "${unit.title}".`,
      icon: unit.emoji ?? "🏆",
    };
    if (!unit.badgeOnCompletion) {
      await ctx.db.patch(unit._id, { badgeOnCompletion: badgeConfig });
    }

    let badge = await ctx.db
      .query("scholarUnitBadges")
      .withIndex("by_scholar_unit", (q) =>
        q.eq("scholarId", scholar._id).eq("unitId", unit._id),
      )
      .first();
    if (!badge) {
      const badgeId = await ctx.db.insert("scholarUnitBadges", {
        scholarId: scholar._id,
        unitId: unit._id,
        earnedAt: Date.now(),
        badgeSnapshot: badgeConfig,
        style: DEFAULT_BADGE_STYLE,
        colorway: DEFAULT_BADGE_COLORWAY,
        artStatus: "generating",
        rerollsUsed: 0,
      });
      await ctx.scheduler.runAfter(0, internal.badgeArtActions.generateBadgeArt, {
        badgeId,
      });
      badge = await ctx.db.get(badgeId);
    }

    await ctx.db.patch(session._id, { activityCompletedAt: Date.now() });
    return { sessionId: session._id, unitId: unit._id, unitTitle: unit.title };
  },
});

// Reset a badge to a fresh, customizable state (ready art, rerolls
// restored) — lets manual UI checks of the customization flow rerun.
export const resetBadgeRerollsForTesting = internalMutation({
  args: { scholarUsername: v.string() },
  handler: async (ctx, args) => {
    const scholar = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.scholarUsername))
      .first();
    if (!scholar) throw new Error(`Scholar not found: ${args.scholarUsername}`);
    const badges = await ctx.db
      .query("scholarUnitBadges")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholar._id))
      .collect();
    for (const b of badges) {
      await ctx.db.patch(b._id, { rerollsUsed: 0, artStatus: "ready" });
    }
    return { reset: badges.length };
  },
});

export const teardownUnitProgressForTesting = internalMutation({
  args: { teacherUsername: v.string() },
  handler: async (ctx, args) => {
    const teacher = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.teacherUsername))
      .first();
    if (!teacher) return null;

    const titles = ["Aviation 101 (test)", "Independent Aviation (test)"];
    for (const title of titles) {
      const unit = await ctx.db
        .query("units")
        .withIndex("by_teacher", (q) => q.eq("teacherId", teacher._id))
        .filter((q) => q.eq(q.field("title"), title))
        .first();
      if (!unit) continue;
      // delete completions
      const completions = await ctx.db
        .query("activityCompletions")
        .collect();
      for (const c of completions) {
        if (c.unitId === unit._id) await ctx.db.delete(c._id);
      }
      // delete projects
      const sessions = await ctx.db.query("sessions").collect();
      for (const p of sessions) {
        if (p.unitId === unit._id) await ctx.db.delete(p._id);
      }
      // delete activities + lessons
      const lessons = await ctx.db
        .query("lessons")
        .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
        .collect();
      for (const l of lessons) {
        const acts = await ctx.db
          .query("activities")
          .withIndex("by_lesson", (q) => q.eq("lessonId", l._id))
          .collect();
        for (const a of acts) await ctx.db.delete(a._id);
        await ctx.db.delete(l._id);
      }
      await ctx.db.delete(unit._id);
    }
    // Clear activitySchedule on any assignments still pointing at the
    // deleted unit. (Post Assignments split; the units we just
    // deleted may have orphan assignments.)
    const all = await ctx.db.query("assignments").collect();
    for (const a of all) {
      if (a.activitySchedule && a.activitySchedule.length > 0) {
        // Safe: standing (unitId-less) assignments never populate
        // activitySchedule, so reaching here means unit-mode.
        const unit = await ctx.db.get(a.unitId!);
        if (!unit) await ctx.db.patch(a._id, { activitySchedule: [] });
      }
    }
    return null;
  },
});

// Give a scholar a live, IN-PROGRESS class-focus + homework activity for an
// assignment they're already on, so their /scholar plate shows all three
// sections (Class focus · Homework · Quests) instead of only Quests.
//
// The plate is session-driven and only shows an assigned activity that is
// (a) live in the assignment's schedule and (b) not yet completed. In the
// rich seed, a cohort scholar's assigned work is typically FINISHED (the
// completions exist) and the in-class window has since elapsed in wall-clock
// time — so nothing shows under Class focus / Homework. This helper, for the
// scholar's first matching assignment:
//   1. re-opens a classFocus + a homework schedule entry to a current window
//      (so the plate treats them as live again), and
//   2. clears the scholar's completions for those two activities + un-archives
//      their existing sessions (so the work reads as in-progress).
// Idempotent — re-running just re-stamps the same window and no-ops the rest.
export const seedAssignedWorkForScholar = internalMutation({
  args: { scholarUsername: v.string() },
  handler: async (ctx, args) => {
    const scholar = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.scholarUsername))
      .first();
    if (!scholar) throw new Error(`Scholar not found: ${args.scholarUsername}`);

    const now = Date.now();
    const CLASS_WINDOW_MS = 50 * 60_000; // ends in ~50 min ("in class now")
    const HOMEWORK_DUE_MS = 3 * 24 * 60 * 60_000; // due in 3 days
    const isLive = (e: { setAt?: number; endsAt?: number }) =>
      e.setAt != null && !(e.endsAt != null && e.endsAt <= now);

    const assignments = await ctx.db.query("assignments").collect();
    const out: {
      scholar: string;
      assignment?: string;
      classFocus?: string;
      homework?: string;
      notes: string[];
    } = { scholar: args.scholarUsername, notes: [] };

    for (const a of assignments) {
      if (a.archivedAt) continue;
      if (!a.scholarIds.includes(scholar._id)) continue;
      const schedule = a.activitySchedule ?? [];
      if (schedule.length === 0) continue;

      // Pick one entry per mode, preferring an already-live one.
      const pick = (mode: "classFocus" | "homework") =>
        schedule.find((e) => e.mode === mode && isLive(e)) ??
        schedule.find((e) => e.mode === mode) ??
        null;
      const cf = pick("classFocus");
      const hw = pick("homework");
      if (!cf && !hw) continue; // not the assignment we're after

      // Re-stamp the chosen entries to a current window so the plate treats
      // them as live (classFocus auto-clears via endsAt; homework via dueAt).
      const newSchedule = schedule.map((e) => {
        if (e === cf) {
          return {
            ...e,
            setAt: now,
            startsAt: undefined,
            scheduledFnId: undefined,
            endsAt: now + CLASS_WINDOW_MS,
          };
        }
        if (e === hw) {
          return {
            ...e,
            setAt: now,
            startsAt: undefined,
            scheduledFnId: undefined,
            endsAt: undefined,
            dueAt: now + HOMEWORK_DUE_MS,
          };
        }
        return e;
      });
      await ctx.db.patch(a._id, { activitySchedule: newSchedule });

      const ensureInProgress = async (
        entry: { activityId: Id<"activities"> } | null,
        mode: "classFocus" | "homework",
      ): Promise<string | undefined> => {
        if (!entry) return undefined;
        const activityId = entry.activityId;
        const activity = await ctx.db.get(activityId);
        const lessonId = activity?.lessonId;
        const lesson = lessonId ? await ctx.db.get(lessonId) : null;
        const unitId = lesson?.unitId ?? a.unitId;
        const title = activity?.title ?? "Assigned work";

        // Un-complete: the plate drops any activity with a completion
        // (scoped by assignment). Delete them so it reads as in-progress.
        const comps = await ctx.db
          .query("activityCompletions")
          .withIndex("by_scholar_activity", (q) =>
            q.eq("scholarId", scholar._id).eq("activityId", activityId),
          )
          .collect();
        for (const c of comps) await ctx.db.delete(c._id);

        // Reuse the scholar's existing session for this assignment+activity,
        // or create one if (somehow) absent.
        const existing = await ctx.db
          .query("sessions")
          .withIndex("by_user", (q) => q.eq("userId", scholar._id))
          .filter((q) =>
            q.and(
              q.eq(q.field("assignmentId"), a._id),
              q.eq(q.field("activityId"), activityId),
            ),
          )
          .first();
        if (existing) {
          await ctx.db.patch(existing._id, {
            isArchived: false,
            activityCompletedAt: undefined,
            activityCompletionMessageId: undefined,
            lastMessageAt: now - (mode === "classFocus" ? 5 : 60) * 60_000,
          });
        } else {
          await ctx.db.insert("sessions", {
            userId: scholar._id,
            unitId,
            lessonId,
            activityId,
            assignmentId: a._id,
            title,
            isArchived: false,
            lastMessageAt: now - (mode === "classFocus" ? 5 : 60) * 60_000,
            lastMessageRole: "user",
            lastMessagePreview:
              mode === "classFocus"
                ? "I picked a small moment — the time I dropped my shave ice…"
                : "Working on my draft — trying to slow down the big part.",
            pulseScore: 3.6,
            analysisSummary:
              mode === "classFocus"
                ? "Engaged; choosing a concrete small moment to write about."
                : "Drafting independently; stretching one moment across sentences.",
          });
        }
        return title;
      };

      out.assignment = a.title ?? a.unitId;
      out.classFocus = await ensureInProgress(cf, "classFocus");
      out.homework = await ensureInProgress(hw, "homework");
      if (cf && !isLive(cf)) out.notes.push("re-opened classFocus window");
      if (hw && !isLive(hw)) out.notes.push("re-opened homework window");
      break; // only the first matching assignment
    }

    if (!out.assignment) out.notes.push("no live assignment found for scholar");
    return out;
  },
});

// Seed a CHOICE lesson assigned to a scholar so the scholar-home "choice menu"
// (web ScholarPlate + native ChoiceMenuCard) has something to render. Creates a
// unit "Choice Test (test)" with ONE choice lesson (pick 1 of 3) + 3 online
// activities, an assignment for the scholar with all 3 options pushed live as
// classFocus, and clears any prior completions/sessions so all 3 read as
// not-started. Idempotent — re-running re-stamps the schedule live.
export const seedChoiceLessonForTesting = internalMutation({
  args: {
    teacherUsername: v.string(),
    scholarUsername: v.string(),
    pickCount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const teacher = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.teacherUsername))
      .first();
    if (!teacher) throw new Error(`Teacher not found: ${args.teacherUsername}`);
    const scholar = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.scholarUsername))
      .first();
    if (!scholar) throw new Error(`Scholar not found: ${args.scholarUsername}`);

    const now = Date.now();
    const pickCount = Math.max(1, Math.round(args.pickCount ?? 1));

    // Unit
    const unitTitle = "Choice Test (test)";
    let unitId = (
      await ctx.db
        .query("units")
        .withIndex("by_teacher", (q) => q.eq("teacherId", teacher._id))
        .filter((q) => q.eq(q.field("title"), unitTitle))
        .first()
    )?._id;
    if (!unitId) {
      unitId = await ctx.db.insert("units", {
        teacherId: teacher._id,
        title: unitTitle,
        emoji: "🍽️",
        isActive: true,
      });
    }

    // One choice lesson (pick N of 3)
    const lessonTitle = "Pick a path";
    let lessonId = (
      await ctx.db
        .query("lessons")
        .withIndex("by_unit", (q) => q.eq("unitId", unitId!))
        .filter((q) => q.eq(q.field("title"), lessonTitle))
        .first()
    )?._id;
    if (lessonId) {
      await ctx.db.patch(lessonId, {
        selectionMode: "choice",
        choicePickCount: pickCount,
      });
    } else {
      lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: lessonTitle,
        order: 0,
        selectionMode: "choice",
        choicePickCount: pickCount,
      });
    }

    // Three online activity options
    const options = [
      {
        title: "Build a volcano",
        scholarDescription:
          "You'll build a volcano model and investigate what makes eruptions happen.",
      },
      {
        title: "Write a poem about lava",
        scholarDescription:
          "You'll write a poem that imagines the heat, motion, and power of lava.",
      },
      {
        title: "Map the world's volcanoes",
        scholarDescription:
          "You'll map the world's volcanoes and look for patterns in where they appear.",
      },
    ];
    const activityIds: Id<"activities">[] = [];
    for (let i = 0; i < options.length; i++) {
      const option = options[i];
      const title = option.title;
      const existingActivity = await ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", lessonId!))
        .filter((q) => q.eq(q.field("title"), title))
        .first();
      let aId: Id<"activities">;
      if (existingActivity) {
        await ctx.db.patch(existingActivity._id, {
          scholarDescription: option.scholarDescription,
        });
        aId = existingActivity._id;
      } else {
        aId = await ctx.db.insert("activities", {
          lessonId,
          title,
          kind: "online" as const,
          systemPrompt: "Help the scholar explore this option Socratically.",
          description: `Option ${i + 1}: ${title.toLowerCase()}.`,
          scholarDescription: option.scholarDescription,
          durationMinutes: 20,
          order: i,
        });
      }
      activityIds.push(aId);
    }

    // Clear any prior completions + sessions for these activities so all read
    // as not-started (a fresh menu).
    for (const aId of activityIds) {
      const comps = await ctx.db
        .query("activityCompletions")
        .withIndex("by_scholar_activity", (q) =>
          q.eq("scholarId", scholar._id).eq("activityId", aId),
        )
        .collect();
      for (const c of comps) await ctx.db.delete(c._id);
      const sess = await ctx.db
        .query("sessions")
        .withIndex("by_user", (q) => q.eq("userId", scholar._id))
        .filter((q) => q.eq(q.field("activityId"), aId))
        .collect();
      for (const s of sess) await ctx.db.delete(s._id);
    }

    // Assignment: push all 3 options live as classFocus so each surfaces as a
    // not-started option row (grouped into one choice menu on the plate).
    const CLASS_WINDOW_MS = 60 * 60_000;
    const schedule = activityIds.map((activityId) => ({
      activityId,
      mode: "classFocus" as const,
      setAt: now,
      endsAt: now + CLASS_WINDOW_MS,
    }));
    const existing = (
      await ctx.db
        .query("assignments")
        .withIndex("by_teacher", (q) => q.eq("teacherId", teacher._id))
        .collect()
    ).find((a) => a.unitId === unitId && !a.archivedAt);
    let assignmentId: Id<"assignments">;
    if (existing) {
      assignmentId = existing._id;
      await ctx.db.patch(existing._id, {
        scholarIds: Array.from(
          new Set([...existing.scholarIds, scholar._id]),
        ),
        activitySchedule: schedule,
      });
    } else {
      assignmentId = await ctx.db.insert("assignments", {
        teacherId: teacher._id,
        unitId,
        scholarIds: [scholar._id],
        startedAt: now,
        activitySchedule: schedule,
      });
    }

    return { unitId, lessonId, activityIds, assignmentId, pickCount };
  },
});

// Offer an EXISTING unit to a scholar as a structured destination (an offer
// star with unitId) — mirrors what units.createAndOfferQuestForScholar
// does, but against a real seeded unit so the star opts into actual
// activities. Lets us eyeball the "guided path" star + opt-in flow.
export const offerUnitToScholarForTesting = internalMutation({
  args: { scholarUsername: v.string(), unitTitle: v.string() },
  handler: async (ctx, args) => {
    const scholar = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.scholarUsername))
      .first();
    if (!scholar) throw new Error(`Scholar not found: ${args.scholarUsername}`);
    const unit = (await ctx.db.query("units").collect()).find(
      (u) => u.title === args.unitTitle && u.isActive,
    );
    if (!unit) throw new Error(`Unit not found: ${args.unitTitle}`);

    const existing = await ctx.db
      .query("seeds")
      .withIndex("by_scholar_status", (q) => q.eq("scholarId", scholar._id))
      .filter((q) => q.eq(q.field("topic"), unit.title))
      .first();
    if (existing) return { seedId: existing._id, reused: true };

    // Attribute the offer to the scholar's group teacher (or the unit's
    // teacher as a fallback) so the card shows a real name, not "Your teacher".
    const groups = await ctx.db.query("scholarGroups").collect();
    const myGroup = groups.find((g) =>
      g.scholarIds.some((id) => String(id) === String(scholar._id)),
    );
    const teacherId = myGroup?.teacherId ?? unit.teacherId;

    const seedId = await ctx.db.insert("seeds", {
      scholarId: scholar._id,
      origin: "teacher",
      status: "active",
      topic: unit.title,
      suggestionType: "teacher_suggestion",
      rationale: `A quest your teacher set up for you — fly here when you're ready.`,
      unitId: unit._id,
      teacherId,
    });
    return { seedId, reused: false };
  },
});

// Give the existing scholar-authored quests a spread of lifecycle states so
// the /teacher/quests chips + pipeline summary are legible in review: one
// in-flight (a session), one badged (a completion badge). Idempotent.
export const seedQuestVarietyForTesting = internalMutation({
  args: {},
  handler: async (ctx) => {
    const out: string[] = [];
    const byUsername = (u: string) =>
      ctx.db
        .query("users")
        .withIndex("by_username", (q) => q.eq("username", u))
        .first();

    // Owners: prefer the rich cohort, else any scholars.
    let owners = (
      await Promise.all(
        ["emma_higa", "kalei_bautista", "koa_demello", "leilani_park"].map(
          byUsername,
        ),
      )
    ).filter((u): u is NonNullable<typeof u> => u != null);
    if (owners.length < 4) {
      owners = await ctx.db
        .query("users")
        .withIndex("by_role", (q) => q.eq("role", "scholar"))
        .take(4);
    }
    if (owners.length === 0) throw new Error("no scholars to seed quests for");
    const owner = (i: number) => owners[i % owners.length]._id;

    // Idempotent unit creator (by owner + title) with N online activities.
    const makeUnit = async (
      ownerId: Id<"users">,
      title: string,
      emoji: string,
      activities: number,
    ): Promise<Id<"units">> => {
      const scholarDescription = "You'll begin this part of your quest.";
      const existing = (
        await ctx.db
          .query("units")
          .withIndex("by_authorScholar", (q) => q.eq("authorScholarId", ownerId))
          .collect()
      ).find((u) => u.title === title);
      if (existing) {
        const lesson = await ctx.db
          .query("lessons")
          .withIndex("by_unit", (q) => q.eq("unitId", existing._id))
          .first();
        if (lesson) {
          const existingActivities = await ctx.db
            .query("activities")
            .withIndex("by_lesson", (q) => q.eq("lessonId", lesson._id))
            .collect();
          for (const activity of existingActivities) {
            await ctx.db.patch(activity._id, { scholarDescription });
          }
        }
        return existing._id;
      }
      const unitId = await ctx.db.insert("units", {
        teacherId: ownerId,
        authorScholarId: ownerId,
        title,
        emoji,
        isActive: true,
        badgeOnCompletion: { title: `${title} — completed`, icon: emoji },
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Getting started",
        order: 0,
      });
      for (let i = 0; i < activities; i++) {
        await ctx.db.insert("activities", {
          lessonId,
          title: `Activity ${i + 1}`,
          order: i,
          kind: "online",
          scholarDescription,
        });
      }
      return unitId;
    };
    const hasSession = (sid: Id<"users">, unitId: Id<"units">) =>
      ctx.db
        .query("sessions")
        .withIndex("by_user", (q) => q.eq("userId", sid))
        .filter((q) => q.eq(q.field("unitId"), unitId))
        .first();

    // OFFERED — an offer star, no session yet.
    {
      const sid = owner(0);
      const unitId = await makeUnit(sid, "Tide Pools of Oʻahu", "🐚", 2);
      const seed = await ctx.db
        .query("seeds")
        .withIndex("by_scholar_status", (q) => q.eq("scholarId", sid))
        .filter((q) => q.eq(q.field("unitId"), unitId))
        .first();
      if (!seed) {
        await ctx.db.insert("seeds", {
          scholarId: sid,
          origin: "teacher",
          status: "active",
          topic: "Tide Pools of Oʻahu",
          suggestionType: "teacher_suggestion",
          rationale: "A quest your teacher set up — fly here when you're ready.",
          unitId,
          teacherId: sid,
        });
        out.push("offered: Tide Pools of Oʻahu");
      }
    }
    // LAUNCHED — a session, nothing finished yet.
    {
      const sid = owner(1);
      const unitId = await makeUnit(sid, "Backyard Birds", "🐦", 2);
      if (!(await hasSession(sid, unitId))) {
        await ctx.db.insert("sessions", {
          userId: sid,
          unitId,
          title: "Backyard Birds",
          isArchived: false,
          lastMessageAt: Date.now() - 30 * 60_000,
          lastMessageRole: "assistant",
          lastMessagePreview: "Welcome! Which bird shows up at your feeder most?",
        });
        out.push("launched: Backyard Birds");
      }
    }
    // IN FLIGHT — a session + one completed activity.
    {
      const sid = owner(2);
      const unitId = await makeUnit(sid, "Build a Weather Station", "🌦️", 3);
      if (!(await hasSession(sid, unitId))) {
        await ctx.db.insert("sessions", {
          userId: sid,
          unitId,
          title: "Build a Weather Station",
          isArchived: false,
          lastMessageAt: Date.now() - 18 * 60_000,
          lastMessageRole: "user",
          lastMessagePreview: "I logged the temperature for three days…",
        });
        const lessons = await ctx.db
          .query("lessons")
          .withIndex("by_unit", (q) => q.eq("unitId", unitId))
          .collect();
        const acts = lessons[0]
          ? await ctx.db
              .query("activities")
              .withIndex("by_lesson", (q) => q.eq("lessonId", lessons[0]._id))
              .collect()
          : [];
        if (acts[0]) {
          await ctx.db.insert("activityCompletions", {
            scholarId: sid,
            activityId: acts[0]._id,
            lessonId: lessons[0]._id,
            unitId,
            completedAt: Date.now() - 60 * 60_000,
          });
        }
        out.push("in flight: Build a Weather Station");
      }
    }
    // BADGED — a completion badge.
    {
      const sid = owner(3);
      const unitId = await makeUnit(sid, "Origami Animals", "🦢", 2);
      const badge = await ctx.db
        .query("scholarUnitBadges")
        .withIndex("by_scholar_unit", (q) =>
          q.eq("scholarId", sid).eq("unitId", unitId),
        )
        .first();
      if (!badge) {
        await ctx.db.insert("scholarUnitBadges", {
          scholarId: sid,
          unitId,
          earnedAt: Date.now() - 2 * 24 * 60 * 60_000,
          badgeSnapshot: { title: "Origami Animals — completed", icon: "🦢" },
        });
        out.push("badged: Origami Animals");
      }
    }
    // STALLED — in progress but left untouched (the "bounced off it" signal).
    {
      const sid = owner(1);
      const unitId = await makeUnit(sid, "Secret Codes in Nature", "🐝", 3);
      if (!(await hasSession(sid, unitId))) {
        await ctx.db.insert("sessions", {
          userId: sid,
          unitId,
          title: "Secret Codes in Nature",
          isArchived: false,
          lastMessageAt: Date.now() - 8 * 24 * 60 * 60_000, // 8 days quiet
          lastMessageRole: "assistant",
          lastMessagePreview: "Bees dance to point hive-mates at flowers — want to crack it?",
        });
        out.push("stalled: Secret Codes in Nature");
      }
    }
    return { out };
  },
});

// Seed a scholar with MULTI-ACTIVITY scholar-owned quests in a spread of
// states, so the home plate shows the not-started / partially-done / actively-
// in-progress cases side by side (used to evaluate the "Continue" launch
// behaviour on multi-step quests). Idempotent by (scholar, title).
export const seedMultiActivityQuestStates = internalMutation({
  args: { scholarUsername: v.string() },
  handler: async (ctx, args) => {
    const scholar = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.scholarUsername))
      .first();
    if (!scholar) throw new Error(`Scholar not found: ${args.scholarUsername}`);
    const sid = scholar._id;

    type ActivityFixture = {
      title: string;
      scholarDescription?: string;
    };

    const makeUnit = async (
      title: string,
      emoji: string,
      description: string,
      scholarDescription: string,
      activities: ActivityFixture[],
    ) => {
      const existing = (
        await ctx.db
          .query("units")
          .withIndex("by_authorScholar", (q) => q.eq("authorScholarId", sid))
          .collect()
      ).find((u) => u.title === title);
      if (existing) {
        const lessons = await ctx.db
          .query("lessons")
          .withIndex("by_unit", (q) => q.eq("unitId", existing._id))
          .collect();
        const lessonId = lessons[0]?._id;
        const existingActivities = lessonId
          ? await ctx.db
              .query("activities")
              .withIndex("by_lesson", (q) => q.eq("lessonId", lessonId))
              .collect()
          : [];
        for (const activity of existingActivities) {
          const fixture = activities.find(
            (candidate) => candidate.title === activity.title,
          );
          if (fixture) {
            await ctx.db.patch(activity._id, {
              scholarDescription: fixture.scholarDescription,
            });
          }
        }
        const activityIds = existingActivities
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          .map((a) => a._id);
        return { unitId: existing._id, lessonId: lessonId!, activityIds };
      }
      const unitId = await ctx.db.insert("units", {
        teacherId: sid,
        authorScholarId: sid,
        title,
        emoji,
        description,
        scholarDescription,
        isActive: true,
        badgeOnCompletion: { title: `${title} — completed`, icon: emoji },
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Core",
        order: 0,
      });
      const activityIds: Id<"activities">[] = [];
      for (let i = 0; i < activities.length; i++) {
        const activity = activities[i];
        const aid = await ctx.db.insert("activities", {
          lessonId,
          title: activity.title,
          description: `Step ${i + 1}: ${activity.title.toLowerCase()}.`,
          scholarDescription: activity.scholarDescription,
          order: i,
          kind: "online",
        });
        activityIds.push(aid);
      }
      return { unitId, lessonId, activityIds };
    };

    const complete = async (
      unitId: Id<"units">,
      lessonId: Id<"lessons">,
      activityId: Id<"activities">,
    ) => {
      const exist = await ctx.db
        .query("activityCompletions")
        .withIndex("by_scholar_activity", (q) =>
          q.eq("scholarId", sid).eq("activityId", activityId),
        )
        .first();
      if (!exist) {
        await ctx.db.insert("activityCompletions", {
          scholarId: sid,
          activityId,
          lessonId,
          unitId,
          completedAt: Date.now(),
          note: "(test seed) multi-activity state demo",
        });
      }
    };

    // Q1 — NOT STARTED (3 activities, nothing done, no session).
    await makeUnit(
      "Make a Mini Comic",
      "📓",
      `${scholar.name ?? "The scholar"}'s three-step quest to make a tiny comic — sketch, ink, then letter it.`,
      "Your three-step quest to make a tiny comic — sketch it, ink the lines, then add the words.",
      [
        {
          title: "Sketch your three panels",
          scholarDescription:
            "You'll sketch three panels to begin your mini comic.",
        },
        {
          title: "Ink the line art",
          scholarDescription:
            "You'll ink the lines that bring your comic's pictures into focus.",
        },
        {
          title: "Letter the speech bubbles",
          scholarDescription:
            "You'll add words to your speech bubbles so your characters can speak.",
        },
      ],
    );

    // Q2 — PARTIALLY DONE, no live session (1 of 3 done → "Continue").
    const q2 = await makeUnit(
      "Backyard Bug Safari",
      "🐛",
      `${scholar.name ?? "The scholar"}'s field study of the bugs in the backyard — observe, sketch, write it up.`,
      "Your field study of the bugs in your backyard — observe them, sketch your favourites, then write it up.",
      [
        {
          title: "Tally the bugs you can find",
          scholarDescription:
            "You'll look closely and keep a tally of the bugs you can find.",
        },
        {
          title: "Sketch your three favourites",
          scholarDescription:
            "You'll sketch three bugs that catch your attention.",
        },
        {
          title: "Write a field-note entry",
          scholarDescription:
            "You'll write a field note about one bug you observed.",
        },
      ],
    );
    await complete(q2.unitId, q2.lessonId, q2.activityIds[0]);

    // Q3 — ACTIVELY IN PROGRESS (1 of 3 done + a live session on activity 2).
    const q3 = await makeUnit(
      "Tide Pool Detective",
      "🦀",
      `${scholar.name ?? "The scholar"}'s investigation of who lives in the tide pools — map, identify, explain.`,
      "Your investigation of who lives in the tide pools — map the zones, identify the creatures, then explain how one survives.",
      [
        {
          title: "Map the zones of a tide pool",
          scholarDescription:
            "You'll map the different zones of a tide pool.",
        },
        {
          title: "Identify five creatures you find",
          scholarDescription:
            "You'll identify five tide-pool creatures and notice where each one lives.",
        },
        {
          title: "Explain how one survives the tides",
          scholarDescription:
            "You'll explain how one tide-pool creature survives the changing water.",
        },
      ],
    );
    await complete(q3.unitId, q3.lessonId, q3.activityIds[0]);
    const q3session = await ctx.db
      .query("sessions")
      .withIndex("by_user", (q) => q.eq("userId", sid))
      .filter((q) => q.eq(q.field("unitId"), q3.unitId))
      .first();
    if (!q3session) {
      await ctx.db.insert("sessions", {
        userId: sid,
        unitId: q3.unitId,
        lessonId: q3.lessonId,
        activityId: q3.activityIds[1],
        title: "Tide Pool Detective",
        isArchived: false,
        lastMessageAt: Date.now() - 40 * 60 * 1000,
        lastMessageRole: "assistant",
        lastMessagePreview:
          "Nice — a hermit crab! Was it up high near the splash zone, or down low in the water?",
      });
    }

    return {
      ok: true,
      states: ["not-started: Make a Mini Comic", "partial 1/3: Backyard Bug Safari", "in-progress 1/3 + session: Tide Pool Detective"],
    };
  },
});

// Archive the scholar's most-recent N non-archived sessions, so the native
// "Archived Sessions" view (and swipe-to-restore) has something to show.
// Idempotent-ish: re-running archives the next most-recent ones.
export const archiveSessionsForTesting = internalMutation({
  args: { scholarUsername: v.string(), count: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const scholar = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.scholarUsername))
      .first();
    if (!scholar) throw new Error(`Scholar not found: ${args.scholarUsername}`);
    const n = args.count ?? 1;
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user_and_archived", (q) =>
        q.eq("userId", scholar._id).eq("isArchived", false),
      )
      .collect();
    const toArchive = sessions
      .filter((s) => !s.isTestDrive && !s.isOffline)
      .sort((a, b) => b._creationTime - a._creationTime)
      .slice(0, n);
    for (const s of toArchive) await ctx.db.patch(s._id, { isArchived: true });
    return { archived: toArchive.map((s) => s.title) };
  },
});

// Seed a dedicated deliverable + rubric criteria for the native RubricBar
// ("Your goal"), with per-criterion verdicts spanning not / half / full.
export const seedDeliverableForTesting = internalMutation({
  args: { scholarUsername: v.string() },
  handler: async (ctx, args) => {
    const scholar = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.scholarUsername))
      .first();
    if (!scholar) throw new Error(`Scholar not found: ${args.scholarUsername}`);

    const title = "Rubric Bar Test — all verdict states";
    const criteria = [
      {
        id: "rubric-full-opening",
        label: "Zooms in on one small moment",
        description: "The writing stays with one candle-blowing instant instead of summarizing the whole party.",
      },
      {
        id: "rubric-half-senses",
        label: "Uses vivid sensory detail",
        description: "The draft includes at least one sound, smell, touch, or visual detail that helps the reader feel present.",
      },
      {
        id: "rubric-not-reflection",
        label: "Shows why the moment mattered",
        description: "The ending should reveal what changed, what was learned, or why this tiny moment is worth remembering.",
      },
      {
        id: "rubric-full-sequence",
        label: "Keeps the sequence easy to follow",
        description: "The reader can track what happened first, next, and last without getting lost.",
      },
    ];

    const unit = await ctx.db
      .query("units")
      .withIndex("by_teacher", (q) => q.eq("teacherId", scholar._id))
      .filter((q) => q.eq(q.field("title"), title))
      .first();
    const unitId =
      unit?._id ??
      (await ctx.db.insert("units", {
        teacherId: scholar._id,
        title,
        emoji: "⭐",
        isActive: true,
        authorScholarId: scholar._id,
      }));

    const lessonTitle = "Goal bar inspection";
    const lesson = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", unitId))
      .filter((q) => q.eq(q.field("title"), lessonTitle))
      .first();
    const lessonId =
      lesson?._id ??
      (await ctx.db.insert("lessons", {
        unitId,
        title: lessonTitle,
        order: 0,
      }));

    const deliverableSpec = {
      kind: "text" as const,
      prompt:
        "Write a tiny memoir scene about blowing out birthday candles. Keep it focused on one small moment.",
      mode: "manual" as const,
      criteria,
    };
    const activity = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (q) => q.eq("lessonId", lessonId))
      .filter((q) => q.eq(q.field("title"), title))
      .first();
    const activityId =
      activity?._id ??
      (await ctx.db.insert("activities", {
        lessonId,
        title,
        kind: "online" as const,
        systemPrompt:
          "Help the scholar revise a tiny memoir scene. Use the rubric verdicts for feedback, but do not give away full rewrites.",
        scholarDescription:
          "You'll revise a tiny memoir scene and use your goal bar to guide your next draft.",
        order: 0,
        deliverable: deliverableSpec,
      }));
    if (activity) {
      await ctx.db.patch(activity._id, {
        kind: "online" as const,
        systemPrompt:
          "Help the scholar revise a tiny memoir scene. Use the rubric verdicts for feedback, but do not give away full rewrites.",
        scholarDescription:
          "You'll revise a tiny memoir scene and use your goal bar to guide your next draft.",
        deliverable: deliverableSpec,
      });
    }

    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user_and_archived", (q) =>
        q.eq("userId", scholar._id).eq("isArchived", false),
      )
      .collect();
    const existingSession = sessions.find(
      (s) =>
        s.title === title &&
        s.activityId === activityId &&
        !s.isTestDrive &&
        !s.isOffline,
    );
    const sessionId =
      existingSession?._id ??
      (await ctx.db.insert("sessions", {
        userId: scholar._id,
        unitId,
        lessonId,
        activityId,
        title,
        isArchived: false,
        lastMessageAt: Date.now(),
        lastMessageRole: "assistant" as const,
        lastMessagePreview:
          "Your rubric has one full star, one half star, and one not-yet star ready to inspect.",
      }));
    await ctx.db.patch(sessionId, {
      unitId,
      lessonId,
      activityId,
      title,
      isArchived: false,
      deliverableCriteria: criteria,
      deliverableCriteriaStatus: "ready",
      deliverableCriteriaError: undefined,
    });

    const verdicts = [
      {
        criterionId: "rubric-full-opening",
        level: "full" as const,
        note: "You stayed tightly focused on the candle moment.",
      },
      {
        criterionId: "rubric-half-senses",
        level: "half" as const,
        note: "The smoke smell is strong; add one more sound or touch detail.",
      },
      {
        criterionId: "rubric-not-reflection",
        level: "not" as const,
        note: "The ending does not yet show why this moment mattered.",
      },
      {
        criterionId: "rubric-full-sequence",
        level: "full" as const,
        note: "The moment unfolds in a clear order.",
      },
    ];
    const existing = await ctx.db
      .query("deliverables")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();
    const row = existing.find((d) => d.activityId === activityId && !d.artifactId);
    if (row) {
      await ctx.db.patch(row._id, {
        scholarId: scholar._id,
        sessionId,
        activityId,
        submittedAt: Date.now(),
        textContent:
          "I blew out the candles and the smoke smelled like burnt sugar. Everyone clapped while the blue smoke curled up.",
        verdicts,
        rubricPassed: false,
        rubricFeedback:
          "Two stars are earned, one is partly there, and one still needs revision.",
        rubricCheckedAt: Date.now(),
        rubricCheckedBy: "ai",
        overall: "half" as const,
      });
    } else {
      await ctx.db.insert("deliverables", {
        activityId,
        scholarId: scholar._id,
        sessionId,
        submittedAt: Date.now(),
        textContent: "I blew out the candles and the smoke smelled like burnt sugar...",
        verdicts,
        rubricPassed: false,
        rubricFeedback:
          "Two stars are earned, one is partly there, and one still needs revision.",
        rubricCheckedAt: Date.now(),
        rubricCheckedBy: "ai",
        overall: "half" as const,
      });
    }
    return {
      ok: true,
      scholarUsername: args.scholarUsername,
      sessionId,
      activityId,
      sessionTitle: title,
      expected: {
        starsEarned: "2.5 of 4",
        full: ["Zooms in on one small moment", "Keeps the sequence easy to follow"],
        half: ["Uses vivid sensory detail"],
        not: ["Shows why the moment mattered"],
      },
    };
  },
});

// Stamp a durable-fluency transition on one skill so the Moments story reveal
// card (convex/practiceMoments.ts's storyMomentForScholar) has something real
// to serve without waiting for an actual multi-session fluency climb. Upserts
// a practiceMastery row for (scholar, skillKey) with `becameFluentAt = now`
// and `source: "practice"` (the demonstrated-fluency gate) — the same shape a
// real correct-answer streak would produce. Purely additive/idempotent (safe
// to re-run); dev-only manual QA tool, never called from the app.
export const stampMomentFluencyForTesting = internalMutation({
  args: {
    scholarUsername: v.string(),
    // Defaults to "lcm" (registered story: "The 221-year cicada reunion" →
    // cicada life cycles) since it's a small, self-contained skill with no
    // prerequisite chain to also fake.
    skillKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scholar = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.scholarUsername))
      .first();
    if (!scholar) throw new Error(`Scholar not found: ${args.scholarUsername}`);

    const skillKey = args.skillKey ?? "lcm";
    const node = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_nodeKey", (q) => q.eq("nodeKey", skillKey))
      .first();
    if (!node) throw new Error(`Unknown skill: ${skillKey}`);

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
      });
      return { updated: true, skillKey, scholarId: scholar._id };
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
    return { updated: false, skillKey, scholarId: scholar._id };
  },
});
