// Scholar ↔ staff conversations — the `mentor` and `workshop` kinds of
// `parentThreads` (the family-messaging engine; the table name is legacy).
// Design: the "Scholar ↔ staff messaging" proposal (2026-09-25).
//
//   mentor   — ONE scholar ↔ the staff side. Only an ADULT opens one (a mentor
//              holding a `scholars:mentor` grant that covers the scholar, or a
//              teacher at the scholar's institution); the scholar can then
//              reply freely. A multi-scholar send fans out into one thread per
//              scholar — never a group chat.
//   workshop — one scholar ↔ the Rabbithole team (teachers at the scholar's
//              institution + platform admins), shown in the scholar's Workshop.
//              Usually created with an idea or a scholar-filed bug report card
//              (scholarSuggestions.ts; `thread.suggestionId` links back). The
//              team may also START one (`startWorkshopThread`): about a bug
//              report the scholar filed (routes into that card's thread), or
//              a fresh topic with no idea behind it (`suggestionId` absent —
//              never a scholarSuggestions row, never counts toward the cap).
//
// OPEN DOOR: there is no thread only one adult can read. Every teacher at the
// scholar's institution can read + reply to that scholar's mentor threads.
// A mentor sees ONLY mentor threads for scholars their grant covers — never
// family or workshop threads, dossiers, or anything else. The one access rule
// lives in lib/scholarThreadAccess.ts and is re-checked on every call.
//
// KID-SAFE DELIVERY: a scholar is notified in-app only. No email/SMS/WhatsApp
// delivery row is ever created for a scholar. A mentor gets email (batched: at
// most one per thread per 15 minutes, `sendMentorEmailBatch`), and can answer
// it by replying (parentMessages.ingestInboundEmail → the mentor branch).
//
// READ STATE: the scholar's is their own participant row (`lastReadAt` vs the
// thread's `lastToParentAt`, stamped on staff messages). Staff read state is
// the thread-level TEAM marker `lastReadByTeacherAt` vs `lastParentToTeacherAt`
// (stamped on scholar messages) — the same shared marker family threads use.
// Staff act as a team; giving a teacher a participant row just to hold a read
// marker would make them a NAMED mentor (emails, facepile), which it must not.
//
// The tutor, observer and staff aide never read these threads.
//
// Viewer is derived server-side from the caller: a scholar-role caller is the
// "scholar" viewer (own threads only); a staff caller is the "staff" viewer.
// Response shapes deliberately MIRROR parentMessages.getThread /
// getThreadAttachments so components/messaging/MessageRow.tsx renders both.

import { v } from "convex/values";
import { authedMutation, authedQuery } from "./lib/customFunctions";
import { getActiveOverlay } from "./lib/auth";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import {
  MAX_BODY,
  appendMessage,
  attachmentPreview,
  createThread,
  editMessageBody,
  ensureThreadParticipants,
  isRetractedMessage,
  messageSentAt,
  prepareAttachments,
  previewOf,
  retractMessageAndAttachments,
  retractOneAttachment,
  userDisplayName,
  type PreparedAttachment,
} from "./parentMessages";
import {
  isPlatformAdminUser,
  isTeamForInstitution,
  scholarForThread,
  markStaffRead,
  scholarThreadAccess,
  type ScholarThreadAccess,
  scholarThreadInstitutionId,
  staffCanReachScholar,
  teachesAtInstitution,
  teachingInstitutionIds,
  threadKind,
} from "./lib/scholarThreadAccess";
import {
  hasActiveStaffMembershipAtInstitution,
  hasAnySchoolOperationsAccess,
  liveSchoolOperationsInstitutionIds,
  mentorCoversScholar,
  mentorInstitutionIds,
  staffCapabilityInstitutionIds,
} from "./lib/staffCapabilities";
import { resolveInstitutionLens } from "./lib/institutionLens";
import { scholarIdsForInstitution } from "./lib/scholarEnrollment";
import { ROLES, isScholarAdminRole } from "./lib/roles";
import { messageEditableUntil } from "../shared/messageEditWindow";
import { previewableMessageLink } from "../lib/messageLinks";
import {
  fromHeader,
  neutralFromHeader,
  renderMentorDigest,
  replyAddressForThread,
  sendParentEmail,
} from "./lib/parentMessageEmail";
import { appBaseUrlOrNull } from "./lib/deploymentConfig";
import { isScholarWithinAideLens } from "./scholarSuggestions";

export type ScholarThreadKind = "mentor" | "workshop";
export type ScholarThreadViewer = "scholar" | "staff";

/** One row in a thread list (scholar Messages or the staff inbox). */
export type ScholarThreadSummary = {
  _id: Id<"parentThreads">;
  kind: ScholarThreadKind;
  /** Scholar viewer: the counterpart (the mentor's name / "The Rabbithole team").
   *  Staff viewer: the scholar's name. */
  title: string;
  /** Workshop: the idea title. Mentor: null. */
  suggestionTitle: string | null;
  suggestionId: Id<"scholarSuggestions"> | null;
  scholarId: Id<"users">;
  scholarName: string;
  /** Named staff participants (mentors), for the staff facepile. */
  staffParticipants: { _id: Id<"users">; name: string; image: string | null }[];
  lastMessagePreview: string; // "" when the thread has no messages yet
  /** "You" when the caller wrote it, else the author's display name. */
  lastMessageAuthorName: string | null;
  lastMessageAt: number;
  /** Workshop: the team opened it (no idea behind it). */
  startedByStaff: boolean;
  /** startedByStaff threads: who sent the opening message; null otherwise. */
  startedByName: string | null;
  /** Workshop threads with no idea: the first line of the opening message. */
  topic: string | null;
  unread: boolean;
};

export type ScholarThreadMessage = {
  _id: Id<"parentMessages">;
  authorType: "scholar" | "teacher";
  authorName: string;
  authorUserId: Id<"users"> | null;
  mine: boolean;
  body: string; // "" when retracted
  createdAt: number;
  editedAt: number | null;
  retracted: boolean;
  /** When the caller's own live message stops being editable/withdrawable;
   *  null when it never was (someone else's, withdrawn, an idea's opening).
   *  A timestamp, not a flag: this query doesn't re-run as time passes, so
   *  clients run the clock against it (shared/messageEditWindow.ts). */
  editableUntil: number | null;
  /** DEPRECATED (TRA-418) — `editableUntil !== null`, no clock. iPad builds
   *  released before `editableUntil` AND it with their own window check. */
  canEdit: boolean;
  /** Staff viewer: the transport it was written through ("via Slack"). Null
   *  for the scholar viewer — a kid doesn't need to know. */
  source: "slack" | null;
  /** Staff viewer only: the original text of a withdrawn message (the open
   *  door — adults can always see what was said). Null for scholars and for
   *  messages that were not withdrawn. */
  withdrawnOriginal: string | null;
  /** Own message already copied outside Rabbithole (a mentor email went out,
   *  or it was posted to a Workshop Slack thread) — withdrawing can't recall
   *  those copies, so the UI must say so. */
  copiedOutside: boolean;
};

export type ScholarThreadDetail = {
  _id: Id<"parentThreads">;
  kind: ScholarThreadKind;
  viewer: ScholarThreadViewer;
  title: string;
  scholarId: Id<"users">;
  scholarName: string;
  suggestion: {
    _id: Id<"scholarSuggestions">;
    title: string;
    scholarWords: string;
    archived: boolean;
  } | null;
  staffParticipants: { _id: Id<"users">; name: string; image: string | null }[];
  /** The open-door line: the scholar always sees it; a staffer outside the
   *  teaching team (a mentor) sees the adult-side version; teachers — who ARE
   *  the open door — see none. */
  openDoorCaption: string | null;
  /** Whether the caller may post here right now. */
  canReply: boolean;
  messages: ScholarThreadMessage[];
};

export type ScholarThreadAttachment = {
  _id: Id<"parentMessageAttachments">;
  messageId: Id<"parentMessages">;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  url: string | null;
  retracted: boolean;
  /** Staff viewers only: an attachment withdrawn by its author (or whose
   *  message was withdrawn) — shown muted, "only staff see this". Scholars
   *  never receive withdrawn rows at all. Same value as `retracted`. */
  withdrawn: boolean;
  /** The caller's own upload on their own message. No clock: the window is
   *  the message's `editableUntil`, which clients check alongside this. */
  canRetract: boolean;
};

export const OPEN_DOOR_CAPTION = "Your teachers can read this conversation.";

/** A mentor is reminded every time that the scholar's teachers can read the
 *  thread too — the same fact the scholar is shown, from the adult side. */
function openDoorCaptionFor(
  access: { viewer: "scholar" | "staff"; asTeam: boolean },
  scholarName: string,
): string | null {
  if (access.viewer === "scholar") return OPEN_DOOR_CAPTION;
  if (access.asTeam) return null;
  const firstName = scholarName.trim().split(/\s+/)[0] || "This scholar";
  return `${firstName}'s teachers can read this conversation.`;
}

/** At most one "a scholar wrote" email per mentor thread per window. */
export const MENTOR_EMAIL_BATCH_MS = 15 * 60 * 1000;

const kindArg = v.optional(v.union(v.literal("mentor"), v.literal("workshop")));

type Ctx = QueryCtx | MutationCtx;
type AuthedCtx = Ctx & { user: Doc<"users"> };
type ScholarMessage = Doc<"parentMessages"> & { authorType: "scholar" | "teacher" };

// ── Shared reads ────────────────────────────────────────────────────────

function isScholarThreadMessage(
  message: Doc<"parentMessages">,
): message is ScholarMessage {
  return message.authorType === "scholar" || message.authorType === "teacher";
}

/** A thread's human messages in send order (`sentAt ?? _creationTime`). */
async function threadMessages(
  ctx: Ctx,
  threadId: Id<"parentThreads">,
): Promise<ScholarMessage[]> {
  const rows = await ctx.db
    .query("parentMessages")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .collect();
  // Stable sort: index order already breaks ties by insertion.
  return rows
    .filter(isScholarThreadMessage)
    .sort(
      (a, b) =>
        messageSentAt(a) - messageSentAt(b) ||
        // An idea's opening leads any message sharing its timestamp.
        Number(b.isIdeaOpening === true) - Number(a.isIdeaOpening === true),
    );
}

async function participantRows(ctx: Ctx, threadId: Id<"parentThreads">) {
  return await ctx.db
    .query("parentThreadParticipants")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .collect();
}

/**
 * Named mentors who can STILL reach the thread. A mentor whose grant was
 * revoked keeps their row (history) but drops out of the facepile and the
 * scholar-facing title — the kid shouldn't see a name that can't answer.
 */
async function staffParticipantsOf(
  ctx: Ctx,
  rows: Doc<"parentThreadParticipants">[],
  scholar: Doc<"users">,
  /** Read-only history: judge standing at the thread's STAMPED school (the
   *  scholar has left it), not the scholar's current one. */
  historicalInstitutionId?: Id<"institutions">,
): Promise<{ _id: Id<"users">; name: string; image: string | null }[]> {
  const users = await Promise.all(
    rows
      .filter((row) => row.side === "staff")
      .map((row) => ctx.db.get(row.parentUserId)),
  );
  const reachable: Doc<"users">[] = [];
  for (const user of users) {
    if (!user) continue;
    const standing = historicalInstitutionId
      ? (await isTeamForInstitution(ctx, user, historicalInstitutionId)) ||
        (await mentorInstitutionIds(ctx, user._id)).has(historicalInstitutionId)
      : (await staffCanReachScholar(ctx, user, scholar, "mentor")).ok;
    if (standing) reachable.push(user);
  }
  return reachable
    .map((user) => ({
      _id: user._id,
      name: userDisplayName(user, "Staff"),
      image: user.image ?? null,
    }));
}

function firstLine(body: string): string {
  const line = body.trim().split(/\r?\n/)[0]?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 77).trimEnd()}…` : line;
}

/** The facts every surface derives from one scholar thread. */
export async function scholarThreadFacts(
  ctx: Ctx,
  thread: Doc<"parentThreads">,
) {
  const messages = await threadMessages(ctx, thread._id);
  const visible = messages.filter((message) => !isRetractedMessage(message));
  const rows = await participantRows(ctx, thread._id);
  const scholarRow =
    rows.find(
      (row) => row.side === "scholar" && row.parentUserId === thread.scholarId,
    ) ?? null;
  const lastVisible = visible[visible.length - 1] ?? null;
  const lastStaff = [...visible].reverse().find((m) => m.authorType === "teacher");
  return {
    messages,
    visible,
    rows,
    lastVisible,
    hasStaffMessage: messages.some((message) => message.authorType === "teacher"),
    lastStaffAuthorId: lastStaff?.authorUserId ?? null,
    scholarUnread:
      (thread.lastToParentAt ?? 0) > (scholarRow?.lastReadAt ?? 0),
    staffUnread:
      (thread.lastParentToTeacherAt ?? 0) > (thread.lastReadByTeacherAt ?? 0),
  };
}

// ── Shared writes (also used by scholarSuggestions.ts + migrations.ts) ───

/**
 * The idea's Workshop thread, creating it when missing. A legacy idea (filed
 * before threads) is BACKFILLED on creation: the scholar's words at the idea's
 * time, then its `staffResponse` as ONE staff message at the reply's time. (Not
 * split on blank lines: the dashboard/aide path overwrote the reply wholesale,
 * so a blank line is usually inside one message, and per-turn authors and
 * times were never recorded.) The reply counts as read for the scholar only
 * if the reflection chat had already surfaced it (`responseSeenAt`).
 *
 * A thread belongs to ONE school. If the scholar has moved since the linked
 * thread was opened, that thread is left with its school (its history stays
 * readable there) and a fresh thread is opened at the scholar's current one.
 * Idempotent; `null` only when the scholar has no institution to anchor to.
 */
export async function ensureWorkshopThreadForSuggestion(
  ctx: MutationCtx,
  suggestion: Doc<"scholarSuggestions">,
  now: number,
): Promise<Id<"parentThreads"> | null> {
  const scholar = await ctx.db.get(suggestion.scholarId);
  const institutionId = scholar
    ? await scholarThreadInstitutionId(ctx, scholar)
    : null;
  if (!scholar || !institutionId) return null;

  const linked = suggestion.threadId ? await ctx.db.get(suggestion.threadId) : null;
  if (linked && linked.institutionId === institutionId) return linked._id;
  const previous = await ctx.db
    .query("parentThreads")
    .withIndex("by_suggestion", (q) => q.eq("suggestionId", suggestion._id))
    .collect();
  const current = previous.find((thread) => thread.institutionId === institutionId);
  if (current) {
    await ctx.db.patch(suggestion._id, { threadId: current._id });
    return current._id;
  }
  // Only a never-threaded idea carries legacy history to backfill; a thread
  // reopened after a move starts from the idea itself.
  const legacy = previous.length === 0 && !linked;

  const backfill = suggestion.createdAt < now;
  const threadId = await createThread(ctx, {
    kind: "workshop",
    suggestionId: suggestion._id,
    parentUserIds: [scholar._id],
    scholarId: scholar._id,
    institutionId,
    now: backfill ? suggestion.createdAt : now,
  });
  const participants = [scholar._id];
  const words = suggestion.scholarWords.trim();
  let scholarReadAt: number | undefined;
  if (words) {
    await appendMessage(ctx, {
      threadId,
      parentUserIds: participants,
      authorType: "scholar",
      authorUserId: scholar._id,
      body: words,
      now,
      isIdeaOpening: true,
      ...(backfill ? { sentAt: suggestion.createdAt } : {}),
    });
    scholarReadAt = backfill ? suggestion.createdAt : now;
  }
  let teamReadAt: number | undefined;
  const reply = legacy ? suggestion.staffResponse : undefined;
  if (reply && reply.body.trim()) {
    await appendMessage(ctx, {
      threadId,
      parentUserIds: participants,
      authorType: "teacher",
      authorUserId: reply.authorId,
      body: reply.body.trim(),
      now,
      sentAt: reply.at,
    });
    // A human wrote it, so staff don't wake up to it as new. The scholar has
    // only "seen" it if the reflection chat surfaced it; otherwise it stays
    // unread so their Messages points them at it.
    teamReadAt = reply.at;
    if (
      suggestion.responseSeenAt !== undefined &&
      suggestion.responseSeenAt >= reply.at
    ) {
      scholarReadAt = reply.at;
    }
  }
  const scholarRow = await ctx.db
    .query("parentThreadParticipants")
    .withIndex("by_thread_parent", (q) =>
      q.eq("threadId", threadId).eq("parentUserId", scholar._id),
    )
    .unique();
  if (scholarRow && scholarReadAt !== undefined) {
    await ctx.db.patch(scholarRow._id, { lastReadAt: scholarReadAt });
  }
  if (teamReadAt !== undefined) {
    await ctx.db.patch(threadId, { lastReadByTeacherAt: teamReadAt });
  }
  await ctx.db.patch(suggestion._id, { threadId });
  return threadId;
}

/**
 * A bug-report card created before its words existed (a spoken report) gets
 * the scholar's words once transcription lands — unless the thread already
 * carries a scholar message.
 */
export async function appendScholarWordsIfMissing(
  ctx: MutationCtx,
  suggestion: Doc<"scholarSuggestions">,
): Promise<void> {
  const words = suggestion.scholarWords.trim();
  if (!words) return;
  const now = Date.now();
  const threadId = await ensureWorkshopThreadForSuggestion(ctx, suggestion, now);
  if (!threadId) return;
  // The REPORT's own opening message specifically — a follow-up the scholar
  // added while transcription was pending is not it.
  if (
    ideaOpeningMessage(await threadMessages(ctx, threadId), suggestion, {
      strict: true,
    })
  ) {
    return;
  }
  const rows = await participantRows(ctx, threadId);
  await appendMessage(ctx, {
    threadId,
    parentUserIds: rows.map((row) => row.parentUserId),
    authorType: "scholar",
    authorUserId: suggestion.scholarId,
    body: words,
    now,
    isIdeaOpening: true,
    // It opens the conversation: DISPLAY it at the report's own time, but it
    // arrives now — staff (team marker) see it as new.
    sentAt: suggestion.createdAt,
    unreadAt: now,
  });
  // No read-marker change: this is background transcription, not the scholar
  // reading — a staff reply that arrived meanwhile must stay unread.
}

/**
 * The scholar's words that open an idea/bug card thread. Flagged since
 * 2026-09-26 (and backfilled by the migration + lazily on first touch). An
 * older, unflagged thread's opening is the scholar message whose ORIGINAL
 * text (before any edit) is the idea's words, else the thread's first scholar
 * message — once the words exist at all (a spoken report still awaiting its
 * transcript has no opening yet, so a follow-up is never mistaken for it).
 * `messages` must be in send order.
 */
export function ideaOpeningMessage<M extends Doc<"parentMessages">>(
  messages: M[],
  suggestion: Pick<Doc<"scholarSuggestions">, "scholarWords"> | null,
  /** Words-match only (no "first scholar message" fallback): used when
   *  deciding whether a transcript still needs inserting. */
  opts: { strict?: boolean } = {},
): M | null {
  const flagged = messages.find((message) => message.isIdeaOpening === true);
  if (flagged) return flagged;
  if (!suggestion) return null;
  const words = suggestion.scholarWords.trim();
  if (!words) return null;
  const scholarMessages = messages.filter((message) => message.authorType === "scholar");
  const originalBody = (message: M) => message.editHistory?.[0]?.body ?? message.body;
  return (
    scholarMessages.find((message) => originalBody(message).trim() === words) ??
    (opts.strict ? null : scholarMessages[0]) ??
    null
  );
}

/** Stamp the opening message's flag if a legacy thread lacks it. Idempotent. */
export async function backfillIdeaOpening(
  ctx: MutationCtx,
  thread: Doc<"parentThreads">,
): Promise<boolean> {
  if (!thread.suggestionId) return false;
  const messages = await threadMessages(ctx, thread._id);
  if (messages.some((message) => message.isIdeaOpening === true)) return false;
  const opening = ideaOpeningMessage(messages, await ctx.db.get(thread.suggestionId));
  if (!opening) return false;
  await ctx.db.patch(opening._id, { isIdeaOpening: true });
  return true;
}

async function markScholarRead(
  ctx: MutationCtx,
  threadId: Id<"parentThreads">,
  scholarId: Id<"users">,
  now: number,
) {
  const row = await ctx.db
    .query("parentThreadParticipants")
    .withIndex("by_thread_parent", (q) =>
      q.eq("threadId", threadId).eq("parentUserId", scholarId),
    )
    .unique();
  if (row) {
    await ctx.db.patch(row._id, { lastReadAt: now });
  } else {
    // The scholar IS the thread's participant; restore a missing row.
    await ctx.db.insert("parentThreadParticipants", {
      threadId,
      parentUserId: scholarId,
      side: "scholar",
      lastReadAt: now,
    });
  }
}


/**
 * Post one message into a scholar thread, with every side effect in one place:
 * portal rows, the author's read marker, and — for a SCHOLAR author — the
 * notification to the staff side (mentor email batch, or the idea's #workshop
 * Slack thread). Callers authorize first.
 */
export async function postScholarThreadMessage(
  ctx: MutationCtx,
  args: {
    thread: Doc<"parentThreads">;
    scholar: Doc<"users">;
    authorType: "scholar" | "teacher";
    authorUserId: Id<"users">;
    body: string;
    attachments?: PreparedAttachment[];
    claimOriginalAttachments?: boolean;
    source?: "slack";
    now: number;
    /** A scholar reply that should also reach the idea's Slack thread. */
    notifyStaff?: boolean;
  },
): Promise<Id<"parentMessages">> {
  const rows = await participantRows(ctx, args.thread._id);
  const messageId = await appendMessage(ctx, {
    threadId: args.thread._id,
    parentUserIds: rows.map((row) => row.parentUserId),
    authorType: args.authorType,
    authorUserId: args.authorUserId,
    body: args.body,
    now: args.now,
    attachments: args.attachments,
    claimOriginalAttachments: args.claimOriginalAttachments,
    source: args.source,
  });
  if (args.authorType === "scholar") {
    await markScholarRead(ctx, args.thread._id, args.authorUserId, args.now);
    if (args.notifyStaff !== false) {
      const kind = threadKind(args.thread);
      if (kind === "mentor") {
        await queueMentorEmails(ctx, args.thread, args.scholar, messageId, args.now);
      } else if (kind === "workshop" && args.thread.suggestionId) {
        await ctx.scheduler.runAfter(
          0,
          internal.scholarSuggestions.forwardScholarReplyToSlack,
          { messageId },
        );
      }
    }
  } else {
    const author = await ctx.db.get(args.authorUserId);
    if (author) await markStaffRead(ctx, args.thread, author, args.now);
  }
  return messageId;
}

// ── Mentor email batching ───────────────────────────────────────────────
// A scholar's message queues one `email` delivery per named mentor (never for
// the scholar). The FIRST queued row of a quiet thread schedules the batch at
// `lastStaffEmailAt + 15 min` (or now); later rows ride that pending batch.
// The batch sends everything still queued, and — because a message can land
// between its claim and its finish — re-schedules itself while any row is
// still queued, so the last message of a burst is never dropped.

async function queuedMentorEmailRows(
  ctx: Ctx,
  threadId: Id<"parentThreads">,
): Promise<Doc<"messageDeliveries">[]> {
  const messages = (
    await ctx.db
      .query("parentMessages")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect()
  );
  const rows: Doc<"messageDeliveries">[] = [];
  for (const message of messages) {
    const deliveries = await ctx.db
      .query("messageDeliveries")
      .withIndex("by_message", (q) => q.eq("messageId", message._id))
      .collect();
    rows.push(
      ...deliveries.filter(
        (delivery) => delivery.channel === "email" && delivery.status === "queued",
      ),
    );
  }
  return rows;
}

async function emailableMentor(
  ctx: Ctx,
  userId: Id<"users">,
  scholar: Doc<"users">,
): Promise<Doc<"users"> | null> {
  const user = await ctx.db.get(userId);
  if (!user?.email || user.role === ROLES.SCHOLAR) return null;
  const prefs = await ctx.db
    .query("notificationPrefs")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  if (prefs?.emailEnabled === false) return null;
  if (!(await staffCanReachScholar(ctx, user, scholar, "mentor")).ok) return null;
  return user;
}

async function queueMentorEmails(
  ctx: MutationCtx,
  thread: Doc<"parentThreads">,
  scholar: Doc<"users">,
  messageId: Id<"parentMessages">,
  now: number,
  /** Only these named adults (a staff message that newly names them). */
  onlyRecipients?: Id<"users">[],
): Promise<void> {
  const rows = (await participantRows(ctx, thread._id)).filter(
    (row) =>
      row.side === "staff" &&
      (!onlyRecipients || onlyRecipients.includes(row.parentUserId)),
  );
  const recipients: Id<"users">[] = [];
  for (const row of rows) {
    if (await emailableMentor(ctx, row.parentUserId, scholar)) {
      recipients.push(row.parentUserId);
    }
  }
  if (recipients.length === 0) return;
  // Rows already queued ride the batch that's scheduled for them — unless
  // they are older than two windows, which means that batch never ran (a
  // crashed send); then schedule afresh rather than strand them.
  const queued = await queuedMentorEmailRows(ctx, thread._id);
  const pending =
    queued.length > 0 &&
    Math.min(...queued.map((row) => row._creationTime)) >
      now - 2 * MENTOR_EMAIL_BATCH_MS;
  for (const recipient of recipients) {
    await ctx.db.insert("messageDeliveries", {
      messageId,
      parentUserId: recipient,
      channel: "email",
      status: "queued",
    });
  }
  if (!pending) {
    await scheduleMentorEmailBatch(ctx, thread, now);
  }
}

async function scheduleMentorEmailBatch(
  ctx: MutationCtx,
  thread: Doc<"parentThreads">,
  now: number,
) {
  const delay = Math.max(
    0,
    (thread.lastStaffEmailAt ?? 0) + MENTOR_EMAIL_BATCH_MS - now,
  );
  await ctx.scheduler.runAfter(delay, internal.scholarMessages.sendMentorEmailBatch, {
    threadId: thread._id,
  });
}

type FrozenRequest = {
  idempotencyKey: string;
  from: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
};

type MentorBatch = {
  threadId: Id<"parentThreads">;
  recipients: {
    email: string;
    deliveryIds: Id<"messageDeliveries">[];
    /** The complete request, frozen at the first claim — the action sends it
     *  verbatim, so every re-send is byte-identical under its key. */
    request: FrozenRequest;
  }[];
} | null;

const BATCH_TAG = "batch:";

/** At most this many messages in one email; the rest roll into the next. */
export const MENTOR_EMAIL_MAX_MESSAGES = 20;

type BatchMessage = {
  deliveryId: Id<"messageDeliveries">;
  at: number;
  body: string;
  attachmentNames: string[];
  authorName?: string;
};

/**
 * Render one recipient's email. From: the scholar ("Ana via Rabbithole")
 * when every message is theirs, the staff author when it's one adult's
 * message(s) (a teacher's introduction), else a neutral "Rabbithole".
 */
function renderMentorRequest(args: {
  threadId: Id<"parentThreads">;
  scholarFirstName: string;
  institutionSlug: string | null;
  messages: BatchMessage[];
  idempotencyKey: string;
}): FrozenRequest {
  const base = appBaseUrlOrNull();
  // The staff inbox, on the Scholars kind, at the thread's school lens.
  const params = new URLSearchParams({ kind: "scholars", thread: args.threadId });
  if (args.institutionSlug) params.set("inst", args.institutionSlug);
  const portalUrl = `${base ?? ""}/teacher/messages?${params.toString()}`;
  const replyTo = replyAddressForThread(args.threadId) ?? undefined;
  const ordered = [...args.messages].sort((a, b) => a.at - b.at);
  const { subject, html, text } = renderMentorDigest({
    scholarFirstName: args.scholarFirstName,
    messages: ordered.map(({ body, attachmentNames, authorName }) => ({
      body,
      attachmentNames,
      ...(authorName ? { authorName } : {}),
    })),
    portalUrl,
    canReplyByEmail: !!replyTo,
  });
  const authors = new Set(ordered.map((message) => message.authorName ?? null));
  const onlyAuthor = authors.size === 1 ? [...authors][0] : undefined;
  const from =
    onlyAuthor === null
      ? fromHeader(args.scholarFirstName)
      : onlyAuthor
        ? fromHeader(onlyAuthor)
        : neutralFromHeader();
  return {
    idempotencyKey: args.idempotencyKey,
    from,
    ...(replyTo ? { replyTo } : {}),
    subject,
    html,
    text,
  };
}

/**
 * Claim everything queued for one thread and stamp the batch time.
 *
 * A FRESH claim snapshots each message and renders each recipient's full
 * request, stored on its rows. A RE-claim (a crashed send, or a transient
 * provider rejection) resends the stored request verbatim — unless a message
 * was withdrawn after a DEFINITIVELY rejected attempt (`attempts` ≥ 1: the
 * provider refused it, nothing went out), in which case that message is
 * dropped and the rest re-rendered under a NEW key (a key is never reused for
 * a different email). A crashed send's outcome is unknown, so it is resent
 * byte-identically and the provider dedupes.
 */
export const claimMentorEmailBatch = internalMutation({
  args: { threadId: v.id("parentThreads") },
  handler: async (ctx, { threadId }): Promise<MentorBatch> => {
    const thread = await ctx.db.get(threadId);
    if (!thread || threadKind(thread) !== "mentor") return null;
    // The window is enforced HERE, not just by the schedule: two batch jobs
    // can overlap (a reply's schedule + a finish's reschedule), and claimed
    // rows stay `queued` until the send marks them, so a second claim inside
    // the window must take nothing. Its finish reschedules what's left.
    if (
      thread.lastStaffEmailAt !== undefined &&
      Date.now() - thread.lastStaffEmailAt < MENTOR_EMAIL_BATCH_MS
    ) {
      return null;
    }
    const allQueued = await queuedMentorEmailRows(ctx, threadId);
    if (allQueued.length === 0) return null;
    // Batch membership is FROZEN at claim (the batch key rides in
    // `providerId` until the real provider id replaces it): a stuck batch is
    // re-claimed with exactly its own rows, never topped up with newer ones.
    const stuck = allQueued.filter((row) => row.providerId?.startsWith(BATCH_TAG));
    const reclaiming = stuck.length > 0;
    const batchKey = stuck[0]?.providerId ?? `${BATCH_TAG}${threadId}:${Date.now()}`;
    const queued = reclaiming
      ? stuck.filter((row) => row.providerId === batchKey)
      : allQueued;
    const skip = async (deliveryId: Id<"messageDeliveries">, error: string) =>
      await ctx.db.patch(deliveryId, { status: "skipped", error });
    const scholar = await scholarForThread(ctx, thread);
    if (!scholar) {
      for (const delivery of queued) await skip(delivery._id, "Thread unavailable");
      return null;
    }
    const scholarFirstName = scholar.name?.trim().split(/\s+/)[0] ?? "A scholar";
    const institution = thread.institutionId
      ? await ctx.db.get(thread.institutionId)
      : null;

    const byRecipient = new Map<
      Id<"users">,
      { email: string; messages: BatchMessage[]; frozen: FrozenRequest | null; changed: boolean }
    >();
    for (const delivery of queued) {
      const recipient = await ctx.db.get(delivery.parentUserId);
      const snapshot = delivery.emailSnapshot;
      if (snapshot) {
        // Only a mentor whose access has since ended is dropped outright.
        if (
          !recipient ||
          !(await staffCanReachScholar(ctx, recipient, scholar, "mentor")).ok
        ) {
          await skip(delivery._id, "Mentor access ended");
          continue;
        }
        const entry = byRecipient.get(delivery.parentUserId) ?? {
          email: snapshot.to,
          messages: [],
          frozen: null,
          changed: false,
        };
        // The frozen request lives on ONE row of the recipient's batch.
        if (snapshot.request) entry.frozen = snapshot.request;
        const message = await ctx.db.get(delivery.messageId);
        // Proven unsent: every attempt so far was refused outright. A crashed
        // send (no recorded attempt) or any ambiguous attempt is not proof.
        const definitivelyRejected =
          (delivery.attempts ?? 0) > 0 && delivery.emailAmbiguous !== true;
        if (definitivelyRejected && (!message || isRetractedMessage(message))) {
          await skip(delivery._id, "Message withdrawn before it could be sent");
          entry.changed = true;
          byRecipient.set(delivery.parentUserId, entry);
          continue;
        }
        entry.messages.push({
          deliveryId: delivery._id,
          at: snapshot.at,
          body: snapshot.body,
          attachmentNames: snapshot.attachmentNames,
          ...(snapshot.authorName ? { authorName: snapshot.authorName } : {}),
        });
        byRecipient.set(delivery.parentUserId, entry);
        continue;
      }
      const message = await ctx.db.get(delivery.messageId);
      if (!message || isRetractedMessage(message)) {
        await skip(delivery._id, "Message withdrawn");
        continue;
      }
      const mentor = await emailableMentor(ctx, delivery.parentUserId, scholar);
      if (!mentor?.email) {
        await skip(delivery._id, "Mentor is not reachable by email");
        continue;
      }
      // A burst beyond the cap stays queued (unclaimed) for the next batch.
      if ((byRecipient.get(mentor._id)?.messages.length ?? 0) >= MENTOR_EMAIL_MAX_MESSAGES) {
        continue;
      }
      const attachmentNames = (
        await ctx.db
          .query("parentMessageAttachments")
          .withIndex("by_message", (q) => q.eq("messageId", message._id))
          .collect()
      )
        .filter((attachment) => attachment.retractedAt === undefined)
        .map((attachment) => attachment.fileName);
      const staffAuthor =
        message.authorType === "teacher" && message.authorUserId
          ? await ctx.db.get(message.authorUserId)
          : null;
      const entry = byRecipient.get(mentor._id) ?? {
        email: mentor.email,
        messages: [],
        frozen: null,
        changed: true,
      };
      entry.messages.push({
        deliveryId: delivery._id,
        at: messageSentAt(message),
        body: message.body,
        attachmentNames,
        ...(message.authorType === "teacher"
          ? { authorName: userDisplayName(staffAuthor, "Staff") }
          : {}),
      });
      byRecipient.set(mentor._id, entry);
    }

    const claimedAt = Date.now();
    const recipients: NonNullable<MentorBatch>["recipients"] = [];
    for (const [recipientId, entry] of byRecipient) {
      if (entry.messages.length === 0) continue;
      // Reuse the frozen request unless its content changed; a change always
      // gets a key that was never used before.
      const request =
        entry.frozen && !entry.changed
          ? entry.frozen
          : renderMentorRequest({
              threadId,
              scholarFirstName,
              institutionSlug: institution?.slug ?? null,
              messages: entry.messages,
              idempotencyKey: `mentor-email/${batchKey.slice(BATCH_TAG.length)}/${recipientId}${
                entry.frozen ? `/r${claimedAt}` : ""
              }`,
            });
      for (const [index, message] of entry.messages.entries()) {
        await ctx.db.patch(message.deliveryId, {
          providerId: batchKey,
          emailSnapshot: {
            to: entry.email,
            body: message.body,
            attachmentNames: message.attachmentNames,
            at: message.at,
            ...(message.authorName ? { authorName: message.authorName } : {}),
            // Stored once per recipient batch, not on every row.
            ...(index === 0 ? { request } : {}),
          },
        });
      }
      recipients.push({
        email: entry.email,
        deliveryIds: entry.messages.map((message) => message.deliveryId),
        request,
      });
    }
    if (recipients.length === 0) return null;
    await ctx.db.patch(threadId, { lastStaffEmailAt: claimedAt });
    // Watchdog, committed with the claim: if the send dies before its own
    // finish runs, this finish still sees the rows queued one window later and
    // schedules a batch that re-claims them. On the happy path it finds
    // nothing and does nothing.
    await ctx.scheduler.runAfter(
      MENTOR_EMAIL_BATCH_MS,
      internal.scholarMessages.finishMentorEmailBatch,
      { threadId },
    );
    return { threadId, recipients };
  },
});

/** Anything queued after the claim waits one window, then goes out. */
export const finishMentorEmailBatch = internalMutation({
  args: { threadId: v.id("parentThreads") },
  handler: async (ctx, { threadId }) => {
    const thread = await ctx.db.get(threadId);
    if (!thread) return;
    if ((await queuedMentorEmailRows(ctx, threadId)).length > 0) {
      await scheduleMentorEmailBatch(ctx, thread, Date.now());
    }
  },
});

/** Transient provider failures retry this many times before failing. */
export const MENTOR_EMAIL_MAX_ATTEMPTS = 3;

/**
 * A transient send failure (rate limit, provider 5xx, network): the rows stay
 * `queued` with their frozen batch key + snapshot, so the next batch (the
 * finish/watchdog reschedule, one window later) re-claims and resends the
 * identical payload under the identical idempotency key. Bounded: after
 * MENTOR_EMAIL_MAX_ATTEMPTS they fail for good.
 */
export const deferMentorEmailDeliveries = internalMutation({
  args: {
    deliveryIds: v.array(v.id("messageDeliveries")),
    error: v.string(),
    /** "rejected": the provider provably refused it (nothing went out).
     *  "ambiguous": it may have been accepted (5xx, lost response, network). */
    outcome: v.union(v.literal("rejected"), v.literal("ambiguous")),
  },
  handler: async (ctx, args) => {
    for (const deliveryId of args.deliveryIds) {
      const delivery = await ctx.db.get(deliveryId);
      if (!delivery || delivery.status !== "queued") continue;
      const attempts = (delivery.attempts ?? 0) + 1;
      // Once ANY attempt might have gone out, the batch can only ever be
      // resent verbatim (same request, same key) — never rebuilt.
      const ambiguous = args.outcome === "ambiguous" || delivery.emailAmbiguous === true;
      await ctx.db.patch(
        deliveryId,
        attempts >= MENTOR_EMAIL_MAX_ATTEMPTS
          ? { status: "failed", attempts, error: args.error, emailAmbiguous: ambiguous }
          : { attempts, error: args.error, emailAmbiguous: ambiguous },
      );
    }
  },
});

/**
 * How a failed send should be treated:
 *   "rejected"  — 429: the provider refused it, provably unsent; retry.
 *   "ambiguous" — 5xx or no provider answer (network, lost response): it may
 *                 have been accepted; retry only byte-identically.
 *   "permanent" — any other provider 4xx: fail now.
 */
export function emailFailureKind(
  error: unknown,
): "rejected" | "ambiguous" | "permanent" {
  const message = error instanceof Error ? error.message : String(error);
  const status = /Resend send failed \((\d+)\)/.exec(message)?.[1];
  if (!status) return "ambiguous";
  const code = Number(status);
  if (code === 429) return "rejected";
  return code >= 500 ? "ambiguous" : "permanent";
}

export const markMentorEmailDeliveries = internalMutation({
  args: {
    deliveryIds: v.array(v.id("messageDeliveries")),
    status: v.union(v.literal("sent"), v.literal("failed"), v.literal("skipped")),
    providerId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    for (const deliveryId of args.deliveryIds) {
      const delivery = await ctx.db.get(deliveryId);
      if (!delivery || delivery.status !== "queued") continue;
      await ctx.db.patch(deliveryId, {
        status: args.status,
        providerId: args.providerId,
        error: args.error,
      });
    }
  },
});

export const sendMentorEmailBatch = internalAction({
  args: { threadId: v.id("parentThreads") },
  handler: async (ctx, { threadId }) => {
    const batch: MentorBatch = await ctx.runMutation(
      internal.scholarMessages.claimMentorEmailBatch,
      { threadId },
    );
    try {
    if (batch) {
      for (const recipient of batch.recipients) {
        const { request } = recipient;
        let providerId: string | null;
        try {
          providerId = await sendParentEmail({
            to: [recipient.email],
            from: request.from,
            replyTo: request.replyTo,
            subject: request.subject,
            html: request.html,
            text: request.text,
            idempotencyKey: request.idempotencyKey,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const kind = emailFailureKind(error);
          if (kind === "permanent") {
            await ctx.runMutation(internal.scholarMessages.markMentorEmailDeliveries, {
              deliveryIds: recipient.deliveryIds,
              status: "failed",
              error: message,
            });
          } else {
            await ctx.runMutation(internal.scholarMessages.deferMentorEmailDeliveries, {
              deliveryIds: recipient.deliveryIds,
              error: message,
              outcome: kind,
            });
          }
          continue;
        }
        // Recording the outcome is OUTSIDE the send's catch: if this write
        // fails, the rows simply stay claimed and the watchdog re-sends the
        // identical request under the identical key (the provider dedupes) —
        // a persistence failure is never mistaken for a provider rejection.
        await ctx.runMutation(internal.scholarMessages.markMentorEmailDeliveries, {
          deliveryIds: recipient.deliveryIds,
          status: providerId ? "sent" : "skipped",
          providerId: providerId ?? undefined,
          ...(providerId ? {} : { error: "Email is not configured" }),
        });
      }
    }
    } finally {
      // Always look for rows that arrived (or were left) after the claim.
      await ctx.runMutation(internal.scholarMessages.finishMentorEmailBatch, {
        threadId,
      });
    }
  },
});

// ── Access (file-local wrappers the handlers call) ──────────────────────

async function requireThreadAccess(
  ctx: AuthedCtx,
  threadId: Id<"parentThreads">,
  mode: "read" | "write" = "write",
) {
  const thread = await ctx.db.get(threadId);
  if (!thread) throw new Error("Conversation not found");
  const access = await scholarThreadAccess(ctx, ctx.user, thread);
  // Tenancy: scholarThreadAccess only succeeds when the thread's stamped
  // institution is its scholar's live institution; re-assert the stamp here.
  if (!access || access.institutionId !== thread.institutionId) {
    throw new Error("Conversation not found");
  }
  if (mode === "write" && access.readOnly) {
    // History from a school the scholar has left: readable, never writable.
    throw new Error("This conversation is read-only — the scholar has moved schools");
  }
  return { thread, access };
}

/** May this STAFF caller open (or post in) a thread of `kind` with `scholarId`? */
async function requireStaffReach(
  ctx: AuthedCtx,
  scholarId: Id<"users">,
  kind: ScholarThreadKind,
): Promise<{
  scholar: Doc<"users">;
  institutionId: Id<"institutions">;
  asTeam: boolean;
}> {
  if (ctx.user.role === ROLES.SCHOLAR) {
    throw new Error("Forbidden: only staff can start a conversation");
  }
  const scholar = await ctx.db.get(scholarId);
  const institutionId =
    scholar && (await scholarThreadInstitutionId(ctx, scholar));
  if (!scholar || !institutionId) throw new Error("Scholar not found");
  const reach = await staffCanReachScholar(ctx, ctx.user, scholar, kind);
  if (!reach.ok) throw new Error("Scholar not found");
  return { scholar, institutionId, asTeam: reach.asTeam };
}

function validatedBody(raw: string, attachments: PreparedAttachment[]): string {
  const body = raw.trim();
  if (!body && attachments.length === 0) throw new Error("Message is empty");
  if (body.length > MAX_BODY) throw new Error("Message is too long");
  return body;
}

// ── Summaries ───────────────────────────────────────────────────────────

async function summarize(
  ctx: AuthedCtx,
  thread: Doc<"parentThreads">,
  access: ScholarThreadAccess,
): Promise<ScholarThreadSummary> {
  const { viewer, scholar } = access;
  const facts = await scholarThreadFacts(ctx, thread);
  const kind = threadKind(thread) as ScholarThreadKind;
  const staffParticipants = await staffParticipantsOf(
    ctx,
    facts.rows,
    scholar,
    access.readOnly ? access.institutionId : undefined,
  );
  const suggestion = thread.suggestionId
    ? await ctx.db.get(thread.suggestionId)
    : null;
  const authorCache = new Map<Id<"users">, Doc<"users"> | null>();
  const authorName = async (message: ScholarMessage) => {
    if (!message.authorUserId) {
      return message.authorType === "scholar" ? "Scholar" : "Staff";
    }
    if (!authorCache.has(message.authorUserId)) {
      authorCache.set(message.authorUserId, await ctx.db.get(message.authorUserId));
    }
    return userDisplayName(
      authorCache.get(message.authorUserId) ?? null,
      message.authorType === "scholar" ? "Scholar" : "Staff",
    );
  };
  const last = facts.lastVisible;
  const lastAttachments = last
    ? (
        await ctx.db
          .query("parentMessageAttachments")
          .withIndex("by_message", (q) => q.eq("messageId", last._id))
          .collect()
      ).filter((attachment) => attachment.retractedAt === undefined)
    : [];
  const opening = facts.messages[0] ?? null;
  // A named adult's unread is their own; the teaching team shares one marker.
  const namedRow =
    viewer === "staff"
      ? facts.rows.find(
          (row) => row.side === "staff" && row.parentUserId === ctx.user._id,
        ) ?? null
      : null;
  const startedByStaff =
    kind === "workshop" && !thread.suggestionId && opening?.authorType === "teacher";
  // Title fallback for a thread with no (reachable) named mentor: the first
  // staff author who can STILL answer — never a lapsed mentor's name.
  let firstStaff: ScholarMessage | undefined;
  if (viewer === "scholar" && kind === "mentor" && staffParticipants.length === 0) {
    for (const message of facts.messages) {
      if (message.authorType !== "teacher" || !message.authorUserId) continue;
      const author = await ctx.db.get(message.authorUserId);
      if (author && (await staffCanReachScholar(ctx, author, scholar, "mentor")).ok) {
        firstStaff = message;
        break;
      }
    }
  }
  const scholarName = userDisplayName(scholar, "Scholar");
  const title =
    viewer === "staff"
      ? scholarName
      : kind === "workshop"
        ? "The Rabbithole team"
        : staffParticipants.length > 0
          ? staffParticipants.map((participant) => participant.name).join(", ")
          : firstStaff
            ? await authorName(firstStaff)
            : "Your teachers";
  return {
    _id: thread._id,
    kind,
    title,
    suggestionTitle: suggestion?.title ?? null,
    suggestionId: thread.suggestionId ?? null,
    scholarId: scholar._id,
    scholarName,
    staffParticipants,
    lastMessagePreview: last
      ? previewOf(last.body) || attachmentPreview(lastAttachments)
      : facts.messages.length > 0
        ? "Message withdrawn"
        : "",
    lastMessageAuthorName: last
      ? last.authorUserId === ctx.user._id
        ? "You"
        : await authorName(last)
      : null,
    lastMessageAt: thread.lastMessageAt,
    startedByStaff,
    startedByName: startedByStaff && opening ? await authorName(opening) : null,
    // Never from a withdrawn message: the first line of the first message
    // still standing, else a neutral label.
    topic:
      kind === "workshop" && !thread.suggestionId && opening
        ? (facts.visible[0] && firstLine(facts.visible[0].body)) ||
          "A message from the team"
        : null,
    unread:
      viewer === "scholar"
        ? facts.scholarUnread
        : namedRow
          ? facts.visible.some(
              (message) =>
                message.authorUserId !== ctx.user._id &&
                // Arrival, not display time: a late transcript shown at the
                // report's original time is still new to a named adult.
                message._creationTime > (namedRow.lastReadAt ?? 0),
            )
          : facts.staffUnread,
  };
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * The MESSAGING lens: the schools where the caller can do scholar messaging —
 * teaching institutions ∪ live mentor-grant institutions (every live school
 * for a platform admin; teaching only with `teachingOnly`). The general
 * institution lens deliberately ignores mentor standing (it must not hand a
 * mentor a roster), so it can't answer "which school's messages" by itself.
 *
 * `institutionScope`: absent or "all" = every messaging school; "" (home) =
 * the caller's lens home when it's a messaging school, every messaging school
 * when the caller has no lens home (a mentor-only staffer), else NONE; a slug
 * or id = that school if it's a messaging school, else NONE. It never falls
 * back to "all candidates" for a school the caller picked.
 */
async function messagingScope(
  ctx: AuthedCtx,
  user: Doc<"users">,
  institutionScope: string | undefined,
  opts: { teachingOnly?: boolean } = {},
): Promise<{
  ids: Id<"institutions">[];
  all: Id<"institutions">[];
  admin: boolean;
  teaching: Set<Id<"institutions">>;
}> {
  const admin = await isPlatformAdminUser(ctx, user);
  const teaching = await teachingInstitutionIds(ctx, user._id);
  const live = (await ctx.db.query("institutions").collect()).filter(
    (institution) => institution.disabledAt === undefined,
  );
  const candidates = new Set<Id<"institutions">>(
    admin
      ? live.map((institution) => institution._id)
      : [
          ...teaching,
          ...(opts.teachingOnly ? [] : await mentorInstitutionIds(ctx, user._id)),
        ],
  );
  const all = [...candidates];
  const requested = institutionScope?.trim();
  const result = (ids: Id<"institutions">[]) => ({ ids, all, admin, teaching });
  if (requested === undefined || requested === "all") return result(all);
  if (requested === "" || requested === "primary") {
    const lens = await resolveInstitutionLens(ctx, user, requested);
    const home = lens.institution?._id;
    if (!home) return result(all);
    return result(candidates.has(home) ? [home] : []);
  }
  const picked = live.find(
    (institution) => institution.slug === requested || institution._id === requested,
  );
  return result(picked && candidates.has(picked._id) ? [picked._id] : []);
}

/**
 * The caller's scholar↔staff threads, newest first.
 * Scholar: own mentor + workshop threads (ignores filter/institutionScope).
 * Staff: threads they can reach, narrowed by `kind` / `filter`
 *   ("mine" = threads where the caller is a named staff participant or has
 *   written a message, plus Workshop ideas no one on staff has picked up yet)
 *   and the `?inst=` lens.
 */
export const listThreads = authedQuery({
  args: {
    kind: kindArg,
    filter: v.optional(
      v.union(v.literal("all"), v.literal("unread"), v.literal("mine")),
    ),
    institutionScope: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ threads: ScholarThreadSummary[]; unreadCount: number }> => {
    const kinds: ScholarThreadKind[] = args.kind ? [args.kind] : ["mentor", "workshop"];
    let candidates: Doc<"parentThreads">[] = [];
    if (ctx.user.role === ROLES.SCHOLAR) {
      candidates = (
        await ctx.db
          .query("parentThreads")
          .withIndex("by_scholar", (q) => q.eq("scholarId", ctx.user._id))
          .collect()
      ).filter((thread) => kinds.includes(threadKind(thread) as ScholarThreadKind));
    } else {
      const byKindInstitution = async (
        kind: ScholarThreadKind,
        institutionId?: Id<"institutions">,
      ) =>
        await ctx.db
          .query("parentThreads")
          .withIndex("by_kind_institution", (q) =>
            institutionId
              ? q.eq("kind", kind).eq("institutionId", institutionId)
              : q.eq("kind", kind),
          )
          .collect();
      const scope = await messagingScope(ctx, ctx.user, args.institutionScope);
      for (const institutionId of scope.ids) {
        // The teaching team reaches both kinds; a mentor-grant school only
        // mentor threads (and within them, only the ones they're named on).
        const teamThere = scope.admin || scope.teaching.has(institutionId);
        for (const kind of kinds) {
          if (kind === "workshop" && !teamThere) continue;
          candidates.push(...(await byKindInstitution(kind, institutionId)));
        }
      }
    }

    const summaries: ScholarThreadSummary[] = [];
    const seen = new Set<Id<"parentThreads">>();
    for (const thread of candidates) {
      if (seen.has(thread._id)) continue;
      seen.add(thread._id);
      const access = await scholarThreadAccess(ctx, ctx.user, thread);
      if (!access) continue;
      const summary = await summarize(ctx, thread, access);
      if (access.viewer === "staff") {
        // "Unread" is the caller's own unread state (named adults have their
        // own marker; teachers share the team marker) — it clears on reading,
        // unlike a "scholar spoke last" rule a closing "thanks!" never leaves.
        if (args.filter === "unread" && !summary.unread) continue;
        if (args.filter === "mine") {
          const facts = await scholarThreadFacts(ctx, thread);
          const named = facts.rows.some(
            (row) => row.side === "staff" && row.parentUserId === ctx.user._id,
          );
          const wrote = facts.messages.some(
            (message) => message.authorUserId === ctx.user._id,
          );
          // An open Workshop idea no one on staff who can still answer has
          // written in or been named on is the whole team's until someone
          // does. Mine is the inbox's default view, so it must not hide a new
          // idea (or one whose only answerer has left) behind "All". An idea
          // the scholar archived, or history from a school they left
          // (replies closed), waits on no one.
          const idea =
            access.kind === "workshop" && !access.readOnly && thread.suggestionId
              ? await ctx.db.get(thread.suggestionId)
              : null;
          let unclaimed = !!idea && idea.archivedAt === undefined;
          if (unclaimed) {
            const staffIds = new Set<Id<"users">>();
            for (const row of facts.rows) {
              if (row.side === "staff") staffIds.add(row.parentUserId);
            }
            for (const message of facts.messages) {
              if (message.authorType === "teacher" && message.authorUserId) {
                staffIds.add(message.authorUserId);
              }
            }
            for (const staffId of staffIds) {
              const person = await ctx.db.get(staffId);
              if (
                person &&
                (await staffCanReachScholar(ctx, person, access.scholar, "workshop"))
                  .ok
              ) {
                unclaimed = false;
                break;
              }
            }
          }
          if (!named && !wrote && !unclaimed) continue;
        }
      }
      summaries.push(summary);
    }
    summaries.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    return {
      threads: summaries,
      unreadCount: summaries.filter((summary) => summary.unread).length,
    };
  },
});

/** Which conversation kinds the caller can see in the staff inbox. */
export const staffAccess = authedQuery({
  args: { institutionScope: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{
    family: boolean; // has school:operations somewhere (existing family inbox)
    mentor: boolean; // teacher/admin, or holds a scholars:mentor grant (in scope)
    workshop: boolean; // teacher/admin (in scope)
    /** Holds a mentor grant but no other staff surface — gets ONLY Messages. */
    mentorOnly: boolean;
    /** May use the staff scholar Search (users.listDirectoryScholars) — the
     *  exact requireScholarAdmin rule, so the UI gates on the real permission. */
    canSearchScholars: boolean;
  }> => {
    if (ctx.user.role === ROLES.SCHOLAR) {
      return {
        family: false,
        mentor: false,
        workshop: false,
        mentorOnly: false,
        canSearchScholars: false,
      };
    }
    const family = !!(await liveSchoolOperationsInstitutionIds(ctx, ctx.user))?.size;
    const scope = await messagingScope(ctx, ctx.user, args.institutionScope);
    const workshop = scope.ids.some(
      (institutionId) => scope.admin || scope.teaching.has(institutionId),
    );
    const mentorGrants = await mentorInstitutionIds(ctx, ctx.user._id);
    const mentorGrant = scope.ids.some((institutionId) => mentorGrants.has(institutionId));
    const otherCapability =
      (await staffCapabilityInstitutionIds(ctx, ctx.user._id)).size > 0;
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", ctx.user._id))
      .collect();
    const onlyBaseStaff = memberships.every(
      (membership) =>
        membership.role === ROLES.STAFF || membership.role === ROLES.PARENT,
    );
    return {
      family,
      mentor: workshop || mentorGrant,
      workshop,
      mentorOnly:
        mentorGrants.size > 0 &&
        !family &&
        scope.teaching.size === 0 &&
        !scope.admin &&
        !otherCapability &&
        onlyBaseStaff &&
        ctx.user.role === ROLES.STAFF,
      canSearchScholars:
        isScholarAdminRole(ctx.user.role) ||
        (await hasAnySchoolOperationsAccess(ctx, ctx.user)),
    };
  },
});

type IncludableRole = "teacher" | "mentor" | "staff";

/**
 * May `user` be NAMED on a mentor thread with this scholar? The teaching team
 * at the scholar's school (a teacher → "teacher", a school admin → "staff";
 * never a system/service account), or a mentor whose live grant covers the
 * scholar ("mentor"). Never a scholar, a guardian, or staff from elsewhere.
 * Returns the role to show, or null.
 */
async function includableRole(
  ctx: Ctx,
  user: Doc<"users"> | null,
  scholar: Doc<"users">,
): Promise<IncludableRole | null> {
  if (!user || user.isSystem === true || user.role === ROLES.SCHOLAR) return null;
  const institutionId = await scholarThreadInstitutionId(ctx, scholar);
  if (!institutionId) return null;
  if (await teachesAtInstitution(ctx, user._id, institutionId)) {
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const teacherThere = memberships.some(
      (membership) =>
        membership.institutionId === institutionId &&
        membership.role === ROLES.TEACHER,
    );
    return teacherThere ? "teacher" : "staff";
  }
  return (await mentorCoversScholar(ctx, user, scholar)) ? "mentor" : null;
}

/**
 * Staff who may be EXPLICITLY named on mentor threads with EVERY one of these
 * scholars — the "Include staff" choices at compose and in "Add people".
 * Candidates pass `includableRole` for each scholar; the caller is excluded.
 * Callable by anyone who may post in mentor threads with all of them
 * (mentors included); otherwise empty. `institutionScope` narrows through the
 * messaging lens, like the rest of the inbox.
 */
export const listIncludableStaff = authedQuery({
  args: {
    scholarIds: v.array(v.id("users")),
    institutionScope: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    { _id: Id<"users">; name: string; image: string | null; role: IncludableRole }[]
  > => {
    if (ctx.user.role === ROLES.SCHOLAR) return [];
    const scholarIds = [...new Set(args.scholarIds)];
    if (scholarIds.length === 0) return [];
    const scope = await messagingScope(ctx, ctx.user, args.institutionScope);
    const inScope = new Set(scope.ids);
    const scholars: Doc<"users">[] = [];
    for (const scholarId of scholarIds) {
      const scholar = await ctx.db.get(scholarId);
      const institutionId = scholar
        ? await scholarThreadInstitutionId(ctx, scholar)
        : null;
      if (
        !scholar ||
        !institutionId ||
        !inScope.has(institutionId) ||
        !(await staffCanReachScholar(ctx, ctx.user, scholar, "mentor")).ok
      ) {
        return [];
      }
      scholars.push(scholar);
    }
    // Candidates come from the FIRST scholar's school (every scholar must
    // share it for anyone to qualify for all of them): its teaching team and
    // its mentor-grant holders.
    const institutionId = (await scholarThreadInstitutionId(ctx, scholars[0]))!;
    const candidateIds = new Set<Id<"users">>();
    for (const membership of await ctx.db
      .query("memberships")
      .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
      .collect()) {
      if (
        membership.role === ROLES.TEACHER ||
        membership.role === ROLES.SCHOOL_ADMIN
      ) {
        candidateIds.add(membership.userId);
      }
    }
    for (const grant of await ctx.db
      .query("staffCapabilityGrants")
      .withIndex("by_institution_capability", (q) =>
        q.eq("institutionId", institutionId).eq("capability", "scholars:mentor"),
      )
      .collect()) {
      if (grant.revokedAt === undefined) candidateIds.add(grant.granteeUserId);
    }
    candidateIds.delete(ctx.user._id);
    const result: {
      _id: Id<"users">;
      name: string;
      image: string | null;
      role: IncludableRole;
    }[] = [];
    for (const candidateId of candidateIds) {
      const candidate = await ctx.db.get(candidateId);
      let role: IncludableRole | null = null;
      for (const scholar of scholars) {
        const here = await includableRole(ctx, candidate, scholar);
        if (!here) {
          role = null;
          break;
        }
        role = role ?? here;
      }
      if (candidate && role) {
        result.push({
          _id: candidate._id,
          name: userDisplayName(candidate, "Staff"),
          image: candidate.image ?? null,
          role,
        });
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  },
});

/**
 * Name more adults on an existing mentor thread ("Add people"). The caller
 * must be able to post here (not read-only history); each person must pass
 * the same rule as compose's "Include staff" for the thread's scholar.
 * Idempotent (someone already named is left alone). Newly named adults get
 * the batched email about the latest message, like any newly named adult.
 * The thread's named set changes — future exact-set reuse keys on the new set.
 */
export const addParticipants = authedMutation({
  args: { threadId: v.id("parentThreads"), userIds: v.array(v.id("users")) },
  handler: async (
    ctx,
    args,
  ): Promise<{ _id: Id<"users">; name: string; image: string | null }[]> => {
    const { thread, access } = await requireThreadAccess(ctx, args.threadId);
    if (access.viewer !== "staff" || access.kind !== "mentor") {
      throw new Error("Only staff can add people to a mentor conversation");
    }
    const existing = new Set(
      (await participantRows(ctx, thread._id))
        .filter((row) => row.side === "staff")
        .map((row) => row.parentUserId),
    );
    const toAdd: Id<"users">[] = [];
    for (const userId of new Set(args.userIds)) {
      if (existing.has(userId)) continue;
      if (!(await includableRole(ctx, await ctx.db.get(userId), access.scholar))) {
        throw new Error("That person can't be added to this conversation");
      }
      toAdd.push(userId);
    }
    if (toAdd.length > 0) {
      await ensureThreadParticipants(ctx, thread._id, toAdd, "staff");
      const latest = (await scholarThreadFacts(ctx, thread)).lastVisible;
      if (latest) {
        await queueMentorEmails(
          ctx,
          (await ctx.db.get(thread._id))!,
          access.scholar,
          latest._id,
          Date.now(),
          toAdd,
        );
      }
    }
    return await staffParticipantsOf(
      ctx,
      await participantRows(ctx, thread._id),
      access.scholar,
    );
  },
});

/** Scholars the caller may open a mentor thread with (staff only). */
export const listMessageableScholars = authedQuery({
  args: {
    institutionScope: v.optional(v.string()),
    // "mentor" (default): scholars the caller may open a mentor thread with.
    // "workshop": scholars at schools where the caller is on the TEACHING team
    // (every live school for a platform admin) — who the team may start a
    // Workshop conversation with. A mentor grant never counts here.
    kind: kindArg,
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    { _id: Id<"users">; name: string; image: string | null; institutionName?: string }[]
  > => {
    if (ctx.user.role === ROLES.SCHOLAR) return [];
    const workshop = args.kind === "workshop";
    const scope = await messagingScope(ctx, ctx.user, args.institutionScope, {
      teachingOnly: workshop,
    });
    const institutionIds = scope.ids;
    // Name the school on each row only when the caller messages at several.
    const labelSchools = scope.all.length > 1;
    const result: {
      _id: Id<"users">;
      name: string;
      image: string | null;
      institutionName?: string;
    }[] = [];
    for (const institutionId of institutionIds) {
      const team = await isTeamForInstitution(ctx, ctx.user, institutionId);
      if (
        !team &&
        (workshop ||
          !(await hasActiveStaffMembershipAtInstitution(ctx, ctx.user._id, institutionId)))
      ) {
        continue;
      }
      const institutionName = labelSchools
        ? (await ctx.db.get(institutionId))?.name
        : undefined;
      for (const scholarId of await scholarIdsForInstitution(ctx, institutionId)) {
        const scholar = await ctx.db.get(scholarId);
        if (
          !scholar ||
          scholar.role !== ROLES.SCHOLAR ||
          scholar.institutionId !== institutionId
        ) {
          continue;
        }
        if (team || (!workshop && (await mentorCoversScholar(ctx, ctx.user, scholar)))) {
          result.push({
            _id: scholar._id,
            name: userDisplayName(scholar, "Scholar"),
            image: scholar.image ?? null,
            ...(institutionName ? { institutionName } : {}),
          });
        }
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const getThread = authedQuery({
  args: { threadId: v.id("parentThreads") },
  handler: async (ctx, args): Promise<ScholarThreadDetail | null> => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) return null;
    const access = await scholarThreadAccess(ctx, ctx.user, thread);
    if (!access || access.institutionId !== thread.institutionId) {
      return null;
    }
    const facts = await scholarThreadFacts(ctx, thread);
    const summary = await summarize(ctx, thread, access);
    const suggestion = thread.suggestionId
      ? await ctx.db.get(thread.suggestionId)
      : null;
    // An idea/bug card's opening message IS the idea: never editable or
    // withdrawable (the scholar archives the idea instead).
    const openingId = thread.suggestionId
      ? ideaOpeningMessage(facts.messages, suggestion)?._id ?? null
      : null;
    const authors = new Map<Id<"users">, Doc<"users"> | null>();
    for (const message of facts.messages) {
      if (message.authorUserId && !authors.has(message.authorUserId)) {
        authors.set(message.authorUserId, await ctx.db.get(message.authorUserId));
      }
    }
    // Own messages already copied outside Rabbithole: a mentor email went
    // out, it was posted into a Workshop Slack thread, or it was written in
    // Slack in the first place. Withdrawing can't recall those copies.
    const copiedOutside = new Set<Id<"parentMessages">>();
    for (const message of facts.messages) {
      if (message.authorUserId !== ctx.user._id) continue;
      if (message.source === "slack" || message.copiedToSlackAt !== undefined) {
        copiedOutside.add(message._id);
        continue;
      }
      const emailed = (
        await ctx.db
          .query("messageDeliveries")
          .withIndex("by_message", (q) => q.eq("messageId", message._id))
          .collect()
      ).some(
        (delivery) =>
          delivery.channel === "email" &&
          (delivery.status === "sent" ||
            delivery.status === "delivered" ||
            // Claimed and attempted but unresolved: it may already be out,
            // so say so (the conservative answer for a withdraw warning).
            (delivery.status === "queued" &&
              delivery.providerId?.startsWith(BATCH_TAG) === true)),
      );
      if (emailed) copiedOutside.add(message._id);
    }
    return {
      _id: thread._id,
      kind: access.kind,
      viewer: access.viewer,
      title: summary.title,
      scholarId: access.scholar._id,
      scholarName: summary.scholarName,
      suggestion: suggestion
        ? {
            _id: suggestion._id,
            title: suggestion.title,
            scholarWords: suggestion.scholarWords,
            archived: suggestion.archivedAt !== undefined,
          }
        : null,
      staffParticipants: summary.staffParticipants,
      openDoorCaption: openDoorCaptionFor(access, summary.scholarName),
      // False only for read-only history from a school the scholar left.
      // False under a view-as overlay too: writes are refused there (the
      // authedMutation read-only gate), so the composer must not offer one.
      canReply: !access.readOnly && !(await getActiveOverlay(ctx)),
      messages: facts.messages.map((message) => {
        const retracted = isRetractedMessage(message);
        const mine = message.authorUserId === ctx.user._id;
        const editableUntil =
          mine && !retracted && message._id !== openingId
            ? messageEditableUntil(messageSentAt(message))
            : null;
        return {
          _id: message._id,
          authorType: message.authorType,
          authorName: message.authorUserId
            ? userDisplayName(
                authors.get(message.authorUserId) ?? null,
                message.authorType === "scholar" ? "Scholar" : "Staff",
              )
            : message.authorType === "scholar"
              ? "Scholar"
              : "Staff",
          authorUserId: message.authorUserId ?? null,
          mine,
          body: retracted ? "" : message.body,
          createdAt: messageSentAt(message),
          editedAt: message.editedAt ?? null,
          retracted,
          editableUntil,
          canEdit: editableUntil !== null,
          source: access.viewer === "staff" ? message.source ?? null : null,
          // The open door: adults can always see what was said; the scholar
          // sees only the tombstone.
          withdrawnOriginal:
            retracted && access.viewer === "staff" ? message.body : null,
          copiedOutside: copiedOutside.has(message._id),
        };
      }),
    };
  },
});

export const getThreadAttachments = authedQuery({
  args: { threadId: v.id("parentThreads") },
  handler: async (ctx, args): Promise<ScholarThreadAttachment[]> => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) return [];
    const access = await scholarThreadAccess(ctx, ctx.user, thread);
    if (!access || access.institutionId !== thread.institutionId) {
      return [];
    }
    const attachments = await ctx.db
      .query("parentMessageAttachments")
      .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
      .collect();
    const result: ScholarThreadAttachment[] = [];
    for (const attachment of attachments) {
      if (!attachment.messageId) continue;
      const message = await ctx.db.get(attachment.messageId);
      if (!message) continue;
      const withdrawn =
        attachment.retractedAt !== undefined || isRetractedMessage(message);
      // The open door: staff still see what was withdrawn; the scholar never
      // receives a withdrawn attachment.
      if (withdrawn && access.viewer !== "staff") continue;
      result.push({
        _id: attachment._id,
        messageId: attachment.messageId,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        url: await ctx.storage.getUrl(attachment.storageId),
        retracted: withdrawn,
        withdrawn,
        canRetract:
          !withdrawn &&
          message.authorUserId === ctx.user._id &&
          attachment.uploaderId === ctx.user._id,
      });
    }
    return result;
  },
});

/**
 * Staff only: send one message to each scholar as its OWN mentor thread
 * (reusing an existing mentor thread with that scholar when there is one).
 * `staffIds` names more adults on each thread (a teacher introducing a
 * mentor, a mentor including a teacher) — each must pass the "Include staff"
 * rule (`listIncludableStaff`) for every selected scholar. The caller is
 * always named.
 */
export const startMentorThreads = authedMutation({
  args: {
    scholarIds: v.array(v.id("users")),
    body: v.string(),
    attachmentIds: v.optional(v.array(v.id("parentMessageAttachments"))),
    staffIds: v.optional(v.array(v.id("users"))),
  },
  handler: async (ctx, args): Promise<{ threadIds: Id<"parentThreads">[] }> => {
    const scholarIds = [...new Set(args.scholarIds)];
    if (scholarIds.length === 0) throw new Error("Choose at least one scholar");
    // Validate EVERY target before the first write: a bulk send must never
    // turn into a partial delivery staff can't see or correct.
    const targets: {
      scholar: Doc<"users">;
      institutionId: Id<"institutions">;
      asTeam: boolean;
    }[] = [];
    for (const scholarId of scholarIds) {
      targets.push(await requireStaffReach(ctx, scholarId, "mentor"));
    }
    const staffIds = [...new Set(args.staffIds ?? [])].filter(
      (userId) => userId !== ctx.user._id,
    );
    const mentors: Doc<"users">[] = [];
    for (const staffId of staffIds) {
      const person = await ctx.db.get(staffId);
      for (const { scholar } of targets) {
        // Same rule as the "Include staff" picker, for EVERY selected scholar.
        if (!(await includableRole(ctx, person, scholar))) {
          throw new Error(
            `${userDisplayName(person, "That person")} can't be included for every selected scholar`,
          );
        }
      }
      mentors.push(person!);
    }
    const attachments = await prepareAttachments(
      ctx,
      args.attachmentIds,
      ctx.user._id,
      targets.length === 1 ? targets[0].scholar._id : undefined,
    );
    const body = validatedBody(args.body, attachments);

    const now = Date.now();
    const threadIds: Id<"parentThreads">[] = [];
    // A mentor conversation is the scholar PLUS the named adults in it, and
    // the adult who opens it is always named (a teacher included), so the kid
    // sees who they're talking to. Reuse a thread only when that set matches
    // exactly — otherwise a teacher's note would land inside a mentor's
    // conversation with the scholar (or vice versa). Teachers still reach
    // every thread by rule; being named is about who the conversation is WITH.
    const named = [...new Set([ctx.user._id, ...mentors.map((mentor) => mentor._id)])];
    const namedKey = [...named].sort().join(",");
    for (const [index, { scholar, institutionId }] of targets.entries()) {
      const candidates = (
        await ctx.db
          .query("parentThreads")
          .withIndex("by_scholar", (q) => q.eq("scholarId", scholar._id))
          .collect()
      )
        .filter(
          (thread) =>
            threadKind(thread) === "mentor" &&
            thread.institutionId === institutionId,
        )
        .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
      let existing: Doc<"parentThreads"> | undefined;
      for (const thread of candidates) {
        const staffKey = (
          await ctx.db
            .query("parentThreadParticipants")
            .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
            .collect()
        )
          .filter((row) => row.side === "staff")
          .map((row) => row.parentUserId)
          .sort()
          .join(",");
        if (staffKey === namedKey) {
          existing = thread;
          break;
        }
      }
      const threadId =
        existing?._id ??
        (await createThread(ctx, {
          kind: "mentor",
          parentUserIds: [scholar._id],
          scholarId: scholar._id,
          institutionId,
          teacherId: ctx.user._id,
          now,
        }));
      await ensureThreadParticipants(ctx, threadId, named, "staff");
      const thread = (await ctx.db.get(threadId))!;
      const messageId = await postScholarThreadMessage(ctx, {
        thread,
        scholar,
        authorType: "teacher",
        authorUserId: ctx.user._id,
        body,
        attachments,
        claimOriginalAttachments: index === 0,
        now,
      });
      // Adults this message newly NAMES (a teacher introducing a mentor) hear
      // about it the way they hear about a scholar's message — the batched
      // email — or a part-time mentor would never know until the kid replies.
      // A reused thread has exactly this named set already, so only a fresh
      // thread names anyone new; the sender never emails themselves.
      if (!existing) {
        const newlyNamed = named.filter((userId) => userId !== ctx.user._id);
        if (newlyNamed.length > 0) {
          await queueMentorEmails(
            ctx,
            (await ctx.db.get(threadId))!,
            scholar,
            messageId,
            now,
            newlyNamed,
          );
        }
      }
      threadIds.push(threadId);
    }
    return { threadIds };
  },
});

/**
 * Team only (a teacher at the scholar's institution, or a platform admin):
 * open a Workshop conversation with ONE scholar. With `bugReportId` (a report
 * that scholar filed themselves), the message goes into that report's Workshop
 * card thread, creating the thread if it doesn't exist yet. Without it, a new
 * idea-less workshop thread is created (`topic` = the first line).
 */
export const startWorkshopThread = authedMutation({
  args: {
    scholarId: v.id("users"),
    body: v.string(),
    attachmentIds: v.optional(v.array(v.id("parentMessageAttachments"))),
    bugReportId: v.optional(v.id("bugReports")),
  },
  handler: async (ctx, args): Promise<{ threadId: Id<"parentThreads"> }> => {
    const { threadId } = await startWorkshopThreadAs(ctx, args);
    return { threadId };
  },
});

/**
 * The bot transport of `startWorkshopThread` (the `start_workshop_thread`
 * tool in lib/suggestionTools.ts — in-app aide, Slack bot, MCP connector).
 * The bot acts for `callerUserId`, who becomes `ctx.user`, so the SAME
 * `requireStaffReach` gate and posting path run. The aide's institution lens
 * is checked first, fail-closed, with the same "Scholar not found" a
 * nonexistent id gets (no cross-tenant existence oracle).
 */
export const startWorkshopThreadForCaller = internalMutation({
  args: {
    callerUserId: v.id("users"),
    scholarId: v.id("users"),
    body: v.string(),
    // Arrays over the wire — Convex validators can't take a Set.
    allowedScholarIds: v.optional(v.array(v.id("users"))),
    scholarLensResolved: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    threadId: Id<"parentThreads">;
    messageId: Id<"parentMessages">;
    scholarFirstName: string;
    body: string;
    editableUntil: number;
    threadUrl: string;
  }> => {
    const user = await ctx.db.get(args.callerUserId);
    if (!user) throw new Error("Not authenticated");
    const allowed = args.allowedScholarIds
      ? new Set(args.allowedScholarIds)
      : undefined;
    if (!isScholarWithinAideLens(args.scholarId, allowed, args.scholarLensResolved)) {
      throw new Error("Scholar not found");
    }
    const started = await startWorkshopThreadAs(
      { ...ctx, user },
      { scholarId: args.scholarId, body: args.body },
    );
    const institution = await ctx.db.get(started.institutionId);
    const params = new URLSearchParams({
      kind: "workshop",
      thread: started.threadId,
    });
    if (institution?.slug) params.set("inst", institution.slug);
    return {
      threadId: started.threadId,
      messageId: started.messageId,
      scholarFirstName:
        started.scholar.name?.trim().split(/\s+/)[0] || "The scholar",
      body: started.body,
      editableUntil: messageEditableUntil(started.sentAt),
      threadUrl: `${appBaseUrlOrNull() ?? ""}/teacher/messages?${params.toString()}`,
    };
  },
});

/**
 * The ONE Workshop-start path, shared by the web composer
 * (`startWorkshopThread`) and the bot tool (`startWorkshopThreadForCaller`).
 * `ctx.user` is the author; `requireStaffReach` is the authorization and
 * institution boundary for both.
 */
async function startWorkshopThreadAs(
  ctx: AuthedCtx & MutationCtx,
  args: {
    scholarId: Id<"users">;
    body: string;
    attachmentIds?: Id<"parentMessageAttachments">[];
    bugReportId?: Id<"bugReports">;
  },
): Promise<{
  threadId: Id<"parentThreads">;
  messageId: Id<"parentMessages">;
  scholar: Doc<"users">;
  institutionId: Id<"institutions">;
  body: string;
  sentAt: number;
}> {
  const { scholar, institutionId } = await requireStaffReach(
    ctx,
    args.scholarId,
    "workshop",
  );
  const attachments = await prepareAttachments(
    ctx,
    args.attachmentIds,
    ctx.user._id,
    scholar._id,
  );
  const body = validatedBody(args.body, attachments);
  const now = Date.now();

  let threadId: Id<"parentThreads"> | null;
  if (args.bugReportId) {
    const report = await ctx.db.get(args.bugReportId);
    // Only a report THIS scholar filed about their own view has a card.
    if (
      !report ||
      report.actorUserId !== scholar._id ||
      report.actorRole !== ROLES.SCHOLAR ||
      report.viewedUserId !== undefined
    ) {
      throw new Error("Bug report not found");
    }
    const card = await ctx.db
      .query("scholarSuggestions")
      .withIndex("by_bugReport", (q) => q.eq("bugReportId", report._id))
      .first();
    if (!card || card.scholarId !== scholar._id) {
      throw new Error("That report isn't on the scholar's Workshop board");
    }
    threadId = await ensureWorkshopThreadForSuggestion(ctx, card, now);
  } else {
    threadId = await createThread(ctx, {
      kind: "workshop",
      parentUserIds: [scholar._id],
      scholarId: scholar._id,
      institutionId,
      teacherId: ctx.user._id,
      now,
    });
  }
  const thread = threadId ? await ctx.db.get(threadId) : null;
  // Tenancy: the conversation must be anchored at the scholar's own school.
  if (!thread || thread.institutionId !== institutionId) {
    throw new Error("Scholar not found");
  }
  const messageId = await postScholarThreadMessage(ctx, {
    thread,
    scholar,
    authorType: "teacher",
    authorUserId: ctx.user._id,
    body,
    attachments,
    now,
  });
  return { threadId: thread._id, messageId, scholar, institutionId, body, sentAt: now };
}

/** Post in an existing thread (scholar in own thread, or permitted staff). */
export const reply = authedMutation({
  args: {
    threadId: v.id("parentThreads"),
    body: v.string(),
    attachmentIds: v.optional(v.array(v.id("parentMessageAttachments"))),
  },
  handler: async (ctx, args): Promise<{ messageId: Id<"parentMessages"> }> => {
    const { thread, access } = await requireThreadAccess(ctx, args.threadId);
    const attachments = await prepareAttachments(
      ctx,
      args.attachmentIds,
      ctx.user._id,
      // Only staff can pick a portfolio item (the helper re-checks standing).
      access.viewer === "staff" ? access.scholar._id : undefined,
    );
    const body = validatedBody(args.body, attachments);
    const messageId = await postScholarThreadMessage(ctx, {
      thread,
      scholar: access.scholar,
      authorType: access.viewer === "scholar" ? "scholar" : "teacher",
      authorUserId: ctx.user._id,
      body,
      attachments,
      now: Date.now(),
    });
    return { messageId };
  },
});

export const markRead = authedMutation({
  args: { threadId: v.id("parentThreads") },
  handler: async (ctx, args): Promise<null> => {
    const { thread, access } = await requireThreadAccess(ctx, args.threadId, "read");
    const now = Date.now();
    if (access.viewer === "scholar") {
      await markScholarRead(ctx, thread._id, ctx.user._id, now);
    } else {
      await markStaffRead(ctx, thread, ctx.user, now);
    }
    return null;
  },
});

async function ownMessageInScholarThread(
  ctx: MutationCtx & { user: Doc<"users"> },
  messageId: Id<"parentMessages">,
): Promise<Doc<"parentMessages">> {
  const message = await ctx.db.get(messageId);
  if (!message || !isScholarThreadMessage(message)) {
    throw new Error("Message not found");
  }
  const { thread } = await requireThreadAccess(ctx, message.threadId);
  if (thread.suggestionId) {
    // Pin the legacy opening's identity now, before this edit could change
    // the text the fallback matches on.
    await backfillIdeaOpening(ctx, thread);
    const opening = ideaOpeningMessage(
      await threadMessages(ctx, thread._id),
      await ctx.db.get(thread.suggestionId),
    );
    if (opening?._id === message._id) {
      throw new Error(
        "This message is the idea itself — archive the idea instead of changing it",
      );
    }
  }
  return message;
}

/** Own message, within the 10-minute window. Keeps editHistory. */
export const editMessage = authedMutation({
  args: { messageId: v.id("parentMessages"), body: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const message = await ownMessageInScholarThread(ctx, args.messageId);
    await editMessageBody(ctx, message, ctx.user._id, args.body);
    return null;
  },
});

/** Own message, within the 10-minute window. Also retracts its attachments. */
export const retractMessage = authedMutation({
  args: { messageId: v.id("parentMessages") },
  handler: async (ctx, args): Promise<null> => {
    const message = await ownMessageInScholarThread(ctx, args.messageId);
    await retractMessageAndAttachments(ctx, message, ctx.user._id);
    return null;
  },
});

/**
 * The link-preview action's authorization for a message in a scholar thread
 * (the family twin is parentMessages.getMessageLinkPreviewRequest): same
 * access rule as reading the bubble, and only the message's one eligible link.
 */
export const getMessageLinkPreviewRequest = authedQuery({
  args: { messageId: v.id("parentMessages"), url: v.string() },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (
      !message ||
      !isScholarThreadMessage(message) ||
      isRetractedMessage(message)
    ) {
      return null;
    }
    const thread = await ctx.db.get(message.threadId);
    if (!thread) return null;
    const access = await scholarThreadAccess(ctx, ctx.user, thread);
    if (!access || access.institutionId !== thread.institutionId) {
      return null;
    }
    const previewUrl = previewableMessageLink(message.body);
    return previewUrl === args.url
      ? { url: previewUrl, viewerId: ctx.user._id }
      : null;
  },
});

/** Which request query guards a message's link preview (kind only, no content). */
export const isScholarThreadMessageInternal = internalQuery({
  args: { messageId: v.id("parentMessages") },
  handler: async (ctx, { messageId }) => {
    const message = await ctx.db.get(messageId);
    const thread = message ? await ctx.db.get(message.threadId) : null;
    return !!thread && threadKind(thread) !== "family";
  },
});

/**
 * Withdraw one attachment of your own message, within the 10-minute window
 * (the family `retractAttachment` refuses scholar threads).
 */
export const retractAttachment = authedMutation({
  args: { attachmentId: v.id("parentMessageAttachments") },
  handler: async (ctx, args): Promise<null> => {
    const attachment = await ctx.db.get(args.attachmentId);
    if (!attachment?.messageId) {
      throw new Error("Attachment is not part of a sent message");
    }
    const message = await ownMessageInScholarThread(ctx, attachment.messageId);
    await retractOneAttachment(ctx, message, attachment, ctx.user._id);
    return null;
  },
});
