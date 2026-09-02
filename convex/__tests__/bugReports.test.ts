import { convexTest } from "convex-test";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { makeSlackTools } from "../lib/slackTools";
import {
  grantStaffAccessToScholars,
  seedScholarInInstitution,
  seedTestInstitution,
} from "./institutionTestHelpers";

const { triageCreate } = vi.hoisted(() => ({
  triageCreate: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: triageCreate };
  }
  return { default: FakeAnthropic, Anthropic: FakeAnthropic };
});

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = ReturnType<typeof convexTest>;
type Role = "scholar" | "teacher" | "platform_admin";

const previousImpersonationFlag = process.env.IMPERSONATION_ENABLED;
const previousSlackToken = process.env.SLACK_BOT_TOKEN;

beforeAll(() => {
  process.env.IMPERSONATION_ENABLED = "on";
});

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  delete process.env.SLACK_BOT_TOKEN;
  triageCreate.mockReset();
  triageCreate.mockResolvedValue({
    content: [
      {
        type: "text",
        text: "Likely session-header state drift. Reproduce from the captured route before dispatching.",
      },
    ],
    usage: { input_tokens: 20, output_tokens: 30 },
  });
});

afterEach(() => {
  delete process.env.SLACK_BOT_TOKEN;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterAll(() => {
  if (previousImpersonationFlag === undefined) {
    delete process.env.IMPERSONATION_ENABLED;
  } else {
    process.env.IMPERSONATION_ENABLED = previousImpersonationFlag;
  }
  if (previousSlackToken === undefined) {
    delete process.env.SLACK_BOT_TOKEN;
  } else {
    process.env.SLACK_BOT_TOKEN = previousSlackToken;
  }
});

async function seedUser(
  t: T,
  role: Role,
  username: string,
  institutionId?: Id<"institutions">,
) {
  return await t.run((ctx) =>
    ctx.db.insert("users", {
      name: `Test ${username}`,
      username,
      role,
      institutionId,
    }),
  );
}

async function withUser(t: T, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1_000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function withUserSession(t: T, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1_000,
    }),
  );
  return {
    sessionId,
    as: t.withIdentity({
      subject: `${userId}|${sessionId}`,
      issuer: "https://convex.dev",
    }),
  };
}

async function seedSession(t: T, scholarId: Id<"users">, title = "Debug session") {
  return await t.run((ctx) =>
    ctx.db.insert("sessions", {
      userId: scholarId,
      title,
      isArchived: false,
    }),
  );
}

async function bindChannel(
  t: T,
  linkedBy: Id<"users">,
  slackChannelId = "C_PRIVATE",
) {
  await t.run((ctx) =>
    ctx.db.insert("bugReportChannel", {
      slackChannelId,
      linkedBy,
      linkedAt: Date.now(),
    }),
  );
}

async function insertReceivedReport(
  t: T,
  args: {
    actorUserId: Id<"users">;
    description: string;
    screenshotStorageId?: Id<"_storage">;
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("bugReports", {
      actorUserId: args.actorUserId,
      actorRole: "teacher",
      surface: "web",
      url: "/teacher/curriculum?tab=preflight",
      description: args.description,
      screenshotStorageId: args.screenshotStorageId,
      attempts: 0,
      status: "received",
    }),
  );
}

function response(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubSlack(options: {
  rootOk?: boolean;
  uploadOk?: boolean;
} = {}) {
  let messageCount = 0;
  const calls: Array<{ method: string; body: unknown }> = [];
  const fetchMock = vi.fn(
    async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const rawUrl = String(url);
      const method = rawUrl.includes("/api/")
        ? rawUrl.split("/api/")[1]
        : rawUrl;
      calls.push({ method, body: init?.body });
      if (method === "chat.postMessage") {
        messageCount += 1;
        if (messageCount === 1 && options.rootOk === false) {
          return response({ ok: false, error: "ratelimited" });
        }
        return response({ ok: true, ts: `1710000000.${messageCount}` });
      }
      if (method === "files.getUploadURLExternal") {
        return options.uploadOk === false
          ? response({ ok: false, error: "ratelimited" })
          : response({
              ok: true,
              upload_url: "https://uploads.slack.test/file",
              file_id: "F_REPORT",
            });
      }
      if (rawUrl === "https://uploads.slack.test/file") {
        return new Response("", { status: 200 });
      }
      if (method === "files.completeUploadExternal") {
        return response({ ok: true });
      }
      throw new Error(`Unexpected fetch: ${rawUrl}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

function findTool(
  tools: Awaited<ReturnType<typeof makeSlackTools>>,
  name: string,
) {
  const tool = tools.find((candidate) => candidate.name === name) as
    | { run: (input: { unlink?: boolean }) => Promise<string> }
    | undefined;
  if (!tool) throw new Error(`Tool ${name} was not assembled`);
  return tool;
}

describe("bugReports.submit", () => {
  test("typed web report stores received and schedules the pipeline", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const teacher = await seedUser(t, "teacher", "lehua");
    await bindChannel(t, admin);
    const asTeacher = await withUser(t, teacher);

    const result = await asTeacher.mutation(api.bugReports.submit, {
      surface: "web",
      url: "https://learn.example/teacher?tab=curriculum#ignored",
      description: "The activity preview stayed blank.",
      userAgent: "Fixture Browser",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.status).toBe("received");
    const report = await t.run((ctx) => ctx.db.get(result.reportId));
    expect(report).toMatchObject({
      actorUserId: teacher,
      actorRole: "teacher",
      surface: "web",
      url: "/teacher?tab=curriculum",
      description: "The activity preview stayed blank.",
      status: "received",
      attempts: 0,
    });
    const jobs = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(jobs.some((job) => job.name === "bugReports:processReport")).toBe(true);
  });

  test("deduplicates a client report id for the same actor", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "lehua_dedup");
    const asTeacher = await withUser(t, teacher);

    const first = await asTeacher.mutation(api.bugReports.submit, {
      surface: "native",
      url: "/session/first",
      clientReportId: "native-report-123",
      description: "Original capture",
    });
    const retry = await asTeacher.mutation(api.bugReports.submit, {
      surface: "native",
      url: "/session/retry",
      clientReportId: "native-report-123",
      description: "Concurrent retry",
    });
    if (!first.ok || !retry.ok) throw new Error("submit failed");

    expect(retry).toEqual(first);
    const reports = await t.run((ctx) =>
      ctx.db
        .query("bugReports")
        .withIndex("by_client_id", (q) =>
          q
            .eq("clientReportId", "native-report-123")
            .eq("actorUserId", teacher),
        )
        .collect(),
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      url: "/session/first",
      description: "Original capture",
      status: "waiting_for_channel",
    });
  });

  test("scholar native report keeps an owned session and silently drops a foreign one", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, {
      slug: "session-ownership-school",
    });
    const scholar = await seedScholarInInstitution(t, {
      institutionId,
      username: "kai",
    });
    const other = await seedScholarInInstitution(t, {
      institutionId,
      username: "lani",
    });
    const ownedSession = await seedSession(t, scholar, "Owned");
    const foreignSession = await seedSession(t, other, "Foreign");
    const asScholar = await withUser(t, scholar);

    const kept = await asScholar.mutation(api.bugReports.submit, {
      surface: "native",
      url: "/session/owned",
      sessionId: ownedSession,
      deviceModel: "iPad fixture",
    });
    const dropped = await asScholar.mutation(api.bugReports.submit, {
      surface: "native",
      url: "/session/foreign",
      sessionId: foreignSession,
    });
    if (!kept.ok || !dropped.ok) throw new Error("submit failed");

    expect((await t.run((ctx) => ctx.db.get(kept.reportId)))?.sessionId).toBe(
      ownedSession,
    );
    const droppedReport = await t.run((ctx) => ctx.db.get(dropped.reportId));
    expect(droppedReport?.sessionId).toBeUndefined();
    expect(droppedReport?.institutionId).toBe(institutionId);
  });

  test("impersonating admin records the real actor and target while normal writes stay blocked", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, {
      slug: "impersonation-report-school",
    });
    const admin = await seedUser(t, "platform_admin", "avery");
    const target = await seedScholarInInstitution(t, {
      institutionId,
      username: "oliver_stone",
    });
    const impersonating = await withUserSession(t, admin);
    await impersonating.as.mutation(api.impersonation.startImpersonation, {
      targetUserId: target,
    });

    await expect(
      impersonating.as.mutation(api.users.updatePreferredFont, {
        preferredFont: "serif",
      }),
    ).rejects.toThrow(/read-only while viewing/i);

    const result = await impersonating.as.mutation(api.bugReports.submit, {
      surface: "web",
      url: "/scholar?remote=oliver_stone",
      description: "The viewed dashboard showed the wrong tab.",
    });
    if (!result.ok) throw new Error(result.error);
    const report = await t.run((ctx) => ctx.db.get(result.reportId));
    expect(report).toMatchObject({
      actorUserId: admin,
      actorRole: "platform_admin",
      viewedUserId: target,
      viewingMode: "actAs",
      status: "waiting_for_channel",
    });
    expect(report?.institutionId).toBeUndefined();
  });

  test("invalid blob is rejected and deleted transactionally", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "lehua");
    const asTeacher = await withUser(t, teacher);
    const invalidBlob = await t.run((ctx) =>
      ctx.storage.store(new Blob(["not an image"], { type: "text/plain" })),
    );

    const result = await asTeacher.mutation(api.bugReports.submit, {
      surface: "web",
      url: "/teacher",
      screenshotStorageId: invalidBlob,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.error).toMatch(/PNG or JPEG/);
    expect(await t.run((ctx) => ctx.storage.get(invalidBlob))).toBeNull();
    expect(
      await t.run((ctx) => ctx.db.query("bugReports").collect()),
    ).toHaveLength(0);
  });

  test("unbound channel stores waiting and raises a warning platform alert", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", "lehua");
    const asTeacher = await withUser(t, teacher);

    const result = await asTeacher.mutation(api.bugReports.submit, {
      surface: "web",
      url: "/teacher",
      description: "Saved even though setup is incomplete.",
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.status).toBe("waiting_for_channel");
    const alerts = await t.run((ctx) => ctx.db.query("alerts").collect());
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: "bug_report_channel_unbound",
      severity: "warning",
      source: "bugReports.submit",
    });
  });

  test("institution resolution follows scholar, validated session, then null", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, {
      slug: "resolution-matrix-school",
    });
    const scholar = await seedScholarInInstitution(t, {
      institutionId,
      username: "kai_matrix",
    });
    const teacher = await seedUser(t, "teacher", "lehua_matrix");
    const admin = await seedUser(t, "platform_admin", "avery_matrix");
    await grantStaffAccessToScholars(t, {
      staffUserId: teacher,
      scholarIds: [scholar],
      institutionId,
    });
    const sessionId = await seedSession(t, scholar);

    const scholarResult = await (await withUser(t, scholar)).mutation(
      api.bugReports.submit,
      { surface: "native", url: "/sky" },
    );
    const teacherResult = await (await withUser(t, teacher)).mutation(
      api.bugReports.submit,
      {
        surface: "web",
        url: "/scholar/session",
        viewedUserId: scholar,
        viewingMode: "inspect",
        sessionId,
      },
    );
    const adminResult = await (await withUser(t, admin)).mutation(
      api.bugReports.submit,
      { surface: "web", url: "/admin" },
    );
    if (!scholarResult.ok || !teacherResult.ok || !adminResult.ok) {
      throw new Error("submit failed");
    }
    const [scholarReport, teacherReport, adminReport] = await Promise.all([
      t.run((ctx) => ctx.db.get(scholarResult.reportId)),
      t.run((ctx) => ctx.db.get(teacherResult.reportId)),
      t.run((ctx) => ctx.db.get(adminResult.reportId)),
    ]);
    expect(scholarReport?.institutionId).toBe(institutionId);
    expect(teacherReport?.institutionId).toBe(institutionId);
    expect(teacherReport?.sessionId).toBe(sessionId);
    expect(teacherReport?.viewedUserId).toBe(scholar);
    expect(adminReport?.institutionId).toBeUndefined();
  });
});

describe("bug-report channel binding", () => {
  test("Slack tool refuses a public channel before calling the bind mutation", async () => {
    const runMutation = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({ ok: true, channel: { is_private: false } }),
      ),
    );
    const tools = await makeSlackTools(
      { runMutation } as unknown as ActionCtx,
      () => {},
      {
        role: "platform_admin",
        callerUserId: "user_admin" as Id<"users">,
        surface: "channel",
        slackChannelId: "C_PUBLIC",
        token: "xoxb-test",
      },
    );

    const result = await findTool(tools, "link_bug_report_channel").run({});
    expect(result).toMatch(/can't link a public channel/i);
    expect(runMutation).not.toHaveBeenCalled();
  });

  test("binding drains every waiting report and schedules processing", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const teacher = await seedUser(t, "teacher", "lehua");
    const asTeacher = await withUser(t, teacher);
    const submitted = await asTeacher.mutation(api.bugReports.submit, {
      surface: "web",
      url: "/teacher",
      description: "Waiting report",
    });
    if (!submitted.ok) throw new Error(submitted.error);

    const linked = await t.mutation(
      internal.bugReports.linkBugReportChannel,
      {
        callerUserId: admin,
        slackChannelId: "C_PRIVATE",
        unlink: false,
      },
    );
    expect(linked).toMatchObject({ ok: true, waitingCount: 1 });
    expect(
      (await t.run((ctx) => ctx.db.get(submitted.reportId)))?.status,
    ).toBe("received");
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(
      scheduled.filter((job) => job.name === "bugReports:processReport"),
    ).toHaveLength(1);
  });
});

describe("durable bug-report pipeline", () => {
  test("failed root post records retry state; rerun advances every receipt and bridges the chat", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const teacher = await seedUser(t, "teacher", "lehua");
    await bindChannel(t, admin);
    const reportId = await insertReceivedReport(t, {
      actorUserId: teacher,
      description: "Preview never left the loading state.",
    });
    process.env.SLACK_BOT_TOKEN = "xoxb-test";

    stubSlack({ rootOk: false });
    await t.action(internal.bugReports.processReport, {
      reportId,
    });
    let report = await t.run((ctx) => ctx.db.get(reportId));
    expect(report?.transcribedAt).toBeTypeOf("number");
    expect(report?.postedAt).toBeUndefined();
    expect(report?.attempts).toBe(1);
    expect(report?.lastError).toMatch(/post: Slack root post failed.*ratelimited/);
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(
      scheduled.filter((job) => job.name === "bugReports:processReport").length,
    ).toBe(1);

    vi.unstubAllGlobals();
    const slack = stubSlack();
    await t.action(internal.bugReports.processReport, {
      reportId,
    });
    report = await t.run((ctx) => ctx.db.get(reportId));
    expect(report).toMatchObject({
      status: "triaged",
      slackChannelId: "C_PRIVATE",
      slackThreadTs: "1710000000.1",
      attempts: 1,
    });
    expect(report?.transcribedAt).toBeTypeOf("number");
    expect(report?.postedAt).toBeTypeOf("number");
    expect(report?.filesAt).toBeTypeOf("number");
    expect(report?.bridgedAt).toBeTypeOf("number");
    expect(report?.triagedAt).toBeTypeOf("number");
    expect(report?.chatId).toBeDefined();
    expect(report?.lastError).toBeUndefined();

    const thread = await t.run((ctx) =>
      ctx.db
        .query("slackThreads")
        .withIndex("by_channel_thread", (q) =>
          q
            .eq("channelId", "C_PRIVATE")
            .eq("threadTs", "1710000000.1"),
        )
        .unique(),
    );
    expect(thread?.chatId).toBe(report?.chatId);
    const messages = await t.run((ctx) =>
      ctx.db
        .query("curriculumMessages")
        .withIndex("by_chat", (q) => q.eq("chatId", report!.chatId!))
        .collect(),
    );
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(triageCreate).toHaveBeenCalledTimes(1);
    const slackPosts = slack.calls.filter(
      (call) => call.method === "chat.postMessage",
    );
    expect(slackPosts.length).toBeGreaterThanOrEqual(2);
  });

  test("attachment failure retries without blocking bridge or triage", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const teacher = await seedUser(t, "teacher", "lehua");
    await bindChannel(t, admin);
    const screenshot = await t.run((ctx) =>
      ctx.storage.store(new Blob(["png"], { type: "image/png" })),
    );
    const reportId = await insertReceivedReport(t, {
      actorUserId: teacher,
      description: "Screenshot shows the failure.",
      screenshotStorageId: screenshot,
    });
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    stubSlack({ uploadOk: false });

    await t.action(internal.bugReports.processReport, {
      reportId,
    });
    const report = await t.run((ctx) => ctx.db.get(reportId));
    expect(report?.status).toBe("triaged");
    expect(report?.filesAt).toBeUndefined();
    expect(report?.bridgedAt).toBeTypeOf("number");
    expect(report?.triagedAt).toBeTypeOf("number");
    expect(report?.attempts).toBe(1);
    expect(report?.lastError).toMatch(/files: screenshot upload failed/);
  });

  test("storage-backed Whisper reads the blob and preserves the m4a filename mapping", async () => {
    const t = convexTest(schema, modules);
    const audio = await t.run((ctx) =>
      ctx.storage.store(new Blob(["aac fixture"], { type: "audio/mp4" })),
    );
    let filename = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const file = (init?.body as FormData).get("file") as File;
        filename = file.name;
        return response({ text: "The preview is blank.", duration: 1.5 });
      }),
    );

    const result = await t.action(internal.audioActions.transcribeStored, {
      storageId: audio,
    });
    expect(result.text).toBe("The preview is blank.");
    expect(filename).toBe("recording.m4a");
    const usage = await t.run((ctx) => ctx.db.query("usageEvents").collect());
    expect(usage[0]).toMatchObject({
      source: "whisper-transcription",
      model: "whisper-1",
      audioSeconds: 1.5,
    });
  });

  test("stuck exhausted report is marked failed and raises a warning", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "avery");
    const teacher = await seedUser(t, "teacher", "lehua");
    await bindChannel(t, admin);
    const reportId = await t.run((ctx) =>
      ctx.db.insert("bugReports", {
        actorUserId: teacher,
        actorRole: "teacher",
        surface: "web",
        url: "/teacher",
        attempts: 5,
        lastError: "post: ratelimited",
        status: "received",
      }),
    );
    const future = Date.now() + 20 * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(future);

    const result = await t.mutation(
      internal.bugReports.sweepStuckReports,
      {},
    );
    expect(result.failed).toBe(1);
    expect((await t.run((ctx) => ctx.db.get(reportId)))?.status).toBe("failed");
    const alerts = await t.run((ctx) => ctx.db.query("alerts").collect());
    expect(alerts.some((alert) => alert.kind === "bug_report_pipeline_stuck")).toBe(
      true,
    );
  });
});
