import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

// The `send_slack_dm` aide tool relays a Slack DM from the current staff user
// to another LINKED STAFF member. We drive the tool through the real
// `api.mcp.callCurriculumTool` action (the same shared assemble layer the
// in-app aide + Slack bot resolve through) so the test exercises the tool's
// actual run() with a live ActionCtx — recipient resolution, the mandatory
// attribution prefix + escaping, every failure mode, and the staff-only
// CALLER gate. Slack's HTTP is stubbed at globalThis.fetch (mirrors
// slackBot.test.ts), so nothing leaves the process.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: string,
  overrides: { name?: string; username?: string; slackUserId?: string } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test${role}`,
      role: role as Doc<"users">["role"],
      slackUserId: overrides.slackUserId,
    }),
  );
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
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

/** Capture every Slack chat.postMessage body; never hits the network. */
function stubFetch() {
  const calls: Array<Record<string, unknown>> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true, ts: "1.2" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = realFetch) };
}

const call = (
  as: Awaited<ReturnType<typeof withUser>>,
  input: { recipient: string; message: string },
) => as.action(api.mcp.callCurriculumTool, { name: "send_slack_dm", input });

describe("send_slack_dm aide tool", () => {
  test("happy path: relays to a linked staff member with the attribution prefix + escaped body", async () => {
    const t = convexTest(schema, modules);
    const sender = await seedUser(t, "teacher", {
      name: "Tess Teacher",
      username: "tess",
    });
    await seedUser(t, "platform_admin", {
      name: "Avery Stone",
      username: "avery",
      slackUserId: "U_AVERY",
    });
    const as = await withUser(t, sender);

    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchStub = stubFetch();
    let result: string;
    try {
      result = await call(as, {
        recipient: "Avery",
        message: "Meeting < 3pm & bring notes >",
      });
    } finally {
      fetchStub.restore();
      delete process.env.SLACK_BOT_TOKEN;
    }

    expect(result).toBe("Sent to Avery Stone on Slack.");
    expect(fetchStub.calls).toHaveLength(1);
    const body = fetchStub.calls[0];
    // chat.postMessage with channel === the recipient's slackUserId opens the IM.
    expect(body.channel).toBe("U_AVERY");
    // Mandatory bold attribution to the HUMAN sender, then the escaped message.
    expect(body.markdown_text).toBe(
      "*From Tess Teacher (via Rabbithole):*\nMeeting &lt; 3pm &amp; bring notes &gt;",
    );
  });

  test("unlinked staff recipient → helpful error, no Slack call", async () => {
    const t = convexTest(schema, modules);
    const sender = await seedUser(t, "teacher", { username: "tess" });
    await seedUser(t, "teacher", {
      name: "Unlinked Ursula",
      username: "ursula",
      // no slackUserId
    });
    const as = await withUser(t, sender);

    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchStub = stubFetch();
    let result: string;
    try {
      result = await call(as, { recipient: "Ursula", message: "hi" });
    } finally {
      fetchStub.restore();
      delete process.env.SLACK_BOT_TOKEN;
    }

    expect(result).toContain("isn't linked to Slack");
    expect(result).toContain("/admin");
    expect(fetchStub.calls).toHaveLength(0);
  });

  test("recipient is a scholar → refused (staff-only), no Slack call", async () => {
    const t = convexTest(schema, modules);
    const sender = await seedUser(t, "teacher", { username: "tess" });
    // A scholar — with a slackUserId, to prove the staff-only gate (not the
    // link check) is what refuses the send.
    await seedUser(t, "scholar", {
      name: "Kai Scholar",
      username: "kai",
      slackUserId: "U_KAI",
    });
    const as = await withUser(t, sender);

    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchStub = stubFetch();
    let result: string;
    try {
      result = await call(as, { recipient: "Kai", message: "hi" });
    } finally {
      fetchStub.restore();
      delete process.env.SLACK_BOT_TOKEN;
    }

    expect(result).toContain("couldn't find a staff member");
    expect(fetchStub.calls).toHaveLength(0);
  });

  test("ambiguous recipient → candidate list, no Slack call", async () => {
    const t = convexTest(schema, modules);
    const sender = await seedUser(t, "teacher", { username: "tess" });
    await seedUser(t, "teacher", {
      name: "Sam Rivera",
      username: "sam1",
      slackUserId: "U_SAM1",
    });
    await seedUser(t, "platform_admin", {
      name: "Sam Chen",
      username: "sam2",
      slackUserId: "U_SAM2",
    });
    const as = await withUser(t, sender);

    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchStub = stubFetch();
    let result: string;
    try {
      result = await call(as, { recipient: "Sam", message: "hi" });
    } finally {
      fetchStub.restore();
      delete process.env.SLACK_BOT_TOKEN;
    }

    expect(result).toContain("ambiguous");
    expect(result).toContain("Sam Rivera");
    expect(result).toContain("Sam Chen");
    expect(fetchStub.calls).toHaveLength(0);
  });

  test("missing SLACK_BOT_TOKEN → friendly config error, no Slack call", async () => {
    const t = convexTest(schema, modules);
    const sender = await seedUser(t, "teacher", { username: "tess" });
    await seedUser(t, "teacher", {
      name: "Avery Stone",
      username: "avery",
      slackUserId: "U_AVERY",
    });
    const as = await withUser(t, sender);

    delete process.env.SLACK_BOT_TOKEN;
    const fetchStub = stubFetch();
    let result: string;
    try {
      result = await call(as, { recipient: "Avery", message: "hi" });
    } finally {
      fetchStub.restore();
    }

    expect(result).toContain("Slack isn't configured");
    expect(fetchStub.calls).toHaveLength(0);
  });

  test("exact username match takes precedence over an ambiguous display-name substring", async () => {
    const t = convexTest(schema, modules);
    const sender = await seedUser(t, "teacher", { username: "tess" });
    // "sam" is BOTH Sam Chen's exact username AND a substring of both display
    // names — so the name matcher alone would return {kind: "ambiguous"}. The
    // exact-username branch must win outright and resolve to Sam Chen; if the
    // ambiguous-name path ever ran first, this would return the candidate list
    // instead of sending.
    await seedUser(t, "teacher", {
      name: "Sam Rivera",
      username: "sam_r",
      slackUserId: "U_SAM_R",
    });
    await seedUser(t, "teacher", {
      name: "Sam Chen",
      username: "sam",
      slackUserId: "U_SAM_C",
    });
    const as = await withUser(t, sender);

    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchStub = stubFetch();
    let result: string;
    try {
      result = await call(as, { recipient: "sam", message: "hi" });
    } finally {
      fetchStub.restore();
      delete process.env.SLACK_BOT_TOKEN;
    }

    expect(result).toBe("Sent to Sam Chen on Slack.");
    expect(fetchStub.calls).toHaveLength(1);
    expect(fetchStub.calls[0].channel).toBe("U_SAM_C");
  });

  test("a non-staff CALLER can never reach the tool (Forbidden)", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", { username: "kai" });
    await seedUser(t, "teacher", {
      name: "Avery Stone",
      username: "avery",
      slackUserId: "U_AVERY",
    });
    const as = await withUser(t, scholar);

    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchStub = stubFetch();
    try {
      await expect(
        call(as, { recipient: "Avery", message: "hi" }),
      ).rejects.toThrow(/Forbidden: send_slack_dm/);
    } finally {
      fetchStub.restore();
      delete process.env.SLACK_BOT_TOKEN;
    }
    expect(fetchStub.calls).toHaveLength(0);
  });
});
