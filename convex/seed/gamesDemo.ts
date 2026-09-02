// Seeds ONE tiny unit whose only job is to prove decision D-4 needs no new
// concept: **"game then debrief" is an ordinary lesson containing two
// activities.**
//
// That decision is easy to state and easy to quietly walk back — the pull
// toward "the game should end with a reflection screen" is strong, and every
// version of that pull adds a debrief PHASE inside the game runtime, which then
// needs its own prompt plumbing, its own completion semantics, and its own
// place in the maturity model. None of that is necessary. Rabbithole already
// has `units → lessons → activities`, and a lesson's default selection mode is
// `sequence` — a linear ladder. So the whole feature is: put the game first and
// an ordinary `online` conversation second, in the same lesson, in order.
//
// This fixture is the proof, and it is deliberately the ONLY thing in it. There
// is no game-specific field on the lesson, no `debriefActivityId` on the game
// activity, and no seed helper that games need and other activities don't. If a
// future change makes this file need one, that is the signal that D-4 is being
// eroded.
//
// The debrief tutor receives the round's DIGEST as deterministic context
// (`sessionHelpers` → `renderDigestForModel`), never raw game state. The
// interaction posture is still that the scholar tells the story: the prompt
// instructs the tutor to elicit the moment their model changed, not narrate the
// server record back to them. See the integration review (2026-07-27).
//
// Dev fixture. Idempotent by slug — running it twice inserts nothing.
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";

const UNIT_SLUG = "games-platform-demo";

/**
 * Insert the games-platform demo unit and its lessons, owned by `teacherId`.
 *
 * Idempotent PER LESSON, not per unit. That distinction is load-bearing and was
 * learned the hard way: this used to bail whole if the unit existed, so when the
 * fixture grew a second lesson, no dev deployment that had ever run it could
 * receive the new one — the seed silently reported success and delivered
 * nothing. A fixture you cannot re-run after you change it is not a fixture.
 *
 * Returns the number of lessons created (0 when everything already exists).
 */
export async function insertGamesDemoUnit(
  ctx: MutationCtx,
  teacherId: Id<"users">,
): Promise<number> {
  const existingUnit = await ctx.db
    .query("units")
    .withIndex("by_slug", (q) => q.eq("slug", UNIT_SLUG))
    .first();

  const unitId =
    existingUnit?._id ??
    (await ctx.db.insert("units", {
    teacherId,
    title: "Games platform demo",
    slug: UNIT_SLUG,
    emoji: "🎲",
    subject: "Other",
    description:
      "A dev fixture for the games platform. One lesson: play a toy game on the iPad, then talk about it. Not real curriculum — delete it when the first real game ships.",
    isActive: true,
    }));

  const lessons = await ctx.db
    .query("lessons")
    .withIndex("by_unit", (q) => q.eq("unitId", unitId))
    .collect();
  const hasLesson = (title: string) => lessons.some((l) => l.title === title);
  let created = 0;

  // ── Lesson 1: the toy game, then a debrief ────────────────────────────────
  // Default selection mode (absent) === "sequence": a linear ladder. THIS is
  // the whole "game then debrief" mechanism. Nothing else is required.
  if (!hasLesson("Warmer / colder")) {
  created++;
  const lessonId = await ctx.db.insert("lessons", {
    unitId,
    title: "Warmer / colder",
    order: 0,
    strand: "core",
    durationMinutes: 20,
  });

  await ctx.db.insert("activities", {
    lessonId,
    title: "Play: Warmer or Colder",
    order: 0,
    kind: "game",
    game: { gameId: "toy-warmer-colder" },
    description:
      "Guess which half hides the token, probe a tile, and use what you learn. Runs on your iPad.",
    scholarDescription:
      "Make a guess, probe a tile, and follow the clues to find the hidden token.",
    durationMinutes: 8,
  });

  await ctx.db.insert("activities", {
    lessonId,
    title: "Talk about it",
    order: 1,
    kind: "online",
    description: "Tell me what you were thinking while you played.",
    scholarDescription:
      "Think back on the moves you made in Warmer or Colder. Share a moment when your idea changed.",
    durationMinutes: 12,
    systemPrompt: [
      "The scholar has just played a very small guessing game: a token hides under one of a row of tiles, they predicted which half it was in, probed a tile, were told how warm the probe was, and could revise before probing again.",
      "",
      "You did not watch them play, and you should not pretend you did. Ask them to tell you what happened, then follow the interesting part.",
      "",
      "The beat worth finding is the moment their mind changed — the probe that made them doubt their first guess, or the one that made them more sure. Ask what the warmth told them, and what it did NOT tell them. If they changed their guess, ask what would have had to happen for them to keep it.",
      "",
      "Do not score the game, do not tell them whether they played 'well', and do not treat finding the token as the point. Losing while reasoning is worth more here than winning by luck, and it is fine to say so.",
    ].join("\n"),
  });
  }

  // ── Lesson 2: the Factor Game, and the OTHER way into a game ──────────────
  //
  // Its own lesson, with no debrief beside it, because this activity has two
  // entry points and only one of them is an assignment: a teacher can assign
  // it, OR the practice playlist can offer it as an ungraded BEAT when the
  // scholar is working the `number-theory` strand (see
  // `convex/lib/practice/gameBeats.ts`). Both routes open THIS activity — one
  // canonical game, one `configJson`, one digest shape. That is what "shows up
  // in practice sets as appropriate" has to mean; a second, practice-only
  // FactorGame would be a second vocabulary for the same thing.
  if (!hasLesson("The Factor Game")) {
  created++;
  const factorLessonId = await ctx.db.insert("lessons", {
    unitId,
    title: "The Factor Game",
    order: 1,
    strand: "core",
    durationMinutes: 15,
  });

  const factorActivityId = await ctx.db.insert("activities", {
    lessonId: factorLessonId,
    title: "Play: The Factor Game",
    order: 0,
    kind: "game",
    game: { gameId: "factor-game", configJson: JSON.stringify({ boardSize: 30, firstTurn: "scholar" }) },
    description:
      "Claim a number; your opponent takes every factor you leave behind. Primes are cheap, highly-composite numbers are expensive. Runs on your iPad.",
    scholarDescription:
      "Play a number-claiming game where every choice changes what is left for your opponent. Look for a strategy you want to try.",
    durationMinutes: 15,
  });

  // Bind it to the strand it belongs to. The binding is what lets the playlist
  // OFFER the game; it grants nothing and schedules nothing.
  await ctx.db.insert("practiceGameBindings", {
    activityId: factorActivityId,
    domain: "whole-number-arithmetic",
    strand: "number-theory",
    blurb: "Factors, as a game you can win by thinking about primes.",
    isActive: true,
    createdBy: teacherId,
  });
  }

  // ── Lesson 3: the Studio, launched as a game ──────────────────────────────
  //
  // The Studio's demo activity deliberately names a LEVEL SUBSET rather than
  // defaulting to the full ladder, because the subset IS the thing this
  // fixture proves: `configJson.levelIds` is a game config "varying a
  // mechanic" (which levels), and the level rail must honor it. The full
  // ladder stays reachable through the standalone /studio route.
  if (!hasLesson("Studio: first programs")) {
  created++;
  const studioLessonId = await ctx.db.insert("lessons", {
    unitId,
    title: "Studio: first programs",
    order: 2,
    strand: "core",
    durationMinutes: 15,
  });

  await ctx.db.insert("activities", {
    lessonId: studioLessonId,
    title: "Play: Studio",
    order: 0,
    kind: "game",
    game: {
      gameId: "studio",
      configJson: JSON.stringify({ levelIds: ["go", "corner", "hallway"] }),
    },
    description:
      "Write tiny JavaScript programs to drive a robot through its first three worlds. Runs on your iPad; the level rail shows only the configured subset.",
    scholarDescription:
      "Write small programs that move a robot through a world. Run your code, watch what happens, and fix it from what the world shows you.",
    durationMinutes: 15,
  });
  }

  return created;
}

/**
 * Push the demo unit live to one scholar so it actually reaches a Home screen.
 *
 * Seeding a unit is not the same as assigning it — without an `assignments`
 * row with a live `activitySchedule` entry, Home correctly says "Nothing
 * scheduled today" and the game is unreachable. That caught us during device
 * verification, which is exactly the kind of thing a fixture should surface.
 *
 * Note this helper is deliberately NOT game-aware: it assigns whatever the
 * lesson's first two activities are, in order, by the ordinary assign path. A
 * game needs no special assignment machinery, and if it ever did, that would be
 * the signal that games have stopped being an ordinary activity kind.
 *
 *   npx convex run seed/gamesDemo:assignGamesDemo '{"scholarUsername":"test-scholar-001"}'
 */
export const assignGamesDemo = internalMutation({
  args: { scholarUsername: v.string() },
  handler: async (ctx, args) => {
    const unit = await ctx.db
      .query("units")
      .withIndex("by_slug", (q) => q.eq("slug", UNIT_SLUG))
      .first();
    if (!unit) return { assigned: 0, note: "Run seedGamesDemo first." };
    const scholar = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.scholarUsername))
      .first();
    if (!scholar) return { assigned: 0, note: "Scholar not found." };

    const lessons = (
      await ctx.db
        .query("lessons")
        .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
        .collect()
    ).sort((a, b) => a.order - b.order);
    if (lessons.length === 0) return { assigned: 0, note: "Demo unit has no lessons." };
    const activities: Doc<"activities">[] = [];
    for (const lesson of lessons) {
      const inLesson = (
        await ctx.db
          .query("activities")
          .withIndex("by_lesson", (q) => q.eq("lessonId", lesson._id))
          .collect()
      ).sort((a, b) => a.order - b.order);
      activities.push(...inLesson);
    }
    if (activities.length === 0) {
      return { assigned: 0, note: "Demo unit has no activities." };
    }

    const now = Date.now();
    // Schedule BOTH activities, in order. This is worth being explicit about,
    // because it corrects a too-simple reading of D-4: the lesson's `sequence`
    // mode fixes the ORDER the two activities appear in the unit nav, but the
    // scholar's Home surfaces *scheduled* activities and rows derived from an
    // existing tutor session. A game creates no session, so completing it does
    // not auto-promote the debrief onto Home — exactly as completing a `web`
    // activity doesn't. So a teacher assigning "game then debrief" schedules
    // both, and the sequence orders them. D-4 still needs no new concept; it
    // just needs the ordinary two-activity assignment a teacher would make.
    const schedule = activities.map((a) => ({
      activityId: a._id,
      mode: "classFocus" as const,
      setAt: now,
    }));
    const existing = await ctx.db
      .query("assignments")
      .withIndex("by_teacher", (q) => q.eq("teacherId", unit.teacherId))
      .collect();
    const match = existing.find(
      (a) =>
        a.unitId === unit._id &&
        a.scholarIds.length === 1 &&
        a.scholarIds[0] === scholar._id,
    );
    if (match) {
      await ctx.db.patch(match._id, { activitySchedule: schedule });
      return { assigned: 1, assignmentId: match._id, mode: "updated" as const };
    }
    const assignmentId = await ctx.db.insert("assignments", {
      teacherId: unit.teacherId,
      unitId: unit._id,
      scholarIds: [scholar._id],
      startedAt: now,
      activitySchedule: schedule,
    });
    return { assigned: 1, assignmentId, mode: "created" as const };
  },
});

/**
 * Standalone runner:
 *   npx convex run seed/gamesDemo:seedGamesDemo
 */
export const seedGamesDemo = internalMutation({
  args: {},
  handler: async (ctx) => {
    const systemTeacher = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", "system@rabbithole.app"))
      .first();
    const teacher =
      systemTeacher ??
      (await ctx.db
        .query("users")
        .filter((q) => q.eq(q.field("role"), "teacher"))
        .first()) ??
      (await ctx.db
        .query("users")
        .filter((q) => q.eq(q.field("role"), "platform_admin"))
        .first());
    if (!teacher) return { inserted: 0, note: "No teacher/admin found; cannot seed." };
    const inserted = await insertGamesDemoUnit(ctx, teacher._id);
    return { inserted };
  },
});
