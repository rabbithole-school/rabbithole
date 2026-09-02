import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function asUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

/**
 * Regression guard for the doc-view EQ/EU editor gate. `units.setGranules`
 * is the ONLY path the curriculum document view uses to edit Essential
 * Questions / Enduring Understandings, and it must admit the same
 * curriculum roles as every other unit-edit mutation (via
 * requireUnitEditAccess) — not the stricter teacher-only set. A
 * `curriculum_designer` can edit the unit's title/description/prose, so
 * they must be able to edit its granules too.
 */
describe("units.setGranules edit gate", () => {
  test("a curriculum_designer may edit EQ/EU", async () => {
    const t = convexTest(schema, modules);
    const { designer, unit } = await t.run(async (ctx) => {
      const designer = await ctx.db.insert("users", {
        name: "D",
        username: "designer",
        role: "curriculum_designer",
      });
      const teacher = await ctx.db.insert("users", {
        name: "T",
        username: "teacher",
        role: "teacher",
      });
      const unit = await ctx.db.insert("units", {
        teacherId: teacher,
        title: "Flight Lab",
        isActive: true,
      });
      return { designer, unit };
    });

    const asDesigner = await asUser(t, designer);
    await expect(
      asDesigner.mutation(api.units.setGranules, {
        id: unit,
        essentialQuestions: [{ text: "Why do birds fly?" }],
      }),
    ).resolves.toBeNull();

    const stored = await t.run(async (ctx) => {
      const u = await ctx.db.get(unit);
      return u?.essentialQuestions ?? [];
    });
    expect(
      (stored as Array<{ text: string }>).some(
        (g) => g.text === "Why do birds fly?",
      ),
    ).toBe(true);
  });

  test("a non-author scholar may NOT edit EQ/EU", async () => {
    const t = convexTest(schema, modules);
    const { scholar, unit } = await t.run(async (ctx) => {
      const teacher = await ctx.db.insert("users", {
        name: "T",
        username: "teacher",
        role: "teacher",
      });
      const scholar = await ctx.db.insert("users", {
        name: "S",
        username: "scholar",
        role: "scholar",
      });
      const unit = await ctx.db.insert("units", {
        teacherId: teacher,
        title: "Flight Lab",
        isActive: true,
      });
      return { scholar, unit };
    });

    const asScholar = await asUser(t, scholar);
    await expect(
      asScholar.mutation(api.units.setGranules, {
        id: unit,
        essentialQuestions: [{ text: "Sneaky edit" }],
      }),
    ).rejects.toThrow(/forbidden/i);
  });
});
