import { v } from "convex/values";
import { MutationCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { staffQuery, staffMutation } from "./lib/customFunctions";
import { requireActiveScholarAccess } from "./lib/access";

/**
 * Whole Child Narratives (review/assessment-and-goals-plan.html §8).
 *
 * One per scholar × period, team-sourced: staff drop category-tagged
 * observations all period long (convex/wholeChild.ts), the team meets in
 * "meeting mode", and the morning-circle advisor captures the agreed read per
 * category and owns the final text. `teamAgreedAt` stamps the meeting consensus.
 * Brief by design — every category is mentioned, none padded (a skipped
 * category still renders a one-liner). No scaled scores.
 */

const DEFAULT_SECTIONS: { key: string; title: string }[] = [
  { key: "execFunction", title: "Executive Function & Learning Habits" },
  { key: "socialEmotional", title: "Social-Emotional Growth" },
  { key: "collaboration", title: "Collaboration, Character & Community" },
  { key: "passions", title: "Passion Projects, Quests & Extended Learning" },
  { key: "goals", title: "Goals for Continued Growth" },
];

// ── Queries ───────────────────────────────────────────────────────────

export const getForScholarPeriod = staffQuery({
  args: { scholarId: v.id("users"), periodId: v.id("reportingPeriods") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const rows = await ctx.db
      .query("wholeChildNarratives")
      .withIndex("by_scholar_period", (q) =>
        q.eq("scholarId", args.scholarId).eq("periodId", args.periodId),
      )
      .collect();
    return rows[0] ?? null;
  },
});

/** The whole roster's whole-child status for a period (meeting-mode progress). */
export const listForPeriod = staffQuery({
  args: { periodId: v.id("reportingPeriods") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("wholeChildNarratives")
      .withIndex("by_period", (q) => q.eq("periodId", args.periodId))
      .collect();
    return await Promise.all(
      rows.map(async (n) => {
        const scholar = await ctx.db.get(n.scholarId);
        return {
          _id: n._id,
          scholarId: n.scholarId,
          scholarName: scholar?.name ?? "Scholar",
          status: n.status,
          hasContent: n.sections.some((s) => s.body.trim().length > 0),
          teamAgreedAt: n.teamAgreedAt ?? null,
        };
      }),
    );
  },
});

// ── Mutations ─────────────────────────────────────────────────────────

export const open = staffMutation({
  args: { scholarId: v.id("users"), periodId: v.id("reportingPeriods") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const rows = await ctx.db
      .query("wholeChildNarratives")
      .withIndex("by_scholar_period", (q) =>
        q.eq("scholarId", args.scholarId).eq("periodId", args.periodId),
      )
      .collect();
    if (rows[0]) return rows[0]._id;
    return await ctx.db.insert("wholeChildNarratives", {
      scholarId: args.scholarId,
      periodId: args.periodId,
      advisorId: ctx.user._id,
      sections: DEFAULT_SECTIONS.map((s) => ({ ...s, body: "" })),
      goalIds: [],
      status: "draft",
    });
  },
});

export const saveSection = staffMutation({
  args: {
    narrativeId: v.id("wholeChildNarratives"),
    key: v.string(),
    body: v.string(),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const n = await requireNarrative(ctx, args.narrativeId);
    const sections = [...n.sections];
    const idx = sections.findIndex((s) => s.key === args.key);
    if (idx >= 0)
      sections[idx] = {
        ...sections[idx],
        body: args.body,
        title: args.title ?? sections[idx].title,
      };
    else sections.push({ key: args.key, title: args.title ?? args.key, body: args.body });
    await ctx.db.patch(args.narrativeId, { sections });
    return await ctx.db.get(args.narrativeId);
  },
});

/** Toggle a section's "done" flag (the author-set completion state). */
export const setSectionDone = staffMutation({
  args: {
    narrativeId: v.id("wholeChildNarratives"),
    key: v.string(),
    done: v.boolean(),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const n = await requireNarrative(ctx, args.narrativeId);
    const sections = [...n.sections];
    const idx = sections.findIndex((s) => s.key === args.key);
    if (idx >= 0) sections[idx] = { ...sections[idx], done: args.done };
    else sections.push({ key: args.key, title: args.title ?? args.key, body: "", done: args.done });
    await ctx.db.patch(args.narrativeId, { sections });
    return await ctx.db.get(args.narrativeId);
  },
});

/**
 * Stamp the team-agreed consensus (from meeting mode). This is a signal
 * ORTHOGONAL to the done/shared status axis — it only stamps `teamAgreedAt`
 * and must never move `status` (doing so previously could downgrade an
 * already-shared report back out of the parent portal).
 */
export const markTeamAgreed = staffMutation({
  args: { narrativeId: v.id("wholeChildNarratives") },
  handler: async (ctx, args) => {
    await requireNarrative(ctx, args.narrativeId);
    await ctx.db.patch(args.narrativeId, { teamAgreedAt: Date.now() });
    return await ctx.db.get(args.narrativeId);
  },
});

export const setGoals = staffMutation({
  args: {
    narrativeId: v.id("wholeChildNarratives"),
    goalIds: v.array(v.id("scholarGoals")),
  },
  handler: async (ctx, args) => {
    await requireNarrative(ctx, args.narrativeId);
    await ctx.db.patch(args.narrativeId, { goalIds: args.goalIds });
  },
});

export const setDone = staffMutation({
  args: { narrativeId: v.id("wholeChildNarratives"), done: v.boolean() },
  handler: async (ctx, args) => {
    const n = await requireNarrative(ctx, args.narrativeId);
    if (n.status === "shared") return await ctx.db.get(args.narrativeId);
    await ctx.db.patch(args.narrativeId, {
      status: args.done ? "final" : "draft",
    });
    return await ctx.db.get(args.narrativeId);
  },
});

/**
 * Share a done whole-child report to the family — mark it shared and stamp
 * `sharedAt` (the parent portal reads `status === "shared"` and renders/sorts
 * by `sharedAt`, so this MUST be stamped, mirroring `courseNarratives.share`).
 */
export const share = staffMutation({
  args: { narrativeId: v.id("wholeChildNarratives") },
  handler: async (ctx, args) => {
    const n = await requireNarrative(ctx, args.narrativeId);
    if (n.status !== "final" && n.status !== "shared")
      throw new Error("Mark the report as done before sharing");
    await ctx.db.patch(args.narrativeId, {
      status: "shared",
      sharedAt: Date.now(),
    });
    return await ctx.db.get(args.narrativeId);
  },
});

// ── Helpers ───────────────────────────────────────────────────────────

async function requireNarrative(
  ctx: MutationCtx & { user: Doc<"users"> },
  narrativeId: Id<"wholeChildNarratives">,
): Promise<Doc<"wholeChildNarratives">> {
  const n = await ctx.db.get(narrativeId);
  if (!n) throw new Error("Whole Child narrative not found");
  await requireActiveScholarAccess(ctx, ctx.user, n.scholarId);
  return n;
}
