import { describe, expect, test } from "vitest";
import { composerAfterPersistedSend } from "../composerAfterSend";

describe("composerAfterPersistedSend", () => {
  test("the <start> opener never erases what the scholar is typing (TRA-527)", () => {
    expect(
      composerAfterPersistedSend("do sharks ever sleep?", {
        directText: "<start>",
      }),
    ).toBe("do sharks ever sleep?");
  });

  test("a dictated take leaves typed text alone", () => {
    expect(
      composerAfterPersistedSend("half a typed thought", {
        directText: "what I said out loud",
      }),
    ).toBe("half a typed thought");
  });

  test("an app update leaves typed text alone", () => {
    expect(
      composerAfterPersistedSend("my next question", { isAppRequest: true }),
    ).toBe("my next question");
  });

  test("a send from the composer clears it", () => {
    expect(composerAfterPersistedSend("do sharks ever sleep?", {})).toBe("");
  });

  test("blank direct text falls back to the composer, so it clears it", () => {
    // handleSend sends the composer when directText is blank; leaving the box
    // full would let the same text be sent twice.
    expect(
      composerAfterPersistedSend("do sharks ever sleep?", { directText: "  " }),
    ).toBe("");
  });
});
