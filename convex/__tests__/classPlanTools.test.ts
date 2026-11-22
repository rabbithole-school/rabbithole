// The class-planning tools report a result line on every call, including a
// question or refusal returned early. An unreported call shows in the aide
// as "Failed: no result reported" though the model got a usable answer (the
// live run of TRA-582 hit this on its first turn).
import { describe, expect, test } from "vitest";
import { getFunctionName } from "convex/server";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { makeClassPlanTools, planAssignmentLine } from "../lib/classPlanTools";

type Tool = { name: string; run: (input: unknown) => Promise<string> };

/** An action ctx whose runQuery answers the two reads give_class_days makes. */
function stubCtx(): ActionCtx {
  const runQuery = async (ref: unknown) => {
    switch (getFunctionName(ref as never)) {
      case "curriculumAssistant:listScholarGroupsInternal":
        return [{ id: "g1", name: "Honu", members: [{ id: "s1", name: "Hoku Makani" }] }];
      case "classPlans:aideClassDays":
        return {
          ok: true,
          groupName: "Honu",
          subject: "Humanities",
          unit: {
            unitTitle: "Island Maps",
            activities: [{ activityId: "a1", title: "Follow the stream" }],
          },
        };
      default:
        throw new Error(`unexpected query ${getFunctionName(ref as never)}`);
    }
  };
  return { runQuery } as unknown as ActionCtx;
}

async function giveTool(events: unknown[]): Promise<Tool> {
  const tools = await makeClassPlanTools(stubCtx(), (e) => events.push(e), {
    callerUserId: "u1" as Id<"users">,
    confirmScope: { surface: "app", turn: 1 },
  });
  return tools.find((t) => t.name === "give_class_days") as unknown as Tool;
}

describe("give_class_days reports every call", () => {
  test("a give with no finish asks the question and reports it", async () => {
    const events: unknown[] = [];
    const tool = await giveTool(events);
    const out = await tool.run({
      groupName: "Honu",
      subject: "Humanities",
      unitId: "unit1",
      gives: [{ activityTitle: "Follow the stream", day: "2026-11-13" }],
    });
    expect(out).toMatch(/^NOT GIVEN/);
    expect(events).toEqual([
      { toolComplete: { name: "give_class_days", result: "Asked the teacher a question · nothing given" } },
    ]);
  });

  test("a refusal reports its first sentence", async () => {
    const events: unknown[] = [];
    const tool = await giveTool(events);
    const out = await tool.run({
      groupName: "Honu",
      subject: "Humanities",
      gives: [{ activityTitle: "Follow the stream", day: "2026-11-13" }],
      finish: "inClass",
    });
    expect(out).toBe("Say which unit (unitId or unitTitle). Nothing given.");
    expect(events).toEqual([
      { toolComplete: { name: "give_class_days", result: "Say which unit (unitId or unitTitle)." } },
    ]);
  });
});

describe("planAssignmentLine", () => {
  test("gives the count of other scholars on a shared assignment only when there is one", () => {
    expect(planAssignmentLine("Honu", "Island Maps", false, { otherScholars: 2 }, "did")).toContain("2 other scholars");
    expect(planAssignmentLine("Honu", "Island Maps", false, null, "did")).not.toMatch(/shared/);
  });
});

describe("a surface without turns", () => {
  test("gets the read tool only: the writes need a server-checked confirmation", async () => {
    const tools = await makeClassPlanTools(stubCtx(), () => {}, { callerUserId: "u1" as Id<"users"> });
    expect(tools.map((t) => t.name)).toEqual(["get_class_days"]);
  });
});
