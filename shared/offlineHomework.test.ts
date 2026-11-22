import { describe, expect, test } from "vitest";
import {
  offlineHomeworkContext,
  offlineHomeworkDueText,
  offlineHomeworkFinishCopy,
} from "./offlineHomework";

describe("the finish block's words", () => {
  test("homework is finished at home; open-until work leaves the list", () => {
    expect(offlineHomeworkFinishCopy("Ms. Rivera").prompt).toBe("Finished this at home?");
    const openUntil = offlineHomeworkFinishCopy("Ms. Rivera", { isHomework: false });
    expect(openUntil.prompt).toBe("Finished this?");
    expect(openUntil.detail).toContain("leaves your list. Ms. Rivera will see it.");
  });
});

describe("offline homework display helpers", () => {
  test("formats unit and optional lesson context", () => {
    expect(
      offlineHomeworkContext({
        unitEmoji: "🔭",
        unitTitle: "Space science",
        lessonTitle: "Orbits",
        teacherName: "Ms. Rivera",
      }),
    ).toBe("🔭 Space science · Orbits");
  });

  test("falls back to teacher context and formats absolute due dates", () => {
    expect(
      offlineHomeworkContext({
        unitEmoji: null,
        unitTitle: null,
        lessonTitle: null,
        teacherName: "Ms. Rivera",
      }),
    ).toBe("From Ms. Rivera");
    const now = Date.UTC(2026, 7, 3, 22, 0);
    // Same wording as every other due date (dueStatus), capitalized.
    expect(
      offlineHomeworkDueText(Date.UTC(2026, 7, 9, 20, 34), now, "Pacific/Honolulu"),
    ).toBe("Due Sun, Aug 9");
    expect(
      offlineHomeworkDueText(Date.UTC(2026, 6, 20, 20, 34), now, "Pacific/Honolulu"),
    ).toBe("Was due Mon, Jul 20");
    expect(offlineHomeworkDueText(null, now, "Pacific/Honolulu")).toBe(
      "No due date",
    );
  });
});
