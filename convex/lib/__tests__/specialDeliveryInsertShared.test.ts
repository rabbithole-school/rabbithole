import { describe, expect, it } from "vitest";
import {
  MAX_INSERT_CAPTION_LENGTH,
  MAX_SKETCH_BRIEF_LENGTH,
  buildSketchImagePrompt,
  parseInsertToolResponse,
} from "../specialDeliveryInsertShared";

describe("parseInsertToolResponse", () => {
  function toolResponse(input: unknown) {
    return [{ type: "tool_use", input }];
  }

  it("returns none when there is no tool_use block", () => {
    expect(parseInsertToolResponse([{ type: "text" }], 3)).toEqual({ kind: "none" });
  });

  it("returns none when choice is missing or unrecognized", () => {
    expect(parseInsertToolResponse(toolResponse({}), 3)).toEqual({ kind: "none" });
    expect(parseInsertToolResponse(toolResponse({ choice: "surprise-me" }), 3)).toEqual({
      kind: "none",
    });
  });

  it("accepts a valid portfolio choice with an in-range index and caption", () => {
    const result = parseInsertToolResponse(
      toolResponse({ choice: "portfolio", portfolioCandidateIndex: 1, caption: "Look at this!" }),
      3,
    );
    expect(result).toEqual({ kind: "portfolio", candidateIndex: 1, caption: "Look at this!" });
  });

  it("rejects a portfolio choice with an out-of-range index", () => {
    expect(
      parseInsertToolResponse(
        toolResponse({ choice: "portfolio", portfolioCandidateIndex: 5, caption: "Nice" }),
        3,
      ),
    ).toEqual({ kind: "none" });
    expect(
      parseInsertToolResponse(
        toolResponse({ choice: "portfolio", portfolioCandidateIndex: -1, caption: "Nice" }),
        3,
      ),
    ).toEqual({ kind: "none" });
  });

  it("rejects a portfolio choice missing a caption", () => {
    expect(
      parseInsertToolResponse(
        toolResponse({ choice: "portfolio", portfolioCandidateIndex: 0 }),
        3,
      ),
    ).toEqual({ kind: "none" });
  });

  it("rejects a portfolio choice when there are zero candidates", () => {
    expect(
      parseInsertToolResponse(
        toolResponse({ choice: "portfolio", portfolioCandidateIndex: 0, caption: "Nice" }),
        0,
      ),
    ).toEqual({ kind: "none" });
  });

  it("clips an overlong caption", () => {
    const long = "x".repeat(500);
    const result = parseInsertToolResponse(
      toolResponse({ choice: "portfolio", portfolioCandidateIndex: 0, caption: long }),
      1,
    );
    expect(result.kind).toBe("portfolio");
    if (result.kind === "portfolio") {
      expect(result.caption.length).toBeLessThanOrEqual(MAX_INSERT_CAPTION_LENGTH);
    }
  });

  it("accepts a valid sketch choice with a grounded brief", () => {
    const result = parseInsertToolResponse(
      toolResponse({
        choice: "sketch",
        caption: "A tiny sun for a bright day",
        sketchBrief: "A cheerful sun rising over a row of tide pools",
      }),
      0,
    );
    expect(result.kind).toBe("sketch");
    if (result.kind === "sketch") {
      expect(result.brief).toBe(
        "A cheerful sun rising over a row of tide pools",
      );
      expect(result.caption).toBe("A tiny sun for a bright day");
    }
  });

  it("rejects a sketch choice missing a brief", () => {
    expect(
      parseInsertToolResponse(
        toolResponse({ choice: "sketch", caption: "Ok" }),
        0,
      ),
    ).toEqual({ kind: "none" });
  });

  it("rejects a sketch choice missing a caption", () => {
    expect(
      parseInsertToolResponse(
        toolResponse({
          choice: "sketch",
          sketchBrief: "A hermit crab exploring a tide pool",
        }),
        0,
      ),
    ).toEqual({ kind: "none" });
  });

  it("clips an overlong sketch brief rather than passing it through raw", () => {
    const long = "a wandering paper airplane ".repeat(20);
    const result = parseInsertToolResponse(
      toolResponse({ choice: "sketch", caption: "Neat", sketchBrief: long }),
      0,
    );
    expect(result.kind).toBe("sketch");
    if (result.kind === "sketch") {
      expect(result.brief.length).toBeLessThanOrEqual(MAX_SKETCH_BRIEF_LENGTH);
    }
  });
});

describe("buildSketchImagePrompt", () => {
  it("clips an overlong raw brief defensively, even if a caller forgot to", () => {
    const long = "x".repeat(5000);
    const prompt = buildSketchImagePrompt(long);
    expect(prompt.length).toBeLessThan(long.length);
  });
});

