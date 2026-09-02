/**
 * Per-scholar grapheme confidence map — the reading-ramp inventory
 * (young-learners-plan.html §10). One `graphemeInventories` row per scholar
 * records which grapheme teams ("sh", "th", "ea", …) a pre-reader is currently
 * training and how far each has faded (`training` → `fading` → `graduated`).
 *
 * This is the INTERIM home for fade state (§10 flags it may later be superseded
 * by a Practice-engine phonics strand), so the read API is deliberately thin —
 * nothing downstream should depend on more than `{ team, stage }`:
 *   • `mine`                — the caller's own inventory; what the session UI
 *                             reads to build per-team render stages.
 *   • `getForScholar`       — a scholar's full inventory, for teacher surfaces.
 *   • `internalGetForScholar` — the same read for internal (streaming/observer)
 *                             callers.
 *   • `upsert`              — teacher writes the whole team list at once, and
 *                             appends every stage transition to `graphemeHistory`.
 *   • `getGraphemeHistory`  — the durable fade-stage arc (teacher surfaces).
 *   • `teamExposureCounts`  — a DB-derived, bounded exposure count per team (a
 *                             teacher-facing promotion HINT, no LLM).
 *
 * `stage` values MUST match the render layer's `GraphemeStage` strings in
 * shared/graphemeSegments.ts (validated declaratively by the schema union).
 */

import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { authedQuery, teacherQuery, teacherMutation } from "./lib/customFunctions";
import { requireActiveScholarAccess } from "./lib/access";
import { normalizeInventoryTeams } from "./lib/graphemeAnnotate";
import type { GraphemeInventoryTeam } from "./lib/graphemeAnnotate";
import type { Id } from "./_generated/dataModel";

/** Arg/stage validator — mirrors the `graphemeInventories.teams` schema shape. */
const teamValidator = v.object({
  team: v.string(),
  stage: v.union(
    v.literal("training"),
    v.literal("fading"),
    v.literal("graduated"),
  ),
});

/**
 * The single inventory read used by every surface (public, internal, and the
 * streaming hook via a direct call). Returns the stored team list, or `[]` when
 * the scholar has no inventory yet.
 */
export async function readInventoryTeams(
  ctx: QueryCtx,
  scholarId: Id<"users">,
): Promise<GraphemeInventoryTeam[]> {
  const row = await ctx.db
    .query("graphemeInventories")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .unique();
  return row?.teams ?? [];
}

/** The caller's own inventory teams; `[]` when none. Read by the session UI. */
export const mine = authedQuery({
  args: {},
  handler: async (ctx): Promise<GraphemeInventoryTeam[]> => {
    return readInventoryTeams(ctx, ctx.user._id);
  },
});

/** A scholar's full inventory (teacher surfaces). `null` when none exists. */
export const getForScholar = teacherQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    return await ctx.db
      .query("graphemeInventories")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .unique();
  },
});

/** Internal read for the streaming/observer paths. Returns teams; `[]` when none. */
export const internalGetForScholar = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args): Promise<GraphemeInventoryTeam[]> => {
    return readInventoryTeams(ctx, args.scholarId);
  },
});

/**
 * Replace a scholar's inventory in one shot (create the row if missing), stamp
 * `updatedAt`. Team strings are canonicalized (lowercased, letter-teams only,
 * deduped) via `normalizeInventoryTeams`; stage strings are validated by the
 * arg union above. Teacher-gated.
 *
 * Side effect: every stage TRANSITION is appended to `graphemeHistory` — a team
 * appearing (undefined → training), a promotion (training → fading), or a
 * graduation (→ graduated). A team whose stage is unchanged writes nothing, and
 * a removed team writes nothing (the arc simply stops). This is the durable
 * portfolio arc (§10) — record-keeping only; it never feeds the tutor prompt.
 */
export const upsert = teacherMutation({
  args: {
    scholarId: v.id("users"),
    teams: v.array(teamValidator),
  },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const teams = normalizeInventoryTeams(args.teams);
    const existing = await ctx.db
      .query("graphemeInventories")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .unique();

    // Diff against the previously-stored (already-normalized) stages so we log
    // exactly the teams whose stage changed — one row each, none for unchanged.
    const prevStage = new Map(
      (existing?.teams ?? []).map((t) => [t.team, t.stage]),
    );
    const now = Date.now();
    for (const t of teams) {
      if (prevStage.get(t.team) !== t.stage) {
        await ctx.db.insert("graphemeHistory", {
          scholarId: args.scholarId,
          team: t.team,
          stage: t.stage,
          recordedAt: now,
          changedBy: ctx.user._id,
        });
      }
    }

    if (existing) {
      await ctx.db.patch(existing._id, { teams, updatedAt: now });
      return existing._id;
    }
    return await ctx.db.insert("graphemeInventories", {
      scholarId: args.scholarId,
      teams,
      updatedAt: now,
    });
  },
});

/**
 * A scholar's grapheme fade-stage history (teacher surfaces), newest first.
 * The durable arc behind the inventory — every team appearance / promotion /
 * graduation recorded by `upsert`. Teacher-gated. Never read into the tutor.
 */
export const getGraphemeHistory = teacherQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    return await ctx.db
      .query("graphemeHistory")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .order("desc")
      .collect();
  },
});

// ── DB-derived promotion nudge (no LLM, no observer) ─────────────────────────
// A cheap, deterministic signal for the teacher editor: roughly how much on-
// screen exposure each still-training team has had, counted straight from the
// grapheme spans the Phase-A annotator (#477) already stamped onto tutor
// messages. It is a HINT the teacher reads — never an automated promotion.
//
// Why this is only a hint, and why the scan is bounded:
//   • The real promotion signal — the observer suggesting a fade from read-along
//     / decoding behavior — is a deliberate §10 follow-up (kin to the reading-
//     level suggestion), not this count. And once the Practice engine (#400)
//     lands, grapheme teams may become phonics-strand nodes whose stage comes
//     straight off the node dial, retiring this bespoke count entirely.
//   • So we keep it deterministic and approximate: we scan only the scholar's
//     most-recently-active sessions (capped) and the most recent messages within
//     each (capped), stopping once we've tallied MAX_ANNOTATED annotated
//     messages. No unbounded table scan; the label says "recently" on purpose.
const EXPOSURE_MAX_SESSIONS = 25;
const EXPOSURE_MAX_MESSAGES_PER_SESSION = 100;
const EXPOSURE_MAX_ANNOTATED = 200;

/**
 * Per-team exposure counts: how many recent annotated tutor messages carry ≥1
 * span for each team (message cardinality — a team counted once per message,
 * however many times it appears in it). Teacher-gated.
 *
 * Returns `{ counts, sampled, capped }` — `counts` keyed by team, `sampled` the
 * number of annotated messages examined, `capped` true when a scan cap was hit
 * (so the caller can honestly present the number as approximate).
 */
export const teamExposureCounts = teacherQuery({
  args: { scholarId: v.id("users") },
  handler: async (
    ctx,
    args,
  ): Promise<{ counts: Record<string, number>; sampled: number; capped: boolean }> => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_user_last_message", (q) => q.eq("userId", args.scholarId))
      .order("desc")
      .take(EXPOSURE_MAX_SESSIONS);

    const counts: Record<string, number> = {};
    let sampled = 0;
    let capped = sessions.length >= EXPOSURE_MAX_SESSIONS;

    for (const session of sessions) {
      if (sampled >= EXPOSURE_MAX_ANNOTATED) {
        capped = true;
        break;
      }
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", session._id))
        .order("desc")
        .take(EXPOSURE_MAX_MESSAGES_PER_SESSION);

      // A truncated session means we skipped older annotated messages — the
      // count is approximate, so flag it (the caller renders a "+").
      if (messages.length >= EXPOSURE_MAX_MESSAGES_PER_SESSION) capped = true;

      for (const message of messages) {
        const spans = message.graphemeSpans;
        if (!spans || spans.length === 0) continue;
        sampled++;
        // Count each team at most once per message (exposure = messages seen).
        const teamsInMessage = new Set(spans.map((s) => s.team));
        for (const team of teamsInMessage) {
          counts[team] = (counts[team] ?? 0) + 1;
        }
        if (sampled >= EXPOSURE_MAX_ANNOTATED) {
          capped = true;
          break;
        }
      }
    }

    return { counts, sampled, capped };
  },
});
