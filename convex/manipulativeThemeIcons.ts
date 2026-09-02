// Generative manipulative theme icons — the charm layer's read/resolve API.
//
// A manipulative's `theme.fill.label` (a short noun) resolves here to a
// generated, chroma-keyed, cached transparent PNG in Convex storage. The
// asset is minted ONCE per normalized label (convex/manipulativeThemeIconActions.ts)
// and SHARED across every activity that uses that label. Renderers resolve via
// the `useThemeIcon` hook (web + native): `getByLabel` returns the URL when
// ready, and a fresh label is warmed by `ensure`. While pending/failed/hidden
// the renderer falls back to the plain shape — a manipulative never blocks on
// art. See schema.ts `manipulativeThemeIcons` and review/generative-manipulative-themes-plan.html.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { authedQuery, authedMutation, teacherMutation } from "./lib/customFunctions";
import { normalizeThemeLabel } from "../lib/manipulative/types";
import { MAX_THEME_LABEL_LEN, themeIconSubject } from "./lib/themeIconArt";

// ── Read path (any signed-in user — renders happen in authed surfaces) ───────

/**
 * Resolve a label to its cached icon. Returns `null` when nothing is cached yet
 * (the caller then fires `ensure`), or `{ status, hidden, url }`. `url` is only
 * populated when the asset is `ready` and not `hidden`.
 */
export const getByLabel = authedQuery({
  args: { label: v.string() },
  handler: async (ctx, { label }) => {
    const key = normalizeThemeLabel(label);
    if (!key) return null;
    const row = await ctx.db
      .query("manipulativeThemeIcons")
      .withIndex("by_label", (q) => q.eq("label", key))
      .first();
    if (!row) return null;
    const usable = row.status === "ready" && !row.hidden && row.imageStorageId;
    return {
      status: row.status,
      hidden: row.hidden ?? false,
      url: usable ? await ctx.storage.getUrl(row.imageStorageId!) : null,
    };
  },
});

/**
 * Warm a label: idempotently ensure a cache row exists and (on a miss) kick off
 * generation. Called by the resolver hook the first time a label has no cached
 * row. Labels come from governed curriculum specs, not free-text scholar input;
 * we still cap length and require a signed-in user to bound the surface.
 */
export const ensure = authedMutation({
  args: { label: v.string() },
  handler: async (ctx, { label }) => {
    const key = normalizeThemeLabel(label);
    if (!key || key.length > MAX_THEME_LABEL_LEN) return null;
    const existing = await ctx.db
      .query("manipulativeThemeIcons")
      .withIndex("by_label", (q) => q.eq("label", key))
      .first();
    if (existing) return existing._id;
    const id = await ctx.db.insert("manipulativeThemeIcons", {
      label: key,
      displayLabel: themeIconSubject(label),
      status: "pending",
      createdBy: ctx.user._id,
      createdAt: Date.now(),
    });
    await ctx.scheduler.runAfter(
      0,
      internal.manipulativeThemeIconActions.generateThemeIcon,
      { id },
    );
    return id;
  },
});

// ── Staff override (teacher-gated) ───────────────────────────────────────────

/** The whole cache, for the override surface (dev gallery). Newest first. Read
 *  is open (icon labels/URLs are non-sensitive curriculum decoration); the
 *  WRITE overrides below stay teacher-gated. */
export const listAll = authedQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("manipulativeThemeIcons").collect();
    rows.sort((a, b) => b.createdAt - a.createdAt);
    return Promise.all(
      rows.map(async (r) => ({
        _id: r._id,
        label: r.label,
        displayLabel: r.displayLabel,
        status: r.status,
        generationModel: r.generationModel ?? null,
        hidden: r.hidden ?? false,
        url:
          r.status === "ready" && r.imageStorageId
            ? await ctx.storage.getUrl(r.imageStorageId)
            : null,
      })),
    );
  },
});

/** Re-mint a label's art (a deliberate curator action, not a per-scholar reroll). */
export const regenerate = teacherMutation({
  args: { label: v.string() },
  handler: async (ctx, { label }) => {
    const key = normalizeThemeLabel(label);
    const row = await ctx.db
      .query("manipulativeThemeIcons")
      .withIndex("by_label", (q) => q.eq("label", key))
      .first();
    if (!row) return null;
    await ctx.db.patch(row._id, { status: "pending", regeneratedAt: Date.now() });
    await ctx.scheduler.runAfter(
      0,
      internal.manipulativeThemeIconActions.generateThemeIcon,
      { id: row._id },
    );
    return row._id;
  },
});

/** Show/hide a label globally (hidden → renderers fall back to the plain shape). */
export const setHidden = teacherMutation({
  args: { label: v.string(), hidden: v.boolean() },
  handler: async (ctx, { label, hidden }) => {
    const key = normalizeThemeLabel(label);
    const row = await ctx.db
      .query("manipulativeThemeIcons")
      .withIndex("by_label", (q) => q.eq("label", key))
      .first();
    if (!row) return null;
    await ctx.db.patch(row._id, { hidden });
    return row._id;
  },
});

/** Drop a label's cache row + its stored asset (falls back to plain shape). */
export const clear = teacherMutation({
  args: { label: v.string() },
  handler: async (ctx, { label }) => {
    const key = normalizeThemeLabel(label);
    const row = await ctx.db
      .query("manipulativeThemeIcons")
      .withIndex("by_label", (q) => q.eq("label", key))
      .first();
    if (!row) return null;
    if (row.imageStorageId) await ctx.storage.delete(row.imageStorageId);
    await ctx.db.delete(row._id);
    return true;
  },
});

// ── Internal plumbing for the generate action ────────────────────────────────

export const getForGeneration = internalQuery({
  args: { id: v.id("manipulativeThemeIcons") },
  handler: async (ctx, { id }) => ctx.db.get(id),
});

/** Prepare one exact label for a manual model-pinned generation pass. Failed
 * rows return to pending; ready rows stay live until replacement succeeds. */
export const prepareManualGeneration = internalMutation({
  args: { label: v.string() },
  handler: async (ctx, { label }) => {
    const key = normalizeThemeLabel(label);
    if (!key || key.length > MAX_THEME_LABEL_LEN) return null;
    const existing = await ctx.db
      .query("manipulativeThemeIcons")
      .withIndex("by_label", (q) => q.eq("label", key))
      .first();
    if (existing) {
      const preserveExisting =
        existing.status === "ready" && Boolean(existing.imageStorageId);
      if (!preserveExisting) await ctx.db.patch(existing._id, { status: "pending" });
      return { id: existing._id, preserveExisting };
    }
    const id = await ctx.db.insert("manipulativeThemeIcons", {
      label: key,
      displayLabel: themeIconSubject(label),
      status: "pending",
      createdAt: Date.now(),
    });
    return { id, preserveExisting: false };
  },
});

/** Ready rows that still have a stored asset — for the in-place downscale
 *  migration (manipulativeThemeIconActions:downscaleExisting), which shrinks
 *  assets baked before the sprite-size cap without rerolling their art. */
export const listReadyWithAsset = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("manipulativeThemeIcons").collect();
    return rows
      .filter((r) => r.status === "ready" && r.imageStorageId)
      .map((r) => ({
        id: r._id,
        label: r.label,
        imageStorageId: r.imageStorageId!,
        prompt: r.prompt ?? "",
        generationModel: r.generationModel,
      }));
  },
});

/** Internal twin of `ensure` (no user gate) for warm/seed actions. Returns the
 *  scheduled row id, or null if the label was already cached. */
export const ensureInternal = internalMutation({
  args: { label: v.string() },
  handler: async (ctx, { label }) => {
    const key = normalizeThemeLabel(label);
    if (!key || key.length > MAX_THEME_LABEL_LEN) return null;
    const existing = await ctx.db
      .query("manipulativeThemeIcons")
      .withIndex("by_label", (q) => q.eq("label", key))
      .first();
    if (existing) return null;
    const id = await ctx.db.insert("manipulativeThemeIcons", {
      label: key,
      displayLabel: themeIconSubject(label),
      status: "pending",
      createdAt: Date.now(),
    });
    await ctx.scheduler.runAfter(
      0,
      internal.manipulativeThemeIconActions.generateThemeIcon,
      { id },
    );
    return id;
  },
});

export const setArt = internalMutation({
  args: {
    id: v.id("manipulativeThemeIcons"),
    imageStorageId: v.id("_storage"),
    prompt: v.string(),
    generationModel: v.optional(v.string()),
  },
  handler: async (ctx, { id, imageStorageId, prompt, generationModel }) => {
    const row = await ctx.db.get(id);
    // The row can vanish mid-generation (a teacher `clear` in the window between
    // storing the asset and this mutation), so reclaim the just-stored blob
    // instead of leaking it with no reference.
    if (!row) {
      await ctx.storage.delete(imageStorageId);
      return;
    }
    // If a stale asset already exists (a regenerate), free it.
    if (row.imageStorageId && row.imageStorageId !== imageStorageId) {
      await ctx.storage.delete(row.imageStorageId);
    }
    await ctx.db.patch(id, {
      imageStorageId,
      prompt,
      status: "ready",
      ...(generationModel ? { generationModel } : {}),
    });
  },
});

export const setStatus = internalMutation({
  args: {
    id: v.id("manipulativeThemeIcons"),
    status: v.union(v.literal("pending"), v.literal("ready"), v.literal("failed")),
  },
  handler: async (ctx, { id, status }) => {
    if (await ctx.db.get(id)) await ctx.db.patch(id, { status });
  },
});
