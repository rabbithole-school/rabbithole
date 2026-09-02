// Pure unit tests for the Workshop idea-conversation tool
// (lib/scholarIdeaTools) — same approach as scholarCodeTools.test.ts: no
// convex-test/SSE, the capture is an injected stub, emit is a spy. Covers the
// flag, the loop config (off-path is a no-op), and the send_idea_to_teacher
// tool's run() wiring: the kid's words + optional refined pass straight
// through, and each capture outcome (captured / at_cap / empty) yields the
// right relayed message. The GUARDRAIL proof lives here: refined is optional,
// and the tool never refuses.

import { afterEach, describe, expect, test, vi } from "vitest";
import {
  isIdeaConvosEnabled,
  ideaConvosLoopConfig,
  IDEA_CONVOS_MAX_ITERATIONS,
  makeIdeaConvoTools,
  ideaSentMessage,
  ideaAtCapMessage,
  IDEA_EMPTY_MESSAGE,
  type CaptureIdea,
  type CaptureIdeaArgs,
  type CaptureIdeaResult,
} from "../lib/scholarIdeaTools";

afterEach(() => {
  delete process.env.WORKSHOP_IDEA_CONVOS_ENABLED;
});

async function runTool(
  tool: unknown,
  input: Record<string, unknown>,
): Promise<unknown> {
  return (tool as { run: (input: Record<string, unknown>) => Promise<unknown> }).run(
    input,
  );
}

/** A capture stub that records the args it saw and returns a fixed result. */
function stubCapture(result: CaptureIdeaResult): {
  capture: CaptureIdea;
  calls: CaptureIdeaArgs[];
} {
  const calls: CaptureIdeaArgs[] = [];
  const capture: CaptureIdea = async (a) => {
    calls.push(a);
    return result;
  };
  return { capture, calls };
}

describe("isIdeaConvosEnabled", () => {
  test("off by default (unset) — ships dark", () => {
    delete process.env.WORKSHOP_IDEA_CONVOS_ENABLED;
    expect(isIdeaConvosEnabled()).toBe(false);
  });

  test("off for anything but true/on/1", () => {
    for (const v of ["false", "nope", "0", "  "]) {
      process.env.WORKSHOP_IDEA_CONVOS_ENABLED = v;
      expect(isIdeaConvosEnabled()).toBe(false);
    }
  });

  test("on for true/on/1 (case-insensitive)", () => {
    for (const v of ["true", "TRUE", "on", "1"]) {
      process.env.WORKSHOP_IDEA_CONVOS_ENABLED = v;
      expect(isIdeaConvosEnabled()).toBe(true);
    }
  });
});

describe("ideaConvosLoopConfig — the off-path is a behavioral no-op", () => {
  test("off → no tools, no cap (byte-identical to tool-less v1)", () => {
    expect(ideaConvosLoopConfig(false)).toEqual({
      withTools: false,
      maxIterations: undefined,
    });
  });

  test("on → tools wired + the cost cap", () => {
    expect(ideaConvosLoopConfig(true)).toEqual({
      withTools: true,
      maxIterations: IDEA_CONVOS_MAX_ITERATIONS,
    });
  });
});

describe("makeIdeaConvoTools — shape + schema", () => {
  test("exposes exactly send_idea_to_teacher, requiring title + scholarWords only", async () => {
    const { capture } = stubCapture({ status: "captured", title: "x" });
    const tools = await makeIdeaConvoTools(vi.fn(), capture);
    expect(tools.map((t) => t.name)).toEqual(["send_idea_to_teacher"]);
    const tool = tools[0] as unknown as {
      input_schema: { required: string[]; properties: Record<string, unknown> };
    };
    // refined is OPTIONAL — the guardrail that the kid can always send as-is.
    expect(tool.input_schema.required).toEqual(["title", "scholarWords"]);
    expect(Object.keys(tool.input_schema.properties).sort()).toEqual([
      "refined",
      "scholarWords",
      "title",
    ]);
  });
});

describe("send_idea_to_teacher — capture wiring", () => {
  test("passes the kid's words + refined straight through, relays the sent message", async () => {
    const { capture, calls } = stubCapture({
      status: "captured",
      title: "Reward effort",
    });
    const emit = vi.fn();
    const tools = await makeIdeaConvoTools(emit, capture);
    const tool = tools[0];

    const result = await runTool(tool, {
      title: "Reward effort",
      scholarWords: "give me candy for each right answer",
      refined: "reward trying hard, not just being right",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      title: "Reward effort",
      scholarWords: "give me candy for each right answer",
      refined: "reward trying hard, not just being right",
    });

    const parsed = JSON.parse(result as string);
    expect(parsed).toEqual({
      ok: true,
      sent: true,
      message: ideaSentMessage("Reward effort"),
    });
    // The relayed message re-states the ceiling: never promise building.
    expect(parsed.message).toMatch(/don't promise it'll get built/i);
    expect(emit).toHaveBeenCalledWith({
      toolComplete: { name: "send_idea_to_teacher", result: "Sent: Reward effort" },
    });
  });

  test("GUARDRAIL b: sends the kid's ORIGINAL words with NO refined when omitted", async () => {
    const { capture, calls } = stubCapture({
      status: "captured",
      title: "Leaderboard",
    });
    const tools = await makeIdeaConvoTools(vi.fn(), capture);

    await runTool(tools[0], {
      title: "Leaderboard",
      scholarWords: "i want a leaderboard so i can beat my friends",
    });

    expect(calls[0]).toEqual({
      title: "Leaderboard",
      scholarWords: "i want a leaderboard so i can beat my friends",
      refined: undefined,
    });
    // The scholar's own words are preserved verbatim; no refinement is invented.
    expect(calls[0].refined).toBeUndefined();
  });

  test("at cap → nothing sent, relays the friendly help-them-prioritize line", async () => {
    const { capture } = stubCapture({ status: "at_cap", cap: 5 });
    const emit = vi.fn();
    const tools = await makeIdeaConvoTools(emit, capture);

    const result = await runTool(tools[0], {
      title: "One more",
      scholarWords: "another idea",
    });

    const parsed = JSON.parse(result as string);
    expect(parsed.ok).toBe(false);
    expect(parsed.sent).toBe(false);
    expect(parsed.message).toBe(ideaAtCapMessage(5));
    // Never frames the idea as not good enough — just a limit + prioritize.
    expect(parsed.message).toMatch(/good one/i);
    expect(parsed.message).toMatch(/matters most/i);
    expect(emit).toHaveBeenCalledWith({
      toolComplete: { name: "send_idea_to_teacher", result: "Not sent (at cap)" },
    });
  });

  test("empty words → not sent, asks for the kid's own words", async () => {
    const { capture } = stubCapture({ status: "empty" });
    const tools = await makeIdeaConvoTools(vi.fn(), capture);
    const result = await runTool(tools[0], { title: "x", scholarWords: "" });
    const parsed = JSON.parse(result as string);
    expect(parsed.ok).toBe(false);
    expect(parsed.sent).toBe(false);
    expect(parsed.message).toBe(IDEA_EMPTY_MESSAGE);
  });
});

describe("relayed messages", () => {
  test("ideaSentMessage names the idea + holds the courier ceiling", () => {
    const m = ideaSentMessage("Night mode");
    expect(m).toContain('"Night mode"');
    expect(m).toMatch(/read every idea/i);
    expect(m).toMatch(/humans decide/i);
  });

  test("ideaAtCapMessage names the cap number", () => {
    expect(ideaAtCapMessage(5)).toContain("5 ideas open");
  });
});
