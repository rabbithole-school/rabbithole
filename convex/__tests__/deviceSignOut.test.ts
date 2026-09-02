import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { isSignOutApprovalReply } from "../deviceSignOut";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedInstitution(
  t: ReturnType<typeof convexTest>,
): Promise<Id<"institutions">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("institutions", {
      name: "Moli",
      slug: "moli",
      kind: "school",
    }),
  );
}

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "staff" | "parent",
  institutionId: Id<"institutions">,
  overrides: { name?: string; slackUserId?: string } = {},
): Promise<Id<"users">> {
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? role,
      username: `${role}-${Math.random().toString(36).slice(2, 8)}`,
      role,
      institutionId: role === "scholar" ? institutionId : undefined,
      slackUserId: overrides.slackUserId,
    }),
  );
  if (role !== "scholar") {
    await t.run(async (ctx) =>
      ctx.db.insert("memberships", { userId, role, institutionId }),
    );
  }
  return userId;
}

// Operations staff (the retired registrar role's successor): a base `staff`
// user with the `school:operations` capability grant, which is what device
// registration/assignment actually checks now.
async function seedOperationsStaffUser(
  t: ReturnType<typeof convexTest>,
  institutionId: Id<"institutions">,
  overrides: { name?: string; slackUserId?: string } = {},
): Promise<Id<"users">> {
  const userId = await seedUser(t, "staff", institutionId, overrides);
  await t.run(async (ctx) =>
    ctx.db.insert("staffCapabilityGrants", {
      granteeUserId: userId,
      institutionId,
      capability: "school:operations",
      grantedBy: userId,
      grantedAt: Date.now(),
    }),
  );
  return userId;
}

async function newSession(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
): Promise<Id<"authSessions">> {
  return await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    };
    return ctx.db.insert("authSessions", session);
  });
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  sessionId?: Id<"authSessions">,
) {
  const sid = sessionId ?? (await newSession(t, userId));
  return t.withIdentity({
    subject: `${userId}|${sid}`,
    issuer: "https://convex.dev",
  });
}

describe("device sign-out approval", () => {
  afterEach(() => {
    delete process.env.SLACK_BOT_TOKEN;
    vi.unstubAllGlobals();
  });

  test.each([
    "approve",
    "approved",
    "allow",
    "allow signout",
    "allow sign out",
    "<@B_BOT> approve",
  ])("recognizes the explicit approval reply %j", (reply) => {
    expect(isSignOutApprovalReply(reply)).toBe(true);
  });

  test("does not treat conversation as approval", () => {
    expect(isSignOutApprovalReply("Can someone approve this?")).toBe(false);
    expect(isSignOutApprovalReply("not yet")).toBe(false);
  });

  test("a linked teacher approval lets the managed iPad complete an authoritative sign-out", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t);
    const operationsStaff = await seedOperationsStaffUser(t, institutionId);
    const teacher = await seedUser(t, "teacher", institutionId, {
      name: "Teacher",
      slackUserId: "U_TEACHER",
    });
    const scholar = await seedUser(t, "scholar", institutionId, {
      name: "Test Scholar",
    });
    const asOperationsStaff = await withUser(t, operationsStaff);

    const registered = await asOperationsStaff.mutation(
      api.managedDeviceClaims.registerManagedDeviceSerials,
      { serials: ["GY9RQ63XVR"] },
    );
    const managedDeviceId = registered.results[0].managedDeviceId!;
    const assigned = await asOperationsStaff.mutation(
      api.managedDeviceClaims.assignScholarToManagedDevice,
      { managedDeviceId, scholarId: scholar },
    );
    const deviceId = "managed-device-signout";
    await t.run(async (ctx) =>
      ctx.runMutation(internal.managedDeviceClaims.consumeManagedClaim, {
        claimToken: assigned.claimToken!,
        deviceId,
      }),
    );
    const deviceSessionId = await newSession(t, scholar);
    const asScholar = await withUser(t, scholar, deviceSessionId);
    await asScholar.mutation(api.devicePairing.attachDeviceSession, { deviceId });
    await t.run(async (ctx) =>
      ctx.db.insert("alertChannel", {
        slackChannelId: "C_ALERTS",
        linkedBy: operationsStaff,
        linkedAt: Date.now(),
        institutionId,
        role: "scoped",
      }),
    );

    const request = await asScholar.mutation(
      api.deviceSignOut.requestApproval,
      { deviceId },
    );
    await t.run(async (ctx) =>
      ctx.db.patch(request.requestId, { slackThreadTs: "1712345.6789" }),
    );

    expect(
      await t.mutation(internal.deviceSignOut.ingestSlackReply, {
        channelId: "C_ALERTS",
        threadTs: "1712345.6789",
        slackUserId: "U_TEACHER",
        body: "allow signout",
      }),
    ).toMatchObject({ handled: true, ok: true });
    expect(await t.run(async (ctx) => ctx.db.get(managedDeviceId))).toMatchObject({
      claimState: "claimed",
      scholarId: scholar,
    });

    await asScholar.mutation(api.deviceSignOut.completeApprovedSignOut, {
      requestId: request.requestId,
      deviceId,
    });

    expect(await t.run(async (ctx) => ctx.db.get(deviceSessionId))).toBeNull();
    expect(await t.run(async (ctx) => ctx.db.get(managedDeviceId))).toMatchObject({
      claimState: "unassigned",
    });
    expect(
      await t.run(async (ctx) => ctx.db.query("pairedDevices").collect()),
    ).toHaveLength(0);
    expect(
      await t.run(async (ctx) => ctx.db.get(request.requestId)),
    ).toMatchObject({ status: "completed", approvedBy: teacher });
    expect(
      await t.run(async (ctx) =>
        ctx.runMutation(internal.managedDeviceClaims.consumeManagedClaim, {
          claimToken: assigned.claimToken!,
          deviceId,
        }),
      ),
    ).toBeNull();
  });

  test("an unlinked or out-of-school Slack user cannot approve", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t);
    const scholar = await seedUser(t, "scholar", institutionId);
    const pairedDeviceId = await t.run(async (ctx) =>
      ctx.db.insert("pairedDevices", {
        institutionId,
        scholarId: scholar,
        deviceId: "device-denied",
        pairedAt: Date.now(),
        pairedBy: scholar,
      }),
    );
    const alertId = await t.run(async (ctx) =>
      ctx.db.insert("alerts", {
        kind: "device_sign_out_approval",
        severity: "info",
        title: "request",
        body: "request",
        source: "test",
        scholarId: scholar,
        status: "open",
        createdAt: Date.now(),
      }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("deviceSignOutRequests", {
        institutionId,
        scholarId: scholar,
        pairedDeviceId,
        deviceId: "device-denied",
        status: "pending",
        requestedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        alertId,
        slackChannelId: "C_ALERTS",
        slackThreadTs: "1712345.9999",
      }),
    );

    expect(
      await t.mutation(internal.deviceSignOut.ingestSlackReply, {
        channelId: "C_ALERTS",
        threadTs: "1712345.9999",
        slackUserId: "U_UNKNOWN",
        body: "approve",
      }),
    ).toMatchObject({ handled: true, ok: false });

    const multiRoleTeacher = await seedUser(t, "parent", institutionId, {
      slackUserId: "U_MULTI_ROLE_TEACHER",
    });
    await t.run(async (ctx) =>
      ctx.db.insert("memberships", {
        userId: multiRoleTeacher,
        role: "teacher",
        institutionId,
      }),
    );
    expect(
      await t.mutation(internal.deviceSignOut.ingestSlackReply, {
        channelId: "C_ALERTS",
        threadTs: "1712345.9999",
        slackUserId: "U_MULTI_ROLE_TEACHER",
        body: "approve",
      }),
    ).toMatchObject({ handled: true, ok: true });
  });

  test("an approval mention is handled once across Slack's duplicate event shapes", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t);
    const teacher = await seedUser(t, "teacher", institutionId, {
      slackUserId: "U_TEACHER",
    });
    const scholar = await seedUser(t, "scholar", institutionId);
    const pairedDeviceId = await t.run(async (ctx) =>
      ctx.db.insert("pairedDevices", {
        institutionId,
        scholarId: scholar,
        deviceId: "device-mention",
        pairedAt: Date.now(),
        pairedBy: teacher,
      }),
    );
    const alertId = await t.run(async (ctx) =>
      ctx.db.insert("alerts", {
        kind: "device_sign_out_approval",
        severity: "info",
        title: "request",
        body: "request",
        source: "test",
        scholarId: scholar,
        status: "open",
        createdAt: Date.now(),
      }),
    );
    const requestId = await t.run(async (ctx) =>
      ctx.db.insert("deviceSignOutRequests", {
        institutionId,
        scholarId: scholar,
        pairedDeviceId,
        deviceId: "device-mention",
        status: "pending",
        requestedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        alertId,
        slackChannelId: "C_ALERTS",
        slackThreadTs: "1712345.1234",
      }),
    );
    const posts: Record<string, unknown>[] = [];
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        posts.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true, ts: "1712345.5678" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const basePayload = {
      team_id: "T1",
      authorizations: [{ user_id: "B_BOT", is_bot: true }],
    };
    await t.action(internal.slackBot.handleEvent, {
      payload: {
        ...basePayload,
        event_id: "EvMessage",
        event: {
          type: "message",
          user: "U_TEACHER",
          text: "<@B_BOT> approve",
          channel: "C_ALERTS",
          channel_type: "channel",
          ts: "1712346.0001",
          thread_ts: "1712345.1234",
        },
      },
    });
    await t.action(internal.slackBot.handleEvent, {
      payload: {
        ...basePayload,
        event_id: "EvMention",
        event: {
          type: "app_mention",
          user: "U_TEACHER",
          text: "<@B_BOT> approve",
          channel: "C_ALERTS",
          ts: "1712346.0001",
          thread_ts: "1712345.1234",
        },
      },
    });

    expect(await t.run(async (ctx) => ctx.db.get(requestId))).toMatchObject({
      status: "approved",
      approvedBy: teacher,
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      channel: "C_ALERTS",
      thread_ts: "1712345.1234",
    });
  });
});
