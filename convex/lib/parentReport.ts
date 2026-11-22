/**
 * Parent reports — the pure half (no DB): the report's storage key, subject
 * folding, placeholder detection, and the drafting prompt.
 *
 * A parent report is ONE prose body per scholar × period × subject, plus one
 * for SEL. It lives on `courseNarratives` as a single `report` section, so the
 * share pipeline, the parent portal, and the curriculum bot's report tools read
 * it with no second storage path. Rabbithole drafts it from the record
 * (`convex/parentReports.ts` gathers, `convex/parentReportActions.ts` calls the
 * model); the teacher edits and publishes it.
 *
 * Anything the record cannot support is written as a bracketed placeholder for
 * the teacher — "[a moment from class you'd like to share]" — never invented.
 * The UI highlights placeholders, and `share` refuses a report that still has
 * one, so a placeholder can't reach a parent.
 */

import { isPrimaryGroupType } from "./groupType";
import { subjectDisciplines, unitSubjectFitsClass } from "./classResolver";
import { normalizePronouns, scholarNamePronounHint } from "./scholarPronouns";
import { formatUnitNotes, type UnitReadingNote } from "./parentReportReading";
import type { LearnedPace, MathLevel, MathLevelBand } from "./practice/frontierGrade";
import { gradeEquivalentFromRank, gradeRelativeBand, levelDelta } from "../../shared/gradeEquivalent";
import { hasEnoughFluentSkillsForPace, MIN_FLUENT_SKILLS_FOR_PACE } from "../../shared/mathPace";

/** The single prose section a parent report is stored in. */
export const REPORT_SECTION_KEY = "report";
export const REPORT_SECTION_TITLE = "Report";

/** The subject a social-emotional report is filed under. */
export const SEL_SUBJECT = "SEL";

/**
 * The reserved subject the "Enrichment and projects" report row is filed
 * under (one per scholar per term, last on the page).
 * Class names are typed into the schedule by staff, and a leading and trailing
 * double underscore is not something a class is called; `reportBucketForUnit`
 * also refuses to treat a class with this key as a real class, so a class can
 * never be bucketed under it by name.
 */
export const ENRICHMENT_SUBJECT = "__enrichment__";
export const ENRICHMENT_TITLE = "Enrichment and projects";

export const PARENT_REPORT_PROMPT_VERSION = "parent-report-2026-11-21-v5" as const;

/**
 * Fold a subject name so "Math", "Maths", and "Mathematics" (or two casings of
 * "Humanities") are one subject. Used to dedupe derived subjects against
 * existing reports and to match a unit's subject to a report's.
 */
export function subjectKey(subject: string): string {
  const s = subject.trim().toLowerCase().replace(/\s+/g, " ");
  if (s === "math" || s === "maths" || s === "mathematics") return "math";
  if (s === "sel" || s === "social-emotional learning" || s === "social emotional learning")
    return "sel";
  return s;
}

export function isSelSubject(subject: string): boolean {
  return subjectKey(subject) === "sel";
}

/**
 * The reserved bucket for work in a class that is not included in reports
 * (`includedInReports: false`, Extended Ed and the like) and for work another
 * school owns: it reaches no report and not the enrichment row. Never a
 * report name, for the same reason as `ENRICHMENT_SUBJECT`.
 */
export const NOT_REPORTED_SUBJECT = "__not_reported__";

/** One live class, as the caller builds it from the term's non-archived
 *  classes. `subject` is the class's display name, `subjectKey` is
 *  `subjectKey(subject)`, `kind` is "enrichment" for the enrichment block,
 *  and `includedInReports: false` leaves the class out of reports entirely
 *  (absent means included). */
export type ReportClassEntry = {
  subject: string;
  subjectKey: string;
  kind?: "enrichment";
  includedInReports?: boolean;
};

/** The minimal unit shape the partition reads. A unit a scholar made carries
 *  `authorScholarId` (the same marker `convex/lib/unitAccess.ts` reads). */
export type ReportBucketUnit = {
  subject?: string | null;
  authorScholarId?: unknown;
};

/** How a folded class name reports: "ordinary" (its own section),
 *  "enrichment" (its work goes to the enrichment row) or "notReported"
 *  (`includedInReports: false`: nowhere). */
export type FoldedClassKind = "ordinary" | "enrichment" | "notReported";

/** One class row's report treatment. Not included wins over the kind. */
function rowReportKind(c: ReportClassEntry): FoldedClassKind {
  if (c.includedInReports === false) return "notReported";
  return c.kind === "enrichment" ? "enrichment" : "ordinary";
}

/**
 * The term's classes folded to one entry per report name, keyed by
 * `subjectKey`. The display name is the first one seen, and the name is an
 * enrichment class, or left out of reports, only when EVERY row carrying it
 * is, so one stale mark cannot
 * pull a whole class's work out of its section. A name that folds to a
 * reserved key or to the SEL report's key is left out, so a class can never
 * collide with those reports.
 */
export function foldReportClasses(
  classIndex: ReportClassEntry[],
): Map<string, { display: string; kind: FoldedClassKind }> {
  const classes = new Map<string, { display: string; kind: FoldedClassKind }>();
  const reserved = new Set([subjectKey(ENRICHMENT_SUBJECT), subjectKey(NOT_REPORTED_SUBJECT), subjectKey(SEL_SUBJECT)]);
  for (const c of classIndex) {
    const k = subjectKey(c.subject);
    if (reserved.has(k)) continue;
    const kind = rowReportKind(c);
    const seen = classes.get(k);
    if (!seen) classes.set(k, { display: c.subject.trim(), kind });
    else if (seen.kind !== kind) seen.kind = "ordinary";
  }
  return classes;
}

/** The bucket a class of this kind files its work under. */
function bucketOfClass(c: { display: string; kind: FoldedClassKind }): string {
  if (c.kind === "enrichment") return ENRICHMENT_SUBJECT;
  if (c.kind === "notReported") return NOT_REPORTED_SUBJECT;
  return c.display;
}

/**
 * The report section a unit's work is filed under: a class name (the class's
 * display subject), `ENRICHMENT_SUBJECT`, or `NOT_REPORTED_SUBJECT`. Every
 * unit lands in exactly one.
 *
 * A staff-made unit goes to the class whose subject it matches, first by the
 * report's own `subjectKey` folding, then by the meaning-matcher
 * `unitSubjectFitsClass` when exactly one ordinary class fits (or, with none,
 * exactly one not-reported class); an exact match lands where that class's kind
 * sends it. Scholar-made units, blank subjects, and subjects matching no class
 * or several all go to enrichment. Groups sharing a class
 * name are one class. Pure: the caller supplies the class list.
 */
export function reportBucketForUnit(
  unit: ReportBucketUnit,
  classIndex: ReportClassEntry[],
): string {
  if (unit.authorScholarId) return ENRICHMENT_SUBJECT;
  const subject = (unit.subject ?? "").trim();
  if (!subject) return ENRICHMENT_SUBJECT;
  const key = subjectKey(subject);
  const classes = foldReportClasses(classIndex);
  const exact = classes.get(key);
  if (exact) return bucketOfClass(exact);
  // By meaning: the one ordinary class that fits; with none, the one
  // not-reported class that fits ("Engineering" → an Extended Ed "Robotics").
  // An enrichment class is matched only by its exact name.
  const fits = (kind: FoldedClassKind) =>
    [...classes.values()].filter((c) => c.kind === kind && unitSubjectFitsClass(subject, c.display));
  const ordinary = fits("ordinary");
  if (ordinary.length === 1) return ordinary[0].display;
  if (ordinary.length === 0) {
    const notReported = fits("notReported");
    if (notReported.length === 1) return NOT_REPORTED_SUBJECT;
  }
  return ENRICHMENT_SUBJECT;
}

/**
 * THE RULE for which classes get a report row with no work in them (TRA-723):
 * a class of a homeroom group the scholar belongs to. A homeroom group is one
 * whose `type` is unset or "primary" (the age-based main group); any other type
 * is a second membership, such as an elective or extended-day group, whose
 * classes get a report only when the scholar has work in them. The teachers
 * are still deciding about those classes: to give every group's classes a row,
 * drop the type check here.
 */
export function classAlwaysReported(
  group: { type?: string | null; scholarIds: readonly string[] },
  scholarId: string,
): boolean {
  return (
    isPrimaryGroupType(group.type) &&
    group.scholarIds.some((id) => String(id) === String(scholarId))
  );
}

/**
 * The one class math practice evidence goes to: an ordinary class whose name
 * means math ("Math", "Math Workshop"), from the SCHOLAR'S OWN classes only.
 * The class named exactly "Math" wins, else the first by name. Null when none
 * of their classes means math: the caller keeps the old "Math" report.
 */
export function mathReportClass(ownClasses: ReportClassEntry[]): string | null {
  const math = [...foldReportClasses(ownClasses)].filter(
    ([, c]) => c.kind === "ordinary" && subjectDisciplines(c.display).includes("math"),
  );
  if (math.length === 0) return null;
  const exact = math.find(([k]) => k === "math");
  if (exact) return exact[1].display;
  return [...math].sort((a, b) => a[1].display.localeCompare(b[1].display))[0][1].display;
}

/**
 * THE pairing of a report row with a class (TRA-723): which of the scholar's
 * own ordinary classes an existing report belongs to, by its subject. Same
 * folded name first, else the one class whose meaning fits ("Social Studies"
 * → "Humanities", "Mathematics" → "Math"); null when none or several fit, or
 * for SEL. Every place a row is paired with a class goes through this.
 */
export function classForReportSubject(
  subject: string,
  ownClasses: ReportClassEntry[],
): string | null {
  if (isSelSubject(subject) || isEnrichmentSubject(subject)) return null;
  const bucket = reportBucketForUnit({ subject }, ownClasses);
  return bucket === ENRICHMENT_SUBJECT || bucket === NOT_REPORTED_SUBJECT ? null : bucket;
}

/** Whether a report name is the enrichment row: its reserved subject, or its
 *  title typed by a teacher or the aide. */
export function isEnrichmentSubject(subject: string): boolean {
  const k = subjectKey(subject);
  return k === subjectKey(ENRICHMENT_SUBJECT) || k === subjectKey(ENRICHMENT_TITLE);
}

/** The name a person reads for a report row. */
export function reportTitle(subject: string): string {
  return isEnrichmentSubject(subject) ? ENRICHMENT_TITLE : subject;
}

/** Refusal for drafting an enrichment row with nothing to list. */
export const NO_ENRICHMENT_REFUSAL =
  "There is nothing to list yet: no enrichment or project work this term was opened in more than one session.";

/**
 * Why a new report may not be opened under this name, or null. A class with
 * no report of its own (the enrichment block, or one not included in reports)
 * is refused by its exact folded name, so hiding it is never only the
 * picker's job.
 */
export function hiddenClassRefusal(subject: string, ownClasses: ReportClassEntry[]): string | null {
  const c = foldReportClasses(ownClasses).get(subjectKey(subject));
  if (c?.kind === "enrichment")
    return `${c.display} has no report of its own. Its work goes in ${ENRICHMENT_TITLE}.`;
  if (c?.kind === "notReported") return `${c.display} is not included in reports.`;
  return null;
}

/** One line of plain text: square brackets would read as a teacher
 *  placeholder and block publishing, and a newline would break the bullet. */
function cleanListLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/\[/g, "(").replace(/\]/g, ")");
}

/** The enrichment items in list order (by first session), blank titles dropped. */
export function orderedEnrichmentItems<T extends { title: string; firstSessionAt: number }>(items: T[]): T[] {
  return items
    .map((item, idx) => ({ item, idx }))
    .filter(({ item }) => cleanListLine(item.title))
    .sort((a, b) => a.item.firstSessionAt - b.item.firstSessionAt || a.idx - b.idx)
    .map(({ item }) => item);
}

/** The "Enrichment and projects" section body: one bullet per unit title,
 *  ordered by first session. Titles only, no status words. The drafter then
 *  rewrites each line for parents (`buildEnrichmentListRequest`). */
export function enrichmentListBody(
  items: { title: string; firstSessionAt: number }[],
): string {
  return orderedEnrichmentItems(items)
    .map((i) => `- ${cleanListLine(i.title)}`)
    .join("\n");
}

/** The drafter's instructions for the enrichment list. */
export function buildEnrichmentListSystemPrompt(): string {
  return `You write the "Enrichment and projects" list at the end of a child's school report. Parents read it. Each item is a project or enrichment unit the child worked on this term. You get its internal title, the description (written for staff), the titles of its lessons, and the titles of the child's own sessions in it. Some items are projects the child built themselves.

For each item, write one plain line a parent understands at a glance: what the project was, in everyday words.
- Read everything given. The title is often an internal label and the description is sometimes empty or says nothing; the lesson and session titles usually show what the work was. A one-word title like "Kindness" tells a parent nothing; the session titles usually show what the child made.
- For a project the child built, say so ("A self-designed app: ...").
- Drop emoji, version numbers, group names and course jargon ("v2", "(Seals)", "Challenge, Review & Skills").
- Describe the project. Don't claim what the child achieved or how well they did.
- Say what the project was in your own words; never quote the description, and leave out anything meant for teachers (grading, setup, logistics, notes about particular children).
- No more than 15 words. No ending period. Plain text: no bold, no brackets.
- If an item gives too little to go on, write its title in plain words. Never guess beyond what the titles and description support.

Output exactly one line per item, in the order given, each starting with "- ". Nothing else.`;
}

/** The request: the items in list order, numbered, with what is inside each. */
export function buildEnrichmentListRequest(
  items: {
    title: string;
    description?: string;
    scholarMade?: boolean;
    lessonTitles?: string[];
    sessionTitles?: string[];
  }[],
): string {
  const titles = (ts: string[] | undefined) =>
    (ts ?? []).map((t) => cleanListLine(t).slice(0, 80)).filter(Boolean).join("; ");
  return items
    .map((i, n) => {
      const lines = [`${n + 1}. Title: ${cleanListLine(i.title)}${i.scholarMade ? " (a project the child built)" : ""}`];
      if (i.description?.trim()) lines.push(`   Description: ${cleanListLine(i.description).slice(0, 400)}`);
      const lessons = titles(i.lessonTitles);
      if (lessons) lines.push(`   Lessons: ${lessons}`);
      const sessions = titles(i.sessionTitles);
      if (sessions) lines.push(`   The child's sessions: ${sessions}`);
      return lines.join("\n");
    })
    .join("\n");
}

/**
 * The drafter's list, or null when it doesn't have exactly one line per item
 * (the plain titles then stay). Lines are cleaned to one line of plain text.
 */
export function parseEnrichmentList(raw: string, count: number): string | null {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    // A dash, a bullet, or the request's own numbering ("1. ").
    .filter((l) => /^([-*•]|\d+[.)])\s+/.test(l))
    .map((l) => cleanListLine(l.replace(/^([-*•]|\d+[.)])\s+/, "").replace(/\*\*/g, "")).replace(/\.$/, ""))
    .filter(Boolean);
  if (lines.length !== count) return null;
  return lines.map((l) => `- ${l}`).join("\n");
}

/** Matches one teacher placeholder: `[...]` on a single line. */
const PLACEHOLDER_RE = /\[[^\]\n]+\]/g;

export type PlaceholderSpan = { start: number; end: number; text: string };

/** Every bracketed placeholder in a report body, in order. */
export function findPlaceholders(body: string): PlaceholderSpan[] {
  const out: PlaceholderSpan[] = [];
  for (const m of body.matchAll(PLACEHOLDER_RE)) {
    const start = m.index ?? 0;
    out.push({ start, end: start + m[0].length, text: m[0] });
  }
  return out;
}

/** The report's prose body (empty string when none has been written). */
export function reportBody(sections: { key: string; body: string }[]): string {
  return sections.find((s) => s.key === REPORT_SECTION_KEY)?.body ?? "";
}

/**
 * Text from the retired rubric sections (context, progress, Core…, goals) on a
 * report started before the prose form. Kept as teacher notes: the drafter
 * reads it, and the composer shows it read-only.
 */
export function legacySectionNotes(
  sections: { key: string; title: string; body: string }[],
): { title: string; body: string }[] {
  return sections
    .filter((s) => s.key !== REPORT_SECTION_KEY && s.body.trim().length > 0)
    .map((s) => ({ title: s.title, body: s.body.trim() }));
}

/**
 * A draft request older than this is treated as dead (the action was killed
 * before it could record a result), so the report is editable again and can
 * be redrafted. A draft and its one revision on Opus 5.5 take a minute or two;
 * this matches Convex's 10-minute action limit, past which the run is dead.
 */
export const DRAFT_STALE_MS = 10 * 60_000;

/** Is a model draft still in flight for this report, as of `now`? */
export function isDrafting(
  n: { draftRequestedAt?: number },
  now: number,
): boolean {
  return n.draftRequestedAt !== undefined && now - n.draftRequestedAt < DRAFT_STALE_MS;
}

/**
 * Why a report can't be published yet, or null. A report with unfilled
 * teacher placeholders ("[a moment from class]") must never reach a parent,
 * and neither may an empty one.
 */
export function publishBlocker(
  sections: { key: string; title: string; body: string }[],
): string | null {
  const body = reportBody(sections);
  const count = findPlaceholders(body).length;
  if (count > 0)
    return `Fill in the ${count} highlighted placeholder${count === 1 ? "" : "s"} before publishing`;
  // Every report publishes as prose. Rubric notes from the old form are
  // teacher notes the drafter reads; they are never published on their own.
  if (!body.trim()) return "Write the report before publishing";
  return null;
}

// ── Evidence (what the drafter is given; also shown to the teacher) ─────

export type EvidenceGroup = {
  /** Stable id for the UI. */
  key: string;
  /** Heading the teacher sees and the model reads. */
  label: string;
  items: string[];
};

export type ParentReportEvidence = {
  scholarFirstName: string;
  /** The pronouns on the scholar's profile, or null when none are recorded. */
  pronouns: string | null;
  gradeLevel: string | null;
  subject: string;
  isSel: boolean;
  periodLabel: string;
  periodStart: string; // YYYY-MM-DD
  periodEnd: string;
  /** What families said they hope for. Empty when none is recorded. */
  familyGoals: string[];
  /**
   * Portfolio pieces the evidence names, by the number the drafter sees
   * ("(piece 2)"). The drafter lists the ones its report describes, and the
   * family can open them from under the report.
   */
  pieces: { ref: number; id: string; title: string }[];
  groups: EvidenceGroup[];
  /** A class report with no work this term: no sessions in its units and no
   *  practice evidence. Never drafted; the teacher can write it by hand. */
  classWithoutWork?: boolean;
  /** Why this report can't be drafted from the record, or null. */
  draftBlocked?: string | null;
};

/** Why a class report with no work can't be drafted. */
export const NO_CLASS_WORK_REFUSAL =
  "There's no work in Rabbithole for this class yet, so there's nothing to draft from. You can write this one yourself.";

export function evidenceItemCount(e: ParentReportEvidence): number {
  return e.familyGoals.length + e.groups.reduce((n, g) => n + g.items.length, 0);
}

// ── Prompt ─────────────────────────────────────────────────────────────

const EXAMPLE_REPORT = `This term Rowan finished our math check-in and reached fluency on about fifteen new skills, several well beyond grade level, like multiplying fractions and finding the area of triangles. What stands out most is how Rowan tests an idea before trusting it. In October, while cutting paper shapes to compare areas, Rowan guessed that a triangle is always half of a rectangle, then went looking for a shape that might break the rule. When a slanted triangle seemed to, Rowan rearranged the pieces and showed why it still holds. By November Rowan was doing this without a prompt: after finding a formula for the tiles a garden path needs, Rowan asked, "Does it still work if the path turns a corner?" and checked. Checking an idea against a hard case is exactly how mathematicians work. Our area unit asked for a written explanation of each formula, and Rowan has written two of the three.

Next term, Rowan will finish that last explanation, and we want Rowan to show their reasoning more often. Rowan often reaches the right answer quickly but skips over why a method works, which makes mistakes harder to catch on longer problems. When Rowan does explain, the thinking is clear and careful, so we'll ask for it in words, sketches or tables. Rowan is ready to start ratios, percents and negative numbers.`;

export function buildParentReportSystemPrompt(): string {
  return `You draft end-of-term progress reports that a teacher at a school for gifted children will edit and then send to a scholar's parents. You write the first draft; the teacher owns the final text.

## Audience and voice
- Parents read this. Write warm, plain, specific English a busy parent can read in a minute. Write in the teacher's voice ("we", "our class").
- No education jargon or internal terms: never say PCM, Core/Connections/Practice/Identity, Bloom's, granule, mastery observation, signal, seed, frontier, dossier, rubric, metacognition, or "on-platform". Name the actual skill or moment instead.
- Sessions in the evidence are with Rabbithole, the school's AI. Parents know it, so say "Rabbithole" without explaining what it is, or "the AI" where a description reads better. Never call it a tutor.
- Refer to the scholar by first name. When a pronoun is needed, use exactly the pronouns the request gives for the child; when it gives none, use they/them. Never infer pronouns from a name or anything else.
- Growth framing: describe what the child can do now and what comes next. Never compare the child to other children. A "next step" is a skill or habit to grow into, never a deficit label.

## Length and shape
- Aim for about 200 words, in two paragraphs, plain prose (no headings, no bullet points, no bold). Never exceed 240 words.
- Paragraph 1: this term. Build it around ONE thread: a habit of mind, or a change, that the evidence shows at two or more dated moments. Tell it through those moments, with the child's own words where they help. Then say where the child stands against what the unit asked, including what is unfinished when the evidence shows it. One thread told well beats several unconnected moments. When the evidence supports no thread, use the strongest single example and say less.
- Measured progress comes first where the evidence has it: skills that reached fluency, grade levels in each area, a milestone earned. Parents want these most, above all in a math report, so give them before the thread, and let the thread take the room that is left.
- In a math report whose evidence says where the child stands across all math areas together, or gives a pace, open with those in one or two sentences. Then name at most three areas, choosing those with the most new learning or those that stand out, each as a whole grade exactly as the evidence words it. Give the other areas as the evidence's summary states them, and mention the areas that rest on the placement check-in alone together in one clause. Name each math area exactly as the evidence names it, without shortening the name.
- When the evidence says too few skills reached fluency this term to state a pace, give no pace, and don't describe how much the child practised or guess at a reason.
- Say once, in plain words, which part of the math picture comes from the placement check-in and which from daily practice in Rabbithole. Don't repeat that split for each area.
- Describe new learning with the skills the evidence marks as new to the child this term. Describe skills marked already known as things the child came in knowing and has now shown; proving a skill the child already knew is never growth.
- A line saying the child has also shown a skill from a higher grade may be mentioned once, as reach. It is never the child's level.
- Give a pace only as the evidence words it, in months of math learned over months of school; never turn it into a multiplier or a percentage, and leave pace out when the evidence says to. State no pace the evidence does not give.
- When the evidence gives a bracketed placeholder for the teacher, keep it exactly as written.
- Paragraph 2: what comes next. One or two goals for next term, why, and how we'll support them. Unfinished work from this term belongs here, as the next step. End when the plan is stated.

## Dates, patterns and change
Most evidence lines end with a date. Name a pattern only when at least two dated items in the evidence show it; one item is one moment, never a pattern. Claim a change ("at first…, by November…", "now reads more closely") only when two dated items show the earlier state and the later one; otherwise describe what the child does. Mention timing naturally by month ("in October", "by mid-November"); never list dates.

Some requests include notes read from the child's own turns in a unit. Each note is already checked against the child's exact words and dated, so they are the best material for the thread. Use a note's quotes as written, or leave them out. Quote the child only where the words show them thinking; never quote a moment of not knowing or forgetting. The thread must be about the report's subject itself: in a math report, how the child reasons about numbers and shapes, and never how they fixed or decorated an app. A note marked not finished yet only knows what happened in the child's Rabbithole sessions; work may have gone further in class, so state it as the next step and never as something the child failed to do.

## Style
Write plainly, in the manner of Strunk and White: active voice, concrete nouns and verbs, no needless words. Every sentence should tell the parent something their child did or something we will do. Cut any line that could sit in any child's report, such as "We can't wait to see what Rowan does next", "we're excited to watch it grow" or "Rowan is a joy to have in class". Prefer one exact example to a general claim. Say what the child should do next directly, without setting it against what they shouldn't ("explain why", not "not just what, but why").

## Family goals
If the evidence includes goals the family shared (for example at a conference), connect the report to them explicitly: say what progress the evidence shows toward each relevant goal, or how next term's plan serves it. Do not invent family goals, and do not mention family goals at all if none are given.
- Raise a goal only in a report it truly concerns. A goal about writing belongs in the writing report, not stretched to fit science or art.
- Parents may not remember a goal they shared months ago. The first time you mention one, say when and where it came from and restate it in a few words ("At our September check-in, you hoped Rowan would add more sensory detail to their stories").

## The evidence is staff-only source material
Apart from the teacher's or teaching team's own notes for this report and the family's goals, the evidence comes from records only staff see: session analyses, confusions noticed, weekly summaries, check-in ratings. Use it to decide what to say, then say it in your own words to a parent. Quote the child's own words when they help, but never copy the records' wording about the child. Never pass on a worry, a behaviour concern, a guess about a diagnosis or anything about another child. A confusion or a "keep growing" item may only appear as a next step we'll work on together.

## Pieces of work
Some evidence lines start with a piece number, like "(piece 2)": a page of the child's work the family can open from under the report. Describe the work in words; never write a piece number in the report. After the report, add one last line listing the pieces the report describes, such as "Pieces: 2, 5", or "Pieces: none".

## Never invent. Use placeholders instead.
Every claim must be supported by the evidence you are given. When something a good report needs is missing from the evidence, write a short bracketed placeholder for the teacher to fill in, for example "[a moment from class that shows this]", "[name of the novel we read]" or "[a goal for next term]". Placeholders are expected and good; a confident invented detail is the worst possible error.
- Keep each placeholder under about 12 words, with no "such as…" lists of options.
- Put each placeholder inside a sentence written to the parent, so the sentence reads naturally once the teacher fills it in. Never write about the evidence, the draft, or what is missing (no "this would round out the picture", no "we don't yet have…").
- Use square brackets only for placeholders.

If the evidence is thin, write a shorter draft and lean on placeholders rather than padding with generalities. Numbers (skill counts, grade levels) may be used only as they appear in the evidence, rounded naturally ("about twenty"). Give a grade level as a whole grade, exactly as the evidence words it ("working at a sixth-grade level"), never a decimal like "grade 6.9" and never rounded up. Say how far into the grade's skills the child is, as the evidence words it.

## The scholar's other reports
When the request includes reports already drafted for this child this term, read them first. Don't retell a story, quote or example another report already uses; choose a different one, or refer back to it in a few words.

## Example of the right length, tone, and specificity (a math report)
${EXAMPLE_REPORT}

## SEL reports
An SEL report is about the child as a learner and a person: habits of mind, independence, self-regulation, friendships, collaboration, and community. Lead with those. The subject reports already describe academic work (they are included in the request when drafted), so an academic moment may illustrate a habit in one short clause, but do not retell it in detail.

Output only the report text.`;
}

/** Another report already drafted for the same scholar and term. */
export type SiblingReport = { subject: string; body: string };

/** One unit's verified reading notes (`parentReportReading`). */
export type UnitReading = { unitTitle: string; notes: UnitReadingNote[] };

export function buildParentReportUserPrompt(
  e: ParentReportEvidence,
  otherReports: SiblingReport[] = [],
  readings: UnitReading[] = [],
): string {
  const lines: string[] = [];
  const topic = e.isSel
    ? "a social-emotional learning (SEL) report: how the child is growing as a learner and a person, including habits of mind, independence, self-regulation, friendships, collaboration, and community"
    : `a ${e.subject} report`;
  lines.push(`Draft ${topic} for ${e.scholarFirstName} ${scholarNamePronounHint(e.pronouns)}.`);
  lines.push(
    `Term: ${e.periodLabel} (${e.periodStart} to ${e.periodEnd}).${e.gradeLevel ? ` ${e.scholarFirstName} is in grade ${e.gradeLevel}.` : ""}`,
  );
  lines.push("");
  lines.push("## Goals the family shared");
  if (e.familyGoals.length === 0) lines.push("(none recorded — do not mention family goals)");
  else for (const g of e.familyGoals) lines.push(`- ${g}`);
  const readingLines = readings.flatMap((r) => formatUnitNotes(r.unitTitle, r.notes));
  let readingPlaced = readingLines.length === 0;
  const pushReadings = () => {
    lines.push("");
    lines.push(`## Read from ${e.scholarFirstName}'s own turns in each unit (dated; quotes are the child's exact words)`);
    lines.push(...readingLines);
    readingPlaced = true;
  };
  for (const group of e.groups) {
    lines.push("");
    lines.push(`## ${group.label}`);
    if (group.items.length === 0) lines.push("(none recorded)");
    else for (const item of group.items) lines.push(`- ${item}`);
    // Right after the units they were read from.
    if (group.key === "units" && !readingPlaced) pushReadings();
  }
  if (!readingPlaced) pushReadings();
  if (otherReports.length > 0) {
    lines.push("");
    lines.push(`## ${e.scholarFirstName}'s other reports this term (don't repeat their stories)`);
    for (const r of otherReports) {
      lines.push("");
      lines.push(`### ${r.subject}`);
      lines.push(r.body.trim());
    }
  }
  lines.push("");
  lines.push("## Before you write");
  if (e.isSel)
    lines.push(
      "- This is the SEL report. Lead with habits, independence, relationships and self-regulation. The subject reports already tell the academic stories, so mention an academic moment in one short clause at most.",
    );
  lines.push(
    "- Stay under 240 words.",
    "- Every placeholder sits inside a sentence addressed to the parent and reads naturally once filled in. Never write a sentence about the evidence, the draft, or what is missing.",
    "- Build paragraph 1 around one thread shown at two or more dated moments; with none, use the strongest single example and say less.",
    "- Name a pattern only when at least two dated items show it, never from one.",
  );
  lines.push("");
  lines.push(
    "Write the draft now. Use only the evidence above; put a bracketed placeholder wherever the teacher needs to add something the evidence does not show.",
  );
  return lines.join("\n");
}

/** Strip model framing the prompt asks it not to produce (a heading line, wrapping quotes). */
export function cleanDraft(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^#+ .*\n+/, "");
  if (text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1).trim();
  return text;
}

// ── Evidence selection ──────────────────────────────────────────────────

/** One candidate evidence line, before selection. */
export type EvidenceCandidate = {
  text: string;
  /** When it happened (ms). Newer evidence is preferred. */
  at: number;
  /** Lines with the same key are repeats of one thing; only the newest is kept. */
  key?: string;
  /** Lines are taken round-robin across buckets, so one kind can't fill the list. */
  bucket?: string;
  /** What the line's date reads as, when the short date of `at` would mislead
   *  (a weekly summary: "week of Nov 3"). */
  when?: string;
};

/**
 * Choose which lines of a group the drafter sees: newest first, one per
 * repeated thing, spread across buckets. A term's record runs to hundreds of
 * lines per group, and taking the first N in date order showed the drafter
 * only the term's opening weeks.
 */
export function pickEvidence(candidates: EvidenceCandidate[], max: number): string[] {
  return pickEvidenceCandidates(candidates, max).map((c) => c.text);
}

/** `pickEvidence`, keeping each chosen candidate whole (with its date). */
export function pickEvidenceCandidates(candidates: EvidenceCandidate[], max: number): EvidenceCandidate[] {
  const newest = [...candidates].sort((a, b) => b.at - a.at);
  const seen = new Set<string>();
  const unique = newest.filter((c) => {
    const k = (c.key ?? c.text).trim().toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const buckets = new Map<string, EvidenceCandidate[]>();
  for (const c of unique) {
    const b = c.bucket ?? "";
    const list = buckets.get(b) ?? [];
    list.push(c);
    buckets.set(b, list);
  }
  const lists = [...buckets.values()];
  const out: EvidenceCandidate[] = [];
  for (let i = 0; out.length < max; i++) {
    let took = false;
    for (const list of lists) {
      if (i < list.length && out.length < max) {
        out.push(list[i]);
        took = true;
      }
    }
    if (!took) break;
  }
  return out;
}

/** "Nov 13" (UTC): the short date evidence lines end with. */
export function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * One candidate as the drafter reads it: the text on one line, clipped to fit,
 * then its date in parentheses at the END, so clipping never cuts the date and
 * a "(piece N) " prefix stays first.
 */
export function datedEvidenceLine(c: EvidenceCandidate, max: number): string {
  const suffix = ` (${c.when ?? shortDate(c.at)})`;
  const room = Math.max(1, max - suffix.length);
  const t = c.text.replace(/\s+/g, " ").trim();
  return `${t.length > room ? `${t.slice(0, room - 1)}…` : t}${suffix}`;
}

// ── Draft check ─────────────────────────────────────────────────────────

export const MAX_REPORT_WORDS = 240;

const SHE_FORMS = /\b(she|her|hers|herself)\b/i;
const HE_FORMS = /\b(he|him|his|himself)\b/i;

/**
 * A gendered pronoun the profile doesn't give, or null. With no pronouns
 * recorded, any he/she form is one. Stories' characters can trip this
 * outside quotes; the cost is one revision call.
 */
function pronounProblem(prose: string, pronouns: string | null): string | null {
  const given = (normalizePronouns(pronouns) ?? "").toLowerCase();
  const mayShe = /\b(she|her)\b/.test(given);
  const mayHe = /\b(he|him)\b/.test(given);
  if ((!mayShe && SHE_FORMS.test(prose)) || (!mayHe && HE_FORMS.test(prose)))
    return given
      ? `Uses pronouns other than the child's (${given}). Use those, or the child's name.`
      : "Uses he/she pronouns. Use the child's name or they/them.";
  return null;
}

const DRAFT_RULES: { pattern: RegExp; problem: string }[] = [
  {
    pattern: /\(?\bpieces? \d+\)?/i,
    problem: "Writes a piece number in the report. The family opens the piece from under the report; describe the work in words.",
  },
  {
    pattern: /\b(grew|grown|grows|become|became|becoming)\s+(into\s+)?(an?\s+)?(more|increasingly)\b/i,
    problem: 'Claims a change ("grew into a more …") without a before. Describe what the child does instead.',
  },
  {
    pattern: /\b(we|I)(['’](re|m)|\s+are|\s+am)?\s+(so\s+|all\s+)?(can['’]?t wait|cannot wait|excited to (see|watch|read|follow)|looking forward to (seeing|watching|reading))|\ba joy to have\b/i,
    problem: "Ends on a stock line that could fit any child. Cut it, or end on the concrete plan.",
  },
  { pattern: /\bgrade[- ]\d+\.\d|\b\d+\.\d+\s*-?\s*grade\b/i, problem: 'Gives a decimal grade level (like "grade 6.9"). Use a whole grade.' },
  {
    pattern:
      /\b(\d+(\.\d+)?\s*(x|×|times)|twice|double|triple)\s+(as\s+fast\s+as\s+)?(the\s+)?(expected|standard|usual|normal|typical)?\s*(pace|rate|speed)\b|\b\d+(\.\d+)?\s*(x|×|times)\s+(faster|quicker)\b|\b(twice|(two|three|four|\d+(\.\d+)?)\s*(x|×|times))\s+as\s+(fast|quickly|quick)\b|\b\d+(\.\d+)?\s*(%|percent)\s+of\s+(the\s+)?(expected|standard|usual|normal|typical)\s+(pace|rate|speed)\b/i,
    problem: 'Gives a pace as a multiplier or percentage (like "2x the expected pace"). Say it in months, as the evidence words it.',
  },
  {
    pattern: /\b(PCM|Bloom'?s|granules?|mastery observations?|dossier|rubric|on-platform|metacognit\w*)\b/i,
    problem: "Uses internal or education jargon. Name the skill or moment instead.",
  },
  { pattern: /\btutor(s|ing|ed)?\b/i, problem: 'Calls Rabbithole a tutor. Say "Rabbithole", or "the AI".' },
  {
    pattern: /\bRabbithole,\s+(the|our|the school's)\s+(AI|learning)/i,
    problem: 'Explains what Rabbithole is. Parents know it; just say "Rabbithole".',
  },
  {
    pattern: /\b((the|this|our) (evidence|records?) (shows?|suggests?|doesn't|does not|don't|is|are)|would (help )?round out|we don't (yet )?have)\b/i,
    problem: "Writes about the evidence or what is missing instead of to the parent.",
  },
];

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Rule breaks a code check can see in a draft. Empty means it passed. The
 * prompt already states each rule; this catches the drafts that drift.
 */
export function checkDraft(text: string, pronouns: string | null = null): string[] {
  const problems: string[] = [];
  const words = wordCount(text);
  if (words > MAX_REPORT_WORDS) problems.push(`It is ${words} words. Cut it to ${MAX_REPORT_WORDS} or fewer.`);
  // Placeholders are the teacher's to fill, and quoted words (a book title,
  // a character's line) aren't the report's own, so neither is checked.
  const prose = text.replace(/\[[^\]\n]+\]/g, "").replace(/["“][^"”\n]*["”]/g, "");
  const pronoun = pronounProblem(prose, pronouns);
  if (pronoun) problems.push(pronoun);
  for (const rule of DRAFT_RULES) if (rule.pattern.test(prose)) problems.push(rule.problem);
  return problems;
}

/** The follow-up turn asking the model to fix what the check found. */
export function buildRevisionRequest(problems: string[]): string {
  return [
    "Revise the draft to fix these problems, changing nothing else:",
    ...problems.map((p) => `- ${p}`),
    "",
    "Output only the revised report text, then the Pieces line as before.",
  ].join("\n");
}

/**
 * Split the drafter's reply into the report and the pieces it describes: the
 * last line "Pieces: 2, 5" (or "Pieces: none") names them by evidence number.
 * Numbers the evidence didn't offer are dropped.
 */
export function splitDraftPieces(
  raw: string,
  offered: { ref: number; id: string }[],
): { text: string; pieceIds: string[]; found: boolean } {
  const lines = raw.trimEnd().split("\n");
  let pieceIds: string[] = [];
  // The last Pieces line wins; anything after it is chatter, not report.
  let at = -1;
  let m: RegExpExecArray | null = null;
  for (let i = lines.length - 1; i >= 0 && !m; i--) {
    m = /^\s*\**pieces\**\s*:\**\s*(.*)$/i.exec(lines[i]);
    if (m) at = i;
  }
  if (m) {
    lines.length = at;
    const byRef = new Map(offered.map((p) => [p.ref, p.id]));
    const refs = [...m[1].matchAll(/\d+/g)].map((x) => Number(x[0]));
    pieceIds = [...new Set(refs.map((r) => byRef.get(r)).filter((id): id is string => id !== undefined))];
  }
  return { text: lines.join("\n").trimEnd(), pieceIds, found: m !== null };
}

const GRADE_ORDINALS = ["kindergarten", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth"];

/**
 * A grade-equivalent value ("G.m": grade G, m tenths of the way through its
 * skills; see `mathLevel`) worded as the whole grade the child is
 * working in. Always the floor: 6.9 is sixth-grade work nearly complete, and a
 * drafter handed the bare decimal rounds it up to seventh.
 */
export function wholeGradeLevel(value: number): string {
  const whole = Math.max(0, Math.floor(value + 1e-9));
  const name = GRADE_ORDINALS[whole];
  if (name === undefined) return `grade-${whole} level`;
  return whole === 0 ? "kindergarten level" : `${name}-grade level`;
}

// ── Overall math position and pace (evidence wording) ───────────────────
// The drafter gets these as plain sentences it can lift. The overall level is
// never printed as a decimal: the drafter would repeat it, and a parent reads
// "6.7" as a precise score it is not.

/** A grade rank in words: "kindergarten", "third grade". */
export function gradeInWords(rank: number): string {
  if (rank < 0) return "pre-kindergarten";
  if (rank === 0) return "kindergarten";
  const name = GRADE_ORDINALS[rank];
  return name === undefined ? `grade ${rank}` : `${name} grade`;
}

/** A grade as an adjective before a noun: "kindergarten", "seventh-grade". */
export function gradeAdjective(rank: number): string {
  if (rank <= 0) return "kindergarten";
  const name = GRADE_ORDINALS[rank];
  return name === undefined ? `grade-${rank}` : `${name}-grade`;
}

/** The phrase with "a" or "an" in front: "an eighth-grade level",
 *  "a seventh-grade skill". Of the grade words, only eighth and eleventh start
 *  with a vowel sound. */
export function withArticle(phrase: string): string {
  return `${/^(eighth|eleventh)\b/i.test(phrase) ? "an" : "a"} ${phrase}`;
}

/**
 * Where the child stands across all of math against the enrolled grade, or
 * null when the grade or the level is unknown. It uses the teacher skills
 * matrix's bands against the grade equivalent (enrolled grade plus school
 * month) at `asOfMs`, the end of the report's window: ahead and far ahead both
 * read "above grade level", on pace reads "at grade level". "Behind" is never
 * asserted: the record can't yet tell a real gap from a skill map still being
 * filled in, so the line hands that sentence to the teacher as a placeholder.
 *
 * The solid-through grade is named only when it reaches the grade below the
 * enrolled one. Lower than that, "at grade level, solid through third grade"
 * reads as a contradiction to a parent, so the line says where the open skills
 * start instead.
 */
export function overallMathPositionLine(
  level: MathLevel | null,
  enrolledRank: number | null,
  asOfMs: number,
): string | null {
  if (!level || enrolledRank === null) return null;
  const gradeEquivalent = gradeEquivalentFromRank(enrolledRank, new Date(asOfMs));
  if (gradeEquivalent === null) return null;
  const enrolled = gradeAdjective(enrolledRank);
  const band = gradeRelativeBand(levelDelta(level.value, gradeEquivalent));
  if (band === "behind") {
    return `Across all math areas together: the record can't say yet how this compares with ${enrolled} math. Write "[how this child's math compares with ${enrolled} expectations]" for the teacher to fill in.`;
  }
  const solid = level.solidThroughRank;
  const depth =
    solid !== null && solid >= enrolledRank - 1
      ? `Solid through ${gradeInWords(solid)}.`
      : `Some ${gradeAdjective(solid === null ? 0 : solid + 1)} skills are still open.`;
  return `Across all math areas together: ${band === "onPace" ? "at" : "above"} grade level for ${gradeInWords(enrolledRank)}, the child's grade this year. ${depth}`;
}

/** The share of credited skills from daily practice at or above which the
 *  picture reads "mostly from daily practice", and below which (from the other
 *  side) "mostly from the placement check-in". Between the two it reads
 *  "about half from each": 35% to 65%. */
export const SOURCE_SPLIT_MOSTLY = 0.65;
/** When one source gives under this share of the credited skills, the picture
 *  reads "almost all" from the other: 5 skills from daily practice against 172
 *  from the placement check-in is far from "a smaller part". */
export const SOURCE_SPLIT_ALMOST_ALL_MINORITY = 0.1;

const countSkills = (n: number) => `${n} skill${n === 1 ? "" : "s"}`;

/** The source split in words a parent could hear: "mostly from daily practice". */
export function sourceSplitPhrase(dailySkills: number, placementSkills: number): string | null {
  const total = dailySkills + placementSkills;
  if (total === 0) return null;
  if (placementSkills === 0) return "all from daily practice";
  if (dailySkills === 0) return "all from the placement check-in";
  const daily = dailySkills / total;
  if (placementSkills / total < SOURCE_SPLIT_ALMOST_ALL_MINORITY) return "almost all from daily practice";
  if (daily < SOURCE_SPLIT_ALMOST_ALL_MINORITY) return "almost all from the placement check-in";
  if (daily > SOURCE_SPLIT_MOSTLY) return "mostly from daily practice";
  if (daily < 1 - SOURCE_SPLIT_MOSTLY) return "mostly from the placement check-in";
  return "about half from daily practice and half from the placement check-in";
}

/** How many credited math skills came from daily work and how many from the
 *  placement check-in, led by the split in words, or null when nothing is
 *  credited. */
export function overallMathSourceLine(level: MathLevel | null): string | null {
  if (!level) return null;
  const phrase = sourceSplitPhrase(level.dailySkills, level.placementSkills);
  if (phrase === null) return null;
  const daily = `${countSkills(level.dailySkills)} observed in daily practice work`;
  const placement = `${countSkills(level.placementSkills)} credited from the placement check-in`;
  const counts =
    level.placementSkills === 0 ? daily : level.dailySkills === 0 ? placement : `${daily}, ${placement}`;
  return `Where this picture comes from: ${phrase} (${counts}).`;
}

// The fluent-skill floor lives in shared/ so the parent Math page gates its
// pace tile on the same number.
export { MIN_FLUENT_SKILLS_FOR_PACE };
/** A deliberate plus-or-minus-a-quarter band around the standard pace of one
 *  month of curriculum per month of school: at or above FAST reads as faster,
 *  below SLOW as slower, anything between as about the expected pace. */
export const FAST_PACE = 1.25;
export const SLOW_PACE = 0.75;

/** Months rounded to the nearest half, in words a parent would say. */
export function monthsInWords(months: number): string {
  const half = Math.round(months * 2) / 2;
  if (half < 0.5) return "less than half a month";
  if (half === 0.5) return "about half a month";
  if (half === 1) return "about 1 month";
  const whole = Math.floor(half);
  return half === whole ? `about ${whole} months` : `about ${whole} and a half months`;
}

/**
 * The pace line for the report's term: new learning against the standard
 * curriculum's clock, plus what the child already knew and showed. Under the
 * fluent-skill floor the line states the low practice as a fact the drafter
 * must pass on, since leaving it out would let a thin term read like a full one.
 */
export function mathPaceLines(pace: LearnedPace | null, joinedOn: string | null = null): string[] {
  return [...joinedLines(joinedOn), ...termPaceLines(pace)];
}

/** A child who joined partway through the term is measured from that day. */
function joinedLines(joinedOn: string | null): string[] {
  return joinedOn
    ? [`Joined: the child joined on ${joinedOn}, partway through the term. Everything about practice and pace below covers only the time since then.`]
    : [];
}

function termPaceLines(pace: LearnedPace | null): string[] {
  const fluent = pace === null ? 0 : pace.learnedSkills + pace.knownSkills;
  if (pace === null || !hasEnoughFluentSkillsForPace(pace)) {
    return [
      `Pace: ${countSkills(fluent)} reached fluency in daily practice this term, too few to state a pace. Say nothing about pace, and nothing about how much the child practised: few new fluent skills can also mean the child spent the term reviewing skills already known.`,
    ];
  }
  if (pace.pace === null) {
    return ["Pace: too little of the term has passed to state a pace. Say nothing about pace."];
  }
  const category =
    pace.pace >= FAST_PACE
      ? "faster than the expected pace"
      : pace.pace < SLOW_PACE
        ? "slower than the expected pace"
        : "about the expected pace";
  const lines = [
    `Pace: ${monthsInWords(pace.learnedMonths)} of new math learned in ${monthsInWords(pace.schoolMonths)} of school, ${category} of one month of curriculum per month of school.`,
  ];
  if (Math.round(pace.knownMonths * 2) / 2 >= 0.5) {
    lines.push(
      `Already known: ${monthsInWords(pace.knownMonths)} of curriculum were skills the child already knew and has now shown this term. These are not new learning.`,
    );
  }
  return lines;
}

/** Every line of the overall math group, in the order the drafter reads them. */
export function overallMathEvidence(
  level: MathLevel | null,
  enrolledRank: number | null,
  asOfMs: number,
  pace: LearnedPace | null,
  /** The day the child joined (YYYY-MM-DD), when after the term began. */
  joinedOn: string | null = null,
): string[] {
  // The Joined line stands on its own: a joiner with nothing credited yet
  // still gets it.
  if (!level) return joinedLines(joinedOn);
  return [overallMathPositionLine(level, enrolledRank, asOfMs), overallMathSourceLine(level), ...mathPaceLines(pace, joinedOn)].filter(
    (l): l is string => l !== null,
  );
}

// ── Each math area's level, and the term's practice (evidence wording) ──
// One line per area the drafter can lift, under one summary line it can use
// when there are too many areas to name. Levels are whole grades only: the
// evidence never shows the drafter a decimal, so it has none to repeat.

/**
 * How far into a grade's skills a level reaches, in five steps. `below` is the
 * upper edge of each step's share of the grade (the level's part after the
 * whole grade), so a level of exactly N.0 is "just starting on" grade N. The
 * steps sit midway between the quarter marks a parent would say.
 */
export const WITHIN_GRADE_STEPS: readonly { below: number; words: string }[] = [
  { below: 0.125, words: "just starting on" },
  { below: 0.375, words: "about a quarter of the way through" },
  { below: 0.625, words: "about halfway through" },
  { below: 0.875, words: "most of the way through" },
  { below: Infinity, words: "through nearly all of" },
];

/** The words for a share (0–1) of one grade's skills, to be followed by
 *  "that grade's skills": "about halfway through". */
export function progressIntoGrade(share: number): string {
  return WITHIN_GRADE_STEPS.find((s) => Math.max(0, share) < s.below)!.words;
}

/**
 * Where an area's coverage stands, read from its grade bands (never from the
 * level's decimal, which is a SUM of shares across grades and says nothing
 * about any one grade). `open` is the first grade not fully covered and its
 * own share. When no grade above it carries credit, the level's whole grade is
 * that grade and its share is how far in (`gapped: false`). Otherwise credit
 * sits above an unfinished grade, and wording the level's decimal as progress
 * through one grade would credit the wrong grade (`gapped: true`), so the line
 * says what is complete, the open grade's share, and the highest grade with
 * credit. Null when every grade is covered.
 */
export function gradeStanding(bands: readonly MathLevelBand[]): {
  open: { rank: number; share: number };
  /** The last complete grade below the open one, or null when none is. */
  completeThroughRank: number | null;
  gapped: boolean;
  topCreditedRank: number;
} | null {
  const i = bands.findIndex((b) => b.daily + b.placement < b.total);
  if (i < 0) return null;
  const open = bands[i];
  const credited = bands.filter((b) => b.daily + b.placement > 0);
  const topCreditedRank = credited.length > 0 ? credited[credited.length - 1].rank : open.rank;
  return {
    open: { rank: open.rank, share: (open.daily + open.placement) / open.total },
    completeThroughRank: i > 0 ? bands[i - 1].rank : null,
    gapped: topCreditedRank > open.rank,
    topCreditedRank,
  };
}

/** How much of one grade's skills a share is: "most of". */
const SHARE_OF_GRADE_STEPS: readonly { below: number; words: string }[] = [
  { below: 0.125, words: "a few of" },
  { below: 0.375, words: "about a quarter of" },
  { below: 0.625, words: "about half of" },
  { below: 0.875, words: "most of" },
  { below: Infinity, words: "nearly all of" },
];

/** The gapped standing in words, after "covers": "every skill through fourth
 *  grade, most of fifth grade's skills, and some skills in higher grades up to
 *  seventh grade". */
function gappedStandingWords(standing: NonNullable<ReturnType<typeof gradeStanding>>): string {
  const open = standing.open;
  const openWords = `${
    open.share === 0 ? "none of" : SHARE_OF_GRADE_STEPS.find((s) => open.share < s.below)!.words
  } ${gradeInWords(open.rank)}'s skills`;
  return [
    standing.completeThroughRank !== null ? `every skill through ${gradeInWords(standing.completeThroughRank)}` : null,
    openWords,
    `and some skills in higher grades up to ${gradeInWords(standing.topCreditedRank)}`,
  ]
    .filter((p): p is string => p !== null)
    .join(", ");
}

export interface AreaLevelInput {
  /** The area's name: "Fractions". */
  label: string;
  /** The area's level (`mathLevel`), placement credit included. */
  levelValue: number;
  /** The legacy highest grade with a skill shown in daily practice, or null. */
  highestValue: number | null;
  /** Skills shown fluent in daily practice. */
  dailySkills: number;
  /** Skills credited by the placement check-in and not yet shown in daily practice. */
  placementSkills: number;
  /** Skills that turned fluent in the report's window and were new to the
   *  child (`isLearnedSkill`). */
  learnedThisTerm: number;
  /** Skills that turned fluent in the report's window that the child already knew. */
  knownThisTerm: number;
  /** The highest grade rank in the area's catalog, or null when unknown. A
   *  level at or above one past it means every skill the area has is covered. */
  topCatalogRank: number | null;
  /** The level's grade bands (`MathLevel.bands`): where any within-grade
   *  wording comes from (see {@link gradeStanding}). */
  bands: readonly MathLevelBand[];
}

/** Whether the area's level covers every skill in its catalog. */
export function areaFinished(input: AreaLevelInput): boolean {
  return input.topCatalogRank !== null && input.levelValue + 1e-9 >= input.topCatalogRank + 1;
}

/** The area's whole grade for the summary range: a finished area counts at its
 *  top catalog grade, since one past it is a grade the area has no skills in. */
export function areaWholeGrade(input: AreaLevelInput): number {
  return areaFinished(input) ? input.topCatalogRank! : Math.max(0, Math.floor(input.levelValue + 1e-9));
}

/** "Has also shown a seventh-grade skill.", only when the highest whole grade
 *  is above the level's whole grade; otherwise null. */
export function areaHighestClause(levelValue: number, highestValue: number | null): string | null {
  if (highestValue === null) return null;
  const highest = Math.floor(highestValue + 1e-9);
  if (highest <= Math.floor(levelValue + 1e-9)) return null;
  return `Has also shown ${withArticle(gradeAdjective(highest))} skill in daily practice.`;
}

/** Where the area's skills come from: daily practice, the placement check-in, or both. */
export function areaSourcesClause(dailySkills: number, placementSkills: number): string | null {
  if (dailySkills === 0 && placementSkills === 0) return null;
  if (placementSkills === 0) return `${countSkills(dailySkills)} shown in daily practice.`;
  if (dailySkills === 0) return `${countSkills(placementSkills)} credited from the placement check-in.`;
  return `${countSkills(dailySkills)} shown in daily practice and ${placementSkills} credited from the placement check-in.`;
}

/** The area's movement in the report's window, split into new learning and
 *  skills the child already knew. */
export function areaTermClause(learned: number, known: number): string {
  if (learned === 0 && known === 0) return "This term: no skills in this area turned fluent.";
  const learnedPart = `${countSkills(learned)} new to the child this term reached fluency`;
  if (known === 0) return `This term: ${learnedPart}.`;
  if (learned === 0)
    return `This term: ${countSkills(known)} reached fluency, all skills the child already knew and has now shown. None were new learning.`;
  return `This term: ${learnedPart}, along with ${countSkills(known)} the child already knew and has now shown.`;
}

/** The area's name inside a sentence: "fractions", "algebra 1". */
function areaNoun(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}

/**
 * One area's level line. A finished area says it has covered every skill the
 * area has; an area with only placement credit says so plainly; any other
 * gives the whole grade, how far into it, the higher reach when there is one,
 * both sources, and this term's new and already-known skills.
 */
export function areaLevelLine(input: AreaLevelInput): string {
  const term = areaTermClause(input.learnedThisTerm, input.knownThisTerm);
  if (areaFinished(input)) {
    return [
      `${input.label}: has covered every ${areaNoun(input.label)} skill through ${gradeInWords(input.topCatalogRank!)}.`,
      areaSourcesClause(input.dailySkills, input.placementSkills),
      input.dailySkills === 0 ? "No skills shown in daily practice in this area yet." : term,
    ]
      .filter((c): c is string => c !== null)
      .join(" ");
  }
  const standing = gradeStanding(input.bands);
  if (standing?.gapped) {
    // Credit above an unfinished grade: say what is true grade by grade.
    const where = gappedStandingWords(standing);
    if (input.dailySkills === 0) {
      return `${input.label}: the placement check-in credited ${countSkills(input.placementSkills)}, which cover ${where}. No skills shown in daily practice in this area yet.`;
    }
    return [
      `${input.label}: covers ${where}.`,
      areaSourcesClause(input.dailySkills, input.placementSkills),
      term,
    ]
      .filter((c): c is string => c !== null)
      .join(" ");
  }
  const grade = wholeGradeLevel(input.levelValue);
  const progress = `${progressIntoGrade(standing ? standing.open.share : 0)} that grade's skills here`;
  if (input.dailySkills === 0) {
    return `${input.label}: placed at ${withArticle(grade)} by the placement check-in (${countSkills(input.placementSkills)} credited), ${progress}. No skills shown in daily practice in this area yet.`;
  }
  return [
    `${input.label}: working at ${withArticle(grade)}, ${progress}.`,
    areaHighestClause(input.levelValue, input.highestValue),
    areaSourcesClause(input.dailySkills, input.placementSkills),
    term,
  ]
    .filter((c): c is string => c !== null)
    .join(" ");
}

/** Areas the summary names as having the most new learning. */
export const MAX_AREAS_MOST_LEARNING = 2;

/** "A and B", "A, B and C". */
function joinNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** "fourth-grade level", the area's whole grade as the summary words it. */
function areaGradeLevel(input: AreaLevelInput): string {
  return `${gradeAdjective(areaWholeGrade(input))} level`;
}

/**
 * The one line above the per-area lines: the whole-grade levels of the areas
 * with daily practice (a range when there are several), the areas with the
 * most new learning this term (only when any skill was new), and the areas
 * that rest on the placement check-in alone, each with its level. The range
 * leaves out placement-only areas so its ends always rest on daily practice.
 * Null when there are no areas. `areas` is in curriculum order, which breaks
 * ties in new learning.
 */
export function areaSummaryLine(areas: readonly AreaLevelInput[]): string | null {
  if (areas.length === 0) return null;
  const practised = areas.filter((a) => a.dailySkills > 0);
  const placementOnly = areas.filter((a) => a.dailySkills === 0);
  const parts: string[] = [];
  if (practised.length === 0) {
    parts.push("No area has daily practice yet; every level below comes from the placement check-in.");
  } else if (practised.length === 1) {
    const level = withArticle(areaGradeLevel(practised[0]));
    parts.push(
      areas.length === 1
        ? `The one area is at ${level}.`
        : `${practised[0].label}, the one area with daily practice, is at ${level}.`,
    );
  } else {
    const grades = practised.map(areaWholeGrade);
    const low = Math.min(...grades);
    const high = Math.max(...grades);
    const which = placementOnly.length === 0 ? "areas" : "areas with daily practice";
    if (low === high) {
      parts.push(`All ${practised.length} ${which} are at ${withArticle(`${gradeAdjective(low)} level`)}.`);
    } else {
      const subject = placementOnly.length === 0 ? "Areas" : "Areas with daily practice";
      parts.push(`${subject} range from ${gradeAdjective(low)} to ${gradeAdjective(high)} level.`);
    }
  }
  const most = areas
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => a.learnedThisTerm > 0)
    .sort((x, y) => y.a.learnedThisTerm - x.a.learnedThisTerm || x.i - y.i)
    .slice(0, MAX_AREAS_MOST_LEARNING)
    .map(({ a }) => `${a.label} (${countSkills(a.learnedThisTerm)} new)`);
  if (most.length > 0) parts.push(`Most new learning this term: ${joinNames(most)}.`);
  if (placementOnly.length > 0) {
    const named = placementOnly.map((a) => `${a.label} (${areaGradeLevel(a)})`);
    parts.push(`Resting on the placement check-in alone, with no daily practice yet: ${joinNames(named)}.`);
  }
  return `Summary of ${countAreas(areas.length)}: ${parts.join(" ")}`;
}

const countAreas = (n: number) => `${n} area${n === 1 ? "" : "s"}`;

/** The summary line, then one line per area, in the order given. */
export function areaLevelEvidence(areas: readonly AreaLevelInput[]): string[] {
  const summary = areaSummaryLine(areas);
  return summary === null ? [] : [summary, ...areas.map(areaLevelLine)];
}

/** The term's fluent-skill count, split into new learning and skills the
 *  child already knew; null when nothing turned fluent. */
export function termFluencyLine(learned: number, known: number): string | null {
  const total = learned + known;
  if (total === 0) return null;
  const head = `${countSkills(total)} reached fluency in daily practice this term`;
  if (known === 0) return `${head}, all new to the child this term.`;
  if (learned === 0) return `${head}, all skills the child already knew and has now shown. None were new learning.`;
  return `${head}: ${learned} new to the child this term and ${known} the child already knew and has now shown.`;
}

/** One skill in the term's fluent list, marked new or already known. */
export function fluentSkillItem(label: string, grade: string | null | undefined, learned: boolean, when: string): string {
  return `${label}${grade ? ` (grade ${grade} skill)` : ""}: ${learned ? "new to the child this term" : "already known, now shown"}, fluent ${when}`;
}
