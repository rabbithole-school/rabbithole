import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, MutationCtx, QueryCtx, DatabaseReader } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { teacherQuery, teacherMutation } from "./lib/customFunctions";
import { filterToAccessibleScholars, requireActiveScholarAccess } from "./lib/access";
import { requirePeriodForScholar } from "./reportingPeriods";
import { gatherWorkingLevel } from "./workingLevel";
import { scholarInstitutionId } from "./lib/scholarEnrollment";
import {
  classAlwaysReported,
  classForReportSubject,
  ENRICHMENT_SUBJECT,
  foldReportClasses,
  hiddenClassRefusal,
  isEnrichmentSubject,
  isSelSubject,
  NOT_REPORTED_SUBJECT,
  mathReportClass,
  publishBlocker,
  reportBucketForUnit,
  subjectKey,
  reportBody,
  REPORT_SECTION_KEY,
  REPORT_SECTION_TITLE,
  type ReportClassEntry,
} from "./lib/parentReport";

/**
 * Course narratives — the storage behind Reports' parent reports.
 *
 * One per scholar × period × subject (SEL is a subject here). Since 2026-11 a
 * report is ONE parent-facing prose body (the `report` section), drafted by
 * Rabbithole from the record (`parentReports.ts`) and edited + published by the
 * teacher. Rows started under the earlier rubric form keep those sections;
 * they are read as teacher notes and never shown to parents once a prose body
 * exists. Ratings stay staff-only and never reach the tutor or the scholar.
 */

/** The sections a newly opened report starts with: one empty prose body. */
export function newReportSections(): { key: string; title: string; body: string }[] {
  return [{ key: REPORT_SECTION_KEY, title: REPORT_SECTION_TITLE, body: "" }];
}

/** The retired rubric form's sections (titles for legacy rows + the bot). */
const LEGACY_SECTIONS: { key: string; title: string }[] = [
  { key: "context", title: "Context — what we studied" },
  { key: "progress", title: "Progress & accomplishments" },
  { key: "dim_core", title: "Core" },
  { key: "dim_connections", title: "Connections" },
  { key: "dim_practice", title: "Practice" },
  { key: "dim_identity", title: "Identity" },
  { key: "goals", title: "Goals for Continued Growth" },
];

// ── Queries ───────────────────────────────────────────────────────────

/**
 * A period's reports for every scholar the caller can reach, whoever opened
 * them. Reports are team work (one teacher's "Draft all" opens every subject),
 * so the roster and bulk publish are scoped by scholar access, not by creator.
 */
async function periodReportsForCaller(
  ctx: QueryCtx & { user: Doc<"users"> },
  periodId: Id<"reportingPeriods">,
): Promise<Doc<"courseNarratives">[]> {
  const rows = await ctx.db
    .query("courseNarratives")
    .withIndex("by_period", (q) => q.eq("periodId", periodId))
    .collect();
  const allowed = new Set(
    await filterToAccessibleScholars(ctx, ctx.user, rows.map((r) => r.scholarId)),
  );
  return rows.filter((r) => allowed.has(r.scholarId));
}

/** A period's reports for the caller's scholars (the roster's queue). */
export const listForPeriod = teacherQuery({
  args: { periodId: v.id("reportingPeriods") },
  handler: async (ctx, args) => {
    const rows = await periodReportsForCaller(ctx, args.periodId);
    const period = await ctx.db.get(args.periodId);
    const leftovers = period ? await periodLeftovers(ctx.db, period, rows) : new Set<string>();
    return await Promise.all(
      rows.map(async (n) => {
        const scholar = await ctx.db.get(n.scholarId);
        return {
          _id: n._id,
          scholarId: n.scholarId,
          scholarName: scholar?.name ?? "Scholar",
          subject: n.subject,
          status: n.status,
          // A second report of a class: parents won't see it, "Share all" skips it.
          leftover: leftovers.has(String(n._id)),
          hasContent:
            n.sections.some((s) => s.body.trim().length > 0) || n.courseRating != null,
          // Non-null = can't be published yet (unfilled placeholders / empty).
          publishBlocker: publishBlocker(n.sections),
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

/**
 * Open (create-if-absent) the narrative for a scholar × period × subject. An
 * existing report for the same class (`classForReportSubject`) is the one
 * opened. With `body`, the report's prose is written in the same mutation, so
 * a teacher writing a report by hand never leaves an empty row behind when the
 * save fails.
 */
export const open = teacherMutation({
  args: {
    scholarId: v.id("users"),
    periodId: v.id("reportingPeriods"),
    subject: v.string(),
    body: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const period = await requirePeriodForScholar(ctx, args.periodId, args.scholarId);
    const match = await findReportRow(ctx.db, args.scholarId, period, args.subject);
    if (match) {
      if (args.body !== undefined) {
        // Writing by hand starts a report; it never overwrites one parents have.
        if (match.status === "shared") throw new ConvexError(SHARED_SLOT_REFUSAL);
        await writeReportBody(ctx, match, args.body);
      }
      return match._id;
    }
    const classes = await loadScholarClasses(ctx.db, args.scholarId, period);
    const subject = newReportSubject(args.subject, classes);
    // Units aren't chosen by hand — derive them from what the scholar actually
    // worked on in the period window (their sessions), scoped to the class.
    const unitIds = await deriveUnitIds(ctx, args.scholarId, args.periodId, subject);
    const sections = newReportSections();
    if (args.body !== undefined) sections[0] = { ...sections[0], body: args.body };
    return await ctx.db.insert("courseNarratives", {
      scholarId: args.scholarId,
      teacherId: ctx.user._id,
      periodId: args.periodId,
      subject,
      unitIds,
      sections,
      goalIds: [],
      status: "draft",
    });
  },
});

/**
 * The subject a NEW report row is stored under: the enrichment row's reserved
 * subject, else its class's name, else the name as typed. Refuses (in plain
 * words) a class with no report of its own: the enrichment block, or a class
 * not included in reports. Every create path goes through this.
 */
export function newReportSubject(subject: string, classes: ScholarClasses): string {
  if (isEnrichmentSubject(subject)) return ENRICHMENT_SUBJECT;
  const refusal = hiddenClassRefusal(subject, classes.own);
  if (refusal) throw new ConvexError(refusal);
  return classForReportSubject(subject, classes.own) ?? subject;
}

/** Write a report's prose body, under the same rule `saveSection` applies. */
async function writeReportBody(ctx: MutationCtx, n: Doc<"courseNarratives">, body: string) {
  const sections = n.sections.some((s) => s.key === REPORT_SECTION_KEY)
    ? n.sections.map((s) => (s.key === REPORT_SECTION_KEY ? { ...s, body } : s))
    : [...n.sections, { key: REPORT_SECTION_KEY, title: REPORT_SECTION_TITLE, body }];
  const blocked = publishedEditBlocker(n, sections);
  if (blocked) throw new Error(blocked);
  const rename = await classNameForRow(ctx.db, n);
  await ctx.db.patch(n._id, rename ? { sections, subject: rename } : { sections });
}

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
    // Parents read a published report live, so a correction may land only if
    // it would itself pass the publish check (no placeholders, not empty).
    const blocked = publishedEditBlocker(n, sections);
    if (blocked) throw new Error(blocked);
    // A report from before classes takes its class's name once it is edited.
    const rename = await classNameForRow(ctx.db, n);
    await ctx.db.patch(args.narrativeId, rename ? { sections, subject: rename } : { sections });
    return await ctx.db.get(args.narrativeId);
  },
});

/**
 * Report-level "Mark as done" toggle — the completion axis (distinct from the
 * separate sharing axis). done ⇒ status "final" (+ snapshot the Working Level,
 * same as the old Finalize); not-done ⇒ back to "draft". A shared report is
 * definitionally done, so this is a no-op once shared.
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
    const blocker = publishBlocker(n.sections);
    if (blocker) throw new Error(blocker);
    // One published report per class: a second report of the class is never shared.
    const period = await ctx.db.get(n.periodId);
    if (period && slotRefusal(n, await loadReportSlots(ctx.db, n.scholarId, period)))
      throw new ConvexError(SHARE_LEFTOVER_REFUSAL);
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
    const rows = await periodReportsForCaller(ctx, args.periodId);
    const period = await ctx.db.get(args.periodId);
    // A second report of a class is never shared; the roster's count skips it too.
    const leftovers = period ? await periodLeftovers(ctx.db, period, rows) : new Set<string>();
    let shared = 0;
    let held = 0;
    for (const n of rows) {
      if (n.status !== "final" || leftovers.has(String(n._id))) continue;
      if (publishBlocker(n.sections)) {
        held++;
        continue;
      }
      const documentId = await writeNarrativeDocument(ctx, n);
      await ctx.db.patch(n._id, {
        status: "shared",
        sharedAt: Date.now(),
        documentId,
      });
      shared++;
    }
    return { shared, held };
  },
});

// ── Internal (the curriculum-bot read/write-report tools) ─────────────

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
    // A subject is matched the way every report is paired with a class, so
    // "Social Studies" finds the report renamed "Humanities".
    const subject = args.subject;
    let filtered = rows;
    if (subject) {
      const period = await ctx.db.get(args.periodId);
      const classes = period ? await loadScholarClasses(ctx.db, args.scholarId, period) : null;
      const plan = classes ? { ...classes, byClass: classes.own.length > 0 } : null;
      const keyOf = (s: string) => (plan ? reportKeyFor(s, plan) : subjectKey(s));
      filtered = rows.filter((n) => keyOf(n.subject) === keyOf(subject));
    }
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
    const period = await requirePeriodForScholar(ctx, args.periodId, args.scholarId);
    const match = await findReportRow(ctx.db, args.scholarId, period, args.subject);
    if (match) return match._id;
    const classes = await loadScholarClasses(ctx.db, args.scholarId, period);
    const subject = newReportSubject(args.subject, classes);
    const unitIds = await deriveUnitIds(ctx, args.scholarId, args.periodId, subject);
    return await ctx.db.insert("courseNarratives", {
      scholarId: args.scholarId,
      teacherId: args.teacherId,
      periodId: args.periodId,
      subject,
      unitIds,
      sections: newReportSections(),
      goalIds: [],
      status: "draft",
    });
  },
});

/** Write one section body (the bot's write_report tool writes the `report` section). */
export const setSectionInternal = internalMutation({
  args: { narrativeId: v.id("courseNarratives"), key: v.string(), body: v.string() },
  handler: async (ctx, args) => {
    const n = await ctx.db.get(args.narrativeId);
    if (!n) throw new Error("Narrative not found");
    const sections = [...n.sections];
    const idx = sections.findIndex((s) => s.key === args.key);
    const title =
      args.key === REPORT_SECTION_KEY
        ? REPORT_SECTION_TITLE
        : (LEGACY_SECTIONS.find((s) => s.key === args.key)?.title ?? args.key);
    if (idx >= 0) sections[idx] = { ...sections[idx], body: args.body };
    else sections.push({ key: args.key, title, body: args.body });
    const blocked = publishedEditBlocker(n, sections);
    if (blocked) return { written: false as const, reason: blocked };
    const period = await ctx.db.get(n.periodId);
    const refused = period ? slotRefusal(n, await loadReportSlots(ctx.db, n.scholarId, period)) : null;
    if (refused) return { written: false as const, reason: refused };
    const rename = await classNameForRow(ctx.db, n);
    await ctx.db.patch(args.narrativeId, rename ? { sections, subject: rename } : { sections });
    return { written: true as const };
  },
});

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Why an edit to a published report can't be saved, or null. Parents read a
 * published report's sections live, so a correction must itself be
 * publishable; an unpublished report takes any edit.
 */
function publishedEditBlocker(
  n: Doc<"courseNarratives">,
  sections: { key: string; title: string; body: string }[],
): string | null {
  if (n.status !== "shared") return null;
  const blocker = publishBlocker(sections);
  return blocker ? `Parents can already see this report. ${blocker}.` : null;
}

async function requireNarrative(
  ctx: MutationCtx & { user: Doc<"users"> },
  narrativeId: Id<"courseNarratives">,
): Promise<Doc<"courseNarratives">> {
  const n = await ctx.db.get(narrativeId);
  if (!n) throw new Error("Narrative not found");
  await requireActiveScholarAccess(ctx, ctx.user, n.scholarId);
  return n;
}

// ── Reports by class (TRA-723) ────────────────────────────────────────

/** A term's live classes for one school, plus the groups they belong to. */
export type TermClasses = {
  classes: (ReportClassEntry & { groupId: Id<"scholarGroups"> })[];
  groups: Map<string, { type?: string; scholarIds: Id<"users">[] }>;
};

// A school runs a few dozen classes a term (groups x subjects); the bound only
// stops a runaway read.
const MAX_TERM_CLASSES = 200;
// Sessions are read newest first, so if a scholar ever passes this the oldest
// drop and the page says it is showing the most recent work.
export const MAX_TERM_SESSIONS = 600;

/**
 * The term's non-archived classes at one school, with each class's group (its
 * `type` and scholars). Read through the term's index and kept only when the
 * class AND its group belong to `institutionId`, so another school's classes
 * never reach a report. No school, no classes.
 */
export async function loadTermClasses(
  db: DatabaseReader,
  institutionId: Id<"institutions"> | undefined,
  periodId: Id<"reportingPeriods">,
): Promise<TermClasses> {
  const out: TermClasses = { classes: [], groups: new Map() };
  if (!institutionId) return out;
  const rows = await db
    .query("classes")
    .withIndex("by_period_group", (q) => q.eq("periodId", periodId))
    .take(MAX_TERM_CLASSES);
  for (const c of rows) {
    if (c.institutionId !== institutionId || c.archivedAt !== undefined) continue;
    const gid = String(c.groupId);
    if (!out.groups.has(gid)) {
      const group = await db.get(c.groupId);
      if (!group || (group.institutionId !== undefined && group.institutionId !== institutionId)) continue;
      out.groups.set(gid, { type: group.type, scholarIds: group.scholarIds });
    }
    out.classes.push({
      subject: c.subject,
      subjectKey: subjectKey(c.subject),
      kind: c.kind,
      includedInReports: c.includedInReports,
      groupId: c.groupId,
    });
  }
  return out;
}

/** A scholar's own classes this term: the classes of every group they are in. */
export type ScholarClasses = {
  institutionId: Id<"institutions"> | undefined;
  /** The bucketing index: homeroom and elective groups alike. */
  own: ReportClassEntry[];
  /** Ordinary homeroom classes: a report row even with no work. */
  timetable: string[];
};

export async function loadScholarClasses(
  db: DatabaseReader,
  scholarId: Id<"users">,
  period: Doc<"reportingPeriods">,
): Promise<ScholarClasses> {
  const institutionId = (await scholarInstitutionId({ db }, scholarId)) ?? period.institutionId;
  return scholarClassesFromTerm(await loadTermClasses(db, institutionId, period._id), institutionId, scholarId);
}

/** A scholar's own classes, from a term's classes already read (so a whole
 *  period's reports can share one read of the term). */
function scholarClassesFromTerm(
  term: TermClasses,
  institutionId: Id<"institutions"> | undefined,
  scholarId: Id<"users">,
): ScholarClasses {
  const own: ReportClassEntry[] = [];
  const homeroomKeys = new Set<string>();
  for (const c of term.classes) {
    const group = term.groups.get(String(c.groupId));
    if (!group || !group.scholarIds.some((id) => id === scholarId)) continue;
    own.push({ subject: c.subject, subjectKey: c.subjectKey, kind: c.kind, includedInReports: c.includedInReports });
    if (classAlwaysReported(group, scholarId)) homeroomKeys.add(c.subjectKey);
  }
  const timetable: string[] = [];
  for (const [key, c] of foldReportClasses(own))
    if (c.kind === "ordinary" && homeroomKeys.has(key)) timetable.push(c.display);
  return { institutionId, own, timetable };
}

/**
 * A unit a teacher made but gave no subject. Its work is in no class's unit
 * list, but evidence from it still belongs to whichever class its own
 * subject names (TRA-728: a multiplication app in a subject-less unit had
 * emptied a scholar's Math report). A scholar's own unit is enrichment by
 * ruling, whatever its sessions touch.
 */
export function isBlankStaffUnit(unit: { subject?: string | null; authorScholarId?: unknown }): boolean {
  return !unit.authorScholarId && !(unit.subject ?? "").trim();
}

/** A scholar's term work, partitioned into report sections. */
export type ScholarTermReports = ScholarClasses & {
  /** False when the scholar has no classes on record for the term: reports
   *  then group by unit subject, as they did before classes existed. */
  byClass: boolean;
  /** Report key (`subjectKey` of its name) → its name and the units in it. */
  sections: Map<string, { subject: string; unitIds: Id<"units">[] }>;
  /** The class math practice evidence goes to; null keeps the old "Math". */
  mathClass: string | null;
  /** The report key a unit's work belongs to; `ENRICHMENT_KEY` when it is in
   *  no class report, null only for a pre-class unit with no subject. */
  keyOfUnit: (unit: Doc<"units">) => string | null;
  /** The term's sessions already read: id → unit, so evidence can place them
   *  without reading each session again. */
  sessionUnits: Map<string, Id<"units"> | undefined>;
  /** Units already read: id → report key, and id → "title — description". */
  unitKeys: Map<string, string | null>;
  /**
   * Staff-made units with no subject. Their titles list under enrichment, but
   * the subject is unknown rather than "not a class", so evidence from their
   * sessions is placed by its own subject (parentReports `keyOfSession`).
   */
  blankStaffUnits: Set<string>;
  unitText: Map<string, string>;
  /** True when the session cap was hit: only the most recent work is shown. */
  recentOnly: boolean;
  /** What the "Enrichment and projects" row may list: units in the
   *  enrichment bucket, with their term sessions oldest first. Read with
   *  `enrichmentListItems`, which applies the worked-more-than-once rule. */
  enrichmentCandidates: Map<string, { title: string; description?: string; scholarMade: boolean; sessions: Doc<"sessions">[] }>;
};

/** The key work in the enrichment bucket carries: it matches no report. */
export const ENRICHMENT_KEY = subjectKey(ENRICHMENT_SUBJECT);
/** The key work in a not-reported class (or another school's unit) carries:
 *  it matches no report and stays out of the enrichment list. */
export const NOT_REPORTED_KEY = subjectKey(NOT_REPORTED_SUBJECT);

/** A unit worked on only once is a glance, not work worth listing. */
const MIN_ENRICHMENT_WORK = 2;
/** Units read only because offline work points at them (no in-term session). */
const MAX_ENRICHMENT_EXTRA_UNITS = 100;

/** Whether a unit may appear in the "Enrichment and projects" list: work in
 *  the enrichment bucket (or, for a scholar with no classes, a unit with no
 *  subject), never another scholar's own project or SEL work. A unit that is
 *  only turned off (`isActive: false`) still counts. */
function listableUnit(unit: Doc<"units">, key: string | null, byClass: boolean, scholarId: Id<"users">): boolean {
  return (
    (key === ENRICHMENT_KEY || (key === null && !byClass)) &&
    (!unit.authorScholarId || unit.authorScholarId === scholarId) &&
    !isSelSubject(unit.subject ?? "")
  );
}

/** Lesson or session titles shown to the list writer per unit. */
const MAX_ENRICHMENT_INSIDE_TITLES = 8;

function distinctTitles(titles: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of titles) {
    const k = t.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(t.trim());
    if (out.length >= MAX_ENRICHMENT_INSIDE_TITLES) break;
  }
  return out;
}

/** One unit on the "Enrichment and projects" list, with what is inside it. */
export type EnrichmentListItem = {
  title: string;
  description?: string;
  /** The scholar built this unit themselves (an app or project of their own). */
  scholarMade: boolean;
  lessonTitles: string[];
  /** The scholar's own session titles in the unit, oldest first. */
  sessionTitles: string[];
  firstSessionAt: number;
};

/** A piece of work the record already holds for a unit, outside a chat: a
 *  completion, a deliverable, or filed paper work. */
export type EnrichmentWork = { unitId: Id<"units"> | null; at: number; sessionId?: Id<"sessions"> };

/**
 * The "Enrichment and projects" list for a term (TRA-723): each listable unit
 * the scholar worked on more than once, dated by its first piece of work.
 *
 * A piece of work is a session that is not archived (a session whose app a
 * teacher put away is archived) in which the scholar wrote a message or
 * played the app, or a completion, deliverable or paper scan from `work`
 * (the record the gatherer already read). Work tied to a session counts once
 * with it; work with no session counts once per day. Reads are indexed: one
 * message (then app play) lookup per session checked, stopping at the second
 * piece, and at most `MAX_ENRICHMENT_EXTRA_UNITS` units with no session.
 * Feed to `enrichmentListBody`.
 */
export async function enrichmentListItems(
  db: DatabaseReader,
  plan: Pick<ScholarTermReports, "enrichmentCandidates" | "keyOfUnit" | "unitKeys" | "byClass">,
  scholarId: Id<"users">,
  work: EnrichmentWork[] = [],
): Promise<EnrichmentListItem[]> {
  // A copy: units found through offline work are added for this call only.
  const candidates = new Map<string, { title: string; description?: string; scholarMade: boolean; sessions: Doc<"sessions">[] }>(plan.enrichmentCandidates);
  // Units with offline work but no in-term session: read once each per call,
  // bounded. (Units seen in a session are already in `unitKeys`.)
  let extraReads = MAX_ENRICHMENT_EXTRA_UNITS;
  const read = new Set<string>();
  for (const w of work) {
    if (!w.unitId) continue;
    const uid = String(w.unitId);
    if (candidates.has(uid) || plan.unitKeys.has(uid) || read.has(uid) || extraReads <= 0) continue;
    read.add(uid);
    extraReads -= 1;
    const unit = await db.get(w.unitId);
    const key = unit ? plan.keyOfUnit(unit) : null;
    if (unit && listableUnit(unit, key, plan.byClass, scholarId))
      candidates.set(uid, { title: unit.title, description: unit.description, scholarMade: unit.authorScholarId === scholarId, sessions: [] });
  }

  const items: EnrichmentListItem[] = [];
  for (const [uid, { title, description, scholarMade, sessions }] of candidates) {
    const archived = new Set(sessions.filter((s) => s.isArchived).map((s) => String(s._id)));
    const pieces = new Map<string, number>();
    const add = (key: string, at: number) => pieces.set(key, Math.min(pieces.get(key) ?? at, at));
    for (const w of work) {
      if (String(w.unitId) !== uid) continue;
      if (w.sessionId) {
        if (!archived.has(String(w.sessionId))) add(`s:${String(w.sessionId)}`, w.at);
      } else add(`d:${new Date(w.at).toISOString().slice(0, 10)}`, w.at);
    }
    for (const s of sessions) {
      if (pieces.size >= MIN_ENRICHMENT_WORK) break;
      if (s.isArchived || pieces.has(`s:${String(s._id)}`)) continue;
      const said = await db
        .query("messages")
        .withIndex("by_session_role", (q) => q.eq("sessionId", s._id).eq("role", "user"))
        .first();
      const played =
        said ??
        (await db
          .query("appPlaySessions")
          .withIndex("by_session_startedAt", (q) => q.eq("sessionId", s._id))
          .first());
      if (played) add(`s:${String(s._id)}`, s._creationTime);
    }
    if (pieces.size < MIN_ENRICHMENT_WORK) continue;
    // What is inside the unit, for the list writer: a title or a one-line
    // description often says nothing ("This is a app").
    const lessons = await db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", uid as Id<"units">))
      .take(MAX_ENRICHMENT_INSIDE_TITLES);
    items.push({
      title,
      description,
      scholarMade,
      lessonTitles: distinctTitles(lessons.map((l) => l.title)),
      sessionTitles: distinctTitles(sessions.filter((s) => !s.isArchived).map((s) => s.title)),
      firstSessionAt: Math.min(...pieces.values()),
    });
  }
  return items;
}

/**
 * The report key of a row or report name: the key of the scholar's class it
 * belongs to (`classForReportSubject`), else its own folded name, which no
 * class work carries.
 */
export function reportKeyFor(subject: string, plan: ScholarClasses & { byClass: boolean }): string {
  if (isEnrichmentSubject(subject)) return ENRICHMENT_KEY;
  if (!plan.byClass) return subjectKey(subject);
  const cls = classForReportSubject(subject, plan.own);
  return subjectKey(cls ?? subject);
}

/**
 * Partition a scholar's term work by THEIR classes. Every unit lands in one
 * bucket (`reportBucketForUnit` over the scholar's own classes): one of their
 * class names, enrichment (the "Enrichment and projects" list), or not
 * reported (a "notReported" class's work). Units another school owns are left
 * out of everything. Sessions are read for the term window, newest
 * first, through the `by_user` index's creation time.
 */
export async function loadScholarTermReports(
  db: DatabaseReader,
  scholarId: Id<"users">,
  period: Doc<"reportingPeriods">,
): Promise<ScholarTermReports> {
  const classes = await loadScholarClasses(db, scholarId, period);
  const { institutionId, own } = classes;
  const byClass = own.length > 0;
  const keyOfUnit = (unit: Doc<"units">): string | null => {
    if (unit.institutionId !== undefined && institutionId !== undefined && unit.institutionId !== institutionId)
      return NOT_REPORTED_KEY;
    if (!byClass) {
      const s = unit.subject?.trim();
      return s ? subjectKey(s) : null;
    }
    return subjectKey(reportBucketForUnit(unit, own));
  };

  const sections = new Map<string, { subject: string; unitIds: Id<"units">[] }>();
  const sessions = await db
    .query("sessions")
    .withIndex("by_user", (q) =>
      q.eq("userId", scholarId).gte("_creationTime", period.startsAt).lte("_creationTime", period.endsAt),
    )
    .order("desc")
    .take(MAX_TERM_SESSIONS);
  const sessionUnits = new Map<string, Id<"units"> | undefined>();
  const unitKeys = new Map<string, string | null>();
  const blankStaffUnits = new Set<string>();
  const unitText = new Map<string, string>();
  // Enrichment-row candidates: unit id → title and its sessions.
  const enrichmentCandidates = new Map<string, { title: string; description?: string; scholarMade: boolean; sessions: Doc<"sessions">[] }>();
  // Oldest first, so a section lists its units in the order they were begun.
  for (const s of [...sessions].reverse()) {
    sessionUnits.set(String(s._id), s.unitId);
    if (!s.unitId) continue;
    enrichmentCandidates.get(String(s.unitId))?.sessions.push(s);
    if (unitKeys.has(String(s.unitId))) continue;
    const unit = await db.get(s.unitId);
    const key = unit ? keyOfUnit(unit) : null;
    unitKeys.set(String(s.unitId), key);
    if (unit && isBlankStaffUnit(unit)) blankStaffUnits.add(String(unit._id));
    // Enrichment work, and (for a scholar with no classes) a unit with no
    // subject, which no report takes either (`listableUnit`).
    if (unit && listableUnit(unit, key, byClass, scholarId))
      enrichmentCandidates.set(String(unit._id), {
        title: unit.title,
        description: unit.description,
        scholarMade: unit.authorScholarId === scholarId,
        sessions: [s],
      });
    if (!unit || key === null || key === ENRICHMENT_KEY || key === NOT_REPORTED_KEY) continue;
    unitText.set(String(unit._id), unit.description ? `${unit.title} — ${unit.description}` : unit.title);
    const name = byClass ? reportBucketForUnit(unit, own) : unit.subject!.trim();
    const section = sections.get(key) ?? { subject: name, unitIds: [] };
    section.unitIds.push(unit._id);
    sections.set(key, section);
  }
  return {
    ...classes,
    byClass,
    sections,
    mathClass: mathReportClass(own),
    keyOfUnit,
    sessionUnits,
    unitKeys,
    blankStaffUnits,
    unitText,
    recentOnly: sessions.length >= MAX_TERM_SESSIONS,
    enrichmentCandidates,
  };
}

/**
 * The units a scholar engaged in-window for one report — from their sessions
 * (the ground truth of what the child actually worked on), never hand-picked:
 * the units the class partition files under the class that report belongs to.
 */
export async function deriveUnitIds(
  ctx: { db: DatabaseReader },
  scholarId: Id<"users">,
  periodId: Id<"reportingPeriods">,
  subject: string,
  plan?: ScholarTermReports,
): Promise<Id<"units">[]> {
  const period = await ctx.db.get(periodId);
  if (!period) return [];
  const reports = plan ?? (await loadScholarTermReports(ctx.db, scholarId, period));
  return reports.sections.get(reportKeyFor(subject, reports))?.unitIds ?? [];
}

// ── One report per slot ───────────────────────────────────────────────

/** Refusals a teacher reads, for a second report in a class's slot. */
export const SHARED_SLOT_REFUSAL = "This class already has a shared report.";
export const LEFTOVER_REFUSAL = "This class already has another report. Draft or edit that one instead.";

/** A slot's report, and any other rows paired with the same class or name. */
export type ReportSlot = { report: Doc<"courseNarratives">; leftovers: Doc<"courseNarratives">[] };

/**
 * THE rule for a slot with several rows (TRA-723): a slot has one report, and
 * the pick is STABLE. The shared row if any (the oldest shared one); else the
 * OLDEST row with text; else the oldest row. An empty row can never displace
 * one with text, and editing a newer row never changes the pick. Every other
 * row is a leftover: listed with a note that parents won't see it, and never
 * drafted, renamed, written by the aide, reused or shared.
 */
export function pickSlotReport(rows: Doc<"courseNarratives">[]): ReportSlot | null {
  if (rows.length === 0) return null;
  const shared = rows.filter((r) => r.status === "shared");
  const written = rows.filter((r) => r.sections.some((s) => s.body.trim()));
  const pool = shared.length > 0 ? shared : written.length > 0 ? written : rows;
  const report = [...pool].sort((a, b) => a._creationTime - b._creationTime || a._id.localeCompare(b._id))[0];
  return { report, leftovers: rows.filter((r) => r._id !== report._id) };
}

/** Refusal for sharing a second report of a class. */
export const SHARE_LEFTOVER_REFUSAL = "This class already has a report. Share that one, or delete it first.";

/**
 * The leftover rows among a period's reports (any scholars): the ids of rows
 * that are not their slot's report. The term's classes are read once per
 * school, so a whole period costs one class read plus a lookup per scholar.
 */
export async function periodLeftovers(
  db: DatabaseReader,
  period: Doc<"reportingPeriods">,
  rows: Doc<"courseNarratives">[],
): Promise<Set<string>> {
  const byScholar = new Map<string, Doc<"courseNarratives">[]>();
  for (const n of rows) byScholar.set(String(n.scholarId), [...(byScholar.get(String(n.scholarId)) ?? []), n]);
  const terms = new Map<string, TermClasses>();
  const out = new Set<string>();
  for (const list of byScholar.values()) {
    const scholarId = list[0].scholarId;
    const institutionId = (await scholarInstitutionId({ db }, scholarId)) ?? period.institutionId;
    const tk = String(institutionId);
    if (!terms.has(tk)) terms.set(tk, await loadTermClasses(db, institutionId, period._id));
    const classes = scholarClassesFromTerm(terms.get(tk)!, institutionId, scholarId);
    const { slots } = groupReportSlots(list, { ...classes, byClass: classes.own.length > 0 });
    for (const slot of slots.values()) for (const l of slot.leftovers) out.add(String(l._id));
  }
  return out;
}

/** The term's reports for a scholar grouped into slots by `reportKeyFor`. */
export type ReportSlots = {
  keyOf: (subject: string) => string;
  slots: Map<string, ReportSlot>;
};

export function groupReportSlots(
  rows: Doc<"courseNarratives">[],
  plan: ScholarClasses & { byClass: boolean },
): ReportSlots {
  const keyOf = (subject: string) => reportKeyFor(subject, plan);
  const byKey = new Map<string, Doc<"courseNarratives">[]>();
  for (const n of rows) {
    const k = keyOf(n.subject);
    byKey.set(k, [...(byKey.get(k) ?? []), n]);
  }
  const slots = new Map<string, ReportSlot>();
  for (const [k, list] of byKey) slots.set(k, pickSlotReport(list)!);
  return { keyOf, slots };
}

export async function loadReportSlots(
  db: DatabaseReader,
  scholarId: Id<"users">,
  period: Doc<"reportingPeriods">,
  classes?: ScholarClasses,
): Promise<ReportSlots & { classes: ScholarClasses; byClass: boolean }> {
  const rows = await db
    .query("courseNarratives")
    .withIndex("by_scholar_period", (q) => q.eq("scholarId", scholarId).eq("periodId", period._id))
    .collect();
  const own = classes ?? (await loadScholarClasses(db, scholarId, period));
  const byClass = own.own.length > 0;
  return { ...groupReportSlots(rows, { ...own, byClass }), classes: own, byClass };
}

/**
 * Why a row may not be drafted, renamed or written as its class's report, or
 * null when it is its slot's report. A row is refused when its slot's report
 * is another row: shared ("already has a shared report") or not.
 */
export function slotRefusal(n: Doc<"courseNarratives">, slots: ReportSlots): string | null {
  const slot = slots.slots.get(slots.keyOf(n.subject));
  if (!slot || slot.report._id === n._id) return null;
  return slot.report.status === "shared" ? SHARED_SLOT_REFUSAL : LEFTOVER_REFUSAL;
}

/** The scholar's report for the same slot as `subject`: its slot's report. */
async function findReportRow(
  db: DatabaseReader,
  scholarId: Id<"users">,
  period: Doc<"reportingPeriods">,
  subject: string,
): Promise<Doc<"courseNarratives"> | null> {
  const s = await loadReportSlots(db, scholarId, period);
  return s.slots.get(s.keyOf(subject))?.report ?? null;
}

/** The display name a row takes once it is drafted or saved: its class's
 *  name, only when it is its slot's (unshared) report. */
export async function classNameForRow(
  db: DatabaseReader,
  n: Doc<"courseNarratives">,
): Promise<string | null> {
  if (n.status === "shared") return null;
  const period = await db.get(n.periodId);
  if (!period) return null;
  const s = await loadReportSlots(db, n.scholarId, period);
  if (!s.byClass || slotRefusal(n, s)) return null;
  const cls = classForReportSubject(n.subject, s.classes.own);
  return cls && cls !== n.subject ? cls : null;
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
  // A prose report is the whole parent-facing text; any retired rubric
  // sections on the same row are teacher notes and stay staff-side.
  const body = reportBody(sections).trim();
  if (body) return `${parts[0]}\n\n${body}`;
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
    title: `${n.subject} report — ${period?.label ?? "period"}`,
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
