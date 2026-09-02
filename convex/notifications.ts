// Notification preferences — SCAFFOLD ONLY.
//
// This phase stores per-user channel + cadence toggles; it does NOT send
// anything. A future "dispatch" phase (weekly digest + homework reminders,
// via the same Resend integration the magic-link auth added) will READ
// these. Building the store now means that phase needs no migration.
//
// Every user manages their OWN prefs (keyed to the authenticated caller) —
// parents today, staff can reuse the same table later. The phone number for
// SMS lives on `users.phone`.

import { v } from "convex/values";
import { authedQuery, authedMutation } from "./lib/customFunctions";

const DEFAULTS = {
  emailEnabled: true,
  smsEnabled: false,
  weeklyDigest: true,
  homeworkReminders: true,
  digestDay: "sunday",
};

/** The caller's own preferences, with defaults applied when unset. */
export const getMyPrefs = authedQuery({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("notificationPrefs")
      .withIndex("by_user", (q) => q.eq("userId", ctx.user._id))
      .unique();
    return {
      emailEnabled: row?.emailEnabled ?? DEFAULTS.emailEnabled,
      smsEnabled: row?.smsEnabled ?? DEFAULTS.smsEnabled,
      weeklyDigest: row?.weeklyDigest ?? DEFAULTS.weeklyDigest,
      homeworkReminders: row?.homeworkReminders ?? DEFAULTS.homeworkReminders,
      digestDay: row?.digestDay ?? DEFAULTS.digestDay,
      phone: ctx.user.phone ?? null,
      address: ctx.user.address ?? null,
    };
  },
});

/** Upsert the caller's own preferences (+ optional phone / address). */
export const updateMyPrefs = authedMutation({
  args: {
    emailEnabled: v.optional(v.boolean()),
    smsEnabled: v.optional(v.boolean()),
    weeklyDigest: v.optional(v.boolean()),
    homeworkReminders: v.optional(v.boolean()),
    digestDay: v.optional(v.string()),
    phone: v.optional(v.string()),
    address: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { phone, address, ...prefs } = args;

    // Phone + address live on the user row (the school's contact record).
    const userPatch: Record<string, unknown> = {};
    if (phone !== undefined) userPatch.phone = phone.trim() || undefined;
    if (address !== undefined) userPatch.address = address.trim() || undefined;
    if (Object.keys(userPatch).length) {
      await ctx.db.patch(ctx.user._id, userPatch);
    }

    const fields = Object.fromEntries(
      Object.entries(prefs).filter(([, v]) => v !== undefined),
    );

    const existing = await ctx.db
      .query("notificationPrefs")
      .withIndex("by_user", (q) => q.eq("userId", ctx.user._id))
      .unique();

    if (existing) {
      if (Object.keys(fields).length) await ctx.db.patch(existing._id, fields);
    } else {
      await ctx.db.insert("notificationPrefs", {
        userId: ctx.user._id,
        ...fields,
      });
    }
  },
});
