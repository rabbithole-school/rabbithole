import { describe, expect, test } from "vitest";
import { passwordAuthParams } from "../../vendor/shared/password";

describe("native password sign-in", () => {
  test("preserves keyboard input for legacy credential verification", () => {
    expect(passwordAuthParams("  burrow  ", "signIn")).toEqual({
      password: "  burrow  ",
      flow: "signIn",
    });
  });
});
