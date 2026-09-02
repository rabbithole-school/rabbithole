/**
 * Unit tests for the unified session-serving orchestration (lib/practice/serve.ts).
 *
 * Two kinds of coverage:
 *   1. GOLDEN EQUIVALENCE — `serveItems(SESSION_POLICY)` must deep-equal a PINNED
 *      copy of the old inline `practiceSession` serving logic (single-domain and
 *      mixed-domain), run against identical seeded fixtures in the same ctx. This
 *      is the behavior-preservation proof for the U-2 extraction.
 *   2. POLICY KNOBS — each `ServePolicy` knob (laneStamping, formPolicy,
 *      manipulativeGuarantee, firstBlockOrdering, generatedSwapShare) demonstrably
 *      changes serving when toggled off/varied.
 *
 * serveItems reads ONLY `practiceItems` from the DB (mastery is passed as a Map),
 * so the fixtures seed practiceItems and construct the label/mastery/lane maps in
 * memory. Every comparison passes IDENTICAL inputs to both the new and the pinned
 * implementations, so the equivalence is exact.
 */

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../../schema";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import {
  buildSession,
  parseItemId,
  type ServedItem,
} from "../practice/session";
import { isFluent } from "../practice/scheduler";
import {
  MANIPULATIVE_ANSWER_TYPE,
  MANIPULATIVE_VERIFIER_KIND,
} from "../../../lib/manipulative/practiceContract";
import {
  serveItems,
  SESSION_POLICY,
  attachWorkedSteps,
  orderedStoredVariants,
  moveFirstPostPlacementManipulativeFirst,
  type ServeQueueEntry,
  type StoredVariantGroup,
} from "../practice/serve";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../../**/*.ts");

const DOMAIN = "whole-number-arithmetic";

// A width-4 rectangle is the only area-16 solution at perimeter 16.
const areaSpec = {
  kind: "areaPerimeter",
  id: "ap",
  concept: "Area with fixed perimeter",
  prompt: "Fence in exactly 16 square units.",
  perimeter: 16,
  startWidth: 1,
  goal: { type: "areaEquals", value: 16 },
};

/** Seed the practiceItems fixture and return the label/mastery/lane maps + the
 *  queued keys shared by every case. Fluent skill: subtract_within_20 (has a
 *  form variant). Stored word problems on count_to_20 (one with workedSteps) +
 *  count_on; curated manipulatives on count_on (in the take(2) sample) and
 *  cardinality_within_10 (only via the guaranteed second lookup). */
async function seedFixture(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    const stored = (
      skillKey: string,
      stem: string,
      answerCanonical: string,
      extra: Partial<Doc<"practiceItems">> = {},
    ) =>
      ctx.db.insert("practiceItems", {
        skillKey,
        domain: DOMAIN,
        stem,
        answerType: "integer",
        answerCanonical,
        verifierKind: "arithmetic",
        source: "generated",
        verifiedAt: Date.now(),
        ...extra,
      });
    const manip = (skillKey: string) =>
      ctx.db.insert("practiceItems", {
        skillKey,
        domain: DOMAIN,
        stem: areaSpec.prompt,
        answerType: MANIPULATIVE_ANSWER_TYPE,
        answerCanonical: "",
        verifierKind: MANIPULATIVE_VERIFIER_KIND,
        manipulativeSpec: JSON.stringify(areaSpec),
        source: "generated",
        verifiedAt: Date.now(),
      });

    // Insertion order matters: `.take(2)` returns rows in creation order.
    await stored("count_to_20", "A stored word problem", "5", {
      workedSteps: [{ text: "step one" }, { text: "step two", blankText: "?" }],
    });
    await stored("count_to_20", "B stored word problem", "6");
    await stored("count_on", "count-on word problem", "7");
    await manip("count_on");
    // cardinality_within_10: two stored word problems BEFORE its manipulative, so
    // the `.take(2)` sample misses the manip and the guaranteed second lookup is
    // exercised.
    await stored("cardinality_within_10", "cardinality word 1", "3");
    await stored("cardinality_within_10", "cardinality word 2", "4");
    await manip("cardinality_within_10");
  });

  const label = (k: string) => k.replace(/_/g, " ");
  const labelByKey = new Map<string, string>(
    ["subtract_within_20", "count_to_10", "count_to_20", "count_on", "cardinality_within_10"].map(
      (k) => [k, label(k)],
    ),
  );

  const masteryRow = (skillKey: string, repetition: number, source: string): Doc<"practiceMastery"> =>
    ({
      _id: `mastery_${skillKey}` as Id<"practiceMastery">,
      _creationTime: 0,
      scholarId: "scholar" as Id<"users">,
      skillKey,
      domain: DOMAIN,
      repetition,
      halfLifeDays: 10,
      frontier: false,
      source,
      updatedAt: Date.now(),
    }) as Doc<"practiceMastery">;

  const masteryByKey = new Map<string, Doc<"practiceMastery">>([
    // Fluent (accessProven reps ≥ 3 AND a demonstrated "practice" source).
    ["subtract_within_20", masteryRow("subtract_within_20", 5, "practice")],
    ["count_to_20", masteryRow("count_to_20", 1, "practice")],
  ]);

  const laneByKey = new Map<string, "review" | "new" | "challenge">([
    ["subtract_within_20", "review"],
    ["count_to_10", "new"],
    ["count_to_20", "new"],
    ["count_on", "review"],
    ["cardinality_within_10", "new"],
  ]);

  const queueKeys = [
    "subtract_within_20",
    "count_to_10",
    "count_to_20",
    "count_on",
    "cardinality_within_10",
  ];

  return { labelByKey, masteryByKey, laneByKey, queueKeys };
}

// ── PINNED copies of the OLD inline serving logic ───────────────────────────
// Verbatim orchestration from practiceSkills.ts BEFORE the U-2 extraction, using
// the (verbatim-moved) leaf helpers. Used only as the golden reference.

const oldFormFor =
  (mastery: Map<string, Doc<"practiceMastery">>) => (key: string, s: number) => {
    const row = mastery.get(key);
    return row && isFluent(row) && s % 10 < 7 ? "missing" : undefined;
  };

async function oldServeSingle(
  ctx: MutationCtx,
  queueKeys: string[],
  labelOf: Map<string, string>,
  mastery: Map<string, Doc<"practiceMastery">>,
  laneByKey: Map<string, "review" | "new" | "challenge">,
  size: number,
  seed: number,
  firstPostPlacementBlock: boolean,
  calibrationSkillKeys: readonly string[],
): Promise<ServedItem[]> {
  const items = buildSession(
    queueKeys.map((k) => ({ key: k, label: labelOf.get(k) ?? k })),
    size,
    seed >>> 0,
    oldFormFor(mastery),
  );
  const generatedBySkill: StoredVariantGroup[] = [];
  const manipulatives: ServedItem[] = [];
  for (const key of queueKeys) {
    const generatedForSkill: ServedItem[] = [];
    const rows = await ctx.db
      .query("practiceItems")
      .withIndex("by_skill", (qq) => qq.eq("skillKey", key))
      .take(2);
    let sawManipulative = false;
    for (const g of rows) {
      const servedItem: ServedItem = {
        itemId: `gen#${g._id}`,
        skillKey: g.skillKey,
        skillLabel: labelOf.get(g.skillKey) ?? g.skillKey,
        stem: g.stem,
        answerType: g.answerType as ServedItem["answerType"],
        manipulativeSpec: g.manipulativeSpec,
        promptVisual: g.promptVisual,
      };
      attachWorkedSteps(servedItem, g, mastery);
      if (g.verifierKind === MANIPULATIVE_VERIFIER_KIND) {
        manipulatives.push(servedItem);
        sawManipulative = true;
      } else {
        generatedForSkill.push(servedItem);
      }
    }
    generatedBySkill.push({ skillKey: key, variants: generatedForSkill });
    if (!sawManipulative) {
      const manipRows = await ctx.db
        .query("practiceItems")
        .withIndex("by_skill", (qq) => qq.eq("skillKey", key))
        .filter((q) => q.eq(q.field("verifierKind"), MANIPULATIVE_VERIFIER_KIND))
        .take(1);
      for (const g of manipRows) {
        manipulatives.push({
          itemId: `gen#${g._id}`,
          skillKey: g.skillKey,
          skillLabel: labelOf.get(g.skillKey) ?? g.skillKey,
          stem: g.stem,
          answerType: g.answerType as ServedItem["answerType"],
          manipulativeSpec: g.manipulativeSpec,
          promptVisual: g.promptVisual,
        });
      }
    }
  }
  const generated = orderedStoredVariants(generatedBySkill, items);
  let served = items;
  if (items.length === 0) {
    served = [...generated, ...manipulatives].slice(0, size);
  } else if (generated.length > 0) {
    const replaceCount = Math.min(generated.length, Math.max(1, Math.floor(size / 4)));
    for (let i = 0; i < replaceCount; i++) {
      const pos = (i * 3 + 1) % items.length;
      items[pos] = generated[i];
    }
  }
  for (const m of manipulatives) {
    if (served.some((it) => it.itemId === m.itemId)) continue;
    const pos = served.findIndex((it) => it.skillKey === m.skillKey);
    if (pos >= 0) served[pos] = m;
    else if (served.length < size) served.push(m);
  }
  for (const it of served) it.lane = laneByKey.get(it.skillKey) ?? "new";
  if (firstPostPlacementBlock) {
    moveFirstPostPlacementManipulativeFirst(served, calibrationSkillKeys);
  }
  return served;
}

async function oldServeMixed(
  ctx: MutationCtx,
  entries: ServeQueueEntry[],
  labelByKey: Map<string, string>,
  masteryByKey: Map<string, Doc<"practiceMastery">>,
  laneByKey: Map<string, "review" | "new" | "challenge">,
  size: number,
  seed: number,
  firstPostPlacementBlock: boolean,
  calibrationSkillKeys: readonly string[],
): Promise<ServedItem[]> {
  const domainOfKey = new Map<string, string>();
  for (const e of entries) if (!domainOfKey.has(e.key)) domainOfKey.set(e.key, e.domain);
  const items = buildSession(
    entries.map((e) => ({ key: e.key, label: labelByKey.get(e.key) ?? e.key })),
    size,
    seed >>> 0,
    oldFormFor(masteryByKey),
  );
  for (const it of items) it.domain = domainOfKey.get(it.skillKey) ?? it.domain;
  const generatedBySkill: StoredVariantGroup[] = [];
  const manipulatives: ServedItem[] = [];
  for (const e of entries) {
    const key = e.key;
    const generatedForSkill: ServedItem[] = [];
    const rows = await ctx.db
      .query("practiceItems")
      .withIndex("by_skill", (qq) => qq.eq("skillKey", key))
      .take(2);
    let sawManipulative = false;
    for (const g of rows) {
      const servedItem: ServedItem = {
        itemId: `gen#${g._id}`,
        skillKey: g.skillKey,
        skillLabel: labelByKey.get(g.skillKey) ?? g.skillKey,
        domain: e.domain,
        stem: g.stem,
        answerType: g.answerType as ServedItem["answerType"],
        manipulativeSpec: g.manipulativeSpec,
        promptVisual: g.promptVisual,
      };
      attachWorkedSteps(servedItem, g, masteryByKey);
      if (g.verifierKind === MANIPULATIVE_VERIFIER_KIND) {
        manipulatives.push(servedItem);
        sawManipulative = true;
      } else {
        generatedForSkill.push(servedItem);
      }
    }
    generatedBySkill.push({ skillKey: key, variants: generatedForSkill });
    if (!sawManipulative) {
      const manipRows = await ctx.db
        .query("practiceItems")
        .withIndex("by_skill", (qq) => qq.eq("skillKey", key))
        .filter((q) => q.eq(q.field("verifierKind"), MANIPULATIVE_VERIFIER_KIND))
        .take(1);
      for (const g of manipRows) {
        manipulatives.push({
          itemId: `gen#${g._id}`,
          skillKey: g.skillKey,
          skillLabel: labelByKey.get(g.skillKey) ?? g.skillKey,
          domain: e.domain,
          stem: g.stem,
          answerType: g.answerType as ServedItem["answerType"],
          manipulativeSpec: g.manipulativeSpec,
          promptVisual: g.promptVisual,
        });
      }
    }
  }
  const generated = orderedStoredVariants(generatedBySkill, items);
  let served = items;
  if (items.length === 0) {
    served = [...generated, ...manipulatives].slice(0, size);
  } else if (generated.length > 0) {
    const replaceCount = Math.min(generated.length, Math.max(1, Math.floor(size / 4)));
    for (let i = 0; i < replaceCount; i++) {
      const pos = (i * 3 + 1) % items.length;
      items[pos] = generated[i];
    }
  }
  for (const m of manipulatives) {
    if (served.some((it) => it.itemId === m.itemId)) continue;
    const pos = served.findIndex((it) => it.skillKey === m.skillKey);
    if (pos >= 0) served[pos] = m;
    else if (served.length < size) served.push(m);
  }
  for (const it of served) it.lane = laneByKey.get(it.skillKey) ?? "new";
  if (firstPostPlacementBlock) {
    moveFirstPostPlacementManipulativeFirst(served, calibrationSkillKeys);
  }
  return served;
}

// ── Golden equivalence ──────────────────────────────────────────────────────

describe("serveItems(SESSION_POLICY) golden equivalence with the old inline logic", () => {
  test("single-domain (untagged), no first-post-placement block", async () => {
    const t = convexTest(schema, modules);
    const { labelByKey, masteryByKey, laneByKey, queueKeys } = await seedFixture(t);
    const seed = 12345;
    const size = 8;

    await t.run(async (ctx) => {
      const oldServed = await oldServeSingle(
        ctx, queueKeys, labelByKey, masteryByKey, laneByKey, size, seed, false, [],
      );
      const newServed = await serveItems(
        ctx,
        {
          entries: queueKeys.map((k) => ({ key: k, domain: DOMAIN })),
          labelByKey,
          masteryByKey,
          laneByKey,
          seed,
          size,
          stampDomain: false,
          firstPostPlacementBlock: false,
          calibrationSkillKeys: [],
        },
        SESSION_POLICY,
      );
      expect(newServed).toEqual(oldServed);
      // Sanity: the fixture actually exercised stored + manipulative + workedSteps.
      expect(newServed.some((it) => it.itemId.startsWith("gen#"))).toBe(true);
      expect(newServed.some((it) => it.answerType === MANIPULATIVE_ANSWER_TYPE)).toBe(true);
      expect(newServed.every((it) => it.domain === undefined)).toBe(true);
    });
  });

  test("single-domain, first-post-placement block orders a calibration manipulative first", async () => {
    const t = convexTest(schema, modules);
    const { labelByKey, masteryByKey, laneByKey } = await seedFixture(t);
    const seed = 777;
    const size = 4;
    // A controlled queue: count_to_10 (template only) holds the front, and
    // cardinality_within_10's manipulative lands at a later slot — so the block
    // ordering has something to actually move to the front.
    const queueKeys = ["count_to_10", "cardinality_within_10"];
    const calibration = ["cardinality_within_10"];

    await t.run(async (ctx) => {
      const oldServed = await oldServeSingle(
        ctx, queueKeys, labelByKey, masteryByKey, laneByKey, size, seed, true, calibration,
      );
      const newServed = await serveItems(
        ctx,
        {
          entries: queueKeys.map((k) => ({ key: k, domain: DOMAIN })),
          labelByKey,
          masteryByKey,
          laneByKey,
          seed,
          size,
          stampDomain: false,
          firstPostPlacementBlock: true,
          calibrationSkillKeys: calibration,
        },
        SESSION_POLICY,
      );
      expect(newServed).toEqual(oldServed);
      // The block leads with the calibration manipulative.
      expect(newServed[0].answerType).toBe(MANIPULATIVE_ANSWER_TYPE);
      expect(newServed[0].skillKey).toBe("cardinality_within_10");
    });
  });

  test("mixed-domain (domain-tagged) blend", async () => {
    const t = convexTest(schema, modules);
    const { labelByKey, masteryByKey, laneByKey } = await seedFixture(t);
    const seed = 424242;
    const size = 8;
    const entries: ServeQueueEntry[] = [
      { key: "subtract_within_20", domain: "whole-number-arithmetic" },
      { key: "count_to_10", domain: "whole-number-arithmetic" },
      { key: "count_to_20", domain: "whole-number-arithmetic" },
      { key: "count_on", domain: "fraction-arithmetic" },
      { key: "cardinality_within_10", domain: "fraction-arithmetic" },
    ];

    await t.run(async (ctx) => {
      const oldServed = await oldServeMixed(
        ctx, entries, labelByKey, masteryByKey, laneByKey, size, seed, false, [],
      );
      const newServed = await serveItems(
        ctx,
        {
          entries,
          labelByKey,
          masteryByKey,
          laneByKey,
          seed,
          size,
          stampDomain: true,
          firstPostPlacementBlock: false,
          calibrationSkillKeys: [],
        },
        SESSION_POLICY,
      );
      expect(newServed).toEqual(oldServed);
      // Every served item is domain-tagged on the blend.
      expect(newServed.every((it) => typeof it.domain === "string")).toBe(true);
    });
  });
});

// ── Policy knobs ────────────────────────────────────────────────────────────

const baseInput = (
  labelByKey: Map<string, string>,
  masteryByKey: Map<string, Doc<"practiceMastery">>,
  laneByKey: Map<string, "review" | "new" | "challenge">,
  queueKeys: string[],
  overrides: Partial<Parameters<typeof serveItems>[1]> = {},
) => ({
  entries: queueKeys.map((k) => ({ key: k, domain: DOMAIN })),
  labelByKey,
  masteryByKey,
  laneByKey,
  seed: 12345,
  size: 8,
  stampDomain: false,
  firstPostPlacementBlock: false,
  calibrationSkillKeys: [] as string[],
  ...overrides,
});

describe("serveItems policy knobs", () => {
  test("laneStamping: on stamps a lane, off leaves it unset", async () => {
    const t = convexTest(schema, modules);
    const { labelByKey, masteryByKey, laneByKey, queueKeys } = await seedFixture(t);
    await t.run(async (ctx) => {
      const on = await serveItems(ctx, baseInput(labelByKey, masteryByKey, laneByKey, queueKeys), SESSION_POLICY);
      expect(on.every((it) => it.lane !== undefined)).toBe(true);

      const off = await serveItems(
        ctx,
        baseInput(labelByKey, masteryByKey, laneByKey, queueKeys),
        { ...SESSION_POLICY, laneStamping: false },
      );
      expect(off.every((it) => it.lane === undefined)).toBe(true);
    });
  });

  test("formPolicy: fluentRelational enables missing-operand forms; directOnly never does", async () => {
    const t = convexTest(schema, modules);
    const { labelByKey, masteryByKey, laneByKey, queueKeys } = await seedFixture(t);
    await t.run(async (ctx) => {
      // directOnly: no template item ever carries the "#missing" form suffix.
      const direct = await serveItems(
        ctx,
        baseInput(labelByKey, masteryByKey, laneByKey, queueKeys),
        { ...SESSION_POLICY, formPolicy: "directOnly" },
      );
      expect(direct.every((it) => !it.itemId.endsWith("#missing"))).toBe(true);

      // fluentRelational: across a handful of seeds the fluent skill
      // (subtract_within_20, which has a variant) produces at least one missing.
      let sawMissing = false;
      for (const seed of [1, 2, 3, 4, 5, 12345, 777, 424242]) {
        const served = await serveItems(
          ctx,
          baseInput(labelByKey, masteryByKey, laneByKey, queueKeys, { seed }),
          SESSION_POLICY,
        );
        if (served.some((it) => it.itemId.endsWith("#missing"))) {
          sawMissing = true;
          break;
        }
      }
      expect(sawMissing).toBe(true);
    });
  });

  test("structured fact metadata does not expand fluent missing-operand forms", async () => {
    const t = convexTest(schema, modules);
    const newlyStructuredFamilies = [
      "add_within_5",
      "subtract_within_5",
      "add_within_10",
      "subtract_within_10",
      "add_within_20_no_regroup",
      "add_subtract_fluency_within_20",
      "mult_facts_0_1_2_5_10",
    ];
    const masteryRow = (skillKey: string): Doc<"practiceMastery"> =>
      ({
        _id: `mastery_${skillKey}` as Id<"practiceMastery">,
        _creationTime: 0,
        scholarId: "scholar" as Id<"users">,
        skillKey,
        domain: DOMAIN,
        repetition: 5,
        halfLifeDays: 10,
        frontier: false,
        source: "practice",
        updatedAt: Date.now(),
      }) as Doc<"practiceMastery">;
    const serveFamily = async (
      ctx: MutationCtx,
      skillKey: string,
      size: number,
    ) =>
      serveItems(
        ctx,
        {
          entries: [{ key: skillKey, domain: DOMAIN }],
          labelByKey: new Map([[skillKey, skillKey]]),
          masteryByKey: new Map([[skillKey, masteryRow(skillKey)]]),
          laneByKey: new Map([[skillKey, "review" as const]]),
          seed: 12_345,
          size,
          stampDomain: false,
          firstPostPlacementBlock: false,
          calibrationSkillKeys: [],
        },
        SESSION_POLICY,
      );

    await t.run(async (ctx) => {
      for (const skillKey of newlyStructuredFamilies) {
        const served = await serveFamily(ctx, skillKey, 30);
        expect(served).toHaveLength(30);
        expect(
          served.every((item) => !item.itemId.endsWith("#missing")),
          skillKey,
        ).toBe(true);
      }

      const historical = await serveFamily(ctx, "subtract_within_20", 100);
      const missingCount = historical.filter((item) =>
        item.itemId.endsWith("#missing"),
      ).length;
      for (const item of historical) {
        const parsed = parseItemId(item.itemId);
        expect(parsed).not.toBeNull();
        expect(parsed?.form === "missing").toBe(parsed!.seed % 10 < 7);
      }
      expect(missingCount / historical.length).toBeGreaterThan(0.6);
      expect(missingCount / historical.length).toBeLessThan(0.8);
    });
  });

  test("manipulativeGuarantee: on force-serves the curated manipulative; off drops it", async () => {
    const t = convexTest(schema, modules);
    const { labelByKey, masteryByKey, laneByKey } = await seedFixture(t);
    // Controlled queue: cardinality_within_10 alone, size 4 — its slots survive,
    // so the guarantee (second lookup + swap-in) can actually place the manip.
    const queueKeys = ["cardinality_within_10"];
    await t.run(async (ctx) => {
      const on = await serveItems(
        ctx,
        baseInput(labelByKey, masteryByKey, laneByKey, queueKeys, { size: 4 }),
        SESSION_POLICY,
      );
      expect(on.some((it) => it.skillKey === "cardinality_within_10" && it.answerType === MANIPULATIVE_ANSWER_TYPE)).toBe(true);

      const off = await serveItems(
        ctx,
        baseInput(labelByKey, masteryByKey, laneByKey, queueKeys, { size: 4 }),
        { ...SESSION_POLICY, manipulativeGuarantee: false },
      );
      expect(off.some((it) => it.answerType === MANIPULATIVE_ANSWER_TYPE)).toBe(false);
    });
  });

  test("firstBlockOrdering: off leaves order untouched even when a block is active", async () => {
    const t = convexTest(schema, modules);
    const { labelByKey, masteryByKey, laneByKey } = await seedFixture(t);
    const queueKeys = ["count_to_10", "cardinality_within_10"];
    const calibration = ["cardinality_within_10"];
    const input = () =>
      baseInput(labelByKey, masteryByKey, laneByKey, queueKeys, {
        seed: 777,
        size: 4,
        firstPostPlacementBlock: true,
        calibrationSkillKeys: calibration,
      });
    await t.run(async (ctx) => {
      const ordered = await serveItems(ctx, input(), SESSION_POLICY);
      const unordered = await serveItems(ctx, input(), { ...SESSION_POLICY, firstBlockOrdering: false });
      expect(ordered[0].answerType).toBe(MANIPULATIVE_ANSWER_TYPE);
      // With ordering off, the manipulative is served but NOT forced to the front.
      expect(unordered[0].answerType).not.toBe(MANIPULATIVE_ANSWER_TYPE);
      expect(unordered.some((it) => it.answerType === MANIPULATIVE_ANSWER_TYPE)).toBe(true);
    });
  });

  test("generatedSwapShare: a larger share swaps in more stored word problems", async () => {
    const t = convexTest(schema, modules);
    const { labelByKey, masteryByKey, laneByKey, queueKeys } = await seedFixture(t);
    await t.run(async (ctx) => {
      const quarter = await serveItems(
        ctx,
        baseInput(labelByKey, masteryByKey, laneByKey, queueKeys),
        { ...SESSION_POLICY, generatedSwapShare: 1 / 4, manipulativeGuarantee: false },
      );
      const half = await serveItems(
        ctx,
        baseInput(labelByKey, masteryByKey, laneByKey, queueKeys),
        { ...SESSION_POLICY, generatedSwapShare: 1 / 2, manipulativeGuarantee: false },
      );
      const storedCount = (items: ServedItem[]) =>
        items.filter((it) => it.itemId.startsWith("gen#")).length;
      expect(storedCount(half)).toBeGreaterThan(storedCount(quarter));
    });
  });
});
