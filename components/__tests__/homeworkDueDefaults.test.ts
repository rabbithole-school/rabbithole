import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import {
  activityCompletionNames,
  homeworkDueToastDescription,
} from "../AssignmentPanel";
import { initialHomeworkDueInputValue } from "../ScheduleActivityDialog";

const assignmentPanelSource = readFileSync(
  new URL("../AssignmentPanel.tsx", import.meta.url),
  "utf8",
);
const assignWorkDrawerSource = readFileSync(
  new URL("../MasterSchedule/AssignWorkDrawer.tsx", import.meta.url),
  "utf8",
);
const scheduleDialogSource = readFileSync(
  new URL("../ScheduleActivityDialog.tsx", import.meta.url),
  "utf8",
);

describe("homework due-date writers", () => {
  test("client writers leave the next-open-school-day default to Convex", () => {
    expect(assignmentPanelSource).not.toContain("7 * 86_400_000");
    expect(assignWorkDrawerSource).not.toContain("7 * 86_400_000");
    expect(assignmentPanelSource).toContain("HomeworkDueDatePopover");
    expect(assignWorkDrawerSource).not.toMatch(/const dueAt\s*=/);
  });

  test("the full editor no longer seeds dueAt from startsAt plus seven days", () => {
    expect(scheduleDialogSource).toContain("initialDueAt");
    expect(scheduleDialogSource).toContain("homeworkDueDateOptions");
    expect(scheduleDialogSource).not.toContain("+ 7 * DAY");
  });

  test("the full editor preserves the live row's current due date", () => {
    const dueAt = Date.parse("2026-08-25T23:59:00");
    expect(new Date(initialHomeworkDueInputValue(dueAt)).getTime()).toBe(dueAt);
  });

  test("the homework toast uses the popover calendar even for mixed rosters", () => {
    expect(
      homeworkDueToastDescription(
        Date.parse("2026-08-26T09:59:59.999Z"),
        { timeZone: "Pacific/Honolulu" },
      ),
    ).toBe("Due Tue Aug 25");
  });
});

describe("activity completion names", () => {
  test("keeps named done and not-done scholars from completedScholarIds", () => {
    const roster = [
      { scholarId: "scholar-a" as Id<"users">, name: "Ari" },
      { scholarId: "scholar-b" as Id<"users">, name: "Mika" },
      { scholarId: "scholar-c" as Id<"users">, name: "Noa" },
    ];

    expect(activityCompletionNames(roster, ["scholar-b"])).toEqual({
      done: ["Mika"],
      notDone: ["Ari", "Noa"],
    });
  });
});
