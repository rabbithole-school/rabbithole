import { describe, expect, test } from "vitest";
import {
  siteUrl,
  linkBaseFor,
  withBase,
  scholarPath,
  scholarSlug,
  sessionPath,
  unitPath,
  assignmentPath,
  formattingGuidance,
} from "../channels";

describe("channels — path builders (relative, mirror app/ routes)", () => {
  test("scholarPath → teacher scholars tab (by username)", () => {
    expect(scholarPath("kawena")).toBe("/teacher/scholars/kawena");
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
  test("slack forbids tables and calls links absolute", () => {
    const g = formattingGuidance("slack");
    expect(g).toMatch(/CANNOT render markdown tables/);
    expect(g).toMatch(/absolute/);
    expect(g).toMatch(/Never paste a bare URL/i);
    expect(g).toMatch(/`taskLink`/);
  });

  test("web allows tables", () => {
    const g = formattingGuidance("web");
    expect(g).toMatch(/tables render in the app/);
    expect(g).not.toMatch(/CANNOT render markdown tables/);
  });

  test("both tell the model to link the first mention via the tool `url` field", () => {
    for (const ch of ["slack", "web"] as const) {
      const g = formattingGuidance(ch);
      expect(g).toMatch(/`url` field/);
      expect(g).toMatch(/\[Name\]\(url\)/);
      expect(g).toMatch(/EVERY .*URL/i);
    }
  });
});
