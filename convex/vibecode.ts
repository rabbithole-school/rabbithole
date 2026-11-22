// Vibecode sessions — a full-screen, chat-driven "describe → generate a live
// app → iterate" workshop (Lovable.dev-style) for gifted scholars. The app IS
// the session's code artifact: the tutor streaming + code-artifact substrate is
// reused wholesale, and the only backend-owned pieces here are the session
// creator and a dev-only smoke helper. The app-builder system-prompt framing
// lives with the tutor prompt (see convex/prompts.ts buildVibecodeSection +
// sessionHelpers/sessionStreamHelpers). See qb/vibecode-spec.md.

import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { authedMutation, authedQuery } from "./lib/customFunctions";
import { scholarAppAccess } from "./lib/deviceAppProjection";
import { timeZoneForInstitution } from "./lib/institutionTime";
import {
  CUSTOM_APP_DEFAULT_STATE_KEY,
  customAppUserPartition,
  isTileSession,
  tileSessionAppForExternalApp,
  tileSessionLastOpenedAt,
  tileSessionTitle,
  userOpensTileSessions,
  type TileSessionApp,
} from "./lib/tileSessions";
import { isAppActivity } from "../shared/appSurface";
import { SCHOLAR_LED_APP_BUILDING } from "../shared/missionCopy";
import { defaultAppDeliverable } from "./lib/appActivity";
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
    // No activity-less app sessions while SCHOLAR_LED_APP_BUILDING is off:
    // new apps come from a teacher's activity (shared/missionCopy.ts).
    if (!SCHOLAR_LED_APP_BUILDING) {
      throw new ConvexError("Apps are built in activities your teacher assigns.");
    }
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
        (candidate) => isAppActivity(candidate) && candidate.title === title,
      ) ?? null;
    if (!activity) {
      const activityId = await ctx.db.insert("activities", {
        lessonId: lesson._id,
        title,
        order: 0,
        kind: "online",
        appActivity: true,
        systemPrompt: TEACHING_GAME_BRIEF,
        deliverable: defaultAppDeliverable({}),
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

// ── Tile sessions (lib/tileSessions.ts) ──────────────────────────────────
// A first-party launcher tile (v1: the Python bench) opens an ordinary
// session in the Workshop, in Play. These three are the whole backend: find
// or create, "＋ New", and the switcher's read. Archive and rename use the
// ordinary sessions.archive / unarchive / update mutations.

/** Shown when a tile cannot open a session; the client keeps the bare host. */
const TILE_NOT_ELIGIBLE = "This app doesn't open in a session.";

/**
 * The gates both tile mutations share. The scholar comes from auth (the
 * wrapper already refused impersonation and read-only accounts); the tile
 * must be one they can open right now through the same rule as their tile
 * (`scholarAppAccess`: a direct add, a grant or a live push), never mere
 * possession of the token; and its custom app must be eligible.
 */
async function requireTileSessionApp(
  ctx: MutationCtx & { user: Doc<"users"> },
  externalAppId: Id<"externalApps">,
): Promise<{ app: TileSessionApp; institutionId: Id<"institutions"> | undefined }> {
  if (!userOpensTileSessions(ctx.user)) {
    throw new ConvexError("Only a scholar's own tile opens a session.");
  }
  const institutionId = await requireActiveLearnerInstitution(ctx, ctx.user._id);
  const access = await scholarAppAccess(ctx, ctx.user, externalAppId);
  if (!access.allowed) {
    throw new ConvexError("This app isn't on your launcher.");
  }
  const app = await tileSessionAppForExternalApp(ctx, externalAppId);
  if (!app) throw new ConvexError(TILE_NOT_ELIGIBLE);
  return { app, institutionId };
}

/**
 * Create one tile session: a vibecode row with NO unit, activity or
 * assignment (so it never becomes a Quest or assigned work), titled with the
 * app and the day, holding one `code` artifact copied from the custom app the
 * way an activity starter is (lib/sessionActivitySetup.ts). The copy carries
 * `fixedApp`, so every AI write path refuses it.
 *
 * The scholar's FIRST tile session of this app also takes over the work they
 * saved in the bare tile host before tile sessions existed (customApp-scope
 * state, `user:<id>` / "default"), copied once into the new session's own
 * state, which is what the tutor reads. The custom-app row is left in place.
 */
async function createTileSession(
  ctx: MutationCtx & { user: Doc<"users"> },
  args: {
    app: TileSessionApp;
    externalAppId: Id<"externalApps">;
    institutionId: Id<"institutions"> | undefined;
  },
): Promise<Id<"sessions">> {
  const userId = ctx.user._id;
  const isFirst =
    (await ctx.db
      .query("sessions")
      .withIndex("by_user_sourceCustomApp", (q) =>
        q.eq("userId", userId).eq("sourceCustomAppId", args.app._id),
      )
      .first()) === null;
  const now = Date.now();
  const timeZone = await timeZoneForInstitution(ctx, args.institutionId);
  const sessionId = await ctx.db.insert("sessions", {
    userId,
    institutionId: args.institutionId,
    sessionMode: "vibecode",
    title: tileSessionTitle(args.app.name, now, timeZone),
    isArchived: false,
    sourceCustomAppId: args.app._id,
    sourceExternalAppId: args.externalAppId,
    // Opened on an app the scholar did not build (TRA-477's starter flag), so
    // the Workshop treats it as a playable app, not a blank build.
    vibecodeStarterUsedAt: args.app.updatedAt ?? args.app._creationTime,
  });
  const artifactId = await ctx.db.insert("artifacts", {
    sessionId,
    title: args.app.name,
    content: args.app.html,
    lastEditedBy: "ai",
    revision: 0,
    type: "code",
    language: "html",
    appAssetIds: args.app.appAssetIds,
    appAi: args.app.appAi,
    fixedApp: args.app.fixedApp,
  });
  if (isFirst) {
    const tileState = await ctx.db
      .query("appStates")
      .withIndex("by_scope_scopeId_userId_key", (q) =>
        q
          .eq("scope", "customApp")
          .eq("scopeId", String(args.app._id))
          .eq("userId", customAppUserPartition(userId))
          .eq("key", CUSTOM_APP_DEFAULT_STATE_KEY),
      )
      .unique();
    const doc = tileState?.doc ?? tileState?.state;
    if (tileState && doc !== undefined) {
      await ctx.db.insert("appStates", {
        scope: "session",
        scopeId: String(sessionId),
        userId: String(userId),
        key: String(artifactId),
        doc,
        log: tileState.log ?? [],
        version: 1,
        updatedAt: now,
      });
    }
  }
  return sessionId;
}

/**
 * A tile tap: reopen the scholar's most recently used non-archived session of
 * this app, or create their first one. Returns the session to navigate to.
 */
export const openTileForSelf = authedMutation({
  args: { externalAppId: v.id("externalApps") },
  handler: async (ctx, args): Promise<{ sessionId: Id<"sessions"> }> => {
    const { app, institutionId } = await requireTileSessionApp(ctx, args.externalAppId);
    const candidates = (
      await ctx.db
        .query("sessions")
        .withIndex("by_user_sourceCustomApp", (q) =>
          q.eq("userId", ctx.user._id).eq("sourceCustomAppId", app._id),
        )
        .collect()
    ).filter(
      (session) =>
        !session.isArchived &&
        session.teacherArchivedAt == null &&
        (!institutionId || session.institutionId === institutionId),
    );
    let newest: { id: Id<"sessions">; at: number } | null = null;
    for (const session of candidates) {
      const at = await tileSessionLastOpenedAt(ctx, session);
      if (!newest || at > newest.at) newest = { id: session._id, at };
    }
    if (newest) return { sessionId: newest.id };
    return {
      sessionId: await createTileSession(ctx, {
        app,
        externalAppId: args.externalAppId,
        institutionId,
      }),
    };
  },
});

/** "＋ New": always a fresh session of this app; the others are untouched. */
export const newTileSessionForSelf = authedMutation({
  args: { externalAppId: v.id("externalApps") },
  handler: async (ctx, args): Promise<{ sessionId: Id<"sessions"> }> => {
    const { app, institutionId } = await requireTileSessionApp(ctx, args.externalAppId);
    return {
      sessionId: await createTileSession(ctx, {
        app,
        externalAppId: args.externalAppId,
        institutionId,
      }),
    };
  },
});

/**
 * The switcher's read: the caller's own sessions of this tile's app, active
 * ones newest first by when they were last opened, archived ones apart.
 * Null when the tile opens no session (the client keeps the bare host). A
 * teacher-archived session is left out of both lists: only a teacher can
 * restore it (sessions.restoreApp).
 */
export const tileSessionsForSelf = authedQuery({
  args: { externalAppId: v.id("externalApps") },
  handler: async (ctx, args) => {
    if (!userOpensTileSessions(ctx.user)) return null;
    const app = await tileSessionAppForExternalApp(ctx, args.externalAppId);
    if (!app) return null;
    const rows = await ctx.db
      .query("sessions")
      .withIndex("by_user_sourceCustomApp", (q) =>
        q.eq("userId", ctx.user._id).eq("sourceCustomAppId", app._id),
      )
      .collect();
    type Row = { sessionId: Id<"sessions">; title: string; lastOpenedAt: number };
    const active: Row[] = [];
    const archived: Row[] = [];
    for (const session of rows) {
      if (!isTileSession(session) || session.teacherArchivedAt != null) continue;
      const row: Row = {
        sessionId: session._id,
        title: session.title,
        lastOpenedAt: await tileSessionLastOpenedAt(ctx, session),
      };
      (session.isArchived ? archived : active).push(row);
    }
    const newestFirst = (a: Row, b: Row) => b.lastOpenedAt - a.lastOpenedAt;
    return {
      appName: app.name,
      active: active.sort(newestFirst),
      archived: archived.sort(newestFirst),
    };
  },
});
