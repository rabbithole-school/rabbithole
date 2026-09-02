/**
 * Homegrown practice engine — Convex surface. Discipline-agnostic (math is the
 * first domain, not the only one).
 *
 * Seeds + reads our own prerequisite knowledge graph (the canonical
 * `knowledgeNodes` + `knowledgeNodeEdges` tables) and the per-scholar mastery it
 * produces (`practiceMastery`),
 * and records practice attempts through the spaced-repetition scheduler. This is
 * a replacement for external practice sites: the Skills › Math lens reads THIS instead of a
 * scrape. Pure logic lives in convex/lib/practice/*; this file is the
 * thin Convex wiring (auth + persistence). See review/practice/.
 */

import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation, internalQuery, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { authedQuery, authedMutation, teacherQuery } from "./lib/customFunctions";
import { requireTeacherOrSelf } from "./lib/auth";
import { requireActiveScholarAccess } from "./lib/access";
import {
  hasScholarMembership,
  requireActiveLearnerInstitution,
} from "./lib/scholarEnrollment";
import type { Doc, Id } from "./_generated/dataModel";
import {
  applyAttempt,
  computeFrontier,
  isDue,
  dueAt,
  nextPractice,
  proficiencyFromReps,
  retentionLabel,
  retention,
  FLUENT_REPS,
  isProvisional,
  isFluent,
  accessProven,
  shouldAccelerate,
  latencyBaselineFromSkillMedians,
  shouldOfferReprobe,
  REPROBE_STRAND_ACCEL,
  REPROBE_SOURCE,
  ACCEL_HALFLIFE_DAYS,
  ACCEL_SOURCE,
  ACCEL_CHAIN_WINDOW_MS,
  DEFAULT_STRAND,
  DEFAULT_MAX_ACTIVE_STRANDS,
  isDemonstratedSource,
  SCAFFOLDED_SOURCE,
  gradeOrdinal,
  gradeBandCeiling,
  desiredRetentionTargets,
  HALFLIFE_LAPSE,
  MIN_HALFLIFE_DAYS,
  type GraphEdge,
  type SkillState,
  type NextPracticeOptions,
  type NextPracticeReason,
} from "./lib/practice/scheduler";
import { confidenceValue, type ConfidenceLevel } from "./lib/practice/calibration";
import { generateSet } from "./lib/practice/templates";
import { buildSession, type ServedItem } from "./lib/practice/session";
import {
  buildTemplateServable,
  buildStoredServable,
  gradeSubmission,
  PRACTICE_POLICY,
  PLACEMENT_POLICY,
  GRADE_ONLY_POLICY,
  STORY_THREAD_POLICY,
  type ServableItem,
  type Submission,
} from "./lib/practice/servable";
import {
  applyAnswerFormatFade,
  serveItems,
  servedItemFromServable,
  SESSION_POLICY,
} from "./lib/practice/serve";
import { STRETCH_DIALOGUE_EVIDENCE_TYPE } from "./lib/practice/dialogueStretch";
import {
  APPLICATION_EVIDENCE_TYPE,
  eligibleStoryApplication,
  isOptionalDepthItemEligible,
} from "./lib/practice/applicationEligibility";
import { composeSegments, type Segment, type ComposeSegmentsOptions } from "./lib/practice/segments";
import { nextFactFluencyFields } from "./lib/practice/factFluency";
import {
  buildFactSprint,
  buildQuickFactsPractice,
  type SprintFamily,
  type SprintFactRow,
} from "./lib/practice/factSprint";
import { scholarLatencyBaseline } from "./lib/practice/scholarLatencyBaseline";
import { nextLatencyStats } from "./lib/practice/latencyStats";
import {
  FACT_FAMILY_SKILLS,
  factBelongsToFamily,
  factKeyFromOperands,
  isFactFamilySkill,
} from "../shared/factKey";
import { applyFade, clampFadeLevel, deriveStepHint, scaffoldLevelFor } from "./lib/practice/fadedSteps";
import {
  strandInstructionKey,
  nodeInstructionKey,
  instructionOfferId,
  TRY_FIRST_LABEL,
  SHOW_ME_LABEL,
  type InstructionAtom,
  type InstructionEntry,
  selectRunLaunchpad,
  type InstructionEventLike,
  type RunItemLike,
} from "./lib/practice/instructionEntries";
import {
  gameBeatOfferId,
  selectRunGameBeat,
  type GameBeatEntry,
  type GameBindingLike,
  type GameOfferLike,
  type RunGameBeat,
} from "./lib/practice/gameBeats";
import { verifyCandidate } from "./lib/practice/verify";
import {
  isRetiredManipulativeSpecId,
  MANIPULATIVE_ANSWER_TYPE,
  MANIPULATIVE_VERIFIER_KIND,
} from "../lib/manipulative/practiceContract";
import type { ManipulativeSpec } from "../lib/manipulative/types";
import { isCurrentManipulativeKind } from "../lib/manipulative/types";
import { assertGradableManipulative } from "../lib/manipulative/authoring";
import { parseManipulativeSpec, redactManipulativeSpecForClient } from "../lib/manipulative/grade";
import { goalText as manipulativeGoalText, describeState as describeManipulativeState } from "../lib/manipulative/logic";
import { MATH_CROSS_DOMAIN_SEEDS } from "./lib/practice/crossDomainSeeds";
import { evaluateGates, gateSkillKeys, type GateFacts } from "./lib/practice/gateEval";
import { handleSeedSpawn } from "./lib/practice/seedSpawn";
import {
  gradeRank,
  strandOrders,
  nextStrandProbe,
  strandFrontier,
  affectSafeFirstProbeIndex,
  domainHasAffectSafeEntry,
  domainFloorGrade,
  probeOutcomeFromKind,
  outcomeCredits,
  higherGrade,
  PLACEMENT_HALF_LIFE_DAYS,
  DEFAULT_PLACEMENT_STRAND,
  sanitizePlacementAnswer,
  sanitizeStemSnapshot,
  automaticPlacementGrade,
  type ProbeOutcome,
  type StrandOrder,
  type PlacementOutcomeKind,
} from "./lib/practice/placement";
import {
  PLACEMENT_GLOBAL_CAP,
  MAPPING_SIT_CAP,
  placementQuestionCap,
  PRACTICE_SESSION_SIZE,
  CHECK_IN_SITTING_PROBE_BUDGET,
  placementFeedback,
} from "../shared/practiceLoop";
import { recordedBreakerLifecycleOperations } from "../shared/practiceLifecycleRetry";
import { generateItem, hasTemplate } from "./lib/practice/templates";
import {
  formatAnswerForDisplay,
  formatUnit,
  parseAnswer,
} from "./lib/practice/answers";
import { expressionAnswerSignals } from "./lib/practice/answerShape";
import { buildPlacementRevealLine, verifyRevealLine, extractNumbers } from "./lib/practice/revealLine";
import { makeItemId, parseItemId, canonicalItemIdentity } from "./lib/practice/session";
import { promptVisualValidator } from "./lib/practice/promptVisual";
import { classifyError } from "./lib/practice/errorPatterns";
import type { ErrorPattern } from "./lib/practice/errorPatterns";
import {
  reconcileProblemSetDispatchCompletions,
  type DispatchCompleted,
} from "./lib/practice/dispatchCompletion";
import {
  ancestorWeights,
  applyImplicitCredit,
  shouldSkipImplicitCredit,
  type ImplicitCreditAttemptSignal,
} from "./lib/practice/implicitCredit";
import { pickFlaggedNode, pickRemediationTarget } from "./lib/practice/remediation";
import {
  openErrorPatterns,
  type OpenErrorPattern,
  PATTERN_PHRASING,
} from "./lib/practice/errorFlags";
import {
  WHOLE_NUMBER_ARITHMETIC_DOMAIN,
} from "./seed/wholeNumberArithmeticGraph";
import { FRACTION_ARITHMETIC_DOMAIN } from "./seed/fractionArithmeticGraph";
import { PROBABILITY_DOMAIN } from "./seed/probabilityGraph";
import { GEOMETRY_MEASUREMENT_DOMAIN } from "./seed/geometryMeasurementGraph";
import { RATIO_PROPORTION_PERCENT_DOMAIN } from "./seed/ratioProportionPercentGraph";
import { EARLY_ALGEBRA_DOMAIN } from "./seed/earlyAlgebraGraph";
import { INTEGERS_COORDINATES_DOMAIN } from "./seed/integersCoordinatesGraph";
import { ALGEBRA_1_DOMAIN } from "./seed/algebra1Graph";
import {
  rebuildPracticeNodes,
  REGISTERED_PRACTICE_DOMAINS,
  DOMAIN_REACHABILITY_STATIC,
  ELECTIVE_PRACTICE_DOMAINS,
} from "./knowledgeNodes";
import { PRACTICE_DOMAINS, practiceDomainLabel, checkInDomainPriority } from "./lib/practice/domains";
import { practicePrereqConcept } from "../shared/practiceDomainLabels";
import { FAST_MATH_NAME } from "../shared/fastMathName";
import { pickStartingSkillLabel } from "../shared/placementResultCopy";
import { dayKeyForTimezone } from "../shared/institutionDay";
import { timeZoneForScholar } from "./lib/institutionTime";
import { mergeDomainQueues, roundRobin } from "./lib/practice/mixedQueue";
import {
  planMappingBand,
  orderMappingCandidates,
  type MappingCandidate,
} from "./lib/practice/mapping";
import {
  summarizeDomainMap,
  domainMayServe,
  isMappedPlacementStatus,
  type DomainMapEntry,
  type ScholarMapSummary,
} from "./lib/practice/domainMapStatus";
import { ROLES } from "./lib/roles";
import { hasMarkdownFormatting } from "./lib/practice/plainText";
import { hintForSkill } from "../lib/mathPracticeHints";
import { computeNewReveals, computeVisibleKeys } from "./lib/practice/reveals";
import {
  breakerMissStreakAttempts,
  breakerFlowFromLifecycle,
  isBreakerCountedAttempt,
  pickRecoverySkill,
  projectBreakerEpisode,
  SPIRAL_GAP_MS,
  SPIRAL_MISS_THRESHOLD,
  SPIRAL_SCAN_LIMIT,
} from "./lib/practice/spiralBreaker";
import {
  isAllDontKnowStreak,
  PRACTICE_ALERT_COMPOSE_DELAY_MS,
  shouldAlertOnStuckEpisode,
} from "./lib/practice/stuckAlertBody";
import {
  hintLadderRungAt,
  hintLadderStepCount,
  type HintLadderRung,
} from "../shared/hintLadder";
import {
  resolveScholarCoachContext,
} from "./lib/practice/handoff";
import {
  resolveEffectiveCheckpoint,
  type CheckpointTarget,
} from "./lib/practice/checkpointFocus";
import { domainClimb } from "./lib/practice/summits";
import {
  practiceScopeAllowsCheckpoint,
  practiceScopeAllowsDomain,
  practiceScopeAllowsNode,
  practiceScopeKey,
  resolvePracticeScope,
  type PracticeScope,
} from "./lib/practice/mathPlan";
// The Quick Facts sentinel is shared with the client's resume validation, so
// the stamp the server writes and the key the client compares against can
// never drift apart.
import { QUICK_FACTS_SCOPE_KEY } from "../shared/practiceResumeContract";

// An admission belongs to the just-finished practice moment, not a retroactive
// reinterpretation of durable learning history.
const SELF_REPORTED_HELP_WINDOW_MS = 30 * 60 * 1000;

// ── Seed: load the graph into the tables (idempotent) ─────────────────────

export const seedGraph = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Absorb the practice graph into the canonical node tables. Return the same
    // { skills, edges } shape existing callers + tests rely on.
    const { nodes, edges } = await rebuildPracticeNodes(ctx);
    return { skills: nodes, edges };
  },
});

// ── Shared read helpers ───────────────────────────────────────────────────

async function loadDomain(ctx: QueryCtx | MutationCtx, domain: string) {
  // Read the canonical node tables, but SHIM the result back to the skillKey-
  // shaped objects the rest of this file (and its callers) already read.
  const nodes = await ctx.db
    .query("knowledgeNodes")
    .withIndex("by_domain", (q) => q.eq("domain", domain))
    .collect();
  const skills = nodes.map((n) => ({
    skillKey: n.nodeKey,
    label: n.label,
    domain: n.domain,
    strand: n.strand,
    grade: n.grade,
    standardCodes: n.standardCodes,
    order: n.order,
    rationale: n.rationale,
  }));
  // Only the directional prerequisite ("buildsOn") edges drive the frontier;
  // the shared edge table may also hold bridge/explicit (Sky) links and
  // INFERENCE-ONLY ("implies") edges. `edges` is the GATING set (buildsOn) used
  // by the frontier gate + prereq recommendations; `impliesEdges` is the
  // INFERENCE-ONLY set, combined with `edges` only by the two inference consumers
  // (implicit-credit propagation + placement inference) — never by gating.
  const edgeRows = await ctx.db
    .query("knowledgeNodeEdges")
    .withIndex("by_domain", (q) => q.eq("domain", domain))
    .collect();
  const edges = edgeRows
    .filter((e) => e.kind === "buildsOn")
    .map((e) => ({ fromKey: e.fromKey, toKey: e.toKey, domain: e.domain, weight: e.weight }));
  const impliesEdges = edgeRows
    .filter((e) => e.kind === "implies")
    .map((e) => ({ fromKey: e.fromKey, toKey: e.toKey, domain: e.domain, weight: e.weight }));
  return { skills, edges, impliesEdges };
}

async function loadMastery(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  domain: string,
): Promise<Map<string, Doc<"practiceMastery">>> {
  const rows = await ctx.db
    .query("practiceMastery")
    .withIndex("by_scholar_domain", (q) =>
      q.eq("scholarId", scholarId).eq("domain", domain),
    )
    .collect();
  return new Map(rows.map((r) => [r.skillKey, r]));
}

function scopeDomains(scope: PracticeScope): string[] {
  return scope.kind === "open"
    ? PRACTICE_DOMAINS.map(({ domain }) => domain)
    : scope.domains.map(({ domain }) => domain);
}

function defaultScopeDomain(scope: PracticeScope): string | undefined {
  return scope.kind === "open"
    ? WHOLE_NUMBER_ARITHMETIC_DOMAIN
    : scope.domains[0]?.domain;
}

function isScopeAllowedDomain(scope: PracticeScope, domain: string | undefined): domain is string {
  return domain !== undefined && practiceScopeAllowsDomain(scope, domain);
}

function scopeLoadedDomain<
  T extends { skillKey: string; domain: string; strand?: string },
>(scope: PracticeScope, domain: string, loaded: { skills: T[]; edges: GraphEdge[] }) {
  if (!practiceScopeAllowsDomain(scope, domain)) {
    return { skills: [] as T[], edges: [] as GraphEdge[] };
  }
  const skills = loaded.skills.filter((skill) =>
    practiceScopeAllowsNode(scope, skill.domain, skill.strand),
  );
  const allowed = new Set(skills.map((skill) => skill.skillKey));
  // Keep edges into allowed nodes, including foreign/out-of-scope prerequisites:
  // their existing evidence can open a gate, but the prerequisite is never served.
  return {
    skills,
    edges: loaded.edges.filter((edge) => allowed.has(edge.toKey)),
  };
}

function emptyPracticeSession(domain?: string, scopeKey?: string, dayKey?: string) {
  return {
    domain: domain ?? null,
    domains: domain ? [domain] : [],
    items: [] as ServedItem[],
    segments: [] as Segment[],
    launchpad: undefined,
    gameBeat: undefined,
    challenge: [] as ServedItem[],
    stretch: [] as ServedItem[],
    firstPostPlacementBlock: false,
    allMapping: false,
    mappingDomains: [] as string[],
    mappingProgressOffset: 0,
    blocked: true as const,
    scopeKey,
    dayKey,
  };
}

const ZERO: SkillState = { repetition: 0, halfLifeDays: 0 };

function stateFromRow(row: Doc<"practiceMastery"> | undefined): SkillState {
  return row
    ? { repetition: row.repetition, halfLifeDays: row.halfLifeDays, lastPracticedAt: row.lastPracticedAt }
    : ZERO;
}

/**
 * Start a direct Quick-facts-only round.
 *
 * This intentionally bypasses the opportunistic fact-sprint gates in
 * `practiceSession`: it does not need a scheduled fact-family skill, weak-fact
 * evidence, or the absence of a durable Calculator License. Its items are still
 * ordinary deterministic fact-family template items, so `submitAnswer` records
 * mastery and per-fact fluency through the normal practice path.
 *
 * `available: false` is deliberately narrow: it means the canonical generator
 * could not create a useful short round, not that the scholar is uncalibrated,
 * licensed, or lacks prior practice evidence.
 */
export const startQuickFactsPractice = authedQuery({
  args: {
    scholarId: v.id("users"),
    seed: v.number(),
    size: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) {
      await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    }
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) {
      throw new Error("Target user is not a scholar");
    }

    const [{ skills }, factRows, baseline] = await Promise.all([
      loadDomain(ctx, WHOLE_NUMBER_ARITHMETIC_DOMAIN),
      ctx.db
        .query("factFluency")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
        .collect(),
      scholarLatencyBaseline(ctx, args.scholarId),
    ]);
    const labelByKey = new Map(
      skills.map((skill) => [skill.skillKey, skill.label]),
    );
    const families: SprintFamily[] = [...FACT_FAMILY_SKILLS].map(
      (skillKey) => ({
        skillKey,
        label: labelByKey.get(skillKey) ?? FAST_MATH_NAME,
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
      }),
    );
    const rows: SprintFactRow[] = [];
    for (const row of factRows) {
      const family = families.find((candidate) =>
        factBelongsToFamily(row.factKey, candidate.skillKey),
      );
      if (!family) continue;
      rows.push({
        factKey: row.factKey,
        skillKey: family.skillKey,
        stats: {
          seenCount: row.seenCount,
          correctCount: row.correctCount,
          latencySamplesMs: row.latencySamplesMs,
          latencyMedianMs: row.latencyMedianMs,
        },
      });
    }
    const items = buildQuickFactsPractice({
      families,
      factRows: rows,
      baseline,
      seed: args.seed,
      maxItems: args.size,
    });
    const available = items.length > 0;
    return {
      domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
      domains: [WHOLE_NUMBER_ARITHMETIC_DOMAIN],
      items,
      segments: available
        ? [{ kind: "fact_sprint" as const, count: items.length }]
        : [],
      launchpad: undefined,
      gameBeat: undefined,
      challenge: [] as ServedItem[],
      stretch: [] as ServedItem[],
      firstPostPlacementBlock: false,
      allMapping: false,
      mappingDomains: [] as string[],
      mappingProgressOffset: 0,
      available,
      unavailableReason: available
        ? null
        : ("generator_unavailable" as const),
      // Quick Facts is scheduled from factFluency records rather than a
      // Math-plan scope, so it carries a fixed sentinel scopeKey — distinct
      // from every ordinary-domain scopeKey, so a Quick Facts snapshot can
      // never resume into an ordinary drill (or vice versa). dayKey still
      // tracks the real institution-local calendar day.
      scopeKey: QUICK_FACTS_SCOPE_KEY,
      dayKey: dayKeyForTimezone(
        Date.now(),
        await timeZoneForScholar(ctx, args.scholarId),
      ),
    };
  },
});

/**
 * Cross-domain frontier resolution (D4). A child practice domain may declare a
 * `buildsOn` edge whose `fromKey` is a node in ANOTHER domain — a FOREIGN
 * prerequisite (e.g. a whole-number skill gating a fraction skill, or a fraction
 * skill gating a probability skill). The edge is stamped with the child
 * (to-side) domain, so `loadDomain(child)` already returns it — but the child's
 * mastery map holds no row for the foreign key, so a naive
 * `stateFromRow(mastery.get(foreignKey))` reads ZERO ("never practiced") and the
 * cross-domain edge permanently LOCKS the child skill.
 *
 * This builds the `stateOf` that `computeFrontier` / `nextPractice` consume so a
 * foreign prereq key resolves against the scholar's mastery in the key's OWN
 * domain (`by_scholar_skill`, disambiguated by the node's real domain via
 * `by_nodeKey` in case a key is reused across domains). Own-domain keys still
 * read from the already-loaded `mastery` map. Only the handful of referenced
 * foreign keys are batch-loaded, so this is inert — zero extra reads — for a
 * self-contained domain whose edges never point out of domain.
 *
 * SCOPE (D4 policy, plan §3 — deliberately conservative): ONLY the frontier gate
 * is cross-domain aware. Remediation (`computeRemediationSkillKey`) and FIRe
 * implicit credit (`recordAttemptCore`) keep reading the domain-scoped `mastery`
 * map directly, so a child-domain miss never auto-serves a parent-domain
 * prerequisite (it can't — the parent skill has no item/template in the child
 * session) and correct child-domain work never writes credit back into a
 * parent-domain mastery row (which would silently mark a parent skill practiced
 * the scholar never drilled). Both are flagged as open questions in the PR.
 */
async function buildFrontierStateOf(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  ownKeys: Iterable<string>,
  edges: readonly { fromKey: string; toKey: string }[],
  mastery: Map<string, Doc<"practiceMastery">>,
  projectedStates: ReadonlyMap<string, SkillState> = new Map(),
): Promise<(key: string) => SkillState> {
  const own = ownKeys instanceof Set ? ownKeys : new Set(ownKeys);
  const foreignKeys = new Set<string>();
  for (const e of edges) if (!own.has(e.fromKey)) foreignKeys.add(e.fromKey);

  const foreign = new Map<string, SkillState>();
  for (const key of foreignKeys) {
    const node = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_nodeKey", (q) => q.eq("nodeKey", key))
      .first();
    const rows = await ctx.db
      .query("practiceMastery")
      .withIndex("by_scholar_skill", (q) =>
        q.eq("scholarId", scholarId).eq("skillKey", key),
      )
      .collect();
    const row = node ? (rows.find((r) => r.domain === node.domain) ?? rows[0]) : rows[0];
    if (row) foreign.set(key, stateFromRow(row));
  }

  return (key: string) => {
    const row = mastery.get(key);
    if (row) return stateFromRow(row);
    return foreign.get(key) ?? projectedStates.get(key) ?? ZERO;
  };
}

/**
 * Auto-remediation target (§5): the pinpointed prerequisite the engine should
 * serve automatically when a scholar has an open error-pattern flag, or
 * `undefined` to stand down. Shared by the adaptive serving queries
 * (`nextForScholar` / `practiceSession` whole-graph / `playlistForScholar`).
 *
 * It picks the most-recently-flagged node in this domain and that node's weakest
 * already-attempted prerequisite. Reads only existing tables; writes nothing.
 */
async function computeRemediationSkillKey(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  domain: string,
  mastery: Map<string, Doc<"practiceMastery">>,
  edges: GraphEdge[],
): Promise<string | undefined> {
  const now = Date.now();
  const events = await ctx.db
    .query("practiceErrorEvents")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  const inDomain = events.filter((e) => e.domain === domain);
  const flaggedNode = pickFlaggedNode(inDomain, now);
  if (flaggedNode === null) return undefined;
  const target = pickRemediationTarget(
    flaggedNode,
    edges,
    (k) => {
      const row = mastery.get(k);
      return row ? stateFromRow(row) : undefined;
    },
    now,
  );
  return target ?? undefined;
}

/**
 * Build the multi-strand scheduling inputs (roadmap §2) from the loaded domain
 * nodes + the scholar's mastery rows:
 *  - `strandOf` maps a skill to its strand (the node's denormalized `strand`);
 *  - `lastServedByStrand` is MAX(updatedAt) GROUP BY strand — the round-robin's
 *    "least-recently-served" signal (computed cheaply off the mastery rows,
 *    which carry a denormalized `strand`, falling back to the node's strand);
 * `hintStrand` (the scholar's optional "I want X today") is layered on by the
 * caller, and `excludedStrands` (a standing assignment's off-limits strands)
 * is threaded straight through to the scheduler. Unstranded nodes collapse to
 * the single default strand, so this degrades cleanly to the original
 * single-track behavior.
 */
function buildStrandScheduling(
  skills: { skillKey: string; strand?: string; grade?: string }[],
  edges: GraphEdge[],
  mastery: Map<string, Doc<"practiceMastery">>,
  scholarGrade?: string,
  hintStrand?: string,
  excludedStrands?: readonly string[],
  firstBlock?: FirstRequiredBlockScheduling,
  frontierAllowedStrands?: readonly string[],
  preferredCheckpoint?: CheckpointTarget,
): NextPracticeOptions {
  const strandByKey = new Map(skills.map((s) => [s.skillKey, s.strand]));
  const strandOf = (key: string): string | undefined => strandByKey.get(key);
  const gradeByKey = new Map(skills.map((s) => [s.skillKey, s.grade]));
  const gradeOf = (key: string): string | undefined => gradeByKey.get(key);
  const retentionTargets = desiredRetentionTargets(
    skills.map((s) => s.skillKey),
    edges,
  );
  const retentionThresholdOf = (key: string): number | undefined => retentionTargets.get(key);

  // Confirmation lane classifier (placement-v2): a due row is inferred credit
  // never genuinely attempted when its `source` is not demonstrated AND it
  // carries no real attempt stamp. `lastPracticedAt` is inflated by
  // placement/reprobe inserts, so it's NOT the honest signal — only
  // `recordAttemptCore` sets `lastAttemptAt` (see the practice-engine rules).
  // A placement row that was attempted-and-MISSED keeps `source: "placement"`
  // but now has `lastAttemptAt` set → treated as a demonstrated (sacred) due
  // review, exactly right. Threaded into `nextPractice` so the placement-flood
  // of easy due reviews is metered instead of crowding out frontier work.
  const inferredDueCredit = (key: string): boolean => {
    const row = mastery.get(key);
    return (
      row !== undefined &&
      !isDemonstratedSource(row.source) &&
      row.lastAttemptAt === undefined
    );
  };

  const lastServedByStrand = new Map<string, number>();
  const acceleratedStrands = new Set<string>();
  for (const row of mastery.values()) {
    const strand = row.strand ?? strandByKey.get(row.skillKey) ?? DEFAULT_STRAND;
    const prev = lastServedByStrand.get(strand);
    if (prev === undefined || row.updatedAt > prev) lastServedByStrand.set(strand, row.updatedAt);
    if (row.source === ACCEL_SOURCE && accessProven(row)) acceleratedStrands.add(strand);
  }
  const demonstratedGrade = maxMasteryGrade(mastery, gradeOf, (row) =>
    isDemonstratedSource(row.source) && accessProven(row),
  );
  const accessGrade = maxMasteryGrade(mastery, gradeOf, accessProven);
  const fallbackGrade = gradeOrdinal(scholarGrade);
  const scholarBandCeiling = gradeBandCeiling({
    demonstratedGrade,
    accessGrade,
    fallbackGrade,
    firstPostPlacementBlock: firstBlock?.active ?? false,
    placedThroughGrade: firstBlock?.placedThroughGrade,
  });
  const bandCeilingOf = (key: string, baseCeiling: number): number => {
    const strand = strandOf(key) ?? DEFAULT_STRAND;
    return acceleratedStrands.has(strand) ? baseCeiling + 1 : baseCeiling;
  };

  return {
    strandOf,
    lastServedByStrand,
    hintStrand,
    preferredCheckpoint,
    excludedStrands,
    frontierAllowedStrands,
    gradeOf,
    scholarBandCeiling,
    bandCeilingOf,
    requiredExcludedSkillKeys: firstBlock?.active ? firstBlock.requiredExcludedSkillKeys : undefined,
    calibrationSkillKeys: firstBlock?.active ? firstBlock.calibrationSkillKeys : undefined,
    inferredDueCredit,
    retentionThresholdOf,
    compressReviews: true,
    // A scholar hint surfaces an extra strand (roadmap §2: "the scholar can
    // manually surface a third") on top of the default 2-strand session cap.
    maxActiveStrands: hintStrand ? DEFAULT_MAX_ACTIVE_STRANDS + 1 : DEFAULT_MAX_ACTIVE_STRANDS,
  };
}

function maxMasteryGrade(
  mastery: Map<string, Doc<"practiceMastery">>,
  gradeOf: (key: string) => string | undefined,
  include: (row: Doc<"practiceMastery">) => boolean,
): number | undefined {
  let max: number | undefined;
  for (const row of mastery.values()) {
    if (!include(row)) continue;
    const ordinal = gradeOrdinal(gradeOf(row.skillKey));
    if (ordinal === undefined) continue;
    if (max === undefined || ordinal > max) max = ordinal;
  }
  return max;
}

type FirstRequiredBlockScheduling = {
  active: boolean;
  placedThroughGrade: string | null;
  requiredExcludedSkillKeys: ReadonlySet<string>;
  /** The required first-block fill: top credited placement skills when any exist,
   *  otherwise honest unmastered frontier foundations that have runnable items. */
  calibrationSkillKeys: readonly string[];
};

const INACTIVE_FIRST_BLOCK: FirstRequiredBlockScheduling = {
  active: false,
  placedThroughGrade: null,
  requiredExcludedSkillKeys: new Set(),
  calibrationSkillKeys: [],
};

/** Cap on the first-block calibration/foundation set. */
const FIRST_BLOCK_CALIBRATION_CAP = 6;

function isRequiredPracticeAttempt(row: Doc<"practiceAttempts">, domain: string): boolean {
  const rowDomain = row.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN;
  if (rowDomain !== domain) return false;
  return row.lane !== "placement" && row.lane !== "reprobe" && row.lane !== "tuneup";
}

function placedThroughGradeFromMastery(
  mastery: Map<string, Doc<"practiceMastery">>,
  skills: { skillKey: string; grade?: string }[],
): string | null {
  const credited = new Set<string>();
  for (const row of mastery.values()) {
    if (row.source === "placement" && !row.frontier && accessProven(row)) {
      credited.add(row.skillKey);
    }
  }
  return derivePlacedThroughGrade(
    credited,
    skills.map((s) => ({ nodeKey: s.skillKey, grade: s.grade })),
  );
}

/**
 * The SKILL-anchored placement END anchor (J3): the scholar's leading frontier
 * skill LABEL — the SAME "you are here" node the Tree marks — resolved from the
 * `frontier: true` mastery rows this domain now carries. `pickStartingSkillLabel`
 * (shared, also fed to the web + native result screens) names the furthest-reached
 * frontier so the copy and the Tree tell ONE story; grade is used only to rank,
 * never rendered. Null when nothing on the frontier carries a label (all-mastered
 * / degenerate) — the surface then shows a warm, numberless fallback.
 */
function startingSkillLabelFromMastery(
  mastery: Iterable<Doc<"practiceMastery">>,
  nodeByKey: Map<string, Doc<"knowledgeNodes">>,
): string | null {
  const frontier: { skillKey: string; label?: string | null; grade?: string | null }[] = [];
  for (const row of mastery) {
    if (!row.frontier) continue;
    const node = nodeByKey.get(row.skillKey);
    frontier.push({ skillKey: row.skillKey, label: node?.label, grade: node?.grade });
  }
  return pickStartingSkillLabel(frontier);
}

async function firstRequiredBlockScheduling(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  domain: string,
  mastery: Map<string, Doc<"practiceMastery">>,
  skills: { skillKey: string; grade?: string; order?: number }[],
  edges: GraphEdge[],
  stateOf: (key: string) => SkillState,
): Promise<FirstRequiredBlockScheduling> {
  const placement = await ctx.db
    .query("practicePlacements")
    .withIndex("by_scholar_domain", (q) => q.eq("scholarId", scholarId).eq("domain", domain))
    .first();
  if (placement?.status !== "complete") return INACTIVE_FIRST_BLOCK;

  const attempts = await ctx.db
    .query("practiceAttempts")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  if (attempts.some((attempt) => isRequiredPracticeAttempt(attempt, domain))) {
    return INACTIVE_FIRST_BLOCK;
  }

  const creditedCalibration = calibrationSkillKeysFromMastery(mastery, skills);
  const runnableCredited = await runnableSkillKeySet(ctx, creditedCalibration);
  const runnableCreditedCalibration = creditedCalibration.filter((key) =>
    runnableCredited.has(key),
  );
  const requiredExcludedSkillKeys = new Set(
    (placement.probeLog ?? [])
      .filter((entry) => entry.outcome === "unknown")
      .map((entry) => entry.nodeKey),
  );
  return {
    active: true,
    placedThroughGrade: placedThroughGradeFromMastery(mastery, skills),
    requiredExcludedSkillKeys,
    calibrationSkillKeys:
      runnableCreditedCalibration.length > 0
        ? runnableCreditedCalibration
        : await foundationalFirstBlockSkillKeys(
            ctx,
            skills,
            edges,
            stateOf,
            requiredExcludedSkillKeys,
          ),
  };
}

/**
 * The first-block CALIBRATION set: the top credited (inferred, source-"placement",
 * non-frontier, access-proven) skills, ordered NEAREST-FRONTIER first (highest
 * grade, then skillKey for determinism) and capped. Re-drilling these confirms
 * the placement's trust-upward credit — converting inferred credit toward
 * demonstrated — and guarantees the first post-placement block is never empty
 * (the discovered frontier is often a just-flagged "don't know" demoted to the
 * challenge tail, and fresh placement credit isn't DUE yet, so nothing else fills
 * the block). The two-axis invariant holds: an UN-practiced placement row stays
 * inferred; only a real drill here promotes it.
 */
function calibrationSkillKeysFromMastery(
  mastery: Map<string, Doc<"practiceMastery">>,
  skills: { skillKey: string; grade?: string }[],
): string[] {
  const gradeByKey = new Map(skills.map((s) => [s.skillKey, s.grade]));
  const known = new Set(skills.map((s) => s.skillKey));
  return [...mastery.values()]
    .filter((row) => row.source === "placement" && !row.frontier && accessProven(row) && known.has(row.skillKey))
    .map((row) => ({ key: row.skillKey, rank: gradeOrdinal(gradeByKey.get(row.skillKey)) ?? -1 }))
    .sort((a, b) => b.rank - a.rank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, FIRST_BLOCK_CALIBRATION_CAP)
    .map((c) => c.key);
}

/**
 * The no-credit placement fallback. An all-"not yet" placement has no inferred
 * credit to confirm, so start at the honest current frontier instead: unmastered
 * placement rows that the graph already identifies as ready foundations. Only
 * keys backed by a deterministic template or an actually stored verified item
 * may enter the lane, keeping the home rows aligned with `practiceSession`.
 *
 * This is scheduling only. It writes no mastery and grants no access; the first
 * real practice attempt remains the only way these repetition-0 rows advance.
 */
async function foundationalFirstBlockSkillKeys(
  ctx: QueryCtx | MutationCtx,
  skills: { skillKey: string; grade?: string; order?: number }[],
  edges: GraphEdge[],
  stateOf: (key: string) => SkillState,
  justMarkedUnknown: ReadonlySet<string>,
): Promise<string[]> {
  const graphReady = new Set(
    computeFrontier(
      skills.map((skill) => skill.skillKey),
      edges,
      stateOf,
    ),
  );
  const candidates = skills
    .filter((skill) => graphReady.has(skill.skillKey))
    .sort((a, b) => {
      const aGrade = gradeOrdinal(a.grade) ?? Number.POSITIVE_INFINITY;
      const bGrade = gradeOrdinal(b.grade) ?? Number.POSITIVE_INFINITY;
      return (
        aGrade - bGrade ||
        (a.order ?? Number.POSITIVE_INFINITY) - (b.order ?? Number.POSITIVE_INFINITY) ||
        (a.skillKey < b.skillKey ? -1 : a.skillKey > b.skillKey ? 1 : 0)
      );
    });
  const runnable = await runnableSkillKeySet(ctx, candidates.map((skill) => skill.skillKey));
  const runnableFoundations = candidates.filter((skill) => runnable.has(skill.skillKey));
  const unflagged = runnableFoundations.filter(
    (skill) => !justMarkedUnknown.has(skill.skillKey),
  );
  if (unflagged.length > 0) {
    return unflagged
      .slice(0, FIRST_BLOCK_CALIBRATION_CAP)
      .map((skill) => skill.skillKey);
  }

  // A one-root domain can have its sole entry point marked "not yet." Keep that
  // runnable, graph-ready root rather than returning an empty first block. The
  // item builder repeats this foundation to fill the session; scheduling it
  // never grants access to descendants.
  return runnableFoundations
    .slice(0, 1)
    .map((skill) => skill.skillKey);
}

/** Required-lane serveability: templates are deterministic; stored rows have
 * already passed the verifier before insertion into `practiceItems`. A skill
 * whose ONLY stored items are stretch-tier does NOT count — stretch items are
 * opt-in insight problems, never the required rotation. Exported as THE
 * canonical "can this skill be practiced" rule — nodeNeighbourhood surfaces it
 * to the targeted-practice (?skill=) launchers on both frontends. */
export async function runnableSkillKeySet(
  ctx: QueryCtx | MutationCtx,
  skillKeys: Iterable<string>,
): Promise<Set<string>> {
  const unique = [...new Set(skillKeys)];
  const runnable = new Set(unique.filter(hasTemplate));
  const stored = await Promise.all(
    unique
      .filter((key) => !runnable.has(key))
      .map(async (key) => ({
        key,
        item: await ctx.db
          .query("practiceItems")
          .withIndex("by_skill", (q) => q.eq("skillKey", key))
          .filter((q) => q.neq(q.field("tier"), "stretch"))
          .first(),
      })),
  );
  for (const { key, item } of stored) if (item !== null) runnable.add(key);
  return runnable;
}

/**
 * The scholar-facing serving lane (P1e) for a scheduler reason — drives the
 * "· review" / "· challenge" item chip. Remediation is redacted (§5): it flows
 * through the reviews channel and reads as an ordinary review to the scholar
 * (never "we detected you're struggling"). Ordinary frontier work is "new" and
 * carries no chip.
 */
function scholarLane(reason: NextPracticeReason): "review" | "new" | "challenge" {
  if (reason === "challenge") return "challenge";
  if (reason === "review" || reason === "remediation") return "review";
  return "new";
}

// ── The "Go deeper" stretch tail (deliberate difficulty on OWNED nodes) ─────
// Beast-Academy-style depth: an insight problem on a node the scholar has
// already DEMONSTRATED fluent, offered opt-in on the done screen — the depth
// sibling of the forward-pointing challenge tail (which serves above-band
// NODES). Misses are expected here (~solving 60–70% first-try is the design
// target) and never touch the mastery row; a success writes depth evidence
// (see submitAnswer). Distinct from the challenge tail: challenge = a step
// FORWARD on the map, stretch = a step DEEPER on a node you own.
const STRETCH_OFFER_CAP = 2;
const STRETCH_SCAN_CAP = 16;
// Per fluent skill, inspect at most the same small candidate window as the
// fluent-node scan. This bounds a prolific item's eligibility pass while still
// leaving eight candidates per possible Go Deeper offer.
const STRETCH_ITEM_SCAN_CAP = 16;
/** Bloom level a stretch success evidences when the item doesn't say ("apply"). */
export const STRETCH_DEFAULT_BLOOM = 3;
/** The evidenceType stamped on VERIFIER-GRADED stretch-success depth
 *  observations. Its model-judged sibling is
 *  lib/practice/dialogueStretch.ts's "stretch_dialogue". */
export const STRETCH_EVIDENCE_TYPE = "stretch_success";
/** The transfer/application sibling of stretch insight evidence. */
export { APPLICATION_EVIDENCE_TYPE };
/** Both stretch depth-evidence kinds — the dedup + re-offer checks treat one
 *  current claim at ≥ level as enough regardless of which vessel earned it.
 *  Facet rule: each facet's evidence suppresses only that facet's offers. */
export const STRETCH_EVIDENCE_TYPES: ReadonlySet<string> = new Set([
  STRETCH_EVIDENCE_TYPE,
  STRETCH_DIALOGUE_EVIDENCE_TYPE,
]);

/**
 * Write the stretch-success depth observation — the scholar-earnable input to
 * the node dial's depth arc (nodeDepth.ts reads masteryObservations, MAX level
 * per node). Deduped: one current stretch_success per node at ≥ this item's
 * Bloom level is enough — re-solving doesn't stack rows.
 */
async function maybeWriteStretchDepthObservation(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  item: { skillKey: string; skillLabel: string; domain: string },
  storedRow: Doc<"practiceItems">,
) {
  const level = storedRow.bloomLevel ?? STRETCH_DEFAULT_BLOOM;
  const current = await ctx.db
    .query("masteryObservations")
    .withIndex("by_scholar_node", (q) =>
      q.eq("scholarId", scholarId).eq("nodeKey", item.skillKey),
    )
    .filter((q) => q.eq(q.field("isSuperseded"), false))
    .collect();
  if (
    current.some((o) => STRETCH_EVIDENCE_TYPES.has(o.evidenceType) && o.masteryLevel >= level)
  )
    return;
  await ctx.db.insert("masteryObservations", {
    scholarId,
    conceptLabel: item.skillLabel,
    domain: item.domain,
    nodeKey: item.skillKey,
    observedAt: Date.now(),
    transcriptExcerpt: storedRow.stem.slice(0, 400),
    masteryLevel: level,
    confidenceScore: 0.85,
    evidenceSummary: `Independently solved a stretch (insight) practice problem${
      storedRow.technique ? ` — technique: ${storedRow.technique.replace(/_/g, " ")}` : ""
    }. Unassisted; graded by the verifier.`,
    evidenceType: STRETCH_EVIDENCE_TYPE,
    attemptContext: "practice",
    studentInitiated: true,
    isSuperseded: false,
  });
}

async function maybeWriteApplicationDepthObservation(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  item: { skillKey: string; skillLabel: string; domain: string },
  storedRow: Doc<"practiceItems">,
) {
  const level = storedRow.bloomLevel ?? STRETCH_DEFAULT_BLOOM;
  const current = await ctx.db
    .query("masteryObservations")
    .withIndex("by_scholar_node", (q) =>
      q.eq("scholarId", scholarId).eq("nodeKey", item.skillKey),
    )
    .filter((q) => q.eq(q.field("isSuperseded"), false))
    .collect();
  if (
    current.some(
      (observation) =>
        observation.evidenceType === APPLICATION_EVIDENCE_TYPE &&
        observation.masteryLevel >= level,
    )
  )
    return;
  await ctx.db.insert("masteryObservations", {
    scholarId,
    conceptLabel: item.skillLabel,
    domain: item.domain,
    nodeKey: item.skillKey,
    observedAt: Date.now(),
    transcriptExcerpt: storedRow.stem.slice(0, 400),
    masteryLevel: level,
    confidenceScore: 0.85,
    evidenceSummary: `Independently solved an application (transfer) practice problem${
      storedRow.technique ? ` — technique: ${storedRow.technique.replace(/_/g, " ")}` : ""
    }. Unassisted; graded by the verifier.`,
    evidenceType: APPLICATION_EVIDENCE_TYPE,
    attemptContext: "practice",
    studentInitiated: true,
    isSuperseded: false,
  });
}

async function maybeWriteOptionalDepthObservation(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  item: { skillKey: string; skillLabel: string; domain: string },
  storedRow: Doc<"practiceItems">,
) {
  if (storedRow.storyToKey !== undefined) {
    await maybeWriteApplicationDepthObservation(ctx, scholarId, item, storedRow);
    return;
  }
  await maybeWriteStretchDepthObservation(ctx, scholarId, item, storedRow);
}

async function stretchTailForScholar(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  domain: string,
  mastery: Map<string, Doc<"practiceMastery">>,
  labelOf: Map<string, string>,
  seed: number,
  allowedKeys?: ReadonlySet<string>,
): Promise<ServedItem[]> {
  // Candidates: nodes with DEMONSTRATED fluency — the bare green gate, not the
  // full retention-context claim, so a currently-due review doesn't disqualify
  // going deeper. Freshest greens first; scan bounded.
  const fluentRows = [...mastery.values()]
    .filter((row) => isFluent(row) && (allowedKeys === undefined || allowedKeys.has(row.skillKey)))
    .sort((a, b) => (b.becameFluentAt ?? 0) - (a.becameFluentAt ?? 0))
    .slice(0, STRETCH_SCAN_CAP);

  const tail: ServedItem[] = [];
  for (const row of fluentRows) {
    if (tail.length >= STRETCH_OFFER_CAP) break;
    const nodeObs = await ctx.db
      .query("masteryObservations")
      .withIndex("by_scholar_node", (q) =>
        q.eq("scholarId", scholarId).eq("nodeKey", row.skillKey),
      )
      .filter((q) => q.eq(q.field("isSuperseded"), false))
      .collect();
    const items = (
      await ctx.db
        .query("practiceItems")
        .withIndex("by_skill_tier", (q) =>
          q.eq("skillKey", row.skillKey).eq("tier", "stretch"),
        )
        .take(STRETCH_ITEM_SCAN_CAP)
    ).filter((item) =>
      isOptionalDepthItemEligible(
        item,
        nodeObs,
        STRETCH_EVIDENCE_TYPES,
      ),
    );
    if (items.length === 0) continue;
    const pick = items[(seed >>> 0) % items.length];
    const servable = buildStoredServable(
      `gen#${pick._id}`,
      pick,
      { label: labelOf.get(row.skillKey), domain },
      domain,
    );
    if (!servable) continue;
    const servedItem = servedItemFromServable(servable, false);
    // Served BARE — no worked-step fade (the point is the unassisted idea).
    // Lane-stamped so the client pre-frames the difficulty before the miss.
    servedItem.lane = "stretch";
    servedItem.domain = domain;
    const storyToKey = pick.storyToKey;
    if (storyToKey !== undefined) {
      // The link's from-key is the row's own skillKey (schema comment).
      const linkedStory = (
        await ctx.db
          .query("knowledgeNodeEdges")
          .withIndex("by_from_to", (q) =>
            q.eq("fromKey", pick.skillKey).eq("toKey", storyToKey),
          )
          .collect()
      ).find((edge) => edge.story !== undefined)?.story;
      if (linkedStory?.hook) servedItem.storyHook = linkedStory.hook;
    }
    tail.push(servedItem);
  }
  return tail;
}

// ── Reads (self-or-teacher) ───────────────────────────────────────────────

/**
 * Project the confirmed floors of every in-progress placement into transient
 * skill states for the Tree read model. This deliberately mirrors placement
 * finalization without writing `practiceMastery`: scheduler/access guards must
 * continue to treat the domain as unmapped until the placement really completes.
 */
async function projectedPlacementStates(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  loadedDomains: ReadonlyMap<string, Awaited<ReturnType<typeof loadDomain>>>,
): Promise<Map<string, SkillState>> {
  const rows = await ctx.db
    .query("practicePlacements")
    .withIndex("by_scholar_domain", (q) => q.eq("scholarId", scholarId))
    .collect();
  const latestByDomain = new Map<string, Doc<"practicePlacements">>();
  for (const row of rows) {
    if (row.status !== "in_progress") continue;
    const current = latestByDomain.get(row.domain);
    if (!current || row.updatedAt > current.updatedAt) {
      latestByDomain.set(row.domain, row);
    }
  }

  const projected = new Map<string, SkillState>();
  for (const row of latestByDomain.values()) {
    const loaded = loadedDomains.get(row.domain) ?? (await loadDomain(ctx, row.domain));
    if (loaded.skills.length === 0) continue;
    const orders = strandOrders(
      loaded.skills.map((skill) => ({
        nodeKey: skill.skillKey,
        strand: skill.strand,
        order: skill.order,
      })),
      loaded.edges,
    );
    const { outcomes } = outcomesFromProbeLog(row.probeLog);
    const floors = floorsFromPlacementRow(orders, row);
    for (const order of orders) {
      const front = strandFrontier(
        order.strand,
        order.orderedKeys,
        outcomes,
        floors.get(order.strand) ?? 0,
      );
      for (const key of front.creditedKeys) {
        projected.set(key, {
          repetition: FLUENT_REPS,
          halfLifeDays: PLACEMENT_HALF_LIFE_DAYS,
          lastPracticedAt: row.updatedAt,
        });
      }
    }
  }
  return projected;
}

/**
 * Merge one or more practice domains into a single scholar tree: every skill
 * (tagged with its `domain`) with its proficiency band, retention label, and
 * whether it's on the frontier — plus the prerequisite edges (cross-domain edges
 * included, since ALL referenced domains are loaded). Shared by the single-domain
 * and unified all-domains reads so the frontier math is identical in both.
 *
 * skillKeys are globally unique (a cross-domain edge's `fromKey` IS the parent
 * domain's own key), so merging masteries/skills by key never collides — the
 * foreign-aware `buildFrontierStateOf` is then inert (every referenced key is
 * loaded), and `computeFrontier` gates a child skill on its parent's mastery
 * exactly as the single-domain path did via foreign resolution.
 */
async function buildScholarTree(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  domainList: string[],
  filterForScholarSelf = false,
) {
  const now = Date.now();
  const skillsByKey = new Map<string, Awaited<ReturnType<typeof loadDomain>>["skills"][number]>();
  const edges: Awaited<ReturnType<typeof loadDomain>>["edges"] = [];
  const mastery = new Map<string, Doc<"practiceMastery">>();
  const loadedDomains = new Map<string, Awaited<ReturnType<typeof loadDomain>>>();
  const presentDomains: string[] = [];

  for (const d of domainList) {
    const loaded = await loadDomain(ctx, d);
    if (loaded.skills.length === 0) continue; // not seeded on this deployment
    loadedDomains.set(d, loaded);
    presentDomains.push(d);
    for (const s of loaded.skills) if (!skillsByKey.has(s.skillKey)) skillsByKey.set(s.skillKey, s);
    edges.push(...loaded.edges);
    const m = await loadMastery(ctx, scholarId, d);
    for (const [k, row] of m) if (!mastery.has(k)) mastery.set(k, row);
  }

  const skills = [...skillsByKey.values()];
  const keys = skills.map((s) => s.skillKey);
  const graphEdges: GraphEdge[] = edges.map((e) => ({ fromKey: e.fromKey, toKey: e.toKey }));
  const retentionTargets = desiredRetentionTargets(keys, graphEdges);
  const projectedStates = await projectedPlacementStates(
    ctx,
    scholarId,
    loadedDomains,
  );
  const stateOf = await buildFrontierStateOf(
    ctx,
    scholarId,
    keys,
    edges,
    mastery,
    projectedStates,
  );
  const frontier = new Set(computeFrontier(keys, graphEdges, stateOf));

  const nodes = skills
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((s) => {
      const masteryRow = mastery.get(s.skillKey);
      const projectedState = projectedStates.get(s.skillKey);
      const st = masteryRow
        ? stateFromRow(masteryRow)
        : (projectedState ?? ZERO);
      return {
        skillKey: s.skillKey,
        label: s.label,
        // The domain each node belongs to — drives the unified map's per-domain
        // banding + colour (the tree analogue of the sky's domain regions).
        domain: s.domain,
        strand: s.strand ?? null,
        grade: s.grade ?? null,
        // Standards are an optional crosswalk tag. Surface the codes (with
        // their framework) for the chip; an empty list = maps to no standard.
        standardCodes: s.standardCodes ?? [],
        repetition: st.repetition,
        halfLifeDays: st.halfLifeDays,
        // Exact practice-earned fluency crossing for historical map snapshots.
        // Older and placement/accelerated rows intentionally remain null so the
        // client can fall back to the legacy lastPracticedAt proxy.
        becameFluentAt: masteryRow?.becameFluentAt ?? null,
        // Historical fallback for mastery rows without a transition stamp.
        lastPracticedAt: st.lastPracticedAt ?? null,
        proficiency: proficiencyFromReps(st.repetition),
        // DEMONSTRATED vs INFERRED credit — the two-axis doctrine made visible.
        // `proficiency` above is a pure rep-count band, so an access-proven but
        // inferred credit (placement / accelerated / re-probe) reads as "fluent"
        // there. This flag carries the SAME source rule `isFluent` uses for the
        // green claim, so the renderer can show inferred credit as "placed"
        // (provisional) instead of the full "fluent" green. A never-practiced
        // node has no row → defaults to demonstrated, but its proficiency is
        // not_started so it never renders green either way.
        demonstrated:
          projectedState && !masteryRow
            ? false
            : isDemonstratedSource(masteryRow?.source),
        retention: retentionLabel(st, now, retentionTargets.get(s.skillKey)),
        // When this practiced skill next crosses its due threshold and returns
        // as review (P1e — the "comes back ~Thu" data). Inverts the forgetting
        // curve with the SAME per-skill retention target the scheduler uses;
        // null for a never-practiced skill (nothing scheduled yet). The client
        // formats it to a weekday phrase (shared/practiceLoop.formatComesBack).
        dueAt: dueAt(st, retentionTargets.get(s.skillKey)) ?? null,
        frontier: frontier.has(s.skillKey),
        // Recent-miss streak → the teacher/parent-facing "struggling" (red)
        // state. REDACTED from the scholar's own map: omitted entirely when this
        // is the scholar reading their own tree, so they can never derive the red
        // deficit mark (honors "a portrait, not a report card"). A never-practiced
        // node (no row) falls back to 0, which reads as not-struggling.
        missStreak: filterForScholarSelf ? undefined : (masteryRow?.missStreak ?? 0),
      };
    });

  let returnedNodes = nodes;
  let returnedEdges = graphEdges;
  if (filterForScholarSelf) {
    const revealRows = await ctx.db
      .query("nodeReveals")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect();
    // Proven-ness comes from the foreign-aware `stateOf`, not the domain-loaded
    // mastery map: on a single-domain read a cross-domain prerequisite's proven
    // credit lives outside `mastery`, and missing it would wrongly hide the
    // one-hop horizon past a foreign-unlocked node. (A foreign prereq's OWN
    // prerequisites aren't loaded, so it reads as trivially available — erring
    // toward showing the pinned domain's entry nodes, which the unified map
    // computes exactly.)
    const referencedKeys = new Set<string>(keys);
    for (const e of graphEdges) {
      referencedKeys.add(e.fromKey);
      referencedKeys.add(e.toKey);
    }
    const provenKeys = new Set<string>();
    for (const key of referencedKeys) {
      if (accessProven(stateOf(key))) provenKeys.add(key);
    }
    const visibleKeys = computeVisibleKeys(
      keys,
      graphEdges,
      provenKeys,
      new Set([...mastery.keys(), ...projectedStates.keys()]),
      new Set(revealRows.map((row) => row.nodeKey)),
    );
    returnedNodes = nodes.filter((node) => visibleKeys.has(node.skillKey));
    returnedEdges = graphEdges.filter(
      (edge) => visibleKeys.has(edge.fromKey) && visibleKeys.has(edge.toKey),
    );
  }

  return {
    // `domain` is the single loaded domain (single-domain reads) or null when the
    // unified map merged several; `domains` is every domain actually present (in
    // display order — the map's vertical band order); `domainLabels` carries the
    // human name per domain so the client renders the rail without importing the
    // (server-side) domain registry + its seed graphs.
    domain: presentDomains.length === 1 ? presentDomains[0] : null,
    domains: presentDomains,
    domainLabels: Object.fromEntries(
      presentDomains.map((d) => [d, practiceDomainLabel(d)]),
    ) as Record<string, string>,
    nodes: returnedNodes,
    edges: returnedEdges,
  };
}

/**
 * The Skills › Math drill-down for a scholar: every skill with its proficiency
 * band, retention label, and whether it's on the frontier — plus the edges.
 * The exact shape the tree-map surface renders.
 *
 * `allDomains` (the unified map — one big tree, scholar- and teacher-facing)
 * merges EVERY seeded practice domain into one tree; otherwise a single domain
 * (an explicit `domain`, else the default whole-number arithmetic) — preserving
 * the historical single-domain callers and their cross-domain frontier semantics.
 */
export const treeForScholar = authedQuery({
  args: {
    scholarId: v.id("users"),
    domain: v.optional(v.string()),
    allDomains: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const isLearnerSelf =
      ctx.user._id === args.scholarId &&
      (await hasScholarMembership(ctx, ctx.user._id));

    const domainList =
      args.allDomains && !args.domain
        ? PRACTICE_DOMAINS.map((d) => d.domain)
        : [args.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN];

    return await buildScholarTree(
      ctx,
      args.scholarId,
      domainList,
      isLearnerSelf,
    );
  },
});

/**
 * Compact practice-mastery summary for a single scholar — used by the
 * teacher's Assignment Run page to show per-scholar progress on
 * problem_set activities without loading the full skill tree.
 * Auth mirrors treeForScholar: teacher-or-self + requireActiveScholarAccess.
 */
export const summaryForScholar = authedQuery({
  args: { scholarId: v.id("users"), domain: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const { practiceScope } = await resolvePracticeScope(ctx, args.scholarId);
    const domain = args.domain ?? defaultScopeDomain(practiceScope);
    if (!isScopeAllowedDomain(practiceScope, domain)) {
      return {
        fluentCount: 0,
        provisionalCount: 0,
        frontierCount: 0,
        dueCount: 0,
        total: 0,
        accessComplete: false,
        exhausted: false,
      };
    }

    const loaded = scopeLoadedDomain(practiceScope, domain, await loadDomain(ctx, domain));
    const { skills, edges } = loaded;
    const mastery = await loadMastery(ctx, args.scholarId, domain);
    const now = Date.now();
    const keys = skills.map((s) => s.skillKey);
    const graphEdges: GraphEdge[] = edges.map((e) => ({
      fromKey: e.fromKey,
      toKey: e.toKey,
    }));
    const retentionTargets = desiredRetentionTargets(keys, graphEdges);
    const stateOf = await buildFrontierStateOf(ctx, args.scholarId, keys, edges, mastery);
    const frontier = new Set(computeFrontier(keys, graphEdges, stateOf));
    const climb = domainClimb(keys, mastery.values());

    let fluentCount = 0;
    let provisionalCount = 0;
    let frontierCount = 0;
    let dueCount = 0;

    for (const s of skills) {
      const row = mastery.get(s.skillKey);
      const st = stateFromRow(row);
      // Keep the domain reads on the bare demonstrated gate. The composite
      // green count needs a scholar-wide latency baseline, and computing that
      // here but not in the domain catalog would make the same domain disagree.
      if (row && isFluent(row)) fluentCount++;
      if (row && isProvisional(row)) provisionalCount++;
      if (frontier.has(s.skillKey)) frontierCount++;
      if (isDue(st, now, retentionTargets.get(s.skillKey))) dueCount++;
    }

    return {
      fluentCount,
      provisionalCount,
      frontierCount,
      dueCount,
      total: skills.length,
      accessComplete: climb.accessComplete,
      // "Summit" means every skill was demonstrated through practice; inferred
      // access credit alone may open the frontier but never exhausts a domain.
      exhausted: climb.demonstratedComplete,
    };
  },
});

/**
 * Stage-2 shared helper: a scholar's progress in ONE domain — enough to decide
 * "summit" (every skill demonstrated, nothing left to learn). Pass `preloadedKeys`
 * (the domain's skillKeys, loaded once) to avoid re-reading the graph per
 * scholar across a cohort-wide scan; omit it and the graph is
 * loaded here. `practiced` = the scholar has any mastery row in the domain
 * (has entered it — placement writes rows too), which is what the switcher
 * lists.
 */
async function domainStatForScholar(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  domain: string,
  preloadedKeys?: string[],
): Promise<{
  domain: string;
  fluentCount: number;
  provisionalCount: number;
  total: number;
  accessComplete: boolean;
  exhausted: boolean;
  practiced: boolean;
}> {
  const keys =
    preloadedKeys ?? (await loadDomain(ctx, domain)).skills.map((s) => s.skillKey);
  const mastery = await loadMastery(ctx, scholarId, domain);
  const climb = domainClimb(keys, mastery.values());
  let fluentCount = 0;
  let provisionalCount = 0;
  for (const k of keys) {
    const row = mastery.get(k);
    if (row && isFluent(row)) fluentCount++;
    if (row && isProvisional(row)) provisionalCount++;
  }
  const total = keys.length;
  return {
    domain,
    fluentCount,
    provisionalCount,
    total,
    accessComplete: climb.accessComplete,
    exhausted: climb.demonstratedComplete,
    practiced: mastery.size > 0,
  };
}

/**
 * Stage 2 — the domains a scholar can move between, with per-domain progress.
 * Powers the practice surface's modest domain switcher and summit state.
 * Returns every REGISTERED domain
 * that has seeded nodes on this deployment (mirrors `standingPractice.listDomains`),
 * tagged with the scholar's demonstrated `fluentCount`, `provisionalCount`,
 * `accessComplete`, whether they've `started` it (any mastery row), and whether
 * they've `exhausted` it (the demonstrated summit).
 *
 * Non-sensitive (labels + counts), so authedQuery with teacher-or-self access —
 * the scholar sees their own, a teacher sees a scholar they have access to.
 */
/**
 * The cross-domain prerequisite DOMAINS for every seeded registered domain:
 * `domain → [foreign domains it has a `buildsOn` edge INTO from]`. A domain's
 * edges are stamped with the TO-side domain, so a foreign FROM-side node marks a
 * cross-domain prerequisite (fractions → whole-number-arithmetic via
 * division_as_sharing; probability → fraction-arithmetic via fraction_as_parts).
 * Used to gate placement (probe in prereq order) and to flag a self-directed
 * entry into a still-gated domain. NodeKeys are globally unique (graphValidation).
 */
/**
 * The cross-domain prerequisite EDGES for every seeded registered domain:
 * `domain → [{ fromKey, fromDomain, grade } …]` — each foreign `buildsOn` edge
 * INTO this domain. A domain's edges are stamped with the TO-side domain, so a
 * foreign FROM-side node marks a cross-domain prerequisite (fractions →
 * whole-number-arithmetic via `division_as_sharing`; probability →
 * fraction-arithmetic via `fraction_as_parts`). Used to gate placement (probe in
 * prereq order) and to name the specific unmet prerequisite in the gated-entry
 * note. NodeKeys are globally unique (graphValidation).
 */
async function crossDomainPrereqEdges(
  ctx: QueryCtx | MutationCtx,
): Promise<Map<string, { fromKey: string; fromDomain: string; grade?: string }[]>> {
  const domainOfKey = new Map<string, string>();
  const gradeOfKey = new Map<string, string | undefined>();
  const edgesByDomain = new Map<string, { fromKey: string }[]>();
  for (const info of PRACTICE_DOMAINS) {
    const nodes = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_domain", (q) => q.eq("domain", info.domain))
      .collect();
    if (nodes.length === 0) continue;
    for (const n of nodes) {
      domainOfKey.set(n.nodeKey, info.domain);
      gradeOfKey.set(n.nodeKey, n.grade);
    }
    const edges = (
      await ctx.db
        .query("knowledgeNodeEdges")
        .withIndex("by_domain", (q) => q.eq("domain", info.domain))
        .collect()
    ).filter((e) => e.kind === "buildsOn");
    edgesByDomain.set(info.domain, edges);
  }
  const out = new Map<string, { fromKey: string; fromDomain: string; grade?: string }[]>();
  for (const [domain, edges] of edgesByDomain) {
    const seen = new Set<string>();
    const foreign: { fromKey: string; fromDomain: string; grade?: string }[] = [];
    for (const e of edges) {
      const fromDomain = domainOfKey.get(e.fromKey);
      if (fromDomain && fromDomain !== domain && !seen.has(e.fromKey)) {
        seen.add(e.fromKey);
        foreign.push({ fromKey: e.fromKey, fromDomain, grade: gradeOfKey.get(e.fromKey) });
      }
    }
    out.set(domain, foreign);
  }
  return out;
}

export const domainsForScholar = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    return domainsForScholarCore(ctx, args.scholarId);
  },
});

/**
 * Shared core for `domainsForScholar` (auth injected by the public query;
 * bare `scholarId` for the internal aide-tool variant below). Extracting it
 * keeps ONE implementation the way `masterSchedule` shares its `core*` helpers
 * between the teacher fn and the bot's internal wrapper — no logic is
 * duplicated.
 *
 * NOTE ON `fluentCount`: all domain reads intentionally use bare `isFluent`:
 * demonstrated practice credit, without retention/latency context. Computing
 * the composite claim here would need a scholar-wide latency baseline across
 * every catalog domain; using it only on selected reads would make equivalent
 * domain counts disagree. `provisionalCount` keeps inferred access separate.
 */
async function domainsForScholarCore(ctx: QueryCtx, scholarId: Id<"users">) {
    const { practiceScope } = await resolvePracticeScope(ctx, scholarId);
    const prereqMap = await crossDomainPrereqEdges(ctx);
    const out: {
      domain: string;
      label: string;
      discipline: string;
      fluentCount: number;
      provisionalCount: number;
      total: number;
      started: boolean;
      accessComplete: boolean;
      exhausted: boolean;
      /** True when a cross-domain prerequisite domain (e.g. whole-number
       *  arithmetic for fractions) is NOT yet placed for this scholar — a
       *  self-directed entry is ALLOWED (never a hard lock) but earns a gentle
       *  portrait-voiced note. */
      prereqGated: boolean;
      /** The SPECIFIC unmet cross-domain prerequisite to name in the gated-entry
       *  note (null when not gated). `concept` is a short kid-facing noun (e.g.
       *  "division"); the note recommends it but still lets the scholar proceed. */
      prereqGate: { concept: string; prereqDomain: string; prereqLabel: string } | null;
    }[] = [];
    // First pass: per-domain stats + which domains are placed (started), so the
    // prereq gate can read the placed set.
    const rows: {
      info: (typeof PRACTICE_DOMAINS)[number];
      started: boolean;
      fluentCount: number;
      provisionalCount: number;
      total: number;
      accessComplete: boolean;
      exhausted: boolean;
    }[] = [];
    const placed = new Set<string>();
    for (const info of PRACTICE_DOMAINS) {
      if (!practiceScopeAllowsDomain(practiceScope, info.domain)) continue;
      const keys = (await loadDomain(ctx, info.domain)).skills
        .filter((skill) =>
          practiceScopeAllowsNode(practiceScope, skill.domain, skill.strand),
        )
        .map((skill) => skill.skillKey);
      if (keys.length === 0) continue; // not seeded on this deployment
      const stat = await domainStatForScholar(ctx, scholarId, info.domain, keys);
      if (stat.practiced) placed.add(info.domain);
      rows.push({
        info,
        started: stat.practiced,
        fluentCount: stat.fluentCount,
        provisionalCount: stat.provisionalCount,
        total: stat.total,
        accessComplete: stat.accessComplete,
        exhausted: stat.exhausted,
      });
    }
    for (const r of rows) {
      const edges = prereqMap.get(r.info.domain) ?? [];
      // The unmet cross-domain prereq edges (their from-DOMAIN isn't placed yet).
      const unmet = edges.filter((e) => !placed.has(e.fromDomain));
      // Name the MOST FOUNDATIONAL unmet prereq (lowest grade, then nodeKey) — the
      // one to recommend "getting comfortable with first".
      const primary = [...unmet].sort(
        (a, b) =>
          (gradeOrdinal(a.grade) ?? 99) - (gradeOrdinal(b.grade) ?? 99) ||
          (a.fromKey < b.fromKey ? -1 : a.fromKey > b.fromKey ? 1 : 0),
      )[0];
      out.push({
        domain: r.info.domain,
        label: r.info.label,
        discipline: r.info.discipline,
        fluentCount: r.fluentCount,
        provisionalCount: r.provisionalCount,
        total: r.total,
        started: r.started,
        accessComplete: r.accessComplete,
        exhausted: r.exhausted,
        prereqGated: unmet.length > 0,
        prereqGate: primary
          ? {
              concept: practicePrereqConcept(primary.fromKey, practiceDomainLabel(primary.fromDomain)),
              prereqDomain: primary.fromDomain,
              prereqLabel: practiceDomainLabel(primary.fromDomain),
            }
          : null,
      });
    }
    return out;
}

export const domainsForScholarInternal = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => domainsForScholarCore(ctx, args.scholarId),
});

/**
 * Teacher-facing internal read of a scholar's skill TREE (per-node mastery,
 * `demonstrated` credit flag, `frontier`, `proficiency`) plus the prerequisite
 * `edges` — the bare-`scholarId` variant of `treeForScholar` for the aide
 * tools (which have no `ctx.user`). Never the scholar-self view, so nodes are
 * NOT hidden and `missStreak` is present: the caller is always staff, gated at
 * tool-assembly time. Mirrors `getScholarPractice` / `getScholarMastery`: the
 * chokepoint is the tool factory's role gate + name-resolution scoping.
 */
export const treeForScholarInternal = internalQuery({
  args: {
    scholarId: v.id("users"),
    domain: v.optional(v.string()),
    allDomains: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    // `allDomains` WINS unconditionally — the tool's contract says `domain` is
    // ignored when it's set, and the tool call site already omits `domain` in
    // that case. Honoring it here too means a future caller that passes BOTH
    // gets the merged tree it asked for rather than a silently single-domain
    // one. (The public `treeForScholar` keeps its `&& !args.domain` form: its
    // existing callers rely on that behavior, and this is the internal twin.)
    const domainList = args.allDomains
      ? PRACTICE_DOMAINS.map((d) => d.domain)
      : [args.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN];
    return await buildScholarTree(ctx, args.scholarId, domainList, false);
  },
});

/** The next-practice queue for a scholar: due reviews first, then strand-balanced frontier. */
export const nextForScholar = authedQuery({
  args: {
    scholarId: v.id("users"),
    domain: v.optional(v.string()),
    limit: v.optional(v.number()),
    // Optional scholar hint ("I want multiplication today"): weights that strand
    // ×2 and surfaces it beyond the 2-strand session cap. Never overrides reviews.
    strandHint: v.optional(v.string()),
    // A standing assignment's off-limits strands — never served (reviews or
    // frontier). Threaded from practiceConfig.excludedStrands.
    excludedStrands: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const { practiceScope } = await resolvePracticeScope(ctx, args.scholarId);
    const domain = args.domain ?? defaultScopeDomain(practiceScope);
    if (!isScopeAllowedDomain(practiceScope, domain)) return [];

    const { skills, edges } = scopeLoadedDomain(
      practiceScope,
      domain,
      await loadDomain(ctx, domain),
    );
    const mastery = await loadMastery(ctx, args.scholarId, domain);
    const gradeLevel = await scholarGradeLevel(ctx, args.scholarId);
    const labelOf = new Map(skills.map((s) => [s.skillKey, s.label]));
    const stateOf = await buildFrontierStateOf(ctx, args.scholarId, skills.map((s) => s.skillKey), edges, mastery);
    const remediationSkillKey = await computeRemediationSkillKey(ctx, args.scholarId, domain, mastery, edges);
    const firstBlock = await firstRequiredBlockScheduling(
      ctx,
      args.scholarId,
      domain,
      mastery,
      skills,
      edges,
      stateOf,
    );
    const queue = nextPractice(
      skills.map((s) => s.skillKey),
      edges,
      stateOf,
      Date.now(),
      args.limit ?? 5,
      { ...buildStrandScheduling(skills, edges, mastery, gradeLevel, args.strandHint, args.excludedStrands, firstBlock), applyMixFloor: true, remediationSkillKey },
    );
    return queue.map((q) => ({ ...q, label: labelOf.get(q.key) ?? q.key }));
  },
});

/**
 * The scholar-home **Playlist card** payload (raise-the-ceiling plan §3): the
 * composed "Today's Math Playlist" — a small set of skills to practice now, the
 * single next-up skill, and how much of today's set is already done. Assembled
 * from the same frontier/review engine `nextForScholar` uses, plus a
 * practiced-today read off honest attempt timestamps; the standing-assignment framing (goal
 * minutes, title, room bell) is merged in on the client from
 * `standingPractice.myActiveStanding` (mirrors how the home already builds its
 * practice link). Self-serve by default; a teacher may pass `scholarId`.
 *
 * The row `reason` drives the scholar-facing tag: a `teacherFocus` next-up reads
 * "your teacher set this next", a `review` row "keeps it sharp", a `new` row
 * "in your set". `doneToday` marks a set skill already practiced in today's
 * block (a ✓ dot) — deliberately NOT a mastery/fluent signal, which lives on the
 * map + the wrap, so §2's "green = fluent" invariant is never diluted here.
 *
 * Doubles as the "You pick" select-and-recompose PREVIEW (raise-the-ceiling
 * §C-2 follow-up): pass the optional `choiceHint` to see the SAME set biased
 * toward a chosen (domain, strand) — no forked composition, the identical
 * `buildStrandScheduling`/`nextPractice` call below is just optionally hinted,
 * mirroring `practiceSession`'s own `choiceHint.domain === domain` gate byte-
 * for-byte, so what this returns is exactly what Start will actually serve.
 */
export const playlistForScholar = authedQuery({
  args: {
    scholarId: v.optional(v.id("users")),
    domain: v.optional(v.string()),
    // Subscription cache-buster changed by clients at institution-local midnight.
    dayKey: v.optional(v.string()),
    // Optional scholar choice (You Pick, select-and-recompose): when its domain
    // matches the resolved `domain` below, its strand is force-activated +
    // double-weighted — the SAME gate `practiceSession`'s single-domain branch
    // applies (`args.choiceHint?.domain === domain`). This makes the home
    // preview a byte-faithful stand-in for what Start will actually serve: no
    // forked scheduling logic, just the same `buildStrandScheduling`/
    // `nextPractice` call already below, now optionally hinted. A mismatched
    // domain (a pick outside today's resolved domain) is silently ignored here,
    // exactly as it would be at serve time.
    choiceHint: v.optional(v.object({ domain: v.string(), strand: v.string() })),
    // Optional Stretch tile recompose: when true, recomposes the `set` to the
    // challenge-tail items only (the above-band frontier nodes the grade band
    // withheld). The required set (reviews) is NOT included — stretch is the
    // opt-in extra. The `hasChallengeItems` flag is ALWAYS returned so the
    // tile can show/hide independently of a selection.
    stretchHint: v.optional(v.boolean()),
    // Option D (OPTION_D_RULINGS Q6): mapping-aware preview. When set (the
    // default/You-Pick Home entries), recompose the preview `set` to the SAME
    // `· mapping` composition `practiceSession` will serve for this domain — so
    // the Home preview and Start never disagree (selecting an unmapped domain
    // previews mapping items, not ordinary root/frontier rows it won't serve).
    // Absent for stretch and for placed scholars with nothing to map (unchanged).
    includeMapping: v.optional(v.boolean()),
    // Vestigial post-focus-cutover: the per-scholar focus model this once
    // escaped is retired, so this argument is now inert. Kept in the schema
    // only so existing callers don't break; the serving resolver never
    // consults it.
    allowOutsideFocus: v.optional(v.boolean()),
    // The requesting client, so a Launchpad authored for one platform only
    // (`instructionContent.platforms`) never surfaces on the other. Absent →
    // "web" (every pre-existing caller).
    platform: v.optional(v.union(v.literal("web"), v.literal("native"))),
  },
  handler: async (ctx, args) => {
    const scholarId = args.scholarId ?? ctx.user._id;
    const isTeacher = requireTeacherOrSelf(ctx.user, scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, scholarId);
    const { practiceScope } = await resolvePracticeScope(ctx, scholarId);
    const rawCheckpoint = await resolveEffectiveCheckpoint(ctx, scholarId);
    const effectiveCheckpoint =
      rawCheckpoint && practiceScopeAllowsCheckpoint(practiceScope, rawCheckpoint)
        ? rawCheckpoint
        : null;
    if (args.domain && !practiceScopeAllowsDomain(practiceScope, args.domain)) {
      return {
        domain: args.domain,
        nextUp: null,
        set: [],
        practicedToday: false,
        skillsPracticedToday: 0,
        everPracticed: false,
        needsPlacement: false,
        firstPostPlacementBlock: false,
        hasChallengeItems: false,
        mappingPreview: false,
        allMapping: false,
        launchpad: undefined,
        blocked: true as const,
      };
    }
    const preferredCheckpoint =
      (args.includeMapping || !args.domain) &&
      !args.choiceHint &&
      !args.stretchHint
        ? effectiveCheckpoint
        : null;
    const domain =
      preferredCheckpoint?.domain ??
      args.domain ??
      defaultScopeDomain(practiceScope);
    if (!domain) {
      return {
        domain: args.domain ?? "",
        nextUp: null, set: [], practicedToday: false, skillsPracticedToday: 0,
        everPracticed: false, needsPlacement: false, firstPostPlacementBlock: false,
        hasChallengeItems: false, mappingPreview: false, allMapping: false, launchpad: undefined,
        blocked: true as const,
      };
    }
    const strandHint = args.choiceHint?.domain === domain ? args.choiceHint.strand : undefined;

    const scopedLoaded = scopeLoadedDomain(practiceScope, domain, await loadDomain(ctx, domain));
    const { skills, edges } = scopedLoaded;
    const mastery = await loadMastery(ctx, scholarId, domain);
    const strandByKey = new Map(skills.map((s) => [s.skillKey, s.strand]));
    const gradeLevel = await scholarGradeLevel(ctx, scholarId);
    const labelOf = new Map(skills.map((s) => [s.skillKey, s.label]));

    // `dayKey` is intentionally not trusted for semantics: it only invalidates
    // the mounted subscription at local midnight. The server resolves the
    // scholar's institution and current local day authoritatively.
    const timeZone = await timeZoneForScholar(ctx, scholarId);
    const currentDayKey = dayKeyForTimezone(Date.now(), timeZone);
    const practicedTodayKeys = new Set<string>();
    for (const row of mastery.values()) {
      if (
        row.lastAttemptAt !== undefined
        && dayKeyForTimezone(row.lastAttemptAt, timeZone) === currentDayKey
      ) {
        practicedTodayKeys.add(row.skillKey);
      }
    }


    const stateOf = await buildFrontierStateOf(ctx, scholarId, skills.map((s) => s.skillKey), edges, mastery);
    const firstBlock = await firstRequiredBlockScheduling(
      ctx,
      scholarId,
      domain,
      mastery,
      skills,
      edges,
      stateOf,
    );
    const queue = nextPractice(
      skills.map((s) => s.skillKey),
      edges.map((e) => ({ fromKey: e.fromKey, toKey: e.toKey })),
      stateOf,
      Date.now(),
      5,
      {
        ...buildStrandScheduling(
          skills,
          edges,
          mastery,
          gradeLevel,
          strandHint,
          undefined,
          firstBlock,
          undefined,
          // Placement is a hard rule ABOVE the checkpoint: while the first
          // post-placement block is active, suppress the soft steer so the
          // just-placed frontier (not the checkpoint) owns the block.
          !firstBlock.active && preferredCheckpoint?.domain === domain
            ? preferredCheckpoint
            : undefined,
        ),
        applyMixFloor: true,
        remediationSkillKey: await computeRemediationSkillKey(ctx, scholarId, domain, mastery, edges),
      },
    );
    const runnable = await runnableSkillKeySet(ctx, queue.map((q) => q.key));

    // Scholar-facing redaction (§5): the auto-remediation reason never reaches a
    // scholar surface — a "remediation" row renders as ordinary practice.
    const baseRegularSet = queue.filter((q) => q.reason !== "challenge" && runnable.has(q.key)).map((q) => ({
      key: q.key,
      label: labelOf.get(q.key) ?? q.key,
      reason: (q.reason === "review" ? "review" : "new") as "review" | "new",
      strand: q.strand,
      doneToday: practicedTodayKeys.has(q.key),
    }));
    const automaticStretch = domainClimb(
      skills.map((skill) => skill.skillKey),
      mastery.values(),
    )
      .accessComplete
      ? await stretchTailForScholar(
          ctx,
          scholarId,
          domain,
          mastery,
          labelOf,
          0,
          new Set(skills.map((skill) => skill.skillKey)),
        )
      : [];
    const regularSet = [
      ...baseRegularSet,
      ...automaticStretch.map((item) => ({
        key: item.itemId,
        label: item.skillLabel,
        reason: "stretch" as const,
        strand: strandByKey.get(item.skillKey) ?? "",
        doneToday: false,
      })),
    ];

    // Challenge-tail items — above-band frontier nodes the grade band withheld,
    // used to power (a) the `hasChallengeItems` flag that shows/hides the
    // Stretch tile and (b) the `stretchHint` recompose: when `stretchHint` is
    // true, the `set` is replaced by these so the scholar sees what the stretch
    // round will actually contain. `runnable` covers the template check for the
    // preview (the in-session serve uses `hasTemplate` for challenge keys
    // specifically, so the preview may be slightly optimistic — acceptable for
    // a stand-in). Strand is kept as-is (challenge items are frontier nodes;
    // their strand is informational, never used for tile selection).
    const challengeItems = queue
      .filter((q) => q.reason === "challenge" && runnable.has(q.key))
      .map((q) => ({
        key: q.key,
        label: labelOf.get(q.key) ?? q.key,
        strand: q.strand,
      }));

    // When stretchHint is set, recompose to show only the challenge tail
    // (the opt-in bonus). Reviews are required and served before the stretch
    // round in-session — they are NOT shown in the stretch preview so the
    // scholar can focus on what's new. The required set is still served first
    // when the actual session runs; the preview is intentionally narrowed.
    const set = args.stretchHint && challengeItems.length > 0
      ? challengeItems.map((item) => ({
          key: item.key,
          label: item.label,
          reason: "new" as const,
          strand: item.strand,
          doneToday: practicedTodayKeys.has(item.key),
        }))
      : regularSet;

    // Next-up is always the first runnable item in the scheduler's own queue.
    let nextUp: { key: string; label: string; reason: "teacher" | "review" | "next" } | null = null;
    if (!args.stretchHint) {
      const first = regularSet.find((s) => !s.doneToday) ?? regularSet[0];
      if (first) {
        nextUp = { key: first.key, label: first.label, reason: first.reason === "review" ? "review" : "next" };
      }
    } else {
      const first = set.find((s) => !s.doneToday) ?? set[0];
      if (first) {
        nextUp = { key: first.key, label: first.label, reason: "next" };
      }
    }

    // Placement gate (mirrors the `needsPlacement` query): only a converged
    // placement run maps a domain. Mastery without one is shadow placement, so
    // the card must still open the check-in rather than treating practice as a
    // substitute for the diagnostic.
    const placement = await ctx.db
      .query("practicePlacements")
      .withIndex("by_scholar_domain", (q) => q.eq("scholarId", scholarId).eq("domain", domain))
      .first();
    const needsPlacement = !isMappedPlacementStatus(placement?.status);

    // Option D (OPTION_D_RULINGS Q6): mapping-aware preview. When `includeMapping`
    // is set (the default/You-Pick Home entries), recompose the preview `set` to
    // the SAME `· mapping` composition `practiceSession` will serve, so the Home
    // preview and Start never disagree. Mirrors `finalizeWithMapping` exactly: an
    // UNMAPPED resolved domain suppresses its ordinary frontier rows and the set
    // leads with the mapping band (all-mapping); a PLACED domain keeps reviews
    // first, then the ≤2 mapping items, then new work (blend). Skipped for stretch
    // and for a fully-placed scholar (the `anyUnmappedDomain` pre-check is cheap).
    type PreviewRow = {
      key: string;
      label: string;
      reason: "review" | "new" | "mapping" | "stretch";
      strand: string;
      doneToday: boolean;
      /** Never set on the legacy path — declared so the wire union with the
       *  focus branch's rows keeps `sweep` readable on clients. */
      sweep?: boolean;
    };
    let mappingSet: PreviewRow[] | null = null;
    let mappingNextUp: { key: string; label: string; reason: "teacher" | "review" | "next" } | null = null;
    let previewAllMapping = false;
    if (
      args.includeMapping &&
      !args.stretchHint &&
      (await anyUnmappedDomain(ctx, scholarId, practiceScope))
    ) {
      const mappingState = await loadMappingState(ctx, scholarId);
      const domainUnmapped = mappingState.ordinarySuppressed.has(domain);
      // Ordinary rows survive ONLY for a PLACED resolved domain — an unmapped
      // domain's frontier work is suppressed (its spots become mapping items),
      // exactly as `finalizeWithMapping` does at serve time.
      const kept: PreviewRow[] = domainUnmapped ? [] : regularSet;
      const hasOtherServable = kept.length > 0;
      const deliberateMappingDomain = strandHint !== undefined ? domain : undefined;
      const built = await buildMappingItems(
        ctx,
        scholarId,
        0,
        mappingState,
        hasOtherServable,
        deliberateMappingDomain,
        deliberateMappingDomain,
        practiceScope,
      );
      if (built.mappingItems.length > 0) {
        previewAllMapping = built.allMapping;
        const mappingRows: PreviewRow[] = built.mappingItems.map((it) => ({
          key: it.itemId,
          label: it.skillLabel,
          reason: "mapping" as const,
          strand: strandByKey.get(it.skillKey) ?? "",
          doneToday: false,
        }));
        const reviews = kept.filter((r) => r.reason === "review");
        const rest = kept.filter((r) => r.reason !== "review");
        mappingSet = [...reviews, ...mappingRows, ...rest];
        // Next-up leads with the first due review (reviews are never displaced),
        // else the first mapping item — matching the served order.
        const firstReview = reviews.find((r) => !r.doneToday) ?? reviews[0];
        mappingNextUp = firstReview
          ? { key: firstReview.key, label: firstReview.label, reason: "review" }
          : { key: mappingRows[0].key, label: mappingRows[0].label, reason: "next" };
      }
    }

    // The Launchpad, resolved for the PREVIEW by the same `resolveRunLaunchpad`
    // the served run uses (P1). The whole point of this card is to be a faithful
    // stand-in for what Start serves; before this, Start could open with an
    // instructional doorway the preview never mentioned, so the set the scholar
    // was shown and the set they got differed by a whole beat.
    //
    // Read-only by construction: resolving is a pure read (no impression claim,
    // no offerCount bump), so previewing never burns the once-a-day offer — the
    // claim still happens on mount in-session. Gated to the scholar themself
    // (a teacher reading the card must not see, or influence, the doorway) and
    // skipped for the stretch preview, whose rows are challenge-tail items
    // relabelled `new` — they are NOT new-lane frontier work and must not
    // qualify. Only display fields are returned; the atoms stay in
    // `practiceSession`, off this subscribed home query.
    const previewRows = (mappingSet ?? set) as PreviewRow[];
    let launchpadPreview:
      | { at: number; title: string; subtitle?: string; domain: string; strand: string }
      | undefined;
    if (!isTeacher && !args.stretchHint && !needsPlacement) {
      const resolved = await resolveRunLaunchpad(
        ctx,
        true,
        scholarId,
        previewRows.map((r) => ({
          skillKey: r.key,
          domain,
          // The preview's row `reason` IS its serving lane, with one mismatch
          // the type system can't catch: a `mapping` row is a placement probe,
          // never new frontier work. `selectRunLaunchpad` only admits "new".
          lane: r.reason,
        })),
        {
          strandByKey,
          strandsWithMastery: strandsWithMasteryFrom(domain, skills, mastery),
          fallbackDomain: domain,
          platform: args.platform ?? "web",
          masteryByKey: mastery,
        },
      );
      if (resolved) {
        launchpadPreview = {
          at: resolved.at,
          title: resolved.entry.title,
          subtitle: resolved.entry.subtitle,
          domain: resolved.entry.target.domain,
          strand: resolved.entry.target.strand,
        };
      }
    }

    return {
      domain,
      nextUp: mappingSet ? mappingNextUp : nextUp,
      set: previewRows,
      practicedToday: practicedTodayKeys.size > 0,
      skillsPracticedToday: practicedTodayKeys.size,
      everPracticed: [...mastery.values()].some(
        (row) => row.lastAttemptAt !== undefined,
      ),
      needsPlacement,
      firstPostPlacementBlock: firstBlock.active,
      /** True when the session has a non-empty challenge tail — the only
       *  condition that shows the Stretch playlist tile. Zero new thresholds. */
      hasChallengeItems: challengeItems.length > 0,
      /** Option D: the preview `set` is the `· mapping` composition (drives the
       *  `· mapping` chips + the ceremony-lite framing on the Home card). */
      mappingPreview: mappingSet !== null,
      /** Option D: the previewed run is 100% mapping (nothing else servable). */
      allMapping: previewAllMapping,
      /** The instructional doorway this run will open with, and the `set` index
       *  it sits BEFORE — resolved by the served run's own selector, so the card
       *  lists the same beats Start will serve. Absent when there is none. */
      launchpad: launchpadPreview,
    };
  },
});

/** `domain \u0000 strand` for every strand the scholar has ANY mastery row in —
 *  i.e. NOT new territory. Built from the domain's full skill list (not just the
 *  served items), because a strand is only "new" if the scholar has no mastery
 *  ANYWHERE in it; checking only the run's items would call a strand new when
 *  the scholar already has rows on its other skills. */
export function strandsWithMasteryFrom(
  domain: string,
  skills: { skillKey: string; strand?: string }[],
  mastery: Map<string, unknown>,
): Set<string> {
  const out = new Set<string>();
  for (const s of skills) {
    const strand = s.strand;
    if (!strand) continue;
    if (mastery.has(s.skillKey)) out.add(`${domain}\u0000${strand}`);
  }
  return out;
}

/**
 * Resolve the Launchpad for a COMPOSED run — the entry to show and the item
 * index to show it before — or `undefined`.
 *
 * This is the run-anchored replacement for `instructionForDaily`'s graph-order
 * pick. Everything it decides is derived from the items the run will actually
 * serve, so the Launchpad can only ever introduce work that is present (see
 * `selectRunLaunchpad`'s comment for the defect this closes).
 *
 * Returns the entry as SIBLING data, never as a member of `items`: `items` stays
 * the graded array, which is what keeps `masteryEffect: "none"` structural
 * rather than a trusted flag — an ungraded beat that is not in the graded array
 * cannot be graded by any code path, including a future one.
 */
async function resolveRunLaunchpad(
  ctx: Parameters<typeof loadMastery>[0],
  /** True only when the SCHOLAR themself is the one practising. A teacher
   *  reading a scholar's run (or any other viewer) never gets a Launchpad: the
   *  doorway claims an impression on mount and burns the scholar's once-a-day
   *  offer, so a remote read would silently spend it. This preserves the guard
   *  the retired `instructionForDaily` query carried. */
  isSelf: boolean,
  scholarId: Id<"users">,
  /** Structurally a `ServedItem[]` at serve time, but deliberately narrowed to
   *  the three fields selection actually reads so the HOME PREVIEW
   *  (`playlistForScholar`) can call this SAME resolver over its preview rows.
   *  One selector, two callers: a second picker here is exactly how the run and
   *  the doorway came to disagree in the first place. */
  items: { skillKey: string; domain?: string; lane?: string }[],
  opts: {
    strandByKey: Map<string, string | undefined>;
    strandsWithMastery: Set<string>;
    fallbackDomain: string;
    /** The requesting client's platform — a Launchpad authored `platforms: ["web"]`
     *  must never surface on native, and vice versa. Defaults to "web" so every
     *  pre-existing caller (none of which passed this) is unchanged; today's
     *  authored content is always `["web", "native"]`, so the default is a
     *  no-op until content actually diverges by platform. */
    platform?: "web" | "native";
    /** Node doorway (§4.1): skillKey → the scholar's mastery row, if any — the
     *  SAME per-skill mastery map every caller already builds for scheduling.
     *  Optional; a caller that omits it gets strand-only behavior, unchanged
     *  from pre-§4.1 (the node doorway simply never fires for it). */
    masteryByKey?: Map<string, unknown>;
  },
): Promise<{ at: number; entry: InstructionEntry } | undefined> {
  if (!isSelf) return undefined;
  if (items.length === 0) return undefined;

  const platform = opts.platform ?? "web";

  const runItems: RunItemLike[] = items.map((it) => ({
    skillKey: it.skillKey,
    domain: it.domain ?? opts.fallbackDomain,
    strand: opts.strandByKey.get(it.skillKey),
    lane: it.lane,
  }));

  // Content lookup is memoized by key (strand OR node), so a repeated strand
  // costs one query, not one per item. (The read is a prefetch, not lazy: the
  // loop below resolves every CANDIDATE up front, because the selector is
  // deliberately pure/sync and so cannot await a lookup mid-scan.)
  const contentCache = new Map<string, Doc<"instructionContent"> | null>();
  const loadEligibleContent = async (key: string) => {
    const hit = contentCache.get(key);
    if (hit !== undefined) return hit;
    const rows = await ctx.db
      .query("instructionContent")
      .withIndex("by_key_status", (q) => q.eq("key", key).eq("verifyStatus", "passed"))
      .collect();
    // Only rows authored for THIS platform are eligible — the whole point of
    // the schema's `platforms` field is that a web-only (or native-only)
    // Launchpad must never surface on the other client.
    const eligible = rows.filter((r) => (r.platforms ?? []).includes(platform));
    let best: Doc<"instructionContent"> | null = null;
    if (eligible.length > 0) {
      const top = eligible.reduce((a, b) => (b.version > a.version ? b : a));
      // Defensive: never surface an empty card.
      if ((top.atoms?.length ?? 0) > 0) best = top;
    }
    contentCache.set(key, best);
    return best;
  };
  const loadContent = (domain: string, strand: string) =>
    loadEligibleContent(strandInstructionKey(domain, strand));
  const loadNodeContent = (skillKey: string) => loadEligibleContent(nodeInstructionKey(skillKey));

  // Pre-resolve content for every candidate the selector could reach:
  //  - STRAND doorway: NEW-lane, stranded items whose whole strand is still
  //    zero-mastery (unchanged from pre-§4.1);
  //  - NODE doorway (§4.1): NEW-lane items whose specific NODE is zero-mastery,
  //    regardless of the strand's mastery state — a hard node inside an
  //    otherwise-known strand is exactly the case node grain exists for.
  for (const it of runItems) {
    if (it.lane !== "new" || !it.strand) continue;
    if (!opts.strandsWithMastery.has(`${it.domain}\u0000${it.strand}`)) {
      await loadContent(it.domain, it.strand);
    }
    if (opts.masteryByKey && !opts.masteryByKey.has(it.skillKey)) {
      await loadNodeContent(it.skillKey);
    }
  }
  if ([...contentCache.values()].every((v) => v === null)) return undefined;

  const events = await ctx.db
    .query("instructionEvents")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  const eventByKey = new Map<string, InstructionEventLike>(events.map((e) => [e.key, e]));
  const timeZone = await timeZoneForScholar(ctx, scholarId);
  const dayBucket = dayKeyForTimezone(Date.now(), timeZone);

  const chosen = selectRunLaunchpad({
    items: runItems,
    hasMasteryInStrand: (domain, strand) =>
      opts.strandsWithMastery.has(`${domain}\u0000${strand}`),
    hasContent: (domain, strand) =>
      contentCache.get(strandInstructionKey(domain, strand)) != null,
    ...(opts.masteryByKey
      ? {
          hasMasteryOnNode: (skillKey: string) => opts.masteryByKey!.has(skillKey),
          hasNodeContent: (skillKey: string) => contentCache.get(nodeInstructionKey(skillKey)) != null,
        }
      : {}),
    eventByKey,
    dayBucket,
  });
  if (!chosen) return undefined;

  const content = contentCache.get(chosen.key);
  if (!content) return undefined;
  return {
    at: chosen.at,
    entry: {
      id: `${chosen.key}:v${content.version}`,
      offerId: instructionOfferId(scholarId, chosen.key),
      kind: "launchpad",
      level: chosen.level,
      key: chosen.key,
      target:
        chosen.level === "node"
          ? { domain: chosen.domain, strand: chosen.strand, nodeKey: chosen.nodeKey }
          : { domain: chosen.domain, strand: chosen.strand },
      title: content.title,
      subtitle: content.subtitle,
      fork: { tryFirstLabel: TRY_FIRST_LABEL, showMeLabel: SHOW_ME_LABEL },
      atoms: content.atoms as InstructionAtom[],
      contentVersion: content.version,
      masteryEffect: "none",
    },
  };
}

/**
 * Resolve the GAME BEAT for a run — the sibling of `resolveRunLaunchpad`.
 *
 * Same contract, same guards, same reason: the beat is chosen FROM the served
 * items so it can never introduce work the run does not contain, and it is
 * returned as `{at, entry}` beside `items` rather than inside it, so the graded
 * array, the cursor and the accuracy calculation never learn that games exist.
 *
 * Like the Launchpad this is advisory — a query cannot write, so
 * `practiceGames.claimGameBeatOffer` re-checks the budget authoritatively when
 * the doorway actually mounts.
 */
async function resolveRunGameBeat(
  ctx: Parameters<typeof loadMastery>[0],
  /** Scholar-only, for the same reason the Launchpad is: the doorway claims an
   *  impression on mount, so a teacher reading a scholar's run would silently
   *  spend the scholar's daily offer. */
  isSelf: boolean,
  scholarId: Id<"users">,
  items: { skillKey: string; domain?: string; lane?: string }[],
  opts: {
    strandByKey: Map<string, string | undefined>;
    fallbackDomain: string;
    /** D-5, applied at selection: no beat is chosen for a client that cannot
     *  play it, so the scholar's daily offer is only ever spent where the
     *  doorway actually opens. */
    canPlayGames: boolean;
  },
): Promise<RunGameBeat | undefined> {
  if (!isSelf) return undefined;
  if (!opts.canPlayGames) return undefined;
  if (items.length === 0) return undefined;

  const runItems = items.map((it) => ({
    skillKey: it.skillKey,
    domain: it.domain ?? opts.fallbackDomain,
    strand: opts.strandByKey.get(it.skillKey),
    lane: it.lane,
  }));

  // Only the (domain, strand) pairs the run actually serves are queried — a
  // binding for a strand nobody is working can never cost a read.
  const pairs = new Set<string>();
  for (const it of runItems) {
    if (it.strand) pairs.add(`${it.domain}\u0000${it.strand}`);
  }
  if (pairs.size === 0) return undefined;

  const bindingRows: Doc<"practiceGameBindings">[] = [];
  for (const pair of pairs) {
    const [domain, strand] = pair.split("\u0000");
    const rows = await ctx.db
      .query("practiceGameBindings")
      .withIndex("by_domain_strand", (q) => q.eq("domain", domain).eq("strand", strand))
      .collect();
    for (const row of rows) if (row.isActive) bindingRows.push(row);
  }
  if (bindingRows.length === 0) return undefined;

  const bindings: GameBindingLike[] = bindingRows.map((b) => ({
    activityId: String(b.activityId),
    domain: b.domain,
    strand: b.strand,
    skillKeys: b.skillKeys ?? null,
    isActive: b.isActive,
  }));

  const offers = await ctx.db
    .query("practiceGameOffers")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  const offerByKey = new Map<string, GameOfferLike>(offers.map((o) => [o.key, o]));

  // "Has this scholar played it, and when" is read from `gameSessions` — the
  // canonical record — rather than mirrored into the offer ledger.
  const lastPlayedByActivity = new Map<string, number>();
  for (const b of bindingRows) {
    const last = await ctx.db
      .query("gameSessions")
      .withIndex("by_scholar_activity", (q) =>
        q.eq("scholarId", scholarId).eq("activityId", b.activityId),
      )
      .order("desc")
      .first();
    if (last) lastPlayedByActivity.set(String(b.activityId), last.startedAt);
  }

  const timeZone = await timeZoneForScholar(ctx, scholarId);
  const now = Date.now();
  const chosen = selectRunGameBeat({
    items: runItems,
    bindings,
    offerByKey,
    lastPlayedByActivity,
    dayBucket: dayKeyForTimezone(now, timeZone),
    now,
  });
  if (!chosen) return undefined;

  const row = bindingRows.find((b) => String(b.activityId) === chosen.binding.activityId);
  if (!row) return undefined;
  const activity = await ctx.db.get(row.activityId);
  // A binding whose activity was deleted, un-gamed, or renamed to a game the
  // catalog no longer carries silently offers nothing. Never a broken doorway.
  const gameId = activity?.kind === "game" ? activity.game?.gameId : undefined;
  if (!activity || !gameId) return undefined;

  const entry: GameBeatEntry = {
    id: `${chosen.key}:${row._id}`,
    offerId: gameBeatOfferId(String(scholarId), chosen.key),
    kind: "game_beat",
    key: chosen.key,
    activityId: String(row.activityId),
    gameId,
    title: activity.title,
    // Scholar-facing playlist subtitle — scholar copy only.
    ...(activity.scholarDescription ? { subtitle: activity.scholarDescription } : {}),
    ...(row.blurb ? { blurb: row.blurb } : {}),
    target: { domain: row.domain, strand: row.strand },
    platform: "native",
    masteryEffect: "none",
  };
  return { at: chosen.at, entry };
}


/**
 * Generate a deterministic set of template items for a skill (the drill core).
 * Pure generation — no writes. Returns [] for a skill that has no template
 * (conceptual nodes get authored / LLM-generated items later).
 */
export const practiceSet = authedQuery({
  args: { skillKey: v.string(), count: v.optional(v.number()), seed: v.optional(v.number()) },
  handler: async (_ctx, args) => {
    return generateSet(args.skillKey, args.count ?? 8, args.seed ?? Date.now() >>> 0);
  },
});

// ── Mixed-domain playlists ─────────────────────────────────────────────────
// A standing playlist may blend SEVERAL practice domains into one interleaved
// session. The engine stays single-domain per skill (each domain's graph,
// mastery, and frontier are computed independently, in computeDomainQueue
// below); the pure queue-level merge — reviews-first global by decay, then
// round-robined frontier — lives in lib/practice/mixedQueue.ts so it unit-tests
// standalone. The submit path needs nothing special: submitAnswer already
// resolves each item's domain from its own skill (by_nodeKey), so a blended
// session records to the right domain automatically.

/** A single domain's computed practice queue plus the per-domain context the
 *  shared item-loader needs. Structurally a MergeableDomainQueue (domain +
 *  entries) plus skills+mastery for serveFromQueue. `reason` is folded to
 *  review|new (remediation flows like a review); `retention` lets the
 *  cross-domain merge rank reviews globally by decay. */
type DomainQueue = {
  domain: string;
  skills: {
    skillKey: string;
    label: string;
    strand?: string;
    order?: number;
  }[];
  mastery: Map<string, Doc<"practiceMastery">>;
  entries: {
    key: string;
    reason: "review" | "new";
    schedulerReason: NextPracticeReason;
    isConfirmation: boolean;
    retention: number;
    strand: string;
  }[];
  challengeEntries: {
    key: string;
    retention: number;
    strand: string;
  }[];
  /** True when this domain is serving its first post-placement calibration block
   *  (raise-the-ceiling) — surfaced so a blended session can report it too. */
  firstPostPlacementBlock: boolean;
  calibrationSkillKeys: readonly string[];
};

/** Compute the whole-graph next-practice queue for ONE domain — identical to
 *  the single-domain path's frontier logic, factored out so a mixed session can
 *  call it per domain and merge the results. `opts.limit` is the queue depth to
 *  compute (defaults to `PRACTICE_SESSION_SIZE`) — it MUST match the size a
 *  caller actually intends to serve, because `applyMixFloor`'s frontier floor
 *  (`ceil(limit / 4)`) is only a real guarantee against the returned `limit`
 *  itself, not some larger candidate pool a caller later truncates. */
async function computeDomainQueue(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  domain: string,
  opts: {
    strandHint?: string;
    excludedStrands?: string[];
    frontierAllowedStrands?: readonly string[];
    preferredCheckpoint?: CheckpointTarget;
    applyMixFloor?: boolean;
    limit?: number;
  },
): Promise<DomainQueue> {
  const { practiceScope } = await resolvePracticeScope(ctx, scholarId);
  const scoped = scopeLoadedDomain(practiceScope, domain, await loadDomain(ctx, domain));
  const { skills, edges } = scoped;
  const mastery = await loadMastery(ctx, scholarId, domain);
  if (skills.length === 0) {
    return {
      domain,
      skills,
      mastery,
      entries: [],
      challengeEntries: [],
      firstPostPlacementBlock: false,
      calibrationSkillKeys: [],
    };
  }
  const gradeLevel = await scholarGradeLevel(ctx, scholarId);
  const now = Date.now();
  const remediationSkillKey = await computeRemediationSkillKey(ctx, scholarId, domain, mastery, edges);
  const stateOf = await buildFrontierStateOf(ctx, scholarId, skills.map((s) => s.skillKey), edges, mastery);
  const firstBlock = await firstRequiredBlockScheduling(
    ctx,
    scholarId,
    domain,
    mastery,
    skills,
    edges,
    stateOf,
  );
  const scheduling = buildStrandScheduling(
    skills,
    edges,
    mastery,
    gradeLevel,
    opts.strandHint,
    opts.excludedStrands,
    firstBlock,
    opts.frontierAllowedStrands,
    // Placement is a hard rule above the checkpoint (see playlistForScholar).
    firstBlock.active ? undefined : opts.preferredCheckpoint,
  );
  const queue = nextPractice(
    skills.map((s) => s.skillKey),
    edges,
    stateOf,
    now,
    opts.limit ?? PRACTICE_SESSION_SIZE,
    {
      ...scheduling,
      applyMixFloor: opts.applyMixFloor ?? true,
      remediationSkillKey,
    },
  );
  const runnable = await runnableSkillKeySet(ctx, queue.map((q) => q.key));
  const entries = queue
    .filter((q) => q.reason !== "challenge" && runnable.has(q.key))
    .map((q) => ({
      key: q.key,
      // Remediation is injected into the reviews channel — treat it as a review.
      reason: (q.reason === "new" ? "new" : "review") as
        | "review"
        | "new",
      schedulerReason: q.reason,
      isConfirmation:
        q.reason === "review" &&
        (scheduling.inferredDueCredit?.(q.key) ?? false),
      retention: retention(stateOf(q.key), now),
      strand: q.strand,
    }));
  const challengeEntries = queue
    .filter((q) => q.reason === "challenge" && runnable.has(q.key))
    .map((q) => ({
      key: q.key,
      retention: retention(stateOf(q.key), now),
      strand: q.strand,
    }));
  return {
    domain,
    skills,
    mastery,
    entries,
    challengeEntries,
    firstPostPlacementBlock: firstBlock.active,
    calibrationSkillKeys: firstBlock.calibrationSkillKeys,
  };
}


/** One `ChoiceCard` per DISTINCT active strand in a domain's computed queue —
 *  the pure extraction step `choiceSetForSelf` (round-robined across
 *  domains) and `newTerritoryCards` (one-per-not-started-domain) both build on,
 *  so neither forks the underlying frontier logic. */
function cardsForDomainQueue(queue: DomainQueue): ChoiceCard[] {
  const labelByKey = new Map(queue.skills.map((skill) => [skill.skillKey, skill.label]));
  const seenStrands = new Set<string>();
  return queue.entries.flatMap((entry) => {
    if (entry.reason !== "new" || !entry.strand || seenStrands.has(entry.strand)) return [];
    seenStrands.add(entry.strand);
    return [{
      domain: queue.domain,
      domainLabel: practiceDomainLabel(queue.domain),
      strand: entry.strand,
      sampleSkillKey: entry.key,
      sampleSkillLabel: labelByKey.get(entry.key) ?? entry.key,
    }];
  });
}

/** The `choiceSetForSelf`/`newTerritoryCards` wire shape — one bounded
 *  frontier (domain, strand) choice, sampling the concrete skill it will
 *  actually serve. */
type ChoiceCard = {
  domain: string;
  domainLabel: string;
  strand: string;
  sampleSkillKey: string;
  sampleSkillLabel: string;
};

async function choiceSetForScholar(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  domains?: string[],
): Promise<ChoiceCard[]> {
  const { practiceScope } = await resolvePracticeScope(ctx, scholarId);

  const registered = new Set(PRACTICE_DOMAINS.map((d) => d.domain));
  const requested =
    domains?.length
      ? domains
      : scopeDomains(practiceScope);
  const selectedDomains = Array.from(new Set(requested)).filter((domain) =>
    registered.has(domain) && practiceScopeAllowsDomain(practiceScope, domain),
  );
  const perDomain = await Promise.all(
    selectedDomains.map((domain) =>
      computeDomainQueue(ctx, scholarId, domain, {}),
    ),
  );

  return roundRobin(perDomain.map(cardsForDomainQueue)).slice(0, 3);
}

/**
 * One `ChoiceCard` per REACHABLE above-ring domain (raise-the-ceiling
 * ceiling-lift, `scratch-critiques/territory-offer-trace.md` §1): a domain
 * that is grade-ineligible (outside the scholar's affect-safe ring, so
 * `computeDomainQueue`'s grade-band scheduler would demote its frontier to
 * `challenge` and drop it) but whose every cross-domain prerequisite has
 * already CONVERGED (`DomainMapEntry.reachable`, `lib/practice/domainMapStatus.ts`).
 *
 * The sample skill comes from the SAME derivation the deliberate-pick serve
 * path uses — `mappingCandidatesForDomain` scoped to just this one domain,
 * exactly as `buildMappingItems`'s `forceLeadDomain` branch scans it — so the
 * card can never promise a strand/skill the serve path would refuse to open.
 * `computeDomainQueue` is deliberately NOT used here: its grade band is
 * exactly what drops the card today.
 *
 * Reuses the existing no-mastery filter semantics (`newTerritoryCardsForScholar`
 * only offers domains the scholar hasn't touched): a `reachable` domain that
 * already carries mastery is skipped, matching every other candidate here.
 */
async function reachableDomainCardsForScholar(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  excluded: Set<string>,
  practiceScope: PracticeScope,
): Promise<ChoiceCard[]> {
  // ── Cheap pre-check before the full-registry load ──────────────────────────
  // `loadMappingState` reads every seeded domain's nodes+edges+mastery (~1-1.5k
  // docs), and this runs on every Home chooser invalidation — while almost no
  // scholar has a reachable domain on any given day. Gate it on STATIC seed
  // meta (`DOMAIN_REACHABILITY_STATIC`, drift-tested against the DB derivation)
  // plus ONE indexed placements read: a domain can only be reachable if it is
  // above the scholar's ring, unconverged, and every prereq domain has a
  // converged run. False positives just fall through to the authoritative
  // derivation below; the drift test guards against false negatives.
  const scholarGrade = await scholarGradeLevel(ctx, scholarId);
  const ringGrade = automaticPlacementGrade(scholarGrade);
  const placementRows = await ctx.db
    .query("practicePlacements")
    .withIndex("by_scholar_domain", (q) => q.eq("scholarId", scholarId))
    .collect();
  const convergedDomains = new Set(
    placementRows.filter((r) => r.status === "complete").map((r) => r.domain),
  );
  const maybeReachable = DOMAIN_REACHABILITY_STATIC.some(
    (m) =>
      (m.elective || !domainHasAffectSafeEntry(m.nodeGrades, ringGrade)) &&
      practiceScopeAllowsDomain(practiceScope, m.domain) &&
      !convergedDomains.has(m.domain) &&
      !excluded.has(m.domain) &&
      m.prereqDomains.every((p) => convergedDomains.has(p)),
  );
  if (!maybeReachable) return [];

  const state = await loadMappingState(ctx, scholarId);
  const orderIndex = new Map(state.domains.map((d, i) => [d.domain, i] as const));
  const reachableDomains = new Set(
    state.summary.perDomain.filter((e) => e.reachable).map((e) => e.domain),
  );
  const cards: ChoiceCard[] = [];
  for (const d of state.domains) {
    if (!practiceScopeAllowsDomain(practiceScope, d.domain)) continue;
    if (!reachableDomains.has(d.domain)) continue;
    if (excluded.has(d.domain)) continue;
    if (state.runtime.get(d.domain)!.hasMastery) continue;
    // A primed run (row exists, zero answered) may carry a parked servedProbe —
    // the ghost guard re-serves THAT probe verbatim, so the card must sample it
    // too or the tile could promise a different skill than Start opens.
    const parked = state.runtime.get(d.domain)!.placementRow?.servedProbe;
    const sample = parked
      ? { strand: parked.strand, probeKey: parked.nodeKey }
      : orderMappingCandidates(
          mappingCandidatesForDomain(
            d,
            state.runtime.get(d.domain)!.placementRow,
            placementGradePriors(d.domain, state.domains, state.runtime, state.scholarGrade),
            orderIndex.get(d.domain) ?? 999,
            MAPPING_SIT_CAP,
          ),
          d.domain,
        )[0];
    if (!sample) continue; // no probeable strand left — nothing to offer yet
    cards.push({
      domain: d.domain,
      domainLabel: practiceDomainLabel(d.domain),
      strand: sample.strand,
      sampleSkillKey: sample.probeKey,
      sampleSkillLabel: d.loaded.nodeByKey.get(sample.probeKey)?.label ?? sample.probeKey,
    });
  }
  return cards;
}

async function newTerritoryCardsForScholar(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  args: {
    excludeDomains?: string[];
    currentDomain?: string;
  },
): Promise<ChoiceCard[]> {
  const { practiceScope } = await resolvePracticeScope(ctx, scholarId);
  const excluded = new Set(args.excludeDomains ?? []);
  const candidates = PRACTICE_DOMAINS.map((d) => d.domain).filter(
    // Electives never take the ordinary (grade-band) door — their ONLY
    // entry is the reachable offer below, which gates on the prereq
    // DAG having converged. Without this, an in-ring elective would be
    // offered before the scholar has the footing its design assumes.
    (domain) =>
      practiceScopeAllowsDomain(practiceScope, domain) &&
      !excluded.has(domain) &&
      !ELECTIVE_PRACTICE_DOMAINS.has(domain),
  );
  const notStarted = await Promise.all(
    candidates.map(async (domain) => {
      const mastery = await loadMastery(ctx, scholarId, domain);
      return { domain, started: mastery.size > 0 };
    }),
  );
  const domains = notStarted.filter((d) => !d.started).map((d) => d.domain);

  const perDomain = await Promise.all(
    domains.map((domain) => computeDomainQueue(ctx, scholarId, domain, {})),
  );
  const ordinaryCards = perDomain.flatMap((queue) =>
    cardsForDomainQueue(queue).slice(0, 1),
  );
  // Above-ring domains reachable via the prereq DAG (raise-the-ceiling) join
  // the offer — this surface already offers every domain (autoBlend/
  // standing). Domains already represented by an ordinary card are never
  // duplicated.
  const ordinaryDomains = new Set(ordinaryCards.map((c) => c.domain));
  const reachableCards = (
    await reachableDomainCardsForScholar(ctx, scholarId, excluded, practiceScope)
  ).filter((c) => !ordinaryDomains.has(c.domain));
  return [...ordinaryCards, ...reachableCards];
}

/**
 * Up to three bounded frontier choices for the authenticated scholar. Each card
 * represents one domain/strand pair and samples the first runnable NEW skill in
 * that scheduler queue. Domains are round-robined so a mixed playlist does not
 * let one larger graph crowd out the others.
 */
export const choiceSetForSelf = authedQuery({
  args: { domains: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    await requireActiveLearnerInstitution(ctx, ctx.user._id);
    return choiceSetForScholar(ctx, ctx.user._id, args.domains);
  },
});

/**
 * One representative `ChoiceCard` per registered domain the scholar has NOT
 * yet STARTED (no mastery rows), excluding any domain already represented
 * elsewhere (the caller passes the domains already shown by
 * `choiceSetForSelf`'s round-robined picks). The "You Pick" tile-row twin of
 * the old standalone "Explore a new territory" pills (raise-the-ceiling
 * consolidation, f7): every not-yet-started domain still gets a discoverable
 * entry point — now a peer tile instead of a separate surface — tagged so the
 * caller can render a subtle "new" accent. Reuses the SAME `computeDomainQueue`
 * frontier logic `choiceSetForSelf` does (a domain with zero mastery has its
 * graph ROOTS as the "new" frontier, so this returns a real, servable card, not
 * a placeholder) — no forked composition. Uncapped (mirrors the old pills,
 * which never capped the explorable-domain list either); the caller wraps.
 */
export const newTerritoryCards = authedQuery({
  args: {
    excludeDomains: v.optional(v.array(v.string())),
    currentDomain: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireActiveLearnerInstitution(ctx, ctx.user._id);
    return newTerritoryCardsForScholar(ctx, ctx.user._id, args);
  },
});

/**
 * The native Home chooser's complete initial card set in one subscription.
 * `newTerritory` derives its exclusions from this transaction's `choiceSet`,
 * removing the client-side choiceSet → newTerritory waterfall while preserving
 * both standalone query payloads and behavior.
 */
export const choiceCardsForSelf = authedQuery({
  args: {
    domains: v.optional(v.array(v.string())),
    currentDomain: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireActiveLearnerInstitution(ctx, ctx.user._id);

    const choiceSet = await choiceSetForScholar(
      ctx,
      ctx.user._id,
      args.domains,
    );
    const newTerritory = await newTerritoryCardsForScholar(
      ctx,
      ctx.user._id,
      {
        excludeDomains: choiceSet.map((card) => card.domain),
        currentDomain: args.currentDomain,
      },
    );
    return { choiceSet, newTerritory };
  },
});

/**
 * The "More of your pick" done-screen bonus (raise-the-ceiling plan §C-3): the
 * next few frontier/review skills within ONE domain+strand pair — the scoped
 * follow-up offered after a session that ran with a `choiceHint`. Reuses
 * `computeDomainQueue`'s ordinary frontier/review logic (so every existing
 * gate — prereq/runnable gating, standing exclusions — applies identically)
 * and narrows the result to the requested strand only. The caller re-enters an
 * ordinary scoped session with the returned `skillKeys` (the same
 * `practiceSession({ skillKeys })` path a problem set or a tune-up uses) —
 * there is no new serve/grade code here.
 */
export const bonusSkillsForChoice = authedQuery({
  args: {
    domain: v.string(),
    strand: v.string(),
    count: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireActiveLearnerInstitution(ctx, ctx.user._id);
    const count = args.count ?? 4;
    // A generous candidate depth: the strand hint force-activates + double-
    // weights `args.strand`, but cross-strand due reviews and other active
    // frontier strands still compete for slots in the underlying queue, so a
    // small limit could starve this ONE strand of enough entries to fill
    // `count`. Over-fetching and then filtering to the strand is cheap (pure
    // in-memory logic over an already-loaded domain graph).
    const queue = await computeDomainQueue(ctx, ctx.user._id, args.domain, {
      strandHint: args.strand,
      limit: Math.max(count * 4, 16),
    });
    const labelByKey = new Map(queue.skills.map((s) => [s.skillKey, s.label]));
    const skillKeys = queue.entries
      .filter((e) => e.strand === args.strand)
      .slice(0, count)
      .map((e) => e.key);
    return {
      skillKeys,
      labels: skillKeys.map((k) => labelByKey.get(k) ?? k),
    };
  },
});

/**
 * Persist one scholar choice for teacher/observer analysis. The authenticated
 * scholar is always the owner; a repeated clientPickId is a successful no-op.
 */
export const logPracticeChoice = authedMutation({
  args: {
    domain: v.string(),
    strand: v.string(),
    source: v.union(
      v.literal("home_choice"),
      v.literal("bonus_more_of_pick"),
      v.literal("bonus_challenge"),
      v.literal("bonus_tuneup"),
    ),
    candidateSkillKeys: v.optional(v.array(v.string())),
    playlistDomains: v.optional(v.array(v.string())),
    clientPickId: v.string(),
  },
  handler: async (ctx, args) => {
    await requireActiveLearnerInstitution(ctx, ctx.user._id);

    const existing = await ctx.db
      .query("practiceChoiceEvents")
      .withIndex("by_scholar_createdAt", (q) => q.eq("scholarId", ctx.user._id))
      .filter((q) => q.eq(q.field("clientPickId"), args.clientPickId))
      .first();
    if (existing) return { eventId: existing._id, created: false };

    const eventId = await ctx.db.insert("practiceChoiceEvents", {
      scholarId: ctx.user._id,
      domain: args.domain,
      strand: args.strand,
      source: args.source,
      candidateSkillKeys: args.candidateSkillKeys,
      playlistDomains: args.playlistDomains,
      clientPickId: args.clientPickId,
      createdAt: Date.now(),
    });
    return { eventId, created: true };
  },
});

// ── Session serving (buildSession + stored-item mix + manipulative guarantee +
//    scaffold + lane + W0-a ordering) lives in lib/practice/serve.ts as the
//    policy-parameterized `serveItems`; `practiceSession` below is a thin consumer.

/**
 * Build a practice SESSION for a scholar: pick the next-practice skills (due
 * reviews + frontier) and serve `size` items drawn from them — stems only, NO
 * answers (graded server-side in `submitAnswer`). Deterministic in `seed` so a
 * given session is stable across re-renders. The core of the silent-practice
 * surface (review/practice/sketches.html §1).
 *
 * MIXED-domain: pass `domains` (≥2) to blend several domains into one
 * interleaved session (see the mixed-domain helpers above). `domain` (single)
 * stays supported and is the primary/first domain.
 */
// Recent-serve dedupe window (repeat-question fix §4): how far back to scan a
// scholar's GRADED practiceAttempts to build the "seen recently" set that
// serving prefers to avoid re-serving. A preference, never a starvation gate.
//
// Spans CONSECUTIVE PRACTICE DAYS (pilot9 J10 §a): the original 24h window only
// caught SAME-DAY repeats, so an identical stored word problem served on day N
// and again on day N+1 fell outside it (two serves on consecutive calendar days
// are up to just under 48h apart) and re-appeared — worse, it then counted as a
// second "two-in-a-row" toward `skill earned`. A 3-day window reliably covers
// the consecutive-day (and skip-a-day) case while still leaving unseen items in
// a realistically-sized pre-warmed pool (~6 items, served ~once/day for a given
// word-problem skill), so the guard never degrades to the exhausted-pool
// fallback in normal cadence. Cheap: `by_scholar_createdAt` bounds the scan to
// this window (~a few dozen rows for an active scholar).
const RECENT_DEDUPE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The scholar's recently-seen question identities over RECENT_DEDUPE_WINDOW_MS,
 * mapped to the canonical identity the serve-time selector compares against
 * (rendered stem/visual for template items, `gen#id` for stored/manipulative).
 * Threaded into `serveItems`/`buildSession` so exact repeats across the last few
 * practice days (incl. the consecutive-day case, pilot9 J10) are de-preferred.
 * Empty for a scholar with no recent graded attempts, in which case serving is
 * byte-identical to before.
 */
async function recentServedIdentities(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  now: number,
): Promise<Set<string>> {
  const since = now - RECENT_DEDUPE_WINDOW_MS;
  const rows = await ctx.db
    .query("practiceAttempts")
    .withIndex("by_scholar_createdAt", (q) =>
      q.eq("scholarId", scholarId).gte("createdAt", since),
    )
    .collect();
  const identities = new Set<string>();
  for (const r of rows) {
    if (r.itemId) identities.add(canonicalItemIdentity(r.itemId));
  }
  return identities;
}

// Teach-before-re-serve window: how far back serving looks for the MISS that
// arms the cold gate below. Bounded on `by_scholar_createdAt` exactly like
// `recentServedIdentities` above, rather than collecting a scholar's whole
// attempt history on every serve. The trade-off is deliberate: a miss older
// than the window is forgotten and the node serves bare again — fail-open
// toward status-quo serving. Harmless, because a node that shaky keeps coming
// back through the SR scheduler and the next miss re-arms the gate at once.
const COLD_FAILURE_WINDOW_MS = 45 * 24 * 60 * 60 * 1000;

/**
 * The queued nodes that are COLD: the scholar missed them and nothing
 * teaching-shaped has happened since, so they re-enter as a level-one
 * worked-step COMPLETION rather than a bare prompt. Cold is temporary — any
 * later correct answer or teaching clears it, and a node with no worked-step
 * content is still served (bare), never withheld.
 *
 * A node is cold iff BOTH:
 *  (a) its latest qualifying MISS is more recent than its latest correct
 *      answer. A miss qualifies when it is not a grade-only retry and not a
 *      placement/check-in probe (those diagnose where to START and must not
 *      alter placement's own handoff); a correct answer counts from ANY lane —
 *      a right placement answer is still proof.
 *  (b) nothing taught the node since that miss. Teaching is either canonical
 *      instruction the scholar actually ENGAGED with (`instructionEvents`
 *      viewed / completed / retrieved, for the node or its owning strand — the
 *      carve-out sanctioned in the schema comment) or the teach-on-miss moment
 *      recorded on the attempt row itself. A shown card, a dismissal, a "try it
 *      myself" choice, and a teaching moment the scholar left STUCK are
 *      deliberately not teaching.
 */
async function coldFailedSkillKeySet(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  candidates: Iterable<{ skillKey: string; domain: string; strand?: string }>,
  now: number,
): Promise<Set<string>> {
  const candidateByKey = new Map(
    [...candidates].map((candidate) => [candidate.skillKey, candidate]),
  );
  if (candidateByKey.size === 0) return new Set();

  const attempts = await ctx.db
    .query("practiceAttempts")
    .withIndex("by_scholar_createdAt", (q) =>
      q.eq("scholarId", scholarId).gte("createdAt", now - COLD_FAILURE_WINDOW_MS),
    )
    .collect();

  const latestFailureAt = new Map<string, number>();
  // Everything that CLEARS a miss, on one axis: a later correct answer or a
  // later teaching moment. Both answer the same question ("is the miss still
  // the last word on this node?"), so one max per node is enough.
  const latestClearedAt = new Map<string, number>();
  const bump = (into: Map<string, number>, key: string, at: number) => {
    if (at > (into.get(key) ?? Number.NEGATIVE_INFINITY)) into.set(key, at);
  };
  for (const attempt of attempts) {
    if (!candidateByKey.has(attempt.nodeKey)) continue;
    const at = attempt.createdAt ?? attempt._creationTime;

    // Teach-on-miss, written back onto the miss row: an explanation that
    // finished streaming, or a hint ladder the scholar walked to a solve. It
    // shares the miss row's `createdAt`, so a fallback timestamp TIES with the
    // failure it teaches — the tie counts as taught. `stuck` is the explicit
    // exception: the explanation was delivered and the scholar stayed lost.
    if (attempt.teachOutcome !== "stuck") {
      if (attempt.explanationFinishedAt !== undefined) {
        bump(latestClearedAt, attempt.nodeKey, attempt.explanationFinishedAt);
      } else if (attempt.teachOutcome === "solved" || attempt.teachOutcome === "hint") {
        bump(latestClearedAt, attempt.nodeKey, at);
      }
    }

    // A grade-only retry moved nothing at the time (no mastery, no scheduler),
    // so it neither arms nor clears the gate — a rescued retry is exactly the
    // case that still deserves one more scaffolded rep.
    if (attempt.retry === true) continue;
    if (attempt.correct) bump(latestClearedAt, attempt.nodeKey, at);
    else if (attempt.lane !== "placement" && attempt.lane !== "reprobe") {
      bump(latestFailureAt, attempt.nodeKey, at);
    }
  }

  const stillFailing = [...latestFailureAt].filter(
    ([key, failedAt]) => failedAt > (latestClearedAt.get(key) ?? Number.NEGATIVE_INFINITY),
  );
  // Only a node whose miss is still the last word is worth an instruction scan.
  if (stillFailing.length === 0) return new Set();

  // Point lookups on `by_scholar_key` for exactly the keys that can clear a
  // still-failing node (its own node key + its strand's), rather than
  // collecting the scholar's whole lifetime instruction ledger. ≤2 narrow
  // index reads per still-failing node, and that set is almost always empty.
  const instructionKeys = new Set<string>();
  for (const [skillKey] of stillFailing) {
    const candidate = candidateByKey.get(skillKey)!;
    instructionKeys.add(nodeInstructionKey(skillKey));
    if (candidate.strand) {
      instructionKeys.add(strandInstructionKey(candidate.domain, candidate.strand));
    }
  }
  const latestInstructionAt = new Map<string, number>();
  for (const key of instructionKeys) {
    const events = await ctx.db
      .query("instructionEvents")
      .withIndex("by_scholar_key", (q) => q.eq("scholarId", scholarId).eq("key", key))
      .collect();
    for (const event of events) {
      const timestamps = [
        event.viewedAt,
        event.completedAt,
        ...(event.retrievals ?? []).map((retrieval) => retrieval.at),
      ];
      const latest = Math.max(
        Number.NEGATIVE_INFINITY,
        ...timestamps.filter((at): at is number => at !== undefined),
      );
      if (latest > (latestInstructionAt.get(event.key) ?? Number.NEGATIVE_INFINITY)) {
        latestInstructionAt.set(event.key, latest);
      }
    }
  }

  const cold = new Set<string>();
  for (const [skillKey, failedAt] of stillFailing) {
    const candidate = candidateByKey.get(skillKey)!;
    const taughtAt = Math.max(
      latestInstructionAt.get(nodeInstructionKey(skillKey)) ?? Number.NEGATIVE_INFINITY,
      candidate.strand
        ? latestInstructionAt.get(strandInstructionKey(candidate.domain, candidate.strand)) ??
            Number.NEGATIVE_INFINITY
        : Number.NEGATIVE_INFINITY,
    );
    if (failedAt > taughtAt) cold.add(skillKey);
  }
  return cold;
}

async function verifiedProblemSetKeys(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  activityId: Id<"activities">,
  requestedSkillKeys: readonly string[] | undefined,
  staffRehearsal: boolean,
): Promise<{ keys: string[]; domain: string } | null> {
  const activity = await ctx.db.get(activityId);
  if (!activity || activity.kind !== "problem_set" || !activity.problemSet || activity.archivedAt) {
    return null;
  }
  const targetSkillKeys = [...new Set(activity.problemSet.targetSkillKeys)];
  const requested = requestedSkillKeys?.length ? [...new Set(requestedSkillKeys)] : targetSkillKeys;
  if (requested.length === 0 || requested.some((key) => !targetSkillKeys.includes(key))) {
    return null;
  }
  const targetNodes = await Promise.all(
    requested.map((key) =>
      ctx.db
        .query("knowledgeNodes")
        .withIndex("by_nodeKey", (q) => q.eq("nodeKey", key))
        .first(),
    ),
  );
  const domain = targetNodes[0]?.domain;
  if (
    !domain ||
    targetNodes.some((node) => node === null || node.domain !== domain) ||
    (activity.problemSet.domain && activity.problemSet.domain !== domain)
  ) {
    return null;
  }
  if (staffRehearsal) return { keys: requested, domain };

  // An activity id alone is not authority: the scholar must be on an active
  // assignment for the activity's unit, and that activity must be live there.
  // This is the narrow roster + unit + schedule proof available in the current
  // model; a self-paced assignment intentionally makes every unit activity live.
  const lesson = activity.lessonId ? await ctx.db.get(activity.lessonId) : null;
  if (!lesson) return null;
  const now = Date.now();
  const assignments = await ctx.db.query("assignments").collect();
  const live = assignments.some((assignment) =>
    !assignment.archivedAt &&
    assignment.unitId === lesson.unitId &&
    assignment.scholarIds.some((id) => id === scholarId) &&
    (assignment.selfPaced ||
      (assignment.activitySchedule ?? []).some(
        (entry) =>
          entry.activityId === activityId &&
          entry.setAt !== undefined &&
          (entry.endsAt === undefined || entry.endsAt > now),
      )),
  );
  return live ? { keys: requested, domain } : null;
}

export const practiceSession = authedQuery({
  args: {
    scholarId: v.id("users"),
    size: v.optional(v.number()),
    seed: v.number(),
    domain: v.optional(v.string()),
    // A MIXED-domain playlist: blend these domains into one interleaved session.
    // ≥2 entries → the cross-domain merge (only on the whole-graph path); ≤1
    // behaves exactly like the single `domain`.
    domains: v.optional(v.array(v.string())),
    // When set (a problem-set activity), scope practice to these skills instead
    // of the scholar's whole-graph frontier — due reviews within the set first.
    skillKeys: v.optional(v.array(v.string())),
    /** Server-verifiable authority for a teacher-assigned problem set. */
    problemSetActivityId: v.optional(v.id("activities")),
    // Optional scholar choice: its strand is weighted ×2 and force-activated
    // only in the matching domain. Ignored when scoped.
    choiceHint: v.optional(v.object({ domain: v.string(), strand: v.string() })),
    // A story archive re-encounter. The client supplies graph identity only;
    // eligibility and item identity are re-resolved server-side.
    storyHint: v.optional(
      v.object({ fromKey: v.string(), toKey: v.string() }),
    ),
    // A standing assignment's off-limits strands — never served (reviews or
    // frontier). Threaded from practiceConfig.excludedStrands.
    excludedStrands: v.optional(v.array(v.string())),
    // Stretch-tile entry: when set, compose the served set as due reviews first
    // (unchanged, never optional) then the challenge-tail items as the opt-in
    // stretch block. Mirrors playlistForScholar's stretchHint so the preview
    // exactly matches what Start serves (reviews-first + challenge tail). Empty
    // challenge tail → falls through to the normal session. Ignored for scoped
    // (skillKeys) and mixed-domain sessions (no challenge tail there).
    stretchHint: v.optional(v.boolean()),
    // OPTION D (OPTION_D_RULINGS): fold the `· mapping` band into this playlist —
    // placement probes for unmapped/in-progress domains served AS playlist items
    // (lane "mapping"), ordered after due reviews and before new frontier work,
    // capped ≤2 on a blend / all-mapping on a cold-start day. Set ONLY by the
    // default (no-pin) Home entry; absent for scoped/standing/stretch entries, so
    // those (and every existing caller/test) are byte-for-byte unchanged. When
    // set, the result also carries `allMapping` + `mappingDomains` for the
    // ceremony-lite skin.
    includeMapping: v.optional(v.boolean()),
    // Vestigial post-focus-cutover: kept only for API compatibility with
    // existing callers; the serving resolver never consults it.
    allowOutsideFocus: v.optional(v.boolean()),
    // Can THIS client actually play a game? Games are iPad-only as policy
    // (D-5), and a game beat is only worth offering where it can be taken:
    // otherwise a scholar practising on a laptop would burn the ≤1/day offer on
    // a doorway they can't walk through, and the iPad — where the game
    // genuinely lives — would find it already spent. Absent/false (every web
    // caller) means no beat is selected at all, which makes the platform policy
    // structural at the SELECTION layer rather than a rendering special case.
    //
    // This is deliberately NOT "hide it on web": a game the teacher wants a
    // scholar to definitely play is ASSIGNED, and an assigned game already
    // appears on the web day rail carrying its capability notice. A BINDING
    // says something narrower — "offer this when they're at this strand and can
    // play it" — so declining to offer it elsewhere loses nothing.
    canPlayGames: v.optional(v.boolean()),
    // The requesting client, so a Launchpad authored for one platform only
    // (`instructionContent.platforms`) never surfaces on the other. Absent →
    // "web" (every pre-existing caller).
    platform: v.optional(v.union(v.literal("web"), v.literal("native"))),
  },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const { practiceScope } = await resolvePracticeScope(ctx, args.scholarId);
    // Stamped onto every served run so a persisted resume snapshot can be
    // invalidated the moment the scholar's scope or the institution-local day
    // changes — resuming into content they're no longer scoped to, or into
    // yesterday's run, would be silently wrong. Computed HERE, from the same
    // resolution the run is built from, so the stamp can't race a scope edit
    // between serving and saving.
    const scopeKey = practiceScopeKey(practiceScope);
    const dayKey = dayKeyForTimezone(
      Date.now(),
      await timeZoneForScholar(ctx, args.scholarId),
    );
    const verifiedActivitySkillKeys = args.problemSetActivityId
      ? await verifiedProblemSetKeys(
          ctx,
          args.scholarId,
          args.problemSetActivityId,
          args.skillKeys,
          isTeacher && ctx.user._id === args.scholarId,
        )
      : null;
    if (args.problemSetActivityId && verifiedActivitySkillKeys === null) {
      return emptyPracticeSession(args.domain, scopeKey, dayKey);
    }
    const requestedSkillKeys = verifiedActivitySkillKeys?.keys ?? args.skillKeys;

    if (args.storyHint) {
      const application = await eligibleStoryApplication(
        ctx,
        args.scholarId,
        args.storyHint.fromKey,
        args.storyHint.toKey,
      );
      const applicationNodes = application
        ? await Promise.all(
            application.items.map((item) =>
              ctx.db
                .query("knowledgeNodes")
                .withIndex("by_nodeKey", (q) => q.eq("nodeKey", item.skillKey))
                .first(),
            ),
          )
        : [];
      if (
        application &&
        applicationNodes.length === application.items.length &&
        applicationNodes.every(
          (node) =>
            node !== null &&
            practiceScopeAllowsNode(practiceScope, node.domain, node.strand),
        )
      ) {
        const items = application.items.map((item) => {
          const served = servedItemFromServable(item, false);
          served.lane = "stretch";
          served.storyHook = application.hook;
          return served;
        });
        return {
          domain: application.domain,
          domains: [application.domain],
          items,
          segments: [{ kind: "stretch" as const, count: items.length }],
          launchpad: undefined,
          gameBeat: undefined,
          challenge: [] as ServedItem[],
          stretch: [] as ServedItem[],
          firstPostPlacementBlock: false,
          allMapping: false,
          mappingDomains: [] as string[],
          storyApplicationMatched: true as const,
          scopeKey,
          dayKey,
        };
      }
    }

    // Only the scholar's OWN sitting can be offered a Launchpad -- see
    // resolveRunLaunchpad's `isSelf` parameter.
    const isSelfPractice = !isTeacher && ctx.user._id === args.scholarId;
    const factSprintEligible =
      practiceScope.kind === "open" &&
      !requestedSkillKeys?.length &&
      !args.stretchHint;
    const rawCheckpoint = await resolveEffectiveCheckpoint(
      ctx,
      args.scholarId,
    );
    // A checkpoint is a steering preference, never an exception to the plan.
    const effectiveCheckpoint =
      rawCheckpoint &&
      practiceScopeAllowsCheckpoint(practiceScope, rawCheckpoint)
        ? rawCheckpoint
        : null;
    const preferredCheckpoint =
      (args.includeMapping || (!args.domain && !args.domains?.length)) &&
      !requestedSkillKeys?.length &&
      !args.stretchHint &&
      !args.choiceHint
        ? effectiveCheckpoint
        : null;

    // Recent-serve dedupe (repeat-question fix §4): the scholar's recently-seen
    // question identities, threaded into every serve path below so exact repeats
    // across the last few practice days (incl. the consecutive-day case, pilot9
    // J10) are de-preferred. Empty → serving is byte-identical.
    const recentIdentities = await recentServedIdentities(
      ctx,
      args.scholarId,
      Date.now(),
    );

    // Option D mapping post-process runs ONLY on the default whole-graph/blend
    // entry (never a scoped problem set or a stretch tail) AND only when the
    // scholar actually has an unmapped domain (cheap pre-check → placed scholars
    // pay nothing and behave exactly as before).
    const wantMapping =
      !!args.includeMapping &&
      !requestedSkillKeys?.length &&
      !args.stretchHint &&
      (await anyUnmappedDomain(ctx, args.scholarId, practiceScope));
    // ── MIXED-domain playlist: blend ≥2 domains into one interleaved session.
    //    Only the whole-graph (non-scoped) path mixes — a problem set is
    //    inherently one activity's skills, so `skillKeys` short-circuits to the
    //    single-domain body below. Reviews across all domains rank globally
    //    (most-decayed first); frontier items round-robin across domains. ──
    const ambientDomains = new Set<string>();
    if (preferredCheckpoint) {
      for (const domain of args.domains ?? []) ambientDomains.add(domain);
      if (args.domain) ambientDomains.add(args.domain);
      const masteryRows = await ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
        .collect();
      for (const row of masteryRows) {
        if (row.lastAttemptAt !== undefined) ambientDomains.add(row.domain);
      }
      ambientDomains.add(preferredCheckpoint.domain);
    }
    const domainSet =
      preferredCheckpoint
        ? PRACTICE_DOMAINS.map(({ domain }) => domain).filter((domain) =>
            ambientDomains.has(domain),
          )
        : args.domains && args.domains.length > 0
        ? Array.from(new Set(args.domains))
        : !args.domain && practiceScope.kind === "limited"
          ? scopeDomains(practiceScope)
          : [];
    if (
      args.domains?.some(
        (requestedDomain) =>
          !practiceScopeAllowsDomain(practiceScope, requestedDomain),
      )
    ) {
      return emptyPracticeSession(args.domains[0], scopeKey, dayKey);
    }
    if (!requestedSkillKeys?.length && domainSet.length > 1) {
      // The requested SERVED size drives every queue limit below (both the
      // per-domain candidate depth and the cross-domain merge cap) so the mix
      // floor (`ceil(size / 4)`) is a real guarantee against what actually
      // reaches the scholar, not a stale larger pool that gets truncated later.
      const size = args.size ?? PRACTICE_SESSION_SIZE;
      const scopedDomainSet = domainSet.filter((domain) =>
        practiceScopeAllowsDomain(practiceScope, domain),
      );
      if (scopedDomainSet.length === 0) return emptyPracticeSession(args.domain, scopeKey, dayKey);
      const perDomain = await Promise.all(
        scopedDomainSet.map((d) =>
          computeDomainQueue(ctx, args.scholarId, d, {
            strandHint: args.choiceHint?.domain === d ? args.choiceHint.strand : undefined,
            excludedStrands: args.excludedStrands,
            preferredCheckpoint:
              preferredCheckpoint?.domain === d
                ? preferredCheckpoint
                : undefined,
            limit: size,
          }),
        ),
      );
      // Global (skillKey-keyed) label + mastery maps across every domain. Keys
      // are assumed distinct across the seeded domains; on a rare collision the
      // first domain in the set wins (a pre-existing skillKey-namespace limit).
      const labelByKey = new Map<string, string>();
      const masteryByKey = new Map<string, Doc<"practiceMastery">>();
      for (const pd of perDomain) {
        for (const s of pd.skills) if (!labelByKey.has(s.skillKey)) labelByKey.set(s.skillKey, s.label);
        for (const [k, row] of pd.mastery) if (!masteryByKey.has(k)) masteryByKey.set(k, row);
      }
      const merged = mergeDomainQueues(perDomain, size, {
        preferredDomain: preferredCheckpoint?.domain,
      });
      // Scholar-facing lane (P1e) per key from the per-domain queue reasons, so a
      // blended session shows "· review" chips too. A blend has no challenge tail
      // (the grade band is a single-domain frontier notion).
      const mixedLaneByKey = new Map<string, "review" | "new" | "challenge">();
      // strand per key, for the playlist-segments composer's "choice" kind
      // (C-4) — a blend's entries already carry `strand` (computeDomainQueue).
      const mixedStrandByKey = new Map<string, string>();
      for (const pd of perDomain) {
        for (const e of pd.entries) {
          if (!mixedLaneByKey.has(e.key)) mixedLaneByKey.set(e.key, e.reason);
          if (!mixedStrandByKey.has(e.key)) mixedStrandByKey.set(e.key, e.strand);
        }
      }
      const coldFailedSkillKeys = await coldFailedSkillKeySet(
        ctx,
        args.scholarId,
        perDomain.flatMap((pd) =>
          pd.skills.map((skill) => ({
            skillKey: skill.skillKey,
            domain: pd.domain,
            strand: skill.strand,
          })),
        ),
        Date.now(),
      );
      const firstPostPlacementBlock = perDomain.some(
        (pd) => pd.firstPostPlacementBlock,
      );
      // Serving (domain-tagged blend) delegates to the unified serveItems; the
      // merged queue is already the per-item domain source.
      const served = await serveItems(
        ctx,
        {
          entries: merged,
          labelByKey,
          masteryByKey,
          laneByKey: mixedLaneByKey,
          seed: args.seed,
          size,
          stampDomain: true,
          firstPostPlacementBlock,
          calibrationSkillKeys: perDomain.flatMap((pd) =>
            pd.firstPostPlacementBlock ? pd.calibrationSkillKeys : [],
          ),
          recentIdentities,
          coldFailedSkillKeys,
        },
        SESSION_POLICY,
      );
      // Playlist segments v1 (raise-the-ceiling §11 / C-4): composed one layer
      // above serveItems so its golden-equivalence test stays untouched — see
      // lib/practice/segments.ts's file header.
      const blendComposeOpts = {
        choiceHint: args.choiceHint,
        strandByKey: mixedStrandByKey,
        stampDomain: true,
      };
      // Option D: fold the `· mapping` band into the blend (after reviews, before
      // new; unmapped-domain frontier work suppressed). A blend leads with the
      // choiceHint domain's mapping if it's the freshly-picked, still-unmapped one.
      const blendMapping = wantMapping
        ? await finalizeWithMapping(
            ctx,
            args.scholarId,
            args.seed,
            served,
            (it) => it.domain ?? domainSet[0],
            blendComposeOpts,
            args.choiceHint?.domain,
            args.choiceHint?.domain,
            practiceScope,
          )
        : null;
      const blendBase = blendMapping ?? composeSegments(served, blendComposeOpts);
      const blendComposed = await withRunFactSprint(
        ctx,
        args.scholarId,
        blendBase,
        domainSet[0],
        args.seed,
        factSprintEligible,
      );
      // P1: the Launchpad is a positioned entry on THIS run. A blend used to be
      // excluded entirely (the web client passed "skip" for any mixed run), so
      // every scholar practising across domains never saw instruction at all.
      // Resolving it from the composed items removes that special case.
      const blendStrandsWithMastery = new Set<string>();
      for (const pd of perDomain) {
        for (const k of strandsWithMasteryFrom(pd.domain, pd.skills, pd.mastery)) {
          blendStrandsWithMastery.add(k);
        }
      }
      const blendLaunchpad = requestedSkillKeys?.length
        ? undefined
        : await resolveRunLaunchpad(ctx, isSelfPractice, args.scholarId, blendComposed.items, {
            strandByKey: mixedStrandByKey,
            strandsWithMastery: blendStrandsWithMastery,
            fallbackDomain: domainSet[0],
            platform: args.platform ?? "web",
            masteryByKey,
          });
      const blendGameBeat = requestedSkillKeys?.length
        ? undefined
        : await resolveRunGameBeat(ctx, isSelfPractice, args.scholarId, blendComposed.items, {
            strandByKey: mixedStrandByKey,
            fallbackDomain: domainSet[0],
            canPlayGames: args.canPlayGames === true,
          });
      return {
        domain: scopedDomainSet[0],
        domains: scopedDomainSet,
        items: blendComposed.items,
        segments: blendComposed.segments,
        launchpad: blendLaunchpad,
        // Sidecar, never a member of `items` — see lib/practice/gameBeats.ts.
        gameBeat: blendGameBeat,
        challenge: [] as ServedItem[],
        // A blend has no stretch tail either (fluent-node scan is a
        // single-domain notion for now; the shape stays uniform).
        stretch: [] as ServedItem[],
        // A blend reports the first post-placement calibration block when ANY of
        // its domains is in one (the post-check-in hand-off lands here), so the
        // client shows the calibration-close copy instead of a raw score.
        firstPostPlacementBlock,
        // Option D mapping metadata (undefined/false when not the mapping entry).
        allMapping: blendMapping?.allMapping ?? false,
        mappingDomains: blendMapping?.mappingDomains ?? [],
        mappingProgressOffset: blendMapping?.mappingProgressOffset ?? 0,
        scopeKey,
        dayKey,
        ...(practiceScope.kind === "limited" && blendComposed.items.length === 0
          ? { blocked: true as const }
          : {}),
      };
    }

    // Fall-through (single-domain / scoped). A length-1 `domains` array is not a
    // blend — honor it as the domain when no explicit `domain` was given, so a
    // one-domain playlist never silently drops to the whole-number default.
    if (
      verifiedActivitySkillKeys &&
      ((args.domain && args.domain !== verifiedActivitySkillKeys.domain) ||
        (args.domains?.some((domain) => domain !== verifiedActivitySkillKeys.domain) ??
          false))
    ) {
      return emptyPracticeSession(args.domain, scopeKey, dayKey);
    }
    const requestedDomain =
      preferredCheckpoint?.domain ??
      args.domain ??
      verifiedActivitySkillKeys?.domain ??
      domainSet[0] ??
      defaultScopeDomain(practiceScope);
    if (
      !verifiedActivitySkillKeys &&
      !isScopeAllowedDomain(practiceScope, requestedDomain)
    ) {
      return emptyPracticeSession(args.domain, scopeKey, dayKey);
    }
    const domain = requestedDomain;

    const scopedLoaded = verifiedActivitySkillKeys
      ? await loadDomain(ctx, domain)
      : scopeLoadedDomain(practiceScope, domain, await loadDomain(ctx, domain));
    const { skills, edges } = scopedLoaded;
    const allowedKeys = new Set(skills.map((skill) => skill.skillKey));
    const mastery = await loadMastery(ctx, args.scholarId, domain);
    const gradeLevel = await scholarGradeLevel(ctx, args.scholarId);
    const labelOf = new Map(skills.map((s) => [s.skillKey, s.label]));
    // Excluded strands are never served — enforced in both the scoped and the
    // whole-graph branches below (the scheduler enforces it for the frontier).
    const excludedSet = new Set(args.excludedStrands ?? []);
    const strandByKey = new Map(skills.map((s) => [s.skillKey, s.strand]));
    const coldFailedSkillKeys = await coldFailedSkillKeySet(
      ctx,
      args.scholarId,
      skills.map((skill) => ({
        skillKey: skill.skillKey,
        domain,
        strand: skill.strand,
      })),
      Date.now(),
    );

    let queueKeys: string[];
    // Scholar-facing lane per served key (P1e "· review"/"· challenge" chip) +
    // the OPTIONAL above-band challenge tail. Filled per branch below.
    const laneByKey = new Map<string, "review" | "new" | "challenge">();
    let challengeQueueKeys: string[] = [];
    let firstPostPlacementBlock = false;
    let calibrationSkillKeys: readonly string[] = [];
    const now = Date.now();
    if (requestedSkillKeys && requestedSkillKeys.length > 0) {
      // Scoped: only the activity's target skills, most-decayed first.
      const scope = new Set(
        requestedSkillKeys.filter((key) =>
          verifiedActivitySkillKeys?.keys.includes(key) ||
          allowedKeys.has(key),
        ),
      );
      queueKeys = skills
        .filter((s) => scope.has(s.skillKey) && !excludedSet.has(strandByKey.get(s.skillKey) ?? ""))
        .map((s) => s.skillKey)
        .sort((a, b) => retention(stateFromRow(mastery.get(a)), now) - retention(stateFromRow(mastery.get(b)), now));
      // A scoped set has no challenge overflow; a due skill still reads "review".
      const scopedTargets = desiredRetentionTargets(
        skills.map((s) => s.skillKey),
        edges,
      );
      for (const k of queueKeys) {
        laneByKey.set(
          k,
          isDue(stateFromRow(mastery.get(k)), now, scopedTargets.get(k)) ? "review" : "new",
        );
      }
    } else {
      const remediationSkillKey = await computeRemediationSkillKey(ctx, args.scholarId, domain, mastery, edges);
      const stateOf = await buildFrontierStateOf(ctx, args.scholarId, skills.map((s) => s.skillKey), edges, mastery);
      const firstBlock = await firstRequiredBlockScheduling(
        ctx,
        args.scholarId,
        domain,
        mastery,
        skills,
        edges,
        stateOf,
      );
      firstPostPlacementBlock = firstBlock.active;
      calibrationSkillKeys = firstBlock.calibrationSkillKeys;
      // The requested SERVED size drives the queue limit — see computeDomainQueue's
      // doc comment: `applyMixFloor`'s `ceil(limit / 4)` frontier floor is only a
      // real guarantee against the limit actually served, not a larger candidate
      // pool truncated downstream by `buildSession`.
      const fullQueue = nextPractice(
        skills.map((s) => s.skillKey),
        edges,
        stateOf,
        now,
        args.size ?? PRACTICE_SESSION_SIZE,
        {
          ...buildStrandScheduling(
            skills,
            edges,
            mastery,
            gradeLevel,
            args.choiceHint?.domain === domain ? args.choiceHint.strand : undefined,
            args.excludedStrands,
            firstBlock,
            undefined,
            // Placement is a hard rule above the checkpoint (see playlistForScholar).
            !firstBlock.active && preferredCheckpoint?.domain === domain
              ? preferredCheckpoint
              : undefined,
          ),
          applyMixFloor: true,
          remediationSkillKey,
        },
      );
      const runnable = await runnableSkillKeySet(ctx, fullQueue.map((q) => q.key));
      const serveableQueue = fullQueue.filter((q) =>
        q.reason === "challenge" ? hasTemplate(q.key) : runnable.has(q.key),
      );
      for (const q of serveableQueue) laneByKey.set(q.key, scholarLane(q.reason));
      // The required set excludes the challenge tail (above-band frontier the
      // grade band withheld) — those are served ONLY in the labeled challenge
      // list below, never mixed into the required items.
      queueKeys = serveableQueue.filter((q) => q.reason !== "challenge").map((q) => q.key);
      challengeQueueKeys = serveableQueue.filter((q) => q.reason === "challenge").map((q) => q.key);
    }
    // Serving (single-domain / scoped) delegates to the unified serveItems.
    // Untagged (no per-item domain) to preserve the single-domain wire shape.
    // The requested SERVED size drives both the queue limit above and this
    // serve call, so PRACTICE_SESSION_SIZE (not the policy default alone) is
    // the source of truth when the caller passes no explicit size.
    const served = await serveItems(
      ctx,
      {
        entries: queueKeys.map((k) => ({ key: k, domain })),
        labelByKey: labelOf,
        masteryByKey: mastery,
        laneByKey,
        seed: args.seed,
        size: args.size ?? PRACTICE_SESSION_SIZE,
        stampDomain: false,
        firstPostPlacementBlock,
        calibrationSkillKeys,
        recentIdentities,
        coldFailedSkillKeys,
      },
      SESSION_POLICY,
    );

    // The OPTIONAL challenge tail (P1e / grade-band §P1b): above-band frontier
    // nodes the band withheld from the required set, offered as an explicitly
    // labeled, opt-in stretch — never mixed in. Template items only (bounded by
    // the scheduler's challenge cap); a distinct sub-seed keeps them from
    // duplicating item #1. Empty on the scoped/mixed paths.
    const challenge: ServedItem[] = [];
    if (challengeQueueKeys.length > 0) {
      // A just-missed skill is not a "challenge" — it re-enters through the
      // teach-first path below the band, never the above-band tail.
      const challengeKeys = challengeQueueKeys.filter(
        (key) => !coldFailedSkillKeys.has(key),
      );
      const built = buildSession(
        challengeKeys.map((k) => ({ key: k, label: labelOf.get(k) ?? k })),
        challengeKeys.length,
        ((args.seed >>> 0) ^ 0x9e3779b9) >>> 0,
        undefined,
        recentIdentities,
      );
      for (const it of built) {
        it.lane = "challenge";
        it.domain = domain;
        challenge.push(it);
      }
    }
    // Playlist segments v1 (raise-the-ceiling §11 / C-4): composed one layer
    // above serveItems so its golden-equivalence test stays untouched — see
    // lib/practice/segments.ts's file header. `choiceHint` is ignored for a
    // scoped (skillKeys) session, mirroring buildStrandScheduling above (it
    // never force-activates a strand there either).
    const composed = composeSegments(served, {
      choiceHint: requestedSkillKeys?.length ? undefined : args.choiceHint,
      strandByKey,
      stampDomain: false,
    });
    // Option D: fold the `· mapping` band into the single-domain default entry.
    // A brand-new scholar (whole-number unmapped) suppresses its served frontier
    // work and gets an all-mapping run; a scholar who deliberately picked an
    // unmapped domain (`choiceHint` matches `domain`) leads with its mapping.
    // The resolved/default domain alone is only the ordinary-work scope; treating
    // it as a deliberate lead would bypass an already in-progress placement.
    const deliberateMappingDomain =
      args.choiceHint?.domain === domain ? domain : undefined;
    const singleMapping = wantMapping
      ? await finalizeWithMapping(
          ctx,
          args.scholarId,
          args.seed,
          served,
          () => domain,
          { choiceHint: args.choiceHint, strandByKey, stampDomain: false },
          deliberateMappingDomain,
          deliberateMappingDomain,
          practiceScope,
        )
      : null;
    // "Go deeper" insight problems on demonstrated-fluent nodes. They remain an
    // optional done-screen offer while the domain has frontier work; once access
    // is proven across the domain, eligible demonstrated nodes become the primary
    // in-domain continuation. Scoped problem sets stay the activity's business.
    const accessComplete =
      !requestedSkillKeys?.length &&
      domainClimb(
        skills.map((skill) => skill.skillKey),
        mastery.values(),
      ).accessComplete;
    const stretch: ServedItem[] = requestedSkillKeys?.length
      ? []
      : await stretchTailForScholar(
          ctx,
          args.scholarId,
          domain,
          mastery,
          labelOf,
          accessComplete ? 0 : args.seed,
          allowedKeys,
        );
    const autoGoDeeper = accessComplete && stretch.length > 0;
    // Stretch-tile entry (stretchHint): compose the session as due reviews
    // first (unchanged, never optional) then the challenge-tail items as the
    // opt-in stretch block. When the challenge tail is empty, fall through to
    // the normal composed session. Reviews retain their order; challenge items
    // keep lane "challenge" so the "· challenge" chip and frontier-moved reveal
    // fire naturally. Ignored for scoped or mixed-domain sessions.
    const singleBase = singleMapping
      ? singleMapping
      : args.stretchHint && !requestedSkillKeys?.length && challenge.length > 0
        ? composeSegments(
            [
              ...served.filter((it) => it.lane === "review"),
              ...challenge,
            ],
            { choiceHint: undefined, strandByKey, stampDomain: false },
          )
        : autoGoDeeper
          ? composeSegments([...served, ...stretch], {
              choiceHint: undefined,
              strandByKey,
              stampDomain: false,
            })
          : composed;
    const finalComposed = await withRunFactSprint(
      ctx,
      args.scholarId,
      singleBase,
      domain,
      args.seed,
      factSprintEligible,
    );
    // P1: resolve the Launchpad from the FINAL composed run, so its strand and
    // its position are both read off the items the scholar will actually see.
    // Scoped problem sets and the opt-in stretch tail are deliberately excluded
    // — neither is a first encounter with a strand.
    const singleLaunchpad =
      requestedSkillKeys?.length || args.stretchHint
        ? undefined
        : await resolveRunLaunchpad(ctx, isSelfPractice, args.scholarId, finalComposed.items, {
            strandByKey,
            strandsWithMastery: strandsWithMasteryFrom(domain, skills, mastery),
            fallbackDomain: domain,
            platform: args.platform ?? "web",
            masteryByKey: mastery,
          });
    const singleGameBeat =
      requestedSkillKeys?.length || args.stretchHint
        ? undefined
        : await resolveRunGameBeat(ctx, isSelfPractice, args.scholarId, finalComposed.items, {
            strandByKey,
            fallbackDomain: domain,
            canPlayGames: args.canPlayGames === true,
          });
    return {
      domain,
      domains: [domain],
      items: finalComposed.items,
      segments: finalComposed.segments,
      launchpad: singleLaunchpad,
      // Sidecar, never a member of `items` — see lib/practice/gameBeats.ts.
      gameBeat: singleGameBeat,
      challenge: args.stretchHint && challenge.length > 0 ? [] : challenge,
      stretch: autoGoDeeper ? [] : stretch,
      firstPostPlacementBlock,
      // Option D mapping metadata (undefined/false when not the mapping entry).
      allMapping: singleMapping?.allMapping ?? false,
      mappingDomains: singleMapping?.mappingDomains ?? [],
      mappingProgressOffset: singleMapping?.mappingProgressOffset ?? 0,
      scopeKey,
      dayKey,
      ...(practiceScope.kind === "limited" && finalComposed.items.length === 0
        ? { blocked: true as const }
        : {}),
    };
  },
});

// ── Write: record a practice attempt ──────────────────────────────────────

/**
 * Fire any mastery-gated cross-domain seeds now that `skillKey` advanced.
 * Idempotent: dedupes on (scholar, sourceLens "math-practice", topic). The seed
 * lands in the Exploration / Sky lens via the shared `seeds` table.
 *
 * Roadmap §7 ①: a seed's firing condition is a multi-signal `gates[]` array
 * (evaluated by `gateEval`), with the legacy single `gateSkillKey` normalized to
 * one FLUENT practiceSkill gate — so today's seeds fire identically while
 * cross-domain / observer-signal / surfaced-topic gates now compose too.
 */
async function maybeFireSeeds(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  skillKey: string,
) {
  // Candidate seeds: any whose gates reference the skill that just advanced.
  // A legacy single-gate seed matches on its gateSkillKey; a multi-signal seed
  // still has ALL its gates re-checked below, so an "all" seed only fires once
  // its OTHER gates are satisfied too.
  const candidates = MATH_CROSS_DOMAIN_SEEDS.filter((s) => gateSkillKeys(s).includes(skillKey));
  if (candidates.length === 0) return;

  // Gather the per-scholar facts the gates read, server-side (teacher-authored
  // data in; the TIER_1 seeds row out). `reps` reflects the just-patched
  // practiceMastery (recordAttemptCore patches before firing). `topicSurfaced`
  // is limited to topics ALREADY surfaced for this scholar (an existing seed),
  // so a topicMentioned gate reveals nothing new about which sessions happened.
  const masteryRows = await ctx.db
    .query("practiceMastery")
    .withIndex("by_scholar_skill", (q) => q.eq("scholarId", scholarId))
    .collect();
  const repMap = new Map<string, number>();
  // Seed gates fire on the GREEN axis (plan of record §1): a PROVISIONAL credit
  // (valve/placement/re-probe — access-proven but not yet demonstrated) reports
  // 0 reps to the gate, so an inferred jump can't fire a cross-domain seed until
  // the skill is genuinely fluent. Demonstrated + still-practising rows report
  // their real count unchanged.
  for (const r of masteryRows)
    repMap.set(`${r.domain}::${r.skillKey}`, isProvisional(r) ? 0 : r.repetition);

  const signalRows = await ctx.db
    .query("sessionSignals")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  const signalSet = new Set(signalRows.map((s) => s.signalType));

  const seedRows = await ctx.db
    .query("seeds")
    .withIndex("by_scholar_status", (q) => q.eq("scholarId", scholarId))
    .collect();
  const surfacedTopics = new Set(seedRows.map((s) => s.topic));
  const existingMathTopics = new Set(
    seedRows.filter((s) => s.sourceLens === "math-practice").map((s) => s.topic),
  );

  const facts: GateFacts = {
    reps: (domain, key) => repMap.get(`${domain}::${key}`) ?? 0,
    hasSignal: (t) => signalSet.has(t),
    topicSurfaced: (t) => surfacedTopics.has(t),
  };

  for (const seed of candidates) {
    if (existingMathTopics.has(seed.topic)) continue; // idempotent
    if (!evaluateGates(seed, facts)) continue;
    await ctx.db.insert("seeds", {
      scholarId,
      origin: "ai-constellation",
      status: "active",
      topic: seed.topic,
      domain: "Mathematics",
      suggestionType: "cross_domain",
      rationale: seed.rationale,
      scholarInvitation: seed.scholarInvitation,
      connectionTo: seed.connectionTo,
      sourceLens: "math-practice",
      reach: 2,
      // On-ramp seeds carry the practice-drill domain their star should route
      // to (e.g. the fractions on-ramp → "fraction-arithmetic"); ordinary seeds
      // leave this unset and fall back to the display-domain allowlist.
      ...(seed.targetPracticeDomain ? { practiceDomain: seed.targetPracticeDomain } : {}),
    });
    // §7②: a fired seed may spawn a follow-up — a teacher notification now, a
    // suggested problem_set later (deferred). handleSeedSpawn no-ops on the
    // activity variant for now; the Sky seed above already fired regardless.
    if (seed.spawn) await handleSeedSpawn(ctx, scholarId, seed.topic, seed.spawn);
  }
}

// ── Latency baseline (B5) ──────────────────────────────────────────────────
// A first-key latency (stem render → first keystroke) is only a plausible
// "retrieval read" inside this window. Values outside it remain excluded from
// the fluency baseline, but are retained as explicitly censored attempt
// telemetry: a >2-minute start may be a real struggle even though it is unsafe
// to treat as the scholar's normal retrieval speed.
const LATENCY_MIN_MS = 300;
const LATENCY_MAX_MS = 120_000;

/** Clamp a client-reported latency to the baseline-safe retrieval window. */
function clampLatency(ms: number | undefined): number | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  if (ms < LATENCY_MIN_MS || ms > LATENCY_MAX_MS) return undefined;
  return ms;
}

type CensoredFirstKey = {
  observedMs: number;
  reason: "below_min" | "above_max";
};

/** Preserve a rejected observation without letting it become a latency sample. */
function censoredFirstKey(ms: number | undefined): CensoredFirstKey | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  if (ms < LATENCY_MIN_MS) return { observedMs: ms, reason: "below_min" };
  if (ms > LATENCY_MAX_MS) return { observedMs: ms, reason: "above_max" };
  return undefined;
}

/** Elapsed time has no upper censor: a long dwell is the signal, not baseline noise. */
function validElapsedMs(ms: number | undefined): number | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  return ms;
}

/**
 * The P2b "struggling prerequisite" signal, read from the RESIDENT mastery row
 * (`preMastery` is already loaded — zero extra queries, so this stays O(1) per
 * prereq instead of scanning the append-only `practiceAttempts` log per attempt,
 * which grows without bound). Two resident signals stand in for the plan's "last
 * real attempt was a miss, OR its last-attempt latency > 2× baseline":
 *   • last-attempt correctness ← `accelStreak`. It increments only on a recorded
 *     correct and resets to 0 on a miss (recordAttemptCore), so `accelStreak===0`
 *     together with an honest `lastAttemptAt` means the last graded attempt
 *     missed. `accelStreak >= 1` means it was correct.
 *   • latency ← `latencyMedianMs` (the scholar's typical retrieval time on this
 *     skill; `shouldSkipImplicitCredit` compares it to 2× the cross-skill
 *     baseline). A stable per-skill median is a steadier "slow-for-this-scholar"
 *     read than a single noisy last-attempt latency.
 * A row never genuinely drilled (no `lastAttemptAt`, no median — e.g. a
 * placement-only credit) yields NO signal, so implicit credit flows as before.
 */
function residentStruggleSignal(
  row: Doc<"practiceMastery">,
): ImplicitCreditAttemptSignal | undefined {
  const hasAttempt = row.lastAttemptAt !== undefined;
  const hasLatency = row.latencyMedianMs !== undefined;
  if (!hasAttempt && !hasLatency) return undefined;
  return {
    // Only judge "was it a miss" when there's an honest attempt stamp; a row with
    // a latency median but no attempt stamp shouldn't be treated as a miss.
    correct: hasAttempt ? (row.accelStreak ?? 0) >= 1 : true,
    ...(hasLatency ? { firstKeyMs: row.latencyMedianMs } : {}),
  };
}

type PracticeAttemptLane =
  | "review"
  | "frontier"
  | "confirmation"
  | "placement"
  | "reprobe"
  | "tuneup"
  | "challenge"
  | "stretch"
  | "chat";

type RecordAttemptMeta = {
  itemId?: string;
  clientEventId?: string;
  submissionFingerprint?: string;
  /** Render-to-submit time for this first, recorded attempt. Telemetry only. */
  elapsedMs?: number;
  /** Canonical fact identity (`shared/factKey.ts`) for a bare-fact attempt,
   *  precomputed at the submit site from the regenerated structured operands.
   *  Present ONLY for the
   *  fact families' direct-form items; its presence is what tells
   *  recordAttemptCore to update the per-fact automaticity ledger. */
  factKey?: string;
  lane?: PracticeAttemptLane;
  explanationReason?: "dont_know" | "miss";
  /** The scholar's sanitized submitted answer, stored on the attempt row so a
   *  miss is diagnosable (the error classifier reads it) and teacher surfaces
   *  can show what was actually typed. Absent for a Don't-Know. */
  answerText?: string;
  /** Teacher/analytics-only snapshot of the missed problem's rendered stem,
   *  captured at grade time (Option 2 — see practiceAttempts.stemSnapshot doc
   *  comment in schema.ts). Set only on a miss. */
  stemSnapshot?: string;
  /** Teacher/analytics-only snapshot of the unredacted canonical answer,
   *  captured at grade time. Set only on a miss; absent for a manipulative
   *  item (no answer string). */
  expectedAnswer?: string;
  /** The correct answer was produced with the worked-example scaffold still
   *  visible (≥1 revealed step). A correct SCAFFOLDED attempt records the
   *  INFERRED `SCAFFOLDED_SOURCE` instead of "practice" — it bumps
   *  repetition/access exactly like a practice attempt (the fade still
   *  progresses) but can't claim demonstrated fluency. Ignored on a miss (a
   *  scaffolded miss is just a miss). Recomputed server-side, never trusted
   *  from the client. */
  scaffolded?: boolean;
  /** Server-derived operation eligibility. False attempts can never advance or
   * trigger a breaker during later reconstruction. */
  breakerEligible?: boolean;
};

const DAY_MS = 86_400_000;

function isAboveBand(key: string, options: NextPracticeOptions): boolean {
  if (options.gradeOf === undefined || options.scholarBandCeiling === undefined) return false;
  const keyGrade = gradeOrdinal(options.gradeOf(key));
  if (keyGrade === undefined) return false;
  const ceiling = options.bandCeilingOf?.(key, options.scholarBandCeiling) ?? options.scholarBandCeiling;
  return Number.isFinite(ceiling) && keyGrade > ceiling;
}

function inferAttemptLane(opts: {
  skillKey: string;
  prev: SkillState;
  now: number;
  preFrontier: Set<string>;
  scheduling: NextPracticeOptions;
  remediationSkillKey?: string;
}): PracticeAttemptLane {
  if (isDue(opts.prev, opts.now, opts.scheduling.retentionThresholdOf?.(opts.skillKey))) {
    return opts.scheduling.inferredDueCredit?.(opts.skillKey) ? "confirmation" : "review";
  }
  if (opts.remediationSkillKey === opts.skillKey) return "review";
  if (opts.preFrontier.has(opts.skillKey)) {
    // A teacher-pinned skill is band-exempt (nextPractice serves it as normal
    // frontier, not challenge) — classify it the same way it was served.
    const bandExempt = opts.skillKey === opts.scheduling.focusSkillKey;
    return !bandExempt && isAboveBand(opts.skillKey, opts.scheduling) ? "challenge" : "frontier";
  }
  return "frontier";
}

async function revealEdgesFrom(
  ctx: MutationCtx,
  nodeKey: string,
): Promise<GraphEdge[]> {
  const rows = await ctx.db
    .query("knowledgeNodeEdges")
    .withIndex("by_from", (q) => q.eq("fromKey", nodeKey))
    .collect();
  return rows
    .filter((row) => row.kind === "buildsOn")
    .map((row) => ({ fromKey: row.fromKey, toKey: row.toKey }));
}

async function revealEdgesTo(
  ctx: MutationCtx,
  nodeKey: string,
): Promise<GraphEdge[]> {
  const rows = await ctx.db
    .query("knowledgeNodeEdges")
    .withIndex("by_to", (q) => q.eq("toKey", nodeKey))
    .collect();
  return rows
    .filter((row) => row.kind === "buildsOn")
    .map((row) => ({ fromKey: row.fromKey, toKey: row.toKey }));
}

function mergeRevealEdges(edgeGroups: GraphEdge[][]): GraphEdge[] {
  const byPair = new Map<string, GraphEdge>();
  for (const edge of edgeGroups.flat()) {
    byPair.set(`${edge.fromKey}\u0000${edge.toKey}`, edge);
  }
  return [...byPair.values()];
}

async function loadRevealMastery(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  keys: Iterable<string>,
): Promise<Map<string, Doc<"practiceMastery">>> {
  const keyList = [...new Set(keys)];
  const rows = await Promise.all(
    keyList.map((key) =>
      ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar_skill", (q) =>
          q.eq("scholarId", scholarId).eq("skillKey", key),
        )
        .first(),
    ),
  );
  return new Map(
    rows
      .filter((row): row is Doc<"practiceMastery"> => row !== null)
      .map((row) => [row.skillKey, row]),
  );
}

function revealProvenSets(
  mastery: Map<string, Doc<"practiceMastery">>,
  changedKey: string,
  wasProven: boolean,
  isProven: boolean,
): { before: Set<string>; after: Set<string>; evidence: Set<string> } {
  const before = new Set<string>();
  const after = new Set<string>();
  const evidence = new Set(mastery.keys());
  evidence.add(changedKey);
  for (const row of mastery.values()) {
    if (row.skillKey === changedKey) continue;
    if (accessProven(row)) {
      before.add(row.skillKey);
      after.add(row.skillKey);
    }
  }
  if (wasProven) before.add(changedKey);
  if (isProven) after.add(changedKey);
  return { before, after, evidence };
}

async function stampPracticeReveals(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  changedKey: string,
  wasProven: boolean,
  isProven: boolean,
  revealedAt: number,
  source: string,
): Promise<void> {
  const changedDependents = await revealEdgesFrom(ctx, changedKey);
  const dependentKeys = [...new Set(changedDependents.map((edge) => edge.toKey))];
  if (dependentKeys.length === 0) return;

  const dependentPrereqGroups = await Promise.all(
    dependentKeys.map((key) => revealEdgesTo(ctx, key)),
  );
  const initialEdges = mergeRevealEdges([
    changedDependents,
    ...dependentPrereqGroups,
  ]);
  const initialMastery = await loadRevealMastery(
    ctx,
    scholarId,
    initialEdges.flatMap((edge) => [edge.fromKey, edge.toKey]),
  );
  const initialSets = revealProvenSets(
    initialMastery,
    changedKey,
    wasProven,
    isProven,
  );
  const prereqsByDependent = new Map<string, string[]>();
  for (const edge of initialEdges) {
    const prereqs = prereqsByDependent.get(edge.toKey);
    if (prereqs) prereqs.push(edge.fromKey);
    else prereqsByDependent.set(edge.toKey, [edge.fromKey]);
  }
  const newlyAvailableKeys = dependentKeys.filter((key) => {
    if (initialSets.evidence.has(key)) return false;
    const prereqs = prereqsByDependent.get(key) ?? [];
    return (
      prereqs.every((prereq) => initialSets.after.has(prereq)) &&
      !prereqs.every((prereq) => initialSets.before.has(prereq))
    );
  });
  if (newlyAvailableKeys.length === 0) return;

  const candidateEdgeGroups = await Promise.all(
    newlyAvailableKeys.map((key) => revealEdgesFrom(ctx, key)),
  );
  const candidateEdges = mergeRevealEdges(candidateEdgeGroups);
  const candidateKeys = [...new Set(candidateEdges.map((edge) => edge.toKey))];
  if (candidateKeys.length === 0) return;

  const candidatePrereqGroups = await Promise.all(
    candidateKeys.map((key) => revealEdgesTo(ctx, key)),
  );
  const candidatePrereqs = mergeRevealEdges(candidatePrereqGroups);
  const candidatePrereqKeys = [
    ...new Set(candidatePrereqs.map((edge) => edge.fromKey)),
  ];
  const candidatePrereqInputGroups = await Promise.all(
    candidatePrereqKeys.map((key) => revealEdgesTo(ctx, key)),
  );
  const graphEdges = mergeRevealEdges([
    initialEdges,
    candidateEdges,
    candidatePrereqs,
    ...candidatePrereqInputGroups,
  ]);

  const mastery = await loadRevealMastery(
    ctx,
    scholarId,
    graphEdges.flatMap((edge) => [edge.fromKey, edge.toKey]),
  );
  const { before, after, evidence } = revealProvenSets(
    mastery,
    changedKey,
    wasProven,
    isProven,
  );
  const revealRows = await Promise.all(
    candidateKeys.map((key) =>
      ctx.db
        .query("nodeReveals")
        .withIndex("by_scholar_node", (q) =>
          q.eq("scholarId", scholarId).eq("nodeKey", key),
        )
        .first(),
    ),
  );
  const alreadyRevealed = new Set(
    revealRows
      .filter((row) => row !== null)
      .map((row) => row.nodeKey),
  );
  const newReveals = computeNewReveals(
    changedKey,
    graphEdges,
    before,
    after,
    evidence,
    alreadyRevealed,
  );
  for (const nodeKey of newReveals) {
    await ctx.db.insert("nodeReveals", {
      scholarId,
      nodeKey,
      revealedAt,
      source,
    });
  }
}

async function recordAttemptCore(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  domain: string,
  skillKey: string,
  correct: boolean,
  firstKeyMs?: number,
  meta: RecordAttemptMeta = {},
) {
  const now = Date.now();

  // Load the domain graph + the scholar's mastery ONCE up front — the
  // acceleration valve (B1) needs the PRE-attempt frontier + prereq state to
  // decide a streak-jump, and the frontier recompute below reuses the graph.
  const { skills, edges, impliesEdges } = await loadDomain(ctx, domain);
  // The INFERENCE edge set (buildsOn ∪ implies) drives implicit-credit
  // propagation only — never gating. `edges` alone keeps driving the frontier.
  const inferenceEdges = [...edges, ...impliesEdges];
  const preMastery = await loadMastery(ctx, scholarId, domain);
  const gradeLevel = await scholarGradeLevel(ctx, scholarId);
  const existing = preMastery.get(skillKey) ?? null;
  const strand = skills.find((s) => s.skillKey === skillKey)?.strand;

  const prev = stateFromRow(existing ?? undefined);
  const retentionTargets = desiredRetentionTargets(
    skills.map((s) => s.skillKey),
    edges,
  );
  const retentionThreshold = retentionTargets.get(skillKey);
  const predictedRetention = retention(prev, now);
  const elapsedDaysSinceLast =
    prev.lastPracticedAt === undefined ? undefined : (now - prev.lastPracticedAt) / DAY_MS;
  const next = applyAttempt(prev, correct, now, retentionThreshold);

  // ── Acceleration valve (B1 — §4): a clean fast streak at a frontier node
  //    earns fluent credit immediately, so a quick kid isn't made to grind. ──
  const nextAccelStreak = correct ? (existing?.accelStreak ?? 0) + 1 : 0;
  // The mirror: consecutive misses, reset by any correct (the "determination of
  // fluency" that supersedes them). Feeds the teacher/parent "struggling" state.
  const nextMissStreak = correct ? 0 : (existing?.missStreak ?? 0) + 1;
  const preStateOf = await buildFrontierStateOf(ctx, scholarId, skills.map((s) => s.skillKey), edges, preMastery);
  const preFrontier = new Set(
    computeFrontier(
      skills.map((s) => s.skillKey),
      edges.map((e) => ({ fromKey: e.fromKey, toKey: e.toKey })),
      preStateOf,
    ),
  );
  const scheduling = buildStrandScheduling(skills, edges, preMastery, gradeLevel);
  const remediationSkillKey = await computeRemediationSkillKey(ctx, scholarId, domain, preMastery, edges);
  const lane = meta.lane ?? inferAttemptLane({
    skillKey,
    prev,
    now,
    preFrontier,
    scheduling,
    remediationSkillKey,
  });
  const directPrereqs = edges.filter((e) => e.toKey === skillKey).map((e) => e.fromKey);
  const prereqAcceleratedRecently = directPrereqs.some((pk) => {
    const row = preMastery.get(pk);
    return row?.source === ACCEL_SOURCE && now - row.updatedAt < ACCEL_CHAIN_WINDOW_MS;
  });
  // "Fast for THIS scholar": compare this attempt's retrieval latency to the
  // scholar's own cross-skill baseline (median of their per-skill medians).
  // Undefined until they have enough history → not fast → no jump (a fresh kid
  // isn't accelerated before we know their normal speed).
  const clampedFirstKey = clampLatency(firstKeyMs);
  const censoredFirstKeyReading = censoredFirstKey(firstKeyMs);
  const elapsedMs = validElapsedMs(meta.elapsedMs);

  const baseline = latencyBaselineFromSkillMedians(
    [...preMastery.values()].map((r) => r.latencyMedianMs ?? NaN),
  );
  const isFast =
    clampedFirstKey !== undefined && baseline !== undefined && clampedFirstKey <= baseline;
  const accelerate = shouldAccelerate({
    correct,
    prevRepetition: prev.repetition,
    nextAccelStreak,
    isFrontierNode: preFrontier.has(skillKey),
    prereqAcceleratedRecently,
    isFast,
  });

  // The state actually written: a jump credits fluent on the placement-length
  // (4-day) leash with source "accelerated"; otherwise the ordinary applyAttempt.
  const written = accelerate
    ? { repetition: FLUENT_REPS, halfLifeDays: ACCEL_HALFLIFE_DAYS, lastPracticedAt: now }
    : next;

  // The source a CORRECT attempt lands: an assisted (scaffold-visible)
  // completion records the INFERRED SCAFFOLDED_SOURCE — access/reps still bump
  // exactly like practice (the fade progresses, reviews schedule), but it's not
  // a demonstration, so it can't go green. A bare correct answer is "practice".
  // A MISS is unchanged (the scaffold flag never applies), so the insert path
  // below keeps writing "practice" for a first-attempt miss just as before.
  const correctSource = correct && meta.scaffolded ? SCAFFOLDED_SOURCE : "practice";

  // ── TRANSITION stamps (once-only; repetition is monotonic and source only
  //    moves toward "practice", so each edge fires at most once per skill). The
  //    source we're about to write mirrors the patch/insert spreads below. ──
  const writtenSource = accelerate
    ? ACCEL_SOURCE
    : correct
      ? correctSource
      : (existing?.source ?? "practice");
  // becameFluentAt: the DEMONSTRATED-fluent gate (context-free isFluent) crosses
  // false→true. An accelerated jump writes source "accelerated" (inferred), so it
  // never trips this — only a real correct attempt that lands source "practice".
  const wasFluent = existing ? isFluent(existing) : false;
  const isNowFluent = isFluent({ repetition: written.repetition, source: writtenSource });
  const turnedFluent = !wasFluent && isNowFluent;
  // frontierAdvancedAt: ACCESS crosses false→true through THIS practice attempt
  // (incl. a valve jump). Placement/reprobe trust-upward is inserted elsewhere,
  // so it never counts as a practice-earned frontier move.
  const wasAccess = existing ? accessProven(existing) : false;
  const advancedFrontier = !wasAccess && accessProven(written);

  // Latency baseline (B5): CORRECT-ONLY (see nextLatencyStats doc) — a miss's
  // first-key time reflects hesitation/confusion, not fluent retrieval, so it
  // must not drag the "fast for this scholar" baseline the valve reads.
  const latencyUpdate =
    correct && clampedFirstKey !== undefined
      ? nextLatencyStats(existing?.latencySamplesMs, clampedFirstKey)
      : undefined;

  if (existing) {
    await ctx.db.patch(existing._id, {
      ...written,
      updatedAt: now,
      // The real drill signal — every recorded attempt (correct OR wrong), so
      // weekly practice-day + inactivity rollups see genuine practice, never
      // placement/reprobe trust-upward (which never touches this field).
      lastAttemptAt: now,
      accelStreak: nextAccelStreak,
      missStreak: nextMissStreak,
      // Provenance of the credit — drives the access-vs-green split (§1). A
      // valve jump stays provisional ("accelerated"); a correct SCAFFOLDED
      // completion stays provisional ("scaffolded"); otherwise a CORRECT bare
      // practice attempt demotes any INFERRED provenance (placement / reprobe /
      // accelerated / scaffolded) to "practice" — the scholar has now
      // demonstrated it, so a previously-provisional row can finally go green
      // (isFluent). A miss leaves source untouched: a wrong answer never claims
      // demonstration.
      ...(accelerate ? { source: ACCEL_SOURCE } : correct ? { source: correctSource } : {}),
      ...(strand !== undefined ? { strand } : {}),
      ...(turnedFluent ? { becameFluentAt: now } : {}),
      ...(advancedFrontier ? { frontierAdvancedAt: now } : {}),
      ...(latencyUpdate ?? {}),
    });
  } else {
    await ctx.db.insert("practiceMastery", {
      scholarId,
      skillKey,
      domain,
      strand,
      repetition: written.repetition,
      halfLifeDays: written.halfLifeDays,
      lastPracticedAt: written.lastPracticedAt,
      lastAttemptAt: now,
      frontier: false,
      source: accelerate ? ACCEL_SOURCE : correctSource,
      accelStreak: nextAccelStreak,
      missStreak: nextMissStreak,
      updatedAt: now,
      ...(turnedFluent ? { becameFluentAt: now } : {}),
      ...(advancedFrontier ? { frontierAdvancedAt: now } : {}),
      ...(latencyUpdate ?? {}),
    });
  }

  // ── Fact-fluency substrate (FastMath analog, §automaticity) ──────────────
  // The per-FACT retrieval ledger, written from the same attempt as mastery.
  // ONLY bare-fact attempts carry `meta.factKey` (the submit site gates hard to
  // fact-family skills + direct items with structured operands), so every other
  // item — and the latency-less recordAttempt/markSkill code paths that pass no
  // factKey — skips this untouched. Invisible + non-gating: it refines the
  // green/automaticity CLAIM and feeds the "Fast math" sprint selector only.
  if (meta.factKey) {
    const factRow = await ctx.db
      .query("factFluency")
      .withIndex("by_scholar_fact", (q) =>
        q.eq("scholarId", scholarId).eq("factKey", meta.factKey!),
      )
      .unique();
    const factFields = nextFactFluencyFields(factRow, {
      factKey: meta.factKey,
      skillKey,
      domain,
      correct,
      latencyMs: clampedFirstKey,
      now,
    });
    if (factFields) {
      if (factRow) {
        await ctx.db.patch(factRow._id, factFields);
      } else {
        await ctx.db.insert("factFluency", {
          scholarId,
          factKey: meta.factKey,
          ...factFields,
        });
      }
    }
  }

  // EVERY access crossing latches its horizon reveals (never un-reveal — a
  // valve-jump's newly visible nodes must survive a later regression exactly
  // like a practice-earned one's). The `source` keeps the recap honest: only
  // "practice" rows mint an "Added to your Tree Map" card (dailyRecap filters),
  // mirroring how placement/reprobe never claim practice-earned movement.
  if (advancedFrontier) {
    try {
      await stampPracticeReveals(
        ctx,
        scholarId,
        skillKey,
        wasAccess,
        true,
        now,
        accelerate ? ACCEL_SOURCE : "practice",
      );
    } catch (error) {
      console.error("Failed to stamp practice node reveals", {
        scholarId,
        skillKey,
        error,
      });
    }
  }

  const attemptId = await ctx.db.insert("practiceAttempts", {
    scholarId,
    nodeKey: skillKey,
    ...(meta.itemId ? { itemId: meta.itemId } : {}),
    correct,
    ...(meta.clientEventId ? { clientEventId: meta.clientEventId } : {}),
    ...(meta.submissionFingerprint
      ? { submissionFingerprint: meta.submissionFingerprint }
      : {}),
    ...(meta.answerText !== undefined ? { answerText: meta.answerText } : {}),
    ...(meta.stemSnapshot !== undefined ? { stemSnapshot: meta.stemSnapshot } : {}),
    ...(meta.expectedAnswer !== undefined ? { expectedAnswer: meta.expectedAnswer } : {}),
    ...(clampedFirstKey !== undefined ? { firstKeyMs: clampedFirstKey } : {}),
    ...(censoredFirstKeyReading !== undefined
      ? { firstKeyMsCensored: censoredFirstKeyReading }
      : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    domain,
    strand: strand ?? DEFAULT_STRAND,
    lane,
    predictedRetention,
    ...(elapsedDaysSinceLast !== undefined ? { elapsedDaysSinceLast } : {}),
    ...(prev.halfLifeDays > 0 ? { halfLifeBefore: prev.halfLifeDays } : {}),
    ...(written.halfLifeDays > 0 ? { halfLifeAfter: written.halfLifeDays } : {}),
    repetitionBefore: prev.repetition,
    source: existing?.source ?? "practice",
    breakerEligible: meta.breakerEligible ?? true,
    ...(meta.scaffolded ? { scaffolded: true } : {}),
    ...(meta.explanationReason
      ? { explanationReason: meta.explanationReason, explanationRequestedAt: now }
      : {}),
    createdAt: now,
  });

  // ── Upward negative evidence (P2c): a miss on prerequisite `u` shortens the
  // leash on only its one-hop INFERRED dependents. Demonstrated rows and rows
  // with an honest attempt stamp are never touched; reps/source stay unchanged.
  if (!correct) {
    const directDependents = new Set(edges.filter((edge) => edge.fromKey === skillKey).map((edge) => edge.toKey));
    for (const dependentKey of directDependents) {
      const row = preMastery.get(dependentKey);
      if (!row) continue;
      if (isDemonstratedSource(row.source)) continue;
      if (row.lastAttemptAt !== undefined) continue;
      await ctx.db.patch(row._id, {
        halfLifeDays: Math.max(MIN_HALFLIFE_DAYS, row.halfLifeDays * HALFLIFE_LAPSE),
      });
    }
  }

  // ── FIRe implicit repetition (§4A): a CORRECT explicit attempt trickles
  //    fractional spaced-repetition credit down the prerequisite DAG. It
  //    refreshes retention ONLY on prerequisites the scholar has already
  //    demonstrated (a mastery row with repetition ≥ 1 and a lastPracticedAt) —
  //    never creates rows, and NEVER touches repetition/source/frontier
  //    (implicit credit is not a demonstration, so it can't flip a provisional
  //    skill to earned fluency: "colors are evidence", plan-of-record §10).
  //    Reads pre-attempt state from `preMastery`; the answered skill is excluded
  //    by `ancestorWeights` itself. Misses / placement / re-probe / record:false
  //    grades never reach here, so they never propagate. Credit flows over the
  //    INFERENCE graph (buildsOn ∪ implies): an `implies` edge trickles credit
  //    exactly like a `buildsOn` prerequisite, at the same default weight. ──
  if (correct) {
    for (const [ancestorKey, weight] of ancestorWeights(skillKey, inferenceEdges)) {
      const row = preMastery.get(ancestorKey);
      if (!row || row.repetition < 1 || row.lastPracticedAt === undefined) continue;
      if (shouldSkipImplicitCredit(residentStruggleSignal(row), baseline)) continue;
      const credited = applyImplicitCredit(stateFromRow(row), weight, now);
      await ctx.db.patch(row._id, {
        halfLifeDays: credited.halfLifeDays,
        lastPracticedAt: credited.lastPracticedAt,
        lastImplicitAt: now,
        implicitCount: (row.implicitCount ?? 0) + 1,
        // Deliberately DO NOT bump `updatedAt` here. It's the scholar-visible
        // "practiced today" clock (playlistForScholar keys `doneToday` /
        // `skillsPracticedToday` off `updatedAt >= startOfToday`) and also drives
        // strand round-robin (`lastServedByStrand` = MAX(updatedAt)) and the
        // accel-chain window. An implicit refresh must leave NO scholar-visible
        // trace (plan §4A invariant), so it only moves retention
        // (`halfLifeDays` / `lastPracticedAt`) + FIRe bookkeeping
        // (`lastImplicitAt` / `implicitCount`). (The plan's A1 wiring sketch
        // listed `updatedAt: now`, but that conflicts with its own invariant —
        // invariant wins.)
      });
    }
  }

  // Recompute the domain frontier from the FRESH (post-patch) mastery — so an
  // accelerated node unlocks its successors in the same call (the map opens
  // under the scholar). Cheap at this scale (tens of nodes).
  const mastery = await loadMastery(ctx, scholarId, domain);
  const postStateOf = await buildFrontierStateOf(ctx, scholarId, skills.map((s) => s.skillKey), edges, mastery);
  const frontier = new Set(
    computeFrontier(
      skills.map((s) => s.skillKey),
      edges.map((e) => ({ fromKey: e.fromKey, toKey: e.toKey })),
      postStateOf,
    ),
  );
  for (const row of mastery.values()) {
    const shouldBe = frontier.has(row.skillKey);
    if (row.frontier !== shouldBe) await ctx.db.patch(row._id, { frontier: shouldBe });
  }

  // Fire any mastery-gated cross-domain seeds now that this skill advanced.
  await maybeFireSeeds(ctx, scholarId, skillKey);

  const updated = mastery.get(skillKey);
  return {
    attemptId,
    lane,
    skillKey,
    repetition: updated?.repetition ?? written.repetition,
    proficiency: proficiencyFromReps(updated?.repetition ?? written.repetition),
    accelerated: accelerate,
    // Consolidation moment (P1e): this attempt just turned the skill fluent
    // (DEMONSTRATED false→true). `comesBackAt` is when it next returns as
    // review — the forgetting curve inverted with the SAME per-skill target the
    // scheduler uses — so the scholar sees "comes back ~Thursday". Undefined
    // when it didn't consolidate this attempt (or a valve jump, which stays
    // provisional and never trips the demonstrated-fluent gate).
    turnedFluent,
    comesBackAt: turnedFluent ? (dueAt(written, retentionThreshold) ?? undefined) : undefined,
  };
}

async function reconcileProblemSetDispatchCompletionsForResult(
  ctx: MutationCtx,
  args: {
    scholarId: Id<"users">;
    skillKey: string;
    now: number;
  },
): Promise<DispatchCompleted[]> {
  try {
    return (
      await reconcileProblemSetDispatchCompletions(ctx, args)
    ).dispatchCompleted;
  } catch (err) {
    console.error(
      "Problem-set dispatch completion reconciliation failed (ignored):",
      err,
    );
    return [];
  }
}

/** A scholar (or a teacher rehearsing) records the result of one practice item. */
export const recordAttempt = authedMutation({
  args: { scholarId: v.id("users"), skillKey: v.string(), correct: v.boolean(), domain: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const result = await recordAttemptCore(
      ctx,
      args.scholarId,
      args.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN,
      args.skillKey,
      args.correct,
      undefined,
      { breakerEligible: !isTeacher },
    );
    const dispatchCompleted = isTeacher
      ? []
      : await reconcileProblemSetDispatchCompletionsForResult(ctx, {
          scholarId: args.scholarId,
          skillKey: args.skillKey,
          now: Date.now(),
        });
    return { ...result, dispatchCompleted };
  },
});

async function spiralBackOff(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  now: number,
): Promise<
  | {
      missStreak: number;
      reattached: boolean;
      recoverySkillKey?: string;
      recoveryDomain?: string;
      streakAttemptIds: Id<"practiceAttempts">[];
      streakAttempts: Doc<"practiceAttempts">[];
      repair?: {
        version: 2;
        triggerAttemptId: Id<"practiceAttempts">;
        triggerNodeKey: string;
        domain: string;
      };
    }
  | undefined
> {
  const attempts = await ctx.db
    .query("practiceAttempts")
    .withIndex("by_scholar_createdAt", (q) => q.eq("scholarId", scholarId))
    // Exclude diagnostic retry rows BEFORE the bounded scan: they are lane-less
    // (so `consecutiveMissStreak` already skips them) but they are also the
    // NEWEST rows, generated exactly when a scholar is missing repeatedly. Left
    // in, they would burn slots out of the SPIRAL_SCAN_LIMIT window and push the
    // counted misses past it — silently disabling the back-off for precisely the
    // struggling scholars it targets. Filtering here spends the bound only on
    // rows the streak can count.
    .filter((q) => q.neq(q.field("retry"), true))
    .order("desc")
    .take(SPIRAL_SCAN_LIMIT);
  const streakNewestFirst = breakerMissStreakAttempts(attempts);
  const missStreak = streakNewestFirst.length;
  if (missStreak < SPIRAL_MISS_THRESHOLD) return undefined;
  const streakAttempts = streakNewestFirst.slice().reverse();
  const streakAttemptIds = streakAttempts.map((attempt) => attempt._id);
  const thresholdAttempt = streakAttempts[SPIRAL_MISS_THRESHOLD - 1]!;
  const latestCountedMissAt =
    streakAttempts.at(-1)?.createdAt ?? streakAttempts.at(-1)!._creationTime;
  let trigger = streakAttempts.find((attempt) => attempt.breakerLifecycle);
  let reattached = false;
  if (trigger?.breakerLifecycle) {
    const recovery = trigger.breaker?.recovery;
    const episode = projectBreakerEpisode(
      trigger.breakerLifecycle,
      latestCountedMissAt,
      now,
      recovery === "won" || recovery === "missed" ? recovery : undefined,
    );
    if (episode.status !== "active") return undefined;
    reattached = missStreak > SPIRAL_MISS_THRESHOLD;
  } else {
    trigger = thresholdAttempt;
    if (!trigger.breakerLifecycle) {
      await ctx.db.patch(trigger._id, {
        breakerLifecycle: {
          version: 2,
          triggerNodeKey: trigger.nodeKey,
          triggeredAt: now,
        },
      });
    }
    reattached = missStreak > SPIRAL_MISS_THRESHOLD;
  }

  const mastery = await ctx.db
    .query("practiceMastery")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  const latencyBaseline = latencyBaselineFromSkillMedians(
    mastery.map((row) => row.latencyMedianMs ?? NaN),
  );
  const runnable = await runnableSkillKeySet(
    ctx,
    mastery.map((row) => row.skillKey),
  );
  const recovery = pickRecoverySkill(mastery, { now, latencyBaseline }, (key) =>
    runnable.has(key),
  );
  const repair = {
    version: 2 as const,
    triggerAttemptId: trigger._id,
    triggerNodeKey: trigger.nodeKey,
    domain: trigger.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN,
  };

  return {
    missStreak,
    reattached,
    streakAttemptIds,
    streakAttempts,
    repair,
    ...(recovery
      ? { recoverySkillKey: recovery.skillKey, recoveryDomain: recovery.domain }
      : {}),
  };
}

/**
 * Recover the currently live breaker handle after a client loses its local
 * state. It reads the same bounded counted-miss window as `spiralBackOff`;
 * historic and closed episodes deliberately return null.
 *
 * This returns the WHOLE episode, not just a handle, because a resuming client
 * must never re-derive breaker progress from its own memory or timers: `flow`
 * is replayed from durable evidence by `breakerFlowFromLifecycle`,
 * `triggerItemId` names the item the repair rung belongs to, `repairStepIndex`
 * is the rung already served (so re-serving it restores the scholar's place
 * instead of handing out a new hint), and the pinned fresh/easy identities let
 * the client rebuild the exact item the server already committed to.
 */
/**
 * The CURRENT scope/day fingerprint, without serving a run. A client holding a
 * persisted resume snapshot reads this to decide whether the snapshot is still
 * honorable before restoring it: `practiceSession` stamps the same two values
 * onto the run it serves, so a Math-plan edit, a standing-assignment change, or
 * an institution-local day rollover invalidates the snapshot rather than
 * resuming the scholar into content or a day that no longer applies. Deliberately
 * a query with no side effects — validating a snapshot must never consume a
 * serve or advance any scheduler state.
 */
export const practiceScopeSnapshotKey = authedQuery({
  args: { scholarId: v.id("users") },
  returns: v.object({ scopeKey: v.string(), dayKey: v.string() }),
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const { practiceScope } = await resolvePracticeScope(ctx, args.scholarId);
    return {
      scopeKey: practiceScopeKey(practiceScope),
      dayKey: dayKeyForTimezone(
        Date.now(),
        await timeZoneForScholar(ctx, args.scholarId),
      ),
    };
  },
});

export const activeBreakerEpisode = authedQuery({
  args: { scholarId: v.id("users") },
  returns: v.union(
    v.null(),
    v.object({
      version: v.literal(2),
      triggerAttemptId: v.id("practiceAttempts"),
      triggerNodeKey: v.string(),
      domain: v.string(),
      missStreak: v.number(),
      lastActivityAt: v.number(),
      expiresAt: v.number(),
      // The item the trigger miss was on — the repair rung's owner.
      triggerItemId: v.optional(v.string()),
      // The client flow state, replayed from durable evidence rather than
      // reconstructed by the client from timestamps.
      flow: v.object({
        stage: v.union(
          v.literal("repair"),
          v.literal("coach"),
          v.literal("fresh"),
          v.literal("easy"),
          v.literal("close"),
        ),
        repair: v.union(
          v.literal("opening"),
          v.literal("open"),
          v.literal("done"),
          v.literal("unavailable"),
        ),
        coachUsed: v.boolean(),
        fresh: v.optional(
          v.object({
            correct: v.boolean(),
            assisted: v.boolean(),
            verified: v.boolean(),
          }),
        ),
        easy: v.optional(
          v.union(
            v.literal("requested"),
            v.literal("unavailable"),
            v.literal("correct"),
            v.literal("missed"),
          ),
        ),
      }),
      // The repair rung already served for the trigger item, so a resume
      // re-serves THAT rung (idempotent) rather than advancing the ladder.
      repairStepIndex: v.optional(v.number()),
      repairRungKind: v.optional(
        v.union(v.literal("completion"), v.literal("reveal")),
      ),
      // Server-pinned recovery items, so a resume reconstructs exactly what was
      // already issued instead of asking for something new.
      freshItemId: v.optional(v.string()),
      easyItemId: v.optional(v.string()),
      easyDomain: v.optional(v.string()),
      confirmedLifecycle: v.array(
        v.union(
          v.literal("repairShown"),
          v.literal("repairUnavailable"),
          v.literal("repairStarted"),
          v.literal("repairCompleted"),
          v.literal("coachEscalated"),
          v.literal("stopped"),
        ),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const attempts = await ctx.db
      .query("practiceAttempts")
      .withIndex("by_scholar_createdAt", (q) => q.eq("scholarId", args.scholarId))
      .filter((q) => q.neq(q.field("retry"), true))
      .order("desc")
      .take(SPIRAL_SCAN_LIMIT);
    const streakNewestFirst = breakerMissStreakAttempts(attempts);
    const missStreak = streakNewestFirst.length;
    if (missStreak < SPIRAL_MISS_THRESHOLD) return null;
    const streakAttempts = streakNewestFirst.slice().reverse();
    const trigger = streakAttempts.find((attempt) => attempt.breakerLifecycle);
    if (!trigger?.breakerLifecycle) return null;
    const latestCountedMissAt =
      streakAttempts.at(-1)?.createdAt ?? streakAttempts.at(-1)!._creationTime;
    const recovery = trigger.breaker?.recovery;
    const easyResult =
      recovery === "won" || recovery === "missed" ? recovery : undefined;
    const episode = projectBreakerEpisode(
      trigger.breakerLifecycle,
      latestCountedMissAt,
      Date.now(),
      easyResult,
    );
    if (episode.status !== "active") return null;
    const lifecycle = trigger.breakerLifecycle;
    // The rung the scholar was actually looking at. `serveHintStep` allows
    // re-serving an already-served index without advancing the ladder, so
    // handing this back is a restore rather than a fresh hint.
    const reveal = trigger.itemId
      ? await latestHintReveal(ctx, args.scholarId, trigger.itemId)
      : null;
    return {
      version: 2 as const,
      triggerAttemptId: trigger._id,
      triggerNodeKey: lifecycle.triggerNodeKey,
      domain: trigger.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN,
      missStreak,
      lastActivityAt: episode.lastActivityAt,
      expiresAt: episode.expiresAt,
      ...(trigger.itemId ? { triggerItemId: trigger.itemId } : {}),
      flow: breakerFlowFromLifecycle(lifecycle, easyResult),
      ...(reveal ? { repairStepIndex: reveal.maxStepServed } : {}),
      ...(lifecycle.repairRungKind ? { repairRungKind: lifecycle.repairRungKind } : {}),
      ...(lifecycle.freshItemId ? { freshItemId: lifecycle.freshItemId } : {}),
      ...(lifecycle.easyItemId ? { easyItemId: lifecycle.easyItemId } : {}),
      ...(lifecycle.easyDomain ? { easyDomain: lifecycle.easyDomain } : {}),
      confirmedLifecycle:
        recordedBreakerLifecycleOperations(lifecycle),
    };
  },
});

export const recordBreakerOutcome = authedMutation({
  args: {
    scholarId: v.id("users"),
    attemptId: v.optional(v.id("practiceAttempts")),
    itemId: v.string(),
    streak: v.number(),
    offer: v.union(v.literal("accepted"), v.literal("declined")),
    recovery: v.optional(
      v.union(
        v.literal("won"),
        v.literal("missed"),
        v.literal("none"),
        v.literal("skipped"),
      ),
    ),
  },
  returns: v.object({ recorded: v.boolean() }),
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const attempt = args.attemptId
      ? await ctx.db.get(args.attemptId)
      : await ctx.db
          .query("practiceAttempts")
          .withIndex("by_scholar_item_createdAt", (q) =>
            q.eq("scholarId", args.scholarId).eq("itemId", args.itemId),
          )
          .filter((q) => q.neq(q.field("retry"), true))
          .order("desc")
          .first();
    if (
      !attempt ||
      attempt.scholarId !== args.scholarId ||
      attempt.itemId !== args.itemId ||
      attempt.correct ||
      !isBreakerCountedAttempt(attempt)
    ) {
      return { recorded: false };
    }
    // Client-reported, low-stakes telemetry; it never affects mastery or serving.
    // The first report records the choice immediately with "none" as the
    // schema-required pending sentinel. A later report may fill that sentinel,
    // but duplicate/stale reports never erase or replace completed telemetry.
    const prior = attempt.breaker;
    const recovery =
      prior?.recovery && prior.recovery !== "none"
        ? prior.recovery
        : (args.recovery ?? prior?.recovery ?? "none");
    const breaker = {
      streak: prior?.streak ?? args.streak,
      offer: prior?.offer ?? args.offer,
      recovery,
    };
    if (
      prior?.streak !== breaker.streak ||
      prior?.offer !== breaker.offer ||
      prior?.recovery !== breaker.recovery
    ) {
      await ctx.db.patch(attempt._id, { breaker });
    }
    if (attempt.breakerLifecycle) {
      await ctx.scheduler.runAfter(
        0,
        internal.practiceStuckAlert.postOutcome,
        { triggerAttemptId: attempt._id },
      );
    }
    return { recorded: true };
  },
});

/**
 * Server-stamped recovery lifecycle for the step-card repair rung. This is
 * intentionally distinct from `recordBreakerOutcome`: the latter remains the
 * compatibility API for the pre-v2 binary offer and legacy rows.
 */
export const recordBreakerRecoveryLifecycle = authedMutation({
  args: {
    scholarId: v.id("users"),
    triggerAttemptId: v.id("practiceAttempts"),
    event: v.union(
      v.literal("repair_shown"),
      v.literal("repair_unavailable"),
      v.literal("repair_started"),
      v.literal("repair_completed"),
      v.literal("coach_escalated"),
      v.literal("easy_exit"),
      v.literal("stopped"),
      v.literal("fresh_result"),
    ),
    // The served item's opaque id, not a claimed outcome. The server resolves
    // the graded attempt and records its actual result.
    freshItemId: v.optional(v.string()),
  },
  returns: v.object({
    recorded: v.boolean(),
    lifecycle: v.optional(
      v.object({
        version: v.literal(2),
        triggerNodeKey: v.string(),
        triggeredAt: v.number(),
        repairShownAt: v.optional(v.number()),
        repairRungKind: v.optional(
          v.union(v.literal("completion"), v.literal("reveal")),
        ),
        repairUnavailableAt: v.optional(v.number()),
        repairStartedAt: v.optional(v.number()),
        repairCompletedAt: v.optional(v.number()),
        coachEscalatedAt: v.optional(v.number()),
        easyExitedAt: v.optional(v.number()),
        stoppedAt: v.optional(v.number()),
        freshItemId: v.optional(v.string()),
        freshIssuedAt: v.optional(v.number()),
        easyItemId: v.optional(v.string()),
        easyDomain: v.optional(v.string()),
        easyIssuedAt: v.optional(v.number()),
        easyUnavailableAt: v.optional(v.number()),
        freshResult: v.optional(
          v.object({
            attemptId: v.id("practiceAttempts"),
            itemId: v.string(),
            correct: v.boolean(),
            assisted: v.optional(v.boolean()),
            completedAt: v.number(),
          }),
        ),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const trigger = await ctx.db.get(args.triggerAttemptId);
    if (
      !trigger ||
      trigger.scholarId !== args.scholarId ||
      trigger.correct ||
      !isBreakerCountedAttempt(trigger)
    ) {
      return { recorded: false };
    }
    const now = Date.now();
    const prior = trigger.breakerLifecycle;
    if (!prior) return { recorded: false };
    const lifecycle: {
      version: 2;
      triggerNodeKey: string;
      triggeredAt: number;
      repairShownAt?: number;
      repairRungKind?: "completion" | "reveal";
      repairUnavailableAt?: number;
      repairStartedAt?: number;
      repairCompletedAt?: number;
      coachEscalatedAt?: number;
      easyExitedAt?: number;
      stoppedAt?: number;
      freshItemId?: string;
      freshIssuedAt?: number;
      easyItemId?: string;
      easyDomain?: string;
      easyIssuedAt?: number;
      easyUnavailableAt?: number;
      freshResult?: {
        attemptId: Id<"practiceAttempts">;
        itemId: string;
        correct: boolean;
        assisted?: boolean;
        completedAt: number;
      };
    } = prior;

    // Each lifecycle field is write-once. Replays are harmless; incompatible
    // backwards transitions are ignored rather than replacing durable evidence.
    if (args.event === "repair_shown") {
      if (lifecycle.repairShownAt !== undefined) {
        return { recorded: true, lifecycle };
      }
      lifecycle.repairShownAt = now;
    } else if (args.event === "repair_unavailable") {
      if (lifecycle.repairUnavailableAt !== undefined) {
        return { recorded: true, lifecycle };
      }
      lifecycle.repairUnavailableAt = now;
    } else if (args.event === "repair_started") {
      if (lifecycle.repairStartedAt !== undefined) {
        return { recorded: true, lifecycle };
      }
      lifecycle.repairStartedAt = now;
    } else if (args.event === "repair_completed") {
      if (
        (!lifecycle.repairStartedAt &&
          !(
            lifecycle.repairShownAt &&
            lifecycle.repairRungKind === "reveal"
          )) ||
        lifecycle.repairCompletedAt !== undefined ||
        lifecycle.easyExitedAt !== undefined ||
        lifecycle.freshResult
      ) {
        return { recorded: Boolean(prior), ...(prior ? { lifecycle } : {}) };
      }
      lifecycle.repairCompletedAt = now;
    } else if (args.event === "coach_escalated") {
      if (
        (!lifecycle.repairStartedAt &&
          !lifecycle.repairShownAt &&
          !lifecycle.repairUnavailableAt) ||
        lifecycle.coachEscalatedAt !== undefined ||
        lifecycle.easyExitedAt !== undefined ||
        lifecycle.freshResult
      ) {
        return { recorded: Boolean(prior), ...(prior ? { lifecycle } : {}) };
      }
      lifecycle.coachEscalatedAt = now;
    } else if (args.event === "easy_exit") {
      if (
        lifecycle.easyExitedAt !== undefined ||
        lifecycle.stoppedAt !== undefined ||
        lifecycle.freshResult?.correct === true
      ) {
        return { recorded: Boolean(prior), ...(prior ? { lifecycle } : {}) };
      }
      lifecycle.easyExitedAt = now;
    } else if (args.event === "stopped") {
      if (
        lifecycle.stoppedAt !== undefined ||
        lifecycle.easyExitedAt !== undefined ||
        lifecycle.freshResult?.correct === true
      ) {
        return { recorded: Boolean(prior), ...(prior ? { lifecycle } : {}) };
      }
      lifecycle.stoppedAt = now;
    } else {
      if (lifecycle.freshResult) {
        return { recorded: true, lifecycle };
      }
      if (
        (!lifecycle.repairCompletedAt && !lifecycle.coachEscalatedAt) ||
        lifecycle.easyExitedAt !== undefined ||
        lifecycle.stoppedAt !== undefined
      ) {
        return { recorded: Boolean(prior), ...(prior ? { lifecycle } : {}) };
      }
      if (!args.freshItemId || lifecycle.freshItemId !== args.freshItemId) {
        return { recorded: false, lifecycle };
      }
      const fresh = await ctx.db
        .query("practiceAttempts")
        .withIndex("by_scholar_item_createdAt", (q) =>
          q.eq("scholarId", args.scholarId).eq("itemId", args.freshItemId!),
        )
        .order("desc")
        .first();
      const supportAt = Math.max(
        lifecycle.repairCompletedAt ?? Number.NEGATIVE_INFINITY,
        lifecycle.coachEscalatedAt ?? Number.NEGATIVE_INFINITY,
      );
      const freshHintReveal = await latestHintReveal(
        ctx,
        args.scholarId,
        args.freshItemId,
      );
      if (
        !fresh ||
        fresh.scholarId !== args.scholarId ||
        fresh.nodeKey !== trigger.nodeKey ||
        !fresh.itemId ||
        fresh.retry === true ||
        fresh.scaffolded === true ||
        fresh.explanationReason !== undefined ||
        fresh.teachOutcome !== undefined ||
        (freshHintReveal !== null && freshHintReveal.createdAt >= supportAt) ||
        (trigger.itemId &&
          canonicalItemIdentity(fresh.itemId) ===
            canonicalItemIdentity(trigger.itemId)) ||
        (fresh.createdAt ?? fresh._creationTime) <=
          Math.max(
            trigger.createdAt ?? trigger._creationTime,
            supportAt,
          )
      ) {
        return { recorded: false, lifecycle };
      }
      lifecycle.freshResult = {
        attemptId: fresh._id,
        itemId: fresh.itemId,
        correct: fresh.correct,
        assisted: false,
        completedAt: now,
      };
    }

    await ctx.db.patch(trigger._id, { breakerLifecycle: lifecycle });
    const terminal =
      lifecycle.freshResult?.correct === true ||
      lifecycle.stoppedAt !== undefined ||
      Boolean(
        lifecycle.easyExitedAt !== undefined &&
          trigger.breaker?.recovery &&
          trigger.breaker.recovery !== "none",
      );
    await ctx.scheduler.runAfter(
      terminal ? 0 : SPIRAL_GAP_MS,
      internal.practiceStuckAlert.postOutcome,
      { triggerAttemptId: trigger._id },
    );
    return { recorded: true, lifecycle };
  },
});

// Recovery items are always served bare, single-slot, into the trigger's own
// node with no scholar-facing chip beyond the ordinary "new" lane — shared by
// both the first-issue path and the idempotent-replay reconstruction below so
// the two can never drift.
function stripRecoveryScaffolds(item: ServedItem): ServedItem {
  delete item.workedSteps;
  delete item.scaffoldLevel;
  delete item.answerFormat;
  item.lane = "new";
  return item;
}

/**
 * Resolve the server-issued recovery target into exactly one bare, distinct
 * same-node item. Client-supplied skill/domain values are deliberately absent:
 * the threshold-crossing attempt and its lifecycle are the authority.
 *
 * Idempotent by construction: once a fresh item has been stamped onto the
 * trigger's lifecycle (a prior call whose response the client never saw — a
 * dropped response, a reload, a retry with a NEW random `seed`), every later
 * call for the SAME trigger reconstructs and re-returns that exact item
 * instead of drawing a new one. Re-serving is not an option here: the
 * underlying draw is randomized by the caller's seed and, for a stored
 * variant, further depends on `Date.now()`-scoped recent-history state — a
 * second draw is not guaranteed (or even likely) to reproduce the first. An
 * itemId is a pure, deterministic reference (`lib/practice/session.ts`), so
 * reconstructing directly from it is the only representation this can be
 * made safe against duplicate calls without storing the whole served item.
 */
export const breakerRecoverySession = authedMutation({
  args: {
    scholarId: v.id("users"),
    triggerAttemptId: v.id("practiceAttempts"),
    seed: v.number(),
  },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const trigger = await ctx.db.get(args.triggerAttemptId);
    if (
      !trigger ||
      trigger.scholarId !== args.scholarId ||
      !trigger.breakerLifecycle ||
      trigger.correct ||
      !isBreakerCountedAttempt(trigger) ||
      (!trigger.breakerLifecycle.repairCompletedAt &&
        !trigger.breakerLifecycle.coachEscalatedAt) ||
      trigger.breakerLifecycle.easyExitedAt !== undefined ||
      trigger.breakerLifecycle.freshResult !== undefined
    ) {
      throw new Error("Recovery session is not available for this attempt");
    }
    const domain = trigger.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN;
    const nodeKey = trigger.breakerLifecycle.triggerNodeKey;

    const alreadyIssuedItemId = trigger.breakerLifecycle.freshItemId;
    if (alreadyIssuedItemId) {
      const item = stripRecoveryScaffolds(
        servedItemFromServable(
          await resolveServableItem(ctx, alreadyIssuedItemId, domain),
          false,
        ),
      );
      return { triggerAttemptId: trigger._id, nodeKey, domain, items: [item] };
    }

    const { skills } = await loadDomain(ctx, domain);
    if (!skills.some((skill) => skill.skillKey === nodeKey)) {
      throw new Error("Recovery target is unavailable");
    }
    const mastery = await loadMastery(ctx, args.scholarId, domain);
    const labelOf = new Map(skills.map((skill) => [skill.skillKey, skill.label]));
    const recentIdentities = await recentServedIdentities(ctx, args.scholarId, Date.now());
    const served = await serveItems(
      ctx,
      {
        entries: [{ key: nodeKey, domain }],
        labelByKey: labelOf,
        masteryByKey: mastery,
        laneByKey: new Map([[nodeKey, "new"]]),
        seed: args.seed,
        size: 1,
        stampDomain: false,
        firstPostPlacementBlock: false,
        calibrationSkillKeys: [],
        recentIdentities,
        // Recovery evidence must be a bare item, never cold-gated teaching.
        coldFailedSkillKeys: new Set(),
      },
      { ...SESSION_POLICY, manipulativeGuarantee: false },
    );
    const item = served[0];
    if (
      !item ||
      item.skillKey !== nodeKey ||
      item.answerType === MANIPULATIVE_ANSWER_TYPE ||
      item.answerType === "dialogue" ||
      !trigger.itemId ||
      canonicalItemIdentity(item.itemId) === canonicalItemIdentity(trigger.itemId)
    ) {
      throw new Error("A fresh recovery item is unavailable");
    }
    // Stored variants can carry faded worked steps even without the cold gate.
    // Strip all answer-producing scaffolds structurally before this wire leaves
    // the server, and persist `scaffolded` on later graded attempts as a guard.
    stripRecoveryScaffolds(item);
    await ctx.db.patch(trigger._id, {
      breakerLifecycle: {
        ...trigger.breakerLifecycle,
        freshItemId: item.itemId,
        freshIssuedAt: Date.now(),
      },
    });

    return { triggerAttemptId: trigger._id, nodeKey, domain, items: [item] };
  },
});

/**
 * Atomically select and pin the breaker's one easy finish. The trigger is the
 * authority: clients supply only entropy for the item variant, never a skill or
 * domain that could escape the scholar's current Practice scope.
 */
export const breakerEasyFinishSession = authedMutation({
  args: {
    scholarId: v.id("users"),
    triggerAttemptId: v.id("practiceAttempts"),
    seed: v.number(),
  },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const trigger = await ctx.db.get(args.triggerAttemptId);
    const lifecycle = trigger?.breakerLifecycle;
    if (
      !trigger ||
      trigger.scholarId !== args.scholarId ||
      trigger.correct ||
      !lifecycle ||
      !isBreakerCountedAttempt(trigger)
    ) {
      throw new Error("Easy finish is not available for this attempt");
    }
    if (lifecycle.easyItemId) {
      const domain = lifecycle.easyDomain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN;
      const item = applyAnswerFormatFade(
        [
          servedItemFromServable(
            await resolveServableItem(ctx, lifecycle.easyItemId, domain),
            false,
          ),
        ],
        await loadMastery(ctx, args.scholarId, domain),
      )[0];
      item.lane = "new";
      return { available: true as const, triggerAttemptId: trigger._id, items: [item] };
    }
    if (lifecycle.easyUnavailableAt !== undefined) {
      return { available: false as const, triggerAttemptId: trigger._id, items: [] as ServedItem[] };
    }
    if (
      lifecycle.stoppedAt !== undefined ||
      lifecycle.freshResult?.correct === true ||
      lifecycle.easyExitedAt !== undefined
    ) {
      throw new Error("Easy finish is not available for this attempt");
    }
    const recentAttempts = await ctx.db
      .query("practiceAttempts")
      .withIndex("by_scholar_createdAt", (q) => q.eq("scholarId", args.scholarId))
      .filter((q) => q.neq(q.field("retry"), true))
      .order("desc")
      .take(SPIRAL_SCAN_LIMIT);
    const currentStreakNewestFirst = breakerMissStreakAttempts(recentAttempts);
    const currentStreak = currentStreakNewestFirst.length;
    const currentStreakAttempts = currentStreakNewestFirst.slice().reverse();
    const latestCountedMissAt =
      currentStreakAttempts.at(-1)?.createdAt ??
      currentStreakAttempts.at(-1)?._creationTime;
    const easyResult = trigger.breaker?.recovery;
    if (
      currentStreak < SPIRAL_MISS_THRESHOLD ||
      !currentStreakAttempts.some((attempt) => attempt._id === trigger._id) ||
      latestCountedMissAt === undefined ||
      projectBreakerEpisode(
        lifecycle,
        latestCountedMissAt,
        Date.now(),
        easyResult === "won" || easyResult === "missed" ? easyResult : undefined,
      ).status !== "active"
    ) {
      throw new Error("Easy finish is not available for this attempt");
    }

    const [{ practiceScope }, mastery] = await Promise.all([
      resolvePracticeScope(ctx, args.scholarId),
      ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
        .collect(),
    ]);
    const inScopeMastery = mastery.filter((row) =>
      practiceScopeAllowsNode(practiceScope, row.domain, row.strand),
    );
    const runnable = await runnableSkillKeySet(ctx, inScopeMastery.map((row) => row.skillKey));
    const latencyBaseline = latencyBaselineFromSkillMedians(
      mastery.map((row) => row.latencyMedianMs ?? NaN),
    );
    const recovery = pickRecoverySkill(
      inScopeMastery,
      { now: Date.now(), latencyBaseline },
      (key) => runnable.has(key),
    );
    const unavailable = async () => {
      const now = Date.now();
      await ctx.db.patch(trigger._id, {
        breakerLifecycle: {
          ...lifecycle,
          easyExitedAt: now,
          easyUnavailableAt: now,
        },
      });
      await ctx.scheduler.runAfter(SPIRAL_GAP_MS, internal.practiceStuckAlert.postOutcome, {
        triggerAttemptId: trigger._id,
      });
      return { available: false as const, triggerAttemptId: trigger._id, items: [] as ServedItem[] };
    };
    if (!recovery) return await unavailable();

    const { skills } = await loadDomain(ctx, recovery.domain);
    const node = skills.find((skill) => skill.skillKey === recovery.skillKey);
    if (!node || !practiceScopeAllowsNode(practiceScope, node.domain, node.strand)) {
      return await unavailable();
    }
    const masteryByKey = await loadMastery(ctx, args.scholarId, recovery.domain);
    const served = await serveItems(
      ctx,
      {
        entries: [{ key: recovery.skillKey, domain: recovery.domain }],
        labelByKey: new Map(skills.map((skill) => [skill.skillKey, skill.label])),
        masteryByKey,
        laneByKey: new Map([[recovery.skillKey, "new"]]),
        seed: args.seed,
        size: 1,
        stampDomain: false,
        firstPostPlacementBlock: false,
        calibrationSkillKeys: [],
        recentIdentities: await recentServedIdentities(ctx, args.scholarId, Date.now()),
        coldFailedSkillKeys: new Set(),
      },
      SESSION_POLICY,
    );
    const item = served[0];
    if (!item || item.skillKey !== recovery.skillKey) return await unavailable();

    const now = Date.now();
    await ctx.db.patch(trigger._id, {
      breakerLifecycle: {
        ...lifecycle,
        easyExitedAt: now,
        easyItemId: item.itemId,
        easyDomain: recovery.domain,
        easyIssuedAt: now,
      },
    });
    return { available: true as const, triggerAttemptId: trigger._id, items: [item] };
  },
});

/**
 * Record a scholar's post-verdict admission that a correct answer used help, then
 * offer one bare, distinct retry at the same node. It reuses `scaffolded` rather
 * than inventing a second not-independent vocabulary: server-detected support and
 * the scholar's own admission both withdraw the same fluency claim, while
 * `selfReportedHelp` preserves the provenance. A wrong prediction/admission is
 * useful learning data, never shame.
 */
export const reportHelpUsed = authedMutation({
  args: {
    scholarId: v.id("users"),
    attemptId: v.id("practiceAttempts"),
    seed: v.number(),
  },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const attempt = await ctx.db.get(args.attemptId);
    const createdAt = attempt
      ? (attempt.createdAt ?? attempt._creationTime)
      : undefined;
    if (
      !attempt ||
      attempt.scholarId !== args.scholarId ||
      attempt.correct !== true ||
      attempt.retry === true ||
      attempt.explanationReason !== undefined ||
      createdAt === undefined ||
      createdAt < Date.now() - SELF_REPORTED_HELP_WINDOW_MS
    ) {
      return { recorded: false, items: [] as ServedItem[] };
    }
    if (attempt.selfReportedHelp === true) {
      return { recorded: true, items: [] as ServedItem[] };
    }

    // Captured before the patch: the admission only "sets" scaffolded when the
    // server hadn't already detected help of its own.
    const scaffoldedSet = attempt.scaffolded !== true;
    await ctx.db.patch(attempt._id, { selfReportedHelp: true, scaffolded: true });
    const masteryRow = await ctx.db
      .query("practiceMastery")
      .withIndex("by_scholar_skill", (q) =>
        q.eq("scholarId", args.scholarId).eq("skillKey", attempt.nodeKey),
      )
      .first();
    const demoted = !!masteryRow && isDemonstratedSource(masteryRow.source);
    if (demoted && masteryRow) {
      // Access/reps were earned; only the bare-demonstration provenance is withdrawn.
      await ctx.db.patch(masteryRow._id, { source: SCAFFOLDED_SOURCE });
    }
    // Remember precisely what this admission changed. A mis-tap is undone by
    // replaying this record backwards, never by assuming the prior state.
    await ctx.db.patch(attempt._id, {
      helpAdmissionUndo: {
        scaffoldedSet,
        ...(demoted && masteryRow ? { masterySource: masteryRow.source } : null),
      },
    });

    const domain = attempt.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN;
    let items: ServedItem[] = [];
    try {
      // The retry is a SERVED item, so it obeys the same Practice scope every
      // other serving path does. An attempt can outlive the plan that produced
      // it (a teacher narrows the scope between the answer and the admission),
      // and owning up must never be the doorway back into a domain or strand
      // the scholar is no longer meant to be practising.
      const { practiceScope } = await resolvePracticeScope(ctx, args.scholarId);
      const { skills } = scopeLoadedDomain(practiceScope, domain, await loadDomain(ctx, domain));
      const node = skills.find((skill) => skill.skillKey === attempt.nodeKey);
      const mastery = await loadMastery(ctx, args.scholarId, domain);
      const labelOf = new Map(skills.map((skill) => [skill.skillKey, skill.label]));
      const recentIdentities = await recentServedIdentities(ctx, args.scholarId, Date.now());
      const served = node
        ? await serveItems(
            ctx,
            {
              entries: [{ key: attempt.nodeKey, domain }],
              labelByKey: labelOf,
              masteryByKey: mastery,
              laneByKey: new Map([[attempt.nodeKey, "new"]]),
              seed: args.seed,
              size: 1,
              stampDomain: false,
              firstPostPlacementBlock: false,
              calibrationSkillKeys: [],
              recentIdentities,
              coldFailedSkillKeys: new Set(),
            },
            { ...SESSION_POLICY, manipulativeGuarantee: false },
          )
        : [];
      const item = served[0];
      if (
        item &&
        item.skillKey === attempt.nodeKey &&
        item.answerType !== MANIPULATIVE_ANSWER_TYPE &&
        item.answerType !== "dialogue" &&
        // Distinctness is only checkable when the answered item identified
        // itself. An attempt recorded without an `itemId` (the item-free
        // `recordAttempt` path) still deserves its unaided shot — `serveItems`
        // already avoids recently served identities.
        (!attempt.itemId ||
          canonicalItemIdentity(item.itemId) !== canonicalItemIdentity(attempt.itemId))
      ) {
        // A fresh proof must be answer-free even if a stored variant carries fades.
        delete item.workedSteps;
        delete item.scaffoldLevel;
        delete item.answerFormat;
        items = [item];
      }
    } catch {
      // The honesty record and fluency correction must survive an unavailable item.
      items = [];
    }
    return { recorded: true, items };
  },
});

/**
 * Take back a "I did this with help" admission — a mis-tap, not a confession the
 * scholar is stuck with. It rewinds exactly what `reportHelpUsed` recorded
 * itself changing (`helpAdmissionUndo`) and nothing more, so an undo can never
 * manufacture a fluency claim: a server-detected scaffold stays, and a mastery
 * row that something else has since touched is left alone. An admission written
 * before this record existed clears the flag only — guessing there could erase a
 * scaffold the server genuinely saw, and "not yet fluent" is the safe direction
 * to be wrong in.
 */
export const undoHelpUsed = authedMutation({
  args: {
    scholarId: v.id("users"),
    attemptId: v.id("practiceAttempts"),
  },
  returns: v.object({ undone: v.boolean() }),
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const attempt = await ctx.db.get(args.attemptId);
    const createdAt = attempt
      ? (attempt.createdAt ?? attempt._creationTime)
      : undefined;
    if (
      !attempt ||
      attempt.scholarId !== args.scholarId ||
      attempt.selfReportedHelp !== true ||
      createdAt === undefined ||
      createdAt < Date.now() - SELF_REPORTED_HELP_WINDOW_MS
    ) {
      // Idempotent and quiet, exactly like the admission it reverses.
      return { undone: false };
    }
    const undo = attempt.helpAdmissionUndo;
    await ctx.db.patch(attempt._id, {
      selfReportedHelp: undefined,
      helpAdmissionUndo: undefined,
      ...(undo?.scaffoldedSet ? { scaffolded: undefined } : null),
    });
    if (undo?.masterySource !== undefined) {
      const masteryRow = await ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar_skill", (q) =>
          q.eq("scholarId", args.scholarId).eq("skillKey", attempt.nodeKey),
        )
        .first();
      // Only rewind OUR demotion. If the row has moved on since — a later bare
      // demonstration, another admission — it belongs to that event now.
      if (masteryRow && masteryRow.source === SCAFFOLDED_SOURCE) {
        await ctx.db.patch(masteryRow._id, { source: undo.masterySource });
      }
    }
    return { undone: true };
  },
});

export const scholarCoachContext = internalQuery({
  args: {
    callerUserId: v.id("users"),
    scholarId: v.id("users"),
    skillKey: v.optional(v.string()),
    entryMode: v.optional(
      v.union(
        v.literal("stuck"),
        v.literal("spiral"),
        v.literal("ladder"),
        v.literal("game"),
      ),
    ),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller) throw new Error("Forbidden");
    const isTeacher = requireTeacherOrSelf(caller, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, caller, args.scholarId);
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar) throw new Error("Scholar not found");
    const skillKey = args.skillKey;
    const mastery = skillKey
      ? await ctx.db
          .query("practiceMastery")
          .withIndex("by_scholar_skill", (q) =>
            q.eq("scholarId", args.scholarId).eq("skillKey", skillKey),
          )
          .first()
      : null;
    return resolveScholarCoachContext({
      scholar,
      mastery,
      skillKey,
      entryMode: args.entryMode,
      now: args.now,
    });
  },
});

/** Internal variant for seeds/tests/server actions (no auth gate). */
export const recordAttemptInternal = internalMutation({
  args: { scholarId: v.id("users"), skillKey: v.string(), correct: v.boolean(), domain: v.optional(v.string()) },
  handler: async (ctx, args) =>
    recordAttemptCore(ctx, args.scholarId, args.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN, args.skillKey, args.correct),
});

/**
 * Resolve an `itemId` to a unified `ServableItem` (its prompt + server-only
 * verifier), the ctx-bound wiring around the pure `servable.ts` builders. Tries
 * the deterministic template engine first (an id that doesn't parse to a known
 * template falls through, exactly as `gradeTemplateItem` returns null), then a
 * stored "gen#<id>" `practiceItems` row; anything else is an unknown item. The
 * display label + domain come from the skill's `knowledgeNodes` row (the same
 * lookup the old inline grader did), defaulting to `defaultDomain`.
 */
async function resolveServableItem(
  ctx: QueryCtx | MutationCtx,
  itemId: string,
  defaultDomain: string,
): Promise<ServableItem> {
  const nodeFor = async (skillKey: string) =>
    (await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_nodeKey", (q) => q.eq("nodeKey", skillKey))
      .first()) ?? null;

  const parsed = parseItemId(itemId);
  if (parsed && hasTemplate(parsed.skillKey)) {
    const node = await nodeFor(parsed.skillKey);
    const item = buildTemplateServable(itemId, node, defaultDomain);
    if (item) return item;
  }
  if (itemId.startsWith("gen#")) {
    const doc = await ctx.db.get(itemId.slice(4) as Id<"practiceItems">);
    if (!doc) throw new Error("Unknown generated item");
    const node = await nodeFor(doc.skillKey);
    const item = buildStoredServable(itemId, doc, node, defaultDomain);
    if (!item) throw new Error("Unservable stored item");
    return item;
  }
  throw new Error("Unknown item");
}

/**
 * The PLACEMENT WARMTH FLOOR (ruling-placement-idk.html Option F): the warm,
 * deterministic reveal line shown on a placement miss / "I haven't learned this
 * yet". NO live LLM call — the line is composed purely from the item (its stored
 * pre-verified `revealLine`, its own worked steps, an authored strategy line, or
 * the Tier-2 generic fallback). NEVER empty. `seed` (the probe-log index) drives
 * the Tier-2 rotation so it's stable across a reload of the same moment.
 */
function placementRevealLineFor(
  item: ServableItem,
  correctAnswer: string | null,
  seed: number,
): string {
  if (item.kind === "template") {
    // Re-derive the deterministic item for its own operands / worked steps — the
    // ServableItem prompt carries workedSteps but not the strategy operands.
    const gen = generateItem(item.ref.skillKey, item.ref.seed, item.ref.form);
    return buildPlacementRevealLine({
      kind: "template",
      correctAnswer,
      workedSteps: gen?.workedSteps,
      ...(gen?.stem ? { stem: gen.stem } : {}),
      ...(gen?.variant ? { variant: gen.variant } : {}),
      ...(gen?.form ? { form: gen.form } : {}),
      seed,
    }).text;
  }
  if (item.kind === "stored") {
    return buildPlacementRevealLine({
      kind: "stored",
      correctAnswer,
      storedRevealLine: item.revealLine ?? null,
      workedSteps: item.prompt.workedSteps,
      seed,
    }).text;
  }
  return buildPlacementRevealLine({ kind: "manipulative", correctAnswer, seed }).text;
}

/**
 * Teach-as-action reveal window (#900). A scholar EARNS the `teachingStep`
 * reveal — worked steps + answer — by tapping "I haven't learned this yet",
 * which records a `dont_know` MISS in `practiceAttempts` for THIS item. The
 * reveal (and the post-reveal scaffold-force in `submitAnswer`) is honored only
 * for a window after that honest miss, not indefinitely: a stale don't-know from
 * an hour ago must not keep gifting the answer / clean mastery on later attempts
 * of the same item.
 */
const TEACHING_REVEAL_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/**
 * True iff the scholar recorded an honest "I haven't learned this yet"
 * (`explanationReason === "dont_know"`) on THIS item within
 * `TEACHING_REVEAL_WINDOW_MS` of `now` — the durable, per-(scholar, item)
 * "the reveal was earned" signal behind the teach-as-action fix (#900). Reads
 * the `by_scholar_item_createdAt` index, so it works for TEMPLATE items too
 * (which carry no stored `practiceItems` id). Read-only; a query may call it
 * (reading `Date.now()` for the recency compare is not a side effect).
 */
async function hasRecentDontKnow(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  itemId: string,
  now: number,
): Promise<boolean> {
  const since = now - TEACHING_REVEAL_WINDOW_MS;
  const rows = await ctx.db
    .query("practiceAttempts")
    .withIndex("by_scholar_item_createdAt", (q) =>
      q.eq("scholarId", scholarId).eq("itemId", itemId).gte("createdAt", since),
    )
    .collect();
  return rows.some((r) => r.explanationReason === "dont_know");
}

async function recentHintReveal(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  itemId: string,
  now: number,
) {
  return await ctx.db
    .query("practiceHintReveals")
    .withIndex("by_scholar_item_createdAt", (q) =>
      q
        .eq("scholarId", scholarId)
        .eq("itemId", itemId)
        .gte("createdAt", now - TEACHING_REVEAL_WINDOW_MS),
    )
    .order("desc")
    .first();
}

async function latestHintReveal(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  itemId: string,
) {
  return await ctx.db
    .query("practiceHintReveals")
    .withIndex("by_scholar_item_createdAt", (q) =>
      q.eq("scholarId", scholarId).eq("itemId", itemId),
    )
    .order("desc")
    .first();
}

type ServedHintStep = {
  rung: HintLadderRung | null;
  hasMore: boolean;
  stepCount: number;
};

async function serveHintStepCore(
  ctx: MutationCtx,
  args: {
    scholarId: Id<"users">;
    itemId: string;
    workedSteps: Parameters<typeof hintLadderStepCount>[0];
    stepIndex?: number;
  },
): Promise<ServedHintStep> {
  let workedSteps = args.workedSteps;
  if (hintLadderStepCount(workedSteps) === 0) {
    const generated = await ctx.db
      .query("practicePadHints")
      .withIndex("by_scholar_item_createdAt", (q) =>
        q.eq("scholarId", args.scholarId).eq("itemId", args.itemId),
      )
      .order("desc")
      .first();
    workedSteps = generated?.workedSteps;
  }
  const stepCount = hintLadderStepCount(workedSteps);
  if (stepCount === 0) {
    return { rung: null, hasMore: false, stepCount: 0 };
  }

  const now = Date.now();
  const recent = await recentHintReveal(
    ctx,
    args.scholarId,
    args.itemId,
    now,
  );
  const latest =
    recent ?? (await latestHintReveal(ctx, args.scholarId, args.itemId));
  const maxAllowed = latest ? latest.maxStepServed + 1 : 0;
  const stepIndex = args.stepIndex ?? maxAllowed;
  if (
    !Number.isInteger(stepIndex) ||
    stepIndex < 0 ||
    stepIndex > maxAllowed
  ) {
    throw new Error("Hint steps must be opened in order.");
  }

  const rung = hintLadderRungAt(workedSteps, stepIndex);
  if (!rung) {
    return { rung: null, hasMore: false, stepCount };
  }

  if (!recent) {
    await ctx.db.insert("practiceHintReveals", {
      scholarId: args.scholarId,
      itemId: args.itemId,
      maxStepServed: stepIndex,
      createdAt: now,
    });
  } else if (stepIndex > recent.maxStepServed) {
    await ctx.db.patch(recent._id, { maxStepServed: stepIndex });
  }

  return {
    rung,
    hasMore: stepIndex + 1 < stepCount,
    stepCount,
  };
}

/**
 * Atomically serve one pre-answer intermediate worked step and stamp the
 * durable assisted marker. This is a mutation, rather than a query, because the
 * marker must be written server-side in the same operation that releases the
 * rung. The final worked step and item answer are absent from the return shape.
 */
export const serveHintStep = authedMutation({
  args: {
    scholarId: v.id("users"),
    itemId: v.string(),
    stepIndex: v.number(),
  },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const item = await resolveServableItem(
      ctx,
      args.itemId,
      WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    );
    return serveHintStepCore(ctx, {
      scholarId: args.scholarId,
      itemId: args.itemId,
      workedSteps: item.prompt.workedSteps,
      stepIndex: args.stepIndex,
    });
  },
});

export const padHintContext = internalQuery({
  args: { itemId: v.string() },
  handler: async (ctx, args) => {
    const item = await resolveServableItem(
      ctx,
      args.itemId,
      WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    );
    const grade = gradeSubmission(
      item,
      { kind: "dontKnow" },
      PLACEMENT_POLICY,
    );
    // The hint verifier guards against leaking the bare mathematical result.
    // A unit belongs in the scholar-facing reveal, but including it here would
    // let a nudge state the same number without the unit and evade that guard.
    const answerCanonical =
      grade.isManipulative || !grade.correctAnswer
        ? null
        : grade.correctAnswer;
    return {
      stem: item.prompt.stem,
      answerType: item.prompt.answerType,
      answerCanonical,
      hasDeterministicSteps:
        hintLadderStepCount(item.prompt.workedSteps) > 0,
    };
  },
});

/**
 * The teaching moment for the "I haven't learned this yet" button — the read
 * side of teach-as-action. A young scholar dismisses instructional prose without
 * reading it, so instead of streaming a worked explanation we hand back ONE
 * interactive faded step: reveal every worked step EXCEPT the final,
 * answer-producing one, which the scholar finishes. Doing the step IS the reading.
 *
 * `steps` is a single-blank fade (level 1: every step revealed but the last)
 * whenever the item carries ≥2 worked steps — a stored word problem with authored
 * steps OR a TEMPLATE drill whose family emits deterministic steps
 * (convex/lib/practice/workedStepGen.ts). Otherwise it's null and the surface
 * degrades to reveal-only (show `answer`) — a template family with no steps, a
 * manipulative, a one-step item, etc. `answer` is the value the client checks the
 * one blank against and/or reveals; null only for a manipulative (no answer string).
 *
 * `hint` is the TIER-2 rung of the ladder a stuck scholar walks down: the SAME
 * move the blanked step performs, set up with its operands but left unevaluated
 * ("Add the partial quotients: 100 + 30 + 6 = ?"). Tier 1 is the blank itself,
 * which NAMES the move; tier 3 is a person (the Socratic handoff). It is DERIVED
 * from the blanked step's own text (`deriveStepHint`), so it can never drift
 * from the step it hints at and can never contain the answer; an item may
 * override with an authored `hintText`. null when the item has no honest
 * intermediate rung — the client then escalates straight to tier 3.
 *
 * The answer is echoed ONLY here, in the post-measurement teaching moment: a
 * scholar already reaches this exact reveal by tapping "I haven't learned this
 * yet" (recorded as a miss), so re-deriving it from a self-owned itemId leaks
 * nothing new. Read-only — it records nothing, so the step attempt can never
 * move mastery or placement scoring.
 */
export const teachingStep = authedQuery({
  args: { scholarId: v.id("users"), itemId: v.string() },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const item = await resolveServableItem(ctx, args.itemId, WHOLE_NUMBER_ARITHMETIC_DOMAIN);
    const answerType = item.prompt.answerType;

    // #900 (teach-as-action mastery leak): reveal the worked steps + answer ONLY
    // when the scholar genuinely earned it by tapping "I haven't learned this
    // yet" for THIS item (a durable `dont_know` MISS in practiceAttempts).
    // Without that signal, hand back nothing — otherwise a scholar could read
    // this reveal from a self-owned itemId (TEMPLATE items included, which the
    // serve path never scaffolds) and submit it for clean mastery. This is a
    // query, so it only READS Date.now() (no side effect) for the recency check.
    if (!(await hasRecentDontKnow(ctx, args.scholarId, args.itemId, Date.now()))) {
      return {
        steps: null as ReturnType<typeof applyFade> | null,
        answer: null as string | null,
        answerType,
        hint: null as string | null,
      };
    }

    // The reveal string for this item (server truth), or undefined for a
    // manipulative (no answer to show). Reused from the shared grade dispatcher.
    const answer = gradeSubmission(item, { kind: "dontKnow" }, PLACEMENT_POLICY).revealedAnswer ?? null;

    // A single-blank teaching step needs ≥2 worked steps. Both a stored item's
    // authored steps AND a template family's deterministically-generated steps
    // live on `item.prompt.workedSteps` (buildStoredServable / buildTemplateServable);
    // a manipulative or a step-less template resolves to none. Force fade level 1
    // — the last (answer-producing) step faded, every earlier step revealed — a
    // completion problem; a faded step's real text is never in the FadeResult.
    let steps = null as ReturnType<typeof applyFade> | null;
    let hint = null as string | null;
    const workedSteps = item.prompt.workedSteps;
    if (workedSteps && workedSteps.length >= 2) {
      const fade = applyFade(workedSteps, 1);
      if (fade.revealed.length > 0) {
        steps = fade;
        // Tier 2 for the ONE blanked step (the last). An authored `hintText`
        // wins; otherwise derive it from that step's own text. A hint identical
        // to the blank is no rung at all — drop it so the client escalates.
        const blanked = workedSteps[workedSteps.length - 1];
        const derived =
          blanked.hintText ?? (answer ? deriveStepHint(blanked.text, answer) : undefined);
        const blankText = fade.faded[fade.faded.length - 1]?.blankText;
        hint = derived && derived !== blankText ? derived : null;
      }
    }
    return { steps, answer, answerType, hint };
  },
});

/**
 * Record HOW FAR down the teaching-moment hint ladder a don't-know went —
 * "solved" (finished the blanked step unaided), "hint" (finished it after the
 * tier-2 setup), or "stuck" (got it wrong, or escalated to the Socratic
 * handoff). The teaching moment is otherwise silent, so without this a teacher
 * sees only "didn't know it" and never WHICH RUNG was missing.
 *
 * Patches the scholar's EXISTING `dont_know` attempt row rather than writing a
 * new one: the outcome is a property of that honest miss, not a second attempt.
 * So it creates no extra `practiceAttempts` row, is invisible to the scheduler,
 * and cannot touch mastery or placement — the teaching moment stays purely
 * instructional (the whole reason it's client-graded).
 *
 * Monotone: the ladder only ever deepens (solved → hint → stuck), so an
 * out-of-order or duplicate call from either frontend can't walk it back.
 * Idempotent and best-effort — a missing row (an expired window, a template
 * item served before this shipped) is a silent no-op, never an error, because
 * a bookkeeping failure must never break a child's teaching moment.
 */
const TEACH_OUTCOME_DEPTH = { solved: 0, hint: 1, stuck: 2 } as const;

export const recordTeachingOutcome = authedMutation({
  args: {
    scholarId: v.id("users"),
    itemId: v.string(),
    outcome: v.union(v.literal("solved"), v.literal("hint"), v.literal("stuck")),
  },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    // Mirror practiceSession's isSelf guard: a teacher previewing / rehearsing an
    // activity must never deepen a REAL scholar's analytics row. Only the
    // scholar's OWN session records which rung of the teaching ladder was needed.
    const isSelf = !isTeacher && ctx.user._id === args.scholarId;
    if (!isSelf) return { recorded: false };
    const since = Date.now() - TEACHING_REVEAL_WINDOW_MS;
    const rows = await ctx.db
      .query("practiceAttempts")
      .withIndex("by_scholar_item_createdAt", (q) =>
        q.eq("scholarId", args.scholarId).eq("itemId", args.itemId).gte("createdAt", since),
      )
      .collect();
    const row = rows.filter((r) => r.explanationReason === "dont_know").pop();
    if (!row) return { recorded: false };

    const prior = row.teachOutcome;
    if (prior && TEACH_OUTCOME_DEPTH[prior] >= TEACH_OUTCOME_DEPTH[args.outcome]) {
      return { recorded: false };
    }
    await ctx.db.patch(row._id, { teachOutcome: args.outcome });
    return { recorded: true };
  },
});

/**
 * Grade + record one submitted answer. The correct answer is re-derived
 * server-side from the item id (anti-cheat — it was never sent to the client),
 * the attempt is recorded through the scheduler, and the result (with the
 * correct answer, now fine to reveal) is returned for immediate feedback.
 *
 * Routed through the unified serve/grade contract (`lib/practice/servable.ts`):
 * resolve the id to a `ServableItem`, grade the `Submission` against it under
 * `PRACTICE_POLICY`, then apply the policy-driven side effects. Behavior-
 * preserving — `PRACTICE_POLICY` encodes exactly this surface's prior behavior.
 */
type SubmitAnswerResult = {
  attemptId?: Id<"practiceAttempts">;
  correct: boolean;
  correctAnswer?: string;
  /** Set only when the VALUE was right and the required measurement unit was
   *  absent ("missing") or not the one asked for ("wrong") — the "so close"
   *  signal a unit-bearing item earns. The attempt is still incorrect and is
   *  recorded exactly like any other miss. */
  unitOutcome?: "missing" | "wrong";
  skillKey: string;
  skillLabel: string;
  repetition: number;
  proficiency: "not_started" | "practicing" | "fluent" | "overlearned";
  accelerated: boolean;
  dontKnow?: boolean;
  turnedFluent: boolean;
  comesBackAt?: number;
  backOff?: {
    missStreak: number;
    reattached?: boolean;
    recoverySkillKey?: string;
    recoveryDomain?: string;
  };
  breakerRecovery?: {
    version: 2;
    triggerAttemptId: Id<"practiceAttempts">;
    triggerNodeKey: string;
    domain: string;
    initialRepair?: ServedHintStep;
  };
  /** True only when this submission atomically persisted a correct, unassisted
   *  fresh same-node result on the breaker trigger attempt. */
  breakerRecoveryVerified?: boolean;
  dispatchCompleted: DispatchCompleted[];
};

function submissionFingerprint(args: {
  itemId: string;
  answer: string;
  record?: boolean;
  replay?: boolean;
  prepareBreakerRepair?: boolean;
  suppressBreaker?: boolean;
  dontKnow?: boolean;
  breakerTriggerAttemptId?: Id<"practiceAttempts">;
  breakerEasyTriggerAttemptId?: Id<"practiceAttempts">;
  predictedConfidence?: ConfidenceLevel;
}, version: 1 | 2): string {
  // Timings are telemetry, not authority: an ambiguous transport retry can
  // measure them differently while still being the same scholar submission.
  const fields = {
    itemId: args.itemId,
    answer: args.answer,
    record: args.record !== false,
    ...(version === 2 ? { replay: args.replay === true } : {}),
    prepareBreakerRepair: args.prepareBreakerRepair === true,
    suppressBreaker: args.suppressBreaker === true,
    dontKnow: args.dontKnow === true,
    breakerTriggerAttemptId: args.breakerTriggerAttemptId ?? null,
    breakerEasyTriggerAttemptId: args.breakerEasyTriggerAttemptId ?? null,
    predictedConfidence: args.predictedConfidence ?? null,
  };
  return `${version === 2 ? "v2:" : ""}${JSON.stringify(fields)}`;
}

function legacySubmissionFingerprint(fingerprint: string): string {
  if (!fingerprint.startsWith("v2:")) return fingerprint;
  const fields = JSON.parse(fingerprint.slice(3)) as Record<string, unknown>;
  delete fields.replay;
  return JSON.stringify(fields);
}

function submissionResultFromReceipt(receipt: string): SubmitAnswerResult {
  // This data is only written from the result returned by this mutation. Its
  // declared `returns` validator validates the same object before commit.
  return JSON.parse(receipt) as SubmitAnswerResult;
}

/**
 * The REHEARSE answer oracle — the read side of the Content-view "Rehearse" on a
 * skill's Questions pool. A teacher previewing a skill's questions AS A SCHOLAR
 * needs to see each item graded, but must NOT accrue any practice record under
 * their staff account (the defect this closes: the old Rehearse link ran the
 * ordinary scholar session, whose `submitAnswer` minted real `practiceMastery` /
 * spaced-repetition rows for the signed-in teacher).
 *
 * This resolves the item to its full `ServableItem` (verifier included) and hands
 * it back so the CLIENT can grade it with the SHARED `gradeSubmission` under
 * `REHEARSE_POLICY` — the exact server grader, so a rehearse verdict is identical
 * to a real one, with every side-effect knob off. It is a QUERY, so it is
 * structurally incapable of a write, and it is teacher-gated (`teacherQuery`),
 * because it returns the unredacted answer — deliberately breaking the
 * scholar-facing anti-cheat invariant for staff only, exactly as `teachingStep`
 * does within its earned window. No scholar ever reaches this.
 *
 * A DIALOGUE stretch item is REFUSED here exactly as `submitAnswer` refuses it:
 * it has no typed answer (it's judged by the rubric on /practice-dialogue), and
 * `buildStoredServable` casts the runtime `"dialogue"` to an `AnswerType` so
 * `gradeSubmission` would silently treat it as an expression. Failing loud keeps
 * the parity claim honest — the grader never returns a verdict it can't stand by.
 */
export const rehearseGradeItem = teacherQuery({
  args: { itemId: v.string(), domain: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const item = await resolveServableItem(
      ctx,
      args.itemId,
      args.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    );
    if (item.prompt.answerType === "dialogue") {
      throw new Error("This one is a conversation — it gets checked from the dialogue, not the pad.");
    }
    return item;
  },
});

/**
 * Grade the one application attached to a durable story-thread session. The
 * session seed is the authority for the edge and the eligible item: callers
 * cannot turn this feedback-only path into a grade oracle for another item.
 */
export const submitStoryThreadApplication = authedMutation({
  args: {
    sessionId: v.id("sessions"),
    itemId: v.string(),
    answer: v.string(),
    dontKnow: v.optional(v.boolean()),
  },
  returns: v.object({
    correct: v.boolean(),
    correctAnswer: v.optional(v.string()),
    unitOutcome: v.optional(v.union(v.literal("missing"), v.literal("wrong"))),
    skillKey: v.string(),
    skillLabel: v.string(),
    repetition: v.number(),
    proficiency: v.union(
      v.literal("not_started"),
      v.literal("practicing"),
      v.literal("fluent"),
      v.literal("overlearned"),
    ),
    accelerated: v.boolean(),
    dontKnow: v.optional(v.boolean()),
    turnedFluent: v.boolean(),
    comesBackAt: v.optional(v.number()),
    breakerRecovery: v.optional(
      v.object({
        version: v.literal(2),
        triggerAttemptId: v.id("practiceAttempts"),
        triggerNodeKey: v.string(),
        domain: v.string(),
      }),
    ),
    backOff: v.optional(
      v.object({
        missStreak: v.number(),
        reattached: v.optional(v.boolean()),
        // Retained for deployed native clients. Current clients use only the
        // server-owned breakerRecovery trigger to serve the easy finish.
        recoverySkillKey: v.optional(v.string()),
        recoveryDomain: v.optional(v.string()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.userId !== ctx.user._id) {
      throw new Error("Story thread session not found");
    }
    if (!session.seedId) throw new Error("Session is not a story thread");

    const seed = await ctx.db.get(session.seedId);
    if (
      !seed ||
      seed.scholarId !== session.userId ||
      seed.origin !== "story" ||
      !seed.storyFromKey ||
      !seed.storyToKey
    ) {
      throw new Error("Session is not a story thread");
    }

    const eligible = await eligibleStoryApplication(
      ctx,
      session.userId,
      seed.storyFromKey,
      seed.storyToKey,
    );
    const item = eligible?.items.find(
      (candidate) => candidate.itemId === args.itemId,
    );
    if (!item || item.kind === "template") {
      throw new Error("That application is not available for this story thread");
    }
    if (item.prompt.answerType === "dialogue") {
      throw new Error(
        "This one is a conversation — it gets checked from the dialogue, not the pad.",
      );
    }

    const submission: Submission = args.dontKnow
      ? { kind: "dontKnow" }
      : item.kind === "manipulative"
        ? { kind: "manipulativeState", stateJson: args.answer }
        : { kind: "typed", raw: args.answer };
    const grade = gradeSubmission(item, submission, STORY_THREAD_POLICY);

    if (grade.correct && !grade.isDontKnow) {
      const storedRow = await ctx.db.get(item.ref);
      if (!storedRow) throw new Error("Story application item not found");
      await maybeWriteOptionalDepthObservation(
        ctx,
        session.userId,
        item,
        storedRow,
      );
    }

    const mastery = await ctx.db
      .query("practiceMastery")
      .withIndex("by_scholar_skill", (q) =>
        q.eq("scholarId", session.userId).eq("skillKey", item.skillKey),
      )
      .first();
    const repetition = mastery?.repetition ?? 0;
    return {
      correct: grade.correct,
      ...(grade.revealedAnswer !== undefined
        ? { correctAnswer: grade.revealedAnswer }
        : {}),
      ...(grade.unitOutcome ? { unitOutcome: grade.unitOutcome } : {}),
      skillKey: item.skillKey,
      skillLabel: item.skillLabel,
      repetition,
      proficiency: proficiencyFromReps(repetition),
      accelerated: false,
      ...(grade.isDontKnow ? { dontKnow: true } : {}),
      turnedFluent: false,
    };
  },
});

export const submitAnswer = authedMutation({
  args: {
    scholarId: v.id("users"),
    itemId: v.string(),
    answer: v.string(),
    // `false` = grade only, don't touch mastery. Used for a RETRY of the same
    // item during the Socratic-handoff loop (⑫): the first attempt already
    // moved the scheduler, so retries must not double-penalize it.
    record: v.optional(v.boolean()),
    // One logical scholar answer. Optional to preserve installed clients while
    // giving new callers an idempotency fence across retries and offline replay.
    clientEventId: v.optional(v.string()),
    // New clients opt into replay-aware fingerprint v2. Optional so an old
    // cached tab and installed native build retain v1 rolling compatibility.
    submissionFingerprintVersion: v.optional(v.literal(2)),
    // Set by the offline-queue REPLAY path (PracticeSession.tsx): an old offline
    // burst is being flushed after reconnect. It is historical evidence, so its
    // attempt/mastery record persists but the breaker is not evaluated at all:
    // no back-off, lifecycle, repair, alert, or active episode.
    //
    // This is a client-asserted submission-context hint, exactly like `record`
    // above — the server can't intrinsically tell a replay from a live submit,
    // since the offline queue is a client construct. A tampering client could
    // pass `replay: true` to suppress its own stuck alert, but the worst case is
    // a MISSED best-effort nudge to a teacher who sees the underlying practice
    // data directly anyway — not a data-integrity or access issue. Accepted for
    // this fire-and-forget signal; revisit if abuse ever matters.
    replay: v.optional(v.boolean()),
    // New clients ask the threshold-crossing mutation to include the first
    // repair rung. Optional and false-by-default so an older native binary that
    // cannot render the payload keeps using its existing follow-up mutation.
    prepareBreakerRepair: v.optional(v.boolean()),
    // Quick Facts intentionally never opens the general practice breaker. This
    // client context keeps the server from creating a recovery lifecycle and
    // staff alert for a panel the scholar was never shown.
    suppressBreaker: v.optional(v.boolean()),
    // Silent latency instrument (B5, raise-the-ceiling plan §5): stem render
    // → first keystroke (the retrieval read) and render → submit. Both
    // optional — omitted whenever the client couldn't measure a reading (an
    // offline-queue replay, a voice-dictation path, …). `firstKeyMs` is clamped
    // before it can feed the v1 baseline; rejected observations are retained as
    // censored telemetry. `elapsedMs` is persisted alongside it but never feeds
    // mastery, scheduling, placement, serving, or fluency.
    firstKeyMs: v.optional(v.number()),
    elapsedMs: v.optional(v.number()),
    // "I haven't learned this yet" (placement v2, drill parity). An honest
    // don't-know is recorded as a MISS for spaced-repetition (it IS a miss — the
    // scholar can't do it yet), but it's flagged distinctly: NO error-pattern
    // classification (a blank isn't a buggy algorithm) and — like every drill
    // miss — the answer is NOT revealed (drills keep withholding). Supportive
    // copy lives on the surface.
    dontKnow: v.optional(v.boolean()),
    breakerTriggerAttemptId: v.optional(v.id("practiceAttempts")),
    breakerEasyTriggerAttemptId: v.optional(v.id("practiceAttempts")),
    // Predict-then-Check calibration (judgment-of-learning): the kid's OPTIONAL
    // pre-answer confidence pick. When present on a RECORDED attempt we log one
    // practicePredictions row alongside the attempt — a metacognitive signal,
    // deliberately separate from mastery (no SR/mastery behavior changes). Absent
    // whenever the chip was skipped (the mechanic is optional). Retries
    // (record:false) never carry it — a prediction is a first-look affordance.
    predictedConfidence: v.optional(
      v.union(v.literal("sure"), v.literal("think_so"), v.literal("not_sure")),
    ),
  },
  returns: v.object({
    correct: v.boolean(),
    attemptId: v.optional(v.id("practiceAttempts")),
    correctAnswer: v.optional(v.string()),
    unitOutcome: v.optional(v.union(v.literal("missing"), v.literal("wrong"))),
    skillKey: v.string(),
    skillLabel: v.string(),
    repetition: v.number(),
    proficiency: v.union(
      v.literal("not_started"),
      v.literal("practicing"),
      v.literal("fluent"),
      v.literal("overlearned"),
    ),
    accelerated: v.boolean(),
    dontKnow: v.optional(v.boolean()),
    turnedFluent: v.boolean(),
    comesBackAt: v.optional(v.number()),
    breakerRecovery: v.optional(
      v.object({
        version: v.literal(2),
        triggerAttemptId: v.id("practiceAttempts"),
        triggerNodeKey: v.string(),
        domain: v.string(),
        initialRepair: v.optional(
          v.object({
            rung: v.union(
              v.null(),
              v.object({
                kind: v.literal("completion"),
                stepIndex: v.number(),
                prompt: v.string(),
                expected: v.string(),
                answerType: v.union(
                  v.literal("integer"),
                  v.literal("decimal"),
                  v.literal("fraction"),
                  v.literal("expression"),
                ),
              }),
              v.object({
                kind: v.literal("reveal"),
                stepIndex: v.number(),
                text: v.string(),
              }),
            ),
            hasMore: v.boolean(),
            stepCount: v.number(),
          }),
        ),
      }),
    ),
    breakerRecoveryVerified: v.optional(v.boolean()),
    backOff: v.optional(
      v.object({
        missStreak: v.number(),
        reattached: v.optional(v.boolean()),
        // Retained for deployed native clients. Current clients use only the
        // server-owned breakerRecovery trigger to serve the easy finish.
        recoverySkillKey: v.optional(v.string()),
        recoveryDomain: v.optional(v.string()),
      }),
    ),
    dispatchCompleted: v.array(
      v.object({
        assignmentId: v.id("assignments"),
        teacherName: v.string(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const clientEventId = args.clientEventId?.trim();
    if (args.clientEventId !== undefined && !clientEventId) {
      throw new Error("Practice submission id cannot be empty");
    }
    const requestFingerprint = clientEventId
      ? submissionFingerprint(
          args,
          args.submissionFingerprintVersion === 2 ? 2 : 1,
        )
      : undefined;
    if (clientEventId && requestFingerprint) {
      const existing = await ctx.db
        .query("practiceAttempts")
        .withIndex("by_scholar_client_event", (q) =>
          q.eq("scholarId", args.scholarId).eq("clientEventId", clientEventId),
        )
        .first();
      if (existing) {
        const compareReplay =
          existing.submissionFingerprint?.startsWith("v2:") === true &&
          args.submissionFingerprintVersion === 2;
        const existingFingerprint = compareReplay
          ? existing.submissionFingerprint
          : existing.submissionFingerprint
            ? legacySubmissionFingerprint(existing.submissionFingerprint)
            : undefined;
        const comparableRequestFingerprint = compareReplay
          ? submissionFingerprint(args, 2)
          : submissionFingerprint(args, 1);
        if (existingFingerprint !== comparableRequestFingerprint) {
          throw new Error("Practice submission id was reused for a different answer");
        }
        if (!existing.submissionResult) {
          throw new Error("Practice submission cannot be replayed because its receipt is unavailable");
        }
        return submissionResultFromReceipt(existing.submissionResult);
      }
    }

    // ── Resolve → grade → policy-driven side effects (unified serve/grade
    // contract, lib/practice/servable.ts). `PRACTICE_POLICY` encodes exactly
    // this surface's prior behavior, so the flow is behavior-preserving. ──
    const item = await resolveServableItem(ctx, args.itemId, WHOLE_NUMBER_ARITHMETIC_DOMAIN);
    if (args.breakerTriggerAttemptId && args.breakerEasyTriggerAttemptId) {
      throw new Error("Breaker submission cannot be both fresh and easy");
    }
    let breakerFreshTrigger: Doc<"practiceAttempts"> | undefined;
    let breakerEasyTrigger: Doc<"practiceAttempts"> | undefined;
    if (args.breakerTriggerAttemptId) {
      const trigger = await ctx.db.get(args.breakerTriggerAttemptId);
      const lifecycle = trigger?.breakerLifecycle;
      const supportAt = Math.max(
        lifecycle?.repairCompletedAt ?? Number.NEGATIVE_INFINITY,
        lifecycle?.coachEscalatedAt ?? Number.NEGATIVE_INFINITY,
      );
      if (
        !trigger ||
        trigger.scholarId !== args.scholarId ||
        !lifecycle ||
        !isBreakerCountedAttempt(trigger) ||
        lifecycle.easyExitedAt !== undefined ||
        lifecycle.stoppedAt !== undefined ||
        lifecycle.freshResult !== undefined ||
        lifecycle.freshItemId !== args.itemId ||
        supportAt === Number.NEGATIVE_INFINITY ||
        item.skillKey !== lifecycle.triggerNodeKey ||
        (trigger.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN) !== item.domain ||
        !trigger.itemId ||
        canonicalItemIdentity(trigger.itemId) === canonicalItemIdentity(args.itemId)
      ) {
        throw new Error("Breaker recovery context is invalid");
      }
      breakerFreshTrigger = trigger;
    }
    if (args.breakerEasyTriggerAttemptId) {
      const trigger = await ctx.db.get(args.breakerEasyTriggerAttemptId);
      const lifecycle = trigger?.breakerLifecycle;
      if (
        !trigger ||
        trigger.scholarId !== args.scholarId ||
        !lifecycle ||
        !isBreakerCountedAttempt(trigger) ||
        lifecycle.stoppedAt !== undefined ||
        lifecycle.freshResult?.correct === true ||
        lifecycle.easyItemId !== args.itemId ||
        (lifecycle.easyDomain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN) !== item.domain ||
        (trigger.breaker?.recovery !== undefined &&
          trigger.breaker.recovery !== "none") ||
        (trigger.itemId &&
          canonicalItemIdentity(trigger.itemId) ===
            canonicalItemIdentity(args.itemId))
      ) {
        throw new Error("Breaker easy-finish context is invalid");
      }
      breakerEasyTrigger = trigger;
    }
    const verifiedBreakerRecovery = breakerFreshTrigger !== undefined;

    // A DIALOGUE stretch item has no typed answer — it's graded by the rubric
    // judge on /practice-dialogue, never here (fail loud, not wrong).
    if (item.prompt.answerType === "dialogue") {
      throw new Error("This one is a conversation — it gets checked from the dialogue, not the pad.");
    }

    // Map the wire args onto a normalized `Submission`. An explicit "I haven't
    // learned this yet" is a dontKnow (always a miss); a manipulative item's
    // opaque runtime state is `manipulativeState`; everything else is a raw
    // typed answer (parsed per the item's answer type at grade time).
    const submission: Submission = args.dontKnow
      ? { kind: "dontKnow" }
      : item.kind === "manipulative"
        ? { kind: "manipulativeState", stateJson: args.answer }
        : { kind: "typed", raw: args.answer };

    const grade = gradeSubmission(item, submission, PRACTICE_POLICY);
    const elapsedMs = validElapsedMs(args.elapsedMs);

    // Store the teacher-visible answer, not a multiple-choice button's wire index.
    const answerText: string | undefined = args.dontKnow
      ? undefined
      : attemptAnswerText(item, args.answer);

    // Scaffold-aware grading: re-derive the fade level server-side from the
    // scholar's CURRENT mastery for this skill (identical to serve time —
    // scaffoldLevelFor → clampFadeLevel to the item's step count). If any step
    // is still revealed it was a scaffolded completion, not a bare problem, so
    // the correct attempt is assisted (recordAttemptCore records an INFERRED
    // source, so it can't go green). Never trust a client-sent level.
    //
    // Serving has a SECOND reason to reveal steps: a COLD node (missed, with no
    // teaching since) comes back pinned at fade level 1 whatever mastery says,
    // so grading has to ask the same question or a 3-of-4-steps-revealed
    // completion mints a bare demonstration. Recomputed here from the same
    // helper serving used, and BEFORE this attempt is recorded — i.e. on the
    // pre-attempt state serving read. Only worth asking when the item actually
    // has ≥2 steps: with fewer, level 1 reveals nothing and the answer is
    // identical either way.
    //
    // The recompute can diverge from what the scholar saw: teaching that lands
    // between serve and submit makes this say not-cold while revealed steps were
    // on screen, so one assisted solve could grade bare. Accepted — the window
    // is seconds long, it errs once and in the scholar's favor, and the
    // alternative (persisting the serve-time decision, the way `serveHintStep`
    // writes `practiceHintReveals`) needs a write from a query.
    const workedStepCount = item.prompt.workedSteps?.length ?? 0;
    let forceTeaching = false;
    if (workedStepCount >= 2 && !verifiedBreakerRecovery) {
      // The node's own domain/strand (the strand instruction key needs both);
      // `item.domain` falls back to the resolver's default for a template.
      const node = await ctx.db
        .query("knowledgeNodes")
        .withIndex("by_nodeKey", (q) => q.eq("nodeKey", item.skillKey))
        .first();
      const cold = await coldFailedSkillKeySet(
        ctx,
        args.scholarId,
        [
          {
            skillKey: item.skillKey,
            domain: node?.domain ?? item.domain,
            ...(node?.strand ? { strand: node.strand } : {}),
          },
        ],
        Date.now(),
      );
      forceTeaching = cold.has(item.skillKey);
    }

    let scaffolded = false;
    if (
      !verifiedBreakerRecovery &&
      item.kind === "stored" &&
      item.prompt.workedSteps &&
      item.prompt.workedSteps.length > 0
    ) {
      const masteryRow = await ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar_skill", (q) =>
          q.eq("scholarId", args.scholarId).eq("skillKey", item.skillKey),
        )
        .first();
      const clamped = clampFadeLevel(
        forceTeaching ? 1 : scaffoldLevelFor(masteryRow ?? undefined),
        item.prompt.workedSteps.length,
      );
      const revealedCount = item.prompt.workedSteps.length - clamped;
      scaffolded = revealedCount > 0;
    } else if (!verifiedBreakerRecovery && forceTeaching && item.kind === "template") {
      // Templates carry deterministic steps that serving normally drops; the
      // cold post-pass in serveItems attaches them at level 1, so ≥2 steps means
      // the scholar finished a completion problem here too.
      scaffolded = true;
    }

    // ── Stretch-tier grading (practiceItems.tier — see the schema comment).
    // Resolved server-side from the stored row; never trusted from the client.
    // Resolved BEFORE the grade-only retry branch: a stretch solve earns depth
    // evidence on ANY unassisted attempt, retries included (below).
    const storedRow = item.kind === "template" ? null : await ctx.db.get(item.ref);
    const isStretch = storedRow?.tier === "stretch";

    // Grade-only retry (handoff loop): return the verdict without recording, so
    // the scheduler isn't penalized twice for one stuck item. Proficiency
    // reflects the already-recorded first attempt.
    if (args.record === false) {
      // A correct UNASSISTED retry of a stretch item still earns the depth
      // observation (the answer was never revealed — wrestling with it and then
      // cracking it IS the evidence). Mastery stays untouched (grade-only).
      // `scaffolded` here reflects only the stored-item fade guard; the hint
      // ladder\'s reveal marker is consulted separately so a hinted stretch
      // solve can never mint an "unassisted" depth row (unreachable today —
      // stretch items carry no workedSteps — but the guard should not rely on
      // that staying true).
      if (isStretch && grade.correct && !scaffolded && storedRow) {
        const hinted = await recentHintReveal(ctx, args.scholarId, args.itemId, Date.now());
        if (!hinted) {
          await maybeWriteOptionalDepthObservation(ctx, args.scholarId, item, storedRow);
        }
      }

      // Record the retry itself as a flagged, diagnostic-only attempt row: it
      // captures the submitted answer + outcome of THIS re-attempt so a stuck
      // item's later tries are no longer invisible. It deliberately does NOT run
      // recordAttemptCore (mastery/SR stay untouched — the whole point of
      // `record:false`), and carries `retry:true` with NO lane / predictedRetention
      // so the spiral-breaker miss-streak and the param-health calibration (both
      // lane-gated) skip it.
      const retryAttemptId = await ctx.db.insert("practiceAttempts", {
        scholarId: args.scholarId,
        nodeKey: item.skillKey,
        itemId: args.itemId,
        correct: grade.correct,
        ...(clientEventId ? { clientEventId } : {}),
        ...(requestFingerprint ? { submissionFingerprint: requestFingerprint } : {}),
        domain: item.domain,
        retry: true,
        breakerEligible: false,
        ...(answerText !== undefined ? { answerText } : {}),
        ...(!grade.correct
          ? {
              ...(sanitizeStemSnapshot(grade.stem) !== undefined
                ? { stemSnapshot: sanitizeStemSnapshot(grade.stem) }
                : {}),
              ...(grade.correctAnswer
                ? { expectedAnswer: sanitizePlacementAnswer(grade.correctAnswer) }
                : {}),
            }
          : {}),
        createdAt: Date.now(),
      });

      const existing = await ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar_skill", (q) =>
          q.eq("scholarId", args.scholarId).eq("skillKey", item.skillKey),
        )
        .first();
      const repetition = existing?.repetition ?? 0;
      // No `attemptId`: a grade-only retry inserts no attempt row, so there is
      // nothing for the client to report help against (and "I did this with help"
      // must never attach to a retry — the first attempt already moved the
      // scheduler).
      const result = {
        correct: grade.correct,
        correctAnswer: grade.revealedAnswer,
        ...(grade.unitOutcome ? { unitOutcome: grade.unitOutcome } : {}),
        skillKey: item.skillKey,
        skillLabel: item.skillLabel,
        repetition,
        proficiency: proficiencyFromReps(repetition),
        accelerated: false,
        // A grade-only retry never consolidates (the first attempt already moved
        // the scheduler) — keep the shape uniform with the recorded path.
        turnedFluent: false as boolean,
        comesBackAt: undefined as number | undefined,
        dispatchCompleted: [],
      } as SubmitAnswerResult;
      if (clientEventId) {
        await ctx.db.patch(retryAttemptId, { submissionResult: JSON.stringify(result) });
      }
      return result;
    }

    // A RECORDED correct attempt after either teaching reveal is assisted: the
    // post-dontKnow `teachingStep` uses the honest miss row, while the pre-answer
    // Hint ladder uses its server-written reveal marker. Both land the INFERRED
    // SCAFFOLDED_SOURCE in recordAttemptCore (bumps reps/access but can't go
    // green). This especially covers TEMPLATE items, which the stored-item
    // scaffold guard above never reaches. record:false retries
    // already returned above (they never move mastery), so this is the recorded
    // path only. Harmless on the dontKnow submit itself: its own miss row isn't
    // written yet (the FIRST don't-know sees no prior row), and `scaffolded`
    // only affects a CORRECT attempt's source — so the miss recording is
    // untouched.
    const revealNow = Date.now();
    if (
      !scaffolded &&
      ((await hasRecentDontKnow(ctx, args.scholarId, args.itemId, revealNow)) ||
        (await recentHintReveal(ctx, args.scholarId, args.itemId, revealNow)))
    ) {
      scaffolded = true;
    }

    const persistBreakerGrade = async (
      attemptId: Id<"practiceAttempts">,
    ): Promise<void> => {
      const completedAt = Date.now();
      if (breakerFreshTrigger?.breakerLifecycle) {
        const lifecycle = breakerFreshTrigger.breakerLifecycle;
        await ctx.db.patch(breakerFreshTrigger._id, {
          breakerLifecycle: {
            ...lifecycle,
            freshResult: {
              attemptId,
              itemId: args.itemId,
              correct: grade.correct,
              assisted: scaffolded || grade.isDontKnow,
              completedAt,
            },
          },
        });
        await ctx.scheduler.runAfter(
          grade.correct ? 0 : SPIRAL_GAP_MS,
          internal.practiceStuckAlert.postOutcome,
          { triggerAttemptId: breakerFreshTrigger._id },
        );
      }
      if (breakerEasyTrigger?.breakerLifecycle) {
        const lifecycle = breakerEasyTrigger.breakerLifecycle;
        const prior = breakerEasyTrigger.breaker;
        const recovery = grade.correct ? "won" : "missed";
        await ctx.db.patch(breakerEasyTrigger._id, {
          breakerLifecycle: {
            ...lifecycle,
            easyExitedAt: lifecycle.easyExitedAt ?? completedAt,
          },
          breaker: {
            streak: prior?.streak ?? SPIRAL_MISS_THRESHOLD,
            offer:
              prior?.offer ??
              (lifecycle.repairCompletedAt ||
              lifecycle.coachEscalatedAt ||
              lifecycle.freshResult
                ? "accepted"
                : "declined"),
            recovery:
              prior?.recovery && prior.recovery !== "none"
                ? prior.recovery
                : recovery,
          },
        });
        await ctx.scheduler.runAfter(
          0,
          internal.practiceStuckAlert.postOutcome,
          { triggerAttemptId: breakerEasyTrigger._id },
        );
      }
    };

    // A stretch MISS never touches the mastery row: no half-life lapse, no rep
    // reset, no upward negative evidence — missing here is the design target
    // (~60–70% first-try success), not a retention signal. The attempt is still
    // logged (lane "stretch") for telemetry, predictions still pair with the
    // outcome, and the Ashlock classifier still runs (teacher-only channel).
    if (isStretch && !grade.correct) {
      const existing = await ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar_skill", (q) =>
          q.eq("scholarId", args.scholarId).eq("skillKey", item.skillKey),
        )
        .first();
      const now = Date.now();
      const firstKeyMs = grade.shouldRecordLatency
        ? clampLatency(args.firstKeyMs)
        : undefined;
      const firstKeyMsCensored = grade.shouldRecordLatency
        ? censoredFirstKey(args.firstKeyMs)
        : undefined;
      const stretchAttemptId = await ctx.db.insert("practiceAttempts", {
        scholarId: args.scholarId,
        nodeKey: item.skillKey,
        itemId: args.itemId,
        correct: false,
        ...(clientEventId ? { clientEventId } : {}),
        ...(requestFingerprint ? { submissionFingerprint: requestFingerprint } : {}),
        ...(answerText !== undefined ? { answerText } : {}),
        ...(sanitizeStemSnapshot(grade.stem) !== undefined
          ? { stemSnapshot: sanitizeStemSnapshot(grade.stem) }
          : {}),
        ...(grade.correctAnswer
          ? { expectedAnswer: sanitizePlacementAnswer(grade.correctAnswer) }
          : {}),
        ...(firstKeyMs !== undefined ? { firstKeyMs } : {}),
        ...(firstKeyMsCensored !== undefined ? { firstKeyMsCensored } : {}),
        ...(elapsedMs !== undefined ? { elapsedMs } : {}),
        domain: item.domain,
        ...(existing?.strand ? { strand: existing.strand } : {}),
        lane: "stretch",
        breakerEligible:
          !isTeacher && args.replay !== true && args.suppressBreaker !== true,
        repetitionBefore: existing?.repetition ?? 0,
        source: existing?.source ?? "practice",
        ...(grade.explanationReason
          ? { explanationReason: grade.explanationReason, explanationRequestedAt: now }
          : {}),
        createdAt: now,
      });
      await persistBreakerGrade(stretchAttemptId);
      const dispatchCompleted = isTeacher
        ? []
        : await reconcileProblemSetDispatchCompletionsForResult(ctx, {
            scholarId: args.scholarId,
            skillKey: item.skillKey,
            now,
          });
      if (args.predictedConfidence) {
        await ctx.db.insert("practicePredictions", {
          scholarId: args.scholarId,
          skillKey: item.skillKey,
          itemId: item.ref as Id<"practiceItems">,
          confidence: confidenceValue(args.predictedConfidence as ConfidenceLevel),
          correct: false,
          source: "practice",
          createdAt: now,
        });
      }
      if (grade.shouldClassifyError) {
        const pattern = classifyError({
          skillKey: item.skillKey,
          stem: grade.stem,
          learnerAnswer: args.answer,
          correctAnswer: grade.correctAnswer,
        });
        if (pattern) {
          await ctx.db.insert("practiceErrorEvents", {
            scholarId: args.scholarId,
            nodeKey: item.skillKey,
            domain: item.domain,
            pattern,
            itemId: args.itemId,
            createdAt: now,
          });
        }
      }
      const repetition = existing?.repetition ?? 0;
      const result = {
        correct: false,
        correctAnswer: grade.revealedAnswer,
        ...(grade.unitOutcome ? { unitOutcome: grade.unitOutcome } : {}),
        skillKey: item.skillKey,
        skillLabel: item.skillLabel,
        repetition,
        proficiency: proficiencyFromReps(repetition),
        accelerated: false,
        dontKnow: grade.isDontKnow,
        turnedFluent: false as boolean,
        comesBackAt: undefined as number | undefined,
        ...(breakerFreshTrigger ? { breakerRecoveryVerified: false } : {}),
        dispatchCompleted,
      } as SubmitAnswerResult;
      if (clientEventId) {
        await ctx.db.patch(stretchAttemptId, { submissionResult: JSON.stringify(result) });
      }
      return result;
    }

    // Record the attempt through the scheduler (the practice policy records
    // mastery + attempt + latency). `recordAttemptCore`'s external contract is
    // unchanged; the policy drives the latency + explanation-reason inputs.
    const factKey =
      isFactFamilySkill(item.skillKey) && grade.variant
        ? factKeyFromOperands(
            grade.variant.a,
            grade.variant.op,
            grade.variant.b,
          )
        : null;
    const rec = await recordAttemptCore(
      ctx,
      args.scholarId,
      item.domain,
      item.skillKey,
      grade.correct,
      grade.shouldRecordLatency ? args.firstKeyMs : undefined,
      {
        itemId: args.itemId,
        ...(clientEventId ? { clientEventId } : {}),
        ...(requestFingerprint ? { submissionFingerprint: requestFingerprint } : {}),
        ...(elapsedMs !== undefined ? { elapsedMs } : {}),
        scaffolded,
        ...(factKey ? { factKey } : {}),
        ...(answerText !== undefined ? { answerText } : {}),
        ...(grade.explanationReason ? { explanationReason: grade.explanationReason } : {}),
        ...(!grade.correct
          ? {
              ...(sanitizeStemSnapshot(grade.stem) !== undefined
                ? { stemSnapshot: sanitizeStemSnapshot(grade.stem) }
                : {}),
              ...(grade.correctAnswer
                ? { expectedAnswer: sanitizePlacementAnswer(grade.correctAnswer) }
                : {}),
            }
          : {}),
        ...(isStretch
          ? { lane: "stretch" as PracticeAttemptLane }
          : grade.lane
            ? { lane: grade.lane as PracticeAttemptLane }
            : {}),
        breakerEligible:
          !isTeacher && args.replay !== true && args.suppressBreaker !== true,
      },
    );
    await persistBreakerGrade(rec.attemptId);
    const dispatchCompleted = isTeacher
      ? []
      : await reconcileProblemSetDispatchCompletionsForResult(ctx, {
          scholarId: args.scholarId,
          skillKey: item.skillKey,
          now: Date.now(),
        });
    const backOff =
      !isTeacher &&
      !args.suppressBreaker &&
      !args.replay &&
      !grade.correct &&
      (rec.lane === "review" ||
        rec.lane === "frontier" ||
        rec.lane === "confirmation")
        ? await spiralBackOff(ctx, args.scholarId, Date.now())
        : undefined;
    let breakerRecovery: SubmitAnswerResult["breakerRecovery"];
    if (backOff?.repair) {
      let initialRepair: ServedHintStep | undefined;
      if (args.prepareBreakerRepair && !backOff.reattached) {
        initialRepair = await serveHintStepCore(ctx, {
          scholarId: args.scholarId,
          itemId: args.itemId,
          workedSteps: item.prompt.workedSteps,
        });
        const trigger = await ctx.db.get(backOff.repair.triggerAttemptId);
        if (trigger?.breakerLifecycle) {
          await ctx.db.patch(trigger._id, {
            breakerLifecycle: {
              ...trigger.breakerLifecycle,
              ...(initialRepair.rung
                ? {
                    repairShownAt: trigger.breakerLifecycle.repairShownAt ?? Date.now(),
                    repairRungKind: initialRepair.rung.kind,
                  }
                : { repairUnavailableAt: Date.now() }),
            },
          });
        }
      }
      breakerRecovery = {
        ...backOff.repair,
        ...(initialRepair ? { initialRepair } : {}),
      };
    }

    // Stuck-in-practice alert: the spiral breaker just tripped (≥3 consecutive
    // misses across items in a short window — the deterministic "stuck in math"
    // signal). The breaker STILL fires for the child on every qualifying streak
    // and offers the same easy-win back-off. The Slack alert is the staff-facing
    // SUBSET where at least one pinned miss has both a submitted and expected
    // answer — something a teacher can actually inspect. Production backtest
    // calibration (2026-08-19): 0/14 historical alerts involved review, 11/14
    // were entirely frontier, 9/14 had zero diagnosable wrong answers, 7/14 were
    // all manipulative-state misses, 2/14 were all don't-knows, and one scholar
    // received 5 alerts in one morning. All-don't-know episodes schedule the
    // mutually-exclusive calm "not yet taught" info alert; other
    // non-diagnosable episodes remain suppressed and cannot consume either
    // per-sitting dedup window. The scheduled composer gathers the shared pinned
    // evidence without blocking this submission.
    //
    // Fire ONLY on the threshold CROSSING (missStreak === SPIRAL_MISS_THRESHOLD),
    // not on every miss past it. The breaker resets its consecutive-miss count on
    // any correct answer, so the crossing is a natural, state-free episode
    // boundary: one alert per distinct spiral (a 4th/5th miss reads as 4/5 and is
    // skipped; a genuinely new spiral after a recovery crosses 3 again). Distinct
    // diagnosable episodes are coalesced to one staff alert per 30-minute sitting,
    // and there is still no re-alert mid-episode.
    //
    // Only fires for a real scholar (backOff gates on !isTeacher) and never on a
    // grade-only retry (those return above, before recordAttemptCore). Replay
    // submissions never reach this path because they do not evaluate backOff.
    if (
      backOff?.repair &&
      backOff.missStreak === SPIRAL_MISS_THRESHOLD &&
      (shouldAlertOnStuckEpisode(backOff.streakAttempts) ||
        isAllDontKnowStreak(backOff.streakAttempts))
    ) {
      await ctx.scheduler.runAfter(
        PRACTICE_ALERT_COMPOSE_DELAY_MS,
        internal.practiceStuckAlert.compose,
        {
          scholarId: args.scholarId,
          triggerAttemptId: backOff.repair.triggerAttemptId,
          missStreak: backOff.missStreak,
          attemptIds: backOff.streakAttemptIds,
          fallbackSkillLabel: item.skillLabel,
          allDontKnow: isAllDontKnowStreak(backOff.streakAttempts),
        },
      );
    }

    // A stretch SUCCESS is depth evidence: the scholar-earnable input to the
    // node dial's depth arc (nodeDepth.ts reads masteryObservations, MAX level
    // per node). Written only for an UNASSISTED solve (never scaffolded), at
    // the item's tagged Bloom level.
    if (isStretch && grade.correct && !scaffolded && storedRow) {
      await maybeWriteOptionalDepthObservation(ctx, args.scholarId, item, storedRow);
    }

    // Predict-then-Check calibration: on a RECORDED attempt where the kid made a
    // prediction, log ONE practicePredictions row (the confidence value paired
    // with the graded outcome). Purely a metacognitive signal — it never touches
    // mastery/SR (recordAttemptCore already ran and is unaffected). `itemId` is
    // stamped only for a stored practiceItems row (a "gen#<id>" item); template
    // items have no id, so it's omitted. record:false retries return above, so a
    // retry never double-logs a prediction.
    if (args.predictedConfidence) {
      // A template item has no stored id; a stored/manipulative item's `ref` is
      // its real `practiceItems` id (the "gen#<id>" slice).
      const predictedItemId = item.kind === "template" ? undefined : item.ref;
      await ctx.db.insert("practicePredictions", {
        scholarId: args.scholarId,
        skillKey: item.skillKey,
        ...(predictedItemId ? { itemId: predictedItemId } : {}),
        confidence: confidenceValue(args.predictedConfidence as ConfidenceLevel),
        correct: grade.correct,
        source: "practice",
        createdAt: Date.now(),
      });
    }

    // C3 (§7): on a RECORDED miss, classify the wrong answer against the
    // buggy-algorithm patterns and log a practiceErrorEvents row when one
    // matches. This is the observer-channel signal behind the teacher-only
    // misconception flag — NOT a write to the authored record. Best-effort:
    // an unclassifiable miss (a slip, a typo, a stem the parser can't read)
    // logs nothing. The policy gates this to non-manipulative, non-dontKnow
    // misses; record:false handoff retries return above, so never reach here.
    if (grade.shouldClassifyError) {
      const pattern = classifyError({
        skillKey: item.skillKey,
        stem: grade.stem,
        learnerAnswer: args.answer,
        correctAnswer: grade.correctAnswer,
      });
      if (pattern) {
        await ctx.db.insert("practiceErrorEvents", {
          scholarId: args.scholarId,
          nodeKey: item.skillKey,
          domain: item.domain,
          pattern,
          itemId: args.itemId,
          createdAt: Date.now(),
        });
      }
    }
    const result = {
      correct: grade.correct,
      // The recorded attempt's id — the handle the client needs to own up
      // afterwards ("I did this with help", reportHelpUsed). Only the RECORDED path
      // has one.
      attemptId: rec.attemptId,
      correctAnswer: grade.revealedAnswer,
      ...(grade.unitOutcome ? { unitOutcome: grade.unitOutcome } : {}),
      skillKey: item.skillKey,
      skillLabel: item.skillLabel,
      repetition: rec.repetition,
      proficiency: rec.proficiency,
      accelerated: rec.accelerated,
      dontKnow: grade.isDontKnow,
      // P1e: on the attempt that consolidates a skill (turns it fluent), tell the
      // scholar when it returns as review ("comes back ~Thursday"). Both absent
      // otherwise.
      turnedFluent: rec.turnedFluent,
      comesBackAt: rec.comesBackAt,
      dispatchCompleted,
      ...(breakerFreshTrigger
        ? {
            breakerRecoveryVerified:
              grade.correct && !scaffolded && !grade.isDontKnow,
          }
        : {}),
      ...(breakerRecovery ? { breakerRecovery } : {}),
      ...(backOff
        ? {
            backOff: {
              missStreak: backOff.missStreak,
              reattached: backOff.reattached,
              ...(backOff.recoverySkillKey
                ? { recoverySkillKey: backOff.recoverySkillKey }
                : {}),
              ...(backOff.recoveryDomain
                ? { recoveryDomain: backOff.recoveryDomain }
                : {}),
            },
          }
        : {}),
    } as SubmitAnswerResult;
    if (clientEventId) {
      await ctx.db.patch(rec.attemptId, { submissionResult: JSON.stringify(result) });
    }
    return result;
  },
});

/**
 * Open practice-derived error patterns for one node (Wave C, "C3" — §7).
 * TEACHER-ONLY detail behind the node drawer's "Practice pattern" card, mirroring
 * openMisconceptionsForNode's redaction: a scholar viewing their own map gets an
 * empty list (never throws for self), an unrelated caller is rejected upstream.
 * A pattern is returned only while it's currently OPEN (≥3 of the same in the
 * trailing 14 days); the flag auto-clears once the errors stop.
 */
export const practiceErrorFlagsForNode = authedQuery({
  args: { scholarId: v.id("users"), nodeKey: v.string() },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (!isTeacher) return { patterns: [] as OpenErrorPattern[] };
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const events = await ctx.db
      .query("practiceErrorEvents")
      .withIndex("by_scholar_node", (q) =>
        q.eq("scholarId", args.scholarId).eq("nodeKey", args.nodeKey),
      )
      .collect();
    return { patterns: openErrorPatterns(events, Date.now()) };
  },
});

/** One retained MISS: whatever's renderable from a graded miss on this node —
 *  a snapshot of the problem + what was submitted/expected, the scratchpad
 *  working if one was captured, and the classified error-pattern phrasing if
 *  one was recognized. Teacher/analytics-only. */
type RecentMiss = {
  nodeKey: string;
  at: number;
  stemSnapshot?: string;
  answerText?: string;
  expectedAnswer?: string;
  workImageUrl?: string;
  errorPattern?: string;
};
/**
 * How many of the node's recent attempts to look through for a renderable
 * miss, and how many to hand back. The scan bound matters because only MISSES
 * carry anything to show, so a scholar who has since practised the node a lot
 * has their misses buried; the take bound keeps the drawer a glance, not a
 * gallery.
 */
const RECENT_MISS_SCAN = 60;
const RECENT_MISS_LIMIT = 3;
/** Both a `practiceAttempts` row and its (optional) `practiceErrorEvents` row
 *  are written by the same grading call, so a short join tolerance is enough
 *  to pair them by `itemId` + nearest `createdAt` without a direct FK. */
const ERROR_EVENT_JOIN_TOLERANCE_MS = 60_000;

/**
 * Keep only the newest miss per item, so a scholar who retries the same
 * problem and misses it again (and again) doesn't crowd out other distinct
 * missed problems in the limited-size "recent misses" digest — the point of
 * the surface is showing WHICH problems a scholar is missing, not one stuck
 * item several times over. Rows are already `.order("desc")`, so the first
 * occurrence of a key IS the newest. `itemId` is optional on
 * `practiceAttempts`, so rows without one (never expected in practice, but
 * not ruled out by the schema) are keyed by their own `_id` instead — they
 * must never collapse into each other.
 */
function dedupeByItem<T extends { itemId?: string; _id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const row of rows) {
    const key = row.itemId ?? `__row_${row._id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

/** Attach classified error-pattern phrasing (if any) to each miss row, joining
 *  `practiceErrorEvents` by `itemId` + nearest `createdAt` — there's no direct
 *  FK between the two tables, so this reuses the same phrasing table the
 *  aggregate node-drawer flag already shows, just at per-instance grain. */
function attachErrorPatterns<T extends { itemId?: string; createdAt?: number; _creationTime: number }>(
  rows: T[],
  events: Array<{ itemId: string; pattern: string; createdAt: number }>,
): Map<T, string> {
  const result = new Map<T, string>();
  for (const row of rows) {
    if (!row.itemId) continue;
    const at = row.createdAt ?? row._creationTime;
    const matched = events
      .filter((e) => e.itemId === row.itemId && Math.abs(e.createdAt - at) <= ERROR_EVENT_JOIN_TOLERANCE_MS)
      .sort((a, b) => Math.abs(a.createdAt - at) - Math.abs(b.createdAt - at))[0];
    const phrasing = matched ? PATTERN_PHRASING[matched.pattern as ErrorPattern] : undefined;
    if (phrasing) result.set(row, phrasing);
  }
  return result;
}

/**
 * Attach the scholar's own working (a cropped Scratchpad PNG) to their most
 * recent attempt on `itemId`.
 *
 * Called fire-and-forget by the native practice screen right after a RECORDED
 * miss, so the pad's ink stops being thrown away at the one moment it is
 * diagnostic. Deliberately a separate mutation rather than an argument to
 * `recordAttempt`: the capture is asynchronous (render → encode → upload) and
 * must never delay, block or fail the scholar's feedback card.
 *
 * Why this exists at all: `practiceErrorEvents` (right above) is the channel
 * that is supposed to carry "where they went wrong", but it is derived from the
 * ANSWER — it stays silent on any miss the classifier can't read, and it encodes
 * a buggy-algorithm PATTERN, never HOW FAR the scholar got. The working is the
 * only record of the difference between "set it up right and slipped at step 3"
 * and "never got started".
 *
 * Best-effort by contract: no matching attempt (a `record: false` retry, a stale
 * item) is a silent no-op, never an error the scholar could see.
 *
 * SELF-ONLY WRITE, for the same reason as `recordTeachingOutcome` above: this
 * patches a REAL scholar's `practiceAttempts` row, so a teacher walking the
 * activity as a preview must never annotate it. Ownership of the image cannot
 * stand in for the guard — `practiceWorkImages.authorizeUpload` admits a
 * teacher, so a preview sitting can mint the ownership row too. Authorization
 * is unchanged and still runs first (the `requireTeacherOrSelf` role gate, then
 * the `requireActiveScholarAccess` institution boundary for a teacher); this
 * check gates only the WRITE, and a non-self call returns the existing
 * `{ attached: false }` no-op shape rather than throwing, because the native
 * screen calls this fire-and-forget and a bookkeeping failure must never
 * surface to the scholar.
 */
export const attachAttemptWork = authedMutation({
  args: {
    scholarId: v.id("users"),
    itemId: v.string(),
    imageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    // Self-or-teacher: in practice always self (the scholar who drew it) — and
    // now enforced, so a teacher-preview sitting can never annotate the row.
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const isSelfPractice = !isTeacher && ctx.user._id === args.scholarId;
    if (!isSelfPractice) return { attached: false };
    const ownership = await ctx.db
      .query("practiceWorkImages")
      .withIndex("by_storage", (q) => q.eq("storageId", args.imageId))
      .filter((q) =>
        q.and(
          q.eq(q.field("scholarId"), args.scholarId),
          q.eq(q.field("itemId"), args.itemId),
        ),
      )
      .first();
    if (!ownership) throw new Error("Practice image ownership could not be verified.");

    const latest = await ctx.db
      .query("practiceAttempts")
      .withIndex("by_scholar_item_createdAt", (q) =>
        q.eq("scholarId", args.scholarId).eq("itemId", args.itemId),
      )
      .filter((q) => q.neq(q.field("retry"), true))
      .order("desc")
      .first();
    // Only ever annotate a MISS. A correct attempt landing between the miss and
    // this call (impossible today — the screen sits on the feedback card — but
    // cheap to guarantee) must not pick up the working.
    if (!latest || latest.correct) return { attached: false };
    if (latest.workImageId) return { attached: false };

    await ctx.db.patch(latest._id, { workImageId: args.imageId });
    return { attached: true };
  },
});

/**
 * The scholar's recent MISSES on one node — teacher-only, same redaction as
 * `practiceErrorFlagsForNode` above (a scholar reading their own map gets an
 * empty list rather than a throw; a parent never gets here).
 *
 * Renders whatever a miss actually carries: the snapshotted stem + expected
 * answer (Option 2 — see `practiceAttempts.stemSnapshot` doc comment), what the
 * scholar typed (`answerText`), the classified error-pattern phrasing if one was
 * recognized, and the retained scratchpad working if one was captured. A miss
 * with nothing renderable (a legacy pre-snapshot row, or a stretch-dialogue
 * miss — which has no discrete stem) is silently omitted; no special-casing
 * needed. This subsumes the old `recentWorkForNode` (image-only) — same query,
 * same two call sites, broader content.
 */
export const recentMissesForNode = authedQuery({
  args: { scholarId: v.id("users"), nodeKey: v.string() },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (!isTeacher) return { misses: [] as RecentMiss[] };
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const rows = await ctx.db
      .query("practiceAttempts")
      .withIndex("by_scholar_node_createdAt", (q) =>
        q.eq("scholarId", args.scholarId).eq("nodeKey", args.nodeKey),
      )
      .order("desc")
      .take(RECENT_MISS_SCAN);

    const renderable = rows
      // A don't-know is an honest "I haven't learned this yet", not a
      // misconception — it renders in the don't-know strip (`dontKnowsForNode`
      // below), never here, so one attempt shows in exactly one place (no
      // double counting). Without this, a `dont_know` row carries a
      // `stemSnapshot`/`expectedAnswer` and would otherwise pass as a plain miss.
      .filter((row) => !row.correct && row.explanationReason !== "dont_know")
      .filter((row) => row.workImageId || row.stemSnapshot || row.expectedAnswer || row.answerText);
    const candidates = dedupeByItem(renderable).slice(0, RECENT_MISS_LIMIT);
    if (candidates.length === 0) return { misses: [] as RecentMiss[] };

    const events = await ctx.db
      .query("practiceErrorEvents")
      .withIndex("by_scholar_node", (q) =>
        q.eq("scholarId", args.scholarId).eq("nodeKey", args.nodeKey),
      )
      .collect();
    const patternByRow = attachErrorPatterns(candidates, events);

    const misses: RecentMiss[] = [];
    for (const row of candidates) {
      const workImageUrl = row.workImageId ? (await ctx.storage.getUrl(row.workImageId)) ?? undefined : undefined;
      misses.push({
        nodeKey: row.nodeKey,
        at: row.createdAt ?? row._creationTime,
        ...(row.stemSnapshot ? { stemSnapshot: row.stemSnapshot } : {}),
        ...(row.answerText ? { answerText: row.answerText } : {}),
        ...(row.expectedAnswer ? { expectedAnswer: row.expectedAnswer } : {}),
        ...(workImageUrl ? { workImageUrl } : {}),
        ...(patternByRow.has(row) ? { errorPattern: patternByRow.get(row)! } : {}),
      });
    }
    return { misses };
  },
});

/** The teach-outcome rung breakdown for a node's don't-know taps — how deep the
 *  teaching-moment scaffold got before the scholar left it. A don't-know with no
 *  recorded rung (the 15-minute window expired, or a legacy/template row) counts
 *  toward `count` but no bucket, so the buckets can sum to less than `count`. */
type DontKnowRungs = { solved: number; hint: number; stuck: number };

/** One retained DON'T-KNOW for the teacher strip: when it happened and the
 *  snapshotted stem if one was captured (a don't-know carries no submitted
 *  answer). Teacher/analytics-only, same redaction as the misses card. */
type DontKnowItem = { nodeKey: string; at: number; stemSnapshot?: string };

/** How many recent don't-know items to hand back for the strip — a glance, not a
 *  gallery, mirroring `RECENT_MISS_LIMIT`. The `count` + rung breakdown are over
 *  ALL don't-knows on the node; only this preview list is bounded. */
const RECENT_DONT_KNOW_LIMIT = 3;

/**
 * The scholar's honest "I haven't learned this yet" taps on one node — the
 * teacher-only counterpart to `recentMissesForNode` above, with its exact
 * redaction (a scholar reading their own map gets zeros/empties rather than a
 * throw; a parent never reaches here; a non-teacher, non-self caller is rejected
 * by `requireTeacherOrSelf`).
 *
 * A `dont_know` attempt (`explanationReason: "dont_know"`) is honesty, not a
 * misconception — the OPPOSITE intervention from a wrong answer (teach it vs.
 * diagnose it), yet today it renders identically to a miss. This returns the
 * count of those taps, the `teachOutcome` rung breakdown (solved / hint / stuck
 * — WHICH scaffold rung the teaching moment reached; "stuck" is the strongest
 * "teach this from scratch" signal the engine has), and a few recent items for
 * the strip that sits beside the misses card. `recentMissesForNode` now excludes
 * these rows, so one attempt renders in exactly one place.
 *
 * Reads the same `by_scholar_node_createdAt` index `recentMissesForNode` uses,
 * scoped to one (scholar, node) — a bounded index range, not a table scan (the
 * same shape `practiceErrorFlagsForNode` collects for its aggregate flag).
 */
export const dontKnowsForNode = authedQuery({
  args: { scholarId: v.id("users"), nodeKey: v.string() },
  handler: async (ctx, args) => {
    const empty = {
      count: 0,
      teachOutcomes: { solved: 0, hint: 0, stuck: 0 } as DontKnowRungs,
      items: [] as DontKnowItem[],
    };
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (!isTeacher) return empty;
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const rows = await ctx.db
      .query("practiceAttempts")
      .withIndex("by_scholar_node_createdAt", (q) =>
        q.eq("scholarId", args.scholarId).eq("nodeKey", args.nodeKey),
      )
      .order("desc")
      .collect();

    // Each tap is one attempt (no dedupe): "4 honest 'I don't know' taps" counts
    // taps, not distinct items — the same problem tapped twice is two taps.
    const dontKnows = rows.filter((row) => row.explanationReason === "dont_know");
    if (dontKnows.length === 0) return empty;

    const teachOutcomes: DontKnowRungs = { solved: 0, hint: 0, stuck: 0 };
    for (const row of dontKnows) {
      if (row.teachOutcome) teachOutcomes[row.teachOutcome] += 1;
    }

    const items: DontKnowItem[] = dontKnows
      .slice(0, RECENT_DONT_KNOW_LIMIT)
      .map((row) => ({
        nodeKey: row.nodeKey,
        at: row.createdAt ?? row._creationTime,
        ...(row.stemSnapshot ? { stemSnapshot: row.stemSnapshot } : {}),
      }));

    return { count: dontKnows.length, teachOutcomes, items };
  },
});

/**
 * One teacher-facing page of a scholar's graded work in a domain. Unlike the
 * old compact recent-misses digest, this preserves every attempt so a teacher
 * can follow both recovery and recurring trouble chronologically.
 *
 * Deliberately a `teacherQuery` (a hard throw for scholars): the sole mount is
 * the teacher-gated math-skills report, so don't quietly widen the surface.
 */
export const recentAttemptsForDomain = teacherQuery({
  args: {
    scholarId: v.id("users"),
    domain: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const attemptPage = await ctx.db
      .query("practiceAttempts")
      .withIndex("by_scholar_domain_createdAt", (q) =>
        q.eq("scholarId", args.scholarId).eq("domain", args.domain),
      )
      .order("desc")
      .paginate(args.paginationOpts);
    if (attemptPage.page.length === 0) return { ...attemptPage, page: [] };

    // Point-lookups over the page's distinct keys, not a whole-domain collect:
    // keeps the read set page-sized so curriculum edits elsewhere in the domain
    // don't invalidate every loaded page.
    const keys = [...new Set(attemptPage.page.map((a) => a.nodeKey))];
    const labelByKey = new Map(
      (
        await Promise.all(
          keys.map((k) =>
            ctx.db
              .query("knowledgeNodes")
              .withIndex("by_nodeKey", (q) => q.eq("nodeKey", k))
              .unique(),
          ),
        )
      ).flatMap((n) => (n ? [[n.nodeKey, n.label] as const] : [])),
    );

    const misses = attemptPage.page.filter((attempt) => !attempt.correct);
    const missTimes = misses.map((attempt) => attempt.createdAt ?? attempt._creationTime);
    const events =
      missTimes.length === 0
        ? []
        : await ctx.db
            .query("practiceErrorEvents")
            .withIndex("by_scholar_domain_createdAt", (q) =>
              q
                .eq("scholarId", args.scholarId)
                .eq("domain", args.domain)
                .gte("createdAt", Math.min(...missTimes) - ERROR_EVENT_JOIN_TOLERANCE_MS)
                .lte("createdAt", Math.max(...missTimes) + ERROR_EVENT_JOIN_TOLERANCE_MS),
            )
            .collect();
    // Misses only: the itemId+time join would otherwise pin a buggy-algorithm
    // diagnosis onto the CORRECT retry that follows a recorded miss.
    const patternByAttempt = attachErrorPatterns(
      misses,
      events,
    );

    const page = await Promise.all(attemptPage.page.map(async (attempt) => {
      const workImageUrl = attempt.workImageId
        ? (await ctx.storage.getUrl(attempt.workImageId)) ?? undefined
        : undefined;
      // The grade-time snapshot is best-effort; when absent, re-resolve the
      // item (templates are deterministic, stored items keep their stem), so
      // the detail dialog can show the exact problem. Unknown/retired items
      // just stay stem-less. Only the stem is taken — canonical answers are
      // never served, snapshots only.
      let stem = attempt.stemSnapshot;
      if (stem === undefined && attempt.itemId) {
        try {
          stem = (await resolveServableItem(ctx, attempt.itemId, args.domain)).prompt.stem;
        } catch {
          // leave undefined
        }
      }
      return {
        attemptId: attempt._id,
        // Display-only fallback; every current writer stamps createdAt, so
        // this cannot reorder the feed (the index sorts on createdAt).
        at: attempt.createdAt ?? attempt._creationTime,
        skillKey: attempt.nodeKey,
        skillLabel: labelByKey.get(attempt.nodeKey) ?? attempt.nodeKey,
        ...(stem !== undefined ? { stemSnapshot: stem } : {}),
        ...(attempt.answerText !== undefined ? { answerText: attempt.answerText } : {}),
        ...(attempt.expectedAnswer !== undefined ? { expectedAnswer: attempt.expectedAnswer } : {}),
        correct: attempt.correct,
        ...(attempt.explanationReason === "dont_know"
          ? { dontKnow: true as const }
          : {}),
        ...(attempt.retry ? { retry: true as const } : {}),
        ...(attempt.lane ? { lane: attempt.lane } : {}),
        ...(workImageUrl ? { workImageUrl } : {}),
        ...(patternByAttempt.has(attempt)
          ? { errorPattern: patternByAttempt.get(attempt)! }
          : {}),
      };
    }));

    return { ...attemptPage, page };
  },
});

/**
 * The auto-remediation target queued for THIS node (§5) — teacher-facing only.
 *
 * Returns `{ skillKey, label }` for the prerequisite the engine is auto-serving
 * because this node is the scholar's most-recently-flagged node, or `null` when
 * nothing is queued (not a teacher, this node isn't the current flag winner, or
 * no eligible prereq). Scholars never see this — the
 * word never reaches a scholar surface.
 */
export const autoRemediationTargetForNode = authedQuery({
  args: { scholarId: v.id("users"), nodeKey: v.string() },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (!isTeacher) return null;
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const node = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_nodeKey", (q) => q.eq("nodeKey", args.nodeKey))
      .unique();
    if (!node) return null;
    const domain = node.domain;
    const { practiceScope } = await resolvePracticeScope(ctx, args.scholarId);
    if (!practiceScopeAllowsNode(practiceScope, node.domain, node.strand)) {
      return null;
    }

    const { skills, edges } = scopeLoadedDomain(
      practiceScope,
      domain,
      await loadDomain(ctx, domain),
    );
    const mastery = await loadMastery(ctx, args.scholarId, domain);

    const now = Date.now();
    const events = await ctx.db
      .query("practiceErrorEvents")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    const inDomain = events.filter((e) => e.domain === domain);
    // Only surface on the node that actually owns the current flag.
    if (pickFlaggedNode(inDomain, now) !== args.nodeKey) return null;

    const target = pickRemediationTarget(
      args.nodeKey,
      edges,
      (k) => {
        const row = mastery.get(k);
        return row ? stateFromRow(row) : undefined;
      },
      now,
    );
    if (target === null) return null;

    const labelOf = new Map(skills.map((s) => [s.skillKey, s.label]));
    return { skillKey: target, label: labelOf.get(target) ?? target };
  },
});

/** Skill metadata for the generation action's prompt. */
export const getSkillInfo = internalQuery({
  args: { skillKey: v.string() },
  handler: async (ctx, args) => {
    const s = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_nodeKey", (q) => q.eq("nodeKey", args.skillKey))
      .first();
    return s
      ? {
          label: s.label,
          grade: s.grade ?? null,
          standardCodes: s.standardCodes ?? [],
          domain: s.domain,
        }
      : null;
  },
});

/** Persist verified generated items (the generation action calls this). */
export const storeGeneratedItems = internalMutation({
  args: {
    skillKey: v.string(),
    replace: v.optional(v.boolean()),
    items: v.array(
      v.object({
        skillKey: v.string(),
        domain: v.string(),
        stem: v.string(),
        answerType: v.string(),
        answerCanonical: v.string(),
        // Display-form measurement unit ("cm³"), already gated by
        // practiceGen.generatedAnswerUnit. Optional: most items have none.
        answerUnit: v.optional(v.string()),
        verifierKind: v.optional(v.string()),
        promptVisual: v.optional(promptVisualValidator),
        model: v.optional(v.string()),
        revealLine: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    if (args.replace) {
      const prior = await ctx.db
        .query("practiceItems")
        .withIndex("by_skill", (q) => q.eq("skillKey", args.skillKey))
        .collect();
      for (const p of prior) {
        // Replace regenerates WORD items only — manipulatives are authored
        // artifacts, deleted deliberately (item-pool UI / bot tool), never as
        // a side effect of a word-problem refresh. Guarding at the write site
        // also closes the check-then-act window in generateForNode's
        // preflight (the LLM call takes seconds; a manipulative inserted
        // meanwhile must survive).
        if (p.verifierKind === MANIPULATIVE_VERIFIER_KIND) continue;
        // A problems-in-chat card is durable transcript history. Keep its
        // server-only grading row so revisiting that card does not turn its
        // `gen#<id>` into an ungradeable dangling reference.
        const chatReference = await ctx.db
          .query("messages")
          .withIndex("by_chat_practice_item", (q) =>
            q.eq("chatPractice.itemId", `gen#${p._id}`),
          )
          .first();
        if (chatReference) continue;
        await ctx.db.delete(p._id);
      }
    }
    let n = 0;
    for (const it of args.items) {
      if (hasMarkdownFormatting(it.stem)) {
        throw new Error("Generated practice stems must be plain text without Markdown formatting");
      }
      await ctx.db.insert("practiceItems", { ...it, source: "generated", verifiedAt: Date.now() });
      n++;
    }
    return n;
  },
});

/**
 * Count already-stored CORE items for a skill — the pre-warm seed step's
 * idempotency check (practiceGen.prewarmConceptualItems). A tiny read-only
 * query, needed because "use node" action files (practiceGen.ts) cannot
 * contain queries/mutations themselves and must reach the DB through one
 * defined here, alongside the sibling getSkillInfo/storeGeneratedItems.
 *
 * Special-tier rows are excluded deliberately: the pre-warm gate skips a node
 * once this reaches PREWARM_MIN_ITEMS, and the items it generates feed the
 * tier-absent core rotation. Counting stretch rows here would let curated
 * special-tier content SUPPRESS generation of the core items the node still
 * needs — the same tier-blindness that made poolSummaryCore over-report
 * coverage, one layer earlier.
 */
export const countStoredItems = internalQuery({
  args: { skillKey: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("practiceItems")
      .withIndex("by_skill_tier", (q) =>
        q.eq("skillKey", args.skillKey).eq("tier", undefined),
      )
      .collect();
    return rows.length;
  },
});

/** The action-safe projection of an activity's persisted practice targets. */
export const problemSetGenerationTargets = internalQuery({
  args: { activityId: v.id("activities") },
  handler: async (ctx, args) => {
    const activity = await ctx.db.get(args.activityId);
    if (!activity || activity.kind !== "problem_set" || !activity.problemSet) {
      return null;
    }
    const domain =
      activity.problemSet.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN;
    const nodes = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .collect();
    const knownKeys = new Set(nodes.map((node) => node.nodeKey));
    return {
      targetSkillKeys: [
        ...new Set(activity.problemSet.targetSkillKeys.filter((key) => knownKeys.has(key))),
      ],
    };
  },
});

/** Schedule durable item generation after any problem-set activity write. */
export async function scheduleProblemSetItemGeneration(
  ctx: MutationCtx,
  activityId: Id<"activities">,
) {
  await ctx.scheduler.runAfter(
    0,
    internal.practiceGen.ensureProblemSetItems,
    { activityId },
  );
}

export const getDomain = query({
  args: { domain: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { skills, edges } = await loadDomain(ctx, args.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN);
    return { skills, edges };
  },
});

/**
 * Grade band ("K".."8") for each of `skillKeys`, keyed by skillKey. Pure
 * curriculum metadata (a knowledge node's optional `grade` tag) — the same kind
 * of public curriculum read as `getDomain` / `getManipulativeItem`, never
 * scholar data.
 *
 * The served-item wire (`ServedItem`) deliberately omits grade, so the practice
 * drill reads it here to gate the kindergarten (grade "K") read-aloud speaker on
 * a question stem — a pre-reader can hear the question. Placement carries its
 * probe grade on the wire already, so only the drill needs this. Keys with no
 * node, or a node with no grade tag, are simply absent from the returned map.
 */
export const gradeBandsForKeys = query({
  args: { skillKeys: v.array(v.string()) },
  returns: v.record(v.string(), v.string()),
  handler: async (ctx, { skillKeys }) => {
    const out: Record<string, string> = {};
    const seen = new Set<string>();
    for (const key of skillKeys) {
      if (seen.has(key)) continue;
      seen.add(key);
      const node = await ctx.db
        .query("knowledgeNodes")
        .withIndex("by_nodeKey", (q) => q.eq("nodeKey", key))
        .first();
      if (node?.grade) out[key] = node.grade;
    }
    return out;
  },
});

// ── Placement warmth-floor backfill (Tier 1c) ──────────────────────────────
// One-time-ish maintenance: give EXISTING stored LLM word-problem items a
// verified `revealLine` (new items get one at generation time). Idempotent +
// budget-capped: `backfillRevealLines` (convex/practiceGen.ts) reads a small
// batch of items still missing a line, generates candidates, and writes back
// only the verified ones through `setItemRevealLine`. Manipulatives have no
// answer string to reveal and are skipped. NEVER run against prod from a
// worktree — dev deployment only.

/** A batch of stored word-problem items still missing a reveal line. */
export const listItemsMissingRevealLine = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("practiceItems")
      .filter((q) =>
        q.and(
          q.eq(q.field("source"), "generated"),
          q.eq(q.field("revealLine"), undefined),
          q.neq(q.field("verifierKind"), MANIPULATIVE_VERIFIER_KIND),
        ),
      )
      .take(Math.max(1, Math.min(args.limit, 100)));
    return rows.map((r) => ({
      itemId: r._id,
      stem: r.stem,
      answerCanonical: r.answerCanonical,
    }));
  },
});

/**
 * Patch a reveal line onto ONE stored item — but only after it clears the SAME
 * verification gate new items pass (the S8 operand-substitution ban against the
 * item's own numbers). A no-op if the row is gone, already has a line, or the
 * candidate fails verification. Returns whether it wrote.
 */
export const setItemRevealLine = internalMutation({
  args: { itemId: v.id("practiceItems"), revealLine: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.itemId);
    if (!doc || doc.revealLine) return false;
    const itemNumbers = [
      ...extractNumbers(doc.stem),
      ...extractNumbers(doc.answerCanonical),
    ];
    if (!verifyRevealLine(args.revealLine, itemNumbers).ok) return false;
    await ctx.db.patch(args.itemId, { revealLine: args.revealLine.trim() });
    return true;
  },
});


/**
 * Deliberately UNAUTHENTICATED read for the native inline-manipulative surface
 * (lane 3, review/native-manipulative-plan): the web `/embed/manipulative`
 * route is loaded inside a scoped `react-native-webview` that carries no
 * Convex Auth session, so it can't call an `authedQuery`. Safe to leave open —
 * a manipulative's `manipulativeSpec` has no answer string to leak (the goal
 * IS the visible task; see practiceContract.ts), and this explicitly refuses
 * any non-manipulative item (their `answerCanonical` DOES matter and must
 * never be servable here). The strategy hint is answer-free and comes from the
 * same existing `hintForSkill` helper as web practice. Grading still only ever happens through the authed
 * `submitAnswer` — this query is read-only and returns no verdict.
 */
export const getManipulativeItem = query({
  args: { itemId: v.string() },
  handler: async (ctx, args) => {
    if (!args.itemId.startsWith("gen#")) return null;
    const doc = await ctx.db.get(args.itemId.slice(4) as Id<"practiceItems">);
    if (!doc || doc.verifierKind !== MANIPULATIVE_VERIFIER_KIND) return null;
    const spec = parseManipulativeSpec(doc.manipulativeSpec);
    if (spec && isRetiredManipulativeSpecId(spec.id)) return null;
    return {
      itemId: args.itemId,
      stem: doc.stem,
      // No-spoilers: strip a geoLocate task's target before it leaves the server
      // (every other kind's spec has no answer and passes through unchanged).
      manipulativeSpec: redactManipulativeSpecForClient(doc.manipulativeSpec) ?? null,
      hint: hintForSkill(doc.skillKey),
    };
  },
});

// ── Placement — per-strand adaptive binary search (roadmap §3) ─────────────
// Replaces the grade-anchored linear placement: each STRAND is ordered
// topologically from the buildsOn graph and binary-searched for its frontier
// INDEPENDENTLY (~3–4 probes/strand). "Trust upward" credits everything below a
// strand's frontier as fluent, but at a SHORT half-life so an over-generous
// placement resurfaces and self-corrects within days. Progress persists to
// `practicePlacements` so a paused diagnostic resumes. Discipline-agnostic
// (keyed by `domain`). Pure logic: convex/lib/practice/placement.ts.
// Status is monotonic: "in_progress" is insert-only; existing rows may advance
// to "complete", but serving or grading must never reopen a converged run.

/** Load a domain's nodes/edges and derive its per-strand topological orders.
 *
 * `edges` is the GATING set (buildsOn) — used for `strandOrders` (the per-strand
 * topological order the binary search walks) and by `creditPlacementFrontiers`'s
 * `computeFrontier` (so an `implies` edge never blocks the frontier). `impliesEdges`
 * is the INFERENCE-ONLY set, consumed ONLY by `impliedPlacementFloors` in the
 * single-domain `submitPlacementAnswer` path: a demonstrated cross-domain source
 * raises a resume floor that credits + skips its target entrance. It deliberately
 * does NOT enter `strandOrders` (a cross-domain source isn't in this domain's node
 * set anyway) — the floor mechanism is the one explicit placement consumer. */
async function loadPlacementContext(ctx: QueryCtx | MutationCtx, domain: string) {
  const nodes = await ctx.db
    .query("knowledgeNodes")
    .withIndex("by_domain", (q) => q.eq("domain", domain))
    .collect();
  const edgeRows = await ctx.db
    .query("knowledgeNodeEdges")
    .withIndex("by_domain", (q) => q.eq("domain", domain))
    .collect();
  const edges = edgeRows
    .filter((e) => e.kind === "buildsOn")
    .map((e) => ({ fromKey: e.fromKey, toKey: e.toKey }));
  const impliesEdges = edgeRows
    .filter((e) => e.kind === "implies")
    .map((e) => ({ fromKey: e.fromKey, toKey: e.toKey }));
  const orders = strandOrders(
    nodes.map((n) => ({ nodeKey: n.nodeKey, strand: n.strand, order: n.order })),
    edges,
  );
  const nodeByKey = new Map(nodes.map((n) => [n.nodeKey, n]));
  const isProbeable = (key: string): boolean => hasTemplate(key);
  return { nodes, edges, impliesEdges, orders, nodeByKey, isProbeable };
}

/**
 * Diagnostic placement floors from cross-domain INFERENCE-ONLY `implies` edges —
 * the PLACEMENT consumer of `implies` (the other is FIRe implicit credit). This
 * is the wiring that makes `implies` do REAL work in production: without it, a
 * cross-domain `implies` source is invisible to placement (its node isn't in the
 * target domain's strand, so `topoOrderStrand` drops the edge) AND to FIRe (the
 * source mastery row lives in another domain, absent from the target's
 * `preMastery`).
 *
 * When a scholar enters an UNMAPPED domain (no mastery here), a DEMONSTRATED
 * cross-domain `implies` SOURCE is diagnostic evidence for its target entrance:
 * the edges are curated so the target's template genuinely exercises the source
 * skill, so a scholar already fluent in the source can be trusted-upward through
 * that target without spending a probe. Each such target raises its strand's
 * resume floor to cover it — reusing placement's EXISTING resume-floor mechanism,
 * so the target (and the topological prefix below it) is credited as fluent at the
 * short placement half-life and skipped as a probe. It NEVER gates: it only lifts
 * a floor (credit + skip), and the short half-life self-corrects an over-generous
 * credit within days, exactly like every other trust-upward placement credit.
 *
 * Returns `strand -> floorIndex` (count of leading nodes to credit). Empty unless
 * the scholar has a demonstrated (accessProven) mastery row for a cross-domain
 * `implies` source. Cross-domain read mirrors `buildFrontierStateOf`: resolve the
 * source's mastery in the source's OWN domain via `by_scholar_skill`.
 */
async function impliedPlacementFloors(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  impliesEdges: readonly { fromKey: string; toKey: string }[],
  orders: StrandOrder[],
  nodeByKey: Map<string, Doc<"knowledgeNodes">>,
): Promise<Map<string, number>> {
  const floors = new Map<string, number>();
  // Only CROSS-domain implies edges carry diagnostic evidence from ANOTHER
  // domain: the source is NOT in this domain's node set, the target IS. An
  // intra-domain implies source would already be measured by this domain's probes.
  const crossEdges = impliesEdges.filter(
    (e) => !nodeByKey.has(e.fromKey) && nodeByKey.has(e.toKey),
  );
  if (crossEdges.length === 0) return floors;

  // Resolve each distinct source's demonstrated state ONCE.
  const demonstrated = new Set<string>();
  for (const key of new Set(crossEdges.map((e) => e.fromKey))) {
    const srcNode = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_nodeKey", (q) => q.eq("nodeKey", key))
      .first();
    const rows = await ctx.db
      .query("practiceMastery")
      .withIndex("by_scholar_skill", (q) =>
        q.eq("scholarId", scholarId).eq("skillKey", key),
      )
      .collect();
    const row = srcNode ? (rows.find((r) => r.domain === srcNode.domain) ?? rows[0]) : rows[0];
    if (row && accessProven(row)) demonstrated.add(key);
  }
  if (demonstrated.size === 0) return floors;

  const posByKey = new Map<string, { strand: string; index: number }>();
  for (const o of orders) {
    o.orderedKeys.forEach((k, i) => posByKey.set(k, { strand: o.strand, index: i }));
  }
  for (const e of crossEdges) {
    if (!demonstrated.has(e.fromKey)) continue;
    const pos = posByKey.get(e.toKey);
    if (!pos) continue;
    floors.set(pos.strand, Math.max(floors.get(pos.strand) ?? 0, pos.index + 1));
  }
  return floors;
}

/** Merge two per-strand floor maps by taking the higher floor for each strand
 *  (both are "credit everything below this index" boundaries, so MAX is correct). */
function mergeFloors(
  a: Map<string, number>,
  b: Map<string, number>,
): Map<string, number> {
  const out = new Map(a);
  for (const [strand, idx] of b) out.set(strand, Math.max(out.get(strand) ?? 0, idx));
  return out;
}

/** Grade a client's accumulated placement answers into per-node probe outcomes.
 *  Routed through the unified serve/grade dispatcher (servable.ts): each answer
 *  is a TEMPLATE re-probe item (reprobe serves template-only), resolved with the
 *  pure `buildTemplateServable` builder and graded under the no-side-effect
 *  GRADE_ONLY policy. A non-template id yields no outcome (skipped). */
function gradeOutcomes(answers: { itemId: string; answer: string }[]): ProbeOutcome[] {
  const out: ProbeOutcome[] = [];
  for (const a of answers) {
    const item = buildTemplateServable(a.itemId, null, "");
    if (!item) continue;
    const grade = gradeSubmission(item, { kind: "typed", raw: a.answer }, GRADE_ONLY_POLICY);
    out.push(probeOutcomeFromKind(grade.skillKey, grade.correct ? "correct" : "incorrect"));
  }
  return out;
}

/** Deterministic per-probe seed so re-fetching a strand's probe is stable. */
function probeSeed(base: number, strand: string, index: number): number {
  let h = (base >>> 0) ^ 0x9e3779b9;
  for (let i = 0; i < strand.length; i++) h = (Math.imul(h, 31) + strand.charCodeAt(i)) >>> 0;
  return (h + Math.imul(index + 1, 2654435761)) >>> 0;
}

/**
 * Best-effort soft grade for the result screen (grade is a tag now, not the
 * placement axis): the highest grade whose every node was credited, contiguous
 * from the lowest present grade. Null when even the lowest grade isn't cleared.
 */
function derivePlacedThroughGrade(
  creditedSet: Set<string>,
  nodes: { nodeKey: string; grade?: string }[],
): string | null {
  const grades = [...new Set(nodes.map((n) => n.grade).filter((g): g is string => !!g))].sort(
    (a, b) => gradeRank(a) - gradeRank(b),
  );
  let placed: string | null = null;
  for (const g of grades) {
    const allCredited = nodes
      .filter((n) => n.grade === g)
      .every((n) => creditedSet.has(n.nodeKey));
    if (allCredited) placed = g;
    else break;
  }
  return placed;
}

/**
 * True when the scholar still needs to place on this domain. A converged
 * placement run is the only mapping evidence; mastery alone is shadow placement.
 */
export const needsPlacement = authedQuery({
  args: { scholarId: v.id("users"), domain: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const domain = args.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN;
    const placement = await ctx.db
      .query("practicePlacements")
      .withIndex("by_scholar_domain", (q) => q.eq("scholarId", args.scholarId).eq("domain", domain))
      .first();
    return !isMappedPlacementStatus(placement?.status);
  },
});

// The legacy single-round placement pair (`placementProbes` / `submitPlacement`)
// was REMOVED 2026-07-06 (PR #576): the placement-v2 loop below is the only
// scholar-facing path, prod carried no real math-practice data (Andy approved
// dropping legacy compat), and the fixture path (`placeScholarInternal`) never
// used them. One consequence to know: a v1 `frontierByStrand`-only row (no
// probeLog) still resumes correctly — the v2 loop reads `frontierByStrand` as
// per-strand resume floors — but v2 rows only write `frontierByStrand` at
// finalize, so there is no v2→v1 resume (moot with v1 gone).

/**
 * Seed mastery from resolved per-strand frontiers and recompute the domain
 * frontier flag — the finalize of the placement-v2 loop (`submitPlacementAnswer`),
 * preserving the two-axis invariant: everything below a strand's frontier is
 * credited FLUENT at the short placement half-life with source "placement"
 * (inferred, self-correcting); the frontier node gets a `repetition: 0` seed;
 * nothing above gets a row.
 *
 * UPSERT, NEVER DOWNGRADE (finish-the-check-in, founder 2026-08-18). This used to
 * insert unconditionally, which was safe only while every finalize path was gated
 * on mastery EXISTENCE. Now that "mapped" means a converged run, a SHADOW-PLACED
 * domain — real `source: "practice"` rows, no run — reaches finalize for the first
 * time, and a blind insert would lay inferred rows on top of demonstrated ones.
 * `loadMastery` is last-row-wins, so those duplicates would SHADOW the earned
 * rows: `masteryOf` flips fluent → placed, `isFluent` goes false, the repetition-0
 * frontier seed lands on a node with real reps, `lastAttemptAt` / `becameFluentAt`
 * / `accelStreak` read as lost, `recordAttemptCore` patches the winning row and
 * strands the demonstrated one forever, and every `.collect()` rollup
 * double-counts. So: at most one row per (scholar, domain, skillKey), and a
 * placement credit may only ever RAISE what is already there.
 */
async function creditPlacementFrontiers(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  domain: string,
  frontiers: { strand: string; frontierKey: string | null; creditedKeys: string[] }[],
  loaded: {
    nodes: Doc<"knowledgeNodes">[];
    edges: { fromKey: string; toKey: string }[];
    nodeByKey: Map<string, Doc<"knowledgeNodes">>;
  },
  now: number,
): Promise<{ placedThroughGrade: string | null; fluentCount: number; frontierSkills: string[] }> {
  const { nodes, edges, nodeByKey } = loaded;
  const existingByKey = await loadMastery(ctx, scholarId, domain);
  const creditedSet = new Set<string>();
  let fluentCount = 0;
  for (const f of frontiers) {
    for (const key of f.creditedKeys) {
      const existing = existingByKey.get(key);
      if (!existing) {
        await ctx.db.insert("practiceMastery", {
          scholarId,
          skillKey: key,
          domain,
          strand: nodeByKey.get(key)?.strand,
          repetition: FLUENT_REPS,
          halfLifeDays: PLACEMENT_HALF_LIFE_DAYS,
          lastPracticedAt: now,
          frontier: false,
          source: "placement",
          updatedAt: now,
        });
      } else {
        // RAISE-ONLY, AND NEVER MINT DEMONSTRATED FLUENCY. Placement offers one
        // thing: inferred access credit at FLUENT_REPS on the short leash. It may
        // lift a row that sits below that, and nothing else:
        //   • An already-access-proven row (`repetition >= FLUENT_REPS`) is left
        //     ENTIRELY alone on the axes that read as green — this is the earned
        //     mastery the earlier fix protects: a demonstrated fluent row must
        //     never be downgraded to inferred "placed" by a search, so its
        //     `source` and reps are untouched.
        //   • A BELOW-fluent row is lifted to the fluent rep floor so the map
        //     stops treating it as a gap — but because a SEARCH (not a
        //     demonstrated attempt) supplied those reps, its provenance becomes
        //     inferred (`source: "placement"`) so `isFluent` stays false and it
        //     reads provisional "placed", self-correcting the instant the scholar
        //     next practises it. Keeping `source: "practice"` while raising reps
        //     to FLUENT_REPS would manufacture demonstrated fluency out of
        //     inference — a once-practised node turning green — which rule 4
        //     forbids. A row that is already inferred stays inferred; nothing here
        //     can RAISE provenance.
        //   • `lastPracticedAt` is NOT re-stamped (the scholar answered a probe
        //     elsewhere in the strand, not on THIS node), and the monotonic +
        //     demonstrated-only fields (`lastAttemptAt`, `becameFluentAt`,
        //     `frontierAdvancedAt`, `accelStreak`, `missStreak`, latency samples)
        //     are never touched — a later real demonstration is not erased.
        //   • `frontier` is left alone here — the whole-domain recompute below is
        //     its authority.
        const patch: Partial<Doc<"practiceMastery">> = {};
        if (existing.repetition < FLUENT_REPS) {
          patch.repetition = FLUENT_REPS;
          // Inference must not read as demonstrated: a below-fluent demonstrated
          // row lifted to the fluent floor by the search becomes provisional
          // (never green). An already-inferred row keeps its inferred source.
          if (isDemonstratedSource(existing.source)) patch.source = "placement";
        }
        if (existing.halfLifeDays < PLACEMENT_HALF_LIFE_DAYS) {
          patch.halfLifeDays = PLACEMENT_HALF_LIFE_DAYS;
        }
        if (Object.keys(patch).length > 0) {
          await ctx.db.patch(existing._id, { ...patch, updatedAt: now });
        }
      }
      creditedSet.add(key);
      fluentCount++;
      await maybeFireSeeds(ctx, scholarId, key);
    }
    // The "you are here" seed for the frontier node. SKIPPED when a row already
    // exists: it would reset real reps to 0 and a 0-day half-life, which is the
    // sharpest downgrade in this function. Nothing is lost — the row already
    // marks the node, and the frontier FLAG is recomputed for every row below.
    if (f.frontierKey && !existingByKey.has(f.frontierKey)) {
      await ctx.db.insert("practiceMastery", {
        scholarId,
        skillKey: f.frontierKey,
        domain,
        strand: nodeByKey.get(f.frontierKey)?.strand,
        repetition: 0,
        halfLifeDays: 0,
        frontier: true,
        source: "placement",
        updatedAt: now,
      });
    }
  }

  // Recompute the denormalized frontier flag across the whole domain (a
  // strand's frontier can still be gated by a cross-strand prerequisite).
  const mastery = await loadMastery(ctx, scholarId, domain);
  const stateOf = await buildFrontierStateOf(ctx, scholarId, nodes.map((s) => s.nodeKey), edges, mastery);
  const frontier = computeFrontier(nodes.map((s) => s.nodeKey), edges, stateOf);
  const frontierSet = new Set(frontier);
  for (const row of mastery.values()) {
    const shouldBe = frontierSet.has(row.skillKey);
    if (row.frontier !== shouldBe) await ctx.db.patch(row._id, { frontier: shouldBe });
  }

  return {
    placedThroughGrade: derivePlacedThroughGrade(creditedSet, nodes),
    fluentCount,
    frontierSkills: frontier,
  };
}

// ── Placement v2 — server-authoritative one-item-at-a-time loop ─────────────
// The shipping single-round UIs defeated the adaptive engine (one midpoint probe
// per strand, then submit). This loop puts the SERVER in charge: it serves ONE
// probe at a time (round-robin across unconverged strands so the kid never grinds
// one topic), grades each answer server-side, appends to the resumable probe log,
// and finalizes with `creditPlacementFrontiers` (identical mastery-crediting to
// the legacy path) once every strand converges or a cap is hit. "Don't Know" is a
// first-class ternary outcome — it caps the ceiling like a miss but is logged
// distinctly and never classified as an error.

/** Reconstruct the accumulated binary outcomes + per-strand answered counts from
 *  a placement row's ternary probe log. */
function outcomesFromProbeLog(
  log: { nodeKey: string; strand: string; outcome: string }[] | undefined,
): { outcomes: ProbeOutcome[]; answeredByStrand: Map<string, number> } {
  const outcomes: ProbeOutcome[] = [];
  const answeredByStrand = new Map<string, number>();
  for (const e of log ?? []) {
    outcomes.push(probeOutcomeFromKind(e.nodeKey, e.outcome as PlacementOutcomeKind));
    answeredByStrand.set(e.strand, (answeredByStrand.get(e.strand) ?? 0) + 1);
  }
  return { outcomes, answeredByStrand };
}

/**
 * Select the NEXT probe to serve: round-robin across strands that still have a
 * probe left, preferring the least-answered strand (ties broken by strand order)
 * so a kid never grinds one topic. Returns null when every strand has converged
 * (→ finalize). The FIRST probe of a fresh strand is anchored affect-safely to
 * the scholar's grade (or ~1/3 up the strand).
 */
function selectNextProbe(
  orders: StrandOrder[],
  isProbeable: (key: string) => boolean,
  outcomes: ProbeOutcome[],
  floors: Map<string, number>,
  answeredByStrand: Map<string, number>,
  firstTargetByStrand: Map<string, number>,
  gradeOf?: (key: string) => string | undefined,
  scholarGrade?: string,
): { strand: string; probeKey: string; index: number } | null {
  const candidates: { strand: string; probeKey: string; index: number; pendingConfirm: boolean; answered: number; ord: number }[] = [];
  orders.forEach((o, ord) => {
    const probe = nextStrandProbe(o.orderedKeys, isProbeable, outcomes, {
      resumeFloor: floors.get(o.strand) ?? 0,
      firstProbeTarget: firstTargetByStrand.get(o.strand),
      gradeOf,
      scholarGrade,
    });
    if (probe) {
      candidates.push({
        strand: o.strand,
        probeKey: probe.probeKey,
        index: probe.index,
        pendingConfirm: probe.pendingConfirm,
        answered: answeredByStrand.get(o.strand) ?? 0,
        ord,
      });
    }
  });
  if (candidates.length === 0) return null;
  // A pending confirm (an unconfirmed slip awaiting a fresh item on the same
  // skill) is resolved before any other strand's probe; otherwise least-answered
  // strand leads so a kid never grinds one topic.
  candidates.sort(
    (a, b) =>
      (a.pendingConfirm === b.pendingConfirm ? 0 : a.pendingConfirm ? -1 : 1) ||
      a.answered - b.answered ||
      a.ord - b.ord,
  );
  const c = candidates[0];
  return { strand: c.strand, probeKey: c.probeKey, index: c.index };
}

/** A scholar's chronological grade tag, for the affect-safe first probe. */
async function scholarGradeLevel(ctx: QueryCtx | MutationCtx, scholarId: Id<"users">): Promise<string | undefined> {
  const u = await ctx.db.get(scholarId);
  return u?.gradeLevel ?? undefined;
}

/** Build the per-strand affect-safe first-probe targets for a domain. */
function firstProbeTargets(
  orders: StrandOrder[],
  nodeByKey: Map<string, Doc<"knowledgeNodes">>,
  scholarGrade: string | undefined,
): Map<string, number> {
  const gradeOf = (key: string): string | undefined => nodeByKey.get(key)?.grade;
  const out = new Map<string, number>();
  for (const o of orders) {
    out.set(o.strand, affectSafeFirstProbeIndex(o.orderedKeys, { gradeOf, scholarGrade }));
  }
  return out;
}

/** The client-facing placement probe wire shape — the stem + input metadata,
 *  NEVER the answer. A MANIPULATIVE probe additionally carries its
 *  `manipulativeSpec` so the shared manipulative stage can render it. */
type PlacementProbeWire = {
  itemId: string;
  skillKey: string;
  strand: string;
  grade: string;
  stem: string;
  answerType: string;
  /** The measurement unit the probe must be answered in, in DISPLAY form
   *  ("cm³") — same non-leaky echo the drill serves (the stem already names it
   *  in words). Absent ⇒ a unit-free item. */
  answerUnit?: string;
  choices?: string[];
  promptVisual?: ServedItem["promptVisual"];
  manipulativeSpec?: string;
  /** "twoD" when the answer is a single fraction / buildable expression, so the
   *  client opens the direct-manipulation box editor (with the fraction / power / root
   *  glyph keys) instead of a plain field — the SAME non-leaky derivation the
   *  session runs. Absent ⇒ a flat typed answer. */
  answerShape?: string;
};

/** The mixed check-in probe wire shape — a placement probe tagged with its
 *  domain (the per-item domain chip, #553). */
type MixedProbeWire = PlacementProbeWire & { domain: string; domainLabel: string };

/** A persisted placement served probe (the row's `servedProbe`). */
type ServedProbe = NonNullable<Doc<"practicePlacements">["servedProbe"]>;

/**
 * Resolve a persisted placement `servedProbe` to its client-facing wire shape
 * (stem only — the answer is NEVER sent). Dispatches on the served item kind
 * through the SHARED servable builders (U-1/U-2), so placement serves the full
 * item union:
 *   • TEMPLATE (default / a legacy row with no `kind`) — regenerated from the
 *     deterministic engine (`buildTemplateServable`, nodeKey + seed).
 *   • MANIPULATIVE (`kind: "manipulative"`) — its curated `practiceItems` row
 *     resolved via `buildStoredServable`, carrying `manipulativeSpec` for the
 *     client stage.
 * Returns null when the item can't be resolved (a since-deleted manipulative
 * row, or a template the engine no longer generates) — the caller re-primes,
 * exactly as the old `generateItem`-returns-null path did.
 */
async function resolvePlacementProbe(
  ctx: QueryCtx | MutationCtx,
  served: ServedProbe,
  nodeByKey: Map<string, Doc<"knowledgeNodes">>,
  domain: string,
): Promise<PlacementProbeWire | null> {
  const node = nodeByKey.get(served.nodeKey) ?? null;
  const grade = node?.grade ?? "";
  const nodeInfo = { label: node?.label, domain };

  let item: ServableItem | null;
  if (served.kind === MANIPULATIVE_VERIFIER_KIND && served.ref) {
    let doc: Doc<"practiceItems"> | null = null;
    try {
      doc = await ctx.db.get(served.ref);
    } catch {
      doc = null; // a malformed / stale ref — treat as unresolvable, re-prime
    }
    if (!doc || doc.verifierKind !== MANIPULATIVE_VERIFIER_KIND) return null;
    item = buildStoredServable(served.itemId, doc, nodeInfo, domain);
  } else {
    // Template (or a legacy row with no kind) — the id is "nodeKey#seed".
    item = buildTemplateServable(served.itemId, nodeInfo, domain);
  }
  if (!item) return null;
  // Reuse the SAME ServableItem→ServedItem adapter the session serves through,
  // so a fraction placement probe opens the 2-D box editor (fraction glyph key)
  // exactly like a fraction practice item. Only `answerShape` is threaded — the
  // client builds the fraction from an EMPTY editor (the answer's skeleton is
  // never leaked), so `answerFormat` is deliberately withheld.
  const servedItem = servedItemFromServable(item, false);
  return {
    itemId: item.itemId,
    skillKey: item.skillKey,
    strand: served.strand,
    grade,
    stem: item.prompt.stem,
    answerType: item.prompt.answerType,
    ...(item.prompt.answerUnit ? { answerUnit: item.prompt.answerUnit } : {}),
    ...(item.prompt.choices ? { choices: item.prompt.choices } : {}),
    ...(item.prompt.promptVisual ? { promptVisual: item.prompt.promptVisual } : {}),
    ...(item.prompt.manipulativeSpec ? { manipulativeSpec: item.prompt.manipulativeSpec } : {}),
    ...(servedItem.answerShape ? { answerShape: servedItem.answerShape } : {}),
  };
}

/** How many manipulative probes MAY be served across ONE check-in (K = 3, Andy).
 *  A manipulative probe REPLACES the template at its node — it counts toward the
 *  per-strand (5) and global (25) caps like any probe, never in addition. */
export const MAX_MANIPULATIVE_PROBES_PER_CHECKIN = 3;

/** Length cap for a manipulative probe's submitted state stored on the probe log
 *  (`answerRaw`). Manipulative states are small (a few disc/plate arrays); this
 *  bounds DB size without truncating a real one. Unlike a template answer it is
 *  NOT stripped/reshaped — it stays structurally intact JSON. */
const MAX_MANIPULATIVE_STATE_LEN = 4096;

/** Teacher-facing attempt text. Multiple-choice submissions travel over the
 * wire as zero-based indexes, but every downstream surface needs the label. */
function attemptAnswerText(
  item: ServableItem,
  answer: string | undefined,
): string | undefined {
  if (answer === undefined) return undefined;
  if (item.kind === "manipulative") {
    return answer.slice(0, MAX_MANIPULATIVE_STATE_LEN);
  }

  const sanitized = sanitizePlacementAnswer(answer);
  if (item.prompt.answerType !== "multipleChoice" || sanitized === undefined) {
    return sanitized;
  }
  const parsed = parseAnswer(sanitized, "multipleChoice");
  if (parsed?.type !== "multipleChoice") return sanitized;
  const label = item.prompt.choices?.[parsed.choiceIndex]?.trim();
  return label
    ? sanitizePlacementAnswer(
        formatAnswerForDisplay(parsed, item.prompt.choices),
      )
    : sanitized;
}

/** Manipulative probes already served (answered) in a probe log. A placement
 *  probe's `itemId` is `gen#<id>` iff it was a manipulative — placement only ever
 *  serves a template ("nodeKey#seed") or a manipulative ("gen#<id>"), so the
 *  prefix is an unambiguous discriminator without a probeLog schema change. */
function manipulativeProbesInLog(log: { itemId?: string }[] | undefined): number {
  let n = 0;
  for (const e of log ?? []) if (e.itemId?.startsWith("gen#")) n++;
  return n;
}

/** TEMPLATE probes already served in one strand of a probe log. The affect-safe
 *  first probe of every strand is a template, so `>= 1` here is exactly "this
 *  strand has already opened on a template" — the gate for swapping in a
 *  manipulative on a later probe of the strand. */
function templateProbesInStrand(
  log: { strand: string; itemId?: string }[] | undefined,
  strand: string,
): number {
  let n = 0;
  for (const e of log ?? []) if (e.strand === strand && !e.itemId?.startsWith("gen#")) n++;
  return n;
}

/**
 * Build the `servedProbe` for a selected probe node — the point where placement
 * chooses between the fast TEMPLATE and a curated MANIPULATIVE. Prefer the
 * template (latency-comparable); swap in the node's stored manipulative iff ALL
 * of these hold (deterministic given the accumulated row state):
 *   (a) the node has a curated manipulative `practiceItems` row,
 *   (b) fewer than K = 3 manipulative probes have been served this check-in
 *       (`manipulativesServed`, counted across ALL domains for a mixed check-in),
 *   (c) the node's strand has already served ≥1 TEMPLATE probe
 *       (`strandTemplateProbes` — the affect-safe first probe stays a template).
 * REPLACEMENT, not addition: the manipulative IS the probe for that node, so it
 * still counts against the per-strand + global caps (it is one probeLog entry).
 * `strandSeedKey` is the per-probe seed namespace (the strand for a single-domain
 * placement; `"<domain>\u0000<strand>"` for the mixed check-in).
 */
async function buildServedProbe(
  ctx: QueryCtx | MutationCtx,
  selected: { strand: string; probeKey: string; index: number },
  baseSeed: number,
  strandSeedKey: string,
  opts: { manipulativesServed: number; strandTemplateProbes: number; attempt?: number },
): Promise<ServedProbe> {
  // A CONFIRM (`attempt >= 1`) must serve a FRESH item on the same skill, never
  // the identical problem — the client seed is stable across a sitting, so the
  // per-node attempt count is folded into the seed here so the retry can't be
  // brute-forced and isn't the same stem the scholar just slipped on. `attempt`
  // 0 (every ordinary first probe) keeps the exact prior seed — serve-equivalence
  // for the honest path is unchanged.
  const attempt = opts.attempt ?? 0;
  const baseProbeSeed = probeSeed(baseSeed, strandSeedKey, selected.index);
  const seed =
    attempt > 0 ? (Math.imul(baseProbeSeed ^ (attempt * 0x9e3779b1), 2654435761) >>> 0) : baseProbeSeed;
  const templateProbe: ServedProbe = {
    nodeKey: selected.probeKey,
    strand: selected.strand,
    itemId: makeItemId(selected.probeKey, seed),
    seed,
    kind: "template",
  };
  if (opts.manipulativesServed >= MAX_MANIPULATIVE_PROBES_PER_CHECKIN) return templateProbe;
  if (opts.strandTemplateProbes < 1) return templateProbe; // affect-safe first probe stays template
  // Bounded scan rather than `.first()`: a row whose spec kind has been RETIRED
  // is unrenderable, and `buildStoredServable` now refuses it — but refusing at
  // serve time only makes the probe unresolvable, and the re-prime would pick
  // the very same row again. Skip such rows at SELECTION so the probe degrades
  // cleanly to a template instead of looping. (Prod held exactly this: two
  // `factorGame` rows on `factors_and_multiples`/`prime_composite`, the latter's
  // ONLY manipulative — see migrations:purgeRetiredKindManipulatives.)
  const manipCandidates = await ctx.db
    .query("practiceItems")
    .withIndex("by_skill", (q) => q.eq("skillKey", selected.probeKey))
    .filter((q) => q.eq(q.field("verifierKind"), MANIPULATIVE_VERIFIER_KIND))
    .take(8);
  const manip = manipCandidates.find((row) => {
    const spec = parseManipulativeSpec(row.manipulativeSpec);
    return (
      !spec ||
      (isCurrentManipulativeKind(spec.kind) &&
        !isRetiredManipulativeSpecId(spec.id))
    );
  });
  if (!manip) return templateProbe;
  return {
    nodeKey: selected.probeKey,
    strand: selected.strand,
    itemId: `gen#${manip._id}`,
    seed,
    kind: MANIPULATIVE_VERIFIER_KIND,
    ref: manip._id,
  };
}

/**
 * The CURRENT placement probe (placement v2), read-only. Returns the probe the
 * server is currently holding in front of the scholar (regenerated stem — never
 * the answer), plus progress. `probe: null` with `needsStart: true` means no probe
 * has been served yet (a brand-new scholar, or a reload before priming) — the
 * client calls `submitPlacementAnswer` with NO answer to prime one (a query can't
 * persist). `done: true` means placement is already complete.
 */
export const placementCurrent = authedQuery({
  args: { scholarId: v.id("users"), domain: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const domain = args.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN;
    const { orders, nodeByKey, isProbeable } = await loadPlacementContext(ctx, domain);
    const row = await ctx.db
      .query("practicePlacements")
      .withIndex("by_scholar_domain", (q) => q.eq("scholarId", args.scholarId).eq("domain", domain))
      .first();
    const totalStrands = new Set([...nodeByKey.values()].map((n) => n.strand ?? DEFAULT_PLACEMENT_STRAND)).size;
    const maxQuestions = placementQuestionCap(
      orders.map((order) => order.orderedKeys.filter(isProbeable).length),
    );
    if (row?.status === "complete") {
      // Re-derive the soft "placed through" grade from the placement-credited
      // mastery (source "placement", non-frontier, ACCESS-PROVEN = the fully-credited
      // fluent set — the SAME set `creditPlacementFrontiers` fed to
      // `derivePlacedThroughGrade` at finalize; the `accessProven` guard drops a
      // repetition-0 frontier seed whose flag was later recomputed to false, which
      // would otherwise be miscounted as credit). This lets a client that boots over
      // an ALREADY-COMPLETE placement (a mid-flow remount, or a reload after
      // finishing) paint the RESULT screen ("You're starting at: <skill>") instead of
      // the intro — re-running a done placement must be impossible. The scholar-facing
      // anchor is the SKILL-anchored `startingSkillLabel` (J3); `placedThroughGrade`
      // stays on the wire for teacher-facing / scheduling use only. Best-effort: null
      // when nothing was credited / no labelled frontier.
      const placementMastery = await ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar_domain", (q) =>
          q.eq("scholarId", args.scholarId).eq("domain", domain),
        )
        .collect();
      const creditedSet = new Set(
        placementMastery
          .filter((m) => m.source === "placement" && !m.frontier && accessProven(m))
          .map((m) => m.skillKey),
      );
      const placedThroughGrade = derivePlacedThroughGrade(creditedSet, [...nodeByKey.values()]);
      const startingSkillLabel = startingSkillLabelFromMastery(placementMastery, nodeByKey);
      return {
        done: true,
        needsStart: false,
        probe: null,
        answered: row.probesAnswered ?? 0,
        totalStrands,
        maxQuestions,
        placedThroughGrade,
        startingSkillLabel,
      };
    }
    if (!row?.servedProbe) {
      return {
        done: false,
        needsStart: true,
        probe: null,
        answered: row?.probesAnswered ?? 0,
        totalStrands,
        maxQuestions,
        placedThroughGrade: null as string | null,
        startingSkillLabel: null as string | null,
      };
    }
    const probe = await resolvePlacementProbe(ctx, row.servedProbe, nodeByKey, domain);
    return {
      done: false,
      needsStart: probe === null,
      probe,
      answered: row.probesAnswered ?? 0,
      totalStrands,
      maxQuestions,
      placedThroughGrade: null as string | null,
      startingSkillLabel: null as string | null,
    };
  },
});

/**
 * Grade one placement answer (or PRIME the first/next probe) — the driver of the
 * placement-v2 loop. With no `itemId`/`outcome`, it PRIMES: ensures a row + a
 * served probe and returns it (no grading — this is the "start"/resume call a
 * query can't make). With an answer, it grades the served probe server-side
 * (ternary: correct | incorrect | unknown), appends to the probe log, selects +
 * persists the next probe (round-robin across unconverged strands), and finalizes
 * — crediting mastery via the SHARED `creditPlacementFrontiers` — once every strand
 * converges or the global cap is hit. Idempotent once the run has CONVERGED
 * (mastery existence alone is shadow placement, and is still placeable).
 */
export const submitPlacementAnswer = authedMutation({
  args: {
    scholarId: v.id("users"),
    domain: v.optional(v.string()),
    seed: v.number(),
    // Absent `itemId` = PRIME (return the current/first probe without grading).
    // Present = grade the served probe. The SERVER derives correct/incorrect by
    // grading `answer` against the served probe (anti-cheat — the answer was
    // never sent to the client); `dontKnow` is the only client-authored signal,
    // an honest "I haven't learned this yet" → the `unknown` ternary outcome.
    itemId: v.optional(v.string()),
    answer: v.optional(v.string()),
    dontKnow: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const domain = args.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN;
    const now = Date.now();

    const { nodes, edges, impliesEdges, orders, nodeByKey, isProbeable } = await loadPlacementContext(ctx, domain);
    const scholarGrade = await scholarGradeLevel(ctx, args.scholarId);
    // COLD-ENTRY GRADE PRIOR (You-Pick fix, CALIBRATION_REPORT.md): a domain
    // cold-picked with NO chronological grade otherwise opens its first probe
    // ~1/3 up each strand — 3–5 grades above a young scholar (pilot9 #6: a
    // grade-2 kid opened on formal angles). Fall back to the domain's
    // foundational FLOOR grade so the first probe anchors at the foundation and
    // trust-upward climbs. Mirroring the MIXED path's start/ceiling split
    // (the check-in's `gradeFor` start/ceiling split): the floor LIFTS the
    // first-probe target only — the
    // affect-safe ring CEILING stays tied to the scholar's REAL grade
    // (`scholarGrade`, undefined here → the ring is bounded by real misses, never
    // by an inferred floor). This never strands a genuinely higher-grade
    // cold-picker below their level. An accurate chronological grade always wins;
    // a domain with no grade tags yields an undefined floor (behavior unchanged).
    const startGrade = scholarGrade ?? domainFloorGrade(nodeByKey.values());
    const firstTargets = firstProbeTargets(orders, nodeByKey, startGrade);
    const gradeOf = (key: string): string | undefined => nodeByKey.get(key)?.grade;

    let row = await ctx.db
      .query("practicePlacements")
      .withIndex("by_scholar_domain", (q) => q.eq("scholarId", args.scholarId).eq("domain", domain))
      .first();

    // Guard: don't re-place a domain whose run already CONVERGED. It used to
    // guard on mastery existence, which made a shadow-placed domain (mastery
    // rows, no converged run) unplaceable — finish-the-check-in, founder
    // 2026-08-18, rules that mastery is not a map.
    if (row?.status === "complete") {
      return { alreadyPlaced: true, done: true, graded: null, probe: null, placedThroughGrade: null as string | null, startingSkillLabel: null as string | null };
    }

    // INFERENCE-ONLY `implies` diagnostic floors: a demonstrated cross-domain
    // source credits (and skips the probe for) its target entrance here. Computed
    // once, merged into every floor read below (resume floors ∪ implied floors).
    const impliedFloors = await impliedPlacementFloors(
      ctx,
      args.scholarId,
      impliesEdges,
      orders,
      nodeByKey,
    );

    // A deliberate single-domain entry may always open its own domain: the
    // one-run-per-scholar cap that used to refuse here is gone with breadth-first
    // serving (finish-the-check-in, founder 2026-08-18), so a scholar may hold
    // several in-progress rows and each resumes independently.

    const floorsFromRow = (): Map<string, number> => {
      const floors = new Map<string, number>();
      const orderByStrand = new Map(orders.map((o) => [o.strand, o.orderedKeys]));
      for (const { strand, frontierKey } of row?.frontierByStrand ?? []) {
        const ordered = orderByStrand.get(strand);
        if (!ordered) continue;
        const idx = ordered.indexOf(frontierKey);
        if (idx >= 0) floors.set(strand, idx);
      }
      return mergeFloors(floors, impliedFloors);
    };

    const persistServed = async (
      served: { strand: string; probeKey: string; index: number } | null,
      probeLog: NonNullable<Doc<"practicePlacements">["probeLog"]>,
    ) => {
      let servedProbe: Doc<"practicePlacements">["servedProbe"] = undefined;
      let probe: PlacementProbeWire | null = null;
      if (served) {
        // Choose the served item (template vs. curated manipulative) from the
        // accumulated log — K=3 across the check-in (single domain here),
        // affect-safe first probe per strand stays a template.
        servedProbe = await buildServedProbe(ctx, served, args.seed, served.strand, {
          manipulativesServed: manipulativeProbesInLog(probeLog),
          strandTemplateProbes: templateProbesInStrand(probeLog, served.strand),
          // A confirm re-serves a node that already has an outcome — perturb the
          // seed so the retry is a FRESH item, not the identical stem.
          attempt: probeLog.filter((e) => e.nodeKey === served.probeKey).length,
        });
        probe = await resolvePlacementProbe(ctx, servedProbe, nodeByKey, domain);
      }
      const fields = {
        probesAnswered: probeLog.length,
        probeLog,
        servedProbe,
        updatedAt: now,
      };
      if (row) await ctx.db.patch(row._id, fields);
      else {
        const id = await ctx.db.insert("practicePlacements", {
          scholarId: args.scholarId,
          domain,
          status: "in_progress",
          ...fields,
        });
        row = await ctx.db.get(id);
      }
      return probe;
    };

    // FINALIZE — every strand converged (or a cap hit): persist the complete row
    // and credit mastery. Shared by BOTH the prime path (a fresh scholar whose
    // domain has nothing probeable) and the grade path, so neither can strand a
    // row at "in_progress" with no probe left to serve.
    const finalize = async (
      log: NonNullable<Doc<"practicePlacements">["probeLog"]>,
      outcomes: ProbeOutcome[],
      floors: Map<string, number>,
    ): Promise<{ placedThroughGrade: string | null; startingSkillLabel: string | null }> => {
      const frontiers = orders.map((o) =>
        strandFrontier(o.strand, o.orderedKeys, outcomes, floors.get(o.strand) ?? 0),
      );
      const frontierByStrand = frontiers
        .filter((f) => f.frontierKey !== null)
        .map((f) => ({ strand: f.strand, frontierKey: f.frontierKey! }));
      const finalFields = {
        status: "complete" as const,
        probesAnswered: log.length,
        probeLog: log,
        servedProbe: undefined,
        frontierByStrand,
        updatedAt: now,
      };
      if (row) await ctx.db.patch(row._id, finalFields);
      else await ctx.db.insert("practicePlacements", { scholarId: args.scholarId, domain, ...finalFields });
      const credited = await creditPlacementFrontiers(
        ctx,
        args.scholarId,
        domain,
        frontiers,
        { nodes, edges, nodeByKey },
        now,
      );
      // The SKILL-anchored end anchor (J3): name the scholar's leading frontier —
      // the SAME recomputed "you are here" set the Tree uses — never a grade.
      const startingSkillLabel = pickStartingSkillLabel(
        credited.frontierSkills.map((k) => ({
          skillKey: k,
          label: nodeByKey.get(k)?.label,
          grade: nodeByKey.get(k)?.grade,
        })),
      );
      return { placedThroughGrade: credited.placedThroughGrade, startingSkillLabel };
    };

    // ── PRIME: ensure a served probe exists; return it. If nothing is left to
    //    probe (converged already / nothing probeable), FINALIZE — mirroring the
    //    grade path — so the scholar never bounces back into placement. ──
    if (!args.itemId) {
      if (row?.servedProbe) {
        const probe = await resolvePlacementProbe(ctx, row.servedProbe, nodeByKey, domain);
        // A parked probe that no longer resolves (content removed since it was
        // served) falls through to serve a fresh one — returning `probe: null`
        // here stranded resumed placements on a blank screen (2026-08-18).
        if (probe) {
          return {
            alreadyPlaced: false,
            done: false,
            graded: null,
            probe,
            placedThroughGrade: null as string | null,
            startingSkillLabel: null as string | null,
          };
        }
      }
      const log = row?.probeLog ?? [];
      const { outcomes, answeredByStrand } = outcomesFromProbeLog(log);
      const floors = floorsFromRow();
      const next = selectNextProbe(
        orders,
        isProbeable,
        outcomes,
        floors,
        answeredByStrand,
        firstTargets,
        gradeOf,
        scholarGrade,
      );
      if (next === null) {
        return { alreadyPlaced: false, done: true, graded: null, probe: null, ...(await finalize(log, outcomes, floors)) };
      }
      const probe = await persistServed(next, log);
      return { alreadyPlaced: false, done: false, graded: null, probe, placedThroughGrade: null as string | null, startingSkillLabel: null as string | null };
    }

    // ── GRADE: the answer must be for the CURRENTLY-served probe. A stale or
    //    duplicate submit (itemId ≠ served — e.g. a network retry after the
    //    server already advanced, or a submit after a reload re-served) is an
    //    idempotent NO-OP: nothing is logged/graded; the caller gets the current
    //    probe back and re-renders. A grade with NO served probe at all (e.g.
    //    after finalize) re-primes the same way. ──
    const served = row?.servedProbe;
    // Resolve the parked probe's render ONCE, before deciding whether this
    // submit matches it. A parked probe whose content died (a reseed removed
    // its node/template/item) must take the stale-submit no-op path even when
    // the itemId MATCHES — `resolveServableItem` below throws on it, which
    // strands the client on its "submitting" screen (review finding,
    // 2026-08-18).
    const servedWire = served
      ? await resolvePlacementProbe(ctx, served, nodeByKey, domain)
      : null;
    if (!served || servedWire === null || served.itemId !== args.itemId) {
      const log = row?.probeLog ?? [];
      const { outcomes, answeredByStrand } = outcomesFromProbeLog(log);
      const floors = floorsFromRow();
      // A LIVE parked probe with a mismatched submit → idempotent no-op echo.
      // A dead one falls through to serve a fresh probe instead (the PRIME
      // path's escape).
      if (servedWire) {
        return {
          alreadyPlaced: false,
          done: false,
          graded: null,
          probe: servedWire,
          placedThroughGrade: null as string | null,
          startingSkillLabel: null as string | null,
        };
      }
      const next = selectNextProbe(
        orders,
        isProbeable,
        outcomes,
        floors,
        answeredByStrand,
        firstTargets,
        gradeOf,
        scholarGrade,
      );
      if (next === null) {
        return { alreadyPlaced: false, done: true, graded: null, probe: null, ...(await finalize(log, outcomes, floors)) };
      }
      const probe = await persistServed(next, log);
      return { alreadyPlaced: false, done: false, graded: null, probe, placedThroughGrade: null as string | null, startingSkillLabel: null as string | null };
    }

    // Resolve the CURRENTLY-served probe to a unified ServableItem (template or
    // manipulative) and grade it through the shared dispatcher under the
    // PLACEMENT policy: ternary outcomes (dontKnow → unknown), reveal the answer
    // on a template miss+correct (locked measurement), a MANIPULATIVE grades via
    // isSolved and never reveals. Placement drives its own side effects below —
    // the policy records nothing.
    const item = await resolveServableItem(ctx, served.itemId, domain);

    // The stored `answerRaw`: a TEMPLATE typed answer is sanitized + hard-capped
    // (short numeric/fraction/expression); a MANIPULATIVE's submitted state is
    // opaque JSON kept intact (length-bounded only).
    const rawAnswer =
      item.kind === "manipulative"
        ? args.answer !== undefined
          ? args.answer.slice(0, MAX_MANIPULATIVE_STATE_LEN)
          : undefined
        : sanitizePlacementAnswer(args.answer);
    const answerText = args.dontKnow
      ? undefined
      : attemptAnswerText(item, args.answer);

    const submission: Submission = args.dontKnow
      ? { kind: "dontKnow" }
      : item.kind === "manipulative"
        ? { kind: "manipulativeState", stateJson: args.answer ?? "" }
        : { kind: "typed", raw: rawAnswer ?? "" };
    const grade = gradeSubmission(item, submission, PLACEMENT_POLICY);
    const correctAnswer = grade.revealedAnswer;
    const kind: PlacementOutcomeKind = grade.isDontKnow
      ? "unknown"
      : grade.correct
        ? "correct"
        : "incorrect";
    const explanationReason =
      kind === "correct" ? undefined : kind === "unknown" ? "dont_know" : "miss";
    await ctx.db.insert("practiceAttempts", {
      scholarId: args.scholarId,
      nodeKey: served.nodeKey,
      itemId: served.itemId,
      correct: outcomeCredits(kind),
      ...(answerText !== undefined ? { answerText } : {}),
      ...(kind !== "correct"
        ? {
            ...(sanitizeStemSnapshot(grade.stem) !== undefined
              ? { stemSnapshot: sanitizeStemSnapshot(grade.stem) }
              : {}),
            ...(grade.correctAnswer
              ? { expectedAnswer: sanitizePlacementAnswer(grade.correctAnswer) }
              : {}),
          }
        : {}),
      domain,
      strand: served.strand,
      lane: "placement",
      breakerEligible: false,
      repetitionBefore: 0,
      source: "placement",
      ...(explanationReason
        ? { explanationReason, explanationRequestedAt: now }
        : {}),
      createdAt: now,
    });

    const log = [
      ...(row?.probeLog ?? []),
      {
        nodeKey: served.nodeKey,
        strand: served.strand,
        outcome: kind,
        at: now,
        ...(rawAnswer !== undefined ? { answerRaw: rawAnswer } : {}),
        // Persist the served item id — the reveal-line builder and the
        // manipulative-probe cap (`gen#` prefix) both key off it, and legacy
        // rows without one still resolve.
        itemId: served.itemId,
      },
    ];
    // The just-appended entry's index — seeds the Tier-2 reveal-line rotation.
    const probeLogIndex = log.length - 1;

    // The placement warmth floor: a warm, deterministic reveal line on a miss /
    // "I haven't learned this yet" (never on a correct answer — that gets the
    // affirmation). NEVER empty (Tier-2 fallback). No live LLM.
    const revealLine =
      kind === "correct"
        ? undefined
        : placementRevealLineFor(item, correctAnswer ?? null, probeLogIndex);

    const { outcomes, answeredByStrand } = outcomesFromProbeLog(log);
    const floors = floorsFromRow();
    const capHit = log.length >= PLACEMENT_GLOBAL_CAP;
    const next = capHit
      ? null
      : selectNextProbe(
          orders,
          isProbeable,
          outcomes,
          floors,
          answeredByStrand,
          firstTargets,
          gradeOf,
          scholarGrade,
        );

    // "Confirm before you cap": a FIRST typed miss on a node doesn't cap the
    // ceiling — the search re-serves a fresh item on the SAME skill. Flag it so
    // the scholar surface offers the two-way choice (retry as a slip, or concede
    // "I don't understand this yet" → cap now). Only when the next probe really is
    // that same node (never on a don't-know, never on a confirmed second miss).
    const firstMissOnNode =
      (row?.probeLog ?? []).every((e) => e.nodeKey !== served.nodeKey);
    const retry =
      kind === "incorrect" &&
      firstMissOnNode &&
      next !== null &&
      next.probeKey === served.nodeKey &&
      next.strand === served.strand;

    if (next !== null) {
      const probe = await persistServed(next, log);
      return {
        alreadyPlaced: false,
        done: false,
        graded: { outcome: kind, correctAnswer, revealLine, unitOutcome: grade.unitOutcome, retry },
        probe,
        placedThroughGrade: null as string | null,
        startingSkillLabel: null as string | null,
      };
    }

    return {
      alreadyPlaced: false,
      done: true,
      graded: { outcome: kind, correctAnswer, revealLine, unitOutcome: grade.unitOutcome, retry: false },
      probe: null,
      ...(await finalize(log, outcomes, floors)),
    };
  },
});

// ── Mixed multi-domain placement — the "Math Check-In" ─────────────────────
// Andy-approved (2026-07): the FIRST placement covers ALL registered practice
// domains, interleaved in ONE scholar-facing session, instead of whole-number-
// only with each later domain needing its own separately-initiated check-in.
// Evidence: a blind 5-day scholar pilot where a gifted 7yo wanted fractions all
// week and could never reach them (no second-placement initiator existed).
//
// UNDERNEATH, the per-(scholar, domain) `practicePlacements` rows + resumability
// are UNCHANGED: each domain still runs its own adaptive per-strand binary search
// (the exact `submitPlacementAnswer` machinery — loadPlacementContext,
// selectNextProbe, strandFrontier, creditPlacementFrontiers — reused here). This
// orchestrator adds only an ORDERING across domains — the same breadth-first
// policy the playlist's `· mapping` band serves (finish-the-check-in, founder
// 2026-08-18: `orderMappingCandidates`, pass 1 everywhere before pass 2, then
// foundational-first deepening). At any instant at most ONE domain's row holds a
// `servedProbe` (the probe in front of the scholar). It also delivers:
//   • FOLDING (phase 3): a domain whose run has CONVERGED is skipped, so a
//     partially-placed scholar (every current real scholar) gets ONLY the missing
//     domains folded into the flow — no chooser UI needed. Idempotent: a completed
//     domain never restarts.
//   • CROSS-DOMAIN INFERENCE (phase 2): a completed domain's discovered grade
//     lifts the grade PRIOR (first-probe target + ring ceiling) of the domains
//     still to be probed (higherGrade, lib/practice/placement.ts), so a G3
//     whole-number placement shortens the fraction probe instead of restarting
//     from zero. The prior only moves where the search STARTS; crediting still
//     flows through creditPlacementFrontiers at source "placement" (inferred,
//     provisional), so the two-axis invariant holds (no new green claim).

/** A seeded registered practice domain (registry ∩ PRACTICE_GRAPHS ∩ this
 *  deployment) with its loaded placement context. */
type MixedDomainCtx = {
  domain: string;
  label: string;
  loaded: Awaited<ReturnType<typeof loadPlacementContext>>;
  /** The OTHER seeded domains this one has a cross-domain `buildsOn` prerequisite
   *  into (e.g. fractions → whole-number-arithmetic via division_as_sharing;
   *  probability → fraction-arithmetic). The mixed check-in DEFERS probing this
   *  domain until every prereq domain here is placed (prereq-ordered probing). */
  prereqDomains: string[];
};

/** A scholar's live placement state in one domain: their mastery, the resumable
 *  placement row, and whether the domain is MAPPED — a CONVERGED placement run,
 *  never mastery-row existence (finish-the-check-in, founder 2026-08-18). A
 *  domain holding mastery with no converged run is SHADOW-PLACED: unmapped, and
 *  it gets searched. `hasMastery` is kept separately because "don't drill the
 *  frontier of a domain you haven't placed" is a different question from "is it
 *  on the map" — a shadow-placed domain has real work to serve. */
type MixedDomainRuntime = {
  mastery: Map<string, Doc<"practiceMastery">>;
  placementRow: Doc<"practicePlacements"> | null;
  hasMastery: boolean;
  done: boolean;
};

/** Load every registered domain that has seeded nodes on this deployment (in
 *  PRACTICE_DOMAINS display order), each with its placement context AND its
 *  cross-domain prerequisite domains (a foreign `buildsOn` source ⇒ a prereq
 *  domain, so the check-in can probe in prereq order). */
async function loadMixedPlacementDomains(
  ctx: QueryCtx | MutationCtx,
): Promise<MixedDomainCtx[]> {
  const loaded: { domain: string; label: string; loaded: Awaited<ReturnType<typeof loadPlacementContext>> }[] = [];
  for (const info of PRACTICE_DOMAINS) {
    const ctxLoaded = await loadPlacementContext(ctx, info.domain);
    if (ctxLoaded.nodes.length === 0) continue; // not seeded on this deployment
    loaded.push({ domain: info.domain, label: info.label, loaded: ctxLoaded });
  }
  // Global nodeKey → domain map (nodeKeys are globally unique — graphValidation).
  // A domain's edges are stamped with the TO-side domain, so a foreign FROM-side
  // node marks a cross-domain prerequisite into another (earlier) domain.
  const domainOfKey = new Map<string, string>();
  for (const d of loaded) for (const n of d.loaded.nodes) domainOfKey.set(n.nodeKey, d.domain);
  return loaded.map((d) => {
    const prereqDomains = new Set<string>();
    for (const e of d.loaded.edges) {
      const fromDomain = domainOfKey.get(e.fromKey);
      if (fromDomain && fromDomain !== d.domain) prereqDomains.add(fromDomain);
    }
    return { ...d, prereqDomains: [...prereqDomains] };
  });
}

/** Read a scholar's live placement runtime for one domain. MAPPED = a converged
 *  placement run; mastery alone is shadow placement and still needs searching. */
async function readMixedDomainRuntime(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  domain: string,
): Promise<MixedDomainRuntime> {
  const mastery = await loadMastery(ctx, scholarId, domain);
  const placementRow = await ctx.db
    .query("practicePlacements")
    .withIndex("by_scholar_domain", (q) =>
      q.eq("scholarId", scholarId).eq("domain", domain),
    )
    .first();
  return {
    mastery,
    placementRow,
    hasMastery: mastery.size > 0,
    done: placementRow?.status === "complete",
  };
}

/**
 * The ONE derivation (finish-the-check-in, founder 2026-08-18): classify every
 * seeded domain for this scholar — converged / in_flight / shadow_placed /
 * queued / available / ineligible — plus the N-of-M counts every surface reads.
 * Pure logic lives in `lib/practice/domainMapStatus.ts`; this is the ctx-free
 * adapter over an already-loaded runtime map, so a mutation that reloads a
 * domain mid-flight can re-derive without another round of reads.
 *
 * The DENOMINATOR is the grade-eligible set (`automaticPlacementGrade` — a
 * missing enrolled grade reads as the K ring, the most restrictive one). The
 * prereq DAG governs serving ORDER (`queued` vs `available`), never membership,
 * so M stays stable as prereqs converge instead of treadmilling upward.
 */
function summarizeScholarMap(
  domains: MixedDomainCtx[],
  runtime: Map<string, MixedDomainRuntime>,
  scholarGrade: string | undefined,
): ScholarMapSummary {
  const eligibilityGrade = automaticPlacementGrade(scholarGrade);
  return summarizeDomainMap(
    domains.map((d) => {
      const rt = runtime.get(d.domain);
      return {
        domain: d.domain,
        prereqDomains: d.prereqDomains,
        // An ELECTIVE domain is never grade-eligible regardless of tags — it
        // never joins M and is never auto-probed; it reaches scholars only
        // through the deliberate new-territory offer (reachable) below.
        gradeEligible:
          !ELECTIVE_PRACTICE_DOMAINS.has(d.domain) &&
          domainHasAffectSafeEntry(d.loaded.nodes, eligibilityGrade),
        placementStatus: rt?.placementRow?.status ?? null,
        answeredProbes: rt?.placementRow?.probeLog?.length ?? 0,
        hasMastery: rt?.hasMastery ?? false,
      };
    }),
    { gradeOnFile: scholarGrade !== undefined },
  );
}

/** Index a summary by domain so the serve paths can ask about one domain. */
function mapEntriesByDomain(summary: ScholarMapSummary): Map<string, DomainMapEntry> {
  return new Map(summary.perDomain.map((entry) => [entry.domain, entry]));
}

/** The per-strand resume floors carried by a placement row's `frontierByStrand`
 *  (a previously-confirmed floor across a paused/resumed diagnostic). Mirrors the
 *  single-domain `floorsFromRow` closure, hoisted so the mixed loop reuses it.
 *  NOTE: the mixed check-in deliberately does NOT fold in `implies` diagnostic
 *  floors — cross-domain credit-minting collides with its `conservativeDomainPrior`
 *  anti-amplification guard (placementPriors.test.ts). The `implies` placement
 *  diagnostic is applied only in the single-domain path (`submitPlacementAnswer`). */
function floorsFromPlacementRow(
  orders: StrandOrder[],
  row: Doc<"practicePlacements"> | null,
): Map<string, number> {
  const floors = new Map<string, number>();
  const orderByStrand = new Map(orders.map((o) => [o.strand, o.orderedKeys]));
  for (const { strand, frontierKey } of row?.frontierByStrand ?? []) {
    const ordered = orderByStrand.get(strand);
    if (!ordered) continue;
    const idx = ordered.indexOf(frontierKey);
    if (idx >= 0) floors.set(strand, idx);
  }
  return floors;
}

/** Regenerate a served probe's stem for a mixed session, tagged with its domain
 *  so the client can show a per-item domain chip (#553 labels). Async: a
 *  manipulative probe resolves its stored spec (resolvePlacementProbe). */
async function renderMixedProbe(
  ctx: QueryCtx | MutationCtx,
  served: NonNullable<Doc<"practicePlacements">["servedProbe"]>,
  d: MixedDomainCtx,
): Promise<MixedProbeWire | null> {
  const base = await resolvePlacementProbe(ctx, served, d.loaded.nodeByKey, d.domain);
  if (!base) return null;
  return { ...base, domain: d.domain, domainLabel: d.label };
}

/**
 * The CONSERVATIVE cross-domain grade prior a single completed domain contributes:
 * its contiguous, access-proven `placedThroughGrade` — NOT the maximum grade tag
 * on any isolated provisional row. This is the fix for the recursive-amplification
 * defect (findings §"Why the prior became Grade 7"): trust-upward can credit an
 * isolated high-grade node low in a strand's topological order without crediting
 * the intervening grade bands, so `max(gradeTag)` over credited rows overstates the
 * domain (a domain that displays Grade 3 could carry an isolated Grade 7 row).
 * Reusing `derivePlacedThroughGrade` — the SAME contiguous rule the result screen
 * shows — means the prior can only reflect a grade band the scholar cleared
 * end-to-end. Pure over the domain's mastery rows + node grades.
 *
 * `accessProven && !frontier` mirrors the credited (trusted-upward) set; the
 * repetition-0 frontier seed is excluded. Any source counts (a domain a scholar
 * genuinely practiced is at least as strong a prior as placement credit).
 */
export function conservativeDomainPrior(
  masteryRows: Iterable<{ skillKey: string; repetition: number; frontier?: boolean }>,
  nodes: { nodeKey: string; grade?: string }[],
): string | null {
  const credited = new Set<string>();
  for (const row of masteryRows) {
    if (!row.frontier && accessProven(row)) credited.add(row.skillKey);
  }
  return derivePlacedThroughGrade(credited, nodes);
}

/**
 * The cross-domain discovered-grade floor for `targetDomain` (phase 2): the
 * highest grade the scholar has CONTIGUOUSLY placed through in any OTHER seeded
 * domain (`conservativeDomainPrior`). Fed through `higherGrade` with the scholar's
 * chronological grade to seed the target domain's grade prior, so an
 * already-demonstrated level in a completed domain starts the next domain's search
 * nearer the frontier — WITHOUT letting an isolated high provisional row amplify
 * across domains. Pure over the loaded contexts + per-domain mastery.
 */
function inferredGradeFloor(
  targetDomain: string,
  domains: MixedDomainCtx[],
  masteryByDomain: Map<string, Map<string, Doc<"practiceMastery">>>,
): string | undefined {
  let best: string | undefined;
  for (const d of domains) {
    if (d.domain === targetDomain) continue;
    const mastery = masteryByDomain.get(d.domain);
    if (!mastery) continue;
    const placedThrough = conservativeDomainPrior(
      mastery.values(),
      [...d.loaded.nodeByKey.values()],
    );
    if (placedThrough !== null) best = higherGrade(best, placedThrough);
  }
  return best;
}

/**
 * The cross-domain grade PRIORS for one domain (phase 2) — SHARED by both serving
 * surfaces (finish-the-check-in, founder 2026-08-18). `startGrade` (inferred,
 * lifted) seeds the FIRST-probe target so a completed domain shortens this one;
 * `ceilingGrade` governs the affect-safe ring ceiling and stays tied to the
 * scholar's REAL chronological level — inference LIFTS the start, NEVER the
 * ceiling (findings minimal-fix #2).
 *
 * Both surfaces must derive this identically or the ghost guard leaks: where
 * inference lifts the start, the playlist band and the check-in would aim a fresh
 * strand's first probe at DIFFERENT nodes, and a probe abandoned on one surface
 * would never resurface on the other. Note the split is safe for the grade side:
 * `nextStrandProbe` reaches every probeable node in its window whatever the
 * target, so WHETHER a probe remains — the only thing `submitMappingAnswer`'s
 * convergence check asks — is invariant to `startGrade`; only WHICH node is
 * chosen depends on it.
 */
function placementGradePriors(
  domain: string,
  domains: MixedDomainCtx[],
  runtime: Map<string, MixedDomainRuntime>,
  scholarGrade: string | undefined,
): { startGrade: string | undefined; ceilingGrade: string | undefined } {
  const masteryByDomain = new Map(
    domains.map((d) => [d.domain, runtime.get(d.domain)?.mastery ?? new Map()] as const),
  );
  return {
    startGrade: higherGrade(scholarGrade, inferredGradeFloor(domain, domains, masteryByDomain)),
    ceilingGrade: scholarGrade,
  };
}

/** The per-domain result summary for the completion screen ("your spots"): each
 *  seeded domain + its SKILL-anchored spot — the domain's leading frontier skill
 *  label (J3), the SAME "you are here" the Tree marks — never a grade. Credit =
 *  access-proven, non-frontier placement rows for the (retained) grade prior; the
 *  `accessProven` guard keeps a recomputed repetition-0 frontier seed from being
 *  miscounted (findings §Result-label secondary bug). `placedThroughGrade` stays
 *  for teacher-facing / scheduling use only; the scholar surface renders
 *  `startingSkillLabel`. */
function mixedPerDomainSummary(
  d: MixedDomainCtx,
  rt: MixedDomainRuntime,
): { domain: string; label: string; placedThroughGrade: string | null; startingSkillLabel: string | null; complete: boolean } {
  const creditedSet = new Set(
    [...rt.mastery.values()]
      .filter((m) => m.source === "placement" && !m.frontier && accessProven(m))
      .map((m) => m.skillKey),
  );
  const placedThroughGrade = rt.done
    ? derivePlacedThroughGrade(creditedSet, [...d.loaded.nodeByKey.values()])
    : null;
  const startingSkillLabel = rt.done
    ? startingSkillLabelFromMastery(rt.mastery.values(), d.loaded.nodeByKey)
    : null;
  return { domain: d.domain, label: d.label, placedThroughGrade, startingSkillLabel, complete: rt.done };
}

/**
 * True when the scholar has automatic placement work available right now — an
 * eligible unmapped domain whose prerequisites have converged, or one with a run
 * already going. Reported from the shared derivation, so a SHADOW-PLACED domain
 * (mastery rows, no converged run) now counts as work: that is the behavior
 * change finish-the-check-in ruled for. Domains wholly above the affect-safe ring
 * stay available by deliberate selection but never keep the check-in open.
 */
export const needsAnyPlacement = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const domains = await loadMixedPlacementDomains(ctx);
    const scholarGrade = await scholarGradeLevel(ctx, args.scholarId);
    const runtime = new Map<string, MixedDomainRuntime>();
    for (const d of domains) {
      runtime.set(
        d.domain,
        await readMixedDomainRuntime(ctx, args.scholarId, d.domain),
      );
    }
    return summarizeScholarMap(domains, runtime, scholarGrade).perDomain.some(
      domainMayServe,
    );
  },
});

/** Shared loader for the two thin read-surface queries below (finish-the-
 *  check-in surfaces, PR2): load every seeded domain + this scholar's runtime,
 *  then classify with the ONE derivation. Not reused by `needsAnyPlacement` /
 *  `mixedPlacementCurrent` above — those are frozen (PR1 engine); this is
 *  purely additive so the engine's serve/finalize logic is untouched. */
async function loadScholarMapSummary(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
): Promise<{ summary: ScholarMapSummary; labelByDomain: Map<string, string> }> {
  const domains = await loadMixedPlacementDomains(ctx);
  const scholarGrade = await scholarGradeLevel(ctx, scholarId);
  const runtime = new Map<string, MixedDomainRuntime>();
  for (const d of domains) {
    runtime.set(d.domain, await readMixedDomainRuntime(ctx, scholarId, d.domain));
  }
  return {
    summary: summarizeScholarMap(domains, runtime, scholarGrade),
    labelByDomain: new Map(domains.map((d) => [d.domain, d.label])),
  };
}

/**
 * The Home CTA's thin read-surface (finish-the-check-in surfaces, PR2): the
 * honest N-of-M the client needs to render "Math check-in · N of M domains
 * mapped" WITHOUT loading a probe. `mapped`/`eligible` are the SAME numbers
 * `mixedPlacementCurrent` now carries (below) — one derivation, every surface.
 * `hasServable` mirrors `needsAnyPlacement`'s boolean so the CTA and the
 * check-in gate can never disagree about whether there's work to do.
 */
export const mapProgressForScholar = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const { summary } = await loadScholarMapSummary(ctx, args.scholarId);
    return {
      mapped: summary.mappedCount,
      eligible: summary.eligibleCount,
      allMapped: summary.allMapped,
      gradeOnFile: summary.gradeOnFile,
      hasServable: summary.perDomain.some(domainMayServe),
      // Has the scholar answered ANY mapping probe yet, on EITHER surface?
      // Drives the CTA's verb ("Start check-in" vs "Continue check-in") and the
      // home's chooser gate — replacing the stale `mixedPlacementCurrent`
      // governor readout both frontends used to poll (decision 6). Derived from
      // the ONE classification, so it can never disagree with N-of-M.
      started: summary.perDomain.some(
        (d) => d.status === "in_flight" || d.status === "converged",
      ),
    };
  },
});

/**
 * Per-domain map status for the fog-of-war tree (finish-the-check-in surfaces,
 * PR2) — exposes the SAME classification `mapProgressForScholar` counts, one
 * entry per seeded domain, so the Tree can fog exactly the domains that aren't
 * mapped yet without re-deriving the rule client-side.
 */
export const domainMapForScholar = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const { summary } = await loadScholarMapSummary(ctx, args.scholarId);
    return summary.perDomain.map((d: DomainMapEntry) => ({
      domain: d.domain,
      status: d.status,
      mapped: d.mapped,
      eligible: d.eligible,
    }));
  },
});

/**
 * The map-COMPLETION state for the Home reveal card (finish-the-check-in
 * surfaces, PR2) — reuses the EXISTING one-time `mapReveals` mechanism
 * (convex/mapGates.ts's sky/tree reveal) rather than inventing a second one,
 * under the new `"mapComplete"` map kind. Scholar-self only, mirroring
 * `mapGates.mine` (never derived for a teacher/remote view).
 *
 * `"complete"` — the map has JUST finished (`allMapped`) and has never been
 * acknowledged: the once-ever "Your map is ready" moment.
 * `"growth"` — the map was already acknowledged complete at some GRADE-eligible
 * count M0, and a later grade unlock has grown that count past M0 (a new domain
 * became eligible BY GRADE). Framed as expansion, never as the check-in
 * becoming incomplete again. `newDomainLabels` names the newly-grade-eligible,
 * still-unmapped domain(s) — sound because the LAST acknowledgment was a full
 * completion, so every domain grade-eligible at that time is already mapped;
 * anything grade-eligible-but-unmapped now must be new.
 *
 * The watermark is deliberately `gradeEligible`-driven, NOT `summary.eligibleCount`
 * (raise-the-ceiling, `scratch-critiques/slip-confirm-interaction-review.md`
 * §2): `eligibleCount` also grows the instant a scholar answers one probe in a
 * DELIBERATELY-opened above-ring domain (it goes `in_flight`, which counts in
 * M). That growth is the scholar's own choice, mid-check-in — reading it as a
 * "growth" reveal would pop a misleading "your map grew — <domain> is newly
 * eligible!" for a domain they just picked themselves. `gradeEligible` is the
 * raw ring-membership input and never moves except on an actual grade unlock,
 * so a self-opened above-ring domain can never trigger this reveal or appear in
 * `newDomainLabels`.
 *
 * `"none"` — nothing to reveal (still in progress, or already acknowledged at
 * the current grade-eligible count).
 */
export const mapCompletionForScholar = authedQuery({
  args: {},
  handler: async (ctx) => {
    const scholarId = ctx.user._id;
    const { summary, labelByDomain } = await loadScholarMapSummary(ctx, scholarId);
    const gradeEligibleCount = summary.perDomain.filter((d) => d.gradeEligible).length;
    const row = await ctx.db
      .query("mapReveals")
      .withIndex("by_scholar_map", (q) =>
        q.eq("scholarId", scholarId).eq("map", "mapComplete"),
      )
      .first();
    const seenAt = row?.eligibleCountSeen ?? null;
    const state: "none" | "complete" | "growth" =
      seenAt === null
        ? summary.allMapped
          ? "complete"
          : "none"
        : gradeEligibleCount > seenAt
          ? "growth"
          : "none";
    const newDomainLabels =
      state === "growth"
        ? summary.perDomain
            .filter((d) => d.gradeEligible && !d.mapped)
            .map((d) => labelByDomain.get(d.domain) ?? d.domain)
        : [];
    return {
      state,
      mapped: summary.mappedCount,
      eligible: summary.eligibleCount,
      newDomainLabels,
    };
  },
});

/**
 * Record that the calling scholar has seen the map-completion/growth reveal, so
 * it never replays for the SAME grade-eligible count — mirrors
 * `mapGates.acknowledgeReveal`. A no-op when there is genuinely nothing to
 * acknowledge (state is `"none"`), so a stray/duplicate call can never fabricate
 * a watermark ahead of the derivation. The watermark stored is the
 * `gradeEligible` count, matching `mapCompletionForScholar`'s read derivation —
 * see that docstring for why (a deliberately-opened above-ring domain must
 * never move this watermark).
 */
export const acknowledgeMapCompletion = authedMutation({
  args: {},
  handler: async (ctx) => {
    const scholarId = ctx.user._id;
    const { summary } = await loadScholarMapSummary(ctx, scholarId);
    const gradeEligibleCount = summary.perDomain.filter((d) => d.gradeEligible).length;
    const existing = await ctx.db
      .query("mapReveals")
      .withIndex("by_scholar_map", (q) =>
        q.eq("scholarId", scholarId).eq("map", "mapComplete"),
      )
      .first();
    const seenAt = existing?.eligibleCountSeen ?? null;
    const state: "none" | "complete" | "growth" =
      seenAt === null
        ? summary.allMapped
          ? "complete"
          : "none"
        : gradeEligibleCount > seenAt
          ? "growth"
          : "none";
    if (state === "none") return existing?._id ?? null;
    if (existing) {
      await ctx.db.patch(existing._id, {
        revealedAt: Date.now(),
        eligibleCountSeen: gradeEligibleCount,
      });
      return existing._id;
    }
    return await ctx.db.insert("mapReveals", {
      scholarId,
      map: "mapComplete",
      revealedAt: Date.now(),
      eligibleCountSeen: gradeEligibleCount,
    });
  },
});

/**
 * The CURRENT mixed-placement probe (read-only) — the multi-domain analogue of
 * `placementCurrent`. Returns the single probe the server is holding in front of
 * the scholar (regenerated stem, tagged with its domain), overall progress, and a
 * per-domain summary for the result screen. `done: true` = every seeded domain is
 * placed; `needsStart: true` = no probe served yet (the client primes via
 * `submitMixedPlacementAnswer` with no answer — a query can't persist).
 */
export const mixedPlacementCurrent = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const domains = await loadMixedPlacementDomains(ctx);
    // The scholar's institution day bounds the "sitting": the per-sitting probe
    // budget counts probes answered TODAY across every domain (probeLog `at`).
    const timeZone = await timeZoneForScholar(ctx, args.scholarId);
    const todayKey = dayKeyForTimezone(Date.now(), timeZone);

    const runtime = new Map<string, MixedDomainRuntime>();
    for (const d of domains) runtime.set(d.domain, await readMixedDomainRuntime(ctx, args.scholarId, d.domain));
    const scholarGrade = await scholarGradeLevel(ctx, args.scholarId);
    const summary = summarizeScholarMap(domains, runtime, scholarGrade);
    const mapEntry = mapEntriesByDomain(summary);
    /** May this domain serve a probe now (shared derivation, breadth-first)? */
    const mayServe = (domain: string): boolean => {
      const entry = mapEntry.get(domain);
      return entry !== undefined && domainMayServe(entry);
    };

    let answered = 0;
    let maxQuestions = 0;
    let complete = 0;
    let sittingAnswered = 0;
    let served: { d: MixedDomainCtx; probe: MixedProbeWire | null } | null = null;
    const perDomain: ReturnType<typeof mixedPerDomainSummary>[] = [];
    for (const d of domains) {
      const rt = runtime.get(d.domain)!;
      const domainAnswered = rt.placementRow?.probesAnswered ?? 0;
      answered += domainAnswered;
      sittingAnswered += (rt.placementRow?.probeLog ?? []).filter(
        (e) => dayKeyForTimezone(e.at, timeZone) === todayKey,
      ).length;
      // The advertised budget counts only domains the check-in can actually
      // reach: a domain outside the map (ineligible — above-ring or ELECTIVE,
      // and not deliberately opened) contributes nothing, or the "up to N"
      // header would promise probes the automatic path never serves. An opened
      // elective is in_flight (eligible) and counts like any other domain.
      const entry = mapEntry.get(d.domain);
      maxQuestions += rt.done
        ? domainAnswered
        : entry !== undefined && !entry.eligible
          ? 0
          : placementQuestionCap(
              d.loaded.orders.map(
                (order) => order.orderedKeys.filter(d.loaded.isProbeable).length,
              ),
            );
      if (rt.done) complete++;
      // Only a servable domain can hold the live probe. A mapped domain that
      // still carries a stale `servedProbe` (e.g. an abandoned single-domain
      // placement the scholar later converged another way) is ignored — the next
      // serve clears it (persistServed), and it must never be re-served here.
      // A queued domain can also carry a stale self-selected probe; the mixed
      // check-in must still defer it until its prereq domain converges.
      if (served === null && mayServe(d.domain) && rt.placementRow?.servedProbe) {
        // A parked probe that no longer renders (content moved on since it was
        // served) is reported as NOT served — the scholar gets the start CTA and
        // the prime mutation clears + re-serves. Wrapping the null kept `served`
        // truthy and stranded resumed check-ins on a blank probe (2026-08-18).
        const probe = await renderMixedProbe(ctx, rt.placementRow.servedProbe, d);
        if (probe) served = { d, probe };
      }
      perDomain.push(mixedPerDomainSummary(d, rt));
    }
    // `complete === domains.length` is also true (vacuously) for a deployment with
    // NO seeded domains — matching submitMixedPlacementAnswer's serve loop there.
    const done = !summary.perDomain.some(domainMayServe);
    // The sitting ceiling the scholar sees ("up to N today"): the per-sitting
    // budget, but never more than what actually remains to fully place everything
    // (adaptive convergence ends early), so the honest "up to" never overstates.
    const sittingMaxQuestions = Math.min(
      CHECK_IN_SITTING_PROBE_BUDGET,
      sittingAnswered + Math.max(0, maxQuestions - answered),
    );
    // Parked for this sitting: the day's budget is spent but domains remain. The
    // scholar surface renders a warm pause; a completed check-in never pauses.
    const paused = !done && sittingAnswered >= CHECK_IN_SITTING_PROBE_BUDGET;

    if (served && served.probe) {
      return {
        done: false,
        needsStart: false,
        paused,
        probe: served.probe,
        answered,
        totalDomains: domains.length,
        domainsComplete: complete,
        // The HONEST N-of-M (finish-the-check-in surfaces, PR2): the eligible
        // (grade-ring) set, not every seeded domain — `totalDomains`/
        // `domainsComplete` above count ALL seeded domains and stay only for
        // back-compat. Every surface's header reads THESE two numbers.
        mapped: summary.mappedCount,
        eligible: summary.eligibleCount,
        maxQuestions,
        sittingAnswered,
        sittingMaxQuestions,
        sittingBudget: CHECK_IN_SITTING_PROBE_BUDGET,
        perDomain,
      };
    }
    return {
      done,
      needsStart: !done && !paused,
      paused,
      probe: null,
      answered,
      totalDomains: domains.length,
      domainsComplete: complete,
      mapped: summary.mappedCount,
      eligible: summary.eligibleCount,
      maxQuestions,
      sittingAnswered,
      sittingMaxQuestions,
      sittingBudget: CHECK_IN_SITTING_PROBE_BUDGET,
      perDomain,
    };
  },
});

/**
 * Grade one mixed-placement answer (or PRIME the first/next probe) — the driver
 * of the multi-domain check-in, the analogue of `submitPlacementAnswer`. With no
 * `itemId` it PRIMES (ensures a served probe across the needy domains and returns
 * it). With an answer it grades the served domain's probe server-side (ternary),
 * appends to THAT domain's resumable log, finalizes+credits the domain the moment
 * its own search converges (so its discovered grade can inform the domains still
 * to come), then serves the next probe BREADTH-FIRST across every servable
 * domain (first coverage of each strand before any domain deepens). `done: true`
 * once no automatic placement work remains; a domain above the affect-safe ring
 * stays unmapped for deliberate entry. Idempotent: a scholar with no automatic
 * placement work is a no-op.
 */
export const submitMixedPlacementAnswer = authedMutation({
  args: {
    scholarId: v.id("users"),
    seed: v.number(),
    itemId: v.optional(v.string()),
    answer: v.optional(v.string()),
    dontKnow: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const now = Date.now();

    const domains = await loadMixedPlacementDomains(ctx);
    const scholarGrade = await scholarGradeLevel(ctx, args.scholarId);
    const orderIndex = new Map(domains.map((d, i) => [d.domain, i]));
    // The scholar's institution day bounds the per-sitting probe budget (below):
    // it counts probes answered TODAY across every domain (probeLog `at`).
    const timeZone = await timeZoneForScholar(ctx, args.scholarId);
    const todayKey = dayKeyForTimezone(now, timeZone);

    // Fresh per-domain runtime, re-read whenever a domain's row/mastery changes.
    // `mapCache` memoizes the derived classification over that runtime and is
    // dropped by every `reload`, so the per-domain loops below don't re-derive it
    // once per domain while it cannot have changed.
    const runtime = new Map<string, MixedDomainRuntime>();
    let mapCache: Map<string, DomainMapEntry> | null = null;
    const reload = async (domain: string): Promise<MixedDomainRuntime> => {
      const rt = await readMixedDomainRuntime(ctx, args.scholarId, domain);
      runtime.set(domain, rt);
      mapCache = null;
      return rt;
    };
    for (const d of domains) await reload(d.domain);

    const buildPerDomain = () =>
      domains.map((d) => mixedPerDomainSummary(d, runtime.get(d.domain)!));

    // Probes ANSWERED this sitting (today) across ALL domains, from the live
    // per-domain runtime logs. The per-sitting budget parks the check-in once this
    // hits CHECK_IN_SITTING_PROBE_BUDGET while domains still need placing.
    const sittingProbeCount = (): number =>
      domains.reduce(
        (n, d) =>
          n +
          (runtime.get(d.domain)!.placementRow?.probeLog ?? []).filter(
            (e) => dayKeyForTimezone(e.at, timeZone) === todayKey,
          ).length,
        0,
      );
    // Server-computed pause signal: the day's probe budget is spent AND domains
    // remain. The scholar surface honors it (warm pause → practice); it never
    // withholds a probe, so an instant automated driver (sim/test) still maps the
    // full graph. False the moment every domain is placed (nothing left to park).
    const sittingBudgetReached = (): boolean =>
      sittingProbeCount() >= CHECK_IN_SITTING_PROBE_BUDGET &&
      domains.some((d) => !runtime.get(d.domain)!.done);

    // The cross-domain grade priors for `domain` (phase 2). `start` (inferred,
    // lifted) seeds the first probe; `ceiling` is the humane ring cap tied to the
    // scholar's real chronological grade — inference LIFTS the start, but NEVER the
    // ceiling (findings minimal-fix #2: a provisional cross-domain credit must not
    // widen the affect-safe ring). An unknown enrolled grade leaves the ceiling
    // undefined (no cap → the search bounds the ring by real misses), so a completed
    // low domain can never strand a later one below its own floor; a correct answer
    // still expands the ring within the search.
    const gradeFor = (domain: string) =>
      placementGradePriors(domain, domains, runtime, scholarGrade);

    // Manipulative probes served across the WHOLE check-in (all domains) — the
    // K=3 budget is check-in-wide, so a manipulative in whole-number counts
    // against fractions too. Reads the live per-domain runtime logs.
    const manipulativesServedAcrossCheckIn = (): number =>
      domains.reduce(
        (n, dd) => n + manipulativeProbesInLog(runtime.get(dd.domain)!.placementRow?.probeLog),
        0,
      );

    // Persist a served probe on ONE domain's row, clearing any other domain's
    // served probe first (the at-most-one-served invariant).
    const persistServed = async (
      d: MixedDomainCtx,
      served: { strand: string; probeKey: string; index: number },
    ): Promise<MixedProbeWire | null> => {
      for (const other of domains) {
        if (other.domain === d.domain) continue;
        const ort = runtime.get(other.domain)!;
        if (ort.placementRow?.servedProbe) {
          await ctx.db.patch(ort.placementRow._id, { servedProbe: undefined, updatedAt: now });
          await reload(other.domain);
        }
      }
      const rt = runtime.get(d.domain)!;
      const log = rt.placementRow?.probeLog ?? [];
      // Choose template vs. curated manipulative: K=3 across the whole check-in,
      // affect-safe first probe of THIS domain's strand stays a template.
      const servedProbe = await buildServedProbe(
        ctx,
        served,
        args.seed,
        `${d.domain}\u0000${served.strand}`,
        {
          manipulativesServed: manipulativesServedAcrossCheckIn(),
          strandTemplateProbes: templateProbesInStrand(log, served.strand),
          // A confirm re-serves an already-answered node — perturb the seed so
          // the retry is a FRESH item, not the identical stem the scholar slipped.
          attempt: log.filter((e) => e.nodeKey === served.probeKey).length,
        },
      );
      const fields = {
        probesAnswered: log.length,
        probeLog: log,
        servedProbe,
        updatedAt: now,
      };
      if (rt.placementRow) await ctx.db.patch(rt.placementRow._id, fields);
      else {
        await ctx.db.insert("practicePlacements", {
          scholarId: args.scholarId,
          domain: d.domain,
          status: "in_progress",
          ...fields,
        });
      }
      await reload(d.domain);
      return renderMixedProbe(ctx, servedProbe, d);
    };

    // Finalize ONE domain (persist the complete row + credit mastery via the
    // shared trust-upward path); marks it done.
    const finalizeDomain = async (d: MixedDomainCtx): Promise<void> => {
      const rt = runtime.get(d.domain)!;
      const log = rt.placementRow?.probeLog ?? [];
      const { outcomes } = outcomesFromProbeLog(log);
      const floors = floorsFromPlacementRow(d.loaded.orders, rt.placementRow);
      const frontiers = d.loaded.orders.map((o) =>
        strandFrontier(o.strand, o.orderedKeys, outcomes, floors.get(o.strand) ?? 0),
      );
      const frontierByStrand = frontiers
        .filter((f) => f.frontierKey !== null)
        .map((f) => ({ strand: f.strand, frontierKey: f.frontierKey! }));
      const finalFields = {
        status: "complete" as const,
        probesAnswered: log.length,
        probeLog: log,
        servedProbe: undefined,
        frontierByStrand,
        updatedAt: now,
      };
      if (rt.placementRow) await ctx.db.patch(rt.placementRow._id, finalFields);
      else await ctx.db.insert("practicePlacements", { scholarId: args.scholarId, domain: d.domain, ...finalFields });
      await creditPlacementFrontiers(
        ctx,
        args.scholarId,
        d.domain,
        frontiers,
        { nodes: d.loaded.nodes, edges: d.loaded.edges, nodeByKey: d.loaded.nodeByKey },
        now,
      );
      await reload(d.domain);
    };

    // ── The shared map derivation, LIVE ──
    // Breadth-first serving holds no snapshot: `reload` keeps `runtime` fresh and
    // drops `mapCache`, so the classification is re-derived after every finalize
    // and finalizing a prerequisite immediately opens the tier behind it.
    const mapEntries = (): Map<string, DomainMapEntry> =>
      (mapCache ??= mapEntriesByDomain(summarizeScholarMap(domains, runtime, scholarGrade)));
    const mayServe = (domain: string): boolean => {
      const entry = mapEntries().get(domain);
      return entry !== undefined && domainMayServe(entry);
    };
    const servableDomains = (): MixedDomainCtx[] => {
      const entries = mapEntries();
      return domains.filter((d) => {
        const entry = entries.get(d.domain);
        return entry !== undefined && domainMayServe(entry);
      });
    };

    /** This domain's next-probe candidates under the check-in's own priors (the
     *  cross-domain-inferred start grade, the real-grade ring ceiling) and its own
     *  probe cap. Same derivation the playlist band uses — one policy, so the two
     *  surfaces can never disagree about which probe is next. */
    const candidatesFor = (d: MixedDomainCtx) =>
      mappingCandidatesForDomain(
        d,
        runtime.get(d.domain)!.placementRow,
        gradeFor(d.domain),
        orderIndex.get(d.domain) ?? 999,
        PLACEMENT_GLOBAL_CAP,
      );

    const currentServed = async (): Promise<{ d: MixedDomainCtx; probe: MixedProbeWire } | null> => {
      // A probe parked on a servable domain is handed straight back — that is the
      // ghost guard: an abandoned probe re-enters on whichever surface asks next,
      // never silently vanishing.
      for (const d of domains) {
        const rt = runtime.get(d.domain)!;
        if (!rt.placementRow?.servedProbe || !mayServe(d.domain)) continue;
        const probe = await renderMixedProbe(ctx, rt.placementRow.servedProbe, d);
        if (probe === null) {
          // The parked probe no longer resolves (its node/template/item was
          // removed by a content change after it was served). Clear it and keep
          // scanning so serveNext() mints a fresh one — handing it back as
          // `probe: null` parks the resumed check-in on a blank screen with no
          // way forward.
          await ctx.db.patch(rt.placementRow._id, { servedProbe: undefined, updatedAt: now });
          await reload(d.domain);
          continue;
        }
        return { d, probe };
      }
      return null;
    };
    /** Drop a probe parked on a domain that may NOT serve now (mapped, queued
     *  behind a prerequisite, or outside the ring) — it must never be handed back
     *  or graded. A servable domain's parked probe is deliberately kept. */
    const clearUnservableServed = async (): Promise<void> => {
      for (const d of domains) {
        const rt = runtime.get(d.domain)!;
        if (rt.done || !rt.placementRow?.servedProbe || mayServe(d.domain)) continue;
        await ctx.db.patch(rt.placementRow._id, { servedProbe: undefined, updatedAt: now });
        await reload(d.domain);
      }
    };

    // Serve the next probe BREADTH-FIRST across every servable domain
    // (finish-the-check-in, founder 2026-08-18): pass 1 gives each eligible strand
    // its first probe, pass 2 deepens foundational-first to convergence, exactly
    // as the playlist band orders its own band (`orderMappingCandidates`). A
    // servable domain with nothing left to ask is finalized in passing, which
    // opens the tier behind it — so this can never dead-end. Returns the served
    // probe (with its domain) or null when nothing can serve.
    const serveNext = async (): Promise<{ d: MixedDomainCtx; probe: MixedProbeWire | null } | null> => {
      // Bounded: each iteration either serves (returns) or finalizes at least one
      // domain (the servable set strictly shrinks), so it can't spin.
      for (let guard = 0; guard <= domains.length; guard++) {
        const servable = servableDomains();
        if (servable.length === 0) return null;
        const withCandidates = servable.map((d) => ({ d, cands: candidatesFor(d) }));
        const exhausted = withCandidates.filter((entry) => entry.cands.length === 0);
        if (exhausted.length > 0) {
          for (const entry of exhausted) await finalizeDomain(entry.d);
          continue;
        }
        const allCands = withCandidates.flatMap((e) => e.cands);
        // "Confirm before you cap": a slip's confirm (a fresh item on the SAME
        // skill) is served IMMEDIATELY in the interactive check-in, so the
        // scholar's "I just made a silly mistake" retry lands on that skill. The
        // playlist band deliberately does NOT preempt this way (it stays
        // breadth-first — see `orderMappingCandidates`); the check-in does.
        const pending = allCands.filter((c) => c.pendingConfirm);
        const best = (pending.length > 0 ? orderMappingCandidates(pending) : orderMappingCandidates(allCands))[0];
        const d = domains.find((x) => x.domain === best.domain)!;
        const probe = await persistServed(d, {
          strand: best.strand,
          probeKey: best.probeKey,
          index: best.probeIndex,
        });
        return { d, probe };
      }
      return null;
    };

    // Idempotent: nothing can serve → no-op done. A mapped domain never restarts,
    // and a domain outside the affect-safe ring is never opened automatically.
    if (servableDomains().length === 0) {
      return { done: true, paused: false, graded: null, probe: null, perDomain: buildPerDomain() };
    }

    // ── PRIME: return the currently-served probe, else serve the next one. Only
    //    a SERVABLE domain can hold the live probe (a stale servedProbe on a
    //    mapped or queued domain is cleared, never re-served). ──
    if (!args.itemId) {
      await clearUnservableServed();
      const parked = await currentServed();
      if (parked) return { done: false, paused: sittingBudgetReached(), graded: null, probe: parked.probe, perDomain: [] };
      const served = await serveNext();
      if (!served) return { done: true, paused: false, graded: null, probe: null, perDomain: buildPerDomain() };
      return { done: false, paused: sittingBudgetReached(), graded: null, probe: served.probe, perDomain: [] };
    }

    // ── GRADE: the answer must be for the CURRENTLY-served probe of a SERVABLE
    //    domain. A stale/duplicate submit (or a probe from a since-mapped domain)
    //    is an idempotent no-op that re-serves. ──
    await clearUnservableServed();
    let servedDomain = domains.find(
      (d) =>
        mayServe(d.domain) &&
        runtime.get(d.domain)!.placementRow?.servedProbe?.itemId === args.itemId,
    );
    if (servedDomain) {
      // Even a MATCHING submit must not grade a probe whose content died (a
      // reseed removed its node/template/item) — `resolveServableItem` below
      // throws on it and the client strands on its "submitting" screen
      // (review finding, 2026-08-18). Clear the corpse and take the no-op
      // re-serve path instead.
      const rt = runtime.get(servedDomain.domain)!;
      const rendered = await renderMixedProbe(ctx, rt.placementRow!.servedProbe!, servedDomain);
      if (rendered === null) {
        await ctx.db.patch(rt.placementRow!._id, { servedProbe: undefined, updatedAt: now });
        await reload(servedDomain.domain);
        servedDomain = undefined;
      }
    }
    if (!servedDomain) {
      const parked = await currentServed();
      if (parked) return { done: false, paused: sittingBudgetReached(), graded: null, probe: parked.probe, perDomain: [] };
      const served = await serveNext();
      if (!served) return { done: true, paused: false, graded: null, probe: null, perDomain: buildPerDomain() };
      return { done: false, paused: sittingBudgetReached(), graded: null, probe: served.probe, perDomain: [] };
    }

    const d = servedDomain;
    const served = runtime.get(d.domain)!.placementRow!.servedProbe!;

    // Resolve the served probe to a unified ServableItem (template or
    // manipulative) and grade through the shared dispatcher under the PLACEMENT
    // policy (ternary; template reveals on miss+correct; manipulative grades via
    // isSolved and never reveals). Placement drives its own side effects below.
    const item = await resolveServableItem(ctx, served.itemId, d.domain);
    const rawAnswer =
      item.kind === "manipulative"
        ? args.answer !== undefined
          ? args.answer.slice(0, MAX_MANIPULATIVE_STATE_LEN)
          : undefined
        : sanitizePlacementAnswer(args.answer);
    const answerText = args.dontKnow
      ? undefined
      : attemptAnswerText(item, args.answer);
    const submission: Submission = args.dontKnow
      ? { kind: "dontKnow" }
      : item.kind === "manipulative"
        ? { kind: "manipulativeState", stateJson: args.answer ?? "" }
        : { kind: "typed", raw: rawAnswer ?? "" };
    const grade = gradeSubmission(item, submission, PLACEMENT_POLICY);
    const correctAnswer = grade.revealedAnswer;
    const kind: PlacementOutcomeKind = grade.isDontKnow
      ? "unknown"
      : grade.correct
        ? "correct"
        : "incorrect";
    await ctx.db.insert("practiceAttempts", {
      scholarId: args.scholarId,
      nodeKey: served.nodeKey,
      itemId: served.itemId,
      correct: outcomeCredits(kind),
      ...(answerText !== undefined ? { answerText } : {}),
      ...(kind !== "correct"
        ? {
            ...(sanitizeStemSnapshot(grade.stem) !== undefined
              ? { stemSnapshot: sanitizeStemSnapshot(grade.stem) }
              : {}),
            ...(grade.correctAnswer
              ? { expectedAnswer: sanitizePlacementAnswer(grade.correctAnswer) }
              : {}),
          }
        : {}),
      domain: d.domain,
      strand: served.strand,
      lane: "placement",
      breakerEligible: false,
      repetitionBefore: 0,
      source: "placement",
      // The other two placement submit paths stamp this; the MIXED check-in — the
      // one every scholar actually uses — did not, so an honest "I haven't learned
      // this yet" was indistinguishable from a wrong answer downstream: it leaked
      // into the teacher-facing misses lists (which filter on
      // `explanationReason !== "dont_know"`) while `dontKnowsForNode` rendered
      // nothing at all for the check-in.
      ...(kind !== "correct"
        ? {
            explanationReason: kind === "unknown" ? ("dont_know" as const) : ("miss" as const),
            explanationRequestedAt: now,
          }
        : {}),
      createdAt: now,
    });

    const rt = runtime.get(d.domain)!;
    // "Confirm before you cap": was this the FIRST typed miss on this node (pre-
    // append log)? A first miss re-serves a fresh item on the same skill rather
    // than capping — the scholar surface offers the two-way slip/concede choice.
    const firstMissOnNode =
      (rt.placementRow?.probeLog ?? []).every((e) => e.nodeKey !== served.nodeKey);
    const log = [
      ...(rt.placementRow?.probeLog ?? []),
      {
        nodeKey: served.nodeKey,
        strand: served.strand,
        outcome: kind,
        at: now,
        ...(rawAnswer !== undefined ? { answerRaw: rawAnswer } : {}),
        itemId: served.itemId,
      },
    ];
    // The just-appended entry's index into THIS domain's log — seeds the
    // Tier-2 reveal-line rotation.
    const probeLogIndex = log.length - 1;
    // The placement warmth floor (mixed check-in): a warm, deterministic reveal
    // line on a miss / don't-know for THIS domain's probe. Never on a correct.
    const revealLine =
      kind === "correct"
        ? undefined
        : placementRevealLineFor(item, correctAnswer ?? null, probeLogIndex);
    await ctx.db.patch(rt.placementRow!._id, {
      probesAnswered: log.length,
      probeLog: log,
      servedProbe: undefined,
      updatedAt: now,
    });
    await reload(d.domain);

    // Finalize this domain the instant its own search converges (or hits its
    // cap), so its discovered grade seeds the domains still to be probed. Asked
    // with the SAME candidate derivation the serve side uses, so the two can
    // never disagree about whether a probe remains.
    if (candidatesFor(d).length === 0) await finalizeDomain(d);

    const served2 = await serveNext();
    const done = served2 === null;
    // The retry offer: a first typed miss whose confirm (a fresh item on the SAME
    // skill in the SAME domain) is exactly what serveNext just picked — pending
    // confirms sort first, so this holds whenever a confirm is due.
    const retry =
      kind === "incorrect" &&
      firstMissOnNode &&
      served2?.d.domain === d.domain &&
      served2?.probe?.skillKey === served.nodeKey;
    return {
      done,
      // Server-computed park signal (soft): the day's budget is spent and domains
      // remain. serveNext still returned the next probe (never withheld) so an
      // instant driver maps the full graph; the scholar surface honors `paused`.
      paused: sittingBudgetReached(),
      graded: { outcome: kind, correctAnswer, domain: d.domain, revealLine, unitOutcome: grade.unitOutcome, retry },
      probe: served2?.probe ?? null,
      perDomain: done ? buildPerDomain() : [],
    };
  },
});

// ── Option D — mapping items inside the daily playlist ─────────────────────────
// (OPTION_D_RULINGS, founder 2026-07-19.) The standalone placement/check-in
// surface retires: an unmapped spot is a `· mapping` SEGMENT of the ordinary
// daily playlist. Mapping items are placement PROBES served AS playlist items
// (lane "mapping"); they grade through `submitMappingAnswer` below, which writes
// INFERRED credit down the SAME `creditPlacementFrontiers` trust-upward path the
// check-in uses — never a demonstrated-fluency claim. The pure mix policy (cap,
// ordering, day-1 all-mapping emergence) lives in lib/practice/mapping.ts.
//
// Ghost migration (Q8): NO idempotent data migration is needed. An existing
// scholar's parked, in-progress `practicePlacements` row is READ by
// `loadMappingState` (it's an unmapped domain — no mastery, placement not
// complete) and its remaining unconverged strands surface as `· mapping` items
// in the next composed playlist; the old deferral/park card just stops being
// rendered. `submitMappingAnswer` appends to that SAME probeLog, so every probe
// the scholar already answered stands. Composition absorbs the ghost — proven by
// convex/__tests__/mappingPlaylist.test.ts ("ghost placement dissolves…").

/** A registered domain's live mapping state for the scholar-facing composition +
 *  the minimal teacher read. */
type MappingDomainInfo = {
  domain: string;
  label: string;
  /** "unmapped" = never probed; "in_progress" = a parked placement with answers. */
  state: "unmapped" | "in_progress";
};

/**
 * Cheap pre-check: does the scholar still have ANY seeded registered domain with
 * no CONVERGED placement run? Indexed reads only — no graph load — so a scholar
 * whose whole map is drawn skips all the mapping machinery below.
 *
 * The mastery short-circuit this used to open with is gone (finish-the-check-in,
 * founder 2026-08-18): mastery is not a map, so a shadow-placed domain must reach
 * the derivation and be searched. Two consequences worth knowing — the check is
 * now a SUPERSET (a domain outside the scholar's affect-safe ring never converges
 * automatically, so it keeps this true and the graph load happens), and the band
 * then legitimately comes back empty, which `finalizeWithMapping`'s zero-item
 * guard already handles. Under the ruling essentially the whole roster has an
 * incomplete map anyway, so the pre-check was never going to save the hot path.
 */
async function anyUnmappedDomain(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  practiceScope: PracticeScope = { kind: "open" },
): Promise<boolean> {
  for (const domain of REGISTERED_PRACTICE_DOMAINS) {
    if (!practiceScopeAllowsDomain(practiceScope, domain)) continue;
    const placement = await ctx.db
      .query("practicePlacements")
      .withIndex("by_scholar_domain", (q) => q.eq("scholarId", scholarId).eq("domain", domain))
      .first();
    if (placement?.status === "complete") continue;
    // An UNOPENED elective is not owed mapping — without this, every fully
    // mapped scholar reads "unmapped forever" and the short-circuit's
    // consumers fall through to the full mapping-state load (Sol review
    // 2026-08-19, finding 3). An opened elective (any placement row) counts.
    if (ELECTIVE_PRACTICE_DOMAINS.has(domain) && !placement) continue;
    // Only count a domain actually seeded on this deployment (one indexed read).
    const anyNode = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .first();
    if (anyNode) return true;
  }
  return false;
}

/**
 * The scholar's live mapping state across every seeded registered domain — the
 * ONE ctx loader behind the shared derivation. Carries the loaded placement
 * contexts, the per-domain runtime, the classification summary, and two sets the
 * playlist keeps deliberately DISTINCT:
 *
 *   • `unmapped` — eligible domains with no converged run. Drives the `· mapping`
 *     band, `mappingDomains`, and the N-of-M counts.
 *   • `ordinarySuppressed` — domains with NO mastery at all and no converged run.
 *     These are the ones whose ordinary frontier work is replaced by mapping
 *     items ("you don't drill the frontier of a domain you haven't placed"). A
 *     SHADOW-PLACED domain is unmapped but NOT suppressed: it holds real, earned
 *     mastery with real reviews due, and swallowing those to run a search would
 *     be a regression, not the ruling.
 */
async function loadMappingState(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
): Promise<{
  domains: MixedDomainCtx[];
  runtime: Map<string, MixedDomainRuntime>;
  summary: ScholarMapSummary;
  notMapped: Set<string>;
  unmapped: Set<string>;
  ordinarySuppressed: Set<string>;
  servable: MixedDomainCtx[];
  scholarGrade: string | undefined;
}> {
  const domains = await loadMixedPlacementDomains(ctx);
  const scholarGrade = await scholarGradeLevel(ctx, scholarId);
  const runtime = new Map<string, MixedDomainRuntime>();
  for (const d of domains) runtime.set(d.domain, await readMixedDomainRuntime(ctx, scholarId, d.domain));
  const summary = summarizeScholarMap(domains, runtime, scholarGrade);
  const entries = mapEntriesByDomain(summary);
  // Every seeded domain with no converged run — including ones outside the ring,
  // which a DELIBERATE pick may still map.
  const notMapped = new Set(
    summary.perDomain.filter((e) => !e.mapped).map((e) => e.domain),
  );
  // The map's remaining set: what "N of M domains mapped" counts down.
  const unmapped = new Set(
    summary.perDomain.filter((e) => e.eligible && !e.mapped).map((e) => e.domain),
  );
  const ordinarySuppressed = new Set(
    domains
      .filter((d) => !runtime.get(d.domain)!.done && !runtime.get(d.domain)!.hasMastery)
      .map((d) => d.domain),
  );
  const servable = domains.filter((d) => {
    const entry = entries.get(d.domain);
    return entry !== undefined && domainMayServe(entry);
  });
  return { domains, runtime, summary, notMapped, unmapped, ordinarySuppressed, servable, scholarGrade };
}

/**
 * The scholar's domain-map summary WITH node labels, for READ surfaces outside
 * the practice loop.
 *
 * The teacher-facing check-in reader (`lib/scholarReads.readScholarMathCheckIn`)
 * is the second consumer of this derivation. It exists so that reader can NEVER
 * answer "is this domain mapped?" with its own predicate: every status word it
 * prints comes from `lib/practice/domainMapStatus`, through this loader, exactly
 * as the serving loop's own does. A reader that re-derived from
 * `practicePlacements.status` would re-open the shadow-placement hole that
 * module closed (mastery without a converged run reading as mapped).
 *
 * This is deliberately the FULL `loadMappingState` path rather than a cheaper
 * bespoke read — a cheaper read is how the fork starts. (The private
 * `loadScholarMapSummary` above serves the scholar-facing thin surfaces that
 * need no node labels; both classify through the ONE `summarizeScholarMap`
 * derivation, so neither forks the mapped/unmapped predicate.)
 */
export async function loadScholarMapSummaryWithNodes(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
): Promise<{
  summary: ScholarMapSummary;
  /** Every seeded node's display label, already collected by the load above.
   *  Handed back so a reader labelling probes does not re-scan
   *  `knowledgeNodes` (an unindexed full-table read) for data this call
   *  just paid for. */
  nodeLabels: Map<string, string>;
}> {
  const state = await loadMappingState(ctx, scholarId);
  const nodeLabels = new Map<string, string>();
  for (const d of state.domains) {
    for (const node of d.loaded.nodes) nodeLabels.set(node.nodeKey, node.label);
  }
  return { summary: state.summary, nodeLabels };
}

/** A mapping candidate plus the probe's index in its strand's topological order —
 *  what `buildServedProbe` needs to seed a persisted `servedProbe`. The extra
 *  field rides along so the check-in orchestrator and the playlist band derive
 *  candidates through the SAME function. */
type MappingCandidateAt = MappingCandidate & { probeIndex: number };

/**
 * The next mapping-probe candidate of every unconverged strand in ONE domain,
 * given that domain's live placement row.
 *
 * The single candidate derivation for BOTH serving surfaces — the playlist's
 * `· mapping` band and the multi-domain check-in. If the two ever derived probes
 * differently they could serve a probe the other refuses to grade, swallowing a
 * scholar's answer. They differ only in their inputs: the band passes the
 * scholar's own grade for both priors and the sit cap; the check-in passes its
 * cross-domain-inferred start grade, the real-grade ring ceiling, and the global
 * probe cap.
 */
function mappingCandidatesForDomain(
  d: { domain: string; loaded: Awaited<ReturnType<typeof loadPlacementContext>> },
  row: Doc<"practicePlacements"> | null,
  priors: { startGrade: string | undefined; ceilingGrade: string | undefined },
  domainOrder: number,
  probeCap: number,
): MappingCandidateAt[] {
  const log = row?.probeLog ?? [];
  if (log.length >= probeCap) return []; // a capped row has nothing left to ask
  const { outcomes, answeredByStrand } = outcomesFromProbeLog(log);
  const floors = floorsFromPlacementRow(d.loaded.orders, row);
  const firstTargets = firstProbeTargets(d.loaded.orders, d.loaded.nodeByKey, priors.startGrade);
  const gradeOf = (key: string): string | undefined => d.loaded.nodeByKey.get(key)?.grade;
  const out: MappingCandidateAt[] = [];
  for (const o of d.loaded.orders) {
    const probe = nextStrandProbe(o.orderedKeys, d.loaded.isProbeable, outcomes, {
      resumeFloor: floors.get(o.strand) ?? 0,
      firstProbeTarget: firstTargets.get(o.strand),
      gradeOf,
      scholarGrade: priors.ceilingGrade,
    });
    if (!probe) continue;
    out.push({
      domain: d.domain,
      strand: o.strand,
      probeKey: probe.probeKey,
      probeIndex: probe.index,
      pendingConfirm: probe.pendingConfirm,
      domainPriority: checkInDomainPriority(d.domain),
      answeredInStrand: answeredByStrand.get(o.strand) ?? 0,
      domainOrder,
    });
  }
  return out;
}

/** A mapping band item's wire shape, built from a resolved `ServableItem`.
 *  A mapping item rides the ORDINARY playlist and is indistinguishable from a
 *  drill item on screen, so a fraction/power/root probe must open the same 2-D box
 *  editor (`answerShape: "twoD"`) rather than dropping to the flat keypad.
 *  Threaded exactly as `resolvePlacementProbe` does: SHAPE only. `answerFormat`
 *  (the L1 skeleton) stays withheld because a mapping probe is a measurement —
 *  the scholar builds the fraction from an empty editor. `factKey` is withheld
 *  too: a mapping probe grades through the placement path and must never bucket
 *  into the fact-fluency ledger or pull a fact family into the sprint. */
function mappingServedItem(item: ServableItem, domain: string): ServedItem {
  const wire = servedItemFromServable(item, false);
  return {
    itemId: item.itemId,
    skillKey: item.skillKey,
    skillLabel: item.skillLabel,
    domain,
    stem: item.prompt.stem,
    answerType: item.prompt.answerType,
    ...(item.prompt.answerUnit ? { answerUnit: item.prompt.answerUnit } : {}),
    ...(item.prompt.choices ? { choices: item.prompt.choices } : {}),
    ...(item.prompt.promptVisual ? { promptVisual: item.prompt.promptVisual } : {}),
    ...(item.prompt.manipulativeSpec ? { manipulativeSpec: item.prompt.manipulativeSpec } : {}),
    ...(wire.answerShape ? { answerShape: wire.answerShape } : {}),
    lane: "mapping" as const,
  };
}

/**
 * Build the `· mapping` band ServedItems for one playlist recomposition: gather
 * the next probe of every servable, unconverged (domain, strand), apply the pure
 * `planMappingBand` mix policy (≤2 blended, all-mapping day-1), and materialize
 * each pick tagged `lane: "mapping"`. Priors come from the SHARED
 * `placementGradePriors`, the same derivation the check-in uses, so both surfaces
 * aim a fresh strand's first probe at the same node; `submitMappingAnswer`'s
 * convergence check still agrees, because whether a probe remains is invariant to
 * the first-probe target (see that helper).
 *
 * GHOST GUARD (finish-the-check-in, founder 2026-08-18): a row carrying a live
 * `servedProbe` — served by the multi-domain check-in or the single-domain loop
 * and never answered — has that EXACT probe (same nodeKey, itemId and seed)
 * re-served for its (domain, strand) instead of a freshly-derived one. Without
 * it a probe abandoned on one surface would be replaced by a different item on
 * the other, and the parked one would sit unanswerable on the row forever.
 */
async function buildMappingItems(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  seed: number,
  state: Awaited<ReturnType<typeof loadMappingState>>,
  hasOtherServable: boolean,
  leadDomain: string | undefined,
  // F2 (Q6): a DELIBERATELY-PICKED unmapped domain (You Pick / explicit-domain
  // entry). When set and still unmapped, the mapping band is SCOPED to just this
  // domain — even if its cross-domain prereqs aren't placed yet — so the pick maps
  // THAT domain (exactly as the retired standalone gate placed a chosen domain
  // directly), and the Home preview/serve for different tiles show DIFFERENT sets.
  // Absent (the default no-selection entry) keeps the breadth-first order across
  // every servable unmapped domain.
  forceLeadDomain?: string,
  practiceScope: PracticeScope = { kind: "open" },
): Promise<{ mappingItems: ServedItem[]; allMapping: boolean; mappingDomains: MappingDomainInfo[] }> {
  const scholarGrade = state.scholarGrade;
  const orderIndex = new Map(state.domains.map((d, i) => [d.domain, i] as const));
  // The domains to gather candidate probes from. A deliberate pick of a still-
  // unmapped domain scopes to JUST that domain (prereq-gating bypassed for the
  // pick); otherwise every servable unmapped domain competes, breadth-first.
  const scanDomains: MixedDomainCtx[] = (() => {
    if (
      forceLeadDomain &&
      practiceScopeAllowsDomain(practiceScope, forceLeadDomain) &&
      state.notMapped.has(forceLeadDomain)
    ) {
      const forced = state.domains.find((d) => d.domain === forceLeadDomain);
      if (forced) return [forced];
    }
    return state.servable.filter((domain) =>
      practiceScopeAllowsDomain(practiceScope, domain.domain),
    );
  })();
  const candidates: MappingCandidateAt[] = [];
  for (const d of scanDomains) {
    candidates.push(
      ...mappingCandidatesForDomain(
        d,
        state.runtime.get(d.domain)!.placementRow,
        placementGradePriors(d.domain, state.domains, state.runtime, scholarGrade),
        orderIndex.get(d.domain) ?? 999,
        MAPPING_SIT_CAP, // capped rows finalize through the client repair handshake
      ).filter((candidate) =>
        practiceScopeAllowsNode(practiceScope, candidate.domain, candidate.strand),
      ),
    );
  }
  // Probes already SERVED but unanswered, keyed by (domain, strand) — the ghost
  // guard's pin set. Only scanned domains can contribute; a probe parked on a
  // domain the band isn't scanning stays parked for whichever surface reaches it.
  const pinned = new Map<string, ServedProbe>();
  for (const d of scanDomains) {
    const served = state.runtime.get(d.domain)!.placementRow?.servedProbe;
    if (served) pinned.set(`${d.domain}\u0000${served.strand}`, served);
  }
  const plan = planMappingBand(candidates, hasOtherServable, { leadDomain });
  const mappingItems: ServedItem[] = [];
  for (const [i, pick] of plan.picks.entries()) {
    const d = state.domains.find((x) => x.domain === pick.domain);
    if (!d) continue;
    const pin = pinned.get(`${pick.domain}\u0000${pick.strand}`);
    if (pin) {
      // Re-serve the parked probe verbatim. `resolveServableItem` throws on an
      // item the engine no longer generates (a since-deleted manipulative row, a
      // retired template); fall through to a fresh probe rather than dropping the
      // strand from the band.
      try {
        mappingItems.push(mappingServedItem(await resolveServableItem(ctx, pin.itemId, pick.domain), pick.domain));
        continue;
      } catch {
        // fall through to the freshly-derived probe below
      }
    }
    const node = d.loaded.nodeByKey.get(pick.probeKey) ?? null;
    const itemId = makeItemId(pick.probeKey, probeSeed(seed, `${pick.domain}\u0000${pick.strand}`, i));
    const item = buildTemplateServable(itemId, node, pick.domain);
    if (!item) continue; // a since-removed template — skip (band shrinks gracefully)
    mappingItems.push(mappingServedItem(item, pick.domain));
  }
  const mappingDomains: MappingDomainInfo[] = state.domains
    .filter((d) => state.unmapped.has(d.domain))
    .map((d) => ({
      domain: d.domain,
      label: d.label,
      state: (state.runtime.get(d.domain)?.placementRow?.probeLog?.length ?? 0) > 0
        ? ("in_progress" as const)
        : ("unmapped" as const),
    }));
  return { mappingItems, allMapping: plan.allMapping, mappingDomains };
}

/** Result of the mapping post-process folded into `practiceSession`'s return. */
type MappingFinalize = {
  items: ServedItem[];
  segments: Segment[];
  allMapping: boolean;
  mappingDomains: MappingDomainInfo[];
  /** Already-recorded probes in the active all-mapping run. A fresh client
   *  adds its local item index so an auth remount resumes at N+1, not 1. */
  mappingProgressOffset: number;
};

/**
 * Assemble the "Fast math" sprint block for a run (fact automaticity, FastMath
 * analog), or `[]` when it should stay dormant. Finds the fact families this run
 * already exercises, loads the scholar's bounded per-fact ledger, assigns rows
 * by generator-family membership, and hands selection to the pure
 * `buildFactSprint`. Kept here (not in the pure lib) because it's the one part
 * that touches `ctx.db`.
 */
async function buildRunFactSprint(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  served: ServedItem[],
  fallbackDomain: string,
  seed: number,
): Promise<ServedItem[]> {
  // Which fact families is this run already working, and which exact facts are
  // already on the board (so the sprint never re-serves one)?
  const famByKey = new Map<string, SprintFamily>();
  const servedFactKeys = new Set<string>();
  for (const item of served) {
    if (!isFactFamilySkill(item.skillKey)) continue;
    if (!famByKey.has(item.skillKey)) {
      famByKey.set(item.skillKey, {
        skillKey: item.skillKey,
        label: item.skillLabel,
        domain: item.domain ?? fallbackDomain,
      });
    }
    if (item.factKey) servedFactKeys.add(item.factKey);
  }
  if (famByKey.size === 0) return [];

  // A passing proctored check is stronger evidence than this sparse retrieval
  // ledger. Licensed scholars keep ordinary fact-family reviews/frontier work,
  // but do not receive the extra sprint block.
  const license = await ctx.db
    .query("calculatorLicenses")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .first();
  if (license) return [];

  const factRows = await ctx.db
    .query("factFluency")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  const families = [...famByKey.values()];
  const rows: SprintFactRow[] = [];
  for (const r of factRows) {
    const family = families.find((candidate) =>
      factBelongsToFamily(r.factKey, candidate.skillKey),
    );
    if (!family) continue;
    rows.push({
      factKey: r.factKey,
      // A row records its most recently attempted family, but the same canonical
      // fact may belong to another active family. Generate through the active one.
      skillKey: family.skillKey,
      stats: {
        seenCount: r.seenCount,
        correctCount: r.correctCount,
        latencySamplesMs: r.latencySamplesMs,
        latencyMedianMs: r.latencyMedianMs,
      },
    });
  }
  if (rows.length === 0) return [];

  const baseline = await scholarLatencyBaseline(ctx, scholarId);
  return buildFactSprint({
    families,
    factRows: rows,
    baseline,
    alreadyServedFactKeys: servedFactKeys,
    seed: (seed >>> 0) ^ 0x5f3759df,
  });
}

/**
 * Insert the optional "Fast math" block into an already-finalized run and
 * splice matching segment metadata at the same boundary. The run itself owns
 * that boundary: any leading focus sweep stays first, followed by every due
 * review, then the sprint before frontier work.
 */
async function withRunFactSprint(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  composed: { items: ServedItem[]; segments: Segment[] },
  fallbackDomain: string,
  seed: number,
  eligible: boolean,
): Promise<{ items: ServedItem[]; segments: Segment[] }> {
  if (!eligible) return composed;
  const factSprint = await buildRunFactSprint(
    ctx,
    scholarId,
    composed.items,
    fallbackDomain,
    seed,
  );
  if (factSprint.length === 0) return composed;

  const items = [...composed.items];
  let at =
    composed.segments[0]?.kind === "sweep"
      ? composed.segments[0].count
      : 0;
  while (at < items.length && items[at].lane === "review") at += 1;
  items.splice(at, 0, ...factSprint);
  const segments = composed.segments.map((segment) => ({ ...segment }));
  const sprintSegment: Segment = {
    kind: "fact_sprint",
    count: factSprint.length,
  };
  let offset = 0;
  let inserted = false;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (at === offset) {
      segments.splice(index, 0, sprintSegment);
      inserted = true;
      break;
    }
    if (at < offset + segment.count) {
      const before = at - offset;
      const after = segment.count - before;
      segments.splice(
        index,
        1,
        { kind: segment.kind, count: before },
        sprintSegment,
        { kind: segment.kind, count: after },
      );
      inserted = true;
      break;
    }
    offset += segment.count;
  }
  if (!inserted) segments.push(sprintSegment);
  return { items, segments };
}

/**
 * Fold the `· mapping` band into an already-served playlist (the includeMapping
 * post-process). Suppresses frontier work in UNMAPPED domains (you don't drill
 * the frontier of a domain you haven't placed — its spots become mapping items),
 * places the mapping band AFTER due reviews and BEFORE new frontier work (Q2),
 * and recomposes segments. Only ever called on the default whole-graph/blend
 * entry (never a scoped problem set / stretch tail), so nothing else changes.
 */
async function finalizeWithMapping(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  seed: number,
  served: ServedItem[],
  domainOf: (item: ServedItem) => string,
  composeOpts: ComposeSegmentsOptions,
  leadDomain: string | undefined,
  // F2 (Q6): the deliberately-picked unmapped domain to scope the mapping band to
  // (see `buildMappingItems`). Undefined for the default no-selection entry.
  forceLeadDomain?: string,
  practiceScope: PracticeScope = { kind: "open" },
): Promise<MappingFinalize> {
  const state = await loadMappingState(ctx, scholarId);
  const kept = served.filter(
    (it) =>
      practiceScopeAllowsDomain(practiceScope, domainOf(it)) &&
      !state.ordinarySuppressed.has(domainOf(it)),
  );
  const hasOtherServable = kept.length > 0;
  const built = await buildMappingItems(
    ctx,
    scholarId,
    seed,
    state,
    hasOtherServable,
    leadDomain,
    forceLeadDomain,
    practiceScope,
  );
  // F7 zero-item guard (OPTION_D_RULINGS): a registered unmapped domain can have
  // nodes but no PROBEABLE template, so the mapping band comes back empty even
  // though `anyUnmappedDomain` was true. Suppressing that domain's ordinary work
  // then would yield a DEAD playlist. So when there's nothing to map, don't
  // suppress — fall back to the plain composition over everything served.
  if (built.mappingItems.length === 0) {
    const plain = composeSegments(served, composeOpts);
    return {
      items: plain.items,
      segments: plain.segments,
      allMapping: false,
      mappingDomains: built.mappingDomains,
      mappingProgressOffset: 0,
    };
  }
  const reviews = kept.filter((it) => it.lane === "review");
  const rest = kept.filter((it) => it.lane !== "review");
  const keptIds = new Set(kept.map((item) => item.itemId));
  const keptSweepCount =
    composeOpts.sweepCount === undefined
      ? undefined
      : served
          .slice(0, composeOpts.sweepCount)
          .filter((item) => keptIds.has(item.itemId)).length;
  const composed = composeSegments(
    [...reviews, ...built.mappingItems, ...rest],
    {
      ...composeOpts,
      sweepCount: keptSweepCount,
    },
  );
  return {
    items: composed.items,
    segments: composed.segments,
    allMapping: built.allMapping,
    mappingDomains: built.mappingDomains,
    mappingProgressOffset: built.allMapping
      ? (state.runtime.get(built.mappingItems[0]?.domain ?? "")
          ?.placementRow?.probeLog?.length ?? 0)
      : 0,
  };
}

/**
 * The scholar-facing mapping composition state (read-only) — the Home card + the
 * practice page read this to decide the ceremony-lite skin ("Math Check-In" at a
 * ~100% mapping ratio) and to show which domains are still mapping. `allMapping`
 * true = the next playlist is 100% mapping. Cheap for a placed scholar (the
 * pre-check short-circuits before any graph load).
 */
export const mappingPlaylistState = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const { practiceScope } = await resolvePracticeScope(ctx, args.scholarId);
    if (!(await anyUnmappedDomain(ctx, args.scholarId, practiceScope))) {
      return { hasMapping: false, allMapping: false, mappingDomains: [] as MappingDomainInfo[] };
    }
    const state = await loadMappingState(ctx, args.scholarId);
    // allMapping ⇔ the scholar has NO placed domain with real review/new work to
    // serve — i.e. every domain they've started is unmapped. A partially-placed
    // scholar (≥1 placed domain contributing frontier/review work) is a blend.
    const hasPlacedDomain = state.domains.some(
      (d) =>
        practiceScopeAllowsDomain(practiceScope, d.domain) &&
        !state.ordinarySuppressed.has(d.domain),
    );
    const built = await buildMappingItems(
      ctx,
      args.scholarId,
      0,
      state,
      /* hasOtherServable */ hasPlacedDomain,
      undefined,
      undefined,
      practiceScope,
    );
    return {
      hasMapping: built.mappingItems.length > 0,
      allMapping: built.allMapping,
      mappingDomains: built.mappingDomains,
    };
  },
});

function resolvedMappingFrontiers(
  orders: StrandOrder[],
  row: Doc<"practicePlacements">,
  log: NonNullable<Doc<"practicePlacements">["probeLog"]>,
) {
  const { outcomes } = outcomesFromProbeLog(log);
  const floors = floorsFromPlacementRow(orders, row);
  return orders.map((order) =>
    strandFrontier(
      order.strand,
      order.orderedKeys,
      outcomes,
      floors.get(order.strand) ?? 0,
    ),
  );
}

async function finalizeMappingPlacementRow(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  domain: string,
  row: Doc<"practicePlacements">,
  loaded: Awaited<ReturnType<typeof loadPlacementContext>>,
  now: number,
  log = row.probeLog ?? [],
): Promise<void> {
  const frontiers = resolvedMappingFrontiers(loaded.orders, row, log);
  const frontierByStrand = frontiers
    .filter((frontier) => frontier.frontierKey !== null)
    .map((frontier) => ({
      strand: frontier.strand,
      frontierKey: frontier.frontierKey!,
    }));
  await ctx.db.patch(row._id, {
    status: "complete" as const,
    probesAnswered: log.length,
    probeLog: log,
    servedProbe: undefined,
    frontierByStrand,
    updatedAt: now,
  });
  await creditPlacementFrontiers(
    ctx,
    scholarId,
    domain,
    frontiers,
    {
      nodes: loaded.nodes,
      edges: loaded.edges,
      nodeByKey: loaded.nodeByKey,
    },
    now,
  );
}

/**
 * Re-entry repair for a client that completed the humane mapping sitting before
 * the server owned that boundary. Idempotent and atomic: capped in-progress rows
 * are finalized through the same trust-upward path as item 18, before either
 * frontend composes a fresh playlist.
 */
export const finalizeCappedMappingRuns = authedMutation({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) {
      await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    }
    const rows = await ctx.db
      .query("practicePlacements")
      .withIndex("by_scholar_domain", (q) =>
        q.eq("scholarId", args.scholarId),
      )
      .collect();
    const finalizedDomains: string[] = [];
    for (const row of rows) {
      if (
        row.status !== "in_progress" ||
        (row.probeLog?.length ?? 0) < MAPPING_SIT_CAP
      ) {
        continue;
      }
      // Always finalize through the SAME trust-upward path as probe 18: resolve
      // the per-strand frontiers and credit them. The old `existingMastery`
      // shortcut (stamp "complete" without crediting) existed ONLY to dodge the
      // unconditional insert that would have shadowed demonstrated mastery — now
      // that `creditPlacementFrontiers` upserts raise-only, the shortcut is both
      // unnecessary and WRONG: a shadow-placed domain hitting the cap would be
      // marked converged (counted in N) with no resolved frontier and no credit.
      const loaded = await loadPlacementContext(ctx, row.domain);
      await finalizeMappingPlacementRow(
        ctx,
        args.scholarId,
        row.domain,
        row,
        loaded,
        Date.now(),
      );
      finalizedDomains.push(row.domain);
    }
    return { finalizedDomains };
  },
});

/**
 * Grade one `· mapping` answer (Option D). A mapping item is a placement probe
 * served in the daily playlist; grading it writes INFERRED credit through the
 * SAME trust-upward `creditPlacementFrontiers` path the check-in uses — the
 * two-axis invariant is preserved (source "placement", never demonstrated
 * fluency). Reveal-only + the warmth floor (PLACEMENT_POLICY + placementFeedback).
 * Deterministic-by-id (no single held `servedProbe`): the probe re-derives from
 * its itemId, so a batch of mapping items grades independently. Idempotent per
 * itemId (a resume re-submit / retry never double-logs). Finalizes + credits the
 * domain the instant its per-strand searches converge → `domainJustMapped` (the
 * "Your tree just filled in ✨" moment).
 */
export const submitMappingAnswer = authedMutation({
  args: {
    scholarId: v.id("users"),
    domain: v.string(),
    itemId: v.string(),
    seed: v.number(),
    answer: v.optional(v.string()),
    dontKnow: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const domain = args.domain;
    const now = Date.now();
    const loaded = await loadPlacementContext(ctx, domain);
    const { orders, nodeByKey, isProbeable } = loaded;

    let row = await ctx.db
      .query("practicePlacements")
      .withIndex("by_scholar_domain", (q) => q.eq("scholarId", args.scholarId).eq("domain", domain))
      .first();

    // Guard: this domain's run already CONVERGED — a stale mapping item from a
    // since-mapped domain (e.g. a sibling probe in this very batch just converged
    // it). Credit NOTHING and never touch the probeLog. But the scholar DID
    // answer a real, resolvable item, so grade it READ-ONLY and return its reveal
    // + warm line — the client shows that acknowledgement, THEN recomposes past
    // the finished domain's stale tail (F3 batch-boundary reveal swallow). An
    // unresolvable / cross-domain id has nothing to reveal, so it stays a bare
    // no-op. The guard used to fire on mastery EXISTENCE, which made a
    // shadow-placed domain permanently ungradeable (finish-the-check-in, founder
    // 2026-08-18: mastery is not a map).
    if (row?.status === "complete") {
      const staleKey = parseItemId(args.itemId)?.skillKey;
      if (staleKey && nodeByKey.has(staleKey)) {
        const item = await resolveServableItem(ctx, args.itemId, domain);
        const rawAnswer =
          item.kind === "manipulative"
            ? args.answer !== undefined
              ? args.answer.slice(0, MAX_MANIPULATIVE_STATE_LEN)
              : undefined
            : sanitizePlacementAnswer(args.answer);
        const submission: Submission = args.dontKnow
          ? { kind: "dontKnow" }
          : item.kind === "manipulative"
            ? { kind: "manipulativeState", stateJson: args.answer ?? "" }
            : { kind: "typed", raw: rawAnswer ?? "" };
        const grade = gradeSubmission(item, submission, PLACEMENT_POLICY);
        const kind: PlacementOutcomeKind = grade.isDontKnow
          ? "unknown"
          : grade.correct
            ? "correct"
            : "incorrect";
        return {
          alreadyMapped: true,
          outcome: kind as PlacementOutcomeKind | null,
          correctAnswer: (grade.revealedAnswer ?? null) as string | null,
          unitOutcome: grade.unitOutcome,
          domainJustMapped: false,
          domainLabel: practiceDomainLabel(domain),
          feedback: placementFeedback(kind, grade.revealedAnswer ?? undefined),
        };
      }
      return {
        alreadyMapped: true,
        outcome: null as PlacementOutcomeKind | null,
        correctAnswer: null as string | null,
        unitOutcome: undefined as "missing" | "wrong" | undefined,
        domainJustMapped: false,
        domainLabel: practiceDomainLabel(domain),
        feedback: null as ReturnType<typeof placementFeedback> | null,
      };
    }

    const parsed = parseItemId(args.itemId);
    const nodeKey = parsed?.skillKey;
    if (!nodeKey || !nodeByKey.has(nodeKey)) {
      // An unresolvable / cross-domain id — never grade it against this domain.
      return {
        alreadyMapped: false,
        outcome: null as PlacementOutcomeKind | null,
        correctAnswer: null as string | null,
        unitOutcome: undefined as "missing" | "wrong" | undefined,
        domainJustMapped: false,
        domainLabel: practiceDomainLabel(domain),
        feedback: null as ReturnType<typeof placementFeedback> | null,
      };
    }
    const strand = nodeByKey.get(nodeKey)?.strand ?? DEFAULT_PLACEMENT_STRAND;

    // Idempotency, per ITEM and per NODE. The item match catches a resume
    // re-submit or a retry of the same band item. The NODE match is the
    // cross-surface case (finish-the-check-in, founder 2026-08-18): the two
    // serving surfaces seed item ids in different namespaces, so a probe answered
    // through the check-in and then submitted late from an abandoned band batch
    // carries a DIFFERENT id for the SAME node — and would otherwise log a second
    // entry for it.
    //
    // "Confirm before you cap" is the ONE legitimate re-serve of an
    // already-answered node: a node with a single unconfirmed miss (a possible
    // slip) is re-served as a FRESH item, and that confirm MUST be recorded — not
    // swallowed as a cross-surface duplicate. So a nodeKey match is a duplicate
    // only when it is NOT a confirm: the node isn't pending (a single miss), or
    // this is a resubmit of the exact same item id.
    const itemDuplicate = row?.probeLog?.find((e) => e.itemId === args.itemId);
    const nodeEntries = (row?.probeLog ?? []).filter((e) => e.nodeKey === nodeKey);
    const nodeIsPending = nodeEntries.length === 1 && nodeEntries[0].outcome === "incorrect";
    const priorEntry = itemDuplicate ?? (nodeIsPending ? undefined : nodeEntries[0]);
    if (priorEntry) {
      const priorKind = priorEntry.outcome as PlacementOutcomeKind;
      return {
        alreadyMapped: false,
        outcome: priorKind,
        correctAnswer: null as string | null,
        unitOutcome: undefined as "missing" | "wrong" | undefined,
        domainJustMapped: false,
        domainLabel: practiceDomainLabel(domain),
        feedback: placementFeedback(priorKind),
      };
    }

    // Resolve + grade under the PLACEMENT policy (reveal-only, warmth floor,
    // ternary). A manipulative probe grades via isSolved and never reveals.
    const item = await resolveServableItem(ctx, args.itemId, domain);
    const rawAnswer =
      item.kind === "manipulative"
        ? args.answer !== undefined
          ? args.answer.slice(0, MAX_MANIPULATIVE_STATE_LEN)
          : undefined
        : sanitizePlacementAnswer(args.answer);
    const answerText = args.dontKnow
      ? undefined
      : attemptAnswerText(item, args.answer);
    const submission: Submission = args.dontKnow
      ? { kind: "dontKnow" }
      : item.kind === "manipulative"
        ? { kind: "manipulativeState", stateJson: args.answer ?? "" }
        : { kind: "typed", raw: rawAnswer ?? "" };
    const grade = gradeSubmission(item, submission, PLACEMENT_POLICY);
    const correctAnswer = grade.revealedAnswer;
    const kind: PlacementOutcomeKind = grade.isDontKnow
      ? "unknown"
      : grade.correct
        ? "correct"
        : "incorrect";

    await ctx.db.insert("practiceAttempts", {
      scholarId: args.scholarId,
      nodeKey,
      itemId: args.itemId,
      correct: outcomeCredits(kind),
      ...(answerText !== undefined ? { answerText } : {}),
      ...(kind !== "correct"
        ? {
            ...(sanitizeStemSnapshot(grade.stem) !== undefined
              ? { stemSnapshot: sanitizeStemSnapshot(grade.stem) }
              : {}),
            ...(grade.correctAnswer
              ? { expectedAnswer: sanitizePlacementAnswer(grade.correctAnswer) }
              : {}),
          }
        : {}),
      domain,
      strand,
      lane: "placement",
      breakerEligible: false,
      repetitionBefore: 0,
      source: "placement",
      ...(kind !== "correct"
        ? { explanationReason: kind === "unknown" ? "dont_know" : "miss", explanationRequestedAt: now }
        : {}),
      createdAt: now,
    });

    const log = [
      ...(row?.probeLog ?? []),
      {
        nodeKey,
        strand,
        outcome: kind,
        at: now,
        ...(rawAnswer !== undefined ? { answerRaw: rawAnswer } : {}),
        itemId: args.itemId,
      },
    ];
    if (row) {
      await ctx.db.patch(row._id, {
        probesAnswered: log.length,
        probeLog: log,
        servedProbe: undefined,
        updatedAt: now,
      });
    } else {
      const id = await ctx.db.insert("practicePlacements", {
        scholarId: args.scholarId,
        domain,
        status: "in_progress" as const,
        probesAnswered: log.length,
        probeLog: log,
        servedProbe: undefined,
        updatedAt: now,
      });
      row = await ctx.db.get(id);
    }

    // Converged? every strand's search has nothing left (or the global cap). The
    // RING CEILING is the scholar's real grade, exactly as both serve paths use
    // it, so serve and grade agree on the boundary. The first-probe target is
    // deliberately the plain scholar grade here rather than the serve side's
    // cross-domain-inferred start: this asks only WHETHER a probe remains, and
    // that answer is invariant to the target (`nextStrandProbe` searches its whole
    // window outward from it), so re-deriving the inferred prior would cost a
    // full multi-domain graph load per answered item and buy nothing.
    const scholarGrade = await scholarGradeLevel(ctx, args.scholarId);
    const { outcomes } = outcomesFromProbeLog(log);
    const floors = floorsFromPlacementRow(orders, row);
    const firstTargets = firstProbeTargets(orders, nodeByKey, scholarGrade);
    const gradeOf = (key: string): string | undefined => nodeByKey.get(key)?.grade;
    const capHit = log.length >= MAPPING_SIT_CAP;
    // The next probe of every strand under the SAME derivation both serve paths
    // use, so serve and grade agree on the boundary. Beyond answering "does a
    // probe remain?" (convergence) this also surfaces a `pendingConfirm` on the
    // just-answered node — the strand still has confirm budget for its single
    // miss, so a fresh confirm item is due (see the retry block below).
    let anyLeft = false;
    let confirmProbe: { strand: string; index: number } | null = null;
    if (!capHit) {
      for (const o of orders) {
        const probe = nextStrandProbe(o.orderedKeys, isProbeable, outcomes, {
          resumeFloor: floors.get(o.strand) ?? 0,
          firstProbeTarget: firstTargets.get(o.strand),
          gradeOf,
          scholarGrade,
        });
        if (probe === null) continue;
        anyLeft = true;
        if (probe.pendingConfirm && probe.probeKey === nodeKey) {
          confirmProbe = { strand: o.strand, index: probe.index };
        }
      }
    }

    // "Confirm before you cap" on the mapping band: a FIRST typed miss whose
    // strand still has confirm budget re-serves a FRESH item on the SAME skill
    // IMMEDIATELY — the founder ruling that INTERRUPTS the band's breadth-first
    // order (a confirm arriving strands later is meaningless to a child; see
    // lib/practice/mapping.ts). The scholar surface then offers the two-way
    // slip/concede choice against this served item. Server-computed only — never
    // a client flag: `retry` is true iff the graded outcome was an incorrect
    // FIRST outcome on the node AND the strand still has confirm budget (the
    // pendingConfirm above). A pending node is never converged, so `retry` and
    // `domainJustMapped` are mutually exclusive.
    const firstOutcomeOnNode = nodeEntries.length === 0;
    let retryItem: ServedItem | null = null;
    if (kind === "incorrect" && firstOutcomeOnNode && confirmProbe) {
      const strandSeedKey = `${domain}\u0000${confirmProbe.strand}`;
      // Perturb the seed by the node's attempt count (=1 for the first confirm),
      // exactly as buildServedProbe does, so the confirm is a DIFFERENT item than
      // the one just missed and can't be brute-forced from the stable client seed.
      const attempt = log.filter((e) => e.nodeKey === nodeKey).length;
      const base = probeSeed(args.seed, strandSeedKey, confirmProbe.index);
      const confirmSeed = Math.imul(base ^ (attempt * 0x9e3779b1), 2654435761) >>> 0;
      const confirmItemId = makeItemId(nodeKey, confirmSeed);
      const built = buildTemplateServable(confirmItemId, nodeByKey.get(nodeKey) ?? null, domain);
      // A node without a template (a manipulative-only skill) can't serve a
      // template confirm here — fall back to the plain cap path (retry stays off).
      if (built) retryItem = mappingServedItem(built, domain);
    }

    let domainJustMapped = false;
    if (!anyLeft) {
      // Finalize + credit (identical trust-upward crediting to the check-in's
      // finalizeDomain): everything below each strand's frontier lands FLUENT at
      // the short placement half-life, source "placement" (inferred).
      await finalizeMappingPlacementRow(
        ctx,
        args.scholarId,
        domain,
        row!,
        loaded,
        now,
        log,
      );
      domainJustMapped = true;
    }

    return {
      alreadyMapped: false,
      outcome: kind,
      correctAnswer: correctAnswer ?? null,
      unitOutcome: grade.unitOutcome,
      domainJustMapped,
      domainLabel: practiceDomainLabel(domain),
      probeLogIndex: log.length - 1,
      feedback: placementFeedback(kind, correctAnswer ?? undefined),
      // "Confirm before you cap": the fresh confirm item to render next (a first
      // typed miss with budget), else null. `retry` is the boolean the scholar
      // surface keys the slip/concede moment off.
      retry: retryItem !== null,
      retryItem,
    };
  },
});

// ── Manipulative Socratic context (U-4) — the practice handoff's context ────
// A manipulative gen# item resolved to its no-leak tutor context: the concept,
// the authored one-line prompt, and a plain restatement of the task (goalText).
// Optionally describes the submitted board (describeState) when a state is
// passed. Returns null for a non-gen#/non-manipulative/unresolvable id (so the
// caller falls through to the template path or "none"). TOTAL: a malformed id
// (e.g. "gen#abc123") can't crash it — the db.get is guarded.
async function resolveManipulativeItemContext(
  ctx: QueryCtx,
  itemId: string,
  stateJson?: string,
): Promise<{ concept: string; prompt: string; task: string; skillKey: string; boardState: string | null } | null> {
  if (!itemId.startsWith("gen#")) return null;
  let doc: Doc<"practiceItems"> | null = null;
  try {
    doc = await ctx.db.get(itemId.slice(4) as Id<"practiceItems">);
  } catch {
    return null; // a malformed doc id → not a resolvable item
  }
  if (!doc || doc.verifierKind !== MANIPULATIVE_VERIFIER_KIND) return null;
  const spec = parseManipulativeSpec(doc.manipulativeSpec);
  if (!spec || isRetiredManipulativeSpecId(spec.id)) return null;
  return {
    concept: spec.concept,
    prompt: spec.prompt,
    task: manipulativeGoalText(spec),
    skillKey: doc.skillKey,
    boardState: stateJson ? describeManipulativeState(spec, stateJson) : null,
  };
}

// ── Manipulative Socratic handoff context (/practice-handoff) ───────────────
// The manipulative twin of deriveHandoffItem (which handles TEMPLATE ids). The
// /practice-handoff httpAction resolves a gen# manipulative item to its no-leak
// context here, passing the scholar's most-recent submitted state so the opener
// can be grounded in what their board actually shows. Auth-free like
// getManipulativeItem: a manipulative spec carries no answer to leak (the goal
// IS the visible task), and the handoff route intentionally binds no scholarId.
export const manipulativeHandoffContext = internalQuery({
  args: { itemId: v.string(), stateJson: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const ctxData = await resolveManipulativeItemContext(ctx, args.itemId, args.stateJson);
    if (!ctxData) return null;
    return ctxData;
  },
});

// ── Strand re-probe (B1 Mechanism 2 — raise-the-ceiling §4) ─────────────────
// Reuses the placement binary search MID-STREAM: when a scholar keeps
// valve-jumping in a strand (under-placed), OFFER a re-probe that moves the
// whole strand frontier at once instead of grinding node-by-node. Credits the
// newly cleared nodes PROVISIONALLY (source "reprobe", placement's short leash)
// — per P1 that's access-proven-but-not-green until practiced. The offer + the
// "⛰ your frontier moved" reveal are rendered elsewhere; this layer only writes
// provenance faithfully and makes no display claim.

/** The scholar's current frontier index in a strand = the count of leading
 *  access-proven nodes in the strand's topological order (the re-probe searches
 *  UP from here). */
function currentStrandFloor(
  orderedKeys: string[],
  mastery: Map<string, Doc<"practiceMastery">>,
): number {
  let floor = 0;
  for (const key of orderedKeys) {
    const row = mastery.get(key);
    if (row && accessProven(row)) floor++;
    else break;
  }
  return floor;
}

/**
 * Which strands the scholar is a re-probe CANDIDATE in (data only — no display
 * claim). A strand qualifies once it holds ≥ REPROBE_STRAND_ACCEL valve-
 * accelerated credits AND still has headroom above the current floor.
 */
export const reprobeCandidates = authedQuery({
  args: { scholarId: v.id("users"), domain: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const domain = args.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN;
    const { orders } = await loadPlacementContext(ctx, domain);
    const mastery = await loadMastery(ctx, args.scholarId, domain);

    const candidates: { strand: string; frontierKey: string; acceleratedCount: number }[] = [];
    for (const o of orders) {
      let accel = 0;
      for (const key of o.orderedKeys) {
        if (mastery.get(key)?.source === ACCEL_SOURCE) accel++;
      }
      if (!shouldOfferReprobe(accel)) continue;
      const floor = currentStrandFloor(o.orderedKeys, mastery);
      if (floor >= o.orderedKeys.length) continue; // whole strand already cleared
      candidates.push({ strand: o.strand, frontierKey: o.orderedKeys[floor], acceleratedCount: accel });
    }
    return { candidates };
  },
});

/**
 * Serve the next re-probe item for ONE strand, given the client's accumulated
 * answers so far. Searches UP from the scholar's current frontier (resume floor
 * derived from mastery); returns { done: true } once converged or nothing
 * probeable remains. Deterministic in `seed`.
 */
export const reprobeProbes = authedQuery({
  args: {
    scholarId: v.id("users"),
    strand: v.string(),
    domain: v.optional(v.string()),
    answers: v.array(v.object({ itemId: v.string(), answer: v.string() })),
    seed: v.number(),
  },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const domain = args.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN;
    const { orders, isProbeable } = await loadPlacementContext(ctx, domain);
    const order = orders.find((o) => o.strand === args.strand);
    if (!order) return { probe: null, done: true };
    const mastery = await loadMastery(ctx, args.scholarId, domain);
    const floor = currentStrandFloor(order.orderedKeys, mastery);
    const outcomes = gradeOutcomes(args.answers);
    const next = nextStrandProbe(order.orderedKeys, isProbeable, outcomes, { resumeFloor: floor });
    if (!next) return { probe: null, done: true };
    const seed = probeSeed(args.seed, args.strand, next.index);
    const item = generateItem(next.probeKey, seed);
    if (!item) return { probe: null, done: true };
    const answerShape = expressionAnswerSignals(item.answerType, item.answer).answerShape;
    return {
      probe: {
        itemId: makeItemId(next.probeKey, seed),
        skillKey: next.probeKey,
        stem: item.stem,
        answerType: item.answerType,
        // Display form ("cm³"), same non-leaky echo the drill serves — the
        // grader (`gradeOutcomes` → `gradeSubmission`) enforces the unit, so
        // the probe wire must let the client offer + gate it.
        ...(item.answerUnit ? { answerUnit: formatUnit(item.answerUnit) } : {}),
        choices: item.choices,
        promptVisual: item.promptVisual,
        ...(answerShape ? { answerShape } : {}),
      },
      done: false,
    };
  },
});

/**
 * Finalize a strand re-probe: grade the accumulated answers, move the frontier
 * up, and credit the NEWLY cleared nodes (strictly above the old floor)
 * provisionally — source "reprobe", repetition FLUENT_REPS at the short
 * placement half-life. Recomputes the domain frontier and fires gated seeds.
 */
export const submitReprobe = authedMutation({
  args: {
    scholarId: v.id("users"),
    strand: v.string(),
    domain: v.optional(v.string()),
    answers: v.array(v.object({ itemId: v.string(), answer: v.string() })),
  },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const domain = args.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN;
    const now = Date.now();
    const { nodes, edges, orders, nodeByKey } = await loadPlacementContext(ctx, domain);
    const order = orders.find((o) => o.strand === args.strand);
    if (!order) {
      return { moved: false, creditedKeys: [] as string[], frontierKey: null as string | null };
    }

    let mastery = await loadMastery(ctx, args.scholarId, domain);
    const oldFloor = currentStrandFloor(order.orderedKeys, mastery);
    const outcomes = gradeOutcomes(args.answers);
    const front = strandFrontier(args.strand, order.orderedKeys, outcomes, oldFloor);

    // Credit only the NEWLY cleared nodes (above the old floor). Trust upward,
    // provisional: source "reprobe" ∉ DEMONSTRATED_SOURCES, so these read as
    // "advanced, unconfirmed" until practiced; the short leash self-corrects.
    const newlyCredited = front.creditedKeys.slice(oldFloor);
    for (const key of newlyCredited) {
      const existing = mastery.get(key);
      const rowFields = {
        scholarId: args.scholarId,
        skillKey: key,
        domain,
        strand: nodeByKey.get(key)?.strand,
        repetition: FLUENT_REPS,
        halfLifeDays: PLACEMENT_HALF_LIFE_DAYS,
        lastPracticedAt: now,
        frontier: false,
        source: REPROBE_SOURCE,
        updatedAt: now,
        // Clearing a HIGHER node is a more recent determination of fluency, and
        // that is exactly what supersedes earlier misses (the same rule that makes
        // a correct answer zero this in recordAttemptCore). Without it the stale
        // streak survives the credit and `masteryOf` keeps returning "struggling",
        // which is TOP priority and would paint a just-credited node red on the
        // teacher's map and re-fire the Today "Needs a look" lane until an
        // unrelated correct answer happened to clear it. Note the re-probe is the
        // one trust-upward site that OVERWRITES an existing row wholesale;
        // `creditPlacementFrontiers` upserts raise-only (it can meet a demonstrated
        // row it must not downgrade), and the accel seed only inserts fresh ones.
        missStreak: 0,
      };
      if (existing) await ctx.db.patch(existing._id, rowFields);
      else await ctx.db.insert("practiceMastery", rowFields);
      await maybeFireSeeds(ctx, args.scholarId, key);
    }

    // Recompute the denormalized frontier flag from fresh mastery.
    mastery = await loadMastery(ctx, args.scholarId, domain);
    const stateOf = await buildFrontierStateOf(ctx, args.scholarId, nodes.map((n) => n.nodeKey), edges, mastery);
    const frontier = new Set(
      computeFrontier(
        nodes.map((n) => n.nodeKey),
        edges,
        stateOf,
      ),
    );
    for (const row of mastery.values()) {
      const shouldBe = frontier.has(row.skillKey);
      if (row.frontier !== shouldBe) await ctx.db.patch(row._id, { frontier: shouldBe });
    }

    return { moved: newlyCredited.length > 0, creditedKeys: newlyCredited, frontierKey: front.frontierKey };
  },
});


/**
 * ONE-OFF REPAIR — re-open placement runs that a SLIP finalized under the old
 * rule (confirm-before-you-cap).
 *
 * Before that fix a single typed miss lowered a strand's ceiling permanently, so
 * a scholar who slipped once was finalized AT the slipped skill with everything
 * above it locked away. The fix changed the SEARCH, not the stored runs: a
 * converged row still reads `status: "complete"`, and `domainMapStatus` treats
 * exactly that as "mapped", so the check-in will never revisit it.
 *
 * The repair is therefore not a data rewrite and grants NO credit. Every such
 * row already carries, in its `probeLog`, a single unconfirmed `incorrect` on
 * the capping node — which under the new rule IS a pending confirm. Re-opening
 * the row simply lets the normal check-in serve that confirm, and the scholar
 * re-earns the ceiling by answering. A genuine gap re-caps in the same place, so
 * this is safe without classifying which misses were slips.
 *
 * Derivation is the SAME `nextStrandProbe` the serve paths use — no second
 * notion of "is a confirm due" — so a row is reopened only when the live engine
 * would actually serve one. Dry-run by default: pass `apply: true` to write.
 */
export const reopenSlipCappedPlacement = internalMutation({
  args: { scholarId: v.id("users"), apply: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const apply = args.apply === true;
    const rows = await ctx.db
      .query("practicePlacements")
      .withIndex("by_scholar_domain", (q) => q.eq("scholarId", args.scholarId))
      .collect();

    const scholarGrade = await scholarGradeLevel(ctx, args.scholarId);
    const plan: {
      domain: string;
      confirmNodes: string[];
      lockedAbove: number;
      reopened: boolean;
    }[] = [];
    const skipped: { domain: string; reason: string }[] = [];

    for (const row of rows) {
      // Only a CONVERGED run is invisible to the check-in; an in-flight one will
      // reach its pending confirm on its own.
      if (row.status !== "complete") continue;
      const { orders, nodeByKey, isProbeable } = await loadPlacementContext(ctx, row.domain);
      const { outcomes } = outcomesFromProbeLog(row.probeLog);
      const floors = floorsFromPlacementRow(orders, row);
      const firstTargets = firstProbeTargets(orders, nodeByKey, scholarGrade);
      const gradeOf = (key: string): string | undefined => nodeByKey.get(key)?.grade;

      const confirmNodes: string[] = [];
      for (const o of orders) {
        const probe = nextStrandProbe(o.orderedKeys, isProbeable, outcomes, {
          resumeFloor: floors.get(o.strand) ?? 0,
          firstProbeTarget: firstTargets.get(o.strand),
          gradeOf,
          scholarGrade,
        });
        if (probe?.pendingConfirm) confirmNodes.push(probe.probeKey);
      }
      if (confirmNodes.length === 0) continue;

      // NOTHING-TO-RECOVER GUARD. A confirm is only worth re-opening a finished
      // run for when there is locked ground ABOVE it. A domain the scholar is
      // fully credited in has none: re-opening would un-map a finished domain,
      // add questions to an already-long check-in, and — if the confirm is
      // missed a second time — cap a strand that is currently complete. So the
      // repair can only ever give ground back, never take it.
      // (Caught by the production dry run: the first scholar's whole-number
      // domain surfaced a real pending confirm while sitting at 87/87 credited,
      // i.e. a pure-cost re-open.)
      const mastery = await loadMastery(ctx, args.scholarId, row.domain);
      const lockedAbove = [...nodeByKey.keys()].filter(
        (key) => (mastery.get(key)?.repetition ?? 0) === 0,
      ).length;
      if (lockedAbove === 0) {
        skipped.push({ domain: row.domain, reason: "nothing-locked-above" });
        continue;
      }

      if (apply) {
        // Clear `servedProbe` too: a converged row's parked probe is stale, and
        // the next serve must pick the pending confirm rather than resume it.
        await ctx.db.patch(row._id, {
          status: "in_progress",
          servedProbe: undefined,
          updatedAt: Date.now(),
        });
      }
      plan.push({ domain: row.domain, confirmNodes, lockedAbove, reopened: apply });
    }

    return {
      applied: apply,
      domains: plan,
      skipped,
      confirmProbes: plan.reduce((n, d) => n + d.confirmNodes.length, 0),
      skillsRecoverable: plan.reduce((n, d) => n + d.lockedAbove, 0),
    };
  },
});

export const placeScholarInternal = internalMutation({
  args: { scholarId: v.id("users"), throughGrade: v.string(), domain: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const domain = args.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN;
    const now = Date.now();
    const skills = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .collect();
    const cutoff = gradeRank(args.throughGrade);
    let n = 0;
    for (const s of skills) {
      if (!s.grade || gradeRank(s.grade) > cutoff) continue;
      const existing = await ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar_skill", (q) => q.eq("scholarId", args.scholarId).eq("skillKey", s.nodeKey))
        .first();
      if (existing) continue;
      await ctx.db.insert("practiceMastery", {
        scholarId: args.scholarId,
        skillKey: s.nodeKey,
        domain,
        strand: s.strand,
        repetition: FLUENT_REPS,
        halfLifeDays: 60,
        lastPracticedAt: now - 2 * 86_400_000,
        frontier: false,
        source: "placement",
        updatedAt: now,
      });
      n++;
    }
    return { placed: n };
  },
});

/** Resolve a problem-set activity to the skills it practices (for scholar launch). */
export const problemSetSkills = authedQuery({
  args: { activityId: v.id("activities") },
  handler: async (ctx, args) => {
    const a = await ctx.db.get(args.activityId);
    if (!a || a.kind !== "problem_set") return null;
    return {
      title: a.title,
      targetSkillKeys: a.problemSet?.targetSkillKeys ?? [],
      itemCount: a.problemSet?.itemCount ?? 10,
      domain: a.problemSet?.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN,
    };
  },
});

/** Create a problem-set activity on a lesson (teacher/curriculum-bot path). */
export const createProblemSetActivity = internalMutation({
  args: {
    lessonId: v.id("lessons"),
    title: v.string(),
    targetSkillKeys: v.optional(v.array(v.string())),
    grade: v.optional(v.string()), // resolve all skills at this grade if no keys given
    itemCount: v.optional(v.number()),
    domain: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const domain = args.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN;
    let keys = args.targetSkillKeys ?? [];
    if (keys.length === 0 && args.grade) {
      // knowledgeNodes has no by_domain_grade index → read the domain and filter.
      const skills = await ctx.db
        .query("knowledgeNodes")
        .withIndex("by_domain", (q) => q.eq("domain", domain))
        .collect();
      keys = skills.filter((s) => s.grade === args.grade).map((s) => s.nodeKey);
    }
    if (keys.length === 0) throw new Error("Provide targetSkillKeys or a grade with skills");
    const siblings = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (q) => q.eq("lessonId", args.lessonId))
      .collect();
    const id = await ctx.db.insert("activities", {
      lessonId: args.lessonId,
      title: args.title,
      kind: "problem_set",
      order: siblings.length,
      problemSet: { domain, targetSkillKeys: keys, itemCount: args.itemCount ?? 10 },
    });
    await scheduleProblemSetItemGeneration(ctx, id);
    return { activityId: id, skillCount: keys.length };
  },
});

const GRADE_RANK = (g: string) => ["K", "1", "2", "3", "4", "5", "6", "7", "8", "9"].indexOf(g);

/**
 * Each skill's DAG depth: the length of its longest prerequisite chain from a
 * root (a no-prereq skill), via the "buildsOn" edges. Grade is a poor proxy
 * for this — grade bands overlap heavily in depth (e.g. in the whole-number-
 * arithmetic graph, grade-2 skills span depth 3–12) — so `devSeedPractice`
 * bands mastery by depth, not grade. Memoized recursion; guarded against a
 * (shouldn't-happen — buildsOn is validated acyclic) cycle so a bad edge
 * can't blow the stack.
 */
function dagDepths(skillKeys: string[], edges: GraphEdge[]): Map<string, number> {
  const prereqs = new Map<string, string[]>();
  for (const key of skillKeys) prereqs.set(key, []);
  for (const e of edges) if (prereqs.has(e.toKey)) prereqs.get(e.toKey)!.push(e.fromKey);
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  function depthOf(key: string): number {
    const cached = depth.get(key);
    if (cached !== undefined) return cached;
    if (visiting.has(key)) return 0;
    visiting.add(key);
    const ps = prereqs.get(key) ?? [];
    const d = ps.length === 0 ? 0 : 1 + Math.max(...ps.map(depthOf));
    visiting.delete(key);
    depth.set(key, d);
    return d;
  }
  for (const key of skillKeys) depthOf(key);
  return depth;
}

/**
 * Dev fixture: give a scholar a realistic mid-graph position so the map +
 * practice demo from a believable spot — a deep, mostly-fluent foundation,
 * NOT a wall of "overlearned". Bands mastery by each skill's DAG depth
 * (`dagDepths`, above), anchored to a `reachDepth` — the deepest skill at/
 * below `throughGrade`, i.e. roughly how far a scholar who's finished that
 * grade band has climbed:
 *   - depth <= reachDepth-2 → the deep foundation: mostly "fluent" (rep 3-4),
 *     a sprinkling (1-in-5) "overlearned" (rep 5-6). Every prereq a level-
 *     (reachDepth-1) skill needs lives in here, so it's ALWAYS fluent+.
 *   - depth == reachDepth-1 → the frontier candidates (rep 0-1, some never
 *     touched, some just dipped in). Because the ENTIRE foundation below is
 *     fluent+, every one of these is guaranteed to satisfy computeFrontier's
 *     "all prereqs fluent" test — this is the tier that actually lights up
 *     `frontier: true` below, deterministically (verified against the real
 *     buildsOn graph, not just asserted).
 *   - depth == reachDepth   → a mid/practicing band (rep 1-2): every one of
 *     these has at least one prereq back at depth reachDepth-1 — which is
 *     NOT fluent (it's the frontier tier above) — so this band is just as
 *     deterministically guaranteed to stay `frontier: false`. Read as "the
 *     scholar has poked at these a couple of times, but hasn't unlocked them
 *     yet" — practicing, not yet reachable.
 *   - depth > reachDepth    → beyond the frontier: no row at all (the engine
 *     treats a missing skill as repetition 0 — locked).
 * `frontier` is nonetheless recomputed via `computeFrontier` against the real
 * graph once seeding is done (mirrors `submitPlacement`) rather than hand-set
 * — the depth bands above are what MAKE that recompute come out this way for
 * this graph, not a substitute for it (a differently-shaped domain graph
 * could in principle have a reachDepth-1 skill with a stray extra prereq
 * pointing somewhere unexpected; computeFrontier is what actually decides).
 */

/**
 * A handful (1-3) of otherwise-fluent foundation skills get a faded retention
 * instead of a fresh one, so `isDue` is true for them — real spaced-review
 * picks for the scheduler, and a "fluent · rusty" dial state. Fires any gated
 * cross-domain seeds. Idempotent (clears this scholar+domain's rows first).
 * Discipline-agnostic (keyed by `domain`, same as the rest of the engine) — pass
 * `domain` to shape any registered practice domain (defaults to whole-number
 * arithmetic); the depth/grade banding is graph-generic. Handy for staging a
 * mixed-domain playlist: seed an open frontier in ≥2 domains so the blend has
 * real "new" work to round-robin across.
 * Run:
 *   npx convex run practiceSkills:devSeedPractice '{"scholarUsername":"test-scholar-001","throughGrade":"2"}'
 *   npx convex run practiceSkills:devSeedPractice '{"scholarUsername":"test-scholar-001","domain":"probability","throughGrade":"7"}'
 */
export const devSeedPractice = internalMutation({
  args: {
    scholarUsername: v.string(),
    throughGrade: v.optional(v.string()),
    domain: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.scholarUsername))
      .first();
    if (!user) throw new Error(`No scholar with username ${args.scholarUsername}`);
    const through = args.throughGrade ?? "2";
    const domain = args.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN;
    const now = Date.now();
    const DAY = 86_400_000;

    const { skills, edges } = await loadDomain(ctx, domain);

    // Clear prior mastery for a deterministic reseed.
    const prior = await ctx.db
      .query("practiceMastery")
      .withIndex("by_scholar_domain", (q) => q.eq("scholarId", user._id).eq("domain", domain))
      .collect();
    for (const p of prior) await ctx.db.delete(p._id);

    const skillKeys = skills.map((s) => s.skillKey);
    const graphEdges: GraphEdge[] = edges.map((e) => ({ fromKey: e.fromKey, toKey: e.toKey }));
    const depthOf = dagDepths(skillKeys, graphEdges);

    const reachDepth = Math.max(
      0,
      ...skills
        .filter((s) => s.grade && GRADE_RANK(s.grade) <= GRADE_RANK(through))
        .map((s) => depthOf.get(s.skillKey) ?? 0),
    );

    // Deepest-first, deterministic order so the overlearned sprinkle + due
    // picks land in the same spots on every reseed.
    const foundation = skills
      .filter((s) => (depthOf.get(s.skillKey) ?? 0) <= reachDepth - 2)
      .sort(
        (a, b) =>
          (depthOf.get(a.skillKey) ?? 0) - (depthOf.get(b.skillKey) ?? 0) ||
          a.skillKey.localeCompare(b.skillKey),
      );
    const frontierTier = skills.filter((s) => (depthOf.get(s.skillKey) ?? 0) === reachDepth - 1);
    const midTier = skills.filter((s) => (depthOf.get(s.skillKey) ?? 0) === reachDepth);
    // Anything deeper than reachDepth is beyond the frontier: deliberately no
    // row — locked.

    // Pick a handful of the (non-overlearned) fluent foundation skills to read
    // "due" — spread evenly across the foundation so the ↻ markers aren't
    // clustered at one depth.
    const fluentPositions = foundation.reduce<number[]>((acc, _, i) => {
      if (i % 5 !== 0) acc.push(i); // skip the overlearned sprinkle below
      return acc;
    }, []);
    const dueCount = fluentPositions.length === 0 ? 0 : Math.min(3, Math.max(1, Math.round(fluentPositions.length * 0.05)));
    const dueIndexes = new Set<number>();
    for (let k = 1; k <= dueCount; k++) {
      const pos = Math.floor((k * fluentPositions.length) / (dueCount + 1));
      dueIndexes.add(fluentPositions[pos]);
    }

    let seeded = 0;

    for (const [i, s] of foundation.entries()) {
      const overlearned = i % 5 === 0;
      const due = dueIndexes.has(i);
      const repetition = overlearned ? (i % 10 === 0 ? 6 : 5) : i % 2 === 0 ? 4 : 3;
      await ctx.db.insert("practiceMastery", {
        scholarId: user._id,
        skillKey: s.skillKey,
        domain,
        strand: s.strand,
        repetition,
        halfLifeDays: due ? 6 : overlearned ? 90 : 45,
        becameFluentAt: now - 30 * DAY,
        lastPracticedAt: due ? now - 18 * DAY : now - 3 * DAY,
        frontier: false,
        source: "practice",
        updatedAt: now,
      });
      seeded++;
      await maybeFireSeeds(ctx, user._id, s.skillKey);
    }

    for (const [i, s] of frontierTier.entries()) {
      const repetition = i % 2 === 0 ? 0 : 1;
      await ctx.db.insert("practiceMastery", {
        scholarId: user._id,
        skillKey: s.skillKey,
        domain,
        strand: s.strand,
        repetition,
        halfLifeDays: repetition > 0 ? 3 : 0,
        ...(repetition > 0 ? { lastPracticedAt: now - DAY } : {}),
        frontier: false,
        source: "practice",
        updatedAt: now,
      });
      seeded++;
    }

    for (const [i, s] of midTier.entries()) {
      const repetition = i % 2 === 0 ? 2 : 1;
      await ctx.db.insert("practiceMastery", {
        scholarId: user._id,
        skillKey: s.skillKey,
        domain,
        strand: s.strand,
        repetition,
        halfLifeDays: 10,
        lastPracticedAt: now - 2 * DAY,
        frontier: false,
        source: "practice",
        updatedAt: now,
      });
      seeded++;
    }

    // Recompute the denormalized frontier flag against the real DAG — the
    // depth band above is only an approximation; the graph's actual prereq
    // wiring (including any cross-strand edges) is what the scheduler and
    // map trust. Mirrors submitPlacement's same recompute.
    const mastery = await loadMastery(ctx, user._id, domain);
    const frontier = new Set(
      computeFrontier(skillKeys, graphEdges, (k) => stateFromRow(mastery.get(k))),
    );
    for (const row of mastery.values()) {
      const shouldBe = frontier.has(row.skillKey);
      if (row.frontier !== shouldBe) await ctx.db.patch(row._id, { frontier: shouldBe });
    }

    return {
      scholar: args.scholarUsername,
      throughGrade: through,
      reachDepth,
      skillsSeeded: seeded,
      foundationCount: foundation.length,
      frontierCandidateCount: frontierTier.length,
      midCount: midTier.length,
      frontierCount: frontier.size,
      dueCount: dueIndexes.size,
      lockedCount: skills.length - seeded,
    };
  },
});

/**
 * DEV-ONLY: place a scholar in an arbitrary practice domain by seeding a
 * mastery row per node (so `needsPlacement` returns false and the scheduler
 * has a populated frontier). Unlike `devSeedPractice` this is domain-generic
 * and does no grade filtering, so it works for enrichment domains like
 * `probability` whose nodes are above the default throughGrade.
 * Run:
 *   npx convex run practiceSkills:devPlaceInDomain '{"scholarUsername":"test-scholar-001","domain":"probability"}'
 */
export const devPlaceInDomain = internalMutation({
  args: { scholarUsername: v.string(), domain: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.scholarUsername))
      .first();
    if (!user) throw new Error(`No scholar with username ${args.scholarUsername}`);
    const now = Date.now();
    const DAY = 86_400_000;
    const { skills, edges } = await loadDomain(ctx, args.domain);
    if (skills.length === 0) throw new Error(`No nodes in domain ${args.domain}`);

    const prior = await ctx.db
      .query("practiceMastery")
      .withIndex("by_scholar_domain", (q) =>
        q.eq("scholarId", user._id).eq("domain", args.domain),
      )
      .collect();
    for (const p of prior) await ctx.db.delete(p._id);

    for (const s of skills) {
      await ctx.db.insert("practiceMastery", {
        scholarId: user._id,
        skillKey: s.skillKey,
        domain: args.domain,
        strand: s.strand,
        repetition: 1,
        halfLifeDays: 3,
        lastPracticedAt: now - 5 * DAY,
        frontier: false,
        source: "practice",
        updatedAt: now,
      });
    }

    const skillKeys = skills.map((s) => s.skillKey);
    const graphEdges: GraphEdge[] = edges.map((e) => ({ fromKey: e.fromKey, toKey: e.toKey }));
    const mastery = await loadMastery(ctx, user._id, args.domain);
    const frontier = new Set(
      computeFrontier(skillKeys, graphEdges, (k) => stateFromRow(mastery.get(k))),
    );
    for (const row of mastery.values()) {
      const shouldBe = frontier.has(row.skillKey);
      if (row.frontier !== shouldBe) await ctx.db.patch(row._id, { frontier: shouldBe });
    }

    return { scholar: args.scholarUsername, domain: args.domain, seeded: skills.length };
  },
});

/**
 * DEV-ONLY: delete a scholar's `practicePlacements` rows (all domains, or one).
 * `devPlaceInDomain` seeds mastery but does NOT close an in-progress placement
 * row, and the practice surface resumes any open placement before honoring
 * seeded mastery — so a scholar who tapped into a check-in once gets trapped in
 * it even after being dev-placed. Run this after (or before) devPlaceInDomain
 * to clear the hijack.
 *
 *   npx convex run practiceSkills:devClearPlacements '{"scholarUsername":"test-scholar-001"}'
 */
export const devClearPlacements = internalMutation({
  args: { scholarUsername: v.string(), domain: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.scholarUsername))
      .first();
    if (!user) throw new Error(`No scholar with username ${args.scholarUsername}`);
    const rows = args.domain
      ? await ctx.db
          .query("practicePlacements")
          .withIndex("by_scholar_domain", (q) =>
            q.eq("scholarId", user._id).eq("domain", args.domain!),
          )
          .collect()
      : (
          await ctx.db.query("practicePlacements").collect()
        ).filter((p) => p.scholarId === user._id);
    for (const p of rows) await ctx.db.delete(p._id);
    return { scholar: args.scholarUsername, deleted: rows.length };
  },
});

/**
 * DEV fixture (lane 2) — seed a couple of manipulative `practiceItems` so a
 * scholar's practice session actually serves one end-to-end. These are global
 * catalog rows (like any generated item), not per-scholar, keyed to a REAL
 * `knowledgeNodes` skill so the scheduler queues + serves them (see
 * practiceSession's `manipulatives` guarantee above). `partition_shapes`
 * (fraction-arithmetic, grade 1) is a graph ROOT — no prerequisites — so it's
 * in the frontier for any scholar who hasn't touched this domain yet, no
 * mastery setup required.
 *
 * The two specs are the "make-half" / "match-two" partition challenges from
 * the fractions-equivalence playlist in components/manipulative/library.ts,
 * copied inline rather than imported: Convex's bundler doesn't resolve the
 * `@/` path alias that library.ts (a client-side file) itself depends on.
 * Idempotent — re-running replaces any manipulative rows already seeded for
 * this skill.
 *
 *   npx convex run practiceSkills:devSeedManipulativePractice
 */
export const devSeedManipulativePractice = internalMutation({
  args: { skillKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const skillKey = args.skillKey ?? "partition_shapes";
    const node = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_nodeKey", (q) => q.eq("nodeKey", skillKey))
      .first();
    if (!node) throw new Error(`Unknown skill: ${skillKey} — seed the domain graph first.`);

    const prior = await ctx.db
      .query("practiceItems")
      .withIndex("by_skill", (q) => q.eq("skillKey", skillKey))
      .collect();
    for (const p of prior) {
      if (p.verifierKind === MANIPULATIVE_VERIFIER_KIND) await ctx.db.delete(p._id);
    }

    const specs: ManipulativeSpec[] = [
      {
        kind: "partition",
        id: "make-half",
        concept: "Equivalent fractions",
        prompt: "Make one half.",
        discs: [{ parts: 4, shaded: 1 }],
        adjustable: ["parts", "shaded"],
        partsRange: [2, 12],
        goal: { type: "shadedFractionEquals", disc: 0, value: 0.5 },
      },
      {
        kind: "partition",
        id: "match-two",
        concept: "Equivalent fractions",
        prompt: "Shade both so they’re the same amount.",
        discs: [
          { parts: 2, shaded: 1 },
          { parts: 6, shaded: 1 },
        ],
        adjustable: ["parts", "shaded"],
        partsRange: [2, 12],
        goal: { type: "discsEqualShadedArea" },
      },
    ];

    const now = Date.now();
    let seeded = 0;
    for (const spec of specs) {
      // Guard: an ungradable spec (no usable goal) must never be persisted —
      // isSolved would always return false for it, so a scholar could never
      // pass it (lib/manipulative/authoring.ts).
      assertGradableManipulative(spec);
      await ctx.db.insert("practiceItems", {
        skillKey,
        domain: node.domain,
        stem: spec.prompt,
        answerType: MANIPULATIVE_ANSWER_TYPE,
        answerCanonical: "",
        verifierKind: MANIPULATIVE_VERIFIER_KIND,
        manipulativeSpec: JSON.stringify(spec),
        source: "generated",
        verifiedAt: now,
      });
      seeded++;
    }
    return { skillKey, domain: node.domain, seeded };
  },
});

const RETIRED_COMPARE_MULTIDIGIT_SPEC_ID = "compare-4200-vs-3800";
const CONTENT_REPAIR_SOURCE = "content_repair";
const CONTENT_REPAIR_REVIEW_AGE_MS = 2 * DAY_MS;
const CONTENT_REPAIR_ATTEMPT_BATCH_SIZE = 25;
const CONTENT_REPAIR_ERROR_BATCH_SIZE = 25;

/**
 * One-off, rerunnable repair for a default item whose prompt asked for a
 * comparison while its contract graded exact marker placement.
 */
export const retireAmbiguousCompareManipulative = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    practiceItemId: v.optional(v.id("practiceItems")),
    cursor: v.optional(v.string()),
    phase: v.optional(
      v.union(v.literal("attempts"), v.literal("errors")),
    ),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const candidates = args.practiceItemId
      ? [await ctx.db.get(args.practiceItemId)]
      : await ctx.db
          .query("practiceItems")
          .withIndex("by_skill", (q) => q.eq("skillKey", "compare_multidigit"))
          .collect();
    const item = candidates.find((candidate) => {
      if (
        !candidate ||
        candidate.verifierKind !== MANIPULATIVE_VERIFIER_KIND
      ) {
        return false;
      }
      return (
        parseManipulativeSpec(candidate.manipulativeSpec)?.id ===
        RETIRED_COMPARE_MULTIDIGIT_SPEC_ID
      );
    });
    if (!item) {
      return {
        dryRun,
        practiceItemId: null,
        invalidatedAttempts: 0,
        repairedScholars: 0,
        deletedErrorEvents: 0,
        continueCursor: null,
        nextPhase: null,
        isDone: true,
      };
    }

    const storedItemId = `gen#${item._id}`;
    let invalidatedAttempts = 0;
    let repairedScholars = 0;
    let deletedErrorEvents = 0;
    const now = Date.now();

    if ((args.phase ?? "attempts") === "attempts") {
      const attemptPage = await ctx.db
        .query("practiceAttempts")
        .withIndex("by_item", (q) => q.eq("itemId", storedItemId))
        .paginate({
          cursor: args.cursor ?? null,
          numItems: CONTENT_REPAIR_ATTEMPT_BATCH_SIZE,
        });
      invalidatedAttempts = attemptPage.page.length;
      const attemptsByScholar = new Map<
        Id<"users">,
        typeof attemptPage.page
      >();
      for (const attempt of attemptPage.page) {
        const attempts = attemptsByScholar.get(attempt.scholarId) ?? [];
        attempts.push(attempt);
        attemptsByScholar.set(attempt.scholarId, attempts);
      }
      repairedScholars = attemptsByScholar.size;

      if (!dryRun) {
        for (const [scholarId, invalidAttempts] of attemptsByScholar) {
          for (const attempt of invalidAttempts) {
            if (
              attempt.workImageId &&
              (await ctx.db.system.get("_storage", attempt.workImageId))
            ) {
              await ctx.storage.delete(attempt.workImageId);
            }
            await ctx.db.delete(attempt._id);
          }

          const mastery = await ctx.db
            .query("practiceMastery")
            .withIndex("by_scholar_skill", (q) =>
              q.eq("scholarId", scholarId).eq("skillKey", "compare_multidigit"),
            )
            .unique();
          if (!mastery) continue;
          const invalidCorrect = invalidAttempts.filter(
            (attempt) => attempt.correct,
          ).length;
          const invalidTimes = new Set(
            invalidAttempts.map(
              (attempt) => attempt.createdAt ?? attempt._creationTime,
            ),
          );
          await ctx.db.patch(mastery._id, {
            repetition: Math.max(0, mastery.repetition - invalidCorrect),
            halfLifeDays: MIN_HALFLIFE_DAYS,
            lastPracticedAt: now - CONTENT_REPAIR_REVIEW_AGE_MS,
            lastAttemptAt:
              mastery.lastAttemptAt !== undefined &&
              invalidTimes.has(mastery.lastAttemptAt)
                ? undefined
                : mastery.lastAttemptAt,
            source: CONTENT_REPAIR_SOURCE,
            accelStreak: 0,
            missStreak: 0,
            latencySamplesMs: undefined,
            latencyMedianMs: undefined,
            latencySpreadMs: undefined,
            becameFluentAt:
              mastery.becameFluentAt !== undefined &&
              invalidTimes.has(mastery.becameFluentAt)
                ? undefined
                : mastery.becameFluentAt,
            frontierAdvancedAt:
              mastery.frontierAdvancedAt !== undefined &&
              invalidTimes.has(mastery.frontierAdvancedAt)
                ? undefined
                : mastery.frontierAdvancedAt,
            updatedAt: now,
          });
        }
      }

      if (!attemptPage.isDone) {
        return {
          dryRun,
          practiceItemId: item._id,
          invalidatedAttempts,
          repairedScholars,
          deletedErrorEvents,
          continueCursor: attemptPage.continueCursor,
          nextPhase: "attempts" as const,
          isDone: false,
        };
      }

      return {
        dryRun,
        practiceItemId: item._id,
        invalidatedAttempts,
        repairedScholars,
        deletedErrorEvents,
        continueCursor: null,
        nextPhase: "errors" as const,
        isDone: false,
      };
    }

    if (!dryRun) {
      const remainingAttempt = await ctx.db
        .query("practiceAttempts")
        .withIndex("by_item", (q) => q.eq("itemId", storedItemId))
        .first();
      if (remainingAttempt) {
        throw new Error(
          "Retired-item attempts remain; finish the attempts phase before deleting error evidence.",
        );
      }
    }

    const errorPage = await ctx.db
      .query("practiceErrorEvents")
      .withIndex("by_item", (q) => q.eq("itemId", storedItemId))
      .paginate({
        cursor: args.phase === "errors" ? (args.cursor ?? null) : null,
        numItems: CONTENT_REPAIR_ERROR_BATCH_SIZE,
      });
    deletedErrorEvents = errorPage.page.length;
    if (!dryRun) {
      for (const row of errorPage.page) await ctx.db.delete(row._id);
    }
    if (!errorPage.isDone) {
      return {
        dryRun,
        practiceItemId: item._id,
        invalidatedAttempts,
        repairedScholars,
        deletedErrorEvents,
        continueCursor: errorPage.continueCursor,
        nextPhase: "errors" as const,
        isDone: false,
      };
    }

    if (!dryRun) await ctx.db.delete(item._id);
    return {
      dryRun,
      practiceItemId: item._id,
      invalidatedAttempts,
      repairedScholars,
      deletedErrorEvents,
      continueCursor: null,
      nextPhase: null,
      isDone: true,
    };
  },
});

/**
 * DEFAULT dev-cohort fixture (lane 4) — unlike `devSeedManipulativePractice`
 * above (a manual, single-skill escape hatch for ad hoc testing), this runs
 * automatically as part of `pnpm db:seed` so every seeded scholar's practice
 * includes a manipulative WITHOUT any manual seed step. Idempotent (re-running
 * replaces exactly these rows) and additive — it never touches the
 * `partition_shapes` rows the manual fixture manages.
 *
 * Each entry is tagged to a REAL `knowledgeNodes` skillKey chosen so a
 * completely fresh seeded scholar (test-scholar-001..007, the rich cohort —
 * anyone with zero `practiceMastery` rows) actually gets it SERVED:
 *
 *   - `count_to_10` (whole-number-arithmetic) is that domain's ONLY graph
 *     ROOT (no prerequisites at all — verified against
 *     `WHOLE_NUMBER_ARITHMETIC_EDGES`) — and whole-number-arithmetic is what
 *     `practiceSession`/`PracticeSession.tsx` serve by DEFAULT (no `?domain=`,
 *     no standing assignment). So this is the one item guaranteed to appear
 *     the moment any seeded scholar opens /scholar/practice — no grinding,
 *     no query param.
 *   - `partition_shapes` is fraction-arithmetic's own sole graph root — reachable
 *     the instant a scholar's practice is scoped to that domain (a standing
 *     assignment, or `?domain=fraction-arithmetic`).
 *   - `fraction_as_parts`, `equivalent_fractions_visual`, `fraction_number_line`
 *     sit 2-3 hops downstream of that same root (fraction_as_parts needs
 *     unit_fraction fluent, which needs partition_shapes fluent — 2 skills ×
 *     FLUENT_REPS correct reps); they light up as a scholar's own practice
 *     naturally advances through the fraction-arithmetic frontier, giving the
 *     "raise the ceiling" fraction-equivalence content (lib/manipulative
 *     goal-bearing specs, reused verbatim from components/manipulative/
 *     library.ts) somewhere real to land.
 *
 * **Content-coverage wave 1** (2026-08-03, review/content-coverage-audit.md
 * ranks 1-3): raised default-manipulative coverage on the ~61 K-6
 * whole-number-arithmetic add-subtract / mult-divide / place-value nodes.
 * Every added entry reuses an EXISTING kind that genuinely lets the scholar
 * act out that node's concept (open-number-line counting on/back, make-ten
 * decomposition, an array/area-model split, equal sharing into plates, or a
 * two-step input→output rule) — see the inline comments below for the
 * per-node reasoning. Nodes with no honest existing-kind fit (3-digit+
 * column addition/subtraction, the written long-division algorithm,
 * expanded/standard-form notation, word problems, order of operations, the
 * ×10-per-place relationship, quotitive "how many groups" division) were
 * deliberately left uncovered rather than stretched into a decorative fit.
 *
 * **Content-coverage wave 2** (2026-08-03, review/content-coverage-audit.md
 * ranks 1-6, next after wave 1): raised default-manipulative coverage across
 * geometry-measurement (area-perimeter, angles), whole-number-arithmetic
 * (number-theory, counting), ratio-proportion-percent (ratios-rates), and
 * early-algebra (expressions-variables). Same discipline as wave 1 — every
 * added entry reuses an EXISTING kind that genuinely lets the scholar act out
 * the concept (an array as a factor/area/square-number build, an area-model
 * split for the distributive property, a protractor construction for a
 * benchmark angle, a function machine for a constant-rate ratio/rate/
 * expression, a number-line placement for a comparison or common multiple, a
 * rekenrek split for a part-part ratio, a partition disc for a
 * part-to-whole fraction) — see the inline comments below for the per-node
 * reasoning. Nodes with no honest existing-kind fit (irregular/composite
 * shapes and non-rectangle area formulas; divisibility rules and prime
 * detection, which has no achievable "solved" state; GCF/common factors/
 * prime factorization, which need two numbers' factor sets compared; ratio
 * notation/reduction/order, and the literal "double" number line, which a
 * single-line `numberline` would misrepresent; numeric-only expression
 * evaluation, two-variable formulas, exponents, term vocabulary, and
 * word-to-symbol translation; basic object counting/cardinality and numeral
 * writing) were deliberately left uncovered — see the task report for the
 * full skip list.
 *
 * **Content-coverage wave 3** (2026-08-04, review/content-coverage-audit.md,
 * the fraction-arithmetic strands ranked in the refreshed top-12 gap table:
 * rank 3 `operations` — all 9 K-6 nodes, rank 10 `concept` — its 4 remaining
 * uncovered nodes, rank 12 `decimals` — all 6 nodes). Post-review revision
 * (2026-08-04, review findings 6+7): the first pass placed most operation
 * seeds as a bare numeric answer on a `numberline` — a manipulative that
 * never MODELS the operation is worse than none. Every operation entry was
 * either RESPEC'd so the interaction genuinely acts out the operation, or
 * SKIPPED with a documented reason (see the inline comments at each site):
 *   • `add_subtract_like`, `add_subtract_mixed_like`, `add_subtract_unlike`,
 *     `add_subtract_decimals` — respec'd to a JUMP model: the handle now
 *     STARTS at the first operand (not 0) and lands on the sum/difference,
 *     so the drag itself performs the add/subtract instead of just placing
 *     the precomputed answer.
 *   • `multiply_fraction_by_whole` — respec'd so the tick spacing equals the
 *     unit-fraction size, making each tick literally one group (repeated
 *     addition made visible on the grid).
 *   • `decompose_fraction` — respec'd from one disc/one value to TWO discs
 *     each with their own required value (`partition`'s new `partsEqual`
 *     goal), so the decomposition itself is graded, not just the total.
 *   • `divide_unit_fractions`, `fraction_scaling`, `multiply_fractions` —
 *     respec'd from `numberline` to `partition`'s disc-subdivision: the
 *     scholar re-cuts a shaded disc into more parts and re-shades to the
 *     result, acting out "divide/multiply by re-partitioning".
 *   • `divide_fractions`, `multiply_decimals`, `divide_decimals` — SKIPPED.
 *     None of the existing kinds honestly model a quotient/product that
 *     lands on a whole-number COUNT (not a fraction-of-one) or a
 *     non-whole number of repeated groups; see the skip-reason comment at
 *     each former site.
 * `numberline` is still used as-is for the four `concept` nodes and the
 * three `decimals` nodes that are genuinely single-value placements
 * (`compare_decimals`, `decimal_notation_fractions`,
 * `decimal_place_value_round` — the last tightened further to mark the two
 * neighboring hundredths as explicit rounding candidates) rather than
 * two-operand computations. `comparison` and `equivalence` (also gapped in
 * this domain) were NOT touched — they didn't make the refreshed top-12
 * table this wave, so they're left for a future wave rather than
 * scope-creeping past the ranked target list.
 *
 * **Content-coverage wave 4** (2026-08-04): the 9 place-value nodes wave 1
 * explicitly skipped as having "no honest existing-kind fit" (expanded/
 * standard-form notation and the ×10-per-place relationship) — now covered by
 * the NEW `placeValue` manipulative kind (lib/manipulative/types.ts), built
 * for exactly this concept. One mode-discriminated kind acts out all three
 * moves: `buildNumber` (assemble base-ten bundles into place columns —
 * tens_ones_to_99, hundreds_tens_ones, place_value_multidigit,
 * expanded_to_standard_form, number_name_to_standard), `expandedForm` (the
 * same build with the additive 400+30+7 expansion foregrounded —
 * expanded_form_3digit, expanded_form_multidigit), and `placeShift` (×10/÷10
 * slides every digit across adjacent columns — place_value_relationships,
 * powers_of_ten). This is the first NEW kind added since the catalog was
 * built; the two self-check shapes (assemble-to-target, shift-to-target) ride
 * the same `isSolved` contract every other kind does.
 *
 * Run manually with `npx convex run practiceSkills:seedDefaultManipulativePractice`;
 * also wired into `scripts/db-seed.sh`. NOT dev-only: this seeds node-keyed
 * CURRICULUM content (default manipulative practice items keyed to knowledge
 * nodes, not fixtures tied to the fictional dev cast), and it was deliberately
 * run against prod on 2026-08-05 to populate that content there. Idempotent —
 * re-running replaces exactly the rows this fixture owns per skill (matched by
 * `manipulativeSpec.id`), so it only fills gaps and never clobbers other rows,
 * on dev or prod.
 *
 * The "wired into db-seed.sh" claim above was false until 2026-08-07: the call
 * sat inside that script's dev-only branch, so `db:seed:prod` could not land a
 * content wave and prod held only what a human last remembered to run by hand.
 * Two waves (PRs #1801, #1805) sat merged-but-unseeded as a result. It now runs
 * in the shared section — and MUST stay after `knowledgeNodes:rebuild`, since
 * the loop below throws on a skill the graph doesn't have yet and a Convex
 * mutation throw rolls back the whole seed, not just the unmatched rows.
 */
export const seedDefaultManipulativePractice = internalMutation({
  args: {},
  handler: async (ctx) => {
    const targets: Array<{ domain: string; skillKey: string; spec: ManipulativeSpec }> = [
      {
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "count_to_10",
        spec: {
          kind: "numberline",
          id: "place-7",
          concept: "Whole numbers",
          prompt: "Put the knob on 7.",
          min: 0,
          max: 10,
          tickStep: 1,
          snap: 1,
          start: 3,
          goal: { type: "placeAt", value: 7 },
        },
      },
      {
        // Rekenrek — the make-ten decomposition (13 → a group of 10 + 3).
        // Reused from the "Number bonds & sharing" playlist
        // (components/manipulative/library.ts). Grade 1 (1.OA.C.6), a few hops
        // downstream of the whole-number root, so it lights up as a scholar's
        // frontier advances (or under ?domain=whole-number-arithmetic).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "make_ten_strategy",
        spec: {
          kind: "rekenrek",
          id: "blast-make-ten-13",
          concept: "Make-ten strategy",
          prompt: "Make ten: push exactly 10 of the 13 beads across, and see what's left over.",
          total: 13,
          startLeft: 0,
          goal: { type: "groupOf", value: 10 },
          source: "Rekenrek (bead rack)",
        },
      },
      {
        // Distributor — division as equal sharing (12 ÷ 4, no remainder).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "division_as_sharing",
        spec: {
          kind: "distributor",
          id: "share-12-by-4",
          concept: "Division as sharing",
          prompt: "Share all 12 cookies equally onto the 4 plates.",
          total: 12,
          groups: 4,
          goal: { type: "shareEqually" },
          source: "Distributor (equal sharing)",
        },
      },
      {
        // Distributor — division WITH a remainder (13 ÷ 4 = 3 r1). Grade 4
        // (4.NBT.B.6 / 4.OA.A.3), the remainder-meaning skill.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "division_with_remainders",
        spec: {
          kind: "distributor",
          id: "share-13-by-4-remainder",
          concept: "Remainders",
          prompt: "Share 13 onto 4 plates. Deal every full round you can — what's left over?",
          total: 13,
          groups: 4,
          goal: { type: "shareEqually" },
          source: "Distributor (equal sharing)",
        },
      },
      // ── Content-coverage wave 1 (2026-08-03) — default manipulatives for the
      // top-ranked whole-number-arithmetic gaps (add-subtract, mult-divide,
      // place-value; see review/content-coverage-audit.md). Each entry below
      // is chosen because an EXISTING manipulative kind genuinely lets the
      // scholar ACT OUT that skill's concept (open-number-line counting on/
      // back, make-a-ten decomposition, an array/area-model split, equal
      // sharing into plates, or a two-step input→output rule) — never a typed
      // answer wearing a manipulative costume. Nodes with no honest existing-
      // kind fit (3-digit+/multi-digit column addition/subtraction, the
      // written long-division algorithm, expanded/standard-form notation,
      // word problems, order of operations, the ×10-per-place relationship)
      // are deliberately left uncovered — see the audit doc / task report for
      // the full skip list and reasoning.

      // add-subtract ──────────────────────────────────────────────────────
      {
        // Open number line: count on within 100, no regrouping (23 + 14 = 37).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "add_2digit_no_regroup",
        spec: {
          kind: "numberline",
          id: "count-on-23-plus-14",
          concept: "Adding 2-digit numbers",
          // Wording deliberately does NOT say "no regrouping needed" — that
          // names the very property the skill is checking, telegraphing the
          // strategy before the scholar reasons about it.
          prompt: "Start at 23. Count forward 14 steps. Where do you land?",
          min: 0,
          max: 50,
          tickStep: 10,
          snap: 1,
          start: 23,
          goal: { type: "placeAt", value: 37, tolerance: 0.5 },
        },
      },
      {
        // Open number line: count on within 20, no crossing a ten (12 + 5 = 17).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "add_within_20_no_regroup",
        spec: {
          kind: "numberline",
          id: "count-on-12-plus-5",
          concept: "Adding within 20",
          prompt: "Start at 12. Count forward 5 steps. Where do you land?",
          min: 0,
          max: 20,
          tickStep: 1,
          snap: 1,
          start: 12,
          goal: { type: "placeAt", value: 17, tolerance: 0.5 },
        },
      },
      {
        // Rekenrek — make-ten regrouping for 8 + 7 (push 10 of the 15 across).
        // Distinct total from the existing make_ten_strategy node (13 → 10+3);
        // same honest fit, different skill/grade.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "add_within_20_regroup",
        spec: {
          kind: "rekenrek",
          id: "blast-regroup-8-plus-7",
          concept: "Regrouping to add",
          prompt: "Show 8 + 7 by making a ten: push exactly 10 of the 15 beads across, and see what's left over.",
          total: 15,
          startLeft: 0,
          goal: { type: "groupOf", value: 10 },
          source: "Rekenrek (bead rack)",
        },
      },
      {
        // Open number line: count back within 100, no regrouping (38 − 15 = 23).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "subtract_2digit_no_regroup",
        spec: {
          kind: "numberline",
          id: "count-back-38-minus-15",
          concept: "Subtracting 2-digit numbers",
          // Same rationale as add_2digit_no_regroup above — the prompt should
          // pose the computation without naming/telegraphing the strategy.
          prompt: "Start at 38. Count back 15. Where do you land?",
          min: 0,
          max: 50,
          tickStep: 10,
          snap: 1,
          start: 38,
          goal: { type: "placeAt", value: 23, tolerance: 0.5 },
        },
      },
      {
        // Open number line: count back within 20 (18 − 6 = 12).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "subtract_within_20",
        spec: {
          kind: "numberline",
          id: "count-back-18-minus-6",
          concept: "Subtracting within 20",
          prompt: "Start at 18. Count back 6. Where do you land?",
          min: 0,
          max: 20,
          tickStep: 1,
          snap: 1,
          start: 18,
          goal: { type: "placeAt", value: 12, tolerance: 0.5 },
        },
      },
      {
        // Open number line: 2-digit addition WITH regrouping (27 + 35 = 62) —
        // the "jump to the next friendly ten, then keep going" strategy.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "add_2digit_regroup",
        spec: {
          kind: "numberline",
          id: "count-on-27-plus-35",
          concept: "Adding with regrouping",
          prompt: "Start at 27. Add 35 — jump to a friendly ten, then keep going. Where do you land?",
          min: 0,
          max: 70,
          tickStep: 10,
          snap: 1,
          start: 27,
          goal: { type: "placeAt", value: 62, tolerance: 0.5 },
        },
      },
      {
        // Open number line: 2-digit subtraction WITH regrouping (42 − 27 = 15).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "subtract_2digit_regroup",
        spec: {
          kind: "numberline",
          id: "count-back-42-minus-27",
          concept: "Subtracting with regrouping",
          prompt: "Start at 42. Subtract 27 — jump back to a friendly ten, then keep going. Where do you land?",
          min: 0,
          max: 50,
          tickStep: 10,
          snap: 1,
          start: 42,
          goal: { type: "placeAt", value: 15, tolerance: 0.5 },
        },
      },
      {
        // Rekenrek — compose a sum within 10 (6 + 4 = 10).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "add_within_10",
        spec: {
          kind: "rekenrek",
          id: "blast-compose-6-plus-4",
          concept: "Composing sums within 10",
          prompt: "Show 6 + 4 = 10: push exactly 6 of the 10 beads across.",
          total: 10,
          startLeft: 0,
          goal: { type: "groupOf", value: 6 },
          source: "Rekenrek (bead rack)",
        },
      },
      {
        // Rekenrek — compose a sum within 5 (3 + 2 = 5).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "add_within_5",
        spec: {
          kind: "rekenrek",
          id: "blast-compose-3-plus-2",
          concept: "Composing sums within 5",
          prompt: "Show 3 + 2 = 5: push exactly 3 of the 5 beads across.",
          total: 5,
          startLeft: 0,
          goal: { type: "groupOf", value: 3 },
          source: "Rekenrek (bead rack)",
        },
      },
      {
        // Open number line: count back within 10 (9 − 4 = 5).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "subtract_within_10",
        spec: {
          kind: "numberline",
          id: "count-back-9-minus-4",
          concept: "Subtracting within 10",
          prompt: "Start at 9. Count back 4. Where do you land?",
          min: 0,
          max: 10,
          tickStep: 1,
          snap: 1,
          start: 9,
          goal: { type: "placeAt", value: 5, tolerance: 0.5 },
        },
      },
      {
        // Open number line: count back within 5 (5 − 3 = 2).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "subtract_within_5",
        spec: {
          kind: "numberline",
          id: "count-back-5-minus-3",
          concept: "Subtracting within 5",
          prompt: "Start at 5. Count back 3. Where do you land?",
          min: 0,
          max: 5,
          tickStep: 1,
          snap: 1,
          start: 5,
          goal: { type: "placeAt", value: 2, tolerance: 0.5 },
        },
      },

      // mult-divide ────────────────────────────────────────────────────────
      {
        // Open number line: skip-count by 2s, snapped so only even landings work.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "skip_count_2s_5s_10s",
        spec: {
          kind: "numberline",
          id: "skip-count-by-2s-to-14",
          concept: "Skip-counting by 2s",
          prompt: "Skip count by 2s: land the knob on 14.",
          min: 0,
          max: 20,
          tickStep: 2,
          snap: 2,
          start: 0,
          goal: { type: "placeAt", value: 14, tolerance: 0.5 },
        },
      },
      {
        // Array — the commutative property made visible: 3×4 and 4×3 both
        // build the SAME product, whichever way it's oriented.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "mult_commutative_associative",
        spec: {
          kind: "array",
          id: "array-commutative-3x4",
          concept: "Commutative property of multiplication",
          prompt: "Build an array that shows 3 × 4 = 12. (Try it as 4 rows of 3, too — the product stays the same!)",
          rows: 2,
          cols: 2,
          maxRows: 8,
          maxCols: 8,
          goal: { type: "productEquals", value: 12 },
        },
      },
      {
        // Distribute — the distributive property as a literal area split:
        // 4 × 7 = 4 × 5 + 4 × 2.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "mult_distributive",
        spec: {
          kind: "distribute",
          id: "distribute-4x7-at-5",
          concept: "Distributive property",
          prompt: "Split the array to show 4 × 7 = 4 × 5 + 4 × 2.",
          width: 7,
          height: 4,
          startColumn: 3,
          goal: { type: "splitAt", column: 5 },
          source: "Distributor (equal sharing)",
        },
      },
      {
        // Distributor — division facts in the ÷6–÷9 family (42 ÷ 7 = 6).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "division_facts_6_9",
        spec: {
          kind: "distributor",
          id: "share-42-by-7",
          concept: "Division facts",
          prompt: "Share 42 equally onto 7 plates — how many on each?",
          total: 42,
          groups: 7,
          goal: { type: "shareEqually" },
          source: "Distributor (equal sharing)",
        },
      },
      {
        // Distributor — division facts through ÷5 (25 ÷ 5 = 5).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "division_facts_0_5",
        spec: {
          kind: "distributor",
          id: "share-25-by-5",
          concept: "Division facts",
          prompt: "Share 25 equally onto 5 plates — how many on each?",
          total: 25,
          groups: 5,
          goal: { type: "shareEqually" },
          source: "Distributor (equal sharing)",
        },
      },
      {
        // Array — an easy fact family (2 × 5 = 10).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "mult_facts_0_1_2_5_10",
        spec: {
          kind: "array",
          id: "array-2x5",
          concept: "Multiplication facts",
          prompt: "Build an array that shows 2 × 5.",
          rows: 2,
          cols: 2,
          maxRows: 10,
          maxCols: 10,
          goal: { type: "productEquals", value: 10 },
        },
      },
      {
        // Array — a medium fact family (4 × 6 = 24).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "mult_facts_3_4_6",
        spec: {
          kind: "array",
          id: "array-4x6",
          concept: "Multiplication facts",
          prompt: "Build an array that shows 4 × 6.",
          rows: 2,
          cols: 2,
          maxRows: 10,
          maxCols: 10,
          goal: { type: "productEquals", value: 24 },
        },
      },
      {
        // Array — the hardest fact family (7 × 8 = 56).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "mult_facts_7_8_9",
        spec: {
          kind: "array",
          id: "array-7x8",
          concept: "Multiplication facts",
          prompt: "Build an array that shows 7 × 8.",
          rows: 2,
          cols: 2,
          maxRows: 12,
          maxCols: 12,
          goal: { type: "productEquals", value: 56 },
        },
      },
      {
        // Open number line: skip-count by 3s.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "skip_count_3s_4s",
        spec: {
          kind: "numberline",
          id: "skip-count-by-3s-to-15",
          concept: "Skip-counting by 3s",
          prompt: "Skip count by 3s: land the knob on 15.",
          min: 0,
          max: 24,
          tickStep: 3,
          snap: 3,
          start: 0,
          goal: { type: "placeAt", value: 15, tolerance: 0.5 },
        },
      },
      {
        // Open number line: skip-count by 7s (hardest family).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "skip_count_6s_7s_8s_9s",
        spec: {
          kind: "numberline",
          id: "skip-count-by-7s-to-21",
          concept: "Skip-counting by 7s",
          prompt: "Skip count by 7s: land the knob on 21.",
          min: 0,
          max: 49,
          tickStep: 7,
          snap: 7,
          start: 0,
          goal: { type: "placeAt", value: 21, tolerance: 0.5 },
        },
      },
      {
        // Array — equal groups AS an array (4 equal groups of 5 = 20).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "equal_groups_concept",
        spec: {
          kind: "array",
          id: "array-4-groups-of-5",
          concept: "Equal groups",
          prompt: "Build 4 equal groups of 5 (4 rows × 5 columns). How many in all?",
          rows: 2,
          cols: 2,
          maxRows: 8,
          maxCols: 8,
          goal: { type: "productEquals", value: 20 },
        },
      },
      {
        // Array — the introductory rows-and-columns concept itself.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "arrays_concept",
        spec: {
          kind: "array",
          id: "array-3x5-intro",
          concept: "Arrays",
          prompt: "Build an array with 3 rows and 5 columns. How many squares in all?",
          rows: 2,
          cols: 2,
          maxRows: 8,
          maxCols: 8,
          goal: { type: "productEquals", value: 15 },
        },
      },
      {
        // Distribute — the area model for multi-digit multiplication:
        // 6 × 13 = 6 × 10 + 6 × 3.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "area_model_multiplication",
        spec: {
          kind: "distribute",
          id: "distribute-6x13-at-10",
          concept: "Area model multiplication",
          prompt: "Split the area model to find 6 × 13 using 6 × 10 + 6 × 3.",
          width: 13,
          height: 6,
          startColumn: 4,
          goal: { type: "splitAt", column: 10 },
          source: "Distributor (equal sharing)",
        },
      },
      {
        // Distribute — 2-digit × 1-digit via partial products:
        // 4 × 15 = 4 × 10 + 4 × 5.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "mult_2digit_by_1digit",
        spec: {
          kind: "distribute",
          id: "distribute-4x15-at-10",
          concept: "Partial products",
          prompt: "Split the array to multiply 4 × 15 using 4 × 10 + 4 × 5.",
          width: 15,
          height: 4,
          startColumn: 6,
          goal: { type: "splitAt", column: 10 },
          source: "Distributor (equal sharing)",
        },
      },
      {
        // Distribute — 3-digit × 1-digit via partial products:
        // 3 × 124 = 3 × 100 + 3 × 24. `distribute` is an abstract labeled-
        // rectangle diagram (no per-unit tiles), so a 3-digit width still
        // renders cleanly — unlike `array`'s literal tile grid.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "mult_3digit_by_1digit",
        spec: {
          kind: "distribute",
          id: "distribute-3x124-at-100",
          concept: "Partial products",
          prompt: "Split the array to multiply 3 × 124 using 3 × 100 + 3 × 24.",
          width: 124,
          height: 3,
          startColumn: 40,
          goal: { type: "splitAt", column: 100 },
          source: "Distributor (equal sharing)",
        },
      },
      {
        // Distribute — 2-digit × 2-digit via ONE partial-products split (the
        // intro step before the full 4-partial-product box method; the tool
        // only supports splitting one factor, so this is a genuine but
        // partial decomposition, not the complete box model).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "mult_2digit_by_2digit",
        spec: {
          kind: "distribute",
          id: "distribute-14x23-at-20",
          concept: "Partial products",
          prompt: "Split the array to multiply 14 × 23 using 14 × 20 + 14 × 3.",
          width: 23,
          height: 14,
          startColumn: 5,
          goal: { type: "splitAt", column: 20 },
          source: "Distributor (equal sharing)",
        },
      },
      {
        // Function machine — a two-step expression IS an affine rule
        // (out = m·in + b); this is the honest existing-kind fit.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "two_step_expressions",
        spec: {
          kind: "functionMachine",
          id: "function-machine-2x-plus-3",
          concept: "Two-step expressions",
          prompt: "Study the examples, then predict what comes out when 5 goes in.",
          rule: { op: "affine", m: 2, b: 3 },
          examples: [
            { in: 1, out: 5 },
            { in: 2, out: 7 },
            { in: 3, out: 9 },
          ],
          queryInput: 5,
          answer: { value: 13, prompt: "What comes out when 5 goes in?" },
        },
      },

      // place-value ────────────────────────────────────────────────────────
      {
        // Open number line: place a 2-digit number relative to a marked one —
        // comparison is a position judgment.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "compare_2digit",
        spec: {
          kind: "numberline",
          id: "compare-47-vs-32",
          concept: "Comparing 2-digit numbers",
          prompt: "Place 47 on the line. Is it more or less than the marked 32?",
          min: 0,
          max: 100,
          tickStep: 10,
          snap: 1,
          start: 10,
          markers: [{ value: 32, label: "32" }],
          goal: { type: "placeAt", value: 47, tolerance: 0.5 },
        },
      },
      {
        // Open number line: ten more (34 → 44) — only the tens digit moves.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "ten_more_ten_less",
        spec: {
          kind: "numberline",
          id: "ten-more-than-34",
          concept: "Ten more / ten less",
          prompt: "Find ten more than 34. Where do you land?",
          min: 0,
          max: 100,
          tickStep: 10,
          snap: 1,
          start: 34,
          goal: { type: "placeAt", value: 44, tolerance: 0.5 },
        },
      },
      {
        // Open number line: place a 3-digit number relative to a marked one.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "compare_3digit",
        spec: {
          kind: "numberline",
          id: "compare-245-vs-198",
          concept: "Comparing 3-digit numbers",
          prompt: "Place 245 on the line. Is it more or less than the marked 198?",
          min: 0,
          max: 300,
          tickStep: 50,
          snap: 1,
          start: 50,
          markers: [{ value: 198, label: "198" }],
          goal: { type: "placeAt", value: 245, tolerance: 0.5 },
        },
      },
      {
        // Open number line: place-value sense through 1,000.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "place_value_to_1000",
        spec: {
          kind: "numberline",
          id: "place-350-to-1000",
          concept: "Place value through 1,000",
          prompt: "Place 350 on the number line (0 to 1,000).",
          min: 0,
          max: 1000,
          tickStep: 100,
          snap: 10,
          start: 50,
          goal: { type: "placeAt", value: 350, tolerance: 0.5 },
        },
      },
      {
        // Open number line: rounding IS a nearest-multiple position judgment —
        // the knob starts unsnapped at 47 and must be dragged to the nearest
        // ten (50).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "round_to_nearest_10_100",
        spec: {
          kind: "numberline",
          id: "round-47-to-nearest-10",
          concept: "Rounding",
          prompt: "Round 47 to the nearest ten. Drag the knob to the answer.",
          min: 0,
          max: 100,
          tickStep: 10,
          snap: 10,
          start: 47,
          // No markers: ticks are already at every ten and labelled, so dots on
          // 40/50 would restate the grid. The knob starting at the unrounded 47
          // is what carries the information — it sits between the two.
          goal: { type: "placeAt", value: 50, tolerance: 0.5 },
        },
      },
      {
        // Open number line: rounding a multi-digit number to the nearest
        // thousand (3,482 → 3,000).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "round_multidigit",
        spec: {
          kind: "numberline",
          id: "round-3482-to-nearest-1000",
          concept: "Rounding multi-digit numbers",
          prompt: "Round 3,482 to the nearest thousand. Drag the knob to the answer.",
          min: 0,
          max: 5000,
          tickStep: 1000,
          snap: 1000,
          start: 3482,
          // No markers — same reason as round-47-to-nearest-10: the thousands
          // are already labelled ticks.
          goal: { type: "placeAt", value: 3000, tolerance: 0.5 },
        },
      },
      {
        // Rekenrek — compose ten (6 + 4 = 10), the place-value root skill:
        // seeing a teen number as "10 + n" starts with seeing 10 itself as a
        // composed pair.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "compose_ten",
        spec: {
          kind: "rekenrek",
          id: "blast-compose-ten-pair",
          concept: "Composing ten",
          prompt: "Compose ten: push exactly 4 beads across, then find their partner.",
          total: 10,
          startLeft: 0,
          goal: { type: "groupOf", value: 4 },
          source: "Rekenrek (bead rack)",
        },
      },

      // ── Content-coverage wave 2 (2026-08-03) — default manipulatives for the
      // next-ranked strands (review/content-coverage-audit.md, ranks 1-6):
      // geometry-measurement area-perimeter + angles, whole-number-arithmetic
      // number-theory + counting, ratio-proportion-percent ratios-rates, and
      // early-algebra expressions-variables. As in wave 1, every entry reuses
      // an EXISTING kind that genuinely lets the scholar act out the concept —
      // never a typed answer in a manipulative costume. Nodes with no honest
      // existing-kind fit (irregular/composite shapes, parallelogram/triangle/
      // trapezoid area — none are rectangles the `array`/`areaPerimeter` kinds
      // can represent; divisibility RULES and prime detection — no achievable
      // "solved" state exists for proving a number is prime; GCF/common
      // factors/prime factorization — comparing two numbers' factor sets has
      // no single-manipulative correlate; ratio notation/reduction/order and
      // the literal "double" number line — a single-line `numberline` would
      // misrepresent or contradict the concept; numeric-only expression
      // evaluation, two-variable formulas, exponents, term vocabulary, and
      // word-to-symbol translation; basic object counting/cardinality and
      // numeral writing — no plain "count these objects" kind exists) are
      // deliberately left uncovered — see the task report for the full skip
      // list and reasoning per strand.

      // geometry-measurement / area-perimeter ─────────────────────────────
      {
        // Array — partition a rectangle into equal rows/cols of unit squares,
        // the physical root of area (2.G.A.2).
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "partition_rectangles_rows_cols",
        spec: {
          kind: "array",
          id: "array-partition-3x4-rect",
          concept: "Partitioning a rectangle",
          // Reworded (not tightened) — the standard (2.G.A.2) is "partition
          // into equal rows/columns and count," not any ONE specific shape,
          // so the prompt no longer names a specific row/column count the
          // `productEquals` goal doesn't actually check (any equal-rows-and-
          // columns array of 12 squares is a genuine partition).
          prompt: "Build an array of equal rows and columns that covers a rectangle with exactly 12 unit squares. How many squares in all?",
          rows: 2,
          cols: 2,
          maxRows: 8,
          maxCols: 8,
          goal: { type: "productEquals", value: 12 },
        },
      },
      {
        // Array — area of a rectangle as rows × columns (3.MD.C.7a/b).
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "area_rectangle",
        spec: {
          kind: "array",
          id: "array-area-rect-5x6",
          concept: "Area of a rectangle",
          prompt: "Find the area of a 5-by-6 rectangle by building the array.",
          rows: 2,
          cols: 2,
          maxRows: 10,
          maxCols: 10,
          goal: { type: "productEquals", value: 30 },
        },
      },
      {
        // Array — area as counting unit squares (3.MD.C.5/6).
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "area_unit_squares",
        spec: {
          kind: "array",
          id: "array-unit-squares-4x7",
          concept: "Area by unit squares",
          prompt: "Cover the rectangle with unit squares to find its area: build an array with 4 rows and 7 columns.",
          rows: 2,
          cols: 2,
          maxRows: 10,
          maxCols: 10,
          goal: { type: "productEquals", value: 28 },
        },
      },
      {
        // Distribute — the area picture of the distributive property
        // (3.MD.C.7c), the same area-model split already reused for
        // arithmetic, now grounding a geometry node directly.
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "area_distributive",
        spec: {
          kind: "distribute",
          id: "distribute-area-6x7-at-4",
          concept: "Distributive property (area)",
          prompt: "Split the array to show 6 × (4 + 3) = 6×4 + 6×3.",
          width: 7,
          height: 6,
          startColumn: 2,
          goal: { type: "splitAt", column: 4 },
          source: "Distributor (equal sharing)",
        },
      },
      {
        // Area/Perimeter — same fixed perimeter, different achievable areas
        // (3.MD.D.8): reshape toward a SPECIFIC target area, distinct from
        // the optimization node below.
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "area_perimeter_relationship",
        spec: {
          kind: "areaPerimeter",
          id: "area-perimeter-relationship-target16",
          concept: "Area vs. perimeter",
          prompt: "This rectangle's perimeter is fixed at 20. Reshape it so the area equals 16.",
          perimeter: 20,
          startWidth: 1,
          goal: { type: "areaEquals", value: 16 },
        },
      },
      {
        // Area/Perimeter — recover an unknown side from a target area at a
        // fixed perimeter (4.MD.A.3), inverse reasoning without equations.
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "area_perimeter_unknown_side",
        spec: {
          kind: "areaPerimeter",
          id: "area-perimeter-unknown-side-p24-a35",
          concept: "Unknown side from area",
          prompt: "A rectangle has perimeter 24. Reshape it so the area equals 35 — what's the missing side?",
          perimeter: 24,
          startWidth: 3,
          goal: { type: "areaEquals", value: 35 },
        },
      },
      {
        // Area/Perimeter — the optimization itself: greatest area for a
        // fixed perimeter (3.MD.D.8 / 4.MD.A.3).
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "same_perimeter_optimize",
        spec: {
          kind: "areaPerimeter",
          id: "area-perimeter-optimize-p16",
          concept: "Optimizing area",
          prompt: "Find the width that gives the LARGEST possible area for a rectangle with perimeter 16.",
          perimeter: 16,
          startWidth: 1,
          goal: { type: "maxArea" },
        },
      },

      // geometry-measurement / angles ──────────────────────────────────────
      {
        // Protractor — construct a right angle, the anchor benchmark
        // (4.MD.C.5 / 4.G.A.1).
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "angle_concept",
        spec: {
          kind: "protractor",
          id: "protractor-angle-concept-90",
          concept: "Angles as turns",
          prompt: "Construct a right angle: drag the ray to 90°.",
          startDeg: 30,
          goal: { type: "constructAngle", targetDeg: 90 },
        },
      },
      {
        // Protractor — construct a 45° benchmark angle (4.MD.C.6).
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "benchmark_angles",
        spec: {
          kind: "protractor",
          id: "protractor-benchmark-angle-45",
          concept: "Benchmark angles",
          prompt: "Construct a 45° angle — halfway between the zero and right-angle benchmarks.",
          startDeg: 100,
          goal: { type: "constructAngle", targetDeg: 45 },
        },
      },
      {
        // Protractor — a half turn is 180° (4.MD.C.5a), grounding the degree
        // as a fraction of a full turn.
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "angle_turns_circle",
        spec: {
          kind: "protractor",
          id: "protractor-angle-turns-180",
          concept: "Angles as fractions of a turn",
          prompt: "A half turn is 180°. Construct a half-turn angle.",
          startDeg: 90,
          goal: { type: "constructAngle", targetDeg: 180 },
        },
      },
      {
        // Protractor — construct an acute angle (4.G.A.1 classification).
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "angle_classification",
        spec: {
          kind: "protractor",
          id: "protractor-angle-classification-acute-30",
          concept: "Classifying angles",
          prompt: "Construct an acute angle: drag the ray to 30°.",
          startDeg: 150,
          goal: { type: "constructAngle", targetDeg: 30 },
        },
      },

      // whole-number-arithmetic / number-theory ────────────────────────────
      {
        // Array — "is k a factor of n?" made visible as a k-row array whose
        // product is n (4.OA.4). `sideEqualsWithProduct` (not bare
        // `productEquals`) requires the built array to actually have a side
        // of 6 — a 3×8 array also multiplies to 24 but would prove "3 is a
        // factor of 24," not this fact, so a bare product check would have
        // silently accepted the wrong evidence.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "is_factor",
        spec: {
          kind: "array",
          id: "array-is-factor-6-of-24",
          concept: "Factors",
          prompt: "Build an array with one side of 6 that multiplies to 24, showing 6 is a factor of 24.",
          rows: 2,
          cols: 2,
          maxRows: 10,
          maxCols: 10,
          goal: { type: "sideEqualsWithProduct", side: 6, product: 24 },
        },
      },
      {
        // Array — the inverse question, "is n a multiple of k?" (4.OA.4).
        // Same tightened goal as `is_factor` above, for the same reason.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "is_multiple",
        spec: {
          kind: "array",
          id: "array-is-multiple-35-of-5",
          concept: "Multiples",
          prompt: "Build an array with one side of 5 that multiplies to 35, showing 35 is a multiple of 5.",
          rows: 2,
          cols: 2,
          maxRows: 10,
          maxCols: 10,
          goal: { type: "sideEqualsWithProduct", side: 5, product: 35 },
        },
      },
      {
        // Array — the dedicated factor-pair-count goal: one factor pair of
        // 24, alongside the fact that 24 has 4 factor pairs in all (4.OA.4).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "factor_pairs",
        spec: {
          kind: "array",
          id: "array-factor-pairs-24",
          concept: "Factor pairs",
          prompt: "Build an array that shows one factor pair of 24 (there are 4 pairs in all: 1×24, 2×12, 3×8, 4×6).",
          rows: 2,
          cols: 2,
          maxRows: 12,
          maxCols: 12,
          goal: { type: "factorPairCountEquals", product: 24, count: 4 },
        },
      },
      {
        // Array — factor and multiple in one build (4.OA.4). Tightened the
        // same way as `is_factor`/`is_multiple`: bare `productEquals` would
        // have let ANY factor pair of 20 (e.g. 2×10) pass a claim
        // specifically about 4 being a factor.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "factors_and_multiples",
        spec: {
          kind: "array",
          id: "array-factors-multiples-4x5",
          concept: "Factors and multiples",
          prompt: "Build an array with one side of 4 that multiplies to 20 — this shows 4 is a factor of 20, and 20 is a multiple of 4.",
          rows: 2,
          cols: 2,
          maxRows: 10,
          maxCols: 10,
          goal: { type: "sideEqualsWithProduct", side: 4, product: 20 },
        },
      },
      {
        // Open number line: the smallest shared multiple of 4 and 6.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "common_multiples",
        spec: {
          kind: "numberline",
          id: "numberline-common-multiple-4-6",
          concept: "Common multiples",
          prompt: "Slide right to lay down the 4s and the 6s. Stop at the first place both land together.",
          min: 0,
          max: 24,
          tickStep: 4,
          snap: 1,
          start: 2,
          multipleTracks: [4, 6],
          goal: { type: "firstCommonMultiple", tolerance: 0.5 },
        },
      },
      {
        // Open number line: the LCM of 3 and 5 (6.NS.B.4).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "lcm",
        spec: {
          kind: "numberline",
          id: "numberline-lcm-3-5",
          concept: "Least common multiple",
          prompt: "Slide right to lay down the 3s and the 5s. Stop at the first place both land together.",
          min: 0,
          max: 30,
          tickStep: 5,
          snap: 1,
          start: 0,
          multipleTracks: [3, 5],
          goal: { type: "firstCommonMultiple", tolerance: 0.5 },
        },
      },
      {
        // Distributor — a remainder that wraps like a clock: 17 hours into a
        // 5-hour cycle, the leftover pile IS the landing hour.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "remainder_cycles",
        spec: {
          kind: "distributor",
          id: "distributor-remainder-cycle-17-5",
          concept: "Remainder cycles",
          prompt: "It's hour 0 on a 5-hour clock. Deal out 17 hours in full 5-hour rounds — what hour (the remainder) do you land on?",
          total: 17,
          groups: 5,
          goal: { type: "shareEqually" },
          source: "Distributor (equal sharing)",
        },
      },
      {
        // Array — a square number is a square array (4×4 = 16).
        // `squareEquals` (not bare `productEquals`) requires rows === cols —
        // a 2×8 array also multiplies to 16 but isn't square, so it must not
        // pass as proof of "4² = 16".
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "square_cube_numbers",
        spec: {
          kind: "array",
          id: "array-square-number-4x4",
          concept: "Square numbers",
          prompt: "Build a square array (same number of rows and columns) that shows 4² = 16.",
          rows: 2,
          cols: 2,
          maxRows: 8,
          maxCols: 8,
          goal: { type: "squareEquals", value: 16 },
        },
      },

      // whole-number-arithmetic / counting ─────────────────────────────────
      {
        // Open number line: count to 20 by ones (K.CC.A.1).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "count_to_20",
        spec: {
          kind: "numberline",
          id: "numberline-count-to-20",
          concept: "Counting to 20",
          prompt: "Count to 20: put the knob on 20.",
          min: 0,
          max: 20,
          tickStep: 5,
          snap: 1,
          start: 5,
          goal: { type: "placeAt", value: 20, tolerance: 0.5 },
        },
      },
      {
        // Open number line: count to 100 by ones, landing on an arbitrary
        // number (K.CC.A.1).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "count_to_100_ones",
        spec: {
          kind: "numberline",
          id: "numberline-count-to-100-ones",
          concept: "Counting to 100 by ones",
          prompt: "Count by ones: put the knob on 63.",
          min: 0,
          max: 100,
          tickStep: 10,
          snap: 1,
          start: 10,
          goal: { type: "placeAt", value: 63, tolerance: 0.5 },
        },
      },
      {
        // Open number line: count to 100 by tens (K.CC.A.1).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "count_to_100_tens",
        spec: {
          kind: "numberline",
          id: "numberline-count-to-100-tens",
          concept: "Counting to 100 by tens",
          prompt: "Skip count by tens: put the knob on 70.",
          min: 0,
          max: 100,
          tickStep: 10,
          snap: 10,
          start: 0,
          goal: { type: "placeAt", value: 70, tolerance: 0.5 },
        },
      },
      {
        // Open number line: compare two numbers within 10 by position
        // (K.CC.C.6/7).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "compare_within_10",
        spec: {
          kind: "numberline",
          id: "numberline-compare-within-10-7-vs-4",
          concept: "Comparing within 10",
          prompt: "Place 7 on the line. Is it more or less than the marked 4?",
          min: 0,
          max: 10,
          tickStep: 2,
          snap: 1,
          start: 1,
          markers: [{ value: 4, label: "4" }],
          goal: { type: "placeAt", value: 7, tolerance: 0.5 },
        },
      },
      {
        // Open number line: count on from a non-1 starting point (K.CC.A.2).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "count_on",
        spec: {
          kind: "numberline",
          id: "numberline-count-on-4-plus-3",
          concept: "Counting forward",
          prompt: "Start at 4. Count forward 3 steps — where do you land?",
          min: 0,
          max: 20,
          tickStep: 5,
          snap: 1,
          start: 4,
          goal: { type: "placeAt", value: 7, tolerance: 0.5 },
        },
      },

      // ratio-proportion-percent / ratios-rates ────────────────────────────
      {
        // Open number line: compare two ratios by their decimal value
        // (6.RP.A.3a/b), the same position-comparison pattern reused for
        // 2-/3-digit numbers in wave 1.
        domain: RATIO_PROPORTION_PERCENT_DOMAIN,
        skillKey: "ratio_compare",
        spec: {
          kind: "numberline",
          id: "numberline-ratio-compare-075-06",
          concept: "Comparing ratios",
          prompt: "Mix A is 3 parts juice to 4 parts water (a value of 0.75). Place 0.75 on the line — is it more or less than Mix B, marked at 0.6?",
          min: 0,
          max: 1,
          tickStep: 0.25,
          snap: 0.01,
          start: 0.1,
          markers: [{ value: 0.6, label: "Mix B" }],
          goal: { type: "placeAt", value: 0.75, tolerance: 0.03 },
        },
      },
      {
        // Function machine — a ratio table IS a constant-rate rule; predict
        // the next entry (6.RP.A.3a).
        domain: RATIO_PROPORTION_PERCENT_DOMAIN,
        skillKey: "ratio_table_complete",
        spec: {
          kind: "functionMachine",
          id: "fm-ratio-table-2-per-shirt",
          concept: "Ratio tables",
          prompt: "A ratio table: shirts cost $2 each. Study the examples, then predict the cost for 6 shirts.",
          rule: { op: "affine", m: 2, b: 0 },
          examples: [
            { in: 2, out: 4 },
            { in: 4, out: 8 },
          ],
          queryInput: 6,
          answer: { value: 12, prompt: "What does 6 shirts cost?" },
        },
      },
      {
        // Function machine — dividing to find "how much for one" (6.RP.A.2).
        // Reworked (2026-08-03 review finding): the ORIGINAL prompt stated
        // "Apples cost $2 each" outright, so predicting the query was a bare
        // multiplication of a GIVEN fact — the "study the examples" framing
        // was theater. The rate is no longer disclosed, and neither example
        // uses a quantity of 1 (which would silently re-disclose it) — the
        // scholar must notice the constant ratio ACROSS the two multi-item
        // totals before they can predict a third.
        domain: RATIO_PROPORTION_PERCENT_DOMAIN,
        skillKey: "rate_unit_whole_numbers",
        spec: {
          kind: "functionMachine",
          id: "fm-rate-unit-derive-apples",
          concept: "Unit rate",
          prompt: "A vendor sells apples by the bunch — no price tag per apple, just totals. Study the examples, then predict the cost for 6 apples.",
          rule: { op: "affine", m: 2, b: 0 },
          examples: [
            { in: 2, out: 4 },
            { in: 4, out: 8 },
          ],
          queryInput: 6,
          answer: { value: 12, prompt: "What do 6 apples cost?" },
        },
      },
      {
        // Function machine — a conversion factor as a constant rate
        // (6.RP.A.3d).
        domain: RATIO_PROPORTION_PERCENT_DOMAIN,
        skillKey: "rate_measurement_conversion",
        spec: {
          kind: "functionMachine",
          id: "fm-rate-convert-ft-in",
          concept: "Unit conversion",
          prompt: "There are 12 inches in a foot. Study the examples, then predict the inches in 5 feet.",
          rule: { op: "affine", m: 12, b: 0 },
          examples: [
            { in: 1, out: 12 },
            { in: 2, out: 24 },
          ],
          queryInput: 5,
          answer: { value: 60, prompt: "How many inches is 5 feet?" },
        },
      },
      {
        // Function machine — unit price as a constant rate (6.RP.A.3b).
        // Reworked (2026-08-03 review finding), same reason as
        // `rate_unit_whole_numbers` above: no disclosed "$X each," no
        // in=1 example — and this one asks for the UNIT price directly
        // (queryInput 1), so the derived rate itself IS the answer, distinct
        // from `rate_unit_whole_numbers`'s "apply the derived rate to a new
        // bulk quantity."
        domain: RATIO_PROPORTION_PERCENT_DOMAIN,
        skillKey: "rate_unit_price",
        spec: {
          kind: "functionMachine",
          id: "fm-rate-unit-price-derive-pens",
          concept: "Unit price",
          prompt: "Pens are sold only in packs — no per-pen price listed. Study the examples, then figure out the price of just ONE pen (the unit price).",
          rule: { op: "affine", m: 3, b: 0 },
          examples: [
            { in: 3, out: 9 },
            { in: 5, out: 15 },
          ],
          queryInput: 1,
          answer: { value: 3, prompt: "What is the price of a single pen (the unit price)?" },
        },
      },
      {
        // Open number line: scale an equivalent ratio up by matching the
        // second quantity (6.RP.A.3a).
        domain: RATIO_PROPORTION_PERCENT_DOMAIN,
        skillKey: "ratio_equivalent_scale",
        spec: {
          kind: "numberline",
          id: "numberline-ratio-scale-2-3-at-8",
          concept: "Equivalent ratios",
          prompt: "The ratio 2:3 scaled up: if the first quantity is 8, place the knob on the matching second quantity.",
          min: 0,
          max: 20,
          tickStep: 4,
          snap: 1,
          start: 2,
          markers: [{ value: 8, label: "first: 8" }],
          goal: { type: "placeAt", value: 12, tolerance: 0.5 },
        },
      },
      {
        // Rekenrek — "for every 2 dogs there are 3 cats" as a literal
        // split of the 5-animal whole (6.RP.A.1).
        domain: RATIO_PROPORTION_PERCENT_DOMAIN,
        skillKey: "ratio_concept_language",
        spec: {
          kind: "rekenrek",
          id: "dotblaster-ratio-concept-2-3",
          concept: "Ratio language",
          prompt: "For every 2 dogs there are 3 cats. Push 2 beads across to stand for the dogs — how many beads stand for the cats?",
          total: 5,
          startLeft: 0,
          goal: { type: "groupOf", value: 2 },
          source: "Rekenrek (bead rack)",
        },
      },
      {
        // Partition — a part-to-part ratio reframed as a part-to-whole
        // fraction (6.RP.A.1).
        domain: RATIO_PROPORTION_PERCENT_DOMAIN,
        skillKey: "ratio_part_part_to_whole",
        spec: {
          kind: "partition",
          id: "partition-ratio-part-whole-3-5",
          concept: "Part-to-whole ratios",
          prompt: "3 out of every 5 marbles are red (3 red : 2 blue). Shade the disc to show red's fraction of the WHOLE.",
          discs: [{ parts: 5, shaded: 2 }],
          adjustable: ["parts", "shaded"],
          partsRange: [2, 12],
          goal: { type: "shadedFractionEquals", disc: 0, value: 0.6 },
        },
      },
      {
        // Function machine — constant speed as a rate (6.RP.A.2).
        domain: RATIO_PROPORTION_PERCENT_DOMAIN,
        skillKey: "rate_constant_speed",
        spec: {
          kind: "functionMachine",
          id: "fm-rate-constant-speed-50mph",
          concept: "Constant speed",
          prompt: "A car travels at a constant 50 mph. Study the examples, then predict the distance after 3 hours.",
          rule: { op: "affine", m: 50, b: 0 },
          examples: [
            { in: 1, out: 50 },
            { in: 2, out: 100 },
          ],
          queryInput: 3,
          answer: { value: 150, prompt: "How far after 3 hours?" },
        },
      },
      {
        // Function machine — a unit rate with a fractional quantity
        // (7.RP.A.1).
        domain: RATIO_PROPORTION_PERCENT_DOMAIN,
        skillKey: "rate_unit_fractional_quantities",
        spec: {
          kind: "functionMachine",
          id: "fm-rate-fractional-half-cup",
          concept: "Fractional unit rates",
          prompt: "A recipe uses 1/2 cup of sugar per batch. Study the examples, then predict cups needed for 6 batches.",
          rule: { op: "affine", m: 0.5, b: 0 },
          examples: [
            { in: 2, out: 1 },
            { in: 4, out: 2 },
          ],
          queryInput: 6,
          answer: { value: 3, prompt: "How many cups for 6 batches?" },
        },
      },

      // early-algebra / expressions-variables ──────────────────────────────
      {
        // Function machine — substitution IS evaluating an affine rule
        // (6.EE.A.2c).
        domain: EARLY_ALGEBRA_DOMAIN,
        skillKey: "expr_evaluate_one_variable",
        spec: {
          kind: "functionMachine",
          id: "fm-expr-eval-one-var-3x-plus-2",
          concept: "Evaluating expressions",
          prompt: "Evaluate 3x + 2 for different values of x. Study the examples, then predict the output when x = 5.",
          rule: { op: "affine", m: 3, b: 2 },
          examples: [
            { in: 1, out: 5 },
            { in: 2, out: 8 },
          ],
          queryInput: 5,
          answer: { value: 17, prompt: "What is 3x + 2 when x = 5?" },
        },
      },
      {
        // Function machine — a variable as a number that changes (6.EE.B.6).
        domain: EARLY_ALGEBRA_DOMAIN,
        skillKey: "expr_variable_meaning",
        spec: {
          kind: "functionMachine",
          id: "fm-expr-variable-meaning-n-plus-4",
          concept: "What a variable means",
          prompt: "The letter n can stand for any number. See how n + 4 changes as n changes, then predict n + 4 when n = 9.",
          rule: { op: "affine", m: 1, b: 4 },
          examples: [
            { in: 1, out: 5 },
            { in: 3, out: 7 },
          ],
          queryInput: 9,
          answer: { value: 13, prompt: "What is n + 4 when n = 9?" },
        },
      },
      {
        // Function machine — evaluating with a fractional coefficient
        // (6.EE.A.2c).
        domain: EARLY_ALGEBRA_DOMAIN,
        skillKey: "expr_evaluate_fractions",
        spec: {
          kind: "functionMachine",
          id: "fm-expr-eval-fractions-half-x-plus-3",
          concept: "Evaluating with fractions",
          prompt: "Evaluate (1/2)x + 3 for different x. Study the examples, then predict the output when x = 6.",
          rule: { op: "affine", m: 0.5, b: 3 },
          examples: [
            { in: 2, out: 4 },
            { in: 4, out: 5 },
          ],
          queryInput: 6,
          answer: { value: 6, prompt: "What is (1/2)x + 3 when x = 6?" },
        },
      },
      {
        // Distribute — the same area-model split, now as the algebra move
        // itself: a(b + c) = ab + ac (6.EE.A.3).
        domain: EARLY_ALGEBRA_DOMAIN,
        skillKey: "expr_distributive_numeric",
        spec: {
          kind: "distribute",
          id: "distribute-expr-distributive-5x10-at-8",
          concept: "Distributive property",
          prompt: "Split the array to show 5 × (8 + 2) = 5×8 + 5×2.",
          width: 10,
          height: 5,
          startColumn: 6,
          goal: { type: "splitAt", column: 8 },
          source: "Distributor (equal sharing)",
        },
      },
      {
        // Function machine — signed slope and intercept (7.NS.A.3 / 6.EE.A.2c).
        domain: EARLY_ALGEBRA_DOMAIN,
        skillKey: "expr_multi_step_signed",
        spec: {
          kind: "functionMachine",
          id: "fm-expr-multi-step-signed-neg2x-plus5",
          concept: "Signed expressions",
          prompt: "Evaluate -2x + 5 for different x, including negatives. Study the examples, then predict the output when x = -3.",
          rule: { op: "affine", m: -2, b: 5 },
          examples: [
            { in: 1, out: 3 },
            { in: 2, out: 1 },
          ],
          queryInput: -3,
          answer: { value: 11, prompt: "What is -2x + 5 when x = -3?" },
        },
      },

      // ── Content-coverage wave 4 (2026-08-04) — the 9 place-value nodes wave 1
      // skipped, now covered by the NEW `placeValue` kind. `buildNumber`
      // assembles base-ten bundles into place columns; `expandedForm` fore-
      // grounds the 400+30+7 sum; `placeShift` uses ×10/÷10 to slide digits
      // across columns. All whole-number-arithmetic / place-value strand. ──
      {
        // buildNumber — two-digit tens+ones (1.NBT.B.2). 47 = 4 tens, 7 ones.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "tens_ones_to_99",
        spec: {
          kind: "placeValue",
          id: "placevalue-tens-ones-47",
          mode: "buildNumber",
          concept: "Tens and ones",
          prompt: "Build 47 out of tens and ones — the right count of each.",
          places: [10, 1],
          goal: { type: "buildValue", value: 47 },
        },
      },
      {
        // buildNumber — three-digit hundreds+tens+ones (2.NBT.A.1). 437.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "hundreds_tens_ones",
        spec: {
          kind: "placeValue",
          id: "placevalue-hundreds-tens-ones-437",
          mode: "buildNumber",
          concept: "Hundreds, tens, and ones",
          prompt: "Build 437 with hundreds, tens, and ones.",
          places: [100, 10, 1],
          goal: { type: "buildValue", value: 437 },
        },
      },
      {
        // expandedForm — write 347 in expanded form (2.NBT.A.3): 300 + 40 + 7.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "expanded_form_3digit",
        spec: {
          kind: "placeValue",
          id: "placevalue-expanded-3digit-347",
          mode: "expandedForm",
          concept: "Expanded form",
          prompt: "Show 347 in expanded form — set each place so 300 + 40 + 7 adds up.",
          places: [100, 10, 1],
          goal: { type: "buildValue", value: 347 },
        },
      },
      {
        // expandedForm — multi-digit expanded form with a zero place (4.NBT.A.2).
        // 5208 = 5000 + 200 + 0 + 8 (the tens place is empty — the point).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "expanded_form_multidigit",
        spec: {
          kind: "placeValue",
          id: "placevalue-expanded-multidigit-5208",
          mode: "expandedForm",
          concept: "Expanded form (multi-digit)",
          prompt: "Show 5,208 in expanded form — mind the empty tens place.",
          places: [1000, 100, 10, 1],
          goal: { type: "buildValue", value: 5208 },
        },
      },
      {
        // placeShift — a digit is 10× the same digit one place to its right
        // (4.NBT.1). Start with 5 in the ones; ×10 to make the 5 worth 50.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "place_value_relationships",
        spec: {
          kind: "placeValue",
          id: "placevalue-shift-relationship-5-to-50",
          mode: "placeShift",
          concept: "Ten times as much",
          prompt: "The 5 is in the ones. Shift it so it's worth ten times as much (50).",
          places: [100, 10, 1],
          start: [0, 0, 5],
          goal: { type: "shiftTo", value: 50 },
        },
      },
      {
        // buildNumber — multi-digit place value to the ten-thousands (4.NBT.A.2).
        // 34125 = 3 ten-thousands, 4 thousands, 1 hundred, 2 tens, 5 ones.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "place_value_multidigit",
        spec: {
          kind: "placeValue",
          id: "placevalue-multidigit-build-34125",
          mode: "buildNumber",
          concept: "Multi-digit place value",
          prompt: "Build 34,125 — set the count in each place from ten-thousands to ones.",
          places: [10000, 1000, 100, 10, 1],
          goal: { type: "buildValue", value: 34125 },
        },
      },
      {
        // buildNumber — compose expanded form back into standard form (4.NBT.2).
        // 600 + 80 + 2 ↔ 682. Distinct from the expandedForm entries: here the
        // prompt gives the SUM and the scholar composes the standard number.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "expanded_to_standard_form",
        spec: {
          kind: "placeValue",
          id: "placevalue-expanded-to-standard-682",
          mode: "buildNumber",
          concept: "Expanded → standard form",
          prompt: "Build the standard number for 600 + 80 + 2.",
          places: [100, 10, 1],
          goal: { type: "buildValue", value: 682 },
        },
      },
      {
        // buildNumber — a number name written as a numeral (4.NBT.2).
        // "two hundred fifty-three" → 253.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "number_name_to_standard",
        spec: {
          kind: "placeValue",
          id: "placevalue-number-name-253",
          mode: "buildNumber",
          concept: "Number names",
          prompt: "Build the number for “two hundred fifty-three.”",
          places: [100, 10, 1],
          goal: { type: "buildValue", value: 253 },
        },
      },
      {
        // placeShift — multiply by a power of ten (5.NBT.2). 43 × 100 = 4,300
        // (two ×10 shifts across the columns).
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "powers_of_ten",
        spec: {
          kind: "placeValue",
          id: "placevalue-powers-of-ten-43-x100",
          mode: "placeShift",
          concept: "Powers of ten",
          prompt: "Multiply 43 by 100 — shift every digit two places up.",
          places: [10000, 1000, 100, 10, 1],
          start: [0, 0, 0, 4, 3],
          goal: { type: "shiftTo", value: 4300 },
        },
      },

      {
        domain: FRACTION_ARITHMETIC_DOMAIN,
        skillKey: "partition_shapes",
        spec: {
          kind: "partition",
          id: "make-half",
          concept: "Equivalent fractions",
          prompt: "Make one half.",
          discs: [{ parts: 4, shaded: 1 }],
          adjustable: ["parts", "shaded"],
          partsRange: [2, 12],
          goal: { type: "shadedFractionEquals", disc: 0, value: 0.5 },
        },
      },
      {
        domain: FRACTION_ARITHMETIC_DOMAIN,
        skillKey: "fraction_as_parts",
        spec: {
          kind: "partition",
          id: "piece-of-cake-three-fourths",
          concept: "Fraction puzzles",
          prompt: "Piece of Cake: make exactly three-fourths of the cake.",
          discs: [{ parts: 8, shaded: 2 }],
          adjustable: ["parts", "shaded"],
          partsRange: [2, 12],
          goal: { type: "shadedFractionEquals", disc: 0, value: 0.75 },
          extraCredit: true,
          source: "Math Circles Collaborative — Piece of Cake (mathcircles.org/activities)",
        },
      },
      {
        domain: FRACTION_ARITHMETIC_DOMAIN,
        skillKey: "equivalent_fractions_visual",
        spec: {
          kind: "partition",
          id: "match-two",
          concept: "Equivalent fractions",
          prompt: "Shade both so they’re the same amount.",
          discs: [
            { parts: 2, shaded: 1 },
            { parts: 6, shaded: 1 },
          ],
          adjustable: ["parts", "shaded"],
          partsRange: [2, 12],
          goal: { type: "discsEqualShadedArea" },
        },
      },
      {
        domain: FRACTION_ARITHMETIC_DOMAIN,
        skillKey: "fraction_number_line",
        spec: {
          kind: "numberline",
          id: "place-three-quarters",
          concept: "Fractions on a line",
          prompt: "Place three-quarters.",
          min: 0,
          max: 1,
          tickStep: 0.25,
          start: 0.1,
          goal: { type: "placeFraction", num: 3, den: 4 },
        },
      },
      {
        domain: PROBABILITY_DOMAIN,
        skillKey: "theoretical_probability_simple",
        spec: {
          kind: "dice",
          id: "prob-d6-even",
          diceType: "d6",
          concept: "Probability",
          prompt: "Roll the die a few times. Then predict: P(rolling an even number)?",
          prediction: { type: "probability", event: { type: "even" } },
        },
      },
      {
        domain: PROBABILITY_DOMAIN,
        skillKey: "theoretical_probability_simple",
        spec: {
          kind: "dice",
          id: "prob-coin-heads",
          diceType: "coin",
          concept: "Probability",
          prompt: "Flip a few times. Then predict: P(heads)?",
          prediction: { type: "probability", event: { type: "face", value: 1 } },
        },
      },
      {
        domain: PROBABILITY_DOMAIN,
        skillKey: "probability_as_fraction",
        spec: {
          kind: "dice",
          id: "prob-d6-gt4-frac",
          diceType: "d6",
          concept: "Probability as a fraction",
          prompt: "Roll first, then predict P(rolling more than 4). Any equivalent fraction is fine.",
          prediction: { type: "probability", event: { type: "greaterThan", value: 4 } },
        },
      },
      {
        domain: PROBABILITY_DOMAIN,
        skillKey: "sample_space",
        spec: {
          kind: "dice",
          id: "prob-d6-fav-even",
          diceType: "d6",
          concept: "Sample space",
          prompt: "Roll first, then ask: how many of the 6 faces are even?",
          prediction: { type: "favorableCount", event: { type: "even" } },
        },
      },
      {
        domain: PROBABILITY_DOMAIN,
        skillKey: "compound_two_dice",
        spec: {
          kind: "dice",
          id: "prob-2d6-mode",
          diceType: "d6",
          count: 2,
          concept: "Two dice",
          prompt: "Roll two dice many times. Which total is most likely?",
          prediction: { type: "mostLikelyTotal" },
        },
      },
      // Second variants so a scoped probability problem-set serves a fuller,
      // more varied session (buildSession surfaces up to 2 items per skill).
      {
        domain: PROBABILITY_DOMAIN,
        skillKey: "sample_space",
        spec: {
          kind: "dice",
          id: "prob-d6-fav-gt4",
          diceType: "d6",
          concept: "Sample space",
          prompt: "Roll first, then ask: how many of the 6 faces are greater than 4?",
          prediction: { type: "favorableCount", event: { type: "greaterThan", value: 4 } },
        },
      },
      {
        domain: PROBABILITY_DOMAIN,
        skillKey: "probability_as_fraction",
        spec: {
          kind: "dice",
          id: "prob-d6-even-frac",
          diceType: "d6",
          concept: "Probability as a fraction",
          prompt: "Roll first, then predict P(rolling an even number). Any equivalent fraction is fine.",
          prediction: { type: "probability", event: { type: "even" } },
        },
      },

      // ── Content-coverage wave 3 (2026-08-04) — default manipulatives for
      // the fraction-arithmetic strands ranked in the refreshed top-12 gap
      // table: operations (rank 3, all 9 nodes), concept (rank 10, its 4
      // remaining uncovered nodes), decimals (rank 12, all 6 nodes).
      // Post-review revision: every operation entry is now either respec'd
      // so the interaction genuinely acts out the operation (a numberline
      // JUMP that starts at the first operand, a tick grid sized to the
      // group unit, or a partition disc that's re-subdivided) or skipped
      // with a documented reason — see the file-level doc comment above
      // `seedDefaultManipulativePractice` for the full per-item breakdown.
      // `comparison` and `equivalence` were left uncovered this wave — they
      // didn't rank in the refreshed top-12 table.
      // fraction-arithmetic / operations ────────────────────────────────────
      {
        // Numberline — like-denominator addition modeled as a JUMP: start
        // the handle already sitting at the first addend (3/8), then drag
        // it forward by the second addend (2/8) to land on the sum (4.NF.A.3a).
        // Starting at 0 and just placing the answer was a typed-answer
        // costume; starting at the first addend makes the drag itself the
        // act of adding the second addend's length.
        domain: FRACTION_ARITHMETIC_DOMAIN,
        skillKey: "add_subtract_like",
        spec: {
          kind: "numberline",
          id: "numberline-add-subtract-like-3-8-plus-2-8",
          concept: "Adding like fractions",
          prompt: "Start at 3/8. Add 2/8 — drag forward by 2/8 to land on the sum.",
          min: 0,
          max: 1,
          tickStep: 0.125,
          snap: 0.125,
          start: 0.375,
          markers: [{ value: 0.375, label: "start: 3/8" }],
          goal: { type: "placeFraction", num: 5, den: 8 },
        },
      },
      {
        // Numberline — a mixed-number subtraction that regroups (4.NF.B.3c),
        // modeled as a JUMP BACKWARD: start at the minuend (3 1/4), drag back
        // by the subtrahend (1 3/4) to land on the difference (1 1/2).
        domain: FRACTION_ARITHMETIC_DOMAIN,
        skillKey: "add_subtract_mixed_like",
        spec: {
          kind: "numberline",
          id: "numberline-add-subtract-mixed-like-3-14-minus-1-34",
          concept: "Adding & subtracting mixed numbers",
          prompt: "Start at 3 1/4. Subtract 1 3/4 — drag back by 1 3/4 to land on the difference.",
          min: 0,
          max: 4,
          tickStep: 1,
          snap: 0.25,
          start: 3.25,
          markers: [{ value: 3.25, label: "start: 3 1/4" }],
          goal: { type: "placeFraction", num: 3, den: 2 },
        },
      },
      {
        // Partition — decompose 5/8 as 3/8 + 2/8 by building BOTH distinct
        // parts, one per disc (4.NF.B.3b). `partsEqual` requires disc 0 to
        // land on 3/8 AND disc 1 to land on 2/8 simultaneously, so shading
        // either disc straight to a combined 5/8 (the earlier, single-disc
        // `shadedFractionEquals` version) can no longer read as solved — the
        // decomposition itself, not just the resulting total, is what's
        // graded.
        domain: FRACTION_ARITHMETIC_DOMAIN,
        skillKey: "decompose_fraction",
        spec: {
          kind: "partition",
          id: "partition-decompose-5-8-into-3-8-plus-2-8",
          concept: "Decomposing fractions",
          prompt: "Decompose 5/8 as 3/8 + 2/8: shade the first disc to 3/8 and the second disc to 2/8.",
          discs: [
            { parts: 8, shaded: 0 },
            { parts: 8, shaded: 0 },
          ],
          adjustable: ["shaded"],
          goal: {
            type: "partsEqual",
            parts: [
              { disc: 0, value: 0.375 },
              { disc: 1, value: 0.25 },
            ],
          },
        },
      },
      {
        // Numberline — a whole number times a unit fraction as repeated
        // addition (4.NF.B.4a): 3 groups of 1/4 = 3/4. Ticks are set to the
        // unit-fraction SIZE (1/4) so each tick literally IS one group — the
        // grid embodies "3 groups", not just a scale to place an answer on.
        // Deliberately NO markers: pre-marking the first two hops does the
        // counting the scholar is here to do. The ticks are the scaffold.
        domain: FRACTION_ARITHMETIC_DOMAIN,
        skillKey: "multiply_fraction_by_whole",
        spec: {
          kind: "numberline",
          id: "numberline-multiply-fraction-by-whole-3x1-4",
          concept: "Multiplying a fraction by a whole number",
          prompt: "3 groups of 1/4 — starting at 0, count 3 ticks of 1/4 each and land there.",
          min: 0,
          max: 2,
          tickStep: 0.25,
          snap: 0.25,
          start: 0,
          goal: { type: "placeFraction", num: 3, den: 4 },
        },
      },
      {
        // Numberline — unlike-denominator addition modeled as a JUMP: start
        // the handle at the first addend (1/2), drag forward by the second
        // addend (1/3) to land on the sum (5.NF.A.1).
        domain: FRACTION_ARITHMETIC_DOMAIN,
        skillKey: "add_subtract_unlike",
        spec: {
          kind: "numberline",
          id: "numberline-add-subtract-unlike-half-plus-third",
          concept: "Adding unlike fractions",
          prompt: "Start at 1/2. Add 1/3 — drag forward by 1/3 to land on the sum.",
          min: 0,
          max: 1,
          tickStep: 1 / 6,
          snap: 1 / 12,
          start: 0.5,
          markers: [{ value: 0.5, label: "start: 1/2" }],
          goal: { type: "placeFraction", num: 5, den: 6 },
        },
      },
      {
        // Partition — a unit fraction divided by a whole number (5.NF.B.7b),
        // modeled by SUBDIVIDING further: start with a disc cut into thirds
        // with 1 shaded (1/3), then re-cut it into sixths (÷2 doubles the
        // part count) and re-shade so the same original third still reads
        // as 1 of the new 6 parts (1/6). Dividing-by-partitioning replaces
        // the earlier bare numberline placement.
        domain: FRACTION_ARITHMETIC_DOMAIN,
        skillKey: "divide_unit_fractions",
        spec: {
          kind: "partition",
          id: "partition-divide-unit-fractions-third-div-2",
          concept: "Dividing unit fractions",
          prompt: "1/3 ÷ 2: split the disc into twice as many parts, then shade 1/6.",
          discs: [{ parts: 3, shaded: 1 }],
          adjustable: ["parts", "shaded"],
          partsRange: [1, 12],
          goal: { type: "shadedFractionEquals", disc: 0, value: 1 / 6 },
        },
      },
      {
        // Partition — multiplication as scaling (5.NF.B.5): start at 3/4
        // (parts 4, shaded 3), re-cut into TWELFTHS and re-shade to 6/12.
        // `requireParts: 12` makes the re-cut part of the goal — shading 2/4
        // directly no longer passes (review: the ratio-only goal was the
        // typed-answer-in-manipulative-costume failure).
        domain: FRACTION_ARITHMETIC_DOMAIN,
        skillKey: "fraction_scaling",
        spec: {
          kind: "partition",
          id: "partition-fraction-scaling-half-of-three-fourths",
          concept: "Fraction multiplication as scaling",
          prompt: "Scale 3/4 by 2/3: re-cut the disc into twelfths, then shade to show the product.",
          discs: [{ parts: 4, shaded: 3 }],
          adjustable: ["parts", "shaded"],
          partsRange: [1, 20],
          goal: { type: "shadedFractionEquals", disc: 0, value: 0.5, requireParts: 12 },
        },
      },
      {
        // Partition — multiplying two fractions (5.NF.B.4a): 2/3 × 3/5 =
        // 6/15, modeled by re-cutting into FIFTEENTHS (requireParts) and
        // re-shading — the operation is the re-partition, not the ratio.
        domain: FRACTION_ARITHMETIC_DOMAIN,
        skillKey: "multiply_fractions",
        spec: {
          kind: "partition",
          id: "partition-multiply-fractions-two-thirds-times-three-fifths",
          concept: "Multiplying fractions",
          prompt: "2/3 × 3/5: re-cut the disc into fifteenths, then shade to show the product.",
          discs: [{ parts: 3, shaded: 2 }],
          adjustable: ["parts", "shaded"],
          partsRange: [1, 20],
          goal: { type: "shadedFractionEquals", disc: 0, value: 0.4, requireParts: 15 },
        },
      },
      // Skip-with-reason: `divide_fractions` (2/3 ÷ 1/6 = 4) has NO honest fit
      // among the existing kinds. Its quotient is a whole number > 1, so it
      // doesn't fit `partition`'s bounded single-whole disc (0..1); it isn't
      // an integer "deal into equal groups" task, so `distributor` doesn't
      // apply either; and a numberline can only place a POSITION, never a
      // count of how many divisor-sized groups fit — there's no existing
      // kind that models measurement division by a non-unit fraction without
      // silently degrading back to "drag to the typed answer". Left
      // uncovered this wave rather than shipped as a fancy input box.

      // fraction-arithmetic / concept ───────────────────────────────────────
      {
        // Partition — a unit fraction is exactly one shaded part of an
        // equally-divided whole (3.NF.A.1).
        domain: FRACTION_ARITHMETIC_DOMAIN,
        skillKey: "unit_fraction",
        spec: {
          kind: "partition",
          id: "partition-unit-fraction-one-fourth",
          concept: "Unit fractions",
          prompt: "Shade 1 of the 4 equal parts to show the unit fraction 1/4.",
          discs: [{ parts: 4, shaded: 0 }],
          adjustable: ["shaded"],
          goal: { type: "shadedFractionEquals", disc: 0, value: 0.25 },
        },
      },
      {
        // Numberline — a whole expressed as a fraction (3.NF.A.3c): 4/4
        // makes one whole.
        domain: FRACTION_ARITHMETIC_DOMAIN,
        skillKey: "whole_as_fraction",
        spec: {
          kind: "numberline",
          id: "numberline-whole-as-fraction-4-4",
          concept: "A whole as a fraction",
          prompt: "4/4 makes one whole — place its value on the line.",
          min: 0,
          max: 2,
          tickStep: 0.5,
          snap: 0.25,
          start: 0,
          goal: { type: "placeFraction", num: 4, den: 4 },
        },
      },
      {
        // Numberline — converting an improper fraction to a mixed number
        // (4.NF.B.3c): 7/4 = 1 3/4.
        domain: FRACTION_ARITHMETIC_DOMAIN,
        skillKey: "mixed_improper",
        spec: {
          kind: "numberline",
          id: "numberline-mixed-improper-7-4",
          concept: "Mixed numbers & improper fractions",
          prompt: "Convert 7/4 to a mixed number — place its value on the line.",
          min: 0,
          max: 3,
          tickStep: 1,
          snap: 0.25,
          start: 0,
          goal: { type: "placeFraction", num: 7, den: 4 },
        },
      },
      {
        // Numberline — a fraction as an unevaluated division (5.NF.B.3):
        // 3 ÷ 4 is the same value as 3/4.
        domain: FRACTION_ARITHMETIC_DOMAIN,
        skillKey: "fraction_as_division",
        spec: {
          kind: "numberline",
          id: "numberline-fraction-as-division-3-div-4",
          concept: "Fractions as division",
          prompt: "3 ÷ 4 is the same as 3/4 — place its value on the line.",
          min: 0,
          max: 1,
          tickStep: 0.25,
          snap: 0.05,
          start: 0,
          goal: { type: "placeFraction", num: 3, den: 4 },
        },
      },

      // fraction-arithmetic / decimals ────────────────────────────────────
      {
        // Numberline — comparing two hundredths-precision decimals
        // (4.NF.C.7): is 0.62 more or less than the marked 0.6? A tight
        // tolerance keeps a scholar who drags to the WRONG marker (0.6, only
        // 0.02 away) from reading as solved.
        domain: FRACTION_ARITHMETIC_DOMAIN,
        skillKey: "compare_decimals",
        spec: {
          kind: "numberline",
          id: "numberline-compare-decimals-062-vs-06",
          concept: "Comparing decimals",
          prompt: "Place 0.62 on the line — is it more or less than Player B's 0.6?",
          min: 0,
          max: 1,
          tickStep: 0.1,
          snap: 0.01,
          start: 0,
          markers: [{ value: 0.6, label: "Player B" }],
          goal: { type: "placeAt", value: 0.62, tolerance: 0.005 },
        },
      },
      {
        // Numberline — a hundredths fraction written as a decimal
        // (4.NF.C.6): 25/100 = 0.25.
        domain: FRACTION_ARITHMETIC_DOMAIN,
        skillKey: "decimal_notation_fractions",
        spec: {
          kind: "numberline",
          id: "numberline-decimal-notation-fractions-25-100",
          concept: "Decimal notation for fractions",
          prompt: "25/100 written as a decimal — place it on the line.",
          min: 0,
          max: 1,
          tickStep: 0.25,
          snap: 0.01,
          start: 0,
          goal: { type: "placeAt", value: 0.25, tolerance: 0.005 },
        },
      },
      {
        // Numberline — adding two decimals to the hundredths (5.NBT.B.7),
        // modeled as a JUMP: start the handle at the first addend (2.35),
        // drag forward by the second addend (1.47) to land on the sum.
        domain: FRACTION_ARITHMETIC_DOMAIN,
        skillKey: "add_subtract_decimals",
        spec: {
          kind: "numberline",
          id: "numberline-add-subtract-decimals-235-plus-147",
          concept: "Adding & subtracting decimals",
          prompt: "Start at 2.35. Add 1.47 — drag forward by 1.47 to land on the sum.",
          min: 0,
          max: 5,
          tickStep: 1,
          snap: 0.01,
          start: 2.35,
          markers: [{ value: 2.35, label: "start: 2.35" }],
          goal: { type: "placeAt", value: 3.82, tolerance: 0.02 },
        },
      },
      // Skip-with-reason: `multiply_decimals` (0.6 × 0.7 = 0.42) has no
      // honest fit among the existing kinds either. A repeated-addition/tick
      // model (as used above for `multiply_fraction_by_whole`) needs a WHOLE
      // number of groups, but 0.7 groups isn't a countable number of jumps;
      // `partition`'s disc-subdivision model (used below for
      // `fraction_scaling`/`multiply_fractions`) is fraction-specific and
      // doesn't extend to arbitrary decimal factors. Left uncovered this wave
      // rather than shipped as a fancy input box.
      {
        // Numberline — rounding to the nearest hundredth against the marked
        // original (5.NBT.A.4): 3.14159 rounds to 3.14. Ticks are set to the
        // hundredths grid itself (the precision being rounded TO), so every
        // candidate hundredth is already a labelled tick. The ONE marker is
        // 3.14159 itself — the only value on this line that falls between
        // ticks, which is exactly what makes "which hundredth is it closer
        // to" a real decision on the grid rather than a free drag graded
        // against a tolerance.
        domain: FRACTION_ARITHMETIC_DOMAIN,
        skillKey: "decimal_place_value_round",
        spec: {
          kind: "numberline",
          id: "numberline-decimal-round-314159-nearest-hundredth",
          concept: "Rounding decimals",
          prompt: "The dot marks 3.14159. Round it to the nearest hundredth — drag the knob to the tick it is closest to.",
          min: 3.1,
          max: 3.17,
          tickStep: 0.01,
          snap: 0.01,
          start: 3.1,
          markers: [{ value: 3.14159, label: "3.14159" }],
          goal: { type: "placeAt", value: 3.14, tolerance: 0.001 },
        },
      },
      // Skip-with-reason: `divide_decimals` (4.5 ÷ 0.5 = 9) also has no
      // honest fit. Unlike a fraction whose quotient stays a fraction-of-one
      // (see `divide_unit_fractions`'s partition re-subdivision), this
      // quotient is a raw COUNT (9), and no existing kind models "count how
      // many divisor-sized groups fit in the dividend" without silently
      // degrading to placing the already-computed count on a number line.
      // Left uncovered this wave rather than shipped as a fancy input box.

      // ── The measurement kinds (2026-08-06) — `ruler`, `clock`, `liquid`,
      // `money`. Only TWO existing graph nodes take one honestly, and both are
      // seeded below. The four kinds were built for Measurement & Data (length
      // 2.MD.A, time 1.MD.B/2.MD.C/3.MD.A, money 2.MD.C.8, liquid volume
      // 3.MD.A.2) — a Common Core domain the practice graph does not model at
      // all today, so there is nowhere else to hang them. Forcing them onto
      // adjacent nodes is exactly the "decorative fit" every earlier wave
      // refused; the honest move is a `measurement-data` strand, which is a
      // curriculum decision (14 new nodes, each needing its own deterministic
      // template, changing what every scholar's geometry-measurement placement
      // probes) rather than a manipulatives one. Until then the four kinds
      // reach scholars through the teacher's own item pool
      // (components/practice/NodeItemPool.tsx), which can attach any kind to
      // any node, and through the /dev-manipulatives gallery.
      //
      // Deliberately NOT seeded, with reasons:
      //   • `ruler` — no length-measurement node exists. `perimeter_polygons`
      //     is the nearest, and a one-bar ruler models a single length, not
      //     the sum of a boundary's sides.
      //   • `liquid` — `volume_unit_cubes` is 3-D packing (counting cubes that
      //     fill a solid), a different model from reading a liquid level off a
      //     graduated scale. Not the same skill in a jar-shaped costume.
      {
        // Clock — the modular-arithmetic node's own rationale names it: "the
        // math of clocks, calendars, day-of-week puzzles". `advanceBy` 200
        // minutes from 9:00 WRAPS the dial past 12 (9:00 + 3h20m = 12:20), so
        // the manipulative performs the mod-720 wrap the skill is about rather
        // than illustrating it. COMPUTE-STYLE: the landing time is never named.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "remainder_cycles",
        spec: {
          kind: "clock",
          id: "clock-wrap-200-minutes-from-9",
          concept: "Remainder cycles",
          prompt: "It's 9:00. Move the hands on by 200 minutes — you'll go right past 12.",
          startHour: 9,
          startMinute: 0,
          snapMinutes: 5,
          goal: { type: "advanceBy", minutes: 200 },
          source: "Clock (a cycle that wraps)",
        },
      },
      {
        // Money — a bank of ONLY nickels and dimes makes counting the tray
        // literally skip-counting by 5s and 10s (45¢ = 5, 15, 25, 35, 45 or
        // 10, 20, 30, 40, 45). Pennies are withheld on purpose: with them the
        // task collapses to counting by ones, which is the habit this node
        // exists to retire.
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "skip_count_2s_5s_10s",
        spec: {
          kind: "money",
          id: "money-skip-count-45-cents-nickels-dimes",
          concept: "Skip-counting by 5s and 10s",
          prompt: "Make 45¢ out of nickels and dimes — count them up as you go.",
          available: ["nickel", "dime"],
          goal: { type: "amountEquals", cents: 45 },
          source: "Money (skip-counting a coin pile)",
        },
      },
      // ── Content wave: authored homes for the four previously-unused kinds.
      // Each item acts out the node's actual idea; geoLocate stays deliberately
      // sparse because a map earns a math home only when route proportion is
      // what determines the pin.

      // balance ─────────────────────────────────────────────────────────────
      {
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        skillKey: "compare_within_10",
        spec: {
          kind: "balance",
          id: "balance-equal-4-and-8",
          concept: "Equal quantities",
          prompt: "The left pan holds 4. Lower the right pan's count until both pans are equal.",
          left: 4,
          right: 8,
          adjustable: ["right"],
          maxUnits: 10,
          goal: { type: "balance" },
        },
      },
      {
        domain: EARLY_ALGEBRA_DOMAIN,
        skillKey: "expr_variable_meaning",
        spec: {
          kind: "balance",
          id: "balance-mystery-block-6",
          concept: "A variable as an unknown",
          prompt: "A mystery block hides a number. Build its value on the left until the beam tells you they are equal.",
          left: 1,
          right: 0,
          adjustable: ["left"],
          mysteryRight: 6,
          maxUnits: 10,
          goal: { type: "balance" },
        },
      },
      {
        domain: EARLY_ALGEBRA_DOMAIN,
        skillKey: "eq_unknown_in_arithmetic",
        spec: {
          kind: "balance",
          id: "balance-missing-addend-3-to-10",
          concept: "A missing amount in an equation",
          prompt: "The right pan starts with 3. Add the missing amount until 3 + ? balances 10.",
          left: 10,
          right: 3,
          adjustable: ["right"],
          maxUnits: 12,
          goal: { type: "balance" },
        },
      },
      {
        domain: EARLY_ALGEBRA_DOMAIN,
        skillKey: "eq_solution_meaning",
        spec: {
          kind: "balance",
          id: "balance-make-equation-true-8",
          concept: "A solution makes an equation true",
          prompt: "The left pan is 8. Change the right pan until the equality is true.",
          left: 8,
          right: 2,
          adjustable: ["right"],
          maxUnits: 10,
          goal: { type: "balance" },
        },
      },
      {
        domain: EARLY_ALGEBRA_DOMAIN,
        skillKey: "eq_test_solution",
        spec: {
          kind: "balance",
          id: "balance-test-7-against-9",
          concept: "Testing a proposed solution",
          prompt: "Does 7 make the pans equal to 9? Test it, then adjust until you find a value that does.",
          left: 9,
          right: 7,
          adjustable: ["right"],
          maxUnits: 12,
          goal: { type: "balance" },
        },
      },
      {
        domain: EARLY_ALGEBRA_DOMAIN,
        skillKey: "eq_one_step_add_sub",
        spec: {
          kind: "balance",
          id: "balance-solve-5-plus-x-equals-12",
          concept: "One-step addition equations",
          prompt: "The right pan starts at 5. Add x more units so 5 + x balances 12.",
          left: 12,
          right: 5,
          adjustable: ["right"],
          maxUnits: 14,
          goal: { type: "balance" },
        },
      },

      // coordinatePlane ─────────────────────────────────────────────────────
      {
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "ordered_pair_meaning",
        spec: {
          kind: "coordinatePlane",
          id: "coordinate-across-3-up-2",
          concept: "Ordered pairs",
          prompt: "Across 3, then up 2: place the point at (3, 2).",
          xMin: 0,
          xMax: 6,
          yMin: 0,
          yMax: 6,
          gridStep: 1,
          draggable: [{ start: { x: 1, y: 1 } }],
          goal: { type: "placePoint", x: 3, y: 2 },
        },
      },
      {
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "coordinate_plane_first_quadrant",
        spec: {
          kind: "coordinatePlane",
          id: "coordinate-first-quadrant-5-4",
          concept: "Plotting in the first quadrant",
          prompt: "A garden sensor is recorded at (5, 4). Put its point on the grid.",
          xMin: 0,
          xMax: 8,
          yMin: 0,
          yMax: 8,
          gridStep: 1,
          draggable: [{ start: { x: 2, y: 1 } }],
          goal: { type: "placePoint", x: 5, y: 4 },
        },
      },
      {
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "four_quadrant_plane",
        spec: {
          kind: "coordinatePlane",
          id: "coordinate-three-four-quadrant-points",
          concept: "Plotting across four quadrants",
          prompt: "Place the three points at (-4, 3), (2, -5), and (-3, -2). Color order does not matter.",
          xMin: -6,
          xMax: 6,
          yMin: -6,
          yMax: 6,
          gridStep: 1,
          draggable: [
            { start: { x: 1, y: 1 } },
            { start: { x: 2, y: 2 } },
            { start: { x: 3, y: 3 } },
          ],
          goal: {
            type: "placePoints",
            points: [
              { x: -4, y: 3 },
              { x: 2, y: -5 },
              { x: -3, y: -2 },
            ],
          },
        },
      },
      {
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "reflect_across_axis",
        spec: {
          kind: "coordinatePlane",
          id: "coordinate-reflect-3-2-across-x",
          concept: "Reflection across the x-axis",
          prompt: "Point P is at (3, 2). Drag its reflection across the x-axis into place.",
          xMin: -5,
          xMax: 5,
          yMin: -5,
          yMax: 5,
          gridStep: 1,
          fixedPoints: [{ x: 3, y: 2, label: "P" }],
          draggable: [{ start: { x: -3, y: -2 } }],
          goal: { type: "reflectPoint", point: { x: 3, y: 2 }, across: "x" },
        },
      },
      {
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "reflect_across_axis",
        spec: {
          kind: "coordinatePlane",
          id: "coordinate-reflect-neg2-4-across-y",
          concept: "Reflection across the y-axis",
          prompt: "Point Q is at (-2, 4). Drag its reflection across the y-axis into place.",
          xMin: -5,
          xMax: 5,
          yMin: -5,
          yMax: 5,
          gridStep: 1,
          fixedPoints: [{ x: -2, y: 4, label: "Q" }],
          draggable: [{ start: { x: -2, y: -4 } }],
          goal: { type: "reflectPoint", point: { x: -2, y: 4 }, across: "y" },
        },
      },
      {
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "coordinate_missing_vertex",
        spec: {
          kind: "coordinatePlane",
          id: "coordinate-complete-rectangle-neg4-3",
          concept: "A missing rectangle vertex",
          prompt: "Three corners of an axis-aligned rectangle are fixed. Place the missing fourth corner.",
          xMin: -6,
          xMax: 6,
          yMin: -4,
          yMax: 6,
          gridStep: 1,
          fixedPoints: [
            { x: -4, y: -1, label: "A" },
            { x: 3, y: -1, label: "B" },
            { x: -4, y: 4, label: "C" },
          ],
          segments: [
            [{ x: -4, y: -1 }, { x: 3, y: -1 }],
            [{ x: -4, y: -1 }, { x: -4, y: 4 }],
          ],
          draggable: [{ start: { x: 0, y: 0 } }],
          goal: { type: "completeRectangle" },
        },
      },
      {
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "coordinate_distance",
        spec: {
          kind: "coordinatePlane",
          id: "coordinate-seven-right-from-neg3-2",
          concept: "Distance on a coordinate line",
          prompt: "Point A is at (-3, 2). Place B on the same row, exactly 7 units to the right.",
          xMin: -5,
          xMax: 6,
          yMin: -4,
          yMax: 5,
          gridStep: 1,
          fixedPoints: [{ x: -3, y: 2, label: "A" }],
          draggable: [{ start: { x: -2, y: -3 } }],
          goal: { type: "placePoint", x: 4, y: 2 },
        },
      },
      {
        domain: INTEGERS_COORDINATES_DOMAIN,
        skillKey: "rational_coordinate_pairs",
        spec: {
          kind: "coordinatePlane",
          id: "coordinate-rational-neg1p5-2p5",
          concept: "Rational coordinates",
          prompt: "Place the point at (-1.5, 2.5). The half-unit grid can hold both coordinates exactly.",
          xMin: -4,
          xMax: 4,
          yMin: -4,
          yMax: 4,
          gridStep: 0.5,
          draggable: [{ start: { x: 1, y: -1 } }],
          goal: { type: "placePoint", x: -1.5, y: 2.5 },
        },
      },

      // riemann ─────────────────────────────────────────────────────────────
      {
        domain: ALGEBRA_1_DOMAIN,
        skillKey: "lin_fn_interpret_context",
        spec: {
          kind: "riemann",
          id: "riemann-rover-1-plus-2t",
          concept: "Accumulated distance from a linear speed",
          prompt: "A rover starts at 1 m/s and gains 2 m/s each second for 4 seconds. Refine the left-sum bars until the distance estimate is within 2 meters of the true area.",
          slope: 2,
          intercept: 1,
          tMax: 4,
          startBars: 2,
          minBars: 1,
          maxBars: 16,
          goal: { type: "approximateWithin", tolerance: 2 },
        },
      },
      {
        domain: ALGEBRA_1_DOMAIN,
        skillKey: "lin_fn_interpret_context",
        spec: {
          kind: "riemann",
          id: "riemann-drone-2-plus-t",
          concept: "Accumulated distance from a linear speed",
          prompt: "A drone starts at 2 m/s and gains 1 m/s each second for 6 seconds. Add bars until your distance estimate is within 2 meters of the true area.",
          slope: 1,
          intercept: 2,
          tMax: 6,
          startBars: 3,
          minBars: 1,
          maxBars: 18,
          goal: { type: "approximateWithin", tolerance: 2 },
        },
      },
      {
        domain: ALGEBRA_1_DOMAIN,
        skillKey: "lin_fn_interpret_context",
        spec: {
          kind: "riemann",
          id: "riemann-runner-1-plus-half-t",
          concept: "Accumulated distance from a linear speed",
          prompt: "A runner starts at 1 m/s and gains 0.5 m/s each second for 8 seconds. How many bars bring the distance estimate within 1 meter?",
          slope: 0.5,
          intercept: 1,
          tMax: 8,
          startBars: 4,
          minBars: 1,
          maxBars: 20,
          goal: { type: "approximateWithin", tolerance: 1 },
        },
      },
      {
        domain: ALGEBRA_1_DOMAIN,
        skillKey: "lin_fn_interpret_context",
        spec: {
          kind: "riemann",
          id: "riemann-train-3-plus-3t",
          concept: "Accumulated distance from a linear speed",
          prompt: "A model train starts at 3 m/s and gains 3 m/s each second for 4 seconds. Tighten the left sum until it is within 3 meters of the true distance.",
          slope: 3,
          intercept: 3,
          tMax: 4,
          startBars: 2,
          minBars: 1,
          maxBars: 16,
          goal: { type: "approximateWithin", tolerance: 3 },
        },
      },
      {
        domain: ALGEBRA_1_DOMAIN,
        skillKey: "lin_fn_interpret_context",
        spec: {
          kind: "riemann",
          id: "riemann-sled-2-plus-1p5t",
          concept: "Accumulated distance from a linear speed",
          prompt: "A test sled starts at 2 m/s and gains 1.5 m/s each second for 6 seconds. Refine the bars until the estimate is within 1.5 meters.",
          slope: 1.5,
          intercept: 2,
          tMax: 6,
          startBars: 3,
          minBars: 1,
          maxBars: 20,
          goal: { type: "approximateWithin", tolerance: 1.5 },
        },
      },

      // geoLocate ───────────────────────────────────────────────────────────
      {
        domain: RATIO_PROPORTION_PERCENT_DOMAIN,
        skillKey: "rate_constant_speed",
        spec: {
          kind: "geoLocate",
          id: "geo-route-honolulu-hilo-quarter",
          concept: "Constant speed along a real route",
          prompt: "A boat holds a constant speed from Honolulu to Hilo. After 1 of 4 equal hours, where is it? Pin the one-quarter point on the route.",
          map: {
            v: 1,
            id: "geo-route-honolulu-hilo-quarter-map",
            title: "Honolulu to Hilo",
            camera: { center: [-157, 21.1], zoom: 6.1 },
            base: "terrain",
            layers: [{
              id: "route",
              label: "Route",
              source: {
                geojson: {
                  type: "FeatureCollection",
                  features: [{
                    type: "Feature",
                    geometry: {
                      type: "LineString",
                      coordinates: [[-157.8583, 21.3069], [-155.09, 19.72]],
                    },
                  }],
                },
              },
              paint: "routeLine",
              tint: "blue",
            }],
            markers: [
              { id: "honolulu", lngLat: [-157.8583, 21.3069], label: "Honolulu" },
              { id: "hilo", lngLat: [-155.09, 19.72], label: "Hilo" },
            ],
            interactions: { tapToPin: true, baseToggle: false, rotate: false, pitch: false },
            task: {
              kind: "locate",
              prompt: "Pin the point one-quarter of the way from Honolulu to Hilo.",
              target: [-157.166225, 20.910175],
              toleranceKm: 35,
            },
          },
        },
      },
      {
        domain: RATIO_PROPORTION_PERCENT_DOMAIN,
        skillKey: "rate_constant_speed",
        spec: {
          kind: "geoLocate",
          id: "geo-route-seattle-san-diego-two-fifths",
          concept: "Constant speed along a real route",
          prompt: "A flight follows the route from Seattle to San Diego at constant speed. After 2 of 5 equal hours, where is it? Pin the two-fifths point.",
          map: {
            v: 1,
            id: "geo-route-seattle-san-diego-two-fifths-map",
            title: "Seattle to San Diego",
            camera: { center: [-120, 40], zoom: 3.5 },
            base: "politicalUnlabeled",
            layers: [{
              id: "route",
              label: "Route",
              source: {
                geojson: {
                  type: "FeatureCollection",
                  features: [{
                    type: "Feature",
                    geometry: {
                      type: "LineString",
                      coordinates: [[-122.3321, 47.6062], [-117.1611, 32.7157]],
                    },
                  }],
                },
              },
              paint: "routeLine",
              tint: "blue",
            }],
            markers: [
              { id: "seattle", lngLat: [-122.3321, 47.6062], label: "Seattle" },
              { id: "san-diego", lngLat: [-117.1611, 32.7157], label: "San Diego" },
            ],
            interactions: { tapToPin: true, baseToggle: false, rotate: false, pitch: false },
            task: {
              kind: "locate",
              prompt: "Pin the point two-fifths of the way from Seattle to San Diego.",
              target: [-120.2637, 41.6500],
              toleranceKm: 85,
            },
          },
        },
      },
      {
        domain: RATIO_PROPORTION_PERCENT_DOMAIN,
        skillKey: "ratio_equivalent_scale",
        spec: {
          kind: "geoLocate",
          id: "geo-route-la-new-york-four-sixths",
          concept: "Equivalent ratios along a route",
          prompt: "A coast-to-coast route is split into 6 equal stages. Starting in Los Angeles, pin the stop after 4 stages toward New York.",
          map: {
            v: 1,
            id: "geo-route-la-new-york-four-sixths-map",
            title: "Los Angeles to New York",
            camera: { center: [-96, 38], zoom: 3.2 },
            base: "politicalUnlabeled",
            layers: [{
              id: "route",
              label: "Six equal stages",
              source: {
                geojson: {
                  type: "FeatureCollection",
                  features: [{
                    type: "Feature",
                    geometry: {
                      type: "LineString",
                      coordinates: [[-118.2437, 34.0522], [-74.006, 40.7128]],
                    },
                  }],
                },
              },
              paint: "routeLine",
              tint: "violet",
            }],
            markers: [
              { id: "los-angeles", lngLat: [-118.2437, 34.0522], label: "Los Angeles" },
              { id: "new-york", lngLat: [-74.006, 40.7128], label: "New York" },
            ],
            interactions: { tapToPin: true, baseToggle: false, rotate: false, pitch: false },
            task: {
              kind: "locate",
              prompt: "Pin the point four-sixths of the way from Los Angeles to New York.",
              target: [-88.7519, 38.4926],
              toleranceKm: 120,
            },
          },
        },
      },
      // ── Content-coverage wave 5 (2026-08-06) — the `measurement-data`
      // strand. Unlike waves 1-4, which raised coverage on nodes that already
      // existed, this wave lands on 14 NEW nodes added in the same change (see
      // convex/seed/geometryMeasurementGraph.ts): Common Core Measurement &
      // Data, which the practice graph did not model at all. The four kinds —
      // `ruler`, `clock`, `liquid`, `money` — were built for exactly these
      // skills, so 13 of the 14 take one honestly rather than by a stretch.
      //
      // Follow-up (2026-08-07): a curated SECOND item on the six nodes where a
      // different case genuinely teaches more than a numbers-swap — a second
      // broken-ruler offset, the addition side of a length difference, the dime
      // (this node's named misleading-size coin), an exact-count coin
      // decomposition, a half-cup sub-unit reading, and an elapsed jump that
      // crosses 12 rather than a plain hour. The other seven stay at one good
      // item apiece (the strand target is "1-2 per node", not "2 everywhere").
      //
      // Skip-with-reason: `length_iterate_units` (1.MD.A.2) is the PRE-ruler
      // skill — laying a unit down repeatedly with no numbered scale to read.
      // Our ruler always prints a numbered scale, which is exactly what that
      // node is about NOT having, so a ruler item there would teach the next
      // skill instead of this one. Left to its template.

      // length ────────────────────────────────────────────────────────────
      {
        // Aligned at zero, so the end mark IS the length. Deliberately the easy
        // case: this node is "read a ruler", and `measure_from_nonzero` is
        // where the two numbers come apart.
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "measure_with_ruler",
        spec: {
          kind: "ruler",
          id: "ruler-measure-from-zero-7cm",
          concept: "Measuring length",
          prompt: "Make the bar exactly 7 cm long, starting from 0.",
          unit: "cm",
          length: 12,
          startEnd: 3,
          goal: { type: "lengthEquals", value: 7 },
          source: "Ruler (linear measurement)",
        },
      },
      {
        // The broken ruler — this node's entire reason for existing.
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "measure_from_nonzero",
        spec: {
          kind: "ruler",
          id: "ruler-broken-start-3-make-5cm",
          concept: "Length is end minus start",
          prompt: "The bar starts at 3, not 0. Make it 5 cm long anyway.",
          unit: "cm",
          length: 12,
          startAt: 3,
          startEnd: 4,
          goal: { type: "lengthEquals", value: 5 },
          source: "Ruler (broken-ruler measurement)",
        },
      },
      {
        // A second broken-ruler case, offset the other way, so the misconception
        // can't be pattern-matched off one example. Pinned at 4, target 6 cm, so
        // the end lands on 10 — a scholar who "reads the number the bar stops on"
        // gets 10 and is wrong; length is 10 − 4. The whole point of this node.
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "measure_from_nonzero",
        spec: {
          kind: "ruler",
          id: "ruler-broken-start-4-make-6cm",
          concept: "Length is end minus start",
          prompt: "The bar's left edge is pinned at 4, not 0. Make it 6 cm long.",
          unit: "cm",
          length: 12,
          startAt: 4,
          startEnd: 6,
          goal: { type: "lengthEquals", value: 6 },
          source: "Ruler (broken-ruler measurement)",
        },
      },
      {
        // A difference stated in prose: work out 9 − 4 first, then build it.
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "compare_lengths_difference",
        spec: {
          kind: "ruler",
          id: "ruler-difference-9-minus-4",
          concept: "Comparing lengths",
          prompt: "A blue ribbon is 9 cm long. Make a red bar that is 4 cm SHORTER than it.",
          unit: "cm",
          length: 12,
          startAt: 2,
          startEnd: 4,
          goal: { type: "lengthEquals", value: 5 },
          source: "Ruler (comparing two lengths)",
        },
      },
      {
        // The comparison run the OTHER direction — "how much longer" as an
        // addition, not a subtraction. The first item makes a bar shorter; this
        // makes one longer (5 + 3 = 8), so the node covers both sides of a
        // length difference rather than only "take away".
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "compare_lengths_difference",
        spec: {
          kind: "ruler",
          id: "ruler-difference-5-plus-3",
          concept: "Comparing lengths",
          prompt: "A red bar is 5 cm long. Make a blue bar that is 3 cm LONGER than it.",
          unit: "cm",
          length: 12,
          startAt: 3,
          startEnd: 5,
          goal: { type: "lengthEquals", value: 8 },
          source: "Ruler (comparing two lengths)",
        },
      },
      {
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "measure_half_quarter_inch",
        spec: {
          kind: "ruler",
          id: "ruler-quarter-inch-2-and-three-quarters",
          concept: "Halves & quarters of an inch",
          prompt: "The bar starts at 1¼. Make it 2¾ inches long — count the quarter marks.",
          unit: "in",
          length: 6,
          precision: 0.25,
          startAt: 1.25,
          startEnd: 2,
          goal: { type: "lengthEquals", value: 2.75 },
          source: "Ruler (quarter-inch scale)",
        },
      },

      // time ──────────────────────────────────────────────────────────────
      {
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "tell_time_hour_half_hour",
        spec: {
          kind: "clock",
          id: "clock-half-past-4",
          concept: "Half past",
          prompt: "Make the clock show half past 4.",
          startHour: 12,
          startMinute: 0,
          snapMinutes: 30,
          goal: { type: "showTime", hour: 4, minute: 30 },
          source: "Clock (hour & half hour)",
        },
      },
      {
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "tell_time_five_minutes",
        spec: {
          kind: "clock",
          id: "clock-show-3-45",
          concept: "Time to five minutes",
          prompt: "Make the clock show 3:45. Look where the hour hand ends up.",
          startHour: 9,
          startMinute: 0,
          snapMinutes: 5,
          showMinuteNumerals: true,
          goal: { type: "showTime", hour: 3, minute: 45 },
          source: "Clock (five-minute intervals)",
        },
      },
      {
        // Snap 1 — every tick, and no minute numerals to lean on.
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "tell_time_to_minute",
        spec: {
          kind: "clock",
          id: "clock-show-7-23",
          concept: "Time to the minute",
          prompt: "Make the clock show 7:23.",
          startHour: 2,
          startMinute: 0,
          snapMinutes: 1,
          goal: { type: "showTime", hour: 7, minute: 23 },
          source: "Clock (to the minute)",
        },
      },
      {
        // COMPUTE-STYLE: the landing time is never named, and the jump crosses
        // the hour so the carry is the work.
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "elapsed_time_minutes",
        spec: {
          kind: "clock",
          id: "clock-elapsed-20-past-2-50",
          concept: "Elapsed time",
          prompt: "It's 2:50. Move the hands on by 20 minutes.",
          startHour: 2,
          startMinute: 50,
          snapMinutes: 5,
          goal: { type: "advanceBy", minutes: 20 },
          source: "Clock (elapsed time across the hour)",
        },
      },
      {
        // A second elapsed jump, landing on the dial's wrap point (11:40 + 35 =
        // 12:15). The first crosses a plain hour; this crosses 12, where the
        // hour numeral resets to 12 rather than counting up — the carry that
        // trips scholars who treat the dial as a straight number line.
        // COMPUTE-STYLE: the landing time is never named.
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "elapsed_time_minutes",
        spec: {
          kind: "clock",
          id: "clock-elapsed-35-from-11-40",
          concept: "Elapsed time",
          prompt: "It's 11:40. Move the hands on by 35 minutes — you'll pass 12.",
          startHour: 11,
          startMinute: 40,
          snapMinutes: 5,
          goal: { type: "advanceBy", minutes: 35 },
          source: "Clock (elapsed time across the hour)",
        },
      },

      // money ─────────────────────────────────────────────────────────────
      {
        // Exactly ONE coin for 25¢: the only way through is knowing which coin
        // is worth what, which is precisely this node.
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "coin_values",
        spec: {
          kind: "money",
          id: "money-25-cents-one-coin",
          concept: "US coin values",
          prompt: "Make 25¢ using exactly ONE coin.",
          available: ["penny", "nickel", "dime", "quarter"],
          goal: { type: "amountEqualsWithCount", cents: 25, count: 1 },
          source: "Money (coin values)",
        },
      },
      {
        // The dime case, which this node's rationale singles out: the dime is
        // the SMALLEST coin yet worth more than the bigger nickel, so a scholar
        // reaching for size gets it wrong. Exactly one coin for 10¢ forces the
        // value, not the size, to decide.
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "coin_values",
        spec: {
          kind: "money",
          id: "money-10-cents-one-coin",
          concept: "US coin values",
          prompt: "Make 10¢ using exactly ONE coin.",
          available: ["penny", "nickel", "dime", "quarter"],
          goal: { type: "amountEqualsWithCount", cents: 10, count: 1 },
          source: "Money (coin values)",
        },
      },
      {
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "count_mixed_coins",
        spec: {
          kind: "money",
          id: "money-make-47-cents",
          concept: "Counting money",
          prompt: "Put exactly 47¢ in the tray.",
          available: ["penny", "nickel", "dime", "quarter"],
          goal: { type: "amountEquals", cents: 47 },
          source: "Money (counting a coin collection)",
        },
      },
      {
        // COMPUTE-STYLE: the minimum is the discovery, never named.
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "make_amount_with_coins",
        spec: {
          kind: "money",
          id: "money-fewest-coins-63-cents",
          concept: "Fewest coins",
          prompt: "Make 63¢ with as few coins as you can.",
          available: ["penny", "nickel", "dime", "quarter"],
          goal: { type: "fewestPieces", cents: 63 },
          source: "Money (minimising the count)",
        },
      },
      {
        // The build run to an EXACT count instead of the fewest — the other half
        // of this node ("make a given amount with coins"). 30¢ in exactly 4
        // coins rules out 3 dimes and forces a real decomposition (dime, dime,
        // nickel, nickel), so the count is a genuine constraint, not decoration.
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "make_amount_with_coins",
        spec: {
          kind: "money",
          id: "money-30-cents-four-coins",
          concept: "Making an amount to a count",
          prompt: "Make 30¢ using exactly 4 coins.",
          available: ["penny", "nickel", "dime", "quarter"],
          goal: { type: "amountEqualsWithCount", cents: 30, count: 4 },
          source: "Money (an exact-count decomposition)",
        },
      },

      // capacity ──────────────────────────────────────────────────────────
      {
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "liquid_volume_measure",
        spec: {
          kind: "liquid",
          id: "liquid-fill-3-cups",
          concept: "Liquid volume",
          prompt: "Pour the tall jar until it holds exactly 3 cups.",
          unit: "cup",
          vessels: [{ capacity: 4, label: "Tall jar" }],
          goal: { type: "fillTo", vessel: 0, value: 3 },
          source: "Measuring jars (liquid volume)",
        },
      },
      {
        // The sub-unit reading, the capacity sibling of the quarter-inch ruler:
        // a half-cup mark sits between the whole numbers, so 2½ cups means
        // stopping ON a mark that isn't labelled. Reads a fraction off a
        // physical scale rather than the whole-number level the first item uses.
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "liquid_volume_measure",
        spec: {
          kind: "liquid",
          id: "liquid-fill-2-and-a-half-cups",
          concept: "Reading a half-cup mark",
          prompt: "Pour the jar until it holds exactly 2½ cups — mind the half-cup marks.",
          unit: "cup",
          step: 0.5,
          vessels: [{ capacity: 4, label: "Tall jar" }],
          goal: { type: "fillTo", vessel: 0, value: 2.5 },
          source: "Measuring jars (half-cup scale)",
        },
      },
      {
        // 5 cups across 4- and 2-cup jars: no single jar can hold it, so the
        // amount genuinely has to be composed.
        domain: GEOMETRY_MEASUREMENT_DOMAIN,
        skillKey: "liquid_volume_combine",
        spec: {
          kind: "liquid",
          id: "liquid-total-5-cups",
          concept: "Composing measures",
          prompt: "Get 5 cups altogether — no single jar is big enough.",
          unit: "cup",
          vessels: [
            { capacity: 4, label: "Tall jar" },
            { capacity: 2, label: "Short jar" },
          ],
          goal: { type: "totalEquals", value: 5 },
          source: "Measuring jars (composing measures)",
        },
      },
    ];

    const now = Date.now();
    let seeded = 0;
    const bySkill = new Map<string, typeof targets>();
    for (const t of targets) {
      const list = bySkill.get(t.skillKey);
      if (list) list.push(t);
      else bySkill.set(t.skillKey, [t]);
    }

    for (const [skillKey, entries] of bySkill) {
      const node = await ctx.db
        .query("knowledgeNodes")
        .withIndex("by_nodeKey", (q) => q.eq("nodeKey", skillKey))
        .first();
      if (!node) throw new Error(`Unknown skill: ${skillKey} — seed the domain graph first.`);

      // Idempotent: update exactly the rows this fixture owns for this skill,
      // matched by manipulativeSpec.id. Updating in place preserves the opaque
      // stored-item IDs held by in-flight sessions and attempt telemetry.
      const prior = await ctx.db
        .query("practiceItems")
        .withIndex("by_skill", (q) => q.eq("skillKey", skillKey))
        .collect();
      const priorById = new Map<string, typeof prior>();
      for (const p of prior) {
        if (p.verifierKind !== MANIPULATIVE_VERIFIER_KIND) continue;
        const parsed = parseManipulativeSpec(p.manipulativeSpec);
        if (!parsed) continue;
        const rows = priorById.get(parsed.id);
        if (rows) rows.push(p);
        else priorById.set(parsed.id, [p]);
      }

      for (const { spec } of entries) {
        assertGradableManipulative(spec);
        const fields = {
          skillKey,
          domain: node.domain,
          stem: spec.prompt,
          answerType: MANIPULATIVE_ANSWER_TYPE,
          answerCanonical: "",
          verifierKind: MANIPULATIVE_VERIFIER_KIND,
          manipulativeSpec: JSON.stringify(spec),
          source: "generated",
          verifiedAt: now,
        } as const;
        const existing = priorById.get(spec.id);
        if (existing?.length) {
          for (const row of existing) await ctx.db.patch(row._id, fields);
        } else {
          await ctx.db.insert("practiceItems", fields);
        }
        seeded++;
      }
    }

    return { seeded, skillKeys: [...bySkill.keys()] };
  },
});

/**
 * DEFAULT dev-cohort fixture — backward-faded worked examples (SPIKE, see
 * convex/lib/practice/fadedSteps.ts). Seeds a handful of fraction-addition
 * (UNLIKE denominators) `practiceItems` rows with `workedSteps` onto
 * `add_subtract_unlike` (fraction-arithmetic), so the fade-scaffold feature is
 * demoable out of the box: a scholar with low/no reps on this skill sees the
 * early steps worked with the final answer-producing step left blank (a
 * COMPLETION problem — never a full answer key); a fluent scholar sees a bare
 * problem. Each item's
 * answer is checked with the SAME arithmetic verifier an LLM-generated
 * candidate goes through (lib/practice/verify.ts) before it's stored — a
 * hand-authored item earns no exemption from that discipline.
 *
 * Idempotent: re-running replaces exactly the rows this fixture owns (matched
 * by `stem`, scoped to this skill), so it never duplicates and never touches
 * any other `add_subtract_unlike` item (e.g. a real generated word problem).
 *
 *   npx convex run practiceSkills:seedFadedWorkedExamples
 */
export const FADED_FRACTION_ADDITION_ITEMS: {
  stem: string;
  answer: string;
  solutionExpression: string;
  workedSteps: { text: string; blankText: string }[];
}[] = [
  {
    stem: "Add: 1/4 + 1/3",
    answer: "7/12",
    solutionExpression: "1/4 + 1/3",
    workedSteps: [
      { text: "Find a common denominator for 4 and 3: 12.", blankText: "Find a common denominator: ?" },
      { text: "Rewrite with twelfths: 1/4 = 3/12 and 1/3 = 4/12.", blankText: "Rewrite both fractions over the common denominator: ?" },
      { text: "Add the numerators and simplify: 3/12 + 4/12 = 7/12.", blankText: "Add the numerators and simplify to get the answer: ?" },
    ],
  },
  {
    stem: "Add: 1/2 + 1/5",
    answer: "7/10",
    solutionExpression: "1/2 + 1/5",
    workedSteps: [
      { text: "Find a common denominator for 2 and 5: 10.", blankText: "Find a common denominator: ?" },
      { text: "Rewrite with tenths: 1/2 = 5/10 and 1/5 = 2/10.", blankText: "Rewrite both fractions over the common denominator: ?" },
      { text: "Add the numerators and simplify: 5/10 + 2/10 = 7/10.", blankText: "Add the numerators and simplify to get the answer: ?" },
    ],
  },
  {
    stem: "Add: 2/3 + 1/6",
    answer: "5/6",
    solutionExpression: "2/3 + 1/6",
    workedSteps: [
      { text: "Find a common denominator for 3 and 6: 6.", blankText: "Find a common denominator: ?" },
      { text: "Rewrite with sixths: 2/3 = 4/6 (1/6 already has denominator 6).", blankText: "Rewrite both fractions over the common denominator: ?" },
      { text: "Add the numerators and simplify: 4/6 + 1/6 = 5/6.", blankText: "Add the numerators and simplify to get the answer: ?" },
    ],
  },
  {
    stem: "Add: 3/4 + 1/6",
    answer: "11/12",
    solutionExpression: "3/4 + 1/6",
    workedSteps: [
      { text: "Find a common denominator for 4 and 6: 12.", blankText: "Find a common denominator: ?" },
      { text: "Rewrite with twelfths: 3/4 = 9/12 and 1/6 = 2/12.", blankText: "Rewrite both fractions over the common denominator: ?" },
      { text: "Add the numerators and simplify: 9/12 + 2/12 = 11/12.", blankText: "Add the numerators and simplify to get the answer: ?" },
    ],
  },
  {
    stem: "Add: 1/6 + 1/4",
    answer: "5/12",
    solutionExpression: "1/6 + 1/4",
    workedSteps: [
      { text: "Find a common denominator for 6 and 4: 12.", blankText: "Find a common denominator: ?" },
      { text: "Rewrite with twelfths: 1/6 = 2/12 and 1/4 = 3/12.", blankText: "Rewrite both fractions over the common denominator: ?" },
      { text: "Add the numerators and simplify: 2/12 + 3/12 = 5/12.", blankText: "Add the numerators and simplify to get the answer: ?" },
    ],
  },
];

export const seedFadedWorkedExamples = internalMutation({
  args: {},
  handler: async (ctx) => {
    const skillKey = "add_subtract_unlike";
    const node = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_nodeKey", (q) => q.eq("nodeKey", skillKey))
      .first();
    if (!node) throw new Error(`Unknown skill: ${skillKey} — seed the domain graph first.`);

    // Idempotent: replace exactly the rows this fixture owns (matched by
    // stem, scoped to this skill) so re-running never duplicates and never
    // touches any other item on this skill (e.g. a real generated word
    // problem or the LLM-prewarmed pool).
    const owned = new Set(FADED_FRACTION_ADDITION_ITEMS.map((it) => it.stem));
    const prior = await ctx.db
      .query("practiceItems")
      .withIndex("by_skill", (q) => q.eq("skillKey", skillKey))
      .collect();
    for (const p of prior) {
      if (p.workedSteps && owned.has(p.stem)) await ctx.db.delete(p._id);
    }

    const now = Date.now();
    let seeded = 0;
    for (const it of FADED_FRACTION_ADDITION_ITEMS) {
      // Same verifier discipline as an LLM-generated candidate (verify.ts) —
      // a hand-authored seed item earns no exemption: never persist an item
      // whose stated answer disagrees with its arithmetic.
      const verdict = verifyCandidate({
        stem: it.stem,
        answer: it.answer,
        answerType: "fraction",
        solutionExpression: it.solutionExpression,
      });
      if (!verdict.ok) {
        throw new Error(`Faded worked-example seed failed verification: ${verdict.reason} (${it.stem})`);
      }
      await ctx.db.insert("practiceItems", {
        skillKey,
        domain: node.domain,
        stem: it.stem,
        answerType: "fraction",
        answerCanonical: it.answer,
        verifierKind: "arithmetic",
        workedSteps: it.workedSteps,
        source: "generated",
        verifiedAt: now,
      });
      seeded++;
    }
    return { skillKey, domain: node.domain, seeded };
  },
});

/**
 * DEV/TEST fixture — seed a scholar into a re-probe CANDIDATE state so the
 * "you're on a roll — jump ahead?" offer (§4 B1-M2) can be exercised on the
 * practice done screen. Seeds `count` valve-"accelerated" credits at the BOTTOM
 * of a strand (default the first strand, "counting"), leaving headroom above so
 * `reprobeCandidates` fires. Deletes any existing rows for those skills first
 * (idempotent). Pair with `devSeedPractice` first so the scholar is already
 * placed (won't hit the placement gate) and has a real session to finish.
 *
 *   npx convex run practiceSkills:devSeedReprobeCandidate '{"scholarUsername":"test-scholar-001"}'
 */
export const devSeedReprobeCandidate = internalMutation({
  args: {
    scholarUsername: v.string(),
    strand: v.optional(v.string()),
    count: v.optional(v.number()),
    domain: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.scholarUsername))
      .first();
    if (!user) throw new Error(`No scholar with username ${args.scholarUsername}`);
    const domain = args.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN;
    const now = Date.now();

    const { orders, nodeByKey } = await loadPlacementContext(ctx, domain);
    const order = args.strand ? orders.find((o) => o.strand === args.strand) : orders[0];
    if (!order) throw new Error(`No strand ${args.strand ?? "(first)"} in domain ${domain}`);

    const n = Math.max(REPROBE_STRAND_ACCEL, args.count ?? REPROBE_STRAND_ACCEL + 1);
    if (order.orderedKeys.length <= n) {
      throw new Error(`Strand ${order.strand} has no headroom above ${n} accelerated credits`);
    }

    const seededKeys = order.orderedKeys.slice(0, n);
    const existing = await loadMastery(ctx, user._id, domain);
    for (const key of seededKeys) {
      const prior = existing.get(key);
      if (prior) await ctx.db.delete(prior._id);
      await ctx.db.insert("practiceMastery", {
        scholarId: user._id,
        skillKey: key,
        domain,
        strand: nodeByKey.get(key)?.strand,
        repetition: FLUENT_REPS,
        halfLifeDays: PLACEMENT_HALF_LIFE_DAYS,
        lastPracticedAt: now,
        frontier: false,
        source: ACCEL_SOURCE,
        updatedAt: now,
      });
    }
    return { strand: order.strand, seededKeys, frontierKey: order.orderedKeys[n] };
  },
});
