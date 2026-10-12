// A BULK-GRANTED External App must be launchable, not just visible.
//
// `appAudiences` grants are resolved at READ time and never fanned out into
// per-scholar `scholarApps` rows, so a scholar who gets an app through their
// group has NO row for it. Both launch-time gates keyed off that row alone, so
// the tile appeared on the launcher and then the launch failed silently:
// `webActivitySessions.start` threw "App not available to you", killing the
// whole capture pipeline (session, heartbeat, screenshots, teacher card).
// Observed in production 2026-08-19: the "Epic" app was granted to two pods and
// had ZERO webActivitySessions rows to show for it. `credentialsForApp` had the
// same row-only gate; there it bites the "libraryCard" flavour, whose secret
// lives on the user rather than on a per-app row.
//
// These tests pin the launcher rule (`launcherShowsApp`) to all three surfaces
// so tile-visible and launchable cannot drift apart again.
//
// Fixture people come from the documented fictional dev cast — this repo is public.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  seedScholarInInstitution,
  seedTestInstitution,
  seedStaffWithMembership,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const _makeTestClient = () => convexTest(schema, modules);
type TestClient = ReturnType<typeof _makeTestClient>;

async function withUser(t: TestClient, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

/** One school, one teacher, one pod-granted app, one scholar in the pod.
 *  `grant: false` leaves the grant for the test to make. */
async function seedGrantedApp(t: TestClient, { grant = true } = {}) {
  const institutionId = await seedTestInstitution(t, { slug: "moli" });
  const teacherId = await seedStaffWithMembership(t, {
    institutionId,
    role: "teacher",
    name: "Lehua Torres",
    username: "lehua-grantlaunch",
  });
  const scholarId = await seedScholarInInstitution(t, {
    institutionId,
    name: "Kai Kahale",
    username: "kai-grantlaunch",
  });
  const appId = await t.run((ctx) =>
    ctx.db.insert("externalApps", {
      name: "Reading App",
      webUrl: "https://reading.example.com/students",
      webAllowedHosts: ["reading.example.com"],
    }),
  );
  const groupId = await t.run((ctx) =>
    ctx.db.insert("scholarGroups", {
      teacherId,
      institutionId,
      name: "Honu",
      scholarIds: [scholarId],
    }),
  );
  if (grant) {
    await t.run((ctx) =>
      ctx.db.insert("appAudiences", {
        appId,
        audienceKind: "group",
        audienceId: String(groupId),
        enabled: true,
        addedBy: teacherId,
      }),
    );
  }
  return { institutionId, teacherId, scholarId, appId, groupId };
}

describe("bulk-granted External Apps launch", () => {
  test("a group-granted app with NO scholarApps row opens a capture session", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, appId } = await seedGrantedApp(t);
    const asScholar = await withUser(t, scholarId);

    // Precondition: the tile is on the launcher and there is no per-scholar row.
    const tiles = await asScholar.query(api.scholarApps.listForLauncher, {});
    expect(tiles.map((tile) => tile.appId)).toEqual([appId]);
    expect(tiles[0].scholarAppId).toBeNull();

    const { sessionId } = await asScholar.mutation(
      api.webActivitySessions.start,
      { appId },
    );
    const row = await t.run((ctx) => ctx.db.get(sessionId));
    expect(row?.appId).toBe(appId);
    expect(row?.scholarId).toBe(scholarId);
  });

  test("a group-granted LIBRARY-CARD app still offers its autofill", async () => {
    // The per-app row is what a "scholarApp" credential is parked on, so that
    // flavour happened to survive the row-only gate. A "libraryCard" app keeps
    // its secret on `users.libraryCredential` instead, so a grant-only scholar
    // has no row at all — and the old gate silently dropped their 🔑 autofill.
    const t = convexTest(schema, modules);
    const { scholarId, appId } = await seedGrantedApp(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(appId, { credentialSource: "libraryCard" });
      await ctx.db.patch(scholarId, {
        libraryCredential: { id: "29001000123456", password: "1234" },
      });
    });

    const asScholar = await withUser(t, scholarId);
    const creds = await asScholar.query(api.scholarApps.credentialsForApp, {
      appId,
    });
    expect(creds?.username).toBe("29001000123456");
    expect(creds?.password).toBe("1234");
  });

  test("archiving a granted app withdraws its autofill with its tile; un-archiving restores both", async () => {
    // TRA-425: the autofill gated on `launcherShowsApp` alone, whose grant
    // half never consults the catalog, so an archived app's tile vanished
    // while the 🔑 kept handing over the scholar's saved login for it.
    const t = convexTest(schema, modules);
    const { teacherId, scholarId, appId } = await seedGrantedApp(t);
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);
    // Parks the login on a visibility-neutral source:"grant" row.
    await asTeacher.mutation(api.scholarApps.setCredentials, {
      scholarId,
      appId,
      username: "kai.k",
      password: "honu-1234",
    });
    const tileShown = async () =>
      (await asScholar.query(api.scholarApps.listForLauncher, {})).some(
        (tile) => tile.appId === appId,
      );
    const autofill = () =>
      asScholar.query(api.scholarApps.credentialsForApp, { appId });
    const savedLogin = { username: "kai.k", password: "honu-1234" };

    expect(await tileShown()).toBe(true);
    expect(await autofill()).toMatchObject(savedLogin);

    await asTeacher.mutation(api.externalApps.setCatalogAppArchived, {
      appId,
      archived: true,
    });
    expect(await tileShown()).toBe(false);
    expect(await autofill()).toBeNull();

    // Archiving deletes neither the grant nor the parked login, so
    // un-archiving brings both back with nothing to re-enter.
    await asTeacher.mutation(api.externalApps.setCatalogAppArchived, {
      appId,
      archived: false,
    });
    expect(await tileShown()).toBe(true);
    expect(await autofill()).toMatchObject(savedLogin);
  });

  test("a scholar with neither a grant nor a direct row still cannot launch", async () => {
    const t = convexTest(schema, modules);
    const { institutionId, appId } = await seedGrantedApp(t);
    const outsiderId = await seedScholarInInstitution(t, {
      institutionId,
      name: "Oliver Stone",
      username: "oliver-grantlaunch",
    });
    const asOutsider = await withUser(t, outsiderId);

    expect(await asOutsider.query(api.scholarApps.listForLauncher, {})).toEqual(
      [],
    );
    await expect(
      asOutsider.mutation(api.webActivitySessions.start, { appId }),
    ).rejects.toThrow(/not available to you/i);
    expect(
      await asOutsider.query(api.scholarApps.credentialsForApp, { appId }),
    ).toBeNull();
  });

  test("a credential-parking row alone neither shows a tile nor authorises a launch", async () => {
    const t = convexTest(schema, modules);
    const { institutionId, appId } = await seedGrantedApp(t);
    // A scholar whose grant was later revoked keeps the parked credential row
    // (§5: retained so it re-attaches on re-grant) — but it is
    // visibility-neutral, so it must not resurrect access on its own.
    const formerId = await seedScholarInInstitution(t, {
      institutionId,
      name: "Sloane Kahale",
      username: "sloane-grantlaunch",
    });
    await t.run((ctx) =>
      ctx.db.insert("scholarApps", {
        scholarId: formerId,
        appId,
        enabled: true,
        source: "grant",
        loginUsername: "sloane.k",
      }),
    );
    const asFormer = await withUser(t, formerId);

    expect(await asFormer.query(api.scholarApps.listForLauncher, {})).toEqual(
      [],
    );
    await expect(
      asFormer.mutation(api.webActivitySessions.start, { appId }),
    ).rejects.toThrow(/not available to you/i);
  });
});

// TRA-431: `setCredentials` parks a login for a group-granted app on a
// visibility-neutral source:"grant" row. A teacher's direct add used to find
// that row, take it for "already added", and record nothing — so the scholar
// lost the app along with the grant, or never got it back once it was gone.
describe("a direct add over a parked grant login", () => {
  const savedLogin = { username: "kai.k", password: "honu-1234" };

  /** The pod world, driven through the real writers: the teacher grants the
   *  app to the pod and parks the scholar's login on it. */
  async function seedParkedLogin(t: TestClient, { parkLogin = true } = {}) {
    const world = await seedGrantedApp(t, { grant: false });
    const { teacherId, scholarId, appId } = world;
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);
    const grant = {
      appId,
      audienceKind: "group" as const,
      audienceId: String(world.groupId),
    };
    await asTeacher.mutation(api.appAudiences.assignToAudience, grant);
    if (parkLogin) {
      await asTeacher.mutation(api.scholarApps.setCredentials, {
        scholarId,
        appId,
        ...savedLogin,
      });
    }
    return {
      ...world,
      asTeacher,
      ungrant: () =>
        asTeacher.mutation(api.appAudiences.unassignAudience, grant),
      addDirectly: () =>
        asTeacher.mutation(api.scholarApps.addToScholar, { scholarId, appId }),
      /** The aide installs the app's URL for the scholar; it dedupes into
       *  this catalog row. */
      installUrl: () =>
        t.mutation(internal.customApps.installExistingUrlApp, {
          name: "Reading App",
          webUrl: "https://reading.example.com/students",
          callerUserId: teacherId,
          scholarIds: [scholarId],
          groupIds: [],
          allowedScholarIds: [scholarId],
        }),
      tileShown: async () =>
        (await asScholar.query(api.scholarApps.listForLauncher, {})).some(
          (tile) => tile.appId === appId,
        ),
      /** The teacher's Apps panel row for the app, or null if it lists none. */
      panelRow: async () =>
        (
          await asTeacher.query(api.scholarApps.listForScholar, { scholarId })
        ).find((row) => row.appId === appId) ?? null,
      autofill: () =>
        asScholar.query(api.scholarApps.credentialsForApp, { appId }),
      links: () =>
        t.run((ctx) =>
          ctx.db
            .query("scholarApps")
            .withIndex("by_scholar_app", (q) =>
              q.eq("scholarId", scholarId).eq("appId", appId),
            )
            .collect(),
        ),
    };
  }

  test("grant removed, then a direct add: the tile comes back with the parked login", async () => {
    const t = convexTest(schema, modules);
    const w = await seedParkedLogin(t);
    await w.ungrant();
    // Precondition: the parked row outlives the grant but shows nothing.
    expect(await w.links()).toMatchObject([{ source: "grant" }]);
    expect(await w.tileShown()).toBe(false);
    expect(await w.panelRow()).toBeNull();

    await w.addDirectly();

    expect(await w.tileShown()).toBe(true);
    expect(await w.panelRow()).toMatchObject({
      direct: true,
      enabled: true,
      grantGroups: [],
      loginUsername: "kai.k",
      hasPassword: true,
    });
    expect(await w.autofill()).toMatchObject(savedLogin);
    // The parked row itself became the direct add; no second row.
    expect(await w.links()).toMatchObject([
      {
        source: "manual",
        enabled: true,
        addedBy: w.teacherId,
        loginUsername: "kai.k",
        loginPassword: "honu-1234",
      },
    ]);
    const audits = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .withIndex("by_action", (q) =>
          q.eq("action", "app-grant.scholar-assigned"),
        )
        .collect(),
    );
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0].detail ?? "")).toEqual({
      appId: w.appId,
      scholarId: w.scholarId,
      previousEnabled: null,
      newEnabled: true,
      via: "ui",
    });
  });

  test("a direct add while the grant is live outlasts the grant", async () => {
    const t = convexTest(schema, modules);
    const w = await seedParkedLogin(t);

    await w.addDirectly();
    expect(await w.panelRow()).toMatchObject({
      direct: true,
      grantGroups: [{ id: w.groupId, name: "Honu", emoji: null }],
    });

    await w.ungrant();
    expect(await w.tileShown()).toBe(true);
    expect(await w.panelRow()).toMatchObject({ direct: true, grantGroups: [] });
    expect(await w.autofill()).toMatchObject(savedLogin);
  });

  test("control: with no parked login, the same direct add inserts a direct row", async () => {
    const t = convexTest(schema, modules);
    const w = await seedParkedLogin(t, { parkLogin: false });
    await w.ungrant();
    expect(await w.links()).toEqual([]);

    await w.addDirectly();

    expect(await w.links()).toMatchObject([{ source: "manual", enabled: true }]);
    expect(await w.tileShown()).toBe(true);
  });

  test("removing the direct add while the grant is live parks the login again", async () => {
    const t = convexTest(schema, modules);
    const w = await seedParkedLogin(t);
    const { scholarAppId } = await w.addDirectly();

    await w.asTeacher.mutation(api.scholarApps.removeFromScholar, {
      scholarAppId,
    });

    // The grant still shows the tile and still needs the login to autofill.
    expect(await w.links()).toMatchObject([
      { source: "grant", enabled: true, loginUsername: "kai.k" },
    ]);
    expect(await w.tileShown()).toBe(true);
    expect(await w.autofill()).toMatchObject(savedLogin);
    expect(await w.panelRow()).toMatchObject({ direct: false });

    // The same id again (a stale drawer, a double click) now names a parked
    // row, not a direct add: it stays, and no second removal is audited.
    await w.asTeacher.mutation(api.scholarApps.removeFromScholar, {
      scholarAppId,
    });
    expect(await w.links()).toMatchObject([
      { source: "grant", loginUsername: "kai.k" },
    ]);
    const removals = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .withIndex("by_action", (q) =>
          q.eq("action", "app-grant.scholar-unassigned"),
        )
        .collect(),
    );
    expect(removals).toHaveLength(1);
  });

  test("the aide's enable and disable follow the same rules", async () => {
    const t = convexTest(schema, modules);
    const w = await seedParkedLogin(t);
    const aideSetAccess = (enabled: boolean) =>
      t.mutation(internal.scholarApps.aideSetScholarAccess, {
        callerUserId: w.teacherId,
        appName: "Reading App",
        scholarQuery: "kai-grantlaunch",
        enabled,
      });

    // Grant live: enable promotes the parked row; disable parks the login again.
    await aideSetAccess(true);
    expect(await w.links()).toMatchObject([
      { source: "manual", loginUsername: "kai.k" },
    ]);
    expect(await aideSetAccess(false)).toMatchObject({ removed: 1 });
    expect(await w.links()).toMatchObject([
      { source: "grant", loginUsername: "kai.k" },
    ]);
    expect(await w.autofill()).toMatchObject(savedLogin);

    // Grant gone: enable gives the app back, and with no grant left to need
    // the login, disable takes the row with it.
    await w.ungrant();
    await aideSetAccess(true);
    expect(await w.tileShown()).toBe(true);
    expect(await aideSetAccess(false)).toMatchObject({ removed: 1 });
    expect(await w.tileShown()).toBe(false);
    expect(await w.links()).toEqual([]);
  });

  // TRA-437: the aide's install-a-URL used its own copy of the "already
  // added" check, so it took the parked row for an install and recorded
  // nothing. It now makes the same direct add as the panel.
  test("grant removed, then the aide installs the URL: the tile comes back", async () => {
    const t = convexTest(schema, modules);
    const w = await seedParkedLogin(t);
    await w.ungrant();
    expect(await w.tileShown()).toBe(false);

    const installed = await w.installUrl();

    expect(await w.tileShown()).toBe(true);
    expect(await w.autofill()).toMatchObject(savedLogin);
    expect(installed).toMatchObject({ appId: w.appId, scholars: 1 });
    expect(await w.links()).toMatchObject([
      {
        source: "manual",
        enabled: true,
        addedBy: w.teacherId,
        loginUsername: "kai.k",
      },
    ]);
    const audits = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .withIndex("by_action", (q) =>
          q.eq("action", "app-grant.scholar-assigned"),
        )
        .collect(),
    );
    expect(audits.map((a) => JSON.parse(a.detail ?? ""))).toEqual([
      {
        appId: w.appId,
        scholarId: w.scholarId,
        previousEnabled: null,
        newEnabled: true,
        via: "aide",
      },
    ]);
  });

  test("the aide's URL install while the grant is live outlasts the grant", async () => {
    const t = convexTest(schema, modules);
    const w = await seedParkedLogin(t);

    const installed = await w.installUrl();
    await w.ungrant();

    expect(await w.tileShown()).toBe(true);
    expect(await w.panelRow()).toMatchObject({ direct: true, grantGroups: [] });
    expect(await w.autofill()).toMatchObject(savedLogin);
    expect(installed).toMatchObject({ scholars: 1 });
  });
});
