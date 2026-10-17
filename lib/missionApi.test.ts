import { describe, expect, it } from "vitest";
import { nextBuildContract } from "@/components/nodeEditor/MissionFields";
import { bakePathArg, BUILD_PATH, ENDLESS_CHAT } from "./bakePaths";
import { canUnlockBuildOf, questLockOf, upNextCandidates } from "./missionApi";

describe("questLockOf (B6 lock rows)", () => {
  const unit = {
    questLocks: { act_build: { prerequisiteTitle: "Name the rule" } },
  };

  it("reads the lock for a locked build step", () => {
    expect(questLockOf(unit, "act_build")).toEqual({
      prerequisiteTitle: "Name the rule",
    });
  });

  it("treats any other row, a missing map, or a missing unit as unlocked", () => {
    expect(questLockOf(unit, "act_other")).toBeNull();
    expect(questLockOf({ title: "Old backend" }, "act_build")).toBeNull();
    expect(questLockOf(undefined, "act_build")).toBeNull();
    expect(questLockOf(unit, null)).toBeNull();
  });
});

describe("upNextCandidates (in-session Up next)", () => {
  const reckon = { _id: "reckon", title: "Name the rule", kind: "online" };
  const walk = { _id: "walk", title: "Go measure", kind: "offline" };
  const build = { _id: "build", title: "Build it", kind: "online", appActivity: true };
  const legacy = { _id: "legacy", title: "Old build", kind: "vibecode" };
  const ids = (xs: { _id: string }[]) => xs.map((x) => x._id);

  it("keeps app activities (a baked build step) and drops offline steps", () => {
    expect(ids(upNextCandidates([reckon, walk, build, legacy], reckon, {}))).toEqual([
      "reckon",
      "build",
      "legacy",
    ]);
  });

  it("drops a build step locked by another step; keeps one this step unlocks", () => {
    const locked = { questLocks: { build: { prerequisiteTitle: "Name the rule" } } };
    expect(ids(upNextCandidates([reckon, build], reckon, locked))).toEqual(["reckon", "build"]);
    const other = { _id: "intro", title: "Read about it", kind: "online" };
    expect(ids(upNextCandidates([other, reckon, build], other, locked))).toEqual([
      "intro",
      "reckon",
    ]);
  });
});

describe("canUnlockBuildOf (badge moment)", () => {
  it("is true only when the server says so", () => {
    expect(canUnlockBuildOf({ canUnlockBuild: true })).toBe(true);
    expect(canUnlockBuildOf({ canUnlockBuild: false })).toBe(false);
    expect(canUnlockBuildOf({})).toBe(false);
    expect(canUnlockBuildOf(null)).toBe(false);
  });
});

describe("bakePathArg (B4 path card)", () => {
  it("carries shape for the build card so the bake can key on it", () => {
    expect(bakePathArg(BUILD_PATH)).toEqual({
      title: "Build a simulation",
      blurb: BUILD_PATH.blurb,
      shape: "build",
    });
  });

  it("sends a plain path without shape, and nothing for endless chat", () => {
    expect(
      bakePathArg({ emoji: "🔍", title: "Get to the bottom of it", blurb: "Why" }),
    ).toEqual({ title: "Get to the bottom of it", blurb: "Why" });
    expect(bakePathArg(ENDLESS_CHAT)).toBeUndefined();
  });
});

describe("nextBuildContract (teacher mission fields)", () => {
  it("saves a gate-only mission on a non-app activity", () => {
    expect(
      nextBuildContract(undefined, { gate: " A first draft exists " }, { appActivity: false }),
    ).toEqual({ invariants: [], freedoms: [], gate: "A first draft exists" });
  });

  it("drops invariants on a non-app activity and clears an empty mission", () => {
    expect(
      nextBuildContract(
        { invariants: ["stale"], freedoms: ["Which moment"] },
        { freedoms: [] },
        { appActivity: false },
      ),
    ).toBeNull();
  });

  it("still needs a must-be-true line on an app activity", () => {
    expect(
      nextBuildContract(undefined, { gate: "It runs once" }, { appActivity: true }),
    ).toBe("needsInvariant");
  });
});
