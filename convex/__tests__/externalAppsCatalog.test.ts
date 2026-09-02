import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import {
  seedTestInstitution,
  seedStaffWithMembership,
  seedScholarInInstitution,
} from "./institutionTestHelpers";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

// Tenant-gate on the External Apps CATALOG writers (coreUpdateApp /
// coreSetArchived), reached via updateCatalogApp / setCatalogAppArchived (the
// public scholarAdmin mutations) and aideUpdateApp / aideSetAppArchived (the bot
// wrappers). The catalog is shared (no institutionId), so the boundary is REACH
// CONTAINMENT: a caller may mutate a catalog app iff every scholar it CURRENTLY
// REACHES is inside their institution lens — or it reaches nobody and they
// created it. See .faux-spec3.md / review/external-apps-launcher.html.

// Deriving a schema-aware client type from a REAL convexTest(schema, modules)
// call site (the convex/tsconfig.json blind-spot the spec warns about):
// `ReturnType<typeof convexTest>` alone drops the schema generic and ctx.db
// falls back to SystemIndexes, breaking withIndex helpers.
const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const _makeTestClient = () => convexTest(schema, modules);
type TestT = ReturnType<typeof _makeTestClient>;

const ORIGINAL_URL = "https://original.example.com/start";
const ORIGINAL_HOST = "original.example.com";
const HIJACK_URL = "https://hijacked.example.net/evil";
// The allowlist is re-derived from the new URL as its SITE, not its exact host
// (registrableHost — subdomains are interchangeable), so a deep link can't lock
// a scholar out of the site's own sign-in hop.
const HIJACK_SITE = "example.net";

async function seedPlatformAdmin(t: TestT): Promise<Id<"users">> {
  return await t.run((ctx) =>
    ctx.db.insert("users", {
      name: "Wren Okafor",
      username: `admin-${Math.random().toString(36).slice(2, 8)}`,
      role: "platform_admin",
    }),
  );
}

/** Insert a catalog app directly so the test controls createdBy + start url. */
async function seedCatalogApp(
  t: TestT,
  createdBy: Id<"users">,
  name: string,
): Promise<Id<"externalApps">> {
  return await t.run((ctx) =>
    ctx.db.insert("externalApps", {
      name,
      webUrl: ORIGINAL_URL,
      webAllowedHosts: [ORIGINAL_HOST],
      createdBy,
    }),
  );
}

async function grantDirect(
  t: TestT,
  appId: Id<"externalApps">,
  scholarId: Id<"users">,
  source: "manual" | "default" | "grant" = "manual",
): Promise<void> {
  await t.run((ctx) =>
    ctx.db.insert("scholarApps", { scholarId, appId, enabled: true, source }),
  );
}

async function grantGroup(
  t: TestT,
  appId: Id<"externalApps">,
  groupId: Id<"scholarGroups">,
): Promise<void> {
  await t.run((ctx) =>
    ctx.db.insert("appAudiences", {
      appId,
      audienceKind: "group",
      audienceId: groupId,
      enabled: true,
    }),
  );
}

async function grantInstitution(
  t: TestT,
  appId: Id<"externalApps">,
  institutionId: Id<"institutions">,
): Promise<void> {
  await t.run((ctx) =>
    ctx.db.insert("appAudiences", {
      appId,
      audienceKind: "institution",
      audienceId: institutionId,
      enabled: true,
    }),
  );
}

async function seedGroup(
  t: TestT,
  institutionId: Id<"institutions">,
  teacherId: Id<"users">,
  scholarIds: Id<"users">[],
): Promise<Id<"scholarGroups">> {
  return await t.run((ctx) =>
    ctx.db.insert("scholarGroups", {
      teacherId,
      institutionId,
      name: `Pod ${Math.random().toString(36).slice(2, 6)}`,
      scholarIds,
    }),
  );
}

async function withUser(t: TestT, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

function readApp(t: TestT, appId: Id<"externalApps">) {
  return t.run((ctx) => ctx.db.get(appId));
}

// ── Drivers: one per (operation × entry point). Each returns a promise that
// resolves on success and rejects on refusal, so a single set of cases exercises
// both the public mutation and the aide wrapper for both operations.

type UpdateDriver = {
  label: string;
  run: (
    t: TestT,
    args: { caller: Id<"users">; appId: Id<"externalApps">; appName: string },
  ) => Promise<unknown>;
};

type ArchiveDriver = {
  label: string;
  run: (
    t: TestT,
    args: { caller: Id<"users">; appId: Id<"externalApps">; appName: string },
  ) => Promise<unknown>;
};

const updateDrivers: UpdateDriver[] = [
  {
    label: "aideUpdateApp",
    run: (t, { caller, appName }) =>
      t.mutation(internal.externalApps.aideUpdateApp, {
        callerUserId: caller,
        appName,
        webUrl: HIJACK_URL,
      }),
  },
  {
    label: "updateCatalogApp",
    run: async (t, { caller, appId }) =>
      (await withUser(t, caller)).mutation(api.externalApps.updateCatalogApp, {
        appId,
        webUrl: HIJACK_URL,
      }),
  },
];

const archiveDrivers: ArchiveDriver[] = [
  {
    label: "aideSetAppArchived",
    run: (t, { caller, appName }) =>
      t.mutation(internal.externalApps.aideSetAppArchived, {
        callerUserId: caller,
        appName,
        archived: true,
      }),
  },
  {
    label: "setCatalogAppArchived",
    run: async (t, { caller, appId }) =>
      (await withUser(t, caller)).mutation(
        api.externalApps.setCatalogAppArchived,
        { appId, archived: true },
      ),
  },
];

/** School A (owns the app), school B (the attacker), a non-creator staffer on
 *  each side, the creator, a platform admin, and one scholar per school. */
async function seedTwoSchools(t: TestT) {
  const schoolA = await seedTestInstitution(t, {
    name: "Kestrel Academy",
    slug: "kestrel",
    isPrimary: true,
  });
  const schoolB = await seedTestInstitution(t, {
    name: "Marlow School",
    slug: "marlow",
  });
  const creatorA = await seedStaffWithMembership(t, {
    institutionId: schoolA,
    name: "Tamsin Reyes",
  });
  const staffA = await seedStaffWithMembership(t, {
    institutionId: schoolA,
    name: "Oren Vance",
  });
  const staffB = await seedStaffWithMembership(t, {
    institutionId: schoolB,
    name: "Pilar Nkemelu",
  });
  const admin = await seedPlatformAdmin(t);
  const scholarA = await seedScholarInInstitution(t, {
    institutionId: schoolA,
    name: "Juniper Alvarez",
  });
  const scholarB = await seedScholarInInstitution(t, {
    institutionId: schoolB,
    name: "Dashiell Fontaine",
  });
  return {
    schoolA,
    schoolB,
    creatorA,
    staffA,
    staffB,
    admin,
    scholarA,
    scholarB,
  };
}

describe.each(updateDrivers)(
  "External Apps catalog write gate — $label",
  (driver) => {
    test("a school-B staffer cannot change the webUrl of an app reaching only school A", async () => {
      const t = convexTest(schema, modules);
      const s = await seedTwoSchools(t);
      const appId = await seedCatalogApp(t, s.creatorA, "Reader One");
      await grantDirect(t, appId, s.scholarA);

      await expect(
        driver.run(t, { caller: s.staffB, appId, appName: "Reader One" }),
      ).rejects.toThrow(/another school/i);

      const after = await readApp(t, appId);
      expect(after?.webUrl).toBe(ORIGINAL_URL);
      expect(after?.webAllowedHosts).toEqual([ORIGINAL_HOST]);
    });

    test("school A's own NON-creator staffer CAN change the webUrl", async () => {
      const t = convexTest(schema, modules);
      const s = await seedTwoSchools(t);
      const appId = await seedCatalogApp(t, s.creatorA, "Reader Two");
      await grantDirect(t, appId, s.scholarA);

      await driver.run(t, { caller: s.staffA, appId, appName: "Reader Two" });

      const after = await readApp(t, appId);
      expect(after?.webUrl).toBe(HIJACK_URL);
      // The new URL re-derives the host allowlist, widened to its site.
      expect(after?.webAllowedHosts).toEqual([HIJACK_SITE]);
    });

    test("an app reaching BOTH schools is refused for each school's staffer, allowed for a platform admin", async () => {
      const t = convexTest(schema, modules);
      const s = await seedTwoSchools(t);
      const appId = await seedCatalogApp(t, s.creatorA, "Reader Both");
      await grantDirect(t, appId, s.scholarA);
      await grantDirect(t, appId, s.scholarB);

      await expect(
        driver.run(t, { caller: s.staffA, appId, appName: "Reader Both" }),
      ).rejects.toThrow(/another school/i);
      await expect(
        driver.run(t, { caller: s.staffB, appId, appName: "Reader Both" }),
      ).rejects.toThrow(/another school/i);
      expect((await readApp(t, appId))?.webUrl).toBe(ORIGINAL_URL);

      // The accepted consequence: only an unrestricted (platform-admin) lens can
      // edit a genuinely two-school app. Asserted deliberately so nobody
      // "fixes" it later by accident.
      await driver.run(t, { caller: s.admin, appId, appName: "Reader Both" });
      expect((await readApp(t, appId))?.webUrl).toBe(HIJACK_URL);
    });

    test("a zero-reach app is editable by its creator and refused for a stranger", async () => {
      const t = convexTest(schema, modules);
      const s = await seedTwoSchools(t);
      const appId = await seedCatalogApp(t, s.creatorA, "Reader Zero");
      // No grants at all → reaches nobody.

      // A zero-reach app refuses a non-creator for a DIFFERENT reason than a
      // cross-school one, and the message must say so — "in use by another
      // school" would be flatly false about an app nobody can open.
      await expect(
        driver.run(t, { caller: s.staffB, appId, appName: "Reader Zero" }),
      ).rejects.toThrow(/only the staff member who added that app/i);
      expect((await readApp(t, appId))?.webUrl).toBe(ORIGINAL_URL);

      await driver.run(t, { caller: s.creatorA, appId, appName: "Reader Zero" });
      expect((await readApp(t, appId))?.webUrl).toBe(HIJACK_URL);
    });

    test("reach via an appAudiences GROUP grant counts", async () => {
      const t = convexTest(schema, modules);
      const s = await seedTwoSchools(t);
      // Creator is the school-B attacker, so the ONLY way school B is refused is
      // if the group grant makes scholar A count as reach (else the zero-reach
      // creator clause would let B through).
      const appId = await seedCatalogApp(t, s.staffB, "Reader Group");
      const groupA = await seedGroup(t, s.schoolA, s.creatorA, [s.scholarA]);
      await grantGroup(t, appId, groupA);

      await expect(
        driver.run(t, { caller: s.staffB, appId, appName: "Reader Group" }),
      ).rejects.toThrow(/another school/i);
      expect((await readApp(t, appId))?.webUrl).toBe(ORIGINAL_URL);

      // School A's staffer contains that reach and may edit.
      await driver.run(t, { caller: s.staffA, appId, appName: "Reader Group" });
      expect((await readApp(t, appId))?.webUrl).toBe(HIJACK_URL);
    });

    test("reach via an INSTITUTION grant counts", async () => {
      const t = convexTest(schema, modules);
      const s = await seedTwoSchools(t);
      const appId = await seedCatalogApp(t, s.staffB, "Reader Inst");
      await grantInstitution(t, appId, s.schoolA);

      await expect(
        driver.run(t, { caller: s.staffB, appId, appName: "Reader Inst" }),
      ).rejects.toThrow(/another school/i);
      expect((await readApp(t, appId))?.webUrl).toBe(ORIGINAL_URL);

      await driver.run(t, { caller: s.staffA, appId, appName: "Reader Inst" });
      expect((await readApp(t, appId))?.webUrl).toBe(HIJACK_URL);
    });

    test("a source:'grant' credential-parking row does NOT count as reach", async () => {
      const t = convexTest(schema, modules);
      const s = await seedTwoSchools(t);
      const appId = await seedCatalogApp(t, s.creatorA, "Reader Park");
      // The ONLY grant is a visibility-neutral credential-parking row for
      // scholar A. If it counted as reach, school A's non-creator staffer would
      // be allowed; because it does NOT, the app is zero-reach and only its
      // creator can edit it.
      await grantDirect(t, appId, s.scholarA, "grant");

      // Zero reach (the grant-source row does not count), so this is the
      // creator-clause refusal, not the cross-school one.
      await expect(
        driver.run(t, { caller: s.staffA, appId, appName: "Reader Park" }),
      ).rejects.toThrow(/only the staff member who added that app/i);
      expect((await readApp(t, appId))?.webUrl).toBe(ORIGINAL_URL);

      await driver.run(t, { caller: s.creatorA, appId, appName: "Reader Park" });
      expect((await readApp(t, appId))?.webUrl).toBe(HIJACK_URL);
    });
  },
);

describe.each(archiveDrivers)(
  "External Apps catalog archive gate — $label",
  (driver) => {
    test("a school-B staffer cannot archive an app reaching only school A", async () => {
      const t = convexTest(schema, modules);
      const s = await seedTwoSchools(t);
      const appId = await seedCatalogApp(t, s.creatorA, "Archive One");
      await grantDirect(t, appId, s.scholarA);

      await expect(
        driver.run(t, { caller: s.staffB, appId, appName: "Archive One" }),
      ).rejects.toThrow(/another school/i);

      const after = await readApp(t, appId);
      expect(after?.archived).toBeFalsy();
    });

    test("school A's own NON-creator staffer CAN archive it", async () => {
      const t = convexTest(schema, modules);
      const s = await seedTwoSchools(t);
      const appId = await seedCatalogApp(t, s.creatorA, "Archive Two");
      await grantDirect(t, appId, s.scholarA);

      await driver.run(t, { caller: s.staffA, appId, appName: "Archive Two" });

      expect((await readApp(t, appId))?.archived).toBe(true);
    });

    test("an app reaching BOTH schools is refused for each school's staffer, allowed for a platform admin", async () => {
      const t = convexTest(schema, modules);
      const s = await seedTwoSchools(t);
      const appId = await seedCatalogApp(t, s.creatorA, "Archive Both");
      await grantDirect(t, appId, s.scholarA);
      await grantDirect(t, appId, s.scholarB);

      await expect(
        driver.run(t, { caller: s.staffA, appId, appName: "Archive Both" }),
      ).rejects.toThrow(/another school/i);
      await expect(
        driver.run(t, { caller: s.staffB, appId, appName: "Archive Both" }),
      ).rejects.toThrow(/another school/i);
      expect((await readApp(t, appId))?.archived).toBeFalsy();

      await driver.run(t, { caller: s.admin, appId, appName: "Archive Both" });
      expect((await readApp(t, appId))?.archived).toBe(true);
    });
  },
);
