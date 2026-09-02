import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { gameBeatKey } from "../lib/practice/gameBeats";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher",
  username: string,
) {
  const institutionId = await seedTestInstitution(t);
  return role === "scholar"
    ? seedScholarInInstitution(t, { institutionId, name: username, username })
    : seedStaffWithMembership(t, { institutionId, name: username, username });
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 3_600_000 }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

async function seedGameActivity(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  title = "Factor Game",
) {
  return t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", { teacherId, title: "Games", isActive: true });
    const lessonId = await ctx.db.insert("lessons", { unitId, title: "Games", order: 0 });
    return ctx.db.insert("activities", {
      lessonId,
      title,
      kind: "game",
      game: { gameId: "toy-warmer-colder" },
      order: 0,
    });
  });
}

function setup() {
  return convexTest(schema, modules);
}

describe("practiceGames — teacher bindings", () => {
  test("a curriculum author can bind a game activity to a strand", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const activityId = await seedGameActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    const res = await asTeacher.mutation(api.practiceGames.bindGameToStrand, {
      activityId,
      domain: "math",
      strand: "number-theory",
    });
    expect(res.mode).toBe("created");

    const bindings = await asTeacher.query(api.practiceGames.listGameBindings, {});
    expect(bindings).toHaveLength(1);
    expect(bindings[0].strand).toBe("number-theory");
    expect(bindings[0].isActive).toBe(true);
    expect(bindings[0].gameId).toBe("toy-warmer-colder");
  });

  test("rebinding the same activity+strand UPDATES rather than duplicating", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const activityId = await seedGameActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);

    await asTeacher.mutation(api.practiceGames.bindGameToStrand, {
      activityId,
      domain: "math",
      strand: "number-theory",
    });
    const again = await asTeacher.mutation(api.practiceGames.bindGameToStrand, {
      activityId,
      domain: "math",
      strand: "number-theory",
      blurb: "Try to beat it.",
    });
    expect(again.mode).toBe("updated");
    const bindings = await asTeacher.query(api.practiceGames.listGameBindings, {});
    expect(bindings).toHaveLength(1);
    expect(bindings[0].blurb).toBe("Try to beat it.");
  });

  test("a NON-game activity cannot be bound — refused at the moment it is made", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const activityId = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", { teacherId, title: "U", isActive: true });
      const lessonId = await ctx.db.insert("lessons", { unitId, title: "L", order: 0 });
      return ctx.db.insert("activities", {
        lessonId,
        title: "A conversation",
        kind: "online",
        order: 0,
      });
    });
    const asTeacher = await withUser(t, teacherId);
    await expect(
      asTeacher.mutation(api.practiceGames.bindGameToStrand, {
        activityId,
        domain: "math",
        strand: "number-theory",
      }),
    ).rejects.toThrow(/kind="game"/);
  });

  test("a scholar cannot create a binding", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const activityId = await seedGameActivity(t, teacherId);
    const asScholar = await withUser(t, scholarId);
    await expect(
      asScholar.mutation(api.practiceGames.bindGameToStrand, {
        activityId,
        domain: "math",
        strand: "number-theory",
      }),
    ).rejects.toThrow();
  });

  test("deactivating keeps the row and its configuration", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const activityId = await seedGameActivity(t, teacherId);
    const asTeacher = await withUser(t, teacherId);
    const { id } = await asTeacher.mutation(api.practiceGames.bindGameToStrand, {
      activityId,
      domain: "math",
      strand: "number-theory",
      blurb: "keep me",
    });
    await asTeacher.mutation(api.practiceGames.setGameBindingActive, {
      bindingId: id,
      isActive: false,
    });
    const bindings = await asTeacher.query(api.practiceGames.listGameBindings, {});
    expect(bindings[0].isActive).toBe(false);
    expect(bindings[0].blurb).toBe("keep me");
  });
});

describe("practiceGames — offer lifecycle", () => {
  test("claiming is idempotent within a scholar-local day", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const activityId = await seedGameActivity(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    expect((await asScholar.mutation(api.practiceGames.claimGameBeatOffer, { activityId })).claimed)
      .toBe(true);
    // A remount is not a new offer — otherwise a reload would burn the
    // scholar's re-offer allowance.
    expect((await asScholar.mutation(api.practiceGames.claimGameBeatOffer, { activityId })).claimed)
      .toBe(false);

    const offers = await asScholar.query(api.practiceGames.offersForScholar, { scholarId });
    expect(offers).toHaveLength(1);
    expect(offers[0].offerCount).toBe(1);
    expect(offers[0].key).toBe(gameBeatKey(String(activityId)));
  });

  test("declining then accepting clears the decline", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const activityId = await seedGameActivity(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    await asScholar.mutation(api.practiceGames.claimGameBeatOffer, { activityId });
    await asScholar.mutation(api.practiceGames.declineGameBeat, { activityId });
    let offers = await asScholar.query(api.practiceGames.offersForScholar, { scholarId });
    expect(offers[0].declinedAt).not.toBeNull();

    await asScholar.mutation(api.practiceGames.acceptGameBeat, { activityId });
    offers = await asScholar.query(api.practiceGames.offersForScholar, { scholarId });
    expect(offers[0].declinedAt).toBeNull();
    expect(offers[0].lastAcceptedAt).not.toBeNull();
  });

  test("declining an unoffered game is a no-op, not an error", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const activityId = await seedGameActivity(t, teacherId);
    const asScholar = await withUser(t, scholarId);
    expect((await asScholar.mutation(api.practiceGames.declineGameBeat, { activityId })).recorded)
      .toBe(false);
  });

  test("a scholar cannot read another scholar's offers", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const otherId = await seedUser(t, "scholar", "s2");
    const activityId = await seedGameActivity(t, teacherId);
    const asOther = await withUser(t, otherId);
    await asOther.mutation(api.practiceGames.claimGameBeatOffer, { activityId });
    const asScholar = await withUser(t, scholarId);
    await expect(
      asScholar.query(api.practiceGames.offersForScholar, { scholarId: otherId }),
    ).rejects.toThrow();
  });

  test("offers write NOTHING to mastery or the practice scheduler (D-3)", async () => {
    // The load-bearing assertion of the whole beat model: a beat lives beside
    // `items`, never inside it, so the entire offer lifecycle must be incapable
    // of producing an attempt row or moving a skill.
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const activityId = await seedGameActivity(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    await asScholar.mutation(api.practiceGames.claimGameBeatOffer, { activityId });
    await asScholar.mutation(api.practiceGames.acceptGameBeat, { activityId });
    await asScholar.mutation(api.games.start, { activityId });
    await asScholar.mutation(api.practiceGames.declineGameBeat, { activityId });

    const { attempts, mastery, observations } = await t.run(async (ctx) => ({
      attempts: await ctx.db.query("practiceAttempts").collect(),
      mastery: await ctx.db.query("practiceMastery").collect(),
      observations: await ctx.db.query("masteryObservations").collect(),
    }));
    expect(attempts).toHaveLength(0);
    expect(mastery).toHaveLength(0);
    expect(observations).toHaveLength(0);
  });
});

describe("practiceSkills.practiceSession — the game beat sidecar", () => {
  // The REAL graph, seeded the way every other practice test does it. A fresh
  // grade-5 scholar's whole-number run leads with `counting` frontier work, so
  // that is the strand a binding must cover to land on item 0.
  const RUN_DOMAIN = "whole-number-arithmetic";
  const RUN_STRAND = "counting";

  async function seedPracticeGraph(t: ReturnType<typeof convexTest>) {
    await t.mutation(internal.practiceSkills.seedGraph, {});
    await t.mutation(internal.practiceSkills.seedDefaultManipulativePractice, {});
  }

  async function seedScholar(t: ReturnType<typeof convexTest>, username: string) {
    const scholarId = await seedScholarInInstitution(t, {
      institutionId: await seedTestInstitution(t),
      name: username,
      username,
    });
    await t.run((ctx) => ctx.db.patch(scholarId, { gradeLevel: "5" }));
    return scholarId;
  }

  test("no beat is served to a client that cannot play one (D-5, at selection)", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedScholar(t, "s1");
    const activityId = await seedGameActivity(t, teacherId);
    await seedPracticeGraph(t);
    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.practiceGames.bindGameToStrand, {
      activityId,
      domain: RUN_DOMAIN,
      strand: RUN_STRAND,
    });

    const asScholar = await withUser(t, scholarId);
    // Web: omits `canPlayGames` entirely. The offer is never spent on a doorway
    // that cannot open, so the iPad still finds it available.
    const web = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId,
      seed: 3,
      domain: RUN_DOMAIN,
    });
    expect((web as { gameBeat?: unknown }).gameBeat).toBeUndefined();
  });

  test("a bound game is served as a sidecar, never as an item", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedScholar(t, "s1");
    const activityId = await seedGameActivity(t, teacherId);
    await seedPracticeGraph(t);
    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.practiceGames.bindGameToStrand, {
      activityId,
      domain: RUN_DOMAIN,
      strand: RUN_STRAND,
      blurb: "See if you can beat it.",
    });

    const asScholar = await withUser(t, scholarId);
    const run = (await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId,
      seed: 3,
      domain: RUN_DOMAIN,
      canPlayGames: true,
    })) as {
      items: { skillKey: string }[];
      gameBeat?: { at: number; entry: Record<string, unknown> };
    };

    expect(run.gameBeat).toBeDefined();
    const beat = run.gameBeat!;
    expect(beat.entry.kind).toBe("game_beat");
    expect(beat.entry.masteryEffect).toBe("none");
    expect(beat.entry.platform).toBe("native");
    expect(beat.entry.title).toBe("Factor Game");
    expect(beat.entry.blurb).toBe("See if you can beat it.");
    expect(beat.entry.activityId).toBe(String(activityId));

    // Position correctness: the beat names the strand of the item it sits on,
    // by construction rather than by hope.
    expect(beat.at).toBeGreaterThanOrEqual(0);
    expect(beat.at).toBeLessThan(run.items.length);
    // And it is NOT in the graded array — nothing about `items` changed.
    expect(run.items.every((it) => typeof it.skillKey === "string")).toBe(true);
  });

  test("an INACTIVE binding serves nothing", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedScholar(t, "s1");
    const activityId = await seedGameActivity(t, teacherId);
    await seedPracticeGraph(t);
    const asTeacher = await withUser(t, teacherId);
    const { id } = await asTeacher.mutation(api.practiceGames.bindGameToStrand, {
      activityId,
      domain: RUN_DOMAIN,
      strand: RUN_STRAND,
    });
    await asTeacher.mutation(api.practiceGames.setGameBindingActive, {
      bindingId: id,
      isActive: false,
    });

    const asScholar = await withUser(t, scholarId);
    const run = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId,
      seed: 3,
      domain: RUN_DOMAIN,
      canPlayGames: true,
    });
    expect((run as { gameBeat?: unknown }).gameBeat).toBeUndefined();
  });

  test("a TEACHER reading the run is served no beat — it would spend the scholar's offer", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedScholar(t, "s1");
    const activityId = await seedGameActivity(t, teacherId);
    await seedPracticeGraph(t);
    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.practiceGames.bindGameToStrand, {
      activityId,
      domain: RUN_DOMAIN,
      strand: RUN_STRAND,
    });
    const run = await asTeacher.query(api.practiceSkills.practiceSession, {
      scholarId,
      seed: 3,
      domain: RUN_DOMAIN,
      canPlayGames: true,
    });
    expect((run as { gameBeat?: unknown }).gameBeat).toBeUndefined();
  });

  test("a binding whose activity was deleted silently offers nothing", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedScholar(t, "s1");
    const activityId = await seedGameActivity(t, teacherId);
    await seedPracticeGraph(t);
    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.practiceGames.bindGameToStrand, {
      activityId,
      domain: RUN_DOMAIN,
      strand: RUN_STRAND,
    });
    await t.run(async (ctx) => ctx.db.delete(activityId));

    const asScholar = await withUser(t, scholarId);
    const run = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId,
      seed: 3,
      domain: RUN_DOMAIN,
      canPlayGames: true,
    });
    // Never a broken doorway.
    expect((run as { gameBeat?: unknown }).gameBeat).toBeUndefined();
  });

  test("a just-played game is on cooldown and is not re-offered", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedScholar(t, "s1");
    const activityId = await seedGameActivity(t, teacherId);
    await seedPracticeGraph(t);
    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.practiceGames.bindGameToStrand, {
      activityId,
      domain: RUN_DOMAIN,
      strand: RUN_STRAND,
    });

    const asScholar = await withUser(t, scholarId);
    await asScholar.mutation(api.games.start, { activityId });

    const run = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId,
      seed: 3,
      domain: RUN_DOMAIN,
      canPlayGames: true,
    });
    expect((run as { gameBeat?: unknown }).gameBeat).toBeUndefined();
  });
});
