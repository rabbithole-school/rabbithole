import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { seedScholarInInstitution, seedStaffWithMembership, seedTestInstitution } from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" = "scholar",
  overrides: { name?: string; username?: string } = {},
): Promise<Id<"users">> {
  const institutionId = await seedTestInstitution(t);
  const name = overrides.name ?? `Test ${role}`;
  const username = overrides.username ?? `test${role}`;
  return role === "scholar"
    ? seedScholarInInstitution(t, { institutionId, name, username })
    : seedStaffWithMembership(t, { institutionId, name, username });
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

describe("users.assignmentsForScholar — focus schedule liveness", () => {
  test("ignores planned class focus until setAt is stamped", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const teacherId = await seedUser(t, "teacher", { username: "teacherFocus" });
    const scholarId = await seedUser(t, "scholar", { username: "scholarFocus" });
    const { assignmentId, activityId } = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Signal Patterns",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Signals",
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Decode the signal",
        kind: "online",
        order: 0,
      });
      const assignmentId = await ctx.db.insert("assignments", {
        teacherId,
        unitId,
        scholarIds: [scholarId],
        startedAt: now,
        activitySchedule: [
          {
            activityId,
            mode: "classFocus",
            startsAt: now + 60_000,
            endsAt: now + 3_600_000,
          },
        ],
      });
      return { assignmentId, activityId };
    });

    const asTeacher = await withUser(t, teacherId);
    const planned = await asTeacher.query(api.users.assignmentsForScholar, {
      scholarId,
    });
    expect(planned).not.toHaveProperty("independentStudyUnits");
    expect(planned.assignments).toEqual([
      expect.objectContaining({
        assignmentId,
        title: "Signal Patterns",
        unitTitle: "Signal Patterns",
      }),
    ]);
    expect(planned.focus).toBeNull();

    await t.run(async (ctx) => {
      const assignment = await ctx.db.get(assignmentId);
      expect(assignment).not.toBeNull();
      await ctx.db.patch(assignmentId, {
        activitySchedule: [
          {
            ...assignment!.activitySchedule![0],
            setAt: now,
          },
        ],
      });
    });

    const live = await asTeacher.query(api.users.assignmentsForScholar, {
      scholarId,
    });
    expect(live.assignments).toHaveLength(1);
    expect(live.focus?.activityId).toBe(activityId);
    expect(live.focus?.activityTitle).toBe("Decode the signal");
  });

  test("resolves a live unit-less ad-hoc dispatch without throwing", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", {
      username: "teacherDispatch",
    });
    const scholarId = await seedUser(t, "scholar", {
      username: "scholarDispatch",
    });

    const asTeacher = await withUser(t, teacherId);
    // "Dispatch now" creates a kind: "adHocDispatch" assignment with NO unitId
    // but a live classFocus schedule entry — the shape that used to crash the
    // teacher Now pane via a bare ctx.db.get(a.unitId!).
    const { assignmentId } = await asTeacher.mutation(
      api.assignments.dispatchActivity,
      { scholarId, title: "Sketch a tide pool" },
    );

    const result = await asTeacher.query(api.users.assignmentsForScholar, {
      scholarId,
    });
    expect(result.assignments).toEqual([
      expect.objectContaining({
        assignmentId,
        title: "Sketch a tide pool",
        unitTitle: null,
      }),
    ]);
    expect(result.focus).not.toBeNull();
    expect(result.focus?.unitId).toBeNull();
    expect(result.focus?.unitTitle).toBeNull();
    expect(result.focus?.activityTitle).toBe("Sketch a tide pool");
  });

  test("ignores class focus targeted to another rostered scholar", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const teacherId = await seedUser(t, "teacher", {
      username: "teacherTargeting",
    });
    const scholarId = await seedUser(t, "scholar", {
      username: "scholarExcluded",
    });
    const targetedScholarId = await seedUser(t, "scholar", {
      username: "scholarTargeted",
    });
    await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Targeted unit",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Targeted lesson",
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Targeted activity",
        kind: "online",
        order: 0,
      });
      await ctx.db.insert("assignments", {
        teacherId,
        unitId,
        scholarIds: [scholarId, targetedScholarId],
        startedAt: now,
        activitySchedule: [
          {
            activityId,
            mode: "classFocus",
            setAt: now,
            endsAt: now + 60_000,
            scholarIds: [targetedScholarId],
          },
        ],
      });
    });

    const asTeacher = await withUser(t, teacherId);
    const result = await asTeacher.query(api.users.assignmentsForScholar, {
      scholarId,
    });
    expect(result.assignments).toHaveLength(1);
    expect(result.focus).toBeNull();
  });
});
