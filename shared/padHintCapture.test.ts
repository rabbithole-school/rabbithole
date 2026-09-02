import { describe, expect, it } from "vitest";
import { padHintCaptureForTrigger } from "./padHintCapture";

const ink = { uri: "file:///pad.png", mime: "image/png" };

describe("pad hint capture consent", () => {
  it("uses ink only when the scholar tapped Hint", () => {
    expect(padHintCaptureForTrigger("hint", ink)).toEqual(ink);
  });

  it("keeps an empty pad on the deterministic path", () => {
    expect(padHintCaptureForTrigger("hint", null)).toBeNull();
  });

  it("does not treat a miss capture as Hint consent", () => {
    expect(padHintCaptureForTrigger("miss", ink)).toBeNull();
  });
});
