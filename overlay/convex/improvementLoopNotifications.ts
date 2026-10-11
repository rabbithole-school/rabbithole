// KIT OVERLAY (not part of the public snapshot).
// The public convex/crons.ts schedules two functions by string reference
// (makeFunctionReference) in a module the Foundation publisher excludes, so
// the push is rejected server-side: "The cron job ... schedules a function
// that does not exist". These no-op stubs satisfy the reference locally.
import { internalAction } from "./_generated/server";

export const scanDailyRotationAndNotify = internalAction({
  args: {},
  handler: async () => null,
});

export const dispatchRoundsReminders = internalAction({
  args: {},
  handler: async () => null,
});
