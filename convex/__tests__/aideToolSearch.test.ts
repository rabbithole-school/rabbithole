/**
 * Tool search on the staff aide: the rare timetable and bell-schedule editors
 * go out with `defer_loading`, the search tool rides along undeferred, and
 * everyday tools such as `give` stay loaded.
 */
import { describe, expect, test } from "vitest";
import { runAideLoop, type AideTool, type AideTools } from "../lib/aideStream";
import {
  AIDE_DEFERRED_TOOLS,
  AIDE_TOOL_SEARCH_TOOL,
  withToolSearch,
} from "../lib/aideToolSearch";

function tool(name: string): AideTool {
  return {
    name,
    description: name,
    input_schema: { type: "object", properties: {} },
    run: async () => "ok",
  } as unknown as AideTool;
}

const names = [
  "give",
  "get_schedule",
  "get_master_schedule",
  "list_terms",
  "clear_activity",
  "move_class",
  "place_class",
  "create_schedule_block",
  "dismiss_flag",
];

function byName(tools: AideTools) {
  return new Map(
    tools.map((t) => [(t as AideTool).name, t as unknown as Record<string, unknown>]),
  );
}

describe("withToolSearch", () => {
  test("defers the listed tools, adds an undeferred search tool, keeps give loaded", () => {
    const out = byName(withToolSearch(names.map(tool)));
    for (const name of ["move_class", "place_class", "create_schedule_block", "dismiss_flag"]) {
      expect(out.get(name)?.defer_loading).toBe(true);
    }
    for (const name of ["give", "get_schedule", "get_master_schedule", "list_terms", "clear_activity"]) {
      expect(out.get(name)?.defer_loading).toBeUndefined();
    }
    const search = out.get(AIDE_TOOL_SEARCH_TOOL.name);
    expect(search?.type).toBe("tool_search_tool_bm25_20251119");
    expect(search?.defer_loading).toBeUndefined();
    // Deferred tools keep their handler so the runner can execute them.
    expect(typeof out.get("move_class")?.run).toBe("function");
  });

  test("never defers an everyday tool", () => {
    for (const name of ["give", "get_schedule", "clear_activity", "get_master_schedule", "list_terms"]) {
      expect(AIDE_DEFERRED_TOOLS.has(name)).toBe(false);
    }
  });

  test("is stable across turns, so the cached tools prefix never varies", () => {
    const tools = names.map(tool);
    const strip = (ts: AideTools) =>
      JSON.stringify(ts.map(({ ...t }) => ({ ...t, run: undefined })));
    expect(strip(withToolSearch(tools))).toBe(strip(withToolSearch(tools)));
  });

  test("leaves tool lists without deferred tools untouched", () => {
    const tools = [tool("give"), tool("get_schedule")];
    expect(withToolSearch(tools)).toBe(tools);
  });

  test("never defers every tool (the API 400s)", () => {
    const tools = [tool("move_class"), tool("place_class")];
    expect(withToolSearch(tools)).toBe(tools);
  });

  test("tolerates listed names that no longer exist", () => {
    const out = withToolSearch([tool("give"), tool("move_class")], new Set(["move_class", "cascade_unit"]));
    expect(out).toHaveLength(3);
  });
});

describe("runAideLoop with tool search", () => {
  test("hands the runner the deferred list and ignores the server search block", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const started: string[] = [];
    const events = [
      { type: "message_start", message: { model: "m", usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Looking." } },
      { type: "content_block_start", index: 1, content_block: { type: "server_tool_use", name: "tool_search_tool_bm25" } },
      { type: "content_block_start", index: 2, content_block: { type: "tool_search_tool_result" } },
      { type: "content_block_start", index: 3, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "Found it." } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
    ];
    const toolRunner = (params: Record<string, unknown>) => {
      calls.push(params);
      return {
        async *[Symbol.asyncIterator]() {
          yield { abort() {}, async *[Symbol.asyncIterator]() { yield* events; } };
        },
      };
    };
    const result = await runAideLoop({
      anthropic: { beta: { messages: { toolRunner } } } as never,
      model: "claude-opus-5-5" as never,
      maxTokens: 1000,
      system: "sys",
      messages: [{ role: "user", content: "move Science to Thursday" }],
      tools: names.map(tool),
      onToolUse: (n) => started.push(n),
      label: "test",
    });
    const sent = byName(calls[0].tools as AideTools);
    expect(sent.get("move_class")?.defer_loading).toBe(true);
    expect(sent.get("give")?.defer_loading).toBeUndefined();
    expect(sent.has(AIDE_TOOL_SEARCH_TOOL.name)).toBe(true);
    // The search is server-side: no client tool start, and text stays separated.
    expect(started).toEqual([]);
    expect(result.content).toBe("Looking.\n\nFound it.");
  });
});
