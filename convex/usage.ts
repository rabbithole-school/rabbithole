/**
 * AI token-usage recorder — the single write path into the `usageEvents`
 * table (schema.ts) that the weekly cost report (convex/usageReport.ts)
 * reads. Keep ALL usage writes flowing through here so every Anthropic
 * call site stays a one-liner and the shape stays consistent.
 *
 * Two entry points:
 *   • `record` (internalMutation) — the raw insert; callers that already
 *     have the four counts (e.g. the streaming loops that accumulate them
 *     turn-by-turn) call this directly via ctx.runMutation.
 *   • `recordAnthropicUsage` (plain async helper) — the one-liner for the
 *     ~non-streaming `anthropic.messages.create` sites: hand it the raw
 *     `response.usage` and it normalizes + writes. Fire-and-forget: it
 *     swallows its own errors so telemetry can never break a producing
 *     action.
 *   • `recordUnitUsage` (plain async helper) — records duration- or
 *     character-metered OpenAI calls with zero token counts.
 *
 * `source` is an OPEN label (surface/function, like alerts.kind); `role`
 * is the triggering principal's role (or omitted for system/cron work).
 * The report maps (source, role) → display buckets in ONE place
 * (convex/lib/usageReport.ts), so the taxonomy isn't baked in here.
 */
import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation, internalQuery } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { platformAdminQuery } from "./lib/customFunctions";
import { resolveActiveMembership } from "./lib/access";
import {
  normalizeAnthropicUsage,
  hasUsage,
  type AnthropicUsage,
  type UsageBreakdown,
} from "./lib/usage";
import {
  accumulateUsage,
  createUsageAccumulator,
  finalizeInstitutionUsage,
  type UsageEventRow,
} from "./lib/usageReport";
import { scholarInstitutionId } from "./lib/scholarEnrollment";

const MAX_ROLLUP_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Resolve only the two attribution rules shared across producers. Scholar
 * work follows the scholar membership; staff work follows
 * the staff member's active membership. Missing data stays unattributed.
 */
export const resolveInstitution = internalQuery({
  args: {
    userId: v.id("users"),
    principal: v.union(v.literal("scholar"), v.literal("staff")),
  },
  handler: async (ctx, { userId, principal }) => {
    const user = await ctx.db.get(userId);
    if (!user) return null;
    if (principal === "scholar") {
      return (await scholarInstitutionId(ctx, userId)) ?? null;
    }
    return (await resolveActiveMembership(ctx, user))?.institutionId ?? null;
  },
});

/** Resolve one institution only when every supplied scholar belongs to it. */
export const resolveSharedScholarInstitution = internalQuery({
  args: { userIds: v.array(v.id("users")) },
  handler: async (ctx, { userIds }) => {
    if (userIds.length === 0) return null;
    const institutions = new Set<Id<"institutions">>();
    for (const userId of userIds) {
      const institutionId = await scholarInstitutionId(ctx, userId);
      if (!institutionId) return null;
      institutions.add(institutionId);
      if (institutions.size > 1) return null;
    }
    return institutions.values().next().value ?? null;
  },
});

/** Resolve a normal tutor/world session through its scholar owner. */
export const resolveSessionInstitution = internalQuery({
  args: { sessionId: v.id("sessions") },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get(sessionId);
    if (!session) return null;
    if (session.institutionId) return session.institutionId;
    const owner = await ctx.db.get(session.userId);
    if (!owner) return null;
    if (session.isTestDrive) {
      return (await resolveActiveMembership(ctx, owner))?.institutionId ?? null;
    }
    return (await scholarInstitutionId(ctx, session.userId)) ?? null;
  },
});

export const record = internalMutation({
  args: {
    source: v.string(),
    role: v.optional(v.string()),
    institutionId: v.optional(v.id("institutions")),
    model: v.string(),
    inputTokens: v.number(),
    cacheWriteTokens: v.number(),
    cacheReadTokens: v.number(),
    outputTokens: v.number(),
    audioSeconds: v.optional(v.number()),
    characters: v.optional(v.number()),
    images: v.optional(v.number()),
    sessionId: v.optional(v.id("sessions")),
  },
  handler: async (ctx, args) => {
    // Skip no-op events so the table (and the report) isn't diluted by
    // zero-token rows (e.g. a call that failed before any usage).
    if (
      !args.inputTokens &&
      !args.cacheWriteTokens &&
      !args.cacheReadTokens &&
      !args.outputTokens &&
      !args.audioSeconds &&
      !args.characters &&
      !args.images
    ) {
      return;
    }
    let institutionId = args.institutionId;
    if (args.sessionId) {
      const session = await ctx.db.get(args.sessionId);
      if (session?.institutionId) institutionId = session.institutionId;
    }
    await ctx.db.insert("usageEvents", {
      ...args,
      institutionId,
      createdAt: Date.now(),
    });
  },
});

/**
 * Record a pre-accumulated breakdown (streaming loops that summed the four
 * counts themselves). Fire-and-forget — never throws into the caller.
 */
export async function recordUsage(
  ctx: ActionCtx,
  args: {
    source: string;
    role?: string | null;
    institutionId?: Id<"institutions"> | null;
    model: string;
    usage: UsageBreakdown;
    sessionId?: Id<"sessions"> | null;
  },
): Promise<void> {
  if (!hasUsage(args.usage)) return;
  try {
    await ctx.runMutation(internal.usage.record, {
      source: args.source,
      role: args.role ?? undefined,
      institutionId: args.institutionId ?? undefined,
      model: args.model,
      inputTokens: args.usage.inputTokens,
      cacheWriteTokens: args.usage.cacheWriteTokens,
      cacheReadTokens: args.usage.cacheReadTokens,
      outputTokens: args.usage.outputTokens,
      sessionId: args.sessionId ?? undefined,
    });
  } catch (err) {
    console.error("[usage] recordUsage failed (non-fatal):", err);
  }
}

/**
 * The one-liner for `anthropic.messages.create` sites: normalize the raw
 * `response.usage` and write. Fire-and-forget.
 */
export async function recordAnthropicUsage(
  ctx: ActionCtx,
  args: {
    source: string;
    role?: string | null;
    institutionId?: Id<"institutions"> | null;
    model: string;
    usage: AnthropicUsage | null | undefined;
    sessionId?: Id<"sessions"> | null;
  },
): Promise<void> {
  await recordUsage(ctx, {
    source: args.source,
    role: args.role,
    institutionId: args.institutionId,
    model: args.model,
    usage: normalizeAnthropicUsage(args.usage),
    sessionId: args.sessionId,
  });
}

/**
 * Record OpenAI usage billed by audio duration or input characters.
 * Fire-and-forget — never throws into the caller.
 */
export async function recordUnitUsage(
  ctx: Pick<ActionCtx, "runMutation">,
  args: {
    source: string;
    role?: string | null;
    model: string;
    audioSeconds?: number | null;
    characters?: number | null;
    sessionId?: Id<"sessions"> | null;
  },
): Promise<void> {
  const audioSeconds =
    typeof args.audioSeconds === "number" && Number.isFinite(args.audioSeconds)
      ? Math.max(0, args.audioSeconds)
      : undefined;
  const characters =
    typeof args.characters === "number" && Number.isFinite(args.characters)
      ? Math.max(0, args.characters)
      : undefined;
  if (!audioSeconds && !characters) return;

  try {
    await ctx.runMutation(internal.usage.record, {
      source: args.source,
      role: args.role ?? undefined,
      model: args.model,
      inputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      audioSeconds,
      characters,
      sessionId: args.sessionId ?? undefined,
    });
  } catch (err) {
    console.error("[usage] recordUnitUsage failed (non-fatal):", err);
  }
}

/**
 * Record a per-image generation event (the Gemini image model, priced PER
 * IMAGE — see `imagePerImage` in lib/usageReport.ts). `images` defaults to 1
 * (one call site = one generated image). Fire-and-forget — never throws into
 * the caller, so metering can't break image generation.
 */
export async function recordImageUsage(
  ctx: Pick<ActionCtx, "runMutation">,
  args: {
    source: string;
    role?: string | null;
    institutionId?: Id<"institutions"> | null;
    model: string;
    images?: number | null;
    sessionId?: Id<"sessions"> | null;
  },
): Promise<void> {
  const images =
    typeof args.images === "number" && Number.isFinite(args.images)
      ? Math.max(0, Math.floor(args.images))
      : 1;
  if (!images) return;

  try {
    await ctx.runMutation(internal.usage.record, {
      source: args.source,
      role: args.role ?? undefined,
      institutionId: args.institutionId ?? undefined,
      model: args.model,
      inputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
      images,
      sessionId: args.sessionId ?? undefined,
    });
  } catch (err) {
    console.error("[usage] recordImageUsage failed (non-fatal):", err);
  }
}

/**
 * One indexed page of the platform-wide institution rollup. The client folds
 * these page-level totals until the raw-event pagination is exhausted, keeping
 * each query transaction below Convex's document-read ceiling.
 */
export const byInstitution = platformAdminQuery({
  args: {
    sinceMs: v.number(),
    untilMs: v.number(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { sinceMs, untilMs, paginationOpts }) => {
    const windowEnd = Math.max(0, Math.min(Date.now(), Math.floor(untilMs)));
    const windowStart = Math.max(
      windowEnd - MAX_ROLLUP_WINDOW_MS,
      Math.min(windowEnd, Math.floor(sinceMs)),
    );
    const eventsPage = await ctx.db
      .query("usageEvents")
      .withIndex("by_createdAt", (q) =>
        q.gte("createdAt", windowStart).lt("createdAt", windowEnd),
      )
      .paginate(paginationOpts);
    const institutions = await ctx.db.query("institutions").collect();
    const institutionLabels = new Map(
      institutions.map((institution) => [
        String(institution._id),
        institution.name,
      ]),
    );
    const rows: UsageEventRow[] = eventsPage.page.map((event) => ({
      source: event.source,
      role: event.role ?? null,
      institutionId: event.institutionId
        ? String(event.institutionId)
        : null,
      model: event.model,
      inputTokens: event.inputTokens,
      cacheWriteTokens: event.cacheWriteTokens,
      cacheReadTokens: event.cacheReadTokens,
      outputTokens: event.outputTokens,
      images: event.images,
      createdAt: event.createdAt,
    }));
    const accumulator = createUsageAccumulator();
    accumulateUsage(accumulator, rows);
    const byInstitution = finalizeInstitutionUsage(
      accumulator,
      institutionLabels,
    );

    return { ...eventsPage, page: byInstitution };
  },
});
