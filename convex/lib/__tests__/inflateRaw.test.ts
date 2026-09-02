import { deflateRawSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { inflateRaw } from "../inflateRaw";

const enc = new TextEncoder();
const dec = new TextDecoder();

function deflate(text: string): Uint8Array {
  return new Uint8Array(deflateRawSync(Buffer.from(text, "utf-8")));
}

describe("inflateRaw", () => {
  test("round-trips a small literal-heavy payload", () => {
    const text = "Hello, curriculum bot!";
    const bytes = enc.encode(text);
    const out = inflateRaw(deflate(text), bytes.length);
    expect(out.length).toBe(bytes.length);
    expect(dec.decode(out)).toBe(text);
  });

  test("round-trips a large, repetitive payload (exercises back-references + dynamic Huffman)", () => {
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(5000);
    const bytes = enc.encode(text);
    const out = inflateRaw(deflate(text), bytes.length);
    expect(dec.decode(out)).toBe(text);
  });

  test("over-declared expectedSize (up to ~4GB uint32) does NOT allocate that much and still decodes", () => {
    // The ZIP central directory's uncompressedSize is attacker-controlled. A
    // crafted value of 0xFFFFFFFF must not trigger a ~4GB allocation. The cap
    // means we allocate MAX_INFLATE_BYTES at most; a small valid stream still
    // decodes correctly (its real output is far under the cap).
    const text = "small but lying about its size";
    const out = inflateRaw(deflate(text), 0xffffffff);
    expect(dec.decode(out)).toBe(text);
  });

  test("stream that produces more output than declared throws (no overflow)", () => {
    const text = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    // Declare far fewer bytes than the stream actually emits.
    expect(() => inflateRaw(deflate(text), 4)).toThrow(
      /output exceeds expected size/,
    );
  });

  test("truncated DEFLATE stream throws quickly instead of hanging", () => {
    const full = deflate("The quick brown fox. ".repeat(2000));
    const truncated = full.subarray(0, Math.floor(full.length / 2));
    const start = Date.now();
    // Declare a generous size so termination comes from a guard/mismatch, not
    // from filling the buffer.
    expect(() => inflateRaw(truncated, 1024 * 1024)).toThrow();
    // If the old unbounded loop regressed, this would spin for seconds/forever.
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test("garbage bytes throw quickly instead of hanging", () => {
    const garbage = new Uint8Array(64);
    for (let i = 0; i < garbage.length; i++) garbage[i] = (i * 37 + 11) & 0xff;
    const start = Date.now();
    expect(() => inflateRaw(garbage, 1024 * 1024)).toThrow();
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test("all-zero bytes with a large declared size terminate quickly (no infinite loop)", () => {
    // All-zero input is the classic degenerate case: fixed-Huffman blocks that
    // decode to end-of-block, then a stored block with a length/inv-length
    // mismatch — must throw, not loop.
    const zeros = new Uint8Array(32);
    const start = Date.now();
    expect(() => inflateRaw(zeros, 8 * 1024 * 1024)).toThrow();
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
