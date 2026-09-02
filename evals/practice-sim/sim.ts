import {
  ACCEL_CHAIN_WINDOW_MS,
  ACCEL_HALFLIFE_DAYS,
  ACCEL_SOURCE,
  DEFAULT_MAX_ACTIVE_STRANDS,
  DEFAULT_STRAND,
  isDemonstratedSource,
  FLUENT_REPS,
  HALFLIFE_GROWTH,
  HALFLIFE_LAPSE,
  MIN_HALFLIFE_DAYS,
  type GraphEdge,
  type NextPracticeOptions,
  type NextPracticeItem,
  type SkillState,
  accessProven,
  applyAttempt,
  computeFrontier,
  desiredRetentionTargets,
  latencyBaselineFromSkillMedians,
  nextPractice,
  retention,
  shouldAccelerate,
} from "../../convex/lib/practice/scheduler";
import {
  ancestorWeights,
  applyImplicitCredit,
  shouldSkipImplicitCredit,
} from "../../convex/lib/practice/implicitCredit";
import { buildSession } from "../../convex/lib/practice/session";
import { hasTemplate } from "../../convex/lib/practice/templates";
import {
  PLACEMENT_HALF_LIFE_DAYS,
  affectSafeFirstProbeIndex,
  gradeRank,
  nextStrandProbe,
  probeOutcomeFromKind,
  strandFrontier,
  strandOrders,
  type ProbeOutcome,
} from "../../convex/lib/practice/placement";
import {
  WHOLE_NUMBER_ARITHMETIC_DOMAIN,
  WHOLE_NUMBER_ARITHMETIC_EDGES,
  WHOLE_NUMBER_ARITHMETIC_SKILLS,
  type SeedSkill,
} from "../../convex/seed/wholeNumberArithmeticGraph";
import {
  FRACTION_ARITHMETIC_DOMAIN,
  FRACTION_ARITHMETIC_EDGES,
  FRACTION_ARITHMETIC_SKILLS,
} from "../../convex/seed/fractionArithmeticGraph";
import {
  PROBABILITY_DOMAIN,
  PROBABILITY_EDGES,
  PROBABILITY_SKILLS,
} from "../../convex/seed/probabilityGraph";

const DAY_MS = 86_400_000;
const START_MS = DAY_MS;
const GRADE_LABELS = ["K", "1", "2", "3", "4", "5", "6", "7", "8"] as const;
const GUESS_RATE = 0.05;
const SLIP_RATE = 0.08;
const DEFAULT_ITEMS_PER_DAY = 10;

// ── Simulated-scholar model (ground truth the engine is trying to estimate) ──
// A scholar's chance on an item has two INDEPENDENT parts:
//   • COMPETENCE — can they produce this skill at all, given their strand
//     ability vs the skill's grade? This is the asymptotic mastery ceiling
//     (never a function of the ENGINE's belief). On/below ability → high;
//     above ability → falls off.
//   • RECALL — do they still remember it right now? The TRUE forgetting curve.
//     First exposure rides on a fixed fresh-recall prior; a practiced skill
//     rides on its true retention, with a relearn-on-sight floor (they've seen
//     it before, so a decayed skill isn't a coin-flip from zero).
// know = competence × (RECALL_FLOOR + (1−RECALL_FLOOR)·recall). The old model
// multiplied EVERYTHING by a ~0.6 grade signal, capping even a perfectly-
// retained on-grade review at ~40% success — implausible for a real learner.
const COMPETENCE_FLOOR = 0.15;
const COMPETENCE_SPAN = 0.82;
const COMPETENCE_BIAS = 1.7;
const COMPETENCE_SLOPE = 1.3;
const RECALL_FLOOR = 0.4;
const FRESH_EXPOSURE_RECALL = 0.55;
// True forgetting: gentler and faster-consolidating than the engine's
// unvalidated model (engine grows half-life ×2.3/rep massed; the real kid
// retains between genuinely-spaced reviews). Because true memory decays SLOWER
// than the engine believes, reviews still succeed even when the engine (which
// targets only DUE_THRESHOLD=0.6 retention) serves them — which is what real
// review success (~60–85%) looks like, and surfaces as the engine slightly
// UNDER-predicting retention (the healthy "raise HALFLIFE_GROWTH" direction).
const TRUE_FIRST_HALFLIFE = 3.5;
const TRUE_FIRST_HALFLIFE_SPAN = 4.0;
const TRUE_GROWTH_MIN = 3.2;
const TRUE_GROWTH_SPAN = 1.2;
const TRUE_HALFLIFE_CAP = 180;
const TRUE_LAPSE = 0.6;
const TRUE_LAPSE_FLOOR = 1.0;
// Trust-upward placement credit means the scholar really can do it — seed a
// genuine (if undrilled) true memory so its confirmation-lane review reflects
// real knowledge, not a cold first-exposure guess (placement over-crediting in
// the sim otherwise dragged review success down).
const PLACEMENT_TRUE_HALFLIFE_MIN = 3;
const PLACEMENT_TRUE_HALFLIFE_SPAN = 5;

export type PracticeDomain =
  | typeof WHOLE_NUMBER_ARITHMETIC_DOMAIN
  | typeof FRACTION_ARITHMETIC_DOMAIN
  | typeof PROBABILITY_DOMAIN;

export type Lane = "frontier" | "review" | "confirmation" | "remediation" | "challenge";

export type CalibrationBucket = {
  bucket: "<0.6" | "0.6-0.75" | "0.75-0.9" | ">=0.9";
  attempts: number;
  predictedAvg: number;
  successRate: number;
};

export type DailyReviewShare = {
  day: number;
  served: number;
  reviewItems: number;
  reviewShare: number;
};

export type SimulationMetrics = {
  scenario: string;
  domain: PracticeDomain;
  days: number;
  scholars: number;
  seed: number;
  totalItems: number;
  offBandItemRate: number;
  reviewShareOverall: number;
  reviewShareByDay: DailyReviewShare[];
  calibration: CalibrationBucket[];
  reviewSuccessRate: number;
  timeToFrontierDays: {
    average: number | null;
    observed: number;
    possible: number;
  };
  itemsServedPerLane: Record<Lane, number>;
};

export type CompareResult = {
  base: SimulationMetrics;
  candidate: SimulationMetrics;
  deltas: Record<string, number | null>;
};

export type SimulationInput = {
  days?: number;
  scholars?: number;
  seed?: number;
  domain?: PracticeDomain;
  scenario?: keyof typeof SCENARIOS;
  itemsPerDay?: number;
};

type Scenario = {
  description: string;
  schedulerOptions: Partial<NextPracticeOptions>;
  legacyHalfLifeGrowth?: boolean;
  placementRing?: boolean;
  phase1Band?: boolean;
  /**
   * Harness-side approximation of the planned grade-band option. Reviews are
   * never filtered; only new frontier work above the scholar's true band is
   * suppressed. This lets scheduler PRs compare against a before/after candidate
   * before the real `NextPracticeOptions` grows grade-band fields.
   */
  gradeBandFrontier?: boolean;
  phase2RetentionTargets?: boolean;
  phase2SpeedGatedImplicitCredit?: boolean;
  phase2UpwardNegativeEvidence?: boolean;
};

export const SCENARIOS = {
  baseline: {
    description: "Pre-Phase-1 baseline: legacy full half-life growth, no grade band, unbounded placement.",
    schedulerOptions: {
      applyMixFloor: true,
      compressReviews: true,
      maxActiveStrands: DEFAULT_MAX_ACTIVE_STRANDS,
      confirmationLaneCap: 2,
    },
    legacyHalfLifeGrowth: true,
  },
  banded: {
    description: "Candidate grade-band approximation: baseline options plus frontier <= true ability + 1.",
    schedulerOptions: {
      applyMixFloor: true,
      compressReviews: true,
      maxActiveStrands: DEFAULT_MAX_ACTIVE_STRANDS,
      confirmationLaneCap: 2,
    },
    legacyHalfLifeGrowth: true,
    gradeBandFrontier: true,
  },
  phase1: {
    description: "Phase 1: retrievability-gated growth, grade-band challenge overflow, expanding-ring placement.",
    schedulerOptions: {
      applyMixFloor: true,
      compressReviews: true,
      compressFrontierReviews: false,
      maxActiveStrands: DEFAULT_MAX_ACTIVE_STRANDS,
      confirmationLaneCap: 2,
    },
    placementRing: true,
    phase1Band: true,
  },
  phase2: {
    description: "Phase 2: per-skill retention, speed-gated FIRe, upward negative evidence, frontier compression.",
    schedulerOptions: {
      applyMixFloor: true,
      compressReviews: true,
      maxActiveStrands: DEFAULT_MAX_ACTIVE_STRANDS,
      confirmationLaneCap: 2,
    },
    placementRing: true,
    phase1Band: true,
    phase2RetentionTargets: true,
    phase2SpeedGatedImplicitCredit: true,
    phase2UpwardNegativeEvidence: true,
  },
  review_heavy: {
    description: "Stress review pressure: no mix floor/compression and a wider confirmation lane.",
    schedulerOptions: {
      applyMixFloor: false,
      compressReviews: false,
      maxActiveStrands: DEFAULT_MAX_ACTIVE_STRANDS,
      confirmationLaneCap: 4,
    },
    legacyHalfLifeGrowth: true,
  },
} satisfies Record<string, Scenario>;

type DomainGraph = {
  domain: PracticeDomain;
  skills: Array<SeedSkill & { order: number }>;
  edges: GraphEdge[];
  skillKeys: string[];
  skillByKey: Map<string, SeedSkill & { order: number }>;
};

type MasteryRow = SkillState & {
  skillKey: string;
  strand?: string;
  source?: string;
  lastAttemptAt?: number;
  updatedAt: number;
  frontier?: boolean;
  accelStreak?: number;
  latencySamplesMs?: number[];
  latencyMedianMs?: number;
  lastAttemptCorrect?: boolean;
  lastAttemptLatencyMs?: number;
  frontierAdvancedAt?: number;
};

type TrueMemory = {
  reps: number;
  halfLifeDays: number;
  lastPracticedAt?: number;
};

type Scholar = {
  id: string;
  gradeOrdinal: number;
  gradeLabel: string;
  strandAbility: Map<string, number>;
  mastery: Map<string, MasteryRow>;
  trueMemory: Map<string, TrueMemory>;
  firstFrontierAdvanceByStrand: Map<string, number>;
};

type AttemptRecord = {
  day: number;
  scholarId: string;
  skillKey: string;
  strand: string;
  lane: Lane;
  skillGrade: number | null;
  abilityGrade: number;
  predictedRetention: number;
  correct: boolean;
  latencyMs: number;
};

type Rng = {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
};

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    int(min: number, max: number): number {
      return Math.floor(next() * (max - min + 1)) + min;
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error("Cannot pick from an empty array");
      return items[Math.floor(next() * items.length)];
    },
  };
}

export function loadPracticeDomain(domain: PracticeDomain): DomainGraph {
  const raw =
    domain === WHOLE_NUMBER_ARITHMETIC_DOMAIN
      ? { skills: WHOLE_NUMBER_ARITHMETIC_SKILLS, edges: WHOLE_NUMBER_ARITHMETIC_EDGES }
      : domain === FRACTION_ARITHMETIC_DOMAIN
        ? { skills: FRACTION_ARITHMETIC_SKILLS, edges: FRACTION_ARITHMETIC_EDGES }
        : { skills: PROBABILITY_SKILLS, edges: PROBABILITY_EDGES };
  const skills = raw.skills.map((skill, order) => ({ ...skill, order }));
  return {
    domain,
    skills,
    edges: raw.edges.map((edge) => ({ fromKey: edge.fromKey, toKey: edge.toKey })),
    skillKeys: skills.map((skill) => skill.skillKey),
    skillByKey: new Map(skills.map((skill) => [skill.skillKey, skill])),
  };
}

export function runSimulation(input: SimulationInput = {}): SimulationMetrics {
  const days = input.days ?? 28;
  const scholarCount = input.scholars ?? 20;
  const seed = input.seed ?? 7;
  const domain = input.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN;
  const scenarioName = input.scenario ?? "baseline";
  const scenario = SCENARIOS[scenarioName];
  if (!scenario) throw new Error(`Unknown scenario: ${scenarioName}`);

  const rng = createRng(seed);
  const graph = loadPracticeDomain(domain);
  const scholars = Array.from({ length: scholarCount }, (_, i) => makeScholar(i, graph, rng));

  for (const scholar of scholars) {
    runPlacement(scholar, graph, rng, START_MS, scenario);
  }

  const attempts: AttemptRecord[] = [];
  const itemsPerDay = input.itemsPerDay ?? DEFAULT_ITEMS_PER_DAY;

  for (let day = 1; day <= days; day++) {
    const dayStart = START_MS + day * DAY_MS;
    scholars.forEach((scholar, scholarIndex) => {
      const now = dayStart + scholarIndex * 30 * 60_000;
      const served = serveDay(scholar, graph, rng, now, day, itemsPerDay, scenario);
      attempts.push(...served);
    });
  }

  return summarize({
    attempts,
    scholars,
    graph,
    scenario: scenarioName,
    domain,
    days,
    seed,
  });
}

export function compareScenarios(
  input: Omit<SimulationInput, "scenario">,
  baseScenario: keyof typeof SCENARIOS = "baseline",
  candidateScenario: keyof typeof SCENARIOS = "banded",
): CompareResult {
  const base = runSimulation({ ...input, scenario: baseScenario });
  const candidate = runSimulation({ ...input, scenario: candidateScenario });
  return {
    base,
    candidate,
    deltas: {
      offBandItemRate: round(candidate.offBandItemRate - base.offBandItemRate),
      reviewShareOverall: round(candidate.reviewShareOverall - base.reviewShareOverall),
      reviewSuccessRate: round(candidate.reviewSuccessRate - base.reviewSuccessRate),
      totalItems: candidate.totalItems - base.totalItems,
      averageTimeToFrontierDays:
        candidate.timeToFrontierDays.average === null || base.timeToFrontierDays.average === null
          ? null
          : round(candidate.timeToFrontierDays.average - base.timeToFrontierDays.average),
    },
  };
}

function makeScholar(index: number, graph: DomainGraph, rng: Rng): Scholar {
  const strands = [...new Set(graph.skills.map((skill) => skill.strand ?? DEFAULT_STRAND))].sort();
  const domainShift =
    graph.domain === PROBABILITY_DOMAIN ? 5 : graph.domain === FRACTION_ARITHMETIC_DOMAIN ? 3 : 2;
  const base = clampOrdinal(domainShift + rng.int(-1, 2));
  const strandAbility = new Map<string, number>();
  for (const strand of strands) {
    strandAbility.set(strand, clampOrdinal(base + rng.int(-1, 2)));
  }
  return {
    id: `scholar-${String(index + 1).padStart(3, "0")}`,
    gradeOrdinal: base,
    gradeLabel: ordinalToGrade(base),
    strandAbility,
    mastery: new Map(),
    trueMemory: new Map(),
    firstFrontierAdvanceByStrand: new Map(),
  };
}

function runPlacement(scholar: Scholar, graph: DomainGraph, rng: Rng, now: number, scenario: Scenario): void {
  const orders = strandOrders(
    graph.skills.map((skill) => ({
      nodeKey: skill.skillKey,
      strand: skill.strand,
      order: skill.order,
    })),
    graph.edges,
  );
  for (const order of orders) {
    const firstProbeTarget = affectSafeFirstProbeIndex(order.orderedKeys, {
      gradeOf: (key) => graph.skillByKey.get(key)?.grade,
      scholarGrade: scholar.gradeLabel,
    });
    const outcomes: ProbeOutcome[] = [];
    while (true) {
      const probe = nextStrandProbe(order.orderedKeys, hasTemplate, outcomes, {
        firstProbeTarget,
        ...(scenario.placementRing
          ? {
              gradeOf: (key) => graph.skillByKey.get(key)?.grade,
              scholarGrade: scholar.gradeLabel,
            }
          : {}),
      });
      if (!probe) break;
      const skill = graph.skillByKey.get(probe.probeKey);
      if (!skill) break;
      const result = answerSkill(scholar, skill, rng, now + outcomes.length * 60_000);
      // The sim models placement by ABILITY with no explicit slip signal, so a
      // genuine miss reads as an honest "don't know" (caps immediately) — the
      // confirm-before-cap slip path is exercised by the unit tests, not here.
      outcomes.push(probeOutcomeFromKind(probe.probeKey, result.correct ? "correct" : "unknown"));
    }

    const frontier = strandFrontier(order.strand, order.orderedKeys, outcomes);
    for (const key of frontier.creditedKeys) {
      const skill = graph.skillByKey.get(key);
      scholar.mastery.set(key, {
        skillKey: key,
        strand: skill?.strand,
        repetition: FLUENT_REPS,
        halfLifeDays: PLACEMENT_HALF_LIFE_DAYS,
        lastPracticedAt: now,
        source: "placement",
        updatedAt: now,
        frontier: false,
      });
      // Seed a genuine (undrilled) TRUE memory for trust-upward credit, so a
      // confirmation-lane review of this skill reflects real knowledge rather
      // than a cold first-exposure guess. Placement answering may have written
      // a probe-derived memory already; the credit is the stronger signal.
      const competence = skill ? competenceFor(scholar, skill) : FRESH_EXPOSURE_RECALL;
      scholar.trueMemory.set(key, {
        reps: 1,
        halfLifeDays: PLACEMENT_TRUE_HALFLIFE_MIN + competence * PLACEMENT_TRUE_HALFLIFE_SPAN,
        lastPracticedAt: now,
      });
    }
    if (frontier.frontierKey && !scholar.mastery.has(frontier.frontierKey)) {
      const skill = graph.skillByKey.get(frontier.frontierKey);
      scholar.mastery.set(frontier.frontierKey, {
        skillKey: frontier.frontierKey,
        strand: skill?.strand,
        repetition: 0,
        halfLifeDays: 0,
        source: "placement",
        updatedAt: now,
        frontier: true,
      });
    }
  }
}

function serveDay(
  scholar: Scholar,
  graph: DomainGraph,
  rng: Rng,
  now: number,
  day: number,
  count: number,
  scenario: Scenario,
): AttemptRecord[] {
  const stateOf = (key: string): SkillState => stateFromRow(scholar.mastery.get(key));
  const inferredDueCredit = (key: string): boolean => {
    const row = scholar.mastery.get(key);
    return (
      row !== undefined &&
      !isDemonstratedSource(row.source) &&
      row.lastAttemptAt === undefined
    );
  };
  const strandOf = (key: string): string | undefined => graph.skillByKey.get(key)?.strand;
  const schedulerOptions: NextPracticeOptions = {
    ...scenario.schedulerOptions,
    strandOf,
    lastServedByStrand: lastServedByStrand(scholar, graph),
    inferredDueCredit,
  };
  if (scenario.phase2RetentionTargets) {
    const targets = desiredRetentionTargets(graph.skillKeys, graph.edges);
    schedulerOptions.retentionThresholdOf = (key) => targets.get(key);
  }
  if (scenario.phase1Band) {
    schedulerOptions.gradeOf = (key) => graph.skillByKey.get(key)?.grade;
    schedulerOptions.scholarBandCeiling = scholarBandCeiling(scholar, graph);
    schedulerOptions.bandCeilingOf = (key, baseCeiling) => {
      const strand = strandOf(key) ?? DEFAULT_STRAND;
      return hasAcceleratedCreditInStrand(scholar, graph, strand) ? baseCeiling + 1 : baseCeiling;
    };
  }
  const queue = nextPractice(graph.skillKeys, graph.edges, stateOf, now, count, {
    ...schedulerOptions,
  });
  const filteredQueue = (
    scenario.phase1Band ? queue.filter((item) => item.reason !== "challenge") : queue
  );
  const servedQueue = scenario.gradeBandFrontier
    ? filteredQueue.filter((item) => item.reason !== "new" || !isOffBand(scholar, graph, item.key))
    : filteredQueue;
  const sessionSeed = rng.int(1, 2_000_000_000);
  const items = buildSession(
    servedQueue.map((item) => ({
      key: item.key,
      label: graph.skillByKey.get(item.key)?.label ?? item.key,
    })),
    Math.min(count, servedQueue.length),
    sessionSeed,
  );

  const queueByKey = new Map(servedQueue.map((item) => [item.key, item]));
  const attempts: AttemptRecord[] = [];
  items.forEach((item, itemIndex) => {
    const queued = queueByKey.get(item.skillKey);
    const skill = graph.skillByKey.get(item.skillKey);
    if (!queued || !skill) return;
    const attemptNow = now + itemIndex * 60_000;
    const before = stateFromRow(scholar.mastery.get(item.skillKey));
    const predictedRetention = retention(before, attemptNow);
    const lane = laneFor(queued, inferredDueCredit);
    const answer = answerSkill(scholar, skill, rng, attemptNow);
    recordAttempt(scholar, graph, skill, answer.correct, answer.latencyMs, attemptNow, day, scenario);
    attempts.push({
      day,
      scholarId: scholar.id,
      skillKey: item.skillKey,
      strand: skill.strand ?? DEFAULT_STRAND,
      lane,
      skillGrade: gradeOrdinal(skill.grade),
      abilityGrade: abilityFor(scholar, skill),
      predictedRetention: round(predictedRetention),
      correct: answer.correct,
      latencyMs: Math.round(answer.latencyMs),
    });
  });
  return attempts;
}

function recordAttempt(
  scholar: Scholar,
  graph: DomainGraph,
  skill: SeedSkill,
  correct: boolean,
  latencyMs: number,
  now: number,
  day: number,
  scenario: Scenario,
): void {
  const skillKey = skill.skillKey;
  const existing = scholar.mastery.get(skillKey);
  const prev = stateFromRow(existing);
  const retentionTargets = scenario.phase2RetentionTargets
    ? desiredRetentionTargets(graph.skillKeys, graph.edges)
    : undefined;
  const retentionThreshold = retentionTargets?.get(skillKey);
  const next = scenario.legacyHalfLifeGrowth
    ? legacyApplyAttempt(prev, correct, now)
    : applyAttempt(prev, correct, now, retentionThreshold);
  const preMastery = new Map(scholar.mastery);
  const preStateOf = (key: string): SkillState => stateFromRow(preMastery.get(key));
  const preFrontier = new Set(computeFrontier(graph.skillKeys, graph.edges, preStateOf));
  const directPrereqs = graph.edges.filter((edge) => edge.toKey === skillKey).map((edge) => edge.fromKey);
  const prereqAcceleratedRecently = directPrereqs.some((key) => {
    const row = preMastery.get(key);
    return row?.source === ACCEL_SOURCE && now - row.updatedAt < ACCEL_CHAIN_WINDOW_MS;
  });
  const baseline = latencyBaselineFromSkillMedians(
    [...preMastery.values()].map((row) => row.latencyMedianMs ?? Number.NaN),
  );
  const nextAccelStreak = correct ? (existing?.accelStreak ?? 0) + 1 : 0;
  const accelerate = shouldAccelerate({
    correct,
    prevRepetition: prev.repetition,
    nextAccelStreak,
    isFrontierNode: preFrontier.has(skillKey),
    prereqAcceleratedRecently,
    isFast: baseline !== undefined && latencyMs <= baseline,
  });
  const written: SkillState = accelerate
    ? { repetition: FLUENT_REPS, halfLifeDays: ACCEL_HALFLIFE_DAYS, lastPracticedAt: now }
    : next;
  const writtenSource = accelerate ? ACCEL_SOURCE : correct ? "practice" : (existing?.source ?? "practice");
  const wasAccess = existing ? accessProven(existing) : false;
  const advancedFrontier = !wasAccess && accessProven(written);
  const latencyUpdate = correct ? nextLatencyStats(existing?.latencySamplesMs, latencyMs) : {};

  scholar.mastery.set(skillKey, {
    ...(existing ?? {
      skillKey,
      strand: skill.strand,
      frontier: false,
    }),
    ...written,
    source: writtenSource,
    updatedAt: now,
    lastAttemptAt: now,
    lastAttemptCorrect: correct,
    lastAttemptLatencyMs: latencyMs,
    accelStreak: nextAccelStreak,
    ...(advancedFrontier ? { frontierAdvancedAt: now } : {}),
    ...latencyUpdate,
  });

  if (advancedFrontier) {
    const strand = skill.strand ?? DEFAULT_STRAND;
    if (!scholar.firstFrontierAdvanceByStrand.has(strand)) {
      scholar.firstFrontierAdvanceByStrand.set(strand, day);
    }
  }

  if (!correct && scenario.phase2UpwardNegativeEvidence) {
    const directDependents = new Set(
      graph.edges.filter((edge) => edge.fromKey === skillKey).map((edge) => edge.toKey),
    );
    for (const dependentKey of directDependents) {
      const row = preMastery.get(dependentKey);
      if (!row) continue;
      if (isDemonstratedSource(row.source)) continue;
      if (row.lastAttemptAt !== undefined) continue;
      const current = scholar.mastery.get(dependentKey);
      if (!current) continue;
      scholar.mastery.set(dependentKey, {
        ...current,
        halfLifeDays: Math.max(MIN_HALFLIFE_DAYS, current.halfLifeDays * HALFLIFE_LAPSE),
      });
    }
  }

  if (correct) {
    for (const [ancestorKey, weight] of ancestorWeights(skillKey, graph.edges)) {
      const row = preMastery.get(ancestorKey);
      if (!row || row.repetition < 1 || row.lastPracticedAt === undefined) continue;
      if (
        scenario.phase2SpeedGatedImplicitCredit &&
        shouldSkipImplicitCredit(
          row.lastAttemptCorrect === undefined
            ? undefined
            : { correct: row.lastAttemptCorrect, firstKeyMs: row.lastAttemptLatencyMs },
          baseline,
        )
      ) {
        continue;
      }
      const credited = applyImplicitCredit(stateFromRow(row), weight, now);
      const current = scholar.mastery.get(ancestorKey);
      if (!current) continue;
      scholar.mastery.set(ancestorKey, {
        ...current,
        halfLifeDays: credited.halfLifeDays,
        lastPracticedAt: credited.lastPracticedAt,
      });
      // Mirror the refresh into TRUE memory: correctly answering a downstream
      // skill genuinely exercises its prerequisite, so the prereq's real recall
      // refreshes too. Without this the engine's FIRe credit lifts predicted
      // retention to ~1 while the true memory stays stale — the exact split
      // that produced a nonsensical ">=0.9 predicted, ~50% observed" bucket.
      const trueMem = scholar.trueMemory.get(ancestorKey);
      if (trueMem && trueMem.reps > 0 && trueMem.lastPracticedAt !== undefined) {
        const creditedTrue = applyImplicitCredit(
          { repetition: trueMem.reps, halfLifeDays: trueMem.halfLifeDays, lastPracticedAt: trueMem.lastPracticedAt },
          weight,
          now,
        );
        scholar.trueMemory.set(ancestorKey, {
          reps: trueMem.reps,
          halfLifeDays: creditedTrue.halfLifeDays,
          lastPracticedAt: creditedTrue.lastPracticedAt ?? now,
        });
      }
    }
  }
}

function competenceFor(scholar: Scholar, skill: SeedSkill): number {
  const skillGrade = gradeOrdinal(skill.grade) ?? scholar.gradeOrdinal;
  const ability = abilityFor(scholar, skill);
  return clamp01(
    COMPETENCE_FLOOR +
      COMPETENCE_SPAN * logistic((ability - skillGrade + COMPETENCE_BIAS) * COMPETENCE_SLOPE),
  );
}

function answerSkill(
  scholar: Scholar,
  skill: SeedSkill,
  rng: Rng,
  now: number,
): { correct: boolean; latencyMs: number } {
  const skillGrade = gradeOrdinal(skill.grade) ?? scholar.gradeOrdinal;
  const ability = abilityFor(scholar, skill);
  const competence = competenceFor(scholar, skill);
  const memory = scholar.trueMemory.get(skill.skillKey);
  const practiced = memory !== undefined && memory.reps > 0;
  // RECALL: true retention for a practiced skill, else a fixed fresh-exposure
  // prior. COMPETENCE is the ceiling; recall scales it, with a relearn floor.
  const recall = practiced ? trueRetentionAt(memory!, now) : FRESH_EXPOSURE_RECALL;
  const know = clamp01(competence * (RECALL_FLOOR + (1 - RECALL_FLOOR) * recall));
  const pCorrect = clamp01(GUESS_RATE + (1 - GUESS_RATE - SLIP_RATE) * know);
  const correct = rng.next() < pCorrect;
  const difficulty = Math.max(0, skillGrade - ability);
  const hesitation = correct ? 1 - recall : 1.25;
  const latencyMs = Math.max(
    450,
    1_000 + difficulty * 650 + hesitation * 1_100 + (rng.next() - 0.5) * 420,
  );

  // Advance the TRUE memory (ground truth). Consolidation scales with
  // competence: a skill within reach sticks; a stretch skill barely does.
  const prev = memory ?? { reps: 0, halfLifeDays: 0 };
  const nextHalfLife = correct
    ? prev.halfLifeDays <= 0
      ? TRUE_FIRST_HALFLIFE + competence * TRUE_FIRST_HALFLIFE_SPAN
      : Math.min(TRUE_HALFLIFE_CAP, prev.halfLifeDays * (TRUE_GROWTH_MIN + competence * TRUE_GROWTH_SPAN))
    : Math.max(TRUE_LAPSE_FLOOR, (prev.halfLifeDays || TRUE_FIRST_HALFLIFE) * TRUE_LAPSE);
  scholar.trueMemory.set(skill.skillKey, {
    reps: prev.reps + (correct ? 1 : 0),
    halfLifeDays: nextHalfLife,
    lastPracticedAt: now,
  });

  return { correct, latencyMs };
}

function summarize(opts: {
  attempts: AttemptRecord[];
  scholars: Scholar[];
  graph: DomainGraph;
  scenario: string;
  domain: PracticeDomain;
  days: number;
  seed: number;
}): SimulationMetrics {
  const { attempts, scholars, graph, scenario, domain, days, seed } = opts;
  const laneCounts: Record<Lane, number> = {
    frontier: 0,
    review: 0,
    confirmation: 0,
    remediation: 0,
    challenge: 0,
  };
  for (const attempt of attempts) laneCounts[attempt.lane] += 1;
  const reviewAttempts = attempts.filter((attempt) => attempt.lane === "review" || attempt.lane === "confirmation");
  const reviewCorrect = reviewAttempts.filter((attempt) => attempt.correct).length;
  const offBand = attempts.filter(
    (attempt) => attempt.skillGrade !== null && attempt.skillGrade > attempt.abilityGrade + 1,
  ).length;
  const byDay: DailyReviewShare[] = [];
  for (let day = 1; day <= days; day++) {
    const dayAttempts = attempts.filter((attempt) => attempt.day === day);
    const reviewItems = dayAttempts.filter(
      (attempt) => attempt.lane === "review" || attempt.lane === "confirmation",
    ).length;
    byDay.push({
      day,
      served: dayAttempts.length,
      reviewItems,
      reviewShare: ratio(reviewItems, dayAttempts.length),
    });
  }
  const frontierDays = scholars.flatMap((scholar) => {
    const strands = new Set(graph.skills.map((skill) => skill.strand ?? DEFAULT_STRAND));
    return [...strands].map((strand) => scholar.firstFrontierAdvanceByStrand.get(strand));
  });
  const observedFrontierDays = frontierDays.filter((day): day is number => day !== undefined);

  return {
    scenario,
    domain,
    days,
    scholars: scholars.length,
    seed,
    totalItems: attempts.length,
    offBandItemRate: ratio(offBand, attempts.length),
    reviewShareOverall: ratio(reviewAttempts.length, attempts.length),
    reviewShareByDay: byDay,
    calibration: calibration(attempts),
    reviewSuccessRate: ratio(reviewCorrect, reviewAttempts.length),
    timeToFrontierDays: {
      average:
        observedFrontierDays.length === 0
          ? null
          : round(observedFrontierDays.reduce((sum, day) => sum + day, 0) / observedFrontierDays.length),
      observed: observedFrontierDays.length,
      possible: frontierDays.length,
    },
    itemsServedPerLane: laneCounts,
  };
}

function calibration(attempts: AttemptRecord[]): CalibrationBucket[] {
  const reviewAttempts = attempts.filter(
    (attempt) => attempt.lane === "review" || attempt.lane === "confirmation",
  );
  const defs: Array<{ bucket: CalibrationBucket["bucket"]; test: (r: number) => boolean }> = [
    { bucket: "<0.6", test: (r) => r < 0.6 },
    { bucket: "0.6-0.75", test: (r) => r >= 0.6 && r < 0.75 },
    { bucket: "0.75-0.9", test: (r) => r >= 0.75 && r < 0.9 },
    { bucket: ">=0.9", test: (r) => r >= 0.9 },
  ];
  return defs.map(({ bucket, test }) => {
    const rows = reviewAttempts.filter((attempt) => test(attempt.predictedRetention));
    return {
      bucket,
      attempts: rows.length,
      predictedAvg: ratio(
        rows.reduce((sum, row) => sum + row.predictedRetention, 0),
        rows.length,
      ),
      successRate: ratio(rows.filter((row) => row.correct).length, rows.length),
    };
  });
}

function stateFromRow(row: MasteryRow | undefined): SkillState {
  return row
    ? {
        repetition: row.repetition,
        halfLifeDays: row.halfLifeDays,
        lastPracticedAt: row.lastPracticedAt,
      }
    : { repetition: 0, halfLifeDays: 0 };
}

function laneFor(item: NextPracticeItem, inferredDueCredit: (key: string) => boolean): Lane {
  if (item.reason === "challenge") return "challenge";
  if (item.reason === "new") return "frontier";
  if (item.reason === "remediation") return "remediation";
  return inferredDueCredit(item.key) ? "confirmation" : "review";
}

function legacyApplyAttempt(prev: SkillState, correct: boolean, now: number): SkillState {
  if (correct) {
    return {
      repetition: prev.repetition + 1,
      halfLifeDays: prev.halfLifeDays <= 0 ? 1 : prev.halfLifeDays * HALFLIFE_GROWTH,
      lastPracticedAt: now,
    };
  }
  return {
    repetition: prev.repetition,
    halfLifeDays: Math.max(MIN_HALFLIFE_DAYS, prev.halfLifeDays * HALFLIFE_LAPSE),
    lastPracticedAt: now,
  };
}

function scholarBandCeiling(scholar: Scholar, graph: DomainGraph): number | undefined {
  const demonstrated = maxMasteryGrade(scholar, graph, (row) =>
    isDemonstratedSource(row.source) && accessProven(row),
  );
  const access = maxMasteryGrade(scholar, graph, accessProven);
  const base = demonstrated ?? access ?? scholar.gradeOrdinal;
  return base === undefined ? undefined : base + 1;
}

function maxMasteryGrade(
  scholar: Scholar,
  graph: DomainGraph,
  include: (row: MasteryRow) => boolean,
): number | undefined {
  let max: number | undefined;
  for (const row of scholar.mastery.values()) {
    if (!include(row)) continue;
    const skill = graph.skillByKey.get(row.skillKey);
    const ordinal = gradeOrdinal(skill?.grade);
    if (ordinal === null) continue;
    if (max === undefined || ordinal > max) max = ordinal;
  }
  return max;
}

function hasAcceleratedCreditInStrand(scholar: Scholar, graph: DomainGraph, strand: string): boolean {
  for (const row of scholar.mastery.values()) {
    const rowStrand = row.strand ?? graph.skillByKey.get(row.skillKey)?.strand ?? DEFAULT_STRAND;
    if (rowStrand === strand && row.source === ACCEL_SOURCE && accessProven(row)) return true;
  }
  return false;
}

function lastServedByStrand(scholar: Scholar, graph: DomainGraph): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of scholar.mastery.values()) {
    const strand = row.strand ?? graph.skillByKey.get(row.skillKey)?.strand ?? DEFAULT_STRAND;
    const prev = out.get(strand);
    if (prev === undefined || row.updatedAt > prev) out.set(strand, row.updatedAt);
  }
  return out;
}

function nextLatencyStats(
  previous: number[] | undefined,
  sample: number,
): { latencySamplesMs: number[]; latencyMedianMs: number } {
  const samples = [...(previous ?? []), sample].slice(-7);
  return {
    latencySamplesMs: samples,
    latencyMedianMs: median(samples),
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function trueRetentionAt(memory: TrueMemory, now: number): number {
  if (memory.reps <= 0) return 1;
  if (memory.lastPracticedAt === undefined || memory.halfLifeDays <= 0) return 0;
  const days = (now - memory.lastPracticedAt) / DAY_MS;
  return days <= 0 ? 1 : Math.pow(2, -days / memory.halfLifeDays);
}

function isOffBand(scholar: Scholar, graph: DomainGraph, key: string): boolean {
  const skill = graph.skillByKey.get(key);
  const skillGrade = skill ? gradeOrdinal(skill.grade) : null;
  return skillGrade !== null && skill !== undefined && skillGrade > abilityFor(scholar, skill) + 1;
}

function abilityFor(scholar: Scholar, skill: SeedSkill): number {
  return scholar.strandAbility.get(skill.strand ?? DEFAULT_STRAND) ?? scholar.gradeOrdinal;
}

function gradeOrdinal(grade: string | undefined): number | null {
  if (!grade) return null;
  const ranked = gradeRank(grade);
  return ranked >= 0 ? ranked : null;
}

function ordinalToGrade(ordinal: number): string {
  return GRADE_LABELS[clampOrdinal(ordinal)];
}

function clampOrdinal(value: number): number {
  return Math.max(0, Math.min(8, value));
}

function logistic(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
