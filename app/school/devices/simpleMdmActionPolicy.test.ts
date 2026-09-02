import { describe, expect, test } from "vitest";
import { getSimpleMdmActionPolicy } from "./simpleMdmActionPolicy";

describe("SimpleMDM action policy", () => {
  test("fails closed while integration status is unresolved", () => {
    expect(getSimpleMdmActionPolicy(undefined)).toEqual({
      status: "loading",
      showPushActions: false,
      canAssign: false,
      assignmentBehavior: "wait",
    });
  });

  test("shows push actions and auto-pushes assignments when configured", () => {
    expect(getSimpleMdmActionPolicy(true)).toEqual({
      status: "configured",
      showPushActions: true,
      canAssign: true,
      assignmentBehavior: "push",
    });
  });

  test("hides push actions and uses fallback enrollment when unconfigured", () => {
    expect(getSimpleMdmActionPolicy(false)).toEqual({
      status: "unconfigured",
      showPushActions: false,
      canAssign: true,
      assignmentBehavior: "fallback",
    });
  });
});
