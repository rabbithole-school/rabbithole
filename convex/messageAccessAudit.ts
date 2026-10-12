// Read-only data audit for the message-access spec (TRA-388,
// convex/lib/messageAccessSpec.ts). REPORTS rows that break an access
// invariant — it never fixes anything. Output is ids + invariant names only
// (no names, no message bodies), so a run's output can be pasted into an issue.
//
//   npx convex run messageAccessAudit:run '{}'                  # first call
//   npx convex run messageAccessAudit:run '{"position": <next>}' # until isDone
//
// BOUNDED: each call spends at most a work budget of db rows (threads,
// participants, messages, deliveries, attachments) and stops BETWEEN
// messages, so a single enormous thread is audited across several calls.
// `next` resumes exactly there — { afterThread, inThread: { threadId,
// afterMessage } } — walking both tables by `_creationTime` (no nested
// .paginate(), which Convex allows only once per function). Nothing is
// silently dropped: a per-row cap that is hit is reported as `auditIncomplete`.
//
// Invariants (severity in brackets):
//   scholarParticipantCount    [error] mentor/workshop thread without exactly
//                              one scholar-side participant
//   strayScholarSide           [error] a scholar-side participant who is not
//                              the thread's scholar
//   offPlatformToScholar       [error] an email/sms/whatsapp delivery row whose
//                              recipient is a scholar (kid-safe delivery)
//   namedStaffWithoutStanding  [warn]  a named staff participant who is neither
//                              a teacher/school admin at the thread's school,
//                              a platform admin, nor covered by a live mentor
//                              grant (their row is inert — access re-checks —
//                              but it is a stale name)
//   suggestionScholarMismatch  [error] a workshop thread whose idea belongs to
//                              a different scholar
//   liveAttachmentOnWithdrawnMessage [warn] an attachment row still live on a
//                              withdrawn message (legacy `retracted: true`
//                              rows). Readers hide it since TRA-403; the
//                              row itself is drift worth knowing about
//   transferredHistory         [info]  thread stamped with a school that is no
//                              longer its scholar's (read-only history)

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalQuery, type QueryCtx } from "./_generated/server";
import {
  isPlatformAdminUser,
  scholarThreadInstitutionId,
  teachesAtInstitution,
  threadKind,
} from "./lib/scholarThreadAccess";
import { mentorCoversScholar } from "./lib/staffCapabilities";
import { isRetractedMessage } from "./parentMessages";
import { ROLES } from "./lib/roles";


export type MessageAccessInvariant =
  | "scholarParticipantCount"
  | "strayScholarSide"
  | "offPlatformToScholar"
  | "namedStaffWithoutStanding"
  | "suggestionScholarMismatch"
  | "liveAttachmentOnWithdrawnMessage"
  | "transferredHistory"
  | "auditIncomplete";

export type MessageAccessViolation = {
  invariant: MessageAccessInvariant;
  severity: "error" | "warn" | "info";
  threadId: Id<"parentThreads">;
  kind: "family" | "mentor" | "workshop";
  /** Ids only — never names or message text. */
  detail: Record<string, string | number>;
};

const SEVERITY: Record<MessageAccessInvariant, MessageAccessViolation["severity"]> = {
  scholarParticipantCount: "error",
  strayScholarSide: "error",
  offPlatformToScholar: "error",
  namedStaffWithoutStanding: "warn",
  suggestionScholarMismatch: "error",
  liveAttachmentOnWithdrawnMessage: "warn",
  transferredHistory: "info",
  auditIncomplete: "warn",
};

/** Per-row caps on child tables that are small by construction; hitting one
 *  is REPORTED (auditIncomplete), never silently truncated. */
const PARTICIPANT_CAP = 500;
const PER_MESSAGE_CAP = 500;

type Report = (
  invariant: MessageAccessInvariant,
  detail: MessageAccessViolation["detail"],
) => void;

function reporter(
  out: MessageAccessViolation[],
  thread: Doc<"parentThreads">,
): Report {
  const kind = threadKind(thread);
  return (invariant, detail) =>
    out.push({ invariant, severity: SEVERITY[invariant], threadId: thread._id, kind, detail });
}

/** Thread-level invariants (participants, idea link, stamp). Returns rows read. */
async function auditThreadHeader(
  ctx: QueryCtx,
  thread: Doc<"parentThreads">,
  report: Report,
): Promise<number> {
  const kind = threadKind(thread);
  const rows = await ctx.db
    .query("parentThreadParticipants")
    .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
    .take(PARTICIPANT_CAP + 1);
  if (rows.length > PARTICIPANT_CAP) {
    report("auditIncomplete", { table: "parentThreadParticipants", checked: PARTICIPANT_CAP });
    rows.length = PARTICIPANT_CAP;
  }
  const scholar = thread.scholarId ? await ctx.db.get(thread.scholarId) : null;

  if (kind !== "family") {
    const scholarRows = rows.filter((row) => row.side === "scholar");
    if (scholarRows.length !== 1) {
      report("scholarParticipantCount", { count: scholarRows.length });
    }
    for (const row of scholarRows) {
      if (row.parentUserId !== thread.scholarId) {
        report("strayScholarSide", { userId: row.parentUserId });
      }
    }
    for (const row of rows.filter((r) => r.side === "staff")) {
      const staff = await ctx.db.get(row.parentUserId);
      const standing =
        !!staff &&
        staff.role !== ROLES.SCHOLAR &&
        ((await isPlatformAdminUser(ctx, staff)) ||
          (!!thread.institutionId &&
            (await teachesAtInstitution(ctx, staff._id, thread.institutionId))) ||
          (kind === "mentor" && (await mentorCoversScholar(ctx, staff, scholar))));
      if (!standing) report("namedStaffWithoutStanding", { userId: row.parentUserId });
    }
    if (kind === "workshop" && thread.suggestionId) {
      const suggestion = await ctx.db.get(thread.suggestionId);
      if (suggestion && suggestion.scholarId !== thread.scholarId) {
        report("suggestionScholarMismatch", {
          suggestionId: suggestion._id,
          suggestionScholarId: suggestion.scholarId,
        });
      }
    }
  }

  if (scholar && thread.institutionId) {
    const current =
      kind === "family" ? scholar.institutionId ?? null : await scholarThreadInstitutionId(ctx, scholar);
    if (current !== thread.institutionId) {
      report("transferredHistory", {
        stampedInstitutionId: thread.institutionId,
        currentInstitutionId: current ?? "none",
      });
    }
  }
  return 1 + rows.length;
}

/** One message's delivery + attachment invariants. Returns rows read. */
async function auditMessage(
  ctx: QueryCtx,
  message: Doc<"parentMessages">,
  report: Report,
  roleOf: (userId: Id<"users">) => Promise<string | null>,
): Promise<number> {
  const deliveries = await ctx.db
    .query("messageDeliveries")
    .withIndex("by_message", (q) => q.eq("messageId", message._id))
    .take(PER_MESSAGE_CAP + 1);
  if (deliveries.length > PER_MESSAGE_CAP) {
    report("auditIncomplete", { table: "messageDeliveries", messageId: message._id, checked: PER_MESSAGE_CAP });
    deliveries.length = PER_MESSAGE_CAP;
  }
  for (const delivery of deliveries) {
    if (delivery.channel === "portal") continue;
    if ((await roleOf(delivery.parentUserId)) === ROLES.SCHOLAR) {
      report("offPlatformToScholar", {
        deliveryId: delivery._id,
        messageId: message._id,
        channel: delivery.channel,
        status: delivery.status,
      });
    }
  }
  let attachmentsRead = 0;
  if (isRetractedMessage(message)) {
    const attachments = await ctx.db
      .query("parentMessageAttachments")
      .withIndex("by_message", (q) => q.eq("messageId", message._id))
      .take(PER_MESSAGE_CAP + 1);
    if (attachments.length > PER_MESSAGE_CAP) {
      report("auditIncomplete", { table: "parentMessageAttachments", messageId: message._id, checked: PER_MESSAGE_CAP });
      attachments.length = PER_MESSAGE_CAP;
    }
    attachmentsRead = attachments.length;
    for (const attachment of attachments) {
      if (attachment.retractedAt === undefined) {
        report("liveAttachmentOnWithdrawnMessage", {
          messageId: message._id,
          attachmentId: attachment._id,
        });
      }
    }
  }
  return 1 + deliveries.length + attachmentsRead;
}

export const AUDIT_DEFAULT_BUDGET = 2000;
export const AUDIT_MAX_BUDGET = 8000;
/** Messages fetched per step inside a thread. */
const MESSAGE_STEP = 50;

const positionValidator = v.object({
  /** `_creationTime` of the last thread fully audited (absent = start). */
  afterThread: v.optional(v.number()),
  /** A thread whose messages were only partly audited. */
  inThread: v.optional(
    v.object({ threadId: v.id("parentThreads"), afterMessage: v.number() }),
  ),
});

export type AuditPosition = {
  afterThread?: number;
  inThread?: { threadId: Id<"parentThreads">; afterMessage: number };
};

/**
 * One bounded slice of the audit. Read-only. Pass `next` back as `position`
 * until `isDone`. `truncated` says this call stopped on its work budget (the
 * remainder is in `next`), never that findings were dropped.
 */
export const run = internalQuery({
  args: {
    position: v.optional(positionValidator),
    budget: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const budget = Math.max(1, Math.min(args.budget ?? AUDIT_DEFAULT_BUDGET, AUDIT_MAX_BUDGET));
    const violations: MessageAccessViolation[] = [];
    const roleCache = new Map<Id<"users">, string | null>();
    const roleOf = async (userId: Id<"users">) => {
      if (!roleCache.has(userId)) roleCache.set(userId, (await ctx.db.get(userId))?.role ?? null);
      return roleCache.get(userId) ?? null;
    };
    let work = 0;
    let threadsCompleted = 0;
    let afterThread = args.position?.afterThread;
    let resume = args.position?.inThread;
    // Every call audits at least one unit (a thread header or a message), so
    // any budget — however small — makes progress.
    let progressed = false;

    const done = (next: AuditPosition | null) => {
      const counts: Partial<Record<MessageAccessInvariant, number>> = {};
      for (const violation of violations) {
        counts[violation.invariant] = (counts[violation.invariant] ?? 0) + 1;
      }
      return {
        threadsCompleted,
        work,
        budget,
        counts,
        violations,
        next,
        truncated: next !== null,
        isDone: next === null,
      };
    };

    for (;;) {
      let thread: Doc<"parentThreads"> | null;
      let afterMessage: number | undefined;
      if (resume) {
        thread = await ctx.db.get(resume.threadId);
        afterMessage = resume.afterMessage;
        resume = undefined;
        work += 1;
        // Deleted between calls: carry on after it.
        if (!thread) continue;
      } else {
        if (work >= budget) return done({ ...(afterThread !== undefined ? { afterThread } : {}) });
        const bound = afterThread;
        thread = await ctx.db
          .query("parentThreads")
          .withIndex("by_creation_time", (q) =>
            bound === undefined ? q : q.gt("_creationTime", bound),
          )
          .first();
        if (!thread) return done(null);
        work += await auditThreadHeader(ctx, thread, reporter(violations, thread));
        progressed = true;
      }
      const report = reporter(violations, thread);
      const current = thread;
      for (;;) {
        const since = afterMessage;
        const messages = await ctx.db
          .query("parentMessages")
          .withIndex("by_thread", (q) =>
            since === undefined
              ? q.eq("threadId", current._id)
              : q.eq("threadId", current._id).gt("_creationTime", since),
          )
          .take(MESSAGE_STEP);
        for (const message of messages) {
          if (work >= budget && progressed) {
            return done({
              ...(afterThread !== undefined ? { afterThread } : {}),
              inThread: {
                threadId: current._id,
                afterMessage: afterMessage ?? message._creationTime - 1,
              },
            });
          }
          work += await auditMessage(ctx, message, report, roleOf);
          afterMessage = message._creationTime;
          progressed = true;
        }
        if (messages.length < MESSAGE_STEP) break;
      }
      afterThread = current._creationTime;
      threadsCompleted += 1;
    }
  },
});
