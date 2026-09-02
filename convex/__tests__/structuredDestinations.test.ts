import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { seedScholarInInstitution, seedStaffWithMembership, seedTestInstitution } from "./institutionTestHelpers";

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

describe("structured destinations (offer stars)", () => {
  test("opting into a structured star starts the unit's first online activity", async () => {
    const t = convexTest(schema, modules);
    const { scholar, unit, activity, seed } = await t.run(async (ctx) => {
      const teacher = await ctx.db.insert("users", {
        name: "T",
        username: "t",
        role: "teacher",
      });
      const scholar = await ctx.db.insert("users", {
        name: "S",
        username: "s",
        role: "scholar",
      });
      const unit = await ctx.db.insert("units", {
        teacherId: teacher,
        title: "Volcanoes",
        isActive: true,
      });
      const lesson = await ctx.db.insert("lessons", {
        unitId: unit,
        title: "L1",
        order: 0,
      });
      const activity = await ctx.db.insert("activities", {
        lessonId: lesson,
        title: "Kickoff",
        order: 0,
        kind: "online",
      });
      const seed = await ctx.db.insert("seeds", {
        scholarId: scholar,
        origin: "teacher",
        status: "active",
        topic: "Volcanoes",
        suggestionType: "teacher_suggestion",
        rationale: "offered",
        unitId: unit,
      });
      return { scholar, unit, activity, seed };
    });

    const asScholar = await asUser(t, scholar);
    const { id } = await asScholar.mutation(api.sessions.createFromSeed, {
      seedId: seed,
    });

    const session = await t.run(async (ctx) => ctx.db.get(id));
    expect(String(session?.unitId)).toBe(String(unit));
    expect(String(session?.activityId)).toBe(String(activity));
    expect(session?.title).toBe("Volcanoes");
  });

  test("opting into a bare proto-activity star stays anchorless", async () => {
    const t = convexTest(schema, modules);
    const { scholar, seed } = await t.run(async (ctx) => {
      const scholar = await ctx.db.insert("users", {
        name: "S",
        username: "s",
        role: "scholar",
      });
      const seed = await ctx.db.insert("seeds", {
        scholarId: scholar,
        origin: "ai",
        status: "active",
        topic: "Why is the sky blue?",
        suggestionType: "frontier",
        rationale: "curious",
      });
      return { scholar, seed };
    });

    const asScholar = await asUser(t, scholar);
    const { id } = await asScholar.mutation(api.sessions.createFromSeed, {
      seedId: seed,
    });
    const session = await t.run(async (ctx) => ctx.db.get(id));
    expect(session?.unitId).toBeUndefined();
    expect(session?.activityId).toBeUndefined();
    expect(session?.title).toBe("Why is the sky blue?");
  });

  test("teacher offer drops a star and is not double-surfaced as a card", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const teacher = await seedStaffWithMembership(t, { institutionId, name: "T", username: "t" });
    const scholar = await seedScholarInInstitution(t, { institutionId, name: "S", username: "s" });
    await t.run(async () => {
    });

    const asTeacher = await asUser(t, teacher);
    const { unitId } = await asTeacher.mutation(
      api.units.createAndOfferQuestForScholar,
      { scholarId: scholar, title: "Comics" },
    );

    // An offer star now points at that unit on the scholar's sky.
    const asScholar = await asUser(t, scholar);
    const sky = await asScholar.query(api.seeds.skyForSelf, {});
    const star = sky.seeds.find((s) => s.topic === "Comics");
    expect(star).toBeDefined();
    expect(star?.structured).toBe(true);

    // …and it is NOT also listed as a not-started IS-unit card.
    const cards = await asScholar.query(api.units.myIndependentStudyUnits, {});
    expect(cards.some((u) => String(u.unitId) === String(unitId))).toBe(false);
  });

  test("a scholar's own (un-offered) IS unit still shows as a card", async () => {
    const t = convexTest(schema, modules);
    const scholar = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "S", username: "s", role: "scholar" }),
    );
    const asScholar = await asUser(t, scholar);
    const { unitId } = await asScholar.mutation(
      api.units.createQuest,
      { title: "My Own Quest" },
    );
    const cards = await asScholar.query(api.units.myIndependentStudyUnits, {});
    expect(cards.some((u) => String(u.unitId) === String(unitId))).toBe(true);
  });
});
