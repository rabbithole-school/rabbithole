/**
 * The managed-iPad agent tools (lib/deviceOpsTools.ts) are wired in ONE
 * place — the shared staff-aide registry `assembleCurriculumTools` — so the
 * in-app aide ("app"), the Slack bot ("slack"), and the MCP connector ("mcp")
 * all get the same four tools from it. These tests pin:
 *
 *   1. Visibility: each tool exactly once for a school-operations caller on
 *      every transport and surface, never for anyone else, and never for a
 *      caller that does not name its transport.
 *   2. The in-app transport audits itself as "app".
 *   3. A platform admin viewing the app AS someone else cannot lock or
 *      restart a real iPad through the in-app aide: the aide stream runs as
 *      the REAL session owner, so the write path itself must refuse.
 *
 * SimpleMDM is a stubbed global fetch throughout; nothing here reaches a
 * real tenant or device. MCP's listing/calling boundary is pinned separately
 * in convex/__tests__/mcpDeviceTools.test.ts.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import schema from "../../schema";
import type { ActionCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import { assembleCurriculumTools } from "../aideTools";
import { canOperateSchoolDevices, type AgentTransport } from "../deviceOpsTools";
import { makeSlackTools, writeSurfaceFor } from "../slackTools";
import { simpleMdmRetryPolicy } from "../simpleMdmClient";
import type { Role } from "../roles";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../../**/*.ts");

const DEVICE_TOOLS = [
  "list_managed_devices",
  "list_rabbithole_lock_devices",
  "set_rabbithole_lock",
  "set_freeze_mode",
  "restart_managed_device",
];
const ROLES: Role[] = [
  "teacher",
  "school_admin",
  "platform_admin",
  "curriculum_designer",
  "staff",
  "parent",
  "scholar",
  "lifelong_learner",
] as Role[];
const CALLER = "user123" as Id<"users">;
const stubCtx = { runQuery: async () => false } as unknown as ActionCtx;

type NamedTool = { name: string; run: (input: unknown) => Promise<string> };
const names = (tools: unknown[]) =>
  (tools as { name: string }[]).map((tool) => tool.name);

function expectDeviceTools(toolNames: string[], eligible: boolean, label: string) {
  for (const name of DEVICE_TOOLS) {
    expect(
      toolNames.filter((n) => n === name),
      `${label}: ${name}`,
    ).toHaveLength(eligible ? 1 : 0);
  }
}

describe("managed-iPad tools on the shared staff aide — who sees them", () => {
  test("Slack: exactly once per eligible role × surface × school-ops, never otherwise", async () => {
    for (const role of ROLES) {
      for (const ops of [false, true]) {
        for (const surface of ["channel", "dm", "mpim"] as const) {
          // Exactly what slackBot.ts assembles for the curriculum lane.
          const shared = await assembleCurriculumTools(stubCtx, () => {}, {
            role,
            callerUserId: CALLER,
            surface: writeSurfaceFor(surface),
            guardianFormAnswersSurface: surface === "channel" ? "shared" : "private",
            hasSchoolOperationsAccess: ops,
            transport: "slack",
          });
          const extras = await makeSlackTools(stubCtx, () => {}, {
            role,
            callerUserId: CALLER,
            surface,
            slackChannelId: "C1",
            token: "xoxb-test",
            hasSchoolOperationsAccess: ops,
          });
          const all = [...names(shared), ...names(extras)];
          expectDeviceTools(
            all,
            canOperateSchoolDevices(role, ops),
            `slack ${role} ops=${ops} ${surface}`,
          );
        }
      }
    }
  });

  test("in-app and MCP: the same predicate on every surface", async () => {
    for (const transport of ["app", "mcp"] as AgentTransport[]) {
      for (const role of ROLES) {
        for (const ops of [false, true]) {
          for (const surface of ["private", "channel"] as const) {
            const tools = await assembleCurriculumTools(stubCtx, () => {}, {
              role,
              callerUserId: CALLER,
              surface,
              hasSchoolOperationsAccess: ops,
              transport,
            });
            expectDeviceTools(
              names(tools),
              canOperateSchoolDevices(role, ops),
              `${transport} ${role} ops=${ops} ${surface}`,
            );
          }
        }
      }
    }
  });

  test("a caller that names no transport never gets them", async () => {
    for (const role of ["teacher", "platform_admin", "staff"] as Role[]) {
      const tools = await assembleCurriculumTools(stubCtx, () => {}, {
        role,
        callerUserId: CALLER,
        surface: "private",
        hasSchoolOperationsAccess: true,
      });
      expectDeviceTools(names(tools), false, `no transport ${role}`);
    }
  });
});

// ── The in-app write path, against a real (convex-test) backend ─────────

type TestHarness = ReturnType<typeof convexTest>;
type Caller = ReturnType<TestHarness["withIdentity"]>;

/** An ActionCtx whose calls carry `as`'s identity — what the /aide-stream
 *  http action hands assembleCurriculumTools. Pass the bare harness for a
 *  sessionless transport (Slack). */
function actionCtxAs(as: Caller | TestHarness): ActionCtx {
  const call =
    (fn: (ref: unknown, args: unknown) => Promise<unknown>) =>
    (ref: unknown, args: unknown) =>
      fn(ref, args);
  return {
    runQuery: call(as.query as never),
    runMutation: call(as.mutation as never),
    runAction: call(as.action as never),
  } as unknown as ActionCtx;
}

async function seedSchoolWithIpad(t: TestHarness) {
  const institutionId = await t.run((ctx) =>
    ctx.db.insert("institutions", {
      name: "moli",
      slug: "moli",
      kind: "school" as const,
      timeZone: "Pacific/Honolulu",
      isPrimary: true,
    }),
  );
  const adminId = await t.run((ctx) =>
    ctx.db.insert("users", {
      name: "Platform Admin",
      username: "platform-admin-device-ops",
      role: "platform_admin",
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: adminId,
      role: "platform_admin",
      institutionId,
    }),
  );
  const scholarId = await t.run((ctx) =>
    ctx.db.insert("users", {
      name: "Test Scholar",
      username: "test-scholar-device-ops",
      role: "scholar",
      institutionId,
    }),
  );
  const pairedDeviceId = await t.run((ctx) =>
    ctx.db.insert("pairedDevices", {
      deviceId: "ipad-1",
      deviceLabel: "iPad 1",
      scholarId,
      institutionId,
      pairedAt: Date.now(),
      pairedBy: adminId,
    }),
  );
  const now = Date.now();
  await t.run((ctx) =>
    ctx.db.insert("managedDeviceClaims", {
      institutionId,
      serial: "SERIAL123",
      scholarId,
      claimState: "claimed" as const,
      createdBy: adminId,
      createdAt: now,
      updatedAt: now,
      claimIssuedAt: now,
      rotationCount: 0,
      claimCount: 1,
      lastDeviceId: "ipad-1",
    }),
  );
  const sessionId = await t.run((ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId: adminId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    };
    return ctx.db.insert("authSessions", session);
  });
  const asAdmin = t.withIdentity({
    subject: `${adminId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
  return { adminId, scholarId, pairedDeviceId, sessionId, asAdmin };
}

async function deviceToolsFor(
  ctx: ActionCtx,
  callerUserId: Id<"users">,
  transport: AgentTransport,
): Promise<Map<string, NamedTool>> {
  const tools = (await assembleCurriculumTools(ctx, () => {}, {
    role: "platform_admin",
    callerUserId,
    surface: "private",
    transport,
  })) as unknown as NamedTool[];
  return new Map(
    tools
      .filter((tool) => DEVICE_TOOLS.includes(tool.name))
      .map((tool) => [tool.name, tool]),
  );
}

/** SimpleMDM stub: answers the serial lookup + detail read, counts restarts. */
function stubSimpleMdm() {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  let restarts = 0;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const href = String(url);
    calls.push(href);
    if (href.includes("/devices?search=SERIAL123")) {
      return new Response(
        JSON.stringify({
          data: [{ type: "device", id: 42, attributes: { serial_number: "SERIAL123" } }],
          has_more: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (href.endsWith("/devices/42")) {
      return new Response(
        JSON.stringify({ data: { type: "device", id: 42, attributes: { is_supervised: true } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (href.endsWith("/devices/42/restart")) {
      restarts += 1;
      return new Response(null, { status: 202 });
    }
    throw new Error(`Unexpected fetch: ${href}`);
  }) as typeof fetch;
  restoreFetch = () => (globalThis.fetch = realFetch);
  return { calls, restarts: () => restarts };
}

let restoreFetch: (() => void) | undefined;
const prevImpersonation = process.env.IMPERSONATION_ENABLED;

beforeAll(() => {
  simpleMdmRetryPolicy.baseDelayMs = 0;
  simpleMdmRetryPolicy.maxDelayMs = 0;
});

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
  delete process.env.SIMPLEMDM_API_KEY;
  if (prevImpersonation === undefined) delete process.env.IMPERSONATION_ENABLED;
  else process.env.IMPERSONATION_ENABLED = prevImpersonation;
});

async function startViewingAs(
  t: TestHarness,
  seeded: Awaited<ReturnType<typeof seedSchoolWithIpad>>,
) {
  process.env.IMPERSONATION_ENABLED = "on";
  await t.run((ctx) =>
    ctx.db.insert("impersonationOverlays", {
      adminUserId: seeded.adminId,
      adminSessionId: seeded.sessionId,
      targetUserId: seeded.scholarId,
      startedAt: Date.now(),
      active: true,
    }),
  );
}

describe("managed-iPad tools from the in-app aide", () => {
  test("a lock change audits itself as the in-app aide", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedSchoolWithIpad(t);
    const tools = await deviceToolsFor(
      actionCtxAs(seeded.asAdmin),
      seeded.adminId,
      "app",
    );
    expect([...tools.keys()].sort()).toEqual([...DEVICE_TOOLS].sort());

    const message = await tools.get("set_rabbithole_lock")!.run({
      paired_device_ids: [seeded.pairedDeviceId],
      state: "disarmed",
      disarm_mode: "until_further_notice",
    });
    expect(message).toMatch(/1 iPad/);
    expect(await t.run((ctx) => ctx.db.get(seeded.pairedDeviceId))).toMatchObject({
      rabbitholeLockDesiredState: "disarmed",
    });
    const audits = await t.run((ctx) => ctx.db.query("auditLog").collect());
    const disarm = audits.find((row) => row.action === "device.rabbithole-lock.disarm");
    expect(disarm?.detail).toContain("via app");
  });

  test("a restart reaches the stubbed SimpleMDM once and audits itself as the in-app aide", async () => {
    process.env.SIMPLEMDM_API_KEY = "test-key";
    const t = convexTest(schema, modules);
    const seeded = await seedSchoolWithIpad(t);
    const simpleMdm = stubSimpleMdm();
    const tools = await deviceToolsFor(
      actionCtxAs(seeded.asAdmin),
      seeded.adminId,
      "app",
    );

    const message = await tools.get("restart_managed_device")!.run({
      paired_device_id: seeded.pairedDeviceId,
    });
    expect(message).toMatch(/Restart command sent/);
    expect(simpleMdm.restarts()).toBe(1);
    const audits = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "device.restart.requested" });
    expect(audits[0].detail).toContain("(from app)");
  });

  test("while viewing as someone else, a lock change is refused and nothing moves", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedSchoolWithIpad(t);
    await startViewingAs(t, seeded);
    const tools = await deviceToolsFor(
      actionCtxAs(seeded.asAdmin),
      seeded.adminId,
      "app",
    );

    const message = await tools.get("set_rabbithole_lock")!.run({
      paired_device_ids: [seeded.pairedDeviceId],
      state: "disarmed",
    });
    expect(message).toMatch(/viewing as another user/i);
    expect(
      (await t.run((ctx) => ctx.db.get(seeded.pairedDeviceId)))
        ?.rabbitholeLockDesiredState,
    ).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.query("auditLog").collect())).toHaveLength(0);
  });

  test("while viewing as someone else, a restart is refused before any SimpleMDM request", async () => {
    process.env.SIMPLEMDM_API_KEY = "test-key";
    const t = convexTest(schema, modules);
    const seeded = await seedSchoolWithIpad(t);
    await startViewingAs(t, seeded);
    const simpleMdm = stubSimpleMdm();
    const tools = await deviceToolsFor(
      actionCtxAs(seeded.asAdmin),
      seeded.adminId,
      "app",
    );

    const message = await tools.get("restart_managed_device")!.run({
      paired_device_id: seeded.pairedDeviceId,
    });
    expect(message).toMatch(/^Failed: .*viewing as another user/i);
    expect(simpleMdm.calls).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("auditLog").collect())).toHaveLength(0);
  });

  test("the overlay binds only the browser session: a sessionless Slack call by the same admin still works", async () => {
    const t = convexTest(schema, modules);
    const seeded = await seedSchoolWithIpad(t);
    await startViewingAs(t, seeded);
    const tools = await deviceToolsFor(actionCtxAs(t), seeded.adminId, "slack");

    const message = await tools.get("set_rabbithole_lock")!.run({
      paired_device_ids: [seeded.pairedDeviceId],
      state: "disarmed",
      disarm_mode: "until_further_notice",
    });
    expect(message).toMatch(/1 iPad/);
    const audits = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audits.find((row) => row.action === "device.rabbithole-lock.disarm")?.detail).toContain(
      "via slack",
    );
  });
});
