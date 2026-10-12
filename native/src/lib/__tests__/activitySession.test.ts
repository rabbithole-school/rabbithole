import { describe, expect, it } from "vitest";

import { activityTapAction, findActivitySession } from "../activitySession";

describe("activityTapAction", () => {
  it("starts a chat activity from a unit-level session (no session activity)", () => {
    // TRA-462: the planning chat of a quest has no activityId, and its chat
    // activities used to be untappable.
    expect(
      activityTapAction({ kind: "online", activityId: "a1", sessionActivityId: null }),
    ).toBe("session");
  });

  it("starts a different chat activity from inside an activity session", () => {
    expect(
      activityTapAction({ kind: "online", activityId: "a2", sessionActivityId: "a1" }),
    ).toBe("session");
  });

  it("treats the session's own activity as current, not a new start", () => {
    expect(
      activityTapAction({ kind: "online", activityId: "a1", sessionActivityId: "a1" }),
    ).toBe("current");
  });

  it("explains offline and share-back work instead of opening a chat", () => {
    for (const kind of ["offline", "shareBack"]) {
      expect(
        activityTapAction({ kind, activityId: "a2", sessionActivityId: null }),
      ).toBe("in-class");
    }
  });

  it("starts the other chat-backed kinds the unit progress counts", () => {
    for (const kind of ["simulator", "vibecode"]) {
      expect(
        activityTapAction({ kind, activityId: "a2", sessionActivityId: null }),
      ).toBe("session");
    }
  });

  it("does nothing for a problem set, which needs a practice skill the map lacks", () => {
    expect(
      activityTapAction({ kind: "problem_set", activityId: "a2", sessionActivityId: null }),
    ).toBe("none");
  });
});

describe("findActivitySession", () => {
  const sessions = [
    { id: "s-other", activityId: "a9", assignmentId: undefined },
    { id: "s-assigned", activityId: "a1", assignmentId: "asg1" },
    { id: "s-own", activityId: "a1", assignmentId: undefined },
    { id: "s-unit", activityId: undefined, assignmentId: undefined },
  ];

  it("reopens the unassigned session for the activity when there is no assignment", () => {
    expect(findActivitySession(sessions, "a1", null)).toBe("s-own");
  });

  it("reopens only the session from the same assignment", () => {
    expect(findActivitySession(sessions, "a1", "asg1")).toBe("s-assigned");
    expect(findActivitySession(sessions, "a1", "asg2")).toBeNull();
  });

  it("returns null when the scholar has not started the activity or sessions are loading", () => {
    expect(findActivitySession(sessions, "a5", null)).toBeNull();
    expect(findActivitySession(undefined, "a1", null)).toBeNull();
  });
});
