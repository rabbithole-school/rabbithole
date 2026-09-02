import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  generateAppToken,
  customAppUrl,
  customAppPath,
  MAX_STATIC_HTML_BYTES,
} from "../customApps";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedScholar(t: ReturnType<typeof convexTest>, name: string) {
  return await t.run((ctx) =>
    ctx.db.insert("users", {
      name,
      username: name.toLowerCase().replace(/\s+/g, "-"),
      role: "scholar",
    }),
  );
}

async function seedTeacher(t: ReturnType<typeof convexTest>) {
  return await t.run((ctx) =>
    ctx.db.insert("users", {
      name: "Test Teacher",
      username: `teacher-${Math.random().toString(36).slice(2, 8)}`,
      role: "teacher",
    }),
  );
}

async function seedGroup(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  name: string,
  scholarIds: Id<"users">[],
) {
  return await t.run((ctx) =>
    ctx.db.insert("scholarGroups", { teacherId, name, scholarIds }),
  );
}

describe("customApps helpers", () => {
  test("generateAppToken is 48 hex chars (192 bits) and unique", () => {
    const a = generateAppToken();
    const b = generateAppToken();
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(a).not.toBe(b);
  });

  test("customAppUrl builds the canonical /custom-apps?token= url", () => {
    expect(customAppUrl("abc123")).toBe(
      "https://rabbithole.test/custom-apps?token=abc123",
    );
  });

  test("customAppPath is domain-agnostic (a bare /custom-apps?token= path)", () => {
    expect(customAppPath("abc123")).toBe("/custom-apps?token=abc123");
  });

  test("MAX_STATIC_HTML_BYTES stays well under Convex's ~1MB value limit", () => {
    expect(MAX_STATIC_HTML_BYTES).toBeLessThan(1024 * 1024);
    expect(MAX_STATIC_HTML_BYTES).toBeGreaterThan(0);
  });
});

describe("installExistingUrlApp", () => {
  test("rejects a scholar outside the supplied aide lens", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const allowed = await seedScholar(t, "Allowed Scholar");
    const outside = await seedScholar(t, "Outside Scholar");

    await expect(
      t.mutation(internal.customApps.installExistingUrlApp, {
        name: "Desmos",
        webUrl: "https://www.desmos.com/calculator",
        callerUserId: teacher,
        // These fixtures stand in for an unrestricted (platform-admin) caller: the
        // lens WAS resolved, it just imposes no restriction. assertTargetsWithinLens
        // now fails closed without this, which is the point of the flag.
        scholarLensResolved: true,
        scholarIds: [outside],
        groupIds: [],
        allowedScholarIds: [allowed],
      }),
    ).rejects.toThrow("outside the active institution view");
  });

  test("fails CLOSED when no lens was ever resolved for the caller", async () => {
    // The old guard began `if (!allowedScholarIds) return;`, so a caller that
    // never resolved a lens read as "no restrictions apply" — which is exactly
    // how the MCP write path reached other schools' scholars. Omitting BOTH
    // the id set and the resolved flag must now refuse the install outright.
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const scholar = await seedScholar(t, "Unlensed Target");

    await expect(
      t.mutation(internal.customApps.installExistingUrlApp, {
        name: "Desmos",
        webUrl: "https://www.desmos.com/calculator",
        callerUserId: teacher,
        scholarIds: [scholar],
        groupIds: [],
      }),
    ).rejects.toThrow("no institution scholar lens was resolved");
  });

  test("an explicitly unrestricted caller (platform admin) may still install", async () => {
    // The legitimate no-id-set case: a lens WAS resolved and imposes no
    // restriction. This must not be caught by the fail-closed head.
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const scholar = await seedScholar(t, "Admin Target");

    const res = await t.mutation(internal.customApps.installExistingUrlApp, {
      name: "Desmos",
      webUrl: "https://www.desmos.com/calculator",
      callerUserId: teacher,
      scholarIds: [scholar],
      groupIds: [],
      scholarLensResolved: true,
    });
    expect(res.appId).toBeDefined();
  });

  test("rejects a GROUP with any member outside the lens", async () => {
    // Group installs stay dynamic (the group id is handed over, not a member
    // snapshot), so the lens has to be enforced against the group's real
    // membership here rather than by pre-filtering in the tool layer.
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const allowed = await seedScholar(t, "In Lens");
    const outside = await seedScholar(t, "Out Of Lens");
    const mixed = await seedGroup(t, teacher, "Mixed", [allowed, outside]);

    await expect(
      t.mutation(internal.customApps.installExistingUrlApp, {
        name: "Desmos",
        webUrl: "https://www.desmos.com/calculator",
        callerUserId: teacher,
        scholarIds: [],
        groupIds: [mixed],
        allowedScholarIds: [allowed],
      }),
    ).rejects.toThrow("group is outside the active institution view");
  });

  test("a stale roster id (deleted account) does not make a whole group read as partial", async () => {
    // readScholarGroups silently drops ids that no longer resolve to a live
    // scholar, so the tool layer offers such a group as whole. The mutation
    // guard must agree — a deleted account or changed role in the stored
    // roster must not turn a legitimate install into an opaque refusal.
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const allowed = await seedScholar(t, "In Lens");
    const departed = await seedScholar(t, "Departed Scholar");
    const group = await seedGroup(t, teacher, "Alumni Mixed", [
      allowed,
      departed,
    ]);
    await t.run((ctx) => ctx.db.delete(departed));

    const res = await t.mutation(internal.customApps.installExistingUrlApp, {
      name: "Desmos",
      webUrl: "https://www.desmos.com/calculator",
      callerUserId: teacher,
      scholarIds: [],
      groupIds: [group],
      allowedScholarIds: [allowed],
    });
    expect(res.appId).toBeDefined();
  });

  test("rejects non-HTTPS URLs", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);

    await expect(
      t.mutation(internal.customApps.installExistingUrlApp, {
        name: "Insecure app",
        webUrl: "http://example.org/app",
        callerUserId: teacher,
        // These fixtures stand in for an unrestricted (platform-admin) caller: the
        // lens WAS resolved, it just imposes no restriction. assertTargetsWithinLens
        // now fails closed without this, which is the point of the flag.
        scholarLensResolved: true,
        scholarIds: [],
        groupIds: [],
      }),
    ).rejects.toThrow("Enter a valid https:// URL");
  });

  test("creates a catalog row + grants for scholars and groups", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const scholar = await seedScholar(t, "Solo Scholar");
    const groupScholar = await seedScholar(t, "Group Scholar");
    const group = await seedGroup(t, teacher, "Seals", [groupScholar]);

    const res = await t.mutation(internal.customApps.installExistingUrlApp, {
      name: "Desmos",
      webUrl: "https://www.desmos.com/calculator",
      callerUserId: teacher,
      // These fixtures stand in for an unrestricted (platform-admin) caller: the
      // lens WAS resolved, it just imposes no restriction. assertTargetsWithinLens
      // now fails closed without this, which is the point of the flag.
      scholarLensResolved: true,
      scholarIds: [scholar],
      groupIds: [group],
    });

    const app = await t.run((ctx) => ctx.db.get(res.appId));
    expect(app?.name).toBe("Desmos");
    expect(app?.webUrl).toBe("https://www.desmos.com/calculator");
    expect(app?.webAllowedHosts).toEqual(["www.desmos.com"]);

    const scholarLink = await t.run((ctx) =>
      ctx.db
        .query("scholarApps")
        .withIndex("by_scholar_app", (q) =>
          q.eq("scholarId", scholar).eq("appId", res.appId),
        )
        .first(),
    );
    expect(scholarLink?.enabled).toBe(true);

    const grant = await t.run((ctx) =>
      ctx.db
        .query("appAudiences")
        .withIndex("by_audience", (q) =>
          q.eq("audienceKind", "group").eq("audienceId", String(group)),
        )
        .first(),
    );
    expect(grant?.appId).toBe(res.appId);
    expect(grant?.enabled).toBe(true);
  });

  test("dedupes into the catalog by exact webUrl", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const a = await seedScholar(t, "Aa");
    const b = await seedScholar(t, "Bb");
    const url = "https://example.org/app";

    const first = await t.mutation(internal.customApps.installExistingUrlApp, {
      name: "Example",
      webUrl: url,
      callerUserId: teacher,
      // These fixtures stand in for an unrestricted (platform-admin) caller: the
      // lens WAS resolved, it just imposes no restriction. assertTargetsWithinLens
      // now fails closed without this, which is the point of the flag.
      scholarLensResolved: true,
      scholarIds: [a],
      groupIds: [],
    });
    const second = await t.mutation(internal.customApps.installExistingUrlApp, {
      name: "Example (again)",
      webUrl: url,
      callerUserId: teacher,
      // These fixtures stand in for an unrestricted (platform-admin) caller: the
      // lens WAS resolved, it just imposes no restriction. assertTargetsWithinLens
      // now fails closed without this, which is the point of the flag.
      scholarLensResolved: true,
      scholarIds: [b],
      groupIds: [],
    });
    expect(second.appId).toBe(first.appId);
    const catalog = await t.run((ctx) =>
      ctx.db
        .query("externalApps")
        .filter((q) => q.eq(q.field("webUrl"), url))
        .collect(),
    );
    expect(catalog).toHaveLength(1);
  });

  test("re-enables a previously disabled scholar link rather than duplicating", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const scholar = await seedScholar(t, "Repeat");
    const args = {
      name: "Repeat App",
      webUrl: "https://repeat.example/app",
      callerUserId: teacher,
      // These fixtures stand in for an unrestricted (platform-admin) caller: the
      // lens WAS resolved, it just imposes no restriction. assertTargetsWithinLens
      // now fails closed without this, which is the point of the flag.
      scholarLensResolved: true,
      scholarIds: [scholar],
      groupIds: [],
    };
    const res = await t.mutation(internal.customApps.installExistingUrlApp, args);
    // Simulate a teacher disabling the tile.
    await t.run(async (ctx) => {
      const link = await ctx.db
        .query("scholarApps")
        .withIndex("by_scholar_app", (q) =>
          q.eq("scholarId", scholar).eq("appId", res.appId),
        )
        .first();
      if (link) await ctx.db.patch(link._id, { enabled: false });
    });
    await t.mutation(internal.customApps.installExistingUrlApp, args);
    const links = await t.run((ctx) =>
      ctx.db
        .query("scholarApps")
        .withIndex("by_scholar_app", (q) =>
          q.eq("scholarId", scholar).eq("appId", res.appId),
        )
        .collect(),
    );
    expect(links).toHaveLength(1);
    expect(links[0].enabled).toBe(true);
  });
});

describe("createStaticApp + resolveByToken", () => {
  test("stores html, creates the tile at the token url, and resolves live html", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const scholar = await seedScholar(t, "Static Scholar");
    const token = generateAppToken();
    const html = "<!doctype html><title>Timer</title><h1>Timer</h1>";

    const res = await t.mutation(internal.customApps.createStaticApp, {
      name: "Timer",
      html,
      token,
      callerUserId: teacher,
      // These fixtures stand in for an unrestricted (platform-admin) caller: the
      // lens WAS resolved, it just imposes no restriction. assertTargetsWithinLens
      // now fails closed without this, which is the point of the flag.
      scholarLensResolved: true,
      scholarIds: [scholar],
      groupIds: [],
    });
    // The teacher-facing message uses the absolute url…
    expect(res.url).toBe(customAppUrl(token));

    const app = await t.run((ctx) => ctx.db.get(res.appId));
    // …but the STORED catalog webUrl is the domain-agnostic path.
    expect(app?.webUrl).toBe(customAppPath(token));
    expect(app?.webAllowedHosts).toBeUndefined();

    const resolved = await t.query(api.customApps.resolveByToken, {
      token,
    });
    // resolveByToken is a public query; call it through the api shape.
    expect(resolved).toMatchObject({
      kind: "static",
      status: "live",
      name: "Timer",
      html,
    });
  });

  test("rejects HTML over the size cap", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const big = "a".repeat(MAX_STATIC_HTML_BYTES + 1);
    await expect(
      t.mutation(internal.customApps.createStaticApp, {
        name: "Too Big",
        html: big,
        token: generateAppToken(),
        callerUserId: teacher,
        // These fixtures stand in for an unrestricted (platform-admin) caller: the
        // lens WAS resolved, it just imposes no restriction. assertTargetsWithinLens
        // now fails closed without this, which is the point of the flag.
        scholarLensResolved: true,
        scholarIds: [],
        groupIds: [],
      }),
    ).rejects.toThrow(/too large/i);
  });

  test("resolveByToken returns null for an unknown token", async () => {
    const t = convexTest(schema, modules);
    const resolved = await t.query(api.customApps.resolveByToken, {
      token: "does-not-exist",
    });
    expect(resolved).toBeNull();
  });

  test("updates static HTML while preserving token, status, tile, and grants", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const scholar = await seedScholar(t, "Updated Scholar");
    const token = generateAppToken();
    const created = await t.mutation(internal.customApps.createStaticApp, {
      name: "Fraction Tiles",
      html: "<!doctype html><h1>Original</h1>",
      token,
      callerUserId: teacher,
      // These fixtures stand in for an unrestricted (platform-admin) caller: the
      // lens WAS resolved, it just imposes no restriction. assertTargetsWithinLens
      // now fails closed without this, which is the point of the flag.
      scholarLensResolved: true,
      scholarIds: [scholar],
      groupIds: [],
    });
    const before = await t.run((ctx) => ctx.db.get(created.customAppId));

    const result = await t.mutation(internal.customApps.updateStaticApp, {
      name: "fraction tiles",
      html: "<!doctype html><h1>Updated</h1>",
      callerUserId: teacher,
      // Unrestricted (platform-admin) caller: the lens WAS resolved, it just
      // imposes no restriction.
      scholarLensResolved: true,
    });

    expect(result).toMatchObject({
      kind: "updated",
      customAppId: created.customAppId,
      token,
      status: "live",
    });
    const after = await t.run((ctx) => ctx.db.get(created.customAppId));
    expect(after).toMatchObject({
      html: "<!doctype html><h1>Updated</h1>",
      token: before?.token,
      status: before?.status,
      externalAppId: before?.externalAppId,
      installScholarIds: before?.installScholarIds,
    });
    const links = await t.run((ctx) =>
      ctx.db
        .query("scholarApps")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholar))
        .collect(),
    );
    expect(links).toHaveLength(1);
    expect(links[0].appId).toBe(created.appId);
  });

  test("refuses a case-insensitive ambiguous static app name", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    for (const name of ["Timer", "timer"]) {
      await t.mutation(internal.customApps.createStaticApp, {
        name,
        html: `<!doctype html><h1>${name}</h1>`,
        token: generateAppToken(),
        callerUserId: teacher,
        // These fixtures stand in for an unrestricted (platform-admin) caller: the
        // lens WAS resolved, it just imposes no restriction. assertTargetsWithinLens
        // now fails closed without this, which is the point of the flag.
        scholarLensResolved: true,
        scholarIds: [],
        groupIds: [],
      });
    }

    const result = await t.mutation(internal.customApps.updateStaticApp, {
      name: "TIMER",
      html: "<!doctype html><h1>Replacement</h1>",
      callerUserId: teacher,
      // Unrestricted (platform-admin) caller: both same-named apps are visible.
      scholarLensResolved: true,
    });

    expect(result).toEqual({ kind: "ambiguous" });
    const rows = await t.run((ctx) => ctx.db.query("customApps").collect());
    expect(rows.map((row) => row.html)).toEqual([
      "<!doctype html><h1>Timer</h1>",
      "<!doctype html><h1>timer</h1>",
    ]);
  });

  test("rejects an oversize static app update", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    await t.mutation(internal.customApps.createStaticApp, {
      name: "Timer",
      html: "<!doctype html><h1>Timer</h1>",
      token: generateAppToken(),
      callerUserId: teacher,
      // These fixtures stand in for an unrestricted (platform-admin) caller: the
      // lens WAS resolved, it just imposes no restriction. assertTargetsWithinLens
      // now fails closed without this, which is the point of the flag.
      scholarLensResolved: true,
      scholarIds: [],
      groupIds: [],
    });

    await expect(
      t.mutation(internal.customApps.updateStaticApp, {
        name: "Timer",
        html: "x".repeat(MAX_STATIC_HTML_BYTES + 1),
        callerUserId: teacher,
        scholarLensResolved: true,
      }),
    ).rejects.toThrow(/too large/i);
  });
});

describe("updateStaticApp tenancy (institution lens)", () => {
  async function seedStaticApp(
    t: ReturnType<typeof convexTest>,
    opts: {
      name: string;
      html: string;
      caller: Id<"users">;
      scholarIds?: Id<"users">[];
      groupIds?: Id<"scholarGroups">[];
    },
  ) {
    return await t.mutation(internal.customApps.createStaticApp, {
      name: opts.name,
      html: opts.html,
      token: generateAppToken(),
      callerUserId: opts.caller,
      // Unrestricted creator — the fixture just needs the app to exist.
      scholarLensResolved: true,
      scholarIds: opts.scholarIds ?? [],
      groupIds: opts.groupIds ?? [],
    });
  }

  test("cross-tenant write is refused and nothing is written", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const scholarA = await seedScholar(t, "School A Scholar");
    const scholarB = await seedScholar(t, "School B Scholar");
    const created = await seedStaticApp(t, {
      name: "Weather Widget",
      html: "<!doctype html><h1>A</h1>",
      caller: teacher,
      scholarIds: [scholarA],
    });

    // A caller whose lens only covers school B cannot see school A's app.
    const result = await t.mutation(internal.customApps.updateStaticApp, {
      name: "Weather Widget",
      html: "<!doctype html><h1>HIJACKED</h1>",
      callerUserId: await seedTeacher(t),
      allowedScholarIds: [scholarB],
    });
    expect(result).toEqual({ kind: "not_found" });
    const after = await t.run((ctx) => ctx.db.get(created.customAppId));
    expect(after?.html).toBe("<!doctype html><h1>A</h1>");
  });

  test("the owning school's teacher still updates fine", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const scholarA = await seedScholar(t, "Owning School Scholar");
    const created = await seedStaticApp(t, {
      name: "Weather Widget",
      html: "<!doctype html><h1>A</h1>",
      caller: teacher,
      scholarIds: [scholarA],
    });

    const result = await t.mutation(internal.customApps.updateStaticApp, {
      name: "Weather Widget",
      html: "<!doctype html><h1>UPDATED</h1>",
      callerUserId: teacher,
      allowedScholarIds: [scholarA],
    });
    expect(result).toMatchObject({ kind: "updated" });
    const after = await t.run((ctx) => ctx.db.get(created.customAppId));
    expect(after?.html).toBe("<!doctype html><h1>UPDATED</h1>");
  });

  test("fails closed when no lens was ever resolved", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    await seedStaticApp(t, {
      name: "Weather Widget",
      html: "<!doctype html><h1>A</h1>",
      caller: teacher,
    });

    await expect(
      t.mutation(internal.customApps.updateStaticApp, {
        name: "Weather Widget",
        html: "<!doctype html><h1>Nope</h1>",
        callerUserId: teacher,
        // Neither allowedScholarIds nor scholarLensResolved: true.
      }),
    ).rejects.toThrow(/no institution scholar lens/i);
  });

  test("an unrestricted caller (lens resolved, no id set) updates fine", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const scholarA = await seedScholar(t, "Some Scholar");
    const created = await seedStaticApp(t, {
      name: "Weather Widget",
      html: "<!doctype html><h1>A</h1>",
      caller: teacher,
      scholarIds: [scholarA],
    });

    const result = await t.mutation(internal.customApps.updateStaticApp, {
      name: "Weather Widget",
      html: "<!doctype html><h1>ADMIN</h1>",
      callerUserId: await seedTeacher(t),
      scholarLensResolved: true,
    });
    expect(result).toMatchObject({ kind: "updated" });
    const after = await t.run((ctx) => ctx.db.get(created.customAppId));
    expect(after?.html).toBe("<!doctype html><h1>ADMIN</h1>");
  });

  test("own zero-grant app is updatable by its creator but not by others", async () => {
    const t = convexTest(schema, modules);
    const creator = await seedTeacher(t);
    const other = await seedTeacher(t);
    const otherScholar = await seedScholar(t, "Other Scholar");
    const created = await seedStaticApp(t, {
      name: "My Sketchpad",
      html: "<!doctype html><h1>Mine</h1>",
      caller: creator,
      // No grants at all.
    });

    // The creator, even under a restrictive lens, can update their own app.
    const mine = await t.mutation(internal.customApps.updateStaticApp, {
      name: "My Sketchpad",
      html: "<!doctype html><h1>Revised</h1>",
      callerUserId: creator,
      allowedScholarIds: [],
    });
    expect(mine).toMatchObject({ kind: "updated" });
    expect(
      (await t.run((ctx) => ctx.db.get(created.customAppId)))?.html,
    ).toBe("<!doctype html><h1>Revised</h1>");

    // A different caller whose lens does not cover it gets not_found.
    const theirs = await t.mutation(internal.customApps.updateStaticApp, {
      name: "My Sketchpad",
      html: "<!doctype html><h1>HIJACKED</h1>",
      callerUserId: other,
      allowedScholarIds: [otherScholar],
    });
    expect(theirs).toEqual({ kind: "not_found" });
    expect(
      (await t.run((ctx) => ctx.db.get(created.customAppId)))?.html,
    ).toBe("<!doctype html><h1>Revised</h1>");
  });

  test("a credential-parking grant row does not count as reach", async () => {
    // scholarApps rows with source "grant" are visibility-NEUTRAL: they park a
    // credential for an audience grant and never show a tile alone (see the
    // launcher's rule in scholarApps.ts). They are also RETAINED after the
    // audience grant is removed. Counting one as reach would inflate the app's
    // audience with a scholar who can no longer open it, and hand a legitimate
    // teacher a false not_found for their own app.
    const t = convexTest(schema, modules);
    const creator = await seedTeacher(t);
    const ghost = await seedScholar(t, "Former Grantee");
    const created = await seedStaticApp(t, {
      name: "Sketchpad",
      html: "<!doctype html><h1>Mine</h1>",
      caller: creator,
    });
    await t.run((ctx) =>
      ctx.db.insert("scholarApps", {
        scholarId: ghost,
        appId: created.appId,
        enabled: true,
        source: "grant" as const,
      }),
    );

    // Reach is still empty, so the zero-reach creator rule applies...
    const mine = await t.mutation(internal.customApps.updateStaticApp, {
      name: "Sketchpad",
      html: "<!doctype html><h1>Revised</h1>",
      callerUserId: creator,
      allowedScholarIds: [],
    });
    expect(mine).toMatchObject({ kind: "updated" });

    // ...and the parked row does not put the app inside a stranger's lens.
    const theirs = await t.mutation(internal.customApps.updateStaticApp, {
      name: "Sketchpad",
      html: "<!doctype html><h1>HIJACKED</h1>",
      callerUserId: await seedTeacher(t),
      allowedScholarIds: [ghost],
    });
    expect(theirs).toEqual({ kind: "not_found" });
    expect((await t.run((ctx) => ctx.db.get(created.customAppId)))?.html).toBe(
      "<!doctype html><h1>Revised</h1>",
    );
  });

  test("same name in two lenses is no longer ambiguous", async () => {
    const t = convexTest(schema, modules);
    const teacherA = await seedTeacher(t);
    const teacherB = await seedTeacher(t);
    const scholarA = await seedScholar(t, "Lens A Scholar");
    const scholarB = await seedScholar(t, "Lens B Scholar");
    const appA = await seedStaticApp(t, {
      name: "Shared Name",
      html: "<!doctype html><h1>A original</h1>",
      caller: teacherA,
      scholarIds: [scholarA],
    });
    const appB = await seedStaticApp(t, {
      name: "Shared Name",
      html: "<!doctype html><h1>B original</h1>",
      caller: teacherB,
      scholarIds: [scholarB],
    });

    // School A's caller updates ITS OWN app; school B's is untouched.
    const resA = await t.mutation(internal.customApps.updateStaticApp, {
      name: "Shared Name",
      html: "<!doctype html><h1>A updated</h1>",
      callerUserId: teacherA,
      allowedScholarIds: [scholarA],
    });
    expect(resA).toMatchObject({ kind: "updated" });
    expect((await t.run((ctx) => ctx.db.get(appA.customAppId)))?.html).toBe(
      "<!doctype html><h1>A updated</h1>",
    );
    expect((await t.run((ctx) => ctx.db.get(appB.customAppId)))?.html).toBe(
      "<!doctype html><h1>B original</h1>",
    );

    // And symmetrically for school B.
    const resB = await t.mutation(internal.customApps.updateStaticApp, {
      name: "Shared Name",
      html: "<!doctype html><h1>B updated</h1>",
      callerUserId: teacherB,
      allowedScholarIds: [scholarB],
    });
    expect(resB).toMatchObject({ kind: "updated" });
    expect((await t.run((ctx) => ctx.db.get(appB.customAppId)))?.html).toBe(
      "<!doctype html><h1>B updated</h1>",
    );
    expect((await t.run((ctx) => ctx.db.get(appA.customAppId)))?.html).toBe(
      "<!doctype html><h1>A updated</h1>",
    );
  });

  test("a non-creator colleague whose lens covers the app updates fine", async () => {
    const t = convexTest(schema, modules);
    const creator = await seedTeacher(t);
    const colleague = await seedTeacher(t);
    const scholarA = await seedScholar(t, "Covered Scholar");
    const created = await seedStaticApp(t, {
      name: "Shared Widget",
      html: "<!doctype html><h1>original</h1>",
      caller: creator,
      scholarIds: [scholarA],
    });

    // The caller is deliberately NOT the creator, so rule (b) cannot mask a
    // broken rule (c): this is the test that actually pins (c)'s permissive
    // path (every reachable scholar is inside the caller's lens).
    const result = await t.mutation(internal.customApps.updateStaticApp, {
      name: "Shared Widget",
      html: "<!doctype html><h1>colleague updated</h1>",
      callerUserId: colleague,
      allowedScholarIds: [scholarA],
    });
    expect(result).toMatchObject({ kind: "updated" });
    expect((await t.run((ctx) => ctx.db.get(created.customAppId)))?.html).toBe(
      "<!doctype html><h1>colleague updated</h1>",
    );
  });

  test("group-granted reachability is expanded", async () => {
    const t = convexTest(schema, modules);
    const creator = await seedTeacher(t);
    const colleague = await seedTeacher(t);
    const scholarA = await seedScholar(t, "Group Member A");
    const scholarB = await seedScholar(t, "Unrelated Scholar B");
    const group = await seedGroup(t, creator, "Pod A", [scholarA]);
    const created = await seedStaticApp(t, {
      name: "Group Widget",
      html: "<!doctype html><h1>original</h1>",
      caller: creator,
      groupIds: [group],
    });

    // A non-creator whose lens covers the group's member sees the app — this
    // only passes if installGroupIds is expanded to its scholars.
    const covered = await t.mutation(internal.customApps.updateStaticApp, {
      name: "Group Widget",
      html: "<!doctype html><h1>covered updated</h1>",
      callerUserId: colleague,
      allowedScholarIds: [scholarA],
    });
    expect(covered).toMatchObject({ kind: "updated" });
    expect((await t.run((ctx) => ctx.db.get(created.customAppId)))?.html).toBe(
      "<!doctype html><h1>covered updated</h1>",
    );

    // A non-creator whose lens covers only an unrelated scholar cannot see it.
    const uncovered = await t.mutation(internal.customApps.updateStaticApp, {
      name: "Group Widget",
      html: "<!doctype html><h1>HIJACKED</h1>",
      callerUserId: colleague,
      allowedScholarIds: [scholarB],
    });
    expect(uncovered).toEqual({ kind: "not_found" });
    expect((await t.run((ctx) => ctx.db.get(created.customAppId)))?.html).toBe(
      "<!doctype html><h1>covered updated</h1>",
    );
  });

  test("a partially-covered group is refused", async () => {
    const t = convexTest(schema, modules);
    const creator = await seedTeacher(t);
    const colleague = await seedTeacher(t);
    const scholarA = await seedScholar(t, "Group Member A");
    const scholarB = await seedScholar(t, "Group Member B");
    const group = await seedGroup(t, creator, "Mixed Pod", [scholarA, scholarB]);
    const created = await seedStaticApp(t, {
      name: "Mixed Group Widget",
      html: "<!doctype html><h1>original</h1>",
      caller: creator,
      groupIds: [group],
    });

    // The group reaches scholarA AND scholarB; a lens covering only scholarA
    // must NOT overwrite it — that would reach scholarB, outside the lens.
    const result = await t.mutation(internal.customApps.updateStaticApp, {
      name: "Mixed Group Widget",
      html: "<!doctype html><h1>HIJACKED</h1>",
      callerUserId: colleague,
      allowedScholarIds: [scholarA],
    });
    expect(result).toEqual({ kind: "not_found" });
    expect((await t.run((ctx) => ctx.db.get(created.customAppId)))?.html).toBe(
      "<!doctype html><h1>original</h1>",
    );
  });

  test("live grants beat stale intent (the reported hole)", async () => {
    const t = convexTest(schema, modules);
    const creator = await seedTeacher(t);
    const scholarB = await seedScholar(t, "School B Scholar");
    const scholarA = await seedScholar(t, "School A Scholar");
    // App created at school B for scholarB only — install INTENT = [scholarB].
    const created = await seedStaticApp(t, {
      name: "Widget",
      html: "<!doctype html><h1>original</h1>",
      caller: creator,
      scholarIds: [scholarB],
    });
    // Another tool later grants it to scholarA via a LIVE scholarApps row,
    // WITHOUT touching installScholarIds (which still names only scholarB).
    await t.run((ctx) =>
      ctx.db.insert("scholarApps", {
        scholarId: scholarA,
        appId: created.appId,
        enabled: true,
        source: "manual",
      }),
    );

    // A caller whose lens covers only scholarB must NOT be able to overwrite —
    // the app now reaches scholarA too. Before the live-grant fix (which read
    // install intent), this call SUCCEEDED, overwriting HTML school A loads.
    const result = await t.mutation(internal.customApps.updateStaticApp, {
      name: "Widget",
      html: "<!doctype html><h1>HIJACKED</h1>",
      callerUserId: creator,
      allowedScholarIds: [scholarB],
    });
    expect(result).toEqual({ kind: "not_found" });
    expect((await t.run((ctx) => ctx.db.get(created.customAppId)))?.html).toBe(
      "<!doctype html><h1>original</h1>",
    );
  });

  test("institution-audience grant is expanded", async () => {
    const t = convexTest(schema, modules);
    const creator = await seedTeacher(t);
    const colleague = await seedTeacher(t);
    const institutionId = await t.run((ctx) =>
      ctx.db.insert("institutions", {
        name: "Moli School",
        slug: "moli",
        kind: "school",
      }),
    );
    const scholarA = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Institution Scholar",
        username: "inst-scholar",
        role: "scholar",
        institutionId,
      }),
    );
    const scholarB = await seedScholar(t, "Unrelated Scholar B");
    // Zero direct/group grants at create; add an institution audience grant.
    const created = await seedStaticApp(t, {
      name: "Institution Widget",
      html: "<!doctype html><h1>original</h1>",
      caller: creator,
    });
    await t.run((ctx) =>
      ctx.db.insert("appAudiences", {
        appId: created.appId,
        audienceKind: "institution",
        audienceId: String(institutionId),
        enabled: true,
      }),
    );

    const covered = await t.mutation(internal.customApps.updateStaticApp, {
      name: "Institution Widget",
      html: "<!doctype html><h1>updated</h1>",
      callerUserId: colleague,
      allowedScholarIds: [scholarA],
    });
    expect(covered).toMatchObject({ kind: "updated" });
    expect((await t.run((ctx) => ctx.db.get(created.customAppId)))?.html).toBe(
      "<!doctype html><h1>updated</h1>",
    );

    const uncovered = await t.mutation(internal.customApps.updateStaticApp, {
      name: "Institution Widget",
      html: "<!doctype html><h1>HIJACKED</h1>",
      callerUserId: colleague,
      allowedScholarIds: [scholarB],
    });
    expect(uncovered).toEqual({ kind: "not_found" });
    expect((await t.run((ctx) => ctx.db.get(created.customAppId)))?.html).toBe(
      "<!doctype html><h1>updated</h1>",
    );
  });

  test("a disabled grant does not count as reach", async () => {
    const t = convexTest(schema, modules);
    const creator = await seedTeacher(t);
    const colleague = await seedTeacher(t);
    const scholarA = await seedScholar(t, "Disabled Grant Scholar");
    const created = await seedStaticApp(t, {
      name: "Paused Widget",
      html: "<!doctype html><h1>original</h1>",
      caller: creator,
    });
    // A DISABLED grant reaching scholarA — must not count as reach.
    await t.run((ctx) =>
      ctx.db.insert("scholarApps", {
        scholarId: scholarA,
        appId: created.appId,
        enabled: false,
        source: "manual",
      }),
    );

    // A lens covering scholarA still cannot see it (its only grant is disabled).
    const other = await t.mutation(internal.customApps.updateStaticApp, {
      name: "Paused Widget",
      html: "<!doctype html><h1>HIJACKED</h1>",
      callerUserId: colleague,
      allowedScholarIds: [scholarA],
    });
    expect(other).toEqual({ kind: "not_found" });
    expect((await t.run((ctx) => ctx.db.get(created.customAppId)))?.html).toBe(
      "<!doctype html><h1>original</h1>",
    );
    // With no live reach, the creator rule applies.
    const mine = await t.mutation(internal.customApps.updateStaticApp, {
      name: "Paused Widget",
      html: "<!doctype html><h1>creator updated</h1>",
      callerUserId: creator,
      allowedScholarIds: [],
    });
    expect(mine).toMatchObject({ kind: "updated" });
    expect((await t.run((ctx) => ctx.db.get(created.customAppId)))?.html).toBe(
      "<!doctype html><h1>creator updated</h1>",
    );
  });

  test("creator loses the bypass once the app reaches a child", async () => {
    const t = convexTest(schema, modules);
    const creator = await seedTeacher(t);
    const reachedScholar = await seedScholar(t, "Reached Scholar");
    const outsideScholar = await seedScholar(t, "Outside Scholar");
    // The app reaches a child via a live grant.
    const created = await seedStaticApp(t, {
      name: "Reaching Widget",
      html: "<!doctype html><h1>original</h1>",
      caller: creator,
      scholarIds: [reachedScholar],
    });

    // The creator, under a lens NOT covering the reached scholar, no longer has
    // a bypass — narrowed rule (b): creator access only survives zero-reach.
    const result = await t.mutation(internal.customApps.updateStaticApp, {
      name: "Reaching Widget",
      html: "<!doctype html><h1>HIJACKED</h1>",
      callerUserId: creator,
      allowedScholarIds: [outsideScholar],
    });
    expect(result).toEqual({ kind: "not_found" });
    expect((await t.run((ctx) => ctx.db.get(created.customAppId)))?.html).toBe(
      "<!doctype html><h1>original</h1>",
    );
  });

  test("a stale direct scholar id does not permanently break updates", async () => {
    const t = convexTest(schema, modules);
    const creator = await seedTeacher(t);
    const ghost = await seedScholar(t, "Ghost Scholar");
    const created = await seedStaticApp(t, {
      name: "Ghost Widget",
      html: "<!doctype html><h1>original</h1>",
      caller: creator,
      scholarIds: [ghost],
    });
    // The grantee's user doc is deleted — its scholarApps row is now a stale id.
    await t.run((ctx) => ctx.db.delete(ghost));

    // The stale id contributes nothing, so the app reaches nobody and the
    // creator rule still applies (no permanent false not_found).
    const result = await t.mutation(internal.customApps.updateStaticApp, {
      name: "Ghost Widget",
      html: "<!doctype html><h1>creator updated</h1>",
      callerUserId: creator,
      allowedScholarIds: [],
    });
    expect(result).toMatchObject({ kind: "updated" });
    expect((await t.run((ctx) => ctx.db.get(created.customAppId)))?.html).toBe(
      "<!doctype html><h1>creator updated</h1>",
    );
  });
});

describe("coded app lifecycle: createPendingCodedApp → finalizeCodedApp", () => {
  let implementationRepository = "rabbithole-school/rabbithole";

  async function seedProposal(t: ReturnType<typeof convexTest>) {
    return await t.run(async (ctx) => {
      const teacherId = await ctx.db.insert("users", {
        name: "Proposal Requester",
        username: `req-${Math.random().toString(36).slice(2, 8)}`,
        role: "teacher",
      });
      const chatId = await ctx.db.insert("chats", {
        teacherId,
        title: "Custom app dispatch",
        pinned: false,
        lastMessageAt: Date.now(),
      });
      return ctx.db.insert("featureProposals", {
        chatId,
        githubRepo: implementationRepository,
        taskId: `task-${Math.random().toString(36).slice(2)}`,
        stage: "code",
        status: "dispatched",
        requestedByUserId: teacherId,
        redactedBrief: "A student-facing app.",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
  }

  test("pending coded app resolves as building (no routePath), then live after finalize", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const scholar = await seedScholar(t, "Coded Scholar");
    const proposalId = await seedProposal(t);
    const token = generateAppToken();

    const pending = await t.mutation(
      internal.customApps.createPendingCodedApp,
      {
        name: "Whiteboard",
        routePath: "/custom-apps/whiteboard-abc123",
        token,
        featureProposalId: proposalId,
        callerUserId: teacher,
        // These fixtures stand in for an unrestricted (platform-admin) caller: the
        // lens WAS resolved, it just imposes no restriction. assertTargetsWithinLens
        // now fails closed without this, which is the point of the flag.
        scholarLensResolved: true,
        scholarIds: [scholar],
        groupIds: [],
      },
    );

    // While building: resolves as coded/building with no routePath, and no
    // tile/grant exists yet.
    const building = await t.query(api.customApps.resolveByToken, {
      token,
    });
    expect(building).toMatchObject({ kind: "coded", status: "building" });
    expect(
      (building as { routePath: string | null } | null)?.routePath,
    ).toBeNull();
    const preGrants = await t.run((ctx) =>
      ctx.db.query("scholarApps").collect(),
    );
    expect(preGrants).toHaveLength(0);

    // Finalize (what the merge webhook schedules): flips to live, creates the
    // tile + grants.
    const fin = await t.mutation(internal.customApps.finalizeCodedApp, {
      customAppId: pending.customAppId,
    });
    expect(fin).not.toBeNull();

    // The launcher tile is created at the domain-agnostic path.
    const codedTile = await t.run((ctx) => ctx.db.get(fin!.appId));
    expect(codedTile?.webUrl).toBe(customAppPath(token));

    const live = await t.query(api.customApps.resolveByToken, { token });
    expect(live).toMatchObject({
      kind: "coded",
      status: "live",
      routePath: "/custom-apps/whiteboard-abc123",
    });
    const grants = await t.run((ctx) =>
      ctx.db
        .query("scholarApps")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholar))
        .collect(),
    );
    expect(grants).toHaveLength(1);
    expect(grants[0].enabled).toBe(true);
  });

  test("finalizeCodedApp is idempotent (a webhook retry is a no-op)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const proposalId = await seedProposal(t);
    const token = generateAppToken();
    const pending = await t.mutation(
      internal.customApps.createPendingCodedApp,
      {
        name: "Once",
        routePath: "/custom-apps/once-xyz",
        token,
        featureProposalId: proposalId,
        callerUserId: teacher,
        // These fixtures stand in for an unrestricted (platform-admin) caller: the
        // lens WAS resolved, it just imposes no restriction. assertTargetsWithinLens
        // now fails closed without this, which is the point of the flag.
        scholarLensResolved: true,
        scholarIds: [],
        groupIds: [],
      },
    );
    const first = await t.mutation(internal.customApps.finalizeCodedApp, {
      customAppId: pending.customAppId,
    });
    const second = await t.mutation(internal.customApps.finalizeCodedApp, {
      customAppId: pending.customAppId,
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    const apps = await t.run((ctx) =>
      ctx.db.query("externalApps").collect(),
    );
    expect(apps).toHaveLength(1);
  });

  test("getPendingByFeatureProposal finds a building row and ignores a live one", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedTeacher(t);
    const proposalId = await seedProposal(t);
    const token = generateAppToken();
    const pending = await t.mutation(
      internal.customApps.createPendingCodedApp,
      {
        name: "Lookup",
        routePath: "/custom-apps/lookup-1",
        token,
        featureProposalId: proposalId,
        callerUserId: teacher,
        // These fixtures stand in for an unrestricted (platform-admin) caller: the
        // lens WAS resolved, it just imposes no restriction. assertTargetsWithinLens
        // now fails closed without this, which is the point of the flag.
        scholarLensResolved: true,
        scholarIds: [],
        groupIds: [],
      },
    );
    const found = await t.query(
      internal.customApps.getPendingByFeatureProposal,
      { featureProposalId: proposalId },
    );
    expect(found).toMatchObject({ customAppId: pending.customAppId });

    await t.mutation(internal.customApps.finalizeCodedApp, {
      customAppId: pending.customAppId,
    });
    const afterFinal = await t.query(
      internal.customApps.getPendingByFeatureProposal,
      { featureProposalId: proposalId },
    );
    expect(afterFinal).toBeNull();
  });

});
