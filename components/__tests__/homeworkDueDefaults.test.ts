import { describe, expect, test } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import {
  activityCompletionNames,
  assignmentEyebrow,
  homeworkDueToastDescription,
  plannedWorkNotice,
} from "../AssignmentPanel";
import { initialHomeworkDueInputValue } from "../ScheduleActivityDialog";

describe("homework due-date writers", () => {
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

describe("the Run page header's planned-vs-sent read", () => {
  test("planned rows are counted, not silently read as nothing", () => {
    // The old header said "nothing pushed yet" over two planned homework
    // rows badged exactly like live ones.
    expect(assignmentEyebrow(0, 2)).toBe(
      "Assignment · 2 planned, nothing sent yet",
    );
    expect(assignmentEyebrow(0, 1)).toBe(
      "Assignment · 1 planned, nothing sent yet",
    );
  });

  test("once something is out, the header says how much of each", () => {
    expect(assignmentEyebrow(1, 2)).toBe("Assignment · 1 sent, 2 planned");
  });

  test("with nothing left planned the eyebrow stays out of the way", () => {
    // The live counts are already chips in the header — the eyebrow only
    // speaks up about the state those chips can't show.
    expect(assignmentEyebrow(2, 0)).toBe("Assignment");
  });

  test("an empty run page keeps the plain eyebrow", () => {
    expect(assignmentEyebrow(0, 0)).toBe("Assignment · nothing sent yet");
  });

  test("an overrun class focus is never reported as nothing sent", () => {
    // Feed it what the server now sends for a started-but-past-its-window
    // focus: sent, nothing planned. The chips drop that entry (its window
    // closed), so passing the chip counts here — as this header used to —
    // produced "nothing sent yet" above a row still offering "Wrap now".
    expect(assignmentEyebrow(1, 0)).toBe("Assignment");
    expect(assignmentEyebrow(1, 0)).not.toContain("nothing sent yet");
  });

  test("the notice names the consequence once", () => {
    // "start", not "see": a planned entry is already visible to the scholar as
    // a non-actionable Coming up preview. What release changes is whether they
    // can open it, so that is what the line claims.
    expect(plannedWorkNotice(1)).toBe(
      "1 activity is planned — scholars can't start it yet.",
    );
    expect(plannedWorkNotice(3)).toBe(
      "3 activities are planned — scholars can't start them yet.",
    );
  });
});
