// The teacher Apps list's sort + learning-contract fields, on top of Teacher
// Apps v2 (#4262):
//   • appAudiences.listAppsWithAudiences rows carry createdAt, lastEditedAt
//     (a custom app's customApps.updatedAt; null for web/native) and
//     hasLearningContract (an un-archived activity whose starterAppId is the
//     app's custom-app row carries a buildContract).
//   • scholarBuiltApps.listForScholars cards carry lastEditedAt (the
//     codeArtifactRevisions row for the current revision, else last activity)
//     and hasLearningContract (the session's activity has a buildContract),
//     filter on it while paging, and walk oldest first with order: "asc".
//
// Fixtures are the fictional makeWorld cast.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { customAppPath } from "../../shared/appKind";
import {
  makeActivity,
  makeLesson,
  makeUnit,
  makeWorld,
  type WorldScholar,
} from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const _makeTestClient = () => convexTest(schema, modules);
type TestClient = ReturnType<typeof _makeTestClient>;

const CONTRACT = {
  invariants: ["Dragging a piece changes the fraction shown"],
  freedoms: ["Colors and theme"],
  gate: "The wall shows one fraction",
};
const HTML = "<html><body>app</body></html>";
const PAGE = { numItems: 50, cursor: null };

async function seedCustomApp(
  t: TestClient,
  opts: { name: string; token: string; createdBy: Id<"users">; updatedAt?: number },
) {
  return await t.run(async (ctx) => {
    const appId = await ctx.db.insert("externalApps", {
      name: opts.name,
      webUrl: customAppPath(opts.token),
      createdBy: opts.createdBy,
    });
    const customAppId = await ctx.db.insert("customApps", {
      token: opts.token,
      name: opts.name,
      kind: "static",
      status: "live",
      html: HTML,
      externalAppId: appId,
      createdBy: opts.createdBy,
      updatedAt: opts.updatedAt,
    });
    return { appId, customAppId };
  });
}

async function seedScholarApp(
  t: TestClient,
  scholar: WorldScholar,
  opts: {
    title: string;
    activityId?: Id<"activities">;
    revision?: number;
    revisionAt?: number;
    lastMessageAt?: number;
  },
) {
  return await t.run(async (ctx) => {
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholar.id,
      institutionId: scholar.institutionId,
      title: opts.title,
      sessionMode: "vibecode",
      isArchived: false,
      activityId: opts.activityId,
      lastMessageAt: opts.lastMessageAt,
    });
    const artifactId = await ctx.db.insert("artifacts", {
      sessionId,
      title: opts.title,
      content: HTML,
      lastEditedBy: "ai",
      type: "code",
      language: "html",
      ...(opts.revision === undefined ? {} : { revision: opts.revision }),
    });
    if (opts.revision !== undefined && opts.revisionAt !== undefined) {
      await ctx.db.insert("codeArtifactRevisions", {
        sessionId,
        artifactId,
        revision: opts.revision,
        html: HTML,
        createdAt: opts.revisionAt,
      });
    }
    return sessionId;
  });
}

describe("listAppsWithAudiences: sort and learning-contract fields", () => {
  test("createdAt, lastEditedAt and hasLearningContract per catalog row", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { schools: 1 });
    const [moli] = world.schools;
    const webId = await t.run((ctx) =>
      ctx.db.insert("externalApps", {
        name: "Acme Practice",
        webUrl: "https://acmepractice.example.com",
        createdBy: moli.teacher.id,
      }),
    );
    const contracted = await seedCustomApp(t, {
      name: "Fraction Wall",
      token: "tok-contract",
      createdBy: moli.teacher.id,
      updatedAt: 1_700_000_000_000,
    });
    const plain = await seedCustomApp(t, {
      name: "Free Draw",
      token: "tok-plain",
      createdBy: moli.teacher.id,
    });
    const retired = await seedCustomApp(t, {
      name: "Retired Game",
      token: "tok-retired",
      createdBy: moli.teacher.id,
      updatedAt: 1_600_000_000_000,
    });
    const unitId = await makeUnit(t, moli.teacher, moli);
    const lessonId = await makeLesson(t, unitId);
    await makeActivity(t, lessonId, {
      starterAppId: contracted.customAppId,
      buildContract: CONTRACT,
    });
    await makeActivity(t, lessonId, { starterAppId: plain.customAppId });
    // Only an archived activity carries the contract: it no longer counts.
    await makeActivity(t, lessonId, {
      starterAppId: retired.customAppId,
      buildContract: CONTRACT,
      archivedAt: 1_700_000_000_000,
    });

    const asTeacher = await world.as.staffOf(moli);
    const rows = await asTeacher.query(api.appAudiences.listAppsWithAudiences, {});
    const row = (id: Id<"externalApps">) => rows.find((r) => r._id === id)!;
    const createdAt = await t.run(async (ctx) => (await ctx.db.get(webId))!._creationTime);

    expect(row(webId)).toMatchObject({
      createdAt,
      lastEditedAt: null,
      hasLearningContract: false,
    });
    expect(row(contracted.appId)).toMatchObject({
      lastEditedAt: 1_700_000_000_000,
      hasLearningContract: true,
    });
    // No updatedAt (legacy): the custom-app row's own creation stands in.
    const plainCreated = await t.run(
      async (ctx) => (await ctx.db.get(plain.customAppId))!._creationTime,
    );
    expect(row(plain.appId)).toMatchObject({
      lastEditedAt: plainCreated,
      hasLearningContract: false,
    });
    expect(row(retired.appId).hasLearningContract).toBe(false);
  });
});

describe("listForScholars: edit time, learning contract, oldest first", () => {
  async function seedWorld(t: TestClient) {
    const world = await makeWorld(t, { schools: 1, scholarsPerSchool: 2 });
    const [moli] = world.schools;
    const unitId = await makeUnit(t, moli.teacher, moli);
    const lessonId = await makeLesson(t, unitId);
    const contractActivity = await makeActivity(t, lessonId, {
      title: "Build a fraction wall",
      appActivity: true,
      buildContract: CONTRACT,
    });
    const first = await seedScholarApp(t, moli.scholars[0], {
      title: "Wall of Fractions",
      activityId: contractActivity,
      revision: 3,
      revisionAt: 1_700_000_500_000,
      lastMessageAt: 1_700_000_900_000,
    });
    const second = await seedScholarApp(t, moli.scholars[1], {
      title: "Lava Racer",
      lastMessageAt: 1_700_000_100_000,
    });
    return { world, moli, first, second };
  }

  test("lastEditedAt reads the current revision's row, else last activity", async () => {
    const t = convexTest(schema, modules);
    const { world, moli, first, second } = await seedWorld(t);
    const asTeacher = await world.as.staffOf(moli);
    const { page } = await asTeacher.query(api.scholarBuiltApps.listForScholars, {
      scholarIds: moli.scholars.map((s) => s.id),
      archived: false,
      paginationOpts: PAGE,
    });
    const card = (id: Id<"sessions">) => page.find((c) => c.sessionId === id)!;
    expect(card(first).lastEditedAt).toBe(1_700_000_500_000);
    expect(card(first).lastActiveAt).toBe(1_700_000_900_000);
    expect(card(second).lastEditedAt).toBe(1_700_000_100_000);
    expect(card(first).hasLearningContract).toBe(true);
    expect(card(second).hasLearningContract).toBe(false);
  });

  test("learningContract filters while paging; order asc walks oldest first", async () => {
    const t = convexTest(schema, modules);
    const { world, moli, first, second } = await seedWorld(t);
    const asTeacher = await world.as.staffOf(moli);
    const base = {
      scholarIds: moli.scholars.map((s) => s.id),
      archived: false,
      paginationOpts: PAGE,
    };
    const ids = async (args: Partial<{ order: "asc" | "desc"; learningContract: "with" | "without" }>) =>
      (await asTeacher.query(api.scholarBuiltApps.listForScholars, { ...base, ...args })).page.map(
        (c) => c.sessionId,
      );

    expect(await ids({})).toEqual([second, first]);
    expect(await ids({ order: "asc" })).toEqual([first, second]);
    expect(await ids({ learningContract: "with" })).toEqual([first]);
    expect(await ids({ learningContract: "without" })).toEqual([second]);
  });

  test("oldest-first pages forward with the cursor", async () => {
    const t = convexTest(schema, modules);
    const { world, moli, first, second } = await seedWorld(t);
    const asTeacher = await world.as.staffOf(moli);
    const base = {
      scholarIds: moli.scholars.map((s) => s.id),
      archived: false,
      order: "asc" as const,
    };
    const one = await asTeacher.query(api.scholarBuiltApps.listForScholars, {
      ...base,
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(one.page.map((c) => c.sessionId)).toEqual([first]);
    expect(one.isDone).toBe(false);
    const two = await asTeacher.query(api.scholarBuiltApps.listForScholars, {
      ...base,
      paginationOpts: { numItems: 1, cursor: one.continueCursor },
    });
    expect(two.page.map((c) => c.sessionId)).toEqual([second]);
  });
});
