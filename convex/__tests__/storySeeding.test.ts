import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { STORY_REGISTRY } from "../lib/practice/storyRegistry";
import { validateRegistryStoryAuthoring } from "../edgeStories";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function nodeByKey(
  t: ReturnType<typeof convexTest>,
  nodeKey: string,
): Promise<Doc<"knowledgeNodes"> | null> {
  const rows = (await t.run(async (ctx) =>
    ctx.db.query("knowledgeNodes").collect(),
  )) as Doc<"knowledgeNodes">[];
  return rows.find((n) => n.nodeKey === nodeKey) ?? null;
}

async function edgeByPair(
  t: ReturnType<typeof convexTest>,
  fromKey: string,
  toKey: string,
): Promise<Doc<"knowledgeNodeEdges"> | null> {
  const rows = (await t.run(async (ctx) =>
    ctx.db.query("knowledgeNodeEdges").collect(),
  )) as Doc<"knowledgeNodeEdges">[];
  return rows.find((e) => e.fromKey === fromKey && e.toKey === toKey) ?? null;
}

describe("edge story registry seeding", () => {
  test("assigns every registry story an authored curiosity cue", () => {
    expect(STORY_REGISTRY.every((story) => story.visualEmoji !== undefined)).toBe(true);
  });

  test("rebuildPracticeNodes seeds registry story edges and deduped world nodes", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.knowledgeNodes.rebuild, {});

    const primeStory = await edgeByPair(t, "prime_factorization", "cicada life cycles");
    expect(primeStory).toMatchObject({
      kind: "bridge",
      method: "curated",
      domain: "sky",
      weight: 1,
    });
    expect(primeStory?.story).toMatchObject({
      kind: "instantiates",
      hook: "Cicadas that count in primes",
      provenance: "registry",
    });
    // Card teaser seeds alongside the story (Finding 2): the reveal card renders
    // this in place of the full narrative.
    expect(primeStory?.story?.teaser).toBeDefined();
    expect(primeStory?.story?.teaser).toContain("13 or 17 years");
    expect(primeStory?.story?.visualEmoji).toBe("🪲");

    const lcmStory = await edgeByPair(t, "lcm", "cicada life cycles");
    expect(lcmStory?.story?.hook).toBe("The 221-year cicada reunion");

    // Level-fit move (Finding 1): Simpson's Paradox lives on ratio_compare
    // (grade 6), NOT on the grade-4 compare_unlike it was authored on.
    const simpsonOnRatio = await edgeByPair(t, "ratio_compare", "simpson's paradox");
    expect(simpsonOnRatio?.story?.hook).toContain("beat his rival two seasons");
    const simpsonOnFractionCompare = await edgeByPair(
      t,
      "compare_unlike",
      "simpson's paradox",
    );
    expect(simpsonOnFractionCompare).toBeNull();

    const cicada = await nodeByKey(t, "cicada life cycles");
    expect(cicada).toMatchObject({
      label: "Cicada life cycles",
      domain: "biology",
      source: "world",
    });
    const cicadaCount = await t.run(async (ctx) => {
      const rows = await ctx.db.query("knowledgeNodes").collect();
      return rows.filter((n) => n.nodeKey === "cicada life cycles").length;
    });
    expect(cicadaCount).toBe(1);
  });

  test("questions route answerless text to the probe and answered text to linked stretch items idempotently", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.knowledgeNodes.rebuild, {});

    const entry = STORY_REGISTRY.find(
      (story) => story.fromKey === "lcm" && story.toKey === "cicada life cycles",
    );
    if (!entry?.questions) throw new Error("Expected the LCM application questions");
    const answered = entry.questions.find((question) => question.answer !== undefined);
    const answerless = entry.questions.find((question) => question.answer === undefined);
    if (!answered || !answerless) throw new Error("Expected answered and answerless questions");

    expect((await edgeByPair(t, entry.fromKey, entry.toKey))?.story?.probe).toBe(
      answerless.text,
    );
    const seeded = await t.run(async (ctx) =>
      ctx.db
        .query("practiceItems")
        .withIndex("by_skill", (q) => q.eq("skillKey", entry.fromKey))
        .filter((q) => q.eq(q.field("stem"), answered.text))
        .collect(),
    );
    expect(seeded).toHaveLength(1);
    expect(seeded[0]).toMatchObject({
      domain: "whole-number-arithmetic",
      answerCanonical: answered.answer,
      tier: "stretch",
      storyToKey: entry.toKey,
      verifierKind: "arithmetic",
      source: "registry",
    });

    await t.mutation(internal.edgeStories.seedRegistry, {});
    const afterReseed = await t.run(async (ctx) =>
      ctx.db
        .query("practiceItems")
        .withIndex("by_skill", (q) => q.eq("skillKey", entry.fromKey))
        .filter((q) => q.eq(q.field("stem"), answered.text))
        .collect(),
    );
    expect(afterReseed).toHaveLength(1);
  });

  test("re-seeding patches a drifted answer key on an already-seeded registry question in place", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.knowledgeNodes.rebuild, {});

    const entry = STORY_REGISTRY.find(
      (story) => story.fromKey === "lcm" && story.toKey === "cicada life cycles",
    );
    const answered = entry?.questions?.find((question) => question.answer !== undefined);
    if (!entry || !answered) throw new Error("Expected the LCM application question");

    // Simulate a deployment seeded BEFORE the registry's answer key was
    // corrected: the stored row has the OLD (wrong) answerCanonical/technique/
    // bloomLevel, same stem, same registry-owned source.
    const seededId = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("practiceItems")
        .withIndex("by_skill", (q) => q.eq("skillKey", entry.fromKey))
        .filter((q) => q.eq(q.field("stem"), answered.text))
        .first();
      if (!row) throw new Error("lcm question was not seeded");
      await ctx.db.patch(row._id, {
        answerCanonical: "9999",
        technique: "stale_technique",
        bloomLevel: 0,
      });
      return row._id;
    });

    const result = await t.mutation(internal.edgeStories.seedRegistry, {});
    expect(result.questionsRefreshed).toBeGreaterThan(0);

    const patched = await t.run(async (ctx) => ctx.db.get(seededId));
    expect(patched?._id).toBe(seededId); // patched in place, not a new row
    expect(patched).toMatchObject({
      answerCanonical: answered.answer,
      technique: answered.technique,
      bloomLevel: answered.bloomLevel,
      source: "registry",
    });

    const allWithStem = await t.run(async (ctx) =>
      ctx.db
        .query("practiceItems")
        .withIndex("by_skill", (q) => q.eq("skillKey", entry.fromKey))
        .filter((q) => q.eq(q.field("stem"), answered.text))
        .collect(),
    );
    expect(allWithStem).toHaveLength(1);
  });

  test("re-seeding never patches a teacher-edited (non-registry-source) question row", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.knowledgeNodes.rebuild, {});

    const entry = STORY_REGISTRY.find(
      (story) => story.fromKey === "lcm" && story.toKey === "cicada life cycles",
    );
    const answered = entry?.questions?.find((question) => question.answer !== undefined);
    if (!entry || !answered) throw new Error("Expected the LCM application question");

    // A teacher opened this seeded row in the item editor and overrode the
    // answer — `updateItemCore` always stamps `source: "authored"` on save,
    // regardless of the row's prior provenance.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("practiceItems")
        .withIndex("by_skill", (q) => q.eq("skillKey", entry.fromKey))
        .filter((q) => q.eq(q.field("stem"), answered.text))
        .first();
      if (!row) throw new Error("lcm question was not seeded");
      await ctx.db.patch(row._id, {
        answerCanonical: "teacher's deliberate override",
        source: "authored",
      });
    });

    const result = await t.mutation(internal.edgeStories.seedRegistry, {});
    expect(result.questionsRefreshed).toBe(0);

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("practiceItems")
        .withIndex("by_skill", (q) => q.eq("skillKey", entry.fromKey))
        .filter((q) => q.eq(q.field("stem"), answered.text))
        .first(),
    );
    expect(row?.answerCanonical).toBe("teacher's deliberate override");
    expect(row?.source).toBe("authored");
  });

  test("editing a registry question's stem text seeds a new row and orphans the old one", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.knowledgeNodes.rebuild, {});

    const entry = STORY_REGISTRY.find(
      (story) => story.fromKey === "lcm" && story.toKey === "cicada life cycles",
    );
    const answered = entry?.questions?.find((question) => question.answer !== undefined);
    if (!entry || !answered) throw new Error("Expected the LCM application question");

    const originalStem = answered.text;
    const editedStem = `${originalStem} (revised wording)`;
    // Mutate the IN-MEMORY registry entry's stem, as if the source file had
    // been edited, then re-seed against it.
    (answered as { text: string }).text = editedStem;
    try {
      const result = await t.mutation(internal.edgeStories.seedRegistry, {});
      expect(result.questionsRefreshed).toBe(0); // a NEW row, not a patch

      const rows = await t.run(async (ctx) =>
        ctx.db
          .query("practiceItems")
          .withIndex("by_skill", (q) => q.eq("skillKey", entry.fromKey))
          .collect(),
      );
      const oldRow = rows.find((r) => r.stem === originalStem);
      const newRow = rows.find((r) => r.stem === editedStem);
      expect(oldRow).toBeDefined(); // orphaned, but still present/serving
      expect(newRow).toMatchObject({
        answerCanonical: answered.answer,
        source: "registry",
        storyToKey: entry.toKey,
      });
    } finally {
      (answered as { text: string }).text = originalStem;
    }
  });

  test("registry authoring rejects carrying both legacy probe and unified questions", () => {
    expect(() =>
      validateRegistryStoryAuthoring({
        probe: "Legacy opener",
        questions: [{ text: "Unified opener" }],
      }),
    ).toThrow(/probe OR questions/i);
  });

  test("seeding does not clobber edited durable stories", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.knowledgeNodes.rebuild, {});

    await t.run(async (ctx) => {
      const edge = await ctx.db
        .query("knowledgeNodeEdges")
        .withIndex("by_from", (q) => q.eq("fromKey", "lcm"))
        .collect()
        .then((rows) => rows.find((e) => e.toKey === "cicada life cycles"));
      if (!edge?.story) throw new Error("lcm story was not seeded");
      await ctx.db.patch(edge._id, {
        story: {
          ...edge.story,
          narrative: "Teacher-edited story that must survive rebuild.",
          provenance: "authored",
          updatedAt: 123,
        },
      });
    });

    await t.mutation(internal.knowledgeNodes.rebuild, {});

    const edge = await edgeByPair(t, "lcm", "cicada life cycles");
    expect(edge?.story?.narrative).toBe(
      "Teacher-edited story that must survive rebuild.",
    );
    expect(edge?.story?.provenance).toBe("authored");
  });

  test("re-seeding refreshes a machine-owned story with edited registry content", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.knowledgeNodes.rebuild, {});

    // Simulate a deployment seeded BEFORE the registry entry was edited: strip
    // the teaser and stale out the narrative on the stored registry-provenance
    // edge, leaving provenance/method exactly as the seeder wrote them.
    await t.run(async (ctx) => {
      const edge = await ctx.db
        .query("knowledgeNodeEdges")
        .withIndex("by_from", (q) => q.eq("fromKey", "prime_factorization"))
        .collect()
        .then((rows) => rows.find((e) => e.toKey === "cicada life cycles"));
      if (!edge?.story) throw new Error("prime story was not seeded");
      expect(edge.story.provenance).toBe("registry");
      await ctx.db.patch(edge._id, {
        story: {
          ...edge.story,
          teaser: undefined,
          narrative: "Stale narrative from an earlier registry revision.",
        },
      });
    });

    const stale = await edgeByPair(t, "prime_factorization", "cicada life cycles");
    expect(stale?.story?.teaser).toBeUndefined();

    const result = await t.mutation(internal.edgeStories.seedRegistry, {});
    expect(result.refreshed).toBeGreaterThan(0);

    const entry = STORY_REGISTRY.find(
      (s) => s.fromKey === "prime_factorization" && s.toKey === "cicada life cycles",
    );
    if (!entry) throw new Error("Expected a prime_factorization cicada registry entry");
    const refreshed = await edgeByPair(t, "prime_factorization", "cicada life cycles");
    expect(refreshed?.story?.narrative).toBe(entry.narrative);
    expect(refreshed?.story?.teaser).toBe(entry.teaser);
    expect(refreshed?.story?.visualEmoji).toBe(entry.visualEmoji);
    expect(refreshed?.story?.provenance).toBe("registry");
    expect(refreshed?.method).toBe("curated");
  });

  test("re-seeding an unchanged deployment is a no-op", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.knowledgeNodes.rebuild, {});

    const result = await t.mutation(internal.edgeStories.seedRegistry, {});
    expect(result).toMatchObject({ nodes: 0, edges: 0, refreshed: 0 });
  });

  test("re-seeding does not clobber a teacher-authored story", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.knowledgeNodes.rebuild, {});

    await t.run(async (ctx) => {
      const edge = await ctx.db
        .query("knowledgeNodeEdges")
        .withIndex("by_from", (q) => q.eq("fromKey", "prime_factorization"))
        .collect()
        .then((rows) => rows.find((e) => e.toKey === "cicada life cycles"));
      if (!edge?.story) throw new Error("prime story was not seeded");
      await ctx.db.patch(edge._id, {
        story: {
          ...edge.story,
          hook: "A hook only a human would write",
          narrative: "Authored words that the seeder must never overwrite.",
          teaser: "Authored teaser.",
          provenance: "authored",
        },
      });
    });

    await t.mutation(internal.edgeStories.seedRegistry, {});

    const edge = await edgeByPair(t, "prime_factorization", "cicada life cycles");
    expect(edge?.story?.hook).toBe("A hook only a human would write");
    expect(edge?.story?.narrative).toBe(
      "Authored words that the seeder must never overwrite.",
    );
    expect(edge?.story?.teaser).toBe("Authored teaser.");
    expect(edge?.story?.provenance).toBe("authored");
  });

  test("curated-to-none durable edge blocks registry resurrection", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.knowledgeNodes.rebuild, {});

    await t.run(async (ctx) => {
      const edge = await ctx.db
        .query("knowledgeNodeEdges")
        .withIndex("by_from", (q) => q.eq("fromKey", "prime_factorization"))
        .collect()
        .then((rows) => rows.find((e) => e.toKey === "cicada life cycles"));
      if (!edge) throw new Error("prime story was not seeded");
      await ctx.db.patch(edge._id, { story: undefined, method: "curated" });
    });

    await t.mutation(internal.edgeStories.seedRegistry, {});

    const edge = await edgeByPair(t, "prime_factorization", "cicada life cycles");
    expect(edge?.method).toBe("curated");
    expect(edge?.story).toBeUndefined();
  });

  test("world nodes are exempt from sky-lane prune", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.knowledgeNodes.rebuild, {});

    await t.mutation(internal.knowledgeNodes.pruneStaleSkyNodes, { keepKeys: [] });

    expect(await nodeByKey(t, "cicada life cycles")).not.toBeNull();
  });

  test("seeding migrates legacy world identities and their incoming edges", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "prime_factorization",
        label: "Prime factorization",
        domain: "whole-number-arithmetic",
      });
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "cicada_life_cycles",
        label: "Cicada life cycles",
        domain: "biology",
        source: "world",
        normalizedLabel: "cicada_life_cycles",
      });
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: "prime_factorization",
        toKey: "cicada_life_cycles",
        domain: "sky",
        kind: "bridge",
        method: "curated",
        story: {
          kind: "instantiates",
          hook: "Teacher-edited cicada story",
          narrative: "This authored version must win during identity migration.",
          provenance: "authored",
        },
      });
    });

    await t.mutation(internal.edgeStories.seedRegistry, {});

    expect(await nodeByKey(t, "cicada_life_cycles")).toBeNull();
    expect(await nodeByKey(t, "cicada life cycles")).toMatchObject({
      normalizedLabel: "cicada life cycles",
      source: "world",
    });
    expect(
      await edgeByPair(t, "prime_factorization", "cicada life cycles"),
    ).toMatchObject({
      method: "curated",
      story: {
        hook: "Teacher-edited cicada story",
        provenance: "authored",
      },
    });
  });

  test("generated registry stories stamp the generated edge method", async () => {
    const entry = STORY_REGISTRY.find((story) => story.provenance === "generated");
    if (!entry) throw new Error("Expected at least one generated registry story");
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: entry.fromKey,
        label: entry.fromKey,
        domain: "math",
      });
    });

    await t.mutation(internal.edgeStories.seedRegistry, {});

    expect(await edgeByPair(t, entry.fromKey, entry.toKey)).toMatchObject({
      method: "generated",
      story: { provenance: "generated" },
    });
  });
});
