import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { makeExternalAppsTools } from "../lib/externalAppsTools";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

// "Make Pumpkin Physics Lab available to the group all day" (prod, 2026-10-30).
// The aide could only say that as one app placement per block, so the grid
// stacked a copy in every row and scholars lost the app between blocks. Now
// enable_app_for_group takes a `throughDay`: each member gets the
// single-scholar day add (openForScholar's core, TRA-444), which ends at the
// midnight after that day in the school's zone. These drive the real tool.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const _makeTestClient = () => convexTest(schema, modules);
type TestClient = ReturnType<typeof _makeTestClient>;

const TZ = "Pacific/Honolulu"; // no DST
const DAY = 24 * 60 * 60_000;
const hst = (local: string) => Date.parse(`${local}-10:00`);
const MONDAY_9AM = hst("2026-09-28T09:00:00");
const TUESDAY_MIDNIGHT = hst("2026-09-29T00:00:00");

function actionCtxFor(t: TestClient): ActionCtx {
  return {
    runQuery: (ref: unknown, args: unknown) =>
      (t as unknown as { query: (r: unknown, a: unknown) => Promise<unknown> }).query(ref, args),
    runMutation: (ref: unknown, args: unknown) =>
      (t as unknown as { mutation: (r: unknown, a: unknown) => Promise<unknown> }).mutation(ref, args),
  } as unknown as ActionCtx;
}

async function withUser(t: TestClient, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 30 * DAY }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

type Tool = {
  run: (input: unknown) => Promise<string>;
  input_schema: { properties: Record<string, unknown> };
};

async function toolsFor(t: TestClient, callerUserId: Id<"users">) {
  const tools = await makeExternalAppsTools(actionCtxFor(t), () => {}, {
    role: "teacher",
    callerUserId,
  });
  return Object.fromEntries(tools.map((tl) => [tl.name, tl])) as unknown as Record<string, Tool>;
}

/** One Honolulu school: a teacher, a two-scholar group, and one app. */
async function seedWorld(t: TestClient) {
  const institutionId = await seedTestInstitution(t, { name: "Moli School", slug: "moli", isPrimary: true });
  const teacherId = await seedStaffWithMembership(t, {
    institutionId,
    role: "teacher",
    name: "Sloane Kahale",
    username: "sloane-day",
  });
  const kai = await seedScholarInInstitution(t, { institutionId, name: "Kai Kahale", username: "kai-day" });
  const noe = await seedScholarInInstitution(t, { institutionId, name: "Noe Akana", username: "noe-day" });
  const ids = await t.run(async (ctx) => {
    await ctx.db.patch(institutionId, { timeZone: TZ });
    const appId = await ctx.db.insert("externalApps", {
      name: "Pumpkin Physics Lab",
      webUrl: "https://pumpkin.example.com",
    });
    const groupId = await ctx.db.insert("scholarGroups", {
      teacherId,
      institutionId,
      name: "Geckos",
      scholarIds: [kai, noe],
    });
    return { appId, groupId };
  });
  return { institutionId, teacherId, kai, noe, ...ids, tools: await toolsFor(t, teacherId) };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

async function row(t: TestClient, w: World, scholarId: Id<"users">) {
  return await t.run((ctx) =>
    ctx.db
      .query("scholarApps")
      .withIndex("by_scholar_app", (q) => q.eq("scholarId", scholarId).eq("appId", w.appId))
      .unique(),
  );
}

async function groupGrants(t: TestClient, w: World) {
  return await t.run((ctx) =>
    ctx.db
      .query("appAudiences")
      .withIndex("by_audience", (q) => q.eq("audienceKind", "group").eq("audienceId", w.groupId))
      .collect(),
  );
}

async function tile(t: TestClient, w: World, scholarId: Id<"users">) {
  const asScholar = await withUser(t, scholarId);
  return (await asScholar.query(api.scholarApps.listForLauncher, { now: Date.now() })).some(
    (r) => r.appId === w.appId,
  );
}

const allDay = (w: World, extra: Record<string, unknown> = {}) =>
  w.tools.enable_app_for_group.run({
    appName: "Pumpkin Physics Lab",
    groupName: "Geckos",
    throughDay: "today",
    ...extra,
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(MONDAY_9AM);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("enable_app_for_group with throughDay — a group's app for one day", () => {
  test("the enable tool offers throughDay; the disable tool does not", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    expect(w.tools.enable_app_for_group.input_schema.properties).toHaveProperty("throughDay");
    expect(w.tools.disable_app_for_group.input_schema.properties).not.toHaveProperty("throughDay");
  });

  test("'today' opens it to every member until the school's midnight, with no group row", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const res = JSON.parse(await allDay(w));
    expect(res).toMatchObject({
      enabled: true,
      standingGroupGrant: false,
      throughDay: "2026-09-28",
      scholarCount: 2,
      keptLonger: 0,
    });
    for (const id of [w.kai, w.noe]) {
      expect(await row(t, w, id)).toMatchObject({
        enabled: true,
        source: "manual",
        addedBy: w.teacherId,
        expiresAt: TUESDAY_MIDNIGHT,
      });
    }
    // Not a standing grant: nothing in appAudiences to outlive the day.
    expect(await groupGrants(t, w)).toHaveLength(0);
    const jobs = (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter(
      (job) => job.name.includes("expireDirectGrant") && job.state.kind === "pending",
    );
    expect(jobs.map((job) => job.scheduledTime)).toEqual([TUESDAY_MIDNIGHT, TUESDAY_MIDNIGHT]);
  });

  test("available through the day, gone the next school day", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await allDay(w);
    // Lunch, the passing time after it, and the last minute of the day.
    for (const local of ["2026-09-28T11:45:00", "2026-09-28T13:02:00", "2026-09-28T23:59:00"]) {
      vi.setSystemTime(hst(local));
      expect(await tile(t, w, w.kai)).toBe(true);
    }
    vi.setSystemTime(hst("2026-09-29T08:00:00"));
    expect(await tile(t, w, w.kai)).toBe(false);
    expect(await tile(t, w, w.noe)).toBe(false);
  });

  test("today is the school's day, not the server's", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    // 23:30 on Monday in Honolulu is already Tuesday in UTC.
    vi.setSystemTime(hst("2026-09-28T23:30:00"));
    const res = JSON.parse(await allDay(w));
    expect(res.throughDay).toBe("2026-09-28");
    expect((await row(t, w, w.kai))?.expiresAt).toBe(TUESDAY_MIDNIGHT);
  });

  test("a later day runs through it; a past or malformed day is refused", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const res = JSON.parse(await allDay(w, { throughDay: "2026-10-02" }));
    expect(res.throughDay).toBe("2026-10-02");
    expect((await row(t, w, w.noe))?.expiresAt).toBe(hst("2026-10-03T00:00:00"));
    expect(await allDay(w, { throughDay: "2026-09-27" })).toMatch(/Pick today or a later day/);
    expect(await allDay(w, { throughDay: "Friday" })).toMatch(/not a day/);
  });

  test("never shortens: a member's standing add or a standing group grant is left alone", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asTeacher = await withUser(t, w.teacherId);
    await asTeacher.mutation(api.scholarApps.addToScholar, { scholarId: w.kai, appId: w.appId });
    const res = JSON.parse(await allDay(w));
    expect(res).toMatchObject({ scholarCount: 1, keptLonger: 1 });
    expect((await row(t, w, w.kai))?.expiresAt).toBeUndefined();
    expect((await row(t, w, w.noe))?.expiresAt).toBe(TUESDAY_MIDNIGHT);

    const t2 = convexTest(schema, modules);
    const w2 = await seedWorld(t2);
    await w2.tools.enable_app_for_group.run({ appName: "Pumpkin Physics Lab", groupName: "Geckos" });
    const again = JSON.parse(await allDay(w2));
    expect(again).toMatchObject({ standingGroupGrant: true, scholarCount: 0 });
    expect(await row(t2, w2, w2.kai)).toBeNull();
  });

  test("without throughDay the grant is still the standing group grant", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const res = JSON.parse(
      await w.tools.enable_app_for_group.run({ appName: "Pumpkin Physics Lab", groupName: "Geckos" }),
    );
    expect(res).toMatchObject({ enabled: true, memberCount: 2 });
    expect(await groupGrants(t, w)).toHaveLength(1);
    expect(await row(t, w, w.kai)).toBeNull();
  });

  test("disable_app_for_group ends the day grant but keeps a standing direct add", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asTeacher = await withUser(t, w.teacherId);
    await asTeacher.mutation(api.scholarApps.addToScholar, { scholarId: w.kai, appId: w.appId });
    await allDay(w);
    const res = JSON.parse(
      await w.tools.disable_app_for_group.run({ appName: "Pumpkin Physics Lab", groupName: "Geckos" }),
    );
    expect(res).toMatchObject({ enabled: false, dayAddsRemoved: 1 });
    expect(await row(t, w, w.noe)).toBeNull();
    expect(await row(t, w, w.kai)).toMatchObject({ enabled: true });
    expect(await tile(t, w, w.noe)).toBe(false);
  });

  test("another school's teacher can't open it for the group", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const otherSchool = await seedTestInstitution(t, { name: "Kaimana School", slug: "kaimana" });
    const outsider = await seedStaffWithMembership(t, {
      institutionId: otherSchool,
      role: "teacher",
      name: "Lehua Torres",
      username: "lehua-day",
    });
    const tools = await toolsFor(t, outsider);
    const out = await tools.enable_app_for_group.run({
      appName: "Pumpkin Physics Lab",
      groupName: "Geckos",
      throughDay: "today",
    });
    expect(out).toMatch(/No group matches/);
    expect(await row(t, w, w.kai)).toBeNull();
    expect(await row(t, w, w.noe)).toBeNull();
  });
});

// Copilot on PR #4539 (TRA-636): nothing recorded which rows a group's day
// opening wrote, so its disable guessed by shape and took a member's own timed
// add, and ending a promoted row deleted the login it had parked.
describe("disable_app_for_group undoes only what the group's day opening wrote", () => {
  const disable = (w: World) =>
    w.tools.disable_app_for_group.run({ appName: "Pumpkin Physics Lab", groupName: "Geckos" });
  const FRIDAY_END = hst("2026-10-03T00:00:00");

  test("a member's own add through Friday survives the group's day opening and its disable", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asTeacher = await withUser(t, w.teacherId);
    await asTeacher.mutation(api.scholarApps.openForScholar, {
      scholarId: w.kai,
      appId: w.appId,
      throughDay: "2026-10-02",
    });
    expect(JSON.parse(await allDay(w))).toMatchObject({ scholarCount: 1, keptLonger: 1 });
    const res = JSON.parse(await disable(w));
    expect(res).toMatchObject({ enabled: false, dayAddsRemoved: 1 });
    expect(await row(t, w, w.kai)).toMatchObject({ enabled: true, source: "manual", expiresAt: FRIDAY_END });
    expect(await row(t, w, w.noe)).toBeNull();
    expect(await tile(t, w, w.kai)).toBe(true);
  });

  test("a later teacher add takes the row out of the group's hands", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await allDay(w);
    const asTeacher = await withUser(t, w.teacherId);
    await asTeacher.mutation(api.scholarApps.openForScholar, {
      scholarId: w.kai,
      appId: w.appId,
      throughDay: "2026-10-02",
    });
    expect((await row(t, w, w.kai))?.openedForGroupId).toBeUndefined();
    expect(JSON.parse(await disable(w))).toMatchObject({ dayAddsRemoved: 1 });
    expect(await row(t, w, w.kai)).toMatchObject({ expiresAt: FRIDAY_END });
  });

  test("a standing group's disable leaves members' timed individual adds alone", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asTeacher = await withUser(t, w.teacherId);
    await asTeacher.mutation(api.scholarApps.openForScholar, { scholarId: w.kai, appId: w.appId });
    await w.tools.enable_app_for_group.run({ appName: "Pumpkin Physics Lab", groupName: "Geckos" });
    const res = JSON.parse(await disable(w));
    expect(res).toMatchObject({ removed: 1, dayAddsRemoved: 0 });
    expect(await row(t, w, w.kai)).toMatchObject({ enabled: true, expiresAt: TUESDAY_MIDNIGHT });
    expect(await tile(t, w, w.kai)).toBe(true);
  });

  test("a paused default row the day opening re-enabled goes with the disable", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await t.run((ctx) =>
      ctx.db.insert("scholarApps", { scholarId: w.kai, appId: w.appId, enabled: false, source: "default" }),
    );
    await allDay(w);
    expect(await row(t, w, w.kai)).toMatchObject({ enabled: true, source: "default", openedForGroupId: w.groupId });
    expect(JSON.parse(await disable(w))).toMatchObject({ dayAddsRemoved: 2 });
    expect(await tile(t, w, w.kai)).toBe(false);
  });

  /** Kai's login parked under a standing group grant, then the grant removed. */
  async function parkedLoginWithoutGrant(t: TestClient, w: World) {
    const asTeacher = await withUser(t, w.teacherId);
    await w.tools.enable_app_for_group.run({ appName: "Pumpkin Physics Lab", groupName: "Geckos" });
    await asTeacher.mutation(api.scholarApps.setCredentials, {
      scholarId: w.kai,
      appId: w.appId,
      username: "kai.k",
      password: "pumpkin-pie",
    });
    await disable(w);
    expect(await row(t, w, w.kai)).toMatchObject({ source: "grant", loginUsername: "kai.k" });
    await allDay(w);
    expect(await row(t, w, w.kai)).toMatchObject({
      source: "manual",
      expiresAt: TUESDAY_MIDNIGHT,
      openedForGroupId: w.groupId,
      loginUsername: "kai.k",
    });
  }
  const parkedAgain = {
    enabled: true,
    source: "grant",
    loginUsername: "kai.k",
    loginPassword: "pumpkin-pie",
  };
  async function expectParkedAgain(t: TestClient, w: World) {
    const link = await row(t, w, w.kai);
    expect(link).toMatchObject(parkedAgain);
    // The end, the group marker and the promotion flag belonged to the add.
    expect(link?.expiresAt).toBeUndefined();
    expect(link?.openedForGroupId).toBeUndefined();
    expect(link?.promotedFromParkedLogin).toBeUndefined();
  }

  test("disabling the day opening parks a saved login again instead of deleting it", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await parkedLoginWithoutGrant(t, w);
    expect(JSON.parse(await disable(w))).toMatchObject({ dayAddsRemoved: 2 });
    await expectParkedAgain(t, w);
    expect(await tile(t, w, w.kai)).toBe(false);
  });

  test("the midnight expiry parks a saved login again instead of deleting it", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await parkedLoginWithoutGrant(t, w);
    const link = await row(t, w, w.kai);
    vi.setSystemTime(TUESDAY_MIDNIGHT + 60_000);
    await t.mutation(internal.scholarApps.expireDirectGrant, {
      scholarAppId: link!._id,
      expiresAt: TUESDAY_MIDNIGHT,
    });
    await expectParkedAgain(t, w);
    expect(await tile(t, w, w.kai)).toBe(false);
  });
});
