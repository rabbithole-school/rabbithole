"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { runSandboxedCheck as runSandbox, SANDBOX_MAX_RESULT_CHARS } from "./lib/sandbox";

/**
 * Executor for the tutor's `check_work` tool. Runs a short, throwaway snippet of
 * the TUTOR'S OWN verification code inside a locked-down QuickJS WASM VM (see
 * convex/lib/sandbox.ts for the caps + the why). Node runtime because the VM is
 * a WASM module; the /project-stream HTTP action (default runtime) dispatches
 * here via ctx.runAction(internal.sandboxActions.runSandboxedCheck, …).
 *
 * Internal only — never exposed to a client, and it takes no scholar data: it
 * only ever runs the tutor's construct-and-verify code (a cipher round-trip, an
 * arithmetic chain, a claimed-rule pattern) so the tutor can refuse to present
 * content that failed its own check.
 */
export const runSandboxedCheck = internalAction({
  args: { code: v.string() },
  returns: v.object({
    ok: v.boolean(),
    value: v.optional(v.any()),
    error: v.optional(v.string()),
    durationMs: v.number(),
  }),
  handler: async (_ctx, args) => {
    const result = await runSandbox(args.code, {
      maxResultChars: SANDBOX_MAX_RESULT_CHARS,
    });
    if (result.ok) {
      return { ok: true, value: result.value, durationMs: result.durationMs };
    }
    return { ok: false, error: result.error, durationMs: result.durationMs };
  },
});
