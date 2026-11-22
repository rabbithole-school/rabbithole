// Master-schedule aide tools — the chat/voice transport over the same
// masterSchedule core that backs the teacher grid UI (convex/masterSchedule.ts).
// This is the deliberate "killer app" for the bot: complex, multi-cell schedule
// surgery a teacher would dread doing by hand — "we have a field trip Wednesday,
// help me shuffle", "Lehua is out sick today, cover her blocks", "push Friday's
// science back a week" — becomes one or a few tool calls.
//
// EVERY direct-manipulation affordance in the grid has a matching tool here, so
// the schedule is fully drivable without a mouse (the project's accessibility
// story is the bot, not a keyboard-drag sensor). Each tool calls a verified
// internal.masterSchedule.aide* fn with the caller's real id; those verify the
// caller document and tenant access to named groups, staff, and assignments
// (they have no ctx.user).
//
// Composed into assembleCurriculumTools (lib/aideTools.ts) behind the same
// teacher/admin gate as the assignment-scheduling tools (it shows teacher +
// roster names). Checked inline here (returns [] otherwise) so callers spread
// the result unconditionally. Shared verbatim by the in-app aide, Slack, + MCP.

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  dayKeyForTimezone,
  dayStartForDayKey,
} from "../../shared/institutionDay";
import { scheduleWeekStartMs } from "../../shared/scheduleWeek";
import { isTeacherRole, type Role } from "./roles";
import type { AideEmit } from "./aideStream";

const WEEKDAY_DESC =
  "Weekday 1–5 (1 = Monday … 5 = Friday). The master schedule is a recurring Mon–Fri week.";

// Steers the aide to the right app grant: a placement covers ONE block's
// window; "all day" for a group is enable_app_for_group's one-day grant.
const APP_TARGET_DESC =
  "Optional: place a catalog app (id from list_external_apps) on this block. It goes live at " +
  "the block's start and clears ten minutes after the block ends, so it covers that one block " +
  "only. Use it for an app in one specific class period. For an app \"all day\" or \"for today\", " +
  "call enable_app_for_group with throughDay:'today' instead, never one placement per block. " +
  "Only class blocks take a class or an app: recess, lunch, prep and homework rows refuse it. " +
  "A cell can carry an app or a curriculum activity, not both.";

/** A YYYY-MM-DD school date → its weekday + the school-local Monday anchor of
 *  its week, in the given institution zone. Exported for tests. */
export function parseSchoolDate(
  date: string,
  timeZone: string,
):
  | { weekday: number; weekStartMs: number }
  | { error: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { error: `Invalid date "${date}". Use YYYY-MM-DD.` };
  }
  let noonMs: number;
  try {
    noonMs = dayStartForDayKey(date, timeZone) + 12 * 60 * 60 * 1000;
  } catch {
    return { error: `Invalid date "${date}". Use YYYY-MM-DD.` };
  }
  if (dayKeyForTimezone(noonMs, timeZone) !== date) {
    return { error: `Invalid date "${date}". Use YYYY-MM-DD.` };
  }
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) {
    return { error: `${date} is a weekend. Choose a Monday–Friday school date.` };
  }
  return { weekday, weekStartMs: scheduleWeekStartMs(noonMs, timeZone) };
}

/** Work given to a class cell's meeting (TRA-571): finished in that class, or by the end of its day. */
const CELL_FINISH_QUESTION =
  "NOT PLACED — nothing changed. The teacher hasn't said when they should finish it. Don't guess, and don't assume it is only for that class. Ask only that, in these words (never \"homework or class focus\"), offering: In that class (it leaves their screens when the class ends) → finish:'inClass' · By the end of that day (stays on their list, late after) → finish:'endOfThatDay'. For a due date on another day, use give with that date as finish.";

export async function makeMasterScheduleTools(
  ctx: ActionCtx,
  emit: AideEmit,
  opts: {
    role: Role | null | undefined;
    callerUserId: Id<"users">;
  },
) {
  // Same audience as the assignment-scheduling tools: the grid shows teacher
  // and scholar-group names, so teacher/admin only.
  if (!isTeacherRole(opts.role)) return [];
  const { callerUserId } = opts;
  // A YYYY-MM-DD date the write tools take is parsed in the TERM's zone — the
  // zone the grid and the placement mutations anchor weeks to — never the
  // caller's, which can differ for a lensed platform admin.
  // (Pacific/Honolulu for the primary — identical to the old fixed offset.)
  const termTimeZone = (target: { periodId?: string; placementId?: string }) =>
    ctx.runQuery(internal.masterSchedule.aideTermTimeZone, target);

  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );

  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const emitCaughtError = (name: string, e: unknown) => {
    emit({ toolComplete: { name, result: `⚠️ ${errMsg(e)}` } });
  };
  const validationError = (name: string, result: string) => {
    emit({ toolComplete: { name, result } });
    return result;
  };

  const listTermsTool = betaTool({
    name: "list_terms",
    description:
      "List the school's terms (reporting periods) — each with its id, label, status, and date range. A term OWNS one master schedule (weekly timetable), so this is the entry point: call it first to get the termId, then get_master_schedule for that term.",
    inputSchema: { type: "object" as const, properties: {}, required: [] as const },
    run: async () => {
      const terms = await ctx.runQuery(internal.masterSchedule.aideListTerms, {
        callerUserId,
      });
      emit({ toolComplete: { name: "list_terms", result: `${terms.length} term(s)` } });
      return JSON.stringify({ terms });
    },
  });

  const getScheduleTool = betaTool({
    name: "get_master_schedule",
    description:
      "Read a term's whole master schedule (weekly timetable) in one shot: the bell-schedule BLOCKS (rows, with times + kind + staffing need), every placed CLASS cell (group × weekday × block, with subject + teacher + any linked assignment/activity), classesWithoutADay (classes not yet on a day; work always has one), the derived staffing COVERAGE rail (how many adults each slot has vs needs), any double-booking CONFLICTS, and the term's TEACHERS + GROUPS with their ids. ALWAYS call this before moving anything — the ids it returns (blockId, placementId, teacherId, groupId) are what every write tool takes. This is how you 'see' the grid.",
    inputSchema: {
      type: "object" as const,
      properties: {
        termId: { type: "string" as const, description: "The term's id (from list_terms)." },
      },
      required: ["termId"] as const,
    },
    run: async (input: { termId: string }) => {
      let grid;
      try {
        grid = await ctx.runQuery(internal.masterSchedule.aideGrid, {
          callerUserId,
          periodId: input.termId as Id<"reportingPeriods">,
        });
      } catch (e) {
        emitCaughtError("get_master_schedule", e);
        return `Could not read the schedule: ${errMsg(e)}`;
      }
      emit({
        toolComplete: {
          name: "get_master_schedule",
          result: `${grid.placements.length} classes, ${grid.shelf.length} with no day yet, ${grid.conflicts.length} conflict(s)`,
        },
      });
      // The term's own institution zone (what the grid's week math used).
      const gridTimeZone = grid.closureTimeZone;
      const withWeeks = <T extends { weekStartMs: number | null }>(placement: T) =>
        placement.weekStartMs == null
          ? placement
          : {
              ...placement,
              week: dayKeyForTimezone(placement.weekStartMs, gridTimeZone),
            };
      const nowMs = Date.now();
      const currentWeek = scheduleWeekStartMs(nowMs, gridTimeZone);
      return JSON.stringify({
        ...grid,
        header: {
          today: dayKeyForTimezone(nowMs, gridTimeZone),
          currentWeekStart: dayKeyForTimezone(currentWeek, gridTimeZone),
        },
        placements: grid.placements.map(withWeeks),
        // Classes waiting for a day (Classes & times lists them). Work never
        // waits without a day (TRA-582).
        shelf: undefined,
        classesWithoutADay: grid.shelf.map(withWeeks),
      });
    },
  });

  const createBlockTool = betaTool({
    name: "create_schedule_block",
    description:
      "Add a bell-schedule BLOCK (a timetable row) to a term — e.g. 'Block A' 08:30–09:40, or 'Lunch' 11:30–12:15. Blocks default SHARED across every group in the term; pass groupId only for a per-group override row. `kind` recess/lunch default to needing 2 adults for the coverage rail. Times are school-local 'HH:MM'. Only school admins can change the bell schedule.",
    inputSchema: {
      type: "object" as const,
      properties: {
        termId: { type: "string" as const, description: "The term's id (from list_terms)." },
        label: { type: "string" as const, description: "Display name, e.g. 'Block A'." },
        startLocal: { type: "string" as const, description: "Start time 'HH:MM' (school-local)." },
        endLocal: { type: "string" as const, description: "End time 'HH:MM'." },
        kind: { type: "string" as const, enum: ["class", "recess", "lunch", "prep"] as const },
        groupId: { type: "string" as const, description: "Optional: a per-group override block (from get_master_schedule)." },
        staffNeed: { type: "number" as const, description: "Optional: adults this block needs (default 1; recess/lunch 2)." },
      },
      required: ["termId", "label", "startLocal", "endLocal"] as const,
    },
    run: async (input: {
      termId: string;
      label: string;
      startLocal: string;
      endLocal: string;
      kind?: "class" | "recess" | "lunch" | "prep";
      groupId?: string;
      staffNeed?: number;
    }) => {
      try {
        const blockId = await ctx.runMutation(internal.masterSchedule.aideCreateBlock, {
          callerUserId,
          periodId: input.termId as Id<"reportingPeriods">,
          label: input.label,
          startLocal: input.startLocal,
          endLocal: input.endLocal,
          kind: input.kind,
          groupId: input.groupId ? (input.groupId as Id<"scholarGroups">) : undefined,
          staffNeed: input.staffNeed,
        });
        emit({ toolComplete: { name: "create_schedule_block", result: `Added "${input.label}"` } });
        return JSON.stringify({ ok: true, blockId });
      } catch (e) {
        emitCaughtError("create_schedule_block", e);
        return `Could not create the block: ${errMsg(e)}`;
      }
    },
  });

  const updateBlockTool = betaTool({
    name: "update_schedule_block",
    description:
      "Edit a bell-schedule block's label, times, weekdays, staffing need, or kind. Identify it by blockId (from get_master_schedule). Only the fields you pass change. Only school admins can change the bell schedule.",
    inputSchema: {
      type: "object" as const,
      properties: {
        blockId: { type: "string" as const },
        label: { type: "string" as const },
        startLocal: { type: "string" as const, description: "'HH:MM'." },
        endLocal: { type: "string" as const, description: "'HH:MM'." },
        staffNeed: { type: "number" as const },
        kind: { type: "string" as const, enum: ["class", "recess", "lunch", "prep"] as const },
      },
      required: ["blockId"] as const,
    },
    run: async (input: {
      blockId: string;
      label?: string;
      startLocal?: string;
      endLocal?: string;
      staffNeed?: number;
      kind?: "class" | "recess" | "lunch" | "prep";
    }) => {
      try {
        await ctx.runMutation(internal.masterSchedule.aideUpdateBlock, {
          callerUserId,
          blockId: input.blockId as Id<"scheduleBlocks">,
          label: input.label,
          startLocal: input.startLocal,
          endLocal: input.endLocal,
          staffNeed: input.staffNeed,
          kind: input.kind,
        });
        emit({ toolComplete: { name: "update_schedule_block", result: "Updated block" } });
        return JSON.stringify({ ok: true });
      } catch (e) {
        emitCaughtError("update_schedule_block", e);
        return `Could not update the block: ${errMsg(e)}`;
      }
    },
  });

  const removeBlockTool = betaTool({
    name: "remove_schedule_block",
    description:
      "Delete a bell-schedule block. Any classes on it are NOT deleted: they move to not yet scheduled (no day), where Classes & times lists them. Work placed on the block keeps the gives it already made. Identify by blockId (from get_master_schedule). Confirm with the teacher first. Only school admins can change the bell schedule.",
    inputSchema: {
      type: "object" as const,
      properties: { blockId: { type: "string" as const } },
      required: ["blockId"] as const,
    },
    run: async (input: { blockId: string }) => {
      try {
        const moved = await ctx.runMutation(internal.masterSchedule.aideRemoveBlock, {
          callerUserId,
          blockId: input.blockId as Id<"scheduleBlocks">,
        });
        emit({ toolComplete: { name: "remove_schedule_block", result: `Removed (${moved} class(es) now have no day)` } });
        return JSON.stringify({ ok: true, classesWithoutADay: moved });
      } catch (e) {
        emitCaughtError("remove_schedule_block", e);
        return `Could not remove the block: ${errMsg(e)}`;
      }
    },
  });

  const placeClassTool = betaTool({
    name: "place_class",
    description:
      "Add a class CELL to the schedule, or give work to a class on a day. Pass BOTH weekday + blockId to drop a recurring cell on a day, or pass date (YYYY-MM-DD) + blockId to place it only in that school-local week. Pass NEITHER day/date nor blockId to leave a CLASS not yet scheduled (no day yet). A class is pure structure: a subject label + optional teacher (shown as an avatar). Bare classes (PE, Art, a field-trip block) need no work. With an activityId, nothing is added to the grid: the activity is GIVEN to the group's class that meets in that block on `date` (required, with blockId and the teacher's `finish`); it shows up when that class starts, and the grid draws it in that class. For several activities or days, use give_class_days instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        termId: { type: "string" as const, description: "The term's id (from list_terms)." },
        groupId: { type: "string" as const, description: "Which scholar group (from get_master_schedule)." },
        subject: { type: "string" as const, description: "Label, e.g. 'Math Workshop', 'Field trip'." },
        weekday: { type: "number" as const, description: WEEKDAY_DESC },
        date: { type: "string" as const, description: "Optional school-local date (YYYY-MM-DD). Overrides weekday and makes the cell week-specific." },
        blockId: { type: "string" as const, description: "Which block/row (from get_master_schedule). Omit with weekday to leave it not yet scheduled." },
        teacherId: { type: "string" as const, description: "Optional teacher (from get_master_schedule.teachers)." },
        activityId: { type: "string" as const, description: "Optional: a unit activity to give to the class that meets here on `date` (needs date, blockId and finish)." },
        externalAppId: { type: "string" as const, description: APP_TARGET_DESC },
        finish: { type: "string" as const, enum: ["inClass", "endOfThatDay"] as const, description: "Required with an activityId — the teacher's answer to \"when should they finish it?\", never a guess. 'inClass' = it leaves their screens when the class ends; 'endOfThatDay' = homework for that class due at the end of that day, staying on their list (late after) until they finish. Omit when the teacher didn't say; the tool tells you to ask." },
        note: { type: "string" as const, description: "Optional free note (good for a class with no day yet)." },
      },
      required: ["termId", "groupId", "subject"] as const,
    },
    run: async (input: {
      termId: string;
      groupId: string;
      subject: string;
      weekday?: number;
      date?: string;
      blockId?: string;
      teacherId?: string;
      activityId?: string;
      externalAppId?: string;
      finish?: "inClass" | "endOfThatDay";
      note?: string;
    }) => {
      if (input.activityId && input.externalAppId) {
        return validationError(
          "place_class",
          "A class cell takes an app or work, not both. Place the app, and give the activity separately.",
        );
      }
      if (input.activityId && !input.finish) {
        return CELL_FINISH_QUESTION;
      }
      const parsedDate = input.date ? parseSchoolDate(input.date, await termTimeZone({ periodId: input.termId })) : null;
      if (parsedDate && "error" in parsedDate) {
        return validationError("place_class", parsedDate.error);
      }
      if (input.activityId) {
        // Work is a give to the class meeting that day (TRA-582).
        if (!input.date || !input.blockId) {
          return validationError(
            "place_class",
            "NOT GIVEN — work goes to a class on a specific day. Pass date (YYYY-MM-DD) and the blockId the class meets in.",
          );
        }
        try {
          const given = await ctx.runMutation(internal.gridGiveActions.aideGiveToClass, {
            callerUserId,
            periodId: input.termId as Id<"reportingPeriods">,
            groupId: input.groupId as Id<"scholarGroups">,
            blockId: input.blockId as Id<"scheduleBlocks">,
            dayKey: input.date,
            activityId: input.activityId as Id<"activities">,
            finish: input.finish === "endOfThatDay" ? "endOfDay" : "inClass",
          });
          emit({ toolComplete: { name: "place_class", result: `Gave it to ${input.subject} on ${input.date}` } });
          return JSON.stringify({ ok: true, given: true, assignmentId: given.assignmentId });
        } catch (e) {
          emitCaughtError("place_class", e);
          return `Could not give it to the class: ${errMsg(e)}`;
        }
      }
      try {
        const placementId = await ctx.runMutation(internal.masterSchedule.aidePlaceClass, {
          callerUserId,
          periodId: input.termId as Id<"reportingPeriods">,
          groupId: input.groupId as Id<"scholarGroups">,
          subject: input.subject,
          weekday: parsedDate?.weekday ?? input.weekday,
          blockId: input.blockId ? (input.blockId as Id<"scheduleBlocks">) : undefined,
          teacherId: input.teacherId ? (input.teacherId as Id<"users">) : undefined,
          externalAppId: input.externalAppId
            ? (input.externalAppId as Id<"externalApps">)
            : undefined,
          note: input.note,
          weekStartMs: parsedDate?.weekStartMs,
        });
        const where =
          (parsedDate || input.weekday) && input.blockId
            ? "placed"
            : "no day yet";
        emit({ toolComplete: { name: "place_class", result: `Added "${input.subject}" (${where})` } });
        return JSON.stringify({
          ok: true,
          placementId,
          noDayYet: !((parsedDate || input.weekday) && input.blockId),
        });
      } catch (e) {
        emitCaughtError("place_class", e);
        return `Could not place the class: ${errMsg(e)}`;
      }
    },
  });

  const moveClassTool = betaTool({
    name: "move_class",
    description:
      "Move an existing class cell to a new (weekday, block) — the drag-drop primitive. Pass BOTH weekday + blockId to drop it there, or toShelf:true to take a CLASS off its day (not yet scheduled); a cell carrying work can't lose its day. For a DATED cell, pass date (YYYY-MM-DD) + blockId to also retarget which week it lives in (recurring cells ignore the week part). Identify by placementId (from get_master_schedule).",
    inputSchema: {
      type: "object" as const,
      properties: {
        placementId: { type: "string" as const },
        weekday: { type: "number" as const, description: WEEKDAY_DESC },
        date: { type: "string" as const, description: "Optional school-local date (YYYY-MM-DD). Overrides weekday; for a dated cell also moves it to that week." },
        blockId: { type: "string" as const, description: "Target block/row id." },
        toShelf: { type: "boolean" as const, description: "Take a class off its day instead (omit weekday/blockId). Refused for a cell carrying work." },
      },
      required: ["placementId"] as const,
    },
    run: async (input: { placementId: string; weekday?: number; date?: string; blockId?: string; toShelf?: boolean }) => {
      const toShelf = input.toShelf === true;
      const parsedDate = !toShelf && input.date ? parseSchoolDate(input.date, await termTimeZone({ placementId: input.placementId })) : null;
      if (parsedDate && "error" in parsedDate) {
        return validationError("move_class", parsedDate.error);
      }
      if (!toShelf && (parsedDate ?? input.weekday) == null) {
        return validationError(
          "move_class",
          "Give both weekday (or date) AND blockId to place it, or toShelf:true to take a class off its day.",
        );
      }
      if (!toShelf && !input.blockId) {
        return validationError(
          "move_class",
          "Give both weekday (or date) AND blockId to place it, or toShelf:true to take a class off its day.",
        );
      }
      try {
        await ctx.runMutation(internal.masterSchedule.aideMovePlacement, {
          callerUserId,
          placementId: input.placementId as Id<"schedulePlacements">,
          weekday: toShelf ? null : (parsedDate?.weekday ?? (input.weekday as number)),
          blockId: toShelf ? null : (input.blockId as Id<"scheduleBlocks">),
          weekStartMs: toShelf ? undefined : parsedDate?.weekStartMs,
        });
        emit({ toolComplete: { name: "move_class", result: toShelf ? "Took the class off its day" : "Moved" } });
        return JSON.stringify({ ok: true });
      } catch (e) {
        emitCaughtError("move_class", e);
        return `Could not move the class: ${errMsg(e)}`;
      }
    },
  });

  const shiftClassTool = betaTool({
    name: "shift_class",
    description:
      "Teleport a placed class by ±N calendar days. Dated cells move across weeks; recurring cells only change weekday, so ±7 is a same-weekday no-op. Weekend destinations roll to the nearest school day in the direction of travel (Fri +1 → next Monday). A shelved class can't shift (nothing to shift from). Identify by placementId. Great for 'bump Wednesday's science to Friday' (deltaDays 2).",
    inputSchema: {
      type: "object" as const,
      properties: {
        placementId: { type: "string" as const },
        deltaDays: { type: "number" as const, description: "Calendar-day delta (+/-); weekends roll in the direction of travel." },
      },
      required: ["placementId", "deltaDays"] as const,
    },
    run: async (input: { placementId: string; deltaDays: number }) => {
      try {
        const res = await ctx.runMutation(internal.masterSchedule.aideShiftPlacement, {
          callerUserId,
          placementId: input.placementId as Id<"schedulePlacements">,
          deltaDays: input.deltaDays,
        });
        if (!res.ok) {
          return validationError(
            "shift_class",
            "That class has no day yet: place it on a day first, then shift it.",
          );
        }
        emit({ toolComplete: { name: "shift_class", result: `Shifted to weekday ${res.weekday}` } });
        return JSON.stringify(res);
      } catch (e) {
        emitCaughtError("shift_class", e);
        return `Could not shift the class: ${errMsg(e)}`;
      }
    },
  });

  const updateClassTool = betaTool({
    name: "update_class",
    description:
      "Edit ONE class cell in place: rename its subject, change its teacher (teacherId), clear its teacher (unassignTeacher:true → leaves the slot unstaffed so the coverage rail flags it), attach or detach a catalog app (externalAppId / detachApp:true), set mode, or edit its note. Identify by placementId. To move it use move_class/shift_class instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        placementId: { type: "string" as const },
        subject: { type: "string" as const },
        teacherId: { type: "string" as const, description: "New teacher id (from get_master_schedule.teachers)." },
        unassignTeacher: { type: "boolean" as const, description: "Clear the teacher (leave unstaffed)." },
        externalAppId: { type: "string" as const, description: APP_TARGET_DESC },
        detachApp: { type: "boolean" as const, description: "Remove this cell's catalog app, ending the block-scoped grant." },
        mode: {
          type: "string" as const,
          enum: ["classFocus", "homework"] as const,
          description: "How work given in this cell finishes. classFocus = done in that class; homework = due on a later day. These are storage names: to the teacher say \"in class\" or \"due later\", never \"class focus\".",
        },
        note: { type: "string" as const },
      },
      required: ["placementId"] as const,
    },
    run: async (input: {
      placementId: string;
      subject?: string;
      teacherId?: string;
      unassignTeacher?: boolean;
      externalAppId?: string;
      detachApp?: boolean;
      mode?: "classFocus" | "homework";
      note?: string;
    }) => {
      const teacherId = input.unassignTeacher
        ? null
        : input.teacherId
          ? (input.teacherId as Id<"users">)
          : undefined;
      if (input.detachApp && input.externalAppId) {
        return validationError(
          "update_class",
          "Pass externalAppId to attach an app or detachApp to remove one, not both.",
        );
      }
      const externalAppId = input.detachApp
        ? null
        : input.externalAppId
          ? (input.externalAppId as Id<"externalApps">)
          : undefined;
      try {
        await ctx.runMutation(internal.masterSchedule.aideUpdatePlacement, {
          callerUserId,
          placementId: input.placementId as Id<"schedulePlacements">,
          subject: input.subject,
          teacherId,
          externalAppId,
          mode: input.mode,
          note: input.note,
        });
        emit({ toolComplete: { name: "update_class", result: "Updated class" } });
        return JSON.stringify({ ok: true });
      } catch (e) {
        emitCaughtError("update_class", e);
        return `Could not update the class: ${errMsg(e)}`;
      }
    },
  });

  const removeClassTool = betaTool({
    name: "remove_class",
    description:
      "Delete a class cell from the schedule (permanent — unlike sending it to Not-yet-scheduled). Identify by placementId. Confirm with the teacher first.",
    inputSchema: {
      type: "object" as const,
      properties: { placementId: { type: "string" as const } },
      required: ["placementId"] as const,
    },
    run: async (input: { placementId: string }) => {
      try {
        const removed = await ctx.runMutation(internal.masterSchedule.aideRemovePlacement, {
          callerUserId,
          placementId: input.placementId as Id<"schedulePlacements">,
        });
        emit({ toolComplete: { name: "remove_class", result: removed ? "Removed" : "Nothing to remove" } });
        return JSON.stringify({ ok: true, removed });
      } catch (e) {
        emitCaughtError("remove_class", e);
        return `Could not remove the class: ${errMsg(e)}`;
      }
    },
  });

  const reassignTeacherTool = betaTool({
    name: "reassign_teacher",
    description:
      "The 'Lehua is out sick' primitive: in ONE call, move every class taught by one teacher to another teacher (or to nobody). Narrow with weekday and/or groupId to scope it ('cover Lehua's Monday Geckos blocks'); omit them to reassign her whole week. Pass toTeacherId to name a substitute, or unassign:true to leave the slots unstaffed (the coverage rail will flag the holes for you to fill). Get the teacher ids from get_master_schedule. Confirm the substitute with the teacher first, and report how many cells moved.",
    inputSchema: {
      type: "object" as const,
      properties: {
        termId: { type: "string" as const, description: "The term's id (from list_terms)." },
        fromTeacherId: { type: "string" as const, description: "The teacher who's out (from get_master_schedule)." },
        toTeacherId: { type: "string" as const, description: "The substitute. Omit + unassign:true to leave unstaffed." },
        unassign: { type: "boolean" as const, description: "Leave the slots unstaffed instead of naming a sub." },
        weekday: { type: "number" as const, description: `Optional scope: ${WEEKDAY_DESC}` },
        groupId: { type: "string" as const, description: "Optional scope: only this scholar group." },
      },
      required: ["termId", "fromTeacherId"] as const,
    },
    run: async (input: {
      termId: string;
      fromTeacherId: string;
      toTeacherId?: string;
      unassign?: boolean;
      weekday?: number;
      groupId?: string;
    }) => {
      if (!input.unassign && !input.toTeacherId) {
        return validationError(
          "reassign_teacher",
          "Name a substitute (toTeacherId) or pass unassign:true to leave the slots unstaffed.",
        );
      }
      try {
        const res = await ctx.runMutation(internal.masterSchedule.aideReassignTeacher, {
          callerUserId,
          periodId: input.termId as Id<"reportingPeriods">,
          fromTeacherId: input.fromTeacherId as Id<"users">,
          toTeacherId: input.unassign ? null : (input.toTeacherId as Id<"users">),
          weekday: input.weekday,
          groupId: input.groupId ? (input.groupId as Id<"scholarGroups">) : undefined,
        });
        emit({ toolComplete: { name: "reassign_teacher", result: `Reassigned ${res.count} class(es)` } });
        return JSON.stringify(res);
      } catch (e) {
        emitCaughtError("reassign_teacher", e);
        return `Could not reassign: ${errMsg(e)}`;
      }
    },
  });

  const markClassActivityDoneTool = betaTool({
    name: "mark_class_activity_done",
    description:
      "Record that a class or some scholars did an activity offline, or that homework is done. A teacher confirming homework is complete includes one-scholar ad-hoc offline or web homework; that assignment's roster is just the one scholar, so homework sent as several one-scholar copies takes one call per copy (the end-of-day past-due question links each scholar's name to their copy's assignment; read the activityId off that assignment with get_assignment). When answering an end-of-day past-due homework question, ALWAYS pass scholarIds for exactly the scholars the teacher confirmed, resolved by name from get_assignment's roster: a cohort assignment's roster can include scholars outside that channel, and omitting scholarIds marks all of them. Marks the activity complete for the assignment's roster (idempotent per scholar), so badges, digests, and due-counts update. Pass scholarIds to mark only a subset (e.g. exclude absentees); omit it to mark the whole roster. Posts ONE class-level Slack message, not one per scholar. This writes the learning record only; it changes nothing on the schedule.",
    inputSchema: {
      type: "object" as const,
      properties: {
        assignmentId: { type: "string" as const, description: "The cohort × unit assignment (from get_master_schedule chip / the run page)." },
        activityId: { type: "string" as const, description: "The activity that happened." },
        scholarIds: { type: "array" as const, items: { type: "string" as const }, description: "Optional subset to mark (defaults to the whole roster; use to exclude absentees)." },
      },
      required: ["assignmentId", "activityId"] as const,
    },
    run: async (input: { assignmentId: string; activityId: string; scholarIds?: string[] }) => {
      try {
        const res = await ctx.runMutation(internal.activityCompletions.aideMarkCompleteForGroup, {
          callerUserId,
          assignmentId: input.assignmentId as Id<"assignments">,
          activityId: input.activityId as Id<"activities">,
          scholarIds: input.scholarIds
            ? (input.scholarIds as Id<"users">[])
            : undefined,
        });
        emit({
          toolComplete: {
            name: "mark_class_activity_done",
            result: `Marked complete for ${res.marked} scholar(s)`,
          },
        });
        return JSON.stringify({ ok: true, ...res });
      } catch (e) {
        emitCaughtError("mark_class_activity_done", e);
        return `Could not mark the activity done for the class: ${errMsg(e)}`;
      }
    },
  });

  const dismissFlagTool = betaTool({
    name: "dismiss_flag",
    description:
      "Dismiss an 'overloaded slot' warning the teacher has decided is fine (e.g. a block deliberately runs two things). Pass the flag's id and the placement ids it covers (both from get_master_schedule.overloaded). This only silences the warning; it does not move anything.",
    inputSchema: {
      type: "object" as const,
      properties: {
        placementIds: { type: "array" as const, items: { type: "string" as const }, description: "The cells the flag covers (from get_master_schedule.overloaded[].placementIds)." },
        flagId: { type: "string" as const, description: "The flag's id (from get_master_schedule.overloaded[].flagId)." },
      },
      required: ["placementIds", "flagId"] as const,
    },
    run: async (input: { placementIds: string[]; flagId: string }) => {
      try {
        const n = await ctx.runMutation(internal.masterSchedule.aideDismissFlag, {
          callerUserId,
          placementIds: input.placementIds as Id<"schedulePlacements">[],
          flagId: input.flagId,
        });
        emit({ toolComplete: { name: "dismiss_flag", result: `Dismissed (${n} cells)` } });
        return JSON.stringify({ ok: true, count: n });
      } catch (e) {
        emitCaughtError("dismiss_flag", e);
        return `Could not dismiss the flag: ${errMsg(e)}`;
      }
    },
  });

  return [
    listTermsTool,
    getScheduleTool,
    createBlockTool,
    updateBlockTool,
    removeBlockTool,
    placeClassTool,
    moveClassTool,
    shiftClassTool,
    updateClassTool,
    removeClassTool,
    reassignTeacherTool,
    markClassActivityDoneTool,
    dismissFlagTool,
  ];
}
