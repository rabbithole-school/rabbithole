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
// a unit open, the assign tools state its id/title so "this unit" resolves
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
import {
  withBase,
  unitPath,
  assignmentPath,
  sessionPath,
  hstLabel,
} from "./channels";
import type { AideEmit } from "./aideStream";

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
  },
) {
  // Reads the roster + edits the agenda, so teacher/admin only — the same
  // gate assembleCurriculumTools applied when these lived inline.
  if (!isTeacherRole(opts.role)) return [];

  const {
    callerUserId,
    linkBase = "",
    currentUnit,
    allowedScholarIds,
  } = opts;

  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );

  // Shared strict unit resolver (lib/aideResolvers.ts) — the SAME
  // implementation the curriculum tools use, so "Elements of Culture" resolves
  // identically whichever surface the teacher is standing on.
  const resolveUnitStrict = makeUnitResolver(ctx);

  // When a unit is already in scope, tell each assign tool which identifier its
  // own schema accepts so "this unit" needs no lookup or invalid retry.
  const currentUnitIdHint = currentUnit
    ? ` The unit currently in scope is "${currentUnit.title}" (unitId ${currentUnit.id}); when the teacher says "this unit", pass that unitId.`
    : "";
  const currentUnitTitleHint = currentUnit
    ? ` The unit currently in scope is "${currentUnit.title}"; when the teacher says "this unit", pass unitTitle "${currentUnit.title}".`
    : "";

  // Batch name → id resolution for the roster-edit tools. Returns the
  // resolved ids, names that didn't match, and names that matched MULTIPLE
  // scholars (a collision). The roster write tools refuse on ANY unresolved
  // OR ambiguous name rather than silently dropping or mis-matching one — a
  // roster op that quietly omits or swaps a child is worse than one that
  // fails. Uses the STRICT matcher (exact full-name wins, partial only when
  // unambiguous), not the read-path first-substring-wins resolver, because a
  // wrong match here puts the wrong child into/out of a cohort.
  const resolveScholars = async (
    names: string[],
  ): Promise<{
    ids: Id<"users">[];
    unresolved: string[];
    ambiguous: { name: string; candidates: string[] }[];
  }> => {
    // Naming is the opt-in: an explicitly named scholar must resolve even if
    // they're Extended Education (lib/scholarParticipationTooling.ts).
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
    const unresolved: string[] = [];
    const ambiguous: { name: string; candidates: string[] }[] = [];
    for (const name of names) {
      const m = matchScholarByName(name, scholars);
      if (m.kind === "match") ids.push(m.scholar.id as Id<"users">);
      else if (m.kind === "ambiguous")
        ambiguous.push({ name, candidates: m.candidates.map((c) => c.name) });
      else unresolved.push(name);
    }
    return { ids, unresolved, ambiguous };
  };

  // Helper: resolve scholar group name → row. Uses the SAME strict matcher as
  // the scholar-name path (matchScholarByName): prefer an exact case-insensitive
  // name match, and refuse (ambiguous) when a partial matches multiple groups —
  // a loose first-substring-wins match would silently assign the unit to the
  // wrong cohort (e.g. "Seals" resolving to "Navy Seals"). Matched groups carry
  // their already-resolved member list (active scholars only — dropped ids
  // omitted, matching the ScholarPicker behaviour).
  const resolveGroup = async (groupName: string) => {
    // Naming the group is the opt-in: its roster is factual membership, so
    // Extended Education members stay in (lib/scholarParticipationTooling.ts).
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
  };

  // Shared cohort resolver for the assignment tools: takes the SAME
  // groupName-XOR-scholarNames shape and returns either the resolved roster or
  // a ready-to-return error message. Extracted so assign_unit and
  // assign_activity_now resolve scholars identically (strict matching, empty-
  // group / unresolved / ambiguous refusal) instead of duplicating the logic.
  const resolveCohort = async (input: {
    groupName?: string;
    scholarNames?: string[];
  }): Promise<
    { ok: true; ids: Id<"users">[] } | { ok: false; message: string }
  > => {
    const hasGroup = input.groupName != null && input.groupName.trim() !== "";
    const hasNames =
      Array.isArray(input.scholarNames) && input.scholarNames.length > 0;
    if (hasGroup && hasNames) {
      return { ok: false, message: "Provide groupName OR scholarNames, not both." };
    }
    if (!hasGroup && !hasNames) {
      return {
        ok: false,
        message:
          "Provide either a groupName (scholar group) or scholarNames (individual scholars).",
      };
    }
    if (hasGroup) {
      const match = await resolveGroup(input.groupName!);
      if (match.kind === "ambiguous") {
        return {
          ok: false,
          message: `Ambiguous group name "${input.groupName}" matches ${match.candidates
            .map((c) => c.name)
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
      return { ok: true, ids: group.members.map((m) => m.id as Id<"users">) };
    }
    const { ids, unresolved, ambiguous } = await resolveScholars(
      input.scholarNames!,
    );
    if (ambiguous.length > 0) {
      const detail = ambiguous
        .map((a) => `"${a.name}" matches ${a.candidates.join(", ")}`)
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
      return { ok: false, message: "No scholars given — refusing to create an empty cohort." };
    }
    return { ok: true, ids };
  };

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

  const assignUnitTool = betaTool({
    name: "assign_unit",
    description:
      "Create (or reuse) a cohort × unit assignment in ONE step. Identify the unit by EITHER unitId (preferred when you already know it — from list_units or create_unit — it bypasses title matching entirely) OR unitTitle (resolved strictly: an exact title wins, a unique partial wins, and an ambiguous partial is refused with the candidate titles so you can retry with the exact one). Provide exactly one of unitId / unitTitle. Specify the scholars either by group name (groupName — resolves the named scholar group directly, no extra round-trip needed) or by individual names (scholarNames). Plans the whole unit on startsAtMs without pushing anything live — the teacher still paces individual activities with the existing schedule/push tools. Re-running the same unit + exact roster reuses the existing active assignment instead of creating a duplicate." +
      currentUnitIdHint,
    inputSchema: {
      type: "object" as const,
      properties: {
        unitId: {
          type: "string" as const,
          description:
            "The unit's Convex ID (from list_units, get_unit_details, or a create_unit result). PREFERRED when known — bypasses title resolution. Provide exactly one of unitId or unitTitle.",
        },
        unitTitle: {
          type: "string" as const,
          description:
            "The unit's title, matched strictly (exact preferred; a unique partial is accepted; an ambiguous partial is refused with candidates). Provide exactly one of unitId or unitTitle.",
        },
        groupName: {
          type: "string" as const,
          description:
            "Name of a scholar group (case-insensitive partial match). Use this when the teacher refers to a group by name (e.g. 'the Geckos', 'Seals'). Mutually exclusive with scholarNames.",
        },
        scholarNames: {
          type: "array" as const,
          items: { type: "string" as const },
          description:
            "Individual scholar names to include. Use this when targeting specific scholars by name rather than a named group. Mutually exclusive with groupName.",
        },
        title: {
          type: "string" as const,
          description: "Optional assignment title override.",
        },
        startsAtMs: {
          type: "number" as const,
          description: "When to plan it on the agenda (epoch ms). Defaults to now.",
        },
      },
      required: [] as const,
    },
    run: async (input: {
      unitId?: string;
      unitTitle?: string;
      groupName?: string;
      scholarNames?: string[];
      title?: string;
      startsAtMs?: number;
    }) => {
      const cohort = await resolveCohort(input);
      if (!cohort.ok) return cohort.message;

      // Resolve the unit: exactly one of unitId (bypasses matching) or
      // unitTitle (strict resolver — refuses ambiguity with the candidates).
      const hasUnitId = input.unitId != null && input.unitId.trim() !== "";
      const hasUnitTitle =
        input.unitTitle != null && input.unitTitle.trim() !== "";
      if (hasUnitId && hasUnitTitle) {
        return "Provide unitId OR unitTitle, not both.";
      }
      if (!hasUnitId && !hasUnitTitle) {
        return "Provide either a unitId (preferred, from list_units) or a unitTitle.";
      }
      let unit: { id: Id<"units">; title: string };
      if (hasUnitId) {
        const details = await ctx.runQuery(
          internal.curriculumAssistant.getUnitDetails,
          { unitId: input.unitId as Id<"units"> },
        );
        if (!details) {
          return `No unit found with id "${input.unitId}". Call list_units to get a valid unitId or title.`;
        }
        unit = { id: input.unitId as Id<"units">, title: details.title };
      } else {
        const r = await resolveUnitStrict(input.unitTitle!);
        if (!r.ok) return r.error;
        unit = r.unit;
      }

      const ids = cohort.ids;
      try {
        const res = await ctx.runMutation(internal.assignments.aideAssignWork, {
          callerUserId,
          unitId: unit.id as Id<"units">,
          scholarIds: ids,
          title: input.title,
          startsAt: input.startsAtMs ?? Date.now(),
          target: { kind: "unit" },
        });
        emit({
          toolComplete: {
            name: "assign_unit",
            result: `${res.created ? "Created" : "Reused"} ${unit.title} for ${ids.length} scholar${ids.length === 1 ? "" : "s"}`,
          },
        });
        return JSON.stringify({
          assignmentId: res.assignmentId,
          created: res.created,
          deduped: !res.created,
          unitTitle: unit.title,
          rosterSize: ids.length,
          url: withBase(linkBase, assignmentPath(res.assignmentId)),
        });
      } catch (e) {
        return `Could not assign unit: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  });

  const assignActivityNowTool = betaTool({
    name: "assign_activity_now",
    description:
      "Assign ONE activity to scholars and start it LIVE right now — it appears for the resolved scholars immediately (no scheduling, no separate push step). Use this when the teacher wants a specific activity in front of scholars NOW (\"put the Tide Pool activity up for the Geckos\", \"give Kai the fractions warm-up now\"). Resolves the unit by title, the activity by title WITHIN that unit, and the scholars by groupName OR scholarNames — exactly like assign_unit. It creates (or reuses) the cohort assignment for EXACTLY those scholars, then pushes the activity live in one call. `mode` classFocus = in-the-room focus (optional endsAtMs auto-clears it then); homework = on their plate (optional dueAtMs). Times are epoch-ms (Hawaii time). Because this makes work appear for scholars instantly, CONFIRM the unit, activity, roster, and mode with the teacher before calling. Note: it targets exactly the scholars you name — a named subset becomes its OWN right-sized assignment, so this cannot push to only part of a pre-existing larger cohort; to push to a subset of an EXISTING assignment, use push_activity_now on that assignment instead." +
      currentUnitTitleHint,
    inputSchema: {
      type: "object" as const,
      properties: {
        unitTitle: {
          type: "string" as const,
          description: "The unit's title (case-insensitive partial match).",
        },
        activityTitle: {
          type: "string" as const,
          description:
            "The activity's title, matched within the resolved unit (case-insensitive; exact title preferred).",
        },
        groupName: {
          type: "string" as const,
          description:
            "Name of a scholar group (case-insensitive partial match). Use when the teacher names a group (e.g. 'the Geckos'). Mutually exclusive with scholarNames.",
        },
        scholarNames: {
          type: "array" as const,
          items: { type: "string" as const },
          description:
            "Individual scholar names to include. Use when targeting specific scholars by name. Mutually exclusive with groupName.",
        },
        mode: {
          type: "string" as const,
          enum: ["classFocus", "homework"],
          description:
            "classFocus = in-the-room focus (optionally auto-clears at endsAtMs); homework = on their plate (optionally due at dueAtMs).",
        },
        endsAtMs: {
          type: "number" as const,
          description: "classFocus only: auto-clear time (epoch ms).",
        },
        dueAtMs: {
          type: "number" as const,
          description: "homework only: due date (epoch ms).",
        },
      },
      required: ["unitTitle", "activityTitle", "mode"] as const,
    },
    run: async (input: {
      unitTitle: string;
      activityTitle: string;
      groupName?: string;
      scholarNames?: string[];
      mode: "classFocus" | "homework";
      endsAtMs?: number;
      dueAtMs?: number;
    }) => {
      if (input.mode === "classFocus" && input.dueAtMs !== undefined) {
        return "dueAtMs is only valid for homework mode; no assignment created.";
      }
      if (input.mode === "homework" && input.endsAtMs !== undefined) {
        return "endsAtMs is only valid for classFocus mode; no assignment created.";
      }

      const cohort = await resolveCohort(input);
      if (!cohort.ok) return cohort.message;

      const r = await resolveUnitStrict(input.unitTitle);
      if (!r.ok) return r.error;
      const unit = r.unit;

      const activity = await resolveActivityInUnit(
        unit.id as Id<"units">,
        input.activityTitle,
      );
      if (!activity.ok) return activity.message;

      // Create/reuse the cohort assignment (planning this one activity), then
      // stamp it live now. Two existing internal mutations, composed — no new
      // backend surface. The two steps fail SEPARATELY: a push failure after
      // the assignment committed is a partial result the model must relay
      // accurately (the work exists, planned, not live), never "nothing
      // happened".
      let res: { assignmentId: Id<"assignments">; created: boolean };
      try {
        res = await ctx.runMutation(internal.assignments.aideAssignWork, {
          callerUserId,
          unitId: unit.id as Id<"units">,
          scholarIds: cohort.ids,
          startsAt: Date.now(),
          target: {
            kind: "activity",
            activityId: activity.activityId,
            mode: input.mode,
            endsAt: input.endsAtMs,
            dueAt: input.dueAtMs,
          },
        });
      } catch (e) {
        return `Could not assign activity: ${e instanceof Error ? e.message : String(e)}`;
      }
      try {
        await ctx.runMutation(internal.assignments.aidePushActivityNow, {
          callerUserId,
          assignmentId: res.assignmentId,
          activityId: activity.activityId,
          mode: input.mode,
          endsAt: input.endsAtMs,
          dueAt: input.dueAtMs,
        });
        emit({
          toolComplete: {
            name: "assign_activity_now",
            result: `${activity.title} live (${input.mode}) for ${cohort.ids.length} scholar${cohort.ids.length === 1 ? "" : "s"}`,
          },
        });
        return JSON.stringify({
          ok: true,
          live: true,
          mode: input.mode,
          assignmentId: res.assignmentId,
          created: res.created,
          unitTitle: unit.title,
          activityTitle: activity.title,
          rosterSize: cohort.ids.length,
          url: withBase(linkBase, assignmentPath(res.assignmentId)),
        });
      } catch (e) {
        return `PARTIAL: the assignment was created (${
          res.created ? "new" : "reused"
        }, ${assignmentPath(res.assignmentId)}) with "${activity.title}" PLANNED, but the live push failed: ${
          e instanceof Error ? e.message : String(e)
        }. Scholars do NOT see it yet — retry with push_activity_now on that assignment, and tell the teacher exactly this state.`;
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
      "Read scheduled activities across ALL the teacher's assignments, flattened to one item per (assignment, activity) push. Each item has an `agendaAtMs` (epoch ms, its position on the agenda) plus a human `whenLabel` in Hawaii time, its `state` (planned | live | done), `mode`, and the assignment/unit/activity it belongs to. This is the read to use before a bulk reschedule. Optionally window by `fromMs`/`toMs` (epoch ms, matched against agendaAtMs).",
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
      const enriched = items.map((it) => ({
        ...it,
        agendaAtMs: it.agendaAt,
        whenLabel: hstLabel(it.agendaAt),
        startsAtLabel: hstLabel(it.startsAt),
        dueAtLabel: hstLabel(it.dueAt),
      }));
      emit({ toolComplete: { name: "get_schedule", result: `${enriched.length} scheduled items` } });
      return JSON.stringify(enriched);
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
      return JSON.stringify({
        ...data,
        url: withBase(linkBase, assignmentPath(data.assignmentId)),
        // A standing (unitId-less) assignment has no unit page to link to.
        unitUrl: data.unitId ? withBase(linkBase, unitPath(data.unitId)) : null,
        schedule: data.schedule.map((e) => ({
          ...e,
          startsAtLabel: hstLabel(e.startsAt),
          dueAtLabel: hstLabel(e.dueAt),
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

  const scheduleActivityTool = betaTool({
    name: "schedule_activity",
    description:
      "Plan an activity push for an assignment's cohort at a future time. Adds a PLANNED entry to the agenda (it auto-goes-live at startsAtMs; a past startsAtMs stays planned until the teacher hits Start now). `mode` is classFocus (in-room) or homework. All scholars on the assignment's roster get it — there is no scholar arg. Times are epoch-ms (Hawaii time). Use get_assignment to find the activityId.",
    inputSchema: {
      type: "object" as const,
      properties: {
        assignmentId: { type: "string" as const },
        activityId: { type: "string" as const },
        mode: { type: "string" as const, enum: ["classFocus", "homework"] },
        startsAtMs: { type: "number" as const, description: "When it goes live (epoch ms)." },
        endsAtMs: { type: "number" as const, description: "classFocus only: auto-clear time (epoch ms)." },
        dueAtMs: { type: "number" as const, description: "homework only: due date (epoch ms)." },
      },
      required: ["assignmentId", "activityId", "mode", "startsAtMs"] as const,
    },
    run: async (input: {
      assignmentId: string;
      activityId: string;
      mode: "classFocus" | "homework";
      startsAtMs: number;
      endsAtMs?: number;
      dueAtMs?: number;
    }) => {
      try {
        await ctx.runMutation(internal.assignments.aideScheduleActivity, {
          callerUserId,
          assignmentId: input.assignmentId as Id<"assignments">,
          activityId: input.activityId as Id<"activities">,
          mode: input.mode,
          startsAt: input.startsAtMs,
          endsAt: input.endsAtMs,
          dueAt: input.dueAtMs,
        });
      } catch (e) {
        return `Could not schedule: ${e instanceof Error ? e.message : String(e)}`;
      }
      emit({ toolComplete: { name: "schedule_activity", result: `Scheduled for ${hstLabel(input.startsAtMs)}` } });
      return JSON.stringify({ ok: true, startsAtLabel: hstLabel(input.startsAtMs) });
    },
  });

  const rescheduleActivityTool = betaTool({
    name: "reschedule_activity",
    description:
      "Move an already-scheduled activity to a new time (epoch ms, Hawaii time). For a PLANNED item this moves when it goes live; for a LIVE item it only moves its agenda position (it does not un-push). To bulk-shift a week, call get_schedule, then call this once per item with startsAtMs + (days * 86400000). Identify the item by its assignmentId + activityId.",
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
      emit({ toolComplete: { name: "reschedule_activity", result: `Moved to ${hstLabel(input.startsAtMs)}` } });
      return JSON.stringify({ ok: true, startsAtLabel: hstLabel(input.startsAtMs) });
    },
  });

  const clearActivityTool = betaTool({
    name: "clear_activity",
    description:
      "Remove an activity from an assignment's schedule (un-plans a planned push, or clears a live one). Identify by assignmentId + activityId.",
    inputSchema: {
      type: "object" as const,
      properties: {
        assignmentId: { type: "string" as const },
        activityId: { type: "string" as const },
      },
      required: ["assignmentId", "activityId"] as const,
    },
    run: async (input: { assignmentId: string; activityId: string }) => {
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
      return JSON.stringify({
        ...data,
        roster: data.roster.map((r) => ({
          ...r,
          lastActiveLabel: hstLabel(r.lastMessageAt),
          // Deep link to the scholar's session under this assignment, opened
          // as that scholar for staff (?remote=). Null until they start.
          sessionUrl: r.sessionId
            ? withBase(linkBase, sessionPath(r.sessionId, r.scholarId))
            : null,
        })),
      });
    },
  });

  const pushActivityNowTool = betaTool({
    name: "push_activity_now",
    description:
      "Start an activity LIVE right now (push-now / set focus) for the assignment's whole cohort — it becomes visible to every scholar on the roster immediately. This is the difference from `schedule_activity`, which only PLANS a future push: use push_activity_now when the teacher wants the class working on something NOW (\"put the Tide Pool activity up\", \"set focus to the Weekend News write-up\"). `mode` classFocus = in-the-room focus (optional `endsAtMs` auto-clears it then); homework = on their plate (optional `dueAtMs`). Get the activityId from get_assignment. Confirm before pushing.",
    inputSchema: {
      type: "object" as const,
      properties: {
        assignmentId: { type: "string" as const },
        activityId: { type: "string" as const },
        mode: { type: "string" as const, enum: ["classFocus", "homework"] },
        endsAtMs: { type: "number" as const, description: "classFocus only: auto-clear time (epoch ms)." },
        dueAtMs: { type: "number" as const, description: "homework only: due date (epoch ms)." },
      },
      required: ["assignmentId", "activityId", "mode"] as const,
    },
    run: async (input: {
      assignmentId: string;
      activityId: string;
      mode: "classFocus" | "homework";
      endsAtMs?: number;
      dueAtMs?: number;
    }) => {
      try {
        await ctx.runMutation(internal.assignments.aidePushActivityNow, {
          callerUserId,
          assignmentId: input.assignmentId as Id<"assignments">,
          activityId: input.activityId as Id<"activities">,
          mode: input.mode,
          endsAt: input.endsAtMs,
          dueAt: input.dueAtMs,
        });
      } catch (e) {
        return `Could not push: ${e instanceof Error ? e.message : String(e)}`;
      }
      emit({ toolComplete: { name: "push_activity_now", result: `Pushed live (${input.mode})` } });
      return JSON.stringify({ ok: true, live: true, mode: input.mode });
    },
  });

  const setAssignmentScholarsTool = betaTool({
    name: "set_assignment_scholars",
    description:
      "REPLACE an assignment's roster with exactly the named scholars — anyone not listed is removed from the cohort, anyone listed is added. To only ADD without removing, use add_assignment_scholars instead. Pass scholar names (resolved case-insensitively); resolve a group's members with list_scholar_groups first if the teacher names a group. Confirm the resolved names with the teacher before changing a roster.",
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

  return [
    assignUnitTool,
    // One-call live delivery of a single activity (assign + push now).
    assignActivityNowTool,
    listAssignmentsTool,
    getScheduleTool,
    getAssignmentTool,
    getAssignmentProgressTool,
    granuleCoverageTool,
    scheduleActivityTool,
    rescheduleActivityTool,
    clearActivityTool,
    pushActivityNowTool,
    // Roster + lifecycle — same cohort, same owner gate.
    setAssignmentScholarsTool,
    addAssignmentScholarsTool,
    archiveAssignmentTool,
  ];
}
