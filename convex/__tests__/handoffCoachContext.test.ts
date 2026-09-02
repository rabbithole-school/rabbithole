import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  resolveCoachAgeBand,
  resolveCoachSkillStatus,
  resolveScholarCoachContext,
} from "../lib/practice/handoff";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const NOW = Date.UTC(2026, 6, 27);

describe("scholar coach context", () => {
  test("maps canonical mastery states, including provisional access", () => {
    expect(resolveCoachSkillStatus(undefined, NOW)).toBe("brand_new");
    expect(
      resolveCoachSkillStatus(
        { repetition: 0, source: "practice", halfLifeDays: 10 },
        NOW,
      ),
    ).toBe("brand_new");
    expect(
      resolveCoachSkillStatus(
        {
          repetition: 5,
          source: "scaffolded",
          halfLifeDays: 100,
          lastPracticedAt: NOW,
        },
        NOW,
      ),
    ).toBe("still_building");
    expect(
      resolveCoachSkillStatus(
        {
          repetition: 3,
          source: "practice",
          halfLifeDays: 1,
          lastPracticedAt: NOW - 30 * 86_400_000,
        },
        NOW,
      ),
    ).toBe("had_it_rusty");
    expect(
      resolveCoachSkillStatus(
        {
          repetition: 3,
          source: "practice",
          halfLifeDays: 100,
          lastPracticedAt: NOW,
        },
        NOW,
      ),
    ).toBe("solid_bad_day");
  });

  test("derives coarse age bands from DOB, then grade fallback", () => {
    expect(resolveCoachAgeBand("2018-08-01", "8", NOW)).toBe("6-8");
    expect(resolveCoachAgeBand(undefined, "6", NOW)).toBe("9-11");
    expect(resolveCoachAgeBand(undefined, "9", NOW)).toBe("12-14");
    expect(resolveCoachAgeBand(undefined, undefined, NOW)).toBeUndefined();
  });

  test("returns only low-cardinality context", () => {
    expect(
      resolveScholarCoachContext({
        scholar: {
          dateOfBirth: "2018-08-01",
          gradeLevel: "2",
          readingLevel: "4.3",
        },
        mastery: {
          repetition: 5,
          source: "scaffolded",
          halfLifeDays: 100,
          lastPracticedAt: NOW,
        },
        skillKey: "count_to_10",
        entryMode: "ladder",
        now: NOW,
      }),
    ).toEqual({
      ageBand: "6-8",
      readingLevel: "4.3",
      skillStatus: "still_building",
      entryMode: "ladder",
    });
  });
});

describe("scholarCoachContext authorization", () => {
  async function seedUser(
    t: ReturnType<typeof convexTest>,
    role: "scholar" | "teacher",
    username: string,
    institutionId?: Id<"institutions">,
  ): Promise<Id<"users">> {
    return t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: username,
        username,
        role,
        gradeLevel: "3",
        readingLevel: "3.5",
        institutionId,
      }),
    );
  }

  test("allows self and an in-scope teacher, rejects other callers", async () => {
    const t = convexTest(schema, modules);
    const [firstInstitution, secondInstitution] = await t.run(async (ctx) => [
      await ctx.db.insert("institutions", {
        name: "First School",
        slug: "first-school",
        kind: "school",
      }),
      await ctx.db.insert("institutions", {
        name: "Second School",
        slug: "second-school",
        kind: "school",
      }),
    ]);
    const scholar = await seedUser(
      t,
      "scholar",
      "context_scholar",
      firstInstitution,
    );
    const stranger = await seedUser(t, "scholar", "context_stranger");
    const teacher = await seedUser(
      t,
      "teacher",
      "context_teacher",
      firstInstitution,
    );
    const outOfScopeTeacher = await seedUser(
      t,
      "teacher",
      "context_other_teacher",
      secondInstitution,
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("memberships", {
        userId: teacher,
        role: "teacher",
        institutionId: firstInstitution,
      });
      await ctx.db.insert("memberships", {
        userId: outOfScopeTeacher,
        role: "teacher",
        institutionId: secondInstitution,
      });
    });

    const self = await t.run(async (ctx) =>
      ctx.runQuery(internal.practiceSkills.scholarCoachContext, {
        callerUserId: scholar,
        scholarId: scholar,
        skillKey: "count_to_10",
        entryMode: "spiral",
        now: NOW,
      }),
    );
    expect(self).toMatchObject({
      ageBand: "6-8",
      readingLevel: "3.5",
      skillStatus: "brand_new",
      entryMode: "spiral",
    });

    await expect(
      t.run(async (ctx) =>
        ctx.runQuery(internal.practiceSkills.scholarCoachContext, {
          callerUserId: stranger,
          scholarId: scholar,
          now: NOW,
        }),
      ),
    ).rejects.toThrow("Forbidden");

    await expect(
      t.run(async (ctx) =>
        ctx.runQuery(internal.practiceSkills.scholarCoachContext, {
          callerUserId: teacher,
          scholarId: scholar,
          entryMode: "game",
          now: NOW,
        }),
      ),
    ).resolves.toMatchObject({
      readingLevel: "3.5",
      entryMode: "game",
    });

    await expect(
      t.run(async (ctx) =>
        ctx.runQuery(internal.practiceSkills.scholarCoachContext, {
          callerUserId: outOfScopeTeacher,
          scholarId: scholar,
          now: NOW,
        }),
      ),
    ).rejects.toThrow("Forbidden: scholar is not in your current context");
  });
});
