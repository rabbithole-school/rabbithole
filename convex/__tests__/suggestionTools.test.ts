// Pure unit tests for the Workshop staff tool set (lib/suggestionTools) —
// same approach as introspectionTools.test.ts: a stub ActionCtx + spy emit,
// no convex-test/SSE. Covers the teacher+ gate (no env flag) and each tool's
// run() wiring (filters passed through, caller as author, close default).

import { describe, expect, test, vi } from "vitest";
import {
  makeSuggestionTools,
  SUGGESTION_SYSTEM_PROMPT_SECTION,
} from "../lib/suggestionTools";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { Role } from "../lib/roles";

const EXPECTED_NAMES = [
  "list_scholar_suggestions",
  "respond_to_suggestion",
  "create_whats_new_entry",
];

function stubCtx(overrides: {
  runQuery?: ReturnType<typeof vi.fn>;
  runMutation?: ReturnType<typeof vi.fn>;
}): ActionCtx {
  return {
    runQuery: overrides.runQuery ?? vi.fn(),
    runMutation: overrides.runMutation ?? vi.fn(),
    runAction: vi.fn(),
    scheduler: { runAfter: vi.fn() },
  } as unknown as ActionCtx;
}

const CALLER_ID = "u_teacher" as Id<"users">;

async function runTool(
  tool: unknown,
  input: Record<string, unknown>,
): Promise<unknown> {
  return (tool as { run: (input: Record<string, unknown>) => Promise<unknown> }).run(
    input,
  );
}

describe("makeSuggestionTools gating (teacher+ only, no env flag)", () => {
  test("exposes exactly the two tools for a teacher", async () => {
    const tools = await makeSuggestionTools(stubCtx({}), vi.fn(), {
      role: "teacher",
      callerUserId: CALLER_ID,
    });
    expect(tools.map((t) => t.name)).toEqual(EXPECTED_NAMES);
  });

  test("also available to platform_admin and school_admin", async () => {
    for (const role of ["platform_admin", "school_admin"] as Role[]) {
      const tools = await makeSuggestionTools(stubCtx({}), vi.fn(), {
        role,
        callerUserId: CALLER_ID,
      });
      expect(tools.map((t) => t.name)).toEqual(EXPECTED_NAMES);
    }
  });

  test("returns [] for a scholar", async () => {
    const tools = await makeSuggestionTools(stubCtx({}), vi.fn(), {
      role: "scholar",
      callerUserId: CALLER_ID,
    });
    expect(tools).toEqual([]);
  });

  test("returns [] for a parent", async () => {
    const tools = await makeSuggestionTools(stubCtx({}), vi.fn(), {
      role: "parent",
      callerUserId: CALLER_ID,
    });
    expect(tools).toEqual([]);
  });

  test("returns [] for a curriculum_designer and staff (not teacher+)", async () => {
    for (const role of ["curriculum_designer", "staff"] as Role[]) {
      const tools = await makeSuggestionTools(stubCtx({}), vi.fn(), {
        role,
        callerUserId: CALLER_ID,
      });
      expect(tools).toEqual([]);
    }
  });

  test("returns [] for a missing role", async () => {
    const tools = await makeSuggestionTools(stubCtx({}), vi.fn(), {
      role: null,
      callerUserId: CALLER_ID,
    });
    expect(tools).toEqual([]);
  });
});

describe("list_scholar_suggestions", () => {
  test("passes the filters through and shapes the rows", async () => {
    const runQuery = vi.fn().mockResolvedValue([
      {
        _id: "s1",
        scholarId: "u_kai",
        scholarName: "Kai Nakamura",
        scholarUsername: "kai",
        title: "Star Map time travel",
        scholarWords: "i want to see my old star map",
        distilled: undefined,
        staffResponse: undefined,
        createdAt: Date.now() - 90 * 60_000,
        updatedAt: Date.now(),
      },
    ]);
    const tools = await makeSuggestionTools(stubCtx({ runQuery }), vi.fn(), {
      role: "teacher",
      callerUserId: CALLER_ID,
    });
    const tool = tools.find((t) => t.name === "list_scholar_suggestions")!;

    const result = await runTool(tool, {
      scholarUsername: "kai",
      filter: "needs_reply",
    });

    expect(runQuery).toHaveBeenCalledTimes(1);
    const [, queryArgs] = runQuery.mock.calls[0];
    expect(queryArgs).toEqual({
      scholarUsername: "kai",
      filter: "needs_reply",
    });

    const parsed = JSON.parse(result as string);
    expect(parsed).toEqual([
      {
        id: "s1",
        scholar: "Kai Nakamura",
        scholarUsername: "kai",
        title: "Star Map time travel",
        words: "i want to see my old star map",
        age: "1h ago",
      },
    ]);
  });
});

describe("list_scholar_suggestions — Extended Education default", () => {
  const now = Date.now();
  const enrolledRow = {
    _id: "s1",
    scholarId: "u_kai",
    scholarName: "Kai Kahale",
    scholarUsername: "kai_kahale",
    title: "Star Map time travel",
    scholarWords: "i want to see my old star map",
    createdAt: now - 60_000,
    updatedAt: now,
  };
  const guestRow = {
    _id: "s2",
    scholarId: "u_hoku",
    scholarName: "Hoku Makani",
    scholarUsername: "hoku_makani",
    title: "Robotics idea",
    scholarWords: "more robot time",
    createdAt: now - 30_000,
    updatedAt: now,
    // The backing query tags program-guest rows (joinScholar).
    extendedEducation: true,
  };

  async function listTool(runQuery: ReturnType<typeof vi.fn>) {
    const tools = await makeSuggestionTools(stubCtx({ runQuery }), vi.fn(), {
      role: "teacher",
      callerUserId: CALLER_ID,
    });
    return tools.find((t) => t.name === "list_scholar_suggestions")!;
  }

  test("default: a guest scholar's idea is omitted, with the opt-in note", async () => {
    const runQuery = vi.fn().mockResolvedValue([enrolledRow, guestRow]);
    const result = await runTool(await listTool(runQuery), {});
    const parsed = JSON.parse(result as string) as {
      ideas: Array<Record<string, unknown>>;
      note: string;
    };
    expect(parsed.ideas.map((i) => i.scholarUsername)).toEqual(["kai_kahale"]);
    expect(parsed.note).toMatch(/1 idea from Extended Education scholars/);
    expect(parsed.note).toMatch(/includeExtendedEducation/);
  });

  test("includeExtendedEducation: guest idea included and tagged, no note", async () => {
    const runQuery = vi.fn().mockResolvedValue([enrolledRow, guestRow]);
    const result = await runTool(await listTool(runQuery), {
      includeExtendedEducation: true,
    });
    const parsed = JSON.parse(result as string) as Array<
      Record<string, unknown>
    >;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.map((i) => i.scholarUsername)).toEqual([
      "kai_kahale",
      "hoku_makani",
    ]);
    const hoku = parsed.find((i) => i.scholarUsername === "hoku_makani");
    expect(hoku).toMatchObject({ extendedEducation: true });
    expect(
      parsed.find((i) => i.scholarUsername === "kai_kahale"),
    ).not.toHaveProperty("extendedEducation");
  });

  test("naming a scholarUsername is itself the opt-in — a guest's ideas resolve", async () => {
    const runQuery = vi.fn().mockResolvedValue([guestRow]);
    const result = await runTool(await listTool(runQuery), {
      scholarUsername: "hoku_makani",
    });
    const parsed = JSON.parse(result as string) as Array<
      Record<string, unknown>
    >;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      scholarUsername: "hoku_makani",
      extendedEducation: true,
    });
  });
});

describe("respond_to_suggestion", () => {
  test("calls respond with the caller as author, and changes no state", async () => {
    const runMutation = vi.fn().mockResolvedValue({
      title: "Star Map time travel",
      scholarFirstName: "Kai",
    });
    const tools = await makeSuggestionTools(stubCtx({ runMutation }), vi.fn(), {
      role: "teacher",
      callerUserId: CALLER_ID,
    });
    const tool = tools.find((t) => t.name === "respond_to_suggestion")!;

    const result = await runTool(tool, {
      suggestionId: "s1",
      body: "Love this — sharing it with the team.",
    });

    expect(runMutation).toHaveBeenCalledTimes(1);
    const [, mutationArgs] = runMutation.mock.calls[0];
    expect(mutationArgs).toEqual({
      suggestionId: "s1",
      authorId: CALLER_ID,
      body: "Love this — sharing it with the team.",
    });

    const parsed = JSON.parse(result as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.message).toContain("Kai");
    // The tool must not tell staff (or imply to the model) that replying filed
    // the idea away — only the scholar can do that.
    expect(parsed.message).toContain("until THEY archive it");
    expect(parsed.message).not.toMatch(/clos/i);
    expect(parsed.status).toBeUndefined();
  });

  test("offers the model no way to close or archive an idea", async () => {
    const tools = await makeSuggestionTools(stubCtx({}), vi.fn(), {
      role: "teacher",
      callerUserId: CALLER_ID,
    });
    const tool = tools.find((t) => t.name === "respond_to_suggestion")!;
    const schema = (
      tool as unknown as {
        input_schema?: { properties: Record<string, unknown> };
        inputSchema?: { properties: Record<string, unknown> };
      }
    );
    const properties =
      schema.input_schema?.properties ?? schema.inputSchema?.properties;
    expect(properties).toBeDefined();
    expect(Object.keys(properties!)).toEqual(["suggestionId", "body"]);
    // …and the description must not coach the model toward a close either.
    expect(
      (tool as unknown as { description: string }).description,
    ).not.toMatch(/close=/);
  });
});

describe("institution lens forwarding (the three backing calls are lens-scoped)", () => {
  const IN_LENS = "u_in_lens" as Id<"users">;
  const OTHER_LENS = "u_other_lens" as Id<"users">;

  const lensOpts = {
    role: "teacher" as Role,
    callerUserId: CALLER_ID,
    allowedScholarIds: new Set([IN_LENS, OTHER_LENS]),
    scholarLensResolved: true,
  };

  test("list_scholar_suggestions forwards the lens (Set → array) to listForStaffInternal", async () => {
    const runQuery = vi.fn().mockResolvedValue([]);
    const tools = await makeSuggestionTools(stubCtx({ runQuery }), vi.fn(), lensOpts);
    const tool = tools.find((t) => t.name === "list_scholar_suggestions")!;

    await runTool(tool, { filter: "needs_reply" });

    const [, queryArgs] = runQuery.mock.calls[0];
    expect(queryArgs.scholarLensResolved).toBe(true);
    expect([...(queryArgs.allowedScholarIds as string[])].sort()).toEqual(
      [IN_LENS, OTHER_LENS].sort(),
    );
  });

  test("respond_to_suggestion forwards the lens to respond", async () => {
    const runMutation = vi.fn().mockResolvedValue({
      title: "T",
      scholarFirstName: "Kai",
    });
    const tools = await makeSuggestionTools(
      stubCtx({ runMutation }),
      vi.fn(),
      lensOpts,
    );
    const tool = tools.find((t) => t.name === "respond_to_suggestion")!;

    await runTool(tool, { suggestionId: "s1", body: "hi" });

    const [, mutationArgs] = runMutation.mock.calls[0];
    expect(mutationArgs.scholarLensResolved).toBe(true);
    expect([...(mutationArgs.allowedScholarIds as string[])].sort()).toEqual(
      [IN_LENS, OTHER_LENS].sort(),
    );
  });

  test("create_whats_new_entry forwards the lens to createEntry", async () => {
    const runMutation = vi
      .fn()
      .mockResolvedValue({ entryId: "c1", creditedCount: 0 });
    const tools = await makeSuggestionTools(
      stubCtx({ runMutation }),
      vi.fn(),
      lensOpts,
    );
    const tool = tools.find((t) => t.name === "create_whats_new_entry")!;

    await runTool(tool, { title: "T", kidBody: "b" });

    const [, mutationArgs] = runMutation.mock.calls[0];
    expect(mutationArgs.scholarLensResolved).toBe(true);
    expect([...(mutationArgs.allowedScholarIds as string[])].sort()).toEqual(
      [IN_LENS, OTHER_LENS].sort(),
    );
  });

  test("an unrestricted admin lens forwards scholarLensResolved with NO id set", async () => {
    const runQuery = vi.fn().mockResolvedValue([]);
    const tools = await makeSuggestionTools(stubCtx({ runQuery }), vi.fn(), {
      role: "teacher" as Role,
      callerUserId: CALLER_ID,
      scholarLensResolved: true,
    });
    const tool = tools.find((t) => t.name === "list_scholar_suggestions")!;

    await runTool(tool, {});

    const [, queryArgs] = runQuery.mock.calls[0];
    expect(queryArgs.scholarLensResolved).toBe(true);
    expect(queryArgs.allowedScholarIds).toBeUndefined();
  });
});

describe("SUGGESTION_SYSTEM_PROMPT_SECTION", () => {
  test("frames the bot as a courier, never a verdict-giver or shipping-promiser", () => {
    expect(SUGGESTION_SYSTEM_PROMPT_SECTION).toMatch(/courier/i);
    expect(SUGGESTION_SYSTEM_PROMPT_SECTION).toMatch(/verdict/i);
    expect(SUGGESTION_SYSTEM_PROMPT_SECTION).toMatch(/Workshop/);
  });

  test("documents create_whats_new_entry: kid-language body + never guess credit", () => {
    expect(SUGGESTION_SYSTEM_PROMPT_SECTION).toMatch(/create_whats_new_entry/);
    expect(SUGGESTION_SYSTEM_PROMPT_SECTION).toMatch(/read BY CHILDREN/i);
    expect(SUGGESTION_SYSTEM_PROMPT_SECTION).toMatch(/never guess credit/i);
  });
});

describe("create_whats_new_entry", () => {
  test("happy path: calls createEntry with caller as author, reports credited count", async () => {
    const runMutation = vi
      .fn()
      .mockResolvedValue({ entryId: "c1", creditedCount: 2 });
    const tools = await makeSuggestionTools(stubCtx({ runMutation }), vi.fn(), {
      role: "teacher",
      callerUserId: CALLER_ID,
    });
    const tool = tools.find((t) => t.name === "create_whats_new_entry")!;

    const result = await runTool(tool, {
      title: "Night Sky mode",
      kidBody: "The Sky can go dark now.",
      creditedScholarUsernames: ["kai", "lani"],
    });

    expect(runMutation).toHaveBeenCalledTimes(1);
    const [, mutationArgs] = runMutation.mock.calls[0];
    expect(mutationArgs).toEqual({
      title: "Night Sky mode",
      kidBody: "The Sky can go dark now.",
      creditedScholarUsernames: ["kai", "lani"],
      createdByUserId: CALLER_ID,
    });

    const parsed = JSON.parse(result as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.message).toContain('Posted "Night Sky mode"');
    expect(parsed.message).toContain("2 scholars will hear their credit");
  });

  test("unknown username → friendly error relayed, ok:false", async () => {
    const runMutation = vi
      .fn()
      .mockRejectedValue(
        new Error('Couldn\'t find a scholar with username "nobody". Double-check the username(s) — I won\'t guess who to credit.'),
      );
    const tools = await makeSuggestionTools(stubCtx({ runMutation }), vi.fn(), {
      role: "teacher",
      callerUserId: CALLER_ID,
    });
    const tool = tools.find((t) => t.name === "create_whats_new_entry")!;

    const result = await runTool(tool, {
      title: "Night Sky mode",
      kidBody: "The Sky can go dark now.",
      creditedScholarUsernames: ["nobody"],
    });

    const parsed = JSON.parse(result as string);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('"nobody"');
    expect(parsed.error).toMatch(/won't guess/i);
  });
});
