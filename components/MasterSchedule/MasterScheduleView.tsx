"use client";

/**
 * MasterScheduleView — the term-scoped recurring timetable behind the Day and
 * Week Assignments views. Rows are bell-schedule blocks, columns are Mon–Fri in
 * week mode or a single weekday in day mode. The top-level Assignments toggle
 * passes Day/Week via the `mode` prop. A single LENS at a time (By group / By
 * teacher) keeps it legible — no overlaid halves like the paper spreadsheet.
 * Cells carry AVATARS (never teacher-color fills), consistent with the rest of
 * Rabbithole.
 *
 * Direct-manipulation surface for the same operations the staff aide can drive
 * via tools (convex/lib/masterScheduleTools.ts): place / move (drag) / teleport
 * (±1 day) / reshelve / quick-add / stamp a week live. Web-only planning
 * surface (teacher/admin); no scholar-facing native gap.
 */
import { railedClassTitle } from "./railedClassTitle";
import {
  applyOptimisticDueMove,
  applyOptimisticMove,
  linkedPlacementIdForProjection,
} from "./optimisticMove";
import { serverErrorMessage } from "@/lib/serverErrorMessage";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  Flex,
  HStack,
  Input,
  Menu,
  Portal,
  Text,
  Tooltip,
  VStack,
  chakra,
} from "@chakra-ui/react";
import {
  CalendarBlank,
  CaretDown,
  Check,
  MagnifyingGlass,
  Plus,
  Warning,
} from "@phosphor-icons/react";
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDndContext,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useMutation, useQuery } from "convex/react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Avatar } from "@/components/Avatar";
import { PlacementChip as EnrichedChip, isAwaitingActivity } from "@/components/MasterSchedule/PlacementChip";
import {
  givenMeetingKeys,
  onePerGive,
  withGiveClock,
} from "@/components/MasterSchedule/giveClock";
import {
  GiveCard,
  GiveRowLabel,
  GiveStripCell,
  UpNextButton,
  giveGroupMark,
  activeGive,
  giveInLens,
  type GridClassMeeting,
  type GridGive,
} from "@/components/MasterSchedule/GiveCard";
import {
  PlacementDetailDrawer,
  type DrawerTarget,
} from "@/components/MasterSchedule/PlacementDetailDrawer";
import { fmtTimeRange } from "@/components/MasterSchedule/timeFormat";
import { DateTermPicker } from "@/components/MasterSchedule/DateTermPicker";
import { useScholarRoster } from "@/hooks/useScholarRoster";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { ROLES } from "@/convex/lib/roles";
import { useAideDock } from "@/components/aide/AideDockProvider";
import { toaster } from "@/lib/toaster";
import { useNow } from "@/hooks/useNow";
import { withClosedWindows } from "@/components/MasterSchedule/closedWindows";
import { EmptyState as PrimitiveEmptyState } from "@/components/ui/EmptyState";
import { CreatePeriodDialog } from "@/components/narrative/CreatePeriodDialog";
import { StartAssignmentDialog } from "@/components/StartAssignmentDialog";
import { computeScheduleLoadingState } from "@/components/MasterSchedule/scheduleLoadingState";
import { BirthdayRosterDialog } from "@/components/MasterSchedule/BirthdayRosterDialog";
import {
  clampToWeekday,
  initialAnchorMs,
  todayAnchorMs,
  termForMs,
} from "@/components/MasterSchedule/scheduleAnchor";
import { closuresForWeek, type SchoolClosure } from "@/shared/schoolClosures";
import { scheduleWeekStartMs } from "@/shared/scheduleWeek";
import { DEFAULT_TIMEZONE, dayKeyForTimezone } from "@/shared/institutionDay";

type Lens = "group" | "teacher";
type ScheduleMode = "week" | "day";
type DropZone = "class" | "homework";

const WEEKDAYS = [
  { n: 1, label: "Mon", full: "Monday" },
  { n: 2, label: "Tue", full: "Tuesday" },
  { n: 3, label: "Wed", full: "Wednesday" },
  { n: 4, label: "Thu", full: "Thursday" },
  { n: 5, label: "Fri", full: "Friday" },
];
type Weekday = (typeof WEEKDAYS)[number];

/** Today's weekday as a 0-based Mon–Fri index (weekends clamp to Monday). */
function defaultDayIndex(): number {
  const dow = new Date().getDay(); // 0=Sun..6=Sat
  return dow >= 1 && dow <= 5 ? dow - 1 : 0;
}

type GridData = NonNullable<ReturnType<typeof useQuery<typeof api.masterSchedule.grid>>>;
type Placement = GridData["placements"][number];

/** A placement that pushes something to scholars (an activity or an app), so
 *  only a class block takes it. A bare row is a staffing marker. */
const carriesWork = (p: Placement) =>
  Boolean(p.activityId || p.assignmentId || p.externalAppId);
type HomeworkDueProjection = GridData["homeworkDue"][number];
type Block = GridData["blocks"][number];
const NO_SENSORS: [] = [];
// The All day row appears when a give drag starts, which shifts every row
// below it; re-measure drop targets during the drag so drops land where the
// pointer is.
const DROP_MEASURING = { droppable: { strategy: MeasuringStrategy.Always } };
type CurriculumUnit = NonNullable<ReturnType<typeof useQuery<typeof api.units.list>>>[number];
type CurriculumActivity = NonNullable<
  ReturnType<typeof useQuery<typeof api.activities.listByUnitPublic>>
>[number];
type CurriculumSuggestion =
  | {
      type: "unit";
      key: string;
      label: string;
      unitId: Id<"units">;
      subtitle: string;
    }
  | {
      type: "activity";
      key: string;
      label: string;
      unitId: Id<"units">;
      activityId: Id<"activities">;
      subtitle: string;
    }
  | {
      type: "skill";
      key: string;
      label: string;
      nodeKey: string;
      domain: string;
      subtitle: string;
    };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Monday 00:00 local of the week containing `ms`, optionally N weeks ahead. */
function mondayOf(ms: number, weeksAhead = 0): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay(); // 0=Sun..6=Sat
  const deltaToMon = (dow + 6) % 7; // days since Monday
  d.setDate(d.getDate() - deltaToMon + weeksAhead * 7);
  return d.getTime();
}

function addDays(ms: number, days: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

function weekdayIndexFor(ms: number): number | null {
  const dow = new Date(ms).getDay();
  return dow >= 1 && dow <= 5 ? dow - 1 : null;
}

function moveWeekday(ms: number, delta: -1 | 1): number {
  let next = addDays(ms, delta);
  while (weekdayIndexFor(next) === null) next = addDays(next, delta);
  return next;
}

function monthDay(ms: number): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(ms));
}

function dayColumnLabel(day: Weekday, weekStartMs: number, scheduleMode: ScheduleMode): string {
  const ms = addDays(weekStartMs, day.n - 1);
  return scheduleMode === "day" ? `${day.full} · ${monthDay(ms)}` : `${day.label} ${new Date(ms).getDate()}`;
}

/** Local "YYYY-MM-DD" for a millisecond timestamp (weekStartMs is local midnight). */
function toDayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse a calendar date at local midnight, avoiding UTC date-only parsing. */
function fromDayKey(dayKey: string | null): number | null {
  const match = dayKey?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
    ? clampToWeekday(date.getTime())
    : null;
}

type BirthdayCell = { name: string; nthLabel: string | null };

/** "Kai Kahale (11th Birthday)" — name + Nth-Birthday age when known. */
function formatBirthdayCell(cell: BirthdayCell): string {
  return cell.nthLabel ? `${cell.name} (${cell.nthLabel})` : cell.name;
}

function cellId(blockId: string, weekday: number) {
  return `cell:${blockId}:${weekday}`;
}

const scheduleCollisionDetection: CollisionDetection = (args) => {
  // A give from the Homework due row lands only where the pointer is: a
  // nearest-centre guess would turn a drop on a (refusing) class cell into a
  // move to whichever due day happens to be closest.
  if ((args.active.data.current as { kind?: string } | undefined)?.kind === "give") {
    return pointerWithin({
      ...args,
      droppableContainers: args.droppableContainers.filter(
        ({ data }) => data.current?.zone === "homework",
      ),
    });
  }
  return closestCenter(args);
};

/** The standard class identity key — (groupId, subject) with subject trimmed +
 *  case-folded, matching shared/meetingSlots.deriveClassMeetingPattern. Used in
 *  the grid to tell whether a cell's activity chip belongs to the same class as
 *  a header the cell already renders. */
function classKey(p: { groupId: string; subject: string }): string {
  return `${String(p.groupId)}|${p.subject.trim().toLowerCase()}`;
}

export function MasterScheduleView({
  viewToggle,
  mode = "week",
  programScoped = false,
}: {
  viewToggle?: React.ReactNode;
  mode?: ScheduleMode;
  /** Program staff share work from the same timetable without gaining
   * school-wide schedule editing authority. */
  programScoped?: boolean;
} = {}) {
  const searchParams = useSearchParams();
  const [initialUrl] = useState<{
    dateMs: number | null;
    lens: Lens | null;
    groupKey: string;
    teacherKey: string;
  }>(() => {
    const lens = searchParams.get("lens");
    return {
      dateMs: fromDayKey(searchParams.get("date")),
      lens:
        programScoped
          ? "group"
          : lens === "group" || lens === "teacher"
            ? lens
            : null,
      groupKey: searchParams.get("group") ?? "",
      teacherKey: searchParams.get("teacher") ?? "",
    };
  });

  // ── Term scope ──────────────────────────────────────────────────────────
  const { scopeParam } = useActiveInstitution();
  const teacherTerms = useQuery(
    api.reportingPeriods.list,
    programScoped ? "skip" : { scope: scopeParam },
  );
  const teacherCurrentTerm = useQuery(
    api.reportingPeriods.current,
    programScoped ? "skip" : { scope: scopeParam },
  );
  const programPeriodState = useQuery(
    api.masterSchedule.programPeriods,
    programScoped ? { institutionScope: scopeParam } : "skip",
  );
  const terms = programScoped ? programPeriodState?.periods : teacherTerms;
  const currentTerm = programScoped
    ? programPeriodState?.current
    : teacherCurrentTerm;
  const [anchorMs, setAnchorMs] = useState(
    () => initialUrl.dateMs ?? clampToWeekday(Date.now()),
  );
  const initializedAnchorRef = useRef(initialUrl.dateMs !== null);
  useEffect(() => {
    if (initializedAnchorRef.current || terms === undefined || currentTerm === undefined) return;
    setAnchorMs(initialAnchorMs(terms, currentTerm));
    initializedAnchorRef.current = true;
  }, [currentTerm, terms]);

  const activeTerm = useMemo(() => {
    if (!terms) return currentTerm ?? null;
    return termForMs(terms, anchorMs) ?? currentTerm ?? terms[0] ?? null;
  }, [anchorMs, currentTerm, terms]);
  const termId = activeTerm?._id ?? null;

  // The week the grid is anchored to, in the SAME fixed-HST arithmetic the
  // backend stamps placements with (currentWeekStartMs → scheduleWeekStartMs).
  // `weekStartMs`/`mondayOf` below stays browser-local for date-LABEL display;
  // this drives (a) filtering chips to the on-screen week and (b) the grid
  // query's week arg, so a concrete chip's stamped weekStartMs compares equal
  // for a viewer in any timezone. See shared/scheduleWeek.ts.
  const anchorWeekStartMs = useMemo(
    () => scheduleWeekStartMs(anchorMs),
    [anchorMs],
  );

  const teacherGrid = useQuery(
    api.masterSchedule.grid,
    !programScoped && termId
      ? { periodId: termId, weekStartMs: anchorWeekStartMs }
      : "skip",
  );
  const programGrid = useQuery(
    api.masterSchedule.programGrid,
    programScoped && termId
      ? {
          periodId: termId,
          weekStartMs: anchorWeekStartMs,
          institutionScope: scopeParam,
        }
      : "skip",
  );
  // The grid returns each open-until window's boundary; this page's minute
  // clock decides which have closed (closedWindows.ts, T11).
  const rawGrid = programScoped ? programGrid : teacherGrid;
  const nowMs = useNow(60_000);
  const grid = useMemo(
    () =>
      rawGrid
        ? withClosedWindows(rawGrid, nowMs, rawGrid.closureTimeZone ?? DEFAULT_TIMEZONE)
        : rawGrid,
    [rawGrid, nowMs],
  );
  // `placements` is the term-wide source feed for drawers and meeting-pattern
  // tools. Cells render the backend's layered target-week feed.
  const weekPlacements = useMemo(
    () => grid?.weekPlacements ?? [],
    [grid?.weekPlacements],
  );

  // See scheduleLoadingState.ts: a null termId can mean either "still
  // fetching" or "no reporting period exists at all" — those need different
  // UI (a spinner vs. an empty state with a next step).
  const { loading, noTermConfigured } = computeScheduleLoadingState({ terms, currentTerm, termId, grid });
  const [newPeriodOpen, setNewPeriodOpen] = useState(false);

  // ── Lens ────────────────────────────────────────────────────────────────
  const { groups: rosterGroups, isLoading: rosterLoading } = useScholarRoster({
    enabled: !programScoped,
  });
  const { user: currentUser } = useCurrentUser();
  const [lens, setLens] = useState<Lens>(() => initialUrl.lens ?? "group");
  const [groupKey, setGroupKey] = useState<string>(initialUrl.groupKey);
  const [teacherKey, setTeacherKey] = useState<string>(initialUrl.teacherKey);
  const [urlStateReady, setUrlStateReady] = useState(false);
  const [programDialogTarget, setProgramDialogTarget] = useState<{
    groupId: string;
    subject?: string;
    scheduleTarget:
      | {
          mode: "classFocus";
          placementId: string;
          blockId: string;
          weekday: number;
          dateMs: number;
          weekStartMs: number;
          blockLabel: string;
          startLocal: string;
          endLocal: string;
        }
      | {
          mode: "homework";
          dueDateMs: number;
        };
  } | null>(null);

  // ── Time span: Week (Mon–Fri) or a single Day column ──────────────────────
  const scheduleMode = mode;
  const [dayIndex, setDayIndex] = useState<number>(defaultDayIndex);
  useEffect(() => {
    const nextIndex = weekdayIndexFor(anchorMs);
    if (nextIndex !== null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- keeps the day-mode selection synchronized to a valid anchor weekday.
      setDayIndex(nextIndex);
    }
  }, [anchorMs]);
  const visibleDays = useMemo<Weekday[]>(
    () => (scheduleMode === "day" ? [WEEKDAYS[dayIndex] ?? WEEKDAYS[0]] : WEEKDAYS),
    [dayIndex, scheduleMode],
  );
  const weekStartMs = useMemo(() => mondayOf(anchorMs), [anchorMs]);
  // No-school days for the concrete week on screen, keyed by weekday (1=Mon…5=Fri).
  // The materializer already skips these; here we overlay a read-only "No School"
  // band on each closed column and suppress quick-add/drop onto it.
  const closuresByWeekday = useMemo<Map<number, SchoolClosure>>(() => {
    const rows = grid?.closures;
    if (!rows || rows.length === 0) return new Map();
    return closuresForWeek(weekStartMs, grid?.closureTimeZone ?? DEFAULT_TIMEZONE, rows);
  }, [grid?.closures, grid?.closureTimeZone, weekStartMs]);

  // Birthdays that land on this displayed week, keyed to the weekday column
  // whose date matches. A birthday is a day-level fact, so it rides the day
  // header (never a class block). The roster hook strips dateOfBirth, so this
  // comes from the dedicated staff-only query.
  const mondayKey = useMemo(() => toDayKey(weekStartMs), [weekStartMs]);
  const weekBirthdays = useQuery(
    api.birthdays.birthdaysForWeek,
    programScoped
      ? "skip"
      : {
          mondayKey,
          institutionScope: scopeParam,
        },
  );
  const birthdaysByWeekday = useMemo(() => {
    const map = new Map<number, BirthdayCell[]>();
    for (const row of weekBirthdays ?? []) {
      const list = map.get(row.weekday) ?? [];
      list.push({ name: row.name, nthLabel: row.nthLabel });
      map.set(row.weekday, list);
    }
    return map;
  }, [weekBirthdays]);

  const goToPreviousSpan = useCallback(() => {
    setAnchorMs((ms) => (scheduleMode === "week" ? addDays(ms, -7) : moveWeekday(ms, -1)));
  }, [scheduleMode]);
  const goToNextSpan = useCallback(() => {
    setAnchorMs((ms) => (scheduleMode === "week" ? addDays(ms, 7) : moveWeekday(ms, 1)));
  }, [scheduleMode]);
  const goToToday = useCallback(() => {
    setAnchorMs(todayAnchorMs());
  }, []);

  // Group options = the teacher's roster groups ∪ any groups already scheduled.
  const groupOptions = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; emoji: string | null }>();
    for (const g of rosterGroups) byId.set(g.id, { id: g.id, name: g.name, emoji: g.emoji });
    for (const g of grid?.groups ?? []) {
      if (!byId.has(String(g._id))) byId.set(String(g._id), { id: String(g._id), name: g.name, emoji: g.emoji });
    }
    return [...byId.values()];
  }, [rosterGroups, grid?.groups]);

  // The signed-in teacher is always a first-class "Me" option in the teacher
  // lens — even before they have any placements — so the default view can land
  // on themselves. Otherwise the picker only lists teachers already scheduled.
  const meId = currentUser?._id ? String(currentUser._id) : "";
  const iAmTeacher = currentUser?.role === ROLES.TEACHER && !!meId;
  const teacherOptions = useMemo<GridData["teachers"]>(() => {
    const base = grid?.teachers ?? [];
    if (iAmTeacher && !base.some((t) => String(t._id) === meId)) {
      return [
        {
          _id: currentUser!._id as Id<"users">,
          name: currentUser!.name ?? "Me",
          username: currentUser!.username ?? null,
        },
        ...base,
      ];
    }
    return base;
  }, [grid?.teachers, iAmTeacher, meId, currentUser]);

  // Default the lens once user + data land: a teacher opens on themselves
  // ("Me" in the By-teacher lens); anyone else opens on By group.
  const didInitDefaultsRef = useRef(false);
  useEffect(() => {
    if (didInitDefaultsRef.current) return;
    if (currentUser === undefined) return; // wait for auth/user to resolve
    if (rosterLoading || (grid === undefined && !noTermConfigured)) return;
    const meIsTeacherOption = !!meId && teacherOptions.some((t) => String(t._id) === meId);
    const defaultLens = iAmTeacher && meIsTeacherOption ? "teacher" : "group";
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Initialize URL-backed controls once their async option lists are available.
    setLens(programScoped ? "group" : initialUrl.lens ?? defaultLens);
    // URL params win, but only when they name a REAL option — a stale/garbage
    // ?group= / ?teacher= falls back to the default instead of an empty grid
    // (mirrors ?date=, which validates + falls back).
    const urlGroup = initialUrl.groupKey;
    const validUrlGroup = groupOptions.some((g) => g.id === urlGroup) ? urlGroup : "";
    const urlTeacher = initialUrl.teacherKey;
    const validUrlTeacher = teacherOptions.some((t) => String(t._id) === urlTeacher)
      ? urlTeacher
      : "";
    setGroupKey(validUrlGroup || groupOptions[0]?.id || "");
    setTeacherKey(
      validUrlTeacher ||
        (iAmTeacher && meIsTeacherOption
          ? meId
          : teacherOptions[0]
            ? String(teacherOptions[0]._id)
            : ""),
    );
    didInitDefaultsRef.current = true;
    setUrlStateReady(true);
  }, [
    currentUser,
    groupOptions,
    teacherOptions,
    iAmTeacher,
    meId,
    rosterLoading,
    grid,
    noTermConfigured,
    initialUrl,
    programScoped,
  ]);

  useEffect(() => {
    if (!urlStateReady || !initializedAnchorRef.current) return;
    const url = new URL(window.location.href);
    url.searchParams.set("lens", lens);
    if (lens === "group") {
      if (groupKey) url.searchParams.set("group", groupKey);
      else url.searchParams.delete("group");
      url.searchParams.delete("teacher");
    } else {
      if (teacherKey) url.searchParams.set("teacher", teacherKey);
      else url.searchParams.delete("teacher");
      url.searchParams.delete("group");
    }
    url.searchParams.set("date", toDayKey(anchorMs));
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextUrl !== currentUrl) {
      window.history.replaceState(window.history.state, "", nextUrl);
    }
  }, [anchorMs, groupKey, lens, teacherKey, urlStateReady]);

  // ── Mutations ─────────────────────────────────────────────────────────────
  // The grid's actions are give actions (TRA-582).
  const giveToClass = useMutation(api.gridGiveActions.giveToClass);
  const giveHomework = useMutation(api.gridGiveActions.giveHomework);
  const moveGive = useMutation(api.gridGiveActions.moveGive);
  // A drop lands at once: the grid's cached result takes the move locally and
  // the server's answer reconciles it (or rolls it back if the move failed).
  const movePlacement = useMutation(
    api.masterSchedule.movePlacement,
  ).withOptimisticUpdate((localStore, { weekday, blockId, ...args }) => {
    // The grid only drops into a cell; a move off its day has no local guess.
    if (weekday == null || blockId == null) return;
    for (const { args: queryArgs, value } of localStore.getAllQueries(
      api.masterSchedule.grid,
    )) {
      if (!value || queryArgs.weekStartMs == null) continue;
      const next = applyOptimisticMove(
        value,
        { ...args, weekday, blockId },
        queryArgs.weekStartMs,
      );
      if (next !== value) localStore.setQuery(api.masterSchedule.grid, queryArgs, next);
    }
  });
  // A Homework due card with no grid placement is a give made outside the
  // grid: dropping it on another day re-gives it "by" that day through the
  // Run page's own path (scheduleActivity keeps it live and keeps its
  // scholars), landing at once like a placement move.
  const regive = useMutation(api.assignments.scheduleActivity).withOptimisticUpdate(
    (localStore, args) => {
      const finish = args.finish;
      if (!finish || (finish.kind !== "by" && finish.kind !== "openUntil")) return;
      for (const { args: queryArgs, value } of localStore.getAllQueries(
        api.masterSchedule.grid,
      )) {
        if (!value || queryArgs.weekStartMs == null) continue;
        const zone = value.closureTimeZone ?? DEFAULT_TIMEZONE;
        const weekDayKeys = [0, 1, 2, 3, 4].map((i) =>
          dayKeyForTimezone(queryArgs.weekStartMs! + i * DAY_MS + DAY_MS / 2, zone),
        );
        const next = applyOptimisticDueMove(
          value,
          { assignmentId: args.assignmentId, activityId: args.activityId, dayKey: finish.dayKey },
          weekDayKeys,
          queryArgs.weekStartMs + Math.max(0, weekDayKeys.indexOf(finish.dayKey)) * DAY_MS,
        );
        if (next !== value) localStore.setQuery(api.masterSchedule.grid, queryArgs, next);
      }
    },
  );
  const removeProgramHandoutPlacement = useMutation(
    api.masterSchedule.removeProgramHandoutPlacement,
  );
  const ensureHomeworkRail = useMutation(api.masterSchedule.ensureHomeworkRail);

  // The aide dock — the conflict section offers an "ask bot" door that seeds
  // the composer.
  const aide = useAideDock();

  // ── DnD ───────────────────────────────────────────────────────────────────
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [dragId, setDragId] = useState<string | null>(null);

  // Built from the term-wide feed, not `weekPlacements`, so the DragOverlay
  // and the drawer resolve any placement id the grid hands them.
  const placementsById = useMemo(() => {
    const m = new Map<string, Placement>();
    for (const p of grid?.placements ?? []) m.set(String(p._id), p);
    return m;
  }, [grid?.placements]);

  // A completed drag can still dispatch a trailing click on the chip that was
  // grabbed — suppress it so a drop never also opens the detail drawer. Set on
  // drag start, cleared a frame after drag end (a plain sub-5px click never
  // starts a drag, so it opens the drawer normally).
  const justDraggedRef = useRef(false);

  const isJustDragged = useCallback(() => justDraggedRef.current, []);

  const onDragStart = (e: DragStartEvent) => {
    justDraggedRef.current = true;
    setDragId(String(e.active.id));
  };
  // The give being dragged, when the card is a Homework due projection with
  // no grid placement (its overlay; class cells refuse it).
  const draggedGive = useMemo(() => {
    if (!dragId?.startsWith("give:")) return null;
    const key = dragId.slice("give:".length);
    return (grid?.homeworkDue ?? []).find((item) => item.key === key) ?? null;
  }, [dragId, grid?.homeworkDue]);
  // Class meetings this week, by cell, for drops, Up next and adding work.
  const meetingByCellGroup = useMemo(() => {
    const m = new Map<string, GridClassMeeting>();
    for (const meeting of grid?.classMeetings ?? []) {
      m.set(`${meeting.blockId}|${meeting.weekday}|${meeting.groupId}`, meeting);
    }
    return m;
  }, [grid?.classMeetings]);
  const meetingFor = useCallback(
    (groupId: string, blockId: string, weekday: number) =>
      meetingByCellGroup.get(`${blockId}|${weekday}|${groupId}`) ?? null,
    [meetingByCellGroup],
  );
  // The classes the Homework due row's "+" can give homework for: this
  // week's meeting classes, one entry per class.
  const classOptions = useMemo(() => {
    const seen = new Map<string, QuickAddClassOption>();
    for (const m of grid?.classMeetings ?? []) {
      const key = String(m.classId);
      if (!seen.has(key)) {
        seen.set(key, { classId: key, groupId: String(m.groupId), subject: m.subject });
      }
    }
    return [...seen.values()].sort((x, y) => x.subject.localeCompare(y.subject));
  }, [grid?.classMeetings]);
  const draggedGridGive = useMemo(() => {
    if (!dragId?.startsWith("grid-give:")) return null;
    const key = dragId.slice("grid-give:".length);
    return (grid?.gives ?? []).find((g) => g.key === key) ?? null;
  }, [dragId, grid?.gives]);
  const onDragEnd = async (e: DragEndEvent) => {
    requestAnimationFrame(() => {
      justDraggedRef.current = false;
    });
    setDragId(null);
    const over = e.over?.id ? String(e.over.id) : null;
    if (!over) return;
    const activeData = e.active.data.current as
      | { kind?: string; item?: HomeworkDueProjection }
      | undefined;
    const give = activeGive(e.active.data.current);
    if (give) {
      const overData = e.over?.data.current as
        | { zone?: DropZone | "allDay"; dayKey?: string }
        | undefined;
      const dayKeyFor = (weekday: number) =>
        dayKeyForTimezone(
          anchorWeekStartMs + (weekday - 1) * DAY_MS + DAY_MS / 2,
          grid?.closureTimeZone ?? DEFAULT_TIMEZONE,
        );
      let to:
        | { kind: "class"; classId: Id<"classes">; dayKey: string }
        | { kind: "allDay"; dayKey: string }
        | { kind: "homework"; dayKey: string }
        | null = null;
      if (overData?.zone === "allDay" && overData.dayKey) {
        to = { kind: "allDay", dayKey: overData.dayKey };
      } else if (over.startsWith("cell:")) {
        const [, blockId, weekdayText] = over.split(":");
        const weekday = Number(weekdayText);
        if (overData?.zone === "homework") {
          to = { kind: "homework", dayKey: dayKeyFor(weekday) };
        } else {
          const meeting = meetingFor(give.groupId, blockId, weekday);
          if (meeting) {
            to = { kind: "class", classId: meeting.classId, dayKey: meeting.dayKey };
          }
        }
      }
      if (
        !to ||
        (to.kind === "class" &&
          // Where it is drawn: a slot it was scheduled into, else its class.
          to.classId === (give.slotClassId ?? give.classId) &&
          to.dayKey === give.dayKey)
      ) {
        return;
      }
      try {
        await moveGive({ pushId: give.pushId, to });
      } catch (err) {
        toaster.create({
          title: "Move failed",
          description: serverErrorMessage(err, "Check your connection and try again."),
          type: "error",
        });
      }
      return;
    }
    if (activeData?.kind === "give" && activeData.item) {
      // Only another day's Homework due row takes a give: it moves the
      // finish to that day. Class cells refuse it (their droppables are
      // disabled during this drag), so anything else is a no-op.
      const zone = (e.over?.data.current as { zone?: DropZone } | undefined)?.zone;
      if (zone !== "homework" || !over.startsWith("cell:")) return;
      const weekday = Number(over.split(":")[2]);
      const item = activeData.item;
      if (weekday === item.weekday) return;
      const dayKey = dayKeyForTimezone(
        anchorWeekStartMs + (weekday - 1) * DAY_MS + DAY_MS / 2,
        grid?.closureTimeZone ?? DEFAULT_TIMEZONE,
      );
      try {
        await regive({
          assignmentId: item.assignmentId,
          activityId: item.activityId,
          startsAt: item.startsAt,
          finish: { kind: "by", dayKey },
        });
      } catch (err) {
        toaster.create({
          title: "Move failed",
          description: serverErrorMessage(err, "Check your connection and try again."),
          type: "error",
        });
      }
      return;
    }
    // Destination: a specific cell (work never moves to a day-less shelf).
    let dest:
      | {
          weekday: number;
          blockId: Id<"scheduleBlocks">;
          weekStartMs?: number;
          mode?: "classFocus" | "homework";
        }
      | null = null;
    if (over.startsWith("cell:")) {
      const [, blockId, weekday] = over.split(":");
      // Zone integrity: a cross-zone drop (class grid ↔ homework due-rail)
      // patches `mode` to match its destination, so a placement's location and
      // mode can never disagree.
      const zone = (
        e.over?.data.current as { zone?: DropZone } | undefined
      )?.zone;
      if (!zone) return;
      dest = {
        weekday: Number(weekday),
        blockId: blockId as Id<"scheduleBlocks">,
        weekStartMs: anchorWeekStartMs,
        mode: zone === "homework" ? "homework" : "classFocus",
      };
    }
    if (!dest) return;
    try {
      await movePlacement({
        placementId: String(e.active.id) as Id<"schedulePlacements">,
        ...dest,
      });
    } catch (err) {
      toaster.create({
        title: "Move failed",
        description: serverErrorMessage(err, "Check your connection and try again."),
        type: "error",
      });
    }
  };
  const onDragCancel = () => {
    justDraggedRef.current = false;
    setDragId(null);
  };

  // ── Detail drawer (click reveals; drag moves) ──────────────────────────────
  const [drawerTarget, setDrawerTarget] = useState<DrawerTarget | null>(null);
  // Focus returns to the originating chip on close — chips stamp
  // data-detail-trigger with their placement id.
  const detailTriggerTokenRef = useRef<string | null>(null);
  const openDetail = useCallback((t: DrawerTarget, triggerToken: string) => {
    if (justDraggedRef.current) return; // a completed drag, not a click
    detailTriggerTokenRef.current = triggerToken;
    setDrawerTarget(t);
  }, []);
  const closeDetail = useCallback(() => {
    setDrawerTarget(null);
    const token = detailTriggerTokenRef.current;
    if (token) {
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(`[data-detail-trigger="${CSS.escape(token)}"]`)
          ?.focus();
      });
    }
  }, []);

  // ── Quick-add ──────────────────────────────────────────────────────────────
  // Two entry points, both gives (TRA-582): clicking a class cell adds work to
  // that class on that day, and the Homework due row's "+" gives homework due
  // that day. We deliberately do NOT bind ⌘K here — that's the app's global
  // command palette (jump-to-scholar/curriculum); hijacking it would
  // double-open.
  const [quickAdd, setQuickAdd] = useState<QuickAddTarget | null>(null);

  // Clicking an EMPTY class cell opens the picker scoped to that class
  // meeting. Suppressed right after a drag (same guard as the detail drawer).
  const openFillSlot = useCallback((p: Placement) => {
    if (justDraggedRef.current || typeof p.weekday !== "number" || !p.blockId) return;
    setQuickAdd({
      kind: "class",
      weekday: p.weekday,
      blockId: String(p.blockId),
      subject: p.subject,
      groupId: String(p.groupId),
    });
  }, []);
  const openProgramWork = useCallback(
    (p: Placement) => {
      if (justDraggedRef.current || p.weekday == null) return;
      const dateMs = anchorWeekStartMs + (p.weekday - 1) * DAY_MS;
      if (p.mode === "homework") {
        setProgramDialogTarget({
          groupId: String(p.groupId),
          subject: p.subject,
          scheduleTarget: { mode: "homework", dueDateMs: dateMs },
        });
        return;
      }
      const block = grid?.blocks.find(
        (candidate) => String(candidate._id) === String(p.blockId),
      );
      if (!block) return;
      setProgramDialogTarget({
        groupId: String(p.groupId),
        subject: p.subject,
        scheduleTarget: {
          mode: "classFocus",
          placementId: String(p._id),
          blockId: String(p.blockId),
          weekday: p.weekday,
          dateMs,
          weekStartMs: p.weekStartMs ?? anchorWeekStartMs,
          blockLabel: block.label,
          startLocal: block.startLocal,
          endLocal: block.endLocal,
        },
      });
    },
    [anchorWeekStartMs, grid?.blocks],
  );
  // ── Derived: coverage / conflict lookups + visible placements ──────────────
  const coverageByCell = useMemo(() => {
    const m = new Map<string, GridData["coverage"][number]>();
    for (const c of grid?.coverage ?? []) m.set(`${c.blockId}|${c.weekday}`, c);
    return m;
  }, [grid?.coverage]);

  const conflictedPlacementIds = useMemo(() => {
    // Conflicts are per-TEACHER (a teacher double-booked in one slot), but a slot
    // is shared by many groups. Keying the badge by (block, weekday) painted
    // every group's cell in that slot — including chips whose teacher isn't
    // involved. Key instead by the exact placement ids the conflict names, so a
    // cell shows the badge iff one of ITS rendered chips is actually conflicted —
    // making the badge coincide with the drawer's conflict section (every badge
    // has its explanation one click away).
    const s = new Set<string>();
    for (const c of grid?.conflicts ?? [])
      for (const id of c.placementIds) s.add(String(id));
    return s;
  }, [grid?.conflicts]);

  const homeworkBlockIds = useMemo(() => {
    const s = new Set<string>();
    for (const b of grid?.blocks ?? []) if (b.kind === "homework") s.add(String(b._id));
    return s;
  }, [grid?.blocks]);
  // Placements in the current lens, indexed by `${blockId}|${weekday}`.
  const cellPlacements = useMemo(() => {
    const m = new Map<string, Placement[]>();
    for (const p of weekPlacements) {
      if (p.onShelf) continue;
      const inLens =
        lens === "group" ? String(p.groupId) === groupKey : String(p.teacherId) === teacherKey;
      if (!inLens) continue;
      // A chip whose finish is a date (or open until a date) sits in the
      // Homework due row instead, and its class keeps its block title here:
      // the class still met.
      let item =
        p.railWeekday != null
          ? (railedClassTitle(p, (id) => homeworkBlockIds.has(id)) as Placement | null)
          : p;
      if (!item) continue;
      // Activity cards retired from the teacher grid (TRA-582): the work they
      // carried draws as gives, and the card leaves only its class's title.
      // The title keeps the card's real id (the conflict badge and the
      // drawer key off it) and opens that card's drawer (`railedFrom`), where
      // it can be removed. The program grid still draws its handout cards.
      if (!programScoped && item.activityId) {
        item = {
          ...item,
          assignmentId: null,
          activityId: null,
          activityTitle: null,
          unitTitle: null,
          mode: null,
          linkState: "none",
          railedFrom: String(item._id),
        } as Placement;
      }
      const key = `${p.blockId}|${p.weekday}`;
      if (!m.has(key)) m.set(key, []);
      const cell = m.get(key)!;
      // One title per class in a cell, preferring the class's own row (a
      // click there adds work) over a retired card's title.
      if (!programScoped && isAwaitingActivity(item)) {
        const at = cell.findIndex(
          (other) => isAwaitingActivity(other) && classKey(other) === classKey(item!),
        );
        if (at >= 0) {
          const isCardTitle = (x: Placement) => "railedFrom" in x;
          if (isCardTitle(cell[at]) && !isCardTitle(item)) cell[at] = item;
          continue;
        }
      }
      cell.push(item);
    }
    return m;
  }, [weekPlacements, lens, groupKey, teacherKey, homeworkBlockIds, programScoped]);

  // Gives (TRA-582): linked ones by class cell, unlinked ones by day for the
  // All day row and the Other times strip. All in the current lens.
  const { givesByCell, allDayByDay, otherByDay } = useMemo(() => {
    const byCell = new Map<string, GridGive[]>();
    const allDay = new Map<number, GridGive[]>();
    const other = new Map<number, GridGive[]>();
    const lensKey = lens === "group" ? groupKey : teacherKey;
    const clocked = withGiveClock(grid?.gives ?? [], nowMs, grid?.closureTimeZone ?? DEFAULT_TIMEZONE);
    // The teacher lens doesn't separate groups: one card per give there.
    const visible = lens === "teacher" ? onePerGive(clocked) : clocked;
    for (const give of visible) {
      if (!giveInLens(give, lens, lensKey)) continue;
      const [map, key] =
        give.place === "class"
          ? [byCell, `${give.blockId}|${give.weekday}`]
          : [give.place === "allDay" ? allDay : other, give.weekday];
      const m = map as Map<typeof key, GridGive[]>;
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(give);
    }
    return { givesByCell: byCell, allDayByDay: allDay, otherByDay: other };
  }, [grid?.gives, grid?.closureTimeZone, lens, groupKey, teacherKey, nowMs]);
  // Up next shows on a meeting in the lens that hasn't ended and has no gives.
  const upNextByCell = useMemo(() => {
    const m = new Map<string, GridClassMeeting[]>();
    const lensKey = lens === "group" ? groupKey : teacherKey;
    const given = givenMeetingKeys(grid?.gives ?? []);
    for (const meeting of grid?.classMeetings ?? []) {
      if (!meeting.upNext || meeting.endsAt <= nowMs) continue;
      const inLens =
        lens === "group"
          ? String(meeting.groupId) === lensKey
          : String(meeting.teacherId) === lensKey;
      if (!inLens || given.has(`${meeting.classId}|${meeting.dayKey}`)) continue;
      const key = `${meeting.blockId}|${meeting.weekday}`;
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(meeting);
    }
    return m;
  }, [grid?.classMeetings, grid?.gives, lens, groupKey, teacherKey, nowMs]);
  const myId = currentUser?._id ? String(currentUser._id) : null;
  const canDragGive = useCallback(
    (give: GridGive) =>
      !programScoped &&
      give.movable &&
      myId != null &&
      String(give.assignmentTeacherId) === myId,
    [programScoped, myId],
  );
  const onGiveUpNext = useCallback(
    async (meeting: GridClassMeeting) => {
      if (!meeting.upNext) return;
      try {
        await giveToClass({
          classId: meeting.classId,
          dayKey: meeting.dayKey,
          work: { kind: "activity", activityId: meeting.upNext.activityId },
        });
      } catch (err) {
        toaster.create({
          title: "Couldn't give it",
          description: serverErrorMessage(err, "Check your connection and try again."),
          type: "error",
        });
      }
    },
    [giveToClass],
  );
  // The All day row takes a dragged give on a day that hasn't started.
  const allDayDropKey = useCallback(
    (weekday: number) => {
      const tz = grid?.closureTimeZone ?? DEFAULT_TIMEZONE;
      const dayKey = dayKeyForTimezone(
        anchorWeekStartMs + (weekday - 1) * DAY_MS + DAY_MS / 2,
        tz,
      );
      return dayKey > dayKeyForTimezone(nowMs, tz) ? dayKey : null;
    },
    [anchorWeekStartMs, grid?.closureTimeZone, nowMs],
  );
  const hasOtherTimes = useMemo(
    // A closed day draws as closed, so its gives don't open the row.
    () =>
      visibleDays.some(
        (d) => !closuresByWeekday.has(d.n) && (otherByDay.get(d.n) ?? []).length > 0,
      ),
    [visibleDays, otherByDay, closuresByWeekday],
  );
  const hasAllDay = useMemo(
    // A closed day draws as closed, so its gives don't open the row.
    () =>
      visibleDays.some(
        (d) => !closuresByWeekday.has(d.n) && (allDayByDay.get(d.n) ?? []).length > 0,
      ),
    [visibleDays, allDayByDay, closuresByWeekday],
  );

  // ── Homework due rail (Q3) ─────────────────────────────────────────────────
  // Homework lives on a virtual per-term block (kind "homework"); it renders as
  // a top-of-day DUE RAIL, not a bell-schedule row. Split the blocks so the rail
  // holds those placements and the grid shows only real class blocks.
  const homeworkBlockId = useMemo(
    () => [...homeworkBlockIds][0] ?? null,
    [homeworkBlockIds],
  );
  // Discoverability: the due rail only renders when a homework block exists, but
  // that block is otherwise created lazily on the FIRST homework placement — so a
  // term with a bell schedule but no homework yet shows no rail and no way to add
  // any. Provision the term's virtual homework block once (idempotent
  // find-or-create) so the rail is always present with its inviting empty cells.
  // Scope to terms that already have a bell schedule: a brand-new term with no
  // blocks at all must keep its "add a bell schedule" empty state (adding a lone
  // homework block would bypass that onboarding, and the rail sits atop the bell
  // schedule anyway). Teacher-only + best-effort: non-teacher viewers simply
  // no-op. Guarded per-term so it fires at most once.
  const ensuredRailTermsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (programScoped) return;
    if (!termId || grid == null || homeworkBlockId) return;
    const hasBellSchedule = (grid.blocks ?? []).some((b) => b.kind !== "homework");
    if (!hasBellSchedule) return;
    const key = String(termId);
    if (ensuredRailTermsRef.current.has(key)) return;
    ensuredRailTermsRef.current.add(key);
    // Best-effort, at most once per mount: a viewer without teacher rights can't
    // provision (and simply won't see the empty rail). Swallow so it never loops.
    ensureHomeworkRail({ periodId: termId }).catch(() => {});
  }, [termId, grid, homeworkBlockId, ensureHomeworkRail, programScoped]);
  const bellBlocks = useMemo(
    () => (grid?.blocks ?? []).filter((b) => b.kind !== "homework"),
    [grid?.blocks],
  );
  // Whether the term has any real content on the homework rail (a due chip or a
  // shelved one). An auto-provisioned but empty homework block is NOT content —
  // it must not, on its own, suppress the "add a bell schedule" onboarding.
  const hasAnyHomework = useMemo(
    () =>
      (grid?.placements ?? []).some((p) => p.mode === "homework") ||
      (grid?.homeworkDue ?? []).length > 0,
    [grid?.placements, grid?.homeworkDue],
  );
  const homeworkDueByDay = useMemo(() => {
    const m = new Map<number, HomeworkDueProjection[]>();
    for (const item of grid?.homeworkDue ?? []) {
      const inLens =
        lens === "group"
          ? String(item.groupId) === groupKey
          : String(item.teacherId) === teacherKey;
      if (!inLens) continue;
      if (!m.has(item.weekday)) m.set(item.weekday, []);
      m.get(item.weekday)!.push(item);
    }
    return m;
  }, [grid?.homeworkDue, lens, groupKey, teacherKey]);
  // Each Homework due card drags as the grid placement it stands in for, so
  // a drop moves that placement like any other card. Work given from its
  // assignment page has no placement (null) and doesn't drag.
  const homeworkDueLinks = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const item of grid?.homeworkDue ?? []) {
      m.set(
        item.key,
        linkedPlacementIdForProjection(grid?.placements ?? [], item, anchorWeekStartMs),
      );
    }
    return m;
  }, [grid?.homeworkDue, grid?.placements, anchorWeekStartMs]);
  const homeworkByDay = useMemo(() => {
    const m = new Map<number, Placement[]>();
    const projectedKeys = new Set(
      (grid?.homeworkDue ?? []).map(
        (item) =>
          `${item.assignmentId}:${item.activityId}:${item.groupId}`,
      ),
    );
    for (const p of weekPlacements) {
      if (p.onShelf || p.weekday == null) continue;
      // The server places each chip by its give's finish (`railWeekday`): the
      // homework block's own chips, and class-cell chips due by a date. An
      // older backend without the field keeps the homework-block rule.
      const railDay =
        p.railWeekday !== undefined
          ? p.railWeekday
          : homeworkBlockIds.has(String(p.blockId))
            ? p.weekday
            : null;
      if (railDay == null) continue;
      if (
        p.assignmentId &&
        p.activityId &&
        projectedKeys.has(`${p.assignmentId}:${p.activityId}:${p.groupId}`)
      ) {
        continue;
      }
      const inLens =
        lens === "group" ? String(p.groupId) === groupKey : String(p.teacherId) === teacherKey;
      if (!inLens) continue;
      if (!m.has(railDay)) m.set(railDay, []);
      m.get(railDay)!.push(p);
    }
    return m;
  }, [
    grid?.homeworkDue,
    weekPlacements,
    homeworkBlockIds,
    lens,
    groupKey,
    teacherKey,
  ]);

  const askBot = useCallback((text: string) => aide.seedComposer(text), [aide]);
  const handleProgramHandoutRemove = useCallback(
    async (placementId: string) => {
      const placement = grid?.placements.find(
        (candidate) => String(candidate._id) === placementId,
      );
      if (!placement?.activityId || !placement.assignmentId || !placement.isProgramHandout) {
        return;
      }
      try {
        await removeProgramHandoutPlacement({
          placementId: placement._id,
          activityId: placement.activityId,
          assignmentId: placement.assignmentId,
        });
      } catch (err) {
        toaster.create({ title: "Remove failed", description: String(err), type: "error" });
      }
    },
    [grid?.placements, removeProgramHandoutPlacement],
  );

  const groupEmojiById = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const g of grid?.groups ?? []) m.set(String(g._id), g.emoji);
    for (const g of groupOptions) if (!m.has(g.id)) m.set(g.id, g.emoji);
    return m;
  }, [grid?.groups, groupOptions]);

  const selectedGroup = groupOptions.find((g) => g.id === groupKey) ?? null;
  const selectedTeacher = teacherOptions.find((t) => String(t._id) === teacherKey) ?? null;
  const programDialogGroup =
    groupOptions.find((group) => group.id === programDialogTarget?.groupId) ??
    null;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <Flex direction="column" h="full" overflow="hidden" bg="white">
      {/* Header rail: view toggle · date/term · span · lens · stamp (one bar) */}
      <Flex
        px={3}
        py={2}
        align="center"
        gap={3}
        borderBottom="1px solid"
        borderColor="gray.100"
        flexWrap="wrap"
        flexShrink={0}
      >
        {viewToggle ? (
          <>
            {viewToggle}
            <Box w="1px" h="20px" bg="gray.200" />
          </>
        ) : null}

        <DateTermPicker
          terms={terms ?? []}
          currentTerm={currentTerm}
          termId={termId}
          anchorMs={anchorMs}
          scheduleMode={scheduleMode}
          onAnchorChange={setAnchorMs}
          onPrevious={goToPreviousSpan}
          onNext={goToNextSpan}
          onToday={goToToday}
        />

        <Box w="1px" h="20px" bg="gray.200" />

        {/* Program staff stay on their explicitly granted group lens. */}
        {!programScoped && (
          <HStack gap={1} p={1} bg="gray.100" borderRadius="full" display="inline-flex">
            <LensButton active={lens === "group"} onClick={() => setLens("group")}>
              By group
            </LensButton>
            <LensButton active={lens === "teacher"} onClick={() => setLens("teacher")}>
              By teacher
            </LensButton>
          </HStack>
        )}

        {programScoped || lens === "group" ? (
          <PillPicker
            label={selectedGroup ? `${selectedGroup.emoji ? selectedGroup.emoji + " " : ""}${selectedGroup.name}` : "Pick a group"}
            emptyText="No groups"
          >
            {groupOptions.map((g) => (
              <Menu.Item key={g.id} value={g.id} cursor="pointer" onClick={() => setGroupKey(g.id)}>
                <HStack w="full" gap={2}>
                  <Text flex={1} lineClamp={1}>{g.emoji ? `${g.emoji} ` : ""}{g.name}</Text>
                  {groupKey === g.id && <Check size={13} />}
                </HStack>
              </Menu.Item>
            ))}
          </PillPicker>
        ) : (
          <PillPicker
            label={selectedTeacher ? (String(selectedTeacher._id) === meId ? "Me" : selectedTeacher.name) : "Pick a teacher"}
            emptyText="No teachers scheduled"
          >
            {teacherOptions.length > 0 ? (
              <TeacherMenuItems teachers={teacherOptions} selectedId={teacherKey} onSelect={setTeacherKey} meId={meId} />
            ) : null}
          </PillPicker>
        )}

        <Box flex={1} />

        {!programScoped && (
          <BirthdayRosterDialog institutionScope={scopeParam} />
        )}

      </Flex>

      {loading ? (
        <Flex flex={1} align="center" justify="center" color="charcoal.300">
          Loading schedule…
        </Flex>
      ) : noTermConfigured ? (
        <Flex flex={1} align="center" justify="center">
          <PrimitiveEmptyState
            size="lg"
            icon={<CalendarBlank weight="duotone" />}
            title={
              programScoped
                ? "No program schedule yet"
                : "No reporting period yet"
            }
            hint={
              programScoped
                ? "A teacher sets up the school timetable. Your assigned programs will appear here when it is ready."
                : "The Schedule shares its term windows with Reports — set one up to start placing classes into it."
            }
            cta={
              programScoped
                ? undefined
                : {
                    label: "Set up a reporting period",
                    icon: <Plus size={14} />,
                    onClick: () => setNewPeriodOpen(true),
                    primary: true,
                  }
            }
          />
        </Flex>
      ) : bellBlocks.length === 0 && !hasAnyHomework ? (
        <EmptyState programScoped={programScoped} />
      ) : (
        <DndContext sensors={programScoped ? NO_SENSORS : sensors} collisionDetection={scheduleCollisionDetection} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={onDragCancel} measuring={DROP_MEASURING}>
          <Flex flex={1} overflow="hidden">
            {/* Grid */}
            <Box flex={1} overflow="auto" p={3}>
              <Box
                display="grid"
                gridTemplateColumns={`140px repeat(${visibleDays.length}, minmax(150px, 1fr))`}
                gap={1.5}
                minW="fit-content"
              >
                {/* Header row */}
                <Box />
                {visibleDays.map((d) => {
                  const closure = closuresByWeekday.get(d.n);
                  const bdays = birthdaysByWeekday.get(d.n) ?? [];
                  return (
                    <Flex key={d.n} direction="column" align="center" py={1} gap={0.5}>
                      <Text fontFamily="heading" fontWeight="700" fontSize="sm" color={closure ? "charcoal.300" : "navy.600"} textAlign="center">
                        {dayColumnLabel(d, weekStartMs, scheduleMode)}
                      </Text>
                      {closure && (
                        <Text
                          fontSize="2xs"
                          fontWeight="700"
                          color="charcoal.400"
                          textAlign="center"
                          lineClamp={1}
                          title={`${closure.kind === "staffOnly" ? "Staff development day" : "No school"} — ${closure.label}`}
                        >
                          {closure.kind === "staffOnly" ? "Staff only" : "No school"} · {closure.label}
                        </Text>
                      )}
                      {bdays.length > 0 && (
                        <Text
                          fontSize="2xs"
                          fontWeight="700"
                          color="violet.600"
                          textAlign="center"
                          lineClamp={1}
                          title={bdays.map(formatBirthdayCell).join(", ")}
                        >
                          🎂{" "}
                          {scheduleMode === "day"
                            ? bdays.map(formatBirthdayCell).join(" · ")
                            : bdays.map((b) => b.name).join(" · ")}
                        </Text>
                      )}
                    </Flex>
                  );
                })}

                {/* Homework due rail — top of day, above the bell schedule. Always
                    shown when the term has a homework block, in every lens, so it
                    doesn't vanish for a teacher (or group) with no homework yet —
                    empty cells just invite adding some. */}
                {homeworkBlockId && (
                  <>
                    <Flex direction="column" justify="center" px={2} py={2}>
                      <Text fontFamily="heading" fontWeight="700" fontSize="sm" color="navy.700" lineClamp={1}>
                        Homework due
                      </Text>
                      <Text fontSize="2xs" color="charcoal.300">
                        turned in that day
                      </Text>
                    </Flex>
                    {visibleDays.map((d) =>
                      closuresByWeekday.has(d.n) ? (
                        <ClosedCell key={`hw-${d.n}`} />
                      ) : (
                        <ScheduleCell
                          key={`hw-${d.n}`}
                          dropId={cellId(homeworkBlockId, d.n)}
                          zone="homework"
                          isBreak={false}
                          fusable={false}
                          items={homeworkByDay.get(d.n) ?? []}
                          homeworkDueItems={homeworkDueByDay.get(d.n) ?? []}
                          homeworkDueLinks={homeworkDueLinks}
                          draggable={!programScoped}
                          isJustDragged={isJustDragged}
                          lens={lens}
                                          groupEmojiById={groupEmojiById}
                          onQuickAdd={() => {
                            if (programScoped && selectedGroup) {
                              setProgramDialogTarget({
                                groupId: selectedGroup.id,
                                subject: selectedGroup.name,
                                scheduleTarget: {
                                  mode: "homework",
                                  dueDateMs:
                                    anchorWeekStartMs + (d.n - 1) * DAY_MS,
                                },
                              });
                              return;
                            }
                            setQuickAdd({ kind: "homework", weekday: d.n });
                          }}
                          onOpenDetail={openDetail}
                          onFillSlot={
                            programScoped ? openProgramWork : openFillSlot
                          }
                        />
                      ),
                    )}
                  </>
                )}

                {/* All day row: unlinked gives whose window covers the
                    school day (TRA-582). Shown in a week that has some, and
                    while a give is dragged, since it takes a drop. */}
                {(hasAllDay || draggedGridGive != null) && (
                  <>
                    <GiveRowLabel title="All day" hint="the whole school day" />
                    {visibleDays.map((d) =>
                      closuresByWeekday.has(d.n) ? (
                        <ClosedCell key={`allday-${d.n}`} />
                      ) : (
                        <GiveStripCell
                          key={`allday-${d.n}`}
                          gives={allDayByDay.get(d.n) ?? []}
                          lens={lens}
                          groupEmojiById={groupEmojiById}
                          dropId={`allday:${d.n}`}
                          dropDayKey={programScoped ? null : allDayDropKey(d.n)}
                          canDragGive={canDragGive}
                          isJustDragged={isJustDragged}
                        />
                      ),
                    )}
                  </>
                )}

                {/* Block rows */}
                {bellBlocks.map((block) => (
                  <BlockRow
                    key={String(block._id)}
                    block={block}
                    days={visibleDays}
                    closedByWeekday={closuresByWeekday}
                    cellPlacements={cellPlacements}
                    givesByCell={givesByCell}
                    upNextByCell={upNextByCell}
                    meetingFor={meetingFor}
                    canDragGive={canDragGive}
                    onGiveUpNext={programScoped ? undefined : onGiveUpNext}
                    isJustDragged={isJustDragged}
                    nowMs={nowMs}
                    coverageByCell={coverageByCell}
                    conflictedPlacementIds={conflictedPlacementIds}
                    groupEmojiById={groupEmojiById}
                    lens={lens}
                              draggable={!programScoped}
                    onOpenDetail={openDetail}
                    onFillSlot={(p) => {
                      // A railed card's class title opens the real card's
                      // drawer; the class is already filled.
                      const railedFrom = (p as Placement & { railedFrom?: string }).railedFrom;
                      if (railedFrom) {
                        openDetail({ kind: "placement", placementId: railedFrom }, railedFrom);
                        return;
                      }
                      (programScoped ? openProgramWork : openFillSlot)(p);
                    }}
                  />
                ))}

                {/* Other times: gives at a time outside any class. Shown only
                    in a week that has some. */}
                {hasOtherTimes && (
                  <>
                    <GiveRowLabel title="Other times" hint="outside any class" />
                    {visibleDays.map((d) =>
                      closuresByWeekday.has(d.n) ? (
                        <ClosedCell key={`other-${d.n}`} />
                      ) : (
                      <GiveStripCell
                        key={`other-${d.n}`}
                        dropId={`other:${d.n}`}
                        gives={otherByDay.get(d.n) ?? []}
                        lens={lens}
                        groupEmojiById={groupEmojiById}
                        canDragGive={canDragGive}
                        isJustDragged={isJustDragged}
                      />
                      ),
                    )}
                  </>
                )}
              </Box>
            </Box>

          </Flex>

          <DragOverlay dropAnimation={null}>
            {draggedGridGive ? (
              <GiveCard
                give={draggedGridGive}
                lens={lens}
                groupEmoji={groupEmojiById.get(String(draggedGridGive.groupId))}
              />
            ) : draggedGive ? (
              <EnrichedChip
                p={draggedGive}
                lens={lens}
                groupEmoji={groupEmojiById.get(String(draggedGive.groupId))}
                dragging
              />
            ) : dragId && placementsById.get(dragId) ? (
              isAwaitingActivity(placementsById.get(dragId)!) ? (
                <Box bg="white" borderRadius="md" boxShadow="lg" w="full">
                  <ChipBody
                    p={placementsById.get(dragId)!}
                    lens={lens}
                    groupEmojiById={groupEmojiById}
                    asBlockTitle
                  />
                </Box>
              ) : (
                <ChipBody p={placementsById.get(dragId)!} lens={lens} groupEmojiById={groupEmojiById} dragging />
              )
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      {!programScoped && quickAdd && (
        <QuickAddPalette
          onClose={() => setQuickAdd(null)}
          target={quickAdd}
          dayLabel={new Date(anchorWeekStartMs + (quickAdd.weekday - 1) * DAY_MS + DAY_MS / 2)
            .toLocaleDateString("en-US", {
              weekday: "long",
              timeZone: grid?.closureTimeZone ?? DEFAULT_TIMEZONE,
            })}
          groupOptions={groupOptions}
          classOptions={classOptions}
          defaultGroupId={
            quickAdd.kind === "class"
              ? quickAdd.groupId
              : lens === "group"
                ? groupKey
                : groupOptions[0]?.id ?? ""
          }
          onSubmit={async ({ work, classId }) => {
            const dayKey = dayKeyForTimezone(
              anchorWeekStartMs + (quickAdd.weekday - 1) * DAY_MS + DAY_MS / 2,
              grid?.closureTimeZone ?? DEFAULT_TIMEZONE,
            );
            try {
              if (quickAdd.kind === "homework") {
                await giveHomework({
                  classId: classId as Id<"classes">,
                  dueDayKey: dayKey,
                  work,
                });
                setQuickAdd(null);
                return;
              }
              // Adding work to a class meeting gives it to that class on that
              // day (TRA-582), the same write as Up next.
              const meeting = meetingFor(quickAdd.groupId, quickAdd.blockId, quickAdd.weekday);
              if (!meeting) {
                // A one-week move leaves this cell with no meeting that day.
                toaster.create({
                  title: "This class doesn't meet then",
                  description: "Give it from a class meeting on the grid, or from the unit's Run page.",
                  type: "info",
                });
              } else {
                await giveToClass({ classId: meeting.classId, dayKey: meeting.dayKey, work });
              }
              setQuickAdd(null);
            } catch (err) {
              toaster.create({
                title: quickAdd.kind === "homework" ? "Couldn't give homework" : "Couldn't add work",
                description: serverErrorMessage(err, "Check your connection and try again."),
                type: "error",
              });
            }
          }}
        />
      )}

      {!programScoped && (
        <CreatePeriodDialog
          open={newPeriodOpen}
          onClose={() => setNewPeriodOpen(false)}
          onCreated={() => setNewPeriodOpen(false)}
        />
      )}

      {/* Click-through detail drawer — stably mounted at the view root (never
          keyed/remounted while open; the Ark body-lock rule). */}
      <PlacementDetailDrawer
        target={drawerTarget}
        grid={grid ?? undefined}
        lens={lens}
        variant={programScoped ? "program" : "teacher"}
        onClose={closeDetail}
        onAskBot={programScoped ? undefined : askBot}
        onRemove={programScoped ? handleProgramHandoutRemove : undefined}
      />

      <StartAssignmentDialog
        open={
          programScoped &&
          programDialogGroup !== null &&
          termId !== null
        }
        onClose={() => setProgramDialogTarget(null)}
        programTarget={
          programDialogGroup && programDialogTarget && termId
            ? {
                groupId: programDialogGroup.id as Id<"scholarGroups">,
                groupName: programDialogGroup.name,
                periodId: termId,
                subject:
                  programDialogTarget?.subject ?? programDialogGroup.name,
                timeZone: grid?.closureTimeZone,
                scheduleTarget: programDialogTarget.scheduleTarget,
              }
            : undefined
        }
        contextText={
          programDialogGroup
            ? `Choose existing work or create a handout for ${programDialogGroup.name}.`
            : undefined
        }
      />
    </Flex>
  );
}

// ── Block row ────────────────────────────────────────────────────────────────

/**
 * A read-only "no school" cell rendered in every block row of a closed column.
 * Non-interactive (no quick-add, not a drop target) so nothing can be scheduled
 * onto a holiday; the column header carries the closure's label.
 */
function ClosedCell({ isBreak }: { isBreak?: boolean }) {
  return (
    <Box
      borderRadius="md"
      minH="56px"
      bg={isBreak ? "gray.100" : "gray.50"}
      border="1px dashed"
      borderColor="gray.200"
      backgroundImage="repeating-linear-gradient(135deg, transparent, transparent 7px, rgba(0,0,0,0.03) 7px, rgba(0,0,0,0.03) 14px)"
      aria-label="No school"
    />
  );
}

function BlockRow({
  block,
  days,
  closedByWeekday,
  cellPlacements,
  givesByCell,
  upNextByCell,
  meetingFor,
  canDragGive,
  onGiveUpNext,
  isJustDragged,
  nowMs,
  coverageByCell,
  conflictedPlacementIds,
  groupEmojiById,
  lens,
  draggable,
  onOpenDetail,
  onFillSlot,
}: {
  block: Block;
  days: Weekday[];
  closedByWeekday: Map<number, SchoolClosure>;
  cellPlacements: Map<string, Placement[]>;
  givesByCell: Map<string, GridGive[]>;
  upNextByCell: Map<string, GridClassMeeting[]>;
  meetingFor: (groupId: string, blockId: string, weekday: number) => GridClassMeeting | null;
  canDragGive: (give: GridGive) => boolean;
  /** Absent on the program grid: its staff give through their own dialog. */
  onGiveUpNext?: (meeting: GridClassMeeting) => void;
  isJustDragged: () => boolean;
  nowMs: number;
  coverageByCell: Map<string, GridData["coverage"][number]>;
  conflictedPlacementIds: Set<string>;
  groupEmojiById: Map<string, string | null>;
  lens: Lens;
  draggable: boolean;
  onOpenDetail: (t: DrawerTarget, triggerToken: string) => void;
  onFillSlot: (p: Placement) => void;
}) {
  const isBreak = block.kind === "recess" || block.kind === "lunch";
  // Only a class block takes an activity or an app; recess, lunch and prep
  // rows keep bare staffing rows only (assertBlockTakesPlacement). So they
  // refuse a dropped card and don't offer to fill a slot. Anything already in
  // one still shows.
  const takesClasses = (block.kind ?? "class") === "class";
  return (
    <>
      {/* Row label */}
      <Flex direction="column" justify="center" px={2} py={2} borderRadius="md" bg={isBreak ? "gray.50" : "transparent"}>
        <Text fontFamily="heading" fontWeight="700" fontSize="sm" color="navy.700" lineClamp={1}>
          {block.label}
        </Text>
        <Text fontSize="2xs" color="charcoal.300">
          {fmtTimeRange(block.startLocal, block.endLocal)}
        </Text>
      </Flex>

      {/* Weekday cells */}
      {days.map((d) => {
        if (closedByWeekday.has(d.n)) return <ClosedCell key={d.n} isBreak={isBreak} />;
        const key = `${block._id}|${d.n}`;
        const items = cellPlacements.get(key) ?? [];
        const coverage = coverageByCell.get(key);
        return (
          <ScheduleCell
            key={d.n}
            dropId={cellId(String(block._id), d.n)}
            zone="class"
            isBreak={isBreak}
            takesClasses={takesClasses}
            items={items}
            gives={givesByCell.get(key) ?? []}
            upNext={upNextByCell.get(key) ?? []}
            takesGive={(give) => {
              const meeting = meetingFor(String(give.groupId), String(block._id), d.n);
              return meeting != null && meeting.endsAt > nowMs;
            }}
            canDragGive={canDragGive}
            onGiveUpNext={onGiveUpNext}
            isJustDragged={isJustDragged}
            coverage={coverage}
            conflictedPlacementIds={conflictedPlacementIds}
            lens={lens}
              draggable={draggable}
            groupEmojiById={groupEmojiById}
            onOpenDetail={onOpenDetail}
            onFillSlot={onFillSlot}
          />
        );
      })}
    </>
  );
}

// ── One droppable cell ───────────────────────────────────────────────────────

function ScheduleCell({
  dropId,
  zone,
  isBreak,
  takesClasses = true,
  fusable = true,
  items,
  gives = [],
  upNext = [],
  takesGive,
  canDragGive,
  onGiveUpNext,
  homeworkDueItems = [],
  homeworkDueLinks,
  isJustDragged,
  coverage,
  conflictedPlacementIds,
  lens,
  draggable = true,
  groupEmojiById,
  onQuickAdd,
  onOpenDetail,
  onFillSlot,
}: {
  dropId: string;
  zone: DropZone;
  isBreak: boolean;
  /** False for a recess, lunch or prep row: refuses a dragged card that
   *  carries work, and offers no slot fill. */
  takesClasses?: boolean;
  fusable?: boolean;
  items: Placement[];
  /** The gives linked to this class meeting (TRA-582). */
  gives?: GridGive[];
  /** Meetings here that offer their class's next activity. */
  upNext?: GridClassMeeting[];
  /** Whether a dragged give can land here: a class cell takes only a
   *  meeting of the give's own group that hasn't ended. The Homework due
   *  row takes any. */
  takesGive?: (give: GridGive) => boolean;
  canDragGive?: (give: GridGive) => boolean;
  onGiveUpNext?: (meeting: GridClassMeeting) => void;
  homeworkDueItems?: HomeworkDueProjection[];
  /** Homework due card key → the placement it drags as (null: not movable). */
  homeworkDueLinks?: Map<string, string | null>;
  /** True right after a drag, so its trailing click doesn't open the link. */
  isJustDragged?: () => boolean;
  coverage?: GridData["coverage"][number];
  /** Ids of every placement party to a double-booking (union of grid.conflicts'
   *  placementIds). The cell shows the conflict badge iff one of ITS rendered
   *  items is in this set — so the badge coincides with the drawer's per-chip
   *  conflict section. Omitted by the homework rail (no conflict badge there). */
  conflictedPlacementIds?: Set<string>;
  lens: Lens;
  draggable?: boolean;
  groupEmojiById: Map<string, string | null>;
  /** The homework rail's add flow (absent on class rows, which only fill an
   *  existing class slot; class slots are edited on School › Classes & times). */
  onQuickAdd?: () => void;
  onOpenDetail: (t: DrawerTarget, triggerToken: string) => void;
  onFillSlot?: (p: Placement) => void;
  /** Opens the class drawer for this cell's class. Absent on the homework rail
   *  (not a class) — its presence is what shows the class-open chevron. */
}) {
  // A give dragged from the Homework due row only moves between days: class
  // cells stop being targets and fade while it's in the air.
  const { active } = useDndContext();
  const draggedGive = activeGive(active?.data.current);
  const refusesDrag =
    (draggedGive != null &&
      zone === "class" &&
      !(takesGive?.(draggedGive) ?? false)) ||
    (!takesClasses &&
      (active?.data.current as { carriesWork?: boolean } | undefined)?.carriesWork === true) ||
    (zone === "class" &&
      (active?.data.current as { kind?: string } | undefined)?.kind === "give");
  const { setNodeRef, isOver } = useDroppable({
    id: dropId,
    data: { zone },
    disabled: refusesDrag,
  });
  const understaffed = coverage && !coverage.ok;
  // This cell is in conflict iff one of the chips IT renders is party to a
  // double-booking (not merely because some other group shares the slot). Name
  // the teacher when every conflicted chip here is the same one (the common
  // case: one teacher double-booked); fall back to the generic label otherwise.
  const conflictedItems = conflictedPlacementIds
    ? items.filter((p) => conflictedPlacementIds.has(String(p._id)))
    : [];
  const hasConflict = conflictedItems.length > 0;
  const conflictTeacherNames = Array.from(
    new Set(
      conflictedItems
        .map((p) => p.teacherName)
        .filter((n): n is string => Boolean(n)),
    ),
  );
  const conflictLabel =
    conflictTeacherNames.length === 1
      ? `Double-booked: ${conflictTeacherNames[0]}`
      : "Double-booked teacher in this slot";
  // Bare classes (no linked activity) render as passive block titles; anything with
  // real content renders as a draggable activity card. The "add an activity" hint
  // shows whenever the block has no activity card yet — including a titled-but-empty
  // block like "Science" awaiting its work.
  const blockTitles = items.filter((p) => isAwaitingActivity(p));
  const activityCards = items.filter((p) => !isAwaitingActivity(p));
  // Class keys named by a HEADER in this cell (the bare recurring rows rendered
  // as block titles). An activity card whose class matches drops its own subject
  // eyebrow so the class isn't named twice stacked (T3 — see the compact chip).
  const headerClassKeys = new Set(blockTitles.map((p) => classKey(p)));
  const isEmpty =
    items.length === 0 && homeworkDueItems.length === 0 && gives.length === 0;

  // Coverage / conflict badges — small icons that stay as absolute top-right
  // overlays.
  const cornerBadges = (understaffed || hasConflict) && (
    <HStack position="absolute" top={1} right={1} gap={1}>
      {hasConflict && (
        // A real control, not a bare `title`: the native tooltip took a second
        // of stillness, never appeared on touch, and nothing said the icon
        // meant anything. Hover/focus names the problem at once; a click
        // opens the conflicted card's drawer, whose conflict section says who
        // else the teacher is booked with and offers the aide.
        <Tooltip.Root openDelay={100} closeDelay={0}>
          <Tooltip.Trigger asChild>
            <chakra.button
              type="button"
              aria-label={`${conflictLabel}. Show details`}
              color="red.500"
              cursor="pointer"
              display="flex"
              borderRadius="sm"
              _hover={{ color: "red.600" }}
              _focusVisible={{ outline: "2px solid", outlineColor: "red.400" }}
              // Keep the press from starting a drag.
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                const id = String(conflictedItems[0]._id);
                onOpenDetail({ kind: "placement", placementId: id }, id);
              }}
            >
              <Warning size={13} weight="fill" />
            </chakra.button>
          </Tooltip.Trigger>
          <Portal>
            <Tooltip.Positioner>
              <Tooltip.Content fontFamily="heading" fontSize="xs">
                {conflictLabel}. Click for details
              </Tooltip.Content>
            </Tooltip.Positioner>
          </Portal>
        </Tooltip.Root>
      )}
      {understaffed && (
        <Box
          title={`Understaffed: ${coverage!.have}/${coverage!.need} adults`}
          fontSize="2xs"
          fontWeight="700"
          color="orange.600"
          bg="orange.50"
          borderRadius="sm"
          px={1}
        >
          {coverage!.have}/{coverage!.need}
        </Box>
      )}
    </HStack>
  );

  // Borderless — the page shows through and the activity card is the one solid
  // object. Empty cells get a hairline baseline.
  // A cell holding only bare slots (no activity card) is an OPEN target: it reads
  // as an empty, dashed placeholder — distinct from a filled cell's solid card — so
  // full vs empty is legible at a glance.
  const awaitingOnly =
    activityCards.length === 0 && gives.length === 0 && blockTitles.length > 0;
  const isHomeworkRail = !fusable;
  // A filled class cell reads as full: the CELL itself becomes the solid white
  // card (border + bg live on the shell), mirroring how an awaiting slot's dashed
  // shell traces the whole cell — so filled and awaiting share the same box,
  // padding, and top-aligned content, differing only by fill state. This holds
  // whether the cell is a pure activity chip OR a class header + its activity
  // chip (a cascaded class slot keeps its recurring structure alongside the
  // concrete chip): any content that includes an activity card reads as filled,
  // never the borderless fallback. Not for the compact homework rail.
  const filled =
    !isHomeworkRail && (activityCards.length > 0 || gives.length > 0);
  const filledLive =
    filled &&
    (activityCards.some((p) => p.linkState === "live") ||
      gives.some((g) => g.state === "live"));
  const shell = isOver
    ? { border: "1px solid", borderColor: "violet.400", borderRadius: "md", bg: "violet.50" }
    : awaitingOnly
        ? {
            border: "1px dashed",
            borderColor: "gray.200",
            borderRadius: "md",
            bg: isBreak ? "gray.50" : "transparent",
          }
        : filled
          ? {
              border: "1px solid",
              borderColor: filledLive ? "green.300" : "gray.200",
              borderRadius: "md",
              bg: "white",
            }
          : isEmpty
            ? {
                borderBottom: "1px solid",
                borderColor: "gray.100",
                bg: isBreak ? "gray.50" : "transparent",
              }
            : {
                border: "1px solid",
                borderColor: "transparent",
                borderRadius: "md",
                bg: isBreak ? "gray.50" : "transparent",
              };
  // The grid is for putting ACTIVITIES into existing class slots — creating or
  // moving slots happens on School › Classes & times. So the cell has ONE click target,
  // derived from what it holds:
  //  • a class slot awaiting work → fill THAT slot. The whole cell is the target
  //    and it inherits the slot's own group, so it never defaults to the wrong
  //    group (the "asks me to add for Honu" bug).
  //  • an empty class cell → inert: you can't add an assignment where there's
  //    no class slot. Only the homework rail (fusable === false) owns an add flow.
  //  • a filled activity cell → defers to its card (which opens the detail drawer).
  const firstAwaiting = blockTitles[0];
  // A class meeting that already has gives still takes more work.
  const fillCell =
    activityCards.length === 0 &&
    blockTitles.length > 0 &&
    takesClasses &&
    onFillSlot &&
    firstAwaiting
      ? () => onFillSlot(firstAwaiting)
      : undefined;
  const addHere = isHomeworkRail ? onQuickAdd : undefined;
  const cellClick = fillCell ?? addHere;
  const hoverable =
    activityCards.length === 0 &&
    gives.length === 0 &&
    homeworkDueItems.length === 0 &&
    Boolean(cellClick);
  return (
    <Box
      ref={setNodeRef}
      position="relative"
      minH="64px"
      opacity={refusesDrag ? 0.45 : undefined}
      p={1}
      display="flex"
      flexDirection="column"
      gap={1}
      {...shell}
      overflow={filled ? "hidden" : undefined}
      transition="background 0.1s, border-color 0.1s"
      role={cellClick ? "button" : undefined}
      tabIndex={cellClick ? 0 : undefined}
      aria-label={
        fillCell
          ? `Add work to ${firstAwaiting!.subject}`
          : addHere
            ? "Give homework due this day"
            : undefined
      }
      cursor={cellClick ? "pointer" : "default"}
      _hover={hoverable ? { bg: "gray.50" } : undefined}
      onClick={cellClick}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (cellClick && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          cellClick();
        }
      }}
    >
      <VStack align="stretch" gap={filled ? 0 : 1} flex={1}>
        {homeworkDueItems.map((item) => (
          <HomeworkDueCard
            key={item.key}
            item={item}
            placementId={homeworkDueLinks?.get(item.key) ?? null}
            draggable={draggable}
            lens={lens}
            groupEmojiById={groupEmojiById}
            isJustDragged={isJustDragged}
          />
        ))}
        {blockTitles.map((p, index) => (
          <PlacementChip
            key={String(p._id)}
            p={p}
            lens={lens}
            groupEmojiById={groupEmojiById}
            enableBlockTitle
              draggable={draggable}
            compound={filled}
            separated={filled && index > 0}
            onOpenDetail={onOpenDetail}
            onFillSlot={takesClasses ? onFillSlot : undefined}
          />
        ))}
        {activityCards.map((p, index) => (
          <PlacementChip
            key={String(p._id)}
            p={p}
            lens={lens}
            groupEmojiById={groupEmojiById}
            fill={filled}
            compound={filled}
            separated={filled && (blockTitles.length > 0 || index > 0)}
            suppressSubjectEyebrow={headerClassKeys.has(classKey(p))}
            draggable={draggable}
            onOpenDetail={onOpenDetail}
          />
        ))}
        {gives.map((give, index) => (
          <GiveCard
            key={give.key}
            give={give}
            lens={lens}
            groupEmoji={giveGroupMark(give, groupEmojiById)}
            fill={filled}
            inClassCell
            separated={
              filled &&
              (blockTitles.length > 0 || activityCards.length > 0 || index > 0)
            }
            draggable={canDragGive?.(give) ?? false}
            isJustDragged={isJustDragged}
          />
        ))}
        {onGiveUpNext &&
          upNext.map((meeting) => (
            <UpNextButton
              key={`${meeting.classId}|${meeting.dayKey}`}
              meeting={meeting}
              onGive={onGiveUpNext}
            />
          ))}
      </VStack>

      {cornerBadges}

      {cellClick && activityCards.length === 0 && gives.length === 0 && (
        <HStack
          position="absolute"
          bottom={1}
          right={1}
          gap={0.5}
          pointerEvents="none"
          color="charcoal.300"
          fontSize="2xs"
          fontWeight="700"
          opacity={0.75}
        >
          <Plus size={15} weight="bold" />
        </HStack>
      )}
    </Box>
  );
}

// ── Homework due card ────────────────────────────────────────────────────────

/** A Homework due projection: a link to its assignment's Run page that
 *  drags like any card. With a grid placement it drags as that placement;
 *  without one (work given outside the grid) it drags as the give itself,
 *  and a drop on another day moves its finish there. The anchor's native
 *  link drag is always off, so a press-and-move never drags a URL ghost. */
function HomeworkDueCard({
  item,
  placementId,
  draggable,
  lens,
  groupEmojiById,
  isJustDragged,
}: {
  item: HomeworkDueProjection;
  placementId: string | null;
  draggable: boolean;
  lens: Lens;
  groupEmojiById: Map<string, string | null>;
  isJustDragged?: () => boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: placementId ?? `give:${item.key}`,
    data: placementId ? undefined : { kind: "give", item },
    disabled: !draggable,
  });
  const canDrag = draggable;
  return (
    <Box
      ref={canDrag ? setNodeRef : undefined}
      {...(canDrag ? attributes : {})}
      {...(canDrag ? listeners : {})}
      display="block"
      opacity={isDragging ? 0.4 : 1}
      cursor={canDrag ? (isDragging ? "grabbing" : "grab") : "pointer"}
      touchAction={canDrag ? "none" : undefined}
      data-detail-trigger={placementId ?? undefined}
    >
      <Link
        href={`/teacher/schedule/${item.assignmentId}`}
        draggable={false}
        // The card's grab hand, not the link's pointer: a press moves it.
        style={{ cursor: "inherit" }}
        onDragStart={(event) => event.preventDefault()}
        onClick={(event) => {
          event.stopPropagation();
          if (isJustDragged?.()) event.preventDefault();
        }}
      >
        <EnrichedChip
          p={item}
          lens={lens}
          groupEmoji={groupEmojiById.get(String(item.groupId))}
        />
      </Link>
    </Box>
  );
}

// ── Draggable placement chip ─────────────────────────────────────────────────

function PlacementChip({
  p,
  lens,
  groupEmojiById,
  enableBlockTitle,
  draggable = true,
  fill = false,
  compound = false,
  separated = false,
  suppressSubjectEyebrow,
  onOpenDetail,
  onFillSlot,
}: {
  p: Placement;
  lens: Lens;
  groupEmojiById: Map<string, string | null>;
  enableBlockTitle?: boolean;
  /** Whether this card can be dragged to re-time it. */
  draggable?: boolean;
  /** Stretch the filled activity card to fill its cell so a full block reads as
   *  full (matches the awaiting slot's full-cell shell). */
  fill?: boolean;
  /** This row is one action inside a shared class-slot shell. */
  compound?: boolean;
  /** Draw the boundary between this action and the preceding row. */
  separated?: boolean;
  /** Drop the class-subject eyebrow because this cell already renders the class's
   *  header (see the compact chip's prop). Only applies to the activity-card path
   *  — a block title never shows an eyebrow. */
  suppressSubjectEyebrow?: boolean;
  onOpenDetail: (t: DrawerTarget, triggerToken: string) => void;
  onFillSlot?: (p: Placement) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: String(p._id),
    data: { carriesWork: carriesWork(p) },
  });
  const placementId = String(p._id);
  // A bare class (no linked activity) reads as the block's TITLE, not an activity
  // card — an EMPTY slot rendered as a flat, full-bleed placeholder in its cell.
  // Flat + non-draggable; a click opens the quick activity picker to FILL the
  // slot (onFillSlot). Editing the slot itself happens on School › Classes & times.
  const asBlock = Boolean(enableBlockTitle) && isAwaitingActivity(p);
  if (asBlock) {
    // stopPropagation keeps this off the cell's own click target; clicking the
    // slot adds work to THAT class.
    if (onFillSlot) {
      return (
        <chakra.button
          type="button"
          w="full"
          px={0}
          pt="2px"
          pb={0}
          border={0}
          borderTopWidth={separated ? "1px" : "0"}
          borderTopColor="gray.100"
          bg="transparent"
          textAlign="left"
          cursor="pointer"
          transition="background 0.1s"
          _hover={compound ? { bg: "gray.50" } : undefined}
          _focusVisible={
            compound
              ? {
                  bg: "gray.50",
                  outline: "2px solid",
                  outlineColor: "violet.400",
                  outlineOffset: "-2px",
                }
              : undefined
          }
          aria-label={`Add work to ${p.subject}`}
          data-detail-trigger={placementId}
          onClick={(e) => {
            e.stopPropagation();
            onFillSlot(p);
          }}
        >
          <ChipBody p={p} lens={lens} groupEmojiById={groupEmojiById} asBlockTitle />
        </chakra.button>
      );
    }
    return <ChipBody p={p} lens={lens} groupEmojiById={groupEmojiById} asBlockTitle />;
  }
  // Drag moves, click reveals: the card is a focusable button whose plain click
  // (or Enter/Space — it's a real <button>) opens the detail drawer; a >5px drag
  // moves the placement (the view suppresses the drag's trailing click). A
  // non-draggable card keeps the same button as a detail-drawer trigger.
  const canDrag = draggable;
  return (
    <Box
      position="relative"
      opacity={isDragging ? 0.4 : 1}
      flex={fill ? 1 : undefined}
      minH={fill ? 0 : undefined}
      borderTopWidth={separated ? "1px" : "0"}
      borderTopColor="gray.100"
    >
      <chakra.button
        type="button"
        ref={canDrag ? setNodeRef : undefined}
        {...(canDrag ? attributes : {})}
        {...(canDrag ? listeners : {})}
        w="full"
        h={fill ? "full" : undefined}
        p={0}
        border={0}
        bg="transparent"
        textAlign="left"
        cursor={canDrag ? (isDragging ? "grabbing" : "grab") : "pointer"}
        touchAction={canDrag ? "none" : undefined}
        transition="background 0.1s"
        _hover={compound ? { bg: "gray.50" } : undefined}
        _focusVisible={
          compound
            ? {
                bg: "gray.50",
                outline: "2px solid",
                outlineColor: "violet.400",
                outlineOffset: "-2px",
              }
            : undefined
        }
        aria-label={`Details for ${p.activityTitle ?? p.subject}`}
        data-detail-trigger={placementId}
        onClick={(e) => {
          e.stopPropagation();
          onOpenDetail({ kind: "placement", placementId }, placementId);
        }}
      >
        <ChipBody
          p={p}
          lens={lens}
          groupEmojiById={groupEmojiById}
          fill={fill}
          suppressSubjectEyebrow={suppressSubjectEyebrow}
        />
      </chakra.button>
    </Box>
  );
}

function ChipBody({
  p,
  lens,
  groupEmojiById,
  dragging,
  flagged,
  asBlockTitle,
  fill,
  flat,
  suppressSubjectEyebrow,
}: {
  p: Placement;
  lens: Lens;
  groupEmojiById: Map<string, string | null>;
  dragging?: boolean;
  flagged?: boolean;
  asBlockTitle?: boolean;
  fill?: boolean;
  flat?: boolean;
  suppressSubjectEyebrow?: boolean;
}) {
  return (
    <EnrichedChip
      p={p}
      lens={lens}
      groupEmoji={groupEmojiById.get(String(p.groupId))}
      dragging={dragging}
      flagged={flagged}
      asBlockTitle={asBlockTitle}
      fill={fill}
      flat={flat}
      suppressSubjectEyebrow={suppressSubjectEyebrow}
    />
  );
}

/** What the quick-add picker gives to (TRA-582): a class meeting on a day,
 *  or homework due on a day. */
type QuickAddTarget =
  | { kind: "class"; weekday: number; blockId: string; subject: string; groupId: string }
  | { kind: "homework"; weekday: number };
type QuickAddClassOption = { classId: string; groupId: string; subject: string };
type QuickAddWork =
  | { kind: "activity"; activityId: Id<"activities"> }
  | { kind: "skill"; nodeKey: string };

function QuickAddPalette({
  onClose,
  target,
  dayLabel,
  groupOptions,
  classOptions,
  defaultGroupId,
  onSubmit,
}: {
  onClose: () => void;
  target: QuickAddTarget;
  dayLabel: string;
  groupOptions: { id: string; name: string; emoji: string | null }[];
  /** The classes homework can be for (homework mode). */
  classOptions: QuickAddClassOption[];
  defaultGroupId: string;
  onSubmit: (v: { work: QuickAddWork; classId: string | null }) => void;
}) {
  const [subject, setSubject] = useState("");
  const [selectedActivityId, setSelectedActivityId] = useState<Id<"activities"> | null>(null);
  const [selectedSkillKey, setSelectedSkillKey] = useState<string | null>(null);
  const [suggestionsVisible, setSuggestionsVisible] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [groupId, setGroupId] = useState(defaultGroupId);
  const groupClasses = classOptions.filter((c) => c.groupId === groupId);
  const [classId, setClassId] = useState<string | null>(null);
  // A group with one class needs no pick.
  const pickedClassId =
    classId && groupClasses.some((c) => c.classId === classId)
      ? classId
      : groupClasses.length === 1
        ? groupClasses[0].classId
        : null;
  const inputRef = useRef<HTMLInputElement>(null);
  const units = useQuery(api.units.list, {});
  const query = subject.trim().toLowerCase();
  const queryReady = query.length >= 2;
  const unitMatches = useMemo<CurriculumUnit[]>(() => {
    if (!queryReady || !units) return [];
    return units
      .filter((unit) => unit.title.toLowerCase().includes(query))
      .slice(0, 5);
  }, [query, queryReady, units]);
  const activeUnit = unitMatches[0] ?? null;
  const activities = useQuery(
    api.activities.listByUnitPublic,
    activeUnit ? { unitId: activeUnit._id } : "skip",
  );
  const skills = useQuery(
    api.standingPractice.searchSkills,
    queryReady ? { query: subject, limit: 6 } : "skip",
  );
  const activityMatches = useMemo<CurriculumActivity[]>(() => {
    if (!queryReady || !activeUnit || !activities) return [];
    const unitMatchesQuery = activeUnit.title.toLowerCase().includes(query);
    return activities
      .filter((activity) => unitMatchesQuery || activity.title.toLowerCase().includes(query))
      .slice(0, 5);
  }, [activeUnit, activities, query, queryReady]);
  const suggestions = useMemo<CurriculumSuggestion[]>(() => {
    if (!queryReady) return [];
    const activitySuggestions: CurriculumSuggestion[] = activeUnit
      ? activityMatches.map((activity) => ({
          type: "activity",
          key: `activity:${String(activity._id)}`,
          label: activity.title,
          unitId: activeUnit._id,
          activityId: activity._id,
          subtitle: `Activity · ${activeUnit.title}${activity.durationMinutes ? ` · ${activity.durationMinutes} min` : ""}`,
        }))
      : [];
    const skillSuggestions: CurriculumSuggestion[] = (skills ?? []).map(
      (skill) => ({
        type: "skill",
        key: `skill:${skill.nodeKey}`,
        label: skill.label,
        nodeKey: skill.nodeKey,
        domain: skill.domain,
        subtitle: `Math skill · ${skill.domainLabel}`,
      }),
    );
    // A unit search lists the unit's activities; a unit itself isn't given from
    // the grid (unit flow retired, TRA-582).
    return [
      ...activitySuggestions,
      ...skillSuggestions,
    ].slice(0, 12);
  }, [
    activeUnit,
    activityMatches,
    queryReady,
    skills,
  ]);
  const curriculumLoading =
    units === undefined ||
    skills === undefined ||
    Boolean(activeUnit && activities === undefined);
  const showSuggestions =
    suggestionsVisible && queryReady && (suggestions.length > 0 || curriculumLoading);
  const highlightedSuggestion =
    highlightedIndex >= 0 ? suggestions[highlightedIndex] : undefined;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets the combobox keyboard highlight when its result set changes.
    setHighlightedIndex(suggestions.length > 0 ? 0 : -1);
  }, [query, suggestions.length]);

  const isHomework = target.kind === "homework";
  const work: QuickAddWork | null = selectedActivityId
    ? { kind: "activity", activityId: selectedActivityId }
    : selectedSkillKey
      ? { kind: "skill", nodeKey: selectedSkillKey }
      : null;
  // A concrete activity or skill, and for homework, the class it's for.
  const canSubmit = work != null && (!isHomework || pickedClassId != null);
  const submit = () => {
    if (!canSubmit || !work) return;
    onSubmit({ work, classId: isHomework ? pickedClassId : null });
  };
  const selectSuggestion = (suggestion: CurriculumSuggestion) => {
    setSubject(suggestion.label);
    setSelectedActivityId(suggestion.type === "activity" ? suggestion.activityId : null);
    setSelectedSkillKey(
      suggestion.type === "skill" ? suggestion.nodeKey : null,
    );
    setSuggestionsVisible(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const selGroup = groupOptions.find((g) => g.id === groupId);
  const selClass = groupClasses.find((c) => c.classId === pickedClassId);

  return (
    <Portal>
      <Box position="fixed" inset={0} bg="blackAlpha.400" zIndex={1400} onClick={onClose} display="flex" alignItems="flex-start" justifyContent="center" pt="12vh">
        <Box
          w="min(560px, 92vw)"
          bg="white"
          borderRadius="xl"
          boxShadow="2xl"
          overflow="hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* What it's given to, pinned at top so it doesn't bounce as
              suggestions appear/resize. */}
          <Box px={4} pt={3} pb={2.5} borderBottom="1px solid" borderColor="gray.100">
            <Text fontSize="2xs" fontWeight="700" textTransform="uppercase" letterSpacing="0.04em" color="charcoal.300">
              {isHomework ? `Homework due ${dayLabel}` : `Add to ${dayLabel}'s class`}
            </Text>
            {target.kind === "class" ? (
              <HStack gap={2} mt={0.5} align="center">
                <Text fontFamily="heading" fontWeight="700" fontSize="md" color="navy.700" lineClamp={1}>
                  {target.subject}
                </Text>
                {selGroup && (
                  <HStack gap={1} px={2} py={0.5} bg="gray.100" borderRadius="full" flexShrink={0}>
                    {selGroup.emoji && <Text fontSize="sm">{selGroup.emoji}</Text>}
                    <Text fontSize="2xs" fontWeight="700" color="charcoal.500">
                      {selGroup.name}
                    </Text>
                  </HStack>
                )}
              </HStack>
            ) : (
              <HStack gap={2} mt={1.5} flexWrap="wrap">
                <FieldPicker label="Group" value={selGroup ? `${selGroup.emoji ? selGroup.emoji + " " : ""}${selGroup.name}` : "—"}>
                  {groupOptions.map((g) => (
                    <Menu.Item key={g.id} value={g.id} cursor="pointer" onClick={() => setGroupId(g.id)}>
                      {g.emoji ? `${g.emoji} ` : ""}{g.name}
                    </Menu.Item>
                  ))}
                </FieldPicker>
                <FieldPicker label="Class" value={selClass ? selClass.subject : groupClasses.length ? "Pick one" : "None this week"}>
                  {groupClasses.map((c) => (
                    <Menu.Item key={c.classId} value={c.classId} cursor="pointer" onClick={() => setClassId(c.classId)}>
                      {c.subject}
                    </Menu.Item>
                  ))}
                </FieldPicker>
              </HStack>
            )}
          </Box>

          <Flex align="center" gap={2} px={4} py={3} borderBottom="1px solid" borderColor="gray.100">
            <MagnifyingGlass size={16} />
            <Input
              ref={inputRef}
              variant="flushed"
              border="none"
              placeholder="Search units, activities, or math skills…"
              value={subject}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={showSuggestions}
              aria-controls="quick-add-curriculum-suggestions"
              aria-activedescendant={
                highlightedSuggestion ? `quick-add-suggestion-${highlightedIndex}` : undefined
              }
              onFocus={() => setSuggestionsVisible(true)}
              onChange={(e) => {
                setSubject(e.target.value);
                setSelectedActivityId(null);
                setSelectedSkillKey(null);
                setSuggestionsVisible(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown" && suggestions.length > 0) {
                  e.preventDefault();
                  setSuggestionsVisible(true);
                  setHighlightedIndex((i) => (i < 0 ? 0 : Math.min(i + 1, suggestions.length - 1)));
                } else if (e.key === "ArrowUp" && suggestions.length > 0) {
                  e.preventDefault();
                  setSuggestionsVisible(true);
                  setHighlightedIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
                } else if (e.key === "Enter") {
                  if (suggestionsVisible && highlightedSuggestion) {
                    e.preventDefault();
                    selectSuggestion(highlightedSuggestion);
                  } else {
                    submit();
                  }
                }
              }}
              fontSize="md"
              _focus={{ boxShadow: "none" }}
            />
          </Flex>

          {showSuggestions && (
            <Box
              id="quick-add-curriculum-suggestions"
              role="listbox"
              borderBottom="1px solid"
              borderColor="gray.100"
              maxH="240px"
              overflowY="auto"
              py={1}
            >
              {suggestions.map((suggestion, index) => {
                const active = index === highlightedIndex;
                return (
                  <chakra.button
                    key={suggestion.key}
                    id={`quick-add-suggestion-${index}`}
                    type="button"
                    role="option"
                    aria-selected={active}
                    w="full"
                    textAlign="left"
                    px={4}
                    py={2}
                    bg={active ? "violet.50" : "white"}
                    _hover={{ bg: "violet.50" }}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => selectSuggestion(suggestion)}
                  >
                    <HStack justify="space-between" gap={3} align="start">
                      <VStack align="start" gap={0} minW={0}>
                        <Text fontSize="sm" fontWeight="700" color="navy.700" lineClamp={1}>
                          {suggestion.label}
                        </Text>
                        <Text fontSize="2xs" color="charcoal.300" lineClamp={1}>
                          {suggestion.subtitle}
                        </Text>
                      </VStack>
                      <Text fontSize="2xs" color={suggestion.type === "unit" ? "charcoal.300" : "violet.600"} fontWeight="700">
                        {suggestion.type === "activity"
                          ? "Activity"
                          : suggestion.type === "skill"
                            ? "Math skill"
                            : "Unit"}
                      </Text>
                    </HStack>
                  </chakra.button>
                );
              })}
              {suggestions.length === 0 && curriculumLoading && (
                <Text px={4} py={2} fontSize="xs" color="charcoal.300">
                  Searching curriculum…
                </Text>
              )}
            </Box>
          )}

          <HStack justify="space-between" px={4} py={3}>
            <Text fontSize="2xs" color="charcoal.300">
              {isHomework
                ? "On their list from the start of that school week, and late after that day."
                : "Shows up when the class starts and finishes in it."}
            </Text>
            <HStack gap={2}>
              <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
              <Button
                size="sm"
                colorPalette="violet"
                disabled={!canSubmit}
                onClick={submit}
                fontFamily="heading"
              >
                {isHomework ? "Give homework" : "Give to class"}
              </Button>
            </HStack>
          </HStack>
        </Box>
      </Box>
    </Portal>
  );
}

// ── Small shared UI ──────────────────────────────────────────────────────────

function LensButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <chakra.button
      onClick={onClick}
      px={3.5}
      py={1}
      borderRadius="full"
      fontFamily="heading"
      fontWeight="600"
      fontSize="sm"
      bg={active ? "white" : "transparent"}
      color={active ? "navy.700" : "charcoal.400"}
      boxShadow={active ? "xs" : "none"}
      _hover={active ? {} : { color: "navy.600" }}
      transition="all 0.1s"
    >
      {children}
    </chakra.button>
  );
}

function TeacherMenuItems({
  teachers,
  selectedId,
  onSelect,
  includeUnassigned,
  meId,
}: {
  teachers: GridData["teachers"];
  selectedId: string;
  onSelect: (id: string) => void;
  includeUnassigned?: boolean;
  /** The signed-in teacher's id — their row is surfaced first and labelled "Me". */
  meId?: string;
}) {
  // Float "Me" to the top so a teacher lands on their own schedule fastest.
  const ordered = meId
    ? [...teachers].sort((a, b) =>
        String(a._id) === meId ? -1 : String(b._id) === meId ? 1 : 0,
      )
    : teachers;
  return (
    <>
      {includeUnassigned && (
        <Menu.Item value="" cursor="pointer" onClick={() => onSelect("")}>
          <HStack w="full" gap={2}>
            <Box
              w={4.5}
              h={4.5}
              borderRadius="full"
              border="1px dashed"
              borderColor="gray.300"
              flexShrink={0}
            />
            <Text flex={1} lineClamp={1}>Unassigned</Text>
            {selectedId === "" && <Check size={13} />}
          </HStack>
        </Menu.Item>
      )}
      {ordered.map((t) => {
        const id = String(t._id);
        const isMe = !!meId && id === meId;
        return (
          <Menu.Item key={id} value={id} cursor="pointer" onClick={() => onSelect(id)}>
            <HStack w="full" gap={2}>
              <Avatar name={t.name} colorKey={String(t._id)} size="2xs" />
              <Text flex={1} lineClamp={1} fontWeight={isMe ? "700" : undefined}>
                {isMe ? "Me" : t.name}
              </Text>
              {isMe && (
                <Text fontSize="2xs" color="charcoal.300" lineClamp={1}>
                  {t.name}
                </Text>
              )}
              {selectedId === id && <Check size={13} />}
            </HStack>
          </Menu.Item>
        );
      })}
    </>
  );
}

function PillPicker({ label, emptyText, children }: { label: string; emptyText: string; children: React.ReactNode }) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <Menu.Root positioning={{ placement: "bottom-start" }}>
      <Menu.Trigger asChild>
        <Button size="sm" variant="outline" borderRadius="full" fontFamily="heading" fontWeight="600" fontSize="sm" color="navy.600" bg="white" gap={1.5} px={3} h="auto" py={1} maxW="220px">
          <Text lineClamp={1}>{label}</Text>
          <CaretDown size={13} />
        </Button>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content minW="220px" maxH="60vh" overflowY="auto">
            {hasChildren ? children : <Box px={3} py={2} fontSize="sm" color="charcoal.300">{emptyText}</Box>}
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

function FieldPicker({ label, value, children }: { label: string; value: string; children: React.ReactNode }) {
  return (
    <VStack align="start" gap={0.5}>
      <Text fontSize="2xs" color="charcoal.300" textTransform="uppercase" letterSpacing="0.04em" fontWeight="700">
        {label}
      </Text>
      <Menu.Root positioning={{ placement: "bottom-start" }}>
        <Menu.Trigger asChild>
          <Button size="xs" variant="outline" borderRadius="md" fontWeight="600" fontSize="xs" gap={1} px={2}>
            <Text lineClamp={1} maxW="130px">{value}</Text>
            <CaretDown size={11} />
          </Button>
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content minW="180px" maxH="50vh" overflowY="auto">{children}</Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
    </VStack>
  );
}

function EmptyState({ programScoped = false }: { programScoped?: boolean }) {
  return (
    <Flex flex={1} align="center" justify="center" direction="column" gap={2} color="charcoal.300" px={6} textAlign="center">
      <CalendarBlank size={32} weight="thin" />
      <Text fontFamily="heading" fontWeight="700" color="navy.600">No schedule for this term yet</Text>
      <Text fontSize="sm" maxW="360px">
        {programScoped
          ? "A teacher sets up the school timetable. Your assigned programs will appear here when they are placed."
          : "Set this term's bell schedule and each group's classes on School › Classes & times, or ask the aide."}
      </Text>
    </Flex>
  );
}
