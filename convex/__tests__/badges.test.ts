import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { grantInstitutionMembership, seedTestInstitution } from "./institutionTestHelpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { buildBadgePrompt } from "../lib/badgeArt";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// ── buildBadgePrompt: pure, deterministic ─────────────────────────────

describe("buildBadgePrompt", () => {
  test("patch style is a wordless embroidered mission patch themed on the title", () => {
    const p = buildBadgePrompt({
      unitTitle: "Aquaponics QUEST",
      description: "Fish and plants grow together.",
      subject: "science",
      style: "patch",
      colorway: "auto",
    });
    expect(p).toContain("embroidered");
    expect(p).toContain("mission patch");
    // The title is used as theme context for the imagery…
    expect(p).toContain("Aquaponics QUEST");
    expect(p).toContain("science");
    expect(p).toContain("Fish and plants grow together");
    // …but the badge itself must be wordless (no banner text to garble).
    expect(p).toContain("NO text");
    expect(p).not.toContain("ribbon banner");
  });

  test("medallion style is the metallic award medallion, also wordless", () => {
    const p = buildBadgePrompt({
      unitTitle: "Prime Numbers",
      style: "medallion",
      colorway: "auto",
    });
    expect(p).toContain("medallion");
    expect(p).toContain("Prime Numbers");
    expect(p).toContain("NO text");
    // no embossed ring-text instruction anymore
    expect(p).not.toContain("embossed in a clean ring");
  });

  test("colorway injects its palette phrase", () => {
    const gold = buildBadgePrompt({
      unitTitle: "X",
      style: "patch",
      colorway: "gold",
    });
    expect(gold).toContain("gold and bronze");
    const violet = buildBadgePrompt({
      unitTitle: "X",
      style: "patch",
      colorway: "violet",
    });
    expect(violet).toContain("violet and magenta");
  });

  test("the prompt forbids lettering for any title", () => {
    const p = buildBadgePrompt({
      unitTitle: "A Really Very Long Unit Title That Would Garble In A Banner",
      style: "patch",
      colorway: "auto",
    });
    expect(p).toContain("NO letters");
    expect(p).toContain("wordless emblem");
  });
});

// ── customizeBadge: ownership + remix-budget guards ───────────────────

async function seedScholar(
  t: ReturnType<typeof convexTest>,
  username: string,
) {
  const institutionId = await seedTestInstitution(t);
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: username, username, role: "scholar" }),
  );

  await t.run((ctx) => ctx.db.patch(userId, { institutionId }));
  return userId;
}

async function asScholar(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedBadge(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      title: "Test Unit",
      isActive: true,
      teacherId: scholarId, // arbitrary; unused by customizeBadge
      badgeOnCompletion: { title: "Test Unit — completed", icon: "🏅" },
    } as never);
    return ctx.db.insert("scholarUnitBadges", {
      scholarId,
      unitId,
      earnedAt: Date.now(),
      badgeSnapshot: { title: "Test Unit — completed", icon: "🏅" },
      style: "patch",
      colorway: "auto",
      artStatus: "ready",
      rerollsUsed: 0,
    });
  });
}

describe("customizeBadge", () => {
  test("a remix applies the choices, marks it generating, and spends the budget", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "owner");
    const badgeId = await seedBadge(t, scholarId);

    const res = await (
      await asScholar(t, scholarId)
    ).mutation(api.badges.customizeBadge, {
      badgeId,
      style: "medallion",
      colorway: "violet",
    });
    expect(res.ok).toBe(true);
    expect(res.rerollsRemaining).toBe(0);

    const row = await t.run((ctx) => ctx.db.get(badgeId));
    expect(row?.style).toBe("medallion");
    expect(row?.colorway).toBe("violet");
    expect(row?.rerollsUsed).toBe(1);
    expect(row?.artStatus).toBe("generating");
  });

  test("a second remix is rejected once the budget is spent", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "owner2");
    const badgeId = await seedBadge(t, scholarId);
    const me = await asScholar(t, scholarId);

    await me.mutation(api.badges.customizeBadge, {
      badgeId,
      style: "medallion",
      colorway: "gold",
    });
    await expect(
      me.mutation(api.badges.customizeBadge, {
        badgeId,
        style: "patch",
        colorway: "mint",
      }),
    ).rejects.toThrow(/no remixes left/i);
  });

  test("a scholar cannot remix someone else's badge", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await seedScholar(t, "owner3");
    const badgeId = await seedBadge(t, ownerId);
    const intruderId = await seedScholar(t, "intruder");

    await expect(
      (
        await asScholar(t, intruderId)
      ).mutation(api.badges.customizeBadge, {
        badgeId,
        style: "patch",
        colorway: "gold",
      }),
    ).rejects.toThrow(/not your badge/i);
  });

  test("an unknown style is rejected", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "owner4");
    const badgeId = await seedBadge(t, scholarId);

    await expect(
      (
        await asScholar(t, scholarId)
      ).mutation(api.badges.customizeBadge, {
        badgeId,
        style: "rainbow",
        colorway: "gold",
      }),
    ).rejects.toThrow(/unknown badge style/i);
  });
});

// ── awardUnitBadge: teacher-facing manual award ───────────────────────

async function seedTeacher(
  t: ReturnType<typeof convexTest>,
  username: string,
) {
  const institutionId = await seedTestInstitution(t);
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { name: username, username, role: "teacher" }),
  );

  await grantInstitutionMembership(t, userId, institutionId);
  return userId;
}

async function seedAwardUnit(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("units", {
      title: "Vacuum Science",
      description: "What happens to water in a vacuum.",
      emoji: "🚀",
      isActive: true,
      teacherId,
      badgeOnCompletion: { title: "Vacuum Science — completed", icon: "🏅" },
    } as never),
  );
}

describe("awardUnitBadge", () => {
  test("a teacher mints the badge + schedules art, defaulting the snapshot to the unit", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t, "teacher");
    const scholarId = await seedScholar(t, "scholar");
    const unitId = await seedAwardUnit(t, teacherId);

    const res = await (
      await asScholar(t, teacherId)
    ).mutation(api.badges.awardUnitBadge, { scholarId, unitId });
    expect(res.alreadyEarned).toBe(false);

    const row = await t.run((ctx) => ctx.db.get(res.badgeId));
    expect(row?.scholarId).toBe(scholarId);
    expect(row?.unitId).toBe(unitId);
    expect(row?.artStatus).toBe("generating");
    expect(row?.style).toBe("patch");
    expect(row?.colorway).toBe("auto");
    expect(row?.badgeSnapshot.title).toBe("Vacuum Science — completed");
  });

  test("override args make an extra-special badge (style + colorway + snapshot)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t, "teacher2");
    const scholarId = await seedScholar(t, "scholar2");
    const unitId = await seedAwardUnit(t, teacherId);

    const res = await (
      await asScholar(t, teacherId)
    ).mutation(api.badges.awardUnitBadge, {
      scholarId,
      unitId,
      style: "medallion",
      colorway: "violet",
      title: "Vacuum Voyager ✨",
      description: "For pioneering what water does in the void.",
    });

    const row = await t.run((ctx) => ctx.db.get(res.badgeId));
    expect(row?.style).toBe("medallion");
    expect(row?.colorway).toBe("violet");
    expect(row?.badgeSnapshot.title).toBe("Vacuum Voyager ✨");
    expect(row?.badgeSnapshot.description).toBe(
      "For pioneering what water does in the void.",
    );
  });

  test("an unknown colorway falls back to the default rather than throwing", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t, "teacher3");
    const scholarId = await seedScholar(t, "scholar3");
    const unitId = await seedAwardUnit(t, teacherId);

    const res = await (
      await asScholar(t, teacherId)
    ).mutation(api.badges.awardUnitBadge, {
      scholarId,
      unitId,
      colorway: "chartreuse",
    });
    const row = await t.run((ctx) => ctx.db.get(res.badgeId));
    expect(row?.colorway).toBe("auto");
  });

  test("it is idempotent per (scholar, unit) — no duplicate row", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t, "teacher4");
    const scholarId = await seedScholar(t, "scholar4");
    const unitId = await seedAwardUnit(t, teacherId);
    const teacher = await asScholar(t, teacherId);

    const first = await teacher.mutation(api.badges.awardUnitBadge, {
      scholarId,
      unitId,
    });
    const second = await teacher.mutation(api.badges.awardUnitBadge, {
      scholarId,
      unitId,
    });
    expect(second.alreadyEarned).toBe(true);
    expect(second.badgeId).toBe(first.badgeId);

    const rows = await t.run((ctx) =>
      ctx.db
        .query("scholarUnitBadges")
        .withIndex("by_scholar_unit", (q) =>
          q.eq("scholarId", scholarId).eq("unitId", unitId),
        )
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });

  test("awarding to a non-scholar is rejected", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t, "teacher5");
    const otherTeacherId = await seedTeacher(t, "not-a-scholar");
    const institutionId = await seedTestInstitution(t);
    await t.run((ctx) => ctx.db.patch(otherTeacherId, { institutionId }));
    const unitId = await seedAwardUnit(t, teacherId);

    await expect(
      (
        await asScholar(t, teacherId)
      ).mutation(api.badges.awardUnitBadge, {
        scholarId: otherTeacherId,
        unitId,
      }),
    ).rejects.toThrow(/not a scholar|Forbidden/i);
  });

  test("a scholar cannot award badges (teacher-gated)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t, "teacher6");
    const scholarId = await seedScholar(t, "scholar6");
    const unitId = await seedAwardUnit(t, teacherId);

    await expect(
      (
        await asScholar(t, scholarId)
      ).mutation(api.badges.awardUnitBadge, { scholarId, unitId }),
    ).rejects.toThrow();
  });
});

describe("badge award on completion", () => {
  test("the manual markComplete path mints the badge when it finishes the unit", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "finisher");

    // A unit that offers a badge, with one online activity in one lesson.
    const { unitId, activityId } = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        title: "Badge Unit",
        isActive: true,
        teacherId: scholarId,
        badgeOnCompletion: { title: "Badge Unit — completed", icon: "🏆" },
      } as never);
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "L1",
        order: 0,
      } as never);
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "A1",
        kind: "online",
        order: 0,
      } as never);
      return { unitId, activityId };
    });

    // No badge before completing.
    const before = await t.run((ctx) =>
      ctx.db
        .query("scholarUnitBadges")
        .withIndex("by_scholar_unit", (q) =>
          q.eq("scholarId", scholarId).eq("unitId", unitId),
        )
        .first(),
    );
    expect(before).toBeNull();

    // The scholar marks the (only) activity complete via the manual toggle.
    await (
      await asScholar(t, scholarId)
    ).mutation(api.activityCompletions.markComplete, { activityId });

    // Badge minted, art generation pending.
    const after = await t.run((ctx) =>
      ctx.db
        .query("scholarUnitBadges")
        .withIndex("by_scholar_unit", (q) =>
          q.eq("scholarId", scholarId).eq("unitId", unitId),
        )
        .first(),
    );
    expect(after).not.toBeNull();
    expect(after?.artStatus).toBe("generating");
  });
});
