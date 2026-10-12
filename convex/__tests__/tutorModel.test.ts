import { describe, expect, test } from "vitest";
import { MODELS } from "../lib/models";
import {
  resolveTutorModel,
  tutorRuntime,
} from "../lib/tutorModel";

describe("resolveTutorModel", () => {
  test("absent and sonnet preferences use the Opus 5.5 fleet default", () => {
    expect(resolveTutorModel(undefined)).toBe(MODELS.OPUS_5_5);
    expect(resolveTutorModel(null)).toBe(MODELS.OPUS_5_5);
    expect(resolveTutorModel("sonnet")).toBe(MODELS.OPUS_5_5);
  });

  test("fable resolves to Fable 5.1", () => {
    expect(resolveTutorModel("fable")).toBe(MODELS.FABLE);
  });
});

describe("tutorRuntime", () => {
  test("Sonnet 5 keeps its runtime: no effort, no fallback", () => {
    expect(tutorRuntime(MODELS.SONNET, "vibecode")).toEqual({
      maxTokens: 4096,
      effort: undefined,
      refusalFallback: false,
    });
  });

  test("Fable uses a larger ceiling only for Vibecode sessions", () => {
    expect(tutorRuntime(MODELS.FABLE, "vibecode")).toEqual({
      maxTokens: 64000,
      effort: "medium",
      refusalFallback: true,
    });
    expect(tutorRuntime(MODELS.FABLE, "conversation")).toEqual({
      maxTokens: 16000,
      effort: "medium",
      refusalFallback: true,
    });
  });

  test("Opus 5.5 gets Fable's larger Vibecode ceiling: a whole app must fit", () => {
    expect(tutorRuntime(MODELS.OPUS_5_5, "vibecode")).toEqual({
      maxTokens: 64000,
      effort: "low",
      refusalFallback: true,
    });
  });

  test("the Opus 5.5 default runs at low effort with the refusal fallback", () => {
    expect(tutorRuntime(MODELS.OPUS_5_5, "conversation")).toEqual({
      maxTokens: 16000,
      effort: "low",
      refusalFallback: true,
    });
  });

  test("only the classifier-running models opt into the refusal fallback", () => {
    // Fable 5.1 and Opus 5.5 run pre-output safety classifiers; a false
    // positive must not leave a scholar with an empty reply.
    expect(tutorRuntime(MODELS.OPUS_5_5).refusalFallback).toBe(true);
    expect(tutorRuntime(MODELS.FABLE).refusalFallback).toBe(true);
    // Sonnet 5 (today's tutor) and Opus 4.8 have nothing to fall back from.
    expect(tutorRuntime(MODELS.SONNET).refusalFallback).toBe(false);
    expect(tutorRuntime(MODELS.OPUS).refusalFallback).toBe(false);
  });
});
