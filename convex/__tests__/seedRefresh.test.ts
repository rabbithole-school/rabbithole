import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  OBSERVER_TOOL,
  buildObserverUserMessage,
  type ObserverContext,
} from "../lib/observerShared";
import type { SeedOrigin, SeedStatus } from "../lib/seeds";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "Seed Scholar", username: "seed", role: "scholar" }),
  );
}

async function sessionFor(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  seedId?: Id<"seeds">,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("sessions", {
      userId: scholarId,
      title: seedId ? `Visited ${seedId}` : "Observer session",
      isArchived: false,
      seedId,
    }),
  );
}

async function directSeed(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  fields: {
    topic: string;
    domain?: string;
    origin?: SeedOrigin;
    status?: SeedStatus;
    rationale?: string;
  },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("seeds", {
      scholarId,
      origin: fields.origin ?? "ai",
      status: fields.status ?? "pending",
      topic: fields.topic,
      domain: fields.domain ?? "Biology",
      suggestionType: "frontier",
      rationale: fields.rationale ?? `rationale: ${fields.topic}`,
    }),
  );
}

async function recordObserverSeed(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  fields: {
    topic: string;
    domain?: string;
    rationale?: string;
    refreshesSeedId?: string;
  },
) {
  const sessionId = await sessionFor(t, scholarId);
  return await t.mutation(internal.seeds.record, {
    scholarId,
    sessionId,
    topic: fields.topic,
    domain: fields.domain,
    suggestionType: "frontier",
    rationale: fields.rationale ?? `rationale: ${fields.topic}`,
    refreshesSeedId: fields.refreshesSeedId,
  });
}

async function seedsFor(t: ReturnType<typeof convexTest>, scholarId: Id<"users">) {
  const rows = await t.run(async (ctx) => ctx.db.query("seeds").collect());
  return rows.filter((seed) => seed.scholarId === scholarId);
}

describe("observer seed declared refresh", () => {
  test("valid refreshesSeedId patches that seed including topic and inserts no row", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const first = await directSeed(t, scholarId, {
      topic: "How do bat colonies share food",
      domain: "Biology",
      rationale: "first",
    });

    const second = await recordObserverSeed(t, scholarId, {
      topic: "Why do vampire bats share blood",
      domain: "Biology",
      rationale: "refreshed",
      refreshesSeedId: first,
    });

    expect(second).toBe(first);
    const rows = await seedsFor(t, scholarId);
    expect(rows).toHaveLength(1);
    expect(rows[0].topic).toBe("Why do vampire bats share blood");
    expect(rows[0].rationale).toBe("refreshed");
  });

  test("garbage refreshesSeedId does not throw and falls through to insert", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);

    const id = await recordObserverSeed(t, scholarId, {
      topic: "Why do vampire bats share blood",
      domain: "Biology",
      refreshesSeedId: "not-an-id",
    });

    const rows = await seedsFor(t, scholarId);
    expect(rows).toHaveLength(1);
    expect(rows[0]._id).toBe(id);
  });

  test("another scholar's pending seed id is ignored", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const otherScholarId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Other Scholar",
        username: "other-seed",
        role: "scholar",
      }),
    );
    const otherSeed = await directSeed(t, otherScholarId, {
      topic: "How do bat colonies share food",
      domain: "Biology",
    });

    const id = await recordObserverSeed(t, scholarId, {
      topic: "Why do vampire bats share blood",
      domain: "Biology",
      refreshesSeedId: otherSeed,
    });

    expect(id).not.toBe(otherSeed);
    expect(await seedsFor(t, scholarId)).toHaveLength(1);
    expect(await seedsFor(t, otherScholarId)).toHaveLength(1);
  });

  test("non-pending and non-ai declared seed ids are ignored", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const active = await directSeed(t, scholarId, {
      topic: "Solar oven engineering",
      domain: "Engineering",
      status: "active",
    });
    const teacher = await directSeed(t, scholarId, {
      topic: "Ancient trade routes",
      domain: "History",
      origin: "teacher",
    });

    const activeResult = await recordObserverSeed(t, scholarId, {
      topic: "Why do vampire bats share blood",
      domain: "Biology",
      refreshesSeedId: active,
    });
    const teacherResult = await recordObserverSeed(t, scholarId, {
      topic: "How octopuses solve puzzles",
      domain: "Biology",
      refreshesSeedId: teacher,
    });

    expect(activeResult).not.toBe(active);
    expect(teacherResult).not.toBe(teacher);
    expect(await seedsFor(t, scholarId)).toHaveLength(4);
  });

  test("visited pending seed id is ignored", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const visited = await directSeed(t, scholarId, {
      topic: "How do bat colonies share food",
      domain: "Biology",
    });
    await sessionFor(t, scholarId, visited);

    const id = await recordObserverSeed(t, scholarId, {
      topic: "Why do vampire bats share blood",
      domain: "Biology",
      refreshesSeedId: visited,
    });

    expect(id).not.toBe(visited);
    expect(await seedsFor(t, scholarId)).toHaveLength(2);
  });

  test("exact-topic backstop still dedupes when nothing is declared", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    const first = await directSeed(t, scholarId, {
      topic: "Conduction and radiation in heat transfer",
      domain: "Physics",
      rationale: "first",
    });

    const second = await recordObserverSeed(t, scholarId, {
      topic: "Conduction and radiation in heat transfer",
      domain: "Physics",
      rationale: "merged",
    });

    expect(second).toBe(first);
    const rows = await seedsFor(t, scholarId);
    expect(rows).toHaveLength(1);
    expect(rows[0].topic).toBe("Conduction and radiation in heat transfer");
    expect(rows[0].rationale).toBe("merged");
  });

  test("re-worded topic without refreshesSeedId inserts a second row (no fuzzy merge)", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t);
    await directSeed(t, scholarId, {
      topic: "Conduction and radiation in heat transfer",
      domain: "Physics",
    });

    await recordObserverSeed(t, scholarId, {
      topic: "How heat transfer works through conduction/radiation",
      domain: "Physics",
    });

    expect(await seedsFor(t, scholarId)).toHaveLength(2);
  });
});

describe("observer pending seed context", () => {
  const context: ObserverContext = {
    scholarName: "Seed Scholar",
    scholarId: "user123",
    title: "Seed Session",
    unitContext: null,
  };

  test("buildObserverUserMessage renders pending seeds only when provided", () => {
    const withPending = buildObserverUserMessage(
      "SCHOLAR: What about bats?",
      [],
      [{ topic: "Pinned thread", domain: "Biology", suggestionType: "frontier" }],
      [{ signalType: "self_direction", intensity: "high" }],
      context,
      [
        {
          _id: "seed123",
          topic: "Bat food sharing",
          domain: "Biology",
          suggestionType: "frontier",
        },
      ],
    );

    expect(withPending).toContain(
      "## Pending Seeds (1) — already on the sky, awaiting teacher review",
    );
    expect(withPending).toContain(
      "Dedup targets: if a seed you want to suggest is the same thread as one of these, reference its id via refreshesSeedId instead of adding a duplicate.",
    );
    expect(withPending).toContain("- [seed123] Bat food sharing (Biology) — frontier");
    expect(withPending.indexOf("## Active Seeds")).toBeLessThan(
      withPending.indexOf("## Pending Seeds"),
    );
    expect(withPending.indexOf("## Pending Seeds")).toBeLessThan(
      withPending.indexOf("## Recent Learner Signals"),
    );

    const omitted = buildObserverUserMessage(
      "SCHOLAR: What about bats?",
      [],
      [],
      [],
      context,
    );
    const empty = buildObserverUserMessage(
      "SCHOLAR: What about bats?",
      [],
      [],
      [],
      context,
      [],
    );
    expect(omitted).not.toContain("## Pending Seeds");
    expect(empty).not.toContain("## Pending Seeds");
  });

  test("OBSERVER_TOOL seed schema exposes optional refreshesSeedId", () => {
    const seedItem = OBSERVER_TOOL.input_schema.properties.seeds.items;

    expect(seedItem.properties.refreshesSeedId).toMatchObject({
      type: "string",
    });
    expect(seedItem.required).not.toContain("refreshesSeedId");
  });
});
