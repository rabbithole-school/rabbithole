import { describe, expect, test } from "vitest";
import { classifyAideUpload } from "../aideUploadMimes";

describe("classifyAideUpload media", () => {
  test("uses the MIME prefix before an ambiguous extension", () => {
    expect(classifyAideUpload("audio/webm", "clip.webm")).toBe("audio");
    expect(classifyAideUpload("video/webm", "clip.webm")).toBe("video");
    expect(classifyAideUpload("audio/mp4", "clip.mp4")).toBe("audio");
    expect(classifyAideUpload("video/mp4", "clip.m4a")).toBe("video");
  });

  test("falls back to video extensions", () => {
    expect(classifyAideUpload("", "clip.webm")).toBe("video");
    expect(classifyAideUpload(undefined, "clip.mp4")).toBe("video");
    expect(classifyAideUpload(null, "clip.mov")).toBe("video");
  });

  test("falls back to audio extensions", () => {
    expect(classifyAideUpload("", "clip.m4a")).toBe("audio");
    expect(classifyAideUpload(undefined, "clip.mp3")).toBe("audio");
    expect(classifyAideUpload(null, "clip.wav")).toBe("audio");
    expect(classifyAideUpload("", "clip.ogg")).toBe("audio");
  });
});
