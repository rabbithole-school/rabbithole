import { minuteOfDayForTimezone } from "./institutionDay";

export type ScholarHomeRow = {
  origin: "classFocus" | "homework" | "is";
  subject: string | null;
  // The session holds an app the scholar built (a `type: "code"` artifact —
  // the same test the teacher archive uses). Such a row also shows on Apps.
  isApp?: boolean;
  /** When an open-until row's window closes (shared/openUntil.ts), else
   *  null. Optional for an older backend's rows (deploy skew). */
  openUntil?: number | null;
};

/**
 * Whether a row is on the scholar's list right now: homework (the Homework
 * section), or open-until work whose window hasn't closed (the Open from
 * class section, TRA-724; shared/homeworkList.ts splits the two). Open-until
 * is stored as class focus, so after it closes a started row falls back to
 * class work ("Pick up where you left off") and an unstarted one is gone.
 */
export function onYourList(row: ScholarHomeRow, nowMs: number): boolean {
  return (
    row.origin === "homework" ||
    (row.origin === "classFocus" && row.openUntil != null && row.openUntil > nowMs)
  );
}

export type ScholarHomeTab = {
  key: string;
  label: string;
};

type UnitBearingHomeRow = {
  unitId: string | null;
  assignmentId?: string | null;
};

export type HomeUnitGroup<T extends UnitBearingHomeRow> = {
  key: string;
  unitId: string | null;
  assignmentId: string | null | undefined;
  rows: T[];
};

/**
 * Collapses a Home row stream into one group per unit + assignment while
 * leaving anchorless work as standalone rows. Group order follows first
 * appearance, and row order inside each group is unchanged.
 */
export function groupHomeRowsByUnit<T extends UnitBearingHomeRow>(
  rows: T[],
): Array<HomeUnitGroup<T>> {
  const groups: Array<HomeUnitGroup<T>> = [];
  const groupedIndex = new Map<string, number>();

  rows.forEach((row, index) => {
    if (row.unitId === null) {
      groups.push({
        key: `anchorless:${index}`,
        unitId: row.unitId,
        assignmentId: row.assignmentId,
        rows: [row],
      });
      return;
    }

    const key = `unit:${row.unitId}:assignment:${row.assignmentId ?? ""}`;
    const existingIndex = groupedIndex.get(key);
    if (existingIndex !== undefined) {
      groups[existingIndex].rows.push(row);
      return;
    }

    groupedIndex.set(key, groups.length);
    groups.push({
      key,
      unitId: row.unitId,
      assignmentId: row.assignmentId,
      rows: [row],
    });
  });

  return groups;
}

const ASSIGNED_ORIGINS = new Set<ScholarHomeRow["origin"]>([
  "classFocus",
  "homework",
]);

function foldedSubject(subject: string | null | undefined): string | null {
  const trimmed = subject?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

const MATH_TAB: ScholarHomeTab = { key: "subject:math", label: "Math" };
const PREP_TAB: ScholarHomeTab = { key: "prep", label: "Scholar’s Prep" };
const MATH_SUBJECTS = new Set(["math", "mathematics", "math workshop"]);

function subjectTabKey(subject: string): string {
  const folded = foldedSubject(subject);
  if (folded && MATH_SUBJECTS.has(folded)) return MATH_TAB.key;
  return `subject:${folded ?? ""}`;
}

function subjectTab(subject: string): ScholarHomeTab {
  const key = subjectTabKey(subject);
  return key === MATH_TAB.key ? MATH_TAB : { key, label: subject };
}

export function deriveHomeTabs({
  subjectTabs,
  rows,
  hasApps = false,
}: {
  subjectTabs: string[];
  rows: ScholarHomeRow[];
  hasApps?: boolean;
}): { tabs: ScholarHomeTab[]; hasOther: boolean } {
  const assignedRows = rows.filter((row) => ASSIGNED_ORIGINS.has(row.origin));
  const assignedSubjects = new Set(
    assignedRows
      .map((row) => row.subject)
      .filter((subject): subject is string => foldedSubject(subject) !== null)
      .map(subjectTabKey),
  );
  const presentTabs = subjectTabs
    .filter((subject) => assignedSubjects.has(subjectTabKey(subject)))
    .map(subjectTab)
    .filter(
      (tab, index, all) =>
        all.findIndex((candidate) => candidate.key === tab.key) === index,
    );
  const hasOther = assignedRows.some(
    (row) => foldedSubject(row.subject) === null,
  );
  // No "All" tab: Now's "Pick up where you left off" lists the open class
  // work it used to hold, and each subject tab holds its own slice.
  const tabs: ScholarHomeTab[] = [{ key: "now", label: "Now" }];

  if (presentTabs.length >= 2) {
    tabs.push(...presentTabs);
  }
  if (!tabs.some((tab) => tab.key === MATH_TAB.key)) tabs.push(MATH_TAB);
  if (hasOther && presentTabs.length >= 2) tabs.push({ key: "other", label: "Other" });
  tabs.push(PREP_TAB);
  // Apps tab sits just left of Quests, and only when the scholar has ≥1 app:
  // a launcher tile, or an app they built (active or archived). The launcher
  // renders ONLY on this tab.
  if (hasApps) tabs.push({ key: "apps", label: "Apps" });
  tabs.push({ key: "quests", label: "Quests" });

  return { tabs, hasOther };
}

export function filterRowsForTab<T extends ScholarHomeRow>(
  rows: T[],
  tabKey: string,
): T[] {
  const assignedRows = rows.filter((row) => ASSIGNED_ORIGINS.has(row.origin));
  if (tabKey === "quests") {
    return rows.filter((row) => row.origin === "is");
  }
  if (tabKey === "apps") return rows.filter((row) => row.isApp === true);
  if (tabKey === "prep") return [];
  if (tabKey === "now") return assignedRows;
  if (tabKey === "other") {
    return assignedRows.filter(
      (row) => foldedSubject(row.subject) === null,
    );
  }

  const selected = tabKey.startsWith("subject:")
    ? tabKey.slice("subject:".length)
    : tabKey;
  const selectedKey = subjectTabKey(selected);
  return assignedRows.filter(
    (row) => row.subject !== null && subjectTabKey(row.subject) === selectedKey,
  );
}

/**
 * The Archived filter's twin of `filterRowsForTab`: which archived rows
 * (sessions.finishedForScholar) a Home tab lists. Every tab places a row the
 * way it places an active one, with one difference: Scholar's Prep renders
 * its own sections when active, and lists archived homework here. Now lists
 * every archived assigned row (what the retired All tab listed).
 */
export function filterArchivedRowsForTab<T extends ScholarHomeRow>(
  rows: T[],
  tabKey: string,
): T[] {
  if (tabKey === "prep") return rows.filter((row) => row.origin === "homework");
  return filterRowsForTab(rows, tabKey);
}

/**
 * The rows a tab's Open from class and Homework sections hold: every item on Now, that
 * subject's slice on a subject (or Other) tab, nothing elsewhere. Same rows,
 * grouped by shared/homeworkList.ts on every tab, so a subject whose only open work is
 * homework still has something on its tab.
 */
export function yourListRowsForTab<T extends ScholarHomeRow>(
  rows: T[],
  tabKey: string,
  nowMs: number,
): T[] {
  if (tabKey === "quests" || tabKey === "apps" || tabKey === "prep") return [];
  return filterRowsForTab(rows, tabKey).filter((row) => onYourList(row, nowMs));
}

export const PICK_UP_HEADING = "Pick up where you left off";

/**
 * "Pick up where you left off" on Now: the open class work from Home's plate
 * (started-but-unfinished, plus the next activities of units with open class
 * work), minus the rows the class section above already shows and open-until
 * work still in Open from class (it lands here once its window closes). Most recently
 * touched first. It replaced the All tab and the quiet-day "Open work" block.
 * It shows at any time of day whenever it has rows (Andy: nothing on Home
 * appears or disappears by the clock).
 */
export function pickUpRows<T extends ScholarHomeRow & { lastTouched?: number }>(
  rows: T[],
  shownInClassSection: readonly T[],
  nowMs: number,
): T[] {
  const shown = new Set(shownInClassSection);
  return filterRowsForTab(rows, "now")
    .filter(
      (row) =>
        row.origin === "classFocus" &&
        !onYourList(row, nowMs) &&
        !shown.has(row),
    )
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        (b.row.lastTouched ?? 0) - (a.row.lastTouched ?? 0) || a.index - b.index,
    )
    .map(({ row }) => row);
}

// Homework on Now is the Homework section (shared/homeworkList.ts). It is
// never hidden by time of day or by how far off a deadline is.

type HomeworkForNowEntry = {
  completedByMe?: boolean;
};

/**
 * The one homework policy every server read shares with the Homework section: every live
 * item the scholar hasn't finished, whatever its due date. (It used to hold
 * back dated work until the next open school day; that window is gone.)
 */
export function filterHomeworkForNow<T extends HomeworkForNowEntry>(
  homework: T[],
): T[] {
  return homework.filter((entry) => !entry.completedByMe);
}

type FocusEntry = {
  setAt?: number | null;
  endsAt?: number | null;
  completedByMe?: boolean;
};

type PlannedEntry = {
  startsAt?: number | null;
};

export type NowDigestSection<Focus, Planned, Playlist> =
  | { key: "focus"; items: Focus[] }
  | { key: "planned"; items: Planned[] }
  | { key: "practice"; playlist: Playlist };

type AssignmentActivityKey = {
  assignmentId?: string | null;
  activityId?: string | null;
};

export function matchRowsToFocusOrder<
  Focus extends AssignmentActivityKey,
  Row extends AssignmentActivityKey,
>(focusItems: Focus[], rows: Row[]): Row[] {
  const matches: Array<Row | undefined> = new Array(focusItems.length);
  const usedRowIndexes = new Set<number>();

  for (const [focusIndex, focus] of focusItems.entries()) {
    if (focus.assignmentId == null || focus.activityId == null) continue;
    const rowIndex = rows.findIndex(
      (candidate, candidateIndex) =>
        !usedRowIndexes.has(candidateIndex) &&
        candidate.assignmentId === focus.assignmentId &&
        candidate.activityId === focus.activityId,
    );
    if (rowIndex < 0) continue;
    matches[focusIndex] = rows[rowIndex];
    usedRowIndexes.add(rowIndex);
  }

  for (const [focusIndex, focus] of focusItems.entries()) {
    if (matches[focusIndex] || focus.activityId == null) continue;
    const rowIndex = rows.findIndex(
      (candidate, candidateIndex) =>
        !usedRowIndexes.has(candidateIndex) &&
        candidate.activityId === focus.activityId,
    );
    if (rowIndex < 0) continue;
    matches[focusIndex] = rows[rowIndex];
    usedRowIndexes.add(rowIndex);
  }

  return matches.filter((row): row is Row => row !== undefined);
}

/**
 * The one name for the scholar's class-work section, on Now and the subject
 * tabs, web and native: "In class now" during school hours, "From
 * class today" after the last bell.
 */
export function focusSectionLabel(isWithinSchoolHours: boolean): string {
  return isWithinSchoolHours ? "In class now" : "From class today";
}

export function buildNowDigest<
  Focus extends FocusEntry,
  Planned extends PlannedEntry,
  Playlist,
>({
  focusEntries,
  plannedToday,
  playlist,
  nowMs,
}: {
  focusEntries: Focus[];
  plannedToday: Planned[];
  playlist: Playlist | null | undefined;
  nowMs: number;
}): {
  sections: Array<NowDigestSection<Focus, Planned, Playlist>>;
  /** No live class focus and no planned class work left today. Homework is
   *  the Homework section (shared/homeworkList.ts) and never decides "quiet". */
  isQuiet: boolean;
} {
  // Showing, not blocking. The upstream institution-clock query has already
  // removed a focus from a prior day unless it carries an explicit future
  // `endsAt`. Within the day it was set, an overrun focus still shows while its
  // wall drops separately through `soloStartableByMe`.
  // `setAt` stamped = a human made it live; a planned entry (startsAt set,
  // setAt null) must NOT surface as the class focus (see the pushes table
  // comment in convex/schema.ts — planned != live is the safety model).
  const liveFocus = focusEntries.filter(
    (entry) =>
      !entry.completedByMe && entry.setAt != null && entry.setAt <= nowMs,
  );
  const upcoming = plannedToday.filter(
    (entry) => entry.startsAt == null || entry.startsAt >= nowMs,
  );
  const sections: Array<NowDigestSection<Focus, Planned, Playlist>> = [];

  if (liveFocus.length > 0) sections.push({ key: "focus", items: liveFocus });
  if (upcoming.length > 0) sections.push({ key: "planned", items: upcoming });
  if (playlist != null) sections.push({ key: "practice", playlist });

  return {
    sections,
    isQuiet: liveFocus.length === 0 && upcoming.length === 0,
  };
}

export type ScholarScheduleBlock = {
  startLocal: string;
  endLocal: string;
};

function parseLocalMinute(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

export function pickCurrentBlock<T extends ScholarScheduleBlock>(
  blocks: T[],
  nowMs: number,
  timeZone: string,
): T | null {
  const localMinute = minuteOfDayForTimezone(nowMs, timeZone);
  for (const block of blocks) {
    const start = parseLocalMinute(block.startLocal);
    const end = parseLocalMinute(block.endLocal);
    if (start === null || end === null || start === end) continue;
    const contains =
      end > start
        ? localMinute >= start && localMinute < end
        : localMinute >= start || localMinute < end;
    if (contains) return block;
  }
  return null;
}

export function isWithinScheduleWindow(
  blocks: ScholarScheduleBlock[],
  nowMs: number,
  timeZone: string,
): boolean {
  const ranges = blocks.flatMap((block) => {
    const start = parseLocalMinute(block.startLocal);
    const end = parseLocalMinute(block.endLocal);
    return start !== null && end !== null && end > start ? [[start, end]] : [];
  });
  if (ranges.length === 0) return false;
  const firstStart = Math.min(...ranges.map(([start]) => start));
  const lastEnd = Math.max(...ranges.map(([, end]) => end));
  const localMinute = minuteOfDayForTimezone(nowMs, timeZone);
  return localMinute >= firstStart && localMinute < lastEnd;
}
