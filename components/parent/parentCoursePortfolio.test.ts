import { describe, expect, test } from "vitest";

import {
  courseTileMeta,
  mediaReleaseNoticeCopy,
  sessionBreadcrumb,
  sessionDateLabel,
} from "./parentCoursePortfolio";

describe("parent course tiles", () => {
  test("counts work and sessions, singular and plural", () => {
    expect(courseTileMeta(3, 5)).toBe("3 pieces of work · 5 sessions");
    expect(courseTileMeta(1, 1)).toBe("1 piece of work · 1 session");
  });

  test("drops an empty half and stays silent when the course is empty", () => {
    expect(courseTileMeta(0, 4)).toBe("4 sessions");
    expect(courseTileMeta(2, 0)).toBe("2 pieces of work");
    expect(courseTileMeta(0, 0)).toBeNull();
  });
});

describe("parent course sessions", () => {
  test("joins the unit, lesson and activity titles it has", () => {
    expect(
      sessionBreadcrumb({
        unitTitle: "Fractions",
        lessonTitle: "Equal shares",
        activityTitle: "Fold and label",
      }),
    ).toBe("Fractions · Equal shares · Fold and label");
  });

  test("renders a handout-only session as its own title", () => {
    expect(
      sessionBreadcrumb({
        unitTitle: null,
        lessonTitle: null,
        activityTitle: "Robot build checklist",
      }),
    ).toBe("Robot build checklist");
    expect(
      sessionBreadcrumb({
        unitTitle: "Robotics",
        lessonTitle: null,
        activityTitle: "Gear ratios",
      }),
    ).toBe("Robotics · Gear ratios");
  });

  test("labels a scheduled date, and nothing when there isn't one", () => {
    expect(sessionDateLabel(Date.UTC(2026, 11, 21, 20, 0, 0))).toMatch(
      /Dec 21/,
    );
    expect(sessionDateLabel(null)).toBeNull();
  });
});

describe("media release notice copy", () => {
  test("a missing form promises no work at all yet, not just no photos", () => {
    const copy = mediaReleaseNoticeCopy("form_missing");
    expect(copy).toEqual({
      body: "Shared work and photos can appear here once the visiting-student form is completed.",
      linkLabel: "Open the visiting-student form",
    });
    // The gate withholds non-media work too while the form is missing, so the
    // notice must not claim other work shows up either way.
    expect(copy!.body).not.toMatch(/either way/);
  });

  test("a withheld media release says other work still appears", () => {
    expect(mediaReleaseNoticeCopy("not_granted")).toEqual({
      body: "Photos and videos aren\u2019t shared because the media release in the visiting-student form wasn\u2019t granted. Other shared work and the teacher\u2019s resources still appear here.",
      linkLabel: "Update the visiting-student form",
    });
  });

  test("the settled states show no notice", () => {
    expect(mediaReleaseNoticeCopy("granted")).toBeNull();
    expect(mediaReleaseNoticeCopy("not_applicable")).toBeNull();
  });
});
