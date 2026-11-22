import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, type DatabaseReader, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { teacherMutation, teacherQuery } from "./lib/customFunctions";
import { requireActiveScholarAccess } from "./lib/access";
import { requirePeriodForScholar } from "./reportingPeriods";
import {
  deriveUnitIds,
  ENRICHMENT_KEY,
  enrichmentListItems,
  groupReportSlots,
  loadReportSlots,
  loadScholarClasses,
  loadScholarTermReports,
  newReportSections,
  newReportSubject,
  NOT_REPORTED_KEY,
  reportKeyFor,
  SHARED_SLOT_REFUSAL,
  slotRefusal,
  type EnrichmentWork,
  type ScholarTermReports,
  isBlankStaffUnit,
} from "./courseNarratives";
import { unitSubjectFitsClass } from "./lib/classResolver";
import { PRACTICE_DOMAIN_LABELS } from "../shared/practiceDomainLabels";
import { learnedSkillKeys, loadMathCatalog } from "./mathPortrait";
import {
  fluentCount,
  frontierGradeValue,
  learnedPace,
  mathLevel,
  paceWindowStart,
  skillsFluentInWindow,
} from "./lib/practice/frontierGrade";
import { gradeRank } from "../shared/gradeRange";
import { dayKeyForTimezone } from "../shared/institutionDay";
import { timeZoneForInstitution } from "./lib/institutionTime";
import { familyPortfolioItems } from "./portfolio";
import { withoutWonders } from "./lib/seeds";
import { INTERIM_RATINGS, INTERIM_SECTIONS } from "./lib/interimCheckinTemplate";
import { capUnitAsked, type ReadingSession, type ReadingTurn, type UnitReadingInput } from "./lib/parentReportReading";
import {
  classForReportSubject,
  ENRICHMENT_SUBJECT,
  enrichmentListBody,
  orderedEnrichmentItems,
  foldReportClasses,
  isDrafting,
  isEnrichmentSubject,
  NO_ENRICHMENT_REFUSAL,
  reportTitle,
  isSelSubject,
  NO_CLASS_WORK_REFUSAL,
  NOT_REPORTED_SUBJECT,
  legacySectionNotes,
  datedEvidenceLine,
  areaLevelEvidence,
  fluentSkillItem,
  overallMathEvidence,
  termFluencyLine,
  pickEvidence,
  pickEvidenceCandidates,
  reportBody,
  reportBucketForUnit,
  REPORT_SECTION_KEY,
  REPORT_SECTION_TITLE,
  SEL_SUBJECT,
  subjectKey,
  type AreaLevelInput,
  type EvidenceCandidate,
  type EvidenceGroup,
  type ParentReportEvidence,
} from "./lib/parentReport";

/**
 * Parent reports — the gatherer + the teacher-facing drafting entry points.
 *
 * ONE gatherer (`gatherParentReportEvidence`), two readers: the drafting action
 * reads it to write the draft, and the composer's evidence pane reads it so the
 * teacher sees exactly what the draft was allowed to say. Pure + lib half:
 * `lib/parentReport.ts`. Model call: `parentReportActions.ts`.
 *
 * Reports are derived, not hand-picked: one per class (every class on the
 * scholar's own timetable, and any other class they have work in this
 * period), plus SEL for everyone. See `deriveReportSubjects`.
 */

const MAX_ITEMS_PER_GROUP = 25;
const MAX_ITEM_CHARS = 320;
// A math area's level line carries the level, the reach, both sources and the
// term's split in one sentence group; at most eight areas, so the room is small.
const MAX_AREA_LINE_CHARS = 480;

function clip(text: string, max = MAX_ITEM_CHARS): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function short(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// ── Subject derivation ──────────────────────────────────────────────────

/**
 * The reports a scholar has this period, in display order: one per class
 * (A to Z), then SEL. A class gets one when it is on the scholar's own
 * timetable (`classAlwaysReported`), even with no work in it yet, or when the
 * scholar has work filed under it (`reportBucketForUnit` over their own
 * classes). New practice fluency counts as work in their math class
 * (`mathReportClass`, else the old "Math" report). Work in the enrichment
 * bucket makes no report here.
 *
 * A scholar with no classes on record for the term keeps the older grouping by
 * unit subject, so their reports don't vanish.
 */
export async function deriveReportSubjects(
  db: DatabaseReader,
  scholarId: Id<"users">,
  period: Doc<"reportingPeriods">,
  plan?: ScholarTermReports,
  fluent?: Doc<"practiceMastery">[],
  paperKeys: string[] = [],
): Promise<string[]> {
  const reports = plan ?? (await loadScholarTermReports(db, scholarId, period));
  const byKey = new Map<string, string>();
  for (const name of reports.timetable) byKey.set(subjectKey(name), name);
  // A class whose only work this term is on paper still gets its row.
  if (reports.byClass) {
    const classes = foldReportClasses(reports.own);
    for (const key of paperKeys) {
      const c = classes.get(key);
      if (c?.kind === "ordinary" && !byKey.has(key)) byKey.set(key, c.display);
    }
  }
  for (const [key, section] of reports.sections)
    if (!byKey.has(key) && !isSelSubject(section.subject)) byKey.set(key, section.subject);
  const math = reports.mathClass ?? "Math";
  if (!byKey.has(subjectKey(math)) && (fluent ?? (await newlyFluent(db, scholarId, period))).length > 0) {
    byKey.set(subjectKey(math), math);
  }
  const academic = [...byKey.values()].sort((a, b) => a.localeCompare(b));
  return [...academic, SEL_SUBJECT];
}

/** Whether a report key is the one math practice evidence goes to. */
function isMathReport(reportKey: string, plan: ScholarTermReports): boolean {
  return reportKey === subjectKey(plan.mathClass ?? "Math");
}

// The read budget (TRA-723). Convex allows 32,000 documents scanned and 16 MiB
// read per transaction.
// The term record below reads at most about 8,600 documents (the
// arithmetic is in the PR body), so the page, "Draft all" and one draft keep
// wide headroom. Each scholar-wide read is limited to the term and capped,
// newest first; reaching a cap sets `limited`, and the page says it shows the
// most recent work.
const MAX_RECORD_ROWS = 400; // mastery, connections, signals: 400 each
const MAX_DELIVERABLES = 250; // + an activity and a lesson read each = 750
// Read ONCE per record and shared with the math portrait; the skill graph has
// about 3,050 skills, so a scholar's rows fit.
const MAX_PRACTICE_ROWS = 3200;
const MAX_PAPER_ITEMS = 80; // each page: 3 lookups + 2 attributions + 10 observations
// Sessions outside the term's read that in-term evidence points at (begun
// before the term): each costs a session and a unit read.
const MAX_EXTRA_SESSIONS = 200;
// Granule rows across every class of one record, and per unit.
const MAX_GRANULE_READS = 400;
const MAX_GRANULES_PER_UNIT = 50;

/** The scholar's practice rows (one per skill), read once. */
async function practiceRows(db: DatabaseReader, scholarId: Id<"users">): Promise<Doc<"practiceMastery">[]> {
  return await db
    .query("practiceMastery")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .take(MAX_PRACTICE_ROWS);
}

/** Practice skills that newly reached fluency in the term. */
function fluentInTerm(rows: Doc<"practiceMastery">[], period: Doc<"reportingPeriods">): Doc<"practiceMastery">[] {
  return rows.filter((r) => r.becameFluentAt !== undefined && r.becameFluentAt >= period.startsAt && r.becameFluentAt <= period.endsAt);
}

async function newlyFluent(
  db: DatabaseReader,
  scholarId: Id<"users">,
  period: Doc<"reportingPeriods">,
): Promise<Doc<"practiceMastery">[]> {
  return fluentInTerm(await practiceRows(db, scholarId), period);
}

/** A page of paper work this scholar alone owns, placed in a unit. */
/** A page of work on paper; `ref` is the number the drafter cites it by ("piece 3"). */
/** One scanned or uploaded page, placed in a report section: `key` is the
 *  report key it counts for (its unit's bucket, else its observed domains),
 *  null when nothing places it. */
type PaperItem = {
  at: number;
  unitId: Id<"units"> | null;
  key: string | null;
  text: string;
  id: Id<"portfolioItems">;
  title: string;
  ref: number;
};

/**
 * The report key for evidence with no unit, from its free-text domains: the
 * one class of the scholar's own that the domains fit (`classForReportSubject`),
 * else enrichment. Every domain falling in a class not included in reports
 * keeps it out of every report. For a scholar with no classes: the one folded
 * domain name, else nothing.
 */
/**
 * The practice engine tags its own work by math area ("fraction-arithmetic");
 * all of it is math, so it names the scholar's math class.
 */
function practiceDomainsAsMath(domains: string[], plan: ScholarTermReports): string[] {
  return domains
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => (d in PRACTICE_DOMAIN_LABELS ? (plan.byClass ? (plan.mathClass ?? d) : "Math") : d));
}

function domainReportKey(domains: string[], plan: ScholarTermReports): string | null {
  const named = practiceDomainsAsMath(domains, plan);
  if (!plan.byClass) {
    const keys = new Set(named.map(subjectKey));
    return keys.size === 1 ? [...keys][0] : null;
  }
  if (named.length === 0) return ENRICHMENT_KEY;
  const keys = new Set<string>();
  for (const d of named) {
    const cls = classForReportSubject(d, plan.own);
    if (cls) keys.add(subjectKey(cls));
  }
  if (keys.size === 1) return [...keys][0];
  if (keys.size === 0 && named.every((d) => reportBucketForUnit({ subject: d }, plan.own) === NOT_REPORTED_SUBJECT))
    return NOT_REPORTED_KEY;
  return ENRICHMENT_KEY;
}

/**
 * The report key of a scanned page with no unit, from the subjects of the
 * skills observed on it. It counts for a class only when EVERY observed
 * subject lands in that one ordinary class of the scholar's. If any lands in a
 * class not included in reports, the page counts nowhere. Otherwise (two
 * classes, or a class and something else) it counts for no class: enrichment.
 */
function pageReportKey(domains: string[], plan: ScholarTermReports): string | null {
  const named = domains.map((d) => d.trim()).filter(Boolean);
  if (!plan.byClass || named.length === 0) return domainReportKey(named, plan);
  const buckets = new Set(named.map((d) => reportBucketForUnit({ subject: d }, plan.own)));
  if (buckets.has(NOT_REPORTED_SUBJECT)) return NOT_REPORTED_KEY;
  if (buckets.size === 1 && !buckets.has(ENRICHMENT_SUBJECT)) return subjectKey([...buckets][0]);
  return ENRICHMENT_KEY;
}

/**
 * Everything the class part of the gatherer reads for one scholar and term,
 * read ONCE: the term partition (`plan`) and the scholar's in-term record.
 * Every class's evidence, and whether a class has any, is then a filter over
 * this, so one read serves a whole report list.
 */
export type TermRecord = {
  plan: ScholarTermReports;
  period: Doc<"reportingPeriods">;
  scholarId: Id<"users">;
  inWindow: (t: number) => boolean;
  /** The report key a session's work belongs to; null when it has no unit. */
  keyOfSession: (sessionId: Id<"sessions"> | undefined) => Promise<string | null>;
  mastery: Doc<"masteryObservations">[];
  practice: Doc<"practiceMastery">[];
  fluent: Doc<"practiceMastery">[];
  deliverables: { at: number; unitId: Id<"units"> | null; sessionId: Id<"sessions">; text: string }[];
  /** In-term activity completions, for the enrichment row's work count. */
  completions: EnrichmentWork[];
  paper: PaperItem[];
  connections: Doc<"crossDomainConnections">[];
  signals: Doc<"sessionSignals">[];
  checkin: Doc<"interimCheckins"> | null;
  /** Reads left for lookups made while filtering (granules, older sessions),
   *  and whether any cap was reached: then only the most recent work counts. */
  budget: { granules: number; extraSessions: number; limited: boolean };
};

export async function loadTermRecord(
  db: DatabaseReader,
  scholarId: Id<"users">,
  period: Doc<"reportingPeriods">,
  plan?: ScholarTermReports,
): Promise<TermRecord> {
  const reports = plan ?? (await loadScholarTermReports(db, scholarId, period));
  const { startsAt, endsAt } = period;
  const inWindow = (t: number) => t >= startsAt && t <= endsAt;

  // Session → report key, through the same class partition the report's units
  // come from, so evidence from another class's work (or enrichment work)
  // stays out. A session begun before the term but worked in it is read here.
  const budget = { granules: MAX_GRANULE_READS, extraSessions: MAX_EXTRA_SESSIONS, limited: reports.recentOnly };
  const sessionKey = new Map<string, string | null>();
  const unitKey = new Map<string, string | null>();
  const keyOfSession = async (sessionId: Id<"sessions"> | undefined): Promise<string | null> => {
    if (!sessionId) return null;
    const sid = String(sessionId);
    if (sessionKey.has(sid)) return sessionKey.get(sid)!;
    let unitId: Id<"units"> | undefined;
    if (reports.sessionUnits.has(sid)) unitId = reports.sessionUnits.get(sid);
    else if (budget.extraSessions > 0) {
      budget.extraSessions -= 1;
      unitId = (await db.get(sessionId))?.unitId;
    } else {
      budget.limited = true;
      return null;
    }
    let key: string | null = null;
    if (unitId) {
      const uid = String(unitId);
      if (reports.unitKeys.has(uid)) {
        key = reports.unitKeys.get(uid) ?? null;
        // A teacher's unit with no subject says nothing about the class, so
        // its evidence is placed by its own subject (`inSubject`'s domains).
        if (key === ENRICHMENT_KEY && reports.blankStaffUnits.has(uid)) key = null;
      } else {
        // Only reached for a session counted against `extraSessions`.
        if (!unitKey.has(uid)) {
          const unit = await db.get(unitId);
          const k = unit ? reports.keyOfUnit(unit) : null;
          unitKey.set(uid, k === ENRICHMENT_KEY && unit && isBlankStaffUnit(unit) ? null : k);
        }
        key = unitKey.get(uid) ?? null;
      }
    }
    sessionKey.set(sid, key);
    return key;
  };

  const masteryRows = await db
    .query("masteryObservations")
    .withIndex("by_scholar_observedAt", (q) =>
      q.eq("scholarId", scholarId).gte("observedAt", startsAt).lte("observedAt", endsAt),
    )
    .order("desc")
    .take(MAX_RECORD_ROWS);
  const mastery = masteryRows.filter((m) => !m.isSuperseded);

  const deliverables: TermRecord["deliverables"] = [];
  const deliverableRows = await db
    .query("deliverables")
    .withIndex("by_scholar_submittedAt", (q) =>
      q.eq("scholarId", scholarId).gte("submittedAt", startsAt).lte("submittedAt", endsAt),
    )
    .order("desc")
    .take(MAX_DELIVERABLES);
  for (const d of deliverableRows) {
    const activity = await db.get(d.activityId);
    const lesson = activity?.lessonId ? await db.get(activity.lessonId) : null;
    const met = (d.verdicts ?? []).filter((x) => x.level === "full").length;
    const total = (d.verdicts ?? []).length;
    deliverables.push({
      at: d.submittedAt,
      unitId: lesson?.unitId ?? null,
      sessionId: d.sessionId,
      text: `${activity?.title ?? "Project"}${total > 0 ? ` (${met} of ${total} criteria fully met)` : ""}${d.rubricFeedback ? `: ${d.rubricFeedback}` : ""}`,
    });
  }

  const connections = await db
    .query("crossDomainConnections")
    .withIndex("by_scholar", (q) =>
      q.eq("scholarId", scholarId).gte("_creationTime", startsAt).lte("_creationTime", endsAt),
    )
    .order("desc")
    .take(MAX_RECORD_ROWS);
  const signals = await db
    .query("sessionSignals")
    .withIndex("by_scholar", (q) =>
      q.eq("scholarId", scholarId).gte("_creationTime", startsAt).lte("_creationTime", endsAt),
    )
    .order("desc")
    .take(MAX_RECORD_ROWS);
  const completionRows = await db
    .query("activityCompletions")
    .withIndex("by_scholar_completedAt", (q) =>
      q.eq("scholarId", scholarId).gte("completedAt", startsAt).lte("completedAt", endsAt),
    )
    .order("desc")
    .take(MAX_RECORD_ROWS);
  const paper = await paperWork(db, scholarId, period, reports);
  const practice = await practiceRows(db, scholarId);
  if (
    masteryRows.length >= MAX_RECORD_ROWS ||
    deliverableRows.length >= MAX_DELIVERABLES ||
    connections.length >= MAX_RECORD_ROWS ||
    signals.length >= MAX_RECORD_ROWS ||
    completionRows.length >= MAX_RECORD_ROWS ||
    paper.limited ||
    practice.length >= MAX_PRACTICE_ROWS
  )
    budget.limited = true;

  return {
    plan: reports,
    period,
    scholarId,
    inWindow,
    keyOfSession,
    mastery,
    practice,
    fluent: fluentInTerm(practice, period),
    deliverables,
    completions: completionRows.map((c) => ({ unitId: c.unitId ?? null, at: c.completedAt, sessionId: c.sessionId })),
    paper: paper.items,
    connections,
    signals,
    checkin: await db
      .query("interimCheckins")
      .withIndex("by_scholar_period", (q) => q.eq("scholarId", scholarId).eq("periodId", period._id))
      .first(),
    budget,
  };
}

/**
 * The evidence groups that are this class's own work this term. A class
 * report is "without work" — never drafted, written by hand instead — exactly
 * when the gatherer returns every one of these empty.
 */
const CLASS_WORK_GROUPS = new Set([
  "units",
  "fluency",
  "understanding",
  "confusions",
  "demonstrated",
  "work",
  "paperWork",
  "connections",
  "habits",
]);

function noClassWork(groups: EvidenceGroup[]): boolean {
  return groups.every((g) => !CLASS_WORK_GROUPS.has(g.key) || g.items.length === 0);
}

/** Is this report one of the scholar's classes (not SEL, not a name a teacher typed)? */
function isClassReport(subject: string, plan: ScholarTermReports): boolean {
  return plan.byClass && classForReportSubject(subject, plan.own) !== null;
}

/**
 * Whether a class report has nothing to draft from, decided by the gatherer's
 * own class groups (`academicGroups`) over a record read once. Reports that
 * are not one of the scholar's classes are never "without work".
 */
export async function reportWithoutWork(
  db: DatabaseReader,
  record: TermRecord,
  subject: string,
): Promise<boolean> {
  if (!isClassReport(subject, record.plan)) return false;
  return noClassWork(await academicGroups(db, record, subject, { light: true }));
}

// ── The gatherer ────────────────────────────────────────────────────────

export async function gatherParentReportEvidence(
  db: DatabaseReader,
  narrative: Doc<"courseNarratives">,
  preloaded?: TermRecord,
): Promise<ParentReportEvidence> {
  const period = preloaded?.period ?? (await db.get(narrative.periodId));
  if (!period) throw new Error("Reporting period not found");
  const scholar = await db.get(narrative.scholarId);
  const scholarId = narrative.scholarId;
  const { startsAt, endsAt } = period;
  const inWindow = (t: number) => t >= startsAt && t <= endsAt;
  const isSel = isSelSubject(narrative.subject);
  const firstName =
    scholar?.firstName?.trim() || scholar?.name?.trim().split(/\s+/)[0] || "Your child";

  const groups: EvidenceGroup[] = [];
  const push = pusher(groups);

  // ── Teacher-written material for THIS report (retired rubric sections) ──
  const notes = legacySectionNotes(narrative.sections);
  if (notes.length > 0) {
    push("teacherNotes", "The teacher's own notes for this report (highest priority — use these)", notes.map((n) => `${n.title}: ${n.body}`));
  }

  const observations = (
    await db.query("observations").withIndex("by_scholar", (q) => q.eq("scholarId", scholarId)).collect()
  )
    .filter((o) => inWindow(o._creationTime) || (o.periodId !== undefined && o.periodId === period._id))
    // Concerns and interventions are teacher-facing analysis; a parent draft
    // shouldn't paraphrase them. The teacher can raise them in their own words.
    .filter((o) => o.type !== "concern" && o.type !== "intervention");

  let classWithoutWork = false;
  let slotBlock: string | null = null;
  let paper: PaperItem[] = [];
  if (isSel) {
    await gatherSel(db, { scholarId, period, inWindow, observations, push });
    if (narrative.status !== "shared") slotBlock = slotRefusal(narrative, await loadReportSlots(db, scholarId, period));
  } else {
    const record = preloaded ?? (await loadTermRecord(db, scholarId, period));
    paper = record.paper;
    const academic = await academicGroups(db, record, narrative.subject);
    groups.push(...academic);
    classWithoutWork = isClassReport(narrative.subject, record.plan) && noClassWork(academic);
    if (narrative.status !== "shared")
      slotBlock = slotRefusal(narrative, groupReportSlots(await periodRows(db, scholarId, period._id), record.plan));
    // Teacher observations. Not subject-tagged, so the model is told to pick.
    push(
      "observations",
      "Teacher observations this term (from any subject — use only those that fit this report)",
      observations
        .filter((o) => o.category === undefined)
        .map((o) => ({ text: `${o.type}: ${o.note}`, at: o._creationTime })),
    );
  }

  // ── Goals the scholar is working on (any subject; the model picks) ──
  const goals = (
    await db.query("scholarGoals").withIndex("by_scholar", (q) => q.eq("scholarId", scholarId)).collect()
  ).filter((g) => g.status === "active" || g.status === "achieved");
  const goalItems: string[] = [];
  for (const g of goals) {
    const checkins = await db
      .query("goalCheckins")
      .withIndex("by_goal", (q) => q.eq("goalId", g._id))
      .order("desc")
      .take(2);
    const latest = checkins.map((c) => c.note).filter(Boolean).join(" / ");
    goalItems.push(`${g.title} (${g.status})${latest ? ` — latest check-in: ${latest}` : ""}`);
  }
  push("goals", "Learning goals on record (use only those that fit this report)", goalItems);

  // ── Last term's report in this subject (to show change over time) ──
  const prior = await priorReportText(db, narrative, period);
  push("prior", "Last term's report in this area (what we said we'd work on)", prior ? [prior] : []);

  return {
    scholarFirstName: firstName,
    // Parent reports use the profile pronouns; a teacher reads every report
    // before it reaches the family (Andy, 2026-11-18; see users.pronouns).
    pronouns: scholar?.pronouns ?? null,
    gradeLevel: scholar?.gradeLevel?.trim() || null,
    subject: narrative.subject,
    isSel,
    periodLabel: period.label,
    periodStart: day(startsAt),
    periodEnd: day(endsAt),
    familyGoals: await gatherFamilyGoals(db, scholarId),
    // Only the pieces this report's evidence actually shows the drafter.
    pieces: paper
      .filter((p) => groups.some((g) => g.key === "paperWork" && g.items.some((i) => i.startsWith(`(piece ${p.ref}) `))))
      .map((p) => ({ ref: p.ref, id: String(p.id), title: p.title })),
    groups,
    classWithoutWork,
    // Why "Draft from the record" is not offered: a second report in the
    // class's slot, or a class with no work. The server refuses the same.
    draftBlocked: slotBlock ?? (classWithoutWork ? NO_CLASS_WORK_REFUSAL : null),
  };
}

/**
 * Everything the Math report's practice evidence is built from, for THIS
 * report's term: the overall level and pace, each area's level, and which of
 * the term's fluent skills were new to the child (`learnedSkillKeys`) or
 * already known. The
 * teacher view's portrait (`gatherMathPortrait` with `withOverall`) measures
 * pace over the school's current period, which is not the report's period once
 * a term is over, so everything here uses the report's own window. The catalog
 * is read once and the attempts lookup (`learnedSkillKeys`) runs once, shared
 * by the pace, the per-area split and the skill list.
 */
async function gatherMathRecord(db: DatabaseReader, record: TermRecord) {
  const { scholarId, period, practice: rows } = record;
  const catalog = await loadMathCatalog(db);
  const grades = catalog.grades;
  // A term still running is measured to today: months of school that haven't
  // happened yet would understate the pace. Month-scale, so a cached query
  // result going a little stale is harmless. The grade equivalent the level is
  // read against is taken at the same moment, so a closed term compares with
  // where that term ended.
  // A child who joined after the term began is measured from the day they
  // joined (`paceWindowStart`, the rule the portrait's pace uses too).
  const scholar = await db.get(scholarId);
  const startMs = paceWindowStart(period.startsAt, scholar?._creationTime);
  const endMs = Math.min(period.endsAt, Date.now());
  const learnedSet = await learnedSkillKeys(db, scholarId, rows, grades, startMs, endMs);
  const inWindow = new Set(skillsFluentInWindow(rows, grades, startMs, endMs).map((r) => r.skillKey));

  // Each area the scholar has touched, in curriculum order.
  const areas: AreaLevelInput[] = [];
  for (const slug of Object.keys(PRACTICE_DOMAIN_LABELS)) {
    const domainRows = rows.filter((r) => r.domain === slug);
    if (domainRows.length === 0) continue;
    const gradeByKey = new Map<string, string | null | undefined>(
      (catalog.nodesByDomain.get(slug) ?? []).map((n) => [n.nodeKey, n.grade]),
    );
    const level = mathLevel(domainRows, gradeByKey);
    if (!level) continue;
    const termRows = domainRows.filter((r) => inWindow.has(r.skillKey));
    const learned = termRows.filter((r) => learnedSet.has(r.skillKey)).length;
    areas.push({
      label: PRACTICE_DOMAIN_LABELS[slug],
      levelValue: level.value,
      highestValue: frontierGradeValue(domainRows, gradeByKey),
      dailySkills: fluentCount(domainRows),
      placementSkills: level.placementSkills,
      learnedThisTerm: learned,
      knownThisTerm: termRows.length - learned,
      // mathLevel's bands are the catalog's graded ranks, lowest upward.
      topCatalogRank: level.bands.length > 0 ? level.bands[level.bands.length - 1].rank : null,
      bands: level.bands,
    });
  }

  return {
    level: mathLevel(rows, grades),
    enrolledRank: gradeRank(scholar?.gradeLevel),
    asOfMs: endMs,
    pace: endMs > startMs ? learnedPace(rows, grades, learnedSet, startMs, endMs) : null,
    /** The day the child joined (YYYY-MM-DD, the school's time zone, as the
     *  parent page prints it), if after the term began: the pace covers only
     *  the time since. */
    joinedOnDay:
      startMs > period.startsAt
        ? dayKeyForTimezone(startMs, await timeZoneForInstitution({ db }, scholar?.institutionId))
        : null,
    areas: areaLevelEvidence(areas),
    /** The term's fluent skills new to the child, and those already known. */
    learned: rows.filter((r) => inWindow.has(r.skillKey) && learnedSet.has(r.skillKey)),
    known: rows.filter((r) => inWindow.has(r.skillKey) && !learnedSet.has(r.skillKey)),
    nodeByKey: new Map([...catalog.nodesByDomain.values()].flat().map((n) => [n.nodeKey, n])),
  };
}

type Push = (groupKey: string, label: string, items: string[] | EvidenceCandidate[], maxChars?: number) => void;

/** Plain strings keep their order; candidates are picked newest-first, one
 *  per repeated thing (lib/parentReport.pickEvidence), and each ends with its
 *  date so the drafter can tell a pattern or a change from one moment. */
function pusher(groups: EvidenceGroup[]): Push {
  return (groupKey, label, items, maxChars = MAX_ITEM_CHARS) => {
    const lines =
      items.length > 0 && typeof items[0] !== "string"
        ? pickEvidenceCandidates(items as EvidenceCandidate[], MAX_ITEMS_PER_GROUP).map((c) =>
            datedEvidenceLine(c, maxChars),
          )
        : (items as string[]).slice(0, MAX_ITEMS_PER_GROUP).map((i) => clip(i, maxChars));
    groups.push({ key: groupKey, label, items: lines });
  };
}

/**
 * The academic report's evidence groups for one report name, filtered from
 * the term record. `light` skips what only decorates an item (skill labels,
 * the math portrait) and never decides whether a group has items, for the
 * "is there anything to draft from" check.
 */
async function academicGroups(
  db: DatabaseReader,
  record: TermRecord,
  subject: string,
  opts: { light?: boolean } = {},
): Promise<EvidenceGroup[]> {
  const { plan, scholarId, inWindow, keyOfSession } = record;
  const key = reportKeyFor(subject, plan);
  const groups: EvidenceGroup[] = [];
  const push = pusher(groups);
  // Where a piece of evidence belongs. With a session in a unit: that unit's
  // bucket only, so a stray tag ("art" on a Science session) never moves it.
  // With no session to place it (a game, a portfolio scan, a chat outside any
  // unit): its free-text domain, matched against the scholar's OWN classes
  // and attached only when exactly one class fits; otherwise it stays with
  // the enrichment work. For a scholar with no classes, the domain matches by
  // folded name, as before.
  const domainMatches = (domain: string) => {
    const d = subjectKey(domain.trim() in PRACTICE_DOMAIN_LABELS ? "Math" : domain);
    return d !== "" && d === key;
  };
  const domainClassKey = (domains: string[]): string | null => {
    const k = domainReportKey(domains, plan);
    return k === ENRICHMENT_KEY || k === NOT_REPORTED_KEY ? null : k;
  };
  const inSubject = async (sessionId: Id<"sessions"> | undefined, domains: string[] = []) => {
    const s = await keyOfSession(sessionId);
    if (s !== null) return s === key;
    if (domains.length === 0) return false;
    return plan.byClass ? domainClassKey(domains) === key : domains.some(domainMatches);
  };

  // Units the scholar actually worked in (read once, with the term).
  const unitIds = plan.sections.get(key)?.unitIds ?? [];
  const unitSet = new Set(unitIds.map(String));
  const units = unitIds.map((id) => plan.unitText.get(String(id))).filter((t): t is string => t !== undefined);
  push("units", "Units and projects this term", units);

  // Practice-engine evidence (the one math class only): the strongest, most
  // specific growth evidence the record has. The "is there anything to draft
  // from" check (`light`) needs only whether a skill turned fluent; the full
  // read splits the term's skills into learned and already known.
  if (isMathReport(key, plan)) {
    const math = opts.light ? null : await gatherMathRecord(db, record);
    const items: string[] = [];
    const split = math ? termFluencyLine(math.learned.length, math.known.length) : null;
    if (split && math) {
      items.push(split);
      // New skills first, so the drafter's examples are new learning: the
      // highest grade first, then the most recent, so the examples come from
      // the child's hardest new work. Already-known skills follow, the most
      // recent spread across math areas.
      const byGradeThenDate = (list: Doc<"practiceMastery">[]) =>
        list
          .map((r) => ({ r, rank: gradeRank(math.nodeByKey.get(r.skillKey)?.grade) ?? -1 }))
          .sort((a, b) => b.rank - a.rank || b.r.becameFluentAt! - a.r.becameFluentAt!)
          .map(({ r }) => r);
      const pick = (list: Doc<"practiceMastery">[]) =>
        pickEvidence(
          list.map((r) => ({ text: r.skillKey, at: r.becameFluentAt!, bucket: r.domain })),
          list.length,
        ).map((skillKey) => list.find((r) => r.skillKey === skillKey)!);
      const learnedKeys = new Set(math.learned.map((r) => r.skillKey));
      for (const r of [...byGradeThenDate(math.learned), ...pick(math.known)]) {
        if (items.length >= MAX_ITEMS_PER_GROUP) break;
        const node = math.nodeByKey.get(r.skillKey);
        if (!node?.label) continue;
        items.push(fluentSkillItem(node.label, node.grade, learnedKeys.has(r.skillKey), short(r.becameFluentAt!)));
      }
    } else if (record.fluent.length > 0) {
      items.push(`${record.fluent.length} skills newly reached fluency this term.`);
    }
    push(
      "fluency",
      "Math practice this term, from the child's daily practice in Rabbithole: skills that reached fluency (new to the child this term first, highest grade first, then skills the child already knew and has now shown)",
      items,
    );
    // A credential a teacher granted (calculatorLicenses.ts): a milestone the
    // family will want named, which fluency counts alone don't show.
    const licenses = await db
      .query("calculatorLicenses")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect();
    push(
      "milestones",
      "Math milestones this term",
      licenses
        .filter((l) => inWindow(l.issuedAt))
        .map(
          (l) =>
            `Earned the school's Calculator License on ${short(l.issuedAt)}: passed the teacher-proctored paper test of math-fact fluency, which gives permission to use a calculator in class.`,
        ),
    );
    if (math) {
      push(
        "overall",
        "Where the child stands in math overall, all areas together, against a standard curriculum, counted by Rabbithole from daily practice and the placement check-in",
        overallMathEvidence(
          math.level,
          math.enrolledRank,
          math.asOfMs,
          math.pace,
          math.joinedOnDay,
        ),
      );
      push(
        "level",
        "Level in each math area now, as whole grades, counted by Rabbithole from the skills shown in daily practice and those credited by the placement check-in. The first line summarizes all areas",
        math.areas,
        MAX_AREA_LINE_CHARS,
      );
    }
  }

  // Understanding shown in tutoring sessions; misconceptions kept apart as
  // material for next steps.
  const understood: EvidenceCandidate[] = [];
  const confusions: EvidenceCandidate[] = [];
  for (const m of record.mastery) {
    if (!(await inSubject(m.sessionId, [m.domain]))) continue;
    const line = `${m.conceptLabel}: ${m.evidenceSummary}${m.studentInitiated ? " (the scholar brought this up on their own)" : ""}`;
    const candidate = { text: line, at: m.observedAt, key: m.conceptLabel };
    if (m.evidenceType === "misconception_signal") confusions.push(candidate);
    else understood.push(candidate);
  }
  push("understanding", "Understanding shown in tutoring sessions", understood);
  push("confusions", "Confusions noticed (material for next steps, not for criticism)", confusions);

  // Granule evidence from the class's units. Skipped by the "any work?"
  // check: granules exist only for the class's units, and a class with a
  // unit already has work. Otherwise read within the record's total budget.
  const granules: EvidenceCandidate[] = [];
  for (const unitId of opts.light ? [] : unitIds) {
    const n = Math.min(MAX_GRANULES_PER_UNIT, record.budget.granules);
    if (n <= 0) {
      record.budget.limited = true;
      break;
    }
    const rows = await db
      .query("granuleEvidence")
      .withIndex("by_scholar_unit", (q) => q.eq("scholarId", scholarId).eq("unitId", unitId))
      .order("desc")
      .take(n);
    record.budget.granules -= rows.length;
    for (const g of rows) {
      if (!inWindow(g.observedAt) || g.outcome !== "demonstrated") continue;
      granules.push({ text: g.evidenceSummary, at: g.observedAt });
    }
  }
  push("demonstrated", "Ideas demonstrated in unit work", granules);

  // Submitted work and its feedback.
  push(
    "work",
    "Projects and work submitted",
    record.deliverables
      .filter((d) => d.unitId !== null && unitSet.has(String(d.unitId)))
      .map((d) => ({ text: d.text, at: d.at })),
  );

  // Scanned or uploaded work on paper, from this class's units.
  push(
    "paperWork",
    "Work on paper (scanned or uploaded)",
    record.paper
      .filter((p) => p.key === key)
      // The number leads, so clipping a long line never cuts it off.
      .map((p) => ({ text: `(piece ${p.ref}) ${p.text}`, at: p.at })),
  );

  // Connections the scholar made to other subjects.
  const conn: EvidenceCandidate[] = [];
  for (const c of record.connections) {
    // Without classes a connection also counts for any domain it names, as before.
    const touches = (!plan.byClass && c.domains.some(domainMatches)) || (await inSubject(c.sessionId, c.domains));
    if (!touches) continue;
    conn.push({ text: `${c.description}${c.studentInitiated ? " (on their own initiative)" : ""}`, at: c._creationTime });
  }
  push("connections", "Connections the scholar made between this subject and other interests", conn);

  // How they worked, in this class's sessions.
  const habits: EvidenceCandidate[] = [];
  for (const s of record.signals) {
    if (!(await inSubject(s.sessionId))) continue;
    habits.push(signalCandidate(s));
  }
  push("habits", "How the scholar approached the work in this subject", habits);

  // The subject's block of the interim check-in.
  const section = INTERIM_SECTIONS.find(
    (s) => s.part === "academic" && (subjectKey(s.title) === key || subjectKey(s.key) === key),
  );
  push(
    "checkin",
    "Mid-term check-in ratings for this subject",
    record.checkin && section ? interimLines(record.checkin, [section]) : [],
  );
  return groups;
}

async function gatherSel(
  db: DatabaseReader,
  args: {
    scholarId: Id<"users">;
    period: Doc<"reportingPeriods">;
    inWindow: (t: number) => boolean;
    observations: Doc<"observations">[];
    push: Push;
  },
) {
  const { scholarId, period, inWindow, push } = args;

  // The team's agreed Whole Child read for this period, if one was written.
  const wc = await db
    .query("wholeChildNarratives")
    .withIndex("by_scholar_period", (q) => q.eq("scholarId", scholarId).eq("periodId", period._id))
    .first();
  push(
    "wholeChild",
    "The teaching team's agreed notes on this scholar this term (highest priority — use these)",
    (wc?.sections ?? []).filter((s) => s.body.trim()).map((s) => `${s.title}: ${s.body}`),
  );

  const CATEGORY_LABEL: Record<string, string> = {
    execFunction: "Learning habits",
    socialEmotional: "Social-emotional",
    collaboration: "Collaboration and community",
    passions: "Passions and projects",
    other: "Other",
  };
  push(
    "staffNotes",
    "Staff notes about the scholar as a learner and person",
    args.observations
      .filter((o) => o.category !== undefined)
      .map((o) => ({ text: `${CATEGORY_LABEL[o.category!] ?? o.category}: ${o.note}`, at: o._creationTime, bucket: o.category })),
  );
  push(
    "observations",
    "Other teacher observations this term",
    args.observations
      .filter((o) => o.category === undefined)
      .map((o) => ({ text: `${o.type}: ${o.note}`, at: o._creationTime })),
  );

  const syntheses = await db
    .query("selSyntheses")
    .withIndex("by_scholar_week", (q) => q.eq("scholarId", scholarId))
    .collect();
  const strengths: EvidenceCandidate[] = [];
  const watch: EvidenceCandidate[] = [];
  for (const s of syntheses) {
    if (s.quiet || !inWindow(s.window.startMs)) continue;
    const at = s.window.startMs;
    // The line ends "(week of Nov 3)": a weekly summary is not one day's moment.
    for (const c of s.strengths) strengths.push({ text: c.text, at, key: c.text, when: `week of ${short(at)}` });
    for (const c of s.watch) watch.push({ text: c.text, at, key: c.text, when: `week of ${short(at)}` });
  }
  push("weeklyStrengths", "Weekly summaries — strengths", strengths);
  push("weeklyWatch", "Weekly summaries — things to keep growing (material for next steps)", watch);

  const signals = await db
    .query("sessionSignals")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  push(
    "habits",
    "How the scholar approached learning in tutoring sessions",
    signals.filter((s) => inWindow(s._creationTime)).map(signalCandidate),
  );

  const seeds = withoutWonders(
    await db.query("seeds").withIndex("by_scholar_status", (q) => q.eq("scholarId", scholarId)).collect(),
  );
  push(
    "interests",
    "Interests the scholar explored by choice",
    seeds
      .filter((s) => s.status === "completed" && inWindow(s.completedAt ?? s._creationTime))
      .map((s) => ({ text: s.topic, at: s.completedAt ?? s._creationTime })),
  );

  const checkin = await db
    .query("interimCheckins")
    .withIndex("by_scholar_period", (q) => q.eq("scholarId", scholarId).eq("periodId", period._id))
    .first();
  const items: string[] = [];
  if (checkin) {
    items.push(...interimLines(checkin, INTERIM_SECTIONS.filter((s) => s.part === "wholeChild")));
    if (checkin.comments.strengths.trim()) items.push(`Strengths and interests: ${checkin.comments.strengths}`);
    if (checkin.comments.growth.trim()) items.push(`Areas for continued growth: ${checkin.comments.growth}`);
  }
  push("checkin", "Mid-term check-in", items);
}

/** A session signal as evidence: one per description, spread across signal types. */
function signalCandidate(s: Doc<"sessionSignals">): EvidenceCandidate {
  return {
    text: `${s.signalType.replace(/_/g, " ")}: ${s.description}`,
    at: s._creationTime,
    key: s.description,
    bucket: s.signalType,
  };
}

/**
 * Work on paper this term: the scanned or uploaded pages the scholar owns or
 * is attributed to (the same union `readScholarWorkSamples` reads), each with
 * the unit it belongs to, its caption, and what the observer saw on it. A page
 * shared with other scholars stays out, since its caption can describe them;
 * so does a page not tied to an assignment or activity, which can't be placed
 * in a class. Only this scholar's observations are read. Each class then
 * keeps the pages from its own units.
 */
async function paperWork(
  db: DatabaseReader,
  scholarId: Id<"users">,
  period: Doc<"reportingPeriods">,
  plan: ScholarTermReports,
): Promise<{ items: PaperItem[]; limited: boolean }> {
  const inWindow = (t: number) => t >= period.startsAt && t <= period.endsAt;
  const items = new Map<string, Doc<"portfolioItems">>();
  for (const item of await db
    .query("portfolioItems")
    .withIndex("by_scholar", (q) =>
      q.eq("scholarId", scholarId).gte("_creationTime", period.startsAt).lte("_creationTime", period.endsAt),
    )
    .order("desc")
    .take(MAX_PAPER_ITEMS))
    items.set(String(item._id), item);
  for (const a of await db
    .query("portfolioAttributions")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId).gte("_creationTime", period.startsAt))
    .order("desc")
    .take(MAX_PAPER_ITEMS)) {
    if (items.has(String(a.portfolioItemId))) continue;
    const item = await db.get(a.portfolioItemId);
    if (item) items.set(String(item._id), item);
  }
  // At most MAX_PAPER_ITEMS pages are placed, newest first, each with at most
  // 3 lookups, 2 attribution rows (a second row is always another scholar's,
  // which already excludes the page) and 10 observation rows.
  const pages = [...items.values()]
    .filter((item) => item.source !== "capture_station" && inWindow(item._creationTime))
    .sort((a, b) => b._creationTime - a._creationTime);
  const limited = pages.length > MAX_PAPER_ITEMS;
  const out: PaperItem[] = [];
  for (const item of pages.slice(0, MAX_PAPER_ITEMS)) {
    let unitId: Id<"units"> | undefined;
    if (item.assignmentId) unitId = (await db.get(item.assignmentId))?.unitId ?? undefined;
    let activityTitle: string | undefined;
    if (item.activityId) {
      const activity = await db.get(item.activityId);
      activityTitle = activity?.title;
      if (!unitId && activity?.lessonId) unitId = (await db.get(activity.lessonId))?.unitId;
    }
    const attributed = await db.query("portfolioAttributions").withIndex("by_item", (q) => q.eq("portfolioItemId", item._id)).take(2);
    if (attributed.some((a) => a.scholarId !== scholarId) || (item.scholarId !== undefined && item.scholarId !== scholarId)) continue;
    const observed = (await db.query("masteryObservations").withIndex("by_portfolioItem", (q) => q.eq("portfolioItemId", item._id)).take(10))
      .filter((o) => o.scholarId === scholarId && !o.isSuperseded);
    const seen = observed
      .filter((o) => o.evidenceType !== "misconception_signal")
      .slice(0, 2)
      .map((o) => `${o.conceptLabel}: ${o.evidenceSummary}`);
    // The page's report section, by the rule all evidence follows: its unit's
    // bucket (whether or not the scholar ever opened that unit in a session),
    // else the domains observed on the page. A page nothing places is left out.
    let key: string | null = null;
    // A teacher's unit with no subject says nothing about the class, so its
    // page is placed by what was observed on it, like a page with no unit.
    let byObservations = !unitId;
    if (unitId) {
      const uid = String(unitId);
      let blank: boolean;
      if (plan.unitKeys.has(uid)) {
        key = plan.unitKeys.get(uid) ?? null;
        blank = plan.blankStaffUnits.has(uid);
      } else {
        const unit = await db.get(unitId);
        key = unit ? plan.keyOfUnit(unit) : null;
        blank = unit !== null && isBlankStaffUnit(unit);
      }
      byObservations = key === ENRICHMENT_KEY && blank;
    }
    if (byObservations) {
      // Placed by real skills only: a misconception note doesn't decide it.
      const placing = observed.filter((o) => o.evidenceType !== "misconception_signal");
      if (placing.length > 0) key = pageReportKey(practiceDomainsAsMath(placing.map((o) => o.domain), plan), plan);
      else if (!unitId) continue;
    }
    out.push({
      at: item._creationTime,
      unitId: unitId ?? null,
      key,
      id: item._id,
      title: item.label ?? activityTitle ?? item.title,
      ref: out.length + 1,
      text: `${item.label ?? activityTitle ?? item.title}${item.aiCaption ? ` — ${item.aiCaption}` : ""}${seen.length ? `. Seen on the page: ${seen.join("; ")}` : ""}`,
    });
  }
  return { items: out, limited };
}

/** One line per rating bucket for the given check-in sections ("Usually: …"). */
function interimLines(
  checkin: Doc<"interimCheckins">,
  sections: typeof INTERIM_SECTIONS,
): string[] {
  const out: string[] = [];
  for (const section of sections) {
    const byRating = new Map<string, string[]>();
    for (const group of section.groups) {
      for (const item of group.items) {
        const r = checkin.ratings[item.key];
        if (!r || r === "notObserved") continue;
        const arr = byRating.get(r) ?? [];
        arr.push(item.label.toLowerCase());
        byRating.set(r, arr);
      }
    }
    for (const rating of INTERIM_RATINGS) {
      const labels = byRating.get(rating.value);
      if (labels?.length) out.push(`${section.title} — ${rating.label}: ${labels.join("; ")}`);
    }
  }
  return out;
}

/**
 * What the family said they hope for: the "family goals" comment on each
 * interim check-in, and parent-teacher conference notes. Conference notes are
 * read from their REDACTED fields only (no scores, no PII), since whatever the
 * draft repeats is headed to a parent.
 */
async function gatherFamilyGoals(db: DatabaseReader, scholarId: Id<"users">): Promise<string[]> {
  const out: string[] = [];
  const checkins = await db
    .query("interimCheckins")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  for (const c of checkins.sort((a, b) => b._creationTime - a._creationTime)) {
    const text = c.comments.familyGoals.trim();
    if (!text) continue;
    const p = await db.get(c.periodId);
    const month = new Date(c._creationTime).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
    out.push(clip(`From the ${p?.label ?? "mid-term"} check-in (${month}): ${text}`, 600));
  }
  const notes = await db
    .query("scholarDocuments")
    .withIndex("by_scholar_kind", (q) => q.eq("scholarId", scholarId).eq("kind", "conference_notes"))
    .collect();
  for (const d of notes.sort((a, b) => b._creationTime - a._creationTime).slice(0, 3)) {
    const parts = [d.redactedSummary?.trim(), ...(d.redactedKeyFindings ?? [])].filter(Boolean);
    if (parts.length === 0) continue;
    out.push(clip(`From conference notes "${d.title}" (${short(d._creationTime)}): ${parts.join(" ")}`, 900));
  }
  return out;
}

/** The previous period's report in the same subject (prose, or legacy sections). */
async function priorReportText(
  db: DatabaseReader,
  narrative: Doc<"courseNarratives">,
  period: Doc<"reportingPeriods">,
): Promise<string | null> {
  const all = await db
    .query("courseNarratives")
    .withIndex("by_scholar", (q) => q.eq("scholarId", narrative.scholarId))
    .collect();
  // The same subject by name, or by meaning, so last term's "Math Workshop"
  // report connects to this term's "Math" class. The newest earlier term wins;
  // within it, a report of the same name beats one that only shares a meaning.
  let best: { n: Doc<"courseNarratives">; endsAt: number; exact: boolean } | null = null;
  for (const n of all) {
    if (n._id === narrative._id) continue;
    const exact = subjectKey(n.subject) === subjectKey(narrative.subject);
    if (!exact && !unitSubjectFitsClass(n.subject, narrative.subject)) continue;
    const p = await db.get(n.periodId);
    if (!p || p.endsAt >= period.startsAt) continue;
    if (!best || p.endsAt > best.endsAt || (p.endsAt === best.endsAt && exact && !best.exact))
      best = { n, endsAt: p.endsAt, exact };
  }
  if (best) {
    const body = reportBody(best.n.sections).trim();
    const text = body || legacySectionNotes(best.n.sections).map((s) => `${s.title}: ${s.body}`).join(" ");
    if (text) return clip(text, 1500);
  }
  if (isSelSubject(narrative.subject)) {
    const wcs = await db
      .query("wholeChildNarratives")
      .withIndex("by_scholar", (q) => q.eq("scholarId", narrative.scholarId))
      .collect();
    let prior: { text: string; endsAt: number } | null = null;
    for (const w of wcs) {
      const p = await db.get(w.periodId);
      if (!p || p.endsAt >= period.startsAt) continue;
      const text = w.sections.filter((s) => s.body.trim()).map((s) => `${s.title}: ${s.body}`).join(" ");
      if (text && (!prior || p.endsAt > prior.endsAt)) prior = { text, endsAt: p.endsAt };
    }
    if (prior) return clip(prior.text, 1500);
  }
  return null;
}

// ── The scholar's report rows ───────────────────────────────────────────

/** One row of a scholar's reports for a term. */
type ReportRow = {
  /** The class (or SEL, or the hand-typed name) the row stands for. */
  subject: string;
  /** The report stored for it; null when none is opened yet. */
  narrative: Doc<"courseNarratives"> | null;
  /** "Draft all" considers it: class and SEL rows, and, for a scholar with no
   *  classes on record, every row as before. A name that is none of the
   *  scholar's classes is never drafted automatically. */
  autoDraft: boolean;
  /** False only for a class report the gatherer finds no work for. */
  hasEvidence: boolean;
  /** A second row in a slot that already has its report: never drafted. */
  leftover: boolean;
};

/**
 * The scholar's report rows for a term, in display order (classes A to Z,
 * then SEL, then names a teacher typed, then "Enrichment and projects"), with existing reports paired to
 * their class by `classForReportSubject`. A shared report that belongs to a
 * class IS that class's report, so the class never gets a second one; an
 * unshared one is reused. "Draft all" and the scholar page both read this.
 */
async function planReportRows(
  db: DatabaseReader,
  record: TermRecord,
  existing: Doc<"courseNarratives">[],
): Promise<ReportRow[]> {
  const { plan, scholarId, period } = record;
  const derived = await deriveReportSubjects(
    db, scholarId, period, plan, record.fluent,
    record.paper.flatMap((p) => (p.key ? [p.key] : [])),
  );
  type Slot = { subject: string; narrative: Doc<"courseNarratives"> | null; handAdded: boolean };
  const slots = new Map<string, Slot>();
  for (const subject of derived) slots.set(reportKeyFor(subject, plan), { subject, narrative: null, handAdded: false });
  // Every scholar has one "Enrichment and projects" row, last.
  slots.set(ENRICHMENT_KEY, { subject: ENRICHMENT_SUBJECT, narrative: null, handAdded: false });
  // Each slot's report by THE slot rule (`pickSlotReport`): a shared row wins,
  // then the newest with text, then the newest. The others are leftovers:
  // listed so nothing disappears, never drafted, renamed or reused.
  const grouped = groupReportSlots(existing, plan);
  const duplicates: Doc<"courseNarratives">[] = [];
  for (const [key, { report, leftovers }] of grouped.slots) {
    let slot = slots.get(key);
    if (!slot) {
      // A class with no derived row (an elective with no work) that a teacher
      // opened is still that class's report; any other name is hand-added.
      const cls = isClassReport(report.subject, plan) ? classForReportSubject(report.subject, plan.own) : null;
      slot = { subject: cls ?? report.subject, narrative: null, handAdded: cls === null };
      slots.set(key, slot);
    }
    slot.narrative = report;
    duplicates.push(...leftovers);
  }
  // Classes A to Z, then SEL, then names a teacher typed, then enrichment.
  const rank = (s: Slot) =>
    isEnrichmentSubject(s.subject) ? 3 : s.handAdded ? 2 : isSelSubject(s.subject) ? 1 : 0;
  // The enrichment row has work when its list has a line.
  const enrichmentHasWork = (await enrichmentItems(db, record)).length > 0;
  const ordered = [...slots.values()].sort((a, b) => rank(a) - rank(b) || a.subject.localeCompare(b.subject));
  const rows: ReportRow[] = [];
  for (const s of ordered)
    rows.push({
      subject: s.subject,
      narrative: s.narrative,
      // A typed name is drafted automatically only where there are no classes.
      autoDraft: !s.handAdded || !plan.byClass,
      hasEvidence: isEnrichmentSubject(s.subject)
        ? enrichmentHasWork
        : !(await reportWithoutWork(db, record, s.subject)),
      leftover: false,
    });
  for (const n of duplicates.sort((a, b) => a.subject.localeCompare(b.subject)))
    rows.push({ subject: n.subject, narrative: n, autoDraft: false, hasEvidence: true, leftover: true });
  return rows;
}

async function periodRows(
  db: DatabaseReader,
  scholarId: Id<"users">,
  periodId: Id<"reportingPeriods">,
): Promise<Doc<"courseNarratives">[]> {
  return await db
    .query("courseNarratives")
    .withIndex("by_scholar_period", (q) => q.eq("scholarId", scholarId).eq("periodId", periodId))
    .collect();
}

// ── Teacher-facing reads ────────────────────────────────────────────────

/**
 * The scholar's report rows for a period, each with whether it has anything
 * to draft from and whether "Draft all" takes it: the page counts "Draft all"
 * from these, so its number matches what runs. `recentOnly` is true when the
 * scholar's sessions passed the read cap and only the most recent work counts.
 */
export const subjectsForScholarPeriod = teacherQuery({
  args: { scholarId: v.id("users"), periodId: v.id("reportingPeriods") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const period = await requirePeriodForScholar(ctx, args.periodId, args.scholarId);
    const record = await loadTermRecord(ctx.db, args.scholarId, period);
    const rows = await planReportRows(ctx.db, record, await periodRows(ctx.db, args.scholarId, args.periodId));
    return {
      rows: rows.map((r) => ({
        subject: r.subject,
        narrativeId: r.narrative?._id ?? null,
        autoDraft: r.autoDraft,
        hasEvidence: r.hasEvidence,
        leftover: r.leftover,
      })),
      // Any read cap reached (sessions, evidence rows): only recent work counts.
      recentOnly: record.budget.limited,
    };
  },
});

/**
 * The scholar's own ordinary classes this term (every group they belong to),
 * A to Z: what the add-report picker offers. Empty when they have no classes
 * on record for the term.
 */
export const classesForScholarPeriod = teacherQuery({
  args: { scholarId: v.id("users"), periodId: v.id("reportingPeriods") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const period = await requirePeriodForScholar(ctx, args.periodId, args.scholarId);
    const { own } = await loadScholarClasses(ctx.db, args.scholarId, period);
    return [...foldReportClasses(own).values()]
      // Only classes with their own section: never an enrichment class
      // (its work is in the list) or a not-reported one (Extended Ed).
      .filter((c) => c.kind === "ordinary")
      .map((c) => c.display)
      .sort((a, b) => a.localeCompare(b));
  },
});

/** The evidence a report's draft is (or would be) written from. */
export const evidence = teacherQuery({
  args: { narrativeId: v.id("courseNarratives") },
  handler: async (ctx, args) => {
    const n = await ctx.db.get(args.narrativeId);
    if (!n) return null;
    await requireActiveScholarAccess(ctx, ctx.user, n.scholarId);
    return await gatherParentReportEvidence(ctx.db, n);
  },
});

/**
 * The portfolio pieces listed under a report, for the composer: each one's
 * name and whether the family can open it (a piece the portfolio doesn't
 * share with them is never shown under their report).
 */
export const reportPieces = teacherQuery({
  args: { narrativeId: v.id("courseNarratives") },
  handler: async (ctx, args) => {
    const n = await ctx.db.get(args.narrativeId);
    if (!n) return [];
    await requireActiveScholarAccess(ctx, ctx.user, n.scholarId);
    const ids = n.pieces ?? [];
    if (ids.length === 0) return [];
    const familySees = new Set(
      (await familyPortfolioItems(ctx, n.scholarId, { hydrate: false })).map((i) => String(i._id)),
    );
    const out: { id: Id<"portfolioItems">; title: string; familyCanSee: boolean }[] = [];
    for (const id of ids) {
      const item = await ctx.db.get(id);
      if (!item) continue;
      const activity = item.activityId ? await ctx.db.get(item.activityId) : null;
      out.push({ id, title: item.label ?? activity?.title ?? item.title, familyCanSee: familySees.has(String(id)) });
    }
    return out;
  },
});

/** Take a piece off a report's "Work in this report" list. */
export const removeReportPiece = teacherMutation({
  args: { narrativeId: v.id("courseNarratives"), pieceId: v.id("portfolioItems") },
  handler: async (ctx, args) => {
    const n = await ctx.db.get(args.narrativeId);
    if (!n) throw new Error("Report not found");
    await requireActiveScholarAccess(ctx, ctx.user, n.scholarId);
    await ctx.db.patch(n._id, { pieces: (n.pieces ?? []).filter((id) => id !== args.pieceId) });
  },
});

// ── Drafting ────────────────────────────────────────────────────────────

/** Mark a report as drafting; returns the request's token. */
async function markDrafting(ctx: MutationCtx, narrativeId: Id<"courseNarratives">): Promise<number> {
  const requestedAt = Date.now();
  await ctx.db.patch(narrativeId, { draftRequestedAt: requestedAt, draftError: undefined });
  return requestedAt;
}

/**
 * Draft these reports one after another, in order. Each draft sees the ones
 * written before it (`evidenceForDraft`), so a scholar's reports don't retell
 * the same story and SEL, drafted last, can see the subject reports.
 */
async function scheduleDrafts(ctx: MutationCtx, ids: Id<"courseNarratives">[]) {
  if (ids.length === 0) return;
  const queue = [];
  for (const narrativeId of ids) queue.push({ narrativeId, requestedAt: await markDrafting(ctx, narrativeId) });
  const [first, ...next] = queue;
  await ctx.scheduler.runAfter(0, internal.parentReportActions.draft, { ...first, next });
}

/**
 * A draft result lands only for the report's live request: a newer request
 * supersedes it, and one past the stale cutoff has already handed the report
 * back to the teacher, who may have edited it since.
 */
function isCurrentRequest(n: Doc<"courseNarratives">, requestedAt: number): boolean {
  return n.draftRequestedAt === requestedAt && isDrafting(n, Date.now());
}

/**
 * Draft (or redraft) one report. Replaces the prose; the composer confirms
 * before a redraft overwrites text. A shared report is never redrafted, and a
 * class report with no work this term is refused (`reportWithoutWork`).
 *
 * Takes the report's id, or a scholar + period + subject for a row not opened
 * yet: the report is then opened in this same mutation, so a refused draft
 * leaves nothing behind. The term is read once and passed down. Returns the
 * report's id.
 */
export const requestDraft = teacherMutation({
  args: {
    narrativeId: v.optional(v.id("courseNarratives")),
    scholarId: v.optional(v.id("users")),
    periodId: v.optional(v.id("reportingPeriods")),
    subject: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let n: Doc<"courseNarratives"> | null = null;
    let subject: string;
    let scholarId: Id<"users">;
    let periodId: Id<"reportingPeriods">;
    if (args.narrativeId) {
      n = await ctx.db.get(args.narrativeId);
      if (!n) throw new Error("Report not found");
      ({ subject, scholarId, periodId } = n);
    } else {
      subject = (args.subject ?? "").trim();
      if (!args.scholarId || !args.periodId || !subject) throw new Error("Say which report to draft");
      scholarId = args.scholarId;
      periodId = args.periodId;
    }
    await requireActiveScholarAccess(ctx, ctx.user, scholarId);
    const period = await requirePeriodForScholar(ctx, periodId, scholarId);
    if (n?.status === "shared") throw new Error("This report has already been published to parents");
    const record = await loadTermRecord(ctx.db, scholarId, period);
    const { plan } = record;
    // One report per slot: a second row in a class's slot is never drafted,
    // and a slot whose report is shared gets no draft at all.
    const slots = groupReportSlots(await periodRows(ctx.db, scholarId, periodId), plan);
    if (n) {
      const refusal = slotRefusal(n, slots);
      if (refusal) throw new ConvexError(refusal);
    } else {
      const slot = slots.slots.get(slots.keyOf(subject));
      if (slot?.report.status === "shared") throw new ConvexError(SHARED_SLOT_REFUSAL);
      n = slot?.report ?? null;
    }
    if (isEnrichmentSubject(n?.subject ?? subject)) {
      // The plain titles land now; the drafter then writes each line for parents.
      const id = (await fillEnrichmentRow(ctx, record, n, true))!;
      await scheduleDrafts(ctx, [id]);
      return id;
    }
    if (await reportWithoutWork(ctx.db, record, n?.subject ?? subject)) throw new ConvexError(NO_CLASS_WORK_REFUSAL);
    // A new row: never for a class with no report of its own.
    if (!n) subject = newReportSubject(subject, plan);
    const className = plan.byClass ? classForReportSubject(n?.subject ?? subject, plan.own) : null;
    if (!n) {
      const name = className ?? subject;
      const id = await ctx.db.insert("courseNarratives", {
        scholarId,
        teacherId: ctx.user._id,
        periodId,
        subject: name,
        unitIds: await deriveUnitIds(ctx, scholarId, periodId, name, plan),
        sections: newReportSections(),
        goalIds: [],
        status: "draft",
      });
      await scheduleDrafts(ctx, [id]);
      return id;
    }
    // A report from before classes takes its class's name when drafted.
    if (className && className !== n.subject) await ctx.db.patch(n._id, { subject: className });
    await scheduleDrafts(ctx, [n._id]);
    return n._id;
  },
});

/** The enrichment row's list from one record: its sessions plus the
 *  completions, deliverables and paper work the record already read. */
async function enrichmentItems(db: DatabaseReader, record: TermRecord) {
  const work: EnrichmentWork[] = [
    ...record.completions,
    ...record.deliverables.map(({ unitId, at, sessionId }) => ({ unitId, at, sessionId })),
    ...record.paper.map(({ unitId, at }) => ({ unitId, at })),
  ];
  return await enrichmentListItems(db, record.plan, record.scholarId, work);
}

/**
 * Fill the "Enrichment and projects" row from the record: the list of
 * `enrichmentListItems`, written as its plain-text body of unit titles at
 * once. The caller then queues the drafter, which rewrites each line for
 * parents from the unit's title and description (and on a reply that doesn't
 * match the list, leaves the titles). Edited, marked done and shared like
 * any report. Opens the row when
 * there is none. Refuses (`refuseEmpty`) or skips when the list is empty.
 * The caller has already refused a shared row. Returns the row's id.
 */
async function fillEnrichmentRow(
  ctx: MutationCtx & { user: { _id: Id<"users"> } },
  record: TermRecord,
  n: Doc<"courseNarratives"> | null,
  refuseEmpty: boolean,
): Promise<Id<"courseNarratives"> | null> {
  const body = enrichmentListBody(await enrichmentItems(ctx.db, record));
  if (!body) {
    if (refuseEmpty) throw new ConvexError(NO_ENRICHMENT_REFUSAL);
    return null;
  }
  const sections = [{ key: REPORT_SECTION_KEY, title: REPORT_SECTION_TITLE, body }];
  if (!n)
    return await ctx.db.insert("courseNarratives", {
      scholarId: record.scholarId,
      teacherId: ctx.user._id,
      periodId: record.period._id,
      subject: ENRICHMENT_SUBJECT,
      unitIds: [],
      sections,
      goalIds: [],
      status: "draft",
    });
  // A redraft replaces the list and goes back to draft, as a model draft does.
  await ctx.db.patch(n._id, {
    subject: ENRICHMENT_SUBJECT,
    sections,
    status: "draft",
    draftRequestedAt: undefined,
    draftError: undefined,
  });
  return n._id;
}

/**
 * Draft every report the scholar page counts for "Draft all": each row that
 * takes part (`planReportRows`), has work to draft from, isn't shared and has
 * no prose yet. A class with no work is skipped and keeps its "Not started"
 * row; a report from before classes is reused under its class's name.
 */
export const draftAllForScholar = teacherMutation({
  args: { scholarId: v.id("users"), periodId: v.id("reportingPeriods") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const period = await requirePeriodForScholar(ctx, args.periodId, args.scholarId);
    const record = await loadTermRecord(ctx.db, args.scholarId, period);
    const rows = await planReportRows(ctx.db, record, await periodRows(ctx.db, args.scholarId, args.periodId));
    const now = Date.now();
    const toDraft: Doc<"courseNarratives">[] = [];
    let listed = 0;
    let enrichmentId: Id<"courseNarratives"> | null = null;
    for (const row of rows) {
      if (!row.autoDraft || !row.hasEvidence) continue;
      let n = row.narrative;
      if (n && (n.status === "shared" || reportBody(n.sections).trim() || isDrafting(n, now))) continue;
      if (isEnrichmentSubject(row.subject)) {
        enrichmentId = await fillEnrichmentRow(ctx, record, n, false);
        if (enrichmentId) listed += 1;
        continue;
      }
      if (!n) {
        const id = await ctx.db.insert("courseNarratives", {
          scholarId: args.scholarId,
          teacherId: ctx.user._id,
          periodId: args.periodId,
          subject: row.subject,
          unitIds: await deriveUnitIds(ctx, args.scholarId, args.periodId, row.subject, record.plan),
          sections: newReportSections(),
          goalIds: [],
          status: "draft",
        });
        n = (await ctx.db.get(id))!;
      } else if (record.plan.byClass && n.subject !== row.subject && isClassReport(row.subject, record.plan)) {
        await ctx.db.patch(n._id, { subject: row.subject });
        n = { ...n, subject: row.subject };
      }
      toDraft.push(n);
    }
    // SEL last, so it is written knowing what the subject reports say.
    toDraft.sort((a, b) => Number(isSelSubject(a.subject)) - Number(isSelSubject(b.subject)));
    // The enrichment list's lines are rewritten for parents last.
    await scheduleDrafts(ctx, [...toDraft.map((n) => n._id), ...(enrichmentId ? [enrichmentId] : [])]);
    // `scheduled`: reports sent to the drafter. `filled`: the enrichment row,
    // listed here by title before the drafter rewrites its lines.
    return { scheduled: toDraft.length, filled: listed };
  },
});

export const evidenceForDraft = internalQuery({
  args: { narrativeId: v.id("courseNarratives") },
  handler: async (ctx, args) => {
    const n = await ctx.db.get(args.narrativeId);
    if (!n) return null;
    const scholar = await ctx.db.get(n.scholarId);
    if (isEnrichmentSubject(n.subject)) {
      // The list's units, in list order, for the drafter to describe.
      const period = await ctx.db.get(n.periodId);
      if (!period) return null;
      const record = await loadTermRecord(ctx.db, n.scholarId, period);
      const items = orderedEnrichmentItems(await enrichmentItems(ctx.db, record)).map((i) => ({
        title: i.title,
        description: i.description,
        scholarMade: i.scholarMade,
        lessonTitles: i.lessonTitles,
        sessionTitles: i.sessionTitles,
      }));
      return { kind: "enrichment" as const, items, institutionId: scholar?.institutionId ?? null };
    }
    // The scholar's other reports this term that already have prose, oldest
    // first: the drafter avoids retelling their stories.
    const siblings = await ctx.db
      .query("courseNarratives")
      .withIndex("by_scholar_period", (q) => q.eq("scholarId", n.scholarId).eq("periodId", n.periodId))
      .collect();
    const otherReports = siblings
      .filter((s) => s._id !== n._id && subjectKey(s.subject) !== subjectKey(n.subject))
      .sort((a, b) => a._creationTime - b._creationTime)
      .map((s) => ({ subject: reportTitle(s.subject), body: clip(reportBody(s.sections), 1800) }))
      .filter((s) => s.body.trim());
    // A class report also gets the units to read the scholar's own turns in
    // (`unitReadingInput`); SEL and other reports read none.
    let record: TermRecord | undefined;
    let readingUnitIds: Id<"units">[] = [];
    if (!isSelSubject(n.subject)) {
      const period = await ctx.db.get(n.periodId);
      if (period) {
        record = await loadTermRecord(ctx.db, n.scholarId, period);
        readingUnitIds = readingUnits(n.subject, record);
      }
    }
    return {
      kind: "report" as const,
      evidence: await gatherParentReportEvidence(ctx.db, n, record),
      otherReports,
      readingUnitIds,
      institutionId: scholar?.institutionId ?? null,
    };
  },
});

// ── The reading pass: a scholar's own turns across one unit ─────────────

/** Units read per class report, most-worked first. */
const MAX_READING_UNITS = 4;
/** Sessions read per unit: spread from the first to the last. */
const MAX_READING_SESSIONS = 40;
/** Messages read per session, oldest first. */
const MAX_READING_MESSAGES_PER_SESSION = 200;
/** Message rows and text read per unit, across its sessions: well inside a
 *  query's 32,000-document and 16 MiB limits even when a session holds long
 *  AI replies or app code. */
const MAX_READING_MESSAGES = 4_000;
const MAX_READING_CHARS = 4_000_000;
/** Lessons and activities read for "what the unit asked". */
const MAX_READING_LESSONS = 12;
const MAX_READING_ACTIVITIES_PER_LESSON = 10;

/**
 * A class report's own units (`plan.sections`, the same set its evidence comes
 * from). Empty for SEL, enrichment, and any report that isn't one of the
 * scholar's classes.
 */
function reportUnitIds(subject: string, plan: ScholarTermReports): Id<"units">[] {
  if (isSelSubject(subject) || isEnrichmentSubject(subject) || !isClassReport(subject, plan)) return [];
  return plan.sections.get(reportKeyFor(subject, plan))?.unitIds ?? [];
}

/**
 * The units the reading pass reads, up to MAX_READING_UNITS: the ones where
 * the scholar said the most worth noticing, counted by the understanding and
 * confusions the observer recorded in the unit's sessions this term, then by
 * sessions. Session count alone ranks a unit of many short sessions over one
 * long conversation, and a class can hold many more units than are read.
 */
function readingUnits(subject: string, record: TermRecord): Id<"units">[] {
  const { plan } = record;
  const weight = new Map<string, { noticed: number; sessions: number }>();
  const at = (unitId: Id<"units">) => {
    const k = String(unitId);
    let w = weight.get(k);
    if (!w) weight.set(k, (w = { noticed: 0, sessions: 0 }));
    return w;
  };
  for (const unitId of plan.sessionUnits.values()) if (unitId) at(unitId).sessions += 1;
  for (const m of record.mastery) {
    const unitId = m.sessionId ? plan.sessionUnits.get(String(m.sessionId)) : undefined;
    if (unitId) at(unitId).noticed += 1;
  }
  return reportUnitIds(subject, plan)
    .map((id, idx) => ({ id, idx, ...(weight.get(String(id)) ?? { noticed: 0, sessions: 0 }) }))
    .sort((a, b) => b.noticed - a.noticed || b.sessions - a.sessions || a.idx - b.idx)
    .slice(0, MAX_READING_UNITS)
    .map((u) => u.id);
}

/** Evenly spread `k` of `items`, always the first and the last. */
function spreadPick<T>(items: T[], k: number): T[] {
  if (items.length <= k) return items;
  const idx = new Set<number>();
  for (let i = 0; i < k; i++) idx.add(Math.round((i * (items.length - 1)) / (k - 1)));
  return [...idx].sort((a, b) => a - b).map((i) => items[i]);
}

/** A "user" row that is not something the scholar said: a staff member typing
 *  for them, an app asking the AI, the `<start>` opener, or a line read
 *  aloud from the AI's reply (the same filter as activityCompletions). */
function notScholarsOwn(m: Doc<"messages">): boolean {
  const text = m.content.trim();
  return m.byStaff === true || m.inputModality === "app" || m.readAloudOf !== undefined || text === "" || text === "<start>";
}

/**
 * "What this unit asked": the unit's own design text (title, the descriptions,
 * the big idea, essential questions and enduring understandings), its lesson
 * titles, and each activity's title, scholar-facing blurb and deliverable
 * prompt. Never the tutor-facing system prompts, and never an activity's
 * teacher notes (`description`).
 */
async function unitAskedText(db: DatabaseReader, unit: Doc<"units">): Promise<string> {
  const lines: string[] = [];
  const add = (label: string, text: string | undefined) => {
    const t = (text ?? "").replace(/\s+/g, " ").trim();
    if (t) lines.push(`${label}: ${t}`);
  };
  add("Description", unit.description);
  if (unit.scholarDescription && unit.scholarDescription !== unit.description)
    add("For the scholar", unit.scholarDescription);
  add("Big idea", unit.bigIdea);
  for (const q of unit.essentialQuestions ?? []) add("Essential question", q.text);
  for (const u of unit.enduringUnderstandings ?? []) add("Understanding", u.text);
  const lessons = (
    await db.query("lessons").withIndex("by_unit", (q) => q.eq("unitId", unit._id)).take(MAX_READING_LESSONS)
  ).sort((a, b) => a.order - b.order);
  for (const lesson of lessons) {
    add("Lesson", lesson.title);
    const activities = (
      await db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", lesson._id))
        .take(MAX_READING_ACTIVITIES_PER_LESSON)
    )
      .filter((a) => a.archivedAt === undefined)
      .sort((a, b) => a.order - b.order);
    for (const a of activities) {
      const parts = [a.title, a.scholarDescription, a.deliverable?.prompt ? `To make: ${a.deliverable.prompt}` : undefined]
        .map((x) => (x ?? "").trim())
        .filter(Boolean);
      add("  Activity", parts.join(" — "));
    }
  }
  return capUnitAsked(lines.join("\n"));
}

/**
 * One class report's reading input for one of its units: the scholar's own
 * turns and the AI's replies across their sessions in the unit this term, and
 * what the unit asked. Null when the unit is not one of this report's units
 * (the same `plan.sections` set the gatherer reads), or for SEL and
 * enrichment.
 *
 * Sessions are the scholar's own term sessions the plan placed in this unit
 * (`plan.sessionUnits`, read through `by_user` in the term window), minus
 * test drives, offline holders and seeded exemplars; archived sessions count,
 * as they do for the class's evidence. Messages are user and assistant rows
 * only (never system or tool rows), with staff-typed and app rows left out.
 *
 * PRIVACY: this reads sessions, messages and the unit's design text, nothing
 * else. It never reads `scholarDossiers`, `scholarDocuments` (clinical and
 * uploaded documents live there), observations or any other record: keep it
 * that way, since what it returns goes to a model writing to parents.
 */
export const unitReadingInput = internalQuery({
  args: { narrativeId: v.id("courseNarratives"), unitId: v.id("units") },
  handler: async (ctx, args): Promise<UnitReadingInput | null> => {
    const n = await ctx.db.get(args.narrativeId);
    if (!n || isSelSubject(n.subject) || isEnrichmentSubject(n.subject)) return null;
    const period = await ctx.db.get(n.periodId);
    if (!period) return null;
    const plan = await loadScholarTermReports(ctx.db, n.scholarId, period);
    if (!reportUnitIds(n.subject, plan).some((id) => id === args.unitId)) return null;
    const unit = await ctx.db.get(args.unitId);
    if (!unit) return null;

    // The plan's sessions are oldest first (`loadScholarTermReports`).
    const sessionIds = [...plan.sessionUnits]
      .filter(([, unitId]) => unitId === args.unitId)
      .map(([sid]) => sid as Id<"sessions">);
    let messageBudget = MAX_READING_MESSAGES;
    let charBudget = MAX_READING_CHARS;
    const sessions: ReadingSession[] = [];
    for (const sid of spreadPick(sessionIds, MAX_READING_SESSIONS)) {
      if (messageBudget <= 0 || charBudget <= 0) break;
      const s = await ctx.db.get(sid);
      if (!s || s.userId !== n.scholarId || s.unitId !== args.unitId) continue;
      if (s.isTestDrive || s.isOffline || s.seedExemplar) continue;
      const turns: ReadingTurn[] = [];
      let read = 0;
      for await (const m of ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", sid))
        .order("asc")) {
        read += 1;
        messageBudget -= 1;
        charBudget -= m.content.length;
        if (m.role === "user" && !notScholarsOwn(m))
          turns.push({ role: "scholar", text: m.content, at: m._creationTime });
        else if (m.role === "assistant" && m.content.trim())
          turns.push({ role: "ai", text: m.content, at: m._creationTime });
        if (read >= MAX_READING_MESSAGES_PER_SESSION || messageBudget <= 0 || charBudget <= 0) break;
      }
      // Dated by the scholar's first turn: a session is often opened (pushed
      // by a teacher) days before the scholar works in it.
      const first = turns.find((t) => t.role === "scholar");
      if (first) sessions.push({ startedAt: first.at, title: s.title, turns });
    }
    return {
      unitTitle: unit.title,
      subject: reportTitle(n.subject),
      unitAsked: await unitAskedText(ctx.db, unit),
      sessions,
    };
  },
});

/**
 * Start the next draft in a queue. Every report still waiting gets a fresh
 * token, so a long queue doesn't go stale and unlock reports that are still
 * coming; a report whose request was replaced or ran out drops off. Returns
 * the queue that is still live, in order.
 */
export const claimDraftQueue = internalMutation({
  args: { items: v.array(v.object({ narrativeId: v.id("courseNarratives"), requestedAt: v.number() })) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const live: { narrativeId: Id<"courseNarratives">; requestedAt: number }[] = [];
    for (const item of args.items) {
      const n = await ctx.db.get(item.narrativeId);
      if (!n || !isCurrentRequest(n, item.requestedAt) || n.status === "shared") continue;
      await ctx.db.patch(n._id, { draftRequestedAt: now });
      live.push({ narrativeId: n._id, requestedAt: now });
    }
    return live;
  },
});

/** Land a finished draft in the report's prose section. */
export const saveDraft = internalMutation({
  args: {
    narrativeId: v.id("courseNarratives"),
    requestedAt: v.number(),
    body: v.string(),
    // The portfolio pieces the draft describes; replaces the report's list.
    pieces: v.optional(v.array(v.id("portfolioItems"))),
  },
  handler: async (ctx, args) => {
    const n = await ctx.db.get(args.narrativeId);
    if (!n || !isCurrentRequest(n, args.requestedAt)) return;
    // Published while drafting: keep what parents already have.
    if (n.status === "shared") {
      await ctx.db.patch(n._id, { draftRequestedAt: undefined });
      return;
    }
    const sections = n.sections.filter((s) => s.key !== REPORT_SECTION_KEY);
    sections.unshift({ key: REPORT_SECTION_KEY, title: REPORT_SECTION_TITLE, body: args.body });
    // A fresh draft hasn't been read by a teacher yet, so it is never "done":
    // demote a report that was marked done so Publish all can't send it.
    await ctx.db.patch(n._id, {
      sections,
      pieces: args.pieces ?? [],
      status: "draft",
      draftRequestedAt: undefined,
      draftedAt: Date.now(),
      draftError: undefined,
    });
  },
});

export const saveDraftError = internalMutation({
  args: { narrativeId: v.id("courseNarratives"), requestedAt: v.number(), error: v.string() },
  handler: async (ctx, args) => {
    const n = await ctx.db.get(args.narrativeId);
    if (!n || !isCurrentRequest(n, args.requestedAt)) return;
    await ctx.db.patch(n._id, { draftRequestedAt: undefined, draftError: args.error.slice(0, 300) });
  },
});
