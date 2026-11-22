// The aide's class-planning tools (TRA-582): plan a unit across a class's
// days by conversation ("put the rest of Mapping Our Islands on Humanities
// through next week, one a day, skipping Wednesday").
//
//   get_class_days   — a class's meetings over a range, with closures, and
//                      (with a unit) its activities and what the group has
//   give_class_days  — several activities to several meetings, previewed,
//                      then given in one confirmed step
//   move_class_days  — move a run of planned gives N class meetings
//
// The backing reads and writes live in convex/classPlans.ts and go through
// the `give` tool's own writers. Built from makeAssignmentTools, so the
// in-app aide and the Slack bot (which composes the same toolset) both get
// them; teacher/admin only (a curriculum:run holder has no group lookups).
//
// Runtime note: like its siblings, dynamically imports `betaTool` (no static
// `@anthropic-ai/sdk` import).

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { AideEmit } from "./aideStream";
import { makeUnitResolver } from "./aideResolvers";
import { matchScholarByName } from "./scholarReadTools";
import { FINISH_DESCRIPTION, finishQuestion, parseFinishInput } from "./assignmentTools";
import type { GiveFinish } from "./giveWindow";
import { shiftDayKey } from "../../shared/institutionDay";
import { withBase, assignmentPath } from "./channels";
import { PLAN_CONFIRMATION_REFUSED } from "./classPlan";

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** "Tue, Nov 10" for a school-local day key. */
export function planDayLabel(dayKey: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${dayKey}T12:00:00.000Z`));
}

function clock(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(ms));
}

/** One line for a finish answer, as the teacher would say it. */
export function finishLabel(finish: GiveFinish): string {
  switch (finish.kind) {
    case "inClass":
      return "in class (leaves their screens when the class ends)";
    case "by":
      return `due ${planDayLabel(finish.dayKey)} (goes late after)`;
    case "openUntil":
      return `open until ${planDayLabel(finish.dayKey)} (then disappears; never late)`;
    case "endOfUnit":
      return "due at the end of the unit";
  }
}

/** The result line for a call that returned a question or a refusal. */
export function earlyResultLabel(out: string): string {
  if (out.startsWith("NOT GIVEN")) return "Asked the teacher a question · nothing given";
  const first = out.split(/(?<=[.?!])\s/)[0] ?? out;
  return first.length > 120 ? `${first.slice(0, 117)}...` : first;
}

/** Which assignment a plan's gives go to, in a sentence for the aide. When
 *  the unit runs for this group only on an assignment shared with other
 *  scholars, says how many (never who) and why it isn't reused. */
export function planAssignmentLine(
  groupName: string,
  unitTitle: string,
  existing: boolean,
  sharedRunning: { otherScholars: number } | null,
  verb: "will" | "did",
): string {
  if (existing) {
    return `${verb === "did" ? "Added" : "Adds"} to the ${groupName} × ${unitTitle} assignment already running.`;
  }
  const what = `${verb === "did" ? "Made" : "Makes"} a new ${groupName} × ${unitTitle} assignment`;
  if (sharedRunning) {
    const n = sharedRunning.otherScholars;
    return `${what}. ${unitTitle} is already running for this group on an assignment shared with ${n} other scholar${n === 1 ? "" : "s"}; a plan never gives into a shared assignment, because a give there would replace the other scholars' give of the same activity.`;
  }
  return `${what}; this group has none running.`;
}

type ActivityRef = { activityId?: string; activityTitle?: string };

/** Match an activity reference against the unit's activities: an id, or a
 *  title (exact wins, a unique partial wins, ambiguity is refused). */
export function matchUnitActivity(
  ref: ActivityRef,
  activities: ReadonlyArray<{ activityId: string; title: string }>,
): { ok: true; activityId: string; title: string } | { ok: false; message: string } {
  if (ref.activityId?.trim()) {
    const hit = activities.find((a) => a.activityId === ref.activityId!.trim());
    return hit
      ? { ok: true, activityId: hit.activityId, title: hit.title }
      : { ok: false, message: `No activity with id "${ref.activityId}" in this unit.` };
  }
  const lower = ref.activityTitle?.trim().toLowerCase() ?? "";
  if (!lower) return { ok: false, message: "Each give needs an activityTitle or activityId." };
  const partial = activities.filter((a) => a.title.toLowerCase().includes(lower));
  const exact = partial.filter((a) => a.title.toLowerCase() === lower);
  const pick = exact.length === 1 ? exact[0] : partial.length === 1 ? partial[0] : null;
  if (pick) return { ok: true, activityId: pick.activityId, title: pick.title };
  return partial.length === 0
    ? { ok: false, message: `No activity matching "${ref.activityTitle}" in this unit.` }
    : {
        ok: false,
        message: `"${ref.activityTitle}" matches ${partial.map((a) => a.title).join(", ")}. Use the exact title.`,
      };
}

export type ClassPlanConfirmScope = {
  surface: "app" | "slack";
  slackChannelId?: string;
  slackThreadTs?: string;
  turn: number;
};

type GroupRef = { id: Id<"scholarGroups">; name: string; memberIds: Id<"users">[] };

export async function makeClassPlanTools(
  ctx: ActionCtx,
  emit: AideEmit,
  opts: {
    callerUserId: Id<"users">;
    linkBase?: string;
    allowedScholarIds?: ReadonlySet<Id<"users">>;
    institutionScope?: string;
    currentUnit?: { id: Id<"units">; title: string } | null;
    /**
     * Who is asking, where, and which turn this is, set by the surface (the
     * in-app aide or Slack), never by the model. The two write tools exist
     * only with it: their confirmation is checked against a later turn, and a
     * surface without turns (the MCP connector) gets the read tool alone.
     */
    confirmScope?: ClassPlanConfirmScope;
  },
) {
  const { callerUserId, linkBase = "", allowedScholarIds, institutionScope, currentUnit, confirmScope } = opts;
  const { betaTool } = await import("@anthropic-ai/sdk/helpers/beta/json-schema");
  const resolveUnitTitle = makeUnitResolver(ctx, callerUserId, institutionScope);

  // The group, with the members a `give` to it reaches (the same lens-scoped
  // group read the give tool's groupName uses).
  const resolveGroup = async (
    groupName: string | undefined,
  ): Promise<{ ok: true; group: GroupRef } | { ok: false; message: string }> => {
    if (!groupName?.trim()) return { ok: false, message: "Name the group (groupName), e.g. 'the Geckos'." };
    const groups = await ctx.runQuery(internal.curriculumAssistant.listScholarGroupsInternal, {
      includeProgramGuests: true,
      ...(allowedScholarIds ? { allowedScholarIds: [...allowedScholarIds] } : {}),
    });
    const match = matchScholarByName(groupName, groups);
    if (match.kind === "ambiguous") {
      return {
        ok: false,
        message: `"${groupName}" matches ${match.candidates.map((c) => c.name).join(", ")}. Use the exact group name.`,
      };
    }
    if (match.kind === "none") {
      return { ok: false, message: `No scholar group found matching "${groupName}". Call list_scholar_groups.` };
    }
    const g = match.scholar;
    if (g.members.length === 0) {
      return { ok: false, message: `${g.name} has no members yet.` };
    }
    return {
      ok: true,
      group: { id: g.id, name: g.name, memberIds: g.members.map((m) => m.id as Id<"users">) },
    };
  };

  const resolveUnit = async (input: {
    unitId?: string;
    unitTitle?: string;
  }): Promise<{ ok: true; unitId: Id<"units"> } | { ok: false; message: string } | null> => {
    const id = input.unitId?.trim();
    const title = input.unitTitle?.trim();
    if (id && title) return { ok: false, message: "Provide unitId OR unitTitle, not both." };
    if (id) return { ok: true, unitId: id as Id<"units"> };
    if (title) {
      const r = await resolveUnitTitle(title);
      return r.ok ? { ok: true, unitId: r.unit.id } : { ok: false, message: r.error };
    }
    return null;
  };

  const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // Every call reports a result line, including a question or a refusal
  // returned early: an unreported call shows as "Failed: no result reported"
  // (aideStream createToolReportTracker) though the model got a usable answer.
  const reporting =
    <I,>(name: string, run: (input: I, report: AideEmit) => Promise<string>) =>
    async (input: I): Promise<string> => {
      let reported = false;
      const report: AideEmit = (data) => {
        if ((data as { toolComplete?: unknown }).toolComplete) reported = true;
        emit(data);
      };
      const out = await run(input, report);
      if (!reported) emit({ toolComplete: { name, result: earlyResultLabel(out) } });
      return out;
    };

  const unitHint = currentUnit
    ? ` The unit in scope is "${currentUnit.title}" (unitId ${currentUnit.id}).`
    : "";

  // ── get_class_days ────────────────────────────────────────────────────
  const getClassDaysTool = betaTool({
    name: "get_class_days",
    description:
      "Read a class's meetings over a range of days: each day the group's class in that subject meets, with its bell block and time, and the days it would have met but the school is closed. Add a unit to also see its activities in teaching order and, for each, whether this group already has it (live, planned for a day, or ended) — the activities with nothing are what's left. Use it before give_class_days or move_class_days, so a plan uses real meetings. Defaults to the next two weeks." +
      unitHint,
    inputSchema: {
      type: "object" as const,
      properties: {
        groupName: { type: "string" as const, description: "The scholar group, e.g. 'the Geckos'." },
        subject: { type: "string" as const, description: "The class's subject, e.g. 'Humanities'. A wrong one is answered with the group's classes." },
        fromDay: { type: "string" as const, description: "First day, YYYY-MM-DD (school-local). Default today." },
        throughDay: { type: "string" as const, description: "Last day, YYYY-MM-DD. Default 13 days after fromDay." },
        unitId: { type: "string" as const, description: "Optional: a unit to show progress for (from list_units)." },
        unitTitle: { type: "string" as const, description: "Optional: the unit's title, instead of unitId." },
      },
      required: ["groupName", "subject"] as const,
    },
    run: reporting("get_class_days", async (input: {
      groupName: string;
      subject: string;
      fromDay?: string;
      throughDay?: string;
      unitId?: string;
      unitTitle?: string;
    }, report) => {
      const g = await resolveGroup(input.groupName);
      if (!g.ok) return g.message;
      const unit = await resolveUnit(input);
      if (unit && !unit.ok) return unit.message;
      let res;
      try {
        res = await ctx.runQuery(internal.classPlans.aideClassDays, {
          callerUserId,
          groupId: g.group.id,
          subject: input.subject,
          fromDayKey: input.fromDay?.trim() || undefined,
          throughDayKey: input.throughDay?.trim() || undefined,
          unitId: unit?.unitId,
          scholarIds: g.group.memberIds,
          now: Date.now(),
        });
      } catch (e) {
        return `Could not read the class: ${errorText(e)}`;
      }
      if (!res.ok) return res.message;
      report({
        toolComplete: {
          name: "get_class_days",
          result: `${res.groupName} · ${res.subject}: ${res.meetings.length} meetings`,
        },
      });
      return JSON.stringify({
        class: `${res.groupName} · ${res.subject}`,
        today: res.todayDayKey,
        from: res.fromDayKey,
        through: res.throughDayKey,
        meetings: res.meetings.map((m) => ({
          day: m.dayKey,
          label: planDayLabel(m.dayKey),
          block: m.blockLabel,
          time: `${clock(m.startsAt, res.timeZone)}–${clock(m.endsAt, res.timeZone)}`,
          ...(m.started ? { started: true } : {}),
        })),
        closed: res.closed.map((c) => ({ day: c.dayKey, label: planDayLabel(c.dayKey), closure: c.label })),
        ...(res.unit
          ? {
              unit: {
                title: res.unit.unitTitle,
                assignmentId: res.unit.assignmentId,
                activities: res.unit.activities.map((a) => ({
                  activityId: a.activityId,
                  title: a.title,
                  lesson: a.lessonTitle,
                  given: a.given
                    ? `${a.given.state}${a.given.dayKey ? ` ${planDayLabel(a.given.dayKey)}` : ""}`
                    : null,
                })),
                notYetGiven: res.unit.activities.filter((a) => !a.given).length,
              },
            }
          : {}),
      });
    }),
  });

  if (!confirmScope) return [getClassDaysTool];
  const scope = { callerUserId, ...confirmScope };

  /** A refusal from the server, in words for the aide. */
  const notDone = (e: unknown, nothing: string) => {
    const message = errorText(e);
    const at = message.indexOf(PLAN_CONFIRMATION_REFUSED);
    return at >= 0
      ? `Not done. ${message.slice(at + PLAN_CONFIRMATION_REFUSED.length).trim()}`
      : `${nothing} ${message.replace(/^[\s\S]*Uncaught Error: /, "").split("\n")[0]}`;
  };

  const confirmText =
    "Confirmation is checked by the server: call this first WITHOUT confirmed, which writes nothing, stores the plan and returns it. Tell the teacher the plan in a few lines, then END YOUR TURN and wait for their reply. Only after they say yes in a new message, call again with confirmed:true and the same arguments: the server then carries out exactly the stored plan, all of it or none. It refuses a confirmation in the same turn, from anyone else or another thread, after 15 minutes, a second time, with different arguments, or when the class's schedule changed since the plan was shown.";

  // ── give_class_days ───────────────────────────────────────────────────
  type GiveDaysInput = {
    groupName: string;
    subject: string;
    unitId?: string;
    unitTitle?: string;
    gives: Array<ActivityRef & { day: string; block?: string; finish?: string; stack?: boolean }>;
    finish?: string;
    confirmed?: boolean;
    confirmationId?: string;
  };

  const giveClassDaysTool = betaTool({
    name: "give_class_days",
    description:
      "Plan part of a unit across a class's days: give several of its activities to a group, each at the start of that group's class on a day you name (\"put the rest of Mapping Our Islands on Humanities through next week, one a day, skipping Wednesday\"). Each give is linked to that class meeting. First read the meetings and what's left with get_class_days, then lay the activities out over the meetings the teacher wants, one per meeting. Every give needs when they should finish it: one `finish` for all, or per give; never guess it. The plan flags any problem: no class that day, school closed, already started, two meetings that day without a block, or a meeting that already holds work from this unit (only put two things in one meeting when the teacher asks: stack). An activity the group already has is flagged; leave it out unless the teacher asks for it again. The gives go to the group's own assignment for the unit, or a new one; the plan says which. For one activity, or for now, use give. " +
      confirmText +
      unitHint,
    inputSchema: {
      type: "object" as const,
      properties: {
        groupName: { type: "string" as const, description: "The scholar group." },
        subject: { type: "string" as const, description: "The class's subject, e.g. 'Humanities'." },
        unitId: { type: "string" as const, description: "The unit (preferred when known). Or unitTitle." },
        unitTitle: { type: "string" as const, description: "The unit's title, instead of unitId." },
        gives: {
          type: "array" as const,
          description: "One entry per activity, in the order the teacher wants them.",
          items: {
            type: "object" as const,
            properties: {
              activityTitle: { type: "string" as const, description: "The activity, matched within the unit. Or activityId." },
              activityId: { type: "string" as const, description: "The activity's id (from get_class_days)." },
              day: { type: "string" as const, description: "The class meeting's day, YYYY-MM-DD (from get_class_days)." },
              block: { type: "string" as const, description: "Only when the class meets more than once that day: the meeting's bell block, as get_class_days names it." },
              finish: { type: "string" as const, description: "Optional: this give's own finish, overriding the shared one. Same values as `finish`." },
              stack: { type: "boolean" as const, description: "true only when the teacher asked for this to share its meeting with other work." },
            },
            required: ["day"] as const,
          },
        },
        finish: { type: "string" as const, description: `For every give without its own. ${FINISH_DESCRIPTION} 'endOfUnit' isn't accepted here: name the day.` },
        confirmed: {
          type: "boolean" as const,
          description: "true only after the teacher replied, in a new message, yes to the plan this tool returned. Omit to plan.",
        },
        confirmationId: { type: "string" as const, description: "Optional with confirmed: the confirmationId the plan returned, if you still have it." },
      },
      required: ["groupName", "subject", "gives"] as const,
    },
    run: reporting("give_class_days", async (input: GiveDaysInput, report) => {
      const g = await resolveGroup(input.groupName);
      if (!g.ok) return `${g.message} Nothing given.`;
      const unit = await resolveUnit(input);
      if (!unit) return "Say which unit (unitId or unitTitle). Nothing given.";
      if (!unit.ok) return `${unit.message} Nothing given.`;
      if (!Array.isArray(input.gives) || input.gives.length === 0) {
        return "List the gives (activity + day). Nothing given.";
      }
      if (input.gives.length > 40) return "At most 40 gives at a time. Nothing given.";
      const shared = parseFinishInput(input.finish);
      if (shared && "error" in shared) return shared.error;

      // The unit's activities, to match titles.
      let days;
      try {
        days = await ctx.runQuery(internal.classPlans.aideClassDays, {
          callerUserId,
          groupId: g.group.id,
          subject: input.subject,
          unitId: unit.unitId,
          scholarIds: g.group.memberIds,
          now: Date.now(),
        });
      } catch (e) {
        return `Could not read the class: ${errorText(e)}. Nothing given.`;
      }
      if (!days.ok) return `${days.message} Nothing given.`;
      const activities = (days.unit?.activities ?? []).map((a) => ({
        activityId: String(a.activityId),
        title: a.title,
      }));

      const items: Array<{
        activityId: Id<"activities">;
        dayKey: string;
        block?: string;
        finish: GiveFinish;
        stack?: boolean;
      }> = [];
      for (const give of input.gives) {
        const act = matchUnitActivity(give, activities);
        if (!act.ok) return `${act.message} Nothing given.`;
        const day = give.day?.trim() ?? "";
        if (!DAY_KEY.test(day)) return `"${give.day}" isn't a day (YYYY-MM-DD). Nothing given.`;
        const own = parseFinishInput(give.finish);
        if (own && "error" in own) return own.error;
        const finish = own ?? shared;
        if (!finish) return finishQuestion(null);
        items.push({
          activityId: act.activityId as Id<"activities">,
          dayKey: day,
          ...(give.block?.trim() ? { block: give.block.trim() } : {}),
          finish,
          ...(give.stack === true ? { stack: true } : {}),
        });
      }
      const payload = {
        groupId: g.group.id,
        subject: input.subject,
        unitId: unit.unitId,
        scholarIds: g.group.memberIds,
        items,
      };

      if (input.confirmed !== true) {
        let res;
        try {
          res = await ctx.runMutation(internal.classPlans.planClassGivesWrite, { scope, payload });
        } catch (e) {
          return notDone(e, "Could not plan it. Nothing given.");
        }
        const plan = res.plan;
        if (!plan.ok) return `${plan.message} Nothing given.`;
        const problems = plan.rows.filter((r) => r.problem).length;
        report({
          toolComplete: {
            name: "give_class_days",
            result: problems
              ? `Plan has ${problems} problem${problems === 1 ? "" : "s"} · nothing given`
              : `Planned ${plan.rows.length} gives · waiting for the teacher to confirm`,
          },
        });
        return JSON.stringify({
          plan: true,
          nothingGivenYet: true,
          class: `${plan.groupName} · ${plan.subject}`,
          unit: plan.unitTitle,
          assignment: planAssignmentLine(plan.groupName, plan.unitTitle, plan.assignmentId !== null, plan.sharedRunning, "will"),
          rows: plan.rows.map((r) => ({
            day: r.dayKey,
            label: planDayLabel(r.dayKey),
            activity: r.title,
            shows: r.meeting
              ? `${r.meeting.blockLabel ? `${r.meeting.blockLabel}, ` : ""}${clock(r.meeting.startsAt, plan.timeZone)}`
              : null,
            finish: finishLabel(r.finish),
            ...(r.stack ? { sharesMeeting: true } : {}),
            ...(r.alreadyGiven
              ? {
                  alreadyGiven: `${r.alreadyGiven.state}${r.alreadyGiven.dayKey ? ` ${planDayLabel(r.alreadyGiven.dayKey)}` : ""}; ${r.alreadyGiven.sameAssignment ? "giving it again moves that give" : "giving it again gives it a second time"}`,
                }
              : {}),
            ...(r.problem ? { problem: r.problem } : {}),
          })),
          ...(res.confirmationId ? { confirmationId: res.confirmationId } : {}),
          next: problems
            ? "Nothing can be confirmed yet. Fix the rows with a problem (ask the teacher if it isn't clear how), then plan again."
            : "Show the teacher this plan and end your turn. Only after they say yes in a new message, call give_class_days again with the same arguments and confirmed:true.",
        });
      }

      let res;
      try {
        res = await ctx.runMutation(internal.classPlans.commitClassGives, {
          scope,
          payload,
          ...(input.confirmationId?.trim() ? { confirmationId: input.confirmationId.trim() } : {}),
        });
      } catch (e) {
        return notDone(e, "Could not give the plan.");
      }
      const unlinked = res.given.filter((r) => !r.linkedToClass);
      report({
        toolComplete: {
          name: "give_class_days",
          result: `${res.given.length} gives planned for ${res.groupName} · ${res.subject}`,
        },
      });
      return JSON.stringify({
        ok: true,
        class: `${res.groupName} · ${res.subject}`,
        unit: res.unitTitle,
        assignmentId: res.assignmentId,
        assignment: planAssignmentLine(res.groupName, res.unitTitle, !res.created, res.created ? res.sharedRunning : null, "did"),
        url: withBase(linkBase, assignmentPath(res.assignmentId)),
        given: res.given.map((r) => ({
          day: r.dayKey,
          label: planDayLabel(r.dayKey),
          activity: r.title,
          shows: `${r.blockLabel ? `${r.blockLabel}, ` : ""}${clock(r.startsAt, res.timeZone)}`,
          finish: finishLabel(r.finish),
          ...(r.live ? { live: true } : {}),
        })),
        ...(unlinked.length
          ? {
              notLinkedToClass: unlinked.map((r) => r.title),
              note: "These were given but aren't linked to the class meeting (the schedule couldn't tell which class they belong to). Tell the teacher.",
            }
          : {}),
      });
    }),
  });

  // ── move_class_days ───────────────────────────────────────────────────
  type MoveInput = {
    groupName: string;
    subject: string;
    fromDay: string;
    throughDay?: string;
    byMeetings: number;
    stack?: boolean;
    confirmed?: boolean;
    confirmationId?: string;
  };

  const moveClassDaysTool = betaTool({
    name: "move_class_days",
    description:
      "Move a run of a class's planned gives, in class or homework, by whole class meetings: byMeetings:1 moves each to the class's next meeting (\"push everything back a day\"), -1 to the one before. It counts the class's own meetings (each period of a double period is one) and skips no-school days. In-class work ends with its new meeting; homework keeps its due date, and a move past it is a problem. Covers gives from fromDay through throughDay (default about two months on); work already live, given by another teacher, or open until a day stays put and is listed. A move onto a meeting that holds other work that isn't moving is a problem unless the teacher asked for both in one meeting (stack). " +
      confirmText,
    inputSchema: {
      type: "object" as const,
      properties: {
        groupName: { type: "string" as const, description: "The scholar group." },
        subject: { type: "string" as const, description: "The class's subject." },
        fromDay: { type: "string" as const, description: "First day whose gives move, YYYY-MM-DD." },
        throughDay: { type: "string" as const, description: "Last day whose gives move, YYYY-MM-DD. Default 59 days after fromDay." },
        byMeetings: { type: "number" as const, description: "Class meetings to move by: 1 = the next meeting, -1 = the one before." },
        stack: { type: "boolean" as const, description: "true only when the teacher asked for moved work to share a meeting with other work." },
        confirmed: { type: "boolean" as const, description: "true only after the teacher replied, in a new message, yes to the plan. Omit to plan." },
        confirmationId: { type: "string" as const, description: "Optional with confirmed: the confirmationId the plan returned." },
      },
      required: ["groupName", "subject", "fromDay", "byMeetings"] as const,
    },
    run: reporting("move_class_days", async (input: MoveInput, report) => {
      const g = await resolveGroup(input.groupName);
      if (!g.ok) return `${g.message} Nothing moved.`;
      const fromDayKey = input.fromDay?.trim() ?? "";
      if (!DAY_KEY.test(fromDayKey)) return "fromDay is YYYY-MM-DD. Nothing moved.";
      const payload = {
        groupId: g.group.id,
        subject: input.subject,
        fromDayKey,
        throughDayKey: input.throughDay?.trim() || shiftDayKey(fromDayKey, 59),
        byMeetings: input.byMeetings,
        ...(input.stack === true ? { stack: true } : {}),
      };
      const rowsOut = (
        rows: Array<{ title: string; fromDayKey: string; homework: boolean; to: { dayKey: string } | null; problem: string | null }>,
      ) =>
        rows.map((r) => ({
          activity: r.title,
          ...(r.homework ? { homework: true } : {}),
          from: planDayLabel(r.fromDayKey),
          to: r.to ? planDayLabel(r.to.dayKey) : null,
          ...(r.problem ? { problem: r.problem } : {}),
        }));
      const leftOut = (rows: Array<{ title: string; dayKey: string; reason: string }>) =>
        rows.map((r) => ({ activity: r.title, day: planDayLabel(r.dayKey), staysBecause: r.reason }));

      if (input.confirmed !== true) {
        let res;
        try {
          res = await ctx.runMutation(internal.classPlans.planClassMoveWrite, { scope, payload });
        } catch (e) {
          return notDone(e, "Could not plan the move. Nothing moved.");
        }
        const plan = res.plan;
        if (!plan.ok) return `${plan.message} Nothing moved.`;
        const problems = plan.rows.filter((r) => r.problem).length;
        report({
          toolComplete: {
            name: "move_class_days",
            result: problems
              ? `Move has ${problems} problem${problems === 1 ? "" : "s"} · nothing moved`
              : `Planned ${plan.rows.length} moves · waiting for the teacher to confirm`,
          },
        });
        return JSON.stringify({
          plan: true,
          nothingMovedYet: true,
          class: `${plan.groupName} · ${plan.subject}`,
          moves: rowsOut(plan.rows),
          staysPut: leftOut(plan.leftAlone),
          ...(res.confirmationId ? { confirmationId: res.confirmationId } : {}),
          next:
            plan.rows.length === 0
              ? "There are no planned gives to move in that range."
              : problems
                ? "Nothing can be confirmed yet. Tell the teacher the problems and ask how to handle them."
                : "Show the teacher these moves and end your turn. Only after they say yes in a new message, call move_class_days again with the same arguments and confirmed:true.",
        });
      }

      let res;
      try {
        res = await ctx.runMutation(internal.classPlans.commitClassMove, {
          scope,
          payload,
          ...(input.confirmationId?.trim() ? { confirmationId: input.confirmationId.trim() } : {}),
        });
      } catch (e) {
        return notDone(e, "Could not move them.");
      }
      report({
        toolComplete: {
          name: "move_class_days",
          result: `Moved ${res.moved.length} for ${res.groupName} · ${res.subject}`,
        },
      });
      return JSON.stringify({
        ok: true,
        class: `${res.groupName} · ${res.subject}`,
        moved: res.moved.map((m) => ({
          activity: m.title,
          from: planDayLabel(m.fromDayKey),
          to: planDayLabel(m.toDayKey),
          ...(m.linked ? {} : { note: "not linked to that class meeting" }),
        })),
        staysPut: leftOut(res.leftAlone),
      });
    }),
  });

  return [getClassDaysTool, giveClassDaysTool, moveClassDaysTool];
}
