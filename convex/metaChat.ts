// The Workshop (internal code name: `meta`) — the scholar-facing "Prep Time"
// reflection chat backend. See review/scholar-meta-prep-time-plan.html §§4, 8, 9.
//
// A lightweight, aide-style chat (runAideStream), deliberately NOT a tutor
// `sessions` row — so the CHAT writes NOTHING to the learning record by
// construction. Only the meta-observer writes, and only through its structured
// output: welfare alerting, consented idea distillation, and (§8) high-bar
// self-reported portrait evidence as reflection-typed masteryObservations.
// One thread per scholar per day (metaChats / metaMessages).
//
// Scheduling is client-derived: `myPrepTimeBlock` returns the window config and
// the CLIENT does the time-window math — no cron, no scheduled functions (§4).

import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import {
  authedQuery,
  authedMutation,
  teacherQuery,
  teacherMutation,
} from "./lib/customFunctions";
import { internalQuery, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  DEFAULT_TIMEZONE,
  PREP_TIME_KEY,
  dayKeyForTimezone,
  participatesInPrep,
  type DailyBlock,
} from "./lib/metaBlocks";
import { canonicalPrepWindow } from "./lib/prepBlock";
import { raiseAlert } from "./alerts";
import {
  fanOutWorkshopIdea,
  MAX_OPEN_SUGGESTIONS_EXPORT,
} from "./scholarSuggestions";
import { isIdeaConvosEnabled } from "./lib/scholarIdeaTools";
import { undeliveredCreditsFor } from "./changelog";
import { siteUrl, scholarPath, withBase } from "./lib/channels";
import { escapeSlackText } from "./lib/slackApi";
import {
  buildReflectionSnippet,
  type MetaCredit,
  type MetaTodaySession,
  type MetaTodayRecord,
  type MetaWeeklyGrowth,
} from "./metaPrompts";
import { practiceDomainLabel } from "../shared/practiceDomainLabels";
import { deriveGrowthStories } from "./lib/growthStories";
import { PRACTICE_DIGEST_WINDOW_MS } from "./lib/practiceDigest";
import { requireActiveScholarAccess } from "./lib/access";
import { institutionPromptProfileForScholar } from "./lib/institutionPromptProfile";
import { isTeacherRole } from "./lib/roles";

// ── Membership + block resolution (shared) ──────────────────────────────

/** Groups whose roster contains this scholar. Mirrors fanOutScholarEvent's
 * scan (scholarGroups has no by-scholar index; the table is small). */
async function groupsForScholar(
  ctx: QueryCtx,
  scholarId: Id<"users">,
): Promise<Doc<"scholarGroups">[]> {
  const groups = await ctx.db.query("scholarGroups").collect();
  return groups.filter((g) => g.scholarIds.includes(scholarId));
}

/**
 * The scholar's active Scholar's Prep window, or null. Move 5 ruling: the group
 * only decides PARTICIPATION (does this pod run the ritual?); the WINDOW comes
 * from the institution's bell-schedule prep block, the single source of truth
 * that Special Delivery reasons about too (convex/lib/prepBlock.ts). A scholar
 * in multiple pods now gets ONE deterministic institution window, never an
 * arbitrary "first group with a block" pick.
 */
async function resolvePrepTimeBlock(
  ctx: QueryCtx,
  scholarId: Id<"users">,
): Promise<DailyBlock | null> {
  const groups = await groupsForScholar(ctx, scholarId);
  if (!participatesInPrep(groups)) return null;
  const scholar = await ctx.db.get(scholarId);
  if (!scholar?.institutionId) return null;
  return canonicalPrepWindow(ctx, scholar.institutionId);
}

/**
 * The scholar's non-throwaway `sessions` for a given day (in `timezone`) —
 * titles + activity titles only, NO transcripts. Shared by the reflection prompt
 * (getContext, keyed on the chat's dayKey) and the homescreen snippet
 * (myReflectionSnippet, keyed on today), so the card and the chat agree on what
 * "today" was. Archived / test-drive / offline sessions are excluded, exactly as
 * before the extraction.
 */
export async function todaySessionsFor(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  dayKey: string,
  timezone: string,
  options: { requireLastMessage?: boolean } = {},
): Promise<MetaTodaySession[]> {
  const allSessions = await ctx.db
    .query("sessions")
    .withIndex("by_user", (q) => q.eq("userId", scholarId))
    .collect();
  const todayRaw = allSessions.filter((s) => {
    if (s.isArchived || s.isTestDrive || s.isOffline) return false;
    if (options.requireLastMessage && s.lastMessageAt === undefined) return false;
    const at = s.lastMessageAt ?? s._creationTime;
    return dayKeyForTimezone(at, timezone) === dayKey;
  });
  return await Promise.all(
    todayRaw.map(async (s) => {
      let activityTitle: string | null = null;
      if (s.activityId) {
        const activity = await ctx.db.get(s.activityId);
        activityTitle = activity?.title ?? null;
      }
      return { title: s.title, activityTitle };
    }),
  );
}

// Caps so the growth section stays a thread to pull, not an inventory.
const MAX_GROWTH_CONCEPTS = 5;
const MAX_MATH_MOVES = 6;
const MAX_GROWTH_BADGES = 5;

// Same instinct for the day's record: a full drill day lists a handful of
// skills per domain, not every row touched.
const MAX_TODAY_SKILLS_PER_DOMAIN = 6;
const MAX_TODAY_COMPLETIONS = 8;
const MAX_TODAY_BADGES = 5;
const INTROSPECTION_THREAD_KEY = "standing";
const MODEL_HISTORY_MESSAGE_LIMIT = 40;
const MODEL_HISTORY_CHAR_LIMIT = 24_000;

async function recentModelMessages(
  ctx: QueryCtx,
  chatId: Id<"metaChats">,
): Promise<Array<Doc<"metaMessages">>> {
  const newest = await ctx.db
    .query("metaMessages")
    .withIndex("by_chat", (q) => q.eq("chatId", chatId))
    .order("desc")
    .take(MODEL_HISTORY_MESSAGE_LIMIT);
  const selected: Array<Doc<"metaMessages">> = [];
  let chars = 0;
  for (const message of newest) {
    if (!message.content.trim()) continue;
    if (selected.length > 0 && chars + message.content.length > MODEL_HISTORY_CHAR_LIMIT) {
      break;
    }
    selected.push(message);
    chars += message.content.length;
  }
  return selected.reverse();
}

/**
 * The day's ACTUAL on-Rabbithole record beyond chat sessions, for the
 * reflection's "Today's context" (and the homescreen snippet) — sessions alone
 * miss most of a real day (morning math is pure practice and produces no
 * session), which is exactly the gap the week-1 pilot flagged: the reflection
 * had no independent knowledge of the scholar's real morning and improvised.
 * Sources, all per-scholar and all rendered as LABELS/TITLES only:
 *   - practice drilled today → practiceMastery rows whose `lastAttemptAt` is
 *     today (the honest "actually drilled" stamp — never inflated by
 *     placement/seed inserts, per the practice-engine rules), grouped by
 *     domain, skill labels off knowledgeNodes;
 *   - placement checks finished today → practicePlacements with
 *     status "complete" whose LAST PROBE landed today (probeLog[].at is
 *     immutable; updatedAt is not — a later patch to an already-complete row
 *     (e.g. a maintenance sweep like practiceTextCleanup, or historically the
 *     retired explanation cache) bumps it, which would make a stale placement
 *     read as "finished today". Legacy/fixture rows with no probeLog fall
 *     back to updatedAt);
 *   - activities completed today → activityCompletions (+ activity titles);
 *   - badges earned today → scholarUnitBadges.badgeSnapshot.title.
 * "Today" = the given dayKey in the given timezone, matching todaySessionsFor.
 */
export async function todayRecordFor(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  dayKey: string,
  timezone: string,
): Promise<MetaTodayRecord> {
  const isToday = (ts: number | undefined): ts is number =>
    typeof ts === "number" && dayKeyForTimezone(ts, timezone) === dayKey;

  // Practice drilled today, grouped by domain.
  const masteryRows = await ctx.db
    .query("practiceMastery")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  const drilledByDomain = new Map<string, Doc<"practiceMastery">[]>();
  for (const r of masteryRows) {
    if (!isToday(r.lastAttemptAt)) continue;
    const rows = drilledByDomain.get(r.domain) ?? [];
    rows.push(r);
    drilledByDomain.set(r.domain, rows);
  }

  // Placement checks finished today (index prefix: scholarId only).
  const placements = await ctx.db
    .query("practicePlacements")
    .withIndex("by_scholar_domain", (q) => q.eq("scholarId", scholarId))
    .collect();
  const placedDomains = new Set(
    placements
      .filter((p) => {
        if (p.status !== "complete") return false;
        // The last probe's `at` is the completion moment and never moves;
        // updatedAt does (explanation caching) — see the doc comment above.
        const lastProbeAt = p.probeLog?.length
          ? Math.max(...p.probeLog.map((e) => e.at))
          : undefined;
        return isToday(lastProbeAt ?? p.updatedAt);
      })
      .map((p) => p.domain),
  );

  const domains = new Set([...drilledByDomain.keys(), ...placedDomains]);
  const labelOf = await loadNodeLabels(ctx, new Set(drilledByDomain.keys()));
  const practice = [...domains].sort().map((domain) => {
    const rows = (drilledByDomain.get(domain) ?? []).sort(
      (a, b) => (b.lastAttemptAt ?? 0) - (a.lastAttemptAt ?? 0),
    );
    const skillLabels: string[] = [];
    for (const r of rows) {
      const label =
        labelOf.get(r.skillKey) ?? r.skillKey.replace(/[-_]+/g, " ");
      if (!skillLabels.includes(label)) skillLabels.push(label);
      if (skillLabels.length >= MAX_TODAY_SKILLS_PER_DOMAIN) break;
    }
    return {
      domainLabel: practiceDomainLabel(domain),
      skillLabels,
      placedToday: placedDomains.has(domain),
    };
  });

  // Activities completed today (titles, deduped).
  const completions = await ctx.db
    .query("activityCompletions")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  const completedActivities: string[] = [];
  for (const c of completions.filter((c) => isToday(c.completedAt))) {
    if (completedActivities.length >= MAX_TODAY_COMPLETIONS) break;
    const activity = await ctx.db.get(c.activityId);
    const title = activity?.title?.trim();
    if (title && !completedActivities.includes(title)) {
      completedActivities.push(title);
    }
  }

  // Badges earned today (titles, deduped).
  const badgeRows = await ctx.db
    .query("scholarUnitBadges")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  const badges: string[] = [];
  for (const b of badgeRows.filter((b) => isToday(b.earnedAt))) {
    const title = b.badgeSnapshot.title.trim();
    if (title && !badges.includes(title)) badges.push(title);
    if (badges.length >= MAX_TODAY_BADGES) break;
  }

  return { practice, completedActivities, badges };
}

/** nodeKey → label for the given domains (knowledgeNodes by_domain) — the same
 * label map the weekly practice digest builds. Empty set → empty map. */
async function loadNodeLabels(
  ctx: QueryCtx,
  domains: Set<string>,
): Promise<Map<string, string>> {
  const labelOf = new Map<string, string>();
  for (const domain of domains) {
    const nodes = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_domain", (q) => q.eq("domain", domain))
      .collect();
    for (const n of nodes) labelOf.set(n.nodeKey, n.label);
  }
  return labelOf;
}

/**
 * Recent growth (last ~week) for the reflection's "how you've grown" opening,
 * assembled from the SAME scholar-facing surfaces /me draws on so the chat never
 * claims growth the portrait can't back (see MetaWeeklyGrowth):
 *   - conceptsGrown → deriveGrowthStories (the /me "My Learning" engine) whose
 *     arc had a fresh observation this week. Quality-gated; misconception rows
 *     are already excluded inside the derivation.
 *   - mathFluent / mathAdvanced → practiceMastery crossing EVENTS this week
 *     (becameFluentAt / frontierAdvancedAt — set only on real practice, never
 *     inferred/placement credit), labeled off knowledgeNodes, exactly as
 *     practiceDigest reads them.
 *   - badges → scholarUnitBadges earned this week (badgeSnapshot.title).
 * LABELS only — never a mastery level, score, or count reaches the prompt. Every
 * list may be empty; a quiet week yields all-empty and the prompt section is
 * omitted (never invent growth).
 */
async function weeklyGrowthFor(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  now: number,
): Promise<MetaWeeklyGrowth> {
  const since = now - PRACTICE_DIGEST_WINDOW_MS;
  const inWindow = (ts: number | undefined): ts is number =>
    ts !== undefined && ts >= since && ts <= now;

  // Concepts grown — reuse the /me growth-story derivation, keep arcs that moved
  // this week. Pass raw masteryObservations rows exactly like growthForScholar.
  const observations = await ctx.db
    .query("masteryObservations")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  const conceptsGrown = deriveGrowthStories(observations)
    .filter((s) => s.latestAt >= since && s.latestAt <= now)
    .map((s) => s.conceptLabel)
    .slice(0, MAX_GROWTH_CONCEPTS);

  // Math frontier moves — crossing EVENTS this week off the transition stamps.
  // A fluent crossing implies the frontier moved, so it isn't double-listed
  // under "advanced".
  const masteryRows = await ctx.db
    .query("practiceMastery")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  const fluentRows = masteryRows
    .filter((r) => inWindow(r.becameFluentAt))
    .sort((a, b) => (b.becameFluentAt ?? 0) - (a.becameFluentAt ?? 0));
  const advancedRows = masteryRows
    .filter((r) => inWindow(r.frontierAdvancedAt))
    .sort((a, b) => (b.frontierAdvancedAt ?? 0) - (a.frontierAdvancedAt ?? 0));

  const labelOf = await loadNodeLabels(
    ctx,
    new Set([...fluentRows, ...advancedRows].map((r) => r.domain)),
  );
  const labelFor = (key: string) =>
    labelOf.get(key) ?? key.replace(/[-_]+/g, " ");
  const dedupe = (labels: string[]) => [...new Set(labels)];
  const fluentKeys = new Set(fluentRows.map((r) => r.skillKey));
  const mathFluent = dedupe(fluentRows.map((r) => labelFor(r.skillKey))).slice(
    0,
    MAX_MATH_MOVES,
  );
  const mathAdvanced = dedupe(
    advancedRows
      .filter((r) => !fluentKeys.has(r.skillKey))
      .map((r) => labelFor(r.skillKey)),
  ).slice(0, MAX_MATH_MOVES);

  // Badges earned this week (most recent first, deduped by title).
  const badgeRows = await ctx.db
    .query("scholarUnitBadges")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  const badges: string[] = [];
  for (const row of badgeRows
    .filter((r) => inWindow(r.earnedAt))
    .sort((a, b) => b.earnedAt - a.earnedAt)) {
    const title = row.badgeSnapshot.title.trim();
    if (title && !badges.includes(title)) badges.push(title);
    if (badges.length >= MAX_GROWTH_BADGES) break;
  }

  return { conceptsGrown, mathFluent, mathAdvanced, badges };
}

// ── Scholar-facing ───────────────────────────────────────────────────────

/**
 * Get-or-create the caller's reflection thread for TODAY. Resolves the day in
 * the scholar's Prep Time block timezone (fallback Pacific/Honolulu), so the
 * thread flips at local midnight. Scholars act only for THEMSELVES — scholarId
 * is always the caller.
 */
export const getOrCreateToday = authedMutation({
  args: {},
  handler: async (ctx) => {
    const scholarId = ctx.user._id;
    const block = await resolvePrepTimeBlock(ctx, scholarId);
    const timezone = block?.timezone ?? DEFAULT_TIMEZONE;
    const dayKey = dayKeyForTimezone(Date.now(), timezone);

    const existing = await ctx.db
      .query("metaChats")
      .withIndex("by_scholar_day", (q) =>
        q.eq("scholarId", scholarId).eq("dayKey", dayKey),
      )
      .unique();
    if (existing) return { chatId: existing._id, dayKey };

    const now = Date.now();
    const chatId = await ctx.db.insert("metaChats", {
      scholarId,
      purpose: "reflection",
      threadKey: dayKey,
      dayKey,
      createdAt: now,
      lastMessageAt: now,
    });
    return { chatId, dayKey };
  },
});

/** Get-or-create the caller's one standing Ask Rabbithole thread. */
export const getOrCreateIntrospection = authedMutation({
  args: {},
  handler: async (ctx) => {
    const scholarId = ctx.user._id;
    const existing = await ctx.db
      .query("metaChats")
      .withIndex("by_scholar_purpose_thread", (q) =>
        q
          .eq("scholarId", scholarId)
          .eq("purpose", "introspection")
          .eq("threadKey", INTROSPECTION_THREAD_KEY),
      )
      .unique();
    if (existing) return { chatId: existing._id };

    const now = Date.now();
    const chatId = await ctx.db.insert("metaChats", {
      scholarId,
      purpose: "introspection",
      threadKey: INTROSPECTION_THREAD_KEY,
      createdAt: now,
      lastMessageAt: now,
    });
    return { chatId };
  },
});

/**
 * Persist a scholar turn + the empty assistant row the /meta-stream handler
 * fills. Verifies the chat belongs to the caller before writing.
 */
export const sendMessage = authedMutation({
  args: { chatId: v.id("metaChats"), content: v.string() },
  handler: async (ctx, args) => {
    const chat = await ctx.db.get(args.chatId);
    if (!chat || chat.scholarId !== ctx.user._id) {
      throw new Error("Forbidden: not your reflection chat");
    }
    const content = args.content.trim();
    if (!content) throw new Error("Message is empty");

    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const streamId = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const now = Date.now();
    // "<start>" is the empty-thread opener sentinel (the native client sends
    // it; web uses startOpener instead). Never persist it as a real user turn
    // — /meta-stream's empty-thread branch materializes the opener itself.
    // Persisting it would show a literal "<start>" bubble in web transcripts
    // and hand the model an unexplained token (the meta prompt, unlike the
    // tutor's, carries no <start> bullet).
    const isOpenerSentinel = content === "<start>";
    if (!isOpenerSentinel) {
      await ctx.db.insert("metaMessages", {
        chatId: args.chatId,
        role: "user",
        content,
        createdAt: now,
      });
    }
    const assistantMsgId = await ctx.db.insert("metaMessages", {
      chatId: args.chatId,
      role: "assistant",
      content: "",
      streamId,
      createdAt: now,
    });
    await ctx.db.patch(args.chatId, { lastMessageAt: now });
    return { assistantMsgId, streamId };
  },
});

/**
 * Create the empty assistant row for the day-aware OPENER, when the thread is
 * still empty. There's no user turn — the /meta-stream handler materializes a
 * `<start>` marker (mirroring the tutor) so the model produces the first line.
 * Returns null when the thread already has messages (so the client never
 * double-fires an opener). Verifies the chat belongs to the caller.
 */
export const startOpener = authedMutation({
  args: { chatId: v.id("metaChats") },
  handler: async (ctx, args) => {
    const chat = await ctx.db.get(args.chatId);
    if (!chat || chat.scholarId !== ctx.user._id) {
      throw new Error("Forbidden: not your reflection chat");
    }
    const existing = await ctx.db
      .query("metaMessages")
      .withIndex("by_chat", (q) => q.eq("chatId", args.chatId))
      .first();
    if (existing) return null; // opener only for a truly empty thread

    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const streamId = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const assistantMsgId = await ctx.db.insert("metaMessages", {
      chatId: args.chatId,
      role: "assistant",
      content: "",
      streamId,
      createdAt: Date.now(),
    });
    return { assistantMsgId, streamId };
  },
});

/** The caller's own chat messages, newest page first for bounded subscriptions. */
export const listMessages = authedQuery({
  args: {
    chatId: v.id("metaChats"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const chat = await ctx.db.get(args.chatId);
    if (!chat || chat.scholarId !== ctx.user._id) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const result = await ctx.db
      .query("metaMessages")
      .withIndex("by_chat", (q) => q.eq("chatId", args.chatId))
      .order("desc")
      .paginate(args.paginationOpts);
    return {
      ...result,
      page: result.page.map((m) => ({
        _id: m._id,
        role: m.role,
        content: m.content,
        streamId: m.streamId ?? null,
        createdAt: m.createdAt,
      })),
    };
  },
});

/**
 * A scholar's reflection thread, for STAFF — the chat is teacher-visible by
 * design (§9). Resolves the given day, or the scholar's most recent thread
 * when `dayKey` is omitted. Returns the day's messages (oldest first).
 */
export const listForScholar = teacherQuery({
  args: {
    scholarId: v.id("users"),
    purpose: v.optional(
      v.union(v.literal("reflection"), v.literal("introspection")),
    ),
    dayKey: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const purpose = args.purpose ?? "reflection";
    const chat =
      purpose === "introspection"
        ? await ctx.db
            .query("metaChats")
            .withIndex("by_scholar_purpose_thread", (q) =>
              q
                .eq("scholarId", args.scholarId)
                .eq("purpose", "introspection")
                .eq("threadKey", INTROSPECTION_THREAD_KEY),
            )
            .unique()
        : args.dayKey
          ? await ctx.db
              .query("metaChats")
              .withIndex("by_scholar_day", (q) =>
                q.eq("scholarId", args.scholarId).eq("dayKey", args.dayKey!),
              )
              .filter((q) => q.eq(q.field("purpose"), "reflection"))
              .unique()
          : await ctx.db
              .query("metaChats")
              .withIndex("by_scholar_day", (q) =>
                q.eq("scholarId", args.scholarId),
              )
              .filter((q) => q.eq(q.field("purpose"), "reflection"))
              .order("desc")
              .first();
    if (!chat) return null;
    const result = await ctx.db
      .query("metaMessages")
      .withIndex("by_chat", (q) => q.eq("chatId", chat._id))
      .order("desc")
      .paginate(args.paginationOpts);
    return {
      chatId: chat._id,
      purpose: chat.purpose,
      dayKey: chat.dayKey ?? null,
      messages: {
        ...result,
        page: result.page.map((m) => ({
          _id: m._id,
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
        })),
      },
    };
  },
});

/**
 * The caller's own Prep Time block config, or null. The CLIENT does the
 * time-window math to render the Home pin — this is just the window config.
 */
export const myPrepTimeBlock = authedQuery({
  args: {
    // Teacher/admin remote mode: inspect the named scholar's Home prep window.
    // Scholars may only read their own block.
    userId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    let scholarId = ctx.user._id;
    if (args.userId && args.userId !== ctx.user._id) {
      if (!isTeacherRole(ctx.user.role)) {
        throw new Error("Forbidden");
      }
      await requireActiveScholarAccess(ctx, ctx.user, args.userId);
      scholarId = args.userId;
    } else if (args.userId) {
      scholarId = args.userId;
    }
    return await resolvePrepTimeBlock(ctx, scholarId);
  },
});

/**
 * The homescreen "Today's reflection" subtitle — a one-line snippet naming what
 * the caller actually did on Rabbithole today (kids forget their day; name it
 * back for them). Same today's-sessions source as the reflection prompt, so the
 * card and the chat never disagree. Returns `{ subtitle }` — null when there's
 * no on-screen activity, so the client keeps its static fallback line. Resolves
 * "today" in the scholar's Prep Time timezone (fallback Pacific/Honolulu).
 */
export const myReflectionSnippet = authedQuery({
  args: {},
  handler: async (ctx) => {
    const scholarId = ctx.user._id;
    const block = await resolvePrepTimeBlock(ctx, scholarId);
    const timezone = block?.timezone ?? DEFAULT_TIMEZONE;
    const dayKey = dayKeyForTimezone(Date.now(), timezone);
    const todaySessions = await todaySessionsFor(
      ctx,
      scholarId,
      dayKey,
      timezone,
    );
    const todayRecord = await todayRecordFor(ctx, scholarId, dayKey, timezone);
    return { subtitle: buildReflectionSnippet(todaySessions, todayRecord) };
  },
});

/**
 * Client-visible Workshop feature flags — SERVER-authored, never a client env
 * guess. Derived from the same deployment env var that gates the tutor-side
 * wiring (isIdeaConvosEnabled), so the UI can never drift from the backend.
 * The Workshop reads `ideaConvosEnabled` to hide the redundant standalone
 * "Got an idea?" composer box once the reflection chat owns idea capture (via
 * send_idea_to_teacher). Both frontends (web WorkshopView, native meta) consume
 * this. Fail-open: when this is unknown/absent the box stays, preserving the
 * flag-OFF submit path.
 */
export const workshopFlags = authedQuery({
  args: {},
  handler: async () => {
    return { ideaConvosEnabled: isIdeaConvosEnabled() };
  },
});

// ── Teacher-facing config ──────────────────────────────────────────────────

/**
 * Upsert or remove the `prepTime` daily block on a group. Group edits are
 * roster-wide today (any teacher may edit any group — see scholarGroups.ts), so
 * this only requires the group to exist.
 *
 * Move 5 ruling: this now controls PARTICIPATION only — the entry's mere
 * presence means "this pod runs Scholar's Prep". WHEN it runs comes from the
 * institution's bell-schedule prep block (convex/lib/prepBlock.ts), never from
 * these times. The window fields (`startLocal`/`endLocal`/`days`/`timezone`) are
 * VESTIGIAL: still written to satisfy the schema (no migration in this PR) but
 * read nowhere. They stay optional so a caller can just toggle participation.
 */
export const setGroupDailyBlock = teacherMutation({
  args: {
    groupId: v.id("scholarGroups"),
    remove: v.optional(v.boolean()),
    label: v.optional(v.string()),
    // Vestigial (Move 5) — accepted for back-compat but no longer determine the
    // window. Defaulted below when absent so the participation toggle needn't
    // send them.
    startLocal: v.optional(v.string()),
    endLocal: v.optional(v.string()),
    days: v.optional(v.array(v.number())),
    timezone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupId);
    if (!group) throw new Error("Group not found.");
    const existing = (group.dailyBlocks ?? []).filter(
      (b) => b.key !== PREP_TIME_KEY,
    );

    if (args.remove) {
      await ctx.db.patch(args.groupId, { dailyBlocks: existing });
      return { removed: true as const };
    }

    // Preserve any previously stored window values (idempotent re-enable), else
    // fall back to the schedule's canonical Mon–Thu 14:30–15:00 placeholder.
    // These are not consumed anywhere — the bell block owns the real window.
    const prior = (group.dailyBlocks ?? []).find((b) => b.key === PREP_TIME_KEY);
    const block: DailyBlock = {
      key: PREP_TIME_KEY,
      label: args.label?.trim() || prior?.label || "Scholar’s Prep",
      startLocal: args.startLocal ?? prior?.startLocal ?? "14:30",
      endLocal: args.endLocal ?? prior?.endLocal ?? "15:00",
      days: args.days ?? prior?.days ?? [1, 2, 3, 4],
      timezone: args.timezone ?? prior?.timezone ?? DEFAULT_TIMEZONE,
    };
    await ctx.db.patch(args.groupId, { dailyBlocks: [...existing, block] });
    return { removed: false as const, block };
  },
});

/**
 * The Scholar's Prep window for a group — null when the pod does NOT run the
 * ritual (no `prepTime` entry), else the institution's canonical bell-schedule
 * window (Move 5). Teacher-gated; group reads are roster-wide, so any teacher
 * may read any group. RosterBoard's Tonight auto-default consumes this shape
 * (isWithinPrepWindow), so it now reads the same clock the scholar pin does.
 */
export const groupPrepTimeBlock = teacherQuery({
  args: { groupId: v.id("scholarGroups") },
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupId);
    if (!group) return null;
    const participates = (group.dailyBlocks ?? []).some(
      (b) => b.key === PREP_TIME_KEY,
    );
    if (!participates || !group.institutionId) return null;
    return canonicalPrepWindow(ctx, group.institutionId);
  },
});

/**
 * The teacher Prep-participation control state for a group: whether the pod runs
 * Scholar's Prep (the toggle) and the institution's canonical bell-schedule
 * `window` to NAME in the helper copy. Move 5: the control no longer sets times,
 * so it needs participation independently of whether a bell block exists —
 * groupPrepTimeBlock conflates the two (null in both cases). Teacher-gated.
 */
export const groupPrepControl = teacherQuery({
  args: { groupId: v.id("scholarGroups") },
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.groupId);
    if (!group) return null;
    const participates = (group.dailyBlocks ?? []).some(
      (b) => b.key === PREP_TIME_KEY,
    );
    const window = group.institutionId
      ? await canonicalPrepWindow(ctx, group.institutionId)
      : null;
    return { participates, window };
  },
});

// ── Internal (called by /meta-stream + the meta-observer) ──────────────────

/**
 * The chat owner + assistant-message ownership facts the /meta-stream handler
 * feeds `validateMetaStreamRequest`. Kept minimal so validation stays pure.
 */
export const getStreamValidation = internalQuery({
  args: { chatId: v.id("metaChats"), assistantMsgId: v.id("metaMessages") },
  handler: async (ctx, args) => {
    const chat = await ctx.db.get(args.chatId);
    const msg = await ctx.db.get(args.assistantMsgId);
    return {
      chatScholarId: (chat?.scholarId ?? null) as string | null,
      assistantChatId: (msg?.chatId ?? null) as string | null,
      assistantRole: (msg?.role ?? null) as string | null,
    };
  },
});

/**
 * Full context for the reflection prompt: reading level, today's session
 * titles, recent growth (last ~week), open ideas (dup-avoidance), and fresh
 * staff responses to deliver. NO transcripts and NO numeric mastery — the growth
 * fields are the SAME kid-facing LABELS /me shows (see weeklyGrowthFor). Only
 * what buildMetaSystemPrompt needs. `updateSuggestionIds` are the ideas whose
 * response is surfaced this turn (the handler stamps them seen at prompt-build
 * time via `markResponsesSeen`).
 */
export const getContext = internalQuery({
  args: { chatId: v.id("metaChats") },
  handler: async (ctx, args) => {
    const chat = await ctx.db.get(args.chatId);
    if (!chat) return null;
    const purpose = chat.purpose;
    const scholar = await ctx.db.get(chat.scholarId);
    const firstName = scholar?.name?.trim().split(/\s+/)[0] || "there";
    const readingLevel = scholar?.readingLevel ?? null;

    const messages = await recentModelMessages(ctx, args.chatId);

    let todaySessions: MetaTodaySession[] = [];
    let todayRecord: MetaTodayRecord | undefined;
    let weeklyGrowth: MetaWeeklyGrowth | undefined;
    if (purpose === "reflection") {
      if (!chat.dayKey) {
        throw new Error(`Reflection metaChat ${chat._id} is missing dayKey`);
      }
      // Today's sessions (in the block timezone) plus the rest of the day's
      // actual record. Introspection deliberately receives none of this.
      const block = await resolvePrepTimeBlock(ctx, chat.scholarId);
      const timezone = block?.timezone ?? DEFAULT_TIMEZONE;
      todaySessions = await todaySessionsFor(
        ctx,
        chat.scholarId,
        chat.dayKey,
        timezone,
      );
      todayRecord = await todayRecordFor(
        ctx,
        chat.scholarId,
        chat.dayKey,
        timezone,
      );
      weeklyGrowth = await weeklyGrowthFor(ctx, chat.scholarId, Date.now());
    }

    // Ideas still on the kid's board (not archived by them) — title + whether a
    // human has written back, for duplicate-avoidance.
    const openRows = await ctx.db
      .query("scholarSuggestions")
      .withIndex("by_scholar", (q) => q.eq("scholarId", chat.scholarId))
      .filter((q) => q.eq(q.field("archivedAt"), undefined))
      .collect();
    const openIdeas = openRows.map((r) => ({
      title: r.title,
      answered: !!r.staffResponse,
    }));

    let ideaUpdates: Array<{
      authorName: string;
      title: string;
      body: string;
    }> = [];
    let updateSuggestionIds: Array<Id<"scholarSuggestions">> = [];
    let credits: MetaCredit[] = [];
    let creditDeliverIds: Array<Id<"changelogEntries">> = [];
    if (purpose === "reflection") {
      // Staff responses and shipped-feature credits are delivered only through
      // Today's reflection. Ask Rabbithole must not consume that state.
      const allIdeas = await ctx.db
        .query("scholarSuggestions")
        .withIndex("by_scholar", (q) => q.eq("scholarId", chat.scholarId))
        .collect();
      const unseen = allIdeas.filter(
        (r) =>
          r.staffResponse &&
          (r.responseSeenAt === undefined ||
            r.responseSeenAt < r.staffResponse.at),
      );
      ideaUpdates = await Promise.all(
        unseen.map(async (r) => {
          const author = await ctx.db.get(r.staffResponse!.authorId);
          return {
            authorName: author?.name?.trim() || "Someone on the team",
            title: r.title,
            body: r.staffResponse!.body,
          };
        }),
      );
      updateSuggestionIds = unseen.map((r) => r._id);
      const undelivered = await undeliveredCreditsFor(ctx, chat.scholarId);
      credits = undelivered.credits;
      creditDeliverIds = undelivered.entryIds;
    }

    return {
      scholarId: chat.scholarId,
      purpose,
      firstName,
      readingLevel,
      todaySessions,
      todayRecord,
      weeklyGrowth,
      openIdeas,
      ideaUpdates,
      updateSuggestionIds,
      credits,
      creditDeliverIds,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };
  },
});

/** Patch the streaming assistant row (~every 200 chars). */
export const updateStreamContent = internalMutation({
  args: { messageId: v.id("metaMessages"), content: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.messageId, { content: args.content });
  },
});

/**
 * Finalize the assistant row, then schedule the meta-observer — exactly the
 * spot sessions schedule the main observer (from the finalize step, after the
 * exchange lands). An empty stream (error) drops the placeholder and schedules
 * nothing.
 */
export const finalizeStream = internalMutation({
  args: {
    messageId: v.id("metaMessages"),
    content: v.string(),
    model: v.optional(v.string()),
    tokensUsed: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.messageId);
    if (!args.content.trim()) {
      if (row) await ctx.db.delete(args.messageId);
      return;
    }
    await ctx.db.patch(args.messageId, {
      content: args.content,
      model: args.model,
      tokensUsed: args.tokensUsed,
      streamId: undefined,
    });
    if (row) {
      await ctx.db.patch(row.chatId, { lastMessageAt: Date.now() });
      // Welfare-first meta-observer runs after EVERY exchange (§8) — the launch
      // gate. Fire-and-forget via the scheduler, like observer.analyzeSession.
      await ctx.scheduler.runAfter(0, internal.metaObserver.analyzeMetaChat, {
        chatId: row.chatId,
      });
    }
  },
});

/**
 * Stamp `responseSeenAt` on ideas whose staff response was surfaced in a
 * reflection chat's updates section. Called at PROMPT-BUILD time (§5.6) — when
 * the chat actually shows the response — not at observer time.
 */
export const markResponsesSeen = internalMutation({
  args: { suggestionIds: v.array(v.id("scholarSuggestions")), at: v.number() },
  handler: async (ctx, args) => {
    for (const id of args.suggestionIds) {
      await ctx.db.patch(id, { responseSeenAt: args.at });
    }
  },
});

// ── Meta-observer support (context query + write path) ──────────────────────
// The observer ACTION lives in convex/metaObserver.ts ("use node"); its DB
// reads/writes go through these V8-runtime functions, mirroring how
// observer.ts (node) writes through analysisHelpers/masteryObservations/etc.

const META_OBSERVER_LEASE_MS = 2 * 60_000;
const META_OBSERVER_BATCH_MESSAGES = 80;
const META_OBSERVER_CONTEXT_MESSAGES = 20;

/**
 * Atomically lease the next completed range. Only one action can analyze a chat
 * at a time, and messages after the newest finalized assistant turn stay for
 * the next drain.
 */
export const claimMetaObserverRange = internalMutation({
  args: { chatId: v.id("metaChats") },
  handler: async (ctx, args) => {
    const chat = await ctx.db.get(args.chatId);
    if (!chat) return null;
    const now = Date.now();
    if (
      chat.observerLeaseId &&
      chat.observerLeaseExpiresAt &&
      chat.observerLeaseExpiresAt > now
    ) {
      return null;
    }

    const cursorAt = chat.observerCursorAt;
    const candidates = await ctx.db
      .query("metaMessages")
      .withIndex("by_chat", (q) => q.eq("chatId", args.chatId))
      .filter((q) =>
        cursorAt === undefined
          ? q.eq(q.field("chatId"), args.chatId)
          : q.gt(q.field("_creationTime"), cursorAt),
      )
      .order("asc")
      .take(META_OBSERVER_BATCH_MESSAGES);
    let throughIndex = -1;
    for (let index = 0; index < candidates.length; index++) {
      const message = candidates[index];
      // Preserve a contiguous completed prefix. A second stream can finish while
      // an earlier assistant row is still live; advancing past that row would
      // make its eventual content permanently invisible to the observer.
      if (message.role === "assistant" && message.streamId !== undefined) break;
      if (
        message.role === "assistant" &&
        message.content.trim()
      ) {
        throughIndex = index;
      }
    }
    if (throughIndex < 0) return null;
    const claimed = candidates.slice(0, throughIndex + 1);
    const throughAt = claimed[claimed.length - 1]._creationTime;
    const rangeKey = `${cursorAt ?? "start"}:${throughAt}`;
    const completed = await ctx.db
      .query("metaObserverRuns")
      .withIndex("by_chat_range", (q) =>
        q.eq("chatId", args.chatId).eq("rangeKey", rangeKey),
      )
      .unique();
    if (completed) {
      await ctx.db.patch(chat._id, { observerCursorAt: throughAt });
      await ctx.scheduler.runAfter(0, internal.metaObserver.analyzeMetaChat, {
        chatId: chat._id,
      });
      return null;
    }

    const priorNewest =
      cursorAt === undefined
        ? []
        : await ctx.db
            .query("metaMessages")
            .withIndex("by_chat", (q) => q.eq("chatId", args.chatId))
            .filter((q) => q.lte(q.field("_creationTime"), cursorAt))
            .order("desc")
            .take(META_OBSERVER_CONTEXT_MESSAGES);
    const scholar = await ctx.db.get(chat.scholarId);
    const open = await ctx.db
      .query("scholarSuggestions")
      .withIndex("by_scholar", (q) => q.eq("scholarId", chat.scholarId))
      .filter((q) => q.eq(q.field("archivedAt"), undefined))
      .collect();
    const leaseId = `${now}:${Math.random().toString(36).slice(2)}`;
    await ctx.db.patch(chat._id, {
      observerLeaseId: leaseId,
      observerLeaseExpiresAt: now + META_OBSERVER_LEASE_MS,
    });
    return {
      leaseId,
      rangeKey,
      expectedCursorAt: cursorAt,
      throughAt,
      scholarId: chat.scholarId,
      scholarName: scholar?.name ?? null,
      institutionProfile: await institutionPromptProfileForScholar(
        ctx,
        chat.scholarId,
      ),
      purpose: chat.purpose,
      openTitles: open.map((o) => o.title),
      openCount: open.length,
      contextMessages: priorNewest.reverse().map((m) => ({
        id: String(m._id),
        role: m.role,
        content: m.content,
      })),
      newMessages: claimed.map((m) => ({
        id: String(m._id),
        role: m.role,
        content: m.content,
      })),
    };
  },
});

/** Release a failed claim only if it is still owned by this action. */
export const releaseMetaObserverLease = internalMutation({
  args: {
    chatId: v.id("metaChats"),
    leaseId: v.string(),
  },
  handler: async (ctx, args) => {
    const chat = await ctx.db.get(args.chatId);
    if (!chat || chat.observerLeaseId !== args.leaseId) return false;
    await ctx.db.patch(chat._id, {
      observerLeaseId: undefined,
      observerLeaseExpiresAt: undefined,
    });
    return true;
  },
});

const META_SAFETY_ALERT = v.object({
  severity: v.union(v.literal("critical"), v.literal("warning")),
  category: v.optional(v.string()),
  summary: v.string(),
  excerpt: v.optional(v.string()),
  sourceMessageId: v.string(),
});

const META_SUGGESTION = v.object({
  title: v.string(),
  scholarWords: v.string(),
  distilled: v.string(),
  consented: v.boolean(),
});

// High-bar self-reported portrait evidence (the meta-observer's third job).
// Exactly the QB shape (§4): conceptLabel + masteryLevel + note + quote.
const META_PORTRAIT_EVIDENCE = v.object({
  conceptLabel: v.string(),
  masteryLevel: v.number(),
  note: v.string(),
  quote: v.string(),
});

// Derived fields for a reflection masteryObservation — the structured output
// carries only the four fields above, so domain/confidence are fixed here:
//  - domain "metacognition": reflection evidence is self-report about one's own
//    learning, not a subject demonstration — a distinct, honest bucket.
//  - confidence 0.6: a self-report is real signal but softer than a demonstrated
//    skill, so it lands mid-scale (0.0-1.0) — never as certain as tutor-observed.
const REFLECTION_DOMAIN = "metacognition";
const REFLECTION_CONFIDENCE = 0.6;

/**
 * The meta-observer's write path. Runs AFTER the model call, in the V8 runtime
 * so it can touch the DB. Order mirrors observer.ts: raise the welfare alert
 * FIRST (fire-and-forget — an alert failure must never block anything else),
 * THEN insert consented ideas (respecting the open cap + skipping title
 * near-duplicates) and route each to the dedicated Workshop ideas inbox,
 * and FINALLY write any high-bar portrait evidence as reflection-typed
 * masteryObservations rows (§4/§8). Portrait rows are ADDITIVE observations the
 * teacher governs through the existing override surfaces — no supersession from
 * a reflection (a wrap-up chat never overwrites a working-session observation).
 */
export const applyMetaAnalysis = internalMutation({
  args: {
    chatId: v.id("metaChats"),
    leaseId: v.string(),
    rangeKey: v.string(),
    expectedCursorAt: v.optional(v.number()),
    throughAt: v.number(),
    newUserMessageIds: v.array(v.string()),
    safetyAlert: v.optional(META_SAFETY_ALERT),
    suggestions: v.array(META_SUGGESTION),
    portraitEvidence: v.optional(v.array(META_PORTRAIT_EVIDENCE)),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ alerted: boolean; captured: number; portraitEvidence: number }> => {
    const chat = await ctx.db.get(args.chatId);
    if (!chat) return { alerted: false, captured: 0, portraitEvidence: 0 };
    const completed = await ctx.db
      .query("metaObserverRuns")
      .withIndex("by_chat_range", (q) =>
        q.eq("chatId", args.chatId).eq("rangeKey", args.rangeKey),
      )
      .unique();
    if (completed) {
      return { alerted: false, captured: 0, portraitEvidence: 0 };
    }
    if (
      chat.observerLeaseId !== args.leaseId ||
      chat.observerCursorAt !== args.expectedCursorAt
    ) {
      throw new Error("Meta-observer claim is stale");
    }

    const purpose = chat.purpose;
    const scholarId = chat.scholarId;
    const scholar = await ctx.db.get(scholarId);
    const scholarName = scholar?.name ?? null;

    // 1. Welfare alert BEFORE any idea write, so a later write can't swallow it.
    //    Fire-and-forget: raiseAlert never throws, and the extra guard mirrors
    //    observer.ts's wrapper so an alert hiccup can't break the chat path.
    let alerted = false;
    if (
      args.safetyAlert &&
      args.newUserMessageIds.includes(args.safetyAlert.sourceMessageId)
    ) {
      const sa = args.safetyAlert;
      const deepLink = withBase(siteUrl(), scholarPath(scholarId));
      const body = [
        escapeSlackText(sa.summary),
        sa.excerpt ? `> ${escapeSlackText(sa.excerpt)}` : null,
        sa.category ? `Category: ${escapeSlackText(sa.category)}` : null,
        `Source: ${purpose === "reflection" ? "Today's reflection" : "Ask Rabbithole"}`,
      ]
        .filter(Boolean)
        .join("\n");
      await raiseAlert(ctx, {
        kind: "welfare",
        severity: sa.severity,
        source: "meta_chat",
        audience: "institution",
        title: `Welfare disclosure — ${escapeSlackText(scholarName ?? "a scholar")}`,
        body,
        scholarId,
        deepLink,
        dedupKey: `welfare-meta:${scholarId}:${sa.sourceMessageId}`,
      });
      alerted = true;
    }

    // 2. Consented ideas → scholarSuggestions rows. Authoritative cap + dedupe
    //    read here (state may have moved since the model saw it).
    //
    //    IDEA CONVERSATIONS: when WORKSHOP_IDEA_CONVOS_ENABLED is on, the
    //    send_idea_to_teacher tool is the SOLE capture path — the scholar sends
    //    ideas in-conversation, so the observer must NOT also distill them or
    //    we'd double-capture. Skip this arm entirely under the flag (welfare in
    //    step 1 and portrait evidence in step 3 are untouched). Flag off → the
    //    observer captures exactly as before.
    const ideaConvos =
      purpose === "introspection" || isIdeaConvosEnabled();
    const open = ideaConvos
      ? []
      : await ctx.db
          .query("scholarSuggestions")
          .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
          .filter((q) => q.eq(q.field("archivedAt"), undefined))
          .collect();
    let openCount = open.length;
    const existingTitles = new Set(
      open.map((o) => o.title.trim().toLowerCase()),
    );

    let captured = 0;
    for (const s of ideaConvos ? [] : args.suggestions) {
      if (!s.consented) continue; // no consent → never a row
      if (openCount >= MAX_OPEN_SUGGESTIONS_EXPORT) continue; // at cap → skip
      const title = s.title.trim();
      if (!title) continue;
      const key = title.toLowerCase();
      if (existingTitles.has(key)) continue; // near-duplicate → skip

      const now = Date.now();
      const suggestionId = await ctx.db.insert("scholarSuggestions", {
        scholarId,
        title,
        scholarWords: s.scholarWords,
        distilled: s.distilled,
        sourceChatId: args.chatId,
        createdAt: now,
        updatedAt: now,
      });
      existingTitles.add(key);
      openCount++;
      captured++;

      await fanOutWorkshopIdea(ctx, {
        suggestionId,
      });
    }

    // 3. Portrait evidence → reflection-typed masteryObservations rows (§4/§8).
    //    Governed memory: observer-authored, schema'd, teacher-visible via the
    //    existing override surfaces. NO supersession (a reflection never
    //    overwrites a working-session observation) and NO seeds/signals.
    let portraitCount = 0;
    for (const p of purpose === "reflection" ? (args.portraitEvidence ?? []) : []) {
      const conceptLabel = p.conceptLabel.trim();
      const quote = p.quote.trim();
      if (!conceptLabel || !quote) continue; // defensive; parser already filters
      // Keep masteryLevel on the 0.0-5.0 Bloom scale even if the model drifts.
      const masteryLevel = Math.max(0, Math.min(5, p.masteryLevel));
      await ctx.db.insert("masteryObservations", {
        scholarId,
        conceptLabel,
        domain: REFLECTION_DOMAIN,
        observedAt: Date.now(),
        metaChatId: args.chatId,
        transcriptExcerpt: quote,
        masteryLevel,
        confidenceScore: REFLECTION_CONFIDENCE,
        evidenceSummary: p.note.trim(),
        evidenceType: "reflection",
        attemptContext: "reflection",
        studentInitiated: true,
        isSuperseded: false,
      });
      portraitCount++;
    }

    await ctx.db.insert("metaObserverRuns", {
      chatId: args.chatId,
      rangeKey: args.rangeKey,
      throughAt: args.throughAt,
      createdAt: Date.now(),
    });
    await ctx.db.patch(chat._id, {
      observerCursorAt: args.throughAt,
      observerLeaseId: undefined,
      observerLeaseExpiresAt: undefined,
    });
    await ctx.scheduler.runAfter(0, internal.metaObserver.analyzeMetaChat, {
      chatId: args.chatId,
    });

    return { alerted, captured, portraitEvidence: portraitCount };
  },
});
