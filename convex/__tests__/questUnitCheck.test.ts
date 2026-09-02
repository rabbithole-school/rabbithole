import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import type { Id } from "../_generated/dataModel";
import { isQuestUnitForScholar } from "../lib/questLifecycle";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher",
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: `Test ${role}`,
      username: `${role}-${Math.random().toString(36).slice(2)}`,
      role,
    }),
  );
}

async function seedCatalogUnit(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("units", {
      teacherId,
      title: "Catalog Unit",
      isActive: true,
    }),
  );
}

describe("isQuestUnitForScholar", () => {
  test("scholar-authored unit is a Quest", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const unitId = await t.run(async (ctx) =>
      ctx.db.insert("units", {
        teacherId: scholarId,
        authorScholarId: scholarId,
        title: "Scholar-authored Unit",
        isActive: true,
      }),
    );

    expect(
      await t.run((ctx) => isQuestUnitForScholar(ctx, scholarId, unitId)),
    ).toBe(true);
  });

  test("seed-linked unit is a Quest", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const unitId = await seedCatalogUnit(t, teacherId);
    await t.run(async (ctx) =>
      ctx.db.insert("seeds", {
        scholarId,
        origin: "teacher",
        status: "dismissed",
        topic: "A linked unit",
        suggestionType: "teacher_suggestion",
        rationale: "A past offer still establishes Quest provenance.",
        unitId,
      }),
    );

    expect(
      await t.run((ctx) => isQuestUnitForScholar(ctx, scholarId, unitId)),
    ).toBe(true);
  });

  test("assignment-less catalog start is a Quest", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const unitId = await seedCatalogUnit(t, teacherId);
    await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        unitId,
        title: "Independent catalog start",
        isArchived: false,
      }),
    );

    expect(
      await t.run((ctx) => isQuestUnitForScholar(ctx, scholarId, unitId)),
    ).toBe(true);
  });

  test("purely assigned catalog unit is not a Quest", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const unitId = await seedCatalogUnit(t, teacherId);
    const assignmentId = await t.run(async (ctx) =>
      ctx.db.insert("assignments", {
        teacherId,
        unitId,
        scholarIds: [scholarId],
        startedAt: Date.now(),
      }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        unitId,
        assignmentId,
        title: "Assigned classwork",
        isArchived: false,
      }),
    );

    expect(
      await t.run((ctx) => isQuestUnitForScholar(ctx, scholarId, unitId)),
    ).toBe(false);
  });
});
