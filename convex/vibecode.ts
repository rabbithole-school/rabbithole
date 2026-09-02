// Vibecode sessions — a full-screen, chat-driven "describe → generate a live
// app → iterate" workshop (Lovable.dev-style) for gifted scholars. The app IS
// the session's code artifact: the tutor streaming + code-artifact substrate is
// reused wholesale, and the only backend-owned pieces here are the session
// creator and a dev-only smoke helper. The app-builder system-prompt framing
// lives with the tutor prompt (see convex/prompts.ts buildVibecodeSection +
// sessionHelpers/sessionStreamHelpers). See qb/vibecode-spec.md.

import { v } from "convex/values";

import { internalMutation } from "./_generated/server";
import { authedMutation } from "./lib/customFunctions";
import {
  requireActiveLearnerInstitution,
  scholarInstitutionId,
} from "./lib/scholarEnrollment";

/** Default title for a fresh vibecode app when the caller doesn't name one. */
const NEW_VIBECODE_TITLE = "New App";

/** Slug for the dev-only demo unit the assignment smoke helper hangs work on. */
const VIBECODE_SMOKE_UNIT_SLUG = "vibecode-smoke";

/** Default title for the smoke helper's vibecode assignment. */
const DEFAULT_VIBECODE_ASSIGNMENT_TITLE = "Build a Teaching Game";

/**
 * The build brief, stored verbatim as the smoke activity's `systemPrompt` (the
 * activity's systemPrompt IS the brief — no dedicated field). This is what a
 * teacher would author, and what flows into the tutor context so the AI builder
 * greets the scholar with the challenge.
 */
const TEACHING_GAME_BRIEF = `ASSIGNMENT — Build a Teaching Game.

The scholar's task: build a small, self-contained web game that TEACHES one true idea to another kid. The scholar picks the topic — times tables, state capitals, the water cycle, fractions, anything they know well.

Coach them toward a game that is: (1) fun within 30 seconds, (2) factually CORRECT — they have to know the idea well enough to check it, and (3) escalating — a little harder as it goes.

When they arrive, greet them as their build partner in ONE short line and ask what they'd like to teach — offer two concrete examples to spark ideas, but let them choose. Then build a first playable version fast and iterate with them.

The skill being practiced is DIRECTING you precisely: when the game is wrong or boring, help them turn that into a specific change ("make the timer 10 seconds", "only show factors up to 12"). ANTI-OFFLOADING: never do their thinking about the topic for them — if they build a multiplication game, do NOT tell them the products; make the GAME check the player's answers. You build the mechanics; they own the ideas.`;

/**
 * Create a vibecode session owned by the current scholar. Mirrors how
 * `sessions.create` builds a minimal free-form row (userId + title +
 * isArchived), stamping `sessionMode: "vibecode"` so the native session router
 * mounts the VibecodeScreen and the tutor prompt leads with the app-builder
 * framing.
 */
export const createSession = authedMutation({
  args: {
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const institutionId = await requireActiveLearnerInstitution(
      ctx,
      ctx.user._id,
    );
    const sessionId = await ctx.db.insert("sessions", {
      userId: ctx.user._id,
      institutionId,
      sessionMode: "vibecode",
      title: args.title ?? NEW_VIBECODE_TITLE,
      isArchived: false,
    });
    return { sessionId };
  },
});

/**
 * Dev-only smoke helper: create a vibecode session owned by a scholar looked up
 * by username (the way `simulator.ts prepareLiveSmoke` does) and mint an auth
 * session so the QB can deep-link `native:///session/<id>` on the iPad. Returns
 * the session id plus the identity to sign in as.
 */
export const prepareVibecodeSmoke = internalMutation({
  args: {
    scholarUsername: v.string(),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scholar = await ctx.db
      .query("users")
      .withIndex("by_username", (query) =>
        query.eq("username", args.scholarUsername),
      )
      .unique();
    if (!scholar || scholar.role !== "scholar") {
      throw new Error("Smoke scholar not found");
    }

    const institutionId = await scholarInstitutionId(ctx, scholar._id);
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholar._id,
      institutionId,
      sessionMode: "vibecode",
      title: args.title ?? NEW_VIBECODE_TITLE,
      isArchived: false,
    });

    const authSessionId = await ctx.db.insert("authSessions", {
      userId: scholar._id,
      expirationTime: Date.now() + 60 * 60 * 1000,
    });

    return {
      sessionId,
      identity: {
        subject: `${scholar._id}|${authSessionId}`,
        issuer: "https://convex.dev",
      },
    };
  },
});

/**
 * Dev-only smoke helper for the vibecode ASSIGNMENT path: authors a
 * `kind:"vibecode"` activity (brief in its `systemPrompt`) on a demo unit +
 * lesson — mirroring how `simulator.ts prepareLiveSmoke` ensures its smoke
 * unit/lesson — then starts a `sessions` row bound to that activity so a
 * scholar opening it lands in the VibecodeScreen with the brief driving the
 * builder. Returns the session + activity ids.
 */
export const prepareVibecodeAssignmentSmoke = internalMutation({
  args: {
    scholarUsername: v.string(),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scholar = await ctx.db
      .query("users")
      .withIndex("by_username", (query) =>
        query.eq("username", args.scholarUsername),
      )
      .unique();
    if (!scholar || scholar.role !== "scholar") {
      throw new Error("Smoke scholar not found");
    }

    // Find/create the demo unit (needs a teacher owner) + its smoke lesson.
    let unit = await ctx.db
      .query("units")
      .withIndex("by_slug", (query) => query.eq("slug", VIBECODE_SMOKE_UNIT_SLUG))
      .unique();
    if (!unit) {
      const teacher = await ctx.db
        .query("users")
        .withIndex("by_role", (query) => query.eq("role", "teacher"))
        .first();
      if (!teacher) throw new Error("Smoke teacher not found");
      const unitId = await ctx.db.insert("units", {
        teacherId: teacher._id,
        title: "Vibecode Smoke",
        slug: VIBECODE_SMOKE_UNIT_SLUG,
        isActive: true,
      });
      unit = (await ctx.db.get(unitId))!;
    }

    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (query) => query.eq("unitId", unit._id))
      .collect();
    const lesson =
      lessons.find((candidate) => candidate.title === "Vibecode smoke") ??
      (await (async () => {
        const lessonId = await ctx.db.insert("lessons", {
          unitId: unit._id,
          title: "Vibecode smoke",
          order: 0,
        });
        return (await ctx.db.get(lessonId))!;
      })());

    // Find-or-create the vibecode activity, its brief in the systemPrompt.
    const title = args.title ?? DEFAULT_VIBECODE_ASSIGNMENT_TITLE;
    const lessonActivities = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (query) => query.eq("lessonId", lesson._id))
      .collect();
    let activity =
      lessonActivities.find(
        (candidate) => candidate.kind === "vibecode" && candidate.title === title,
      ) ?? null;
    if (!activity) {
      const activityId = await ctx.db.insert("activities", {
        lessonId: lesson._id,
        title,
        order: 0,
        kind: "vibecode",
        systemPrompt: TEACHING_GAME_BRIEF,
      });
      activity = (await ctx.db.get(activityId))!;
    }

    // Start the scholar's vibecode session bound to that activity.
    const institutionId = await scholarInstitutionId(ctx, scholar._id);
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholar._id,
      institutionId,
      activityId: activity._id,
      sessionMode: "vibecode",
      title: activity.title,
      isArchived: false,
    });

    return { sessionId, activityId: activity._id };
  },
});
