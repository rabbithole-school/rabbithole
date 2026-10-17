import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { assembleCurriculumTools } from "../lib/aideTools";
import { makeCustomAppTools } from "../lib/customAppTools";
import { assembleUnitDesignerTools } from "../lib/unitDesignerTools";
import {
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

/**
 * The vibecode MODEL CONTRACT (activities.buildContract) + allowSilence get
 * WRITTEN by every authoring surface: the web editor's mutations, the aide's
 * two vibecode tools, the unit designer tools — and travel on duplicate and
 * fork. Limits live in lib/buildContract.ts.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = TestConvex<typeof schema>;

const CONTRACT = {
  invariants: [
    "Winged seeds drift with the wind; heavy seeds land near the parent",
    "Seeds that land in the parent's shade sprout less often",
  ],
  freedoms: ["setting", "characters", "visuals"],
  gate: "One generation dropped and sprouted with the default seed",
};

async function seedUser(t: T, role: "teacher" | "scholar", username: string) {
  return await t.run((ctx) =>
    ctx.db.insert("users", { name: `Test ${role}`, username, role }),
  );
}

async function withUser(t: T, userId: Id<"users">) {
  const sessionId = await t.run((ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedLesson(t: T, teacherId: Id<"users">) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Plants on the move",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "How seeds travel",
      order: 0,
    });
    return { unitId, lessonId };
  });
}

function actionCtxFor(t: T): ActionCtx {
  return {
    runQuery: (ref: unknown, args: unknown) =>
      (t.query as (r: unknown, a: unknown) => Promise<unknown>)(ref, args),
    runMutation: (ref: unknown, args: unknown) =>
      (t.mutation as (r: unknown, a: unknown) => Promise<unknown>)(ref, args),
  } as unknown as ActionCtx;
}

async function runTool(
  tools: Array<{ name: string }>,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} was not registered`);
  return String(
    await (
      tool as unknown as {
        run: (args: Record<string, unknown>) => Promise<unknown>;
      }
    ).run(input),
  );
}

const activityByTitle = (t: T, title: string) =>
  t.run(async (ctx) =>
    (await ctx.db.query("activities").collect()).find(
      (row) => row.title === title,
    ),
  );

describe("model contract on activities", () => {
  test("create persists the contract and allowSilence on a vibecode activity", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "contract-teacher");
    const { lessonId } = await seedLesson(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    const id = await asTeacher.mutation(api.activities.create, {
      lessonId,
      title: "Seed launcher",
      kind: "vibecode",
      buildContract: {
        ...CONTRACT,
        invariants: ["  padded invariant  ", "", ...CONTRACT.invariants],
      },
      allowSilence: true,
    });
    const row = await asTeacher.query(api.activities.get, { id });
    expect(row?.buildContract).toEqual({
      ...CONTRACT,
      invariants: ["padded invariant", ...CONTRACT.invariants],
    });
    expect(row?.allowSilence).toBe(true);
  });

  test("kinds with no tutor session reject a mission; allowSilence is app-only", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "contract-kind-teacher");
    const { lessonId } = await seedLesson(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    await expect(
      asTeacher.mutation(api.activities.create, {
        lessonId,
        title: "Seed chat",
        kind: "offline",
        buildContract: CONTRACT,
      }),
    ).rejects.toThrow(/only to online activities/);
    await expect(
      asTeacher.mutation(api.activities.create, {
        lessonId,
        title: "Seed chat",
        kind: "offline",
        allowSilence: true,
      }),
    ).rejects.toThrow(/app \(build-an-app\) activities/);

    const offlineId = await asTeacher.mutation(api.activities.create, {
      lessonId,
      title: "Seed walk",
      kind: "offline",
    });
    await expect(
      asTeacher.mutation(api.activities.update, {
        id: offlineId,
        buildContract: CONTRACT,
      }),
    ).rejects.toThrow(/only to online activities/);
    await expect(
      t.mutation(internal.activities.upsertInternal, {
        parent: { kind: "lesson", lessonId },
        title: "Seed sort",
        kind: "offline",
        buildContract: CONTRACT,
      }),
    ).rejects.toThrow(/only to online activities/);
  });

  test("a non-app online activity carries a gate + freedoms mission, never invariants (TRA-519 B1)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "mission-teacher");
    const { lessonId } = await seedLesson(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const deliverable = {
      kind: "text" as const,
      prompt: "Write your story",
      mode: "none" as const,
      criteria: [],
    };

    await t.mutation(internal.activities.upsertInternal, {
      parent: { kind: "lesson", lessonId },
      title: "Narrative draft",
      kind: "online",
      deliverable,
      buildContract: {
        invariants: [],
        freedoms: ["  which moment you pick  "],
        gate: "a first draft of the whole story exists",
      },
    });
    const id = (await activityByTitle(t, "Narrative draft"))!._id;
    expect((await asTeacher.query(api.activities.get, { id }))?.buildContract).toEqual({
      invariants: [],
      freedoms: ["which moment you pick"],
      gate: "a first draft of the whole story exists",
    });

    await expect(
      asTeacher.mutation(api.activities.update, {
        id,
        buildContract: { invariants: ["the hero wins"], freedoms: [] },
      }),
    ).rejects.toThrow(/deliverable's criteria/);
    await expect(
      asTeacher.mutation(api.activities.update, { id, allowSilence: true }),
    ).rejects.toThrow(/app \(build-an-app\) activities/);

    // An empty mission on a non-app activity stores as absent.
    await asTeacher.mutation(api.activities.update, {
      id,
      buildContract: { invariants: [], freedoms: ["  "] },
    });
    expect((await asTeacher.query(api.activities.get, { id }))?.buildContract).toBeUndefined();
  });

  test("update sets, clears with null, and a kind flip drops both fields", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "contract-update-teacher");
    const { lessonId } = await seedLesson(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const id = await asTeacher.mutation(api.activities.create, {
      lessonId,
      title: "Seed launcher",
      kind: "vibecode",
    });

    await asTeacher.mutation(api.activities.update, {
      id,
      buildContract: CONTRACT,
      allowSilence: true,
    });
    let row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.buildContract).toEqual(CONTRACT);
    expect(row?.allowSilence).toBe(true);

    await asTeacher.mutation(api.activities.update, {
      id,
      buildContract: null,
      allowSilence: false,
    });
    row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.buildContract).toBeUndefined();
    expect(row?.allowSilence).toBeUndefined();

    await asTeacher.mutation(api.activities.update, {
      id,
      buildContract: CONTRACT,
      allowSilence: true,
    });
    await asTeacher.mutation(api.activities.update, { id, kind: "online" });
    row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.buildContract).toBeUndefined();
    expect(row?.allowSilence).toBeUndefined();
  });

  test("limits: 1–5 invariants, ≤ 8 freedoms, ≤ 240 characters per entry", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "contract-limit-teacher");
    const { lessonId } = await seedLesson(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const create = (buildContract: {
      invariants: string[];
      freedoms: string[];
      gate?: string;
    }) =>
      asTeacher.mutation(api.activities.create, {
        lessonId,
        title: "Limit probe",
        kind: "vibecode",
        buildContract,
      });
    const long = "x".repeat(241);
    const ok = "x".repeat(240);

    await expect(create({ invariants: ["  "], freedoms: [] })).rejects.toThrow(
      /1–5/,
    );
    await expect(
      create({ invariants: ["a", "b", "c", "d", "e", "f"], freedoms: [] }),
    ).rejects.toThrow(/1–5/);
    await expect(
      create({
        invariants: ["a"],
        freedoms: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
      }),
    ).rejects.toThrow(/at most 8/);
    await expect(create({ invariants: [long], freedoms: [] })).rejects.toThrow(
      /240/,
    );
    await expect(
      create({ invariants: ["a"], freedoms: [long] }),
    ).rejects.toThrow(/240/);
    await expect(
      create({ invariants: ["a"], freedoms: [], gate: long }),
    ).rejects.toThrow(/240/);

    const id = await create({
      invariants: ["a", "b", "c", "d", ok],
      freedoms: ["1", "2", "3", "4", "5", "6", "7", "8"],
      gate: ok,
    });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.buildContract?.invariants).toHaveLength(5);
    expect(row?.buildContract?.freedoms).toHaveLength(8);
  });

  test("duplicate and fork carry the contract and allowSilence", async () => {
    const t = convexTest(schema, modules);
    const sourceTeacherId = await seedUser(t, "teacher", "contract-source");
    const callerId = await seedUser(t, "teacher", "contract-forker");
    const { lessonId } = await seedLesson(t, sourceTeacherId);
    const sourceId = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Seed launcher",
        kind: "vibecode",
        systemPrompt: "Build a seed you can launch.",
        buildContract: CONTRACT,
        allowSilence: true,
        order: 0,
      }),
    );

    const copyId = await (
      await withUser(t, sourceTeacherId)
    ).mutation(api.activities.duplicate, { activityId: sourceId });
    const fork = await (
      await withUser(t, callerId)
    ).mutation(api.activities.forkToMyUnit, { activityId: sourceId });

    const [copy, forked, source] = await t.run(async (ctx) => [
      await ctx.db.get(copyId),
      await ctx.db.get(fork.activityId),
      await ctx.db.get(sourceId),
    ]);
    for (const row of [copy, forked]) {
      expect(row?.buildContract).toEqual(CONTRACT);
      expect(row?.allowSilence).toBe(true);
    }
    // A copy, not a shared reference: editing the copy leaves the source.
    expect(forked?._id).not.toBe(source?._id);
    expect(source?.buildContract).toEqual(CONTRACT);
  });

  test("allowSilence is stored only alongside a contract", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "contract-silence-teacher");
    const { lessonId } = await seedLesson(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const id = await asTeacher.mutation(api.activities.create, {
      lessonId,
      title: "Silent without a contract",
      kind: "vibecode",
      allowSilence: true,
    });
    let row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.allowSilence).toBeUndefined();

    await asTeacher.mutation(api.activities.update, { id, allowSilence: true });
    row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.allowSilence).toBeUndefined();

    // With a contract already on the row, allowSilence alone sticks.
    await asTeacher.mutation(api.activities.update, { id, buildContract: CONTRACT });
    await asTeacher.mutation(api.activities.update, { id, allowSilence: true });
    row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.allowSilence).toBe(true);

    // Clearing the contract clears allowSilence with it.
    await asTeacher.mutation(api.activities.update, { id, buildContract: null });
    row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.buildContract).toBeUndefined();
    expect(row?.allowSilence).toBeUndefined();

    const upserted = await t.mutation(internal.activities.upsertInternal, {
      parent: { kind: "lesson", lessonId },
      title: "Upserted without a contract",
      kind: "vibecode",
      allowSilence: true,
    });
    row = await t.run((ctx) => ctx.db.get(upserted.activityId));
    expect(row?.allowSilence).toBeUndefined();
  });

  test("an upsert retry naming vibecode + contract never writes it onto an online row", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "contract-upsert-teacher");
    const { lessonId } = await seedLesson(t, teacherId);
    const activityId = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Seed launcher",
        kind: "online",
        systemPrompt: "Explain how far seeds travel.",
        order: 0,
      }),
    );
    await t.mutation(internal.activities.upsertInternal, {
      parent: { kind: "lesson", lessonId },
      match: { byId: activityId },
      title: "Seed launcher",
      kind: "vibecode",
      buildContract: CONTRACT,
      allowSilence: true,
    });
    const row = await t.run((ctx) => ctx.db.get(activityId));
    expect(row?.kind).toBe("online");
    expect(row?.buildContract).toBeUndefined();
    expect(row?.allowSilence).toBeUndefined();
  });
});

describe("model contract via the aide and unit tools", () => {
  test("create_scholar_activity writes both fields on a vibecode activity", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, {
      name: "Voyager Academy",
      slug: "voyager-contract",
    });
    const teacherId = await seedStaffWithMembership(t, {
      institutionId,
      name: "Lehua Torres",
      username: "lehua-contract",
    });
    const { lessonId } = await seedLesson(t, teacherId);
    const tools = (await assembleCurriculumTools(actionCtxFor(t), vi.fn(), {
      role: "teacher",
      callerUserId: teacherId,
      surface: "private",
      allowedScholarIds: new Set(),
      scholarLensResolved: true,
    })) as Array<{ name: string }>;

    const reply = await runTool(tools, "create_scholar_activity", {
      lessonId,
      title: "Seed launcher",
      kind: "vibecode",
      systemPrompt: "Build a seed you can launch and watch land.",
      buildContract: CONTRACT,
      allowSilence: true,
    });
    expect(JSON.parse(reply).kind).toBe("app");
    const row = await activityByTitle(t, "Seed launcher");
    expect(row?.buildContract).toEqual(CONTRACT);
    expect(row?.allowSilence).toBe(true);
  });

  test("make_app_a_coached_activity writes both fields on the drafted activity", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, {
      name: "Voyager Academy",
      slug: "voyager-coached-contract",
    });
    const teacherId = await seedStaffWithMembership(t, {
      institutionId,
      name: "Lehua Torres",
      username: "lehua-coached-contract",
    });
    const tools = (await makeCustomAppTools(actionCtxFor(t), vi.fn(), {
      role: "teacher",
      callerUserId: teacherId,
      linkBase: "https://rabbithole.test",
      allowedScholarIds: new Set(),
      scholarLensResolved: true,
    })) as Array<{ name: string }>;

    // A malformed contract is refused before any unit is created.
    const refused = await runTool(tools, "make_app_a_coached_activity", {
      appRequest: "A bridge you load with trucks until it sags.",
      title: "Bridge loader",
      buildBrief: "Let the scholar find how span length changes sag.",
      buildContract: { invariants: [], freedoms: [] },
    });
    expect(refused).toMatch(/^Not created/);
    expect(
      await t.run(async (ctx) => (await ctx.db.query("units").collect()).length),
    ).toBe(0);

    await runTool(tools, "make_app_a_coached_activity", {
      appRequest: "A bridge you load with trucks until it sags.",
      title: "Bridge loader",
      buildBrief: "Let the scholar find how span length changes sag.",
      buildContract: CONTRACT,
      allowSilence: true,
    });
    const row = await activityByTitle(t, "Bridge loader");
    // TRA-519: an app activity is stored as online + appActivity.
    expect(row).toMatchObject({ kind: "online", appActivity: true });
    expect(row?.buildContract).toEqual(CONTRACT);
    expect(row?.allowSilence).toBe(true);
  });

  test("unit create_activity and update_activity write the contract", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "contract-unit-teacher");
    const { unitId } = await seedLesson(t, teacherId);
    const tools = (await assembleUnitDesignerTools(actionCtxFor(t), () => {}, {
      teacherId,
      unitId,
      role: "teacher",
    })) as Array<{ name: string }>;

    await runTool(tools, "create_activity", {
      lessonTitle: "How seeds travel",
      title: "Seed launcher",
      kind: "vibecode",
      systemPrompt: "Build a seed you can launch.",
      buildContract: CONTRACT,
      allowSilence: true,
    });
    let row = await activityByTitle(t, "Seed launcher");
    expect(row?.buildContract).toEqual(CONTRACT);
    expect(row?.allowSilence).toBe(true);

    const next = { invariants: ["Heavier seeds fall faster"], freedoms: [] };
    await runTool(tools, "update_activity", {
      lessonTitle: "How seeds travel",
      activityTitle: "Seed launcher",
      buildContract: next,
      allowSilence: false,
    });
    row = await activityByTitle(t, "Seed launcher");
    expect(row?.buildContract).toEqual(next);
    expect(row?.allowSilence).toBeUndefined();

    // Non-vibecode: refused, nothing written.
    await runTool(tools, "create_activity", {
      lessonTitle: "How seeds travel",
      title: "Seed walk",
      kind: "offline",
    });
    const refused = await runTool(tools, "update_activity", {
      lessonTitle: "How seeds travel",
      activityTitle: "Seed walk",
      buildContract: CONTRACT,
    });
    expect(refused).toMatch(/^Not updated/);
    expect((await activityByTitle(t, "Seed walk"))?.buildContract).toBeUndefined();
  });
});

// TRA-477: the aide and unit tools can now set the App designer's scholar
// edit policy (activities.editAccess) — vibecode only.
describe("scholar edit policy via the aide and unit tools", () => {
  async function curriculumTools(t: T, slug: string) {
    const institutionId = await seedTestInstitution(t, {
      name: "Voyager Academy",
      slug,
    });
    const teacherId = await seedStaffWithMembership(t, {
      institutionId,
      name: "Lehua Torres",
      username: `${slug}-teacher`,
    });
    const { lessonId } = await seedLesson(t, teacherId);
    const tools = (await assembleCurriculumTools(actionCtxFor(t), vi.fn(), {
      role: "teacher",
      callerUserId: teacherId,
      surface: "private",
      allowedScholarIds: new Set(),
      scholarLensResolved: true,
    })) as Array<{ name: string }>;
    return { tools, lessonId };
  }

  test("create_scholar_activity writes each scholarEdit value; omitted stays unset", async () => {
    const t = convexTest(schema, modules);
    const { tools, lessonId } = await curriculumTools(t, "edit-aide");

    for (const [scholarEdit, stored] of [
      ["play", "never"],
      ["afterCompletion", "afterCompletion"],
      ["build", "always"],
      [undefined, undefined],
    ] as const) {
      const title = `Seed launcher ${scholarEdit ?? "default"}`;
      await runTool(tools, "create_scholar_activity", {
        lessonId,
        title,
        kind: "vibecode",
        systemPrompt: "Build a seed you can launch and watch land.",
        ...(scholarEdit ? { scholarEdit } : {}),
      });
      const row = await activityByTitle(t, title);
      expect(row).toMatchObject({ kind: "online", appActivity: true });
      expect(row?.editAccess).toBe(stored);
    }
  });

  test("create_scholar_activity refuses scholarEdit on a non-vibecode kind", async () => {
    const t = convexTest(schema, modules);
    const { tools, lessonId } = await curriculumTools(t, "edit-aide-kind");

    const reply = await runTool(tools, "create_scholar_activity", {
      lessonId,
      title: "Seed walk",
      kind: "offline",
      scholarEdit: "play",
    });
    expect(JSON.parse(reply).error).toMatch(/app activities only/);
    expect(await activityByTitle(t, "Seed walk")).toBeFalsy();
  });

  test("updateInternal sets editAccess on vibecode, rejects other kinds, clears on a kind flip", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "edit-update-teacher");
    const { lessonId } = await seedLesson(t, teacherId);
    const vibe = await t.mutation(internal.activities.upsertInternal, {
      parent: { kind: "lesson", lessonId },
      title: "Gecko climb",
      kind: "vibecode",
    });
    const offline = await t.mutation(internal.activities.upsertInternal, {
      parent: { kind: "lesson", lessonId },
      title: "Spelling walk",
      kind: "offline",
    });

    await t.mutation(internal.activities.updateInternal, {
      id: vibe.activityId,
      editAccess: "never",
    });
    expect((await activityByTitle(t, "Gecko climb"))?.editAccess).toBe("never");

    await expect(
      t.mutation(internal.activities.updateInternal, {
        id: offline.activityId,
        editAccess: "never",
      }),
    ).rejects.toThrow(/app activities only/);
    expect((await activityByTitle(t, "Spelling walk"))?.editAccess).toBeUndefined();
    await expect(
      t.mutation(internal.activities.upsertInternal, {
        parent: { kind: "lesson", lessonId },
        title: "Spelling walk two",
        kind: "offline",
        editAccess: "never",
      }),
    ).rejects.toThrow(/app activities only/);

    await t.mutation(internal.activities.updateInternal, {
      id: vibe.activityId,
      kind: "offline",
    });
    expect((await activityByTitle(t, "Gecko climb"))?.editAccess).toBeUndefined();
  });

  test("unit create_activity and update_activity write scholarEdit", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "edit-unit-teacher");
    const { unitId } = await seedLesson(t, teacherId);
    const tools = (await assembleUnitDesignerTools(actionCtxFor(t), () => {}, {
      teacherId,
      unitId,
      role: "teacher",
    })) as Array<{ name: string }>;

    await runTool(tools, "create_activity", {
      lessonTitle: "How seeds travel",
      title: "Seed game",
      kind: "vibecode",
      systemPrompt: "A seed game to play.",
      scholarEdit: "play",
    });
    expect((await activityByTitle(t, "Seed game"))?.editAccess).toBe("never");

    await runTool(tools, "update_activity", {
      lessonTitle: "How seeds travel",
      activityTitle: "Seed game",
      scholarEdit: "afterCompletion",
    });
    expect((await activityByTitle(t, "Seed game"))?.editAccess).toBe(
      "afterCompletion",
    );

    await runTool(tools, "create_activity", {
      lessonTitle: "How seeds travel",
      title: "Seed walk",
      kind: "offline",
    });
    const refused = await runTool(tools, "update_activity", {
      lessonTitle: "How seeds travel",
      activityTitle: "Seed walk",
      scholarEdit: "play",
    });
    expect(refused).toMatch(/^Not updated/);
    expect((await activityByTitle(t, "Seed walk"))?.editAccess).toBeUndefined();
  });
});
