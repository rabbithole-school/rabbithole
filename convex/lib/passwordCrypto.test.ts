import { describe, expect, test } from "vitest";
import { Scrypt } from "lucia";
import { passwordCrypto } from "./passwordCrypto";

describe("passwordCrypto", () => {
  test("hashes normalized credentials and verifies padded sign-in/current-password input", async () => {
    const hash = await passwordCrypto.hashSecret("  rabbit hole  ");

    await expect(passwordCrypto.verifySecret("rabbit hole", hash)).resolves.toBe(
      true,
    );
    await expect(
      passwordCrypto.verifySecret("\t rabbit hole \n", hash),
    ).resolves.toBe(true);

    await expect(new Scrypt().verify(hash, "  rabbit hole  ")).resolves.toBe(
      false,
    );
  });

  test("accepts a legacy hash only with its original edge whitespace", async () => {
    const legacyPassword = "  rabbit hole  ";
    const legacyHash = await new Scrypt().hash(legacyPassword);

    await expect(
      passwordCrypto.verifySecret(legacyPassword, legacyHash),
    ).resolves.toBe(true);
    await expect(
      passwordCrypto.verifySecret("rabbit hole", legacyHash),
    ).resolves.toBe(false);
  });
});
