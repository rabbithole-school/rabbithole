import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { Role } from "../lib/roles";
import type { AideEmit } from "../lib/aideStream";
import {
  makeExternalAppsTools,
  redactSecrets,
} from "../lib/externalAppsTools";
import { APP_PLACEMENT_GRACE_MS, APP_PLACEMENT_LEAD_MS } from "../masterSchedule";

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
  via?: "aide" | "slack",
  emit: AideEmit = () => {},
) {
  const tools = await makeExternalAppsTools(actionCtxFor(t), emit, {
    role,
    callerUserId,
    // The private 1:1 surface — the only one that carries the credential tool.
    surface: "private",
    via,
  });
  return Object.fromEntries(tools.map((tl) => [tl.name, tl])) as Record<
    string,
    { run: (input: unknown) => Promise<string> }
  >;
}

const parse = (s: string) => JSON.parse(s) as Record<string, unknown>;

/** A signed-in client, for reading a scholar's own launcher tiles. */
async function signedIn(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 30 * 86_400_000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

/**
 * The "did you mean…" candidate list out of a resolver refusal. Asserting on
 * THIS rather than the whole message is the point: the message legitimately
 * echoes the name the caller typed, so a naive `not.toMatch(name)` would fail
 * on the caller's own input while proving nothing about what leaked.
 */
const candidatesIn = (message: string, label: string) =>
  message.includes(`${label}:`) ? message.split(`${label}:`)[1] : "";

describe("external-apps aide tools (end-to-end)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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
    // The web tile reports its canonical kind so the aide can filter by it.
    expect(apps[0].appKind).toBe("web");
  });

  test("list_external_apps reports each app's canonical appKind (web vs native)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const tools = await toolsFor(t, teacher);

    await tools.create_external_app.run({
      name: "TypingClub",
      webUrl: "https://typingclub.com/",
    });
    await tools.create_external_app.run({
      name: "Google Sheets",
      webUrl: "https://sheets.google.com/",
      nativeUrlScheme: "googlesheets://",
    });

    const listed = parse(await tools.list_external_apps.run({}));
    const apps = listed.apps as Array<Record<string, unknown>>;
    const kindOf = (name: string) =>
      apps.find((a) => a.name === name)?.appKind;
    expect(kindOf("TypingClub")).toBe("web");
    expect(kindOf("Google Sheets")).toBe("native");
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

  /**
   * The regression that matters. `launcherShowsApp` grants access by THREE
   * authorities — a direct scholarApps row, an appAudiences grant, and a LIVE
   * PUSH — and this read used to answer only the first two. So an app whose
   * access came entirely from a schedule block reported "0 group(s), 0
   * school(s), 0 scholar(s)", which is indistinguishable from revoked.
   *
   * 2026-09-21: that output convinced an agent a correctly-configured Scratch
   * had been broken ("those grants got dropped somewhere in the reshuffle").
   * It recommended restoring standing grants; two people approved mid-class,
   * and a deliberate block-scoping was undone — 15 scholars back to 24/7
   * access. The zeros were true. The sentence built on them was not.
   */
  test("an app granted ONLY by a schedule block is reported, not shown as ungranted", async () => {
    const t = convexTest(schema, modules);
    const moli = await ensurePrimaryInstitution(t);
    const teacher = await seedUser(t, "teacher");
    await seedMembership(t, teacher, moli);
    const s1 = await seedUser(t, "scholar", { name: "Kai" });
    const groupId = await seedGroup(t, teacher, "Robotics", [s1]);
    const tools = await toolsFor(t, teacher);

    await tools.create_external_app.run({
      name: "Scratch",
      webUrl: "https://scratch.mit.edu/",
    });
    const appId = await t.run(async (ctx) => {
      const app = await ctx.db
        .query("externalApps")
        .filter((q) => q.eq(q.field("name"), "Scratch"))
        .first();
      return app!._id;
    });

    // Block-scoped ONLY: a placement carrying the app, and no standing grant
    // of any kind — exactly the posture the 2026-09-15 ruling requires.
    const periodId = await t.run(async (ctx) =>
      ctx.db.insert("reportingPeriods", {
        label: "Fall 2026",
        startsAt: Date.now() - 30 * 86_400_000,
        endsAt: Date.now() + 60 * 86_400_000,
        status: "open",
        institutionId: moli,
      }),
    );
    const blockId = await t.run(async (ctx) =>
      ctx.db.insert("scheduleBlocks", {
        periodId,
        key: "blockE",
        label: "Block E",
        startLocal: "15:05",
        endLocal: "16:30",
        weekdays: [1, 3],
        kind: "class",
        order: 0,
      }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        subject: "Robotics",
        teacherId: teacher,
        weekday: 1,
        blockId,
        externalAppId: appId,
        mode: "classFocus",
      }),
    );

    const access = parse(
      await tools.get_external_app_access.run({ appName: "Scratch" }),
    );

    // The old, misleading half is still accurate: there are no standing grants.
    expect(access.groups).toHaveLength(0);
    expect(access.institutions).toHaveLength(0);
    expect(access.scholars).toHaveLength(0);

    // The new half is what stops the false alarm.
    const blockScoped = access.blockScoped as Array<Record<string, unknown>>;
    expect(blockScoped).toHaveLength(1);
    expect(blockScoped[0].group).toBe("Robotics");
    expect(blockScoped[0].block).toBe("Block E");
    expect(blockScoped[0].day).toBe("Mon");
    expect(blockScoped[0].blockLocal).toBe("15:05-16:30");
    // The WINDOW, not the bell: lead-in before, grace after. Pinned as a
    // literal so a constant change has to be seen here.
    expect(blockScoped[0].windowLocal).toBe("14:50-16:40");
    expect(access.recentGrantChanges).toBeDefined();
  });

  test("a shelved placement is not reported as access", async () => {
    const t = convexTest(schema, modules);
    const moli = await ensurePrimaryInstitution(t);
    const teacher = await seedUser(t, "teacher");
    await seedMembership(t, teacher, moli);
    const s1 = await seedUser(t, "scholar", { name: "Kai" });
    const groupId = await seedGroup(t, teacher, "Robotics", [s1]);
    const tools = await toolsFor(t, teacher);
    await tools.create_external_app.run({
      name: "Scratch",
      webUrl: "https://scratch.mit.edu/",
    });
    const appId = await t.run(async (ctx) => {
      const app = await ctx.db
        .query("externalApps")
        .filter((q) => q.eq(q.field("name"), "Scratch"))
        .first();
      return app!._id;
    });
    const periodId = await t.run(async (ctx) =>
      ctx.db.insert("reportingPeriods", {
        label: "Fall 2026",
        startsAt: Date.now() - 30 * 86_400_000,
        endsAt: Date.now() + 60 * 86_400_000,
        status: "open",
        institutionId: moli,
      }),
    );
    // No weekday, no block — a "not yet scheduled" shelf item. It grants
    // nothing, so counting it would overstate access in the other direction.
    await t.run(async (ctx) =>
      ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        subject: "Robotics",
        teacherId: teacher,
        externalAppId: appId,
        mode: "classFocus",
      }),
    );

    const access = parse(
      await tools.get_external_app_access.run({ appName: "Scratch" }),
    );
    expect(access.blockScoped).toHaveLength(0);
    expect(access.pushes).toHaveLength(0);
  });

  /**
   * TRA-426, the teacher's half of 2026-09-21. A teacher pushing an app to a
   * class puts it on every covered scholar's tile with no placement and no
   * standing grant. This read found pushes only through `schedulePlacements`,
   * so it reported nobody while the class was using the app.
   */
  test("a teacher's live app push is reported, not shown as ungranted", async () => {
    vi.useFakeTimers(); // holds makeFocus's auto-clear and allowlist jobs
    vi.setSystemTime(Date.parse("2026-09-28T12:50:00-10:00"));
    const t = convexTest(schema, modules);
    const moli = await ensurePrimaryInstitution(t);
    const teacher = await seedUser(t, "teacher");
    await seedMembership(t, teacher, moli);
    const kai = await seedUser(t, "scholar", { name: "Kai" });
    const groupId = await seedGroup(t, teacher, "Robotics", [kai]);
    const statuses: string[] = [];
    const tools = await toolsFor(t, teacher, "teacher", undefined, (data) => {
      const done = data.toolComplete as { result: string } | undefined;
      if (done) statuses.push(done.result);
    });
    await tools.create_external_app.run({
      name: "Scratch",
      webUrl: "https://scratch.mit.edu/",
    });
    const appId = await t.run(
      async (ctx) => (await ctx.db.query("externalApps").first())!._id,
    );

    // The real writer: the staff aide's make-focus runs the same createFocus
    // as the web dialog. Its default window is 60 minutes.
    const pushed = await t.mutation(internal.pushes.makeFocusFromAide, {
      callerUserId: teacher,
      appId,
      groupId,
    });
    if (!pushed.ok) throw new Error(pushed.message);

    // Positive control: the scholar's tile shows it.
    const asKai = await signedIn(t, kai);
    const tiles = async () =>
      (await asKai.query(api.scholarApps.listForLauncher, {})).map((a) => a.name);
    expect(await tiles()).toEqual(["Scratch"]);

    const access = parse(
      await tools.get_external_app_access.run({ appName: "Scratch" }),
    );
    expect(access.groups).toHaveLength(0);
    expect(access.institutions).toHaveLength(0);
    expect(access.scholars).toHaveLength(0);
    expect(access.blockScoped).toHaveLength(0);
    expect(access.pushes).toEqual([
      expect.objectContaining({
        live: true,
        source: "teacher",
        group: "Robotics",
        liveUntilLocal: "2026-09-28, 13:50",
        overrun: false,
      }),
    ]);
    // The line a human reads in Slack names who and until when, rather than
    // the standing zeros alone.
    expect(statuses.at(-1)).toMatch(/Robotics.*13:50/);

    // Archiving leaves the push open for staff to clear (TRA-337), but every
    // tile drops the app, so it is not live here either.
    await tools.archive_external_app.run({ appName: "Scratch" });
    expect(await tiles()).toEqual([]);
    const archived = parse(
      await tools.get_external_app_access.run({ appName: "Scratch" }),
    );
    expect(archived.pushes).toEqual([
      expect.objectContaining({ live: false, liveUntilLocal: null }),
    ]);
    expect(statuses.at(-1)).not.toMatch(/LIVE/);
    await tools.unarchive_external_app.run({ appName: "Scratch" });
    expect(await tiles()).toEqual(["Scratch"]);

    // Wrapped up, it leaves the tile and this read together.
    await t.mutation(internal.pushes.clearFocusFromAide, {
      callerUserId: teacher,
      pushId: pushed.pushId,
    });
    expect(await tiles()).toEqual([]);
    expect(
      parse(await tools.get_external_app_access.run({ appName: "Scratch" })).pushes,
    ).toEqual([]);
  });

  /**
   * TRA-426, the block's half. A placement's push that runs past its window
   * (block end + grace) with nothing clearing it still shows on the tile
   * until the school day ends: `isPushShowing`, the rule the tile follows.
   * This read judged pushes with its own `startsAt <= now < endsAt` and
   * reported nobody.
   */
  test("a block's push that outruns its window is reported live until the school day ends", async () => {
    vi.useFakeTimers(); // the activation and auto-clear run only when this test runs them
    const blockStart = Date.parse("2026-09-28T13:00:00-10:00"); // a Monday
    const windowOpens = blockStart - APP_PLACEMENT_LEAD_MS;
    const windowCloses = blockStart + 60 * 60_000 + APP_PLACEMENT_GRACE_MS;
    vi.setSystemTime(windowOpens - 15 * 60_000);
    const t = convexTest(schema, modules);
    const moli = await ensurePrimaryInstitution(t);
    const teacher = await seedUser(t, "teacher");
    await seedMembership(t, teacher, moli);
    const kai = await seedUser(t, "scholar", { name: "Kai" });
    const groupId = await seedGroup(t, teacher, "Robotics", [kai]);
    const statuses: string[] = [];
    const tools = await toolsFor(t, teacher, "teacher", undefined, (data) => {
      const done = data.toolComplete as { result: string } | undefined;
      if (done) statuses.push(done.result);
    });
    await tools.create_external_app.run({
      name: "Scratch",
      webUrl: "https://scratch.mit.edu/",
    });
    const appId = await t.run(
      async (ctx) => (await ctx.db.query("externalApps").first())!._id,
    );
    const { periodId, blockId } = await t.run(async (ctx) => {
      const periodId = await ctx.db.insert("reportingPeriods", {
        label: "Fall 2026",
        startsAt: Date.now() - 30 * 86_400_000,
        endsAt: Date.now() + 60 * 86_400_000,
        status: "open",
        institutionId: moli,
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
      return { periodId, blockId };
    });

    // The real writers: the aide's place_class materializes today's window,
    // and its activation job opens it at the lead-in.
    const placementId = await t.mutation(internal.masterSchedule.aidePlaceClass, {
      callerUserId: teacher,
      periodId,
      groupId,
      subject: "Robotics",
      teacherId: teacher,
      weekday: 1,
      blockId,
      externalAppId: appId,
    });
    const [push] = await t.run((ctx) =>
      ctx.db
        .query("pushes")
        .withIndex("by_schedule_placement", (q) =>
          q.eq("schedulePlacementId", placementId),
        )
        .collect(),
    );
    vi.setSystemTime(windowOpens);
    await t.mutation(internal.masterSchedule.activatePlacementAppPush, {
      placementId,
      pushId: push._id,
    });

    // 50 minutes past the window's close, and the auto-clear never landed.
    vi.setSystemTime(windowCloses + 50 * 60_000);
    const asKai = await signedIn(t, kai);
    const tiles = async () =>
      (await asKai.query(api.scholarApps.listForLauncher, {})).map((a) => a.name);
    expect(await tiles()).toEqual(["Scratch"]);
    const access = parse(
      await tools.get_external_app_access.run({ appName: "Scratch" }),
    );
    expect(access.pushes).toEqual([
      expect.objectContaining({
        live: true,
        source: "schedule",
        group: "Robotics",
        liveUntilLocal: "2026-09-29, 00:00",
        overrun: true,
      }),
    ]);
    // Midnight is the bound, not a forecast: a clear normally lands within
    // minutes, and the line a human reads says so.
    expect(statuses.at(-1)).toMatch(/Robotics until 2026-09-29, 00:00 at the latest/);

    // And it does end then: past midnight the tile and this read drop it together.
    vi.setSystemTime(Date.parse("2026-09-29T00:30:00-10:00"));
    expect(await tiles()).toEqual([]);
    const nextDay = parse(
      await tools.get_external_app_access.run({ appName: "Scratch" }),
    );
    expect(
      (nextDay.pushes as Array<{ live: boolean }>).filter((p) => p.live),
    ).toEqual([]);
  });

  /**
   * TRA-445. The app-wide answer names a push to a list of scholars only as a
   * count ("1 scholar"), so it could not say whether a GIVEN scholar was
   * covered. Asked about one scholar, the tool answers for them, and the line
   * a human reads in Slack is that answer.
   */
  test("asked about one scholar, it says whether they can open the app, why, and until when", async () => {
    vi.useFakeTimers(); // holds makeFocus's auto-clear and allowlist jobs
    vi.setSystemTime(Date.parse("2026-09-28T12:50:00-10:00"));
    const t = convexTest(schema, modules);
    const moli = await ensurePrimaryInstitution(t);
    const teacher = await seedUser(t, "teacher", { name: "Sloane Kahale" });
    await seedMembership(t, teacher, moli);
    const kai = await seedUser(t, "scholar", { name: "Kai Kahale", username: "kai_kahale" });
    await seedUser(t, "scholar", { name: "Lani Kahale", username: "lani_kahale" });
    const statuses: string[] = [];
    const tools = await toolsFor(t, teacher, "teacher", undefined, (data) => {
      const done = data.toolComplete as { result: string } | undefined;
      if (done) statuses.push(done.result);
    });
    await tools.create_external_app.run({
      name: "Scratch",
      webUrl: "https://scratch.mit.edu/",
    });
    const appId = await t.run(
      async (ctx) => (await ctx.db.query("externalApps").first())!._id,
    );
    await (await signedIn(t, teacher)).mutation(api.pushes.makeFocus, {
      scholarIds: [kai],
      target: { kind: "app", externalAppId: appId },
    });

    const access = parse(
      await tools.get_external_app_access.run({ appName: "Scratch", scholar: "kai_kahale" }),
    );
    expect(access.forScholar).toMatchObject({
      name: "Kai Kahale",
      canOpen: true,
      untilLocal: "2026-09-28, 13:50",
      via: [
        expect.objectContaining({
          route: "teacher push",
          name: "Sloane Kahale's push to them alone",
        }),
      ],
    });
    // Their answer first, then the app-wide clocked parts.
    expect(statuses.at(-1)).toBe(
      "Kai Kahale can open Scratch via Sloane Kahale's push to them alone, until 13:50, when the window closes. App-wide: LIVE now for 1 scholar until 2026-09-28, 13:50.",
    );
    // A classmate the push leaves out.
    await tools.get_external_app_access.run({ appName: "Scratch", scholar: "Lani Kahale" });
    expect(statuses.at(-1)).toBe(
      "Lani Kahale can't open Scratch right now, and no class they're in is on their school's schedule for it. App-wide: LIVE now for 1 scholar until 2026-09-28, 13:50.",
    );

    // Without `scholar`, the line is the app-wide one it always was.
    const appWide = parse(await tools.get_external_app_access.run({ appName: "Scratch" }));
    expect(appWide).not.toHaveProperty("forScholar");
    expect(statuses.at(-1)).toBe(
      "Scratch: standing — 0 group(s), 0 school(s), 0 scholar(s); LIVE now for 1 scholar until 2026-09-28, 13:50",
    );

    // An unknown scholar (or one outside the caller's school) is an error.
    expect(
      await tools.get_external_app_access.run({ appName: "Scratch", scholar: "nobody_here" }),
    ).toMatch(/^Could not read access: No scholar matches "nobody_here"/);
  });

  /**
   * The review's repro of the 2026-09-21 shape: an app granted only by a
   * class block, asked about a scholar in that class before the window. The
   * answer must say when they CAN, and never read as a missing grant.
   */
  test("asked about a scholar before their block, it says when the app opens for them", async () => {
    vi.useFakeTimers(); // the activation job runs only if this test runs it
    vi.setSystemTime(Date.parse("2026-09-28T14:20:00-10:00")); // a Monday
    const t = convexTest(schema, modules);
    const moli = await ensurePrimaryInstitution(t);
    const teacher = await seedUser(t, "teacher", { name: "Sloane Kahale" });
    await seedMembership(t, teacher, moli);
    const kai = await seedUser(t, "scholar", { name: "Kai Kahale", username: "kai_kahale" });
    await seedUser(t, "scholar", { name: "Lani Kahale", username: "lani_kahale" });
    const groupId = await seedGroup(t, teacher, "Robotics", [kai]);
    const statuses: string[] = [];
    const tools = await toolsFor(t, teacher, "teacher", undefined, (data) => {
      const done = data.toolComplete as { result: string } | undefined;
      if (done) statuses.push(done.result);
    });
    await tools.create_external_app.run({
      name: "Scratch",
      webUrl: "https://scratch.mit.edu/",
    });
    const appId = await t.run(
      async (ctx) => (await ctx.db.query("externalApps").first())!._id,
    );
    const { periodId, blockId } = await t.run(async (ctx) => {
      const periodId = await ctx.db.insert("reportingPeriods", {
        label: "Fall 2026",
        startsAt: Date.now() - 30 * 86_400_000,
        endsAt: Date.now() + 60 * 86_400_000,
        status: "open",
        institutionId: moli,
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
    // Block-scoped only, by the aide's own writer: no standing grant at all.
    await t.mutation(internal.masterSchedule.aidePlaceClass, {
      callerUserId: teacher,
      periodId,
      groupId,
      subject: "Robotics",
      teacherId: teacher,
      weekday: 1,
      blockId,
      externalAppId: appId,
    });

    vi.setSystemTime(Date.parse("2026-09-28T14:35:00-10:00"));
    const access = parse(
      await tools.get_external_app_access.run({ appName: "Scratch", scholar: "kai_kahale" }),
    );
    // "When" is the scheduler's planned push; the class is configuration.
    expect(access.forScholar).toMatchObject({
      canOpen: false,
      whyNot: "no-route",
      when: {
        opens: [
          {
            atLocal: "2026-09-28, 14:50",
            name: "for Robotics (Block E)",
            windowLocal: "2026-09-28, 14:50 - 2026-09-28, 16:40",
          },
        ],
        wrappedToday: [],
        scheduled: [
          expect.objectContaining({
            name: "Robotics during Block E",
            windowLocal: "Mon 14:50-16:40",
            termStatus: "current",
          }),
        ],
      },
    });
    expect(statuses.at(-1)).toBe(
      "Kai Kahale can't open Scratch right now. It opens at 14:50 today for Robotics (Block E). Scratch is scheduled for Robotics during Block E (Mon 14:50-16:40) this term (ends Nov 27). App-wide: 1 block-scoped (Robotics Block E Mon 14:50-16:40); not open yet for Robotics 2026-09-28, 14:50 - 2026-09-28, 16:40.",
    );
    // Not in Robotics: no class they're in is on their school's schedule for it, said
    // plainly, and the app-wide part shows the app is block-scoped for
    // someone else.
    await tools.get_external_app_access.run({ appName: "Scratch", scholar: "lani_kahale" });
    expect(statuses.at(-1)).toBe(
      "Lani Kahale can't open Scratch right now, and no class they're in is on their school's schedule for it. App-wide: 1 block-scoped (Robotics Block E Mon 14:50-16:40); not open yet for Robotics 2026-09-28, 14:50 - 2026-09-28, 16:40.",
    );
    // Neither line offers a grant as the fix (the 2026-09-15 ruling).
    expect(statuses.slice(-2).join(" ")).not.toMatch(/grant/);
  });

  /**
   * One instant for the whole answer. The action takes Date.now() once and
   * the query judges both the app-wide `pushes` list and `forScholar` at it.
   * Before, the list was judged at the start of the minute and the scholar at
   * the query's own clock, so in the seconds after a teacher's push ended
   * (13:00:30 here) one half said "until 13:00" and the other "overrun".
   */
  test("the scholar's answer and the app-wide push list agree about a push that just ended", async () => {
    vi.useFakeTimers(); // holds makeFocus's auto-clear, so the push overruns
    vi.setSystemTime(Date.parse("2026-09-28T12:30:30-10:00"));
    const t = convexTest(schema, modules);
    const moli = await ensurePrimaryInstitution(t);
    const teacher = await seedUser(t, "teacher", { name: "Sloane Kahale" });
    await seedMembership(t, teacher, moli);
    const kai = await seedUser(t, "scholar", { name: "Kai Kahale", username: "kai_kahale" });
    const tools = await toolsFor(t, teacher);
    await tools.create_external_app.run({
      name: "Scratch",
      webUrl: "https://scratch.mit.edu/",
    });
    const appId = await t.run(
      async (ctx) => (await ctx.db.query("externalApps").first())!._id,
    );
    await (await signedIn(t, teacher)).mutation(api.pushes.makeFocus, {
      scholarIds: [kai],
      target: { kind: "app", externalAppId: appId },
      durationMin: 30, // ends 13:00:30
    });
    type Halves = {
      forScholar: { untilLocal: string | null; via: Array<{ overrun: boolean }> };
      pushes: Array<{ liveUntilLocal: string | null; overrun: boolean }>;
    };
    const ask = async () =>
      JSON.parse(
        await tools.get_external_app_access.run({ appName: "Scratch", scholar: "kai_kahale" }),
      ) as Halves;

    vi.setSystemTime(Date.parse("2026-09-28T13:00:20-10:00"));
    let halves = await ask();
    expect(halves.forScholar.via[0].overrun).toBe(false);
    expect(halves.pushes[0].overrun).toBe(false);
    expect(halves.forScholar.untilLocal).toBe("2026-09-28, 13:00");
    expect(halves.pushes[0].liveUntilLocal).toBe("2026-09-28, 13:00");

    vi.setSystemTime(Date.parse("2026-09-28T13:00:40-10:00"));
    halves = await ask();
    expect(halves.forScholar.via[0].overrun).toBe(true);
    expect(halves.pushes[0].overrun).toBe(true);
    expect(halves.forScholar.untilLocal).toBe("2026-09-29, 00:00");
    expect(halves.pushes[0].liveUntilLocal).toBe("2026-09-29, 00:00");
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

  test("Slack grant tools stamp the Slack entry path", async () => {
    const t = convexTest(schema, modules);
    const moli = await ensurePrimaryInstitution(t);
    const teacher = await seedUser(t, "teacher");
    await seedMembership(t, teacher, moli);
    const scholar = await seedUser(t, "scholar", { name: "Kai" });
    await seedGroup(t, teacher, "Geckos", [scholar]);
    const tools = await toolsFor(t, teacher, "teacher", "slack");

    await tools.create_external_app.run({
      name: "Typing Club",
      webUrl: "https://typingclub.com/",
    });
    await tools.enable_app_for_group.run({
      appName: "Typing Club",
      groupName: "Geckos",
    });

    const rows = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].detail ?? "{}")).toMatchObject({
      via: "slack",
    });
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

  test("saves a named scholar's External App login without returning its credentials", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", {
      name: "Leilani Park",
      username: "leilani_park",
    });
    const tools = await toolsFor(t, teacher);

    const created = parse(await tools.create_external_app.run({
      name: "Scratch",
      webUrl: "https://scratch.mit.edu/",
    }));
    await tools.enable_app_for_scholar.run({
      appName: "Scratch",
      scholar: "leilani_park",
    });

    const result = await tools.set_external_app_login.run({
      appName: "Scratch",
      scholar: "leilani_park",
      username: " leilani ",
      password: "not-a-real-password",
    });
    expect(result).not.toContain("leilani ");
    expect(result).not.toContain("not-a-real-password");

    const link = await t.run(async (ctx) =>
      ctx.db
        .query("scholarApps")
        .withIndex("by_scholar_app", (q) =>
          q
            .eq("scholarId", scholar)
            .eq("appId", created.appId as Id<"externalApps">),
        )
        .first(),
    );
    expect(link?.loginUsername).toBe("leilani");
    expect(link?.loginPassword).toBe("not-a-real-password");
  });

  test("offers the credential-bearing tool only when the surface is explicitly private", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const namesFor = async (surface?: "private" | "channel") => {
      const tools = await makeExternalAppsTools(actionCtxFor(t), () => {}, {
        role: "teacher",
        callerUserId: teacher,
        ...(surface ? { surface } : {}),
      });
      return tools.map((tool) => tool.name);
    };
    expect(await namesFor("channel")).not.toContain("set_external_app_login");
    // An OMITTED surface is how the MCP connector assembles tools, and its
    // service accounts can be one identity shared by a whole channel — so the
    // default must fail closed, exactly as the password/passkey resets do.
    expect(await namesFor(undefined)).not.toContain("set_external_app_login");
    expect(await namesFor("private")).toContain("set_external_app_login");
  });

  test("no failure message can carry a submitted secret back to the model", () => {
    // The mutation's argument validator quotes the value it rejected — the
    // shape of message this exists for.
    expect(
      redactSecrets(
        'Value does not match validator. Path: .password Value: "hunter2" Validator: v.string()',
        ["leilani", "hunter2"],
      ),
    ).toBe(
      'Value does not match validator. Path: .password Value: "[redacted]" Validator: v.string()',
    );
    expect(redactSecrets("hunter2 hunter2", ["hunter2"])).toBe("[redacted] [redacted]");
    // Empty and omitted fields carry no secret and must not blank the message.
    expect(redactSecrets("Scholar not found", ["", undefined])).toBe("Scholar not found");
  });

  test("reports a clear, not a save, when nothing is left on a scholar-app login", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    await seedUser(t, "scholar", { name: "Leilani Park", username: "leilani_park" });
    const tools = await toolsFor(t, teacher);
    parse(await tools.create_external_app.run({ name: "Scratch", webUrl: "https://scratch.mit.edu/" }));
    await tools.enable_app_for_scholar.run({ appName: "Scratch", scholar: "leilani_park" });
    await tools.set_external_app_login.run({ appName: "Scratch", scholar: "leilani_park", username: "leilani" });

    // Username was the only field on file; emptying it leaves nothing.
    const res = parse(await tools.set_external_app_login.run({
      appName: "Scratch",
      scholar: "leilani_park",
      username: "",
    }));
    expect(res.cleared).toBe(true);
  });

  test("a library-card app never loses its card to a PIN-only update, and a numeric PIN is stored as text", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", {
      name: "Leilani Park",
      username: "leilani_park",
    });
    const tools = await toolsFor(t, teacher);
    parse(await tools.create_external_app.run({
      name: "Public Library",
      webUrl: "https://library.example/",
      credentialSource: "libraryCard",
    }));
    await tools.enable_app_for_scholar.run({
      appName: "Public Library",
      scholar: "leilani_park",
    });
    const credential = async () =>
      (await t.run((ctx) => ctx.db.get(scholar)))?.libraryCredential;

    // No card on file yet: a PIN alone has nothing to attach to. The old
    // path wrote `libraryCredential: undefined` here and said "Saved".
    const refused = await tools.set_external_app_login.run({
      appName: "Public Library",
      scholar: "leilani_park",
      password: "4321",
    });
    expect(refused).toContain("no library card number on file");
    expect(refused).not.toContain("4321");
    expect(await credential()).toBeUndefined();

    // Card + PIN, with the PIN arriving as a JSON number the way a model
    // tends to send all-digit strings.
    const saved = await tools.set_external_app_login.run({
      appName: "Public Library",
      scholar: "leilani_park",
      username: " 2100 0123 4567 ",
      password: 4321,
    });
    expect(saved).not.toContain("4321");
    expect(saved).not.toContain("2100");
    expect(await credential()).toEqual({ id: "2100 0123 4567", password: "4321" });

    // With a card on file, a PIN-only update keeps the card — and the PIN is
    // stored trimmed, the way the guardian-facing writer stores it.
    await tools.set_external_app_login.run({
      appName: "Public Library",
      scholar: "leilani_park",
      password: " 9999 ",
    });
    expect(await credential()).toEqual({ id: "2100 0123 4567", password: "9999" });

    // An explicit empty card number is the deliberate clear.
    const cleared = parse(await tools.set_external_app_login.run({
      appName: "Public Library",
      scholar: "leilani_park",
      username: "",
    }));
    expect(cleared.cleared).toBe(true);
    expect(await credential()).toBeUndefined();
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

    test("a push is reported only to its own school", async () => {
      vi.useFakeTimers(); // holds makeFocus's auto-clear and allowlist jobs
      const t = convexTest(schema, modules);
      const { outsider, moliTeacher } = await twoSchools(t);
      const moliTools = await toolsFor(t, moliTeacher);
      await moliTools.create_external_app.run({
        name: "Typing Club",
        webUrl: "https://typingclub.com/",
      });
      const { appId, groupId } = await t.run(async (ctx) => ({
        appId: (await ctx.db.query("externalApps").first())!._id,
        groupId: (await ctx.db.query("scholarGroups").first())!._id,
      }));
      const pushed = await t.mutation(internal.pushes.makeFocusFromAide, {
        callerUserId: moliTeacher,
        appId,
        groupId,
      });
      if (!pushed.ok) throw new Error(pushed.message);

      const own = parse(
        await moliTools.get_external_app_access.run({ appName: "Typing Club" }),
      );
      expect(own.pushes).toEqual([
        expect.objectContaining({ live: true, group: "Geckos" }),
      ]);
      const seen = parse(
        await (await toolsFor(t, outsider)).get_external_app_access.run({
          appName: "Typing Club",
        }),
      );
      expect(seen.pushes).toEqual([]);
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
