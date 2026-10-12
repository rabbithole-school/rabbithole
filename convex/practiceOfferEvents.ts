/**
 * practiceOfferEvents — the done-screen offer ledger (shown → accepted/declined)
 * for the re-probe and the "Keep going?" bonus cards. See the table comment in
 * schema.ts for why this is its own table.
 *
 * SYSTEM-ONLY telemetry: self-only writes (the caller IS the scholar; no
 * scholarId arg, so a teacher in remote/rehearsal can never write one for a
 * kid), no reads exposed, nothing here feeds mastery or scheduling.
 */

import { v } from "convex/values";
import { authedMutation } from "./lib/customFunctions";

const offerKind = v.union(
  v.literal("reprobe"),
  v.literal("tuneup"),
  v.literal("stretch"),
  v.literal("challenge"),
  v.literal("moreOfPick"),
);

/** Record that an offer slot was rendered. Idempotent per clientEventId. */
export const recordOfferShown = authedMutation({
  args: { kind: offerKind, clientEventId: v.string() },
  handler: async (ctx, args) => {
    const clientEventId = args.clientEventId.trim();
    if (!clientEventId) throw new Error("clientEventId is required");
    const existing = await ctx.db
      .query("practiceOfferEvents")
      .withIndex("by_scholar_client_event", (q) =>
        q.eq("scholarId", ctx.user._id).eq("clientEventId", clientEventId),
      )
      .unique();
    if (existing) return { eventId: existing._id };
    const eventId = await ctx.db.insert("practiceOfferEvents", {
      scholarId: ctx.user._id,
      kind: args.kind,
      offeredAt: Date.now(),
      outcome: "offered",
      clientEventId,
    });
    return { eventId };
  },
});

/**
 * Settle an offer as accepted or declined. Terminal: the first outcome wins,
 * so a late/duplicate event can't flip it. A missing row is a no-op (the shown
 * write is best-effort on the client).
 */
export const recordOfferOutcome = authedMutation({
  args: {
    clientEventId: v.string(),
    outcome: v.union(v.literal("accepted"), v.literal("declined")),
  },
  handler: async (ctx, args) => {
    const clientEventId = args.clientEventId.trim();
    if (!clientEventId) throw new Error("clientEventId is required");
    const row = await ctx.db
      .query("practiceOfferEvents")
      .withIndex("by_scholar_client_event", (q) =>
        q.eq("scholarId", ctx.user._id).eq("clientEventId", clientEventId),
      )
      .unique();
    if (!row || row.outcome !== "offered") return { settled: false };
    await ctx.db.patch(row._id, { outcome: args.outcome, outcomeAt: Date.now() });
    return { settled: true };
  },
});
