import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import {
  GOOGLE_DOCS_EVENT_TYPES,
  GOOGLE_DOCS_SUBSCRIPTION_MAX_FAILURES,
  GOOGLE_DOCS_SUBSCRIPTION_RENEWAL_WINDOW_MS,
  GOOGLE_DRIVE_COMMENT_CREATED_EVENT,
  GOOGLE_DRIVE_REPLY_CREATED_EVENT,
} from "./lib/googleDocsEventsConstants";
import { isValidEmail, normalizeEmail } from "./lib/email";
import { isPlatformAdminRole, isStaffRole, ROLES } from "./lib/roles";

function hasCurrentEventTypes(eventTypes: string[] | undefined): boolean {
  return (
    eventTypes?.length === GOOGLE_DOCS_EVENT_TYPES.length &&
    GOOGLE_DOCS_EVENT_TYPES.every((eventType) => eventTypes.includes(eventType))
  );
}

export const claimEvent = internalMutation({
  args: {
    messageId: v.string(),
    eventId: v.string(),
    eventType: v.string(),
    documentId: v.optional(v.string()),
    commentId: v.optional(v.string()),
    replyId: v.optional(v.string()),
    mentionedEmails: v.array(v.string()),
    authorEmail: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ fresh: boolean }> => {
    const [sameMessage, sameEvent] = await Promise.all([
      ctx.db
        .query("googleDocsEventReceipts")
        .withIndex("by_message", (q) => q.eq("messageId", args.messageId))
        .unique(),
      ctx.db
        .query("googleDocsEventReceipts")
        .withIndex("by_event", (q) => q.eq("eventId", args.eventId))
        .unique(),
    ]);
    if (sameMessage || sameEvent) return { fresh: false };

    const actionable =
      (args.eventType === GOOGLE_DRIVE_COMMENT_CREATED_EVENT ||
        args.eventType === GOOGLE_DRIVE_REPLY_CREATED_EVENT) &&
      !!args.documentId &&
      !!args.commentId &&
      (args.eventType !== GOOGLE_DRIVE_REPLY_CREATED_EVENT || !!args.replyId) &&
      args.mentionedEmails.length > 0;
    const receiptId = await ctx.db.insert("googleDocsEventReceipts", {
      ...args,
      receivedAt: Date.now(),
      status: actionable ? "received" : "ignored",
    });
    if (actionable) {
      await ctx.scheduler.runAfter(
        0,
        internal.googleDocsEventsActions.processThreadEvent,
        { receiptId },
      );
    }
    return { fresh: true };
  },
});

export const getReplyContext = internalQuery({
  args: { receiptId: v.id("googleDocsEventReceipts") },
  handler: async (ctx, args) => {
    const receipt = await ctx.db.get(args.receiptId);
    if (!receipt?.documentId || !receipt.commentId) return null;
    const subscriptions = await ctx.db
      .query("googleDocsSubscriptions")
      .withIndex("by_document", (q) =>
        q.eq("documentId", receipt.documentId as string),
      )
      .collect();
    const subscription = subscriptions
      .filter((candidate) => candidate.status === "active")
      .sort((a, b) => b.expireTime - a.expireTime)[0];
    if (!subscription) return null;
    const credentials = await ctx.db
      .query("institutionGoogleAccounts")
      .withIndex("by_institution", (q) =>
        q.eq("institutionId", subscription.institutionId),
      )
      .collect();
    const credential =
      credentials.find((candidate) => candidate.purpose === "workspace_bot") ??
      credentials.find((candidate) => candidate.purpose === "docs_bot");
    if (!credential) return null;
    return {
      receipt,
      institutionId: subscription.institutionId,
      botEmail: credential.email,
      subscriptionCreatedBy: subscription.createdBy,
    };
  },
});

function normalizedDisplayName(value: string | undefined): string {
  return value?.trim().replace(/\s+/g, " ").toLocaleLowerCase() ?? "";
}

export const commentAuthorCandidates = internalQuery({
  args: {
    institutionId: v.id("institutions"),
    displayName: v.string(),
    subscriptionCreatedBy: v.id("users"),
  },
  handler: async (ctx, args) => {
    const institution = await ctx.db.get(args.institutionId);
    if (!institution || institution.disabledAt !== undefined) return [];

    const [memberships, platformAdmins] = await Promise.all([
      ctx.db
        .query("memberships")
        .withIndex("by_institution", (q) =>
          q.eq("institutionId", args.institutionId),
        )
        .collect(),
      ctx.db
        .query("users")
        .withIndex("by_role", (q) => q.eq("role", ROLES.PLATFORM_ADMIN))
        .collect(),
    ]);
    const memberRoles = new Map(
      memberships
        .filter((membership) => isStaffRole(membership.role))
        .map((membership) => [membership.userId, membership.role]),
    );
    const candidateIds = [
      args.subscriptionCreatedBy,
      ...memberRoles.keys(),
      ...platformAdmins.map((user) => user._id),
    ].filter((userId, index, all) => all.indexOf(userId) === index);
    const wantedName = normalizedDisplayName(args.displayName);
    const candidates = [];

    for (const userId of candidateIds) {
      const [user, googleAccount] = await Promise.all([
        ctx.db.get(userId),
        ctx.db
          .query("googleAccounts")
          .withIndex("by_user", (q) => q.eq("userId", userId))
          .unique(),
      ]);
      if (!user || !googleAccount) continue;
      const role = memberRoles.get(userId) ?? user.role;
      if (!isStaffRole(role) && !isPlatformAdminRole(role)) continue;

      const isSubscriptionCreator = userId === args.subscriptionCreatedBy;
      const nameMatches = [
        googleAccount.googleDisplayName,
        user.name,
        user.username,
      ].some(
        (name) => normalizedDisplayName(name) === wantedName,
      );
      if (!isSubscriptionCreator && !nameMatches) continue;
      candidates.push({
        userId,
        googleEmail: googleAccount.email,
        googleSub: googleAccount.googleSub,
        googleDisplayName: googleAccount.googleDisplayName,
      });
    }
    return candidates;
  },
});

export const resolveCommentAuthorStaffIdentity = internalQuery({
  args: {
    institutionId: v.id("institutions"),
    email: v.optional(v.string()),
    verifiedUserId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const email = args.email ? normalizeEmail(args.email) : undefined;
    if (!args.verifiedUserId && (!email || !isValidEmail(email))) return null;
    const [verifiedUser, userByEmail, institution] = await Promise.all([
      args.verifiedUserId ? ctx.db.get(args.verifiedUserId) : null,
      email
        ? ctx.db
            .query("users")
            .withIndex("by_email", (q) => q.eq("email", email))
            .unique()
        : null,
      ctx.db.get(args.institutionId),
    ]);
    if (!institution || institution.disabledAt !== undefined) {
      return null;
    }
    let user = verifiedUser ?? userByEmail;
    if (!user && email) {
      const linkedAccounts = await ctx.db
        .query("googleAccounts")
        .withIndex("by_email", (q) => q.eq("email", email))
        .collect();
      if (linkedAccounts.length > 1) {
        console.warn(
          "[googleDocsEvents] ambiguous linked Google account email; withholding comment tools",
        );
        return null;
      }
      if (linkedAccounts.length === 0) return null;
      user = await ctx.db.get(linkedAccounts[0].userId);
      if (!user) return null;
    }
    if (!user) return null;
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const membership = memberships.find(
      (candidate) =>
        candidate.institutionId === args.institutionId &&
        isStaffRole(candidate.role),
    );
    // Platform admins may hold no membership row at the institution (they
    // lens in without one) — admit them by top-level role, mirroring
    // canManageInstitutionGoogleCredentialInternal.
    if (!membership && !isPlatformAdminRole(user.role)) return null;
    const role = membership?.role ?? user.role;
    if (!role) return null;
    return {
      userId: user._id,
      role,
      name: user.name ?? user.username ?? email ?? "Google Docs collaborator",
    };
  },
});

export const claimTriggerReply = internalMutation({
  args: { receiptId: v.id("googleDocsEventReceipts") },
  handler: async (ctx, args): Promise<{ fresh: boolean }> => {
    const receipt = await ctx.db.get(args.receiptId);
    if (!receipt?.documentId || !receipt.commentId) return { fresh: false };
    const receipts = await ctx.db
      .query("googleDocsEventReceipts")
      .withIndex("by_trigger", (q) =>
        q
          .eq("documentId", receipt.documentId)
          .eq("commentId", receipt.commentId)
          .eq("replyId", receipt.replyId),
      )
      .collect();
    if (
      receipts.some(
        (candidate) =>
          candidate._id !== receipt._id &&
          (candidate.replyClaimedAt !== undefined ||
            candidate.repliedAt !== undefined),
      ) ||
      receipt.replyClaimedAt !== undefined
    ) {
      await ctx.db.patch(receipt._id, { status: "ignored" });
      return { fresh: false };
    }
    await ctx.db.patch(receipt._id, {
      status: "processing",
      replyClaimedAt: Date.now(),
    });
    return { fresh: true };
  },
});

export const finishReceipt = internalMutation({
  args: {
    receiptId: v.id("googleDocsEventReceipts"),
    outcome: v.union(
      v.literal("ignored"),
      v.literal("replied"),
      v.literal("failed"),
    ),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const receipt = await ctx.db.get(args.receiptId);
    if (!receipt) return;
    await ctx.db.patch(receipt._id, {
      status: args.outcome,
      repliedAt: args.outcome === "replied" ? Date.now() : receipt.repliedAt,
      error: args.error,
    });
  },
});

export const activeSubscriptionForDocument = internalQuery({
  args: {
    institutionId: v.id("institutions"),
    documentId: v.string(),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("googleDocsSubscriptions")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    return (
      rows
        .filter(
          (row) =>
            row.institutionId === args.institutionId && row.status === "active",
        )
        .sort((a, b) => b.expireTime - a.expireTime)[0] ?? null
    );
  },
});

export const replaceSubscription = internalMutation({
  args: {
    institutionId: v.id("institutions"),
    documentId: v.string(),
    subscriptionName: v.string(),
    expireTime: v.number(),
    eventTypes: v.array(v.string()),
    createdBy: v.id("users"),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("googleDocsSubscriptions")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    for (const row of existing) {
      if (
        row.institutionId === args.institutionId &&
        row.status === "active"
      ) {
        await ctx.db.patch(row._id, { status: "dead" });
      }
    }
    return await ctx.db.insert("googleDocsSubscriptions", {
      ...args,
      status: "active",
      renewalFailureCount: 0,
    });
  },
});

export const updateSubscription = internalMutation({
  args: {
    subscriptionId: v.id("googleDocsSubscriptions"),
    subscriptionName: v.string(),
    expireTime: v.number(),
    eventTypes: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.subscriptionId);
    if (!row) throw new Error("Google Docs subscription not found");
    await ctx.db.patch(row._id, {
      subscriptionName: args.subscriptionName,
      expireTime: args.expireTime,
      eventTypes: args.eventTypes,
      status: "active",
      renewalFailureCount: 0,
      lastError: undefined,
    });
  },
});

export const subscriptionsForRenewal = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, args) => {
    const expiring = await ctx.db
      .query("googleDocsSubscriptions")
      .withIndex("by_expiry", (q) =>
        q.lt(
          "expireTime",
          args.now + GOOGLE_DOCS_SUBSCRIPTION_RENEWAL_WINDOW_MS,
        ),
      )
      .filter((q) => q.eq(q.field("status"), "active"))
      .take(100);
    const active = await ctx.db
      .query("googleDocsSubscriptions")
      .filter((q) => q.eq(q.field("status"), "active"))
      .take(100);
    const byId = new Map(expiring.map((row) => [row._id, row]));
    for (const row of active) {
      if (!hasCurrentEventTypes(row.eventTypes)) byId.set(row._id, row);
    }
    return [...byId.values()];
  },
});

export const markSubscriptionError = internalMutation({
  args: {
    subscriptionId: v.id("googleDocsSubscriptions"),
    error: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ failureCount: number; dead: boolean } | null> => {
    const row = await ctx.db.get(args.subscriptionId);
    if (!row || row.status !== "active") return null;
    const failureCount = (row.renewalFailureCount ?? 0) + 1;
    const dead = failureCount >= GOOGLE_DOCS_SUBSCRIPTION_MAX_FAILURES;
    await ctx.db.patch(row._id, {
      lastError: args.error,
      renewalFailureCount: failureCount,
      status: dead ? "dead" : "active",
    });
    return { failureCount, dead };
  },
});

export const pruneDeadSubscriptions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("googleDocsSubscriptions")
      .filter((q) => q.eq(q.field("status"), "dead"))
      .take(500);
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length;
  },
});
