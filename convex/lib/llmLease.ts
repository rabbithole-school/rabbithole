import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  CONCURRENCY_RETRY_AFTER_SEC,
  type LlmLimitReason,
} from "./llmLimiter";

export type LlmLeaseAcquisition =
  | {
      ok: false;
      reason: LlmLimitReason;
      retryAfterSec: number;
    }
  | {
      ok: true;
      release: () => Promise<void>;
    };

/**
 * The one place a denial is logged, so the busy regime reads as a single
 * identity-free warning per request. A thrown acquire (OCC retries exhausted)
 * is folded in as `cause` rather than logged separately as an error.
 */
function deniedLease(
  surface: string,
  denial: Extract<LlmLeaseAcquisition, { ok: false }>,
  cause?: unknown,
): Extract<LlmLeaseAcquisition, { ok: false }> {
  console.warn("[llm-limiter] denied", {
    reason: denial.reason,
    surface,
    retryAfterSec: denial.retryAfterSec,
    ...(cause !== undefined ? { cause: String(cause) } : {}),
  });
  return denial;
}

export async function acquireLlmLease(
  ctx: ActionCtx,
  args: {
    userId: Id<"users">;
    surface: string;
    institutionId?: Id<"institutions">;
    /** A `/session-stream` turn (llmLimiter.acquire reclaims dead turns' leases). */
    sessionStream?: {
      sessionId: Id<"sessions">;
      assistantMsgId: Id<"messages">;
    };
  },
): Promise<LlmLeaseAcquisition> {
  const acquireMutation = () =>
    ctx.runMutation(internal.llmLimiter.acquire, args);
  // The lease table is one platform-wide range under OCC, so at the ceiling
  // an acquire can exhaust its retries and throw. That is the "busy" regime
  // the limiter exists for: degrade to the 429 the route already renders,
  // never to a generic 500.
  let result: Awaited<ReturnType<typeof acquireMutation>>;
  try {
    result = await acquireMutation();
  } catch (error) {
    return deniedLease(
      args.surface,
      {
        ok: false,
        reason: "platform",
        retryAfterSec: CONCURRENCY_RETRY_AFTER_SEC,
      },
      error,
    );
  }
  if (!result.ok) return deniedLease(args.surface, result);

  return {
    ok: true,
    release: async () => {
      try {
        await ctx.runMutation(internal.llmLimiter.release, {
          leaseId: result.leaseId,
        });
      } catch (error) {
        console.error("[llm-limiter] lease release failed:", error);
      }
    },
  };
}
