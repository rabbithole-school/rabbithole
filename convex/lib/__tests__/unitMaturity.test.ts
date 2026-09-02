import { describe, expect, test } from "vitest";
import {
  activityNodeStatus,
  buildCompletenessCriteria,
  computeUnitMaturity,
  deriveReadiness,
  REHEARSE_PASS_FITNESS,
  rollupNodeStatus,
  unitNodeStatus,
  type MaturityInput,
  type ReadinessInput,
} from "../unitMaturity";

// A fully-built unit + lessons (all 7 completeness checks met).
const builtUnit = {
  bigIdea: "Systems balance",
  essentialQuestions: ["Why?"],
  enduringUnderstandings: ["Things balance"],
};
const builtLessons = [
  { strand: "core", systemPrompt: "p" },
  { strand: "connections", systemPrompt: "p" },
  { strand: "practice", systemPrompt: "p" },
];

function input(overrides: Partial<MaturityInput> = {}): MaturityInput {
  return {
    unit: builtUnit,
    lessons: builtLessons,
    review: null,
    rehearsal: null,
    assignment: null,
    grounding: null,
    ...overrides,
  };
}

describe("buildCompletenessCriteria", () => {
  test("all met on a fully-built unit", () => {
    const c = buildCompletenessCriteria(builtUnit, builtLessons);
    expect(c).toHaveLength(7);
    expect(c.every((x) => x.met)).toBe(true);
  });

  test("flags each missing essential", () => {
    const c = buildCompletenessCriteria(
      { bigIdea: "  ", essentialQuestions: [], enduringUnderstandings: undefined },
      [],
    );
    const byLabel = Object.fromEntries(c.map((x) => [x.label, x.met]));
    expect(byLabel["Big Idea"]).toBe(false); // whitespace-only
    expect(byLabel["Essential Questions"]).toBe(false);
    expect(byLabel["Enduring Understandings"]).toBe(false);
    expect(byLabel["Core lesson"]).toBe(false);
    expect(byLabel["All prompts generated"]).toBe(false); // no lessons
  });

  test("'All prompts generated' is false if any lesson lacks a prompt", () => {
    const c = buildCompletenessCriteria(builtUnit, [
      { strand: "core", systemPrompt: "p" },
      { strand: "connections", systemPrompt: "  " },
    ]);
    expect(c.find((x) => x.label === "All prompts generated")!.met).toBe(false);
  });
});

describe("computeUnitMaturity — ladder is strictly sequential", () => {
  test("incomplete unit is in Draft, frontier=draft", () => {
    const m = computeUnitMaturity(
      input({ unit: { bigIdea: "x" }, lessons: [] }),
    );
    expect(m.currentStageId).toBe("draft");
    expect(m.frontierStageId).toBe("draft");
    expect(m.stages[0].done).toBe(false);
    expect(m.completeness.completed).toBeLessThan(m.completeness.total);
    expect(m.stages[0].detail).toMatch(/essentials/);
  });

  test("built but unreviewed: Draft done, frontier=reviewed", () => {
    const m = computeUnitMaturity(input());
    expect(m.stages[0].done).toBe(true);
    expect(m.stages[0].detail).toBe("Built");
    expect(m.currentStageId).toBe("draft");
    expect(m.frontierStageId).toBe("reviewed");
    expect(m.stages[1].detail).toBe("Not reviewed");
  });

  test("review with open gaps does NOT advance past Draft", () => {
    const m = computeUnitMaturity(input({ review: { openGapCount: 2 } }));
    expect(m.stages[1].done).toBe(false);
    expect(m.stages[1].detail).toBe("2 gaps open");
    expect(m.frontierStageId).toBe("reviewed");
  });

  test("clean review → Reviewed, frontier=rehearsed", () => {
    const m = computeUnitMaturity(input({ review: { openGapCount: 0 } }));
    expect(m.stages[1].done).toBe(true);
    expect(m.stages[1].detail).toBe("Coherent");
    expect(m.currentStageId).toBe("reviewed");
    expect(m.frontierStageId).toBe("rehearsed");
  });

  test("rehearsal cannot advance while review still has gaps (gating)", () => {
    const m = computeUnitMaturity(
      input({
        review: { openGapCount: 1 },
        rehearsal: { onlineCount: 2, passing: 2 },
      }),
    );
    // Even with passing rehearsals, an un-reviewed unit stays at Draft.
    expect(m.stages[2].done).toBe(false);
    expect(m.currentStageId).toBe("draft");
  });

  test("all online activities passing → Rehearsed; frontier=assigned", () => {
    const m = computeUnitMaturity(
      input({
        review: { openGapCount: 0 },
        rehearsal: { onlineCount: 3, passing: 3 },
      }),
    );
    expect(m.stages[2].done).toBe(true);
    expect(m.stages[2].detail).toBe("3/3 activities");
    expect(m.currentStageId).toBe("rehearsed");
    // Assigned is the next rung now (no active assignment yet).
    expect(m.frontierStageId).toBe("assigned");
  });

  test("Assigned lights independently from an active assignment", () => {
    const m = computeUnitMaturity(
      input({
        review: { openGapCount: 0 },
        rehearsal: { onlineCount: 2, passing: 2 },
        assignment: { activeCount: 2 },
      }),
    );
    const assigned = m.stages.find((s) => s.id === "assigned")!;
    expect(assigned.done).toBe(true);
    expect(assigned.detail).toBe("Assigned to 2 cohorts");
    // Rehearsed + Assigned done, Debriefed is the frontier.
    expect(m.frontierStageId).toBe("debriefed");
  });

  test("Assigned can light even when earlier confidence rungs aren't done", () => {
    // You can ship a draft — assignment is an execution fact, not a grade.
    const m = computeUnitMaturity(
      input({ unit: { bigIdea: "x" }, lessons: [], assignment: { activeCount: 1 } }),
    );
    expect(m.stages.find((s) => s.id === "assigned")!.done).toBe(true);
    expect(m.stages[0].done).toBe(false); // draft not complete
    // Frontier is still the first un-earned confidence rung.
    expect(m.frontierStageId).toBe("draft");
  });

  test("partial rehearsal does not earn Rehearsed", () => {
    const m = computeUnitMaturity(
      input({
        review: { openGapCount: 0 },
        rehearsal: { onlineCount: 3, passing: 2 },
      }),
    );
    expect(m.stages[2].done).toBe(false);
    expect(m.stages[2].detail).toBe("2/3 activities");
  });

  test("no online activities → Rehearsed unreachable, with a clear detail", () => {
    const m = computeUnitMaturity(
      input({ review: { openGapCount: 0 }, rehearsal: { onlineCount: 0, passing: 0 } }),
    );
    expect(m.stages[2].done).toBe(false);
    expect(m.stages[2].detail).toBe("No online activities");
  });

  test("grounded + trustworthy + assigned → Debriefed, all stages done, frontier=null", () => {
    const m = computeUnitMaturity(
      input({
        review: { openGapCount: 0 },
        rehearsal: { onlineCount: 2, passing: 2 },
        assignment: { activeCount: 1 },
        grounding: { groundedCount: 2, trustworthyCount: 2 },
      }),
    );
    expect(m.stages.every((s) => s.done)).toBe(true);
    expect(m.currentStageId).toBe("debriefed");
    expect(m.frontierStageId).toBeNull();
    expect(m.stages[4].detail).toBe("Matches real scholars");
  });

  test("grounded but NOT trustworthy → not Debriefed, warns", () => {
    const m = computeUnitMaturity(
      input({
        review: { openGapCount: 0 },
        rehearsal: { onlineCount: 2, passing: 2 },
        assignment: { activeCount: 1 },
        grounding: { groundedCount: 2, trustworthyCount: 1 },
      }),
    );
    expect(m.stages[4].done).toBe(false);
    expect(m.stages[4].detail).toBe("Off from real scholars");
    expect(m.currentStageId).toBe("assigned");
    expect(m.frontierStageId).toBe("debriefed");
  });
});

describe("computeUnitMaturity — shape invariants", () => {
  test("always returns 5 stages in ladder order", () => {
    const m = computeUnitMaturity(input());
    expect(m.stages.map((s) => s.id)).toEqual([
      "draft",
      "reviewed",
      "rehearsed",
      "assigned",
      "debriefed",
    ]);
  });

  test("REHEARSE_PASS_FITNESS is on the 1–5 scale", () => {
    expect(REHEARSE_PASS_FITNESS).toBeGreaterThan(1);
    expect(REHEARSE_PASS_FITNESS).toBeLessThanOrEqual(5);
  });
});

describe("activityNodeStatus — per-activity dot", () => {
  test("non-online activity is always 'built' (nothing to rehearse)", () => {
    expect(
      activityNodeStatus({
        isOnline: false,
        bestFitness: null,
        grounded: false,
        trustworthy: false,
      }),
    ).toBe("built");
  });

  test("online, never rehearsed → 'draft'", () => {
    expect(
      activityNodeStatus({
        isOnline: true,
        bestFitness: null,
        grounded: false,
        trustworthy: false,
      }),
    ).toBe("draft");
  });

  test("rehearsed at/above the bar, not debriefed → 'inProgress'", () => {
    expect(
      activityNodeStatus({
        isOnline: true,
        bestFitness: REHEARSE_PASS_FITNESS,
        grounded: false,
        trustworthy: false,
      }),
    ).toBe("inProgress");
  });

  test("rehearsed BELOW the bar → 'needsWork'", () => {
    expect(
      activityNodeStatus({
        isOnline: true,
        bestFitness: REHEARSE_PASS_FITNESS - 0.5,
        grounded: false,
        trustworthy: false,
      }),
    ).toBe("needsWork");
  });

  test("debriefed + trustworthy → 'matured'", () => {
    expect(
      activityNodeStatus({
        isOnline: true,
        bestFitness: 5,
        grounded: true,
        trustworthy: true,
      }),
    ).toBe("matured");
  });

  test("debriefed but NOT trustworthy → 'needsWork' (sims off from real)", () => {
    expect(
      activityNodeStatus({
        isOnline: true,
        bestFitness: 5,
        grounded: true,
        trustworthy: false,
      }),
    ).toBe("needsWork");
  });
});

describe("rollupNodeStatus — lesson dot", () => {
  test("no rehearsable children → 'built'", () => {
    expect(rollupNodeStatus([])).toBe("built");
    expect(rollupNodeStatus(["built", "built"])).toBe("built");
  });

  test("any needsWork wins", () => {
    expect(rollupNodeStatus(["matured", "needsWork", "inProgress"])).toBe(
      "needsWork",
    );
  });

  test("all matured (ignoring built) → 'matured'", () => {
    expect(rollupNodeStatus(["matured", "built", "matured"])).toBe("matured");
  });

  test("some progress, not all matured → 'inProgress'", () => {
    expect(rollupNodeStatus(["matured", "draft"])).toBe("inProgress");
    expect(rollupNodeStatus(["inProgress", "draft"])).toBe("inProgress");
  });

  test("all draft → 'draft'", () => {
    expect(rollupNodeStatus(["draft", "draft", "built"])).toBe("draft");
  });
});

describe("unitNodeStatus — unit dot from the ladder stage", () => {
  test("debriefed → matured; reviewed/rehearsed/assigned → inProgress; draft → draft", () => {
    expect(unitNodeStatus("debriefed")).toBe("matured");
    expect(unitNodeStatus("assigned")).toBe("inProgress");
    expect(unitNodeStatus("rehearsed")).toBe("inProgress");
    expect(unitNodeStatus("reviewed")).toBe("inProgress");
    expect(unitNodeStatus("draft")).toBe("draft");
  });
});

// ─── Signal 1 · Readiness (the green preflight gate, PR #1072 §8) ──────────
describe("deriveReadiness — the preflight gate", () => {
  const ready = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
    built: true,
    builtDetail: "Built",
    review: { openGapCount: 0 },
    rehearsal: { onlineCount: 2, passing: 2 },
    ...over,
  });

  test("all three gates cleared ⇒ ready", () => {
    const r = deriveReadiness(ready());
    expect(r.ready).toBe(true);
    expect(r.running).toBe(false);
    expect(r.frontierStepId).toBeNull();
    expect(r.steps.map((s) => s.state)).toEqual(["done", "done", "done"]);
  });

  test("ready needs NO assignment or real sessions — the gate is preflight only", () => {
    // ReadinessInput carries no assignment/session field at all; a unit with a
    // clean review + passing rehearsal is Ready before anything ships.
    const r = deriveReadiness(ready());
    expect(r.ready).toBe(true);
    expect(Object.keys(ready())).not.toContain("assignment");
  });

  test("not built ⇒ built + review are the frontier, not ready", () => {
    const r = deriveReadiness(ready({ built: false, builtDetail: "3/7 essentials" }));
    expect(r.ready).toBe(false);
    expect(r.frontierStepId).toBe("built");
    // review can't be actioned until built.
    expect(r.steps[1].state).toBe("todo");
  });

  test("open review gaps block Ready and surface the count", () => {
    const r = deriveReadiness(ready({ review: { openGapCount: 2 } }));
    expect(r.ready).toBe(false);
    expect(r.frontierStepId).toBe("heuristicReview");
    expect(r.steps[1].detail).toBe("2 gaps open");
  });

  test("a running heuristic review shows as running (drives the Spinner)", () => {
    const r = deriveReadiness(ready({ review: null, reviewRunning: true }));
    expect(r.running).toBe(true);
    expect(r.runningStepId).toBe("heuristicReview");
    expect(r.steps[1].state).toBe("running");
  });

  test("no online activities ⇒ rehearsal is n/a and doesn't block Ready", () => {
    const r = deriveReadiness(ready({ rehearsal: { onlineCount: 0, passing: 0 } }));
    expect(r.ready).toBe(true);
    expect(r.steps[2].state).toBe("na");
  });

  test("an explicit skip clears the expensive rehearsal gate (hatched, still Ready)", () => {
    const r = deriveReadiness(
      ready({ rehearsal: { onlineCount: 2, passing: 0 }, rehearsalSkipped: true }),
    );
    expect(r.ready).toBe(true);
    expect(r.rehearsalSkipped).toBe(true);
    expect(r.steps[2].state).toBe("skipped");
  });

  test("a running rehearsal shows as running, not ready", () => {
    const r = deriveReadiness(
      ready({ rehearsal: { onlineCount: 2, passing: 1 }, rehearsalRunning: true }),
    );
    expect(r.ready).toBe(false);
    expect(r.running).toBe(true);
    expect(r.runningStepId).toBe("scholarBotRehearsal");
  });

  test("labels are the renamed vocabulary", () => {
    const r = deriveReadiness(ready());
    expect(r.steps.map((s) => s.label)).toEqual([
      "Built",
      "Heuristic review",
      "Scholar-bot rehearsal",
    ]);
  });
});
