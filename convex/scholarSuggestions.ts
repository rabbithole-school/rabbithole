// The Workshop (internal code name: `meta`) — scholar suggestions about
// Rabbithole itself, and the staff response loop that closes the circuit.
// See review/scholar-meta-prep-time-plan.html §§5, 6, 8, 9.
//
// An idea has NO staff-set state (the `heard`/`answered` enum was retired
// 2026-08-25 — see schema.ts). Two independent facts describe one:
//   * **a human replied** — `staffResponse !== undefined`. That is what the
//     kid's card reads and what the staff queue means by "owes a reply".
//   * **the scholar archived it** — `archivedAt`. The scholar's own act; staff
//     have no way to set it. "Open" everywhere means NOT ARCHIVED.
// Replying therefore does not close anything: it is a comment, never a
// verdict, and the five-open cap is a prioritization lesson pointed at the
// kid, so the kid — not a staffer — decides when a slot frees. No pipeline, no
// tracking to shipped code; release-note credit is its own editorial act on
// `changelogEntries`, not here.
//
// Phase 1 (this file): the manual composer (`createMine`), the scholar's own
// board (`listMine`), the staff queue (`listOpenForStaff` +
// `listForStaffInternal` for the aide tool), and the human reply (`respond`,
// the aide tool's backing mutation). The reflection chat that auto-distills
// ideas is Phase 2.
//
// THE CONVERSATION (2026-09-25). Every idea now has a Workshop thread — a
// `parentThreads` row of kind "workshop" (scholarMessages.ts), linked both
// ways (`scholarSuggestions.threadId` / `parentThreads.suggestionId`). The
// scholar's words are its first message; every staff reply (dashboard, aide,
// Slack) is a message in it, and the scholar can answer back. "A human
// replied" = the thread holds a staff message; `staffResponse` and
// `responseSeenAt` are DEPRECATED (read only to backfill a legacy idea's
// thread) until the narrow drops them.

import { v } from "convex/values";
import { authedQuery, authedMutation, teacherQuery, teacherMutation } from "./lib/customFunctions";
import {
  internalAction,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { isTeacherRole } from "./lib/roles";
import {
  resolveInstitutionLens,
  scholarInLens,
  scholarIdsInLens,
} from "./lib/institutionLens";
import { extendedEducationTag } from "./lib/scholarParticipationTooling";
import { firstLineToTitle } from "./lib/textToTitle";
import { scholarInstitutionId } from "./lib/scholarEnrollment";
import {
  ensureWorkshopThreadForSuggestion,
  appendScholarWordsIfMissing,
  postScholarThreadMessage,
  scholarThreadFacts,
} from "./scholarMessages";
import {
  scholarForThread,
  staffCanReachScholar,
} from "./lib/scholarThreadAccess";
import {
  attachmentPreview,
  previewOf,
  userDisplayName,
} from "./parentMessages";
import {
  escapeSlackText,
  fetchConversationHistory,
  fetchConversationReplies,
  messageWithDeliveryMetadata,
  postMessage,
  type SlackMessageMetadata,
} from "./lib/slackApi";

/**
 * Fail-CLOSED institution-lens check for the Workshop aide-tool paths — the
 * internal fns that run with NO `ctx.user`, so the caller's scholar lens is
 * threaded in as args (`allowedScholarIds` + `scholarLensResolved`). Mirrors the
 * semantics of `assertTargetsWithinLens` in convex/customApps.ts: an absent id
 * set is legitimate ONLY when the caller actually resolved a lens and found
 * itself unrestricted (a platform admin's "all" lens). A caller that never
 * resolved one at all sees / touches NOTHING — that silence must never read as
 * "no restrictions apply". Exported so `changelog.createEntry` enforces the
 * identical rule on credited usernames.
 */
export function isScholarWithinAideLens(
  scholarId: Id<"users">,
  allowedScholarIds: Set<Id<"users">> | undefined,
  scholarLensResolved: boolean | undefined,
): boolean {
  if (!allowedScholarIds) return scholarLensResolved === true;
  return allowedScholarIds.has(scholarId);
}

// Soft cap on OPEN (heard) ideas per scholar — a prioritization lesson, not a
// hard wall (§9 "rate/volume sanity"). The friendly error names the number so
// the UI can show it verbatim.
const MAX_OPEN_SUGGESTIONS = 5;
/** Slack message metadata `event_type` on a Workshop-idea notification. The
 * inbound reply path keys on it to tell OUR root apart from any other message
 * a human might start a thread under. */
export const WORKSHOP_IDEA_EVENT_TYPE = "rabbithole_workshop_idea";
const WORKSHOP_RETRY_DELAYS_MS = [5_000, 30_000, 2 * 60_000, 10 * 60_000];

/** The `delivery_id` this file stamps on the Slack root message. It is the ONLY
 * durable Slack-thread → idea binding we have (the visible text carries just a
 * shortened name + title), so both the outbound dedupe and the inbound reply
 * path derive from this one shape. */
export function workshopDeliveryId(suggestionId: Id<"scholarSuggestions">): string {
  return `workshop-idea:${suggestionId}`;
}

/** Inverse of `workshopDeliveryId`, for the inbound Slack thread reply. Returns
 * the id string, or null when the metadata isn't ours.
 *
 * The shape check is not redundant with the mutation's `normalizeId`: the
 * @mention path names this id inside a MODEL PROMPT (slackBot.ts), so anything
 * carrying whitespace or newlines could add lines to that prompt. Only this bot
 * writes the metadata today, which is exactly why the guard belongs here rather
 * than in a comment about how it can't happen. */
export function suggestionIdFromDeliveryId(deliveryId: unknown): string | null {
  if (typeof deliveryId !== "string") return null;
  const prefix = "workshop-idea:";
  if (!deliveryId.startsWith(prefix)) return null;
  const raw = deliveryId.slice(prefix.length).trim();
  return /^[a-zA-Z0-9_-]+$/.test(raw) ? raw : null;
}

/** Shared with the meta-observer so its at-cap skip matches the composer's. */
export const MAX_OPEN_SUGGESTIONS_EXPORT = MAX_OPEN_SUGGESTIONS;

/**
 * A scholar's OPEN IDEAS — not archived, and not a bug-report card. The one
 * read behind the five-open cap (composer, chat capture, restore, observer) and
 * the reflection chat's duplicate-avoidance list, so a bug report can never
 * push a kid into the "which idea matters most?" moment.
 */
export async function openIdeas(
  ctx: QueryCtx,
  scholarId: Id<"users">,
): Promise<Doc<"scholarSuggestions">[]> {
  const open = await ctx.db
    .query("scholarSuggestions")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .filter((q) => q.eq(q.field("archivedAt"), undefined))
    .collect();
  return open.filter((row) => !row.bugReportId);
}

// Voice-only reports have no words until transcription lands.
const BUG_REPORT_CARD_FALLBACK_TITLE = "A bug you reported";

function bugReportCardFields(description: string | undefined) {
  const words = description?.trim() ?? "";
  return {
    title: (words && firstLineToTitle(words)) || BUG_REPORT_CARD_FALLBACK_TITLE,
    scholarWords: words,
  };
}

/**
 * Put a bug report the scholar filed about their OWN view onto their Workshop
 * board and into #workshop, exactly like an idea — a plain staff reply in that
 * thread reaches the scholar. Triage stays in the bug channel's own thread. The
 * one difference from an idea: no cap, because a bug report is never refused.
 * Idempotent per report. A spoken report's words don't exist yet, so its
 * #workshop post waits for `syncBugReportCard` after transcription.
 */
export async function fileBugReportCard(
  ctx: MutationCtx,
  args: {
    scholarId: Id<"users">;
    bugReportId: Id<"bugReports">;
    description: string | undefined;
    awaitingTranscript: boolean;
  },
): Promise<void> {
  const existing = await ctx.db
    .query("scholarSuggestions")
    .withIndex("by_bugReport", (q) => q.eq("bugReportId", args.bugReportId))
    .first();
  if (existing) return;
  const now = Date.now();
  const fields = bugReportCardFields(args.description);
  const suggestionId = await ctx.db.insert("scholarSuggestions", {
    scholarId: args.scholarId,
    bugReportId: args.bugReportId,
    ...fields,
    createdAt: now,
    updatedAt: now,
  });
  // The card's conversation. A spoken report's words land later
  // (syncBugReportCard), so its first message may wait for them.
  const card = await ctx.db.get(suggestionId);
  if (card) await ensureWorkshopThreadForSuggestion(ctx, card, now);
  if (!args.awaitingTranscript) await fanOutWorkshopIdea(ctx, { suggestionId });
}

/**
 * Once transcription has run, refresh the card's words and, for a spoken
 * report, post the #workshop thread `fileBugReportCard` held back.
 */
export async function syncBugReportCard(
  ctx: MutationCtx,
  args: {
    bugReportId: Id<"bugReports">;
    description: string | undefined;
    heldBack: boolean;
  },
): Promise<void> {
  const card = await ctx.db
    .query("scholarSuggestions")
    .withIndex("by_bugReport", (q) => q.eq("bugReportId", args.bugReportId))
    .first();
  if (!card) return;
  await ctx.db.patch(card._id, {
    ...bugReportCardFields(args.description),
    updatedAt: Date.now(),
  });
  const refreshed = await ctx.db.get(card._id);
  if (refreshed) await appendScholarWordsIfMissing(ctx, refreshed);
  if (args.heldBack) await fanOutWorkshopIdea(ctx, { suggestionId: card._id });
}

/** "Kai Nakamura" → "Kai N." for the digest line — a first name + last
 * initial, the same register the Slack sketch uses (§6). Falls back to the
 * whole name when there's no surname, or a generic label when unknown. */
export function shortScholarName(fullName: string | undefined | null): string {
  const name = (fullName ?? "").trim();
  if (!name) return "A scholar";
  const parts = name.split(/\s+/);
  if (parts.length === 1) return parts[0];
  const lastInitial = parts[parts.length - 1].charAt(0).toUpperCase();
  return `${parts[0]} ${lastInitial}.`;
}

// Slack rejects chat.postMessage text past ~40k chars and renders anything
// over a few thousand poorly. The RECORD keeps the kid's words verbatim —
// only the Slack rendering is clipped, with an explicit marker. Clip before
// escaping so an escape entity can't be cut mid-way.
const MAX_SLACK_IDEA_CHARS = 3500;

export function workshopIdeaSlackText(
  scholarName: string | undefined | null,
  scholarWords: string,
  kind: "idea" | "bug_report" = "idea",
): string {
  const trimmed = scholarWords.trim();
  const clipped = trimmed.length > MAX_SLACK_IDEA_CHARS
    ? `${trimmed.slice(0, MAX_SLACK_IDEA_CHARS)}…\n(truncated — the full idea is in Rabbithole)`
    : trimmed;
  const quotedIdea = escapeSlackText(clipped || "(no words captured)").replace(/\r?\n/g, "\n> ");
  const name = `**${escapeSlackText(shortScholarName(scholarName))}**`;
  return kind === "bug_report"
    ? `🐛 ${name} reported a bug (triage is in the bug-report channel):\n> ${quotedIdea}`
    : `💡 ${name} filed a Workshop idea:\n> ${quotedIdea}`;
}

/**
 * Workshop ideas use the primary school's configured inbox, never a class
 * group's EOD thread. The action revalidates eligibility before delivery.
 */
export async function fanOutWorkshopIdea(
  ctx: MutationCtx,
  args: { suggestionId: Id<"scholarSuggestions"> },
): Promise<void> {
  try {
    await ctx.scheduler.runAfter(0, internal.scholarSuggestions.postWorkshopIdea, {
      suggestionId: args.suggestionId,
    });
  } catch (err) {
    console.error("Workshop idea Slack fan-out failed (ignored):", err);
  }
}

/** Delivery-time facts for a first-party Workshop idea notification. */
export const workshopDeliveryContext = internalQuery({
  args: { suggestionId: v.id("scholarSuggestions") },
  handler: async (ctx, args) => {
    const suggestion = await ctx.db.get(args.suggestionId);
    if (!suggestion) return null;
    const institutionId = await scholarInstitutionId(ctx, suggestion.scholarId);
    if (!institutionId) return null;
    const institution = await ctx.db.get(institutionId);
    if (!institution?.isPrimary || institution.disabledAt !== undefined) return null;
    const scholar = await ctx.db.get(suggestion.scholarId);
    return {
      text: workshopIdeaSlackText(
        scholar?.name,
        suggestion.scholarWords,
        suggestion.bugReportId ? "bug_report" : "idea",
      ),
      deliveryId: workshopDeliveryId(suggestion._id),
      createdAt: suggestion.createdAt,
    };
  },
});

export const postWorkshopIdea = internalAction({
  args: {
    suggestionId: v.id("scholarSuggestions"),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const channelId = process.env.SLACK_WORKSHOP_CHANNEL_ID?.trim();
    const token = process.env.SLACK_BOT_TOKEN;
    if (!channelId || !token) return;
    const context = await ctx.runQuery(
      internal.scholarSuggestions.workshopDeliveryContext,
      { suggestionId: args.suggestionId },
    );
    if (!context) return;

    const scheduleRetry = async (retryAfterMs?: number) => {
      const attempt = args.attempt ?? 0;
      const baseDelay = WORKSHOP_RETRY_DELAYS_MS[attempt];
      if (baseDelay === undefined) return;
      await ctx.scheduler.runAfter(
        Math.max(baseDelay, retryAfterMs ?? 0),
        internal.scholarSuggestions.postWorkshopIdea,
        { suggestionId: args.suggestionId, attempt: attempt + 1 },
      );
    };

    const history = await fetchConversationHistory(token, channelId, {
      oldest: String(Math.max(0, Math.floor(context.createdAt / 1000) - 60)),
    });
    if (!history.ok) {
      await scheduleRetry(history.retryAfterMs);
      return;
    }
    const alreadyPosted = messageWithDeliveryMetadata(
      history.messages,
      WORKSHOP_IDEA_EVENT_TYPE,
      context.deliveryId,
    );
    if (alreadyPosted) {
      // Metadata dedupe still guards the post; make sure the durable binding
      // exists too (a retry after a crash between post and record).
      await ctx.runMutation(internal.scholarSuggestions.recordWorkshopSlackRoot, {
        suggestionId: args.suggestionId,
        channelId,
        threadTs: alreadyPosted.ts!,
      });
      return;
    }

    const metadata: SlackMessageMetadata = {
      event_type: WORKSHOP_IDEA_EVENT_TYPE,
      event_payload: { delivery_id: context.deliveryId },
    };
    const posted = await postMessage(token, {
      channel: channelId,
      text: context.text,
      metadata,
      markdown: true,
    });
    if (!posted.ok) {
      await scheduleRetry(posted.retryAfterMs);
      return;
    }
    if (posted.ts) {
      await ctx.runMutation(internal.scholarSuggestions.recordWorkshopSlackRoot, {
        suggestionId: args.suggestionId,
        channelId: posted.channel ?? channelId,
        threadTs: posted.ts,
      });
    }
  },
});

/**
 * The durable #workshop root ↔ idea thread binding, in the same table the
 * family Slack bridge uses. It is what lets a scholar's in-app reply land in
 * the idea's own Slack thread. (Inbound staff replies still resolve through
 * the root's metadata — parentMessages.ingestInboundSlackReply hands these
 * rows back as non-family.) Idempotent on (channel, ts).
 */
export const recordWorkshopSlackRoot = internalMutation({
  args: {
    suggestionId: v.id("scholarSuggestions"),
    channelId: v.string(),
    threadTs: v.string(),
  },
  handler: async (ctx, args) => {
    const suggestion = await ctx.db.get(args.suggestionId);
    if (!suggestion) return null;
    const threadId = await ensureWorkshopThreadForSuggestion(
      ctx,
      suggestion,
      Date.now(),
    );
    if (!threadId) return null;
    // The #workshop root quotes the scholar's words, so the thread's OPENING
    // scholar message now also lives in Slack — withdrawing it in the app
    // can't recall that copy (copiedOutside). Posted and reconciled alike.
    const opening = (
      await ctx.db
        .query("parentMessages")
        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
        .collect()
    )
      .filter((message) => message.authorType === "scholar")
      .sort((a, b) => (a.sentAt ?? a._creationTime) - (b.sentAt ?? b._creationTime))[0];
    if (opening && opening.copiedToSlackAt === undefined) {
      await ctx.db.patch(opening._id, { copiedToSlackAt: Date.now() });
    }
    const existing = await ctx.db
      .query("parentSlackThreads")
      .withIndex("by_channel_thread", (q) =>
        q.eq("channelId", args.channelId).eq("threadTs", args.threadTs),
      )
      .first();
    if (existing) {
      return existing.parentThreadId === threadId ? existing._id : null;
    }
    return await ctx.db.insert("parentSlackThreads", {
      parentThreadId: threadId,
      channelId: args.channelId,
      threadTs: args.threadTs,
      lastNotifiedAt: Date.now(),
    });
  },
});

/**
 * What a scholar's in-app reply looks like in the idea's #workshop thread —
 * labelled as the scholar's own words from the app, so no staffer mistakes it
 * for a colleague. The bot posts it, and slackBot ignores bot-authored
 * messages, so it can never be re-ingested as a staff reply (no echo loop).
 */
function workshopScholarReplySlackText(
  scholarName: string | undefined | null,
  body: string,
  attachmentCount: number,
): string {
  const trimmed = body.trim();
  const clipped = trimmed.length > MAX_SLACK_IDEA_CHARS
    ? `${trimmed.slice(0, MAX_SLACK_IDEA_CHARS)}…`
    : trimmed;
  const quoted = clipped
    ? `> ${escapeSlackText(clipped).replace(/\r?\n/g, "\n> ")}`
    : "";
  const attached =
    attachmentCount > 0
      ? `_${attachmentCount === 1 ? "1 attachment" : `${attachmentCount} attachments`} — open it in Rabbithole_`
      : "";
  return [
    `↩ **${escapeSlackText(shortScholarName(scholarName))}** replied in the app:`,
    quoted,
    attached,
  ]
    .filter(Boolean)
    .join("\n");
}

export const scholarReplySlackContext = internalQuery({
  args: { messageId: v.id("parentMessages") },
  handler: async (ctx, { messageId }) => {
    const message = await ctx.db.get(messageId);
    if (!message || message.authorType !== "scholar" || message.retractedAt) {
      return null;
    }
    const thread = await ctx.db.get(message.threadId);
    if (!thread || thread.kind !== "workshop" || !thread.suggestionId) return null;
    const scholar = await scholarForThread(ctx, thread);
    if (!scholar || !thread.institutionId) return null;
    // First-party only, exactly like the #workshop post itself.
    const institution = await ctx.db.get(thread.institutionId);
    if (!institution?.isPrimary) return null;
    const channelId = process.env.SLACK_WORKSHOP_CHANNEL_ID?.trim();
    const roots = await ctx.db
      .query("parentSlackThreads")
      .withIndex("by_parent_thread", (q) => q.eq("parentThreadId", thread._id))
      .collect();
    const root = roots
      .filter((row) => !channelId || row.channelId === channelId)
      .sort((a, b) => b.lastNotifiedAt - a.lastNotifiedAt)[0];
    const suggestion = await ctx.db.get(thread.suggestionId);
    if (!suggestion) return null;
    const attachments = (
      await ctx.db
        .query("parentMessageAttachments")
        .withIndex("by_message", (q) => q.eq("messageId", message._id))
        .collect()
    ).filter((attachment) => attachment.retractedAt === undefined);
    return {
      // Null for an idea posted before roots were recorded (or migrated):
      // the action then finds the root by its delivery metadata.
      root: root ? { channelId: root.channelId, threadTs: root.threadTs } : null,
      suggestionId: suggestion._id,
      deliveryId: workshopDeliveryId(suggestion._id),
      createdAt: suggestion.createdAt,
      text: workshopScholarReplySlackText(
        scholar.name,
        message.body,
        attachments.length,
      ),
    };
  },
});

/** Slack metadata `event_type` on a scholar's forwarded Workshop reply. */
const WORKSHOP_REPLY_EVENT_TYPE = "rabbithole_workshop_scholar_reply";

function workshopReplyDeliveryId(messageId: Id<"parentMessages">): string {
  return `workshop-reply:${messageId}`;
}

/**
 * A scholar's in-app reply on an idea → that idea's #workshop Slack thread.
 * Never a silent drop: a root that can't be found yet (the idea's own post may
 * still be retrying) or a failed post retries on the same backoff as the idea
 * post, and the final failure is logged as an error.
 */
export const forwardScholarReplyToSlack = internalAction({
  args: { messageId: v.id("parentMessages"), attempt: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const token = process.env.SLACK_BOT_TOKEN;
    const channelId = process.env.SLACK_WORKSHOP_CHANNEL_ID?.trim();
    if (!token || !channelId) return;
    const context = await ctx.runQuery(
      internal.scholarSuggestions.scholarReplySlackContext,
      { messageId: args.messageId },
    );
    if (!context) return;
    const attempt = args.attempt ?? 0;
    const retryOrGiveUp = async (reason: string, retryAfterMs?: number) => {
      const baseDelay = WORKSHOP_RETRY_DELAYS_MS[attempt];
      if (baseDelay === undefined) {
        console.error(
          `Workshop scholar reply ${args.messageId} never reached #workshop (idea ${context.suggestionId}): ${reason} — it is in the app only.`,
        );
        return;
      }
      await ctx.scheduler.runAfter(
        Math.max(baseDelay, retryAfterMs ?? 0),
        internal.scholarSuggestions.forwardScholarReplyToSlack,
        { messageId: args.messageId, attempt: attempt + 1 },
      );
    };
    let root = context.root;
    if (!root) {
      // A legacy/migrated idea (or one whose post hasn't landed yet): find its
      // #workshop root the way postWorkshopIdea dedupes, by the delivery id in
      // the root's metadata, and record it so the next reply skips the search.
      const history = await fetchConversationHistory(token, channelId, {
        oldest: String(Math.max(0, Math.floor(context.createdAt / 1000) - 60)),
      });
      const found = history.ok
        ? messageWithDeliveryMetadata(
            history.messages,
            WORKSHOP_IDEA_EVENT_TYPE,
            context.deliveryId,
          )
        : undefined;
      if (!found?.ts) {
        await retryOrGiveUp(
          history.ok
            ? "no #workshop root found"
            : `history read failed: ${history.error ?? "unknown"}`,
          history.retryAfterMs,
        );
        return;
      }
      root = { channelId, threadTs: found.ts };
      await ctx.runMutation(internal.scholarSuggestions.recordWorkshopSlackRoot, {
        suggestionId: context.suggestionId,
        channelId: root.channelId,
        threadTs: root.threadTs,
      });
    }
    // Each forwarded reply carries its own delivery id in Slack metadata, so a
    // retry after an ambiguous outcome (Slack took the post but the response
    // was lost) reconciles against the thread instead of posting it twice.
    const deliveryId = workshopReplyDeliveryId(args.messageId);
    if (attempt > 0) {
      const replies = await fetchConversationReplies(
        token,
        root.channelId,
        root.threadTs,
      );
      if (!replies.ok) {
        await retryOrGiveUp(
          `thread read failed: ${replies.error ?? "unknown"}`,
          replies.retryAfterMs,
        );
        return;
      }
      if (
        messageWithDeliveryMetadata(
          replies.messages,
          WORKSHOP_REPLY_EVENT_TYPE,
          deliveryId,
        )
      ) {
        await ctx.runMutation(internal.scholarSuggestions.markReplyCopiedToSlack, {
          messageId: args.messageId,
        });
        return;
      }
    }
    const posted = await postMessage(token, {
      channel: root.channelId,
      threadTs: root.threadTs,
      text: context.text,
      markdown: true,
      metadata: {
        event_type: WORKSHOP_REPLY_EVENT_TYPE,
        event_payload: { delivery_id: deliveryId },
      },
    });
    if (!posted.ok) {
      await retryOrGiveUp(`post failed: ${posted.error ?? "unknown"}`, posted.retryAfterMs);
      return;
    }
    await ctx.runMutation(internal.scholarSuggestions.markReplyCopiedToSlack, {
      messageId: args.messageId,
    });
  },
});

/** Stamp that a scholar's reply now also lives in Slack (see copiedOutside). */
export const markReplyCopiedToSlack = internalMutation({
  args: { messageId: v.id("parentMessages") },
  handler: async (ctx, { messageId }) => {
    const message = await ctx.db.get(messageId);
    if (message && message.copiedToSlackAt === undefined) {
      await ctx.db.patch(messageId, { copiedToSlackAt: Date.now() });
    }
  },
});

/**
 * An idea's conversation state, read from its Workshop thread: whether any
 * staff message exists (`answered`) and whether the scholar spoke last
 * (`owesReply` — a brand-new idea, or a follow-up after a reply). An idea
 * whose thread hasn't been backfilled yet falls back to its legacy
 * `staffResponse`.
 */
async function ideaConversation(ctx: QueryCtx, row: Doc<"scholarSuggestions">) {
  const linked = row.threadId ? await ctx.db.get(row.threadId) : null;
  // A thread left behind at a school the scholar has moved away from is not
  // this idea's conversation any more (the next write opens a fresh one).
  const thread = linked && (await scholarForThread(ctx, linked)) ? linked : null;
  if (!thread) {
    return {
      thread: null,
      facts: null,
      answered: !!row.staffResponse,
      owesReply: !row.staffResponse,
    };
  }
  const facts = await scholarThreadFacts(ctx, thread);
  return {
    thread,
    facts,
    answered: facts.hasStaffMessage,
    owesReply: facts.lastVisible
      ? facts.lastVisible.authorType === "scholar"
      : !facts.hasStaffMessage,
  };
}

/** A staff-facing suggestion row joined with its scholar's display name +
 * username (the queue + the aide tool both need to name the child). */
async function joinScholar(ctx: QueryCtx, row: Doc<"scholarSuggestions">) {
  const scholar = await ctx.db.get(row.scholarId);
  const conversation = await ideaConversation(ctx, row);
  return {
    _id: row._id,
    scholarId: row.scholarId,
    scholarName: scholar?.name ?? "Unknown scholar",
    scholarUsername: scholar?.username ?? null,
    title: row.title,
    scholarWords: row.scholarWords,
    // Additive when a thinking-partner conversation reshaped the idea and the
    // scholar agreed to the new framing — staff see the kid's original words
    // (scholarWords) AND this refined framing. Absent for as-sent ideas.
    refined: row.refined,
    distilled: row.distilled,
    archivedAt: row.archivedAt,
    answered: conversation.answered,
    // The scholar spoke last — a new idea, or a follow-up after a reply.
    needsReply: conversation.owesReply,
    // A card mirroring a scholar's bug report rather than an idea.
    bugReport: !!row.bugReportId,
    // The idea's Workshop conversation (open it in /teacher/messages).
    threadId: row.threadId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // Extended Education (program-guest) scholars' rows carry a tag so the
    // aide tool edge can apply the enrolled-only default (see
    // lib/scholarParticipationTooling.ts); enrolled rows stay byte-identical.
    ...extendedEducationTag({ enrollmentStanding: scholar?.enrollmentStanding }),
  };
}

/**
 * File an idea about the Workshop, for MYSELF. `scholarId` is ALWAYS the
 * caller — never an argument — so no one can file on another kid's behalf.
 * Title is the first line/sentence of the text; scholarWords keeps the full
 * verbatim text (in-app only). New ideas start `heard`.
 */
export const createMine = authedMutation({
  args: { text: v.string() },
  handler: async (ctx, args) => {
    const text = args.text.trim();
    if (!text) {
      throw new Error("Add a few words about your idea first.");
    }

    const scholarId = ctx.user._id;

    // Soft cap: too many open ideas is a prioritization moment, not a bug.
    const open = await openIdeas(ctx, scholarId);
    if (open.length >= MAX_OPEN_SUGGESTIONS) {
      throw new Error(
        `You've already got ${MAX_OPEN_SUGGESTIONS} ideas open in the Workshop — that's the most at once. Let's see what happens with those first. Which one matters most to you?`,
      );
    }

    const now = Date.now();
    const title = firstLineToTitle(text);
    const suggestionId = await ctx.db.insert("scholarSuggestions", {
      scholarId,
      title,
      scholarWords: text,
      createdAt: now,
      updatedAt: now,
    });
    const idea = await ctx.db.get(suggestionId);
    if (idea) await ensureWorkshopThreadForSuggestion(ctx, idea, now);

    await fanOutWorkshopIdea(ctx, {
      suggestionId,
    });

    return { suggestionId, title };
  },
});

/**
 * The result the `send_idea_to_teacher` tool relays to the model (Workshop
 * idea-conversations, WORKSHOP_IDEA_CONVOS_ENABLED). A discriminated union so
 * the tool can speak naturally about what happened:
 *  - `captured`: the idea was sent (a row exists).
 *  - `at_cap`:   the scholar already has the max open ideas — nothing was sent;
 *                the tool relays a "help them prioritize" nudge (§9 cap parity
 *                with the composer's message).
 *  - `empty`:    no scholar words to send (defensive; the model must supply the
 *                kid's own phrasing).
 */
export type CaptureFromChatResult =
  | { status: "captured"; suggestionId: Id<"scholarSuggestions">; title: string }
  | { status: "at_cap"; cap: number }
  | { status: "empty" };

/**
 * Capture an idea a scholar chose to send from a Workshop reflection chat, via
 * the `send_idea_to_teacher` tool. The parallel of `createMine` for the tool
 * path: `scholarId` is the chat's owner (resolved by the caller from the
 * authenticated identity — NEVER a model-supplied value), so no one can file on
 * another kid's behalf.
 *
 * Records the kid's OWN words verbatim (`scholarWords`) and, when a thinking-
 * partner conversation reshaped the idea and the scholar agreed to it, the
 * `refined` framing too — staff see BOTH (QB guardrail #3, "the kid's words
 * survive"). At the open-ideas cap it captures NOTHING and returns `at_cap` so
 * the tool can help the scholar prioritize instead of erroring (guardrail #2 /
 * §9), never a hard wall that would block sending.
 */
export const captureFromChat = internalMutation({
  args: {
    scholarId: v.id("users"),
    title: v.string(),
    scholarWords: v.string(),
    refined: v.optional(v.string()),
    sourceChatId: v.optional(v.id("metaChats")),
  },
  handler: async (ctx, args): Promise<CaptureFromChatResult> => {
    const scholarWords = args.scholarWords.trim();
    // The kid's own words are the whole point — never file an empty idea.
    if (!scholarWords) return { status: "empty" };

    const scholarId = args.scholarId;

    // Soft cap, same number as the composer — the thinking partner helps the
    // scholar prioritize rather than piling on. Nothing is written at the cap.
    const open = await openIdeas(ctx, scholarId);
    if (open.length >= MAX_OPEN_SUGGESTIONS) {
      return { status: "at_cap", cap: MAX_OPEN_SUGGESTIONS };
    }

    const title = args.title.trim() || firstLineToTitle(scholarWords);
    // Only persist `refined` when it's a real, distinct framing — a blank or a
    // verbatim echo of the kid's own words isn't a refinement, so drop it.
    const refinedTrimmed = args.refined?.trim();
    const refined =
      refinedTrimmed && refinedTrimmed !== scholarWords ? refinedTrimmed : undefined;

    const now = Date.now();
    const suggestionId = await ctx.db.insert("scholarSuggestions", {
      scholarId,
      title,
      scholarWords,
      ...(refined ? { refined } : {}),
      sourceChatId: args.sourceChatId,
      createdAt: now,
      updatedAt: now,
    });
    const idea = await ctx.db.get(suggestionId);
    if (idea) await ensureWorkshopThreadForSuggestion(ctx, idea, now);

    await fanOutWorkshopIdea(ctx, {
      suggestionId,
    });

    return { status: "captured", suggestionId, title };
  },
});

/**
 * The caller's own suggestions, newest first — full rows (their own words +
 * any staff response), each with the responding staff member's display name
 * resolved for the "From <staff name>" block on their card. Safe: it's the
 * scholar's own record.
 */
export const listMine = authedQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("scholarSuggestions")
      .withIndex("by_scholar", (q) => q.eq("scholarId", ctx.user._id))
      .order("desc")
      .collect();
    return await Promise.all(
      rows.map(async (row) => {
        // DEPRECATED fields kept for clients still reading them.
        const responder = row.staffResponse
          ? await ctx.db.get(row.staffResponse.authorId)
          : null;
        const conversation = await ideaConversation(ctx, row);
        let lastMessage: {
          authorName: string;
          body: string;
          mine: boolean;
          at: number;
        } | null = null;
        const last = conversation.facts?.lastVisible ?? null;
        if (last) {
          const mine = last.authorUserId === ctx.user._id;
          const author = last.authorUserId
            ? await ctx.db.get(last.authorUserId)
            : null;
          const attachments = (
            await ctx.db
              .query("parentMessageAttachments")
              .withIndex("by_message", (q) => q.eq("messageId", last._id))
              .collect()
          ).filter((attachment) => attachment.retractedAt === undefined);
          lastMessage = {
            authorName: mine
              ? "You"
              : userDisplayName(author, "The Rabbithole team"),
            body: previewOf(last.body) || attachmentPreview(attachments),
            mine,
            at: last.sentAt ?? last._creationTime,
          };
        }
        return {
          ...row,
          responderName: responder?.name ?? null,
          threadId: conversation.thread?._id ?? null,
          lastMessage,
          unread: conversation.facts?.scholarUnread ?? false,
          answered: conversation.answered,
        };
      }),
    );
  },
});

/**
 * Ideas that still OWE A REPLY — not archived by the scholar, and the scholar
 * spoke last in the idea's thread (nobody has written back yet, or the
 * scholar answered a reply) — oldest first, joined with each scholar's name + username.
 * Backs the teacher-dashboard queue (the aide tool reads through the internal
 * sibling below, since it runs in an action with a mapped principal, not a
 * Convex-auth identity).
 */
export const listOpenForStaff = teacherQuery({
  args: {},
  handler: async (ctx) => {
    // Indexed on the un-archived rows only — an archived idea is off the
    // plate, and a global scan would grow without bound as the table does.
    const rows = await ctx.db
      .query("scholarSuggestions")
      .withIndex("by_archived", (q) => q.eq("archivedAt", undefined))
      .collect();
    rows.sort((a, b) => a.createdAt - b.createdAt);
    // Institution boundary (CLAUDE.md § Multi-tenancy): a role check alone is a
    // cross-tenant leak, so a teacher only sees ideas from scholars in their
    // context. Use the SAME lens the aide path uses (institutionLens) — NOT the
    // access.ts helpers — so the dashboard and the aide cannot diverge: the aide
    // lens deliberately includes UNASSIGNED scholars (institutionId undefined)
    // under the primary institution during the pre-backfill window, and those
    // scholars' ideas must not silently vanish from the queue that owes them a
    // reply. Build the allowed set once, then filter BEFORE joining any scholar
    // name/username PII.
    const lens = await resolveInstitutionLens(ctx, ctx.user, "");
    const allowed = await scholarIdsInLens(ctx, lens, {
      includeProgramGuests: true,
    });
    const visible = rows.filter((r) => allowed.has(r.scholarId));
    const joined = await Promise.all(visible.map((row) => joinScholar(ctx, row)));
    return joined.filter((row) => row.needsReply);
  },
});

/**
 * Staff-queue read for the aide tool (`list_scholar_suggestions`), gated at
 * the tool-assembly layer (teacher+). Optional filters: `filter` and a
 * scholar `username` (exact). Oldest first — the longest-waiting idea leads.
 *
 * `filter` replaced the retired `status` enum: "needs_reply" (nobody has
 * written back and the scholar hasn't archived it), "answered" (a human
 * replied), "archived" (the scholar archived it). Archived ideas are EXCLUDED
 * from the other two — they are off the kid's plate.
 */
export const listForStaffInternal = internalQuery({
  args: {
    filter: v.optional(
      v.union(
        v.literal("needs_reply"),
        v.literal("answered"),
        v.literal("archived"),
      ),
    ),
    scholarUsername: v.optional(v.string()),
    // Institution lens threaded from the aide tool layer (this fn has no
    // ctx.user). Arrays over the wire — Convex validators can't take a Set.
    allowedScholarIds: v.optional(v.array(v.id("users"))),
    scholarLensResolved: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const allowed = args.allowedScholarIds
      ? new Set(args.allowedScholarIds)
      : undefined;
    // Fail CLOSED: a caller that never resolved a lens sees nothing.
    const inLens = (scholarId: Id<"users">) =>
      isScholarWithinAideLens(scholarId, allowed, args.scholarLensResolved);

    let scholarId: Id<"users"> | undefined;
    const username = args.scholarUsername?.trim();
    if (username) {
      const scholar = await ctx.db
        .query("users")
        .withIndex("by_username", (q) => q.eq("username", username))
        .unique();
      // A named-but-unknown scholar yields no rows (the tool says so) rather
      // than silently listing everyone's ideas. An out-of-lens scholar is
      // refused the SAME way — same empty shape as "unknown scholar" — so the
      // tool copy still reads correctly and we never confirm that another
      // tenant's scholar exists.
      if (!scholar || !inLens(scholar._id)) return [];
      scholarId = scholar._id;
    }

    let rows: Doc<"scholarSuggestions">[];
    if (scholarId) {
      const id = scholarId;
      rows = await ctx.db
        .query("scholarSuggestions")
        .withIndex("by_scholar", (q) => q.eq("scholarId", id))
        .collect();
    } else if (args.filter === "answered" || args.filter === "needs_reply") {
      // Both live filters are "not archived" — read that through the index
      // rather than scanning every idea the school has ever filed.
      rows = await ctx.db
        .query("scholarSuggestions")
        .withIndex("by_archived", (q) => q.eq("archivedAt", undefined))
        .collect();
    } else {
      rows = await ctx.db.query("scholarSuggestions").collect();
    }
    if (args.filter === "archived") {
      rows = rows.filter((r) => !!r.archivedAt);
    } else if (args.filter === "answered" || args.filter === "needs_reply") {
      rows = rows.filter((r) => !r.archivedAt);
    }

    // Scope to the lens BEFORE joinScholar — never resolve a child's name +
    // username for an out-of-lens row.
    rows = rows.filter((r) => inLens(r.scholarId));

    rows.sort((a, b) => a.createdAt - b.createdAt);
    const joined = await Promise.all(rows.map((row) => joinScholar(ctx, row)));
    if (args.filter === "answered") return joined.filter((row) => row.answered);
    if (args.filter === "needs_reply") return joined.filter((row) => row.needsReply);
    return joined;
  },
});

/**
 * Shared core for posting a human reply on an idea — used by the aide tool's
 * `respond` (internal, bot-mapped author), the dashboard's `respondAsStaff`
 * (teacherMutation, the signed-in teacher) and the #workshop Slack thread.
 * `authorId` must be teacher+ (checked here as defense-in-depth).
 *
 * A reply is a MESSAGE in the idea's Workshop thread (authorType "teacher"),
 * appended after whatever is already there — never an overwrite, never a
 * string glued onto a previous reply. It CHANGES NO STATE: whether the idea is
 * still on the scholar's plate is theirs to say (`archivedAt`).
 */
async function respondCore(
  ctx: MutationCtx,
  args: {
    suggestionId: Id<"scholarSuggestions">;
    authorId: Id<"users">;
    body: string;
    // Institution boundary. The dashboard path (respondAsStaff) has a real
    // authenticated staffer → the SAME institution lens the aide uses
    // (resolveInstitutionLens + scholarInLens), so unassigned scholars under
    // the primary institution stay answerable; the aide path threads its
    // resolved lens in and is fail-closed the same way as listForStaffInternal.
    lens:
      | { via: "userAccess" }
      | {
          via: "aideLens";
          allowedScholarIds: Set<Id<"users">> | undefined;
          scholarLensResolved: boolean | undefined;
        };
    /** Transport provenance ("via Slack") for the staff-facing badge. */
    source?: "slack";
  },
) {
  const author = await ctx.db.get(args.authorId);
  if (!author || !isTeacherRole(author.role)) {
    throw new Error("Forbidden: teacher or admin role required");
  }
  const body = args.body.trim();
  if (!body) throw new Error("A reply needs a message.");

  const suggestion = await ctx.db.get(args.suggestionId);
  if (!suggestion) throw new Error("Suggestion not found");

  // Institution boundary (CLAUDE.md § Multi-tenancy): a staffer may only reply
  // to an idea from a scholar in their context — the role gate above is not
  // enough. Enforced BEFORE any write, so an out-of-lens idea is left untouched.
  // The dashboard path resolves the SAME lens the aide uses (institutionLens,
  // not access.ts) so unassigned scholars under the primary institution stay
  // answerable; the aide path uses its threaded, fail-closed set.
  let withinLens: boolean;
  if (args.lens.via === "userAccess") {
    const lens = await resolveInstitutionLens(ctx, author, "");
    const scholar = await ctx.db.get(suggestion.scholarId);
    withinLens = !!scholar && scholarInLens(lens, scholar);
  } else {
    withinLens = isScholarWithinAideLens(
      suggestion.scholarId,
      args.lens.allowedScholarIds,
      args.lens.scholarLensResolved,
    );
  }
  if (!withinLens) {
    // Deliberately the IDENTICAL error as a nonexistent id above — an
    // out-of-lens suggestion must be indistinguishable from "no such
    // suggestion" so staff can't use this as an existence oracle to learn that
    // another school's suggestion exists (same principle as the username branch
    // in listForStaffInternal and the credit branch in changelog.createEntry).
    // Do NOT "improve" this into a specific "outside your institution" message.
    throw new Error("Suggestion not found");
  }

  const now = Date.now();
  const threadId = await ensureWorkshopThreadForSuggestion(ctx, suggestion, now);
  const thread = threadId ? await ctx.db.get(threadId) : null;
  const threadScholar = thread ? await scholarForThread(ctx, thread) : null;
  if (!thread || !threadScholar) {
    // No institution to anchor a conversation to — same refusal shape.
    throw new Error("Suggestion not found");
  }
  // The lens above is a VISIBILITY rule; posting requires the Workshop team
  // rule itself (a teacher/school admin at the scholar's school, or a platform
  // admin). A global-teacher account whose only standing at that school is
  // base staff or curriculum could otherwise write into a thread it can't
  // read. Same refusal shape as a nonexistent id.
  if (!(await staffCanReachScholar(ctx, author, threadScholar, "workshop")).ok) {
    throw new Error("Suggestion not found");
  }
  const priorFacts = await scholarThreadFacts(ctx, thread);
  await postScholarThreadMessage(ctx, {
    thread,
    scholar: threadScholar,
    authorType: "teacher",
    authorUserId: args.authorId,
    body,
    source: args.source,
    now,
  });
  await ctx.db.patch(args.suggestionId, { updatedAt: now });

  const scholarFirstName =
    threadScholar.name?.trim().split(/\s+/)[0] ?? "the scholar";
  return {
    title: suggestion.title,
    scholarFirstName,
    appended: priorFacts.hasStaffMessage,
  };
}

/**
 * Store a human reply on an idea (the aide tool `respond_to_suggestion`'s
 * backing mutation). `authorId` is the CALLER (per-message principal),
 * resolved by the tool. The scholar lens is threaded from the tool layer so
 * this fails closed on a caller that never resolved one.
 */
export const respond = internalMutation({
  args: {
    suggestionId: v.id("scholarSuggestions"),
    authorId: v.id("users"),
    body: v.string(),
    // Arrays over the wire — Convex validators can't take a Set.
    allowedScholarIds: v.optional(v.array(v.id("users"))),
    scholarLensResolved: v.optional(v.boolean()),
  },
  handler: async (ctx, args) =>
    respondCore(ctx, {
      suggestionId: args.suggestionId,
      authorId: args.authorId,
      body: args.body,
      lens: {
        via: "aideLens",
        allowedScholarIds: args.allowedScholarIds
          ? new Set(args.allowedScholarIds)
          : undefined,
        scholarLensResolved: args.scholarLensResolved,
      },
    }),
});

/**
 * The teacher-dashboard queue's reply action — the signed-in teacher IS the
 * author. Thin `teacherMutation` wrapper over the same core as the aide tool
 * (per-request principal from the auth identity, not an arg). Its lens comes
 * from the real
 * authenticated user (resolveInstitutionLens), so it needs no id-set plumbing.
 */
export const respondAsStaff = teacherMutation({
  args: {
    suggestionId: v.id("scholarSuggestions"),
    body: v.string(),
  },
  handler: async (ctx, args) =>
    respondCore(ctx, {
      suggestionId: args.suggestionId,
      authorId: ctx.user._id,
      body: args.body,
      lens: { via: "userAccess" },
    }),
});

/**
 * The result of routing a plain Slack thread reply onto its Workshop idea, so
 * the Slack layer can ACK legibly instead of repeating the silent drop this
 * path exists to fix (see convex/slackBot.ts → handleWorkshopIdeaThreadReply).
 */
export type WorkshopSlackReplyResult =
  | { status: "recorded"; appended: boolean; title: string; scholarFirstName: string }
  | { status: "empty" }
  | { status: "forbidden" }
  | { status: "not_found" };

/**
 * Record a staff member's PLAIN Slack thread reply as the response on the idea
 * its thread root announced.
 *
 * Why this exists: `postWorkshopIdea` is a one-way post with no `slackThreads`
 * row, so a plain reply used to fall through every branch of the Slack message
 * handler and return silently — the child never heard back and the staffer got
 * no signal that nothing had happened (observed on prod 2026-08-25: both
 * Workshop ideas filed to date had a staff reply in Slack and neither reached
 * the scholar).
 *
 * Semantics, decided deliberately:
 *  - **Never changes the idea's state**, because no reply does any more: the
 *    `heard`/`answered` enum is retired and only the scholar can put an idea
 *    away (`archivedAt`).
 *  - **Every reply is its own message** in the idea's Workshop thread (source
 *    "slack"), after whatever is already there — the scholar sees each turn
 *    in their Messages and can answer back, and their answer comes back into
 *    this same Slack thread.
 *  - **Every staff reply in the thread reaches the child.** That IS the
 *    feature; it also means the thread is not a staff-room. The ✅ ack on the
 *    Slack side makes that visible on every message.
 *
 * `suggestionId` arrives as a raw string parsed out of Slack metadata, so it is
 * normalized against the real table rather than trusted as an id.
 */
export const respondFromSlackThread = internalMutation({
  args: {
    suggestionId: v.string(),
    authorId: v.id("users"),
    body: v.string(),
  },
  handler: async (ctx, args): Promise<WorkshopSlackReplyResult> => {
    const body = args.body.trim();
    if (!body) return { status: "empty" };

    // Pre-checked here (rather than left to respondCore's throw) so the Slack
    // layer can tell a staffer WHY nothing was recorded.
    const author = await ctx.db.get(args.authorId);
    if (!author || !isTeacherRole(author.role)) return { status: "forbidden" };

    const suggestionId = ctx.db.normalizeId(
      "scholarSuggestions",
      args.suggestionId,
    );
    if (!suggestionId) return { status: "not_found" };
    const existing = await ctx.db.get(suggestionId);
    if (!existing) return { status: "not_found" };

    // Each Slack reply is its own message in the idea's thread. Slack retries
    // are already deduped by event id upstream (slackBot.claimEvent).
    try {
      const result = await respondCore(ctx, {
        suggestionId,
        authorId: args.authorId,
        body,
        lens: { via: "userAccess" },
        source: "slack",
      });
      return {
        status: "recorded",
        appended: result.appended,
        title: result.title,
        scholarFirstName: result.scholarFirstName,
      };
    } catch (err) {
      // The expected throw here is respondCore's institution-lens refusal,
      // which is deliberately indistinguishable from "no such suggestion" (see
      // the comment there) — keep the RESPONSE that way. But the assumption
      // that nothing else can throw is unenforced, so log: a real bug degrading
      // into a friendly "couldn't match that" is precisely the silent failure
      // this whole path exists to eliminate.
      console.error(
        `scholarSuggestions.respondFromSlackThread: refused ${suggestionId}:`,
        err,
      );
      return { status: "not_found" };
    }
  },
});

/**
 * Put one of MY OWN ideas away, or bring it back.
 *
 * This is the lever the five-open cap was always pointing at. The cap's message
 * asks the kid "which one matters most to you?" — but until now a STAFFER
 * closing an idea is what freed a slot, so the friction landed on the child and
 * the control sat with an adult. `scholarId` is ALWAYS the caller, never an
 * argument, and there is deliberately no staff-facing equivalent: an adult can
 * reply to an idea, and that is all.
 *
 * Reversible on purpose. Putting something away should never feel like losing
 * it, and a kid who archives to make room may want it back next week.
 */
export const setArchivedMine = authedMutation({
  args: {
    suggestionId: v.id("scholarSuggestions"),
    archived: v.boolean(),
  },
  handler: async (ctx, args) => {
    const suggestion = await ctx.db.get(args.suggestionId);
    // Same shape as every other "my own row" guard: a suggestion belonging to
    // someone else is indistinguishable from one that doesn't exist.
    if (!suggestion || suggestion.scholarId !== ctx.user._id) {
      throw new Error("Idea not found");
    }
    const alreadyArchived = !!suggestion.archivedAt;
    if (alreadyArchived === args.archived) {
      return { archived: alreadyArchived, title: suggestion.title };
    }

    // Bringing an idea back can push the scholar over the five-open cap — say
    // so plainly rather than silently exceeding it, and name the number the way
    // the composer does. A bug-report card is not an idea, so it never waits.
    if (!args.archived && !suggestion.bugReportId) {
      const open = await openIdeas(ctx, ctx.user._id);
      if (open.length >= MAX_OPEN_SUGGESTIONS) {
        throw new Error(
          `You've already got ${MAX_OPEN_SUGGESTIONS} ideas out — that's the most at once. Archive one first to make room for this one.`,
        );
      }
    }

    await ctx.db.patch(args.suggestionId, {
      archivedAt: args.archived ? Date.now() : undefined,
      updatedAt: Date.now(),
    });
    return { archived: args.archived, title: suggestion.title };
  },
});
