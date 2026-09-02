/**
 * gateEval — pure evaluation of a CrossDomainSeed's firing gates (roadmap §7 ①).
 *
 * A gate is a firing CONDITION: passing it ADDS a seed, it never restricts or
 * hides one. The legacy single `gateSkillKey` normalizes to ONE `practiceSkill`
 * gate so today's `MATH_CROSS_DOMAIN_SEEDS` fire identically; `gates[]` adds
 * multi-signal firing — cross-domain fluency + observer signals + already-
 * surfaced topics — combined with AND ("all", the default) or ANY ("any").
 *
 * PURE by design: the DB reads live in the caller (convex/practiceSkills.ts →
 * maybeFireSeeds), which gathers `GateFacts` once and passes them in. That keeps
 * this unit-testable and keeps query cost owned by the firing site.
 *
 * PRIVACY (roadmap §7): gates read teacher-authored data server-side, and the
 * `seeds` row that actually reaches a scholar/parent is already TIER_1 — so it's
 * teacher-data-in, scholar-safe-out. The one sharp edge is `topicMentioned`: it
 * must reveal NOTHING NEW about which sessions happened, so the caller's
 * `topicSurfaced` fact is limited to topics already surfaced for this scholar
 * (an existing seed), never the raw observer transcript.
 */

import type { CrossDomainSeed, SeedGate } from "./crossDomainSeeds";
import { FLUENT_REPS } from "./scheduler";
import { WHOLE_NUMBER_ARITHMETIC_DOMAIN } from "../../seed/wholeNumberArithmeticGraph";

/** The already-read, per-scholar facts a gate array is evaluated against. */
export type GateFacts = {
  /** Current repetition count for a (domain, skillKey) pair — 0 if none. */
  reps: (domain: string, skillKey: string) => number;
  /** Whether the scholar has an observer signal of this type on record. */
  hasSignal: (signalType: string) => boolean;
  /** Whether this topic is already surfaced for the scholar (the
   *  `topicMentioned` privacy limit — an existing seed reveals nothing new). */
  topicSurfaced: (topic: string) => boolean;
};

/** Normalize a seed's firing condition into the multi-signal gate array. A
 *  legacy `gateSkillKey`-only seed becomes one FLUENT practiceSkill gate. */
export function gatesForSeed(seed: CrossDomainSeed): { gates: SeedGate[]; mode: "any" | "all" } {
  if (seed.gates && seed.gates.length > 0) {
    return { gates: seed.gates, mode: seed.gateMode ?? "all" };
  }
  return {
    gates: [
      {
        kind: "practiceSkill",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: seed.gateSkillKey,
        minReps: FLUENT_REPS,
      },
    ],
    mode: "all",
  };
}

function gatePasses(gate: SeedGate, facts: GateFacts): boolean {
  switch (gate.kind) {
    case "practiceSkill":
      return facts.reps(gate.domain, gate.skillKey) >= gate.minReps;
    case "observerSignal":
      return facts.hasSignal(gate.signalType);
    case "topicMentioned":
      return facts.topicSurfaced(gate.topic);
    default:
      return false;
  }
}

/** Does this seed's gate array pass, given the scholar's current facts? */
export function evaluateGates(seed: CrossDomainSeed, facts: GateFacts): boolean {
  const { gates, mode } = gatesForSeed(seed);
  if (gates.length === 0) return false;
  return mode === "any"
    ? gates.some((g) => gatePasses(g, facts))
    : gates.every((g) => gatePasses(g, facts));
}

/** The practice skillKeys this seed's gates reference — the reverse index the
 *  firing site uses to pick candidate seeds when a skill advances. */
export function gateSkillKeys(seed: CrossDomainSeed): string[] {
  const keys: string[] = [];
  for (const g of gatesForSeed(seed).gates) {
    if (g.kind === "practiceSkill") keys.push(g.skillKey);
  }
  return keys;
}
