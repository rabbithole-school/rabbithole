import { convexTest } from "convex-test";
import { isScheduleRow } from "../lib/pushes";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  readSchedule,
  writeSchedule,
} from "../lib/scheduleStore";
import { applyScheduleActivity } from "../assignments";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// The schedule store (Linear TRA-13): every give, reschedule, clear, job,
// roster change and archive writes `pushes` rows, the only copy.

const HOUR = 60 * 60 * 1000;

// convexTest's return type is only schema-aware when the schema is
// carried through; the bare ReturnType erases it and `withIndex` stops
// resolving the real indexes.
type Harness = ReturnType<typeof convexTest<typeof schema.tables>>;

async function withUser(t: Harness, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + HOUR,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedClassroom(t: Harness) {
  await t.mutation(internal.institutions.ensureDefaults, {});
  const schoolId = await t.query(
    internal.institutions.primaryInstitutionIdQuery,
    {},
  );
  if (!schoolId) throw new Error("ensureDefaults created no primary school");

  const teacherId = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Teacher",
      username: "t_mirror",
      role: "teacher",
      institutionId: schoolId,
    }),
  );
  await t.run(async (ctx) =>
    ctx.db.insert("memberships", {
      userId: teacherId,
      role: "teacher",
      institutionId: schoolId,
    }),
  );

  const scholarIds: Id<"users">[] = [];
  for (const username of ["s_one", "s_two"]) {
    scholarIds.push(
      await t.run(async (ctx) =>
        ctx.db.insert("users", {
          name: username,
          username,
          role: "scholar",
          institutionId: schoolId,
        }),
      ),
    );
  }

  const { unitId, activityId, otherActivityId } = await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      title: "Tide pools",
      teacherId,
      institutionId: schoolId,
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Zonation",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Field notes",
      order: 0,
      kind: "offline",
      // Offline homework is refused without something a scholar can read.
      scholarDescription: "Write what you notice in the high tide zone.",
    });
    const otherActivityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Sketch a limpet",
      order: 1,
      kind: "offline",
      scholarDescription: "Sketch one limpet and label its foot.",
    });
    return { unitId, lessonId, activityId, otherActivityId };
  });

  const assignmentId = await t.run(async (ctx) =>
    ctx.db.insert("assignments", {
      teacherId,
      unitId,
      scholarIds,
      startedAt: Date.now(),
    }),
  );

  return {
    institutionId: schoolId,
    teacherId,
    scholarIds,
    unitId,
    activityId,
    otherActivityId,
    assignmentId,
  };
}

/** The schedule as every reader and writer sees it (from `pushes`). */
async function scheduleOf(t: Harness, assignmentId: Id<"assignments">) {
  return t.run(async (ctx) => readSchedule(ctx, { _id: assignmentId }));
}

async function scheduleRows(t: Harness, assignmentId: Id<"assignments">) {
  const rows = await t.run(async (ctx) =>
    (
      await ctx.db
        .query("pushes")
        .withIndex("by_assignment", (q) => q.eq("assignmentId", assignmentId))
        .collect()
    ).filter(isScheduleRow),
  );
  // TRA-580 step 5: the store keeps `timing` as the kind alone.
  for (const row of rows) expect(Object.keys(row.timing)).toEqual(["kind"]);
  return rows;
}

// Every test here runs on a pinned school-day midday (noon HST). These tests
// schedule work relative to "now", and on a real clock any window that crosses
// Hawaii midnight changes the outcome, so they failed every evening.
// A test that needs another time sets it itself.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T22:00:00.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the schedule store (pushes only)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("every mode is stored as kind-only timing with its end in endsAt/afterEnd", async () => {
    // Mid-day in Honolulu, so the untimed focus's end of day is hours away whenever the suite runs.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T22:00:00.000Z"));
    const t = convexTest(schema, modules);
    const c = await seedClassroom(t);
    const now = Date.now();
    await t.run((ctx) => writeSchedule(ctx, c.assignmentId, [
      { activityId: c.activityId, mode: "classFocus", setAt: now, endsAt: now + HOUR },
      { activityId: c.activityId, mode: "homework", setAt: now, dueAt: now + 24 * HOUR },
    ]));
    let rows = await scheduleRows(t, c.assignmentId);
    const focusId = rows.find((r) => r.blocking)!._id;
    const homeworkId = rows.find((r) => !r.blocking)!._id;
    expect(rows.find((r) => r.blocking)).toMatchObject({
      timing: { kind: "focus" }, endsAt: now + HOUR, afterEnd: "fade",
    });
    expect(rows.find((r) => !r.blocking)).toMatchObject({
      timing: { kind: "homework" }, endsAt: now + 24 * HOUR, afterEnd: "late",
    });

    // Same rows, new mode within each key: the timed focus becomes untimed and
    // the homework loses its date. Kind + end changes are detected and the
    // end fields recomputed, not left at the old numbers.
    await t.run((ctx) => writeSchedule(ctx, c.assignmentId, [
      { activityId: c.activityId, mode: "classFocus", setAt: now },
      { activityId: c.activityId, mode: "homework", setAt: now },
    ]));
    rows = await scheduleRows(t, c.assignmentId);
    const untimed = rows.find((r) => r._id === focusId)!;
    const undated = rows.find((r) => r._id === homeworkId)!;
    expect(untimed).toMatchObject({ timing: { kind: "untilCleared" }, afterEnd: "fade" });
    // Its stored end is the close of its school day, never the old window.
    expect(untimed.endsAt).toBeGreaterThan(now + HOUR);
    expect(undated).toMatchObject({ timing: { kind: "homework" }, afterEnd: "late" });
    expect(undated.endsAt).toBeUndefined();
    const schedule = await scheduleOf(t, c.assignmentId);
    expect(schedule.find((e) => e.mode === "classFocus")?.endsAt).toBeUndefined();
    expect(schedule.find((e) => e.mode === "homework")?.dueAt).toBeUndefined();

    // And back to a timed focus at a new end.
    await t.run((ctx) => writeSchedule(ctx, c.assignmentId, [
      { activityId: c.activityId, mode: "classFocus", setAt: now, endsAt: now + 2 * HOUR },
    ]));
    rows = await scheduleRows(t, c.assignmentId);
    expect(rows.find((r) => r._id === focusId)).toMatchObject({
      timing: { kind: "focus" }, endsAt: now + 2 * HOUR, afterEnd: "fade",
    });
  });

  test("a planned give is stored as a row with its activation job", async () => {
    const t = convexTest(schema, modules);
    const c = await seedClassroom(t);
    const asTeacher = await withUser(t, c.teacherId);
    const startsAt = Date.now() + HOUR;

    await asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: c.assignmentId,
      activityId: c.activityId,
      mode: "classFocus",
      startsAt,
      endsAt: startsAt + HOUR,
    });

    const [entry] = await scheduleOf(t, c.assignmentId);
    expect(entry).toMatchObject({
      activityId: c.activityId,
      mode: "classFocus",
      startsAt,
      endsAt: startsAt + HOUR,
    });
    expect(entry.setAt).toBeUndefined();
    // The job lives on the row, so reschedule and clear can cancel it.
    expect(entry.scheduledFnId).toBeDefined();
  });

  test("reschedule moves the row and replaces its job; clear closes it, never deletes", async () => {
    const t = convexTest(schema, modules);
    const c = await seedClassroom(t);
    const asTeacher = await withUser(t, c.teacherId);

    await asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: c.assignmentId,
      activityId: c.activityId,
      mode: "homework",
      startsAt: Date.now() + HOUR,
      dueAt: Date.now() + 48 * HOUR,
    });
    const before = (await scheduleOf(t, c.assignmentId))[0];
    await asTeacher.mutation(api.assignments.rescheduleActivity, {
      assignmentId: c.assignmentId,
      activityId: c.activityId,
      startsAt: Date.now() + 5 * HOUR,
    });
    const after = (await scheduleOf(t, c.assignmentId))[0];
    expect(after.startsAt).toBeGreaterThan(before.startsAt!);
    expect(after.scheduledFnId).toBeDefined();
    expect(after.scheduledFnId).not.toBe(before.scheduledFnId);
    const oldJob = await t.run(async (ctx) =>
      ctx.db.system.get(before.scheduledFnId!),
    );
    expect(oldJob?.state.kind).toBe("canceled");

    await asTeacher.mutation(api.assignments.clearActivity, {
      assignmentId: c.assignmentId,
      activityId: c.activityId,
    });
    expect(await scheduleOf(t, c.assignmentId)).toEqual([]);
    const rows = await scheduleRows(t, c.assignmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].clearedAt).toBeTypeOf("number");
    expect(rows[0].clearedReason).toBe("teacher");
    const newJob = await t.run(async (ctx) =>
      ctx.db.system.get(after.scheduledFnId!),
    );
    expect(newJob?.state.kind).toBe("canceled");
  });

  test("a planned focus goes live on its job and closes as expired at its end", async () => {
    vi.useFakeTimers();
    // Pin a school-day midday: an unpinned clock let these fail whenever
    // "now + 1h" fell late enough in the Hawaii evening to cross midnight.
    vi.setSystemTime(new Date("2026-11-09T22:00:00.000Z"));
    const t = convexTest(schema, modules);
    const c = await seedClassroom(t);
    const asTeacher = await withUser(t, c.teacherId);
    const startsAt = Date.now() + HOUR;

    await asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: c.assignmentId,
      activityId: c.activityId,
      mode: "classFocus",
      startsAt,
      endsAt: startsAt + HOUR,
    });

    vi.advanceTimersByTime(HOUR + 1000);
    await t.finishInProgressScheduledFunctions();
    const [live] = await scheduleOf(t, c.assignmentId);
    expect(live.setAt).toBeTypeOf("number");
    // Live now: the row holds its auto-clear job instead of the activation.
    expect(live.scheduledFnId).toBeDefined();
    const autoClear = await t.run(async (ctx) =>
      ctx.db.system.get(live.scheduledFnId!),
    );
    expect(autoClear?.name).toContain("autoClearActivity");

    vi.advanceTimersByTime(HOUR + 1000);
    await t.finishInProgressScheduledFunctions();
    expect(await scheduleOf(t, c.assignmentId)).toEqual([]);
    const rows = await scheduleRows(t, c.assignmentId);
    expect(rows.map((r) => r.clearedReason)).toEqual(["expired"]);
  });

  test("a roster change narrows targeted entries and drops one left with nobody", async () => {
    const t = convexTest(schema, modules);
    const c = await seedClassroom(t);
    const asTeacher = await withUser(t, c.teacherId);

    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: c.assignmentId,
      activityId: c.activityId,
      mode: "classFocus",
      endsAt: Date.now() + HOUR,
      scholarIds: [c.scholarIds[0]],
    });
    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: c.assignmentId,
      activityId: c.otherActivityId,
      mode: "homework",
      dueAt: Date.now() + 24 * HOUR,
    });

    await asTeacher.mutation(api.assignments.setScholars, {
      assignmentId: c.assignmentId,
      scholarIds: [c.scholarIds[1]],
    });

    const schedule = await scheduleOf(t, c.assignmentId);
    // The targeted focus had only scholar 0: dropped, never widened.
    expect(schedule.map((e) => e.activityId)).toEqual([c.otherActivityId]);
    expect(schedule[0].scholarIds).toBeUndefined();
  });

  test("archiving empties the schedule and cancels pending jobs", async () => {
    const t = convexTest(schema, modules);
    const c = await seedClassroom(t);
    const asTeacher = await withUser(t, c.teacherId);
    await asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: c.assignmentId,
      activityId: c.activityId,
      mode: "homework",
      startsAt: Date.now() + HOUR,
      dueAt: Date.now() + 24 * HOUR,
    });
    const [planned] = await scheduleOf(t, c.assignmentId);

    await asTeacher.mutation(api.assignments.archive, {
      assignmentId: c.assignmentId,
    });

    expect(await scheduleOf(t, c.assignmentId)).toEqual([]);
    const job = await t.run(async (ctx) =>
      ctx.db.system.get(planned.scheduledFnId!),
    );
    expect(job?.state.kind).toBe("canceled");
  });

  test("the aide's clear_activity pushId path can't close a schedule row", async () => {
    const t = convexTest(schema, modules);
    const c = await seedClassroom(t);
    const asTeacher = await withUser(t, c.teacherId);
    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: c.assignmentId,
      activityId: c.activityId,
      mode: "classFocus",
      endsAt: Date.now() + HOUR,
    });
    const [row] = await scheduleRows(t, c.assignmentId);
    const res = await t.mutation(internal.pushes.clearFocusFromAide, {
      callerUserId: c.teacherId,
      pushId: row._id,
    });
    expect(res.ok).toBe(false);
    expect(await scheduleOf(t, c.assignmentId)).toHaveLength(1);
  });

  test("a live focus stores its auto-clear job; clear, archive and a new end cancel it", async () => {
    // Pin a school-day midday so "now + 1h" never crosses Hawaii midnight.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T22:00:00.000Z"));
    const t = convexTest(schema, modules);
    const c = await seedClassroom(t);
    const asTeacher = await withUser(t, c.teacherId);
    const jobState = (id: Id<"_scheduled_functions">) =>
      t.run(async (ctx) => (await ctx.db.system.get(id))?.state.kind);

    // Push now: the auto-clear id is on the row; clear cancels it.
    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: c.assignmentId,
      activityId: c.activityId,
      mode: "classFocus",
      endsAt: Date.now() + HOUR,
    });
    const [pushed] = await scheduleOf(t, c.assignmentId);
    expect(pushed.scheduledFnId).toBeDefined();
    await asTeacher.mutation(api.assignments.clearActivity, {
      assignmentId: c.assignmentId,
      activityId: c.activityId,
    });
    expect(await jobState(pushed.scheduledFnId!)).toBe("canceled");

    // A new end replaces the job; the same end keeps it.
    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: c.assignmentId,
      activityId: c.activityId,
      mode: "classFocus",
      endsAt: Date.now() + HOUR,
    });
    const [again] = await scheduleOf(t, c.assignmentId);
    await t.run(async (ctx) => {
      const a = (await ctx.db.get(c.assignmentId))!;
      await applyScheduleActivity(ctx, a, {
        activityId: c.activityId,
        mode: "classFocus",
        startsAt: again.startsAt!,
        endsAt: again.endsAt,
      });
    });
    const [same] = await scheduleOf(t, c.assignmentId);
    expect(same.scheduledFnId).toBe(again.scheduledFnId);
    expect(await jobState(again.scheduledFnId!)).toBe("pending");
    await t.run(async (ctx) => {
      const a = (await ctx.db.get(c.assignmentId))!;
      await applyScheduleActivity(ctx, a, {
        activityId: c.activityId,
        mode: "classFocus",
        startsAt: again.startsAt!,
        endsAt: again.endsAt! + HOUR,
      });
    });
    const [moved] = await scheduleOf(t, c.assignmentId);
    expect(moved.scheduledFnId).toBeDefined();
    expect(moved.scheduledFnId).not.toBe(again.scheduledFnId);
    expect(await jobState(again.scheduledFnId!)).toBe("canceled");

    // Moving a live focus's agenda position keeps its auto-clear.
    await asTeacher.mutation(api.assignments.rescheduleActivity, {
      assignmentId: c.assignmentId,
      activityId: c.activityId,
      startsAt: Date.now() + 5 * HOUR,
    });
    const [rescheduled] = await scheduleOf(t, c.assignmentId);
    expect(rescheduled.scheduledFnId).toBe(moved.scheduledFnId);
    expect(await jobState(moved.scheduledFnId!)).toBe("pending");

    // Archive cancels it.
    await asTeacher.mutation(api.assignments.archive, {
      assignmentId: c.assignmentId,
    });
    expect(await jobState(moved.scheduledFnId!)).toBe("canceled");
  });

  test("the Run page query still answers activitySchedule for a long-lived tab (until 2026-12-01)", async () => {
    const t = convexTest(schema, modules);
    const c = await seedClassroom(t);
    const asTeacher = await withUser(t, c.teacherId);
    await asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: c.assignmentId,
      activityId: c.activityId,
      mode: "homework",
      startsAt: Date.now() + HOUR,
      dueAt: Date.now() + 48 * HOUR,
    });
    const run = (await asTeacher.query(api.assignments.get, {
      assignmentId: c.assignmentId,
    })) as unknown as { schedule: unknown[]; activitySchedule: unknown[] };
    expect(run.schedule).toHaveLength(1);
    expect(run.activitySchedule).toEqual(run.schedule);
  });

  test("entries read back most recently activated first, then planned by soonest start, undated planned last", async () => {
    vi.useFakeTimers();
    // Pin a school-day midday: an unpinned clock let these fail whenever
    // "now + 1h" fell late enough in the Hawaii evening to cross midnight.
    vi.setSystemTime(new Date("2026-11-09T22:00:00.000Z"));
    const t = convexTest(schema, modules);
    const c = await seedClassroom(t);
    const third = await t.run(async (ctx) =>
      ctx.db.insert("activities", {
        lessonId: (await ctx.db.get(c.activityId))!.lessonId,
        title: "Tide chart",
        order: 2,
        kind: "offline",
        scholarDescription: "Read the tide chart.",
      }),
    );
    const now = Date.now();
    // Written in this order: an undated planned entry first, then a live one
    // given an hour ago, then one planned for two hours from now, then a
    // classFocus of the first activity that went live 30 minutes ago.
    await t.run(async (ctx) => {
      await writeSchedule(ctx, c.assignmentId, [
        { activityId: third, mode: "homework" },
      ]);
    });
    vi.advanceTimersByTime(1000);
    await t.run(async (ctx) => {
      const current = await readSchedule(ctx, { _id: c.assignmentId });
      await writeSchedule(ctx, c.assignmentId, [
        ...current,
        { activityId: c.otherActivityId, mode: "homework", setAt: now - HOUR },
        { activityId: c.activityId, mode: "homework", startsAt: now + 2 * HOUR },
        { activityId: c.activityId, mode: "classFocus", setAt: now - HOUR / 2 },
      ]);
    });
    const schedule = await scheduleOf(t, c.assignmentId);
    expect(schedule.map((e) => [e.activityId, e.mode])).toEqual([
      [c.activityId, "classFocus"], // live 30 minutes ago: the newest give
      [c.otherActivityId, "homework"], // live an hour ago
      [c.activityId, "homework"], // planned for two hours from now
      [third, "homework"], // planned, no start: last
    ]);
    vi.useRealTimers();
  });

  test("live entries activated together keep creation order, whatever their planned starts", async () => {
    vi.useFakeTimers();
    // Pin a school-day midday: an unpinned clock let these fail whenever
    // "now + 1h" fell late enough in the Hawaii evening to cross midnight.
    vi.setSystemTime(new Date("2026-11-09T22:00:00.000Z"));
    const t = convexTest(schema, modules);
    const c = await seedClassroom(t);
    const at = Date.now() - HOUR;
    // The older row was planned LATER: creation order must still win.
    await t.run(async (ctx) => {
      await writeSchedule(ctx, c.assignmentId, [
        { activityId: c.activityId, mode: "homework", setAt: at, startsAt: at + 5 * HOUR },
      ]);
    });
    vi.advanceTimersByTime(1000);
    await t.run(async (ctx) => {
      const current = await readSchedule(ctx, { _id: c.assignmentId });
      await writeSchedule(ctx, c.assignmentId, [
        ...current,
        { activityId: c.otherActivityId, mode: "homework", setAt: at, startsAt: at },
      ]);
    });
    const first = await scheduleOf(t, c.assignmentId);
    expect(first.map((e) => e.activityId)).toEqual([c.activityId, c.otherActivityId]);
    expect(await scheduleOf(t, c.assignmentId)).toEqual(first);
    vi.useRealTimers();
  });

  test("the Run page outline shows the deciding entry: a newer homework beats an older live focus", async () => {
    const t = convexTest(schema, modules);
    const c = await seedClassroom(t);
    const now = Date.now();
    const dueAt = now + 48 * HOUR;
    await t.run(async (ctx) => {
      await writeSchedule(ctx, c.assignmentId, [
        { activityId: c.activityId, mode: "classFocus", setAt: now - 2 * HOUR, endsAt: now + HOUR },
        { activityId: c.activityId, mode: "homework", setAt: now - HOUR, dueAt },
      ]);
    });
    const asTeacher = await withUser(t, c.teacherId);
    const progress = await asTeacher.query(api.assignments.activityProgress, {
      assignmentId: c.assignmentId,
    });
    const row = progress!.lessons
      .flatMap((l: { activities: Array<{ activityId: string; schedule: unknown }> }) => l.activities)
      .find((a: { activityId: string }) => a.activityId === c.activityId) as {
      schedule: { mode: string; dueAt: number | null } | null;
    };
    expect(row.schedule?.mode).toBe("homework");
    expect(row.schedule?.dueAt).toBe(dueAt);
  });

  test("an assignment with no resolvable school refuses the write rather than losing it", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarIds, activityId, assignmentId } =
      await seedClassroom(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(teacherId, { institutionId: undefined });
      for (const id of scholarIds) {
        await ctx.db.patch(id, { institutionId: undefined });
      }
      for (const m of await ctx.db.query("memberships").collect()) {
        await ctx.db.delete(m._id);
      }
      for (const i of await ctx.db.query("institutions").collect()) {
        await ctx.db.patch(i._id, { isPrimary: false });
      }
    });
    await expect(
      t.run(async (ctx) =>
        writeSchedule(ctx, assignmentId, [
          { activityId, mode: "classFocus", setAt: Date.now() },
        ]),
      ),
    ).rejects.toThrow(/belongs to no school/);
    expect(await scheduleOf(t, assignmentId)).toEqual([]);
  });
});

describe("an auto-clear acts only on the live occurrence it was armed for", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A live focus as the pre-switch code left it: the row with no job id,
   *  and an untracked auto-clear queued at its end. */
  async function legacyLiveFocus(
    t: Harness,
    c: Awaited<ReturnType<typeof seedClassroom>>,
    endsAt: number,
  ) {
    const now = Date.now();
    return t.run(async (ctx) => {
      await writeSchedule(ctx, c.assignmentId, [
        { activityId: c.activityId, mode: "classFocus", setAt: now, startsAt: now, endsAt },
      ]);
      return ctx.scheduler.runAt(endsAt, internal.assignments.autoClearActivity, {
        assignmentId: c.assignmentId,
        activityId: c.activityId,
      });
    });
  }

  const pendingAutoClears = (t: Harness) =>
    t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (f) => f.name.includes("autoClearActivity") && f.state.kind === "pending",
      ),
    );

  test("a legacy clear that finds a newer PLANNED entry does nothing, so shelving it still cancels the activation", async () => {
    vi.useFakeTimers();
    // Pin a school-day midday: an unpinned clock let these fail whenever
    // "now + 1h" fell late enough in the Hawaii evening to cross midnight.
    vi.setSystemTime(new Date("2026-11-09T22:00:00.000Z"));
    const t = convexTest(schema, modules);
    const c = await seedClassroom(t);
    const asTeacher = await withUser(t, c.teacherId);
    const start = Date.now();

    // 1. Pre-switch: a live focus with an untracked auto-clear at +1h.
    await legacyLiveFocus(t, c, start + HOUR);
    // 2. After the switch: clear it, then plan the same activity for later.
    await asTeacher.mutation(api.assignments.clearActivity, {
      assignmentId: c.assignmentId,
      activityId: c.activityId,
    });
    await asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: c.assignmentId,
      activityId: c.activityId,
      mode: "classFocus",
      startsAt: start + 3 * HOUR,
      endsAt: start + 4 * HOUR,
    });
    const [planned] = await scheduleOf(t, c.assignmentId);
    const activation = planned.scheduledFnId!;
    expect(activation).toBeDefined();

    // 3. The old clear fires before that block: it must not touch the plan.
    vi.advanceTimersByTime(HOUR + 1000);
    await t.finishInProgressScheduledFunctions();
    const [still] = await scheduleOf(t, c.assignmentId);
    expect(still.setAt).toBeUndefined();
    expect(still.scheduledFnId).toBe(activation);
    expect(await pendingAutoClears(t)).toHaveLength(0);

    // 4. Shelve it: the activation is cancelled, not orphaned.
    await asTeacher.mutation(api.assignments.clearActivity, {
      assignmentId: c.assignmentId,
      activityId: c.activityId,
    });
    const job = await t.run(async (ctx) => ctx.db.system.get(activation));
    expect(job?.state.kind).toBe("canceled");

    // 5. Nothing goes live at the block.
    vi.advanceTimersByTime(3 * HOUR);
    await t.finishInProgressScheduledFunctions();
    expect(await scheduleOf(t, c.assignmentId)).toEqual([]);
  });

  test("re-timing a legacy live focus leaves one clear, and the row keeps its cancel handle", async () => {
    vi.useFakeTimers();
    // Pin a school-day midday: an unpinned clock let these fail whenever
    // "now + 1h" fell late enough in the Hawaii evening to cross midnight.
    vi.setSystemTime(new Date("2026-11-09T22:00:00.000Z"));
    const t = convexTest(schema, modules);
    const c = await seedClassroom(t);
    const start = Date.now();
    await legacyLiveFocus(t, c, start + HOUR);

    // After the switch: the focus is re-timed to end an hour later.
    await t.run(async (ctx) => {
      const a = (await ctx.db.get(c.assignmentId))!;
      const [live] = await readSchedule(ctx, a);
      await applyScheduleActivity(ctx, a, {
        activityId: c.activityId,
        mode: "classFocus",
        startsAt: live.startsAt!,
        endsAt: start + 2 * HOUR,
      });
    });
    const [retimed] = await scheduleOf(t, c.assignmentId);
    const tracked = retimed.scheduledFnId!;
    expect(tracked).toBeDefined();

    // The legacy clear fires at the old end: no second clear, handle intact.
    vi.advanceTimersByTime(HOUR + 1000);
    await t.finishInProgressScheduledFunctions();
    const pending = await pendingAutoClears(t);
    expect(pending.map((f) => f._id)).toEqual([tracked]);
    const [afterLegacy] = await scheduleOf(t, c.assignmentId);
    expect(afterLegacy.scheduledFnId).toBe(tracked);
    expect(afterLegacy.setAt).toBe(retimed.setAt);

    // The tracked clear ends it at the new end.
    vi.advanceTimersByTime(HOUR);
    await t.finishInProgressScheduledFunctions();
    expect(await scheduleOf(t, c.assignmentId)).toEqual([]);
    expect(await pendingAutoClears(t)).toHaveLength(0);
  });

  test("a clear armed for one live occurrence never clears a newer one", async () => {
    vi.useFakeTimers();
    // Pin a school-day midday: an unpinned clock let these fail whenever
    // "now + 1h" fell late enough in the Hawaii evening to cross midnight.
    vi.setSystemTime(new Date("2026-11-09T22:00:00.000Z"));
    const t = convexTest(schema, modules);
    const c = await seedClassroom(t);
    const asTeacher = await withUser(t, c.teacherId);
    const start = Date.now();
    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: c.assignmentId,
      activityId: c.activityId,
      mode: "classFocus",
      endsAt: start + HOUR,
    });
    const [first] = await scheduleOf(t, c.assignmentId);
    // A clear armed for the first occurrence that somehow survived.
    await t.run(async (ctx) =>
      ctx.scheduler.runAt(start + HOUR, internal.assignments.autoClearActivity, {
        assignmentId: c.assignmentId,
        activityId: c.activityId,
        armedSetAt: first.setAt,
      }),
    );
    // A new occurrence of the same activity, live later with a later end.
    vi.advanceTimersByTime(10 * 60_000);
    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: c.assignmentId,
      activityId: c.activityId,
      mode: "classFocus",
      endsAt: start + 3 * HOUR,
    });
    const [second] = await scheduleOf(t, c.assignmentId);
    expect(second.setAt).not.toBe(first.setAt);

    vi.advanceTimersByTime(HOUR);
    await t.finishInProgressScheduledFunctions();
    const [stillLive] = await scheduleOf(t, c.assignmentId);
    expect(stillLive.setAt).toBe(second.setAt);
    expect(stillLive.scheduledFnId).toBe(second.scheduledFnId);
  });
});

describe("what is a schedule row (TRA-575)", () => {
  test("new schedule rows carry the scheduleMirror flag that marks a schedule row", async () => {
    const t = convexTest(schema, modules);
    const c = await seedClassroom(t);
    await t.run(async (ctx) => {
      await writeSchedule(ctx, c.assignmentId, [
        { activityId: c.activityId, mode: "homework", setAt: Date.now() },
      ]);
    });
    const rows = await scheduleRows(t, c.assignmentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].scheduleMirror).toBe(true);
    expect((await scheduleOf(t, c.assignmentId)).map((e) => e.activityId)).toEqual([
      c.activityId,
    ]);
  });

  test("an unflagged ad hoc push filed under an assignment (an old makeFocus) is never a schedule row", async () => {
    const t = convexTest(schema, modules);
    const c = await seedClassroom(t);
    const pushId = await t.run(async (ctx) =>
      ctx.db.insert("pushes", {
        institutionId: c.institutionId,
        target: { kind: "activity", activityId: c.activityId },
        audience: { kind: "institution" },
        timing: { kind: "focus" }, endsAt: Date.now() + HOUR, afterEnd: "fade",
        blocking: false,
        setAt: Date.now(),
        assignmentId: c.assignmentId,
        pushedBy: c.teacherId,
      }),
    );
    const push = await t.run(async (ctx) => ctx.db.get(pushId));
    expect(isScheduleRow(push!)).toBe(false);
    expect(await scheduleOf(t, c.assignmentId)).toEqual([]);
  });

  test("makeFocus never files a push under an assignment, so it never joins a schedule", async () => {
    const t = convexTest(schema, modules);
    const c = await seedClassroom(t);
    const teacher = await withUser(t, c.teacherId);
    const pushId = await teacher.mutation(api.pushes.makeFocus, {
      target: { kind: "activity", activityId: c.activityId },
      assignmentId: c.assignmentId,
      durationMin: 20,
    });
    const push = await t.run(async (ctx) => ctx.db.get(pushId));
    expect(push?.assignmentId).toBeUndefined();
    expect(await scheduleOf(t, c.assignmentId)).toEqual([]);
  });
});
