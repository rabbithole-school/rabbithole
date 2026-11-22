import { beforeEach, describe, expect, test, vi } from "vitest";
import { runObserver, type TranscriptCase } from "../lib/runObserver";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

const fixture: TranscriptCase = {
  id: "fx-diagnostics",
  title: "Fictional bridge",
  scholarName: "Test Scholar",
  unitTitle: null,
  transcript: [{ role: "user", content: "The cable pulls on both ends." }],
  source: "fixture",
};

const observation = {
  conceptLabel: "Tension",
  domain: "Physics",
  masteryLevel: 2,
  confidenceScore: 0.8,
  evidenceSummary: "Explained tension in a cable.",
  evidenceType: "direct_demonstration",
  attemptContext: "conversation",
  studentInitiated: true,
  transcriptExcerpt: "The cable pulls on both ends.",
};

function reply(
  content: Array<{ type: string; input?: unknown; text?: string }>,
  stop_reason = "tool_use",
) {
  return {
    id: "msg-test",
    model: "test-model",
    content,
    stop_reason,
    usage: { input_tokens: 100, output_tokens: 200 },
  };
}

describe("observer eval raw diagnostics", () => {
  beforeEach(() => create.mockReset());

  test.each([
    ["model emitted an empty array", { observations: [] }],
    ["model used a different key", { masteryObservations: [observation] }],
    [
      "parser dropped an unscored row",
      { observations: [{ ...observation, confidenceScore: undefined }] },
    ],
  ])("preserves the evidence when %s", async (_reason, fields) => {
    const raw = reply([
      { type: "tool_use", input: { pulse: { summary: "Bridge reasoning." }, ...fields } },
    ]);
    create.mockResolvedValueOnce(raw);

    const run = await runObserver(fixture, "test-model");

    expect(run.result?.observations).toEqual([]);
    expect(run.responses).toEqual([raw]);
    expect(run.maxTokens).toBe(create.mock.calls[0][0].max_tokens);
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("keeps both attempts and their usage when a toolless reply is retried", async () => {
    const noCall = reply([{ type: "text", text: "Analysis without a call." }], "end_turn");
    const called = reply([
      { type: "tool_use", input: { pulse: { summary: "Bridge reasoning." }, observations: [observation] } },
    ]);
    create.mockResolvedValueOnce(noCall).mockResolvedValueOnce(called);

    const run = await runObserver(fixture, "test-model");

    expect(run.responses).toEqual([noCall, called]);
    expect(run.usage).toEqual({ input: 200, output: 400 });
    expect(run.result?.observations).toEqual([observation]);
  });

  test("keeps the first response and billed usage if the retry fails", async () => {
    const noCall = reply([{ type: "text", text: "Analysis without a call." }], "end_turn");
    create.mockResolvedValueOnce(noCall).mockRejectedValueOnce(new Error("Test transport failure"));

    const run = await runObserver(fixture, "test-model");

    expect(run.result).toBeNull();
    expect(run.error).toBe("Test transport failure");
    expect(run.responses).toEqual([noCall]);
    expect(run.usage).toEqual({ input: 100, output: 200 });
  });
});
