import { describe, expect, test } from "vitest";
import { messagingSchoolSlug } from "./messagingScope";

describe("messagingSchoolSlug", () => {
  test("names the requested school only on Messages", () => {
    expect(messagingSchoolSlug("/teacher/messages", "moli")).toBe("moli");
    expect(messagingSchoolSlug("/teacher/scholars", "moli")).toBeNull();
  });

  test("home and all-schools views have no messaging-specific school", () => {
    expect(messagingSchoolSlug("/teacher/messages", "")).toBeNull();
    expect(messagingSchoolSlug("/teacher/messages", "all")).toBeNull();
  });
});
