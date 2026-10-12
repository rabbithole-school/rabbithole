// Tenancy gate for the audience-grant WRITE paths (convex/appAudiences.ts).
//
// The catalog (`externalApps`) is deliberately GLOBAL, so the tenant boundary is
// the AUDIENCE you grant to — a scholarGroup or an institution. These tests
// prove a teacher at school B cannot assign/unassign/disable school A's grants
// (a cross-tenant DoS + reach), while the owning school's staff and platform
// admins still can. Covers BOTH the public `scholarAdmin*` mutations and the
// internal aide* wrappers.
//
// Fixture people are drawn from the documented fictional dev cast (Avery Stone,
// Sloane Kahale, Lehua Torres, Hoku Makani, Kai Kahale, Oliver Stone) — this
// repo is public.

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  grantInstitutionMembership,
  seedTestInstitution,
  seedStaffWithMembership,
  seedScholarInInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// `TestClient` drops the schema generic, so ctx.db falls
// back to SystemIndexes and any withIndex("by_audience", …) helper fails the
// ROOT tsc (the convex-project tsconfig doesn't cover __tests__, so it passes
// there — check both). Derive the alias from a real call to keep the DataModel.
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

async function seedPlatformAdmin(
  t: TestClient,
): Promise<Id<"users">> {
  return await t.run((ctx) =>
    ctx.db.insert("users", {
      name: "Avery Stone",
      username: "avery-admin",
      role: "platform_admin",
    }),
  );
}

async function seedApp(t: TestClient): Promise<Id<"externalApps">> {
  return await t.run((ctx) =>
    ctx.db.insert("externalApps", {
      name: "Acme Practice",
      webUrl: "https://acmepractice.example.com",
    }),
  );
}

async function seedGroup(
  t: TestClient,
  opts: {
    teacherId: Id<"users">;
    institutionId: Id<"institutions">;
    name: string;
    scholarIds: Id<"users">[];
  },
): Promise<Id<"scholarGroups">> {
  return await t.run((ctx) =>
    ctx.db.insert("scholarGroups", {
      teacherId: opts.teacherId,
      institutionId: opts.institutionId,
      name: opts.name,
      scholarIds: opts.scholarIds,
    }),
  );
}

async function seedGrant(
  t: TestClient,
  opts: {
    appId: Id<"externalApps">;
    audienceKind: "group" | "institution";
    audienceId: string;
    addedBy: Id<"users">;
  },
): Promise<Id<"appAudiences">> {
  return await t.run((ctx) =>
    ctx.db.insert("appAudiences", {
      appId: opts.appId,
      audienceKind: opts.audienceKind,
      audienceId: opts.audienceId,
      enabled: true,
      addedBy: opts.addedBy,
    }),
  );
}

/** A second, distinctly-named global catalog app (the catalog is tenant-free). */
async function seedNamedApp(
  t: TestClient,
  name: string,
): Promise<Id<"externalApps">> {
  return await t.run((ctx) =>
    ctx.db.insert("externalApps", {
      name,
      webUrl: `https://${name.replace(/\s+/g, "").toLowerCase()}.example.com`,
    }),
  );
}

/** A DIRECT per-scholar app link (source manual/default → shows a tile + counts
 *  toward the facepile). */
async function seedScholarApp(
  t: TestClient,
  opts: {
    scholarId: Id<"users">;
    appId: Id<"externalApps">;
    source?: "manual" | "default";
  },
): Promise<Id<"scholarApps">> {
  return await t.run((ctx) =>
    ctx.db.insert("scholarApps", {
      scholarId: opts.scholarId,
      appId: opts.appId,
      enabled: true,
      source: opts.source ?? "manual",
    }),
  );
}

/** Count of grant rows for a specific (app, audience). */
async function grantCount(
  t: TestClient,
  appId: Id<"externalApps">,
  audienceKind: "group" | "institution",
  audienceId: string,
): Promise<number> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db
      .query("appAudiences")
      .withIndex("by_audience", (q) =>
        q.eq("audienceKind", audienceKind).eq("audienceId", audienceId),
      )
      .filter((q) => q.eq(q.field("appId"), appId))
      .collect();
    return rows.length;
  });
}

async function auditRows(t: TestClient, action?: string) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("auditLog").collect();
    return action ? rows.filter((row) => row.action === action) : rows;
  });
}

function auditDetail(row: { detail?: string }) {
  return JSON.parse(row.detail ?? "{}") as Record<string, unknown>;
}

/**
 * Two schools (A "Moli School", B "Kula School"), each with two teachers (a
 * distinct group creator + a non-creator actor, so the permissive path can't
 * hide behind an ownership short-circuit), a scholar, and a scholarGroup. One
 * global catalog app. Names are unique so the aide* name resolvers are
 * unambiguous.
 */
async function setup(t: TestClient) {
  const instA = await seedTestInstitution(t, {
    name: "Moli School",
    slug: "moli",
    isPrimary: true,
  });
  const instB = await seedTestInstitution(t, {
    name: "Kula School",
    slug: "kula",
  });

  const teacherAcreator = await seedStaffWithMembership(t, {
    institutionId: instA,
    name: "Lehua Torres",
    username: "lehua-a-creator",
  });
  const teacherA = await seedStaffWithMembership(t, {
    institutionId: instA,
    name: "Hoku Makani",
    username: "hoku-a-actor",
  });
  const teacherB = await seedStaffWithMembership(t, {
    institutionId: instB,
    name: "Sloane Kahale",
    username: "sloane-b-actor",
  });

  const scholarA = await seedScholarInInstitution(t, {
    institutionId: instA,
    name: "Oliver Stone",
    username: "oliver-a",
  });
  const scholarB = await seedScholarInInstitution(t, {
    institutionId: instB,
    name: "Kai Kahale",
    username: "kai-b",
  });

  const groupA = await seedGroup(t, {
    teacherId: teacherAcreator,
    institutionId: instA,
    name: "Moli Geckos",
    scholarIds: [scholarA],
  });
  const groupB = await seedGroup(t, {
    teacherId: teacherB,
    institutionId: instB,
    name: "Kula Honu",
    scholarIds: [scholarB],
  });

  const appId = await seedApp(t);

  return {
    instA,
    instB,
    teacherAcreator,
    teacherA,
    teacherB,
    scholarA,
    scholarB,
    groupA,
    groupB,
    appId,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Public mutations — GROUP audience
// ─────────────────────────────────────────────────────────────────────────

describe("public mutations — group audience cross-tenant denial", () => {
  test("school-B teacher CANNOT assignToAudience an app to a school-A group", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);
    const asB = await withUser(t, s.teacherB);

    await expect(
      asB.mutation(api.appAudiences.assignToAudience, {
        appId: s.appId,
        audienceKind: "group",
        audienceId: s.groupA,
      }),
    ).rejects.toThrow(/Forbidden/);

    expect(await grantCount(t, s.appId, "group", s.groupA)).toBe(0);
  });

  // ── Roster-shape holes the roster-based helper would have let through ──
  // requireGroupScholarAccess (the read-side helper) forbids only a WHOLLY
  // foreign group: an EMPTY group is never forbidden, and a group is accessible
  // if ANY single member is. Both are fine for a read and are holes for a write
  // gate, which is why the group branch gates on the group's parent SCHOOL.

  test("school-B teacher CANNOT grant to an EMPTY school-A group", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);
    const emptyA = await seedGroup(t, {
      teacherId: s.teacherAcreator,
      institutionId: s.instA,
      name: "Moli Empty",
      scholarIds: [],
    });
    const asB = await withUser(t, s.teacherB);

    await expect(
      asB.mutation(api.appAudiences.assignToAudience, {
        appId: s.appId,
        audienceKind: "group",
        audienceId: emptyA,
      }),
    ).rejects.toThrow(/Forbidden/);

    expect(await grantCount(t, s.appId, "group", emptyA)).toBe(0);
  });

  test("school-B teacher CANNOT grant to a school-A group merely because it holds one reachable scholar", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);
    // A legacy mixed roster: mostly school A, with one school-B scholar in it.
    const mixedA = await seedGroup(t, {
      teacherId: s.teacherAcreator,
      institutionId: s.instA,
      name: "Moli Mixed",
      scholarIds: [s.scholarA, s.scholarB],
    });
    const asB = await withUser(t, s.teacherB);

    await expect(
      asB.mutation(api.appAudiences.assignToAudience, {
        appId: s.appId,
        audienceKind: "group",
        audienceId: mixedA,
      }),
    ).rejects.toThrow(/Forbidden/);

    expect(await grantCount(t, s.appId, "group", mixedA)).toBe(0);
  });

  test("school-B teacher CANNOT unassign a grant on an EMPTY school-A group", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);
    const emptyA = await seedGroup(t, {
      teacherId: s.teacherAcreator,
      institutionId: s.instA,
      name: "Moli Empty",
      scholarIds: [],
    });
    await seedGrant(t, {
      appId: s.appId,
      audienceKind: "group",
      audienceId: emptyA,
      addedBy: s.teacherAcreator,
    });
    const asB = await withUser(t, s.teacherB);

    await expect(
      asB.mutation(api.appAudiences.unassignAudience, {
        appId: s.appId,
        audienceKind: "group",
        audienceId: emptyA,
      }),
    ).rejects.toThrow(/Forbidden/);

    expect(await grantCount(t, s.appId, "group", emptyA)).toBe(1);
  });

  test("a legacy UNSTAMPED group is treated as the primary school, not as unowned", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);
    // institutionId omitted — the pre-stamping shape. institutionIdInLens reads
    // it as the primary school (school A here), so school B must not reach it.
    const legacy = await t.run((ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: s.teacherAcreator,
        name: "Moli Legacy",
        scholarIds: [],
      }),
    );
    const asB = await withUser(t, s.teacherB);

    await expect(
      asB.mutation(api.appAudiences.assignToAudience, {
        appId: s.appId,
        audienceKind: "group",
        audienceId: legacy,
      }),
    ).rejects.toThrow(/Forbidden/);
    expect(await grantCount(t, s.appId, "group", legacy)).toBe(0);

    // ...and the primary school's own teacher still can.
    const asA = await withUser(t, s.teacherA);
    await asA.mutation(api.appAudiences.assignToAudience, {
      appId: s.appId,
      audienceKind: "group",
      audienceId: legacy,
    });
    expect(await grantCount(t, s.appId, "group", legacy)).toBe(1);
  });

  test("school-B teacher CANNOT unassignAudience school-A's existing grant", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);
    await seedGrant(t, {
      appId: s.appId,
      audienceKind: "group",
      audienceId: s.groupA,
      addedBy: s.teacherAcreator,
    });
    const asB = await withUser(t, s.teacherB);

    await expect(
      asB.mutation(api.appAudiences.unassignAudience, {
        appId: s.appId,
        audienceKind: "group",
        audienceId: s.groupA,
      }),
    ).rejects.toThrow(/Forbidden/);

    // Grant survives.
    expect(await grantCount(t, s.appId, "group", s.groupA)).toBe(1);
  });

  test("school-B teacher CANNOT setAudienceEnabled(false) on school-A's grant", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);
    await seedGrant(t, {
      appId: s.appId,
      audienceKind: "group",
      audienceId: s.groupA,
      addedBy: s.teacherAcreator,
    });
    const asB = await withUser(t, s.teacherB);

    await expect(
      asB.mutation(api.appAudiences.setAudienceEnabled, {
        appId: s.appId,
        audienceKind: "group",
        audienceId: s.groupA,
        enabled: false,
      }),
    ).rejects.toThrow(/Forbidden/);

    const stillEnabled = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("appAudiences")
        .withIndex("by_audience", (q) =>
          q.eq("audienceKind", "group").eq("audienceId", s.groupA),
        )
        .first();
      return row?.enabled;
    });
    expect(stillEnabled).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Public mutations — INSTITUTION audience
// ─────────────────────────────────────────────────────────────────────────

describe("public mutations — institution audience cross-tenant denial", () => {
  test("school-B teacher CANNOT assign an app to school A (institution)", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);
    const asB = await withUser(t, s.teacherB);

    await expect(
      asB.mutation(api.appAudiences.assignToAudience, {
        appId: s.appId,
        audienceKind: "institution",
        audienceId: s.instA,
      }),
    ).rejects.toThrow(/Forbidden/);

    expect(await grantCount(t, s.appId, "institution", s.instA)).toBe(0);
  });

  test("school-B teacher CANNOT unassign school A's institution grant", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);
    await seedGrant(t, {
      appId: s.appId,
      audienceKind: "institution",
      audienceId: s.instA,
      addedBy: s.teacherAcreator,
    });
    const asB = await withUser(t, s.teacherB);

    await expect(
      asB.mutation(api.appAudiences.unassignAudience, {
        appId: s.appId,
        audienceKind: "institution",
        audienceId: s.instA,
      }),
    ).rejects.toThrow(/Forbidden/);

    expect(await grantCount(t, s.appId, "institution", s.instA)).toBe(1);
  });

  test("school-B teacher CANNOT disable school A's institution grant", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);
    await seedGrant(t, {
      appId: s.appId,
      audienceKind: "institution",
      audienceId: s.instA,
      addedBy: s.teacherAcreator,
    });
    const asB = await withUser(t, s.teacherB);

    await expect(
      asB.mutation(api.appAudiences.setAudienceEnabled, {
        appId: s.appId,
        audienceKind: "institution",
        audienceId: s.instA,
        enabled: false,
      }),
    ).rejects.toThrow(/Forbidden/);

    const stillEnabled = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("appAudiences")
        .withIndex("by_audience", (q) =>
          q.eq("audienceKind", "institution").eq("audienceId", s.instA),
        )
        .first();
      return row?.enabled;
    });
    expect(stillEnabled).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Permissive path — the owning school's (non-creator) teacher CAN
// ─────────────────────────────────────────────────────────────────────────

describe("public mutations — owning school's teacher is allowed", () => {
  test("non-creator school-A teacher CAN assign/disable/unassign its own group grant", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);
    // Act as teacherA (Hoku), who did NOT create groupA (Lehua did) — proves the
    // gate keys on institution scope, not group ownership.
    const asA = await withUser(t, s.teacherA);

    const assigned = await asA.mutation(api.appAudiences.assignToAudience, {
      appId: s.appId,
      audienceKind: "group",
      audienceId: s.groupA,
    });
    expect(assigned.created).toBe(true);
    expect(await grantCount(t, s.appId, "group", s.groupA)).toBe(1);

    await asA.mutation(api.appAudiences.setAudienceEnabled, {
      appId: s.appId,
      audienceKind: "group",
      audienceId: s.groupA,
      enabled: false,
    });
    const disabled = await t.run(async (ctx) => {
      const row = await ctx.db.get(assigned.grantId);
      return row?.enabled;
    });
    expect(disabled).toBe(false);

    const removed = await asA.mutation(api.appAudiences.unassignAudience, {
      appId: s.appId,
      audienceKind: "group",
      audienceId: s.groupA,
    });
    expect(removed.removed).toBe(1);
    expect(await grantCount(t, s.appId, "group", s.groupA)).toBe(0);
  });

  describe("app-grant audit log", () => {
    test("assign writes one audience-assigned audit row with actor, target, and ui path", async () => {
      const t = convexTest(schema, modules);
      const s = await setup(t);
      const asA = await withUser(t, s.teacherA);

      await asA.mutation(api.appAudiences.assignToAudience, {
        appId: s.appId,
        audienceKind: "group",
        audienceId: s.groupA,
      });

      const rows = await auditRows(t, "app-grant.audience-assigned");
      expect(rows).toHaveLength(1);
      expect(rows[0].actorUserId).toBe(s.teacherA);
      expect(rows[0].targetUserId).toBe(s.teacherA);
      expect(auditDetail(rows[0])).toEqual({
        appId: s.appId,
        audienceKind: "group",
        audienceId: s.groupA,
        previousEnabled: null,
        newEnabled: true,
        via: "ui",
      });
    });

    test("unassign writes one audience-unassigned audit row", async () => {
      const t = convexTest(schema, modules);
      const s = await setup(t);
      await seedGrant(t, {
        appId: s.appId,
        audienceKind: "group",
        audienceId: s.groupA,
        addedBy: s.teacherAcreator,
      });
      const asA = await withUser(t, s.teacherA);

      await asA.mutation(api.appAudiences.unassignAudience, {
        appId: s.appId,
        audienceKind: "group",
        audienceId: s.groupA,
      });

      const rows = await auditRows(t, "app-grant.audience-unassigned");
      expect(rows).toHaveLength(1);
      expect(rows[0].actorUserId).toBe(s.teacherA);
      expect(auditDetail(rows[0])).toMatchObject({
        appId: s.appId,
        audienceKind: "group",
        audienceId: s.groupA,
        previousEnabled: true,
        newEnabled: "removed",
        via: "ui",
      });
    });

    test("setAudienceEnabled true to false writes previous and new state", async () => {
      const t = convexTest(schema, modules);
      const s = await setup(t);
      await seedGrant(t, {
        appId: s.appId,
        audienceKind: "group",
        audienceId: s.groupA,
        addedBy: s.teacherAcreator,
      });
      const asA = await withUser(t, s.teacherA);

      await asA.mutation(api.appAudiences.setAudienceEnabled, {
        appId: s.appId,
        audienceKind: "group",
        audienceId: s.groupA,
        enabled: false,
      });

      const rows = await auditRows(t, "app-grant.audience-disabled");
      expect(rows).toHaveLength(1);
      expect(auditDetail(rows[0])).toEqual({
        appId: s.appId,
        audienceKind: "group",
        audienceId: s.groupA,
        previousEnabled: true,
        newEnabled: false,
        via: "ui",
      });
    });

    test("setAudienceEnabled no-op writes no audit row", async () => {
      const t = convexTest(schema, modules);
      const s = await setup(t);
      await seedGrant(t, {
        appId: s.appId,
        audienceKind: "group",
        audienceId: s.groupA,
        addedBy: s.teacherAcreator,
      });
      const asA = await withUser(t, s.teacherA);

      await asA.mutation(api.appAudiences.setAudienceEnabled, {
        appId: s.appId,
        audienceKind: "group",
        audienceId: s.groupA,
        enabled: true,
      });

      expect(await auditRows(t)).toHaveLength(0);
    });

    test("assigning an already-enabled audience grant writes no audit row", async () => {
      const t = convexTest(schema, modules);
      const s = await setup(t);
      await seedGrant(t, {
        appId: s.appId,
        audienceKind: "group",
        audienceId: s.groupA,
        addedBy: s.teacherAcreator,
      });
      const asA = await withUser(t, s.teacherA);

      await asA.mutation(api.appAudiences.assignToAudience, {
        appId: s.appId,
        audienceKind: "group",
        audienceId: s.groupA,
      });

      expect(await auditRows(t)).toHaveLength(0);
    });

    test("aide audience assignment stamps via aide", async () => {
      const t = convexTest(schema, modules);
      const s = await setup(t);

      await t.run((ctx) =>
        ctx.runMutation(internal.appAudiences.aideSetGroupAccess, {
          callerUserId: s.teacherA,
          appName: "Acme Practice",
          groupName: "Moli Geckos",
          enabled: true,
        }),
      );

      const rows = await auditRows(t, "app-grant.audience-assigned");
      expect(rows).toHaveLength(1);
      expect(rows[0].actorUserId).toBe(s.teacherA);
      expect(auditDetail(rows[0])).toMatchObject({ via: "aide" });
    });

    test("scholarApps add writes one scholar-assigned audit row", async () => {
      const t = convexTest(schema, modules);
      const s = await setup(t);
      const asA = await withUser(t, s.teacherA);

      await asA.mutation(api.scholarApps.addToScholar, {
        scholarId: s.scholarA,
        appId: s.appId,
      });

      const rows = await auditRows(t, "app-grant.scholar-assigned");
      expect(rows).toHaveLength(1);
      expect(rows[0].actorUserId).toBe(s.teacherA);
      expect(rows[0].targetUserId).toBe(s.scholarA);
      expect(auditDetail(rows[0])).toEqual({
        appId: s.appId,
        scholarId: s.scholarA,
        previousEnabled: null,
        newEnabled: true,
        via: "ui",
      });
    });
  });

  test("non-creator school-A teacher CAN assign its own institution grant", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);
    const asA = await withUser(t, s.teacherA);

    const assigned = await asA.mutation(api.appAudiences.assignToAudience, {
      appId: s.appId,
      audienceKind: "institution",
      audienceId: s.instA,
    });
    expect(assigned.created).toBe(true);
    expect(await grantCount(t, s.appId, "institution", s.instA)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Platform admin is unrestricted
// ─────────────────────────────────────────────────────────────────────────

describe("platform admin is unrestricted", () => {
  test("platform admin CAN assign/disable/unassign any school's group grant", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);
    const adminId = await seedPlatformAdmin(t);
    const asAdmin = await withUser(t, adminId);

    const assigned = await asAdmin.mutation(api.appAudiences.assignToAudience, {
      appId: s.appId,
      audienceKind: "group",
      audienceId: s.groupA,
    });
    expect(assigned.created).toBe(true);

    await asAdmin.mutation(api.appAudiences.setAudienceEnabled, {
      appId: s.appId,
      audienceKind: "group",
      audienceId: s.groupA,
      enabled: false,
    });

    const removed = await asAdmin.mutation(api.appAudiences.unassignAudience, {
      appId: s.appId,
      audienceKind: "group",
      audienceId: s.groupA,
    });
    expect(removed.removed).toBe(1);
  });

  test("platform admin CAN assign a foreign institution grant", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);
    const adminId = await seedPlatformAdmin(t);
    const asAdmin = await withUser(t, adminId);

    const assigned = await asAdmin.mutation(api.appAudiences.assignToAudience, {
      appId: s.appId,
      audienceKind: "institution",
      audienceId: s.instB,
    });
    expect(assigned.created).toBe(true);
    expect(await grantCount(t, s.appId, "institution", s.instB)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Malformed audience id — fail closed
// ─────────────────────────────────────────────────────────────────────────

describe("malformed audienceId is refused (fail closed)", () => {
  test("a non-normalizing group audienceId is refused, not silently ignored", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);
    const asA = await withUser(t, s.teacherA);

    await expect(
      asA.mutation(api.appAudiences.assignToAudience, {
        appId: s.appId,
        audienceKind: "group",
        audienceId: "not-a-real-id",
      }),
    ).rejects.toThrow(/Forbidden/);

    expect(await grantCount(t, s.appId, "group", "not-a-real-id")).toBe(0);
  });

  test("a non-normalizing institution audienceId is refused", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);
    const asA = await withUser(t, s.teacherA);

    await expect(
      asA.mutation(api.appAudiences.assignToAudience, {
        appId: s.appId,
        audienceKind: "institution",
        audienceId: "not-a-real-id",
      }),
    ).rejects.toThrow(/Forbidden/);

    expect(await grantCount(t, s.appId, "institution", "not-a-real-id")).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Aide* wrappers (internal, name-resolved) — BOTH cross-tenant + permissive
// ─────────────────────────────────────────────────────────────────────────
//
// The aide path resolves human-typed NAMES within the caller's scope
// (resolveGroupByName / resolveInstitutionByName are both scoped), so a
// school-B caller can't even NAME school A's group/school: the refusal lands at
// name resolution ("No group/school matches …") BEFORE the shared core gate.
// That is a tighter refusal than the id path's /Forbidden/, so these assert the
// rejection + zero rows rather than a specific message. The permissive cases
// prove the core gate does not over-block an in-scope aide grant.

describe("aide wrappers — group access", () => {
  test("school-B teacher CANNOT grant an app to school A's group by name", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);

    await expect(
      t.run((ctx) =>
        ctx.runMutation(internal.appAudiences.aideSetGroupAccess, {
          callerUserId: s.teacherB,
          appName: "Acme Practice",
          groupName: "Moli Geckos",
          enabled: true,
        }),
      ),
    ).rejects.toThrow(/No group matches/);

    expect(await grantCount(t, s.appId, "group", s.groupA)).toBe(0);
  });

  test("school-B teacher CANNOT disable school A's group grant by name", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);
    await seedGrant(t, {
      appId: s.appId,
      audienceKind: "group",
      audienceId: s.groupA,
      addedBy: s.teacherAcreator,
    });

    await expect(
      t.run((ctx) =>
        ctx.runMutation(internal.appAudiences.aideSetGroupAccess, {
          callerUserId: s.teacherB,
          appName: "Acme Practice",
          groupName: "Moli Geckos",
          enabled: false,
        }),
      ),
    ).rejects.toThrow(/No group matches/);

    // Grant survives, still enabled.
    expect(await grantCount(t, s.appId, "group", s.groupA)).toBe(1);
    const stillEnabled = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("appAudiences")
        .withIndex("by_audience", (q) =>
          q.eq("audienceKind", "group").eq("audienceId", s.groupA),
        )
        .first();
      return row?.enabled;
    });
    expect(stillEnabled).toBe(true);
  });

  test("owning school's teacher CAN grant + revoke its own group by name", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);

    const granted = await t.run((ctx) =>
      ctx.runMutation(internal.appAudiences.aideSetGroupAccess, {
        callerUserId: s.teacherA,
        appName: "Acme Practice",
        groupName: "Moli Geckos",
        enabled: true,
      }),
    );
    expect(granted.enabled).toBe(true);
    expect(await grantCount(t, s.appId, "group", s.groupA)).toBe(1);

    const revoked = await t.run((ctx) =>
      ctx.runMutation(internal.appAudiences.aideSetGroupAccess, {
        callerUserId: s.teacherA,
        appName: "Acme Practice",
        groupName: "Moli Geckos",
        enabled: false,
      }),
    );
    expect(revoked.enabled).toBe(false);
    expect(await grantCount(t, s.appId, "group", s.groupA)).toBe(0);
  });
});

describe("aide wrappers — institution access", () => {
  test("school-B teacher CANNOT grant an app to school A by name", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);

    await expect(
      t.run((ctx) =>
        ctx.runMutation(internal.appAudiences.aideSetInstitutionAccess, {
          callerUserId: s.teacherB,
          appName: "Acme Practice",
          institutionName: "Moli School",
          enabled: true,
        }),
      ),
    ).rejects.toThrow(/No school matches/);

    expect(await grantCount(t, s.appId, "institution", s.instA)).toBe(0);
  });

  test("school-B teacher CANNOT unassign school A's institution grant by name", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);
    await seedGrant(t, {
      appId: s.appId,
      audienceKind: "institution",
      audienceId: s.instA,
      addedBy: s.teacherAcreator,
    });

    await expect(
      t.run((ctx) =>
        ctx.runMutation(internal.appAudiences.aideSetInstitutionAccess, {
          callerUserId: s.teacherB,
          appName: "Acme Practice",
          institutionName: "Moli School",
          enabled: false,
        }),
      ),
    ).rejects.toThrow(/No school matches/);

    expect(await grantCount(t, s.appId, "institution", s.instA)).toBe(1);
  });

  test("owning school's teacher CAN grant its own institution by name", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);

    const granted = await t.run((ctx) =>
      ctx.runMutation(internal.appAudiences.aideSetInstitutionAccess, {
        callerUserId: s.teacherA,
        appName: "Acme Practice",
        institutionName: "Moli School",
        enabled: true,
      }),
    );
    expect(granted.enabled).toBe(true);
    expect(await grantCount(t, s.appId, "institution", s.instA)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Web scholarAdminQuery READS — tenant-scoped grant/scholar detail (the fix)
// ─────────────────────────────────────────────────────────────────────────
//
// The catalog (`externalApps`) is GLOBAL and must stay browsable across schools
// (a school must be able to see an app exists and adopt it). What was leaking is
// the GRANT/scholar detail hung off each app row: a teacher at school B, on the
// web Apps tab, could see school A's group names, school names, and scholar
// facepiles. These prove the reads now scope that detail to the caller's tenant
// (via the same requireScholarAdminScope the aide path uses) while leaving the
// app rows themselves whole. The lens-scoped-count consequence is intended and
// accepted (Andy, 2026-08-19): a staffer sees their own school's number.

/** Grant s.appId to BOTH schools (group + institution audiences each). */
async function grantAppToBothSchools(
  t: TestClient,
  s: Awaited<ReturnType<typeof setup>>,
): Promise<void> {
  await seedGrant(t, {
    appId: s.appId,
    audienceKind: "group",
    audienceId: s.groupA,
    addedBy: s.teacherAcreator,
  });
  await seedGrant(t, {
    appId: s.appId,
    audienceKind: "institution",
    audienceId: s.instA,
    addedBy: s.teacherAcreator,
  });
  await seedGrant(t, {
    appId: s.appId,
    audienceKind: "group",
    audienceId: s.groupB,
    addedBy: s.teacherB,
  });
  await seedGrant(t, {
    appId: s.appId,
    audienceKind: "institution",
    audienceId: s.instB,
    addedBy: s.teacherB,
  });
}

describe("web App reads — caller admission and argument scoping", () => {
  test("a multi-hat caller (parent role + school_admin membership) can read", async () => {
    // requireScholarAdmin (the scholarAdminQuery wrapper) admits a scholar-admin
    // ROLE *or* anyone with school-operations access via a MEMBERSHIP. The scope
    // helper these reads now call used to key only off the top-level role, so a
    // multi-hat caller passed the wrapper and then THREW — a working Apps tab
    // turning into an error, which is a worse regression than the leak this PR
    // closes. Multi-hat staff are an explicitly supported shape in this repo.
    const t = convexTest(schema, modules);
    const s = await setup(t);
    const multiHat = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Sloane Kahale",
        username: "sloane-multihat",
        role: "parent",
      }),
    );
    await grantInstitutionMembership(t, multiHat, s.instA, "school_admin");
    const asMultiHat = await withUser(t, multiHat);

    const rows = await asMultiHat.query(
      api.appAudiences.listAppsWithAudiences,
      {},
    );
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.some((r) => r._id === s.appId)).toBe(true);
  });

  test("a foreign groupId is refused indistinguishably from a missing one", async () => {
    // A valid FOREIGN group id must not succeed where an invalid id throws —
    // that difference is an existence oracle for another school's groups. Same
    // message for both, and the app rows are never filtered either way.
    const t = convexTest(schema, modules);
    const s = await setup(t);
    const asB = await withUser(t, s.teacherB);

    await expect(
      asB.query(api.appAudiences.listAppsWithAudiences, { groupId: s.groupA }),
    ).rejects.toThrow(/Group not found/);

    // Their OWN group still works, and still returns the whole catalog.
    const rows = await asB.query(api.appAudiences.listAppsWithAudiences, {
      groupId: s.groupB,
    });
    expect(rows.some((r) => r._id === s.appId)).toBe(true);
  });
});

describe("listAppsWithAudiences — catalog stays whole, grants are scoped", () => {
  test("a school-B staffer still sees EVERY non-archived app, including one granted only at school A", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);
    // s.appId is granted ONLY at school A.
    await seedGrant(t, {
      appId: s.appId,
      audienceKind: "group",
      audienceId: s.groupA,
      addedBy: s.teacherAcreator,
    });
    await seedGrant(t, {
      appId: s.appId,
      audienceKind: "institution",
      audienceId: s.instA,
      addedBy: s.teacherAcreator,
    });
    // A second global app granted at school B, so the expected set has two ids.
    const appB = await seedNamedApp(t, "Reading Reef");
    await seedGrant(t, {
      appId: appB,
      audienceKind: "group",
      audienceId: s.groupB,
      addedBy: s.teacherB,
    });

    const asB = await withUser(t, s.teacherB);
    const rows = await asB.query(api.appAudiences.listAppsWithAudiences, {});
    const ids = new Set(rows.map((r) => String(r._id)));

    // THE RULING: the catalog is whole. If a future "tidy-up" starts hiding the
    // A-only app from school B, this assertion fails.
    expect(ids).toEqual(new Set([String(s.appId), String(appB)]));
  });

  test("grants on each app row are filtered to the caller's tenant", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);
    // s.appId granted only at school A.
    await seedGrant(t, {
      appId: s.appId,
      audienceKind: "group",
      audienceId: s.groupA,
      addedBy: s.teacherAcreator,
    });
    await seedGrant(t, {
      appId: s.appId,
      audienceKind: "institution",
      audienceId: s.instA,
      addedBy: s.teacherAcreator,
    });

    const asB = await withUser(t, s.teacherB);
    const rowsB = await asB.query(api.appAudiences.listAppsWithAudiences, {});
    const rowB = rowsB.find((r) => String(r._id) === String(s.appId));
    expect(rowB?.audiences).toEqual([]); // school B sees no grants

    const asA = await withUser(t, s.teacherA);
    const rowsA = await asA.query(api.appAudiences.listAppsWithAudiences, {});
    const rowA = rowsA.find((r) => String(r._id) === String(s.appId));
    expect(
      new Set(rowA?.audiences.map((a) => String(a.audienceId))),
    ).toEqual(new Set([String(s.groupA), String(s.instA)]));
  });

  test("directScholarCount and facepile are lens-scoped, not cross-school totals", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);
    // The same app is directly on one scholar at EACH school.
    await seedScholarApp(t, { scholarId: s.scholarA, appId: s.appId });
    await seedScholarApp(t, { scholarId: s.scholarB, appId: s.appId });

    const asB = await withUser(t, s.teacherB);
    const rowsB = await asB.query(api.appAudiences.listAppsWithAudiences, {});
    const rowB = rowsB.find((r) => String(r._id) === String(s.appId));
    expect(rowB?.directScholarCount).toBe(1);
    expect(rowB?.directFacepile.map((f) => String(f._id))).toEqual([
      String(s.scholarB),
    ]);

    const asA = await withUser(t, s.teacherA);
    const rowsA = await asA.query(api.appAudiences.listAppsWithAudiences, {});
    const rowA = rowsA.find((r) => String(r._id) === String(s.appId));
    expect(rowA?.directScholarCount).toBe(1);
    expect(rowA?.directFacepile.map((f) => String(f._id))).toEqual([
      String(s.scholarA),
    ]);
  });

  test("a platform admin sees every grant on the app row (unrestricted scope)", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);
    await grantAppToBothSchools(t, s);
    const adminId = await seedPlatformAdmin(t);
    const asAdmin = await withUser(t, adminId);

    const rows = await asAdmin.query(api.appAudiences.listAppsWithAudiences, {});
    const row = rows.find((r) => String(r._id) === String(s.appId));
    expect(
      new Set(row?.audiences.map((a) => String(a.audienceId))),
    ).toEqual(
      new Set([
        String(s.groupA),
        String(s.instA),
        String(s.groupB),
        String(s.instB),
      ]),
    );
  });
});

describe("listAppsWithAudiences — appKind is derived server-side", () => {
  test("web / custom / native apps each report their canonical appKind", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);

    // s.appId is a plain https web app → "web".
    const customId = await t.run((ctx) =>
      ctx.db.insert("externalApps", {
        name: "Fraction Lab",
        webUrl: "/custom-apps?token=tok-abc",
      }),
    );
    const nativeId = await t.run((ctx) =>
      ctx.db.insert("externalApps", {
        name: "Sheets",
        webUrl: "https://docs.google.com/spreadsheets",
        nativeUrlScheme: "googlesheets://",
      }),
    );

    const asA = await withUser(t, s.teacherA);
    const rows = await asA.query(api.appAudiences.listAppsWithAudiences, {});
    const kindOf = (id: Id<"externalApps">) =>
      rows.find((r) => String(r._id) === String(id))?.appKind;

    expect(kindOf(s.appId)).toBe("web");
    expect(kindOf(customId)).toBe("custom");
    expect(kindOf(nativeId)).toBe("native");
  });
});

describe("listAudiencesForApp — scoped for group AND institution audiences", () => {
  test("a school-B staffer sees only their own group + institution grants", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);
    await grantAppToBothSchools(t, s);

    const asB = await withUser(t, s.teacherB);
    const audB = await asB.query(api.appAudiences.listAudiencesForApp, {
      appId: s.appId,
    });
    expect(new Set(audB.map((a) => String(a.audienceId)))).toEqual(
      new Set([String(s.groupB), String(s.instB)]),
    );
    // Neither the foreign GROUP nor the foreign INSTITUTION leaks through.
    expect(audB.some((a) => String(a.audienceId) === String(s.groupA))).toBe(
      false,
    );
    expect(audB.some((a) => String(a.audienceId) === String(s.instA))).toBe(
      false,
    );
  });

  test("a school-A staffer sees only school A's grants", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);
    await grantAppToBothSchools(t, s);

    const asA = await withUser(t, s.teacherA);
    const audA = await asA.query(api.appAudiences.listAudiencesForApp, {
      appId: s.appId,
    });
    expect(new Set(audA.map((a) => String(a.audienceId)))).toEqual(
      new Set([String(s.groupA), String(s.instA)]),
    );
  });

  test("a platform admin sees all four grants (both schools, both kinds)", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);
    await grantAppToBothSchools(t, s);
    const adminId = await seedPlatformAdmin(t);
    const asAdmin = await withUser(t, adminId);

    const aud = await asAdmin.query(api.appAudiences.listAudiencesForApp, {
      appId: s.appId,
    });
    expect(aud.length).toBe(4);
  });
});

describe("enablementForApp — scoped grants + direct scholars", () => {
  test("a school-B staffer's editor seed omits foreign grants and scholars", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);
    await grantAppToBothSchools(t, s);
    await seedScholarApp(t, { scholarId: s.scholarA, appId: s.appId });
    await seedScholarApp(t, { scholarId: s.scholarB, appId: s.appId });

    const asB = await withUser(t, s.teacherB);
    const enB = await asB.query(api.appAudiences.enablementForApp, {
      appId: s.appId,
    });
    expect(enB.groupIds).toEqual([String(s.groupB)]);
    expect(enB.institutionIds).toEqual([String(s.instB)]);
    expect(enB.direct.map((d) => String(d.scholarId))).toEqual([
      String(s.scholarB),
    ]);
  });

  test("a platform admin's editor seed includes every grant + scholar", async () => {
    const t = convexTest(schema, modules);
    const s = await setup(t);
    await grantAppToBothSchools(t, s);
    await seedScholarApp(t, { scholarId: s.scholarA, appId: s.appId });
    await seedScholarApp(t, { scholarId: s.scholarB, appId: s.appId });
    const adminId = await seedPlatformAdmin(t);
    const asAdmin = await withUser(t, adminId);

    const en = await asAdmin.query(api.appAudiences.enablementForApp, {
      appId: s.appId,
    });
    expect(new Set(en.groupIds)).toEqual(
      new Set([String(s.groupA), String(s.groupB)]),
    );
    expect(new Set(en.institutionIds)).toEqual(
      new Set([String(s.instA), String(s.instB)]),
    );
    expect(new Set(en.direct.map((d) => String(d.scholarId)))).toEqual(
      new Set([String(s.scholarA), String(s.scholarB)]),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// aideGetAppAccess for ONE scholar: can they open it, why, until when
// (TRA-445). The answer is `scholarAppAccess`, the launch gates' own check,
// so these pin its wording and its tenancy; the reader-agreement sweep
// (appAccessAgreement.explore.test.ts) pins its agreement with the tile.
// ─────────────────────────────────────────────────────────────────────────

describe("aideGetAppAccess for one scholar (TRA-445)", () => {
  const TZ = "Pacific/Honolulu"; // no DST, so every local time below is exact
  const hst = (local: string) => Date.parse(`${local}-10:00`);
  // Monday 2026-09-28, Block E 15:05–16:30: its app window is 14:50–16:40.
  const WINDOW_OPENS = hst("2026-09-28T14:50:00");

  afterEach(() => {
    vi.useRealTimers();
  });

  /** `setup`'s two schools, with Moli on a known clock. Every timer is faked,
   *  so a writer's scheduled jobs (auto-clear, allowlist nudge) run only when
   *  a test runs them. */
  async function world(at: number) {
    vi.useFakeTimers();
    vi.setSystemTime(at);
    const t = convexTest(schema, modules);
    const s = await setup(t);
    await t.run((ctx) => ctx.db.patch(s.instA, { timeZone: TZ }));
    return { t, s };
  }

  /** As the tool asks: at the exact (faked) server clock. */
  async function ask(
    t: TestClient,
    callerUserId: Id<"users">,
    scholar?: string,
  ) {
    return await t.query(internal.appAudiences.aideGetAppAccess, {
      callerUserId,
      appName: "Acme Practice",
      now: Date.now(),
      ...(scholar === undefined ? {} : { scholar }),
    });
  }

  async function forScholar(t: TestClient, callerUserId: Id<"users">, scholar: string) {
    const res = await ask(t, callerUserId, scholar);
    if (!res.forScholar) throw new Error("no forScholar in the answer");
    return res.forScholar;
  }

  /** Block E (Mon and Wed) in a term, placed with the app for Moli Geckos on
   *  each of `weekdays` by the aide's own writer, which plans this week's
   *  pushes for them (planned: not set live yet). */
  async function placeBlockE(
    t: TestClient,
    s: Awaited<ReturnType<typeof setup>>,
    weekdays: number[] = [1],
  ): Promise<Id<"schedulePlacements">[]> {
    const { periodId, blockId } = await t.run(async (ctx) => {
      const periodId = await ctx.db.insert("reportingPeriods", {
        label: "Fall 2026",
        startsAt: Date.now() - 30 * 86_400_000,
        endsAt: Date.now() + 60 * 86_400_000,
        status: "open",
        institutionId: s.instA,
      });
      const blockId = await ctx.db.insert("scheduleBlocks", {
        periodId,
        key: "blockE",
        label: "Block E",
        startLocal: "15:05",
        endLocal: "16:30",
        weekdays: [1, 3],
        kind: "class",
        order: 0,
      });
      return { periodId, blockId };
    });
    const placements: Id<"schedulePlacements">[] = [];
    for (const weekday of weekdays) {
      placements.push(
        await t.mutation(internal.masterSchedule.aidePlaceClass, {
          callerUserId: s.teacherA,
          periodId,
          groupId: s.groupA,
          subject: "Robotics",
          teacherId: s.teacherA,
          weekday,
          blockId,
          externalAppId: s.appId,
        }),
      );
    }
    return placements;
  }

  /** Monday's planned push opens at the window's lead-in, as its activation
   *  job does. */
  async function openMondayWindow(t: TestClient, placementId: Id<"schedulePlacements">) {
    const [push] = await t.run((ctx) =>
      ctx.db
        .query("pushes")
        .withIndex("by_schedule_placement", (q) => q.eq("schedulePlacementId", placementId))
        .collect(),
    );
    vi.setSystemTime(WINDOW_OPENS);
    await t.mutation(internal.masterSchedule.activatePlacementAppPush, {
      placementId,
      pushId: push._id,
    });
  }

  test("a direct add and standing grants: each route named, with no set end", async () => {
    const { t, s } = await world(hst("2026-09-28T10:00:00"));
    await seedScholarApp(t, { scholarId: s.scholarA, appId: s.appId });
    await seedGrant(t, {
      appId: s.appId,
      audienceKind: "group",
      audienceId: String(s.groupA),
      addedBy: s.teacherA,
    });
    await seedGrant(t, {
      appId: s.appId,
      audienceKind: "institution",
      audienceId: String(s.instA),
      addedBy: s.teacherA,
    });

    const answer = await forScholar(t, s.teacherA, "oliver-a");
    expect(answer).toMatchObject({
      name: "Oliver Stone",
      username: "oliver-a",
      canOpen: true,
      whyNot: null,
      untilLocal: null,
    });
    expect(answer.via.map((r) => [r.route, r.name, r.untilLocal])).toEqual([
      ["direct", "a direct add to them", null],
      ["school grant", "the school-wide grant at Moli School", null],
      ["group grant", "the Moli Geckos group grant", null],
    ]);
    expect(answer.summary).toBe(
      "Oliver Stone can open Acme Practice via a direct add to them, the school-wide grant at Moli School and the Moli Geckos group grant, with no set end: standing access lasts until someone removes it.",
    );
    // A yes has no "when": it is only for a no.
    expect(answer.when).toBeNull();

    // A "default" row is their own row too, but seeded for every new scholar
    // rather than added for them, and it is named that way.
    const lani = await seedScholarInInstitution(t, {
      institutionId: s.instA,
      name: "Lani Kahale",
      username: "lani-a",
    });
    await seedScholarApp(t, { scholarId: lani, appId: s.appId, source: "default" });
    const lanis = await forScholar(t, s.teacherA, "lani-a");
    expect(lanis.via.map((r) => [r.route, r.name])).toEqual([
      ["direct", "the default apps every new scholar gets"],
      ["school grant", "the school-wide grant at Moli School"],
    ]);
  });

  test("a schedule push: named for its group and block, until its window closes; an overrun, until midnight at the latest", async () => {
    const { t, s } = await world(hst("2026-09-28T14:30:00"));
    const [monday] = await placeBlockE(t, s);
    await openMondayWindow(t, monday);

    // Inside the block: the example TRA-445 asked for.
    vi.setSystemTime(hst("2026-09-28T15:30:00"));
    let answer = await forScholar(t, s.teacherA, "oliver-a");
    expect(answer.canOpen).toBe(true);
    expect(answer.via).toEqual([
      {
        route: "schedule push",
        name: "the Moli Geckos Block E schedule push",
        untilLocal: "2026-09-28, 16:40",
        overrun: false,
        windowEndsLocal: "2026-09-28, 16:40",
      },
    ]);
    expect(answer.untilLocal).toBe("2026-09-28, 16:40");
    expect(answer.summary).toBe(
      "Oliver Stone can open Acme Practice via the Moli Geckos Block E schedule push, until 16:40, when the window closes.",
    );

    // 50 minutes past the window, and the auto-clear never landed: still on
    // the tile (isPushShowing's same-day clause), so still open, but only
    // until the school's midnight, and the answer says why.
    vi.setSystemTime(hst("2026-09-28T17:30:00"));
    const asOliver = await withUser(t, s.scholarA);
    const tile = async () =>
      (await asOliver.query(api.scholarApps.listForLauncher, {})).some(
        (row) => row.appId === s.appId,
      );
    expect(await tile()).toBe(true);
    answer = await forScholar(t, s.teacherA, "oliver-a");
    expect(answer.canOpen).toBe(true);
    expect(answer.via).toEqual([
      expect.objectContaining({
        route: "schedule push",
        untilLocal: "2026-09-29, 00:00",
        overrun: true,
        windowEndsLocal: "2026-09-28, 16:40",
      }),
    ]);
    expect(answer.untilLocal).toBe("2026-09-29, 00:00");
    expect(answer.summary).toBe(
      "Oliver Stone can open Acme Practice via the Moli Geckos Block E schedule push, until midnight at the latest: its window closed at 16:40, but nothing has cleared the push yet (a clear normally lands within minutes).",
    );

    // And it does end then, with the tile. Nothing is planned for next week
    // yet, so the answer states the class's configuration, not a forecast.
    vi.setSystemTime(hst("2026-09-29T00:30:00"));
    expect(await tile()).toBe(false);
    answer = await forScholar(t, s.teacherA, "oliver-a");
    expect(answer).toMatchObject({
      canOpen: false,
      whyNot: "no-route",
      via: [],
      untilLocal: null,
      when: {
        opens: [],
        wrappedToday: [],
        scheduled: [
          {
            name: "Moli Geckos during Block E",
            windowLocal: "Mon 14:50-16:40",
            termStatus: "current",
            termEndsLocal: "Nov 27",
            weekOver: false,
          },
        ],
      },
    });
    expect(answer.summary).toBe(
      "Oliver Stone can't open Acme Practice right now. Acme Practice is scheduled for Moli Geckos during Block E (Mon 14:50-16:40) this term (ends Nov 27).",
    );
  });

  test("before its block, the planned push says when it opens, and the class is stated as configuration", async () => {
    // The 2026-09-21 shape: an app granted only by a class block, asked about
    // a scholar in that class a quarter of an hour before its window.
    const { t, s } = await world(hst("2026-09-28T14:20:00"));
    // Wednesday placed first: the days still read in week order. The writer
    // plans this week's Monday and Wednesday pushes.
    await placeBlockE(t, s, [3, 1]);
    // Last spring's placement, left in place: stated with its ended term,
    // which is why it opens nothing.
    await t.run(async (ctx) => {
      const periodId = await ctx.db.insert("reportingPeriods", {
        label: "Spring 2026",
        startsAt: hst("2026-01-05T00:00:00"),
        endsAt: hst("2026-05-29T00:00:00"),
        status: "closed",
        institutionId: s.instA,
      });
      const blockId = await ctx.db.insert("scheduleBlocks", {
        periodId,
        key: "blockB",
        label: "Block B",
        startLocal: "09:00",
        endLocal: "10:00",
        weekdays: [2],
        kind: "class",
        order: 0,
      });
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId: s.groupA,
        weekday: 2,
        blockId,
        subject: "Robotics",
        externalAppId: s.appId,
      });
    });
    vi.setSystemTime(hst("2026-09-28T14:35:00"));

    const answer = await forScholar(t, s.teacherA, "oliver-a");
    expect(answer).toMatchObject({ canOpen: false, whyNot: "no-route", via: [] });
    // "When" comes from the scheduler's own rows, soonest first.
    expect(answer.when?.opens).toEqual([
      {
        atLocal: "2026-09-28, 14:50",
        name: "for Moli Geckos (Block E)",
        windowLocal: "2026-09-28, 14:50 - 2026-09-28, 16:40",
      },
      {
        atLocal: "2026-09-30, 14:50",
        name: "for Moli Geckos (Block E)",
        windowLocal: "2026-09-30, 14:50 - 2026-09-30, 16:40",
      },
    ]);
    expect(answer.when?.scheduled).toEqual([
      {
        name: "Moli Geckos during Block E",
        windowLocal: "Mon/Wed 14:50-16:40",
        term: "Fall 2026",
        termStatus: "current",
        termStartsLocal: "Aug 29",
        termEndsLocal: "Nov 27",
        weekOver: false,
      },
      {
        name: "Moli Geckos during Block B",
        windowLocal: "Tue 08:45-10:10",
        term: "Spring 2026",
        termStatus: "ended",
        termStartsLocal: "Jan 5",
        termEndsLocal: "May 29",
        weekOver: false,
      },
    ]);
    expect(answer.summary).toBe(
      "Oliver Stone can't open Acme Practice right now. It opens at 14:50 today for Moli Geckos (Block E). Acme Practice is scheduled for Moli Geckos during Block E (Mon/Wed 14:50-16:40) this term (ends Nov 27). Acme Practice is scheduled for Moli Geckos during Block B (Tue 08:45-10:10), but that term ended May 29.",
    );
    expect(answer.summary).not.toMatch(/grant/);

    // A classmate outside Moli Geckos: nothing is scheduled for them, said
    // plainly.
    await seedScholarInInstitution(t, {
      institutionId: s.instA,
      name: "Lani Kahale",
      username: "lani-a",
    });
    const lanis = await forScholar(t, s.teacherA, "lani-a");
    expect(lanis).toMatchObject({
      canOpen: false,
      whyNot: "no-route",
      when: { opens: [], wrappedToday: [], scheduled: [] },
    });
    expect(lanis.summary).toBe(
      "Lani Kahale can't open Acme Practice right now, and no class they're in is on their school's schedule for it.",
    );
  });

  test("a wrapped-up session is stated as wrapped up, never as about to open", async () => {
    const { t, s } = await world(hst("2026-09-28T14:30:00"));
    const [monday] = await placeBlockE(t, s);
    await openMondayWindow(t, monday);
    // Mid-block, the teacher wraps it up.
    vi.setSystemTime(hst("2026-09-28T15:30:00"));
    const [push] = await t.run((ctx) =>
      ctx.db
        .query("pushes")
        .withIndex("by_schedule_placement", (q) => q.eq("schedulePlacementId", monday))
        .collect(),
    );
    await (await withUser(t, s.teacherA)).mutation(api.pushes.clearPush, { pushId: push._id });

    vi.setSystemTime(hst("2026-09-28T15:40:00"));
    const answer = await forScholar(t, s.teacherA, "oliver-a");
    expect(answer.canOpen).toBe(false);
    expect(answer.when).toMatchObject({
      opens: [],
      wrappedToday: [
        {
          name: "today's Block E session for Moli Geckos",
          atLocal: "2026-09-28, 15:30",
          opened: true,
        },
      ],
    });
    expect(answer.summary).toBe(
      "Oliver Stone can't open Acme Practice right now. Today's Block E session for Moli Geckos was wrapped up at 15:30. Acme Practice is scheduled for Moli Geckos during Block E (Mon 14:50-16:40) this term (ends Nov 27).",
    );
  });

  test("a session called off before it opened is stated as called off", async () => {
    const { t, s } = await world(hst("2026-09-28T13:00:00"));
    const [monday] = await placeBlockE(t, s);
    const [push] = await t.run((ctx) =>
      ctx.db
        .query("pushes")
        .withIndex("by_schedule_placement", (q) => q.eq("schedulePlacementId", monday))
        .collect(),
    );
    vi.setSystemTime(hst("2026-09-28T14:00:00"));
    await (await withUser(t, s.teacherA)).mutation(api.pushes.clearPush, { pushId: push._id });

    vi.setSystemTime(hst("2026-09-28T14:10:00"));
    const answer = await forScholar(t, s.teacherA, "oliver-a");
    expect(answer.when?.opens).toEqual([]);
    expect(answer.when?.wrappedToday).toEqual([
      { name: "today's Block E session for Moli Geckos", atLocal: "2026-09-28, 14:00", opened: false },
    ]);
    expect(answer.summary).toMatch(
      /^Oliver Stone can't open Acme Practice right now\. Today's Block E session for Moli Geckos was called off at 14:00\./,
    );
  });

  describe("a teacher's clear is a wrap-up only when it ended a session of theirs", () => {
    /** Block E on Monday and Wednesday in the Fall term, placed by the
     *  aide's writer, which plans this week's pushes for both days. */
    async function blockE(t: TestClient, s: Awaited<ReturnType<typeof setup>>) {
      const { periodId, blockId } = await t.run(async (ctx) => {
        const periodId = await ctx.db.insert("reportingPeriods", {
          label: "Fall 2026",
          startsAt: Date.now() - 30 * 86_400_000,
          endsAt: Date.now() + 60 * 86_400_000,
          status: "open",
          institutionId: s.instA,
        });
        const blockId = await ctx.db.insert("scheduleBlocks", {
          periodId,
          key: "blockE",
          label: "Block E",
          startLocal: "15:05",
          endLocal: "16:30",
          weekdays: [1, 3],
          kind: "class",
          order: 0,
        });
        return { periodId, blockId };
      });
      const place = (weekday: number) =>
        t.mutation(internal.masterSchedule.aidePlaceClass, {
          callerUserId: s.teacherA,
          periodId,
          groupId: s.groupA,
          subject: "Robotics",
          teacherId: s.teacherA,
          weekday,
          blockId,
          externalAppId: s.appId,
        });
      return { place };
    }
    const pushesOf = (t: TestClient, placementId: Id<"schedulePlacements">) =>
      t.run((ctx) =>
        ctx.db
          .query("pushes")
          .withIndex("by_schedule_placement", (q) => q.eq("schedulePlacementId", placementId))
          .collect(),
      );

    test("a deleted class ends no session (and a re-placed one still opens today)", async () => {
      const { t, s } = await world(hst("2026-09-28T09:00:00"));
      const { place } = await blockE(t, s);
      const asTeacher = await withUser(t, s.teacherA);
      const first = await place(1);
      // Deleting it clears its push with the "teacher" reason
      // (settlePlacementAppPush).
      vi.setSystemTime(hst("2026-09-28T10:00:00"));
      await asTeacher.mutation(api.masterSchedule.removePlacement, { placementId: first });
      vi.setSystemTime(hst("2026-09-28T10:05:00"));
      let answer = await forScholar(t, s.teacherA, "oliver-a");
      expect(answer.when).toEqual({ opens: [], wrappedToday: [], scheduled: [] });
      expect(answer.summary).toBe(
        "Oliver Stone can't open Acme Practice right now, and no class they're in is on their school's schedule for it.",
      );

      // Placed again: it opens today, and nothing says it was called off.
      await place(1);
      answer = await forScholar(t, s.teacherA, "oliver-a");
      expect(answer.when?.opens.map((o) => o.atLocal)).toEqual(["2026-09-28, 14:50"]);
      expect(answer.when?.wrappedToday).toEqual([]);
      expect(answer.summary).not.toMatch(/called off|wrapped up/);
    });

    test("an app detached from a class ends no session", async () => {
      const { t, s } = await world(hst("2026-09-28T09:00:00"));
      const { place } = await blockE(t, s);
      const monday = await place(1);
      // Detaching clears its push with the "teacher" reason
      // (coreUpdatePlacement); the class itself still meets.
      vi.setSystemTime(hst("2026-09-28T10:00:00"));
      await (await withUser(t, s.teacherA)).mutation(api.masterSchedule.updatePlacement, {
        placementId: monday,
        externalAppId: null,
      });
      vi.setSystemTime(hst("2026-09-28T10:05:00"));
      const answer = await forScholar(t, s.teacherA, "oliver-a");
      expect(answer.when).toEqual({ opens: [], wrappedToday: [], scheduled: [] });
      expect(answer.summary).not.toMatch(/called off|wrapped up/);
    });

    test("a session a newer push covers again is not wrapped up", async () => {
      const { t, s } = await world(hst("2026-09-28T12:00:00"));
      const asTeacher = await withUser(t, s.teacherA);
      const pushId = await asTeacher.mutation(api.pushes.makeFocus, {
        scholarIds: [s.scholarA],
        target: { kind: "app", externalAppId: s.appId },
      });
      vi.setSystemTime(hst("2026-09-28T13:00:00"));
      await asTeacher.mutation(api.pushes.clearPush, { pushId });
      // Wrapped up, and nothing newer: it is stated.
      vi.setSystemTime(hst("2026-09-28T13:05:00"));
      expect((await forScholar(t, s.teacherA, "oliver-a")).when?.wrappedToday).toEqual([
        { name: "Hoku Makani's push to them alone", atLocal: "2026-09-28, 13:00", opened: true },
      ]);
      // A newer push planned for them today covers that day's session again.
      await t.run((ctx) =>
        ctx.db.insert("pushes", {
          institutionId: s.instA,
          target: { kind: "app", externalAppId: s.appId },
          audience: { kind: "scholars", scholarIds: [s.scholarA] },
          timing: { kind: "focus", endsAt: hst("2026-09-28T16:00:00") },
          blocking: false,
          pushedBy: s.teacherA,
          startsAt: hst("2026-09-28T15:00:00"),
        }),
      );
      const answer = await forScholar(t, s.teacherA, "oliver-a");
      expect(answer.when?.wrappedToday).toEqual([]);
      expect(answer.when?.opens.map((o) => o.atLocal)).toEqual(["2026-09-28, 15:00"]);
    });

    test("another day's session called off today is not today's", async () => {
      const { t, s } = await world(hst("2026-09-28T09:00:00"));
      const { place } = await blockE(t, s);
      await place(1);
      const wednesday = await place(3);
      // On Monday, the teacher calls off Wednesday's planned session.
      const [wednesdays] = await pushesOf(t, wednesday);
      vi.setSystemTime(hst("2026-09-28T10:00:00"));
      await (await withUser(t, s.teacherA)).mutation(api.pushes.clearPush, {
        pushId: wednesdays._id,
      });
      vi.setSystemTime(hst("2026-09-28T10:05:00"));
      const answer = await forScholar(t, s.teacherA, "oliver-a");
      expect(answer.when?.wrappedToday).toEqual([]);
      expect(answer.when?.opens.map((o) => o.atLocal)).toEqual(["2026-09-28, 14:50"]);
      expect(answer.summary).not.toMatch(/called off/);
    });

    test("a session that never covered them is not theirs to have wrapped up", async () => {
      const { t, s } = await world(hst("2026-09-28T09:00:00"));
      const lani = await seedScholarInInstitution(t, {
        institutionId: s.instA,
        name: "Lani Kahale",
        username: "lani-a",
      });
      const asTeacher = await withUser(t, s.teacherA);
      const pushId = await asTeacher.mutation(api.pushes.makeFocus, {
        scholarIds: [lani],
        target: { kind: "app", externalAppId: s.appId },
      });
      vi.setSystemTime(hst("2026-09-28T10:00:00"));
      await asTeacher.mutation(api.pushes.clearPush, { pushId });
      vi.setSystemTime(hst("2026-09-28T10:05:00"));
      expect((await forScholar(t, s.teacherA, "oliver-a")).when?.wrappedToday).toEqual([]);
      // Positive control: it is Lani's.
      expect((await forScholar(t, s.teacherA, "lani-a")).when?.wrappedToday).toEqual([
        { name: "Hoku Makani's push to them alone", atLocal: "2026-09-28, 10:00", opened: true },
      ]);
    });
  });

  test("a class with no teacher opens like any other; one in a term that has not started says why it won't open", async () => {
    const { t, s } = await world(hst("2026-09-28T13:00:00"));
    // By the aide's writer with no teacher: the scheduler plans its push all
    // the same (TRA-450).
    const { periodId, blockId } = await t.run(async (ctx) => {
      const periodId = await ctx.db.insert("reportingPeriods", {
        label: "Fall 2026",
        startsAt: Date.now() - 30 * 86_400_000,
        endsAt: Date.now() + 60 * 86_400_000,
        status: "open",
        institutionId: s.instA,
      });
      const blockId = await ctx.db.insert("scheduleBlocks", {
        periodId,
        key: "blockE",
        label: "Block E",
        startLocal: "15:05",
        endLocal: "16:30",
        weekdays: [1],
        kind: "class",
        order: 0,
      });
      return { periodId, blockId };
    });
    await t.mutation(internal.masterSchedule.aidePlaceClass, {
      callerUserId: s.teacherA,
      periodId,
      groupId: s.groupA,
      subject: "Robotics",
      weekday: 1,
      blockId,
      externalAppId: s.appId,
    });
    // Next term's placement, as it sits before its term starts (the cron
    // materializes only a term that spans today).
    await t.run(async (ctx) => {
      const winter = await ctx.db.insert("reportingPeriods", {
        label: "Winter 2026",
        startsAt: hst("2026-10-12T00:00:00"),
        endsAt: hst("2026-12-18T00:00:00"),
        status: "upcoming",
        institutionId: s.instA,
      });
      const blockC = await ctx.db.insert("scheduleBlocks", {
        periodId: winter,
        key: "blockC",
        label: "Block C",
        startLocal: "10:00",
        endLocal: "11:00",
        weekdays: [3],
        kind: "class",
        order: 0,
      });
      await ctx.db.insert("schedulePlacements", {
        periodId: winter,
        groupId: s.groupA,
        weekday: 3,
        blockId: blockC,
        subject: "Robotics",
        teacherId: s.teacherA,
        externalAppId: s.appId,
      });
    });

    const answer = await forScholar(t, s.teacherA, "oliver-a");
    expect(answer.when?.opens).toEqual([
      {
        atLocal: "2026-09-28, 14:50",
        name: "for Moli Geckos (Block E)",
        windowLocal: "2026-09-28, 14:50 - 2026-09-28, 16:40",
      },
    ]);
    expect(answer.when?.scheduled.map((c) => [c.name, c.termStatus])).toEqual([
      ["Moli Geckos during Block E", "current"],
      ["Moli Geckos during Block C", "upcoming"],
    ]);
    expect(answer.summary).toBe(
      "Oliver Stone can't open Acme Practice right now. It opens at 14:50 today for Moli Geckos (Block E). Acme Practice is scheduled for Moli Geckos during Block E (Mon 14:50-16:40) this term (ends Nov 27). Acme Practice is scheduled for Moli Geckos during Block C (Wed 09:45-11:10), but that term starts Oct 12.",
    );
  });

  test("another school's term never appears, as a placement or as a push's block", async () => {
    const { t, s } = await world(hst("2026-09-28T13:00:00"));
    // A legacy UNSTAMPED group holding a Moli scholar, placed in KULA's term.
    // The scheduler stamps its push with the primary school (Moli), so the
    // push reaches Oliver, but the term and block are Kula's.
    await t.run(async (ctx) => {
      const legacy = await ctx.db.insert("scholarGroups", {
        teacherId: s.teacherA,
        name: "Old Robotics",
        scholarIds: [s.scholarA],
      });
      const kulaTerm = await ctx.db.insert("reportingPeriods", {
        label: "Kula Fall 2026",
        startsAt: Date.now() - 30 * 86_400_000,
        endsAt: Date.now() + 60 * 86_400_000,
        status: "open",
        institutionId: s.instB,
      });
      const blockK = await ctx.db.insert("scheduleBlocks", {
        periodId: kulaTerm,
        key: "blockK",
        label: "Kula Block K",
        startLocal: "12:45",
        endLocal: "14:00",
        weekdays: [1],
        kind: "class",
        order: 0,
      });
      const placementId = await ctx.db.insert("schedulePlacements", {
        periodId: kulaTerm,
        groupId: legacy,
        weekday: 1,
        blockId: blockK,
        subject: "Robotics",
        teacherId: s.teacherB,
        externalAppId: s.appId,
      });
      await ctx.db.insert("pushes", {
        institutionId: s.instA,
        target: { kind: "app", externalAppId: s.appId },
        audience: { kind: "group", groupId: legacy },
        timing: { kind: "focus", endsAt: hst("2026-09-28T14:10:00") },
        blocking: false,
        pushedBy: s.teacherB,
        setAt: hst("2026-09-28T12:30:00"),
        startsAt: hst("2026-09-28T12:30:00"),
        schedulePlacementId: placementId,
        occurrenceDate: "2026-09-28",
      });
    });

    // Live: the push route is named without Kula's block.
    const live = await forScholar(t, s.teacherA, "oliver-a");
    expect(live.via.map((r) => r.name)).toEqual(["the Old Robotics schedule push"]);
    expect(JSON.stringify(live)).not.toMatch(/Kula/);

    // Not live: the placement in Kula's term is not listed at all.
    vi.setSystemTime(hst("2026-09-29T09:00:00"));
    const later = await forScholar(t, s.teacherA, "oliver-a");
    expect(later.canOpen).toBe(false);
    expect(later.when?.scheduled).toEqual([]);
    expect(JSON.stringify(later)).not.toMatch(/Kula/);
  });

  test("identical placements read once; a one-week placement names its week", async () => {
    const { t, s } = await world(hst("2026-09-28T09:00:00"));
    await t.run(async (ctx) => {
      const periodId = await ctx.db.insert("reportingPeriods", {
        label: "Fall 2026",
        startsAt: Date.now() - 30 * 86_400_000,
        endsAt: Date.now() + 60 * 86_400_000,
        status: "open",
        institutionId: s.instA,
      });
      const blockId = await ctx.db.insert("scheduleBlocks", {
        periodId,
        key: "blockE",
        label: "Block E",
        startLocal: "15:05",
        endLocal: "16:30",
        weekdays: [1],
        kind: "class",
        order: 0,
      });
      const placement = {
        periodId,
        groupId: s.groupA,
        weekday: 1,
        blockId,
        subject: "Robotics",
        teacherId: s.teacherA,
        externalAppId: s.appId,
      };
      await ctx.db.insert("schedulePlacements", placement);
      await ctx.db.insert("schedulePlacements", placement); // a duplicated row
      await ctx.db.insert("schedulePlacements", {
        ...placement,
        weekStartMs: hst("2026-10-05T00:00:00"),
      });
    });
    const answer = await forScholar(t, s.teacherA, "oliver-a");
    expect(answer.when?.scheduled.map((c) => c.windowLocal)).toEqual([
      "Mon 14:50-16:40",
      "Mon 14:50-16:40, week of Oct 5 only",
    ]);
    expect(answer.summary).toBe(
      "Oliver Stone can't open Acme Practice right now. Acme Practice is scheduled for Moli Geckos during Block E (Mon 14:50-16:40) this term (ends Nov 27). Acme Practice is scheduled for Moli Geckos during Block E (Mon 14:50-16:40, week of Oct 5 only) this term (ends Nov 27).",
    );
  });

  test("a push planned for them but not yet open is when they can", async () => {
    const { t, s } = await world(hst("2026-09-28T08:00:00"));
    // No writer plans an app push outside the master schedule today; the rule
    // covers any planned push, so one is seeded as a teacher's would look.
    await t.run((ctx) =>
      ctx.db.insert("pushes", {
        institutionId: s.instA,
        target: { kind: "app", externalAppId: s.appId },
        audience: { kind: "scholars", scholarIds: [s.scholarA] },
        timing: { kind: "focus", endsAt: hst("2026-09-28T10:00:00") },
        blocking: false,
        pushedBy: s.teacherA,
        startsAt: hst("2026-09-28T09:00:00"),
      }),
    );
    const answer = await forScholar(t, s.teacherA, "oliver-a");
    expect(answer.when).toEqual({
      opens: [
        {
          atLocal: "2026-09-28, 09:00",
          name: "with Hoku Makani's push to them alone",
          windowLocal: "2026-09-28, 09:00 - 2026-09-28, 10:00",
        },
      ],
      wrappedToday: [],
      scheduled: [],
    });
    expect(answer.summary).toBe(
      "Oliver Stone can't open Acme Practice right now. It opens at 09:00 today with Hoku Makani's push to them alone.",
    );
  });

  test("a teacher's push to a list of scholars, or to an assignment roster: the case the roster can only count", async () => {
    const { t, s } = await world(hst("2026-09-28T13:00:00"));
    const lani = await seedScholarInInstitution(t, {
      institutionId: s.instA,
      name: "Lani Kahale",
      username: "lani-a",
    });
    const asTeacher = await withUser(t, s.teacherA);
    await asTeacher.mutation(api.pushes.makeFocus, {
      scholarIds: [s.scholarA],
      target: { kind: "app", externalAppId: s.appId },
    });

    const res = await ask(t, s.teacherA, "oliver-a");
    // The app-wide roster says only "1 scholar"…
    expect(res.pushes).toEqual([expect.objectContaining({ live: true, group: "1 scholar" })]);
    // …and asked by name, the aide says who.
    expect(res.forScholar).toMatchObject({
      canOpen: true,
      untilLocal: "2026-09-28, 14:00",
      via: [
        {
          route: "teacher push",
          name: "Hoku Makani's push to them alone",
          untilLocal: "2026-09-28, 14:00",
          overrun: false,
          windowEndsLocal: "2026-09-28, 14:00",
        },
      ],
    });
    expect(res.forScholar?.summary).toBe(
      "Oliver Stone can open Acme Practice via Hoku Makani's push to them alone, until 14:00, when the window closes.",
    );
    // A classmate the list leaves out cannot.
    expect(await forScholar(t, s.teacherA, "lani-a")).toMatchObject({
      canOpen: false,
      whyNot: "no-route",
      via: [],
    });

    // An assignment roster. No writer gives an APP push this audience today
    // (the sweep seeds it for the same reason: the lookup reads it).
    await t.run(async (ctx) => {
      const assignmentId = await ctx.db.insert("assignments", {
        teacherId: s.teacherA,
        scholarIds: [s.scholarA, lani],
        startedAt: Date.now(),
      });
      await ctx.db.insert("pushes", {
        institutionId: s.instA,
        target: { kind: "app", externalAppId: s.appId },
        audience: { kind: "assignment", assignmentId },
        timing: { kind: "focus", endsAt: hst("2026-09-28T13:45:00") },
        blocking: false,
        pushedBy: s.teacherAcreator,
        setAt: Date.now(),
      });
    });
    const lanis = await forScholar(t, s.teacherA, "lani-a");
    expect(lanis).toMatchObject({ canOpen: true, untilLocal: "2026-09-28, 13:45" });
    expect(lanis.via.map((r) => r.name)).toEqual([
      "Lehua Torres's push to an assignment roster of 2 scholars",
    ]);
    // Oliver now holds two pushes; access lasts until the later one ends.
    const olivers = await forScholar(t, s.teacherA, "oliver-a");
    expect(olivers.via.map((r) => r.route)).toEqual(["teacher push", "teacher push"]);
    expect(olivers.untilLocal).toBe("2026-09-28, 14:00");
  });

  test("can't open: nothing is set up for them, or the app is archived", async () => {
    const { t, s } = await world(hst("2026-09-28T10:00:00"));
    let answer = await forScholar(t, s.teacherA, "Oliver Stone");
    expect(answer).toMatchObject({
      canOpen: false,
      whyNot: "no-route",
      via: [],
      untilLocal: null,
      when: { opens: [], wrappedToday: [], scheduled: [] },
    });
    expect(answer.summary).toBe(
      "Oliver Stone can't open Acme Practice right now, and no class they're in is on their school's schedule for it.",
    );

    // Archived: nothing opens it, so no "when" is offered.
    await seedScholarApp(t, { scholarId: s.scholarA, appId: s.appId });
    await t.run((ctx) => ctx.db.patch(s.appId, { archived: true }));
    answer = await forScholar(t, s.teacherA, "oliver-a");
    expect(answer).toMatchObject({ canOpen: false, whyNot: "archived", via: [], when: null });
    expect(answer.summary).toBe(
      "Oliver Stone can't open Acme Practice: it is archived, so nothing opens it until it is restored.",
    );
  });

  test("a group from another school counts toward access but is never named to this school", async () => {
    const { t, s } = await world(hst("2026-09-28T10:00:00"));
    // A Kula-stamped group whose roster holds a Moli scholar. The writers
    // refuse to build one; the grant scan still reads it, as the tile does.
    const kulaGroup = await seedGroup(t, {
      teacherId: s.teacherB,
      institutionId: s.instB,
      name: "Kula Robotics Club",
      scholarIds: [s.scholarA],
    });
    await seedGrant(t, {
      appId: s.appId,
      audienceKind: "group",
      audienceId: String(kulaGroup),
      addedBy: s.teacherB,
    });
    // Positive control: the grant really does put the app on Oliver's tile.
    const asOliver = await withUser(t, s.scholarA);
    expect(
      (await asOliver.query(api.scholarApps.listForLauncher, {})).some(
        (row) => row.appId === s.appId,
      ),
    ).toBe(true);

    const res = await ask(t, s.teacherA, "oliver-a");
    expect(res.forScholar).toMatchObject({
      canOpen: true,
      via: [{ route: "group grant", name: "a group grant to a group not visible to you" }],
    });
    expect(JSON.stringify(res)).not.toMatch(/Kula Robotics Club/);

    // The filter is the caller's scope, not a blanket one: a platform admin,
    // whose scope is every school, is told the name.
    const adminId = await seedPlatformAdmin(t);
    const asAdmin = await forScholar(t, adminId, "oliver-a");
    expect(asAdmin.via.map((r) => r.name)).toEqual(["the Kula Robotics Club group grant"]);
  });

  test("the teacher app panel's via-group chip never names another school's group (TRA-447)", async () => {
    const { t, s } = await world(hst("2026-09-28T10:00:00"));
    const kulaGroup = await seedGroup(t, {
      teacherId: s.teacherB,
      institutionId: s.instB,
      name: "Kula Robotics Club",
      scholarIds: [s.scholarA],
    });
    await seedGrant(t, {
      appId: s.appId,
      audienceKind: "group",
      audienceId: String(kulaGroup),
      addedBy: s.teacherB,
    });
    // Positive control: a group from the teacher's OWN school granting the
    // same app is still named.
    const moliGroup = await seedGroup(t, {
      teacherId: s.teacherA,
      institutionId: s.instA,
      name: "Moli Makers",
      scholarIds: [s.scholarA],
    });
    await seedGrant(t, {
      appId: s.appId,
      audienceKind: "group",
      audienceId: String(moliGroup),
      addedBy: s.teacherA,
    });

    // The grant still counts: the app is on the panel, granted via a group…
    const asTeacher = await withUser(t, s.teacherA);
    const rows = await asTeacher.query(api.scholarApps.listForScholar, {
      scholarId: s.scholarA,
    });
    const row = rows.find((r) => r.appId === s.appId);
    const byId = new Map(row?.grantGroups.map((g) => [g.id, g]));
    expect(row?.grantGroups).toHaveLength(2);
    expect(byId.get(kulaGroup)).toEqual({
      id: kulaGroup,
      name: "a group not visible to you",
      emoji: null,
    });
    expect(byId.get(moliGroup)?.name).toBe("Moli Makers");
    // …but the other school's group is never named.
    expect(JSON.stringify(rows)).not.toMatch(/Kula Robotics Club/);

    // Positive control: a platform admin's scope is every school, so they see it.
    const adminId = await seedPlatformAdmin(t);
    const asAdmin = await withUser(t, adminId);
    const adminRows = await asAdmin.query(api.scholarApps.listForScholar, {
      scholarId: s.scholarA,
    });
    expect(
      adminRows.find((r) => r.appId === s.appId)?.grantGroups.map((g) => g.name).sort(),
    ).toEqual(["Kula Robotics Club", "Moli Makers"]);
  });

  test("a push to a group the caller cannot see keeps the group's name out of the answer, on both push paths", async () => {
    const { t, s } = await world(hst("2026-09-28T13:00:00"));
    // A legacy UNSTAMPED group: the primary school's by the push writer's
    // rule, but its roster reaches a Kula scholar, so `isGroupInScope` hides
    // it from a Moli teacher.
    const legacy = await t.run((ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: s.teacherA,
        name: "Legacy Geckos",
        scholarIds: [s.scholarA, s.scholarB],
      }),
    );
    // A teacher's push to it, by the real writer…
    const asTeacher = await withUser(t, s.teacherA);
    await asTeacher.mutation(api.pushes.makeFocus, {
      groupId: legacy,
      target: { kind: "app", externalAppId: s.appId },
    });
    // …and a block's push to it, live since its lead-in, as the materializer
    // leaves one.
    await t.run(async (ctx) => {
      const periodId = await ctx.db.insert("reportingPeriods", {
        label: "Fall 2026",
        startsAt: Date.now() - 30 * 86_400_000,
        endsAt: Date.now() + 60 * 86_400_000,
        status: "open",
        institutionId: s.instA,
      });
      const blockId = await ctx.db.insert("scheduleBlocks", {
        periodId,
        key: "blockR",
        label: "Block R",
        startLocal: "13:00",
        endLocal: "14:00",
        weekdays: [1],
        kind: "class",
        order: 0,
      });
      const placementId = await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId: legacy,
        weekday: 1,
        blockId,
        subject: "Robotics",
        externalAppId: s.appId,
      });
      await ctx.db.insert("pushes", {
        institutionId: s.instA,
        target: { kind: "app", externalAppId: s.appId },
        audience: { kind: "group", groupId: legacy },
        timing: { kind: "focus", endsAt: hst("2026-09-28T14:10:00") },
        blocking: false,
        pushedBy: s.teacherA,
        setAt: hst("2026-09-28T12:45:00"),
        startsAt: hst("2026-09-28T12:45:00"),
        schedulePlacementId: placementId,
        occurrenceDate: "2026-09-28",
      });
    });

    const res = await ask(t, s.teacherA, "oliver-a");
    expect(res.forScholar?.canOpen).toBe(true);
    expect(res.forScholar?.via.map((r) => `${r.route}: ${r.name}`).sort()).toEqual([
      "schedule push: a schedule push to a group not visible to you",
      "teacher push: Hoku Makani's push to a group not visible to you",
    ]);
    expect(JSON.stringify(res.forScholar)).not.toMatch(/Legacy Geckos/);
    // The app-wide list names a push's group by the push's school instead,
    // so it still says "Legacy Geckos": the difference groupLabelInScope's
    // comment records.
    expect(res.pushes.map((p) => p.group)).toContain("Legacy Geckos");

    // Wrapped up, both pushes and the placement behind one are stated as
    // facts, and the group stays unnamed on all three paths.
    vi.setSystemTime(hst("2026-09-28T13:20:00"));
    const open = await t.run((ctx) => ctx.db.query("pushes").collect());
    for (const push of open) await asTeacher.mutation(api.pushes.clearPush, { pushId: push._id });
    vi.setSystemTime(hst("2026-09-28T13:30:00"));
    const after = await forScholar(t, s.teacherA, "oliver-a");
    expect(after.canOpen).toBe(false);
    expect(after.when?.wrappedToday.map((w) => w.name).sort()).toEqual([
      "Hoku Makani's push to a group not visible to you",
      "today's Block R session for a group not visible to you",
    ]);
    expect(after.when?.scheduled.map((c) => c.name)).toEqual([
      "a group not visible to you during Block R",
    ]);
    expect(JSON.stringify(after)).not.toMatch(/Legacy Geckos/);
  });

  test("a re-push is one name in the sentence and two routes in `via`", async () => {
    const { t, s } = await world(hst("2026-09-28T13:00:00"));
    const asTeacher = await withUser(t, s.teacherA);
    const pushToOliver = () =>
      asTeacher.mutation(api.pushes.makeFocus, {
        scholarIds: [s.scholarA],
        target: { kind: "app", externalAppId: s.appId },
        durationMin: 30,
      });
    await pushToOliver();
    vi.setSystemTime(hst("2026-09-28T13:10:00"));
    await pushToOliver();
    const answer = await forScholar(t, s.teacherA, "oliver-a");
    expect(answer.via.map((r) => r.name)).toEqual([
      "Hoku Makani's push to them alone",
      "Hoku Makani's push to them alone",
    ]);
    // Access lasts until the later of the two ends.
    expect(answer.summary).toBe(
      "Oliver Stone can open Acme Practice via Hoku Makani's push to them alone, until 13:40, when the window closes.",
    );
  });

  test("a scholar outside the caller's school is not found, exactly like a name that matches no one", async () => {
    const { t, s } = await world(hst("2026-09-28T10:00:00"));
    await seedScholarApp(t, { scholarId: s.scholarA, appId: s.appId });
    const refusal = async (scholar: string) => {
      try {
        await ask(t, s.teacherB, scholar);
      } catch (error) {
        return (error instanceof Error ? error.message : String(error)).replace(scholar, "<q>");
      }
      throw new Error(`asking about ${scholar} did not refuse`);
    };
    const foreign = await refusal("oliver-a");
    expect(foreign).toMatch(/No scholar matches "<q>"/);
    expect(foreign).toBe(await refusal("nobody-here"));
    expect(await refusal("Oliver Stone")).toBe(foreign);
    // Their own scholar resolves.
    expect((await forScholar(t, s.teacherB, "kai-b")).canOpen).toBe(false);
  });

  test("without `scholar`, the answer is the app-wide one, unchanged", async () => {
    const { t, s } = await world(hst("2026-09-28T13:00:00"));
    await seedScholarApp(t, { scholarId: s.scholarA, appId: s.appId });
    const asTeacher = await withUser(t, s.teacherA);
    await asTeacher.mutation(api.pushes.makeFocus, {
      scholarIds: [s.scholarA],
      target: { kind: "app", externalAppId: s.appId },
    });
    const plain = await ask(t, s.teacherA);
    expect(plain).not.toHaveProperty("forScholar");
    const { forScholar: named, ...rest } = await ask(t, s.teacherA, "oliver-a");
    expect(named?.canOpen).toBe(true);
    expect(rest).toEqual(plain);
  });
});
