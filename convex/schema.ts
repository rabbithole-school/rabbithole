import { defineSchema, defineTable } from "convex/server";
import { v, type Infer } from "convex/values";
import { authTables } from "@convex-dev/auth/server";
import { ROLES } from "./lib/roles";
import {
  seedOriginValidator,
  seedStatusValidator,
  seedSuggestionTypeValidator,
} from "./lib/seeds";
import { promptVisualValidator } from "./lib/practice/promptVisual";
import type { ErrorPattern } from "./lib/practice/errorPatterns";
import { healthRecordSchemaFields } from "./lib/healthRecord";
import { inputModalityValidator } from "./lib/inputModality";
import { policyIRValidator } from "../lib/simulator/policyIR";
import { preflightResultValidator } from "./lib/curriculumPreflightResult";

const guardianFormIdValidator = v.union(
  v.literal("annual_program_participation"),
  v.literal("keiki_cooking_lab_liability_waiver"),
  v.literal("extended_education_visiting_student"),
);
const guardianFormAnswersValidator = v.union(
  v.object({
    kind: v.literal("annual_program_participation"),
    publicMediaOptOut: v.boolean(),
    fieldTripRestriction: v.boolean(),
    fieldTripRestrictionDetails: v.string(),
    peRecessRestriction: v.boolean(),
    peRecessRestrictionDetails: v.string(),
    swimmingRestriction: v.boolean(),
    swimmingRestrictionDetails: v.string(),
  }),
  v.object({
    kind: v.literal("keiki_cooking_lab_liability_waiver"),
    parentFullName: v.string(),
    studentFullName: v.string(),
    details: v.string(),
    waiverDate: v.string(),
  }),
  v.object({
    kind: v.literal("extended_education_visiting_student"),
    confirmationEmail: v.string(),
    studentFullName: v.string(),
    studentPreferredName: v.string(),
    studentDateOfBirth: v.string(),
    studentGrade: v.string(),
    studentCurrentSchool: v.string(),
    studentHomeAddress: v.string(),
    extendedEducationClass: v.union(
      v.literal(""),
      v.literal("robotics"),
      v.literal("photography"),
    ),
    guardian1: v.object({
      name: v.string(),
      relationship: v.string(),
      homePhone: v.string(),
      cellPhone: v.string(),
      workPhone: v.string(),
      email: v.string(),
    }),
    guardian2: v.object({
      name: v.string(),
      relationship: v.string(),
      homePhone: v.string(),
      cellPhone: v.string(),
      workPhone: v.string(),
      email: v.string(),
    }),
    emergencyContacts: v.array(
      v.object({
        name: v.string(),
        relationship: v.string(),
        phone: v.string(),
      }),
    ),
    authorizedPickupPersons: v.array(
      v.object({
        name: v.string(),
        relationship: v.string(),
        phone: v.string(),
      }),
    ),
    notAuthorizedPickupPerson: v.object({
      name: v.string(),
      relationship: v.string(),
      reason: v.string(),
    }),
    primaryPhysician: v.string(),
    primaryPhysicianPhone: v.string(),
    preferredHospital: v.string(),
    insuranceProvider: v.string(),
    insurancePolicyNumber: v.string(),
    hasAllergies: v.union(v.literal(""), v.literal("yes"), v.literal("no")),
    allergyTypes: v.array(
      v.union(
        v.literal("food"),
        v.literal("medication"),
        v.literal("environmental"),
        v.literal("insect_stings"),
        v.literal("other"),
      ),
    ),
    allergyReactionDescription: v.string(),
    allergyEmergencyTreatment: v.string(),
    medicalConditions: v.array(
      v.union(
        v.literal("asthma"),
        v.literal("diabetes"),
        v.literal("seizure_disorder"),
        v.literal("severe_allergies"),
        v.literal("heart_condition"),
        v.literal("hearing_vision_impairment"),
        v.literal("other"),
      ),
    ),
    medicalConditionDetails: v.string(),
    currentlyTakingMedications: v.union(
      v.literal(""),
      v.literal("yes"),
      v.literal("no"),
    ),
    medications: v.array(
      v.object({
        name: v.string(),
        purpose: v.string(),
        dosage: v.string(),
        administrationInstructions: v.string(),
      }),
    ),
    carriesEmergencyMedication: v.union(
      v.literal(""),
      v.literal("yes"),
      v.literal("no"),
    ),
    emergencyMedicalCareAuthorized: v.boolean(),
    firstAidAuthorized: v.union(
      v.literal(""),
      v.literal("yes"),
      v.literal("no"),
    ),
    emergencyTransportationAuthorized: v.union(
      v.literal(""),
      v.literal("yes"),
      v.literal("no"),
    ),
    liabilityWaiverAgreed: v.boolean(),
    mediaRelease: v.union(
      v.literal(""),
      v.literal("grant"),
      v.literal("do_not_grant"),
    ),
    parentCertificationAgreed: v.boolean(),
    printedName: v.string(),
    signatureDate: v.string(),
  }),
);

// Validated union of the six documented arithmetic error patterns (Ashlock
// taxonomy; see convex/lib/practice/errorPatterns.ts — the same taxonomy
// real scholars' practiceErrorEvents are tagged with). Explicit literals give a
// precise document type; the compile-time assertion below keeps this set in
// exact sync with the canonical ErrorPattern union (adding a pattern there
// breaks the build until it's added here too).
const errorPatternValidator = v.union(
  v.literal("SMALLER_FROM_LARGER"),
  v.literal("DROPPED_CARRY"),
  v.literal("PLACE_MISALIGNMENT"),
  v.literal("OFF_BY_ONE_SKIP"),
  v.literal("REMAINDER_IGNORED"),
  v.literal("REVERSED_OPERANDS"),
);
type _ErrorPatternValidatorMatches =
  [ErrorPattern] extends [Infer<typeof errorPatternValidator>]
    ? [Infer<typeof errorPatternValidator>] extends [ErrorPattern]
      ? true
      : never
    : never;
const _errorPatternValidatorExhaustive: _ErrorPatternValidatorMatches = true;
void _errorPatternValidatorExhaustive;

// A scripted, documented misconception a synthetic scholar (sim cast member)
// carries — adoptable #5. Additive/optional; ordinary personas omit it.
const misconceptionValidator = v.object({
  pattern: errorPatternValidator,
  skillKey: v.optional(v.string()),
  note: v.optional(v.string()),
});

const instructionAtomValidator = v.union(
  v.object({
    kind: v.literal("story_hook"),
    hook: v.string(),
    fromKey: v.optional(v.string()),
    toKey: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal("micro_explain"),
    text: v.string(),
  }),
  v.object({
    kind: v.literal("worked_example"),
    strategyLabel: v.string(),
    steps: v.array(v.string()),
    examplePrompt: v.string(),
    exampleAnswer: v.string(),
  }),
  v.object({
    kind: v.literal("try_it"),
    strategyLabel: v.string(),
    steps: v.array(v.string()),
    examplePrompt: v.string(),
    exampleAnswer: v.string(),
    answerType: v.optional(
      v.union(
        v.literal("integer"),
        v.literal("decimal"),
        v.literal("fraction"),
        v.literal("expression"),
        v.literal("multipleChoice"),
      ),
    ),
  }),
  v.object({
    kind: v.literal("manipulative"),
    spec: v.string(),
  }),
  v.object({
    kind: v.literal("video"),
    provider: v.literal("youtube"),
    videoId: v.string(),
    startSec: v.number(),
    endSec: v.number(),
    captionText: v.string(),
    sourceLabel: v.string(),
    sourceUrl: v.string(),
  }),
);

/**
 * ─── THIS FILE IS THE SOURCE OF TRUTH FOR THE DATA MODEL ───────────────
 *
 * Don't maintain a second prose copy of the table list anywhere (docs
 * drift; the code can't). When a doc needs the data model, it points
 * here. Put the *why* of each table in a comment above its
 * `defineTable` so the next reader/agent gets the rationale inline.
 *
 * The tables fall into three layers — keep new tables in the layer they
 * belong to and comment which one:
 *
 *   1. DESIGN (curriculum) — what *could* be taught, never tied to a
 *      cohort. units → lessons → activities, plus the building blocks
 *      (personas, perspectives, processes) and the standards graph
 *      (standards, standardsDocuments).
 *
 *   2. EXECUTION (assignments) — a unit *being run* with a cohort.
 *      `assignments` is the pivot (one cohort × one unit × one
 *      teacher); every execution-side row stamps `assignmentId` so the
 *      same unit can run many times without work bleeding across
 *      cohorts: sessions (+ messages, artifacts, appStates, processState),
 *      activityCompletions, deliverables, shareBackDigests. Roster
 *      helpers: scholarGroups, teacherAffinities. Curriculum-design
 *      dry-run: testDriveFlags. (focusSettings was dropped — replaced
 *      by assignments; see that table's comment +
 *      review/design-vs-execution-split.md.)
 *
 *   3. OBSERVATION (learning record) — what the system noticed:
 *      analyses, masteryObservations (+ teacherMasteryOverrides),
 *      sessionSignals, crossDomainConnections, seeds, observations.
 *
 * Surface mapping: the Curriculum tab is the DESIGN surface (it lists a
 * unit's assignments + an Assign CTA, not live class progress); the
 * Assignments tab is the EXECUTION surface (the Run page).
 * ───────────────────────────────────────────────────────────────────────
 */
const sessionTableFields = {
    userId: v.id("users"),
    // Tenant at the moment this learning session is created. This cannot be
    // reconstructed from users.institutionId for adults whose home role is
    // parent/staff but whose learner role belongs to a different institution.
    institutionId: v.optional(v.id("institutions")),
    unitId: v.optional(v.id("units")),
    lessonId: v.optional(v.id("lessons")),
    // The lesson activity (sub-task) this project is working on, if any.
    activityId: v.optional(v.id("activities")),
    // Conversation stays the read-time default for every existing row. A
    // Workbench deliberately reuses the session spine for its sideline tutor,
    // while this discriminator stops chat-assuming consumers from guessing.
    sessionMode: v.optional(
      v.union(
        v.literal("conversation"),
        v.literal("workbench"),
        v.literal("vibecode"),
      ),
    ),
    title: v.string(),
    analysisSummary: v.optional(v.string()),
    pulseScore: v.optional(v.number()),
    teacherWhisper: v.optional(v.string()),
    pendingWhisper: v.optional(v.string()),
    readingLevelOverride: v.optional(v.string()),
    // Time limit mode (parent-set)
    sessionTimeLimit: v.optional(v.number()), // minutes
    sessionStartTime: v.optional(v.number()), // timestamp ms
    isArchived: v.boolean(),
    // Scholar intentionally re-entered a completed session to keep revising.
    // Completion remains in activityCompletions/scholarUnitBadges; this marker
    // only keeps the reopened work visible on the active plate.
    reopenedAt: v.optional(v.number()),
    // The Assignment (cohort container) this project belongs to. Every
    // execution-side row stamps this so cohort A and cohort B never
    // blend in counts, share-back digests, or progress widgets.
    // See review/design-vs-execution-split.md.
    assignmentId: v.optional(v.id("assignments")),
    activityCompletedAt: v.optional(v.number()), // timestamp ms — scholar finished this activity
    // Last explicit scholar wrap-up refresh. Bounds observer reruns without
    // changing activity completion or adding a parallel recap lifecycle.
    recapRequestedAt: v.optional(v.number()),
    // The post-tool tutor message that naturally closes the activity. Completion
    // UI is anchored immediately after this message so later voluntary chat
    // cannot make a new question look like part of the completion handoff.
    activityCompletionMessageId: v.optional(v.id("messages")),
    // Snapshot of the resolved rubric criteria for THIS project.
    // Populated when the parent activity is auto-mode: the system
    // generates criteria fresh at project creation time, calibrated to
    // the scholar's reading level. Manual-mode activities don't set
    // this — the UI + rubric check fall back to
    // `activity.deliverable.criteria` directly.
    deliverableCriteria: v.optional(
      v.array(
        v.object({
          id: v.string(),
          label: v.string(),
          description: v.optional(v.string()),
        }),
      ),
    ),
    // Async generation state for auto-mode rubrics. "pending" while
    // the AI generation action is in flight; "ready" once
    // deliverableCriteria is populated; "error" if generation failed
    // (UI surfaces and offers a retry).
    deliverableCriteriaStatus: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("ready"),
        v.literal("error"),
      ),
    ),
    deliverableCriteriaError: v.optional(v.string()),
    // "Big picture" reflection — AI-generated narrative that
    // situates this activity in the unit theme + scholar's arc.
    // Surfaced via the compass button in the project header (the
    // reflection drawer). Generated once at project creation,
    // grounded in real DB rows so we never fabricate "two weeks
    // ago you read X" when no such X exists.
    //
    // Flexible shape: 1-4 sections, AI picks its own headings and
    // omits any that would be filler. A single-activity unit gets
    // maybe 1-2 sections (just the big idea, maybe a "this activity"
    // tie-in). A multi-lesson unit might get 4 — big idea, arc so
    // far, this activity, what's next. The drawer renders whatever
    // comes back.
    reflection: v.optional(
      v.object({
        sections: v.array(
          v.object({
            heading: v.string(),
            body: v.string(),
          }),
        ),
        generatedAt: v.number(),
      }),
    ),
    reflectionStatus: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("ready"),
        v.literal("error"),
      ),
    ),
    reflectionError: v.optional(v.string()),
    // Test-drive mode: this project is a teacher dry-run of an activity, not
    // a real scholar session. Observer/dossier/mastery/seeds writes are
    // skipped, and the project is filtered out of dashboard / scholar lists.
    // Owned by the teacher (`userId = teacher._id`).
    isTestDrive: v.optional(v.boolean()),
    // Offline project: a project with no chat thread, materialized from a
    // scanned/uploaded deliverable (see portfolioMaterialize.ts). Holds the
    // scholar's file deliverable(s) for an offline activity so scanned work
    // is a first-class deliverable everywhere downstream (Run page, share
    // backs, completions). Filtered out of the scholar's chat-project lists
    // exactly like isTestDrive — there's no conversation to resume. Owned by
    // the scholar (`userId = scholar._id`), unlike test-drive projects.
    isOffline: v.optional(v.boolean()),
    // Seeded exemplar transcript: rich dev seed rows that power teacher-facing
    // dashboards/debriefs but must never be resumed as a scholar's live session.
    seedExemplar: v.optional(v.boolean()),
    // Test-drive "View as": render the AI tutor's context as if this project
    // belonged to a different identity, without actually changing ownership
    // or producing writes. Two modes (mutually exclusive):
    //   1. Real scholar — `testDriveAsScholarId` set. Dossier, reading level,
    //      mastery, signals, seeds, directives, and name come from that
    //      scholar's records (purely read).
    //   2. Synthetic scholar — `testDriveSynthetic*` fields set. A virtual
    //      profile sourced entirely from these fields; no DB lookups for
    //      scholar-scoped data (mastery/signals/seeds skipped).
    // When neither is set, test-drive falls back to "view as self" (the
    // teacher's own identity, which has no useful dossier — the original
    // baseline behavior).
    testDriveAsScholarId: v.optional(v.id("users")),
    testDriveSyntheticName: v.optional(v.string()),
    testDriveSyntheticReadingLevel: v.optional(v.string()),
    testDriveSyntheticDossier: v.optional(v.string()),
    // Test-drive "Reset & replay": the prior drive's scholar turns (minus
    // the synthetic `<start>` greeting) carried forward onto this fresh
    // drive so the teacher can auto-re-send them against the edited prompt
    // instead of re-typing the conversation. `replayStopAfter` is the turn
    // count that lands on the last flagged tutor response (the moment under
    // test) where the driver pauses; it equals replayScript.length when
    // nothing was flagged (replay everything). Both are stamped only by a
    // replay reset and cleared (via sessions.clearReplayScript) once the
    // teacher consumes or dismisses the offer, so a reload doesn't re-offer
    // a spent script. See review/test-drive-replay-plan.md.
    replayScript: v.optional(v.array(v.string())),
    replayStopAfter: v.optional(v.number()),
    // Denormalized from last message for efficient teacher dashboard queries
    lastMessageAt: v.optional(v.number()),
    lastMessageRole: v.optional(v.string()),
    lastMessagePreview: v.optional(v.string()), // first 120 chars of last message
    // Origin tag for projects spawned from a `seeds` row. Used by the
    // scholar plate query to attribute Independent-Study bare-row
    // projects back to the seed they came from. Pre-existing prod
    // orphans don't carry this; the plate query treats any anchorless
    // project as a bare IS row regardless.
    seedId: v.optional(v.id("seeds")),
  };

// ── Worlds -- authored specs and server-run simulation records ───────────────
//
// Convex validators establish SHAPE. The code-owned template registry in
// lib/simulator/templates/ establishes meaning: numeric ranges, unique slot ids,
// sense/action/metric vocabularies, prompt limits, and template versions.
const worldSenseValidator = v.object({
  senseId: v.string(),
  range: v.optional(v.number()),
  channels: v.optional(v.array(v.string())),
});

const speciesSlotValidator = v.object({
  slotId: v.string(),
  label: v.string(),
  countMin: v.number(),
  countMax: v.number(),
  defaultCount: v.number(),
  senses: v.array(worldSenseValidator),
  starterHint: v.optional(v.string()),
  // A LOCKED slot's deck is teacher-authored and read-only for the scholar —
  // see the doc comment on `SpeciesSlot` in lib/simulator/contract.ts.
  locked: v.optional(v.boolean()),
});

const ecosystemTerrainPointValidator = v.object({
  x: v.number(),
  y: v.number(),
});

const ecosystemLandscapeValidator = v.object({
  version: v.literal(1),
  seed: v.string(),
  regionCount: v.number(),
  roughness: v.number(),
  lowlandCoverage: v.number(),
  highlandCoverage: v.number(),
});

const ecosystemGridConfigValidator = v.object({
  width: v.number(),
  height: v.number(),
  boundary: v.union(v.literal("bounded"), v.literal("toroidal")),
  initialResourceDensity: v.number(),
  resourceRegrowthPerTick: v.number(),
  corpseDecayTicks: v.number(),
  baseMetabolicCost: v.number(),
  reproductionEnergyThreshold: v.number(),
  maxAutomata: v.number(),
  environmentalNoise: v.object({
    enabled: v.boolean(),
    amplitude: v.number(),
  }),
  initialPositions: v.optional(
    v.record(
      v.string(),
      v.array(
        v.object({
          x: v.number(),
          y: v.number(),
        }),
      ),
    ),
  ),
  scoringSlotId: v.optional(v.string()),
  biome: v.optional(v.union(v.literal("reef"), v.literal("meadow"))),
  landscape: v.optional(ecosystemLandscapeValidator),
  terrain: v.optional(
    v.object({
      shelter: v.array(ecosystemTerrainPointValidator),
      current: v.array(
        v.object({
          x: v.number(),
          y: v.number(),
          direction: v.union(
            v.literal("north"),
            v.literal("east"),
            v.literal("south"),
            v.literal("west"),
          ),
        }),
      ),
      shallows: v.array(ecosystemTerrainPointValidator),
      predatorSlotIds: v.array(v.string()),
    }),
  ),
  heredity: v.optional(
    v.object({
      enabled: v.boolean(),
      mutationStd: v.number(),
    }),
  ),
});

const prisonersDilemmaConfigValidator = v.object({
  rounds: v.optional(v.number()),
  noiseProbability: v.number(),
  payoffMatrix: v.object({
    mutualCooperation: v.number(),
    temptation: v.number(),
    sucker: v.number(),
    mutualDefection: v.number(),
  }),
  maxAutomata: v.literal(2),
});

const matrixGameActionValidator = v.object({
  actionId: v.union(v.literal("optionA"), v.literal("optionB")),
  label: v.string(),
});

const matrixGamePayoffValidator = v.object({
  a: v.number(),
  b: v.number(),
});

const matrixGameConfigValidator = v.object({
  rounds: v.number(),
  noiseProbability: v.number(),
  actions: v.array(matrixGameActionValidator),
  payoffs: v.object({
    optionA: v.object({
      optionA: matrixGamePayoffValidator,
      optionB: matrixGamePayoffValidator,
    }),
    optionB: v.object({
      optionA: matrixGamePayoffValidator,
      optionB: matrixGamePayoffValidator,
    }),
  }),
  maxAutomata: v.literal(2),
});

const publicGoodsConfigValidator = v.object({
  rounds: v.number(),
  endowmentPerRound: v.number(),
  multiplier: v.number(),
  noiseProbability: v.number(),
  maxAutomata: v.number(),
});

const measuredCriterionValidator = v.object({
  kind: v.literal("measured"),
  metricKey: v.string(),
  direction: v.union(
    v.literal("maximize"),
    v.literal("minimize"),
    v.literal("target"),
  ),
  target: v.optional(v.number()),
});

const galleryCriterionValidator = v.object({
  kind: v.literal("gallery"),
  frameKey: v.string(),
  curatorNote: v.optional(v.string()),
});

const adversarialCriterionValidator = v.object({
  kind: v.literal("adversarial"),
  scoreMetricKeys: v.array(v.string()),
});

const tickBudgetValidator = v.object({
  iterationTicks: v.number(),
  seasonTicks: v.number(),
  absoluteMaxTicks: v.number(),
});

const worldInterpreterValidator = v.union(
  v.object({
    kind: v.literal("llm"),
    role: v.literal("AUTOMATON"),
  }),
  v.object({
    kind: v.literal("scripted"),
    interpreterId: v.string(),
  }),
);

export const simulatorSpecValidator = v.union(
  v.object({
    version: v.literal(1),
    templateId: v.literal("ecosystemGrid"),
    templateVersion: v.number(),
    config: ecosystemGridConfigValidator,
    criterion: v.union(measuredCriterionValidator, galleryCriterionValidator),
    speciesSlots: v.array(speciesSlotValidator),
    tickBudget: tickBudgetValidator,
    interpreter: worldInterpreterValidator,
    microWorld: v.boolean(),
  }),
  v.object({
    version: v.literal(1),
    templateId: v.literal("prisonersDilemma"),
    templateVersion: v.number(),
    config: prisonersDilemmaConfigValidator,
    criterion: adversarialCriterionValidator,
    speciesSlots: v.array(speciesSlotValidator),
    tickBudget: tickBudgetValidator,
    interpreter: worldInterpreterValidator,
    microWorld: v.boolean(),
  }),
  v.object({
    version: v.literal(1),
    templateId: v.literal("matrixGame"),
    templateVersion: v.number(),
    config: matrixGameConfigValidator,
    criterion: v.union(adversarialCriterionValidator, measuredCriterionValidator),
    speciesSlots: v.array(speciesSlotValidator),
    tickBudget: tickBudgetValidator,
    interpreter: worldInterpreterValidator,
    microWorld: v.boolean(),
  }),
  v.object({
    version: v.literal(1),
    templateId: v.literal("publicGoods"),
    templateVersion: v.number(),
    config: publicGoodsConfigValidator,
    criterion: measuredCriterionValidator,
    speciesSlots: v.array(speciesSlotValidator),
    tickBudget: tickBudgetValidator,
    interpreter: worldInterpreterValidator,
    microWorld: v.boolean(),
  }),
);

const deckCardValidator = v.object({
  slotId: v.string(),
  count: v.number(),
  prompt: v.string(),
});

const hypothesisValidator = v.object({
  prediction: v.union(
    v.literal("better"),
    v.literal("worse"),
    v.literal("about_the_same"),
    v.literal("exploratory"),
  ),
  note: v.optional(v.string()),
});

const metricValueValidator = v.object({
  key: v.string(),
  value: v.number(),
});

const metricSampleValidator = v.object({
  tick: v.number(),
  values: v.array(metricValueValidator),
});

const usageValidator = v.object({
  inputTokens: v.number(),
  cacheWriteTokens: v.number(),
  cacheReadTokens: v.number(),
  outputTokens: v.number(),
});

const compiledPolicySnapshotValidator = v.union(
  v.object({
    slotId: v.string(),
    status: v.literal("ready"),
    policyHash: v.string(),
    policy: policyIRValidator,
  }),
  v.object({
    slotId: v.string(),
    status: v.literal("fallback"),
    reason: v.union(
      v.literal("compiling"),
      v.literal("failed"),
      v.literal("missing"),
    ),
  }),
);

const automatonTickRecordValidator = v.object({
  automatonId: v.string(),
  slotId: v.string(),
  // These JSON fields are bounded and parsed through the frozen contract before
  // insert. They preserve exactly what the Automaton saw, chose among, and said.
  observationJson: v.string(),
  scratchBefore: v.optional(v.string()),
  tickPhase: v.string(),
  legalActionsJson: v.string(),
  decisionHash: v.string(),
  source: v.union(
    v.literal("model"),
    v.literal("decision_cache"),
    v.literal("compiled"),
    v.literal("compiled-fallback"),
  ),
  cacheOrigin: v.optional(
    v.object({
      runId: v.id("simulatorRuns"),
      startTick: v.number(),
      tick: v.number(),
      automatonId: v.string(),
    }),
  ),
  modelResponseJson: v.string(),
  reasoning: v.string(),
  policyRuleId: v.optional(v.string()),
  policyTrace: v.optional(v.string()),
  requestedActionJson: v.string(),
  acceptedActionJson: v.string(),
  accepted: v.boolean(),
  invalidCode: v.optional(v.string()),
  scratchAfter: v.optional(v.string()),
  usage: v.optional(usageValidator),
});

const tickRecordValidator = v.object({
  tick: v.number(),
  phase: v.string(),
  // Replay needs the exact deterministic physics seed; run identity is
  // intentionally absent from the model decision hash but not from physics.
  physicsSeed: v.optional(v.string()),
  automata: v.array(automatonTickRecordValidator),
  deltaJson: v.string(),
  metrics: v.array(metricValueValidator),
  invalidActionCount: v.number(),
});

// ── PCM (Parallel Curriculum Model) dimension ──────────────────────────
// Carl's four assessment dimensions. Used both as an OPTIONAL observer tag
// on evidence rows (masteryObservations / sessionSignals /
// crossDomainConnections) and as the rubric axes on courseNarratives.
// Core = essential knowledge/skills · Connections = interdisciplinary
// transfer + systems thinking · Practice = thinking/working like a
// practitioner · Identity = self-awareness, interests, the field's meaning.
// Mirrors the four `lessons.strand` values on purpose. See
// review/assessment-and-goals-plan.html §4.
const pcmDimensionValidator = v.union(
  v.literal("core"),
  v.literal("connections"),
  v.literal("practice"),
  v.literal("identity"),
);

export default defineSchema({
  // Spread @convex-dev/auth internal tables (authAccounts, authSessions, etc.)
  ...authTables,

  // ── INSTITUTIONS (the school a scholar belongs to) ────────────────────
  // A heavyweight, EXCLUSIVE grouping — unlike scholarGroups (many,
  // teacher-made, soft affinity) a scholar belongs to exactly ONE
  // institution (users.institutionId). It separates scholars from
  // outside testers ("Guests") so most staff views can
  // default to the home school and hide guests. Seeded with two rows by
  // `institutions.ensureDefaults`: the primary school and
  // "Guests". `kind` drives default behavior (school = shown by default;
  // guest = hidden unless asked for); `isPrimary` marks the one home
  // school the roster defaults to. Future: real partner schools as more
  // `kind: "school"` rows. See review/institutions-roster-plan.md.


  institutions: defineTable({
    name: v.string(),
    // URL/identifier-safe stable key, e.g. "primary" | "guests". The
    // seed + filters reference institutions by slug so code never depends
    // on a generated id.
    slug: v.string(),
    kind: v.union(
      v.literal("school"),
      v.literal("guest"),
      v.literal("community"),
    ),
    // Exactly one institution should set this — the home school the roster
    // defaults to. Absent/false = not the default scope.
    isPrimary: v.optional(v.boolean()),
    // The school's identity mark. `logoStorageId` (an uploaded image blob) is
    // the preferred mark; `emoji` is the FALLBACK shown only when no logo is
    // set. The single render component `components/InstitutionMark.tsx` owns the
    // logo → emoji → initial chain, so "emoji is only ever a fallback" holds at
    // every call site instead of per-surface. Both optional: an institution
    // with neither renders its name's initial.
    emoji: v.optional(v.string()),
    logoStorageId: v.optional(v.id("_storage")),
    // IANA timezone used for scholar-facing "today" boundaries. Optional for
    // existing rows; readers fall back to Pacific/Honolulu.
    timeZone: v.optional(v.string()),
    // Where this school's Rounds week turns over (`lib/roundsCadence.ts`).
    // `roundsAnchorWeekday` is 0=Sun … 6=Sat, `roundsAnchorMinutes` is 0–1439
    // minutes past institution-local midnight. These fields are the legacy
    // academic fallback when `roundsCadences` has no academic entry; both absent
    // = Monday 00:00, exactly the behaviour older `weekKey`s were written under.
    roundsAnchorWeekday: v.optional(v.number()),
    roundsAnchorMinutes: v.optional(v.number()),
    // Institution-owned Rounds meetings. Readers resolve the requested kind
    // from this list first; academic alone may fall back to the legacy anchor
    // pair above, while a missing SEL entry means SEL Rounds is not configured.
    roundsCadences: v.optional(
      v.array(
        v.object({
          kind: v.union(v.literal("academic"), v.literal("sel")),
          weekday: v.number(),
          minutes: v.number(),
        }),
      ),
    ),
    createdBy: v.optional(v.id("users")),
    // ── TEMPORARY SUSPENSION (disable/enable) ─────────────────────────────
    // A reversible "paused" state — distinct from cascade-delete: NOTHING is
    // destroyed and re-enabling fully restores access. Framed for billing (a
    // school that stops paying is suspended, not deleted). The TIMESTAMP is the
    // single source of truth: `disabledAt` present == suspended, absent ==
    // active (no separate boolean that could drift). `disabledBy` records the
    // platform admin who paused it; `disabledReason` is an optional short note.
    // The PRIMARY institution can never be suspended (server-refused, like
    // delete) — pausing it would take the whole school offline. Enforcement of
    // what "suspended" means lives at the auth chokepoint (convex/lib/access.ts
    // → assertInstitutionActive, called by requireUser); the lifecycle
    // mutations are in convex/institutionLifecycle.ts.
    disabledAt: v.optional(v.number()),
    disabledBy: v.optional(v.id("users")),
    disabledReason: v.optional(v.string()),
  }).index("by_slug", ["slug"]),

  // ── MEMBERSHIPS (a user's roles/contexts) ─────────────────────────────
  // The unifying "who you are, in which capacity, at which institution"
  // table. ONE row per context: a user holds many memberships and switches
  // between them. Replaces the single `users.role` field (which is kept
  // denormalized during the migration). Examples: a teacher at two schools
  // has two `(teacher, institution)` rows; a platform admin + parent has
  // `(platform_admin, null)` + `(parent, null)`; a scholar has exactly one
  // `(scholar, school)` row. During the enrollment migration,
  // `users.institutionId` remains a legacy mirror only.
  // The active membership (server-validated to belong to the user) drives
  // both the effective role and the accessible-scholar set
  // (convex/lib/access.ts). `institutionId` is null for platform_admin/parent
  // (platform_admin is global; a parent's scope comes from `guardianships`). See
  // review/institutions-access-plan.md.
  memberships: defineTable({
    userId: v.id("users"),
    role: v.union(
      v.literal(ROLES.SCHOLAR),
      v.literal(ROLES.TEACHER),
      v.literal(ROLES.PLATFORM_ADMIN),
      v.literal(ROLES.SCHOOL_ADMIN),
      v.literal(ROLES.CURRICULUM_DESIGNER),
      v.literal(ROLES.STAFF),
      v.literal(ROLES.PARENT),
      v.literal(ROLES.LIFELONG_LEARNER),
    ),
    institutionId: v.optional(v.id("institutions")),
    createdBy: v.optional(v.id("users")), // audit: who granted it
    // The invite whose redemption created this membership, when it came from
    // the institution invite-code flow (`institutionInvites`). Optional +
    // additive: memberships minted any other way (admin grant, seed, backfill)
    // leave it absent. The audit link from a membership back to the link a
    // partner clicked to create/join their institution.
    inviteId: v.optional(v.id("institutionInvites")),
  })
    .index("by_user", ["userId"])
    .index("by_institution", ["institutionId"])
    .index("by_role", ["role"])
    .index("by_user_role", ["userId", "role"])
    .index("by_institution_role", ["institutionId", "role"]),

  // Migration audit rows for scholar accounts whose legacy institution field
  // was absent. Those accounts are deliberately not guessed into a school.
  scholarEnrollmentMigrationIssues: defineTable({
    scholarId: v.id("users"),
    reason: v.union(
      v.literal("missing_legacy_institution"),
      v.literal("missing_institution_record"),
    ),
    recordedAt: v.number(),
  }).index("by_scholar", ["scholarId"]),
  // ── STAFF CAPABILITY GRANTS ────────────────────────────────────────────
  // Narrow, institution-scoped powers for staff whose primary role intentionally
  // does not imply teacher-wide scholar access. Each row grants exactly one
  // capability either across an institution or for one scholar group; revocation
  // remains in the row for audit rather than deleting authorization history.
  staffCapabilityGrants: defineTable({
    granteeUserId: v.id("users"),
    institutionId: v.id("institutions"),
    capability: v.union(
      v.literal("curriculum:edit"),
      v.literal("school:operations"),
      v.literal("health:manage"),
      v.literal("program:publish"),
      v.literal("captures:review"),
    ),
    scholarGroupId: v.optional(v.id("scholarGroups")),
    grantedBy: v.id("users"),
    grantedAt: v.number(),
    revokedBy: v.optional(v.id("users")),
    revokedAt: v.optional(v.number()),
  })
    .index("by_grantee_capability", ["granteeUserId", "capability"])
    .index("by_institution_capability", ["institutionId", "capability"])
    .index("by_group_capability", ["scholarGroupId", "capability"]),

  // ── INSTITUTION INVITES (multi-tenant onboarding) ─────────────────────
  // Unguessable invite codes a platform admin (create-kind) or a school admin
  // (join-kind) mints to onboard an outside partner or a new member. This is
  // the DB-backed replacement for the removed deployment-global env signup
  // codes (which only ever mapped a role into the PRIMARY institution).
  // Public signup is CLOSED unconditionally: the ONLY way to create an account
  // is to redeem a valid invite (users.registerWithCode). The very first
  // platform admin is created out-of-band via the admin-key-gated CLI mutation
  // `users.bootstrapFirstPlatformAdmin` (refuses once any admin exists).
  //
  //   kind: "create_institution" → the redeemer names + creates their OWN new
  //     institution and becomes its school_admin (never platform_admin). No
  //     institutionId (it doesn't exist yet); no role (always school_admin).
  //   kind: "join_institution"   → the redeemer joins an EXISTING institution
  //     with `role` (school_admin | teacher | scholar). `institutionId` is the
  //     school they land in.
  //
  // A code is redeemable while: not revoked (`revokedAt` unset), not expired
  // (`expiresAt` unset or in the future), and under its use cap (`maxUses`
  // unset or `usedCount < maxUses`). Redemption runs inside
  // `users.registerWithCode` (the single signup entry point) and stamps
  // `memberships.inviteId`. A create-kind redemption also records its singular
  // created-school outcome on the invite; reusable join invites keep their
  // per-user provenance on memberships instead of duplicating a redemption log.
  // See review/institution-scoping-audit.html.
  institutionInvites: defineTable({
    // Unguessable random token (the bearer credential in the /join?code= link).
    code: v.string(),
    kind: v.union(
      v.literal("create_institution"),
      v.literal("join_institution"),
    ),
    // Required for join_institution (the target school); absent for
    // create_institution (the institution is created at redemption time).
    institutionId: v.optional(v.id("institutions")),
    // The role a join_institution redeemer receives. Absent for
    // create_institution (always school_admin). Only a platform admin may mint
    // a join invite whose role is school_admin.
    role: v.optional(
      v.union(
        v.literal(ROLES.SCHOOL_ADMIN),
        v.literal(ROLES.TEACHER),
        v.literal(ROLES.SCHOLAR),
      ),
    ),
    createdBy: v.id("users"),
    createdAt: v.number(),
    expiresAt: v.optional(v.number()), // absent = never expires
    maxUses: v.optional(v.number()), // absent = unlimited
    usedCount: v.number(),
    // Outcome of a create_institution redemption. Optional + additive so
    // pre-existing invites remain valid; join_institution invites leave these
    // unset because memberships.inviteId is their per-redemption provenance.
    createdInstitutionId: v.optional(v.id("institutions")),
    redeemedBy: v.optional(v.id("users")),
    redeemedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()), // set = permanently dead
    // Free-text operator note, e.g. "James Wong — Prism Academy".
    label: v.optional(v.string()),
  })
    .index("by_code", ["code"])
    .index("by_institution", ["institutionId"]),

  // Override the users table to include both auth fields and our custom fields
  users: defineTable({
    // Auth fields (from @convex-dev/auth)
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    image: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    // Our custom fields
    username: v.optional(v.string()),
    externalId: v.optional(v.string()),
    // Stable identifier supplied by a trusted enrollment source. It is scoped by
    // `institutionId`; never use a display name or date of birth as an import key.
    enrollmentExternalKey: v.optional(v.string()),
    role: v.optional(
      v.union(
        v.literal(ROLES.SCHOLAR),
        v.literal(ROLES.TEACHER),
        v.literal(ROLES.PLATFORM_ADMIN),
        v.literal(ROLES.SCHOOL_ADMIN),
        v.literal(ROLES.CURRICULUM_DESIGNER),
        v.literal(ROLES.STAFF),
        v.literal(ROLES.PARENT),
        v.literal(ROLES.LIFELONG_LEARNER)
      )
    ),
    // The school this scholar belongs to (see the `institutions` table).
    // Scholars only — staff stay global (no institution) for now. Optional
    // so existing rows are valid before the backfill stamps everyone; the
    // backfill sets every scholar to the primary school and
    // flips known outside testers to "Guests". Most staff roster views
    // default to the primary institution, hiding guests.
    institutionId: v.optional(v.id("institutions")),
    // Program guests participate in Extended Education offerings without
    // inheriting full-school operations. Absent preserves the legacy meaning:
    // a fully enrolled scholar.
    enrollmentStanding: v.optional(
      v.union(v.literal("enrolled"), v.literal("program_guest")),
    ),
    // Postal address (freeform, single string). Mainly a PARENT contact field
    // — Rabbithole is the school's system of record for parent contact info
    // (email/phone/address). Staff-only PII: a parent must NEVER see another
    // parent's address (custody/safety), so parent-facing queries must never
    // return it. See convex/parents.ts + review/parent-role-plan.md.
    address: v.optional(v.string()),
    // Structured guardian contact fields used by the operations staff CSV export.
    // `name` and `address` remain synchronized display strings for legacy
    // readers; staff entry now writes these normalized columns.
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    streetAddress: v.optional(v.string()),
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    zip: v.optional(v.string()),
    readingLevel: v.optional(v.string()),
    // WRITING-DERIVED grade estimate pending teacher review. Every input is the
    // scholar's own production (typed tutor chat + OCR'd handwritten work); nothing
    // observes what they can READ. Not a Lexile measure, not a normed assessment,
    // not a screener. Present only while it DISAGREES with `readingLevel` —
    // agreement clears it, so a shown disagreement is always current evidence.
    readingLevelSuggestion: v.optional(v.string()),
    /** When `readingLevelSuggestion` was computed. Without it the age is unknowable. */
    readingLevelSuggestionAt: v.optional(v.number()),
    dateOfBirth: v.optional(v.string()), // ISO date string, e.g. "2018-03-15"
    // Scholar's CHRONOLOGICAL grade ("K","1"…"8"). The reference notch on the
    // Acceleration view — what the calendar says, against which we celebrate how
    // far ABOVE grade level a gifted scholar reaches (never a ceiling). Optional;
    // absent = no notch drawn. See convex/acceleration.ts.
    gradeLevel: v.optional(v.string()),
    // The outside school named during Extended Education onboarding. Optional:
    // full-time scholars and existing rows do not have an external school.
    externalSchoolName: v.optional(v.string()),
    profileSetupComplete: v.optional(v.boolean()),
    ttsEnabled: v.optional(v.boolean()), // Text-to-speech (undefined = enabled)
    sttEnabled: v.optional(v.boolean()), // Speech-to-text / voice dictation (undefined = enabled)
    mustResetPassword: v.optional(v.boolean()), // Force password reset on next login
    // Short-lived, single-use permission to bind a PASSWORD to this row through
    // the auth callback. A scholar username is public (roster, one-pagers), so
    // without this anyone who knew one could claim the account via
    // `flow: "signUp"` — see lib/authGuards.assertScholarAdoptionAuthorized.
    // Stamped only by paths that have already proven authorization (redeeming a
    // one-time enroll link, or an authenticated self-serve password change) and
    // cleared the moment it is used. A stale value is harmless: it is a
    // timestamp, and an expired one authorizes nothing.
    passwordBindAllowedUntil: v.optional(v.number()),
    // A staff account created by redeeming an institution invite
    // (`institutionInvites`) that has NOT yet completed passwordless
    // enrollment (its passkey). Until enrollment completes the account has no
    // credential, so the auth callback must REFUSE to bootstrap a password
    // onto it — otherwise an abandoned invite leaves a school_admin row anyone
    // who guesses the username could claim. Cleared ONLY when a passkey is
    // enrolled (passkeys.insertCredential — the ceremony requires the one-time
    // enroll link). Deliberately NOT cleared by magic-link, whose callback runs
    // at unauthenticated link-REQUEST time (see resolveMagicLinkUser); a
    // magic-link-only staffer simply stays pending, which is harmless because
    // the flag blocks only password-binding. Absent = a normal account.
    pendingEnrollment: v.optional(v.boolean()),
    // Non-human SERVICE account (e.g. "rabbithole-guide", which owns the
    // onboarding unit + every onboarding assignment). Never sign-in-able:
    // the password path refuses to bootstrap credentials onto it (see
    // convex/auth.ts createOrUpdateUser), so a hard-coded, passwordless,
    // never-passkey'd account can't be claimed. Absent = a normal account.
    isSystem: v.optional(v.boolean()),
    preferredFont: v.optional(v.string()), // "andika" | "opendyslexic" | undefined (system default)
    // Staff-aide model preference — the "vote with your feet" opt-in.
    // Absent = fleet default (Fable 5, or the AIDE_MODEL env override);
    // "sonnet" / "opus" / "fable" pin that staff member's aide surfaces
    // (Chat tab, unit-designer bot, Slack bot) to Sonnet 5 / Opus 4.8 /
    // Fable 5. Staff-only (users.setAideModel gates on isStaffRole); never
    // affects the scholar tutor or parent chat. See convex/lib/aideModel.ts.
    aideModel: v.optional(
      v.union(v.literal("sonnet"), v.literal("opus"), v.literal("fable")),
    ),
    // Slack workspace member id (e.g. "U07ABCDE") — the identity bridge for
    // the Rabbithole Slack bot. Per-user mapping set by an admin (manual or
    // auto-link by verified Slack email); the bot FAILS CLOSED for Slack
    // users with no mapping. See review/slack-bot-plan.md.
    slackUserId: v.optional(v.string()),
    // A scholar's PUBLIC-LIBRARY account — e.g. their Hawai'i State Public
    // Library System card # + PIN. OPTIONAL and scholar-level (NOT per-app) so
    // ONE library card auto-signs-in EVERY library-backed External App
    // (PressReader today; more later) instead of re-storing it per app — an app
    // opts in with `externalApps.credentialSource: "libraryCard"`. Same
    // dev-grade at-rest trust model as scholarApps.loginPassword: the PIN is
    // returned ONLY to the owner for embedded auto-login. Authorized staff may
    // manage the card number and replace the PIN, but never read the saved PIN;
    // linked guardians receive only a masked card status and replace both
    // fields explicitly. This is NOT sensitive-prod safe without encryption.
    libraryCredential: v.optional(
      v.object({ id: v.string(), password: v.string() }),
    ),
    // Monotonic credential metadata kept even after removal, preventing a stale
    // guardian tab from overwriting a remove→re-add cycle. Legacy rows with a
    // credential and no revision are revision 1; rows with neither are 0.
    libraryCredentialRevision: v.optional(v.number()),
  })
    .index("by_institution_enrollment_external_key", [
      "institutionId",
      "enrollmentExternalKey",
    ])
    .index("by_email", ["email"])
    .index("by_username", ["username"])
    .index("by_externalId", ["externalId"])
    .index("by_role", ["role"])
    .index("by_institution", ["institutionId"])
    .index("by_institution_role", ["institutionId", "role"])
    .index("by_slackUserId", ["slackUserId"]),

  // ── AUTH (passkeys / WebAuthn) ────────────────────────────────────────
  // Staff (teacher/admin/curriculum_designer) sign in passwordless with a
  // passkey. These three tables implement WebAuthn on top of
  // @convex-dev/auth, which has no native passkey provider. See
  // .claude/rules/rabbithole-passkeys.md for the full design.

  // A registered WebAuthn credential (one row per device a user enrolled).
  // The passkey *replaces* the password for staff: at sign-in we look the
  // credential up by `credentialId` and return its `userId` to mint the
  // Convex Auth session (see convex/auth.ts authorize). `publicKey` is the
  // COSE key stored base64url; `counter` is the signature counter we bump
  // on every auth to detect cloned authenticators.
  passkeys: defineTable({
    userId: v.id("users"),
    credentialId: v.string(), // base64url credential ID (lookup key)
    publicKey: v.string(), // base64url-encoded COSE public key
    counter: v.number(), // signature counter (anti-clone)
    transports: v.optional(v.array(v.string())), // ["internal","hybrid",...]
    deviceType: v.optional(v.string()), // "singleDevice" | "multiDevice"
    backedUp: v.optional(v.boolean()),
    label: v.optional(v.string()), // human label, e.g. "MacBook Touch ID"
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_credentialId", ["credentialId"]),

  // Short-lived server-generated challenges. A WebAuthn ceremony is two
  // round trips (generate options -> browser signs -> verify); the
  // challenge created in step 1 must be remembered to verify in step 3.
  // We return the row `_id` as an opaque `challengeId` to the client and
  // consume (delete) the row on verify so it can't be replayed. `userId`
  // is set for registration of a known/authenticated user; null for the
  // anonymous authentication (sign-in) ceremony.
  webauthnChallenges: defineTable({
    challenge: v.string(), // base64url
    type: v.union(v.literal("registration"), v.literal("authentication")),
    userId: v.optional(v.id("users")),
    expiresAt: v.number(),
  }).index("by_user", ["userId"]),

  // One-time bootstrap tokens for enrolling a staffer's FIRST passkey.
  // Passwordless staff can't password-login to register their first
  // credential, so an admin (or CLI) issues a token; the staffer opens
  // /enroll?token=... and registers. We store only a sha256 hash of the
  // raw token. Single-use (`usedAt`) and time-boxed (`expiresAt`).
  enrollmentTokens: defineTable({
    userId: v.id("users"),
    tokenHash: v.string(), // sha256 hex of the raw token
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
    issuedBy: v.optional(v.id("users")), // admin who issued (null = CLI)
  })
    .index("by_user", ["userId"])
    .index("by_tokenHash", ["tokenHash"]),

  // One-shot embed-session handoff tokens — the PROD auth bridge that lets the
  // native app hand a scholar's identity to the web `/embed/manipulative`
  // route it loads inside a session-less react-native-webview (the WebView
  // carries no Convex Auth cookie). The already-authenticated native app mints
  // a token for ITS OWN identity (embedAuth.issueEmbedToken), passes it in the
  // URL fragment, and the embed page redeems it via the `embedToken` auth
  // provider. See convex/embedAuth.ts + review/native-manipulative-plan.
  //
  // Why its own table rather than reusing enrollmentTokens: different
  // lifecycle + trust model — these are FAR shorter-lived (≤120s vs 7 days),
  // are minted by the *scholar themselves* (not an admin), and mint a session
  // rather than enrolling a credential. Keeping them separate keeps each
  // table's single-use/TTL invariants obvious. As with enrollment tokens we
  // store ONLY a sha256 hash of the raw token (never the raw value);
  // single-use (`usedAt`) and time-boxed (`expiresAt` = createdAt + ≤120s).
  embedSessionTokens: defineTable({
    userId: v.id("users"),
    tokenHash: v.string(), // sha256 hex of the raw token
    createdAt: v.number(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_tokenHash", ["tokenHash"]),

  // ── iPad device pairing (camera-free sign-in) ─────────────────────────
  // The short-code handshake that signs a locked-down 1:1 iPad into a
  // scholar account WITHOUT a camera (no QR), universal links, or an
  // associated-domains entitlement — the streaming-TV "add this device"
  // model. See convex/devicePairing.ts for the full protocol + threat model.
  //
  // devicePairingRequests is the EPHEMERAL half. A signed-out device
  // generates a high-entropy VERIFIER locally, hashes it, and registers a
  // request carrying only that hash + a stable deviceId; it gets back an
  // opaque requestId and a SHORT human-typable code it displays. A staffer
  // enters that code in the web console, picks a scholar, and approves. The
  // device then exchanges (requestId + the raw verifier) for a real session.
  //
  // Security invariants (enforced in devicePairing.ts):
  //   - The raw verifier is NEVER stored, logged, or displayed — only its
  //     sha256 hash lives here, so a photographed code alone is useless.
  //   - The code is a LOOKUP KEY, not a credential: approval grants the
  //     DEVICE (whoever holds the verifier), never the person typing the code.
  //   - `expiresAt` (~5 min) kills a stale pending request; approval opens a
  //     short single-use exchange window (`approvalExpiresAt`, ~60s).
  //   - `exchangedAt` is the atomic single-use burn — a second exchange fails.
  devicePairingRequests: defineTable({
    // Short, human-typable, ambiguity-free code (stored uppercase, no
    // separators). A lookup key only; possession without the verifier is inert.
    code: v.string(),
    // sha256 hex of the device's secret verifier. The raw verifier is sent
    // ONLY at exchange (over TLS) and hashed here to compare — never persisted.
    verifierHash: v.string(),
    // A stable per-iPad id the device persists across re-pairings (the durable
    // binding key). Untrusted (client-chosen) — it's a label for the binding,
    // not an authenticator; the session identity is always the approved scholar.
    deviceId: v.string(),
    deviceLabel: v.optional(v.string()), // e.g. "iPad (9th gen)" — display only
    status: v.union(
      v.literal("pending"), // registered, awaiting a staffer's approval
      v.literal("approved"), // staffer approved; exchange window open
      v.literal("exchanged"), // burnt — a session was minted (terminal)
    ),
    createdAt: v.number(),
    expiresAt: v.number(), // createdAt + ~5 min; a pending request past this is dead
    // Set on approval (institution-scoped — the scholar's institution):
    scholarId: v.optional(v.id("users")),
    institutionId: v.optional(v.id("institutions")),
    approvedBy: v.optional(v.id("users")), // the staffer (audit)
    approvedAt: v.optional(v.number()),
    approvalExpiresAt: v.optional(v.number()), // approvedAt + ~60s single-use window
    exchangedAt: v.optional(v.number()), // single-use burn stamp
  })
    .index("by_code", ["code"])
    .index("by_status", ["status"])
    .index("by_device", ["deviceId"]),

  // pairedDevices is the DURABLE half: which scholar an iPad is currently
  // bound to. Devices get reassigned between scholars/years, so the binding is
  // durable but REVERSIBLE (unpair / re-pair just rewrite this row, keyed on
  // institutionId+deviceId). `authSessionId` tracks the device's current
  // session so a lost iPad can be signed out remotely (revokeDeviceSession)
  // WITHOUT touching the scholar's other sessions — the just-authenticated
  // device records itself here (attachDeviceSession, keyed on its own
  // getAuthSessionId — unspoofable), the same sidecar trick as mcpSessions.
  pairedDevices: defineTable({
    institutionId: v.id("institutions"),
    deviceId: v.string(),
    scholarId: v.id("users"),
    deviceLabel: v.optional(v.string()),
    pairedAt: v.number(),
    pairedBy: v.id("users"), // the staffer who approved the current binding
    lastRequestId: v.optional(v.id("devicePairingRequests")),
    // Managed-claim exchanges stamp their serial-keyed owner here. Manual
    // pairing clears it, so a changed install identity can retire only the
    // obsolete managed binding without touching legitimate manual pairings.
    managedDeviceClaimId: v.optional(v.id("managedDeviceClaims")),
    // The device's current tracked auth session (for remote sign-out). Set by
    // attachDeviceSession after exchange; cleared when the session is revoked.
    authSessionId: v.optional(v.id("authSessions")),
    // Rabbithole Lock is the product name for the app's Autonomous Single App
    // Mode control. Absent desired state means ARMED so pre-existing fleet rows
    // stay locked without a migration. A disarm may last for one app entry,
    // until the institution's next midnight, for a fixed number of minutes
    // staff choose ("timed"), or until staff explicitly re-arm.
    rabbitholeLockDesiredState: v.optional(
      v.union(v.literal("armed"), v.literal("disarmed")),
    ),
    rabbitholeLockDisarmMode: v.optional(
      v.union(
        v.literal("one_time"),
        v.literal("until_midnight"),
        v.literal("until_further_notice"),
        v.literal("timed"),
      ),
    ),
    // Shared by "until_midnight" (the institution's next midnight) and "timed"
    // (now + the staff-chosen minutes) — the single instant a scheduled re-arm
    // job compares against, so both modes reuse one field instead of two.
    rabbitholeLockDisarmExpiresAt: v.optional(v.number()),
    rabbitholeLockUpdatedAt: v.optional(v.number()),
    rabbitholeLockUpdatedBy: v.optional(v.id("users")),
    // The native app acknowledges the exact desired-state revision it applied
    // and reports iOS truth separately. Staff UI must never equate "requested"
    // with "currently in Single App Mode".
    rabbitholeLockAppliedDesiredState: v.optional(
      v.union(v.literal("armed"), v.literal("disarmed")),
    ),
    rabbitholeLockAppliedAt: v.optional(v.number()),
    rabbitholeLockInSingleAppMode: v.optional(v.boolean()),
    // A temporary, staff-authorized Robotics capture surface for this already
    // assigned managed iPad. All fields are optional so existing bindings stay
    // valid; the server treats an expired command as inactive even before its
    // revision-checked scheduled cleanup runs.
    assignedDeviceCaptureStationId: v.optional(v.id("captureStations")),
    assignedDeviceCaptureExpiresAt: v.optional(v.number()),
    assignedDeviceCaptureUpdatedAt: v.optional(v.number()),
    assignedDeviceCaptureUpdatedBy: v.optional(v.id("users")),
    // Deprecated: the assigned-device capture issuance-quota window. No longer
    // written (the quota was dropped in favor of delete-if-empty supersession),
    // but kept as optional so a prod deploy never rejects a pre-existing binding
    // that still carries these fields. A follow-up migration clears + narrows
    // them (widen → migrate → narrow); do not re-use these names.
    assignedDeviceCaptureSessionWindowStartedAt: v.optional(v.number()),
    assignedDeviceCaptureSessionsIssuedInWindow: v.optional(v.number()),
  })
    .index("by_institution", ["institutionId"])
    .index("by_device", ["institutionId", "deviceId"])
    // deviceId alone — the console shows "this iPad is currently paired to X"
    // when a re-pair request comes in, before the institution is known.
    .index("by_device_id", ["deviceId"])
    .index("by_scholar", ["scholarId"]),

  // A paired scholar can ask to sign out from the native iPad, but a durable
  // MDM claim would immediately sign it back in. The request is posted to the
  // institution's existing alerts channel; a linked staff member explicitly
  // approves in that Slack thread, then the iPad completes an authoritative
  // unpair that invalidates the claim before clearing local auth.
  deviceSignOutRequests: defineTable({
    institutionId: v.id("institutions"),
    scholarId: v.id("users"),
    pairedDeviceId: v.id("pairedDevices"),
    deviceId: v.string(),
    deviceLabel: v.optional(v.string()),
    managedDeviceClaimId: v.optional(v.id("managedDeviceClaims")),
    managedSerial: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("completed"),
      v.literal("expired"),
    ),
    requestedAt: v.number(),
    expiresAt: v.number(),
    alertId: v.id("alerts"),
    slackChannelId: v.string(),
    slackThreadTs: v.optional(v.string()),
    slackPostedAt: v.optional(v.number()),
    slackPostError: v.optional(v.string()),
    approvedBy: v.optional(v.id("users")),
    approvedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
  })
    .index("by_device", ["deviceId", "requestedAt"])
    .index("by_channel_thread", ["slackChannelId", "slackThreadTs"])
    .index("by_status", ["status"]),

  // ── MANAGED-CLAIM device roster (zero-touch iPad provisioning) ─────────
  // The serial-keyed sibling of `pairedDevices`, for the ADE→SimpleMDM managed
  // fleet where NOBODY types anything on the device. iOS forbids an app from
  // reading its own serial/UDID, so the device's identity arrives via MDM
  // MANAGED APP CONFIGURATION (the `com.apple.configuration.managed`
  // dictionary SimpleMDM sets PER DEVICE). Rabbithole mints a per-device CLAIM
  // token bound to (scholar, institution, serial); SimpleMDM delivers it in the
  // AppConfig payload; the app reads it on first launch and exchanges it for a
  // real Convex Auth session — the same session-minting path as pairing
  // (auth.ts `deviceClaim` provider → managedDeviceClaims.consumeManagedClaim).
  // See convex/managedDeviceClaims.ts for the full protocol + threat model.
  //
  // This row is BOTH the roster (loadable before scholar assignments are known,
  // keyed by Apple School Manager serials) AND the durable claim. The
  // `unassigned` rung intentionally has neither scholar nor token; assignment
  // mints the first claim. Serials are globally unique (Apple), so `serial` is
  // the natural key.
  //
  // Single-use vs DURABLE (the deliberate choice — see managedDeviceClaims.ts):
  // the claim is DURABLE/reusable, NOT burned on first exchange. The device is
  // meant to STAY signed in, and the claim lives in per-device MDM config that
  // survives an app reinstall or a wipe-and-re-enroll (SimpleMDM re-pushes it) —
  // so a reusable claim is what keeps provisioning zero-touch across the
  // device's whole life. Its confidentiality rests on the supervised device +
  // per-serial config; we mitigate the durable-secret risk by (a) hashing the
  // token at rest (raw value exposed ONCE, at mint), and (b) supporting
  // explicit per-device rotation + revocation.
  //
  // Security invariants (enforced in managedDeviceClaims.ts):
  //   - The raw claim token is NEVER stored — only its sha256 hash lives here.
  //   - Every mint/assign is INSTITUTION-SCOPED (requireScholarsAccessible) —
  //     staff can never assign a device to another school's scholar.
  //   - Rotation issues a fresh token and invalidates the prior one (the old
  //     hash is overwritten), so a leaked token is killable without deleting
  //     the roster row. Revocation invalidates the token with no replacement.
  //   - Every exchange is audited (managed-claim.exchange) with serial +
  //     scholar + the consuming device id.
  managedDeviceClaims: defineTable({
    institutionId: v.id("institutions"),
    // Apple hardware serial, stored UPPERCASE/trimmed. The durable key —
    // stable across app reinstalls and identifierForVendor resets.
    serial: v.string(),
    // Deprecated: Rabbithole no longer reads or writes its own device name.
    // Kept optional until legacy production values are cleared before narrowing.
    label: v.optional(v.string()),
    scholarId: v.optional(v.id("users")), // absent while the roster row is unassigned
    // sha256 hex of the CURRENT claim token. The raw token is returned once at
    // mint/rotation (or pushed to SimpleMDM) and hashed here to compare at
    // exchange — never persisted in the clear.
    claimTokenHash: v.optional(v.string()),
    // A remotely pushed replacement remains pending until the iPad exchanges
    // it. Keeping the current hash valid during delivery makes recovery
    // fail-safe when SimpleMDM or the device is temporarily offline.
    pendingClaimTokenHash: v.optional(v.string()),
    pendingClaimIssuedAt: v.optional(v.number()),
    pendingRotationCount: v.optional(v.number()),
    pendingSimplemdmPushedAt: v.optional(v.number()),
    claimState: v.union(
      v.literal("unassigned"), // serial registered, no scholar or claim yet
      v.literal("unclaimed"), // token minted, never exchanged yet
      v.literal("claimed"), // token exchanged at least once (device active)
      v.literal("revoked"), // token invalidated, no replacement — must rotate to re-issue
    ),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
    // The current claim reached SimpleMDM at this time. Cleared whenever the
    // claim rotates or the device is unassigned/revoked.
    simplemdmPushedAt: v.optional(v.number()),
    // Issuance/rotation of the CURRENT token:
    claimIssuedAt: v.number(),
    rotationCount: v.number(),
    // Consumption of the CURRENT token (reset on rotation):
    firstClaimedAt: v.optional(v.number()),
    lastClaimedAt: v.optional(v.number()),
    claimCount: v.number(),
    // identifierForVendor of the last device that exchanged (links this
    // serial-keyed row to its ephemeral `pairedDevices` binding).
    lastDeviceId: v.optional(v.string()),
    // Reversible roster-only hold. The device remains visible and manually
    // assignable, but bulk auto-assignment skips it until staff include it again.
    autoAssignExcluded: v.optional(v.boolean()),
    revokedAt: v.optional(v.number()),
    revokedBy: v.optional(v.id("users")),
    // Bumped on every boundary change to this claim's identity: scholarId
    // change (assign/reassign/unassign), a same-scholar credential rotation
    // (rotateManagedDeviceClaim — the "token may have leaked" button), or an
    // institution change. The active-unlock reconciler stamps the generation
    // it observed onto a deviceAppUnlockStates row at unlock time; a
    // mismatch at recheck means the claim's identity moved since that unlock
    // was granted, so a stale reconcile task can never mistake a fresh
    // owner/token's valid unlock for the departed one's stale one. Absent
    // === 0 for pre-existing rows (no migration needed; this field has never
    // shipped to prod).
    claimGeneration: v.optional(v.number()),
  })
    .index("by_serial", ["serial"])
    .index("by_institution", ["institutionId"])
    .index("by_claim_hash", ["claimTokenHash"])
    .index("by_pending_claim_hash", ["pendingClaimTokenHash"])
    // Additive lookup for authenticated native-client heartbeats. The client
    // never declares itself managed; the server resolves this relationship.
    .index("by_last_device_id", ["lastDeviceId"])
    .index("by_scholar", ["scholarId"]),

  // A dedicated, already-installed SimpleMDM custom profile for one managed
  // iPad. This is deliberately separate from `managedDeviceClaims`: claims are
  // about zero-touch sign-in, while this binding grants a profile mutation only
  // for a profile that an operator has explicitly dedicated to one serial.
  //
  // `baselineBundleIds` is the complete locked allowlist from that dedicated
  // profile. It is never inferred from a group/fleet profile; temporary app
  // access only appends one server-owned app key to this exact per-device set.
  deviceAppUnlockBindings: defineTable({
    institutionId: v.id("institutions"),
    managedDeviceClaimId: v.id("managedDeviceClaims"),
    serial: v.string(),
    simpleMdmProfileId: v.string(),
    // The profile body fetched from SimpleMDM at configuration time. Updating
    // its one allowlist preserves every device-specific baseline payload.
    baselineProfileXml: v.string(),
    baselineBundleIds: v.array(v.string()),
    profilePayloadIdentifier: v.string(),
    profilePayloadUuid: v.string(),
    profileUuid: v.string(),
    configuredAt: v.number(),
    configuredBy: v.id("users"),
  })
    .index("by_managed_device", ["managedDeviceClaimId"])
    .index("by_profile", ["simpleMdmProfileId"])
    .index("by_serial", ["serial"])
    // Every unlock-mediated iPad in one school. A school-wide app push has no
    // per-scholar audience to walk, so the allowlist projector marks that
    // school's bound devices dirty directly rather than enumerating every
    // scholar to reach the same set.
    .index("by_institution", ["institutionId"]),

  // Desired state and SimpleMDM acknowledgement for a temporary native-app
  // release. The server never calls an MDM group endpoint: every row resolves
  // through exactly one `deviceAppUnlockBindings` row above.
  deviceAppUnlockStates: defineTable({
    institutionId: v.id("institutions"),
    managedDeviceClaimId: v.id("managedDeviceClaims"),
    desiredState: v.union(v.literal("locked"), v.literal("unlocked")),
    appKey: v.optional(
      v.union(v.literal("google-sheets"), v.literal("lego-spike")),
    ),
    expiresAt: v.optional(v.number()),
    // `idleSince` turns the normal one-hour expiry into an inactivity lease.
    // Active external work has a separate, deliberately bounded failsafe.
    idleSince: v.optional(v.number()),
    activeSessionFailsafeAt: v.optional(v.number()),
    // Identifies the native handoff that currently owns the active lease. A
    // stale return from an older app launch cannot shorten a newer launch.
    activeLeaseToken: v.optional(v.string()),
    // Pending locks are retried on this indexed schedule so one broken iPad
    // cannot starve later expired leases from the bounded reconciler batch.
    pendingLockRetryAt: v.optional(v.number()),
    updatedAt: v.number(),
    requestedAt: v.number(),
    requestedBy: v.id("users"),
    // One external profile PATCH may be in flight per dedicated profile. A
    // token makes a late action result inert after recovery takes ownership.
    operationToken: v.optional(v.string()),
    operationStartedAt: v.optional(v.number()),
    mdmAcceptedAt: v.optional(v.number()),
    expectedAvailableAt: v.optional(v.number()),
    lockedAt: v.optional(v.number()),
    lastMdmError: v.optional(v.string()),
    // The one authoritative correctness mechanism: every row with
    // desiredState="unlocked" is periodically re-derived from scratch
    // (claim/owner generation, scholar, catalog mapping, audience/archive
    // authorization, expiry) by the bounded active-unlock reconciler once
    // this timestamp elapses. Event-driven "hooks" (a teacher revoke, a
    // claim decommission, …) only ever advance this to "now" to reduce
    // latency — they never decide lock/unlock themselves. Absent is treated
    // as due immediately (pre-existing rows, or a fresh unlock awaiting its
    // first recheck stamp).
    nextRecheckAt: v.optional(v.number()),
    // The managedDeviceClaims.claimGeneration observed at unlock-grant time
    // (or at the last successful recheck). The reconciler's atomic gate
    // locks immediately on any mismatch against the claim's CURRENT
    // generation, rather than trusting a stale task's authorization verdict
    // for a claim whose identity has since changed.
    claimGeneration: v.optional(v.number()),
    // Durable "finish relocking, THEN delete both this row and my dedicated-
    // profile binding" intent (Finding 3, final gate). Stamped by
    // `removeManagedDevice` BEFORE it deletes the managedDeviceClaims row,
    // whenever the unlock/relock was not already fully settled — deleting
    // the state/binding synchronously in that case would either strand an
    // in-flight baseline PATCH with nothing left to record success/failure
    // against, or (once the reconciler did finish) permanently orphan this
    // row's `deviceAppUnlockBindings.by_profile` pointer against a claim id
    // that can never again match a freshly re-registered claim for the same
    // serial. `recordMdmPatch`'s accepted=true branch checks this flag and,
    // once SimpleMDM has durably accepted the baseline PATCH, deletes both
    // rows instead of merely marking them accepted. Absent/false: ordinary
    // accept path (row survives).
    cleanupAfterLockIntent: v.optional(v.boolean()),

    // ── The PROJECTED allowlist (app-access unification, lanes B/C) ──
    //
    // The scalar `appKey` above is the LEASE model: one app at a time, opened
    // by a launch-time ceremony and handed back. These fields are the SET
    // model that supersedes it — `desiredAllowlist(device) = baseline ∪
    // { bundleId(app) : app granted-or-pushed to this device's scholar right
    // now } ∪ (the live ceremony lease's app, if any)`. The grant is the
    // authority; the MDM allowlist is an eventually-consistent projection of
    // it, converged by the reconciler in convex/deviceAppUnlock.ts.
    //
    // Both models coexist ON PURPOSE until the shipped iPad build stops
    // driving the ceremony (lane D). Composition rule, so the two writers can
    // never fight over one profile: the projected set is always a SUPERSET
    // member of whatever the ceremony wants, so every writer — a ceremony
    // unlock, a ceremony relock, and the projection itself — PATCHes the same
    // computed set. See `projectedBundleIdsForClaim` in
    // convex/lib/deviceAppProjection.ts.
    //
    // The lease fields above stay authoritative for the CEREMONY's own state
    // machine (`status` / `requestUnlock` / `requestLock` / `markReturned`);
    // nothing here is read by that machine, and the projection never writes
    // `desiredState`, `appKey`, `expiresAt`, `mdmAcceptedAt` or
    // `lastMdmError`. That separation is what keeps a projection failure from
    // reading to the live client as a failed unlock.

    // What the projector last COMPUTED for this device (diagnostic; the value
    // actually sent is recomputed inside the same transaction that acquires
    // the operation token, never read back from here).
    desiredBundleIds: v.optional(v.array(v.string())),
    // What SimpleMDM last durably ACCEPTED for this device. This is the diff
    // baseline: `desired !== applied` is the only thing that makes the
    // projector spend a network call. Absent means "never projected" — which
    // is itself drift, so a freshly-bound device converges on the next tick.
    appliedBundleIds: v.optional(v.array(v.string())),
    projectionAppliedAt: v.optional(v.number()),
    // When this device's projection is next due to be re-derived. `0` = dirty
    // now (what the mutation-site hooks stamp); absent = never projected, and
    // sorts as due immediately. Hooks only ever move this EARLIER — the cron
    // remains the one correctness authority, exactly as `nextRecheckAt`
    // already works for the lease model.
    projectionDueAt: v.optional(v.number()),
    // Last projection PATCH failure, kept separate from `lastMdmError` so a
    // background projection failure can never surface to the native client as
    // a failed unlock ceremony (`statusFor` reads `lastMdmError` only).
    projectionError: v.optional(v.string()),

    // ── The VERIFY AUTHORITY: `appliedBundleIds` is a HINT, never truth ──
    //
    // `appliedBundleIds` records what a writer BELIEVES SimpleMDM holds. That
    // belief can be wrong in the one direction that matters: a PATCH whose
    // transport timed out may still land later, so a whole-profile write can
    // arrive AFTER a newer one and silently restore an allowlist that was
    // derived before a revocation. If the stored hint were treated as truth,
    // `desired === applied` would then skip every future PATCH and the
    // resurrected app would stay in the profile forever.
    //
    // So the LIVE profile is the authority. The projector may skip a PATCH on
    // the strength of the stored hint only while that hint is backed by a
    // recent read of the real profile — which the PATCH path already performs
    // (`assertLiveTemplate` downloads it). `projectionVerifiedAt` stamps when
    // `appliedBundleIds` was last proven equal to the live allowlist;
    // `projectionVerifyNeeded` forces the next pass to re-read regardless.
    //
    // Trust is destroyed explicitly wherever a writer cannot prove what
    // landed: a failed or timed-out PATCH, a record arriving under a lost
    // token, a preemption, and a profile rebind.
    projectionVerifiedAt: v.optional(v.number()),
    projectionVerifyNeeded: v.optional(v.boolean()),
    // The TIME FENCE that makes `projectionVerifyNeeded` sound.
    //
    // A flag alone is not enough, because a later SUCCESS can erase it while
    // the uncertainty is still outstanding: a PATCH times out (uncertain), a
    // revocation lands, a second PATCH succeeds and clears the flag with a
    // fresh `projectionVerifiedAt` — and only THEN does the first write reach
    // SimpleMDM and restore the revoked app, now trusted for a full interval.
    // Preemption has the same shape.
    //
    // So an uncertain operation stamps a BARRIER: the latest moment its write
    // could still be applied server-side. `projectionVerifyNeeded` may be
    // cleared ONLY by a live profile read performed AFTER that barrier — never
    // by a write succeeding, and never before it. Concurrent uncertain
    // operations keep the MAXIMUM barrier, so the fence only ever moves later.
    projectionVerifyBarrierAt: v.optional(v.number()),

    // Which writer holds `operationToken`. Absent === "ceremony", so every
    // row written before the projection existed keeps exactly its old
    // meaning.
    //
    // The token is a mutual-exclusion lease on one whole-profile PATCH, and
    // both writers need it — but it is also CLIENT-VISIBLE through
    // `statusFor`, which reports a held token as `mdm-patch-in-flight`. A
    // background projection holding it would therefore make a scholar's cold
    // tap wait, and make `requestUnlock` throw "already in progress", on
    // precisely the teacher-just-granted correlation the projection exists to
    // serve. Discriminating the holder fixes both: a projection-held token is
    // INVISIBLE to `statusFor` (the row's underlying lease state is reported
    // instead) and is PREEMPTIBLE by the ceremony and by the revocation gate.
    // A ceremony-held token keeps today's semantics exactly.
    tokenKind: v.optional(
      v.union(v.literal("ceremony"), v.literal("projection")),
    ),
  })
    .index("by_managed_device", ["managedDeviceClaimId"])
    .index("by_desired_recheck", ["desiredState", "nextRecheckAt"])
    .index("by_pending_lock_retry", [
      "desiredState",
      "mdmAcceptedAt",
      "pendingLockRetryAt",
    ])
    // Rows mid-teardown, reachable REGARDLESS of their lease/acceptance flags.
    // `by_pending_lock_retry` only finds a row that is locked AND unaccepted,
    // so a device whose removal raced an in-flight write could settle into a
    // combination none of the recovery scans matched — stranding the binding
    // with the profile still widened. This index exists so no combination of
    // flags can hide a row that still owes a teardown.
    .index("by_cleanup_intent", ["cleanupAfterLockIntent"]),

  // Enumerable record of every auth session a managed-device pairing has
  // EVER attached — never a single denormalized pointer that a later attach
  // can silently supersede. A device's boot can sign-in more than once
  // (crash/retry loops) before app code confirms an attach; decommissioning
  // the pairing must revoke every session it ever recorded here for the
  // departing scholar, not just the most recent one. Rows are inserted
  // ATOMICALLY at exchange/claim-consumption time (mintAuthSessionForUser in
  // convex/devicePairing.ts, called from the SAME mutation that resolves the
  // device binding) — a session is never left unenumerable by a crash between
  // sign-in and a later best-effort client attach.
  pairedDeviceAuthSessions: defineTable({
    pairedDeviceId: v.id("pairedDevices"),
    authSessionId: v.id("authSessions"),
    scholarId: v.id("users"),
    attachedAt: v.number(),
    revokedAt: v.optional(v.number()),
    // Immutable back-reference for managed-claim sessions ONLY (undefined for
    // manual pairing rows). Set once, at mint time, and never repointed —
    // unlike `pairedDeviceId`/`pairedDevices.managedDeviceClaimId`, which a
    // later manual re-pair can clear or repoint away from the claim. This is
    // what lets a claim rotation/decommission find and revoke its session
    // even after the mutable pairedDevices link has moved on (see
    // revokeManagedClaimSessions in devicePairing.ts).
    managedDeviceClaimId: v.optional(v.id("managedDeviceClaims")),
    claimGeneration: v.optional(v.number()),
  })
    .index("by_paired_device", ["pairedDeviceId"])
    .index("by_session", ["authSessionId"])
    .index("by_claim_generation", ["managedDeviceClaimId", "claimGeneration"]),

  // ── Native client heartbeats ────────────────────────────────────────────
  // One current build/liveness record per authenticated user + stable native
  // installation id. The tenant and managed-device classification are derived
  // on the server from the authenticated user and managed-claim binding.
  nativeClientHeartbeats: defineTable({
    userId: v.id("users"),
    institutionId: v.optional(v.id("institutions")),
    deviceId: v.string(),
    channel: v.union(v.literal("stable"), v.literal("canary")),
    appVersion: v.string(),
    buildNumber: v.string(),
    gitSha: v.string(),
    managedDeviceId: v.optional(v.id("managedDeviceClaims")),
    lastSeenAt: v.number(),
  })
    .index("by_user_device", ["userId", "deviceId"])
    .index("by_institution_last_seen", ["institutionId", "lastSeenAt"])
    .index("by_managed_device", ["managedDeviceId"]),

// A scholar's pass through an activity. The locked nomenclature calls
  // this a *session* (see review/curriculum-rehearse-and-maturity.md). The
  // canonical PHYSICAL table is `sessions` (renamed from `projects`; see
  // review/project-to-session-rename-plan.md), and the app/API concept is
  // "session" (`api.sessions`, `convex/sessions.ts`). The deprecated
  // `projects` source table + its backfill migration were dropped in the
  // post-soak follow-up. The child-FK *field* has also been renamed
  // `projectId` → `sessionId` (staged widen→switch→narrow rollout); the only
  // `project` terms left are the `/project-stream` route and the
  // `attemptContext: "project"` enum value (each its own contract-coupled
  // follow-up).
  sessions: defineTable(sessionTableFields)
    .index("by_user", ["userId"])
    .index("by_institution", ["institutionId"])
    .index("by_user_last_message", ["userId", "lastMessageAt"])
    .index("by_user_and_archived", ["userId", "isArchived"])
    .index("by_unit", ["unitId"])
    .index("by_lesson", ["lessonId"])
    // Resolve a scholar's re-openable session for a completed unit
    // (sessions.reopenableForUnit) without scanning all of their sessions.
    .index("by_user_unit", ["userId", "unitId"])
    .index("by_assignment", ["assignmentId"])
    // The Debrief's Key Moments roll up real sessions for one activity.
    .index("by_activity", ["activityId"]),

  messages: defineTable({
    sessionId: v.id("sessions"),
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("system"),
      v.literal("tool")
    ),
    content: v.string(),
    // A rubric award is a durable transcript event, not assistant prose. The
    // criterion snapshot keeps its historical title stable if the rubric changes.
    flairAwards: v.optional(
      v.array(
        v.object({
          criterionId: v.string(),
          label: v.string(),
          // Retained for compatibility with award rows created during rollout.
          description: v.optional(v.string()),
        }),
      ),
    ),
    // How this user turn entered the composer. Optional preserves historical
    // rows and messages sent by older native clients during rollout.
    inputModality: v.optional(inputModalityValidator),
    // Notebook entries share the session spine without pretending that an
    // engine-authored run marker is scholar speech. Consumers must project this
    // typed arm explicitly rather than treating `content` as transcript prose.
    notebookEntry: v.optional(
      v.union(
        v.object({
          kind: v.literal("hypothesis"),
          runId: v.id("simulatorRuns"),
          prediction: hypothesisValidator,
        }),
        v.object({
          kind: v.literal("run_marker"),
          runId: v.id("simulatorRuns"),
          deckVersion: v.number(),
          outcomeMetrics: v.array(metricValueValidator),
        }),
        v.object({
          kind: v.literal("conclusion"),
          runIds: v.array(v.id("simulatorRuns")),
          text: v.string(),
        }),
        v.object({
          kind: v.literal("note"),
          text: v.string(),
        }),
      ),
    ),
    toolAction: v.optional(v.string()),
    // Snapshot of active dimensions when this message was sent
    // These are strings (not v.id) because they're historical references
    // that should survive if the original entity is deleted
    personaId: v.optional(v.string()),
    unitId: v.optional(v.string()),
    perspectiveId: v.optional(v.string()),
    processId: v.optional(v.string()),
    model: v.optional(v.string()),
    tokensUsed: v.optional(v.number()),
    // Deterministic hash of the tutor system-prompt configuration + active
    // prompt gates at response time. The timestamp joined to GitHub deployment
    // history remains the full code-revision provenance.
    promptVersion: v.optional(v.string()),
    flagged: v.boolean(),
    flagReason: v.optional(v.string()),
    // Image attachment (Convex file storage)
    imageId: v.optional(v.id("_storage")),
    // The original generate_image tool prompt for a tutor-created illustration.
    // Optional so existing images keep their stored alt text and replay behavior.
    imagePrompt: v.optional(v.string()),
    // Provenance for a FOUND image (the search_image tool) rather than a
    // generated one. A found image is a real photograph or a published diagram,
    // so unlike a generated illustration it has a source that must travel with
    // it: the scholar sees the host under the picture, and the pair is what
    // lets a reader tell "the model drew this" from "the web published this".
    // Mutually exclusive with imagePrompt in practice — the two tools write
    // different rows — but nothing structural enforces that, so renderers must
    // treat either as optional.
    imageSourceHost: v.optional(v.string()),
    imageSearchQuery: v.optional(v.string()),
    // Problems-in-chat (roadmap §8 Pattern 3): an inline, interactive practice
    // item the tutor served mid-conversation via the serve_practice_problem
    // tool. Carried on a `role: "tool"` row so the scholar can answer it in
    // place; ordinary items grade through the normal practice path, while a
    // storyThread item uses its feedback-only policy. ANTI-CHEAT:
    // the correct answer is NEVER stored here (or sent to the client) — the
    // item is an opaque template or stored itemId re-derived server-side to
    // grade, mirroring the practice-session contract. Feature-gated
    // (CHAT_PRACTICE_ENABLED); ON in prod since 2026-07-13 (Andy's call —
    // flipped without the re-eval; early transcripts watched instead). See
    // review/practice/practice-unification-choice-geometry-plan.html.
    chatPractice: v.optional(
      v.union(
        v.object({
          kind: v.literal("typed"),
          // Story-thread applications use the feedback-only grade mutation.
          // Optional so every pre-existing ordinary chat-practice row remains valid.
          mode: v.optional(v.literal("storyThread")),
          itemId: v.string(),
          skillKey: v.string(),
          skillLabel: v.string(),
          stem: v.string(),
          answerType: v.string(),
          // The measurement unit the answer must carry, display form ("cm³").
          // Widening only — pre-existing rows have none and grade unit-free.
          answerUnit: v.optional(v.string()),
          choices: v.optional(v.array(v.string())),
          // Same non-leaky 2-D editor signal used by standalone practice.
          answerShape: v.optional(v.literal("twoD")),
          // Display-only prompt visual (e.g. the dots to count) — same channel
          // as practiceItems.promptVisual. Text-only items omit it.
          promptVisual: v.optional(promptVisualValidator),
        }),
        v.object({
          kind: v.literal("manipulative"),
          mode: v.optional(v.literal("storyThread")),
          itemId: v.string(),
          skillKey: v.string(),
          skillLabel: v.string(),
          // Goal-bearing spec only; it contains no answer string. The submitted
          // runtime state is graded server-side through submitAnswer.
          manipulativeSpec: v.string(),
        }),
      ),
    ),
    // Authored instruction served inline after the scholar explicitly names a
    // math gap and accepts the tutor's offer. This is a presentation snapshot,
    // not a graded item: lifecycle writes stay in instructionEvents and never
    // touch mastery, practice credit, or activity completion.
    instruction: v.optional(
      v.object({
        key: v.string(),
        title: v.string(),
        subtitle: v.optional(v.string()),
        atoms: v.array(instructionAtomValidator),
        contentVersion: v.number(),
      }),
    ),
    // Magic Annotations: idempotency guard so a re-run of the stream doesn't
    // re-detect/re-transform an already-processed user image upload.
    magicProcessed: v.optional(v.boolean()),
    // For persistent-text-streaming: links to active stream
    streamId: v.optional(v.string()),
    // Why a silent assistant-only stream was opened. Activity kickoff needs
    // durable provenance so clients can distinguish its recoverable placeholder
    // from a real transcript turn after an interrupted HTTP stream.
    streamTrigger: v.optional(
      v.union(v.literal("activityKickoff")),
    ),
    // Liveness heartbeat for an in-flight stream. The HTTP stream handler
    // stamps this at message_start and on every persist tick; the orphan-reap
    // in sessions.sendMessage keys its age-guard off it (not _creationTime) so
    // a healthy-but-slow stream — long tool call, model thinking-pause, or a
    // short reply that never reaches the persist threshold — is never reaped
    // while still alive. Optional so pre-existing rows validate; the reap falls
    // back to _creationTime when it's absent.
    lastStreamActivityAt: v.optional(v.number()),
    // Reading-ramp grapheme spans (young-learners-plan.html §10). Written
    // post-stream by the grapheme annotator (graphemeActions.annotateAndStore)
    // ONLY for pre-reader scholars with an active team inventory; consumed by
    // the GraphemeText renderers (web + native) to color the grapheme teams the
    // scholar is currently training. Character offsets [start, end) into
    // `content`. A stored value — even `[]` (a valid "nothing to color" result)
    // — doubles as the annotator's idempotency guard.
    graphemeSpans: v.optional(
      v.array(
        v.object({
          start: v.number(),
          end: v.number(),
          team: v.string(),
        }),
      ),
    ),
  })
    .index("by_session", ["sessionId"])
    .index("by_session_role", ["sessionId", "role"])
    .index("by_stream", ["streamId"])
    .index("by_chat_practice_item", ["chatPractice.itemId"]),

  analyses: defineTable({
    sessionId: v.id("sessions"),
    engagementScore: v.optional(v.number()),
    complexityLevel: v.optional(v.number()),
    onTaskScore: v.optional(v.number()),
    topics: v.optional(v.array(v.string())),
    learningIndicators: v.optional(v.array(v.string())),
    concernFlags: v.optional(v.array(v.string())),
    summary: v.optional(v.string()),
    suggestedIntervention: v.optional(v.string()),
    promptVersion: v.optional(v.string()),
  }).index("by_session", ["sessionId"]),

  observations: defineTable({
    teacherId: v.id("users"),
    scholarId: v.id("users"),
    sessionId: v.optional(v.id("sessions")),
    note: v.string(),
    type: v.union(
      v.literal("praise"),
      v.literal("concern"),
      v.literal("suggestion"),
      v.literal("intervention"),
      v.literal("note"),
    ),
    category: v.optional(
      v.union(
        v.literal("execFunction"),
        v.literal("socialEmotional"),
        v.literal("collaboration"),
        v.literal("passions"),
        v.literal("other"),
      ),
    ),
    // Migrated Whole Child inputs retain their explicit term filing. New
    // observations derive reporting-period membership from _creationTime.
    periodId: v.optional(v.id("reportingPeriods")),
    // Claim-strength weight for the evidence binder (assessment-and-goals §12).
    // "major" surfaces first + carries the claim-strength weight; "minor" is
    // texture. Default (incl. unset) == minor, so history needs no backfill.
    // The staff bot infers this from language ("this is a big one", an
    // incident with follow-up) and says which it chose in its confirmation.
    weight: v.optional(v.union(v.literal("minor"), v.literal("major"))),
  })
    .index("by_scholar", ["scholarId"])
    .index("by_teacher", ["teacherId"])
    .index("by_session", ["sessionId"]),

  // ─── Standards Reference Layer (for compliance lens) ─────────────
  standardsDocuments: defineTable({
    asnDocumentId: v.string(),
    title: v.string(),
    subject: v.string(),
    jurisdiction: v.string(),
  })
    .index("by_subject", ["subject"])
    .index("by_jurisdiction", ["jurisdiction"]),

  standards: defineTable({
    asnId: v.string(),
    notation: v.optional(v.string()),
    description: v.string(),
    gradeLevels: v.array(v.string()),
    subject: v.string(),
    statementLabel: v.string(),
    isLeaf: v.boolean(),
    parentId: v.optional(v.id("standards")),
    documentId: v.id("standardsDocuments"),
    // ─── Understanding (node identity) vs. the code (a tag) ──────────────
    // A short, kid-/teacher-legible phrasing of what the standard means ("you
    // can tell which of two fractions is bigger"), so the Knowledge Tree's node
    // identity is an UNDERSTANDING and the CCSS/ASN code rides along as a tag —
    // never the node's identity. LLM-translated (Haiku) from notation +
    // description, persisted + cached. See convex/understandings.ts.
    understanding: v.optional(v.string()),
    understandingSource: v.optional(v.string()), // e.g. "claude-haiku-4-5"
  })
    .index("by_subject", ["subject"])
    .index("by_subject_leaf", ["subject", "isLeaf"])
    .index("by_parent", ["parentId"])
    .index("by_notation", ["notation"])
    .index("by_document", ["documentId"])
    .index("by_asnId", ["asnId"]),

  // ═══ THE ONE CANONICAL KNOWLEDGE NODE (§1 of review/practice/) ═══════════
  // ONE node type subsuming the three former stores: the curated knowledgeTree
  // (code DAG, lib/knowledgeTreeData.ts), practiceSkills (procedural DAG), and
  // concepts + atlas (the Sky). A node's IDENTITY is the understanding/skill
  // itself (`nodeKey` + `label`) — a standard is an OPTIONAL crosswalk TAG,
  // never identity, never the join spine; a standard-less node is first-class.
  // Facets are populated as needed: "core vs. beyond-core" is WHICH facets are
  // filled, not a second node type. Per-scholar readings (practiceMastery,
  // masteryObservations) stay in their own tables. This is Wave 0 — the
  // foundation every later lane reads. Built on-branch as a destructive rebuild
  // (no backward-compat adapters); existing prod is a later lossy re-seed.
  knowledgeNodes: defineTable({
    // ── identity facet ──
    nodeKey: v.string(), // stable snake_case id (was practiceSkills.skillKey)
    label: v.string(), // the understanding/skill in plain words — the identity
    domain: v.string(), // discipline vertical (math, biology, writing, …)
    strand: v.optional(v.string()), // sub-thread within a domain (§2 frontier vector)
    normalizedLabel: v.optional(v.string()), // lowercased/collapsed, for dedup + lookup (was concepts.normalizedLabel)
    // ── standards facet (OPTIONAL tag — never identity) ──
    standardCodes: v.optional(
      v.array(v.object({ framework: v.string(), code: v.string() })),
    ),
    grade: v.optional(v.string()), // optional soft band hint ("K".."8"); not identity
    standardId: v.optional(v.id("standards")), // provenance back-link (was concepts.standardId)
    // ── procedural facet (absent = a non-procedural / concept-only node) ──
    verifierKind: v.optional(v.string()), // pluggable check ("arithmetic" | "unit-test" | …)
    order: v.optional(v.number()), // topological/display order within the domain
    rationale: v.optional(v.string()), // one line: what a learner can DO here
    // ── conceptual facet ──
    // depth (Bloom) is a PER-SCHOLAR reading in masteryObservations — not stored here.
    source: v.optional(v.string()), // provenance: "curated" | "practice" | "standard" | "mastery" | "seed" | "world"
    refCount: v.optional(v.number()), // how many source rows rolled into this node
    // ── story-art facet ──
    // Pre-baked scholar-safe art belongs only on world/far-end story nodes by
    // convention. Optional so the procedural/core graph stays image-free and
    // every story can keep using its authored visualEmoji fallback.
    artStorageId: v.optional(v.id("_storage")),
    artContentHash: v.optional(v.string()), // sha256 of the baked transparent PNG
    artStatus: v.optional(
      v.union(
        v.literal("generating"),
        v.literal("ready"),
        v.literal("failed"),
      ),
    ),
    // ── spatial facet: BOTH projections of the one node (§4 guard) ──
    embeddingText: v.optional(v.string()),
    embeddedAt: v.optional(v.number()),
    skyX: v.optional(v.number()), // Sky/atlas omnidirectional PCA (was concepts.x)
    skyY: v.optional(v.number()), // (was concepts.y)
    treeX: v.optional(v.number()), // Skills-map DAG-depth projection (§4 atlasX)
    treeY: v.optional(v.number()), // (§4 atlasY)
    treeY2: v.optional(v.number()), // Skills-map parallax lane (§4 atlasY2)
    projectedAt: v.optional(v.number()),
    // ── conceptual facet: curated knowledgeTree matching ──
    // Lowercase keywords that map an observer's concept label onto this node
    // (was knowledgeTree TreeNode.match). Present on curated (source:"curated")
    // nodes absorbed from the code-backed knowledgeTree fixtures; absent
    // elsewhere. Read by frontierForScholar's keyword match.
    matchKeywords: v.optional(v.array(v.string())),
  })
    .index("by_nodeKey", ["nodeKey"])
    .index("by_domain", ["domain"])
    .index("by_domain_strand", ["domain", "strand"])
    .index("by_normalized", ["normalizedLabel"])
    .index("by_source", ["source"])
    .index("by_standard", ["standardId"]),

  // Vectors live in a side table (same reason as conceptEmbeddings — keep the
  // hot display queries light; only the build steps + bounded cosine read them).
  // Keyed 1:1 to a node; cleared/rewritten on rebuild.
  knowledgeNodeEmbeddings: defineTable({
    nodeId: v.id("knowledgeNodes"),
    vector: v.array(v.float64()),
  }).index("by_node", ["nodeId"]),

  // The ONE edge set. An edge connects two understandings; its `kind` is the
  // physical legacy column, its relation says whether the edge ORDERS learning
  // or merely INVITES it, its method says who/what drew it, and its story says
  // what verified world-material the tutor can say about it. Relation mapping:
  // buildsOn/buildsTowards/requires => dependency (directional, arrows OK);
  // bridge/explicit/nn => bridge (associative, no arrows); implies => dependency
  // for RENDER, but INFERENCE-ONLY — consumed only by placement inference +
  // implicit-credit propagation, and structurally invisible to frontier gating
  // and prereq recommendations (which key off kind:"buildsOn"). Method mapping
  // for legacy rows: dependency + implies kinds => curated; bridge => embedding;
  // explicit => observed; nn => nn. Ownership rule: story-bearing rows and
  // method curated/generated rows are CORPUS and no pipeline may delete or
  // overwrite them; embedding/nn/observed rows without stories are CACHE and may
  // be rebuilt. Cosmology: the edge is canonical, a leap is per-scholar evidence
  // that a connection was made, and a seed is a per-scholar invitation to make
  // one. Keyed by nodeKey strings so graph lanes seed/merge without id joins.
  knowledgeNodeEdges: defineTable({
    fromKey: v.string(), // prerequisite / source (nodeKey)
    toKey: v.string(), // dependent / target (nodeKey)
    domain: v.string(),
    kind: v.string(), // "buildsOn" | "buildsTowards" | "requires" | "bridge" | "explicit" | "nn" | "implies"
    weight: v.optional(v.number()),
    // ── method: who/what drew this edge (generation provenance) ──
    // "curated"   – code-backed fixtures or human-verified content (durable)
    // "generated" – LLM-authored content that passed verification (durable)
    // "embedding" – atlas cross-domain cosine backbone (pipeline-owned, regenerable)
    // "nn"        – atlas per-node top-K cosine neighbors (pipeline-owned, regenerable)
    // "observed"  – promoted from a scholar's crossDomainConnections leap (pipeline-owned)
    method: v.optional(
      v.union(
        v.literal("curated"),
        v.literal("generated"),
        v.literal("embedding"),
        v.literal("nn"),
        v.literal("observed"),
      ),
    ),
    // ── story: verified world-material payload (what the tutor can SAY about this edge) ──
    // Present => this row is CORPUS, not cache: no pipeline may ever delete or overwrite it.
    story: v.optional(
      v.object({
        kind: v.union(
          v.literal("instantiates"),
          v.literal("applies"),
          v.literal("history"),
          v.literal("etymology"),
        ),
        hook: v.string(), // one-line hook title (<=200 chars)
        narrative: v.string(), // the story itself (<=600)
        // Card teaser: the 1-3 sentence hook+surprise the reveal card renders in
        // place of the full narrative, so the moment reads as a teaser, not a wall
        // of text. Content metadata (same species as the story text), NOT a UI
        // primitive — the full `narrative` is still what the "Find out more" tutor
        // thread receives (storyOpen). Optional so pre-teaser prod stories still read.
        teaser: v.optional(v.string()), // card teaser (<=400 chars)
        // A single curiosity cue, authored with a story or its stable world family.
        // Optional so legacy stories degrade honestly to their text-only rendering.
        visualEmoji: v.optional(v.string()),
        probe: v.optional(v.string()), // Socratic question into it (<=300)
        source: v.optional(v.string()), // citation / verification trail
        provenance: v.union(
          v.literal("registry"),
          v.literal("authored"),
          v.literal("generated"),
        ),
        updatedAt: v.optional(v.number()),
      }),
    ),
  })
    .index("by_to", ["toKey"])
    .index("by_from", ["fromKey"])
    .index("by_from_to", ["fromKey", "toKey"])
    .index("by_domain", ["domain"])
    .index("by_kind", ["kind"])
    .index("by_story_provenance", ["story.provenance"]),

  // Per-scholar per-skill mastery + retention — the engine's output, what the
  // Skills lens reads. `repetition` → proficiency band; `halfLifeDays` +
  // `lastPracticedAt` → retention (fresh/due); `frontier` is denormalized for
  // cheap reads. `source` is the engine-neutral discriminator ("practice" =
  // homegrown problem sets; "placement" = the placement quiz). See
  // convex/lib/practice/scheduler.ts. Discipline-agnostic — no standards here.
  practiceMastery: defineTable({
    scholarId: v.id("users"),
    skillKey: v.string(),
    domain: v.string(),
    // Denormalized sub-thread within the domain (mirrors the node's
    // `knowledgeNodes.strand`) — kept here so per-strand grouping/rollups
    // read cheaply off `by_scholar_strand` without joining back to the node.
    strand: v.optional(v.string()),
    // DEPRECATED widening field. A teacher's per-scholar skill target for this domain — the node the
    // teacher wants this scholar pointed at next (an override/pin on top of
    // the engine's own frontier). Optional: absent == follow the engine.
    teacherFocusSkillKey: v.optional(v.string()),
    repetition: v.number(),
    halfLifeDays: v.number(),
    // The spaced-repetition CLOCK for this skill — reset whenever the review
    // schedule legitimately restarts, which INCLUDES inferred credit: placement
    // and reprobe stamp it so a trust-upward row starts its retention decay. So
    // `lastPracticedAt` is "when the SR clock last ticked", NOT "when the scholar
    // last actually drilled" — a freshly-placed row has a `lastPracticedAt` even
    // though no attempt happened. Use it for isDue / retention only.
    lastPracticedAt: v.optional(v.number()),
    // The REAL attempt signal — stamped ONLY by recordAttemptCore, on every
    // recorded attempt (correct OR wrong). Placement / reprobe / seed inserts
    // deliberately leave it unset, so this is the honest "did the scholar drill
    // this skill" timestamp. Weekly rollups count practice days + inactivity off
    // THIS field, never `lastPracticedAt` (which placement would inflate).
    // Forward-only: unset on historical rows, populated going forward.
    lastAttemptAt: v.optional(v.number()),
    frontier: v.boolean(),
    source: v.string(), // "practice" | "placement"
    updatedAt: v.number(),
    // Self-relative latency baseline (Wave B, "B5" — raise-the-ceiling plan
    // §5): a small ring buffer of the most recent CORRECT first-key latencies
    // (stem render → first keystroke — the retrieval read, not typing time),
    // capped ~10 (oldest dropped), plus the median + spread (median absolute
    // deviation, MAD) recomputed from the buffer on every update. This is what
    // lets the acceleration valve (B1) and the automaticity gauge tell "fast
    // for THIS scholar" from slow, WITHOUT any cross-scholar norm. See
    // convex/practiceSkills.ts (submitAnswer, recordAttemptCore).
    latencySamplesMs: v.optional(v.array(v.number())),
    latencyMedianMs: v.optional(v.number()),
    latencySpreadMs: v.optional(v.number()),
    // Acceleration valve (Wave B, "B1" — §4): the current CLEAN consecutive
    // correct-attempt streak on this node. Increments on a recorded correct,
    // resets to 0 on a miss (⑫ retries use record:false → never counted, so a
    // streak entry is a genuine first attempt). When it reaches ACCEL_STREAK at
    // a frontier node the node is credited fluent (source "accelerated").
    accelStreak: v.optional(v.number()),
    // The MIRROR of accelStreak: the current consecutive-MISS streak on this
    // node. Increments on a recorded miss, resets to 0 on a recorded correct
    // (recordAttemptCore) — a correct answer is the "more recent determination
    // of fluency" that supersedes earlier misses. At STRUGGLING_MISS_THRESHOLD
    // (2) it drives the teacher/parent-facing "struggling" render state (a red
    // dot on the mastery dial/map), distinct from amber "frontier". Deliberately
    // NOT a scan of the append-only practiceAttempts log (which grows without
    // bound — see residentStruggleSignal): O(1) resident state, exactly like
    // accelStreak. REDACTED from the scholar's own map (teacher/parent only).
    missStreak: v.optional(v.number()),
    // TRANSITION timestamps — set ONCE, at the moment the row crosses a bar in
    // the write path (recordAttemptCore), so week-over-week rollups can report a
    // TRUE "turned fluent / moved the frontier THIS week" instead of the lossy
    // "touched-recently AND currently-passes-the-bar" proxy (the composite
    // isFluent read decays with time; the crossing is an EVENT, so it must be
    // stamped when it happens). Forward-only: unset on historical rows, populated
    // going forward. Both gates are monotonic in the write path (repetition never
    // decreases; source only moves toward "practice"), so each fires at most once
    // per skill — a later review or a miss never re-stamps.
    //   • becameFluentAt — the DEMONSTRATED gate flips true (accessProven AND
    //     source "practice"). Never set by inferred credit (placement / reprobe /
    //     accelerated) — only a real correct attempt earns it.
    //   • frontierAdvancedAt — ACCESS is proven THROUGH practice (repetition
    //     crosses FLUENT_REPS in recordAttemptCore, incl. a valve jump).
    //     Placement's trust-upward is inserted elsewhere, so a bulk placement
    //     never inflates a week's "frontier moves".
    becameFluentAt: v.optional(v.number()),
    frontierAdvancedAt: v.optional(v.number()),
    // FIRe implicit refresh bookkeeping (§4A) — teacher/admin-facing only.
    // `lastImplicitAt`: when this row last received fractional implicit credit
    // from a correct answer on a descendant skill; `implicitCount`: how many
    // times it has. Invisible to every scholar-facing read; feeds
    // instrumentation and the tune-up sampler. Implicit credit NEVER touches
    // `repetition`/`source`/`frontier`, so it can't flip a fluency color.
    lastImplicitAt: v.optional(v.number()),
    implicitCount: v.optional(v.number()),
  })
    .index("by_scholar", ["scholarId"])
    // Today only needs struggling rows, never a scholar's complete mastery
    // record. Keep the resident miss-streak signal range-addressable.
    .index("by_scholar_miss_streak", ["scholarId", "missStreak"])
    .index("by_scholar_domain", ["scholarId", "domain"])
    .index("by_scholar_strand", ["scholarId", "strand"])
    .index("by_scholar_skill", ["scholarId", "skillKey"]),

  // FACT FLUENCY — the FastMath-analog automaticity substrate (2026-07). A
  // `practiceMastery` row lives at the grain of a fact FAMILY (`skillKey`, e.g.
  // `mult_facts_7_8_9`); automaticity, though, lives at the grain of the single
  // fact — a scholar can be instant on 7×2 and still counting on 7×8. This
  // table is that finer, per-fact retrieval ledger, minted ONLY for the
  // fact-family skills (`shared/factKey.ts` → FACT_FAMILY_SKILLS) and written
  // ONLY by `recordAttemptCore` off the same attempt that updates mastery.
  //
  // DELIBERATELY INVISIBLE + NON-GATING (doctrine): it never gates access and is
  // never rendered to a scholar as a number/score/clock. It refines the
  // green/automaticity CLAIM (the lightning gauge) and selects which bare facts
  // a "Fast math" beat drills — nothing else. `factKey` is the canonical
  // identity (commutative ops folded: 7×8 ≡ 8×7); see `shared/factKey.ts`.
  factFluency: defineTable({
    scholarId: v.id("users"),
    // Canonical fact identity — `add:LO+HI` | `sub:A-B` | `mul:LOxHI`
    // (`shared/factKey.ts`). Commutative ops fold; subtraction keeps order.
    factKey: v.string(),
    // The fact-FAMILY skill this fact most recently rolled up from (e.g.
    // `mult_facts_7_8_9`). Generator spaces overlap, so sprint selection derives
    // current family membership from `factKey` rather than treating this as an
    // owner.
    skillKey: v.string(),
    domain: v.string(),
    // Lifetime tallies: recorded attempts (correct OR wrong) and correct
    // attempts. Automaticity is classified from accuracy + recent latency
    // relative to the scholar's current baseline, not a persisted fast verdict.
    seenCount: v.number(),
    correctCount: v.number(),
    // Per-fact CORRECT-ONLY latency ring buffer (mirrors `practiceMastery`'s
    // B5 buffer): recent first-key latencies (stem render → first keystroke =
    // the retrieval read, not typing time) plus their median. A miss's first-key
    // time reflects hesitation, not retrieval, so it never enters here.
    latencySamplesMs: v.optional(v.array(v.number())),
    latencyMedianMs: v.optional(v.number()),
    // Retained for decay/retention policy: lastSeenAt ages any practiced fact,
    // while lastCorrectAt distinguishes successful retrieval from mere exposure.
    lastSeenAt: v.number(),
    lastCorrectAt: v.optional(v.number()),
  })
    .index("by_scholar", ["scholarId"])
    .index("by_scholar_fact", ["scholarId", "factKey"]),

  // CALCULATOR LICENSE — the durable record of a scholar receiving the
  // school's teacher-proctored, offline Calculator License Test. One row per
  // scholar; granting again CORRECTS the existing row (re-recording at the
  // teacher's discretion), deleting it removes the credential.
  //
  // WHY A ROW AT ALL, when Fast Math readiness is already derivable. They are
  // different KINDS of claim, and collapsing them would lose the durable one:
  // readiness is derived from the live fact ledger and DECAYS (an automaticity
  // rung can fall back), while a license is an adult-issued event that happened
  // on a date and stays true. Pass/not-yet is entirely at TEACHER DISCRETION —
  // there is no numeric score or threshold the app enforces — so automaticity
  // never gates this credential either.
  //
  // Deliberately minimal: the exam itself is paper, proctored in the room, so
  // nothing about item-level responses belongs here — only when and who
  // issued it.
  //
  // The linked badge is celebration art only. Scholars may remix its constrained
  // style/colorway, but the issuer and validity remain on this teacher-owned
  // row.
  calculatorLicenses: defineTable({
    scholarId: v.id("users"),
    // @deprecated Legacy field from when the grant mutation recorded a raw
    // paper-exam score (24-28 out of 28). Pass/not-yet is now entirely a
    // teacher-discretion call with no numeric input, so this is never read,
    // written, or validated by current code. Kept optional, and only so that
    // documents already in production (which may still carry it) remain valid
    // against the schema — do not resurrect it as a live field.
    score: v.optional(v.number()),
    issuedAt: v.number(),
    // The proctoring teacher/admin who recorded the pass.
    issuedBy: v.id("users"),
    // Generated gold medallion displayed on the scholar's credential and in
    // their badge collection. Optional for forward-compatible legacy rows.
    badgeId: v.optional(v.id("scholarUnitBadges")),
  }).index("by_scholar", ["scholarId"]),

  // The teacher-set domain[/strand]×grade checkpoint for one durable math group. A
  // scholar group becomes a math group by having this row; ordinary pods and
  // class-digest groups need no discriminator field. The checkpoint is a SOFT
  // preference for new frontier work, never an access gate or mastery claim.
  mathGroupCheckpoint: defineTable({
    groupId: v.id("scholarGroups"),
    domain: v.string(),
    strand: v.optional(v.string()), // absent => the whole domain at this grade
    grade: v.string(),
    // DEPRECATED widening field from the retired per-skill checkpoint UI.
    // Current checkpoints are the domain[/strand] × grade band above.
    nodeKey: v.optional(v.string()),
    updatedBy: v.id("users"),
    updatedAt: v.number(),
  }).index("by_group", ["groupId"]),

  // A scholar-specific exception to the math group's checkpoint. Teacher rows
  // outrank the group. Certification remains derived from mastery, not
  // persisted here.
  scholarCheckpointOverride: defineTable({
    scholarId: v.id("users"),
    domain: v.string(),
    strand: v.optional(v.string()), // absent => the whole domain at this grade
    grade: v.string(),
    // DEPRECATED widening field from the retired per-skill checkpoint UI.
    nodeKey: v.optional(v.string()),
    source: v.literal("teacher"),
    updatedBy: v.id("users"),
    updatedAt: v.number(),
  })
    .index("by_scholar", ["scholarId"]),

  // The canonical per-scholar Math-plan controls. An explicit `open` row is
  // meaningful: it overrides a legacy standing-practice assignment during the
  // widening dual-read.
  scholarMathPlans: defineTable({
    scholarId: v.id("users"),
    practiceScope: v.union(
      v.object({ kind: v.literal("open") }),
      v.object({
        kind: v.literal("limited"),
        domains: v.array(
          v.object({
            domain: v.string(),
            strands: v.optional(v.array(v.string())),
          }),
        ),
      }),
    ),
    checkpointSuppressed: v.optional(v.boolean()),
    updatedBy: v.id("users"),
    updatedAt: v.number(),
  }).index("by_scholar", ["scholarId"]),

  // Widen-phase audit trail: ambiguous legacy standing assignments are recorded
  // rather than converted into an invented Math-plan scope.
  scholarMathPlanMigrationIssues: defineTable({
    scholarId: v.id("users"),
    assignmentIds: v.array(v.id("assignments")),
    reason: v.union(
      v.literal("complex_strand_config"),
      v.literal("overlapping_standing_assignments"),
      v.literal("unknown_domain"),
    ),
    recordedAt: v.number(),
  }).index("by_scholar", ["scholarId"]),

  // Append-only per-scholar reveal latch + event log for the Tree map's
  // thoughtful-reveal horizon. A row means "this node has been revealed to this
  // scholar" — written once, never deleted (never un-reveal). Doubles as the
  // daily-recap "Added to your Tree Map" event source.
  nodeReveals: defineTable({
    scholarId: v.id("users"),
    nodeKey: v.string(),
    revealedAt: v.number(),
    // What knowledge movement caused the reveal. Only "practice" today.
    source: v.string(),
  })
    .index("by_scholar", ["scholarId"])
    .index("by_scholar_node", ["scholarId", "nodeKey"])
    .index("by_scholar_revealedAt", ["scholarId", "revealedAt"]),

  // OBSERVATION: the durable, stateful funnel for a rare scholar-facing
  // "moment" opened from the learning record. `practiceChoiceEvents` and
  // `practiceErrorEvents` are intentional SIBLING ledgers: immutable telemetry
  // for teacher/observer reads, while this table is scholar-facing and patched
  // as its interaction outcome advances. Combining them in one
  // kind-discriminated table would blur privacy boundaries and force unrelated
  // mutability and index needs into one contract.
  //
  // Moment vocabulary has four distinct axes: surface (the moment/card), source
  // (the story edge and fluency trigger), action (the offer/open/probe/try/save/
  // dismiss operation), and outcome (its past-tense result:
  // offered/opened/probed/tried/saved/dismissed). Keep those axes separate rather
  // than introducing transport-specific synonyms.
  //
  // The first moment kind is a verified skill→world story offered when
  // `practiceMastery.becameFluentAt` crosses the demonstrated-fluency bar; the
  // kind union is intentionally narrow now and will grow as other moment
  // families earn their own routing rules.
  //
  // This is a ledger, not the story corpus: `fromKey` + `toKey` are logical
  // references to `knowledgeNodeEdges` because graph identity lives in stable
  // node keys, while the actual hook/narrative/source remain canonical on the
  // edge. `offeredAt` drives both the global rarity governor and per-edge
  // re-offer window. `outcome` advances monotonically from offered through
  // interaction; tried/saved/dismissed are terminal so a scholar's durable
  // choice is never erased by a late client event. `tried` means the linked
  // Go-deeper round actually started, preserving the existing rule that starting
  // stretch settles the story. `clientEventId` makes the render-time write
  // retry-safe across reconnects.
  momentEvents: defineTable({
    scholarId: v.id("users"),
    // Future moment families widen this literal union rather than overloading
    // story outcomes or trigger semantics.
    kind: v.literal("story"),
    fromKey: v.string(),
    toKey: v.string(),
    trigger: v.literal("fluency_transition"),
    offeredAt: v.number(),
    outcome: v.union(
      v.literal("offered"),
      v.literal("opened"),
      v.literal("probed"),
      v.literal("tried"),
      v.literal("saved"),
      v.literal("dismissed"),
    ),
    outcomeAt: v.optional(v.number()),
    clientEventId: v.string(),
  })
    // Chronological per-scholar governor/read model.
    .index("by_scholar", ["scholarId", "offeredAt"])
    // Durable per-edge eligibility history, independent of story payload edits.
    .index("by_scholar_edge", ["scholarId", "fromKey", "toKey"])
    // Render retries are idempotent per scholar without scanning their ledger.
    .index("by_scholar_client_event", ["scholarId", "clientEventId"]),

  // ─── Instructional "Launchpad" content (instructional segments v1) ────────
  // Versioned, verified, STRAND-LEVEL instructional content shown the first time
  // a scholar enters a genuinely new strand (answers "too fully Socratic" with a
  // real explain-and-show beat that sits on the playlist alongside practice).
  //
  // The load-bearing design choice: content is DECOUPLED from any served item. A
  // `worked_example` atom teaches the strand's core move on its OWN canonical
  // numbers, never a live item's stem/answer. That decoupling is what makes a
  // Launchpad structurally safe to never touch mastery (`masteryEffect` is a
  // property of the content shape, not a trusted client flag) and lets the same
  // content double as an on-demand "See an example" explainer. It also sidesteps
  // the serve-time answer-leak problem (the front-run item is only chosen after
  // scheduling): because the Launchpad never references that item, there is no
  // pairwise leak to verify at serve time.
  //
  // One PASSED row per `key` = "strand:<domain>:<strand>" is the serve contract;
  // a higher `version` supersedes. Missing/unverified content ⇒ NO Launchpad is
  // offered — never a broken/empty card, and (for a designated anchor strand) a
  // seed-time coverage check flags the gap rather than silently dropping the
  // scholar back to fully-Socratic. `atoms` is validated non-empty.
  instructionContent: defineTable({
    key: v.string(), // "strand:<domain>:<strand>"
    domain: v.string(),
    strand: v.string(),
    version: v.number(),
    title: v.string(),
    subtitle: v.optional(v.string()),
    atoms: v.array(instructionAtomValidator),
    provenance: v.union(v.literal("authored"), v.literal("generated")),
    verifyStatus: v.union(
      v.literal("passed"),
      v.literal("failed"),
      v.literal("unverified"),
    ),
    verifyReport: v.optional(v.string()),
    unavailableVideoIds: v.optional(v.array(v.string())),
    videosCheckedAt: v.optional(v.number()),
    platforms: v.array(v.string()), // Authored seed targets ["web", "native"].
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_key_status", ["key", "verifyStatus"])
    .index("by_domain", ["domain"]),

  // ─── Instructional "Launchpad" per-scholar lifecycle ledger (v1) ──────────
  // ONE offer row per (scholar, key). Like `momentEvents` (and unlike the
  // immutable `practiceChoiceEvents`/`practiceErrorEvents` telemetry siblings)
  // this is a scholar-facing, PATCHED lifecycle row. Independent nullable
  // timestamps record the funnel — shown → (skip=try | show) → viewed /
  // completed / dismissed — plus an append-only `retrievals` log for later
  // "See an example" reopens ("idea_shelf") and post-miss explainer pulls
  // ("post_miss").
  //
  // Re-offer rule (pedagogy): a Launchpad re-offers while the scholar only ever
  // tapped "Try it myself" and never viewed/completed/dismissed it, capped at
  // `offerCount <= 3` — so one impulsive skip never permanently suppresses
  // instruction, but a scholar who has seen or deliberately dismissed it is left
  // alone. `lastShownDayBucket` (scholar-local yyyy-mm-dd) enforces ≤1 Launchpad
  // per day across keys. `offerId` = `${scholarId}:${key}` is the stable render
  // handle threaded through the wire entry and every record mutation.
  //
  // PRIVACY: SYSTEM-ONLY. Never read into any mastery, credit, adaptive-
  // difficulty, or scholar-/teacher-facing "quality"/deficit surface. Choosing
  // "Show me" vs "Try it" is a preference, not a signal.
  //
  // ONE SANCTIONED CARVE-OUT (Andy's ruling, 2026-08-18): serving MAY read
  // `viewedAt` / `completedAt` / `retrievals[].at` as evidence that teaching
  // actually HAPPENED, to decide whether a previously-missed node re-enters as
  // a worked-step completion instead of a bare prompt — the teach-before-
  // re-serve gate (`practiceSkills.coldFailedSkillKeySet`). Nothing else opens:
  // `initialChoice`, `shownAt`, `dismissedAt` and `offerCount` stay off-limits
  // to serving, so choosing "Try it myself" never by itself changes difficulty.
  // Only the MISS does, and any later success or teaching clears it.
  instructionEvents: defineTable({
    scholarId: v.id("users"),
    key: v.string(),
    offerId: v.string(),
    shownAt: v.optional(v.number()),
    initialChoice: v.optional(v.union(v.literal("try"), v.literal("show"))),
    viewedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    dismissedAt: v.optional(v.number()),
    offerCount: v.number(),
    lastShownDayBucket: v.optional(v.string()),
    retrievals: v.array(
      v.object({
        at: v.number(),
        source: v.union(v.literal("idea_shelf"), v.literal("post_miss")),
      }),
    ),
  })
    .index("by_scholar_key", ["scholarId", "key"])
    .index("by_scholar", ["scholarId"]),

  // Durable proof that a pre-answer worked-step rung crossed the wire. Kept
  // separate from `instructionEvents`: that Launchpad preference ledger is
  // explicitly forbidden from feeding mastery/credit, while this marker exists
  // solely so submitAnswer can keep an assisted solve inferred rather than green.
  // `createdAt` begins one bounded assistance window. A rung served after that
  // window writes a fresh row: ordering can resume from the latest historical
  // max while the newly served help still marks the next answer assisted.
  practiceHintReveals: defineTable({
    scholarId: v.id("users"),
    itemId: v.string(),
    maxStepServed: v.number(),
    createdAt: v.number(),
  }).index("by_scholar_item_createdAt", ["scholarId", "itemId", "createdAt"]),

  // ─── Game beats on the practice playlist ────────────────────────────────
  // A teacher's binding of a `kind="game"` activity to a slice of the practice
  // graph: "offer this game when the scholar is working this strand." It is how
  // a game shows up in a practice run WITHOUT being a practice item — a game
  // has no answer to grade, and grading one (pass iff you beat the AI) is the
  // exact D-3 violation this replaces.
  //
  // The beat is served as a SIDECAR to the run (`practiceSession.gameBeat =
  // {at, entry}`), never as an element of `items`, so the graded array and the
  // scheduler are untouched by construction. Rules live in
  // convex/lib/practice/gameBeats.ts.
  //
  // `skillKeys` (optional) narrows a binding from the whole strand to named
  // skills. Absent ⇒ the whole strand.
  practiceGameBindings: defineTable({
    activityId: v.id("activities"), // must be kind="game"
    domain: v.string(),
    strand: v.string(),
    skillKeys: v.optional(v.array(v.string())),
    /** Teacher-authored, scholar-facing: why this game is here. */
    blurb: v.optional(v.string()),
    isActive: v.boolean(),
    createdBy: v.id("users"),
  })
    .index("by_domain_strand", ["domain", "strand"])
    .index("by_activity", ["activityId"]),

  // The offer ledger for game beats — OFFERS and DECLINES only.
  //
  // Deliberately does NOT record "played": `gameSessions` already is that
  // record (one row per round, with startedAt/endedAt/status), and the cooldown
  // reads it there rather than keeping a second copy that could drift. This
  // table exists for the one fact `gameSessions` structurally cannot hold — a
  // doorway that was shown and passed on, which starts no session at all.
  //
  // Kept separate from `instructionEvents` rather than overloaded onto it: that
  // table's fields (`initialChoice: try|show`, `retrievals.source:
  // idea_shelf|post_miss`) are instruction-specific and would be nonsense here.
  //
  // PRIVACY: SYSTEM-ONLY, on the same footing as `instructionEvents`. Never read
  // into any mastery, credit, adaptive-difficulty, or scholar-/teacher-facing
  // "quality"/deficit surface. Passing on a game is a preference, not a deficit,
  // and a game's outcome never touches mastery at all (D-3).
  practiceGameOffers: defineTable({
    scholarId: v.id("users"),
    key: v.string(), // `game:<activityId>`
    offerId: v.string(), // `<scholarId>:<key>`
    activityId: v.id("activities"),
    offerCount: v.number(),
    lastOfferedAt: v.optional(v.number()),
    lastOfferedDayBucket: v.optional(v.string()), // scholar-local yyyy-mm-dd
    /** Set when the scholar passed the doorway rather than opening it. */
    declinedAt: v.optional(v.number()),
    /** Set when they opened it. The round itself lives in `gameSessions`. */
    lastAcceptedAt: v.optional(v.number()),
  })
    .index("by_scholar_key", ["scholarId", "key"])
    .index("by_scholar", ["scholarId"]),

  // Server-owned provenance for every image a practice model may consume.
  // Bytes enter through /practice-image-upload, which authenticates + authorizes
  // the caller before storing the blob and writing this row. A client can never
  // claim an arbitrary pre-existing storage id after the fact.
  practiceWorkImages: defineTable({
    scholarId: v.id("users"),
    itemId: v.string(),
    storageId: v.id("_storage"),
    source: v.union(
      v.literal("hint"),
      v.literal("miss"),
      v.literal("handoff"),
      v.literal("dialogue"),
    ),
    createdAt: v.number(),
  })
    .index("by_storage", ["storageId"])
    .index("by_scholar_item_createdAt", ["scholarId", "itemId", "createdAt"]),

  // Verified pad-grounded hint output. The full step sequence stays server-only:
  // serveHintStep exposes intermediate rungs and structurally withholds the final
  // answer-producing step through the same PR-3 contract.
  practicePadHints: defineTable({
    scholarId: v.id("users"),
    itemId: v.string(),
    imageId: v.id("_storage"),
    nudge: v.string(),
    workedSteps: v.optional(
      v.array(
        v.object({
          text: v.string(),
          blankText: v.optional(v.string()),
          expected: v.optional(v.string()),
          answerType: v.optional(
            v.union(
              v.literal("integer"),
              v.literal("decimal"),
              v.literal("fraction"),
              v.literal("expression"),
            ),
          ),
        }),
      ),
    ),
    model: v.string(),
    createdAt: v.number(),
  }).index("by_scholar_item_createdAt", ["scholarId", "itemId", "createdAt"]),

  // ─── Map reveals (the "milestone reveal" of the scholar's two maps) ──
  // One row per scholar per map (`sky` | `tree` | `mapComplete`) recording that
  // its ONE-TIME celebratory reveal has already been shown. It is NOT the
  // unlock flag — the gate that HIDES/SHOWS a map in the scholar's own nav is
  // derived purely from EVIDENCE (see convex/mapGates.ts: welcome-unit complete
  // / seeds / masteryObservations for the Sky; any practicePlacements row for
  // the Tree), so an existing scholar with history is never re-locked. This
  // table only answers "has the fun reveal already fired?" so it never
  // replays. A one-shot backfill (migrations.backfillMapReveals) stamps every
  // already-unlocked scholar as already-revealed, so the reveal fires only for
  // genuinely NEW scholars crossing the boundary. Reveals are scholar-self only
  // (teachers / parents / observers always see every map and never mint a row
  // here).
  //
  // `mapComplete` (finish-the-check-in surfaces, PR2, 2026-08-18) reuses this
  // SAME one-time-reveal mechanism for the Home "your map is ready" completion
  // card instead of inventing a second one. `eligibleCountSeen` is its only
  // extra field: since the above-ring territory offer (raise-the-ceiling,
  // 2026-08-19) it stores the GRADE-eligible domain count — the ring-membership
  // count that moves only on a real grade unlock — NOT `eligibleCount`/M, which
  // also grows the moment a scholar deliberately opens an above-ring domain
  // (self-opened growth must never fire the reveal). Rows stamped before that
  // change stored raw M, which was numerically identical (no scholar could open
  // an above-ring domain then), so no migration. The FIRST stamp (map
  // completes) sets it; a later grade unlock growing the grade-eligible count
  // past the watermark is a GROWTH moment ("a new domain appeared"), never a
  // second "map complete" — acknowledging re-stamps the same row. Absent/unused
  // on `sky`/`tree`.
  mapReveals: defineTable({
    scholarId: v.id("users"),
    map: v.union(v.literal("sky"), v.literal("tree"), v.literal("mapComplete")),
    revealedAt: v.number(),
    eligibleCountSeen: v.optional(v.number()),
  }).index("by_scholar_map", ["scholarId", "map"]),

  // Append-only practice attempt telemetry. One row per GRADED practice attempt
  // (correct and incorrect), keyed by the node and optional served item identity,
  // so teacher / analytics surfaces can compute per-item effectiveness (success
  // rate, latency, downstream retention) and future calibration can compare
  // "the engine thought R≈0.7" against actual review success. Teacher/analytics
  // only: never read it into a scholar-facing prompt/history/score stream.
  // `nodeKey` == the knowledgeNodes join key (a.k.a. skillKey on per-scholar
  // tables). Existing prod rows from PR #627 carry only the base item telemetry;
  // Phase-1 calibration fields are optional and populated going forward.
  practiceAttempts: defineTable({
    scholarId: v.id("users"),
    nodeKey: v.string(),
    itemId: v.optional(v.string()),
    correct: v.boolean(),
    // A client-minted logical submission identity. Optional for installed clients;
    // new submitAnswer callers reuse it after an ambiguous network failure so this
    // row is both the idempotency fence and the authoritative replay receipt.
    clientEventId: v.optional(v.string()),
    // Canonical authority-bearing request fields for the clientEventId. A key
    // reused for another answer must fail rather than replaying the wrong result.
    submissionFingerprint: v.optional(v.string()),
    // Exact submitAnswer result for a lost-response replay. JSON keeps this
    // additive receipt coupled to the mutation's output validator instead of
    // maintaining a second, drifting schema for the same public contract.
    submissionResult: v.optional(v.string()),
    // The scholar's SUBMITTED answer, sanitized + length-capped (control chars
    // stripped; a typed answer capped like a placement answer, a tapped
    // multiple-choice answer stored as its option label rather than its wire
    // index, a manipulative's opaque state capped to its own bound). Optional +
    // additive: legacy rows (and a Don't-Know, which carries no answer) simply
    // have none. Without it a
    // miss is an undiagnosable boolean — the error classifier
    // (`practiceErrorEvents`) is derived from THIS text, so it stays silent on
    // any miss the classifier can't read, and no teacher surface can say more
    // than "got it wrong." Teacher/analytics-only; never re-served to a scholar.
    answerText: v.optional(v.string()),
    // Marks a GRADE-ONLY retry submission (the `record:false` re-attempt during
    // the Socratic-handoff loop) rather than the first, scheduler-moving attempt.
    // A retry row is a pure diagnostic record: it captures the submitted answer +
    // outcome WITHOUT touching mastery/SR (it never runs the scheduler), and it
    // carries NO `lane` / `predictedRetention`, so the spiral-breaker miss-streak
    // and the self-tuning param-health calibration (both lane-gated) skip it.
    retry: v.optional(v.boolean()),
    // Server-authored breaker participation at attempt insertion. `false`
    // permanently prevents the row from advancing a miss streak or becoming its
    // trigger even when the inferred lane would ordinarily count (offline replay,
    // contained/Quick Facts mode, or staff rehearsal). A correct result in a
    // counted lane still resets prior misses, preserving the old operation
    // boundary. Optional for rolling compatibility: legacy rows without it retain
    // the previous retry + lane rules, while every new writer stamps a value.
    breakerEligible: v.optional(v.boolean()),
    // True only when the server rendered answer-producing worked steps or a
    // teaching scaffold with this graded attempt. Additive telemetry lets
    // resilience recovery reject assisted "fresh" evidence without asking the
    // client to characterize its own independence.
    scaffolded: v.optional(v.boolean()),
    // The server marks `scaffolded` when it rendered answer-producing help;
    // `selfReportedHelp` is the scholar's own post-verdict admission, and also
    // sets `scaffolded`: neither is a bare demonstration. This separate flag
    // preserves which provenance occurred.
    selfReportedHelp: v.optional(v.boolean()),
    // Exactly what the admission changed, so an un-press restores THAT and
    // nothing else. Without it an undo would have to guess, and the wrong guess
    // hands back a fluency claim that was never earned (a server-detected
    // scaffold, or a mastery row demoted by something else). Written by
    // `reportHelpUsed`, cleared by `undoHelpUsed`; absent on an un-admitted
    // attempt. `masterySource` is present iff the admission demoted a mastery
    // row, and holds that row's prior `source`.
    helpAdmissionUndo: v.optional(
      v.object({
        scaffoldedSet: v.boolean(),
        masterySource: v.optional(v.string()),
      }),
    ),
    // First-key latency remains the baseline-safe reading: values outside the
    // accepted retrieval window are kept separately so analytics can see slow
    // starts without feeding them into mastery, scheduling, or fluency.
    firstKeyMs: v.optional(v.number()),
    firstKeyMsCensored: v.optional(
      v.object({
        observedMs: v.number(),
        reason: v.union(v.literal("below_min"), v.literal("above_max")),
      }),
    ),
    // Render-to-submit time for the recorded first attempt. Unlike firstKeyMs,
    // this exists for tap/drag manipulatives and explicit Don't-Know submits.
    // Teacher/analytics-only; no scheduler or scholar-facing reader uses it.
    elapsedMs: v.optional(v.number()),
    domain: v.optional(v.string()),
    strand: v.optional(v.string()),
    lane: v.optional(
      v.union(
        v.literal("review"),
        v.literal("frontier"),
        v.literal("confirmation"),
        v.literal("placement"),
        v.literal("reprobe"),
        v.literal("tuneup"),
        v.literal("challenge"),
        v.literal("stretch"),
        v.literal("chat"),
      ),
    ),
    predictedRetention: v.optional(v.number()),
    elapsedDaysSinceLast: v.optional(v.number()),
    halfLifeBefore: v.optional(v.number()),
    halfLifeAfter: v.optional(v.number()),
    repetitionBefore: v.optional(v.number()),
    source: v.optional(v.string()),
    // Teacher/analytics-only lifecycle for teach-on-miss/don't-know moments.
    // These timestamps prove whether a generated worked explanation was merely
    // needed, actually began streaming, finished, or errored. They are never read
    // by scholar-facing surfaces.
    explanationReason: v.optional(
      v.union(v.literal("dont_know"), v.literal("miss")),
    ),
    explanationRequestedAt: v.optional(v.number()),
    explanationStartedAt: v.optional(v.number()),
    explanationFinishedAt: v.optional(v.number()),
    explanationErrorAt: v.optional(v.number()),
    // How far down the teaching-moment HINT LADDER this don't-know went, once
    // the scholar left it (practiceSkills.recordTeachingOutcome). Set ONLY on a
    // row that already has `explanationReason: "dont_know"`, and monotone —
    // it only ever deepens.
    //   "solved" — finished the blanked step unaided
    //   "hint"   — finished it after the tier-2 hint (the move, set up)
    //   "stuck"  — got it wrong, or escalated to the Socratic handoff
    // Teacher/analytics-only: it answers "WHICH RUNG was missing", which a bare
    // don't-know miss cannot. Never read by the scheduler, mastery or placement
    // — the teaching moment stays purely instructional. One sanctioned reader
    // (2026-08-18, alongside the `instructionEvents` carve-out): the teach-
    // before-re-serve gate treats a finished explanation as teaching, and a
    // moment left "stuck" as no teaching at all, so it never re-serves a missed
    // node bare. Difficulty of the RE-SERVE only; mastery/credit stay untouched.
    teachOutcome: v.optional(
      v.union(v.literal("solved"), v.literal("hint"), v.literal("stuck")),
    ),
    breaker: v.optional(
      v.object({
        streak: v.number(),
        offer: v.union(v.literal("accepted"), v.literal("declined")),
        recovery: v.union(
          v.literal("won"),
          v.literal("missed"),
          v.literal("none"),
          v.literal("skipped"),
        ),
      }),
    ),
    // Versioned resilience-recovery telemetry. Kept separate from `breaker` so
    // legacy `{ streak, offer, recovery }` rows retain their original meaning.
    // The timestamps are written by the server; the fresh result is linked to
    // the actually graded same-node attempt rather than a client assertion.
    breakerLifecycle: v.optional(
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
        // Written by the recovery-serving mutation before the item leaves the
        // server, so grading can authorize exactly that item rather than any
        // other item on the same node.
        freshItemId: v.optional(v.string()),
        freshIssuedAt: v.optional(v.number()),
        // The one easier close-out item is separately pinned from freshItemId:
        // fresh is same-node repair evidence; easy may be a different in-scope
        // mastery node and must never authorize an arbitrary client item.
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
    // The scholar's own working, as a cropped PNG of the Scratchpad, captured
    // automatically when this attempt was a MISS (never on a correct answer, and
    // never when the pad is empty). It exists because the thing that is supposed
    // to carry "where they went wrong" — `practiceErrorEvents` — is derived from
    // the ANSWER, so it stays silent on any miss the classifier can't read, and
    // it encodes a buggy-algorithm PATTERN, never HOW FAR the scholar got. A kid
    // who set the problem up correctly and slipped at step 3 is otherwise
    // indistinguishable from one who never started; the working is the only
    // record of the difference.
    //
    // Never exposed as a browsable record to the scholar or a parent. Same-problem
    // responsive help MAY consume it while responding to this item; the
    // cross-problem archive remains teacher-only (Andy, 2026-07-27, Proposal §6
    // Ruling 1). NodeDrawer is still the only browsable surface.
    // The scholar is told after the fact (on the miss card) that it was kept:
    // deliberately not warned beforehand, because a child who knows the pad is
    // watched while they work performs their thinking instead of doing it.
    workImageId: v.optional(v.id("_storage")),
    // Teacher/analytics-only SNAPSHOT of the missed problem, captured at GRADE
    // TIME (Option 2 — a read-time join from `itemId` to `practiceItems` is
    // blank for any generated/ephemeral item, which is exactly where a teacher
    // "trust but verify" look matters most; a snapshot is prod-true for every
    // item source, forever). Written ONLY on a MISS (never on a correct
    // answer, mirroring `workImageId`). Sourced from the same `GradeResult`
    // the grader already computed (`servable.ts`'s `stem` / `correctAnswer`)
    // — no extra read or join at write time. Sanitized + length-capped like
    // `answerText`; never re-served to a scholar; never read by the
    // scheduler, mastery, or placement. No migration/backfill: legacy rows,
    // and any miss from a surface with no discrete stem (the stretch-dialogue
    // Socratic judge in `practiceDialogue.ts`), simply lack these fields, and
    // the teacher-only read side omits them gracefully.
    stemSnapshot: v.optional(v.string()),
    // The unredacted canonical answer (`GradeResult.correctAnswer` —
    // deliberately NOT `revealedAnswer`, which the drill policy usually
    // withholds from the scholar on a miss). Absent for a manipulative item
    // (no answer string to snapshot; it grades via `isSolved`).
    expectedAnswer: v.optional(v.string()),
    createdAt: v.optional(v.number()),
  })
    .index("by_scholar", ["scholarId"])
    .index("by_scholar_client_event", ["scholarId", "clientEventId"])
    .index("by_node", ["nodeKey"])
    .index("by_item", ["itemId"])
    .index("by_scholar_item_createdAt", ["scholarId", "itemId", "createdAt"])
    // Per-(scholar, node) history, newest last. Serves the teacher-only
    // `recentMissesForNode` read behind the node drawer: without it the only route
    // to "this scholar's attempts on this node" is a full per-scholar scan
    // filtered in memory, and this table grows by one row per graded attempt.
    .index("by_scholar_node_createdAt", ["scholarId", "nodeKey", "createdAt"])
    // Recent-serve dedupe (practiceSession): scan ALL of one scholar's recent
    // graded attempts over a bounded window to build the "seen-recently" set the
    // serve-time `preferUnseenCandidates` selector defers. `by_scholar_item_createdAt`
    // can't do this efficiently (itemId is between scholarId and createdAt), so
    // this per-scholar-by-time index is additive.
    .index("by_scholar_createdAt", ["scholarId", "createdAt"])
    // Per-(scholar, domain) history, newest first. Serves the teacher-only
    // `recentAttemptsForDomain` feed: a post-index domain filter would scan the
    // scholar's entire cross-domain log to fill each page (and any attempt in
    // any domain would invalidate every loaded page), so the domain lives in
    // the index. Legacy rows without `domain` fall outside every range.
    .index("by_scholar_domain_createdAt", ["scholarId", "domain", "createdAt"])
    .index("by_createdAt", ["createdAt"]),

  // ─── Reimagined closure headline cache (governed generation) ─────────
  // The growth-framed "closure line" that LEADS the practice done-screen and the
  // daily "Look what you did today" recap — see
  // review/practice/completion-messaging-plan.html. Same GOVERNED pattern as
  // masteryObservations: an LLM writes it from an already-redacted signal, we
  // store it, it is teacher-inspectable, and the UI renders it deterministically —
  // never a live model voice speaking to the child (the anti-parasocial rule).
  //
  // A pure per-(scholar, kind, signal) CACHE. Both surfaces render an instant
  // deterministic fallback (shared/closureLines.ts buildPracticeClosure /
  // buildDailyArc) and swap in this stored line when present, so no completion
  // screen ever blocks on a model call. Keyed by a stable hash of the redacted
  // signal (closureSignalHash) so an identical situation reuses the line instead
  // of regenerating. `signal` is the redacted JSON the model actually saw — skill
  // LABELS + a COARSE effort shape only, NEVER a raw score / streak / another
  // learner — kept for teacher review + eval.
  closureLines: defineTable({
    scholarId: v.id("users"),
    kind: v.union(v.literal("practice"), v.literal("daily")),
    signalHash: v.string(),
    headline: v.string(),
    signal: v.string(),
    model: v.string(),
    createdAt: v.number(),
  }).index("by_scholar_kind_hash", ["scholarId", "kind", "signalHash"]),

  // One frozen, print-ready "Special delivery" letter per scholar/day. The
  // letter stores only scholar-safe labels and bounded deterministic prompts;
  // raw transcripts, analyses, scores, concern flags, and hidden schedule
  // placements never cross this boundary.
  specialDeliveryLetters: defineTable({
    institutionId: v.id("institutions"),
    scholarId: v.id("users"),
    dayKey: v.string(),
    nextSchoolDayKey: v.string(),
    scholarName: v.string(),
    salutationName: v.string(),
    homework: v.array(
      v.object({
        title: v.string(),
        unitTitle: v.optional(v.string()),
        dueAt: v.optional(v.number()),
        instructions: v.optional(v.string()),
        teacherName: v.optional(v.string()),
      }),
    ),
    // Scholar-selected work and notes are distinct from teacher-assigned
    // homework throughout the delivery payload and printer renderer.
    takeHome: v.optional(
      v.array(
        v.object({
          kind: v.union(v.literal("chosen"), v.literal("note")),
          title: v.string(),
          detail: v.optional(v.string()),
        }),
      ),
    ),
    reflectionPrompts: v.array(v.string()),
    tomorrowClues: v.array(v.string()),
    factsHash: v.string(),
    copyVersion: v.string(),
    // Fingerprint of the exact deterministic letter body rendered for print.
    // Optional while existing frozen rows age out.
    contentFingerprint: v.optional(v.string()),
    preparedAt: v.number(),
    preparedBy: v.optional(v.id("users")),
    // ─── Optional daily surprise insert (see convex/specialDeliveryInsertActions.ts)
    //
    // A model-chosen, editorial-discretion insert: EITHER a piece of the
    // scholar's own same-day portfolio work OR a small generated "charm
    // sketch" image (a crisp black-ink editorial illustration made via the
    // SAME canonical Gemini image pipeline every other generative-art surface
    // uses — convex/lib/gemini.ts's geminiGenerateImage; see
    // convex/specialDeliveryInsertActions.ts) OR nothing. Frozen exactly once
    // per letter (see the `insert === undefined` guard in
    // specialDelivery.ts's freezeInsert) so a retry/refresh of the
    // deterministic letter body never re-rolls this choice or re-spends a
    // model call. `insertModel` + `insertPromptVersion` stamp which model and
    // prompt/schema version produced it, mirroring `copyVersion` for the
    // deterministic body. This is a charm layer, never a data channel: no
    // score, verdict, or classification is ever stored here, only the frozen
    // editorial output (a reference + a caption, and for a sketch, the exact
    // grounded image brief that was sent to the image model).
    insert: v.optional(
      v.union(
        v.object({ kind: v.literal("none") }),
        v.object({
          kind: v.literal("portfolio"),
          // The submitted deliverable this insert surfaces — kept for
          // traceability/audit alongside the frozen storageId below (which
          // is what rendering actually reads, so a later resubmission under
          // the same deliverable can never silently change what was frozen).
          deliverableId: v.id("deliverables"),
          storageId: v.id("_storage"),
          mime: v.union(v.literal("image/jpeg"), v.literal("image/png")),
          caption: v.string(),
        }),
        v.object({
          kind: v.literal("sketch"),
          storageId: v.id("_storage"),
          mime: v.union(v.literal("image/jpeg"), v.literal("image/png")),
          caption: v.string(),
          // The exact grounded image brief sent to the canonical image
          // model (wrapped in the fixed graphite-sketch style prompt) —
          // kept for traceability/audit, never re-sent on a later render.
          prompt: v.string(),
        }),
      ),
    ),
    // Set in the same transaction that creates/refreshes the letter, before
    // any provider call, so concurrent preparation paths cannot both spend on
    // the same optional insert.
    insertRequestedAt: v.optional(v.number()),
    insertModel: v.optional(v.string()),
    insertPromptVersion: v.optional(v.string()),
    // ─── Editorial reflection/clue provenance (see
    // convex/specialDeliveryEditorialActions.ts) ───────────────────────────
    //
    // `reflectionPrompts` (look-back) and `tomorrowClues` (tomorrow-clue) are
    // now written by the editorial model pass, not the deterministic body.
    // These stamp WHICH editorial prompt/schema version produced them (mirrors
    // `copyVersion` for the deterministic body) and, when a section came back
    // BLANK, the named `BlankReason` for it (no-candidate / model-declined /
    // failed-validation / no-self-generated-signal) — so a teacher surface can
    // tell an honest blank from a not-yet-run one. All optional: they are unset
    // until the editorial pass has run, and a printed section leaves its
    // *BlankReason field unset. `editorialRequestedAt` marks that the pass has
    // been scheduled/run so it fires exactly once per letter (mirrors
    // `insertRequestedAt`), never re-spending a model call on re-preparation.
    editorialRequestedAt: v.optional(v.number()),
    editorialVersion: v.optional(v.string()),
    lookBackBlankReason: v.optional(v.string()),
    clueBlankReason: v.optional(v.string()),
  })
    .index("by_scholar_day", ["scholarId", "dayKey"])
    .index("by_institution_day", ["institutionId", "dayKey"]),

  // Self-tuning digest output (Workstream 4 — the parameter-health layer of the
  // weekly practice digest; see review/practice/algo-decisions-2026-07.md
  // §"Workstream 4" and review/practice-algorithm-plan.html §7). One row per
  // 28-day evaluation window in which a MEMORY-MODEL parameter shows a
  // QUALIFYING signal (its 95% CI excludes the healthy band). It is written by
  // convex/practiceDigest.ts, NEVER by the scheduler, so this table can only ever
  // hold a *proposal* — the firewall the plan insists on: the loop tunes its own
  // recommendations, never itself, and a human reviews/merges every parameter
  // change (there is no path from a metric to a live constant without a person in
  // the middle).
  //
  //   • Only memory-model params ever land here (`HALFLIFE_GROWTH`,
  //     `HALFLIFE_LAPSE`, initial half-life). POLICY params (retention targets,
  //     grade-band width, FLUENT_REPS, caps) are curricular judgments — the
  //     digest may only *prompt discussion* about them and never writes a row.
  //   • A single qualifying window persists a row (so the NEXT window can confirm
  //     it); `evidence.consecutiveWindows` records the run length. Only once it
  //     reaches 2 (the two-consecutive-window gate) does the digest surface it as
  //     an actionable recommendation and fire the Layer-3 hook.
  //   • `evidence` is a JSON string (the structured window metrics + the
  //     consecutive-window trail) rather than a nested object, so the shape can
  //     evolve without a schema migration.
  //   • `status` starts "open"; a human sets "dismissed" (breaks the
  //     consecutive-window chain, so it stops re-surfacing) or "actioned" (the
  //     proposed constant shipped). Teacher/admin-read only — on the far side of
  //     the redaction boundary, never surfaced to a scholar or parent.
  practiceParamRecommendations: defineTable({
    windowEnd: v.number(),
    param: v.string(), // e.g. "HALFLIFE_GROWTH" (memory-model params only)
    currentValue: v.number(),
    proposedValue: v.number(),
    evidence: v.string(), // JSON: window metrics + consecutive-window trail
    status: v.union(
      v.literal("open"),
      v.literal("dismissed"),
      v.literal("actioned"),
    ),
  })
    .index("by_param", ["param"])
    .index("by_windowEnd", ["windowEnd"]),

  // VERIFIED practice items (the contextual layer on top of any deterministic
  // generators). Only candidates that passed a VERIFIER (math: the safe
  // arithmetic evaluator in convex/lib/practice/verify.ts — the model's solution
  // expression, safely evaluated, must equal its stated answer) are stored, so a
  // wrong item never reaches a child. `verifierKind` is the pluggable seam: the
  // grader dispatches on it, so other disciplines add their own verifier
  // (code-execution, unit-aware numeric, exact-text, …) WITHOUT touching the
  // core. The answer lives here server-side (never served to the client); items
  // are graded by id lookup. See convex/practiceGen.ts + sketches §5.
  practiceItems: defineTable({
    skillKey: v.string(),
    domain: v.string(),
    stem: v.string(),
    answerType: v.string(), // "integer" | "decimal" | "fraction" | "multipleChoice" | "expression" | "text" | "manipulative" | …
    answerCanonical: v.string(), // parsed + compared at grade time
    // The measurement unit this item must be answered IN, display form ("cm³",
    // "m²", "°") — the stored twin of a deterministic template's `answerUnit`
    // (lib/practice/templates.ts). Present ⇒ the value alone is an INCOMPLETE
    // answer: `buildStoredServable` resolves it through the shared unit registry
    // (`parseUnitKey`) into the verifier's `requiredUnit`, so "112" misses on an
    // item asking for "112 cm³", and echoes it on the prompt so the pad offers
    // the unit keys.
    //
    // Only a form the registry knows is ever written (the write sites
    // canonicalize through `parseUnitKey` → `formatUnit`), and only when the
    // STEM itself names the unit — a required unit a child was never asked for
    // would be a wrong-answer trap, not a stricter grade.
    //
    // WIDENING ONLY, no backfill: every pre-existing row has none and keeps
    // grading unit-free exactly as before, and an unrecognized value degrades to
    // the same unit-free grading rather than an unsatisfiable requirement.
    answerUnit: v.optional(v.string()),
    // Stored multiple-choice items carry their render-safe labels here; the
    // canonical answer remains the zero-based choice index above.
    choices: v.optional(v.array(v.string())),
    // The verifier that vetted (and re-grades) this item. Default/today:
    // "arithmetic". The extension point for non-math domains.
    verifierKind: v.optional(v.string()),
    // For a MANIPULATIVE item (answerType/verifierKind === "manipulative"): the
    // JSON-serialized `ManipulativeSpec` (lib/manipulative/types.ts). The client
    // renders it and submits the locked-in state; the grader re-runs the pure
    // `isSolved` on it server-side (lib/manipulative/grade.ts). Absent for every
    // other answerType — additive + optional, no migration.
    manipulativeSpec: v.optional(v.string()),
    // Backward-faded worked example (Renkl/Atkinson faded worked examples —
    // SPIKE; see convex/lib/practice/fadedSteps.ts). A multi-step procedure is
    // worked fully at first; as the scholar's fluency on `skillKey` grows,
    // steps fade from the END backward (last step first) until the item is a
    // bare problem, with a self-explanation prompt at the fade boundary.
    // `text` is the fully-worked step (server-only — see below); `blankText`
    // is what a FADED step shows instead (defaults to a generic placeholder
    // when absent). Additive + optional, no migration; absent on every item
    // that predates this field or doesn't opt in.
    //
    // ⚠️ Same discipline as `answerCanonical`: a faded step's `text` must NEVER
    // be sent to the client — only `applyFade`'s `revealed`/`faded` shapes
    // (lib/practice/fadedSteps.ts) cross the wire, and those never carry a
    // faded step's `text`.
    // `hintText` is the TIER-2 hint for the teaching moment (lib/practice/
    // fadedSteps.ts `deriveStepHint`): the same move, set up with its operands
    // but left unevaluated. Only meaningful on the FINAL step. Optional and
    // almost always absent — the server DERIVES it from the step's own text, so
    // it cannot drift; author it only when the final step's prose doesn't state
    // the move arithmetically (e.g. a decimal-point placement).
    workedSteps: v.optional(
      v.array(
        v.object({
          text: v.string(),
          blankText: v.optional(v.string()),
          hintText: v.optional(v.string()),
        }),
      ),
    ),
    // Display-only structured prompt visual. Unlike a manipulative, this never
    // changes answerType/verifierKind and submits no state; it only replaces
    // janky prompt text (e.g. baked-in dot glyphs) with a real visual.
    promptVisual: v.optional(promptVisualValidator),
    // ── Stretch tier (Beast-Academy-style deliberate difficulty) ─────────
    // Absent = core (the fluency rotation). "stretch" = a starred/insight item
    // on the SAME node — harder by requiring an idea, not more steps. Stretch
    // items are EXCLUDED from the ordinary serving rotation and offered only
    // as the opt-in "Go deeper" tail on already-fluent nodes. Grading rules
    // (practiceSkills.submitAnswer): a stretch MISS never touches the mastery
    // row (no half-life lapse, no rep change — misses here are expected and
    // must not dent the green claim); a stretch SUCCESS records a normal
    // practice rep AND writes depth evidence (a masteryObservations row,
    // evidenceType "stretch_success") — the scholar-earnable input to the
    // node-dial depth arc. Open string so future tiers need no migration.
    tier: v.optional(v.string()),
    // Optional link to the story bridge whose real-world situation this stretch
    // item applies: the edge is (this row's own skillKey) → storyToKey. Link
    // presence is the application facet; tier stays "stretch". No separate
    // from-key — skillKey already IS the story's near end (one canonical home).
    storyToKey: v.optional(v.string()),
    // Insight-technique taxonomy tag for a stretch item ("working_backward",
    // "casework", "invariant", "symmetry", "extremal", "multiple_paths", …).
    // Open string; used for generation prompts + per-node coverage audits.
    technique: v.optional(v.string()),
    // The Bloom conceptual level (0–5, same scale as
    // masteryObservations.masteryLevel) a solo success on this item evidences.
    // Absent defaults to 3 ("apply") at grade time. Only read for stretch items.
    bloomLevel: v.optional(v.number()),
    // DIALOGUE stretch item (answerType "dialogue" — the rubric'd-chat vessel,
    // lib/practice/dialogueStretch.ts): the judge's grading criteria.
    // ⚠️ SERVER-ONLY, same discipline as `answerCanonical` — never crosses the
    // serve wire (a served dialogue item carries only its stem). Keep each
    // rubric to 2–3 ESSENTIAL criteria; the pass bar is all-of-them.
    rubricCriteria: v.optional(v.array(v.string())),
    // The PLACEMENT WARMTH FLOOR reveal line (Tier 1c) — a short, warm strategy
    // one-liner GENERATED + VERIFIED at item-generation time (convex/practiceGen.ts
    // → lib/practice/revealLine.verifyRevealLine: the S8 operand-substitution ban
    // is enforced mechanically, so a line can only use the item's own numbers).
    // Shown reveal-only in the placement feedback moment on a miss / "I haven't
    // learned this yet" (the answer is already revealed there, so this is safe to
    // serve — unlike `workedSteps.text`). NEVER produced by a live LLM call at
    // serve time. Absent on items that predate this field / failed verification;
    // the serve path degrades to the deterministic Tier-2 floor.
    revealLine: v.optional(v.string()),
    source: v.string(), // "generated"
    model: v.optional(v.string()),
    verifiedAt: v.number(),
  })
    .index("by_skill", ["skillKey"])
    .index("by_skill_tier", ["skillKey", "tier"])
    .index("by_domain", ["domain"])
    .index("by_domain_verifierKind", ["domain", "verifierKind"]),

  // Resumable per-strand placement (the initial "how far in each strand is
  // this scholar?" probe). One row per (scholar, domain); it accumulates as
  // the scholar answers probes, so a placement can be paused and picked back
  // up. `frontierByStrand` records the current best-guess frontier node in
  // each strand — the seed the practice engine starts from once placement is
  // `complete`. Discipline-agnostic (keyed by `domain`), same as the rest of
  // the practice engine. See convex/lib/practice/placement.ts.
  practicePlacements: defineTable({
    scholarId: v.id("users"),
    domain: v.string(),
    status: v.string(), // "in_progress" | "complete"
    probesAnswered: v.number(),
    frontierByStrand: v.optional(
      v.array(v.object({ strand: v.string(), frontierKey: v.string() })),
    ),
    // ── placement v2 (server-authoritative one-item-at-a-time loop) ──
    // All ADDITIVE + optional: a legacy row (from before the v2 loop, or the
    // fixture path) simply has none set. `probeLog` is the authoritative
    // accumulated-outcomes record (the
    // ternary outcome per answered probe — it replaces the old client-held
    // `answers` transcript); the search bounds are RECONSTRUCTED from it +
    // `frontierByStrand` (resume floors) via `searchBounds`, so there is no
    // separate stored-bounds field to fall out of sync. `servedProbe` is the
    // probe currently in front of the scholar — persisted so a reload re-serves
    // the SAME item (same node + seed), not a fresh one.
    probeLog: v.optional(
      v.array(
        v.object({
          nodeKey: v.string(),
          strand: v.string(),
          outcome: v.string(), // "correct" | "incorrect" | "unknown"
          at: v.number(),
          answerRaw: v.optional(v.string()),
          // The served item id — the reveal-line builder and the manipulative
          // probe cap (`gen#` prefix) key off it server-side (never trusting
          // client-supplied item text). Additive optional: legacy entries lack it.
          itemId: v.optional(v.string()),
          // HISTORICAL: the tutor's short worked explanation for a MISS /
          // "haven't learned it yet" on this probe, cached by the retired
          // /placement-explain surface (replaced by the deterministic warmth-
          // floor `revealLine`). No writer remains; kept for existing rows and
          // teacher inspection. Never set for a `correct` outcome.
          explanation: v.optional(v.string()),
        }),
      ),
    ),
    servedProbe: v.optional(
      v.object({
        nodeKey: v.string(),
        strand: v.string(),
        itemId: v.string(),
        seed: v.number(),
        // ── U-3: the served probe's item KIND + optional stored-item ref ──
        // ADDITIVE + optional. Placement now serves the full item union: the
        // fast deterministic TEMPLATE (default) OR a curated MANIPULATIVE for a
        // probe node. Absent `kind` ⇒ a legacy/template probe (nodeKey + seed
        // regenerate it deterministically; `itemId` = "nodeKey#seed"). `kind:
        // "manipulative"` ⇒ a `practiceItems` row served as the probe — `ref`
        // is its id and `itemId` is "gen#<ref>". An in-flight row from the old
        // shape resolves as a template, so it never crashes on resume.
        kind: v.optional(v.string()),
        ref: v.optional(v.id("practiceItems")),
      }),
    ),
    updatedAt: v.number(),
  }).index("by_scholar_domain", ["scholarId", "domain"]),

  // Practice-derived error events (Wave C, "C3" — raise-the-ceiling plan §7).
  // One append-only row per CLASSIFIED wrong answer in the drill: the
  // buggy-algorithm pattern (Ashlock literature) the classifier
  // (convex/lib/practice/errorPatterns.ts) recognised at grade time. This is
  // the OBSERVER-channel signal that feeds the teacher-only misconception flag
  // on a node — it is NOT a write to the teacher's authored record
  // (masteryObservations), and unlike that table it needs no sessionId (practice
  // has no session entity). A flag opens when ≥3 of the SAME pattern land inside
  // a rolling 14-day window (convex/lib/practice/errorFlags.ts) and auto-clears
  // by construction once the errors stop (old rows age past the window). Rows
  // are teacher-only on read; never surfaced to the scholar. `nodeKey` == the
  // knowledgeNodes join key (a.k.a. skillKey on the per-scholar tables).
  practiceErrorEvents: defineTable({
    scholarId: v.id("users"),
    nodeKey: v.string(),
    domain: v.string(),
    pattern: v.string(), // an ErrorPattern (see errorPatterns.ts)
    itemId: v.string(),
    createdAt: v.number(),
  })
    .index("by_scholar", ["scholarId"])
    .index("by_scholar_domain", ["scholarId", "domain"])
    .index("by_scholar_domain_createdAt", ["scholarId", "domain", "createdAt"])
    .index("by_scholar_node", ["scholarId", "nodeKey"])
    .index("by_item", ["itemId"]),

  // Scholar practice-choice events — an append-only OBSERVATION record of the
  // bounded frontier choice a scholar made before or between practice blocks.
  // This is a teacher/observer-facing interest signal, never a scholar-facing
  // history or score. `clientPickId` makes retries idempotent per scholar;
  // candidateSkillKeys preserves the offered set when the caller has it, while
  // playlistDomains records the mixed-domain context around the pick.
  practiceChoiceEvents: defineTable({
    scholarId: v.id("users"),
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
    createdAt: v.number(),
  })
    .index("by_scholar_createdAt", ["scholarId", "createdAt"])
    .index("by_scholar_domain_strand", ["scholarId", "domain", "strand"]),

  // Tune-up checkpoint (§4B) — an offer-based, untimed, UNSCORED mixed-topic
  // retention check that audits fluent skills, especially INFERRED credit
  // (placement / valve / re-probe) never independently demonstrated. A row is
  // created on ACCEPT (never on offer) and patched on completion; it feeds the
  // future weekly digest + instruments. Teacher/admin-only on read (a scholar
  // never sees their tune-up history — no score, no streak, no nag).
  practiceTuneups: defineTable({
    scholarId: v.id("users"),
    domain: v.string(),
    skillKeys: v.array(v.string()),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    total: v.number(),
    correctCount: v.optional(v.number()),
  }).index("by_scholar", ["scholarId"]),

  // Predict-then-Check calibration (judgment-of-learning). One append-only row
  // per PREDICTED practice attempt: the kid's optional pre-answer confidence
  // (`confidence` — the numeric value the `ConfidenceLevel` pick maps to, see
  // convex/lib/practice/calibration.ts) paired with the graded `correct`. This
  // is a METACOGNITIVE signal (are they calibrated to what they actually know?),
  // deliberately SEPARATE from mastery/spaced-repetition — a prediction never
  // touches practiceMastery. Teacher-facing analysis (calibrationForScholar);
  // the scholar sees only gentle per-item mismatch reveals, never a running
  // number. Absent whenever the kid skipped the chip (the mechanic is optional).
  // `skillKey` == the knowledgeNodes join key; `itemId` is set only when the
  // graded item was a stored practiceItems row (template items have no id).
  practicePredictions: defineTable({
    scholarId: v.id("users"),
    skillKey: v.string(),
    itemId: v.optional(v.id("practiceItems")),
    confidence: v.number(),
    correct: v.boolean(),
    source: v.string(), // "practice"
    createdAt: v.number(),
  })
    .index("by_scholar", ["scholarId"])
    .index("by_scholar_skill", ["scholarId", "skillKey"]),

  // ─── Observer Output Tables ────────────────────────────────────────
  masteryObservations: defineTable({
    scholarId: v.id("users"),
    conceptLabel: v.string(),
    domain: v.string(),
    // Logical ref to knowledgeNodes.nodeKey, resolved conservatively at write
    // time. Optional because observer-authored concepts do not always map
    // confidently onto a canonical node.
    nodeKey: v.optional(v.string()),
    observedAt: v.number(),
    // Optional (widened 2026-07): a tutor session for ordinary observations, but
    // ABSENT for Workshop "reflection" evidence (evidenceType === "reflection"),
    // which has no session — it comes from a metaChat instead (metaChatId below).
    // A session-less row simply never matches a per-session read (recapForSession),
    // which is correct: a reflection isn't part of any one session's recap.
    sessionId: v.optional(v.id("sessions")),
    // Set ONLY on Workshop reflection evidence — the metaChats thread the
    // meta-observer distilled it from (the counterpart to sessionId for the
    // session-less case). Absent for every session-sourced observation.
    metaChatId: v.optional(v.id("metaChats")),
    // Set ONLY on evidence read straight off a SCANNED work sample that never
    // materialized into a session/deliverable — a worksheet filed to a scholar
    // with no activity tag (convex/portfolioAssess.ts). Third session-less
    // anchor, alongside metaChatId: the scan IS the evidence, so the row points
    // at the portfolio item instead of a transcript.
    portfolioItemId: v.optional(v.id("portfolioItems")),
    // Set ONLY on observations distilled from a completed GAME session's
    // server-derived digest (convex/gameObserver.ts). FOURTH session-less
    // anchor, alongside metaChatId and portfolioItemId: the digest IS the
    // evidence — rebuilt deterministically from an append-only event log — so
    // the row points at the game session instead of a transcript. The SR legs
    // stay absolute: a game never writes practiceAttempts/practiceMastery, and
    // this portrait-layer row is the ONLY way a game's evidence reaches the
    // learning record (via the observer, never green fluency).
    gameSessionId: v.optional(v.id("gameSessions")),
    transcriptExcerpt: v.string(),
    excerptMessageIds: v.optional(v.array(v.id("messages"))),
    masteryLevel: v.number(),
    confidenceScore: v.number(),
    evidenceSummary: v.string(),
    // Open string (not a v.union), so new kinds need no schema change. Values in
    // use: the main observer's "direct_demonstration" | "indirect_inference" |
    // "misconception_signal" | "interest_signal", plus "reflection" — a
    // self-reported metacognition/mastery statement the Workshop meta-observer
    // distilled (paired with attemptContext "reflection" + metaChatId, no session).
    evidenceType: v.string(),
    attemptContext: v.string(),
    studentInitiated: v.boolean(),
    standardIds: v.optional(v.array(v.id("standards"))),
    supersedesId: v.optional(v.id("masteryObservations")),
    isSuperseded: v.boolean(),
    // Set when this row was superseded by the write-path dedup BACKSTOP
    // (a lexical near-duplicate the model didn't collapse itself) rather than by
    // a model-directed supersession — lets a teacher/admin audit what the net
    // merged. Additive + optional: absence == "not auto-superseded".
    autoSuperseded: v.optional(v.boolean()),
    // ─── Misconception lifecycle ───────────────────────────────────────
    // Only meaningful when evidenceType === "misconception_signal". A
    // misconception is "open" (needs un-teaching) until a teacher marks it
    // "addressed". Absence of the field == "open", so pre-existing rows and
    // freshly-observed misconceptions default to open with no migration.
    // Stored on the row so supersession reopens it naturally: if the observer
    // re-observes the same misconception in a later session, that inserts a
    // fresh (open) row and supersedes the addressed one.
    misconceptionStatus: v.optional(
      v.union(v.literal("open"), v.literal("addressed")),
    ),
    misconceptionAddressedAt: v.optional(v.number()),
    misconceptionAddressedBy: v.optional(v.id("users")),
    misconceptionNote: v.optional(v.string()),
    // ─── Automaticity / fluency (per-node depth dimension) ──────────────
    // 1 = effortful, 2 = fluent, 3 = automatic. Shown ONLY where we have a real
    // fluency signal (an external practice site's speed/spaced-rep, a teacher's "knows it but
    // slow", or tutor response-latency) — never inferred from a single chat.
    // Absent = no fluency signal yet (the common case). See the automaticity
    // section in review/learning-lenses-plan.md.
    fluencyLevel: v.optional(v.number()),
    fluencySource: v.optional(v.string()),
    // When the fluency reading was taken — automaticity decays without
    // practice, so a fluency signal is timestamped and can age out (unlike
    // "mastered", which the schema doesn't assume is monotonic either).
    fluencyObservedAt: v.optional(v.number()),
    // ─── PCM dimension tag (assessment-and-goals §4) ────────────────────
    // Optional observer tag placing this evidence on one of Carl's four PCM
    // dimensions, populated ONLY where the observer judged it clear-cut.
    // Absent = untagged (the common case) — the binder still counts the row,
    // it just doesn't attribute it to a dimension. Never a kid-facing grade.
    pcmDimension: v.optional(pcmDimensionValidator),
  })
    .index("by_scholar", ["scholarId"])
    .index("by_scholar_domain", ["scholarId", "domain"])
    .index("by_scholar_node", ["scholarId", "nodeKey"])
    .index("by_scholar_current", ["scholarId", "isSuperseded"])
    .index("by_session", ["sessionId"])
    // Teardown + re-run dedupe for scan-anchored rows: "what did THIS scan
    // produce?" (portfolioAssess re-runs, item deletion, un-attribution).
    .index("by_portfolioItem", ["portfolioItemId"])
    // Dedupe for game-anchored rows: "has THIS game session already been
    // observed?" — the gameObserver pass skips a session that already produced
    // a row, so a re-schedule/retry never double-writes the portrait.
    .index("by_gameSession", ["gameSessionId"])
    // Day-scoped reads (keyMoments.collectScholarDayMoments, the Special
    // Delivery generator) range on `observedAt` — the row's OWN timestamp,
    // which is not always `_creationTime` (e.g. late-filed portfolio scans).
    // Without this a per-scholar-day read is an unbounded `by_scholar` scan
    // over a scholar's entire lifetime of observations.
    .index("by_scholar_observedAt", ["scholarId", "observedAt"]),

  teacherMasteryOverrides: defineTable({
    scholarId: v.id("users"),
    observationId: v.id("masteryObservations"),
    teacherId: v.id("users"),
    masteryLevel: v.number(),
    notes: v.string(),
  })
    .index("by_scholar", ["scholarId"])
    .index("by_observation", ["observationId"]),

  // ─── Granule evidence (unit-anchored mastery) ───────────────────────
  // One row per observer attribution of a conversation to one of the
  // unit's EQs/EUs ("granules"). The complement of masteryObservations:
  // mastery is bottom-up (whatever concepts the observer noticed),
  // granule evidence is top-down (did the kid engage what the unit is
  // FOR). Status is always DERIVED, never stored — green if any
  // "demonstrated" row, yellow if only "probed" rows, gray if no rows
  // at all. Gray is a curriculum signal (Rabbithole never probed it),
  // not a kid deficit. No teacher-override table on purpose: the grid
  // reports what Rabbithole observed, period — a tool for the teacher,
  // not a record needing adjudication.
  granuleEvidence: defineTable({
    scholarId: v.id("users"),
    unitId: v.id("units"),
    // → units.essentialQuestions[].key / enduringUnderstandings[].key.
    // A key no longer present on the unit (granule deleted or text
    // edited through a non-key-aware path) simply stops rendering.
    granuleKey: v.string(),
    // Execution scoping — re-running a unit with a new cohort starts
    // gray. Optional: unit-anchored projects without an assignment
    // (e.g. independent exploration of the unit) still accrue evidence.
    assignmentId: v.optional(v.id("assignments")),
    sessionId: v.id("sessions"),
    observedAt: v.number(),
    // demonstrated = the scholar showed the understanding (own words,
    // application, transfer). probed = the conversation engaged the
    // granule but the scholar didn't (yet) demonstrate it.
    outcome: v.union(v.literal("demonstrated"), v.literal("probed")),
    transcriptExcerpt: v.string(),
    evidenceSummary: v.string(),
    // Checklist-for-Rabbithole: highest Bloom level the conversation
    // engaged this granule at ("remember" … "create"). Tutor-facing
    // scaffolding hint, never a kid-facing grade.
    bloomLevel: v.optional(v.string()),
    // When the observer simultaneously logged a misconception touching
    // this granule, link it so the grid cell can badge it.
    misconceptionObservationId: v.optional(v.id("masteryObservations")),
    // Stamped when the project's activity is a conversation recipe —
    // powers the baseline ↔ exit pre/post comparison.
    phase: v.optional(v.union(v.literal("baseline"), v.literal("exit"))),
  })
    .index("by_scholar_unit", ["scholarId", "unitId"])
    .index("by_scholar_assignment", ["scholarId", "assignmentId"])
    .index("by_assignment", ["assignmentId"])
    .index("by_session", ["sessionId"]),

  // ─── Teach-backs (scholar-as-teacher "explain it back" viva) ───────
  // The Feynman inversion: instead of the tutor explaining, the CHILD
  // teaches a concept to the tutor (who plays a deliberately naive
  // learner). A separate grading pass scores the EXPLANATION —
  // completeness, causal chain, example use, handling of naive probes.
  // The `rubric` is TEACHER-ONLY (same redaction contract as tune-ups /
  // observer scores): it is ABSENT — never null — from any scholar/parent
  // read. The kid never sees a grade; the reward is the act of teaching.
  // Feature-gated (TEACH_BACK_ENABLED); OFF for live until the tutor-prompt
  // change passes owner review, mirroring problems-in-chat.
  teachBacks: defineTable({
    sessionId: v.id("sessions"),
    scholarId: v.id("users"),
    // What the scholar taught, in plain words (the tutor's tool arg).
    conceptLabel: v.string(),
    // Optional knowledgeNodes.nodeKey link when the concept maps to a graph
    // node (lets the mastery observation resolve a domain); absent otherwise.
    nodeKey: v.optional(v.string()),
    // active until the async grading pass writes a rubric; then graded. A
    // grading FAILURE leaves it active on purpose (the record survives, we can
    // re-grade) — see teachBackGrading.gradeTeachBack.
    status: v.union(v.literal("active"), v.literal("graded")),
    // The assistant message live when the mode opened — grading pulls the
    // transcript range from here forward as the scholar's explanation.
    startedAtMessageId: v.optional(v.id("messages")),
    // TEACHER-ONLY score of the explanation. Four 0–3 dimensions + a short
    // teacher summary. Absent while active / if grading failed.
    rubric: v.optional(
      v.object({
        completeness: v.number(),
        causalChain: v.number(),
        example: v.number(),
        handledProbes: v.number(),
        summary: v.string(),
      }),
    ),
    // Teacher acknowledged/read this teach-back (dashboard toggle).
    teacherReviewed: v.optional(v.boolean()),
    createdAt: v.number(),
    gradedAt: v.optional(v.number()),
  })
    .index("by_session", ["sessionId"])
    .index("by_scholar", ["scholarId"]),

  // ─── Seeds (replaces suggestedTopics) ──────────────────────────────
  seeds: defineTable({
    scholarId: v.id("users"),
    origin: seedOriginValidator,
    status: seedStatusValidator,
    dismissedReason: v.optional(v.string()),
    topic: v.string(),
    domain: v.optional(v.string()),
    // "frontier" | "depth_probe" | "extension" | "cross_domain" | "leap" …
    // "leap" = a transdisciplinary bridge from the Interpretive constellation
    // (a far star — e.g. "fairness" → vampire-bat reciprocity).
    suggestionType: seedSuggestionTypeValidator,
    // TWO descriptions, by audience (DEC — the redaction boundary):
    //   `rationale`         = TEACHER-facing diagnostic. May name the scholar,
    //                         the gap, the misconception ("Oliver couldn't
    //                         explain the pressure mechanism — the key gap").
    //   `scholarInvitation` = SCHOLAR-facing 2nd-person hook the kid actually
    //                         reads on their sky ("Why does a kettle boil
    //                         faster up a mountain?"). Never names them, never
    //                         says "gap"/"misconception". Optional for back-
    //                         compat: scholar surfaces fall back to `rationale`
    //                         when absent (older observer seeds, teacher seeds).
    rationale: v.string(),
    scholarInvitation: v.optional(v.string()),
    approachHint: v.optional(v.string()),
    connectionTo: v.optional(v.string()),
    sessionId: v.optional(v.id("sessions")),
    // Terminal lifecycle timestamp: the scholar explored this seed's spawned
    // session/unit and finished it. Optional because existing/live seeds start
    // pending/active and are stamped only on completion.
    completedAt: v.optional(v.number()),
    teacherId: v.optional(v.id("users")),
    currentBloomsLevel: v.optional(v.number()),
    targetBloomsLevel: v.optional(v.number()),
    // Which lens proposed this (Interpretive constellation generator stamps
    // "interpretive"). Provenance for the star-chart + evals.
    sourceLens: v.optional(v.string()),
    // How far the leap reaches across disciplines (0 = next-step, 1 = near
    // neighbour, 2 = far star) — drives the star's distance from centre.
    reach: v.optional(v.number()),
    // A STRUCTURED destination: the star points at a real curriculum unit
    // (a teacher/bot offer with lessons, activities, a badge) rather than a
    // bare proto-activity topic the tutor ad-libs. When set, opting in
    // (createFromSeed) starts that unit instead of an anchorless chat, and
    // the sky badges the star with a "guided path" marker.
    unitId: v.optional(v.id("units")),
    // Seed vs Destination intent (see review/seeds-destinations-design.html). A
    // `seed` is a curiosity invitation (a thread to pull); a `destination` is a
    // deliberate target the teacher elevates ("head here"). Optional for back-
    // compat: a missing value reads as `seed` (or `destination` when `unitId`
    // is present — a structured guided path is inherently a destination).
    // A cross-domain PRACTICE on-ramp target: a practice-drill domain slug
    // (convex/lib/practice/domains.ts) this seed's Sky "practice this"
    // invitation routes to, overriding the broad display-domain→drill
    // allowlist. Set on on-ramp seeds (e.g. the fractions on-ramp →
    // "fraction-arithmetic"); absent for ordinary seeds (which fall back to the
    // allowlist, or show no invitation).
    practiceDomain: v.optional(v.string()),
    intent: v.optional(v.union(v.literal("seed"), v.literal("destination"))),
    // The two knowledgeNodeEdges graph keys a story-star souvenir was minted
    // from (present only when origin === "story" — minted automatically the
    // moment a story card is OFFERED, by practiceMoments.recordMomentOffered
    // via convex/lib/seeds.ts's plantStorySeed, so a story survives whatever
    // the scholar does with the card). Logical references, the
    // same convention as momentEvents.fromKey/toKey: the story text itself
    // stays canonical on the edge, only copied here (into topic/
    // scholarInvitation/connectionTo) at mint time.
    storyFromKey: v.optional(v.string()),
    storyToKey: v.optional(v.string()),
  })
    .index("by_scholar_status", ["scholarId", "status"])
    .index("by_scholar_origin", ["scholarId", "origin"])
    // Narrow the roster-wide Interpretive surfaces (Class Galaxy, Trophy
    // Case) to just the "leap" stars — the interpretive-lens seeds OR
    // those explicitly typed "leap" — instead of scanning every seed in
    // the school. See lib/leapSeeds.ts (collectInterpretiveStars).
    .index("by_sourceLens", ["sourceLens"])
    .index("by_suggestionType", ["suggestionType"])
    // Idempotent "one story-star per (scholar, edge)" lookup for
    // plantStorySeed — cheaper than scanning by_scholar_origin + filtering.
    .index("by_scholar_story_edge", ["scholarId", "storyFromKey", "storyToKey"]),

  // ─── Session Signals (learner character) ───────────────────────────
  sessionSignals: defineTable({
    scholarId: v.id("users"),
    sessionId: v.id("sessions"),
    signalType: v.string(),
    description: v.string(),
    intensity: v.string(),
    transcriptExcerpt: v.optional(v.string()),
    // Optional PCM tag (assessment-and-goals §4) — most identity-dimension
    // evidence surfaces as a signal ("chose the harder problem"). Absent =
    // untagged.
    pcmDimension: v.optional(pcmDimensionValidator),
  })
    .index("by_scholar", ["scholarId"])
    .index("by_scholar_type", ["scholarId", "signalType"])
    .index("by_session", ["sessionId"]),

  // ─── Cross-Domain Connections ──────────────────────────────────────
  crossDomainConnections: defineTable({
    scholarId: v.id("users"),
    domains: v.array(v.string()),
    conceptLabels: v.array(v.string()),
    description: v.string(),
    sessionId: v.id("sessions"),
    studentInitiated: v.boolean(),
    transcriptExcerpt: v.optional(v.string()),
    // Optional PCM tag (assessment-and-goals §4). A connection is almost
    // always "connections"-dimension evidence, but the observer may tag a
    // prompted-vs-unprompted nuance; absent = untagged.
    pcmDimension: v.optional(pcmDimensionValidator),
  })
    .index("by_scholar", ["scholarId"])
    .index("by_session", ["sessionId"]),

  // ─── Golden-set labeling (Opus-judge calibration) ──────────────────────
  //
  // Human raters (teachers, at a group meeting) score real tutor turns on the
  // SAME rubric dimensions the Opus quality-judge uses (single-sourced in
  // shared/tutorQualityRubric.ts). Comparing human scores against the judge's
  // on identical definitions is how we calibrate the judge — see
  // review/continuous-eval-plan.html §7 and convex/qualityLabeling.ts. Backing
  // store for the /teacher/labeling surface (web-only staff tool).

  // The curated list of sessions to label — Andy builds this in ~2 minutes from
  // recent real (non-test-drive) sessions before the meeting. `order` drives the
  // display order; `addedById` records who queued it. No scholar identity here.
  qualityLabelQueue: defineTable({
    sessionId: v.id("sessions"),
    addedById: v.id("users"),
    order: v.number(),
    note: v.optional(v.string()),
  })
    .index("by_session", ["sessionId"])
    .index("by_order", ["order"]),

  // One rater's blind score for ONE tutor turn (message). `dims` maps a rubric
  // dimension key (see shared/tutorQualityRubric.ts) → 1..5; only the dims this
  // rater actually scored appear. `cantJudge` lists dims the rater explicitly
  // marked "can't judge" (distinct from simply not scoring). Upsert key is
  // (raterId, messageId) — one row per rater per turn. Raters never see each
  // other's rows while labeling (blind); they surface only in agreementReport.
  qualityGoldLabels: defineTable({
    raterId: v.id("users"),
    sessionId: v.id("sessions"),
    messageId: v.id("messages"),
    // dimKey -> 1..5 (higher = better, matching the judge rubric).
    dims: v.record(v.string(), v.number()),
    note: v.optional(v.string()),
    cantJudge: v.optional(v.array(v.string())),
  })
    .index("by_session", ["sessionId"])
    .index("by_rater", ["raterId"])
    .index("by_rater_and_session", ["raterId", "sessionId"])
    // Upsert key: exactly one score row per rater per message.
    .index("by_rater_and_message", ["raterId", "messageId"]),

  // One rater's whole-transcript verdict for a session: an optional overall
  // 1..5 + note. Upsert key is (raterId, sessionId) — one row per rater per
  // transcript. Also blind (surfaces only in agreementReport).
  qualityGoldTranscriptLabels: defineTable({
    raterId: v.id("users"),
    sessionId: v.id("sessions"),
    overall: v.optional(v.number()),
    note: v.optional(v.string()),
  })
    .index("by_session", ["sessionId"])
    .index("by_rater", ["raterId"])
    // Upsert key: exactly one transcript row per rater per session.
    .index("by_rater_and_session", ["raterId", "sessionId"]),

  // ─── Nightly Quality-Pulse samples (the persisted judged signal) ──────
  //
  // One row per session judged by the nightly tutor-quality judge
  // (evals/tutor-quality/nightly.ts, review/continuous-eval-plan.html §4). This
  // is the DURABLE half the CI artifact isn't: it lets the Quality Pulse trend
  // scores over time, dedup so the same session isn't re-judged every night
  // (upsert by sessionId, skip when `turnsJudged` is unchanged), and key every
  // score to the `promptVersion` it was produced under + the judge engine/model
  // that produced it (so a Copilot-engine run never silently conflates with an
  // Anthropic-API one).
  //
  // GRADES THE TUTOR, NEVER THE KID: there is deliberately NO scholarId or any
  // other learner-identity field here — the grain is (session, promptVersion),
  // so nobody can build a learner-vs-learner comparison from this table. Per-kid
  // signal stays in the scholar's own Portrait. `scores` is v.any() (the rubric
  // dimension means + summaryVerdict) so a rubric change is not a schema
  // migration.
  //
  // THREE SURFACES (widened 2026-07): the nightly pipeline scores the
  // streaming tutor (`surface: "tutor"`, keyed by `sessionId`) AND the ephemeral
  // practice "Talk it through" handoff (`surface: "handoff"`, keyed by
  // `handoffId` → handoffTranscripts), plus baked QUEST designs
  // (`surface: "questDesign"`, keyed by `unitId`). This is a pure WIDENING —
  // pre-existing rows carry a `sessionId` and no `surface`, so `surface` absent
  // is read as "tutor" everywhere. No backfill needed. Exactly one surface key
  // is set per row.
  qualityPulseSamples: defineTable({
    // Present on tutor-surface rows (optional so handoff rows can omit it).
    sessionId: v.optional(v.id("sessions")),
    // Present on handoff-surface rows only.
    handoffId: v.optional(v.id("handoffTranscripts")),
    // Present on quest-design rows only.
    unitId: v.optional(v.id("units")),
    // Which surface this score grades. Absent (legacy rows) === "tutor".
    surface: v.optional(
      v.union(
        v.literal("tutor"),
        v.literal("handoff"),
        v.literal("questDesign"),
      ),
    ),
    // Singular only when every judged assistant message has the same runtime
    // version. The array + coverage flag preserve mixed/legacy transcript truth.
    promptVersion: v.optional(v.string()),
    promptVersions: v.optional(v.array(v.string())),
    hasUnversionedAssistantMessages: v.optional(v.boolean()),
    judgeEngine: v.string(), // "anthropic" | "copilot"
    judgeModel: v.string(), // provenance, e.g. "copilot-cli:claude-opus-4-8"
    scores: v.any(), // { dimMeans: {...}, summaryVerdict: number }
    // Qualitative evidence for the teacher-facing weekly digest's narrative pass
    // (best/worst moment + the transcript's topProblems). Numbers-only stays the
    // CI-artifact contract; this richer field is Convex-ONLY (staff trust
    // boundary, same as the teacher dashboard). Grades the tutor, never the kid:
    // no scholar identity — `tutorExcerpt` is the TUTOR's text only.
    // Tutor/handoff shape: { topProblems: string[], bestTurn: TurnEvidence | null,
    //          worstTurn: TurnEvidence | null } where TurnEvidence =
    //          { turnIndex, dim, score, note, tutorExcerpt }.
    // QUEST-design shape: { designDiagnosis: string }.
    evidence: v.optional(v.any()),
    // Tutor/handoff assistant-turn count; QUEST-design activity count.
    turnsJudged: v.number(),
    flagged: v.boolean(), // did the observer flag a concern on this session?
    judgedAt: v.number(),
  })
    // Upsert + dedup key for the tutor surface: at most one live sample per session.
    .index("by_session", ["sessionId"])
    // Upsert + dedup key for the handoff surface: at most one live sample per handoff.
    .index("by_handoff", ["handoffId"])
    // Upsert + dedup key for QUEST designs: at most one live sample per unit.
    .index("by_unit", ["unitId"])
    // Trend/rollup reads walk samples in judged-time order.
    .index("by_judgedAt", ["judgedAt"]),

  // ─── Practice "Talk it through" handoff transcripts (judged retrospectively) ──
  //
  // The practice handoff (⑫; convex/lib/practice/handoff.ts + the
  // `/practice-handoff` route) is a warm, UNGRADED scratch chat that opens after
  // a scholar misses the same item twice. Fade/mastery integrity is enforced in
  // ONE place — the practice grading engine — so the handoff tutor is freed from
  // any runtime answer-leak gate. The agreed safety net for "is the handoff tutor
  // giving away answers too readily?" is RETROSPECTIVE weekly quality evals over
  // real transcripts, exactly like the streaming tutor's. But handoffs are
  // ephemeral (2–4 exchanges, nothing persisted) and never reach the `sessions`
  // sampler, so they were never judged. This table is the durable capture.
  //
  // PRIVACY: deliberately NO scholarId. The `/practice-handoff` route binds no
  // scholar (the item is a deterministic template item, not per-scholar data), so
  // there is no learner identity to store. The upsert key is `dedupKey` — a
  // server-derived hash(callerUserId + itemId + first user message) — so the
  // growing transcript is captured into ONE row across a session's turns without
  // ever storing the userId. The stem/wrongAnswers are a math problem + numeric
  // guesses (no PII). Judged by the same nightly rubric as `sessions`; scored
  // rows land in `qualityPulseSamples` with `surface: "handoff"`.
  handoffTranscripts: defineTable({
    // Stable natural key for the per-turn UPSERT: a hash of
    // callerUserId + itemId + first user message (see handoffDedupKey). NOT the
    // userId itself — a dedup key, not a security token or a learner identifier.
    dedupKey: v.string(),
    itemId: v.string(), // the practice item id (`skillKey#seed[#form]`)
    skillKey: v.string(), // parsed from itemId, for at-a-glance grouping
    stem: v.string(), // the problem stem the scholar saw (no PII)
    wrongAnswers: v.array(v.string()), // the scholar's misses, oldest first
    promptVersion: v.string(), // HANDOFF_PROMPT_VERSION at capture time
    transcript: v.array(
      v.object({
        role: v.union(v.literal("user"), v.literal("assistant")),
        content: v.string(),
      }),
    ),
    turns: v.number(), // assistant turns captured so far (== assistant msg count)
    createdAt: v.number(), // first-capture time (stable across upserts)
  })
    // Upsert + dedup key: at most one live row per (caller, item, opening move).
    .index("by_dedupKey", ["dedupKey"])
    // The judge sampler walks recent handoffs in creation-time order.
    .index("by_createdAt", ["createdAt"]),

  // ─── Shared short-form tutor transcripts (judged retrospectively) ───────────
  //
  // Durable, anonymous capture for short tutor surfaces that do not belong in a
  // full `sessions` transcript. `/story-open` is the first writer: it persists the
  // wonder-opening conversation behind a world-connection story so the tutor can
  // be judged later for grounding, wait-time, and learner agency. The existing
  // `handoffTranscripts` table has the same lifecycle and privacy contract; rather
  // than add another field-for-field sibling, new short-form surfaces consolidate
  // here behind `surface` + a surface-specific `anchor`.
  //
  // `surface: "handoff"` and its anchor variant are RESERVED for the separate
  // follow-up migration of `handoffTranscripts`; stretchDialogue is the first
  // active second surface. More tutor surfaces join by adding a literal + anchor
  // variant instead of creating another sibling table.
  //
  // REDACTION: deliberately NO scholarId. A surface may use a scholar id to
  // authorize its request, but identity never enters this row. `dedupKey` is a
  // server-derived hash that lets a growing conversation UPSERT into ONE row; only
  // the hash is stored, never the caller user id. Anchors contain only the
  // curriculum/problem context needed by the retrospective tutor judge.
  tutorTranscripts: defineTable({
    // The surface is indexed explicitly so each judge can scan only its own
    // transcript family. "handoff" is reserved for the follow-up migration above.
    surface: v.union(v.literal("storyOpen"), v.literal("handoff"), v.literal("stretchDialogue")),
    // Keep surface-specific context out of a widening bag of optional fields. The
    // discriminator makes each row's judging anchor complete and reviewable.
    anchor: v.union(
      v.object({
        kind: v.literal("storyOpen"),
        fromKey: v.string(), // skill node the story bridges FROM
        toKey: v.string(), // world node the story bridges TO
        hook: v.string(), // card hook the scholar saw (verified curriculum text)
      }),
      v.object({
        // Reserved shape only: handoffTranscripts remains the source of truth
        // until its separate post-pilot migration.
        kind: v.literal("handoff"),
        itemId: v.string(),
        skillKey: v.string(),
        stem: v.string(),
        wrongAnswers: v.array(v.string()),
      }),
      v.object({
        kind: v.literal("stretchDialogue"),
        itemId: v.string(),
        skillKey: v.string(),
        stem: v.string(),
      }),
    ),
    // Stable natural key for the per-turn UPSERT. It is a deduplication key, not
    // a security token or learner identifier.
    dedupKey: v.string(),
    promptVersion: v.string(), // the surface's prompt version at capture time
    transcript: v.array(
      v.object({
        role: v.union(v.literal("user"), v.literal("assistant")),
        content: v.string(),
      }),
    ),
    turns: v.number(), // assistant turns captured so far (== assistant msg count)
    createdAt: v.number(), // first-capture time (stable across upserts)
    // Set only after a stretch-dialogue judge consumes this server-held log.
    // An active log has no completedAt and can be appended; a completed one
    // cannot be graded again.
    completedAt: v.optional(v.number()),
  })
    // Upsert + dedup key: at most one live row per anonymous conversation.
    .index("by_dedupKey", ["dedupKey"])
    // Each surface's judge walks only its recent transcripts in creation order.
    .index("by_surface_createdAt", ["surface", "createdAt"]),

  // ─── Class Galaxy convergences (group Interpretive lens) ───────────
  //
  // (Removed 2026-06.) The Class Galaxy is now a LENS of the shared Concept
  // Atlas — concepts.classGalaxy computes cohort heat (how many scholars
  // circle each concept) deterministically from demonstrated mastery, so no
  // cached LLM-convergence table is needed. The old `galaxyConvergences`
  // table + galaxy.ts/galaxyConvergence.ts were deleted.

  // DEPRECATED (anti-parasocial, 2026-06): personas made the tutor "become" a
  // character. Kept intact (table, rows, indexes) so existing data + history
  // survive and re-enabling is reversible, but the tutor no longer injects a
  // persona, fresh seeds don't wire one, and the building block is hidden from
  // active surfaces. See TODO.html ("Reimagine personas").
  personas: defineTable({
    teacherId: v.id("users"),
    title: v.string(),
    slug: v.optional(v.string()),
    emoji: v.string(),
    description: v.optional(v.string()),
    systemPrompt: v.optional(v.string()),
    isActive: v.boolean(),
  })
    .index("by_teacher", ["teacherId"])
    .index("by_active", ["isActive"])
    .index("by_slug", ["slug"]),

  perspectives: defineTable({
    teacherId: v.id("users"),
    title: v.string(),
    slug: v.optional(v.string()),
    icon: v.optional(v.string()),
    description: v.optional(v.string()),
    systemPrompt: v.optional(v.string()),
    isActive: v.boolean(),
  })
    .index("by_teacher", ["teacherId"])
    .index("by_active", ["isActive"])
    .index("by_slug", ["slug"]),

  // ── PHYSICAL ENVIRONMENT (DESIGN layer) ───────────────────────────────
  // The school's physical space, curated as a teaching tool: rooms
  // (`spaces`) grouping the gear (`equipment`) the tutor can send scholars
  // to touch — hand bells for integer ratios, a singing bowl for resonance,
  // a compass + straight-edge for construction. Unlike the teacher-scoped
  // building blocks (personas/perspectives/processes), these are
  // INSTITUTION-scoped: the physical space belongs to the school, shared by
  // all its teachers. See review/physical-environment-teaching-tool-plan.html.
  //
  // `spaces` groups gear; `equipment` is the LEAF the tutor references (it
  // carries the concept tags, teacher-authored task seeds, and the
  // human-in-the-loop gate).
  spaces: defineTable({
    institutionId: v.id("institutions"),
    name: v.string(), // "Music Room", "Maker Lab"
    slug: v.optional(v.string()),
    kind: v.optional(
      v.union(
        v.literal("classroom"),
        v.literal("lab"),
        v.literal("music"),
        v.literal("art"),
        v.literal("library"),
        v.literal("makerspace"),
        v.literal("outdoor"),
        v.literal("gym"),
        v.literal("other"),
      ),
    ),
    description: v.optional(v.string()),
    isActive: v.boolean(),
  })
    .index("by_institution", ["institutionId"])
    .index("by_slug", ["slug"]),

  equipment: defineTable({
    institutionId: v.id("institutions"),
    // Where it lives (nullable → "somewhere in the school").
    spaceId: v.optional(v.id("spaces")),
    name: v.string(), // "Set of hand bells", "Singing bowl", "Compass & straight-edge"
    category: v.optional(v.string()), // musical | scientific | measurement | art | tools | manipulatives
    description: v.optional(v.string()),
    quantity: v.optional(v.string()), // free-text: "8 bells (C-C)", "class set"
    // A photo of the actual item (staff-uploaded, e.g. from the mobile
    // add-by-photo flow). Curation aid only — never sent to the tutor.
    photoStorageId: v.optional(v.id("_storage")),

    // ── The redaction boundary (human-in-the-loop) ──
    // The tutor NEVER sees an item unless a staffer flips this true. This is
    // the redaction-boundary / human-in-the-loop principle applied to the
    // physical world.
    tutorSuggestable: v.boolean(),
    // Gates HOW the tutor may suggest it: "none" = suggest freely;
    // "adult_present" = phrase as "ask your teacher to help you…";
    // "teacher_only" = never tutor-suggested (curation reference only).
    supervision: v.optional(
      v.union(
        v.literal("none"),
        v.literal("adult_present"),
        v.literal("teacher_only"),
      ),
    ),
    safetyNotes: v.optional(v.string()), // surfaced verbatim in the invitation

    // ── Pedagogy hooks ──
    conceptIds: v.optional(v.array(v.id("concepts"))), // what it teaches → the Knowledge-Tree lens
    usageIdeas: v.optional(v.array(v.string())), // teacher-authored task seeds
    isActive: v.boolean(),
  })
    .index("by_institution", ["institutionId"])
    .index("by_space", ["spaceId"])
    .index("by_institution_suggestable", ["institutionId", "tutorSuggestable"])
    // Reference check in equipment.discardUpload — the burst add-by-photo
    // flow hits it on every retake/cancel, so no full-table scan.
    .index("by_photo", ["photoStorageId"]),

  // ── PHYSICAL TASKS (EXECUTION / OBSERVATION layer) ────────────────────
  // A hands-on task the tutor invited a scholar to do IRL with a piece of
  // `equipment` — "go ring the hand bells and tell me which pairs sound good
  // together." Written by the tutor's `suggest_physical_task` tool (Phase 2 of
  // review/physical-environment-teaching-tool-plan.html) so the invitation
  // renders as a "Go do this" card, persists across reloads, and is visible to
  // teachers. The scholar taps "I'm back" to mark it done, then reports what
  // they noticed in chat (the tutor reasons from their observations).
  //
  // Equipment is referenced by NAME (+ optional id) because the tutor sees the
  // inventory as names, not ids — so a later rename/archive of the gear never
  // orphans the historical task record. A completed task becomes learning-record
  // evidence in Phase 3.
  physicalTasks: defineTable({
    sessionId: v.id("sessions"),
    scholarId: v.id("users"),
    assignmentId: v.optional(v.id("assignments")),
    equipmentId: v.optional(v.id("equipment")),
    equipmentName: v.string(),
    spaceName: v.optional(v.string()),
    // The tutor's open-ended invitation (what to explore + report back).
    prompt: v.string(),
    status: v.union(v.literal("suggested"), v.literal("completed")),
    suggestedAt: v.number(),
    completedAt: v.optional(v.number()),
    // "📸 Show what I found": the scholar can return from a hands-on task with a
    // PHOTO of what they built/found. It rides the existing chat image-message
    // vision path (a role:"user" message carries the same storage id in
    // `imageId`, so the tutor reasons from the artifact next turn) AND is
    // stamped here so the completed task carries durable evidence for the
    // portrait / ScholarFeed. Optional — the bare "I'm back" return still works.
    photoStorageId: v.optional(v.id("_storage")),
  })
    .index("by_session", ["sessionId"])
    .index("by_scholar", ["scholarId"])
    // Reference checks in equipment.remove / equipment.discardUpload —
    // physicalTasks grows unboundedly, so those must not full-scan it.
    .index("by_equipment", ["equipmentId"])
    .index("by_photo", ["photoStorageId"]),

  units: defineTable({
    teacherId: v.id("users"),
    // The institution that owns this curriculum. Optional during the additive
    // rollout: legacy rows with no institution belong to the primary school.
    institutionId: v.optional(v.id("institutions")),
    title: v.string(),
    slug: v.optional(v.string()),
    emoji: v.optional(v.string()),
    description: v.optional(v.string()),
    // Scholar-FACING blurb (2nd person — "your study of…"), shown on the
    // scholar's own home cards. `description` stays teacher-facing (3rd
    // person — "Emma's study of…") for teacher surfaces. The explicit
    // `backfillUnitScholarDescriptions` widen-phase migration must run before
    // the unit-card fallback is removed.
    scholarDescription: v.optional(v.string()),
    systemPrompt: v.optional(v.string()),
    rubric: v.optional(v.string()),
    targetBloomLevel: v.optional(
      v.union(
        v.literal("remember"),
        v.literal("understand"),
        v.literal("apply"),
        v.literal("analyze"),
        v.literal("evaluate"),
        v.literal("create")
      )
    ),
    // Phase 1: building-block references (unit composes these)
    // personaId is DEPRECATED (anti-parasocial) — retained optional so existing
    // unit→persona links survive, but no new unit wires one and it's never
    // injected. See TODO.html ("Reimagine personas").
    personaId: v.optional(v.id("personas")),
    perspectiveId: v.optional(v.id("perspectives")),
    processId: v.optional(v.id("processes")),
    durationMinutes: v.optional(v.number()),
    youtubeUrl: v.optional(v.string()),
    videoTranscript: v.optional(v.string()),
    // PCM curriculum fields
    bigIdea: v.optional(v.string()),
    // EQs/EUs are the unit's "granules" — the mastery atoms that
    // granuleEvidence rows attribute observations to. Each entry
    // carries a stable `key` so evidence survives reordering and
    // (via a future key-aware editor) text edits. Stored as keyed
    // objects; all writers go through `convex/lib/granules.ts`
    // (`toKeyedGranules`), which still accepts the plain-string arrays
    // the UI/bot tools speak and mints/preserves keys. The legacy
    // bare-string storage shape was narrowed away once
    // `migrations.keyUnitGranules` had backfilled prod.
    essentialQuestions: v.optional(
      v.array(v.object({ key: v.string(), text: v.string() })),
    ),
    enduringUnderstandings: v.optional(
      v.array(v.object({ key: v.string(), text: v.string() })),
    ),
    subject: v.optional(v.string()),
    gradeLevel: v.optional(v.string()),
    mathDomain: v.optional(v.string()),
    isActive: v.boolean(),
    // ─── Independent Study ────────────────────────────────────────
    // When set, this unit was authored by a scholar — their own
    // independent study. Visible to the scholar + their assigned
    // teachers (read-only for teachers). When unset, this is regular
    // teacher-authored curriculum.
    authorScholarId: v.optional(v.id("users")),
    // PROVENANCE of a scholar-owned unit (only meaningful with
    // authorScholarId): "author" = the scholar built it from scratch (a
    // Custom Quest) → shown as "Authored by X"; "inspired" = the unit was
    // designed by someone else (a teacher offer, an AI bake) but sparked
    // by / first started by the scholar → shown as "Inspired by X". Unset
    // defaults to "inspired" (the scholar didn't necessarily author it).
    authorRole: v.optional(v.union(v.literal("author"), v.literal("inspired"))),
    // ─── Auto-bake provenance ─────────────────────────────────────
    // When set, this unit was designed headlessly by the Curriculum Bot
    // from a scholar's exploration seed (the seed→unit "bake" on launch),
    // NOT hand-authored. Lets teacher curriculum/quests surfaces flag its
    // provenance ("auto-baked from a seed") + treat it as born-Draft for
    // optional review. See review/seed-to-unit-bake-plan.md.
    bakedFromSeedId: v.optional(v.id("seeds")),
    // ─── Badge on completion ──────────────────────────────────────
    // Per-unit badge config. Replaces the dropped badges-on-quests
    // model. When set, finishing every activity in the unit earns
    // the scholar this badge (written into scholarUnitBadges).
    badgeOnCompletion: v.optional(
      v.object({
        title: v.string(),
        description: v.optional(v.string()),
        icon: v.optional(v.string()), // emoji
      }),
    ),
    // ─── Readiness signal runtime state (PR #1072 §8) ─────────────
    // The Readiness gate (green) shows a Spinner while the heuristic review
    // runs. Review is fired by pushing a prompt to the Curriculum Bot (no
    // durable in-flight row otherwise), so `markReviewStarted` stamps this;
    // it's treated as "running" only while it's newer than the latest
    // `unitReviews.reviewedAt`. Cleared implicitly when a review lands.
    reviewStartedAt: v.optional(v.number()),
    // The scholar-bot rehearsal is expensive (time + tokens). A teacher may
    // explicitly skip it and still reach "Ready to assign" — the gate renders
    // hatched, not failed. Timestamp of the skip (null/unset = not skipped).
    rehearsalSkippedAt: v.optional(v.number()),
  })
    .index("by_teacher", ["teacherId"])
    .index("by_active", ["isActive"])
    .index("by_slug", ["slug"])
    .index("by_institution", ["institutionId"])
    .index("by_authorScholar", ["authorScholarId"]),

  lessons: defineTable({
    unitId: v.id("units"),
    title: v.string(),
    // OPTIONAL PCM strand TAG — a lesson's pedagogical role, not a
    // structural grouping. Lessons are sequenced freely by `order`; the
    // strand is just a label the UI shows as a chip and the curriculum bot
    // reasons about. The common-sense conventions (Core generally comes
    // first, Identity is optional and only sometimes used) are guidance the
    // bot/teacher apply — deliberately NOT enforced here. A lesson may carry
    // no strand at all. Mirrors the four PCM assessment dimensions
    // (convex/lib/pcm.ts) by name only.
    strand: v.optional(v.union(
      v.literal("core"), v.literal("connections"),
      v.literal("practice"), v.literal("identity")
    )),
    systemPrompt: v.optional(v.string()),
    processId: v.optional(v.id("processes")),
    order: v.number(),
    durationMinutes: v.optional(v.number()),
    // ─── Selection mode (activity choice) ─────────────────────────
    // How a scholar moves through this lesson's activities.
    //   - "sequence" / absent → today's behavior: the activities are a
    //     LINEAR ladder, done in `order`.
    //   - "choice" → the activities are ALTERNATIVES (a menu). The
    //     scholar completes `choicePickCount` (default 1) of them and the
    //     lesson is satisfied; the remaining options stay openable but no
    //     longer count as assigned work (curiosity-friendly, ungraded).
    // Purely a READ-TIME reinterpretation of the same activity group —
    // authoring activities is unchanged. See
    // review/activity-choice-plan.html.
    selectionMode: v.optional(
      v.union(v.literal("sequence"), v.literal("choice")),
    ),
    // choice lessons only: how many of the options a scholar must
    // complete. Clamped at read time to [1, #liveOptions]. Absent = 1.
    choicePickCount: v.optional(v.number()),
  })
    .index("by_unit", ["unitId"]),

  activities: defineTable({
    // Activities belong to a lesson (which belongs to a unit). The
    // single hierarchy: Unit → Lesson → Activity. Independent Study
    // units use the same shape — the unit's `authorScholarId` is what
    // makes it an IS unit.
    lessonId: v.optional(v.id("lessons")),
    title: v.string(),
    // Teacher-facing design intent and facilitation notes. Never shown to scholars.
    description: v.optional(v.string()),
    // Scholar-facing blurb (2nd person or neutral invitation), shown on scholar
    // home cards and activity navigation. Scholar reads never fall back to
    // `description`.
    scholarDescription: v.optional(v.string()),
    // "online"    = scholar opens this in Rabbithole; needs systemPrompt.
    // "offline"   = classroom/lab/discussion; teacher planning only.
    // "shareBack" = teacher-facilitated discussion of earlier work,
    //               with an AI digest. Has a `shareBackRecipe` + a
    //               `sourceActivityIds` array. See
    //               review/shareback-offline-activity.md.
    // "web"       = external-site assignment (e.g. a math-fluency site): the
    //               scholar opens `webUrl` in a domain-locked native
    //               webview inside the iPad shell (plain new tab on
    //               desktop). Sessions + captures land in
    //               `webActivitySessions`. See
    //               review/web-assignment-plan.md.
    // "game"      = a bespoke educational game, played in the NATIVE iPad
    //               app only. Games are a SIBLING primitive to
    //               manipulatives, not a ManipulativeKind: the game itself
    //               is code (native/src/games/<gameId>/), registered in
    //               lib/games/catalog.ts, and this row only names which one
    //               plus its config. Sessions + evidence land in
    //               `gameSessions` / `gameEvents` / `gameSessionDigests`.
    //               A game's outcome NEVER touches mastery — it emits
    //               evidence, the server draws conclusions.
    // "simulator" = a Workbench Simulator: a versioned row parameterizes one
    //               code-owned physics template. The scholar authors the
    //               prompt deck; server-run automata produce immutable chunks.
    //               Criterion scores NEVER touch mastery.
    // "vibecode"  = a full-screen app-builder workshop: the scholar directs the
    //               AI to generate + iterate a live web app. The activity's
    //               systemPrompt IS the build brief; the app is the artifact.
    kind: v.union(
      v.literal("online"),
      v.literal("offline"),
      v.literal("shareBack"),
      v.literal("web"),
      v.literal("problem_set"),
      v.literal("game"),
      v.literal("simulator"),
      v.literal("vibecode"),
    ),
    // kind="web" only: the start URL the webview opens. When
    // `externalAppId` is set this is an OPTIONAL per-activity override
    // (e.g. a deep link to a specific page); blank = open the catalog
    // app's own URL.
    webUrl: v.optional(v.string()),
    // kind="web" only: hosts the webview may navigate to. Plain entries
    // ("example.com") match the host and its subdomains; "*."
    // prefixes match subdomains only. Empty/unset = locked to webUrl's
    // host. Enforced by the urlChange watchdog in lib/webAssignment.ts.
    // When `externalAppId` is set and this is empty, the catalog app's
    // allowlist applies (the allowlist is defined once, in the catalog).
    webAllowedHosts: v.optional(v.array(v.string())),
    // kind="web" only: optional reference to a shared External App in the
    // `externalApps` catalog (the same registry that powers the scholar
    // home launcher). When set, the app is the source of truth for the
    // assignment's identity (name + icon) and security allowlist; the
    // fields above act as optional per-activity overrides. This is what
    // lets one app definition power BOTH a standing launcher tile AND a
    // scheduled Web Assignment. See review/external-apps-launcher.html.
    externalAppId: v.optional(v.id("externalApps")),
    // kind="problem_set" only: which homegrown knowledge-graph skills this set
    // practices, and how many items per session. The scholar's session is drawn
    // adaptively from these skills' frontier + due reviews. See convex/practiceSkills.ts.
    problemSet: v.optional(
      v.object({
        domain: v.optional(v.string()),
        targetSkillKeys: v.array(v.string()),
        itemCount: v.optional(v.number()),
      }),
    ),
    // kind="game" only: which registered game to launch, plus optional
    // authored config. `gameId` must be in lib/games/catalog.ts's GAME_IDS
    // (validated at write time); `configJson` is a JSON string parsed by
    // THAT game's own config codec — the server never interprets it, and a
    // config can only vary a mechanic, never introduce one. Deliberately
    // NOT here: any grading, scoring, mastery or unlock field. See
    // lib/games/contract.ts.
    game: v.optional(
      v.object({
        gameId: v.string(),
        configJson: v.optional(v.string()),
      }),
    ),
    // kind="simulator" only. This is authored configuration, never executable
    // physics: the registry validates the template, Senses, metric, counts, and
    // budgets on every write and launch.
    simulatorSpec: v.optional(simulatorSpecValidator),
    // Optional held-out skills for the curriculum-sim OUTCOME PROBE (adoptable
    // #1, review/sim-realism-lessons.html §5). Curriculum sims only run on
    // kind:"online" activities, which carry NO problemSet, so an online
    // activity that still wants a sim pre→post probe names its target
    // knowledge-graph skills here. The probe resolves its skills from
    // problemSet?.targetSkillKeys first, then this, then skips gracefully.
    // Purely a measurement input — never gates anything a scholar sees.
    probeSkillKeys: v.optional(v.array(v.string())),
    // (isHomework moved to focusSettings.isHomework — homework is a
    // property of the push, not the content. See
    // review/homework-on-assignment.md.)
    // Per-activity jigsaw — when true, the AI tutor asks the scholar
    // to pick their own "angle" on this activity during a kickoff
    // phase, and each scholar gets a different perspective on the
    // same prompt. Angle is stored in `scholarActivityAngles`.
    hasScholarAngles: v.optional(v.boolean()),
    // Design-time intent for how this activity is meant to be done.
    // Auto-populates an Assignment's activitySchedule when the unit
    // is assigned: "homework" activities land on each cohort's plate
    // immediately; "classFocus" activities stay dormant until the
    // teacher pushes them from the Run page; "either" / undefined
    // also stay dormant (no auto-push, no UI hint).
    defaultMode: v.optional(
      v.union(
        v.literal("classFocus"),
        v.literal("homework"),
        v.literal("either"),
      ),
    ),
    // Deliverable spec: what the scholar must produce + the private quality
    // map the AI (or teacher) checks against. Full criteria award their
    // labels as scholar-visible flair; the map does not gate completion.
    //
    // Two rubric authoring modes:
    //   - "manual": teacher authors the criteria array directly. Every
    //               scholar is judged against the same private map.
    //               Criteria array is required and used as-is.
    //   - "auto":   teacher writes optional `notes` describing intent.
    //               When a scholar starts a project, the system
    //               generates criteria fresh, calibrated to that
    //               scholar's reading level, and snapshots them on the
    //               project (`projects.deliverableCriteria`). The
    //               `criteria` array at the activity level may be
    //               omitted; if present it's a seed/example for the
    //               generator.
    deliverable: v.optional(
      v.object({
        kind: v.union(
          v.literal("photo"),
          v.literal("artifact"),
          v.literal("slides"),
          v.literal("text"),
          v.literal("audio"),
          v.literal("map"),
        ),
        prompt: v.string(),
        // manual = teacher writes criteria, auto = AI generates per-scholar,
        // none = no rubric (scholar just fills in the doc, no AI grading).
        mode: v.union(
          v.literal("manual"),
          v.literal("auto"),
          v.literal("none"),
        ),
        notes: v.optional(v.string()), // auto mode: prose intent for the generator
        criteria: v.array(
          v.object({
            id: v.string(),
            label: v.string(),
            description: v.optional(v.string()),
          }),
        ),
      }),
    ),
    // ── Advance ("ready to move on") CHAT rubric ──────────────────────
    // A rubric WITHOUT a deliverable: the same criteria shape, graded
    // against the CONVERSATION instead of a submitted artifact. Lets a
    // pure-discussion activity have a real "ready to advance" bar (the
    // tutor scores it with the same update_rubric_score tool, no artifact;
    // a pass marks the activity complete and surfaces the Continue CTA)
    // instead of a crude message-count heuristic. Manual criteria only for
    // now. See the chat-rubric plan/report.
    advanceRubric: v.optional(
      v.object({
        criteria: v.array(
          v.object({
            id: v.string(),
            label: v.string(),
            description: v.optional(v.string()),
          }),
        ),
      }),
    ),
    systemPrompt: v.optional(v.string()),
    // Scholar-safe material resources owned by sibling activities in this unit.
    // Every read revalidates that relationship before exposing a resource.
    referencedResourceIds: v.optional(
      v.array(v.id("activityResources")),
    ),
    processId: v.optional(v.id("processes")),
    durationMinutes: v.optional(v.number()),
    order: v.number(),
    // Deprecated presentation attachment fields. They remain dual-written while
    // activityResources is backfilled; canonical presentation state lives there.
    slidesDeck: v.optional(v.string()),
    // Deprecated Google Slides compatibility fields.
    googleSlidesPresentationId: v.optional(v.string()),
    googleSlidesUrl: v.optional(v.string()),
    googleSlidesName: v.optional(v.string()),
    googleSlidesThumbnailUrl: v.optional(v.string()),
    // Historical personal-OAuth provenance. New writes also persist the
    // complete personal/Workspace principal on the canonical resource.
    googleSlidesOwnerId: v.optional(v.id("users")),
    // ─── Share Back recipe (kind === "shareBack") ──────────────────
    // The teacher picks one of a small set of recipes — each is a
    // different facilitation shape:
    //   - reflection    : summary + themes + scholar highlights + prompts
    //   - galleryWalk   : every scholar's piece surfaced, lighter synthesis
    //   - exitTicket    : surface confusions + gaps, not celebrations
    //   - debateDebrief : positions taken, contrasts, evidence used
    //   - custom        : no recipe scaffolding — just facilitationFocus
    //
    // `sourceActivityIds` points at the earlier ONLINE activities
    // whose submitted deliverables get collated into the AI digest
    // (see shareBackDigests). `facilitationFocus` is the teacher's
    // free-text steer for the digest ("focus on word choice", "find
    // pieces that took emotional risks", etc.) — it's also what
    // shows up where Description usually does on this activity kind.
    shareBackRecipe: v.optional(
      v.union(
        v.literal("reflection"),
        v.literal("galleryWalk"),
        v.literal("exitTicket"),
        v.literal("debateDebrief"),
        v.literal("custom"),
      ),
    ),
    sourceActivityIds: v.optional(v.array(v.id("activities"))),
    facilitationFocus: v.optional(v.string()),
    // ─── Conversation recipe (kind === "online") ───────────────────
    // Pre-shaped EQ/EU assessment conversations. Distinct from
    // `shareBackRecipe` above (which shapes the share-back DIGEST):
    //   - baseline   : opening conversation — the tutor elicits the
    //                  scholar's current thinking on the unit's
    //                  essential questions WITHOUT teaching (stealth
    //                  pre-assessment).
    //   - exitTicket : closing conversation — the tutor revisits the
    //                  EQs against the scholar's baseline answers.
    // The observer stamps granuleEvidence rows from these projects
    // with phase "baseline" / "exit", which powers the pre/post
    // comparison.
    recipe: v.optional(
      v.union(v.literal("baseline"), v.literal("exitTicket")),
    ),
    // Soft-archive timestamp (mirrors assignments.archivedAt). When set, the
    // activity is hidden from scholar-facing reads and schedulable pickers but
    // stays visible (dimmed) on teacher design surfaces, and any existing
    // session/placement pointing at it still resolves. Archiving is the
    // non-destructive alternative to deleting an activity scholars have worked
    // on. See convex/lib/activityCascade.ts (activityHasScholarWork).
    archivedAt: v.optional(v.number()),
    // (Legacy `scholarId` + `isHomework` removed. See
    // review/homework-on-assignment.md.)
  })
    .index("by_lesson", ["lessonId"]),

  // DESIGN: scholar-facing source material attached to exactly one activity.
  // This is deliberately a child table rather than a reusable library: each
  // row has its own order, upload/extraction lifecycle, and storage ownership.
  // `extractedText` is internal tutor context; scholar reads receive only
  // display metadata plus a fresh serving URL.
  activityResources: defineTable({
    activityId: v.id("activities"),
    title: v.string(),
    source: v.union(
      v.object({
        kind: v.literal("file"),
        fileStorageId: v.id("_storage"),
        fileName: v.string(),
        mimeType: v.string(),
        sizeBytes: v.number(),
      }),
      v.object({
        kind: v.literal("link"),
        url: v.string(),
      }),
      v.object({
        kind: v.literal("video"),
        url: v.string(),
      }),
      v.object({
        kind: v.literal("rabbit_slides"),
        // Validated Deck JSON. Its revision is intentionally inside Deck.
        deck: v.string(),
      }),
      v.object({
        kind: v.literal("google_slides"),
        presentationId: v.string(),
        url: v.string(),
        name: v.optional(v.string()),
        thumbnailUrl: v.optional(v.string()),
        principal: v.union(
          v.object({
            kind: v.literal("personal_oauth"),
            userId: v.id("users"),
          }),
          v.object({
            kind: v.literal("workspace_bot"),
            institutionId: v.id("institutions"),
            credentialId: v.id("institutionGoogleAccounts"),
          }),
          // Only migrated legacy rows without trustworthy ownership use this.
          v.object({ kind: v.literal("legacy_unknown") }),
        ),
      }),
    ),
    order: v.number(),
    uploadedBy: v.id("users"),
    extractionStatus: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("extracting"),
        v.literal("ready"),
        v.literal("error"),
      ),
    ),
    extractedText: v.optional(v.string()),
    extractionError: v.optional(v.string()),
  }).index("by_activity", ["activityId"]),

  // AI-generated digest for a Share Back offline activity. One row per
  // Share Back activity. Mirrors the reflection / deliverable-criteria
  // generation pattern: pending → ready / error, with a regenerate
  // path. The teacher facilitates the `ready` digest full-screen.
  shareBackDigests: defineTable({
    activityId: v.id("activities"), // the Share Back offline activity
    // The Assignment this digest belongs to — keyed so the same
    // Share Back activity can be run with multiple cohorts and each
    // cohort gets its own digest scoped to its own submissions.
    // Optional during migration; required after Phase 3.
    assignmentId: v.optional(v.id("assignments")),
    status: v.union(
      v.literal("pending"),
      v.literal("ready"),
      v.literal("error"),
    ),
    error: v.optional(v.string()),
    generatedAt: v.optional(v.number()),
    // Provenance — what was collated when this digest was generated.
    // Drives the "N new submissions since generated" staleness nudge.
    sourceSnapshot: v.optional(
      v.array(
        v.object({
          activityId: v.id("activities"),
          title: v.string(),
          deliverableCount: v.number(),
        }),
      ),
    ),
    // ── AI-produced digest content ──
    summary: v.optional(v.string()), // 2-4 sentence synthesis
    themes: v.optional(
      v.array(
        v.object({
          title: v.string(),
          body: v.string(),
        }),
      ),
    ),
    highlights: v.optional(
      v.array(
        v.object({
          deliverableId: v.id("deliverables"),
          scholarId: v.id("users"),
          scholarName: v.string(),
          sourceActivityTitle: v.string(),
          angleTitle: v.optional(v.string()), // when the source had angles
          reason: v.string(), // why the AI flagged it
          excerpt: v.string(), // short pull-quote
          sessionId: v.optional(v.id("sessions")),
        }),
      ),
    ),
    discussionPrompts: v.optional(v.array(v.string())),
  })
    .index("by_activity", ["activityId"])
    .index("by_assignment_activity", ["assignmentId", "activityId"]),

  // AI-generated "class digest" — a glanceable synthesis of what a
  // cohort did, at TWO scopes off ONE engine + ONE table (DRY):
  //   - scope "activity": one assigned activity × one cohort. "How did
  //     'Write your Weekend News' land across the class?"
  //   - scope "cohort":   the whole assignment, recent window — the
  //     "today's read" roll-up across all of a cohort's activities.
  // Generalizes the shareBackDigests pattern (pending → ready/error,
  // regenerate, staleness) to EVERY assigned activity, and is
  // auto-(re)generated as cohort work accumulates (classDigests
  // .maybeAutoGenerate + the cron sweep). One row per (assignment,
  // activity) for activity scope; one row per assignment for cohort.
  classDigests: defineTable({
    scope: v.union(
      v.literal("activity"),
      v.literal("cohort"),
      // scope "class": a (groupId, subject, periodId) class digest — the union
      // of the class's linked assignments this period (see convex/classResolver
      // .ts). ADDITIVE: pre-existing rows are all activity/cohort and untouched.
      v.literal("class"),
    ),
    assignmentId: v.id("assignments"),
    activityId: v.optional(v.id("activities")), // scope === "activity"
    // ── scope === "class" identity (all additive/optional; absent on the
    // activity/cohort rows that predate this scope). The row is keyed by the
    // (groupId, subject, periodId) class, not a single assignment;
    // `assignmentId` above carries a REPRESENTATIVE (the class's most-recently-
    // created linked assignment) only to satisfy the required field — the
    // collation/counts always re-resolve the full class via classResolver.
    // `subject` is stored normalized (trim + lowercase — classSubjectKey) so
    // the class key stays stable.
    groupId: v.optional(v.id("scholarGroups")),
    subject: v.optional(v.string()),
    periodId: v.optional(v.id("reportingPeriods")),
    status: v.union(
      v.literal("pending"),
      v.literal("ready"),
      v.literal("error"),
    ),
    error: v.optional(v.string()),
    generatedAt: v.optional(v.number()),
    // Provenance for the staleness nudge + auto-regen debounce: how much
    // cohort work existed when this digest was generated.
    sourceSnapshot: v.optional(
      v.object({
        completedCount: v.number(),
        startedCount: v.number(),
        deliverableCount: v.number(),
        // Source watermark at generation time: the newest observer analysis
        // and newest message across the sessions this digest collated. Lets
        // a mid-session digest go stale / regenerate when later analyses or
        // messages advance past it, even with unchanged counts. Optional +
        // additive: absent on digests predating watermarks → no watermark
        // staleness check for those rows (they behave exactly as before).
        latestAnalysisAt: v.optional(v.number()),
        latestMessageAt: v.optional(v.number()),
      }),
    ),
    // ── AI content (shared shape across both scopes) ──
    headline: v.optional(v.string()), // one-line "how it landed" (inline snippet)
    summary: v.optional(v.string()), // 2-4 sentence synthesis (dedicated view)
    themes: v.optional(
      v.array(v.object({ title: v.string(), body: v.string() })),
    ),
    // Key moments worth the teacher's attention — each tied to a scholar
    // (+ project when known) so the dedicated view can drill in and the
    // triage actions (observation / seed) have a concrete target.
    moments: v.optional(
      v.array(
        v.object({
          kind: v.union(
            v.literal("breakthrough"),
            v.literal("misconception"),
            v.literal("offTask"),
            v.literal("insight"),
            v.literal("needsHelp"),
          ),
          scholarId: v.id("users"),
          scholarName: v.string(),
          sessionId: v.optional(v.id("sessions")),
          headline: v.string(), // <= ~80 chars
          detail: v.string(), // one line of context / excerpt
        }),
      ),
    ),
    discussionPrompts: v.optional(v.array(v.string())),
  })
    .index("by_assignment_activity", ["assignmentId", "activityId"])
    .index("by_assignment_scope", ["assignmentId", "scope"])
    // Class-scope lookup: one row per (groupId, subject, periodId) class. Only
    // scope === "class" rows set all three; activity/cohort rows leave them
    // undefined and are never looked up by this index.
    .index("by_group_subject_period", ["groupId", "subject", "periodId"]),

  // Per-scholar completion stamps for activities. Online activities can be
  // auto-marked when the scholar finishes the project; offline activities
  // are marked manually from the navigator card ("Done with the lab demo").
  activityCompletions: defineTable({
    scholarId: v.id("users"),
    activityId: v.id("activities"),
    // lessonId/unitId optional: scholar-scoped activities (the new
    // IS task model) don't live in a lesson or unit. Curriculum
    // activities still carry both.
    lessonId: v.optional(v.id("lessons")),
    unitId: v.optional(v.id("units")),
    completedAt: v.number(),
    // The project that produced this completion (set for online activities).
    sessionId: v.optional(v.id("sessions")),
    // The Assignment this completion was earned under. Lets the same
    // scholar do the same activity in different runs without "already
    // done" bleeding across cohorts. Optional during migration.
    assignmentId: v.optional(v.id("assignments")),
    // Optional teacher/scholar note recorded at completion time.
    note: v.optional(v.string()),
    // Explicit scholar action provenance for a completion started from the
    // take-home plan. Optional keeps every pre-existing completion valid.
    source: v.optional(v.literal("scholar_home")),
    action: v.optional(v.literal("scholar_marked_take_home_done")),
  })
    .index("by_scholar", ["scholarId"])
    .index("by_scholar_unit", ["scholarId", "unitId"])
    .index("by_scholar_activity", ["scholarId", "activityId"])
    .index("by_scholar_assignment", ["scholarId", "assignmentId"])
    // Range-scan "completed since <t>" for the daily recap without loading a
    // scholar's whole completion history.
    .index("by_scholar_completedAt", ["scholarId", "completedAt"])
    .index("by_assignment", ["assignmentId"])
    // "Has anyone completed this activity?" — the delete-guard existence check
    // (activityHasScholarWork) without scanning by scholar.
    .index("by_activity", ["activityId"]),

  // The scholar-owned, institution-local-day selections behind the take-home plan.
  // Assigned homework deliberately does NOT live here: it is always re-derived
  // from assignments so schedule edits take effect immediately.
  takeHomePlanItems: defineTable({
    scholarId: v.id("users"),
    institutionId: v.id("institutions"),
    dayKey: v.string(), // institution-local YYYY-MM-DD, never server-local
    kind: v.union(
      v.literal("activity"),
      v.literal("quest"),
      v.literal("session"),
      v.literal("note"),
    ),
    // `activity` choices point at a started activity session; `quest` choices
    // point at a unit and may retain the session that prompted the choice;
    // `session` retains a newly started unstructured Sky thread while it bakes.
    activityId: v.optional(v.id("activities")),
    unitId: v.optional(v.id("units")),
    sessionId: v.optional(v.id("sessions")),
    text: v.optional(v.string()), // required by the mutation for `kind: note`
    checkedAt: v.optional(v.number()),
    removedAt: v.optional(v.number()),
    // A plan-originated completion retains its provenance so undo can only
    // retract a completion this plan actually created.
    markedDoneAt: v.optional(v.number()),
    markedCompletionId: v.optional(v.id("activityCompletions")),
    // A direct suggestion resolution belongs in the daily activity record, not
    // the editable tonight list. It keeps the exact canonical side effect so
    // Undo can reverse only what this decision created.
    resolution: v.optional(
      v.union(
        v.literal("activity_completed"),
        v.literal("quest_closed"),
      ),
    ),
    resolvedAt: v.optional(v.number()),
    // "Close quest" is a reversible scholar outcome, not a completion. It
    // archives only the Quest's active sessions; it never writes a completion
    // or awards a badge.
    questOutcome: v.optional(v.literal("scholar_closed")),
    questClosedAt: v.optional(v.number()),
    questClosedSessionIds: v.optional(v.array(v.id("sessions"))),
  })
    .index("by_scholar_day", ["scholarId", "dayKey"])
    .index("by_institution_day", ["institutionId", "dayKey"]),

  // One scholar session inside a kind="web" activity's external site
  // (e.g. an external practice-site block). Created when the webview opens,
  // finalized when it closes. Holds the Observation-layer captures:
  // periodic screenshots (storage ids) and structured extraction
  // (an external site's daily XP + completed tasks, pulled via the site's
  // own session — see review/web-assignment-plan.md). Consumed by the
  // teacher dashboard (session card + filmstrip), the tutor's
  // "external practice today" prompt section, and the XP-goal
  // auto-completion in `webActivitySessions.finalize`.
  webActivitySessions: defineTable({
    scholarId: v.id("users"),
    // A session belongs to EITHER a kind="web" activity (a scheduled Web
    // Assignment) OR a standing External App (`appId`) launched from the
    // scholar's home launcher. Exactly one is set; both pull the same
    // locked-webview + capture pipeline. activityId-only completion logic
    // (activityCompletions, unit badges) is skipped for app sessions —
    // an app launch is standing access, not an assignment. See
    // review/external-apps-launcher.html.
    activityId: v.optional(v.id("activities")),
    appId: v.optional(v.id("externalApps")),
    assignmentId: v.optional(v.id("assignments")),
    startedAt: v.number(),
    // Stamped by finalize; missing = session still open (or app died
    // before close — treat lastHeartbeatAt as the effective end).
    endedAt: v.optional(v.number()),
    // Bumped on every capture tick so an abandoned session still shows
    // a real duration.
    lastHeartbeatAt: v.optional(v.number()),
    // Webview screenshots, oldest → newest. Capped (FIFO) by
    // `attachScreenshot` so a forgotten-open iPad can't fill storage.
    screenshotIds: v.array(v.id("_storage")),
    // Off-allowlist navigations the watchdog yanked back. >0 is a
    // teacher-visible signal worth a glance.
    offDomainBlocks: v.optional(v.number()),
    // Last main-frame URL seen (debugging + teacher context).
    lastUrl: v.optional(v.string()),
    // Structured extraction from the external site, best-effort.
    extracted: v.optional(
      v.object({
        xpToday: v.optional(v.number()),
        xpGoal: v.optional(v.number()),
        courseName: v.optional(v.string()),
        percentComplete: v.optional(v.number()),
        tasksCompletedToday: v.optional(v.number()),
        // Human-readable per-task lines, e.g. "Lesson: Dividing
        // fractions (12 XP)". Capped server-side.
        taskSummaries: v.optional(v.array(v.string())),
      }),
    ),
    // Where `extracted` came from: the site's own JSON API ("api",
    // richer + preferred) or DOM text scraping ("dom", fallback).
    extractedSource: v.optional(v.union(v.literal("api"), v.literal("dom"))),
    // One-line natural-language recap for the teacher card, written by a
    // cheap Haiku pass at finalize from `extracted`
    // (convex/webActivitySummary.ts). Best-effort + cached; absent until
    // the session ends with captured content — the card falls back to the
    // structured course/badge/task lines when this is missing.
    summary: v.optional(v.string()),
  })
    .index("by_scholar", ["scholarId", "startedAt"])
    .index("by_activity", ["activityId"])
    .index("by_app", ["appId"])
    .index("by_assignment", ["assignmentId"]),

  // ─── Worlds -- Workbench execution and immutable simulation truth ─────
  //
  // This is a separate simulation-record category from the games capture
  // layer below (the boundary is also frozen in lib/simulator/contract.ts and
  // lib/games/contract.ts; see the approved Workbench plan section 4). Games
  // record what a scholar did in a client-run interactive. World chunks record
  // what server-run automata did after a scholar authored a deck. The stores
  // share server seeds, frozen inputs, append-only truth, deterministic
  // summaries, and the invariant that no score reaches a mastery writer.

  // Ready compile-on-save artifacts are immutable per (deckHash, slotId,
  // compileContextHash). Failed rows may retry when their compiler fingerprint
  // changes or their backoff elapses. Runs still freeze the ready policy or
  // fallback state, so retries never change an in-flight or historical result.
  compiledPolicies: defineTable({
    deckHash: v.string(),
    slotId: v.string(),
    templateId: v.union(
      v.literal("ecosystemGrid"),
      v.literal("prisonersDilemma"),
      v.literal("matrixGame"),
      v.literal("publicGoods"),
    ),
    templateVersion: v.number(),
    compileContextHash: v.optional(v.string()),
    status: v.union(
      v.literal("compiling"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    policy: v.optional(policyIRValidator),
    policyHash: v.optional(v.string()),
    interpreterVersion: v.number(),
    compilerModelId: v.string(),
    compilerFingerprint: v.optional(v.string()),
    compileAttempts: v.optional(v.number()),
    errorCode: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_deck_slot", ["deckHash", "slotId"])
    .index("by_deck_slot_context", [
      "deckHash",
      "slotId",
      "compileContextHash",
    ]),

  // One mutable aggregate beside a sessionMode="workbench" session. The session
  // supplies conversation/observer wiring; this row owns the versioned prompt
  // deck, sparse teacher grants, and honest bench recency.
  simulatorBenches: defineTable({
    sessionId: v.id("sessions"),
    scholarId: v.id("users"),
    activityId: v.id("activities"),
    assignmentId: v.optional(v.id("assignments")),
    effectiveSpec: v.optional(simulatorSpecValidator),
    specVersion: v.optional(v.number()),
    specForkedAt: v.optional(v.number()),
    deck: v.array(deckCardValidator),
    deckVersion: v.number(),
    deckHash: v.string(),
    runGrants: v.array(
      v.object({
        scope: v.union(v.literal("block"), v.literal("week")),
        windowKey: v.string(),
        count: v.number(),
        grantedBy: v.id("users"),
        grantedAt: v.number(),
      }),
    ),
    lastRunId: v.optional(v.id("simulatorRuns")),
    lastBenchActivityAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_session", ["sessionId"])
    .index("by_scholar_activity", ["scholarId", "activityId"])
    .index("by_assignment_scholar", ["assignmentId", "scholarId"]),

  // Reactive run manifest + mutation-owned orchestration row. Launch freezes
  // deck/spec/model/protocol inputs. Private physics state is replaced in place;
  // public queries project it out and expose the bounded scene/summary instead.
  simulatorRuns: defineTable({
    sessionId: v.id("sessions"),
    scholarId: v.id("users"),
    activityId: v.id("activities"),
    assignmentId: v.optional(v.id("assignments")),
    runKind: v.union(v.literal("iteration"), v.literal("season")),
    targetTicks: v.number(),
    deckSnapshot: v.array(deckCardValidator),
    deckVersion: v.number(),
    deckHash: v.string(),
    simulatorSpecSnapshot: simulatorSpecValidator,
    simulatorSpecHash: v.string(),
    compiledPolicyHash: v.optional(v.string()),
    interpreterVersion: v.optional(v.number()),
    compiledPolicySnapshot: v.optional(v.array(compiledPolicySnapshotValidator)),
    hypothesis: v.optional(hypothesisValidator),
    seed: v.string(),
    status: v.union(v.literal("queued"), v.literal("ticking"), v.literal("completed"), v.literal("halted"), v.literal("crashed")),
    haltReason: v.optional(v.union(v.literal("scholar_stop"), v.literal("teacher_pause"), v.literal("budget"), v.literal("terminal_physics"))),
    nextTick: v.number(), attempt: v.number(), leaseUntil: v.optional(v.number()),
    leasedAt: v.optional(v.number()), workId: v.optional(v.string()),
    stopRequestedAt: v.optional(v.number()), pauseRequestedAt: v.optional(v.number()),
    chunkCount: v.number(), latestCommittedTick: v.number(),
    latestChunkStartTick: v.optional(v.number()), latestCheckpointTick: v.optional(v.number()),
    latestSnapshotJson: v.string(), latestSceneJson: v.string(),
    currentMetrics: v.array(metricValueValidator), summarySeries: v.array(metricSampleValidator),
    criterionScores: v.array(metricValueValidator), extinct: v.optional(v.boolean()),
    invalidActionCount: v.number(), modelCallCount: v.number(), decisionCacheHitCount: v.number(),
    attemptLog: v.array(v.object({
      startTick: v.number(), attempt: v.number(),
      outcome: v.union(v.literal("provider_error"), v.literal("lease_expired"), v.literal("worker_crash")),
      errorCode: v.optional(v.string()), errorMessage: v.optional(v.string()),
      usage: v.optional(usageValidator), at: v.number(),
    })),
    budgetState: v.union(v.literal("reserved"), v.literal("released")),
    budgetBlockKey: v.string(), budgetWeekKey: v.string(), blockLimitSnapshot: v.number(),
    weekLimitSnapshot: v.number(), reservationReleasedAt: v.optional(v.number()),
    modelId: v.string(), simulatorProtocolVersion: v.number(),
    promptProtocolVersion: v.number(),
    decisionHashVersion: v.number(), physicsTemplateVersion: v.number(), rendererProtocolVersion: v.number(),
    tournamentId: v.optional(v.id("tournaments")), tournamentPairingKey: v.optional(v.string()),
    queuedAt: v.number(), startedAt: v.optional(v.number()), lastCommittedAt: v.optional(v.number()),
    endedAt: v.optional(v.number()), updatedAt: v.number(), errorCode: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  })
    .index("by_session", ["sessionId", "queuedAt"])
    .index("by_session_status", ["sessionId", "status", "queuedAt"])
    .index("by_scholar", ["scholarId", "queuedAt"])
    .index("by_scholar_status", ["scholarId", "status", "queuedAt"])
    .index("by_activity", ["activityId", "queuedAt"])
    .index("by_assignment", ["assignmentId", "queuedAt"])
    .index("by_tournament", ["tournamentId", "queuedAt"])
    .index("by_status_queue", ["status", "queuedAt"])
    .index("by_status_lease", ["status", "leaseUntil"])
    .index("by_assignment_status", ["assignmentId", "status", "queuedAt"])
    .index("by_scholar_assignment_block", ["scholarId", "assignmentId", "budgetBlockKey", "budgetState", "queuedAt"])
    .index("by_scholar_assignment_week", ["scholarId", "assignmentId", "budgetWeekKey", "budgetState", "queuedAt"]),

  simulatorRunChunks: defineTable({
    runId: v.id("simulatorRuns"),
    scholarId: v.id("users"),
    startTick: v.number(), endTick: v.number(), attempt: v.number(),
    ticks: v.array(tickRecordValidator),
    initialCheckpoint: v.optional(v.object({ tick: v.number(), stateJson: v.string(), sceneJson: v.string(), stateHash: v.string() })),
    checkpoint: v.optional(v.object({ tick: v.number(), stateJson: v.string(), sceneJson: v.string(), stateHash: v.string() })),
    chunkHash: v.string(), createdAt: v.number(),
  }).index("by_run_startTick", ["runId", "startTick"]),

  // One teacher-launched cohort round-robin. Entrants freeze the submitted
  // bench deck; pairings point at ordinary simulatorRuns; standings name decks,
  // never scholars. Scholar identity stays server-side and appears only in the
  // teacher-gated projection in convex/tournaments.ts.
  tournaments: defineTable({
    assignmentId: v.id("assignments"),
    activityId: v.id("activities"),
    createdBy: v.id("users"),
    status: v.union(
      v.literal("draft"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    simulatorSpecSnapshot: simulatorSpecValidator,
    entrants: v.array(
      v.object({
        simulatorBenchId: v.id("simulatorBenches"),
        scholarId: v.id("users"),
        sessionId: v.id("sessions"),
        deckLabel: v.string(),
        deckSnapshot: v.array(deckCardValidator),
        deckVersion: v.number(),
        deckHash: v.string(),
        compiledPolicySource: v.optional(
          v.object({
            deckHash: v.string(),
            slotId: v.string(),
          }),
        ),
      }),
    ),
    pairings: v.array(
      v.object({
        pairingKey: v.string(),
        simulatorEntrantABenchId: v.id("simulatorBenches"),
        simulatorEntrantBBenchId: v.id("simulatorBenches"),
        status: v.union(
          v.literal("pending"),
          v.literal("queued"),
          v.literal("ticking"),
          v.literal("completed"),
          v.literal("failed"),
        ),
        simulatorRunId: v.optional(v.id("simulatorRuns")),
      }),
    ),
    standings: v.array(
      v.object({
        simulatorBenchId: v.id("simulatorBenches"),
        deckLabel: v.string(),
        matchesPlayed: v.number(),
        wins: v.number(),
        draws: v.number(),
        losses: v.number(),
        totalScore: v.number(),
        cooperationRate: v.number(),
        forgivenessEvents: v.number(),
        populationShare: v.optional(v.number()),
      }),
    ),
    // Generation 0 is an equal population. The following twenty-four deterministic
    // replicator updates make the tournament's strategy ecology inspectable.
    replicatorGenerations: v.optional(
      v.array(
        v.object({
          generation: v.number(),
          shares: v.array(
            v.object({
              simulatorBenchId: v.id("simulatorBenches"),
              populationShare: v.number(),
            }),
          ),
        }),
      ),
    ),
    standingsCollapsed: v.boolean(),
    createdAt: v.number(),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_assignment", ["assignmentId", "createdAt"])
    .index("by_status", ["status", "updatedAt"]),

  // ─── Games — the sibling primitive to manipulatives ────────────────
  //
  // One scholar's pass through a kind="game" activity. NOT a `sessions`
  // row: `sessions` means "a conversation with the tutor" (messages,
  // artifacts, whispers, analyses, streaming state) and every consumer
  // assumes that. A game session has no conversation — it has an
  // append-only event log. Same reason `webActivitySessions` is already
  // its own table.
  //
  // THE INVARIANT THIS TABLE EXISTS TO HOLD: a game emits EVIDENCE; the
  // server draws conclusions. Nothing in the completion path for one of
  // these rows may reach a mastery writer. Skill credit comes from ordinary
  // practice, full stop. A game is deliberately adjacent to the skills it
  // touches (a practice beat is bound to skillKeys, and the scheduler keeps
  // serving fresh, cold, unassisted items on those same skills), so the practice
  // engine is already the transfer instrument — green is minted only by later
  // bare reps. There is no separate "transfer item" mechanism, and none is
  // planned: building one would duplicate the scheduler. See
  // lib/games/contract.ts.
  //
  // A ROUND IS NEVER RESUMED. Interrupted, crashed and abandoned rounds
  // are closed and digested where they stopped; the scholar starts a
  // fresh one. The evidence is what is durable, not the position.
  gameSessions: defineTable({
    scholarId: v.id("users"),
    activityId: v.id("activities"),
    assignmentId: v.optional(v.id("assignments")),
    // Denormalized from the activity at start so evidence stays readable
    // even after the activity is re-pointed at a different game.
    gameId: v.string(),
    // The module's manifest version at the time this session started.
    // Provenance for the evidence, not a compatibility gate — nothing is
    // ever loaded back into a running game.
    gameVersion: v.number(),
    // The activity's authored config, FROZEN at start. Read back when the
    // digest is built, so a mid-round teacher edit cannot reinterpret a
    // finished round under different rules (e.g. re-price a rocket).
    configJson: v.string(),
    // Stable per session. Server-generated — a client never picks its own
    // seed, so the same round cannot be re-rolled for a better draw.
    seed: v.string(),
    // The game's final runtime state, as JSON, written ONCE at completion.
    // OPAQUE to the server: never parsed here, never digested, never sent
    // to a teacher surface or a model prompt. Kept as a forensic record
    // only — it is explicitly NOT a resume vehicle.
    finalStateJson: v.optional(v.string()),
    // Highest assigned event seq. Doubles as the optimistic-concurrency
    // token for ingest — a batch stamped with a stale lastSeq is rejected
    // rather than interleaved.
    lastSeq: v.number(),
    // Host-tracked active time (wall clock minus backgrounded time). A
    // game never asserts elapsed time; it has no AppState signal.
    activeMs: v.number(),
    startedAt: v.number(),
    lastActivityAt: v.number(),
    endedAt: v.optional(v.number()),
    // The game's own word for how its round ended. A CLAIM about its own
    // rules — never a grade, never a mastery signal.
    outcomeKey: v.optional(v.string()),
    status: v.union(
      v.literal("active"),
      v.literal("completed"),
      // The host's error boundary caught a crash in the game's renderer.
      // The session is closed honestly rather than left dangling; the
      // evidence collected up to that point is still valid.
      v.literal("crashed"),
      // Ended without completing: the scholar backed out, or a new round
      // of the same activity superseded it. Same treatment as a crash —
      // closed, digested, and never resumed.
      v.literal("abandoned"),
    ),
  })
    .index("by_scholar", ["scholarId", "startedAt"])
    .index("by_scholar_activity", ["scholarId", "activityId"])
    .index("by_activity", ["activityId"])
    .index("by_assignment", ["assignmentId"]),

  // The append-only evidence log. One row per event, `seq` contiguous
  // from 1 within a session, assigned server-side. This is the only
  // record the digest is ever built from — the state blob above is not
  // an input. Rows are never updated or deleted.
  //
  // `payloadJson` is one of the ten closed `GameEventPayload` shapes in
  // lib/games/contract.ts, validated at ingest. `eventKey` must appear in
  // the game's server-owned evidence plan (lib/games/catalog.ts) — a game
  // labels nothing about itself for the tutor.
  gameEvents: defineTable({
    sessionId: v.id("gameSessions"),
    scholarId: v.id("users"),
    seq: v.number(),
    eventKey: v.string(),
    payloadJson: v.string(),
    // WHO did the thing. A game with an opponent (a bot taking a turn)
    // would otherwise log the machine's move indistinguishably from the
    // scholar's, and every downstream reading — the digest, a teacher's
    // review, anything a tutor is later told — would attribute it to the
    // child. Not a formatting nicety: a false claim about a kid's
    // thinking. Defaulted server-side, never inferred from absence.
    actor: v.union(v.literal("scholar"), v.literal("opponent"), v.literal("system")),
    // Host-derived active time when the event happened.
    atActiveMs: v.number(),
    receivedAt: v.number(),
  })
    .index("by_session_seq", ["sessionId", "seq"]),

  // The server-derived digest of a finished session — the ONLY thing
  // that ever leaves a game. Rebuilt deterministically from `gameEvents`
  // at completion (never trusted from the client: the games shape of the
  // rule in lib/manipulative/practiceContract.ts). Read by the teacher
  // review surface; a later prompt builder may read it too, which is
  // exactly why raw game state is not in it.
  gameSessionDigests: defineTable({
    sessionId: v.id("gameSessions"),
    scholarId: v.id("users"),
    activityId: v.id("activities"),
    assignmentId: v.optional(v.id("assignments")),
    gameId: v.string(),
    builtAt: v.number(),
    // A serialized `GameSessionDigest` (lib/games/digest.ts). Stored as
    // JSON so the digest shape can grow without a schema migration; the
    // shape is enforced by the type + its tests, not by the DB.
    digestJson: v.string(),
  })
    .index("by_session", ["sessionId"])
    .index("by_scholar", ["scholarId", "builtAt"])
    .index("by_activity", ["activityId"]),

  // ─── External Apps — standing, scholar-attached external web apps ──
  //
  // The org catalog of launchable external websites (e.g. an external practice site).
  // Distinct from a kind="web" activity: an External App is durable and
  // lives on the scholar's home launcher (a grid of squircles), not on
  // the curriculum plate. Launching one opens the SAME domain-locked
  // native webview and writes the SAME webActivitySessions capture rows.
  // See review/external-apps-launcher.html.
  externalApps: defineTable({
    name: v.string(),
    // Start URL the locked webview opens.
    webUrl: v.string(),
    // Hosts the webview may navigate to — same semantics as
    // activities.webAllowedHosts (bare host matches subdomains; "*."
    // prefixes match subdomains only). Empty/unset = locked to webUrl's
    // host. Enforced by the urlChange watchdog in lib/webAssignment.ts.
    webAllowedHosts: v.optional(v.array(v.string())),
    // Tile icon, resolved through ONE chain that `shared/appTileMark.ts`
    // owns: an uploaded asset → a remote/bundled URL → `iconEmoji` → the
    // name's initial. Emoji is only ever a
    // fallback for a real logo, exactly as institutions.emoji is for a
    // school's uploaded mark, and it is the rung most apps land on: an
    // emoji needs no upload, no third-party request, and renders the same
    // on the web launcher and the native iPad one, online or off.
    iconStorageId: v.optional(v.id("_storage")),
    iconUrl: v.optional(v.string()),
    iconEmoji: v.optional(v.string()),
    // Squircle tint behind an emoji/initial mark (an image gets a white
    // tile). Unset = a stable hue derived from the app's name, so tiles
    // without a chosen brand color still read as distinct apps.
    color: v.optional(v.string()),
    // When true, this app is copied onto every newly-created scholar
    // (and onto existing scholars by the one-shot backfill). Currently no
    // app sets this — the prior default provider was retired as a default (it stays in
    // the catalog but is assigned manually).
    defaultForNewScholars: v.optional(v.boolean()),
    archived: v.optional(v.boolean()),
    createdBy: v.optional(v.id("users")),
    // ── Account-link (login helper) config — Layer 2(a). Where to type on
    //    the login page so the username helper can prefill and the key
    //    button can autofill. Heuristic fallbacks apply when unset.
    loginUrlPattern: v.optional(v.string()),
    usernameSelector: v.optional(v.string()),
    passwordSelector: v.optional(v.string()),
    // Optional declarative auto-login flow id. When set, the native embedded
    // host runs a BUNDLED, app-specific login script (that opens the sign-in
    // UI, fills the fields, checks any required agreement box, and submits)
    // instead of the plain username/password selector prefill. The executable
    // logic lives in reviewed native code (ExternalAppHost) keyed by this id —
    // the DB only stores the discriminator. Currently: "pressReaderLibraryCard"
    // (Hawaii State Public Library card # + PIN). Unset = selector prefill/fill.
    loginFlow: v.optional(v.string()),
    // Where this app's stored login comes from when auto-filling:
    //  • unset / "scholarApp" → the per-scholar scholarApps.loginUsername /
    //    loginPassword (each scholar's own site account).
    //  • "libraryCard" → the scholar's shared users.libraryCredential
    //    (PressReader + any future library-backed app), so one library card
    //    signs in every library app without re-entering it per app.
    credentialSource: v.optional(
      v.union(v.literal("scholarApp"), v.literal("libraryCard")),
    ),
    // Optional native iOS app URL scheme (e.g. "googlesheets://"). When set,
    // the native iPad launcher opens the INSTALLED native app via this scheme
    // instead of the locked webview; the web launcher always opens webUrl.
    // Presence is the only signal — there is no separate "is native" flag and
    // no bundle-id/installed-app detection (tile visibility already comes from
    // staff assignment). Validated to a scheme-URL prefix on write.
    nativeUrlScheme: v.optional(v.string()),
  })
    .index("by_default", ["defaultForNewScholars"])
    .index("by_archived", ["archived"]),

  // Which External Apps a given scholar has on their launcher. A join,
  // not an array on the user: per-scholar enable + "added by whom" want
  // their own row, and the catalog stays authoritative (URL, hosts,
  // icon edited once, reflected everywhere). No `order` — we assume <4
  // apps per scholar, so there's no reordering. Removing a scholar's
  // tile is just deleting their row (never touches the catalog); a
  // default re-seeds only onto NEW scholars.
  scholarApps: defineTable({
    scholarId: v.id("users"),
    appId: v.id("externalApps"),
    // Teacher/admin on/off — hides the tile without losing the link.
    enabled: v.boolean(),
    // How this per-scholar row came to be:
    //  • "default" / "manual" → a DIRECT add (seeded default, or a teacher
    //    added it one-off). These SHOW a tile (subject to `enabled`).
    //  • "grant" → visibility-NEUTRAL. Lazily created ONLY to park a
    //    per-scholar credential for an app the scholar gets via an
    //    `appAudiences` grant (§5). It never forces a tile on its own — the
    //    grant shows the tile — and its stored login is retained even if the
    //    grant is later removed (re-attaches on re-grant).
    source: v.union(
      v.literal("default"),
      v.literal("manual"),
      v.literal("grant"),
    ),
    addedBy: v.optional(v.id("users")),
    // ── Account-link (Layer 2). The username is NOT a secret (helper
    //    prefill; shown to staff). The password is OPT-IN, dev-grade
    //    plaintext, returned ONLY to the owner (autofill) for the key
    //    button — never shown to staff, never sensitive-prod without
    //    encryption. setCredentials is merge-safe (set one, keep other).
    loginUsername: v.optional(v.string()),
    loginPassword: v.optional(v.string()),
  })
    .index("by_scholar", ["scholarId"])
    .index("by_scholar_app", ["scholarId", "appId"])
    .index("by_app", ["appId"]),

  // Bulk grants — "give this app to a whole AUDIENCE" (a scholarGroup or an
  // institution), resolved to launcher tiles at READ time (never fanned out
  // into per-scholar rows). A scholar's launcher is the UNION of every grant
  // that covers them (via their groups + their institution) plus their direct
  // `scholarApps` rows. Membership churn is therefore free: a scholar who
  // joins the Geckos gets every Gecko grant the same second, with no backfill;
  // un-granting deletes ONE row and the tile cleanly disappears for everyone it
  // covered. Credentials never live here — they stay per-scholar on
  // `scholarApps` / `users.libraryCredential`. See
  // review/bulk-external-apps-plan.html §4–5.
  appAudiences: defineTable({
    appId: v.id("externalApps"),
    audienceKind: v.union(v.literal("group"), v.literal("institution")),
    // An id("scholarGroups") or id("institutions"), stored as a plain string
    // so one column covers both audience kinds (paired with audienceKind).
    audienceId: v.string(),
    // Pause a grant without deleting it (mirrors scholarApps.enabled). A
    // disabled grant resolves to no tiles but keeps its place for a later
    // resume — pausing a rollout is a real classroom move.
    enabled: v.boolean(),
    addedBy: v.optional(v.id("users")),
  })
    .index("by_app", ["appId"])
    .index("by_audience", ["audienceKind", "audienceId"]),

  // ─── Custom Apps — bot-installable classroom apps ─────────────────
  //
  // A "custom app" is one a teacher asks the staff aide/Slack bot to
  // "install for a student" that ISN'T a pre-existing website. Two kinds,
  // both reached through ONE url — rabbithole.school/custom-apps?token=
  // <token> — and both installed onto scholars via the SAME External Apps
  // grant system (an `externalApps` catalog row whose `webUrl` is that token
  // url, plus `scholarApps` / `appAudiences` grants):
  //
  //   • kind "static" — a self-contained HTML app (no backend). The bot
  //     vibecodes the HTML inline and stores it HERE (`html`), so a static
  //     app needs NO code change / PR: it's created and installed instantly.
  //     The /custom-apps route renders `html` in a sandboxed iframe.
  //   • kind "coded" — an app that needs persistence / real-time
  //     collaboration / a real backend. The bot dispatches a Copilot cloud
  //     agent to write a real in-repo route (`routePath`), which Andy reviews
  //     and merges. The row is created `status:"building"` and linked to the
  //     dispatch (`featureProposalId`); when that PR MERGES the merge webhook
  //     flips it to `status:"live"` and creates the External-App grants for
  //     the stored install targets (finalizeCodedApp). The /custom-apps route
  //     redirects a coded token to `routePath`.
  //
  // The `token` is an unguessable bearer secret carried in the url; the
  // External-Apps grant is what controls WHICH scholars see the launcher tile.
  // See convex/customApps.ts + convex/lib/customAppTools.ts.
  customApps: defineTable({
    // Unguessable id in the ?token= url. Unique; the route resolves by it.
    token: v.string(),
    name: v.string(),
    kind: v.union(v.literal("static"), v.literal("coded")),
    // "building" — a coded app whose PR hasn't merged yet (tile ungranted).
    // "live" — installed & renderable. "archived" — retired.
    status: v.union(
      v.literal("building"),
      v.literal("live"),
      v.literal("archived"),
    ),
    // kind "static": the app IS this self-contained HTML (rendered in a
    // sandboxed iframe by the /custom-apps route). Size-capped by the tool.
    html: v.optional(v.string()),
    // kind "coded": the in-repo route the token redirects to, e.g.
    // "/custom-apps/collab-whiteboard". Written by the dispatched PR.
    routePath: v.optional(v.string()),
    // The catalog row created when the app goes live (the launcher tile). A
    // static app has this from creation; a coded app gets it on finalize.
    externalAppId: v.optional(v.id("externalApps")),
    // kind "coded" provenance: the dispatch whose PR builds this app. The
    // merge webhook finds the pending row by this id.
    featureProposalId: v.optional(v.id("featureProposals")),
    // Where this app should be installed once live. For a static app the
    // grants are created immediately, but we still record the intent; for a
    // coded app finalizeCodedApp reads these to create the grants on merge.
    installScholarIds: v.optional(v.array(v.id("users"))),
    installGroupIds: v.optional(v.array(v.id("scholarGroups"))),
    createdBy: v.optional(v.id("users")),
  })
    .index("by_token", ["token"])
    .index("by_featureProposal", ["featureProposalId"])
    .index("by_status", ["status"]),

  // ─── Assignments — execution instances ──────────────────────────
  //
  // An Assignment is a unit being run with a specific cohort of
  // scholars. It's the pivot between Curriculum (Design) and
  // everything execution-flavored — projects, deliverables,
  // completions, share-back digests all stamp `assignmentId` so the
  // same unit can be run multiple times (different cohorts, different
  // teachers, different semesters) without anyone's work bleeding
  // across runs.
  //
  // Within an Assignment, individual activities are scheduled — each
  // entry in `activitySchedule` says "scholars in the cohort should
  // do this activity right now (classFocus)" or "this activity is on
  // their plate to finish (homework)". An activity can only appear
  // once per Assignment; flipping it from homework → class focus
  // updates the existing entry. Multiple class-focus and multiple
  // homework pushes can coexist within one Assignment (the "two
  // cards rule" + multi-activity).
  //
  // See review/design-vs-execution-split.md.
  assignments: defineTable({
    teacherId: v.id("users"),
    // Optional (the Wave-2 widen): a "unit" assignment always carries one;
    // a "standing" assignment (practiceMode below) has NO unit at all — it
    // follows the scholar's own DAG frontier via practiceConfig instead.
    // Every reader that treats this as always-defined must guard it (see
    // review/practice/practice-engine-roadmap.html §10).
    unitId: v.optional(v.id("units")),
    scholarIds: v.array(v.id("users")),
    // Immutable provenance for an assignment published through an explicitly
    // coached Extended education group. The scholarIds snapshot remains the
    // execution roster; later group membership changes never widen old work.
    scholarGroupId: v.optional(v.id("scholarGroups")),
    // Simulator run limits are execution policy, not curriculum authorship. Absent
    // rows use conservative engine defaults; grants remain scholar-bench-local.
    simulatorRunBudget: v.optional(
      v.object({
        perScholarBlock: v.number(),
        perScholarWeek: v.number(),
        timeZone: v.optional(v.string()),
      }),
    ),
    // Durable teacher pause latch for the cohort's Simulator runs (plan §8 Assign).
    // ADDITIVE + absent == not paused. Checked by launchRun so "Pause all" also
    // blocks NEW launches, not just in-flight runs; resume clears it and any
    // pending per-run pause markers so ticking runs are not stranded.
    simulatorRunsPaused: v.optional(v.boolean()),
    // Per-assignment season length override (plan §8 Assign). ADDITIVE + absent
    // == use the Simulator spec's own seasonTicks. launchRun clamps it to the spec's
    // absolute max so an override can never exceed the template's hard ceiling.
    simulatorSeasonTicks: v.optional(v.number()),
    // Optional display label — defaults to the unit title.
    title: v.optional(v.string()),
    // Discriminates the KIND of assignment for surfaces that must tell a
    // one-off teacher dispatch apart from a unit run or standing practice
    // (including an individually dispatched activity or a scheduled group skill).
    // ADDITIVE + absent
    // == infer from unitId/practiceMode (a normal unit or standing
    // assignment, today's default). "adHocDispatch" = a unit-less one-off
    // activity a teacher/bot dispatched directly (Q1 in
    // review/scheduling-model-sketches.html). It complements practiceMode
    // (which is unit-vs-standing for the practice engine); this is the
    // provenance discriminator the schedule surfaces read.
    kind: v.optional(
      v.union(
        v.literal("unit"),
        v.literal("standing"),
        v.literal("adHocDispatch"),
      ),
    ),
    // ── Practice lane (Wave-0 additive; runtime is Wave-2) ──────────────
    // "unit" (the default/today: a normal unit assignment) vs "standing"
    // (an open-ended per-domain practice assignment with no fixed unit).
    // Absent == "unit".
    practiceMode: v.optional(
      v.union(v.literal("unit"), v.literal("standing")),
    ),
    // Config for a standing-practice assignment (which domain/strands to
    // pull from + a daily goal). Ignored for practiceMode "unit".
    practiceConfig: v.optional(
      v.object({
        domain: v.string(),
        // A MIXED-domain playlist: the set of practice domains this standing
        // assignment blends (a single interleaved session drawing due reviews +
        // frontier work across all of them). Additive + back-compat: when absent
        // or of length ≤1 the assignment is single-domain (uses `domain` above);
        // when it has ≥2 entries the practice engine runs the mixed-domain merge.
        // `domain` stays populated (the first/primary domain) so every existing
        // single-domain reader keeps working unchanged.
        domains: v.optional(v.array(v.string())),
        dailyGoalMinutes: v.optional(v.number()),
        pinnedStrands: v.optional(v.array(v.string())),
        excludedStrands: v.optional(v.array(v.string())),
      }),
    ),
    startedAt: v.number(),
    // Soft-archived: shown in history, hidden from active lists.
    archivedAt: v.optional(v.number()),
    // Self-paced assignments (onboarding) expose the whole unit to the
    // scholar-facing readers. `activitySchedule` still drives plate cards +
    // the class-focus lock, but progress/next/browse do not filter to it.
    selfPaced: v.optional(v.boolean()),
    // Per-activity scheduling state. Empty array = the cohort is on
    // the unit broadly but no specific activity has been pushed yet.
    // Entries can be added by:
    //   - the dialog at create time (auto-fills from each activity's
    //     defaultMode — homework activities land here immediately)
    //   - the Run page (teacher pushes/clears per activity)
    //   - the calendar/agenda (teacher PLANS a future push)
    //
    // An entry is LIVE to scholars only when `setAt` is stamped.
    // `startsAt` is the *planned* time (agenda position) and is
    // harmless on its own — a planned entry (startsAt set, setAt null)
    // is visible to the teacher on the agenda but NOT to scholars,
    // until either its activation job fires at a future startsAt or the
    // teacher hits "Start now". See review/calendar-view-plan.md.
    activitySchedule: v.optional(
      v.array(
        v.object({
          activityId: v.id("activities"),
          mode: v.union(v.literal("classFocus"), v.literal("homework")),
          // When this entry went LIVE to scholars. Absent = planned,
          // not-yet-live (agenda-only). Optional for that reason.
          setAt: v.optional(v.number()),
          // Planned time — when the teacher intends it to go live.
          // Drives agenda position; editing it never auto-pushes.
          startsAt: v.optional(v.number()),
          // Pending activation job (so reschedule/cancel can stop it).
          scheduledFnId: v.optional(v.id("_scheduled_functions")),
          endsAt: v.optional(v.number()), // classFocus auto-clear
          dueAt: v.optional(v.number()),  // homework due date
          // ─── Per-scholar targeting (divide & conquer / trimmed choice) ──
          // Optional narrowing of who this activity is live for. ABSENT (or
          // empty) = cohort-wide, exactly today's behavior — every reader
          // assumes this. PRESENT & non-empty = only these scholars see this
          // activity live; it's dropped from everyone else's plate/progress.
          // MUST be a subset of the assignment's `scholarIds` (kept in sync
          // when the roster shrinks — see applySetScholars). Enables
          // divide & conquer (option A → some scholars, option B → others)
          // and teacher-trimmed choice without a new table. See
          // review/activity-choice-plan.html.
          scholarIds: v.optional(v.array(v.id("users"))),
        }),
      ),
    ),
  })
    .index("by_practice_mode", ["practiceMode"])
    .index("by_teacher", ["teacherId"])
    .index("by_scholar_group", ["scholarGroupId"])
    .index("by_unit", ["unitId"])
    .index("by_teacher_started", ["teacherId", "startedAt"]),

  // ───────────────────────── PUSHES ─────────────────────────
  // "This, to these scholars, right now." The single way a teacher says
  // something is live — replacing `assignments.activitySchedule`, which
  // could only ever point at an ACTIVITY inside a UNIT inside an
  // ASSIGNMENT. See review/class-focus-rethink.html.
  //
  // Three unions, each removing a coupling the old shape hardcoded:
  //   target   — WHAT (was: a bare activityId)
  //   audience — WHO  (was: the assignment's snapshot roster, narrowed)
  //   timing   — WHEN (was: mode + endsAt + dueAt, three fields held
  //              together by hand-written guards in every write path)
  //
  // ROWS ARE NEVER DELETED. Expiry and "wrap it up" stamp `clearedAt`
  // and drop out of live reads; the row survives as the event record of
  // what a class was shown and when. This is a DELIBERATE departure from
  // the old autoClearActivity, which filtered the entry out of the array
  // and destroyed it — making a minted throwaway activity the only
  // surviving trace. A definition is not an event; this table is the
  // event.
  pushes: defineTable({
    institutionId: v.id("institutions"),

    // ── WHAT ──
    target: v.union(
      v.object({
        kind: v.literal("activity"),
        activityId: v.id("activities"),
      }),
      v.object({
        kind: v.literal("app"),
        externalAppId: v.id("externalApps"),
      }),
      v.object({
        kind: v.literal("resource"),
        resourceId: v.id("activityResources"),
      }),
      v.object({
        kind: v.literal("link"),
        url: v.string(),
        title: v.string(),
        media: v.optional(
          v.union(v.literal("video"), v.literal("page")),
        ),
      }),
    ),

    // ── WHO ──
    // Resolved LIVE at read time, never fanned out into per-scholar rows.
    // A push is standing intent for the minutes it is open, so a scholar
    // who joins Geckos mid-period sees it and one who leaves stops — the
    // same reasoning as appAudiences. Contrast assignments.scholarIds,
    // which deliberately SNAPSHOTS because an assignment is a historical
    // execution record.
    audience: v.union(
      v.object({
        kind: v.literal("scholars"),
        scholarIds: v.array(v.id("users")),
      }),
      v.object({
        kind: v.literal("group"),
        groupId: v.id("scholarGroups"),
      }),
      v.object({
        kind: v.literal("institution"),
      }),
      // "Everyone this assignment is currently for." The roster lives on
      // `assignments.scholarIds` and is itself a deliberate snapshot — it
      // moves only when a teacher explicitly changes it, never by group
      // drift — so resolving it live here does NOT reintroduce the widening
      // that snapshot was protecting against. It reproduces exactly what
      // `activitySchedule` did: cohort-wide meant "no stored list", read
      // against the roster of the moment, so a scholar added to the cohort
      // while a focus is open sees it.
      //
      // Storing the roster inline instead would freeze it, and a teacher
      // adding a late arrival mid-period would have to re-push to reach them.
      v.object({
        kind: v.literal("assignment"),
        assignmentId: v.id("assignments"),
      }),
    ),

    // ── WHEN ──
    // focus        = a window that CLOSES (endsAt REQUIRED — this is what
    //                makes auto-expiry a guarantee rather than a UI default)
    // untilCleared = the focus lane WITHOUT a clock: live until the scholar
    //                completes it or a teacher wraps it up
    // homework     = a deadline to MEET
    //
    // `untilCleared` is not a weaker `focus`; it is a different promise, and
    // the two must not be collapsed. Expiry here is DESTRUCTIVE — a closed
    // focus drops out of the plate and takes any in-progress row with it
    // (see scholarPlate's mode gate). That is correct for "the class is on
    // this for 40 minutes" and wrong for a DISPATCH, where a teacher hands
    // one scholar a bespoke activity and the lock is meant to release on
    // completion, not on a timer. Forcing a window onto a dispatch deletes a
    // scholar's half-finished work out from under them.
    //
    // Note the asymmetry with homework, whose deadline is OPTIONAL for a
    // different reason. Homework never expires — being overdue is the
    // signal, so the row stays on the plate either way — which means a
    // deadline is display and ordering only, never liveness. Work published
    // to a program group (assignProgramActivity) is genuinely open-ended:
    // it is available until a teacher ends it, and the plate already renders
    // that row with no due chip. Inventing a deadline for it would put a
    // fictional date in front of a scholar. Undated homework sorts last —
    // no deadline is the least urgent thing in the lane, not the most.
    timing: v.union(
      v.object({ kind: v.literal("focus"), endsAt: v.number() }),
      v.object({ kind: v.literal("untilCleared") }),
      v.object({
        kind: v.literal("homework"),
        dueAt: v.optional(v.number()),
      }),
    ),

    // Does this take over the scholar's home ("finish this first")?
    // INDEPENDENT of `target` — blocking is teacher intent, while what
    // RELEASES the block is derived from the target. v1 only permits
    // true for activity targets, because their per-scholar clear stamp
    // already exists in activityCompletions; a blocking app/link would
    // need a per-scholar clear record, which is a deliberate follow-up.
    blocking: v.boolean(),

    // "Watch this before we start." The teacher's voice on the card.
    note: v.optional(v.string()),

    // ── Lifecycle (semantics lifted verbatim from activitySchedule) ──
    // Stamped = LIVE to scholars. Absent = planned, agenda-only.
    setAt: v.optional(v.number()),
    // Planned time. Drives agenda position; editing never auto-pushes.
    startsAt: v.optional(v.number()),
    // Pending activation job, so reschedule/cancel can stop it.
    scheduledFnId: v.optional(v.id("_scheduled_functions")),

    // Soft close. Absent = still open. Never deleted.
    clearedAt: v.optional(v.number()),
    clearedReason: v.optional(
      v.union(
        v.literal("expired"),
        v.literal("teacher"),
        v.literal("superseded"),
      ),
    ),

    // Provenance when this push came from unit work, so the Run page,
    // progress roll-ups and the parent letter keep their assignment
    // context. Absent for an ad-hoc push (an app, a video, a link),
    // which is exactly the case the old shape could not represent.
    assignmentId: v.optional(v.id("assignments")),

    pushedBy: v.id("users"),

    // MIGRATION SCAFFOLDING — delete with `activitySchedule` itself.
    // True on a row this table maintains as a mirror of an
    // `assignments.activitySchedule` entry, so the mirror sync can find
    // and update its own rows without ever touching a genuine push. The
    // two are otherwise indistinguishable: makeFocus takes an optional
    // assignmentId, so a teacher featuring an activity from the Run page
    // can produce the same (assignmentId, activityId) pair a mirror uses.
    // See TODO.html#pushes-migrate-activity-schedule.
    scheduleMirror: v.optional(v.boolean()),

    // Provenance + dedup key for a row the MASTER SCHEDULE materializer
    // (masterSchedule.reconcilePlacement) owns, distinct from scheduleMirror
    // above: a schedulePlacements row carrying an `externalAppId` (the
    // "standing assignment" shape — LEGO SPIKE live for Robotics' Block E)
    // materializes into exactly one open push per (placement, occurrence),
    // found by this field the same way `scheduleMirror` rows are found by
    // (assignmentId, activityId, blocking). Set ONLY by the master-schedule
    // materializer; a teacher's own makeFocus never stamps it. Absent on
    // every other push, including a genuine teacher-pushed app focus.
    schedulePlacementId: v.optional(v.id("schedulePlacements")),

    // WINDOW IDENTITY for a schedulePlacementId row (QB ruling, round 3 of
    // the app-access review): the OCCURRENCE this push belongs to, as the
    // local calendar date (a day-key string, e.g. "2026-08-24") in the
    // placement's institution timezone — NOT startsAt. A teacher editing the
    // block's start/end mid-week is still "this same occurrence, at a
    // different time": identity — and therefore a teacher-clear's
    // terminality — must survive that edit, so it cannot be keyed on a
    // mutable clock field. A placement moved to a different CALENDAR DAY is
    // a genuinely new occurrence and gets a fresh row. See the "App-target
    // placements" section header in masterSchedule.ts for the full
    // invariant. Absent on every push this field's sibling above is absent
    // on too.
    occurrenceDate: v.optional(v.string()),
  })
    // Live reads are institution-scoped: load the open pushes for a
    // school, then match `audience` in JS. Convex cannot index into a
    // union or an array, and the open set is bounded by how many things
    // a school has live at once (single digits), so this is the same
    // read-time resolution appAudiences already does.
    .index("by_institution_cleared", ["institutionId", "clearedAt"])
    .index("by_institution_setAt", ["institutionId", "setAt"])
    .index("by_assignment", ["assignmentId"])
    .index("by_pusher", ["pushedBy"])
    .index("by_schedule_placement", ["schedulePlacementId"])
    // The exact-occurrence lookup + the bounded "recent pushes for this
    // placement" scan both key off this pair — see masterSchedule.ts's
    // findPushForOccurrence / recentPushesForPlacement. Ordered by
    // occurrenceDate, so "most recent" is simply index order, descending.
    .index("by_schedule_placement_occurrence", ["schedulePlacementId", "occurrenceDate"]),

  // (focusSettings dropped — replaced by `assignments`. See
  // review/design-vs-execution-split.md.)

  // Named groups of scholars (geckos / honu / etc.). A teacher assigns
  // an activity to a group, an individual, or any combination — the
  // resulting assignment's scholarIds is the union (resolved in the
  // ScholarPicker UI, not stored as a group ref). Groups are
  // roster-wide: `teacherId` only records the creator. Every teacher
  // sees and can use every group, matching the role-based (not ACL)
  // permission model — `units.list()` works the same way. The
  // per-teacher personalization layer is `teacherAffinities` below.
  scholarGroups: defineTable({
    teacherId: v.id("users"), // creator; NOT an ownership/visibility gate
    // Parent school for institution-scoped grants and access. Optional while
    // legacy groups are stamped lazily by membership mutations.
    institutionId: v.optional(v.id("institutions")),
    name: v.string(),
    emoji: v.optional(v.string()),
    scholarIds: v.array(v.id("users")),
    // Free-form routing tag. Unset or "primary" marks the scholar's age-based
    // main group; any other value is a subject key (e.g. "math").
    type: v.optional(v.string()),
    // Whether this instructional group can include Extended Education scholars.
    // Missing legacy values are enrolled-only; the widening migration stamps
    // existing program groups explicitly before callers rely on this field.
    participation: v.optional(
      v.union(
        v.literal("enrolled_only"),
        v.literal("includes_program_guests"),
      ),
    ),
    // The staff member who RUNS this group — distinct from `teacherId`, which
    // only records who happened to create the row. Still NOT an ACL: every
    // teacher sees and can edit every group. Ownership is a ROUTING fact —
    // it's what makes a group-scoped surface (the Math Skills studio, the
    // Scholars tab) open on the owner's own cohort instead of the whole
    // roster. Optional: an unowned group simply never becomes anyone's
    // default, and every legacy group stays exactly as it is.
    ownerId: v.optional(v.id("users")),
    // Slack channel this group's activity notifications post to (e.g. the
    // #geckos channel). LINKING IS THE OPT-IN — no channel, no
    // notifications, and the general teaching channel never gets
    // unsolicited posts. Set via the bot's link_channel_to_group tool.
    slackChannelId: v.optional(v.string()),
    // "immediate" posts each event as it happens; default (undefined) is
    // the calm daily digest.
    slackNotifyMode: v.optional(
      v.union(v.literal("digest"), v.literal("immediate")),
    ),
    // Standing daily blocks (e.g. the Workshop's "Prep Time" window). WINDOW
    // CONFIG ONLY — never content: each entry is just when a block is live for
    // this group's scholars, and the CLIENT derives the Home pin from local
    // time (no cron, no scheduled functions — §4). DEFAULT OFF: no block
    // unless a teacher sets one. `days` are 1–7 = Mon–Sun (1–5 = Mon–Fri);
    // `timezone` is an IANA string (school is HST). See
    // review/scholar-meta-prep-time-plan.html §4.
    dailyBlocks: v.optional(
      v.array(
        v.object({
          key: v.string(),
          label: v.string(),
          startLocal: v.string(), // "14:30"
          endLocal: v.string(), // "15:00"
          days: v.array(v.number()), // 1–5 = Mon–Fri
          timezone: v.string(), // IANA, e.g. "Pacific/Honolulu"
        }),
      ),
    ),
  })
    .index("by_teacher", ["teacherId"])
    .index("by_institution", ["institutionId"]),

  // Teacher-created multiplayer spaces for vibecoded apps. Assignment rooms
  // auto-bind to every member's session in that assignment; group/explicit
  // rooms are selected by id by apps that deliberately opt into shared state.
  // Membership is stored on the room and is the authorization boundary.
  rooms: defineTable({
    ownerTeacherId: v.id("users"),
    name: v.string(),
    kind: v.union(
      v.literal("assignment"),
      v.literal("group"),
      v.literal("explicit"),
    ),
    assignmentId: v.optional(v.id("assignments")),
    groupId: v.optional(v.id("scholarGroups")),
    memberIds: v.array(v.id("users")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner", ["ownerTeacherId"])
    .index("by_assignment", ["assignmentId"])
    .index("by_group", ["groupId"]),

  // Per-teacher "my scholars" affinity. Convenience only — NOT an ACL.
  // Every teacher still has full read/write on every scholar; this just
  // drives default sort-to-top and an optional "my scholars only"
  // filter in the dashboard + pickers. One row per teacher.
  teacherAffinities: defineTable({
    teacherId: v.id("users"),
    scholarIds: v.array(v.id("users")),
    groupIds: v.array(v.id("scholarGroups")),
  }).index("by_teacher", ["teacherId"]),

  // ═══════════════════════════════════════════════════════════════════════
  // MASTER SCHEDULE (review/master-schedule-plan.html)
  // A term-scoped, recurring WEEKLY TIMETABLE — the surface a small school
  // runs its week from. Two light template tables layered over the shipped
  // execution model:
  //   Layer 1 — scheduleBlocks:     the bell-schedule skeleton (the rows).
  //   Layer 2 — schedulePlacements: recurring class cells (group × weekday ×
  //                                 block), each an avatar-shown teacher +
  //                                 optional link to a live assignment/activity.
  //   Layer 3 — assignments.activitySchedule[] (UNTOUCHED): the absolute-time
  //             per-activity pushes a materialize step stamps a live week into,
  //             reusing the planned≠live safety model (setAt vs startsAt).
  // "Term" is the reporting period reframed in place (zero migration): these
  // tables reference `periodId: reportingPeriods`. The grid is the PLAN; the
  // activitySchedule stays the LIVE truth, bridged by materializeWeek.
  // ═══════════════════════════════════════════════════════════════════════

  // Layer 1 — the bell-schedule skeleton for a Term. One row per time block
  // (Morning Circle, Block A–D, Recess, Lunch, Practice Lab …). Blocks default
  // SHARED across all groups in the term (`groupId` absent); a per-group
  // override row (groupId set) lets one pod run a different block layout. The
  // grid renders these as its rows, ordered by `order`.
  scheduleBlocks: defineTable({
    periodId: v.id("reportingPeriods"), // the Term this schedule belongs to
    // Absent = shared across every group in the term (the default). Set = a
    // per-group override block (only appears in that group's lens).
    groupId: v.optional(v.id("scholarGroups")),
    key: v.string(), // stable slug, e.g. "blockA"
    label: v.string(), // display, e.g. "Block A"
    startLocal: v.string(), // "08:30" (school-local wall time)
    endLocal: v.string(), // "09:40"
    weekdays: v.array(v.number()), // 1–5 = Mon–Fri (7 = Sun)
    order: v.number(), // vertical position in the grid
    // Coverage target: how many distinct adults this block needs (default 1;
    // recess/lunch typically 2). Drives the derived staffing rail (§10).
    staffNeed: v.optional(v.number()),
    // Non-class rows render as spanning bands, not droppable cells.
    // "homework" is a VIRTUAL top-of-week due rail (Q3 in
    // review/scheduling-model-sketches.html): a single per-term block that
    // homework-mode placements pin their due day to, so homework shows as
    // due-work above the bell schedule WITHOUT consuming a room-time slot,
    // while preserving the both-weekday-and-blockId placed invariant.
    kind: v.optional(
      v.union(
        v.literal("class"),
        v.literal("recess"),
        v.literal("lunch"),
        v.literal("prep"),
        v.literal("homework"),
      ),
    ),
  })
    .index("by_period", ["periodId"])
    .index("by_period_group", ["periodId", "groupId"]),

  // Layer 2 — a recurring class pinned to a slot: (group × weekday × block).
  // Every filled cell in the grid is one of these. `weekday`/`blockId` BOTH
  // null ⇒ the placement is on the SHELF (tentatively scheduled, not yet
  // dropped onto a day). A placement is pure structure by default — a subject
  // label + optional teacher (shown as an avatar, never a color fill). It only
  // touches the live push layer when it links an `assignmentId` + `activityId`
  // and a week is materialized.
  schedulePlacements: defineTable({
    periodId: v.id("reportingPeriods"),
    groupId: v.id("scholarGroups"),
    // Null ⇒ shelf. Both are set together (a placed cell) or both null (shelf).
    weekday: v.optional(v.number()), // 1–5
    blockId: v.optional(v.id("scheduleBlocks")),
    subject: v.string(), // "Math Workshop"
    // Optional (avatar shown when present). A bare class (PE, Art, Recess
    // coverage) can have a teacher but no Rabbithole content.
    teacherId: v.optional(v.id("users")),
    // Optional link to a live assignment (cohort × unit) and one of its
    // activities. When BOTH are present + the cell is placed, materializeWeek
    // stamps this activity into that assignment's activitySchedule for the week.
    assignmentId: v.optional(v.id("assignments")),
    activityId: v.optional(v.id("activities")),
    // Optional link to a catalog app (LEGO SPIKE, Math Academy, …) instead of
    // curriculum content — the "standing assignment" shape: a recurring block
    // (Robotics' Block E) grants the group's scholars an app tile for exactly
    // the block's local window. MUTUALLY EXCLUSIVE with activityId — enforced
    // in the write path (corePlaceClass / coreUpdatePlacement), not here,
    // because a schema union would fork every other optional field on this
    // table into two shapes for no reader's benefit. When set, the
    // materializer (masterSchedule.reconcilePlacement) creates/clears a
    // `pushes` row (target kind "app") at the block's local start/end instead
    // of calling applyScheduleActivity — see
    // review/app-access-unification-plan.html §robotics.
    externalAppId: v.optional(v.id("externalApps")),
    // How a materialized push behaves. Default classFocus (in-room).
    mode: v.optional(v.union(v.literal("classFocus"), v.literal("homework"))),
    spanBlocks: v.optional(v.number()), // double period (spans N block rows)
    note: v.optional(v.string()), // free note (shelf items: "sometime wk 4")
    // ── Unit-cascade + concrete-week fields (Q2 in
    // review/scheduling-model-sketches.html). ALL additive/optional; absent
    // reproduces today's recurring-shell behavior. ────────────────────────
    // The concrete week this chip belongs to (Monday 00:00 school-local,
    // epoch-ms). Absent = a recurring shell that applies to every week
    // (today's default). Set = a week-specific materialized instance.
    weekStartMs: v.optional(v.number()),
    // Groups the placements a single unit-drop cascaded — for bulk move,
    // undo, labeling, and the out-of-order flag. A random slug minted per
    // cascade. NOT a recurrence rule: the rows are the source of truth.
    sequenceId: v.optional(v.string()),
    // 0-based position of this activity within its cascade sequence.
    sequenceIndex: v.optional(v.number()),
    // The teacher accepted this chip's actual (weekday/block/week) order even
    // though it differs from sequenceIndex — suppress the out-of-order flag.
    orderOverride: v.optional(v.boolean()),
    // Flag ids the teacher explicitly dismissed/silenced on this cell
    // (conflict / out-of-order) so they don't re-raise.
    dismissedFlags: v.optional(v.array(v.string())),
    // Which generator produced this row — for explanation/labeling only,
    // NEVER re-run to regenerate children (no hidden recurrence engine).
    createdFromStrategy: v.optional(
      v.union(
        v.literal("contiguous"),
        v.literal("daily"),
        v.literal("unitPacing"),
        // The class-anchored flow (Phase 2): activities land on the class's own
        // weekly meetings, one per meeting. Additive — legacy values kept for
        // already-cascaded rows (explanation-only; never re-run to regenerate).
        v.literal("classMeetings"),
        // The "all on one day" layout: every activity of a unit lands on the
        // SAME chosen weekday/block/week (the secondary choice to Flow).
        v.literal("sameDay"),
        v.literal("chat"),
      ),
    ),
  })
    .index("by_period", ["periodId"])
    .index("by_period_group", ["periodId", "groupId"])
    .index("by_block", ["blockId"])
    .index("by_teacher", ["teacherId"])
    .index("by_activity", ["activityId"])
    .index("by_assignment", ["assignmentId"])
    .index("by_sequence", ["sequenceId"]),

  // Teacher-flagged tutor moments inside a test-drive session (Test Drive
  // phase 3). The teacher clicks 👍 / 👎 on a tutor message to mark it as
  // good or bad; Curriculum Bot reads these flags alongside the transcript
  // when refining the activity's systemPrompt. Only valid against projects
  // with `isTestDrive: true`. One flag per (project, message) — re-flagging
  // toggles or replaces.
  testDriveFlags: defineTable({
    sessionId: v.id("sessions"),
    messageId: v.id("messages"),
    teacherId: v.id("users"),
    kind: v.union(v.literal("good"), v.literal("bad")),
    note: v.optional(v.string()),
  })
    .index("by_session", ["sessionId"])
    .index("by_message", ["messageId"]),

  // Scholar-authored "Rabbithole got this wrong" flags. A scholar clicks the
  // got-it-wrong control on a tutor (assistant) message in their OWN live
  // session to flag the AI's output as wrong. This is the pro-skepticism
  // signal of the anti-parasocial initiative: catching the AI is a WIN — it
  // fights automation bias / oracle-trust (Rabbithole is a tool to be
  // outgrown). One flag per (scholar, message); re-clicking toggles it off
  // (reversible). Surfaces to the teacher in the session transcript +
  // a "caught the AI" count on the scholar's profile. Distinct from
  // testDriveFlags (a teacher curriculum-design tool); these are real
  // scholar corrections on live work and are NOT accepted on test-drive
  // sessions.
  messageFlags: defineTable({
    sessionId: v.id("sessions"),
    messageId: v.id("messages"),
    scholarId: v.id("users"),
    // Optional free-text "why" the scholar thought it was wrong. The control
    // ships flag-first (one tap); a reason can be added later without a
    // schema change.
    reason: v.optional(v.string()),
  })
    .index("by_session", ["sessionId"])
    .index("by_message", ["messageId"])
    .index("by_scholar", ["scholarId"]),

  processes: defineTable({
    teacherId: v.id("users"),
    title: v.string(),
    slug: v.optional(v.string()),
    emoji: v.optional(v.string()),
    description: v.optional(v.string()),
    systemPrompt: v.optional(v.string()),
    steps: v.array(
      v.object({
        key: v.string(),
        title: v.string(),
        description: v.optional(v.string()),
      })
    ),
    isActive: v.boolean(),
  })
    .index("by_teacher", ["teacherId"])
    .index("by_active", ["isActive"])
    .index("by_slug", ["slug"]),

  artifacts: defineTable({
    sessionId: v.id("sessions"),
    title: v.string(),
    content: v.string(),
    lastEditedBy: v.union(v.literal("scholar"), v.literal("ai")),
    // TRUE while this document still contains words the tutor typed on the
    // scholar's behalf, via edit_document's "transcribe" command (a
    // transcription accommodation for scholars whose typing, not whose
    // thinking, is the bottleneck). `lastEditedBy` is binary and so conflates
    // AI-authored with AI-transcribed; this separates them, because the rubric
    // grades this text and a portrait the scholar recognizes as theirs must not
    // quietly blur who put the words down.
    //
    // It describes the TEXT, not the document's history: it is recomputed on
    // every scholar edit against `tutorTranscribedExcerpts`, so a scholar who
    // rewrites the transcribed passage in their own words clears it and gets
    // full credit for their own authorship.
    //
    // Read this as a positive signal only: when set, the tutor did transcribe.
    // When absent it does NOT prove the scholar typed everything themselves —
    // the tutor occasionally reaches for a generic edit command instead of
    // `transcribe`, so the marker under-reports. Never invert it into a claim
    // of unaided authorship.
    hasTutorTranscription: v.optional(v.boolean()),
    // The exact passages the tutor transcribed, kept so the marker above can be
    // re-verified against the live content after a scholar edit. Pruned to the
    // ones still present; absent on rows that never had a transcription.
    tutorTranscribedExcerpts: v.optional(v.array(v.string())),
    // Plain text/code documents use optimistic concurrency. Legacy rows omit
    // this until their first compatible edit; structured artifacts own their
    // separate update contracts.
    revision: v.optional(v.number()),
    // "map" artifacts store a JSON `StoredMapArtifact` ({ v, spec, scholarPins })
    // in `content` — the GeoMap surface. Written only by the show_map tool
    // (spec) + scholarSetMapPins (pins); see convex/artifacts.ts + lib/geomap.
    //
    // "slides" artifacts store a JSON `Deck` (shared/slidesScene.ts) in
    // `content` — the Rabbit Slides surface that replaces Google Slides for
    // scholars. Same envelope as "map": structured JSON in a string, validated
    // server-side before every write. Unlike "map" there is NO second namespace
    // for scholar edits — the AI and the scholar edit the same elements, so
    // concurrent-edit safety comes from the deck's `revision` counter and the
    // optional `baseRevision` check on applySlideOps, not from a merge rule.
    //
    // "manipulative" artifacts store a JSON `StoredManipulativeArtifact`
    // ({ v, spec }) in `content` — one ad-hoc, ungraded, poke-able manipulative
    // dropped into a live session by the show_manipulative tool. Same envelope
    // discipline as "map"/"slides": the spec is validated server-side
    // (lib/manipulative/validate.ts) before every write.
    type: v.optional(
      v.union(
        v.literal("text"),
        v.literal("code"),
        v.literal("map"),
        v.literal("slides"),
        v.literal("manipulative"),
      ),
    ),
    language: v.optional(v.string()), // e.g. "html", "javascript", "python"
  }).index("by_session", ["sessionId"]),

  // EXECUTION — opaque-origin code apps cannot use browser storage reliably,
  // so the trusted web/native host persists one small LWW document + bounded
  // console ring. Room scope stores one shared document plus separate per-user
  // presence/write-throttle partitions; it is never projected into tutor context.
  appStates: defineTable({
    scope: v.optional(
      v.union(
        v.literal("session"),
        v.literal("customApp"),
        v.literal("room"),
      ),
    ),
    scopeId: v.optional(v.string()),
    userId: v.optional(v.string()),
    key: v.optional(v.string()),
    doc: v.optional(v.any()),
    // The app chooses the only named functions its tutor may invoke. Function
    // bodies never cross this boundary; only this bounded public registry does.
    actions: v.optional(
      v.array(
        v.object({
          name: v.string(),
          description: v.string(),
        }),
      ),
    ),
    // One bounded request/result mailbox per app-state row. The tutor may queue
    // only a name present in `actions`; the owner host invokes it in the sandbox.
    actionRequest: v.optional(
      v.object({
        id: v.string(),
        name: v.string(),
        args: v.optional(v.any()),
        requestedAt: v.number(),
      }),
    ),
    actionResult: v.optional(
      v.object({
        requestId: v.string(),
        ok: v.boolean(),
        result: v.optional(v.any()),
        error: v.optional(v.string()),
        completedAt: v.number(),
      }),
    ),
    log: v.optional(
      v.array(
        v.object({
          level: v.union(
            v.literal("log"),
            v.literal("warn"),
            v.literal("error"),
          ),
          message: v.string(),
          at: v.number(),
        }),
      ),
    ),
    version: v.number(),
    updatedAt: v.number(),
    // Widen-only compatibility with rows written by the pre-production spike.
    // Production writes populate the scoped tuple + `doc` above.
    sessionId: v.optional(v.id("sessions")),
    artifactId: v.optional(v.id("artifacts")),
    state: v.optional(v.any()),
  })
    .index("by_scope_scopeId_userId_key", [
      "scope",
      "scopeId",
      "userId",
      "key",
    ])
    .index("by_scope_scopeId_userId", ["scope", "scopeId", "userId"])
    .index("by_scope_scopeId", ["scope", "scopeId"])
    .index("by_session_artifact", ["sessionId", "artifactId"]),

  scholarDossiers: defineTable({
    scholarId: v.id("users"),
    content: v.string(),
  }).index("by_scholar", ["scholarId"]),

  // Reading-ramp grapheme confidence map (young-learners-plan.html §10) — one
  // row per scholar. The INTERIM home for per-team fade state: which grapheme
  // teams ("sh", "th", "ea", …) a pre-reader is currently training and how far
  // each has faded. The tutor stream reads it to decide whether to annotate a
  // turn (see shouldAnnotateGraphemes); the GraphemeText renderers read the
  // stages to fade each team's color. `stage` values MUST match the render
  // layer's GraphemeStage strings in shared/graphemeSegments.ts. Kept a THIN
  // read surface on purpose: §10 flags that once the Practice engine lands,
  // grapheme teams may become knowledge nodes in a phonics strand and this map
  // is superseded by reading stage straight off the node dial — so nothing
  // downstream should depend on this table's shape beyond {team, stage}.
  graphemeInventories: defineTable({
    scholarId: v.id("users"),
    teams: v.array(
      v.object({
        team: v.string(),
        stage: v.union(
          v.literal("training"),
          v.literal("fading"),
          v.literal("graduated"),
        ),
      }),
    ),
    updatedAt: v.number(),
  }).index("by_scholar", ["scholarId"]),

  // Reading-ramp grapheme fade-stage history (young-learners-plan.html §10) —
  // an append-only arc of every stage transition for each of a scholar's
  // grapheme teams. `graphemeInventories` holds only the CURRENT stage; this
  // table is the durable story of how each team got there (e.g. "sh reached
  // fading Jun 3, graduated Jun 12"). Graduations are portfolio milestones, kin
  // to `readingLevelHistory` — so we record EVERY transition (a team appearing,
  // a promotion, a graduation), not just the final rung, and surface it in the
  // teacher editor's history line. Written from `graphemeInventory.upsert`
  // whenever a team's stage differs from its stored value. RECORD-KEEPING ONLY:
  // it is never read into the tutor's prompt (the annotator sees only outbound
  // text + the live inventory — not this arc); it's for the teacher surface and
  // the parent-facing portrait.
  graphemeHistory: defineTable({
    scholarId: v.id("users"),
    team: v.string(),
    stage: v.union(
      v.literal("training"),
      v.literal("fading"),
      v.literal("graduated"),
    ),
    recordedAt: v.number(),
    changedBy: v.optional(v.id("users")), // teacher/admin who made the change
  }).index("by_scholar", ["scholarId"]),

  // Human-facing name: "guidance". The table name is unchanged.
  teacherDirectives: defineTable({
    scholarId: v.id("users"),
    label: v.string(), // e.g. "SWI / stealth-dyslexia"
    content: v.string(), // teacher-authored instructions to the tutor
    authorId: v.id("users"), // teacher or admin who last wrote it
    isActive: v.boolean(),
    updatedAt: v.number(),
    // When this guidance stops being injected into the tutor prompt. ABSENT
    // means STANDING — which is exactly what every row written before this
    // field existed means, so there is nothing to migrate. Set from Rounds
    // ("keep another week"), cleared to make a piece of guidance standing.
    expiresAt: v.optional(v.number()),
    // The Rounds meeting this guidance was created or extended in, when it
    // came from the room. Absent for guidance authored anywhere else.
    sourceMeetingId: v.optional(v.id("scholarReviewMeetings")),
  })
    .index("by_scholar", ["scholarId"])
    .index("by_scholar_active", ["scholarId", "isActive"]),

  curriculumMessages: defineTable({
    teacherId: v.id("users"),
    unitId: v.optional(v.id("units")),
    // When set, this message is part of a thread scoped to a specific scholar.
    // When unset, the message belongs to the teacher's global curriculum thread
    // (legacy behavior — kept for backward compatibility).
    scholarId: v.optional(v.id("users")),
    // Future-proofing for multi-thread-per-scholar. null/undefined means the
    // scholar's primary thread.
    threadLabel: v.optional(v.string()),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    // Slack threads are multi-author: the human who sent this turn. Rendered
    // as a small gray label above the bubble in the in-app Chat tab (the
    // content itself stays clean — no inline "Name: " prefix). Unset for
    // in-app messages (the owner is implicit).
    speakerName: v.optional(v.string()),
    model: v.optional(v.string()),
    tokensUsed: v.optional(v.number()),
    streamId: v.optional(v.string()),
    // FK to the `chats` table (the teacher-aide / Curriculum-Bot / Slack chat
    // thread this message belongs to). Optional: unit-scoped Curriculum Bot
    // messages belong to a unit thread, not a chat.
    chatId: v.optional(v.id("chats")),
    // Test Drive phase 3: when the teacher sends a message in the bot
    // drawer with one or more pending 👍/👎 flags, we snapshot the flag
    // contexts onto the message so they persist in chat history. Each
    // entry renders as a chip above the user's bubble. Snapshots (not
    // live refs to testDriveFlags) because the teacher may toggle flags
    // off later, but the bot conversation history should still show what
    // was true at the moment they sent.
    flagSnapshots: v.optional(
      v.array(
        v.object({
          kind: v.union(v.literal("good"), v.literal("bad")),
          snippet: v.string(),
        }),
      ),
    ),
    // Files the teacher attached to a (user-role) message via the chat
    // composer's "+" button — already uploaded to Convex storage. Images and
    // PDFs are passed to Claude as inline content blocks (vision); ALL
    // attachments are also offered to the upload tools
    // (upload_scholar_document / add_portfolio_item) so the teacher can say
    // "add this to Kai's file".
    attachments: v.optional(
      v.array(
        v.object({
          storageId: v.id("_storage"),
          fileName: v.string(),
          mimeType: v.optional(v.string()),
          sizeBytes: v.optional(v.number()),
        }),
      ),
    ),
    // Google Drive documents LINKED (not uploaded) via the composer's Drive
    // picker. We store only a reference — the file stays in the teacher's
    // Drive — plus a thumbnail for the chip. At stream time the bot fetches
    // the doc's text through the teacher's linked Google account
    // (getValidAccessToken → Drive export) and injects it as a document block.
    // Shape mirrors scholarDocuments.link.
    driveAttachments: v.optional(
      v.array(
        v.object({
          driveFileId: v.string(),
          url: v.string(),
          name: v.string(),
          mimeType: v.string(),
          thumbnailUrl: v.optional(v.string()),
        }),
      ),
    ),
  })
    .index("by_teacher", ["teacherId"])
    .index("by_teacher_unit", ["teacherId", "unitId"])
    .index("by_scholar_and_creation", ["scholarId"])
    .index("by_stream", ["streamId"])
    .index("by_chat", ["chatId"]),

  // The teacher-aide / Curriculum-Bot / Slack chat-thread table. Renamed from
  // `chatSessions` to `chats` to match the "New chat" button + Slack
  // nomenclature and to free the overloaded word "session" (now exclusively a
  // scholar's pass through an activity — the `sessions` table).
  chats: defineTable({
    teacherId: v.id("users"),
    title: v.string(),
    scholarId: v.optional(v.id("users")),
    // Origin transport. "slack" chats are unified Slack threads — the UI
    // shows a subtle "via Slack" badge. Unset = created in-app.
    source: v.optional(v.literal("slack")),
    // When set, this chat is the unit-scoped Curriculum Bot thread for a
    // specific unit (teacher chats with the bot while editing the unit).
    // When unset, this is a global Teacher Aide chat.
    unitId: v.optional(v.id("units")),
    pinned: v.boolean(),
    lastMessageAt: v.number(),
    activeStreamId: v.optional(v.string()),
  })
    .index("by_teacher", ["teacherId"])
    .index("by_teacher_pinned", ["teacherId", "pinned"])
    .index("by_scholar", ["scholarId"])
    .index("by_teacher_unit", ["teacherId", "unitId"])
    // Recency-ordered generic chat library — lets a "recent chats" surface
    // take N rows instead of collecting the teacher's whole history.
    .index("by_teacher_unit_activity", ["teacherId", "unitId", "lastMessageAt"]),

  // ── THE WORKSHOP (reflection chat) ────────────────────────────────────
  // The scholar-facing Workshop chats — lightweight aide-style threads,
  // deliberately NOT tutor `sessions` rows. Reflection is one thread per
  // scholar/day; introspection is one standing Ask Rabbithole thread. dayKey
  // remains optional because the standing thread is not tied to a local date.
  metaChats: defineTable({
    scholarId: v.id("users"),
    purpose: v.union(
      v.literal("reflection"),
      v.literal("introspection"),
    ),
    // Reflection: the local calendar day. Introspection: "standing".
    threadKey: v.string(),
    // Reflection only: "2026-07-03" in the Prep block's timezone.
    dayKey: v.optional(v.string()),
    // Durable serialized meta-observer drain. The cursor is the last analyzed
    // metaMessages._creationTime. A short lease prevents overlapping actions.
    observerCursorAt: v.optional(v.number()),
    observerLeaseId: v.optional(v.string()),
    observerLeaseExpiresAt: v.optional(v.number()),
    createdAt: v.number(),
    lastMessageAt: v.number(),
  })
    .index("by_scholar_day", ["scholarId", "dayKey"])
    .index("by_scholar_purpose_thread", [
      "scholarId",
      "purpose",
      "threadKey",
    ]),

  // Messages in either Workshop chat purpose.
  metaMessages: defineTable({
    chatId: v.id("metaChats"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    model: v.optional(v.string()),
    tokensUsed: v.optional(v.number()),
    streamId: v.optional(v.string()), // set on the in-progress assistant row
    createdAt: v.number(),
  }).index("by_chat", ["chatId"]),

  // One row per successfully applied meta-observer range. This makes welfare
  // alerts, suggestion capture, and portrait writes idempotent across retries.
  metaObserverRuns: defineTable({
    chatId: v.id("metaChats"),
    rangeKey: v.string(),
    throughAt: v.number(),
    createdAt: v.number(),
  }).index("by_chat_range", ["chatId", "rangeKey"]),
  // OAuth 2.1 state for the remote MCP connector (`/api/mcp`). A user
  // pastes the URL into Claude, Claude dynamically registers as a client
  // (RFC 7591), the user consents on /oauth/authorize, and the code is
  // exchanged for a REAL Convex Auth session via the "mcp" credentials
  // provider in auth.ts — so MCP requests authenticate as the actual user
  // and every existing role/guardianship gate applies. Replaced the old
  // bearer `tokens` table (deleted 2026-06; nothing used it in the wild).

  // Dynamically registered OAuth clients. Public clients only (PKCE, no
  // secret stored). One row per connector registration.
  mcpOauthClients: defineTable({
    clientId: v.string(),
    clientName: v.optional(v.string()),
    redirectUris: v.array(v.string()),
  }).index("by_clientId", ["clientId"]),

  // Short-lived, one-shot authorization codes binding a user's consent to
  // a client + PKCE challenge. Only the sha256 of the code is stored; the
  // raw code goes to the client via the redirect and is consumed (deleted)
  // on first exchange attempt.
  mcpOauthCodes: defineTable({
    codeHash: v.string(),
    clientId: v.string(),
    userId: v.id("users"),
    redirectUri: v.string(),
    codeChallenge: v.string(), // base64url(S256(code_verifier))
    scope: v.optional(v.string()),
    expiresAt: v.number(),
  })
    .index("by_codeHash", ["codeHash"])
    .index("by_user", ["userId"]),

  // Tracking sidecar for active MCP connections, so a user can see and
  // revoke them (Account Details → "Connect Claude"). An MCP access token
  // is a stock Convex Auth session (authSessions), which carries NO provider
  // tag — browser and MCP sessions are otherwise indistinguishable. So at
  // token-exchange the freshly-authenticated session records ITSELF here
  // (mcpOauth.recordMySession, keyed on its own sessionId — unspoofable),
  // capturing the client it connected from. Revoke deletes the authSessions
  // row (killing the token) + this sidecar row. Rows whose authSessions
  // parent is gone/expired are dead and swept on next connect.
  mcpSessions: defineTable({
    sessionId: v.id("authSessions"),
    userId: v.id("users"),
    clientId: v.string(),
    clientName: v.optional(v.string()),
    createdAt: v.number(),
    lastSeenAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_session", ["sessionId"]),

  // Remembered consent: once a user approves a client on the consent screen
  // with "remember", later authorize requests for that same (user, client)
  // auto-approve and skip the click. Keyed on (userId, clientId) — scope
  // doesn't widen access (tools follow the user's role), so it isn't part of
  // the key. Cleared when the user revokes that client's connection, so a
  // revoke also stops silent re-granting.
  mcpOauthConsents: defineTable({
    userId: v.id("users"),
    clientId: v.string(),
    createdAt: v.number(),
    lastUsedAt: v.number(),
  }).index("by_user_client", ["userId", "clientId"]),

  // ── SLACK BOT (the third agent transport) ─────────────────────────────
  // See review/slack-bot-plan.md + .claude/rules/rabbithole-slack-bot.md.
  // Identity lives on users.slackUserId (fail closed); these tables hold
  // the transport state.

  // Slack threads the bot participates in. Inserted when the bot first
  // replies in a thread (channel @mention or DM); after that, plain
  // messages in the thread are treated as follow-ups (no re-mention
  // needed). `chatId` unifies the thread with a `chats` row so
  // the conversation is the same object as an in-app aide chat.
  slackThreads: defineTable({
    channelId: v.string(),
    threadTs: v.string(), // Slack thread root timestamp (their id format)
    // FK to the `chats` row this Slack thread is unified with, so the
    // conversation is the same object as an in-app aide chat.
    chatId: v.optional(v.id("chats")),
    // The mapped Rabbithole user who started the thread (for session
    // bookkeeping; per-message authorization still resolves each event's
    // author independently).
    startedByUserId: v.id("users"),
    lastActivityAt: v.number(),
  })
    .index("by_channel_thread", ["channelId", "threadTs"])
    // Reverse lookup: given a unified `chats` row, find its Slack thread —
    // so out-of-band producers (e.g. the introspection proposal-outcome
    // notifier) can post back into the originating thread.
    .index("by_chat", ["chatId"]),

  // Events-API dedupe: Slack retries deliveries (timeouts, 5xx) with the
  // same event_id. One row per processed event; swept opportunistically.
  slackEvents: defineTable({
    eventId: v.string(),
    receivedAt: v.number(),
  }).index("by_eventId", ["eventId"]),

  // DM document intake (Phase 4): Slack file → Convex storage, exactly
  // once. The confirm flow spans turns ("attach this to Kai?" → "yes"),
  // and each turn rebuilds context from Slack — this table is what lets
  // a later turn resolve the same slackFileId to the already-stored blob
  // instead of re-downloading (or worse, losing the ref).
  slackFiles: defineTable({
    slackFileId: v.string(),
    storageId: v.id("_storage"),
    name: v.optional(v.string()),
    mimetype: v.optional(v.string()),
    sizeBytes: v.optional(v.number()),
  }).index("by_slackFileId", ["slackFileId"]),

  // Durable bug-report intake: one row carries the reporter/context packet,
  // storage-backed evidence, Slack thread bridge, and per-step receipts.
  bugReports: defineTable({
    // identity — actor is the real signed-in owner, even during impersonation
    actorUserId: v.id("users"),
    actorRole: v.string(),
    clientReportId: v.optional(v.string()), // stable native outbox id for at-most-once intake
    viewedUserId: v.optional(v.id("users")), // impersonation/remote target
    institutionId: v.optional(v.id("institutions")), // server-resolved; never guessed
    surface: v.union(v.literal("native"), v.literal("web")),
    // context (server-validated)
    url: v.string(), // sanitized pathname + relevant params
    sessionId: v.optional(v.id("sessions")), // kept only if it belongs to the scholar
    viewingMode: v.optional(v.string()), // "actAs" | "inspect" | null
    deviceModel: v.optional(v.string()), // expo-device (native)
    osVersion: v.optional(v.string()),
    userAgent: v.optional(v.string()), // web
    appVersion: v.optional(v.string()),
    appBuild: v.optional(v.string()),
    // payload
    description: v.optional(v.string()), // typed text OR audio transcript
    audioStorageId: v.optional(v.id("_storage")),
    screenshotStorageId: v.optional(v.id("_storage")),
    // provenance bridge + Slack coordinates
    chatId: v.optional(v.id("chats")), // the real bridge to dispatch/outcome
    slackChannelId: v.optional(v.string()), // for deep-linking
    slackThreadTs: v.optional(v.string()),
    // durable-pipeline receipts
    transcribedAt: v.optional(v.number()),
    postedAt: v.optional(v.number()),
    filesAt: v.optional(v.number()),
    bridgedAt: v.optional(v.number()),
    triagedAt: v.optional(v.number()),
    attempts: v.optional(v.number()),
    lastError: v.optional(v.string()),
    resolvedAt: v.optional(v.number()),
    status: v.union(
      v.literal("received"),
      v.literal("waiting_for_channel"),
      v.literal("posted"),
      v.literal("triaged"),
      v.literal("resolved"),
      v.literal("failed"),
    ),
  })
    .index("by_institution", ["institutionId"])
    .index("by_actor", ["actorUserId"])
    .index("by_client_id", ["clientReportId", "actorUserId"])
    .index("by_status", ["status"]),

  // Outbound notification queue for group-linked channels (Phase 3).
  // Digest-mode events accumulate here until the hourly flush posts one
  // activity update in the day's check-in thread; immediate-mode events skip it.
  slackNotificationQueue: defineTable({
    groupId: v.id("scholarGroups"),
    channelId: v.string(),
    text: v.string(), // one digest line, already formatted
    // Stable producer identity. Revisions with the same key replace the pending
    // line; once sent, the next revision starts a new digest-window row.
    dedupeKey: v.optional(v.string()),
    sent: v.boolean(),
  })
    .index("by_sent", ["sent"])
    .index("by_group_dedupe_sent", ["groupId", "dedupeKey", "sent"]),

  // One row per posted end-of-day check-in — the per-channel/per-day dedupe
  // and the pointer from a date to its thread. Claimed BEFORE the Slack post
  // (reserve-before-external-call) so a crash mid-post can't double-post.
  eodCheckins: defineTable({
    channelId: v.string(),
    dateKey: v.string(), // Institution-local calendar day, "YYYY-MM-DD"
    // `threadTs` is staged immediately after the parent succeeds. Rows written
    // before `lifecycle` existed used this field only when fully finalized, so
    // an absent lifecycle + threadTs remains a completed legacy check-in.
    threadTs: v.optional(v.string()),
    lifecycle: v.optional(
      v.union(
        v.literal("parent_pending"),
        v.literal("parent_staged"),
        v.literal("reply_pending"),
        v.literal("completed"),
        v.literal("failed"),
      ),
    ),
    // The retry worker always uses the original check-in day and persisted reply
    // payload, never the next cron run's date key or a newly-generated summary.
    dayStartMs: v.optional(v.number()),
    dateLabel: v.optional(v.string()),
    institutionId: v.optional(v.id("institutions")),
    // Durable generated parent hook. Persisted before Slack delivery so a retry
    // reconciles or reposts the same headline rather than regenerating it.
    parentText: v.optional(v.string()),
    replyText: v.optional(v.string()),
    // Exact rows rendered into the initial wrap-up. Rows arriving after this
    // snapshot remain pending for the next hourly activity update.
    initialQueueIds: v.optional(v.array(v.id("slackNotificationQueue"))),
    // One durable hourly batch per thread. Persisting the payload lets a later
    // cron reconcile an ambiguous Slack response without duplicating the reply.
    activityUpdate: v.optional(
      v.object({
        deliveryId: v.string(),
        text: v.string(),
        queueIds: v.array(v.id("slackNotificationQueue")),
        startedAt: v.number(),
        leaseUntil: v.number(),
      }),
    ),
    retryAt: v.optional(v.number()),
    retryAttempts: v.optional(v.number()),
    lastError: v.optional(v.string()),
    groupIds: v.array(v.id("scholarGroups")),
    postedAt: v.number(),
  })
    .index("by_channel_date", ["channelId", "dateKey"])
    .index("by_retryAt", ["retryAt"]),

  // Parent-message Slack transport. One row maps ONE posted Slack thread root
  // in the shared staff parent-message channel back to ONE parent thread, so
  // any trusted teacher/admin reply can be routed fail-closed even if a
  // notification race briefly creates multiple roots for the same parent
  // thread. Separate from `slackThreads` because these threads are not aide
  // conversations: the bot is just a transport bridge, and a teacher reply
  // writes a normal `parentMessages.authorType="teacher"` row.
  parentSlackThreads: defineTable({
    parentThreadId: v.id("parentThreads"),
    channelId: v.string(), // linked staff Slack channel id
    threadTs: v.string(), // root ts of the bot's parent-message notification
    lastParentMessageId: v.optional(v.id("parentMessages")),
    lastNotifiedAt: v.number(),
    lastTeacherReplyAt: v.optional(v.number()),
  })
    .index("by_channel_thread", ["channelId", "threadTs"])
    .index("by_parent_thread", ["parentThreadId"]),

  // The single admin-linked destination for teacher↔parent Slack notices. At
  // most one row; linking upserts it. This channel must be private/staff-only
  // operationally because parent/child PII is intentionally visible to members.
  parentMessageChannel: defineTable({
    slackChannelId: v.string(),
    linkedBy: v.id("users"),
    linkedAt: v.number(),
  }),

  // The single private, platform-operator Slack destination for reports across
  // every institution. The binding tool enforces conversations.info.is_private.
  bugReportChannel: defineTable({
    slackChannelId: v.string(),
    linkedBy: v.id("users"),
    linkedAt: v.number(),
  }),

  // ── GITHUB INTEGRATION (introspection loop — Phase 1 plumbing) ────────
  // See review/rabbithole-introspection-plan.html §4/§5/§7 and
  // review/copilot-pr-sketches-plan.html. The Slack bot's staged escalation
  // (proposal → plan → code) hands work off to the GitHub Copilot cloud
  // agent; these tables hold operational handoff state, including the assembled
  // dispatch prompt needed to retry a failed task, but are not the canonical
  // proposal store. The rendered proposal.html lives in its Copilot PR commit
  // (private `rabbithole-proposals` repo); we store an unguessable POINTER to it
  // (token + path + commit/blob sha) so the on-demand proxy can render it for
  // Slack.

  // One row per per-rung handoff. Maps a Slack-bot thread (a `chats` row,
  // same pattern as `slackThreads.chatId`) to the GitHub-side handle — an
  // agent-tasks-API task id and/or an opened PR number — so inbound
  // webhook events and outbound relays can find their way back to the
  // right conversation.
  featureProposals: defineTable({
    chatId: v.id("chats"),
    // Optional bridge to the policy-neutral improvement evidence ledger. Older
    // proposals predate traces and intentionally remain valid without one.
    improvementTraceId: v.optional(v.id("improvementTraces")),
    // A repository identifier associated with a proposal or code task.
    githubRepo: v.string(),
    // The dispatched agent-tasks-API task id, once known (dispatch is
    // stubbed — see convex/github.ts's dispatchAgentTask).
    taskId: v.optional(v.string()),
    // Which model the requester chose for the cloud sandbox agent (the
    // fable-vs-opus knob; Copilot's own id naming, dots not dashes —
    // "claude-opus-4.7" today, "claude-fable-5" once the org enables the
    // Fable policy; see github.ts dispatchAgentTask). Absent/"" = Auto.
    model: v.optional(v.string()),
    // The PR opened for this stage, once known. A proposal/plan-stage
    // task may never open one (§5's return-without-PR path).
    prNumber: v.optional(v.number()),
    // The branch Copilot pushes for this task (an agent-task session's
    // `head_ref`), learned by the reconcile poll (convex/github.ts's
    // pollProposalTask). It's the key that resolves the PR number, and the
    // fallback the webhook uses to link a `pull_request.opened` event when
    // the PR number wasn't known yet.
    headRef: v.optional(v.string()),
    // Wall-clock cutoff for the reconcile poll: after this the poll gives up
    // and marks the row failed (a "timed out" flavor). Set at dispatch time.
    pollDeadline: v.optional(v.number()),
    // Number of automatic recovery attempts claimed after a Copilot runner
    // failed during checkout before the agent started. Capped at one by the
    // reconcile poll; the idempotent GitHub comment may be retried within the
    // reconciliation window without incrementing this again.
    recoveryAttempts: v.optional(v.number()),
    // Set when the automatic recovery attempt is atomically claimed. The poll
    // allows GitHub a short reconciliation window to expose the replacement
    // session before deciding the retry itself failed.
    recoveryRequestedAt: v.optional(v.number()),
    // The full assembled dispatch prompt (brief + any authoritative-proposal
    // attachment), stored so the reconcile poll can re-dispatch an IDENTICAL
    // fresh task if the first run crashes BEFORE opening a PR. Absent on older
    // rows (and on marketing-lane dispatches), which simply don't auto-retry.
    dispatchPrompt: v.optional(v.string()),
    // Number of automatic RE-DISPATCH attempts (a fresh agent task) claimed
    // after a run failed before opening a PR — the checkout/startup-crash case
    // the comment-recovery path (recoveryAttempts) can't help with, since there
    // is no PR to @Copilot on. Separate counter so the two paths never interfere.
    // Capped at one by the reconcile poll.
    redispatchAttempts: v.optional(v.number()),
    // Set while a fresh replacement task is being dispatched. Concurrent poll
    // ticks wait for repointToRetryTask to install the replacement task id.
    redispatchRequestedAt: v.optional(v.number()),
    // A human-confirmed @Copilot relay resumed an admission-blocked task on
    // this same PR. It preserves the original task/PR identity and gives the
    // reconcile poll a fresh window for the new session.
    continuationRequestedAt: v.optional(v.number()),
    stage: v.union(
      v.literal("proposal"),
      v.literal("plan"),
      v.literal("code"),
    ),
    status: v.union(
      v.literal("dispatched"),
      v.literal("in_progress"),
      v.literal("delivered"),
      v.literal("failed"),
      // The agent task could not be admitted before it started. Its existing
      // draft PR remains the only continuation target; a person must resolve
      // the external blocker and explicitly relay continuation.
      v.literal("blocked"),
    ),
    requestedByUserId: v.id("users"),
    // The product-signal-only brief actually sent as the task prompt —
    // kept for audit/debugging, NOT the rendered proposal (§5: that's
    // never stored here).
    redactedBrief: v.string(),
    // Stable automatic-work identity. The weekly pulse uses this to suppress a
    // second task while the same class + dimensions + target remains open.
    dedupKey: v.optional(v.string()),
    // ── proposal.html pointer (review/copilot-pr-sketches-plan.html Ph.1) ──
    // Set once, on the winning "delivered" transition, when a proposal PR
    // added a self-contained proposal.html. The on-demand proxy at
    // GET /proposal/:sketchToken reads the file live from GitHub at the
    // pinned blob sha and renders it for a Slack link. All optional (a
    // proposal task may return without a PR, or without an HTML file), and
    // additive — no existing row/flow depends on them.
    sketchToken: v.optional(v.string()), // unguessable public id → the URL
    sketchPath: v.optional(v.string()), // resolved path of the proposal.html
    sketchCommitSha: v.optional(v.string()), // PR head commit (provenance/snapshot)
    sketchBlobSha: v.optional(v.string()), // git blob sha the proxy reads
    // Immutable generated result pointer and the privacy-screened Slack summary
    // from proposal delivery. No raw result content is stored here.
    resultPath: v.optional(v.string()),
    resultCommitSha: v.optional(v.string()),
    resultBlobSha: v.optional(v.string()),
    resultDigest: v.optional(v.string()),
    resultSlackSummary: v.optional(v.string()),
    // The "who asked for this?" provenance comment on the PR
    // (convex/lib/proposalProvenance.ts). A dispatched PR is otherwise
    // anonymous — the requester lives only on requestedByUserId above — so
    // Rabbithole comments the provenance onto the PR as soon as it learns the
    // number. Two fields because a lease and a receipt are different facts:
    // `claimedAt` is an EXPIRING lease that admits one of the several writers
    // that can learn a PR number (reconcile poll, webhook) and is cleared on a
    // failed post; `commentedAt` is set only once the comment is confirmed on
    // the PR, and is what permanently stops further attempts. Splitting them is
    // what keeps a dropped action from burning the job forever. NOTE the limit
    // of that: an expired lease only helps if some writer calls the poster
    // again. A failed post self-schedules its own retry, but an attempt that is
    // HARD-killed mid-flight (deploy, infra) never reaches that catch — and if
    // the row is already terminal, the poll has stopped and the webhook has
    // fired its one shot, so nothing re-invokes it and the PR stays unstamped.
    // Narrow enough to accept; a sweeper cron is the fix if it ever shows up.
    provenanceClaimedAt: v.optional(v.number()),
    provenanceCommentedAt: v.optional(v.number()),
    // The one-per-task DM to the REVIEWER ("someone else's ask just became a
    // PR you have to look at" — convex/lib/proposalReviewerDm.ts). Same
    // lease/receipt split, and for the same reason, as the provenance pair
    // above: `claimedAt` is an EXPIRING lease cleared on a failed post,
    // `sentAt` is the receipt that permanently stops further attempts. The DM
    // is scheduled only from the winning terminal transition, so this is
    // belt-and-braces against a manual re-run rather than a real race.
    reviewerDmClaimedAt: v.optional(v.number()),
    reviewerDmSentAt: v.optional(v.number()),
    // The reviewer-DM lead's Slack coordinates (channel + message ts), stamped
    // by notifyProposalReviewer ONLY when it opened the requester+reviewer
    // GROUP DM — so the later "your feature is live" notice threads into the
    // SAME conversation and one thread holds the whole life of one PR. Left
    // unset on the 1:1 fallback (the requester isn't in that room), which makes
    // the ship notice fall back to the requester's own origin thread instead.
    noticeChannelId: v.optional(v.string()),
    noticeThreadTs: v.optional(v.string()),
    // ── "your feature is live" ship notice (stacks on the reviewer DM) ────
    // A staff-requested CODE PR flips to `delivered` the moment the agent
    // OPENS it, so merge + prod deploy were previously silent. These fields
    // drive one final notice — the "go try it" moment — once the merge commit
    // has actually deployed to prod. All optional/additive; no existing flow
    // reads them, and the `status` union is deliberately untouched.
    //
    // Correlation is by MERGE COMMIT SHA, because a Convex-deploy workflow_run
    // and a Vercel production deployment_status carry no PR number.
    mergedAt: v.optional(v.number()), // when the PR merged (pull_request.closed, merged=true)
    mergeCommitSha: v.optional(v.string()), // the merge commit — deploy-signal key
    // Settle-window bookkeeping (convex/githubEvents.ts). Rather than infer
    // which deploys are "owed", each matching prod-deploy signal bumps
    // `deploySignalCount` (a generation counter for debounce) and re-arms a
    // timer; the notice fires once the latest signal's timer elapses with no
    // newer signal. `deploySignalSeen` distinguishes "a deploy confirmed" from
    // "we only ever saw the merge" (→ a softer fallback notice at the deadline).
    deploySignalSeen: v.optional(v.boolean()),
    deploySignalCount: v.optional(v.number()),
    lastDeploySignalAt: v.optional(v.number()),
    // A matching prod deploy REPORTED failure → suppress the notice entirely.
    // Telling a requester "it's live" on a red prod deploy would be false.
    deployFailed: v.optional(v.boolean()),
    // Wall-clock cutoff (set at merge time) for the fallback notice, so a merge
    // whose deploy signal never arrives (e.g. deployment_status isn't
    // subscribed) still gets a softer "merged, live shortly" notice.
    shipDeadline: v.optional(v.number()),
    // Exactly-once for the ship notice — same lease/receipt split as the
    // provenance + reviewer-DM pairs above. `claimedAt` is the expiring lease
    // admitting one poster across a retrying webhook + both timers; `sentAt` is
    // the receipt that permanently stops further attempts. `resolvedAt` is the
    // other terminal: the finalizer decided to stay SILENT (a failed deploy),
    // which must also stop every later timer from firing a notice.
    shipNoticeClaimedAt: v.optional(v.number()),
    shipNoticeSentAt: v.optional(v.number()),
    shipNoticeResolvedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_chat", ["chatId"])
    .index("by_improvementTrace", ["improvementTraceId"])
    .index("by_taskId", ["taskId"])
    .index("by_prNumber", ["prNumber"])
    // Resolves the on-demand proxy's URL token → the pointer row.
    .index("by_sketchToken", ["sketchToken"])
    // Lets the webhook correlate a `pull_request.opened` event to an
    // as-yet-unlinked row by the branch Copilot pushed (defense-in-depth
    // alongside the poll's own PR resolution — see githubEvents.ts).
    .index("by_headRef", ["headRef"])
    // Correlates a prod-deploy signal (a Convex-deploy workflow_run / a Vercel
    // production deployment_status — neither carries a PR number) back to the
    // merged row by its merge commit sha (see githubEvents.ts).
    .index("by_mergeCommitSha", ["mergeCommitSha"])
    // The per-day dispatch cap (§8 cost controls) counts recent dispatches
    // by this — `createdAt` rather than `_creationTime` so tests can seed
    // rows on either side of the window boundary.
    .index("by_createdAt", ["createdAt"])
    .index("by_dedupKey", ["dedupKey"]),

  // References-only ledger for improvement work. It records provenance and
  // execution/outcome identities without storing prompts, bodies, or workflow
  // state-machine rules.
  improvementTraces: defineTable({
    institutionId: v.id("institutions"),
    policy: v.union(
      v.literal("rounds"),
      v.literal("dieter"),
      v.literal("coherence"),
    ),
    lifecycle: v.union(
      v.literal("discovered"),
      v.literal("proposed"),
      v.literal("approved"),
      v.literal("executing"),
      v.literal("completed"),
      v.literal("declined"),
    ),
    createdBy: v.id("users"),
    chatId: v.optional(v.id("chats")),
    evidenceRefs: v.array(v.object({ kind: v.string(), ref: v.string() })),
    execution: v.optional(
      v.object({
        provider: v.union(
          v.literal("github-cloud"),
          v.literal("autonomous-coordinator"),
        ),
        executionId: v.string(),
        attemptId: v.optional(v.string()),
        workerId: v.optional(v.string()),
        workspaceId: v.optional(v.string()),
        copilotSessionId: v.optional(v.string()),
        eventCursor: v.optional(v.string()),
      }),
    ),
    outcomeRef: v.optional(v.object({ kind: v.string(), ref: v.string() })),
    // Dieter-only: the generated, privacy-validated one-paragraph technical
    // summary bound to this trace's outcome (see scripts/lib/dieterSummary.mjs's
    // `assertDieterSlackSummary` / convex/dieterSweep.ts's Convex-side mirror
    // of the same content rules). Present on EVERY Dieter trace — nothing
    // included — because the weekly digest must lead with this exact
    // generated paragraph, never a synthesized aggregate of counts. This is
    // categorically different from the "prompts, bodies, or workflow
    // state-machine rules" this table otherwise avoids storing: it is a
    // short (240-900 char), already-privacy-screened technical conclusion,
    // the same carve-out used by the private execution adapter's retryable
    // delivery below.
    dieterSlackSummary: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_institution_createdAt", ["institutionId", "createdAt"])
    .index("by_institution_policy_createdAt", [
      "institutionId",
      "policy",
      "createdAt",
    ])
    .index("by_chat", ["chatId"])
    .index("by_provider_executionId", [
      "execution.provider",
      "execution.executionId",
    ]),


  // The weekly staff review container and its per-scholar discussion rows.
  // These are records, not a decision workflow; later lanes own the surfaces.
  scholarReviewMeetings: defineTable({
    institutionId: v.id("institutions"),
    periodId: v.id("reportingPeriods"),
    // Absent on pre-cadence rows means academic. The migration in
    // `convex/migrations.ts` stamps that value explicitly before a later lane
    // can retire the legacy lookup index.
    cadenceKind: v.optional(
      v.union(v.literal("academic"), v.literal("sel")),
    ),
    weekKey: v.string(),
    createdBy: v.id("users"),
    status: v.union(v.literal("open"), v.literal("closed")),
    createdAt: v.number(),
    closedAt: v.optional(v.number()),
    closedBy: v.optional(v.id("users")),
  }).index("by_institution_period_weekKey", [
    "institutionId",
    "periodId",
    "weekKey",
  ]).index("by_institution_period_cadence_weekKey", [
    "institutionId",
    "periodId",
    "cadenceKind",
    "weekKey",
  ]),

  // Durable dedupe for the hourly Rounds reminder dispatcher. The row contains
  // only schedule identity and delivery state, never Slack payloads or learner
  // evidence.
  roundsReminderDeliveries: defineTable({
    institutionId: v.id("institutions"),
    cadenceKind: v.union(v.literal("academic"), v.literal("sel")),
    weekKey: v.string(),
    claimedAt: v.number(),
    sentAt: v.optional(v.number()),
  }).index("by_institution_cadence_week", [
    "institutionId",
    "cadenceKind",
    "weekKey",
  ]),

  // One row per (institution, SEL week) the weekly synthesis batch has been
  // dispatched for. The generator itself is idempotent (it upserts each
  // scholar/week artifact), so this table only spends its existence keeping the
  // hourly cron from re-running a whole institution's model batch it already
  // completed this week — the same claim/complete discipline as the Slack cue
  // above. `completedAt` unset means claimed-but-not-yet-finished (a crash
  // between claim and settle is retried once the claim lease lapses). On a
  // PARTIAL failure the run is settled but left incomplete (claim lease rewound)
  // so the next tick regenerates; `attemptCount` bounds those retries and
  // `lastFailedCount` records the last pass's per-scholar failure tally.
  selSynthesisRuns: defineTable({
    institutionId: v.id("institutions"),
    weekKey: v.string(),
    claimedAt: v.number(),
    completedAt: v.optional(v.number()),
    attemptCount: v.optional(v.number()),
    lastFailedCount: v.optional(v.number()),
  }).index("by_institution_week", ["institutionId", "weekKey"]),

  // One row per scholar per Rounds week. The team's written NOTE is the whole
  // artifact: it replaced a four-option disposition picker (`decision`) that
  // produced no usable record of what the adults actually said.
  scholarReviewEntries: defineTable({
    institutionId: v.id("institutions"),
    meetingId: v.id("scholarReviewMeetings"),
    scholarId: v.id("users"),
    // VESTIGIAL — narrowed to optional and NO LONGER WRITTEN (`rounds.open`
    // stopped stamping it). Deliberately not dropped, following the same
    // deferred-drop reasoning as the `alerts` status fields below: removing a
    // field that `by_meeting_position` indexes is a real widen→migrate→narrow,
    // worth doing when something else touches this table rather than on its
    // own.
    //
    // It is not merely unused, it is actively unwanted: a STORED sort key
    // makes a client-side roster re-sort (by name, by age, by whatever the
    // room wants that week) impossible without a write, and Rounds is projected
    // on one screen while everyone else reads their own laptop. Ordering is a
    // read-model concern (`rounds.week`'s `order` argument), never state.
    //
    // `by_meeting_position` is KEPT and is still the stable read order. With
    // `position` absent on every new row the index degrades to (meetingId,
    // undefined, _id) — i.e. insertion order within a meeting, which is the
    // roster order `rounds.open` inserts in. Rows written before this change
    // still carry a number and sort ahead of the undefined ones; that only
    // matters inside a single legacy meeting, where it is the original order.
    position: v.optional(v.number()),
    previousEntryId: v.optional(v.id("scholarReviewEntries")),
    // The team's note for this scholar this week, in their own words. Written
    // by `rounds.saveNote`, editable afterwards by any teacher with access.
    note: v.optional(v.string()),
    // Stamped ONLY by `rounds.saveNote`: the note IS the record that the
    // scholar was discussed, so `discussedAt` present ⟺ a note exists.
    // `convex/coherence.ts` depends on that equivalence. Doubles as the
    // optimistic-concurrency token two teachers typing in the same row race on.
    discussedAt: v.optional(v.number()),
    discussedBy: v.optional(v.id("users")),
  })
    .index("by_institution", ["institutionId"])
    .index("by_meeting_position", ["meetingId", "position"])
    .index("by_meeting_scholar", ["meetingId", "scholarId"])
    .index("by_scholar", ["scholarId"]),

  // Durable pagination state for the bounded Coherence roster scan. A stored
  // Convex cursor advances each institution through every scholar instead of
  // repeatedly inspecting only the first page.
  coherenceScanStates: defineTable({
    institutionId: v.id("institutions"),
    scholarCursor: v.string(),
    updatedAt: v.number(),
  }).index("by_institution", ["institutionId"]),

  // Findings from integrity sweeps. The state reference is deliberately a
  // pointer, never a copied record or sensitive user content.
  sweepFindings: defineTable({
    institutionId: v.id("institutions"),
    scan: v.union(
      v.literal("reachability"),
      v.literal("lifecycle_state"),
      v.literal("derived_drift"),
      v.literal("config_shadow"),
      v.literal("unrepresented"),
      v.literal("integrity"),
    ),
    stateRef: v.object({
      table: v.string(),
      field: v.string(),
      docId: v.optional(v.string()),
    }),
    consequence: v.string(),
    affectedKind: v.union(
      v.literal("scholar"),
      v.literal("teacher"),
      v.literal("parent"),
      v.literal("curriculum"),
      v.literal("system"),
    ),
    // Current detectors are scholar-specific. Keep the primary subject
    // indexable so the canonical scholar feed never depends on an
    // institution-wide truncation.
    affectedUserId: v.id("users"),
    severity: v.union(
      v.literal("blocking"),
      v.literal("capping"),
      v.literal("misleading"),
      v.literal("cosmetic"),
    ),
    representationGap: v.union(
      v.literal("no_ui"),
      v.literal("no_alert"),
      v.literal("no_tool_access"),
      v.literal("truncated"),
      v.literal("stale_derived"),
      v.literal("none"),
    ),
    observedAt: v.number(),
    reproducedAt: v.optional(v.number()),
    disposition: v.union(
      v.literal("logged_only"),
      v.literal("needs_decision"),
      v.literal("repair_proposed"),
      v.literal("repaired"),
      v.literal("declined"),
    ),
    declineReason: v.optional(
      v.union(
        v.literal("wrong_problem"),
        v.literal("wrong_fix"),
        v.literal("not_now"),
        v.literal("already_exists"),
        v.literal("too_big"),
        v.literal("taste"),
      ),
    ),
    guardTestPath: v.optional(v.string()),
    proposalId: v.optional(v.id("featureProposals")),
    // Narrow dispatch bookkeeping for the one automatic Coherence proposal.
    // This is an outbox lease, not a general-purpose workflow engine.
    proposalTraceId: v.optional(v.id("improvementTraces")),
    proposalClaimedAt: v.optional(v.number()),
    proposalClaimAttempts: v.optional(v.number()),
    dedupKey: v.string(),
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
  })
    .index("by_institution_lastSeenAt", ["institutionId", "lastSeenAt"])
    .index("by_affectedUser_lastSeenAt", ["affectedUserId", "lastSeenAt"])
    .index("by_dedupKey", ["dedupKey"])
    .index("by_disposition", ["disposition"]),

  // ── THE WORKSHOP (internal code name: `meta`) ─────────────────────────
  // Ideas scholars file about Rabbithole *itself* — "the software you use
  // takes your design feedback seriously" (review/scholar-meta-prep-time-
  // plan.html §§2, 5). An idea has EXACTLY TWO states, no pipeline:
  //   `heard`    — captured; staff will read it (set by the system on file).
  //   `answered` — a human replied with a real comment (NO verdict/good-bad
  //                label) and closed it. The reply IS the whole payload;
  //                staff may also reply WITHOUT closing to keep the
  //                conversation going one more beat (§5).
  // Deliberately NOT tracked to shipped code — product development is
  // messier than one idea → one PR (§5). Release-note attribution is its own
  // editorial act and lives on `changelogEntries.creditedScholarIds` (a later
  // phase), NOT here — an idea's life ends at a human reply. Phase 1 is this
  // table + its CRUD + the staff response loop; the reflection chat that
  // auto-distills ideas (`distilled`/`sourceChatId`) is Phase 2's meta-observer.
  scholarSuggestions: defineTable({
    scholarId: v.id("users"),
    title: v.string(), // short display name (first line/sentence of the idea)
    // The kid's words, verbatim — in-app only, NEVER leaves Convex (no name,
    // id, or quote in any GitHub artifact; §9 "kid words stay home").
    scholarWords: v.string(),
    // AI-distilled neutral summary — the Phase 2 meta-observer fills this;
    // Phase 1's manual composer leaves it unset.
    distilled: v.optional(v.string()),
    // The refined framing a thinking-partner conversation shaped — set by the
    // send_idea_to_teacher tool (WORKSHOP_IDEA_CONVOS_ENABLED) ONLY when a
    // conversation reshaped the idea and the scholar agreed to the new wording.
    // The kid's own words always live in scholarWords; refined is additive, so
    // staff see BOTH (the original phrasing + the framing they landed on). Unset
    // when the idea was sent as-is (the common case) and for every pre-feature
    // row / the manual composer / the observer path.
    refined: v.optional(v.string()),
    // The reflection chat this idea was captured from — Phase 2 only; the
    // Phase 1 composer sets nothing. Points at the Workshop `metaChats`
    // thread (not the staff `chats` table).
    sourceChatId: v.optional(v.id("metaChats")),
    // RETIRED (2026-08-25). The staff-set `heard`/`answered` state did three
    // jobs and should have done none of them: "has a human replied" is just
    // `staffResponse !== undefined`; whether a card can be opened on the kid's
    // board is the same question; and "is this still on my plate" is the
    // SCHOLAR's call (`archivedAt`). A staffer replying must not close a kid's
    // idea, and the five-open cap is a prioritization lesson aimed at the kid —
    // so the kid holds the lever, not staff.
    // Optional for the widen→migrate→narrow rollout ONLY; nothing reads or
    // writes it. Dropped from this validator once `migrations:dropSuggestionStatus`
    // has run on prod.
    status: v.optional(v.union(v.literal("heard"), v.literal("answered"))),
    // When the SCHOLAR put this idea away. Their board, their call: staff have
    // no way to set it, an archived idea stops counting against the five-open
    // cap, and it is reversible (they can bring it back).
    archivedAt: v.optional(v.number()),
    // The single human reply. No verdict field exists, by design (§5).
    staffResponse: v.optional(
      v.object({
        authorId: v.id("users"),
        body: v.string(),
        at: v.number(),
      }),
    ),
    // When the scholar was last shown this idea's staff response inside a
    // reflection chat (the ONLY delivery channel — §7). Stamped at
    // prompt-build time by the meta chat, so a response is surfaced once and
    // a LATER staff edit (staffResponse.at > responseSeenAt) resurfaces it.
    responseSeenAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    // A scholar's own "My ideas" board + the open-ideas soft cap.
    .index("by_scholar", ["scholarId"])
    // The staff queue's "still on someone's plate" read. Replaces the retired
    // `by_status` index: Convex indexes an absent optional field as its own
    // value, so `q.eq("archivedAt", undefined)` scans ONLY the un-archived
    // rows rather than the whole table (which would grow without bound and
    // eventually blow the transaction read limit).
    .index("by_archived", ["archivedAt"]),

  // ── "What's new" changelog (the Workshop's closing-the-circle surface) ──
  // Staff-authored, class-visible release notes in KID language (§5/§8).
  // Attribution lives HERE, never on an idea: `creditedScholarIds` is an
  // editorial 0..n set the staff author chooses (or reads off a private
  // proposals-repo `Credits:` line) — it is NOT derived from any idea's
  // status (ideas' lives end at a human reply; credit is a separate act).
  // Each credited scholar hears their credit ONCE, personally, at their next
  // Prep Time — `creditDelivered` records that per-scholar at-most-once stamp
  // (mirrors scholarSuggestions.responseSeenAt: stamped at prompt-build time).
  changelogEntries: defineTable({
    title: v.string(),
    // The body children read — plain, warm, no jargon (§5). Never a raw diff.
    kidBody: v.string(),
    // Editorial credit, 0..n scholars — independent of any idea's status.
    creditedScholarIds: v.array(v.id("users")),
    // Which credited scholars have already heard their credit moment, and when.
    creditDelivered: v.array(
      v.object({ scholarId: v.id("users"), at: v.number() }),
    ),
    createdByUserId: v.id("users"),
    createdAt: v.number(),
  })
    // Newest-first class-visible feed (order by createdAt at read time).
    .index("by_createdAt", ["createdAt"]),

  // Webhook dedupe for /github/events — GitHub retries a delivery (same
  // X-GitHub-Delivery id) on a non-2xx or timeout, exactly like Slack's
  // event_id retries (see `slackEvents`).
  githubWebhookEvents: defineTable({
    deliveryId: v.string(),
    receivedAt: v.number(),
  }).index("by_delivery", ["deliveryId"]),

  // ── ALERTS (general staff-facing alert fabric) ────────────────────────
  // The urgent, single-destination sibling of slackNotificationQueue.
  // `slackNotificationQueue` = per-group, opt-in, DIGESTED activity notices
  // (completions, deliverables). `alerts` = high-urgency, fire-once events
  // routed IMMEDIATELY to ONE admin-linked #rabbithole-alerts channel. The
  // first producer is the observer's welfare/ongoing-harm signal, but
  // `kind` is an open string so any future producer (account issues,
  // system failures) can raise one WITHOUT a schema change — keep this
  // general. Raising an alert is fire-and-forget (never throws into a
  // producer); see convex/alerts.ts.
  // Alerts are FIRE-AND-FORGET notifications, not a work queue: raise → dedup →
  // post to the institution's Slack channel, where the human triage actually
  // happens (unread, threads, emoji). There is deliberately NO in-app inbox.
  //
  // ⚠️ `status`, `acknowledgedBy`, `acknowledgedAt` and the `by_status` index
  // below are VESTIGIAL — the fossil of an inbox that was never built. `status`
  // is written exactly once, always "open", by `alerts.raise`, and nothing in
  // the repo ever updates it; `acknowledgedBy`/`acknowledgedAt` have no reader
  // AND no writer; `by_status` is never queried (the only reads of this table
  // are the `by_dedup` coalescing lookup, `alerts.recentByScholar`, and the
  // admin scholar-wipe — none of them touches status).
  //
  // So "every alert is status=open" is guaranteed database behaviour and
  // carries NO information. It does NOT mean an alert went unseen. That misread
  // happened on 2026-08-19 while reviewing the first classroom day: 14/14 open
  // was reported as an unactioned-alert problem and produced a proposal for an
  // acknowledge workflow. Andy rejected it, correctly — these are ambient
  // awareness signals with no owner and no closure condition ("might be a good
  // moment to check in"), an unresolved practice_stuck from Tuesday means
  // nothing on Wednesday, and an unread count is an obligation surface this
  // product deliberately avoids elsewhere.
  //
  // Before proposing an inbox again, weigh the day-one evidence that Slack
  // already worked: teachers logged concern notes matching the alerts, about
  // the same scholars, inside the same class block. The ONE kind where "did a
  // human definitely see this?" is a real question is `welfare` (raised in
  // observer.ts — the only model-chosen severity, and the only one that can be
  // "critical"); the answer there is escalation in the Slack thread, not a
  // status column.
  //
  // Deleting the dead fields is the honest end state but needs a real
  // widen→migrate→narrow (`status` is required, so every row must be cleared
  // before the narrow) — worth doing when something else touches this table,
  // not on its own.
  alerts: defineTable({
    kind: v.string(), // e.g. "welfare"; open-ended for extensibility
    severity: v.union(
      v.literal("critical"),
      v.literal("warning"),
      v.literal("info"),
    ),
    title: v.string(), // one-line headline
    body: v.string(), // fuller context (may include a brief excerpt)
    source: v.string(), // producer tag, e.g. "observer"
    scholarId: v.optional(v.id("users")),
    sessionId: v.optional(v.id("sessions")),
    deepLink: v.optional(v.string()),
    // Practice breaker alerts use the alert row as their Slack thread receipt:
    // the threshold-crossing attempt identifies the episode, while the Slack
    // coordinates let one later outcome reply land under the original alert.
    practiceTriggerAttemptId: v.optional(v.id("practiceAttempts")),
    practiceDiagnosis: v.optional(v.string()),
    practiceDiagnosisReadyAt: v.optional(v.number()),
    slackChannelId: v.optional(v.string()),
    slackMessageTs: v.optional(v.string()),
    practiceOutcomeClaim: v.optional(
      v.object({
        claimId: v.optional(v.string()),
        deliveryId: v.string(),
        claimedAt: v.number(),
      }),
    ),
    practiceOutcomePostedAt: v.optional(v.number()),
    // Coalescing key — a producer that fires repeatedly for the same
    // ongoing situation passes a stable key so we alert once, not per turn.
    dedupKey: v.optional(v.string()),
    status: v.union(v.literal("open"), v.literal("acknowledged")),
    acknowledgedBy: v.optional(v.id("users")),
    acknowledgedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_dedup", ["dedupKey"])
    .index("by_scholar", ["scholarId"])
    .index("by_scholar_created", ["scholarId", "createdAt"])
    .index("by_practice_trigger", ["practiceTriggerAttemptId"]),

  // Admin-linked destinations for `alerts`. Separate from
  // scholarGroups.slackChannelId (those are per-group, lower-urgency,
  // digested). Linked by an admin via the bot's link_alerts_channel tool.
  //
  // Three explicit roles:
  //   "scoped"       — one channel per institution; receives that institution's
  //                    scholar alerts, Quality Pulse, and Practice Portrait.
  //   "catchall"     — fallback for institutions without their own scoped channel;
  //                    receives scholar alerts + reports for institutions that have
  //                    no scoped channel. No institutionId.
  //   "platform-ops" — single dedicated channel for firm-wide cost/usage reports
  //                    and generic non-scholar system/error alerts. No institutionId.
  //
  // Legacy rows without a `role` field keep their previous semantics:
  //   institutionId present → treated as "scoped"
  //   institutionId absent  → treated as "catchall"
  alertChannel: defineTable({
    slackChannelId: v.string(),
    linkedBy: v.id("users"),
    linkedAt: v.number(),
    // Required for "scoped" channels; absent for platform-wide roles.
    institutionId: v.optional(v.id("institutions")),
    // Explicit role. Legacy rows without this field behave as "scoped" when
    // institutionId is set, or "catchall" when institutionId is absent.
    role: v.optional(
      v.union(
        v.literal("scoped"),
        v.literal("catchall"),
        v.literal("platform-ops"),
        // Private platform-wide cadence and proposal threads for the improvement system.
        v.literal("improvement-loops"),
      ),
    ),
  })
    .index("by_institution", ["institutionId"])
    .index("by_role", ["role"]),

  // ── USAGE EVENTS (AI token telemetry → weekly cost report) ─────────────
  // One row per model call (or per streamed tool-loop turn) recording the
  // full Anthropic usage breakdown, so the weekly cost report
  // (convex/usageReport.ts) can attribute $ spend by source and model. All
  // writes go through the single helper in convex/usage.ts (recordUsage /
  // recordAnthropicUsage) — never insert here directly, so every call site
  // stays a one-liner. Fire-and-forget: recording must never throw into a
  // producing action.
  //
  //   • source — an OPEN surface/function label (like alerts.kind), e.g.
  //     "tutor", "observer", "aide-chat", "curriculum-bot", "titles". The
  //     report maps these + `role` into display buckets (students/teachers/
  //     platform-admin/tutor/observer) in ONE place, so the taxonomy is a
  //     single editable table, not baked into every producer.
  //   • role — the triggering principal's role (scholar/teacher/admin/…) or
  //     absent for system/cron work. Lets the report split the shared aide
  //     between "teachers" and "platform-admin".
  //   • institutionId — the institution whose work caused the call, when it
  //     can be resolved without guessing. Missing means "unattributed" in
  //     platform rollups; legacy rows remain valid.
  //   • the four token counts mirror Anthropic's usage object: uncached
  //     input, 5-min cache writes, cache reads (hits), and output (which
  //     for Fable includes always-on thinking tokens).
  //
  // Higher-volume than most tables (one row per model call), so reports walk
  // bounded windows through `by_createdAt` rather than collecting the whole
  // table, and a retention sweep cron trims rows past the report's needs.
  // The all-institution rollup also uses this index: it must visit every event
  // in the selected window, so an institution+time index would add N+1 scans
  // and high-volume write/storage cost without reducing documents read.
  usageEvents: defineTable({
    source: v.string(),
    role: v.optional(v.string()),
    institutionId: v.optional(v.id("institutions")),
    model: v.string(),
    inputTokens: v.number(), // uncached input
    cacheWriteTokens: v.number(), // 5-min ephemeral cache writes
    cacheReadTokens: v.number(), // cache hits (reads)
    outputTokens: v.number(), // output (Fable: incl. thinking)
    audioSeconds: v.optional(v.number()), // duration-metered audio input
    characters: v.optional(v.number()), // character-metered text input
    images: v.optional(v.number()), // per-image count (Gemini image model)
    sessionId: v.optional(v.id("sessions")),
    createdAt: v.number(),
  }).index("by_createdAt", ["createdAt"]).index("by_institution", ["institutionId"]),

  // ── GUARDIANSHIPS (parent ↔ scholar relationship) ─────────────────────
  // The real link the old token model lacked: which parent accounts may
  // see which scholars' (non-sensitive) learning data. Many-to-many — one
  // parent can have several kids, one kid several guardians. All guardians
  // are treated identically (no relationship "type" — Andy: don't care
  // which). Created by a scholar-admin (teacher/admin/operations staff). The gate
  // `requireGuardianOf` (convex/lib/auth.ts) reads this; parents NEVER get
  // sensitive surfaces (dossier/docs/observations/transcripts).
  guardianships: defineTable({
    parentUserId: v.id("users"), // role === "parent"
    scholarUserId: v.id("users"), // role === "scholar"
    createdBy: v.id("users"), // audit: the scholar-admin who linked them
  })
    .index("by_parent", ["parentUserId"])
    .index("by_scholar", ["scholarUserId"])
    // Membership check + dedupe: at most one row per (parent, scholar).
    .index("by_pair", ["parentUserId", "scholarUserId"]),

  // ── PARENT CHAT (the parent aide) ─────────────────────────────────────
  // A parent's single-thread conversation with an AI aide that answers
  // questions about THEIR OWN children only. Deliberately separate from the
  // teacher-keyed `chats` / curriculumMessages tables (gated staff-
  // only) so the parent surface is fully isolated — the aide's tools are
  // guardianship-scoped in /parent-chat-stream, and never expose
  // transcripts / dossier / docs. One flat thread per parent (no
  // multi-session for v1).
  parentChatMessages: defineTable({
    parentUserId: v.id("users"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    streamId: v.optional(v.string()), // set on the in-progress assistant row
  }).index("by_parent", ["parentUserId"]),

  // ── NOTIFICATION PREFERENCES (scaffold; sending is a FUTURE phase) ─────
  // Per-user channel + cadence knobs the future digest / homework-reminder
  // job will read. NOTHING sends today — these are just stored toggles, so
  // the later "dispatch" phase needs no migration. One row per user
  // (parents now; staff can reuse the same table later). All fields
  // optional; `getMyPrefs` fills defaults when a row is absent. SMS needs a
  // phone number (users.phone). See review/parent-role-plan.md §10.
  notificationPrefs: defineTable({
    userId: v.id("users"),
    emailEnabled: v.optional(v.boolean()), // default true
    smsEnabled: v.optional(v.boolean()), // default false (needs a phone)
    weeklyDigest: v.optional(v.boolean()), // default true
    homeworkReminders: v.optional(v.boolean()), // default true
    digestDay: v.optional(v.string()), // e.g. "sunday"; default "sunday"
  }).index("by_user", ["userId"]),

  // ── PARENT MESSAGING (teacher ↔ family threads + multi-channel delivery) ──
  // One thread per scholar includes that scholar's linked guardians and staff.
  // `parentUserId` is the legacy anchor retained during the widen/migrate/narrow
  // rollout; access and per-parent read state live in parentThreadParticipants.
  parentThreads: defineTable({
    parentUserId: v.id("users"), // DEPRECATED: first participant; remove after backfill
    teacherId: v.optional(v.id("users")), // staff author; null = parent-initiated
    scholarId: v.optional(v.id("users")), // SUBJECT of the conversation (never an access grant)
    // Required for new scholar-less staff threads. Legacy rows remain unstamped
    // during the widen; staff access derives only when every guardian child is
    // at one unambiguous institution.
    institutionId: v.optional(v.id("institutions")),
    broadcastId: v.optional(v.string()), // DEPRECATED: old per-parent broadcast rollup
    botEnabled: v.optional(v.boolean()), // DEPRECATED: removed in-thread assistant
    lastMessageAt: v.number(),
    lastParentToTeacherAt: v.optional(v.number()),
    lastToParentAt: v.optional(v.number()),
    lastReadByParentAt: v.optional(v.number()), // DEPRECATED: participant rows own this
    lastReadByTeacherAt: v.optional(v.number()),
  })
    .index("by_parent", ["parentUserId"])
    .index("by_teacher", ["teacherId"])
    .index("by_scholar", ["scholarId"])
    .index("by_institution", ["institutionId"])
    .index("by_broadcast", ["broadcastId"]),

  parentThreadParticipants: defineTable({
    threadId: v.id("parentThreads"),
    parentUserId: v.id("users"),
    lastReadAt: v.optional(v.number()),
  })
    .index("by_thread", ["threadId"])
    .index("by_parent", ["parentUserId"])
    .index("by_thread_parent", ["threadId", "parentUserId"]),

  // One human-authored message in a thread. Assistant-era values remain
  // accepted only so the widened schema can coexist with old documents until
  // the cleanup migration is explicitly run and verified.
  parentMessages: defineTable({
    threadId: v.id("parentThreads"),
    authorType: v.union(
      v.literal("teacher"),
      v.literal("parent"),
      v.literal("bot"),
    ),
    authorUserId: v.optional(v.id("users")), // absent only on deprecated bot rows
    body: v.string(),
    // DEPRECATED assistant-era fields; new writes omit them.
    audience: v.optional(
      v.union(
        v.literal("rabbithole"),
        v.literal("teacher"),
        v.literal("both"),
      ),
    ),
    broadcastId: v.optional(v.string()),
    retracted: v.optional(v.boolean()),
    streamId: v.optional(v.string()),
    // For an inbound off-portal row: the provider's message id (WhatsApp
    // `wamid`, Slack event/message id, etc.). Used to dedupe at-least-once
    // webhooks so a replay cannot re-append + re-trigger downstream sends.
    providerMessageId: v.optional(v.string()),
    // Transport a message was AUTHORED through, for a teacher-facing "via X"
    // provenance badge (mirrors `chats.source`). Unset = the in-app portal.
    // Only "slack" today (a teacher reply typed in their Slack DM bridge).
    source: v.optional(v.literal("slack")),
  })
    .index("by_thread", ["threadId"])
    .index("by_provider_message", ["providerMessageId"]),

  // Short-lived, metadata-only cache for the one eligible external link in a
  // visible family message. It deliberately stores no HTML, image bytes, or
  // provider response body; both ready and failed rows expire quickly.
  messageLinkPreviewCache: defineTable({
    url: v.string(),
    hostname: v.string(),
    state: v.union(v.literal("pending"), v.literal("ready"), v.literal("failed")),
    claimId: v.optional(v.string()),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    expiresAt: v.number(),
  })
    .index("by_url", ["url"])
    .index("by_expires_at", ["expiresAt"]),

  // A small per-viewer window prevents the message-bound preview action from
  // becoming a high-rate external fetch relay.
  messageLinkPreviewRateLimits: defineTable({
    viewerId: v.id("users"),
    count: v.number(),
    windowEndsAt: v.number(),
  }).index("by_viewer", ["viewerId"]),

  // Uploads staged for, or claimed by, a family message. `source: "portfolio"`
  // borrows storage owned by a portfolio item, so message cleanup must never
  // delete that blob. Existing rows predate provenance and are uploads.
  parentMessageAttachments: defineTable({
    messageId: v.optional(v.id("parentMessages")),
    threadId: v.optional(v.id("parentThreads")),
    storageId: v.id("_storage"),
    uploaderId: v.id("users"),
    fileName: v.string(),
    mimeType: v.string(),
    sizeBytes: v.number(),
    source: v.optional(v.union(v.literal("upload"), v.literal("portfolio"))),
    portfolioItemId: v.optional(v.id("portfolioItems")),
  })
    .index("by_message", ["messageId"])
    .index("by_thread", ["threadId"])
    .index("by_storage", ["storageId"])
    .index("by_uploader", ["uploaderId"]),

  // The unit of SEND. Portal and phone rows are per guardian. A group email has
  // one row anchored to the first recipient; dispatch resolves every current
  // participant and sends one email with the group in `To`.
  messageDeliveries: defineTable({
    messageId: v.id("parentMessages"),
    parentUserId: v.id("users"),
    channel: v.union(
      v.literal("portal"),
      v.literal("email"),
      v.literal("sms"),
      v.literal("whatsapp"),
    ),
    status: v.union(
      v.literal("queued"),
      v.literal("sent"),
      v.literal("delivered"),
      v.literal("failed"),
      v.literal("skipped"), // no opted-in identity / suppressed
    ),
    providerId: v.optional(v.string()),
    error: v.optional(v.string()),
  })
    .index("by_message", ["messageId"])
    .index("by_status", ["status"])
    // Twilio status-callback lookup: provider message SID → our delivery row.
    .index("by_provider", ["providerId"])
    .index("by_message_parent_channel", [
      "messageId",
      "parentUserId",
      "channel",
    ]),

  // A parent's OFF-PORTAL channel opt-ins (sms / whatsapp). Email is on by
  // default via notificationPrefs.emailEnabled and needs no row; these phone
  // channels are OFF until the parent self-serves an opt-in (a row with
  // `optInAt` and `stopState !== true`). `by_identity` is the FAIL-CLOSED
  // lookup the inbound webhooks use to resolve a sender — an unmapped number
  // gets no data and no bot answer (the users.slackUserId stance).
  parentChannelIdentities: defineTable({
    parentUserId: v.id("users"),
    channel: v.union(v.literal("sms"), v.literal("whatsapp")),
    identity: v.string(), // E.164 phone / WhatsApp id
    preferred: v.optional(v.boolean()),
    optInAt: v.optional(v.number()),
    consentSource: v.optional(v.string()), // "self-serve" | "staff"
    stopState: v.optional(v.boolean()), // true = opted out (STOP / unsubscribe)
    // Last time this parent messaged us on this channel — opens WhatsApp's
    // 24-hour customer-service window (free-form replies allowed inside it;
    // a pre-approved template is required outside it).
    lastInboundAt: v.optional(v.number()),
    // The wamid of the last opt-in webhook we processed on this identity. Meta
    // delivers webhooks at-least-once, so we dedup a re-delivered opt-in on this
    // (the normal-message path dedups via parentMessages.providerMessageId).
    lastInboundMessageId: v.optional(v.string()),
  })
    .index("by_parent", ["parentUserId"])
    .index("by_identity", ["channel", "identity"]),

  processState: defineTable({
    sessionId: v.id("sessions"),
    processId: v.id("processes"),
    currentStep: v.string(),
    steps: v.array(
      v.object({
        key: v.string(),
        status: v.union(
          v.literal("not_started"),
          v.literal("in_progress"),
          v.literal("completed")
        ),
        commentary: v.optional(v.string()),
      })
    ),
  }).index("by_session", ["sessionId"]),

  // ─── Scholar Documents (Phase 2 — cognitive-assessment-first onboarding) ──
  //
  // Sensitive per-scholar source documents (cognitive assessments, IEPs,
  // parent notes, observations). Read/write gated to teacher + admin only.
  // Scholars must NEVER access this table — the redactedSummary is used to
  // generate directives/seeds that eventually surface to the tutor (and thus
  // potentially to the scholar), so the redaction pass is load-bearing.
  scholarDocuments: defineTable({
    scholarId: v.id("users"),
    kind: v.union(
      v.literal("teacher_report"), // teacher-authored narrative report (was the `reports` table)
      v.literal("assessment"), // cognitive / neuropsych eval
      v.literal("iep"), // IEP or 504 plan
      v.literal("report_card"), // school report card; staff-only source material
      v.literal("identity_document"), // identity verification; never tutor-fed
      v.literal("parent_email"), // email or note from a parent
      v.literal("observation"), // teacher/staff written observation
      v.literal("other"),
    ),
    // How this document was entered. Drives which fields are populated and how
    // it reaches the tutor. Optional for back-compat: pre-existing rows have no
    // `format` and are all uploads, so read code treats `undefined` as "file".
    //   "text" — teacher typed it (bodyText is the source of truth)
    //   "file" — PDF/image upload (the original extract→redact pipeline)
    //   "gdoc" — a linked Google Doc (link only; no content stored or ingested)
    format: v.optional(
      v.union(v.literal("text"), v.literal("file"), v.literal("gdoc")),
    ),
    title: v.string(), // human-facing label
    // Teacher-authored body for `format:"text"` (e.g. a Teacher Report). Shown
    // verbatim to teachers; also fed (as extractedText) through the SAME
    // redaction pass as uploads so the scholar-facing tutor only ever sees the
    // redacted* variant — sensitivity is handled by the pipeline, never by
    // which input button was used.
    bodyText: v.optional(v.string()),
    // Link metadata for `format:"gdoc"`. Link-only by design: we store the
    // Drive id + url, never the doc's contents, so nothing is ingested unless a
    // future "pull text" action explicitly does so (and then it redacts too).
    link: v.optional(
      v.object({
        driveFileId: v.string(),
        url: v.string(),
        name: v.optional(v.string()),
        mimeType: v.optional(v.string()),
      }),
    ),
    // Whether this document's REDACTED findings join the bounded "background
    // notes" section of the scholar tutor prompt (see prompts.buildDocumentNotesSection).
    // Default true for teacher-authored notes (teacher_report/observation/other);
    // false for sensitive uploads (assessment/iep/parent_email), which reach the
    // tutor only via a teacher-approved proposal. Stored so a teacher can toggle.
    feedsTutor: v.optional(v.boolean()),
    fileStorageId: v.optional(v.id("_storage")), // optional because purge policy may delete it
    fileMimeType: v.optional(v.string()),
    fileSizeBytes: v.optional(v.number()),
    extractedText: v.optional(v.string()), // full OCR/PDF text, internal-only
    // Two audiences. Both have PII stripped (names, full DOB, address, clinician,
    // license #, non-educational medical). "redacted" = the ADDITIONAL removal of
    // assessment numbers (IQ / index / subtest scores, percentiles) for the
    // scholar-facing tutor. The proposal generator (→ directives/seeds → tutor
    // system prompt) reads ONLY the redacted* fields — never the score-bearing
    // ones. See scholarDocumentActions.ts.
    summary: v.optional(v.string()), // full detail incl. scores — TEACHER-facing
    keyFindings: v.optional(v.array(v.string())), // full bullets (may cite scores) — teacher-facing
    redactedSummary: v.optional(v.string()), // scores removed — feeds the scholar-facing tutor
    redactedKeyFindings: v.optional(v.array(v.string())), // number-free bullets — scholar-facing
    uploadedBy: v.id("users"),
    processingStatus: v.union(
      v.literal("pending"),
      v.literal("extracting"),
      v.literal("redacting"),
      v.literal("ready"),
      v.literal("error"),
    ),
    processingError: v.optional(v.string()),
  })
    .index("by_scholar", ["scholarId"])
    .index("by_scholar_kind", ["scholarId", "kind"]),

  // Audit trail for every access to scholarDocuments.
  documentAccessLog: defineTable({
    documentId: v.id("scholarDocuments"),
    scholarId: v.id("users"), // denormalized for easy per-scholar audit
    userId: v.id("users"), // who accessed
    action: v.union(
      v.literal("upload"),
      v.literal("view_summary"), // read redactedSummary
      v.literal("view_extracted"), // read full extractedText
      v.literal("download_pdf"),
      v.literal("delete"),
      v.literal("generate_proposal"),
      v.literal("apply_proposal"),
    ),
  })
    .index("by_document", ["documentId"])
    .index("by_scholar", ["scholarId"])
    .index("by_user", ["userId"]),

  // Cached proposal output for a document so teachers can re-open the diff
  // without re-running the LLM. Keyed 1:1 (or latest-per-doc) by documentId.
  documentProposals: defineTable({
    documentId: v.id("scholarDocuments"),
    scholarId: v.id("users"),
    proposal: v.any(), // structured { rationale, directives[], seeds[], unitSuggestion? }
    generatedBy: v.id("users"), // teacher who triggered generation
    model: v.optional(v.string()),
    // Set when teacher approves (some-or-all of) the proposal.
    appliedAt: v.optional(v.number()),
    appliedBy: v.optional(v.id("users")),
    // Set when teacher rejects the proposal outright.
    rejectedAt: v.optional(v.number()),
    rejectedBy: v.optional(v.id("users")),
  })
    .index("by_document", ["documentId"])
    .index("by_scholar", ["scholarId"]),

  readingLevelHistory: defineTable({
    scholarId: v.id("users"),
    level: v.string(),
    source: v.union(v.literal("teacher"), v.literal("observer")),
    changedBy: v.optional(v.id("users")),
  }).index("by_scholar", ["scholarId"]),

  // Optional per-user link to a Google account. Currently used by the
  // Slides export path for teachers/curriculum designers; reusable for
  // future Drive / Classroom / Calendar integrations.
  //
  // Tokens are stored server-side and never exposed to the client. The
  // `getAccessToken` helper in `lib/google.ts` refreshes the access token
  // when within 5 min of expiry.
  googleAccounts: defineTable({
    userId: v.id("users"),
    googleSub: v.string(), // stable Google user id ("sub" claim)
    email: v.string(),
    // OpenID profile name for the linked Google identity. Google Drive comment
    // authors expose this display name but suppress email/sub/permissionId, so
    // it safely narrows which linked token should perform the final `author.me`
    // verification.
    googleDisplayName: v.optional(v.string()),
    accessToken: v.string(),
    refreshToken: v.optional(v.string()), // present when offline access granted
    expiresAt: v.number(), // ms epoch
    scopes: v.array(v.string()),
    connectedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_googleSub", ["googleSub"])
    .index("by_email", ["email"]),

  // ─── Institution-owned Google sync identity ───────────────────────
  //
  // The credential the Drive-sync inbox calls Google as, owned by the
  // INSTITUTION (a school), not a person. This is the decoupling that lets
  // "the school's inbox" survive staff churn and shrink its blast radius —
  // versus overloading a staffer's personal 1:1 `googleAccounts` link (which
  // is shared with the Slides picker + deck creation and exposes their whole
  // Drive). The scanner's legacy row omits `purpose`; a separately consented
  // Docs bot uses `purpose: "docs_bot"` so it can never replace that scanner.
  // `identityType` discriminates:
  //
  //   "google_oauth"    — a dedicated real Google account, linked via the
  //                       existing OAuth flow (or minted from a staffer's
  //                       token during backfill). Holds accessToken /
  //                       refreshToken / expiresAt, refreshed like the
  //                       per-user link. Blast radius = that account's Drive
  //                       (keep it empty except the folder).
  //   "service_account" — a Google Cloud service account. Holds the SA key
  //                       (email + PEM private key + key id); we mint 2-legged
  //                       JWT access tokens on demand and cache them in
  //                       saAccessToken/saAccessTokenExpiresAt. The folder is
  //                       SHARED to the SA's email — no domain-wide delegation.
  //                       Blast radius = only what's explicitly shared. The
  //                       enterprise-grade north star.
  //
  // See `convex/lib/serviceAccount.ts` + `convex/lib/googleTokens.ts`
  // (getValidAccessTokenForCredential) and review/drive-sync-institution-accounts-plan.html.
  institutionGoogleAccounts: defineTable({
    institutionId: v.id("institutions"),
    // Purpose-less rows remain scanner credentials. Read `docs_bot` as the
    // legacy Workspace principal while new connections use `workspace_bot`.
    purpose: v.optional(
      v.union(v.literal("docs_bot"), v.literal("workspace_bot")),
    ),
    identityType: v.union(
      v.literal("google_oauth"),
      v.literal("service_account"),
    ),
    // Display email for the identity — the OAuth account's email, or the SA's
    // client_email. Always set (it's what the admin surface shows).
    email: v.string(),
    // Least-privilege scopes this credential was granted (drive.readonly only
    // for a scanner inbox — it never makes slides).
    scopes: v.array(v.string()),
    // ── identityType === "google_oauth" ──
    googleSub: v.optional(v.string()),
    accessToken: v.optional(v.string()),
    refreshToken: v.optional(v.string()),
    expiresAt: v.optional(v.number()), // ms epoch
    // ── identityType === "service_account" ──
    saClientEmail: v.optional(v.string()),
    saPrivateKey: v.optional(v.string()), // PEM (PKCS#8)
    saPrivateKeyId: v.optional(v.string()),
    saClientId: v.optional(v.string()),
    saTokenUri: v.optional(v.string()),
    // Cached JWT-minted access token so we don't re-sign on every call.
    saAccessToken: v.optional(v.string()),
    saAccessTokenExpiresAt: v.optional(v.number()), // ms epoch
    connectedAt: v.number(),
    connectedBy: v.optional(v.id("users")), // audit: who configured it
  }).index("by_institution", ["institutionId"]),

  // Workspace Events subscriptions for Docs created by the staff aide. These
  // are short-lived (resource payloads cap at four hours without DWD), so the
  // expiry index drives proactive renewal rather than treating them as static
  // integration configuration.
  googleDocsSubscriptions: defineTable({
    institutionId: v.id("institutions"),
    documentId: v.string(),
    subscriptionName: v.string(),
    expireTime: v.number(),
    createdBy: v.id("users"),
    status: v.union(v.literal("active"), v.literal("dead")),
    eventTypes: v.optional(v.array(v.string())),
    lastError: v.optional(v.string()),
    renewalFailureCount: v.optional(v.number()),
  })
    .index("by_document", ["documentId"])
    .index("by_expiry", ["expireTime"]),

  // Pub/Sub is at-least-once. One receipt claims both the Pub/Sub message id
  // and CloudEvent id before ACK; the per-comment index separately caps the
  // worker at one reply in the original Google Docs thread.
  googleDocsEventReceipts: defineTable({
    messageId: v.string(),
    eventId: v.string(),
    eventType: v.string(),
    documentId: v.optional(v.string()),
    commentId: v.optional(v.string()),
    replyId: v.optional(v.string()),
    mentionedEmails: v.array(v.string()),
    authorEmail: v.optional(v.string()),
    receivedAt: v.number(),
    status: v.union(
      v.literal("received"),
      v.literal("ignored"),
      v.literal("processing"),
      v.literal("replied"),
      v.literal("failed"),
    ),
    replyClaimedAt: v.optional(v.number()),
    repliedAt: v.optional(v.number()),
    error: v.optional(v.string()),
  })
    .index("by_message", ["messageId"])
    .index("by_event", ["eventId"])
    .index("by_comment", ["documentId", "commentId"])
    .index("by_trigger", ["documentId", "commentId", "replyId"]),

  // ─── Portfolio (scholar work samples) ─────────────────────────────
  //
  // A scholar's body of WORK — scanned worksheets, drawings, projects,
  // photos of physical builds. Distinct from `scholarDocuments` (which is
  // sensitive ADULT-facing source material — assessments, IEPs — that must
  // never reach the scholar). Portfolio items are the kid's own output, so
  // there's no redaction pass: we extract a caption + any text for search
  // and surfacing, and that's it.
  //
  // The marquee ingestion path is a classroom printer/scanner that drops
  // PDFs/images into a watched Google Drive folder. Each scan is matched to
  // a scholar by the name the kid wrote in the corner (read by Claude
  // vision). Confident matches auto-assign; uncertain ones land in a teacher
  // review queue (matchStatus = "unmatched" | "ambiguous"). Manual uploads
  // (source = "manual") are matched at upload time, so they skip straight to
  // "confirmed".
  //
  // Teacher/admin gated like scholarDocuments, but the sensitivity bar is
  // lower (it's the scholar's own work) — the gate is about tidiness and
  // attribution, not secrecy.
  portfolioItems: defineTable({
    // Legacy singular owner. New work uses portfolioAttributions; readers fall
    // back here until the attribution migration is narrowed.
    scholarId: v.optional(v.id("users")),
    // The institution this scan belongs to — the folder's owning school for a
    // Drive-synced item, the uploader's institution for a manual one. Drives
    // institution-scoped matching (a scan at School A can never match School
    // B's roster) and the per-institution "To review" queue. Optional so
    // pre-per-institution rows stay valid; unmatched legacy rows ride the
    // primary school's lens (same rule as scholarInLens) until backfilled.
    institutionId: v.optional(v.id("institutions")),
    title: v.string(), // filename or AI-derived label
    // Where the scan came IN from. All sources run the same AI pipeline.
    //   google_drive — auto-synced from the watched printer folder, OR a
    //                  one-off file the teacher picked from their Drive
    //   upload       — a file the teacher uploaded directly
    //   photo        — captured from the webcam (1+ pages → one PDF)
    //   manual       — legacy per-scholar manual upload (scholar known up front)
    source: v.union(
      v.literal("google_drive"),
      v.literal("upload"),
      v.literal("photo"),
      v.literal("manual"),
      v.literal("capture_station"),
    ),
    fileStorageId: v.optional(v.id("_storage")),
    fileMimeType: v.optional(v.string()),
    fileSizeBytes: v.optional(v.number()),
    // Derived ~512px JPEG preview, generated server-side at ingest (photon for
    // images, PDFium page-1 raster for PDFs). Optional so the field is additive;
    // the UI falls back to a file-type icon when absent or "error".
    thumbStorageId: v.optional(v.id("_storage")),
    thumbStatus: v.optional(
      v.union(
        v.literal("pending"), // queued / generating
        v.literal("ready"), // thumbStorageId is set and usable
        v.literal("error"), // generation failed — show the icon fallback
      ),
    ),
    // Drive provenance — the dedupe key so a re-ping never double-ingests.
    // One scanned Drive file can split into several items (a stack of
    // submissions), so driveFileId is NOT unique; it marks "which scan did
    // this come from" and gates re-ingest at the file level.
    driveFileId: v.optional(v.string()),
    // When this item is one segment carved out of a multi-page scan, the
    // 1-indexed inclusive page range it occupied in the original file.
    pageRange: v.optional(v.object({ start: v.number(), end: v.number() })),
    // AI outputs (no redaction — scholar's own work).
    extractedText: v.optional(v.string()), // transcribed text, for search
    aiCaption: v.optional(v.string()), // 1–2 sentence description of the work
    // Structured learner voice extracted only from a self-report / learning-profile
    // scan. This remains anchored to the source work item and is deliberately
    // separate from mastery observations and observer-authored session signals.
    learnerStatements: v.optional(
      v.array(
        v.object({
          kind: v.union(
            v.literal("interest"),
            v.literal("self_reflection"),
          ),
          facet: v.optional(
            v.union(
              v.literal("confidence"),
              v.literal("self_efficacy"),
              v.literal("insight"),
            ),
          ),
          text: v.string(),
        }),
      ),
    ),
    // Three distinct names for this work. title is the filename/caption-derived
    // name. documentHeading is what a scanned page prints on itself, verbatim,
    // capped at 80 chars — scanner-only (a program capture has none). label is
    // the human-assigned name the school gives the work (e.g. "Learning
    // Print"), also capped at 80 chars; it names scanned documents AND program
    // captures alike, so it is deliberately source-neutral, not "documentLabel".
    // label is human-only: no AI/extraction path may ever write it, and a
    // heading-extraction sweep must never clear it.
    // "" means extraction looked and found no printed heading; undefined means
    // this item has never had heading extraction.
    documentHeading: v.optional(v.string()),
    label: v.optional(v.string()),
    // Matching.
    detectedName: v.optional(v.string()), // raw name read off the page
    matchConfidence: v.optional(v.number()), // 0–1 from the matcher
    matchStatus: v.union(
      v.literal("unmatched"), // no scholar found — needs teacher review
      v.literal("ambiguous"), // multiple candidates — needs teacher review
      v.literal("matched"), // auto-matched with confidence; scholarId set
      v.literal("confirmed"), // a teacher (or manual upload) set the scholar
    ),
    // ── Assignment tagging (which assignment is this scan FOR?) ──
    // Second resolution axis alongside the scholar. An item is only fully
    // "processed" when BOTH the scholar and the assignment are resolved.
    // assignmentStatus:
    //   "unresolved" — not decided yet → needs teacher review
    //   "matched"    — AI auto-tagged (content match + scholar is enrolled)
    //   "confirmed"  — a teacher picked the assignment
    //   "none"       — decided NOT to belong to any assignment (still "filled")
    assignmentId: v.optional(v.id("assignments")),
    assignmentStatus: v.optional(
      v.union(
        v.literal("unresolved"),
        v.literal("matched"),
        v.literal("confirmed"),
        v.literal("none"),
      ),
    ),
    // ── Activity tagging (which activity within the assignment?) ──
    // Optional refinement of the assignment axis. When a teacher sets
    // BOTH a scholar and an activity, the item "materializes" into an
    // offline project + file deliverable (see portfolioMaterialize.ts),
    // so the scan flows into the activity's submissions + any Share Back
    // that lists it as a source. Left unset → the scan is filed to the
    // cohort as a body-of-work item but produces no deliverable.
    activityId: v.optional(v.id("activities")),
    // Undefined legacy rows retain their pre-migration guardian visibility. New
    // writers are explicit: ordinary school ingest stays family-visible, while
    // capture-station evidence starts staff-only until it is curated.
    familyVisibility: v.optional(
      v.union(v.literal("staff_only"), v.literal("attributed_families")),
    ),
    uploadedBy: v.optional(v.id("users")), // null for Drive-sourced
    // ── Magic Annotations ──
    // When the scan carried Magic Corners, the "magic version" of the file,
    // kept ALONGSIDE the original so the UI can show a before/after. Same kind
    // of file as the original: an image item → the redrawn image; a (possibly
    // multi-page) PDF → the PDF with each marked page substituted in place.
    // magicInstruction is what was read out of the frame(s) (page-tagged when
    // there's more than one).
    magicStorageId: v.optional(v.id("_storage")),
    // A thumbnail of the magic version (JPEG), so a card can preview the
    // redraw without loading the full file — and so a magic PDF (whose redraw
    // is a PDF, not an image) still has an inline preview. Same role as
    // thumbStorageId but for the magic variant.
    magicThumbStorageId: v.optional(v.id("_storage")),
    magicInstruction: v.optional(v.string()),
    processingStatus: v.union(
      v.literal("pending"),
      v.literal("extracting"), // Claude vision reading the page
      v.literal("matching"), // resolving detectedName -> scholar
      v.literal("ready"),
      v.literal("error"),
    ),
    processingError: v.optional(v.string()),
    // Did the observer look at this scan for LEARNING evidence? Mirrors
    // thumbStatus: absent = never considered, "pending" = claimed + scheduled,
    // "ready" = the assess run finished (possibly with ZERO observations — a
    // blank page or a survey is a valid nothing-to-say outcome), "skipped" =
    // ineligible (materialized into an activity/deliverable, unresolved
    // scholar, no file), "error" = the run failed and may be retried.
    // Only activity-LESS scans go down this path; a tagged scan is assessed as
    // a deliverable instead (deliverableAssess.ts). See portfolioAssess.ts.
    observationStatus: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("ready"),
        v.literal("skipped"),
        v.literal("error"),
      ),
    ),
  })
    .index("by_scholar", ["scholarId"])
    .index("by_driveFileId", ["driveFileId"])
    .index("by_matchStatus", ["matchStatus"])
    .index("by_processingStatus", ["processingStatus"])
    .index("by_processing_match", ["processingStatus", "matchStatus"])
    .index("by_processing_assignment", [
      "processingStatus",
      "assignmentStatus",
    ])
    .index("by_institution_processing_status", [
      "institutionId",
      "processingStatus",
    ])
    .index("by_institution_processing_match", [
      "institutionId",
      "processingStatus",
      "matchStatus",
    ])
    .index("by_institution_processing_assignment", [
      "institutionId",
      "processingStatus",
      "assignmentStatus",
    ])
    .index("by_assignment", ["assignmentId"])
    .index("by_activity", ["activityId"])
    .index("by_institution", ["institutionId"]),

  // Attribution is deliberately separate from the scanned/uploaded binary:
  // one work sample can belong to several scholars without duplicating storage,
  // OCR, captioning, or portfolio records.
  portfolioAttributions: defineTable({
    portfolioItemId: v.id("portfolioItems"),
    scholarId: v.id("users"),
    attributedAt: v.number(),
    attributedBy: v.optional(v.id("users")),
    reflection: v.optional(v.string()),
    reflectionUpdatedAt: v.optional(v.number()),
  })
    .index("by_item", ["portfolioItemId"])
    .index("by_scholar", ["scholarId"])
    .index("by_item_scholar", ["portfolioItemId", "scholarId"]),

  // Capability-scoped shared devices used only to capture program work. A
  // station is bound server-side to one institution + scholar group and never
  // receives a scholar or staff auth session.
  captureStations: defineTable({
    institutionId: v.id("institutions"),
    scholarGroupId: v.id("scholarGroups"),
    label: v.string(),
    // Absent until a STATIC kiosk device is provisioned for this station. The
    // assigned-device capture path authenticates off the scholar's own paired
    // session and never reads this, so creating a station must not mint a
    // credential nobody will redeem.
    enrollmentTokenHash: v.optional(v.string()),
    // The enrollment secret provisions one physical station, not an unbounded
    // fleet. We retain only a hash so a database read cannot replay it.
    enrolledDeviceIdHash: v.optional(v.string()),
    enrollmentEpoch: v.optional(v.number()),
    sessionWindowStartedAt: v.optional(v.number()),
    sessionsIssuedInWindow: v.optional(v.number()),
    enabled: v.boolean(),
    createdBy: v.id("users"),
    createdAt: v.number(),
    rotatedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_group", ["scholarGroupId"])
    .index("by_enrollment_token_hash", ["enrollmentTokenHash"])
    .index("by_institution", ["institutionId"]),

  captureStationSessions: defineTable({
    captureStationId: v.id("captureStations"),
    deviceId: v.string(),
    sessionTokenHash: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
    // A rotated enrollment may leave this session alive only long enough to
    // report or finalize its own already-issued upload reservations. It cannot
    // bootstrap, mint URLs, or start unrelated captures.
    recoveryOnly: v.optional(v.boolean()),
    lastUsedAt: v.optional(v.number()),
    uploadUrlsIssued: v.optional(v.number()),
    capturesRegistered: v.optional(v.number()),
    registeredBytes: v.optional(v.number()),
    // Present only for a temporary capture mode on an already assigned managed
    // iPad. Capability validation rechecks this exact binding/revision so a
    // stop, expiry, reassignment, revocation, or replacement takes effect
    // immediately for every existing session token.
    pairedDeviceId: v.optional(v.id("pairedDevices")),
    assignedDeviceCaptureUpdatedAt: v.optional(v.number()),
  })
    .index("by_station", ["captureStationId"])
    .index("by_session_token_hash", ["sessionTokenHash"]),

  captureStationUploadReservations: defineTable({
    captureStationId: v.id("captureStations"),
    sessionId: v.id("captureStationSessions"),
    // Records the enrollment-token generation that issued this URL for audit.
    // Unknown-blob debt is intentionally station-lifetime, not epoch-scoped.
    enrollmentEpoch: v.optional(v.number()),
    // Absent = the capture's own media. "poster" = the small still that stands
    // in for a video. A poster gets its OWN reservation so it is metered,
    // swept, and provenance-checked exactly like the media it accompanies;
    // the two roles are never interchangeable at register time.
    purpose: v.optional(v.literal("poster")),
    status: v.union(
      v.literal("issued"),
      v.literal("uploaded"),
      v.literal("finalized"),
      v.literal("cancelled"),
      // An expired direct-upload URL never reveals its storage id unless the
      // client reports back. Retain this accounting row to bound those blobs.
      v.literal("abandoned"),
    ),
    storageId: v.optional(v.id("_storage")),
    mimeType: v.optional(v.string()),
    sizeBytes: v.optional(v.number()),
    captureId: v.optional(v.id("captureStationCaptures")),
    createdAt: v.number(),
    updatedAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_station", ["captureStationId"])
    .index("by_session", ["sessionId"])
    .index("by_storage", ["storageId"])
    .index("by_status_expiry", ["status", "expiresAt"]),

  captureStationCaptures: defineTable({
    captureStationId: v.id("captureStations"),
    sessionId: v.id("captureStationSessions"),
    portfolioItemId: v.id("portfolioItems"),
    storageId: v.id("_storage"),
    scholarIds: v.array(v.id("users")),
    mimeType: v.string(),
    sizeBytes: v.number(),
    createdAt: v.number(),
    undoneAt: v.optional(v.number()),
    videoDurationMs: v.optional(v.number()),
    videoThumbStorageId: v.optional(v.id("_storage")),
  })
    .index("by_station", ["captureStationId"])
    .index("by_session", ["sessionId"])
    .index("by_storage", ["storageId"])
    .index("by_portfolio_item", ["portfolioItemId"]),

  // ─── Drive sync state ─────────────────────────────────────────────
  //
  // Per-INSTITUTION config + cursor for a watched Drive folder feeding the
  // portfolio. One row per institution (keyed by `institutionId`; still
  // indexed by `folderId` for the channel-ops path). Holds:
  //   - institutionId: the school this inbox belongs to. Optional during the
  //     widen→backfill→narrow migration; the per-institution connect flow
  //     always sets it.
  //   - credentialRef: pointer to the institution-owned sync identity
  //     (`institutionGoogleAccounts`) we call Drive as. Replaces the personal
  //     `syncOwnerUserId` link — which is kept optional for legacy rows and
  //     the OAuth-from-a-staffer backfill path.
  //   - startPageToken: the changes.list cursor — advanced after each sync.
  //   - channelId / resourceId / channelExpiration: the active
  //     changes.watch push channel, renewed by a cron before expiry.
  //   - channelToken: random secret echoed back in X-Goog-Channel-Token so
  //     the webhook can reject pings that don't originate from our watch.
  // See `convex/driveSync.ts` + `convex/driveSyncState.ts`.
  driveSyncState: defineTable({
    folderId: v.string(),
    // The institution that owns this inbox. Optional during migration; the
    // per-institution connect flow always sets it.
    institutionId: v.optional(v.id("institutions")),
    // The institution-owned credential we call Drive as. Optional for legacy
    // rows that still point at a personal syncOwnerUserId.
    credentialRef: v.optional(v.id("institutionGoogleAccounts")),
    // LEGACY: the Rabbithole user whose personal googleAccounts link we called
    // Drive as, before institution credentials. Widened to optional — new rows
    // use credentialRef; service-account rows have no user at all.
    syncOwnerUserId: v.optional(v.id("users")),
    // Friendly label for the scanner that drops into this folder
    // (e.g. "Brother MFC-L2750DW"). Shown in the Add-work panel.
    printerName: v.optional(v.string()),
    // Short how-to shown under the Add-work buttons (e.g. "Load pages face-up,
    // press the green Scan-to-Drive button"). Admin-settable.
    printerInstructions: v.optional(v.string()),
    startPageToken: v.optional(v.string()),
    channelId: v.optional(v.string()),
    resourceId: v.optional(v.string()),
    channelExpiration: v.optional(v.number()), // ms epoch
    channelToken: v.optional(v.string()),
    lastSyncedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
  })
    .index("by_folder", ["folderId"])
    .index("by_institution", ["institutionId"]),

  // ─── Drive ingestion claims ───────────────────────────────────────
  //
  // The Drive webhook and the periodic safety-net can list the same file
  // concurrently. This row is the serializable, per-school file-level claim
  // they must obtain before downloading or sending the scan to AI. It is
  // deliberately separate from portfolioItems: a single file can produce many
  // items, and those items are not present until the AI pass finishes.
  //
  // `institutionId` is optional only for the legacy, pre-institution sync row.
  // New Drive syncs always claim on their institution + Drive file id pair.
  driveFileIngestions: defineTable({
    institutionId: v.optional(v.id("institutions")),
    driveFileId: v.string(),
    status: v.union(
      v.literal("claimed"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    // A fencing receipt for the action that owns this attempt. Completion or
    // failure from an expired claimant cannot settle a newer attempt.
    claimToken: v.string(),
    claimedAt: v.number(),
    attempts: v.number(),
    completedAt: v.optional(v.number()),
    failedAt: v.optional(v.number()),
    retryAt: v.optional(v.number()),
    failureReason: v.optional(v.string()),
  }).index("by_institution_drive_file", ["institutionId", "driveFileId"]),

  // ─── Deleted Drive-scan tombstones ────────────────────────────────
  //
  // `portfolio.deleteItem` hard-deletes the portfolioItems row, but the
  // watched-folder sync (interval cron + Drive-watch webhook) re-lists the
  // folder and treats "file with no portfolioItems row" as unseen — so a
  // deleted scan would re-download and resurrect in the scanner inbox on the
  // next sync. A dismissal row keeps the driveFileId durably "already
  // handled" for the AUTOMATIC paths (folder sync + watch re-delivery). An
  // explicit teacher re-pick (`ingestDriveFileById`) deliberately ignores
  // dismissals, so re-importing a deleted file still works.
  driveFileDismissals: defineTable({
    driveFileId: v.string(),
    // Denormalized from the deleted item, for per-school forensics.
    institutionId: v.optional(v.id("institutions")),
    dismissedBy: v.id("users"),
  }).index("by_driveFileId", ["driveFileId"]),

  // ─── Slide media ownership ────────────────────────────────────────
  //
  // A storage id is NOT authorization. `_storage` is one flat namespace shared
  // with scanned health documents and portfolio images, so without this a
  // scholar could put any storage id they learned into their OWN deck and have
  // the export action embed that blob in a file they then download.
  //
  // Every photo or video a client puts on a slide is registered here at upload time, and
  // the write path refuses an `assetId` that is not registered to the deck's
  // owner. Uploads for other features are unaffected — they simply never appear
  // here, so they can never be referenced from a slide.
  slideAssets: defineTable({
    storageId: v.id("_storage"),
    uploaderId: v.id("users"),
    // How the asset got here. Absent on rows predating "Make a picture" (all of
    // which were uploads). Request spend is capped separately below so rejected
    // briefs count too; this field remains provenance for ownership/reporting.
    source: v.optional(
      v.union(
        v.literal("upload"),
        v.literal("generated"),
        v.literal("webSearch"),
      ),
    ),
    searchQuery: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
  })
    .index("by_storage", ["storageId"])
    .index("by_uploader", ["uploaderId"]),

  // One row per accepted "Make it" request, written before either model call.
  // Counting requests rather than successful assets bounds Haiku guardrail spend
  // even when a learner repeatedly submits a topic-only brief that triggers a
  // soft guardrail alert. Uploads never write here.
  slideImageGenerationAttempts: defineTable({
    uploaderId: v.id("users"),
  }).index("by_uploader", ["uploaderId"]),

  // One row per accepted "Find an image" query, written before Brave is called.
  // Picks are uncapped and follow the same semantics as ordinary uploads.
  slideImageSearchAttempts: defineTable({
    uploaderId: v.id("users"),
  }).index("by_uploader", ["uploaderId"]),

  // ─── Submitted deliverables ───────────────────────────────────────
  //
  // One per (project, activity). Re-submitting overwrites the previous
  // row's rubric check fields (unlimited retries). The Quest model is
  // gone — deliverables now live entirely in the activity context.
  deliverables: defineTable({
    activityId: v.id("activities"),
    scholarId: v.id("users"),
    sessionId: v.id("sessions"),
    // The Assignment this submission was made under. Lets the same
    // activity be run with multiple cohorts and each cohort's
    // share-back / submissions panel sees only its own work.
    // Optional during migration.
    assignmentId: v.optional(v.id("assignments")),
    // Content (one of these three is set, depending on activity.deliverable.kind)
    artifactId: v.optional(v.id("artifacts")),
    fileStorageId: v.optional(v.id("_storage")), // for photo / audio / slides export
    textContent: v.optional(v.string()),
    // Structured map checkpoints stay separate from text so teacher and family
    // surfaces never mistake serialized map JSON for a document body.
    mapContent: v.optional(v.string()),
    // Snapshotted from the artifact alongside `textContent`: true when any of
    // the submitted writing was transcribed by the tutor from words the scholar
    // gave in chat. Carried onto the deliverable so the teacher reading a
    // graded submission later can tell that apart from writing the scholar
    // typed themselves — the snapshot outlives the artifact's current state.
    // Positive signal only; see the artifacts field for why absence proves
    // nothing.
    hasTutorTranscription: v.optional(v.boolean()),
    // When this deliverable was materialized from a scanned/uploaded
    // portfolio item (an "offline project"), the source item. The file +
    // caption + extracted text live ON the portfolio item (single source of
    // truth — we reference, never copy), so content resolvers read through
    // this backlink. None of artifactId/fileStorageId/textContent is set in
    // that case. See portfolioMaterialize.ts.
    portfolioItemId: v.optional(v.id("portfolioItems")),
    submittedAt: v.number(),
    // "Check my work" is a repeatable formative checkpoint; "Send it" is the
    // no-rubric handoff. Keep the distinction even though legacy rows share the
    // submittedAt field.
    lastAction: v.optional(
      v.union(v.literal("check"), v.literal("send")),
    ),
    // Explicit teacher publication of one frozen digital-work revision. It
    // lives on the deliverable row rather than introducing a publication table.
    familyVisibility: v.optional(
      v.union(v.literal("staff_only"), v.literal("attributed_families")),
    ),
    familySnapshot: v.optional(
      v.union(
        v.object({
          kind: v.literal("text"),
          title: v.string(),
          content: v.string(),
          hasTutorTranscription: v.optional(v.boolean()),
        }),
        v.object({
          kind: v.literal("map"),
          title: v.string(),
          content: v.string(),
        }),
      ),
    ),
    familyPublishedAt: v.optional(v.number()),
    familyPublishedBy: v.optional(v.id("users")),
    // Rubric check result (flattened; partial states are natural here).
    rubricPassed: v.optional(v.boolean()),
    rubricFeedback: v.optional(v.string()),
    rubricCheckedAt: v.optional(v.number()),
    rubricCheckedBy: v.optional(
      v.union(v.literal("ai"), v.literal("teacher")),
    ),
    flairEarned: v.optional(
      v.array(
        v.object({
          criterionId: v.string(),
          earnedAt: v.number(),
          // The grader's one-sentence note about the submission that EARNED
          // this flair, snapshotted at award time. Scholar-facing: it is the
          // only readable explanation of a mark, because a criterion's
          // `description` is grader-facing rubric text and must never be shown
          // to a scholar. Snapshotted rather than read live off `verdicts`
          // because flair is permanent while verdicts are overwritten by the
          // next check — a later "half" would turn a celebration into a
          // deficit note. Absent on flair awarded before this field existed.
          note: v.optional(v.string()),
        }),
      ),
    ),
    // Per-criterion verdicts from the AI rubric check.
    verdicts: v.optional(
      v.array(
        v.object({
          criterionId: v.string(),
          level: v.union(
            v.literal("not"),
            v.literal("half"),
            v.literal("full"),
          ),
          note: v.optional(v.string()),
        }),
      ),
    ),
    overall: v.optional(
      v.union(v.literal("not"), v.literal("half"), v.literal("full")),
    ),
  })
    .index("by_scholar", ["scholarId"])
    .index("by_scholar_submittedAt", ["scholarId", "submittedAt"])
    .index("by_activity", ["activityId"])
    .index("by_session", ["sessionId"])
    .index("by_assignment_activity", ["assignmentId", "activityId"])
    .index("by_portfolioItem", ["portfolioItemId"]),

  // ─── Per-scholar angle on an activity (jigsaw, post-Quests) ───────
  //
  // When an activity has `hasScholarAngles: true`, the AI tutor's
  // kickoff phase asks the scholar to pick their own "angle" on the
  // shared prompt. Each scholar's angle is stored here; the tutor
  // context for subsequent turns injects this scholar's title +
  // description so their experience differentiates from peers.
  //
  // Replaces the old `scholarQuests.differentiation` mechanic.
  scholarActivityAngles: defineTable({
    scholarId: v.id("users"),
    activityId: v.id("activities"),
    title: v.string(),
    description: v.string(),
    setAt: v.number(),
    setBy: v.union(v.literal("scholar"), v.literal("teacher"), v.literal("ai")),
  })
    .index("by_scholar", ["scholarId"])
    .index("by_activity", ["activityId"])
    .index("by_scholar_activity", ["scholarId", "activityId"]),

  // ─── Earned unit badges ──────────────────────────────────────────
  //
  // When a scholar completes every activity in a unit that has a
  // `badgeOnCompletion`, they earn the badge — recorded here. One row
  // per (scholar, unit). Replaces the old quest-scoped badges.
  scholarUnitBadges: defineTable({
    scholarId: v.id("users"),
    // Optional typed source for badges that celebrate a non-unit achievement.
    // The durable Calculator License record remains in calculatorLicenses.
    kind: v.optional(v.literal("calculator_license")),
    // Optional: a badge is usually tied to a completed unit, but teachers can
    // also award a free-standing "custom" badge with no unit attached. When
    // absent, badgeSnapshot.title is the source of truth for its name.
    unitId: v.optional(v.id("units")),
    earnedAt: v.number(),
    // Snapshot of the badge config at the moment of earning so a
    // teacher editing the unit later doesn't retroactively change
    // what scholars earned.
    badgeSnapshot: v.object({
      title: v.string(),
      description: v.optional(v.string()),
      icon: v.optional(v.string()),
    }),
    // ─── Generative art layer (see convex/lib/badgeArt.ts) ──────────
    // The badge's artwork is generated async after it's earned (the
    // emoji `icon` above is the loading/fallback). `style` + `colorway`
    // are the scholar's preset customization choices; `rerollsUsed`
    // caps regeneration (anti-distraction, MAX_BADGE_REROLLS). All
    // optional so legacy rows + in-flight art degrade to the emoji.
    style: v.optional(v.union(v.literal("patch"), v.literal("medallion"))),
    colorway: v.optional(v.string()),
    imageStorageId: v.optional(v.id("_storage")),
    artStatus: v.optional(
      v.union(
        v.literal("generating"),
        v.literal("ready"),
        v.literal("failed"),
      ),
    ),
    rerollsUsed: v.optional(v.number()),
  })
    .index("by_scholar", ["scholarId"])
    .index("by_unit", ["unitId"])
    .index("by_scholar_unit", ["scholarId", "unitId"]),

  // ─── Generative manipulative theme icons (the charm layer) ────────
  //
  // A manipulative's `theme.fill.label` (a short noun — "pig", "rocket")
  // resolves to a generated, chroma-keyed, cached transparent PNG hosted
  // here. Generated once PER LABEL via the same Gemini→green-screen→key
  // pipeline as quest badges (convex/manipulativeThemeIconActions.ts),
  // then SHARED across every activity that uses that label — unlike a
  // badge, which is one asset per scholar-unit. `label` is the NORMALIZED
  // key (lib/manipulative/types.ts `normalizeThemeLabel`). Renderers read
  // it through the `useThemeIcon` hook (web + native) and fall back to the
  // plain shape while `pending`/`failed`/`hidden`. Governance: no external
  // URL ever enters — we mint every pixel; a constrained prompt (a single
  // friendly wordless object); `hidden` is the staff override. Mirrors the
  // scholarUnitBadges art columns.
  manipulativeThemeIcons: defineTable({
    // Normalized cache key (lowercase/trim/collapse) — unique per label.
    label: v.string(),
    // The label as first authored, for the staff/override UI.
    displayLabel: v.string(),
    // The exact generation prompt (audit + regenerate reproducibility).
    prompt: v.optional(v.string()),
    // Exact Gemini model that minted the current asset. Required for precise
    // regeneration after a quota fallback; absent on legacy rows.
    generationModel: v.optional(v.string()),
    imageStorageId: v.optional(v.id("_storage")),
    status: v.union(
      v.literal("pending"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    // Staff override: hide a specific label globally → renderers fall back
    // to the plain shape. Auto-live by default (unset/false), per the
    // "curator, not a per-item gate" model.
    hidden: v.optional(v.boolean()),
    // Who first triggered generation (a scholar render or a staffer).
    createdBy: v.optional(v.id("users")),
    createdAt: v.number(),
    regeneratedAt: v.optional(v.number()),
  }).index("by_label", ["label"]),

  // Generated Bold lineal-color art for earned rubric flair. Criteria may be
  // institution-authored or per-scholar AI output, so this cache is isolated
  // from the globally shared/listed manipulative icon cache.
  flairArt: defineTable({
    institutionId: v.id("institutions"),
    artKey: v.string(),
    sourceLabel: v.string(),
    sourceDescription: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    imageStorageId: v.optional(v.id("_storage")),
    prompt: v.optional(v.string()),
    generationModel: v.optional(v.string()),
    attemptCount: v.number(),
    lastAttemptAt: v.number(),
    failedAt: v.optional(v.number()),
    createdAt: v.number(),
    createdBy: v.optional(v.id("users")),
  })
    .index("by_institution_key", ["institutionId", "artKey"])
    .index("by_status", ["status"]),

  // ─── SELF-IMPROVING CURRICULA (Observation layer, design-facing) ──
  //
  // Substrate for "Auto-improve this activity": simulate a diverse cast
  // of synthetic scholars *playing through* an activity against the REAL
  // tutor (production buildSystemPrompt), judge the transcripts, and
  // (later phases) propose + hill-climb activity edits. It's a learning
  // record ABOUT the curriculum, not about a scholar. The portable loop
  // logic lives in evals/curriculum-sim/; these tables + the "use node"
  // actions are the product wrapper. See
  // review/self-improving-curricula-plan.md.

  // A reusable synthetic cast member — the behavioral knobs the
  // simulator roleplays (e.g. "gives up quickly when confused"), beyond
  // the one-off testDriveSynthetic* fields on `projects`. Owner-scoped so
  // a teacher curates their own cast library; never tied to a real kid.
  syntheticScholarProfiles: defineTable({
    ownerId: v.id("users"),
    name: v.string(),
    // e.g. "Grade 2", "Grade 5" — drives the tutor's READING LEVEL section.
    readingLevel: v.string(),
    // Synthetic dossier text; fed to the real tutor's buildDossierSection.
    // Teacher- or AI-authored — treat as untrusted, like a real dossier.
    dossier: v.string(),
    // Behavioral roleplay knobs; what makes the emergent conversation
    // diverge per kid.
    traits: v.array(v.string()),
    archetype: v.optional(v.string()),
    // Adoptable #5 — an optional scripted, documented arithmetic misconception
    // (one of the six Ashlock error patterns). When present, buildKidSystem
    // injects a faithful buggy-algorithm description + a persistence rule so the
    // sim kid keeps making the error until genuinely re-taught, letting a
    // rehearsal test whether an activity surfaces and repairs the errors real
    // scholars actually make. Absent for ordinary personas.
    misconception: v.optional(misconceptionValidator),
  }).index("by_owner", ["ownerId"]),

  // A tunable snapshot of an activity's prompt + rubric. The live
  // `activities` row stays the source of truth; candidates accumulate
  // here without touching it. `origin: "baseline"` captures the current
  // state at experiment start; promotion writes a winning variant back
  // via the normal teacher-gated activities.update. Lineage
  // (parentVariantId/generation) supports the Phase-3 hill-climb and
  // gives the repo the activity version history it lacks today.
  curriculumVariants: defineTable({
    activityId: v.id("activities"),
    experimentId: v.optional(v.id("curriculumExperiments")),
    parentVariantId: v.optional(v.id("curriculumVariants")),
    generation: v.number(),
    // The candidate activity systemPrompt under test (null = cleared).
    systemPrompt: v.optional(v.union(v.string(), v.null())),
    // Candidate deliverable rubric criteria (Phase 2+); omitted = unchanged.
    deliverableCriteria: v.optional(
      v.array(
        v.object({
          id: v.string(),
          label: v.string(),
          description: v.optional(v.string()),
        }),
      ),
    ),
    origin: v.union(
      v.literal("baseline"),
      v.literal("ai-proposed"),
      v.literal("teacher-edited"),
    ),
    // Why the Improver proposed this (Phase 2+); free text.
    rationale: v.optional(v.string()),
    // Judge aggregate across the cast for this variant (the `Aggregate`
    // shape from lib/curriculumScore). v.any() so a rubric-dim change
    // doesn't force a schema migration — the code enforces shape.
    aggregateScores: v.optional(v.any()),
    status: v.union(
      v.literal("candidate"),
      v.literal("promoted"),
      v.literal("rejected"),
    ),
  })
    .index("by_activity", ["activityId"])
    .index("by_experiment", ["experimentId"]),

  // One experiment a teacher kicked off. `progress` is the reactive doc
  // the UI subscribes to (no polling) — same pattern as the dashboard.
  curriculumExperiments: defineTable({
    activityId: v.id("activities"),
    teacherId: v.id("users"),
    // Phase ladder: analyze (report, no edits) → propose (one edit) →
    // loop (hill-climb). Phase 1 ships "analyze".
    mode: v.union(
      v.literal("analyze"),
      v.literal("propose"),
      v.literal("loop"),
    ),
    config: v.object({
      castProfileIds: v.array(v.id("syntheticScholarProfiles")),
      maxTurns: v.number(),
      // Plain-language objective the simulator works toward and the judge
      // scores against. Not an `activities` field — the success criterion
      // the loop optimizes for. Defaulted from the activity title +
      // deliverable at kickoff; teacher can override.
      learningGoal: v.string(),
      generations: v.optional(v.number()),
      variantsPerGen: v.optional(v.number()),
    }),
    status: v.union(
      v.literal("running"),
      v.literal("done"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    progress: v.object({
      sessionsDone: v.number(),
      sessionsTotal: v.number(),
      generation: v.optional(v.number()),
      message: v.optional(v.string()),
      // Live feed of the session currently being simulated — streamed
      // turn-by-turn so the running view shows the conversation building up
      // (spinner + name + transcript) instead of a lone status line. Cleared
      // by finalize once the run ends.
      liveScholarName: v.optional(v.string()),
      liveScholarReadingLevel: v.optional(v.string()),
      liveTranscript: v.optional(
        v.array(
          v.object({
            role: v.union(v.literal("tutor"), v.literal("scholar")),
            content: v.string(),
          }),
        ),
      ),
    }),
    baselineVariantId: v.optional(v.id("curriculumVariants")),
    bestVariantId: v.optional(v.id("curriculumVariants")),
    error: v.optional(v.string()),
    // LLM-synthesized "overall verdict" — the cast-level twin of each session's
    // judge summary, shown as the headline of the results. Generated from the
    // baseline cast once per run; absent if the synthesis call failed.
    overallVerdict: v.optional(v.string()),
    // Structured teacher-facing findings result — the recovered contract from
    // curriculumPreflightResult.ts (severity/target/evidence per finding, plus
    // the coverage envelope). Additive alongside overallVerdict: absent on
    // older records, and absent if the judged synthesis call itself failed
    // (deterministic findings + `analysisStatus` still land via the
    // fallback path, so a failed synthesis is never silently indistinguishable
    // from an experiment that predates this field).
    preflightResult: v.optional(preflightResultValidator),
    // Phase 4 — sim-to-real calibration (lib/curriculumGround.Calibration):
    // judges REAL transcripts for this activity with the same curriculum judge
    // and compares to the sim baseline. v.any() for the same reason as
    // aggregateScores — a rubric-dim change shouldn't force a migration.
    // Computed on demand (groundExperiment); absent until a teacher runs it.
    grounding: v.optional(v.any()),
    // Adoptable #3 — the pairwise promote-gate result for propose/loop runs:
    // per-cast head-to-head winners (baseline vs candidate, same kid, order
    // randomized), the net cast preference, and how the decision was reached
    // ("pairwise" or "absolute-fallback"). v.any() for the same
    // migration-avoidance reason as aggregateScores/grounding. Shape is
    // ExperimentPairwise in convex/lib/curriculumScore.ts. Absent for analyze
    // mode and for runs whose candidate never beat the baseline.
    pairwise: v.optional(v.any()),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  })
    .index("by_activity", ["activityId"])
    // Per-teacher status lookup — powers the global header's "background tasks
    // running" indicator (curriculumExperiments.listRunning), which needs the
    // caller's RUNNING experiments without scanning the whole table.
    .index("by_teacher_status", ["teacherId", "status"]),

  // Each synthetic transcript, linked to the variant it tested. The
  // emergent conversation + its judged verdict — the evidence the teacher
  // reads ("here's a kid who stalled here").
  simulatedSessions: defineTable({
    experimentId: v.id("curriculumExperiments"),
    variantId: v.id("curriculumVariants"),
    profileId: v.id("syntheticScholarProfiles"),
    transcript: v.array(
      v.object({
        role: v.union(v.literal("tutor"), v.literal("scholar")),
        content: v.string(),
      }),
    ),
    stopReason: v.union(
      v.literal("goal"),
      v.literal("stuck"),
      v.literal("maxTurns"),
    ),
    // SessionVerdict (judge output). v.any() for the same reason as
    // curriculumVariants.aggregateScores.
    verdict: v.optional(v.any()),
    goalReached: v.optional(v.boolean()),
    // OUTCOME PROBE (adoptable #1, review/sim-realism-lessons.html §5). A small
    // held-out set of verified practice items for the activity's target skills,
    // answered IN CHARACTER by the sim kid and graded DETERMINISTICALLY by the
    // practice verifier (NO judge). An isomorphic PRE-probe (before the session)
    // and POST-probe (after) let us report a sim pre→post delta, converting
    // goalAttainment from "sounded like understanding" into "could then answer
    // held-out items". Read as a DELTA BETWEEN VARIANTS over the same cast, never
    // as an absolute (a sim kid carries the too-capable bias). Mirrors the
    // practiceAttempts field shape. Present only when probe skills resolved.
    probe: v.optional(
      v.object({
        skills: v.array(v.string()), // the resolved target skillKeys probed
        itemsPerProbe: v.number(), // count of items in each of pre/post
        preScore: v.number(), // fraction correct on the PRE probe (0..1)
        postScore: v.number(), // fraction correct on the POST probe (0..1)
        delta: v.number(), // postScore - preScore
        items: v.array(
          v.object({
            skillKey: v.string(),
            stem: v.string(), // the POST item stem (isomorphic to the pre)
            preStem: v.string(), // the PRE item stem (same template, diff numbers)
            preCorrect: v.boolean(),
            postCorrect: v.boolean(),
          }),
        ),
      }),
    ),
    // Why a session carries no `probe` (no resolvable/templated target skills, or
    // a transient model error while answering) — the probe NEVER crashes a run.
    probeSkipReason: v.optional(v.string()),
  }).index("by_experiment", ["experimentId"]),

  // ── Judge ↔ teacher micro-validation (sim-realism adoptable #2) ──────
  // The judge scores REAL transcripts during grounding, but grounding only
  // KEEPS the aggregate (curriculumExperiments.grounding) and DISCARDS the
  // per-session verdicts — so the judge's ranking of individual real sessions
  // was never reproducible. This table persists one canonical judged verdict
  // per (activity, real session), refreshed by the latest grounding run, so a
  // teacher's pairwise picks (judgeComparisons) can be correlated against the
  // judge's fitness ranking. `verdict` is v.any() (a curriculumScore
  // SessionVerdict) for the same rubric-evolution reason as
  // curriculumVariants.aggregateScores; `fitness` is the mean of the fitness
  // dims — the judge's ranking signal — and `excerpt` is a truncated transcript
  // the validation UI shows side by side (so pairsForActivity stays cheap).
  groundedSessionVerdicts: defineTable({
    activityId: v.id("activities"),
    sessionId: v.id("sessions"),
    experimentId: v.id("curriculumExperiments"),
    scholarId: v.optional(v.id("users")),
    profileName: v.string(),
    readingLevel: v.string(),
    verdict: v.any(), // curriculumScore SessionVerdict
    fitness: v.number(), // mean of the fitness dims — the judge's ranking signal
    goalAttainment: v.number(),
    excerpt: v.string(), // truncated transcript for the side-by-side UI
    judgedAt: v.number(),
  })
    .index("by_activity", ["activityId"])
    .index("by_activity_session", ["activityId", "sessionId"])
    .index("by_experiment", ["experimentId"]),

  // A teacher's pairwise "which session went better for this kid?" judgment —
  // the human half of adoptable #2. `correlation` reads these against the
  // persisted judge verdicts (groundedSessionVerdicts) to compute an agreement
  // rate + an r-value telling us how much to trust the judge's scorecards.
  // One row per (teacher, activity, unordered session pair), upserted — the
  // last pick wins, in the A/B order the teacher last saw.
  judgeComparisons: defineTable({
    teacherId: v.id("users"),
    activityId: v.id("activities"),
    sessionAId: v.id("sessions"),
    sessionBId: v.id("sessions"),
    teacherChoice: v.union(
      v.literal("A"),
      v.literal("B"),
      v.literal("tie"),
    ),
    createdAt: v.number(),
  }).index("by_activity_teacher", ["activityId", "teacherId"]),

  // Durable coherence Review of a unit — the "Reviewed" rung of the
  // maturity rail (review/curriculum-rehearse-and-maturity.md). The
  // Review action (a Curriculum-Bot tool) writes one row per run; the
  // maturity query reads the latest. `openGapCount` = EQs/EUs that no
  // activity genuinely engages (the coverage gaps the Review surfaces);
  // 0 = coherent, which lights the rail's Reviewed lamp. Promotes the
  // old ephemeral "Review unit" chat message into a re-runnable artifact.
  unitReviews: defineTable({
    unitId: v.id("units"),
    reviewedBy: v.id("users"),
    reviewedAt: v.number(),
    openGapCount: v.number(),
    // Full coverage findings (EQ/EU × activity matrix + missing items).
    // v.any() so the Review rubric can evolve without a schema migration.
    summary: v.optional(v.any()),
  }).index("by_unit", ["unitId"]),

  // ── Debrief: Key Moments triage ──────────────────────────────────────
  // After a class has done an activity, the Debrief surfaces the most
  // interesting real-scholar moments (mastery breakthroughs, misconceptions,
  // strong signals, cross-domain insights — scored by lib/momentInterest).
  // A teacher keeps or dismisses each; this records that verdict so the
  // deck doesn't re-surface a triaged moment. The moment itself lives in
  // its source table (masteryObservations / sessionSignals /
  // crossDomainConnections) — we only store a reference + the verdict.
  momentTriage: defineTable({
    teacherId: v.id("users"),
    activityId: v.id("activities"), // scope (the activity being debriefed)
    source: v.union(
      v.literal("mastery"),
      v.literal("signal"),
      v.literal("connection"),
    ),
    sourceId: v.string(), // the source row's _id (stringified — cross-table)
    verdict: v.union(v.literal("kept"), v.literal("dismissed")),
    triagedAt: v.number(),
  })
    .index("by_activity_teacher", ["activityId", "teacherId"])
    // Look up one moment's verdict (idempotent re-triage).
    .index("by_source", ["activityId", "teacherId", "source", "sourceId"]),

  // ── Debrief: curriculum reflection ───────────────────────────────────
  // The teacher's "what worked / what didn't" on an activity after a real
  // run — the self-reflection half of Debrief. One per (activity, teacher),
  // upserted. Distinct from the team-facing sim scorecard.
  activityReflections: defineTable({
    activityId: v.id("activities"),
    teacherId: v.id("users"),
    content: v.string(),
    updatedAt: v.number(),
  }).index("by_activity_teacher", ["activityId", "teacherId"]),

  // ── Admin impersonation ("View as user") ────────────────────────────
  // A server-side "view-as" OVERLAY on the admin's OWN session (NOT a session
  // mint). One row per active episode, keyed to the admin's live authSession.
  // While active, getCurrentUser resolves as the target (read-only), so the
  // whole app runs as the target — no token, no client bind, no re-mint. Exit
  // just ends the row. See review/admin-impersonation-redesign-plan.html §6.
  impersonationOverlays: defineTable({
    adminUserId: v.id("users"), // the platform-admin doing the viewing
    adminSessionId: v.id("authSessions"), // their OWN live session (the anchor)
    targetUserId: v.id("users"), // whose data they're viewing (read-only)
    reason: v.optional(v.string()), // free-text support/verification note
    startedAt: v.number(),
    expiresAt: v.optional(v.number()), // hard TTL; inert past this (see impersonationConfig)
    endedAt: v.optional(v.number()),
    active: v.boolean(),
  })
    .index("by_admin_session", ["adminSessionId", "active"]) // identity resolution + gate + banner
    .index("by_admin", ["adminUserId"])
    .index("by_active", ["active"]), // sweep of stale/orphaned overlays

  // Durable, general-purpose admin audit trail. Impersonation is its first
  // writer; role changes / deletions can adopt it later. Shape mirrors the
  // per-domain `documentAccessLog` convention.
  auditLog: defineTable({
    actorUserId: v.id("users"), // who performed the action
    action: v.string(), // e.g. "impersonation.start" | "impersonation.stop"
    targetUserId: v.optional(v.id("users")),
    at: v.number(),
    detail: v.optional(v.string()), // reason / free-text
    // Optional forensics if the HTTP layer can supply them.
    ip: v.optional(v.string()),
    userAgent: v.optional(v.string()),
  })
    .index("by_actor", ["actorUserId"])
    .index("by_action", ["action"])
    .index("by_target", ["targetUserId"]),

  // ── INSTITUTION CASCADE-DELETE (audit + resumable job) ─────────────────
  // The most destructive operation in the product: deleting an entire
  // institution and everything scoped to it. This row is BOTH the durable
  // audit record AND the resumable job state, and it deliberately lives
  // OUTSIDE the institution being deleted so it survives the cascade — the
  // institution row, its staff, and (when a school_admin deletes their own
  // school) the requester themselves are all gone by the time `status` flips
  // to "completed", so nothing inside the tenant could hold this record.
  //
  // Resumability: a half-finished delete (crash, budget cutoff, redeploy) is
  // safe to re-run — each `deletionStep` re-queries live state, so re-running
  // from any phase converges. `phase`/`counts` make progress observable while
  // the internal action drives batched steps. `institutionId` is kept as a raw
  // (soon-dangling) id purely for the audit trail; the human-readable
  // name/slug + requester snapshot fields keep the record legible after every
  // referenced row is gone. See convex/institutionDeletion.ts.
  institutionDeletions: defineTable({
    institutionId: v.id("institutions"), // dangling once finalize deletes the row
    institutionName: v.string(), // snapshot — legible after deletion
    institutionSlug: v.string(),
    // Requester snapshot. `requestedByUserId` may itself be deleted (a
    // school_admin deleting their OWN school), so the string snapshots are the
    // authoritative audit identity.
    requestedByUserId: v.id("users"),
    requestedByName: v.optional(v.string()),
    requestedByUsername: v.optional(v.string()),
    requestedByRole: v.optional(v.string()),
    // The name the admin typed to confirm (re-verified server-side).
    typedName: v.string(),
    // True when the requester's own account is in the delete set.
    deletingSelf: v.boolean(),
    status: v.union(
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    phase: v.string(), // "users" | "sessions" | "units" | "institutionScoped" | "memberships" | "done"
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    // Running tally of deleted rows per table (merged across steps).
    counts: v.optional(v.record(v.string(), v.number())),
  })
    .index("by_institution", ["institutionId"])
    .index("by_status", ["status"]),
  // ═══════════════════════════════════════════════════════════════════════
  // NARRATIVE ASSESSMENT (PCM) & GOALS — review/assessment-and-goals-plan.html
  //
  // A reporting layer that READS the observation layer. Nothing here creates
  // evidence; the narrative period READS it. Guardrails baked in: rubric
  // numbers never reach the tutor or the scholar (goals are the only
  // scholar-facing artifact); ratings compare a child to descriptors, never
  // to classmates; the AI's rating suggestion is stored alongside the
  // teacher's (anti-anchoring) as the calibration dataset (§11).
  // ═══════════════════════════════════════════════════════════════════════

  // ── Reporting calendar (§13) ──────────────────────────────────────────
  // Beginning/Middle/End of the year. A "snapshot" is the binder rollup
  // evaluated at a frozen date range; growth-over-period is two snapshots
  // diffed. `narrativesDueAt` drives the composer's nudges.
  reportingPeriods: defineTable({
    label: v.string(), // "Fall 2026" · "Spring 2027"
    startsAt: v.number(),
    endsAt: v.number(),
    narrativesDueAt: v.optional(v.number()),
    status: v.union(
      v.literal("upcoming"),
      v.literal("open"),
      v.literal("writing"),
      v.literal("closed"),
    ),
    // Institution scoping — periods belong to a school. Optional for back-
    // compat / single-school dev.
    institutionId: v.optional(v.id("institutions")),
  }).index("by_status", ["status"]).index("by_institution", ["institutionId"]),

  // ── School closures (no-school days) ───────────────────────────────────
  // Date-specific NO-SCHOOL days for the Master Schedule: holidays, breaks,
  // and staff-development / faculty-in-service days, derived from the
  // institution academic calendar. Deliberately institution + DATE scoped, NOT
  // term-scoped: multi-day breaks (e.g. Winter Break) can fall BETWEEN two
  // reportingPeriods, so a term FK would have no home for them.
  //
  // The materializer (convex/masterSchedule.ts) skips any placement whose
  // (weekStartMs, weekday) resolves to a closed day — nothing goes live on a
  // holiday — and the grid / scholar / teacher "today" surfaces render a
  // "No School" state. There is NO editing UI yet: the source of truth is
  // seed data (convex/seed/schoolClosures.ts).
  //
  // Days are stored as institution-local "YYYY-MM-DD" keys (matching the
  // dayKeyForTimezone idiom used everywhere else), so a closure test is a pure
  // lexicographic string range compare — DST-safe, no offset math. `startDayKey`
  // == `endDayKey` for a single day; the range is inclusive on both ends.
  schoolClosures: defineTable({
    // Absent = applies to every institution (single-school dev / global). Set =
    // scoped to one school, mirroring reportingPeriods.institutionId.
    institutionId: v.optional(v.id("institutions")),
    startDayKey: v.string(), // "YYYY-MM-DD" institution-local, inclusive
    endDayKey: v.string(), // inclusive; == startDayKey for a single day
    label: v.string(), // "Winter Break" · "Statehood Day" · "Staff Development Day"
    // holiday  = no school for anyone.
    // staffOnly = no school for SCHOLARS; faculty in-service (e.g. the Day After
    //             Thanksgiving, the Jan-4 Faculty In-service). Both suppress
    //             scholar classes; the split is for labeling.
    kind: v.union(v.literal("holiday"), v.literal("staffOnly")),
  }).index("by_institution", ["institutionId"]),

  // ── Course narrative (§7) — one per scholar × period × subject ────────
  // Sections stored as a keyed list (NOT fixed columns) so the "simplify?"
  // decision is config, not migration. Numbers are a staff instrument.
  courseNarratives: defineTable({
    scholarId: v.id("users"),
    teacherId: v.id("users"),
    periodId: v.id("reportingPeriods"),
    subject: v.string(), // "Mathematics" · "Science" · "Humanities"
    unitIds: v.array(v.id("units")), // what actually ran this period
    // context · progress · perDimension… · goals — each { key, title, body }.
    sections: v.array(
      v.object({ key: v.string(), title: v.string(), body: v.string(), done: v.optional(v.boolean()) }),
    ),
    // 1–7 per PCM dimension + an overall Course Performance Rating.
    pcmRatings: v.optional(
      v.object({
        core: v.optional(v.number()),
        connections: v.optional(v.number()),
        practice: v.optional(v.number()),
        identity: v.optional(v.number()),
      }),
    ),
    courseRating: v.optional(v.number()), // 1–7 overall
    // DEPRECATED (2026-07-02): the AI rating suggestion / anti-anchoring reveal
    // was removed — assessment is teacher-authored; AI help now lives in the
    // curriculum bot (read/write-report tools), not baked-in draft/check.
    // Fields kept optional so pre-existing rows still validate; no new writer.
    aiSuggested: v.optional(
      v.object({
        pcmRatings: v.optional(
          v.object({
            core: v.optional(v.number()),
            connections: v.optional(v.number()),
            practice: v.optional(v.number()),
            identity: v.optional(v.number()),
          }),
        ),
        courseRating: v.optional(v.number()),
        rationale: v.string(),
        model: v.optional(v.string()),
      }),
    ),
    ratingsCommittedAt: v.optional(v.number()), // DEPRECATED (see aiSuggested)
    // Simple team signoff (collaboration): each staffer who has reviewed/agreed.
    signoffs: v.optional(
      v.array(v.object({ userId: v.id("users"), at: v.number() })),
    ),
    // Per-domain Working Level vector (§10), snapshotted at composer time.
    workingLevel: v.optional(
      v.object({
        headline: v.optional(v.string()),
        byDomain: v.array(
          v.object({
            domain: v.string(),
            level: v.string(),
            source: v.string(),
          }),
        ),
      }),
    ),
    goalIds: v.array(v.id("scholarGoals")), // accepted Goals for Continued Growth
    status: v.union(
      v.literal("draft"),
      v.literal("final"),
      v.literal("shared"),
    ),
    sharedAt: v.optional(v.number()),
    // The shared narrative also lands as a scholarDocuments row so it enters
    // the redaction pipeline + document history (§5).
    documentId: v.optional(v.id("scholarDocuments")),
  })
    .index("by_scholar", ["scholarId"])
    .index("by_scholar_period", ["scholarId", "periodId"])
    .index("by_period", ["periodId"])
    .index("by_teacher_period", ["teacherId", "periodId"]),

  // ── Whole Child Narrative (§8) — one per scholar, team-sourced ────────
  // The morning-circle advisor owns the final text; `teamAgreedAt` is
  // stamped from meeting mode. Sections are keyed like courseNarratives.
  wholeChildNarratives: defineTable({
    scholarId: v.id("users"),
    periodId: v.id("reportingPeriods"),
    advisorId: v.id("users"),
    sections: v.array(
      v.object({ key: v.string(), title: v.string(), body: v.string(), done: v.optional(v.boolean()) }),
    ),
    teamAgreedAt: v.optional(v.number()),
    goalIds: v.array(v.id("scholarGoals")),
    status: v.union(
      v.literal("draft"),
      v.literal("teamReview"),
      v.literal("final"),
      v.literal("shared"),
    ),
    sharedAt: v.optional(v.number()),
    documentId: v.optional(v.id("scholarDocuments")),
  })
    .index("by_scholar", ["scholarId"])
    .index("by_scholar_period", ["scholarId", "periodId"])
    .index("by_period", ["periodId"]),

  // ── Weekly SEL synthesis — stable teacher-facing Rounds read model ─────
  // One derived strengths-first artifact per scholar/week. It covers existing
  // learner-character and watch evidence that academic Rounds does not, while
  // staying entirely outside the tutor context; only hand-authored guidance may
  // cross that boundary.
  selSyntheses: defineTable({
    scholarId: v.id("users"),
    institutionId: v.id("institutions"),
    weekKey: v.string(),
    strengths: v.array(
      v.object({
        text: v.string(),
        cites: v.array(
          v.object({
            kind: v.union(
              v.literal("sessionSignal"),
              v.literal("analysis"),
              v.literal("alert"),
              v.literal("observation"),
            ),
            id: v.string(),
            label: v.string(),
            at: v.number(),
          }),
        ),
      }),
    ),
    watch: v.array(
      v.object({
        text: v.string(),
        cites: v.array(
          v.object({
            kind: v.union(
              v.literal("sessionSignal"),
              v.literal("analysis"),
              v.literal("alert"),
              v.literal("observation"),
            ),
            id: v.string(),
            label: v.string(),
            at: v.number(),
          }),
        ),
      }),
    ),
    quiet: v.boolean(),
    window: v.object({ startMs: v.number(), endMs: v.number() }),
    model: v.string(),
    promptVersion: v.string(),
    generatedAt: v.number(),
  })
    .index("by_scholar_week", ["scholarId", "weekKey"])
    .index("by_institution_week", ["institutionId", "weekKey"]),

  // ── Goals — the long-term primitive (§9) ──────────────────────────────
  // Longer-lived than a quest; the thread the year hangs on. Governed
  // authorship: teacher/scholar-authored (never model), schema'd + reviewable,
  // deterministically injected into the tutor prompt, kid-safe by construction.
  scholarGoals: defineTable({
    scholarId: v.id("users"),
    title: v.string(),
    description: v.optional(v.string()),
    kind: v.union(
      v.literal("academic"),
      v.literal("personal"),
      v.literal("habit"),
      v.literal("hobby"),
    ),
    origin: v.union(
      v.literal("goalWeek"),
      v.literal("narrative"),
      v.literal("scholar"),
      v.literal("teacher"),
    ),
    createdBy: v.id("users"), // scholar-proposed goals await teacher approval
    status: v.union(
      v.literal("proposed"),
      v.literal("active"),
      v.literal("achieved"),
      v.literal("retired"),
    ),
    // Default true once active — injected as a deterministic prompt section.
    feedsTutor: v.boolean(),
    targetPeriodId: v.optional(v.id("reportingPeriods")),
  })
    .index("by_scholar", ["scholarId"])
    .index("by_scholar_status", ["scholarId", "status"]),

  // ── Goal check-ins (§9) — a moment recorded against a goal ────────────
  // Scholar self-reports ("I finally built the solar oven"), teacher notes,
  // and observer-noticed progress. The child's own sense of achievement is
  // Identity-dimension evidence.
  goalCheckins: defineTable({
    goalId: v.id("scholarGoals"),
    scholarId: v.id("users"),
    authorType: v.union(
      v.literal("scholar"),
      v.literal("teacher"),
      v.literal("observer"),
    ),
    authorId: v.optional(v.id("users")),
    note: v.string(),
    sessionId: v.optional(v.id("sessions")),
  })
    .index("by_goal", ["goalId"])
    .index("by_scholar", ["scholarId"]),

  // ── Weekly goals — the learner-owned SRL loop ─────────────────────────
  // OBSERVATION layer. A small, visible weekly commitment the SCHOLAR sets
  // (or a teacher suggests) — Zimmerman's forethought → performance →
  // reflection loop: `strategy` is the kid's named approach (forethought),
  // `reflection` + met/not_yet is their end-of-week self-report (reflection).
  // Governed authorship: scholar/teacher-authored (never model), schema'd +
  // reviewable, deterministically injected into the tutor prompt
  // (buildWeeklyGoalsSection). "met"/"not_yet" is the kid's + teacher's own
  // judgment — NEVER auto-graded, and NEVER comparative (a goal is
  // learner↔concept, never learner↔learner). Private to scholar + staff.
  //
  // DISTINCT from `scholarGoals` (the long-term, year-spanning goals
  // primitive): this is the WEEKLY cadence keyed to a Monday. See
  // DRAFT-NOTES.md — the two goal concepts may want unifying in review.
  weeklyGoals: defineTable({
    scholarId: v.id("users"),
    text: v.string(),
    // The kid's named approach — "how will you try?" (SRL forethought).
    strategy: v.optional(v.string()),
    // ISO date (YYYY-MM-DD) of the Monday that anchors the goal's week (HST).
    weekOf: v.string(),
    // A scholar-set goal is `active` the moment it's set (scholar owns it —
    // no approval gate). `proposed` is only a teacher SUGGESTION awaiting the
    // scholar's acceptance. A teacher may `archive` (veto/close) any goal.
    status: v.union(
      v.literal("proposed"),
      v.literal("active"),
      v.literal("met"),
      v.literal("not_yet"),
      v.literal("archived"),
    ),
    // Who authored it. A scholar-set goal is `active` at once; a teacher-suggested
    // goal starts `proposed` so the SCHOLAR accepts it → active (agency is the
    // point).
    source: v.union(v.literal("scholar"), v.literal("teacher")),
    teacherNote: v.optional(v.string()),
    // The scholar's own end-of-week words (self-reported, never a verdict).
    reflection: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
    // When the goal became `active`. A scholar-set goal owns itself end-to-end,
    // so it's stamped at creation (no approval gate); a teacher-suggested goal is
    // stamped when the scholar accepts. Anchors the practice-movement window on
    // the goal card.
    activatedAt: v.optional(v.number()),
  })
    .index("by_scholar", ["scholarId"])
    .index("by_scholar_week", ["scholarId", "weekOf"]),

  // ── SCHOLAR HEALTH RECORDS (family onboarding) ───────────────────────
  // One canonical signed record per scholar. Guardian-specific drafts live in
  // scholarHealthRecordDrafts so partial edits never mutate the last signed
  // snapshot or leak between guardians.
  scholarHealthRecords: defineTable({
    scholarId: v.id("users"),
    guardianId: v.id("users"),
    // Includes deprecated compatibility fields for the standalone annual-program
    // and cooking-waiver forms; do not remove until their backfill is verified.
    ...healthRecordSchemaFields,
    signerUserId: v.id("users"),
    signedAt: v.number(),
    submittedAt: v.number(),
    standardProgramAcknowledgedAt: v.optional(v.number()),
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    confirmationEmailSent: v.optional(v.boolean()),
  }).index("by_scholar", ["scholarId"]),

  scholarHealthRecordDrafts: defineTable({
    scholarId: v.id("users"),
    guardianId: v.id("users"),
    ...healthRecordSchemaFields,
    baseRevision: v.number(),
    version: v.number(),
    // Version 2 is the medical-only 11-step wizard. Older drafts have no
    // marker, allowing the one-time form extraction to interpret old step 10
    // without coupling future standalone forms to health-wizard numbering.
    wizardVersion: v.optional(v.number()),
    currentStep: v.number(),
    lastCompletedStep: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_scholar", ["scholarId"])
    .index("by_guardian", ["guardianId"])
    .index("by_scholar_and_guardian", ["scholarId", "guardianId"]),

  // Typed standalone legal/participation forms. One signed canonical response
  // per scholar + form; each guardian owns an independent draft.
  guardianFormSubmissions: defineTable({
    scholarId: v.id("users"),
    guardianId: v.id("users"),
    signerUserId: v.id("users"),
    formId: guardianFormIdValidator,
    formVersion: v.number(),
    answers: guardianFormAnswersValidator,
    signerName: v.string(),
    signedAt: v.number(),
    submittedAt: v.number(),
    revision: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_scholar_form", ["scholarId", "formId"])
    .index("by_scholar_form_guardian", ["scholarId", "formId", "guardianId"])
    .index("by_form", ["formId"]),

  guardianFormDrafts: defineTable({
    scholarId: v.id("users"),
    guardianId: v.id("users"),
    formId: guardianFormIdValidator,
    formVersion: v.number(),
    answers: guardianFormAnswersValidator,
    baseRevision: v.number(),
    version: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_scholar_form_guardian", ["scholarId", "formId", "guardianId"])
    .index("by_scholar_form", ["scholarId", "formId"])
    .index("by_form", ["formId"]),

  // Delivery ledger for staff-initiated form reminders. One row records the
  // latest queued reminder for a guardian, scholar, and logical form.
  formReminderReceipts: defineTable({
    guardianId: v.id("users"),
    scholarId: v.id("users"),
    formId: v.string(),
    requestedBy: v.id("users"),
    lastRemindedAt: v.number(),
  })
    .index("by_guardian_scholar_form", ["guardianId", "scholarId", "formId"])
    .index("by_scholar_form", ["scholarId", "formId"]),

  // Guardian-bound uploads stay private until their file id is included in a
  // signed scholar record. Staff downloads only resolve canonical references.
  healthRecordFiles: defineTable({
    scholarId: v.id("users"),
    uploadedBy: v.id("users"),
    kind: v.union(
      v.literal("medication_authorization"),
      v.literal("immunization_record"),
      v.literal("custody_document"),
      // The legacy single action-plan slot — still serves seizure / diabetes /
      // behavioral-health / other via the record's `actionPlanDocumentId`.
      v.literal("action_plan_document"),
      // Condition-keyed action plans. A scholar with BOTH a food-allergy EAP
      // and an asthma EAP needs two distinct signed plans at once, which the
      // single generic slot above cannot hold. Keyed by the `hap.*` flag they
      // hang off (`actionPlanDocumentIds.allergy` / `.asthma`).
      v.literal("action_plan_document_allergy"),
      v.literal("action_plan_document_asthma"),
      v.literal("support_plan_document"),
      // A physician's return-to-activity clearance. UNLIKE every other kind
      // above, it is NOT a slot on the signed annual record — it is attached to
      // a `medicalClearanceRequests` row (event-triggered, can recur). A file of
      // this kind is kept alive by that request's `documentId` pointer, which
      // `healthDocumentIsReferenced` consults so the 24h unreferenced-file sweep
      // does not delete it.
      v.literal("medical_clearance_document"),
      // The physician-completed physical exam form. Like clearance — and unlike
      // every typed slot above — it is NOT a slot on the signed annual record:
      // it is a standalone guardian-uploaded document that sits beside the
      // "Annual program participation" and Cooking Lab waiver items on the
      // parent Forms list. There is no attach step and no owning row; the
      // FINALIZED file IS the record, and "current physical" is simply the
      // newest finalized row for the scholar (earlier ones are kept as
      // history). `healthDocumentIsReferenced` treats a finalized row of this
      // kind as referenced so the 24h unreferenced-file sweep leaves it alone.
      v.literal("physical_exam_document"),
    ),
    storageId: v.optional(v.id("_storage")),
    fileName: v.optional(v.string()),
    contentType: v.optional(
      v.union(
        v.literal("application/pdf"),
        v.literal("image/jpeg"),
        v.literal("image/png"),
      ),
    ),
    size: v.optional(v.number()),
    sha256: v.optional(v.string()),
    createdAt: v.number(),
    finalizedAt: v.optional(v.number()),
    // True when the file arrived through the STAFF upload path (an operations staffer /
    // teacher / admin filing a paper copy handed in at the front desk) rather
    // than the parent's Medical & Emergency form. Records the PATH, not the
    // uploader's role, on purpose: a teacher who is also a guardian uploads
    // through the parent form, and that document IS parent-attested. Absent on
    // every parent upload (and on every row predating this field).
    uploadedByStaff: v.optional(v.boolean()),
    // ── Staff review state, on the DOCUMENT itself (never a parallel table) ──
    // Absent while a document is on file but not yet triaged — that "pending
    // review" state is DERIVED (a finalized file with no `reviewStatus`), not
    // stored. Set by `scholarHealthRecords.setHealthDocumentReviewStatus`
    // (scholar_admin only). "needs_replacement" is a soft flag surfaced to the
    // family through the Forms dashboard — it does not delete or unlink the
    // file.
    reviewStatus: v.optional(
      v.union(v.literal("accepted"), v.literal("needs_replacement")),
    ),
    reviewedBy: v.optional(v.id("users")),
    reviewedAt: v.optional(v.number()),
    reviewNote: v.optional(v.string()),
    // Per-medication expiry, staff-transcribed from the physician-signed
    // Medication Authorization (a single PDF-level date can't represent a
    // two-medication authorization where only one has lapsed). Anchored to the
    // FILE staff is reading from — never the parent-signed `medications[]`
    // snapshot, which the guardian owns and re-signs. Only meaningful on
    // `medication_authorization` rows.
    medicationExpirations: v.optional(
      v.array(
        v.object({
          name: v.string(),
          expiresAt: v.number(),
        }),
      ),
    ),
  })
    .index("by_scholar", ["scholarId"])
    .index("by_uploader", ["uploadedBy"])
    .index("by_storage", ["storageId"]),

  // ── Slice C: medical-clearance requests ────────────────────────────────
  // A physician's return-to-activity clearance is EVENT-TRIGGERED (a scholar
  // returns from an injury, a communicable illness, a procedure) and can recur
  // several times a year. Nothing in the signed annual health record can say
  // "clearance is currently required" the way `hap.asthma` implies an EAP — so
  // clearance is modeled as an explicit requested-instance lifecycle rather
  // than a declarative slot. Staff open a request; the family (or front desk)
  // attaches the physician document; staff review it on the same drawer that
  // hosts the annual physician forms. A request supersedes any earlier open one
  // for the same scholar, so at most one clearance is "in flight" at a time.
  medicalClearanceRequests: defineTable({
    scholarId: v.id("users"),
    // Snapshotted from the scholar at request time so institution-scoped reads
    // and alerts don't re-resolve it (mirrors how alerts/dashboard scope).
    institutionId: v.optional(v.id("institutions")),
    requestedBy: v.id("users"),
    requestedAt: v.number(),
    // Why staff asked for it (e.g. "Return from concussion"). Shown to the
    // family so they know which physician note to bring.
    reason: v.string(),
    // Lifecycle:
    //   open              — requested; awaiting a document.
    //   pending_review    — a document is attached; awaiting staff review.
    //   needs_replacement — staff reviewed and asked for a new document.
    //   cleared           — staff accepted; the scholar is cleared (resolved).
    //   cancelled         — staff withdrew the request (resolved).
    //   superseded        — replaced by a newer request for the same scholar.
    status: v.union(
      v.literal("open"),
      v.literal("pending_review"),
      v.literal("needs_replacement"),
      v.literal("cleared"),
      v.literal("cancelled"),
      v.literal("superseded"),
    ),
    // The attached physician document (a `healthRecordFiles` row of kind
    // `medical_clearance_document`). This pointer is what keeps that file alive
    // past the 24h unreferenced-upload sweep.
    documentId: v.optional(v.id("healthRecordFiles")),
    reviewNote: v.optional(v.string()),
    reviewedBy: v.optional(v.id("users")),
    reviewedAt: v.optional(v.number()),
    // Set when the request leaves an active state (cleared / cancelled /
    // superseded).
    resolvedAt: v.optional(v.number()),
    supersededBy: v.optional(v.id("medicalClearanceRequests")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_scholar", ["scholarId"])
    .index("by_scholar_status", ["scholarId", "status"])
    .index("by_status", ["status"])
    .index("by_institution", ["institutionId"]),

  // ═══════════════════════════════════════════════════════════════════════
  // ROOM LAYER — the teacher's voice reaching the room's screens. One
  // primitive, three kinds, meant to be ridden by later moves (a hand-raise
  // channel, a "gather" call, …) rather than re-invented per feature.
  // ═══════════════════════════════════════════════════════════════════════

  // A single teacher-authored cue broadcast to every scholar screen in
  // scope, live via Convex reactivity (no polling, no push infra). Three
  // kinds, one shape:
  //   "message"    — a short spoken note, shown verbatim ("Clean up in two
  //                  minutes — then we're on the rug.").
  //   "transition" — same shape as message; a distinct kind only so the
  //                  scholar-facing banner can read the moment correctly
  //                  ("we're moving on") without the teacher's words having
  //                  to spell that out every time.
  //   "rest"       — "screens down": a full-screen calm overlay on every
  //                  in-scope scholar surface. NOT a countdown or lockout —
  //                  it is a room STATE the teacher calls and clears by hand
  //                  (`clearedAt`/`clearedBy`), and it must never destroy or
  //                  interrupt in-flight work (the session underneath is
  //                  untouched; the overlay just sits on top until cleared).
  // Scope is (institutionId, groupId): `groupId` absent = every scholar in
  // the institution ("the whole room"); present = just that pod. A scholar
  // is in scope when BOTH their `users.institutionId` matches AND (groupId
  // is absent OR they're a member of that `scholarGroups` row) — resolved by
  // `roomCues.activeRoomCuesForSelf`, which is deliberately the ONLY read
  // surface scholars get: it returns just {kind, body, returnAt,
  // authorName} — never `authorId`, `institutionId`, or `groupId`, so a
  // scholar can never learn who else is in scope or how the room is
  // organized from a cue alone.
  //
  // Cues are dismissible + low-frequency BY DESIGN: no repeat/nag machinery,
  // no read receipts, no schedules. `message`/`transition` auto-expire
  // (`expiresAt`, defaulted ~5 min server-side in `callRoomCue` when the
  // teacher doesn't set one) so a forgotten banner doesn't linger for a kid
  // who was away from the screen; `rest` has no default expiry — it holds
  // until the teacher explicitly clears it (or calls a new `rest`, which
  // auto-clears the prior live one for the same scope — only one live rest
  // cue per scope at a time).
  roomCues: defineTable({
    institutionId: v.id("institutions"),
    // Absent = the whole institution ("the room"); present = one pod.
    groupId: v.optional(v.id("scholarGroups")),
    authorId: v.id("users"), // the teacher who called it — staff-only, never returned to scholars
    kind: v.union(
      v.literal("message"),
      v.literal("transition"),
      v.literal("rest"),
    ),
    // The teacher's words, VERBATIM — never AI-generated cheer. Required for
    // message/transition; absent for rest (rest's copy is fixed chrome —
    // "🌙 Screens resting" — not authored per-call).
    body: v.optional(v.string()),
    // "back at 1:15" — a rest-only wall-clock hint (epoch ms), never a
    // client-side countdown. Absent = no stated return time.
    returnAt: v.optional(v.number()),
    createdAt: v.number(),
    // message/transition: auto-expire (defaulted in callRoomCue). rest:
    // normally absent — cleared explicitly instead.
    expiresAt: v.optional(v.number()),
    // Set only when a teacher explicitly clears (or a new rest cue
    // auto-clears the prior live one for the same scope). Absent = still live
    // (subject to `expiresAt`, if any).
    clearedAt: v.optional(v.number()),
    clearedBy: v.optional(v.id("users")),
  })
    .index("by_institution", ["institutionId", "createdAt"])
    .index("by_group", ["groupId", "createdAt"]),


  // One row per person who asked for an invite on the public /waitlist form.
  // Written by an UNAUTHENTICATED mutation (that's the point — these people
  // have no account), read only by platform admins. Deliberately platform-
  // level, not institution-scoped: the request is to get onto Rabbithole at
  // all, so there is no tenant to resolve from and none to guess.
  //
  // Contains no scholar data — only what the requester typed about themselves.
  // Re-submitting the same address UPDATES the row (see waitlist.submit), so
  // one address is one row no matter how many times someone hits send.
  waitlist: defineTable({
    email: v.string(), // normalized (trimmed + lowercased) — the identity here
    school: v.string(), // free text: their current school
    role: v.union(
      v.literal("teacher"),
      v.literal("ed_tech"),
      v.literal("administrator"),
      v.literal("parent"),
      v.literal("student"),
    ),
    interest: v.optional(v.string()), // "what would you do with Rabbithole"
    // _creationTime is the FIRST ask; this is the most recent one, so a
    // re-submission still sorts to the top of the admin list.
    lastSubmittedAt: v.number(),
    // Receipt that the notification email actually left Resend, so a silent
    // send failure is visible in the admin table rather than invisible.
    notifiedAt: v.optional(v.number()),
  }).index("by_email", ["email"]),

  // ── STUDIO (the 4-session creative-coding elective) ───────────────────
  // One row per (scholar, level): the scholar's saved source for that level,
  // PLUS the best verdict any run has ever produced for it. See
  // shared/studioContract.ts for the full contract (StudioLevel,
  // StudioRunResult, the generous fixer, ...).
  //
  // `levelId` is a plain string, NOT `v.id(...)` — deliberately. A level is
  // CODE (`shared/studioLevels.ts`), not a database row: its `make()` ROLLS a
  // fresh world every time (a new hallway, new treasure placement, ...), and a
  // table row can't roll dice. There is nothing to foreign-key to; `levelId`
  // is just the ladder's stable id string, matched against a level's `id` in
  // code.
  //
  // Saved source and progress share ONE row rather than two tables: both are
  // keyed by exactly (scholarId, levelId), both are read together (restore the
  // editor AND show whether it's cleared), and a second `studioProgress` table
  // would only duplicate that same key + index for no independent lifecycle
  // (see .claude/rules/necessity-bar.md). `solved` is STICKY — once a run
  // wins, a later non-winning run (a scholar tinkering after clearing a level)
  // never un-solves it. `bestSteps` is the fewest robot steps any winning run
  // has taken, so a teacher can see not just who cleared a level but how
  // cleanly.
  studioPrograms: defineTable({
    scholarId: v.id("users"),
    levelId: v.string(),
    source: v.string(),
    updatedAt: v.number(),
    solved: v.boolean(),
    bestSteps: v.optional(v.number()),
  })
    .index("by_scholar_level", ["scholarId", "levelId"])
    .index("by_scholar", ["scholarId"]),
});
