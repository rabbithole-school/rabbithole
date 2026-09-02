import { describe, expect, test, vi } from "vitest";
import { internal } from "../../_generated/api";
import type { ActionCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { assembleUnitDesignerTools } from "../unitDesignerTools";
import { ROLES } from "../roles";

/**
 * The Curriculum Bot's unit-CRUD tools are always present, but the
 * scholar-read tools it folds in must stay role-scoped — a
 * curriculum_designer driving the bot still must not reach scholar
 * records. Assembly itself touches ctx — it runs a `ctx.runQuery(...)`
 * to resolve the scholar lens — so the stub ctx must implement
 * `runQuery`; the tools then touch ctx again only inside run().
 */
const runQuery = vi.fn().mockResolvedValue({
  unrestricted: false,
  scholarIds: [],
  lensLabel: "Test school",
});
const ctx = { runQuery } as unknown as ActionCtx;
const emit = () => {};

const names = async (role: Parameters<typeof assembleUnitDesignerTools>[2]["role"]) =>
  (
    await assembleUnitDesignerTools(ctx, emit, {
      teacherId: "u_t" as Id<"users">,
      unitId: "unit_1" as Id<"units">,
      role,
    })
  )
    .map((t) => t.name)
    .sort();

const UNIT_CRUD = [
  "read_unit_structure",
  "update_unit",
  "create_lesson",
  "update_lesson",
  "delete_lesson",
  "generate_lesson_prompt",
  "generate_all_prompts",
  "create_activity",
  "list_activity_kind_catalog",
  "create_game_activity",
  "create_web_activity",
  "create_share_back_activity",
  "create_simulator_activity",
  "update_simulator_spec",
  "list_simulator_templates",
  "update_activity",
  "delete_activity",
  "reorder_activities",
  "generate_activity_prompt",
  "create_slides_deck",
  "read_deck",
  "apply_deck_edits",
];

// Assignment scheduling — the shared group from lib/assignmentTools.ts. The
// unit page is where a teacher asks to RUN the unit they're looking at, so the
// bot needs the same tools the global Curriculum Assistant has; without them
// it truthfully refused "assign this unit to the Geckos".
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

describe("assembleUnitDesignerTools", () => {
  test("resolves the scholar lens from the open unit's institution", async () => {
    runQuery.mockClear();
    await assembleUnitDesignerTools(ctx, emit, {
      teacherId: "u_t" as Id<"users">,
      unitId: "unit_1" as Id<"units">,
      role: ROLES.TEACHER,
      institutionScope: "school_1",
    });

    expect(runQuery).toHaveBeenCalledWith(
      internal.curriculumAssistant.resolveAideScholarLens,
      { callerUserId: "u_t", scope: "school_1" },
    );
  });

  test("teacher gets unit CRUD + full scholar-read set + groups + web tools", async () => {
    const got = await names(ROLES.TEACHER);
    for (const t of UNIT_CRUD) expect(got).toContain(t);
    expect(got).toContain("get_scholar_documents"); // full scholar read
    expect(got).toContain("list_scholars");
    expect(got).toContain("list_scholar_groups"); // roster cohorts (teacher-gated)
    expect(got).toContain("web_search"); // generic capability
    expect(got).toContain("web_fetch"); // generic capability
  });

  test("teacher can also RUN the unit — the assignment group is registered", async () => {
    const got = await names(ROLES.TEACHER);
    for (const t of ASSIGNMENT_TOOLS) expect(got).toContain(t);
    // Folding in a second toolset can only ever be safe if the names stay
    // unique — the Anthropic API rejects a duplicate tool name outright.
    expect(new Set(got).size).toBe(got.length);
  });

  test("the open unit is named in the assign tools' descriptions", async () => {
    const tools = await assembleUnitDesignerTools(ctx, emit, {
      teacherId: "u_t" as Id<"users">,
      unitId: "unit_1" as Id<"units">,
      role: ROLES.TEACHER,
      unitTitle: "Tide Pool Ecosystems",
    });
    // `description` isn't on every arm of the heterogeneous tool union (the
    // Anthropic-hosted web tools have none), so narrow to this tool's shape.
    const d =
      (tools.find((t) => t.name === "assign_unit")! as unknown as {
        description?: string;
      }).description ?? "";
    expect(d).toContain('The unit currently in scope is "Tide Pool Ecosystems"');
    expect(d).toContain("unitId unit_1");
  });

  test("the Simulator vocabulary remains discoverable while world identifiers stay stable", async () => {
    const tools = await assembleUnitDesignerTools(ctx, emit, {
      teacherId: "u_t" as Id<"users">,
      unitId: "unit_1" as Id<"units">,
      role: ROLES.TEACHER,
    });
    const catalog = tools.find((t) => t.name === "list_simulator_templates")! as unknown as {
      description?: string;
    };
    const create = tools.find((t) => t.name === "create_simulator_activity")! as unknown as {
      name: string;
      description?: string;
    };

    expect(catalog.description).toContain("Simulator activity");
    expect(create.description).toContain("simulator activity");
    expect(create.name).toBe("create_simulator_activity");
    expect(create.description).not.toContain("World Workbench");
  });

  test("activity authoring teaches private quality maps and complete flair details", async () => {
    const tools = await assembleUnitDesignerTools(ctx, emit, {
      teacherId: "u_t" as Id<"users">,
      unitId: "unit_1" as Id<"units">,
      role: ROLES.TEACHER,
    });
    const create = tools.find((t) => t.name === "create_activity")! as unknown as {
      description: string;
      input_schema: {
        properties: {
          deliverable: {
            description: string;
            properties: {
              criteria: {
                items: {
                  properties: {
                    label: { description: string };
                  };
                };
              };
            };
          };
        };
      };
    };

    expect(create.description).toContain("private quality map");
    expect(create.description).toContain("NOT a scholar checklist or a completion gate");
    expect(create.description).toContain(
      "its label and description shown together",
    );
    expect(create.description).not.toContain("scholar sees a checklist");
    expect(create.input_schema.properties.deliverable.description).toContain(
      "It does not gate activity completion",
    );
    expect(
      create.input_schema.properties.deliverable.properties.criteria.items.properties.label
        .description,
    ).toContain("Short criterion name");
  });

  test("curriculum_designer gets unit CRUD + web tools but NO scholar records or groups", async () => {
    const got = await names(ROLES.CURRICULUM_DESIGNER);
    for (const t of UNIT_CRUD) expect(got).toContain(t);
    // web_search/web_fetch are generic, so a designer still gets them.
    expect(got).toContain("web_search");
    expect(got).toContain("web_fetch");
    // The scholar-read ACL strips everything roster-shaped for a designer —
    // including the groups tool (member names are roster data).
    expect(got).not.toContain("list_scholars");
    expect(got).not.toContain("get_scholar_dossier");
    expect(got).not.toContain("get_scholar_documents");
    expect(got).not.toContain("get_scholar_mastery");
    expect(got).not.toContain("list_scholar_groups");
    // Running a cohort reads the roster and puts work in front of real kids —
    // teacher/admin only, so the bot must keep refusing this honestly.
    for (const t of ASSIGNMENT_TOOLS) expect(got).not.toContain(t);
  });
});

describe("read_unit_structure includeActivityDetails", () => {
  // Fake designer context: one lesson, one online activity carrying a
  // systemPrompt and a deliverable with criteria.
  const fakeContext = {
    unit: {
      title: "Flight",
      subject: "Science",
      gradeLevel: null,
      bigIdea: "Forces shape motion",
      essentialQuestions: ["Why do planes stay up?"],
      enduringUnderstandings: ["Lift opposes gravity"],
    },
    lessons: [
      {
        _id: "lesson_1",
        title: "Lift",
        strand: "core",
        processTitle: null,
        processEmoji: null,
        processId: null,
        activities: [
          {
            _id: "act_1",
            title: "How wings work",
            description: "Explore airflow",
            kind: "online",
            systemPrompt: "Guide the scholar through Bernoulli's principle.",
            deliverable: {
              kind: "text",
              prompt: "Explain why a wing generates lift.",
              mode: "manual",
              criteria: [
                { id: "c1", label: "Names air pressure", description: "above vs below the wing" },
              ],
            },
            googleSlidesPresentationId: null,
          },
        ],
      },
    ],
    processes: [],
  };
  const ctxWithQuery = {
    runQuery: async () => fakeContext,
  } as unknown as ActionCtx;

  const getTool = async () => {
    const tools = await assembleUnitDesignerTools(ctxWithQuery, emit, {
      teacherId: "u_t" as Id<"users">,
      unitId: "unit_1" as Id<"units">,
      role: ROLES.TEACHER,
    });
    // `find` over the heterogeneous tool array types `run`'s input as the
    // intersection of every tool's schema — cast to this tool's real shape.
    return tools.find((t) => t.name === "read_unit_structure")! as unknown as {
      run: (input: { includeActivityDetails?: boolean }) => Promise<string>;
    };
  };

  test("default output lists EQs/EUs and activity titles but not prompts", async () => {
    const tool = await getTool();
    const out = await tool.run({});
    expect(out).toContain("Why do planes stay up?");
    expect(out).toContain("Lift opposes gravity");
    expect(out).toContain("How wings work");
    expect(out).not.toContain("Bernoulli");
    expect(out).not.toContain("Names air pressure");
  });

  test("includeActivityDetails adds systemPrompt + deliverable criteria", async () => {
    const tool = await getTool();
    const out = await tool.run({ includeActivityDetails: true });
    expect(out).toContain("Guide the scholar through Bernoulli's principle.");
    expect(out).toContain("Explain why a wing generates lift.");
    expect(out).toContain("Names air pressure: above vs below the wing");
  });
});
