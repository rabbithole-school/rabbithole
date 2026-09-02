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
import { api } from "../_generated/api";
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

/** One school, one teacher, one pod-granted app, one scholar in the pod. */
async function seedGrantedApp(t: TestClient) {
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
  await t.run((ctx) =>
    ctx.db.insert("appAudiences", {
      appId,
      audienceKind: "group",
      audienceId: String(groupId),
      enabled: true,
      addedBy: teacherId,
    }),
  );
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
