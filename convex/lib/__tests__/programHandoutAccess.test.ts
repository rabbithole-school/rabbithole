import { describe, expect, test } from "vitest";
import type { Doc } from "../../_generated/dataModel";
import { isProgramHandoutActivity } from "../programHandoutAccess";

type Activity = Doc<"activities">;
type Assignment = Doc<"assignments">;

function activity(overrides: Partial<Activity> = {}): Activity {
  return {
    _id: "activity_1" as Activity["_id"],
    _creationTime: 0,
    title: "Safety handout",
    kind: "offline",
    order: 0,
    ...overrides,
  } as Activity;
}

function assignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    _id: "assignment_1" as Assignment["_id"],
    _creationTime: 0,
    teacherId: "user_1" as Assignment["teacherId"],
    scholarIds: [],
    scholarGroupId: "group_1" as NonNullable<Assignment["scholarGroupId"]>,
    kind: "adHocDispatch",
    startedAt: 0,
    ...overrides,
  } as Assignment;
}

describe("isProgramHandoutActivity", () => {
  test("a lesson-less offline activity on an ad-hoc group assignment is a handout", () => {
    expect(isProgramHandoutActivity(activity(), assignment())).toBe(true);
  });

  test("anything missing one leg of the shape is not", () => {
    expect(isProgramHandoutActivity(null, assignment())).toBe(false);
    expect(isProgramHandoutActivity(activity(), null)).toBe(false);
    // A curriculum activity: it has a lesson.
    expect(
      isProgramHandoutActivity(
        activity({ lessonId: "lesson_1" as Activity["lessonId"] }),
        assignment(),
      ),
    ).toBe(false);
    expect(
      isProgramHandoutActivity(activity({ kind: "online" }), assignment()),
    ).toBe(false);
    expect(
      isProgramHandoutActivity(activity(), assignment({ kind: "unit" })),
    ).toBe(false);
    // No group provenance: it is not a program artifact at all.
    expect(
      isProgramHandoutActivity(
        activity(),
        assignment({ scholarGroupId: undefined }),
      ),
    ).toBe(false);
    expect(
      isProgramHandoutActivity(activity(), assignment({ archivedAt: 1 })),
    ).toBe(false);
  });
});
