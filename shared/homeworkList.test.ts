import { describe, expect, test } from "vitest";
import {
  buildHomeworkWeek,
  buildYourList,
  homeworkListRowMeta,
  homeworkRowCta,
  opensOfflinePage,
  showsHomeworkDueChip,
  type HomeworkWeek,
} from "./homeworkList";
import { dueStatus } from "./institutionDay";

const timeZone = "Pacific/Honolulu";
// Wednesday, Nov 11 2026, 7pm in Honolulu. This week is Nov 9–13.
const wedEvening = Date.parse("2026-11-12T05:00:00.000Z");
const localNoon = (dayKey: string) => Date.parse(`${dayKey}T22:00:00.000Z`);

type Item = {
  id: string;
  dueAt: number | null;
  openUntil?: number | null;
  completedByMe?: boolean;
  isReopenedComplete?: boolean;
};

const work: Item[] = [
  { id: "undated", dueAt: null },
  { id: "late-old", dueAt: localNoon("2026-10-16") },
  { id: "late-monday", dueAt: localNoon("2026-11-09") },
  { id: "today", dueAt: localNoon("2026-11-11") },
  { id: "friday", dueAt: localNoon("2026-11-13") },
  { id: "thursday", dueAt: localNoon("2026-11-12") },
  { id: "next-thursday", dueAt: localNoon("2026-11-19") },
  { id: "far", dueAt: localNoon("2026-12-18") },
  { id: "done", dueAt: localNoon("2026-11-12"), completedByMe: true },
  { id: "done-undated", dueAt: null, completedByMe: true },
];

const ids = (items: Item[]) => items.map((item) => item.id);
const allIds = (week: HomeworkWeek<Item>) =>
  week.sections.flatMap((section) => ids(section.items));
const section = (week: HomeworkWeek<Item>, kind: string) =>
  week.sections.find((s) => s.kind === kind);
const build = (items: Item[], nowMs = wedEvening) =>
  buildHomeworkWeek(items, { nowMs, timeZone });

describe("buildHomeworkWeek", () => {
  const week = build(work);

  test("every live, unfinished item appears exactly once", () => {
    const live = work.filter((item) => !item.completedByMe).map((i) => i.id);
    expect(allIds(week).sort()).toEqual([...live].sort());
    expect(new Set(allIds(week)).size).toBe(allIds(week).length);
  });

  test("one surface in reading order: This week, Late, Next week, Later, No date", () => {
    expect(
      week.sections.map((s) => [s.heading, s.range, s.actionable, ids(s.items)]),
    ).toEqual([
      ["This week", "Nov 9–13", true, ["today", "thursday", "friday"]],
      ["Late", null, true, ["late-old", "late-monday"]],
      ["Next week", "Nov 16–20", false, ["next-thursday"]],
      ["Later", null, false, ["far"]],
      ["No date", null, true, ["undated"]],
    ]);
  });

  test("a quiet week is one subheading and one row", () => {
    const quiet = build([{ id: "only", dueAt: localNoon("2026-11-13") }]);
    expect(quiet.sections.map((s) => [s.heading, ids(s.items)])).toEqual([
      ["This week", ["only"]],
    ]);
  });

  test("an empty or all-finished list has no sections", () => {
    for (const items of [[], [{ id: "x", dueAt: null, completedByMe: true }]]) {
      const empty = build(items);
      expect(empty.isEmpty).toBe(true);
      expect(empty.sections).toEqual([]);
    }
  });

  test("on a weekend, This week is the coming week", () => {
    const saturday = Date.parse("2026-11-14T20:00:00.000Z");
    const weekend = build(work, saturday);
    expect(section(weekend, "thisWeek")?.range).toBe("Nov 16–20");
    expect(ids(section(weekend, "thisWeek")!.items)).toEqual(["next-thursday"]);
    expect(ids(section(weekend, "late")!.items)).toEqual([
      "late-old",
      "late-monday",
      "today",
      "thursday",
      "friday",
    ]);
  });

  // Saturday Nov 14 and Sunday Nov 15, 10am in Honolulu: "This week" is
  // Nov 16–20, so this weekend's due days lead the section on their own.
  const saturday = Date.parse("2026-11-14T20:00:00.000Z");
  const sunday = Date.parse("2026-11-15T20:00:00.000Z");
  const weekendWork: Item[] = [
    { id: "due-sat", dueAt: localNoon("2026-11-14") },
    { id: "due-sun", dueAt: localNoon("2026-11-15") },
    { id: "due-mon", dueAt: localNoon("2026-11-16") },
    { id: "due-fri", dueAt: localNoon("2026-11-13") },
  ];

  test("on Saturday, this weekend's work leads as This weekend, never under Nov 16–20", () => {
    const week = build(weekendWork, saturday);
    expect(week.sections.map((s) => [s.heading, s.range, ids(s.items)])).toEqual([
      ["This weekend", null, ["due-sat", "due-sun"]],
      ["This week", "Nov 16–20", ["due-mon"]],
      ["Late", null, ["due-fri"]],
    ]);
    expect(dueStatus(localNoon("2026-11-14"), saturday, timeZone)?.phrase).toBe(
      "due today",
    );
    expect(dueStatus(localNoon("2026-11-15"), saturday, timeZone)?.phrase).toBe(
      "due tomorrow",
    );
  });

  test("on Sunday, Saturday's work is Late and Sunday's leads as This weekend", () => {
    const week = build(weekendWork, sunday);
    expect(week.sections.map((s) => [s.heading, ids(s.items)])).toEqual([
      ["This weekend", ["due-sun"]],
      ["This week", ["due-mon"]],
      ["Late", ["due-fri", "due-sat"]],
    ]);
  });

  test("a weekday never has a This weekend section", () => {
    expect(section(build(weekendWork, wedEvening), "weekend")).toBeUndefined();
  });
});

describe("homeworkRowCta", () => {
  const now = wedEvening;
  const forecast = { isOffline: false, forecast: true, nowMs: now };
  const live = { isOffline: false, forecast: false, nowMs: now };

  test("started homework due next week keeps its way back in: Continue", () => {
    expect(homeworkRowCta({ notStarted: false }, forecast)).toBe("Continue");
  });

  test("open-until work available now stays openable in a forecast section", () => {
    const openUntil = now + 4 * 86_400_000;
    expect(homeworkRowCta({ notStarted: true, openUntil }, forecast)).toBe("Start");
    // A window that has already closed opens nothing.
    expect(homeworkRowCta({ notStarted: true, openUntil: now - 1 }, forecast)).toBeNull();
  });

  test("a row with a session is started even when nothing was sent yet", () => {
    // scholarPlate reports an opened-but-empty session as notStarted: true
    // with a real sessionId; it must not lose its way back in.
    const opened = { notStarted: true, sessionId: "session-1" };
    expect(homeworkRowCta(opened, forecast)).toBe("Continue");
    expect(homeworkRowCta(opened, live)).toBe("Continue");
  });

  test("not-yet-started work in a forecast section has no CTA", () => {
    expect(homeworkRowCta({ notStarted: true }, forecast)).toBeNull();
  });

  test("this week's rows: Start, Continue, or Open for offline work", () => {
    expect(homeworkRowCta({ notStarted: true }, live)).toBe("Start");
    expect(homeworkRowCta({ notStarted: false }, live)).toBe("Continue");
    expect(homeworkRowCta({ notStarted: true }, { ...live, isOffline: true })).toBe("Open");
    expect(homeworkRowCta({ notStarted: false }, { ...forecast, isOffline: true })).toBe("Open");
  });
});

describe("opensOfflinePage (TRA-739)", () => {
  const openUntil = wedEvening + 3 * 86_400_000;

  test("offline homework and offline open-until work open their page", () => {
    const homework = { activityKind: "offline", origin: "homework", openUntil: null };
    const openFromClass = { activityKind: "offline", origin: "classFocus", openUntil };
    expect(opensOfflinePage(homework)).toBe(true);
    expect(opensOfflinePage(openFromClass)).toBe(true);
    // Its row in Open from class: "Open", the open-until pill, no due chip,
    // and "away from the BunnyPad".
    expect(
      homeworkRowCta(
        { ...openFromClass, notStarted: true, sessionId: null },
        { isOffline: opensOfflinePage(openFromClass), forecast: false, nowMs: wedEvening },
      ),
    ).toBe("Open");
    expect(showsHomeworkDueChip({ ...openFromClass, dueAt: null }, wedEvening, timeZone)).toBe(
      false,
    );
    expect(
      homeworkListRowMeta({ subject: "Science", teacherName: "Ms. Rivera", isOffline: true }),
    ).toBe("Science · with Ms. Rivera · away from the BunnyPad");
  });

  test("offline in-class work and online open-until work do not", () => {
    expect(
      opensOfflinePage({ activityKind: "offline", origin: "classFocus", openUntil: null }),
    ).toBe(false);
    expect(opensOfflinePage({ activityKind: "online", origin: "classFocus", openUntil })).toBe(
      false,
    );
    expect(opensOfflinePage({ activityKind: "online", origin: "homework" })).toBe(false);
  });
});

describe("the row's attribution", () => {
  test("reads 'Subject · with Teacher'", () => {
    expect(
      homeworkListRowMeta({ subject: "Science", teacherName: "Ms. Rivera", isOffline: false }),
    ).toBe("Science · with Ms. Rivera");
  });
});

describe("late vs future dates can't be confused", () => {
  test("a late Thursday and next Thursday never share a phrase", () => {
    const lateThursday = dueStatus(localNoon("2026-10-29"), wedEvening, timeZone);
    const nextThursday = dueStatus(localNoon("2026-11-19"), wedEvening, timeZone);
    expect(lateThursday?.status).toBe("overdue");
    expect(nextThursday?.status).toBe("upcoming");
    expect(lateThursday?.phrase).not.toBe(nextThursday?.phrase);
    expect(lateThursday?.phrase).toMatch(/Oct 29/);
    expect(nextThursday?.phrase).toMatch(/Nov 19/);
  });
});

describe("work the scholar already finished and chose to keep working on", () => {
  const reopened = {
    id: "reopened",
    dueAt: localNoon("2026-10-30"),
    isReopenedComplete: true,
  };

  test("is never Late: a past due date sits in This week", () => {
    const week = build([
      reopened,
      { id: "undated-reopened", dueAt: null, isReopenedComplete: true },
    ]);
    expect(week.sections.map((s) => [s.kind, ids(s.items)])).toEqual([
      ["thisWeek", ["reopened"]],
      ["undated", ["undated-reopened"]],
    ]);
  });

  test("shows no late chip once its date has passed", () => {
    expect(showsHomeworkDueChip(reopened, wedEvening, timeZone)).toBe(false);
    // Owed late work keeps its chip; a reopened item not yet due keeps it too.
    expect(
      showsHomeworkDueChip({ dueAt: localNoon("2026-10-30") }, wedEvening, timeZone),
    ).toBe(true);
    expect(
      showsHomeworkDueChip(
        { dueAt: localNoon("2026-11-13"), isReopenedComplete: true },
        wedEvening,
        timeZone,
      ),
    ).toBe(true);
    // Open-until and undated rows never carry a due chip.
    expect(showsHomeworkDueChip({ dueAt: null, openUntil: 1 }, wedEvening, timeZone)).toBe(false);
    expect(showsHomeworkDueChip({ dueAt: null }, wedEvening, timeZone)).toBe(false);
  });
});

describe("open-until work is Open from class, never Homework (TRA-724)", () => {
  // Saturday Nov 14's end, the way giveWindow stores "open until Sat".
  const satEnd = Date.parse("2026-11-15T10:00:00.000Z") - 1;
  const friEnd = Date.parse("2026-11-14T10:00:00.000Z") - 1;
  const nextWedEnd = Date.parse("2026-11-19T10:00:00.000Z") - 1;
  const rows: Item[] = [
    ...work,
    { id: "open-next-wed", dueAt: null, openUntil: nextWedEnd },
    { id: "open-sat", dueAt: null, openUntil: satEnd },
    { id: "open-fri", dueAt: null, openUntil: friEnd },
    { id: "open-done", dueAt: null, openUntil: satEnd, completedByMe: true },
  ];
  const open = (nowMs = wedEvening) =>
    buildYourList(rows, { nowMs, timeZone }).openFromClass;

  test("an open-until row never appears in the Homework rows", () => {
    expect(allIds(build(rows)).filter((id) => id.startsWith("open"))).toEqual([]);
    expect(build([{ id: "open-sat", dueAt: null, openUntil: satEnd }]).isEmpty).toBe(true);
  });

  test("a dated or undated homework row never appears in Open from class", () => {
    expect(allIds(open())).toEqual(["open-fri", "open-sat", "open-next-wed"]);
    expect(buildYourList(work, { nowMs: wedEvening, timeZone }).openFromClass.isEmpty).toBe(true);
  });

  test("Homework is unchanged by open-until rows beside it", () => {
    expect(build(rows).sections).toEqual(build(work).sections);
  });

  test("one list, soonest closing first, no subheading, every row actionable", () => {
    const { sections } = open();
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ heading: null, range: null, actionable: true });
  });

  test("finished work and closed windows leave it; with none it is empty", () => {
    expect(allIds(open())).not.toContain("open-done");
    const saturdayNight = Date.parse("2026-11-15T09:00:00.000Z");
    expect(allIds(open(saturdayNight))).toEqual(["open-sat", "open-next-wed"]);
    const thursdayAfter = Date.parse("2026-11-20T09:00:00.000Z");
    expect(open(thursdayAfter).isEmpty).toBe(true);
    expect(open(thursdayAfter).sections).toEqual([]);
  });

  test("open-until work alone is not a clear day: the list is not empty", () => {
    const only: Item[] = [{ id: "open-sat", dueAt: null, openUntil: satEnd }];
    const list = buildYourList(only, { nowMs: wedEvening, timeZone });
    expect(list.homework.isEmpty).toBe(true);
    expect(list.isEmpty).toBe(false);
    expect(buildYourList([], { nowMs: wedEvening, timeZone }).isEmpty).toBe(true);
    expect(buildYourList(work, { nowMs: wedEvening, timeZone }).isEmpty).toBe(false);
  });

  test("its rows keep their CTA, since every window is open now", () => {
    for (const row of open().sections[0].items) {
      expect(
        homeworkRowCta(
          { ...row, notStarted: true },
          { isOffline: false, forecast: false, nowMs: wedEvening },
        ),
      ).toBe("Start");
    }
  });
});
