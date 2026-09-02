import { describe, expect, test } from "vitest";
import {
  TEACHER_CHAT_PATH,
  isTeacherChatPath,
  teacherChatHref,
} from "../teacherChat";

// Chat is no longer a tab in the staff strip: the header Robot opens the docked
// chat, and the dock header's "All chats" link is the ONE door to the
// full-screen route. That link is the whole escape hatch now, so the three
// things it must get right — carrying the active thread, carrying the
// institution lens, and NOT handing a unit-design thread to a route that
// cannot continue it — are asserted here rather than trusted to a browser walk.

describe("teacherChatHref", () => {
  test("with no active thread it opens the thread library", () => {
    expect(teacherChatHref({ sessionId: null, scopeParam: "" })).toBe(
      TEACHER_CHAT_PATH,
    );
    expect(teacherChatHref({ sessionId: undefined, scopeParam: null })).toBe(
      TEACHER_CHAT_PATH,
    );
  });

  test("with an active ordinary dock thread it deep-links that thread", () => {
    expect(teacherChatHref({ sessionId: "chat123", scopeParam: "" })).toBe(
      "/teacher/chat/chat123",
    );
  });

  test("a unit-scoped dock never deep-links its thread — only the library", () => {
    // The full-screen route is the GENERIC chat surface: no unitContext, so a
    // send there would go through sendSessionMessage and lose the unit tools,
    // the unit prompt, and the unitId attribution. Unit-design chats stay with
    // their unit (listSessionsForUnit); "All chats" offers the library instead.
    expect(
      teacherChatHref({ sessionId: "chat123", scopeParam: "", unitScoped: true }),
    ).toBe(TEACHER_CHAT_PATH);
    // …and the institution lens still survives that hop.
    expect(
      teacherChatHref({
        sessionId: "chat123",
        scopeParam: "moli",
        unitScoped: true,
      }),
    ).toBe("/teacher/chat?inst=moli");
  });

  test("the active institution lens survives the hop", () => {
    expect(teacherChatHref({ sessionId: null, scopeParam: "moli" })).toBe(
      "/teacher/chat?inst=moli",
    );
    expect(teacherChatHref({ sessionId: "chat123", scopeParam: "moli" })).toBe(
      "/teacher/chat/chat123?inst=moli",
    );
    // "all" is a real lens on the teacher surfaces (unlike /school, which has
    // no all-institutions state), so it rides along untouched.
    expect(teacherChatHref({ sessionId: "chat123", scopeParam: "all" })).toBe(
      "/teacher/chat/chat123?inst=all",
    );
  });

  test("no lens means no stray query string", () => {
    expect(teacherChatHref({ sessionId: "chat123", scopeParam: undefined })).toBe(
      "/teacher/chat/chat123",
    );
  });
});

describe("isTeacherChatPath", () => {
  test("true on the full-screen chat route and its thread URLs", () => {
    expect(isTeacherChatPath("/teacher/chat")).toBe(true);
    expect(isTeacherChatPath("/teacher/chat/chat123")).toBe(true);
  });

  test("false elsewhere — including a path that merely shares the prefix", () => {
    // A prefix match would suppress the dock (and light the Robot) on a
    // sibling route that has nothing to do with chat.
    expect(isTeacherChatPath("/teacher/chatter")).toBe(false);
    expect(isTeacherChatPath("/teacher/scholars")).toBe(false);
    expect(isTeacherChatPath("/school/settings")).toBe(false);
    expect(isTeacherChatPath(null)).toBe(false);
  });
});
