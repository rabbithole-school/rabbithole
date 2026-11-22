import { convexTest, type TestConvex } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { makeAssignmentTools } from "../lib/assignmentTools";
import { readSchedule } from "../lib/scheduleStore";
import { schoolDayEndAt } from "../lib/schoolDays";
import { yourListRowsForTab } from "../../shared/scholarHomeNow";
import { buildYourList, homeworkRowCta, opensOfflinePage } from "../../shared/homeworkList";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

/**
 * Offline work given "Open until a date" (TRA-739). It is stored as class
 * focus that ends on a later day (shared/openUntil.ts), and offline class
 * focus is hidden from scholars because the teacher runs it in the room. So
 * an offline open-until give used to reach no one. It now reaches its
 * scholars the way offline homework does: a row under "Open from class" that
 * opens the read-only page, which they can mark done. "In that class" offline
 * work stays hidden, and giving an empty offline activity open-until is
 * refused like giving it as homework.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const TIME_ZONE = "Pacific/Honolulu";
const hst = (dayKey: string, hhmm: string) =>
  Date.parse(`${dayKey}T${hhmm}:00.000-10:00`);
// Tuesday 2026-11-10, 9:30 in Honolulu.
const TUESDAY_930AM = hst("2026-11-10", "09:30");
const SATURDAY = "2026-11-14";
const OPEN_UNTIL_SATURDAY = { kind: "openUntil" as const, dayKey: SATURDAY };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(TUESDAY_930AM);
});

afterEach(() => {
  vi.useRealTimers();
});

type T = TestConvex<typeof schema>;

async function withUser(t: T, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 3_600_000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

/** A school, a teacher, one scholar, a unit with an offline activity that
 *  has instructions, an empty offline one, and an assignment for the scholar. */
async function seedWorld(t: T) {
  const institutionId = await seedTestInstitution(t);
  await t.run((ctx) => ctx.db.patch(institutionId, { timeZone: TIME_ZONE }));
  const teacher = await seedStaffWithMembership(t, {
    institutionId,
    name: "Leilani Teacher",
  });
  const scholar = await seedScholarInInstitution(t, {
    institutionId,
    name: "Kaimana Example",
  });
  const { unitId, readable, empty } = await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId: teacher,
      institutionId,
      title: "Tide Pools",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Observing",
      order: 0,
    });
    const readable = await ctx.db.insert("activities", {
      lessonId,
      title: "Sketch the tide line",
      kind: "offline",
      scholarDescription: "Sketch the tide line in your notebook.",
      order: 0,
    });
    const empty = await ctx.db.insert("activities", {
      lessonId,
      title: "Pool walk",
      kind: "offline",
      order: 1,
    });
    return { unitId, readable, empty };
  });
  const asTeacher = await withUser(t, teacher);
  const assignmentId = await asTeacher.mutation(api.assignments.create, {
    unitId,
    scholarIds: [scholar],
  });
  return { teacher, scholar, readable, empty, assignmentId, asTeacher };
}

function actionCtxFor(t: T): ActionCtx {
  return {
    runQuery: (ref: unknown, args: unknown) =>
      (t as unknown as { query: (r: unknown, a: unknown) => Promise<unknown> }).query(ref, args),
    runMutation: (ref: unknown, args: unknown) =>
      (t as unknown as { mutation: (r: unknown, a: unknown) => Promise<unknown> }).mutation(ref, args),
  } as unknown as ActionCtx;
}

describe("offline work given open until a date", () => {
  test("shows under Open from class with the offline Open button, never late", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await w.asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId,
      activityId: w.readable,
      finish: OPEN_UNTIL_SATURDAY,
    });
    const asScholar = await withUser(t, w.scholar);
    const plate = await asScholar.query(api.scholarPlate.activeForMe, {});
    const row = plate.rows.find((r) => r.activityId === w.readable)!;
    expect(row).toMatchObject({
      origin: "classFocus",
      activityKind: "offline",
      openUntil: schoolDayEndAt(SATURDAY, TIME_ZONE),
      dueAt: null,
      sessionId: null,
      description: "Sketch the tide line in your notebook.",
    });

    const now = Date.now();
    const list = buildYourList(yourListRowsForTab(plate.rows, "now", now), {
      nowMs: now,
      timeZone: TIME_ZONE,
    });
    expect(list.homework.isEmpty).toBe(true);
    const section = list.openFromClass.sections[0]!;
    expect(section.items.map((r) => r.activityId)).toEqual([w.readable]);
    expect(opensOfflinePage(row)).toBe(true);
    expect(
      homeworkRowCta(row, { isOffline: opensOfflinePage(row), forecast: false, nowMs: now }),
    ).toBe("Open");

    // The teacher's "In that class" list never headlines it.
    const focus = await asScholar.query(api.assignments.currentClassFocusForMe, {});
    expect(focus.map((f) => f.activityId)).not.toContain(w.readable);
  });

  test("offline work given in that class stays hidden", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await w.asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId,
      activityId: w.readable,
      finish: { kind: "inClass" },
    });
    const asScholar = await withUser(t, w.scholar);
    const plate = await asScholar.query(api.scholarPlate.activeForMe, {});
    expect(plate.rows.find((r) => r.activityId === w.readable)).toBeUndefined();
  });

  test("planned open-until work is not shown until it goes live", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await w.asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId,
      activityId: w.readable,
      startsAt: hst("2026-11-11", "09:00"),
      finish: OPEN_UNTIL_SATURDAY,
    });
    const asScholar = await withUser(t, w.scholar);
    const plate = await asScholar.query(api.scholarPlate.activeForMe, {});
    expect(plate.rows.find((r) => r.activityId === w.readable)).toBeUndefined();
  });

  test("opens the read-only page, can be marked done, and is gone after it closes", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await w.asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId,
      activityId: w.readable,
      finish: OPEN_UNTIL_SATURDAY,
    });
    const asScholar = await withUser(t, w.scholar);
    const opened = await asScholar.mutation(api.sessions.openOfflineHomework, {
      activityId: w.readable,
      assignmentId: w.assignmentId,
    });
    const session = await t.run((ctx) => ctx.db.get(opened.id));
    expect(session).toMatchObject({ isOffline: true, assignmentId: w.assignmentId });

    // Opening leaves it on the list, still unstarted, and counts nothing on
    // the teacher's Run page (its 0/N counts completions).
    const progress = async () =>
      (await w.asTeacher.query(api.assignments.activityProgress, {
        assignmentId: w.assignmentId,
      })) as unknown;
    expect(JSON.stringify(await progress())).not.toContain(String(w.scholar));
    const afterOpen = await asScholar.query(api.scholarPlate.activeForMe, {});
    expect(afterOpen.rows.find((r) => r.activityId === w.readable)).toBeDefined();

    // The offline page offers "I did it", with no due date (never late).
    const view = await asScholar.query(api.portfolio.offlineSessionView, {
      sessionId: opened.id,
    });
    expect(view).toMatchObject({ canMarkDone: true, isHomework: false, dueAt: null });

    const marked = await asScholar.mutation(
      api.activityCompletions.markHomeworkDoneForSelf,
      { assignmentId: w.assignmentId, activityId: w.readable },
    );
    expect(marked.ok).toBe(true);
    const afterMark = await asScholar.query(api.scholarPlate.activeForMe, {});
    expect(afterMark.rows.find((r) => r.activityId === w.readable)).toBeUndefined();
    expect(JSON.stringify(await progress())).toContain(String(w.scholar));

    // Unfinished again: after Saturday the give is gone and won't reopen.
    await t.run(async (ctx) => {
      const done = await ctx.db
        .query("activityCompletions")
        .withIndex("by_scholar", (q) => q.eq("scholarId", w.scholar))
        .collect();
      for (const row of done) await ctx.db.delete(row._id);
    });
    vi.setSystemTime(hst("2026-11-15", "09:00"));
    const after = await asScholar.query(api.scholarPlate.activeForMe, {});
    expect(after.rows.find((r) => r.activityId === w.readable)).toBeUndefined();
    await expect(
      asScholar.mutation(api.sessions.openOfflineHomework, {
        activityId: w.readable,
        assignmentId: w.assignmentId,
      }),
    ).rejects.toThrow(/not live/);
  });

  test("in-class offline work cannot be opened as a page", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await w.asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId,
      activityId: w.readable,
      finish: { kind: "inClass" },
    });
    const asScholar = await withUser(t, w.scholar);
    await expect(
      asScholar.mutation(api.sessions.openOfflineHomework, {
        activityId: w.readable,
        assignmentId: w.assignmentId,
      }),
    ).rejects.toThrow(/not live/);
  });

  test("the parent Homework tab lists it under Open from class", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await w.asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId,
      activityId: w.readable,
      finish: OPEN_UNTIL_SATURDAY,
    });
    const plan = await t.query(internal.parents.getChildHomeworkPlan, {
      scholarId: w.scholar,
    });
    expect(plan!.items).toEqual([
      expect.objectContaining({
        title: "Sketch the tide line",
        dueAt: null,
        openUntil: schoolDayEndAt(SATURDAY, TIME_ZONE),
        awayFromBunnyPad: true,
      }),
    ]);
  });
});

describe("giving an empty offline activity open until a date", () => {
  const SENTENCE = "Add instructions or materials first, then give it.";

  test("is refused with a sentence the teacher can read, and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const refusal = await w.asTeacher
      .mutation(api.assignments.pushActivity, {
        assignmentId: w.assignmentId,
        activityId: w.empty,
        finish: OPEN_UNTIL_SATURDAY,
      })
      .catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ConvexError);
    expect((refusal as ConvexError<string>).data).toBe(SENTENCE);

    const planned = await w.asTeacher
      .mutation(api.assignments.scheduleActivity, {
        assignmentId: w.assignmentId,
        activityId: w.empty,
        startsAt: hst("2026-11-11", "09:00"),
        finish: OPEN_UNTIL_SATURDAY,
      })
      .catch((e: unknown) => e);
    expect((planned as ConvexError<string>).data).toBe(SENTENCE);
  });

  test("as homework keeps its own sentence; in that class is allowed", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const homework = await w.asTeacher
      .mutation(api.assignments.pushActivity, {
        assignmentId: w.assignmentId,
        activityId: w.empty,
        finish: { kind: "by", dayKey: SATURDAY },
      })
      .catch((e: unknown) => e);
    expect((homework as ConvexError<string>).data).toBe(
      "Add instructions or materials first, then give it as homework.",
    );
    await w.asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId,
      activityId: w.empty,
      finish: { kind: "inClass" },
    });
  });

  test("re-planning closed open-until work in that class is judged as in-class", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await w.asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId: w.assignmentId,
      activityId: w.readable,
      finish: OPEN_UNTIL_SATURDAY,
    });
    // The instructions are gone and the window has closed.
    await t.run((ctx) => ctx.db.patch(w.readable, { scholarDescription: undefined }));
    vi.setSystemTime(hst("2026-11-15", "09:00"));
    await w.asTeacher.mutation(api.assignments.scheduleActivity, {
      assignmentId: w.assignmentId,
      activityId: w.readable,
      startsAt: hst("2026-11-16", "09:00"),
      finish: { kind: "inClass" },
    });
    const entry = await t.run(async (ctx) =>
      (await readSchedule(ctx, { _id: w.assignmentId })).find(
        (e) => e.activityId === w.readable,
      ),
    );
    expect(entry?.mode).toBe("classFocus");
    expect(entry?.setAt).toBeUndefined();
  });

  test("the aide's give tool reports the same refusal", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const tools = await makeAssignmentTools(actionCtxFor(t), () => {}, {
      role: "teacher",
      callerUserId: w.teacher,
    });
    const give = tools.find((tool) => tool.name === "give") as unknown as {
      run: (input: unknown) => Promise<string>;
    };
    const result = await give.run({
      unitTitle: "Tide Pools",
      activityTitle: "Pool walk",
      scholarNames: ["Kaimana Example"],
      startsNow: true,
      finish: `openUntil:${SATURDAY}`,
    });
    expect(result).toContain(SENTENCE);
  });
});
