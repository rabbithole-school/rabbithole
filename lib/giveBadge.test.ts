import { describe, expect, it } from "vitest";
import { giveBadge, IN_CLASS_LABEL, NO_END_LABEL } from "./giveBadge";

// Honolulu has no daylight saving, so local times are fixed offsets (UTC-10).
const TZ = "Pacific/Honolulu";
const local = (iso: string) => Date.parse(`${iso}-10:00`);

// Tuesday, Nov 17 2026, 10:00 local.
const NOW = local("2026-11-17T10:00:00");

describe("giveBadge", () => {
  it("says In class for a give that ends in the class it shows up in", () => {
    const badge = giveBadge(
      {
        mode: "classFocus",
        setAt: local("2026-11-17T09:30:00"),
        endsAt: local("2026-11-17T10:45:00"),
      },
      { nowMs: NOW, timeZone: TZ },
    );
    expect(badge).toEqual({ kind: "inClass", text: IN_CLASS_LABEL });
    expect(badge.text).toBe("In class");
  });

  it("says In class for a planned in-class give, which gets its end when it starts", () => {
    expect(
      giveBadge(
        { mode: "classFocus", setAt: null, startsAt: local("2026-11-18T09:00:00"), endsAt: null },
        { nowMs: NOW, timeZone: TZ },
      ).text,
    ).toBe("In class");
  });

  it("says Due with the day for a give due by a date (or the end of the unit)", () => {
    expect(
      giveBadge(
        { mode: "homework", setAt: NOW, dueAt: local("2026-11-19T23:59:00") },
        { nowMs: NOW, timeZone: TZ },
      ),
    ).toEqual({ kind: "due", text: "Due Thu, Nov 19", late: false });
    expect(
      giveBadge(
        { mode: "homework", setAt: NOW, dueAt: local("2026-11-18T23:59:00") },
        { nowMs: NOW, timeZone: TZ },
      ).text,
    ).toBe("Due tomorrow");
  });

  it("keeps the late wording once the due day has passed", () => {
    expect(
      giveBadge(
        { mode: "homework", setAt: NOW, dueAt: local("2026-11-16T23:59:00") },
        { nowMs: NOW, timeZone: TZ },
      ),
    ).toEqual({ kind: "due", text: "Was due Mon, Nov 16", late: true });
  });

  it("says Open until with the day, and Closed once that day is over", () => {
    const entry = {
      mode: "classFocus" as const,
      setAt: local("2026-11-17T09:00:00"),
      endsAt: local("2026-11-21T00:00:00"), // end of Fri, Nov 20
    };
    expect(giveBadge(entry, { nowMs: NOW, timeZone: TZ })).toEqual({
      kind: "openUntil",
      text: "Open until Fri",
      closed: false,
    });
    expect(
      giveBadge(entry, { nowMs: local("2026-11-21T08:00:00"), timeZone: TZ }),
    ).toEqual({ kind: "openUntil", text: "Closed Fri", closed: true });
  });

  it("adds the date when the closing day is a week or more away", () => {
    const entry = {
      mode: "classFocus" as const,
      setAt: NOW,
      endsAt: local("2026-11-25T00:00:00"), // end of Tue, Nov 24
    };
    expect(giveBadge(entry, { nowMs: NOW, timeZone: TZ })).toMatchObject({
      text: "Open until Tue, Nov 24",
    });
  });

  it("never calls a planned open-until give closed, even past its day", () => {
    expect(
      giveBadge(
        {
          mode: "classFocus",
          setAt: null,
          startsAt: local("2026-11-17T09:00:00"),
          endsAt: local("2026-11-21T00:00:00"),
        },
        { nowMs: local("2026-11-21T08:00:00"), timeZone: TZ },
      ),
    ).toEqual({ kind: "openUntil", text: "Open until Fri", closed: false });
  });

  it("says No end date for a give that stays until the teacher clears it", () => {
    expect(
      giveBadge({ mode: "classFocus", setAt: NOW, endsAt: null }, { nowMs: NOW, timeZone: TZ }),
    ).toEqual({ kind: "noEnd", text: NO_END_LABEL });
    expect(
      giveBadge({ mode: "homework", setAt: NOW, dueAt: null }, { nowMs: NOW, timeZone: TZ }).text,
    ).toBe("No end date");
  });
});
