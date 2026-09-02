import { v, type Infer } from "convex/values";
import { PROTECTED_DIMS } from "./curriculumDimensions";

/**
 * The protected dimensions a run must have evaluated to be certifiable.
 *
 * Its own export because callers read it as "what the CURRENT contract
 * requires", which is a different question from "what the scoring gate
 * protects" even when the two answers coincide today.
 */
export const CURRENT_PREFLIGHT_PROTECTED_DIMS = PROTECTED_DIMS;

export const preflightFindingProvenanceValidator = v.union(
  v.literal("deterministic"),
  v.literal("judged"),
);

export const preflightFindingStatusValidator = v.union(
  v.literal("needs-action"),
  v.literal("not-observed"),
);

export const preflightTargetSurfaceValidator = v.union(
  v.literal("activity-resources"),
  v.literal("activity-tutor-prompt"),
  v.literal("activity-deliverable"),
  v.literal("activity-duration"),
  v.literal("rehearse"),
);

const contextCoverageValidator = v.union(
  v.literal("included"),
  v.literal("omitted"),
  v.literal("withheld"),
);

export const preflightResultValidator = v.object({
  version: v.literal(1),
  backendCommit: v.optional(v.string()),
  analysisStatus: v.optional(
    v.union(
      v.literal("complete"),
      v.literal("failed"),
      v.literal("unavailable"),
      v.literal("error"),
    ),
  ),
  summary: v.string(),
  findings: v.array(
    v.object({
      id: v.string(),
      provenance: preflightFindingProvenanceValidator,
      status: preflightFindingStatusValidator,
      owningLayer: v.union(
        v.literal("activity"),
        v.literal("tutor"),
        v.literal("runtime"),
      ),
      severity: v.union(
        v.literal("critical"),
        v.literal("high"),
        v.literal("medium"),
        v.literal("low"),
      ),
      title: v.string(),
      evidence: v.array(v.string()),
      evidencePointer: v.string(),
      targetSurface: preflightTargetSurfaceValidator,
      suggestedAction: v.string(),
      contextDependencies: v.optional(
        v.array(
          v.union(
            v.literal("unit"),
            v.literal("lesson"),
            v.literal("resources"),
            v.literal("deliverableScoring"),
            v.literal("completion"),
          ),
        ),
      ),
    }),
  ),
  runObservedInventory: v.optional(
    v.array(
      v.object({
        id: v.string(),
        provenance: v.literal("judged"),
        title: v.string(),
        evidence: v.array(v.string()),
      }),
    ),
  ),
  coverage: v.object({
    cast: v.object({
      expected: v.number(),
      completed: v.number(),
      failed: v.number(),
      stopReasons: v.object({
        goal: v.number(),
        stuck: v.number(),
        maxTurns: v.number(),
      }),
    }),
    probes: v.object({
      completed: v.number(),
      skipped: v.number(),
    }),
    turns: v.optional(
      v.object({
        allowed: v.number(),
        perSim: v.array(
          v.object({
            profileName: v.string(),
            used: v.number(),
            stopReason: v.union(
              v.literal("goal"),
              v.literal("stuck"),
              v.literal("maxTurns"),
            ),
          }),
        ),
      }),
    ),
    correctness: v.optional(
      v.union(v.literal("checked"), v.literal("not-checked")),
    ),
    protectedFloorBreaches: v.optional(
      v.array(
        v.object({
          profileName: v.string(),
          dimension: v.string(),
          value: v.number(),
          floor: v.number(),
        }),
      ),
    ),
    uncheckedProtectedDims: v.optional(v.array(v.string())),
    context: v.object({
      unit: contextCoverageValidator,
      lesson: contextCoverageValidator,
      resources: contextCoverageValidator,
      deliverable: v.optional(contextCoverageValidator),
      deliverableScoring: v.optional(contextCoverageValidator),
      completion: contextCoverageValidator,
    }),
  }),
});

export type PreflightResult = Infer<typeof preflightResultValidator>;
export type PreflightCoverage = PreflightResult["coverage"];
export type PreflightTargetSurface =
  PreflightResult["findings"][number]["targetSurface"];

/**
 * Normalize a candidate git SHA into a stamp-safe string. Used to record
 * which backend build produced a synthesis — pure ops provenance, not
 * rendered anywhere today.
 */
export function normalizeBackendCommit(value: unknown): string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : "unavailable";
}

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const PREFLIGHT_SYNTHESIS_SYSTEM = `You are synthesizing the teacher-facing result of ONE
activity rehearsal for a Socratic AI tutor at a gifted elementary school.

Return a short summary and an ordered list of at most six concrete findings. Put the most
important fix first. Every finding must be supported by the supplied per-sim verdict evidence;
do not claim that an omitted context layer was tested.
If the evidence supports no concrete authored change, return an empty findings array. Never
manufacture advice merely to fill the list.
RANKING: correctness and source-access failures first; then repeated activity-owned pedagogy
failures; then narrower tutor-owned patterns. A run with any maxTurns stops may not receive an
unqualified success claim.
Each finding has exactly one owning layer and one target. Never bundle a content/resource repair
with a tutor-behavior or global-prompt change; emit separate findings when both are supported.

SEVERITY: critical = assigning the activity would make a false or unsafe claim; high = the
activity materially misleads the teacher or scholar; medium = a meaningful quality problem;
low = a small improvement. Do not inflate severity to make a longer list.

TARGET RULES:
- A source, handout, named list, quotation, or reference the scholar needs must target
  activity-resources. NEVER recommend copying scholar-required source material into the tutor
  prompt: the scholar cannot inspect private tutor instructions.
- Opening questions, scaffolding, sequencing, praise, labels, and tutor behavior target
  activity-tutor-prompt.
- Rubric, artifact, or transfer requirements target activity-deliverable.
- Time-fit findings target activity-duration.
- Reliability or coverage findings that call for another run target rehearse.

NEGATIVE CONTROLS — never recommend these:
- a global tutor rule that guesses prior curriculum or silently supplies a missing source;
- a blanket ban on focused questions;
- a broad anti-hallucination rule for an authored source-boundary mismatch;
- another global anti-offloading rule when the activity wording owns the failure;
- treating a polished artifact as proof every conversational uncertainty was resolved;
- asking a new question or task after the activity has completed;
- maximizing abstract complexity in the global tutor prompt;
- restating existing anti-telegraphing guidance more loudly without measured evidence.

Write evidence as short factual statements or brief excerpts. Do not display a new score,
severity, or confidence label. The caller adds judged provenance and stable ids.`;

export const PREFLIGHT_SYNTHESIS_TOOL = {
  name: "record_preflight_result" as const,
  description:
    "Record the prioritized teacher-facing summary and evidence-backed findings for one rehearsal.",
  input_schema: {
    type: "object" as const,
    required: ["summary", "findings"],
    properties: {
      summary: {
        type: "string" as const,
        description:
          "One or two sentences naming the load-bearing strength and the most important limitation.",
      },
      findings: {
        type: "array" as const,
        maxItems: 6,
        items: {
          type: "object" as const,
          required: [
            "title",
            "evidence",
            "evidencePointer",
            "owningLayer",
            "severity",
            "targetSurface",
            "suggestedAction",
            "contextDependencies",
          ],
          properties: {
            title: { type: "string" as const },
            evidence: {
              type: "array" as const,
              minItems: 1,
              maxItems: 3,
              items: { type: "string" as const },
            },
            evidencePointer: {
              type: "string" as const,
              description:
                "A compact pointer such as aggregate, opener:all, or verdict:Pip:promptAttribution.",
            },
            owningLayer: {
              type: "string" as const,
              enum: ["activity", "tutor"] as const,
            },
            severity: {
              type: "string" as const,
              enum: ["critical", "high", "medium", "low"] as const,
            },
            targetSurface: {
              type: "string" as const,
              enum: [
                "activity-resources",
                "activity-tutor-prompt",
                "activity-deliverable",
                "activity-duration",
                "rehearse",
              ] as const,
            },
            suggestedAction: { type: "string" as const },
            contextDependencies: {
              type: "array" as const,
              maxItems: 5,
              items: {
                type: "string" as const,
                enum: [
                  "unit",
                  "lesson",
                  "resources",
                  "deliverableScoring",
                  "completion",
                ] as const,
              },
              description:
                "Context layers this finding's evidence depends on. Use an empty array when it depends only on the activity prompt and observed transcript.",
            },
          },
        },
      },
      runObservedInventory: {
        type: "array" as const,
        maxItems: 3,
        items: {
          type: "object" as const,
          required: ["title", "evidence"],
          properties: {
            title: { type: "string" as const },
            evidence: {
              type: "array" as const,
              minItems: 1,
              maxItems: 5,
              items: { type: "string" as const },
            },
          },
        },
      },
    },
  },
};

const TARGETS = new Set<PreflightTargetSurface>([
  "activity-resources",
  "activity-tutor-prompt",
  "activity-deliverable",
  "activity-duration",
  "rehearse",
]);

export function preflightCoverage(
  expected: number,
  stopReasons: string[],
  context: PreflightCoverage["context"],
  probes: PreflightCoverage["probes"] = { completed: 0, skipped: 0 },
  turns: NonNullable<PreflightCoverage["turns"]> = {
    allowed: 0,
    perSim: [],
  },
  correctness: NonNullable<PreflightCoverage["correctness"]> = "not-checked",
  protectedFloorBreaches: NonNullable<
    PreflightCoverage["protectedFloorBreaches"]
  > = [],
  uncheckedProtectedDims?: string[],
): PreflightCoverage {
  const safeExpected = Math.max(0, Math.floor(expected));
  const safeCompleted = Math.min(safeExpected, stopReasons.length);
  const count = (reason: string) =>
    stopReasons.filter((candidate) => candidate === reason).length;
  return {
    cast: {
      expected: safeExpected,
      completed: safeCompleted,
      failed: safeExpected - safeCompleted,
      stopReasons: {
        goal: count("goal"),
        stuck: count("stuck"),
        maxTurns: count("maxTurns"),
      },
    },
    probes,
    turns,
    correctness,
    protectedFloorBreaches,
    ...(uncheckedProtectedDims !== undefined ? { uncheckedProtectedDims } : {}),
    context,
  };
}

export function fallbackPreflightResult(
  coverage: PreflightCoverage,
  deterministicFindings: PreflightResult["findings"] = [],
  reason: "unavailable" | "error" = "unavailable",
): PreflightResult {
  const analysisUnavailable: PreflightResult["findings"][number] = {
    id:
      reason === "error"
        ? "deterministic-judged-analysis-error"
        : "deterministic-judged-analysis-unavailable",
    provenance: "deterministic",
    status: "needs-action",
    owningLayer: "runtime",
    severity: "high",
    title:
      reason === "error"
        ? "Cross-sim synthesis failed — per-sim judgments below are intact"
        : "Cross-sim synthesis was unavailable — per-sim judgments below are intact",
    evidence: [
      reason === "error"
        ? "An internal error prevented source, correctness, and pedagogy recommendations from being computed."
        : "Source, correctness, and pedagogy recommendations were not computed for this run.",
    ],
    evidencePointer: "synthesis:unavailable",
    targetSurface: "rehearse",
    suggestedAction:
      "Read the per-sim scorecards and activity attributions below, then re-run before treating the activity as ready.",
  };
  return {
    version: 1,
    analysisStatus: reason,
    summary:
      "The rehearsal finished, but its recommendation summary could not be generated. The scorecards and transcripts are still available below.",
    findings: [analysisUnavailable, ...deterministicFindings],
    runObservedInventory: [],
    coverage,
  };
}

type RawFinding = {
  title?: unknown;
  evidence?: unknown;
  targetSurface?: unknown;
  suggestedAction?: unknown;
  evidencePointer?: unknown;
  owningLayer?: unknown;
  severity?: unknown;
  contextDependencies?: unknown;
};

type RawSynthesis = {
  summary?: unknown;
  findings?: unknown;
  runObservedInventory?: unknown;
};

export function normalizePreflightSynthesis(
  raw: RawSynthesis,
  coverage: PreflightCoverage,
  idFactory: () => string = () => crypto.randomUUID(),
): PreflightResult | null {
  const summary = cleanText(raw.summary);
  if (!summary || !Array.isArray(raw.findings)) return null;

  const findingCandidates = raw.findings.slice(0, 6);
  const findings = findingCandidates
    .map((candidate): PreflightResult["findings"][number] | null => {
      if (!candidate || typeof candidate !== "object") return null;
      const finding = candidate as RawFinding;
      const title = cleanText(finding.title);
      const suggestedAction = cleanText(finding.suggestedAction);
      const evidencePointer = cleanText(finding.evidencePointer);
      const owningLayer = finding.owningLayer;
      const severity = finding.severity;
      const target = finding.targetSurface;
      const contextDependencies = Array.isArray(finding.contextDependencies)
        ? finding.contextDependencies.filter(
            (
              layer,
            ): layer is NonNullable<
              PreflightResult["findings"][number]["contextDependencies"]
            >[number] =>
              layer === "unit" ||
              layer === "lesson" ||
              layer === "resources" ||
              layer === "deliverableScoring" ||
              layer === "completion",
          )
        : [];
      const missingDependencies = contextDependencies.filter(
        (layer) => coverage.context[layer] !== "included",
      );
      const evidence = Array.isArray(finding.evidence)
        ? finding.evidence
            .map(cleanText)
            .filter((item): item is string => item !== null)
            .slice(0, 3)
        : [];
      if (
        !title ||
        !suggestedAction ||
        !evidencePointer ||
        (owningLayer !== "activity" && owningLayer !== "tutor") ||
        !["critical", "high", "medium", "low"].includes(String(severity)) ||
        typeof target !== "string" ||
        !TARGETS.has(target as PreflightTargetSurface) ||
        !Array.isArray(finding.contextDependencies) ||
        contextDependencies.length !== finding.contextDependencies.length ||
        evidence.length === 0
      ) {
        return null;
      }
      const status =
        missingDependencies.length > 0 ? "not-observed" : "needs-action";
      const dependencyTargetMismatch =
        status === "not-observed" &&
        ((missingDependencies.includes("resources") &&
          target !== "activity-resources") ||
          (missingDependencies.includes("deliverableScoring") &&
            target !== "activity-deliverable"));
      return {
        id: idFactory(),
        provenance: "judged",
        status,
        owningLayer,
        severity: severity as "critical" | "high" | "medium" | "low",
        title,
        evidence,
        evidencePointer,
        targetSurface: target as PreflightTargetSurface,
        suggestedAction: dependencyTargetMismatch
          ? "Resolve the missing authored context and rerun before applying this recommendation."
          : suggestedAction,
        contextDependencies,
      };
    })
    .filter(
      (finding): finding is PreflightResult["findings"][number] =>
        finding !== null,
    );

  if (findings.length !== findingCandidates.length) return null;
  const inventoryCandidates = Array.isArray(raw.runObservedInventory)
    ? raw.runObservedInventory.slice(0, 3)
    : [];
  const runObservedInventory = Array.isArray(raw.runObservedInventory)
    ? inventoryCandidates
        .map((candidate) => {
          if (!candidate || typeof candidate !== "object") return null;
          const item = candidate as { title?: unknown; evidence?: unknown };
          const title = cleanText(item.title);
          const evidence = Array.isArray(item.evidence)
            ? item.evidence
                .map(cleanText)
                .filter((entry): entry is string => entry !== null)
                .slice(0, 5)
            : [];
          return title && evidence.length > 0
            ? { id: idFactory(), provenance: "judged" as const, title, evidence }
            : null;
        })
        .filter(
          (
            item,
          ): item is NonNullable<PreflightResult["runObservedInventory"]>[number] =>
            item !== null,
        )
    : [];
  if (runObservedInventory.length !== inventoryCandidates.length) return null;
  return {
    version: 1,
    analysisStatus: "complete",
    summary,
    findings,
    runObservedInventory,
    coverage,
  };
}

/**
 * Deterministic (non-LLM) findings computed straight from coverage/duration —
 * these run unconditionally, even if the judged synthesis call fails.
 *
 * Deliberately excludes: a deterministic fabrication check (declined — the
 * judge has no `factualCorrectness` dimension on this codebase to duplicate)
 * and a per-dimension design/gifted floor-breach scan (declined — single-cell
 * judge noise made an uncalibrated per-dimension cap inappropriate). The one
 * kept cast-level check, `protectedFloorBreaches`, reuses the pre-existing
 * calibrated `DEFAULT_GATE.absoluteFloor` from `curriculumScore.ts`, so it is
 * not a new uncalibrated threshold. See curriculumSim.ts's
 * `synthesizePreflightResult` for the matching exclusion note.
 */
export function deterministicPreflightFindings(args: {
  coverage: PreflightCoverage;
  durationMinutes: number | null;
}): PreflightResult["findings"] {
  const findings: PreflightResult["findings"] = [];
  const { cast } = args.coverage;
  if (cast.failed > 0) {
    findings.push({
      id: "deterministic-cast-coverage",
      provenance: "deterministic",
      status: "needs-action",
      owningLayer: "runtime",
      severity: "high",
      title: `${cast.failed} ${cast.failed === 1 ? "sim did" : "sims did"} not produce a verdict`,
      evidence: [
        `${cast.completed} of ${cast.expected} expected sims completed.`,
      ],
      evidencePointer: "coverage:cast",
      targetSurface: "rehearse",
      suggestedAction:
        "Re-run before relying on the judged recommendations, or inspect the failed run.",
      contextDependencies: [],
    });
  }
  if (cast.stopReasons.maxTurns > 0) {
    const duration = args.durationMinutes
      ? ` within the activity's ${args.durationMinutes}-minute budget`
      : " within the rehearsal turn budget";
    findings.push({
      id: "deterministic-time-budget",
      provenance: "deterministic",
      status: "needs-action",
      owningLayer: "runtime",
      severity: "medium",
      title: `${cast.stopReasons.maxTurns} of ${cast.completed} sims used the full turn budget`,
      evidence: [
        `${cast.stopReasons.maxTurns} simulated sessions used every available turn${duration}; this alone does not say whether the deliverable or only follow-up work was cut off.`,
      ],
      evidencePointer: "coverage:stopReasons.maxTurns",
      targetSurface: "activity-duration",
      suggestedAction:
        "Check whether the authored work fits the scheduled duration before assigning it.",
      contextDependencies: [],
    });
  }
  const floorBreaches = args.coverage.protectedFloorBreaches ?? [];
  if (floorBreaches.length > 0) {
    findings.push({
      id: "deterministic-protected-floor-breach",
      provenance: "deterministic",
      status: "needs-action",
      owningLayer: "tutor",
      severity: "high",
      title: `${floorBreaches.length} per-sim protected ${floorBreaches.length === 1 ? "score breached" : "scores breached"} the floor`,
      evidence: floorBreaches
        .slice(0, 5)
        .map(
          (breach) =>
            `${breach.profileName}: ${breach.dimension} ${breach.value} < ${breach.floor}.`,
        ),
      evidencePointer: "coverage:protectedFloorBreaches",
      targetSurface: "activity-tutor-prompt",
      suggestedAction:
        "Revise the activity tutor prompt so it challenges claims neutrally, withholds answers, and redirects the reasoning to the scholar.",
      contextDependencies: [],
    });
  }
  return findings;
}
