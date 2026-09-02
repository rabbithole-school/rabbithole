import {
  dayKeyForTimezone,
  minuteOfDayForTimezone,
} from "./institutionDay";

export type ScholarHomeRow = {
  origin: "classFocus" | "homework" | "is";
  subject: string | null;
};

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
  const tabs: ScholarHomeTab[] = [
    { key: "now", label: "Now" },
    { key: "all", label: "All" },
  ];

  if (presentTabs.length >= 2) {
    tabs.push(...presentTabs);
  }
  if (!tabs.some((tab) => tab.key === MATH_TAB.key)) tabs.push(MATH_TAB);
  if (hasOther && presentTabs.length >= 2) tabs.push({ key: "other", label: "Other" });
  tabs.push(PREP_TAB);
  // Apps tab (the external-app launcher) sits just left of Quests, and only
  // when the scholar has ≥1 app. The launcher renders ONLY on this tab.
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
  if (tabKey === "prep" || tabKey === "apps") return [];
  if (tabKey === "all" || tabKey === "now") return assignedRows;
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

export function shouldShowHomeworkInNow({
  currentBlockKind,
  isWithinSchoolHours,
  isPrepTime,
}: {
  currentBlockKind?: string | null;
  isWithinSchoolHours: boolean;
  isPrepTime: boolean;
}): boolean {
  return currentBlockKind === "prep" || isPrepTime || !isWithinSchoolHours;
}

type HomeworkForNowEntry = {
  dueAt?: number | null;
  completedByMe?: boolean;
};

/**
 * The one deadline policy for the Home Now digest. Undated work stays visible;
 * dated work appears only once it is due, or when it is due on the next day
 * school is open.
 */
export function filterHomeworkForNow<T extends HomeworkForNowEntry>(
  homework: T[],
  {
    nowMs,
    timeZone,
    nextOpenSchoolDayKey,
  }: {
    nowMs: number;
    timeZone: string;
    nextOpenSchoolDayKey: string | null | undefined;
  },
): T[] {
  const todayKey = dayKeyForTimezone(nowMs, timeZone);
  return homework.filter((entry) => {
    if (entry.completedByMe) return false;
    if (entry.dueAt == null) return true;

    const dueDayKey = dayKeyForTimezone(entry.dueAt, timeZone);
    return (
      dueDayKey <= todayKey ||
      (nextOpenSchoolDayKey != null && dueDayKey === nextOpenSchoolDayKey)
    );
  });
}

type FocusEntry = {
  setAt?: number | null;
  endsAt?: number | null;
  completedByMe?: boolean;
};

type PlannedEntry = {
  startsAt?: number | null;
};

type HomeworkEntry = {
  completedByMe?: boolean;
};

export type NowDigestSection<Focus, Planned, Homework, Playlist> =
  | { key: "focus"; items: Focus[] }
  | { key: "planned"; items: Planned[] }
  | { key: "practice"; playlist: Playlist }
  | { key: "homework"; items: Homework[] };

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

  return [
    ...matches.filter((row): row is Row => row !== undefined),
    ...rows.filter((_, rowIndex) => !usedRowIndexes.has(rowIndex)),
  ];
}

export function buildNowDigest<
  Focus extends FocusEntry,
  Planned extends PlannedEntry,
  Homework extends HomeworkEntry,
  Playlist,
>({
  focusEntries,
  plannedToday,
  homework,
  playlist,
  nowMs,
}: {
  focusEntries: Focus[];
  plannedToday: Planned[];
  homework: Homework[];
  playlist: Playlist | null | undefined;
  nowMs: number;
}): {
  sections: Array<NowDigestSection<Focus, Planned, Homework, Playlist>>;
  isQuiet: boolean;
} {
  // Showing, not blocking. `endsAt` deliberately isn't consulted: an overrun
  // focus that nobody has wrapped is still what the class is on, and the
  // upstream query has already dropped anything actually ended. Filtering it
  // again here is what made the ladder call the day quiet — and render its
  // "Open work" fallback — while the plate below still printed "Class focus"
  // for that very row. The wall is handled separately, by dropping the
  // entry's `soloStartableByMe` once its window closes.
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
  const dueHomework = homework.filter((entry) => !entry.completedByMe);
  const sections: Array<
    NowDigestSection<Focus, Planned, Homework, Playlist>
  > = [];

  if (liveFocus.length > 0) sections.push({ key: "focus", items: liveFocus });
  if (upcoming.length > 0) sections.push({ key: "planned", items: upcoming });
  if (playlist != null) sections.push({ key: "practice", playlist });
  if (dueHomework.length > 0) {
    sections.push({ key: "homework", items: dueHomework });
  }

  return {
    sections,
    isQuiet:
      liveFocus.length === 0 &&
      upcoming.length === 0 &&
      dueHomework.length === 0,
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
