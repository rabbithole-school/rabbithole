import { describe, expect, test } from "vitest";
import {
  appRoleFor,
  deliverableStatusFor,
  effectiveActivityKind,
  isAppActivity,
  sessionAppContextFor,
} from "./appSurface";

describe("app activity shape", () => {
  test("legacy vibecode and folded online+app are app activities", () => {
    expect(isAppActivity({ kind: "vibecode" })).toBe(true);
    expect(isAppActivity({ kind: "online", appActivity: true })).toBe(true);
    expect(isAppActivity({ kind: "online" })).toBe(false);
    // A stray flag on a non-online kind is not an app activity.
    expect(isAppActivity({ kind: "offline", appActivity: true })).toBe(false);
    expect(isAppActivity(null)).toBe(false);
  });

  test("effective kind keeps the legacy token for every app activity", () => {
    expect(effectiveActivityKind({ kind: "online", appActivity: true })).toBe("vibecode");
    expect(effectiveActivityKind({ kind: "vibecode" })).toBe("vibecode");
    expect(effectiveActivityKind({ kind: "online" })).toBe("online");
    expect(effectiveActivityKind({ kind: "game" })).toBe("game");
  });
});

describe("appRoleFor", () => {
  test.each([
    ["no activity", null, "work"],
    ["app activity", { kind: "online", appActivity: true }, "work"],
    ["legacy app activity", { kind: "vibecode" }, "work"],
    ["app deliverable", { kind: "online", deliverable: { kind: "artifact" } }, "work"],
    ["written deliverable", { kind: "online", deliverable: { kind: "text" } }, "side"],
    ["slides deliverable", { kind: "online", deliverable: { kind: "slides" } }, "side"],
    ["discussion rubric", { kind: "online", advanceRubric: { criteria: [] } }, "side"],
    ["bare online", { kind: "online" }, "work"],
  ] as const)("%s", (_label, activity, role) => {
    expect(appRoleFor(activity)).toBe(role);
  });
});

describe("sessionAppContextFor", () => {
  test("builder features follow any app; the stance only the app that is the work", () => {
    expect(
      sessionAppContextFor({ sessionMode: undefined, role: "side", hasApp: true }),
    ).toEqual({
      builderPrimary: false,
      hasApp: true,
      role: "side",
      builderFeatures: true,
      builderStance: false,
    });
    expect(
      sessionAppContextFor({ sessionMode: undefined, role: "work", hasApp: true })
        .builderStance,
    ).toBe(true);
    expect(
      sessionAppContextFor({ sessionMode: undefined, role: "work", hasApp: false }),
    ).toMatchObject({ builderFeatures: false, builderStance: false });
  });

  test("a builder-primary session has builder features before its first build", () => {
    expect(
      sessionAppContextFor({ sessionMode: "vibecode", role: "work", hasApp: false }),
    ).toMatchObject({ builderPrimary: true, builderFeatures: true, builderStance: true });
  });
});

test("deliverable status", () => {
  expect(deliverableStatusFor({ completed: false, hasWork: false })).toBe("not started");
  expect(deliverableStatusFor({ completed: false, hasWork: true })).toBe("in progress");
  expect(deliverableStatusFor({ completed: true, hasWork: false })).toBe("done");
});
