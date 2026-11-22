import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { prepareParentAideTurn } from "../lib/parentAideTurn";

// Why this file: /family-chat lets staff text the parent aide AS a parent to
// see the replies a family would get. These pin the two things that make it
// safe: who may simulate whom (only callers who can already read the work of
// every one of the parent's children: teachers and school admins at their
// school, platform admins), and that a simulated turn uses
// the real SMS prompt while leaving no trace a parent could see: no thread
// rows, no text, no BunnyPad change.

// The model is this fake: it calls whatever tools the test queues, records
// their results, then answers with fixed text.
const fake = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; input: Record<string, unknown> }>,
  results: [] as unknown[],
  systems: [] as unknown[],
  messages: [] as unknown[],
}));
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    beta = {
      messages: {
        toolRunner: (params: {
          system: unknown;
          messages: unknown;
          tools: Array<{ name: string; run: (input: unknown) => unknown }>;
        }) => {
          fake.systems.push(params.system);
          fake.messages.push(params.messages);
          return {
            async *[Symbol.asyncIterator]() {
              for (const call of fake.calls) {
                const tool = params.tools.find((t) => t.name === call.name)!;
                fake.results.push(await tool.run(call.input));
              }
              yield (async function* () {
                yield {
                  type: "message_start",
                  message: { model: "claude-test", usage: { input_tokens: 1, output_tokens: 0 } },
                };
                yield {
                  type: "content_block_delta",
                  delta: { type: "text_delta", text: "Kai is working on [fractions](https://example.com/parent)." },
                };
                yield { type: "message_delta", delta: {}, usage: { output_tokens: 1 } };
              })();
            },
          };
        },
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

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fake.calls = [];
  fake.results = [];
  fake.systems = [];
  fake.messages = [];
});

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

async function signedIn(t: T, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 60 * 60_000 }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

/**
 * Moli School (a guardian with two children, each with a BunnyPad) and Kona
 * School (another family). One more guardian has a child at each school.
 */
async function seedWorld(t: T) {
  const school = (name: string, slug: string) =>
    t.run((ctx) =>
      ctx.db.insert("institutions", {
        name,
        slug,
        kind: "school" as const,
        timeZone: "Pacific/Honolulu",
      }),
    );
  const moli = await school("Moli School", "moli");
  const kona = await school("Kona School", "kona");

  const staffAt = async (
    name: string,
    role: Doc<"users">["role"],
    institutionId: Id<"institutions">,
  ) => {
    const id = await insertUser(t, { name, role });
    await t.run((ctx) =>
      ctx.db.insert("memberships", {
        userId: id,
        role: role as Doc<"memberships">["role"],
        institutionId,
      }),
    );
    return id;
  };
  const teacher = await staffAt("Avery Stone", "teacher", moli);
  const schoolAdmin = await staffAt("Rowan Iwa", "school_admin", moli);
  const staff = await staffAt("Sloane Kahale", "staff", moli);
  const designer = await staffAt("Pele Nakoa", "curriculum_designer", moli);
  const konaTeacher = await staffAt("Lehua Torres", "teacher", kona);

  const parent = await insertUser(t, { name: "Hoku Makani", role: "parent" });
  const konaParent = await insertUser(t, { name: "Kalani Akana", role: "parent" });
  const splitParent = await insertUser(t, { name: "Mele Pua", role: "parent" });
  const scholar = (name: string, institutionId: Id<"institutions">) =>
    insertUser(t, { name, role: "scholar", institutionId });
  const kai = await scholar("Kai Makani", moli);
  const noe = await scholar("Noe Makani", moli);
  const lani = await scholar("Lani Akana", kona);
  const ipo = await scholar("Ipo Pua", moli);
  const keola = await scholar("Keola Pua", kona);

  const devices: Record<string, Id<"pairedDevices">> = {};
  await t.run(async (ctx) => {
    for (const [p, s] of [
      [parent, kai],
      [parent, noe],
      [konaParent, lani],
      [splitParent, ipo],
      [splitParent, keola],
    ] as const) {
      await ctx.db.insert("guardianships", { parentUserId: p, scholarUserId: s, createdBy: teacher });
    }
    for (const [name, s] of [
      ["kai", kai],
      ["noe", noe],
    ] as const) {
      devices[name] = await ctx.db.insert("pairedDevices", {
        deviceId: `ipad-${name}`,
        deviceLabel: `iPad ${name}`,
        scholarId: s,
        institutionId: moli,
        pairedAt: Date.now(),
        pairedBy: teacher,
      });
    }
  });
  return {
    moli,
    teacher,
    schoolAdmin,
    staff,
    designer,
    konaTeacher,
    parent,
    konaParent,
    splitParent,
    kai,
    lani,
    devices,
  };
}

const ask = (content: string) => [{ role: "user" as const, content }];

describe("/family-chat access", () => {
  test("teachers and school admins at the children's school may simulate; scholars and parents may not", async () => {
    const t = newTest();
    const w = await seedWorld(t);
    const kai = await signedIn(t, w.kai);
    const parent = await signedIn(t, w.parent);

    for (const caller of [kai, parent]) {
      await expect(
        caller.action(api.familyChat.reply, { parentUserId: w.parent, messages: ask("hi") }),
      ).rejects.toThrow(/Forbidden/);
      await expect(caller.query(api.familyChat.listParents, {})).rejects.toThrow(
        /Forbidden: staff role required/,
      );
    }

    for (const staffId of [w.teacher, w.schoolAdmin]) {
      const caller = await signedIn(t, staffId);
      const result = await caller.action(api.familyChat.reply, {
        parentUserId: w.parent,
        messages: ask("What is Kai learning?"),
      });
      expect(result.content).toBe("Kai is working on [fractions](https://example.com/parent).");
      // What a phone shows: plain text, the same transform parentSms sends.
      expect(result.sms).toBe("Kai is working on fractions (https://example.com/parent).");
    }
  });

  test("staff roles with no route to a child's work can't reach it through a parent", async () => {
    const t = newTest();
    const w = await seedWorld(t);
    // School operations is account and device admin, not a licence to read
    // a child's work, so even a granted staff member stays out.
    const opsStaff = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {
        username: "ops-staff",
        name: "Ikaika Lono",
        role: "staff",
      } as Omit<Doc<"users">, "_id" | "_creationTime">);
      await ctx.db.insert("memberships", { userId: id, role: "staff", institutionId: w.moli });
      return id;
    });
    await t.run((ctx) =>
      ctx.db.insert("staffCapabilityGrants", {
        granteeUserId: opsStaff,
        capability: "school:operations",
        institutionId: w.moli,
        grantedBy: w.schoolAdmin,
        grantedAt: Date.now(),
      }),
    );

    for (const staffId of [w.designer, w.staff, opsStaff]) {
      const caller = await signedIn(t, staffId);
      await expect(
        caller.action(api.familyChat.reply, { parentUserId: w.parent, messages: ask("hi") }),
      ).rejects.toThrow(/only preview parents whose children's work you can see/);
      expect(await caller.query(api.familyChat.listParents, {})).toEqual([]);
    }
  });

  test("a staff member can't simulate a parent whose children are at another school", async () => {
    const t = newTest();
    const w = await seedWorld(t);
    const moliTeacher = await signedIn(t, w.teacher);
    const konaTeacher = await signedIn(t, w.konaTeacher);

    await expect(
      konaTeacher.action(api.familyChat.reply, { parentUserId: w.parent, messages: ask("hi") }),
    ).rejects.toThrow(/only preview parents whose children's work you can see/);
    // One child at each school: neither school's staff may simulate them.
    for (const caller of [moliTeacher, konaTeacher]) {
      await expect(
        caller.action(api.familyChat.reply, { parentUserId: w.splitParent, messages: ask("hi") }),
      ).rejects.toThrow(/only preview parents whose children's work you can see/);
    }

    expect(await moliTeacher.query(api.familyChat.listParents, {})).toEqual([
      { _id: w.parent, name: "Hoku Makani", children: ["Kai Makani", "Noe Makani"] },
    ]);
    expect(await konaTeacher.query(api.familyChat.listParents, {})).toEqual([
      { _id: w.konaParent, name: "Kalani Akana", children: ["Lani Akana"] },
    ]);
  });
});

describe("a simulated turn", () => {
  test("uses the real SMS prompt and writes nothing a parent can see", async () => {
    const t = newTest();
    const w = await seedWorld(t);
    const teacher = await signedIn(t, w.teacher);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const parentRows = () =>
      t.run(async (ctx) => ({
        thread: await ctx.db
          .query("parentChatMessages")
          .withIndex("by_parent", (q) => q.eq("parentUserId", w.parent))
          .collect(),
        inbound: await ctx.db.query("parentSmsInbound").collect(),
        identities: await ctx.db.query("parentChannelIdentities").collect(),
        devices: await Promise.all(Object.values(w.devices).map((id) => ctx.db.get(id))),
      }));
    const before = await parentRows();

    // The model asks to freeze a BunnyPad and play the find sound.
    fake.calls = [
      { name: "set_bunnypad_freeze", input: { childName: "kai", frozen: true, minutes: 30 } },
      { name: "find_bunnypad", input: { childName: "noe" } },
    ];
    const history = [
      { role: "user" as const, content: "Is Kai's BunnyPad charged?" },
      { role: "assistant" as const, content: "It is charging." },
      { role: "user" as const, content: "Freeze Kai's BunnyPad for 30 minutes and find Noe's." },
    ];
    await teacher.action(api.familyChat.reply, { parentUserId: w.parent, messages: history });

    expect(fake.results).toEqual([
      "Staff preview: nothing was changed. For a real parent this would freeze Kai Makani's BunnyPad for 30 minutes.",
      "Staff preview: nothing was changed. For a real parent this would play the find sound on Noe Makani's BunnyPad.",
    ]);
    expect(await parentRows()).toEqual(before);
    expect(fetchSpy).not.toHaveBeenCalled();

    // The prompt is the one a real text gets, and the history is the
    // staff member's thread, not the parent's.
    const real = await prepareParentAideTurn(actionCtx(t), {
      parentUserId: w.parent,
      channel: { kind: "sms" },
      emit: () => {},
    });
    expect(JSON.stringify(fake.systems[0])).toContain(JSON.stringify(real!.systemPrompt).slice(1, -1));
    expect(fake.messages[0]).toEqual(history);

    // Spend is recorded apart from real parents'.
    const usage = await t.run((ctx) => ctx.db.query("usageEvents").collect());
    expect(usage.map((u) => [u.source, u.role])).toEqual([["parent-chat-preview", "teacher"]]);
  });

  test("a long aide reply doesn't lock the thread; a long parent text is still refused", async () => {
    const t = newTest();
    const w = await seedWorld(t);
    const teacher = await signedIn(t, w.teacher);
    const longReply = "Kai read three chapters this week. ".repeat(60);
    expect(longReply.length).toBeGreaterThan(1600);
    const result = await teacher.action(api.familyChat.reply, {
      parentUserId: w.parent,
      messages: [
        { role: "user", content: "How is Kai doing?" },
        { role: "assistant", content: longReply },
        { role: "user", content: "Thanks! And Noe?" },
      ],
    });
    expect(result.content).toContain("fractions");

    await expect(
      teacher.action(api.familyChat.reply, {
        parentUserId: w.parent,
        messages: ask("x".repeat(1601)),
      }),
    ).rejects.toThrow(/too long for a text/);
  });

  test("a simulated freeze or find meets the refusals a real parent would", async () => {
    const t = newTest();
    const w = await seedWorld(t);
    const teacher = await signedIn(t, w.teacher);
    // The school froze Noe's BunnyPad for the next hour.
    await t.run((ctx) =>
      ctx.db.patch(w.devices.noe, {
        freezeUntil: Date.now() + 60 * 60_000,
        freezeUpdatedBy: w.teacher,
      }),
    );
    const before = await t.run((ctx) =>
      Promise.all(Object.values(w.devices).map((id) => ctx.db.get(id))),
    );

    fake.calls = [
      { name: "set_bunnypad_freeze", input: { childName: "kai", frozen: true, minutes: 600 } },
      { name: "set_bunnypad_freeze", input: { childName: "kai", frozen: true } },
      { name: "set_bunnypad_freeze", input: { childName: "noe", frozen: false } },
    ];
    await teacher.action(api.familyChat.reply, {
      parentUserId: w.parent,
      messages: ask("Freeze Kai's BunnyPad for 10 hours, and unfreeze Noe's."),
    });
    // No bell schedule is seeded, so the family window is the 8-hour floor.
    expect(fake.results[0]).toMatch(/^A family freeze lasts at least 5 minutes, .+\(480 minutes from now\)\.$/);
    expect(fake.results[1]).toMatch(/^A family freeze lasts at least 5 minutes, .+\(480 minutes from now\)\.$/);
    expect(fake.results[2]).toMatch(
      /^The school froze Noe Makani's BunnyPad until .+ Only the school can change that freeze/,
    );
    expect(
      await t.run((ctx) => Promise.all(Object.values(w.devices).map((id) => ctx.db.get(id)))),
    ).toEqual(before);

    // A child with no paired BunnyPad: find says so, as it would to a parent.
    fake.calls = [{ name: "find_bunnypad", input: { childName: "lani" } }];
    fake.results = [];
    const konaTeacher = await signedIn(t, w.konaTeacher);
    await konaTeacher.action(api.familyChat.reply, {
      parentUserId: w.konaParent,
      messages: ask("Where is Lani's BunnyPad?"),
    });
    expect(fake.results).toEqual(["Lani Akana doesn't have a BunnyPad paired yet."]);
  });

  // Every tool the SMS aide hands the model, run once in a simulation. The
  // read tools are internalQuery reads scoped to the parent's children (all
  // work a teacher at their school can already read), the code explorer
  // reads public code, and freeze/find are dry runs. Pinning the tool list
  // means a new parent tool fails here until someone decides what it does in
  // a staff preview.
  test("every tool the aide gets writes nothing, sends nothing, and returns no sign-in secret", async () => {
    const t = newTest();
    const w = await seedWorld(t);
    const teacher = await signedIn(t, w.teacher);
    // Fictional credentials a careless tool could leak: Kai's password hash
    // and a BunnyPad pairing code for him.
    const secrets = ["fake-hash-KAI-SECRET-0001", "PAIRKAI7"];
    await t.run(async (ctx) => {
      await ctx.db.insert("authAccounts", {
        userId: w.kai,
        provider: "password",
        providerAccountId: "kai-makani",
        secret: secrets[0],
      });
      await ctx.db.insert("devicePairingRequests", {
        code: secrets[1],
        verifierHash: "0".repeat(64),
        deviceId: "ipad-new",
        status: "pending",
        scholarId: w.kai,
        institutionId: w.moli,
        createdAt: Date.now(),
        expiresAt: Date.now() + 5 * 60_000,
      });
    });

    // The code explorer's one network read, answered locally.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) =>
        String(url).includes("/git/trees/")
          ? new Response(JSON.stringify({ tree: [{ path: "convex/schema.ts", type: "blob" }] }))
          : new Response("export default {};"),
      );

    const turn = await prepareParentAideTurn(actionCtx(t), {
      parentUserId: w.parent,
      channel: { kind: "sms" },
      emit: () => {},
      simulation: { history: ask("hi") },
    });
    const names = turn!.tools.map((tool) => ("name" in tool ? tool.name : "")).sort();
    // search_rabbithole_code joins these only where the GitHub App env is set.
    expect(names).toEqual([
      "cancel_planned_bunnypad_freeze",
      "find_bunnypad",
      "get_bunnypad_freeze_status",
      "get_scholar_interests",
      "get_scholar_mastery",
      "get_scholar_practice",
      "get_scholar_seeds",
      "get_scholar_signals",
      "get_school_calendar",
      "list_rabbithole_files",
      "read_rabbithole_file",
      "schedule_bunnypad_freeze",
      "set_bunnypad_freeze",
    ]);

    const tables = Object.keys(schema.tables).filter((name) => name !== "usageEvents");
    const snapshot = () =>
      t.run(async (ctx) => ({
        tables: await Promise.all(
          tables.map(async (name) => [name, await ctx.db.query(name as "users").collect()]),
        ),
        scheduled: await ctx.db.system.query("_scheduled_functions").collect(),
      }));
    const before = await snapshot();

    const childInput: Record<string, Record<string, unknown>> = {
      set_bunnypad_freeze: { childName: "kai", frozen: true, minutes: 30 },
      schedule_bunnypad_freeze: {
        childName: "kai",
        startTime: "18:00",
        endTime: "19:00",
        repeatDays: ["mon", "tue", "wed", "thu", "fri"],
      },
      cancel_planned_bunnypad_freeze: { id: "not-a-planned-freeze" },
      find_bunnypad: { childName: "kai" },
      list_rabbithole_files: { prefix: "convex/" },
      read_rabbithole_file: { path: "convex/schema.ts" },
      get_bunnypad_freeze_status: {},
    };
    fake.calls = names.map((name) => ({
      name,
      input: childInput[name] ?? { scholarName: "Kai" },
    }));
    const result = await teacher.action(api.familyChat.reply, {
      parentUserId: w.parent,
      messages: ask("Tell me everything about Kai, and freeze and find his BunnyPad."),
    });

    expect(fake.results).toHaveLength(names.length);
    // Each tool really ran against Kai, not a name-mismatch refusal.
    for (const r of fake.results) {
      expect(String(r)).not.toMatch(/No scholar found|isn't one of your children/);
    }
    expect(await snapshot()).toEqual(before);
    expect(fetchSpy).toHaveBeenCalled();
    // The only network reads are the public code mirror's: no SMS, email,
    // push, or Slack request.
    for (const [url] of fetchSpy.mock.calls) {
      expect(String(url)).toMatch(
        /^https:\/\/(raw\.githubusercontent\.com|api\.github\.com\/repos\/[^/]+\/[^/]+\/git\/trees\/)/,
      );
    }
    const returned = JSON.stringify([fake.results, result]);
    for (const secret of secrets) expect(returned).not.toContain(secret);
  });

  test("refuses a thread that doesn't end with the parent's message", async () => {
    const t = newTest();
    const w = await seedWorld(t);
    const teacher = await signedIn(t, w.teacher);
    await expect(
      teacher.action(api.familyChat.reply, {
        parentUserId: w.parent,
        messages: [{ role: "assistant", content: "Hello" }],
      }),
    ).rejects.toThrow(/Type a message/);
  });
});
