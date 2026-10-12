import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  grantInstitutionMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";
import { makeStaff, makeWorld } from "./factories/world";

// The `send_slack_dm` aide tool relays a Slack message from the current staff
// user to another LINKED STAFF member AT THEIR OWN SCHOOL, in a GROUP DM
// holding both of them. We drive the tool through the real
// `api.mcp.callCurriculumTool` action (the same shared assemble layer the
// in-app aide + Slack bot resolve through) so the test exercises the tool's
// actual run() with a live ActionCtx — recipient resolution, the group-DM open
// and its 1:1 fallback, the mandatory attribution prefix + escaping, the
// permalink receipt, every failure mode, the staff-only CALLER gate, and the
// tenant boundary on the directory it resolves against. Slack's HTTP is
// stubbed at globalThis.fetch (mirrors
// slackBot.test.ts), so nothing leaves the process.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type MembershipRole = Doc<"memberships">["role"];

/**
 * Seed a user, plus the membership that gives them standing at `institutionId`
 * (the shared fixture school by default; pass `null` for a deliberately
 * school-less account). The membership — never `users.role` — is the tenant
 * boundary the directory scopes on, so a fixture without one is invisible to
 * every sender.
 */
async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: string,
  overrides: {
    name?: string;
    username?: string;
    slackUserId?: string;
    institutionId?: Id<"institutions"> | null;
    /** Defaults to `role`; set it to seed a deliberately mismatched pair. */
    membershipRole?: MembershipRole;
  } = {},
) {
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test${role}`,
      role: role as Doc<"users">["role"],
      slackUserId: overrides.slackUserId,
    }),
  );
  // Defaults to the shared fixture institution, so a sender and a recipient
  // seeded with no explicit school land in the SAME one — what every test that
  // isn't about the tenant boundary wants.
  const institutionId =
    overrides.institutionId === undefined
      ? await seedTestInstitution(t)
      : overrides.institutionId;
  if (institutionId) {
    const membershipRole = overrides.membershipRole ?? (role as MembershipRole);
    await t.run(async (ctx) =>
      ctx.db.insert("memberships", {
        userId,
        role: membershipRole,
        institutionId,
      }),
    );
  }
  return userId;
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

const PERMALINK = "https://example.slack.com/archives/C_GROUP/p1700000000000100";

type SlackCall = { method: string; body: Record<string, unknown> };

/**
 * Route every Slack call by method and record its decoded body; never hits the
 * network. The three methods this tool touches do NOT share an encoding —
 * conversations.open and chat.postMessage take JSON, chat.getPermalink is
 * form-encoded (slackCallForm) — so the stub decodes per method rather than
 * assuming one. A stub that JSON.parse'd everything would throw on the
 * permalink read and look like a tool bug.
 */
function stubFetch(opts: { openOk?: boolean; permalink?: string | null } = {}) {
  const { openOk = true, permalink = PERMALINK } = opts;
  const calls: SlackCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = String(url).split("/api/")[1] ?? String(url);
    const raw = String(init?.body ?? "");
    const body: Record<string, unknown> = raw.startsWith("{")
      ? (JSON.parse(raw) as Record<string, unknown>)
      : Object.fromEntries(new URLSearchParams(raw));
    calls.push({ method, body });
    const json = (payload: Record<string, unknown>) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (method === "conversations.open") {
      return openOk
        ? json({ ok: true, channel: { id: "C_GROUP" } })
        : json({ ok: false, error: "missing_scope" });
    }
    if (method === "chat.postMessage") {
      // Slack echoes the conversation it ACTUALLY posted into. Posting to a
      // user id opens that person's IM implicitly and resolves to its `D…` id.
      const passed = String(body.channel ?? "");
      return json({
        ok: true,
        ts: "1.2",
        channel: passed.startsWith("U") ? `D${passed.slice(1)}` : passed,
      });
    }
    if (method === "chat.getPermalink") {
      // The real API rejects a USER id here — probed live 2026-09-17,
      // `channel_not_found`. The stub must too, or it hides the bug where a
      // caller passes the id it sent rather than the one Slack resolved.
      if (String(body.channel ?? "").startsWith("U")) {
        return json({ ok: false, error: "channel_not_found" });
      }
      return permalink
        ? json({ ok: true, permalink })
        : json({ ok: false, error: "message_not_found" });
    }
    return json({ ok: true, ts: "1.2" });
  }) as typeof fetch;
  return {
    calls,
    posts: () => calls.filter((c) => c.method === "chat.postMessage"),
    restore: () => (globalThis.fetch = realFetch),
  };
}

const call = (
  as: Awaited<ReturnType<typeof withUser>>,
  input: { recipient: string; message: string },
) => as.action(api.mcp.callCurriculumTool, { name: "send_slack_dm", input });

describe("send_slack_dm aide tool", () => {
  test("happy path: opens a group DM with BOTH people, attributes in real bold, and returns the permalink", async () => {
    const t = convexTest(schema, modules);
    const school = await seedTestInstitution(t);
    const sender = await seedUser(t, "teacher", {
      name: "Tess Teacher",
      username: "tess",
      slackUserId: "U_TESS",
      institutionId: school,
    });
    await seedUser(t, "school_admin", {
      name: "Avery Stone",
      username: "avery",
      slackUserId: "U_AVERY",
      institutionId: school,
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

    // The room holds the sender AND the recipient — that is the whole point:
    // the recipient can answer the relay where it arrived.
    const opened = fetchStub.calls.find((c) => c.method === "conversations.open");
    expect(opened?.body.users).toBe("U_TESS,U_AVERY");

    const posts = fetchStub.posts();
    expect(posts).toHaveLength(1);
    expect(posts[0].body.channel).toBe("C_GROUP");
    // `**` not `*`: markdown_text is CommonMark, where a single asterisk is
    // EMPHASIS. A live relay shipped its "bold" attribution in italics.
    expect(posts[0].body.markdown_text).toBe(
      "**From <@U_TESS> (via Rabbithole):**\n\nMeeting &lt; 3pm &amp; bring notes &gt;\n\n_Relayed by Rabbithole — reply here and <@U_TESS> will see it._",
    );

    // The receipt carries the permalink, and tells the model to hand it over:
    // it is the only trace of the send that outlives the stream.
    expect(result).toContain("Sent to Avery Stone on Slack");
    expect(result).toContain("group DM");
    expect(result).toContain(PERMALINK);
    expect(
      fetchStub.calls.find((c) => c.method === "chat.getPermalink")?.body
        .channel,
    ).toBe("C_GROUP");
  });

  test("sender with no linked Slack account → 1:1 fallback that SAYS replies won't reach them", async () => {
    const t = convexTest(schema, modules);
    // No slackUserId on the sender — there is no second person to put in a room.
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
      result = await call(as, { recipient: "Avery", message: "hi" });
    } finally {
      fetchStub.restore();
      delete process.env.SLACK_BOT_TOKEN;
    }

    // Never attempt a group with one member.
    expect(fetchStub.calls.some((c) => c.method === "conversations.open")).toBe(
      false,
    );
    const posts = fetchStub.posts();
    expect(posts).toHaveLength(1);
    // chat.postMessage with channel === the recipient's slackUserId opens the IM.
    expect(posts[0].body.channel).toBe("U_AVERY");
    // Plain escaped name (no mention id to use), and the recipient is told a
    // reply here goes nowhere — the alternative is typing into a void.
    expect(posts[0].body.markdown_text).toBe(
      "**From Tess Teacher (via Rabbithole):**\n\nhi\n\n_Relayed by Rabbithole. Tess Teacher isn't in this conversation, so a reply here won't reach them._",
    );
    expect(result).toContain("1:1 DM");
    expect(result).toContain("/admin");
    // The receipt survives the fallback: the permalink is resolved against the
    // conversation Slack RESOLVED (`D_AVERY`), not the user id we posted to.
    const link = fetchStub.calls.find((c) => c.method === "chat.getPermalink");
    expect(link?.body.channel).toBe("D_AVERY");
    expect(result).toContain(PERMALINK);
  });

  test("conversations.open fails (missing_scope) → degrades to the 1:1 DM, never drops the message", async () => {
    const t = convexTest(schema, modules);
    const sender = await seedUser(t, "teacher", {
      name: "Tess Teacher",
      username: "tess",
      slackUserId: "U_TESS",
    });
    await seedUser(t, "platform_admin", {
      name: "Avery Stone",
      username: "avery",
      slackUserId: "U_AVERY",
    });
    const as = await withUser(t, sender);

    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchStub = stubFetch({ openOk: false });
    let result: string;
    try {
      result = await call(as, { recipient: "Avery", message: "hi" });
    } finally {
      fetchStub.restore();
      delete process.env.SLACK_BOT_TOKEN;
    }

    expect(fetchStub.calls.some((c) => c.method === "conversations.open")).toBe(
      true,
    );
    const posts = fetchStub.posts();
    expect(posts).toHaveLength(1);
    expect(posts[0].body.channel).toBe("U_AVERY");
    expect(result).toContain("Sent to Avery Stone on Slack");
    // The sender IS linked — a Slack-side refusal must never be reported as a
    // missing account, or the reader goes to /admin to fix nothing.
    expect(result).not.toContain("no linked Slack account");
    expect(result).not.toContain("/admin");
    expect(result).toContain(PERMALINK);
  });

  test("self-relay → the sender's own DM, with no footer claiming they're absent", async () => {
    const t = convexTest(schema, modules);
    const sender = await seedUser(t, "teacher", {
      name: "Tess Teacher",
      username: "tess",
      slackUserId: "U_TESS",
    });
    const as = await withUser(t, sender);

    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchStub = stubFetch();
    let result: string;
    try {
      result = await call(as, { recipient: "tess", message: "note to self" });
    } finally {
      fetchStub.restore();
      delete process.env.SLACK_BOT_TOKEN;
    }

    // Never open a "group" of one person with themselves.
    expect(fetchStub.calls.some((c) => c.method === "conversations.open")).toBe(
      false,
    );
    const posted = String(fetchStub.posts()[0].body.markdown_text);
    expect(posted).toContain("**From Tess Teacher (via Rabbithole):**");
    expect(posted).toContain("note to self");
    // The absence footer would be nonsense here — they ARE the conversation.
    expect(posted).not.toContain("isn't in this conversation");
    expect(result).not.toContain("won't come back");
  });

  test("an ambiguous postMessage failure is reported as UNCERTAIN, not as undelivered", async () => {
    const t = convexTest(schema, modules);
    const sender = await seedUser(t, "teacher", {
      name: "Tess Teacher",
      username: "tess",
      slackUserId: "U_TESS",
    });
    await seedUser(t, "platform_admin", {
      name: "Avery Stone",
      username: "avery",
      slackUserId: "U_AVERY",
    });
    const as = await withUser(t, sender);

    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const method = String(url).split("/api/")[1] ?? "";
      // Slack documents internal_error as potentially partially-successful:
      // the post may have landed and the response been lost.
      const payload =
        method === "chat.postMessage"
          ? { ok: false, error: "internal_error" }
          : { ok: true, channel: { id: "C_GROUP" } };
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    let result: string;
    try {
      result = await call(as, { recipient: "Avery", message: "hi" });
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.SLACK_BOT_TOKEN;
    }

    // Resolving the uncertainty toward "it failed" is what produces a retry
    // that double-pings a colleague.
    expect(result).toContain("may or may not");
    expect(result).toContain("Do NOT resend");
  });

  test("a display name carrying CommonMark delimiters cannot forge a second attribution", async () => {
    const t = convexTest(schema, modules);
    // The attribution line is the whole reason a relay can't be read as
    // someone else's words — so a name must not be able to close its span.
    const sender = await seedUser(t, "teacher", {
      name: "Eve**\n\n**From Avery Stone (via Rabbithole):**",
      username: "eve",
    });
    await seedUser(t, "platform_admin", {
      name: "Avery Stone",
      username: "avery",
      slackUserId: "U_AVERY",
    });
    const as = await withUser(t, sender);

    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchStub = stubFetch();
    try {
      await call(as, { recipient: "avery", message: "hi" });
    } finally {
      fetchStub.restore();
      delete process.env.SLACK_BOT_TOKEN;
    }

    const posted = String(fetchStub.posts()[0].body.markdown_text);
    // Exactly ONE attribution line, and the injected one is inert.
    expect(posted.match(/\*\*From /g)).toHaveLength(1);
    expect(posted).not.toContain("\n\n**From Avery Stone");
    // STRIPPED, not backslash-escaped. Escaping is defeated by Slack's
    // CommonMark→mrkdwn round trip (probed live 2026-09-17: `\*\*` comes back
    // as raw `**`, which Slack's own renderer then reinterprets as markup), so
    // an assertion that accepted a backslashed form would pass on a string that
    // still forges an attribution in the recipient's client.
    // Exactly two `**` in the whole message: the one attribution span's own
    // open and close. Any delimiter surviving out of the NAME would add more.
    expect(posted.match(/\*\*/g)).toHaveLength(2);
    expect(posted).toContain("**From Eve From Avery Stone (via Rabbithole):");
    expect(posted).not.toContain("\\");
  });

  test("permalink lookup fails → the send still succeeds and says so", async () => {
    const t = convexTest(schema, modules);
    const sender = await seedUser(t, "teacher", {
      name: "Tess Teacher",
      username: "tess",
      slackUserId: "U_TESS",
    });
    await seedUser(t, "platform_admin", {
      name: "Avery Stone",
      username: "avery",
      slackUserId: "U_AVERY",
    });
    const as = await withUser(t, sender);

    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchStub = stubFetch({ permalink: null });
    let result: string;
    try {
      result = await call(as, { recipient: "Avery", message: "hi" });
    } finally {
      fetchStub.restore();
      delete process.env.SLACK_BOT_TOKEN;
    }

    // A delivered message with no link beats a failed send — the permalink is
    // never load-bearing.
    expect(fetchStub.posts()).toHaveLength(1);
    expect(result).toContain("Sent to Avery Stone on Slack");
    expect(result).not.toContain("http");
  });

  test("unlinked staff recipient → helpful error, no Slack call", async () => {
    const t = convexTest(schema, modules);
    const school = await seedTestInstitution(t);
    const sender = await seedUser(t, "teacher", {
      username: "tess",
      institutionId: school,
    });
    await seedUser(t, "teacher", {
      name: "Unlinked Ursula",
      username: "ursula",
      institutionId: school,
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
    const school = await seedTestInstitution(t);
    const sender = await seedUser(t, "teacher", {
      username: "tess",
      institutionId: school,
    });
    // A scholar at the SENDER'S OWN school — with a slackUserId — so the
    // staff-only gate (not the link check and not the tenant boundary) is
    // provably what refuses the send.
    await seedUser(t, "scholar", {
      name: "Kai Scholar",
      username: "kai",
      slackUserId: "U_KAI",
      institutionId: school,
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
    const school = await seedTestInstitution(t);
    const sender = await seedUser(t, "teacher", {
      username: "tess",
      institutionId: school,
    });
    await seedUser(t, "teacher", {
      name: "Sam Rivera",
      username: "sam1",
      slackUserId: "U_SAM1",
      institutionId: school,
    });
    await seedUser(t, "school_admin", {
      name: "Sam Chen",
      username: "sam2",
      slackUserId: "U_SAM2",
      institutionId: school,
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

  test("an over-broad recipient refuses to LIST the matches — it is a disambiguation prompt, not a directory", async () => {
    const t = convexTest(schema, modules);
    const sender = await seedUser(t, "teacher", {
      name: "Tess Teacher",
      username: "tess",
    });
    // `matchByName` falls back to SUBSTRING matching and the backing staff
    // directory is deployment-wide with no institution boundary, so before the
    // cap a one-character recipient read back the name and username of every
    // staff member on the deployment — including colleagues at other schools,
    // with no Slack linkage anywhere in the path. (The boundary itself is a
    // separate fix; this removes the enumeration.)
    await seedUser(t, "teacher", {
      name: "Dana Kestrel",
      username: "dana.kestrel",
    });
    await seedUser(t, "school_admin", {
      name: "Marcus Ala",
      username: "marcus.ala",
    });
    await seedUser(t, "teacher", { name: "Ana Reyes", username: "ana.reyes" });
    await seedUser(t, "teacher", { name: "Kai Nakama", username: "kai.n" });
    await seedUser(t, "teacher", { name: "Lehua Torres", username: "lehua" });
    await seedUser(t, "teacher", { name: "Hoku Makani", username: "hoku" });
    const as = await withUser(t, sender);

    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchStub = stubFetch();
    let result: string;
    try {
      result = await call(as, { recipient: "a", message: "hi" });
    } finally {
      fetchStub.restore();
      delete process.env.SLACK_BOT_TOKEN;
    }

    expect(result).toContain("too many staff");
    for (const leaked of [
      "Dana Kestrel",
      "dana.kestrel",
      "Marcus Ala",
      "marcus.ala",
      "Ana Reyes",
      "lehua",
    ]) {
      expect(result).not.toContain(leaked);
    }
    expect(fetchStub.calls).toHaveLength(0);
  });

  test("a genuinely ambiguous recipient still names the few candidates", async () => {
    const t = convexTest(schema, modules);
    const sender = await seedUser(t, "teacher", { username: "tess" });
    await seedUser(t, "teacher", { name: "Sam Rivera", username: "sam1" });
    await seedUser(t, "teacher", { name: "Sam Chen", username: "sam2" });
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

    // The cap must not break the case it exists to protect: choosing between
    // two colleagues is a real question.
    expect(result).toContain("ambiguous");
    expect(result).toContain("Sam Rivera");
    expect(result).toContain("Sam Chen");
  });

  test("missing SLACK_BOT_TOKEN → friendly config error, no Slack call", async () => {
    const t = convexTest(schema, modules);
    const school = await seedTestInstitution(t);
    const sender = await seedUser(t, "teacher", {
      username: "tess",
      institutionId: school,
    });
    await seedUser(t, "teacher", {
      name: "Avery Stone",
      username: "avery",
      slackUserId: "U_AVERY",
      institutionId: school,
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
    const school = await seedTestInstitution(t);
    const sender = await seedUser(t, "teacher", {
      username: "tess",
      institutionId: school,
    });
    // "sam" is BOTH Sam Chen's exact username AND a substring of both display
    // names — so the name matcher alone would return {kind: "ambiguous"}. The
    // exact-username branch must win outright and resolve to Sam Chen; if the
    // ambiguous-name path ever ran first, this would return the candidate list
    // instead of sending.
    await seedUser(t, "teacher", {
      name: "Sam Rivera",
      username: "sam_r",
      slackUserId: "U_SAM_R",
      institutionId: school,
    });
    await seedUser(t, "teacher", {
      name: "Sam Chen",
      username: "sam",
      slackUserId: "U_SAM_C",
      institutionId: school,
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

    expect(result).toContain("Sent to Sam Chen on Slack");
    expect(fetchStub.posts()).toHaveLength(1);
    // The sender is unlinked here, so this is the 1:1 path: the recipient's
    // own Slack id is the channel.
    expect(fetchStub.posts()[0].body.channel).toBe("U_SAM_C");
  });

  test("a non-staff CALLER can never reach the tool (Forbidden)", async () => {
    const t = convexTest(schema, modules);
    const school = await seedTestInstitution(t);
    const scholar = await seedUser(t, "scholar", {
      username: "kai",
      institutionId: school,
    });
    await seedUser(t, "teacher", {
      name: "Avery Stone",
      username: "avery",
      slackUserId: "U_AVERY",
      institutionId: school,
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

  // ── The tenant boundary ─────────────────────────────────────────────────
  // This deployment hosts many schools. The directory the tool resolves
  // against used to be role-filtered only, so an exact name or username at
  // ANOTHER institution resolved and opened a real Slack DM. The boundary is
  // the institution-scoped staff MEMBERSHIP, never `users.role`.

  test("a staff member at ANOTHER institution is not reachable, even by exact name", async () => {
    const t = convexTest(schema, modules);
    // makeWorld seeds two schools by default — exactly this case.
    const world = await makeWorld(t);
    const [mine, theirs] = world.schools;
    const outsider = await makeStaff(t, theirs, "teacher", {
      name: "Outsider Oren",
      slackUserId: "U_OREN",
    });
    const as = await world.as.staffOf(mine, "teacher");

    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchStub = stubFetch();
    let byName: string;
    let byUsername: string;
    try {
      byName = await call(as, { recipient: "Outsider Oren", message: "hi" });
      byUsername = await call(as, { recipient: outsider.username, message: "hi" });
    } finally {
      fetchStub.restore();
      delete process.env.SLACK_BOT_TOKEN;
    }

    // Neither the display-name nor the exact-username path may resolve them,
    // and nothing may reach Slack — a send opens a durable DM, so the only
    // acceptable outcome is the not-found refusal.
    expect(byName).toContain("couldn't find a staff member");
    expect(byUsername).toContain("couldn't find a staff member");
    expect(fetchStub.calls).toHaveLength(0);

    // …and the leak is closed at the directory itself, not just at the tool.
    const visible = await t.query(internal.users.listStaffForSlackDmInternal, {
      callerUserId: mine.teacher.id,
    });
    expect(visible.map((u) => u.id)).toContain(mine.admin.id);
    expect(visible.map((u) => u.id)).not.toContain(theirs.teacher.id);
    expect(visible.map((u) => u.id)).not.toContain(outsider.id);
  });

  test("a caller with memberships at two schools sees the UNION of both", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t);
    const [first, second] = world.schools;
    // A shared staffer — genuinely staff at each school, so each school's
    // colleagues are legitimately theirs to reach.
    const shared = await makeStaff(t, first, "teacher", { name: "Dual Dana" });
    await grantInstitutionMembership(t, shared.id, second.id, "teacher");

    const visible = await t.query(internal.users.listStaffForSlackDmInternal, {
      callerUserId: shared.id,
    });
    const ids = visible.map((u) => u.id);
    expect(ids).toContain(first.teacher.id);
    expect(ids).toContain(second.teacher.id);
    // Each person appears once even when reachable through several schools —
    // asserted on the doubly-reachable person specifically, since a uniqueness
    // check alone also passes if they were dropped entirely.
    expect(ids.filter((id) => id === shared.id)).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);

    // The single-school colleague still cannot see across the seam.
    const oneSchool = await t.query(internal.users.listStaffForSlackDmInternal, {
      callerUserId: first.teacher.id,
    });
    expect(oneSchool.map((u) => u.id)).not.toContain(second.teacher.id);
  });

  test("a platform_admin keeps global reach", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t);
    const [first, second] = world.schools;
    const admin = world.platformAdmin;
    expect(admin).toBeDefined();

    const visible = await t.query(internal.users.listStaffForSlackDmInternal, {
      callerUserId: admin!.id,
    });
    const ids = visible.map((u) => u.id);
    expect(ids).toContain(first.teacher.id);
    expect(ids).toContain(second.teacher.id);
    // Still staff-only: a scholar is never a DM target for anyone.
    expect(ids).not.toContain(first.scholars[0].id);
  });

  test("a non-staff account holding a staff membership is still not a candidate", async () => {
    const t = convexTest(schema, modules);
    const school = await seedTestInstitution(t);
    const sender = await seedUser(t, "teacher", {
      username: "tess",
      institutionId: school,
    });
    // Pathological but expressible: a scholar account carrying a teacher
    // membership row. The membership is the tenant boundary, but `users.role`
    // is the staff-only belt — a scholar must never become a DM target.
    await seedUser(t, "scholar", {
      name: "Kai Scholar",
      username: "kai",
      slackUserId: "U_KAI",
      institutionId: school,
      membershipRole: "teacher",
    });

    const visible = await t.query(internal.users.listStaffForSlackDmInternal, {
      callerUserId: sender,
    });
    expect(visible.map((u) => u.username)).not.toContain("kai");
  });

  test("a staff account is unreachable through a NON-staff membership", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t);
    const [mine, theirs] = world.schools;
    // A real teacher at the OTHER school who also sits in this one as a
    // scholar (an adult learner taking a class here). `users.role` is
    // `teacher`, so the staff-only filter alone would admit them — only the
    // MEMBERSHIP role keeps them out, which is the boundary this pins.
    const visitor = await makeStaff(t, theirs, "teacher", {
      name: "Visiting Vi",
      slackUserId: "U_VI",
    });
    await t.run(async (ctx) =>
      ctx.db.insert("memberships", {
        userId: visitor.id,
        role: "scholar",
        institutionId: mine.id,
      }),
    );

    const visible = await t.query(internal.users.listStaffForSlackDmInternal, {
      callerUserId: mine.teacher.id,
    });
    expect(visible.map((u) => u.id)).not.toContain(visitor.id);
  });

  test("a sender's NON-staff membership grants them no directory at all", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t);
    const [mine, theirs] = world.schools;
    // The mirror of the above, on the SENDER side: a scholar membership at a
    // school is not staff standing there, so it opens no directory.
    const outsider = await makeStaff(t, theirs, "teacher", {
      name: "Peripheral Pat",
    });
    await t.run(async (ctx) =>
      ctx.db.insert("memberships", {
        userId: outsider.id,
        role: "scholar",
        institutionId: mine.id,
      }),
    );

    const visible = await t.query(internal.users.listStaffForSlackDmInternal, {
      callerUserId: outsider.id,
    });
    const ids = visible.map((u) => u.id);
    expect(ids).toContain(theirs.teacher.id);
    expect(ids).not.toContain(mine.teacher.id);
    expect(ids).not.toContain(mine.admin.id);
  });

  test("the PLATFORM ADMIN is reachable from a school they hold no membership at", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t);
    const [mine, theirs] = world.schools;
    // The exact prod shape that PR #3895 broke: the operator's only
    // institution-scoped staff membership is at ONE non-primary school, and
    // every other linked staffer is somewhere else. #3895 gave platform_admin
    // global reach as a SENDER but not as a RECIPIENT, so nobody could DM the
    // operator any more. Global standing has to cut both ways.
    const operator = await seedUser(t, "platform_admin", {
      name: "Ops Olina",
      username: "olina",
      slackUserId: "U_OLINA",
      institutionId: theirs.id,
      membershipRole: "teacher",
    });

    const visible = await t.query(internal.users.listStaffForSlackDmInternal, {
      callerUserId: mine.teacher.id,
    });
    expect(visible.map((u) => u.id)).toContain(operator);

    // …and the DM actually goes out, not just appears in the directory.
    const as = await world.as.staffOf(mine, "teacher");
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchStub = stubFetch();
    let result: string;
    try {
      result = await call(as, { recipient: "olina", message: "hi" });
    } finally {
      fetchStub.restore();
      delete process.env.SLACK_BOT_TOKEN;
    }
    expect(result).not.toContain("couldn't find");
    expect(fetchStub.calls.length).toBeGreaterThan(0);

    // Global standing is an exception for the GLOBAL operator only — it must
    // not smuggle that school's ordinary staff across the seam.
    expect(visible.map((u) => u.id)).not.toContain(theirs.teacher.id);
    expect(visible.map((u) => u.id)).not.toContain(theirs.admin.id);
  });

  test("a school-less curriculum_designer is reachable by ordinary staff", async () => {
    const t = convexTest(schema, modules);
    const school = await seedTestInstitution(t);
    const sender = await seedUser(t, "teacher", {
      username: "tess",
      institutionId: school,
    });
    // `ensureDefaultMembershipForUser` mints an institution-LESS membership for
    // a curriculum_designer. They belong to no school, so there is no tenant to
    // cross — and six of them exist on prod.
    const designer = await seedUser(t, "curriculum_designer", {
      name: "Rootless Robin",
      username: "robin",
      slackUserId: "U_ROBIN",
      institutionId: null,
    });
    await t.run(async (ctx) =>
      ctx.db.insert("memberships", {
        userId: designer,
        role: "curriculum_designer",
        // deliberately unscoped
      }),
    );

    const visible = await t.query(internal.users.listStaffForSlackDmInternal, {
      callerUserId: sender,
    });
    expect(visible.map((u) => u.id)).toContain(designer);
  });

  test("an unscoped LIFELONG_LEARNER membership does not carry a scoped staffer across schools", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t);
    const [mine, theirs] = world.schools;
    // The leak adversarial review caught before this landed. `lifelong_learner`
    // is globally privileged for LIFECYCLE purposes (never swept by an
    // institution delete, never blocked by a suspension) but it is NOT a staff
    // role — and it is the STAFF DOGFOODING role, so a real teacher holding one
    // is the expected case, not a contrived one. Checking global standing on
    // the membership while checking staff standing only on the user combined
    // two unrelated capacities into cross-school authority.
    const outsider = await makeStaff(t, theirs, "teacher", {
      name: "Dogfood Dana",
      slackUserId: "U_DANA",
    });
    await t.run(async (ctx) =>
      ctx.db.insert("memberships", {
        userId: outsider.id,
        role: "lifelong_learner",
        // unscoped — deployment-wide for lifecycle, but never staff standing
      }),
    );

    const visible = await t.query(internal.users.listStaffForSlackDmInternal, {
      callerUserId: mine.teacher.id,
    });
    expect(visible.map((u) => u.id)).not.toContain(outsider.id);

    // And the tool refuses, by name and by exact username.
    const as = await world.as.staffOf(mine, "teacher");
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchStub = stubFetch();
    try {
      expect(await call(as, { recipient: "Dogfood Dana", message: "hi" })).toContain(
        "couldn't find a staff member",
      );
      expect(await call(as, { recipient: outsider.username, message: "hi" })).toContain(
        "couldn't find a staff member",
      );
    } finally {
      fetchStub.restore();
      delete process.env.SLACK_BOT_TOKEN;
    }
    expect(fetchStub.calls).toHaveLength(0);
  });

  test("a platform_admin sender still reaches a school-less designer", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", {
      username: "root",
      institutionId: null,
    });
    const designer = await seedUser(t, "curriculum_designer", {
      name: "Rootless Robin",
      username: "robin2",
      slackUserId: "U_ROBIN2",
      institutionId: null,
    });
    await t.run(async (ctx) =>
      ctx.db.insert("memberships", {
        userId: designer,
        role: "curriculum_designer",
      }),
    );

    // The one assertion worth keeping from the test this PR deleted: global
    // SENDER reach must still see a recipient who belongs to no school.
    const visible = await t.query(internal.users.listStaffForSlackDmInternal, {
      callerUserId: admin,
    });
    expect(visible.map((u) => u.id)).toContain(designer);
  });

  test("global standing does NOT extend to a scholar or a system account", async () => {
    const t = convexTest(schema, modules);
    const school = await seedTestInstitution(t);
    const sender = await seedUser(t, "teacher", {
      username: "tess",
      institutionId: school,
    });
    // An unscoped membership is not a way around the staff-only filter.
    const kid = await seedUser(t, "scholar", {
      name: "Kai Scholar",
      username: "kai",
      slackUserId: "U_KAI",
      institutionId: null,
    });
    await t.run(async (ctx) =>
      ctx.db.insert("memberships", {
        userId: kid,
        role: "curriculum_designer",
      }),
    );
    const svc = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Service Account",
        username: "svc-global",
        role: "platform_admin",
        isSystem: true,
      }),
    );

    const ids = (
      await t.query(internal.users.listStaffForSlackDmInternal, {
        callerUserId: sender,
      })
    ).map((u) => u.id);
    expect(ids).not.toContain(kid);
    expect(ids).not.toContain(svc);
  });

});
