import { describe, expect, test } from "vitest";
import {
  closuresInWeekOf,
  firstSchoolDayOfWeek,
  homeworkDueStatus,
  homeworkWeekWindow,
  isWeekEndDueDay,
  lastSchoolDayOfWeek,
  nextSchoolWeekMonday,
  weekEndDueDayFor,
  thisSchoolWeekMonday,
  weekClosedNote,
  type WeekClosure,
} from "./homeworkWeek";

const TZ = "Pacific/Honolulu";
const at = (local: string) => Date.parse(`${local}-10:00`);
// Monday, Nov 9 2026, 3pm in Honolulu. The week is Nov 9–13.
const MONDAY = at("2026-11-09T15:00:00");
const endOf = (dayKey: string) => at(`${dayKey}T23:59:00`);

const veteransDay: WeekClosure = {
  startDayKey: "2026-11-11",
  endDayKey: "2026-11-11",
  label: "Veterans Day",
};
const holidayFriday: WeekClosure = {
  startDayKey: "2026-11-13",
  endDayKey: "2026-11-13",
  label: "Staff day",
};
const thanksgiving: WeekClosure = {
  startDayKey: "2026-11-26",
  endDayKey: "2026-11-27",
  label: "Thanksgiving Break",
};

describe("the week's last school day", () => {
  test("is Friday in an ordinary week", () => {
    expect(lastSchoolDayOfWeek("2026-11-09", [])).toBe("2026-11-13");
    expect(lastSchoolDayOfWeek("2026-11-09", [veteransDay])).toBe("2026-11-13");
  });

  test("moves to Thursday when Friday is a holiday", () => {
    expect(lastSchoolDayOfWeek("2026-11-09", [holidayFriday])).toBe("2026-11-12");
    expect(isWeekEndDueDay("2026-11-12", [holidayFriday])).toBe(true);
    expect(isWeekEndDueDay("2026-11-13", [holidayFriday])).toBe(false);
  });

  test("skips a multi-day break, and is null for a fully closed week", () => {
    expect(lastSchoolDayOfWeek("2026-11-23", [thanksgiving])).toBe("2026-11-25");
    const winter: WeekClosure = {
      startDayKey: "2026-12-21",
      endDayKey: "2027-01-01",
      label: "Winter Break",
    };
    expect(lastSchoolDayOfWeek("2026-12-21", [winter])).toBeNull();
  });
});

describe("homeworkDueStatus: the this-week display rule", () => {
  test("a due date on the week's last school day reads 'due this week'", () => {
    expect(homeworkDueStatus(endOf("2026-11-13"), MONDAY, TZ, [])?.phrase).toBe(
      "due this week",
    );
  });

  test("a holiday Friday makes Thursday read 'due this week'", () => {
    const closures = [holidayFriday];
    expect(
      homeworkDueStatus(endOf("2026-11-12"), MONDAY, TZ, closures)?.phrase,
    ).toBe("due this week");
    // An ordinary Thursday reads by its weekday name.
    expect(homeworkDueStatus(endOf("2026-11-12"), MONDAY, TZ, [])?.phrase).toBe(
      "due Thursday",
    );
  });

  test("the sharper words win: tomorrow the night before, today on the day", () => {
    // Thursday night before an ordinary Friday deadline.
    const thursdayNight = at("2026-11-12T20:00:00");
    expect(homeworkDueStatus(endOf("2026-11-13"), thursdayNight, TZ, [])).toEqual({
      status: "upcoming",
      phrase: "due tomorrow",
    });
    // Holiday Friday: Thursday is the deadline, so Wednesday night says
    // tomorrow and Thursday says today.
    const wednesdayNight = at("2026-11-11T20:00:00");
    expect(
      homeworkDueStatus(endOf("2026-11-12"), wednesdayNight, TZ, [holidayFriday])
        ?.phrase,
    ).toBe("due tomorrow");
    expect(
      homeworkDueStatus(endOf("2026-11-12"), thursdayNight, TZ, [holidayFriday]),
    ).toEqual({ status: "dueToday", phrase: "due today" });
    // Two days out it is still "this week".
    const tuesday = at("2026-11-10T20:00:00");
    expect(
      homeworkDueStatus(endOf("2026-11-12"), tuesday, TZ, [holidayFriday])?.phrase,
    ).toBe("due this week");
  });

  test("next week's last school day reads 'due next week'", () => {
    expect(homeworkDueStatus(endOf("2026-11-20"), MONDAY, TZ, [])?.phrase).toBe(
      "due next week",
    );
    // Thanksgiving week: Wednesday is the last school day.
    const wedOfThanksgivingWeek = at("2026-11-18T09:00:00");
    expect(
      homeworkDueStatus(endOf("2026-11-25"), wedOfThanksgivingWeek, TZ, [
        thanksgiving,
      ])?.phrase,
    ).toBe("due next week");
  });

  test("this week and next week read by weekday; later weeks, today and late keep theirs", () => {
    expect(homeworkDueStatus(endOf("2026-11-11"), MONDAY, TZ, [])?.phrase).toBe(
      "due Wednesday",
    );
    // Next week's Monday and Thursday: the Next week subheading carries the
    // week, the chip the day.
    expect(homeworkDueStatus(endOf("2026-11-16"), MONDAY, TZ, [])?.phrase).toBe(
      "due Monday",
    );
    expect(homeworkDueStatus(endOf("2026-11-19"), MONDAY, TZ, [])?.phrase).toBe(
      "due Thursday",
    );
    expect(homeworkDueStatus(endOf("2026-11-27"), MONDAY, TZ, [])?.phrase).toBe(
      "due Fri, Nov 27",
    );
    const friday = at("2026-11-13T08:00:00");
    expect(homeworkDueStatus(endOf("2026-11-13"), friday, TZ, [])).toEqual({
      status: "dueToday",
      phrase: "due today",
    });
    const saturday = at("2026-11-14T08:00:00");
    expect(homeworkDueStatus(endOf("2026-11-13"), saturday, TZ, [])).toEqual({
      status: "overdue",
      phrase: "was due Fri, Nov 13",
    });
  });

  test("on a weekend, the coming week is this week", () => {
    const sunday = at("2026-11-08T20:00:00");
    expect(thisSchoolWeekMonday(sunday, TZ)).toBe("2026-11-09");
    expect(homeworkDueStatus(endOf("2026-11-13"), sunday, TZ, [])?.phrase).toBe(
      "due this week",
    );
  });

  test("without the calendar, the last school day reads by its weekday", () => {
    // No closures known: never guess "this week", just name the day.
    expect(
      homeworkDueStatus(endOf("2026-11-13"), MONDAY, TZ, undefined)?.phrase,
    ).toBe("due Friday");
    // Beyond next week the full date stays.
    expect(
      homeworkDueStatus(endOf("2026-11-27"), MONDAY, TZ, undefined)?.phrase,
    ).toBe("due Fri, Nov 27");
  });
});

describe("the families' closure line", () => {
  test("names the day in full, with the reason", () => {
    expect(weekClosedNote("2026-11-09", [veteransDay])).toBe(
      "No school Wednesday (Veterans Day)",
    );
  });

  test("joins a run of closed days, and is null for an open week", () => {
    expect(weekClosedNote("2026-11-23", [thanksgiving])).toBe(
      "No school Thursday–Friday (Thanksgiving Break)",
    );
    expect(weekClosedNote("2026-11-16", [veteransDay, thanksgiving])).toBeNull();
  });
});

describe("closuresInWeekOf", () => {
  test("keeps only the closures inside a day's school week", () => {
    expect(
      closuresInWeekOf("2026-11-12", [veteransDay, holidayFriday, thanksgiving]),
    ).toEqual([veteransDay, holidayFriday]);
  });
});

describe("homework week windows (teacher planning)", () => {
  // 2026-11-09 is a Monday. Veterans Day: Wednesday 2026-11-11.
  const thanksgiving = {
    startDayKey: "2026-11-26",
    endDayKey: "2026-11-27",
    label: "Thanksgiving Break",
  };
  const wholeWeek = {
    startDayKey: "2026-12-21",
    endDayKey: "2027-01-01",
    label: "Winter Break",
  };

  test("runs Monday to Friday on an open week", () => {
    expect(homeworkWeekWindow("2026-11-16", [])).toEqual({
      mondayKey: "2026-11-16",
      showsUpDayKey: "2026-11-16",
      dueDayKey: "2026-11-20",
    });
  });

  test("moves the due day to Wednesday when Thursday and Friday are closed", () => {
    expect(homeworkWeekWindow("2026-11-23", [thanksgiving])?.dueDayKey).toBe(
      "2026-11-25",
    );
  });

  test("moves the show-up day past a closed Monday", () => {
    const monday = { startDayKey: "2027-01-18", endDayKey: "2027-01-18", label: "MLK Day" };
    expect(firstSchoolDayOfWeek("2027-01-18", [monday])).toBe("2027-01-19");
  });

  test("has no window when the school is closed all week", () => {
    expect(homeworkWeekWindow("2026-12-21", [wholeWeek])).toBeNull();
  });

  test("reads next week as the week after this school week, as scholars do", () => {
    const tz = "Pacific/Honolulu";
    const at = (iso: string) => new Date(iso).getTime();
    // Wednesday Nov 11 → Nov 16.
    expect(nextSchoolWeekMonday(at("2026-11-11T20:00:00Z"), tz)).toBe("2026-11-16");
    // Friday evening Nov 13 → Nov 16.
    expect(nextSchoolWeekMonday(at("2026-11-14T05:00:00Z"), tz)).toBe("2026-11-16");
    // Sunday Nov 15: this week is Nov 16, so next week is Nov 23.
    expect(nextSchoolWeekMonday(at("2026-11-15T20:00:00Z"), tz)).toBe("2026-11-23");
  });

  test("due this week is the week's last school day, rolling past a weekend", () => {
    const friday = { startDayKey: "2026-11-13", endDayKey: "2026-11-13", label: "Holiday" };
    expect(weekEndDueDayFor("2026-11-10", [])).toBe("2026-11-13");
    expect(weekEndDueDayFor("2026-11-10", [friday])).toBe("2026-11-12");
    // Showing up on Friday when Friday is closed: next week's Friday.
    expect(weekEndDueDayFor("2026-11-13", [friday])).toBe("2026-11-20");
    // Saturday: the coming week.
    expect(weekEndDueDayFor("2026-11-14", [])).toBe("2026-11-20");
  });
});
