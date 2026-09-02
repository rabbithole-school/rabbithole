import { describe, expect, test } from "vitest";
import { messageThreadHref } from "../messageThreadUrl";

describe("messageThreadHref", () => {
  test("adds a thread while preserving the rest of the page context", () => {
    expect(
      messageThreadHref(
        "/teacher/messages",
        new URLSearchParams("inst=moli&scope=mine"),
        "thread-123",
      ),
    ).toBe("/teacher/messages?inst=moli&scope=mine&thread=thread-123");
  });

  test("removes only the thread selection", () => {
    expect(
      messageThreadHref(
        "/parent/messages",
        new URLSearchParams("child=scholar-1&thread=old"),
        null,
      ),
    ).toBe("/parent/messages?child=scholar-1");
  });
});
