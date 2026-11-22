import { describe, expect, it } from "vitest";
import { nextBuildContract } from "@/components/nodeEditor/MissionFields";
import { upNextCandidates } from "./missionApi";

describe("upNextCandidates (in-session Up next)", () => {
  const reckon = { _id: "reckon", title: "Name the rule", kind: "online" };
  const walk = { _id: "walk", title: "Go measure", kind: "offline" };
  const build = { _id: "build", title: "Build it", kind: "online", appActivity: true };
  const legacy = { _id: "legacy", title: "Old build", kind: "vibecode" };
  const ids = (xs: { _id: string }[]) => xs.map((x) => x._id);

  it("keeps app activities (a baked build step) and drops offline steps", () => {
    expect(ids(upNextCandidates([reckon, walk, build, legacy]))).toEqual([
      "reckon",
      "build",
      "legacy",
    ]);
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
