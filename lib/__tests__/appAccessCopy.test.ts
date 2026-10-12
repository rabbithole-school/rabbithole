import { describe, expect, test } from "vitest";

import { closesPhrase, scheduleWindowsPhrase, throughDayPhrase } from "../appAccessCopy";

const blockE = {
  subject: "Robotics",
  block: "Block E",
  weekdays: [1, 3],
  opensLocal: "14:50",
  closesLocal: "16:40",
};

describe("the device console's words for when an app opens (TRA-444)", () => {
  test("a block names its class, its days and the app's window", () => {
    expect(scheduleWindowsPhrase([blockE])).toBe("Robotics Block E (Mon/Wed 14:50–16:40)");
  });

  test("several blocks read as one phrase", () => {
    const blockC = { ...blockE, subject: "Maker lab", block: "Block C", weekdays: [5] };
    expect(scheduleWindowsPhrase([blockE, blockC])).toBe(
      "Robotics Block E (Mon/Wed 14:50–16:40) and Maker lab Block C (Fri 14:50–16:40)",
    );
    expect(scheduleWindowsPhrase([blockE, blockC, blockE])).toBe(
      "Robotics Block E (Mon/Wed 14:50–16:40), Maker lab Block C (Fri 14:50–16:40) and Robotics Block E (Mon/Wed 14:50–16:40)",
    );
  });

  test("the last day of opened access, relative to the school's today when it is known", () => {
    expect(throughDayPhrase("2026-09-28", "2026-09-28")).toBe("today");
    expect(throughDayPhrase("2026-09-29", "2026-09-28")).toBe("tomorrow");
    expect(throughDayPhrase("2026-10-02", "2026-09-28")).toBe("Fri, Oct 2");
    // Another year says so, so a mistyped year shows on the button.
    expect(throughDayPhrase("2027-01-04", "2026-12-28")).toBe("Mon, Jan 4, 2027");
    expect(throughDayPhrase("2099-12-31", "2026-09-28")).toBe("Thu, Dec 31, 2099");
    // Without today, the full date. Read as a calendar date, never shifted by
    // the viewer's time zone.
    expect(throughDayPhrase("2026-09-28")).toBe("Mon, Sep 28, 2026");
  });

  test("when it closes: tonight, or at the end of a later day", () => {
    expect(closesPhrase("2026-09-28", "2026-09-28")).toBe("It closes at midnight on its own.");
    expect(closesPhrase("2026-09-29", "2026-09-28")).toBe("It closes on its own at the end of tomorrow.");
    expect(closesPhrase("2026-10-02", "2026-09-28")).toBe("It closes on its own at the end of Fri, Oct 2.");
  });
});
