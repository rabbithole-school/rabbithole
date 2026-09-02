/**
 * Teacher-approved sign-out for paired native iPads.
 *
 * A managed iPad cannot safely use ordinary local sign-out: its durable MDM
 * claim would immediately authenticate it again. The scholar requests approval,
 * Rabbithole posts to the institution's existing alert channel, and an
 * authorized staff reply approves one completion. The iPad then invalidates its
 * managed claim and pairing before clearing local auth.
 */
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { authedMutation, authedQuery } from "./lib/customFunctions";
import { resolveTargetChannels } from "./alerts";
import { postMessage } from "./lib/slackApi";
import { unpairDeviceBinding } from "./devicePairing";
import { resolveInstitutionLens } from "./lib/institutionLens";

const REQUEST_TTL_MS = 30 * 60 * 1000;

function effectiveStatus(
  request: Doc<"deviceSignOutRequests">,
  now: number,
): Doc<"deviceSignOutRequests">["status"] {
  return request.status === "pending" && request.expiresAt <= now
    ? "expired"
    : request.status;
}

export function isSignOutApprovalReply(text: string): boolean {
  const normalized = text
    .replace(/<@[^>]+>/g, "")
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/g, "")
    .replace(/\s+/g, " ");
  return new Set([
    "approve",
    "approved",
    "allow",
    "allow signout",
    "allow sign out",
    "approve signout",
    "approve sign out",
    "yes",
    "ok",
    "okay",
  ]).has(normalized);
}

async function latestRequestForDevice(
  ctx: Pick<QueryCtx, "db">,
  deviceId: string,
): Promise<Doc<"deviceSignOutRequests"> | null> {
  return await ctx.db
    .query("deviceSignOutRequests")
    .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
    .order("desc")
    .first();
}

async function bindingForScholarDevice(
  ctx: Pick<QueryCtx, "db">,
  scholarId: Id<"users">,
  deviceId: string,
): Promise<Doc<"pairedDevices"> | null> {
  const bindings = await ctx.db
    .query("pairedDevices")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  return bindings.find((binding) => binding.deviceId === deviceId) ?? null;
}

export const statusForDevice = authedQuery({
  args: { deviceId: v.string() },
  handler: async (ctx, args) => {
    const binding = await bindingForScholarDevice(
      ctx,
      ctx.user._id,
      args.deviceId,
    );
    const latest = await latestRequestForDevice(ctx, args.deviceId);
    const ownRequest = latest?.scholarId === ctx.user._id ? latest : null;
    return {
      paired: binding !== null,
      scholarName: ctx.user.name ?? ctx.user.username ?? "this scholar",
      request: ownRequest
        ? {
            _id: ownRequest._id,
            status: effectiveStatus(ownRequest, Date.now()),
            requestedAt: ownRequest.requestedAt,
            notified: ownRequest.slackPostedAt !== undefined,
            slackPostError: ownRequest.slackPostError ?? null,
          }
        : null,
    };
  },
});

export const requestApproval = authedMutation({
  args: { deviceId: v.string() },
  handler: async (ctx, args) => {
    const binding = await bindingForScholarDevice(
      ctx,
      ctx.user._id,
      args.deviceId,
    );
    if (!binding) {
      throw new Error("This iPad is no longer paired to your account.");
    }

    const now = Date.now();
    const latest = await latestRequestForDevice(ctx, args.deviceId);
    if (
      latest?.scholarId === ctx.user._id &&
      effectiveStatus(latest, now) === "pending" &&
      latest.pairedDeviceId === binding._id
    ) {
      return { requestId: latest._id, alreadyPending: true };
    }
    if (
      latest?.scholarId === ctx.user._id &&
      effectiveStatus(latest, now) === "pending"
    ) {
      await ctx.db.patch(latest._id, { status: "expired" });
    }

    const channels = await resolveTargetChannels(ctx, {
      audience: "institution",
      institutionId: binding.institutionId,
      scholarId: binding.scholarId,
    });
    const slackChannelId = channels[0];
    if (!slackChannelId) {
      throw new Error(
        "Teacher approval is not configured for this school. Ask a teacher for help.",
      );
    }

    const managedClaim = binding.managedDeviceClaimId
      ? await ctx.db.get(binding.managedDeviceClaimId)
      : null;
    const alertId = await ctx.db.insert("alerts", {
      kind: "device_sign_out_approval",
      severity: "info",
      title: `iPad sign-out request — ${ctx.user.name ?? ctx.user.username ?? "Scholar"}`,
      body: "A paired iPad is asking for permission to sign out.",
      source: "deviceSignOut",
      scholarId: ctx.user._id,
      dedupKey: `device-sign-out:${binding.deviceId}:${now}`,
      status: "open",
      createdAt: now,
    });
    const requestId = await ctx.db.insert("deviceSignOutRequests", {
      institutionId: binding.institutionId,
      scholarId: ctx.user._id,
      pairedDeviceId: binding._id,
      deviceId: binding.deviceId,
      deviceLabel: binding.deviceLabel,
      managedDeviceClaimId: binding.managedDeviceClaimId,
      managedSerial: managedClaim?.serial,
      status: "pending",
      requestedAt: now,
      expiresAt: now + REQUEST_TTL_MS,
      alertId,
      slackChannelId,
    });
    await ctx.db.insert("auditLog", {
      actorUserId: ctx.user._id,
      action: "device.signout.request",
      targetUserId: ctx.user._id,
      at: now,
      detail: `device ${binding.deviceId}`,
    });
    await ctx.scheduler.runAfter(0, internal.deviceSignOut.postRequestToSlack, {
      requestId,
    });
    return { requestId, alreadyPending: false };
  },
});

export const requestForSlackPost = internalQuery({
  args: { requestId: v.id("deviceSignOutRequests") },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (!request || request.status !== "pending") return null;
    const scholar = await ctx.db.get(request.scholarId);
    return {
      request,
      scholarName: scholar?.name ?? scholar?.username ?? "A scholar",
    };
  },
});

export const recordSlackPost = internalMutation({
  args: {
    requestId: v.id("deviceSignOutRequests"),
    threadTs: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (!request || request.status !== "pending") return;
    await ctx.db.patch(request._id, {
      status: args.error ? "expired" : "pending",
      slackThreadTs: args.threadTs,
      slackPostedAt: args.threadTs ? Date.now() : undefined,
      slackPostError: args.error,
    });
  },
});

export const postRequestToSlack = internalAction({
  args: { requestId: v.id("deviceSignOutRequests") },
  handler: async (ctx, args) => {
    const payload = await ctx.runQuery(
      internal.deviceSignOut.requestForSlackPost,
      args,
    );
    if (!payload) return;
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
      await ctx.runMutation(internal.deviceSignOut.recordSlackPost, {
        requestId: args.requestId,
        error: "Slack is not configured.",
      });
      return;
    }
    const device = payload.request.managedSerial
      ? `iPad ${payload.request.managedSerial}`
      : payload.request.deviceLabel ?? "A paired iPad";
    const response = await postMessage(token, {
      channel: payload.request.slackChannelId,
      markdown: true,
      text:
        `🔐 **Sign-out approval requested**\n` +
        `${device} is paired to **${payload.scholarName}** and is asking to sign out.\n` +
        `Reply \`approve\` or \`allow signout\` in this thread to allow it. ` +
        `The request expires in 30 minutes.`,
    });
    const posted = response.ok && !!response.ts;
    await ctx.runMutation(internal.deviceSignOut.recordSlackPost, {
      requestId: args.requestId,
      threadTs: posted ? response.ts : undefined,
      error: posted
        ? undefined
        : response.error ?? "Slack did not return a message timestamp.",
    });
  },
});

export const ingestSlackReply = internalMutation({
  args: {
    channelId: v.string(),
    threadTs: v.string(),
    slackUserId: v.string(),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const request = await ctx.db
      .query("deviceSignOutRequests")
      .withIndex("by_channel_thread", (q) =>
        q
          .eq("slackChannelId", args.channelId)
          .eq("slackThreadTs", args.threadTs),
      )
      .unique();
    if (!request) return { handled: false, ok: false, message: "" };
    if (!isSignOutApprovalReply(args.body)) {
      return {
        handled: true,
        ok: false,
        message: 'Reply "approve" or "allow signout" to allow this iPad to sign out.',
      };
    }

    const approver = await ctx.db
      .query("users")
      .withIndex("by_slackUserId", (q) =>
        q.eq("slackUserId", args.slackUserId),
      )
      .unique();
    if (!approver) {
      return {
        handled: true,
        ok: false,
        message: "A linked teacher or authorized school staff member must approve this request.",
      };
    }
    const lens = await resolveInstitutionLens(ctx, approver, "all");
    if (
      !lens.isAdmin &&
      !lens.allowedInstitutionIds.has(request.institutionId)
    ) {
      return {
        handled: true,
        ok: false,
        message: "You cannot approve sign-out requests for this school.",
      };
    }

    const now = Date.now();
    const status = effectiveStatus(request, now);
    if (status === "expired") {
      if (request.status === "pending") {
        await ctx.db.patch(request._id, { status: "expired" });
      }
      return {
        handled: true,
        ok: false,
        message: "This request expired. Ask the scholar to request approval again.",
      };
    }
    if (status !== "pending") {
      return {
        handled: true,
        ok: status === "approved" || status === "completed",
        message:
          status === "completed"
            ? "This iPad has already signed out."
            : "This sign-out request has already been approved.",
      };
    }
    const binding = await ctx.db.get(request.pairedDeviceId);
    if (
      !binding ||
      binding.scholarId !== request.scholarId ||
      binding.deviceId !== request.deviceId
    ) {
      await ctx.db.patch(request._id, { status: "expired" });
      return {
        handled: true,
        ok: false,
        message: "This iPad is no longer paired to that scholar.",
      };
    }

    await ctx.db.patch(request._id, {
      status: "approved",
      approvedBy: approver._id,
      approvedAt: now,
    });
    await ctx.db.patch(request.alertId, {
      status: "acknowledged",
      acknowledgedBy: approver._id,
      acknowledgedAt: now,
    });
    await ctx.db.insert("auditLog", {
      actorUserId: approver._id,
      action: "device.signout.approve",
      targetUserId: request.scholarId,
      at: now,
      detail: `device ${request.deviceId}; Slack thread ${args.threadTs}`,
    });
    const scholar = await ctx.db.get(request.scholarId);
    return {
      handled: true,
      ok: true,
      message: `Approved. ${scholar?.name ?? "The scholar"}'s iPad can now sign out.`,
    };
  },
});

export const completeApprovedSignOut = authedMutation({
  args: {
    requestId: v.id("deviceSignOutRequests"),
    deviceId: v.string(),
  },
  handler: async (ctx, args) => {
    const request = await ctx.db.get(args.requestId);
    if (
      !request ||
      request.scholarId !== ctx.user._id ||
      request.deviceId !== args.deviceId
    ) {
      throw new Error("That sign-out approval is not for this iPad.");
    }
    if (request.status === "completed") return { completed: true };
    if (request.status !== "approved") {
      throw new Error("Teacher approval is still required.");
    }

    const requestedBinding = await ctx.db.get(request.pairedDeviceId);
    const binding =
      requestedBinding &&
      requestedBinding.scholarId === ctx.user._id &&
      requestedBinding.deviceId === args.deviceId
        ? requestedBinding
        : await bindingForScholarDevice(ctx, ctx.user._id, args.deviceId);
    if (binding) {
      await unpairDeviceBinding(
        ctx,
        binding,
        ctx.user._id,
        "device.signout.complete",
      );
    }
    await ctx.db.patch(request._id, {
      status: "completed",
      completedAt: Date.now(),
    });
    return { completed: true };
  },
});
