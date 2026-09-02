"use node";

import { v } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  GoogleApiError,
  driveCommentGet,
  driveCommentReplyCreate,
  driveCommentsList,
  getDocument,
  workspaceEventsSubscriptionCreate,
  workspaceEventsSubscriptionUpdate,
} from "./lib/googleDocsApi";
import {
  getValidAccessToken,
  getValidDocsBotToken,
} from "./lib/googleTokens";
import { fetchUserInfo } from "./lib/google";
import {
  buildGoogleDocumentBody,
  processGoogleThreadEvent,
  type GoogleThreadReplyDeps,
} from "./lib/googleDocsCommentReply";
import { type AideTool } from "./lib/aideStream";
import { recordUsage } from "./usage";
import {
  GOOGLE_DOCS_EVENT_TYPES,
  GOOGLE_DOCS_SUBSCRIPTION_RENEWAL_WINDOW_MS,
} from "./lib/googleDocsEventsConstants";
import { assembleCurriculumTools } from "./lib/aideTools";
import {
  filterGoogleDocsCommentTools,
  runGoogleDocsCommentLoop,
} from "./lib/googleDocsCommentTools";
import type { Role } from "./lib/roles";
import { MODELS } from "./lib/models";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasCurrentEventTypes(eventTypes: string[] | undefined): boolean {
  return (
    eventTypes?.length === GOOGLE_DOCS_EVENT_TYPES.length &&
    GOOGLE_DOCS_EVENT_TYPES.every((eventType) => eventTypes.includes(eventType))
  );
}

async function runDocsCommentAideTurn(
  ctx: ActionCtx,
  institutionId: Id<"institutions">,
  context: Parameters<GoogleThreadReplyDeps["runAideTurn"]>[0],
): Promise<string> {
  const access = await assembleGoogleDocsCommentToolsForAuthor(
    ctx,
    institutionId,
    context.triggerAuthorEmail,
    context.triggerAuthorUserId as Id<"users"> | undefined,
  );
  const { Anthropic } = await import("@anthropic-ai/sdk");
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const result = await runGoogleDocsCommentLoop({
    anthropic,
    tools: access.tools,
    context,
  });
  await recordUsage(ctx, {
    source: "google-docs-comment",
    role: access.role,
    institutionId,
    model: result.model || MODELS.SONNET,
    usage: result.usage,
  });
  return result.content;
}

export async function assembleGoogleDocsCommentToolsForAuthor(
  ctx: ActionCtx,
  institutionId: Id<"institutions">,
  authorEmail: string | undefined,
  verifiedUserId?: Id<"users">,
): Promise<{ tools: AideTool[]; role: Role | null }> {
  if (!authorEmail && !verifiedUserId) return { tools: [], role: null };
  const identity = await ctx.runQuery(
    internal.googleDocsEvents.resolveCommentAuthorStaffIdentity,
    {
      institutionId,
      email: authorEmail,
      verifiedUserId,
    },
  );
  if (!identity) return { tools: [], role: null };

  const lens = await ctx.runQuery(
    internal.curriculumAssistant.resolveAideScholarLens,
    {
      callerUserId: identity.userId,
      scope: String(institutionId),
    },
  );
  const roster = await assembleCurriculumTools(ctx, () => {}, {
    role: identity.role,
    callerUserId: identity.userId,
    surface: "channel",
    guardianFormAnswersSurface: "shared",
    allowedScholarIds: lens.scholarIds
      ? new Set<Id<"users">>(lens.scholarIds)
      : undefined,
    scholarLensResolved: true,
    lensLabel: lens.lensLabel,
    institutionScope: String(institutionId),
    institutionId,
  });
  return {
    tools: filterGoogleDocsCommentTools(roster),
    role: identity.role,
  };
}

export async function resolveGoogleDocsCommentAuthorIdentity(
  ctx: ActionCtx,
  args: {
    institutionId: Id<"institutions">;
    subscriptionCreatedBy: Id<"users">;
    documentId: string;
    commentId: string;
    replyId?: string;
    displayName: string;
  },
): Promise<{ userId: Id<"users">; email: string } | undefined> {
  const candidates = await ctx.runQuery(
    internal.googleDocsEvents.commentAuthorCandidates,
    {
      institutionId: args.institutionId,
      displayName: args.displayName,
      subscriptionCreatedBy: args.subscriptionCreatedBy,
    },
  );
  for (const candidate of candidates) {
    try {
      const token = await getValidAccessToken(ctx, candidate.userId);
      const comment = await driveCommentGet(
        token,
        args.documentId,
        args.commentId,
      );
      const trigger = args.replyId
        ? comment.replies?.find((reply) => reply.id === args.replyId)
        : comment;
      if (trigger?.author?.me === true) {
        if (!candidate.googleDisplayName) {
          try {
            const profile = await fetchUserInfo(token);
            if (profile.sub === candidate.googleSub && profile.name?.trim()) {
              await ctx.runMutation(
                internal.googleAccounts.updateDisplayNameInternal,
                {
                  userId: candidate.userId,
                  googleSub: candidate.googleSub,
                  googleDisplayName: profile.name,
                },
              );
            }
          } catch (error) {
            console.warn(
              "[googleDocsEvents] could not cache linked Google display name",
              errorMessage(error),
            );
          }
        }
        return {
          userId: candidate.userId,
          email: candidate.googleEmail,
        };
      }
    } catch (error) {
      console.warn(
        "[googleDocsEvents] linked account could not verify comment author",
        errorMessage(error),
      );
    }
  }
  return undefined;
}

export const ensureSubscription = internalAction({
  args: {
    institutionId: v.id("institutions"),
    documentId: v.string(),
    createdBy: v.id("users"),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ subscriptionName: string; created: boolean }> => {
    const existing: Doc<"googleDocsSubscriptions"> | null = await ctx.runQuery(
      internal.googleDocsEvents.activeSubscriptionForDocument,
      {
        institutionId: args.institutionId,
        documentId: args.documentId,
      },
    );
    if (
      existing?.status === "active" &&
      hasCurrentEventTypes(existing.eventTypes) &&
      existing.expireTime >
        Date.now() + GOOGLE_DOCS_SUBSCRIPTION_RENEWAL_WINDOW_MS
    ) {
      return { subscriptionName: existing.subscriptionName, created: false };
    }

    const token = await getValidDocsBotToken(ctx, args.institutionId);
    const subscription = existing
      ? await workspaceEventsSubscriptionUpdate(
          token,
          existing.subscriptionName,
        ).catch((error: unknown) => {
          // A subscription can vanish server-side (expired, deleted); without
          // this fallback the PATCH 404s until the row goes dead and the doc
          // is left permanently unmonitored.
          if (error instanceof GoogleApiError && error.status === 404) {
            return workspaceEventsSubscriptionCreate(token, args.documentId);
          }
          throw error;
        })
      : await workspaceEventsSubscriptionCreate(token, args.documentId);
    const expireTime = Date.parse(subscription.expireTime);
    if (!Number.isFinite(expireTime)) {
      throw new Error("Workspace Events returned an invalid expiration time");
    }
    if (existing) {
      await ctx.runMutation(internal.googleDocsEvents.updateSubscription, {
        subscriptionId: existing._id,
        subscriptionName: subscription.name,
        expireTime,
        eventTypes: [...GOOGLE_DOCS_EVENT_TYPES],
      });
    } else {
      await ctx.runMutation(internal.googleDocsEvents.replaceSubscription, {
        institutionId: args.institutionId,
        documentId: args.documentId,
        subscriptionName: subscription.name,
        expireTime,
        eventTypes: [...GOOGLE_DOCS_EVENT_TYPES],
        createdBy: args.createdBy,
      });
    }
    return { subscriptionName: subscription.name, created: !existing };
  },
});

export const renewExpiringSubscriptions = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ pruned: number; renewed: number; attempted: number }> => {
    const pruned: number = await ctx.runMutation(
      internal.googleDocsEvents.pruneDeadSubscriptions,
      {},
    );
    const subscriptions: Doc<"googleDocsSubscriptions">[] = await ctx.runQuery(
      internal.googleDocsEvents.subscriptionsForRenewal,
      { now: Date.now() },
    );
    let renewed = 0;
    for (const subscription of subscriptions) {
      try {
        await ctx.runAction(internal.googleDocsEventsActions.ensureSubscription, {
          institutionId: subscription.institutionId,
          documentId: subscription.documentId,
          createdBy: subscription.createdBy,
        });
        renewed += 1;
      } catch (error) {
        const failure = await ctx.runMutation(
          internal.googleDocsEvents.markSubscriptionError,
          {
            subscriptionId: subscription._id,
            error: errorMessage(error),
          },
        );
        if (failure?.dead) {
          console.error(
            `GIVING UP on Docs subscription ${subscription.subscriptionName} after ${failure.failureCount} consecutive renewal failures:`,
            error,
          );
          continue;
        }
        console.error(
          `Failed to renew Docs subscription ${subscription.subscriptionName} (${failure?.failureCount ?? "unknown"}/5):`,
          error,
        );
      }
    }
    return { pruned, renewed, attempted: subscriptions.length };
  },
});

export const processThreadEvent = internalAction({
  args: { receiptId: v.id("googleDocsEventReceipts") },
  handler: async (ctx, args) => {
    const context = await ctx.runQuery(
      internal.googleDocsEvents.getReplyContext,
      { receiptId: args.receiptId },
    );
    if (!context) {
      await ctx.runMutation(internal.googleDocsEvents.finishReceipt, {
        receiptId: args.receiptId,
        outcome: "ignored",
      });
      return { kind: "ignored_unmonitored_document" as const };
    }

    const {
      receipt,
      institutionId,
      botEmail,
      subscriptionCreatedBy,
    } = context;
    const token = await getValidDocsBotToken(ctx, institutionId);
    try {
      const result = await processGoogleThreadEvent(
        {
          documentId: receipt.documentId!,
          commentId: receipt.commentId!,
          replyId: receipt.replyId,
          mentionedEmails: receipt.mentionedEmails,
          eventAuthorEmail: receipt.authorEmail,
          botEmail,
        },
        {
          listComments: (documentId) => driveCommentsList(token, documentId),
          resolveTriggerAuthorIdentity: (trigger) =>
            resolveGoogleDocsCommentAuthorIdentity(ctx, {
              institutionId,
              subscriptionCreatedBy,
              ...trigger,
            }),
          claimReply: async () =>
            (
              await ctx.runMutation(
                internal.googleDocsEvents.claimTriggerReply,
                { receiptId: args.receiptId },
              )
            ).fresh,
          getDocumentContext: async (documentId) => {
            const document = await getDocument(token, documentId, {
              includeTabsContent: true,
            });
            return {
              title: document.title ?? "Untitled document",
              body: buildGoogleDocumentBody(document),
            };
          },
          runAideTurn: (aideContext) =>
            runDocsCommentAideTurn(ctx, institutionId, aideContext),
          createReply: (documentId, commentId, content) =>
            driveCommentReplyCreate(token, documentId, commentId, content),
        },
      );
      if (result.kind === "trigger_not_found") {
        throw new Error("Google Drive comment or reply was not found after its create event");
      }
      await ctx.runMutation(internal.googleDocsEvents.finishReceipt, {
        receiptId: args.receiptId,
        outcome: result.kind === "replied" ? "replied" : "ignored",
      });
      return result;
    } catch (error) {
      await ctx.runMutation(internal.googleDocsEvents.finishReceipt, {
        receiptId: args.receiptId,
        outcome: "failed",
        error: errorMessage(error),
      });
      throw error;
    }
  },
});
