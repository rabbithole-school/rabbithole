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
