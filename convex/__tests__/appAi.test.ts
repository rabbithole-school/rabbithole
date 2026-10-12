import { convexTest } from "convex-test";
import { MAX_CHARACTER_REPLY_CHARS } from "../../shared/appAiPolicy";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { APP_AI_MODEL } from "../lib/models";
import { APP_AI_LLM_SURFACE } from "../lib/llmLimiter";
import { deleteSessionCascade } from "../lib/cascade";
import { deleteSessionInner } from "../devPurge";
import {
  grantStaffAccessToScholars,
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const { anthropicCreate } = vi.hoisted(() => ({
  anthropicCreate: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    beta = { messages: { create: anthropicCreate } };
  }
  return { default: FakeAnthropic, Anthropic: FakeAnthropic };
});

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

function setup() {
  return convexTest(schema, modules);
}
type T = ReturnType<typeof setup>;

const CHARACTER = {
  name: "Bolt",
  persona: "A literal-minded robot who follows rules exactly.",
  moods: ["literal", "confused", "proud"],
  verdicts: ["rule_accepted", "rule_rejected"],
};
const JUDGE = {
  id: "fractions",
  rubric: "Correct when the answer names 3/4.",
  verdicts: ["correct", "not_yet"],
};

/** A structured-output reply: one text block holding the JSON. */
function toolReply(input: Record<string, unknown>) {
  return textReply(JSON.stringify(input));
}

function textReply(text: string, stopReason = "end_turn") {
  return {
    model: APP_AI_MODEL,
    stop_reason: stopReason,
    content: [{ type: "text", text }],
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

async function sessionRows(t: T, sessionId: Id<"sessions">) {
  return await t.run((ctx) =>
    ctx.db
      .query("appAiTurns")
      .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
      .collect(),
  );
}

async function asUser(t: T, userId: Id<"users">) {
  const authSessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1_000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${authSessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedApp(
  t: T,
  options: { withCharacter?: boolean; slug?: string } = {},
) {
  const institutionId = await seedTestInstitution(t, {
    slug: options.slug ?? "app-ai-school",
  });
  const scholarId = await seedScholarInInstitution(t, { institutionId });
  const { sessionId, artifactId } = await t.run(async (ctx) => {
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      title: "Teach the robot",
      isArchived: false,
      institutionId,
    });
    const artifactId = await ctx.db.insert("artifacts", {
      sessionId,
      title: "Robot",
      content: "<html></html>",
      lastEditedBy: "ai",
      type: "code",
      appAi: {
        ...(options.withCharacter === false ? {} : { character: CHARACTER }),
        judges: [JUDGE],
        updatedAt: 1,
      },
    });
    return { sessionId, artifactId };
  });
  return { institutionId, scholarId, sessionId, artifactId };
}

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  anthropicCreate.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("appAiActions.say", () => {
  test("records a done exchange and returns the validated reply", async () => {
    const t = setup();
    const { scholarId, artifactId, sessionId } = await seedApp(t);
    anthropicCreate.mockResolvedValue(
      toolReply({ line: "Rule stored.", mood: "proud", verdict: "rule_accepted" }),
    );

    const result = await (await asUser(t, scholarId)).action(
      api.appAiActions.say,
      { artifactId, text: "  When I wave, wave back.  " },
    );

    expect(result).toMatchObject({
      ok: true,
      line: "Rule stored.",
      mood: "proud",
      verdict: "rule_accepted",
    });
    const request = anthropicCreate.mock.calls[0][0];
    expect(request.model).toBe(APP_AI_MODEL);
    expect(request).not.toHaveProperty("tool_choice");
    expect(request.output_config.format.type).toBe("json_schema");
    expect(request.messages).toEqual([
      { role: "user", content: "When I wave, wave back." },
    ]);

    const rows = await t.run((ctx) =>
      ctx.db
        .query("appAiTurns")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "exchange",
      status: "done",
      scholarLine: "When I wave, wave back.",
      line: "Rule stored.",
      verdict: "rule_accepted",
      model: APP_AI_MODEL,
    });
    const leases = await t.run((ctx) => ctx.db.query("llmLeases").collect());
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({
      surface: APP_AI_LLM_SURFACE,
      active: false,
    });
  });

  test("the author's director notes never reach the character's model", async () => {
    const t = setup();
    const { scholarId, artifactId } = await seedApp(t);
    const notes = "DIRECTOR-ONLY: the scholar must find the goal unprompted.";
    await t.run(async (ctx) => {
      const artifact = await ctx.db.get(artifactId);
      await ctx.db.patch(artifactId, {
        appAi: {
          ...artifact!.appAi!,
          character: { ...CHARACTER, directorNotes: notes },
        },
      });
    });
    anthropicCreate.mockResolvedValue(
      toolReply({ line: "Rule stored.", mood: "proud", verdict: "rule_accepted" }),
    );

    const result = await (await asUser(t, scholarId)).action(
      api.appAiActions.say,
      { artifactId, text: "Wave back." },
    );

    expect(result.ok).toBe(true);
    expect(JSON.stringify(anthropicCreate.mock.calls[0][0])).not.toContain(
      "DIRECTOR-ONLY",
    );
  });

  test("replays prior replies with their effective verdict and the newest direction", async () => {
    const t = setup();
    const { scholarId, artifactId, sessionId } = await seedApp(t);
    await t.run(async (ctx) => {
      const base = { sessionId, artifactId, status: "done" as const };
      await ctx.db.insert("appAiTurns", {
        ...base,
        kind: "exchange",
        scholarLine: "Rule one",
        line: "Stored.",
        mood: "literal",
        verdict: "rule_rejected",
        verdictOverride: { verdict: "rule_accepted", at: 2 },
        createdAt: 1,
      });
      await ctx.db.insert("appAiTurns", {
        ...base,
        kind: "direction",
        direction: "Be gentler.",
        createdAt: 2,
      });
      await ctx.db.insert("appAiTurns", {
        ...base,
        kind: "aside",
        line: "Good try!",
        mood: "proud",
        createdAt: 3,
      });
    });
    anthropicCreate.mockResolvedValue(toolReply({ line: "Ok.", mood: "literal" }));

    await (await asUser(t, scholarId)).action(api.appAiActions.say, {
      artifactId,
      text: "Rule two",
    });

    const request = anthropicCreate.mock.calls[0][0];
    // The persona block is cached; the direction rides in its own block after
    // it, so a new direction leaves the cached prefix intact.
    expect(request.system).toHaveLength(2);
    expect(request.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(request.system[0].text).not.toContain("Be gentler.");
    expect(request.system[1].text).toContain("Be gentler.");
    expect(request.system[1]).not.toHaveProperty("cache_control");
    expect(request.messages).toEqual([
      { role: "user", content: "Rule one" },
      {
        role: "assistant",
        content:
          "[mood: literal · verdict: rule_accepted] Stored.\n[mood: proud] Good try!",
      },
      { role: "user", content: "Rule two" },
    ]);
  });

  test("re-normalizes the app context, shows it on the current line only, and records it", async () => {
    const t = setup();
    const { scholarId, artifactId, sessionId } = await seedApp(t);
    anthropicCreate.mockResolvedValue(toolReply({ line: "Ok.", mood: "literal" }));
    const scholar = await asUser(t, scholarId);

    // Called directly, so nothing upstream cleaned it: the server must.
    await scholar.action(api.appAiActions.say, {
      artifactId,
      text: "Wave back",
      context: { stage: 4, "1bad": 1, mode: `  rule\n${"x".repeat(200)}` },
    });
    await scholar.action(api.appAiActions.say, {
      artifactId,
      text: "Now jump",
      context: { stage: 5 },
    });

    const mode = `rule ${"x".repeat(115)}`;
    expect(anthropicCreate.mock.calls[0][0].messages).toEqual([
      {
        role: "user",
        content: `<app_state>\nmode: ${mode}\nstage: 4\n</app_state>\nWave back`,
      },
    ]);
    // The earlier line replays as the child said it; only the new one carries state.
    expect(anthropicCreate.mock.calls[1][0].messages).toEqual([
      { role: "user", content: "Wave back" },
      { role: "assistant", content: "[mood: literal] Ok." },
      { role: "user", content: "<app_state>\nstage: 5\n</app_state>\nNow jump" },
    ]);
    const rows = await t.run((ctx) =>
      ctx.db
        .query("appAiTurns")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    // Convex delivers the record with sorted keys; the record keeps that order.
    expect(rows.map((row) => row.appContext)).toEqual([
      JSON.stringify({ mode, stage: 4 }),
      JSON.stringify({ stage: 5 }),
    ]);
  });

  test("records no context when the app sends none", async () => {
    const t = setup();
    const { scholarId, artifactId, sessionId } = await seedApp(t);
    anthropicCreate.mockResolvedValue(toolReply({ line: "Ok.", mood: "literal" }));
    await (await asUser(t, scholarId)).action(api.appAiActions.say, {
      artifactId,
      text: "Hi",
      context: { "not valid": "x" },
    });
    expect(anthropicCreate.mock.calls[0][0].messages).toEqual([
      { role: "user", content: "Hi" },
    ]);
    const [row] = await t.run((ctx) =>
      ctx.db
        .query("appAiTurns")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    expect(row).not.toHaveProperty("appContext");
  });

  test("clamps a bad mood, drops an unknown verdict, and truncates a long line", async () => {
    const t = setup();
    const { scholarId, artifactId } = await seedApp(t);
    const long = `${"Beep. ".repeat(70)}${"x".repeat(200)}`;
    anthropicCreate.mockResolvedValue(
      toolReply({ line: long, mood: "furious", verdict: "maybe" }),
    );

    const result = await (await asUser(t, scholarId)).action(
      api.appAiActions.say,
      { artifactId, text: "Hi" },
    );

    if (!result.ok) throw new Error("expected a reply");
    expect(result.mood).toBe("literal");
    expect(result.verdict).toBeUndefined();
    expect(result.line.length).toBeLessThanOrEqual(MAX_CHARACTER_REPLY_CHARS);
    expect(result.line.endsWith(".")).toBe(true);
  });

  test("refuses a caller who does not own the session", async () => {
    const t = setup();
    const { institutionId, artifactId } = await seedApp(t);
    const otherScholar = await seedScholarInInstitution(t, { institutionId });

    await expect(
      (await asUser(t, otherScholar)).action(api.appAiActions.say, {
        artifactId,
        text: "Hi",
      }),
    ).rejects.toThrow(/Forbidden/);
    expect(anthropicCreate).not.toHaveBeenCalled();
  });

  test("a teacher can play in their own test-drive rehearsal", async () => {
    const t = setup();
    const institutionId = await seedTestInstitution(t, { slug: "rehearsal" });
    const teacherId = await seedStaffWithMembership(t, { institutionId });
    const artifactId = await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("sessions", {
        userId: teacherId,
        title: "Rehearse",
        isArchived: false,
        isTestDrive: true,
        institutionId,
      });
      return await ctx.db.insert("artifacts", {
        sessionId,
        title: "Robot",
        content: "<html></html>",
        lastEditedBy: "ai",
        type: "code",
        appAi: { character: CHARACTER, updatedAt: 1 },
      });
    });
    anthropicCreate.mockResolvedValue(toolReply({ line: "Hi.", mood: "literal" }));

    const result = await (await asUser(t, teacherId)).action(
      api.appAiActions.say,
      { artifactId, text: "Hello" },
    );

    expect(result).toMatchObject({ ok: true, line: "Hi." });
  });

  test("is unavailable when the app has no character", async () => {
    const t = setup();
    const { scholarId, artifactId } = await seedApp(t, { withCharacter: false });

    const result = await (await asUser(t, scholarId)).action(
      api.appAiActions.say,
      { artifactId, text: "Hi" },
    );

    expect(result).toEqual({ ok: false, code: "unavailable" });
    expect(anthropicCreate).not.toHaveBeenCalled();
  });

  test("marks the turn failed when the model call throws", async () => {
    const t = setup();
    const { scholarId, artifactId, sessionId } = await seedApp(t);
    anthropicCreate.mockRejectedValue(new Error("network down"));
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await (await asUser(t, scholarId)).action(
      api.appAiActions.say,
      { artifactId, text: "Hi" },
    );

    expect(result).toEqual({ ok: false, code: "failed" });
    const rows = await t.run((ctx) =>
      ctx.db
        .query("appAiTurns")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    expect(rows.map((row) => row.status)).toEqual(["failed"]);
    const leases = await t.run((ctx) => ctx.db.query("llmLeases").collect());
    expect(leases.every((lease) => !lease.active)).toBe(true);
  });

  test("a declined call is retried once and the child gets the reply", async () => {
    const t = setup();
    const { scholarId, artifactId } = await seedApp(t);
    anthropicCreate
      .mockResolvedValueOnce(textReply("", "refusal"))
      .mockResolvedValueOnce(toolReply({ line: "Ok.", mood: "literal" }));
    const result = await (await asUser(t, scholarId)).action(
      api.appAiActions.say,
      { artifactId, text: "Where is the hull patch?" },
    );
    expect(result.ok).toBe(true);
    expect(anthropicCreate).toHaveBeenCalledTimes(2);
  });

  test("asks the API for a refusal fallback", async () => {
    const t = setup();
    const { scholarId, artifactId } = await seedApp(t);
    anthropicCreate.mockResolvedValue(toolReply({ line: "Ok.", mood: "literal" }));
    await (await asUser(t, scholarId)).action(api.appAiActions.say, {
      artifactId,
      text: "Hi",
    });
    const request = anthropicCreate.mock.calls[0][0];
    expect(request.fallbacks).toBe("default");
    expect(request.betas).toEqual(["server-side-fallback-2026-07-01"]);
  });

  test.each([
    ["a refusal that survived the fallback", textReply("", "refusal")],
    [
      "a refusal whose partial text parses",
      textReply(JSON.stringify({ line: "I can't help.", mood: "literal" }), "refusal"),
    ],
    ["a reply cut off at max_tokens", textReply('{"line": "Wh', "max_tokens")],
    ["malformed JSON", textReply("Rule stored, beep.")],
  ])("fails the turn on %s and explains nothing", async (_label, response) => {
    const t = setup();
    const { scholarId, artifactId, sessionId } = await seedApp(t);
    anthropicCreate.mockResolvedValue(response);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await (await asUser(t, scholarId)).action(
      api.appAiActions.say,
      { artifactId, text: "Hi" },
    );

    expect(result).toEqual({ ok: false, code: "failed" });
    const rows = await sessionRows(t, sessionId);
    expect(rows.map((row) => row.status)).toEqual(["failed"]);
    expect(rows[0].line).toBeUndefined();
  });

  test("reads the final model's reply when a fallback ran", async () => {
    const t = setup();
    const { scholarId, artifactId, sessionId } = await seedApp(t);
    anthropicCreate.mockResolvedValue({
      model: "claude-opus-5-5",
      stop_reason: "end_turn",
      content: [
        { type: "fallback", from: { model: APP_AI_MODEL }, to: { model: "claude-opus-5-5" } },
        { type: "text", text: JSON.stringify({ line: "Yes.", mood: "literal" }) },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const result = await (await asUser(t, scholarId)).action(
      api.appAiActions.say,
      { artifactId, text: "Can you tell me where it is?" },
    );

    expect(result).toMatchObject({ ok: true, line: "Yes." });
    const [row] = await sessionRows(t, sessionId);
    expect(row.model).toBe("claude-opus-5-5");
  });
});

describe("app-AI calls are bounded before they write", () => {
  async function exhaustAppAiWindow(t: T, userId: Id<"users">) {
    const now = Date.now();
    await t.run(async (ctx) => {
      for (let index = 0; index < 60; index++) {
        await ctx.db.insert("llmLeases", {
          userId,
          surface: APP_AI_LLM_SURFACE,
          startedAt: now - 60_000 + index,
          active: false,
        });
      }
    });
  }

  const turnRows = (t: T, sessionId: Id<"sessions">) =>
    t.run((ctx) =>
      ctx.db
        .query("appAiTurns")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );

  test("a call refused by the rate limit records nothing", async () => {
    const t = setup();
    const { scholarId, artifactId, sessionId } = await seedApp(t);
    await exhaustAppAiWindow(t, scholarId);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const scholar = await asUser(t, scholarId);

    const said = await scholar.action(api.appAiActions.say, {
      artifactId,
      text: "Hi",
    });
    const judged = await scholar.action(api.appAiActions.judge, {
      artifactId,
      judgeId: "fractions",
      answer: "3/4",
    });

    expect(said).toMatchObject({ ok: false, code: "busy" });
    expect(judged).toMatchObject({ ok: false, code: "busy" });
    expect(await turnRows(t, sessionId)).toEqual([]);
    expect(anthropicCreate).not.toHaveBeenCalled();
  });

  test("a call the turn refuses still spends an app-AI start and writes no row", async () => {
    const t = setup();
    const { scholarId, artifactId, sessionId } = await seedApp(t, {
      withCharacter: false,
    });

    const result = await (await asUser(t, scholarId)).action(
      api.appAiActions.say,
      { artifactId, text: "Hi" },
    );

    expect(result).toEqual({ ok: false, code: "unavailable" });
    expect(await turnRows(t, sessionId)).toEqual([]);
    const leases = await t.run((ctx) => ctx.db.query("llmLeases").collect());
    expect(leases).toHaveLength(1);
    expect(leases[0]).toMatchObject({
      surface: APP_AI_LLM_SURFACE,
      active: false,
    });
  });

  test("failed rows cannot push the scene out of the actor's reach", async () => {
    const t = setup();
    const { scholarId, artifactId, sessionId } = await seedApp(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("appAiTurns", {
        sessionId,
        artifactId,
        kind: "exchange",
        status: "done",
        scholarLine: "Rule one",
        line: "Stored.",
        mood: "literal",
        createdAt: 1,
      });
      for (let index = 0; index < 250; index++) {
        await ctx.db.insert("appAiTurns", {
          sessionId,
          artifactId,
          kind: "exchange",
          status: "failed",
          scholarLine: `noise ${index}`,
          createdAt: 10 + index,
        });
      }
    });
    anthropicCreate.mockResolvedValue(toolReply({ line: "Ok.", mood: "literal" }));

    await (await asUser(t, scholarId)).action(api.appAiActions.say, {
      artifactId,
      text: "Rule two",
    });

    expect(anthropicCreate.mock.calls[0][0].messages).toEqual([
      { role: "user", content: "Rule one" },
      { role: "assistant", content: "[mood: literal] Stored." },
      { role: "user", content: "Rule two" },
    ]);
  });
});

describe("deleting a session", () => {
  async function seedTurns(t: T) {
    const app = await seedApp(t);
    await t.run(async (ctx) => {
      for (const kind of ["exchange", "direction", "aside", "judgment"] as const) {
        await ctx.db.insert("appAiTurns", {
          sessionId: app.sessionId,
          artifactId: app.artifactId,
          kind,
          status: "done",
          scholarLine: "my rule",
          createdAt: 1,
        });
      }
    });
    return app;
  }

  test("deleteSessionCascade removes the session's in-app AI record", async () => {
    const t = setup();
    const { sessionId } = await seedTurns(t);

    await t.run((ctx) => deleteSessionCascade(ctx, {}, sessionId));

    expect(await t.run((ctx) => ctx.db.query("appAiTurns").collect())).toEqual(
      [],
    );
  });

  test("the dev purge removes it too", async () => {
    const t = setup();
    const { sessionId } = await seedTurns(t);

    await t.run((ctx) => deleteSessionInner(ctx, sessionId));

    expect(await t.run((ctx) => ctx.db.query("appAiTurns").collect())).toEqual(
      [],
    );
  });
});

describe("appAi.beginJudgment busy rule", () => {
  test("refuses while a recent judgment is pending, allows once it is stale", async () => {
    const t = setup();
    const { scholarId, artifactId, sessionId } = await seedApp(t);
    const now = Date.now();
    const pendingId = await t.run((ctx) =>
      ctx.db.insert("appAiTurns", {
        sessionId,
        artifactId,
        kind: "judgment",
        status: "pending",
        judgeId: "fractions",
        scholarLine: "1/2",
        createdAt: now - 5_000,
      }),
    );
    const args = {
      callerUserId: scholarId,
      artifactId,
      judgeId: "fractions",
      answer: "3/4",
    };

    expect(await t.mutation(internal.appAi.beginJudgment, args)).toMatchObject(
      { ok: false, code: "busy" },
    );
    await t.run((ctx) => ctx.db.patch(pendingId, { createdAt: now - 31_000 }));
    expect((await t.mutation(internal.appAi.beginJudgment, args)).ok).toBe(
      true,
    );
  });
});

describe("appAi.beginTurn busy rule", () => {
  test("refuses while a recent exchange is pending, allows once it is stale", async () => {
    const t = setup();
    const { scholarId, artifactId, sessionId } = await seedApp(t);
    const now = Date.now();
    const pendingId = await t.run((ctx) =>
      ctx.db.insert("appAiTurns", {
        sessionId,
        artifactId,
        kind: "exchange",
        status: "pending",
        scholarLine: "first",
        createdAt: now - 5_000,
      }),
    );

    const refused = await t.mutation(internal.appAi.beginTurn, {
      callerUserId: scholarId,
      artifactId,
      text: "second",
    });
    expect(refused).toMatchObject({ ok: false, code: "busy" });

    await t.run((ctx) => ctx.db.patch(pendingId, { createdAt: now - 31_000 }));
    const allowed = await t.mutation(internal.appAi.beginTurn, {
      callerUserId: scholarId,
      artifactId,
      text: "second",
    });
    expect(allowed.ok).toBe(true);
  });
});

describe("appAiActions.judge", () => {
  test("records a judgment and returns verdict and feedback", async () => {
    const t = setup();
    const { scholarId, artifactId, sessionId } = await seedApp(t);
    anthropicCreate.mockResolvedValue(
      toolReply({ verdict: "not_yet", feedback: "Look at the shaded parts again." }),
    );

    const result = await (await asUser(t, scholarId)).action(
      api.appAiActions.judge,
      { artifactId, judgeId: "fractions", answer: "1/2" },
    );

    expect(result).toMatchObject({
      ok: true,
      verdict: "not_yet",
      feedback: "Look at the shaded parts again.",
    });
    const rows = await t.run((ctx) =>
      ctx.db
        .query("appAiTurns")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    expect(rows[0]).toMatchObject({
      kind: "judgment",
      status: "done",
      judgeId: "fractions",
      scholarLine: "1/2",
      verdict: "not_yet",
    });
  });

  test("tells the judge which question the answer belongs to and records it", async () => {
    const t = setup();
    const { scholarId, artifactId, sessionId } = await seedApp(t);
    anthropicCreate.mockResolvedValue(toolReply({ verdict: "correct" }));

    await (await asUser(t, scholarId)).action(api.appAiActions.judge, {
      artifactId,
      judgeId: "fractions",
      answer: "3/4",
      context: { question: 2 },
    });

    expect(anthropicCreate.mock.calls[0][0].messages).toEqual([
      {
        role: "user",
        content: "<app_state>\nquestion: 2\n</app_state>\n<answer>\n3/4\n</answer>",
      },
    ]);
    const [row] = await t.run((ctx) =>
      ctx.db
        .query("appAiTurns")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    expect(row.appContext).toBe(JSON.stringify({ question: 2 }));
  });

  test("is unavailable for an unknown judge id", async () => {
    const t = setup();
    const { scholarId, artifactId } = await seedApp(t);

    const result = await (await asUser(t, scholarId)).action(
      api.appAiActions.judge,
      { artifactId, judgeId: "nope", answer: "1/2" },
    );

    expect(result).toEqual({ ok: false, code: "unavailable" });
    expect(anthropicCreate).not.toHaveBeenCalled();
  });

  test("fails rather than inventing a verdict the judge does not offer", async () => {
    const t = setup();
    const { scholarId, artifactId } = await seedApp(t);
    anthropicCreate.mockResolvedValue(toolReply({ verdict: "brilliant" }));

    const result = await (await asUser(t, scholarId)).action(
      api.appAiActions.judge,
      { artifactId, judgeId: "fractions", answer: "3/4" },
    );

    expect(result).toEqual({ ok: false, code: "failed" });
  });

  test("a refused judgment fails and records no verdict", async () => {
    const t = setup();
    const { scholarId, artifactId, sessionId } = await seedApp(t);
    anthropicCreate.mockResolvedValue(textReply("", "refusal"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await (await asUser(t, scholarId)).action(
      api.appAiActions.judge,
      { artifactId, judgeId: "fractions", answer: "3/4" },
    );

    expect(result).toEqual({ ok: false, code: "failed" });
    const [row] = await sessionRows(t, sessionId);
    expect(row).toMatchObject({ kind: "judgment", status: "failed" });
    expect(row.verdict).toBeUndefined();
  });
});

describe("appAi.listForSession", () => {
  async function seedRecord(t: T) {
    const app = await seedApp(t);
    await t.run(async (ctx) => {
      const base = {
        sessionId: app.sessionId,
        artifactId: app.artifactId,
        status: "done" as const,
      };
      await ctx.db.insert("appAiTurns", {
        ...base,
        kind: "exchange",
        scholarLine: "Hi",
        line: "Hello.",
        verdict: "rule_rejected",
        verdictOverride: { verdict: "rule_accepted", at: 5 },
        appContext: JSON.stringify({ stage: 2 }),
        createdAt: 1,
      });
      await ctx.db.insert("appAiTurns", {
        ...base,
        kind: "direction",
        direction: "Be gentler.",
        createdAt: 2,
      });
    });
    return app;
  }

  test("the owner sees the scene without directions or overrides", async () => {
    const t = setup();
    const { scholarId, sessionId } = await seedRecord(t);

    const rows = await (await asUser(t, scholarId)).query(
      api.appAi.listForSession,
      { sessionId },
    );

    expect(rows.map((row) => row.kind)).toEqual(["exchange"]);
    expect(rows[0].verdictOverride).toBeUndefined();
    // The verdict that stands — the tutor's overrule — not the one it replaced.
    expect(rows[0].verdict).toBe("rule_accepted");
    expect(rows[0]).not.toHaveProperty("appContext");
  });

  test("a teacher with access sees everything", async () => {
    const t = setup();
    const { scholarId, sessionId, institutionId } = await seedRecord(t);
    const teacherId = await seedStaffWithMembership(t, { institutionId });
    await grantStaffAccessToScholars(t, {
      staffUserId: teacherId,
      scholarIds: [scholarId],
    });

    const rows = await (await asUser(t, teacherId)).query(
      api.appAi.listForSession,
      { sessionId },
    );

    expect(rows.map((row) => row.kind)).toEqual(["exchange", "direction"]);
    expect(rows[0].verdictOverride?.verdict).toBe("rule_accepted");
    expect(rows[0].appContext).toBe(JSON.stringify({ stage: 2 }));
  });

  test("a teacher from another institution is refused", async () => {
    const t = setup();
    const { sessionId } = await seedRecord(t);
    const otherSchool = await seedTestInstitution(t, { slug: "other-school" });
    const outsider = await seedStaffWithMembership(t, {
      institutionId: otherSchool,
    });

    await expect(
      (await asUser(t, outsider)).query(api.appAi.listForSession, { sessionId }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("another scholar is refused", async () => {
    const t = setup();
    const { sessionId, institutionId } = await seedRecord(t);
    const otherScholar = await seedScholarInInstitution(t, { institutionId });

    await expect(
      (await asUser(t, otherScholar)).query(api.appAi.listForSession, {
        sessionId,
      }),
    ).rejects.toThrow(/Forbidden/);
  });
});
