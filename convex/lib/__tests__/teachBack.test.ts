import { describe, it, expect, afterEach } from "vitest";
import {
  teachBackEnabled,
  buildTeachBackGradingPrompt,
  parseTeachBackRubric,
  START_TEACH_BACK_TOOL,
  FINISH_TEACH_BACK_TOOL,
  TEACH_BACK_GRADING_TOOL,
} from "../teachBack";

describe("teachBackEnabled — the gate", () => {
  const prev = process.env.TEACH_BACK_ENABLED;
  afterEach(() => {
    if (prev === undefined) delete process.env.TEACH_BACK_ENABLED;
    else process.env.TEACH_BACK_ENABLED = prev;
  });

  it("is OFF by default (unset / false / 0 / empty)", () => {
    delete process.env.TEACH_BACK_ENABLED;
    expect(teachBackEnabled()).toBe(false);
    process.env.TEACH_BACK_ENABLED = "false";
    expect(teachBackEnabled()).toBe(false);
    process.env.TEACH_BACK_ENABLED = "0";
    expect(teachBackEnabled()).toBe(false);
    process.env.TEACH_BACK_ENABLED = "";
    expect(teachBackEnabled()).toBe(false);
  });

  it("is ON only for an explicit truthy value", () => {
    for (const v of ["true", "1", "on", "yes", "TRUE", "On"]) {
      process.env.TEACH_BACK_ENABLED = v;
      expect(teachBackEnabled()).toBe(true);
    }
  });
});

describe("buildTeachBackGradingPrompt", () => {
  it("forces the grading tool and carries the concept + transcript into the user prompt", () => {
    const { system, user } = buildTeachBackGradingPrompt({
      conceptLabel: "why the moon has phases",
      transcript: "Scholar: The moon has phases because...",
    });
    expect(system).toContain("record_teach_back_rubric");
    expect(user).toContain("why the moon has phases");
    expect(user).toContain("The moon has phases because");
  });
});

describe("parseTeachBackRubric — strict validation", () => {
  it("accepts a well-formed rubric", () => {
    const r = parseTeachBackRubric({
      completeness: 2,
      causalChain: 3,
      example: 1,
      handledProbes: 2,
      summary: "  Solid causal account; example was thin.  ",
    });
    expect(r).toEqual({
      completeness: 2,
      causalChain: 3,
      example: 1,
      handledProbes: 2,
      summary: "Solid causal account; example was thin.",
    });
  });

  it("clamps out-of-range scores to 0–3 and rounds", () => {
    const r = parseTeachBackRubric({
      completeness: 7,
      causalChain: -2,
      example: 2.6,
      handledProbes: 0,
      summary: "ok",
    })!;
    expect(r.completeness).toBe(3);
    expect(r.causalChain).toBe(0);
    expect(r.example).toBe(3);
    expect(r.handledProbes).toBe(0);
  });

  it("rejects missing scores, non-number scores, empty/absent summary, non-objects", () => {
    expect(parseTeachBackRubric(null)).toBeNull();
    expect(parseTeachBackRubric("nope")).toBeNull();
    expect(
      parseTeachBackRubric({ completeness: 1, causalChain: 1, example: 1 }),
    ).toBeNull(); // missing handledProbes + summary
    expect(
      parseTeachBackRubric({
        completeness: "2",
        causalChain: 1,
        example: 1,
        handledProbes: 1,
        summary: "x",
      }),
    ).toBeNull();
    expect(
      parseTeachBackRubric({
        completeness: 1,
        causalChain: 1,
        example: 1,
        handledProbes: 1,
        summary: "   ",
      }),
    ).toBeNull();
  });
});

describe("tool specs", () => {
  it("start_teach_back requires only conceptLabel", () => {
    expect(START_TEACH_BACK_TOOL.name).toBe("start_teach_back");
    expect(START_TEACH_BACK_TOOL.description.toLowerCase()).toContain(
      "whole playlist checkpoint",
    );
    expect(START_TEACH_BACK_TOOL.description.toLowerCase()).toContain(
      "at most once per activity/session stretch",
    );
    expect(START_TEACH_BACK_TOOL.inputSchema.required).toEqual(["conceptLabel"]);
    expect(START_TEACH_BACK_TOOL.inputSchema.properties.conceptLabel.type).toBe(
      "string",
    );
    expect(START_TEACH_BACK_TOOL.inputSchema.properties.nodeKey.type).toBe(
      "string",
    );
  });

  it("finish_teach_back takes an optional teachBackId (nothing required)", () => {
    expect(FINISH_TEACH_BACK_TOOL.name).toBe("finish_teach_back");
    expect(FINISH_TEACH_BACK_TOOL.inputSchema.required).toEqual([]);
  });

  it("the grading tool uses snake_case input_schema (raw messages.create) + 4 dims", () => {
    expect(TEACH_BACK_GRADING_TOOL.name).toBe("record_teach_back_rubric");
    expect(TEACH_BACK_GRADING_TOOL.input_schema.required).toEqual([
      "completeness",
      "causalChain",
      "example",
      "handledProbes",
      "summary",
    ]);
  });
});
