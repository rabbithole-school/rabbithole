import { describe, expect, test } from "vitest";

import {
  parentPortalMode,
  parentSignInHref,
  parentTabFromPath,
  parentVisibleTabs,
  PARENT_VISIBLE_TABS,
} from "./parentTabs";

describe("parent tabs", () => {
  test("supports the enrolled-family routes, including an empty portfolio", () => {
    expect(PARENT_VISIBLE_TABS).toEqual([
      "records",
      "portfolio",
      "math",
      "calendar",
      "messages",
    ]);
    expect(parentTabFromPath("/parent/records")).toBe("records");
    expect(parentTabFromPath("/parent/portfolio")).toBe("portfolio");
    expect(parentTabFromPath("/parent/math")).toBe("math");
    expect(parentTabFromPath("/parent/calendar")).toBe("calendar");
  });

  test("always includes Messages for enrolled families", () => {
    expect(parentVisibleTabs()).toEqual([
      "records",
      "portfolio",
      "math",
      "calendar",
      "messages",
      "admissions",
    ]);
    expect(parentTabFromPath("/parent/messages")).toBe("messages");
  });

  test("falls back to Records for unknown or hidden routes", () => {
    expect(parentTabFromPath("/parent")).toBe("records");
    expect(parentTabFromPath("/parent/progress")).toBe("records");
    expect(parentTabFromPath("/parent/settings")).toBe("records");
    expect(parentTabFromPath("/parent/unknown")).toBe("records");
  });

  test("lands program-guest families on Records with Portfolio and Messages also available", () => {
    expect(parentVisibleTabs("program_guest")).toEqual([
      "records",
      "portfolio",
      "messages",
    ]);
    expect(parentTabFromPath("/parent", "program_guest")).toBe("records");
    expect(parentTabFromPath("/parent/records", "program_guest")).toBe("records");
    expect(parentTabFromPath("/parent/portfolio", "program_guest")).toBe("portfolio");
    expect(parentTabFromPath("/parent/messages", "program_guest")).toBe("messages");
  });

  test("reads the tab from segment two even inside a course view", () => {
    expect(parentTabFromPath("/parent/portfolio/abc123")).toBe("portfolio");
    expect(parentTabFromPath("/parent/portfolio/other", "program_guest")).toBe(
      "portfolio",
    );
  });

  test("shows an applicant family only Admissions and lands every route there", () => {
    expect(parentVisibleTabs("applicant")).toEqual(["admissions"]);
    expect(parentTabFromPath("/parent", "applicant")).toBe("admissions");
    expect(parentTabFromPath("/parent/admissions", "applicant")).toBe(
      "admissions",
    );
    for (const hidden of [
      "records",
      "portfolio",
      "math",
      "calendar",
      "messages",
      "progress",
      "settings",
    ]) {
      expect(parentTabFromPath(`/parent/${hidden}`, "applicant")).toBe(
        "admissions",
      );
    }
  });

  test("shows an enrolled family Admissions last, and keeps it from program guests", () => {
    expect(parentVisibleTabs().at(-1)).toBe("admissions");
    expect(parentTabFromPath("/parent/admissions")).toBe("admissions");
    expect(parentTabFromPath("/parent")).toBe("records");
    expect(parentVisibleTabs("program_guest")).not.toContain("admissions");
    expect(parentTabFromPath("/parent/admissions", "program_guest")).toBe(
      "records",
    );
  });

  test("derives the mode with applicant taking precedence", () => {
    expect(
      parentPortalMode({ applicantOnly: false, programGuest: false }),
    ).toBe("family");
    expect(parentPortalMode({ applicantOnly: false, programGuest: true })).toBe(
      "program_guest",
    );
    expect(parentPortalMode({ applicantOnly: true, programGuest: false })).toBe(
      "applicant",
    );
  });
});

describe("parentSignInHref", () => {
  test("an expired session on the Admissions tab goes to the applicant sign-in", () => {
    expect(parentSignInHref("/parent/admissions")).toBe(
      "/admissions/sign-in?next=%2Fparent%2Fadmissions",
    );
    expect(parentSignInHref("/parent/admissions?x=1")).toBe(
      "/admissions/sign-in?next=%2Fparent%2Fadmissions%3Fx%3D1",
    );
  });

  test("anywhere else in the portal, a browser last in applicant mode does too", () => {
    expect(parentSignInHref("/parent", true)).toBe(
      "/admissions/sign-in?next=%2Fparent",
    );
  });

  test("enrolled families keep the generic sign-in", () => {
    expect(parentSignInHref("/parent/records?child=abc")).toBe(
      "/sign-in?next=%2Fparent%2Frecords%3Fchild%3Dabc",
    );
    expect(parentSignInHref("/parent/admissionsx")).toBe(
      "/sign-in?next=%2Fparent%2Fadmissionsx",
    );
  });
});
