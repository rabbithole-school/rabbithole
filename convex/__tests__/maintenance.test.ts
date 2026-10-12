import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { scholarOwnedRowSources } from "../lib/cascade";
import schema from "../schema";
import { deleteUserCore } from "../users";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  username: string,
) {
  return await t.run((ctx) =>
    ctx.db.insert("users", {
      name: `Test ${username}`,
      username,
      role: "scholar",
    }),
  );
}

const REPRESENTATIVE_TABLES = [
  "calculatorLicenses",
  "scholarMathPlans",
  "scholarMathPlanMigrationIssues",
  "specialDeliveryLetters",
  "practiceMastery",
  "practiceWorkImages",
  "practiceAttempts",
  "momentEvents",
  "practicePlacements",
] as const;

async function seedRepresentativePracticeRows(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
) {
  return await t.run(async (ctx) => {
    const institutionId = await ctx.db.insert("institutions", {
      name: `Test School ${scholarId}`,
      slug: `test-${scholarId}`,
      kind: "school",
    });
    const workImageId = await ctx.storage.store(
      new Blob([`work-${scholarId}`], { type: "image/png" }),
    );
    const letterSketchId = await ctx.storage.store(
      new Blob([`sketch-${scholarId}`], { type: "image/png" }),
    );
    const rows = {
      calculatorLicense: await ctx.db.insert("calculatorLicenses", {
        scholarId,
        issuedAt: 1,
        issuedBy: scholarId,
      }),
      mathPlan: await ctx.db.insert("scholarMathPlans", {
        scholarId,
        practiceScope: { kind: "open" },
        updatedBy: scholarId,
        updatedAt: 1,
      }),
      mathPlanIssue: await ctx.db.insert("scholarMathPlanMigrationIssues", {
        scholarId,
        assignmentIds: [],
        reason: "unknown_domain",
        recordedAt: 1,
      }),
      specialDeliveryLetter: await ctx.db.insert("specialDeliveryLetters", {
        institutionId,
        scholarId,
        dayKey: "2026-09-06",
        nextSchoolDayKey: "2026-09-07",
        scholarName: "Test Scholar",
        salutationName: "Scholar",
        homework: [],
        reflectionPrompts: [],
        tomorrowClues: [],
        factsHash: `facts-${scholarId}`,
        copyVersion: "test",
        preparedAt: 1,
        insert: {
          kind: "sketch",
          storageId: letterSketchId,
          mime: "image/png",
          caption: "A test sketch",
          prompt: "Draw a test sketch",
        },
      }),
      mastery: await ctx.db.insert("practiceMastery", {
        scholarId,
        skillKey: "whole_numbers_addition",
        domain: "whole-number-arithmetic",
        repetition: 1,
        halfLifeDays: 1,
        frontier: true,
        source: "practice",
        updatedAt: 1,
      }),
      workImage: await ctx.db.insert("practiceWorkImages", {
        scholarId,
        itemId: "whole_numbers_addition",
        storageId: workImageId,
        source: "miss",
        createdAt: 1,
      }),
      attempt: await ctx.db.insert("practiceAttempts", {
        scholarId,
        nodeKey: "whole_numbers_addition",
        correct: true,
        workImageId,
        createdAt: 1,
      }),
      moment: await ctx.db.insert("momentEvents", {
        scholarId,
        kind: "story",
        fromKey: "whole_numbers_addition",
        toKey: "counting-in-the-world",
        trigger: "fluency_transition",
        offeredAt: 1,
        outcome: "offered",
        clientEventId: `moment-${scholarId}`,
      }),
      placement: await ctx.db.insert("practicePlacements", {
        scholarId,
        domain: "whole-number-arithmetic",
        status: "complete",
        probesAnswered: 1,
        updatedAt: 1,
      }),
    };
    return { rows, blobIds: [workImageId, letterSketchId] };
  });
}

describe("scholar-owned cascade inventory", () => {
  test("every inventory index exists with scholarId first", () => {
    for (const source of scholarOwnedRowSources) {
      // `export()` is how the Convex CLI reads a table's declared indexes; it
      // is not part of TableDefinition's public type, so cast structurally.
      const exported = (
        schema.tables[source.table] as unknown as {
          export(): { indexes: { indexDescriptor: string; fields: string[] }[] };
        }
      ).export();
      const index = exported.indexes.find(
        (candidate) => candidate.indexDescriptor === source.index,
      );
      expect(index, `${source.table}.${source.index}`).toBeDefined();
      expect(index?.fields[0], `${source.table}.${source.index}`).toBe(
        "scholarId",
      );
    }
  });
});

describe("scholar practice-row maintenance", () => {
  test("deleteUserCore removes canonical scholar-owned rows and blobs", async () => {
    const t = convexTest(schema, modules);
    const callerId = await seedUser(t, "operator");
    const scholarId = await seedUser(t, "practice-delete");
    const seeded = await seedRepresentativePracticeRows(t, scholarId);

    await t.run((ctx) => deleteUserCore(ctx, scholarId, callerId));

    await t.run(async (ctx) => {
      expect(await ctx.db.get(scholarId)).toBeNull();
      for (const rowId of Object.values(seeded.rows)) {
        expect(await ctx.db.get(rowId)).toBeNull();
      }
      for (const storageId of seeded.blobIds) {
        expect(await ctx.storage.get(storageId)).toBeNull();
        expect(await ctx.storage.getUrl(storageId)).toBeNull();
      }
    });
  });

  test("purgeOrphanScholarRows dry-runs, then deletes only orphan rows and blobs", async () => {
    const t = convexTest(schema, modules);
    const orphanScholarId = await seedUser(t, "orphan-practice");
    const liveScholarId = await seedUser(t, "live-practice");
    const orphan = await seedRepresentativePracticeRows(t, orphanScholarId);
    const live = await seedRepresentativePracticeRows(t, liveScholarId);
    await t.run((ctx) => ctx.db.delete(orphanScholarId));

    await expect(
      t.run((ctx) =>
        ctx.runMutation(internal.maintenance.purgeOrphanScholarRows, {}),
      ),
    ).rejects.toThrow(/explicit non-empty tables slice/);

    const dryRun = await t.run((ctx) =>
      ctx.runMutation(internal.maintenance.purgeOrphanScholarRows, {
        tables: [...REPRESENTATIVE_TABLES],
      }),
    );
    expect(dryRun.dryRun).toBe(true);
    expect(dryRun.scholarIds).toEqual([orphanScholarId]);
    for (const table of REPRESENTATIVE_TABLES) {
      expect(dryRun.perTable[table]).toEqual({
        orphanRows: 1,
        distinctScholars: 1,
      });
    }

    await t.run(async (ctx) => {
      for (const rowId of Object.values(orphan.rows)) {
        expect(await ctx.db.get(rowId)).not.toBeNull();
      }
      for (const storageId of orphan.blobIds) {
        expect(await ctx.storage.get(storageId)).not.toBeNull();
      }
    });

    const liveRun = await t.run((ctx) =>
      ctx.runMutation(internal.maintenance.purgeOrphanScholarRows, {
        dryRun: false,
        tables: [...REPRESENTATIVE_TABLES],
      }),
    );
    expect(liveRun.dryRun).toBe(false);
    expect(liveRun.scholarIds).toEqual([orphanScholarId]);

    await t.run(async (ctx) => {
      for (const rowId of Object.values(orphan.rows)) {
        expect(await ctx.db.get(rowId)).toBeNull();
      }
      for (const rowId of Object.values(live.rows)) {
        expect(await ctx.db.get(rowId)).not.toBeNull();
      }
      for (const storageId of orphan.blobIds) {
        expect(await ctx.storage.get(storageId)).toBeNull();
        expect(await ctx.storage.getUrl(storageId)).toBeNull();
      }
      for (const storageId of live.blobIds) {
        expect(await ctx.storage.get(storageId)).not.toBeNull();
        expect(await ctx.storage.getUrl(storageId)).not.toBeNull();
      }
      expect(await ctx.db.get(liveScholarId)).not.toBeNull();
    });
  });
});
