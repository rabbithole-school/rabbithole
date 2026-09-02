import type { Doc } from "../_generated/dataModel";
import {
  COMPILED_POLICY_INTERPRETER_ID,
  type DeckCard,
  type SimulatorSpec,
} from "../../lib/simulator/contract";
import {
  POLICY_INTERPRETER_VERSION,
  parsePolicyIR,
  type PolicyIR,
  type PolicySelector,
  type ReferencePolicyDeck,
} from "../../lib/simulator/policyIR";
import { canonicalJson, sha256Hex } from "../../lib/simulator/prompt";
import type { CriterionDirection, Spread } from "../../lib/simulator/teacherDigest";
import { criterionDelta } from "../../lib/simulator/teacherDigest";
import { getSimulatorTemplate } from "../../lib/simulator/templates/registry";

export const DEGENERATE_VARIANTS = ["empty", "noop", "greedy"] as const;
export type DegenerateVariant = (typeof DEGENERATE_VARIANTS)[number];
export type SeparationVerdict = "separated" | "close" | "degenerate-wins";

type PolicySnapshot = NonNullable<
  Doc<"simulatorRuns">["compiledPolicySnapshot"]
>[number];

export type DegenerateProbe = {
  deck: DeckCard[];
  simulatorSpec: SimulatorSpec;
  compiledPolicyHash: string;
  interpreterVersion: number;
  compiledPolicySnapshot: PolicySnapshot[];
  matchupPolicyHashes?: {
    policyHash: string;
    /** Hash of the opponent's frozen starter prompt + action contract. */
    opponentPolicyHash: string;
  };
};

export type ReferenceProbe = Pick<
  DegenerateProbe,
  | "deck"
  | "simulatorSpec"
  | "compiledPolicyHash"
  | "interpreterVersion"
  | "compiledPolicySnapshot"
>;

export type DegenerateProbePlan = {
  variants: DegenerateVariant[];
  note: string | null;
};

export type DegenerateProbeOptions = {
  /** Teacher-authored policies for visible, locked opponent slots. */
  lockedPolicies?: readonly PolicyIR[];
};

type GreedySelectorBuilder = (
  spec: SimulatorSpec,
  slotId: string,
) => PolicySelector;

const GREEDY_SELECTORS: Record<string, GreedySelectorBuilder> = {
  ecosystemGrid: (spec, slotId) => {
    const slot = spec.speciesSlots.find(
      (candidate) => candidate.slotId === slotId,
    );
    const sensesResources = slot?.senses.some((sense) =>
      sense.channels?.includes("resources"),
    );
    if (sensesResources) {
      return {
        kind: "action",
        actionKind: "graze",
        target: { kind: "nearest_resource", direction: "toward" },
      };
    }
    const targetSlot =
      spec.speciesSlots.find((candidate) => candidate.slotId !== slotId)
        ?.slotId ?? slotId;
    return {
      kind: "action",
      actionKind: "eat",
      target: {
        kind: "nearest_automaton",
        slotId: targetSlot,
        direction: "toward",
      },
    };
  },
  prisonersDilemma: () => ({
    kind: "action",
    actionKind: "defect",
    target: { kind: "none" },
  }),
  publicGoods: () => ({
    kind: "action",
    actionKind: "withhold",
    target: { kind: "none" },
  }),
  // matrixGame deliberately has no entry: its configurable action labels do
  // not define one canonical "greedy" move across authored payoff matrices.
};

export function degenerateProbePlan(templateId: string): DegenerateProbePlan {
  const template = getSimulatorTemplate(templateId);
  const hasLiteralNoop =
    template?.actionKinds.includes("noop") ?? false;
  const variants: DegenerateVariant[] =
    templateId === "prisonersDilemma"
      ? ["empty", "greedy"]
      : [
          "empty",
          ...(hasLiteralNoop ? (["noop"] as const) : []),
          ...(GREEDY_SELECTORS[templateId] ? (["greedy"] as const) : []),
        ];
  return {
    variants,
    note: GREEDY_SELECTORS[templateId]
      ? null
      : "No template-specific greedy probe yet.",
  };
}

function probePrompt(templateId: string, variant: DegenerateVariant): string {
  if (variant === "empty") return "";
  if (variant === "noop") return "Take no deliberate action.";
  if (templateId === "prisonersDilemma") return "Always defect.";
  if (templateId === "publicGoods") return "Always withhold.";
  return "Always take the template's greedy action.";
}

function selectorFor(
  spec: SimulatorSpec,
  slotId: string,
  variant: DegenerateVariant,
): PolicySelector {
  if (variant === "noop") return { kind: "noop" };
  const template = getSimulatorTemplate(spec.templateId);
  if (!template) throw new Error(`Unknown World template "${spec.templateId}"`);
  if (variant === "greedy") {
    const build = GREEDY_SELECTORS[spec.templateId];
    if (!build) {
      throw new Error(
        `No template-specific greedy probe for "${spec.templateId}"`,
      );
    }
    return build(spec, slotId);
  }
  // "Empty" means no authored strategy: choose the registry's first legal
  // action kind. target:none deterministically selects its first legal instance.
  const neutralActionKind = template.actionKinds[0];
  if (!neutralActionKind) {
    throw new Error(`World template "${spec.templateId}" has no legal actions`);
  }
  return {
    kind: "action",
    actionKind: neutralActionKind,
    target: { kind: "none" },
  };
}

function policyFor(
  spec: SimulatorSpec,
  slotId: string,
  variant: DegenerateVariant,
): PolicyIR {
  const template = getSimulatorTemplate(spec.templateId);
  if (!template) throw new Error(`Unknown World template "${spec.templateId}"`);
  return parsePolicyIR(
    {
      version: 1,
      templateId: spec.templateId,
      slotId,
      rules: [
        {
          id: variant,
          when: [],
          then: selectorFor(spec, slotId, variant),
        },
      ],
      default: { kind: "abstain" },
    },
    {
      templateId: spec.templateId,
      slotId,
      actionKinds: template.actionKinds,
    },
  );
}

/**
 * Builds frozen interpreter inputs directly. Degenerate policies vary only
 * scholar-editable slots; locked teacher foils keep their authored policy.
 * A Prisoner's Dilemma opponent slot remains a live starter-hint fallback.
 */
export async function buildDegenerateProbe(
  spec: SimulatorSpec,
  variant: DegenerateVariant,
  options: DegenerateProbeOptions = {},
): Promise<DegenerateProbe> {
  const template = getSimulatorTemplate(spec.templateId);
  if (!template) throw new Error(`Unknown World template "${spec.templateId}"`);
  if (!degenerateProbePlan(spec.templateId).variants.includes(variant)) {
    throw new Error(
      `World template "${spec.templateId}" does not support the ${variant} probe`,
    );
  }
  const simulatorSpec: SimulatorSpec = {
    ...spec,
    interpreter: {
      kind: "scripted",
      interpreterId: COMPILED_POLICY_INTERPRETER_ID,
    },
  };
  const starterOpponent =
    spec.templateId === "prisonersDilemma" && spec.speciesSlots.length > 1;
  const lockedPolicyBySlot = new Map(
    (options.lockedPolicies ?? []).map((policy) => [policy.slotId, policy]),
  );
  const deck = spec.speciesSlots.map((slot, index) => ({
    slotId: slot.slotId,
    count: slot.defaultCount,
    prompt:
      (starterOpponent && index > 0) || slot.locked
        ? slot.starterHint ?? ""
        : probePrompt(spec.templateId, variant),
  }));
  const compiledPolicySnapshot = await Promise.all(
    spec.speciesSlots.map(async (slot, index): Promise<PolicySnapshot> => {
      if (starterOpponent && index > 0) {
        return {
          slotId: slot.slotId,
          status: "fallback",
          reason: "missing",
        };
      }

      const policy = slot.locked
        ? lockedPolicyBySlot.get(slot.slotId)
        : policyFor(spec, slot.slotId, variant);
      if (!policy) {
        throw new Error(
          `Locked slot "${slot.slotId}" requires its authored reference policy for a degenerate probe`,
        );
      }
      return {
        slotId: slot.slotId,
        status: "ready",
        policyHash: await sha256Hex(canonicalJson(policy)),
        policy,
      };
    }),
  );
  const policyHashes = compiledPolicySnapshot
    .filter(
      (
        snapshot,
      ): snapshot is Extract<PolicySnapshot, { status: "ready" }> =>
        snapshot.status === "ready",
    )
    .map(({ slotId, policyHash }) => ({ slotId, policyHash }));
  const matchupPolicyHashes =
    starterOpponent && policyHashes[0]
      ? {
          policyHash: policyHashes[0].policyHash,
          opponentPolicyHash: await sha256Hex(
            canonicalJson({
              slotId: spec.speciesSlots[1].slotId,
              prompt: spec.speciesSlots[1].starterHint ?? "",
              actionSchema: template.actionSchema,
            }),
          ),
        }
      : undefined;
  return {
    deck,
    simulatorSpec,
    compiledPolicyHash: await sha256Hex(
      canonicalJson({
        interpreterVersion: POLICY_INTERPRETER_VERSION,
        slots: compiledPolicySnapshot.map((snapshot) =>
          snapshot.status === "ready"
            ? {
                slotId: snapshot.slotId,
                status: snapshot.status,
                policyHash: snapshot.policyHash,
              }
            : snapshot,
        ),
      }),
    ),
    interpreterVersion: POLICY_INTERPRETER_VERSION,
    compiledPolicySnapshot,
    matchupPolicyHashes,
  };
}

/**
 * Freezes an authored reference deck into the same compiled-run contract as a
 * degenerate probe. The complete catch-all check prevents a card labeled
 * deterministic from falling through to a model decision at runtime.
 */
export async function buildReferenceProbe(
  spec: SimulatorSpec,
  reference: ReferencePolicyDeck,
): Promise<ReferenceProbe> {
  const template = getSimulatorTemplate(spec.templateId);
  if (!template) throw new Error(`Unknown World template "${spec.templateId}"`);
  if (reference.criterion?.kind === "opposition-panel") {
    throw new Error(
      "Authored opposition reference decks need a fixed-opponent Preflight run",
    );
  }
  const expectedSlots = spec.speciesSlots.map((slot) => slot.slotId).sort();
  const actualSlots = reference.policies.map((policy) => policy.slotId).sort();
  if (canonicalJson(actualSlots) !== canonicalJson(expectedSlots)) {
    throw new Error("Authored reference deck does not match this World's species slots");
  }
  for (const policy of reference.policies) {
    if (policy.templateId !== spec.templateId) {
      throw new Error("Authored reference deck uses a different World template");
    }
    const fallback = policy.rules.at(-1);
    if (!fallback || fallback.when.length !== 0 || fallback.then.kind === "abstain") {
      throw new Error(
        `Authored reference deck for "${policy.slotId}" needs a non-abstaining final rule`,
      );
    }
  }

  const deck = spec.speciesSlots.map((slot) => ({
    slotId: slot.slotId,
    count: slot.defaultCount,
    prompt: slot.starterHint ?? "",
  }));
  const compiledPolicySnapshot = await Promise.all(
    reference.policies.map(async (policy): Promise<PolicySnapshot> => ({
      slotId: policy.slotId,
      status: "ready",
      policyHash: await sha256Hex(canonicalJson(policy)),
      policy,
    })),
  );
  return {
    deck,
    simulatorSpec: {
      ...spec,
      interpreter: {
        kind: "scripted",
        interpreterId: COMPILED_POLICY_INTERPRETER_ID,
      },
    },
    compiledPolicyHash: await sha256Hex(
      canonicalJson({
        interpreterVersion: POLICY_INTERPRETER_VERSION,
        slots: compiledPolicySnapshot.map((snapshot) => ({
          slotId: snapshot.slotId,
          status: snapshot.status,
          policyHash: snapshot.status === "ready" ? snapshot.policyHash : undefined,
        })),
      }),
    ),
    interpreterVersion: POLICY_INTERPRETER_VERSION,
    compiledPolicySnapshot,
  };
}

export type SeparationResult = {
  verdict: SeparationVerdict;
  referenceAdvantage: number;
  noiseBand: number;
};

/**
 * The duplicate starter runs are the calibration sample: their observed range
 * is the noise band. Degenerate variants have one run apiece, so their point
 * estimate is intentionally judged against the two-sample starter band rather
 * than pretending they carry an independent variance estimate.
 */
export function criterionSeparation(input: {
  starter: Spread | null;
  degenerate: Spread | null;
  direction: CriterionDirection;
  target?: number;
  reference?: Spread | null;
}): SeparationResult | null {
  if (!input.starter || input.starter.count < 2 || !input.degenerate) return null;
  const reference = input.reference ?? input.starter;
  if (!reference) return null;
  const referenceAdvantage = criterionDelta(
    reference,
    input.degenerate,
    input.direction,
    input.target,
  );
  if (referenceAdvantage === null) return null;
  const noiseBand = input.starter.max - input.starter.min;
  return {
    verdict:
      referenceAdvantage <= 0
        ? "degenerate-wins"
        : referenceAdvantage <= noiseBand
          ? "close"
          : "separated",
    referenceAdvantage,
    noiseBand,
  };
}
