import { describe, expect, test } from "vitest";
import { academicCalendarIcs } from "./academicCalendarIcs";

describe("academicCalendarIcs", () => {
  test("serializes all-day events with exclusive end dates and escaped text", () => {
    expect(
      academicCalendarIcs(
        { name: "Moli School calendar", timeZone: "Pacific/Honolulu" },
        [
          {
            uid: "school-closure-1@calendar.rabbithole",
            startDayKey: "2026-12-21",
            endDayKey: "2027-01-01",
            summary: "Winter Break, school closed",
            description: "No classes\nEnjoy the break.",
            location: "Moli; campus",
            category: "School closure",
            updatedAt: Date.UTC(2026, 7, 1, 12, 34, 56),
          },
        ],
      ),
    ).toBe(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Rabbithole//School calendar//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "X-WR-CALNAME:Moli School calendar",
        "X-WR-TIMEZONE:Pacific/Honolulu",
        "BEGIN:VEVENT",
        "UID:school-closure-1@calendar.rabbithole",
        "DTSTAMP:20260801T123456Z",
        "LAST-MODIFIED:20260801T123456Z",
        "DTSTART;VALUE=DATE:20261221",
        // Exclusive end: an all-day range through Jan 1 ends on Jan 2.
        "DTEND;VALUE=DATE:20270102",
        "SUMMARY:Winter Break\\, school closed",
        "DESCRIPTION:No classes\\nEnjoy the break.",
        "LOCATION:Moli\\; campus",
        "CATEGORIES:School closure",
        "STATUS:CONFIRMED",
        "TRANSP:TRANSPARENT",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n"),
    );
  });

  test("carries the school's own time zone, not a hardcoded one", () => {
    const ics = academicCalendarIcs(
      { name: "Kula Guest School calendar", timeZone: "America/Denver" },
      [],
    );

    expect(ics).toContain("X-WR-TIMEZONE:America/Denver");
    expect(ics).not.toContain("Pacific/Honolulu");
  });

  test("a school with no closures still yields a well-formed calendar", () => {
    const ics = academicCalendarIcs(
      { name: "Hoku School calendar", timeZone: "Pacific/Honolulu" },
      [],
    );

    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).not.toContain("BEGIN:VEVENT");
  });

  test("folds long content lines without splitting UTF-8 characters", () => {
    const ics = academicCalendarIcs(
      { name: "Moli School", timeZone: "Pacific/Honolulu" },
      [
        {
          uid: "school-closure-2@calendar.rabbithole",
          startDayKey: "2026-08-21",
          endDayKey: "2026-08-21",
          summary:
            "Kaʻahumanu ʻohana evening — a very long school-wide title families read before making plans",
          category: "School event",
          updatedAt: 0,
        },
      ],
    );

    const lines = ics.split("\r\n");
    expect(lines.some((line) => line.startsWith(" "))).toBe(true);
    // RFC 5545: no line may exceed 75 OCTETS (not characters), and a fold must
    // never land mid-character — a split multi-byte ʻokina would corrupt the
    // title in every calendar client.
    const encoder = new TextEncoder();
    for (const line of lines) {
      expect(encoder.encode(line).length).toBeLessThanOrEqual(75);
    }
    const unfolded = lines
      .filter((line) => line.length > 0)
      .reduce(
        (acc, line) =>
          line.startsWith(" ") ? acc + line.slice(1) : `${acc}\n${line}`,
        "",
      );
    expect(unfolded).toContain(
      "SUMMARY:Kaʻahumanu ʻohana evening — a very long school-wide title families read before making plans",
    );
  });
});
