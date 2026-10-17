// TRA-519 A4 — every activity writer folds an app activity into
// { kind: "online", appActivity: true } (lib/appActivity.ts), whether the
// caller says kind "vibecode" (legacy, still accepted) or appActivity: true.
// The installer, the coached-app tool and fork are covered where they live
// (appInstall / makeAppCoachedActivity / curriculumDuplicate tests).

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  defaultAppDeliverable,
  foldedAppActivityPatch,
  resolveActivityWriteTarget,
} from "../lib/appActivity";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TestCtx = TestConvex<typeof schema>;

const CONTRACT = {
  invariants: ["Heavier carts speed up less under the same push"],
  freedoms: ["The cart's look"],
};

async function seedTeacher(t: TestCtx) {
  return await t.run((ctx) =>
    ctx.db.insert("users", {
      name: "Avery Stone",
      username: `teacher-${crypto.randomUUID()}`,
      role: "teacher",
    }),
  );
}

async function withUser(t: TestCtx, userId: Id<"users">) {
  const authSessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${authSessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedLesson(t: TestCtx, teacherId: Id<"users">) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Forces",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Carts",
      order: 0,
    });
    return { unitId, lessonId };
  });
}

const read = (t: TestCtx, id: Id<"activities">) =>
  t.run((ctx) => ctx.db.get(id));

function expectFoldedApp(row: Doc<"activities"> | null) {
  expect(row).toMatchObject({ kind: "online", appActivity: true });
  expect(row?.deliverable?.kind).toBe("artifact");
}

describe("resolveActivityWriteTarget", () => {
  test("legacy kind and the flag resolve to the same stored shape", () => {
    expect(resolveActivityWriteTarget(null, { kind: "vibecode" })).toMatchObject(
      { kind: "online", isApp: true, effectiveKind: "vibecode" },
    );
    expect(
      resolveActivityWriteTarget(null, { kind: "online", appActivity: true }),
    ).toMatchObject({ kind: "online", isApp: true, effectiveKind: "vibecode" });
    expect(resolveActivityWriteTarget(null, { kind: "online" })).toMatchObject({
      kind: "online",
      isApp: false,
      effectiveKind: "online",
    });
  });

  test("an edit that names no shape keeps the row's (a legacy row folds)", () => {
    expect(
      resolveActivityWriteTarget({ kind: "vibecode" }, {}),
    ).toMatchObject({ kind: "online", isApp: true, shapeSupplied: false });
    expect(
      resolveActivityWriteTarget({ kind: "online", appActivity: true }, {
        kind: "online",
      }),
    ).toMatchObject({ isApp: false, leavesApp: true });
  });

  test("only an online activity can be an app", () => {
    expect(() =>
      resolveActivityWriteTarget(null, { kind: "offline", appActivity: true }),
    ).toThrow(/Only an online activity/);
    expect(() =>
      resolveActivityWriteTarget(null, { kind: "vibecode", appActivity: false }),
    ).toThrow();
  });
});

describe("every writer stores the folded shape", () => {
  test("activities.create — kind vibecode and appActivity alike", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const { lessonId } = await seedLesson(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const legacy = await asTeacher.mutation(api.activities.create, {
      lessonId,
      title: "Cart lab",
      kind: "vibecode",
      scholarDescription: "Build a cart you can push.",
      tutorModel: "fable",
      buildContract: CONTRACT,
    });
    const flagged = await asTeacher.mutation(api.activities.create, {
      lessonId,
      title: "Cart lab two",
      kind: "online",
      appActivity: true,
    });
    const legacyRow = await read(t, legacy);
    expectFoldedApp(legacyRow);
    // The default app deliverable's prompt is the scholar description.
    expect(legacyRow?.deliverable?.prompt).toBe("Build a cart you can push.");
    expect(legacyRow?.tutorModel).toBe("fable");
    expect(legacyRow?.buildContract).toEqual(CONTRACT);
    expectFoldedApp(await read(t, flagged));
  });

  test("activities.update — appActivity on, then off, clears app-only fields", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const { lessonId } = await seedLesson(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const id = await asTeacher.mutation(api.activities.create, {
      lessonId,
      title: "Cart chat",
      kind: "online",
    });
    await asTeacher.mutation(api.activities.update, { id, appActivity: true });
    expectFoldedApp(await read(t, id));
    await asTeacher.mutation(api.activities.update, {
      id,
      buildContract: CONTRACT,
      allowSilence: true,
      editAccess: "never",
      tutorModel: "fable",
    });
    expect(await read(t, id)).toMatchObject({
      buildContract: CONTRACT,
      allowSilence: true,
      editAccess: "never",
      tutorModel: "fable",
    });

    await asTeacher.mutation(api.activities.update, { id, appActivity: false });
    const off = await read(t, id);
    expect(off?.kind).toBe("online");
    expect(off?.appActivity).toBeUndefined();
    expect(off?.buildContract).toBeUndefined();
    expect(off?.allowSilence).toBeUndefined();
    expect(off?.editAccess).toBeUndefined();
    expect(off?.tutorModel).toBeUndefined();
    // The untouched default app deliverable goes with it.
    expect(off?.deliverable).toBeUndefined();
  });

  test("activities.update — app off keeps a deliverable whose prompt the teacher wrote", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const { lessonId } = await seedLesson(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const id = await asTeacher.mutation(api.activities.create, {
      lessonId,
      title: "Cart chat",
      kind: "online",
    });
    await asTeacher.mutation(api.activities.update, { id, appActivity: true });
    await asTeacher.mutation(api.activities.update, {
      id,
      deliverable: {
        kind: "artifact",
        prompt: "Build a cart that shows mass vs. acceleration.",
        mode: "none",
        criteria: [],
      },
    });
    await asTeacher.mutation(api.activities.update, { id, appActivity: false });
    expect((await read(t, id))?.deliverable?.prompt).toBe(
      "Build a cart that shows mass vs. acceleration.",
    );
  });

  test("activities.update — app off drops a default derived from scholarDescription", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const { lessonId } = await seedLesson(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const id = await asTeacher.mutation(api.activities.create, {
      lessonId,
      title: "Cart chat",
      kind: "online",
      scholarDescription: "Make the cart move.",
    });
    await asTeacher.mutation(api.activities.update, { id, appActivity: true });
    expect((await read(t, id))?.deliverable?.prompt).toBe("Make the cart move.");
    await asTeacher.mutation(api.activities.update, { id, appActivity: false });
    expect((await read(t, id))?.deliverable).toBeUndefined();
  });

  test("activities.update — kind vibecode on a legacy-free row folds it", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const { lessonId } = await seedLesson(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const id = await asTeacher.mutation(api.activities.create, {
      lessonId,
      title: "Cart walk",
      kind: "offline",
    });
    await asTeacher.mutation(api.activities.update, { id, kind: "vibecode" });
    expectFoldedApp(await read(t, id));
  });

  test("upsertInternal / createInternal / updateInternal", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const { lessonId } = await seedLesson(t, teacherId);
    const upserted = await t.mutation(internal.activities.upsertInternal, {
      parent: { kind: "lesson", lessonId },
      title: "Gecko climb",
      kind: "vibecode",
      editAccess: "afterCompletion",
    });
    expect(upserted.kind).toBe("vibecode"); // effective kind reported back
    expectFoldedApp(await read(t, upserted.activityId));

    // An idempotent retry naming the legacy kind matches the folded row.
    const retry = await t.mutation(internal.activities.upsertInternal, {
      parent: { kind: "lesson", lessonId },
      match: { byTitle: "Gecko climb" },
      title: "Gecko climb",
      kind: "vibecode",
      buildContract: CONTRACT,
    });
    expect(retry.existed).toBe(true);
    expect((await read(t, upserted.activityId))?.buildContract).toEqual(
      CONTRACT,
    );

    const created = await t.mutation(internal.activities.createInternal, {
      lessonId,
      title: "Ramp builder",
      kind: "vibecode",
    });
    expectFoldedApp(await read(t, created));

    const plain = await t.mutation(internal.activities.upsertInternal, {
      parent: { kind: "lesson", lessonId },
      title: "Ramp talk",
      kind: "offline",
    });
    await t.mutation(internal.activities.updateInternal, {
      id: plain.activityId,
      kind: "vibecode",
    });
    expectFoldedApp(await read(t, plain.activityId));
  });

  test("aiCreateForIsUnit (Quest co-design)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const scholarId = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Hoku Makani",
        username: `scholar-${crypto.randomUUID()}`,
        role: "scholar",
      }),
    );
    const { unitId, lessonId } = await seedLesson(t, teacherId);
    await t.run((ctx) => ctx.db.patch(unitId, { authorScholarId: scholarId }));
    // B6: a Quest's build step comes after a learning step.
    await t.mutation(internal.activities.aiCreateForIsUnit, {
      lessonId,
      scholarId,
      unitId,
      title: "How money grows",
      kind: "online",
      systemPrompt: "Work out how interest compounds.",
    });
    const id = await t.mutation(internal.activities.aiCreateForIsUnit, {
      lessonId,
      scholarId,
      unitId,
      title: "Clicker",
      kind: "vibecode",
      systemPrompt: "Build a clicker that shows compound growth.",
    });
    expectFoldedApp(await read(t, id));
  });

  test("duplicate copies a legacy row into the folded shape", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const { lessonId } = await seedLesson(t, teacherId);
    const source = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Old app",
        kind: "vibecode",
        order: 0,
        editAccess: "never",
        buildContract: CONTRACT,
      }),
    );
    const asTeacher = await withUser(t, teacherId);
    const copy = await asTeacher.mutation(api.activities.duplicate, {
      activityId: source,
    });
    const row = await read(t, copy);
    expectFoldedApp(row);
    expect(row?.buildContract).toEqual(CONTRACT);
  });

  test("teacherAide.createScholarActivity", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const { lessonId } = await seedLesson(t, teacherId);
    const result = await t.mutation(internal.teacherAide.createScholarActivity, {
      lessonId,
      title: "Seed launcher",
      kind: "vibecode",
      systemPrompt: "Build a seed you can launch.",
      tutorModel: "fable",
    });
    const row = await read(t, result.activityId);
    expectFoldedApp(row);
    expect(row?.tutorModel).toBe("fable");
  });
});

describe("app-only settings and the one-bar rule", () => {
  test("a contract or editAccess on a plain online activity is refused", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const { lessonId } = await seedLesson(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    await expect(
      asTeacher.mutation(api.activities.create, {
        lessonId,
        title: "Chat",
        kind: "online",
        buildContract: CONTRACT,
      }),
    ).rejects.toThrow(/deliverable's criteria/);
    const id = await asTeacher.mutation(api.activities.create, {
      lessonId,
      title: "Chat",
      kind: "online",
    });
    await expect(
      asTeacher.mutation(api.activities.update, { id, editAccess: "never" }),
    ).rejects.toThrow(/app activities only/);
  });

  test("an app activity can't take an advanceRubric", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const { lessonId } = await seedLesson(t, teacherId);
    await expect(
      t.mutation(internal.activities.upsertInternal, {
        parent: { kind: "lesson", lessonId },
        title: "Debate app",
        kind: "vibecode",
        advanceRubric: { criteria: [{ id: "rule", label: "Names the rule" }] },
      }),
    ).rejects.toThrow(/advanceRubric/);

    const discussion = await t.mutation(internal.activities.upsertInternal, {
      parent: { kind: "lesson", lessonId },
      title: "Discussion",
      kind: "online",
      advanceRubric: { criteria: [{ id: "rule", label: "Names the rule" }] },
    });
    await expect(
      t.mutation(internal.activities.updateInternal, {
        id: discussion.activityId,
        appActivity: true,
      }),
    ).rejects.toThrow(/advanceRubric/);
  });
});

describe("foldedAppActivityPatch", () => {
  test("legacy rows only; a defaulted deliverable only when there is no bar", () => {
    expect(foldedAppActivityPatch({ kind: "online" })).toEqual({});
    expect(
      foldedAppActivityPatch({ kind: "vibecode", scholarDescription: "Go!" }),
    ).toEqual({
      kind: "online",
      appActivity: true,
      deliverable: defaultAppDeliverable({ scholarDescription: "Go!" }),
    });
    expect(
      foldedAppActivityPatch({
        kind: "vibecode",
        advanceRubric: { criteria: [{ id: "a", label: "A" }] },
      }),
    ).toEqual({ kind: "online", appActivity: true });
  });
});
