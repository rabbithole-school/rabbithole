import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  deliverableValidator,
  advanceRubricValidator,
} from "./lib/deliverable";
import { plantTeacherSeed } from "./lib/seeds";
import { toKeyedGranules } from "./lib/granules";
import { institutionIdForUnitAuthor } from "./lib/unitAccess";
import { ROLES } from "./lib/roles";
import { isValidReadingLevel } from "./lib/readingLevels";
import { deleteUserCore } from "./users";
import { moveLessonToUnitCore } from "./lessons";
import type { Doc, Id } from "./_generated/dataModel";

/**
 * Teacher Aide helpers — internal mutations invoked by the curriculum-designer
 * AI tools (defined in http.ts). These exist so teachers can do through the
 * AI chat what Andy previously did via CLI-only scripts
 * (see the now-deleted adminSeed* one-off scripts for the original pattern).
 *
 * As of Phase 1.5, teacher-authored pedagogical instructions live in the
 * dedicated `teacherDirectives` table (see `convex/teacherDirectives.ts`).
 * The old `[Teacher-authored YYYY-MM-DD: <label>]` marker-block approach on
 * the scholar dossier has been removed.
 */

/**
 * Upsert a teacher directive for a scholar by label. Delegates to the
 * `teacherDirectives.upsertByLabel` logic — kept here as a thin wrapper so the
 * curriculum-designer HTTP action keeps a stable `internal.teacherAide.*` API.
 */
export const upsertTeacherDirective = internalMutation({
  args: {
    scholarId: v.id("users"),
    label: v.string(),
    content: v.string(),
    authorId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const label = args.label.trim();
    if (!label) {
      throw new Error("label must be a non-empty string");
    }
    const content = args.content.trim();

    const existing = await ctx.db
      .query("teacherDirectives")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();

    const labelLower = label.toLowerCase();
    const match = existing.find((r) => r.label.toLowerCase() === labelLower);

    const now = Date.now();

    if (match) {
      await ctx.db.patch(match._id, {
        content,
        authorId: args.authorId,
        updatedAt: now,
      });
      return { action: "updated" as const, id: match._id, label: match.label };
    }

    const id = await ctx.db.insert("teacherDirectives", {
      scholarId: args.scholarId,
      label,
      content,
      authorId: args.authorId,
      isActive: true,
      updatedAt: now,
    });
    return { action: "created" as const, id, label };
  },
});

/**
 * Thin wrapper: create an active teacher-origin seed for a scholar.
 * Mirrors seeds.create (teacherMutation) but callable from an internal
 * context (the curriculum-designer HTTP action runs outside user auth).
 */
export const createScholarSeed = internalMutation({
  args: {
    scholarId: v.id("users"),
    teacherId: v.id("users"),
    topic: v.string(),
    domain: v.optional(v.string()),
    rationale: v.string(),
    approachHint: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { id } = await plantTeacherSeed(ctx, {
      scholarId: args.scholarId,
      topic: args.topic.trim(),
      rationale: args.rationale.trim(),
      domain: args.domain?.trim() || undefined,
      approachHint: args.approachHint?.trim() || undefined,
      teacherId: args.teacherId,
    });
    return id;
  },
});

/**
 * Create a scholar-scoped quest for the Curriculum Bot. A "scholar quest"
 * IS an Independent Study unit: it's owned by the scholar
 * (`teacherId = authorScholarId = scholarId`) so it surfaces on the
 * scholar's home + unit picker and they own it — the authoring teacher
 * edits via their teacher role. Same shape as
 * `units.createAndOfferQuestForScholar`.
 *
 * `authorId` is accepted for tool-call signature compatibility but is no
 * longer used for ownership (the scholar is the owner). Before this, the
 * tool produced a generic, un-attached teacher unit reachable only via
 * Browse units, which is why bot-built units never showed up for the
 * scholar. See review/scholar-IS-codesign.md.
 *
 * Idempotent by (scholarId, title) — case-insensitive. If an IS unit with
 * the same title already exists for this scholar, returns the existing
 * unitId with `existed: true` instead of creating a duplicate.
 */
export const createScholarQuest = internalMutation({
  args: {
    scholarId: v.id("users"),
    authorId: v.id("users"),
    title: v.string(),
    emoji: v.optional(v.string()),
    description: v.optional(v.string()),
    bigIdea: v.optional(v.string()),
    essentialQuestions: v.optional(v.array(v.string())),
    enduringUnderstandings: v.optional(v.array(v.string())),
    subject: v.optional(v.string()),
    gradeLevel: v.optional(v.string()),
    // Set when this unit is being designed headlessly from an exploration
    // seed (the seed→unit bake). Stamped onto the unit as provenance.
    bakedFromSeedId: v.optional(v.id("seeds")),
  },
  handler: async (ctx, args) => {
    const title = args.title.trim();
    if (!title) throw new Error("title must be a non-empty string");
    const scholarId = args.scholarId;

    // Idempotency: an IS unit already authored for this scholar with the
    // same (case-insensitive) title.
    const existing = await ctx.db
      .query("units")
      .withIndex("by_authorScholar", (q) =>
        q.eq("authorScholarId", scholarId),
      )
      .collect();
    const titleLower = title.toLowerCase();
    const match = existing.find(
      (u) => u.title.trim().toLowerCase() === titleLower,
    );
    if (match) {
      return { unitId: match._id, existed: true as const };
    }

    const emoji = args.emoji?.trim() || "⚡";
    const institutionId = await institutionIdForUnitAuthor(ctx, scholarId, {
      asScholar: true,
    });
    const unitId = await ctx.db.insert("units", {
      // Owned by the scholar — see the doc comment above. This is what
      // makes it surface on their home (units.myIndependentStudyUnits)
      // and stay private to them (units.list scholar-path filter).
      teacherId: scholarId,
      institutionId,
      title,
      emoji,
      description: args.description?.trim() || undefined,
      bigIdea: args.bigIdea?.trim() || undefined,
      essentialQuestions: args.essentialQuestions
        ? toKeyedGranules(args.essentialQuestions, undefined, "eq")
        : undefined,
      enduringUnderstandings: args.enduringUnderstandings
        ? toKeyedGranules(args.enduringUnderstandings, undefined, "eu")
        : undefined,
      subject: args.subject?.trim() || undefined,
      gradeLevel: args.gradeLevel?.trim() || undefined,
      isActive: true,
      authorScholarId: scholarId,
      ...(args.bakedFromSeedId ? { bakedFromSeedId: args.bakedFromSeedId } : {}),
      badgeOnCompletion: {
        title: `${title} — completed`,
        description: `Earned by completing every activity in "${title}".`,
        icon: emoji,
      },
    });
    return { unitId, existed: false as const };
  },
});

/**
 * Create a GENERAL curriculum unit (not scholar-scoped) — the generative
 * entry point on the Curriculum landing's bot ("describe a unit and I'll
 * build it"). Mirrors `createScholarQuest` but the unit is owned by the
 * authoring teacher and visible in the general curriculum index
 * (`units.list`), with no `authorScholarId` / completion badge.
 *
 * Idempotent by (authorId, title) — case-insensitive — so a model retry
 * doesn't spawn a duplicate "Untitled"-style unit. A unit is an empty
 * container; follow up with create_scholar_lesson / the unit designer bot
 * to populate it.
 */
export const createCurriculumUnit = internalMutation({
  args: {
    authorId: v.id("users"),
    title: v.string(),
    emoji: v.optional(v.string()),
    description: v.optional(v.string()),
    bigIdea: v.optional(v.string()),
    essentialQuestions: v.optional(v.array(v.string())),
    enduringUnderstandings: v.optional(v.array(v.string())),
    subject: v.optional(v.string()),
    gradeLevel: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const title = args.title.trim();
    if (!title) throw new Error("title must be a non-empty string");

    // Idempotency: a general unit this author already created with the same
    // (case-insensitive) title. Scoped to the author's own units so two
    // teachers can independently have like-named units.
    const existing = await ctx.db
      .query("units")
      .withIndex("by_teacher", (q) => q.eq("teacherId", args.authorId))
      .collect();
    const titleLower = title.toLowerCase();
    const match = existing.find(
      (u) => !u.authorScholarId && u.title.trim().toLowerCase() === titleLower,
    );
    if (match) {
      return { unitId: match._id, existed: true as const };
    }

    const institutionId = await institutionIdForUnitAuthor(ctx, args.authorId);
    const unitId = await ctx.db.insert("units", {
      teacherId: args.authorId,
      institutionId,
      title,
      emoji: args.emoji?.trim() || undefined,
      description: args.description?.trim() || undefined,
      bigIdea: args.bigIdea?.trim() || undefined,
      essentialQuestions: args.essentialQuestions
        ? toKeyedGranules(args.essentialQuestions, undefined, "eq")
        : undefined,
      enduringUnderstandings: args.enduringUnderstandings
        ? toKeyedGranules(args.enduringUnderstandings, undefined, "eu")
        : undefined,
      subject: args.subject?.trim() || undefined,
      gradeLevel: args.gradeLevel?.trim() || undefined,
      isActive: true,
    });
    return { unitId, existed: false as const };
  },
});

/**
 * Create a lesson under a given unit. Appends by default; an explicit
 * zero-based position inserts there and shifts a consecutive occupied run.
 *
 * Idempotent by (unitId, title) — case-insensitive. If a lesson with the same
 * title already exists under this unit, returns the existing lessonId with
 * `existed: true` instead of creating a duplicate.
 */
export const createScholarLesson = internalMutation({
  args: {
    unitId: v.id("units"),
    title: v.string(),
    strand: v.optional(
      v.union(
        v.literal("core"),
        v.literal("connections"),
        v.literal("practice"),
        v.literal("identity")
      )
    ),
    systemPrompt: v.optional(v.string()),
    durationMinutes: v.optional(v.number()),
    position: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const title = args.title.trim();
    if (!title) throw new Error("title must be a non-empty string");
    if (
      args.position !== undefined &&
      (!Number.isInteger(args.position) || args.position < 0)
    ) {
      throw new Error("position must be a non-negative integer");
    }

    const existing = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", args.unitId))
      .collect();

    const titleLower = title.toLowerCase();
    const match = existing.find(
      (l) => l.title.trim().toLowerCase() === titleLower
    );
    if (match) {
      return { lessonId: match._id, existed: true as const };
    }

    const order =
      args.position ??
      existing.reduce((max, l) => Math.max(max, l.order), -1) + 1;
    if (args.position !== undefined) {
      const occupiedOrders = new Set(existing.map((sibling) => sibling.order));
      let firstOpenOrder = order;
      while (occupiedOrders.has(firstOpenOrder)) firstOpenOrder += 1;
      for (const sibling of existing) {
        if (sibling.order >= order && sibling.order < firstOpenOrder) {
          await ctx.db.patch(sibling._id, { order: sibling.order + 1 });
        }
      }
    }
    const lessonId = await ctx.db.insert("lessons", {
      unitId: args.unitId,
      title,
      strand: args.strand,
      systemPrompt: args.systemPrompt?.trim() || undefined,
      order,
      durationMinutes: args.durationMinutes,
    });
    return { lessonId, existed: false as const };
  },
});

/**
 * Move a lesson (and its activities, which follow automatically — they
 * only reference `lessonId`, never `unitId`) to a different unit. Shares
 * `moveLessonToUnitCore` with the public `lessons.moveToUnit` mutation so
 * the two paths can't drift.
 *
 * ACL note: unlike `lessons.moveToUnit`, this mutation does NOT call
 * `requireUnitEditAccess` itself — like `createScholarLesson` above, it
 * trusts the aide tool's role gate (the `canSeeScholarData` group in
 * `lib/aideTools.ts`, teacher/admin only) as the auth boundary, since an
 * internal mutation invoked from an aide tool doesn't carry the original
 * caller's identity.
 */
export const moveLesson = internalMutation({
  args: {
    lessonId: v.id("lessons"),
    targetUnitId: v.id("units"),
  },
  handler: async (ctx, args) => {
    return await moveLessonToUnitCore(ctx, {
      id: args.lessonId,
      targetUnitId: args.targetUnitId,
    });
  },
});

/**
 * Create an activity under a lesson. `kind` selects the activity type
 * (online tutor session / offline classroom task / vibecode build
 * workshop); it defaults to "online". An ONLINE activity must carry either
 * a document deliverable quality map or a conversation advance rubric,
 * enforced downstream by `requireDeliverableForOnline` in
 * activities.upsertInternal. offline and vibecode activities take neither.
 *
 * Idempotent by (lessonId, title) — case-insensitive.
 *
 * Earlier iterations forced a deliverable on EVERY call with an
 * escape-hatch confirmNoDeliverable flag. Sonnet kept taking the escape
 * hatch even when the teacher described a clear quality bar. The
 * deliverable is now required-by-kind (online only) rather than a flag the
 * bot can wave away. Open-ended activities (discussion, journaling) can be
 * authored via the teacher UI directly when needed.
 */
/**
 * Thin wrapper around activities.upsertInternal — keeps the
 * `internal.teacherAide.createScholarActivity` API stable for the
 * global Curriculum Bot tool. All actual logic (normalize, guard,
 * idempotent upsert, ordering) lives in the canonical primitive.
 */
export const createScholarActivity = internalMutation({
  args: {
    lessonId: v.id("lessons"),
    title: v.string(),
    description: v.optional(v.string()),
    scholarDescription: v.optional(v.string()),
    // Activity kind. Defaults to "online" (an AI-tutor session). "offline" is
    // a classroom task; "vibecode" is a full-screen app-builder workshop whose
    // systemPrompt IS the build brief. Only these three are safe from the
    // global aide — game/web/world/shareBack/problem_set need extra payload.
    // World/problem_set use dedicated global tools; the catalog-backed kinds
    // remain an Edit-surface hand-off until their lookup tools ship.
    kind: v.optional(
      v.union(
        v.literal("online"),
        v.literal("offline"),
        v.literal("vibecode"),
      ),
    ),
    systemPrompt: v.optional(v.string()),
    durationMinutes: v.optional(v.number()),
    position: v.optional(v.number()),
    // Optional now that non-online kinds exist. `upsertInternal` still enforces
    // "an online activity MUST have a deliverable" via requireDeliverableForOnline.
    deliverable: v.optional(deliverableValidator),
    // Conversation exit bar for an online activity with NO document — the
    // tutor grades the discussion + map interactions. Mutually exclusive
    // with `deliverable`; either satisfies the online-grading guard.
    advanceRubric: v.optional(advanceRubricValidator),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    activityId: Id<"activities">;
    existed: boolean;
    kind: Doc<"activities">["kind"];
    deliverableAttached: boolean;
    advanceRubricAttached: boolean;
    unitId: Id<"units">;
  }> => {
    const title = args.title.trim();
    if (!title) throw new Error("title must be a non-empty string");
    const lesson = await ctx.db.get(args.lessonId);
    if (!lesson) throw new Error("Lesson not found");
    const result = await ctx.runMutation(internal.activities.upsertInternal, {
      parent: { kind: "lesson" as const, lessonId: args.lessonId },
      match: { byTitle: title },
      title,
      description: args.description,
      scholarDescription: args.scholarDescription,
      kind: args.kind ?? "online",
      systemPrompt: args.systemPrompt,
      durationMinutes: args.durationMinutes,
      position: args.position,
      deliverable: args.deliverable,
      advanceRubric: args.advanceRubric,
    });
    // unitId lets the caller build a deep link to the created activity
    // (unitPath(unitId, { lessonId, activityId })).
    return { ...result, unitId: lesson.unitId };
  },
});

/**
 * Record a teacher observation about a scholar, including a neutral Whole Child
 * take. The Slack bot's quick-capture tool lands here; mirrors
 * `observations.add` with an explicit teacherId because the bot acts on behalf
 * of a mapped Slack user, not a Convex Auth identity. Role gating
 * (teacher/admin) happens in the tool assembler, same trust model as the other
 * internal mutations in this file.
 */
export const addScholarObservation = internalMutation({
  args: {
    teacherId: v.id("users"),
    scholarId: v.id("users"),
    note: v.string(),
    type: v.union(
      v.literal("praise"),
      v.literal("concern"),
      v.literal("suggestion"),
      v.literal("intervention"),
      v.literal("note"),
    ),
    weight: v.optional(v.union(v.literal("minor"), v.literal("major"))),
    periodId: v.optional(v.id("reportingPeriods")),
    category: v.optional(
      v.union(
        v.literal("execFunction"),
        v.literal("socialEmotional"),
        v.literal("collaboration"),
        v.literal("passions"),
        v.literal("other"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const note = args.note.trim();
    if (!note) throw new Error("note must be a non-empty string");
    // Defense-in-depth: never write an observation against a non-scholar
    // account (parity with the report/dossier scribe tools; callers already
    // resolve through the scholars-only roster).
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) {
      throw new Error("Scholar not found");
    }
    const id = await ctx.db.insert("observations", {
      teacherId: args.teacherId,
      scholarId: args.scholarId,
      note,
      type: args.type,
      weight: args.weight,
      category: args.category,
      periodId: args.category ? args.periodId : undefined,
    });
    return { observationId: id };
  },
});

/**
 * Create a teacher report for a scholar (a dated narrative note). Mirrors
 * `scholarDocuments.createTextReport` — a teacher-authored TEXT document
 * (kind "teacher_report") routed through the same extract→redact pipeline as
 * every other document, so the scholar-facing tutor only ever sees the
 * redacted variant — but with an explicit teacherId so a bot can author it on
 * the teacher's behalf. Role gating (teacher/admin) is in the tool assembler.
 * (The legacy `reports` table + its raw-text dossier auto-append are retired —
 * dropped after the reports→Documents fold; history in PROMPT_HISTORY.md.)
 */
export const addScholarReport = internalMutation({
  args: {
    teacherId: v.id("users"),
    scholarId: v.id("users"),
    title: v.string(),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const title = args.title.trim();
    const content = args.content.trim();
    if (!title) throw new Error("title must be a non-empty string");
    if (!content) throw new Error("content must be a non-empty string");

    // Defense-in-depth: never write a report against a non-scholar account
    // (callers already resolve through the scholars-only roster).
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) {
      throw new Error("Scholar not found");
    }

    const documentId = await ctx.db.insert("scholarDocuments", {
      scholarId: args.scholarId,
      kind: "teacher_report",
      format: "text",
      title,
      bodyText: content,
      // Seed extractedText so the redaction action skips file extraction and
      // redacts the teacher's words directly (same as createTextReport).
      extractedText: content,
      uploadedBy: args.teacherId,
      processingStatus: "pending",
      // Teacher-authored notes inform the tutor by default (per Andy, Jun 2026).
      feedsTutor: true,
    });

    await ctx.db.insert("documentAccessLog", {
      documentId,
      scholarId: args.scholarId,
      userId: args.teacherId,
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
 * Update a scholar's dossier (the teacher-/observer-authored learning notes).
 * `mode: "append"` adds a dated block; `mode: "replace"` overwrites the whole
 * dossier (use sparingly — it discards history). Mirrors
 * `dossier.updateByTeacher`. Role gating (teacher/admin) is in the assembler.
 */
export const updateScholarDossier = internalMutation({
  args: {
    scholarId: v.id("users"),
    content: v.string(),
    mode: v.union(v.literal("append"), v.literal("replace")),
  },
  handler: async (ctx, args) => {
    const content = args.content.trim();
    if (!content) throw new Error("content must be a non-empty string");

    // Defense-in-depth: never write a dossier against a non-scholar account.
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) {
      throw new Error("Scholar not found");
    }

    const existing = await ctx.db
      .query("scholarDossiers")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .first();

    if (args.mode === "replace") {
      if (existing) {
        await ctx.db.patch(existing._id, { content });
      } else {
        await ctx.db.insert("scholarDossiers", { scholarId: args.scholarId, content });
      }
      return { mode: "replace" as const };
    }

    // append
    const dateStr = new Date().toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    const appendText = `\n\n--- Note (${dateStr}) ---\n${content}`;
    if (existing) {
      await ctx.db.patch(existing._id, { content: existing.content + appendText });
    } else {
      await ctx.db.insert("scholarDossiers", {
        scholarId: args.scholarId,
        content: appendText.trimStart(),
      });
    }
    return { mode: "append" as const };
  },
});

/**
 * Set (or clear) a scholar's reading level. Mirrors
 * `scholars.updateReadingLevel`: validates the level, patches the user,
 * clears any pending AI suggestion, and records a teacher-sourced history
 * row. `readingLevel: null` clears the level. Role gating (teacher/admin)
 * is in the assembler.
 */
export const setScholarReadingLevel = internalMutation({
  args: {
    callerUserId: v.id("users"),
    scholarId: v.id("users"),
    readingLevel: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    if (args.readingLevel !== null && !isValidReadingLevel(args.readingLevel)) {
      throw new Error(
        `Invalid reading level "${args.readingLevel}". Use "K", a grade like "3" or "5.4", or "college".`,
      );
    }
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) {
      throw new Error("Scholar not found");
    }
    await ctx.db.patch(args.scholarId, {
      readingLevel: args.readingLevel ?? undefined,
      // Mirror scholars.updateReadingLevel: the teacher has ruled, so the pending
      // writing-derived estimate and its timestamp are both superseded.
      // DEPENDS ON pending schema addition users.readingLevelSuggestionAt.
      readingLevelSuggestion: undefined,
      readingLevelSuggestionAt: undefined,
    });
    if (args.readingLevel !== null) {
      await ctx.db.insert("readingLevelHistory", {
        scholarId: args.scholarId,
        level: args.readingLevel,
        source: "teacher",
        changedBy: args.callerUserId,
      });
    }
    return { readingLevel: args.readingLevel };
  },
});

/**
 * Update a scholar's profile fields (display name, date of birth). Mirrors
 * `users.adminUpdateScholarProfile` (scholar-admin powers). Role gating is
 * in the assembler (isScholarAdminRole).
 */
export const updateScholarProfile = internalMutation({
  args: {
    scholarId: v.id("users"),
    name: v.optional(v.string()),
    dateOfBirth: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) {
      throw new Error("Scholar not found");
    }
    const patch: Record<string, string> = {};
    if (args.name !== undefined) {
      const trimmed = args.name.trim();
      if (trimmed === "") throw new Error("Name cannot be empty");
      patch.name = trimmed;
    }
    if (args.dateOfBirth !== undefined) patch.dateOfBirth = args.dateOfBirth;
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.scholarId, patch);
    }
    return { updated: Object.keys(patch) };
  },
});

/**
 * Reset (remove) all of a scholar's passkeys — the "kid can't get past the
 * passkey prompt" recovery. Mirrors `passkeys.resetForScholar`. Role gating
 * (scholar-admin) + surface gating (private only) is in the assembler.
 */
export const resetScholarPasskeys = internalMutation({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar) throw new Error("Scholar not found");
    if (scholar.role !== ROLES.SCHOLAR) {
      throw new Error("Can only reset scholar passkeys");
    }
    const existing = await ctx.db
      .query("passkeys")
      .withIndex("by_user", (q) => q.eq("userId", args.scholarId))
      .collect();
    for (const p of existing) await ctx.db.delete(p._id);
    return { removed: existing.length };
  },
});

/**
 * Permanently delete a scholar and every record that references them. Mirrors
 * the admin dashboard's `users.deleteUser` (shares `deleteUserCore`). This is
 * IRREVERSIBLE. Role gating (admin only) + surface gating (private only) is in
 * the assembler.
 */
export const deleteScholar = internalMutation({
  args: { callerUserId: v.id("users"), scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) {
      throw new Error("Scholar not found");
    }
    return await deleteUserCore(ctx, args.scholarId, args.callerUserId);
  },
});

/**
 * Add a portfolio work-sample for a scholar from an already-uploaded file.
 * Mirrors `portfolio.registerUpload` (source "manual", auto-confirmed, no
 * assignment) and kicks the extract+thumbnail pipeline. Role gating
 * (teacher/admin) is in the assembler.
 */
export const addPortfolioItem = internalMutation({
  args: {
    callerUserId: v.id("users"),
    scholarId: v.id("users"),
    title: v.string(),
    fileStorageId: v.id("_storage"),
    fileMimeType: v.optional(v.string()),
    fileSizeBytes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) {
      throw new Error("Scholar not found");
    }
    const itemId = await ctx.db.insert("portfolioItems", {
      scholarId: args.scholarId,
      title: args.title.trim() || "Untitled work",
      source: "manual",
      fileStorageId: args.fileStorageId,
      fileMimeType: args.fileMimeType,
      fileSizeBytes: args.fileSizeBytes,
      matchStatus: "confirmed",
      matchConfidence: 1,
      assignmentStatus: "none",
      uploadedBy: args.callerUserId,
      processingStatus: "pending",
      thumbStatus: "pending",
      institutionId: scholar.institutionId,
      familyVisibility: "attributed_families",
    });
    await ctx.db.insert("portfolioAttributions", {
      portfolioItemId: itemId,
      scholarId: args.scholarId,
      attributedAt: Date.now(),
      attributedBy: args.callerUserId,
    });
    await ctx.scheduler.runAfter(0, internal.portfolioActions.extractAndMatch, {
      itemId,
    });
    return { itemId };
  },
});
