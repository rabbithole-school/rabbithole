"use node";

/**
 * Server side of the sandboxed-app AI bridge (shared/appAiPolicy.ts):
 * `rabbithole.character.say(text, { context }?)` → `say`, and
 * `rabbithole.judge(judgeId, answer, { context }?)` → `judge`. The persona and
 * rubrics live on `artifacts.appAi`; every call is recorded in `appAiTurns`.
 * The host never sends a session id — the server resolves artifact → session
 * itself.
 *
 * Both calls are one structured-output request to APP_AI_MODEL
 * (lib/appAiPrompt builds the body) under an app-AI LLM lease, which draws on
 * its own per-user window (convex/lib/llmLimiter.ts) so a lively game cannot
 * lock out the tutor.
 */

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { action, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { APP_AI_MODEL } from "./lib/models";
import { requireAnthropicApiKey } from "./lib/anthropic";
import { recordAnthropicUsage } from "./usage";
import { acquireLlmLease } from "./lib/llmLease";
import { APP_AI_LLM_SURFACE } from "./lib/llmLimiter";
import { sanitizeScholarVisibleText } from "./lib/scholarSafeText";
import {
  buildCharacterRequest,
  buildJudgeRequest,
  readStructuredReply,
  validateCharacterReply,
  validateJudgeReply,
} from "./lib/appAiPrompt";
import {
  normalizeAppAiContext,
  type AppAiContext,
} from "../shared/appAiPolicy";
import { assertWritableAction } from "./lib/auth";

/** Usage-report label for both calls (an open label; see convex/usage.ts). */
const APP_AI_USAGE_SOURCE = "app-ai";
const CALL_TIMEOUT_MS = 10_000;

const failureValidator = v.object({
  ok: v.literal(false),
  code: v.union(
    v.literal("unavailable"),
    v.literal("busy"),
    v.literal("timeout"),
    v.literal("invalid"),
    v.literal("failed"),
  ),
  retryAfterSec: v.optional(v.number()),
});

const FAILED = { ok: false as const, code: "failed" as const };

// Optional app-supplied facts (`say(text, { context })`). The host parser
// already normalized it; the server does again, since a client can call the
// action directly.
const appContextValidator = v.optional(
  v.record(v.string(), v.union(v.string(), v.number(), v.boolean())),
);

/** The teacher-readable record keeps the normalized context as compact JSON. */
function appContextField(context: AppAiContext | undefined) {
  return context ? { appContext: JSON.stringify(context) } : {};
}

type AppAiFailure = {
  ok: false;
  code: "unavailable" | "busy" | "timeout" | "invalid" | "failed";
  retryAfterSec?: number;
};
type SayResult =
  | {
      ok: true;
      line: string;
      mood: string;
      verdict?: string;
      turnId: Id<"appAiTurns">;
    }
  | AppAiFailure;
type JudgeResult =
  | {
      ok: true;
      verdict: string;
      feedback?: string;
      turnId: Id<"appAiTurns">;
    }
  | AppAiFailure;

/** One retry after a classifier decline; see callAppAiModel. */
const REFUSAL_ATTEMPTS = 2;

/**
 * Send one app-AI request and record its usage. Returns the parsed JSON reply
 * (null when there is none to trust — see readStructuredReply) and the model
 * that answered, which differs from APP_AI_MODEL when a fallback ran.
 */
async function callAppAiModel(
  ctx: ActionCtx,
  request: ReturnType<typeof buildCharacterRequest>,
  record: {
    role?: string;
    institutionId?: Id<"institutions">;
    sessionId: Id<"sessions">;
  },
): Promise<{ raw: unknown; model: string }> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const anthropic = new Anthropic({ apiKey: requireAnthropicApiKey() });
  // The safety classifier occasionally declines an ordinary line (seen live:
  // about one call in a hundred, on requests like "where is the hull patch").
  // A decline is not stable across attempts, so one retry turns nearly all of
  // them into a normal reply instead of an error on the child's screen.
  for (let attempt = 1; ; attempt++) {
    const response = await anthropic.beta.messages.create(
      // SDK 0.91 types predate `fallbacks` and `between_tools` thinking; the
      // live API accepts both on APP_AI_MODEL.
      request as unknown as MessageCreateParamsNonStreaming,
      { timeout: CALL_TIMEOUT_MS },
    );
    const model =
      typeof response.model === "string" ? response.model : APP_AI_MODEL;
    await recordAnthropicUsage(ctx, {
      source: APP_AI_USAGE_SOURCE,
      role: record.role,
      model,
      usage: response.usage,
      institutionId: record.institutionId,
      sessionId: record.sessionId,
    });
    const raw = readStructuredReply(response);
    if (raw !== null) return { raw, model };
    const category = (
      response as { stop_details?: { category?: string | null } | null }
    ).stop_details?.category;
    console.warn(
      `[appAi] no usable reply from ${model} (stop_reason: ${response.stop_reason}${category ? `, category: ${category}` : ""}, attempt ${attempt})`,
    );
    if (response.stop_reason !== "refusal" || attempt >= REFUSAL_ATTEMPTS) {
      return { raw, model };
    }
  }
}

export const say = action({
  args: {
    artifactId: v.id("artifacts"),
    text: v.string(),
    context: appContextValidator,
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      line: v.string(),
      mood: v.string(),
      verdict: v.optional(v.string()),
      turnId: v.id("appAiTurns"),
    }),
    failureValidator,
  ),
  handler: async (ctx, args): Promise<SayResult> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await assertWritableAction(ctx);

    const context = normalizeAppAiContext(args.context);
    const lease = await acquireAppAiLease(ctx, userId);
    if (!lease.ok) return lease;

    let begun;
    try {
      begun = await ctx.runMutation(internal.appAi.beginTurn, {
        callerUserId: userId,
        artifactId: args.artifactId,
        text: args.text,
        ...appContextField(context),
      });
    } catch (error) {
      await lease.release();
      throw error;
    }
    if (!begun.ok) {
      await lease.release();
      return begun;
    }
    const { turnId } = begun;

    try {
      const { raw, model } = await callAppAiModel(
        ctx,
        buildCharacterRequest(
          begun.character,
          begun.direction,
          begun.priorTurns,
          begun.scholarLine,
          context,
        ),
        begun,
      );
      // A refusal or a malformed reply reads as null: the child sees a plain
      // failure, never a refusal's explanation.
      const reply = validateCharacterReply(raw, begun.character);
      // A one-line reply: the filter either keeps it or drops it whole.
      const line = reply ? sanitizeScholarVisibleText(reply.line).trim() : "";
      if (!reply || !line) {
        await failTurn(ctx, turnId);
        return FAILED;
      }

      await ctx.runMutation(internal.appAi.completeTurn, {
        turnId,
        model,
        line,
        mood: reply.mood,
        ...(reply.verdict !== undefined ? { verdict: reply.verdict } : {}),
      });
      return {
        ok: true as const,
        line,
        mood: reply.mood,
        ...(reply.verdict !== undefined ? { verdict: reply.verdict } : {}),
        turnId,
      };
    } catch (error) {
      console.error("[appAi.say] character call failed:", error);
      await failTurn(ctx, turnId);
      return FAILED;
    } finally {
      await lease.release();
    }
  },
});

export const judge = action({
  args: {
    artifactId: v.id("artifacts"),
    judgeId: v.string(),
    answer: v.string(),
    context: appContextValidator,
  },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      verdict: v.string(),
      feedback: v.optional(v.string()),
      turnId: v.id("appAiTurns"),
    }),
    failureValidator,
  ),
  handler: async (ctx, args): Promise<JudgeResult> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await assertWritableAction(ctx);

    const context = normalizeAppAiContext(args.context);
    const lease = await acquireAppAiLease(ctx, userId);
    if (!lease.ok) return lease;

    let begun;
    try {
      begun = await ctx.runMutation(internal.appAi.beginJudgment, {
        callerUserId: userId,
        artifactId: args.artifactId,
        judgeId: args.judgeId,
        answer: args.answer,
        ...appContextField(context),
      });
    } catch (error) {
      await lease.release();
      throw error;
    }
    if (!begun.ok) {
      await lease.release();
      return begun;
    }
    const { turnId } = begun;

    try {
      const { raw, model } = await callAppAiModel(
        ctx,
        buildJudgeRequest(begun.judge, begun.answer, context),
        begun,
      );
      const reply = validateJudgeReply(raw, begun.judge);
      if (!reply) {
        await failTurn(ctx, turnId);
        return FAILED;
      }
      const feedback = reply.feedback
        ? sanitizeScholarVisibleText(reply.feedback).trim()
        : "";

      await ctx.runMutation(internal.appAi.completeTurn, {
        turnId,
        model,
        verdict: reply.verdict,
        ...(feedback ? { feedback } : {}),
      });
      return {
        ok: true as const,
        verdict: reply.verdict,
        ...(feedback ? { feedback } : {}),
        turnId,
      };
    } catch (error) {
      console.error("[appAi.judge] judge call failed:", error);
      await failTurn(ctx, turnId);
      return FAILED;
    } finally {
      await lease.release();
    }
  },
});

/**
 * The lease comes BEFORE the turn row: a refused call writes nothing, and a
 * call the turn mutation itself refuses (no character, empty line, one already
 * in flight) has still spent an app-AI start. So an app calling `say` or
 * `judge` in a loop is bounded by the app-AI window, never by table growth.
 * The lease carries no institution: the tenant is only resolved by the turn
 * mutation, and nothing reads a lease's institution.
 */
async function acquireAppAiLease(
  ctx: ActionCtx,
  userId: Id<"users">,
): Promise<
  | Extract<Awaited<ReturnType<typeof acquireLlmLease>>, { ok: true }>
  | { ok: false; code: "busy"; retryAfterSec: number }
> {
  const lease = await acquireLlmLease(ctx, {
    userId,
    surface: APP_AI_LLM_SURFACE,
  });
  if (!lease.ok) {
    return { ok: false, code: "busy", retryAfterSec: lease.retryAfterSec };
  }
  return lease;
}

/** Best-effort: the caller is already returning a failure code. */
async function failTurn(
  ctx: Pick<ActionCtx, "runMutation">,
  turnId: Id<"appAiTurns">,
) {
  try {
    await ctx.runMutation(internal.appAi.failTurn, { turnId });
  } catch (error) {
    console.error("[appAi] could not mark turn failed:", error);
  }
}
