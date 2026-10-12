import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { grantInstitutionMembership, seedTestInstitution } from "./institutionTestHelpers";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import {
  classFocusLifetimeConfirmation,
  makeAssignmentTools,
} from "../lib/assignmentTools";
import type { Role } from "../lib/roles";

/**
 * The teacher Aide's `assign_activity_now` tool (convex/lib/aideTools.ts) has
 * no backend mutation of its own — it COMPOSES two existing internal mutations:
 * `aideAssignWork` (target kind "activity", startsAt now) creates/reuses the
 * cohort assignment and PLANS the one activity, then `aidePushActivityNow`
 * stamps it live. These tests cover that composition and the roster-subset
 * semantics the tool relies on (a named subset becomes its own right-sized
 * assignment) at the mutation layer, since the tool closures can't be driven
 * without a live action ctx.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

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
  role = "scholar",
  overrides: { name?: string; username?: string } = {},
) {
  const institutionId = await seedTestInstitution(t);
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test${role}${Math.random()}`,
      role,
    }),
  );

  await t.run((ctx) => ctx.db.patch(userId, { institutionId }));
  if (role === "teacher" || role === "school_admin") await grantInstitutionMembership(t, userId, institutionId, role);
  return userId;
}

async function seedUnitWithActivity(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  title = "Test Unit",
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title,
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Test Lesson",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Test Activity",
      kind: "online",
      systemPrompt: "...",
      order: 0,
    });
    return { unitId, lessonId, activityId };
  });
}

const HOUR = 3_600_000;

async function toolsFor(
  t: ReturnType<typeof convexTest>,
  callerUserId: Id<"users">,
  role: Role = "teacher",
) {
  const tools = await makeAssignmentTools(actionCtxFor(t), () => {}, {
    role,
    callerUserId,
  });
  return Object.fromEntries(tools.map((tool) => [tool.name, tool])) as Record<
    string,
    { run: (input: unknown) => Promise<string> }
  >;
}

describe("assign_activity_now composition", () => {
  test("tool result states the class-focus lifetime", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    await seedUser(t, "scholar", {
      name: "Avery Example",
      username: "avery-example",
    });
    await seedUnitWithActivity(t, teacher);
    const tools = await toolsFor(t, teacher);

    const withoutEnd = JSON.parse(
      await tools.assign_activity_now.run({
        unitTitle: "Test Unit",
        activityTitle: "Test Activity",
        scholarNames: ["Avery Example"],
        mode: "classFocus",
      }),
    ) as Record<string, unknown>;
    expect(withoutEnd.confirmation).toBe(
      classFocusLifetimeConfirmation(undefined, "Pacific/Honolulu"),
    );

    const endsAtMs = Date.now() + HOUR;
    const withEnd = JSON.parse(
      await tools.assign_activity_now.run({
        unitTitle: "Test Unit",
        activityTitle: "Test Activity",
        scholarNames: ["Avery Example"],
        mode: "classFocus",
        endsAtMs,
      }),
    ) as Record<string, unknown>;
    expect(withEnd.confirmation).toBe(
      classFocusLifetimeConfirmation(endsAtMs, "Pacific/Honolulu"),
    );
  });

  test("assignWork(activity) plans it, then pushActivityNow makes it live", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacher);

    const now = Date.now();
    const res = await t.run(async (ctx) =>
      ctx.runMutation(internal.assignments.aideAssignWork, {
        callerUserId: teacher,
        unitId,
        scholarIds: [scholar],
        startsAt: now,
        target: {
          kind: "activity",
          activityId,
          mode: "classFocus",
          endsAt: now + HOUR,
        },
      }),
    );
    expect(res.created).toBe(true);

    // assignWork alone only PLANS the activity — not yet visible to scholars.
    const planned = await t.run(async (ctx) => ctx.db.get(res.assignmentId));
    expect(planned?.activitySchedule).toHaveLength(1);
    expect(planned!.activitySchedule![0].activityId).toBe(activityId);
    expect(planned!.activitySchedule![0].setAt).toBeUndefined();

    // The second half of the tool: push it live now.
    await t.run(async (ctx) =>
      ctx.runMutation(internal.assignments.aidePushActivityNow, {
        callerUserId: teacher,
        assignmentId: res.assignmentId,
        activityId,
        mode: "classFocus",
        endsAt: now + HOUR,
      }),
    );

    const live = await t.run(async (ctx) => ctx.db.get(res.assignmentId));
    expect(live!.activitySchedule).toHaveLength(1);
    const entry = live!.activitySchedule![0];
    expect(entry.activityId).toBe(activityId);
    expect(entry.mode).toBe("classFocus");
    // Live now — setAt stamped so the scholar sees it.
    expect(entry.setAt).toBeDefined();
  });

  test("a named subset becomes its own right-sized assignment", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const a = await seedUser(t, "scholar", { username: "scholar-a" });
    const b = await seedUser(t, "scholar", { username: "scholar-b" });
    const c = await seedUser(t, "scholar", { username: "scholar-c" });
    const { unitId, activityId } = await seedUnitWithActivity(t, teacher);

    // Whole-class assignment already exists for the unit.
    await t.run(async (ctx) =>
      ctx.runMutation(internal.assignments.aideAssignWork, {
        callerUserId: teacher,
        unitId,
        scholarIds: [a, b, c],
        startsAt: Date.now(),
        target: { kind: "unit" },
      }),
    );

    // The tool targets EXACTLY the named subset — a different roster, so it's a
    // fresh, right-sized assignment rather than a push to the whole cohort.
    const now = Date.now();
    const subset = await t.run(async (ctx) =>
      ctx.runMutation(internal.assignments.aideAssignWork, {
        callerUserId: teacher,
        unitId,
        scholarIds: [a],
        startsAt: now,
        target: { kind: "activity", activityId, mode: "homework", dueAt: now + 24 * HOUR },
      }),
    );
    expect(subset.created).toBe(true);

    const doc = await t.run(async (ctx) => ctx.db.get(subset.assignmentId));
    expect(doc!.scholarIds).toEqual([a]);
  });

  test("composition is teacher/admin-only (a scholar cannot assign)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedUnitWithActivity(t, teacher);

    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.assignments.aideAssignWork, {
          callerUserId: scholar,
          unitId,
          scholarIds: [scholar],
          startsAt: Date.now(),
          target: { kind: "activity", activityId, mode: "classFocus" },
        }),
      ),
    ).rejects.toThrow(/teacher\/admin only/i);
  });
});
