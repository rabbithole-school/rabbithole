// Room Layer — the teacher's voice reaching the room's screens. One
// primitive (`roomCues`, see schema.ts), three kinds ("message" /
// "transition" / "rest"), live via ordinary Convex reactivity (no polling,
// no push infra, no schedules). A teacher calls a cue in scope of an
// institution ("the room") or one pod within it; every in-scope scholar
// surface (web plate/session, native home/session) subscribes to
// `activeRoomCuesForSelf` and renders it, then it clears itself (expiry) or
// the teacher clears it by hand.
//
// Deliberately NOT built for volume: no read receipts, no repeat/nag
// machinery, no AI-generated copy — the teacher's words go out verbatim,
// and a scholar only ever sees the shaped read-model
// (`activeRoomCuesForSelf`'s return), never the scope internals (author id,
// institution, group) that decided they were in scope.

import { v } from "convex/values";
import { teacherMutation, teacherQuery, authedQuery } from "./lib/customFunctions";
import { resolveInstitutionLens } from "./lib/institutionLens";
import { shortScholarName } from "./scholarSuggestions";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

// message/transition auto-expire this long after creation unless the caller
// passes `expiresInMs` — long enough to actually be seen, short enough that
// a forgotten banner never lingers for a kid who stepped away from the
// screen. `rest` never gets a default expiry (see schema.ts) — it's cleared
// explicitly, by design (Andy, 2026-07-13: no countdown clocks, no
// scheduled lockouts).
const DEFAULT_EXPIRES_MS = 5 * 60 * 1000;

/** Groups whose roster contains this scholar. Mirrors metaChat.ts's
 * groupsForScholar (scholarGroups has no by-scholar index; the table is
 * small). Duplicated rather than imported — a private helper, not worth a
 * shared module for one three-line scan. */
async function groupsForScholar(
  ctx: QueryCtx,
  scholarId: Id<"users">,
): Promise<Doc<"scholarGroups">[]> {
  const groups = await ctx.db.query("scholarGroups").collect();
  return groups.filter((g) => g.scholarIds.includes(scholarId));
}

/** Is this `roomCues` row still live right now (not cleared, not expired)? */
function isLive(cue: Doc<"roomCues">, now: number): boolean {
  if (cue.clearedAt !== undefined) return false;
  if (cue.expiresAt !== undefined && cue.expiresAt <= now) return false;
  return true;
}

/**
 * Call a room cue — a teacher speaks, every in-scope scholar screen shows
 * it. `scope` is the same institution-lens string every other teacher
 * surface uses (absent/""/"primary" = the teacher's home school; a slug or
 * id honors a specific one they staff); `groupId` absent = the whole
 * institution, present = just that pod.
 *
 * A new "rest" cue auto-clears any prior LIVE rest cue for the exact same
 * scope first — only one live "screens down" per (institution, group) at a
 * time, so calling it again just replaces the return-time/whatever rather
 * than stacking overlays. "message"/"transition" never replace each other —
 * each is independent and self-expires.
 */
export const callRoomCue = teacherMutation({
  args: {
    scope: v.optional(v.string()),
    groupId: v.optional(v.id("scholarGroups")),
    kind: v.union(
      v.literal("message"),
      v.literal("transition"),
      v.literal("rest"),
    ),
    body: v.optional(v.string()),
    returnAt: v.optional(v.number()),
    expiresInMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
    const institution = lens.institution;
    if (!institution) {
      throw new Error("Pick a specific school to send a room cue to.");
    }
    if (args.groupId) {
      const group = await ctx.db.get(args.groupId);
      if (!group) throw new Error("That group no longer exists.");
    }

    const now = Date.now();

    if (args.kind === "rest") {
      const candidates = await ctx.db
        .query("roomCues")
        .withIndex("by_institution", (q) =>
          q.eq("institutionId", institution._id),
        )
        .collect();
      for (const prior of candidates) {
        if (prior.kind !== "rest") continue;
        if (prior.groupId !== args.groupId) continue;
        if (!isLive(prior, now)) continue;
        await ctx.db.patch(prior._id, {
          clearedAt: now,
          clearedBy: ctx.user._id,
        });
      }
      return await ctx.db.insert("roomCues", {
        institutionId: institution._id,
        groupId: args.groupId,
        authorId: ctx.user._id,
        kind: "rest",
        returnAt: args.returnAt,
        createdAt: now,
      });
    }

    // "message" | "transition" — the teacher's words, verbatim.
    const body = (args.body ?? "").trim();
    if (!body) {
      throw new Error("Write what you want scholars to see.");
    }
    return await ctx.db.insert("roomCues", {
      institutionId: institution._id,
      groupId: args.groupId,
      authorId: ctx.user._id,
      kind: args.kind,
      body,
      createdAt: now,
      expiresAt: now + (args.expiresInMs ?? DEFAULT_EXPIRES_MS),
    });
  },
});

/**
 * Clear a cue early — the teacher's "screens up" for a `rest` cue, or
 * ending a `message`/`transition` before its auto-expiry. No-op if already
 * cleared or expired.
 */
export const clearRoomCue = teacherMutation({
  args: { cueId: v.id("roomCues") },
  handler: async (ctx, args) => {
    const cue = await ctx.db.get(args.cueId);
    if (!cue) throw new Error("That cue no longer exists.");
    if (cue.clearedAt !== undefined) return;
    await ctx.db.patch(args.cueId, {
      clearedAt: Date.now(),
      clearedBy: ctx.user._id,
    });
  },
});

/**
 * The teacher-facing "what's live right now, for the scope I'm about to
 * call" read — backs the Room compose control's "Screens up" affordance
 * (which needs a `cueId` to clear) and lets it show the current rest state
 * before the teacher acts. Unlike `activeRoomCuesForSelf`, this matches the
 * EXACT scope (institution + this exact `groupId`, no group-membership
 * expansion) — a teacher composing for "the whole room" shouldn't see a
 * pod's cue and think the room is already resting.
 */
export const activeForScope = teacherQuery({
  args: {
    scope: v.optional(v.string()),
    groupId: v.optional(v.id("scholarGroups")),
  },
  handler: async (ctx, args) => {
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
    const institution = lens.institution;
    if (!institution) return [];

    const now = Date.now();
    const cues = await ctx.db
      .query("roomCues")
      .withIndex("by_institution", (q) =>
        q.eq("institutionId", institution._id),
      )
      .collect();
    const live = cues.filter(
      (cue) => isLive(cue, now) && cue.groupId === args.groupId,
    );

    const newestByKind = new Map<string, Doc<"roomCues">>();
    for (const cue of live) {
      const current = newestByKind.get(cue.kind);
      if (!current || cue.createdAt > current.createdAt) {
        newestByKind.set(cue.kind, cue);
      }
    }
    return [...newestByKind.values()].map((cue) => ({
      cueId: cue._id,
      kind: cue.kind,
      body: cue.body ?? null,
      returnAt: cue.returnAt ?? null,
      createdAt: cue.createdAt,
    }));
  },
});

/**
 * The live cues that should render on THIS scholar's screens right now —
 * the ONLY read surface scholars get. Resolves the scholar's institution
 * (`users.institutionId`) + which `scholarGroups` they're in, then returns
 * at most one cue per kind (the newest live one), shaped down to exactly
 * what renders: no `authorId`, no `institutionId`/`groupId`, no way to infer
 * who else is in scope or how the room is organized.
 *
 * A non-scholar (no `institutionId`) simply gets an empty room — staff stay
 * global by design (see schema.ts's `users.institutionId` comment).
 */
export const activeRoomCuesForSelf = authedQuery({
  args: {},
  handler: async (ctx) => {
    const institutionId = ctx.user.institutionId;
    if (!institutionId) return [];

    const myGroups = await groupsForScholar(ctx, ctx.user._id);
    const myGroupIds = new Set(myGroups.map((g) => g._id));

    const now = Date.now();
    const cues = await ctx.db
      .query("roomCues")
      .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
      .collect();

    const live = cues.filter((cue) => {
      if (!isLive(cue, now)) return false;
      if (cue.groupId !== undefined && !myGroupIds.has(cue.groupId)) {
        return false;
      }
      return true;
    });

    // Newest per kind — the room speaks once per kind, not a feed.
    const newestByKind = new Map<string, Doc<"roomCues">>();
    for (const cue of live) {
      const current = newestByKind.get(cue.kind);
      if (!current || cue.createdAt > current.createdAt) {
        newestByKind.set(cue.kind, cue);
      }
    }

    const authorCache = new Map<Id<"users">, string>();
    async function authorNameFor(authorId: Id<"users">): Promise<string> {
      const cached = authorCache.get(authorId);
      if (cached) return cached;
      const author = await ctx.db.get(authorId);
      const name = shortScholarName(author?.name);
      authorCache.set(authorId, name);
      return name;
    }

    const kindOrder: Record<Doc<"roomCues">["kind"], number> = {
      message: 0,
      transition: 1,
      rest: 2,
    };
    const shaped = await Promise.all(
      [...newestByKind.values()]
        .sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind])
        .map(async (cue) => ({
          cueId: cue._id,
          kind: cue.kind,
          body: cue.body ?? null,
          returnAt: cue.returnAt ?? null,
          authorName: await authorNameFor(cue.authorId),
        })),
    );
    return shaped;
  },
});
