import { describe, it, expect } from "vitest";
import {
  bytesToBase64,
  hashText,
  ttsFileName,
  prepareSpeech,
} from "../ttsAudio";

// Reference base64 via node's Buffer (the impl deliberately avoids Buffer).
function ref(bytes: number[]): string {
  return Buffer.from(bytes).toString("base64");
}

describe("bytesToBase64", () => {
  it("encodes an empty array to an empty string", () => {
    expect(bytesToBase64(new Uint8Array([]))).toBe("");
  });

  it("matches Buffer for lengths hitting every padding case", () => {
    for (const arr of [[0], [0, 255], [0, 127, 255], [77, 97, 110], [1, 2, 3, 4, 5]]) {
      expect(bytesToBase64(new Uint8Array(arr))).toBe(ref(arr));
    }
  });

  it("matches Buffer for a pseudo-random binary blob (all byte values)", () => {
    const bytes = Array.from({ length: 256 }, (_, i) => (i * 37 + 11) & 0xff);
    expect(bytesToBase64(new Uint8Array(bytes))).toBe(ref(bytes));
  });

  it("pads correctly: 1 byte → 2 chars + '=='", () => {
    expect(bytesToBase64(new Uint8Array([0]))).toBe("AA==");
  });

  it("pads correctly: 2 bytes → 3 chars + '='", () => {
    expect(bytesToBase64(new Uint8Array([0, 0]))).toBe("AAA=");
  });
});

describe("hashText", () => {
  it("is deterministic", () => {
    expect(hashText("Spiders have eight legs")).toBe(
      hashText("Spiders have eight legs"),
    );
  });

  it("differs for different input", () => {
    expect(hashText("cat")).not.toBe(hashText("dog"));
  });

  it("is always 8 lowercase hex chars", () => {
    for (const s of ["", "a", "a much longer label with spaces!", "🕷️"]) {
      expect(hashText(s)).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});

describe("ttsFileName", () => {
  it("wraps the hash in the rh-tts-*.mp3 pattern", () => {
    expect(ttsFileName("hello")).toBe(`rh-tts-${hashText("hello")}.mp3`);
    expect(ttsFileName("hello")).toMatch(/^rh-tts-[0-9a-f]{8}\.mp3$/);
  });
});

describe("prepareSpeech", () => {
  it("trims and collapses whitespace", () => {
    expect(prepareSpeech("  hello   world \n")).toBe("hello world");
  });

  it("returns empty for blank/whitespace-only input", () => {
    expect(prepareSpeech("")).toBe("");
    expect(prepareSpeech("   \n\t ")).toBe("");
  });

  it("clamps to 4096 chars", () => {
    const long = "x".repeat(5000);
    expect(prepareSpeech(long).length).toBe(4096);
  });

  it("leaves short labels untouched", () => {
    expect(prepareSpeech("Tap what you want to do")).toBe(
      "Tap what you want to do",
    );
  });
});
