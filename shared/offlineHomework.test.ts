import { describe, expect, test } from "vitest";
import {
  offlineHomeworkContext,
  offlineHomeworkDueText,
} from "./offlineHomework";

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
    expect(
      offlineHomeworkDueText(
        Date.UTC(2026, 7, 9, 20, 34),
        "Pacific/Honolulu",
      ),
    ).toBe("Due Sun, Aug 9 at 10:34 AM");
    expect(offlineHomeworkDueText(null, "Pacific/Honolulu")).toBe(
      "No due date",
    );
  });
});
