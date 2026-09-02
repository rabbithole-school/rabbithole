import { describe, expect, test } from "vitest";
import { signState, verifyState, STATE_TTL_MS } from "../lib/google";

const SECRET = "test-secret-32-chars-aaaaaaaaaaaaa";

describe("OAuth state signing + verification", () => {
  test("verifyState recovers the signed payload", async () => {
    const payload = { userId: "u1", returnTo: "/teacher", nonce: "abc" };
    const state = await signState(payload, SECRET);
    const out = await verifyState<typeof payload & { iat: number }>(
      state,
      SECRET
    );
    expect(out).not.toBeNull();
    expect(out?.userId).toBe("u1");
    expect(out?.returnTo).toBe("/teacher");
    expect(out?.nonce).toBe("abc");
    expect(typeof out?.iat).toBe("number");
  });

  test("verifyState rejects a tampered payload", async () => {
    const state = await signState({ userId: "u1" }, SECRET);
    // Flip a character in the json half (before the dot).
    const [b64Json, sig] = state.split(".");
    const tampered = b64Json.slice(0, -1) + "X" + "." + sig;
    const out = await verifyState(tampered, SECRET);
    expect(out).toBeNull();
  });

  test("verifyState rejects a wrong secret", async () => {
    const state = await signState({ userId: "u1" }, SECRET);
    const out = await verifyState(state, "different-secret-32-chars-bbbbbbbbb");
    expect(out).toBeNull();
  });

  test("verifyState rejects state older than STATE_TTL_MS", async () => {
    // Pretend we signed STATE_TTL_MS + 1s ago by passing a frozen `now`
    // to signState. verifyState reads its own `now` (default Date.now)
    // and compares against the embedded iat.
    const longAgo = Date.now() - (STATE_TTL_MS + 1000);
    const state = await signState({ userId: "u1" }, SECRET, longAgo);
    const out = await verifyState(state, SECRET);
    expect(out).toBeNull();
  });

  test("verifyState accepts state right at the TTL boundary", async () => {
    // 1 second under the limit — should still verify.
    const justInTime = Date.now() - (STATE_TTL_MS - 1000);
    const state = await signState({ userId: "u1" }, SECRET, justInTime);
    const out = await verifyState(state, SECRET);
    expect(out).not.toBeNull();
  });

  test("verifyState rejects malformed input", async () => {
    expect(await verifyState("not-a-state", SECRET)).toBeNull();
    expect(await verifyState("only-one-half", SECRET)).toBeNull();
    expect(await verifyState("", SECRET)).toBeNull();
  });

  test("verifyState rejects state with no iat (legacy, unsigned-time)", async () => {
    // Hand-craft a state where the payload has no iat. Compute its
    // signature so the HMAC check passes — just to prove the iat
    // requirement is enforced separately.
    const json = JSON.stringify({ userId: "u1", noIat: true });
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(json));
    const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
    const state = `${btoa(json)}.${b64}`;
    const out = await verifyState(state, SECRET);
    expect(out).toBeNull();
  });
});
