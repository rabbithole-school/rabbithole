// Teacher Apps v2 (review/teacher-apps-v2-sketch.html): the "Built by
// scholars" read (scholarBuiltApps.listForScholars) and the scope picker +
// timed-access additions to appAudiences.listAppsWithAudiences.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = ReturnType<typeof convexTest>;

async function asUser(t: T, userId: Id<"users">) {
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

const HTML = "<html><body>app</body></html>";

async function seedSchool(t: T) {
  const institutionId = await seedTestInstitution(t);
  const otherInstitutionId = await seedTestInstitution(t, {
    slug: "other-school",
    name: "Other School",
  });
  const teacherId = await seedStaffWithMembership(t, {
    institutionId,
    name: "Avery Stone",
    username: "avery-stone",
  });
  const otherTeacherId = await seedStaffWithMembership(t, {
    institutionId: otherInstitutionId,
    username: "other-teacher",
  });
  const scholarId = await seedScholarInInstitution(t, {
    institutionId,
    name: "Hoku Makani",
    username: "hoku",
  });
  const secondScholarId = await seedScholarInInstitution(t, {
    institutionId,
    name: "Lehua Torres",
    username: "lehua",
  });
  return {
    institutionId,
    otherInstitutionId,
    teacherId,
    otherTeacherId,
    scholarId,
    secondScholarId,
  };
}

async function seedApp(
  t: T,
  args: {
    userId: Id<"users">;
    institutionId: Id<"institutions">;
    title: string;
    revision: number | undefined;
    starterAppId?: Id<"customApps">;
    lastMessageAt?: number;
    extra?: {
      freePlay?: boolean;
      freePlayOf?: Id<"sessions">;
      teacherArchivedAt?: number;
      isTestDrive?: boolean;
    };
  },
) {
  return await t.run(async (ctx) => {
    let activityId: Id<"activities"> | undefined;
    if (args.starterAppId) {
      const unitId = await ctx.db.insert("units", {
        teacherId: args.userId,
        title: "Fraction Sense",
        isActive: true,
        institutionId: args.institutionId,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Fractions",
        order: 0,
      });
      activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Frog Jump Fractions",
        kind: "vibecode",
        order: 0,
        starterAppId: args.starterAppId,
        scholarsStartFrom: "starter",
      });
    }
    const sessionId = await ctx.db.insert("sessions", {
      userId: args.userId,
      institutionId: args.institutionId,
      title: args.title,
      sessionMode: "vibecode",
      isArchived: args.extra?.teacherArchivedAt != null,
      activityId,
      lastMessageAt: args.lastMessageAt,
      ...(args.starterAppId ? { vibecodeStarterUsedAt: 1 } : {}),
      ...(args.extra?.freePlayOf ? { freePlay: true } : {}),
      ...(args.extra ?? {}),
    });
    await ctx.db.insert("artifacts", {
      sessionId,
      title: args.title,
      content: HTML,
      lastEditedBy: "ai",
      ...(args.revision === undefined ? {} : { revision: args.revision }),
      type: "code",
      language: "html",
    });
    return sessionId;
  });
}

const PAGE = { numItems: 50, cursor: null };

describe("scholarBuiltApps.listForScholars", () => {
  async function seedStarter(t: T, createdBy: Id<"users">) {
    return await t.run((ctx) =>
      ctx.db.insert("customApps", {
        token: `starter-${createdBy}`,
        name: "Frog Jump",
        kind: "static",
        status: "live",
        html: HTML,
        origin: "starter",
        createdBy,
        updatedAt: 1,
      }),
    );
  }

  test("lists changed apps newest first, hides an untouched starter copy and rehearsals", async () => {
    const t = convexTest(schema, modules);
    const w = await seedSchool(t);
    const starterAppId = await seedStarter(t, w.teacherId);
    await seedApp(t, {
      userId: w.scholarId,
      institutionId: w.institutionId,
      title: "Untouched copy",
      revision: 0,
      starterAppId,
    });
    const changed = await seedApp(t, {
      userId: w.scholarId,
      institutionId: w.institutionId,
      title: "Frog Jump Fractions",
      revision: 2,
      starterAppId,
    });
    // A legacy copy that predates revision stamping stays visible.
    const legacy = await seedApp(t, {
      userId: w.scholarId,
      institutionId: w.institutionId,
      title: "Legacy copy",
      revision: undefined,
      starterAppId,
    });
    const own = await seedApp(t, {
      userId: w.secondScholarId,
      institutionId: w.institutionId,
      title: "Star Painter",
      revision: 0,
    });
    const archived = await seedApp(t, {
      userId: w.scholarId,
      institutionId: w.institutionId,
      title: "Bow Clicker",
      revision: 4,
      extra: { teacherArchivedAt: 50 },
    });
    // A rehearsal is not a scholar's build, and a chat holds no app.
    await seedApp(t, {
      userId: w.scholarId,
      institutionId: w.institutionId,
      title: "Rehearsal",
      revision: 3,
      extra: { isTestDrive: true },
    });
    await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: w.scholarId,
        institutionId: w.institutionId,
        title: "Just a chat",
        isArchived: false,
      }),
    );

    const asTeacher = await asUser(t, w.teacherId);
    const both = [w.scholarId, w.secondScholarId];
    const active = await asTeacher.query(api.scholarBuiltApps.listForScholars, {
      scholarIds: both,
      archived: false,
      paginationOpts: PAGE,
    });
    expect(active.page.map((a) => a.sessionId)).toEqual([own, legacy, changed]);
    expect(active.page[2].fromStarter).toEqual({
      starterName: "Frog Jump",
      teacherName: "Avery Stone",
    });
    expect(active.page[2].activityTitle).toBe("Frog Jump Fractions");
    expect(active.page[0].fromStarter).toBeNull();
    expect(active.page[0].builder.name).toBe("Lehua Torres");

    const archivedPage = await asTeacher.query(
      api.scholarBuiltApps.listForScholars,
      { scholarIds: both, archived: true, paginationOpts: PAGE },
    );
    expect(archivedPage.page.map((a) => a.sessionId)).toEqual([archived]);
    expect(archivedPage.page[0].archivedAt).toBe(50);

    // Narrowed to one scholar (the per-scholar index), the other drops out.
    const one = await asTeacher.query(api.scholarBuiltApps.listForScholars, {
      scholarIds: [w.scholarId],
      archived: false,
      paginationOpts: PAGE,
    });
    expect(one.page.map((a) => a.sessionId)).toEqual([legacy, changed]);
  });

  test("a free build in a chat-primary session counts; a non-app activity's code does not", async () => {
    const t = convexTest(schema, modules);
    const w = await seedSchool(t);
    const { chatBuild } = await t.run(async (ctx) => {
      // A free build: no activity, no builder-primary sessionMode.
      const chatBuild = await ctx.db.insert("sessions", {
        userId: w.scholarId,
        institutionId: w.institutionId,
        title: "Chat about volcanoes",
        isArchived: false,
      });
      await ctx.db.insert("artifacts", {
        sessionId: chatBuild,
        title: "Volcano Quiz",
        content: HTML,
        lastEditedBy: "ai",
        revision: 1,
        type: "code",
      });
      // A code artifact in an ordinary (non-app) activity is not an app.
      const unitId = await ctx.db.insert("units", {
        teacherId: w.teacherId,
        title: "Essays",
        isActive: true,
        institutionId: w.institutionId,
      });
      const lessonId = await ctx.db.insert("lessons", { unitId, title: "L", order: 0 });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Write an essay",
        kind: "online",
        order: 0,
      });
      const essay = await ctx.db.insert("sessions", {
        userId: w.scholarId,
        institutionId: w.institutionId,
        title: "Essay",
        isArchived: false,
        activityId,
      });
      await ctx.db.insert("artifacts", {
        sessionId: essay,
        title: "Essay canvas",
        content: HTML,
        lastEditedBy: "scholar",
        revision: 1,
        type: "code",
      });
      return { chatBuild };
    });
    const asTeacher = await asUser(t, w.teacherId);
    for (const scholarIds of [[w.scholarId], [w.scholarId, w.secondScholarId]]) {
      const apps = await asTeacher.query(api.scholarBuiltApps.listForScholars, {
        scholarIds,
        archived: false,
        paginationOpts: PAGE,
      });
      expect(apps.page.map((a) => a.sessionId)).toEqual([chatBuild]);
      expect(apps.page[0].activityTitle).toBeNull();
    }
  });

  test("one card per free-play lineage: the newest copy", async () => {
    const t = convexTest(schema, modules);
    const w = await seedSchool(t);
    const source = await seedApp(t, {
      userId: w.scholarId,
      institutionId: w.institutionId,
      title: "Lava Runner",
      revision: 5,
    });
    const copy = await seedApp(t, {
      userId: w.scholarId,
      institutionId: w.institutionId,
      title: "Lava Runner",
      revision: 0,
      extra: { freePlayOf: source },
    });
    const asTeacher = await asUser(t, w.teacherId);
    const apps = await asTeacher.query(api.scholarBuiltApps.listForScholars, {
      scholarIds: [w.scholarId],
      archived: false,
      paginationOpts: PAGE,
    });
    expect(apps.page.map((a) => a.sessionId)).toEqual([copy]);
  });

  test("pages through app sessions", async () => {
    const t = convexTest(schema, modules);
    const w = await seedSchool(t);
    for (const title of ["One", "Two", "Three"]) {
      await seedApp(t, {
        userId: w.scholarId,
        institutionId: w.institutionId,
        title,
        revision: 1,
      });
    }
    const asTeacher = await asUser(t, w.teacherId);
    const first = await asTeacher.query(api.scholarBuiltApps.listForScholars, {
      scholarIds: [w.scholarId, w.secondScholarId],
      archived: false,
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page.map((a) => a.title)).toEqual(["Three", "Two"]);
    expect(first.isDone).toBe(false);
    const second = await asTeacher.query(api.scholarBuiltApps.listForScholars, {
      scholarIds: [w.scholarId, w.secondScholarId],
      archived: false,
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page.map((a) => a.title)).toEqual(["One"]);
  });

  test("pages over the scope's school: another school's newer apps never crowd a page", async () => {
    const t = convexTest(schema, modules);
    const w = await seedSchool(t);
    const ours: Id<"sessions">[] = [];
    for (const title of ["Ours 1", "Ours 2", "Ours 3"]) {
      ours.push(
        await seedApp(t, {
          userId: w.scholarId,
          institutionId: w.institutionId,
          title,
          revision: 1,
        }),
      );
    }
    const foreignScholarId = await seedScholarInInstitution(t, {
      institutionId: w.otherInstitutionId,
      name: "Koa Medeiros",
      username: "koa",
    });
    for (let i = 0; i < 6; i++) {
      await seedApp(t, {
        userId: foreignScholarId,
        institutionId: w.otherInstitutionId,
        title: `Theirs ${i}`,
        revision: 1,
      });
    }
    const asTeacher = await asUser(t, w.teacherId);
    const scope = [w.scholarId, w.secondScholarId];
    const first = await asTeacher.query(api.scholarBuiltApps.listForScholars, {
      scholarIds: scope,
      archived: false,
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page.map((a) => a.sessionId)).toEqual([ours[2], ours[1]]);
    expect(first.isDone).toBe(false);
    const second = await asTeacher.query(api.scholarBuiltApps.listForScholars, {
      scholarIds: scope,
      archived: false,
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page.map((a) => a.sessionId)).toEqual([ours[0]]);
    expect(second.isDone).toBe(true);
  });

  test("pages one scholar's apps", async () => {
    const t = convexTest(schema, modules);
    const w = await seedSchool(t);
    for (const title of ["One", "Two", "Three"]) {
      await seedApp(t, {
        userId: w.scholarId,
        institutionId: w.institutionId,
        title,
        revision: 1,
      });
    }
    await seedApp(t, {
      userId: w.secondScholarId,
      institutionId: w.institutionId,
      title: "Someone else's",
      revision: 1,
    });
    const asTeacher = await asUser(t, w.teacherId);
    const first = await asTeacher.query(api.scholarBuiltApps.listForScholars, {
      scholarIds: [w.scholarId],
      archived: false,
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page.map((a) => a.title)).toEqual(["Three", "Two"]);
    expect(first.isDone).toBe(false);
    const second = await asTeacher.query(api.scholarBuiltApps.listForScholars, {
      scholarIds: [w.scholarId],
      archived: false,
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    expect(second.page.map((a) => a.title)).toEqual(["One"]);
    expect(second.isDone).toBe(true);
  });

  test("a page stops at the scan budget and hands back a cursor", async () => {
    const t = convexTest(schema, modules);
    const w = await seedSchool(t);
    const older = await seedApp(t, {
      userId: w.scholarId,
      institutionId: w.institutionId,
      title: "Under a pile of chats",
      revision: 1,
    });
    await t.run(async (ctx) => {
      for (let i = 0; i < 310; i++) {
        await ctx.db.insert("sessions", {
          userId: w.scholarId,
          institutionId: w.institutionId,
          title: `Chat ${i}`,
          isArchived: false,
        });
      }
    });
    const asTeacher = await asUser(t, w.teacherId);
    const scope = [w.scholarId, w.secondScholarId];
    const first = await asTeacher.query(api.scholarBuiltApps.listForScholars, {
      scholarIds: scope,
      archived: false,
      paginationOpts: { numItems: 30, cursor: null },
    });
    expect(first.page).toEqual([]);
    expect(first.isDone).toBe(false);
    const second = await asTeacher.query(api.scholarBuiltApps.listForScholars, {
      scholarIds: scope,
      archived: false,
      paginationOpts: { numItems: 30, cursor: first.continueCursor },
    });
    expect(second.page.map((a) => a.sessionId)).toEqual([older]);
    expect(second.isDone).toBe(true);
  });

  test("the app is the first code artifact with code in it", async () => {
    const t = convexTest(schema, modules);
    const w = await seedSchool(t);
    await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("sessions", {
        userId: w.scholarId,
        institutionId: w.institutionId,
        title: "Free build",
        isArchived: false,
      });
      await ctx.db.insert("artifacts", {
        sessionId,
        title: "Empty canvas",
        content: "",
        lastEditedBy: "scholar",
        type: "code",
      });
      await ctx.db.insert("artifacts", {
        sessionId,
        title: "Comet Catcher",
        content: HTML,
        lastEditedBy: "ai",
        revision: 2,
        type: "code",
      });
    });
    const asTeacher = await asUser(t, w.teacherId);
    const apps = await asTeacher.query(api.scholarBuiltApps.listForScholars, {
      scholarIds: [w.scholarId],
      archived: false,
      paginationOpts: PAGE,
    });
    expect(apps.page.map((a) => a.title)).toEqual(["Comet Catcher"]);
  });

  test("refuses another school's teacher and a non-teacher", async () => {
    const t = convexTest(schema, modules);
    const w = await seedSchool(t);
    await seedApp(t, {
      userId: w.scholarId,
      institutionId: w.institutionId,
      title: "Lava Runner",
      revision: 1,
    });
    const args = {
      scholarIds: [w.scholarId],
      archived: false,
      paginationOpts: PAGE,
    };
    const asOther = await asUser(t, w.otherTeacherId);
    await expect(
      asOther.query(api.scholarBuiltApps.listForScholars, args),
    ).rejects.toThrow(/Forbidden/);
    const asScholar = await asUser(t, w.scholarId);
    await expect(
      asScholar.query(api.scholarBuiltApps.listForScholars, args),
    ).rejects.toThrow();
  });
});

describe("appAudiences.listAppsWithAudiences scope + timed access", () => {
  async function seedCatalog(t: T, w: Awaited<ReturnType<typeof seedSchool>>) {
    return await t.run(async (ctx) => {
      const groupId = await ctx.db.insert("scholarGroups", {
        teacherId: w.teacherId,
        institutionId: w.institutionId,
        name: "Seals",
        scholarIds: [w.scholarId],
      });
      const groupApp = await ctx.db.insert("externalApps", {
        name: "Group app",
        webUrl: "https://group.example.com/",
      });
      const directApp = await ctx.db.insert("externalApps", {
        name: "Direct app",
        webUrl: "https://direct.example.com/",
      });
      const pushedApp = await ctx.db.insert("externalApps", {
        name: "Pushed app",
        webUrl: "https://pushed.example.com/",
      });
      await ctx.db.insert("appAudiences", {
        appId: groupApp,
        audienceKind: "group",
        audienceId: String(groupId),
        enabled: true,
      });
      await ctx.db.insert("scholarApps", {
        scholarId: w.secondScholarId,
        appId: directApp,
        enabled: true,
        source: "manual",
        expiresAt: 10_000_000,
      });
      return { groupId, groupApp, directApp, pushedApp };
    });
  }

  test("narrows the catalog and reach to the picked scholars", async () => {
    const t = convexTest(schema, modules);
    const w = await seedSchool(t);
    const c = await seedCatalog(t, w);
    const asTeacher = await asUser(t, w.teacherId);

    const whole = await asTeacher.query(
      api.appAudiences.listAppsWithAudiences,
      {},
    );
    expect(whole.map((r) => r.name)).toEqual([
      "Direct app",
      "Group app",
      "Pushed app",
    ]);

    const seals = await asTeacher.query(
      api.appAudiences.listAppsWithAudiences,
      { scholarIds: [w.scholarId] },
    );
    expect(seals.map((r) => r._id)).toEqual([c.groupApp]);

    const lehua = await asTeacher.query(
      api.appAudiences.listAppsWithAudiences,
      { scholarIds: [w.secondScholarId] },
    );
    expect(lehua.map((r) => r._id)).toEqual([c.directApp]);
    expect(lehua[0].directScholarCount).toBe(1);
  });

  test("reports a live grant, a live push and a planned push as timed windows", async () => {
    const t = convexTest(schema, modules);
    const w = await seedSchool(t);
    const c = await seedCatalog(t, w);
    const now = Date.now();
    const asTeacher = await asUser(t, w.teacherId);

    // A planned push for the Seals — the "Next" window.
    await t.run((ctx) =>
      ctx.db.insert("pushes", {
        institutionId: w.institutionId,
        target: { kind: "app", externalAppId: c.pushedApp },
        audience: { kind: "group", groupId: c.groupId },
        timing: { kind: "focus", endsAt: now + 3 * 60 * 60_000 },
        blocking: false,
        pushedBy: w.teacherId,
        startsAt: now + 2 * 60 * 60_000,
      }),
    );
    let rows = await asTeacher.query(api.appAudiences.listAppsWithAudiences, {
      scholarIds: [w.scholarId],
      now,
    });
    const pushed = rows.find((r) => r._id === c.pushedApp);
    expect(pushed?.timed).toMatchObject({
      state: "next",
      source: "push",
      audience: "Seals",
      startsAt: now + 2 * 60 * 60_000,
    });

    // A live push beats the planned one.
    await t.run((ctx) =>
      ctx.db.insert("pushes", {
        institutionId: w.institutionId,
        target: { kind: "app", externalAppId: c.pushedApp },
        audience: { kind: "group", groupId: c.groupId },
        timing: { kind: "focus", endsAt: now + 30 * 60_000 },
        blocking: false,
        pushedBy: w.teacherId,
        setAt: now - 60_000,
      }),
    );
    rows = await asTeacher.query(api.appAudiences.listAppsWithAudiences, {
      scholarIds: [w.scholarId],
      now,
    });
    expect(rows.find((r) => r._id === c.pushedApp)?.timed).toMatchObject({
      state: "live",
      endsAt: now + 30 * 60_000,
    });

    // The pushes cover the Seals only, so another scholar sees neither; their
    // "Open until…" grant is their live window.
    const lehua = await asTeacher.query(api.appAudiences.listAppsWithAudiences, {
      scholarIds: [w.secondScholarId],
      now: 1_000_000,
    });
    expect(lehua.map((r) => r._id)).toEqual([c.directApp]);
    expect(lehua[0].timed).toMatchObject({
      state: "live",
      source: "grant",
      endsAt: 10_000_000,
      audience: "Lehua Torres",
    });
  });

  test("a group scope shows only that group's windows; an ended push shows none", async () => {
    const t = convexTest(schema, modules);
    const w = await seedSchool(t);
    const c = await seedCatalog(t, w);
    const now = Date.now();
    await t.run(async (ctx) => {
      const honu = await ctx.db.insert("scholarGroups", {
        teacherId: w.teacherId,
        institutionId: w.institutionId,
        name: "Honu",
        scholarIds: [w.secondScholarId],
      });
      await ctx.db.insert("pushes", {
        institutionId: w.institutionId,
        target: { kind: "app", externalAppId: c.pushedApp },
        audience: { kind: "group", groupId: honu },
        timing: { kind: "focus", endsAt: now + 30 * 60_000 },
        blocking: false,
        pushedBy: w.teacherId,
        setAt: now - 60_000,
      });
      // Set two days ago, never cleared: no longer on anyone's tile.
      await ctx.db.insert("pushes", {
        institutionId: w.institutionId,
        target: { kind: "app", externalAppId: c.groupApp },
        audience: { kind: "group", groupId: c.groupId },
        timing: { kind: "focus", endsAt: now - 47 * 60 * 60_000 },
        blocking: false,
        pushedBy: w.teacherId,
        setAt: now - 48 * 60 * 60_000,
      });
    });
    const asTeacher = await asUser(t, w.teacherId);

    const seals = await asTeacher.query(api.appAudiences.listAppsWithAudiences, {
      scholarIds: [w.scholarId],
      now,
    });
    // The Honu push doesn't reach the Seals, and the old push is over.
    expect(seals.map((r) => r._id)).toEqual([c.groupApp]);
    expect(seals[0].timed).toBeNull();

    const honu = await asTeacher.query(api.appAudiences.listAppsWithAudiences, {
      scholarIds: [w.secondScholarId],
      now,
    });
    expect(honu.find((r) => r._id === c.pushedApp)?.timed).toMatchObject({
      state: "live",
      audience: "Honu",
    });
  });

  test("the Archived filter lists only archived apps this caller could restore", async () => {
    const t = convexTest(schema, modules);
    const w = await seedSchool(t);
    const foreignScholarId = await seedScholarInInstitution(t, {
      institutionId: w.otherInstitutionId,
      name: "Koa Medeiros",
      username: "koa",
    });
    const { mine, foreign } = await t.run(async (ctx) => {
      const mine = await ctx.db.insert("externalApps", {
        name: "Old typing game",
        webUrl: "https://typing.example.com/",
        archived: true,
        createdBy: w.teacherId,
      });
      const foreign = await ctx.db.insert("externalApps", {
        name: "Other school's app",
        webUrl: "https://other.example.com/",
        archived: true,
        createdBy: w.otherTeacherId,
      });
      await ctx.db.insert("scholarApps", {
        scholarId: foreignScholarId,
        appId: foreign,
        enabled: true,
        source: "manual",
      });
      return { mine, foreign };
    });
    const asTeacher = await asUser(t, w.teacherId);
    const rows = await asTeacher.query(api.appAudiences.listAppsWithAudiences, {
      includeArchived: true,
    });
    const archivedIds = rows.filter((r) => r.archived).map((r) => r._id);
    expect(archivedIds).toEqual([mine]);
    expect(archivedIds).not.toContain(foreign);
  });

  test("drops another school's scholar from the scope", async () => {
    const t = convexTest(schema, modules);
    const w = await seedSchool(t);
    await seedCatalog(t, w);
    const asOther = await asUser(t, w.otherTeacherId);
    const rows = await asOther.query(api.appAudiences.listAppsWithAudiences, {
      scholarIds: [w.secondScholarId],
      now: 1_000_000,
    });
    // The foreign scholar is not in scope, so nothing is reached.
    expect(rows).toEqual([]);
  });
});
