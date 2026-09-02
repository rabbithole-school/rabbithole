import { v } from "convex/values";
import { internalMutation, internalQuery, MutationCtx, DatabaseReader } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { teacherQuery, teacherMutation } from "./lib/customFunctions";
import { requireActiveScholarAccess } from "./lib/access";
import { gatherWorkingLevel } from "./workingLevel";
import { isValidRating } from "./lib/pcm";

/**
 * Course narratives (review/assessment-and-goals-plan.html §7).
 *
 * One per scholar × period × subject. The TEACHER writes the prose + assigns
 * the ratings; Rabbithole briefs (the binder), checks the draft, and stores its
 * OWN rating suggestion — revealed only AFTER the teacher commits theirs
 * (anti-anchoring, enforced here at the read layer). The (teacher, AI) pair is
 * the calibration dataset (§11). Numbers never reach the tutor or the scholar.
 */

const DEFAULT_SECTIONS: { key: string; title: string }[] = [
  { key: "context", title: "Context — what we studied" },
  { key: "progress", title: "Progress & accomplishments" },
  { key: "dim_core", title: "Core" },
  { key: "dim_connections", title: "Connections" },
  { key: "dim_practice", title: "Practice" },
  { key: "dim_identity", title: "Identity" },
  { key: "goals", title: "Goals for Continued Growth" },
];

const pcmRatingsValidator = v.object({
  core: v.optional(v.number()),
  connections: v.optional(v.number()),
  practice: v.optional(v.number()),
  identity: v.optional(v.number()),
});

const statusValidator = v.union(
  v.literal("draft"),
  v.literal("final"),
  v.literal("shared"),
);

// ── Queries ───────────────────────────────────────────────────────────

/** The teacher's narratives for a period (the "write all my narratives" queue). */
export const listForPeriod = teacherQuery({
  args: { periodId: v.id("reportingPeriods") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("courseNarratives")
      .withIndex("by_teacher_period", (q) =>
        q.eq("teacherId", ctx.user._id).eq("periodId", args.periodId),
      )
      .collect();
    return await Promise.all(
      rows.map(async (n) => {
        const scholar = await ctx.db.get(n.scholarId);
        return {
          _id: n._id,
          scholarId: n.scholarId,
          scholarName: scholar?.name ?? "Scholar",
          subject: n.subject,
          status: n.status,
          hasContent:
            n.sections.some((s) => s.body.trim().length > 0) || n.courseRating != null,
          ratingsCommittedAt: n.ratingsCommittedAt ?? null,
        };
      }),
    );
  },
});

/**
 * Get a single narrative by id (with the scholar's name + signoff authors).
 */
export const get = teacherQuery({
  args: { narrativeId: v.id("courseNarratives") },
  handler: async (ctx, args) => {
    const n = await ctx.db.get(args.narrativeId);
    if (!n) return null;
    await requireActiveScholarAccess(ctx, ctx.user, n.scholarId);
    const scholar = await ctx.db.get(n.scholarId);
    const signoffs = await Promise.all(
      (n.signoffs ?? []).map(async (s) => {
        const u = await ctx.db.get(s.userId);
        return { userId: s.userId, at: s.at, name: u?.name ?? "Staff" };
      }),
    );
    return {
      ...n,
      scholarName: scholar?.name ?? "Scholar",
      signoffs,
      signedOffByMe: (n.signoffs ?? []).some((s) => s.userId === ctx.user._id),
    };
  },
});

/** All of a scholar's narratives across periods (for their portfolio timeline). */
export const listForScholar = teacherQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    return await ctx.db
      .query("courseNarratives")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .order("desc")
      .collect();
  },
});

// ── Mutations ─────────────────────────────────────────────────────────

/** Open (create-if-absent) the narrative for a scholar × period × subject. */
export const open = teacherMutation({
  args: {
    scholarId: v.id("users"),
    periodId: v.id("reportingPeriods"),
    subject: v.string(),
  },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const existing = await ctx.db
      .query("courseNarratives")
      .withIndex("by_scholar_period", (q) =>
        q.eq("scholarId", args.scholarId).eq("periodId", args.periodId),
      )
      .collect();
    const match = existing.find(
      (n) => n.subject.toLowerCase() === args.subject.toLowerCase(),
    );
    if (match) return match._id;
    // Units aren't chosen by hand — derive them from what the scholar actually
    // worked on in the period window (their sessions), scoped to the subject.
    const unitIds = await deriveUnitIds(ctx, args.scholarId, args.periodId, args.subject);
    return await ctx.db.insert("courseNarratives", {
      scholarId: args.scholarId,
      teacherId: ctx.user._id,
      periodId: args.periodId,
      subject: args.subject,
      unitIds,
      sections: DEFAULT_SECTIONS.map((s) => ({ ...s, body: "" })),
      goalIds: [],
      status: "draft",
    });
  },
});

/**
 * The units a scholar actually engaged this period for a subject — derived
 * from their in-window sessions, NOT hand-picked. Live query the composer uses
 * for the (read-only) Context reference + to scope the binder.
 */
export const derivedUnits = teacherQuery({
  args: {
    scholarId: v.id("users"),
    periodId: v.id("reportingPeriods"),
    subject: v.string(),
  },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const ids = await deriveUnitIds(ctx, args.scholarId, args.periodId, args.subject);
    const out: { id: Id<"units">; title: string }[] = [];
    for (const id of ids) {
      const u = await ctx.db.get(id);
      if (u) out.push({ id, title: u.title });
    }
    return out;
  },
});

/** Save one section's body (the teacher's prose). */
export const saveSection = teacherMutation({
  args: {
    narrativeId: v.id("courseNarratives"),
    key: v.string(),
    body: v.string(),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const n = await requireNarrative(ctx, args.narrativeId);
    const sections = [...n.sections];
    const idx = sections.findIndex((s) => s.key === args.key);
    if (idx >= 0) {
      sections[idx] = {
        ...sections[idx],
        body: args.body,
        title: args.title ?? sections[idx].title,
      };
    } else {
      sections.push({ key: args.key, title: args.title ?? args.key, body: args.body });
    }
    await ctx.db.patch(args.narrativeId, { sections });
    return await ctx.db.get(args.narrativeId);
  },
});

/** Toggle a section's "done" flag (the author-set completion state). */
export const setSectionDone = teacherMutation({
  args: {
    narrativeId: v.id("courseNarratives"),
    key: v.string(),
    done: v.boolean(),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const n = await requireNarrative(ctx, args.narrativeId);
    const sections = [...n.sections];
    const idx = sections.findIndex((s) => s.key === args.key);
    if (idx >= 0) {
      sections[idx] = { ...sections[idx], done: args.done };
    } else {
      sections.push({ key: args.key, title: args.title ?? args.key, body: "", done: args.done });
    }
    await ctx.db.patch(args.narrativeId, { sections });
    return await ctx.db.get(args.narrativeId);
  },
});

/** Re-derive + refresh the stored units from the scholar's in-window sessions. */
export const refreshUnits = teacherMutation({
  args: { narrativeId: v.id("courseNarratives") },
  handler: async (ctx, args) => {
    const n = await requireNarrative(ctx, args.narrativeId);
    const unitIds = await deriveUnitIds(ctx, n.scholarId, n.periodId, n.subject);
    await ctx.db.patch(args.narrativeId, { unitIds });
    return unitIds;
  },
});

/**
 * Save the teacher's PCM ratings + Course Performance Rating (teacher-authored;
 * no AI suggestion, no anti-anchoring ceremony — assessment is the teacher's).
 */
export const setRatings = teacherMutation({
  args: {
    narrativeId: v.id("courseNarratives"),
    pcmRatings: pcmRatingsValidator,
    courseRating: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireNarrative(ctx, args.narrativeId);
    for (const val of [
      args.pcmRatings.core,
      args.pcmRatings.connections,
      args.pcmRatings.practice,
      args.pcmRatings.identity,
      args.courseRating,
    ]) {
      if (val !== undefined && !isValidRating(val))
        throw new Error("Ratings must be integers 1–7");
    }
    await ctx.db.patch(args.narrativeId, {
      pcmRatings: args.pcmRatings,
      courseRating: args.courseRating,
    });
    return await ctx.db.get(args.narrativeId);
  },
});

/** Toggle the caller's team signoff on a narrative (simple collaboration). */
export const toggleSignoff = teacherMutation({
  args: { narrativeId: v.id("courseNarratives") },
  handler: async (ctx, args) => {
    const n = await requireNarrative(ctx, args.narrativeId);
    const current = n.signoffs ?? [];
    const mine = current.find((s) => s.userId === ctx.user._id);
    const next = mine
      ? current.filter((s) => s.userId !== ctx.user._id)
      : [...current, { userId: ctx.user._id, at: Date.now() }];
    await ctx.db.patch(args.narrativeId, { signoffs: next });
    return await ctx.db.get(args.narrativeId);
  },
});

export const setGoals = teacherMutation({
  args: {
    narrativeId: v.id("courseNarratives"),
    goalIds: v.array(v.id("scholarGoals")),
  },
  handler: async (ctx, args) => {
    await requireNarrative(ctx, args.narrativeId);
    await ctx.db.patch(args.narrativeId, { goalIds: args.goalIds });
  },
});

/** Mark a narrative final + snapshot the Working Level (report says what was true then). */
export const finalize = teacherMutation({
  args: { narrativeId: v.id("courseNarratives") },
  handler: async (ctx, args) => {
    const n = await requireNarrative(ctx, args.narrativeId);
    const period = await ctx.db.get(n.periodId);
    const window = period
      ? { startsAt: period.startsAt, endsAt: period.endsAt }
      : undefined;
    const workingLevel = await gatherWorkingLevel(ctx.db, n.scholarId, window);
    await ctx.db.patch(args.narrativeId, { status: "final", workingLevel });
    return await ctx.db.get(args.narrativeId);
  },
});

export const setStatus = teacherMutation({
  args: { narrativeId: v.id("courseNarratives"), status: statusValidator },
  handler: async (ctx, args) => {
    await requireNarrative(ctx, args.narrativeId);
    await ctx.db.patch(args.narrativeId, { status: args.status });
  },
});

/**
 * Report-level "Mark as done" toggle — the completion axis (distinct from the
 * separate sharing axis). done ⇒ status "final" (+ snapshot the Working Level,
 * same as the old Finalize); not-done ⇒ back to "draft". A shared report is
 * definitionally done, so this is a no-op once shared (unshare first).
 */
export const setDone = teacherMutation({
  args: { narrativeId: v.id("courseNarratives"), done: v.boolean() },
  handler: async (ctx, args) => {
    const n = await requireNarrative(ctx, args.narrativeId);
    if (n.status === "shared") return await ctx.db.get(args.narrativeId);
    if (args.done) {
      const period = await ctx.db.get(n.periodId);
      const window = period
        ? { startsAt: period.startsAt, endsAt: period.endsAt }
        : undefined;
      const workingLevel = await gatherWorkingLevel(ctx.db, n.scholarId, window);
      await ctx.db.patch(args.narrativeId, { status: "final", workingLevel });
    } else {
      await ctx.db.patch(args.narrativeId, { status: "draft" });
    }
    return await ctx.db.get(args.narrativeId);
  },
});

/**
 * Share a FINAL narrative: mark it shared, and land the PROSE (ratings/numbers
 * excluded — §3 prose-only) as a scholarDocuments teacher_report so it enters
 * the redaction pipeline + document history (§5) and the existing "generate
 * proposal" flow can refresh the dossier from it (never auto-applied). Parents
 * see the shared prose in the portal.
 */
export const share = teacherMutation({
  args: { narrativeId: v.id("courseNarratives") },
  handler: async (ctx, args) => {
    const n = await requireNarrative(ctx, args.narrativeId);
    if (n.status === "draft")
      throw new Error("Finalize the narrative before sharing");
    const documentId = await writeNarrativeDocument(ctx, n);
    await ctx.db.patch(args.narrativeId, {
      status: "shared",
      sharedAt: Date.now(),
      documentId,
    });
    return await ctx.db.get(args.narrativeId);
  },
});

/** Period-level share: push every FINAL narrative in a period at once. */
export const sharePeriod = teacherMutation({
  args: { periodId: v.id("reportingPeriods") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("courseNarratives")
      .withIndex("by_teacher_period", (q) =>
        q.eq("teacherId", ctx.user._id).eq("periodId", args.periodId),
      )
      .collect();
    let shared = 0;
    for (const n of rows) {
      if (n.status !== "final") continue;
      const documentId = await writeNarrativeDocument(ctx, n);
      await ctx.db.patch(n._id, {
        status: "shared",
        sharedAt: Date.now(),
        documentId,
      });
      shared++;
    }
    return { shared };
  },
});

// ── Internal (the curriculum-bot read/write-report tools) ─────────────

const DIMENSION_TO_SECTION: Record<string, string> = {
  core: "dim_core",
  connections: "dim_connections",
  practice: "dim_practice",
  identity: "dim_identity",
};

/** Read a scholar's narrative(s) for a period, for the bot's get_scholar_report. */
export const getForBot = internalQuery({
  args: {
    scholarId: v.id("users"),
    periodId: v.id("reportingPeriods"),
    subject: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("courseNarratives")
      .withIndex("by_scholar_period", (q) =>
        q.eq("scholarId", args.scholarId).eq("periodId", args.periodId),
      )
      .collect();
    const filtered = args.subject
      ? rows.filter((n) => n.subject.toLowerCase() === args.subject!.toLowerCase())
      : rows;
    return filtered.map((n) => ({
      _id: n._id,
      subject: n.subject,
      status: n.status,
      sections: n.sections,
      pcmRatings: n.pcmRatings ?? null,
      courseRating: n.courseRating ?? null,
    }));
  },
});

/** Open-if-missing a narrative for (scholar, period, subject); returns its id. */
export const openInternal = internalMutation({
  args: {
    scholarId: v.id("users"),
    teacherId: v.id("users"),
    periodId: v.id("reportingPeriods"),
    subject: v.string(),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("courseNarratives")
      .withIndex("by_scholar_period", (q) =>
        q.eq("scholarId", args.scholarId).eq("periodId", args.periodId),
      )
      .collect();
    const match = rows.find(
      (n) => n.subject.toLowerCase() === args.subject.toLowerCase(),
    );
    if (match) return match._id;
    const unitIds = await deriveUnitIds(ctx, args.scholarId, args.periodId, args.subject);
    return await ctx.db.insert("courseNarratives", {
      scholarId: args.scholarId,
      teacherId: args.teacherId,
      periodId: args.periodId,
      subject: args.subject,
      unitIds,
      sections: DEFAULT_SECTIONS.map((s) => ({ ...s, body: "" })),
      goalIds: [],
      status: "draft",
    });
  },
});

/** Write one section body (the bot's write_report_section tool). */
export const setSectionInternal = internalMutation({
  args: { narrativeId: v.id("courseNarratives"), key: v.string(), body: v.string() },
  handler: async (ctx, args) => {
    const n = await ctx.db.get(args.narrativeId);
    if (!n) throw new Error("Narrative not found");
    const sections = [...n.sections];
    const idx = sections.findIndex((s) => s.key === args.key);
    const title = DEFAULT_SECTIONS.find((s) => s.key === args.key)?.title ?? args.key;
    if (idx >= 0) sections[idx] = { ...sections[idx], body: args.body };
    else sections.push({ key: args.key, title, body: args.body });
    await ctx.db.patch(args.narrativeId, { sections });
  },
});

/** Set one rating (the bot's set_report_rating tool). dimension incl. "overall". */
export const setRatingInternal = internalMutation({
  args: {
    narrativeId: v.id("courseNarratives"),
    dimension: v.string(),
    value: v.number(),
  },
  handler: async (ctx, args) => {
    const n = await ctx.db.get(args.narrativeId);
    if (!n) throw new Error("Narrative not found");
    if (!Number.isInteger(args.value) || args.value < 1 || args.value > 7)
      throw new Error("Rating must be an integer 1–7");
    if (args.dimension === "overall") {
      await ctx.db.patch(args.narrativeId, { courseRating: args.value });
      return;
    }
    if (!(args.dimension in DIMENSION_TO_SECTION))
      throw new Error(`Unknown dimension "${args.dimension}"`);
    await ctx.db.patch(args.narrativeId, {
      pcmRatings: { ...(n.pcmRatings ?? {}), [args.dimension]: args.value },
    });
  },
});

// ── Helpers ───────────────────────────────────────────────────────────

async function requireNarrative(
  ctx: MutationCtx & { user: Doc<"users"> },
  narrativeId: Id<"courseNarratives">,
): Promise<Doc<"courseNarratives">> {
  const n = await ctx.db.get(narrativeId);
  if (!n) throw new Error("Narrative not found");
  await requireActiveScholarAccess(ctx, ctx.user, n.scholarId);
  return n;
}

/**
 * The units a scholar engaged in-window for a subject — from their sessions
 * (the ground truth of what the child actually worked on), never hand-picked.
 * Deduped, scoped to the reporting period's date range + the subject.
 */
async function deriveUnitIds(
  ctx: { db: DatabaseReader },
  scholarId: Id<"users">,
  periodId: Id<"reportingPeriods">,
  subject: string,
): Promise<Id<"units">[]> {
  const period = await ctx.db.get(periodId);
  if (!period) return [];
  const subjectLc = subject.trim().toLowerCase();
  const sessions = await ctx.db
    .query("sessions")
    .withIndex("by_user", (q) => q.eq("userId", scholarId))
    .collect();
  const seen = new Set<string>();
  const out: Id<"units">[] = [];
  for (const s of sessions) {
    if (s._creationTime < period.startsAt || s._creationTime > period.endsAt) continue;
    if (!s.unitId || seen.has(String(s.unitId))) continue;
    const unit = await ctx.db.get(s.unitId);
    if (!unit) continue;
    if ((unit.subject ?? "").trim().toLowerCase() !== subjectLc) continue;
    seen.add(String(s.unitId));
    out.push(s.unitId);
  }
  return out;
}


/**
 * Assemble a narrative's PROSE (ratings/numbers excluded) into the shared
 * document / parent view / PDF text. Pure + exported so the parent portal and
 * the conference export render identical prose. §3: prose-only.
 */
export function narrativeToProse(
  subject: string,
  periodLabel: string,
  sections: { key: string; title: string; body: string }[],
): string {
  const parts = [`${subject} — ${periodLabel}`];
  for (const s of sections) {
    if (!s.body.trim()) continue;
    parts.push(`\n## ${s.title}\n${s.body.trim()}`);
  }
  return parts.join("\n");
}

/**
 * Land the narrative's prose as a scholarDocuments teacher_report + schedule
 * redaction. `feedsTutor: false` — the narrative reaches the tutor only via a
 * teacher-approved dossier proposal, never auto-injected (§5/§11).
 */
async function writeNarrativeDocument(
  ctx: MutationCtx & { user: Doc<"users"> },
  n: Doc<"courseNarratives">,
): Promise<Id<"scholarDocuments">> {
  const period = await ctx.db.get(n.periodId);
  const body = narrativeToProse(n.subject, period?.label ?? "This period", n.sections);
  const documentId = await ctx.db.insert("scholarDocuments", {
    scholarId: n.scholarId,
    kind: "teacher_report",
    format: "text",
    title: `${n.subject} narrative — ${period?.label ?? "period"}`,
    bodyText: body,
    extractedText: body,
    uploadedBy: ctx.user._id,
    processingStatus: "pending",
    feedsTutor: false,
  });
  await ctx.db.insert("documentAccessLog", {
    documentId,
    scholarId: n.scholarId,
    userId: ctx.user._id,
    action: "upload",
  });
  await ctx.scheduler.runAfter(
    0,
    internal.scholarDocumentActions.extractAndRedact,
    { documentId },
  );
  return documentId;
}
