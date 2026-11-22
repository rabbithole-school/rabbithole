// The `deviceActivityEvents` kind and Rabbithole Lock reason vocabularies,
// shared by the table definition (convex/schema.ts) and the write path
// (convex/deviceActivity.ts `record`) so the two cannot drift apart.

import { v } from "convex/values";

export const deviceActivityKindValidator = v.union(
  // Usage: what shared/deviceActivityRollup.ts turns into screen time.
  v.literal("app_foreground"),
  v.literal("app_background"),
  v.literal("heartbeat"),
  v.literal("external_launch"),
  v.literal("external_return"),
  // Diagnostics (TRA-331), ignored by the usage roll-up. `app_stuck_inactive`
  // is reported while the app has sat in iOS's `inactive` state for minutes
  // (clientAt = when inactive began, durationMs = how long so far), and
  // `app_stuck_inactive_end` when it finally leaves that state.
  v.literal("app_stuck_inactive"),
  v.literal("app_stuck_inactive_end"),
  // The lock controller actually calling iOS to enter / exit Single App Mode.
  v.literal("asam_enter"),
  v.literal("asam_exit"),
);

/** Why the lock controller entered or exited Single App Mode. */
export const asamTransitionReasonValidator = v.union(
  // exits
  v.literal("offline"),
  v.literal("unpaired"),
  v.literal("disarmed"),
  v.literal("system_ui_release"),
  // entries
  v.literal("cold_start"),
  v.literal("back_online"),
  v.literal("armed"),
  v.literal("system_ui_restore"),
  v.literal("reassert"),
);

// ── The screen-time summary row (`screenTimeDays`) ──────────────────────

/** Minutes per stretch kind (shared/screenTimeStretches.ts `STRETCH_KINDS`). */
export const kindMinutesValidator = v.object({
  launched_app: v.number(),
  web: v.number(),
  building: v.number(),
  playing: v.number(),
  practice: v.number(),
  chat: v.number(),
  rabbithole: v.number(),
});

/**
 * One scholar-day as `deviceActivity.readScholarDayUsage` rolls it up, less
 * the fields the row carries itself (scholar, day) and the read-time ones
 * (name, timeline). Mirrors `ScholarDayUsage`; a type test keeps them equal.
 */
export const screenTimeDayUsageValidator = v.object({
  foregroundMinutes: v.number(),
  apps: v.array(
    v.object({
      externalAppId: v.string(),
      appName: v.string(),
      measuredMinutes: v.number(),
      estimatedMinutes: v.number(),
      estimatedIntervals: v.number(),
    }),
  ),
  unattributedBackgroundMinutes: v.number(),
  measuredMinutes: v.number(),
  estimatedMinutes: v.number(),
  estimatedIntervals: v.number(),
  byContext: v.record(
    v.string(),
    v.object({ measuredMinutes: v.number(), estimatedMinutes: v.number() }),
  ),
  eventCount: v.number(),
  outsideSchool: v.object({
    measuredMinutes: v.number(),
    estimatedMinutes: v.number(),
    foregroundMinutes: v.number(),
  }),
  builder: v.object({ onScreenMinutes: v.number(), activeMinutes: v.number() }),
  webActivityMinutes: v.number(),
  otherRabbitholeMinutes: v.number(),
  schoolDay: v.boolean(),
});
