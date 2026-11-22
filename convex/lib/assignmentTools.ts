// Bot DRY Layer 5 — the shared *assignment-scheduling* tool group.
//
// Assigning a unit, reading a cohort's progress, and pushing/scheduling an
// activity are the same fourteen operations wherever a teacher asks for them.
// They used to live inline in assembleCurriculumTools (lib/aideTools.ts), so
// only the GLOBAL Curriculum Assistant (plus Slack + MCP, which compose it)
// could run a unit — a teacher standing on a unit page and asking its
// Curriculum Bot to "assign this unit to the Geckos" got a truthful refusal,
// because that surface's toolset had no assignment tools at all.
//
// This module is the one implementation, spread into BOTH assemblers:
// lib/aideTools.ts (global scope) and lib/unitDesignerTools.ts (unit scope).
// The gate is unchanged — `isTeacherRole`, so a curriculum_designer still
// gets nothing here — and the tool definitions moved verbatim, so the global
// aide's toolset is byte-identical to before the extraction.
//
// `currentUnit` is the only unit-scope addition: when the surface already has
// a unit open, `give` and publish_unit state its id so "this unit" resolves
// without a list_units round-trip.
//
// Runtime note: like its siblings, this dynamically imports `betaTool` and
// does NO static `@anthropic-ai/sdk` import (keeps node:* out of the edge
// bundle).

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { isTeacherRole, type Role } from "./roles";
import { matchScholarByName } from "./scholarReadTools";
import { makeUnitResolver } from "./aideResolvers";
import { youtubeVideoId } from "../../shared/activityResourceEmbed";
import {
  withBase,
  unitPath,
  assignmentPath,
  sessionPath,
  schoolTimeLabel,
} from "./channels";
import type { AideEmit } from "./aideStream";
import type { GiveChoices, GiveFinish } from "./giveWindow";
import { openUntilClosesAt, openUntilDayKey } from "../../shared/openUntil";
import type { StoredGiveEntry } from "../assignments";
import { MISSING_FINISH_QUESTION } from "./giveQuestions";
import { dayKeyForTimezone, shiftDayKey } from "../../shared/institutionDay";
import { nonSchoolDayNote } from "../../shared/schoolClosures";
import { makeClassPlanTools, type ClassPlanConfirmScope } from "./classPlanTools";

export type AssignmentCohortInput = {
  groupName?: string;
  scholarNames?: string[];
};

export type AssignmentCohortResolution =
  | {
      ok: true;
      ids: Id<"users">[];
      audienceLabel: string;
    }
  | { ok: false; message: string };

async function resolveAssignmentScholars(
  ctx: ActionCtx,
  names: string[],
  allowedScholarIds?: ReadonlySet<Id<"users">>,
): Promise<{
  ids: Id<"users">[];
  resolvedNames: string[];
  unresolved: string[];
  ambiguous: { name: string; candidates: string[] }[];
}> {
  const { scholars } = await ctx.runQuery(
    internal.curriculumAssistant.listScholarsInternal,
    {
      includeProgramGuests: true,
      ...(allowedScholarIds
        ? { allowedScholarIds: [...allowedScholarIds] }
        : {}),
    },
  );
  const ids: Id<"users">[] = [];
  const resolvedNames: string[] = [];
  const unresolved: string[] = [];
  const ambiguous: { name: string; candidates: string[] }[] = [];
  for (const name of names) {
    const match = matchScholarByName(name, scholars);
    if (match.kind === "match") {
      ids.push(match.scholar.id as Id<"users">);
      resolvedNames.push(match.scholar.name);
    } else if (match.kind === "ambiguous") {
      ambiguous.push({
        name,
        candidates: match.candidates.map((candidate) => candidate.name),
      });
    } else {
      unresolved.push(name);
    }
  }
  return { ids, resolvedNames, unresolved, ambiguous };
}

async function resolveAssignmentGroup(
  ctx: ActionCtx,
  groupName: string,
  allowedScholarIds?: ReadonlySet<Id<"users">>,
) {
  const groups = await ctx.runQuery(
    internal.curriculumAssistant.listScholarGroupsInternal,
    {
      includeProgramGuests: true,
      ...(allowedScholarIds
        ? { allowedScholarIds: [...allowedScholarIds] }
        : {}),
    },
  );
  return matchScholarByName(groupName, groups);
}

/** The shared strict groupName-XOR-scholarNames resolver for assignment tools. */
export function makeAssignmentCohortResolver(
  ctx: ActionCtx,
  allowedScholarIds?: ReadonlySet<Id<"users">>,
  opts: {
    // false for a curriculum:run holder: a group lookup would reveal group
    // names and membership she has no read of. She names scholars instead.
    allowGroups?: boolean;
  } = {},
) {
  const allowGroups = opts.allowGroups ?? true;
  return async (
    input: AssignmentCohortInput,
  ): Promise<AssignmentCohortResolution> => {
    const hasGroup = input.groupName != null && input.groupName.trim() !== "";
    const hasNames =
      Array.isArray(input.scholarNames) && input.scholarNames.length > 0;
    if (hasGroup && hasNames) {
      return {
        ok: false,
        message: "Provide groupName OR scholarNames, not both.",
      };
    }
    if (!hasGroup && !hasNames) {
      return {
        ok: false,
        message:
          "Provide either a groupName (scholar group) or scholarNames (individual scholars).",
      };
    }
    if (hasGroup && !allowGroups) {
      return {
        ok: false,
        message:
          "Scholar groups aren't available to you here. Name the scholars instead (scholarNames). No assignment created.",
      };
    }
    if (hasGroup) {
      const match = await resolveAssignmentGroup(
        ctx,
        input.groupName!,
        allowedScholarIds,
      );
      if (match.kind === "ambiguous") {
        return {
          ok: false,
          message: `Ambiguous group name "${input.groupName}" matches ${match.candidates
            .map((candidate) => candidate.name)
            .join(", ")}. No assignment created — use the exact group name.`,
        };
      }
      if (match.kind === "none") {
        return {
          ok: false,
          message: `No scholar group found matching "${input.groupName}". Call list_scholar_groups to see available groups.`,
        };
      }
      const group = match.scholar;
      if (group.members.length === 0) {
        return {
          ok: false,
          message: `Scholar group "${group.name}" exists but has no members. Add scholars to the group first.`,
        };
      }
      return {
        ok: true,
        ids: group.members.map((member) => member.id as Id<"users">),
        audienceLabel: group.name,
      };
    }
    const { ids, resolvedNames, unresolved, ambiguous } =
      await resolveAssignmentScholars(
        ctx,
        input.scholarNames!,
        allowedScholarIds,
      );
    if (ambiguous.length > 0) {
      const detail = ambiguous
        .map(
          (match) =>
            `"${match.name}" matches ${match.candidates.join(", ")}`,
        )
        .join("; ");
      return {
        ok: false,
        message: `Ambiguous scholar name(s): ${detail}. No assignment created — use a full name to disambiguate.`,
      };
    }
    if (unresolved.length > 0) {
      return {
        ok: false,
        message: `Could not resolve these scholar names: ${unresolved.join(", ")}. No assignment created.`,
      };
    }
    if (ids.length === 0) {
      return {
        ok: false,
        message: "No scholars given — refusing to create an empty cohort.",
      };
    }
    return { ok: true, ids, audienceLabel: resolvedNames.join(", ") };
  };
}

export type AssignActivityNowExecution =
  | {
      status: "given";
      assignmentId: Id<"assignments">;
      created: boolean;
    }
  | { status: "assign_failed"; error: string };

// ── The two questions every give asks (TRA-571) ────────────────────────
//
// "When does it show up?" and "When should they finish it?". A give tool never
// fills either answer in for the teacher: a missing answer comes back as the
// question to ask, with the concrete choices read from the group's bell
// schedule (convex/lib/giveWindow.ts maps the answers onto stored fields).

export const FINISH_DESCRIPTION =
  "When they should finish it — the teacher's answer, never a guess. 'inClass': it leaves their screens when the bell block it shows up in ends (or at the end of that school day when there's no block). A date 'YYYY-MM-DD' (\"due Saturday\", \"by Saturday\"): it stays on their list until they finish and shows as late after that day. 'openUntil:YYYY-MM-DD' (\"open until Saturday\", \"available until Saturday\"): it's available until the end of that day, then leaves their list whether or not they finished, and is never late; the day must be after the day it shows up. 'endOfUnit': due on the last day already scheduled in this assignment. For an app or a link only, 'forAWhile:<minutes>' (1 to 90, \"for 20 minutes\"): it leaves their screens that many minutes from now. When the teacher's words could mean either a due date or open-until (\"keep it live until Saturday\", \"until Wednesday\"), don't pick one: ask ONE question, e.g. \"Due Saturday (it stays on their list and goes late), or open until Saturday (then it disappears)?\" Omit it when the teacher didn't say; the tool then tells you what to ask.";

export const THIS_WEEK_FINISH_DESCRIPTION =
  "'thisWeek' (\"due this week\", \"this week's homework\"): due at the end of the last school day of the week it shows up in, with the school's closures (a holiday Friday makes it Thursday). Use it instead of guessing Friday's date.";

export const NEXT_WEEK_HOMEWORK_DESCRIPTION =
  "true when the teacher says \"next week's homework\" (\"assign it for next week's homework\"). It answers both questions from the school calendar: it shows up at the start of next school week's first school day and is due at the end of that week's last school day (a holiday Friday makes it Thursday). It is filed under its class: the group's class in the unit's subject, or, when the unit has no subject or none matches, the teacher's own class for that group; when more than one could be it, the tool asks which. Next week is the school week after this one; on a weekend this week is already the coming one, so next week is the week after it. Don't also pass startsNow, startsAtMs or finish. Tell the teacher both days, and the class, from the result. For a different week, use startsAtMs and finish instead.";

/** Parse the `finish` tool input. Undefined = not answered yet. */
export function parseFinishInput(
  raw: string | undefined,
): GiveFinish | undefined | { error: string } {
  const value = raw?.trim();
  if (!value) return undefined;
  if (value === "inClass") return { kind: "inClass" };
  if (value === "endOfUnit") return { kind: "endOfUnit" };
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { kind: "by", dayKey: value };
  const openUntil = /^openUntil:\s*(\d{4}-\d{2}-\d{2})$/.exec(value);
  if (openUntil) return { kind: "openUntil", dayKey: openUntil[1] };
  return {
    error: `finish "${value}" isn't one of 'inClass', 'endOfUnit', a date 'YYYY-MM-DD', 'openUntil:YYYY-MM-DD', or (for an app or a link only) 'forAWhile:<minutes>'. Nothing was given.`,
  };
}

/** "Tomorrow" → "tomorrow", "This week (Thu, Nov 12)" → "this week (Thu,
 *  Nov 12)"; a date ("Mon, Nov 16") keeps its capital. */
function lowerFirst(label: string): string {
  return /^(Today|Tomorrow|This week|Next week)\b/.test(label)
    ? label[0].toLowerCase() + label.slice(1)
    : label;
}

/** "Mon, Nov 23", never relative. */
function weekOfLabel(mondayKey: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${mondayKey}T12:00:00.000Z`));
}

type PushFinishInput = GiveFinish | { kind: "forAWhile"; minutes: number };

/** "For a while" ('forAWhile:<minutes>'), the finish only an app or a link
 *  takes; undefined for any other answer. */
function forAWhileInput(
  raw: string | undefined,
): { kind: "forAWhile"; minutes: number } | undefined {
  const match = /^forAWhile:\s*(\d+)$/.exec(raw?.trim() ?? "");
  return match ? { kind: "forAWhile", minutes: Number(match[1]) } : undefined;
}

function dayLabel(dayKey: string, todayKey: string): string {
  if (dayKey === todayKey) return "today";
  if (dayKey === shiftDayKey(todayKey, 1)) return "tomorrow";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${dayKey}T12:00:00.000Z`));
}

function clockTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(ms));
}

function inClassChoice(choices: GiveChoices): string {
  const at = clockTime(choices.inClass.endsAt, choices.timeZone);
  return choices.inClass.blockLabel
    ? `In that class (leaves their screens at ${at} when ${choices.inClass.blockLabel} ends)`
    : `In that class (no bell block then, so it leaves their screens at the end of that day)`;
}

/** The give choices for the aide's question and summary. A read that fails
 *  (for example, not the caller's assignment) returns null, and the write
 *  that follows reports the real refusal. */
export async function readGiveChoices(
  ctx: ActionCtx,
  args: {
    callerUserId: Id<"users">;
    assignmentId?: Id<"assignments">;
    unitId?: Id<"units">;
    scholarIds?: Id<"users">[];
    activityId?: Id<"activities">;
    startsAt?: number;
  },
): Promise<GiveChoices | null> {
  try {
    return await ctx.runQuery(internal.assignments.aideGiveChoices, args);
  } catch {
    return null;
  }
}

/** The tool result when the teacher hasn't said when it should be finished. */
export function finishQuestion(choices: GiveChoices | null): string {
  const options = choices
    ? [
        `${inClassChoice(choices)} → finish:'inClass'`,
        ...choices.dueDays.map(
          (day) =>
            `By ${lowerFirst(day.label)} → finish:'${day.dayKey}'`,
        ),
        ...(choices.endOfUnit
          ? [
              `By the end of the unit (${dayLabel(choices.endOfUnit.dayKey, choices.todayDayKey)}) → finish:'endOfUnit'`,
            ]
          : []),
        "Another date → finish:'YYYY-MM-DD'",
        "Open until a date (available until the end of that day, then it leaves their list; never late) → finish:'openUntil:YYYY-MM-DD'",
      ]
    : [
        "In that class → finish:'inClass'",
        "By a date → finish:'YYYY-MM-DD'",
        "Open until a date → finish:'openUntil:YYYY-MM-DD'",
      ];
  return `NOT GIVEN — nothing changed. The teacher hasn't said when they should finish it. Don't guess, and don't assume it is only for that class. Ask the teacher only that question (confirm anything they already told you, like when it shows up), offering these choices: ${options.join(" · ")}. Then call this tool again with finish. Put the choices to the teacher in these words; never ask \"homework or class focus\" (those are storage names, not words teachers use).`;
}

/** The tool result when the teacher hasn't said when it shows up. `nowArg`
 *  and `startArg` are THIS tool's own argument spellings (`give` and
 *  make_app_a_coached_activity both take startsNow:true / startsAtMs). */
export function startQuestion(
  choices: GiveChoices | null,
  nowArg: string,
  startArg = "startsAtMs",
): string {
  const current = choices?.currentBlock
    ? ` (in ${choices.currentBlock.subject}, which ends at ${clockTime(choices.currentBlock.endsAt, choices.timeZone)})`
    : "";
  const blocks = (choices?.blocks ?? []).slice(0, 8).map((block) => {
    const day = dayLabel(block.dayKey, choices!.todayDayKey);
    return `${day[0].toUpperCase()}${day.slice(1)} · ${block.subject} (${clockTime(block.startsAt, choices!.timeZone)}) → ${startArg}:${block.startsAt}`;
  });
  return `NOT GIVEN — nothing changed. The teacher hasn't said when it should show up. Don't guess. Ask the teacher only that question, offering: Now${current} → ${nowArg}${blocks.length ? ` · ${blocks.join(" · ")}` : ""} · Another time → ${startArg}.`;
}

/**
 * One line about what was actually STORED (not what was asked: giving more
 * time keeps a live focus's end and the later due date). Includes the one
 * consequence that changed: dated work stays on the list and shows as late.
 */
export function storedWindowSummary(
  stored: StoredGiveEntry | null,
  choices: GiveChoices | null,
): string {
  if (!stored || !choices) return "";
  const closesAt = openUntilClosesAt(stored, choices.timeZone);
  if (closesAt != null) {
    return openUntilSummary(openUntilDayKey(closesAt, choices.timeZone), choices);
  }
  if (stored.mode === "classFocus") {
    if (stored.endsAt == null) return "";
    const at = clockTime(stored.endsAt, choices.timeZone);
    return choices.inClass.blockLabel &&
      stored.endsAt === choices.inClass.endsAt
      ? `Leaves their screens at ${at}, when ${choices.inClass.blockLabel} ends.`
      : `Leaves their screens at ${at}.`;
  }
  if (stored.dueAt == null) return "";
  const dayKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: choices.timeZone,
  }).format(new Date(stored.dueAt));
  return dueSummary(dayKey, choices);
}

/**
 * The due-day line, plus a note when that day isn't a school day (a weekend
 * or a closure). The note is a fact for the teacher: the give still happened.
 */
function dueSummary(dayKey: string, choices: GiveChoices): string {
  const due = `Due ${dayLabel(dayKey, choices.todayDayKey)} (end of day). It stays on their list until they finish, so anyone not done by then sees it as late instead of having it disappear.`;
  const note = dueDayNote(dayKey, choices);
  return note ? `${due} ${note}` : due;
}

/**
 * The open-until line: what happens when the window closes, plus the same
 * non-school-day note a due date gets.
 */
function openUntilSummary(dayKey: string, choices: GiveChoices): string {
  const day = dayLabel(dayKey, choices.todayDayKey);
  const line = `Open until ${day} (end of day), then it disappears from their list whether or not they finished; it's never marked late. After ${day}, the Run page shows who didn't finish.`;
  const note = dueDayNote(dayKey, choices);
  return note ? `${line} ${note}` : line;
}

function dueDayNote(dayKey: string, choices: GiveChoices): string | null {
  const note = nonSchoolDayNote(dayKey, choices.closures);
  return note ? `Note: ${note} Tell the teacher in case they meant a school day.` : null;
}

/**
 * For a give tool that doesn't otherwise summarize the window: the note when
 * a "by" date isn't a school day, or, for open-until, what happens when it
 * closes. Null otherwise. Reads the choices only for a date.
 */
export async function finishDateNote(
  ctx: ActionCtx,
  finish: GiveFinish,
  args: Parameters<typeof readGiveChoices>[1],
): Promise<string | null> {
  if (finish.kind !== "by" && finish.kind !== "openUntil") return null;
  const choices = await readGiveChoices(ctx, args);
  if (!choices) return null;
  return finish.kind === "openUntil"
    ? openUntilSummary(finish.dayKey, choices)
    : dueDayNote(finish.dayKey, choices);
}

/**
 * One line for the teacher about the window that was stored, including the
 * one consequence that changed: work with a finish date stays on the list and
 * shows as late, it no longer disappears.
 */
export function windowSummary(
  finish: GiveFinish,
  choices: GiveChoices | null,
): string {
  if (!choices) return "";
  if (finish.kind === "openUntil") return openUntilSummary(finish.dayKey, choices);
  if (finish.kind === "inClass") {
    const at = clockTime(choices.inClass.endsAt, choices.timeZone);
    return choices.inClass.blockLabel
      ? `Leaves their screens at ${at}, when ${choices.inClass.blockLabel} ends.`
      : "No bell block then, so it leaves their screens at the end of that school day.";
  }
  const dayKey =
    finish.kind === "by" ? finish.dayKey : choices.endOfUnit?.dayKey;
  if (!dayKey) return "";
  return dueSummary(dayKey, choices);
}

/** The `give` tool's input (TRA-573): what, to whom, when it shows up, and
 *  when they should finish it. See the tool description for the routes. */
export type GiveInput = {
  assignmentId?: string;
  activityId?: string;
  unitId?: string;
  unitTitle?: string;
  lessonTitle?: string;
  activityTitle?: string;
  newActivity?: {
    title?: string;
    activityKind?: "online" | "offline" | "web" | "problem_set";
    systemPrompt?: string;
    description?: string;
    webUrl?: string;
    targetSkillKeys?: string[];
    itemCount?: number;
  };
  groupName?: string;
  scholarNames?: string[];
  scholarId?: string;
  title?: string;
  appName?: string;
  url?: string;
  media?: "video" | "page";
  note?: string;
  startsNow?: boolean;
  startsAtMs?: number;
  finish?: string;
  /** "Next week's homework" (TRA-581): answers both questions at once. */
  nextWeekHomework?: boolean;
  /** With nextWeekHomework: the teacher's answer to "which class?". */
  homeworkClass?: string;
};

// ── Deploy skew: the five folded give verbs (one release) ───────────────
//
// An MCP client lists tools once and may call a name it listed before the
// fold into `give`. These names are NOT listed anywhere; a dispatcher that
// can't find a tool by name maps an old call onto `give` here, so it gets
// the same two questions and can never bypass them. The in-app aide and the
// Slack bot send the tool list with every turn, so a model there can only
// call listed names. The HTTP connector routes an old name here too
// (app/api/mcp/toolRoute.ts). Compatibility for long-lived MCP clients;
// remove after 2026-12-01.

export { LEGACY_GIVE_TOOL_NAMES } from "../../shared/legacyGiveToolNames";

const asString = (v: unknown) => (typeof v === "string" ? v : undefined);
const asNumber = (v: unknown) => (typeof v === "number" ? v : undefined);
const asStrings = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

/** The `give` input an old give tool's call stands for, or null. */
export function legacyGiveInput(
  name: string,
  raw: unknown,
): GiveInput | null {
  const input = (raw ?? {}) as Record<string, unknown>;
  const finish = asString(input.finish);
  switch (name) {
    case "assign_unit":
      return {
        unitId: asString(input.unitId),
        unitTitle: asString(input.unitTitle),
        groupName: asString(input.groupName),
        scholarNames: asStrings(input.scholarNames),
        title: asString(input.title),
        activityTitle: asString(input.activityTitle),
        startsNow: input.startsNow === true ? true : undefined,
        startsAtMs: asNumber(input.startsAtMs),
        finish,
      };
    case "assign_activity_now":
      return {
        unitTitle: asString(input.unitTitle),
        activityTitle: asString(input.activityTitle),
        groupName: asString(input.groupName),
        scholarNames: asStrings(input.scholarNames),
        startsNow: true,
        finish,
      };
    case "push_activity_now":
      return {
        assignmentId: asString(input.assignmentId),
        activityId: asString(input.activityId),
        scholarNames: asStrings(input.scholarNames),
        startsNow: true,
        finish,
      };
    case "schedule_activity":
      return {
        assignmentId: asString(input.assignmentId),
        activityId: asString(input.activityId),
        startsAtMs: asNumber(input.startsAtMs),
        finish,
      };
    case "dispatch_activity": {
      const scholarName = asString(input.scholarName);
      return {
        scholarNames: scholarName ? [scholarName] : undefined,
        scholarId: asString(input.scholarId),
        newActivity: {
          title: asString(input.title),
          activityKind: asString(input.activityKind) as
            | "online"
            | "offline"
            | "web"
            | "problem_set"
            | undefined,
          systemPrompt: asString(input.systemPrompt),
          description: asString(input.description),
          webUrl: asString(input.webUrl),
          targetSkillKeys: asStrings(input.targetSkillKeys),
          itemCount: asNumber(input.itemCount),
        },
        startsNow: input.live === true ? true : undefined,
        startsAtMs: input.live === false ? asNumber(input.startsAt) : undefined,
        finish,
      };
    }
    default:
      return null;
  }
}

/**
 * Find a tool by name, or, for one of the folded give verbs, the `give` tool
 * with the old call's input mapped onto it. `null` when neither exists for
 * this caller (the dispatcher's own "Forbidden").
 */
export function resolveToolWithLegacyGive<T extends { name: string }>(
  tools: ReadonlyArray<T>,
  name: string,
  input: unknown,
): { tool: T; input: unknown } | null {
  const tool = tools.find((t) => t.name === name);
  if (tool) return { tool, input };
  const give = tools.find((t) => t.name === "give");
  const mapped = give ? legacyGiveInput(name, input) : null;
  return give && mapped ? { tool: give, input: mapped } : null;
}

/** When it shows up: now, or a later time (undefined = not answered yet). */
type GiveWhen = { now: boolean; startsAt: number | undefined };

/** Compose the canonical assignment creation/reuse and immediate live push. */
export async function assignAndGiveActivity(
  ctx: ActionCtx,
  args: {
    callerUserId: Id<"users">;
    unitId: Id<"units">;
    activityId: Id<"activities">;
    scholarIds: Id<"users">[];
    startsAt: number;
    finish: GiveFinish;
  },
): Promise<AssignActivityNowExecution> {
  // ONE write: an answered give goes live now (or is planned for later)
  // inside aideAssignWork, so there's no second push that could fail after
  // scholars already have the work.
  try {
    const assignment = await ctx.runMutation(
      internal.assignments.aideAssignWork,
      {
        callerUserId: args.callerUserId,
        unitId: args.unitId,
        scholarIds: args.scholarIds,
        startsAt: args.startsAt,
        target: { kind: "activity", activityId: args.activityId },
        finish: args.finish,
      },
    );
    return { status: "given", ...assignment };
  } catch (error) {
    return {
      status: "assign_failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Build the assignment-scheduling toolset for one aide turn. Returns `[]` for
 * a non-teacher caller (the gate `assembleCurriculumTools` used to apply
 * inline), so callers can spread the result unconditionally — mirrors
 * makeSuggestionTools / makeScholarWriteTools.
 */
export async function makeAssignmentTools(
  ctx: ActionCtx,
  emit: AideEmit,
  opts: {
    role: Role | null | undefined;
    callerUserId: Id<"users">;
    // Where deep links point: "" = relative (in-app UI), siteUrl() =
    // absolute (Slack / external channels). See lib/channels.ts.
    linkBase?: string;
    // The unit this surface is already scoped to (the unit-page Curriculum
    // Bot). When set, the two assign tools name it in their descriptions so
    // "assign this unit" needs no title matching. Null/undefined on the
    // global aide, which has no unit in scope.
    currentUnit?: { id: Id<"units">; title: string } | null;
    allowedScholarIds?: ReadonlySet<Id<"users">>;
    // True when the surface already resolved the scholar lens, so an absent
    // `allowedScholarIds` means an admin's unrestricted lens rather than "no
    // lens supplied". `give` falls back to the caller's home lens otherwise
    // when it names one scholar for a new one-off activity.
    scholarLensResolved?: boolean;
    // The institution lens the caller picked (the in-app aide), so unit
    // titles resolve within the units their Curriculum page shows.
    institutionScope?: string;
    // A non-teacher holding curriculum:run (lib/curriculumRun.ts). She gets the
    // RUNNER subset only — assign a unit she can edit, read and edit the
    // agenda of assignments she owns — and `allowedScholarIds` must be her
    // assignee lens (scholars at her run schools), never a record-read lens.
    curriculumRunner?: boolean;
    // Who is asking, where, and which turn (set by the surface). Only with it
    // do the class-plan write tools exist; see lib/classPlanTools.ts.
    classPlanConfirmScope?: ClassPlanConfirmScope;
  },
) {
  // Reads the roster + edits the agenda, so teacher/admin only — the same
  // gate assembleCurriculumTools applied when these lived inline — plus the
  // curriculum:run subset below. Every backing function re-checks ownership
  // and, for a runner, the unit + same-school boundary.
  const runnerMode =
    !isTeacherRole(opts.role) && opts.curriculumRunner === true;
  if (!isTeacherRole(opts.role) && !runnerMode) return [];

  const {
    callerUserId,
    linkBase = "",
    currentUnit,
    allowedScholarIds,
    institutionScope,
  } = opts;

  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );

  // The caller's school zone for every time label below (Pacific/Honolulu for
  // the primary — byte-identical to the old fixed-HST labels). Resolved on the
  // first tool run that labels a time, never while the toolset is built.
  let timeZonePromise: Promise<string> | null = null;
  const schoolTimeZone = () =>
    (timeZonePromise ??= ctx.runQuery(internal.institutions.staffTimeZone, {
      userId: callerUserId,
    }));

  // Shared strict unit resolver (lib/aideResolvers.ts) — the SAME
  // implementation the curriculum tools use, so "Elements of Culture" resolves
  // identically whichever surface the teacher is standing on.
  const resolveUnitStrict = makeUnitResolver(
    ctx,
    callerUserId,
    institutionScope,
  );

  // When a unit is already in scope, tell each assign tool which identifier its
  // own schema accepts so "this unit" needs no lookup or invalid retry.
  const currentUnitIdHint = currentUnit
    ? ` The unit currently in scope is "${currentUnit.title}" (unitId ${currentUnit.id}); when the teacher says "this unit", pass that unitId.`
    : "";
  const resolveCohort = makeAssignmentCohortResolver(
    ctx,
    allowedScholarIds,
    { allowGroups: !runnerMode },
  );
  const resolveScholars = (names: string[]) =>
    resolveAssignmentScholars(ctx, names, allowedScholarIds);

  // Resolve an activity by title WITHIN a unit (case-insensitive; exact title
  // wins over an ambiguous partial). Walks the unit's lessons and their
  // activities via the existing internal readers.
  const resolveActivityInUnit = async (
    unitId: Id<"units">,
    activityTitle: string,
  ): Promise<
    | { ok: true; activityId: Id<"activities">; title: string }
    | { ok: false; message: string }
  > => {
    const lower = activityTitle.trim().toLowerCase();
    if (!lower) return { ok: false, message: "Provide an activity title." };
    const lessons = await ctx.runQuery(internal.lessons.listByUnitInternal, {
      unitId,
    });
    const matches: { id: Id<"activities">; title: string }[] = [];
    for (const l of lessons) {
      const acts = await ctx.runQuery(
        internal.activities.listByLessonInternal,
        { lessonId: l._id },
      );
      for (const a of acts) {
        if (a.title.toLowerCase().includes(lower)) {
          matches.push({ id: a._id, title: a.title });
        }
      }
    }
    if (matches.length === 0) {
      return {
        ok: false,
        message: `No activity matching "${activityTitle}" found in this unit.`,
      };
    }
    const exact = matches.filter((m) => m.title.toLowerCase() === lower);
    if (exact.length === 1) {
      return { ok: true, activityId: exact[0].id, title: exact[0].title };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        message: `Ambiguous activity "${activityTitle}" matches ${matches
          .map((m) => m.title)
          .join(", ")}. Use the exact title.`,
      };
    }
    return { ok: true, activityId: matches[0].id, title: matches[0].title };
  };

  // ── Assignment scheduling (teacher/admin only) ──────────────────────
  // Lets the aide read and edit the agenda the same way the teacher UI
  // does. An assignment IS a cohort (its scholarIds roster), so there's
  // no scholar arg — picking the assignment picks the scholars. All
  // ownership-gated to the caller in convex/assignments.ts.

  // ── give (TRA-573) ─────────────────────────────────────────────────
  // The one way the aide gives work. It used to be five verbs (assign_unit,
  // assign_activity_now, push_activity_now, schedule_activity,
  // dispatch_activity) that each answered "what, to whom, when it shows up,
  // when they finish" a little differently. `give` takes those answers and
  // routes to the SAME internal writes the five used:
  //   - an activity of an existing assignment, now   → aidePushActivityNow
  //   - an activity of an existing assignment, later → aideScheduleActivity
  //   - a unit / lesson / activity for a named cohort → aideAssignWork
  //   - a new one-off activity for one scholar        → aideDispatchActivity
  //   - an app or a link, now                         → pushes.giveFocusFromAide
  // A missing start or finish returns the question (startQuestion /
  // finishQuestion), exactly as the five did, and writes nothing.

  const filled = (value: string | undefined) =>
    value != null && value.trim() !== "";

  // Resolve a unit by exactly one of unitId (bypasses matching) or unitTitle
  // (strict resolver — refuses ambiguity with the candidates).
  const resolveUnitInput = async (
    input: GiveInput,
  ): Promise<
    | { ok: true; unit: { id: Id<"units">; title: string } }
    | { ok: false; message: string }
  > => {
    const hasUnitId = filled(input.unitId);
    const hasUnitTitle = filled(input.unitTitle);
    if (hasUnitId && hasUnitTitle) {
      return { ok: false, message: "Provide unitId OR unitTitle, not both." };
    }
    if (!hasUnitId && !hasUnitTitle) {
      return {
        ok: false,
        message:
          "Provide either a unitId (preferred, from list_units) or a unitTitle.",
      };
    }
    if (hasUnitId) {
      const details = await ctx.runQuery(
        internal.curriculumAssistant.getUnitDetails,
        { unitId: input.unitId as Id<"units"> },
      );
      if (!details) {
        return {
          ok: false,
          message: `No unit found with id "${input.unitId}". Call list_units to get a valid unitId or title.`,
        };
      }
      return {
        ok: true,
        unit: { id: input.unitId as Id<"units">, title: details.title },
      };
    }
    const r = await resolveUnitStrict(input.unitTitle!);
    return r.ok ? { ok: true, unit: r.unit } : { ok: false, message: r.error };
  };

  // Resolve a lesson by title WITHIN a unit, with the same strict matching as
  // activities: an exact title wins, an ambiguous partial is refused.
  const resolveLessonInUnit = async (
    unitId: Id<"units">,
    lessonTitle: string,
  ): Promise<
    | { ok: true; lessonId: Id<"lessons">; title: string }
    | { ok: false; message: string }
  > => {
    const lower = lessonTitle.trim().toLowerCase();
    const lessons = await ctx.runQuery(internal.lessons.listByUnitInternal, {
      unitId,
    });
    const matches = lessons.filter((l) =>
      l.title.toLowerCase().includes(lower),
    );
    if (matches.length === 0) {
      return {
        ok: false,
        message: `No lesson matching "${lessonTitle}" found in this unit.`,
      };
    }
    const exact = matches.filter((l) => l.title.toLowerCase() === lower);
    const pick =
      exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : null;
    if (!pick) {
      return {
        ok: false,
        message: `Ambiguous lesson "${lessonTitle}" matches ${matches
          .map((l) => l.title)
          .join(", ")}. Use the exact title.`,
      };
    }
    return { ok: true, lessonId: pick._id, title: pick.title };
  };

  // Resolve named scholars on an existing assignment (push's "more time"
  // path), with its refusals.
  const resolveNarrowing = async (
    names: string[],
  ): Promise<
    | { ok: true; ids: Id<"users">[]; names: string[] }
    | { ok: false; message: string }
  > => {
    const { ids, resolvedNames, unresolved, ambiguous } =
      await resolveScholars(names);
    if (ambiguous.length > 0) {
      const detail = ambiguous
        .map((a) => `"${a.name}" matches ${a.candidates.join(", ")}`)
        .join("; ");
      return {
        ok: false,
        message: `Ambiguous scholar name(s): ${detail}. Nothing given — use a full name to disambiguate.`,
      };
    }
    if (unresolved.length > 0) {
      return {
        ok: false,
        message: `Could not resolve these scholar names: ${unresolved.join(", ")}. Nothing given.`,
      };
    }
    if (ids.length === 0) {
      return {
        ok: false,
        message:
          "No scholars given. Omit scholarNames to give it to the whole cohort. Nothing given.",
      };
    }
    return { ok: true, ids, names: resolvedNames };
  };

  // Both answers, or the question for the first missing one. Never a guess.
  const missingAnswer = (
    when: GiveWhen,
    finish: GiveFinish | undefined,
    choices: GiveChoices | null,
  ): string | null => {
    if (!when.now && when.startsAt === undefined) {
      return startQuestion(choices, "startsNow:true");
    }
    if (!finish) return finishQuestion(choices);
    return null;
  };

  const plural = (n: number) => `${n} scholar${n === 1 ? "" : "s"}`;

  // An activity of an EXISTING assignment: its cohort, or named scholars on
  // it (push's "more time for Kai" path).
  const giveOnAssignment = async (
    input: GiveInput,
    when: GiveWhen,
    finish: GiveFinish | undefined,
  ): Promise<string> => {
    if (filled(input.groupName)) {
      return "With assignmentId, the audience is that assignment's cohort, so groupName isn't used. Name scholarNames to give it to only some of them. Nothing given.";
    }
    const assignmentId = input.assignmentId as Id<"assignments">;
    let activityId = input.activityId as Id<"activities"> | undefined;
    if (!filled(input.activityId)) {
      if (!filled(input.activityTitle)) {
        return "Say which activity of the assignment to give: activityId (from get_assignment) or activityTitle. Nothing given.";
      }
      const data = await ctx.runQuery(internal.assignments.aideGetAssignment, {
        callerUserId,
        assignmentId,
      });
      if (!data) {
        return `No assignment found with id "${input.assignmentId}" (or it isn't yours). Nothing given.`;
      }
      const lower = input.activityTitle!.trim().toLowerCase();
      const candidates = data.availableActivities.filter((a) =>
        a.title.toLowerCase().includes(lower),
      );
      const exact = candidates.filter((a) => a.title.toLowerCase() === lower);
      const pick =
        exact.length === 1
          ? exact[0]
          : candidates.length === 1
            ? candidates[0]
            : null;
      if (!pick) {
        return candidates.length === 0
          ? `No activity matching "${input.activityTitle}" in ${data.unitTitle}. Nothing given.`
          : `Ambiguous activity "${input.activityTitle}" matches ${candidates
              .map((a) => a.title)
              .join(", ")}. Use the exact title. Nothing given.`;
      }
      activityId = pick.activityId;
    }
    let scholarIds: Id<"users">[] | undefined;
    let forScholars: string[] | undefined;
    if (input.scholarNames !== undefined && filled(input.scholarId)) {
      return "Provide scholarNames OR scholarId, not both. Nothing given.";
    }
    if (input.scholarNames !== undefined) {
      const narrowed = await resolveNarrowing(input.scholarNames);
      if (!narrowed.ok) return narrowed.message;
      scholarIds = narrowed.ids;
      forScholars = narrowed.names;
    } else if (filled(input.scholarId)) {
      // A scholar id narrows exactly like a name: never the whole cohort.
      // The write checks the scholar is on the roster.
      scholarIds = [input.scholarId!.trim() as Id<"users">];
      forScholars = [input.scholarId!.trim()];
    }
    const choices = await readGiveChoices(ctx, {
      callerUserId,
      assignmentId,
      activityId,
      scholarIds,
      startsAt: when.now ? undefined : when.startsAt,
    });
    if (!when.now && when.startsAt === undefined) {
      return startQuestion(choices, "startsNow:true");
    }

    if (when.now) {
      // "More time" for named scholars may reuse the live entry's finish; the
      // mutation refuses with the question when there's nothing to reuse. A
      // null read (not the caller's assignment) falls through to the write,
      // which reports the real refusal.
      if (!finish && scholarIds === undefined && choices) {
        return finishQuestion(choices);
      }
      let stored: StoredGiveEntry | null;
      try {
        ({ stored } = await ctx.runMutation(
          internal.assignments.aidePushActivityNow,
          {
            callerUserId,
            assignmentId,
            activityId: activityId!,
            finish,
            scholarIds,
          },
        ));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.includes(MISSING_FINISH_QUESTION)) {
          return finishQuestion(choices);
        }
        return `Could not give it: ${message}`;
      }
      const summary = storedWindowSummary(stored, choices);
      emit({ toolComplete: { name: "give", result: `Live now · ${summary}` } });
      return JSON.stringify({
        ok: true,
        live: stored ? stored.setAt != null : true,
        forScholars,
        finish: summary,
      });
    }

    // Later. A planned entry goes to the whole cohort; it can't name a subset.
    if (scholarIds !== undefined) {
      return "Giving it to only some of an assignment's scholars works when it shows up now (startsNow:true). For a later start, give it to the whole cohort, or name the scholars with the unit (unitTitle + activityTitle + scholarNames) for their own assignment. Nothing given.";
    }
    if (!finish) return finishQuestion(choices);
    let stored: StoredGiveEntry | null;
    try {
      ({ stored } = await ctx.runMutation(
        internal.assignments.aideScheduleActivity,
        {
          callerUserId,
          assignmentId,
          activityId: activityId!,
          startsAt: when.startsAt!,
          finish,
        },
      ));
    } catch (e) {
      return `Could not give it: ${e instanceof Error ? e.message : String(e)}`;
    }
    const startsAtLabel = schoolTimeLabel(
      stored?.startsAt ?? when.startsAt!,
      await schoolTimeZone(),
    );
    const summary = storedWindowSummary(stored, choices);
    emit({
      toolComplete: {
        name: "give",
        result: `Shows up ${startsAtLabel}${summary ? ` · ${summary}` : ""}`,
      },
    });
    return JSON.stringify({
      ok: true,
      // What was stored: a start inside the grace window, or a re-timed live
      // entry, is live already.
      live: stored?.setAt != null,
      startsAtLabel,
      finish: summary,
    });
  };

  // A unit, one lesson of it, or one activity of it, for a named cohort. The
  // same write creates (or reuses) the cohort × unit assignment and gives the
  // work, so there's no second write that could fail after scholars have it.
  const giveFromUnit = async (
    input: GiveInput,
    when: GiveWhen,
    finish: GiveFinish | undefined,
  ): Promise<string> => {
    if (filled(input.scholarId)) {
      return "scholarId is only for a new one-off activity. Name the cohort with groupName or scholarNames. Nothing given.";
    }
    if (filled(input.activityTitle) && filled(input.lessonTitle)) {
      return "Provide activityTitle OR lessonTitle, not both (or neither, for the whole unit). Nothing given.";
    }
    const cohort = await resolveCohort(input);
    if (!cohort.ok) return cohort.message;
    const resolved = await resolveUnitInput(input);
    if (!resolved.ok) return resolved.message;
    const unit = resolved.unit;

    let activity: { activityId: Id<"activities">; title: string } | null =
      null;
    let lesson: { lessonId: Id<"lessons">; title: string } | null = null;
    if (filled(input.activityTitle)) {
      const found = await resolveActivityInUnit(unit.id, input.activityTitle!);
      if (!found.ok) return found.message;
      activity = found;
    } else if (filled(input.lessonTitle)) {
      const found = await resolveLessonInUnit(unit.id, input.lessonTitle!);
      if (!found.ok) return found.message;
      lesson = found;
    }

    const choices = await readGiveChoices(ctx, {
      callerUserId,
      unitId: unit.id,
      scholarIds: cohort.ids,
      activityId: activity?.activityId,
      startsAt: when.now ? undefined : when.startsAt,
    });
    const question = missingAnswer(when, finish, choices);
    if (question || !finish) return question ?? finishQuestion(choices);

    let res: { assignmentId: Id<"assignments">; created: boolean; live: boolean };
    try {
      res = await ctx.runMutation(internal.assignments.aideAssignWork, {
        callerUserId,
        unitId: unit.id,
        scholarIds: cohort.ids,
        title: input.title,
        startsAt: when.now ? Date.now() : when.startsAt!,
        target: activity
          ? { kind: "activity", activityId: activity.activityId }
          : lesson
            ? { kind: "lesson", lessonId: lesson.lessonId }
            : { kind: "unit" },
        finish,
      });
    } catch (e) {
      return `Could not give it: ${e instanceof Error ? e.message : String(e)}`;
    }
    const summary = windowSummary(finish, choices);
    const what = activity?.title ?? lesson?.title ?? unit.title;
    emit({
      toolComplete: {
        name: "give",
        result: `${what} ${res.live ? "live" : "planned"} for ${plural(cohort.ids.length)}${summary ? ` · ${summary}` : ""}`,
      },
    });
    return JSON.stringify({
      ok: true,
      live: res.live,
      assignmentId: res.assignmentId,
      created: res.created,
      deduped: !res.created,
      unitTitle: unit.title,
      lessonTitle: lesson?.title,
      activityTitle: activity?.title,
      rosterSize: cohort.ids.length,
      url: withBase(linkBase, assignmentPath(res.assignmentId)),
      startsAtLabel: when.now
        ? undefined
        : schoolTimeLabel(when.startsAt!, await schoolTimeZone()),
      finish: summary,
    });
  };

  // A NEW one-off activity for one scholar (a one-scholar assignment).
  const giveNewActivity = async (
    input: GiveInput,
    when: GiveWhen,
    finish: GiveFinish | undefined,
  ): Promise<string> => {
    if (runnerMode) {
      return "A new one-off activity isn't available to you here. Give an activity from a unit you run instead. Nothing given.";
    }
    const spec = input.newActivity!;
    if (!filled(spec.title)) {
      return "A new activity needs newActivity.title. Nothing given.";
    }
    if (filled(input.groupName)) {
      return "A new one-off activity goes to one scholar at a time. Name one scholar (scholarNames with one name, or scholarId), and call give once per scholar. Nothing given.";
    }
    const names = (input.scholarNames ?? []).filter((n) => n.trim() !== "");
    const hasId = filled(input.scholarId);
    if (names.length > 0 && hasId) {
      return "Provide scholarNames OR scholarId, not both. Nothing given.";
    }
    if (names.length > 1) {
      return "A new one-off activity goes to one scholar at a time. Call give once per scholar. Nothing given.";
    }
    if (names.length === 0 && !hasId) {
      return "Name the scholar (scholarNames with one name, or scholarId). Nothing given.";
    }

    let scholarId = hasId ? (input.scholarId as Id<"users">) : undefined;
    let scholarName: string | undefined = names[0];
    if (!scholarId) {
      // The aide's scholar lens. A surface that resolved it passes the ids
      // (or none, for an admin's explicit all-institutions lens); otherwise
      // fall back to the caller's home lens.
      let lensIds: ReadonlySet<Id<"users">> | undefined = allowedScholarIds;
      if (lensIds === undefined && opts.scholarLensResolved !== true) {
        const lens = await ctx.runQuery(
          internal.curriculumAssistant.resolveAideScholarLens,
          { callerUserId, scope: "" },
        );
        if (!lens.unrestricted) {
          lensIds = new Set<Id<"users">>(lens.scholarIds ?? []);
        }
      }
      // Naming a scholar IS the Extended Education opt-in — an explicitly
      // named program guest must still resolve here.
      const { scholars } = await ctx.runQuery(
        internal.curriculumAssistant.listScholarsInternal,
        { includeProgramGuests: true },
      );
      const visibleScholars =
        lensIds === undefined
          ? scholars
          : scholars.filter((scholar) =>
              lensIds.has(scholar.id as Id<"users">),
            );
      const match = matchScholarByName(names[0], visibleScholars);
      if (match.kind === "ambiguous") {
        return `Ambiguous scholar "${names[0]}" matches ${match.candidates.map((candidate) => candidate.name).join(", ")}. Use the exact name. Nothing given.`;
      }
      if (match.kind === "none") {
        return `No scholar matched "${names[0]}". Check the name. Nothing given.`;
      }
      scholarId = match.scholar.id as Id<"users">;
      scholarName = match.scholar.name;
    }

    const choices = await readGiveChoices(ctx, {
      callerUserId,
      scholarIds: [scholarId],
      startsAt: when.now ? undefined : when.startsAt,
    });
    const question = missingAnswer(when, finish, choices);
    if (question || !finish) return question ?? finishQuestion(choices);

    try {
      const res = await ctx.runMutation(
        internal.assignments.aideDispatchActivity,
        {
          callerUserId,
          scholarId,
          title: spec.title!,
          activityKind: spec.activityKind,
          systemPrompt: spec.systemPrompt,
          description: spec.description,
          webUrl: spec.webUrl,
          targetSkillKeys: spec.targetSkillKeys,
          itemCount: spec.itemCount,
          live: when.now,
          startsAt: when.now ? undefined : when.startsAt,
          finish,
        },
      );
      const summary = windowSummary(finish, choices);
      emit({
        toolComplete: {
          name: "give",
          result: `Gave "${spec.title}" to ${scholarName ?? "the scholar"} ${res.live ? "(live now)" : "(planned)"}${summary ? `. ${summary}` : ""}`,
        },
      });
      return JSON.stringify({
        ok: true,
        scholarId,
        scholarName: scholarName ?? null,
        ...res,
        startsAtLabel: when.now
          ? undefined
          : schoolTimeLabel(when.startsAt!, await schoolTimeZone()),
        finish: summary,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      emit({ toolComplete: { name: "give", result: `⚠️ ${message}` } });
      return `Could not give the activity: ${message}`;
    }
  };

  // An app from the catalog or a link, put in front of a group now. No unit
  // or assignment: it is written as an ad hoc push (convex/pushes.ts), and
  // get_schedule lists it with a pushId that clear_activity takes.
  const giveAppOrLink = async (
    input: GiveInput,
    when: GiveWhen,
    finish: PushFinishInput | undefined,
  ): Promise<string> => {
    if (runnerMode) {
      return "Putting an app or a link in front of scholars isn't available to you here. Nothing given.";
    }
    if (filled(input.appName) && filled(input.url)) {
      return "Provide appName OR url, not both. Nothing given.";
    }
    if (filled(input.scholarId)) {
      return "For an app or a link, name scholars with scholarNames (or a groupName). Nothing given.";
    }
    if (when.startsAt !== undefined) {
      return "An app or a link can only show up now (startsNow:true). For a later time, give it then, or put the app on the class's cell in the master schedule (place_class with appId). Nothing given.";
    }
    if (!when.now) {
      return "NOT GIVEN — nothing changed. An app or a link shows up now. Confirm that with the teacher, then call give again with startsNow:true.";
    }
    if (!finish) {
      return "NOT GIVEN — nothing changed. The teacher hasn't said when it should leave their screens. Don't guess. Ask only that, offering: In this class (it leaves when the class meeting now ends; with none meeting, at the day's last bell, and not after the last bell) → finish:'inClass' · For a while (10, 20, 30, 60 or 90 minutes) → finish:'forAWhile:30' · Open until a later day, at most two weeks out (until the end of that day) → finish:'openUntil:YYYY-MM-DD'.";
    }
    if (finish.kind === "by" || finish.kind === "endOfUnit") {
      return "An app or a link has nothing to finish, so it can't be due. Use finish:'inClass', 'forAWhile:<minutes>' or 'openUntil:YYYY-MM-DD'. Nothing given.";
    }
    if (filled(input.groupName) && input.scholarNames !== undefined) {
      return "Provide groupName OR scholarNames, not both. Nothing given.";
    }

    let groupId: Id<"scholarGroups"> | undefined;
    let scholarIds: Id<"users">[] | undefined;
    if (filled(input.groupName)) {
      const match = await resolveAssignmentGroup(
        ctx,
        input.groupName!,
        allowedScholarIds,
      );
      if (match.kind === "ambiguous") {
        return `Ambiguous group name "${input.groupName}" matches ${match.candidates
          .map((candidate) => candidate.name)
          .join(", ")}. Use the exact group name. Nothing given.`;
      }
      if (match.kind === "none") {
        return `No scholar group found matching "${input.groupName}". Call list_scholar_groups to see available groups. Nothing given.`;
      }
      // A group with members outside the caller's lens would reach them too.
      if (match.scholar.hasHiddenMembers) {
        return `Some of "${match.scholar.name}" are outside your view, so it can't go to the whole group. Name the scholars instead. Nothing given.`;
      }
      groupId = match.scholar.id;
    } else if (input.scholarNames !== undefined) {
      // An empty list is not "everyone": a school-wide push needs both
      // audience fields left out on purpose.
      if (!input.scholarNames.some((name) => name.trim() !== "")) {
        return "No scholars named. Name the scholars (scholarNames) or a group (groupName). Nothing given.";
      }
      const narrowed = await resolveNarrowing(input.scholarNames);
      if (!narrowed.ok) return narrowed.message;
      scholarIds = narrowed.ids;
    }

    const res = await ctx.runMutation(internal.pushes.giveFocusFromAide, {
      callerUserId,
      scope: institutionScope,
      appName: filled(input.appName) ? input.appName!.trim() : undefined,
      url: filled(input.url) ? input.url!.trim() : undefined,
      title: filled(input.title) ? input.title!.trim() : undefined,
      media: input.media,
      groupId,
      scholarIds,
      finish,
      note: filled(input.note) ? input.note!.trim() : undefined,
    });
    if (!res.ok) {
      return "question" in res ? res.message : `Could not give it: ${res.message}`;
    }
    const at = clockTime(res.endsAt, res.timeZone);
    const summary =
      finish.kind === "openUntil"
        ? `Open until ${dayLabel(finish.dayKey, dayKeyForTimezone(Date.now(), res.timeZone))} (end of day), then it leaves their screens.`
        : finish.kind === "forAWhile"
          ? `Leaves their screens at ${at}, in ${finish.minutes} minutes.`
          : res.blockLabel
            ? `Leaves their screens at ${at}, when ${res.blockLabel} ends.`
            : res.lastBell
              ? `No class is meeting now, so it stays on their screens until the last bell, ${at}.`
              : `Leaves their screens at ${at}.`;
    const everyone = !groupId && !scholarIds;
    emit({
      toolComplete: {
        name: "give",
        result: `${res.title} live for ${res.audienceLabel} · ${summary}`,
      },
    });
    return JSON.stringify({
      ok: true,
      live: true,
      pushId: res.pushId,
      title: res.title,
      audience: everyone
        ? `Every enrolled scholar at ${res.schoolName}`
        : res.audienceLabel,
      school: res.schoolName,
      finish: summary,
    });
  };

  const giveTool = betaTool({
    name: "give",
    description:
      "Give work to scholars. This is the one tool for every give: an activity of an existing assignment, a unit (or one lesson or activity of it) for a cohort, a new one-off activity for one scholar, or an app or a link in front of a group right now. Every give needs the teacher's two answers: when it shows up (startsNow:true, or startsAtMs for a later time — a bell-block start the tool offers, or a time the teacher named) and when they should finish it (`finish`). Leave out whichever the teacher didn't say and the tool tells you what to ask, with the group's bell blocks as choices; nothing is written until both are there. Work shows up for scholars, so CONFIRM what, who and when with the teacher before calling.\n\n" +
      "WHAT and WHO, one of:\n" +
      "(1) An activity of an EXISTING assignment: assignmentId + activityId (from get_assignment) or activityTitle. Its whole cohort gets it. Add scholarNames (with startsNow:true) to give it to just those scholars on the roster: it ADDS them to whoever already has it live, which is how you give one or a few scholars more time (\"give Kai more time on the Tide Pool write-up\"); when it's already live for others it keeps that entry's finish and needs no `finish`. Each scholar lands back in their existing session with their work, so never make a new assignment for that (it would open a blank session). It refuses, saying what to do instead, when it would change anything for anyone else (planned, live for the whole cohort, or live with a different finish).\n" +
      "(2) A unit for a cohort: unitId (preferred when known, from list_units or create_unit) OR unitTitle (matched strictly: an exact title wins, a unique partial wins, an ambiguous partial is refused with the candidates). Add activityTitle for one activity of it, or lessonTitle for one lesson; omit both for the whole unit. Name the cohort by groupName (a scholar group) OR scholarNames (individual scholars). It creates (or reuses) the cohort × unit assignment for EXACTLY those scholars, so a named subset becomes its own assignment and can't reach part of a larger existing cohort (use (1) for that). Giving the same unit to the exact same roster again reuses its assignment. `title` optionally overrides the assignment title.\n" +
      "(3) A NEW one-off activity for ONE scholar: newActivity plus that scholar (scholarNames with one name, preferred, or scholarId). It makes a one-scholar assignment; call give once per scholar. newActivity.activityKind:'online' (the default) is a Socratic tutor chat; give a clear systemPrompt that keeps the tutor Socratic. 'offline' needs a due date (offline work can't be 'inClass' or 'openUntil'), and its description is REQUIRED and must hold the teacher's complete scholar-facing instructions and any pasted reading, verbatim; never invent or summarize missing source material. 'web' gives a specific HTTPS URL (embedded on iPad, opened on desktop), so don't invent a reading type. For a VIDEO don't use web: when a target activity already exists, attach the video with add_activity_resource, a video's canonical home (one sandboxed youtube-nocookie player card for the whole cohort, with no clock), whereas a YouTube web activity host-locks the WebView to all of youtube.com, fans out one assignment per scholar, and can never be completed. NEVER give a YouTube URL as web; if you do, it becomes an online tutor activity with the video attached as a sandboxed resource. Non-YouTube readings keep using web. 'problem_set' is targeted adaptive practice: first call list_practice_nodes for the domain, choose the ONE serveable node that exactly matches the teacher's topic, and pass its nodeKey as the only targetSkillKeys entry; never infer a skill key from prose.\n(4) An APP or a LINK in front of scholars right now (\"show the Geckos this reef video until the bell\"): appName (an app in the catalog, exact name) OR url (+ title, media). Audience: groupName or scholarNames, or neither for every enrolled scholar at the school (say so when you confirm). It shows up now only (startsNow:true) and leaves their screens at its finish, never late (an app has nothing to be due): 'inClass' (when the class meeting now, or starting within 10 minutes, ends; with none, at the day's last bell; refused after the last bell or on a day with no classes), 'forAWhile:<minutes>' (up to 90, for a window no class lines up with: after school, a whole-school game over lunch), or 'openUntil:YYYY-MM-DD' (at most 14 days out). get_schedule lists it with a pushId; clear_activity with that pushId ends it early." +
      currentUnitIdHint,
    inputSchema: {
      type: "object" as const,
      properties: {
        assignmentId: {
          type: "string" as const,
          description:
            "(1) An existing assignment (from list_assignments). Its cohort is the audience.",
        },
        activityId: {
          type: "string" as const,
          description:
            "(1) The activity on that assignment (from get_assignment). Or use activityTitle.",
        },
        unitId: {
          type: "string" as const,
          description:
            "(2) The unit's Convex ID (from list_units, get_unit_details, or a create_unit result). PREFERRED when known. Provide exactly one of unitId or unitTitle.",
        },
        unitTitle: {
          type: "string" as const,
          description:
            "(2) The unit's title, matched strictly. Provide exactly one of unitId or unitTitle.",
        },
        lessonTitle: {
          type: "string" as const,
          description:
            "(2) Optional: give only this lesson of the unit (matched within it).",
        },
        activityTitle: {
          type: "string" as const,
          description:
            "(1) or (2): give only this activity, matched within the assignment's or unit's activities (case-insensitive; exact title wins, ambiguous refused).",
        },
        newActivity: {
          type: "object" as const,
          description: "(3) A new one-off activity for one scholar.",
          properties: {
            title: {
              type: "string" as const,
              description:
                "Short title, e.g. 'Copenhagen taxation exploration'.",
            },
            activityKind: {
              type: "string" as const,
              enum: ["online", "offline", "web", "problem_set"] as const,
              description:
                "online = tutor chat (default); offline = scholar-facing instructions/reading in description (required; needs a due date); web = a non-YouTube reading/web URL; problem_set = targeted adaptive practice.",
            },
            systemPrompt: {
              type: "string" as const,
              description:
                "Optional tutor system prompt (defaults to a Socratic exploration prompt).",
            },
            description: {
              type: "string" as const,
              description:
                "Required for offline: complete scholar-facing instructions and any pasted reading, verbatim. Optional short scholar-facing context for other kinds.",
            },
            webUrl: {
              type: "string" as const,
              description:
                "Required for web: the specific HTTPS reading/web URL. A YouTube URL here becomes a tutor activity with the video attached.",
            },
            targetSkillKeys: {
              type: "array" as const,
              items: { type: "string" as const },
              description:
                "Required for problem_set: exactly one nodeKey from list_practice_nodes.",
            },
            itemCount: {
              type: "number" as const,
              description:
                "problem_set only: number of items, 1–30 (default 10).",
            },
          },
          required: ["title"] as const,
        },
        groupName: {
          type: "string" as const,
          description:
            "(2) or (4): a scholar group's name (case-insensitive partial match), e.g. 'the Geckos'. Mutually exclusive with scholarNames.",
        },
        scholarNames: {
          type: "array" as const,
          items: { type: "string" as const },
          description:
            "(1) Optional: only these scholars on the assignment, with startsNow:true. (2) or (4): the audience, instead of groupName. (3) The one scholar.",
        },
        scholarId: {
          type: "string" as const,
          description:
            "A scholar's user id, when already known, instead of scholarNames: (3) the one scholar for a new activity, or (1) one scholar on an existing assignment (narrows to just them, like scholarNames).",
        },
        title: {
          type: "string" as const,
          description:
            "(2) Optional assignment title override. (4) What scholars see as a link's name.",
        },
        appName: {
          type: "string" as const,
          description:
            "(4) An app in the catalog, by its exact name (case-insensitive). Mutually exclusive with url.",
        },
        url: {
          type: "string" as const,
          description:
            "(4) A full http(s) URL for a video or web page. Mutually exclusive with appName.",
        },
        media: {
          type: "string" as const,
          enum: ["video", "page"] as const,
          description: "(4) For url only: picks the glyph and the verb (Watch vs Open).",
        },
        note: {
          type: "string" as const,
          description:
            "(4) Optional one-line note shown verbatim under the app or link.",
        },
        startsNow: {
          type: "boolean" as const,
          description: "true when the teacher wants it to show up now.",
        },
        startsAtMs: {
          type: "number" as const,
          description:
            "When it shows up, for a later time (epoch ms, school-local). Omit with startsNow, or when the teacher didn't say.",
        },
        finish: {
          type: "string" as const,
          description: `${FINISH_DESCRIPTION} ${THIS_WEEK_FINISH_DESCRIPTION}`,
        },
        nextWeekHomework: {
          type: "boolean" as const,
          description: NEXT_WEEK_HOMEWORK_DESCRIPTION,
        },
        homeworkClass: {
          type: "string" as const,
          description:
            "With nextWeekHomework: which class it's for (a class subject such as 'Science'), when the teacher said (\"next week's science homework\") or answered the tool's \"Which class is this for?\". Omit otherwise; the tool works it out or asks.",
        },
      },
      required: [] as const,
    },
    run: async (rawInput: GiveInput) => {
      // "Next week's homework" answers both questions from the school
      // calendar, then takes the ordinary give path.
      let input = rawInput;
      // The class it's for, picked with the week (TRA-581): rides on the
      // finish answer, and the write path stamps it after its class checks.
      let homeworkClassId: Id<"classes"> | undefined;
      let homeworkClassSubject: string | null = null;
      if (input.nextWeekHomework === true) {
        if (
          input.startsNow === true ||
          input.startsAtMs !== undefined ||
          filled(input.finish)
        ) {
          return "nextWeekHomework sets when it shows up and when it's due, so don't also pass startsNow, startsAtMs or finish. Nothing given.";
        }
        // What it's for, when it resolves cheaply, so it can show up at its
        // class's first meeting and link to that class. A failure here is
        // reported by the give path below, not guessed around.
        let unitId: Id<"units"> | undefined;
        let scholarIds: Id<"users">[] | undefined;
        if (!filled(input.assignmentId)) {
          if (filled(input.unitId) || filled(input.unitTitle)) {
            const unit = await resolveUnitInput(input);
            if (unit.ok) unitId = unit.unit.id;
          }
          if (filled(input.groupName) || (input.scholarNames?.length ?? 0) > 0) {
            const cohort = await resolveCohort(input);
            if (cohort.ok) scholarIds = cohort.ids;
          }
        }
        const week = await ctx.runQuery(
          internal.homeworkPlanner.aideNextWeekHomework,
          {
            callerUserId,
            now: Date.now(),
            assignmentId: filled(input.assignmentId)
              ? (input.assignmentId as Id<"assignments">)
              : undefined,
            unitId,
            scholarIds,
            className: filled(input.homeworkClass) ? input.homeworkClass : undefined,
          },
        );
        if (!week) return "Couldn't read your school's calendar. Nothing given.";
        if (week.kind === "closed") {
          return `NOT GIVEN — nothing changed. There's no school the week of ${weekOfLabel(week.mondayKey)}, so it has no homework days. Ask the teacher which week they mean, then give it with startsAtMs and finish.`;
        }
        if (week.kind === "whichClass") {
          const choices = week.choices.join(" or ");
          return `NOT GIVEN — nothing changed. More than one class could be this homework's. Ask the teacher only "Which class is this for: ${choices}?", then call give again with the same input plus homeworkClass set to their answer (one of: ${week.choices.map((c) => `'${c}'`).join(", ")}).`;
        }
        input = {
          ...input,
          nextWeekHomework: undefined,
          homeworkClass: undefined,
          startsAtMs: week.showsUpAt,
          finish: week.dueDayKey,
        };
        homeworkClassId = week.classId ?? undefined;
        homeworkClassSubject = week.classSubject;
      }
      // "Due this week": the last school day of the week it shows up in.
      if (input.finish?.trim() === "thisWeek") {
        const dayKey = await ctx.runQuery(internal.homeworkPlanner.aideThisWeekDueDay, {
          callerUserId,
          now: Date.now(),
          startsAt: input.startsNow === true ? undefined : input.startsAtMs,
        });
        if (!dayKey) {
          return "NOT GIVEN — nothing changed. There's no school day that week to be due on. Ask the teacher which day they mean.";
        }
        input = { ...input, finish: dayKey };
      }
      const appOrLink = filled(input.appName) || filled(input.url);
      const forAWhile = appOrLink ? forAWhileInput(input.finish) : undefined;
      const parsed = forAWhile ? undefined : parseFinishInput(input.finish);
      if (parsed && "error" in parsed) return parsed.error;
      const finish: GiveFinish | undefined =
        parsed?.kind === "by" && homeworkClassId
          ? { ...parsed, classId: homeworkClassId }
          : parsed;
      if (input.startsNow === true && input.startsAtMs !== undefined) {
        return "Provide startsNow:true OR startsAtMs, not both. Nothing given.";
      }
      const when: GiveWhen = {
        now: input.startsNow === true,
        startsAt: input.startsNow === true ? undefined : input.startsAtMs,
      };
      const result = await (async (): Promise<string> => {
        const onAssignment = filled(input.assignmentId);
        const fromUnit = filled(input.unitId) || filled(input.unitTitle);
        if (appOrLink) {
          if (
            input.newActivity != null ||
            filled(input.assignmentId) ||
            filled(input.unitId) ||
            filled(input.unitTitle) ||
            filled(input.activityId) ||
            filled(input.activityTitle) ||
            filled(input.lessonTitle)
          ) {
            return "An app or a link is given on its own, so don't also name an assignment, unit, lesson, activity or newActivity. Nothing given.";
          }
          return giveAppOrLink(input, when, forAWhile ?? finish);
        }
        if (input.newActivity != null) {
          if (
            onAssignment ||
            fromUnit ||
            filled(input.activityId) ||
            filled(input.activityTitle) ||
            filled(input.lessonTitle)
          ) {
            return "newActivity makes a new activity, so don't also name an assignment, unit, lesson or activity. Nothing given.";
          }
          return giveNewActivity(input, when, finish);
        }
        if (onAssignment) {
          if (fromUnit || filled(input.lessonTitle)) {
            return "With assignmentId, give one of its activities (activityId or activityTitle); don't also name a unit or lesson. To give a whole unit or lesson, name the unit and the cohort instead. Nothing given.";
          }
          return giveOnAssignment(input, when, finish);
        }
        if (filled(input.activityId)) {
          return "activityId goes with assignmentId. With a unit, name the activity by activityTitle. Nothing given.";
        }
        if (fromUnit) return giveFromUnit(input, when, finish);
        return "Say what to give: an activity of an existing assignment (assignmentId + activityId or activityTitle), a unit for a cohort (unitId or unitTitle, optionally lessonTitle or activityTitle, plus groupName or scholarNames), a new one-off activity (newActivity + one scholar), or an app or a link (appName or url). Nothing given.";
      })();
      // Name the class next week's homework was filed under (TRA-581).
      if (homeworkClassSubject && result.startsWith("{")) {
        try {
          const parsedResult = JSON.parse(result) as Record<string, unknown>;
          if (parsedResult.ok === true) {
            return JSON.stringify({ ...parsedResult, homeworkClass: homeworkClassSubject });
          }
        } catch {
          // Not JSON after all: return it as it is.
        }
      }
      return result;
    },
  });

  // Publication (TRA-490): a new unit is teachers-only until published or
  // assigned. Assigning publishes on its own; this is the tool for "let
  // scholars find it" without assigning, and for taking it back.
  const publishUnitTool = betaTool({
    name: "publish_unit",
    description:
      "Publish a unit so scholars can find it in Start a Quest and start it on their own, or unpublish it (published: false) to make it teachers-only again. A new unit starts UNPUBLISHED; giving it (give) and every place tool publish it automatically, so call this only when the teacher wants the unit open to scholars WITHOUT assigning it, or wants it hidden again. Unpublishing never takes away work a scholar was already assigned. Not for a scholar's own Quest (independent study), which is private to that scholar." +
      currentUnitIdHint,
    inputSchema: {
      type: "object" as const,
      properties: {
        unitId: {
          type: "string" as const,
          description:
            "The unit's Convex ID (from list_units, get_unit_details, or a create_unit result).",
        },
        published: {
          type: "boolean" as const,
          description: "true (default) to publish, false to unpublish.",
        },
      },
      required: ["unitId"] as const,
    },
    run: async (input: { unitId: string; published?: boolean }) => {
      try {
        const res = await ctx.runMutation(internal.units.aideSetUnitPublished, {
          callerUserId,
          unitId: input.unitId as Id<"units">,
          published: input.published ?? true,
        });
        emit({
          toolComplete: {
            name: "publish_unit",
            result: `${res.published ? "Published" : "Unpublished"} "${res.title}"`,
          },
        });
        return JSON.stringify(res);
      } catch (e) {
        return `Could not change publication: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  const listAssignmentsTool = betaTool({
    name: "list_assignments",
    description:
      "List the teacher's active assignments. An assignment is one cohort (a fixed set of scholars) running one unit — its `roster` is who's in it. Use this to find an assignmentId, and to tell apart two assignments of the same unit by their rosters.",
    inputSchema: { type: "object" as const, properties: {}, required: [] as const },
    run: async () => {
      const rows = await ctx.runQuery(
        internal.assignments.aideListAssignments,
        { callerUserId },
      );
      const withUrls = rows.map((r) => ({
        ...r,
        url: withBase(linkBase, assignmentPath(r.assignmentId)),
      }));
      emit({ toolComplete: { name: "list_assignments", result: `Found ${rows.length} assignments` } });
      return JSON.stringify(withUrls);
    },
  });

  const getScheduleTool = betaTool({
    name: "get_schedule",
    description:
      "Read scheduled activities across ALL the teacher's assignments, flattened to one item per (assignment, activity) push. Each item has an `agendaAtMs` (epoch ms, its position on the agenda) plus a human `whenLabel` in school-local time, its `state` (planned | live | done), `mode` (a storage name: classFocus = in class or open until a date, homework = due on a date; describe it to teachers in those words, never as \"class focus\"), and the assignment/unit/activity it belongs to. This is the read to use before a bulk reschedule. Optionally window by `fromMs`/`toMs` (epoch ms, matched against agendaAtMs). An app or a link given right now (give case 4) is listed too, as a `live` item with a `pushId`, its `title`, `audience`, `whenLabel` and `endsAtLabel`; It can't be rescheduled: clear_activity with that pushId is the only way to end it early.",
    inputSchema: {
      type: "object" as const,
      properties: {
        fromMs: { type: "number" as const, description: "Only items at/after this epoch-ms agenda position." },
        toMs: { type: "number" as const, description: "Only items before this epoch-ms agenda position." },
      },
      required: [] as const,
    },
    run: async (input: { fromMs?: number; toMs?: number }) => {
      const items = await ctx.runQuery(
        internal.assignments.aideScheduleForTeacher,
        { callerUserId, from: input.fromMs, to: input.toMs },
      );
      const timeZone = await schoolTimeZone();
      const enriched = items.map((it) => ({
        ...it,
        agendaAtMs: it.agendaAt,
        whenLabel: schoolTimeLabel(it.agendaAt, timeZone),
        startsAtLabel: schoolTimeLabel(it.startsAt, timeZone),
        dueAtLabel: schoolTimeLabel(it.dueAt, timeZone),
      }));
      // Apps and links given right now (ad hoc pushes, on no assignment).
      const pushes = runnerMode
        ? null
        : await ctx.runQuery(internal.pushes.liveFocusForAide, {
            callerUserId,
            scope: institutionScope,
          });
      const liveGives = (pushes?.ok ? pushes.pushes : [])
        .filter((p) => {
          const at = p.setAt ?? Date.now();
          if (input.fromMs != null && at < input.fromMs) return false;
          if (input.toMs != null && at >= input.toMs) return false;
          return true;
        })
        .map((p) => ({
          state: "live" as const,
          pushId: p.pushId,
          kind: p.kind,
          title: p.title,
          audience: p.audience,
          note: p.note,
          agendaAtMs: p.setAt,
          whenLabel: schoolTimeLabel(p.setAt, timeZone),
          endsAtLabel: schoolTimeLabel(p.endsAt, timeZone),
        }));
      const all = liveGives.length > 0 ? [...enriched, ...liveGives] : enriched;
      emit({ toolComplete: { name: "get_schedule", result: `${all.length} scheduled items` } });
      return JSON.stringify(all);
    },
  });

  const getAssignmentTool = betaTool({
    name: "get_assignment",
    description:
      "Full detail for ONE assignment: its roster, its current schedule, and the unit's `availableActivities` (each with an activityId and whether it's already scheduled). Use this to find the activityId for an activity you want to schedule that isn't on the agenda yet.",
    inputSchema: {
      type: "object" as const,
      properties: {
        assignmentId: { type: "string" as const, description: "The assignment's Convex id (from list_assignments)." },
      },
      required: ["assignmentId"] as const,
    },
    run: async (input: { assignmentId: string }) => {
      const data = await ctx.runQuery(internal.assignments.aideGetAssignment, {
        callerUserId,
        assignmentId: input.assignmentId as Id<"assignments">,
      });
      if (!data) return `No assignment found with id "${input.assignmentId}" (or it isn't yours).`;
      emit({ toolComplete: { name: "get_assignment", result: data.unitTitle } });
      const timeZone = await schoolTimeZone();
      return JSON.stringify({
        ...data,
        url: withBase(linkBase, assignmentPath(data.assignmentId)),
        // A standing (unitId-less) assignment has no unit page to link to.
        unitUrl: data.unitId ? withBase(linkBase, unitPath(data.unitId)) : null,
        schedule: data.schedule.map((e) => ({
          ...e,
          startsAtLabel: schoolTimeLabel(e.startsAt, timeZone),
          dueAtLabel: schoolTimeLabel(e.dueAt, timeZone),
        })),
      });
    },
  });

  const granuleCoverageTool = betaTool({
    name: "get_granule_coverage",
    description:
      "Understanding coverage for one assignment: each scholar's status against the unit's essential questions / enduring understandings. green = demonstrated, yellow = probed but not yet demonstrated, gray = no conversation has engaged it yet. A mostly-gray granule across the cohort is a CURRICULUM gap (Rabbithole never probed it — consider scheduling an activity that does), not a scholar deficit.\n\n" +
      "BEFORE/AFTER: each cell also carries baselineStatus (start of unit) and exitStatus (end of unit) plus an `improved` flag, and the response has a cohort-level `movement` rollup (comparablePairs / improved / heldAtDemonstrated). Use these to answer 'how did this assignment AFFECT understanding?' — but note before/after only exists once BOTH a baseline and an exit-ticket activity have run; otherwise report cumulative status and say the pre/post pair is missing. Use list_assignments to find the assignmentId.",
    inputSchema: {
      type: "object" as const,
      properties: {
        assignmentId: { type: "string" as const, description: "The assignment's Convex id (from list_assignments)." },
      },
      required: ["assignmentId"] as const,
    },
    run: async (input: { assignmentId: string }) => {
      const data = await ctx.runQuery(internal.granuleEvidence.aideCoverage, {
        callerUserId,
        assignmentId: input.assignmentId as Id<"assignments">,
      });
      if (!data) return `No assignment found with id "${input.assignmentId}" (or it isn't yours).`;
      if (data.granules.length === 0)
        return `Unit "${data.unitTitle}" has no essential questions or enduring understandings defined, so there's no coverage to report.`;
      emit({ toolComplete: { name: "get_granule_coverage", result: `${data.scholars.length} scholars × ${data.granules.length} granules` } });
      return JSON.stringify(data);
    },
  });

  const rescheduleActivityTool = betaTool({
    name: "reschedule_activity",
    description:
      "Move an already-scheduled activity to a new time (epoch ms, school-local time). For a PLANNED item this moves when it goes live; for a LIVE item it only moves its agenda position (it does not un-push). To move a run of a class's gives by class meetings (\"push everything back a day\"), use move_class_days. Identify the item by its assignmentId + activityId.",
    inputSchema: {
      type: "object" as const,
      properties: {
        assignmentId: { type: "string" as const },
        activityId: { type: "string" as const },
        startsAtMs: { type: "number" as const, description: "New agenda time (epoch ms)." },
      },
      required: ["assignmentId", "activityId", "startsAtMs"] as const,
    },
    run: async (input: { assignmentId: string; activityId: string; startsAtMs: number }) => {
      let res: { ok: boolean; found: boolean };
      try {
        res = await ctx.runMutation(internal.assignments.aideRescheduleActivity, {
          callerUserId,
          assignmentId: input.assignmentId as Id<"assignments">,
          activityId: input.activityId as Id<"activities">,
          startsAt: input.startsAtMs,
        });
      } catch (e) {
        return `Could not reschedule: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (!res.found) return "No scheduled entry found for that activity on that assignment — nothing to move.";
      emit({ toolComplete: { name: "reschedule_activity", result: `Moved to ${schoolTimeLabel(input.startsAtMs, await schoolTimeZone())}` } });
      return JSON.stringify({ ok: true, startsAtLabel: schoolTimeLabel(input.startsAtMs, await schoolTimeZone()) });
    },
  });

  const clearActivityTool = betaTool({
    name: "clear_activity",
    description:
      "Remove an activity from an assignment's schedule (un-plans a planned push, or clears a live one). Identify by assignmentId + activityId, or, for an app or a link given right now, by its pushId from get_schedule (exactly one of the two). This removes it for the assignment's WHOLE roster — before clearing in reply to an end-of-day past-due homework question, check the roster with get_assignment, and if it includes scholars beyond the ones named in the question, say so and confirm before clearing.",
    inputSchema: {
      type: "object" as const,
      properties: {
        assignmentId: { type: "string" as const },
        activityId: { type: "string" as const },
        pushId: {
          type: "string" as const,
          description:
            "An app or a link given right now (from get_schedule), instead of assignmentId + activityId.",
        },
      },
      required: [] as const,
    },
    run: async (input: {
      assignmentId?: string;
      activityId?: string;
      pushId?: string;
    }) => {
      const hasPush = filled(input.pushId);
      const hasEntry = filled(input.assignmentId) || filled(input.activityId);
      if (hasPush === hasEntry) {
        return "Identify exactly one thing to clear: assignmentId + activityId, or a pushId from get_schedule. Nothing cleared.";
      }
      if (hasPush) {
        const ended = await ctx.runMutation(internal.pushes.clearFocusFromAide, {
          callerUserId,
          pushId: input.pushId!.trim(),
          scope: institutionScope,
        });
        if (!ended.ok) return `Could not clear: ${ended.message}`;
        emit({ toolComplete: { name: "clear_activity", result: "Cleared" } });
        return JSON.stringify({ ok: true, message: ended.message });
      }
      if (!filled(input.assignmentId) || !filled(input.activityId)) {
        return "Give both assignmentId and activityId. Nothing cleared.";
      }
      let res: { ok: boolean; removed: boolean };
      try {
        res = await ctx.runMutation(internal.assignments.aideClearActivity, {
          callerUserId,
          assignmentId: input.assignmentId as Id<"assignments">,
          activityId: input.activityId as Id<"activities">,
        });
      } catch (e) {
        return `Could not clear: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (!res.removed) return "No scheduled entry found for that activity on that assignment — nothing to clear.";
      emit({ toolComplete: { name: "clear_activity", result: "Cleared" } });
      return JSON.stringify({ ok: true });
    },
  });

  // ── Assignment insight + live controls (teacher/admin only) ──────────
  // The "how's it going" read and the act-now writes that complete the
  // conversational alternative to the Run page's list-detail layout.

  const getAssignmentProgressTool = betaTool({
    name: "get_assignment_progress",
    description:
      "How is ONE assignment going right now? Returns the roster with each scholar's started-status (has a project) + project link + how many activities they've completed, PLUS a per-activity roll-up: how many completed (and who hasn't), how many SUBMISSIONS are in (deliverables) with the not/half/full verdict breakdown, and the push state (planned | live | done). Use this to answer \"how many submissions are in for <activity>?\", \"who hasn't started yet?\", and \"open <scholar>'s project\". Find the assignmentId first with list_assignments / get_schedule. Activities are trimmed to those scheduled or with any work, so a since-cleared activity still reports its submissions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        assignmentId: { type: "string" as const, description: "The assignment's Convex id (from list_assignments / get_schedule)." },
      },
      required: ["assignmentId"] as const,
    },
    run: async (input: { assignmentId: string }) => {
      const data = await ctx.runQuery(internal.assignments.aideAssignmentProgress, {
        callerUserId,
        assignmentId: input.assignmentId as Id<"assignments">,
      });
      if (!data) return `No assignment found with id "${input.assignmentId}" (or it isn't yours).`;
      const started = data.roster.filter((r) => r.started).length;
      emit({
        toolComplete: {
          name: "get_assignment_progress",
          result: `${data.unitTitle}: ${started}/${data.rosterSize} started`,
        },
      });
      const timeZone = await schoolTimeZone();
      return JSON.stringify({
        ...data,
        roster: data.roster.map((r) => ({
          ...r,
          lastActiveLabel: schoolTimeLabel(r.lastMessageAt, timeZone),
          // Deep link to the scholar's session under this assignment, opened
          // as that scholar for staff (?remote=). Null until they start.
          sessionUrl: r.sessionId
            ? withBase(linkBase, sessionPath(r.sessionId, r.scholarId))
            : null,
        })),
      });
    },
  });

  const setAssignmentScholarsTool = betaTool({
    name: "set_assignment_scholars",
    description:
      "REPLACE an assignment's roster with exactly the named scholars — anyone not listed is removed from the cohort, anyone listed is added. To only ADD without removing, use add_assignment_scholars instead; to take one or a few scholars off, use remove_assignment_scholars. Pass scholar names (resolved case-insensitively); resolve a group's members with list_scholar_groups first if the teacher names a group. Confirm the resolved names with the teacher before changing a roster.",
    inputSchema: {
      type: "object" as const,
      properties: {
        assignmentId: { type: "string" as const },
        scholarNames: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "The exact set of scholars the cohort should contain.",
        },
      },
      required: ["assignmentId", "scholarNames"] as const,
    },
    run: async (input: { assignmentId: string; scholarNames: string[] }) => {
      const { ids, unresolved, ambiguous } = await resolveScholars(
        input.scholarNames,
      );
      if (ambiguous.length > 0) {
        const detail = ambiguous
          .map((a) => `"${a.name}" matches ${a.candidates.join(", ")}`)
          .join("; ");
        return `Ambiguous scholar name(s): ${detail}. No change made — use a full name to disambiguate.`;
      }
      if (unresolved.length > 0) {
        return `Could not resolve these scholar names: ${unresolved.join(", ")}. No change made.`;
      }
      if (ids.length === 0) return "No scholars given — refusing to empty the roster. Pass at least one scholar.";
      try {
        const res = await ctx.runMutation(internal.assignments.aideSetScholars, {
          callerUserId,
          assignmentId: input.assignmentId as Id<"assignments">,
          scholarIds: ids,
        });
        emit({ toolComplete: { name: "set_assignment_scholars", result: `Roster set to ${res.rosterSize}` } });
        return JSON.stringify({ ok: true, rosterSize: res.rosterSize });
      } catch (e) {
        return `Could not set roster: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  const removeAssignmentScholarsTool = betaTool({
    name: "remove_assignment_scholars",
    description:
      "REMOVE the named scholars from one of YOUR assignments' cohorts, keeping everyone else — use this instead of set_assignment_scholars when taking one or a few scholars off (e.g. a visitor after their visit). Names (or usernames, to tell apart two scholars with the same name) are matched against that assignment's own roster, so it works even for a scholar who has since moved to another school. Refuses an ambiguous or unknown name, and refuses to empty the roster (archive the assignment instead). Activities targeted only at the removed scholars are dropped from the schedule. Confirm the scholar and assignment before calling.",
    inputSchema: {
      type: "object" as const,
      properties: {
        assignmentId: { type: "string" as const },
        scholarNames: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Scholars to remove from the cohort.",
        },
      },
      required: ["assignmentId", "scholarNames"] as const,
    },
    run: async (input: { assignmentId: string; scholarNames: string[] }) => {
      try {
        const res = await ctx.runMutation(internal.assignments.aideRemoveScholars, {
          callerUserId,
          assignmentId: input.assignmentId as Id<"assignments">,
          scholarNames: input.scholarNames,
        });
        if (!res.ok) return res.message;
        emit({
          toolComplete: {
            name: "remove_assignment_scholars",
            result: `Removed ${res.removed.join(", ")}; roster now ${res.rosterSize}`,
          },
        });
        return JSON.stringify({ ok: true, removed: res.removed, rosterSize: res.rosterSize });
      } catch (e) {
        return `Could not remove scholars: ${e instanceof Error ? e.message : String(e)}. No change made.`;
      }
    },
  });

  const addAssignmentScholarsTool = betaTool({
    name: "add_assignment_scholars",
    description:
      "ADD the named scholars to an assignment's cohort, keeping everyone already on the roster (use set_assignment_scholars to replace instead). Pass scholar names; resolve a group with list_scholar_groups first if the teacher names a group. Confirm before changing a roster.",
    inputSchema: {
      type: "object" as const,
      properties: {
        assignmentId: { type: "string" as const },
        scholarNames: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Scholars to add to the cohort.",
        },
      },
      required: ["assignmentId", "scholarNames"] as const,
    },
    run: async (input: { assignmentId: string; scholarNames: string[] }) => {
      const { ids, unresolved, ambiguous } = await resolveScholars(
        input.scholarNames,
      );
      if (ambiguous.length > 0) {
        const detail = ambiguous
          .map((a) => `"${a.name}" matches ${a.candidates.join(", ")}`)
          .join("; ");
        return `Ambiguous scholar name(s): ${detail}. No change made — use a full name to disambiguate.`;
      }
      if (unresolved.length > 0) {
        return `Could not resolve these scholar names: ${unresolved.join(", ")}. No change made.`;
      }
      if (ids.length === 0) return "No scholars given to add.";
      try {
        const res = await ctx.runMutation(internal.assignments.aideAddScholars, {
          callerUserId,
          assignmentId: input.assignmentId as Id<"assignments">,
          scholarIds: ids,
        });
        emit({ toolComplete: { name: "add_assignment_scholars", result: `Roster now ${res.rosterSize}` } });
        return JSON.stringify({ ok: true, rosterSize: res.rosterSize });
      } catch (e) {
        return `Could not add scholars: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  const archiveAssignmentTool = betaTool({
    name: "archive_assignment",
    description:
      "Archive (end) an assignment — clears its live/planned pushes and drops it from the active list. Scholars stop seeing its activities. Un-archiving is a UI-only action, so treat this as one-way from here. ALWAYS confirm the specific assignment (unit + roster, from list_assignments) with the teacher before archiving.",
    inputSchema: {
      type: "object" as const,
      properties: {
        assignmentId: { type: "string" as const },
      },
      required: ["assignmentId"] as const,
    },
    run: async (input: { assignmentId: string }) => {
      try {
        const res = await ctx.runMutation(internal.assignments.aideArchiveAssignment, {
          callerUserId,
          assignmentId: input.assignmentId as Id<"assignments">,
        });
        emit({
          toolComplete: {
            name: "archive_assignment",
            result: res.alreadyArchived ? "Already archived" : "Archived",
          },
        });
        return JSON.stringify(res);
      } catch (e) {
        return `Could not archive: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  // Resolve one of the caller's assignments by its human name (its unit title,
  // or the ad-hoc dispatch title). Strict like the rest of the aide: an exact
  // name wins, a unique partial wins, an ambiguous partial is refused with the
  // candidates so the model can retry with the exact one (or an assignmentId).
  const resolveAssignmentByTitle = async (
    title: string,
  ): Promise<
    | { ok: true; assignmentId: Id<"assignments"> }
    | { ok: false; message: string }
  > => {
    const lower = title.trim().toLowerCase();
    if (!lower) return { ok: false, message: "Provide an assignment title." };
    const rows: Array<{
      assignmentId: Id<"assignments">;
      title: string | null;
      unitTitle: string;
    }> = await ctx.runQuery(internal.assignments.aideListAssignments, {
      callerUserId,
    });
    const label = (r: { title: string | null; unitTitle: string }) =>
      (r.title ?? r.unitTitle).toLowerCase();
    const matches = rows.filter((r) => label(r).includes(lower));
    if (matches.length === 0) {
      return {
        ok: false,
        message: `No assignment matching "${title}". Use list_assignments to find it, or pass an assignmentId.`,
      };
    }
    const exact = matches.filter((r) => label(r) === lower);
    if (exact.length === 1) {
      return { ok: true, assignmentId: exact[0].assignmentId };
    }
    if (matches.length === 1) {
      return { ok: true, assignmentId: matches[0].assignmentId };
    }
    return {
      ok: false,
      message: `Ambiguous assignment "${title}" matches ${matches
        .map((r) => r.title ?? r.unitTitle)
        .join(", ")}. Use the exact name or an assignmentId.`,
    };
  };

  const addActivityResourceTool = betaTool({
    name: "add_activity_resource",
    description:
      "Attach a VIDEO (or a web LINK) to an EXISTING activity as a resource — the canonical home for a video a cohort should watch. It becomes a resource card the tutor hands out with share_resource; a YouTube video plays in the sandboxed youtube-nocookie player (it does NOT host-lock a WebView to all of youtube.com), one card for the whole cohort, and it carries no clock. PREFER THIS over giving a new one-off web activity for any YouTube URL whenever a target activity already exists. Identify the activity by its assignment (assignmentId preferred, or assignmentTitle — its unit/dispatch name) PLUS activityTitle, matched strictly within that assignment's unit: an exact title wins, an ambiguous partial is refused. `kind` defaults to video when the URL is a YouTube link, otherwise link.",
    inputSchema: {
      type: "object" as const,
      properties: {
        assignmentId: {
          type: "string" as const,
          description:
            "The assignment's Convex id (from list_assignments / get_assignment). PREFERRED. Provide this OR assignmentTitle.",
        },
        assignmentTitle: {
          type: "string" as const,
          description:
            "The assignment's name (its unit title, or an ad-hoc dispatch title), matched strictly — exact wins, ambiguous refused. Provide this OR assignmentId.",
        },
        activityTitle: {
          type: "string" as const,
          description:
            "The target activity's title WITHIN that assignment's unit (case-insensitive; exact title wins, ambiguous refused).",
        },
        url: {
          type: "string" as const,
          description:
            "The resource URL (https). A YouTube watch/share/shorts/embed URL is embedded as a sandboxed video.",
        },
        title: {
          type: "string" as const,
          description:
            "Optional display title for the resource card (defaults to 'Video' or 'Website').",
        },
        kind: {
          type: "string" as const,
          enum: ["video", "link"] as const,
          description:
            "video = embedded player (YouTube → sandboxed youtube-nocookie); link = a website card. Defaults to video for a YouTube URL, else link.",
        },
      },
      required: ["activityTitle", "url"] as const,
    },
    run: async (input: {
      assignmentId?: string;
      assignmentTitle?: string;
      activityTitle: string;
      url?: string;
      title?: string;
      kind?: "video" | "link";
    }) => {
      const hasId = input.assignmentId?.trim();
      const hasTitle = input.assignmentTitle?.trim();
      if (hasId && hasTitle) {
        return "Provide assignmentId OR assignmentTitle, not both; no resource was added.";
      }
      if (!hasId && !hasTitle) {
        return "Provide assignmentId or assignmentTitle; no resource was added.";
      }
      const url = input.url?.trim();
      if (!url) return "Provide a resource URL; no resource was added.";

      let assignmentId: Id<"assignments">;
      if (hasId) {
        assignmentId = hasId as Id<"assignments">;
      } else {
        const resolved = await resolveAssignmentByTitle(hasTitle!);
        if (!resolved.ok) return `${resolved.message} No resource was added.`;
        assignmentId = resolved.assignmentId;
      }

      const data = await ctx.runQuery(internal.assignments.aideGetAssignment, {
        callerUserId,
        assignmentId,
      });
      if (!data) {
        return `No assignment found with id "${assignmentId}" (or it isn't yours); no resource was added.`;
      }

      const lower = input.activityTitle.trim().toLowerCase();
      if (!lower) return "Provide an activity title; no resource was added.";
      const candidates = data.availableActivities.filter((a) =>
        a.title.toLowerCase().includes(lower),
      );
      if (candidates.length === 0) {
        return `No activity matching "${input.activityTitle}" in ${data.unitTitle}; no resource was added.`;
      }
      const exact = candidates.filter((a) => a.title.toLowerCase() === lower);
      let activity: (typeof candidates)[number];
      if (exact.length === 1) {
        activity = exact[0];
      } else if (candidates.length === 1) {
        activity = candidates[0];
      } else {
        return `Ambiguous activity "${input.activityTitle}" matches ${candidates
          .map((a) => a.title)
          .join(", ")}. Use the exact title; no resource was added.`;
      }

      const kind: "video" | "link" =
        input.kind ?? (youtubeVideoId(url) ? "video" : "link");

      let res: { resourceId: Id<"activityResources">; title: string };
      try {
        res = await ctx.runMutation(
          internal.activityResources.aideAddUrlResource,
          {
            callerUserId,
            activityId: activity.activityId,
            title: input.title ?? "",
            url,
            kind,
          },
        );
      } catch (e) {
        return `Could not add the resource: ${e instanceof Error ? e.message : String(e)}`;
      }

      const assignmentName = data.title ?? data.unitTitle;
      const noun = kind === "video" ? "video" : "link";
      emit({
        toolComplete: {
          name: "add_activity_resource",
          result: `Added ${noun} "${res.title}" to ${activity.title}`,
        },
      });
      return JSON.stringify({
        ok: true,
        kind,
        resourceId: res.resourceId,
        resourceTitle: res.title,
        activityId: activity.activityId,
        activityTitle: activity.title,
        assignmentId: data.assignmentId,
        assignmentTitle: assignmentName,
        message: `Added ${noun} "${res.title}" to ${activity.title} (${assignmentName})`,
      });
    },
  });

  if (runnerMode) {
    // curriculum:run: run the units she can edit. Deliberately NOT here:
    // publish_unit (a design decision for the unit's school), the granule
    // coverage grid (per-scholar understanding evidence — learning record),
    // roster edits and archive (teacher lifecycle), and resources (design).
    // `give` refuses a new one-off activity for her (it builds no unit).
    return [
      giveTool,
      listAssignmentsTool,
      getScheduleTool,
      getAssignmentTool,
      getAssignmentProgressTool,
      rescheduleActivityTool,
      clearActivityTool,
    ];
  }

  // Planning a unit across a class's days (TRA-582): teacher/admin only,
  // since it names groups.
  const classPlanTools = await makeClassPlanTools(ctx, emit, {
    callerUserId,
    linkBase,
    allowedScholarIds,
    institutionScope,
    currentUnit,
    confirmScope: opts.classPlanConfirmScope,
  });

  return [
    // The one way to give work (TRA-573).
    giveTool,
    ...classPlanTools,
    publishUnitTool,
    listAssignmentsTool,
    getScheduleTool,
    getAssignmentTool,
    getAssignmentProgressTool,
    granuleCoverageTool,
    rescheduleActivityTool,
    clearActivityTool,
    // Roster + lifecycle — same cohort, same owner gate.
    setAssignmentScholarsTool,
    addAssignmentScholarsTool,
    removeAssignmentScholarsTool,
    archiveAssignmentTool,
    // Attach a video/link to an activity as a resource (the canonical home for
    // a video — vs. a one-off web activity given to each scholar).
    addActivityResourceTool,
  ];
}
