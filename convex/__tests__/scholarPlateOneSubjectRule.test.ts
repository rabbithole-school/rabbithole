import { convexTest } from "convex-test";
import { insertAssignmentWithSchedule, setSchedule, withDefaultSchools } from "./scheduleFixtures";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { loadScheduleRows } from "../lib/scheduleStore";
import { firstClassIdByWork } from "../lib/homeworkSubject";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin" = "scholar",
  overrides: Partial<Doc<"users">> = {},
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("users", {
      name: overrides.name ?? (role === "scholar" ? "Test Scholar" : `Test ${role}`),
      username:
        overrides.username ??
        (role === "scholar" ? "testscholar" : `test${role}`),
      role,
      readingLevel: overrides.readingLevel,
      image: overrides.image,
    });
  });
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedUnit(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  title: string,
  subject: string | undefined,
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title,
      ...(subject ? { subject } : {}),
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: `${title} lesson`,
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: `${title} activity`,
      kind: "online",
      systemPrompt: "You are testing this activity.",
      order: 0,
    });
    return { unitId, activityId };
  });
}

// TRA-721: the scholar's list labels a give with the same subject the family
// Homework tab and the teacher's planner do: the filed class, then the unit's
// subject, then the unit's title.
describe("scholarPlate.activeForMe: one subject rule", () => {
  test("a give filed under Science is labelled Science though its activity is placed in Math Workshop", async () => {
    const t = await withDefaultSchools(convexTest(schema, modules));
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const filed = await seedUnit(t, teacherId, "Ecosystems", "Interdisciplinary Science");
    const other = await seedUnit(t, teacherId, "Fractions", "Mathematics");
    const now = Date.now();

    await t.run(async (ctx) => {
      const assignmentId = await insertAssignmentWithSchedule(ctx, {
        teacherId,
        unitId: filed.unitId,
        scholarIds: [scholarId],
        startedAt: now,
        activitySchedule: [
          { activityId: filed.activityId, mode: "homework", setAt: now - 1_000 },
        ],
      });
      const otherAssignmentId = await insertAssignmentWithSchedule(ctx, {
        teacherId,
        unitId: other.unitId,
        scholarIds: [scholarId],
        startedAt: now,
        activitySchedule: [
          { activityId: other.activityId, mode: "homework", setAt: now - 1_000 },
        ],
      });
      const institution = (await ctx.db.query("institutions").first())!;
      const periodId = await ctx.db.insert("reportingPeriods", {
        label: "Current Term",
        startsAt: now - 86_400_000,
        endsAt: now + 86_400_000,
        status: "open",
      });
      const groupId = await ctx.db.insert("scholarGroups", {
        teacherId,
        name: "Geckos",
        scholarIds: [scholarId],
      });
      const scienceClassId = await ctx.db.insert("classes", {
        institutionId: institution._id,
        periodId,
        groupId,
        subject: "Science",
        subjectKey: "science",
        meetings: [],
      });
      // The give is filed under the Science class.
      for (const push of await ctx.db
        .query("pushes")
        .withIndex("by_assignment_cleared", (q) =>
          q.eq("assignmentId", assignmentId).eq("clearedAt", undefined),
        )
        .collect()) {
        await ctx.db.patch(push._id, { classId: scienceClassId });
      }
      // Its activity sits in Math Workshop on the timetable; Science is a tab
      // through another placement.
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        subject: "Math Workshop",
        assignmentId,
        activityId: filed.activityId,
      });
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        subject: "Science",
        assignmentId: otherAssignmentId,
        activityId: other.activityId,
      });
    });

    const asScholar = await withUser(t, scholarId);
    const result = await asScholar.query(api.scholarPlate.activeForMe, {});
    const row = result.rows.find((r) => r.activityId === filed.activityId);

    expect(result.subjectTabs).toEqual(["Math Workshop", "Science"]);
    expect(row?.subjectLabel).toBe("Science");
    expect(row?.subject).toBe("Science");
  });

  test("a filed class beats a conflicting placement for the tab; a unit with no subject still takes the placement's tab", async () => {
    const t = await withDefaultSchools(convexTest(schema, modules));
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const filed = await seedUnit(t, teacherId, "Ecosystems", undefined);
    const unfiled = await seedUnit(t, teacherId, "Free Reading", undefined);
    const now = Date.now();

    await t.run(async (ctx) => {
      const make = (u: { unitId: Id<"units">; activityId: Id<"activities"> }) =>
        insertAssignmentWithSchedule(ctx, {
          teacherId,
          unitId: u.unitId,
          scholarIds: [scholarId],
          startedAt: now,
          activitySchedule: [
            { activityId: u.activityId, mode: "homework", setAt: now - 1_000 },
          ],
        });
      const filedAssignmentId = await make(filed);
      const unfiledAssignmentId = await make(unfiled);
      const institution = (await ctx.db.query("institutions").first())!;
      const periodId = await ctx.db.insert("reportingPeriods", {
        label: "Current Term",
        startsAt: now - 86_400_000,
        endsAt: now + 86_400_000,
        status: "open",
      });
      const groupId = await ctx.db.insert("scholarGroups", {
        teacherId,
        name: "Geckos",
        scholarIds: [scholarId],
      });
      const scienceClassId = await ctx.db.insert("classes", {
        institutionId: institution._id,
        periodId,
        groupId,
        subject: "Science",
        subjectKey: "science",
        meetings: [],
      });
      for (const push of await ctx.db
        .query("pushes")
        .withIndex("by_assignment_cleared", (q) =>
          q.eq("assignmentId", filedAssignmentId).eq("clearedAt", undefined),
        )
        .collect()) {
        await ctx.db.patch(push._id, { classId: scienceClassId });
      }
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        subject: "Math Workshop",
        assignmentId: filedAssignmentId,
        activityId: filed.activityId,
      });
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        subject: "Science",
        assignmentId: unfiledAssignmentId,
        activityId: unfiled.activityId,
      });
    });

    const asScholar = await withUser(t, scholarId);
    const result = await asScholar.query(api.scholarPlate.activeForMe, {});
    const filedRow = result.rows.find((r) => r.activityId === filed.activityId);
    const unfiledRow = result.rows.find((r) => r.activityId === unfiled.activityId);
    expect(filedRow?.subject).toBe("Science");
    expect(unfiledRow?.subject).toBe("Science");
    expect(unfiledRow?.subjectLabel).toBe("Free Reading");
  });

  test("a give with no class takes the unit's subject, then the unit's title", async () => {
    const t = await withDefaultSchools(convexTest(schema, modules));
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const withSubject = await seedUnit(t, teacherId, "Ecosystems", "Interdisciplinary Science");
    const noSubject = await seedUnit(t, teacherId, "Free Reading", undefined);
    const now = Date.now();

    await t.run(async (ctx) => {
      for (const u of [withSubject, noSubject]) {
        await insertAssignmentWithSchedule(ctx, {
          teacherId,
          unitId: u.unitId,
          scholarIds: [scholarId],
          startedAt: now,
          activitySchedule: [
            { activityId: u.activityId, mode: "homework", setAt: now - 1_000 },
          ],
        });
      }
    });

    const asScholar = await withUser(t, scholarId);
    const result = await asScholar.query(api.scholarPlate.activeForMe, {});
    expect(
      result.rows.find((r) => r.activityId === withSubject.activityId)?.subjectLabel,
    ).toBe("Interdisciplinary Science");
    expect(
      result.rows.find((r) => r.activityId === noSubject.activityId)?.subjectLabel,
    ).toBe("Free Reading");
  });

  test("homework withdrawn and given again under another class stands as one row, filed under the new class", async () => {
    const t = await withDefaultSchools(convexTest(schema, modules));
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const unit = await seedUnit(t, teacherId, "Ecosystems", "Interdisciplinary Science");
    const now = Date.now();

    const result = await t.run(async (ctx) => {
      const institution = (await ctx.db.query("institutions").first())!;
      const periodId = await ctx.db.insert("reportingPeriods", {
        label: "Current Term",
        startsAt: now - 86_400_000,
        endsAt: now + 86_400_000,
        status: "open",
      });
      const groupId = await ctx.db.insert("scholarGroups", {
        teacherId,
        name: "Geckos",
        scholarIds: [scholarId],
      });
      const classFor = (subject: string) =>
        ctx.db.insert("classes", {
          institutionId: institution._id,
          periodId,
          groupId,
          subject,
          subjectKey: subject.toLowerCase(),
          meetings: [],
        });
      const mathClassId = await classFor("Math Workshop");
      const scienceClassId = await classFor("Science");
      const assignmentId = await insertAssignmentWithSchedule(ctx, {
        teacherId,
        unitId: unit.unitId,
        scholarIds: [scholarId],
        startedAt: now,
      });
      const entry = {
        activityId: unit.activityId,
        mode: "homework" as const,
        setAt: now - 1_000,
      };
      await setSchedule(ctx, assignmentId, [{ ...entry, homeworkClassId: mathClassId }]);
      // Withdrawn: the same row closes in place.
      await setSchedule(ctx, assignmentId, [
        { ...entry, homeworkClassId: mathClassId, endsAt: now - 500 },
      ]);
      const whileWithdrawn = await loadScheduleRows(ctx, assignmentId);
      // Given again under another class: the withdrawn row is retired.
      await setSchedule(ctx, assignmentId, [
        { ...entry, homeworkClassId: scienceClassId },
      ]);
      const rows = await loadScheduleRows(ctx, assignmentId);
      return {
        withdrawnCount: whileWithdrawn.length,
        rowCount: rows.length,
        classIds: [...firstClassIdByWork(rows).values()],
        mathClassId,
        scienceClassId,
      };
    });

    expect(result.withdrawnCount).toBe(1);
    expect(result.rowCount).toBe(1);
    expect(result.classIds).toEqual([result.scienceClassId]);

    const asScholar = await withUser(t, scholarId);
    const plate = await asScholar.query(api.scholarPlate.activeForMe, {});
    expect(
      plate.rows.find((r) => r.activityId === unit.activityId)?.subjectLabel,
    ).toBe("Science");
  });
});
