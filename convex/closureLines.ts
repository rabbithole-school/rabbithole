/**
 * Governed generation of the scholar-facing CLOSURE LINE — the growth-framed
 * headline that leads the practice done-screen and the daily "Look what you did
 * today" recap (review/practice/completion-messaging-plan.html, Strategy B).
 *
 * The SAME governed pattern as the observer → masteryObservations: a model writes
 * the line from an already-redacted signal, we STORE it (closureLines table), it
 * is teacher-inspectable, and the UI renders it deterministically. It is NEVER a
 * live model voice talking to the child — the surfaces always render an instant
 * deterministic fallback (shared/closureLines.ts) and only swap in a stored line
 * when it exists, so no completion screen ever blocks on a model call.
 *
 * Flow (client-triggered, cached — the practice run has no server-side record to
 * ride, D4): the done-screen / recap card fires ensureClosureLine(signal) once;
 * it dedupes on a hash of the redacted signal, generates with MODELS.SONNET only
 * on a cache miss (quality > latency because it's async/cached), runs the line
 * through the anti-parasocial guard (shared/closureGuard.ts), stores it, and
 * returns it. A rejected or failed line returns null → the fallback stands.
 *
 * Redaction: only skill LABELS + a coarse effort SHAPE + booleans ever reach the
 * model. No raw score/streak/another learner — enforced by re-sanitizing the
 * client signal here and by the guard on the way out.
 */

import { v } from "convex/values";
import { authedAction } from "./lib/customFunctions";
import { internalMutation, internalQuery } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { MODELS } from "./lib/models";
import { requireAnthropicApiKey } from "./lib/anthropic";
import { recordAnthropicUsage } from "./usage";
import { ROLES } from "./lib/roles";
import {
  closureSignalHash,
  sanitizeLabels,
  type ClosureKind,
  type ClosureSignal,
  type PracticeSignal,
  type DailySignal,
} from "../shared/closureLines";
import { validateClosureLine } from "../shared/closureGuard";
import {
  CLOSURE_SYSTEM,
  CLOSURE_PROMPT_VERSION,
  buildClosureUserMessage,
} from "./lib/closureLinePrompt";

const kindValidator = v.union(v.literal("practice"), v.literal("daily"));

// A permissive signal envelope (all fields optional); the handler rebuilds the
// strict per-kind ClosureSignal server-side so a tampered client can't smuggle
// anything past sanitizeLabels / the enum coercions.
const signalValidator = v.object({
  wrap: v.optional(
    v.union(
      v.literal("session"),
      v.literal("tuneup"),
      v.literal("challenge"),
      v.literal("calibration"),
    ),
  ),
  skills: v.optional(v.array(v.string())),
  effortShape: v.optional(
    v.union(v.literal("steady"), v.literal("stretched"), v.literal("hardSet")),
  ),
  challengeMoved: v.optional(v.boolean()),
  frontierSkills: v.optional(v.array(v.string())),
  recovery: v.optional(v.literal("sameNodeUnassisted")),
  yoursNow: v.optional(v.array(v.string())),
  newOnMap: v.optional(v.array(v.string())),
  practiced: v.optional(v.array(v.string())),
  finished: v.optional(v.array(v.string())),
  practicedCount: v.optional(v.number()),
});

function rebuildSignal(
  kind: ClosureKind,
  raw: {
    wrap?: "session" | "tuneup" | "challenge" | "calibration";
    skills?: string[];
    effortShape?: "steady" | "stretched" | "hardSet";
    challengeMoved?: boolean;
    frontierSkills?: string[];
    recovery?: "sameNodeUnassisted";
    yoursNow?: string[];
    newOnMap?: string[];
    practiced?: string[];
    finished?: string[];
    practicedCount?: number;
  },
): ClosureSignal {
  if (kind === "practice") {
    const sig: PracticeSignal = {
      wrap: raw.wrap ?? "session",
      skills: sanitizeLabels(raw.skills ?? []),
      effortShape: raw.effortShape ?? "steady",
      challengeMoved: !!raw.challengeMoved,
      frontierSkills: sanitizeLabels(raw.frontierSkills ?? []),
      ...(raw.recovery === "sameNodeUnassisted"
        ? { recovery: raw.recovery }
        : {}),
    };
    return sig;
  }
  const sig: DailySignal = {
    yoursNow: sanitizeLabels(raw.yoursNow ?? []),
    newOnMap: sanitizeLabels(raw.newOnMap ?? []),
    practiced: sanitizeLabels(raw.practiced ?? []),
    finished: sanitizeLabels(raw.finished ?? []),
    practicedCount: Math.max(0, Math.round(raw.practicedCount ?? 0)),
  };
  return sig;
}

/** The skill/lesson LABELS a signal carries — passed to the guard so digits that
 *  come from a real skill name ("×7, ×8, ×9", "add within 20") aren't mistaken
 *  for an invented score. */
function signalLabels(signal: ClosureSignal): string[] {
  if ("skills" in signal) {
    return [...signal.skills, ...signal.frontierSkills];
  }
  return [...signal.yoursNow, ...signal.newOnMap, ...signal.practiced, ...signal.finished];
}

function cachedPromptVersion(serializedSignal: string): string | null {
  try {
    const parsed: unknown = JSON.parse(serializedSignal);
    if (typeof parsed !== "object" || parsed === null || !("v" in parsed)) return null;
    return typeof parsed.v === "string" ? parsed.v : null;
  } catch {
    return null;
  }
}

/** Read the cached line for a (scholar, kind, signalHash), if any. */
export const getCached = internalQuery({
  args: { scholarId: v.id("users"), kind: kindValidator, signalHash: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("closureLines")
      .withIndex("by_scholar_kind_hash", (q) =>
        q.eq("scholarId", args.scholarId).eq("kind", args.kind).eq("signalHash", args.signalHash),
      )
      .first();
    return row && cachedPromptVersion(row.signal) === CLOSURE_PROMPT_VERSION
      ? row.headline
      : null;
  },
});

/** Upsert a generated line into the cache (idempotent on the signal hash). */
export const storeLine = internalMutation({
  args: {
    scholarId: v.id("users"),
    kind: kindValidator,
    signalHash: v.string(),
    headline: v.string(),
    signal: v.string(),
    model: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("closureLines")
      .withIndex("by_scholar_kind_hash", (q) =>
        q.eq("scholarId", args.scholarId).eq("kind", args.kind).eq("signalHash", args.signalHash),
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        headline: args.headline,
        signal: args.signal,
        model: args.model,
        createdAt: Date.now(),
      });
      return existing._id;
    }
    return ctx.db.insert("closureLines", {
      scholarId: args.scholarId,
      kind: args.kind,
      signalHash: args.signalHash,
      headline: args.headline,
      signal: args.signal,
      model: args.model,
      createdAt: Date.now(),
    });
  },
});

/**
 * Ensure a governed closure line exists for this (scholar, kind, signal) and
 * return it — or null so the caller keeps its deterministic fallback. Only the
 * scholar's OWN live view generates (a teacher rehearsal / remote view renders
 * the fallback, never a fresh model call about someone else).
 */
export const ensureClosureLine = authedAction({
  args: {
    scholarId: v.id("users"),
    kind: kindValidator,
    signal: signalValidator,
  },
  handler: async (ctx, args): Promise<string | null> => {
    // Auth: currentUser gates the call, and generation is self-only.
    const user = await ctx.runQuery(api.users.currentUser, {});
    if (!user || user._id !== args.scholarId) return null;

    const signal = rebuildSignal(args.kind, args.signal);
    const signalHash = closureSignalHash(args.kind, signal);

    // Cache hit → done, no model call.
    const cached = await ctx.runQuery(internal.closureLines.getCached, {
      scholarId: args.scholarId,
      kind: args.kind,
      signalHash,
    });
    if (cached) return cached;

    try {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const anthropic = new Anthropic({ apiKey: requireAnthropicApiKey() });
      const response = await anthropic.messages.create({
        model: MODELS.SONNET,
        max_tokens: 120,
        system: CLOSURE_SYSTEM,
        messages: [
          { role: "user", content: buildClosureUserMessage(args.kind, signal) },
        ],
      });
      const institutionId = await ctx.runQuery(internal.usage.resolveInstitution, {
        userId: args.scholarId,
        principal: "scholar",
      });
      await recordAnthropicUsage(ctx, {
        source: "closure-line",
        role: ROLES.SCHOLAR,
        model: MODELS.SONNET,
        usage: response.usage,
        institutionId,
      });
      const textBlock = response.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") return null;
      const line = textBlock.text
        .replace(/[\r\n]+/g, " ")
        .replace(/^["'`]+|["'`]+$/g, "")
        .trim();

      // Anti-parasocial guard: a line that breaks the contract is dropped, and
      // the caller's deterministic fallback stands. Never store a bad line.
      // The signal's own skill labels are allowlisted so a legitimately numeric
      // skill name (e.g. "×7, ×8, ×9") isn't mistaken for a score.
      const guard = validateClosureLine(line, { allowedLabels: signalLabels(signal) });
      if (!guard.ok) {
        console.warn(`[closureLines] rejected generated line (${guard.reason}): ${line}`);
        return null;
      }

      await ctx.runMutation(internal.closureLines.storeLine, {
        scholarId: args.scholarId,
        kind: args.kind,
        signalHash,
        headline: line,
        signal: JSON.stringify({ v: CLOSURE_PROMPT_VERSION, ...signal }),
        model: MODELS.SONNET,
      });
      return line;
    } catch (err) {
      console.error("[closureLines] generation failed:", err);
      return null;
    }
  },
});
