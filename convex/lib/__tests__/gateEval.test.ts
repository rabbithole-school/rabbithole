import { describe, it, expect } from "vitest";
import {
  evaluateGates,
  gatesForSeed,
  gateSkillKeys,
  type GateFacts,
} from "../practice/gateEval";
import { FLUENT_REPS } from "../practice/scheduler";
import { WHOLE_NUMBER_ARITHMETIC_DOMAIN } from "../../seed/wholeNumberArithmeticGraph";
import type { CrossDomainSeed } from "../practice/crossDomainSeeds";

const base = { topic: "t", scholarInvitation: "i", rationale: "r", connectionTo: "c" };

function facts(
  over: Partial<{ reps: Record<string, number>; signals: string[]; topics: string[] }> = {},
): GateFacts {
  const reps = over.reps ?? {};
  const signals = new Set(over.signals ?? []);
  const topics = new Set(over.topics ?? []);
  return {
    reps: (d, k) => reps[`${d}::${k}`] ?? 0,
    hasSignal: (t) => signals.has(t),
    topicSurfaced: (t) => topics.has(t),
  };
}

describe("gateEval", () => {
  it("legacy gateSkillKey fires only at FLUENT_REPS", () => {
    const seed: CrossDomainSeed = { ...base, gateSkillKey: "mult_facts_7_8_9" };
    const key = `${WHOLE_NUMBER_ARITHMETIC_DOMAIN}::mult_facts_7_8_9`;
    expect(evaluateGates(seed, facts({ reps: { [key]: FLUENT_REPS - 1 } }))).toBe(false);
    expect(evaluateGates(seed, facts({ reps: { [key]: FLUENT_REPS } }))).toBe(true);
  });

  it("normalizes a legacy seed to one FLUENT practiceSkill gate", () => {
    const seed: CrossDomainSeed = { ...base, gateSkillKey: "count_on" };
    expect(gatesForSeed(seed)).toEqual({
      gates: [
        {
          kind: "practiceSkill",
          domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
          skillKey: "count_on",
          minReps: FLUENT_REPS,
        },
      ],
      mode: "all",
    });
    expect(gateSkillKeys(seed)).toEqual(["count_on"]);
  });

  it("gates[] mode 'all' (default) requires every gate", () => {
    const seed: CrossDomainSeed = {
      ...base,
      gateSkillKey: "x",
      gates: [
        { kind: "practiceSkill", domain: "d", skillKey: "a", minReps: 3 },
        { kind: "observerSignal", signalType: "persistence" },
      ],
    };
    expect(evaluateGates(seed, facts({ reps: { "d::a": 3 } }))).toBe(false); // missing signal
    expect(
      evaluateGates(seed, facts({ reps: { "d::a": 3 }, signals: ["persistence"] })),
    ).toBe(true);
  });

  it("gates[] mode 'any' needs just one gate", () => {
    const seed: CrossDomainSeed = {
      ...base,
      gateSkillKey: "x",
      gateMode: "any",
      gates: [
        { kind: "practiceSkill", domain: "d", skillKey: "a", minReps: 5 },
        { kind: "observerSignal", signalType: "curiosity" },
      ],
    };
    expect(evaluateGates(seed, facts())).toBe(false);
    expect(evaluateGates(seed, facts({ signals: ["curiosity"] }))).toBe(true);
    expect(evaluateGates(seed, facts({ reps: { "d::a": 5 } }))).toBe(true);
  });

  it("topicMentioned respects the privacy limit (only already-surfaced topics)", () => {
    const seed: CrossDomainSeed = {
      ...base,
      gateSkillKey: "x",
      gates: [{ kind: "topicMentioned", topic: "volcanoes" }],
    };
    expect(evaluateGates(seed, facts())).toBe(false); // not surfaced → never fires
    expect(evaluateGates(seed, facts({ topics: ["volcanoes"] }))).toBe(true);
  });

  it("gateSkillKeys collects the practiceSkill gates from gates[]", () => {
    const seed: CrossDomainSeed = {
      ...base,
      gateSkillKey: "ignored-when-gates-present",
      gates: [
        { kind: "practiceSkill", domain: "d", skillKey: "a", minReps: 3 },
        { kind: "observerSignal", signalType: "s" },
        { kind: "practiceSkill", domain: "d", skillKey: "b", minReps: 3 },
      ],
    };
    expect(gateSkillKeys(seed)).toEqual(["a", "b"]);
  });
});
