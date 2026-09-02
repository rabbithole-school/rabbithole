import { deflateRawSync } from "node:zlib";
import { convexTest } from "convex-test";
import { describe, expect, test, beforeAll, afterAll, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { computeSlackSignature } from "../lib/slackSignature";
import {
  resolveSlackScholarLens,
  waitForSlackReplies,
  collectThreadImages,
  collectThreadDocuments,
  collectThreadTextDocuments,
  resolveDriveLinks,
  buildToolContext,
  settleRunningToolActivity,
  UNREPORTED_TOOL_RESULT,
  messageSurface,
  mentionSurface,
  resolveSlackBotUserId,
  slackTurnNeedsErrorNotice,
  reconcileSlackThreadForTrigger,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from "../slackBot";
import type { SlackMessage } from "../lib/slackApi";
import type { ToolActivity } from "../lib/toolActivityGroups";
import { fetchConversationKind } from "../lib/slackApi";
import { checkinDayKey } from "../lib/eodCheckin";
import {
  buildSlackTranscript,
  type TranscriptContent,
} from "../lib/slackTranscript";

const { slackToolRunner } = vi.hoisted(() => ({
  slackToolRunner: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    beta = { messages: { toolRunner: slackToolRunner } };
  }
  return { default: FakeAnthropic, Anthropic: FakeAnthropic };
});

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role = "scholar",
  overrides: {
    name?: string;
    username?: string;
    slackUserId?: string;
    email?: string;
    institutionId?: Id<"institutions">;
  } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test${role}`,
      role: role as Doc<"users">["role"],
      slackUserId: overrides.slackUserId,
      email: overrides.email,
      ...(overrides.institutionId
        ? { institutionId: overrides.institutionId }
        : {}),
    }),
  );
}

async function seedInstitution(
  t: ReturnType<typeof convexTest>,
  slug: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("institutions", {
      name: slug,
      slug,
      kind: "school" as const,
    }),
  );
}

async function grantMembership(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  role: "teacher" | "staff" | "school_admin",
  institutionId: Id<"institutions">,
) {
  await t.run(async (ctx) =>
    ctx.db.insert("memberships", { userId, role, institutionId }),
  );
}

// The retired registrar role's successor: a `staff` membership plus the
// `school:operations` capability grant that gives it scholar-admin access
// without curriculum or sensitive learning data.
async function grantOperationsCapability(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
) {
  await t.run(async (ctx) =>
    ctx.db.insert("staffCapabilityGrants", {
      granteeUserId: userId,
      institutionId,
      capability: "school:operations",
      grantedBy: userId,
      grantedAt: Date.now(),
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

const SECRET = "test-signing-secret";

async function signedSlackPost(
  t: ReturnType<typeof convexTest>,
  body: Record<string, unknown>,
): Promise<Response> {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = await computeSlackSignature(SECRET, ts, raw);
  return await t.fetch("/slack/events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": sig,
    },
    body: raw,
  });
}

describe("/slack/events endpoint", () => {
  test("503 when Slack isn't configured", async () => {
    delete process.env.SLACK_SIGNING_SECRET;
    const t = convexTest(schema, modules);
    const res = await t.fetch("/slack/events", { method: "POST", body: "{}" });
    expect(res.status).toBe(503);
  });

  test("rejects bad signatures", async () => {
    process.env.SLACK_SIGNING_SECRET = SECRET;
    const t = convexTest(schema, modules);
    const res = await t.fetch("/slack/events", {
      method: "POST",
      headers: {
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-slack-signature": "v0=deadbeef",
      },
      body: JSON.stringify({ type: "event_callback", event_id: "Ev1" }),
    });
    expect(res.status).toBe(401);
  });

  test("answers the url_verification challenge", async () => {
    process.env.SLACK_SIGNING_SECRET = SECRET;
    const t = convexTest(schema, modules);
    const res = await signedSlackPost(t, {
      type: "url_verification",
      challenge: "challenge-token-123",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "challenge-token-123" });
  });

  test("claims events exactly once (retry dedupe)", async () => {
    process.env.SLACK_SIGNING_SECRET = SECRET;
    const t = convexTest(schema, modules);
    const body = {
      type: "event_callback",
      event_id: "Ev42",
      event: { type: "app_mention" }, // malformed enough that handleEvent no-ops
    };
    const first = await signedSlackPost(t, body);
    expect(first.status).toBe(200);
    const second = await signedSlackPost(t, body);
    expect(second.status).toBe(200);

    const rows = await t.run(async (ctx) =>
      ctx.db.query("slackEvents").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].eventId).toBe("Ev42");
  });
});

describe("identity mapping", () => {
  test("getBySlackIdInternal resolves mapped users, null otherwise", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", { slackUserId: "U123" });
    const found = await t.run(async (ctx) =>
      ctx.runQuery(internal.users.getBySlackIdInternal, { slackUserId: "U123" }),
    );
    expect(found?._id).toBe(teacherId);
    const missing = await t.run(async (ctx) =>
      ctx.runQuery(internal.users.getBySlackIdInternal, { slackUserId: "U999" }),
    );
    expect(missing).toBeNull();
  });

  describe("Slack event/thread reconciliation", () => {
    const message = (
      ts: string,
      user: string,
      text: string,
    ): SlackMessage => ({ ts, user, text });

    test("injects a trigger missing from Slack's eventually consistent thread read", () => {
      const thread = [
        message("100.000001", "U1", "root"),
        message("101.000001", "UBOT", "previous answer"),
      ];
      const trigger: SlackMessage = {
        ...message("102.000001", "UREGISTRAR", "read the attached profile"),
        files: [
          {
            id: "F_PROFILE",
            name: "profile.pdf",
            mimetype: "application/pdf",
            size: 760_174,
            url_private_download: "https://files.slack.test/profile.pdf",
          },
        ],
      };

      const reconciled = reconcileSlackThreadForTrigger(thread, trigger);

      expect(reconciled.at(-1)).toEqual(trigger);
      const lastTurn = buildSlackTranscript({
        messages: reconciled,
        botUserId: "UBOT",
        names: new Map(),
        documents: new Map([
          ["F_PROFILE", { dataBase64: "JVBERi0x", name: "profile.pdf" }],
        ]),
      }).at(-1);
      expect(lastTurn?.role).toBe("user");
      expect(lastTurn?.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "document",
            source: expect.objectContaining({ media_type: "application/pdf" }),
          }),
        ]),
      );
    });

    test("replaces a fetched trigger instead of duplicating it", () => {
      const trigger = message("102.000001", "UREGISTRAR", "canonical event text");
      const reconciled = reconcileSlackThreadForTrigger(
        [
          message("100.000001", "U1", "root"),
          message("102.000001", "UREGISTRAR", "stale fetched text"),
        ],
        trigger,
      );

      expect(reconciled.filter((item) => item.ts === trigger.ts)).toEqual([trigger]);
    });

    test("keeps fetched file metadata when the event copy is sparse", () => {
      const fetchedTrigger: SlackMessage = {
        ...message("102.000001", "UREGISTRAR", "stale text"),
        files: [
          {
            id: "F_PROFILE",
            name: "profile.pdf",
            mimetype: "application/pdf",
            url_private_download: "https://files.slack.test/profile.pdf",
          },
        ],
      };
      const trigger = message("102.000001", "UREGISTRAR", "canonical event text");

      const reconciled = reconcileSlackThreadForTrigger(
        [message("100.000001", "U1", "root"), fetchedTrigger],
        trigger,
      );

      expect(reconciled.at(-1)).toMatchObject({
        text: "canonical event text",
        files: fetchedTrigger.files,
      });
    });

    test("drops later messages and bounds long threads around the triggering turn", () => {
      const fetched = Array.from({ length: 82 }, (_, i) =>
        message(`${100 + i}.000001`, i % 2 ? "UBOT" : "U1", `message ${i}`),
      );
      const trigger = message("170.000001", "UREGISTRAR", "current request");

      const reconciled = reconcileSlackThreadForTrigger(fetched, trigger, 50);

      expect(reconciled).toHaveLength(50);
      expect(reconciled[0]).toEqual(fetched[0]);
      expect(reconciled.at(-1)).toEqual(trigger);
      expect(reconciled.some((item) => Number(item.ts) > Number(trigger.ts))).toBe(false);
    });
  });

  test("adminSetSlackUserId enforces uniqueness and admin role", async () => {
    const t = convexTest(schema, modules);
    const adminId = await seedUser(t, "platform_admin");
    const teacherA = await seedUser(t, "teacher", { username: "ta" });
    const teacherB = await seedUser(t, "teacher", { username: "tb" });
    const asAdmin = await withUser(t, adminId);

    await asAdmin.mutation(api.users.adminSetSlackUserId, {
      userId: teacherA,
      slackUserId: "U777",
    });
    await expect(
      asAdmin.mutation(api.users.adminSetSlackUserId, {
        userId: teacherB,
        slackUserId: "U777",
      }),
    ).rejects.toThrow(/already linked/);

    // Clearing works.
    await asAdmin.mutation(api.users.adminSetSlackUserId, {
      userId: teacherA,
      slackUserId: undefined,
    });
    const a = await t.run(async (ctx) => ctx.db.get(teacherA));
    expect(a?.slackUserId).toBeUndefined();

    // Non-admins are forbidden.
    const asTeacher = await withUser(t, teacherA);
    await expect(
      asTeacher.mutation(api.users.adminSetSlackUserId, {
        userId: teacherA,
        slackUserId: "U1",
      }),
    ).rejects.toThrow(/Forbidden/);
  });
});

describe("Slack scholar institution lens", () => {
  test("resolves the requester's home institution and materializes its scholar set", async () => {
    const callerUserId = "caller" as Id<"users">;
    const inLens = "in-lens" as Id<"users">;
    const runQuery = vi.fn().mockResolvedValue({
      scholarIds: [inLens],
      lensLabel: "Home School",
      unrestricted: false,
    });

    const result = await resolveSlackScholarLens({ runQuery }, callerUserId);

    expect(runQuery).toHaveBeenCalledWith(
      internal.curriculumAssistant.resolveAideScholarLens,
      { callerUserId, scope: "" },
    );
    expect(result.lensLabel).toBe("Home School");
    expect(result.allowedScholarIds).toEqual(new Set([inLens]));
  });

  test("fails closed when lens resolution does not return scholar ids", async () => {
    const runQuery = vi.fn().mockResolvedValue({
      scholarIds: null,
      lensLabel: null,
      unrestricted: true,
    });

    const result = await resolveSlackScholarLens(
      { runQuery },
      "caller" as Id<"users">,
    );

    expect(result.allowedScholarIds).toEqual(new Set());
  });
});

describe("Slack reply completion", () => {
  test("waits for every reply segment when an earlier segment rejects", async () => {
    let finishLastReply!: () => void;
    const lastReply = new Promise<void>((resolve) => {
      finishLastReply = resolve;
    });
    let completed = false;

    const waiting = waitForSlackReplies([
      Promise.reject(new Error("stream failed")),
      lastReply,
    ]).then(() => {
      completed = true;
    });

    await Promise.resolve();
    expect(completed).toBe(false);

    finishLastReply();
    await waiting;
    expect(completed).toBe(true);
  });
});

describe("react_only lead-in retraction", () => {
  test("a refused react_only commits only the forced reply", async () => {
    const leadIn = "I'll stay out of the way.";
    const forcedReply = "Here is the answer you asked for.";
    const stream = (
      events: Array<Record<string, unknown>>,
    ): AsyncIterable<Record<string, unknown>> => ({
      async *[Symbol.asyncIterator]() {
        yield* events;
      },
    });

    slackToolRunner.mockImplementationOnce(
      (config: {
        tools: Array<{
          name: string;
          run: (input: { emoji: string }) => Promise<string>;
        }>;
      }) => ({
        async *[Symbol.asyncIterator]() {
          yield stream([
            {
              type: "message_start",
              message: {
                model: "claude-test",
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            },
            {
              type: "content_block_delta",
              delta: { type: "text_delta", text: leadIn },
            },
            {
              type: "content_block_start",
              content_block: { type: "tool_use", name: "react_only" },
            },
          ]);
          const reactOnly = config.tools.find((tool) => tool.name === "react_only");
          if (!reactOnly) throw new Error("react_only tool was not registered");
          const refusal = await reactOnly.run({ emoji: "none" });
          expect(refusal).toContain("NOT available");
          yield stream([
            {
              type: "message_start",
              message: {
                model: "claude-test",
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            },
            {
              type: "content_block_delta",
              delta: { type: "text_delta", text: forcedReply },
            },
          ]);
        },
      }),
    );

    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli-react-only");
    const teacherId = await seedUser(t, "teacher", {
      username: "lehua-react-only",
      slackUserId: "U_LEHUA",
      institutionId,
    });
    await grantMembership(t, teacherId, "teacher", institutionId);

    const previousToken = process.env.SLACK_BOT_TOKEN;
    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.ANTHROPIC_API_KEY = "test-key";
    const realFetch = globalThis.fetch;
    const messages = new Map<string, string>();
    const deleted = new Set<string>();
    let nextTs = 1;

    globalThis.fetch = (async (
      url: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const method = String(url).split("/api/")[1] ?? String(url);
      const raw = String(init?.body ?? "");
      const body = raw.startsWith("{")
        ? (JSON.parse(raw) as Record<string, unknown>)
        : Object.fromEntries(new URLSearchParams(raw));

      if (method === "conversations.info") {
        return Response.json({
          ok: true,
          channel: { id: "C_BUGS", is_channel: true },
        });
      }
      if (method === "conversations.replies") {
        return Response.json({
          ok: true,
          messages: [
            {
              ts: "100.1",
              user: "U_LEHUA",
              text: `<@B_BOT> please answer this`,
            },
          ],
        });
      }
      if (method === "users.info") {
        return Response.json({
          ok: true,
          user: { id: "U_LEHUA", real_name: "Lehua Torres" },
        });
      }
      if (method === "chat.startStream") {
        const ts = `stream-${nextTs++}`;
        messages.set(ts, "");
        return Response.json({ ok: true, ts });
      }
      if (method === "chat.appendStream") {
        const ts = String(body.ts);
        messages.set(
          ts,
          `${messages.get(ts) ?? ""}${String(body.markdown_text ?? "")}`,
        );
        return Response.json({ ok: true });
      }
      if (method === "chat.delete") {
        deleted.add(String(body.ts));
        return Response.json({ ok: true });
      }
      if (method === "chat.postMessage") {
        const ts = `post-${nextTs++}`;
        messages.set(ts, String(body.text ?? ""));
        return Response.json({ ok: true, ts });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;

    try {
      await t.action(internal.slackBot.handleEvent, {
        payload: {
          team_id: "T1",
          event_id: "EvRefusedReactOnly",
          authorizations: [{ user_id: "B_BOT", is_bot: true }],
          event: {
            type: "app_mention",
            user: "U_LEHUA",
            text: "<@B_BOT> please answer this",
            channel: "C_BUGS",
            ts: "100.1",
          },
        },
      });
    } finally {
      globalThis.fetch = realFetch;
      if (previousToken === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = previousToken;
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousApiKey;
    }

    const committed = [...messages]
      .filter(([ts]) => !deleted.has(ts))
      .map(([, text]) => text)
      .join("\n");
    expect(committed).toContain(forcedReply);
    expect(committed).not.toContain(leadIn);

    const stored = await t.run(async (ctx) =>
      ctx.db.query("curriculumMessages").collect(),
    );
    expect(stored.at(-1)?.content).toContain(forcedReply);
    expect(stored.at(-1)?.content).not.toContain(leadIn);
  });
});

describe("error notice on a failed turn", () => {
  // A turn that throws must never leave the human with nothing. The trap is
  // that the turn's promise array mixes real utterances with tool-activity
  // renders and retractions, so "did we post anything?" is not the same
  // question as "did we answer them?".
  test("a turn that only rendered tool activity still gets the notice", () => {
    expect(
      slackTurnNeedsErrorNotice({
        posts: ["tool-activity"],
        reactedOnly: false,
      }),
    ).toBe(true);
  });

  test("a retracted message doesn't count as having spoken", () => {
    expect(
      slackTurnNeedsErrorNotice({
        posts: ["tool-activity", "retracted"],
        reactedOnly: false,
      }),
    ).toBe(true);
  });

  test("a turn that posted nothing at all gets the notice", () => {
    expect(
      slackTurnNeedsErrorNotice({ posts: [], reactedOnly: false }),
    ).toBe(true);
  });

  test("a trailing utterance suppresses it — the human has a reply on screen", () => {
    expect(
      slackTurnNeedsErrorNotice({
        posts: ["tool-activity", "reply"],
        reactedOnly: false,
      }),
    ).toBe(false);
  });

  test("a lead-in the turn then abandoned mid-tool still gets the notice", () => {
    // "text · tools · text" is the designed shape of a reply, so an utterance
    // FOLLOWED by tool activity is a narration ("let me check…"), not an
    // answer — the model went back to work and never came back.
    expect(
      slackTurnNeedsErrorNotice({
        posts: ["reply", "tool-activity"],
        reactedOnly: false,
      }),
    ).toBe(true);
  });

  test("a turn that ended on its reply is answered, tools or no tools", () => {
    expect(
      slackTurnNeedsErrorNotice({ posts: ["reply"], reactedOnly: false }),
    ).toBe(false);
  });

  test("a deliberate react_only turn is already answered", () => {
    // It replies with a reaction and retracts everything else; an error notice
    // on top would contradict the silence it chose.
    expect(
      slackTurnNeedsErrorNotice({ posts: ["retracted"], reactedOnly: true }),
    ).toBe(false);
  });
});

describe("Slack bot identity resolution", () => {
  test("finds the bot when it is not authorizations[0]", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("auth.test should not be called"));

    try {
      expect(
        await resolveSlackBotUserId({
          api_app_id: "A_RABBITHOLE",
          authorizations: [
            { user_id: "U_OTHER", is_bot: false, app_id: "A_OTHER" },
            { user_id: "B_BOT", is_bot: true, app_id: "A_RABBITHOLE" },
          ],
        }),
      ).toBe("B_BOT");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("falls back to the installed bot identity when authorizations is empty", async () => {
    const previousToken = process.env.SLACK_BOT_TOKEN;
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            user_id: "B_PERSISTED",
            bot_id: "BOT1",
            team_id: "T1",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    try {
      expect(
        await resolveSlackBotUserId({
          team_id: "T1",
          event_id: "EvFallback",
          authorizations: [],
          event: { type: "app_mention", channel: "C1" },
        }),
      ).toBe("B_PERSISTED");
      expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("/auth.test");
    } finally {
      fetchSpy.mockRestore();
      if (previousToken === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = previousToken;
    }
  });

  test("logs context loudly when no bot identity can be determined", async () => {
    const previousToken = process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        resolveSlackBotUserId({
          api_app_id: "A_RABBITHOLE",
          team_id: "T1",
          event_id: "EvDegraded",
          authorizations: [],
          event: { type: "app_mention", channel: "C1" },
        }),
      ).resolves.toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("mention routing is degraded"),
        expect.objectContaining({
          eventId: "EvDegraded",
          teamId: "T1",
          apiAppId: "A_RABBITHOLE",
          eventType: "app_mention",
          channelId: "C1",
          authorizationCount: 0,
        }),
      );
    } finally {
      errorSpy.mockRestore();
      if (previousToken !== undefined) {
        process.env.SLACK_BOT_TOKEN = previousToken;
      }
    }
  });
});

describe("parent-message Slack channel routing", () => {
  async function seedMappedParentSlackThread(t: ReturnType<typeof convexTest>) {
    const institutionId = await seedInstitution(t, "parent-routing-school");
    const teacher = await seedUser(t, "teacher", {
      username: "teacher",
      name: "Ms Lani",
      slackUserId: "U_TEACHER",
      institutionId,
    });
    await grantMembership(t, teacher, "teacher", institutionId);
    const kai = await seedUser(t, "scholar", {
      username: "kai",
      name: "Kai",
      institutionId,
    });
    const pat = await seedUser(t, "parent", {
      username: "pat",
      name: "Pat",
      email: "pat@home.test",
    });
    const threadId = await t.run(async (ctx) => {
      await ctx.db.insert("guardianships", {
        parentUserId: pat,
        scholarUserId: kai,
        createdBy: teacher,
      });
      const parentThreadId = await ctx.db.insert("parentThreads", {
        parentUserId: pat,
        teacherId: teacher,
        scholarId: kai,
        lastMessageAt: Date.now(),
      });
      await ctx.db.insert("parentSlackThreads", {
        parentThreadId,
        channelId: "C_PARENT_STAFF",
        threadTs: "111.222",
        lastNotifiedAt: Date.now(),
      });
      return parentThreadId;
    });
    return { threadId, teacher, pat };
  }

  test("plain channel thread replies in mapped parent-message threads are ingested before aide routing", async () => {
    const t = convexTest(schema, modules);
    const { threadId, teacher } = await seedMappedParentSlackThread(t);

    await t.action(internal.slackBot.handleEvent, {
      payload: {
        team_id: "T1",
        event_id: "EvParentChannelReply",
        authorizations: [{ user_id: "B_BOT", is_bot: true }],
        event: {
          type: "message",
          user: "U_TEACHER",
          text: "Happy to talk tomorrow.",
          channel: "C_PARENT_STAFF",
          channel_type: "channel",
          ts: "111.333",
          thread_ts: "111.222",
        },
      },
    });

    const messages = await t.run(async (ctx) =>
      ctx.db
        .query("parentMessages")
        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
        .collect(),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      authorType: "teacher",
      authorUserId: teacher,
      body: "Happy to talk tomorrow.",
      providerMessageId: "slack:EvParentChannelReply",
      source: "slack",
    });
  });

  test("a mentioned parent-thread reply is still ingested on the message event", async () => {
    const t = convexTest(schema, modules);
    const { threadId } = await seedMappedParentSlackThread(t);

    await t.action(internal.slackBot.handleEvent, {
      payload: {
        team_id: "T1",
        event_id: "EvMentionedParentReply",
        authorizations: [{ user_id: "B_BOT", is_bot: true }],
        event: {
          type: "message",
          user: "U_TEACHER",
          text: "<@B_BOT> Happy to talk tomorrow.",
          channel: "C_PARENT_STAFF",
          channel_type: "channel",
          ts: "111.333",
          thread_ts: "111.222",
        },
      },
    });

    const messages = await t.run(async (ctx) =>
      ctx.db
        .query("parentMessages")
        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
        .collect(),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].providerMessageId).toBe(
      "slack:EvMentionedParentReply",
    );
  });

  test("rejected parent-channel replies post a threaded couldn't-send notice", async () => {
    const t = convexTest(schema, modules);
    const { threadId } = await seedMappedParentSlackThread(t);

    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const realFetch = globalThis.fetch;
    const posts: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toContain("chat.postMessage");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      posts.push(body);
      return new Response(JSON.stringify({ ok: true, ts: "111.444" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await t.action(internal.slackBot.handleEvent, {
        payload: {
          team_id: "T1",
          event_id: "EvParentChannelRejected",
          authorizations: [{ user_id: "B_BOT", is_bot: true }],
          event: {
            type: "message",
            user: "U_STRANGER",
            text: "Please send this",
            channel: "C_PARENT_STAFF",
            channel_type: "channel",
            ts: "111.333",
            thread_ts: "111.222",
          },
        },
      });
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.SLACK_BOT_TOKEN;
    }

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      channel: "C_PARENT_STAFF",
      thread_ts: "111.222",
    });
    expect(String(posts[0].text)).toContain("Couldn't send to the parent");

    const messages = await t.run(async (ctx) =>
      ctx.db
        .query("parentMessages")
        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
        .collect(),
    );
    expect(messages).toHaveLength(0);
  });
});

describe("alert-thread routing", () => {
  test("answers the first plain reply to a Rabbithole-authored alert root", async () => {
    const t = convexTest(schema, modules);
    const linkedBy = await seedUser(t, "platform_admin");
    await t.run((ctx) =>
      ctx.db.insert("alertChannel", {
        slackChannelId: "C_ALERTS",
        linkedBy,
        linkedAt: Date.now(),
        role: "catchall",
      }),
    );

    const previousToken = process.env.SLACK_BOT_TOKEN;
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const realFetch = globalThis.fetch;
    const methods: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const method = String(url).split("/api/")[1] ?? String(url);
      methods.push(method);
      const body =
        method === "conversations.replies"
          ? {
              ok: true,
              messages: [
                {
                  ts: "111.000",
                  user: "B_BOT",
                  bot_id: "BOT_APP",
                  text: "A managed iPad needs charging.",
                },
                {
                  ts: "111.222",
                  thread_ts: "111.000",
                  user: "U_SOMEONE",
                  text: "What is its battery level now?",
                },
              ],
            }
          : { ok: true, ts: "111.333" };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      await t.action(internal.slackBot.handleEvent, {
        payload: {
          team_id: "T1",
          event_id: "EvAlertReply",
          authorizations: [{ user_id: "B_BOT", is_bot: true }],
          event: {
            type: "message",
            user: "U_SOMEONE",
            channel: "C_ALERTS",
            channel_type: "channel",
            ts: "111.222",
            thread_ts: "111.000",
            text: "What is its battery level now?",
          },
        },
      });
    } finally {
      globalThis.fetch = realFetch;
      if (previousToken === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = previousToken;
    }

    expect(methods).toEqual(["conversations.replies", "chat.postMessage"]);
  });
});

describe("group DM (mpim) routing", () => {
  // The reviewer notice opens a group DM holding the requester and the
  // reviewer, so the bot now lives in a room where two humans talk to EACH
  // OTHER. It must stay out of that unless spoken to. Note that Slack DOES
  // fire `app_mention` in an mpim (verified live — see the test below), so
  // the message path must leave mentions alone here exactly as in a channel.
  let prevToken: string | undefined;
  beforeAll(() => {
    prevToken = process.env.SLACK_BOT_TOKEN;
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
  });
  afterAll(() => {
    if (prevToken === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = prevToken;
  });

  /** Capture Slack calls. The author is deliberately an UNMAPPED Slack user,
   * so reaching runConversation shows up as exactly one postMessage (the
   * "I can't tell who you are" notice) without needing an AI round-trip.
   *
   * `conversations.info` answers with the REAL group-DM body from the live
   * probe (note `is_channel: true` sitting right next to `is_mpim: true`), so
   * the mention path resolves this room the way production would rather than
   * silently exercising the can't-tell fallback. */
  function stubSlack() {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const method = String(url).split("/api/")[1] ?? String(url);
      calls.push(method);
      const body =
        method === "conversations.info"
          ? {
              ok: true,
              channel: {
                id: "G_REVIEW",
                is_im: false,
                is_mpim: true,
                is_channel: true,
                is_private: true,
              },
            }
          : { ok: true, ts: "1.2" };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    return {
      calls: () => calls,
      posts: () => calls.filter((c) => c === "chat.postMessage"),
      restore: () => {
        globalThis.fetch = realFetch;
      },
    };
  }

  async function deliver(
    t: ReturnType<typeof convexTest>,
    event: Record<string, unknown>,
  ) {
    const stub = stubSlack();
    try {
      await t.action(internal.slackBot.handleEvent, {
        payload: {
          team_id: "T1",
          event_id: `Ev${Math.random()}`,
          authorizations: [{ user_id: "B_BOT", is_bot: true }],
          event: {
            type: "message",
            user: "U_SOMEONE",
            channel: "G_REVIEW",
            channel_type: "mpim",
            ts: "222.111",
            ...event,
          },
        },
      });
    } finally {
      stub.restore();
    }
    return stub.posts().length;
  }

  test("ignores messages between the two humans", async () => {
    const t = convexTest(schema, modules);
    expect(await deliver(t, { text: "thanks, I'll take a look tonight" })).toBe(
      0,
    );
  });

  // VERIFIED LIVE against prod (2026-07-25): Slack DOES deliver `app_mention`
  // for a group DM — an @-mention there was answered by the deployed bot with
  // no mpim-specific code at all. The message path must therefore keep its
  // hands off mentions here exactly as it does in a channel, or the mention
  // gets handled twice and the bot answers itself twice.
  test("leaves an @-mention to app_mention rather than answering twice", async () => {
    const t = convexTest(schema, modules);
    expect(await deliver(t, { text: "<@B_BOT> go ahead and build it" })).toBe(0);
  });

  test("answers an app_mention in a group DM, resolving the surface by API", async () => {
    const t = convexTest(schema, modules);
    const stub = stubSlack();
    try {
      await t.action(internal.slackBot.handleEvent, {
        payload: {
          team_id: "T1",
          event_id: "EvMpimMention",
          authorizations: [{ user_id: "B_BOT", is_bot: true }],
          event: {
            type: "app_mention",
            user: "U_SOMEONE",
            text: "<@B_BOT> go ahead and build it",
            channel: "G_REVIEW",
            ts: "222.111",
          },
        },
      });
    } finally {
      stub.restore();
    }
    expect(stub.posts()).toHaveLength(1);
    // The mention is answered AND the surface came from Slack rather than
    // being assumed: an app_mention carries no channel_type, so skipping this
    // lookup is the same as hardcoding "channel".
    expect(stub.calls()).toContain("conversations.info");
  });

  test("continues a thread it already joined without needing another mention", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        name: "Avery Stone",
        username: "avery",
        role: "platform_admin",
      });
      const chatId = await ctx.db.insert("chats", {
        teacherId: userId,
        title: "Group DM",
        pinned: false,
        lastMessageAt: Date.now(),
      });
      await ctx.db.insert("slackThreads", {
        channelId: "G_REVIEW",
        threadTs: "222.000",
        chatId,
        startedByUserId: userId,
        lastActivityAt: Date.now(),
      });
    });
    expect(
      await deliver(t, { text: "and add the CSV escaping", thread_ts: "222.000" }),
    ).toBe(1);
  });

  test("still ignores an unrelated thread it never joined", async () => {
    const t = convexTest(schema, modules);
    expect(
      await deliver(t, { text: "sounds good", thread_ts: "222.999" }),
    ).toBe(0);
  });

  // Surface classification, pinned to payloads PROBED LIVE on 2026-07-26
  // (throwaway group DM on the Slack-debug rig; nothing inferred from docs).
  // Ids below are symbolic — the KEYS are what the probe pinned down:
  //
  //   message in a group DM, human-authored, threaded, no mention:
  //     {"type":"message","channel_type":"mpim","channel":…,
  //      "user":…,"ts":…,"thread_ts":…}
  //   the SAME message's app_mention sibling (when it does mention the bot):
  //     {"type":"app_mention","channel":…,"user":…,"ts":…,"thread_ts":…}
  //                                       ← no `channel_type` key at all
  //
  // The absence on `app_mention` is why the surface for a mention has to come
  // from conversations.info instead of the event.
  describe("surface classification", () => {
    test("a group DM message is its own surface, not a channel", () => {
      expect(messageSurface("mpim")).toBe("mpim");
    });

    test("only `im` is the 1:1 DM", () => {
      expect(messageSurface("im")).toBe("dm");
    });

    test("public and private channels are channel threads", () => {
      expect(messageSurface("channel")).toBe("channel");
      expect(messageSurface("group")).toBe("channel");
    });

    test("a missing channel_type — as on app_mention — falls back to channel", () => {
      // Safe by construction: a mention turn can never stay silent anyway, so
      // the fallback can only cost a prompt-cache miss, never a dropped ask.
      expect(messageSurface(undefined)).toBe("channel");
    });
  });

  // conversations.info responses, also copied from the live probe. A group DM
  // reports `is_channel: true` ALONGSIDE `is_mpim: true`, so the DM flags have
  // to be read first — and the channel id is `C`-prefixed either way.
  describe("fetchConversationKind", () => {
    function stubInfo(body: Record<string, unknown>) {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch;
      return () => {
        globalThis.fetch = realFetch;
      };
    }

    test("reads a group DM as mpim despite is_channel also being true", async () => {
      const restore = stubInfo({
        ok: true,
        channel: {
          id: "C_GROUP_DM",
          is_im: false,
          is_mpim: true,
          is_channel: true,
          is_private: true,
        },
      });
      try {
        expect(await fetchConversationKind("xoxb-test", "C_GROUP_DM")).toBe(
          "mpim",
        );
      } finally {
        restore();
      }
    });

    test("reads a 1:1 DM as dm (Slack omits the other flags entirely)", async () => {
      const restore = stubInfo({
        ok: true,
        channel: { id: "D_ONE_TO_ONE", is_im: true },
      });
      try {
        expect(await fetchConversationKind("xoxb-test", "D_ONE_TO_ONE")).toBe(
          "dm",
        );
      } finally {
        restore();
      }
    });

    test("reads a public channel as channel", async () => {
      const restore = stubInfo({
        ok: true,
        channel: {
          id: "C_PUBLIC",
          is_im: false,
          is_mpim: false,
          is_channel: true,
          is_private: false,
        },
      });
      try {
        expect(await fetchConversationKind("xoxb-test", "C_PUBLIC")).toBe(
          "channel",
        );
      } finally {
        restore();
      }
    });

    test("says null rather than guessing when Slack refuses", async () => {
      const restore = stubInfo({ ok: false, error: "missing_scope" });
      try {
        expect(await fetchConversationKind("xoxb-test", "C1")).toBeNull();
      } finally {
        restore();
      }
    });
  });

  // The mention path is the ENTRY POINT for a reviewer group DM, so it is the
  // one that most needs pinning: `slackThreads` rows are only written from
  // inside runConversation, and the plain-message path drops anything in an
  // unknown thread — so the first turn the bot ever takes in one of these
  // rooms is necessarily an app_mention.
  describe("mentionSurface", () => {
    let prevToken: string | undefined;
    beforeAll(() => {
      prevToken = process.env.SLACK_BOT_TOKEN;
      process.env.SLACK_BOT_TOKEN = "xoxb-test";
    });
    afterAll(() => {
      if (prevToken === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = prevToken;
    });

    /** @returns a restore fn; `bodies` are consumed one per fetch. */
    function stubInfoSequence(bodies: Record<string, unknown>[]) {
      const realFetch = globalThis.fetch;
      let i = 0;
      globalThis.fetch = (async () => {
        const body = bodies[Math.min(i++, bodies.length - 1)];
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;
      return {
        count: () => i,
        restore: () => {
          globalThis.fetch = realFetch;
        },
      };
    }

    const MPIM_INFO = {
      ok: true,
      channel: {
        id: "C_GROUP_DM",
        is_im: false,
        is_mpim: true,
        is_channel: true,
        is_private: true,
      },
    };

    test("classifies a mention in a group DM as mpim, not channel", async () => {
      const stub = stubInfoSequence([MPIM_INFO]);
      try {
        expect(await mentionSurface("C_GROUP_DM")).toBe("mpim");
      } finally {
        stub.restore();
      }
    });

    test("agrees with the message path for the same room", async () => {
      // Both event paths MUST land on the same surface for a given thread, or
      // the tools array — and with it the prompt-cache prefix, whose only
      // breakpoint sits after the tools — is rewritten every time a mention
      // turn and a plain turn alternate.
      const stub = stubInfoSequence([MPIM_INFO]);
      try {
        expect(await mentionSurface("C_GROUP_DM")).toBe(
          messageSurface("mpim"),
        );
      } finally {
        stub.restore();
      }
    });

    test("a mention in a real channel is still a channel", async () => {
      const stub = stubInfoSequence([
        { ok: true, channel: { id: "C_PUBLIC", is_im: false, is_mpim: false, is_channel: true } },
      ]);
      try {
        expect(await mentionSurface("C_PUBLIC")).toBe("channel");
      } finally {
        stub.restore();
      }
    });

    test("retries once before giving up on a transient failure", async () => {
      // The fallback is safe for silence (the @-mention gate refuses
      // react_only regardless) but NOT free: it re-registers the five
      // channel-binding tools in a group DM for that turn. Hence the retry.
      const stub = stubInfoSequence([
        { ok: false, error: "ratelimited" },
        MPIM_INFO,
      ]);
      try {
        expect(await mentionSurface("C_GROUP_DM")).toBe("mpim");
        expect(stub.count()).toBe(2);
      } finally {
        stub.restore();
      }
    });

    test("falls back to channel — today's behaviour — when Slack stays down", async () => {
      const stub = stubInfoSequence([{ ok: false, error: "ratelimited" }]);
      try {
        expect(await mentionSurface("C_GROUP_DM")).toBe("channel");
        expect(stub.count()).toBe(2);
      } finally {
        stub.restore();
      }
    });
  });
});

describe("slackAdminOps", () => {
  test("issueParentEnrollLink: scholar-admin only, resolves parents, rejects ambiguity", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const designerId = await seedUser(t, "curriculum_designer");
    await seedUser(t, "parent", {
      name: "Rowan Example",
      email: "rowan@example.com",
      username: "re",
    });
    await seedUser(t, "parent", {
      name: "Morgan Example",
      email: "morgan@example.com",
      username: "me",
    });

    // Role gate: designer refused.
    const refused = await t.run(async (ctx) =>
      ctx.runMutation(internal.slackAdminOps.issueParentEnrollLink, {
        callerUserId: designerId,
        parentName: "Rowan",
      }),
    );
    expect(refused).toMatchObject({ ok: false });

    // Ambiguous surname → asks to narrow.
    const ambiguous = await t.run(async (ctx) =>
      ctx.runMutation(internal.slackAdminOps.issueParentEnrollLink, {
        callerUserId: teacherId,
        parentName: "Example",
      }),
    );
    expect(ambiguous.ok).toBe(false);
    if (!ambiguous.ok) expect(ambiguous.message).toContain("Multiple parents");

    // Unique match → link issued.
    const issued = await t.run(async (ctx) =>
      ctx.runMutation(internal.slackAdminOps.issueParentEnrollLink, {
        callerUserId: teacherId,
        parentName: "Rowan",
      }),
    );
    expect(issued.ok).toBe(true);
    if (issued.ok) {
      expect(issued.url).toContain("/enroll?token=");
      expect(issued.parentName).toBe("Rowan Example");
    }
    const tokens = await t.run(async (ctx) =>
      ctx.db.query("enrollmentTokens").collect(),
    );
    expect(tokens).toHaveLength(1);
  });

  test("issueScholarPinLink: scholar-admin + same-institution only, scholars only, returns an enroll link", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "pin-inst");
    const registrarId = await seedUser(t, "staff", { institutionId: inst });
    await grantMembership(t, registrarId, "staff", inst);
    await grantOperationsCapability(t, registrarId, inst);
    const parentId = await seedUser(t, "parent", { username: "p1" });
    const scholarId = await seedUser(t, "scholar", {
      name: "Kai Nakamura",
      username: "kai",
      institutionId: inst,
    });

    // Seed an existing credential + session — issuing a link must NOT wipe them
    // (the scholar's old PIN keeps working until they redeem the link).
    await t.run(async (ctx) => {
      await ctx.db.insert("authAccounts", {
        userId: scholarId,
        provider: "password",
        providerAccountId: "kai@local",
      });
      await ctx.db.insert("authSessions", {
        userId: scholarId,
        expirationTime: Date.now() + 1000 * 60 * 60,
      });
    });

    // Parent calling → refused.
    const refused = await t.run(async (ctx) =>
      ctx.runMutation(internal.slackAdminOps.issueScholarPinLink, {
        callerUserId: parentId,
        scholarId,
      }),
    );
    expect(refused.ok).toBe(false);

    // Targeting a non-scholar → refused.
    const wrongTarget = await t.run(async (ctx) =>
      ctx.runMutation(internal.slackAdminOps.issueScholarPinLink, {
        callerUserId: registrarId,
        scholarId: registrarId,
      }),
    );
    expect(wrongTarget.ok).toBe(false);

    // Operations staff issuing for a scholar in their institution → ok.
    const result = await t.run(async (ctx) =>
      ctx.runMutation(internal.slackAdminOps.issueScholarPinLink, {
        callerUserId: registrarId,
        scholarId,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toContain("/enroll?token=");
      expect(result.username).toBe("kai");
    }
    // Existing credential + session are left intact (no destructive reset).
    const accounts = await t.run(async (ctx) =>
      ctx.db.query("authAccounts").collect(),
    );
    expect(accounts).toHaveLength(1);
    const sessions = await t.run(async (ctx) =>
      ctx.db.query("authSessions").collect(),
    );
    expect(sessions).toHaveLength(1);
  });

  // Institution scope on the Slack twin (the same cross-tenant account-takeover
  // door as the in-app issueScholarEnrollLink): a scholar-admin in school A must
  // not be able to mint a PIN link for a scholar in school B and sign in as that
  // child. Platform admins stay global.
  test("issueScholarPinLink: rejects a cross-institution mint", async () => {
    const t = convexTest(schema, modules);
    const instA = await seedInstitution(t, "pin-school-a");
    const instB = await seedInstitution(t, "pin-school-b");
    const registrarA = await seedUser(t, "staff", {
      username: "reg-a",
      institutionId: instA,
    });
    await grantMembership(t, registrarA, "staff", instA);
    await grantOperationsCapability(t, registrarA, instA);
    const scholarB = await seedUser(t, "scholar", {
      username: "scholar-b",
      institutionId: instB,
    });

    const res = await t.run(async (ctx) =>
      ctx.runMutation(internal.slackAdminOps.issueScholarPinLink, {
        callerUserId: registrarA,
        scholarId: scholarB,
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("Forbidden");
    // No token was minted for the out-of-scope scholar.
    const tokens = await t.run(async (ctx) =>
      ctx.db.query("enrollmentTokens").collect(),
    );
    expect(tokens).toHaveLength(0);
  });

  test("issueScholarPinLink: allows a same-institution mint", async () => {
    const t = convexTest(schema, modules);
    const inst = await seedInstitution(t, "pin-same-school");
    const registrar = await seedUser(t, "staff", {
      username: "reg-same",
      institutionId: inst,
    });
    await grantMembership(t, registrar, "staff", inst);
    await grantOperationsCapability(t, registrar, inst);
    const scholar = await seedUser(t, "scholar", {
      username: "scholar-same",
      institutionId: inst,
    });

    const res = await t.run(async (ctx) =>
      ctx.runMutation(internal.slackAdminOps.issueScholarPinLink, {
        callerUserId: registrar,
        scholarId: scholar,
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.url).toContain("/enroll?token=");
  });

  test("issueScholarPinLink: allows a platform admin across institutions", async () => {
    const t = convexTest(schema, modules);
    const instB = await seedInstitution(t, "pin-admin-school-b");
    const admin = await seedUser(t, "platform_admin", { username: "pin-admin" });
    const scholarB = await seedUser(t, "scholar", {
      username: "admin-scholar-b",
      institutionId: instB,
    });

    const res = await t.run(async (ctx) =>
      ctx.runMutation(internal.slackAdminOps.issueScholarPinLink, {
        callerUserId: admin,
        scholarId: scholarB,
      }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.url).toContain("/enroll?token=");
  });
});

describe("slackNotifications", () => {
  async function seedGroup(
    t: ReturnType<typeof convexTest>,
    teacherId: Id<"users">,
    scholarIds: Id<"users">[],
    overrides: {
      name?: string;
      type?: string;
      slackChannelId?: string;
      slackNotifyMode?: "digest" | "immediate";
    } = {},
  ) {
    return await t.run(async (ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId,
        name: overrides.name ?? "Geckos",
        scholarIds,
        type: overrides.type,
        slackChannelId: overrides.slackChannelId,
        slackNotifyMode: overrides.slackNotifyMode,
      }),
    );
  }

  test("linkChannelToGroup: teacher links + unlinks; designer refused", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const designerId = await seedUser(t, "curriculum_designer");
    const scholarId = await seedUser(t, "scholar");
    const groupId = await seedGroup(t, teacherId, [scholarId]);

    const refused = await t.run(async (ctx) =>
      ctx.runMutation(internal.slackNotifications.linkChannelToGroup, {
        callerUserId: designerId,
        groupName: "Geckos",
        slackChannelId: "C111",
        unlink: false,
      }),
    );
    expect(refused.ok).toBe(false);

    const linked = await t.run(async (ctx) =>
      ctx.runMutation(internal.slackNotifications.linkChannelToGroup, {
        callerUserId: teacherId,
        groupName: "geck",
        slackChannelId: "C111",
        unlink: false,
      }),
    );
    expect(linked.ok).toBe(true);
    let group = await t.run(async (ctx) => ctx.db.get(groupId));
    expect(group?.slackChannelId).toBe("C111");

    // Unlinking from the WRONG channel refuses; right channel clears.
    const wrongChannel = await t.run(async (ctx) =>
      ctx.runMutation(internal.slackNotifications.linkChannelToGroup, {
        callerUserId: teacherId,
        groupName: "Geckos",
        slackChannelId: "C222",
        unlink: true,
      }),
    );
    expect(wrongChannel.ok).toBe(false);
    const unlinked = await t.run(async (ctx) =>
      ctx.runMutation(internal.slackNotifications.linkChannelToGroup, {
        callerUserId: teacherId,
        groupName: "Geckos",
        slackChannelId: "C111",
        unlink: true,
      }),
    );
    expect(unlinked.ok).toBe(true);
    group = await t.run(async (ctx) => ctx.db.get(groupId));
    expect(group?.slackChannelId).toBeUndefined();
  });

  test("notifyScholarEvent queues for digest groups, skips unlinked, schedules immediate", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const kai = await seedUser(t, "scholar", { name: "Kai", username: "kai" });
    const lani = await seedUser(t, "scholar", { name: "Lani", username: "lani" });

    await seedGroup(t, teacherId, [kai], { name: "Geckos", slackChannelId: "C-GECKOS" });
    await seedGroup(t, teacherId, [kai], { name: "Unlinked" }); // no channel
    await seedGroup(t, teacherId, [lani], { name: "Honu", slackChannelId: "C-HONU" });

    await t.run(async (ctx) =>
      ctx.runMutation(internal.slackNotifications.notifyScholarEvent, {
        scholarId: kai,
        text: "Kai finished *Weekend News*",
      }),
    );

    const queued = await t.run(async (ctx) =>
      ctx.db.query("slackNotificationQueue").collect(),
    );
    // Only the linked group containing Kai — not Unlinked, not Honu.
    expect(queued).toHaveLength(1);
    expect(queued[0].channelId).toBe("C-GECKOS");
    expect(queued[0].sent).toBe(false);
  });

  test("notifyScholarEvent replaces a matching pending digest row", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const kai = await seedUser(t, "scholar", {
      name: "Kai",
      username: "kai-digest",
    });
    await seedGroup(t, teacherId, [kai], {
      name: "Geckos",
      slackChannelId: "C-GECKOS",
    });

    const notify = async (text: string) =>
      t.run(async (ctx) =>
        ctx.runMutation(internal.slackNotifications.notifyScholarEvent, {
          scholarId: kai,
          text,
          dedupeKey: "deliverable:one",
        }),
      );

    await notify("First draft");
    await notify("Revised draft");

    let queued = await t.run(async (ctx) =>
      ctx.db.query("slackNotificationQueue").collect(),
    );
    expect(queued).toHaveLength(1);
    expect(queued[0].text).toBe("Revised draft");
    expect(queued[0].dedupeKey).toBe("deliverable:one");

    await t.run(async (ctx) =>
      ctx.runMutation(internal.slackNotifications.markSent, {
        ids: [queued[0]._id],
      }),
    );
    await notify("Next digest");

    queued = await t.run(async (ctx) =>
      ctx.db.query("slackNotificationQueue").collect(),
    );
    expect(queued).toHaveLength(2);
    expect(queued.filter((row) => !row.sent)).toHaveLength(1);
    expect(queued.find((row) => !row.sent)?.text).toBe("Next digest");
  });

  test("markSent flips queue rows", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const kai = await seedUser(t, "scholar", { username: "kai2" });
    const groupId = await seedGroup(t, teacherId, [kai], { slackChannelId: "C1" });
    const rowId = await t.run(async (ctx) =>
      ctx.db.insert("slackNotificationQueue", {
        groupId,
        channelId: "C1",
        text: "x",
        sent: false,
      }),
    );
    await t.run(async (ctx) =>
      ctx.runMutation(internal.slackNotifications.markSent, { ids: [rowId] }),
    );
    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row?.sent).toBe(true);
  });
});

describe("slackBot thread bookkeeping", () => {
  test("upsertThread inserts once and bumps activity", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const id1 = await t.run(async (ctx) =>
      ctx.runMutation(internal.slackBot.upsertThread, {
        channelId: "C1",
        threadTs: "111.222",
        startedByUserId: teacherId,
      }),
    );
    const id2 = await t.run(async (ctx) =>
      ctx.runMutation(internal.slackBot.upsertThread, {
        channelId: "C1",
        threadTs: "111.222",
        startedByUserId: teacherId,
      }),
    );
    expect(id1).toBe(id2);
    const found = await t.run(async (ctx) =>
      ctx.runQuery(internal.slackBot.getThread, {
        channelId: "C1",
        threadTs: "111.222",
      }),
    );
    expect(found?._id).toBe(id1);
    const missing = await t.run(async (ctx) =>
      ctx.runQuery(internal.slackBot.getThread, {
        channelId: "C1",
        threadTs: "999.999",
      }),
    );
    expect(missing).toBeNull();
  });
});

describe("scholarDocuments.aideRegisterFromSlack", () => {
  test("teacher attaches; operations staff refused; non-scholar target refused", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const registrarId = await seedUser(t, "staff");
    const scholarId = await seedUser(t, "scholar", { name: "Kai", username: "kai3" });

    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["%PDF-1.4 fake"], { type: "application/pdf" })),
    );

    // Operations staff refused — assessment documents are teacher/admin-only.
    const refused = await t.run(async (ctx) =>
      ctx.runMutation(internal.scholarDocuments.aideRegisterFromSlack, {
        callerUserId: registrarId,
        scholarId,
        storageId,
        kind: "assessment",
        title: "WISC-V",
      }),
    );
    expect(refused.ok).toBe(false);

    // Non-scholar target refused.
    const wrongTarget = await t.run(async (ctx) =>
      ctx.runMutation(internal.scholarDocuments.aideRegisterFromSlack, {
        callerUserId: teacherId,
        scholarId: registrarId,
        storageId,
        kind: "assessment",
        title: "WISC-V",
      }),
    );
    expect(wrongTarget.ok).toBe(false);

    // Teacher → document row + audit log + pipeline scheduled.
    const ok = await t.run(async (ctx) =>
      ctx.runMutation(internal.scholarDocuments.aideRegisterFromSlack, {
        callerUserId: teacherId,
        scholarId,
        storageId,
        kind: "assessment",
        title: "WISC-V Report",
        fileMimeType: "application/pdf",
      }),
    );
    expect(ok.ok).toBe(true);
    const docs = await t.run(async (ctx) =>
      ctx.db.query("scholarDocuments").collect(),
    );
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe("WISC-V Report");
    expect(docs[0].uploadedBy).toBe(teacherId);
    expect(docs[0].processingStatus).toBe("pending");
    const log = await t.run(async (ctx) =>
      ctx.db.query("documentAccessLog").collect(),
    );
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe("upload");
  });
});

describe("thread ↔ chat unification (Phase 2)", () => {
  test("ensureThreadSession creates once, reuses after", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const first = await t.run(async (ctx) =>
      ctx.runMutation(internal.slackBot.ensureThreadSession, {
        channelId: "C1",
        threadTs: "100.1",
        userId: teacherId,
      }),
    );
    const second = await t.run(async (ctx) =>
      ctx.runMutation(internal.slackBot.ensureThreadSession, {
        channelId: "C1",
        threadTs: "100.1",
        userId: teacherId,
      }),
    );
    expect(first.chatId).toBe(second.chatId);

    const session = await t.run(async (ctx) => ctx.db.get(first.chatId));
    expect(session?.teacherId).toBe(teacherId);
    const sessions = await t.run(async (ctx) =>
      ctx.db.query("chats").collect(),
    );
    expect(sessions).toHaveLength(1);
  });

  test("ensureThreadSession attaches a session to a pre-existing thread row and keeps its starter", async () => {
    const t = convexTest(schema, modules);
    const starterId = await seedUser(t, "teacher", { username: "starter" });
    const followerId = await seedUser(t, "teacher", { username: "follower" });
    await t.run(async (ctx) =>
      ctx.runMutation(internal.slackBot.upsertThread, {
        channelId: "C2",
        threadTs: "200.1",
        startedByUserId: starterId,
      }),
    );
    // A FOLLOW-UP from another teacher creates the session — it should be
    // owned by the thread STARTER, not the follower.
    const { chatId } = await t.run(async (ctx) =>
      ctx.runMutation(internal.slackBot.ensureThreadSession, {
        channelId: "C2",
        threadTs: "200.1",
        userId: followerId,
      }),
    );
    const session = await t.run(async (ctx) => ctx.db.get(chatId));
    expect(session?.teacherId).toBe(starterId);
  });

  test("recordExchange persists turns, bumps lastMessageAt, flags first exchange", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { chatId } = await t.run(async (ctx) =>
      ctx.runMutation(internal.slackBot.ensureThreadSession, {
        channelId: "C3",
        threadTs: "300.1",
        userId: teacherId,
      }),
    );

    const first = await t.run(async (ctx) =>
      ctx.runMutation(internal.slackBot.recordExchange, {
        sessionId: chatId,
        userContent: "Lehua: how is Kai?",
        assistantContent: "Kai is thriving.",
        model: "claude-sonnet-4-6",
        tokensUsed: 42,
      }),
    );
    expect(first.firstExchange).toBe(true);

    const second = await t.run(async (ctx) =>
      ctx.runMutation(internal.slackBot.recordExchange, {
        sessionId: chatId,
        userContent: "Avery: and Lani?",
        assistantContent: "Lani too.",
      }),
    );
    expect(second.firstExchange).toBe(false);

    const messages = await t.run(async (ctx) =>
      ctx.db
        .query("curriculumMessages")
        .withIndex("by_chat", (q) => q.eq("chatId", chatId))
        .collect(),
    );
    expect(messages).toHaveLength(4);
    expect(messages[0].content).toBe("Lehua: how is Kai?");
    expect(messages[0].role).toBe("user");
    expect(messages[1].content).toBe("Kai is thriving.");
    expect(messages[1].tokensUsed).toBe(42);
    // All rows are owned by the session owner (attribution lives in the
    // name prefix), so the in-app Chat tab renders them as one thread.
    expect(new Set(messages.map((m) => m.teacherId)).size).toBe(1);
  });
});

describe("notification producers (Phase 3)", () => {
  test("markComplete queues a digest line for linked groups only", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const kai = await seedUser(t, "scholar", { name: "Kai Nakamura", username: "kai9" });

    // Linked group containing Kai + an unlinked one.
    await t.run(async (ctx) => {
      await ctx.db.insert("scholarGroups", {
        teacherId,
        name: "Geckos",
        scholarIds: [kai],
        slackChannelId: "C-GECKOS",
      });
      await ctx.db.insert("scholarGroups", {
        teacherId,
        name: "Unlinked",
        scholarIds: [kai],
      });
    });

    const { unitId, lessonId, activityId } = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Weekend News",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "L1",
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Write your story",
        kind: "online",
        order: 0,
      });
      return { unitId, lessonId, activityId };
    });
    void unitId;
    void lessonId;

    const asKai = await withUser(t, kai);
    await asKai.mutation(api.activityCompletions.markComplete, { activityId });

    const queued = await t.run(async (ctx) =>
      ctx.db.query("slackNotificationQueue").collect(),
    );
    expect(queued).toHaveLength(1);
    expect(queued[0].channelId).toBe("C-GECKOS");
    expect(queued[0].text).toContain("Kai Nakamura");
    expect(queued[0].text).toContain("Write your story");
    expect(queued[0].text).toContain("completed");

    // Re-completing (existing row) does NOT re-notify.
    await asKai.mutation(api.activityCompletions.markComplete, { activityId });
    const after = await t.run(async (ctx) =>
      ctx.db.query("slackNotificationQueue").collect(),
    );
    expect(after).toHaveLength(1);
  });

  test("math assignment completion routes only to the math cohort", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const kai = await seedUser(t, "scholar", {
      name: "Kai Nakamura",
      username: "kai-math",
    });
    const primaryGroupId = await t.run(async (ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId,
        name: "Geckos",
        scholarIds: [kai],
        type: "primary",
        slackChannelId: "C-GECKOS",
      }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId,
        name: "Carl's Math",
        scholarIds: [kai],
        type: "math",
        slackChannelId: "C-MATH",
      }),
    );

    const { activityId, sessionId } = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Fractions",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "L1",
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Fraction Lab",
        kind: "online",
        order: 0,
      });
      const assignmentId = await ctx.db.insert("assignments", {
        teacherId,
        unitId,
        scholarIds: [kai],
        startedAt: Date.now(),
        activitySchedule: [],
      });
      const periodId = await ctx.db.insert("reportingPeriods", {
        label: "Fall",
        startsAt: Date.now() - 1_000,
        endsAt: Date.now() + 1_000,
        status: "open",
      });
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId: primaryGroupId,
        subject: "Math",
        assignmentId,
        activityId,
      });
      const sessionId = await ctx.db.insert("sessions", {
        userId: kai,
        assignmentId,
        unitId,
        lessonId,
        activityId,
        title: "Fraction Lab",
        isArchived: false,
      });
      return { activityId, sessionId };
    });

    const asKai = await withUser(t, kai);
    await asKai.mutation(api.activityCompletions.markComplete, {
      activityId,
      sessionId,
    });

    const queued = await t.run(async (ctx) =>
      ctx.db.query("slackNotificationQueue").collect(),
    );
    expect(queued).toHaveLength(1);
    expect(queued[0].channelId).toBe("C-MATH");
  });

  test("markComplete with no linked groups queues nothing", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const kai = await seedUser(t, "scholar", { username: "kai10" });
    const { activityId } = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "U",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", { unitId, title: "L", order: 0 });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "A",
        kind: "online",
        order: 0,
      });
      return { activityId };
    });
    const asKai = await withUser(t, kai);
    await asKai.mutation(api.activityCompletions.markComplete, { activityId });
    const queued = await t.run(async (ctx) =>
      ctx.db.query("slackNotificationQueue").collect(),
    );
    expect(queued).toHaveLength(0);
  });

  test("flushActivityUpdates replies in today's check-in thread and marks rows sent", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const teacherId = await seedUser(t, "teacher");
    const kai = await seedUser(t, "scholar", {
      username: "kai11",
      institutionId,
    });
    const groupId = await t.run(async (ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId,
        institutionId,
        name: "Geckos",
        scholarIds: [kai],
        slackChannelId: "C-G",
      }),
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("slackNotificationQueue", {
        groupId,
        channelId: "C-G",
        text: "*Kai* completed *A*",
        sent: false,
      });
      await ctx.db.insert("slackNotificationQueue", {
        groupId,
        channelId: "C-G",
        text: "*Kai* submitted *B*",
        sent: false,
      });
      await ctx.db.insert("eodCheckins", {
        channelId: "C-G",
        dateKey: checkinDayKey(Date.now()),
        threadTs: "100.1",
        lifecycle: "completed",
        institutionId,
        groupIds: [groupId],
        postedAt: Date.now(),
      });
    });

    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const posts: Array<{ url: string; body: unknown }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes("conversations.replies")) {
        return new Response(JSON.stringify({ ok: true, messages: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      posts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, ts: "1.2" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      expect(
        await t.action(internal.slackNotifications.flushActivityUpdates, {}),
      ).toEqual({ postedChannels: 1, skippedChannels: 0 });
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(posts).toHaveLength(1);
    const body = posts[0].body as {
      channel: string;
      thread_ts: string;
      markdown_text: string;
      metadata: { event_type: string };
    };
    expect(posts[0].url).toContain("chat.postMessage");
    expect(body.channel).toBe("C-G");
    expect(body.thread_ts).toBe("100.1");
    expect(body.metadata.event_type).toBe("rabbithole_activity_update");
    expect(body.markdown_text).toContain("Activity since the last update");
    expect(body.markdown_text).toContain("• *Kai* completed *A*");
    expect(body.markdown_text).toContain("• *Kai* submitted *B*");

    const rows = await t.run(async (ctx) =>
      ctx.db.query("slackNotificationQueue").collect(),
    );
    expect(rows.every((r) => r.sent)).toBe(true);

    globalThis.fetch = (async () => {
      throw new Error("should not be called");
    }) as typeof fetch;
    try {
      expect(
        await t.action(internal.slackNotifications.flushActivityUpdates, {}),
      ).toEqual({ postedChannels: 0, skippedChannels: 0 });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("flushActivityUpdates keeps rows queued until today's check-in thread exists", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli-no-thread");
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar", {
      username: "queued-scholar",
      institutionId,
    });
    await t.run(async (ctx) => {
      const groupId = await ctx.db.insert("scholarGroups", {
        teacherId,
        institutionId,
        name: "Geckos",
        scholarIds: [scholarId],
        slackChannelId: "C-NO-THREAD",
      });
      await ctx.db.insert("slackNotificationQueue", {
        groupId,
        channelId: "C-NO-THREAD",
        text: "*Queued Scholar* completed *A*",
        sent: false,
      });
    });

    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("should not call Slack without a check-in thread");
    }) as typeof fetch;
    try {
      expect(
        await t.action(internal.slackNotifications.flushActivityUpdates, {}),
      ).toEqual({ postedChannels: 0, skippedChannels: 1 });
    } finally {
      globalThis.fetch = realFetch;
    }
    const rows = await t.run((ctx) =>
      ctx.db.query("slackNotificationQueue").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].sent).toBe(false);
  });

  test("flushActivityUpdates reconciles an ambiguous post without duplicating it", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli-reconcile");
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar", {
      username: "reconcile-scholar",
      institutionId,
    });
    const activeScholarId = await seedUser(t, "scholar", {
      username: "active-reconcile-scholar",
      institutionId,
    });
    const staleGroupId = await t.run(async (ctx) => {
      const staleGroupId = await ctx.db.insert("scholarGroups", {
        teacherId,
        institutionId,
        name: "Geckos",
        scholarIds: [scholarId],
        slackChannelId: "C-RECONCILE",
      });
      await ctx.db.insert("slackNotificationQueue", {
        groupId: staleGroupId,
        channelId: "C-RECONCILE",
        text: "*Reconcile Scholar* submitted *A*",
        sent: false,
      });
      const activeGroupId = await ctx.db.insert("scholarGroups", {
        teacherId,
        institutionId,
        name: "Honu",
        scholarIds: [activeScholarId],
        slackChannelId: "C-RECONCILE",
      });
      await ctx.db.insert("slackNotificationQueue", {
        groupId: activeGroupId,
        channelId: "C-RECONCILE",
        text: "*Active Reconcile Scholar* completed *B*",
        sent: false,
      });
      await ctx.db.insert("eodCheckins", {
        channelId: "C-RECONCILE",
        dateKey: checkinDayKey(Date.now()),
        threadTs: "200.1",
        lifecycle: "completed",
        institutionId,
        groupIds: [staleGroupId, activeGroupId],
        postedAt: Date.now(),
      });
      return staleGroupId;
    });

    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const realFetch = globalThis.fetch;
    let postCalls = 0;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      if (String(url).includes("conversations.replies")) {
        return new Response(JSON.stringify({ ok: true, messages: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      postCalls += 1;
      return new Response(
        JSON.stringify({ ok: false, error: "internal_error" }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;
    try {
      expect(
        await t.action(internal.slackNotifications.flushActivityUpdates, {}),
      ).toEqual({ postedChannels: 0, skippedChannels: 1 });

      const checkin = await t.run((ctx) =>
        ctx.db.query("eodCheckins").unique(),
      );
      const deliveryId = checkin?.activityUpdate?.deliveryId;
      expect(deliveryId).toBeTruthy();
      const activityUpdate = checkin?.activityUpdate;
      if (checkin && activityUpdate) {
        await t.run(async (ctx) => {
          await ctx.db.patch(staleGroupId, {
            slackChannelId: undefined,
          });
          await ctx.db.patch(checkin._id, {
            activityUpdate: {
              ...activityUpdate,
              leaseUntil: Date.now() - 1,
            },
          });
        });
      }

      globalThis.fetch = (async (url: RequestInfo | URL) => {
        if (!String(url).includes("conversations.replies")) {
          postCalls += 1;
          throw new Error("reconciliation should not repost");
        }
        return new Response(
          JSON.stringify({
            ok: true,
            messages: [
              {
                ts: "200.2",
                thread_ts: "200.1",
                metadata: {
                  event_type: "rabbithole_activity_update",
                  event_payload: { delivery_id: deliveryId },
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      }) as typeof fetch;

      expect(
        await t.action(internal.slackNotifications.flushActivityUpdates, {}),
      ).toEqual({ postedChannels: 1, skippedChannels: 0 });
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(postCalls).toBe(1);
    const state = await t.run(async (ctx) => ({
      checkin: await ctx.db.query("eodCheckins").unique(),
      queued: await ctx.db.query("slackNotificationQueue").collect(),
    }));
    expect(state.checkin?.activityUpdate).toBeUndefined();
    expect(state.queued.every((row) => row.sent)).toBe(true);
  });

  test("group delivery revalidation rejects a transferred scholar", async () => {
    const t = convexTest(schema, modules);
    const moli = await seedInstitution(t, "moli");
    const guests = await seedInstitution(t, "guests");
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar", {
      username: "moved-scholar",
      institutionId: moli,
    });
    const groupId = await t.run((ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId,
        institutionId: moli,
        name: "Geckos",
        scholarIds: [scholarId],
        slackChannelId: "C-G",
      }),
    );

    expect(
      await t.query(internal.slackNotifications.groupDeliveryAllowed, {
        groupId,
        channelId: "C-G",
        scholarIds: [scholarId],
      }),
    ).toBe(true);
    await t.run((ctx) => ctx.db.patch(scholarId, { institutionId: guests }));
    expect(
      await t.query(internal.slackNotifications.groupDeliveryAllowed, {
        groupId,
        channelId: "C-G",
        scholarIds: [scholarId],
      }),
    ).toBe(false);
    expect(
      await t.query(internal.slackNotifications.scholarDeliveryAllowed, {
        scholarId,
        institutionId: moli,
      }),
    ).toBe(false);
    expect(
      await t.query(internal.slackNotifications.scholarDeliveryAllowed, {
        scholarId,
        institutionId: guests,
      }),
    ).toBe(true);
  });
});

describe("DM file intake (Phase 4)", () => {
  test("recordSlackFile is idempotent on slackFileId", async () => {
    const t = convexTest(schema, modules);
    const storage1 = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["a"], { type: "application/pdf" })),
    );
    const storage2 = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["b"], { type: "application/pdf" })),
    );
    const first = await t.run(async (ctx) =>
      ctx.runMutation(internal.slackBot.recordSlackFile, {
        slackFileId: "F1",
        storageId: storage1,
        name: "wisc.pdf",
        mimetype: "application/pdf",
      }),
    );
    // Second record with a DIFFERENT storage id keeps the first mapping.
    const second = await t.run(async (ctx) =>
      ctx.runMutation(internal.slackBot.recordSlackFile, {
        slackFileId: "F1",
        storageId: storage2,
      }),
    );
    expect(first).toBe(storage1);
    expect(second).toBe(storage1);
    const rows = await t.run(async (ctx) => ctx.db.query("slackFiles").collect());
    expect(rows).toHaveLength(1);

    const found = await t.run(async (ctx) =>
      ctx.runQuery(internal.slackBot.getSlackFile, { slackFileId: "F1" }),
    );
    expect(found?.storageId).toBe(storage1);
  });
});

describe("event dedupe sweep (cron)", () => {
  test("sweepEvents deletes hour-old rows, keeps fresh ones", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("slackEvents", {
        eventId: "EvOld",
        receivedAt: Date.now() - 2 * 60 * 60 * 1000,
      });
      await ctx.db.insert("slackEvents", {
        eventId: "EvFresh",
        receivedAt: Date.now(),
      });
    });
    await t.run(async (ctx) =>
      ctx.runMutation(internal.slackBot.sweepEvents, {}),
    );
    const rows = await t.run(async (ctx) =>
      ctx.db.query("slackEvents").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].eventId).toBe("EvFresh");
  });
});

// The Agent messaging experience (agent_view) replaced assistant_thread_started
// with app_home_opened(tab:"messages") as the DM-open signal. The handler pins
// suggested prompts every open (idempotent) and greets only on a fresh DM.
describe("app_home_opened DM onboarding (agent_view)", () => {
  function stubSlack(historyMessages: unknown[]) {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = String(url).split("/api/")[1] ?? String(url);
      const raw = String(init?.body ?? "");
      const body = raw.startsWith("{")
        ? (JSON.parse(raw) as Record<string, unknown>)
        : Object.fromEntries(new URLSearchParams(raw));
      calls.push({ method, body });
      if (method === "conversations.history") {
        return new Response(
          JSON.stringify({ ok: true, messages: historyMessages }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true, ts: "1.2" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    return { calls, restore: () => (globalThis.fetch = realFetch) };
  }

  test("fresh DM: greets once + pins suggested prompts", async () => {
    const t = convexTest(schema, modules);
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const { calls, restore } = stubSlack([]);
    try {
      await t.action(internal.slackBot.handleEvent, {
        payload: {
          event_id: "EvHomeFresh",
          event: { type: "app_home_opened", tab: "messages", channel: "D1", user: "U1" },
        },
      });
    } finally {
      restore();
      delete process.env.SLACK_BOT_TOKEN;
    }
    const prompts = calls.find((c) => c.method === "assistant.threads.setSuggestedPrompts");
    expect(prompts?.body).toMatchObject({ channel_id: "D1" });
    expect(prompts?.body.thread_ts).toBeUndefined();
    const greeting = calls.find((c) => c.method === "chat.postMessage");
    expect(greeting?.body.channel).toBe("D1");
    expect(String(greeting?.body.text)).toContain("Aloha");
  });

  test("returning DM: pins prompts but does NOT greet again", async () => {
    const t = convexTest(schema, modules);
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const { calls, restore } = stubSlack([{ ts: "9.9", text: "hi" }]);
    try {
      await t.action(internal.slackBot.handleEvent, {
        payload: {
          event_id: "EvHomeReturning",
          event: { type: "app_home_opened", tab: "messages", channel: "D1", user: "U1" },
        },
      });
    } finally {
      restore();
      delete process.env.SLACK_BOT_TOKEN;
    }
    expect(calls.some((c) => c.method === "assistant.threads.setSuggestedPrompts")).toBe(true);
    expect(calls.some((c) => c.method === "chat.postMessage")).toBe(false);
  });

  test("home tab open is ignored (not the Messages tab)", async () => {
    const t = convexTest(schema, modules);
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const { calls, restore } = stubSlack([]);
    try {
      await t.action(internal.slackBot.handleEvent, {
        payload: {
          event_id: "EvHomeTab",
          event: { type: "app_home_opened", tab: "home", channel: "D1", user: "U1" },
        },
      });
    } finally {
      restore();
      delete process.env.SLACK_BOT_TOKEN;
    }
    expect(calls).toHaveLength(0);
  });
});

// ── Attachment byte budget (#909) ──────────────────────────────────────────
// A PDF shared into two messages was budgeted once but emitted per-occurrence,
// and images had no aggregate cap at all — so a request could blow past
// Anthropic's ~32MB ceiling and hard-400 instead of degrading gracefully.
describe("Slack attachment byte budget (#909)", () => {
  const BOT = "U0BOT";
  const NAMES = new Map([["U1", "Lehua"]]);
  const TOKEN = "xoxb-test";
  const MB = 1024 * 1024;

  /** Bytes that pass isPdfBytes (leading `%PDF`), padded to `n` bytes. */
  function pdfBytes(n: number): Uint8Array {
    const b = new Uint8Array(n);
    b[0] = 0x25; // %
    b[1] = 0x50; // P
    b[2] = 0x44; // D
    b[3] = 0x46; // F
    return b;
  }
  /** Bytes that detectImageMime reads as PNG (0x89 0x50), padded to `n`. */
  function pngBytes(n: number): Uint8Array {
    const b = new Uint8Array(n);
    b[0] = 0x89;
    b[1] = 0x50;
    return b;
  }

  /** Stub downloadSlackFile's fetch: map url_private_download → raw bytes. */
  function stubDownloads(payloads: Map<string, Uint8Array>) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const bytes = payloads.get(String(url));
      if (!bytes) return new Response(null, { status: 404 });
      return new Response(bytes.buffer as ArrayBuffer, { status: 200 });
    }) as typeof fetch;
    return () => {
      globalThis.fetch = realFetch;
    };
  }

  type Blocks = Exclude<TranscriptContent, string>;

  // ── Part 1: buildSlackTranscript emits each document id at most once ──────
  test("a PDF shared into two messages yields ONE base64 document block, the 2nd a descriptor", () => {
    const turns = buildSlackTranscript({
      messages: [
        {
          ts: "1",
          user: "U1",
          text: "here's the assessment",
          subtype: "file_share",
          files: [{ id: "F1", name: "wisc.pdf", mimetype: "application/pdf" }],
        },
        {
          ts: "2",
          user: "U1",
          text: "re-sharing for reference",
          subtype: "file_share",
          files: [{ id: "F1", name: "wisc.pdf", mimetype: "application/pdf" }],
        },
      ],
      botUserId: BOT,
      names: NAMES,
      documents: new Map([["F1", { dataBase64: "JVBERi0x", name: "wisc.pdf" }]]),
    });
    // Same author → merged into one user turn carrying the media.
    expect(turns).toHaveLength(1);
    const content = turns[0].content as Blocks;
    const docBlocks = content.filter((b) => b.type === "document");
    expect(docBlocks).toHaveLength(1); // emitted ONCE, not twice
    const textBlock = content.find((b) => b.type === "text") as { text: string };
    expect(textBlock.text).toContain("[attached PDF: wisc.pdf]"); // 1st: inline
    expect(textBlock.text).toContain("slackFileId=F1"); // 2nd: text descriptor
  });

  test("two DISTINCT PDFs are unaffected — each still emits its own document block", () => {
    const turns = buildSlackTranscript({
      messages: [
        {
          ts: "1",
          user: "U1",
          text: "form A",
          subtype: "file_share",
          files: [{ id: "F1", name: "a.pdf", mimetype: "application/pdf" }],
        },
        {
          ts: "2",
          user: "U1",
          text: "form B",
          subtype: "file_share",
          files: [{ id: "F2", name: "b.pdf", mimetype: "application/pdf" }],
        },
      ],
      botUserId: BOT,
      names: NAMES,
      documents: new Map([
        ["F1", { dataBase64: "AA", name: "a.pdf" }],
        ["F2", { dataBase64: "BB", name: "b.pdf" }],
      ]),
    });
    const content = turns[0].content as Blocks;
    expect(content.filter((b) => b.type === "document")).toHaveLength(2);
  });

  // ── Part 2: images + docs share one raw-byte ceiling ──────────────────────
  test("collectThreadImages reports bytesUsed and stops at the shared byte budget", async () => {
    const u1 = "https://files.slack/i1";
    const u2 = "https://files.slack/i2";
    const restore = stubDownloads(
      new Map([
        [u1, pngBytes(2 * MB)],
        [u2, pngBytes(2 * MB)],
      ]),
    );
    try {
      const thread: SlackMessage[] = [
        {
          ts: "1",
          user: "U1",
          subtype: "file_share",
          files: [
            { id: "I1", name: "one.png", mimetype: "image/png", size: 2 * MB, url_private_download: u1 },
            { id: "I2", name: "two.png", mimetype: "image/png", size: 2 * MB, url_private_download: u2 },
          ],
        },
      ];
      const full = await collectThreadImages(TOKEN, thread);
      expect(full.images.size).toBe(2);
      expect(full.bytesUsed).toBe(4 * MB);
      // A tight shared budget admits only the first image; the 2nd is skipped.
      const tight = await collectThreadImages(TOKEN, thread, 3 * MB);
      expect(tight.images.size).toBe(1);
      expect(tight.bytesUsed).toBe(2 * MB);
    } finally {
      restore();
    }
  });

  test("collectThreadDocuments budgets against the REMAINING allowance", async () => {
    const url = "https://files.slack/d1";
    const restore = stubDownloads(new Map([[url, pdfBytes(6 * MB)]]));
    try {
      const thread: SlackMessage[] = [
        {
          ts: "1",
          user: "U1",
          subtype: "file_share",
          files: [
            { id: "D1", name: "report.pdf", mimetype: "application/pdf", size: 6 * MB, url_private_download: url },
          ],
        },
      ];
      // Ample remaining allowance → inlined.
      expect((await collectThreadDocuments(TOKEN, thread, 20 * MB)).size).toBe(1);
      // Only 5MB left (images spent the rest) → the 6MB PDF no longer fits.
      expect((await collectThreadDocuments(TOKEN, thread, 5 * MB)).size).toBe(0);
    } finally {
      restore();
    }
  });

  test("images + a PDF over the shared ceiling degrade the PDF to a descriptor (end-to-end)", async () => {
    // 3 images @ 4MB = 12MB (all inline). The PDF is 14MB — UNDER the 15MB
    // per-file cap, but the shared ceiling leaves only 24-12 = 12MB, so it is
    // skipped rather than pushing the request over Anthropic's byte limit.
    const imgUrls = ["u/i1", "u/i2", "u/i3"];
    const docUrl = "u/d1";
    const payloads = new Map<string, Uint8Array>();
    imgUrls.forEach((u) => payloads.set(u, pngBytes(4 * MB)));
    payloads.set(docUrl, pdfBytes(14 * MB));
    const restore = stubDownloads(payloads);
    try {
      const thread: SlackMessage[] = [
        {
          ts: "1",
          user: "U1",
          text: "look at these",
          subtype: "file_share",
          files: [
            ...imgUrls.map((u, i) => ({
              id: `I${i}`,
              name: `i${i}.png`,
              mimetype: "image/png",
              size: 4 * MB,
              url_private_download: u,
            })),
            { id: "D1", name: "big.pdf", mimetype: "application/pdf", size: 14 * MB, url_private_download: docUrl },
          ],
        },
      ];
      const imgRes = await collectThreadImages(TOKEN, thread);
      expect(imgRes.images.size).toBe(3);
      expect(imgRes.bytesUsed).toBe(12 * MB);
      // Thread the running total exactly like handleEvent does.
      const documents = await collectThreadDocuments(
        TOKEN,
        thread,
        MAX_TOTAL_ATTACHMENT_BYTES - imgRes.bytesUsed,
      );
      expect(documents.size).toBe(0); // over the joint ceiling → not inlined

      const turns = buildSlackTranscript({
        messages: thread,
        botUserId: BOT,
        names: NAMES,
        images: imgRes.images,
        documents,
      });
      const content = turns[0].content as Blocks;
      expect(content.filter((b) => b.type === "image")).toHaveLength(3);
      expect(content.filter((b) => b.type === "document")).toHaveLength(0);
      const textBlock = content.find((b) => b.type === "text") as { text: string };
      expect(textBlock.text).toContain("slackFileId=D1"); // PDF left as descriptor
    } finally {
      restore();
    }
  });
});

// ── Oversized-image downscaling (blind-on-a-screenshot fix) ─────────────────
describe("Slack oversized-image downscaling", () => {
  const TOKEN = "xoxb-test";
  const MB = 1024 * 1024;
  const SHRUNK = "A".repeat(400_000); // stand-in for a downscaled JPEG's base64

  /** Bytes detectImageMime reads as PNG (0x89 0x50), padded to `n`. */
  function pngBytes(n: number): Uint8Array {
    const b = new Uint8Array(n);
    b[0] = 0x89;
    b[1] = 0x50;
    return b;
  }
  function stubDownloads(payloads: Map<string, Uint8Array>) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const bytes = payloads.get(String(url));
      if (!bytes) return new Response(null, { status: 404 });
      return new Response(bytes.buffer as ArrayBuffer, { status: 200 });
    }) as typeof fetch;
    return () => {
      globalThis.fetch = realFetch;
    };
  }

  test("an image over the per-image cap is downscaled via the normalizer, not dropped", async () => {
    const url = "https://files.slack/big";
    const normalize = vi.fn(async () => ({
      mediaType: "image/jpeg" as const,
      dataBase64: SHRUNK,
    }));
    const thread: SlackMessage[] = [
      {
        ts: "1",
        user: "U1",
        subtype: "file_share",
        files: [
          {
            id: "B1",
            name: "IMG_2914.jpg",
            mimetype: "image/jpeg",
            size: 7 * MB, // declared over Anthropic's 5MB cap
            url_private_download: url,
          },
        ],
      },
    ];
    // Over-cap files go straight to the normalizer by URL — the full source is
    // never pulled into this action, so no fetch stub is needed.
    const res = await collectThreadImages(
      TOKEN,
      thread,
      MAX_TOTAL_ATTACHMENT_BYTES,
      normalize,
    );
    expect(normalize).toHaveBeenCalledWith({ url });
    expect(res.images.size).toBe(1);
    expect(res.images.get("B1")).toEqual({
      mediaType: "image/jpeg",
      dataBase64: SHRUNK,
    });
    expect(res.bytesUsed).toBe(Math.floor((SHRUNK.length * 3) / 4));
  });

  test("an oversized image with no normalizer wired is left out (descriptor fallback)", async () => {
    const thread: SlackMessage[] = [
      {
        ts: "1",
        user: "U1",
        subtype: "file_share",
        files: [
          {
            id: "B1",
            name: "IMG.jpg",
            mimetype: "image/jpeg",
            size: 7 * MB,
            url_private_download: "https://files.slack/x",
          },
        ],
      },
    ];
    const res = await collectThreadImages(TOKEN, thread);
    expect(res.images.size).toBe(0);
    expect(res.bytesUsed).toBe(0);
  });

  test("a small-declared image whose actual bytes are oversized is still downscaled", async () => {
    const url = "https://files.slack/liar";
    const restore = stubDownloads(new Map([[url, pngBytes(7 * MB)]]));
    const normalize = vi.fn(async () => ({
      mediaType: "image/jpeg" as const,
      dataBase64: SHRUNK,
    }));
    try {
      const thread: SlackMessage[] = [
        {
          ts: "1",
          user: "U1",
          subtype: "file_share",
          files: [
            {
              id: "B1",
              name: "IMG.png",
              mimetype: "image/png",
              size: 1 * MB, // Slack under-reports; real bytes are 7MB
              url_private_download: url,
            },
          ],
        },
      ];
      const res = await collectThreadImages(
        TOKEN,
        thread,
        MAX_TOTAL_ATTACHMENT_BYTES,
        normalize,
      );
      expect(normalize).toHaveBeenCalledWith({ url });
      expect(res.images.get("B1")?.mediaType).toBe("image/jpeg");
      expect(res.bytesUsed).toBe(Math.floor((SHRUNK.length * 3) / 4));
    } finally {
      restore();
    }
  });

  test("an image beyond the downscale source ceiling is skipped without invoking the normalizer", async () => {
    const normalize = vi.fn(async () => ({
      mediaType: "image/jpeg" as const,
      dataBase64: "A",
    }));
    const thread: SlackMessage[] = [
      {
        ts: "1",
        user: "U1",
        subtype: "file_share",
        files: [
          {
            id: "B1",
            name: "HUGE.jpg",
            mimetype: "image/jpeg",
            size: 20 * MB, // beyond NORMALIZE_MAX_SOURCE_BYTES (12MB)
            url_private_download: "https://files.slack/huge",
          },
        ],
      },
    ];
    const res = await collectThreadImages(
      TOKEN,
      thread,
      MAX_TOTAL_ATTACHMENT_BYTES,
      normalize,
    );
    expect(res.images.size).toBe(0);
    expect(normalize).not.toHaveBeenCalled();
  });

  test("undownscalable images ahead of a small one don't crowd it out of the inline slots", async () => {
    // MAX_INLINE_IMAGES worth of undownscalable (>12MB) images precede a small,
    // inlineable screenshot. The slot cap counts SUCCESSES, so the small image
    // is still reached and shown — the old pre-slice would have dropped it.
    const smallUrl = "https://files.slack/small";
    const restore = stubDownloads(new Map([[smallUrl, pngBytes(1 * MB)]]));
    try {
      const huge = Array.from({ length: 8 }, (_v, i) => ({
        id: `H${i}`,
        name: `huge${i}.jpg`,
        mimetype: "image/jpeg",
        size: 20 * MB, // >12MB → undownscalable, collected as nothing
        url_private_download: `https://files.slack/h${i}`,
      }));
      const thread: SlackMessage[] = [
        {
          ts: "1",
          user: "U1",
          subtype: "file_share",
          files: [
            ...huge,
            {
              id: "S1",
              name: "screenshot.png",
              mimetype: "image/png",
              size: 1 * MB,
              url_private_download: smallUrl,
            },
          ],
        },
      ];
      const res = await collectThreadImages(TOKEN, thread);
      expect(res.images.has("S1")).toBe(true);
      expect(res.images.size).toBe(1);
    } finally {
      restore();
    }
  });
});

// ── Parsed (non-PDF) document attachments ────────────────────────────────────
// The Slack surface reuses the in-app aide's upload machinery
// (classifyAideUpload + extractDirectText) so a .docx/.rtf/.txt someone drops in
// a thread is READ, not just described. These cover the real parse paths.
describe("collectThreadTextDocuments", () => {
  const TOKEN = "xoxb-test";

  /** Stub downloadSlackFile's fetch: map url_private_download → raw bytes. */
  function stubDownloads(payloads: Map<string, Uint8Array>) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const bytes = payloads.get(String(url));
      if (!bytes) return new Response(null, { status: 404 });
      return new Response(bytes.buffer as ArrayBuffer, { status: 200 });
    }) as typeof fetch;
    return () => {
      globalThis.fetch = realFetch;
    };
  }

  /** A REAL .docx (zip + central directory + EOCD, deflated) so the test
   *  exercises the actual central-directory reader and pure-JS inflate that
   *  production uses in the Convex isolate. */
  function makeDocx(documentXml: string): Uint8Array {
    const name = Buffer.from("word/document.xml", "ascii");
    const uncompressed = Buffer.from(documentXml, "utf-8");
    const compressed = deflateRawSync(uncompressed);
    const method = 8;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt32LE(compressed.length, 18);
    lfh.writeUInt32LE(uncompressed.length, 22);
    lfh.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([lfh, name, compressed]);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt32LE(compressed.length, 20);
    cdh.writeUInt32LE(uncompressed.length, 24);
    cdh.writeUInt16LE(name.length, 28);
    cdh.writeUInt32LE(0, 42);
    const central = Buffer.concat([cdh, name]);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length, 12);
    eocd.writeUInt32LE(local.length, 16);

    return new Uint8Array(Buffer.concat([local, central, eocd]));
  }

  test("extracts real text from a .docx attachment", async () => {
    const url = "https://files.slack/draft";
    const docx = makeDocx(
      `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>` +
        `<w:p><w:r><w:t>Mangrove </w:t></w:r><w:r><w:t>unit plan</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>Week &amp; one</w:t></w:r></w:p>` +
        `</w:body></w:document>`,
    );
    const restore = stubDownloads(new Map([[url, docx]]));
    try {
      const thread: SlackMessage[] = [
        {
          ts: "1",
          user: "U1",
          subtype: "file_share",
          files: [
            {
              id: "T1",
              name: "draft.docx",
              mimetype:
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              size: 2048,
              url_private_download: url,
            },
          ],
        },
      ];
      const texts = await collectThreadTextDocuments(TOKEN, thread);
      expect(texts.size).toBe(1);
      // Real extraction: runs merge, entities decode.
      expect(texts.get("T1")!.text).toContain("Mangrove unit plan");
      expect(texts.get("T1")!.text).toContain("Week & one");
    } finally {
      restore();
    }
  });

  test("extracts a plain-text file, and a CSV via the same text path", async () => {
    const txtUrl = "https://files.slack/notes";
    const csvUrl = "https://files.slack/roster";
    const restore = stubDownloads(
      new Map([
        [txtUrl, new TextEncoder().encode("line one\nline two")],
        [csvUrl, new TextEncoder().encode("name,grade\nKai,4")],
      ]),
    );
    try {
      const thread: SlackMessage[] = [
        {
          ts: "1",
          user: "U1",
          subtype: "file_share",
          files: [
            { id: "T1", name: "notes.txt", mimetype: "text/plain", size: 20, url_private_download: txtUrl },
            { id: "T2", name: "roster.csv", mimetype: "text/csv", size: 20, url_private_download: csvUrl },
          ],
        },
      ];
      const texts = await collectThreadTextDocuments(TOKEN, thread);
      expect(texts.get("T1")!.text).toContain("line two");
      expect(texts.get("T2")!.text).toContain("Kai,4");
    } finally {
      restore();
    }
  });

  test("strips RTF control words rather than dumping raw markup", async () => {
    const url = "https://files.slack/memo";
    const rtf = new TextEncoder().encode(
      String.raw`{\rtf1\ansi{\fonttbl\f0 Arial;}\f0 Hello \b bold\b0  world\par}`,
    );
    const restore = stubDownloads(new Map([[url, rtf]]));
    try {
      const thread: SlackMessage[] = [
        {
          ts: "1",
          user: "U1",
          subtype: "file_share",
          files: [
            { id: "T1", name: "memo.rtf", mimetype: "application/rtf", size: 100, url_private_download: url },
          ],
        },
      ];
      const texts = await collectThreadTextDocuments(TOKEN, thread);
      expect(texts.get("T1")!.text).toContain("Hello bold world");
      expect(texts.get("T1")!.text).not.toContain("rtf1");
    } finally {
      restore();
    }
  });

  test("ignores PDFs and images — those are inlined as bytes elsewhere", async () => {
    const restore = stubDownloads(new Map());
    try {
      const thread: SlackMessage[] = [
        {
          ts: "1",
          user: "U1",
          subtype: "file_share",
          files: [
            { id: "P1", name: "form.pdf", mimetype: "application/pdf", size: 100, url_private_download: "u/p" },
            { id: "I1", name: "shot.png", mimetype: "image/png", size: 100, url_private_download: "u/i" },
          ],
        },
      ];
      expect((await collectThreadTextDocuments(TOKEN, thread)).size).toBe(0);
    } finally {
      restore();
    }
  });

  test("classifies by FILENAME when Slack's declared mimetype is wrong/missing", async () => {
    // Slack frequently reports application/octet-stream for uploads.
    const url = "https://files.slack/mystery";
    const restore = stubDownloads(
      new Map([[url, new TextEncoder().encode("recovered contents")]]),
    );
    try {
      const thread: SlackMessage[] = [
        {
          ts: "1",
          user: "U1",
          subtype: "file_share",
          files: [
            {
              id: "T1",
              name: "agenda.md",
              mimetype: "application/octet-stream",
              size: 30,
              url_private_download: url,
            },
          ],
        },
      ];
      const texts = await collectThreadTextDocuments(TOKEN, thread);
      expect(texts.get("T1")!.text).toContain("recovered contents");
    } finally {
      restore();
    }
  });

  test("a corrupt .docx is skipped, not thrown — the reply must survive", async () => {
    const url = "https://files.slack/corrupt";
    const restore = stubDownloads(
      new Map([[url, new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01])]]),
    );
    try {
      const thread: SlackMessage[] = [
        {
          ts: "1",
          user: "U1",
          subtype: "file_share",
          files: [
            {
              id: "T1",
              name: "broken.docx",
              mimetype:
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              size: 6,
              url_private_download: url,
            },
          ],
        },
      ];
      await expect(
        collectThreadTextDocuments(TOKEN, thread),
      ).resolves.toHaveProperty("size", 0);
    } finally {
      restore();
    }
  });

  test("a download failure leaves the file as a descriptor", async () => {
    const restore = stubDownloads(new Map()); // every fetch 404s
    try {
      const thread: SlackMessage[] = [
        {
          ts: "1",
          user: "U1",
          subtype: "file_share",
          files: [
            { id: "T1", name: "notes.txt", mimetype: "text/plain", size: 10, url_private_download: "u/gone" },
          ],
        },
      ];
      expect((await collectThreadTextDocuments(TOKEN, thread)).size).toBe(0);
    } finally {
      restore();
    }
  });

  test("an oversized file is skipped before download", async () => {
    const restore = stubDownloads(new Map());
    try {
      const thread: SlackMessage[] = [
        {
          ts: "1",
          user: "U1",
          subtype: "file_share",
          files: [
            {
              id: "T1",
              name: "huge.docx",
              mimetype:
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              size: 50 * 1024 * 1024,
              url_private_download: "u/huge",
            },
          ],
        },
      ];
      expect((await collectThreadTextDocuments(TOKEN, thread)).size).toBe(0);
    } finally {
      restore();
    }
  });

  test("truncates a novel-length document so it can't crowd out the thread", async () => {
    const url = "https://files.slack/novel";
    const restore = stubDownloads(
      new Map([[url, new TextEncoder().encode("x".repeat(250_000))]]),
    );
    try {
      const thread: SlackMessage[] = [
        {
          ts: "1",
          user: "U1",
          subtype: "file_share",
          files: [
            { id: "T1", name: "novel.txt", mimetype: "text/plain", size: 250_000, url_private_download: url },
          ],
        },
      ];
      const text = (await collectThreadTextDocuments(TOKEN, thread)).get("T1")!.text;
      expect(text.length).toBeLessThan(120_000);
      expect(text.endsWith("…[truncated]")).toBe(true);
    } finally {
      restore();
    }
  });

  test("collects a repeated file once and caps how many it parses", async () => {
    const payloads = new Map<string, Uint8Array>();
    const files = Array.from({ length: 8 }, (_, i) => {
      const url = `u/t${i}`;
      payloads.set(url, new TextEncoder().encode(`body ${i}`));
      return { id: `T${i}`, name: `n${i}.txt`, mimetype: "text/plain", size: 10, url_private_download: url };
    });
    const restore = stubDownloads(payloads);
    try {
      const thread: SlackMessage[] = [
        { ts: "1", user: "U1", subtype: "file_share", files },
        // The same file re-shared later must not be parsed twice.
        { ts: "2", user: "U1", subtype: "file_share", files: [files[0]] },
      ];
      const texts = await collectThreadTextDocuments(TOKEN, thread);
      expect(texts.size).toBe(5); // MAX_INLINE_TEXT_DOCS
      expect(texts.get("T0")!.text).toBe("body 0");
    } finally {
      restore();
    }
  });
});

describe("resolveDriveLinks", () => {
  const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";
  const LINK = `https://docs.google.com/document/d/${ID}/edit`;
  const USER = "user_1" as Id<"users">;
  const FRESH = Date.now() + 3_600_000;

  /** ctx whose only query is googleAccounts.getForUserInternal. */
  const ctxFor = (acct: unknown) =>
    ({
      runQuery: async () => acct,
      runMutation: async () => undefined,
    }) as unknown as Parameters<typeof resolveDriveLinks>[0];

  const LINKED = {
    email: "lehua@moli.school",
    accessToken: "tok",
    expiresAt: FRESH,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  };

  const stubFetch = (handler: (url: string) => Response) => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) =>
      handler(String(input)),
    ) as unknown as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  };

  test("no Drive link in the text is a no-op (no token work at all)", async () => {
    const runQuery = vi.fn();
    const ctx = { runQuery } as unknown as Parameters<
      typeof resolveDriveLinks
    >[0];
    expect(await resolveDriveLinks(ctx, USER, "just a normal message")).toBe("");
    expect(runQuery).not.toHaveBeenCalled();
  });

  test("unlinked account relays the reconnect link, markup intact", async () => {
    const out = await resolveDriveLinks(ctxFor(null), USER, `see ${LINK}`);
    expect(out).toMatch(/<https?:\/\/[^|]+\/connect-google[^|]*\|Connect Google Drive>/);
    // The model must be told to preserve the markup, or it renders as prose.
    expect(out).toContain("keeping the link markup exactly as written");
  });

  // A 404 used to be reported flatly as "isn't shared with you", which sent
  // people chasing access they already had when the model had simply invented
  // the URL. It has to leave both explanations open and prefer re-searching.
  test("an unreachable file doesn't get blamed on permissions", async () => {
    const restore = stubFetch(() => new Response("no", { status: 404 }));
    try {
      const out = await resolveDriveLinks(ctxFor(LINKED), USER, LINK);
      expect(out).toContain("lehua@moli.school");
      expect(out).toContain("search_drive");
      expect(out).not.toMatch(/isn't shared with lehua@moli.school\./);
      expect(out).not.toContain("Resolved a Google Drive link");
    } finally {
      restore();
    }
  });

  test("a readable Doc is folded in with its text", async () => {
    const restore = stubFetch((url) =>
      url.includes("/export")
        ? new Response("The whole draft.")
        : new Response(
            JSON.stringify({
              id: ID,
              name: "Unit Plan",
              mimeType: "application/vnd.google-apps.document",
            }),
            { headers: { "content-type": "application/json" } },
          ),
    );
    try {
      const out = await resolveDriveLinks(ctxFor(LINKED), USER, `read ${LINK}`);
      expect(out).toContain("Resolved a Google Drive link");
      expect(out).toContain("Unit Plan");
      expect(out).toContain("The whole draft.");
      // Attribution matters: the reader is the ASKER, not the bot.
      expect(out).toContain("lehua@moli.school");
    } finally {
      restore();
    }
  });

  test("an unreadable file names the file and the reason", async () => {
    const restore = stubFetch((url) =>
      url.includes("alt=media")
        ? new Response("x")
        : new Response(
            JSON.stringify({
              id: ID,
              name: "scan.pdf",
              mimeType: "application/pdf",
            }),
            { headers: { "content-type": "application/json" } },
          ),
    );
    try {
      const out = await resolveDriveLinks(ctxFor(LINKED), USER, LINK);
      expect(out).toContain("scan.pdf");
      expect(out).toContain("attached in Slack");
    } finally {
      restore();
    }
  });
});

// Prod 2026-07-25 (Andy): during a 5-call `create_event_draft` run in
// #marketing-studio the bot showed NOTHING for a full minute — the "✓ …" row
// only appeared after the run finished, so it looked hung. `setStatus` is
// DM-only, so in a channel this context block is the only live signal there is.
describe("buildToolContext live progress", () => {
  test("renders a running group as ⋯ + the running label", () => {
    const text = buildToolContext([
      { name: "create_event_draft", status: "running" },
      { name: "create_event_draft", status: "running" },
    ]);
    expect(text.startsWith("⋯")).toBe(true);
    expect(text).toContain("Creating");
    expect(text).toContain("(2)");
  });

  test("settles to ✓ + the done label once every call completes", () => {
    const text = buildToolContext([
      { name: "create_event_draft", status: "complete", result: "ok" },
      { name: "create_event_draft", status: "complete", result: "ok" },
    ]);
    expect(text.startsWith("✓")).toBe(true);
    expect(text).toContain("Created");
    expect(text).toContain("2");
  });

  test("a still-running group stays ⋯ while earlier finished groups show ✓", () => {
    const lines = buildToolContext([
      { name: "list_events", status: "complete", result: "ok" },
      { name: "create_event_draft", status: "running" },
    ]).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith("✓")).toBe(true);
    expect(lines[1].startsWith("⋯")).toBe(true);
  });

  test("no tools renders nothing (never posts an empty block)", () => {
    expect(buildToolContext([])).toBe("");
  });

  test("a single failing call renders ⚠, names the tool, and shows the stripped reason", () => {
    const text = buildToolContext([
      {
        name: "dispatch_implementation",
        status: "complete",
        result: "Failed: daily dispatch cap reached",
      },
    ]);
    expect(text.startsWith("⚠")).toBe(true);
    // Friendly tool name (friendlyToolName lowercases unmapped ids), not the raw
    // id, and the reason with `Failed:` stripped.
    expect(text).toContain("dispatch implementation");
    expect(text).toContain("daily dispatch cap reached");
    expect(text).not.toContain("Failed:");
    // Two-space gap after the mark, matching the ✓/⋯ lines.
    expect(text.startsWith("⚠  ")).toBe(true);
  });

  test("an 'Error: …' result is classified as a failure too", () => {
    const text = buildToolContext([
      { name: "read_repo_file", status: "complete", result: "Error: file not found" },
    ]);
    expect(text.startsWith("⚠")).toBe(true);
    expect(text).toContain("file not found");
    expect(text).not.toContain("Error:");
  });

  test("a partly-failed group keeps its done label and says how many failed", () => {
    const text = buildToolContext([
      { name: "create_lesson", status: "complete", result: "Created lesson A" },
      { name: "create_lesson", status: "complete", result: "Failed: boom" },
      { name: "create_lesson", status: "complete", result: "Created lesson C" },
    ]);
    expect(text.startsWith("⚠")).toBe(true);
    expect(text).toContain("(1 of 3 failed)");
    // Keeps the counted-noun done label rather than discarding the count — the
    // two calls that landed really did create lessons.
    expect(text).toContain("3 lessons");
  });

  test("a wholly-failed group never asserts the work happened", () => {
    const text = buildToolContext([
      { name: "create_lesson", status: "complete", result: "Failed: boom" },
      { name: "create_lesson", status: "complete", result: "Failed: boom" },
    ]);
    expect(text.startsWith("⚠")).toBe(true);
    // "Created 2 lessons" would be a lie when both calls failed.
    expect(text).not.toContain("Created");
    expect(text).toContain("(2)");
    expect(text).toContain("boom");
  });

  test("an all-success group still renders ✓ and a still-running group still renders ⋯", () => {
    expect(
      buildToolContext([
        { name: "create_lesson", status: "complete", result: "Created lesson A" },
      ]).startsWith("✓"),
    ).toBe(true);
    expect(
      buildToolContext([{ name: "create_lesson", status: "running" }]).startsWith("⋯"),
    ).toBe(true);
  });

  test("the exact prod symptom settles instead of sticking on ⋯", () => {
    // A dispatch_implementation that never emitted toolComplete: left `running`,
    // the block would freeze on "⋯ dispatch implementation…" forever.
    const log: ToolActivity[] = [
      { name: "dispatch_implementation", status: "running" },
    ];
    expect(buildToolContext(log).startsWith("⋯")).toBe(true);
    settleRunningToolActivity(log);
    const settled = buildToolContext(log);
    expect(settled.startsWith("⚠")).toBe(true);
    expect(settled).toContain("dispatch implementation");
  });
});

describe("settleRunningToolActivity", () => {
  test("settles running entries to complete with the unreported result", () => {
    const tools: ToolActivity[] = [
      { name: "dispatch_implementation", status: "running" },
    ];
    const changed = settleRunningToolActivity(tools);
    expect(changed).toBe(true);
    expect(tools[0].status).toBe("complete");
    expect(tools[0].result).toBe(UNREPORTED_TOOL_RESULT);
  });

  test("leaves already-complete entries and their results untouched", () => {
    const tools: ToolActivity[] = [
      { name: "create_lesson", status: "complete", result: "Created lesson A" },
      { name: "dispatch_implementation", status: "running" },
    ];
    settleRunningToolActivity(tools);
    expect(tools[0]).toEqual({
      name: "create_lesson",
      status: "complete",
      result: "Created lesson A",
    });
    expect(tools[1].status).toBe("complete");
    expect(tools[1].result).toBe(UNREPORTED_TOOL_RESULT);
  });

  test("no-ops and returns false on an already-settled list", () => {
    const tools: ToolActivity[] = [
      { name: "create_lesson", status: "complete", result: "Created lesson A" },
    ];
    expect(settleRunningToolActivity(tools)).toBe(false);
    expect(tools[0].result).toBe("Created lesson A");
  });
});

// ── Workshop-idea thread replies ────────────────────────────────────────
// A plain reply under a `postWorkshopIdea` notification has no `slackThreads`
// row, so before this branch existed it fell through to the getThread bail and
// vanished with no reaction, no notice and no log — the scholar never heard
// back. See convex/slackBot.ts → handleWorkshopIdeaThreadReply.
describe("workshop idea thread replies", () => {
  const WORKSHOP_CHANNEL = "C_WORKSHOP";

  async function seedWorkshopIdea(t: ReturnType<typeof convexTest>) {
    return await t.run(async (ctx) => {
      const institutionId = await ctx.db.insert("institutions", {
        name: "Moli School",
        slug: "moli-workshop-thread",
        kind: "school",
        isPrimary: true,
      });
      const scholar = await ctx.db.insert("users", {
        name: "Lily Stone",
        username: "lilyWT",
        role: "scholar",
        institutionId,
      });
      const teacher = await ctx.db.insert("users", {
        name: "Mr Andy",
        username: "andyWT",
        role: "teacher",
        slackUserId: "U_ANDY",
      });
      await ctx.db.insert("memberships", {
        userId: teacher,
        role: "teacher",
        institutionId,
      });
      const now = Date.now();
      const suggestionId = await ctx.db.insert("scholarSuggestions", {
        scholarId: scholar,
        title: "I did the math and it wont go away",
        scholarWords: "I did the math and it wont go away",
        createdAt: now,
        updatedAt: now,
      });
      return { suggestionId, teacher, scholar };
    });
  }

  /** A fetch stub that answers the thread read with OUR notification as the
   * root, and records every other Slack call the handler makes. */
  function stubSlack(
    suggestionId: string,
    calls: Array<{ method: string; body: Record<string, string> }>,
  ) {
    return (async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = String(url).split("/").pop() ?? "";
      const raw = String(init?.body ?? "");
      const body = raw.startsWith("{")
        ? (JSON.parse(raw) as Record<string, string>)
        : Object.fromEntries(new URLSearchParams(raw));
      calls.push({ method, body });
      if (method === "conversations.replies") {
        return new Response(
          JSON.stringify({
            ok: true,
            messages: [
              {
                ts: "900.111",
                bot_id: "B_BOT",
                text: "💡 *Lily S.* filed a Workshop idea: \"…\"",
                metadata: {
                  event_type: "rabbithole_workshop_idea",
                  event_payload: { delivery_id: `workshop-idea:${suggestionId}` },
                },
              },
              {
                ts: "900.222",
                user: "U_ANDY",
                text: "thanks for letting us know! :rabbit2: Mr Andy",
                blocks: [
                  {
                    type: "rich_text",
                    elements: [
                      {
                        type: "rich_text_section",
                        elements: [
                          { type: "text", text: "thanks for letting us know! " },
                          { type: "emoji", name: "rabbit2", unicode: "1f407" },
                          { type: "text", text: " Mr Andy" },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ ok: true, ts: "900.999" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  }

  async function replyInThread(
    t: ReturnType<typeof convexTest>,
    args: { eventId: string; user: string; text: string },
  ) {
    await t.action(internal.slackBot.handleEvent, {
      payload: {
        team_id: "T1",
        event_id: args.eventId,
        authorizations: [{ user_id: "B_BOT", is_bot: true }],
        event: {
          type: "message",
          user: args.user,
          text: args.text,
          channel: WORKSHOP_CHANNEL,
          channel_type: "channel",
          ts: "900.222",
          thread_ts: "900.111",
        },
      },
    });
  }

  test("a staff reply lands on the idea and gets a ✅ ack", async () => {
    const t = convexTest(schema, modules);
    const { suggestionId, teacher } = await seedWorkshopIdea(t);

    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_WORKSHOP_CHANNEL_ID = WORKSHOP_CHANNEL;
    const realFetch = globalThis.fetch;
    const calls: Array<{ method: string; body: Record<string, string> }> = [];
    globalThis.fetch = stubSlack(suggestionId, calls);

    try {
      await replyInThread(t, {
        eventId: "EvWorkshopReply",
        user: "U_ANDY",
        text: "thanks for letting us know! :rabbit2: Mr Andy",
      });
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.SLACK_BOT_TOKEN;
      delete process.env.SLACK_WORKSHOP_CHANNEL_ID;
    }

    const row = await t.run(async (ctx) => ctx.db.get(suggestionId));
    // Slack sends `:rabbit2:`; a child reads this outside Slack, so the stored
    // body must carry the actual emoji.
    expect(row?.staffResponse?.body).toBe(
      "thanks for letting us know! \u{1F407} Mr Andy",
    );
    expect(row?.staffResponse?.authorId).toBe(teacher);
    // A reply changes no state — the idea stays on the kid's board until THEY
    // archive it.
    expect(row?.archivedAt).toBeUndefined();

    // The delivery is invisible from Slack, so the ✅ is the only signal the
    // reply actually reached a child — and nothing else was posted.
    const reaction = calls.find((c) => c.method === "reactions.add");
    expect(reaction?.body).toMatchObject({
      channel: WORKSHOP_CHANNEL,
      timestamp: "900.222",
      name: "white_check_mark",
    });
    expect(calls.some((c) => c.method === "chat.postMessage")).toBe(false);
  });

  test("an unlinked replier is TOLD it didn't send, and nothing is written", async () => {
    const t = convexTest(schema, modules);
    const { suggestionId } = await seedWorkshopIdea(t);

    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_WORKSHOP_CHANNEL_ID = WORKSHOP_CHANNEL;
    const realFetch = globalThis.fetch;
    const calls: Array<{ method: string; body: Record<string, string> }> = [];
    globalThis.fetch = stubSlack(suggestionId, calls);

    try {
      await replyInThread(t, {
        eventId: "EvWorkshopUnlinked",
        user: "U_STRANGER",
        text: "who is this",
      });
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.SLACK_BOT_TOKEN;
      delete process.env.SLACK_WORKSHOP_CHANNEL_ID;
    }

    const row = await t.run(async (ctx) => ctx.db.get(suggestionId));
    expect(row?.staffResponse).toBeUndefined();
    const notice = calls.find((c) => c.method === "chat.postMessage");
    expect(String(notice?.body.text)).toContain("didn't send that to the scholar");
    expect(calls.some((c) => c.method === "reactions.add")).toBe(false);
  });

  test("an @mention in the thread goes to the AIDE, not the direct recorder", async () => {
    // Both events fire for a mentioned reply. The message path bails at the
    // <@bot> guard; the app_mention path runs the aide — which is handed the
    // suggestion id so respond_to_suggestion is deterministic. What must NOT
    // happen is the direct recorder writing an aide-addressed message
    // ("@Rabbithole please pass this along") to the child as-is.
    const t = convexTest(schema, modules);
    const { suggestionId } = await seedWorkshopIdea(t);

    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_WORKSHOP_CHANNEL_ID = WORKSHOP_CHANNEL;
    const realFetch = globalThis.fetch;
    const calls: Array<{ method: string; body: Record<string, string> }> = [];
    globalThis.fetch = stubSlack(suggestionId, calls);

    try {
      await t.action(internal.slackBot.handleEvent, {
        payload: {
          team_id: "T1",
          event_id: "EvWorkshopMention",
          authorizations: [{ user_id: "B_BOT", is_bot: true }],
          event: {
            type: "app_mention",
            user: "U_ANDY",
            text: "<@B_BOT> please pass this along, we'll fix it",
            channel: WORKSHOP_CHANNEL,
            ts: "900.222",
            thread_ts: "900.111",
          },
        },
      });
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.SLACK_BOT_TOKEN;
      delete process.env.SLACK_WORKSHOP_CHANNEL_ID;
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousApiKey;
    }

    const row = await t.run(async (ctx) => ctx.db.get(suggestionId));
    expect(row?.staffResponse).toBeUndefined();
    // No ✅ — that ack belongs to the direct recorder. The aide's own 👀 is
    // expected here and is what tells the staffer the bot took the message.
    expect(
      calls.some(
        (c) =>
          c.method === "reactions.add" &&
          c.body.name === "white_check_mark",
      ),
    ).toBe(false);
    // The binding lookup ran, so the aide is told WHICH idea this thread is.
    expect(calls.some((c) => c.method === "conversations.replies")).toBe(true);
  });

  test("emoji resolve from the EVENT's own blocks, before the thread read has the message", async () => {
    // Slack's Events API can arrive before conversations.replies exposes the
    // message, so the event's blocks must be the source of truth — otherwise a
    // fast reply reaches the child as a literal ":rabbit2:".
    const t = convexTest(schema, modules);
    const { suggestionId } = await seedWorkshopIdea(t);

    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_WORKSHOP_CHANNEL_ID = WORKSHOP_CHANNEL;
    const realFetch = globalThis.fetch;
    const calls: Array<{ method: string; body: Record<string, string> }> = [];
    globalThis.fetch = stubSlack(suggestionId, calls);

    try {
      await t.action(internal.slackBot.handleEvent, {
        payload: {
          team_id: "T1",
          event_id: "EvWorkshopFastReply",
          authorizations: [{ user_id: "B_BOT", is_bot: true }],
          event: {
            type: "message",
            user: "U_ANDY",
            text: "working on it! :rabbit2: mr andy",
            channel: WORKSHOP_CHANNEL,
            channel_type: "channel",
            // A ts the stubbed thread read does NOT contain.
            ts: "900.999",
            thread_ts: "900.111",
            blocks: [
              {
                type: "rich_text",
                elements: [
                  {
                    type: "rich_text_section",
                    elements: [
                      { type: "text", text: "working on it! " },
                      { type: "emoji", name: "rabbit2", unicode: "1f407" },
                      { type: "text", text: " mr andy" },
                    ],
                  },
                ],
              },
            ],
          },
        },
      });
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.SLACK_BOT_TOKEN;
      delete process.env.SLACK_WORKSHOP_CHANNEL_ID;
    }

    const row = await t.run(async (ctx) => ctx.db.get(suggestionId));
    expect(row?.staffResponse?.body).toBe("working on it! \u{1F407} mr andy");
  });

  test("a reply in a DIFFERENT channel is left to the normal routing", async () => {
    const t = convexTest(schema, modules);
    const { suggestionId } = await seedWorkshopIdea(t);

    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_WORKSHOP_CHANNEL_ID = WORKSHOP_CHANNEL;
    const realFetch = globalThis.fetch;
    const calls: Array<{ method: string; body: Record<string, string> }> = [];
    globalThis.fetch = stubSlack(suggestionId, calls);

    try {
      await t.action(internal.slackBot.handleEvent, {
        payload: {
          team_id: "T1",
          event_id: "EvOtherChannel",
          authorizations: [{ user_id: "B_BOT", is_bot: true }],
          event: {
            type: "message",
            user: "U_ANDY",
            text: "thanks!",
            channel: "C_SOMEWHERE_ELSE",
            channel_type: "channel",
            ts: "900.222",
            thread_ts: "900.111",
          },
        },
      });
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.SLACK_BOT_TOKEN;
      delete process.env.SLACK_WORKSHOP_CHANNEL_ID;
    }

    const row = await t.run(async (ctx) => ctx.db.get(suggestionId));
    expect(row?.staffResponse).toBeUndefined();
    expect(calls.some((c) => c.method === "reactions.add")).toBe(false);
  });
});
