import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../../schema";
import type { ActionCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import type { Role } from "../roles";
import { makePracticeSkillTreeTools } from "../practiceSkillTreeTools";
import { WHOLE_NUMBER_ARITHMETIC_DOMAIN } from "../../seed/wholeNumberArithmeticGraph";
import { FRACTION_ARITHMETIC_DOMAIN } from "../../seed/fractionArithmeticGraph";
import { FLUENT_REPS } from "../practice/scheduler";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "../../__tests__/institutionTestHelpers";

/**
 * End-to-end exercise of the practice skill-tree aide tool (the renamed,
 * read-only successor to the retired math-focus aide tools — the runtime
 * dropped every focus read/write tool along with the retired hard-serving
 * control plane). This module now exposes exactly ONE tool,
 * `get_scholar_skill_tree`, so the surviving coverage is: the teacher role
 * gate, the skill-tree honesty invariants (demonstrated/inferred separation,
 * stripped deficit/rep-band fields), the allDomains override, and the
 * allowedScholarIds lens scoping.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../../**/*.ts");

function actionCtxFor(t: ReturnType<typeof convexTest>): ActionCtx {
  return {
    runQuery: (ref: unknown, args: unknown) =>
      (t as unknown as { query: (r: unknown, a: unknown) => Promise<unknown> }).query(ref, args),
    runMutation: (ref: unknown, args: unknown) =>
      (t as unknown as { mutation: (r: unknown, a: unknown) => Promise<unknown> }).mutation(ref, args),
  } as unknown as ActionCtx;
}

async function seedTeacherAndScholar(
  t: ReturnType<typeof convexTest>,
  scholarName = "Henry",
) {
  const institutionId = await seedTestInstitution(t);
  const teacherId = await seedStaffWithMembership(t, {
    institutionId,
    name: "Carl",
    username: `carl-${Math.random().toString(36).slice(2)}`,
  });
  const scholarId = await seedScholarInInstitution(t, {
    institutionId,
    name: scholarName,
    username: `henry-${Math.random().toString(36).slice(2)}`,
  });
  return { institutionId, teacherId, scholarId };
}

async function seedNode(
  t: ReturnType<typeof convexTest>,
  domain: string,
  strand: string,
  nodeKey: string,
  grade = "3",
) {
  await t.run((ctx) =>
    ctx.db.insert("knowledgeNodes", { nodeKey, label: nodeKey, domain, strand, grade }),
  );
}

async function seedEdge(
  t: ReturnType<typeof convexTest>,
  domain: string,
  fromKey: string,
  toKey: string,
) {
  await t.run((ctx) =>
    ctx.db.insert("knowledgeNodeEdges", { fromKey, toKey, domain, kind: "buildsOn" }),
  );
}

async function seedMastery(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  domain: string,
  skillKey: string,
  source: "practice" | "placement" | "scaffolded",
  opts: { repetition?: number; lastPracticedAt?: number | null } = {},
) {
  const repetition = opts.repetition ?? FLUENT_REPS;
  // Default: fluent-band rows carry a fresh practice stamp; a caller can pass
  // lastPracticedAt (incl. null) to model a zero-credit first-attempt row.
  const lastPracticedAt =
    opts.lastPracticedAt === undefined ? Date.now() : opts.lastPracticedAt;
  await t.run((ctx) =>
    ctx.db.insert("practiceMastery", {
      scholarId,
      skillKey,
      domain,
      repetition,
      // Demonstrated rows get a long half-life + a fresh practice stamp so the
      // retention leg of isFluent passes; placement rows are the short-half-life
      // inferred credit that reads as provisional, never fluent.
      halfLifeDays: source === "practice" ? 30 : 4,
      ...(lastPracticedAt === null ? {} : { lastPracticedAt }),
      frontier: false,
      source,
      updatedAt: Date.now(),
    }),
  );
}

async function toolsFor(
  t: ReturnType<typeof convexTest>,
  callerUserId: Id<"users">,
  role: Role = "teacher",
  allowedScholarIds?: Set<Id<"users">>,
) {
  const tools = await makePracticeSkillTreeTools(actionCtxFor(t), () => {}, {
    role,
    callerUserId,
    allowedScholarIds,
  });
  return Object.fromEntries(tools.map((tl: { name: string }) => [tl.name, tl])) as unknown as Record<
    string,
    { run: (input: unknown) => Promise<string> }
  >;
}

const parse = (s: string) => JSON.parse(s) as Record<string, unknown>;

describe("practice skill-tree aide tool (end-to-end)", () => {
  test("a non-teacher gets NO tools", async () => {
    const t = convexTest(schema, modules);
    const { scholarId } = await seedTeacherAndScholar(t);
    const tools = await makePracticeSkillTreeTools(actionCtxFor(t), () => {}, {
      role: "scholar",
      callerUserId: scholarId,
    });
    expect(tools).toHaveLength(0);
  });

  test("a teacher's factory exposes exactly get_scholar_skill_tree", async () => {
    const t = convexTest(schema, modules);
    const { teacherId } = await seedTeacherAndScholar(t);
    const tools = await makePracticeSkillTreeTools(actionCtxFor(t), () => {}, {
      role: "teacher",
      callerUserId: teacherId,
    });
    expect(tools.map((tl: { name: string }) => tl.name)).toEqual(["get_scholar_skill_tree"]);
  });

  test("get_scholar_skill_tree projects a four-state `status` on the FLUENT band + attempt signal, and STRIPS deficit/conflating fields", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarId } = await seedTeacherAndScholar(t);
    // (a) never-practiced node — no mastery row at all → not_started.
    await seedNode(t, WHOLE_NUMBER_ARITHMETIC_DOMAIN, "counting", "count_to_30");
    // (b) placement-inferred, FLUENT band — access-proven, not real practice → inferred.
    await seedNode(t, WHOLE_NUMBER_ARITHMETIC_DOMAIN, "counting", "count_to_20");
    // (c) practice-demonstrated, FLUENT band — genuinely earned → demonstrated.
    await seedNode(t, WHOLE_NUMBER_ARITHMETIC_DOMAIN, "counting", "count_to_10");
    // (d) 1 rep of real practice, BELOW fluent band → in_progress (not mastered).
    await seedNode(t, WHOLE_NUMBER_ARITHMETIC_DOMAIN, "counting", "count_to_40");
    // (e) 1 rep scaffolded partial credit, below fluent → in_progress (not "placed through").
    await seedNode(t, WHOLE_NUMBER_ARITHMETIC_DOMAIN, "counting", "count_to_50");
    // (f) zero credit but an attempt on record (a first WRONG attempt stamps
    //     lastPracticedAt at reps 0) → in_progress, NOT not_started.
    await seedNode(t, WHOLE_NUMBER_ARITHMETIC_DOMAIN, "counting", "count_to_60");
    await seedEdge(t, WHOLE_NUMBER_ARITHMETIC_DOMAIN, "count_to_10", "count_to_20");
    await seedEdge(t, WHOLE_NUMBER_ARITHMETIC_DOMAIN, "count_to_20", "count_to_30");
    await seedMastery(t, scholarId, WHOLE_NUMBER_ARITHMETIC_DOMAIN, "count_to_10", "practice");
    await seedMastery(t, scholarId, WHOLE_NUMBER_ARITHMETIC_DOMAIN, "count_to_20", "placement");
    await seedMastery(t, scholarId, WHOLE_NUMBER_ARITHMETIC_DOMAIN, "count_to_40", "practice", {
      repetition: 1,
    });
    await seedMastery(t, scholarId, WHOLE_NUMBER_ARITHMETIC_DOMAIN, "count_to_50", "scaffolded", {
      repetition: 1,
    });
    await seedMastery(t, scholarId, WHOLE_NUMBER_ARITHMETIC_DOMAIN, "count_to_60", "practice", {
      repetition: 0,
      lastPracticedAt: Date.now(),
    });

    const tools = await toolsFor(t, teacherId);
    const tree = parse(
      await tools.get_scholar_skill_tree.run({
        scholarName: "Henry",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
      }),
    );
    const nodes = tree.nodes as Record<string, unknown>[];
    const edges = tree.edges as { fromKey: string; toKey: string }[];
    const byKey = (k: string) => nodes.find((n) => n.skillKey === k)!;

    // (c) fluent + practice → demonstrated (the ONLY mastered value).
    expect(byKey("count_to_10").status).toBe("demonstrated");
    expect(byKey("count_to_10").demonstrated).toBe(true);
    // (b) fluent + placement → inferred, demonstrated FALSE.
    expect(byKey("count_to_20").status).toBe("inferred");
    expect(byKey("count_to_20").demonstrated).toBe(false);
    // (a) never-practiced → not_started, demonstrated FALSE (the prod defect,
    // 2026-09-02: the raw upstream flag defaults TRUE for a node with no row).
    expect(byKey("count_to_30").status).toBe("not_started");
    expect(byKey("count_to_30").demonstrated).toBe(false);
    // (d) reviewer counterexample #1: 1 rep of practice is BELOW fluent → in_progress.
    expect(byKey("count_to_40").status).toBe("in_progress");
    expect(byKey("count_to_40").demonstrated).toBe(false);
    // (e) reviewer counterexample #2: scaffolded partial credit → in_progress
    // (neither mastered nor "placed through").
    expect(byKey("count_to_50").status).toBe("in_progress");
    expect(byKey("count_to_50").demonstrated).toBe(false);
    // (f) reviewer counterexample #3: a first wrong attempt (reps 0, stamped) is
    // in_progress, not not_started ("never seen, no attempt" would be a lie).
    expect(byKey("count_to_60").status).toBe("in_progress");
    expect(byKey("count_to_60").demonstrated).toBe(false);

    expect(nodes.every((n) => "status" in n)).toBe(true);
    expect(edges).toContainEqual({ fromKey: "count_to_10", toKey: "count_to_20" });
    // Finding 3 + 4 (from the retired math-focus tools): the deficit signal and
    // the false-fluent rep band are NOT handed to the model.
    for (const n of nodes) {
      expect(n).not.toHaveProperty("missStreak");
      expect(n).not.toHaveProperty("proficiency");
      expect(n).not.toHaveProperty("repetition");
    }
  });

  test("get_scholar_skill_tree: allDomains WINS over a passed domain (matches the description)", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarId } = await seedTeacherAndScholar(t);
    await seedNode(t, WHOLE_NUMBER_ARITHMETIC_DOMAIN, "counting", "count_to_10");
    await seedNode(t, FRACTION_ARITHMETIC_DOMAIN, "parts", "one_half");
    void scholarId;

    const tools = await toolsFor(t, teacherId);
    const tree = parse(
      await tools.get_scholar_skill_tree.run({
        scholarName: "Henry",
        domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        allDomains: true,
      }),
    );
    const domains = tree.domains as string[];
    // Despite passing domain: whole-number-arithmetic, allDomains:true returns
    // BOTH seeded domains, not just the one named.
    expect(domains).toContain(WHOLE_NUMBER_ARITHMETIC_DOMAIN);
    expect(domains).toContain(FRACTION_ARITHMETIC_DOMAIN);
  });

  // ── allowedScholarIds LENS enforcement ──
  describe("allowedScholarIds lens scoping", () => {
    test("cannot resolve a scholar outside the lens", async () => {
      const t = convexTest(schema, modules);
      const { teacherId, scholarId } = await seedTeacherAndScholar(t);
      await seedNode(t, WHOLE_NUMBER_ARITHMETIC_DOMAIN, "counting", "count_to_10");
      void scholarId;
      // Lens that does NOT include Henry.
      const emptyLens = new Set<Id<"users">>();
      const tools = await toolsFor(t, teacherId, "teacher", emptyLens);

      expect(
        await tools.get_scholar_skill_tree.run({
          scholarName: "Henry",
          domain: WHOLE_NUMBER_ARITHMETIC_DOMAIN,
        }),
      ).toMatch(/No scholar found/);
    });
  });
});
