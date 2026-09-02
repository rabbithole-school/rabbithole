import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  COMPILER_SYSTEM,
  compilerContract,
  compilerMessage,
  validateCompilerOutput,
} from "../simulatorPolicyCompiler";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { COOPERATION_CONFLICT_LESSONS } from "../seed/cooperationConflict";
import {
  SYSTEMS_AGENTS_LESSONS,
  simulatorSpecForStorage,
} from "../seed/systemsAgents";
import type { SimulatorSpec } from "../../lib/simulator/contract";
import {
  POLICY_COMPILE_MAX_ATTEMPTS,
  POLICY_COMPILE_RETRY_BASE_MS,
  POLICY_COMPILE_RETRY_CAP_MS,
  POLICY_COMPILE_STUCK_TIMEOUT_MS,
  POLICY_INTERPRETER_VERSION,
  policyCompileRetryDelayMs,
  policyCompileContextHash,
  shouldRecompileFailedPolicy,
  shouldRestartCompilingPolicy,
  type PolicyPredicate,
  type PolicyTarget,
} from "../../lib/simulator/policyIR";
import { getSimulatorTemplate } from "../../lib/simulator/templates/registry";

const createModel = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: createModel };
  }
  return { default: FakeAnthropic, Anthropic: FakeAnthropic };
});

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TestHarness = ReturnType<typeof convexTest>;

const NOISY_POLICY_PROMPT =
  "Cooperate on the first round. If it looks like Ben cheated me last round, cheat this round to pay him back, then try cooperating again. If he looks like he cheated me three rounds in a row, stop trusting him and cheat for the rest of the game.";

const PREDICATE_EXAMPLES = {
  self_energy: { kind: "self_energy", op: "gte", value: 1 },
  self_total_score: { kind: "self_total_score", op: "gte", value: 1 },
  nearest_resource_distance: {
    kind: "nearest_resource_distance",
    op: "lte",
    value: 2,
  },
  terrain_here: { kind: "terrain_here", terrainKind: "shelter" },
  nearest_terrain: {
    kind: "nearest_terrain",
    terrainKind: "shallows",
    op: "lte",
    value: 2,
  },
  nearest_automaton_distance: {
    kind: "nearest_automaton_distance",
    slotId: "other",
    op: "lte",
    value: 2,
  },
  nearest_automaton_direction: {
    kind: "nearest_automaton_direction",
    slotId: "other",
    direction: "north",
  },
  boundary: { kind: "boundary", direction: "north", present: true },
  tick: { kind: "tick", op: "gte", value: 1 },
  tick_phase: { kind: "tick_phase", op: "eq", value: "round 2" },
  scratch: { kind: "scratch", op: "contains", value: "wait" },
  rounds_remaining: { kind: "rounds_remaining", op: "lte", value: 2 },
  last_move: { kind: "last_move", actor: "opponent", move: "defect" },
  last_action: { kind: "last_action", actor: "opponent", value: "optionB" },
  perceived_last_contributors: {
    kind: "perceived_last_contributors",
    op: "gte",
    value: 2,
  },
  self_last_payoff: { kind: "self_last_payoff", op: "gte", value: 1 },
} satisfies Record<PolicyPredicate["kind"], PolicyPredicate>;

const TARGET_EXAMPLES = {
  none: { kind: "none" },
  nearest_resource: { kind: "nearest_resource", direction: "toward" },
  nearest_terrain: {
    kind: "nearest_terrain",
    terrainKind: "shallows",
    direction: "toward",
  },
  nearest_automaton: {
    kind: "nearest_automaton",
    slotId: "other",
    direction: "toward",
  },
  direction: { kind: "direction", direction: "north" },
} satisfies Record<PolicyTarget["kind"], PolicyTarget>;

const SEEDED_WORLDS: { title: string; spec: SimulatorSpec }[] = [
  ...SYSTEMS_AGENTS_LESSONS.flatMap((lesson) =>
    lesson.activities.map((activity) => ({
      title: activity.title,
      spec: activity.simulatorSpec,
    })),
  ),
  ...COOPERATION_CONFLICT_LESSONS.map((lesson) => ({
    title: lesson.activity.title,
    spec: lesson.activity.simulatorSpec,
  })),
];

function kindFromSignature(signature: string): string {
  const parametersStart = signature.indexOf("(");
  return parametersStart === -1 ? signature : signature.slice(0, parametersStart);
}

function noisyPrisonersDilemma(): SimulatorSpec {
  const spec = COOPERATION_CONFLICT_LESSONS.find(
    (lesson) => lesson.activity.title === "Trade through the noise",
  )?.activity.simulatorSpec;
  if (!spec) throw new Error("Missing noisy Prisoner's Dilemma seed");
  return spec;
}

function policyForSlot(slotId: string) {
  return {
    version: 1 as const,
    templateId: "prisonersDilemma" as const,
    slotId,
    rules: [
      {
        id: "answer-apparent-defection",
        when: [
          {
            kind: "last_move" as const,
            actor: "opponent" as const,
            move: "defect" as const,
          },
        ],
        then: {
          kind: "action" as const,
          actionKind: "defect",
          target: { kind: "none" as const },
        },
      },
      {
        id: "cooperate",
        when: [],
        then: {
          kind: "action" as const,
          actionKind: "cooperate",
          target: { kind: "none" as const },
        },
      },
    ],
    default: { kind: "abstain" as const },
  };
}

function catchAllPolicy(
  templateId: SimulatorSpec["templateId"],
  slotId: string,
  actionKind: string,
) {
  return {
    version: 1 as const,
    templateId,
    slotId,
    rules: [
      {
        id: "default-action",
        when: [],
        then: {
          kind: "action" as const,
          actionKind,
          target: { kind: "none" as const },
        },
      },
    ],
    default: { kind: "abstain" as const },
  };
}

async function seedPendingPolicy(
  t: TestHarness,
  spec: SimulatorSpec,
  slotId: string,
): Promise<Id<"compiledPolicies">> {
  const template = getSimulatorTemplate(spec.templateId);
  if (!template) throw new Error(`Unknown template "${spec.templateId}"`);
  const slot = spec.speciesSlots.find((candidate) => candidate.slotId === slotId);
  if (!slot) throw new Error(`Missing slot "${slotId}"`);
  const compileContextHash = await policyCompileContextHash({
    templateId: spec.templateId,
    templateVersion: spec.templateVersion,
    slotId,
    senses: slot.senses,
    actionSchema: template.actionSchema,
  });
  return await t.run((ctx) =>
    ctx.db.insert("compiledPolicies", {
      deckHash: "same-prompt-deck",
      slotId,
      templateId: spec.templateId,
      templateVersion: spec.templateVersion,
      compileContextHash,
      status: "compiling",
      interpreterVersion: POLICY_INTERPRETER_VERSION,
      compilerModelId: "claude-sonnet-5",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

describe("World policy compiler contract", () => {
  beforeEach(() => {
    createModel.mockReset();
  });

  test.each(SEEDED_WORLDS)(
    "$title: every advertised predicate and target round-trips validation",
    ({ spec }) => {
      const template = getSimulatorTemplate(spec.templateId);
      if (!template) throw new Error(`Unknown template "${spec.templateId}"`);

      for (const slot of spec.speciesSlots) {
        const card = { slotId: slot.slotId, prompt: slot.starterHint ?? "Wait." };
        const contract = compilerContract(
          spec,
          card,
          template.actionKinds,
          template.actionSchema,
        );
        const actionKind = template.actionKinds[0];
        if (!actionKind) throw new Error(`${spec.templateId} has no action kinds`);

        const predicateRules = contract.vocabulary.predicates.map(
          (signature, index) => {
            const kind = kindFromSignature(signature) as PolicyPredicate["kind"];
            return {
              id: `predicate-${index}`,
              when: [PREDICATE_EXAMPLES[kind]],
              then: {
                kind: "action" as const,
                actionKind,
                target: { kind: "none" as const },
              },
            };
          },
        );
        const targetRules = contract.vocabulary.targets.map((signature, index) => {
          const kind = kindFromSignature(signature) as PolicyTarget["kind"];
          return {
            id: `target-${index}`,
            when: [],
            then: {
              kind: "action" as const,
              actionKind,
              target: TARGET_EXAMPLES[kind],
            },
          };
        });
        const emission = {
          ...contract.policyHeader,
          rules: [...predicateRules, ...targetRules],
          default: { kind: "abstain" as const },
        };

        expect(
          validateCompilerOutput(emission, {
            templateId: spec.templateId,
            slotId: slot.slotId,
            actionKinds: template.actionKinds,
          }),
        ).toEqual(emission);
      }
    },
  );

  test.each(SEEDED_WORLDS)(
    "$title: every seeded slot completes through the real compile action",
    async ({ spec }) => {
      const t = convexTest(schema, modules);
      const template = getSimulatorTemplate(spec.templateId);
      if (!template) throw new Error(`Unknown template "${spec.templateId}"`);
      const actionKind = template.actionKinds[0];
      if (!actionKind) throw new Error(`${spec.templateId} has no action kinds`);

      for (const slot of spec.speciesSlots) {
        const policyId = await seedPendingPolicy(t, spec, slot.slotId);
        createModel.mockResolvedValueOnce({
          content: [
            {
              type: "tool_use",
              name: "compile_policy",
              input: catchAllPolicy(spec.templateId, slot.slotId, actionKind),
            },
          ],
          usage: { input_tokens: 10, output_tokens: 20 },
        });

        await expect(
          t.action(internal.simulatorPolicyCompiler.compilePolicy, {
            policyId,
            spec: simulatorSpecForStorage(spec),
            card: {
              slotId: slot.slotId,
              prompt: slot.starterHint ?? "Take the default action.",
            },
          }),
        ).resolves.toEqual({ status: "ready" });
        await expect(t.run((ctx) => ctx.db.get(policyId))).resolves.toMatchObject({
          slotId: slot.slotId,
          status: "ready",
          policy: { slotId: slot.slotId },
        });
      }
    },
  );

  test("grows failed-policy retry backoff exponentially and caps it", () => {
    expect(policyCompileRetryDelayMs(0)).toBe(POLICY_COMPILE_RETRY_BASE_MS);
    expect(policyCompileRetryDelayMs(1)).toBe(POLICY_COMPILE_RETRY_BASE_MS);
    expect(policyCompileRetryDelayMs(2)).toBe(
      POLICY_COMPILE_RETRY_BASE_MS * 2,
    );
    expect(policyCompileRetryDelayMs(100)).toBe(POLICY_COMPILE_RETRY_CAP_MS);
  });

  test("stops same-compiler retries at the attempt cap", () => {
    expect(
      shouldRecompileFailedPolicy(
        {
          status: "failed",
          compilerFingerprint: "current",
          compileAttempts: POLICY_COMPILE_MAX_ATTEMPTS,
          updatedAt: 0,
        },
        {
          now: POLICY_COMPILE_RETRY_CAP_MS * 2,
          fingerprint: "current",
        },
      ),
    ).toBe(false);
  });

  test("compiler fingerprint changes retry immediately despite backoff and attempt cap", () => {
    expect(
      shouldRecompileFailedPolicy(
        {
          status: "failed",
          compilerFingerprint: "old",
          compileAttempts: POLICY_COMPILE_MAX_ATTEMPTS,
          updatedAt: 10_000,
        },
        { now: 10_000, fingerprint: "current" },
      ),
    ).toBe(true);
  });

  test("holds fresh same-compiler failures in backoff", () => {
    expect(
      shouldRecompileFailedPolicy(
        {
          status: "failed",
          compilerFingerprint: "current",
          compileAttempts: 1,
          updatedAt: 10_000,
        },
        {
          now: 10_000 + POLICY_COMPILE_RETRY_BASE_MS - 1,
          fingerprint: "current",
        },
      ),
    ).toBe(false);
    expect(
      shouldRecompileFailedPolicy(
        {
          status: "failed",
          compilerFingerprint: "current",
          compileAttempts: 1,
          updatedAt: 10_000,
        },
        {
          now: 10_000 + POLICY_COMPILE_RETRY_BASE_MS,
          fingerprint: "current",
        },
      ),
    ).toBe(true);
  });

  test("restarts compiling policies after a compiler change or stuck timeout", () => {
    expect(
      shouldRestartCompilingPolicy(
        {
          status: "compiling",
          compilerFingerprint: "old",
          updatedAt: 10_000,
        },
        { now: 10_000, fingerprint: "current" },
      ),
    ).toBe(true);
    expect(
      shouldRestartCompilingPolicy(
        {
          status: "compiling",
          compilerFingerprint: "current",
          updatedAt: 10_000,
        },
        {
          now: 10_000 + POLICY_COMPILE_STUCK_TIMEOUT_MS - 1,
          fingerprint: "current",
        },
      ),
    ).toBe(false);
    expect(
      shouldRestartCompilingPolicy(
        {
          status: "compiling",
          compilerFingerprint: "current",
          updatedAt: 10_000,
        },
        {
          now: 10_000 + POLICY_COMPILE_STUCK_TIMEOUT_MS,
          fingerprint: "current",
        },
      ),
    ).toBe(true);
  });

  test("noisy Prisoner's Dilemma advertises a validator-safe policy root", () => {
    const noisy = noisyPrisonersDilemma();
    const template = getSimulatorTemplate(noisy.templateId);
    if (!template) throw new Error(`Unknown template "${noisy.templateId}"`);
    const card = {
      slotId: "trader_ana",
      prompt:
        "Cooperate unless two apparent defections in a row make the decision uncertain.",
    };
    const message = compilerMessage(
      noisy,
      card,
      template.actionKinds,
      template.actionSchema,
    );

    expect(message).toContain('"version":1');
    expect(message).not.toContain("policyIRVersion");
    expect(message).toContain(
      "REFERENCE CONTEXT - DO NOT COPY THESE FIELDS INTO POLICY IR",
    );
    expect(COMPILER_SYSTEM).toContain(
      "Never wrap it under\nparameters, input, policy, or any other field",
    );

    const contract = compilerContract(
      noisy,
      card,
      template.actionKinds,
      template.actionSchema,
    );
    const emission = {
      ...contract.policyHeader,
      rules: [
        {
          id: "uncertain-after-apparent-defection",
          when: [
            {
              kind: "last_move" as const,
              actor: "opponent" as const,
              move: "defect" as const,
            },
          ],
          then: { kind: "abstain" as const },
        },
        {
          id: "cooperate",
          when: [],
          then: {
            kind: "action" as const,
            actionKind: "cooperate",
            target: { kind: "none" as const },
          },
        },
      ],
      default: { kind: "abstain" as const },
    };

    expect(
      validateCompilerOutput(emission, {
        templateId: noisy.templateId,
        slotId: card.slotId,
        actionKinds: template.actionKinds,
      }),
    ).toEqual(emission);
  });

  test("noisy Prisoner's Dilemma compile prompts differ only by requested slot", () => {
    const spec = noisyPrisonersDilemma();
    const template = getSimulatorTemplate(spec.templateId);
    if (!template) throw new Error(`Unknown template "${spec.templateId}"`);
    const anaMessage = compilerMessage(
      spec,
      { slotId: "trader_ana", prompt: NOISY_POLICY_PROMPT },
      template.actionKinds,
      template.actionSchema,
    );
    const benMessage = compilerMessage(
      spec,
      { slotId: "trader_ben", prompt: NOISY_POLICY_PROMPT },
      template.actionKinds,
      template.actionSchema,
    );

    expect(anaMessage).not.toEqual(benMessage);
    expect(anaMessage.replaceAll("trader_ana", "<slot>")).toEqual(
      benMessage.replaceAll("trader_ben", "<slot>"),
    );
  });

  test("real compile action accepts strict and provider-wrapped IR for both noisy slots", async () => {
    const t = convexTest(schema, modules);
    const spec = noisyPrisonersDilemma();
    const anaPolicyId = await seedPendingPolicy(t, spec, "trader_ana");
    const benPolicyId = await seedPendingPolicy(t, spec, "trader_ben");

    createModel
      .mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            name: "compile_policy",
            input: { policy: policyForSlot("trader_ana") },
          },
        ],
        usage: { input_tokens: 10, output_tokens: 20 },
      })
      .mockResolvedValueOnce({
        content: [
          {
            type: "tool_use",
            name: "compile_policy",
            input: policyForSlot("trader_ben"),
          },
        ],
        usage: { input_tokens: 10, output_tokens: 20 },
      });

    await expect(
      t.action(internal.simulatorPolicyCompiler.compilePolicy, {
        policyId: anaPolicyId,
        spec: simulatorSpecForStorage(spec),
        card: { slotId: "trader_ana", prompt: NOISY_POLICY_PROMPT },
      }),
    ).resolves.toEqual({ status: "ready" });
    await expect(
      t.action(internal.simulatorPolicyCompiler.compilePolicy, {
        policyId: benPolicyId,
        spec: simulatorSpecForStorage(spec),
        card: { slotId: "trader_ben", prompt: NOISY_POLICY_PROMPT },
      }),
    ).resolves.toEqual({ status: "ready" });

    const [ana, ben] = await t.run(async (ctx) => [
      await ctx.db.get(anaPolicyId),
      await ctx.db.get(benPolicyId),
    ]);
    expect(ana).toMatchObject({
      slotId: "trader_ana",
      status: "ready",
      policy: { slotId: "trader_ana" },
    });
    expect(ben).toMatchObject({
      slotId: "trader_ben",
      status: "ready",
      policy: { slotId: "trader_ben" },
    });
    expect(createModel).toHaveBeenCalledTimes(2);
  });

  test.each(["parameters", "policy", "policyIR"] as const)(
    "unwraps the observed provider %s envelope without weakening inner validation",
    (wrapper) => {
      const policy = policyForSlot("trader_ana");
      expect(
        validateCompilerOutput(
          { [wrapper]: policy },
          {
            templateId: "prisonersDilemma",
            slotId: "trader_ana",
            actionKinds: ["cooperate", "defect"],
          },
        ),
      ).toEqual(policy);
      expect(() =>
        validateCompilerOutput(
          { [wrapper]: { ...policy, invented: true } },
          {
            templateId: "prisonersDilemma",
            slotId: "trader_ana",
            actionKinds: ["cooperate", "defect"],
          },
        ),
      ).toThrow(/unknown field "invented"/);
      expect(() =>
        validateCompilerOutput(
          { [wrapper]: policy, extra: true },
          {
            templateId: "prisonersDilemma",
            slotId: "trader_ana",
            actionKinds: ["cooperate", "defect"],
          },
        ),
      ).toThrow(/unknown field/);
    },
  );
});
