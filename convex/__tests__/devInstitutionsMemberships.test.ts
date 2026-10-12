import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Why this file: staff scoping reads the active membership, so a seeded teacher
// without one sees no scholars. The dev seed used to rely on a separate
// membership backfill that only the private seed script ran; a fresh local
// run (`pnpm local:setup`) left every seeded teacher with an empty roster.

describe("seedDevInstitutions gives seeded users their default memberships", () => {
  test("teacher joins the dev primary school, scholar its assigned one, idempotently", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarId } = await t.run(async (ctx) => ({
      teacherId: await ctx.db.insert("users", { name: "T", username: "t", role: "teacher" }),
      scholarId: await ctx.db.insert("users", { name: "S", username: "s", role: "scholar" }),
    }));

    const seed = () => t.mutation(internal.seed.institutions.seedDevInstitutions, {});
    await seed();
    await seed();

    await t.run(async (ctx) => {
      const primary = (await ctx.db.query("institutions").collect()).find((i) => i.isPrimary);
      const memberships = await ctx.db.query("memberships").collect();
      const of = (userId: typeof teacherId) => memberships.filter((m) => m.userId === userId);
      expect(of(teacherId).map((m) => [m.role, m.institutionId])).toEqual([["teacher", primary?._id]]);
      expect(of(scholarId).map((m) => [m.role, m.institutionId])).toEqual([["scholar", primary?._id]]);
    });
  });
});
