// TRA-519 B1/B5/B6: the one derivation of a session's mission and of the
// Quest build lock (convex/lib/mission.ts).
import { describe, expect, test } from "vitest";
import {
  DEFAULT_APP_GATE,
  defaultGateFor,
  questBuildLock,
  questBuildPrerequisite,
  lockedQuestBuildTitle,
  resolveSessionMission,
} from "../lib/mission";
import { questBuildLockLabel } from "../../shared/missionCopy";

const essay = {
  _id: "essay",
  title: "Write your rule",
  kind: "online",
  deliverable: { kind: "text" },
};
const discussion = {
  _id: "talk",
  title: "Talk it through",
  kind: "online",
  advanceRubric: { criteria: [] },
};
const walk = { _id: "walk", title: "Go measure", kind: "offline" };
const build = {
  _id: "build",
  title: "Build the simulation",
  kind: "online",
  appActivity: true,
  deliverable: { kind: "artifact" },
};
const legacyBuild = { _id: "legacy", title: "Old build", kind: "vibecode" };
const quest = { authorScholarId: "scholar1" };
const teacherUnit = {};

describe("defaultGateFor", () => {
  test("each deliverable kind gets its first-form gate", () => {
    expect(defaultGateFor(essay)).toMatch(/first draft/);
    expect(defaultGateFor({ kind: "online", deliverable: { kind: "slides" } })).toMatch(/slides/);
    expect(defaultGateFor({ kind: "online", deliverable: { kind: "map" } })).toMatch(/map/);
    expect(defaultGateFor(build)).toBe(DEFAULT_APP_GATE);
    expect(defaultGateFor(legacyBuild)).toBe(DEFAULT_APP_GATE);
  });

  test("exploration and non-online kinds get none", () => {
    expect(defaultGateFor(discussion)).toBeNull();
    expect(defaultGateFor(walk)).toBeNull();
    expect(defaultGateFor({ kind: "online" })).toBeNull();
  });
});

describe("resolveSessionMission", () => {
  test("default mission for a deliverable activity", () => {
    const m = resolveSessionMission({}, essay, teacherUnit);
    expect(m).toMatchObject({ source: "default", freedoms: [], invariants: [], questLine: null });
    expect(m?.gate).toMatch(/first draft/);
  });

  test("an authored gate wins; invariants only for app activities", () => {
    const authored = resolveSessionMission(
      {},
      { ...essay, buildContract: { invariants: ["x"], freedoms: ["topic"], gate: "Two paragraphs" } },
      teacherUnit,
    );
    expect(authored).toMatchObject({ source: "authored", gate: "Two paragraphs", freedoms: ["topic"], invariants: [] });
    const app = resolveSessionMission(
      {},
      { ...build, buildContract: { invariants: ["ball falls"], freedoms: [] } },
      teacherUnit,
    );
    expect(app).toMatchObject({ source: "authored", gate: DEFAULT_APP_GATE, invariants: ["ball falls"] });
  });

  test("no mission for exploration, free play, non-online and open chat", () => {
    expect(resolveSessionMission({}, discussion, teacherUnit)).toBeNull();
    expect(resolveSessionMission({}, walk, teacherUnit)).toBeNull();
    expect(resolveSessionMission({ freePlay: true }, essay, teacherUnit)).toBeNull();
    expect(resolveSessionMission({}, null, null)).toBeNull();
  });

  test("a Quest planning chat steers by the Quest mission once it has a gate", () => {
    expect(resolveSessionMission({}, null, { ...quest, mission: { text: "A clicker" } })).toBeNull();
    const m = resolveSessionMission({}, null, {
      ...quest,
      mission: { text: "A clicker that shows growth", gate: "it grows each tick" },
    });
    expect(m).toMatchObject({ source: "quest", gate: "it grows each tick", questLine: "A clicker that shows growth" });
  });

  test("the Quest line rides along on a Quest activity, never on a teacher unit", () => {
    const unitWithMission = { mission: { text: "Why slopes", gate: "g" } };
    expect(resolveSessionMission({}, essay, { ...quest, ...unitWithMission })?.questLine).toBe("Why slopes");
    expect(resolveSessionMission({}, essay, unitWithMission)?.questLine).toBeNull();
  });

  test("ownQuest marks a scholar's own Quest, never a teacher unit", () => {
    expect(resolveSessionMission({}, build, quest)?.ownQuest).toBe(true);
    expect(resolveSessionMission({}, build, teacherUnit)?.ownQuest).toBe(false);
    expect(
      resolveSessionMission({}, null, { ...quest, mission: { text: "A clicker", gate: "g" } })?.ownQuest,
    ).toBe(true);
  });

  test("unlocksBuild framing is for learning steps only", () => {
    expect(resolveSessionMission({}, essay, quest, { unlocksBuild: "Build it" })?.unlocksBuild).toBe("Build it");
    expect(resolveSessionMission({}, build, quest, { unlocksBuild: "Build it" })?.unlocksBuild).toBeNull();
  });
});

describe("learn before you build (B6)", () => {
  const ordered = [essay, walk, discussion, build];
  const none = () => false;
  const all = () => true;

  test("the prerequisite is the nearest preceding learning step, skipping away-from-screen and discussion steps", () => {
    expect(questBuildPrerequisite(ordered, "build")?._id).toBe("essay");
    expect(questBuildPrerequisite(ordered, "essay")).toBeNull();
    expect(questBuildPrerequisite([build, essay], "build")).toBeNull();
  });

  test("locked in a Quest until the learning step is complete", () => {
    expect(questBuildLock(quest, ordered, "build", none)).toEqual({
      locked: true,
      prerequisiteId: "essay",
      prerequisiteTitle: "Write your rule",
    });
    expect(questBuildLock(quest, ordered, "build", all)).toEqual({ locked: false });
    expect(questBuildLock(quest, ordered, "essay", none)).toEqual({ locked: false });
  });

  test("teacher units are never locked", () => {
    expect(questBuildLock(teacherUnit, ordered, "build", none)).toEqual({ locked: false });
  });

  test("every step before a locked build step names it, not only the nearest prerequisite", () => {
    const first = { ...essay, _id: "first", title: "Read about slopes" };
    const steps = [first, essay, walk, build];
    expect(lockedQuestBuildTitle(quest, steps, "first", none)).toBe("Build the simulation");
    expect(lockedQuestBuildTitle(quest, steps, "essay", none)).toBe("Build the simulation");
    // The unlock condition is still the nearest learning step only.
    const onlyEssay = (id: string) => id === "essay";
    expect(lockedQuestBuildTitle(quest, steps, "first", onlyEssay)).toBeNull();
    const onlyFirst = (id: string) => id === "first";
    expect(lockedQuestBuildTitle(quest, steps, "first", onlyFirst)).toBe("Build the simulation");
  });

  test("the planning chat (no step) and a step after the build see the locked build too", () => {
    const reflect = { ...essay, _id: "reflect", title: "Reflect" };
    expect(lockedQuestBuildTitle(quest, ordered, null, none)).toBe("Build the simulation");
    expect(lockedQuestBuildTitle(quest, [...ordered, reflect], "reflect", none)).toBe("Build the simulation");
    expect(lockedQuestBuildTitle(quest, ordered, null, all)).toBeNull();
  });

  test("a teacher's unit, or a Quest with no build step, has no locked build", () => {
    expect(lockedQuestBuildTitle(teacherUnit, ordered, "essay", none)).toBeNull();
    expect(lockedQuestBuildTitle(quest, [essay, walk], "essay", none)).toBeNull();
  });

  test("the Quest planning chat carries the unlock framing", () => {
    const m = resolveSessionMission({}, null, {
      ...quest,
      mission: { text: "A clicker", gate: "it ticks" },
    }, { unlocksBuild: "Build it" });
    expect(m?.unlocksBuild).toBe("Build it");
  });

  test("lock label", () => {
    expect(questBuildLockLabel("Write your rule")).toBe("Unlocks when you finish Write your rule");
  });
});
