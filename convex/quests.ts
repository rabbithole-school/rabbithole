// The ONE quest transition surface. A "quest" is a per-scholar lifecycle over a
// UNIT, outside any assignment; its identity is the pair (scholarId, unitId),
// and its state is DERIVED (never stored) by convex/lib/questLifecycle.ts.
//
// This module is the design doc's "one mutation surface: transitions, not table
// pokes" (review/quest-lifecycle-unification.html §proposal). Each transition is
// a thin, role-gated wrapper around writes that ALREADY exist — no new tables,
// no schema change — and returns the RESULTING canonical state (recomputed via
// questStateForPair) so a caller always sees the derivation agree with the write.
//
//   offer   (teacher) — plant/reuse the teacher seed pointing at the unit.
//   start   (scholar) — accept an open offer → launch the session (shared
//                       seed-launch core, no duplicated logic).
//   finish  (teacher) — NO-OP VALIDATION: finishing is EARNED (badge or all
//                       activities complete), never stamped. Verifies + returns.
//   retract (teacher) — deactivate the scholar-owned unit + dismiss its seeds +
//                       archive its sessions (MOVED here from units.ts, PR #787).
//   reopen  (teacher) — inverse of retract: reactivate the unit + unarchive its
//                       sessions (seeds stay dismissed; re-offer explicitly).
//
// The retract/reopen CORES also back the aide tools (convex/lib/aideTools.ts),
// which run in an action with a verified callerUserId, so the cores re-check the
// teacher role + scholar-access boundary themselves (same pattern as
// assignments.coreAideArchive / coreAideDispatchActivity).

import { v } from "convex/values";
import {
  authedMutation,
  teacherMutation,
  teacherQuery,
} from "./lib/customFunctions";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireActiveScholarAccess } from "./lib/access";
import { isTeacherRole } from "./lib/roles";
import { plantTeacherSeed } from "./lib/seeds";
import { questStateForPair, questsForScholar } from "./lib/questLifecycle";
import type { QuestState } from "./lib/questLifecycle";
import { chosenPathValidator } from "./bakeUnitFromSeed";
import { createSessionFromSeedCore } from "./sessions";

// ── Shared cores (also called by the aide tools' internal mutations) ──────

/**
 * Re-derive the teacher/admin caller from a verified id and enforce the role,
 * for the internal (aide/MCP action) path that bypasses the customFunction
 * gate. On the public teacherMutation path this is a redundant-but-harmless
 * double-check (ctx.user is already a teacher).
 */
async function requireTeacherCaller(
  ctx: MutationCtx,
  callerUserId: Id<"users">,
): Promise<Doc<"users">> {
  const u = await ctx.db.get(callerUserId);
  if (!u || !isTeacherRole(u.role)) {
    throw new Error("Quest transitions are teacher/admin only");
  }
  return u;
}

export interface OfferResult {
  seedId: Id<"seeds">;
  existed: boolean;
  state: QuestState | null;
  /** The offered unit's title — so callers (the aide tool) can name it without a second lookup. */
  unitTitle: string;
}

export async function offerScholarQuestCore(
  ctx: MutationCtx,
  callerUserId: Id<"users">,
  args: {
    scholarId: Id<"users">;
    unitId: Id<"units">;
    topic?: string;
    rationale?: string;
  },
): Promise<OfferResult> {
  const caller = await requireTeacherCaller(ctx, callerUserId);
  await requireActiveScholarAccess(ctx, caller, args.scholarId);
  const unit = await ctx.db.get(args.unitId);
  if (!unit) throw new Error("Unit not found");

  const { id, existed } = await plantTeacherSeed(ctx, {
    scholarId: args.scholarId,
    topic: args.topic?.trim() || unit.title,
    rationale: args.rationale?.trim() || `Offered the quest "${unit.title}".`,
    teacherId: caller._id,
    unitId: args.unitId,
  });

  const state = await questStateForPair(ctx, args.scholarId, args.unitId);
  return { seedId: id, existed, state, unitTitle: unit.title };
}

export interface RetractResult {
  unitDeactivated: boolean;
  seedsDismissed: number;
  sessionsArchived: number;
  state: QuestState | null;
}

/**
 * The `retract` transition (MOVED verbatim from units.retractScholarQuest).
 *
 * A scholar quest can reach Home through THREE independent paths (an active
 * unit's standalone IS card, a live/pending SEED offer, and an in-progress
 * SESSION), so retracting cleanly means closing all three at once:
 *   1. deactivate the unit (`isActive: false`) — drops the standalone IS card;
 *   2. dismiss every non-terminal seed offer pointing at it — clears the sky;
 *   3. archive its non-archived, non-test-drive sessions — clears the plate.
 *
 * Nothing is hard-deleted (unit deactivate is reversible via `reopen`; sessions
 * are soft-archived), so the learning record is preserved. Returns the cascade
 * counts plus the resulting canonical state (always `retracted`).
 */
export async function retractScholarQuestCore(
  ctx: MutationCtx,
  callerUserId: Id<"users">,
  unitId: Id<"units">,
): Promise<RetractResult> {
  const caller = await requireTeacherCaller(ctx, callerUserId);
  const unit = await ctx.db.get(unitId);
  if (!unit) throw new Error("Unit not found");
  const authorScholarId = unit.authorScholarId;
  if (!authorScholarId) {
    throw new Error("Not a scholar-authored quest");
  }
  // Teacher must have access to the owning scholar (institution boundary).
  await requireActiveScholarAccess(ctx, caller, authorScholarId);

  // 1. Deactivate the unit.
  const unitDeactivated = unit.isActive === true;
  if (unitDeactivated) {
    await ctx.db.patch(unitId, { isActive: false });
  }

  // 2. Dismiss non-terminal seed offers pointing at this unit. A seed belongs
  //    to the owning scholar, so scan just their pending + active seeds.
  let seedsDismissed = 0;
  for (const status of ["pending", "active"] as const) {
    const seeds = await ctx.db
      .query("seeds")
      .withIndex("by_scholar_status", (q) =>
        q.eq("scholarId", authorScholarId).eq("status", status),
      )
      .collect();
    for (const seed of seeds) {
      if (String(seed.unitId ?? "") !== String(unitId)) continue;
      await ctx.db.patch(seed._id, {
        status: "dismissed",
        dismissedReason: "Quest retracted",
        teacherId: caller._id,
      });
      seedsDismissed++;
    }
  }

  // 3. Archive its non-archived, non-test-drive sessions.
  let sessionsArchived = 0;
  const sessions = await ctx.db
    .query("sessions")
    .withIndex("by_unit", (q) => q.eq("unitId", unitId))
    .collect();
  for (const s of sessions) {
    if (s.isArchived || s.isTestDrive) continue;
    await ctx.db.patch(s._id, { isArchived: true });
    sessionsArchived++;
  }

  const state = await questStateForPair(ctx, authorScholarId, unitId);
  return { unitDeactivated, seedsDismissed, sessionsArchived, state };
}

export interface ReopenResult {
  unitReactivated: boolean;
  sessionsUnarchived: number;
  state: QuestState | null;
}

/**
 * The `reopen` transition — the inverse of {@link retractScholarQuestCore}:
 * reactivate the (scholar-owned) unit and unarchive its sessions. Seeds
 * deliberately STAY dismissed — a retract declined the offer, so the teacher
 * re-offers explicitly via {@link offer} if they want the star back. Scholar
 * reads then re-derive state normally.
 *
 * NOTE (asymmetry): retract archives every live session; reopen unarchives every
 * archived (non-test-drive) session, so a session the scholar had archived
 * themselves BEFORE the retract is also restored. This mirrors the design's
 * one-transition intent (reopen ≈ "undo the retract"), at the cost of not
 * perfectly reconstructing pre-retract per-session archive state.
 */
export async function reopenScholarQuestCore(
  ctx: MutationCtx,
  callerUserId: Id<"users">,
  unitId: Id<"units">,
): Promise<ReopenResult> {
  const caller = await requireTeacherCaller(ctx, callerUserId);
  const unit = await ctx.db.get(unitId);
  if (!unit) throw new Error("Unit not found");
  const authorScholarId = unit.authorScholarId;
  if (!authorScholarId) {
    throw new Error("Not a scholar-authored quest");
  }
  await requireActiveScholarAccess(ctx, caller, authorScholarId);

  const unitReactivated = unit.isActive === false;
  if (unitReactivated) {
    await ctx.db.patch(unitId, { isActive: true });
  }

  // Unarchive its sessions (retract's inverse). Leave test-drive sessions alone
  // (retract never touched them).
  let sessionsUnarchived = 0;
  const sessions = await ctx.db
    .query("sessions")
    .withIndex("by_unit", (q) => q.eq("unitId", unitId))
    .collect();
  for (const s of sessions) {
    if (!s.isArchived || s.isTestDrive) continue;
    await ctx.db.patch(s._id, { isArchived: false });
    sessionsUnarchived++;
  }

  const state = await questStateForPair(ctx, authorScholarId, unitId);
  return { unitReactivated, sessionsUnarchived, state };
}

// ── The five public transitions ──────────────────────────────────────────

/**
 * `offer` — offer an existing unit to a scholar by planting (or reusing) the
 * teacher seed that points at it. Idempotent by (scholar, unit):
 * {@link plantTeacherSeed} returns the existing non-terminal seed instead of a
 * duplicate. A once-dismissed offer is re-planted fresh (a new active seed).
 */
export const offer = teacherMutation({
  args: {
    scholarId: v.id("users"),
    unitId: v.id("units"),
    // Optional framing; defaults to the unit's own title / a generic rationale.
    topic: v.optional(v.string()),
    rationale: v.optional(v.string()),
  },
  handler: (ctx, args) => offerScholarQuestCore(ctx, ctx.user._id, args),
});

/**
 * `start` (scholar-self) — accept an open offer: resolve the scholar's OWN
 * non-terminal seed pointing at the unit and launch its session through the
 * shared seed-launch core (the SAME path opting into a Sky star takes — see
 * sessions.createFromSeed). Returns the new session id. Bare units with no open
 * offer are launched via sessions.startUnit, not this transition.
 */
export const start = authedMutation({
  args: {
    unitId: v.id("units"),
    // Passed through to the bake for a topic-only seed (rare here — offers are
    // unit-backed); harmless for structured offers.
    bakePath: v.optional(chosenPathValidator),
  },
  handler: async (ctx, args) => {
    const scholarId = ctx.user._id;
    const seeds = await ctx.db
      .query("seeds")
      .withIndex("by_scholar_status", (q) => q.eq("scholarId", scholarId))
      .collect();
    const openOffer = seeds.find(
      (s) =>
        String(s.unitId ?? "") === String(args.unitId) &&
        (s.status === "pending" || s.status === "active"),
    );
    if (!openOffer) {
      throw new Error("No open offer to start for this unit");
    }

    const { id } = await createSessionFromSeedCore(
      ctx,
      scholarId,
      openOffer._id,
      args.bakePath,
    );

    const state = await questStateForPair(ctx, scholarId, args.unitId);
    return { sessionId: id, state };
  },
});

/**
 * `finish` — a NO-OP VALIDATION wrapper. Finishing a quest is DERIVED state (a
 * completion badge, or all activities complete), so it's ONLY valid when the
 * canonical derivation already computes `finished`; a teacher force-finish is
 * deliberately NOT in the lifecycle model (§4 of the design doc). This verifies
 * the state is already `finished` and returns it — documenting that finishing is
 * EARNED, not stamped — and writes nothing.
 */
export const finish = teacherMutation({
  args: { scholarId: v.id("users"), unitId: v.id("units") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const unit = await ctx.db.get(args.unitId);
    if (!unit) throw new Error("Unit not found");

    const state = await questStateForPair(ctx, args.scholarId, args.unitId);
    if (state !== "finished") {
      throw new Error(
        `Quest is not finished (state: ${state ?? "unknown"}). ` +
          "Finishing is earned — a completion badge or all activities complete — not stamped.",
      );
    }
    return { state };
  },
});

/** `retract` — deactivate the scholar-owned unit + dismiss its seeds + archive
 *  its sessions, in one call. Teacher-gated + scoped to the owning scholar. */
export const retract = teacherMutation({
  args: { unitId: v.id("units") },
  handler: (ctx, args) =>
    retractScholarQuestCore(ctx, ctx.user._id, args.unitId),
});

/** `reopen` — the inverse of retract: reactivate the unit + unarchive its
 *  sessions (seeds stay dismissed). Teacher-gated + scholar-scoped. */
export const reopen = teacherMutation({
  args: { unitId: v.id("units") },
  handler: (ctx, args) =>
    reopenScholarQuestCore(ctx, ctx.user._id, args.unitId),
});

// ── Read side (scholar-detail Quests section) ─────────────────────────────

/**
 * `listForScholar` — every quest that belongs to one scholar, for the teacher's
 * per-scholar Quests section on the scholar-detail page (the ONE place a quest
 * is listed as a managed object). Delegates to the single canonical derivation
 * ({@link questsForScholar}) and returns its rows verbatim — title, emoji, the
 * canonical `state`, `source`, online-activity counts, `lastTouched`,
 * `offeredAt`, and the `unitIsDraft`/`unitIsActive` provenance — so this can't
 * drift from the board or the plate. Teacher-gated + scoped to the owning
 * scholar (institution boundary), mirroring the transitions above.
 */
export const listForScholar = teacherQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    return questsForScholar(ctx, args.scholarId);
  },
});

// ── Internal aide/MCP entry points (verified callerUserId, re-checked cores) ─

export const aideOfferScholarQuest = internalMutation({
  args: {
    callerUserId: v.id("users"),
    scholarId: v.id("users"),
    unitId: v.id("units"),
    topic: v.optional(v.string()),
    rationale: v.optional(v.string()),
  },
  handler: (ctx, { callerUserId, ...args }) =>
    offerScholarQuestCore(ctx, callerUserId, args),
});

/**
 * Optional `expectedScholarId` guard: the aide tool resolves the scholar by
 * name for the confirm wording, so we verify the target unit actually belongs
 * to that scholar before mutating — a mismatch means the bot paired the wrong
 * (scholar, unit) and we refuse rather than retract someone else's quest.
 */
async function assertUnitOwnedBy(
  ctx: MutationCtx,
  unitId: Id<"units">,
  expectedScholarId?: Id<"users">,
): Promise<void> {
  if (!expectedScholarId) return;
  const unit = await ctx.db.get(unitId);
  if (
    unit &&
    unit.authorScholarId &&
    unit.authorScholarId !== expectedScholarId
  ) {
    throw new Error("That quest doesn't belong to the named scholar.");
  }
}

export const aideRetractScholarQuest = internalMutation({
  args: {
    callerUserId: v.id("users"),
    unitId: v.id("units"),
    expectedScholarId: v.optional(v.id("users")),
  },
  handler: async (ctx, { callerUserId, unitId, expectedScholarId }) => {
    await assertUnitOwnedBy(ctx, unitId, expectedScholarId);
    return retractScholarQuestCore(ctx, callerUserId, unitId);
  },
});

export const aideReopenScholarQuest = internalMutation({
  args: {
    callerUserId: v.id("users"),
    unitId: v.id("units"),
    expectedScholarId: v.optional(v.id("users")),
  },
  handler: async (ctx, { callerUserId, unitId, expectedScholarId }) => {
    await assertUnitOwnedBy(ctx, unitId, expectedScholarId);
    return reopenScholarQuestCore(ctx, callerUserId, unitId);
  },
});
