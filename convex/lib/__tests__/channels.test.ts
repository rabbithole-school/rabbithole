import { describe, expect, test } from "vitest";
import {
  siteUrl,
  linkBaseFor,
  withBase,
  scholarPath,
  scholarSlug,
  sessionPath,
  unitPath,
  activityRehearsalPath,
  assignmentPath,
  formattingGuidance,
  schoolTimeLabel,
  wallClockUtcIdentity,
} from "../channels";

describe("channels — path builders (relative, mirror app/ routes)", () => {
  test("scholarPath → teacher scholars tab (by username)", () => {
    expect(scholarPath("kawena")).toBe("/teacher/scholars/kawena");
  });

  test("scholarPath → one of the scholar's sub-tabs, as the next path segment", () => {
    expect(scholarPath("kawena", "documents")).toBe(
      "/teacher/scholars/kawena/documents",
    );
  });

  test("scholarSlug: username wins, id is the fallback", () => {
    expect(scholarSlug("kawena", "u1")).toBe("kawena");
    expect(scholarSlug(null, "u1")).toBe("u1");
    expect(scholarSlug(undefined, "u1")).toBe("u1");
    // `??`, not `||`: a real (even if odd) username is always kept.
    expect(scholarSlug("", "u1")).toBe("");
  });

  test("sessionPath with and without remote scholar", () => {
    expect(sessionPath("p1")).toBe("/scholar/p1");
    expect(sessionPath("p1", "u1")).toBe("/scholar/p1?remote=u1");
  });

  test("unitPath: bare → curriculum summary, node-focused → edit pane", () => {
    expect(unitPath("un1")).toBe("/teacher/curriculum/un1");
    expect(unitPath("un1", { lessonId: "le1" })).toBe(
      "/teacher/curriculum/un1/edit?lesson=le1",
    );
    expect(unitPath("un1", { lessonId: "le1", activityId: "ac1" })).toBe(
      "/teacher/curriculum/un1/edit?lesson=le1&activity=ac1",
    );
  });

  test("activityRehearsalPath → manual activity Preflight", () => {
    expect(activityRehearsalPath("un1", "le1", "ac1")).toBe(
      "/teacher/curriculum/un1/preflight?lesson=le1&activity=ac1&surface=columns&rehearse=manual",
    );
  });

  test("assignmentPath → Schedule Run page", () => {
    expect(assignmentPath("a1")).toBe("/teacher/schedule/a1");
  });
});

describe("channels — link base", () => {
  test("withBase: empty base stays relative; absolute bases normalize trailing slashes", () => {
    expect(withBase("", "/teacher/curriculum/un1")).toBe("/teacher/curriculum/un1");
    expect(withBase("https://x.test", "/teacher/curriculum/un1")).toBe(
      "https://x.test/teacher/curriculum/un1",
    );
    expect(withBase("https://x.test/", "/calendar.ics?school=moli")).toBe(
      "https://x.test/calendar.ics?school=moli",
    );
    expect(withBase("https://x.test///", "/calendar.ics?school=moli")).toBe(
      "https://x.test/calendar.ics?school=moli",
    );
  });

  test("web is relative; slack is absolute (== siteUrl)", () => {
    expect(linkBaseFor("web")).toBe("");
    expect(linkBaseFor("slack")).toBe(siteUrl());
    expect(linkBaseFor("slack")).toBeTruthy();
  });

  test("a slack deep link is absolute", () => {
    const url = withBase(linkBaseFor("slack"), scholarPath("u1"));
    expect(url.startsWith(siteUrl())).toBe(true);
    expect(url.endsWith("/teacher/scholars/u1")).toBe(true);
  });
});

describe("channels — formattingGuidance is channel-conditional", () => {
  test("slack and web guidance are not the same string", () => {
    expect(formattingGuidance("slack")).not.toBe(formattingGuidance("web"));
  });

  test("slack forbids the markdown tables that web permits", () => {
    const slack = formattingGuidance("slack");
    const web = formattingGuidance("web");
    // The branch, not the exact copy: only the Slack channel carries the
    // "no tables" caveat (accept any negation phrasing)…
    const forbidsTables = /(?:cannot|can't|do(?:es)? not|never)[^.]*render[^.]*table/i;
    expect(slack).toMatch(forbidsTables);
    expect(web).not.toMatch(forbidsTables);
    // …while web affirmatively permits them.
    expect(web).toMatch(/tables? render/i);
  });
});

describe("channels — school-time labels (TRA-486)", () => {
  // The fixed -10h formatter every aide label used before labels took the
  // institution's zone. Kept here as an independent oracle: the primary
  // school's labels must not change by a single byte.
  const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function legacyHstLabel(ms: number, withYear = false): string {
    const d = new Date(ms - 10 * 60 * 60 * 1000);
    let h = d.getUTCHours();
    const ap = h < 12 ? "AM" : "PM";
    h = h % 12 || 12;
    const year = withYear ? `${d.getUTCFullYear()}, ` : "";
    return `${WD[d.getUTCDay()]}, ${MO[d.getUTCMonth()]} ${d.getUTCDate()}, ${year}${h}:${String(d.getUTCMinutes()).padStart(2, "0")} ${ap} HST`;
  }

  test("Pacific/Honolulu is byte-identical to the legacy fixed-HST label", () => {
    // Every ~2h across two years, offset so minutes, midnights and noons vary.
    for (
      let ms = Date.UTC(2026, 0, 1);
      ms < Date.UTC(2028, 0, 1);
      ms += 2 * 60 * 60 * 1000 + 7 * 60 * 1000
    ) {
      expect(schoolTimeLabel(ms, "Pacific/Honolulu")).toBe(legacyHstLabel(ms));
      expect(schoolTimeLabel(ms, "Pacific/Honolulu", { withYear: true })).toBe(
        legacyHstLabel(ms, true),
      );
    }
    expect(schoolTimeLabel(null, "Pacific/Honolulu")).toBeNull();
  });

  test("two schools in different zones each get their own local date", () => {
    // 05:30 UTC on Oct 13: Monday evening in Honolulu, Tuesday in New York.
    const ms = Date.UTC(2026, 9, 13, 5, 30);
    expect(schoolTimeLabel(ms, "Pacific/Honolulu")).toBe("Mon, Oct 12, 7:30 PM HST");
    expect(schoolTimeLabel(ms, "America/New_York")).toBe("Tue, Oct 13, 1:30 AM EDT");
  });

  test("the 9am wall-clock anchor follows the zone's offset", () => {
    const ms = Date.UTC(2026, 9, 13, 5, 30);
    expect(wallClockUtcIdentity(ms, "Pacific/Honolulu")).toBe(
      "9:00 AM HST on a date = that date at 19:00 UTC",
    );
    expect(wallClockUtcIdentity(ms, "America/New_York")).toBe(
      "9:00 AM EDT on a date = that date at 13:00 UTC",
    );
    expect(wallClockUtcIdentity(ms, "Pacific/Auckland")).toBe(
      "9:00 AM GMT+13 on a date = the day before at 20:00 UTC",
    );
  });
});
