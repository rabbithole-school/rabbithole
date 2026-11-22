import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import type { ActionCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  prepareParentAideTurn,
  runParentAideTurn,
  type ParentAideChannel,
} from "../lib/parentAideTurn";
import {
  READ_ONLY_ACCOUNT_ERROR,
  VIEWING_AS_READ_ONLY_ERROR,
} from "../lib/auth";

// Why this file: the parent aide's BunnyPad freeze tools are the first parent
// WRITE an LLM can trigger. These pin the boundaries the tools add on top of
// freezeFromGuardian: the guardian is the turn's parent (never model input),
// the child comes only from that parent's guardianships, and a read-only
// account or a View as session is refused in words the aide can say back.

// The HTTP case below drives the real /parent-chat-stream route; its model is
// this fake, which calls whatever tool the test queues and records the result.
const fake = vi.hoisted(() => ({
  call: null as null | { name: string; input: Record<string, unknown> },
  results: [] as unknown[],
  systems: [] as unknown[],
}));
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    beta = {
      messages: {
        toolRunner: (params: {
          system: unknown;
          tools: Array<{ name: string; run: (input: unknown) => unknown }>;
        }) => (fake.systems.push(params.system), {
          async *[Symbol.asyncIterator]() {
            if (fake.call) {
              const tool = params.tools.find((t) => t.name === fake.call!.name)!;
              fake.results.push(await tool.run(fake.call.input));
            }
            yield (async function* () {
              yield {
                type: "message_start",
                message: { model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } },
              };
              yield { type: "content_block_delta", delta: { type: "text_delta", text: "Done." } };
              yield { type: "message_delta", delta: {}, usage: { output_tokens: 1 } };
            })();
          },
        }),
      },
    };
  }
  return { default: FakeAnthropic, Anthropic: FakeAnthropic };
});

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const newTest = () => convexTest(schema, modules);
type T = ReturnType<typeof newTest>;

afterEach(() => {
  vi.unstubAllEnvs();
  fake.call = null;
  fake.results = [];
  fake.systems = [];
});

/** An ActionCtx over convex-test, so the lib functions run unmodified. */
function actionCtx(t: T): ActionCtx {
  type Call = (...args: unknown[]) => Promise<unknown>;
  const run = t as unknown as { query: Call; mutation: Call; action: Call };
  return {
    runQuery: (...args: unknown[]) => run.query(...args),
    runMutation: (...args: unknown[]) => run.mutation(...args),
    runAction: (...args: unknown[]) => run.action(...args),
  } as unknown as ActionCtx;
}

async function insertUser(t: T, fields: Partial<Doc<"users">> & { name: string }) {
  return await t.run((ctx) =>
    ctx.db.insert("users", {
      username: fields.name.toLowerCase().replaceAll(" ", "-"),
      ...fields,
    } as Omit<Doc<"users">, "_id" | "_creationTime">),
  );
}

/**
 * One school with a teacher. Hoku Makani's guardian has two children with
 * BunnyPads (Kai, Noe); another family's child (Lani) has one too.
 */
async function seedWorld(t: T, guardianRole: Doc<"users">["role"] = "parent") {
  const institutionId = await t.run((ctx) =>
    ctx.db.insert("institutions", {
      name: "Moli School",
      slug: "moli",
      kind: "school" as const,
      timeZone: "Pacific/Honolulu",
    }),
  );
  const teacher = await insertUser(t, { name: "Avery Stone", role: "teacher" });
  await t.run((ctx) =>
    ctx.db.insert("memberships", { userId: teacher, role: "teacher", institutionId }),
  );
  const parent = await insertUser(t, { name: "Hoku Makani", role: guardianRole });
  const otherParent = await insertUser(t, { name: "Lehua Torres", role: "parent" });
  const scholar = (name: string) =>
    insertUser(t, { name, role: "scholar", institutionId });
  const kai = await scholar("Kai Makani");
  const noe = await scholar("Noe Makani");
  const lani = await scholar("Lani Torres");
  const devices: Record<string, Id<"pairedDevices">> = {};
  await t.run(async (ctx) => {
    for (const [p, s] of [
      [parent, kai],
      [parent, noe],
      [otherParent, lani],
    ] as const) {
      await ctx.db.insert("guardianships", {
        parentUserId: p,
        scholarUserId: s,
        createdBy: teacher,
      });
    }
    for (const [name, s] of [
      ["kai", kai],
      ["noe", noe],
      ["lani", lani],
    ] as const) {
      devices[name] = await ctx.db.insert("pairedDevices", {
        deviceId: `ipad-${name}`,
        deviceLabel: `iPad ${name}`,
        scholarId: s,
        institutionId,
        pairedAt: Date.now(),
        pairedBy: teacher,
      });
    }
  });
  return { institutionId, teacher, parent, otherParent, kai, noe, lani, devices };
}

type RunnableTool = { name: string; run: (input: unknown) => Promise<unknown> };

async function freezeTools(
  t: T,
  parentUserId: Id<"users">,
  channel: ParentAideChannel = { kind: "web", selectedChildId: null },
  emitted: Array<Record<string, unknown>> = [],
) {
  const turn = await prepareParentAideTurn(actionCtx(t), {
    parentUserId,
    channel,
    emit: (data) => emitted.push(data),
  });
  const tools = turn!.tools as unknown as RunnableTool[];
  const named = (name: string) => tools.find((tool) => tool.name === name)!;
  return {
    turn: turn!,
    status: async () =>
      JSON.parse(String(await named("get_bunnypad_freeze_status").run({}))),
    set: async (input: Record<string, unknown>) =>
      String(await named("set_bunnypad_freeze").run(input)),
    plan: async (input: Record<string, unknown>) =>
      String(await named("schedule_bunnypad_freeze").run(input)),
    cancelPlan: async (input: Record<string, unknown>) =>
      String(await named("cancel_planned_bunnypad_freeze").run(input)),
  };
}

const rowOf = (t: T, id: Id<"pairedDevices">) => t.run((ctx) => ctx.db.get(id));

describe("parent aide BunnyPad freeze tools", () => {
  test("plan \"6 to 7pm every weeknight\", list it, and cancel it", async () => {
    vi.useFakeTimers();
    // Monday 2 Nov 2026, 5pm HST.
    vi.setSystemTime(new Date("2026-11-03T03:00:00.000Z"));
    try {
      const t = newTest();
      const { parent, kai } = await seedWorld(t);
      const { plan, status, cancelPlan } = await freezeTools(t, parent);

      expect(
        await plan({
          childName: "Kai",
          startTime: "18:00",
          endTime: "19:00",
          repeatDays: ["mon", "tue", "wed", "thu", "fri"],
        }),
      ).toContain("Kai Makani's BunnyPad will be frozen 6pm to 7pm every weekday, starting Mon, Nov 2");
      // A bad day name changes nothing.
      expect(
        await plan({ childName: "Kai", startTime: "18:00", endTime: "19:00", repeatDays: ["funday"] }),
      ).toMatch(/mon/);

      const [kaiStatus] = await status();
      expect(kaiStatus.plannedFreezes).toEqual([
        { id: expect.any(String), when: "6pm to 7pm every weekday" },
      ]);
      expect(await cancelPlan({ id: kaiStatus.plannedFreezes[0].id })).toContain(
        "Removed the 6pm to 7pm every weekday freeze",
      );
      expect(
        await t.run((ctx) =>
          ctx.db
            .query("scheduledFreezes")
            .withIndex("by_scholar", (q) => q.eq("scholarId", kai))
            .collect(),
        ),
      ).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("\"until 5:33pm\" goes in as an end time, not minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-03T03:00:00.000Z")); // 5pm HST
    try {
      const t = newTest();
      const { parent, devices } = await seedWorld(t);
      const { set } = await freezeTools(t, parent);
      expect(await set({ childName: "Kai", frozen: true, untilTime: "17:33" })).toContain(
        "5:33",
      );
      expect((await rowOf(t, devices.kai))?.freezeUntil).toBe(
        Date.parse("2026-11-03T03:33:00.000Z"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test("freeze, status, and unfreeze one child's BunnyPad; the audit names the channel", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T03:00:00.000Z"));
    try {
      const t = newTest();
      const { parent, devices } = await seedWorld(t);
      const { set, status } = await freezeTools(t, parent);

      expect(await status()).toEqual([
        { child: "Kai Makani", bunnyPads: [{ device: "iPad kai", frozen: false }] },
        { child: "Noe Makani", bunnyPads: [{ device: "iPad noe", frozen: false }] },
      ]);

      const frozen = await set({ childName: "kai", frozen: true, minutes: 90 });
      expect(frozen).toMatch(
        /^Kai Makani's BunnyPad will be frozen until .+\. The freeze takes effect once the BunnyPad is connected\.$/,
      );
      const end = Date.parse("2026-11-02T04:30:00.000Z");
      expect(await rowOf(t, devices.kai)).toMatchObject({
        freezeUntil: end,
        freezeUpdatedBy: parent,
      });
      expect((await rowOf(t, devices.noe))!.freezeUntil).toBeUndefined();

      const [kaiStatus, noeStatus] = await status();
      expect(kaiStatus.bunnyPads[0]).toMatchObject({
        frozen: true,
        frozenBy: "family",
        setByYou: true,
      });
      expect(typeof kaiStatus.bunnyPads[0].frozenUntil).toBe("string");
      expect(noeStatus.bunnyPads[0]).toEqual({ device: "iPad noe", frozen: false });

      expect(await set({ childName: "Kai Makani", frozen: false })).toBe(
        "Kai Makani's BunnyPad will be unfrozen. That takes effect once the BunnyPad is connected.",
      );
      expect((await rowOf(t, devices.kai))!.freezeUntil).toBeUndefined();

      const audits = await t.run((ctx) =>
        ctx.db
          .query("auditLog")
          .filter((q) => q.eq(q.field("action"), "device.freeze.start"))
          .collect(),
      );
      expect(audits).toHaveLength(1);
      expect(audits[0].detail).toContain("via parent_app");
    } finally {
      vi.useRealTimers();
    }
  });

  test("an SMS turn records the SMS source", async () => {
    const t = newTest();
    const { parent } = await seedWorld(t);
    const { set } = await freezeTools(t, parent, { kind: "sms" });
    await set({ childName: "Noe", frozen: true, minutes: 30 });
    const audits = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .filter((q) => q.eq(q.field("action"), "device.freeze.start"))
        .collect(),
    );
    expect(audits.map((row) => row.detail?.includes("via parent_sms"))).toEqual([true]);
  });

  test("a child who isn't theirs, or an ambiguous name, changes nothing", async () => {
    const t = newTest();
    const { parent, devices } = await seedWorld(t);
    const { set, status } = await freezeTools(t, parent);

    expect(await set({ childName: "Lani", frozen: true, minutes: 30 })).toBe(
      `"Lani" isn't one of your children, so I can't change their BunnyPad.`,
    );
    expect(await set({ childName: "Makani", frozen: true, minutes: 30 })).toMatch(
      /could be Kai Makani or Noe Makani/,
    );
    for (const id of Object.values(devices)) {
      expect((await rowOf(t, id))!.freezeUntil).toBeUndefined();
    }
    // Status lists only this parent's children.
    expect(JSON.stringify(await status())).not.toContain("Lani");
  });

  test("a model-supplied guardian or scholar id is ignored", async () => {
    const t = newTest();
    const { parent, otherParent, lani, devices } = await seedWorld(t);
    const { set } = await freezeTools(t, parent);

    // The parent's own child, with another family's ids smuggled alongside.
    await set({
      childName: "Kai",
      frozen: true,
      minutes: 30,
      guardianUserId: otherParent,
      scholarId: lani,
    });
    expect(await rowOf(t, devices.kai)).toMatchObject({ freezeUpdatedBy: parent });
    expect((await rowOf(t, devices.lani))!.freezeUntil).toBeUndefined();

    // And the other family's tools can't reach this family's child, whatever
    // the model passes.
    const other = await freezeTools(t, otherParent);
    expect(
      await other.set({ childName: "Kai", frozen: false, guardianUserId: parent }),
    ).toMatch(/isn't one of your children/);
    expect((await rowOf(t, devices.kai))!.freezeUntil).toBeDefined();

    // Neither tool's schema offers a guardian field to fill.
    const tools = other.turn.tools as unknown as Array<{
      name: string;
      input_schema: { properties: Record<string, unknown> };
    }>;
    for (const name of ["get_bunnypad_freeze_status", "set_bunnypad_freeze"]) {
      const tool = tools.find((candidate) => candidate.name === name)!;
      expect(Object.keys(tool.input_schema.properties)).not.toContain("guardianUserId");
    }
  });

  test("a school freeze is reported back, not overridden", async () => {
    const t = newTest();
    const { teacher, parent, devices } = await seedWorld(t);
    await t.run((ctx) =>
      ctx.db.patch(devices.kai, {
        freezeUntil: Date.now() + 60 * 60_000,
        freezeUpdatedBy: teacher,
      }),
    );
    const emitted: Array<Record<string, unknown>> = [];
    const { set, status } = await freezeTools(t, parent, undefined, emitted);

    expect((await status())[0].bunnyPads[0]).toMatchObject({
      frozen: true,
      frozenBy: "school",
      setByYou: false,
    });
    for (const input of [
      { childName: "Kai", frozen: false },
      { childName: "Kai", frozen: true, minutes: 10 },
    ]) {
      expect(await set(input)).toMatch(
        /^The school froze Kai Makani's BunnyPad until .+ please ask Kai Makani's teacher\.$/,
      );
    }
    expect(await rowOf(t, devices.kai)).toMatchObject({ freezeUpdatedBy: teacher });
    // The refusal reaches the activity row as a failure (toolActivityGroups'
    // isFailureResult), not as a neutral "done".
    const results = emitted
      .map((e) => e.toolComplete as { name: string; result: string } | undefined)
      .filter((e) => e?.name === "set_bunnypad_freeze")
      .map((e) => e!.result);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.startsWith("Failed: The school froze"))).toBe(true);
  });

  test("minutes under 5 or past the family window are refused in words", async () => {
    const t = newTest();
    const { parent, devices } = await seedWorld(t);
    const { set } = await freezeTools(t, parent);
    for (const minutes of [undefined, 4, 481]) {
      // No bell schedule is seeded, so the window is the 8-hour floor.
      expect(await set({ childName: "Kai", frozen: true, minutes })).toMatch(
        /^A family freeze lasts at least 5 minutes, and right now it can run until .+ at the latest \(480 minutes from now\)\.$/,
      );
    }
    expect((await rowOf(t, devices.kai))!.freezeUntil).toBeUndefined();
  });

  test("a read-only account is refused, whichever channel reached the tool", async () => {
    const t = newTest();
    const { parent, devices } = await seedWorld(t);
    // Tools prepared first, then the account goes read-only: the mutation's
    // own check is what refuses, not the route in front of it.
    const { set } = await freezeTools(t, parent, { kind: "sms" });
    await t.run((ctx) => ctx.db.patch(parent, { readOnly: true }));
    expect(await set({ childName: "Kai", frozen: true, minutes: 30 })).toBe(
      READ_ONLY_ACCOUNT_ERROR,
    );
    expect((await rowOf(t, devices.kai))!.freezeUntil).toBeUndefined();
  });
});

describe("the turn carries the current school time for end-time requests", () => {
  // "Freeze it until 8pm" needs now in the child's school zone. It rides as
  // uncached dynamic system text, so the cached prompt stays byte-stable.
  test("built per turn in the school's zone, outside the cached prompt, on both channels", async () => {
    vi.useFakeTimers();
    // Sunday 5:00 PM in Honolulu: 8pm is 180 minutes away.
    vi.setSystemTime(new Date("2026-11-02T03:00:00.000Z"));
    try {
      vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
      const t = newTest();
      const { parent } = await seedWorld(t);
      const { turn } = await freezeTools(t, parent, { kind: "sms" });
      expect(turn.turnSystemText).toContain("Right now it is Sun, Nov 1, 2026, 5:00 PM HST.");
      expect(turn.systemPrompt).not.toContain("Right now it is");

      // Background: runParentAideTurn hands it to the model after the
      // cache breakpoint.
      const { Anthropic } = await import("@anthropic-ai/sdk");
      await runParentAideTurn(actionCtx(t), {
        anthropic: new Anthropic(),
        parentUserId: parent,
        content: "Freeze it until 8pm",
        channel: { kind: "sms" },
      });
      const [cached, dynamic] = fake.systems.at(-1) as Array<{
        text: string;
        cache_control?: unknown;
      }>;
      expect(cached.cache_control).toBeDefined();
      expect(cached.text).not.toContain("Right now it is");
      expect(dynamic).toEqual({ type: "text", text: turn.turnSystemText });

      // A later turn gets a fresh clock.
      vi.setSystemTime(new Date("2026-11-02T04:00:00.000Z"));
      const later = await freezeTools(t, parent, { kind: "sms" });
      expect(later.turn.turnSystemText).toContain("6:00 PM HST");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("/parent-chat-stream — the freeze tool sees the caller's identity", () => {
  // freezeFromGuardian's View as guard (assertNotImpersonating) reads the
  // auth session. These run the real route, so they prove the HTTP action's
  // identity reaches the mutation through the tool's ctx.runMutation.

  async function signedIn(t: T, userId: Id<"users">) {
    const sessionId = await t.run((ctx) =>
      ctx.db.insert("authSessions", {
        userId,
        expirationTime: Date.now() + 60 * 60_000,
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

  async function postTurn(
    t: T,
    as: ReturnType<T["withIdentity"]>,
    parentUserId: Id<"users">,
  ) {
    const assistantMsgId = await t.run((ctx) =>
      ctx.db.insert("parentChatMessages", {
        parentUserId,
        role: "assistant",
        content: "",
      }),
    );
    const res = await as.fetch("/parent-chat-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assistantMsgId }),
    });
    return { status: res.status, body: await res.text() };
  }

  test("signed in normally, the freeze lands", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("IMPERSONATION_ENABLED", "on");
    const t = newTest();
    const { parent, devices } = await seedWorld(t);
    const { as } = await signedIn(t, parent);
    fake.call = {
      name: "set_bunnypad_freeze",
      input: { childName: "Kai", frozen: true, minutes: 30 },
    };
    const res = await postTurn(t, as, parent);
    expect(res.status).toBe(200);
    expect(String(fake.results[0])).toMatch(/^Kai Makani's BunnyPad will be frozen until /);
    // The web route passes the clock line after the cache breakpoint too.
    const [, dynamic] = fake.systems.at(-1) as Array<{ text: string }>;
    expect(dynamic.text).toMatch(/^Right now it is /);
    expect(await rowOf(t, devices.kai)).toMatchObject({ freezeUpdatedBy: parent });
  });

  test("inside a View as session, the freeze is refused in words", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.stubEnv("IMPERSONATION_ENABLED", "on");
    const t = newTest();
    // A platform admin who is also a guardian, viewing as another parent. The
    // route runs the aide as the session's real owner, so the tools are the
    // admin's own family's — and the overlay must still stop the write.
    const { parent: admin, otherParent, devices } = await seedWorld(t, "platform_admin");
    const { as, sessionId } = await signedIn(t, admin);
    await t.run((ctx) =>
      ctx.db.insert("impersonationOverlays", {
        adminUserId: admin,
        adminSessionId: sessionId,
        targetUserId: otherParent,
        startedAt: Date.now(),
        expiresAt: Date.now() + 60 * 60_000,
        active: true,
      }),
    );
    fake.call = {
      name: "set_bunnypad_freeze",
      input: { childName: "Kai", frozen: true, minutes: 30 },
    };
    const res = await postTurn(t, as, admin);
    expect(res.status).toBe(200);
    expect(fake.results).toEqual([VIEWING_AS_READ_ONLY_ERROR]);
    expect((await rowOf(t, devices.kai))!.freezeUntil).toBeUndefined();
  });

  test("a read-only account never reaches the model", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const t = newTest();
    const { parent, devices } = await seedWorld(t);
    await t.run((ctx) => ctx.db.patch(parent, { readOnly: true }));
    const { as } = await signedIn(t, parent);
    fake.call = {
      name: "set_bunnypad_freeze",
      input: { childName: "Kai", frozen: true, minutes: 30 },
    };
    const res = await postTurn(t, as, parent);
    expect(res.status).toBe(403);
    expect(res.body).toContain(READ_ONLY_ACCOUNT_ERROR);
    expect(fake.results).toEqual([]);
    expect((await rowOf(t, devices.kai))!.freezeUntil).toBeUndefined();
  });
});

// TRA-625: the bedtime tools ride on the same turn, for the primary school's
// parents only, with the same closed-over guardian and strict child match.
describe("parent aide BunnyPad bedtime tools", () => {
  test("only a primary-school parent gets them, and they set one child's bedtime", async () => {
    const t = newTest();
    const { institutionId, parent, kai } = await seedWorld(t);

    const toolNames = async () => {
      const turn = await prepareParentAideTurn(actionCtx(t), {
        parentUserId: parent,
        channel: { kind: "sms" },
        emit: () => {},
      });
      return (turn!.tools as unknown as RunnableTool[]).map((tool) => tool.name);
    };
    expect(await toolNames()).not.toContain("set_bunnypad_bedtime");

    await t.run((ctx) => ctx.db.patch(institutionId, { isPrimary: true }));
    expect(await toolNames()).toEqual(
      expect.arrayContaining(["get_bunnypad_bedtime", "set_bunnypad_bedtime"]),
    );

    const turn = await prepareParentAideTurn(actionCtx(t), {
      parentUserId: parent,
      channel: { kind: "sms" },
      emit: () => {},
    });
    const named = (name: string) =>
      (turn!.tools as unknown as RunnableTool[]).find((tool) => tool.name === name)!;
    const set = async (input: Record<string, unknown>) =>
      String(await named("set_bunnypad_bedtime").run(input));

    expect(await set({ childName: "kai", bedtime: "7:30pm", wakeTime: "06:00" })).toMatch(
      /24-hour clock times/,
    );
    expect(await set({ childName: "kai", bedtime: "21:00", wakeTime: "06:00" })).toMatch(
      /Bedtime can be between/,
    );
    expect(await set({ childName: "lani", bedtime: "19:30", wakeTime: "06:00" })).toMatch(
      /isn't one of your children/,
    );
    expect(await set({ childName: "kai", bedtime: "19:30", wakeTime: "06:00" })).toBe(
      "Kai Makani's BunnyPad will sleep from 7:30pm to 6am every night, starting tonight.",
    );

    const rows = await t.run((ctx) => ctx.db.query("scholarBedtimes").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scholarId: kai, startMinutes: 1170, endMinutes: 360, updatedBy: parent });

    const status = JSON.parse(String(await named("get_bunnypad_bedtime").run({})));
    expect(status).toEqual([
      { child: "Kai Makani", bedtime: { window: "7:30pm to 6am", setBy: "family" } },
      { child: "Noe Makani", bedtime: { window: "8pm to 6am", setBy: "school" } },
    ]);
  });
});
