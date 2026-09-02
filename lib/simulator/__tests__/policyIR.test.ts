import { describe, expect, it } from "vitest";

import {
  MAX_POLICY_PREDICATES_PER_RULE,
  MAX_POLICY_RULES,
  describePolicyRule,
  evaluatePolicy,
  parsePolicyIR,
  policyIRJsonSchemaForTemplate,
  policyPredicateVocabulary,
  type PolicyIR,
} from "../policyIR";
import { canonicalJson, isExactLegalAction } from "../prompt";
import { compilerVocabulary } from "../../../convex/simulatorPolicyCompiler";

const ECOSYSTEM_POLICY: PolicyIR = {
  version: 1,
  templateId: "ecosystemGrid",
  slotId: "grazer",
  rules: [
    {
      id: "graze-now",
      when: [
        { kind: "self_energy", op: "lt", value: 6 },
        { kind: "nearest_resource_distance", op: "eq", value: 0 },
      ],
      then: {
        kind: "action",
        actionKind: "graze",
        target: { kind: "nearest_resource", direction: "toward" },
      },
    },
    {
      id: "seek-food",
      when: [{ kind: "nearest_resource_distance", op: "lte", value: 4 }],
      then: {
        kind: "action",
        actionKind: "move",
        target: { kind: "nearest_resource", direction: "toward" },
      },
    },
  ],
  default: { kind: "abstain" },
};

const ECOSYSTEM_OBSERVATION = {
  self: {
    id: "grazer:1",
    slotId: "grazer",
    x: 1,
    y: 1,
    energy: 4,
    hidden: false,
    terrain: { kind: "shelter" },
  },
  vision: {
    resources: [{ x: 3, y: 1, dx: 2, dy: 0, distance: 2, biomass: 4 }],
    terrain: [
      { kind: "shelter", x: 1, y: 1, dx: 0, dy: 0, distance: 0 },
      { kind: "shallows", x: 3, y: 1, dx: 2, dy: 0, distance: 2 },
    ],
    automata: [],
    boundary: ["north"],
  },
};

describe("World compiled policy IR", () => {
  it("round-trips the bounded validator and rejects vocabulary escapes", () => {
    const parsed = parsePolicyIR(JSON.parse(JSON.stringify(ECOSYSTEM_POLICY)), {
      templateId: "ecosystemGrid",
      slotId: "grazer",
      actionKinds: ["move", "eat", "graze", "hide", "rest", "reproduce", "noop"],
    });
    expect(parsed).toEqual(ECOSYSTEM_POLICY);
    expect(JSON.parse(canonicalJson(parsed))).toEqual(
      JSON.parse(canonicalJson(ECOSYSTEM_POLICY)),
    );

    expect(() =>
      parsePolicyIR({
        ...ECOSYSTEM_POLICY,
        rules: [
          ...ECOSYSTEM_POLICY.rules,
          {
            id: "escape",
            when: [],
            then: {
              kind: "action",
              actionKind: "teleport",
              target: { kind: "none" },
            },
          },
        ],
      }, {
        templateId: "ecosystemGrid",
        slotId: "grazer",
        actionKinds: ["move", "graze", "noop"],
      }),
    ).toThrow(/not declared/);

    expect(() =>
      parsePolicyIR({
        ...ECOSYSTEM_POLICY,
        rules: Array.from({ length: MAX_POLICY_RULES + 1 }, (_, index) => ({
          id: `rule-${index}`,
          when: [],
          then: { kind: "noop" },
        })),
      }),
    ).toThrow(/at most/);

    expect(() =>
      parsePolicyIR({
        ...ECOSYSTEM_POLICY,
        rules: [{
          id: "too-many-guards",
          when: Array.from(
            { length: MAX_POLICY_PREDICATES_PER_RULE + 1 },
            () => ({ kind: "tick", op: "gte", value: 0 }),
          ),
          then: { kind: "noop" },
        }],
      }),
    ).toThrow(/at most/);
  });

  it("evaluates ecosystem rules deterministically and re-intersects the legal set", () => {
    const legal = [
      { kind: "move", to: { x: 1, y: 0 } },
      { kind: "move", to: { x: 2, y: 1 } },
      { kind: "rest" },
      { kind: "noop" },
    ];
    const first = evaluatePolicy(
      ECOSYSTEM_POLICY,
      ECOSYSTEM_OBSERVATION,
      legal,
      2,
      undefined,
      "day",
    );
    const second = evaluatePolicy(
      ECOSYSTEM_POLICY,
      ECOSYSTEM_OBSERVATION,
      legal,
      2,
      undefined,
      "day",
    );
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      kind: "action",
      action: { kind: "move", to: { x: 2, y: 1 } },
      ruleId: "seek-food",
    });

    expect(describePolicyRule(ECOSYSTEM_POLICY.rules[0])).toBe(
      "energy < 6 and nearest food distance = 0 -> graze toward nearest food",
    );

    const malformedPolicy = {
      ...ECOSYSTEM_POLICY,
      rules: [
        {
          id: "illegal-selector",
          when: [],
          then: {
            kind: "action",
            actionKind: "teleport",
            target: { kind: "none" },
          },
        },
      ],
    } as PolicyIR;
    expect(
      evaluatePolicy(
        malformedPolicy,
        ECOSYSTEM_OBSERVATION,
        legal,
        2,
        undefined,
        "day",
      ),
    ).toMatchObject({ kind: "action", action: { kind: "noop" } });
  });

  it("interprets ecosystem terrain predicates and directional targets", () => {
    const terrainPolicy: PolicyIR = {
      version: 1,
      templateId: "ecosystemGrid",
      slotId: "grazer",
      rules: [
        {
          id: "leave-shelter-for-shallows",
          when: [
            { kind: "terrain_here", terrainKind: "shelter" },
            {
              kind: "nearest_terrain",
              terrainKind: "shallows",
              op: "lte",
              value: 3,
            },
          ],
          then: {
            kind: "action",
            actionKind: "move",
            target: {
              kind: "nearest_terrain",
              terrainKind: "shallows",
              direction: "toward",
            },
          },
        },
      ],
      default: { kind: "abstain" },
    };
    expect(parsePolicyIR(terrainPolicy, {
      templateId: "ecosystemGrid",
      slotId: "grazer",
      actionKinds: ["move", "noop"],
    })).toEqual(terrainPolicy);
    expect(
      evaluatePolicy(
        terrainPolicy,
        ECOSYSTEM_OBSERVATION,
        [
          { kind: "move", to: { x: 1, y: 0 } },
          { kind: "move", to: { x: 2, y: 1 } },
          { kind: "noop" },
        ],
        0,
        undefined,
      ),
    ).toMatchObject({
      kind: "action",
      action: { kind: "move", to: { x: 2, y: 1 } },
      ruleId: "leave-shelter-for-shallows",
    });
  });

  it("covers Prisoner's Dilemma history without reading hidden opponent truth", () => {
    const policy: PolicyIR = {
      version: 1,
      templateId: "prisonersDilemma",
      slotId: "deck_a",
      rules: [
        {
          id: "answer-defection",
          when: [{ kind: "last_move", actor: "opponent", move: "defect" }],
          then: {
            kind: "action",
            actionKind: "defect",
            target: { kind: "none" },
          },
        },
        {
          id: "open-cooperate",
          when: [],
          then: {
            kind: "action",
            actionKind: "cooperate",
            target: { kind: "none" },
          },
        },
      ],
      default: { kind: "abstain" },
    };
    const observation = {
      self: { id: "deck_a:1", slotId: "deck_a", totalScore: 3 },
      round: 2,
      roundsRemaining: 8,
      history: [
        {
          round: 1,
          myMove: "cooperate",
          opponentMove: "defect",
          myPayoff: 0,
          cumulativeScore: 0,
        },
      ],
    };
    expect(
      evaluatePolicy(
        policy,
        observation,
        [{ kind: "cooperate" }, { kind: "defect" }],
        1,
        undefined,
        "round 2",
      ),
    ).toMatchObject({ kind: "action", action: { kind: "defect" } });
  });

  it("evaluates matrix action history and public-goods round readings", () => {
    const matrixPolicy: PolicyIR = {
      version: 1,
      templateId: "matrixGame",
      slotId: "row",
      rules: [
        {
          id: "answer-b",
          when: [{ kind: "last_action", actor: "opponent", value: "optionB" }],
          then: {
            kind: "action",
            actionKind: "optionA",
            target: { kind: "none" },
          },
        },
      ],
      default: { kind: "abstain" },
    };
    expect(
      evaluatePolicy(
        matrixPolicy,
        {
          self: { totalScore: 3 },
          roundsRemaining: 2,
          history: [{ myAction: "optionA", opponentAction: "optionB", myPayoff: 3 }],
        },
        [{ kind: "optionA" }, { kind: "optionB" }],
        1,
        undefined,
        "round 2",
      ),
    ).toMatchObject({ kind: "action", action: { kind: "optionA" } });

    const publicGoodsPolicy: PolicyIR = {
      version: 1,
      templateId: "publicGoods",
      slotId: "villager",
      rules: [
        {
          id: "repair-low-pool",
          when: [
            { kind: "perceived_last_contributors", op: "lt", value: 3 },
            { kind: "self_last_payoff", op: "gte", value: 5 },
          ],
          then: {
            kind: "action",
            actionKind: "contribute",
            target: { kind: "none" },
          },
        },
      ],
      default: { kind: "abstain" },
    };
    expect(
      evaluatePolicy(
        publicGoodsPolicy,
        {
          self: { totalScore: 8 },
          roundsRemaining: 2,
          history: [{ contributorCount: 2, myAction: "withhold", myPayoff: 8 }],
        },
        [{ kind: "withhold" }, { kind: "contribute" }],
        1,
        undefined,
        "round 2",
      ),
    ).toMatchObject({ kind: "action", action: { kind: "contribute" } });
  });

  it("enforces template-scoped predicates, targets, and compiler schemas", () => {
    const publicPredicate = {
      kind: "perceived_last_contributors",
      op: "gte",
      value: 3,
    };
    expect(() =>
      parsePolicyIR(
        {
          version: 1,
          templateId: "matrixGame",
          slotId: "row",
          rules: [
            {
              id: "illegal-public-reading",
              when: [publicPredicate],
              then: { kind: "action", actionKind: "optionA", target: { kind: "none" } },
            },
          ],
          default: { kind: "abstain" },
        },
        {
          templateId: "matrixGame",
          slotId: "row",
          actionKinds: ["optionA", "optionB"],
        },
      ),
    ).toThrow(/not declared by this template/);
    expect(() =>
      parsePolicyIR(
        {
          version: 1,
          templateId: "publicGoods",
          slotId: "villager",
          rules: [
            {
              id: "illegal-target",
              when: [],
              then: {
                kind: "action",
                actionKind: "contribute",
                target: { kind: "nearest_resource", direction: "toward" },
              },
            },
          ],
          default: { kind: "abstain" },
        },
        {
          templateId: "publicGoods",
          slotId: "villager",
          actionKinds: ["withhold", "contribute"],
        },
      ),
    ).toThrow(/target.*not declared/);
    expect(() =>
      parsePolicyIR(
        {
          version: 1,
          templateId: "publicGoods",
          slotId: "villager",
          rules: [
            {
              id: "illegal-terrain-reading",
              when: [{ kind: "terrain_here", terrainKind: "shelter" }],
              then: { kind: "action", actionKind: "contribute", target: { kind: "none" } },
            },
          ],
          default: { kind: "abstain" },
        },
        {
          templateId: "publicGoods",
          slotId: "villager",
          actionKinds: ["withhold", "contribute"],
        },
      ),
    ).toThrow(/not declared by this template/);

    expect(policyPredicateVocabulary("matrixGame")).toContain("last_action");
    expect(policyPredicateVocabulary("matrixGame")).not.toContain(
      "perceived_last_contributors",
    );
    const matrixSchema = policyIRJsonSchemaForTemplate("matrixGame");
    expect(matrixSchema.properties.templateId).toEqual({
      type: "string",
      const: "matrixGame",
    });
    const rules = matrixSchema.properties.rules as {
      items: {
        properties: {
          when: {
            items: {
              oneOf: Array<{ properties?: { kind?: { const?: string } } }>;
            };
          };
        };
      };
    };
    const schemaKinds = rules.items.properties.when.items.oneOf.map(
      (variant) => variant.properties?.kind?.const,
    );
    expect(schemaKinds).toContain("last_action");
    expect(schemaKinds).not.toContain("perceived_last_contributors");
    expect(schemaKinds).not.toContain("last_move");
    const ecosystemSchema = policyIRJsonSchemaForTemplate("ecosystemGrid");
    const ecosystemRules = ecosystemSchema.properties.rules as typeof rules;
    const ecosystemKinds =
      ecosystemRules.items.properties.when.items.oneOf.map(
        (variant) => variant.properties?.kind?.const,
      );
    expect(ecosystemKinds).toEqual(
      expect.arrayContaining(["terrain_here", "nearest_terrain"]),
    );
    expect(compilerVocabulary("ecosystemGrid")).toMatchObject({
      predicates: expect.arrayContaining([
        "terrain_here(kind)",
        "nearest_terrain(kind,op,value)",
      ]),
      targets: expect.arrayContaining(["nearest_terrain(kind,toward|away)"]),
    });
    expect(compilerVocabulary("publicGoods").predicates).not.toContain(
      "terrain_here(kind)",
    );
  });

  it("never emits outside the current legal set, noop, or abstain", () => {
    let state = 0x1a2b3c4d;
    const random = () => {
      state = (1664525 * state + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    const actionKinds = ["move", "graze", "rest", "hide", "noop"] as const;
    for (let sample = 0; sample < 500; sample += 1) {
      const legal = Array.from(
        { length: Math.floor(random() * 6) },
        (_, index) => {
          const kind = actionKinds[Math.floor(random() * actionKinds.length)];
          return kind === "move"
            ? { kind, to: { x: index, y: Math.floor(random() * 4) } }
            : { kind };
        },
      );
      const policy: PolicyIR = {
        version: 1,
        templateId: "ecosystemGrid",
        slotId: "random",
        rules: [
          {
            id: "random-rule",
            when: [
              {
                kind: "self_energy",
                op: random() > 0.5 ? "gte" : "lt",
                value: Math.floor(random() * 10),
              },
            ],
            then: {
              kind: "action",
              actionKind:
                actionKinds[Math.floor(random() * actionKinds.length)],
              target: { kind: "none" },
            },
          },
        ],
        default: { kind: "abstain" },
      };
      const result = evaluatePolicy(
        policy,
        { self: { energy: Math.floor(random() * 10) } },
        legal.length > 0 ? legal : [{ kind: "noop" }],
        sample,
        undefined,
        sample % 2 === 0 ? "day" : "night",
      );
      if (result.kind === "abstain") continue;
      expect(
        isExactLegalAction(
          result.action,
          legal.length > 0 ? legal : [{ kind: "noop" }],
        ),
      ).toBe(true);
    }
  });

  it("fails closed when a template exposes no legal actions", () => {
    expect(() =>
      evaluatePolicy(
        {
          ...ECOSYSTEM_POLICY,
          rules: [{ id: "wait", when: [], then: { kind: "noop" } }],
        },
        ECOSYSTEM_OBSERVATION,
        [],
        0,
        undefined,
        "day",
      ),
    ).toThrow("World template produced no valid legal action");
  });
});
