import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { hasTemplate } from "../lib/practice/templates";

const modules = (import.meta as ImportMeta & { glob: (p: string) => Record<string, () => Promise<unknown>> }).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: string,
  username: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: `Test ${role}`, username, role }),
  );
}

async function asUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 3_600_000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

/** A gradable partition-manipulative spec (mirrors the seed fixture). */
const GRADABLE_SPEC = JSON.stringify({
  kind: "partition",
  id: "test-make-half",
  concept: "Equivalent fractions",
  prompt: "Make one half.",
  discs: [{ parts: 4, shaded: 1 }],
  adjustable: ["parts", "shaded"],
  partsRange: [2, 12],
  goal: { type: "shadedFractionEquals", disc: 0, value: 0.5 },
});

describe("practiceItemPool — reads", () => {
  test("manipulativeKindUsage reads and returns only manipulative rows", async () => {
    // No graph nodes are needed for this query's kind tally. Its one-document
    // budget is the storage-read proof: same- and other-domain non-manipulative
    // rows would make the pre-index domain scans exceed it.
    const t = convexTest({ schema, modules, transactionLimits: { documentsRead: 1 } });
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceItems", {
        skillKey: "target_manipulative",
        domain: "whole-number-arithmetic",
        stem: "Make one half.",
        answerType: "manipulative",
        answerCanonical: "",
        verifierKind: "manipulative",
        manipulativeSpec: GRADABLE_SPEC,
        source: "generated",
        verifiedAt: Date.now(),
      });
      await ctx.db.insert("practiceItems", {
        skillKey: "same_domain_arithmetic",
        domain: "whole-number-arithmetic",
        stem: "2 + 3",
        answerType: "integer",
        answerCanonical: "5",
        verifierKind: "arithmetic",
        source: "generated",
        verifiedAt: Date.now(),
      });
      await ctx.db.insert("practiceItems", {
        skillKey: "other_domain_dialogue",
        domain: "fraction-arithmetic",
        stem: "Explain one half.",
        answerType: "dialogue",
        answerCanonical: "",
        verifierKind: "rubric_dialogue",
        source: "generated",
        verifiedAt: Date.now(),
      });
    });

    const usage = await t.query(internal.practiceItemPool.manipulativeKindUsageInternal, {});
    const attributedCount = usage.byKind.reduce((count, kind) => count + kind.itemCount, 0);

    expect(attributedCount).toBe(1);
    expect(usage.byKind.find((kind) => kind.kind === "partition")).toMatchObject({
      itemCount: 1,
      skillCount: 1,
      skills: [{ skillKey: "target_manipulative", label: "target_manipulative", count: 1 }],
    });
    expect(usage.unparseableCount).toBe(0);
  });

  test("poolForNode: null for unknown node; template previews + stored items for a real one", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const teacher = await seedUser(t, "teacher", "pool-teacher");
    const asTeacher = await asUser(t, teacher);

    expect(await asTeacher.query(api.practiceItemPool.poolForNode, { nodeKey: "no_such_node" })).toBeNull();

    // count_to_10 is the whole-number-arithmetic root and is templated.
    expect(hasTemplate("count_to_10")).toBe(true);
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceItems", {
        skillKey: "count_to_10",
        domain: "whole-number-arithmetic",
        stem: "How many stars? ⭐⭐⭐",
        answerType: "integer",
        answerCanonical: "3",
        verifierKind: "arithmetic",
        source: "generated",
        model: "test-model",
        verifiedAt: Date.now(),
      });
    });

    const pool = await asTeacher.query(api.practiceItemPool.poolForNode, { nodeKey: "count_to_10" });
    expect(pool).not.toBeNull();
    expect(pool!.hasTemplate).toBe(true);
    expect(pool!.templatePreviews.length).toBeGreaterThan(0);
    // Previews carry stems AND answers (staff-facing read).
    for (const p of pool!.templatePreviews) {
      expect(p.stem.length).toBeGreaterThan(0);
      expect(p.answer.length).toBeGreaterThan(0);
    }
    expect(pool!.items).toHaveLength(1);
    expect(pool!.items[0].answer).toBe("3");
    expect(pool!.node.domain).toBe("whole-number-arithmetic");

    const domainItems = await asTeacher.query(api.practiceItemPool.itemsForDomain, {
      domain: "whole-number-arithmetic",
    });
    const countItems = domainItems.filter((item) => item.skillKey === "count_to_10");
    expect(countItems).toHaveLength(1);
    expect(countItems[0]).toMatchObject({
      skillKey: "count_to_10",
      skillLabel: pool!.node.label,
      answer: "3",
      verifierKind: "arithmetic",
    });
  });

  test("poolSummary: reports per-node and per-strand content coverage", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const teacher = await seedUser(t, "teacher", "pool-teacher2");
    const asTeacher = await asUser(t, teacher);

    // Baseline BEFORE this test's own inserts: seedGraph absorbs the story
    // registry, whose application questions land in the pool as stretch items,
    // so count assertions below are deltas — pinning absolute numbers here
    // re-breaks this test every time a registry batch ships.
    const before = await asTeacher.query(api.practiceItemPool.poolSummary, {
      domain: "fraction-arithmetic",
    });
    const beforePartition = before.nodes.find(
      (n) => n.nodeKey === "partition_shapes",
    );
    const beforePartitionStrand = before.strandRollups.find(
      (rollup) => rollup.strand === beforePartition?.strand,
    );

    await t.run(async (ctx) => {
      await ctx.db.insert("practiceItems", {
        skillKey: "partition_shapes",
        domain: "fraction-arithmetic",
        stem: "Make one half.",
        answerType: "manipulative",
        answerCanonical: "",
        verifierKind: "manipulative",
        manipulativeSpec: GRADABLE_SPEC,
        source: "generated",
        verifiedAt: Date.now(),
      });
      await ctx.db.insert("practiceItems", {
        skillKey: "partition_shapes",
        domain: "fraction-arithmetic",
        stem: "A fraction puzzle that takes an idea.",
        answerType: "fraction",
        answerCanonical: "1/2",
        verifierKind: "arithmetic",
        tier: "stretch",
        technique: "structure",
        source: "authored",
        verifiedAt: Date.now(),
      });
      await ctx.db.insert("practiceItems", {
        skillKey: "unit_fraction",
        domain: "fraction-arithmetic",
        stem: "Explain a unit fraction.",
        answerType: "dialogue",
        answerCanonical: "",
        verifierKind: "rubric_dialogue",
        tier: "stretch",
        technique: "multiple_paths",
        source: "authored",
        verifiedAt: Date.now(),
      });
    });

    const summary = await asTeacher.query(api.practiceItemPool.poolSummary, {
      domain: "fraction-arithmetic",
    });
    expect(summary.nodes.length).toBeGreaterThan(0);
    const partition = summary.nodes.find((n) => n.nodeKey === "partition_shapes")!;
    expect(partition.hasManipulative).toBe(true);
    expect(partition.manipulativeCount).toBe(
      (beforePartition?.manipulativeCount ?? 0) + 1,
    );
    expect(partition.hasStretch).toBe(true);
    expect(partition.stretchCount).toBe((beforePartition?.stretchCount ?? 0) + 1);
    expect(partition.itemCount).toBe(beforePartition?.itemCount ?? 0);
    expect(partition.serveable).toBe(true);
    // Dialogue stretch rows without a rubric cannot reach the scholar-facing
    // Go deeper tail, so they do not count as coverage.
    const invalidDialogue = summary.nodes.find((n) => n.nodeKey === "unit_fraction")!;
    expect(invalidDialogue.hasStretch).toBe(false);
    expect(invalidDialogue.stretchCount).toBe(0);

    const partitionStrand = summary.strandRollups.find(
      (rollup) => rollup.strand === partition.strand,
    )!;
    expect(partitionStrand.totalNodes).toBe(
      summary.nodes.filter((node) => node.strand === partition.strand).length,
    );
    // Special-tier rows are tracked by stretch coverage, not core stored-item coverage.
    expect(partitionStrand.storedItemNodeCount).toBe(
      beforePartitionStrand?.storedItemNodeCount ?? 0,
    );
    expect(partitionStrand.storedItemCount).toBe(
      beforePartitionStrand?.storedItemCount ?? 0,
    );
    expect(partitionStrand.manipulativeNodeCount).toBe(
      (beforePartitionStrand?.manipulativeNodeCount ?? 0) + 1,
    );
    expect(partitionStrand.manipulativeCount).toBe(
      (beforePartitionStrand?.manipulativeCount ?? 0) + 1,
    );
    expect(partitionStrand.stretchCount).toBe(
      (beforePartitionStrand?.stretchCount ?? 0) + 1,
    );
    // partition_shapes may already carry registry stretch coverage, so the
    // node-count either stays flat (node already counted) or grows by one.
    expect(partitionStrand.stretchNodeCount).toBeGreaterThanOrEqual(
      beforePartitionStrand?.stretchNodeCount ?? 0,
    );
    expect(partitionStrand.stretchNodeCount).toBeLessThanOrEqual(
      (beforePartitionStrand?.stretchNodeCount ?? 0) + 1,
    );
    // A conceptual (untemplated) node with no stored items is an explicit hole.
    const unserveable = summary.nodes.filter((n) => !n.serveable);
    for (const n of unserveable) expect(n.hasTemplate).toBe(false);
  });

  test("poolForNode: targeted rehearsal excludes stretch-only items", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const teacher = await seedUser(t, "teacher", "stretch-only-pool-teacher");
    const asTeacher = await asUser(t, teacher);

    expect(hasTemplate("fraction_as_parts")).toBe(false);
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceItems", {
        skillKey: "fraction_as_parts",
        domain: "fraction-arithmetic",
        stem: "A stretch-only unit fraction puzzle.",
        answerType: "fraction",
        answerCanonical: "1/3",
        verifierKind: "arithmetic",
        tier: "stretch",
        technique: "structure",
        source: "authored",
        verifiedAt: Date.now(),
      });
    });

    let pool = await asTeacher.query(api.practiceItemPool.poolForNode, {
      nodeKey: "fraction_as_parts",
    });
    expect(pool!.practiceServeable).toBe(false);

    await t.run(async (ctx) => {
      await ctx.db.insert("practiceItems", {
        skillKey: "fraction_as_parts",
        domain: "fraction-arithmetic",
        stem: "What fraction of six equal parts is one part?",
        answerType: "fraction",
        answerCanonical: "1/6",
        verifierKind: "arithmetic",
        source: "authored",
        verifiedAt: Date.now(),
      });
    });
    pool = await asTeacher.query(api.practiceItemPool.poolForNode, {
      nodeKey: "fraction_as_parts",
    });
    expect(pool!.practiceServeable).toBe(true);

    await t.run(async (ctx) => {
      await ctx.db.insert("practiceItems", {
        skillKey: "fraction_as_parts",
        domain: "fraction-arithmetic",
        stem: "A second stretch-only unit fraction puzzle.",
        answerType: "fraction",
        answerCanonical: "1/4",
        verifierKind: "arithmetic",
        tier: "stretch",
        technique: "structure",
        source: "authored",
        verifiedAt: Date.now(),
      });
    });
    pool = await asTeacher.query(api.practiceItemPool.poolForNode, {
      nodeKey: "fraction_as_parts",
    });
    expect(pool!.practiceServeable).toBe(true);

    const summary = await asTeacher.query(api.practiceItemPool.poolSummary, {
      domain: "fraction-arithmetic",
    });
    const row = summary.nodes.find((node) => node.nodeKey === "fraction_as_parts")!;
    expect(row.itemCount).toBe(1);
    expect(row.serveable).toBe(true);
    expect(row.stretchCount).toBe(2);
  });

  test("gates: a scholar cannot read the pool (answers included) or write items", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedUser(t, "scholar", "pool-scholar");
    const asScholar = await asUser(t, scholar);

    await expect(
      asScholar.query(api.practiceItemPool.poolForNode, { nodeKey: "count_to_10" }),
    ).rejects.toThrow();
    await expect(
      asScholar.query(api.practiceItemPool.poolSummary, { domain: "whole-number-arithmetic" }),
    ).rejects.toThrow();
    await expect(
      asScholar.query(api.practiceItemPool.itemsForDomain, {
        domain: "whole-number-arithmetic",
      }),
    ).rejects.toThrow();
    await expect(
      asScholar.mutation(api.practiceItemPool.createItem, {
        nodeKey: "count_to_10",
        stem: "2+2?",
        answerType: "integer",
        answer: "4",
      }),
    ).rejects.toThrow();
    await expect(
      asScholar.action(api.practiceItemPool.generateForNode, { nodeKey: "count_to_10" }),
    ).rejects.toThrow();
  });

  test("curriculum_designer passes the gate (design-side surface)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const designer = await seedUser(t, "curriculum_designer", "pool-designer");
    const asDesigner = await asUser(t, designer);
    const pool = await asDesigner.query(api.practiceItemPool.poolForNode, { nodeKey: "count_to_10" });
    expect(pool).not.toBeNull();
    await expect(
      asDesigner.query(api.practiceItemPool.itemsForDomain, {
        domain: "whole-number-arithmetic",
      }),
    ).resolves.toBeDefined();
  });
});

describe("practiceItemPool — authoring", () => {
  test("createItem validates + normalizes the answer; bad answers are refused", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const teacher = await seedUser(t, "teacher", "author-teacher");
    const asTeacher = await asUser(t, teacher);

    // Unknown node refused.
    await expect(
      asTeacher.mutation(api.practiceItemPool.createItem, {
        nodeKey: "nope",
        stem: "x",
        answerType: "integer",
        answer: "1",
      }),
    ).rejects.toThrow(/Unknown knowledge node/);

    // Garbage answer refused.
    await expect(
      asTeacher.mutation(api.practiceItemPool.createItem, {
        nodeKey: "count_to_10",
        stem: "How many?",
        answerType: "integer",
        answer: "banana",
      }),
    ).rejects.toThrow(/isn't a valid integer/);

    // Unsupported answer type refused.
    await expect(
      asTeacher.mutation(api.practiceItemPool.createItem, {
        nodeKey: "count_to_10",
        stem: "Pick one",
        answerType: "multipleChoice",
        answer: "0",
      }),
    ).rejects.toThrow(/Answer type/);

    // Good fraction: stored canonically reduced ("6/8" → "3/4"), source "authored".
    await asTeacher.mutation(api.practiceItemPool.createItem, {
      nodeKey: "count_to_10",
      stem: "Share 6 cookies among 8 kids — how much each?",
      answerType: "fraction",
      answer: "6/8",
    });
    const pool = await asTeacher.query(api.practiceItemPool.poolForNode, { nodeKey: "count_to_10" });
    expect(pool!.items).toHaveLength(1);
    expect(pool!.items[0].answer).toBe("3/4");
    expect(pool!.items[0].source).toBe("authored");
    // No unit was authored — ItemView reports it as null (the default,
    // value-only-graded case), never undefined or "".
    expect(pool!.items[0].answerUnit).toBeNull();
    // Node domain stamped from the graph, not caller-supplied.
    await t.run(async (ctx) => {
      const row = await ctx.db.get(pool!.items[0].id);
      expect(row!.domain).toBe("whole-number-arithmetic");
    });
  });

  test("an authored answerUnit is enforced by the real scholar-facing grader", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const teacher = await seedUser(t, "teacher", "unit-teacher");
    const scholar = await seedUser(t, "scholar", "unit-scholar");
    const asTeacher = await asUser(t, teacher);
    const asScholar = await asUser(t, scholar);

    const STEM = "A crate's volume is 112cm³. Enter that volume.";

    // A unit the registry doesn't know is refused, legibly.
    await expect(
      asTeacher.mutation(api.practiceItemPool.createItem, {
        nodeKey: "count_to_10",
        stem: STEM,
        answerType: "integer",
        answer: "112",
        answerUnit: "furlongs",
      }),
    ).rejects.toThrow(/isn't a unit the grader knows/);

    // A unit the STEM never asks for is refused — it would mark a correct
    // bare answer wrong.
    await expect(
      asTeacher.mutation(api.practiceItemPool.createItem, {
        nodeKey: "count_to_10",
        stem: "Maya packs 6 boxes with 7 shells each. How many shells?",
        answerType: "integer",
        answer: "42",
        answerUnit: "cm³",
      }),
    ).rejects.toThrow(/never asks for cm³/);

    // A digit-plus-unit suffix inside a larger identifier is not the stem naming
    // that unit.
    await expect(
      asTeacher.mutation(api.practiceItemPool.createItem, {
        nodeKey: "count_to_10",
        stem: "The sample code is x8m.",
        answerType: "integer",
        answer: "8",
        answerUnit: "m",
      }),
    ).rejects.toThrow(/never asks for m/);
    await expect(
      asTeacher.mutation(api.practiceItemPool.createItem, {
        nodeKey: "count_to_10",
        stem: "The sample code is x_8m.",
        answerType: "integer",
        answer: "8",
        answerUnit: "m",
      }),
    ).rejects.toThrow(/never asks for m/);
    await expect(
      asTeacher.mutation(api.practiceItemPool.createItem, {
        nodeKey: "count_to_10",
        stem: "The value is 1e-3m.",
        answerType: "decimal",
        answer: "0.001",
        answerUnit: "m",
      }),
    ).rejects.toThrow(/never asks for m/);

    // Authored as a written phrase; stored as the canonical display glyph.
    await asTeacher.mutation(api.practiceItemPool.createItem, {
      nodeKey: "count_to_10",
      stem: STEM,
      answerType: "integer",
      answer: "112",
      answerUnit: "cubic centimeters",
    });
    const pool = await asTeacher.query(api.practiceItemPool.poolForNode, { nodeKey: "count_to_10" });
    const itemId = pool!.items[0].id;
    await t.run(async (ctx) => {
      expect((await ctx.db.get(itemId))!.answerUnit).toBe("cm³");
    });
    // ItemView (what the pool UI renders) round-trips the same canonical unit.
    expect(pool!.items[0].answerUnit).toBe("cm³");

    // The scholar-facing grader now needs value AND unit.
    const bare = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: `gen#${itemId}`,
      answer: "112",
    });
    expect(bare.correct).toBe(false);
    const wrongUnit = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: `gen#${itemId}`,
      answer: "112 cm²",
    });
    expect(wrongUnit.correct).toBe(false);
    const full = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: `gen#${itemId}`,
      answer: "112 cm³",
    });
    expect(full.correct).toBe(true);

    // "" clears the requirement — back to value-only grading.
    await asTeacher.mutation(api.practiceItemPool.updateItem, { id: itemId, answerUnit: "" });
    await t.run(async (ctx) => {
      expect((await ctx.db.get(itemId))!.answerUnit).toBeUndefined();
    });
    const clearedPool = await asTeacher.query(api.practiceItemPool.poolForNode, {
      nodeKey: "count_to_10",
    });
    expect(clearedPool!.items[0].answerUnit).toBeNull();
    const cleared = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: `gen#${itemId}`,
      answer: "112",
    });
    expect(cleared.correct).toBe(true);
  });

  test("updateItem edits are live in grading (submitAnswer grades against the NEW answer)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const teacher = await seedUser(t, "teacher", "edit-teacher");
    const scholar = await seedUser(t, "scholar", "edit-scholar");
    const asTeacher = await asUser(t, teacher);
    const asScholar = await asUser(t, scholar);

    await asTeacher.mutation(api.practiceItemPool.createItem, {
      nodeKey: "count_to_10",
      stem: "How many fingers on one hand?",
      answerType: "integer",
      answer: "5",
    });
    const pool = await asTeacher.query(api.practiceItemPool.poolForNode, { nodeKey: "count_to_10" });
    const itemId = pool!.items[0].id;

    // Teacher fixes the item (new stem + answer).
    await asTeacher.mutation(api.practiceItemPool.updateItem, {
      id: itemId,
      stem: "How many fingers on two hands?",
      answer: "10",
    });

    // The scholar-facing grader now accepts the NEW answer for the stored item.
    const wrong = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: `gen#${itemId}`,
      answer: "5",
    });
    expect(wrong.correct).toBe(false);
    const right = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: `gen#${itemId}`,
      answer: "10",
    });
    expect(right.correct).toBe(true);
  });

  test("manipulative items: answer edits refused, ungradable spec refused, gradable spec saved", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const teacher = await seedUser(t, "teacher", "manip-teacher");
    const asTeacher = await asUser(t, teacher);

    const created = await asTeacher.mutation(api.practiceItemPool.createItem, {
      nodeKey: "partition_shapes",
      manipulativeSpec: GRADABLE_SPEC,
    });
    expect(created.kind).toBe("manipulative");
    const id = created.id;

    // No answer string on a manipulative.
    await expect(
      asTeacher.mutation(api.practiceItemPool.updateItem, { id, answer: "1/2" }),
    ).rejects.toThrow(/no answer string/);

    // An ungradable spec (no goal) must never persist.
    const ungradable = JSON.stringify({ ...JSON.parse(GRADABLE_SPEC), goal: undefined });
    await expect(
      asTeacher.mutation(api.practiceItemPool.updateItem, { id, manipulativeSpec: ungradable }),
    ).rejects.toThrow();

    // A valid edit updates spec + stem and re-marks provenance.
    const edited = JSON.stringify({ ...JSON.parse(GRADABLE_SPEC), prompt: "Shade exactly half." });
    await asTeacher.mutation(api.practiceItemPool.updateItem, { id, manipulativeSpec: edited });
    const pool = await asTeacher.query(api.practiceItemPool.poolForNode, { nodeKey: "partition_shapes" });
    const item = pool!.items.find((it) => it.id === id)!;
    expect(item.stem).toBe("Shade exactly half.");
    expect(item.source).toBe("authored");
  });

  test("a structurally-invalid manipulative spec (gradable goal, missing renderer fields) is refused", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const teacher = await seedUser(t, "teacher", "smoke-teacher");
    const asTeacher = await asUser(t, teacher);

    // Goal shape passes the gradability check, but there are no `discs` — the
    // scholar renderer's initialPartition(spec).discs.map would crash on mount.
    const noDiscs = JSON.stringify({
      kind: "partition",
      id: "broken",
      concept: "x",
      prompt: "Make one half.",
      goal: { type: "discsEqualShadedArea" },
    });
    await expect(
      asTeacher.mutation(api.practiceItemPool.createItem, {
        nodeKey: "partition_shapes",
        manipulativeSpec: noDiscs,
      }),
    ).rejects.toThrow(/renderer/);

    // Empty prompt refused too (it's the item stem every surface shows).
    const noPrompt = JSON.stringify({ ...JSON.parse(GRADABLE_SPEC), prompt: "  " });
    await expect(
      asTeacher.mutation(api.practiceItemPool.createItem, {
        nodeKey: "partition_shapes",
        manipulativeSpec: noPrompt,
      }),
    ).rejects.toThrow(/prompt/);
  });

  test("storeGeneratedItems replace clears word items but PRESERVES manipulatives", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceItems", {
        skillKey: "partition_shapes",
        domain: "fraction-arithmetic",
        stem: "old word item",
        answerType: "integer",
        answerCanonical: "1",
        verifierKind: "arithmetic",
        source: "generated",
        verifiedAt: Date.now(),
      });
      await ctx.db.insert("practiceItems", {
        skillKey: "partition_shapes",
        domain: "fraction-arithmetic",
        stem: "Make one half.",
        answerType: "manipulative",
        answerCanonical: "",
        verifierKind: "manipulative",
        manipulativeSpec: GRADABLE_SPEC,
        source: "authored",
        verifiedAt: Date.now(),
      });
    });

    await t.mutation(internal.practiceSkills.storeGeneratedItems, {
      skillKey: "partition_shapes",
      replace: true,
      items: [
        {
          skillKey: "partition_shapes",
          domain: "fraction-arithmetic",
          stem: "new word item",
          answerType: "integer",
          answerCanonical: "2",
          verifierKind: "arithmetic",
        },
      ],
    });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("practiceItems")
        .withIndex("by_skill", (q) => q.eq("skillKey", "partition_shapes"))
        .collect(),
    );
    const stems = rows.map((r) => r.stem).sort();
    expect(stems).toEqual(["Make one half.", "new word item"]);
  });

  test("deleteItem removes the row", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const teacher = await seedUser(t, "teacher", "del-teacher");
    const asTeacher = await asUser(t, teacher);

    await asTeacher.mutation(api.practiceItemPool.createItem, {
      nodeKey: "count_to_10",
      stem: "2 + 2?",
      answerType: "integer",
      answer: "4",
    });
    const pool = await asTeacher.query(api.practiceItemPool.poolForNode, { nodeKey: "count_to_10" });
    await asTeacher.mutation(api.practiceItemPool.deleteItem, { id: pool!.items[0].id });
    const after = await asTeacher.query(api.practiceItemPool.poolForNode, { nodeKey: "count_to_10" });
    expect(after!.items).toHaveLength(0);
  });

  test("createItem: a valid manipulative spec is accepted through the public mutation; an invalid one is rejected", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const teacher = await seedUser(t, "teacher", "manip-create-teacher");
    const asTeacher = await asUser(t, teacher);

    // Valid, gradable spec — accepted, stamped with the manipulative
    // answerType/verifierKind contract, stem derived from the spec's prompt.
    const created = await asTeacher.mutation(api.practiceItemPool.createItem, {
      nodeKey: "partition_shapes",
      manipulativeSpec: GRADABLE_SPEC,
    });
    expect(created.kind).toBe("manipulative");
    const pool = await asTeacher.query(api.practiceItemPool.poolForNode, { nodeKey: "partition_shapes" });
    const row = pool!.items.find((it) => it.id === created.id)!;
    expect(row.verifierKind).toBe("manipulative");
    expect(row.answerType).toBe("manipulative");
    expect(row.stem).toBe("Make one half.");
    expect(row.manipulativeSpec).not.toBeNull();

    // Invalid JSON — refused before any gradability check runs.
    await expect(
      asTeacher.mutation(api.practiceItemPool.createItem, {
        nodeKey: "partition_shapes",
        manipulativeSpec: "{not json",
      }),
    ).rejects.toThrow(/valid JSON/);

    // Well-formed JSON but no usable goal — refused (ungradable).
    const ungradable = JSON.stringify({ ...JSON.parse(GRADABLE_SPEC), goal: undefined });
    await expect(
      asTeacher.mutation(api.practiceItemPool.createItem, {
        nodeKey: "partition_shapes",
        manipulativeSpec: ungradable,
      }),
    ).rejects.toThrow(/Ungradable/);
  });
});

describe("practiceItemPool — manipulativeCoverage", () => {
  test("counts stored word items + manipulatives per skill, across a domain and across all registered domains", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const teacher = await seedUser(t, "teacher", "coverage-teacher");
    const asTeacher = await asUser(t, teacher);
    const baseline = await asTeacher.query(api.practiceItemPool.manipulativeCoverage, {
      domain: "fraction-arithmetic",
    });
    const baselineBySkill = new Map(baseline.map((row) => [row.skillKey, row]));

    await t.run(async (ctx) => {
      // Two core word items + one core manipulative on partition_shapes.
      await ctx.db.insert("practiceItems", {
        skillKey: "partition_shapes",
        domain: "fraction-arithmetic",
        stem: "word item one",
        answerType: "integer",
        answerCanonical: "1",
        verifierKind: "arithmetic",
        source: "authored",
        verifiedAt: Date.now(),
      });
      await ctx.db.insert("practiceItems", {
        skillKey: "partition_shapes",
        domain: "fraction-arithmetic",
        stem: "word item two",
        answerType: "integer",
        answerCanonical: "2",
        verifierKind: "arithmetic",
        source: "authored",
        verifiedAt: Date.now(),
      });
      await ctx.db.insert("practiceItems", {
        skillKey: "partition_shapes",
        domain: "fraction-arithmetic",
        stem: "Make one half.",
        answerType: "manipulative",
        answerCanonical: "",
        verifierKind: "manipulative",
        manipulativeSpec: GRADABLE_SPEC,
        source: "authored",
        verifiedAt: Date.now(),
      });
      // Present tiers do not contribute core coverage, including unknown tiers.
      await ctx.db.insert("practiceItems", {
        skillKey: "partition_shapes",
        domain: "fraction-arithmetic",
        stem: "stretch word item",
        answerType: "integer",
        answerCanonical: "3",
        verifierKind: "arithmetic",
        tier: "stretch",
        source: "authored",
        verifiedAt: Date.now(),
      });
      await ctx.db.insert("practiceItems", {
        skillKey: "partition_shapes",
        domain: "fraction-arithmetic",
        stem: "future-tier manipulative",
        answerType: "manipulative",
        answerCanonical: "",
        verifierKind: "manipulative",
        manipulativeSpec: GRADABLE_SPEC,
        tier: "future",
        source: "authored",
        verifiedAt: Date.now(),
      });
    });

    // Scoped to one domain.
    const scoped = await asTeacher.query(api.practiceItemPool.manipulativeCoverage, {
      domain: "fraction-arithmetic",
    });
    expect(scoped.length).toBeGreaterThan(0);
    expect(scoped.every((r) => typeof r.skillKey === "string")).toBe(true);
    const partitionRow = scoped.find((r) => r.skillKey === "partition_shapes")!;
    const partitionBaseline = baselineBySkill.get("partition_shapes");
    expect(partitionRow.storedWordCount).toBe(
      (partitionBaseline?.storedWordCount ?? 0) + 2,
    );
    expect(partitionRow.manipulativeCount).toBe(
      (partitionBaseline?.manipulativeCount ?? 0) + 1,
    );
    expect(partitionRow.label.length).toBeGreaterThan(0);
    // Registry-linked application items may already contribute stored words;
    // this fixture changes only partition_shapes and leaves every other row at
    // its seeded baseline.
    const untouched = scoped.filter((r) => r.skillKey !== "partition_shapes");
    for (const r of untouched) {
      expect(r.storedWordCount).toBe(baselineBySkill.get(r.skillKey)?.storedWordCount ?? 0);
      expect(r.manipulativeCount).toBe(baselineBySkill.get(r.skillKey)?.manipulativeCount ?? 0);
    }
    // Default-ish ordering: ascending by manipulativeCount.
    for (let i = 1; i < scoped.length; i++) {
      expect(scoped[i].manipulativeCount).toBeGreaterThanOrEqual(scoped[i - 1].manipulativeCount);
    }

    // Omitted domain ⇒ every registered domain — a strict superset of the
    // scoped fraction-arithmetic rows (whole-number-arithmetic + probability
    // nodes appear too, and partition_shapes's core counts are unchanged).
    const all = await asTeacher.query(api.practiceItemPool.manipulativeCoverage, {});
    expect(all.length).toBeGreaterThan(scoped.length);
    const partitionInAll = all.find((r) => r.skillKey === "partition_shapes")!;
    expect(partitionInAll.storedWordCount).toBe(partitionRow.storedWordCount);
    expect(partitionInAll.manipulativeCount).toBe(partitionRow.manipulativeCount);
    // count_to_10 is whole-number-arithmetic — only visible in the "all" read.
    expect(scoped.some((r) => r.skillKey === "count_to_10")).toBe(false);
    expect(all.some((r) => r.skillKey === "count_to_10")).toBe(true);
  });

  test("gates: a scholar cannot read manipulative coverage", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedUser(t, "scholar", "coverage-scholar");
    const asScholar = await asUser(t, scholar);

    await expect(
      asScholar.query(api.practiceItemPool.manipulativeCoverage, { domain: "fraction-arithmetic" }),
    ).rejects.toThrow();
    await expect(asScholar.query(api.practiceItemPool.manipulativeCoverage, {})).rejects.toThrow();
  });

  test("curriculum_designer passes the gate", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const designer = await seedUser(t, "curriculum_designer", "coverage-designer");
    const asDesigner = await asUser(t, designer);
    const rows = await asDesigner.query(api.practiceItemPool.manipulativeCoverage, {
      domain: "whole-number-arithmetic",
    });
    expect(rows.length).toBeGreaterThan(0);
  });
});
