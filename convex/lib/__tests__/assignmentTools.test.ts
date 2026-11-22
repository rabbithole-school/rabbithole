import { describe, expect, test, vi } from "vitest";
import type { ActionCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/api";
import { makeAssignmentTools } from "../assignmentTools";
import { ROLES } from "../roles";

/**
 * `makeAssignmentTools` is the ONE assignment-scheduling tool group, spread
 * into both aide assemblers (the global Curriculum Assistant and the unit
 * page's Curriculum Bot). Like its siblings it touches ctx only inside each
 * tool's run() closure, so we can assemble with a stub ctx and assert names.
 *
 * Two things are load-bearing here: the exact membership of the group (it was
 * extracted verbatim out of assembleCurriculumTools, so a drop or an addition
 * is a change to the global aide too) and the role gate — reading a roster and
 * editing the agenda is teacher/admin territory, never a curriculum_designer's.
 */
const ctx = {} as unknown as ActionCtx;
const emit = () => {};
const caller = "u_caller" as Id<"users">;

const ASSIGNMENT_TOOLS = [
  "give",
  // Read-only class-day planning tool. give_class_days / move_class_days are
  // offered only on surfaces that carry a confirmation scope (none here).
  "get_class_days",
  "publish_unit",
  "list_assignments",
  "get_schedule",
  "get_assignment",
  "get_assignment_progress",
  "get_granule_coverage",
  "reschedule_activity",
  "clear_activity",
  "set_assignment_scholars",
  "add_assignment_scholars",
  "remove_assignment_scholars",
  "archive_assignment",
  "add_activity_resource",
];

const build = async (
  role: Parameters<typeof makeAssignmentTools>[2]["role"],
  currentUnit?: { id: Id<"units">; title: string } | null,
) =>
  await makeAssignmentTools(ctx, emit, {
    role,
    callerUserId: caller,
    currentUnit,
  });

const names = async (role: Parameters<typeof makeAssignmentTools>[2]["role"]) =>
  (await build(role)).map((t) => t.name);

describe("makeAssignmentTools role gating", () => {
  test("teacher gets the whole assignment group, in order", async () => {
    expect(await names(ROLES.TEACHER)).toEqual(ASSIGNMENT_TOOLS);
  });

  test("platform admin gets the same group", async () => {
    expect(await names(ROLES.PLATFORM_ADMIN)).toEqual(ASSIGNMENT_TOOLS);
  });

  test("curriculum_designer, base staff (operations), scholar, and no role get NOTHING", async () => {
    for (const role of [
      ROLES.CURRICULUM_DESIGNER,
      ROLES.STAFF,
      ROLES.SCHOLAR,
      null,
      undefined,
    ] as const) {
      expect(await names(role)).toEqual([]);
    }
  });
});

describe("makeAssignmentTools currentUnit hint", () => {
  // `description` isn't on every arm of the heterogeneous betaTool union
  // (the Anthropic-hosted tools have no description), so narrow to the shape
  // every tool in THIS group actually has.
  const describeOf = (
    tools: Awaited<ReturnType<typeof build>>,
    name: string,
  ) =>
    (tools.find((t) => t.name === name)! as unknown as { description?: string })
      .description ?? "";

  test("names the open unit by the unitId give accepts", async () => {
    const tools = await build(ROLES.TEACHER, {
      id: "unit_7" as Id<"units">,
      title: "Tide Pool Ecosystems",
    });
    const give = describeOf(tools, "give");
    expect(give).toContain(
      'The unit currently in scope is "Tide Pool Ecosystems"',
    );
    expect(give).toContain("unitId unit_7");
    expect(give).toContain("pass that unitId");

    // Nothing else in the group changes shape because a unit is open.
    expect(describeOf(tools, "list_assignments")).not.toContain("currently in scope");
  });

  test("says nothing about a current unit on the global (unit-less) aide", async () => {
    const tools = await build(ROLES.TEACHER);
    expect(describeOf(tools, "give")).not.toContain("currently in scope");
  });
});

describe("makeAssignmentTools scholar lens", () => {
  test("passes the allowed scholar ids into group resolution", async () => {
    const allowed = new Set(["scholar_in_lens" as Id<"users">]);
    const runQuery = vi.fn().mockResolvedValue([]);
    const tools = await makeAssignmentTools(
      { runQuery, runMutation: vi.fn() } as unknown as ActionCtx,
      emit,
      {
        role: ROLES.TEACHER,
        callerUserId: caller,
        allowedScholarIds: allowed,
      },
    );
    const give = tools.find((tool) => tool.name === "give")! as unknown as {
      run: (input: Record<string, unknown>) => Promise<string>;
    };

    await give.run({ unitTitle: "Robots", groupName: "Robotics" });

    expect(runQuery).toHaveBeenCalledWith(
      internal.curriculumAssistant.listScholarGroupsInternal,
      { includeProgramGuests: true, allowedScholarIds: ["scholar_in_lens"] },
    );
  });
});

describe("give finish", () => {
  test("rejects a malformed finish before resolving data", async () => {
    const runQuery = vi.fn();
    const runMutation = vi.fn();
    const tools = await makeAssignmentTools(
      { runQuery, runMutation } as unknown as ActionCtx,
      emit,
      { role: ROLES.TEACHER, callerUserId: caller },
    );
    const tool = tools.find((t) => t.name === "give")! as unknown as {
      run: (input: {
        unitTitle: string;
        activityTitle: string;
        startsNow?: boolean;
        finish?: string;
      }) => Promise<string>;
    };

    const result = await tool.run({
      unitTitle: "Tide Pool Ecosystems",
      activityTitle: "Observe a Tide Pool",
      startsNow: true,
      finish: "next week sometime",
    });
    expect(result.startsWith('finish "next week sometime"')).toBe(true);
    expect(runQuery).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
  });
});
