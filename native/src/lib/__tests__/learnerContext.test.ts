import { describe, expect, it } from "vitest";

import { hasLearnerContext } from "../learnerContext";

describe("hasLearnerContext", () => {
  it("is undefined while either query is still loading", () => {
    expect(hasLearnerContext({ me: undefined, memberships: [] })).toBeUndefined();
    expect(
      hasLearnerContext({ me: { role: "scholar" }, memberships: undefined }),
    ).toBeUndefined();
  });

  it("treats a top-level scholar or lifelong learner as a learner", () => {
    expect(hasLearnerContext({ me: { role: "scholar" }, memberships: [] })).toBe(
      true,
    );
    expect(
      hasLearnerContext({ me: { role: "lifelong_learner" }, memberships: [] }),
    ).toBe(true);
  });

  it("treats a learner membership as a learner regardless of top-level role", () => {
    expect(
      hasLearnerContext({
        me: { role: "staff" },
        memberships: [{ role: "teacher" }, { role: "scholar" }],
      }),
    ).toBe(true);
  });

  it("is false for a teacher with only staff memberships (TRA-316)", () => {
    // The seeded dev teacher: autologin as this user must NOT mount scholar
    // Home's learner-only queries, which throw "A learner membership is required".
    expect(
      hasLearnerContext({
        me: { role: "teacher" },
        memberships: [{ role: "teacher" }, { role: "admin" }],
      }),
    ).toBe(false);
  });

  it("is false for a signed-out or role-less user", () => {
    expect(hasLearnerContext({ me: null, memberships: [] })).toBe(false);
    expect(hasLearnerContext({ me: {}, memberships: [] })).toBe(false);
  });
});
