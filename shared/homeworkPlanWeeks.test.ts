import { describe, expect, test } from "vitest";
import {
  buildHomeworkMonth,
  homeworkMonthFirstDay,
  homeworkMonthKeyFor,
  homeworkPlanWeek,
  homeworkPlanWindowStart,
  shiftMonthKey,
} from "./homeworkPlanWeeks";

const TZ = "Pacific/Honolulu";
const at = (local: string) => Date.parse(`${local}-10:00`);
// Wednesday, Nov 11 2026, 7pm in Honolulu.
const WEDNESDAY = at("2026-11-11T19:00:00");
const item = (key: string, local: string | null) => ({
  key,
  dueAt: local ? at(local) : null,
});
const veteransDay = {
  startDayKey: "2026-11-11",
  endDayKey: "2026-11-11",
  label: "Veterans Day",
};
const thanksgiving = {
  startDayKey: "2026-11-26",
  endDayKey: "2026-11-27",
  label: "Thanksgiving Break",
};

describe("buildHomeworkMonth", () => {
  const month = buildHomeworkMonth(
    [
      item("fri-9", "2026-11-13T23:59:00"),
      item("wed-9", "2026-11-11T12:00:00"),
      item("wed-thanksgiving", "2026-11-25T23:59:00"),
      item("thu-thanksgiving", "2026-11-26T23:59:00"),
      item("undated", null),
      item("december", "2026-12-04T23:59:00"),
      item("october", "2026-10-30T23:59:00"),
    ],
    [veteransDay, thanksgiving],
    { monthKey: "2026-11", nowMs: WEDNESDAY, timeZone: TZ },
  );

  test("one subheading per school week with a weekday in the month", () => {
    expect(month.title).toBe("November 2026");
    // Nov 1 is a Sunday, so the first week is Nov 2–6; Nov 30–Dec 4 is the last.
    expect(month.weeks.map((w) => w.heading)).toEqual([
      "Nov 2–6",
      "This week · Nov 9–13",
      "Next week · Nov 16–20",
      "Nov 23–27",
      "Nov 30–Dec 4",
    ]);
  });

  test("one quiet closure line per week, days in full", () => {
    expect(month.weeks[1].closedNote).toBe("No school Wednesday (Veterans Day)");
    expect(month.weeks[3].closedNote).toBe(
      "No school Thursday–Friday (Thanksgiving Break)",
    );
    expect(month.weeks[2].closedNote).toBeNull();
  });

  test("due phrases: this week for the last school day, full weekday otherwise", () => {
    expect(month.weeks[1].entries.map((e) => [e.item.key, e.when])).toEqual([
      ["wed-9", "Due today"],
      ["fri-9", "Due this week"],
    ]);
    // Beyond next week the day is named: "this week" under "Nov 23–27"
    // would point at the wrong week.
    expect(month.weeks[3].entries.map((e) => [e.item.key, e.when])).toEqual([
      ["wed-thanksgiving", "Due Wednesday"],
      ["thu-thanksgiving", "Due Thursday"],
    ]);
    // The week overlapping December still holds its Friday.
    expect(month.weeks[4].entries.map((e) => e.item.key)).toEqual(["december"]);
  });

  test("a due day already past reads as a plain date, today and ahead keep their wording", () => {
    const when = (local: string, now = WEDNESDAY) =>
      buildHomeworkMonth([item("x", local)], [], {
        monthKey: "2026-11",
        nowMs: now,
        timeZone: TZ,
      }).weeks.flatMap((w) => w.entries.map((e) => e.when))[0];
    // Monday of this week, already past: not "Due Monday".
    expect(when("2026-11-09T23:59:00")).toBe("Was due Mon, Nov 9");
    // Late in the day still counts as today; tomorrow and a later day ahead.
    expect(when("2026-11-11T23:59:00")).toBe("Due today");
    expect(when("2026-11-12T23:59:00")).toBe("Due tomorrow");
    expect(when("2026-11-16T23:59:00")).toBe("Due Monday");
    // The next Monday, seen from Tuesday of that week, is the past one.
    expect(when("2026-11-16T23:59:00", at("2026-11-17T08:00:00"))).toBe(
      "Was due Mon, Nov 16",
    );
  });

  test("an empty week ahead is not posted yet; an empty week now or before has none", () => {
    expect(month.weeks[2].entries).toEqual([]);
    expect(month.weeks[2].emptyText).toBe("Not posted yet.");
    expect(month.weeks[0].emptyText).toBe("No homework.");
  });

  test("weeks outside the month and undated work stay out of the weeks", () => {
    const keys = month.weeks.flatMap((w) => w.entries.map((e) => e.item.key));
    expect(keys).not.toContain("october");
    expect(month.undated.map((i) => i.key)).toEqual(["undated"]);
  });

  test("open-until work is Open from class after the weeks, never in a week (TRA-724)", () => {
    const open = buildHomeworkMonth(
      [
        { key: "open-next-tue", dueAt: null, openUntil: at("2026-11-18T00:00:00") },
        item("due-fri", "2026-11-13T23:59:00"),
        { key: "open-sat", dueAt: null, openUntil: at("2026-11-15T00:00:00") },
        { key: "open-december", dueAt: null, openUntil: at("2026-12-12T00:00:00") },
      ],
      [],
      { monthKey: "2026-11", nowMs: WEDNESDAY, timeZone: TZ },
    );
    expect(open.weeks.flatMap((w) => w.entries.map((e) => e.item.key))).toEqual(["due-fri"]);
    expect(open.openFromClass.map((e) => [e.item.key, e.when])).toEqual([
      ["open-sat", "Open until Saturday, Nov 14"],
      ["open-next-tue", "Open until Tuesday, Nov 17"],
    ]);
    // Drawn right after this week (Nov 9–13), before next week.
    expect(open.openFromClassAfter).toBe("2026-11-09");
  });

  test("browsing another month, Open from class follows its first week", () => {
    const december = buildHomeworkMonth(
      [{ key: "open-dec", dueAt: null, openUntil: at("2026-12-12T00:00:00") }],
      [],
      { monthKey: "2026-12", nowMs: WEDNESDAY, timeZone: TZ },
    );
    expect(december.weeks.some((w) => w.isThisWeek)).toBe(false);
    expect(december.openFromClassAfter).toBe(december.weeks[0].mondayKey);
    expect(december.openFromClass.map((e) => e.item.key)).toEqual(["open-dec"]);
  });

  test("a window that already closed is not shown; one closing today is", () => {
    const month = buildHomeworkMonth(
      [
        { key: "closed-monday", dueAt: null, openUntil: at("2026-11-10T00:00:00") },
        { key: "closing-today", dueAt: null, openUntil: at("2026-11-12T00:00:00") },
      ],
      [],
      { monthKey: "2026-11", nowMs: WEDNESDAY, timeZone: TZ },
    );
    expect(month.openFromClass.map((e) => e.item.key)).toEqual(["closing-today"]);
    expect(month.weeks.flatMap((w) => w.entries)).toEqual([]);
  });

  test("a week with only open-until work reads as having no homework", () => {
    const open = buildHomeworkMonth(
      [{ key: "open", dueAt: null, openUntil: at("2026-11-15T00:00:00") }],
      [],
      { monthKey: "2026-11", nowMs: WEDNESDAY, timeZone: TZ },
    );
    expect(open.weeks[1].entries).toEqual([]);
    expect(open.weeks[1].emptyText).toBe("No homework.");
    expect(open.openFromClass.map((e) => e.item.key)).toEqual(["open"]);
  });

  test("next week's last school day says next week; a holiday Friday moves it", () => {
    const next = buildHomeworkMonth(
      [item("fri-16", "2026-11-20T23:59:00"), item("wed-tg", "2026-11-25T23:59:00")],
      [thanksgiving],
      { monthKey: "2026-11", nowMs: at("2026-11-18T10:00:00"), timeZone: TZ },
    );
    // From Wednesday Nov 18: Friday Nov 20 is this week; Thanksgiving week's
    // Wednesday is its last school day, so it reads next week.
    expect(next.weeks[2].entries.map((e) => e.when)).toEqual(["Due this week"]);
    expect(next.weeks[3].entries.map((e) => e.when)).toEqual(["Due next week"]);
  });

  test("tomorrow says tomorrow", () => {
    const tuesday = at("2026-11-10T19:00:00");
    const tue = buildHomeworkMonth(
      [item("wed", "2026-11-11T12:00:00")],
      [],
      { monthKey: "2026-11", nowMs: tuesday, timeZone: TZ },
    );
    expect(tue.weeks[1].entries.map((e) => e.when)).toEqual(["Due tomorrow"]);
  });
});

describe("a month that opens on a weekend", () => {
  // Nov 1, 2026 is a Sunday: the week holding it (Oct 26–30) has no
  // November weekday, so it is shown only for work dated in November.
  const build = (items: Array<{ key: string; dueAt: number | null; openUntil?: number | null }>) =>
    buildHomeworkMonth(items, [], { monthKey: "2026-11", nowMs: WEDNESDAY, timeZone: TZ });

  test("work due Sunday Nov 1 appears, under the week that holds it", () => {
    const month = build([item("sunday-1st", "2026-11-01T23:59:00")]);
    expect(month.weeks[0].heading).toBe("Oct 26–30");
    expect(month.weeks[0].entries.map((e) => [e.item.key, e.when])).toEqual([
      ["sunday-1st", "Was due Sun, Nov 1"],
    ]);
    expect(month.weeks.map((w) => w.mondayKey)).toContain("2026-11-02");
  });

  test("open-until work closing on the 1st is in the month's Open from class", () => {
    // Seen on Thursday Oct 29, while both windows are still open.
    const month = buildHomeworkMonth(
      [
        { key: "open-to-1st", dueAt: null, openUntil: at("2026-11-02T00:00:00") },
        { key: "open-to-oct-30", dueAt: null, openUntil: at("2026-10-31T00:00:00") },
      ],
      [],
      { monthKey: "2026-11", nowMs: at("2026-10-29T12:00:00"), timeZone: TZ },
    );
    expect(month.weeks[0].mondayKey).toBe("2026-11-02");
    expect(month.openFromClass.map((e) => [e.item.key, e.when])).toEqual([
      ["open-to-1st", "Open until Sunday, Nov 1"],
    ]);
  });

  test("with nothing dated in the month, that week stays out", () => {
    const month = build([item("october-friday", "2026-10-30T23:59:00")]);
    expect(month.weeks[0].mondayKey).toBe("2026-11-02");
    expect(month.weeks.flatMap((w) => w.entries)).toEqual([]);
  });
});

describe("month keys", () => {
  test("open on this week's month, and a weekend means the coming week", () => {
    expect(homeworkMonthKeyFor(WEDNESDAY, TZ)).toBe("2026-11");
    expect(homeworkMonthKeyFor(at("2027-02-28T10:00:00"), TZ)).toBe("2027-03");
  });

  test("shift across years, and read from the Monday of the week holding the 1st", () => {
    expect(shiftMonthKey("2026-11", 2)).toBe("2027-01");
    expect(shiftMonthKey("2027-01", -1)).toBe("2026-12");
    // Nov 1, 2026 is a Sunday and Aug 1 a Saturday: the read starts the
    // Monday before, so work due that weekend is in the data.
    expect(homeworkMonthFirstDay("2026-11")).toBe("2026-10-26");
    expect(homeworkMonthFirstDay("2026-08")).toBe("2026-07-27");
    expect(homeworkMonthFirstDay("2026-12")).toBe("2026-11-30");
  });

  test("the default server window still starts last week", () => {
    expect(homeworkPlanWindowStart(WEDNESDAY, TZ)).toBe("2026-11-02");
  });
});

// The parent aide reads these labels instead of doing date arithmetic
// (TRA-621: left to it, the model put Friday's work in "next week").
describe("homeworkPlanWeek", () => {
  const due = (local: string) => ({ dueAt: at(local) });
  // Monday, Nov 9 and Saturday, Nov 14 2026, 10am in Honolulu.
  const MONDAY = at("2026-11-09T10:00:00");
  const SATURDAY = at("2026-11-14T10:00:00");

  test("on a Monday: Friday is this week, and the weeks either side are labelled", () => {
    const week = (local: string) => homeworkPlanWeek(due(local), MONDAY, TZ);
    expect(week("2026-11-04T23:59:00")).toBe("last week");
    expect(week("2026-11-09T08:00:00")).toBe("this week");
    expect(week("2026-11-13T23:59:00")).toBe("this week");
    expect(week("2026-11-20T23:59:00")).toBe("next week");
    expect(week("2026-11-27T23:59:00")).toBe("later");
  });

  test("on a Saturday, this week is the coming one and this weekend leads", () => {
    const week = (local: string) => homeworkPlanWeek(due(local), SATURDAY, TZ);
    expect(week("2026-11-13T23:59:00")).toBe("last week");
    expect(week("2026-11-15T20:00:00")).toBe("this weekend");
    expect(week("2026-11-16T23:59:00")).toBe("this week");
    expect(week("2026-11-20T23:59:00")).toBe("this week");
    expect(week("2026-11-27T23:59:00")).toBe("next week");
  });

  test("open-until work is placed by the day its window closes", () => {
    const openUntil = (local: string) =>
      homeworkPlanWeek({ dueAt: null, openUntil: at(local) }, MONDAY, TZ);
    // Closes at midnight starting Monday Nov 16: open until Sunday, this week.
    expect(openUntil("2026-11-16T00:00:00")).toBe("this week");
    expect(openUntil("2026-11-21T00:00:00")).toBe("next week");
  });

  test("undated work has no week", () => {
    expect(homeworkPlanWeek({ dueAt: null }, MONDAY, TZ)).toBeNull();
    expect(homeworkPlanWeek({ dueAt: null, openUntil: null }, SATURDAY, TZ)).toBeNull();
  });
});
