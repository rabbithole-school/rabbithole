import { describe, expect, test } from "vitest";
import { canRevokeInvite } from "./inviteStatus";

describe("canRevokeInvite", () => {
  test.each([
    ["active", true],
    ["revoked", false],
    ["expired", false],
    ["exhausted", false],
  ] as const)("%s invite => %s", (status, expected) => {
    expect(canRevokeInvite(status)).toBe(expected);
  });
});
