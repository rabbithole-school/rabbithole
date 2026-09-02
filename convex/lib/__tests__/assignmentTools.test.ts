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
  "assign_unit",
  "assign_activity_now",
  "list_assignments",
  "get_schedule",
  "get_assignment",
  "get_assignment_progress",
  "get_granule_coverage",
  "schedule_activity",
  "reschedule_activity",
  "clear_activity",
  "push_activity_now",
  "set_assignment_scholars",
  "add_assignment_scholars",
  "archive_assignment",
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

  test("names the open unit using the identifier each assign tool accepts", async () => {
    const tools = await build(ROLES.TEACHER, {
      id: "unit_7" as Id<"units">,
      title: "Tide Pool Ecosystems",
    });
    const assignUnit = describeOf(tools, "assign_unit");
    expect(assignUnit).toContain(
      'The unit currently in scope is "Tide Pool Ecosystems"',
    );
    expect(assignUnit).toContain("unitId unit_7");
    expect(assignUnit).toContain("pass that unitId");

    const assignActivity = describeOf(tools, "assign_activity_now");
    expect(assignActivity).toContain(
      'The unit currently in scope is "Tide Pool Ecosystems"',
    );
    expect(assignActivity).toContain('pass unitTitle "Tide Pool Ecosystems"');
    expect(assignActivity).not.toContain("unitId unit_7");

    // Nothing else in the group changes shape because a unit is open.
    expect(describeOf(tools, "list_assignments")).not.toContain("currently in scope");
  });

  test("says nothing about a current unit on the global (unit-less) aide", async () => {
    const tools = await build(ROLES.TEACHER);
    for (const name of ["assign_unit", "assign_activity_now"]) {
      expect(describeOf(tools, name)).not.toContain("currently in scope");
    }
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
    const assign = tools.find((tool) => tool.name === "assign_unit")! as unknown as {
      run: (input: Record<string, unknown>) => Promise<string>;
    };

    await assign.run({ groupName: "Robotics" });

    expect(runQuery).toHaveBeenCalledWith(
      internal.curriculumAssistant.listScholarGroupsInternal,
      { includeProgramGuests: true, allowedScholarIds: ["scholar_in_lens"] },
    );
  });
});

describe("assign_activity_now timing fields", () => {
  test.each([
    {
      mode: "classFocus" as const,
      timing: { dueAtMs: 1_800_000_000_000 },
      expected: "dueAtMs is only valid for homework mode",
    },
    {
      mode: "homework" as const,
      timing: { endsAtMs: 1_800_000_000_000 },
      expected: "endsAtMs is only valid for classFocus mode",
    },
  ])("rejects incompatible timing for $mode before resolving data", async ({
    mode,
    timing,
    expected,
  }) => {
    const runQuery = vi.fn();
    const runMutation = vi.fn();
    const tools = await makeAssignmentTools(
      { runQuery, runMutation } as unknown as ActionCtx,
      emit,
      { role: ROLES.TEACHER, callerUserId: caller },
    );
    const tool = tools.find((t) => t.name === "assign_activity_now")! as unknown as {
      run: (input: {
        unitTitle: string;
        activityTitle: string;
        mode: "classFocus" | "homework";
        endsAtMs?: number;
        dueAtMs?: number;
      }) => Promise<string>;
    };

    await expect(
      tool.run({
        unitTitle: "Tide Pool Ecosystems",
        activityTitle: "Observe a Tide Pool",
        mode,
        ...timing,
      }),
    ).resolves.toContain(expected);
    expect(runQuery).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
  });
});
