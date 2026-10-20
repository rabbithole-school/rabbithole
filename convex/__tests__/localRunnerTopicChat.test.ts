// localRunner:startTopicChat — the local runner's agent lands the person in a
// tutor chat on the topic they named, as the "+ Custom Quest" → "Endless chat"
// → "Start exploring" dialog would have, with no clicks.
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { seedTestInstitution } from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TC = TestConvex<typeof schema>;

afterEach(() => {
  vi.unstubAllEnvs();
});

function asLocalRunner() {
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
  vi.stubEnv("RABBITHOLE_ALLOW_DEV_LOGIN", "true");
  vi.stubEnv("RABBITHOLE_ALLOW_DEV_FIXTURES", "true");
}

async function seedScholar(t: TC, username: string): Promise<Id<"users">> {
  const institutionId = await seedTestInstitution(t);
  return await t.run((ctx) =>
    ctx.db.insert("users", { name: username, username, role: "scholar", institutionId }),
  );
}

async function signedInAs(t: TC, userId: Id<"users">) {
  const authSessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 3_600_000 }),
  );
  return t.withIdentity({ subject: `${userId}|${authSessionId}`, issuer: "https://convex.dev" });
}

/** The web dialog's launch, call for call (components/CreateQuestDialog.tsx)
 *  with the "Endless chat" choice: no bakePath. */
async function webCustomQuestEndlessChat(t: TC, scholarId: Id<"users">, topic: string) {
  const scholar = await signedInAs(t, scholarId);
  const { unitId } = await scholar.mutation(api.units.createQuest, { title: topic });
  const session = await scholar.mutation(api.sessions.create, { unitId });
  await scholar.mutation(api.units.scheduleCustomQuestBake, { unitId, sessionId: session.id });
  return session.id;
}

/** What the opening turn and the chat page read, minus ids and timestamps. */
async function shape(t: TC, sessionId: Id<"sessions">) {
  return await t.run(async (ctx) => {
    const session = (await ctx.db.get(sessionId)) as Doc<"sessions">;
    const unit = (await ctx.db.get(session.unitId!)) as Doc<"units">;
    const processState = await ctx.db
      .query("processState")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect();
    const scheduled = (await ctx.db.system.query("_scheduled_functions").collect())
      .filter((job) => (job.args[0] as { unitId?: string }).unitId === unit._id)
      .map((job) => ({ name: job.name, args: Object.keys(job.args[0] as object).sort() }));
    const { _id, _creationTime, userId, unitId, ...sessionRest } = session;
    const { _id: _u, _creationTime: _uc, teacherId, authorScholarId, ...unitRest } = unit;
    return {
      session: sessionRest,
      sessionOwnedByScholar: userId === unit.authorScholarId && teacherId === userId,
      unit: unitRest,
      processStates: processState.length,
      scheduled,
    };
  });
}

describe("localRunner:startTopicChat", () => {
  test("refuses on a hosted deployment, even with the dev flags on", async () => {
    vi.stubEnv("CONVEX_CLOUD_URL", "https://example-123.convex.cloud");
    vi.stubEnv("RABBITHOLE_ALLOW_DEV_LOGIN", "true");
    vi.stubEnv("RABBITHOLE_ALLOW_DEV_FIXTURES", "true");
    const t = convexTest(schema, modules);
    await seedScholar(t, "leilani_park");
    await expect(
      t.mutation(internal.localRunner.startTopicChat, {
        username: "leilani_park",
        topic: "aquaponics",
      }),
    ).rejects.toThrow(/only runs on the local runner/);
    expect(await t.run((ctx) => ctx.db.query("sessions").collect())).toHaveLength(0);
  });

  test("refuses on a loopback backend the runner didn't mark", async () => {
    vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
    vi.stubEnv("RABBITHOLE_ALLOW_DEV_LOGIN", "true");
    vi.stubEnv("RABBITHOLE_ALLOW_DEV_FIXTURES", "");
    const t = convexTest(schema, modules);
    await seedScholar(t, "leilani_park");
    await expect(
      t.mutation(internal.localRunner.startTopicChat, {
        username: "leilani_park",
        topic: "aquaponics",
      }),
    ).rejects.toThrow(/only runs on the local runner/);
  });

  test("creates the scholar's chat on the topic and returns its page", async () => {
    asLocalRunner();
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "leilani_park");

    const result = await t.mutation(internal.localRunner.startTopicChat, {
      username: "leilani_park",
      topic: "  aquaponics \n",
    });

    expect(result.path).toBe(`/scholar/${result.sessionId}`);
    const session = await t.run((ctx) => ctx.db.get(result.sessionId));
    expect(session).toMatchObject({ userId: scholarId, title: "aquaponics", isArchived: false });
    // No tutor turn: the chat page's opening turn runs when it mounts.
    const messages = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", result.sessionId))
        .collect(),
    );
    expect(messages).toHaveLength(0);
  });

  test("makes the same session the web Custom Quest dialog makes", async () => {
    asLocalRunner();
    const t = convexTest(schema, modules);
    const viaWeb = await webCustomQuestEndlessChat(
      t,
      await seedScholar(t, "web_scholar"),
      "aquaponics",
    );
    await seedScholar(t, "leilani_park");
    const viaRunner = await t.mutation(internal.localRunner.startTopicChat, {
      username: "leilani_park",
      topic: "aquaponics",
    });

    const web = await shape(t, viaWeb);
    const runner = await shape(t, viaRunner.sessionId);
    expect(runner).toEqual(web);
    // The fields the opening turn reads, spelled out: an unheld, activity-less
    // chat on the scholar's own quest, with the bake left off the live chat.
    expect(runner.session.questBakeStatus).toBeUndefined();
    expect(runner.session.activityId).toBeUndefined();
    expect(runner.sessionOwnedByScholar).toBe(true);
    expect(runner.scheduled).toEqual([
      { name: "bakeUnitFromSeed:bakeCustomQuestUnit", args: ["unitId"] },
    ]);
  });

  test("validates the topic and the username", async () => {
    asLocalRunner();
    const t = convexTest(schema, modules);
    await seedScholar(t, "leilani_park");
    const start = (username: string, topic: string) =>
      t.mutation(internal.localRunner.startTopicChat, { username, topic });

    await expect(start("leilani_park", "   ")).rejects.toThrow(/Name a topic/);
    await expect(start("leilani_park", "x".repeat(201))).rejects.toThrow(/under 200/);
    await expect(start("nobody_here", "aquaponics")).rejects.toThrow(/No scholar/);
    const teacherId = await t.run((ctx) =>
      ctx.db.insert("users", { name: "T", username: "a_teacher", role: "teacher" }),
    );
    expect(teacherId).toBeTruthy();
    await expect(start("a_teacher", "aquaponics")).rejects.toThrow(/No scholar/);
  });
});
