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
