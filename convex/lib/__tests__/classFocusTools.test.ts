import { convexTest } from "convex-test";
import { getFunctionName } from "convex/server";
import { describe, expect, test, vi } from "vitest";
import schema from "../../schema";
import { internal } from "../../_generated/api";
import type { ActionCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { assembleCurriculumTools } from "../aideTools";
import { makeSlackTools, writeSurfaceFor, type SlackSurface } from "../slackTools";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../../**/*.ts");

// The class-focus tools ride the SHARED staff-aide assembly
// (lib/aideTools.ts → lib/classFocusTools.ts), so the in-app aide
// (/aide-stream), the Slack bot, and the MCP connector all get them from one
// place. These tests drive that assembly, not one transport. The backing
// functions' own boundary (role + institution lens) is pinned in
// convex/__tests__/pushes.test.ts ("the staff-aide surface").

const FOCUS_TOOLS = [
  "list_focus_options",
  "make_class_focus",
  "list_class_focus",
  "end_class_focus",
];
const TEACHER_ROLES = ["teacher", "school_admin", "platform_admin"];
const OTHER_ROLES = [
  "scholar",
  "parent",
  "curriculum_designer",
  "staff",
  "lifelong_learner",
];
const CALLER = "user123" as Id<"users">;

type NamedTool = { name: string; run: (input: unknown) => Promise<string> };

const stubCtx = { runQuery: async () => false } as unknown as ActionCtx;

const aideTools = async (
  ctx: ActionCtx,
  role: string,
  callerUserId: Id<"users">,
  opts: {
    surface?: "private" | "channel";
    hasSchoolOperationsAccess?: boolean;
  } = {},
) =>
  (await assembleCurriculumTools(ctx, () => {}, {
    role: role as never,
    callerUserId,
    surface: opts.surface ?? "private",
    hasSchoolOperationsAccess: opts.hasSchoolOperationsAccess,
  })) as unknown as NamedTool[];

// Exactly what slackBot.ts assembles for the curriculum lane: the shared set
// plus the Slack-only extras.
const slackToolNames = async (
  role: string,
  surface: SlackSurface,
  hasSchoolOperationsAccess: boolean,
) => {
  const shared = await assembleCurriculumTools(stubCtx, () => {}, {
    role: role as never,
    callerUserId: CALLER,
    surface: writeSurfaceFor(surface),
    guardianFormAnswersSurface: surface === "channel" ? "shared" : "private",
    hasSchoolOperationsAccess,
    transport: "slack",
  });
  const extras = await makeSlackTools(stubCtx, () => {}, {
    role: role as never,
    callerUserId: CALLER,
    surface,
    slackChannelId: "C1",
    token: "xoxb-test",
    hasSchoolOperationsAccess,
  });
  return [...shared, ...extras].map((tool) => (tool as { name: string }).name);
};

describe("class-focus tools on the shared staff aide", () => {
  test("offered to teacher roles on every surface; never to other roles", async () => {
    for (const role of TEACHER_ROLES) {
      for (const surface of ["private", "channel"] as const) {
        const names = (await aideTools(stubCtx, role, CALLER, { surface })).map(
          (tool) => tool.name,
        );
        for (const name of FOCUS_TOOLS) expect(names).toContain(name);
      }
    }
    for (const role of OTHER_ROLES) {
      for (const hasSchoolOperationsAccess of [false, true]) {
        const names = (
          await aideTools(stubCtx, role, CALLER, { hasSchoolOperationsAccess })
        ).map((tool) => tool.name);
        for (const name of FOCUS_TOOLS) expect(names).not.toContain(name);
      }
    }
  });

  test("Slack keeps the same gate: each tool exactly once for teacher roles on channel/DM/group DM, absent otherwise", async () => {
    for (const surface of ["channel", "dm", "mpim"] as const) {
      for (const hasSchoolOperationsAccess of [false, true]) {
        for (const role of TEACHER_ROLES) {
          const names = await slackToolNames(
            role,
            surface,
            hasSchoolOperationsAccess,
          );
          for (const name of FOCUS_TOOLS) {
            expect(names.filter((n) => n === name)).toHaveLength(1);
          }
          // No tool name is offered twice on Slack after the move.
          expect(new Set(names).size).toBe(names.length);
        }
        for (const role of OTHER_ROLES) {
          const names = await slackToolNames(
            role,
            surface,
            hasSchoolOperationsAccess,
          );
          for (const name of FOCUS_TOOLS) expect(names).not.toContain(name);
        }
      }
    }
  });

  test("the caller is the aide session's user, never a model argument", async () => {
    const runQuery = vi.fn().mockResolvedValue(false);
    const ctx = { runQuery } as unknown as ActionCtx;
    const tool = (await aideTools(ctx, "teacher", CALLER)).find(
      (x) => x.name === "list_class_focus",
    )!;
    runQuery.mockReset().mockResolvedValue({ ok: true, pushes: [] });
    // A smuggled caller id in the input is ignored.
    await tool.run({ callerUserId: "someone_else" });
    expect(runQuery).toHaveBeenCalledWith(internal.pushes.liveFocusForAide, {
      callerUserId: CALLER,
    });
  });

  test("through the aide, a teacher pushes to their own group and is refused another school's", async () => {
    const t = convexTest(schema, modules);
    const { guests } = await t.mutation(
      internal.institutions.ensureDefaults,
      {},
    );
    const home = await t.run(async (ctx) =>
      (await ctx.db.query("institutions").collect()).find((i) => i.isPrimary)!._id,
    );
    const { homeTeacher, otherTeacher, homeGroup, appId } = await t.run(
      async (ctx) => {
        const homeTeacher = await ctx.db.insert("users", {
          name: "Test home teacher",
          username: "home_teacher",
          role: "teacher",
          institutionId: home,
        });
        await ctx.db.insert("memberships", {
          userId: homeTeacher,
          role: "teacher",
          institutionId: home,
        });
        const otherTeacher = await ctx.db.insert("users", {
          name: "Test other teacher",
          username: "other_teacher",
          role: "teacher",
          institutionId: guests,
        });
        await ctx.db.insert("memberships", {
          userId: otherTeacher,
          role: "teacher",
          institutionId: guests,
        });
        const kid = await ctx.db.insert("users", {
          name: "Test kid",
          username: "home_kid",
          role: "scholar",
          institutionId: home,
        });
        const homeGroup = await ctx.db.insert("scholarGroups", {
          teacherId: homeTeacher,
          institutionId: home,
          name: "Geckos",
          scholarIds: [kid],
        });
        const appId = await ctx.db.insert("externalApps", {
          name: "Tide Pool",
          webUrl: "https://example.test",
        });
        return { homeTeacher, otherTeacher, homeGroup, appId };
      },
    );

    // A real ActionCtx over convex-test, so the tools run their backing
    // functions against seeded rows (optional capability probes answer "no").
    const isOptionalCapabilityQuery = (ref: unknown) =>
      getFunctionName(ref as Parameters<typeof getFunctionName>[0]).includes(
        ":canOffer",
      );
    const ctx = {
      runQuery: (ref: unknown, args: unknown) =>
        isOptionalCapabilityQuery(ref)
          ? Promise.resolve(false)
          : (t.query as (r: unknown, a: unknown) => Promise<unknown>)(ref, args),
      runMutation: (ref: unknown, args: unknown) =>
        (t.mutation as (r: unknown, a: unknown) => Promise<unknown>)(ref, args),
      runAction: (ref: unknown, args: unknown) =>
        (t.action as (r: unknown, a: unknown) => Promise<unknown>)(ref, args),
    } as unknown as ActionCtx;
    const toolFor = async (caller: Id<"users">, name: string) =>
      (await aideTools(ctx, "teacher", caller)).find((x) => x.name === name)!;

    // Another school's teacher cannot target the home group.
    const refused = await (await toolFor(otherTeacher, "make_class_focus")).run({
      app_id: appId,
      group_id: homeGroup,
    });
    expect(refused).toMatch(/another school/i);

    // The home teacher's push lands and shows up in their live list.
    await (await toolFor(homeTeacher, "make_class_focus")).run({
      app_id: appId,
      group_id: homeGroup,
      duration_min: 20,
    });
    const live = JSON.parse(
      await (await toolFor(homeTeacher, "list_class_focus")).run({}),
    ) as { pushId: Id<"pushes">; title: string }[];
    expect(live.map((row) => row.title)).toEqual(["Tide Pool"]);

    // The other school sees nothing live and cannot end the home push.
    expect(await (await toolFor(otherTeacher, "list_class_focus")).run({})).toBe(
      "Nothing is up right now.",
    );
    expect(
      await (await toolFor(otherTeacher, "end_class_focus")).run({
        push_id: live[0].pushId,
      }),
    ).toMatch(/another school/i);
  });
});
