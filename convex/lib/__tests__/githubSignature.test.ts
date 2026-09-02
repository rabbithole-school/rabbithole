import { describe, expect, test } from "vitest";
import { computeGithubSignature, verifyGithubSignature } from "../githubSignature";

const SECRET = "test-webhook-secret";

describe("githubSignature", () => {
  test("round-trips: a computed signature verifies", async () => {
    const body = JSON.stringify({ zen: "Design for failure." });
    const sig = await computeGithubSignature(SECRET, body);
    expect(sig.startsWith("sha256=")).toBe(true);
    expect(
      await verifyGithubSignature({
        secret: SECRET,
        signatureHeader: sig,
        rawBody: body,
      }),
    ).toBe(true);
  });

  test("is deterministic and shaped like GitHub's sha256 scheme", async () => {
    const sig1 = await computeGithubSignature(SECRET, "body");
    const sig2 = await computeGithubSignature(SECRET, "body");
    expect(sig1).toBe(sig2);
    expect(sig1).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(await computeGithubSignature(SECRET, "other")).not.toBe(sig1);
    expect(await computeGithubSignature("other-secret", "body")).not.toBe(sig1);
  });

  test("rejects a tampered body", async () => {
    const sig = await computeGithubSignature(SECRET, "original");
    expect(
      await verifyGithubSignature({
        secret: SECRET,
        signatureHeader: sig,
        rawBody: "tampered",
      }),
    ).toBe(false);
  });

  test("fails closed: no secret configured", async () => {
    const sig = await computeGithubSignature(SECRET, "body");
    expect(
      await verifyGithubSignature({
        secret: undefined,
        signatureHeader: sig,
        rawBody: "body",
      }),
    ).toBe(false);
  });

  test("fails closed: missing signature header", async () => {
    expect(
      await verifyGithubSignature({
        secret: SECRET,
        signatureHeader: null,
        rawBody: "body",
      }),
    ).toBe(false);
  });

  test("rejects a garbage signature header", async () => {
    expect(
      await verifyGithubSignature({
        secret: SECRET,
        signatureHeader: "sha256=deadbeef",
        rawBody: "body",
      }),
    ).toBe(false);
  });
});
