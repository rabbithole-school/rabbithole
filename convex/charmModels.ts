// Charm models — the shared cache behind the builder's `charm_model` tool.
// One row per normalized subject; the generator and the sandbox check live in
// convex/charmModelActions.ts, the contract in convex/lib/charmModelCode.ts.

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import {
  MAX_CHARM_MODEL_SUBJECT_LEN,
  normalizeCharmModelSubject,
} from "./lib/charmModelCode";

/**
 * Find or create the row for one subject. A missing row is inserted pending;
 * an existing row comes back as it is, so the caller can tell a cache hit
 * (ready + code) from a miss and the hidden override from both. Two scholars
 * missing the same subject at once may both generate; the later write wins,
 * which wastes one generation but never serves a broken model.
 */
export const ensureRow = internalMutation({
  args: {
    subject: v.string(),
    createdBy: v.optional(v.id("users")),
  },
  handler: async (ctx, { subject, createdBy }) => {
    // Shared across ALL institutions on purpose, like the charm icon cache
    // (Andy, 2026-10-23: "across schools is fine"). A row is a generic noun's
    // model with no scholar or school data in it; remixes, which carry a
    // child's own words, never land here (see charmModelActions.ts). Not a
    // tenancy leak: see .claude/rules/rabbithole-multi-tenancy.md.
    const label = normalizeCharmModelSubject(subject);
    if (!label || label.length > MAX_CHARM_MODEL_SUBJECT_LEN) return null;
    const existing = await ctx.db
      .query("charmModels")
      .withIndex("by_label", (q) => q.eq("label", label))
      .first();
    if (existing) return existing;
    const id = await ctx.db.insert("charmModels", {
      label,
      displayLabel: subject.replace(/\s+/g, " ").trim(),
      status: "pending",
      ...(createdBy ? { createdBy } : {}),
      createdAt: Date.now(),
    });
    return await ctx.db.get(id);
  },
});

export const setReady = internalMutation({
  args: {
    id: v.id("charmModels"),
    code: v.string(),
    generationModel: v.string(),
  },
  handler: async (ctx, { id, code, generationModel }) => {
    if (!(await ctx.db.get(id))) return;
    await ctx.db.patch(id, { code, generationModel, status: "ready" });
  },
});

/** A failed generation never replaces a model that is already live. */
export const setFailed = internalMutation({
  args: { id: v.id("charmModels") },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (!row || (row.status === "ready" && row.code)) return;
    await ctx.db.patch(id, { status: "failed" });
  },
});

/**
 * Staff override until there is a list UI:
 *   npx convex run charmModels:setHidden '{"subject":"chimpanzee","hidden":true}'
 * A hidden subject is never served to a new app or regenerated.
 */
export const setHidden = internalMutation({
  args: { subject: v.string(), hidden: v.boolean() },
  handler: async (ctx, { subject, hidden }) => {
    const row = await ctx.db
      .query("charmModels")
      .withIndex("by_label", (q) =>
        q.eq("label", normalizeCharmModelSubject(subject)),
      )
      .first();
    if (!row) return false;
    await ctx.db.patch(row._id, { hidden });
    return true;
  },
});
