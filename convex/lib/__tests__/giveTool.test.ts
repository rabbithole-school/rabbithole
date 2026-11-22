import { getFunctionName } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import type { ActionCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { internal } from "../../_generated/api";
import {
  LEGACY_GIVE_TOOL_NAMES,
  makeAssignmentTools,
  resolveToolWithLegacyGive,
} from "../assignmentTools";
import { ROLES } from "../roles";

// The give tool's contract on an existing assignment (review of #4506):
//  - a `scholarId` narrows the audience like scholarNames; it never widens to
//    the whole cohort;
//  - `live` reports what was STORED, not what was asked.

type GiveRun = { run: (input: Record<string, unknown>) => Promise<string> };

async function giveTool(mutationResult: unknown) {
  const runQuery = vi.fn().mockImplementation(async (fn) =>
    getFunctionName(fn).includes("staffTimeZone") ? "America/Los_Angeles" : null,
  );
  const runMutation = vi.fn().mockResolvedValue(mutationResult);
  const tools = await makeAssignmentTools(
    { runQuery, runMutation } as unknown as ActionCtx,
    () => {},
    { role: ROLES.TEACHER, callerUserId: "u_teacher" as Id<"users"> },
  );
  const give = tools.find((t) => t.name === "give") as unknown as GiveRun;
  return { give, runMutation };
}

const callsTo = (
  runMutation: ReturnType<typeof vi.fn>,
  fn: Parameters<typeof getFunctionName>[0],
) =>
  runMutation.mock.calls.filter(
    ([called]) => getFunctionName(called) === getFunctionName(fn),
  );

describe("give with scholarId on an existing assignment", () => {
  test("now: only Kai gets it (narrowing), never the whole cohort", async () => {
    const { give, runMutation } = await giveTool({ stored: null });
    await give.run({
      assignmentId: "a_tidepools",
      activityId: "act_writeup",
      scholarId: "u_kai",
      startsNow: true,
      finish: "inClass",
    });
    const pushes = callsTo(runMutation, internal.assignments.aidePushActivityNow);
    expect(pushes).toHaveLength(1);
    expect(pushes[0][1].scholarIds).toEqual(["u_kai"]);
  });

  test("later: refused like a named subset, nothing written", async () => {
    const { give, runMutation } = await giveTool({ stored: null });
    const out = await give.run({
      assignmentId: "a_tidepools",
      activityId: "act_writeup",
      scholarId: "u_kai",
      startsAtMs: Date.now() + 86_400_000,
      finish: "inClass",
    });
    expect(out).toMatch(/Nothing given/);
    expect(runMutation).not.toHaveBeenCalled();
  });

  test("scholarId together with scholarNames is refused", async () => {
    const { give, runMutation } = await giveTool({ stored: null });
    const out = await give.run({
      assignmentId: "a_tidepools",
      activityId: "act_writeup",
      scholarId: "u_kai",
      scholarNames: ["Mia"],
      startsNow: true,
      finish: "inClass",
    });
    expect(out).toMatch(/Nothing given/);
    expect(runMutation).not.toHaveBeenCalled();
  });
});

describe("give reports the stored state", () => {
  test("a 'later' start that was stored live (grace window, or a live re-time) reports live:true", async () => {
    const now = Date.now();
    const { give } = await giveTool({
      stored: { mode: "homework", setAt: now, startsAt: now, endsAt: null, dueAt: now + 86_400_000 },
    });
    const out = JSON.parse(
      await give.run({
        assignmentId: "a_tidepools",
        activityId: "act_writeup",
        startsAtMs: now + 60_000,
        finish: "2026-11-20",
      }),
    );
    expect(out.live).toBe(true);
  });

  test("a planned row reports live:false", async () => {
    const now = Date.now();
    const { give } = await giveTool({
      stored: { mode: "homework", setAt: null, startsAt: now + 86_400_000, endsAt: null, dueAt: now + 2 * 86_400_000 },
    });
    const out = JSON.parse(
      await give.run({
        assignmentId: "a_tidepools",
        activityId: "act_writeup",
        startsAtMs: now + 86_400_000,
        finish: "2026-11-20",
      }),
    );
    expect(out.live).toBe(false);
  });
});

describe("the folded give verbs (deploy skew, one release)", () => {
  test("none is listed; each old call runs give and keeps its questions", async () => {
    const runQuery = vi.fn().mockImplementation(async (fn) =>
      getFunctionName(fn).includes("staffTimeZone") ? "America/Los_Angeles" : null,
    );
    const runMutation = vi.fn().mockResolvedValue({ stored: null });
    const tools = await makeAssignmentTools(
      { runQuery, runMutation } as unknown as ActionCtx,
      () => {},
      { role: ROLES.TEACHER, callerUserId: "u_teacher" as Id<"users"> },
    );
    for (const old of LEGACY_GIVE_TOOL_NAMES) {
      expect(tools.map((t) => t.name)).not.toContain(old);
    }
    // schedule_activity with no finish: the finish question, nothing written.
    const found = resolveToolWithLegacyGive(tools, "schedule_activity", {
      assignmentId: "a1",
      activityId: "act1",
      startsAtMs: Date.now() + 86_400_000,
    })!;
    expect(found.tool.name).toBe("give");
    const out = await (found.tool as unknown as GiveRun).run(
      found.input as Record<string, unknown>,
    );
    expect(out).toMatch(/NOT GIVEN/);
    expect(runMutation).not.toHaveBeenCalled();
    // push_activity_now keeps "now" and the named scholars.
    const push = resolveToolWithLegacyGive(tools, "push_activity_now", {
      assignmentId: "a1",
      activityId: "act1",
      scholarNames: ["Kai"],
    })!;
    expect(push.input).toMatchObject({ startsNow: true, scholarNames: ["Kai"] });
    // dispatch_activity live:false keeps its later start.
    const dispatch = resolveToolWithLegacyGive(tools, "dispatch_activity", {
      scholarName: "Kai",
      title: "Notes",
      live: false,
      startsAt: 123,
    })!;
    expect(dispatch.input).toMatchObject({
      scholarNames: ["Kai"],
      startsAtMs: 123,
      newActivity: { title: "Notes" },
    });
    expect(resolveToolWithLegacyGive(tools, "not_a_tool", {})).toBeNull();
  });
});
