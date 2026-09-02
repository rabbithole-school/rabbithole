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
import { describe, expect, test } from "vitest";
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
