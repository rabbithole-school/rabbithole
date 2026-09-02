import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { STORY_KINDS } from "../edgeStories";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role = "scholar",
  overrides: {
    name?: string;
    username?: string;
    readingLevel?: string;
    image?: string;
  } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test${role}`,
      role,
      readingLevel: overrides.readingLevel,
      image: overrides.image,
    })
  );
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    })
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedUnitWithActivity(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId, title: "Test Unit", isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId, title: "Test Lesson", order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId, title: "Test Activity", kind: "online",
      systemPrompt: "...", order: 0,
    });
    return { unitId, lessonId, activityId };
  });
}

void seedUnitWithActivity;

async function seedNode(
  t: ReturnType<typeof convexTest>,
  nodeKey: string,
  label = `Label for ${nodeKey}`,
  domain = "math",
  strand?: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("knowledgeNodes", { nodeKey, label, domain, strand }),
  );
}

const GOOD_STORY = {
  kind: "instantiates",
  hook: "Cicadas emerge on prime-numbered years.",
  narrative: "13- and 17-year cicadas pick prime cycles so predators can't sync up.",
} as const;

describe("edgeStories — role gates", () => {
  test("any authenticated user may read stories", async () => {
    const t = convexTest(schema, modules);
    await seedNode(t, "primes");
    await seedNode(t, "cicadas", "Cicadas", "biology");
    await t.run(async (ctx) =>
      ctx.db.insert("knowledgeNodeEdges", {
        fromKey: "primes",
        toKey: "cicadas",
        domain: "sky",
        kind: "bridge",
        method: "curated",
        story: { ...GOOD_STORY, provenance: "registry" },
      }),
    );

    const asScholar = await withUser(
      t,
      await seedUser(t, "scholar", { username: "kai" }),
    );
    const res = await asScholar.query(api.nodeNeighbourhood.neighbourhood, {
      nodeKey: "primes",
    });
    expect(res?.stories).toHaveLength(1);
    expect(res?.stories[0].toLabel).toBe("Cicadas");
  });

  test("scholar is rejected on write", async () => {
    const t = convexTest(schema, modules);
    await seedNode(t, "primes");
    const asScholar = await withUser(
      t,
      await seedUser(t, "scholar", { username: "kai" }),
    );
    await expect(
      asScholar.mutation(api.edgeStories.upsertStory, {
        fromKey: "primes",
        toLabel: "Cicadas",
        toDomain: "biology",
        story: GOOD_STORY,
      }),
    ).rejects.toThrow(/curriculum access|Forbidden/i);
  });
});

describe("edgeStories — validation and writes", () => {
  async function teacherCtx() {
    const t = convexTest(schema, modules);
    await seedNode(t, "primes");
    const asTeacher = await withUser(
      t,
      await seedUser(t, "teacher", { username: "tess" }),
    );
    return { t, asTeacher };
  }

  test("creates a curated story edge and mints a world far-end node", async () => {
    const { t, asTeacher } = await teacherCtx();
    const before = Date.now();
    const res = await asTeacher.mutation(api.edgeStories.upsertStory, {
      fromKey: "primes",
      toLabel: "Cicada life cycles",
      toDomain: "biology",
      story: GOOD_STORY,
    });

    expect(res.toKey).toBe("cicada life cycles");
    expect(res.method).toBe("curated");
    expect(res.story.provenance).toBe("authored");
    expect(res.story.updatedAt).toBeGreaterThanOrEqual(before);

    const world = await t.run(async (ctx) =>
      ctx.db
        .query("knowledgeNodes")
        .withIndex("by_nodeKey", (q) => q.eq("nodeKey", "cicada life cycles"))
        .first(),
    );
    expect(world).toMatchObject({
      label: "Cicada life cycles",
      domain: "biology",
      source: "world",
      embeddingText: "Cicada life cycles. Cicadas emerge on prime-numbered years.",
    });
  });

  test("editing a registry story converts provenance to authored", async () => {
    const { t, asTeacher } = await teacherCtx();
    await seedNode(t, "cicadas", "Cicadas", "biology");
    const edgeId = await t.run(async (ctx) =>
      ctx.db.insert("knowledgeNodeEdges", {
        fromKey: "primes",
        toKey: "cicadas",
        domain: "sky",
        kind: "bridge",
        method: "curated",
        story: { ...GOOD_STORY, provenance: "registry" },
      }),
    );

    const res = await asTeacher.mutation(api.edgeStories.upsertStory, {
      edgeId,
      fromKey: "primes",
      story: { kind: "applies", hook: "Edited hook", narrative: "Edited story" },
    });
    expect(res.story).toMatchObject({
      kind: "applies",
      hook: "Edited hook",
      narrative: "Edited story",
      provenance: "authored",
    });
  });

  test("rejects invalid kinds, visuals, and length ceilings", async () => {
    const { asTeacher } = await teacherCtx();
    await expect(
      asTeacher.mutation(api.edgeStories.upsertStory, {
        fromKey: "primes",
        toLabel: "Cicadas",
        toDomain: "biology",
        story: { ...GOOD_STORY, kind: "nonsense" },
      }),
    ).rejects.toThrow(/Invalid story kind/i);
    await expect(
      asTeacher.mutation(api.edgeStories.upsertStory, {
        fromKey: "primes",
        toLabel: "Cicadas",
        toDomain: "biology",
        story: { ...GOOD_STORY, narrative: "x".repeat(601) },
      }),
    ).rejects.toThrow(/Narrative text must be 600/i);
    await expect(
      asTeacher.mutation(api.edgeStories.upsertStory, {
        fromKey: "primes",
        toLabel: "Cicadas",
        toDomain: "biology",
        story: { ...GOOD_STORY, visualEmoji: "not an emoji" },
      }),
    ).rejects.toThrow(/Visual emoji/i);
    await expect(
      asTeacher.mutation(api.edgeStories.upsertStory, {
        fromKey: "primes",
        toLabel: "Cicadas",
        toDomain: "biology",
        story: { ...GOOD_STORY, visualEmoji: "Cicada 🪲" },
      }),
    ).rejects.toThrow(/single emoji/i);
    await expect(
      asTeacher.mutation(api.edgeStories.upsertStory, {
        fromKey: "primes",
        toLabel: "Cicadas",
        toDomain: "biology",
        story: { ...GOOD_STORY, visualEmoji: "🪲" },
      }),
    ).resolves.toMatchObject({ story: { visualEmoji: "🪲" } });
  });

  test("removeStory clears the story but keeps the durable tombstone (blocks reseed resurrection)", async () => {
    const { t, asTeacher } = await teacherCtx();
    await seedNode(t, "cicadas", "Cicadas", "biology");
    const edgeId = await t.run(async (ctx) =>
      ctx.db.insert("knowledgeNodeEdges", {
        fromKey: "primes",
        toKey: "cicadas",
        domain: "sky",
        kind: "bridge",
        method: "curated",
        story: { ...GOOD_STORY, provenance: "authored" },
      }),
    );

    await asTeacher.mutation(api.edgeStories.removeStory, { edgeId });
    const edge = await t.run(async (ctx) => ctx.db.get(edgeId));
    // The edge SURVIVES with no story — a hard delete would let seedRegistry
    // resurrect the removed story on the next rebuild. The story-less,
    // method:"curated" tombstone is what makes the deletion durable.
    expect(edge).not.toBeNull();
    expect(edge?.story).toBeUndefined();
    expect(edge?.method).toBe("curated");
    expect(edge?.kind).toBe("bridge");
  });

  test("upsertStory refuses to attach a story to a dependency edge", async () => {
    const { t, asTeacher } = await teacherCtx();
    await seedNode(t, "cicadas", "Cicadas", "biology");
    // A prerequisite edge that runs the same direction as the story we try to add.
    const depId = await t.run(async (ctx) =>
      ctx.db.insert("knowledgeNodeEdges", {
        fromKey: "primes",
        toKey: "cicadas",
        domain: "whole-number-arithmetic",
        kind: "buildsOn",
        method: "curated",
      }),
    );
    // Direct edgeId attach is refused outright.
    await expect(
      asTeacher.mutation(api.edgeStories.upsertStory, {
        edgeId: depId,
        fromKey: "primes",
        story: GOOD_STORY,
      }),
    ).rejects.toThrow(/dependency/i);
    // The create-by-pair path must NOT clobber the dependency edge — it inserts
    // a separate bridge and leaves the buildsOn edge intact.
    await asTeacher.mutation(api.edgeStories.upsertStory, {
      fromKey: "primes",
      toLabel: "Cicadas",
      toDomain: "biology",
      story: GOOD_STORY,
    });
    const dep = await t.run(async (ctx) => ctx.db.get(depId));
    expect(dep?.kind).toBe("buildsOn");
    expect(dep?.story).toBeUndefined();
    const bridges = await t.run(async (ctx) =>
      (await ctx.db.query("knowledgeNodeEdges").withIndex("by_from", (q) => q.eq("fromKey", "primes")).collect())
        .filter((e) => e.kind === "bridge" && e.story !== undefined),
    );
    expect(bridges.length).toBe(1);
  });

  test("STORY_KINDS are the four expected story bridges", () => {
    expect([...STORY_KINDS]).toEqual([
      "instantiates",
      "applies",
      "history",
      "etymology",
    ]);
  });
});

describe("edgeStories.listStories", () => {
  test("returns every story edge across provenances, once per edge, with joined labels", async () => {
    const t = convexTest(schema, modules);
    await seedNode(t, "partition_shapes", "Partition shapes", "fraction-arithmetic", "sense-making");
    await seedNode(t, "fraction_line", "Fractions on a line", "fraction-arithmetic", "sense-making");
    await seedNode(t, "cicada_life_cycles", "Cicada life cycles", "biology");
    await seedNode(t, "music_looping", "Looping rhythm", "music");

    const [registryEdgeId, authoredEdgeId, generatedEdgeId] = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.insert("knowledgeNodeEdges", {
          fromKey: "partition_shapes",
          toKey: "fraction_line",
          domain: "sky",
          kind: "bridge",
          method: "curated",
          story: {
            kind: "applies",
            hook: "Share a pan of brownies.",
            narrative: "Equal shares map cleanly to fraction names.",
            visualEmoji: "🍫",
            provenance: "registry",
            updatedAt: 1001,
          },
        }),
        ctx.db.insert("knowledgeNodeEdges", {
          fromKey: "partition_shapes",
          toKey: "cicada_life_cycles",
          domain: "sky",
          kind: "bridge",
          method: "curated",
          story: {
            kind: "instantiates",
            hook: "Prime cycles in nature.",
            narrative: "Cicadas echo periodic spacing ideas.",
            probe: "Why might primes matter?",
            source: "Field notes",
            provenance: "authored",
            updatedAt: 1002,
          },
        }),
        ctx.db.insert("knowledgeNodeEdges", {
          fromKey: "partition_shapes",
          toKey: "music_looping",
          domain: "sky",
          kind: "bridge",
          method: "generated",
          story: {
            kind: "history",
            hook: "Bars and beats.",
            narrative: "Looping patterns use the same partitioning logic.",
            provenance: "generated",
            updatedAt: 1003,
          },
        }),
      ]),
    );

    await t.run(async (ctx) =>
      ctx.db.insert("knowledgeNodeEdges", {
        fromKey: "partition_shapes",
        toKey: "unused_edge",
        domain: "sky",
        kind: "bridge",
        method: "curated",
      }),
    );

    const asTeacher = await withUser(
      t,
      await seedUser(t, "teacher", { username: "inventory-teacher" }),
    );
    const rows = await asTeacher.query(api.edgeStories.listStories, {});
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.edgeId))).toEqual(
      new Set([registryEdgeId, authoredEdgeId, generatedEdgeId]),
    );

    const registry = rows.find((row) => row.edgeId === registryEdgeId);
    expect(registry).toMatchObject({
      fromKey: "partition_shapes",
      fromLabel: "Partition shapes",
      fromDomain: "fraction-arithmetic",
      fromStrand: "sense-making",
      toLabel: "Fractions on a line",
      toDomain: "fraction-arithmetic",
      kind: "applies",
      provenance: "registry",
      visualEmoji: "🍫",
    });

    const authored = rows.find((row) => row.edgeId === authoredEdgeId);
    expect(authored?.probe).toBe("Why might primes matter?");
    expect(authored?.source).toBe("Field notes");
    expect(authored?.updatedAt).toBe(1002);
  });

  test("uses the curriculum gate", async () => {
    const t = convexTest(schema, modules);
    await seedNode(t, "partition_shapes", "Partition shapes");
    const asScholar = await withUser(
      t,
      await seedUser(t, "scholar", { username: "inventory-scholar" }),
    );
    await expect(asScholar.query(api.edgeStories.listStories, {})).rejects.toThrow(
      /curriculum access|Forbidden/i,
    );
  });
});

describe("edgeStories — internal twins", () => {
  test("upsertStoryInternal writes without an auth gate", async () => {
    const t = convexTest(schema, modules);
    await seedNode(t, "primes");
    const res = await t.mutation(internal.edgeStories.upsertStoryInternal, {
      fromKey: "primes",
      toLabel: "Cicadas",
      toDomain: "biology",
      story: GOOD_STORY,
    });
    expect(res.story.provenance).toBe("authored");
  });
});
