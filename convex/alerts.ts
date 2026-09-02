/**
 * General staff-facing ALERT fabric — urgent, institution-scoped posts to
 * admin-linked Slack alert channels.
 *
 *   slackNotifications = per-group, opt-in, DIGESTED activity notices
 *     (completions, deliverable submissions) to whichever channel a teacher
 *     linked. Calm; one daily roll-up.
 *   alerts (this file)  = high-urgency, fire-once events routed IMMEDIATELY
 *     to the admin-linked alert channel for the scholar's institution (with a
 *     catchall fallback). Platform-level operational alerts route to the
 *     dedicated platform-ops channel.
 *
 * Four explicit channel roles:
 *   "scoped"       — one channel per institution; receives scholar alerts,
 *                    Quality Pulse, and Practice Portrait for that institution.
 *   "catchall"     — fallback for institutions without a scoped channel;
 *                    receives scholar alerts + reports for any institution that
 *                    has no dedicated scoped channel.
 *   "platform-ops" — single dedicated channel for firm-wide cost/usage reports
 *                    and generic non-scholar system/error alerts. Never receives
 *                    scholar alerts or institution reports.
 *   "improvement-loops" — single private platform-wide channel for generic
 *                    cadence pointers and redacted proposal threads. Never
 *                    receives scholar data or alert content.
 *
 * Every alert declares one explicit `audience`:
 *   "institution" → an institution-facing alert. Resolve the institution from
 *                   `institutionId` (if given) else the scholar's
 *                   scholar membership; post to that institution's scoped
 *                   channel, falling back to the catchall. If the institution
 *                   can't be resolved (no ids, or the scholar has none), post
 *                   to the catchall directly. Producers: welfare/parasocial,
 *                   scholar feedback, seed spawns, and the per-institution
 *                   weekly digests (Quality Pulse, Practice Portrait).
 *   "platform"    → a firm-wide operational alert with no institution scope
 *                   (cost/usage report, pipeline failures). Posts to the
 *                   platform-ops channel only; never a scoped or catchall one.
 *
 * Everything is fire-and-forget: raising an alert must NEVER throw into a
 * producing action/mutation. When no channel is linked yet, the alert row
 * is still recorded (audit trail) — it just doesn't post anywhere.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { isPlatformAdminRole } from "./lib/roles";
import { teacherQuery } from "./lib/customFunctions";
import { requireActiveScholarAccess } from "./lib/access";
import { scholarInstitutionId } from "./lib/scholarEnrollment";

const ALERT_SEVERITY = v.union(
  v.literal("critical"),
  v.literal("warning"),
  v.literal("info"),
);

export type AlertSeverity = "critical" | "warning" | "info";

// A practice struggle may be productive struggle, not a warning. Keep warning
// severity for routing, but use a value-neutral glyph for this kind alone.
const ALERT_KIND_EMOJI: Readonly<Record<string, string>> = {
  practice_stuck: "🧗",
  // Asking to stop is a feeling, not a failure. A severity glyph (⚠️) would
  // read as "this scholar is a problem"; this one reads as "this was hard".
  chat_overwhelm: "😫",
};

export function alertEmoji(
  kind: string,
  severity: AlertSeverity,
): string {
  return (
    ALERT_KIND_EMOJI[kind] ??
    (severity === "critical" ? "🚨" : severity === "warning" ? "⚠️" : "ℹ️")
  );
}

// Re-alert window: a producer passing a stable dedupKey only generates a
// NEW alert if no alert with that key was raised in the last 12h. Keeps an
// ongoing situation (re-detected on every observer pass) to one post,
// while still re-alerting if it recurs the next day. A producer can pass a
// longer `dedupWindowMs` for a slow-moving PATTERN (vs. an emergency) so it
// doesn't nag — e.g. parasocial over-reliance coalesces over days.
const DEDUP_WINDOW_MS = 12 * 60 * 60 * 1000;
type AlertDbCtx = Pick<MutationCtx | QueryCtx, "db">;

export interface RaiseAlertArgs {
  kind: string;
  severity: AlertSeverity;
  title: string;
  body: string;
  source: string;
  // Routing axis (required). "institution" resolves a scoped→catchall channel
  // from institutionId/scholar; "platform" posts to the platform-ops channel.
  audience: "institution" | "platform";
  scholarId?: Id<"users">;
  sessionId?: Id<"sessions">;
  deepLink?: string;
  dedupKey?: string;
  // Override the default 12h coalescing window (ms). For a pattern, not an
  // emergency, pass something longer so re-detections don't re-post.
  dedupWindowMs?: number;
  // For an "institution"-audience alert with no scholar (e.g. the weekly
  // per-institution digests): the institution to route to. Ignored for
  // "platform". When both this and scholarId are set, this takes precedence.
  institutionId?: Id<"institutions">;
  practiceTriggerAttemptId?: Id<"practiceAttempts">;
}

// ─── Internal channel helpers ──────────────────────────────────────────────

/**
 * Derive the effective role of a channel row. Handles legacy rows that were
 * inserted before the explicit `role` field existed.
 * Legacy: institutionId set → "scoped"; institutionId absent → "catchall".
 */
export function effectiveRole(ch: {
  role?: "scoped" | "catchall" | "platform-ops" | "improvement-loops";
  institutionId?: Id<"institutions">;
}): "scoped" | "catchall" | "platform-ops" | "improvement-loops" {
  if (ch.role === "platform-ops") return "platform-ops";
  if (ch.role === "improvement-loops") return "improvement-loops";
  if (ch.role === "scoped") return "scoped";
  if (ch.role === "catchall") return "catchall";
  // Legacy row: derive from institutionId presence.
  return ch.institutionId !== undefined ? "scoped" : "catchall";
}

/**
 * Find the scoped channel for a specific institution, skipping platform-ops.
 */
async function findScopedChannel(
  ctx: AlertDbCtx,
  institutionId: Id<"institutions">,
): Promise<string | null> {
  const rows = await ctx.db
    .query("alertChannel")
    .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
    .collect();
  const ch = rows.find((r) => effectiveRole(r) === "scoped");
  return ch?.slackChannelId ?? null;
}

/**
 * Find the catchall channel (any row with no institutionId that is not
 * platform-ops). Handles legacy rows (no role field).
 */
async function findCatchallChannel(
  ctx: AlertDbCtx,
): Promise<string | null> {
  const rows = await ctx.db
    .query("alertChannel")
    .withIndex("by_institution", (q) => q.eq("institutionId", undefined))
    .collect();
  const ch = rows.find((r) => effectiveRole(r) === "catchall");
  return ch?.slackChannelId ?? null;
}

/**
 * Find the platform-ops channel (explicit role only — never a legacy row).
 */
async function findPlatformOpsChannel(
  ctx: AlertDbCtx,
): Promise<string | null> {
  const ch = await ctx.db
    .query("alertChannel")
    .withIndex("by_role", (q) => q.eq("role", "platform-ops"))
    .first();
  return ch?.slackChannelId ?? null;
}

/**
 * Resolve the target channel IDs for a given alert, applying the routing rules.
 *   audience "platform"    → the platform-ops channel only (or []).
 *   audience "institution" → institution = institutionId ?? scholar's
 *                            institutionId; its scoped channel, else the
 *                            catchall. Unresolvable institution → catchall.
 */
export async function resolveTargetChannels(
  ctx: AlertDbCtx,
  args: Pick<RaiseAlertArgs, "audience" | "scholarId" | "institutionId">,
): Promise<string[]> {
  if (args.audience === "platform") {
    const ch = await findPlatformOpsChannel(ctx);
    return ch ? [ch] : [];
  }

  // audience === "institution": resolve the institution from an explicit id,
  // else the scholar's institution.
  let instId = args.institutionId;
  if (!instId && args.scholarId) {
    instId = await scholarInstitutionId(ctx, args.scholarId);
  }
  if (instId) {
    const ch = await findScopedChannel(ctx, instId);
    if (ch) return [ch];
  }
  // No institution resolved, or it has no scoped channel → catchall.
  const fallback = await findCatchallChannel(ctx);
  return fallback ? [fallback] : [];
}

// ──────────────────────────────────────────────────────────────────────────────

/**
 * Record an alert and (if a channel is linked) post it immediately. Plain
 * in-transaction function so producers can call it directly from a
 * mutation; the `raise` internalMutation below wraps it for "use node"
 * actions. Never throws.
 */
export async function raiseAlert(
  ctx: MutationCtx,
  args: RaiseAlertArgs,
): Promise<Id<"alerts"> | undefined> {
  try {
    // Coalesce repeats for the same ongoing situation.
    if (args.dedupKey) {
      const dedupKey = args.dedupKey;
      const recent = await ctx.db
        .query("alerts")
        .withIndex("by_dedup", (q) => q.eq("dedupKey", dedupKey))
        .collect();
      const since = Date.now() - (args.dedupWindowMs ?? DEDUP_WINDOW_MS);
      const duplicate = recent.find((a) => a.createdAt >= since);
      if (duplicate) {
        return duplicate.practiceTriggerAttemptId ===
          args.practiceTriggerAttemptId
          ? duplicate._id
          : undefined;
      }
    }

    const createdAt = Date.now();
    const alertId = await ctx.db.insert("alerts", {
      kind: args.kind,
      severity: args.severity,
      title: args.title,
      body: args.body,
      source: args.source,
      scholarId: args.scholarId,
      sessionId: args.sessionId,
      deepLink: args.deepLink,
      practiceTriggerAttemptId: args.practiceTriggerAttemptId,
      dedupKey: args.dedupKey,
      status: "open",
      createdAt,
    });

    const emoji = alertEmoji(args.kind, args.severity);
    const lines = [`${emoji} *${args.title}*`, args.body];
    if (args.deepLink) lines.push(`<${args.deepLink}|Open in Rabbithole>`);
    const text = lines.join("\n");

    const deliveryInstitutionId =
      args.institutionId ??
      (args.scholarId
        ? await scholarInstitutionId(ctx, args.scholarId)
        : undefined);
    const targetChannelIds = await resolveTargetChannels(ctx, {
      audience: args.audience,
      scholarId: args.scholarId,
      institutionId: deliveryInstitutionId,
    });

    // Observability: a high-urgency alert that resolves to no channel is
    // silently dropped from Slack (the row is still recorded above). Warn so
    // a mislinked/unlinked deployment is visible. Still fire-and-forget.
    if (
      targetChannelIds.length === 0 &&
      (args.severity === "critical" || args.severity === "warning")
    ) {
      console.warn(
        `raiseAlert: ${args.severity} alert resolved to ZERO channels ` +
          `(kind=${args.kind}, audience=${args.audience}) — recorded but not posted.`,
      );
    }

    for (const channelId of targetChannelIds) {
      await ctx.scheduler.runAfter(0, internal.slackNotifications.postNow, {
        channelId,
        text,
        scholarId: args.scholarId,
        institutionId: deliveryInstitutionId,
        alertAudience: args.audience,
        alertId,
        alertCreatedAt: createdAt,
      });
    }
    return alertId;
  } catch (err) {
    console.error("raiseAlert failed (ignored):", err);
    return undefined;
  }
}

export const getAlertCreatedAt = internalQuery({
  args: { alertId: v.id("alerts") },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, args) => {
    const alert = await ctx.db.get(args.alertId);
    return alert?.createdAt ?? null;
  },
});

export const recordSlackDelivery = internalMutation({
  args: {
    alertId: v.id("alerts"),
    channelId: v.string(),
    messageTs: v.string(),
  },
  handler: async (ctx, args) => {
    const alert = await ctx.db.get(args.alertId);
    if (!alert) return false;
    if (alert.slackChannelId && alert.slackMessageTs) return true;
    await ctx.db.patch(alert._id, {
     slackChannelId: args.channelId,
     slackMessageTs: args.messageTs,
    });
    if (alert.practiceTriggerAttemptId) {
     await ctx.scheduler.runAfter(
       0,
       internal.practiceStuckAlert.postOutcome,
       { triggerAttemptId: alert.practiceTriggerAttemptId },
     );
    }
    return true;
  },
});

export const deliveryAllowed = internalQuery({
  args: {
    channelId: v.string(),
    audience: v.union(v.literal("institution"), v.literal("platform")),
    scholarId: v.optional(v.id("users")),
    institutionId: v.optional(v.id("institutions")),
  },
  handler: async (ctx, args) => {
    if (
      args.scholarId &&
      (await scholarInstitutionId(ctx, args.scholarId)) !== args.institutionId
    ) {
      return false;
    }
    const channels = await resolveTargetChannels(ctx, {
      audience: args.audience,
      scholarId: args.scholarId,
      institutionId: args.institutionId,
    });
    return channels.includes(args.channelId);
  },
});

/** Whether a Slack channel is one of Rabbithole's configured alert lanes. */
export const isLinkedAlertChannel = internalQuery({
  args: { channelId: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    const rows = await ctx.db.query("alertChannel").collect();
    return rows.some((row) => row.slackChannelId === args.channelId);
  },
});

/**
 * internalMutation wrapper so a "use node" action (the observer) can raise
 * an alert via ctx.runMutation. Mirrors `raiseAlert` exactly. `audience` is
 * required — "institution" (scoped→catchall) or "platform" (platform-ops).
 */
export const raise = internalMutation({
  args: {
    kind: v.string(),
    severity: ALERT_SEVERITY,
    title: v.string(),
    body: v.string(),
    source: v.string(),
    audience: v.union(v.literal("institution"), v.literal("platform")),
    scholarId: v.optional(v.id("users")),
    sessionId: v.optional(v.id("sessions")),
    deepLink: v.optional(v.string()),
    dedupKey: v.optional(v.string()),
    dedupWindowMs: v.optional(v.number()),
    institutionId: v.optional(v.id("institutions")),
  },
  handler: async (ctx, args) => raiseAlert(ctx, args),
});

const ALERT_CHANNEL_ROLE = v.optional(
  v.union(
    v.literal("scoped"),
    v.literal("catchall"),
    v.literal("platform-ops"),
    v.literal("improvement-loops"),
  ),
);

/**
 * Admin-only: link (or unlink) THIS Slack channel as an alert destination.
 *
 * Role semantics:
 *   "scoped"       — requires institution_slug or institutionId; receives that
 *                    institution's scholar alerts, Quality Pulse, Practice Portrait.
 *   "catchall"     — no institution; fallback for institutions without a scoped
 *                    channel. Omitting role when also omitting institution_slug
 *                    defaults to "catchall" for backward compatibility.
 *   "platform-ops" — no institution; receives firm-wide cost/usage reports and
 *                    generic system/error alerts. Only one platform-ops channel
 *                    can be linked at a time.
 *   "improvement-loops" — no institution; receives generic Rounds/Coherence
 *                    pointers and redacted proposal threads. Only one can be linked.
 *
 * Gated to ADMIN since it's a school-wide setting.
 */
export const linkAlertsChannel = internalMutation({
  args: {
    callerUserId: v.id("users"),
    slackChannelId: v.string(),
    unlink: v.boolean(),
    // Scope by institution id OR slug (slug is resolved here; id takes
    // precedence). Required for "scoped" role; ignored for "catchall" and
    // "platform-ops" and "improvement-loops".
    institutionId: v.optional(v.id("institutions")),
    institutionSlug: v.optional(v.string()),
    // Explicit role. Defaults to "scoped" if institutionId/institutionSlug is
    // provided, "catchall" otherwise (backward-compatible with legacy callers).
    role: ALERT_CHANNEL_ROLE,
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    ok: boolean;
    message: string;
    // On a successful LINK: the effective role + (for scoped) the institution
    // name, so the Slack tool can stamp a role-appropriate channel topic.
    role?: "scoped" | "catchall" | "platform-ops" | "improvement-loops";
    institutionName?: string;
  }> => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller || !isPlatformAdminRole(caller.role)) {
      return {
        ok: false,
        message: "Forbidden: admin role required to link the alerts channel.",
      };
    }

    // Resolve institution: prefer explicit id, then slug lookup.
    let institutionId = args.institutionId;
    if (!institutionId && args.institutionSlug) {
      const inst = await ctx.db
        .query("institutions")
        .withIndex("by_slug", (q) => q.eq("slug", args.institutionSlug!))
        .first();
      if (!inst) {
        const all = await ctx.db.query("institutions").collect();
        const slugs = all.map((i) => i.slug).join(", ") || "(none)";
        return {
          ok: false,
          message: `No institution found with slug "${args.institutionSlug}". Available slugs: ${slugs}.`,
        };
      }
      institutionId = inst._id;
    }

    // Determine the effective role.
    const role: "scoped" | "catchall" | "platform-ops" | "improvement-loops" =
      args.role ??
      (institutionId !== undefined ? "scoped" : "catchall");

    // Validate role ↔ institutionId consistency.
    if (role === "scoped" && !institutionId) {
      return {
        ok: false,
        message: "The \"scoped\" role requires an institution_slug or institutionId.",
      };
    }
    if (
      (role === "catchall" ||
        role === "platform-ops" ||
        role === "improvement-loops") &&
      institutionId
    ) {
      return {
        ok: false,
        message: `The "${role}" role does not accept an institution scope. Omit institution_slug.`,
      };
    }

    // Locate the existing row for this role/scope.
    let existing: { _id: Id<"alertChannel">; slackChannelId: string } | null =
      null;

    if (role === "scoped") {
      // One row per institution; look up by institutionId index.
      const row = await ctx.db
        .query("alertChannel")
        .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
        .first();
      if (row && effectiveRole(row) === "scoped") {
        existing = row;
      }
    } else if (role === "platform-ops" || role === "improvement-loops") {
      // Exactly one channel per platform-wide role; look up by the role index.
      existing =
        (await ctx.db
          .query("alertChannel")
          .withIndex("by_role", (q) => q.eq("role", role))
          .first()) ?? null;
    } else {
      // catchall: legacy/no-role catchall or explicit catchall only.
      const rows = await ctx.db
        .query("alertChannel")
        .withIndex("by_institution", (q) => q.eq("institutionId", undefined))
        .collect();
      existing = rows.find((r) => effectiveRole(r) === "catchall") ?? null;
    }

    if (args.unlink) {
      if (!existing || existing.slackChannelId !== args.slackChannelId) {
        return {
          ok: false,
          message: `This channel isn't the linked alerts channel for the "${role}" role.`,
        };
      }
      await ctx.db.delete(existing._id);
      const scopeDesc =
        role === "scoped"
          ? "that institution's"
          : role === "platform-ops" || role === "improvement-loops"
            ? role
            : "catchall";
      return {
        ok: true,
        message: `Unlinked — ${scopeDesc} alerts will no longer post here.`,
      };
    }

    const institution = institutionId ? await ctx.db.get(institutionId) : null;
    const institutionName = institution?.name ?? null;

    if (existing) {
      await ctx.db.patch(existing._id, {
        slackChannelId: args.slackChannelId,
        linkedBy: args.callerUserId,
        linkedAt: Date.now(),
        // Upgrade legacy rows to carry an explicit role.
        role,
      });
    } else {
      await ctx.db.insert("alertChannel", {
        slackChannelId: args.slackChannelId,
        linkedBy: args.callerUserId,
        linkedAt: Date.now(),
        institutionId: role === "scoped" ? institutionId : undefined,
        role,
      });
    }

    const scopeDesc =
      role === "platform-ops"
        ? "as the platform-ops channel (firm-wide cost/usage reports and system alerts)"
        : role === "improvement-loops"
          ? "as the improvement-loops channel (generic cadence and redacted proposal threads)"
        : institutionName
          ? `for ${institutionName} scholars`
          : "as the catchall channel for institutions without a dedicated channel";
    // What actually posts here differs by role: scoped/catchall get safety
    // alerts + the weekly institution reports; platform-ops gets cost/usage
    // reports + system alerts and NEVER safety alerts.
    const postsHere =
      role === "platform-ops"
        ? "The weekly cost/usage report and system alerts now post here."
        : role === "improvement-loops"
          ? "Generic improvement pointers and redacted proposal threads now post here; learner data never does."
        : "Urgent safety alerts and the weekly reports now post here.";
    return {
      ok: true,
      message: `Linked this channel for Rabbithole alerts ${scopeDesc}. ${postsHere}`,
      role,
      institutionName: institutionName ?? undefined,
    };
  },
});

/**
 * The platform-ops channel ID, or null if none is linked. Used by the weekly
 * cost/usage report to scope its canvas to the dedicated operational channel.
 */
export const platformOpsChannelId = internalQuery({
  args: {},
  handler: async (ctx): Promise<string | null> => {
    const ch = await ctx.db
      .query("alertChannel")
      .withIndex("by_role", (q) => q.eq("role", "platform-ops"))
      .first();
    return ch?.slackChannelId ?? null;
  },
});

/** The private platform-wide channel for generic improvement-loop cadence. */
export const improvementLoopsChannelId = internalQuery({
  args: {},
  handler: async (ctx): Promise<string | null> => {
    const ch = await ctx.db
      .query("alertChannel")
      .withIndex("by_role", (q) => q.eq("role", "improvement-loops"))
      .first();
    return ch?.slackChannelId ?? null;
  },
});

/**
 * Alert kinds that belong in a scholar's teacher-facing RECORD.
 *
 * Allowlisted SERVER-side, not passed by the caller, because the exclusions are
 * a privacy boundary rather than a display preference:
 *   - `welfare` — its producer deliberately keeps the urgent path Slack-only
 *     (see `recentByScholar` below); a calm chronological card is the wrong
 *     rendering for it, and escalation happens in the Slack thread.
 *   - `medication_authorization_expired`, `parent_health_record_update` —
 *     health content, gated elsewhere by `hasHealthAccessAtInstitution`
 *     (convex/lib/staffCapabilities.ts). This query carries no capability
 *     check, so including them would widen access to health data.
 *   - `parasocial_reliance` — already rendered as the pinned "Connection note"
 *     on the same surface. One canonical rendering per signal; a second
 *     chronological copy would be the duplicate this repo's taste rules forbid.
 *   - `slide_image_guardrail` — RETIRED. Its producer (a Haiku authorship
 *     classifier on slide-image briefs) was deleted 2026-08-25 after its
 *     complete production record came back 13/13 false positives — every flag
 *     a decorative prop misread as offloading — so no new rows of this kind can
 *     exist. Historical prod rows remain (alerts.kind is an open string), and
 *     they must stay OUT of the record: each one wrongly implies a child tried
 *     to offload their thinking, the opposite of "a portrait, not a report
 *     card".
 *   - device / bug_report / digest / usage kinds — operations and platform
 *     alerts. Not a learning record, and mostly not scholar-scoped at all.
 *
 * What remains is the scholar's own learning story: how the tutoring went, what
 * they pushed back on, and where practice stalled.
 */
export const SCHOLAR_RECORD_ALERT_KINDS: readonly string[] = [
  "chat_stuck",
  "chat_overwhelm",
  "scholar_feedback",
  "practice_stuck",
  "practice_not_yet_taught",
  "seed_spawn",
];

const SCHOLAR_RECORD_KIND_SET = new Set(SCHOLAR_RECORD_ALERT_KINDS);

/**
 * Every record-eligible alert for one scholar, newest first.
 *
 * This is a RECORD, not an inbox: no unread count, no acknowledgement, no
 * closure condition — the same posture the table comment in schema.ts spells
 * out. It exists so the web UI is a complete account of what the system
 * noticed, instead of that account living only in Slack scrollback.
 *
 * Same teacher gate and institution boundary as `recentByScholar`.
 */
export const recordForScholar = teacherQuery({
  args: {
    scholarId: v.id("users"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const rows = await ctx.db
      .query("alerts")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .order("desc")
      .collect();
    return rows
      .filter((a) => SCHOLAR_RECORD_KIND_SET.has(a.kind))
      .slice(0, args.limit ?? 40)
      .map((a) => ({
        _id: a._id,
        kind: a.kind,
        severity: a.severity,
        title: a.title,
        body: a.body,
        deepLink: a.deepLink,
        sessionId: a.sessionId,
        createdAt: a.createdAt,
      }));
  },
});

/**
 * Recent alerts for a scholar of a given `kind`, most recent first.
 * Teacher-gated (teacher/admin only) — scholars, operations staff and parents are
 * rejected server-side. Powers calm IN-APP surfaces for low-urgency alert
 * kinds (e.g. the parasocial "Connection note" on the scholar's plate). The
 * urgent welfare path stays Slack-only by its producer's choice; this query
 * only returns what a caller explicitly asks for by kind.
 *
 * Prefer `recordForScholar` above for the chronological record; this one stays
 * for a surface that wants exactly one kind and its own rendering.
 */
export const recentByScholar = teacherQuery({
  args: {
    scholarId: v.id("users"),
    kind: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // teacherQuery already guarantees a teacher/admin caller; add the
    // institution boundary so a cross-institution teacher can't read another
    // school's scholar's alerts once enforcement is on (no-op while off).
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const rows = await ctx.db
      .query("alerts")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .order("desc")
      .collect();
    return rows
      .filter((a) => a.kind === args.kind)
      .slice(0, args.limit ?? 20);
  },
});
