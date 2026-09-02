import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import {
  authedQuery,
  authedMutation,
} from "./lib/customFunctions";
import { ROLES, isPlatformAdminRole, isTeacherRole } from "./lib/roles";
import { internal } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { readScholarDocuments } from "./lib/scholarReads";
import { requireActiveScholarAccess } from "./lib/access";
import { institutionPromptProfileForScholar } from "./lib/institutionPromptProfile";
import { scholarFormsAllowed } from "./lib/formInstitutionGate";
import {
  documentKindUsesExtraction,
  requireKindAccess,
} from "./lib/documentKinds";
import {
  attachableHealthKinds,
  hasSignedHealthRecord,
  listHealthDocumentsForStaff,
  staffScholarAccessible,
} from "./scholarHealthRecords";

/**
 * Scholar Documents — Phase 2, cognitive-assessment-first onboarding.
 *
 * HARD RULE: every read of a scholarDocuments ROW is gated to teacher + admin.
 * Scholars must NEVER read any field of scholarDocuments — especially not
 * extractedText or redactedSummary. Treat the role gate as load-bearing.
 *
 * The one endpoint here that a non-teacher may call is
 * `listDocumentsForStaff`, and it enforces exactly that rule: a health-authorized
 * staffer gets the HEALTH half of the merged list and this table is never queried
 * on their behalf.
 *
 * The extracted text is raw PDF OCR (may contain subscores, medical history,
 * etc). The redactedSummary feeds downstream AI calls that generate directives
 * and seeds, which eventually surface to the scholar via the tutor. If
 * anything sensitive leaks past the redaction pass, it ends up in front of
 * the kid. Be paranoid.
 */

// ── Internal helpers ────────────────────────────────────────────────────

/** Throw unless the current user is teacher or admin. Used on every public fn. */
async function requireTeacherOrAdmin(
  ctx: { user: Doc<"users"> }
): Promise<Doc<"users">> {
  const role = ctx.user.role;
  if (!isTeacherRole(role)) {
    throw new Error("Forbidden: teacher or admin role required");
  }
  return ctx.user;
}

async function logAccess(
  ctx: MutationCtx,
  args: {
    documentId: Doc<"scholarDocuments">["_id"];
    scholarId: Doc<"users">["_id"];
    userId: Doc<"users">["_id"];
    action:
      | "upload"
      | "view_summary"
      | "view_extracted"
      | "download_pdf"
      | "delete"
      | "generate_proposal"
      | "apply_proposal";
  }
): Promise<void> {
  await ctx.db.insert("documentAccessLog", args);
}

// ── Mutations (public, teacher + admin only) ────────────────────────────

/**
 * Generate a short-lived upload URL for the client to PUT bytes to.
 * Teacher/admin only.
 */
export const generateUploadUrl = authedMutation({
  args: {},
  handler: async (ctx) => {
    await requireTeacherOrAdmin(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Register an uploaded document. Called by the client after it has PUT the
 * bytes to the upload URL.
 *
 * NOTE on consent: we assume consent to upload cognitive/assessment documents
 * is implicit from enrollment. When/if we add an explicit per-document consent
 * toggle (parent sign-off, granular purpose), gate it here before insert.
 */
export const registerUpload = authedMutation({
  args: {
    scholarId: v.id("users"),
    kind: v.union(
      v.literal("assessment"),
      v.literal("iep"),
      v.literal("report_card"),
      v.literal("identity_document"),
      v.literal("parent_email"),
      v.literal("observation"),
      v.literal("other"),
    ),
    title: v.string(),
    fileStorageId: v.id("_storage"),
    fileMimeType: v.optional(v.string()),
    fileSizeBytes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await requireTeacherOrAdmin(ctx);
    requireKindAccess(user.role, args.kind);

    // Verify scholar exists and is a scholar role (don't allow uploading
    // "documents" against a teacher/admin account by mistake).
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar) throw new Error("Scholar not found");
    await requireActiveScholarAccess(ctx, user, args.scholarId);

    const documentId = await ctx.db.insert("scholarDocuments", {
      scholarId: args.scholarId,
      kind: args.kind,
      format: "file",
      title: args.title.trim() || "Untitled document",
      fileStorageId: args.fileStorageId,
      fileMimeType: args.fileMimeType,
      fileSizeBytes: args.fileSizeBytes,
      uploadedBy: user._id,
      processingStatus: documentKindUsesExtraction(args.kind)
        ? "pending"
        : "ready",
      // Sensitive uploads reach the tutor only via a teacher-approved proposal,
      // never the auto-injected "background notes" section. Teacher can opt in.
      feedsTutor: false,
    });

    await logAccess(ctx, {
      documentId,
      scholarId: args.scholarId,
      userId: user._id,
      action: "upload",
    });

    if (documentKindUsesExtraction(args.kind)) {
      await ctx.scheduler.runAfter(
        0,
        internal.scholarDocumentActions.extractAndRedact,
        { documentId },
      );
    }

    return { documentId };
  },
});

// ── Text reports & Google Doc links (teacher-authored documents) ─────────

/**
 * Create a teacher-authored TEXT document (default: a Teacher Report). The body
 * is the source of truth, shown verbatim to teachers — but it still flows
 * through the SAME redaction pass as uploads (bodyText is seeded as
 * extractedText), so the scholar-facing tutor only ever sees the redacted*
 * variant. Sensitivity is handled by the pipeline, not by which input was used.
 */
export const createTextReport = authedMutation({
  args: {
    scholarId: v.id("users"),
    kind: v.optional(
      v.union(
        v.literal("teacher_report"),
        v.literal("observation"),
        v.literal("other"),
      ),
    ),
    title: v.string(),
    bodyText: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireTeacherOrAdmin(ctx);
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar) throw new Error("Scholar not found");
    await requireActiveScholarAccess(ctx, user, args.scholarId);

    const body = args.bodyText.trim();
    if (!body) throw new Error("Report body is empty");

    const documentId = await ctx.db.insert("scholarDocuments", {
      scholarId: args.scholarId,
      kind: args.kind ?? "teacher_report",
      format: "text",
      title: args.title.trim() || "Untitled report",
      bodyText: body,
      // Seed extractedText so the redaction action skips file extraction and
      // redacts the teacher's words directly.
      extractedText: body,
      uploadedBy: user._id,
      processingStatus: "pending",
      // Teacher-authored notes inform the tutor by default (per Andy, Jun 2026).
      feedsTutor: true,
    });

    await logAccess(ctx, {
      documentId,
      scholarId: args.scholarId,
      userId: user._id,
      action: "upload",
    });

    await ctx.scheduler.runAfter(
      0,
      internal.scholarDocumentActions.extractAndRedact,
      { documentId },
    );

    return { documentId };
  },
});

/**
 * Edit a text document's title/body. Re-runs redaction when the body changes so
 * the scholar-facing variant tracks the teacher's edits. Text documents only.
 */
export const updateTextReport = authedMutation({
  args: {
    documentId: v.id("scholarDocuments"),
    title: v.optional(v.string()),
    bodyText: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = await requireTeacherOrAdmin(ctx);
    const doc = await ctx.db.get(args.documentId);
    if (!doc) throw new Error("Document not found");
    if (doc.format !== "text") throw new Error("Not a text document");
    await requireActiveScholarAccess(ctx, user, doc.scholarId);

    const updates: {
      title?: string;
      bodyText?: string;
      extractedText?: string;
      processingStatus?: "pending";
    } = {};
    if (args.title !== undefined) updates.title = args.title.trim() || doc.title;
    let bodyChanged = false;
    if (args.bodyText !== undefined) {
      const body = args.bodyText.trim();
      if (!body) throw new Error("Report body is empty");
      updates.bodyText = body;
      updates.extractedText = body;
      updates.processingStatus = "pending";
      bodyChanged = true;
    }
    await ctx.db.patch(args.documentId, updates);

    if (bodyChanged) {
      await ctx.scheduler.runAfter(
        0,
        internal.scholarDocumentActions.extractAndRedact,
        { documentId: args.documentId },
      );
    }
  },
});

/**
 * Link an existing Google Doc (link-only). We store the Drive id + url, never
 * the document's contents, so nothing is ingested or redacted and nothing
 * reaches the tutor. A future "pull text" action could ingest + redact it.
 */
export const addGoogleDocLink = authedMutation({
  args: {
    scholarId: v.id("users"),
    kind: v.optional(
      v.union(
        v.literal("teacher_report"),
        v.literal("observation"),
        v.literal("other"),
      ),
    ),
    title: v.string(),
    link: v.object({
      driveFileId: v.string(),
      url: v.string(),
      name: v.optional(v.string()),
      mimeType: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const user = await requireTeacherOrAdmin(ctx);
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar) throw new Error("Scholar not found");
    await requireActiveScholarAccess(ctx, user, args.scholarId);

    const documentId = await ctx.db.insert("scholarDocuments", {
      scholarId: args.scholarId,
      kind: args.kind ?? "teacher_report",
      format: "gdoc",
      title:
        args.title.trim() || args.link.name?.trim() || "Linked Google Doc",
      link: args.link,
      uploadedBy: user._id,
      // Link-only: nothing to process.
      processingStatus: "ready",
      // No content stored, so nothing feeds the tutor.
      feedsTutor: false,
    });

    await logAccess(ctx, {
      documentId,
      scholarId: args.scholarId,
      userId: user._id,
      action: "upload",
    });

    return { documentId };
  },
});

/**
 * Hard-delete a document (and its underlying storage file). Teacher/admin only.
 * Leaves the access log entries behind (we want the audit trail to survive).
 */
export const deleteDocument = authedMutation({
  args: { documentId: v.id("scholarDocuments") },
  handler: async (ctx, args) => {
    const user = await requireTeacherOrAdmin(ctx);
    const doc = await ctx.db.get(args.documentId);
    if (!doc) return;
    await requireActiveScholarAccess(ctx, user, doc.scholarId);

    if (doc.fileStorageId) {
      try {
        await ctx.storage.delete(doc.fileStorageId);
      } catch (err) {
        // File may already be gone; log but don't fail the delete.
        console.warn(
          `[scholarDocuments.delete] storage.delete failed for ${doc.fileStorageId}:`,
          err
        );
      }
    }

    await ctx.db.delete(args.documentId);

    await logAccess(ctx, {
      documentId: args.documentId,
      scholarId: doc.scholarId,
      userId: user._id,
      action: "delete",
    });
  },
});

// ── Queries (public, teacher + admin only) ──────────────────────────────

/** The metadata-only shape returned by every list endpoint. No extractedText,
 * no redactedSummary — hoisted so the two lists can't drift apart. */
function scholarDocumentRow(r: Doc<"scholarDocuments">) {
  return {
    _id: r._id,
    _creationTime: r._creationTime,
    scholarId: r.scholarId,
    kind: r.kind,
    format: r.format ?? "file",
    title: r.title,
    // Teacher-authored content (text reports) — safe to surface in the list
    // for a snippet; the whole table is teacher/admin-gated. Uploaded files
    // never put their (sensitive) summary text here.
    bodyText: r.bodyText,
    link: r.link,
    feedsTutor: r.feedsTutor,
    fileMimeType: r.fileMimeType,
    fileSizeBytes: r.fileSizeBytes,
    uploadedBy: r.uploadedBy,
    processingStatus: r.processingStatus,
    processingError: r.processingError,
    hasFile: r.fileStorageId != null,
    hasExtractedText: r.extractedText != null,
    // Teacher-facing existence flag + bullets (fall back to legacy fields for
    // documents processed before the summary/redacted split).
    hasSummary: (r.summary ?? r.redactedSummary) != null,
    keyFindings: r.keyFindings,
  };
}

/**
 * List documents for a scholar, newest-first. Returns METADATA ONLY — no
 * extractedText, no redactedSummary. That split is intentional: the list view
 * should never leak summary text, and the separate `get` endpoint logs the
 * summary access so we know who opened what.
 */
export const listForScholar = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await requireTeacherOrAdmin(ctx);
    await requireActiveScholarAccess(ctx, user, args.scholarId);

    const rows = await ctx.db
      .query("scholarDocuments")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .order("desc")
      .collect();

    return rows.map(scholarDocumentRow);
  },
});

/**
 * The scholar's documents as STAFF see them: the `scholarDocuments` rows above
 * PLUS the health documents attached to their signed health record, merged
 * into one newest-first list.
 *
 * The two halves live in different tables on purpose and that stays true here
 * — this merges the LIST, not the TABLES. A health row is a pointer into
 * `healthRecordFiles`; it never carries a summary, extracted text or
 * `feedsTutor`, because health documents have no ingestion pipeline.
 *
 * Access is per-half, and deliberately asymmetric:
 *   • teacher / school_admin / platform_admin — both halves. The health half is
 *     BEST-EFFORT: a school_admin viewing the all-institutions lens resolves to
 *     zero health candidates today, and hard-throwing there would take away the
 *     document list they already have.
 *   • staff with health:manage — the health half ONLY, and
 *     `scholarDocuments` is never even queried for them. That is the whole
 *     point of keeping `requireTeacherOrAdmin` untouched: an operations staffer filing an
 *     immunization card gains no sight of a cognitive assessment.
 *   • staff with school:operations but no health capability — a valid caller
 *     with scholar access and NO health half: the list returns normally with
 *     `healthDocumentsVisible: false` and the health half empty. It does NOT
 *     throw; the health capability governs only whether that half is shown.
 *   • a caller with NEITHER scholar access nor the health half over this
 *     scholar — refused at the scholar-access boundary.
 */
export const listDocumentsForStaff = authedQuery({
  args: {
    scholarId: v.id("users"),
    institutionScope: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const user = ctx.user;
    // Staff→scholar surface: the target MUST be a scholar, and this is never
    // self-serve. `requireActiveScholarAccess` (below) SELF-EXEMPTS a user
    // reading their own id, so without this a teacher/admin passing their OWN
    // id would get any scholarDocuments rows on that account, and a scholar
    // passing their own id would reach the staff list. Load the target once and
    // refuse anything that isn't another account's scholar. This subsumes the
    // per-branch self-check and applies to BOTH branches.
    const target = await ctx.db.get(args.scholarId);
    if (!target || target.role !== "scholar" || target._id === user._id) {
      throw new Error("Forbidden: scholar is not in your current context");
    }
    const canReadScholarDocuments = isTeacherRole(user.role);

    let documents: ReturnType<typeof scholarDocumentRow>[] = [];
    if (canReadScholarDocuments) {
      await requireActiveScholarAccess(ctx, user, args.scholarId);
      const rows = await ctx.db
        .query("scholarDocuments")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
        .order("desc")
        .collect();
      documents = rows.map(scholarDocumentRow);
    }

    let healthVisible: boolean;
    if (canReadScholarDocuments) {
      healthVisible = await staffScholarAccessible(
        ctx,
        user,
        args.scholarId,
        args.institutionScope,
      );
    } else {
      // A non-teacher scholar-admin reaches this merged list through EITHER of
      // two INDEPENDENT capabilities, and either one alone is legitimate:
      //   • school:operations → scholar access, but NO health half to show; or
      //   • staff with health:manage → the health half only.
      // Gate on ACCESS, and let health CAPABILITY decide ONLY whether the health
      // half is shown. The old code treated the health boundary as the sole
      // gate and hard-threw whenever the caller held no health grant — which
      // conflated "no health capability" with "scholar not in your context" and
      // broke a school:operations staffer who genuinely has scholar access (the
      // "Something went wrong" error opening any scholar). So: resolve health
      // visibility NON-throwingly first; only when there is no health half do we
      // fall back to the scholar-access boundary, so a caller with NEITHER
      // capability over this scholar is still refused (hard error, unchanged).
      healthVisible = await staffScholarAccessible(
        ctx,
        user,
        args.scholarId,
        args.institutionScope,
      );
      if (!healthVisible) {
        // No health half. To receive the (health-less) list the caller must be
        // a STAFF scholar-admin with school:operations scholar access over this
        // scholar. (The staff-only-surface / self-serve and not-a-scholar cases
        // are already refused by the target guard at the top of the handler.)
        await requireActiveScholarAccess(ctx, user, args.scholarId);
      }
    }

    const healthFormsAvailable = await scholarFormsAllowed(ctx, args.scholarId);
    const healthDocumentsAvailableForRead =
      isPlatformAdminRole(user.role) || healthFormsAvailable;
    const healthDocuments = healthDocumentsAvailableForRead && healthVisible
      ? await listHealthDocumentsForStaff(ctx, args.scholarId)
      : [];

    return {
      canReadScholarDocuments,
      // Whether the health half of this list is being shown at all. A caller
      // who can read scholarDocuments still gets the rest of their list when
      // the health lens can't resolve (a school_admin on the all-institutions
      // view), so `false` here is the difference between "no health documents
      // exist" and "we didn't look". Health data is exactly where those two
      // must never render identically.
      healthDocumentsVisible: healthVisible,
      // This is about the TARGET scholar's institution, not the caller's role
      // or active lens. The upload dialog hides its health-record group when the
      // underlying primary-institution forms cannot exist for this scholar.
      healthFormsAvailable,
      // Platform admins retain the existing cross-institution READ exception,
      // even though the target-school boolean above still blocks new uploads.
      healthDocumentsAvailableForRead,
      // Can this caller attach a health document to this scholar right now?
      // Both halves of the answer live server-side so the dropdown can never
      // offer an upload the mutation would refuse.
      canUploadHealthDocuments:
        healthFormsAvailable &&
        healthVisible &&
        (await hasSignedHealthRecord(ctx, args.scholarId)),
      // ...and WHICH kinds, for the same reason. Two of the five slots only
      // exist when the family's own answers call for them, so offering all
      // five unconditionally would let staff file a document the record has
      // nowhere to keep.
      attachableHealthKinds: healthFormsAvailable && healthVisible
        ? await attachableHealthKinds(ctx, args.scholarId)
        : [],
      documents,
      healthDocuments,
    };
  },
});

/**
 * Get one document including the redactedSummary. Logs view_summary.
 *
 * This is a query (not a mutation), so we can't write to the audit log here
 * directly — instead expose a companion mutation `logSummaryView` that the UI
 * calls alongside this query. We still strip extractedText from the response.
 */
export const get = authedQuery({
  args: { documentId: v.id("scholarDocuments") },
  handler: async (ctx, args) => {
    const user = await requireTeacherOrAdmin(ctx);
    const doc = await ctx.db.get(args.documentId);
    if (!doc) return null;
    await requireActiveScholarAccess(ctx, user, doc.scholarId);

    // Never return extractedText from `get`. That's gated behind the
    // separately-audited getExtractedText endpoint.
    const { extractedText, ...rest } = doc;
    void extractedText;
    return rest;
  },
});

/**
 * Log the fact that someone read the redactedSummary for a document. UI calls
 * this right after `get`. Split from `get` because Convex queries can't write.
 */
export const logSummaryView = authedMutation({
  args: { documentId: v.id("scholarDocuments") },
  handler: async (ctx, args) => {
    const user = await requireTeacherOrAdmin(ctx);
    const doc = await ctx.db.get(args.documentId);
    if (!doc) throw new Error("Document not found");
    await requireActiveScholarAccess(ctx, user, doc.scholarId);
    await logAccess(ctx, {
      documentId: args.documentId,
      scholarId: doc.scholarId,
      userId: user._id,
      action: "view_summary",
    });
  },
});

/**
 * Fetch the raw extractedText for a document. Split from `get` so we can tell
 * in the audit log whether anyone pulled the unredacted text. Teacher/admin
 * only. Pair with `logExtractedView` (see below) — same reason as above.
 */
export const getExtractedText = authedQuery({
  args: { documentId: v.id("scholarDocuments") },
  handler: async (ctx, args) => {
    const user = await requireTeacherOrAdmin(ctx);
    const doc = await ctx.db.get(args.documentId);
    if (!doc) return null;
    await requireActiveScholarAccess(ctx, user, doc.scholarId);
    return {
      _id: doc._id,
      scholarId: doc.scholarId,
      extractedText: doc.extractedText ?? null,
      processingStatus: doc.processingStatus,
    };
  },
});

export const logExtractedView = authedMutation({
  args: { documentId: v.id("scholarDocuments") },
  handler: async (ctx, args) => {
    const user = await requireTeacherOrAdmin(ctx);
    const doc = await ctx.db.get(args.documentId);
    if (!doc) throw new Error("Document not found");
    await requireActiveScholarAccess(ctx, user, doc.scholarId);
    await logAccess(ctx, {
      documentId: args.documentId,
      scholarId: doc.scholarId,
      userId: user._id,
      action: "view_extracted",
    });
  },
});

/**
 * Get the storage URL for downloading the original PDF. Logs download_pdf.
 * Returns null if the file has been purged (retention policy).
 */
export const getDownloadUrl = authedQuery({
  args: { documentId: v.id("scholarDocuments") },
  handler: async (ctx, args) => {
    const user = await requireTeacherOrAdmin(ctx);
    const doc = await ctx.db.get(args.documentId);
    if (!doc) return null;
    await requireActiveScholarAccess(ctx, user, doc.scholarId);
    if (!doc.fileStorageId) return null;
    return await ctx.storage.getUrl(doc.fileStorageId);
  },
});

export const logDownload = authedMutation({
  args: { documentId: v.id("scholarDocuments") },
  handler: async (ctx, args) => {
    const user = await requireTeacherOrAdmin(ctx);
    const doc = await ctx.db.get(args.documentId);
    if (!doc) throw new Error("Document not found");
    await requireActiveScholarAccess(ctx, user, doc.scholarId);
    await logAccess(ctx, {
      documentId: args.documentId,
      scholarId: doc.scholarId,
      userId: user._id,
      action: "download_pdf",
    });
  },
});

/** List the audit trail for a document. Teacher/admin only. */
export const auditLogForDocument = authedQuery({
  args: { documentId: v.id("scholarDocuments") },
  handler: async (ctx, args) => {
    const user = await requireTeacherOrAdmin(ctx);
    const doc = await ctx.db.get(args.documentId);
    if (!doc) return [];
    await requireActiveScholarAccess(ctx, user, doc.scholarId);
    return await ctx.db
      .query("documentAccessLog")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .order("desc")
      .collect();
  },
});

// ── Internal API (consumed by scholarDocumentActions.extractAndRedact) ───

/** Internal: fetch a document row including extractedText + fileStorageId. */
export const aiGetDocument = internalQuery({
  args: { documentId: v.id("scholarDocuments") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.documentId);
  },
});

/**
 * Internal: resolve the scholar's OWN institution identity profile (school name,
 * etc.) for the redaction pass. Rabbithole is multi-tenant, so the redaction
 * prompt must preserve the child's actual school as provenance rather than the
 * historical hardcoded primary frame. Reuses the shared
 * `institutionPromptProfileForScholar` resolver (falls back to the configured
 * default for the primary school, the guest bucket, or a missing institution).
 */
export const aiInstitutionProfileForScholar = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) =>
    institutionPromptProfileForScholar(ctx, args.scholarId),
});

/**
 * Internal: list a scholar's documents for the teacher-facing bots — title,
 * kind, status, the teacher summary, and key findings. NEVER returns
 * extractedText (raw OCR may contain medical history etc). Backs the
 * get_scholar_documents bot tool (teacher-facing curriculum bots), so it
 * returns the full teacher summary (scores retained), not the scholar-safe
 * redacted variant.
 *
 * The caller (a teacher-gated stream) is responsible for the role gate;
 * this internal query is unauthenticated by design like the other ai*
 * document helpers.
 */
export const aiListForScholar = internalQuery({
  args: { scholarId: v.id("users") },
  // Implementation shared with the MCP connector via lib/scholarReads.ts.
  handler: async (ctx, args) => readScholarDocuments(ctx, args.scholarId),
});

/** Internal: patch processingStatus (+ optional error). */
export const aiPatchProcessingStatus = internalMutation({
  args: {
    documentId: v.id("scholarDocuments"),
    status: v.union(
      v.literal("pending"),
      v.literal("extracting"),
      v.literal("redacting"),
      v.literal("ready"),
      v.literal("error"),
    ),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.documentId, {
      processingStatus: args.status,
      processingError: args.error,
    });
  },
});

/** Internal: write extractedText. */
export const aiPatchExtractedText = internalMutation({
  args: {
    documentId: v.id("scholarDocuments"),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.documentId, { extractedText: args.text });
  },
});

/** Internal: write redactedSummary + key findings. */
export const aiPatchRedactedSummary = internalMutation({
  args: {
    documentId: v.id("scholarDocuments"),
    summary: v.string(),
    keyFindings: v.array(v.string()),
    redactedSummary: v.string(),
    redactedKeyFindings: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.documentId, {
      summary: args.summary,
      keyFindings: args.keyFindings,
      redactedSummary: args.redactedSummary,
      redactedKeyFindings: args.redactedKeyFindings,
    });
  },
});

/**
 * Internal: purge the underlying storage file + null out fileStorageId.
 * Called by the extraction action if DOCUMENT_RETENTION_POLICY=purge_after_redaction.
 */
export const aiPurgeFile = internalMutation({
  args: { documentId: v.id("scholarDocuments") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (!doc || !doc.fileStorageId) return;
    try {
      await ctx.storage.delete(doc.fileStorageId);
    } catch (err) {
      console.warn(`[aiPurgeFile] storage.delete failed:`, err);
    }
    await ctx.db.patch(args.documentId, { fileStorageId: undefined });
  },
});

/**
 * Internal: write an audit log entry from an action/internal flow. Actions
 * can't write directly, so they call this via runMutation.
 */
export const aiLogAccess = internalMutation({
  args: {
    documentId: v.id("scholarDocuments"),
    scholarId: v.id("users"),
    userId: v.id("users"),
    action: v.union(
      v.literal("upload"),
      v.literal("view_summary"),
      v.literal("view_extracted"),
      v.literal("download_pdf"),
      v.literal("delete"),
      v.literal("generate_proposal"),
      v.literal("apply_proposal"),
    ),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("documentAccessLog", args);
  },
});

// ── Test fixture (dev-only convenience) ─────────────────────────────────

/**
 * Insert a document row directly with a pre-populated extractedText, skipping
 * the PDF-upload path. Used from the Convex CLI during dev verification so we
 * don't burn Gemini credits on round-tripping a fake PDF. NOT exposed to the
 * browser (internalMutation). Only ever pointed at a test scholar (testkai or
 * similar) — never a real scholar.
 */
export const adminTestCreateFixture = internalMutation({
  args: {
    scholarId: v.id("users"),
    uploadedBy: v.id("users"),
    title: v.string(),
    extractedText: v.string(),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("scholarDocuments", {
      scholarId: args.scholarId,
      kind: "assessment",
      title: args.title,
      uploadedBy: args.uploadedBy,
      extractedText: args.extractedText,
      processingStatus: "redacting",
    });
    return id;
  },
});

/**
 * Test/fixture: insert a scholar document in `ready` state with a pre-populated
 * summary + key findings, bypassing the extraction pipeline. Used by the
 * Playwright verification scripts so we don't burn API credits on a fake PDF.
 * Admin-only, internal (not browser-reachable). The same text is written to both
 * the teacher (summary/keyFindings) and redacted (redactedSummary/
 * redactedKeyFindings) fields — fixtures don't exercise the score-split.
 *
 * Requires the uploader to already exist; we audit the upload as if it came
 * from that user. Only ever pointed at a test scholar — never a real scholar.
 */
export const adminFixtureInsertReady = internalMutation({
  args: {
    scholarId: v.id("users"),
    uploadedBy: v.id("users"),
    title: v.string(),
    extractedText: v.string(),
    summary: v.string(),
    keyFindings: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const documentId = await ctx.db.insert("scholarDocuments", {
      scholarId: args.scholarId,
      kind: "assessment",
      title: args.title,
      uploadedBy: args.uploadedBy,
      extractedText: args.extractedText,
      summary: args.summary,
      keyFindings: args.keyFindings,
      redactedSummary: args.summary,
      redactedKeyFindings: args.keyFindings,
      processingStatus: "ready",
    });

    await ctx.db.insert("documentAccessLog", {
      documentId,
      scholarId: args.scholarId,
      userId: args.uploadedBy,
      action: "upload",
    });

    return documentId;
  },
});

/**
 * Test/fixture: hard-delete a document by id, its audit log entries, and any
 * cached proposal. Used by the Playwright verification script for cleanup.
 * Admin-only, internal (not browser-reachable).
 */
export const adminFixtureDelete = internalMutation({
  args: { documentId: v.id("scholarDocuments") },
  handler: async (ctx, args) => {
    const doc = await ctx.db.get(args.documentId);
    if (!doc) return { deleted: false };
    if (doc.fileStorageId) {
      try {
        await ctx.storage.delete(doc.fileStorageId);
      } catch {
        // ignore
      }
    }

    const auditRows = await ctx.db
      .query("documentAccessLog")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    for (const r of auditRows) await ctx.db.delete(r._id);

    const proposals = await ctx.db
      .query("documentProposals")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    for (const p of proposals) await ctx.db.delete(p._id);

    await ctx.db.delete(args.documentId);
    return { deleted: true };
  },
});

/**
 * Test/fixture cleanup: remove every teacherDirective + seed for a given
 * scholar that matches any of the provided labels / topics. Used by the
 * Playwright verification script to clean up anything the proposal flow
 * created. Admin-only, internal.
 */
export const adminFixtureCleanupScholar = internalMutation({
  args: {
    scholarId: v.id("users"),
    directiveLabels: v.array(v.string()),
    seedTopics: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    let directivesDeleted = 0;
    let seedsDeleted = 0;

    if (args.directiveLabels.length > 0) {
      const labelLowerSet = new Set(
        args.directiveLabels.map((l) => l.trim().toLowerCase())
      );
      const dirs = await ctx.db
        .query("teacherDirectives")
        .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
        .collect();
      for (const d of dirs) {
        if (labelLowerSet.has(d.label.toLowerCase())) {
          await ctx.db.delete(d._id);
          directivesDeleted += 1;
        }
      }
    }

    if (args.seedTopics.length > 0) {
      const topicSet = new Set(args.seedTopics.map((t) => t.trim()));
      // Check both pending and active statuses
      for (const status of ["pending", "active", "dismissed"] as const) {
        const rows = await ctx.db
          .query("seeds")
          .withIndex("by_scholar_status", (q) =>
            q.eq("scholarId", args.scholarId).eq("status", status)
          )
          .collect();
        for (const s of rows) {
          if (topicSet.has(s.topic.trim())) {
            await ctx.db.delete(s._id);
            seedsDeleted += 1;
          }
        }
      }
    }

    return { directivesDeleted, seedsDeleted };
  },
});

// Unused-import marker: `QueryCtx` isn't currently referenced outside of the
// internal helpers — keep it imported for future shared helpers.
export type _ScholarDocQueryCtx = QueryCtx;

/**
 * Register a document uploaded via the Slack bot's DM intake
 * (`add_scholar_document` tool). Mirrors `registerUpload` exactly — same
 * insert, same audit log, same pipeline kickoff — but takes an explicit
 * caller because the bot acts for a mapped Slack user, not a Convex Auth
 * identity. Re-verifies the caller's role here (defense in depth: this is
 * the most sensitive write on the Slack surface).
 */
export const aideRegisterFromSlack = internalMutation({
  args: {
    callerUserId: v.id("users"),
    scholarId: v.id("users"),
    storageId: v.id("_storage"),
    kind: v.union(
      v.literal("assessment"),
      v.literal("iep"),
      v.literal("parent_email"),
      v.literal("observation"),
      v.literal("other"),
    ),
    title: v.string(),
    fileMimeType: v.optional(v.string()),
    fileSizeBytes: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { ok: true; documentId: Doc<"scholarDocuments">["_id"]; message: string }
    | { ok: false; message: string }
  > => {
    const caller = await ctx.db.get(args.callerUserId);
    if (
      !caller ||
      (!isTeacherRole(caller.role))
    ) {
      return { ok: false, message: "Forbidden: teacher or admin role required" };
    }
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) {
      return { ok: false, message: "Scholar not found" };
    }

    const documentId = await ctx.db.insert("scholarDocuments", {
      scholarId: args.scholarId,
      kind: args.kind,
      title: args.title.trim() || "Untitled document",
      fileStorageId: args.storageId,
      fileMimeType: args.fileMimeType,
      fileSizeBytes: args.fileSizeBytes,
      uploadedBy: caller._id,
      processingStatus: "pending",
    });

    await logAccess(ctx, {
      documentId,
      scholarId: args.scholarId,
      userId: caller._id,
      action: "upload",
    });

    await ctx.scheduler.runAfter(
      0,
      internal.scholarDocumentActions.extractAndRedact,
      { documentId },
    );

    return { ok: true, documentId, message: "Document registered" };
  },
});
