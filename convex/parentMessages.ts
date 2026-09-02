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
import { previewableMessageLink } from "../lib/messageLinks";
import {
  attributedScholarIds,
  isAttributedToScholar,
} from "./lib/portfolioAttributions";
import {
  portfolioFamilySharingEligibility,
  portfolioItemContainsIdentifiableMedia,
} from "./lib/schoolMediaConsent";
import { assignmentResolved } from "./lib/portfolioStatus";
import type { Id, Doc } from "./_generated/dataModel";
import type { QueryCtx, MutationCtx } from "./_generated/server";

const MAX_BODY = 8000;

// ctx shape after the authed/teacher custom-function wrappers attach `user`.
type AuthedQueryCtx = QueryCtx & { user: Doc<"users"> };
type AuthedCtx = (QueryCtx | MutationCtx) & { user: Doc<"users"> };
type PreparedAttachment = Doc<"parentMessageAttachments"> & {
  messageId?: undefined;
  threadId?: undefined;
};

async function requireSchoolOperationsForScholars(
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
  ctx: AuthedCtx,
  thread: Doc<"parentThreads">,
): Promise<Id<"institutions"> | null> {
  return await unambiguousInstitutionForParents(
    ctx,
    await threadParticipantIds(ctx, thread),
  );
}

async function threadInstitutionId(
  ctx: AuthedCtx,
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

async function canOperateThread(
  ctx: AuthedCtx,
  thread: Doc<"parentThreads">,
): Promise<boolean> {
  const institutionId = await threadInstitutionId(ctx, thread);
  return !!(
    institutionId &&
    (await hasSchoolOperationsAccessAtInstitution(
      ctx,
      ctx.user,
      institutionId,
    ))
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
  if (isPortfolioAttachment(attachment)) {
    const item = attachment.portfolioItemId
      ? await ctx.db.get(attachment.portfolioItemId)
      : null;
    if (item?.fileStorageId === attachment.storageId) return;
  }
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

async function prepareAttachments(
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
      });
    }
  }
}

function attachmentPreview(
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

async function guardianParentsOfScholar(
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
  ).filter((teacher): teacher is Doc<"users"> => teacher !== null);
  return teachers
    .map((teacher) => ({
      _id: teacher._id,
      name: userDisplayName(teacher, "Teacher"),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function threadParticipantIds(
  ctx: QueryCtx | MutationCtx,
  thread: Doc<"parentThreads">,
): Promise<Id<"users">[]> {
  const rows = await ctx.db
    .query("parentThreadParticipants")
    .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
    .collect();
  return rows.length > 0
    ? [...new Set(rows.map((row) => row.parentUserId))]
    : [thread.parentUserId];
}

async function ensureThreadParticipants(
  ctx: MutationCtx,
  threadId: Id<"parentThreads">,
  parentUserIds: Id<"users">[],
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

function userDisplayName(user: Doc<"users"> | null, fallback: string): string {
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

/**
 * Register a freshly uploaded file to the current user before any family
 * message may reference it. Unclaimed rows self-delete after 24 hours.
 */
export const registerAttachmentUpload = authedMutation({
  args: {
    storageId: v.id("_storage"),
    fileName: v.string(),
    mimeType: v.optional(v.string()),
    sizeBytes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const storage = await ctx.db.system.get("_storage", args.storageId);
    if (!storage) throw new Error("Uploaded file was not found");
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

    const existing = await ctx.db
      .query("parentMessageAttachments")
      .withIndex("by_storage", (q) => q.eq("storageId", args.storageId))
      .first();
    if (existing) {
      if (
        existing.uploaderId !== ctx.user._id ||
        existing.messageId ||
        existing.threadId
      ) {
        throw new Error("Attachment is not available");
      }
      return { attachmentId: existing._id };
    }

    const attachmentId = await ctx.db.insert("parentMessageAttachments", {
      storageId: args.storageId,
      uploaderId: ctx.user._id,
      fileName,
      mimeType: mimeType || "application/octet-stream",
      sizeBytes: storage.size,
      source: "upload",
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
async function createThread(
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
  const threadId = await ctx.db.insert("parentThreads", {
    parentUserId: parentUserIds[0],
    teacherId: opts.teacherId,
    scholarId: opts.scholarId,
    institutionId,
    broadcastId: opts.broadcastId,
    lastMessageAt: opts.now,
  });
  await ensureThreadParticipants(ctx, threadId, parentUserIds);
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

/** Append a message + its per-channel delivery rows (portal sent immediately). */
async function appendMessage(
  ctx: MutationCtx,
  opts: {
    threadId: Id<"parentThreads">;
    parentUserIds: Id<"users">[];
    authorType: "teacher" | "parent";
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
  },
): Promise<Id<"parentMessages">> {
  const messageId = await ctx.db.insert("parentMessages", {
    threadId: opts.threadId,
    authorType: opts.authorType,
    authorUserId: opts.authorUserId,
    body: opts.body,
    broadcastId: opts.broadcastId,
    providerMessageId: opts.providerMessageId,
    source: opts.source,
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
  if (opts.queueOffPortal) {
    const emailRecipients: Id<"users">[] = [];
    for (const parentUserId of parentUserIds) {
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
  const patch: Record<string, number> = { lastMessageAt: opts.now };
  if (opts.authorType === "parent") {
    patch.lastParentToTeacherAt = opts.now;
  }
  // Every human message is new to the other guardians; the sender's own
  // participant read marker is stamped immediately by the caller.
  patch.lastToParentAt = opts.now;
  await ctx.db.patch(opts.threadId, patch);
  if (opts.authorType === "parent") {
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

const threadSurfaceArg = v.optional(v.union(v.literal("parent"), v.literal("staff")));

async function threadViewer(
  ctx: AuthedCtx,
  thread: Doc<"parentThreads">,
  surface?: ThreadSurface,
): Promise<Viewer> {
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
) {
  threads.sort((a, b) => b.lastMessageAt - a.lastMessageAt);

  return await Promise.all(
    threads.map(async (t) => {
      const msgs = await ctx.db
        .query("parentMessages")
        .withIndex("by_thread", (q) => q.eq("threadId", t._id))
        .collect();
      const humanMessages = msgs.filter((message) => message.authorType !== "bot");
      const last = humanMessages[humanMessages.length - 1];
      const lastAttachments = last
        ? await ctx.db
            .query("parentMessageAttachments")
            .withIndex("by_message", (q) => q.eq("messageId", last._id))
            .collect()
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
          : "",
        lastAuthorType: last?.authorType ?? null,
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
      };
    }),
  );
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
    const participantRows = await ctx.db
      .query("parentThreadParticipants")
      .withIndex("by_parent", (q) => q.eq("parentUserId", ctx.user._id))
      .collect();
    const participantThreads = (
      await Promise.all(participantRows.map((row) => ctx.db.get(row.threadId)))
    ).filter((thread): thread is Doc<"parentThreads"> => thread !== null);
    const legacyThreads = await ctx.db
      .query("parentThreads")
      .withIndex("by_parent", (q) => q.eq("parentUserId", ctx.user._id))
      .collect();
    const threads = [
      ...new Map(
        [...participantThreads, ...legacyThreads].map((thread) => [
          thread._id,
          thread,
        ]),
      ).values(),
    ];
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
 * Thread list for the caller. Parents see ONLY their own threads. Teachers
 * default to threads they authored (scope "mine"); scope "all" returns the
 * roster-wide parent-thread list (any teacher is trusted) — used by the
 * staff Messages inbox.
 */
export const listMyThreads = authedQuery({
  args: {
    // Inbox toggle: "mine" (threads I own) vs "all" (every staff thread).
    scope: v.optional(v.union(v.literal("mine"), v.literal("all"))),
    // Active institution lens (?inst=): "" = home, "all", or a slug. Narrows the
    // staff inbox to threads about scholars in the resolved institution scope.
    institutionScope: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const role = ctx.user.role;
    let threads: Doc<"parentThreads">[];
    let viewer: Viewer;
    if (role === ROLES.PARENT) {
      const participantRows = await ctx.db
        .query("parentThreadParticipants")
        .withIndex("by_parent", (q) => q.eq("parentUserId", ctx.user._id))
        .collect();
      const participantThreads = (
        await Promise.all(participantRows.map((row) => ctx.db.get(row.threadId)))
      ).filter((thread): thread is Doc<"parentThreads"> => thread !== null);
      const legacyThreads = await ctx.db
        .query("parentThreads")
        .withIndex("by_parent", (q) => q.eq("parentUserId", ctx.user._id))
        .collect();
      threads = [
        ...new Map(
          [...participantThreads, ...legacyThreads].map((thread) => [
            thread._id,
            thread,
          ]),
        ).values(),
      ];
      viewer = "parent";
    } else {
      if (args.scope === "all") {
        threads = await ctx.db.query("parentThreads").collect();
      } else {
        threads = await ctx.db
          .query("parentThreads")
          .withIndex("by_teacher", (q) => q.eq("teacherId", ctx.user._id))
          .collect();
      }
      threads = (
        await Promise.all(
          threads.map(async (thread) =>
            (await canOperateThread(ctx, thread)) ? thread : null,
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
      viewer = "teacher";
    }

    return await summarizeThreads(ctx, threads, viewer);
  },
});

function previewOf(body: string): string {
  const t = body.replace(/\s+/g, " ").trim();
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
      messages: visibleMessages
        .map((m) => ({
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
          body: m.body,
          createdAt: m._creationTime,
          // Transport provenance ("via Slack") is teacher-facing only — a parent
          // doesn't need to know which channel the teacher happened to reply from.
          source: viewer === "teacher" ? m.source ?? null : null,
        })),
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
    if (!message || !isHumanParentMessage(message)) return null;
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
    for (const attachment of attachments) {
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
      })),
    );
  },
});

// ── Writes (shared) ─────────────────────────────────────────────────────

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
    if (!message || message.authorType !== "parent") return null;

    const thread = await ctx.db.get(message.threadId);
    if (!thread) return null;
    const channel = await ctx.db.query("parentMessageChannel").first();
    if (!channel) return null;
    const parent = message.authorUserId
      ? await ctx.db.get(message.authorUserId)
      : null;

    return {
      messageId,
      threadId: thread._id,
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
        ).map(async (attachment) => ({
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

    const teacher = await ctx.db
      .query("users")
      .withIndex("by_slackUserId", (q) => q.eq("slackUserId", args.slackUserId))
      .unique();
    if (!teacher) {
      return { handled: true as const, ok: false as const, reason: "unlinked" as const };
    }
    const thread = await ctx.db.get(mapping.parentThreadId);
    if (!thread) {
      return { handled: true as const, ok: false as const, reason: "no-thread" as const };
    }
    if (thread.scholarId) {
      const scholar = await ctx.db.get(thread.scholarId);
      if (
        !scholar?.institutionId ||
        !(await hasSchoolOperationsAccessAtInstitution(
          ctx,
          teacher,
          scholar.institutionId,
        ))
      ) {
        return { handled: true as const, ok: false as const, reason: "unlinked" as const };
      }
    }
    const parentUserIds = await threadParticipantIds(ctx, thread);
    const body = args.body.trim();
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
    const participantRows = await ctx.db
      .query("parentThreadParticipants")
      .withIndex("by_parent", (q) => q.eq("parentUserId", parentUserId))
      .collect();
    const participantThreads = (
      await Promise.all(participantRows.map((row) => ctx.db.get(row.threadId)))
    ).filter((thread): thread is Doc<"parentThreads"> => thread !== null);
    const legacyThreads = await ctx.db
      .query("parentThreads")
      .withIndex("by_parent", (q) => q.eq("parentUserId", parentUserId))
      .collect();
    const threads = [
      ...new Map(
        [...participantThreads, ...legacyThreads].map((thread) => [
          thread._id,
          thread,
        ]),
      ).values(),
    ];
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
