import { afterEach, describe, expect, test, vi } from "vitest";
import {
  encryptGoogleToken,
  isEncryptedGoogleToken,
  openGoogleAccountTokens,
  openGoogleToken,
  sealGoogleToken,
} from "../googleTokenCrypto";

function randomKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("google token encryption", () => {
  test("round-trips through the v1 format", async () => {
    vi.stubEnv("GOOGLE_TOKEN_ENCRYPTION_KEY", randomKey());
    const sealed = await encryptGoogleToken("ya29.access-token");
    expect(sealed).toMatch(/^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain("ya29");
    expect(isEncryptedGoogleToken(sealed)).toBe(true);
    expect(await openGoogleToken(sealed)).toBe("ya29.access-token");
  });

  test("uses a fresh IV for every encryption", async () => {
    vi.stubEnv("GOOGLE_TOKEN_ENCRYPTION_KEY", randomKey());
    const a = await encryptGoogleToken("same");
    const b = await encryptGoogleToken("same");
    expect(a).not.toBe(b);
    expect(a.split(":")[1]).not.toBe(b.split(":")[1]);
  });

  test("a tampered ciphertext fails to decrypt", async () => {
    vi.stubEnv("GOOGLE_TOKEN_ENCRYPTION_KEY", randomKey());
    const sealed = await encryptGoogleToken("1//refresh-token");
    const [version, iv, ciphertext] = sealed.split(":");
    const flipped =
      (ciphertext[0] === "A" ? "B" : "A") + ciphertext.slice(1);
    await expect(openGoogleToken(`${version}:${iv}:${flipped}`)).rejects.toThrow(
      /failed to decrypt/,
    );
    const otherIv = (iv[0] === "A" ? "B" : "A") + iv.slice(1);
    await expect(openGoogleToken(`${version}:${otherIv}:${ciphertext}`)).rejects.toThrow(
      /failed to decrypt/,
    );
  });

  test("a different key cannot decrypt", async () => {
    vi.stubEnv("GOOGLE_TOKEN_ENCRYPTION_KEY", randomKey());
    const sealed = await encryptGoogleToken("secret");
    vi.stubEnv("GOOGLE_TOKEN_ENCRYPTION_KEY", randomKey());
    await expect(openGoogleToken(sealed)).rejects.toThrow(/failed to decrypt/);
  });

  test("legacy plaintext still reads (widen phase)", async () => {
    vi.stubEnv("GOOGLE_TOKEN_ENCRYPTION_KEY", randomKey());
    expect(await openGoogleToken("ya29.legacy")).toBe("ya29.legacy");
    expect(
      await openGoogleAccountTokens({
        accessToken: "ya29.legacy",
        refreshToken: "1//legacy-refresh",
      }),
    ).toEqual({ accessToken: "ya29.legacy", refreshToken: "1//legacy-refresh" });
  });

  test("an unknown version is rejected rather than used as a bearer token", async () => {
    vi.stubEnv("GOOGLE_TOKEN_ENCRYPTION_KEY", randomKey());
    await expect(openGoogleToken("v9:abc:def")).rejects.toThrow(/Unrecognised/);
  });

  test("reading v1 without a key names the missing env var", async () => {
    vi.stubEnv("GOOGLE_TOKEN_ENCRYPTION_KEY", randomKey());
    const sealed = await encryptGoogleToken("secret");
    vi.stubEnv("GOOGLE_TOKEN_ENCRYPTION_KEY", "");
    await expect(openGoogleToken(sealed)).rejects.toThrow(
      /GOOGLE_TOKEN_ENCRYPTION_KEY/,
    );
  });

  test("rejects a key that is not 32 bytes", async () => {
    vi.stubEnv("GOOGLE_TOKEN_ENCRYPTION_KEY", btoa("too-short"));
    await expect(encryptGoogleToken("x")).rejects.toThrow(/32 bytes/);
  });

  test("sealGoogleToken encrypts when the key is set and never double-wraps", async () => {
    vi.stubEnv("GOOGLE_TOKEN_ENCRYPTION_KEY", randomKey());
    const sealed = await sealGoogleToken("ya29.token");
    expect(isEncryptedGoogleToken(sealed)).toBe(true);
    expect(await sealGoogleToken(sealed)).toBe(sealed);
  });

  test("the write path refuses to start on production without a key", async () => {
    vi.stubEnv("GOOGLE_TOKEN_ENCRYPTION_KEY", "");
    vi.stubEnv("CONVEX_CLOUD_URL", "https://example-prod-001.convex.cloud");
    await expect(sealGoogleToken("ya29.token")).rejects.toThrow(
      /GOOGLE_TOKEN_ENCRYPTION_KEY/,
    );
  });

  test("any hosted deployment without the dev opt-in refuses without a key", async () => {
    vi.stubEnv("GOOGLE_TOKEN_ENCRYPTION_KEY", "");
    vi.stubEnv("CONVEX_CLOUD_URL", "https://some-prototype-123.convex.cloud");
    vi.stubEnv("ADMISSIONS_DEV_MODE", "");
    await expect(sealGoogleToken("ya29.token")).rejects.toThrow(/GOOGLE_TOKEN_ENCRYPTION_KEY/);
    vi.stubEnv("ADMISSIONS_DEV_MODE", "true"); // only "1" opts in
    await expect(sealGoogleToken("ya29.token")).rejects.toThrow(/GOOGLE_TOKEN_ENCRYPTION_KEY/);
  });

  test("a hosted dev deployment that opts in without a key keeps legacy plaintext", async () => {
    vi.stubEnv("GOOGLE_TOKEN_ENCRYPTION_KEY", "");
    vi.stubEnv("CONVEX_CLOUD_URL", "https://some-prototype-123.convex.cloud");
    vi.stubEnv("ADMISSIONS_DEV_MODE", "1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await sealGoogleToken("ya29.token")).toBe("ya29.token");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
