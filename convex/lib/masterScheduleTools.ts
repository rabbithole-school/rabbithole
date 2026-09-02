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
// internal.masterSchedule.aide* fn with the caller's real id; those re-check the
// caller is a teacher/admin (they have no ctx.user).
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
  DEFAULT_TIMEZONE,
} from "../../shared/institutionDay";
import { scheduleWeekStartMs } from "../../shared/scheduleWeek";
import { isTeacherRole, type Role } from "./roles";
import type { AideEmit } from "./aideStream";
import { matchScholarByName } from "./scholarReadTools";

const WEEKDAY_DESC =
  "Weekday 1–5 (1 = Monday … 5 = Friday). The master schedule is a recurring Mon–Fri week.";

function parseSchoolDate(date: string):
  | { weekday: number; weekStartMs: number }
  | { error: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { error: `Invalid date "${date}". Use YYYY-MM-DD.` };
  }
  const noonMs = Date.parse(`${date}T12:00:00-10:00`);
  if (
    !Number.isFinite(noonMs) ||
    dayKeyForTimezone(noonMs, DEFAULT_TIMEZONE) !== date
  ) {
    return { error: `Invalid date "${date}". Use YYYY-MM-DD.` };
  }
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (weekday === 0 || weekday === 6) {
    return { error: `${date} is a weekend. Choose a Monday–Friday school date.` };
  }
  return { weekday, weekStartMs: scheduleWeekStartMs(noonMs) };
}

export async function makeMasterScheduleTools(
  ctx: ActionCtx,
  emit: AideEmit,
  opts: {
    role: Role | null | undefined;
    callerUserId: Id<"users">;
    allowedScholarIds?: Set<Id<"users">>;
    scholarLensResolved?: boolean;
  },
) {
  // Same audience as the assignment-scheduling tools: the grid shows teacher
  // and scholar-group names, so teacher/admin only.
  if (!isTeacherRole(opts.role)) return [];
  const { callerUserId } = opts;

  // Name resolution must use the same institution lens as the aide's scholar
  // reads. Callers with an explicit lens pass it through; MCP and other callers
  // without one resolve the caller's home lens here. Only a platform admin's
  // unrestricted "all" lens remains unfiltered.
  const configuredScholarIds = opts.allowedScholarIds;

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
      "Read a term's whole master schedule (weekly timetable) in one shot: the bell-schedule BLOCKS (rows, with times + kind + staffing need), every placed CLASS cell (group × weekday × block, with subject + teacher + any linked assignment/activity), the NOT-YET-SCHEDULED lane (classes not yet dropped onto a day), the derived staffing COVERAGE rail (how many adults each slot has vs needs), any double-booking CONFLICTS, and the term's TEACHERS + GROUPS with their ids. ALWAYS call this before moving anything — the ids it returns (blockId, placementId, teacherId, groupId) are what every write tool takes. This is how you 'see' the grid.",
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
          result: `${grid.placements.length} classes, ${grid.shelf.length} on shelf, ${grid.conflicts.length} conflict(s)`,
        },
      });
      const withWeeks = <T extends { weekStartMs: number | null }>(placement: T) =>
        placement.weekStartMs == null
          ? placement
          : {
              ...placement,
              week: dayKeyForTimezone(
                placement.weekStartMs,
                DEFAULT_TIMEZONE,
              ),
            };
      const currentWeek = scheduleWeekStartMs(Date.now());
      return JSON.stringify({
        ...grid,
        header: {
          today: dayKeyForTimezone(Date.now(), DEFAULT_TIMEZONE),
          currentWeekStart: dayKeyForTimezone(
            currentWeek,
            DEFAULT_TIMEZONE,
          ),
        },
        placements: grid.placements.map(withWeeks),
        shelf: grid.shelf.map(withWeeks),
      });
    },
  });

  const createBlockTool = betaTool({
    name: "create_schedule_block",
    description:
      "Add a bell-schedule BLOCK (a timetable row) to a term — e.g. 'Block A' 08:30–09:40, or 'Lunch' 11:30–12:15. Blocks default SHARED across every group in the term; pass groupId only for a per-group override row. `kind` recess/lunch default to needing 2 adults for the coverage rail. Times are school-local 'HH:MM'.",
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
      "Edit a bell-schedule block's label, times, weekdays, staffing need, or kind. Identify it by blockId (from get_master_schedule). Only the fields you pass change.",
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
      "Delete a bell-schedule block. Any classes on it are NOT deleted — they move to the SHELF so nothing is silently lost. Identify by blockId (from get_master_schedule). Confirm with the teacher first.",
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
        emit({ toolComplete: { name: "remove_schedule_block", result: `Removed (${moved} class(es) → shelf)` } });
        return JSON.stringify({ ok: true, movedToShelf: moved });
      } catch (e) {
        emitCaughtError("remove_schedule_block", e);
        return `Could not remove the block: ${errMsg(e)}`;
      }
    },
  });

  const placeClassTool = betaTool({
    name: "place_class",
    description:
      "Add a class CELL to the schedule. Pass BOTH weekday + blockId to drop a recurring cell on a day, or pass date (YYYY-MM-DD) + blockId to place it only in that school-local week. Pass NEITHER day/date nor blockId to leave it NOT YET SCHEDULED (no day yet — 'sometime week 4'). A class is pure structure by default: a subject label + optional teacher (shown as an avatar). Linking an assignmentId + activityId makes it live scholar-facing: the activity is auto-planned into the assignment's schedule and goes live on its own at the block's time (no separate publish step). Bare classes (PE, Art, a field-trip block) are fine with no linked content.",
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
        assignmentId: { type: "string" as const, description: "Optional: link a live assignment (cohort × unit)." },
        activityId: { type: "string" as const, description: "Optional: which activity of that assignment to materialize." },
        mode: { type: "string" as const, enum: ["classFocus", "homework"] as const },
        note: { type: "string" as const, description: "Optional free note (good for not-yet-scheduled items)." },
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
      assignmentId?: string;
      activityId?: string;
      mode?: "classFocus" | "homework";
      note?: string;
    }) => {
      const parsedDate = input.date ? parseSchoolDate(input.date) : null;
      if (parsedDate && "error" in parsedDate) {
        return validationError("place_class", parsedDate.error);
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
          assignmentId: input.assignmentId ? (input.assignmentId as Id<"assignments">) : undefined,
          activityId: input.activityId ? (input.activityId as Id<"activities">) : undefined,
          mode: input.mode,
          note: input.note,
          weekStartMs: parsedDate?.weekStartMs,
        });
        const where =
          (parsedDate || input.weekday) && input.blockId
            ? "placed"
            : "on the shelf";
        emit({ toolComplete: { name: "place_class", result: `Added "${input.subject}" (${where})` } });
        return JSON.stringify({
          ok: true,
          placementId,
          shelved: !((parsedDate || input.weekday) && input.blockId),
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
      "Move an existing class cell to a new (weekday, block) — the drag-drop primitive. Pass BOTH weekday + blockId to drop it there, or toShelf:true to send it back to Not-yet-scheduled. For a DATED cell, pass date (YYYY-MM-DD) + blockId to also retarget which week it lives in (recurring cells ignore the week part). Identify by placementId (from get_master_schedule).",
    inputSchema: {
      type: "object" as const,
      properties: {
        placementId: { type: "string" as const },
        weekday: { type: "number" as const, description: WEEKDAY_DESC },
        date: { type: "string" as const, description: "Optional school-local date (YYYY-MM-DD). Overrides weekday; for a dated cell also moves it to that week." },
        blockId: { type: "string" as const, description: "Target block/row id." },
        toShelf: { type: "boolean" as const, description: "Send it back to Not-yet-scheduled instead (omit weekday/blockId)." },
      },
      required: ["placementId"] as const,
    },
    run: async (input: { placementId: string; weekday?: number; date?: string; blockId?: string; toShelf?: boolean }) => {
      const toShelf = input.toShelf === true;
      const parsedDate = !toShelf && input.date ? parseSchoolDate(input.date) : null;
      if (parsedDate && "error" in parsedDate) {
        return validationError("move_class", parsedDate.error);
      }
      if (!toShelf && (parsedDate ?? input.weekday) == null) {
        return validationError(
          "move_class",
          "Give both weekday (or date) AND blockId to place it, or toShelf:true to shelf it.",
        );
      }
      if (!toShelf && !input.blockId) {
        return validationError(
          "move_class",
          "Give both weekday (or date) AND blockId to place it, or toShelf:true to shelf it.",
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
        emit({ toolComplete: { name: "move_class", result: toShelf ? "Moved to shelf" : "Moved" } });
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
            "That class is on the shelf — place it on a day first, then shift it.",
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
      "Edit ONE class cell in place: rename its subject, change its teacher (teacherId), clear its teacher (unassignTeacher:true → leaves the slot unstaffed so the coverage rail flags it), set mode, or edit its note. Identify by placementId. To move it use move_class/shift_class instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        placementId: { type: "string" as const },
        subject: { type: "string" as const },
        teacherId: { type: "string" as const, description: "New teacher id (from get_master_schedule.teachers)." },
        unassignTeacher: { type: "boolean" as const, description: "Clear the teacher (leave unstaffed)." },
        mode: { type: "string" as const, enum: ["classFocus", "homework"] as const },
        note: { type: "string" as const },
      },
      required: ["placementId"] as const,
    },
    run: async (input: {
      placementId: string;
      subject?: string;
      teacherId?: string;
      unassignTeacher?: boolean;
      mode?: "classFocus" | "homework";
      note?: string;
    }) => {
      const teacherId = input.unassignTeacher
        ? null
        : input.teacherId
          ? (input.teacherId as Id<"users">)
          : undefined;
      try {
        await ctx.runMutation(internal.masterSchedule.aideUpdatePlacement, {
          callerUserId,
          placementId: input.placementId as Id<"schedulePlacements">,
          subject: input.subject,
          teacherId,
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

  const dispatchActivityTool = betaTool({
    name: "dispatch_activity",
    description:
      "Give ONE scholar ad-hoc work, identified by scholarName (preferred) or scholarId. Creates a one-scholar assignment and, by default, makes it LIVE immediately; pass live:false to queue it for later, or mode:'homework' + dueAt for take-home work. activityKind:'online' creates a Socratic tutor chat. For offline homework, pass activityKind:'offline' AND mode:'homework'; description is REQUIRED and must contain the teacher's complete scholar-facing instructions and pasted reading verbatim. Never invent or summarize missing source material. activityKind:'web' assigns a specific HTTPS URL — use the SAME kind for a video or a reading; Rabbithole's existing web-assignment surface embeds it on iPad and opens it on desktop, so do NOT invent a reading type. activityKind:'problem_set' creates targeted adaptive practice; first call list_practice_nodes for the relevant domain, choose the ONE serveable node that exactly matches the teacher's topic, and pass its nodeKey as the sole targetSkillKeys entry. Never infer a skill key from prose. For online work, give a clear systemPrompt that keeps the tutor Socratic.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scholarName: {
          type: "string" as const,
          description:
            "The target scholar's name. Matched strictly: exact wins; ambiguous partial names are refused. Provide this OR scholarId.",
        },
        scholarId: {
          type: "string" as const,
          description:
            "The target scholar's user id, when already known. Provide this OR scholarName.",
        },
        title: { type: "string" as const, description: "Short title, e.g. 'Copenhagen taxation exploration'." },
        activityKind: {
          type: "string" as const,
          enum: ["online", "offline", "web", "problem_set"] as const,
          description:
            "online = tutor chat; offline = scholar-facing instructions/reading in description (required; also pass mode:'homework' for take-home work); web = a video or reading URL; problem_set = targeted adaptive practice. Defaults to online.",
        },
        systemPrompt: { type: "string" as const, description: "Optional tutor system prompt for the activity (defaults to a Socratic exploration prompt)." },
        description: { type: "string" as const, description: "Required for offline: complete scholar-facing instructions and any pasted reading, preserved verbatim. Optional short scholar-facing context for other kinds." },
        webUrl: {
          type: "string" as const,
          description: "Required for activityKind:'web'. The specific HTTPS video or reading URL to open.",
        },
        targetSkillKeys: {
          type: "array" as const,
          items: { type: "string" as const },
          description:
            "Required for activityKind:'problem_set'. Exactly one nodeKey chosen from list_practice_nodes.",
        },
        itemCount: {
          type: "number" as const,
          description: "problem_set only: number of items, 1–30 (default 10).",
        },
        mode: { type: "string" as const, enum: ["classFocus", "homework"] as const, description: "classFocus (in-the-moment focus) or homework. Default classFocus." },
        live: { type: "boolean" as const, description: "true (default) = live NOW; false = plan it for startsAt (add to queue)." },
        startsAt: { type: "number" as const, description: "Epoch ms — planned start when live:false." },
        dueAt: { type: "number" as const, description: "Epoch ms — due time for mode:'homework'." },
      },
      required: ["title"] as const,
    },
    run: async (input: {
      scholarName?: string;
      scholarId?: string;
      title: string;
      activityKind?: "online" | "offline" | "web" | "problem_set";
      systemPrompt?: string;
      description?: string;
      webUrl?: string;
      targetSkillKeys?: string[];
      itemCount?: number;
      mode?: "classFocus" | "homework";
      live?: boolean;
      startsAt?: number;
      dueAt?: number;
    }) => {
      const hasName = input.scholarName?.trim();
      const hasId = input.scholarId?.trim();
      if (hasName && hasId) {
        return validationError(
          "dispatch_activity",
          "Provide scholarName OR scholarId, not both; no activity was dispatched.",
        );
      }
      if (!hasName && !hasId) {
        return validationError(
          "dispatch_activity",
          "Provide scholarName or scholarId; no activity was dispatched.",
        );
      }

      let scholarId = hasId as string | undefined;
      let scholarName = hasName;
      if (!scholarId) {
        let allowedScholarIds = configuredScholarIds;
        if (
          allowedScholarIds === undefined &&
          opts.scholarLensResolved !== true
        ) {
          const lens = await ctx.runQuery(
            internal.curriculumAssistant.resolveAideScholarLens,
            { callerUserId, scope: "" },
          );
          if (!lens.unrestricted) {
            allowedScholarIds = new Set<Id<"users">>(lens.scholarIds ?? []);
          }
        }
        // Naming a scholar IS the Extended Education opt-in — an explicitly
        // named program guest must still resolve here.
        const { scholars } = await ctx.runQuery(
          internal.curriculumAssistant.listScholarsInternal,
          { includeProgramGuests: true },
        );
        const visibleScholars =
          allowedScholarIds === undefined
            ? scholars
            : scholars.filter((scholar) =>
                allowedScholarIds.has(scholar.id as Id<"users">),
              );
        const match = matchScholarByName(hasName!, visibleScholars);
        if (match.kind === "ambiguous") {
          return validationError(
            "dispatch_activity",
            `Ambiguous scholar "${hasName}" matches ${match.candidates.map((candidate) => candidate.name).join(", ")}. Use the exact name; no activity was dispatched.`,
          );
        }
        if (match.kind === "none") {
          return validationError(
            "dispatch_activity",
            `No scholar matched "${hasName}". Check the name; no activity was dispatched.`,
          );
        }
        scholarId = match.scholar.id;
        scholarName = match.scholar.name;
      }

      try {
        const res = await ctx.runMutation(internal.assignments.aideDispatchActivity, {
          callerUserId,
          scholarId: scholarId as Id<"users">,
          title: input.title,
          activityKind: input.activityKind,
          systemPrompt: input.systemPrompt,
          description: input.description,
          webUrl: input.webUrl,
          targetSkillKeys: input.targetSkillKeys,
          itemCount: input.itemCount,
          mode: input.mode,
          live: input.live,
          startsAt: input.startsAt,
          dueAt: input.dueAt,
        });
        emit({
          toolComplete: {
            name: "dispatch_activity",
            result: `Dispatched "${input.title}" to ${scholarName ?? "the scholar"} ${input.live === false ? "(queued)" : "(live now)"}`,
          },
        });
        return JSON.stringify({
          ok: true,
          activityKind: input.activityKind ?? "online",
          scholarId,
          scholarName: scholarName ?? null,
          ...res,
        });
      } catch (e) {
        emitCaughtError("dispatch_activity", e);
        return `Could not dispatch the activity: ${errMsg(e)}`;
      }
    },
  });

  const cascadeUnitTool = betaTool({
    name: "cascade_unit",
    description:
      "Flow a whole UNIT onto a CLASS's weekly meetings in one call — the 'put the chatbots unit into Humanities' primitive. Writes one visible, draggable class cell per activity (in the unit's order), ONE PER CLASS MEETING, chronologically from the clicked slot, skipping no-school days — all tagged as one sequence so you can move (move_sequence) or push them back (reflow_unit) together. Pass anchorPlacementId = the clicked class slot (from get_master_schedule): its class supplies the subject + the weekly meeting pattern (e.g. Mon/Wed/Fri), so the chips carry the CLASS name, not the unit title. With no anchor the picked slot is treated as the class's only weekly meeting (one chip per week). Flowing (one per meeting) is the default; pass layout:'sameDay' to instead stack the WHOLE unit onto the single chosen day/block (the 'assign it all on one day' choice) — every activity lands in that one slot. Without startDate the cascade starts in the CURRENT week; if the teacher wants a future week, pass startDate (YYYY-MM-DD school-local) for the first cell, which overrides startWeekday. Needs the assignment (cohort × unit) for the unit's activities. Everything auto-goes-live at its block time (no publish step). If the layout isn't right, the teacher can drag a cell or ask you to move/reflow the sequence.",
    inputSchema: {
      type: "object" as const,
      properties: {
        termId: { type: "string" as const, description: "The term's id (from list_terms)." },
        groupId: { type: "string" as const, description: "Which scholar group (from get_master_schedule)." },
        assignmentId: { type: "string" as const, description: "The cohort × unit assignment whose unit to lay out." },
        startWeekday: { type: "number" as const, description: WEEKDAY_DESC },
        startDate: { type: "string" as const, description: "Optional school-local date (YYYY-MM-DD) for the first cell. Required for a future week; overrides startWeekday." },
        startBlockId: { type: "string" as const, description: "The block/row to start in (from get_master_schedule)." },
        anchorPlacementId: { type: "string" as const, description: "The clicked class slot (a recurring class cell from get_master_schedule). Supplies the class subject + weekly meeting pattern. Omit to treat the start slot as a single weekly meeting." },
        layout: { type: "string" as const, enum: ["flow", "sameDay"] as const, description: "How the unit's activities lay out: 'flow' (default) = one per class meeting across days; 'sameDay' = every activity stacked on the single chosen day/block." },
        teacherId: { type: "string" as const, description: "Optional teacher for every cell (defaults to the assignment's teacher)." },
        mode: { type: "string" as const, enum: ["classFocus", "homework"] as const, description: "Default classFocus." },
      },
      required: ["termId", "groupId", "assignmentId", "startWeekday", "startBlockId"] as const,
    },
    run: async (input: {
      termId: string;
      groupId: string;
      assignmentId: string;
      startWeekday: number;
      startDate?: string;
      startBlockId: string;
      anchorPlacementId?: string;
      layout?: "flow" | "sameDay";
      teacherId?: string;
      mode?: "classFocus" | "homework";
    }) => {
      const parsedDate = input.startDate
        ? parseSchoolDate(input.startDate)
        : null;
      if (parsedDate && "error" in parsedDate) {
        return validationError("cascade_unit", parsedDate.error);
      }
      try {
        const res = await ctx.runMutation(internal.masterSchedule.aideCascadeUnit, {
          callerUserId,
          periodId: input.termId as Id<"reportingPeriods">,
          groupId: input.groupId as Id<"scholarGroups">,
          assignmentId: input.assignmentId as Id<"assignments">,
          startWeekday: parsedDate?.weekday ?? input.startWeekday,
          startBlockId: input.startBlockId as Id<"scheduleBlocks">,
          anchorPlacementId: input.anchorPlacementId
            ? (input.anchorPlacementId as Id<"schedulePlacements">)
            : undefined,
          layout: input.layout,
          teacherId: input.teacherId ? (input.teacherId as Id<"users">) : undefined,
          weekStartMs: parsedDate?.weekStartMs,
          mode: input.mode,
        });
        emit({
          toolComplete: {
            name: "cascade_unit",
            result:
              res.strategy === "sameDay"
                ? `Placed ${res.placementIds.length} activities all on one day`
                : `Flowed ${res.placementIds.length} activities onto the class's meetings`,
          },
        });
        return JSON.stringify(res);
      } catch (e) {
        emitCaughtError("cascade_unit", e);
        return `Could not cascade the unit: ${errMsg(e)}`;
      }
    },
  });

  const reflowUnitTool = betaTool({
    name: "reflow_unit",
    description:
      "Push the rest of a unit sequence back one meeting — the 'we didn't get to this activity, slide the rest' primitive (the [No — push the rest] answer to 'did this happen?'). Re-runs the class-meeting layout over the tail (every chip at sequenceIndex ≥ fromIndex) anchored at the next meeting, updating the SAME cells in place (drags, dismissed flags, and the live layer all reconcile). The whole projection shifts one meeting later; the end date updates. Identify the sequence by sequenceId and the missed activity's 0-based sequenceIndex (both from get_master_schedule). Repeat to push another meeting. Use mark_class_activity_done instead when the activity actually DID happen offline.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sequenceId: { type: "string" as const, description: "The unit sequence's id (from get_master_schedule)." },
        fromIndex: { type: "number" as const, description: "0-based sequenceIndex of the MISSED activity; it and everything after slide one meeting later." },
      },
      required: ["sequenceId", "fromIndex"] as const,
    },
    run: async (input: { sequenceId: string; fromIndex: number }) => {
      try {
        const res = await ctx.runMutation(internal.masterSchedule.aideReflowSequence, {
          callerUserId,
          sequenceId: input.sequenceId,
          fromIndex: input.fromIndex,
        });
        emit({
          toolComplete: {
            name: "reflow_unit",
            result: `Pushed ${res.count} activity slot(s) back a meeting (${res.merged} merged)`,
          },
        });
        return JSON.stringify(res);
      } catch (e) {
        emitCaughtError("reflow_unit", e);
        return `Could not reflow the sequence: ${errMsg(e)}`;
      }
    },
  });

  const markClassActivityDoneTool = betaTool({
    name: "mark_class_activity_done",
    description:
      "Record that a class DID an activity (typically offline) — the [Yes — mark as done] answer to 'did this activity happen?'. Also use it when a teacher confirms one-scholar ad-hoc offline homework is complete; that assignment's roster is just the one scholar. Marks the activity complete for the assignment's roster (idempotent per scholar), so badges, digests, and due-counts update. Pass scholarIds to mark only a subset (e.g. exclude absentees); omit it to mark the whole roster. Posts ONE class-level Slack message, not one per scholar. This writes the learning record only — it does NOT move any cell (use reflow_unit for that).",
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

  const moveSequenceTool = betaTool({
    name: "move_sequence",
    description:
      "Bulk-move every cell of a unit sequence at once — the 'push the rest of this unit back a week' primitive. Pass deltaWeeks (±) to shift the whole sequence across weeks. deltaDays wraps within Mon–Fri and cannot cross weeks; use deltaWeeks to move across weeks. Identify the sequence by sequenceId (every cascaded cell carries one; read it from get_master_schedule). Returns the handled cell ids and merge count so you can report collisions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sequenceId: { type: "string" as const, description: "The sequence id shared by the unit's cells (from get_master_schedule)." },
        deltaWeeks: { type: "number" as const, description: "Shift every cell by ±N weeks." },
        deltaDays: { type: "number" as const, description: "Shift every cell by ±N weekdays (wraps within Mon–Fri)." },
      },
      required: ["sequenceId"] as const,
    },
    run: async (input: { sequenceId: string; deltaWeeks?: number; deltaDays?: number }) => {
      if (!input.deltaWeeks && !input.deltaDays) {
        return validationError(
          "move_sequence",
          "Pass a deltaWeeks and/or deltaDays to move the sequence.",
        );
      }
      try {
        const res = await ctx.runMutation(internal.masterSchedule.aideMoveSequence, {
          callerUserId,
          sequenceId: input.sequenceId,
          deltaWeeks: input.deltaWeeks,
          deltaDays: input.deltaDays,
        });
        emit({
          toolComplete: {
            name: "move_sequence",
            result: `Moved ${res.count} cell(s) (${res.merged} merged)`,
          },
        });
        return JSON.stringify(res);
      } catch (e) {
        emitCaughtError("move_sequence", e);
        return `Could not move the sequence: ${errMsg(e)}`;
      }
    },
  });

  const acceptReorderTool = betaTool({
    name: "accept_reorder",
    description:
      "Silence a unit's 'out of order' flag by accepting its current order as intentional (the teacher called an audible — e.g. did activity 3 before activity 2 because of weather). Marks every cell in the sequence as an accepted reorder so the flag stops re-raising. Identify by sequenceId. Use this when the teacher confirms the new order is deliberate; use move_sequence instead if they actually want to shuffle the cells.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sequenceId: { type: "string" as const, description: "The out-of-order sequence's id (from get_master_schedule.outOfOrder)." },
      },
      required: ["sequenceId"] as const,
    },
    run: async (input: { sequenceId: string }) => {
      try {
        const n = await ctx.runMutation(internal.masterSchedule.aideAcceptReorder, {
          callerUserId,
          sequenceId: input.sequenceId,
        });
        emit({ toolComplete: { name: "accept_reorder", result: `Accepted reorder (${n} cells)` } });
        return JSON.stringify({ ok: true, count: n });
      } catch (e) {
        emitCaughtError("accept_reorder", e);
        return `Could not accept the reorder: ${errMsg(e)}`;
      }
    },
  });

  const dismissFlagTool = betaTool({
    name: "dismiss_flag",
    description:
      "Dismiss an 'overloaded slot' warning the teacher has decided is fine (e.g. a block deliberately runs two things). Pass the flag's id and the placement ids it covers (both from get_master_schedule.overloaded). This only silences the warning; it does not move anything. For an out-of-order flag, use accept_reorder instead.",
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

  const placeHomeworkTool = betaTool({
    name: "place_homework",
    description:
      "Put homework on a day's DUE RAIL (the top-of-day strip, not a bell block) — 'this is due Wednesday'. Homework is a scholar obligation with a due day, not room time, so it lives in a virtual homework row above the timetable. Pass dueWeekday for the day it's due, or omit it to leave the homework not yet scheduled while the due day is undecided. Link an assignment+activity to make it real scholar-visible work; omit them for a bare placeholder.",
    inputSchema: {
      type: "object" as const,
      properties: {
        termId: { type: "string" as const, description: "The term's id (from list_terms)." },
        groupId: { type: "string" as const, description: "Which scholar group (from get_master_schedule)." },
        subject: { type: "string" as const, description: "Label, e.g. 'Fractions problem set'." },
        dueWeekday: { type: "number" as const, description: `Due day: ${WEEKDAY_DESC} Omit to leave it not yet scheduled.` },
        assignmentId: { type: "string" as const, description: "Optional: link a live assignment." },
        activityId: { type: "string" as const, description: "Optional: which activity to materialize as homework." },
        teacherId: { type: "string" as const, description: "Optional owning teacher." },
        note: { type: "string" as const, description: "Optional free note." },
      },
      required: ["termId", "groupId", "subject"] as const,
    },
    run: async (input: {
      termId: string;
      groupId: string;
      subject: string;
      dueWeekday?: number;
      assignmentId?: string;
      activityId?: string;
      teacherId?: string;
      note?: string;
    }) => {
      try {
        const placementId = await ctx.runMutation(internal.masterSchedule.aidePlaceHomework, {
          callerUserId,
          periodId: input.termId as Id<"reportingPeriods">,
          groupId: input.groupId as Id<"scholarGroups">,
          subject: input.subject,
          teacherId: input.teacherId ? (input.teacherId as Id<"users">) : undefined,
          assignmentId: input.assignmentId ? (input.assignmentId as Id<"assignments">) : undefined,
          activityId: input.activityId ? (input.activityId as Id<"activities">) : undefined,
          dueWeekday: input.dueWeekday,
          note: input.note,
        });
        emit({
          toolComplete: {
            name: "place_homework",
            result: input.dueWeekday ? `Homework due weekday ${input.dueWeekday}` : "Homework on shelf",
          },
        });
        return JSON.stringify({ ok: true, placementId });
      } catch (e) {
        emitCaughtError("place_homework", e);
        return `Could not place the homework: ${errMsg(e)}`;
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
    dispatchActivityTool,
    cascadeUnitTool,
    reflowUnitTool,
    markClassActivityDoneTool,
    moveSequenceTool,
    acceptReorderTool,
    dismissFlagTool,
    placeHomeworkTool,
  ];
}
