import { describe, expect, test } from "vitest";
import {
  sha256Hex,
  base64UrlEncode,
  pkceChallengeFromVerifier,
  isValidPkceVerifier,
  randomToken,
} from "../oauthCrypto";

describe("base64UrlEncode", () => {
  test("matches Node's base64url for assorted lengths", () => {
    for (const len of [0, 1, 2, 3, 4, 31, 32, 33]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 37 + 5) % 256);
      expect(base64UrlEncode(bytes)).toBe(
        Buffer.from(bytes).toString("base64url"),
      );
    }
  });
});

describe("pkceChallengeFromVerifier", () => {
  test("matches the RFC 7636 appendix B vector", async () => {
    // https://datatracker.ietf.org/doc/html/rfc7636#appendix-B
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(await pkceChallengeFromVerifier(verifier)).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("isValidPkceVerifier", () => {
  test("accepts the RFC vector and a 43-char minimum", () => {
    expect(isValidPkceVerifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(true);
    expect(isValidPkceVerifier("a".repeat(43))).toBe(true);
    expect(isValidPkceVerifier("a".repeat(128))).toBe(true);
  });

  test("rejects too-short, too-long, and bad characters", () => {
    expect(isValidPkceVerifier("a".repeat(42))).toBe(false);
    expect(isValidPkceVerifier("a".repeat(129))).toBe(false);
    expect(isValidPkceVerifier("a".repeat(42) + "!")).toBe(false);
    expect(isValidPkceVerifier("")).toBe(false);
  });
});

describe("sha256Hex / randomToken", () => {
  test("sha256Hex produces the known hash of 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("randomToken is hex of the requested byte length", () => {
    const token = randomToken(16);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(randomToken()).toMatch(/^[0-9a-f]{64}$/);
  });
});
