import { describe, expect, test } from "vitest";
import { dayStartForDayKey, instantForLocalMinutes } from "./institutionDay";
import {
  isOpenUntil,
  isOpenUntilByDate,
  isOnOwnTime,
  openUntilClosesAt,
  openUntilClosedLine,
  openUntilDateLabel,
  openUntilPhrase,
  splitOpenFromClass,
} from "./openUntil";

const TZ = "Pacific/Honolulu";
const at = (dayKey: string, hh: number, mm = 0) =>
  instantForLocalMinutes(dayKey, hh * 60 + mm, TZ);
// The end of a school day the way giveWindow stores it (schoolDayEndAt).
const endOf = (dayKey: string) => {
  const next = new Date(`${dayKey}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return dayStartForDayKey(next.toISOString().slice(0, 10), TZ) - 1;
};

describe("isOpenUntil", () => {
  test("a class focus that ends on a later day is open-until", () => {
    expect(
      isOpenUntil(
        { mode: "classFocus", setAt: at("2026-11-09", 9), endsAt: endOf("2026-11-14") },
        TZ,
      ),
    ).toBe(true);
  });

  test("an in-class give ends the day it starts: its block, or the end of that day", () => {
    const setAt = at("2026-11-09", 9);
    expect(
      isOpenUntil({ mode: "classFocus", setAt, endsAt: at("2026-11-09", 9, 45) }, TZ),
    ).toBe(false);
    expect(
      isOpenUntil({ mode: "classFocus", setAt, endsAt: endOf("2026-11-09") }, TZ),
    ).toBe(false);
  });

  test("a block that ends at exactly midnight is still in that class", () => {
    const midnight = dayStartForDayKey("2026-11-10", TZ);
    expect(
      isOpenUntil(
        { mode: "classFocus", setAt: at("2026-11-09", 22), endsAt: midnight },
        TZ,
      ),
    ).toBe(false);
    // One millisecond later it belongs to the next day.
    expect(
      isOpenUntil(
        { mode: "classFocus", setAt: at("2026-11-09", 22), endsAt: midnight + 1 },
        TZ,
      ),
    ).toBe(true);
  });

  test("planned work reads its start time", () => {
    expect(
      isOpenUntil(
        { mode: "classFocus", startsAt: at("2026-11-12", 9), endsAt: endOf("2026-11-14") },
        TZ,
      ),
    ).toBe(true);
    expect(
      isOpenUntil(
        { mode: "classFocus", startsAt: at("2026-11-14", 9), endsAt: endOf("2026-11-14") },
        TZ,
      ),
    ).toBe(false);
  });

  test("homework and an endless focus never are", () => {
    expect(
      isOpenUntil(
        { mode: "homework", setAt: at("2026-11-09", 9), endsAt: endOf("2026-11-14") },
        TZ,
      ),
    ).toBe(false);
    expect(isOpenUntil({ mode: "classFocus", setAt: at("2026-11-09", 9) }, TZ)).toBe(
      false,
    );
  });
});

describe("open-until wording", () => {
  test("the row pill and the parent plan's date", () => {
    expect(openUntilPhrase(endOf("2026-11-14"), TZ, at("2026-11-12", 9))).toBe("Open until Sat");
    expect(openUntilDateLabel(endOf("2026-11-14"), TZ)).toBe("Open until Sat, Nov 14");
  });
});

describe("openUntilPhrase adds the date from seven days out", () => {
  // Today is Tue Nov 17, 9am Honolulu.
  const now = at("2026-11-17", 9);
  const phrase = (closeDay: string, nowMs = now) =>
    openUntilPhrase(endOf(closeDay), TZ, nowMs);

  test("closing today, in six days: weekday only", () => {
    expect(phrase("2026-11-17")).toBe("Open until Tue");
    expect(phrase("2026-11-23")).toBe("Open until Mon");
  });

  test("seven days out (next Tuesday) and fourteen: weekday and date", () => {
    expect(phrase("2026-11-24")).toBe("Open until Tue, Nov 24");
    expect(phrase("2026-12-01")).toBe("Open until Tue, Dec 1");
  });

  test("counts school days in the school's zone, not 168 hours", () => {
    // 11pm Tue Nov 17 Honolulu is already Wed Nov 18 in UTC. Seven school
    // days out is Nov 24 either way; Nov 23 stays short.
    const lateTue = at("2026-11-17", 23, 30);
    expect(phrase("2026-11-23", lateTue)).toBe("Open until Mon");
    expect(phrase("2026-11-24", lateTue)).toBe("Open until Tue, Nov 24");
    // Early Tuesday: less than 168 hours before the end of Nov 24, still 7 days.
    expect(phrase("2026-11-24", at("2026-11-17", 0, 5))).toBe("Open until Tue, Nov 24");
  });

  test("a closing time just before local midnight belongs to that day", () => {
    const justBefore = dayStartForDayKey("2026-11-25", TZ) - 1;
    expect(openUntilPhrase(justBefore, TZ, now)).toBe("Open until Tue, Nov 24");
    // Exactly local midnight also belongs to the day before.
    expect(openUntilPhrase(dayStartForDayKey("2026-11-24", TZ), TZ, now)).toBe(
      "Open until Mon",
    );
  });

  test("a date in another year carries the year", () => {
    expect(phrase("2027-01-05")).toBe("Open until Tue, Jan 5, 2027");
  });
});

describe("openUntilClosedLine", () => {
  const entry = {
    mode: "classFocus" as const,
    setAt: at("2026-11-09", 9),
    endsAt: endOf("2026-11-14"),
  };
  const args = {
    rosterIds: ["a", "b", "c", "d", "e", "f"],
    completedScholarIds: ["a", "b", "c", "d", "zz"],
    timeZone: TZ,
  };

  test("is null while the window is open", () => {
    expect(openUntilClosedLine(entry, { ...args, nowMs: at("2026-11-13", 9) })).toBeNull();
  });

  test("counts who finished once it closes", () => {
    expect(openUntilClosedLine(entry, { ...args, nowMs: at("2026-11-15", 9) })).toBe(
      "Closed Sat · 4 of 6 finished",
    );
  });

  test("counts over the scholars the give reached", () => {
    expect(
      openUntilClosedLine(
        { ...entry, scholarIds: ["a", "e"] },
        { ...args, nowMs: at("2026-11-15", 9) },
      ),
    ).toBe("Closed Sat · 1 of 2 finished");
  });

  test("an in-class give never gets one", () => {
    expect(
      openUntilClosedLine(
        { ...entry, endsAt: at("2026-11-09", 9, 45) },
        { ...args, nowMs: at("2026-11-15", 9) },
      ),
    ).toBeNull();
  });
});

describe("splitOpenFromClass", () => {
  test("open-until rows go to Open from class, soonest closing first; the rest keep their order", () => {
    const rows = [
      { id: "hw-b", dueAt: 5 },
      { id: "open-late", openUntil: 30 },
      { id: "hw-undated", openUntil: null },
      { id: "open-soon", openUntil: 10 },
      { id: "hw-a", dueAt: 1 },
    ];
    const { due, openFromClass } = splitOpenFromClass(rows);
    expect(due.map((r) => r.id)).toEqual(["hw-b", "hw-undated", "hw-a"]);
    expect(openFromClass.map((r) => r.id)).toEqual(["open-soon", "open-late"]);
  });
});

describe("isOpenUntil with the stored openUntil kind (TRA-726)", () => {
  const sameDay = { mode: "classFocus" as const, setAt: at("2026-11-14", 9), endsAt: endOf("2026-11-14") };
  const laterDay = { mode: "classFocus" as const, setAt: at("2026-11-09", 9), endsAt: endOf("2026-11-14") };

  test("a row stored as openUntil is open-until, even when it starts on its last day", () => {
    expect(isOpenUntil(sameDay, TZ)).toBe(false);
    expect(isOpenUntil({ ...sameDay, openUntilKind: true }, TZ)).toBe(true);
    expect(isOnOwnTime({ ...sameDay, openUntilKind: true }, TZ)).toBe(true);
    expect(openUntilClosesAt({ ...sameDay, openUntilKind: true }, TZ)).toBe(sameDay.endsAt);
  });

  test("without the kind the date guess decides, as before", () => {
    for (const kind of [undefined, null, false]) {
      expect(isOpenUntil({ ...laterDay, openUntilKind: kind }, TZ)).toBe(true);
      expect(isOpenUntil({ ...sameDay, openUntilKind: kind }, TZ)).toBe(false);
    }
  });

  test("the kind never makes homework or an end-less focus open-until", () => {
    expect(isOpenUntil({ mode: "homework", setAt: laterDay.setAt, endsAt: laterDay.endsAt, openUntilKind: true }, TZ)).toBe(false);
    expect(isOpenUntil({ mode: "classFocus", setAt: laterDay.setAt, openUntilKind: true }, TZ)).toBe(false);
  });

  test("isOpenUntilByDate ignores the kind", () => {
    expect(isOpenUntilByDate({ ...sameDay, openUntilKind: true } as typeof sameDay, TZ)).toBe(false);
    expect(isOpenUntilByDate(laterDay, TZ)).toBe(true);
  });
});
