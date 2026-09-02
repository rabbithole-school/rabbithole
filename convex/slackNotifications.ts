/**
 * Outbound Slack notifications — the "#geckos" surface from
 * review/slack-bot-plan.md Phase 3.
 *
 * THE OPT-IN RULE: notifications only ever go to a Slack channel that a
 * teacher explicitly linked to a scholar group (the bot's
 * `link_channel_to_group` tool). No link → no posts; the general
 * teaching channel never gets unsolicited messages.
 *
 * Delivery: default is a calm HOURLY UPDATE in the day's end-of-day check-in
 * thread; a group can opt into "immediate" mode.
 * Event producers (activityCompletions, deliverables) call
 * `notifyScholarEvent` after their writes; everything downstream of that
 * call is fire-and-forget and must never break the producing mutation.
 */
import { v } from "convex/values";
import {
  internalMutation,
  internalAction,
  internalQuery,
} from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id, Doc } from "./_generated/dataModel";
import { isTeacherRole } from "./lib/roles";
import {
  fetchConversationHistory,
  fetchConversationReplies,
  messageWithDeliveryMetadata,
  postMessage,
  type SlackMessageMetadata,
} from "./lib/slackApi";
import { siteUrl, scholarPath, withBase } from "./lib/channels";
import { owningGroupForScholar } from "../shared/scholarGroupRouting";
import { scholarInstitutionId } from "./lib/scholarEnrollment";
import { effectiveInstitutionTimeZone } from "./lib/institutionTime";
import { checkinDayKey } from "./lib/eodCheckin";

const ACTIVITY_UPDATE_LIMIT = 50;
const ACTIVITY_UPDATE_EVENT_TYPE = "rabbithole_activity_update";
// Convex actions hard-stop at 10 minutes. Keep the lease beyond that ceiling so
// an in-flight Slack call cannot overlap a reclaim; the next hourly tick still
// arrives well after this lease expires.
const ACTIVITY_UPDATE_LEASE_MS = 15 * 60 * 1000;
const ALERT_DELIVERY_EVENT_TYPE = "rabbithole_alert";
const ALERT_DELIVERY_MAX_ATTEMPTS = 8;
const ALERT_DELIVERY_RETRY_BASE_MS = 5_000;
const ALERT_DELIVERY_RETRY_MAX_MS = 5 * 60 * 1000;

function alertDeliveryRetryDelay(attempt: number, retryAfterMs?: number): number {
  return Math.max(
    retryAfterMs ?? 0,
    Math.min(
      ALERT_DELIVERY_RETRY_BASE_MS * 2 ** attempt,
      ALERT_DELIVERY_RETRY_MAX_MS,
    ),
  );
}

// siteUrl now lives in lib/channels (shared with the aide deep-link layer);
// re-exported here so existing importers keep their path.
export { siteUrl };

async function groupDeliveryIsCurrent(
  ctx: Pick<QueryCtx, "db">,
  args: {
    groupId: Id<"scholarGroups">;
    channelId: string;
    scholarIds?: Id<"users">[];
  },
): Promise<boolean> {
  const group = await ctx.db.get(args.groupId);
  if (
    !group?.institutionId ||
    group.slackChannelId !== args.channelId ||
    args.scholarIds?.some((id) => !group.scholarIds.includes(id))
  ) {
    return false;
  }
  const institutionIds = await Promise.all(
    group.scholarIds.map((id) => scholarInstitutionId(ctx, id)),
  );
  return institutionIds.every((id) => id === group.institutionId);
}

/** Absolute deep link to a scholar's profile in the teacher dashboard. */
export function scholarDeepLink(scholarId: Id<"users">): string {
  return withBase(siteUrl(), scholarPath(scholarId));
}

// ── Channel ↔ group linking (the opt-in) ────────────────────────────────

export const linkChannelToGroup = internalMutation({
  args: {
    callerUserId: v.id("users"),
    groupName: v.string(),
    slackChannelId: v.string(),
    unlink: v.boolean(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: boolean; message: string }> => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller || !isTeacherRole(caller.role)) {
      return { ok: false, message: "Forbidden: teacher or admin role required" };
    }
    const query = args.groupName.trim().toLowerCase();
    if (!query) return { ok: false, message: "Which scholar group?" };

    const groups = await ctx.db.query("scholarGroups").collect();
    const matches = groups.filter((g) => g.name.toLowerCase().includes(query));
    if (matches.length === 0) {
      const names = groups.map((g) => g.name).join(", ") || "(none exist yet)";
      return {
        ok: false,
        message: `No scholar group matches "${args.groupName}". Groups: ${names}.`,
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        message: `Multiple groups match "${args.groupName}": ${matches.map((g) => g.name).join(", ")}. Be more specific.`,
      };
    }

    const group = matches[0];
    if (args.unlink) {
      if (group.slackChannelId !== args.slackChannelId) {
        return {
          ok: false,
          message: `"${group.name}" isn't linked to this channel.`,
        };
      }
      await ctx.db.patch(group._id, {
        slackChannelId: undefined,
        slackNotifyMode: undefined,
      });
      return { ok: true, message: `Unlinked "${group.name}" from this channel — no more notifications here.` };
    }

    await ctx.db.patch(group._id, { slackChannelId: args.slackChannelId });
    return {
      ok: true,
      message: `Linked "${group.name}" to this channel. Activity notifications (completions, deliverable submissions) will collect into hourly updates on the day's check-in thread. Say "switch ${group.name} to immediate notifications" to change the cadence.`,
    };
  },
});

export const setNotifyMode = internalMutation({
  args: {
    callerUserId: v.id("users"),
    groupName: v.string(),
    mode: v.union(v.literal("digest"), v.literal("immediate")),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; message: string }> => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller || !isTeacherRole(caller.role)) {
      return { ok: false, message: "Forbidden: teacher or admin role required" };
    }
    const query = args.groupName.trim().toLowerCase();
    const groups = await ctx.db.query("scholarGroups").collect();
    const match = groups.find((g) => g.name.toLowerCase().includes(query));
    if (!match) return { ok: false, message: `No scholar group matches "${args.groupName}".` };
    if (!match.slackChannelId) {
      return { ok: false, message: `"${match.name}" isn't linked to a Slack channel yet.` };
    }
    await ctx.db.patch(match._id, { slackNotifyMode: args.mode });
    return {
      ok: true,
      message: `"${match.name}" notifications set to ${args.mode === "immediate" ? "immediate" : "hourly check-in thread updates"}.`,
    };
  },
});

// ── Event intake (called by producers after their writes) ───────────────

/**
 * Route a scholar event to its owning group's linked channel. Digest mode
 * queues; immediate mode posts right away. Never
 * throws — a Slack hiccup must not break the producing mutation. Plain
 * function so producers (activityCompletions, deliverables) call it
 * in-transaction without a sub-mutation.
 */
export async function fanOutScholarEvent(
  ctx: MutationCtx,
  args: {
    scholarId: Id<"users">;
    text: string;
    subject?: string | null;
    dedupeKey?: string;
  },
): Promise<void> {
  try {
    const groups = await ctx.db.query("scholarGroups").collect();
    const group = owningGroupForScholar(
      groups,
      args.scholarId,
      args.subject,
    );
    if (!group?.slackChannelId) return;
    if (group.slackNotifyMode === "immediate") {
      await ctx.scheduler.runAfter(0, internal.slackNotifications.postNow, {
        channelId: group.slackChannelId,
        text: args.text,
        groupId: group._id,
        scholarIds: [args.scholarId],
      });
    } else {
      const pending = args.dedupeKey
        ? await ctx.db
            .query("slackNotificationQueue")
            .withIndex("by_group_dedupe_sent", (q) =>
              q
                .eq("groupId", group._id)
                .eq("dedupeKey", args.dedupeKey)
                .eq("sent", false),
            )
            .first()
        : null;
      if (pending) {
        await ctx.db.patch(pending._id, {
          channelId: group.slackChannelId,
          text: args.text,
        });
        return;
      }
      await ctx.db.insert("slackNotificationQueue", {
        groupId: group._id,
        channelId: group.slackChannelId,
        text: args.text,
        dedupeKey: args.dedupeKey,
        sent: false,
      });
    }
  } catch (err) {
    console.error("Slack notification fan-out failed (ignored):", err);
  }
}

/**
 * Class-level fan-out: resolve one owning group per scholar, then post ONE
 * message per resulting linked channel. A whole-class action therefore avoids
 * both per-scholar spam and duplicate posts from overlapping memberships.
 * Never throws — a Slack hiccup must not break the producing mutation.
 */
export async function fanOutClassEvent(
  ctx: MutationCtx,
  args: {
    scholarIds: Id<"users">[];
    subject?: string | null;
    makeText: (group: Doc<"scholarGroups">) => string;
  },
): Promise<void> {
  try {
    const groups = await ctx.db.query("scholarGroups").collect();
    const linkedById = new Map<Id<"scholarGroups">, Doc<"scholarGroups">>();
    for (const scholarId of args.scholarIds) {
      const group = owningGroupForScholar(groups, scholarId, args.subject);
      if (group?.slackChannelId) linkedById.set(group._id, group);
    }
    const linked = [...linkedById.values()];
    for (const group of linked) {
      const text = args.makeText(group);
      if (group.slackNotifyMode === "immediate") {
        await ctx.scheduler.runAfter(0, internal.slackNotifications.postNow, {
          channelId: group.slackChannelId!,
          text,
          groupId: group._id,
          scholarIds: group.scholarIds,
        });
      } else {
        await ctx.db.insert("slackNotificationQueue", {
          groupId: group._id,
          channelId: group.slackChannelId!,
          text,
          sent: false,
        });
      }
    }
  } catch (err) {
    console.error("Slack class notification fan-out failed (ignored):", err);
  }
}

export const notifyScholarEvent = internalMutation({
  args: {
    scholarId: v.id("users"),
    text: v.string(), // already formatted, deep link included
    subject: v.optional(v.string()),
    dedupeKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => fanOutScholarEvent(ctx, args),
});

export const postNow = internalAction({
  args: {
    channelId: v.string(),
    text: v.string(),
    groupId: v.optional(v.id("scholarGroups")),
    scholarIds: v.optional(v.array(v.id("users"))),
    scholarId: v.optional(v.id("users")),
    institutionId: v.optional(v.id("institutions")),
    alertAudience: v.optional(
      v.union(v.literal("institution"), v.literal("platform")),
    ),
    alertId: v.optional(v.id("alerts")),
    alertCreatedAt: v.optional(v.number()),
    deliveryAttempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) return; // Slack not configured on this deployment
    if (
      args.groupId &&
      !(await ctx.runQuery(internal.slackNotifications.groupDeliveryAllowed, {
        groupId: args.groupId,
        channelId: args.channelId,
        scholarIds: args.scholarIds,
      }))
    ) {
      return;
    }
    if (
      args.alertAudience &&
      !(await ctx.runQuery(internal.alerts.deliveryAllowed, {
        channelId: args.channelId,
        audience: args.alertAudience,
        scholarId: args.scholarId,
        institutionId: args.institutionId,
      }))
    ) {
      return;
    }
    if (
      args.scholarId &&
      !(await ctx.runQuery(
        internal.slackNotifications.scholarDeliveryAllowed,
        {
          scholarId: args.scholarId,
          institutionId: args.institutionId,
        },
      ))
    ) {
      return;
    }
    const deliveryAttempt = args.deliveryAttempt ?? 0;
    const scheduleAlertRetry = async (retryAfterMs?: number) => {
      if (!args.alertId || deliveryAttempt >= ALERT_DELIVERY_MAX_ATTEMPTS - 1) {
        if (args.alertId) {
          console.error(
            `Slack alert delivery exhausted retries for ${args.alertId}`,
          );
        }
        return;
      }
      await ctx.scheduler.runAfter(
        alertDeliveryRetryDelay(deliveryAttempt, retryAfterMs),
        internal.slackNotifications.postNow,
        { ...args, deliveryAttempt: deliveryAttempt + 1 },
      );
    };
    const recordAlertDelivery = async (messageTs: string) => {
      try {
        await ctx.runMutation(internal.alerts.recordSlackDelivery, {
          alertId: args.alertId!,
          channelId: args.channelId,
          messageTs,
        });
        return true;
      } catch (error) {
        console.error("Slack alert receipt failed:", error);
        await scheduleAlertRetry();
        return false;
      }
    };

    // An alert retry may be running after Slack accepted the prior write but the
    // response (or receipt mutation) was lost. Confirm the stable delivery id
    // before another root post; an unavailable scan must never create a duplicate.
    if (args.alertId && deliveryAttempt > 0) {
      const alertCreatedAt =
        args.alertCreatedAt ??
        (await ctx.runQuery(internal.alerts.getAlertCreatedAt, {
          alertId: args.alertId,
        }));
      if (alertCreatedAt === null) return;
      const oldest = String(
        Math.max(0, Math.floor((alertCreatedAt - 60_000) / 1000)),
      );
      const history = await fetchConversationHistory(token, args.channelId, {
        oldest,
      });
      if (!history.ok) {
        await scheduleAlertRetry(history.retryAfterMs);
        return;
      }
      const delivered = messageWithDeliveryMetadata(
        history.messages,
        ALERT_DELIVERY_EVENT_TYPE,
        String(args.alertId),
      );
      if (delivered?.ts) {
        await recordAlertDelivery(delivered.ts);
        return;
      }
    }
    const result = await postMessage(token, {
      channel: args.channelId,
      text: args.text,
      markdown: true,
      ...(args.alertId
        ? {
            metadata: {
              event_type: ALERT_DELIVERY_EVENT_TYPE,
              event_payload: { delivery_id: String(args.alertId) },
            },
          }
        : {}),
    });
    if (result.ok && result.ts && args.alertId) {
      await recordAlertDelivery(result.ts);
    } else if (
      args.alertId &&
      (!result.ok
        ? result.ambiguous || result.retryAfterMs !== undefined
        : !result.ts)
    ) {
      await scheduleAlertRetry(result.retryAfterMs);
    }
  },
});

export const groupDeliveryAllowed = internalQuery({
  args: {
    groupId: v.id("scholarGroups"),
    channelId: v.string(),
    scholarIds: v.optional(v.array(v.id("users"))),
  },
  handler: (ctx, args) => groupDeliveryIsCurrent(ctx, args),
});

export const scholarDeliveryAllowed = internalQuery({
  args: {
    scholarId: v.id("users"),
    institutionId: v.optional(v.id("institutions")),
  },
  handler: async (ctx, args) =>
    (await scholarInstitutionId(ctx, args.scholarId)) === args.institutionId,
});

// ── Hourly check-in thread updates (cron) ──────────────────────────────

export const pendingDigest = internalQuery({
  args: { ids: v.optional(v.array(v.id("slackNotificationQueue"))) },
  handler: async (ctx, args) => {
    const idSet = args.ids
      ? new Set(args.ids.map(String))
      : null;
    const rows = await ctx.db
      .query("slackNotificationQueue")
      .withIndex("by_sent", (q) => q.eq("sent", false))
      .collect();
    const eligible = await Promise.all(
      rows.map(async (row) =>
        (!idSet || idSet.has(String(row._id))) &&
        (await groupDeliveryIsCurrent(ctx, {
          groupId: row.groupId,
          channelId: row.channelId,
        }))
          ? row
          : null,
      ),
    );
    return eligible.filter(
      (row): row is Doc<"slackNotificationQueue"> => row !== null,
    );
  },
});

export const markSent = internalMutation({
  args: { ids: v.array(v.id("slackNotificationQueue")) },
  handler: async (ctx, args) => {
    for (const id of args.ids) {
      await ctx.db.patch(id, { sent: true });
    }
  },
});

function activityUpdateMetadata(deliveryId: string): SlackMessageMetadata {
  return {
    event_type: ACTIVITY_UPDATE_EVENT_TYPE,
    event_payload: { delivery_id: deliveryId },
  };
}

export const claimActivityUpdate = internalMutation({
  args: {
    channelId: v.string(),
    ids: v.array(v.id("slackNotificationQueue")),
  },
  handler: async (ctx, args) => {
    const loaded = await Promise.all(args.ids.map((id) => ctx.db.get(id)));
    const eligible: Array<
      Doc<"slackNotificationQueue"> & {
        institutionId: Id<"institutions">;
      }
    > = [];

    for (const row of loaded) {
      if (
        !row ||
        row.sent ||
        row.channelId !== args.channelId ||
        !(await groupDeliveryIsCurrent(ctx, {
          groupId: row.groupId,
          channelId: row.channelId,
        }))
      ) {
        continue;
      }
      const group = await ctx.db.get(row.groupId);
      if (!group?.institutionId) continue;
      eligible.push({ ...row, institutionId: group.institutionId });
    }
    if (eligible.length === 0) return null;

    const institutionIds = new Set(eligible.map((row) => String(row.institutionId)));
    if (institutionIds.size !== 1) return null;
    const institutionId = eligible[0].institutionId;
    const institution = await ctx.db.get(institutionId);
    if (!institution || institution.disabledAt !== undefined) return null;

    const dateKey = checkinDayKey(
      Date.now(),
      effectiveInstitutionTimeZone(institution.timeZone),
    );
    const checkins = await ctx.db
      .query("eodCheckins")
      .withIndex("by_channel_date", (q) =>
        q.eq("channelId", args.channelId).eq("dateKey", dateKey),
      )
      .collect();
    const checkin = checkins.find(
      (candidate) =>
        candidate.threadTs !== undefined &&
        (candidate.lifecycle === "completed" ||
          candidate.lifecycle === undefined) &&
        candidate.institutionId === institutionId,
    );
    if (!checkin?.threadTs) return null;

    const eligibleIds = new Set(eligible.map((row) => String(row._id)));
    const now = Date.now();
    if (checkin.activityUpdate) {
      if (checkin.activityUpdate.leaseUntil > now) return null;
      const activityUpdate = {
        ...checkin.activityUpdate,
        leaseUntil: now + ACTIVITY_UPDATE_LEASE_MS,
      };
      await ctx.db.patch(checkin._id, { activityUpdate });
      return {
        checkinId: checkin._id,
        channelId: checkin.channelId,
        threadTs: checkin.threadTs,
        canPost: activityUpdate.queueIds.every((id) =>
          eligibleIds.has(String(id)),
        ),
        ...activityUpdate,
      };
    }

    const batch = eligible
      .sort((a, b) => a._creationTime - b._creationTime)
      .slice(0, ACTIVITY_UPDATE_LIMIT);
    const deliveryId = `activity:${checkin._id}:${batch
      .map((row) => row._id)
      .join(".")}`;
    const activityUpdate = {
      deliveryId,
      text: `*Activity since the last update:*\n${batch
        .map((row) => `• ${row.text}`)
        .join("\n")}`,
      queueIds: batch.map((row) => row._id),
      startedAt: now,
      leaseUntil: now + ACTIVITY_UPDATE_LEASE_MS,
    };
    await ctx.db.patch(checkin._id, { activityUpdate });
    return {
      checkinId: checkin._id,
      channelId: checkin.channelId,
      threadTs: checkin.threadTs,
      canPost: true,
      ...activityUpdate,
    };
  },
});

export const abandonActivityUpdate = internalMutation({
  args: {
    checkinId: v.id("eodCheckins"),
    deliveryId: v.string(),
  },
  handler: async (ctx, args) => {
    const checkin = await ctx.db.get(args.checkinId);
    if (checkin?.activityUpdate?.deliveryId !== args.deliveryId) return false;
    await ctx.db.patch(checkin._id, { activityUpdate: undefined });
    return true;
  },
});

export const finalizeActivityUpdate = internalMutation({
  args: {
    checkinId: v.id("eodCheckins"),
    deliveryId: v.string(),
  },
  handler: async (ctx, args) => {
    const checkin = await ctx.db.get(args.checkinId);
    const update = checkin?.activityUpdate;
    if (!checkin || !update || update.deliveryId !== args.deliveryId) {
      return false;
    }
    for (const id of update.queueIds) {
      const row = await ctx.db.get(id);
      if (row && !row.sent) {
        await ctx.db.patch(id, { sent: true });
      }
    }
    await ctx.db.patch(checkin._id, { activityUpdate: undefined });
    const threadTs = checkin.threadTs;
    if (threadTs) {
      const thread = await ctx.db
        .query("slackThreads")
        .withIndex("by_channel_thread", (q) =>
          q.eq("channelId", checkin.channelId).eq("threadTs", threadTs),
        )
        .unique();
      if (thread) {
        await ctx.db.patch(thread._id, { lastActivityAt: Date.now() });
      }
    }
    return true;
  },
});

/** Post at most one activity-gated update per channel on each hourly run. */
export const flushActivityUpdates = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ postedChannels: number; skippedChannels: number }> => {
    const token = process.env.SLACK_BOT_TOKEN;
    const rows = await ctx.runQuery(internal.slackNotifications.pendingDigest, {});
    if (rows.length === 0 || !token) {
      return { postedChannels: 0, skippedChannels: 0 };
    }

    const byChannel = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byChannel.get(row.channelId) ?? [];
      list.push(row);
      byChannel.set(row.channelId, list);
    }

    let postedChannels = 0;
    let skippedChannels = 0;
    for (const [channelId, channelRows] of byChannel) {
      let update = await ctx.runMutation(
        internal.slackNotifications.claimActivityUpdate,
        {
          channelId,
          ids: channelRows.map((row) => row._id),
        },
      );
      if (!update) {
        skippedChannels += 1;
        continue;
      }

      let completed = false;
      for (let attempt = 0; attempt < 2 && update; attempt += 1) {
        const replies = await fetchConversationReplies(
          token,
          update.channelId,
          update.threadTs,
        );
        if (!replies.ok) break;

        const delivered = messageWithDeliveryMetadata(
          replies.messages,
          ACTIVITY_UPDATE_EVENT_TYPE,
          update.deliveryId,
        );
        if (!delivered && !update.canPost) {
          await ctx.runMutation(
            internal.slackNotifications.abandonActivityUpdate,
            {
              checkinId: update.checkinId,
              deliveryId: update.deliveryId,
            },
          );
          update = await ctx.runMutation(
            internal.slackNotifications.claimActivityUpdate,
            {
              channelId,
              ids: channelRows.map((row) => row._id),
            },
          );
          continue;
        }
        if (!delivered) {
          const res = await postMessage(token, {
            channel: update.channelId,
            threadTs: update.threadTs,
            text: update.text,
            markdown: true,
            metadata: activityUpdateMetadata(update.deliveryId),
          });
          if (!res.ok) break;
        }

        await ctx.runMutation(
          internal.slackNotifications.finalizeActivityUpdate,
          {
            checkinId: update.checkinId,
            deliveryId: update.deliveryId,
          },
        );
        completed = true;
        break;
      }
      if (!completed) {
        skippedChannels += 1;
        continue;
      }
      postedChannels += 1;
    }
    return { postedChannels, skippedChannels };
  },
});
