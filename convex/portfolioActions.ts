"use node";

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MODELS } from "./lib/models";
import type { ActionCtx } from "./_generated/server";
import { recordAnthropicUsage } from "./usage";
import { ROLES } from "./lib/roles";
import { matchScholar } from "./lib/scholarMatch";
import {
  normalizeDocumentHeading,
  normalizeSegments,
  applyPageRotation,
  normalizeRotationRepair,
  type RotationRepairPlan,
  type RawSegment,
} from "./lib/pdfSegments";
import { resolveAssignment } from "./lib/portfolioStatus";
import { getAuthUserId } from "@convex-dev/auth/server";
import { getValidAccessToken } from "./lib/googleTokens";
import { isIngestibleMime, imageMediaType } from "./lib/ingestMimes";
import { detectImageMime, type ImageMime } from "./lib/imageBytes";

/**
 * Extraction + matching pipeline for portfolioItems.
 *
 * Two entry points:
 *
 *  - extractAndMatch  — the MANUAL-upload path. One already-created item whose
 *    scholar is known. Reads the page (caption + text), and bakes in a
 *    rotation if the page was scanned sideways. No splitting.
 *
 *  - ingestDriveFile  — the DRIVE path. A freshly-scanned file that may be a
 *    STACK (e.g. 12 pages = 4 students × a 3-page assignment). One vision pass
 *    segments it into separate submissions; each segment becomes its own
 *    rotated PDF + portfolioItem, matched to a scholar by the name on the page.
 *
 * Both share the Claude vision call. There's NO redaction — this is the
 * scholar's own work.
 *
 * pdf-lib note: it's CommonJS, so under Convex's esbuild the named exports
 * land on `.default`. `loadPdfLib()` unwraps that. (Proven on the Convex node
 * runtime before this shipped.)
 */

function portfolioModel(): string {
  return process.env.PORTFOLIO_MODEL || MODELS.SONNET;
}

// ─── Vision prompts ─────────────────────────────────────────────────────

export const SINGLE_PROMPT = `You are looking at a single piece of a child's schoolwork scanned by a
classroom printer. Return, as JSON only:
{
  "detectedName": "<the student name the child wrote on the page (a corner, a
    'Name:' line, a header), exactly as written, or null if none. Do NOT use a
    name printed in the worksheet's own content.>",
  "documentHeading": "<the document's PRINTED NAME, verbatim: the title for the
    whole form or worksheet, such as a title block or letterhead at the very top
    (e.g. 'Learning Print', 'Exit Ticket', 'Weekly Reading Log'), or null. A
    numbered/lettered section label WITHIN it (e.g. 'I. Strengths and Interests'
    or 'Part B: Reflection') is not the document name; if that is the only
    heading, return null. Do not use body text, a question, handwriting, a
    description you compose, or a page/template code in a corner. Most
    worksheets print no document name: prefer null over a guess, and return a
    string only for a clear whole-document title. This is the ONE exception to
    the skip-pre-printed-boilerplate rule.>",
  "caption": "<1-2 plain sentences describing what the work is and what the
    child did>",
  "extractedText": "<the child's legible handwriting/answers as plain text, or
    empty string. Skip pre-printed worksheet boilerplate.>",
  "rotationDegrees": <0, 90, 180, or 270 — how many degrees CLOCKWISE the page
    must be rotated to be upright for a human reader. 0 if already upright.>,
  "assignmentId": <if a list of ASSIGNMENTS is given below, the id of the one
    this work is clearly FOR (the page's topic/task matches that assignment's
    unit), else null. Only pick an id when you're confident from the content;
    when unsure, null.>
}
Return ONLY the JSON. No prose, no code fences.`;

export const ROTATION_REPAIR_PROMPT = `Inspect this PDF only for page orientation. For each page, decide how
many degrees CLOCKWISE it must be rotated so that its content is upright for a
human reader. Do not transcribe, summarize, identify, or reproduce any page
content. Return JSON only:
{"rotationDegreesByPage":[<one of 0,90,180,270 per page, in page order>]}
The array length MUST equal the number of pages.`;

type RepairPdfRotationResult = {
  ok: boolean;
  error?: string;
  currentRotations?: number[];
  proposedCorrections?: number[];
  reportedPageCount?: number;
  valid?: boolean;
  expectedStorageId?: Id<"_storage">;
  dryRun?: boolean;
  newSizeBytes?: number;
};

export const SEGMENTS_PROMPT = `You are looking at a MULTI-PAGE PDF that a teacher produced by scanning a
STACK of paper. The stack may contain several different students' work, and
each student's submission may span multiple consecutive pages (e.g. a 3-page
assignment). Pages are numbered starting at 1.

Your job: split the stack into separate SUBMISSIONS. A new submission starts
when the author changes (a different student name appears) or a fresh
first-page/header/"Name:" line begins a new assignment. Continuation pages
(mid-assignment, often no name) belong to the submission that started before
them.

IMPORTANT: a page that is mostly a child's DRAWING or a hand-drawn frame —
e.g. "Magic Corners" (four hand-drawn L-shaped corner brackets around a small
sketch or a few words), often on an otherwise blank page with no name — is by
itself NOT a submission boundary. Treat it as a CONTINUATION of the submission
it sits within (kids draw these in the middle of their packet); don't split it
into its own segment. So a 3-page packet whose page 2 is such a drawing is ONE
3-page submission, not three. (A genuine new submission still begins the normal
way — a different student's name, or a clear new named header — just never on a
bare drawing page alone.)

Return, as JSON only:
{
  "segments": [
    {
      "startPage": <1-indexed first page of this submission>,
      "endPage": <1-indexed last page, inclusive>,
      "detectedName": "<student name written on the pages, exactly as written,
        or null>",
      "documentHeading": "<the document's PRINTED NAME, verbatim: the title for
        the whole form or worksheet, such as a title block or letterhead at the
        very top (e.g. 'Learning Print', 'Exit Ticket', 'Weekly Reading Log'),
        or null. A numbered/lettered section label WITHIN it (e.g. 'I. Strengths
        and Interests' or 'Part B: Reflection') is not the document name; if
        that is the only heading, return null. Do not use body text, a question,
        handwriting, a description you compose, or a page/template code in a
        corner. Most worksheets print no document name: prefer null over a
        guess, and return a string only for a clear whole-document title. This
        is the ONE exception to the skip-pre-printed-boilerplate rule.>",
      "caption": "<1-2 plain sentences describing this submission>",
      "extractedText": "<the child's legible text across these pages, or empty>",
      "rotationDegreesByPage": [<one 0, 90, 180, or 270 clockwise correction
        per page in this segment, in page order; length MUST equal
        endPage - startPage + 1>],
      "rotationDegrees": <legacy fallback only: one correction for every page
        when rotationDegreesByPage is absent>,
      "assignmentId": <if a list of ASSIGNMENTS is given below, the id of the
        one this submission is clearly FOR (topic/task matches), else null. Only
        pick when confident from the content; when unsure, null.>
    }
  ]
}

If the whole stack is clearly ONE submission, return a single segment covering
all pages. Cover every page; don't overlap ranges. Return ONLY the JSON.`;

/** Build the assignment-candidate block appended to a vision prompt. */
function assignmentListText(
  assignments: { id: string; title: string; unitTitle: string | null; description: string | null }[],
): string {
  if (assignments.length === 0) return "";
  const lines = assignments.map((a) => {
    const ctx = [a.unitTitle, a.description].filter(Boolean).join(" — ");
    return `- ${a.id}: "${a.title}"${ctx ? ` (${ctx})` : ""}`;
  });
  return `\n\nASSIGNMENTS (use these ids for the assignmentId field; pick one only if the work clearly matches it, else null):\n${lines.join("\n")}`;
}


// ─── Claude helpers ─────────────────────────────────────────────────────

type ClaudeBlock =
  | { type: "text"; text: string }
  | {
      type: "document";
      source: { type: "base64"; media_type: "application/pdf"; data: string };
    }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
        data: string;
      };
    };

async function callClaude(
  ctx: ActionCtx,
  content: ClaudeBlock[],
  maxTokens: number,
  source: string,
  institutionId: Id<"institutions"> | null = null,
  model: string = portfolioModel(),
): Promise<string> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const anthropic = new Anthropic();
  const response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    // No `temperature`: the current models (Sonnet 5+) reject it ("temperature is
    // deprecated for this model"). Matches the tutor/observer/scholar-doc calls.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    messages: [{ role: "user", content: content as any }],
  });
  await recordAnthropicUsage(ctx, {
    source,
    role: ROLES.TEACHER,
    model,
    usage: response.usage,
    institutionId,
  });
  const text = response.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
  if (!text.trim()) {
    throw new Error(
      `Claude returned empty text (stop_reason: ${response.stop_reason ?? "unknown"})`
    );
  }
  return text;
}

function blobToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * Build the Claude vision block for a scanned file. The declared MIME can be
 * WRONG — phones/printers/upload pickers mislabel files, and a `.png` whose
 * bytes are actually a JPEG made Claude 400 ("image was specified using the
 * image/png media type, but the image appears to be a image/jpeg image"),
 * which failed the whole ingest before it produced anything. For images we
 * sniff the real type from the leading bytes; PDFs (and anything `imageMediaType`
 * doesn't recognize) go through the document path. Returns the corrected image
 * MIME so the caller can also store the truth, not the lie.
 */
function visionFileBlock(
  bytes: Uint8Array,
  declaredMime: string,
): { block: ClaudeBlock; imgType: ImageMime | null; realMime: string } {
  const data = blobToBase64(bytes);
  const declaredImg = imageMediaType(declaredMime);
  if (declaredImg) {
    const realMime = detectImageMime(bytes, declaredImg);
    return {
      block: { type: "image", source: { type: "base64", media_type: realMime, data } },
      imgType: realMime,
      realMime,
    };
  }
  return {
    block: { type: "document", source: { type: "base64", media_type: "application/pdf", data } },
    imgType: null,
    realMime: declaredMime,
  };
}

function stripFences(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  }
  return cleaned;
}

// ─── pdf-lib helpers ────────────────────────────────────────────────────

async function loadPdfLib(): Promise<typeof import("pdf-lib")> {
  const mod = await import("pdf-lib");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((mod as any).default ?? mod) as typeof import("pdf-lib");
}

function toBlob(bytes: Uint8Array, type: string): Blob {
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  return new Blob([ab], { type });
}

// ─── title helpers ──────────────────────────────────────────────────────

function isJunkTitle(title: string): boolean {
  return /^(scan|img|image|doc|document|untitled|photo|file)[\s_\-#]*\d*$/i.test(
    title.trim()
  );
}

function captionToTitle(caption: string): string {
  const t = (caption.split(/[.!?]/)[0] || caption).trim();
  return t.length > 60 ? `${t.slice(0, 57)}...` : t;
}

function segmentTitle(
  baseTitle: string,
  caption: string,
  range: { start: number; end: number },
  isMulti: boolean
): string {
  if (caption) return captionToTitle(caption);
  const base = isJunkTitle(baseTitle) ? "Scan" : baseTitle.replace(/\.[^.]+$/, "");
  return isMulti ? `${base} (pp ${range.start}-${range.end})` : base;
}

// ─── MANUAL path: single item, caption + rotation, no split ─────────────

export const extractAndMatch = internalAction({
  args: { itemId: v.id("portfolioItems") },
  handler: async (ctx, args) => {
    const item = await ctx.runQuery(internal.portfolio.aiGetItem, {
      itemId: args.itemId,
    });

    if (!item) return null;
    const institutionId = item.scholarId
      ? await ctx.runQuery(internal.usage.resolveInstitution, {
          userId: item.scholarId,
          principal: "scholar",
        })
      : null;

    if (!process.env.ANTHROPIC_API_KEY) {
      await ctx.runMutation(internal.portfolio.aiPatchProcessingStatus, {
        itemId: args.itemId,
        status: "error",
        error: "ANTHROPIC_API_KEY not set on this deployment",
      });
      return null;
    }

    try {
      if (!item.fileStorageId) throw new Error("Item has no fileStorageId");

      await ctx.runMutation(internal.portfolio.aiPatchProcessingStatus, {
        itemId: args.itemId,
        status: "extracting",
      });

      const blob = await ctx.storage.get(item.fileStorageId);
      if (!blob) throw new Error("Storage blob missing");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const mimeType = item.fileMimeType ?? "application/pdf";
      const { block: fileBlock, imgType } = visionFileBlock(bytes, mimeType);

      const raw = await callClaude(
        ctx,
        [fileBlock, { type: "text", text: SINGLE_PROMPT }],
        4096,
        "portfolio-caption",
        institutionId,
      );
      const parsed = JSON.parse(stripFences(raw));
      const detectedName =
        typeof parsed.detectedName === "string" && parsed.detectedName.trim()
          ? parsed.detectedName.trim()
          : undefined;
      const documentHeading = normalizeDocumentHeading(parsed.documentHeading);
      const caption = typeof parsed.caption === "string" ? parsed.caption.trim() : "";
      const extractedText =
        typeof parsed.extractedText === "string" ? parsed.extractedText.trim() : "";
      const rotation = ((Math.round(Number(parsed.rotationDegrees) / 90) * 90) % 360 + 360) % 360;

      const newTitle = isJunkTitle(item.title) && caption ? captionToTitle(caption) : undefined;
      await ctx.runMutation(internal.portfolio.aiPatchExtraction, {
        itemId: args.itemId,
        caption,
        extractedText,
        detectedName,
        documentHeading,
        title: newTitle,
      });

      // Bake in rotation for PDFs scanned sideways.
      if (rotation !== 0 && !imgType) {
        const { PDFDocument, degrees } = await loadPdfLib();
        const doc = await PDFDocument.load(bytes);
        for (const page of doc.getPages()) {
          // Compose with any existing /Rotate — the model judged the
          // *displayed* orientation, so the correction is additive.
          const cur = page.getRotation().angle;
          page.setRotation(degrees((cur + rotation) % 360));
        }
        const rotated = await doc.save();
        const newId = await ctx.storage.store(toBlob(rotated, "application/pdf"));
        await ctx.runMutation(internal.portfolio.aiReplaceFile, {
          itemId: args.itemId,
          newStorageId: newId,
        });
      }

      // Legacy/defensive: a Drive-sourced single item still gets matched.
      if (item.source === "google_drive") {
        const roster = await ctx.runQuery(internal.portfolio.listScholarsForMatch, {
          institutionId: item.institutionId,
        });
        const verdict = matchScholar(detectedName ?? null, roster);
        await ctx.runMutation(internal.portfolio.aiSetMatch, {
          itemId: args.itemId,
          scholarId:
            verdict.status === "matched" && verdict.scholarId
              ? (verdict.scholarId as Id<"users">)
              : undefined,
          matchStatus: verdict.status,
          matchConfidence: verdict.confidence,
        });
      }

      await ctx.runMutation(internal.portfolio.aiPatchProcessingStatus, {
        itemId: args.itemId,
        status: "ready",
      });
      // Generate the thumbnail off the FINAL file (after any rotation bake-in).
      await ctx.scheduler.runAfter(0, internal.portfolioThumbs.generate, {
        itemId: args.itemId,
      });
      // Magic Annotations: a manually-uploaded image/PDF can carry a marker too.
      await ctx.scheduler.runAfter(0, internal.magicAnnotations.processPortfolioItem, {
        itemId: args.itemId,
      });
      return { ok: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[portfolio.extractAndMatch] FAILED: ${message}`);
      await ctx.runMutation(internal.portfolio.aiPatchProcessingStatus, {
        itemId: args.itemId,
        status: "error",
        error: message.slice(0, 500),
      });
      return { ok: false, error: message };
    }
  },
});

/** Propose (or explicitly apply) page-orientation repairs to an existing PDF. */
export const repairPdfRotation = internalAction({
  args: {
    itemId: v.id("portfolioItems"),
    /** Defaults to true: callers must explicitly opt into the storage mutation. */
    dryRun: v.optional(v.boolean()),
    currentRotations: v.optional(v.array(v.number())),
    proposedCorrections: v.optional(v.array(v.number())),
    expectedStorageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args): Promise<RepairPdfRotationResult> => {
    const item = await ctx.runQuery(internal.portfolio.aiGetItem, { itemId: args.itemId });
    if (!item) return { ok: false, error: "Portfolio item not found" };
    if (!item.fileStorageId) return { ok: false, error: "Portfolio item has no file" };
    const mimeType = (item.fileMimeType ?? "").split(";")[0].trim().toLowerCase();
    if (mimeType !== "application/pdf") {
      return { ok: false, error: "Rotation repair only supports PDF files" };
    }
    const blob = await ctx.storage.get(item.fileStorageId);
    if (!blob) return { ok: false, error: "Portfolio file is missing" };

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const { PDFDocument, degrees } = await loadPdfLib();
    const source = await PDFDocument.load(bytes);
    const currentRotations = source.getPages().map((page) => page.getRotation().angle);
    const dryRun = args.dryRun !== false;
    let plan: RotationRepairPlan;
    if (dryRun) {
      const raw = await callClaude(
        ctx,
        [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: blobToBase64(bytes) } },
          { type: "text", text: ROTATION_REPAIR_PROMPT },
        ],
        1024,
        "portfolio-rotation-repair",
        item.institutionId ?? null,
      );
      plan = normalizeRotationRepair(raw, source.getPageCount(), currentRotations);
      if (!plan.valid) {
        return {
          ok: false,
          error: `Model returned ${plan.reportedPageCount} rotations for ${source.getPageCount()} pages`,
          ...plan,
          dryRun: true,
        };
      }
    } else {
      if (
        !args.currentRotations ||
        !args.proposedCorrections ||
        !args.expectedStorageId
      ) {
        return { ok: false, error: "Apply requires the reviewed rotation plan" };
      }
      if (args.expectedStorageId !== item.fileStorageId) {
        return { ok: false, error: "Portfolio PDF changed after the rotation dry-run" };
      }
      plan = normalizeRotationRepair(
        { rotationDegreesByPage: args.proposedCorrections },
        source.getPageCount(),
        currentRotations,
      );
      if (!plan.valid || args.currentRotations.length !== source.getPageCount()) {
        return { ok: false, error: "Reviewed rotation plan has the wrong page count" };
      }
      const reviewedCurrent = normalizeRotationRepair(
        { rotationDegreesByPage: args.proposedCorrections },
        source.getPageCount(),
        args.currentRotations,
      ).currentRotations;
      if (reviewedCurrent.some((rotation, index) => rotation !== plan.currentRotations[index])) {
        return { ok: false, error: "Portfolio PDF changed after the rotation dry-run" };
      }
    }
    const result = {
      ok: true,
      ...plan,
      expectedStorageId: item.fileStorageId,
      dryRun,
    };
    if (dryRun) return result;

    const out = await PDFDocument.create();
    const copied = await out.copyPages(source, source.getPages().map((_, i) => i));
    for (const [index, page] of copied.entries()) {
      applyPageRotation(page, plan.proposedCorrections[index], degrees);
      out.addPage(page);
    }
    const corrected = await out.save();
    const newStorageId = await ctx.storage.store(toBlob(corrected, "application/pdf"));
    const replacement = await ctx.runMutation(internal.portfolio.replaceFileAfterRotation, {
      itemId: args.itemId,
      expectedOldStorageId: item.fileStorageId,
      newStorageId,
      newSizeBytes: corrected.byteLength,
    });
    if (!replacement.replaced) {
      return { ...result, ok: false, error: "Portfolio item was deleted during repair" };
    }
    await ctx.scheduler.runAfter(0, internal.portfolioThumbs.generate, { itemId: args.itemId });
    if (replacement.regenerateMagic) {
      await ctx.scheduler.runAfter(0, internal.magicAnnotations.processPortfolioItem, {
        itemId: args.itemId,
      });
    }
    return { ...result, dryRun: false, newSizeBytes: corrected.byteLength };
  },
});

// ─── Ingest a scan from ANY source: segment a stack → rotated per-submission
// items, match scholar + assignment. Used by the Drive watch, one-off Drive
// picks, direct uploads, and webcam photo captures. Dedupe only applies when a
// driveFileId is present (the watch can re-deliver).

export const ingestScan = internalAction({
  args: {
    source: v.union(
      v.literal("google_drive"),
      v.literal("upload"),
      v.literal("photo"),
    ),
    driveFileId: v.optional(v.string()),
    originalStorageId: v.id("_storage"),
    fileMimeType: v.optional(v.string()),
    title: v.string(),
    // Set by the public actions (ingestUploadedScan / ingestDriveFileById) so
    // the inbox shows a spinner the instant the teacher kicks off ingest. We
    // patch this row's status through the pipeline, then delete it once the
    // real segment rows land. The Drive-watch path doesn't set it (auto-sync
    // isn't user-initiated → no immediate-spinner requirement).
    placeholderItemId: v.optional(v.id("portfolioItems")),
    // The institution whose inbox this scan belongs to. Set by the Drive-watch
    // fan-out (the folder's owning institution) and by the manual upload/pick
    // paths (the uploader's institution). Constrains name-matching to that
    // school's roster and stamps the resulting items — the cross-tenant fix.
    institutionId: v.optional(v.id("institutions")),
    // Present only when Drive sync already owns the atomic file-level claim.
    // Claimed retries may have partial segment rows, so they bypass the legacy
    // any-item dedupe guard and rely on insertSegment's page-range upsert.
    ingestionClaimToken: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ created: number; error?: string }> => {
    // Helper to keep the placeholder lifecycle consistent across the early
    // returns below. Calls are no-ops when no placeholder was passed.
    const markPlaceholder = async (
      status: "extracting" | "matching" | "error",
      error?: string,
    ) => {
      if (!args.placeholderItemId) return;
      await ctx.runMutation(internal.portfolio.aiPatchProcessingStatus, {
        itemId: args.placeholderItemId,
        status,
        error,
      });
    };
    const dropPlaceholder = async () => {
      if (!args.placeholderItemId) return;
      await ctx.runMutation(internal.portfolio.deletePlaceholderIfPending, {
        itemId: args.placeholderItemId,
      });
    };

    // Dedupe guard for Drive files, which the watch can re-deliver. Only the
    // watch path reaches here with a driveFileId and NO placeholder — the
    // one-off pick (`ingestDriveFileById`) already pre-checks before creating
    // its placeholder, and that placeholder itself carries the driveFileId, so
    // running the check here would match the row we just created and abort
    // every single pick. Skip the guard whenever a placeholder is present.
    if (
      args.driveFileId &&
      !args.placeholderItemId &&
      !args.ingestionClaimToken
    ) {
      // "Already handled" includes teacher-deleted files (dismissals), so a
      // watch re-delivery can't resurrect a deleted scan.
      const already = await ctx.runQuery(internal.portfolio.driveFileAlreadyHandled, {
        driveFileId: args.driveFileId,
      });
      if (already) {
        await ctx.storage.delete(args.originalStorageId).catch(() => {});
        await dropPlaceholder();
        return { created: 0 };
      }
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      await markPlaceholder("error", "ANTHROPIC_API_KEY not set");
      return { created: 0, error: "ANTHROPIC_API_KEY not set" };
    }

    try {
      await markPlaceholder("extracting");
      const blob = await ctx.storage.get(args.originalStorageId);
      if (!blob) throw new Error("Storage blob missing");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const mimeType = args.fileMimeType ?? "application/pdf";
      const roster = await ctx.runQuery(internal.portfolio.listScholarsForMatch, {
        institutionId: args.institutionId,
      });
      const assignments = await ctx.runQuery(
        internal.portfolio.activeAssignmentsForMatch,
        {},
      );
      const assignmentBlock = assignmentListText(assignments);

      // Non-PDF (image): single item, no split, no rotation (v1).
      if (mimeType !== "application/pdf") {
        const { block: fileBlock, imgType, realMime } = visionFileBlock(bytes, mimeType);
        const raw = await callClaude(
          ctx,
          [fileBlock, { type: "text", text: SINGLE_PROMPT + assignmentBlock }],
          4096,
          "portfolio-intake",
        );
        const parsed = JSON.parse(stripFences(raw));
        const detectedName =
          typeof parsed.detectedName === "string" && parsed.detectedName.trim()
            ? parsed.detectedName.trim()
            : null;
        const documentHeading = normalizeDocumentHeading(parsed.documentHeading);
        const caption = typeof parsed.caption === "string" ? parsed.caption.trim() : "";
        const extractedText =
          typeof parsed.extractedText === "string" ? parsed.extractedText.trim() : "";
        await markPlaceholder("matching");
        const verdict = matchScholar(detectedName, roster);
        const matchedScholarId =
          verdict.status === "matched" && verdict.scholarId ? verdict.scholarId : null;
        const assignment = resolveAssignment(
          typeof parsed.assignmentId === "string" ? parsed.assignmentId : null,
          matchedScholarId,
          assignments,
        );
        const imageItemId = await ctx.runMutation(internal.portfolio.insertSegment, {
          source: args.source,
          driveFileId: args.driveFileId,
          title: segmentTitle(args.title, caption, { start: 1, end: 1 }, false),
          fileStorageId: args.originalStorageId,
          // Store the SNIFFED type, not the (possibly wrong) declared one, so
          // thumbnails / magic / the portfolio <img> all see the truth.
          fileMimeType: realMime,
          fileSizeBytes: bytes.byteLength,
          detectedName: detectedName ?? undefined,
          documentHeading,
          aiCaption: caption || undefined,
          extractedText: extractedText || undefined,
          scholarId: matchedScholarId ? (matchedScholarId as Id<"users">) : undefined,
          matchStatus: verdict.status,
          matchConfidence: verdict.confidence,
          assignmentId: assignment.assignmentId
            ? (assignment.assignmentId as Id<"assignments">)
            : undefined,
          assignmentStatus: assignment.assignmentStatus,
          institutionId: args.institutionId,
        });
        // Magic Annotations: image scans can carry a Magic Corners marker.
        // Non-blocking + failure-tolerant, like thumbnail generation.
        if (imgType) {
          await ctx.scheduler.runAfter(0, internal.magicAnnotations.processPortfolioItem, {
            itemId: imageItemId,
          });
        }
        await dropPlaceholder();
        return { created: 1 };
      }

      // PDF: segment the stack, then split + rotate each submission.
      const { PDFDocument, degrees } = await loadPdfLib();
      const source = await PDFDocument.load(bytes);
      const pageCount = source.getPageCount();

      const raw = await callClaude(
        ctx,
        [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: blobToBase64(bytes) } },
          { type: "text", text: SEGMENTS_PROMPT + assignmentBlock },
        ],
        4096,
        "portfolio-intake",
      );
      let rawSegments: RawSegment[] = [];
      try {
        const parsed = JSON.parse(stripFences(raw));
        rawSegments = Array.isArray(parsed.segments) ? parsed.segments : [];
      } catch {
        rawSegments = [];
      }
      const segments = normalizeSegments(rawSegments, pageCount);
      const isMulti = segments.length > 1;
      await markPlaceholder("matching");

      // Fast path: one segment, whole file, no rotation → reuse the original
      // blob instead of copying it.
      const lone = segments[0];
      const reuseOriginal =
        segments.length === 1 &&
        lone.startPage === 1 &&
        lone.endPage === pageCount &&
        lone.rotationDegreesByPage.every((rotation) => rotation === 0);

      let created = 0;
      for (const seg of segments) {
        let storageId: Id<"_storage">;
        let sizeBytes: number;
        if (reuseOriginal) {
          storageId = args.originalStorageId;
          sizeBytes = bytes.byteLength;
        } else {
          const out = await PDFDocument.create();
          const indices: number[] = [];
          for (let p = seg.startPage; p <= seg.endPage; p++) indices.push(p - 1);
          const copied = await out.copyPages(source, indices);
          for (const [index, page] of copied.entries()) {
            // Additive: compose each correction with the page's existing
            // /Rotate (copyPages preserves it).
            applyPageRotation(page, seg.rotationDegreesByPage[index], degrees);
            out.addPage(page);
          }
          const outBytes = await out.save();
          sizeBytes = outBytes.byteLength;
          storageId = await ctx.storage.store(toBlob(outBytes, "application/pdf"));
        }

        const verdict = matchScholar(seg.detectedName, roster);
        const matchedScholarId =
          verdict.status === "matched" && verdict.scholarId ? verdict.scholarId : null;
        const assignment = resolveAssignment(
          seg.assignmentGuess,
          matchedScholarId,
          assignments,
        );
        const segItemId = await ctx.runMutation(internal.portfolio.insertSegment, {
          source: args.source,
          driveFileId: args.driveFileId,
          title: segmentTitle(
            args.title,
            seg.caption,
            { start: seg.startPage, end: seg.endPage },
            isMulti
          ),
          fileStorageId: storageId,
          fileMimeType: "application/pdf",
          fileSizeBytes: sizeBytes,
          pageRange: { start: seg.startPage, end: seg.endPage },
          detectedName: seg.detectedName ?? undefined,
          documentHeading: seg.documentHeading,
          aiCaption: seg.caption || undefined,
          extractedText: seg.extractedText || undefined,
          scholarId: matchedScholarId ? (matchedScholarId as Id<"users">) : undefined,
          matchStatus: verdict.status,
          matchConfidence: verdict.confidence,
          assignmentId: assignment.assignmentId
            ? (assignment.assignmentId as Id<"assignments">)
            : undefined,
          assignmentStatus: assignment.assignmentStatus,
          institutionId: args.institutionId,
        });
        // Magic Annotations: a scanned PDF (the Brother-printer path) can carry
        // Magic Corners on any page. processPortfolioItem scans every page of
        // this student's submission and substitutes the marked ones in place.
        await ctx.scheduler.runAfter(0, internal.magicAnnotations.processPortfolioItem, {
          itemId: segItemId,
        });
        created++;
      }

      // We made per-segment copies — drop the combined original.
      if (!reuseOriginal) {
        await ctx.storage.delete(args.originalStorageId).catch(() => {});
      }

      console.log(
        `[portfolio.ingestDriveFile] ${args.driveFileId}: ${pageCount}pp -> ${created} item(s)`
      );
      await dropPlaceholder();
      return { created };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[portfolio.ingestDriveFile] FAILED ${args.driveFileId}: ${message}`);
      // Leave nothing behind so the safety-net poll can retry cleanly.
      await ctx.storage.delete(args.originalStorageId).catch(() => {});
      // Stamp the placeholder so the user sees the failure immediately instead
      // of waiting 10 min for the cron sweep.
      await markPlaceholder("error", message.slice(0, 500));
      return { created: 0, error: message };
    }
  },
});

// An untitled production packet yielded section headers and even body text as
// document names; keep the whole-document versus section distinction explicit.
export const HEADING_ONLY_PROMPT = `Read only the document's PRINTED NAME: the title for the whole form or worksheet,
such as a title block or letterhead at the very top (e.g. "Learning Print",
"Exit Ticket", or "Weekly Reading Log").
Return JSON only:
{
  "documentHeading": "<the printed document name, verbatim, or null>"
}
A numbered/lettered section label WITHIN the document, such as "I. Strengths and
Interests" or "Part B: Reflection", is a section, not the document name. If that
is the only heading, return null. Do not return body text, a question, the
child's handwriting, a description you compose, or a page/template code in a
corner. Most worksheets genuinely print no document name; null is correct and
expected. Prefer null over a guess. Return a string only when the page clearly
carries a title for the whole document. Return ONLY the JSON.`;

/**
 * Backfill one legacy scan with only printed-heading extraction.
 * Real scans showed materially inconsistent headings at the Haiku tier, so this
 * uses the same portfolio model as the main extraction path.
 */
export const extractHeadingOnly = internalAction({
  args: {
    itemId: v.id("portfolioItems"),
    force: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: boolean; skipped?: boolean }> => {
    const item = await ctx.runQuery(internal.portfolio.aiGetItem, {
      itemId: args.itemId,
    });
    if (!item) return { ok: false, skipped: true };
    if (item.documentHeading !== undefined && !args.force) {
      return { ok: true, skipped: true };
    }
    if (!item.fileStorageId) {
      await ctx.runMutation(internal.portfolio.aiPatchDocumentHeading, {
        itemId: args.itemId,
        documentHeading: "",
      });
      return { ok: true, skipped: true };
    }

    try {
      const blob = await ctx.storage.get(item.fileStorageId);
      if (!blob) throw new Error("Storage blob missing");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const mimeType = item.fileMimeType ?? "application/pdf";
      const { block: fileBlock } = visionFileBlock(bytes, mimeType);
      const institutionId =
        item.institutionId ??
        (item.scholarId
          ? await ctx.runQuery(internal.usage.resolveInstitution, {
              userId: item.scholarId,
              principal: "scholar",
            })
          : null);
      const raw = await callClaude(
        ctx,
        [fileBlock, { type: "text", text: HEADING_ONLY_PROMPT }],
        256,
        "portfolio-heading-backfill",
        institutionId,
        portfolioModel(),
      );
      const parsed = JSON.parse(stripFences(raw)) as {
        documentHeading?: unknown;
      };
      await ctx.runMutation(internal.portfolio.aiPatchDocumentHeading, {
        itemId: args.itemId,
        documentHeading: normalizeDocumentHeading(parsed.documentHeading),
      });
      return { ok: true };
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(
        `[portfolio.extractHeadingOnly] FAILED ${args.itemId}: ${reason}`,
      );
      await ctx.runMutation(internal.portfolio.aiPatchDocumentHeading, {
        itemId: args.itemId,
        documentHeading: "",
      });
      return { ok: false };
    }
  },
});

// ─── Public ingest entry points (teacher/admin/curriculum) ──────────────

/**
 * Ingest a file the teacher uploaded directly (Upload File) or captured from
 * the webcam (Take Photo → one combined PDF). The client has already PUT the
 * bytes via files.generateUploadUrl and hands us the storageId. Processing
 * (segment / rotate / match / assignment) runs async; the item appears in the
 * scanner inbox once ready.
 */
export const ingestUploadedScan = action({
  args: {
    storageId: v.id("_storage"),
    fileMimeType: v.optional(v.string()),
    title: v.string(),
    source: v.optional(v.union(v.literal("upload"), v.literal("photo"))),
    scope: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ scheduled: true }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not signed in");
    // Reject unknown MIME types. `_storage` ids are unguessable, so this
    // is defense-in-depth against a client passing a storageId pointed at a
    // non-scan blob (e.g. an avatar) that would crash extraction.
    if (args.fileMimeType && !isIngestibleMime(args.fileMimeType)) {
      throw new Error(`Unsupported file type: ${args.fileMimeType}`);
    }
    // Scope this upload to the uploader's institution so matching runs against
    // their school's roster and the item lands in their inbox.
    const caller = await ctx.runQuery(
      internal.driveSyncState.resolveInstitutionForCaller,
      { userId, scope: args.scope },
    );
    const institutionId = caller?.institutionId;
    await ctx.runQuery(api.portfolio.scannerCounts, { scope: args.scope });
    // Synchronous placeholder so the inbox spinner appears immediately. If
    // the scheduled action throws before reaching insertSegment, the cron
    // sweep marks this row as `error` after 10 min.
    const placeholderItemId = await ctx.runMutation(
      internal.portfolio.insertPlaceholder,
      {
        source: args.source ?? "upload",
        title: args.title,
        fileStorageId: args.storageId,
        fileMimeType: args.fileMimeType,
        uploadedBy: userId,
        institutionId,
      },
    );
    await ctx.scheduler.runAfter(0, internal.portfolioActions.ingestScan, {
      source: args.source ?? "upload",
      originalStorageId: args.storageId,
      fileMimeType: args.fileMimeType,
      title: args.title,
      placeholderItemId,
      institutionId,
    });
    return { scheduled: true };
  },
});

/**
 * Ingest a one-off file the teacher picked from their Google Drive (not the
 * watched folder). Downloads it server-side via the caller's linked Google
 * account, then runs the same pipeline. driveFileId is set so re-picking the
 * same file dedupes.
 */
export const ingestDriveFileById = action({
  args: {
    fileId: v.string(),
    fileName: v.optional(v.string()),
    fileMimeType: v.optional(v.string()),
    scope: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ scheduled: boolean; error?: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not signed in");

    // Pre-dedupe BEFORE we download + store. ingestScan dedupes too, but its
    // check happens AFTER ctx.storage.store, which leaks a blob on
    // double-clicks (the orphan delete swallows failures silently). Catching
    // it here is one query, no storage write, no race.
    const alreadyExists = await ctx.runQuery(
      internal.portfolio.hasItemsForDriveFile,
      { driveFileId: args.fileId },
    );
    if (alreadyExists) {
      return { scheduled: false, error: "Already imported" };
    }

    // Resolve and validate the target school before touching the user's
    // external Drive account.
    const caller = await ctx.runQuery(
      internal.driveSyncState.resolveInstitutionForCaller,
      { userId, scope: args.scope },
    );
    const institutionId = caller?.institutionId;
    await ctx.runQuery(api.portfolio.scannerCounts, { scope: args.scope });
    const token = await getValidAccessToken(ctx, userId);

    // Resolve name/mime if the picker didn't supply them.
    let name = args.fileName;
    let mime = args.fileMimeType;
    if (!name || !mime) {
      const metaRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${args.fileId}?fields=name,mimeType&supportsAllDrives=true`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!metaRes.ok) {
        return { scheduled: false, error: `Drive metadata failed (${metaRes.status})` };
      }
      const meta = (await metaRes.json()) as { name?: string; mimeType?: string };
      name = name ?? meta.name;
      mime = mime ?? meta.mimeType;
    }
    // MIME allow-list (defense-in-depth — Picker is restricted to scan types).
    if (mime && !isIngestibleMime(mime)) {
      return { scheduled: false, error: `Unsupported file type: ${mime}` };
    }

    const dlRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${args.fileId}?alt=media&supportsAllDrives=true`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!dlRes.ok) {
      return { scheduled: false, error: `Drive download failed (${dlRes.status})` };
    }
    const ab = await dlRes.arrayBuffer();
    const storageId = await ctx.storage.store(
      new Blob([ab], { type: mime ?? "application/octet-stream" }),
    );

    // Scope the pick to the picker's institution (roster + inbox placement).
    // Synchronous placeholder so the inbox spinner appears immediately.
    // ingestScan will delete it once segment rows land (or mark it `error`
    // if AI extraction fails); the cron sweep is the last-resort cleanup.
    const placeholderItemId = await ctx.runMutation(
      internal.portfolio.insertPlaceholder,
      {
        source: "google_drive",
        title: name ?? "Drive file",
        fileStorageId: storageId,
        fileMimeType: mime,
        driveFileId: args.fileId,
        uploadedBy: userId,
        institutionId,
      },
    );
    await ctx.scheduler.runAfter(0, internal.portfolioActions.ingestScan, {
      source: "google_drive",
      driveFileId: args.fileId,
      originalStorageId: storageId,
      fileMimeType: mime,
      title: name ?? "Drive file",
      placeholderItemId,
      institutionId,
    });

    return { scheduled: true };
  },
});
