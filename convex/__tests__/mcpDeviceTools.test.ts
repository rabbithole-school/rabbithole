import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, internal } from "../_generated/api";
import schema from "../schema";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// The managed-iPad surface of the OAuth MCP connector. convex/mcp.ts is the
// SECURITY BOUNDARY — the Next route's registration is UX — so these tests
// drive api.mcp.listDeviceTools / callDeviceTool directly and pin the three
// gates that stand between a chat client and a child's device: the
// school-operations capability, the institution boundary, and the disarm
// argument validation. The tool prose asks a model to list-then-confirm
// before writing; none of these tests rely on it doing so, because prompt
// confirmation is never the authorization boundary.

type TestHarness = ReturnType<typeof convexTest>;
type SeedRole = "teacher" | "staff" | "scholar" | "parent" | "platform_admin";

async function seedInstitution(t: TestHarness, slug: string) {
  return await t.run((ctx) =>
    ctx.db.insert("institutions", {
      name: slug,
      slug,
      kind: "school" as const,
      timeZone: "Pacific/Honolulu",
    }),
  );
}

async function seedUser(
  t: TestHarness,
  role: SeedRole,
  institutionId?: Id<"institutions">,
  name = `Test ${role}`,
) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      name,
      username: name.toLowerCase().replaceAll(" ", "-"),
      role,
      ...(role === "scholar" && institutionId ? { institutionId } : {}),
    }),
  );
  if (role !== "scholar" && role !== "parent" && institutionId) {
    await t.run((ctx) =>
      ctx.db.insert("memberships", { userId, role, institutionId }),
    );
  }
  return userId;
}

/** A base `staff` account only reaches device operations through an active,
 *  institution-scoped school:operations grant. */
async function grantSchoolOperations(
  t: TestHarness,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
) {
  await t.run((ctx) =>
    ctx.db.insert("staffCapabilityGrants", {
      granteeUserId: userId,
      institutionId,
      capability: "school:operations",
      grantedBy: userId,
      grantedAt: Date.now(),
    }),
  );
}

async function withUser(t: TestHarness, userId: Id<"users">) {
  const sessionId = await t.run((ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1_000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedPairedDevice(
  t: TestHarness,
  institutionId: Id<"institutions">,
  scholarId: Id<"users">,
  pairedBy: Id<"users">,
  deviceId: string,
) {
  return await t.run((ctx) =>
    ctx.db.insert("pairedDevices", {
      deviceId,
      deviceLabel: `iPad ${deviceId}`,
      scholarId,
      institutionId,
      pairedAt: Date.now(),
      pairedBy,
    }),
  );
}

async function seedManagedClaim(
  t: TestHarness,
  institutionId: Id<"institutions">,
  createdBy: Id<"users">,
  serial: string,
  lastDeviceId: string,
  scholarId?: Id<"users">,
) {
  const now = Date.now();
  return await t.run((ctx) =>
    ctx.db.insert("managedDeviceClaims", {
      institutionId,
      serial,
      scholarId,
      claimState: "claimed" as const,
      createdBy,
      createdAt: now,
      updatedAt: now,
      claimIssuedAt: now,
      rotationCount: 0,
      claimCount: 1,
      lastDeviceId,
    }),
  );
}

/** One school, one teacher, one scholar on a claimed + paired iPad. */
async function seedSchool(t: TestHarness, slug: string, scholarName: string) {
  const institutionId = await seedInstitution(t, slug);
  const teacherId = await seedUser(t, "teacher", institutionId, `${slug} teacher`);
  const scholarId = await seedUser(t, "scholar", institutionId, scholarName);
  const pairedDeviceId = await seedPairedDevice(
    t,
    institutionId,
    scholarId,
    teacherId,
    `ipad-${slug}`,
  );
  await seedManagedClaim(
    t,
    institutionId,
    teacherId,
    `SERIAL-${slug.toUpperCase()}`,
    `ipad-${slug}`,
    scholarId,
  );
  return { institutionId, teacherId, scholarId, pairedDeviceId };
}

const DEVICE_TOOL_NAMES = [
  "list_managed_devices",
  "list_rabbithole_lock_devices",
  "set_rabbithole_lock",
];

describe("mcp device tools — who sees them", () => {
  test("a teacher gets the full managed-iPad toolset", async () => {
    const t = convexTest(schema, modules);
    const { teacherId } = await seedSchool(t, "moli", "Kai");

    const asTeacher = await withUser(t, teacherId);
    const tools = await asTeacher.action(api.mcp.listDeviceTools, {});
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...DEVICE_TOOL_NAMES].sort(),
    );
  });

  test("base staff WITHOUT school:operations gets nothing, and the write tool refuses by name", async () => {
    const t = convexTest(schema, modules);
    const { institutionId, pairedDeviceId } = await seedSchool(t, "moli", "Kai");
    // A staff membership at the school, but no capability grant — the exact
    // shape a role-only check would wave through.
    const ungrantedStaff = await seedUser(t, "staff", institutionId, "Ungranted Staff");

    const asStaff = await withUser(t, ungrantedStaff);
    expect(await asStaff.action(api.mcp.listDeviceTools, {})).toEqual([]);
    await expect(
      asStaff.action(api.mcp.callDeviceTool, {
        name: "set_rabbithole_lock",
        input: { paired_device_ids: [pairedDeviceId], state: "disarmed" },
      }),
    ).rejects.toThrow("Forbidden");
    // Nothing moved.
    expect(
      (await t.run((ctx) => ctx.db.get(pairedDeviceId)))
        ?.rabbitholeLockDesiredState,
    ).toBeUndefined();
  });

  test("base staff WITH an active school:operations grant does get them", async () => {
    const t = convexTest(schema, modules);
    const { institutionId } = await seedSchool(t, "moli", "Kai");
    const opsStaff = await seedUser(t, "staff", institutionId, "Ops Staff");
    await grantSchoolOperations(t, opsStaff, institutionId);

    const asStaff = await withUser(t, opsStaff);
    const tools = await asStaff.action(api.mcp.listDeviceTools, {});
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...DEVICE_TOOL_NAMES].sort(),
    );
  });

  test("a granted operations staffer can list AND command their school's iPads", async () => {
    const t = convexTest(schema, modules);
    const { institutionId, pairedDeviceId } = await seedSchool(t, "moli", "Kai");
    await seedSchool(t, "other", "Hoku");
    const opsStaff = await seedUser(t, "staff", institutionId, "Ops Staff");
    await grantSchoolOperations(t, opsStaff, institutionId);

    const asStaff = await withUser(t, opsStaff);
    const devices = JSON.parse(
      await asStaff.action(api.mcp.callDeviceTool, {
        name: "list_managed_devices",
        input: {},
      }),
    ) as { serial: string }[];
    // The grant scopes the lens, not just the role: the second school's iPad
    // is absent even though "all" was requested internally.
    expect(devices.map((device) => device.serial)).toEqual(["SERIAL-MOLI"]);

    await asStaff.action(api.mcp.callDeviceTool, {
      name: "set_rabbithole_lock",
      input: {
        paired_device_ids: [pairedDeviceId],
        state: "disarmed",
        disarm_mode: "until_further_notice",
      },
    });
    expect(await t.run((ctx) => ctx.db.get(pairedDeviceId))).toMatchObject({
      rabbitholeLockDesiredState: "disarmed",
      rabbitholeLockDisarmMode: "until_further_notice",
    });
  });

  test("a parent and a scholar see no device surface at all", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, pairedDeviceId } = await seedSchool(t, "moli", "Kai");
    const parentId = await seedUser(t, "parent", undefined, "Parent");

    for (const userId of [parentId, scholarId]) {
      const asUser = await withUser(t, userId);
      expect(await asUser.action(api.mcp.listDeviceTools, {})).toEqual([]);
      await expect(
        asUser.action(api.mcp.callDeviceTool, {
          name: "set_rabbithole_lock",
          input: { paired_device_ids: [pairedDeviceId], state: "disarmed" },
        }),
      ).rejects.toThrow("Forbidden");
    }
  });
});

describe("mcp device tools — the institution boundary", () => {
  test("list_managed_devices shows only the caller's own school's iPads", async () => {
    const t = convexTest(schema, modules);
    const home = await seedSchool(t, "moli", "Kai");
    await seedSchool(t, "other", "Hoku");

    const asTeacher = await withUser(t, home.teacherId);
    const raw = await asTeacher.action(api.mcp.callDeviceTool, {
      name: "list_managed_devices",
      input: {},
    });
    const devices = JSON.parse(raw) as {
      serial: string;
      scholar: string | null;
      pairedDeviceId: string | null;
      appAccess: { key: string; blocker: string | null }[];
    }[];

    expect(devices.map((device) => device.serial)).toEqual(["SERIAL-MOLI"]);
    expect(devices[0]).toMatchObject({
      scholar: "Kai",
      pairedDeviceId: home.pairedDeviceId,
    });
    // The device-truth panel's four-fact rows travel with the row, so a model
    // can answer "can Kai open <app>, and what is stopping it?" in one call.
    // Assert the DERIVED value, not merely the key's presence: this fixture
    // seeds a scholar but no app grant and no unlock binding, so every row
    // must name "binding" as the first fact in the way. A payload that had
    // come loose from stored device state would not produce that.
    expect(devices[0].appAccess.length).toBeGreaterThan(0);
    expect(
      devices[0].appAccess.every((app) => app.blocker === "binding"),
    ).toBe(true);
  });

  // TRA-434: a scholar's deletion leaves their iPad's claim for staff to
  // reassign. The tool lists it as the console does, flagged, and the
  // institution boundary still holds for it.
  test("list_managed_devices keeps a deleted scholar's iPad, flagged, in its own school only", async () => {
    const t = convexTest(schema, modules);
    const home = await seedSchool(t, "moli", "Kai");
    const foreign = await seedSchool(t, "other", "Hoku");
    const admin = await seedUser(t, "platform_admin", undefined, "Platform Admin");
    const asAdmin = await withUser(t, admin);
    await asAdmin.mutation(api.users.deleteUser, { userId: home.scholarId });
    await asAdmin.mutation(api.users.deleteUser, { userId: foreign.scholarId });

    const asTeacher = await withUser(t, home.teacherId);
    const devices = JSON.parse(
      await asTeacher.action(api.mcp.callDeviceTool, {
        name: "list_managed_devices",
        input: {},
      }),
    ) as {
      serial: string;
      scholar: string | null;
      scholarDeleted: boolean;
      appAccessError: string | null;
      appAccess: { blocker: string | null }[];
    }[];
    expect(devices.map((device) => device.serial)).toEqual(["SERIAL-MOLI"]);
    expect(devices[0]).toMatchObject({
      scholar: null,
      scholarDeleted: true,
      appAccessError: null,
    });
    // With nobody assigned, "scholar" is the first fact in the way of every app.
    expect(devices[0].appAccess.every((app) => app.blocker === "scholar")).toBe(true);
  });

  test("list_rabbithole_lock_devices resolves by scholar name within the caller's school", async () => {
    const t = convexTest(schema, modules);
    const home = await seedSchool(t, "moli", "Kai");
    await seedSchool(t, "other", "Kaiona");

    const asTeacher = await withUser(t, home.teacherId);
    const raw = await asTeacher.action(api.mcp.callDeviceTool, {
      name: "list_rabbithole_lock_devices",
      input: { search: "Kai" },
    });
    const devices = JSON.parse(raw) as {
      pairedDeviceId: string;
      scholar: string;
    }[];
    // "Kai" matches the other school's "Kaiona" too — scoping, not the search
    // string, is what keeps it out.
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      pairedDeviceId: home.pairedDeviceId,
      scholar: "Kai",
    });
  });

  test("set_rabbithole_lock refuses a device in another institution", async () => {
    const t = convexTest(schema, modules);
    const home = await seedSchool(t, "moli", "Kai");
    const foreign = await seedSchool(t, "other", "Hoku");

    const asTeacher = await withUser(t, home.teacherId);
    const message = await asTeacher.action(api.mcp.callDeviceTool, {
      name: "set_rabbithole_lock",
      input: {
        paired_device_ids: [foreign.pairedDeviceId],
        state: "disarmed",
        disarm_mode: "until_further_notice",
      },
    });
    expect(message).toContain("unavailable in your school context");
    expect(
      (await t.run((ctx) => ctx.db.get(foreign.pairedDeviceId)))
        ?.rabbitholeLockDesiredState,
    ).toBeUndefined();
  });

  test("a mixed-tenant batch changes nothing, including the caller's own device", async () => {
    const t = convexTest(schema, modules);
    const home = await seedSchool(t, "moli", "Kai");
    const foreign = await seedSchool(t, "other", "Hoku");

    const asTeacher = await withUser(t, home.teacherId);
    await asTeacher.action(api.mcp.callDeviceTool, {
      name: "set_rabbithole_lock",
      input: {
        paired_device_ids: [home.pairedDeviceId, foreign.pairedDeviceId],
        state: "disarmed",
      },
    });
    const rows = await t.run((ctx) => ctx.db.query("pairedDevices").collect());
    expect(
      rows.every((row) => row.rabbitholeLockDesiredState === undefined),
    ).toBe(true);
  });
});

describe("mcp device tools — the write itself", () => {
  test("a timed disarm without disarm_minutes is refused", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, pairedDeviceId } = await seedSchool(t, "moli", "Kai");

    const asTeacher = await withUser(t, teacherId);
    await expect(
      asTeacher.action(api.mcp.callDeviceTool, {
        name: "set_rabbithole_lock",
        input: {
          paired_device_ids: [pairedDeviceId],
          state: "disarmed",
          disarm_mode: "timed",
        },
      }),
    ).rejects.toThrow("disarmMinutes");
    expect(
      (await t.run((ctx) => ctx.db.get(pairedDeviceId)))
        ?.rabbitholeLockDesiredState,
    ).toBeUndefined();
  });

  test("an out-of-range timed disarm is refused too", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, pairedDeviceId } = await seedSchool(t, "moli", "Kai");

    const asTeacher = await withUser(t, teacherId);
    await expect(
      asTeacher.action(api.mcp.callDeviceTool, {
        name: "set_rabbithole_lock",
        input: {
          paired_device_ids: [pairedDeviceId],
          state: "disarmed",
          disarm_mode: "timed",
          disarm_minutes: 9000,
        },
      }),
    ).rejects.toThrow();
    expect(
      (await t.run((ctx) => ctx.db.get(pairedDeviceId)))
        ?.rabbitholeLockDesiredState,
    ).toBeUndefined();
  });

  test("a valid disarm lands and audits itself as MCP, not Slack", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, pairedDeviceId } = await seedSchool(t, "moli", "Kai");

    const asTeacher = await withUser(t, teacherId);
    const message = await asTeacher.action(api.mcp.callDeviceTool, {
      name: "set_rabbithole_lock",
      input: {
        paired_device_ids: [pairedDeviceId],
        state: "disarmed",
        disarm_mode: "timed",
        disarm_minutes: 45,
      },
    });
    expect(message).toContain("45 minutes");
    expect(await t.run((ctx) => ctx.db.get(pairedDeviceId))).toMatchObject({
      rabbitholeLockDesiredState: "disarmed",
      rabbitholeLockDisarmMode: "timed",
    });

    // The whole reason setFromSlack became setFromAgent: an ops audit line
    // must name the surface the command actually came from.
    const audits = await t.run((ctx) => ctx.db.query("auditLog").collect());
    const disarm = audits.find(
      (row) => row.action === "device.rabbithole-lock.disarm",
    );
    expect(disarm?.detail).toContain("via mcp");
  });
});

describe("mcp device tools — the database backstop, reached directly", () => {
  // The tests above prove the OUTER gate (mcpDeviceTools never assembles the
  // tool). That gate is not the security boundary — the internal functions
  // are. These call them directly, the way a future transport that forgot the
  // factory would, so removing the outer gate alone cannot make the backstop
  // silently untested.

  test("the internal write refuses an ungranted staff caller outright", async () => {
    const t = convexTest(schema, modules);
    const { institutionId, pairedDeviceId } = await seedSchool(t, "moli", "Kai");
    const ungrantedStaff = await seedUser(t, "staff", institutionId, "Ungranted Staff");

    const result = await t.mutation(internal.deviceLock.setFromAgent, {
      callerUserId: ungrantedStaff,
      source: "mcp" as const,
      pairedDeviceIds: [pairedDeviceId],
      state: "disarmed" as const,
    });
    expect(result).toMatchObject({ ok: false });
    expect(
      (await t.run((ctx) => ctx.db.get(pairedDeviceId)))
        ?.rabbitholeLockDesiredState,
    ).toBeUndefined();

    const listed = await t.query(internal.deviceLock.listForAgent, {
      callerUserId: ungrantedStaff,
    });
    expect(listed).toMatchObject({ ok: false });
  });

  test("a DISABLED institution is out of reach even for a platform admin", async () => {
    const t = convexTest(schema, modules);
    const { institutionId, pairedDeviceId } = await seedSchool(t, "moli", "Kai");
    const admin = await seedUser(t, "platform_admin", undefined, "Platform Admin");
    // schoolOperationsInstitutionIds short-circuits to "all" for this role
    // before any institution is loaded, so a suspended school used to stay
    // commandable from the agent transports while the web console
    // (hasSchoolOperationsAccessAtInstitution) refused it.
    await t.run((ctx) => ctx.db.patch(institutionId, { disabledAt: Date.now() }));

    const listed = await t.query(internal.deviceLock.listForAgent, {
      callerUserId: admin,
    });
    expect(listed.ok).toBe(true);
    if (listed.ok) expect(listed.devices).toEqual([]);

    const result = await t.mutation(internal.deviceLock.setFromAgent, {
      callerUserId: admin,
      source: "mcp" as const,
      pairedDeviceIds: [pairedDeviceId],
      state: "disarmed" as const,
    });
    expect(result).toMatchObject({ ok: false });
    expect(
      (await t.run((ctx) => ctx.db.get(pairedDeviceId)))
        ?.rabbitholeLockDesiredState,
    ).toBeUndefined();
  });

  test("a platform admin CAN still command a live institution", async () => {
    const t = convexTest(schema, modules);
    const { pairedDeviceId } = await seedSchool(t, "moli", "Kai");
    const admin = await seedUser(t, "platform_admin", undefined, "Platform Admin");

    const result = await t.mutation(internal.deviceLock.setFromAgent, {
      callerUserId: admin,
      source: "mcp" as const,
      pairedDeviceIds: [pairedDeviceId],
      state: "disarmed" as const,
      disarmMode: "until_further_notice" as const,
    });
    expect(result).toMatchObject({ ok: true, changedCount: 1 });
  });

  test("the managed-device roster also hides a disabled institution", async () => {
    const t = convexTest(schema, modules);
    const { institutionId } = await seedSchool(t, "moli", "Kai");
    const admin = await seedUser(t, "platform_admin", undefined, "Platform Admin");

    const before = await t.query(internal.managedDeviceClaims.listForAgent, {
      callerUserId: admin,
    });
    expect(before.ok).toBe(true);
    if (before.ok) expect(before.devices).toHaveLength(1);

    await t.run((ctx) => ctx.db.patch(institutionId, { disabledAt: Date.now() }));
    const after = await t.query(internal.managedDeviceClaims.listForAgent, {
      callerUserId: admin,
    });
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.devices).toEqual([]);
  });
});
