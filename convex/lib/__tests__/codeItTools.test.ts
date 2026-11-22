// The offer_code_it_quest aide tool: teacher roles only, the list mode's
// most-ready-first order and already-offered flag, and the note it adds when
// a teacher offers a mission on a skill the scholar is not fluent on yet.
// Fictional names only (the dev cast).
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../../schema";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";
import { CODE_IT_TOOL_NAME, makeCodeItTools } from "../codeItTools";
import { CODE_IT_MISSIONS } from "../practice/codeItMissions";
import { FLUENT_REPS } from "../practice/scheduler";
import { ALGEBRA_2_DOMAIN, ALGEBRA_2_SKILLS } from "../../seed/algebra2Graph";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "../../__tests__/institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../../**/*.ts");

type Tool = { run: (input: Record<string, unknown>) => Promise<string> };
type T = ReturnType<typeof convexTest>;

function actionCtxFor(t: T): ActionCtx {
  return {
    runQuery: (ref: unknown, args: unknown) =>
      (t as unknown as { query: (r: unknown, a: unknown) => Promise<unknown> }).query(
        ref,
        args,
      ),
    runMutation: (ref: unknown, args: unknown) =>
      (t as unknown as { mutation: (r: unknown, a: unknown) => Promise<unknown> }).mutation(
        ref,
        args,
      ),
  } as unknown as ActionCtx;
}

async function setup(t: T) {
  const institutionId = await seedTestInstitution(t, {
    name: "Moli School",
    slug: `moli-${Math.random().toString(36).slice(2)}`,
  });
  const teacherId = await seedStaffWithMembership(t, {
    institutionId,
    name: "Lehua Torres",
    username: `lehua-${Math.random().toString(36).slice(2)}`,
  });
  const scholarId = await seedScholarInInstitution(t, {
    institutionId,
    name: "Hoku Makani",
    username: `hoku-${Math.random().toString(36).slice(2)}`,
  });
  // The mission skills as Algebra 2 nodes, so the skill tree has them.
  await t.run(async (ctx) => {
    for (const skill of ALGEBRA_2_SKILLS) {
      if (!CODE_IT_MISSIONS.some((m) => m.skillKey === skill.skillKey)) continue;
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: skill.skillKey,
        label: skill.label,
        domain: ALGEBRA_2_DOMAIN,
        strand: skill.strand,
        grade: skill.grade,
      });
    }
  });
  return { teacherId, scholarId };
}

async function seedMastery(
  t: T,
  scholarId: Id<"users">,
  skillKey: string,
  repetition: number,
  source: "practice" | "placement",
) {
  const skill = ALGEBRA_2_SKILLS.find((s) => s.skillKey === skillKey)!;
  await t.run((ctx) =>
    ctx.db.insert("practiceMastery", {
      scholarId,
      skillKey,
      domain: ALGEBRA_2_DOMAIN,
      strand: skill.strand,
      repetition,
      halfLifeDays: 4,
      frontier: false,
      source,
      updatedAt: 1,
    }),
  );
}

async function toolFor(t: T, callerUserId: Id<"users">, role: "teacher" | "parent" | "scholar") {
  const tools = await makeCodeItTools(actionCtxFor(t), () => {}, { callerUserId, role });
  return tools.find((tool) => tool.name === CODE_IT_TOOL_NAME) as unknown as Tool | undefined;
}

type Listed = {
  offeredNothing: true;
  missions: Array<{
    skillKey: string;
    title: string;
    mission: string;
    status: string;
    alreadyOffered: boolean;
  }>;
};

describe("offer_code_it_quest", () => {
  test("is absent for parent and scholar roles", async () => {
    const t = convexTest(schema, modules);
    const { scholarId } = await setup(t);
    expect(await toolFor(t, scholarId, "scholar")).toBeUndefined();
    expect(await toolFor(t, scholarId, "parent")).toBeUndefined();
  });

  test("the description lists every mission's skillKey", async () => {
    const t = convexTest(schema, modules);
    const { teacherId } = await setup(t);
    const tools = await makeCodeItTools(actionCtxFor(t), () => {}, {
      callerUserId: teacherId,
      role: "teacher",
    });
    const description = (tools[0] as unknown as { description: string }).description;
    for (const m of CODE_IT_MISSIONS) expect(description).toContain(m.skillKey);
  });

  test("without skillKey it lists most ready first and offers nothing", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarId } = await setup(t);
    await seedMastery(t, scholarId, "log_evaluate", 1, "practice");
    await seedMastery(t, scholarId, "seq_recursive", FLUENT_REPS, "placement");
    await seedMastery(t, scholarId, "cx_multiply", FLUENT_REPS, "practice");
    const tool = (await toolFor(t, teacherId, "teacher"))!;

    const listed = JSON.parse(await tool.run({ scholarName: "Hoku Makani" })) as Listed;
    expect(listed.offeredNothing).toBe(true);
    expect(listed.missions).toHaveLength(CODE_IT_MISSIONS.length);
    expect(listed.missions.slice(0, 3).map((m) => [m.skillKey, m.status])).toEqual([
      ["cx_multiply", "demonstrated"],
      ["seq_recursive", "inferred"],
      ["log_evaluate", "in_progress"],
    ]);
    // The rest keep the registry's order.
    const rest = CODE_IT_MISSIONS.map((m) => m.skillKey).filter(
      (k) => !["cx_multiply", "seq_recursive", "log_evaluate"].includes(k),
    );
    expect(listed.missions.slice(3).map((m) => m.skillKey)).toEqual(rest);
    expect(listed.missions.slice(3).every((m) => m.status === "not_started")).toBe(true);
    expect(listed.missions.every((m) => !m.alreadyOffered)).toBe(true);

    const units = await t.run((ctx) =>
      ctx.db
        .query("units")
        .withIndex("by_authorScholar", (q) => q.eq("authorScholarId", scholarId))
        .collect(),
    );
    expect(units).toHaveLength(0);
  });

  test("offering a skill not started yet goes through and says so; the list then marks it", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarId } = await setup(t);
    await seedMastery(t, scholarId, "cx_multiply", FLUENT_REPS, "practice");
    const tool = (await toolFor(t, teacherId, "teacher"))!;

    const early = JSON.parse(
      await tool.run({ scholarName: "Hoku Makani", skillKey: "quad_complex_roots" }),
    ) as { created: boolean; skillStatus: string; readiness?: string; result: string };
    expect(early.created).toBe(true);
    expect(early.skillStatus).toBe("not_started");
    expect(early.readiness).toContain("not started in practice yet");
    expect(early.result).toContain("not practice and moves no mastery");

    const ready = JSON.parse(
      await tool.run({ scholarName: "Hoku Makani", skillKey: "cx_multiply" }),
    ) as { created: boolean; readiness?: string };
    expect(ready.created).toBe(true);
    expect(ready.readiness).toBeUndefined();

    const again = JSON.parse(
      await tool.run({ scholarName: "Hoku Makani", skillKey: "cx_multiply" }),
    ) as { created: boolean; result: string };
    expect(again.created).toBe(false);
    expect(again.result).toContain("nothing new was sent");

    const listed = JSON.parse(await tool.run({ scholarName: "Hoku Makani" })) as Listed;
    const offered = listed.missions.filter((m) => m.alreadyOffered).map((m) => m.skillKey);
    expect(offered.sort()).toEqual(["cx_multiply", "quad_complex_roots"]);
  });

  test("a mission the scholar started on their own is never called an offer", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarId } = await setup(t);
    await seedMastery(t, scholarId, "cx_multiply", FLUENT_REPS, "practice");
    // Python evidence: an ordinary Python Quest offer.
    await t.mutation(internal.questProposals.offerQuestForUser, {
      offererId: teacherId,
      scholarId,
      kind: "python",
      mission: "Count the primes below 100.",
      title: "Prime count",
    });
    const sessionId = await t.run((ctx) =>
      ctx.db.insert("authSessions", { userId: scholarId, expirationTime: Date.now() + 3_600_000 }),
    );
    const asScholar = t.withIdentity({
      subject: `${scholarId}|${sessionId}`,
      issuer: "https://convex.dev",
    });
    await asScholar.mutation(api.users.setCodeItEnabled, { enabled: true });
    await asScholar.mutation(api.questProposals.startUnlockedCodeIt, { skillKey: "cx_multiply" });
    const tool = (await toolFor(t, teacherId, "teacher"))!;

    const listed = JSON.parse(await tool.run({ scholarName: "Hoku Makani" })) as {
      missions: Array<{
        skillKey: string;
        alreadyOffered: boolean;
        startedOnTheirOwn: boolean;
        offer?: string;
      }>;
    };
    const mission = listed.missions.find((m) => m.skillKey === "cx_multiply")!;
    expect(mission.alreadyOffered).toBe(false);
    expect(mission.startedOnTheirOwn).toBe(true);
    expect(mission.offer).toContain("no teacher offered it");

    const offered = JSON.parse(
      await tool.run({ scholarName: "Hoku Makani", skillKey: "cx_multiply" }),
    ) as { created: boolean; startedOnTheirOwn?: boolean; result: string };
    expect(offered.created).toBe(false);
    expect(offered.startedOnTheirOwn).toBe(true);
    expect(offered.result).toContain("already started");
    expect(offered.result).not.toContain("was already offered");
  });

  test("a scholar outside the lens is not found and nothing is offered", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarId } = await setup(t);
    const tools = await makeCodeItTools(actionCtxFor(t), () => {}, {
      callerUserId: teacherId,
      role: "teacher",
      allowedScholarIds: new Set<Id<"users">>(),
    });
    const tool = tools[0] as unknown as Tool;
    const result = await tool.run({ scholarName: "Hoku Makani", skillKey: "cx_multiply" });
    expect(result).toContain("No scholar matched");
    const units = await t.run((ctx) =>
      ctx.db
        .query("units")
        .withIndex("by_authorScholar", (q) => q.eq("authorScholarId", scholarId))
        .collect(),
    );
    expect(units).toHaveLength(0);
  });
});
