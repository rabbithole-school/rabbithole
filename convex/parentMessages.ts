// Teacher ↔ parent messaging — threads, messages, and per-recipient
// deliveries. The scholar-facing tutor is untouched; this is human staff ↔
// parent communication. See teacher-parent-messaging-plan.
//
// TWO GATES:
//   • Staff (teacher/admin/operations staff) compose + read threads for scholars in
//     their institution context. Platform admins retain global access.
//   • A guardian in the parent surface reads/writes ONLY threads where they
//     have a parentThreadParticipants row, regardless of their primary role.
//
// FAMILY GROUPS. One scholar thread includes all linked guardians. Guardians
// can see the shared conversation and each other by display name; contact
// details remain server-side. A future per-scholar setting may opt a family
// back into separate guardian threads.
//
// OTHER KINDS. The same tables also carry scholar ↔ staff conversations
// (`kind` "mentor" / "workshop", scholarMessages.ts). Every public entry point
// here is FAMILY-ONLY: it refuses a non-family thread, and every family listing
// ignores non-family threads and non-family participant sides (a staffer who is
// also a guardian must never see a mentor thread on their parent surface). The
// engine pieces (attachments, appendMessage, edit/retract, the 10-minute window)
// are shared and exported for scholarMessages.ts.

import { v } from "convex/values";
import {
  authedQuery,
  authedMutation,
} from "./lib/customFunctions";
import { ROLES, isStaffRole } from "./lib/roles";
import { isProgramGuest } from "./lib/enrollmentStanding";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery } from "./_generated/server";
import {
  whatsAppOptInLink,
  isStopKeyword,
  parseOptInToken,
} from "./lib/parentMessageChannels";
import { resolveInstitutionLens } from "./lib/institutionLens";
import { requireGuardianOf } from "./lib/auth";
import {
  hasAnySchoolOperationsAccess,
  hasSchoolOperationsAccessAtInstitution,
} from "./lib/staffCapabilities";
import {
  emailMailboxesMatch,
  emailTaggedMailboxesMatch,
} from "./lib/resendInbound";
import {
  MESSAGE_ATTACHMENT_MAX_BYTES,
  MESSAGE_ATTACHMENT_MAX_COUNT,
  MESSAGE_ATTACHMENT_MAX_TOTAL_BYTES,
  isSupportedMessageAttachment,
  safeMessageAttachmentFileName,
} from "../shared/messageAttachments";
import { messagePlainText, previewableMessageLink } from "../lib/messageLinks";
import { slackTextToMessageBody } from "./lib/slackText";
import {
  editWindowOpen,
  messageEditableUntil,
} from "../shared/messageEditWindow";
import {
  isFamilySide,
  isFamilyThread,
  markStaffRead,
  scholarForThread,
  staffCanReachScholar,
  threadKind,
} from "./lib/scholarThreadAccess";
import {
  attributedScholarIds,
  isAttributedToScholar,
} from "./lib/portfolioAttributions";
import {
  portfolioFamilySharingEligibility,
  portfolioItemContainsIdentifiableMedia,
} from "./lib/schoolMediaConsent";
import { assignmentResolved } from "./lib/portfolioStatus";
import {
  UPLOAD_RESERVATION_TTL_MS,
  attachmentOwnsBlob,
} from "./lib/parentMessageAttachmentStorage";
import type { Id, Doc } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx } from "./_generated/server";

export const MAX_BODY = 8000;

// ctx shape after the authed/teacher custom-function wrappers attach `user`.
type AuthedQueryCtx = QueryCtx & { user: Doc<"users"> };
type AuthedCtx = (QueryCtx | MutationCtx) & { user: Doc<"users"> };
export type PreparedAttachment = Doc<"parentMessageAttachments"> & {
  messageId?: undefined;
  threadId?: undefined;
};

export async function requireSchoolOperationsForScholars(
  ctx: AuthedCtx,
  scholarIds: Iterable<Id<"users">>,
): Promise<void> {
  if (!(await hasAnySchoolOperationsAccess(ctx, ctx.user))) {
    throw new Error("Forbidden: school operations access required");
  }
  for (const scholarId of new Set(scholarIds)) {
    const scholar = await ctx.db.get(scholarId);
    if (
      !scholar?.institutionId ||
      !(await hasSchoolOperationsAccessAtInstitution(
        ctx,
        ctx.user,
        scholar.institutionId,
      ))
    ) {
      throw new Error("Forbidden: scholar is not in your current school context");
    }
  }
}

async function requireSchoolOperationsForParents(
  ctx: AuthedCtx,
  parentIds: Iterable<Id<"users">>,
): Promise<Map<Id<"users">, Id<"institutions">>> {
  if (!(await hasAnySchoolOperationsAccess(ctx, ctx.user))) {
    throw new Error("Forbidden: school operations access required");
  }
  const institutions = new Map<Id<"users">, Id<"institutions">>();
  for (const parentId of new Set(parentIds)) {
    const institutionId = await operationalInstitutionForParent(ctx, parentId);
    if (!institutionId) {
      throw new Error("Forbidden: parent is not in your current school context");
    }
    institutions.set(parentId, institutionId);
  }
  return institutions;
}

async function operationalInstitutionForParent(
  ctx: AuthedCtx,
  parentId: Id<"users">,
): Promise<Id<"institutions"> | null> {
  const guardianships = await ctx.db
    .query("guardianships")
    .withIndex("by_parent", (q) => q.eq("parentUserId", parentId))
    .collect();
  const institutionIds = new Set<Id<"institutions">>();
  for (const guardianship of guardianships) {
    const scholar = await ctx.db.get(guardianship.scholarUserId);
    if (
      scholar?.institutionId &&
      (await hasSchoolOperationsAccessAtInstitution(
        ctx,
        ctx.user,
        scholar.institutionId,
      ))
    ) {
      institutionIds.add(scholar.institutionId);
    }
  }
  if (institutionIds.size !== 1) return null;
  return institutionIds.values().next().value!;
}

async function unambiguousInstitutionForParents(
  ctx: Pick<QueryCtx | MutationCtx, "db">,
  parentIds: Iterable<Id<"users">>,
): Promise<Id<"institutions"> | null> {
  const institutionIds = new Set<Id<"institutions">>();
  for (const parentId of new Set(parentIds)) {
    const guardianships = await ctx.db
      .query("guardianships")
      .withIndex("by_parent", (q) => q.eq("parentUserId", parentId))
      .collect();
    for (const guardianship of guardianships) {
      const institutionId = (await ctx.db.get(guardianship.scholarUserId))
        ?.institutionId;
      if (institutionId) institutionIds.add(institutionId);
    }
  }
  if (institutionIds.size !== 1) return null;
  return institutionIds.values().next().value!;
}

async function legacyParentThreadInstitutionId(
  ctx: QueryCtx | MutationCtx,
  thread: Doc<"parentThreads">,
): Promise<Id<"institutions"> | null> {
  return await unambiguousInstitutionForParents(
    ctx,
    await threadParticipantIds(ctx, thread),
  );
}

async function threadInstitutionId(
  ctx: QueryCtx | MutationCtx,
  thread: Doc<"parentThreads">,
): Promise<Id<"institutions"> | null> {
  if (thread.scholarId) {
    const institutionId = (await ctx.db.get(thread.scholarId))?.institutionId;
    return !institutionId ||
      (thread.institutionId && thread.institutionId !== institutionId)
      ? null
      : institutionId;
  }
  return thread.institutionId ?? (await legacyParentThreadInstitutionId(ctx, thread));
}

export async function canOperateThread(
  ctx: AuthedCtx,
  thread: Doc<"parentThreads">,
): Promise<boolean> {
  return await userCanOperateThread(ctx, ctx.user, thread);
}

/**
 * The staff side of a FAMILY thread: live school:operations at the thread's
 * OWN institution (its stamp; a legacy thread's unambiguous guardian school).
 * Never the scholar's current school — once a scholar moves, `threadInstitutionId`
 * is null and no school's staff reach the old thread. The one rule for the app
 * and every transport (the Slack reply bridge) alike.
 */
export async function userCanOperateThread(
  ctx: QueryCtx | MutationCtx,
  user: Pick<Doc<"users">, "_id" | "role">,
  thread: Doc<"parentThreads">,
): Promise<boolean> {
  if (!isFamilyThread(thread)) return false;
  const institutionId = await threadInstitutionId(ctx, thread);
  return !!(
    institutionId &&
    (await hasSchoolOperationsAccessAtInstitution(ctx, user, institutionId))
  );
}

async function threadBelongsToInstitution(
  ctx: AuthedCtx,
  thread: Doc<"parentThreads">,
  institutionId: Id<"institutions">,
): Promise<boolean> {
  return (await threadInstitutionId(ctx, thread)) === institutionId;
}

async function portfolioAttachmentFamilySharing(
  ctx: Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">,
  item: Doc<"portfolioItems">,
): Promise<{ allowed: boolean; blocker: string | null }> {
  return await portfolioFamilySharingEligibility(
    ctx,
    await attributedScholarIds(ctx, item),
    portfolioItemContainsIdentifiableMedia(item),
  );
}

function isHumanParentMessage(
  message: Doc<"parentMessages">,
): message is Doc<"parentMessages"> & {
  authorType: "teacher" | "parent";
} {
  return message.authorType === "teacher" || message.authorType === "parent";
}

export function isRetractedMessage(
  message: Pick<Doc<"parentMessages">, "retracted" | "retractedAt">,
): boolean {
  return message.retracted === true || message.retractedAt !== undefined;
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function isPortfolioAttachment(
  attachment: Doc<"parentMessageAttachments">,
): boolean {
  return attachment.source === "portfolio";
}

async function deleteAttachmentStorageIfOwned(
  ctx: MutationCtx,
  attachment: Doc<"parentMessageAttachments">,
): Promise<void> {
  if (!(await attachmentOwnsBlob(ctx, attachment))) return;
  const references = await ctx.db
    .query("parentMessageAttachments")
    .withIndex("by_storage", (q) => q.eq("storageId", attachment.storageId))
    .collect();
  if (
    !references.some(
      (row) =>
        row._id !== attachment._id ||
        row.messageId ||
        row.threadId,
    )
  ) {
    await ctx.storage.delete(attachment.storageId);
  }
}

export async function prepareAttachments(
  ctx: MutationCtx & { user: Doc<"users"> },
  attachmentIds: Id<"parentMessageAttachments">[] | undefined,
  uploaderId: Id<"users">,
  portfolioScholarId?: Id<"users">,
): Promise<PreparedAttachment[]> {
  const uniqueIds = [...new Set(attachmentIds ?? [])];
  if (uniqueIds.length !== (attachmentIds?.length ?? 0)) {
    throw new Error("An attachment was selected more than once");
  }
  if (uniqueIds.length > MESSAGE_ATTACHMENT_MAX_COUNT) {
    throw new Error(
      `Attach no more than ${MESSAGE_ATTACHMENT_MAX_COUNT} files to one message`,
    );
  }
  const rows: PreparedAttachment[] = [];
  let totalStorageBytes = 0;
  for (const attachmentId of uniqueIds) {
    const row = await ctx.db.get(attachmentId);
    if (
      !row ||
      row.uploaderId !== uploaderId ||
      row.messageId ||
      row.threadId
    ) {
      throw new Error("Attachment is not available");
    }
    const storage = await ctx.db.system.get("_storage", row.storageId);
    if (!storage) throw new Error("Attachment file is missing");
    if (isPortfolioAttachment(row)) {
      if (!portfolioScholarId) {
        throw new Error("Portfolio attachments require one scholar");
      }
      await requireSchoolOperationsForScholars(ctx, [portfolioScholarId]);
      const item = row.portfolioItemId
        ? await ctx.db.get(row.portfolioItemId)
        : null;
      const attributed =
        item && (await isAttributedToScholar(ctx, item, portfolioScholarId));
      const sharing = item
        ? await portfolioAttachmentFamilySharing(ctx, item)
        : null;
      if (
        !item ||
        !attributed ||
        item.familyVisibility === "staff_only" ||
        !assignmentResolved(item) ||
        item.fileStorageId !== row.storageId ||
        item.processingStatus !== "ready"
      ) {
        throw new Error("Portfolio attachment is not available");
      }
      if (!sharing?.allowed) {
        throw new Error(
          sharing?.blocker ?? "Portfolio attachment is not available",
        );
      }
    }
    totalStorageBytes += storage.size;
    rows.push(row as PreparedAttachment);
  }
  if (totalStorageBytes > MESSAGE_ATTACHMENT_MAX_TOTAL_BYTES) {
    throw new Error("Attachments must total 30 MB or smaller");
  }
  return rows;
}

async function attachUploadsToMessage(
  ctx: MutationCtx,
  attachments: PreparedAttachment[],
  messageId: Id<"parentMessages">,
  threadId: Id<"parentThreads">,
  claimOriginals: boolean,
): Promise<void> {
  for (const attachment of attachments) {
    if (claimOriginals) {
      await ctx.db.patch(attachment._id, { messageId, threadId });
    } else {
      await ctx.db.insert("parentMessageAttachments", {
        messageId,
        threadId,
        storageId: attachment.storageId,
        uploaderId: attachment.uploaderId,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        source: attachment.source,
        portfolioItemId: attachment.portfolioItemId,
        uploadReservedAt: attachment.uploadReservedAt,
      });
    }
  }
}

export function attachmentPreview(
  attachments: Doc<"parentMessageAttachments">[],
): string {
  if (attachments.length === 0) return "";
  if (attachments.length === 1) {
    return attachments[0].mimeType.startsWith("image/")
      ? "Photo"
      : `Attachment: ${attachments[0].fileName}`;
  }
  return `${attachments.length} attachments`;
}

// ── Recipient resolution (guardianship graph) ───────────────────────────

export async function guardianParentsOfScholar(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
): Promise<Id<"users">[]> {
  const links = await ctx.db
    .query("guardianships")
    .withIndex("by_scholar", (q) => q.eq("scholarUserId", scholarId))
    .collect();
  return links.map((l) => l.parentUserId);
}

async function parentRecipientTeachers(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
) {
  await requireGuardianOf(ctx, scholarId);
  const scholar = await ctx.db.get(scholarId);
  if (!scholar || scholar.role !== ROLES.SCHOLAR || !scholar.institutionId) {
    throw new Error("Scholar not found");
  }
  const institution = await ctx.db.get(scholar.institutionId);
  if (!institution || institution.disabledAt) {
    throw new Error("Scholar's school is unavailable");
  }
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_institution", (q) =>
      q.eq("institutionId", scholar.institutionId),
    )
    .collect();
  const teacherMembershipIds = new Set(
    memberships
      .filter((membership) => membership.role === ROLES.TEACHER)
      .map((membership) => membership.userId),
    // System accounts (the institution's MCP teacher service account) hold a
    // teacher membership but nobody reads their messages — dropped below.
  );
  const staffMembershipIds = new Set(
    (
      memberships.filter((membership) => isStaffRole(membership.role))
    )
      .map((membership) => membership.userId),
  );
  const teacherIds = isProgramGuest(scholar)
    ? [
        ...new Set(
          (
            await ctx.db
              .query("scholarGroups")
              .withIndex("by_institution", (q) =>
                q.eq("institutionId", scholar.institutionId),
              )
              .collect()
          )
            .filter((group) => group.scholarIds.includes(scholarId))
            .map((group) => group.ownerId)
            .filter(
              (teacherId): teacherId is Id<"users"> =>
                teacherId !== undefined &&
                staffMembershipIds.has(teacherId),
            ),
        ),
      ]
    : [...teacherMembershipIds];
  const teachers = (
    await Promise.all(teacherIds.map((teacherId) => ctx.db.get(teacherId)))
  ).filter(
    (teacher): teacher is Doc<"users"> => teacher !== null && teacher.isSystem !== true,
  );
  return teachers
    .map((teacher) => ({
      _id: teacher._id,
      name: userDisplayName(teacher, "Teacher"),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A FAMILY thread's guardian participants (non-family sides never count). */
export async function threadParticipantIds(
  ctx: QueryCtx | MutationCtx,
  thread: Doc<"parentThreads">,
): Promise<Id<"users">[]> {
  const rows = (
    await ctx.db
      .query("parentThreadParticipants")
      .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
      .collect()
  ).filter(isFamilySide);
  return rows.length > 0
    ? [...new Set(rows.map((row) => row.parentUserId))]
    : [thread.parentUserId];
}

export async function ensureThreadParticipants(
  ctx: MutationCtx,
  threadId: Id<"parentThreads">,
  parentUserIds: Id<"users">[],
  // Absent = a guardian (family). Scholar threads pass "scholar" / "staff".
  side?: "scholar" | "staff",
): Promise<void> {
  const existing = await ctx.db
    .query("parentThreadParticipants")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .collect();
  const existingIds = new Set(existing.map((row) => row.parentUserId));
  for (const parentUserId of new Set(parentUserIds)) {
    if (!existingIds.has(parentUserId)) {
      await ctx.db.insert("parentThreadParticipants", {
        threadId,
        parentUserId,
        ...(side ? { side } : {}),
      });
    }
  }
}

async function participantRow(
  ctx: QueryCtx | MutationCtx,
  threadId: Id<"parentThreads">,
  parentUserId: Id<"users">,
) {
  return await ctx.db
    .query("parentThreadParticipants")
    .withIndex("by_thread_parent", (q) =>
      q.eq("threadId", threadId).eq("parentUserId", parentUserId),
    )
    .unique();
}

async function markParentRead(
  ctx: MutationCtx,
  thread: Doc<"parentThreads">,
  parentUserId: Id<"users">,
  now: number,
): Promise<void> {
  const row = await participantRow(ctx, thread._id, parentUserId);
  if (row) {
    await ctx.db.patch(row._id, { lastReadAt: now });
  } else if (thread.parentUserId === parentUserId) {
    await ctx.db.patch(thread._id, { lastReadByParentAt: now });
  }
}

/** Is this parent reachable by email right now (has an email + email on)? */
async function emailEligible(
  ctx: QueryCtx | MutationCtx,
  parentUserId: Id<"users">,
): Promise<boolean> {
  const parent = await ctx.db.get(parentUserId);
  if (!parent?.email) return false;
  const prefs = await ctx.db
    .query("notificationPrefs")
    .withIndex("by_user", (q) => q.eq("userId", parentUserId))
    .unique();
  return prefs?.emailEnabled !== false; // default opted-in to email
}

/** The off-portal phone channels (sms/whatsapp) this parent has OPTED INTO. */
async function optedInChannels(
  ctx: QueryCtx | MutationCtx,
  parentUserId: Id<"users">,
): Promise<("sms" | "whatsapp")[]> {
  const rows = await ctx.db
    .query("parentChannelIdentities")
    .withIndex("by_parent", (q) => q.eq("parentUserId", parentUserId))
    .collect();
  const set = new Set<"sms" | "whatsapp">();
  for (const r of rows) {
    if (r.optInAt && r.stopState !== true) set.add(r.channel);
  }
  return [...set];
}

/** Dedupe the parent set addressed by {scholarId | assignmentId | parentIds}. */
async function resolveParentIds(
  ctx: QueryCtx | MutationCtx,
  args: {
    scholarId?: Id<"users">;
    scholarIds?: Id<"users">[];
    assignmentId?: Id<"assignments">;
    parentIds?: Id<"users">[];
    includeProgramGuests?: boolean;
  },
): Promise<{ parentIds: Id<"users">[]; unlinkedScholarNames: string[] }> {
  const set = new Set<string>();
  const unlinked: string[] = [];

  const addScholarGuardians = async (sid: Id<"users">) => {
    const scholar = await ctx.db.get(sid);
    if (isProgramGuest(scholar) && args.includeProgramGuests !== true) return;
    const parents = await guardianParentsOfScholar(ctx, sid);
    if (parents.length === 0) {
      if (scholar) unlinked.push(scholar.name ?? "a scholar");
    }
    parents.forEach((p) => set.add(p));
  };

  if (args.parentIds) for (const id of args.parentIds) set.add(id);
  if (args.scholarId) await addScholarGuardians(args.scholarId);
  if (args.scholarIds) for (const sid of args.scholarIds) await addScholarGuardians(sid);
  if (args.assignmentId) {
    const a = await ctx.db.get(args.assignmentId);
    if (a) for (const sid of a.scholarIds) await addScholarGuardians(sid);
  }

  // A recipient must be a real guardian — defined by the guardianships graph,
  // NOT merely a non-scholar account. The scholar/assignment paths resolve
  // guardians by construction; this ALSO constrains the client-supplied
  // `parentIds` arg (a staff caller could otherwise list any non-scholar user).
  // A guardian may be staff (an operations staffer/admin who is also a parent) — so we
  // authorize on the guardianship, not users.role.
  const parentIds: Id<"users">[] = [];
  for (const id of set) {
    const u = await ctx.db.get(id as Id<"users">);
    if (!u || u.role === ROLES.SCHOLAR) continue;
    const guardian = await ctx.db
      .query("guardianships")
      .withIndex("by_parent", (q) => q.eq("parentUserId", id as Id<"users">))
      .first();
    if (guardian) parentIds.push(id as Id<"users">);
  }
  return { parentIds, unlinkedScholarNames: [...new Set(unlinked)] };
}

export function userDisplayName(user: Doc<"users"> | null, fallback: string): string {
  return user?.name ?? user?.username ?? user?.email ?? fallback;
}

async function childNameForThread(
  ctx: QueryCtx | MutationCtx,
  thread: Doc<"parentThreads">,
): Promise<string | null> {
  if (thread.scholarId) {
    const child = await ctx.db.get(thread.scholarId);
    return userDisplayName(child, "Scholar");
  }
  const links = await ctx.db
    .query("guardianships")
    .withIndex("by_parent", (q) => q.eq("parentUserId", thread.parentUserId))
    .collect();
  if (links.length !== 1) return null;
  const child = await ctx.db.get(links[0].scholarUserId);
  return userDisplayName(child, "Scholar");
}

/**
 * Staff compose preview: the deduped parent list a target resolves to. No
 * address is returned (the staff directory is the place for that); name +
 * email is what teachers already see there.
 */
export const resolveRecipients = authedQuery({
  args: {
    scholarId: v.optional(v.id("users")),
    scholarIds: v.optional(v.array(v.id("users"))),
    assignmentId: v.optional(v.id("assignments")),
    parentIds: v.optional(v.array(v.id("users"))),
    includeProgramGuests: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const scholarIds = new Set<Id<"users">>();
    if (args.scholarId) scholarIds.add(args.scholarId);
    for (const scholarId of args.scholarIds ?? []) scholarIds.add(scholarId);
    if (args.assignmentId) {
      const assignment = await ctx.db.get(args.assignmentId);
      for (const scholarId of assignment?.scholarIds ?? []) {
        scholarIds.add(scholarId);
      }
    }
    await requireSchoolOperationsForScholars(ctx, scholarIds);
    // Scholar- and assignment-derived guardians inherit the target scholar's
    // already-validated institution. Only a caller-supplied parent id needs its
    // own guardian/institution authorization check.
    const directParents = await resolveParentIds(ctx, {
      parentIds: args.parentIds,
    });
    await requireSchoolOperationsForParents(ctx, directParents.parentIds);
    const { parentIds, unlinkedScholarNames } = await resolveParentIds(ctx, args);
    const resolvedParents = (
      await Promise.all(
        parentIds.map(async (id) => {
          const p = await ctx.db.get(id);
          return p
            ? {
                parentUserId: p._id,
                name: p.name ?? "Parent",
                email: p.email ?? null,
              }
            : null;
        }),
      )
    ).filter((p): p is NonNullable<typeof p> => p !== null);
    return {
      parents: resolvedParents,
      unlinkedScholarNames,
    };
  },
});

// ── Attachment staging ──────────────────────────────────────────────────

// Twice a full composer, so retries after a failed upload never hit it.
const MAX_OPEN_UPLOAD_RESERVATIONS = 2 * MESSAGE_ATTACHMENT_MAX_COUNT;

/**
 * Issue an upload URL for a family-message attachment and reserve it to the
 * caller for a file of exactly `sizeBytes`. `registerAttachmentUpload` accepts
 * only a blob of that size created after the reservation, so a storage id
 * learned from elsewhere (a portfolio scan, a health document) cannot be
 * staged — and then deleted — as the caller's own upload: an older blob fails
 * the time check, and a newer one would need its exact size guessed before it
 * existed, within a capped number of open reservations.
 */
export const generateAttachmentUploadUrl = authedMutation({
  args: { sizeBytes: v.number() },
  handler: async (ctx, { sizeBytes }) => {
    if (
      !Number.isInteger(sizeBytes) ||
      sizeBytes <= 0 ||
      sizeBytes > MESSAGE_ATTACHMENT_MAX_BYTES
    ) {
      throw new Error("Each file must be 25 MB or smaller");
    }
    const open = await ctx.db
      .query("parentMessageUploadReservations")
      .withIndex("by_user", (q) => q.eq("userId", ctx.user._id))
      .take(MAX_OPEN_UPLOAD_RESERVATIONS);
    if (open.length >= MAX_OPEN_UPLOAD_RESERVATIONS) {
      throw new Error("Too many uploads in progress. Try again in an hour.");
    }
    const reservationId = await ctx.db.insert(
      "parentMessageUploadReservations",
      { userId: ctx.user._id, sizeBytes },
    );
    await ctx.scheduler.runAfter(
      UPLOAD_RESERVATION_TTL_MS,
      internal.parentMessages.expireAttachmentUploadReservation,
      { reservationId },
    );
    return { uploadUrl: await ctx.storage.generateUploadUrl(), reservationId };
  },
});

export const expireAttachmentUploadReservation = internalMutation({
  args: { reservationId: v.id("parentMessageUploadReservations") },
  handler: async (ctx, { reservationId }) => {
    if (await ctx.db.get(reservationId)) await ctx.db.delete(reservationId);
  },
});

/**
 * Register a freshly uploaded file to the current user before any family
 * message may reference it. Unclaimed rows self-delete after 24 hours.
 */
export const registerAttachmentUpload = authedMutation({
  args: {
    reservationId: v.id("parentMessageUploadReservations"),
    storageId: v.id("_storage"),
    fileName: v.string(),
    mimeType: v.optional(v.string()),
    sizeBytes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // A retry after a successful registration finds its own staged row; the
    // reservation it consumed is already gone.
    const existing = await ctx.db
      .query("parentMessageAttachments")
      .withIndex("by_storage", (q) => q.eq("storageId", args.storageId))
      .first();
    if (existing) {
      if (
        existing.uploaderId !== ctx.user._id ||
        isPortfolioAttachment(existing) ||
        existing.messageId ||
        existing.threadId
      ) {
        throw new Error("Attachment is not available");
      }
      return { attachmentId: existing._id };
    }

    const reservation = await ctx.db.get(args.reservationId);
    const storage = await ctx.db.system.get("_storage", args.storageId);
    if (
      !reservation ||
      reservation.userId !== ctx.user._id ||
      reservation._creationTime + UPLOAD_RESERVATION_TTL_MS < Date.now()
    ) {
      throw new Error("Upload expired. Attach the file again.");
    }
    if (!storage) throw new Error("Uploaded file was not found");
    // Convex returns a storage id only after the upload, so a blob that
    // predates the reservation did not come from it; one of another size did
    // not either.
    if (
      storage._creationTime <= reservation._creationTime ||
      storage.size !== reservation.sizeBytes
    ) {
      throw new Error("Attachment is not available");
    }
    const fileName = safeMessageAttachmentFileName(args.fileName);
    const mimeType = storage.contentType ?? args.mimeType ?? "";
    if (!fileName) throw new Error("Attachment needs a valid filename");
    if (
      !isSupportedMessageAttachment(mimeType, fileName) ||
      storage.size <= 0
    ) {
      throw new Error("Choose a supported, non-empty attachment");
    }
    if (storage.size > MESSAGE_ATTACHMENT_MAX_BYTES) {
      throw new Error("Each file must be 25 MB or smaller");
    }

    await ctx.db.delete(reservation._id);
    const attachmentId = await ctx.db.insert("parentMessageAttachments", {
      storageId: args.storageId,
      uploaderId: ctx.user._id,
      fileName,
      mimeType: mimeType || "application/octet-stream",
      sizeBytes: storage.size,
      source: "upload",
      uploadReservedAt: reservation._creationTime,
    });
    await ctx.scheduler.runAfter(
      24 * 60 * 60 * 1000,
      internal.parentMessages.deleteAbandonedAttachment,
      { attachmentId },
    );
    return {
      attachmentId,
      fileName,
      mimeType,
      sizeBytes: storage.size,
    };
  },
});

/** Stage an eligible portfolio item without transferring ownership of its blob. */
export const registerPortfolioAttachment = authedMutation({
  args: { portfolioItemId: v.id("portfolioItems"), scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireSchoolOperationsForScholars(ctx, [args.scholarId]);
    const item = await ctx.db.get(args.portfolioItemId);
    const attributed =
      item && (await isAttributedToScholar(ctx, item, args.scholarId));
    const sharing = item
      ? await portfolioAttachmentFamilySharing(ctx, item)
      : null;
    if (
      !item ||
      !attributed ||
      item.familyVisibility === "staff_only" ||
      !assignmentResolved(item) ||
      !item.fileStorageId ||
      item.processingStatus !== "ready"
    ) {
      throw new Error("Portfolio item is not available");
    }
    if (!sharing?.allowed) {
      throw new Error(sharing?.blocker ?? "Portfolio item is not available");
    }
    const storage = await ctx.db.system.get("_storage", item.fileStorageId);
    if (!storage) throw new Error("Portfolio file is missing");
    const fileName = safeMessageAttachmentFileName(item.title);
    const mimeType = item.fileMimeType ?? storage.contentType ?? "";
    if (
      !fileName ||
      !isSupportedMessageAttachment(mimeType, fileName) ||
      storage.size <= 0 ||
      storage.size > MESSAGE_ATTACHMENT_MAX_BYTES
    ) {
      throw new Error("Portfolio item cannot be attached");
    }
    const attachmentId = await ctx.db.insert("parentMessageAttachments", {
      storageId: item.fileStorageId,
      uploaderId: ctx.user._id,
      fileName,
      mimeType,
      sizeBytes: storage.size,
      source: "portfolio",
      portfolioItemId: item._id,
    });
    await ctx.scheduler.runAfter(
      24 * 60 * 60 * 1000,
      internal.parentMessages.deleteAbandonedAttachment,
      { attachmentId },
    );
    return {
      attachmentId,
      storageId: item.fileStorageId,
      fileName,
      mimeType,
      sizeBytes: storage.size,
    };
  },
});

export const discardAttachmentUpload = authedMutation({
  args: { attachmentId: v.id("parentMessageAttachments") },
  handler: async (ctx, { attachmentId }) => {
    const attachment = await ctx.db.get(attachmentId);
    if (!attachment) return { ok: true };
    if (attachment.uploaderId !== ctx.user._id) {
      throw new Error("Forbidden: attachment belongs to another user");
    }
    if (attachment.messageId || attachment.threadId) {
      throw new Error("Sent attachments cannot be removed");
    }
    await deleteAttachmentStorageIfOwned(ctx, attachment);
    await ctx.db.delete(attachment._id);
    return { ok: true };
  },
});

export const deleteAbandonedAttachment = internalMutation({
  args: { attachmentId: v.id("parentMessageAttachments") },
  handler: async (ctx, { attachmentId }) => {
    const attachment = await ctx.db.get(attachmentId);
    if (!attachment || attachment.messageId || attachment.threadId) return;
    await deleteAttachmentStorageIfOwned(ctx, attachment);
    await ctx.db.delete(attachment._id);
  },
});

// ── Thread creation ─────────────────────────────────────────────────────

/**
 * Portal "New message" actions always create a distinct thread, like email.
 * Transport-level inbound messages that carry no thread identity (WhatsApp/SMS)
 * may still use getOrCreateThread below and collapse into the latest match.
 */
export async function createThread(
  ctx: MutationCtx,
  opts: {
    parentUserIds: Id<"users">[];
    teacherId?: Id<"users">;
    scholarId?: Id<"users">;
    institutionId?: Id<"institutions">;
    broadcastId?: string;
    now: number;
    // Scholar ↔ staff threads (scholarMessages.ts): `parentUserIds` is then
    // just the scholar (side "scholar"); named mentors are added separately.
    kind?: "mentor" | "workshop";
    suggestionId?: Id<"scholarSuggestions">;
  },
): Promise<Id<"parentThreads">> {
  const parentUserIds = [...new Set(opts.parentUserIds)];
  if (parentUserIds.length === 0) throw new Error("Thread needs a guardian");
  if (opts.kind && (!opts.scholarId || parentUserIds.length !== 1 ||
      parentUserIds[0] !== opts.scholarId)) {
    throw new Error("A scholar thread's only initial participant is its scholar");
  }
  const institutionId =
    opts.institutionId ??
    (opts.scholarId
      ? (await ctx.db.get(opts.scholarId))?.institutionId
      : await unambiguousInstitutionForParents(ctx, parentUserIds)) ??
    undefined;
  const threadId = await ctx.db.insert("parentThreads", {
    parentUserId: parentUserIds[0],
    teacherId: opts.teacherId,
    scholarId: opts.scholarId,
    institutionId,
    broadcastId: opts.broadcastId,
    lastMessageAt: opts.now,
    ...(opts.kind ? { kind: opts.kind } : {}),
    ...(opts.suggestionId ? { suggestionId: opts.suggestionId } : {}),
  });
  await ensureThreadParticipants(
    ctx,
    threadId,
    parentUserIds,
    opts.kind ? "scholar" : undefined,
  );
  return threadId;
}

async function getOrCreateThread(
  ctx: MutationCtx,
  opts: {
    parentUserIds: Id<"users">[];
    teacherId?: Id<"users">;
    scholarId?: Id<"users">;
    institutionId?: Id<"institutions">;
    broadcastId?: string;
    now: number;
  },
): Promise<Id<"parentThreads">> {
  const parentUserIds = [...new Set(opts.parentUserIds)];
  if (parentUserIds.length === 0) throw new Error("Thread needs a guardian");
  const institutionId =
    opts.institutionId ??
    (opts.scholarId
      ? (await ctx.db.get(opts.scholarId))?.institutionId
      : await unambiguousInstitutionForParents(ctx, parentUserIds)) ??
    undefined;
  const existing = opts.scholarId
    ? await ctx.db
        .query("parentThreads")
        .withIndex("by_scholar", (q) => q.eq("scholarId", opts.scholarId))
        .collect()
    : await ctx.db
        .query("parentThreads")
        .withIndex("by_parent", (q) => q.eq("parentUserId", parentUserIds[0]))
        .collect();
  const match = existing
    .filter(
      (thread) =>
        isFamilyThread(thread) &&
        thread.scholarId === opts.scholarId &&
        (thread.institutionId === institutionId ||
          // A legacy subject thread is safely identified by its immutable
          // scholar id. Adopt the derived anchor below instead of duplicating it.
          (opts.scholarId !== undefined && thread.institutionId === undefined)) &&
        (thread.teacherId ?? null) === (opts.teacherId ?? null),
    )
    .sort((a, b) => b.lastMessageAt - a.lastMessageAt)[0];
  if (match) {
    await ctx.db.patch(match._id, {
      lastMessageAt: opts.now,
      ...(institutionId && !match.institutionId ? { institutionId } : {}),
    });
    await ensureThreadParticipants(ctx, match._id, parentUserIds);
    return match._id;
  }
  return await createThread(ctx, { ...opts, parentUserIds, institutionId });
}

/**
 * Append a message + its per-channel delivery rows (portal sent immediately).
 *
 * Kind-aware: off-portal (email/SMS/WhatsApp) rows are only ever queued on a
 * FAMILY thread and only for guardian recipients — never for a scholar, and
 * never on a mentor/workshop thread (a mentor's email rides its own batch in
 * scholarMessages.ts). The unread stamps are directional:
 *   family   — lastParentToTeacherAt on a guardian message; lastToParentAt on
 *              every human message (guardians read each other too).
 *   scholar  — lastParentToTeacherAt on a SCHOLAR message (staff unread);
 *              lastToParentAt on a STAFF message only (the scholar's unread).
 */
export async function appendMessage(
  ctx: MutationCtx,
  opts: {
    threadId: Id<"parentThreads">;
    parentUserIds: Id<"users">[];
    authorType: "teacher" | "parent" | "scholar";
    authorUserId?: Id<"users">;
    body: string;
    broadcastId?: string;
    now: number;
    queueOffPortal?: boolean;
    // Provider message id (WhatsApp `wamid`) for inbound dedup.
    providerMessageId?: string;
    // Transport the message was authored through (e.g. a Slack-bridged teacher
    // reply) — drives the teacher-facing "via Slack" provenance badge.
    source?: "slack";
    attachments?: PreparedAttachment[];
    claimOriginalAttachments?: boolean;
    // Backfill only: the message's original time (see schema `sentAt`).
    sentAt?: number;
    // The scholar's words that open a Workshop idea / bug card (schema).
    isIdeaOpening?: true;
    // A message that ARRIVES now but displays at an older `sentAt` (a late
    // transcript): unread accounting uses this arrival time, not `sentAt`.
    unreadAt?: number;
  },
): Promise<Id<"parentMessages">> {
  const thread = await ctx.db.get(opts.threadId);
  if (!thread) throw new Error("Thread not found");
  const family = isFamilyThread(thread);
  // A scholar never writes in a family thread; a guardian never writes in a
  // scholar thread. Caught here so no caller can mix the two.
  if (family ? opts.authorType === "scholar" : opts.authorType === "parent") {
    throw new Error("Author does not belong to this conversation");
  }
  const messageId = await ctx.db.insert("parentMessages", {
    threadId: opts.threadId,
    authorType: opts.authorType,
    authorUserId: opts.authorUserId,
    body: opts.body,
    broadcastId: opts.broadcastId,
    providerMessageId: opts.providerMessageId,
    source: opts.source,
    ...(opts.sentAt !== undefined ? { sentAt: opts.sentAt } : {}),
    ...(opts.isIdeaOpening ? { isIdeaOpening: true as const } : {}),
  });
  await attachUploadsToMessage(
    ctx,
    opts.attachments ?? [],
    messageId,
    opts.threadId,
    opts.claimOriginalAttachments ?? true,
  );
  const parentUserIds = [...new Set(opts.parentUserIds)];
  // Portal is the durable record — delivered immediately to every participant.
  for (const parentUserId of parentUserIds) {
    await ctx.db.insert("messageDeliveries", {
      messageId,
      parentUserId,
      channel: "portal",
      status: "sent",
    });
  }
  if (opts.queueOffPortal && family) {
    const emailRecipients: Id<"users">[] = [];
    for (const parentUserId of parentUserIds) {
      const recipient = await ctx.db.get(parentUserId);
      // Kid-safe delivery: no off-portal row is EVER created for a scholar.
      if (!recipient || recipient.role === ROLES.SCHOLAR) continue;
      if (await emailEligible(ctx, parentUserId)) emailRecipients.push(parentUserId);
      for (const channel of await optedInChannels(ctx, parentUserId)) {
        await ctx.db.insert("messageDeliveries", {
          messageId,
          parentUserId,
          channel,
          status: "queued",
        });
      }
    }
    if (emailRecipients.length > 0) {
      await ctx.db.insert("messageDeliveries", {
        messageId,
        parentUserId: emailRecipients[0],
        channel: "email",
        status: "queued",
      });
    }
  }
  // Direction-aware unread stamps (same Date.now() space as the read markers).
  const stampAt = opts.unreadAt ?? opts.sentAt ?? opts.now;
  const patch: Record<string, number> = {
    lastMessageAt: Math.max(thread.lastMessageAt, stampAt),
  };
  if (family) {
    if (opts.authorType === "parent") {
      patch.lastParentToTeacherAt = stampAt;
    }
    // Every human message is new to the other guardians; the sender's own
    // participant read marker is stamped immediately by the caller.
    patch.lastToParentAt = stampAt;
  } else if (opts.authorType === "scholar") {
    // Max, not overwrite: a backfilled/transcribed message carries an older
    // `sentAt` and must never roll a newer stamp back.
    patch.lastParentToTeacherAt = Math.max(thread.lastParentToTeacherAt ?? 0, stampAt);
  } else {
    patch.lastToParentAt = Math.max(thread.lastToParentAt ?? 0, stampAt);
  }
  await ctx.db.patch(opts.threadId, patch);
  if (family && opts.authorType === "parent") {
    await ctx.scheduler.runAfter(
      0,
      internal.parentMessageSlack.notifyParentMessageChannel,
      {
        messageId,
      },
    );
  }
  return messageId;
}

// ── Staff: send ─────────────────────────────────────────────────────────

/** Send a message from staff into one family thread per selected scholar. */
export const sendMessage = authedMutation({
  args: {
    body: v.string(),
    attachmentIds: v.optional(
      v.array(v.id("parentMessageAttachments")),
    ),
    // Recipient selector (any combination; deduped):
    scholarId: v.optional(v.id("users")),
    scholarIds: v.optional(v.array(v.id("users"))),
    assignmentId: v.optional(v.id("assignments")),
    parentIds: v.optional(v.array(v.id("users"))),
    // Program families require an explicit Extended Education send path.
    // Ordinary assignment/group-derived audiences stay enrolled-only.
    includeProgramGuests: v.optional(v.boolean()),
    // Conversation subject ("about Kai"); defaults to scholarId when present.
    subjectScholarId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const body = args.body.trim();

    const scholarIds = new Set<Id<"users">>();
    if (args.scholarId) scholarIds.add(args.scholarId);
    for (const scholarId of args.scholarIds ?? []) scholarIds.add(scholarId);
    if (args.assignmentId) {
      const assignment = await ctx.db.get(args.assignmentId);
      for (const scholarId of assignment?.scholarIds ?? []) scholarIds.add(scholarId);
    }
    if (args.includeProgramGuests !== true) {
      for (const scholarId of [...scholarIds]) {
        if (isProgramGuest(await ctx.db.get(scholarId))) {
          scholarIds.delete(scholarId);
        }
      }
    }
    const subjectScholarId =
      args.subjectScholarId &&
      (args.includeProgramGuests === true ||
        !isProgramGuest(await ctx.db.get(args.subjectScholarId)))
        ? args.subjectScholarId
        : undefined;
    await requireSchoolOperationsForScholars(ctx, scholarIds);
    if (subjectScholarId) {
      await requireSchoolOperationsForScholars(ctx, [subjectScholarId]);
    }
    const portfolioScholarId =
      scholarIds.size === 1
        ? [...scholarIds][0]
        : subjectScholarId && scholarIds.size === 0
          ? subjectScholarId
          : undefined;
    const attachments = await prepareAttachments(
      ctx,
      args.attachmentIds,
      ctx.user._id,
      portfolioScholarId,
    );
    if (!body && attachments.length === 0) {
      throw new Error("Message is empty");
    }
    if (body.length > MAX_BODY) throw new Error("Message is too long");

    const targets: {
      scholarId?: Id<"users">;
      parentUserIds: Id<"users">[];
      institutionId: Id<"institutions">;
    }[] = [];
    const allRecipients = new Set<Id<"users">>();
    for (const scholarId of scholarIds) {
      const parentUserIds = await guardianParentsOfScholar(ctx, scholarId);
      // Do this validation before the first thread/message write. Silently
      // skipping one selected family would turn a bulk send into a partial
      // delivery that staff cannot see or correct.
      if (parentUserIds.length === 0) {
        throw new Error("No linked parents: every selected scholar needs a linked parent");
      }
      const scholar = await ctx.db.get(scholarId);
      if (!scholar?.institutionId) {
        throw new Error("Scholar is not in an institution");
      }
      parentUserIds.forEach((parentId) => allRecipients.add(parentId));
      targets.push({ scholarId, parentUserIds, institutionId: scholar.institutionId });
    }
    if (scholarIds.size === 0) {
      if (subjectScholarId) {
        const guardianIds = await guardianParentsOfScholar(
          ctx,
          subjectScholarId,
        );
        const guardianSet = new Set(guardianIds);
        if (
          args.parentIds?.some((parentId) => !guardianSet.has(parentId))
        ) {
          throw new Error(
            "Every recipient must be a guardian of the subject scholar",
          );
        }
        guardianIds.forEach((parentId) => allRecipients.add(parentId));
        if (guardianIds.length > 0) {
          targets.push({
            scholarId: subjectScholarId,
            parentUserIds: guardianIds,
            institutionId: (await ctx.db.get(subjectScholarId))!.institutionId!,
          });
        }
      } else {
        const { parentIds: resolvedParentIds } = await resolveParentIds(ctx, args);
        const institutions = await requireSchoolOperationsForParents(
          ctx,
          resolvedParentIds,
        );
        for (const parentId of resolvedParentIds) {
          targets.push({
            parentUserIds: [parentId],
            institutionId: institutions.get(parentId)!,
          });
          allRecipients.add(parentId);
        }
      }
    }
    if (targets.length === 0) {
      throw new Error("No linked parents for that selection");
    }

    const now = Date.now();
    const broadcastId = targets.length > 1 ? randomId() : undefined;

    const threadIds: Id<"parentThreads">[] = [];
    const dispatchMessageIds: Id<"parentMessages">[] = [];
    for (const [targetIndex, target] of targets.entries()) {
      const threadId = await createThread(ctx, {
        parentUserIds: target.parentUserIds,
        teacherId: ctx.user._id,
        scholarId: target.scholarId,
        institutionId: target.institutionId,
        broadcastId,
        now,
      });
      await ctx.db.patch(threadId, { lastReadByTeacherAt: now });
      const messageId = await appendMessage(ctx, {
        threadId,
        parentUserIds: target.parentUserIds,
        authorType: "teacher",
        authorUserId: ctx.user._id,
        body,
        broadcastId,
        now,
        queueOffPortal: true,
        attachments,
        claimOriginalAttachments: targetIndex === 0,
      });
      dispatchMessageIds.push(messageId);
      threadIds.push(threadId);
    }
    // Hand the queued off-portal deliveries to the (idempotent) dispatcher.
    if (dispatchMessageIds.length > 0) {
      await ctx.scheduler.runAfter(0, internal.parentMessageSend.dispatch, {
        messageIds: dispatchMessageIds,
      });
    }
    return {
      broadcastId: broadcastId ?? null,
      threadIds,
      recipientCount: allRecipients.size,
    };
  },
});

// ── Thread access ───────────────────────────────────────────────────────

type Viewer = "parent" | "teacher";
type ThreadSurface = "parent" | "staff";
type OffPortalDeliveryChannel = "email" | "sms" | "whatsapp";
type CopiedChannel = OffPortalDeliveryChannel | "slack";

const threadSurfaceArg = v.optional(v.union(v.literal("parent"), v.literal("staff")));
const offPortalDeliveryChannels: OffPortalDeliveryChannel[] = [
  "email",
  "sms",
  "whatsapp",
];

async function threadViewer(
  ctx: AuthedCtx,
  thread: Doc<"parentThreads">,
  surface?: ThreadSurface,
): Promise<Viewer> {
  // Family-only engine entry: a mentor/workshop thread is reachable ONLY
  // through scholarMessages.ts, whatever the caller's roles or participant rows.
  if (!isFamilyThread(thread)) {
    throw new Error("Forbidden: not a participant in this thread");
  }
  const role = ctx.user.role;
  const isParentParticipant = (await threadParticipantIds(ctx, thread)).includes(
    ctx.user._id,
  );
  if (surface === "parent") {
    if (isParentParticipant) return "parent";
    throw new Error("Forbidden: not a participant in this thread");
  }
  if (surface === "staff") {
    if (await canOperateThread(ctx, thread)) {
      return "teacher";
    }
    throw new Error("Forbidden: not a participant in this thread");
  }
  if (role === ROLES.PARENT && isParentParticipant) {
    return "parent";
  }
  if (await canOperateThread(ctx, thread)) {
    return "teacher";
  }
  throw new Error("Forbidden: not a participant in this thread");
}

/**
 * The family threads a guardian participates in (participant rows on the
 * family side + legacy `parentUserId` anchors). Non-family threads and
 * non-family sides are dropped, so a guardian who is ALSO a mentor (or the
 * scholar anchor of a scholar thread) never sees those here.
 */
async function guardianFamilyThreads(
  ctx: QueryCtx | MutationCtx,
  parentUserId: Id<"users">,
): Promise<Doc<"parentThreads">[]> {
  const participantRows = (
    await ctx.db
      .query("parentThreadParticipants")
      .withIndex("by_parent", (q) => q.eq("parentUserId", parentUserId))
      .collect()
  ).filter(isFamilySide);
  const participantThreads = (
    await Promise.all(participantRows.map((row) => ctx.db.get(row.threadId)))
  ).filter((thread): thread is Doc<"parentThreads"> => thread !== null);
  const legacyThreads = await ctx.db
    .query("parentThreads")
    .withIndex("by_parent", (q) => q.eq("parentUserId", parentUserId))
    .collect();
  return [
    ...new Map(
      [...participantThreads, ...legacyThreads]
        .filter(isFamilyThread)
        .map((thread) => [thread._id, thread]),
    ).values(),
  ];
}

async function hasGuardianContext(ctx: AuthedCtx): Promise<boolean> {
  if (ctx.user.role === ROLES.PARENT) return true;
  const link = await ctx.db
    .query("guardianships")
    .withIndex("by_parent", (q) => q.eq("parentUserId", ctx.user._id))
    .first();
  return !!link;
}

async function summarizeThreads(
  ctx: AuthedQueryCtx,
  threads: Doc<"parentThreads">[],
  viewer: Viewer,
  standing: StaffStandingCache = new Map(),
) {
  threads.sort((a, b) => b.lastMessageAt - a.lastMessageAt);

  return await Promise.all(
    threads.map(async (t) => {
      const msgs = await ctx.db
        .query("parentMessages")
        .withIndex("by_thread", (q) => q.eq("threadId", t._id))
        .collect();
      const humanMessages = msgs.filter((message) => message.authorType !== "bot");
      const visibleHumanMessages = humanMessages.filter(
        (message) => !isRetractedMessage(message),
      );
      const last = visibleHumanMessages[visibleHumanMessages.length - 1];
      const lastAttachments = last
        ? (
            await ctx.db
              .query("parentMessageAttachments")
              .withIndex("by_message", (q) => q.eq("messageId", last._id))
              .collect()
          ).filter((attachment) => attachment.retractedAt === undefined)
        : [];
      const participantIds = await threadParticipantIds(ctx, t);
      const parents = await Promise.all(
        participantIds.map((parentUserId) => ctx.db.get(parentUserId)),
      );
      const scholar = t.scholarId ? await ctx.db.get(t.scholarId) : null;
      const teacher = t.teacherId ? await ctx.db.get(t.teacherId) : null;
      // Unread is directional: parents read teacher messages, and teachers read
      // parent messages.
      const hasUnread =
        viewer === "parent"
          ? (t.lastToParentAt ?? 0) >
            ((await participantRow(ctx, t._id, ctx.user._id))?.lastReadAt ??
              t.lastReadByParentAt ??
              0)
          : (t.lastParentToTeacherAt ?? 0) > (t.lastReadByTeacherAt ?? 0);
      const threadSummary = {
        _id: t._id,
        parentName: parents
          .map((parent) => userDisplayName(parent, "Parent"))
          .join(", "),
        scholarName: scholar?.name ?? null,
        teacherName: teacher?.name ?? null,
        lastMessageAt: t.lastMessageAt,
        lastPreview: last
          ? previewOf(last.body) || attachmentPreview(lastAttachments)
          : humanMessages.length > 0
            ? "Message withdrawn"
            : "",
        // Who wrote the latest message, as THIS viewer reads it: "You" only
        // for their own words. Any staffer may write in a family thread, and
        // so may every guardian on it, so the side alone can't say "you".
        lastMessageAuthorName: last
          ? last.authorUserId === ctx.user._id
            ? "You"
            : userDisplayName(
                last.authorUserId ? await ctx.db.get(last.authorUserId) : null,
                last.authorType === "parent" ? "Parent" : "Teacher",
              )
          : null,
        hasUnread,
      };
      const guardians = parents.filter(
        (parent): parent is Doc<"users"> => parent !== null,
      );
      if (viewer === "parent") {
        return {
          ...threadSummary,
          viewer,
          guardians: guardians.map((parent) => ({
            name: userDisplayName(parent, "Parent"),
          })),
        };
      }
      return {
        ...threadSummary,
        viewer,
        guardians: guardians.map((parent) => ({
          _id: parent._id,
          name: userDisplayName(parent, "Parent"),
          image: parent.image ?? null,
        })),
        staff: await familyThreadStaff(ctx, standing, t, humanMessages),
      };
    }),
  );
}

/**
 * Whether a staffer can still operate family threads at an institution, the
 * `userCanOperateThread` rule, memoized for one read: the same few owners and
 * authors recur across a whole inbox.
 */
type StaffStandingCache = Map<string, Promise<boolean>>;

function staffStillOperates(
  ctx: QueryCtx | MutationCtx,
  cache: StaffStandingCache,
  userId: Id<"users">,
  institutionId: Id<"institutions"> | null,
): Promise<boolean> {
  if (!institutionId) return Promise.resolve(false);
  const key = `${userId}:${institutionId}`;
  let standing = cache.get(key);
  if (!standing) {
    standing = (async () => {
      const user = await ctx.db.get(userId);
      return (
        !!user &&
        (await hasSchoolOperationsAccessAtInstitution(ctx, user, institutionId))
      );
    })();
    cache.set(key, standing);
  }
  return standing;
}

/**
 * The staff on a family thread, owner first: the teacher who started or
 * claimed it, then anyone else on the staff side who has written in it — only
 * those who can still read and reply here (the facepile's contract; a
 * departed teacher's messages keep their name, but they leave the pile). Staff
 * share family threads as a team, so this names who has taken part, never who
 * may read.
 */
async function familyThreadStaff(
  ctx: QueryCtx | MutationCtx,
  cache: StaffStandingCache,
  thread: Doc<"parentThreads">,
  messages: Doc<"parentMessages">[],
): Promise<{ _id: Id<"users">; name: string; image: string | null }[]> {
  const staffIds = new Set<Id<"users">>(
    thread.teacherId ? [thread.teacherId] : [],
  );
  for (const message of messages) {
    if (message.authorType === "teacher" && message.authorUserId) {
      staffIds.add(message.authorUserId);
    }
  }
  const institutionId = await threadInstitutionId(ctx, thread);
  const staff = await Promise.all(
    [...staffIds].map(async (id) =>
      (await staffStillOperates(ctx, cache, id, institutionId))
        ? await ctx.db.get(id)
        : null,
    ),
  );
  return staff
    .filter((person): person is Doc<"users"> => person !== null)
    .map((person) => ({
      _id: person._id,
      name: userDisplayName(person, "Teacher"),
      image: person.image ?? null,
    }));
}

// ── Reads (shared parent + teacher, each scoped) ────────────────────────

/**
 * Thread list for the parent surface. This is guardian-scoped by the thread's
 * parent participant, not by users.role, so staff who are also guardians see
 * their own family threads in /parent while their staff inbox remains role-
 * scoped through listMyThreads.
 */
export const listMyGuardianThreads = authedQuery({
  args: {},
  handler: async (ctx) => {
    if (!(await hasGuardianContext(ctx))) return [];
    const threads = await guardianFamilyThreads(ctx, ctx.user._id);
    return await summarizeThreads(ctx, threads, "parent");
  },
});

/** Teachers a parent may address for one of their own children. */
export const listParentRecipientTeachers = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    return await parentRecipientTeachers(ctx, args.scholarId);
  },
});

/**
 * Thread list for the caller. Parents see ONLY their own threads. Staff
 * default to scope "mine" (`isMyFamilyThread`); scope "all" returns every
 * family thread they can operate (any teacher is trusted) — both used by the
 * staff Messages inbox, which opens on Mine.
 */
export const listMyThreads = authedQuery({
  args: {
    // Inbox toggle: "mine" (threads I'm part of, plus unclaimed ones) vs
    // "all" (every staff thread).
    scope: v.optional(v.union(v.literal("mine"), v.literal("all"))),
    // Active institution lens (?inst=): "" = home, "all", or a slug. Narrows the
    // staff inbox to threads about scholars in the resolved institution scope.
    institutionScope: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const role = ctx.user.role;
    let threads: Doc<"parentThreads">[];
    let viewer: Viewer;
    const standing: StaffStandingCache = new Map();
    if (role === ROLES.PARENT) {
      threads = await guardianFamilyThreads(ctx, ctx.user._id);
      viewer = "parent";
    } else {
      // Every thread, narrowed to the family threads the caller can operate
      // (and, for "mine", to theirs) below. "mine" can't use `by_teacher`
      // alone: it also takes unclaimed threads and ones the caller wrote in.
      threads = await ctx.db.query("parentThreads").collect();
      threads = (
        await Promise.all(
          threads.map(async (thread) =>
            isFamilyThread(thread) && (await canOperateThread(ctx, thread))
              ? thread
              : null,
          ),
        )
      ).filter((thread): thread is Doc<"parentThreads"> => thread !== null);
      if (args.institutionScope !== undefined) {
        const lens = await resolveInstitutionLens(
          ctx,
          ctx.user,
          args.institutionScope,
        );
        const institution = lens.institution;
        if (lens.scope !== "all" && institution) {
          threads = (
            await Promise.all(
              threads.map(async (thread) =>
                (await threadBelongsToInstitution(ctx, thread, institution._id))
                  ? thread
                  : null,
              ),
            )
          ).filter((thread): thread is Doc<"parentThreads"> => thread !== null);
        }
      }
      if (args.scope !== "all") {
        threads = (
          await Promise.all(
            threads.map(async (thread) =>
              (await isMyFamilyThread(ctx, standing, thread)) ? thread : null,
            ),
          )
        ).filter((thread): thread is Doc<"parentThreads"> => thread !== null);
      }
      viewer = "teacher";
    }

    return await summarizeThreads(ctx, threads, viewer, standing);
  },
});

/**
 * A staff inbox's "Mine" (the view it opens on): family threads the caller
 * owns or has written in as staff, plus unclaimed ones — no current staffer
 * owns or has written in them. A parent's note to the "School team" has no
 * teacher until a staff reply claims it, and a thread whose teacher has since
 * left has no one to answer it; either sits in every staffer's Mine rather
 * than only behind "All", where nobody would see it by default. Except the
 * caller's own family's thread: a staffer who is also a guardian doesn't
 * triage their own note as staff.
 */
async function isMyFamilyThread(
  ctx: AuthedCtx,
  standing: StaffStandingCache,
  thread: Doc<"parentThreads">,
): Promise<boolean> {
  if (thread.teacherId === ctx.user._id) return true;
  const messages = await ctx.db
    .query("parentMessages")
    .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
    .collect();
  const staffAuthors = new Set<Id<"users">>();
  for (const message of messages) {
    if (message.authorType === "teacher" && message.authorUserId) {
      staffAuthors.add(message.authorUserId);
    }
  }
  if (staffAuthors.has(ctx.user._id)) return true;
  const institutionId = await threadInstitutionId(ctx, thread);
  for (const staffId of [
    ...(thread.teacherId ? [thread.teacherId] : []),
    ...staffAuthors,
  ]) {
    if (await staffStillOperates(ctx, standing, staffId, institutionId)) {
      return false;
    }
  }
  return !(await threadParticipantIds(ctx, thread)).includes(ctx.user._id);
}

export function previewOf(body: string): string {
  const t = messagePlainText(body, { labelsOnly: true })
    .replace(/\s+/g, " ")
    .trim();
  return t.length > 90 ? t.slice(0, 90) + "…" : t;
}

/** Full thread + messages. Parents are participant-gated; staff are institution-gated. */
export const getThread = authedQuery({
  args: { threadId: v.id("parentThreads"), as: threadSurfaceArg },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) return null;
    const viewer = await threadViewer(ctx, thread, args.as);

    const msgs = await ctx.db
      .query("parentMessages")
      .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
      .collect();

    const participantIds = await threadParticipantIds(ctx, thread);
    const parents = await Promise.all(
      participantIds.map((parentUserId) => ctx.db.get(parentUserId)),
    );
    const scholar = thread.scholarId ? await ctx.db.get(thread.scholarId) : null;
    const visibleMessages = msgs.filter(isHumanParentMessage);
    const authorIds = [
      ...new Set(
        visibleMessages.flatMap((message) =>
          message.authorUserId ? [message.authorUserId] : [],
        ),
      ),
    ];
    const authors = new Map(
      (
        await Promise.all(
          authorIds.map(async (authorId) => [authorId, await ctx.db.get(authorId)] as const),
        )
      ).map(([authorId, author]) => [authorId, author]),
    );

    const threadPayload = {
      _id: thread._id,
      parentName: parents
        .map((parent) => userDisplayName(parent, "Parent"))
        .join(", "),
      scholarName: scholar?.name ?? null,
      messages: await Promise.all(
        visibleMessages.map(async (m) => {
          const retracted = isRetractedMessage(m);
          // When the window closes, not whether it's open: this query doesn't
          // re-run as time passes, so the client runs the clock (T11).
          const editableUntil =
            m.authorUserId === ctx.user._id && !retracted
              ? messageEditableUntil(messageSentAt(m))
              : null;
          const deliveredChannels = editableUntil !== null
            ? new Set(
                (
                  await ctx.db
                    .query("messageDeliveries")
                    .withIndex("by_message", (q) => q.eq("messageId", m._id))
                    .collect()
                )
                  .filter(
                    (delivery) =>
                      delivery.channel !== "portal" &&
                      (delivery.status === "sent" ||
                        delivery.status === "delivered"),
                  )
                  .map((delivery) => delivery.channel),
              )
            : new Set<OffPortalDeliveryChannel>();
          const offPortalDelivered = offPortalDeliveryChannels.filter((channel) =>
            deliveredChannels.has(channel),
          );
          const copiedChannels: CopiedChannel[] = [
            ...offPortalDelivered,
            ...(editableUntil !== null &&
            (m.copiedToSlackAt !== undefined || m.source === "slack")
              ? (["slack"] as const)
              : []),
          ];
          return {
            _id: m._id,
            authorType: m.authorType,
            authorName: m.authorUserId
              ? userDisplayName(
                  authors.get(m.authorUserId) ?? null,
                  m.authorType === "parent" ? "Parent" : "Teacher",
                )
              : m.authorType === "parent"
                ? "Parent"
                : "Teacher",
            // The viewer's own words. Not the same as "their side": another
            // staffer or a co-guardian writes on the same side and must still
            // be named (the scholar-thread contract's `mine`).
            mine: !!m.authorUserId && m.authorUserId === ctx.user._id,
            body: retracted ? "" : m.body,
            createdAt: m._creationTime,
            editedAt: m.editedAt ?? null,
            retracted,
            // No `canEdit` here: web bundles from before #3983 showed Edit on
            // it alone, with no clock, so a clock-free `true` would offer Edit
            // on every old message in a stale tab. Absent, they hide it.
            editableUntil,
            offPortalDelivered,
            // Transport provenance ("via Slack") is teacher-facing only — a parent
            // doesn't need to know which channel the teacher happened to reply from.
            source: viewer === "teacher" ? m.source ?? null : null,
            // Staff see what a withdrawn message said (the open door);
            // guardians see only the tombstone.
            withdrawnOriginal: retracted && viewer === "teacher" ? m.body : null,
            // Every place the author's own message was copied outside
            // Rabbithole — a family email/SMS/WhatsApp, the staff Slack mirror,
            // or it was written in Slack — so a withdraw warning can name them.
            // `copiedOutside` is the shared row contract with scholar threads.
            copiedChannels,
            copiedOutside: copiedChannels.length > 0,
          };
        }),
      ),
    };
    const guardians = parents.filter(
      (parent): parent is Doc<"users"> => parent !== null,
    );
    if (viewer === "parent") {
      return {
        ...threadPayload,
        viewer,
        guardians: guardians.map((parent) => ({
          name: userDisplayName(parent, "Parent"),
        })),
      };
    }
    return {
      ...threadPayload,
      viewer,
      scholarId: thread.scholarId ?? null,
      guardians: guardians.map((parent) => ({
        _id: parent._id,
        name: userDisplayName(parent, "Parent"),
        image: parent.image ?? null,
      })),
      staff: await familyThreadStaff(ctx, new Map(), thread, visibleMessages),
    };
  },
});

/**
 * The preview action receives only a message-bound URL after this query has
 * applied the same thread and tenant authorization as the visible bubble.
 */
export const getMessageLinkPreviewRequest = authedQuery({
  args: {
    messageId: v.id("parentMessages"),
    url: v.string(),
    as: threadSurfaceArg,
  },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (
      !message ||
      !isHumanParentMessage(message) ||
      isRetractedMessage(message)
    ) {
      return null;
    }
    const thread = await ctx.db.get(message.threadId);
    if (!thread) return null;
    await threadViewer(ctx, thread, args.as);
    const previewUrl = previewableMessageLink(message.body);
    return previewUrl === args.url
      ? { url: previewUrl, viewerId: ctx.user._id }
      : null;
  },
});

/** Attachment metadata + serving URLs, behind the thread and institution gate. */
export const getThreadAttachments = authedQuery({
  args: { threadId: v.id("parentThreads"), as: threadSurfaceArg },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) return [];
    const viewer = await threadViewer(ctx, thread, args.as);
    const attachments = await ctx.db
      .query("parentMessageAttachments")
      .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
      .collect();
    const visibleAttachments = [];
    const withdrawnMessages = new Map<Id<"parentMessages">, boolean>();
    const messageWithdrawn = async (messageId: Id<"parentMessages"> | undefined) => {
      if (!messageId) return false;
      if (!withdrawnMessages.has(messageId)) {
        const message = await ctx.db.get(messageId);
        withdrawnMessages.set(messageId, !message || isRetractedMessage(message));
      }
      return withdrawnMessages.get(messageId)!;
    };
    for (const attachment of attachments) {
      // Staff still see a withdrawn attachment (flagged); guardians never do —
      // including a live attachment row on a withdrawn MESSAGE (TRA-403).
      const withdrawn =
        attachment.retractedAt !== undefined ||
        (await messageWithdrawn(attachment.messageId));
      if (withdrawn && viewer !== "teacher") continue;
      if (viewer === "parent" && isPortfolioAttachment(attachment)) {
        const item = attachment.portfolioItemId
          ? await ctx.db.get(attachment.portfolioItemId)
          : null;
        const attributed =
          item &&
          thread.scholarId &&
          (await isAttributedToScholar(ctx, item, thread.scholarId));
        if (
          !item ||
          !attributed ||
          item.familyVisibility === "staff_only" ||
          !assignmentResolved(item) ||
          !(await portfolioAttachmentFamilySharing(ctx, item)).allowed
        ) {
          continue;
        }
      }
      visibleAttachments.push(attachment);
    }
    return await Promise.all(
      visibleAttachments.map(async (attachment) => ({
        _id: attachment._id,
        messageId: attachment.messageId,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        url: await ctx.storage.getUrl(attachment.storageId),
        withdrawn:
          attachment.retractedAt !== undefined ||
          (await messageWithdrawn(attachment.messageId)),
      })),
    );
  },
});

// ── Writes (shared) ─────────────────────────────────────────────────────
// The edit/withdraw engine is kind-agnostic and shared with scholarMessages.ts;
// each caller authorizes the THREAD first (family: threadViewer, scholar
// threads: scholarThreadAccess), then these enforce authorship + the window.

/** When a message was sent, for display order and the edit window. */
export function messageSentAt(
  message: Pick<Doc<"parentMessages">, "_creationTime" | "sentAt">,
): number {
  return message.sentAt ?? message._creationTime;
}

/**
 * Only the author may change a message, and only inside the one 10-minute
 * window every author and every conversation kind shares. Server-enforced —
 * the UI hiding the control is a courtesy, not the gate.
 */
export function assertAuthorCanChange(
  message: Doc<"parentMessages">,
  userId: Id<"users">,
): void {
  if (message.authorUserId !== userId) {
    throw new Error("Forbidden: only the message author may change it");
  }
  if (!editWindowOpen(messageEditableUntil(messageSentAt(message)), Date.now())) {
    throw new Error("Messages can only be changed for 10 minutes after sending");
  }
}

export async function editMessageBody(
  ctx: MutationCtx,
  message: Doc<"parentMessages">,
  userId: Id<"users">,
  rawBody: string,
): Promise<void> {
  assertAuthorCanChange(message, userId);
  if (isRetractedMessage(message)) {
    throw new Error("Withdrawn messages cannot be edited");
  }
  const body = rawBody.trim();
  const liveAttachments = (
    await ctx.db
      .query("parentMessageAttachments")
      .withIndex("by_message", (q) => q.eq("messageId", message._id))
      .collect()
  ).filter((attachment) => attachment.retractedAt === undefined);
  if (!body && liveAttachments.length === 0) {
    throw new Error("Message is empty");
  }
  if (body.length > MAX_BODY) throw new Error("Message is too long");

  const now = Date.now();
  await ctx.db.patch(message._id, {
    body,
    editedAt: now,
    editHistory: [
      ...(message.editHistory ?? []),
      { body: message.body, replacedAt: now },
    ],
  });
}

export async function retractMessageAndAttachments(
  ctx: MutationCtx,
  message: Doc<"parentMessages">,
  userId: Id<"users">,
): Promise<void> {
  if (message.retractedAt !== undefined) return;
  assertAuthorCanChange(message, userId);

  const now = Date.now();
  await ctx.db.patch(message._id, {
    retractedAt: now,
    retractedByUserId: userId,
  });
  const attachments = await ctx.db
    .query("parentMessageAttachments")
    .withIndex("by_message", (q) => q.eq("messageId", message._id))
    .collect();
  for (const attachment of attachments) {
    if (attachment.retractedAt !== undefined) continue;
    await ctx.db.patch(attachment._id, {
      retractedAt: now,
      retractedByUserId: userId,
    });
  }
}

export async function retractOneAttachment(
  ctx: MutationCtx,
  message: Doc<"parentMessages">,
  attachment: Doc<"parentMessageAttachments">,
  userId: Id<"users">,
): Promise<void> {
  if (attachment.retractedAt !== undefined) return;
  assertAuthorCanChange(message, userId);

  const now = Date.now();
  await ctx.db.patch(attachment._id, {
    retractedAt: now,
    retractedByUserId: userId,
  });
  const otherLiveAttachments = (
    await ctx.db
      .query("parentMessageAttachments")
      .withIndex("by_message", (q) => q.eq("messageId", message._id))
      .collect()
  ).filter(
    (candidate) =>
      candidate._id !== attachment._id && candidate.retractedAt === undefined,
  );
  if (
    !message.body.trim() &&
    otherLiveAttachments.length === 0 &&
    message.retractedAt === undefined
  ) {
    await ctx.db.patch(message._id, {
      retractedAt: now,
      retractedByUserId: userId,
    });
  }
}

async function authoredMessageForMutation(
  ctx: MutationCtx & { user: Doc<"users"> },
  messageId: Id<"parentMessages">,
  surface?: ThreadSurface,
): Promise<Doc<"parentMessages">> {
  const message = await ctx.db.get(messageId);
  if (!message || !isHumanParentMessage(message)) {
    throw new Error("Message not found");
  }
  const thread = await ctx.db.get(message.threadId);
  if (!thread) throw new Error("Thread not found");
  await threadViewer(ctx, thread, surface);
  if (message.authorUserId !== ctx.user._id) {
    throw new Error("Forbidden: only the message author may change it");
  }
  return message;
}

export const editMessage = authedMutation({
  args: {
    messageId: v.id("parentMessages"),
    body: v.string(),
    as: threadSurfaceArg,
  },
  handler: async (ctx, args) => {
    const message = await authoredMessageForMutation(
      ctx,
      args.messageId,
      args.as,
    );
    await editMessageBody(ctx, message, ctx.user._id, args.body);
    return { ok: true };
  },
});

export const retractMessage = authedMutation({
  args: {
    messageId: v.id("parentMessages"),
    as: threadSurfaceArg,
  },
  handler: async (ctx, args) => {
    const message = await authoredMessageForMutation(
      ctx,
      args.messageId,
      args.as,
    );
    await retractMessageAndAttachments(ctx, message, ctx.user._id);
    return { ok: true };
  },
});

export const retractAttachment = authedMutation({
  args: {
    attachmentId: v.id("parentMessageAttachments"),
    as: threadSurfaceArg,
  },
  handler: async (ctx, args) => {
    const attachment = await ctx.db.get(args.attachmentId);
    if (!attachment?.messageId) {
      throw new Error("Attachment is not part of a sent message");
    }
    const message = await authoredMessageForMutation(
      ctx,
      attachment.messageId,
      args.as,
    );
    await retractOneAttachment(ctx, message, attachment, ctx.user._id);
    return { ok: true };
  },
});

/** Append a reply. Parent must own the thread; any teacher may reply. */
export const replyInThread = authedMutation({
  args: {
    threadId: v.id("parentThreads"),
    body: v.string(),
    attachmentIds: v.optional(
      v.array(v.id("parentMessageAttachments")),
    ),
    as: threadSurfaceArg,
  },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) throw new Error("Thread not found");
    const viewer = await threadViewer(ctx, thread, args.as);
    const isParent = viewer === "parent";
    const isTeacher = viewer === "teacher";
    const parentUserIds = await threadParticipantIds(ctx, thread);
    const attachments = await prepareAttachments(
      ctx,
      args.attachmentIds,
      ctx.user._id,
      isTeacher ? thread.scholarId : undefined,
    );
    const body = args.body.trim();
    if (!body && attachments.length === 0) {
      throw new Error("Message is empty");
    }
    if (body.length > MAX_BODY) throw new Error("Message is too long");

    const now = Date.now();
    const messageId = await appendMessage(ctx, {
      threadId: thread._id,
      parentUserIds,
      authorType: isParent ? "parent" : "teacher",
      authorUserId: ctx.user._id,
      body,
      now,
      queueOffPortal: isTeacher,
      attachments,
    });
    if (isTeacher) {
      await ctx.scheduler.runAfter(0, internal.parentMessageSend.dispatch, {
        messageIds: [messageId],
      });
    }
    // Stamp the sender's own read marker (you've seen everything up to now).
    if (isParent) {
      await markParentRead(ctx, thread, ctx.user._id, now);
    } else {
      await ctx.db.patch(thread._id, {
        lastReadByTeacherAt: now,
        // A teacher reply claims an unassigned (parent-initiated) thread.
        ...(!thread.teacherId ? { teacherId: ctx.user._id } : {}),
      });
    }
    return { ok: true };
  },
});

/** Parent starts a new thread with the school. */
export const startThread = authedMutation({
  args: {
    body: v.string(),
    attachmentIds: v.optional(
      v.array(v.id("parentMessageAttachments")),
    ),
    scholarId: v.optional(v.id("users")),
    teacherId: v.optional(v.id("users")),
    as: threadSurfaceArg,
  },
  handler: async (ctx, args) => {
    const wantsParentSurface = args.as === "parent" || ctx.user.role === ROLES.PARENT;
    if (!wantsParentSurface || !(await hasGuardianContext(ctx))) {
      throw new Error("Forbidden: parent context required");
    }
    const attachments = await prepareAttachments(
      ctx,
      args.attachmentIds,
      ctx.user._id,
    );
    const body = args.body.trim();
    if (!body && attachments.length === 0) {
      throw new Error("Message is empty");
    }
    if (body.length > MAX_BODY) throw new Error("Message is too long");
    // A parent may only set the subject to one of their OWN children. With one
    // linked child, infer the scholar so the family thread includes all of that
    // child's guardians.
    let subject: Id<"users"> | undefined;
    const links = await ctx.db
      .query("guardianships")
      .withIndex("by_parent", (q) => q.eq("parentUserId", ctx.user._id))
      .collect();
    if (args.scholarId) {
      const link = links.find((row) => row.scholarUserId === args.scholarId);
      if (link) subject = args.scholarId;
    } else if (links.length === 1) {
      subject = links[0].scholarUserId;
    }
    const subjectScholar = subject ? await ctx.db.get(subject) : null;
    if (subjectScholar && isProgramGuest(subjectScholar) && !args.teacherId) {
      throw new Error("Choose the program teacher for this message");
    }
    if (args.teacherId) {
      if (!subject) {
        throw new Error("Choose a child before choosing a teacher");
      }
      const teachers = await parentRecipientTeachers(ctx, subject);
      if (!teachers.some((teacher) => teacher._id === args.teacherId)) {
        throw new Error("Teacher is not available for this child");
      }
    }

    const now = Date.now();
    const parentUserIds = subject
      ? await guardianParentsOfScholar(ctx, subject)
      : [ctx.user._id];
    const threadId = await createThread(ctx, {
      parentUserIds,
      teacherId: args.teacherId,
      scholarId: subject,
      institutionId: subjectScholar?.institutionId,
      now,
    });
    const thread = await ctx.db.get(threadId);
    if (!thread) throw new Error("Thread not found");
    await markParentRead(ctx, thread, ctx.user._id, now);
    await appendMessage(ctx, {
      threadId,
      parentUserIds,
      authorType: "parent",
      authorUserId: ctx.user._id,
      body,
      now,
      attachments,
    });
    return { threadId };
  },
});

/** Stamp the caller's read marker for unread badges. */
export const markThreadRead = authedMutation({
  args: { threadId: v.id("parentThreads"), as: threadSurfaceArg },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) return;
    const now = Date.now();
    const viewer = await threadViewer(ctx, thread, args.as);
    if (viewer === "parent") {
      await markParentRead(ctx, thread, ctx.user._id, now);
    } else {
      await ctx.db.patch(thread._id, { lastReadByTeacherAt: now });
    }
  },
});

// ── Slack teacher-side transport ─────────────────────────────────────────

function newestParentSlackThread(
  rows: Doc<"parentSlackThreads">[],
): Doc<"parentSlackThreads"> | null {
  return rows.reduce<Doc<"parentSlackThreads"> | null>((best, row) => {
    if (!best) return row;
    if (row.lastNotifiedAt !== best.lastNotifiedAt) {
      return row.lastNotifiedAt > best.lastNotifiedAt ? row : best;
    }
    if (row._creationTime !== best._creationTime) {
      return row._creationTime > best._creationTime ? row : best;
    }
    return row._id > best._id ? row : best;
  }, null);
}

export const getSlackNotificationContext = internalQuery({
  args: { messageId: v.id("parentMessages") },
  handler: async (ctx, { messageId }) => {
    const message = await ctx.db.get(messageId);
    if (
      !message ||
      message.authorType !== "parent" ||
      isRetractedMessage(message)
    ) {
      return null;
    }

    const thread = await ctx.db.get(message.threadId);
    if (!thread || !isFamilyThread(thread)) return null;
    // First-party only (TRA-402): the staff channel lives in ONE Slack
    // workspace — the primary school's. Mirror only a thread whose own
    // institution is the LIVE primary one; a second school's, a suspended
    // school's, or a transferred scholar's thread (no institution) stays in
    // the app. (Reading `isPrimary` from the row: the same signal the tenancy
    // helpers use.)
    const institutionId = await threadInstitutionId(ctx, thread);
    const institution = institutionId ? await ctx.db.get(institutionId) : null;
    if (!institution?.isPrimary || institution.disabledAt !== undefined) {
      console.log(
        `parent-message Slack mirror skipped for thread ${thread._id}: not the live primary institution`,
      );
      return null;
    }
    const channel = await ctx.db.query("parentMessageChannel").first();
    if (!channel) return null;
    const parent = message.authorUserId
      ? await ctx.db.get(message.authorUserId)
      : null;

    return {
      messageId,
      threadId: thread._id,
      institutionSlug: institution.slug ?? null,
      channelId: channel.slackChannelId,
      parentName: userDisplayName(parent, "Parent"),
      childName: await childNameForThread(ctx, thread),
      body: message.body,
      attachments: await Promise.all(
        (
          await ctx.db
            .query("parentMessageAttachments")
            .withIndex("by_message", (q) =>
              q.eq("messageId", message._id),
            )
            .collect()
        )
          .filter((attachment) => attachment.retractedAt === undefined)
          .map(async (attachment) => ({
            fileName: attachment.fileName,
            url: await ctx.storage.getUrl(attachment.storageId),
          })),
      ),
    };
  },
});

export const getParentSlackThreadByParentThread = internalQuery({
  args: {
    parentThreadId: v.id("parentThreads"),
    channelId: v.optional(v.string()),
  },
  handler: async (ctx, { parentThreadId, channelId }) => {
    const allRows = await ctx.db
      .query("parentSlackThreads")
      .withIndex("by_parent_thread", (q) => q.eq("parentThreadId", parentThreadId))
      .collect();
    const rows = channelId
      ? allRows.filter((row) => row.channelId === channelId)
      : allRows;
    return newestParentSlackThread(rows);
  },
});

export const recordParentSlackThreadNotification = internalMutation({
  args: {
    parentThreadId: v.id("parentThreads"),
    channelId: v.string(),
    threadTs: v.string(),
    messageId: v.id("parentMessages"),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    // The mirrored message now also lives in the staff Slack channel — a copy
    // a guardian's withdrawal can't recall (copiedChannels "slack").
    const mirrored = await ctx.db.get(args.messageId);
    if (mirrored && mirrored.copiedToSlackAt === undefined) {
      await ctx.db.patch(mirrored._id, { copiedToSlackAt: now });
    }
    const existingAnchor = await ctx.db
      .query("parentSlackThreads")
      .withIndex("by_channel_thread", (q) =>
        q.eq("channelId", args.channelId).eq("threadTs", args.threadTs),
      )
      .first();
    if (existingAnchor) {
      if (existingAnchor.parentThreadId !== args.parentThreadId) {
        throw new Error("Slack parent-message thread anchor collision");
      }
      await ctx.db.patch(existingAnchor._id, {
        lastParentMessageId: args.messageId,
        lastNotifiedAt: now,
      });
      return existingAnchor._id;
    }
    return await ctx.db.insert("parentSlackThreads", {
      parentThreadId: args.parentThreadId,
      channelId: args.channelId,
      threadTs: args.threadTs,
      lastParentMessageId: args.messageId,
      lastNotifiedAt: now,
    });
  },
});

export const ingestInboundSlackReply = internalMutation({
  args: {
    channelId: v.string(),
    threadTs: v.string(),
    slackUserId: v.string(),
    body: v.string(),
    eventId: v.optional(v.string()),
    messageTs: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const providerMessageId =
      args.eventId?.trim() ||
      (args.messageTs ? `${args.channelId}:${args.messageTs}` : undefined);
    const providerKey = providerMessageId
      ? `slack:${providerMessageId}`
      : undefined;
    if (providerKey) {
      const dupe = await ctx.db
        .query("parentMessages")
        .withIndex("by_provider_message", (q) =>
          q.eq("providerMessageId", providerKey),
        )
        .first();
      if (dupe) {
        return {
          handled: true as const,
          ok: true as const,
          action: "duplicate" as const,
          threadId: dupe.threadId,
        };
      }
    }

    const mapping = await ctx.db
      .query("parentSlackThreads")
      .withIndex("by_channel_thread", (q) =>
        q.eq("channelId", args.channelId).eq("threadTs", args.threadTs),
      )
      .first();
    if (!mapping) {
      return { handled: false as const, ok: false as const, reason: "no-mapping" as const };
    }

    const thread = await ctx.db.get(mapping.parentThreadId);
    if (!thread) {
      return { handled: true as const, ok: false as const, reason: "no-thread" as const };
    }
    // A Workshop idea's #workshop root is recorded in this same table (the
    // durable Slack ↔ thread binding). Its replies are NOT family replies:
    // hand them back so slackBot routes them to the Workshop path.
    if (!isFamilyThread(thread)) {
      return {
        handled: false as const,
        ok: false as const,
        reason: "not-family" as const,
      };
    }
    const teacher = await ctx.db
      .query("users")
      .withIndex("by_slackUserId", (q) => q.eq("slackUserId", args.slackUserId))
      .unique();
    if (!teacher) {
      return { handled: true as const, ok: false as const, reason: "unlinked" as const };
    }
    // The same rule as an in-app staff reply (TRA-401): live school:operations
    // at the thread's OWN institution — for every family thread, with or
    // without a subject scholar, never the scholar's current school.
    if (!(await userCanOperateThread(ctx, teacher, thread))) {
      return { handled: true as const, ok: false as const, reason: "unlinked" as const };
    }
    const parentUserIds = await threadParticipantIds(ctx, thread);
    const body = slackTextToMessageBody(args.body).trim();
    if (!body) return { handled: true as const, ok: false as const, reason: "empty" as const };
    if (body.length > MAX_BODY) {
      return { handled: true as const, ok: false as const, reason: "too-long" as const };
    }

    const now = Date.now();
    const messageId = await appendMessage(ctx, {
      threadId: thread._id,
      parentUserIds,
      authorType: "teacher",
      authorUserId: teacher._id,
      body,
      now,
      queueOffPortal: true,
      providerMessageId: providerKey,
      source: "slack",
    });
    await ctx.db.patch(thread._id, {
      lastReadByTeacherAt: now,
      ...(thread.teacherId ? {} : { teacherId: teacher._id }),
    });
    await ctx.db.patch(mapping._id, { lastTeacherReplyAt: now });
    await ctx.scheduler.runAfter(0, internal.parentMessageSend.dispatch, {
      messageIds: [messageId],
    });
    return {
      handled: true as const,
      ok: true as const,
      action: "message" as const,
      threadId: thread._id,
      messageId,
    };
  },
});

// ── Inbound email (reply-by-email → a chat message) ─────────────────────
// A parent replies to a message email; the provider (Resend inbound) POSTs it
// to /parent-message-inbound, which calls this. We parse the thread token from
// the routed recipient (reply+<threadId>@…) and FAIL CLOSED unless the From
// uniquely matches a participant's email. Resend webhooks are at-least-once, so
// providerMessageId deduplicates retries before they can append downstream work.

export const ingestInboundEmail = internalMutation({
  args: {
    toAddress: v.string(),
    fromEmail: v.string(),
    body: v.string(),
    providerMessageId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const m = /reply\+([a-z0-9]+)@/i.exec(args.toAddress);
    if (!m) return { ok: false, reason: "no-thread-token" as const };

    let thread: Doc<"parentThreads"> | null = null;
    try {
      thread = await ctx.db.get(m[1] as Id<"parentThreads">);
    } catch {
      thread = null;
    }
    if (!thread) return { ok: false, reason: "no-thread" as const };
    const kind = threadKind(thread);
    if (kind === "workshop") {
      // Workshop threads never email anyone, so no reply address was issued.
      return { ok: false, reason: "not-accepted" as const };
    }
    if (kind === "mentor") {
      return await ingestMentorEmailReply(ctx, thread, args);
    }

    const parentUserIds = await threadParticipantIds(ctx, thread);
    const parents = await Promise.all(
      parentUserIds.map(async (parentUserId) => ({
        parentUserId,
        parent: await ctx.db.get(parentUserId),
      })),
    );
    const normalizedFrom = args.fromEmail.trim().toLowerCase();
    const exactSenders = parents.filter(
      ({ parent }) => parent?.email?.trim().toLowerCase() === normalizedFrom,
    );
    const aliasSenders =
      exactSenders.length === 0
        ? parents.filter(
            ({ parent }) =>
              !!parent?.email &&
              (emailMailboxesMatch(parent.email, args.fromEmail) ||
                emailTaggedMailboxesMatch(parent.email, args.fromEmail)),
          )
        : [];
    const sender =
      exactSenders.length === 1
        ? exactSenders[0]
        : aliasSenders.length === 1
          ? aliasSenders[0]
          : null;
    if (!sender) {
      return { ok: false, reason: "sender-mismatch" as const }; // FAIL CLOSED
    }
    if (args.providerMessageId) {
      const duplicate = await ctx.db
        .query("parentMessages")
        .withIndex("by_provider_message", (q) =>
          q.eq("providerMessageId", args.providerMessageId),
        )
        .first();
      if (duplicate) {
        return {
          ok: true as const,
          action: "duplicate" as const,
          threadId: thread._id,
        };
      }
    }
    const body = args.body.trim();
    if (!body) return { ok: false, reason: "empty" as const };
    if (body.length > MAX_BODY) {
      return { ok: false, reason: "too-long" as const };
    }

    const now = Date.now();
    await appendMessage(ctx, {
      threadId: thread._id,
      parentUserIds,
      authorType: "parent",
      authorUserId: sender.parentUserId,
      body,
      now,
      providerMessageId: args.providerMessageId,
    });
    await markParentRead(ctx, thread, sender.parentUserId, now);
    return { ok: true as const, action: "message" as const, threadId: thread._id };
  },
});

/**
 * A mentor answering a "a scholar wrote" email. The reply address names the
 * thread; the SENDER must be a named mentor on it whose access still holds
 * (grant not revoked), matched exactly or as a mailbox alias of their own
 * address — never a forwarded/CC'd copy from someone else's mailbox. Posts as
 * that mentor (authorType "teacher"). Nothing is sent onward: the scholar is
 * notified in-app only.
 */
async function ingestMentorEmailReply(
  ctx: MutationCtx,
  thread: Doc<"parentThreads">,
  args: { fromEmail: string; body: string; providerMessageId?: string },
) {
  const scholar = await scholarForThread(ctx, thread);
  if (!scholar) return { ok: false, reason: "no-thread" as const };
  const rows = await ctx.db
    .query("parentThreadParticipants")
    .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
    .collect();
  const mentors = (
    await Promise.all(
      rows
        .filter((row) => row.side === "staff")
        .map(async (row) => ({ row, user: await ctx.db.get(row.parentUserId) })),
    )
  ).filter(
    (candidate): candidate is { row: Doc<"parentThreadParticipants">; user: Doc<"users"> } =>
      candidate.user !== null && !!candidate.user.email,
  );
  const normalizedFrom = args.fromEmail.trim().toLowerCase();
  const exact = mentors.filter(
    ({ user }) => user.email!.trim().toLowerCase() === normalizedFrom,
  );
  const alias =
    exact.length === 0
      ? mentors.filter(
          ({ user }) =>
            emailMailboxesMatch(user.email!, args.fromEmail) ||
            emailTaggedMailboxesMatch(user.email!, args.fromEmail),
        )
      : [];
  const sender =
    exact.length === 1 ? exact[0] : alias.length === 1 ? alias[0] : null;
  if (!sender) return { ok: false, reason: "sender-mismatch" as const };
  if (!(await staffCanReachScholar(ctx, sender.user, scholar, "mentor")).ok) {
    return { ok: false, reason: "sender-mismatch" as const };
  }
  if (args.providerMessageId) {
    const duplicate = await ctx.db
      .query("parentMessages")
      .withIndex("by_provider_message", (q) =>
        q.eq("providerMessageId", args.providerMessageId),
      )
      .first();
    if (duplicate) {
      return { ok: true as const, action: "duplicate" as const, threadId: thread._id };
    }
  }
  const body = args.body.trim();
  if (!body) return { ok: false, reason: "empty" as const };
  if (body.length > MAX_BODY) return { ok: false, reason: "too-long" as const };

  const now = Date.now();
  await appendMessage(ctx, {
    threadId: thread._id,
    parentUserIds: rows.map((row) => row.parentUserId),
    authorType: "teacher",
    authorUserId: sender.user._id,
    body,
    now,
    providerMessageId: args.providerMessageId,
  });
  // Same read semantics as an in-app reply: the mentor's own marker, and the
  // team marker only if the author is on the teaching team.
  await markStaffRead(ctx, thread, sender.user, now);
  return { ok: true as const, action: "message" as const, threadId: thread._id };
}

// ── Off-portal channel consent (sms / whatsapp) ─────────────────────────
// Email is on by default; phone channels are OFF until the parent opts in.
// The easiest opt-in (Andy): the parent taps the wa.me link / scans the QR,
// which prefills "optin:<their id>"; messaging the school number then links
// their WhatsApp on inbound (no manual number entry). They self-serve here.

export const getMyChannels = authedQuery({
  args: {},
  handler: async (ctx) => {
    const optInLink =
      ctx.user.role === ROLES.PARENT
        ? await whatsAppOptInLink(ctx.user._id)
        : null;
    if (ctx.user.role !== ROLES.PARENT) {
      return { channels: [], whatsappOptInLink: null, whatsappConfigured: false };
    }
    const rows = await ctx.db
      .query("parentChannelIdentities")
      .withIndex("by_parent", (q) => q.eq("parentUserId", ctx.user._id))
      .collect();
    return {
      channels: rows.map((r) => ({
        _id: r._id,
        channel: r.channel,
        identity: r.identity,
        optedIn: !!r.optInAt && r.stopState !== true,
        stopped: r.stopState === true,
      })),
      whatsappOptInLink: optInLink,
      whatsappConfigured: !!optInLink,
    };
  },
});

/** Parent self-serve: pause / resume one of their own phone channels. */
export const setMyChannelStopped = authedMutation({
  args: { channelId: v.id("parentChannelIdentities"), stopped: v.boolean() },
  handler: async (ctx, args) => {
    if (ctx.user.role !== ROLES.PARENT) throw new Error("Forbidden");
    const row = await ctx.db.get(args.channelId);
    if (!row || row.parentUserId !== ctx.user._id) {
      throw new Error("Channel not found");
    }
    await ctx.db.patch(args.channelId, {
      stopState: args.stopped,
      optInAt: row.optInAt ?? Date.now(),
    });
  },
});

// ── Inbound WhatsApp (one normalizer) ───────────────────────────────────
// The Meta Cloud API webhook (/wa-inbound) calls this for each inbound message.
// Three cases: a STOP keyword (opt out), an "optin:<id>" token (link the
// sender's number to that parent), or a normal message (routed to the parent's
// thread. A normal message from an UNMAPPED number FAILS CLOSED. (`channel`
// keeps an "sms" arm for schema compatibility, but the Cloud API only ever
// delivers "whatsapp".)

export const ingestInboundPhone = internalMutation({
  args: {
    channel: v.union(v.literal("sms"), v.literal("whatsapp")),
    fromNumber: v.string(),
    body: v.string(),
    messageId: v.optional(v.string()), // provider wamid, for dedup
  },
  handler: async (ctx, { channel, fromNumber, body, messageId }) => {
    // Idempotency: Meta delivers webhooks at-least-once and retries on any
    // non-200, so a replayed inbound must NOT re-append + re-trigger the bot.
    if (messageId) {
      const dupe = await ctx.db
        .query("parentMessages")
        .withIndex("by_provider_message", (q) =>
          q.eq("providerMessageId", messageId),
        )
        .first();
      if (dupe) {
        return {
          ok: true as const,
          action: "duplicate" as const,
        };
      }
    }
    // Canonical identity = digits only. Twilio sent "whatsapp:+1650…"; the Cloud
    // API sends a bare "1650…" — normalize both so stored identities match
    // regardless of provider (deliverOffPortal also sends to the digits form).
    const identity = fromNumber.replace(/[^\d]/g, "");

    if (isStopKeyword(body)) {
      const rows = await ctx.db
        .query("parentChannelIdentities")
        .withIndex("by_identity", (q) => q.eq("channel", channel).eq("identity", identity))
        .collect();
      for (const r of rows) await ctx.db.patch(r._id, { stopState: true });
      return {
        ok: true as const,
        action: "stopped" as const,
      };
    }

    const token = await parseOptInToken(body);
    if (token) {
      let parent: Doc<"users"> | null = null;
      try {
        parent = await ctx.db.get(token as Id<"users">);
      } catch {
        parent = null;
      }
      if (!parent || parent.role !== ROLES.PARENT) {
        return {
          ok: false as const,
          reason: "bad-token" as const,
        };
      }
      const existing = await ctx.db
        .query("parentChannelIdentities")
        .withIndex("by_identity", (q) => q.eq("channel", channel).eq("identity", identity))
        .first();
      // Idempotency: a re-delivered opt-in webhook (same wamid) must not re-link
      // or re-send the welcome — that would double-message the parent.
      if (existing && messageId && existing.lastInboundMessageId === messageId) {
        return { ok: true as const, action: "duplicate" as const };
      }
      if (existing) {
        await ctx.db.patch(existing._id, {
          parentUserId: parent._id,
          optInAt: Date.now(),
          consentSource: "self-serve",
          stopState: false,
          lastInboundAt: Date.now(),
          lastInboundMessageId: messageId,
        });
      } else {
        await ctx.db.insert("parentChannelIdentities", {
          parentUserId: parent._id,
          channel,
          identity,
          optInAt: Date.now(),
          consentSource: "self-serve",
          lastInboundAt: Date.now(),
          lastInboundMessageId: messageId,
        });
      }
      // Send a one-time orientation message back so the parent knows it worked.
      // The inbound just re-opened the WhatsApp 24h window, so free-form is
      // allowed.
      const childLinks = await ctx.db
        .query("guardianships")
        .withIndex("by_parent", (q) => q.eq("parentUserId", parent._id))
        .collect();
      const childNames: string[] = [];
      for (const l of childLinks) {
        const child = await ctx.db.get(l.scholarUserId);
        if (child?.name) childNames.push(child.name);
      }
      await ctx.scheduler.runAfter(0, internal.parentMessageSend.sendOptInWelcome, {
        channel,
        identity,
        childNames,
      });
      return {
        ok: true as const,
        action: "opted-in" as const,
      };
    }

    // A normal message — only from a known, opted-in number (FAIL CLOSED).
    const idRow = await ctx.db
      .query("parentChannelIdentities")
      .withIndex("by_identity", (q) => q.eq("channel", channel).eq("identity", identity))
      .first();
    if (!idRow || idRow.stopState === true || !idRow.optInAt) {
      return {
        ok: false as const,
        reason: "unmapped" as const,
      };
    }
    const text = body.trim();
    if (!text) {
      return {
        ok: false as const,
        reason: "empty" as const,
      };
    }

    const parentUserId = idRow.parentUserId;
    const now = Date.now();
    // A real inbound re-opens the WhatsApp 24h window.
    await ctx.db.patch(idRow._id, { lastInboundAt: now });
    const threads = await guardianFamilyThreads(ctx, parentUserId);
    threads.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
    let thread: Doc<"parentThreads"> | null = threads[0] ?? null;
    if (!thread) {
      const links = await ctx.db
        .query("guardianships")
        .withIndex("by_parent", (q) => q.eq("parentUserId", parentUserId))
        .collect();
      const scholarId = links.length === 1 ? links[0].scholarUserId : undefined;
      const parentUserIds = scholarId
        ? await guardianParentsOfScholar(ctx, scholarId)
        : [parentUserId];
      const threadId = await getOrCreateThread(ctx, {
        parentUserIds,
        scholarId,
        now,
      });
      thread = await ctx.db.get(threadId);
    }
    if (!thread) throw new Error("Thread not found");
    const parentUserIds = await threadParticipantIds(ctx, thread);

    await appendMessage(ctx, {
      threadId: thread._id,
      parentUserIds,
      authorType: "parent",
      authorUserId: parentUserId,
      body: text,
      now,
      providerMessageId: messageId,
    });
    await markParentRead(ctx, thread, parentUserId, now);
    return { ok: true as const, action: "message" as const, threadId: thread._id };
  },
});

/** One-time cutover: normalize parentChannelIdentities.identity to digits only
 *  (Twilio stored "+1650…"; the Meta Cloud API uses a bare "1650…"). Idempotent
 *  — safe to re-run; drops a non-canonical row if a canonical twin exists. */
export const normalizeChannelIdentities = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("parentChannelIdentities").collect();
    let fixed = 0;
    let deletedDup = 0;
    for (const r of rows) {
      const norm = r.identity.replace(/[^\d]/g, "");
      if (norm === r.identity) continue;
      const twin = await ctx.db
        .query("parentChannelIdentities")
        .withIndex("by_identity", (q) =>
          q.eq("channel", r.channel).eq("identity", norm),
        )
        .first();
      if (twin) {
        await ctx.db.delete(r._id); // a canonical row already exists
        deletedDup++;
      } else {
        await ctx.db.patch(r._id, { identity: norm });
        fixed++;
      }
    }
    return { scanned: rows.length, fixed, deletedDup };
  },
});
