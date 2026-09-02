import { v } from "convex/values";

import {
  MAX_SCRATCH_CHARS,
  type SensePackage,
  type WorldActionSchema,
} from "./contract";
import { canonicalJson, isExactLegalAction, sha256Hex } from "./prompt";

export { COMPILED_POLICY_INTERPRETER_ID } from "./contract";
export const POLICY_IR_VERSION = 1 as const;
export const POLICY_INTERPRETER_VERSION = 1 as const;
export const MAX_POLICY_RULES = 24;
export const MAX_POLICY_PREDICATES_PER_RULE = 8;

export const COMPILER_SYSTEM = `
You compile one scholar-authored World Species prompt into a bounded policy IR.
The IR is data, never JavaScript. Use only the supplied closed predicate,
target, and action vocabularies. Do not invent sensors, hidden state, physics,
coordinates, loops, functions, code, network access, or actions.
The compile_policy input is the Policy IR object itself. Its only root fields
are version, templateId, slotId, rules, and default. Never wrap it under
parameters, input, policy, or any other field, and never copy reference-context
fields into it.

Rules are evaluated in order. Every rule guard is an AND over its predicates.
An empty guard means always. An action selector picks from the legal action menu
at runtime; if its requested action is unavailable, the interpreter safely
waits. The required default is abstain, which asks Haiku for only that one tick.
Scratch memory starts empty and can only be written by a prior live Haiku
fallback; do not assume or invent an initial memory value.
Use explicit abstain only for situations the prompt genuinely leaves ambiguous.
Prefer a final empty-guard rule when the prompt states a clear default.
If the prompt requires state or history that the closed vocabulary cannot
express, abstain at that decision instead of inventing a predicate or field.

Compile the prompt's behavioral intent faithfully. Never diagnose, improve, or
grade the scholar's writing. Call compile_policy exactly once.
`.trim();

// Bump when compiler BEHAVIOR changes in a way the hashed system prompt does not
// capture (e.g. output-unwrapping/parsing changes like PR #2251). Prompt edits are
// captured automatically by hashing COMPILER_SYSTEM below.
export const POLICY_COMPILER_VERSION = 2;
// Stop repeated failures from consuming unbounded model calls.
export const POLICY_COMPILE_MAX_ATTEMPTS = 4;
// Start same-compiler retries after one minute.
export const POLICY_COMPILE_RETRY_BASE_MS = 60_000;
// Bound the exponential retry delay at thirty minutes.
export const POLICY_COMPILE_RETRY_CAP_MS = 30 * 60_000;
// Treat an action that never completed as orphaned after ten minutes.
export const POLICY_COMPILE_STUCK_TIMEOUT_MS = 10 * 60_000;

const MAX_POLICY_ID_CHARS = 64;
const MAX_POLICY_VALUE_CHARS = 160;
const MAX_POLICY_SLOT_ID_CHARS = 160;

export type NumericComparison = "lt" | "lte" | "eq" | "neq" | "gte" | "gt";
export type CardinalDirection = "same" | "north" | "east" | "south" | "west";
export type BoundaryDirection = Exclude<CardinalDirection, "same">;
export type PolicyTerrainKind = "shelter" | "current" | "shallows";

export type PolicyPredicate =
  | { kind: "self_energy"; op: NumericComparison; value: number }
  | { kind: "self_total_score"; op: NumericComparison; value: number }
  | { kind: "nearest_resource_distance"; op: NumericComparison; value: number }
  | { kind: "terrain_here"; terrainKind: PolicyTerrainKind }
  | {
      kind: "nearest_terrain";
      terrainKind: PolicyTerrainKind;
      op: NumericComparison;
      value: number;
    }
  | {
      kind: "nearest_automaton_distance";
      slotId: string;
      op: NumericComparison;
      value: number;
    }
  | {
      kind: "nearest_automaton_direction";
      slotId: string;
      direction: CardinalDirection;
    }
  | { kind: "boundary"; direction: BoundaryDirection; present: boolean }
  | { kind: "tick"; op: NumericComparison; value: number }
  | { kind: "tick_phase"; op: "eq" | "neq"; value: string }
  | {
      kind: "scratch";
      op: "eq" | "neq" | "contains" | "not_contains";
      value: string;
    }
  | { kind: "rounds_remaining"; op: NumericComparison; value: number }
  | {
      kind: "last_move";
      actor: "self" | "opponent";
      move: "cooperate" | "defect";
    }
  | {
      kind: "last_action";
      actor: "self" | "opponent";
      value: "optionA" | "optionB";
    }
  | {
      kind: "perceived_last_contributors";
      op: NumericComparison;
      value: number;
    }
  | { kind: "self_last_payoff"; op: NumericComparison; value: number };

export type PolicyTarget =
  | { kind: "none" }
  | { kind: "nearest_resource"; direction: "toward" | "away" }
  | {
      kind: "nearest_terrain";
      terrainKind: PolicyTerrainKind;
      direction: "toward" | "away";
    }
  | {
      kind: "nearest_automaton";
      slotId: string;
      direction: "toward" | "away";
    }
  | { kind: "direction"; direction: BoundaryDirection };

export type PolicySelector =
  | { kind: "action"; actionKind: string; target: PolicyTarget }
  | { kind: "noop" }
  | { kind: "abstain" };

export interface PolicyRule {
  id: string;
  when: PolicyPredicate[];
  then: PolicySelector;
}

export interface PolicyIR {
  version: typeof POLICY_IR_VERSION;
  templateId: "ecosystemGrid" | "prisonersDilemma" | "matrixGame" | "publicGoods";
  slotId: string;
  rules: PolicyRule[];
  default: { kind: "abstain" };
}

export type OppositionPanelCriterion = {
  kind: "opposition-panel";
  candidateSlotId: string;
  scoreMetricKey: string;
  emptyPolicyFailureLeg: string;
  opponents: readonly {
    label: string;
    policy: PolicyIR;
    minimumMeanScore: number;
  }[];
};

export type ReferencePolicyDeck = {
  summary: string;
  policies: readonly PolicyIR[];
  /**
   * Teacher-facing language for a specific authored World. It explains the
   * decision being rehearsed without asking the generic Preflight surface to
   * infer a story from metric names.
   */
  preflightStory?: {
    setup: string;
    /**
     * Teacher-facing clear-result sentence. The panel interpolates
     * `{referenceMean}`, `{starterMean}`, and `{shortcutRange}` from the
     * corresponding runs; authored text owns all activity-specific nouns.
     */
    clearTemplate: string;
  };
  /**
   * Self-play can make a neutral default look optimal. A panel criterion keeps
   * the shipped World shape intact while testing its editable policy against
   * fixed authored opposition through the same interpreter and physics.
   */
  criterion?: OppositionPanelCriterion;
};

export type PolicyEvaluation =
  | {
      kind: "action";
      action: unknown;
      ruleId: string;
      trace: string;
    }
  | {
      kind: "abstain";
      ruleId?: string;
      trace: string;
    };

export type CompiledPolicyGuaranteeSlot = {
  status: string;
  policy?: Pick<PolicyIR, "rules">;
};

export function isGuaranteedCompiledPolicySet(input: {
  interpreterVersion?: number;
  policies?: readonly CompiledPolicyGuaranteeSlot[];
}): boolean {
  return (
    input.interpreterVersion === POLICY_INTERPRETER_VERSION &&
    input.policies !== undefined &&
    input.policies.length > 0 &&
    input.policies.every(
      (slot) =>
        slot.status === "ready" &&
        slot.policy !== undefined &&
        slot.policy.rules.every((rule) => rule.then.kind !== "abstain") &&
        slot.policy.rules.some((rule) => rule.when.length === 0),
    )
  );
}

export async function policyCompileContextHash(input: {
  templateId: PolicyIR["templateId"];
  templateVersion: number;
  slotId: string;
  senses: SensePackage;
  actionSchema: WorldActionSchema;
}): Promise<string> {
  return await sha256Hex(canonicalJson(input));
}

export async function policyCompilerFingerprint(input: {
  modelId: string;
}): Promise<string> {
  // Identify compiler behavior without invalidating ready compile-context rows.
  return await sha256Hex(
    canonicalJson({
      compilerVersion: POLICY_COMPILER_VERSION,
      irVersion: POLICY_IR_VERSION,
      interpreterVersion: POLICY_INTERPRETER_VERSION,
      system: COMPILER_SYSTEM,
      modelId: input.modelId,
    }),
  );
}

export function policyCompileRetryDelayMs(attempts: number): number {
  // Grow retries exponentially while keeping interaction-driven recovery bounded.
  return Math.min(
    POLICY_COMPILE_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
    POLICY_COMPILE_RETRY_CAP_MS,
  );
}

export function shouldRecompileFailedPolicy(
  existing: {
    status: "compiling" | "ready" | "failed";
    compilerFingerprint?: string;
    compileAttempts?: number;
    updatedAt: number;
  },
  input: { now: number; fingerprint: string },
): boolean {
  // Compiler upgrades heal failures immediately; same-compiler retries honor limits.
  if (existing.status !== "failed") return false;
  if (existing.compilerFingerprint !== input.fingerprint) return true;
  const attempts = existing.compileAttempts ?? 0;
  if (attempts >= POLICY_COMPILE_MAX_ATTEMPTS) return false;
  return (
    input.now - existing.updatedAt >= policyCompileRetryDelayMs(attempts)
  );
}

export function shouldRestartCompilingPolicy(
  existing: {
    status: "compiling" | "ready" | "failed";
    compilerFingerprint?: string;
    updatedAt: number;
  },
  input: { now: number; fingerprint: string },
): boolean {
  if (existing.status !== "compiling") return false;
  return (
    existing.compilerFingerprint !== input.fingerprint ||
    input.now - existing.updatedAt >= POLICY_COMPILE_STUCK_TIMEOUT_MS
  );
}

const numericComparisonValidator = v.union(
  v.literal("lt"),
  v.literal("lte"),
  v.literal("eq"),
  v.literal("neq"),
  v.literal("gte"),
  v.literal("gt"),
);

const cardinalDirectionValidator = v.union(
  v.literal("same"),
  v.literal("north"),
  v.literal("east"),
  v.literal("south"),
  v.literal("west"),
);

const boundaryDirectionValidator = v.union(
  v.literal("north"),
  v.literal("east"),
  v.literal("south"),
  v.literal("west"),
);

const terrainKindValidator = v.union(
  v.literal("shelter"),
  v.literal("current"),
  v.literal("shallows"),
);

export const policyPredicateValidator = v.union(
  v.object({
    kind: v.literal("self_energy"),
    op: numericComparisonValidator,
    value: v.number(),
  }),
  v.object({
    kind: v.literal("self_total_score"),
    op: numericComparisonValidator,
    value: v.number(),
  }),
  v.object({
    kind: v.literal("nearest_resource_distance"),
    op: numericComparisonValidator,
    value: v.number(),
  }),
  v.object({
    kind: v.literal("terrain_here"),
    terrainKind: terrainKindValidator,
  }),
  v.object({
    kind: v.literal("nearest_terrain"),
    terrainKind: terrainKindValidator,
    op: numericComparisonValidator,
    value: v.number(),
  }),
  v.object({
    kind: v.literal("nearest_automaton_distance"),
    slotId: v.string(),
    op: numericComparisonValidator,
    value: v.number(),
  }),
  v.object({
    kind: v.literal("nearest_automaton_direction"),
    slotId: v.string(),
    direction: cardinalDirectionValidator,
  }),
  v.object({
    kind: v.literal("boundary"),
    direction: boundaryDirectionValidator,
    present: v.boolean(),
  }),
  v.object({
    kind: v.literal("tick"),
    op: numericComparisonValidator,
    value: v.number(),
  }),
  v.object({
    kind: v.literal("tick_phase"),
    op: v.union(v.literal("eq"), v.literal("neq")),
    value: v.string(),
  }),
  v.object({
    kind: v.literal("scratch"),
    op: v.union(
      v.literal("eq"),
      v.literal("neq"),
      v.literal("contains"),
      v.literal("not_contains"),
    ),
    value: v.string(),
  }),
  v.object({
    kind: v.literal("rounds_remaining"),
    op: numericComparisonValidator,
    value: v.number(),
  }),
  v.object({
    kind: v.literal("last_move"),
    actor: v.union(v.literal("self"), v.literal("opponent")),
    move: v.union(v.literal("cooperate"), v.literal("defect")),
  }),
  v.object({
    kind: v.literal("last_action"),
    actor: v.union(v.literal("self"), v.literal("opponent")),
    value: v.union(v.literal("optionA"), v.literal("optionB")),
  }),
  v.object({
    kind: v.literal("perceived_last_contributors"),
    op: numericComparisonValidator,
    value: v.number(),
  }),
  v.object({
    kind: v.literal("self_last_payoff"),
    op: numericComparisonValidator,
    value: v.number(),
  }),
);

const policyTargetValidator = v.union(
  v.object({ kind: v.literal("none") }),
  v.object({
    kind: v.literal("nearest_resource"),
    direction: v.union(v.literal("toward"), v.literal("away")),
  }),
  v.object({
    kind: v.literal("nearest_terrain"),
    terrainKind: terrainKindValidator,
    direction: v.union(v.literal("toward"), v.literal("away")),
  }),
  v.object({
    kind: v.literal("nearest_automaton"),
    slotId: v.string(),
    direction: v.union(v.literal("toward"), v.literal("away")),
  }),
  v.object({
    kind: v.literal("direction"),
    direction: boundaryDirectionValidator,
  }),
);

export const policySelectorValidator = v.union(
  v.object({
    kind: v.literal("action"),
    actionKind: v.string(),
    target: policyTargetValidator,
  }),
  v.object({ kind: v.literal("noop") }),
  v.object({ kind: v.literal("abstain") }),
);

export const policyIRValidator = v.object({
  version: v.literal(POLICY_IR_VERSION),
  templateId: v.union(
    v.literal("ecosystemGrid"),
    v.literal("prisonersDilemma"),
    v.literal("matrixGame"),
    v.literal("publicGoods"),
  ),
  slotId: v.string(),
  rules: v.array(
    v.object({
      id: v.string(),
      when: v.array(policyPredicateValidator),
      then: policySelectorValidator,
    }),
  ),
  default: v.object({ kind: v.literal("abstain") }),
});

export const POLICY_IR_JSON_SCHEMA: {
  type: "object";
  additionalProperties: false;
  required: string[];
  properties: Record<string, unknown>;
} = {
  type: "object",
  additionalProperties: false,
  required: ["version", "templateId", "slotId", "rules", "default"],
  properties: {
    version: { type: "integer", const: POLICY_IR_VERSION },
    templateId: {
      type: "string",
      enum: ["ecosystemGrid", "prisonersDilemma", "matrixGame", "publicGoods"],
    },
    slotId: { type: "string", maxLength: MAX_POLICY_SLOT_ID_CHARS },
    rules: {
      type: "array",
      maxItems: MAX_POLICY_RULES,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "when", "then"],
        properties: {
          id: { type: "string", maxLength: MAX_POLICY_ID_CHARS },
          when: {
            type: "array",
            maxItems: MAX_POLICY_PREDICATES_PER_RULE,
            items: {
              oneOf: [
                ...[
                  "self_energy",
                  "self_total_score",
                  "nearest_resource_distance",
                  "tick",
                  "rounds_remaining",
                  "perceived_last_contributors",
                  "self_last_payoff",
                ].map(
                  (kind) => ({
                    type: "object",
                    additionalProperties: false,
                    required: ["kind", "op", "value"],
                    properties: {
                      kind: { const: kind },
                      op: {
                        type: "string",
                        enum: ["lt", "lte", "eq", "neq", "gte", "gt"],
                      },
                      value: { type: "number" },
                    },
                  }),
                ),
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "terrainKind"],
                  properties: {
                    kind: { const: "terrain_here" },
                    terrainKind: {
                      type: "string",
                      enum: ["shelter", "current", "shallows"],
                    },
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "terrainKind", "op", "value"],
                  properties: {
                    kind: { const: "nearest_terrain" },
                    terrainKind: {
                      type: "string",
                      enum: ["shelter", "current", "shallows"],
                    },
                    op: {
                      type: "string",
                      enum: ["lt", "lte", "eq", "neq", "gte", "gt"],
                    },
                    value: { type: "number" },
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "slotId", "op", "value"],
                  properties: {
                    kind: { const: "nearest_automaton_distance" },
                    slotId: { type: "string", maxLength: MAX_POLICY_SLOT_ID_CHARS },
                    op: {
                      type: "string",
                      enum: ["lt", "lte", "eq", "neq", "gte", "gt"],
                    },
                    value: { type: "number" },
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "slotId", "direction"],
                  properties: {
                    kind: { const: "nearest_automaton_direction" },
                    slotId: { type: "string", maxLength: MAX_POLICY_SLOT_ID_CHARS },
                    direction: {
                      type: "string",
                      enum: ["same", "north", "east", "south", "west"],
                    },
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "direction", "present"],
                  properties: {
                    kind: { const: "boundary" },
                    direction: {
                      type: "string",
                      enum: ["north", "east", "south", "west"],
                    },
                    present: { type: "boolean" },
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "op", "value"],
                  properties: {
                    kind: { const: "tick_phase" },
                    op: { type: "string", enum: ["eq", "neq"] },
                    value: { type: "string", maxLength: MAX_POLICY_VALUE_CHARS },
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "op", "value"],
                  properties: {
                    kind: { const: "scratch" },
                    op: {
                      type: "string",
                      enum: ["eq", "neq", "contains", "not_contains"],
                    },
                    value: { type: "string", maxLength: MAX_SCRATCH_CHARS },
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "actor", "move"],
                  properties: {
                    kind: { const: "last_move" },
                    actor: { type: "string", enum: ["self", "opponent"] },
                    move: { type: "string", enum: ["cooperate", "defect"] },
                  },
                },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "actor", "value"],
                  properties: {
                    kind: { const: "last_action" },
                    actor: { type: "string", enum: ["self", "opponent"] },
                    value: { type: "string", enum: ["optionA", "optionB"] },
                  },
                },
              ],
            },
          },
          then: {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["kind", "actionKind", "target"],
                properties: {
                  kind: { const: "action" },
                  actionKind: { type: "string", maxLength: MAX_POLICY_VALUE_CHARS },
                  target: {
                    oneOf: [
                      {
                        type: "object",
                        additionalProperties: false,
                        required: ["kind"],
                        properties: { kind: { const: "none" } },
                      },
                      ...["nearest_resource"].map((kind) => ({
                        type: "object",
                        additionalProperties: false,
                        required: ["kind", "direction"],
                        properties: {
                          kind: { const: kind },
                          direction: {
                            type: "string",
                            enum: ["toward", "away"],
                          },
                        },
                      })),
                      {
                        type: "object",
                        additionalProperties: false,
                        required: ["kind", "terrainKind", "direction"],
                        properties: {
                          kind: { const: "nearest_terrain" },
                          terrainKind: {
                            type: "string",
                            enum: ["shelter", "current", "shallows"],
                          },
                          direction: {
                            type: "string",
                            enum: ["toward", "away"],
                          },
                        },
                      },
                      {
                        type: "object",
                        additionalProperties: false,
                        required: ["kind", "slotId", "direction"],
                        properties: {
                          kind: { const: "nearest_automaton" },
                          slotId: {
                            type: "string",
                            maxLength: MAX_POLICY_SLOT_ID_CHARS,
                          },
                          direction: {
                            type: "string",
                            enum: ["toward", "away"],
                          },
                        },
                      },
                      {
                        type: "object",
                        additionalProperties: false,
                        required: ["kind", "direction"],
                        properties: {
                          kind: { const: "direction" },
                          direction: {
                            type: "string",
                            enum: ["north", "east", "south", "west"],
                          },
                        },
                      },
                    ],
                  },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["kind"],
                properties: { kind: { const: "noop" } },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["kind"],
                properties: { kind: { const: "abstain" } },
              },
            ],
          },
        },
      },
    },
    default: {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: { kind: { const: "abstain" } },
    },
  },
};

const POLICY_PREDICATES_BY_TEMPLATE: Readonly<
  Record<PolicyIR["templateId"], readonly PolicyPredicate["kind"][]>
> = {
  ecosystemGrid: [
    "self_energy",
    "self_total_score",
    "nearest_resource_distance",
    "terrain_here",
    "nearest_terrain",
    "nearest_automaton_distance",
    "nearest_automaton_direction",
    "boundary",
    "tick",
    "tick_phase",
    "scratch",
    "rounds_remaining",
    "last_move",
  ],
  prisonersDilemma: [
    "self_energy",
    "self_total_score",
    "nearest_resource_distance",
    "nearest_automaton_distance",
    "nearest_automaton_direction",
    "boundary",
    "tick",
    "tick_phase",
    "scratch",
    "rounds_remaining",
    "last_move",
  ],
  matrixGame: [
    "self_total_score",
    "tick",
    "tick_phase",
    "scratch",
    "rounds_remaining",
    "last_action",
  ],
  publicGoods: [
    "self_total_score",
    "tick",
    "tick_phase",
    "scratch",
    "rounds_remaining",
    "perceived_last_contributors",
    "self_last_payoff",
  ],
};

const POLICY_TARGETS_BY_TEMPLATE: Readonly<
  Record<PolicyIR["templateId"], readonly PolicyTarget["kind"][]>
> = {
  ecosystemGrid: [
    "none",
    "nearest_resource",
    "nearest_terrain",
    "nearest_automaton",
    "direction",
  ],
  prisonersDilemma: [
    "none",
    "nearest_resource",
    "nearest_automaton",
    "direction",
  ],
  matrixGame: ["none"],
  publicGoods: ["none"],
};

export function policyPredicateVocabulary(
  templateId: PolicyIR["templateId"],
): readonly PolicyPredicate["kind"][] {
  return POLICY_PREDICATES_BY_TEMPLATE[templateId];
}

export function policyTargetVocabulary(
  templateId: PolicyIR["templateId"],
): readonly PolicyTarget["kind"][] {
  return POLICY_TARGETS_BY_TEMPLATE[templateId];
}

type JsonSchemaVariant = {
  properties?: {
    kind?: { const?: string };
    target?: { oneOf?: JsonSchemaVariant[] };
  };
};

/**
 * The compiler sees only the predicate and target vocabulary legal for this
 * template. The exported global schema remains the storage validator's superset.
 */
export function policyIRJsonSchemaForTemplate(
  templateId: PolicyIR["templateId"],
): typeof POLICY_IR_JSON_SCHEMA {
  const schema = JSON.parse(
    JSON.stringify(POLICY_IR_JSON_SCHEMA),
  ) as typeof POLICY_IR_JSON_SCHEMA;
  schema.properties.templateId = { type: "string", const: templateId };
  const rules = schema.properties.rules as {
    items: {
      properties: {
        when: { items: { oneOf: JsonSchemaVariant[] } };
        then: { oneOf: JsonSchemaVariant[] };
      };
    };
  };
  const allowedPredicates = new Set(policyPredicateVocabulary(templateId));
  rules.items.properties.when.items.oneOf =
    rules.items.properties.when.items.oneOf.filter((variant) => {
      const kind = variant.properties?.kind?.const;
      return typeof kind === "string" && allowedPredicates.has(kind as PolicyPredicate["kind"]);
    });
  const actionSelector = rules.items.properties.then.oneOf.find(
    (variant) => variant.properties?.kind?.const === "action",
  );
  const allowedTargets = new Set(policyTargetVocabulary(templateId));
  if (actionSelector?.properties?.target?.oneOf) {
    actionSelector.properties.target.oneOf =
      actionSelector.properties.target.oneOf.filter((variant) => {
        const kind = variant.properties?.kind?.const;
        return typeof kind === "string" && allowedTargets.has(kind as PolicyTarget["kind"]);
      });
  }
  return schema;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`${field} contains unknown field "${key}"`);
    }
  }
}

function boundedString(value: unknown, field: string, maxChars: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxChars ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${field} must be plain text from 1 through ${maxChars} characters`);
  }
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be finite`);
  }
  return value;
}

function numericComparison(value: unknown, field: string): NumericComparison {
  if (
    value !== "lt" &&
    value !== "lte" &&
    value !== "eq" &&
    value !== "neq" &&
    value !== "gte" &&
    value !== "gt"
  ) {
    throw new Error(`${field} is not a supported numeric comparison`);
  }
  return value;
}

function boundaryDirection(value: unknown, field: string): BoundaryDirection {
  if (value !== "north" && value !== "east" && value !== "south" && value !== "west") {
    throw new Error(`${field} is not a cardinal direction`);
  }
  return value;
}

function cardinalDirection(value: unknown, field: string): CardinalDirection {
  if (value === "same") return value;
  return boundaryDirection(value, field);
}

function terrainKind(value: unknown, field: string): PolicyTerrainKind {
  if (value !== "shelter" && value !== "current" && value !== "shallows") {
    throw new Error(`${field} is not a supported terrain kind`);
  }
  return value;
}

function parsePredicate(value: unknown, field: string): PolicyPredicate {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error(`${field} must be a predicate object`);
  }
  switch (value.kind) {
    case "self_energy": {
      onlyKeys(value, ["kind", "op", "value"], field);
      return {
        kind: "self_energy",
        op: numericComparison(value.op, `${field}.op`),
        value: finiteNumber(value.value, `${field}.value`),
      };
    }
    case "self_total_score": {
      onlyKeys(value, ["kind", "op", "value"], field);
      return {
        kind: "self_total_score",
        op: numericComparison(value.op, `${field}.op`),
        value: finiteNumber(value.value, `${field}.value`),
      };
    }
    case "nearest_resource_distance": {
      onlyKeys(value, ["kind", "op", "value"], field);
      return {
        kind: "nearest_resource_distance",
        op: numericComparison(value.op, `${field}.op`),
        value: finiteNumber(value.value, `${field}.value`),
      };
    }
    case "terrain_here":
      onlyKeys(value, ["kind", "terrainKind"], field);
      return {
        kind: value.kind,
        terrainKind: terrainKind(value.terrainKind, `${field}.terrainKind`),
      };
    case "nearest_terrain":
      onlyKeys(value, ["kind", "terrainKind", "op", "value"], field);
      return {
        kind: value.kind,
        terrainKind: terrainKind(value.terrainKind, `${field}.terrainKind`),
        op: numericComparison(value.op, `${field}.op`),
        value: finiteNumber(value.value, `${field}.value`),
      };
    case "tick": {
      onlyKeys(value, ["kind", "op", "value"], field);
      return {
        kind: "tick",
        op: numericComparison(value.op, `${field}.op`),
        value: finiteNumber(value.value, `${field}.value`),
      };
    }
    case "rounds_remaining": {
      onlyKeys(value, ["kind", "op", "value"], field);
      return {
        kind: "rounds_remaining",
        op: numericComparison(value.op, `${field}.op`),
        value: finiteNumber(value.value, `${field}.value`),
      };
    }
    case "nearest_automaton_distance":
      onlyKeys(value, ["kind", "slotId", "op", "value"], field);
      return {
        kind: value.kind,
        slotId: boundedString(value.slotId, `${field}.slotId`, MAX_POLICY_SLOT_ID_CHARS),
        op: numericComparison(value.op, `${field}.op`),
        value: finiteNumber(value.value, `${field}.value`),
      };
    case "nearest_automaton_direction":
      onlyKeys(value, ["kind", "slotId", "direction"], field);
      return {
        kind: value.kind,
        slotId: boundedString(value.slotId, `${field}.slotId`, MAX_POLICY_SLOT_ID_CHARS),
        direction: cardinalDirection(value.direction, `${field}.direction`),
      };
    case "boundary":
      onlyKeys(value, ["kind", "direction", "present"], field);
      if (typeof value.present !== "boolean") {
        throw new Error(`${field}.present must be boolean`);
      }
      return {
        kind: value.kind,
        direction: boundaryDirection(value.direction, `${field}.direction`),
        present: value.present,
      };
    case "tick_phase":
      onlyKeys(value, ["kind", "op", "value"], field);
      if (value.op !== "eq" && value.op !== "neq") {
        throw new Error(`${field}.op must be eq or neq`);
      }
      return {
        kind: value.kind,
        op: value.op,
        value: boundedString(value.value, `${field}.value`, MAX_POLICY_VALUE_CHARS),
      };
    case "scratch":
      onlyKeys(value, ["kind", "op", "value"], field);
      if (
        value.op !== "eq" &&
        value.op !== "neq" &&
        value.op !== "contains" &&
        value.op !== "not_contains"
      ) {
        throw new Error(`${field}.op is not a supported scratch comparison`);
      }
      return {
        kind: value.kind,
        op: value.op,
        value: boundedString(value.value, `${field}.value`, MAX_SCRATCH_CHARS),
      };
    case "last_move":
      onlyKeys(value, ["kind", "actor", "move"], field);
      if (value.actor !== "self" && value.actor !== "opponent") {
        throw new Error(`${field}.actor must be self or opponent`);
      }
      if (value.move !== "cooperate" && value.move !== "defect") {
        throw new Error(`${field}.move must be cooperate or defect`);
      }
      return { kind: value.kind, actor: value.actor, move: value.move };
    case "last_action":
      onlyKeys(value, ["kind", "actor", "value"], field);
      if (value.actor !== "self" && value.actor !== "opponent") {
        throw new Error(`${field}.actor must be self or opponent`);
      }
      if (value.value !== "optionA" && value.value !== "optionB") {
        throw new Error(`${field}.value must be optionA or optionB`);
      }
      return { kind: value.kind, actor: value.actor, value: value.value };
    case "perceived_last_contributors":
    case "self_last_payoff":
      onlyKeys(value, ["kind", "op", "value"], field);
      return {
        kind: value.kind,
        op: numericComparison(value.op, `${field}.op`),
        value: finiteNumber(value.value, `${field}.value`),
      };
    default:
      throw new Error(`${field}.kind is not in the policy predicate vocabulary`);
  }
}

function parseTarget(value: unknown, field: string): PolicyTarget {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error(`${field} must be a target object`);
  }
  switch (value.kind) {
    case "none":
      onlyKeys(value, ["kind"], field);
      return { kind: value.kind };
    case "nearest_resource":
      onlyKeys(value, ["kind", "direction"], field);
      if (value.direction !== "toward" && value.direction !== "away") {
        throw new Error(`${field}.direction must be toward or away`);
      }
      return { kind: value.kind, direction: value.direction };
    case "nearest_terrain":
      onlyKeys(value, ["kind", "terrainKind", "direction"], field);
      if (value.direction !== "toward" && value.direction !== "away") {
        throw new Error(`${field}.direction must be toward or away`);
      }
      return {
        kind: value.kind,
        terrainKind: terrainKind(value.terrainKind, `${field}.terrainKind`),
        direction: value.direction,
      };
    case "nearest_automaton":
      onlyKeys(value, ["kind", "slotId", "direction"], field);
      if (value.direction !== "toward" && value.direction !== "away") {
        throw new Error(`${field}.direction must be toward or away`);
      }
      return {
        kind: value.kind,
        slotId: boundedString(value.slotId, `${field}.slotId`, MAX_POLICY_SLOT_ID_CHARS),
        direction: value.direction,
      };
    case "direction":
      onlyKeys(value, ["kind", "direction"], field);
      return {
        kind: value.kind,
        direction: boundaryDirection(value.direction, `${field}.direction`),
      };
    default:
      throw new Error(`${field}.kind is not in the policy target vocabulary`);
  }
}

function parseSelector(
  value: unknown,
  field: string,
  allowedActionKinds?: ReadonlySet<string>,
  allowedTargetKinds?: ReadonlySet<PolicyTarget["kind"]>,
): PolicySelector {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error(`${field} must be an action selector`);
  }
  if (value.kind === "noop" || value.kind === "abstain") {
    onlyKeys(value, ["kind"], field);
    return { kind: value.kind };
  }
  if (value.kind !== "action") {
    throw new Error(`${field}.kind is not in the policy selector vocabulary`);
  }
  onlyKeys(value, ["kind", "actionKind", "target"], field);
  const actionKind = boundedString(
    value.actionKind,
    `${field}.actionKind`,
    MAX_POLICY_VALUE_CHARS,
  );
  if (allowedActionKinds && !allowedActionKinds.has(actionKind)) {
    throw new Error(`${field}.actionKind "${actionKind}" is not declared by this template`);
  }
  const target = parseTarget(value.target, `${field}.target`);
  if (allowedTargetKinds && !allowedTargetKinds.has(target.kind)) {
    throw new Error(`${field}.target "${target.kind}" is not declared by this template`);
  }
  return {
    kind: value.kind,
    actionKind,
    target,
  };
}

export function parsePolicyIR(
  value: unknown,
  expected?: {
    templateId: PolicyIR["templateId"];
    slotId: string;
    actionKinds: readonly string[];
  },
): PolicyIR {
  if (!isRecord(value)) throw new Error("Policy IR must be an object");
  onlyKeys(value, ["version", "templateId", "slotId", "rules", "default"], "policy");
  if (value.version !== POLICY_IR_VERSION) {
    throw new Error(`Policy IR version must be ${POLICY_IR_VERSION}`);
  }
  if (
    value.templateId !== "ecosystemGrid" &&
    value.templateId !== "prisonersDilemma" &&
    value.templateId !== "matrixGame" &&
    value.templateId !== "publicGoods"
  ) {
    throw new Error("Policy IR names an unknown template");
  }
  const slotId = boundedString(value.slotId, "policy.slotId", MAX_POLICY_SLOT_ID_CHARS);
  if (expected?.templateId !== undefined && value.templateId !== expected.templateId) {
    throw new Error("Policy IR template does not match the compile request");
  }
  if (expected?.slotId !== undefined && slotId !== expected.slotId) {
    throw new Error("Policy IR Species slot does not match the compile request");
  }
  if (!Array.isArray(value.rules) || value.rules.length > MAX_POLICY_RULES) {
    throw new Error(`Policy IR may contain at most ${MAX_POLICY_RULES} rules`);
  }
  const allowedActionKinds = expected ? new Set(expected.actionKinds) : undefined;
  const allowedPredicateKinds = expected
    ? new Set(policyPredicateVocabulary(expected.templateId))
    : undefined;
  const allowedTargetKinds = expected
    ? new Set(policyTargetVocabulary(expected.templateId))
    : undefined;
  const ids = new Set<string>();
  const rules = value.rules.map((raw, index): PolicyRule => {
    const field = `policy.rules[${index}]`;
    if (!isRecord(raw)) throw new Error(`${field} must be an object`);
    onlyKeys(raw, ["id", "when", "then"], field);
    const id = boundedString(raw.id, `${field}.id`, MAX_POLICY_ID_CHARS);
    if (ids.has(id)) throw new Error(`Policy IR repeats rule id "${id}"`);
    ids.add(id);
    if (
      !Array.isArray(raw.when) ||
      raw.when.length > MAX_POLICY_PREDICATES_PER_RULE
    ) {
      throw new Error(
        `${field}.when may contain at most ${MAX_POLICY_PREDICATES_PER_RULE} predicates`,
      );
    }
    return {
      id,
      when: raw.when.map((predicate, predicateIndex) => {
        const predicateField = `${field}.when[${predicateIndex}]`;
        const parsed = parsePredicate(predicate, predicateField);
        if (allowedPredicateKinds && !allowedPredicateKinds.has(parsed.kind)) {
          throw new Error(
            `${predicateField}.kind "${parsed.kind}" is not declared by this template`,
          );
        }
        return parsed;
      }),
      then: parseSelector(
        raw.then,
        `${field}.then`,
        allowedActionKinds,
        allowedTargetKinds,
      ),
    };
  });
  if (!isRecord(value.default)) throw new Error("policy.default must be an object");
  onlyKeys(value.default, ["kind"], "policy.default");
  if (value.default.kind !== "abstain") {
    throw new Error("policy.default must abstain when no rule matches");
  }
  return {
    version: POLICY_IR_VERSION,
    templateId: value.templateId,
    slotId,
    rules,
    default: { kind: "abstain" },
  };
}

function compareNumber(left: number, op: NumericComparison, right: number): boolean {
  switch (op) {
    case "lt":
      return left < right;
    case "lte":
      return left <= right;
    case "eq":
      return left === right;
    case "neq":
      return left !== right;
    case "gte":
      return left >= right;
    case "gt":
      return left > right;
  }
}

type RelativeEntity = {
  id?: string;
  slotId?: string;
  terrainKind?: PolicyTerrainKind;
  x?: number;
  y?: number;
  dx: number;
  dy: number;
  distance: number;
};

function sensedEntities(
  observation: Record<string, unknown>,
  key: "automata" | "resources" | "terrain",
): RelativeEntity[] {
  const entities = new Map<string, RelativeEntity>();
  for (const senseId of ["vision", "smell", "touch"]) {
    const reading = observation[senseId];
    if (!isRecord(reading) || !Array.isArray(reading[key])) continue;
    for (const raw of reading[key]) {
      if (
        !isRecord(raw) ||
        typeof raw.dx !== "number" ||
        typeof raw.dy !== "number" ||
        typeof raw.distance !== "number" ||
        !Number.isFinite(raw.dx) ||
        !Number.isFinite(raw.dy) ||
        !Number.isFinite(raw.distance)
      ) {
        continue;
      }
      const sensedTerrainKind: PolicyTerrainKind | undefined =
        raw.kind === "shelter" || raw.kind === "current" || raw.kind === "shallows"
          ? raw.kind
          : undefined;
      const entity: RelativeEntity = {
        id: typeof raw.id === "string" ? raw.id : undefined,
        slotId: typeof raw.slotId === "string" ? raw.slotId : undefined,
        terrainKind: sensedTerrainKind,
        x: typeof raw.x === "number" ? raw.x : undefined,
        y: typeof raw.y === "number" ? raw.y : undefined,
        dx: raw.dx,
        dy: raw.dy,
        distance: raw.distance,
      };
      const keyValue =
        entity.id ??
        (entity.x !== undefined && entity.y !== undefined
          ? `${entity.x},${entity.y}`
          : `${entity.slotId ?? ""}:${entity.dx},${entity.dy}`);
      const previous = entities.get(keyValue);
      if (!previous || entity.distance < previous.distance) {
        entities.set(keyValue, entity);
      }
    }
  }
  return [...entities.values()].sort((left, right) => {
    const distance = left.distance - right.distance;
    if (distance !== 0) return distance;
    const leftId = left.id ?? "";
    const rightId = right.id ?? "";
    if (leftId !== rightId) return leftId < rightId ? -1 : 1;
    return left.dx - right.dx || left.dy - right.dy;
  });
}

function directionFor(relative: Pick<RelativeEntity, "dx" | "dy">): CardinalDirection {
  if (relative.dx === 0 && relative.dy === 0) return "same";
  if (Math.abs(relative.dx) > Math.abs(relative.dy)) {
    return relative.dx > 0 ? "east" : "west";
  }
  return relative.dy > 0 ? "south" : "north";
}

function boundaries(observation: Record<string, unknown>): Set<string> {
  const result = new Set<string>();
  for (const senseId of ["vision", "smell", "touch"]) {
    const reading = observation[senseId];
    if (!isRecord(reading) || !Array.isArray(reading.boundary)) continue;
    for (const direction of reading.boundary) {
      if (typeof direction === "string") result.add(direction);
    }
  }
  return result;
}

function predicateMatches(
  predicate: PolicyPredicate,
  observation: Record<string, unknown>,
  tick: number,
  tickPhase: string,
  scratch: string | undefined,
): boolean {
  const self = isRecord(observation.self) ? observation.self : {};
  switch (predicate.kind) {
    case "self_energy":
      return (
        typeof self.energy === "number" &&
        compareNumber(self.energy, predicate.op, predicate.value)
      );
    case "self_total_score":
      return (
        typeof self.totalScore === "number" &&
        compareNumber(self.totalScore, predicate.op, predicate.value)
      );
    case "nearest_resource_distance": {
      const nearest = sensedEntities(observation, "resources")[0];
      return (
        nearest !== undefined &&
        compareNumber(nearest.distance, predicate.op, predicate.value)
      );
    }
    case "terrain_here":
      return (
        isRecord(self.terrain) &&
        self.terrain.kind === predicate.terrainKind
      );
    case "nearest_terrain": {
      const nearest = sensedEntities(observation, "terrain").find(
        (candidate) => candidate.terrainKind === predicate.terrainKind,
      );
      return (
        nearest !== undefined &&
        compareNumber(nearest.distance, predicate.op, predicate.value)
      );
    }
    case "nearest_automaton_distance": {
      const nearest = sensedEntities(observation, "automata").find(
        (candidate) => candidate.slotId === predicate.slotId,
      );
      return (
        nearest !== undefined &&
        compareNumber(nearest.distance, predicate.op, predicate.value)
      );
    }
    case "nearest_automaton_direction": {
      const nearest = sensedEntities(observation, "automata").find(
        (candidate) => candidate.slotId === predicate.slotId,
      );
      return nearest !== undefined && directionFor(nearest) === predicate.direction;
    }
    case "boundary":
      return boundaries(observation).has(predicate.direction) === predicate.present;
    case "tick":
      return compareNumber(tick, predicate.op, predicate.value);
    case "tick_phase":
      return predicate.op === "eq"
        ? tickPhase === predicate.value
        : tickPhase !== predicate.value;
    case "scratch": {
      const value = scratch ?? "";
      if (predicate.op === "eq") return value === predicate.value;
      if (predicate.op === "neq") return value !== predicate.value;
      if (predicate.op === "contains") return value.includes(predicate.value);
      return !value.includes(predicate.value);
    }
    case "rounds_remaining":
      return (
        typeof observation.roundsRemaining === "number" &&
        compareNumber(
          observation.roundsRemaining,
          predicate.op,
          predicate.value,
        )
      );
    case "last_move": {
      if (!Array.isArray(observation.history)) return false;
      const last = observation.history.at(-1);
      if (!isRecord(last)) return false;
      const move =
        predicate.actor === "self" ? last.myMove : last.opponentMove;
      return move === predicate.move;
    }
    case "last_action": {
      if (!Array.isArray(observation.history)) return false;
      const last = observation.history.at(-1);
      if (!isRecord(last)) return false;
      const action =
        predicate.actor === "self" ? last.myAction : last.opponentAction;
      return action === predicate.value;
    }
    case "perceived_last_contributors": {
      if (!Array.isArray(observation.history)) return false;
      const last = observation.history.at(-1);
      return (
        isRecord(last) &&
        typeof last.contributorCount === "number" &&
        compareNumber(last.contributorCount, predicate.op, predicate.value)
      );
    }
    case "self_last_payoff": {
      if (!Array.isArray(observation.history)) return false;
      const last = observation.history.at(-1);
      return (
        isRecord(last) &&
        typeof last.myPayoff === "number" &&
        compareNumber(last.myPayoff, predicate.op, predicate.value)
      );
    }
  }
}

function describeComparison(op: NumericComparison): string {
  return {
    lt: "<",
    lte: "<=",
    eq: "=",
    neq: "!=",
    gte: ">=",
    gt: ">",
  }[op];
}

export function describePolicyPredicate(predicate: PolicyPredicate): string {
  switch (predicate.kind) {
    case "self_energy":
      return `energy ${describeComparison(predicate.op)} ${predicate.value}`;
    case "self_total_score":
      return `score ${describeComparison(predicate.op)} ${predicate.value}`;
    case "nearest_resource_distance":
      return `nearest food distance ${describeComparison(predicate.op)} ${predicate.value}`;
    case "terrain_here":
      return `current cell is ${predicate.terrainKind}`;
    case "nearest_terrain":
      return `nearest ${predicate.terrainKind} distance ${describeComparison(predicate.op)} ${predicate.value}`;
    case "nearest_automaton_distance":
      return `nearest ${predicate.slotId} distance ${describeComparison(predicate.op)} ${predicate.value}`;
    case "nearest_automaton_direction":
      return `nearest ${predicate.slotId} is ${predicate.direction}`;
    case "boundary":
      return `${predicate.direction} edge ${predicate.present ? "is sensed" : "is not sensed"}`;
    case "tick":
      return `tick ${describeComparison(predicate.op)} ${predicate.value}`;
    case "tick_phase":
      return `phase ${predicate.op === "eq" ? "is" : "is not"} ${predicate.value}`;
    case "scratch":
      return `memory ${predicate.op.replace("_", " ")} "${predicate.value}"`;
    case "rounds_remaining":
      return `rounds left ${describeComparison(predicate.op)} ${predicate.value}`;
    case "last_move":
      return `last ${predicate.actor} move was ${predicate.move}`;
    case "last_action":
      return `last ${predicate.actor} action was ${predicate.value}`;
    case "perceived_last_contributors":
      return `perceived contributors last round ${describeComparison(predicate.op)} ${predicate.value}`;
    case "self_last_payoff":
      return `last payoff ${describeComparison(predicate.op)} ${predicate.value}`;
  }
}

export function describePolicySelector(selector: PolicySelector): string {
  if (selector.kind === "noop") return "wait";
  if (selector.kind === "abstain") return "ask Haiku for this tick";
  switch (selector.target.kind) {
    case "none":
      return selector.actionKind;
    case "nearest_resource":
      return `${selector.actionKind} ${selector.target.direction} nearest food`;
    case "nearest_terrain":
      return `${selector.actionKind} ${selector.target.direction} nearest ${selector.target.terrainKind}`;
    case "nearest_automaton":
      return `${selector.actionKind} ${selector.target.direction} nearest ${selector.target.slotId}`;
    case "direction":
      return `${selector.actionKind} ${selector.target.direction}`;
  }
}

export function describePolicyRule(rule: PolicyRule): string {
  const guard =
    rule.when.length === 0
      ? "always"
      : rule.when.map(describePolicyPredicate).join(" and ");
  return `${guard} -> ${describePolicySelector(rule.then)}`;
}

function neutralAction(legalActions: readonly unknown[]): unknown {
  const neutral =
    legalActions.find(
      (action) => isRecord(action) && action.kind === "noop",
    ) ??
    legalActions[0];
  if (
    neutral === undefined ||
    !isExactLegalAction(neutral, legalActions)
  ) {
    throw new Error("World template produced no valid legal action");
  }
  return neutral;
}

function movementStep(
  action: Record<string, unknown>,
  self: Record<string, unknown>,
): { dx: number; dy: number } | null {
  if (
    !isRecord(action.to) ||
    typeof action.to.x !== "number" ||
    typeof action.to.y !== "number" ||
    typeof self.x !== "number" ||
    typeof self.y !== "number"
  ) {
    return null;
  }
  const rawDx = action.to.x - self.x;
  const rawDy = action.to.y - self.y;
  return {
    dx: rawDx > 1 ? -1 : rawDx < -1 ? 1 : rawDx,
    dy: rawDy > 1 ? -1 : rawDy < -1 ? 1 : rawDy,
  };
}

function selectDirectionalMove(
  candidates: readonly Record<string, unknown>[],
  self: Record<string, unknown>,
  target: { dx: number; dy: number },
  direction: "toward" | "away",
): Record<string, unknown> | undefined {
  const scored = candidates
    .map((candidate) => {
      const step = movementStep(candidate, self);
      if (!step) return null;
      const distance =
        Math.abs(target.dx - step.dx) + Math.abs(target.dy - step.dy);
      return { candidate, distance };
    })
    .filter(
      (
        entry,
      ): entry is { candidate: Record<string, unknown>; distance: number } =>
        entry !== null,
    )
    .sort((left, right) =>
      direction === "toward"
        ? left.distance - right.distance
        : right.distance - left.distance,
    );
  return scored[0]?.candidate;
}

function selectAction(
  selector: Extract<PolicySelector, { kind: "action" }>,
  observation: Record<string, unknown>,
  legalActions: readonly unknown[],
): unknown {
  const candidates = legalActions.filter(
    (action): action is Record<string, unknown> =>
      isRecord(action) && action.kind === selector.actionKind,
  );
  if (candidates.length === 0) return undefined;
  if (selector.target.kind === "none") return candidates[0];
  if (selector.target.kind === "direction") {
    const expected = {
      north: { dx: 0, dy: -1 },
      east: { dx: 1, dy: 0 },
      south: { dx: 0, dy: 1 },
      west: { dx: -1, dy: 0 },
    }[selector.target.direction];
    const self = isRecord(observation.self) ? observation.self : {};
    return candidates.find((candidate) => {
      const step = movementStep(candidate, self);
      return step?.dx === expected.dx && step.dy === expected.dy;
    });
  }
  const target = selector.target;
  const entities =
    target.kind === "nearest_resource"
      ? sensedEntities(observation, "resources")
      : target.kind === "nearest_terrain"
        ? sensedEntities(observation, "terrain").filter(
            (candidate) => candidate.terrainKind === target.terrainKind,
          )
      : sensedEntities(observation, "automata").filter(
          (candidate) =>
            target.kind === "nearest_automaton" &&
            candidate.slotId === target.slotId,
        );
  const nearest = entities[0];
  if (!nearest) return undefined;
  if (selector.actionKind === "eat" && nearest.id) {
    return candidates.find((candidate) => candidate.targetId === nearest.id);
  }
  if (
    selector.actionKind === "graze" &&
    nearest.x !== undefined &&
    nearest.y !== undefined
  ) {
    return candidates.find(
      (candidate) =>
        isRecord(candidate.at) &&
        candidate.at.x === nearest.x &&
        candidate.at.y === nearest.y,
    );
  }
  if (selector.actionKind === "move") {
    const self = isRecord(observation.self) ? observation.self : {};
    return selectDirectionalMove(
      candidates,
      self,
      nearest,
      target.direction,
    );
  }
  return candidates[0];
}

export function evaluatePolicy(
  ir: PolicyIR,
  observationValue: unknown,
  legalActions: readonly unknown[],
  tick: number,
  scratch: string | undefined,
  tickPhase = "",
): PolicyEvaluation {
  const observation = isRecord(observationValue) ? observationValue : {};
  for (const rule of ir.rules.slice(0, MAX_POLICY_RULES)) {
    if (
      !rule.when
        .slice(0, MAX_POLICY_PREDICATES_PER_RULE)
        .every((predicate) =>
          predicateMatches(predicate, observation, tick, tickPhase, scratch),
        )
    ) {
      continue;
    }
    const ruleText = describePolicyRule(rule);
    if (rule.then.kind === "abstain") {
      return {
        kind: "abstain",
        ruleId: rule.id,
        trace: `Rule ${rule.id} fired: ${ruleText}`,
      };
    }
    const selected =
      rule.then.kind === "noop"
        ? neutralAction(legalActions)
        : selectAction(rule.then, observation, legalActions);
    const action =
      selected !== undefined &&
      isExactLegalAction(selected, legalActions)
        ? selected
        : neutralAction(legalActions);
    return {
      kind: "action",
      action,
      ruleId: rule.id,
      trace:
        selected === undefined
          ? `Rule ${rule.id} fired, but that action was not legal now: ${ruleText} -> wait`
          : `Rule ${rule.id} fired: ${ruleText}`,
    };
  }
  return {
    kind: "abstain",
    trace: "No compiled rule matched, so this tick asks Haiku.",
  };
}
