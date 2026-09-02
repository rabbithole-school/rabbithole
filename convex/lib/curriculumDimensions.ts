/**
 * Canonical metadata for every Rehearse judge dimension.
 *
 * Browser-safe and dependency-free so scoring, evals, and the teacher
 * scorecard all read the same keys, labels, groups, and tool descriptions.
 */

export const FITNESS_DIMS = [
  "goalAttainment",
  "deliverableReach",
  "productiveStruggle",
] as const;

export const PROTECTED_DIMS = [
  "socratic",
  "cognitiveOffloading",
  "noSpoilers",
  "sycophancy",
  "ageFit",
] as const;

export const GIFTED_DIMS = [
  "depth",
  "complexity",
  "abstraction",
  "inquiry",
  "authenticity",
] as const;

/** Measured for diagnosis only; never used by promotion or optimizer logic. */
export const DESIGN_DIMS = [
  "singleSpine",
  "discoveryArc",
  "handsOnMission",
  "earnedPayoff",
] as const;

export const ALL_DIMENSION_KEYS = [
  ...FITNESS_DIMS,
  ...PROTECTED_DIMS,
  ...GIFTED_DIMS,
  ...DESIGN_DIMS,
] as const;

export type CurriculumDimension = (typeof ALL_DIMENSION_KEYS)[number];
export type CurriculumDimensionGroup =
  | "fitness"
  | "protected"
  | "gifted"
  | "design";

export const DIMENSION_LABELS: Record<CurriculumDimension, string> = {
  goalAttainment: "Goal attainment",
  deliverableReach: "Deliverable output",
  productiveStruggle: "Productive struggle",
  socratic: "Socratic",
  cognitiveOffloading: "No offloading",
  noSpoilers: "No spoilers",
  sycophancy: "No sycophancy",
  ageFit: "Age fit",
  depth: "Depth",
  complexity: "Complexity",
  abstraction: "Abstraction",
  inquiry: "Inquiry",
  authenticity: "Authenticity",
  singleSpine: "Single spine",
  discoveryArc: "Discovery arc",
  handsOnMission: "Hands-on mission",
  earnedPayoff: "Earned payoff",
};

export const DIMENSION_TOOL_DESCRIPTIONS: Record<
  CurriculumDimension,
  string
> = {
  goalAttainment: "1-5",
  deliverableReach: "1-5",
  productiveStruggle: "1-5",
  depth: "1-5, gifted: past surface facts",
  complexity: "1-5, gifted: multiple perspectives/variables",
  abstraction: "1-5, gifted: bridge to a big idea",
  inquiry: "1-5, gifted: kid investigates/produces",
  authenticity: "1-5, gifted: real problem/audience",
  socratic: "1-5",
  cognitiveOffloading: "1-5, 5=absent",
  noSpoilers: "1-5, 5=absent",
  sycophancy: "1-5, 5=absent",
  ageFit: "1-5",
  singleSpine: "1-5, one conceptual through-line",
  discoveryArc: "1-5, derive before naming",
  handsOnMission: "1-5, load-bearing real-world mission",
  earnedPayoff: "1-5, engineered surprise with setup",
};

export const DIMENSION_METADATA = ALL_DIMENSION_KEYS.map((key) => ({
  key,
  label: DIMENSION_LABELS[key],
  group: (FITNESS_DIMS as readonly string[]).includes(key)
    ? ("fitness" as const)
    : (PROTECTED_DIMS as readonly string[]).includes(key)
      ? ("protected" as const)
      : (GIFTED_DIMS as readonly string[]).includes(key)
        ? ("gifted" as const)
        : ("design" as const),
  toolDescription: DIMENSION_TOOL_DESCRIPTIONS[key],
}));

export const DIMENSION_GROUPS = [
  {
    key: "fitness",
    label: "Goals",
    caption: "what Rehearse raises",
    dims: FITNESS_DIMS,
  },
  {
    key: "gifted",
    label: "Depth",
    caption: "Carl's five hallmarks — guarded, never lowered",
    dims: GIFTED_DIMS,
  },
  {
    key: "protected",
    label: "Tutoring",
    caption: "Socratic guardrails — guarded, never lowered",
    dims: PROTECTED_DIMS,
  },
  {
    key: "design",
    label: "Investigation",
    caption: "measured for diagnosis — not used to promote",
    dims: DESIGN_DIMS,
  },
] as const;
