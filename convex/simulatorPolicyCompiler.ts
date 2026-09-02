"use node";

import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { MODELS } from "./lib/models";
import { ROLES } from "./lib/roles";
import { recordAnthropicUsage } from "./usage";
import { simulatorSpecValidator } from "./schema";
import { MAX_PROMPT_CHARS, type SimulatorSpec } from "../lib/simulator/contract";
import {
  COMPILER_SYSTEM,
  POLICY_INTERPRETER_VERSION,
  POLICY_IR_VERSION,
  parsePolicyIR,
  policyIRJsonSchemaForTemplate,
  policyPredicateVocabulary,
  policyTargetVocabulary,
  policyCompileContextHash,
  type PolicyIR,
  type PolicyPredicate,
  type PolicyTarget,
} from "../lib/simulator/policyIR";
import { canonicalJson, sha256Hex } from "../lib/simulator/prompt";
import { getSimulatorTemplate } from "../lib/simulator/templates/registry";

export { COMPILER_SYSTEM };

const COMPILE_TOOL = {
  name: "compile_policy",
  description:
    "Emit the complete bounded decision policy for exactly one Species card.",
} as const;

type CompilerResponse = {
  content: unknown[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compileToolInput(content: readonly unknown[]): unknown {
  for (const block of content) {
    if (
      isRecord(block) &&
      block.type === "tool_use" &&
      block.name === COMPILE_TOOL.name &&
      "input" in block
    ) {
      return block.input;
    }
  }
  throw new Error("Compiler response did not call compile_policy");
}

const POLICY_WRAPPER_FIELDS = new Set(["parameters", "policy", "policyIR"]);

export function normalizeCompilerOutput(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const [field, ...rest] = Object.keys(input);
  if (!field || rest.length > 0 || !POLICY_WRAPPER_FIELDS.has(field)) return input;
  return input[field];
}

const PREDICATE_SIGNATURES: Record<PolicyPredicate["kind"], string> = {
  self_energy: "self_energy(op,value)",
  self_total_score: "self_total_score(op,value)",
  nearest_resource_distance: "nearest_resource_distance(op,value)",
  terrain_here: "terrain_here(kind)",
  nearest_terrain: "nearest_terrain(kind,op,value)",
  nearest_automaton_distance: "nearest_automaton_distance(slotId,op,value)",
  nearest_automaton_direction: "nearest_automaton_direction(slotId,direction)",
  boundary: "boundary(direction,present)",
  tick: "tick(op,value)",
  tick_phase: "tick_phase(eq|neq,value)",
  scratch: "scratch(eq|neq|contains|not_contains,value)",
  rounds_remaining: "rounds_remaining(op,value)",
  last_move: "last_move(self|opponent,cooperate|defect)",
  last_action: "last_action(self|opponent,optionA|optionB)",
  perceived_last_contributors: "perceived_last_contributors(op,value)",
  self_last_payoff: "self_last_payoff(op,value)",
};

const TARGET_SIGNATURES: Record<PolicyTarget["kind"], string> = {
  none: "none",
  nearest_resource: "nearest_resource(toward|away)",
  nearest_terrain: "nearest_terrain(kind,toward|away)",
  nearest_automaton: "nearest_automaton(slotId,toward|away)",
  direction: "direction(north|east|south|west)",
};

export function compilerVocabulary(templateId: PolicyIR["templateId"]) {
  return {
    predicates: policyPredicateVocabulary(templateId).map(
      (kind) => PREDICATE_SIGNATURES[kind],
    ),
    targets: policyTargetVocabulary(templateId).map(
      (kind) => TARGET_SIGNATURES[kind],
    ),
  };
}

export function compilerContract(
  spec: SimulatorSpec,
  card: { slotId: string; prompt: string },
  actionKinds: readonly string[],
  actionSchema: unknown,
) {
  const slot = spec.speciesSlots.find((candidate) => candidate.slotId === card.slotId);
  if (!slot) throw new Error(`Unknown Species slot "${card.slotId}"`);
  return {
    policyHeader: {
      version: POLICY_IR_VERSION,
      templateId: spec.templateId,
      slotId: slot.slotId,
    },
    referenceContext: {
      interpreterVersion: POLICY_INTERPRETER_VERSION,
      templateVersion: spec.templateVersion,
      senses: slot.senses,
      actionKinds,
      actionSchema,
    },
    vocabulary: compilerVocabulary(spec.templateId),
  };
}

export function compilerMessage(
  spec: SimulatorSpec,
  card: { slotId: string; prompt: string },
  actionKinds: readonly string[],
  actionSchema: unknown,
): string {
  const contract = compilerContract(spec, card, actionKinds, actionSchema);
  return [
    "POLICY IR HEADER - COPY THESE EXACT ROOT FIELDS",
    canonicalJson(contract.policyHeader),
    "REFERENCE CONTEXT - DO NOT COPY THESE FIELDS INTO POLICY IR",
    canonicalJson(contract.referenceContext),
    "CLOSED PREDICATE VOCABULARY",
    contract.vocabulary.predicates.join("\n"),
    "CLOSED TARGET VOCABULARY",
    contract.vocabulary.targets.join("\n"),
    "SPECIES PROMPT",
    card.prompt,
  ].join("\n\n");
}

export function validateCompilerOutput(
  input: unknown,
  expected: {
    templateId: PolicyIR["templateId"];
    slotId: string;
    actionKinds: readonly string[];
  },
): PolicyIR {
  return parsePolicyIR(normalizeCompilerOutput(input), expected);
}

export const compilePolicy = internalAction({
  args: {
    policyId: v.id("compiledPolicies"),
    spec: simulatorSpecValidator,
    card: v.object({
      slotId: v.string(),
      prompt: v.string(),
    }),
  },
  handler: async (ctx, args): Promise<{ status: "ready" | "failed" | "stale" }> => {
    const pending = await ctx.runQuery(internal.simulatorPolicies.getForCompile, {
      policyId: args.policyId,
    });
    if (!pending) return { status: "stale" };

    let errorCode = "POLICY_COMPILE_FAILED";
    try {
      if (args.card.prompt.length > MAX_PROMPT_CHARS) {
        throw new Error("Species prompt exceeds the compiler input limit");
      }
      const spec = args.spec as SimulatorSpec;
      const template = getSimulatorTemplate(spec.templateId);
      if (!template) throw new Error(`Unknown World template "${spec.templateId}"`);
      template.validateSpec(spec);
      const slot = spec.speciesSlots.find(
        (candidate) => candidate.slotId === args.card.slotId,
      );
      if (!slot) throw new Error(`Unknown Species slot "${args.card.slotId}"`);
      const compileContextHash = await policyCompileContextHash({
        templateId: spec.templateId,
        templateVersion: spec.templateVersion,
        slotId: args.card.slotId,
        senses: slot.senses,
        actionSchema: template.actionSchema,
      });
      if (pending.compileContextHash !== compileContextHash) {
        return { status: "stale" };
      }

      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const anthropic = new Anthropic();
      errorCode = "POLICY_COMPILER_PROVIDER_ERROR";
      const response = (await anthropic.messages.create({
        model: MODELS.SONNET,
        max_tokens: 5_000,
        system: COMPILER_SYSTEM,
        tools: [
          {
            ...COMPILE_TOOL,
            input_schema: policyIRJsonSchemaForTemplate(spec.templateId),
          },
        ],
        tool_choice: { type: "tool", name: COMPILE_TOOL.name },
        messages: [
          {
            role: "user",
            content: compilerMessage(
              spec,
              args.card,
              template.actionKinds,
              template.actionSchema,
            ),
          },
        ],
      })) as CompilerResponse;
      await recordAnthropicUsage(ctx, {
        source: "world_policy_compiler",
        role: ROLES.SCHOLAR,
        model: MODELS.SONNET,
        usage: response.usage,
      });

      errorCode = "MALFORMED_POLICY_IR";
      const policy = validateCompilerOutput(compileToolInput(response.content), {
        templateId: spec.templateId,
        slotId: args.card.slotId,
        actionKinds: template.actionKinds,
      });
      const policyHash = await sha256Hex(canonicalJson(policy));
      const result = await ctx.runMutation(internal.simulatorPolicies.completeCompile, {
        policyId: args.policyId,
        compileContextHash,
        policy,
        policyHash,
      });
      return { status: result.kind === "ready" ? "ready" : "stale" };
    } catch (error) {
      console.error(
        `[simulatorPolicyCompiler] ${String(args.policyId)} failed (${errorCode}):`,
        error instanceof Error ? error.message : String(error),
      );
      const result = await ctx.runMutation(internal.simulatorPolicies.failCompile, {
        policyId: args.policyId,
        compileContextHash: pending.compileContextHash ?? "",
        errorCode,
      });
      return { status: result.kind === "failed" ? "failed" : "stale" };
    }
  },
});
