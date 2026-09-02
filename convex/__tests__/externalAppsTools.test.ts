import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { Role } from "../lib/roles";
import { makeExternalAppsTools } from "../lib/externalAppsTools";

/**
 * End-to-end exercise of the External-Apps aide tools: build the real tool
 * closures against a convex-test backend (routing the ActionCtx runQuery/
 * runMutation to the harness) and drive the whole ADD → CONFIGURE →
 * GRANT/REVOKE flow through them the way the bot would — proving the tool →
 * internal aide* → core wiring, the NAME→id resolution, and the scholar-admin
 * gate. Both the in-app aide AND Slack reach these tools through
 * assembleCurriculumTools, so this one exercise covers both transports.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// A minimal ActionCtx that routes the only two methods the tools use to the
// harness. convex-test's top-level query/mutation accept internal refs.
function actionCtxFor(t: ReturnType<typeof convexTest>): ActionCtx {
  return {
    runQuery: (ref: unknown, args: unknown) =>
      (t as unknown as { query: (r: unknown, a: unknown) => Promise<unknown> }).query(ref, args),
    runMutation: (ref: unknown, args: unknown) =>
      (t as unknown as { mutation: (r: unknown, a: unknown) => Promise<unknown> }).mutation(ref, args),
  } as unknown as ActionCtx;
}

/**
 * Every fixture below is TENANT-BEARING on purpose. These tools resolve
 * human-typed names over whole tables, so a fixture with no institutions at all
 * cannot tell a correctly-scoped resolver from a leaking one — which is exactly
 * how the unscoped first draft passed this suite. Scholars are stamped into an
 * institution, groups carry `institutionId`, and staff are scoped by an explicit
 * `memberships` row (or, with none, the primary-school fallback that
 * `curatableInstitutionIds` gives a not-yet-onboarded staffer).
 */
async function ensurePrimaryInstitution(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const existing = (await ctx.db.query("institutions").collect()).find(
      (i) => i.isPrimary,
    );
    if (existing) return existing._id;
    return ctx.db.insert("institutions", {
      name: "Moli School",
      slug: "moli",
      kind: "school",
      emoji: "🏫",
      isPrimary: true,
    });
  });
}

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role = "teacher",
  opts: { name?: string; username?: string; institutionId?: Id<"institutions"> } = {},
) {
  // A scholar's school IS users.institutionId — default them into the primary
  // school so the roster a staffer can reach is a real, bounded set.
  const institutionId =
    opts.institutionId ??
    (role === "scholar" ? await ensurePrimaryInstitution(t) : undefined);
  if (role !== "scholar") await ensurePrimaryInstitution(t);
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: opts.name ?? `Test ${role}`,
      username: opts.username ?? `u-${role}-${Math.random().toString(36).slice(2)}`,
      role,
      ...(institutionId ? { institutionId } : {}),
    }),
  );
}

async function seedInstitution(
  t: ReturnType<typeof convexTest>,
  name = "Moli School",
  opts: { slug?: string; primary?: boolean } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("institutions", {
      name,
      slug: opts.slug ?? name.toLowerCase().replace(/\W+/g, "-"),
      kind: "school",
      emoji: "🏫",
      ...(opts.primary ?? true ? { isPrimary: true } : {}),
    }),
  );
}

/** Pin a staffer to ONE school, the way real staff scoping works. */
async function seedMembership(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
  role = "teacher",
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("memberships", { userId, institutionId, role }),
  );
}

/**
 * Grant a staff capability (test helper, local to this file — the retired
 * `registrar` role's successor for scholar-admin access is a base `staff`
 * user plus this `school:operations` grant).
 */
async function grantCapability(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
  capability:
    | "curriculum:edit"
    | "school:operations"
    | "health:manage"
    | "program:publish"
    | "captures:review",
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("staffCapabilityGrants", {
      granteeUserId: userId,
      institutionId,
      capability,
      grantedBy: userId,
      grantedAt: Date.now(),
    }),
  );
}

async function seedGroup(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  name: string,
  scholarIds: Id<"users">[],
  institutionId?: Id<"institutions">,
) {
  const inst = institutionId ?? (await ensurePrimaryInstitution(t));
  return await t.run(async (ctx) =>
    ctx.db.insert("scholarGroups", {
      teacherId,
      name,
      emoji: "🦎",
      scholarIds,
      institutionId: inst,
    }),
  );
}

async function toolsFor(
  t: ReturnType<typeof convexTest>,
  callerUserId: Id<"users">,
  role: Role = "teacher",
) {
  const tools = await makeExternalAppsTools(actionCtxFor(t), () => {}, {
    role,
    callerUserId,
  });
  return Object.fromEntries(tools.map((tl) => [tl.name, tl])) as Record<
    string,
    { run: (input: unknown) => Promise<string> }
  >;
}

const parse = (s: string) => JSON.parse(s) as Record<string, unknown>;

/**
 * The "did you mean…" candidate list out of a resolver refusal. Asserting on
 * THIS rather than the whole message is the point: the message legitimately
 * echoes the name the caller typed, so a naive `not.toMatch(name)` would fail
 * on the caller's own input while proving nothing about what leaked.
 */
const candidatesIn = (message: string, label: string) =>
  message.includes(`${label}:`) ? message.split(`${label}:`)[1] : "";

describe("external-apps aide tools (end-to-end)", () => {
  test("a non-scholar-admin (scholar) gets NO external-app tools", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    const tools = await makeExternalAppsTools(actionCtxFor(t), () => {}, {
      role: "scholar",
      callerUserId: scholar,
    });
    expect(tools).toHaveLength(0);
  });

  test("operations staff (staff role + school:operations grant) DOES get the external-app tools", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await ensurePrimaryInstitution(t);
    const opsStaff = await seedUser(t, "staff");
    await seedMembership(t, opsStaff, institutionId, "staff");
    await grantCapability(t, opsStaff, institutionId, "school:operations");
    const tools = await makeExternalAppsTools(actionCtxFor(t), () => {}, {
      role: "staff",
      callerUserId: opsStaff,
      hasSchoolOperationsAccess: true,
    });
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.map((tl) => tl.name)).toContain("create_external_app");
  });

  test("create → list surfaces the new app with its config", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const tools = await toolsFor(t, teacher);

    const created = parse(
      await tools.create_external_app.run({
        name: "Acme Practice",
        webUrl: "https://acmepractice.com/learn",
        credentialSource: "scholarApp",
        defaultForNewScholars: true,
      }),
    );
    expect(created.name).toBe("Acme Practice");

    // webAllowedHosts derived from the URL host.
    const app = await t.run(async (ctx) =>
      ctx.db.get(created.appId as Id<"externalApps">),
    );
    expect(app?.webAllowedHosts).toContain("acmepractice.com");
    expect(app?.defaultForNewScholars).toBe(true);

    const listed = parse(await tools.list_external_apps.run({}));
    const apps = listed.apps as Array<Record<string, unknown>>;
    expect(apps).toHaveLength(1);
    expect(apps[0].name).toBe("Acme Practice");
    expect(apps[0].credentialSource).toBe("scholarApp");
    expect(apps[0].directScholarCount).toBe(0);
  });

  test("update renames + reconfigures an existing app (by name)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const tools = await toolsFor(t, teacher);

    const created = parse(
      await tools.create_external_app.run({
        name: "Acmepractice",
        webUrl: "https://acmepractice.com/",
      }),
    );
    const appId = created.appId as Id<"externalApps">;

    const updated = parse(
      await tools.update_external_app.run({
        appName: "Acmepractice",
        name: "Acme Practice",
        webUrl: "https://learn.acmepractice.com/",
        credentialSource: "libraryCard",
      }),
    );
    expect(updated.name).toBe("Acme Practice");

    const app = await t.run(async (ctx) => ctx.db.get(appId));
    expect(app?.name).toBe("Acme Practice");
    expect(app?.credentialSource).toBe("libraryCard");
    // webUrl changed → hosts re-derived from the new host, widened to its site
    // (registrableHost), so "learn." and "www." are both reachable.
    expect(app?.webAllowedHosts).toEqual(["acmepractice.com"]);
  });

  test("create + update carry nativeUrlScheme; empty string clears; invalid is rejected", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const tools = await toolsFor(t, teacher);

    // Create with a valid scheme persists it.
    const created = parse(
      await tools.create_external_app.run({
        name: "Google Sheets",
        webUrl: "https://sheets.google.com/",
        nativeUrlScheme: "googlesheets://",
      }),
    );
    const appId = created.appId as Id<"externalApps">;
    let app = await t.run(async (ctx) => ctx.db.get(appId));
    expect(app?.nativeUrlScheme).toBe("googlesheets://");

    // Update repoints it.
    await tools.update_external_app.run({
      appName: "Google Sheets",
      nativeUrlScheme: "ms-excel://",
    });
    app = await t.run(async (ctx) => ctx.db.get(appId));
    expect(app?.nativeUrlScheme).toBe("ms-excel://");

    // Empty string clears it.
    await tools.update_external_app.run({
      appName: "Google Sheets",
      nativeUrlScheme: "",
    });
    app = await t.run(async (ctx) => ctx.db.get(appId));
    expect(app?.nativeUrlScheme).toBeUndefined();

    // An invalid (non scheme-URL) value is rejected on create — the run wrapper
    // catches the mutation error and surfaces it as a message, so nothing is
    // written.
    const createErr = await tools.create_external_app.run({
      name: "Bad Native",
      webUrl: "https://bad.example.com/",
      nativeUrlScheme: "not a scheme",
    });
    expect(createErr).toMatch(/native app URL scheme/i);
    const badRows = await t.run(async (ctx) =>
      ctx.db
        .query("externalApps")
        .filter((q) => q.eq(q.field("name"), "Bad Native"))
        .collect(),
    );
    expect(badRows).toHaveLength(0);

    // …and rejected on update (the existing value is untouched).
    const updateErr = await tools.update_external_app.run({
      appName: "Google Sheets",
      nativeUrlScheme: "nocolonslashes",
    });
    expect(updateErr).toMatch(/native app URL scheme/i);
    app = await t.run(async (ctx) => ctx.db.get(appId));
    expect(app?.nativeUrlScheme).toBeUndefined();
  });

  test("enable_app_for_group then get_external_app_access reflects it; disable removes it", async () => {
    const t = convexTest(schema, modules);
    const moli = await ensurePrimaryInstitution(t);
    const teacher = await seedUser(t, "teacher");
    // The group write gate requires a real staff membership at the group's
    // school (the group path uses schoolOperations scope, which — unlike the
    // name-resolver's curatable scope — has no not-yet-onboarded fallback).
    await seedMembership(t, teacher, moli);
    const s1 = await seedUser(t, "scholar", { name: "Kai" });
    const s2 = await seedUser(t, "scholar", { name: "Lani" });
    await seedGroup(t, teacher, "Geckos", [s1, s2]);
    const tools = await toolsFor(t, teacher);

    await tools.create_external_app.run({
      name: "Typing Club",
      webUrl: "https://typingclub.com/",
    });

    const enabled = parse(
      await tools.enable_app_for_group.run({
        appName: "Typing Club",
        groupName: "Geckos",
      }),
    );
    expect(enabled.enabled).toBe(true);
    expect(enabled.memberCount).toBe(2);

    let access = parse(
      await tools.get_external_app_access.run({ appName: "Typing Club" }),
    );
    let groups = access.groups as Array<Record<string, unknown>>;
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("Geckos");
    expect(groups[0].memberCount).toBe(2);

    const disabled = parse(
      await tools.disable_app_for_group.run({
        appName: "Typing Club",
        groupName: "Geckos",
      }),
    );
    expect(disabled.enabled).toBe(false);

    access = parse(
      await tools.get_external_app_access.run({ appName: "Typing Club" }),
    );
    groups = access.groups as Array<Record<string, unknown>>;
    expect(groups).toHaveLength(0);
  });

  test("enable/disable for a whole institution (by name)", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "Moli School");
    const teacher = await seedUser(t, "teacher");
    await seedUser(t, "scholar", { name: "Oliver", institutionId });
    const tools = await toolsFor(t, teacher);

    await tools.create_external_app.run({
      name: "Library",
      webUrl: "https://library.example.com/",
    });

    const enabled = parse(
      await tools.enable_app_for_institution.run({
        appName: "Library",
        institutionName: "Moli School",
      }),
    );
    expect(enabled.enabled).toBe(true);
    expect(enabled.memberCount).toBe(1);

    let access = parse(
      await tools.get_external_app_access.run({ appName: "Library" }),
    );
    expect((access.institutions as unknown[]).length).toBe(1);

    await tools.disable_app_for_institution.run({
      appName: "Library",
      institutionName: "Moli School",
    });
    access = parse(await tools.get_external_app_access.run({ appName: "Library" }));
    expect((access.institutions as unknown[]).length).toBe(0);
  });

  test("enable/disable an app for ONE scholar by username", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    await seedUser(t, "scholar", { name: "Leilani Park", username: "leilani_park" });
    const tools = await toolsFor(t, teacher);

    await tools.create_external_app.run({
      name: "Scratch",
      webUrl: "https://scratch.mit.edu/",
    });

    const enabled = parse(
      await tools.enable_app_for_scholar.run({
        appName: "Scratch",
        scholar: "leilani_park",
      }),
    );
    expect(enabled.enabled).toBe(true);

    let access = parse(await tools.get_external_app_access.run({ appName: "Scratch" }));
    let scholars = access.scholars as Array<Record<string, unknown>>;
    expect(scholars).toHaveLength(1);
    expect(scholars[0].username).toBe("leilani_park");

    const disabled = parse(
      await tools.disable_app_for_scholar.run({
        appName: "Scratch",
        scholar: "leilani_park",
      }),
    );
    expect(disabled.enabled).toBe(false);
    expect(disabled.removed).toBe(1);

    access = parse(await tools.get_external_app_access.run({ appName: "Scratch" }));
    scholars = access.scholars as Array<Record<string, unknown>>;
    expect(scholars).toHaveLength(0);
  });

  test("get_external_app_access defaults to enrolled scholars; opt-in includes tagged Extended Education rows", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    await seedUser(t, "scholar", { name: "Kai", username: "kai_kahale" });
    const guest = await seedUser(t, "scholar", {
      name: "Hoku",
      username: "hoku_makani",
    });
    await t.run((ctx) =>
      ctx.db.patch(guest, { enrollmentStanding: "program_guest" }),
    );
    const tools = await toolsFor(t, teacher);

    await tools.create_external_app.run({
      name: "Typing Club",
      webUrl: "https://typingclub.com/",
    });
    await tools.enable_app_for_scholar.run({
      appName: "Typing Club",
      scholar: "kai_kahale",
    });
    // Naming a scholar is the opt-in — the guest still resolves for a grant.
    await tools.enable_app_for_scholar.run({
      appName: "Typing Club",
      scholar: "hoku_makani",
    });

    // Default enumeration: enrolled scholars only, with the discoverability note.
    const dflt = parse(
      await tools.get_external_app_access.run({ appName: "Typing Club" }),
    );
    const defaultScholars = dflt.scholars as Array<Record<string, unknown>>;
    expect(defaultScholars.map((s) => s.username)).toEqual(["kai_kahale"]);
    expect(dflt.note).toMatch(/1 Extended Education scholar/);
    expect(dflt.note).toMatch(/includeExtendedEducation/);

    // Opt-in: everyone, with the guest row tagged and no note.
    const all = parse(
      await tools.get_external_app_access.run({
        appName: "Typing Club",
        includeExtendedEducation: true,
      }),
    );
    const allScholars = all.scholars as Array<Record<string, unknown>>;
    expect(allScholars.map((s) => s.username).sort()).toEqual([
      "hoku_makani",
      "kai_kahale",
    ]);
    const hoku = allScholars.find((s) => s.username === "hoku_makani");
    const kai = allScholars.find((s) => s.username === "kai_kahale");
    expect(hoku).toMatchObject({ extendedEducation: true });
    expect(kai).not.toHaveProperty("extendedEducation");
    expect(all.note).toBeUndefined();
  });

  test("archive flags the app in the list; unarchive restores it", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const tools = await toolsFor(t, teacher);

    await tools.create_external_app.run({
      name: "Old App",
      webUrl: "https://old.example.com/",
    });

    const archived = parse(await tools.archive_external_app.run({ appName: "Old App" }));
    expect(archived.archived).toBe(true);

    // The aide list surfaces archived apps but flags them (so the bot can
    // un-archive), while the public web catalog hides them.
    const listed = parse(await tools.list_external_apps.run({}));
    const apps = listed.apps as Array<Record<string, unknown>>;
    const row = apps.find((a) => a.name === "Old App");
    expect(row).toBeTruthy();
    expect(row!.archived).toBe(true);

    const restored = parse(await tools.unarchive_external_app.run({ appName: "Old App" }));
    expect(restored.archived).toBe(false);
    const relisted = parse(await tools.list_external_apps.run({}));
    const row2 = (relisted.apps as Array<Record<string, unknown>>).find(
      (a) => a.name === "Old App",
    );
    expect(row2!.archived).toBe(false);
  });

  test("an unknown app name returns a helpful error listing candidates", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const tools = await toolsFor(t, teacher);
    await tools.create_external_app.run({ name: "Acme Practice", webUrl: "https://m.example.com/" });

    const res = await tools.get_external_app_access.run({ appName: "Nonexistent" });
    expect(res).toMatch(/Could not read access|No app matches/i);
    expect(res).toMatch(/Acme Practice/);
  });

  // ── Multi-tenancy ────────────────────────────────────────────────────────
  // These tools resolve NAMES over whole tables, so the role gate alone would
  // let school B's staff grant/revoke apps for school A — and leak A's group,
  // school, and scholar names through the "did you mean…" candidate lists.
  // "Can B act on A's data" is the leak question; "is B shown A's data as if it
  // were B's own" is the harm (CLAUDE.md → Multi-tenancy).
  describe("tenancy boundary", () => {
    // Two real schools; the acting teacher belongs to Kula, everything
    // interesting lives at Moli.
    async function twoSchools(t: ReturnType<typeof convexTest>) {
      const moli = await seedInstitution(t, "Moli School", { slug: "moli" });
      const kula = await seedInstitution(t, "Kula Academy", {
        slug: "kula",
        primary: false,
      });
      const outsider = await seedUser(t, "teacher", { name: "Outside Teacher" });
      await seedMembership(t, outsider, kula);
      const moliScholar = await seedUser(t, "scholar", {
        name: "Leilani Park",
        username: "leilani_park",
        institutionId: moli,
      });
      const moliTeacher = await seedUser(t, "teacher", { name: "Moli Teacher" });
      await seedMembership(t, moliTeacher, moli);
      await seedGroup(t, moliTeacher, "Geckos", [moliScholar], moli);
      return { moli, kula, outsider, moliTeacher, moliScholar };
    }

    test("a teacher at another school cannot grant an app to this school's group or scholar", async () => {
      const t = convexTest(schema, modules);
      const { outsider, moliTeacher } = await twoSchools(t);

      // The Moli teacher creates the app (catalog is shared).
      await (await toolsFor(t, moliTeacher)).create_external_app.run({
        name: "Typing Club",
        webUrl: "https://typingclub.com/",
      });

      const tools = await toolsFor(t, outsider);

      const byGroup = await tools.enable_app_for_group.run({
        appName: "Typing Club",
        groupName: "Geckos",
      });
      expect(byGroup).toMatch(/No group matches/i);
      // …and the "did you mean" candidate list — the actual leak vector, as
      // opposed to the caller's own echoed input — must not enumerate the
      // other school's groups.
      expect(candidatesIn(byGroup, "Known groups")).not.toMatch(/Geckos/);

      const byScholar = await tools.enable_app_for_scholar.run({
        appName: "Typing Club",
        scholar: "leilani_park",
      });
      expect(byScholar).toMatch(/No scholar matches/i);

      // Nothing was written.
      const grants = await t.run(async (ctx) =>
        ctx.db.query("appAudiences").collect(),
      );
      expect(grants).toHaveLength(0);
      const links = await t.run(async (ctx) =>
        ctx.db.query("scholarApps").collect(),
      );
      expect(links).toHaveLength(0);
    });

    test("a teacher cannot grant an app to a school they don't belong to", async () => {
      const t = convexTest(schema, modules);
      const { outsider, moliTeacher } = await twoSchools(t);
      await (await toolsFor(t, moliTeacher)).create_external_app.run({
        name: "Library",
        webUrl: "https://library.example.com/",
      });

      const tools = await toolsFor(t, outsider);
      const res = await tools.enable_app_for_institution.run({
        appName: "Library",
        institutionName: "Moli School",
      });
      expect(res).toMatch(/No school matches/i);
      expect(candidatesIn(res, "Known schools")).not.toMatch(/Moli/);
      expect(
        await t.run(async (ctx) => ctx.db.query("appAudiences").collect()),
      ).toHaveLength(0);
    });

    test("access readouts show only the caller's own tenant", async () => {
      const t = convexTest(schema, modules);
      const { outsider, moliTeacher, kula } = await twoSchools(t);
      const moliTools = await toolsFor(t, moliTeacher);
      await moliTools.create_external_app.run({
        name: "Typing Club",
        webUrl: "https://typingclub.com/",
      });
      await moliTools.enable_app_for_group.run({
        appName: "Typing Club",
        groupName: "Geckos",
      });
      await moliTools.enable_app_for_scholar.run({
        appName: "Typing Club",
        scholar: "leilani_park",
      });

      // The owner sees their own grants…
      const own = parse(
        await moliTools.get_external_app_access.run({ appName: "Typing Club" }),
      );
      expect((own.groups as unknown[]).length).toBe(1);
      expect((own.scholars as unknown[]).length).toBe(1);

      // …the outsider sees the app but none of Moli's people.
      const outsiderTools = await toolsFor(t, outsider);
      const seen = parse(
        await outsiderTools.get_external_app_access.run({ appName: "Typing Club" }),
      );
      expect(seen.groups).toHaveLength(0);
      expect(seen.scholars).toHaveLength(0);
      expect(seen.institutions).toHaveLength(0);

      const listed = parse(await outsiderTools.list_external_apps.run({}));
      const row = (listed.apps as Array<Record<string, unknown>>).find(
        (a) => a.name === "Typing Club",
      );
      expect(row!.directScholarCount).toBe(0);
      expect(row!.audiences).toHaveLength(0);
      expect(kula).toBeTruthy();
    });

    // An UNSTAMPED group is a legacy artifact (scholarGroups.create stamps
    // institutionId, empty groups included). Both cases below were reachable
    // under the first draft of this fix, which reused the read-side rule
    // "empty group is harmless, partial overlap is fine" — true for a read,
    // false for a durable grant against a mutable roster.
    async function unstampedGroup(
      t: ReturnType<typeof convexTest>,
      teacherId: Id<"users">,
      name: string,
      scholarIds: Id<"users">[],
    ) {
      return await t.run(async (ctx) =>
        ctx.db.insert("scholarGroups", { teacherId, name, emoji: "🦎", scholarIds }),
      );
    }

    test("an EMPTY unstamped group is not a pre-grant vector for an outsider", async () => {
      const t = convexTest(schema, modules);
      const { outsider, moliTeacher } = await twoSchools(t);
      await unstampedGroup(t, moliTeacher, "Future Cohort", []);
      await (await toolsFor(t, moliTeacher)).create_external_app.run({
        name: "Typing Club",
        webUrl: "https://typingclub.com/",
      });

      const res = await (await toolsFor(t, outsider)).enable_app_for_group.run({
        appName: "Typing Club",
        groupName: "Future Cohort",
      });
      expect(res).toMatch(/No group matches/i);
      // The danger is a grant that lies dormant and activates when the group is
      // later populated — so assert nothing was written at all.
      expect(
        await t.run(async (ctx) => ctx.db.query("appAudiences").collect()),
      ).toHaveLength(0);
    });

    test("a MIXED unstamped group is all-or-nothing, not reachable via one member", async () => {
      const t = convexTest(schema, modules);
      const { outsider, moliTeacher, moliScholar, kula } = await twoSchools(t);
      const kulaScholar = await seedUser(t, "scholar", {
        name: "Kula Kid",
        institutionId: kula,
      });
      // Legacy shape: one of MY scholars alongside one of theirs.
      await unstampedGroup(t, moliTeacher, "Mixed Legacy", [
        moliScholar,
        kulaScholar,
      ]);
      await (await toolsFor(t, moliTeacher)).create_external_app.run({
        name: "Typing Club",
        webUrl: "https://typingclub.com/",
      });

      // The Kula teacher owns ONE member — that must not grant to the whole
      // roster (which includes Moli's scholar).
      const res = await (await toolsFor(t, outsider)).enable_app_for_group.run({
        appName: "Typing Club",
        groupName: "Mixed Legacy",
      });
      expect(res).toMatch(/No group matches/i);
      expect(
        await t.run(async (ctx) => ctx.db.query("appAudiences").collect()),
      ).toHaveLength(0);
    });

    test("a platform admin is not tenant-scoped", async () => {
      const t = convexTest(schema, modules);
      const { moliTeacher } = await twoSchools(t);
      await (await toolsFor(t, moliTeacher)).create_external_app.run({
        name: "Typing Club",
        webUrl: "https://typingclub.com/",
      });
      const admin = await seedUser(t, "platform_admin");
      const tools = await toolsFor(t, admin, "platform_admin");
      const res = parse(
        await tools.enable_app_for_group.run({
          appName: "Typing Club",
          groupName: "Geckos",
        }),
      );
      expect(res.enabled).toBe(true);
    });
  });

  test("create_external_app refuses a non-https URL", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const tools = await toolsFor(t, teacher);
    const res = await tools.create_external_app.run({
      name: "Insecure",
      webUrl: "http://insecure.example.com/",
    });
    expect(res).toMatch(/https/i);
    expect(
      await t.run(async (ctx) => ctx.db.query("externalApps").collect()),
    ).toHaveLength(0);
  });

  test("create_external_app dedupes on webUrl instead of making a second tile", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const tools = await toolsFor(t, teacher);
    const a = parse(
      await tools.create_external_app.run({
        name: "Typing Club",
        webUrl: "https://typingclub.com/",
      }),
    );
    const b = parse(
      await tools.create_external_app.run({
        name: "Typing Club (again)",
        webUrl: "https://typingclub.com/",
      }),
    );
    expect(b.appId).toBe(a.appId);
    expect(b.deduped).toBe(true);
    expect(
      await t.run(async (ctx) => ctx.db.query("externalApps").collect()),
    ).toHaveLength(1);
  });
});
