import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "../schema";
import type { ActionCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { Role } from "../lib/roles";
import { makeMasterScheduleTools } from "../lib/masterScheduleTools";
import { scheduleWeekStartMs } from "../../shared/scheduleWeek";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

/**
 * End-to-end exercise of the master-schedule aide tools: build the real tool
 * closures against a convex-test backend (routing the ActionCtx runQuery/
 * runMutation to the harness) and drive a whole schedule through them the way
 * the bot would — proving the tool → internal aide* → core wiring, the id
 * plumbing (string args cast to Convex ids), and the teacher gate. The name-
 * level ACL is covered separately in lib/__tests__/aideTools.test.ts.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const DAY = 86_400_000;

// A minimal ActionCtx that routes the only two methods the tools use to the
// harness. convex-test's top-level query/mutation accept internal refs.
function actionCtxFor(t: ReturnType<typeof convexTest>): ActionCtx {
  return {
    runQuery: (ref: unknown, args: unknown) =>
      (t as unknown as { query: (r: unknown, a: unknown) => Promise<unknown> }).query(ref, args),
    runMutation: (ref: unknown, args: unknown) =>
      (t as unknown as { mutation: (r: unknown, a: unknown) => Promise<unknown> }).mutation(ref, args),
  } as unknown as ActionCtx;
}

async function seedUser(t: ReturnType<typeof convexTest>, role = "teacher", name?: string) {
  const institutionId = await seedTestInstitution(t);
  const username = `u-${role}-${Math.random().toString(36).slice(2)}`;
  return role === "teacher"
    ? seedStaffWithMembership(t, { institutionId, name: name ?? `Test ${role}`, username })
    : seedScholarInInstitution(t, { institutionId, name: name ?? `Test ${role}`, username });
}

async function seedPeriod(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("reportingPeriods", {
      label: "Fall 2026",
      startsAt: Date.now(),
      endsAt: Date.now() + 90 * DAY,
      status: "open",
    }),
  );
}

async function seedGroup(t: ReturnType<typeof convexTest>, teacherId: Id<"users">, name = "Geckos") {
  return await t.run(async (ctx) =>
    ctx.db.insert("scholarGroups", { teacherId, name, emoji: "🦎", scholarIds: [] }),
  );
}

async function toolsFor(
  t: ReturnType<typeof convexTest>,
  callerUserId: Id<"users">,
  role: Role = "teacher",
  emit: Parameters<typeof makeMasterScheduleTools>[1] = () => {},
  allowedScholarIds?: Set<Id<"users">>,
  scholarLensResolved?: boolean,
) {
  const tools = await makeMasterScheduleTools(actionCtxFor(t), emit, {
    role,
    callerUserId,
    allowedScholarIds,
    scholarLensResolved,
  });
  return Object.fromEntries(tools.map((tl) => [tl.name, tl])) as Record<
    string,
    { run: (input: unknown) => Promise<string> }
  >;
}

const parse = (s: string) => JSON.parse(s) as Record<string, unknown>;

describe("master-schedule aide tools (end-to-end)", () => {
  test("a non-teacher gets NO master-schedule tools", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    const tools = await makeMasterScheduleTools(actionCtxFor(t), () => {}, {
      role: "scholar",
      callerUserId: scholar,
    });
    expect(tools).toHaveLength(0);
  });

  test("full bot flow: list term → build a block → place classes → read grid", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "Lehua");
    const periodId = await seedPeriod(t);
    const groupId = await seedGroup(t, teacher);
    const tools = await toolsFor(t, teacher);

    // 1. Find the term.
    const terms = parse(await tools.list_terms.run({}));
    expect((terms.terms as unknown[]).length).toBe(1);
    const termId = (terms.terms as { _id: string }[])[0]._id;
    expect(termId).toBe(periodId);

    // 2. Create a block.
    const blk = parse(await tools.create_schedule_block.run({
      termId, label: "Block A", startLocal: "08:30", endLocal: "09:40",
    }));
    expect(blk.ok).toBe(true);
    const blockId = blk.blockId as string;

    // 3. Place a class on it + one on the shelf.
    const placed = parse(await tools.place_class.run({
      termId, groupId, subject: "Math", teacherId: teacher, weekday: 1, blockId,
    }));
    expect(placed.ok).toBe(true);
    expect(placed.shelved).toBe(false);
    const shelved = parse(await tools.place_class.run({
      termId, groupId, subject: "Guest (some week)",
    }));
    expect(shelved.shelved).toBe(true);

    // 4. Read the grid back.
    const grid = parse(await tools.get_master_schedule.run({ termId }));
    expect((grid.blocks as unknown[]).length).toBe(1);
    expect((grid.placements as unknown[]).length).toBe(2);
    expect((grid.shelf as unknown[]).length).toBe(1);
    expect((grid.teachers as { name: string }[]).some((x) => x.name === "Lehua")).toBe(true);
    expect(grid.header).toMatchObject({
      today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      currentWeekStart: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
  });

  test("reassign_teacher covers an out-sick teacher's whole week in one call", async () => {
    const t = convexTest(schema, modules);
    const lehua = await seedUser(t, "teacher", "Lehua");
    const sub = await seedUser(t, "teacher", "Sub");
    const periodId = await seedPeriod(t);
    const groupId = await seedGroup(t, lehua);
    const tools = await toolsFor(t, lehua);

    const blk = parse(await tools.create_schedule_block.run({
      termId: periodId, label: "A", startLocal: "08:30", endLocal: "09:40",
    }));
    const blockId = blk.blockId as string;
    for (const weekday of [1, 2, 3]) {
      await tools.place_class.run({
        termId: periodId, groupId, subject: "Class", teacherId: lehua, weekday, blockId,
      });
    }

    // Missing substitute → guidance, no change.
    const guard = await tools.reassign_teacher.run({ termId: periodId, fromTeacherId: lehua });
    expect(guard).toMatch(/substitute|unassign/i);

    // Cover the whole week with the sub.
    const res = parse(await tools.reassign_teacher.run({
      termId: periodId, fromTeacherId: lehua, toTeacherId: sub,
    }));
    expect(res.count).toBe(3);

    const grid = parse(await tools.get_master_schedule.run({ termId: periodId }));
    for (const p of grid.placements as { teacherId: string }[]) {
      expect(p.teacherId).toBe(sub);
    }
  });

  test("shift_class teleports a placed class; refuses on a shelf item", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const periodId = await seedPeriod(t);
    const groupId = await seedGroup(t, teacher);
    const tools = await toolsFor(t, teacher);
    const blk = parse(await tools.create_schedule_block.run({
      termId: periodId, label: "A", startLocal: "08:00", endLocal: "09:00",
    }));
    const blockId = blk.blockId as string;
    const placed = parse(await tools.place_class.run({
      termId: periodId, groupId, subject: "Science", weekday: 3, blockId,
    }));
    const shifted = parse(await tools.shift_class.run({
      placementId: placed.placementId, deltaDays: 2,
    }));
    expect(shifted).toEqual({ ok: true, weekday: 5 }); // Wed → Fri

    const shelf = parse(await tools.place_class.run({
      termId: periodId, groupId, subject: "Shelved",
    }));
    const noShift = await tools.shift_class.run({
      placementId: shelf.placementId, deltaDays: 1,
    });
    expect(noShift).toMatch(/shelf/i);
  });

  test("move_class needs both coords or toShelf; moving a linked class onto a day auto-materializes it", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const periodId = await seedPeriod(t);
    const groupId = await seedGroup(t, teacher);
    const tools = await toolsFor(t, teacher);
    const blk = parse(await tools.create_schedule_block.run({
      termId: periodId, label: "A", startLocal: "08:30", endLocal: "09:40",
    }));
    const blockId = blk.blockId as string;

    // A linked assignment + activity.
    const { assignmentId, activityId } = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", { teacherId: teacher, title: "U", isActive: true });
      const lessonId = await ctx.db.insert("lessons", { unitId, title: "L", order: 0 });
      const actId = await ctx.db.insert("activities", {
        lessonId, title: "Act", kind: "online", systemPrompt: "...", order: 0,
      });
      const aId = await ctx.db.insert("assignments", {
        teacherId: teacher, unitId, scholarIds: [], startedAt: Date.now(), activitySchedule: [],
      });
      return { assignmentId: aId, activityId: actId };
    });

    // Shelf it first (no auto-materialize while shelved), then move onto a day.
    const p = parse(await tools.place_class.run({
      termId: periodId, groupId, subject: "Math",
      assignmentId, activityId, mode: "classFocus",
    }));
    const placementId = p.placementId as string;

    // Still shelved → nothing materialized yet.
    let a = await t.run(async (ctx) => ctx.db.get(assignmentId as Id<"assignments">));
    expect((a as Doc<"assignments">).activitySchedule).toHaveLength(0);

    const badMove = await tools.move_class.run({ placementId, weekday: 1 });
    expect(badMove).toMatch(/both weekday AND blockId|toShelf/i);

    await tools.move_class.run({ placementId, weekday: 1, blockId });

    // Moving onto a day auto-materializes the linked activity PLANNED (setAt null).
    a = await t.run(async (ctx) => ctx.db.get(assignmentId as Id<"assignments">));
    expect((a as Doc<"assignments">).activitySchedule).toHaveLength(1);
    expect((a as Doc<"assignments">).activitySchedule![0].activityId).toBe(activityId);
    expect((a as Doc<"assignments">).activitySchedule![0].setAt).toBeUndefined(); // planned

    // Shelving it again un-materializes the planned entry.
    await tools.move_class.run({ placementId, toShelf: true });
    a = await t.run(async (ctx) => ctx.db.get(assignmentId as Id<"assignments">));
    expect((a as Doc<"assignments">).activitySchedule).toHaveLength(0);
  });

  test("dispatch_activity gives one scholar a live ad-hoc activity", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", "Oliver");
    const tools = await toolsFor(t, teacher);

    const res = parse(await tools.dispatch_activity.run({
      scholarId: scholar,
      title: "Copenhagen taxation exploration",
      systemPrompt: "Guide the scholar Socratically through how cities fund themselves.",
    }));
    expect(res.ok).toBe(true);
    const assignmentId = res.assignmentId as Id<"assignments">;

    const a = await t.run(async (ctx) => ctx.db.get(assignmentId));
    expect((a as Doc<"assignments">).kind).toBe("adHocDispatch");
    expect((a as Doc<"assignments">).scholarIds).toEqual([scholar]);
    // Live-now → one materialized entry with a real setAt.
    expect((a as Doc<"assignments">).activitySchedule).toHaveLength(1);
    expect((a as Doc<"assignments">).activitySchedule![0].setAt).toBeTypeOf("number");

    // Queue variant: live:false → planned (setAt null).
    const queued = parse(await tools.dispatch_activity.run({
      scholarId: scholar, title: "Later reading", live: false, startsAt: Date.now() + DAY,
    }));
    const qa = await t.run(async (ctx) => ctx.db.get(queued.assignmentId as Id<"assignments">));
    expect((qa as Doc<"assignments">).activitySchedule![0].setAt).toBeUndefined();

    const dueAt = Date.now() + DAY;
    const instructions = "Read the passage twice.\n\nOn paper, sketch the pattern you notice.";
    const offline = parse(await tools.dispatch_activity.run({
      scholarId: scholar,
      title: "Pattern field notes",
      activityKind: "offline",
      description: instructions,
      mode: "homework",
      dueAt,
    }));
    expect(offline.ok).toBe(true);
    const offlineActivity = await t.run(async (ctx) =>
      ctx.db.get(offline.activityId as Id<"activities">),
    );
    expect(offlineActivity).toMatchObject({
      kind: "offline",
      // The dispatch `description` arg is scholar-facing instructions, so it
      // lands in the scholar-visible field.
      scholarDescription: instructions,
    });
    expect((offlineActivity as Doc<"activities">).systemPrompt).toBeUndefined();
    const offlineAssignment = await t.run(async (ctx) =>
      ctx.db.get(offline.assignmentId as Id<"assignments">),
    );
    expect((offlineAssignment as Doc<"assignments">).activitySchedule?.[0]).toMatchObject({
      mode: "homework",
      dueAt,
    });

    const completed = parse(await tools.mark_class_activity_done.run({
      assignmentId: offline.assignmentId,
      activityId: offline.activityId,
    }));
    expect(completed).toMatchObject({ ok: true, marked: 1, created: 1 });
    const completion = await t.run(async (ctx) =>
      ctx.db
        .query("activityCompletions")
        .withIndex("by_scholar_assignment", (q) =>
          q
            .eq("scholarId", scholar)
            .eq("assignmentId", offline.assignmentId as Id<"assignments">),
        )
        .first(),
    );
    expect(completion?.activityId).toBe(offline.activityId);
  });

  test("dispatch_activity resolves a scholar name and creates web or practice work", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", "Milo Kealoha");
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "angle_sum_triangle",
        label: "Use the 180-degree angle sum of a triangle",
        domain: "geometry-measurement",
        source: "practice",
      });
    });
    const tools = await toolsFor(t, teacher);

    const reading = parse(await tools.dispatch_activity.run({
      scholarName: "Milo Kealoha",
      title: "Triangle angle reading",
      activityKind: "web",
      webUrl: "https://example.com/triangle-angles",
    }));
    expect(reading.ok).toBe(true);
    expect(reading.scholarId).toBe(scholar);
    expect(reading.scholarName).toBe("Milo Kealoha");
    const readingActivity = await t.run(async (ctx) =>
      ctx.db.get(reading.activityId as Id<"activities">),
    );
    expect((readingActivity as Doc<"activities">).kind).toBe("web");

    const practice = parse(await tools.dispatch_activity.run({
      scholarName: "Milo",
      title: "Triangle angle tune-up",
      activityKind: "problem_set",
      targetSkillKeys: ["angle_sum_triangle"],
      itemCount: 6,
    }));
    const practiceActivity = await t.run(async (ctx) =>
      ctx.db.get(practice.activityId as Id<"activities">),
    );
    expect((practiceActivity as Doc<"activities">).problemSet).toEqual({
      domain: "geometry-measurement",
      targetSkillKeys: ["angle_sum_triangle"],
      itemCount: 6,
    });
  });

  test("dispatch_activity name matching cannot see scholars outside the institution lens", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const visible = await seedUser(t, "scholar", "Milo Kealoha");
    const hidden = await seedUser(t, "scholar", "Milo Kapono");
    const tools = await toolsFor(
      t,
      teacher,
      "teacher",
      () => {},
      new Set([visible]),
    );

    const visibleResult = parse(await tools.dispatch_activity.run({
      scholarName: "Milo",
      title: "Visible scholar work",
    }));
    expect(visibleResult.ok).toBe(true);
    expect(visibleResult.scholarId).toBe(visible);

    const hiddenResult = await tools.dispatch_activity.run({
      scholarName: "Milo Kapono",
      title: "Hidden scholar work",
    });
    expect(hiddenResult).toContain('No scholar matched "Milo Kapono"');
    expect(hiddenResult).not.toContain(String(hidden));
  });

  test("dispatch_activity preserves an explicitly resolved unrestricted admin lens", async () => {
    const t = convexTest(schema, modules);
    const admin = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Platform Admin",
        username: "platform-admin",
        role: "platform_admin",
      }),
    );
    const scholar = await seedUser(t, "scholar", "Milo Across Schools");
    const tools = await toolsFor(
      t,
      admin,
      "platform_admin",
      () => {},
      undefined,
      true,
    );

    const result = parse(await tools.dispatch_activity.run({
      scholarName: "Milo Across Schools",
      title: "Cross-school admin assignment",
    }));
    expect(result.ok).toBe(true);
    expect(result.scholarId).toBe(scholar);
  });

  test("cascade_unit lays a whole unit out, then move_sequence bulk-shifts it", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const periodId = await seedPeriod(t);
    const groupId = await seedGroup(t, teacher);
    const tools = await toolsFor(t, teacher);
    const blk = parse(await tools.create_schedule_block.run({
      termId: periodId, label: "A", startLocal: "08:30", endLocal: "09:40",
    }));
    const blockId = blk.blockId as string;

    // A unit with 3 activities + an assignment on it.
    const assignmentId = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", { teacherId: teacher, title: "U", isActive: true });
      const lessonId = await ctx.db.insert("lessons", { unitId, title: "L", order: 0 });
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert("activities", {
          lessonId, title: `Act ${i}`, kind: "online", systemPrompt: "...", order: i,
        });
      }
      return ctx.db.insert("assignments", {
        teacherId: teacher, unitId, scholarIds: [], startedAt: Date.now(), activitySchedule: [],
      });
    });

    const casc = parse(await tools.cascade_unit.run({
      termId: periodId, groupId, assignmentId,
      startWeekday: 1, startBlockId: blockId,
    }));
    expect((casc.placementIds as unknown[]).length).toBe(3);
    expect(casc.strategy).toBe("classMeetings");

    const grid1 = parse(await tools.get_master_schedule.run({ termId: periodId }));
    const placed = (grid1.placements as { sequenceId?: string; weekday: number }[])
      .filter((p) => p.sequenceId === casc.sequenceId);
    expect(placed).toHaveLength(3);
    // No class structure at the target → single weekly meeting: one per week at
    // the clicked slot (all weekday 1, different weeks).
    expect(placed.map((p) => p.weekday).sort()).toEqual([1, 1, 1]);

    // Bulk-shift the whole sequence one weekday later.
    const moved = parse(await tools.move_sequence.run({
      sequenceId: casc.sequenceId, deltaDays: 1,
    }));
    expect(moved.count).toBe(3);
    expect(moved.merged).toBe(0);
    const grid2 = parse(await tools.get_master_schedule.run({ termId: periodId }));
    const placed2 = (grid2.placements as { sequenceId?: string; weekday: number }[])
      .filter((p) => p.sequenceId === casc.sequenceId);
    expect(placed2.map((p) => p.weekday).sort()).toEqual([2, 2, 2]);

    // Guard: no delta → guidance.
    const guard = await tools.move_sequence.run({ sequenceId: casc.sequenceId });
    expect(guard).toMatch(/delta/i);
  });

  test("cascade_unit startDate anchors a future school-local week", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const periodId = await seedPeriod(t);
    const groupId = await seedGroup(t, teacher);
    const tools = await toolsFor(t, teacher);
    const blk = parse(await tools.create_schedule_block.run({
      termId: periodId, label: "A", startLocal: "08:30", endLocal: "09:40",
    }));
    const blockId = blk.blockId as string;
    const assignmentId = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId: teacher, title: "Future Unit", isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId, title: "L", order: 0,
      });
      for (let i = 0; i < 2; i++) {
        await ctx.db.insert("activities", {
          lessonId,
          title: `Act ${i}`,
          kind: "online",
          systemPrompt: "...",
          order: i,
        });
      }
      return ctx.db.insert("assignments", {
        teacherId: teacher,
        unitId,
        scholarIds: [],
        startedAt: Date.now(),
        activitySchedule: [],
      });
    });
    const startDate = "2032-06-16"; // Wednesday
    const requestedWeek = scheduleWeekStartMs(
      Date.parse(`${startDate}T12:00:00-10:00`),
    );

    const cascade = parse(await tools.cascade_unit.run({
      termId: periodId,
      groupId,
      assignmentId,
      startWeekday: 1,
      startDate,
      startBlockId: blockId,
      layout: "sameDay",
    }));
    const placements = await t.run((ctx) =>
      ctx.db
        .query("schedulePlacements")
        .withIndex("by_sequence", (q) =>
          q.eq("sequenceId", cascade.sequenceId as string),
        )
        .collect(),
    );
    expect(placements).toHaveLength(2);
    expect(placements.every((placement) =>
      placement.weekStartMs === requestedWeek)).toBe(true);
    expect(placements.every((placement) => placement.weekday === 3)).toBe(true);
  });

  test("caught tool errors emit toolComplete", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const periodId = await seedPeriod(t);
    const groupId = await seedGroup(t, teacher);
    const emit = vi.fn();
    const tools = await toolsFor(t, teacher, "teacher", emit);

    const result = await tools.place_class.run({
      termId: periodId,
      groupId,
      subject: "Broken",
      weekday: 1,
      blockId: "garbage-id",
    });

    expect(result).toMatch(/Could not place the class/i);
    expect(emit).toHaveBeenCalledWith({
      toolComplete: {
        name: "place_class",
        result: expect.stringMatching(/^⚠️ /),
      },
    });
  });

  test("accept_reorder silences a sequence's out-of-order flag", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const periodId = await seedPeriod(t);
    const groupId = await seedGroup(t, teacher);
    const tools = await toolsFor(t, teacher);
    const blk = parse(await tools.create_schedule_block.run({
      termId: periodId, label: "A", startLocal: "08:30", endLocal: "09:40",
    }));
    const blockId = blk.blockId as string;
    // A class meeting Mon/Tue/Wed in block A (recurring structure), so the
    // cascade lays the unit across weekdays within one week — then teleporting
    // activity 0 to Friday is a genuine reorder.
    let monSlot = "";
    const assignmentId = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", { teacherId: teacher, title: "U", isActive: true });
      const lessonId = await ctx.db.insert("lessons", { unitId, title: "L", order: 0 });
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert("activities", {
          lessonId, title: `Act ${i}`, kind: "online", systemPrompt: "...", order: i,
        });
      }
      for (const weekday of [1, 2, 3]) {
        const id = await ctx.db.insert("schedulePlacements", {
          periodId, groupId, subject: "Humanities", weekday,
          blockId: blockId as Id<"scheduleBlocks">,
        });
        if (weekday === 1) monSlot = id;
      }
      return ctx.db.insert("assignments", {
        teacherId: teacher, unitId, scholarIds: [], startedAt: Date.now(), activitySchedule: [],
      });
    });
    const casc = parse(await tools.cascade_unit.run({
      termId: periodId, groupId, assignmentId,
      startWeekday: 1, startBlockId: blockId, anchorPlacementId: monSlot,
    }));

    // Scramble: teleport the FIRST activity (weekday 1) to Friday → out of order.
    const grid1 = parse(await tools.get_master_schedule.run({ termId: periodId }));
    const first = (grid1.placements as { _id: string; sequenceId?: string; sequenceIndex?: number; weekday: number }[])
      .find((p) => p.sequenceId === casc.sequenceId && p.sequenceIndex === 0)!;
    await tools.shift_class.run({ placementId: first._id, deltaDays: 4 }); // Mon → Fri

    const grid2 = parse(await tools.get_master_schedule.run({ termId: periodId }));
    expect((grid2.outOfOrder as { sequenceId: string }[]).some((f) => f.sequenceId === casc.sequenceId)).toBe(true);

    // Accept it as intentional → flag gone.
    const acc = parse(await tools.accept_reorder.run({ sequenceId: casc.sequenceId }));
    expect(acc.ok).toBe(true);
    const grid3 = parse(await tools.get_master_schedule.run({ termId: periodId }));
    expect((grid3.outOfOrder as { sequenceId: string }[]).some((f) => f.sequenceId === casc.sequenceId)).toBe(false);
  });

  test("place_homework lands on the due rail (virtual homework block), or the shelf", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const periodId = await seedPeriod(t);
    const groupId = await seedGroup(t, teacher);
    const tools = await toolsFor(t, teacher);

    const due = parse(await tools.place_homework.run({
      termId: periodId, groupId, subject: "Fractions set", dueWeekday: 3,
    }));
    expect(due.ok).toBe(true);

    const grid = parse(await tools.get_master_schedule.run({ termId: periodId }));
    const hwBlock = (grid.blocks as { _id: string; kind?: string }[]).find((b) => b.kind === "homework");
    expect(hwBlock).toBeTruthy();
    const hwPlacement = (grid.placements as { blockId?: string; weekday?: number; mode?: string }[])
      .find((p) => p.blockId === hwBlock!._id);
    expect(hwPlacement?.weekday).toBe(3);
    expect(hwPlacement?.mode).toBe("homework");
    // Not flagged overloaded even if several land on the same day.
    await tools.place_homework.run({ termId: periodId, groupId, subject: "Reading log", dueWeekday: 3 });
    const grid2 = parse(await tools.get_master_schedule.run({ termId: periodId }));
    expect((grid2.overloaded as unknown[]).length).toBe(0);

    // Shelf variant (no dueWeekday).
    const shelved = parse(await tools.place_homework.run({
      termId: periodId, groupId, subject: "Someday HW",
    }));
    expect(shelved.ok).toBe(true);
    const grid3 = parse(await tools.get_master_schedule.run({ termId: periodId }));
    expect((grid3.shelf as { subject?: string }[]).some((s) => s.subject === "Someday HW")).toBe(true);
  });
});
