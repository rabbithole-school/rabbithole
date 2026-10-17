import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILD_SIMULATION_PATH,
  MISSION_COPY,
  questBuildLockLabel,
} from "./missionCopy";

// The scholar-facing mission labels (TRA-519) render on web AND the iPad. Both
// import this one module (native through its vendored copy), so pinning the
// strings here — and the vendored copy to this file — keeps them identical.
describe("mission copy", () => {
  it("pins the scholar-facing labels", () => {
    expect(MISSION_COPY.savedForLater).toBe("Saved for later");
    expect(MISSION_COPY.buildItNow).toBe("Build it now");
    expect(MISSION_COPY.makeItAQuest).toBe("Make it a Quest");
    expect(MISSION_COPY.missionPrefix).toBe("Mission:");
    expect(MISSION_COPY.unlockBuild).toBe("Unlock: build a simulation of this");
    expect(BUILD_SIMULATION_PATH).toEqual({
      emoji: "🛠️",
      title: "Build a simulation",
      blurb: "Figure out how it works, then build a simulation that shows it.",
      shape: "build",
    });
    expect(questBuildLockLabel("Name the rule")).toBe(
      "Unlocks when you finish Name the rule",
    );
  });

  it("native reads a byte-identical vendored copy", () => {
    const shared = readFileSync(resolve(__dirname, "missionCopy.ts"), "utf8");
    const vendored = readFileSync(
      resolve(__dirname, "../native/vendor/shared/missionCopy.ts"),
      "utf8",
    );
    expect(vendored).toBe(shared);
  });
});
