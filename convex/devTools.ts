/**
 * Dev-only mirror helper. One-off: imports a payload of users + units +
 * lessons + activities + projects (sourced from a prod read) into the
 * current deployment, remapping prod IDs to fresh dev IDs.
 *
 * This file is intentionally minimal and intended to be deleted after
 * the mirror is done. Internal mutation — only callable via `convex run`.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

type AnyDoc = Record<string, unknown>;

export const importMirror = internalMutation({
  args: {
    payload: v.any(),
  },
  handler: async (ctx, args) => {
    const payload = args.payload as {
      users: { prodUserId: string; username: string; name: string }[];
      units: AnyDoc[];
      lessons: AnyDoc[];
      activities: AnyDoc[];
      sessions: AnyDoc[];
    };

    const userMap = new Map<string, Id<"users">>();
    const unitMap = new Map<string, Id<"units">>();
    const lessonMap = new Map<string, Id<"lessons">>();
    const activityMap = new Map<string, Id<"activities">>();

    // ── Users ────────────────────────────────────────────────────────
    for (const u of payload.users) {
      // Skip if a dev user with this username already exists.
      const existing = await ctx.db
        .query("users")
        .filter((q) => q.eq(q.field("username"), u.username))
        .unique();
      if (existing) {
        userMap.set(u.prodUserId, existing._id);
        continue;
      }
      const id = await ctx.db.insert("users", {
        username: u.username,
        name: u.name,
        role: "scholar",
        profileSetupComplete: true,
      });
      userMap.set(u.prodUserId, id);
    }

    // Pick the first dev teacher to own mirrored units (units require teacherId).
    const teacher = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("role"), "teacher"))
      .first();
    if (!teacher) throw new Error("No teacher in dev — can't assign units.");

    // ── Units ────────────────────────────────────────────────────────
    for (const u of payload.units) {
      const id = await ctx.db.insert("units", {
        teacherId: teacher._id,
        title: String(u.title ?? "Mirrored unit"),
        emoji: typeof u.emoji === "string" ? u.emoji : undefined,
        description:
          typeof u.description === "string" ? u.description : undefined,
        isActive: u.isActive === false ? false : true,
        subject: typeof u.subject === "string" ? u.subject : undefined,
      });
      unitMap.set(String(u._id), id);
    }

    // ── Lessons ──────────────────────────────────────────────────────
    for (const l of payload.lessons) {
      const newUnitId = unitMap.get(String(l.unitId));
      if (!newUnitId) continue;
      const id = await ctx.db.insert("lessons", {
        unitId: newUnitId,
        title: String(l.title ?? "Mirrored lesson"),
        order: typeof l.order === "number" ? l.order : 0,
      });
      lessonMap.set(String(l._id), id);
    }

    // ── Activities ───────────────────────────────────────────────────
    for (const a of payload.activities) {
      const newLessonId = a.lessonId
        ? lessonMap.get(String(a.lessonId))
        : undefined;
      const kind = (a.kind === "online" || a.kind === "offline" || a.kind === "shareBack")
        ? a.kind
        : "online";
      const id = await ctx.db.insert("activities", {
        lessonId: newLessonId,
        title: String(a.title ?? "Mirrored activity"),
        kind,
        order: typeof a.order === "number" ? a.order : 0,
      });
      activityMap.set(String(a._id), id);
    }

    // ── Projects ─────────────────────────────────────────────────────
    let sessionCount = 0;
    for (const p of payload.sessions) {
      const newUserId = userMap.get(String(p.userId));
      if (!newUserId) continue;
      const newUnitId = p.unitId ? unitMap.get(String(p.unitId)) : undefined;
      const newLessonId = p.lessonId ? lessonMap.get(String(p.lessonId)) : undefined;
      const newActivityId = p.activityId ? activityMap.get(String(p.activityId)) : undefined;
      await ctx.db.insert("sessions", {
        userId: newUserId,
        unitId: newUnitId,
        lessonId: newLessonId,
        activityId: newActivityId,
        title: String(p.title ?? "Mirrored project"),
        isArchived: p.isArchived === true,
        analysisSummary:
          typeof p.analysisSummary === "string" ? p.analysisSummary : undefined,
        pulseScore: typeof p.pulseScore === "number" ? p.pulseScore : undefined,
      });
      sessionCount++;
    }

    return {
      users: userMap.size,
      units: unitMap.size,
      lessons: lessonMap.size,
      activities: activityMap.size,
      sessions: sessionCount,
    };
  },
});

/**
 * Dev-only: seed a homework + class-focus assignment so we can validate
 * the ScholarPlate's classFocus/homework sections. Idempotent: rewrites
 * the schedule on an existing (teacher, unit, scholar) match.
 */
export const seedTestAssignment = internalMutation({
  args: {
    teacherId: v.id("users"),
    scholarId: v.id("users"),
    unitId: v.id("units"),
    classFocusActivityId: v.id("activities"),
    homeworkActivityId: v.id("activities"),
    // Override the homework due date (ms). Lets a dev seed PAST-due homework
    // to exercise the scholar "Catch up" / teacher "was due X" treatments.
    homeworkDueAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const schedule = [
      {
        activityId: args.classFocusActivityId,
        mode: "classFocus" as const,
        setAt: now,
      },
      {
        activityId: args.homeworkActivityId,
        mode: "homework" as const,
        setAt: now,
        dueAt: args.homeworkDueAt ?? now + 7 * 86_400_000,
      },
    ];
    const existing = await ctx.db
      .query("assignments")
      .withIndex("by_teacher", (q) => q.eq("teacherId", args.teacherId))
      .collect();
    const match = existing.find(
      (a) =>
        a.unitId === args.unitId &&
        a.scholarIds.length === 1 &&
        a.scholarIds[0] === args.scholarId,
    );
    if (match) {
      await ctx.db.patch(match._id, { activitySchedule: schedule });
      return { id: match._id, mode: "updated" as const };
    }
    const id = await ctx.db.insert("assignments", {
      teacherId: args.teacherId,
      unitId: args.unitId,
      scholarIds: [args.scholarId],
      startedAt: now,
      activitySchedule: schedule,
    });
    return { id, mode: "created" as const };
  },
});

/**
 * Dev-only: stamp a project so it shows up in the scholar's plate under
 * a specific assignment + activity. We use this to demo classFocus +
 * homework rows on a scholar who has an existing anchorless project.
 */
export const stampSessionAssignment = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    assignmentId: v.id("assignments"),
    activityId: v.id("activities"),
  },
  handler: async (ctx, args) => {
    const activity = await ctx.db.get(args.activityId);
    const lesson = activity?.lessonId
      ? await ctx.db.get(activity.lessonId)
      : null;
    await ctx.db.patch(args.sessionId, {
      assignmentId: args.assignmentId,
      activityId: args.activityId,
      lessonId: activity?.lessonId,
      unitId: lesson?.unitId,
    });
  },
});

/**
 * Dev-only: seed a complete Web Assignment fixture — "Math Block" unit
 * → "Daily practice" lesson → a kind="web" external-practice activity —
 * and push it live (classFocus) to the named scholar. Idempotent by
 * title.
 *
 *   npx convex run devTools:seedWebAssignmentForTesting \
 *     '{"teacherUsername":"test-teacher-001","scholarUsername":"test-scholar-001"}'
 */
export const seedWebAssignmentForTesting = internalMutation({
  args: {
    teacherUsername: v.string(),
    scholarUsername: v.string(),
  },
  handler: async (ctx, args) => {
    const byUsername = async (username: string) => {
      const u = await ctx.db
        .query("users")
        .withIndex("by_username", (q) => q.eq("username", username))
        .first();
      if (!u) throw new Error(`No user with username "${username}"`);
      return u;
    };
    const teacher = await byUsername(args.teacherUsername);
    const scholar = await byUsername(args.scholarUsername);

    const UNIT_TITLE = "Math Block";
    const unit = (await ctx.db.query("units").collect()).find(
      (u) => u.title === UNIT_TITLE && u.teacherId === teacher._id,
    );
    let unitId = unit?._id;
    if (!unitId) {
      unitId = await ctx.db.insert("units", {
        teacherId: teacher._id,
        title: UNIT_TITLE,
        emoji: "🧮",
        isActive: true,
      });
    }
    const lesson = (
      await ctx.db
        .query("lessons")
        .withIndex("by_unit", (q) => q.eq("unitId", unitId))
        .collect()
    ).find((l) => l.title === "Daily practice");
    let lessonId = lesson?._id;
    if (!lessonId) {
      lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Daily practice",
        order: 0,
      });
    }
    const activity = (
      await ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", lessonId))
        .collect()
    ).find((a) => a.kind === "web");
    let activityId = activity?._id;
    if (!activityId) {
      activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Practice Site",
        description: "Do whatever the practice site gives you next.",
        kind: "web",
        webUrl: "https://www.example.com/learn",
        webAllowedHosts: ["example.com"],
        defaultMode: "classFocus",
        order: 0,
      });
    }

    // Push live to this scholar (reuse seedTestAssignment's matching).
    const now = Date.now();
    const schedule = [
      { activityId, mode: "classFocus" as const, setAt: now },
    ];
    const existing = await ctx.db
      .query("assignments")
      .withIndex("by_teacher", (q) => q.eq("teacherId", teacher._id))
      .collect();
    const match = existing.find(
      (a) =>
        a.unitId === unitId &&
        a.scholarIds.length === 1 &&
        a.scholarIds[0] === scholar._id,
    );
    let assignmentId = match?._id;
    if (assignmentId) {
      await ctx.db.patch(assignmentId, { activitySchedule: schedule });
    } else {
      assignmentId = await ctx.db.insert("assignments", {
        teacherId: teacher._id,
        unitId,
        scholarIds: [scholar._id],
        startedAt: now,
        activitySchedule: schedule,
      });
    }
    return { unitId, lessonId, activityId, assignmentId };
  },
});

/**
 * Dev-only: dump a scholar's web sessions WITH resolved screenshot
 * URLs — CLI-friendly verification for the E2E run.
 *
 *   npx convex run devTools:dumpWebSessions '{"scholarUsername":"test-scholar-001"}'
 */
export const dumpWebSessions = internalQuery({
  args: { scholarUsername: v.string() },
  handler: async (ctx, args) => {
    const scholar = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.scholarUsername))
      .first();
    if (!scholar) throw new Error("scholar not found");
    const sessions = await ctx.db
      .query("webActivitySessions")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholar._id))
      .collect();
    return Promise.all(
      sessions.map(async (s) => ({
        _id: s._id,
        startedAt: s.startedAt,
        endedAt: s.endedAt ?? null,
        lastHeartbeatAt: s.lastHeartbeatAt ?? null,
        lastUrl: s.lastUrl ?? null,
        offDomainBlocks: s.offDomainBlocks ?? 0,
        extracted: s.extracted ?? null,
        extractedSource: s.extractedSource ?? null,
        summary: s.summary ?? null,
        screenshotUrls: (
          await Promise.all(s.screenshotIds.map((id) => ctx.storage.getUrl(id)))
        ).filter(Boolean),
      })),
    );
  },
});

/**
 * Dev-only: inject realistic captured metadata onto a scholar's most-recent
 * web session, so the summary pass + teacher card can be exercised without a
 * live iPad completing real external-practice-site tasks. Mirrors what
 * recordProgress writes. Pair with `webActivitySummary:summarize` to test
 * the Haiku recap end-to-end.
 *
 *   npx convex run devTools:setWebSessionExtracted '{"scholarUsername":"test-scholar-001","extracted":{...}}'
 */
export const setWebSessionExtracted = internalMutation({
  args: {
    scholarUsername: v.string(),
    extracted: v.object({
      xpToday: v.optional(v.number()),
      xpGoal: v.optional(v.number()),
      courseName: v.optional(v.string()),
      percentComplete: v.optional(v.number()),
      tasksCompletedToday: v.optional(v.number()),
      taskSummaries: v.optional(v.array(v.string())),
    }),
    extractedSource: v.optional(v.union(v.literal("api"), v.literal("dom"))),
  },
  handler: async (ctx, args) => {
    const scholar = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.scholarUsername))
      .first();
    if (!scholar) throw new Error("scholar not found");
    const latest = await ctx.db
      .query("webActivitySessions")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholar._id))
      .order("desc")
      .first();
    if (!latest) throw new Error("no web session to patch");
    await ctx.db.patch(latest._id, {
      extracted: args.extracted,
      extractedSource: args.extractedSource ?? "api",
      summary: undefined,
    });
    return { sessionId: latest._id };
  },
});
