import { convexTest } from "convex-test";
import { insertAssignmentWithSchedule } from "./scheduleFixtures";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { grantInstitutionMembership, seedTestInstitution } from "./institutionTestHelpers";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { readSchedule, writeSchedule } from "../lib/scheduleStore";
import { applyPushActivity } from "../assignments";
import { makeAssignmentTools } from "../lib/assignmentTools";

/**
 * "Give more time": pushing an activity to some scholars on an EXISTING
 * assignment, added to whoever already has it live. An activity is one
 * schedule entry per assignment, so the failure this guards is a
 * one-scholar push replacing a live cohort entry and pulling the work off
 * everyone else's screen.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const HOUR = 3_600_000;
type Entry = Awaited<ReturnType<typeof readSchedule>>[number];

function actionCtxFor(t: ReturnType<typeof convexTest>): ActionCtx {
  return {
    runQuery: (ref: unknown, args: unknown) =>
      (t as unknown as { query: (r: unknown, a: unknown) => Promise<unknown> }).query(ref, args),
    runMutation: (ref: unknown, args: unknown) =>
      (t as unknown as { mutation: (r: unknown, a: unknown) => Promise<unknown> }).mutation(ref, args),
  } as unknown as ActionCtx;
}

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: string,
  name: string,
) {
  const institutionId = await seedTestInstitution(t);
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name, username: `${name}-${Math.random()}`, role, institutionId }),
  );
  if (role === "teacher") await grantInstitutionMembership(t, userId, institutionId, role);
  return userId;
}

async function seedWorld(t: ReturnType<typeof convexTest>) {
  const teacher = await seedUser(t, "teacher", "Teacher Example");
  const a = await seedUser(t, "scholar", "Avery Example");
  const b = await seedUser(t, "scholar", "Blake Example");
  const c = await seedUser(t, "scholar", "Casey Example");
  const institutionId = await seedTestInstitution(t);
  const { unitId, activityId } = await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId: teacher,
      institutionId,
      title: "Civilizations",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", { unitId, title: "Lesson", order: 0 });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Historical Figures",
      kind: "online",
      systemPrompt: "...",
      order: 0,
    });
    return { unitId, activityId };
  });
  // The cohort assignment, with nothing on its schedule yet.
  const assignmentId = await t.run((ctx) =>
    insertAssignmentWithSchedule(ctx, {
      teacherId: teacher,
      unitId,
      scholarIds: [a, b, c],
      startedAt: Date.now(),
      activitySchedule: [],
    }),
  );
  return { teacher, a, b, c, activityId, assignmentId };
}

async function setEntry(
  t: ReturnType<typeof convexTest>,
  assignmentId: Id<"assignments">,
  entry: Entry,
) {
  await t.run(async (ctx) => {
    const a = await ctx.db.get(assignmentId);
    await writeSchedule(ctx, a!, [entry]);
  });
}

async function entryOf(
  t: ReturnType<typeof convexTest>,
  assignmentId: Id<"assignments">,
) {
  const schedule = await t.run((ctx) => readSchedule(ctx, { _id: assignmentId }));
  expect(schedule).toHaveLength(1);
  return schedule[0];
}

async function pushMoreTime(
  t: ReturnType<typeof convexTest>,
  w: Awaited<ReturnType<typeof seedWorld>>,
  scholarIds: Id<"users">[],
) {
  await t.mutation(internal.assignments.aidePushActivityNow, {
    callerUserId: w.teacher,
    assignmentId: w.assignmentId,
    activityId: w.activityId,
    mode: "homework",
    dueAt: Date.now() + 24 * HOUR,
    scholarIds,
  });
}

describe("give more time (add to the live audience)", () => {
  test("a finished cohort push reopens for just the named scholar", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    // Amber's case: a whole-cohort class focus from days ago, no longer showing.
    await setEntry(t, w.assignmentId, {
      activityId: w.activityId,
      mode: "classFocus",
      setAt: Date.now() - 48 * HOUR,
      startsAt: Date.now() - 48 * HOUR,
    });

    await pushMoreTime(t, w, [w.a]);

    const entry = await entryOf(t, w.assignmentId);
    expect(entry.mode).toBe("homework");
    expect(entry.setAt).toBeGreaterThan(Date.now() - HOUR);
    expect(entry.scholarIds).toEqual([w.a]);
  });

  test("a second scholar is added, never swapped in", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await pushMoreTime(t, w, [w.a]);
    await pushMoreTime(t, w, [w.b]);

    expect((await entryOf(t, w.assignmentId)).scholarIds).toEqual([w.a, w.b]);

    // Adding the last scholar covers the roster, which collapses to everyone.
    await pushMoreTime(t, w, [w.c]);
    expect((await entryOf(t, w.assignmentId)).scholarIds).toBeUndefined();
  });

  test("refuses when it is already live for the whole cohort, changing nothing", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const live: Entry = {
      activityId: w.activityId,
      mode: "homework",
      setAt: Date.now() - HOUR,
      startsAt: Date.now() - HOUR,
      dueAt: Date.now() + 48 * HOUR,
    };
    await setEntry(t, w.assignmentId, live);

    await expect(pushMoreTime(t, w, [w.a])).rejects.toThrow(
      /already live as homework for the whole cohort/,
    );
    expect(await entryOf(t, w.assignmentId)).toEqual(live);
  });

  test("refuses an off-roster scholar by name, even beside a rostered one", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const outsider = await seedUser(t, "scholar", "Drew Example");

    await expect(pushMoreTime(t, w, [w.a, outsider])).rejects.toThrow(
      /Not on this assignment's roster: Drew Example/,
    );
    const schedule = await t.run((ctx) =>
      readSchedule(ctx, { _id: w.assignmentId }),
    );
    expect(schedule).toHaveLength(0);
  });

  test("keeps a planned cohort push instead of cancelling it", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const planned: Entry = {
      activityId: w.activityId,
      mode: "classFocus",
      startsAt: Date.now() + 24 * HOUR,
    };
    await setEntry(t, w.assignmentId, planned);

    await expect(pushMoreTime(t, w, [w.a])).rejects.toThrow(/would cancel that plan/);
    expect(await entryOf(t, w.assignmentId)).toEqual(planned);
  });

  test("a whole-cohort focus set today is refused with the wrap-first remedy", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const focus: Entry = {
      activityId: w.activityId,
      mode: "classFocus",
      setAt: Date.now() - 60_000,
      startsAt: Date.now() - 60_000,
    };
    await setEntry(t, w.assignmentId, focus);

    await expect(pushMoreTime(t, w, [w.a])).rejects.toThrow(/wrap it first/);
    expect(await entryOf(t, w.assignmentId)).toEqual(focus);
  });

  test("never flips a live targeted entry's mode, either direction", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const focusForA: Entry = {
      activityId: w.activityId,
      mode: "classFocus",
      setAt: Date.now() - 60_000,
      startsAt: Date.now() - 60_000,
      endsAt: Date.now() + HOUR,
      scholarIds: [w.a],
    };
    await setEntry(t, w.assignmentId, focusForA);
    // Homework for B over A's live focus.
    await expect(pushMoreTime(t, w, [w.b])).rejects.toThrow(/live as in-class work/);
    // Read back with its finish, from the stored `focus` kind (TRA-726).
    expect(await entryOf(t, w.assignmentId)).toEqual({ ...focusForA, openUntilKind: false });

    // Class focus for B over A's live homework.
    const homeworkForA: Entry = {
      activityId: w.activityId,
      mode: "homework",
      setAt: Date.now() - HOUR,
      startsAt: Date.now() - HOUR,
      dueAt: Date.now() + 72 * HOUR,
      scholarIds: [w.a],
    };
    await setEntry(t, w.assignmentId, homeworkForA);
    await expect(
      t.mutation(internal.assignments.aidePushActivityNow, {
        callerUserId: w.teacher,
        assignmentId: w.assignmentId,
        activityId: w.activityId,
        mode: "classFocus",
        scholarIds: [w.b],
      }),
    ).rejects.toThrow(/live as homework/);
    expect(await entryOf(t, w.assignmentId)).toEqual(homeworkForA);
  });

  test("merging keeps the earlier scholar's later due date", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const friday = Date.now() + 96 * HOUR;
    await setEntry(t, w.assignmentId, {
      activityId: w.activityId,
      mode: "homework",
      setAt: Date.now() - HOUR,
      startsAt: Date.now() - HOUR,
      dueAt: friday,
      scholarIds: [w.a],
    });

    await pushMoreTime(t, w, [w.b]); // due tomorrow
    const entry = await entryOf(t, w.assignmentId);
    expect(entry.scholarIds).toEqual([w.a, w.b]);
    expect(entry.dueAt).toBe(friday);
  });

  test("a plain targeted push still replaces the audience", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await pushMoreTime(t, w, [w.a]);

    // The class-roster paths (masterSchedule) push a roster subset and rely on
    // replacement; only addToLiveAudience unions.
    await t.run(async (ctx) => {
      const doc = (await ctx.db.get(w.assignmentId))!;
      await applyPushActivity(ctx, doc, {
        activityId: w.activityId,
        mode: "homework",
        dueAt: Date.now() + 24 * HOUR,
        scholarIds: [w.b],
      });
    });
    expect((await entryOf(t, w.assignmentId)).scholarIds).toEqual([w.b]);
  });
});

describe("give on an existing assignment with scholarNames", () => {
  async function tools(t: ReturnType<typeof convexTest>, callerUserId: Id<"users">) {
    const list = await makeAssignmentTools(actionCtxFor(t), () => {}, {
      role: "teacher",
      callerUserId,
    });
    return Object.fromEntries(list.map((tool) => [tool.name, tool])) as Record<
      string,
      { run: (input: unknown) => Promise<string> }
    >;
  }

  test("targets the named scholar and reports who got it", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const res = JSON.parse(
      await (await tools(t, w.teacher)).give.run({
        assignmentId: w.assignmentId,
        activityId: w.activityId,
        startsNow: true,
        // Not live for anyone yet, so this is a new give: it needs a finish.
        finish: "2099-01-02",
        scholarNames: ["Avery Example"],
      }),
    ) as Record<string, unknown>;

    expect(res).toMatchObject({ ok: true, live: true, forScholars: ["Avery Example"] });
    expect((await entryOf(t, w.assignmentId)).scholarIds).toEqual([w.a]);
  });

  test("an unknown name pushes nothing", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const res = await (await tools(t, w.teacher)).give.run({
      assignmentId: w.assignmentId,
      activityId: w.activityId,
      startsNow: true,
      finish: "2099-01-02",
      scholarNames: ["Nobody Here"],
    });

    expect(res).toMatch(/Could not resolve/);
    const schedule = await t.run((ctx) =>
      readSchedule(ctx, { _id: w.assignmentId }),
    );
    expect(schedule).toHaveLength(0);
  });
});
