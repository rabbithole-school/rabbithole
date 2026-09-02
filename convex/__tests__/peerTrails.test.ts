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

async function scholar(
  t: ReturnType<typeof convexTest>,
  username: string,
  name: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name, username, role: "scholar" }),
  );
}

async function unit(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  title: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("units", { teacherId, title, emoji: "📘", isActive: true }),
  );
}

async function badge(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  unitId: Id<"units">,
  earnedAt: number,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("scholarUnitBadges", {
      scholarId,
      unitId,
      earnedAt,
      badgeSnapshot: { title: "Badge", icon: "🏆" },
    });
  });
}

async function asScholar(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId: scholarId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${scholarId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

describe("peer trails (social proof)", () => {
  test("surfaces pod-mates' badges the scholar hasn't done, ranked by earners", async () => {
    const t = convexTest(schema, modules);
    const teacher = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "T", username: "t", role: "teacher" }),
    );

    const me = await scholar(t, "me", "Me Scholar");
    const b = await scholar(t, "b", "Bea Pod");
    const c = await scholar(t, "c", "Cy Pod");
    const outsider = await scholar(t, "out", "Otto Outsider");

    // me, b, c share a pod; outsider is in a different group.
    await t.run(async (ctx) => {
      await ctx.db.insert("scholarGroups", {
        teacherId: teacher,
        name: "Honu",
        emoji: "🐢",
        scholarIds: [me, b, c],
      });
      await ctx.db.insert("scholarGroups", {
        teacherId: teacher,
        name: "Other",
        scholarIds: [outsider],
      });
      await ctx.db.insert("scholarGroups", {
        teacherId: teacher,
        name: "Grade 3-5 schedule",
        scholarIds: [me, outsider],
      });
    });

    const unitX = await unit(t, teacher, "Game Theory");
    const unitY = await unit(t, teacher, "Vampire Bats");
    const unitZ = await unit(t, teacher, "Already Mine");
    const unitW = await unit(t, teacher, "Outsider Only");

    // X earned by both pod-mates (2 earners) → should rank first.
    await badge(t, b, unitX, 100);
    await badge(t, c, unitX, 200);
    // Y earned by one pod-mate.
    await badge(t, b, unitY, 150);
    // Z earned by a pod-mate AND by me → excluded (already mine).
    await badge(t, b, unitZ, 120);
    await badge(t, me, unitZ, 130);
    // W earned only by an outsider (not my pod) → excluded.
    await badge(t, outsider, unitW, 140);

    const asMe = await asScholar(t, me);
    const { trails, group } = await asMe.query(api.trophyCase.trailsForScholar, {});

    expect(group).toEqual({ name: "Honu", emoji: "🐢" });
    const titles = trails.map((tr) => tr.unitTitle);
    expect(titles).toEqual(["Game Theory", "Vampire Bats"]);
    expect(trails[0].earnerCount).toBe(2);
    expect(trails[1].earnerCount).toBe(1);
    // Already-mine + outsider units never appear.
    expect(titles).not.toContain("Already Mine");
    expect(titles).not.toContain("Outsider Only");
  });

  test("a started unit is not re-offered as a trail", async () => {
    const t = convexTest(schema, modules);
    const teacher = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "T", username: "t", role: "teacher" }),
    );
    const me = await scholar(t, "me", "Me");
    const mate = await scholar(t, "mate", "Mate");
    await t.run(async (ctx) => {
      await ctx.db.insert("scholarGroups", {
        teacherId: teacher,
        name: "Pod",
        scholarIds: [me, mate],
      });
    });
    const u = await unit(t, teacher, "Shared Topic");
    await badge(t, mate, u, 100);
    // I already started a session in that unit → already on my plate.
    await t.run(async (ctx) => {
      await ctx.db.insert("sessions", {
        userId: me,
        unitId: u,
        title: "Shared Topic",
        isArchived: false,
      });
    });

    const asMe = await asScholar(t, me);
    const { trails } = await asMe.query(api.trophyCase.trailsForScholar, {});
    expect(trails).toHaveLength(0);
  });

  test("followBadgeSelf plants a star on the scholar's own map, idempotently", async () => {
    const t = convexTest(schema, modules);
    const me = await scholar(t, "me", "Me");
    const asMe = await asScholar(t, me);

    const first = await asMe.mutation(api.seeds.followBadgeSelf, {
      topic: "Game Theory",
      inspiredByName: "Bea",
    });
    expect(first.alreadyFollowing).toBe(false);

    const again = await asMe.mutation(api.seeds.followBadgeSelf, {
      topic: "Game Theory",
      inspiredByName: "Bea",
    });
    expect(again.alreadyFollowing).toBe(true);
    expect(again.id).toBe(first.id);

    const sky = await asMe.query(api.seeds.skyForSelf, {});
    expect(sky.seeds.some((s) => s.topic === "Game Theory")).toBe(true);
  });
});
