import { describe, expect, it } from "vitest";
import {
  safeTutorKeyReturnPath,
  TUTOR_KEY_DEFAULT_RETURN,
  tutorKeyHref,
} from "./tutorKeyReturn";
import { TUTOR_KEY_PATH } from "@/shared/tutorKey";

describe("safeTutorKeyReturnPath", () => {
  it.each([
    "/scholar",
    "/scholar/abc123",
    "/scholar/abc123?quest=1&tab=chat",
    "/scholar/abc123#end",
  ])("keeps the same-origin path %s", (path) => {
    expect(safeTutorKeyReturnPath(path)).toBe(path);
  });

  it.each([
    ["protocol-relative", "//evil.com"],
    ["absolute URL", "https://evil.com"],
    ["backslash", "/\\evil.com"],
    ["javascript: scheme", "javascript:alert(1)"],
    ["empty", ""],
    ["relative without a slash", "scholar"],
    ["tab smuggling", "/\t/evil.com"],
    ["newline", "/scholar\n"],
  ])("falls back for %s", (_label, raw) => {
    expect(safeTutorKeyReturnPath(raw)).toBe(TUTOR_KEY_DEFAULT_RETURN);
  });

  it("falls back when next is absent or repeated", () => {
    expect(safeTutorKeyReturnPath(undefined)).toBe(TUTOR_KEY_DEFAULT_RETURN);
    expect(safeTutorKeyReturnPath(["/a", "/b"])).toBe(TUTOR_KEY_DEFAULT_RETURN);
  });
});

describe("tutorKeyHref", () => {
  it("returns to the chat's path and query", () => {
    expect(tutorKeyHref(TUTOR_KEY_PATH, "/scholar/abc123?quest=1")).toBe(
      "/tutor-key?next=%2Fscholar%2Fabc123%3Fquest%3D1",
    );
  });

  it("never carries an off-site return", () => {
    expect(tutorKeyHref(TUTOR_KEY_PATH, "//evil.com")).toBe(
      "/tutor-key?next=%2Fscholar",
    );
  });
});
