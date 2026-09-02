import { describe, expect, test } from "vitest";

import {
  parentTabFromPath,
  parentVisibleTabs,
  PARENT_VISIBLE_TABS,
} from "./parentTabs";

describe("parent tabs", () => {
  test("supports the enrolled-family routes, including an empty portfolio", () => {
    expect(PARENT_VISIBLE_TABS).toEqual([
      "records",
      "portfolio",
      "math",
      "calendar",
      "messages",
    ]);
    expect(parentTabFromPath("/parent/records")).toBe("records");
    expect(parentTabFromPath("/parent/portfolio")).toBe("portfolio");
    expect(parentTabFromPath("/parent/math")).toBe("math");
    expect(parentTabFromPath("/parent/calendar")).toBe("calendar");
  });

  test("always includes Messages for enrolled families", () => {
    expect(parentVisibleTabs()).toEqual([
      "records",
      "portfolio",
      "math",
      "calendar",
      "messages",
    ]);
    expect(parentTabFromPath("/parent/messages")).toBe("messages");
  });

  test("falls back to Records for unknown or hidden routes", () => {
    expect(parentTabFromPath("/parent")).toBe("records");
    expect(parentTabFromPath("/parent/progress")).toBe("records");
    expect(parentTabFromPath("/parent/settings")).toBe("records");
    expect(parentTabFromPath("/parent/unknown")).toBe("records");
  });

  test("lands program-guest families on Records with Messages also available", () => {
    expect(parentVisibleTabs(true)).toEqual(["records", "messages"]);
    expect(parentTabFromPath("/parent", true)).toBe("records");
    expect(parentTabFromPath("/parent/records", true)).toBe("records");
    expect(parentTabFromPath("/parent/portfolio", true)).toBe("records");
    expect(parentTabFromPath("/parent/messages", true)).toBe(
      "messages",
    );
  });
});
