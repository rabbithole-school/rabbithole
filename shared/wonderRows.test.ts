import { describe, expect, test } from "vitest";
import {
  RECENT_WONDERS_SHOWN,
  WONDER_MARK,
  earlierWonders,
  formatWonderTime,
  starterListRow,
  starterMetaLine,
  wonderListRow,
  wonderMetaLine,
  wonderPlaceLine,
} from "./wonderRows";

const TZ = "Pacific/Honolulu";
// Friday, November 13, 2026, 10:12 in Honolulu (UTC-10).
const ASKED = Date.UTC(2026, 10, 13, 20, 12);
const SAME_DAY_LATER = Date.UTC(2026, 10, 14, 2, 30); // 4:30 PM the same day
const DAY = 86_400_000;

describe("wonderPlaceLine", () => {
  test("names each box", () => {
    expect(wonderPlaceLine({ surface: "quests" })).toBe("Asked on Quests");
    expect(wonderPlaceLine({ surface: "prep" })).toBe("Asked on Scholar’s Prep");
  });

  test("a build wonder names its unit, and says less when the title is gone", () => {
    expect(wonderPlaceLine({ surface: "build", unitTitle: "Angle croc" })).toBe(
      "Asked while building Angle croc",
    );
    expect(wonderPlaceLine({ surface: "build", unitTitle: null })).toBe(
      "Asked while building",
    );
    expect(wonderPlaceLine({ surface: "build", unitTitle: "  " })).toBe(
      "Asked while building",
    );
  });

  test("no place, or a place this build doesn't know, says nothing", () => {
    expect(wonderPlaceLine(null)).toBeNull();
    expect(wonderPlaceLine({ surface: "lab" })).toBeNull();
  });
});

describe("formatWonderTime", () => {
  test("today is the clock time in the school's zone, with no AM/PM", () => {
    expect(formatWonderTime(ASKED, SAME_DAY_LATER, TZ)).toBe("10:12");
    expect(formatWonderTime(Date.UTC(2026, 10, 13, 23, 40), SAME_DAY_LATER, TZ)).toBe(
      "1:40",
    );
  });

  test("the day is the school's calendar day, not UTC's", () => {
    // 11:30 PM Friday in Honolulu is already Saturday in UTC.
    const lateFriday = Date.UTC(2026, 10, 14, 9, 30);
    expect(formatWonderTime(lateFriday, lateFriday + 60_000, TZ)).toBe(
      "11:30",
    );
  });

  test("yesterday, then weekdays inside the week, then a date", () => {
    expect(formatWonderTime(ASKED, ASKED + DAY, TZ)).toBe("Yesterday");
    expect(formatWonderTime(ASKED, ASKED + 2 * DAY, TZ)).toBe("Friday");
    expect(formatWonderTime(ASKED, ASKED + 6 * DAY, TZ)).toBe("Friday");
    expect(formatWonderTime(ASKED, ASKED + 7 * DAY, TZ)).toBe("Nov 13");
  });

  test("a date in another year carries the year", () => {
    expect(formatWonderTime(ASKED, ASKED + 60 * DAY, TZ)).toBe("Nov 13, 2026");
  });
});

describe("wonderMetaLine", () => {
  test("where, then when", () => {
    expect(
      wonderMetaLine({ askedOn: { surface: "quests" }, askedAt: ASKED }, SAME_DAY_LATER, TZ),
    ).toBe("Asked on Quests · 10:12");
  });

  test("with no place, only when", () => {
    expect(wonderMetaLine({ askedOn: null, askedAt: ASKED }, SAME_DAY_LATER, TZ)).toBe(
      "10:12",
    );
  });
});

describe("starterMetaLine", () => {
  test("a Story names its practice skill", () => {
    expect(starterMetaLine("story", { skillName: "prime numbers" })).toBe(
      "From your prime numbers practice",
    );
    expect(starterMetaLine("story", null)).toBe("From your practice");
  });

  test("a teacher's pick names the teacher", () => {
    expect(starterMetaLine("teacher", { teacherName: "Ms. Rivera" })).toBe(
      "Picked by Ms. Rivera",
    );
    expect(starterMetaLine("teacher", null)).toBe("Picked by your teacher");
  });

  test("the other sources", () => {
    expect(starterMetaLine("idea", null)).toBe("An idea from Rabbithole");
    expect(starterMetaLine("parked", null)).toBe("Saved while building");
    expect(starterMetaLine("followUp", null)).toBe("From one of your Quests");
  });

  test("a saved question and a follow-up name what the kid was building (TRA-682)", () => {
    expect(starterMetaLine("parked", { questTitle: "Angle croc" })).toBe(
      "Saved while building Angle croc",
    );
    expect(starterMetaLine("followUp", { questTitle: "Angle croc" })).toBe(
      "From your Angle croc Quest",
    );
  });

  test("a mismatched detail falls back to the plain wording", () => {
    expect(starterMetaLine("story", { teacherName: "Ms. Rivera" })).toBe(
      "From your practice",
    );
  });

  test("an unknown source says nothing", () => {
    expect(starterMetaLine("classmate", null)).toBeNull();
  });
});

describe("rows", () => {
  test("a wonder: the question, the reply, the meta line, and Open", () => {
    expect(
      wonderListRow(
        {
          seedId: "s1",
          question: "Do fish get thirsty?",
          sessionId: "c1",
          askedAt: ASKED,
          askedOn: { surface: "prep" },
          replyExcerpt: "Saltwater fish drink all the time.",
        },
        SAME_DAY_LATER,
        TZ,
      ),
    ).toEqual({
      key: "wonder:s1",
      mark: WONDER_MARK,
      title: "Do fish get thirsty?",
      content: "Saltwater fish drink all the time.",
      meta: "Asked on Scholar’s Prep · 10:12",
      replyLink: null,
      verb: { label: "Open", weight: "outline" },
    });
  });

  test("a wonder a teacher replied to ends with who replied, linking the thread", () => {
    const base = {
      seedId: "s1",
      question: "Do fish get thirsty?",
      sessionId: "c1",
      askedAt: ASKED,
      askedOn: null,
      replyExcerpt: null,
    };
    expect(
      wonderListRow(
        { ...base, reply: { teacherName: "Ms. Rivera", threadId: "t1" } },
        SAME_DAY_LATER,
        TZ,
      ).replyLink,
    ).toEqual({ label: "Ms. Rivera replied", threadId: "t1" });
    expect(
      wonderListRow(
        { ...base, reply: { teacherName: null, threadId: "t1" } },
        SAME_DAY_LATER,
        TZ,
      ).replyLink,
    ).toEqual({ label: "A teacher replied", threadId: "t1" });
    expect(wonderListRow({ ...base, reply: null }, SAME_DAY_LATER, TZ).replyLink).toBeNull();
  });

  test("a wonder still waiting for its reply has no content line", () => {
    const row = wonderListRow(
      {
        seedId: "s1",
        question: "Do fish get thirsty?",
        sessionId: "c1",
        askedAt: ASKED,
        askedOn: null,
        replyExcerpt: null,
      },
      SAME_DAY_LATER,
      TZ,
    );
    expect(row.content).toBeNull();
  });

  test("a starter: its emoji, its line, where it came from, and Ask", () => {
    expect(
      starterListRow({
        seedId: "s2",
        emoji: "🦗",
        line: "Why do cicadas wait 13 or 17 years to come out?",
        source: "story",
        detail: { skillName: "prime numbers" },
      }),
    ).toEqual({
      key: "starter:s2",
      mark: "🦗",
      title: "Why do cicadas wait 13 or 17 years to come out?",
      content: null,
      meta: "From your prime numbers practice",
      replyLink: null,
      verb: { label: "Ask", weight: "outline" },
    });
  });
});

describe("earlierWonders", () => {
  test("leaves out today's wonders, by the school's day, and keeps a few", () => {
    const wonders = [
      { id: "today", askedAt: ASKED },
      ...Array.from({ length: RECENT_WONDERS_SHOWN + 2 }, (_, i) => ({
        id: `older-${i}`,
        askedAt: ASKED - (i + 1) * DAY,
      })),
    ];
    expect(earlierWonders(wonders, SAME_DAY_LATER, TZ).map((w) => w.id)).toEqual(
      Array.from({ length: RECENT_WONDERS_SHOWN }, (_, i) => `older-${i}`),
    );
    // The next day, yesterday's wonder joins Earlier.
    expect(earlierWonders(wonders, ASKED + DAY, TZ)[0].id).toBe("today");
  });
});
