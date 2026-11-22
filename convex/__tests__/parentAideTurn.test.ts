import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import type { Anthropic } from "@anthropic-ai/sdk";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  prepareParentAideTurn,
  runParentAideTurn,
  type ParentAideChannel,
} from "../lib/parentAideTurn";
import { FLUENT_REPS } from "../lib/practice/scheduler";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Why this file: lib/parentAideTurn is the one place every parent-aide
// channel (the web panel today, SMS next) gets its scope, tools, and prompt.
// These pin that a turn reaches ONLY the parent's own children, whatever
// channel it arrives on, and that the SMS entry point persists the
// thread the web panel reads.

const newTest = () => convexTest(schema, modules);
type T = ReturnType<typeof newTest>;

async function seedUser(t: T, role: string, username: string) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: `Test ${username}`,
      username,
      role: role as Doc<"users">["role"],
    }),
  );
}

/** Two families: the parent of kai + noe, and lani from another family. */
async function seedFamilies(t: T) {
  const admin = await seedUser(t, "platform_admin", "admin");
  const parent = await seedUser(t, "parent", "parent");
  const kai = await seedUser(t, "scholar", "kai");
  const noe = await seedUser(t, "scholar", "noe");
  const lani = await seedUser(t, "scholar", "lani");
  const otherParent = await seedUser(t, "parent", "otherparent");
  await t.run(async (ctx) => {
    for (const [p, s] of [
      [parent, kai],
      [parent, noe],
      [otherParent, lani],
    ] as const) {
      await ctx.db.insert("guardianships", {
        parentUserId: p,
        scholarUserId: s,
        createdBy: admin,
      });
    }
  });
  return { parent, kai, noe, lani, otherParent };
}

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

type RunnerParams = {
  system: unknown;
  messages: Array<{ role: string; content: string }>;
  tools: Array<{ name: string; run: (input: unknown) => unknown }>;
};

/** A fake client whose single model turn is whatever `respond` returns. */
function fakeAnthropic(respond: (params: RunnerParams) => Promise<string>) {
  const calls: RunnerParams[] = [];
  const toolRunner = (params: RunnerParams) => {
    calls.push(params);
    return {
      async *[Symbol.asyncIterator]() {
        const text = await respond(params);
        yield (async function* () {
          yield {
            type: "message_start",
            message: {
              model: "claude-test",
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          };
          if (text) {
            yield {
              type: "content_block_delta",
              delta: { type: "text_delta", text },
            };
          }
          yield { type: "message_delta", delta: {}, usage: { output_tokens: 5 } };
        })();
      },
    };
  };
  return {
    anthropic: { beta: { messages: { toolRunner } } } as unknown as Anthropic,
    calls,
  };
}

async function threadOf(t: T, parentUserId: Id<"users">) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("parentChatMessages")
      .withIndex("by_parent", (q) => q.eq("parentUserId", parentUserId))
      .collect(),
  );
}

describe("prepareParentAideTurn — scope comes from guardianships alone", () => {
  test("tools and prompt reach only the parent's own children, on every channel", async () => {
    const t = newTest();
    const { parent, kai, noe } = await seedFamilies(t);
    const channels: ParentAideChannel[] = [
      { kind: "web", selectedChildId: null },
      { kind: "sms" },
    ];
    for (const channel of channels) {
      const turn = await prepareParentAideTurn(actionCtx(t), {
        parentUserId: parent,
        channel,
        emit: () => {},
      });
      expect(turn).not.toBeNull();
      expect([...turn!.allowedScholarIds].sort()).toEqual([kai, noe].sort());
      expect(turn!.systemPrompt).toContain("Test kai, Test noe");
      expect(turn!.systemPrompt).not.toContain("Test lani");
      const names = turn!.tools.map((tool) => ("name" in tool ? tool.name : ""));
      // Tier-1 parent tools, never the staff dossier or the roster.
      expect(names).toContain("get_scholar_mastery");
      expect(names).not.toContain("get_scholar_dossier");
      expect(names).not.toContain("list_scholars");
    }
  });

  // TRA-322: the real parent-aide path is the one that gets the Math Skills
  // tile's count and skill list from get_scholar_practice.
  test("get_scholar_practice carries the tile's fluent-skill list, on every channel", async () => {
    const t = newTest();
    const { parent, kai } = await seedFamilies(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "add",
        label: "Add within 10",
        domain: "whole-number-arithmetic",
        grade: "1",
      });
      await ctx.db.insert("practiceMastery", {
        scholarId: kai,
        skillKey: "add",
        domain: "whole-number-arithmetic",
        repetition: FLUENT_REPS,
        halfLifeDays: 30,
        frontier: false,
        source: "practice",
        updatedAt: Date.now(),
      });
    });
    for (const channel of [
      { kind: "web", selectedChildId: null },
      { kind: "sms" },
    ] as ParentAideChannel[]) {
      const turn = await prepareParentAideTurn(actionCtx(t), {
        parentUserId: parent,
        channel,
        emit: () => {},
      });
      const tool = turn!.tools.find(
        (x) => "name" in x && x.name === "get_scholar_practice",
      ) as unknown as { run: (input: unknown) => Promise<string> };
      const parsed = JSON.parse(await tool.run({ scholarName: "kai" })) as {
        mathPortrait: { domains: Array<Record<string, unknown>> };
      };
      expect(parsed.mathPortrait.domains[0]).toMatchObject({
        fluentSkills: 1,
        fluentSkillLabels: ["Add within 10"],
      });
    }
  });

  test("a web selection names a child only if it is the parent's own; SMS has none", async () => {
    const t = newTest();
    const { parent, noe, lani } = await seedFamilies(t);
    const prompt = async (channel: ParentAideChannel) =>
      (await prepareParentAideTurn(actionCtx(t), {
        parentUserId: parent,
        channel,
        emit: () => {},
      }))!.systemPrompt;

    expect(await prompt({ kind: "web", selectedChildId: noe })).toContain(
      "looking at Test noe",
    );
    const foreign = await prompt({ kind: "web", selectedChildId: lani });
    expect(foreign).not.toContain("looking at");
    expect(foreign).not.toContain("Test lani");
    expect(await prompt({ kind: "sms" })).not.toContain("looking at");
  });

  test("a non-guardian gets no turn", async () => {
    const t = newTest();
    const teacher = await seedUser(t, "teacher", "teacher");
    expect(
      await prepareParentAideTurn(actionCtx(t), {
        parentUserId: teacher,
        channel: { kind: "sms" },
        emit: () => {},
      }),
    ).toBeNull();
  });
});

describe("runParentAideTurn — a turn with no request, no SSE, no selected child", () => {
  test("persists both rows, returns the reply, and its tools refuse another family's child", async () => {
    const t = newTest();
    const { parent, otherParent } = await seedFamilies(t);
    const toolResults: Record<string, unknown> = {};
    const { anthropic, calls } = fakeAnthropic(async (params) => {
      const mastery = params.tools.find((tool) => tool.name === "get_scholar_mastery")!;
      toolResults.foreign = await mastery.run({ scholarName: "lani" });
      toolResults.own = await mastery.run({ scholarName: "kai" });
      return "Kai is growing in fractions.";
    });

    const result = await runParentAideTurn(actionCtx(t), {
      anthropic,
      parentUserId: parent,
      content: "  How is Kai doing?  ",
      channel: { kind: "sms" },
    });

    expect(result.content).toBe("Kai is growing in fractions.");
    expect(toolResults.foreign).toBe('No scholar found matching "lani".');
    expect(String(toolResults.own)).not.toMatch(/No scholar found/);

    // The model saw the parent's message as the newest turn.
    expect(calls).toHaveLength(1);
    expect(calls[0].messages.at(-1)).toEqual({
      role: "user",
      content: "How is Kai doing?",
    });

    // Both rows land in the thread the web panel reads, complete.
    const thread = await threadOf(t, parent);
    expect(thread.map((m) => [m._id, m.role, m.content, m.streamId])).toEqual([
      [result.userMessageId, "user", "How is Kai doing?", undefined],
      [result.assistantMessageId, "assistant", "Kai is growing in fractions.", undefined],
    ]);
    expect(await threadOf(t, otherParent)).toEqual([]);
  });

  test("an empty reply writes no assistant row", async () => {
    const t = newTest();
    const { parent } = await seedFamilies(t);
    const { anthropic } = fakeAnthropic(async () => "");
    const result = await runParentAideTurn(actionCtx(t), {
      anthropic,
      parentUserId: parent,
      content: "hello",
      channel: { kind: "sms" },
    });
    expect(result.assistantMessageId).toBeNull();
    expect((await threadOf(t, parent)).map((m) => m.role)).toEqual(["user"]);
  });

  test("a non-guardian or read-only account is refused before anything is written", async () => {
    const t = newTest();
    const teacher = await seedUser(t, "teacher", "teacher");
    const { parent } = await seedFamilies(t);
    await t.run(async (ctx) => ctx.db.patch(parent, { readOnly: true }));
    const { anthropic, calls } = fakeAnthropic(async () => "should not run");

    for (const [who, error] of [
      [teacher, /not a guardian/i],
      [parent, /read-only/i],
    ] as const) {
      await expect(
        runParentAideTurn(actionCtx(t), {
          anthropic,
          parentUserId: who,
          content: "hi",
          channel: { kind: "sms" },
        }),
      ).rejects.toThrow(error);
      expect(await threadOf(t, who)).toEqual([]);
    }
    expect(calls).toHaveLength(0);
  });

  test("the reply joins the existing web thread as history", async () => {
    const t = newTest();
    const { parent } = await seedFamilies(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("parentChatMessages", {
        parentUserId: parent,
        role: "user",
        content: "earlier question",
      });
      await ctx.db.insert("parentChatMessages", {
        parentUserId: parent,
        role: "assistant",
        content: "earlier answer",
      });
    });
    const { anthropic, calls } = fakeAnthropic(async () => "ok");
    await runParentAideTurn(actionCtx(t), {
      anthropic,
      parentUserId: parent,
      content: "follow-up",
      channel: { kind: "sms" },
    });
    expect(calls[0].messages.map((m) => m.content)).toEqual([
      "earlier question",
      "earlier answer",
      "follow-up",
    ]);
    // Read back through the internal getter the web route uses.
    const context = await t.run(async (ctx) =>
      ctx.runQuery(internal.parentChat.getContext, { parentUserId: parent }),
    );
    expect(context?.messages.map((m) => m.content)).toEqual([
      "earlier question",
      "earlier answer",
      "follow-up",
      "ok",
    ]);
  });
});
