import { describe, expect, test } from "vitest";
import {
  computeSlackSignature,
  verifySlackSignature,
} from "../slackSignature";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";

describe("slackSignature", () => {
  test("round-trips: a computed signature verifies", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ type: "event_callback", event_id: "Ev123" });
    const sig = await computeSlackSignature(SECRET, ts, body);
    expect(sig.startsWith("v0=")).toBe(true);
    expect(
      await verifySlackSignature({
        signingSecret: SECRET,
        timestampHeader: ts,
        signatureHeader: sig,
        rawBody: body,
      }),
    ).toBe(true);
  });

  test("is deterministic and shaped like Slack's v0 scheme", async () => {
    const sig1 = await computeSlackSignature(SECRET, "1531420618", "body");
    const sig2 = await computeSlackSignature(SECRET, "1531420618", "body");
    expect(sig1).toBe(sig2);
    expect(sig1).toMatch(/^v0=[0-9a-f]{64}$/);
    // Different inputs → different signatures.
    expect(await computeSlackSignature(SECRET, "1531420619", "body")).not.toBe(sig1);
    expect(await computeSlackSignature(SECRET, "1531420618", "other")).not.toBe(sig1);
  });

  test("rejects a tampered body", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await computeSlackSignature(SECRET, ts, "original");
    expect(
      await verifySlackSignature({
        signingSecret: SECRET,
        timestampHeader: ts,
        signatureHeader: sig,
        rawBody: "tampered",
      }),
    ).toBe(false);
  });

  test("rejects a stale timestamp (replay window)", async () => {
    const staleTs = String(Math.floor(Date.now() / 1000) - 6 * 60);
    const sig = await computeSlackSignature(SECRET, staleTs, "body");
    expect(
      await verifySlackSignature({
        signingSecret: SECRET,
        timestampHeader: staleTs,
        signatureHeader: sig,
        rawBody: "body",
      }),
    ).toBe(false);
  });

  test("rejects missing headers and garbage timestamps", async () => {
    expect(
      await verifySlackSignature({
        signingSecret: SECRET,
        timestampHeader: null,
        signatureHeader: "v0=abc",
        rawBody: "x",
      }),
    ).toBe(false);
    expect(
      await verifySlackSignature({
        signingSecret: SECRET,
        timestampHeader: "not-a-number",
        signatureHeader: "v0=abc",
        rawBody: "x",
      }),
    ).toBe(false);
    expect(
      await verifySlackSignature({
        signingSecret: "",
        timestampHeader: String(Math.floor(Date.now() / 1000)),
        signatureHeader: "v0=abc",
        rawBody: "x",
      }),
    ).toBe(false);
  });
});
