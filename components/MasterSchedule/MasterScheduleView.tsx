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
  VStack,
  chakra,
} from "@chakra-ui/react";
import {
  CalendarBlank,
  CaretDown,
  CaretRight,
  ChatCircle,
  Check,
  DotsSixVertical,
  LockSimple,
  LockSimpleOpen,
  MagnifyingGlass,
  Plus,
  Printer,
  Warning,
} from "@phosphor-icons/react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  pointerWithin,
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
  PlacementDetailDrawer,
  type DrawerTarget,
} from "@/components/MasterSchedule/PlacementDetailDrawer";
import {
  ClassDrawer,
  type ClassDrawerTarget,
  type FlowAnotherUnitAnchor,
} from "@/components/MasterSchedule/ClassDrawer";
import { fmtTime, fmtTimeRange } from "@/components/MasterSchedule/timeFormat";
import { DateTermPicker, type ReportingPeriodOption } from "@/components/MasterSchedule/DateTermPicker";
import { useScholarRoster } from "@/hooks/useScholarRoster";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { ROLES } from "@/convex/lib/roles";
import { useAideDock } from "@/components/aide/AideDockProvider";
import { toaster } from "@/lib/toaster";
import { EmptyState as PrimitiveEmptyState } from "@/components/ui/EmptyState";
import { CreatePeriodDialog } from "@/components/narrative/NarrativeQueue";
import { StartAssignmentDialog } from "@/components/StartAssignmentDialog";
import { computeScheduleLoadingState } from "@/components/MasterSchedule/scheduleLoadingState";
import {
  clampToWeekday,
  initialAnchorMs,
  todayAnchorMs,
} from "@/components/MasterSchedule/scheduleAnchor";
import { closuresForWeek, type SchoolClosure } from "@/shared/schoolClosures";
import { scheduleWeekStartMs } from "@/shared/scheduleWeek";
import {
  deriveClassMeetingPattern,
  generateMeetingSlots,
} from "@/shared/meetingSlots";

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
type HomeworkDueProjection = GridData["homeworkDue"][number];
type Block = GridData["blocks"][number];
const NO_SENSORS: [] = [];
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

function termForMs(terms: ReportingPeriodOption[], ms: number) {
  return terms.find((term) => ms >= term.startsAt && ms <= term.endsAt) ?? null;
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

// The shelf is one tall target, so pointer containment must outrank the much
// nearer centers of adjacent grid cells.
const scheduleCollisionDetection: CollisionDetection = (args) => {
  const shelfCollisions = pointerWithin({
    ...args,
    droppableContainers: args.droppableContainers.filter(({ id }) => id === "shelf"),
  });
  if (shelfCollisions.length > 0) return shelfCollisions;
  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter(({ id }) => id !== "shelf"),
  });
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
    programScoped ? "skip" : {},
  );
  const teacherCurrentTerm = useQuery(
    api.reportingPeriods.current,
    programScoped ? "skip" : {},
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
  const grid = programScoped ? programGrid : teacherGrid;
  // `placements` is the term-wide source feed for drawers, the shelf, and
  // meeting-pattern tools. Cells render the backend's layered target-week feed.
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
  // "Edit blocks" mode — locked by default. When on, bare-class blocks (a
  // subject with no linked activity, e.g. "Science") stop rendering as passive
  // titles and become draggable/removable chips, so a teacher can re-time or
  // delete the block's structure. Off = the everyday "fill blocks with
  // activities" view. Transient (not persisted).
  const [editBlocks, setEditBlocks] = useState(false);
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
    return closuresForWeek(weekStartMs, grid?.closureTimeZone ?? "Pacific/Honolulu", rows);
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
  const placeClass = useMutation(api.masterSchedule.placeClass);
  const movePlacement = useMutation(api.masterSchedule.movePlacement);
  const removePlacement = useMutation(api.masterSchedule.removePlacement);
  const removeProgramHandoutPlacement = useMutation(
    api.masterSchedule.removeProgramHandoutPlacement,
  );
  const updatePlacement = useMutation(api.masterSchedule.updatePlacement);
  const scheduleSkill = useMutation(api.masterSchedule.scheduleSkill);
  const cascadeUnitForGroup = useMutation(api.masterSchedule.cascadeUnitForGroup);
  const dismissFlagMut = useMutation(api.masterSchedule.dismissFlag);
  const acceptReorderMut = useMutation(api.masterSchedule.acceptReorder);
  const ensureHomeworkRail = useMutation(api.masterSchedule.ensureHomeworkRail);

  // The aide dock — flags ("overloaded", "out of order") offer an "ask bot"
  // door that seeds the composer, DRY with the conflict→chat pattern.
  const aide = useAideDock();

  // ── DnD ───────────────────────────────────────────────────────────────────
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [dragId, setDragId] = useState<string | null>(null);
  // When a whole cell is grabbed in edit mode, the block fuses into one draggable
  // card; we track the placement ids it carries so a single drop moves them all.
  const [dragCellIds, setDragCellIds] = useState<string[] | null>(null);

  // Built from the term-wide feed, not `weekPlacements`: the shelf can hold
  // placements whose stamped `weekStartMs` is outside the viewed week, and those
  // items are still draggable. Resolving the DragOverlay against a week-scoped
  // map would render an empty overlay for such a drag.
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

  const onDragStart = (e: DragStartEvent) => {
    justDraggedRef.current = true;
    setDragId(String(e.active.id));
    const data = e.active.data.current as { kind?: string; placementIds?: string[] } | undefined;
    setDragCellIds(data?.kind === "cell" ? data.placementIds ?? [] : null);
  };
  const onDragEnd = async (e: DragEndEvent) => {
    requestAnimationFrame(() => {
      justDraggedRef.current = false;
    });
    setDragId(null);
    setDragCellIds(null);
    const over = e.over?.id ? String(e.over.id) : null;
    if (!over) return;
    // Destination: the shelf, or a specific cell.
    let dest:
      | {
          weekday: number | null;
          blockId: Id<"scheduleBlocks"> | null;
          weekStartMs?: number;
          mode?: "classFocus" | "homework";
        }
      | null = null;
    if (over === "shelf") {
      dest = { weekday: null, blockId: null };
    } else if (over.startsWith("cell:")) {
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
    // A fused whole-cell grab carries every placement in the block; a plain chip
    // carries just itself. Either way, move them all to the destination together.
    const data = e.active.data.current as { kind?: string; placementIds?: string[] } | undefined;
    const ids =
      data?.kind === "cell" && data.placementIds?.length ? data.placementIds : [String(e.active.id)];
    try {
      await Promise.all(
        ids.map((id) =>
          movePlacement({
            placementId: id as Id<"schedulePlacements">,
            ...dest,
          }),
        ),
      );
    } catch (err) {
      toaster.create({ title: "Move failed", description: String(err), type: "error" });
    }
  };
  const onDragCancel = () => {
    justDraggedRef.current = false;
    setDragId(null);
    setDragCellIds(null);
  };

  // ── Detail drawer (click reveals; drag moves) ──────────────────────────────
  const [drawerTarget, setDrawerTarget] = useState<DrawerTarget | null>(null);
  // Focus returns to the originating chip on close — chips stamp
  // data-detail-trigger with their placement id (fused cells: their drag id).
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

  // ── Class drawer (the queue made visible — §7) ──────────────────────────────
  // A discreet chevron on any class cell opens a drawer for that (groupId,
  // subject) class: its whole spine (past + upcoming meetings) derived from the
  // grid's own placements. Distinct from the per-placement detail drawer above.
  const [classDrawer, setClassDrawer] = useState<ClassDrawerTarget | null>(null);
  const openClassDrawer = useCallback((groupId: string, subject: string) => {
    if (justDraggedRef.current) return; // a completed drag, not a click
    setClassDrawer({ groupId, subject });
  }, []);

  // ── Quick-add ──────────────────────────────────────────────────────────────
  // Entry points are the shelf "Quick Add" control + the per-cell hover "+".
  // We deliberately do NOT bind ⌘K here — that's the app's global command
  // palette (jump-to-scholar/curriculum); hijacking it would double-open.
  const [quickAdd, setQuickAdd] = useState<{
    weekday?: number;
    blockId?: string;
    // When set, the palette FILLS this existing (empty) slot with an activity
    // instead of creating a new class — the everyday "put work in a slot" action.
    fill?: { placementId: string; subject: string; groupId: string; teacherId: string };
  } | null>(null);

  // Clicking an EMPTY slot opens the quick picker scoped to that slot, so the
  // chosen activity fills the slot in place (updatePlacement) rather than adding a
  // sibling class. Suppressed right after a drag (same guard as the detail drawer).
  const openFillSlot = useCallback((p: Placement) => {
    if (justDraggedRef.current) return;
    setQuickAdd({
      weekday: typeof p.weekday === "number" ? p.weekday : undefined,
      blockId: p.blockId ? String(p.blockId) : undefined,
      fill: {
        placementId: String(p._id),
        subject: p.subject,
        groupId: String(p.groupId),
        teacherId: p.teacherId ? String(p.teacherId) : "",
      },
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
  // "Flow another unit" from the class drawer: reuse the EXISTING flow palette
  // (no new flow UI). The class drawer resolves the class's first FREE meeting;
  // we jump the grid to that week (so the cascade's start week — anchorWeekStartMs
  // — lines up) and open the palette in fill mode anchored on the class's
  // recurring slot there, so the flow lands end-to-end after the current queue.
  const openFlowForClass = useCallback((a: FlowAnotherUnitAnchor) => {
    setClassDrawer(null);
    setAnchorMs(a.weekStartMs + (a.weekday - 1) * DAY_MS);
    setQuickAdd({
      weekday: a.weekday,
      blockId: a.blockId,
      fill: {
        placementId: a.anchorPlacementId,
        subject: a.subject,
        groupId: a.groupId,
        teacherId: a.teacherId,
      },
    });
  }, []);

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

  // Placements in the current lens, indexed by `${blockId}|${weekday}`.
  const cellPlacements = useMemo(() => {
    const m = new Map<string, Placement[]>();
    for (const p of weekPlacements) {
      if (p.onShelf) continue;
      const inLens =
        lens === "group" ? String(p.groupId) === groupKey : String(p.teacherId) === teacherKey;
      if (!inLens) continue;
      const key = `${p.blockId}|${p.weekday}`;
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(p);
    }
    return m;
  }, [weekPlacements, lens, groupKey, teacherKey]);

  const shelfItems = useMemo(() => {
    return (grid?.shelf ?? []).filter((p) =>
      lens === "group" ? String(p.groupId) === groupKey : String(p.teacherId) === teacherKey,
    );
  }, [grid?.shelf, lens, groupKey, teacherKey]);

  // ── Homework due rail (Q3) ─────────────────────────────────────────────────
  // Homework lives on a virtual per-term block (kind "homework"); it renders as
  // a top-of-day DUE RAIL, not a bell-schedule row. Split the blocks so the rail
  // holds those placements and the grid shows only real class blocks.
  const homeworkBlockIds = useMemo(() => {
    const s = new Set<string>();
    for (const b of grid?.blocks ?? []) if (b.kind === "homework") s.add(String(b._id));
    return s;
  }, [grid?.blocks]);
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
      if (!homeworkBlockIds.has(String(p.blockId))) continue;
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
      if (!m.has(p.weekday)) m.set(p.weekday, []);
      m.get(p.weekday)!.push(p);
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

  // ── Flags: overloaded slots + out-of-order sequence chips (Q2) ──────────────
  // A cell shows an "overloaded" tag only when ≥2 of the chips the teacher can
  // actually SEE in it (current lens) belong to one derived overload flag.
  const overloadByCell = useMemo(() => {
    const m = new Map<string, { flagId: string; placementIds: string[] }>();
    for (const f of grid?.overloaded ?? []) {
      const key = `${f.blockId}|${f.weekday}`;
      const ids = f.placementIds.map(String);
      const visible = (cellPlacements.get(key) ?? []).filter((it) =>
        ids.includes(String(it._id)),
      );
      if (visible.length >= 2) m.set(key, { flagId: f.flagId, placementIds: ids });
    }
    return m;
  }, [grid?.overloaded, cellPlacements]);
  const outOfOrderChips = useMemo(() => {
    const m = new Map<string, { sequenceId: string; flagId: string }>();
    for (const f of grid?.outOfOrder ?? [])
      m.set(String(f.placementId), { sequenceId: f.sequenceId, flagId: f.flagId });
    return m;
  }, [grid?.outOfOrder]);

  const askBot = useCallback((text: string) => aide.seedComposer(text), [aide]);
  const onDismissOverload = useCallback(
    async (flagId: string, placementIds: string[]) => {
      try {
        await dismissFlagMut({
          flagId,
          placementIds: placementIds as Id<"schedulePlacements">[],
        });
      } catch (err) {
        toaster.create({ title: "Couldn't dismiss", description: String(err), type: "error" });
      }
    },
    [dismissFlagMut],
  );
  const onAcceptReorder = useCallback(
    async (sequenceId: string) => {
      try {
        await acceptReorderMut({ sequenceId });
      } catch (err) {
        toaster.create({ title: "Couldn't accept", description: String(err), type: "error" });
      }
    },
    [acceptReorderMut],
  );

  // Remove — reached from the detail drawer's destructive footer (movement is
  // drag-only, so this is the one placement action left outside dnd).
  const handleRemove = useCallback(
    async (placementId: string) => {
      try {
        await removePlacement({ placementId: placementId as Id<"schedulePlacements"> });
      } catch (err) {
        toaster.create({ title: "Remove failed", description: String(err), type: "error" });
      }
    },
    [removePlacement],
  );
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
  const blocks = grid?.blocks ?? [];

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
          <Button
            size="xs"
            variant="outline"
            colorPalette="violet"
            asChild
          >
            <a
              href="/print/special-delivery"
              target="_blank"
              rel="noreferrer"
            >
              <Printer size={14} />
              Special delivery
            </a>
          </Button>
        )}

        {/* Edit-blocks lock — unlocks re-timing/removing bare class blocks. */}
        {!programScoped && (
        <chakra.button
          type="button"
          onClick={() => setEditBlocks((v) => !v)}
          display="inline-flex"
          alignItems="center"
          gap={1.5}
          px={3}
          py={1.5}
          borderRadius="full"
          borderWidth="1px"
          borderStyle="solid"
          borderColor={editBlocks ? "violet.300" : "gray.200"}
          bg={editBlocks ? "violet.50" : "white"}
          color={editBlocks ? "violet.700" : "charcoal.400"}
          fontSize="xs"
          fontWeight="700"
          cursor="pointer"
          aria-pressed={editBlocks}
          title={
            editBlocks
              ? "Blocks unlocked — drag to re-time, ⋯ to remove. Click to lock."
              : "Class blocks are locked. Unlock to re-time or remove them."
          }
          _hover={{ borderColor: editBlocks ? "violet.400" : "gray.300" }}
        >
          {editBlocks ? <LockSimpleOpen size={14} weight="bold" /> : <LockSimple size={14} weight="bold" />}
          <Text>{editBlocks ? "Editing blocks" : "Edit blocks"}</Text>
        </chakra.button>
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
        <DndContext sensors={programScoped ? NO_SENSORS : sensors} collisionDetection={scheduleCollisionDetection} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={onDragCancel}>
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
                          lens={lens}
                          editBlocks={editBlocks}
                          groupEmojiById={groupEmojiById}
                          outOfOrderChips={outOfOrderChips}
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
                            setQuickAdd({
                              weekday: d.n,
                              blockId: homeworkBlockId,
                            });
                          }}
                          onOpenDetail={openDetail}
                          onFillSlot={
                            programScoped ? openProgramWork : openFillSlot
                          }
                          onAskBot={askBot}
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
                    coverageByCell={coverageByCell}
                    conflictedPlacementIds={conflictedPlacementIds}
                    overloadByCell={overloadByCell}
                    outOfOrderChips={outOfOrderChips}
                    groupEmojiById={groupEmojiById}
                    lens={lens}
                    editBlocks={editBlocks}
                    draggable={!programScoped}
                    onQuickAdd={(weekday) => setQuickAdd({ weekday, blockId: String(block._id) })}
                    onOpenDetail={openDetail}
                    onFillSlot={programScoped ? openProgramWork : openFillSlot}
                    onOpenClass={programScoped ? undefined : openClassDrawer}
                    onDismissOverload={onDismissOverload}
                    onAskBot={askBot}
                  />
                ))}
              </Box>
            </Box>

            {/* Shelf */}
            {!programScoped && (
              <ShelfTray
                items={shelfItems}
                groupEmojiById={groupEmojiById}
                lens={lens}
                onQuickAdd={() => setQuickAdd({})}
                onOpenDetail={openDetail}
              />
            )}
          </Flex>

          <DragOverlay dropAnimation={null}>
            {dragCellIds ? (
              <Box
                bg="white"
                border="1px solid"
                borderColor="gray.200"
                borderRadius="lg"
                boxShadow="xl"
                w="full"
                overflow="hidden"
              >
                <FusedCellBody
                  placements={dragCellIds
                    .map((id) => placementsById.get(id))
                    .filter((p): p is Placement => Boolean(p))}
                  lens={lens}
                  groupEmojiById={groupEmojiById}
                />
              </Box>
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

      {!programScoped && quickAdd && termId && (
        <QuickAddPalette
          onClose={() => setQuickAdd(null)}
          blocks={blocks}
          placements={grid?.placements ?? []}
          closures={grid?.closures ?? []}
          closureTimeZone={grid?.closureTimeZone ?? "Pacific/Honolulu"}
          anchorWeekStartMs={anchorWeekStartMs}
          groupOptions={groupOptions}
          teacherOptions={teacherOptions}
          defaultGroupId={
            quickAdd.fill
              ? quickAdd.fill.groupId
              : lens === "group"
                ? groupKey
                : groupOptions[0]?.id ?? ""
          }
          defaultTeacherId={
            quickAdd.fill ? quickAdd.fill.teacherId : lens === "teacher" ? teacherKey : ""
          }
          initial={{ weekday: quickAdd.weekday, blockId: quickAdd.blockId }}
          fillTarget={quickAdd.fill ?? null}
          onRemove={
            quickAdd.fill && editBlocks
              ? async () => {
                  try {
                    await removePlacement({
                      placementId: quickAdd.fill!.placementId as Id<"schedulePlacements">,
                    });
                    setQuickAdd(null);
                  } catch (err) {
                    toaster.create({
                      title: "Couldn't remove slot",
                      description: String(err),
                      type: "error",
                    });
                  }
                }
              : undefined
          }
          onSubmit={async ({ subject, groupId, teacherId, weekday, blockId, activityId, unitId, skillKey, layout }) => {
            try {
              if (unitId) {
                // Unit pick → flow the whole unit's activities into the grid.
                if (weekday == null || !blockId) {
                  toaster.create({
                    title: "Pick a day + block first",
                    description: "A unit flows onto the grid starting from a placed slot.",
                    type: "error",
                  });
                  return;
                }
                await cascadeUnitForGroup({
                  periodId: termId,
                  groupId: groupId as Id<"scholarGroups">,
                  unitId,
                  startWeekday: weekday,
                  startBlockId: blockId as Id<"scheduleBlocks">,
                  // "flow" spreads one activity per class meeting; "sameDay"
                  // stacks the whole unit on the chosen day (the secondary choice).
                  layout,
                  // Anchor on the clicked class slot: its class supplies the
                  // subject + weekly meeting pattern (class-anchored flow). The
                  // on-screen week is the flow's start week.
                  ...(quickAdd.fill
                    ? { anchorPlacementId: quickAdd.fill.placementId as Id<"schedulePlacements"> }
                    : {}),
                  weekStartMs: anchorWeekStartMs,
                  ...(teacherId ? { teacherId: teacherId as Id<"users"> } : {}),
                });
                // Keep the clicked class slot: it's the recurring class
                // STRUCTURE (weekStartMs == null), not a throwaway placeholder —
                // deleting it would permanently remove the class. The cascade's
                // concrete week-1 chip and this recurring slot now coexist in the
                // cell (rendered as class header + chip); the week filter + the
                // `filled` cell styling keep that reading as one full slot.
                setQuickAdd(null);
                return;
              }
              if (skillKey) {
                await scheduleSkill({
                  periodId: termId,
                  groupId: groupId as Id<"scholarGroups">,
                  subject,
                  nodeKey: skillKey,
                  ...(teacherId ? { teacherId: teacherId as Id<"users"> } : {}),
                  ...(weekday != null ? { weekday } : {}),
                  ...(blockId ? { blockId: blockId as Id<"scheduleBlocks"> } : {}),
                  ...(quickAdd.fill
                    ? {
                        placementId:
                          quickAdd.fill.placementId as Id<"schedulePlacements">,
                      }
                    : {}),
                });
                setQuickAdd(null);
                return;
              }
              if (quickAdd.fill) {
                await updatePlacement({
                  placementId: quickAdd.fill.placementId as Id<"schedulePlacements">,
                  ...(activityId ? { activityId: activityId as Id<"activities"> } : {}),
                });
              } else {
                await placeClass({
                  periodId: termId,
                  groupId: groupId as Id<"scholarGroups">,
                  subject,
                  ...(activityId ? { activityId: activityId as Id<"activities"> } : {}),
                  ...(teacherId ? { teacherId: teacherId as Id<"users"> } : {}),
                  ...(weekday != null ? { weekday } : {}),
                  ...(blockId ? { blockId: blockId as Id<"scheduleBlocks"> } : {}),
                });
              }
              setQuickAdd(null);
            } catch (err) {
              toaster.create({
                title: quickAdd.fill ? "Couldn't add work" : "Add failed",
                description: String(err),
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
        editBlocks={editBlocks}
        onClose={closeDetail}
        outOfOrderByPlacement={
          programScoped ? undefined : outOfOrderChips
        }
        onAcceptReorder={programScoped ? undefined : onAcceptReorder}
        onAskBot={programScoped ? undefined : askBot}
        onRemove={programScoped ? handleProgramHandoutRemove : handleRemove}
      />

      {/* Class drawer — the (groupId, subject) queue view. Stably mounted at the
          view root (never keyed/remounted while open; the Ark body-lock rule). */}
      <ClassDrawer
        target={programScoped ? null : classDrawer}
        grid={grid ?? undefined}
        onClose={() => setClassDrawer(null)}
        onFlowUnit={openFlowForClass}
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
                institutionScope: scopeParam,
                periodId: termId,
                subject:
                  programDialogTarget?.subject ?? programDialogGroup.name,
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
  coverageByCell,
  conflictedPlacementIds,
  overloadByCell,
  outOfOrderChips,
  groupEmojiById,
  lens,
  editBlocks,
  draggable,
  onQuickAdd,
  onOpenDetail,
  onFillSlot,
  onOpenClass,
  onDismissOverload,
  onAskBot,
}: {
  block: Block;
  days: Weekday[];
  closedByWeekday: Map<number, SchoolClosure>;
  cellPlacements: Map<string, Placement[]>;
  coverageByCell: Map<string, GridData["coverage"][number]>;
  conflictedPlacementIds: Set<string>;
  overloadByCell: Map<string, { flagId: string; placementIds: string[] }>;
  outOfOrderChips: Map<string, { sequenceId: string; flagId: string }>;
  groupEmojiById: Map<string, string | null>;
  lens: Lens;
  editBlocks: boolean;
  draggable: boolean;
  onQuickAdd: (weekday: number) => void;
  onOpenDetail: (t: DrawerTarget, triggerToken: string) => void;
  onFillSlot: (p: Placement) => void;
  onOpenClass?: (groupId: string, subject: string) => void;
  onDismissOverload: (flagId: string, placementIds: string[]) => void;
  onAskBot: (text: string) => void;
}) {
  const isBreak = block.kind === "recess" || block.kind === "lunch";
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
        const overload = overloadByCell.get(key);
        return (
          <ScheduleCell
            key={d.n}
            dropId={cellId(String(block._id), d.n)}
            zone="class"
            isBreak={isBreak}
            items={items}
            coverage={coverage}
            conflictedPlacementIds={conflictedPlacementIds}
            overload={overload}
            outOfOrderChips={outOfOrderChips}
            overloadContext={`${block.label} on ${d.full}`}
            lens={lens}
            editBlocks={editBlocks}
            draggable={draggable}
            groupEmojiById={groupEmojiById}
            onQuickAdd={() => onQuickAdd(d.n)}
            onOpenDetail={onOpenDetail}
            onFillSlot={onFillSlot}
            onOpenClass={onOpenClass}
            onDismissOverload={onDismissOverload}
            onAskBot={onAskBot}
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
  fusable = true,
  items,
  homeworkDueItems = [],
  coverage,
  conflictedPlacementIds,
  overload,
  outOfOrderChips,
  overloadContext,
  lens,
  editBlocks,
  draggable = true,
  groupEmojiById,
  onQuickAdd,
  onOpenDetail,
  onFillSlot,
  onOpenClass,
  onDismissOverload,
  onAskBot,
}: {
  dropId: string;
  zone: DropZone;
  isBreak: boolean;
  fusable?: boolean;
  items: Placement[];
  homeworkDueItems?: HomeworkDueProjection[];
  coverage?: GridData["coverage"][number];
  /** Ids of every placement party to a double-booking (union of grid.conflicts'
   *  placementIds). The cell shows the conflict badge iff one of ITS rendered
   *  items is in this set — so the badge coincides with the drawer's per-chip
   *  conflict section. Omitted by the homework rail (no conflict badge there). */
  conflictedPlacementIds?: Set<string>;
  overload?: { flagId: string; placementIds: string[] };
  outOfOrderChips: Map<string, { sequenceId: string; flagId: string }>;
  overloadContext?: string;
  lens: Lens;
  editBlocks: boolean;
  draggable?: boolean;
  groupEmojiById: Map<string, string | null>;
  onQuickAdd: () => void;
  onOpenDetail: (t: DrawerTarget, triggerToken: string) => void;
  onFillSlot?: (p: Placement) => void;
  /** Opens the class drawer for this cell's class. Absent on the homework rail
   *  (not a class) — its presence is what shows the class-open chevron. */
  onOpenClass?: (groupId: string, subject: string) => void;
  onDismissOverload?: (flagId: string, placementIds: string[]) => void;
  onAskBot?: (text: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId, data: { zone } });
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
  const isEmpty = items.length === 0 && homeworkDueItems.length === 0;
  // "Edit blocks" fuses an occupied cell into ONE draggable card so re-timing a
  // block moves its class + activity together. Empty cells become dashed drop
  // targets. The homework due-rail (fusable=false) keeps its per-item cards.
  const fused = editBlocks && fusable && !isEmpty;
  const emptyUnlocked = editBlocks && fusable && isEmpty;

  // The Overloaded flag is a wide text pill, so it renders in NORMAL FLOW at the
  // top of the cell (reserving its own row) rather than overlapping content —
  // placed before the content stack in both the fused and the locked renderings.
  const overloadTag = overload && (
    <OverloadTag
      onDismiss={() => onDismissOverload?.(overload.flagId, overload.placementIds)}
      onAskBot={() =>
        onAskBot?.(
          `${overloadContext ?? "This slot"} has more than one activity scheduled at once. Help me spread them out or resolve the overlap.`,
        )
      }
    />
  );
  // Coverage / conflict badges — small icons that stay as absolute top-right
  // overlays, shared by both the fused and the borderless (locked) renderings.
  const cornerBadges = (understaffed || hasConflict) && (
    <HStack position="absolute" top={1} right={1} gap={1}>
      {hasConflict && (
        <Box
          role="img"
          aria-label={conflictLabel}
          title={conflictLabel}
          color="red.500"
        >
          <Warning size={13} weight="fill" />
        </Box>
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

  // Unlocked + occupied: the whole block is one grab target.
  if (fused) {
    return (
      <Box
        ref={setNodeRef}
        position="relative"
        minH="64px"
        display="flex"
        flexDirection="column"
        gap={1}
        borderRadius="lg"
        outline="2px solid"
        outlineColor={isOver ? "violet.400" : "transparent"}
        outlineOffset="1px"
        transition="outline-color 0.1s"
      >
        {overloadTag}
        <FusedCell
          placements={items}
          dragId={dropId.replace(/^cell:/, "cellgrab:")}
          lens={lens}
          groupEmojiById={groupEmojiById}
          onOpenDetail={onOpenDetail}
        />
        {cornerBadges}
      </Box>
    );
  }

  // Locked (view): borderless — the page shows through and the activity card is
  // the one solid object. Empty cells get a hairline baseline + hover ＋; when
  // unlocked-but-empty they become a dashed drop target.
  // A cell holding only bare slots (no activity card) is an OPEN target: it reads
  // as an empty, dashed placeholder — distinct from a filled cell's solid card — so
  // full vs empty is legible at a glance.
  const awaitingOnly = activityCards.length === 0 && blockTitles.length > 0;
  const isHomeworkRail = !fusable;
  // A filled class cell reads as full: the CELL itself becomes the solid white
  // card (border + bg live on the shell), mirroring how an awaiting slot's dashed
  // shell traces the whole cell — so filled and awaiting share the same box,
  // padding, and top-aligned content, differing only by fill state. This holds
  // whether the cell is a pure activity chip OR a class header + its activity
  // chip (a cascaded class slot keeps its recurring structure alongside the
  // concrete chip): any content that includes an activity card reads as filled,
  // never the borderless fallback. Not for the compact homework rail.
  const filled = !isHomeworkRail && activityCards.length > 0;
  const filledLive = filled && activityCards.some((p) => p.linkState === "live");
  const shell = isOver
    ? { border: "1px solid", borderColor: "violet.400", borderRadius: "md", bg: "violet.50" }
    : emptyUnlocked
      ? { border: "1px dashed", borderColor: "violet.200", borderRadius: "md", bg: "violet.50" }
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
  // Normal (locked) mode is for putting ACTIVITIES into existing class slots —
  // not for creating slots (that's Edit blocks). So the cell has ONE click target,
  // derived from what it holds:
  //  • a class slot awaiting work → fill THAT slot. The whole cell is the target
  //    and it inherits the slot's own group, so it never defaults to the wrong
  //    group (the "asks me to add for Honu" bug).
  //  • an empty class cell → inert in locked mode: you can't add an assignment
  //    where there's no class slot. It only invites adding while Edit blocks is
  //    on, or on the homework rail (fusable === false), which owns its add flow.
  //  • a filled activity cell → defers to its card (which opens the detail drawer).
  const firstAwaiting = blockTitles[0];
  const fillCell =
    awaitingOnly && onFillSlot && firstAwaiting ? () => onFillSlot(firstAwaiting) : undefined;
  const addHere = isHomeworkRail || (isEmpty && editBlocks) ? onQuickAdd : undefined;
  const cellClick = fillCell ?? addHere;
  const hoverable =
    activityCards.length === 0 &&
    homeworkDueItems.length === 0 &&
    Boolean(cellClick);
  // The class this cell belongs to (bare or filled) — its recurring/concrete rows
  // all share (groupId, subject). A discreet chevron opens the class drawer for
  // it WITHOUT stealing the cell's fill click or a chip's detail click. Not shown
  // on the homework rail (which never passes onOpenClass) or empty cells.
  const classItem = onOpenClass && items.length > 0 ? items[0] : null;
  return (
    <Box
      ref={setNodeRef}
      position="relative"
      minH="64px"
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
            ? "Add a class here"
            : undefined
      }
      cursor={cellClick ? "pointer" : "default"}
      _hover={hoverable ? { bg: emptyUnlocked ? "violet.100" : "gray.50" } : undefined}
      onClick={cellClick}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (cellClick && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          cellClick();
        }
      }}
    >
      {overloadTag}
      <VStack align="stretch" gap={filled ? 0 : 1} flex={1}>
        {homeworkDueItems.map((item) => (
          <Link
            key={item.key}
            href={`/teacher/schedule/${item.assignmentId}`}
            onClick={(event) => event.stopPropagation()}
          >
            <EnrichedChip
              p={item}
              lens={lens}
              groupEmoji={groupEmojiById.get(String(item.groupId))}
            />
          </Link>
        ))}
        {blockTitles.map((p, index) => (
          <PlacementChip
            key={String(p._id)}
            p={p}
            lens={lens}
            groupEmojiById={groupEmojiById}
            enableBlockTitle
            editBlocks={editBlocks}
            draggable={draggable}
            compound={filled}
            separated={filled && index > 0}
            outOfOrder={outOfOrderChips.get(String(p._id))}
            onOpenDetail={onOpenDetail}
            onFillSlot={onFillSlot}
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
            outOfOrder={outOfOrderChips.get(String(p._id))}
            draggable={draggable}
            onOpenDetail={onOpenDetail}
          />
        ))}
      </VStack>

      {cornerBadges}

      {/* Class-open chevron — a discreet, always-present affordance on the
          class's right edge. stopPropagation keeps it off the cell's fill click
          and the chip's detail click (the two existing actions the plan says not
          to steal). */}
      {classItem && (
        <chakra.button
          type="button"
          position="absolute"
          top="50%"
          right={0.5}
          transform="translateY(-50%)"
          zIndex={1}
          display="flex"
          alignItems="center"
          justifyContent="center"
          w={4}
          h={5}
          borderRadius="sm"
          color="charcoal.300"
          opacity={0.5}
          cursor="pointer"
          aria-label={`Open the ${classItem.subject} class`}
          title="Open class"
          _hover={{ opacity: 1, bg: "gray.100", color: "charcoal.600" }}
          _focusVisible={{
            opacity: 1,
            outline: "2px solid",
            outlineColor: "violet.400",
            outlineOffset: "1px",
          }}
          onClick={(e) => {
            e.stopPropagation();
            onOpenClass!(String(classItem.groupId), classItem.subject);
          }}
        >
          <CaretRight size={13} weight="bold" />
        </chakra.button>
      )}

      {cellClick && activityCards.length === 0 && (
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

// ── Fused cell (edit mode) ───────────────────────────────────────────────────
// When "Edit blocks" is on, an occupied cell lifts off the grid as ONE elevated,
// draggable card. Its bare-class title(s) and activity fuse into a single object
// with one grab target (a grip), so a drag re-times the whole block together.
// A click opens the detail drawer in block scope (per-row tap-through to each
// placement's detail); a drag (>5px) moves the block. Movement is drag-only.

function FusedCellBody({
  placements,
  lens,
  groupEmojiById,
}: {
  placements: Placement[];
  lens: Lens;
  groupEmojiById: Map<string, string | null>;
}) {
  const blockTitles = placements.filter((p) => isAwaitingActivity(p));
  const activityCards = placements.filter((p) => !isAwaitingActivity(p));
  // Same T3 suppression as the locked cell: an activity card drops its subject
  // eyebrow when a header in this fused block already names its class.
  const headerClassKeys = new Set(blockTitles.map((p) => classKey(p)));
  return (
    <VStack align="stretch" gap={0}>
      {blockTitles.map((p) => (
        <ChipBody key={String(p._id)} p={p} lens={lens} groupEmojiById={groupEmojiById} asBlockTitle />
      ))}
      {activityCards.map((p, i) => (
        <Box
          key={String(p._id)}
          borderTop={blockTitles.length > 0 || i > 0 ? "1px solid" : undefined}
          borderColor="gray.100"
        >
          <ChipBody
            p={p}
            lens={lens}
            groupEmojiById={groupEmojiById}
            flat
            suppressSubjectEyebrow={headerClassKeys.has(classKey(p))}
          />
        </Box>
      ))}
    </VStack>
  );
}

function FusedCell({
  placements,
  dragId,
  lens,
  groupEmojiById,
  onOpenDetail,
}: {
  placements: Placement[];
  dragId: string;
  lens: Lens;
  groupEmojiById: Map<string, string | null>;
  onOpenDetail: (t: DrawerTarget, triggerToken: string) => void;
}) {
  const placementIds = placements.map((p) => String(p._id));
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: dragId,
    data: { kind: "cell", placementIds },
  });
  const subjects = placements.map((p) => p.subject).join(", ");
  return (
    <chakra.button
      type="button"
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      w="full"
      flex="1"
      p={0}
      border="1px solid"
      borderColor="gray.200"
      bg="white"
      borderRadius="lg"
      boxShadow={isDragging ? "xl" : "lg"}
      textAlign="left"
      overflow="hidden"
      position="relative"
      cursor={isDragging ? "grabbing" : "grab"}
      touchAction="none"
      opacity={isDragging ? 0.4 : 1}
      aria-label={`Details for block: ${subjects}`}
      data-detail-trigger={dragId}
      onClick={(e) => {
        e.stopPropagation();
        onOpenDetail({ kind: "cell", placementIds }, dragId);
      }}
    >
      <Box position="absolute" top={1} right={1} color="gray.300" pointerEvents="none" zIndex={1}>
        <DotsSixVertical size={14} weight="bold" />
      </Box>
      <FusedCellBody placements={placements} lens={lens} groupEmojiById={groupEmojiById} />
    </chakra.button>
  );
}

// ── Dismissible flag tags ────────────────────────────────────────────────────

function OverloadTag({ onDismiss, onAskBot }: { onDismiss: () => void; onAskBot: () => void }) {
  return (
    <Menu.Root positioning={{ placement: "bottom-start" }}>
      <Menu.Trigger asChild>
        <HStack
          as="button"
          alignSelf="flex-start"
          gap={0.5}
          bg="amber.50"
          color="amber.700"
          borderRadius="sm"
          px={1}
          py={0.5}
          fontSize="2xs"
          fontWeight="700"
          cursor="pointer"
          _hover={{ bg: "amber.100" }}
          onClick={(e) => e.stopPropagation()}
          title="More than one activity in this slot"
        >
          <Warning size={11} weight="fill" />
          <Text>Overloaded</Text>
        </HStack>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content minW="180px" onClick={(e) => e.stopPropagation()}>
            <Menu.Item value="ask" onClick={onAskBot}>
              <ChatCircle size={15} /> Ask the bot to resolve
            </Menu.Item>
            <Menu.Item value="dismiss" onClick={onDismiss}>
              <Check size={15} /> It&apos;s fine — dismiss
            </Menu.Item>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

// ── Draggable placement chip ─────────────────────────────────────────────────

function PlacementChip({
  p,
  lens,
  groupEmojiById,
  outOfOrder,
  enableBlockTitle,
  editBlocks,
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
  outOfOrder?: { sequenceId: string; flagId: string };
  enableBlockTitle?: boolean;
  editBlocks?: boolean;
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
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: String(p._id) });
  const placementId = String(p._id);
  // A bare class (no linked activity) reads as the block's TITLE, not an activity
  // card — an EMPTY slot rendered as a flat, full-bleed placeholder in its cell.
  //  - Locked: flat + non-draggable; a click opens the quick activity picker to
  //    FILL the slot (onFillSlot). Editing the slot itself (rename, re-time) stays
  //    an Edit-blocks affordance.
  //  - Unlocked ("Edit blocks"): the SAME flat title lifts off the grid with a drop
  //    shadow and becomes draggable (drag re-times; click opens the drawer).
  // The shelf keeps every item a draggable card so it can be dropped onto the grid.
  const asBlock = Boolean(enableBlockTitle) && isAwaitingActivity(p);
  if (asBlock && !editBlocks) {
    // stopPropagation keeps this off the cell's generic add-a-class target; clicking
    // the slot fills THAT slot, while empty cell space still adds a new class.
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
  const canDrag = draggable || asBlock;
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
        // An unlocked block keeps its flat title but lifts off the grid with a
        // white fill + drop shadow — the affordance that it's now draggable.
        bg={asBlock ? "white" : "transparent"}
        borderRadius={asBlock ? "md" : undefined}
        boxShadow={asBlock ? (isDragging ? "lg" : "md") : undefined}
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
          asBlockTitle={asBlock}
          fill={fill}
          flagged={!asBlock && Boolean(outOfOrder)}
          outOfOrder={!asBlock && Boolean(outOfOrder)}
          suppressSubjectEyebrow={!asBlock && suppressSubjectEyebrow}
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
  outOfOrder,
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
  outOfOrder?: boolean;
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
      outOfOrder={outOfOrder}
      asBlockTitle={asBlockTitle}
      fill={fill}
      flat={flat}
      suppressSubjectEyebrow={suppressSubjectEyebrow}
    />
  );
}

// ── Shelf tray ───────────────────────────────────────────────────────────────

function ShelfTray({
  items,
  groupEmojiById,
  lens,
  onQuickAdd,
  onOpenDetail,
}: {
  items: Placement[];
  groupEmojiById: Map<string, string | null>;
  lens: Lens;
  onQuickAdd: () => void;
  onOpenDetail: (t: DrawerTarget, triggerToken: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: "shelf" });
  return (
    <Box
      ref={setNodeRef}
      w="220px"
      flexShrink={0}
      borderLeft="1px solid"
      borderColor="gray.100"
      bg={isOver ? "violet.50" : "gray.50"}
      p={2.5}
      overflow="auto"
      transition="background 0.1s"
    >
      <Text fontFamily="heading" fontWeight="700" fontSize="xs" color="charcoal.400" textTransform="uppercase" letterSpacing="0.04em" mb={2}>
        Not yet scheduled
      </Text>
      <chakra.button
        type="button"
        w="full"
        display="flex"
        alignItems="center"
        gap={1.5}
        px={2}
        py={1.5}
        mb={2}
        border={0}
        borderRadius="md"
        bg="transparent"
        color="charcoal.400"
        fontSize="xs"
        fontWeight="700"
        cursor="pointer"
        aria-label="Quick add a class"
        onClick={onQuickAdd}
        _hover={{ bg: "white", color: "navy.600" }}
        _focusVisible={{ outline: "2px solid", outlineColor: "violet.300", outlineOffset: "2px" }}
      >
        <Plus size={14} weight="bold" />
        <Text>Quick add</Text>
      </chakra.button>
      {items.length === 0 ? (
        <Text fontSize="xs" color="charcoal.300">
          Classes &amp; one-offs that don&apos;t have a day yet. Drag one onto the grid to place it.
        </Text>
      ) : (
        <VStack align="stretch" gap={1.5}>
          {items.map((p) => (
            <PlacementChip key={String(p._id)} p={p} lens={lens} groupEmojiById={groupEmojiById} onOpenDetail={onOpenDetail} />
          ))}
        </VStack>
      )}
    </Box>
  );
}

// ── Quick-add palette ────────────────────────────────────────────────────────

function QuickAddPalette({
  onClose,
  blocks,
  placements,
  closures,
  closureTimeZone,
  anchorWeekStartMs,
  groupOptions,
  teacherOptions,
  defaultGroupId,
  defaultTeacherId,
  initial,
  fillTarget,
  onRemove,
  onSubmit,
}: {
  onClose: () => void;
  blocks: Block[];
  placements: GridData["placements"];
  closures: GridData["closures"];
  closureTimeZone: string;
  anchorWeekStartMs: number;
  groupOptions: { id: string; name: string; emoji: string | null }[];
  teacherOptions: GridData["teachers"];
  defaultGroupId: string;
  defaultTeacherId: string;
  initial: { weekday?: number; blockId?: string };
  /** When set, the palette FILLS this existing empty slot with a chosen activity
   *  (the class's subject/teacher/time are already the slot's) — so it's a pure
   *  activity picker, not the full add-a-class form. */
  fillTarget?: { placementId: string; subject: string } | null;
  /** Fill mode only: clear this (empty) slot entirely. */
  onRemove?: () => void;
  onSubmit: (v: {
    subject: string;
    groupId: string;
    teacherId: string;
    weekday: number | null;
    blockId: string | null;
    activityId: Id<"activities"> | null;
    unitId: Id<"units"> | null;
    skillKey: string | null;
    /** Unit picks only: "flow" spreads one activity per class meeting; "sameDay"
     *  stacks the whole unit on the chosen day. Ignored for non-unit adds. */
    layout: "flow" | "sameDay";
  }) => void;
}) {
  const [subject, setSubject] = useState("");
  const [selectedActivityId, setSelectedActivityId] = useState<Id<"activities"> | null>(null);
  // When a UNIT is picked, the palette flows the whole unit onto the class's
  // weekly meetings (cascade). There is no pacing toggle — one activity per
  // meeting is the only rhythm (resolved 2026-07-23).
  const [selectedUnitId, setSelectedUnitId] = useState<Id<"units"> | null>(null);
  const [selectedSkillKey, setSelectedSkillKey] = useState<string | null>(null);
  const [suggestionsVisible, setSuggestionsVisible] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [groupId, setGroupId] = useState(defaultGroupId);
  const [teacherId, setTeacherId] = useState(defaultTeacherId);
  const [weekday, setWeekday] = useState<number | null>(initial.weekday ?? null);
  const [blockId, setBlockId] = useState<string | null>(initial.blockId ?? null);
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
    const unitSuggestions: CurriculumSuggestion[] = unitMatches.map((unit) => ({
      type: "unit",
      key: `unit:${String(unit._id)}`,
      label: unit.title,
      unitId: unit._id,
      subtitle: "Unit",
    }));
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
    return [
      ...unitSuggestions,
      ...activitySuggestions,
      ...skillSuggestions,
    ].slice(0, 12);
  }, [
    activeUnit,
    activityMatches,
    queryReady,
    skills,
    unitMatches,
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

  const isFill = Boolean(fillTarget);
  const isUnit = Boolean(selectedUnitId);
  // A unit pick flows the whole unit (needs a group + a placed start slot);
  // fill mode needs a concrete activity/skill pick; add-a-class mode just needs
  // a label.
  const canSubmit = isUnit
    ? Boolean(groupId)
    : isFill
      ? Boolean(selectedActivityId || selectedSkillKey)
      : subject.trim().length > 0 && Boolean(groupId);
  // Block-order map + lookup for the meeting generator and labels.
  const blockOrder = useMemo(
    () => new Map(blocks.map((b) => [String(b._id), b.order])),
    [blocks],
  );
  const blockById = useMemo(
    () => new Map(blocks.map((b) => [String(b._id), b])),
    [blocks],
  );

  // The class we're flowing into = (groupId, subject). Its weekly meeting
  // pattern is derived from the schedule's recurring rows — the SAME pure helper
  // the backend uses, so the preview can't drift from what gets written.
  const flowSubject = isFill ? fillTarget!.subject : subject.trim();
  const meetingPattern = useMemo(
    () =>
      deriveClassMeetingPattern({
        placements: placements.map((p) => ({
          weekStartMs: p.weekStartMs ?? null,
          weekday: p.weekday ?? null,
          blockId: p.blockId ? String(p.blockId) : null,
          groupId: String(p.groupId),
          subject: p.subject,
          mode: p.mode ?? null,
        })),
        groupId,
        subject: flowSubject,
        blockOrder,
      }),
    [placements, groupId, flowSubject, blockOrder],
  );
  // Human "Meets Mon Wed Fri 9:00" label for the discovered pattern.
  const meetingLabel = useMemo(() => {
    if (meetingPattern.length === 0) return null;
    const days = meetingPattern
      .map((m) => WEEKDAYS.find((d) => d.n === m.weekday)?.label ?? "")
      .filter(Boolean);
    const startTimes = Array.from(
      new Set(
        meetingPattern
          .map((m) => blockById.get(m.blockId)?.startLocal)
          .filter((t): t is string => Boolean(t)),
      ),
    );
    const time = startTimes.length === 1 ? ` ${fmtTime(startTimes[0])}` : "";
    return `Meets ${days.join(" ")}${time}`;
  }, [meetingPattern, blockById]);

  // Preview where each of the unit's activities lands, from the shared
  // meeting-slot generator — one activity per meeting, chronological from the
  // clicked slot, skipping no-school days. Only computable once a start slot is
  // chosen.
  const previewActivities =
    isUnit && activeUnit && String(activeUnit._id) === String(selectedUnitId)
      ? activities
      : undefined;
  const selectedUnitActivityCount = previewActivities?.length;
  const cascadePreview = useMemo(() => {
    if (!previewActivities || previewActivities.length === 0) return null;
    if (weekday == null || !blockId) return null;
    const dayLabel = (n: number) => WEEKDAYS.find((d) => d.n === n)?.label ?? "—";
    const blockLabel = (id: string) => blockById.get(id)?.label ?? "—";
    const blockMinutes = (id: string): number | null => {
      const b = blockById.get(id);
      if (!b) return null;
      const parse = (hhmm: string) => {
        const [h, m] = hhmm.split(":").map(Number);
        return Number.isNaN(h) || Number.isNaN(m) ? null : h * 60 + m;
      };
      const start = parse(b.startLocal);
      const end = parse(b.endLocal);
      if (start == null || end == null) return null;
      return end - start;
    };
    const slots = generateMeetingSlots({
      pattern: meetingPattern,
      blockOrder,
      startWeekStartMs: anchorWeekStartMs,
      startWeekday: weekday,
      startBlockId: String(blockId),
      count: previewActivities.length,
      closures,
      timeZone: closureTimeZone,
    });
    const rows = previewActivities.map((a, i) => {
      const s = slots[i];
      const dateMs = s.weekStartMs + (s.weekday - 1) * DAY_MS;
      const blockMin = blockMinutes(s.blockId);
      const dur = a.durationMinutes ?? null;
      // Duration lint: the block's own length is the calibration (§6) — no
      // invented threshold. Flag only when the activity clearly overruns.
      const durationLint =
        dur != null && blockMin != null && dur > blockMin
          ? `${dur} min planned · this block is ${blockMin} min`
          : null;
      return {
        title: a.title,
        dateLabel: `${dayLabel(s.weekday)} ${monthDay(dateMs)}`,
        block: blockLabel(s.blockId),
        durationLint,
      };
    });
    // Closures that fall inside the flow's span (shown as "skips"), so the dates
    // jumping over a holiday reads as intentional, not a glitch.
    const last = slots[slots.length - 1];
    const spanEnd = last.weekStartMs + (last.weekday - 1) * DAY_MS;
    const spanStartKey = toDayKey(anchorWeekStartMs);
    const spanEndKey = toDayKey(spanEnd);
    const skipped = closures
      .filter((c) => c.endDayKey >= spanStartKey && c.startDayKey <= spanEndKey)
      .map((c) => c.label);
    const finishes = last ? monthDay(spanEnd) : null;
    return { rows, skipped, finishes };
  }, [
    previewActivities,
    weekday,
    blockId,
    meetingPattern,
    blockOrder,
    blockById,
    anchorWeekStartMs,
    closures,
    closureTimeZone,
  ]);
  const submit = (layout: "flow" | "sameDay" = "flow") => {
    if (!canSubmit) return;
    onSubmit({
      subject: isFill ? fillTarget!.subject : subject.trim(),
      groupId,
      teacherId,
      weekday,
      blockId,
      activityId: selectedActivityId,
      unitId: selectedUnitId,
      skillKey: selectedSkillKey,
      layout,
    });
  };
  const selectSuggestion = (suggestion: CurriculumSuggestion) => {
    setSubject(suggestion.label);
    setSelectedActivityId(suggestion.type === "activity" ? suggestion.activityId : null);
    setSelectedUnitId(suggestion.type === "unit" ? suggestion.unitId : null);
    setSelectedSkillKey(
      suggestion.type === "skill" ? suggestion.nodeKey : null,
    );
    setSuggestionsVisible(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const selGroup = groupOptions.find((g) => g.id === groupId);
  const selTeacher = teacherOptions.find((t) => String(t._id) === teacherId);
  const selBlock = blocks.find((b) => String(b._id) === blockId);

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
          {/* Fill mode: the class + time are the slot's already, so show just the
              target and go straight to the activity search. */}
          {isFill && (
            <Box px={4} pt={3} pb={2.5} borderBottom="1px solid" borderColor="gray.100">
              <Text fontSize="2xs" fontWeight="700" textTransform="uppercase" letterSpacing="0.04em" color="charcoal.300">
                {isUnit ? "Flow a unit into" : "Add an activity to"}
              </Text>
              <HStack gap={2} mt={0.5} align="center">
                <Text fontFamily="heading" fontWeight="700" fontSize="md" color="navy.700" lineClamp={1}>
                  {fillTarget!.subject}
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
            </Box>
          )}
          {/* Context pinned at top so it doesn't bounce as suggestions appear/resize */}
          {!isFill && (
          <Box px={4} pt={3} pb={2.5} borderBottom="1px solid" borderColor="gray.100">
            <HStack gap={2} flexWrap="wrap">
              <FieldPicker label="Group" value={selGroup ? `${selGroup.emoji ? selGroup.emoji + " " : ""}${selGroup.name}` : "—"}>
                {groupOptions.map((g) => (
                  <Menu.Item key={g.id} value={g.id} cursor="pointer" onClick={() => setGroupId(g.id)}>
                    {g.emoji ? `${g.emoji} ` : ""}{g.name}
                  </Menu.Item>
                ))}
              </FieldPicker>

              <FieldPicker label="Teacher" value={selTeacher ? selTeacher.name : "Unassigned"}>
                <TeacherMenuItems
                  teachers={teacherOptions}
                  selectedId={teacherId}
                  onSelect={setTeacherId}
                  includeUnassigned
                />
              </FieldPicker>

              <FieldPicker label="Day" value={weekday ? WEEKDAYS.find((d) => d.n === weekday)?.label ?? "—" : "Shelf"}>
                <Menu.Item
                  value="shelf"
                  cursor="pointer"
                  onClick={() => {
                    setWeekday(null);
                    setBlockId(null);
                  }}
                >
                  Shelf (no day)
                </Menu.Item>
                {WEEKDAYS.map((d) => (
                  <Menu.Item key={d.n} value={String(d.n)} cursor="pointer" onClick={() => setWeekday(d.n)}>
                    {d.label}
                  </Menu.Item>
                ))}
              </FieldPicker>

              <FieldPicker label="Block" value={selBlock ? selBlock.label : "Shelf"}>
                <Menu.Item
                  value="shelf"
                  cursor="pointer"
                  onClick={() => {
                    setWeekday(null);
                    setBlockId(null);
                  }}
                >
                  Shelf (no block)
                </Menu.Item>
                {blocks.map((b) => (
                  <Menu.Item key={String(b._id)} value={String(b._id)} cursor="pointer" onClick={() => setBlockId(String(b._id))}>
                    {b.label} · {fmtTime(b.startLocal)}
                  </Menu.Item>
                ))}
              </FieldPicker>
            </HStack>
          </Box>
          )}

          <Flex align="center" gap={2} px={4} py={3} borderBottom="1px solid" borderColor="gray.100">
            <MagnifyingGlass size={16} />
            <Input
              ref={inputRef}
              variant="flushed"
              border="none"
              placeholder={
                isFill
                  ? "Search activities or math skills…"
                  : "Search units, activities, or math skills…"
              }
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
                setSelectedUnitId(null);
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

          {/* Unit pick → choose how its activities flow onto the grid. */}
          {isUnit && (
            <Box px={4} py={3} borderBottom="1px solid" borderColor="gray.100" bg="violet.50">
              <HStack justify="space-between" align="start" mb={2} gap={3}>
                <VStack align="start" gap={0.5} minW={0}>
                  <Text fontSize="2xs" fontWeight="700" textTransform="uppercase" letterSpacing="0.04em" color="violet.700">
                    Flow a unit into {flowSubject || "this class"}
                  </Text>
                  {meetingLabel ? (
                    <Text fontSize="2xs" color="charcoal.400" fontWeight="600">
                      {meetingLabel} · one activity per meeting
                    </Text>
                  ) : (
                    <Text fontSize="2xs" color="charcoal.400">
                      No recurring class here — lands one activity per week from
                      this slot.
                    </Text>
                  )}
                </VStack>
                {typeof selectedUnitActivityCount === "number" && (
                  <Text fontSize="2xs" color="charcoal.400" fontWeight="600" flexShrink={0}>
                    {selectedUnitActivityCount} {selectedUnitActivityCount === 1 ? "activity" : "activities"}
                  </Text>
                )}
              </HStack>
              {cascadePreview && (
                <Box mt={1} borderTop="1px solid" borderColor="violet.100" pt={2.5}>
                  <Text fontSize="2xs" fontWeight="700" textTransform="uppercase" letterSpacing="0.04em" color="violet.700" mb={1.5}>
                    Preview
                  </Text>
                  <VStack align="stretch" gap={1} maxH="180px" overflowY="auto" pr={1}>
                    {cascadePreview.rows.map((row, i) => (
                      <VStack key={i} align="stretch" gap={0}>
                        <HStack justify="space-between" gap={3} align="center">
                          <HStack gap={2} minW={0}>
                            <Text fontSize="2xs" fontWeight="700" color="charcoal.300" w="16px" flexShrink={0} textAlign="right">
                              {i + 1}
                            </Text>
                            <Text fontSize="xs" color="navy.700" lineClamp={1}>
                              {row.title}
                            </Text>
                          </HStack>
                          <HStack gap={1.5} flexShrink={0}>
                            <Text fontSize="2xs" fontWeight="700" color="charcoal.500">
                              {row.dateLabel}
                            </Text>
                            <Text fontSize="2xs" color="charcoal.300">·</Text>
                            <Text fontSize="2xs" color="charcoal.400" lineClamp={1} maxW="120px">
                              {row.block}
                            </Text>
                          </HStack>
                        </HStack>
                        {row.durationLint && (
                          <Text fontSize="2xs" color="orange.600" pl="26px" lineClamp={1}>
                            ⚠ {row.durationLint}
                          </Text>
                        )}
                      </VStack>
                    ))}
                  </VStack>
                  {cascadePreview.skipped.length > 0 && (
                    <Text fontSize="2xs" color="charcoal.400" mt={2}>
                      Skips no-school days: {cascadePreview.skipped.join(", ")}
                    </Text>
                  )}
                  {cascadePreview.finishes && (
                    <Text fontSize="2xs" color="charcoal.500" fontWeight="700" mt={1.5}>
                      At this pace: finishes {cascadePreview.finishes}
                    </Text>
                  )}
                </Box>
              )}
              <Text fontSize="2xs" color="charcoal.400" mt={2.5} fontStyle="italic">
                A projection at the current pace — you can drag activities, or if a
                class falls behind, push the rest from a past meeting.
              </Text>
            </Box>
          )}

          <HStack justify="space-between" px={4} py={3}>
            {isFill && onRemove ? (
              <Button size="sm" variant="ghost" colorPalette="red" onClick={onRemove} fontFamily="heading">
                Remove slot
              </Button>
            ) : (
              <Text fontSize="2xs" color="charcoal.300">
                {isUnit
                  ? weekday && blockId
                    ? "Flow across meetings, or stack it all on this day."
                    : "Pick a day + block to flow a unit."
                  : weekday && blockId
                    ? "Places on the grid."
                    : "Parks on the shelf (pick a day + block to place it)."}
              </Text>
            )}
            <HStack gap={2}>
              <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
              {isUnit && (
                <Button
                  size="sm"
                  variant="outline"
                  colorPalette="violet"
                  disabled={!canSubmit || weekday == null || !blockId}
                  onClick={() => submit("sameDay")}
                  fontFamily="heading"
                >
                  All on one day
                </Button>
              )}
              <Button
                size="sm"
                colorPalette="violet"
                disabled={!canSubmit || (isUnit && (weekday == null || !blockId))}
                onClick={() => submit("flow")}
                fontFamily="heading"
              >
                {isUnit ? "Flow unit" : isFill ? "Add activity" : "Add class"}
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
          : "Add bell-schedule blocks (Morning Circle, Block A–D, Recess, Lunch…) for this term, then place classes into them — by drag, Quick add, or by asking the aide."}
      </Text>
    </Flex>
  );
}
