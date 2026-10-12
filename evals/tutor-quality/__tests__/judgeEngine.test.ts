/**
 * Pure tests for the judge engine seam (no CLI, no API). Pins the two
 * load-bearing invariants of the "one rubric, two engines" design:
 *   - the Copilot output is parsed + SCHEMA-VALIDATED the same way the Anthropic
 *     tool call is, so a malformed engine response fails loudly, and
 *   - provenance is stamped so a Copilot-judged score is never conflated with an
 *     API-judged one.
 */
import { afterEach, describe, expect, test } from "vitest";
import { MODELS, TUTOR_JUDGE_MODEL } from "../../../convex/lib/models";
import {
  assertJudgeNotWeaker,
  buildCopilotPrompt,
  extractJson,
  judgeEngineName,
  judgeProvenance,
  validateToolInput,
  type JudgeTool,
} from "../lib/judgeEngine";

const TOOL: JudgeTool = {
  name: "record_turn_verdict",
  description: "test",
  input_schema: {
    type: "object",
    required: ["socratic", "notes"],
    properties: {
      socratic: { type: "integer" },
      followUpQuality: { type: ["integer", "null"] },
      topProblems: { type: "array" },
      notes: { type: "string" },
    },
  },
};

const ENV_KEY = "JUDGE_ENGINE";
const original = process.env[ENV_KEY];
const originalModel = process.env.JUDGE_MODEL;
afterEach(() => {
  if (original === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = original;
  if (originalModel === undefined) delete process.env.JUDGE_MODEL;
  else process.env.JUDGE_MODEL = originalModel;
});

describe("extractJson", () => {
  test("parses a bare object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  test("ignores leading log noise and a markdown fence", () => {
    const raw = 'thinking...\n```json\n{"socratic": 4, "notes": "ok"}\n```\n';
    expect(extractJson(raw)).toEqual({ socratic: 4, notes: "ok" });
  });

  test("respects braces inside strings", () => {
    const raw = 'prefix {"notes": "score is {high}", "socratic": 5} suffix';
    expect(extractJson(raw)).toEqual({ notes: "score is {high}", socratic: 5 });
  });

  test("throws when there is no object", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("validateToolInput", () => {
  test("accepts a well-formed verdict (incl. null union + array)", () => {
    const v = { socratic: 4, followUpQuality: null, topProblems: [], notes: "x" };
    expect(validateToolInput(v, TOOL)).toBe(v);
  });

  test("rejects a missing required field", () => {
    expect(() => validateToolInput({ socratic: 4 }, TOOL)).toThrow(/missing required field "notes"/);
  });

  test("rejects a wrong type", () => {
    expect(() =>
      validateToolInput({ socratic: "high", notes: "x" }, TOOL),
    ).toThrow(/socratic/);
  });

  test("rejects a non-integer number for an integer field", () => {
    expect(() =>
      validateToolInput({ socratic: 4.5, notes: "x" }, TOOL),
    ).toThrow(/socratic/);
  });

  test("accepts null for a nullable union field but not for a plain integer", () => {
    expect(() => validateToolInput({ socratic: null, notes: "x" }, TOOL)).toThrow(/socratic/);
    expect(
      validateToolInput({ socratic: 3, followUpQuality: 5, notes: "x" }, TOOL),
    ).toBeTruthy();
  });

  test("rejects a non-object", () => {
    expect(() => validateToolInput([1, 2], TOOL)).toThrow();
    expect(() => validateToolInput(null, TOOL)).toThrow();
  });
});

describe("judgeEngineName / judgeProvenance", () => {
  test("defaults to anthropic and the pinned TUTOR_JUDGE_MODEL", () => {
    delete process.env[ENV_KEY];
    delete process.env.JUDGE_MODEL;
    expect(judgeEngineName()).toBe("anthropic");
    expect(judgeProvenance()).toBe(TUTOR_JUDGE_MODEL);
  });

  test("JUDGE_MODEL overrides the anthropic judge, dotted or dashed", () => {
    delete process.env[ENV_KEY];
    process.env.JUDGE_MODEL = "claude-opus-4.8";
    expect(judgeProvenance()).toBe(MODELS.OPUS);
  });

  test("copilot provenance is the normalised copilot-cli id", () => {
    process.env[ENV_KEY] = "copilot";
    expect(judgeEngineName()).toBe("copilot");
    expect(judgeProvenance()).toBe("copilot-cli:claude-fable-5-1");
  });

  test("rejects an unknown engine", () => {
    process.env[ENV_KEY] = "gemini";
    expect(() => judgeEngineName()).toThrow(/Unknown JUDGE_ENGINE/);
  });
});

describe("buildCopilotPrompt", () => {
  test("embeds the rubric, the case, and the exact required keys", () => {
    const prompt = buildCopilotPrompt({
      system: "RUBRIC-TEXT",
      tool: TOOL,
      userText: "CASE-TEXT",
      maxTokens: 800,
    });
    expect(prompt).toContain("RUBRIC-TEXT");
    expect(prompt).toContain("CASE-TEXT");
    expect(prompt).toContain('"socratic"');
    expect(prompt).toContain("EXACTLY ONE JSON object");
  });
});

describe("assertJudgeNotWeaker", () => {
  test("the default judge can grade every tutor model we run", () => {
    delete process.env[ENV_KEY];
    delete process.env.JUDGE_MODEL;
    expect(() => assertJudgeNotWeaker([MODELS.SONNET, MODELS.OPUS_5_5, MODELS.FABLE])).not.toThrow();
  });

  test("refuses a judge weaker than either compared model", () => {
    expect(() => assertJudgeNotWeaker([MODELS.SONNET, MODELS.OPUS_5_5], MODELS.OPUS)).toThrow(
      /weaker than tutor model "claude-opus-5-5"/,
    );
  });

  test("allows a judge equal to the strongest compared model", () => {
    expect(() => assertJudgeNotWeaker([MODELS.OPUS_5_5], MODELS.OPUS_5_5)).not.toThrow();
  });

  test("refuses a model it cannot rank instead of guessing", () => {
    expect(() => assertJudgeNotWeaker(["claude-unknown-9"], MODELS.FABLE)).toThrow(/no capability rank/);
  });
});

describe("assertJudgeNotWeaker id normalisation", () => {
  test("accepts dotted ids for both judge and tutor", () => {
    expect(() => assertJudgeNotWeaker(["claude-opus-5.5"], "claude-fable-5.1")).not.toThrow();
    expect(() => assertJudgeNotWeaker(["claude-opus-5.5"], "claude-opus-4.8")).toThrow(/weaker/);
  });
});
