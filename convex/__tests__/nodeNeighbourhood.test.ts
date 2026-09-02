import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "../schema";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

// Mirror the NodeDrawer's bucketing so this test asserts the SAME split the
// core⟷all toggle performs client-side (components/NodeDrawer.tsx ~L325).
const TREE = new Set(["buildsOn", "buildsTowards", "requires"]);
const SKY_CAP = 5; // drawer caps sky neighbours at 5

type Edge = { fromKey: string; toKey: string; kind: string; relation?: string };
function skyBucket(edges: Edge[], focal: string): string[] {
  return [
    ...new Set(
      edges
        .filter((e) => !TREE.has(e.kind))
        .map((e) => (e.fromKey === focal ? e.toKey : e.fromKey)),
    ),
  ];
}
function prereqBucket(edges: Edge[], focal: string): string[] {
  return edges
    .filter((e) => TREE.has(e.kind) && e.toKey === focal)
    .map((e) => e.fromKey);
}

describe("nodeNeighbourhood.neighbourhood — nn edges surface in the sky bucket", () => {
  test("a TREE/skill node gets its precomputed nn edges in the sky bucket (drawer 'all')", async () => {
    const t = convexTest(schema, modules);

    // Focal node is a curated tree/skill node — the case the old
    // cross-domain-only bridge build left with NO associative neighbours.
    await t.run(async (ctx) => {
      const place = (nodeKey: string, source: string, domain: string) =>
        ctx.db.insert("knowledgeNodes", {
          nodeKey,
          label: nodeKey,
          normalizedLabel: nodeKey,
          domain,
          source,
          skyX: 5,
          skyY: 5,
          refCount: 1,
        });

      await place("math:add", "curated", "math");
      await place("math:count", "curated", "math"); // prereq (tree)
      // six associative neighbours (any domain) → nn edges
      for (let i = 0; i < 6; i++) await place(`assoc:${i}`, "seed", "science");

      // Tree edge (prereq lattice) — must land in the TREE bucket, not sky.
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: "math:count",
        toKey: "math:add",
        domain: "math",
        kind: "buildsOn",
      });
      // nn edges (stored canonical order fromKey<toKey, domain sentinel "sky").
      for (let i = 0; i < 6; i++) {
        const [fromKey, toKey] =
          "math:add" < `assoc:${i}`
            ? ["math:add", `assoc:${i}`]
            : [`assoc:${i}`, "math:add"];
        await ctx.db.insert("knowledgeNodeEdges", {
          fromKey,
          toKey,
          domain: "sky",
          kind: "nn",
          weight: 0.5 + i * 0.01,
        });
      }
    });

    const userId = await seedStaffWithMembership(t, { institutionId: await seedTestInstitution(t), name: "Reader", username: "reader" });
    const asUser = await withUser(t, userId);

    const res = await asUser.query(api.nodeNeighbourhood.neighbourhood, {
      nodeKey: "math:add",
    });
    expect(res).not.toBeNull();
    const edges = res!.edges as Edge[];

    // The query returns nn edges (kind not in TREE_KINDS).
    expect(edges.some((e) => e.kind === "nn")).toBe(true);
    expect(edges.find((e) => e.kind === "nn")?.relation).toBe("bridge");
    expect(edges.find((e) => e.kind === "buildsOn")?.relation).toBe("dependency");

    // Sky bucket = all six associative neighbours; prereq stays in the tree bucket.
    const sky = skyBucket(edges, "math:add");
    for (let i = 0; i < 6; i++) expect(sky).toContain(`assoc:${i}`);
    expect(sky).not.toContain("math:count");

    // Tree bucket = the buildsOn prereq (never an nn neighbour).
    expect(prereqBucket(edges, "math:add")).toContain("math:count");

    // The drawer caps the sky neighbourhood at 5.
    expect(sky.slice(0, SKY_CAP)).toHaveLength(SKY_CAP);

    // Neighbour node records are returned for the nn endpoints.
    const neighbourKeys = new Set(res!.neighbours.map((n) => n.nodeKey));
    for (let i = 0; i < 6; i++) expect(neighbourKeys.has(`assoc:${i}`)).toBe(true);
  });

  test("unknown edge kinds are excluded and reported", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "focal",
        label: "Focal",
        domain: "math",
      });
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "known",
        label: "Known",
        domain: "math",
      });
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: "focal",
        toKey: "known",
        domain: "math",
        kind: "bogus",
      });
    });
    const userId = await seedStaffWithMembership(t, { institutionId: await seedTestInstitution(t), name: "Reader", username: "reader" });
    const asUser = await withUser(t, userId);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await asUser.query(api.nodeNeighbourhood.neighbourhood, {
      nodeKey: "focal",
    });

    expect(res?.edges).toEqual([]);
    expect(res?.neighbours).toEqual([]);
    expect(spy).toHaveBeenCalledWith(
      "Unknown knowledge edge kind in neighbourhood response",
      expect.objectContaining({ kind: "bogus" }),
    );
    spy.mockRestore();
  });

  test("story edges are co-fetched and excluded from generic edges", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "prime_factorization",
        label: "Prime factorization",
        domain: "math",
      });
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "cicada life cycles",
        label: "Cicada life cycles",
        domain: "biology",
      });
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "cryptography",
        label: "Cryptography",
        domain: "computer-science",
      });
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: "prime_factorization",
        toKey: "cicada life cycles",
        domain: "sky",
        kind: "bridge",
        method: "curated",
        story: {
          kind: "instantiates",
          hook: "Cicadas that count in primes",
          narrative: "Prime-numbered cicada cycles rarely line up with predator cycles.",
          provenance: "registry",
        },
      });
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: "prime_factorization",
        toKey: "cryptography",
        domain: "sky",
        kind: "bridge",
        method: "embedding",
        weight: 0.7,
      });
    });

    const userId = await seedStaffWithMembership(t, { institutionId: await seedTestInstitution(t), name: "Reader", username: "reader" });
    const asUser = await withUser(t, userId);
    const res = await asUser.query(api.nodeNeighbourhood.neighbourhood, {
      nodeKey: "prime_factorization",
    });

    expect(res?.stories).toHaveLength(1);
    expect(res?.stories[0]).toMatchObject({
      direction: "outgoing",
      fromKey: "prime_factorization",
      fromLabel: "Prime factorization",
      toKey: "cicada life cycles",
      toLabel: "Cicada life cycles",
      toDomain: "biology",
      story: { hook: "Cicadas that count in primes" },
    });
    expect(res?.edges.map((e) => e.toKey)).toEqual(["cryptography"]);
    expect(res?.edges[0]).toMatchObject({
      relation: "bridge",
      method: "embedding",
    });

    const incoming = await asUser.query(api.nodeNeighbourhood.neighbourhood, {
      nodeKey: "cicada life cycles",
    });
    expect(incoming?.stories).toHaveLength(1);
    expect(incoming?.stories[0]).toMatchObject({
      direction: "incoming",
      fromKey: "prime_factorization",
      fromLabel: "Prime factorization",
      fromDomain: "math",
      toKey: "cicada life cycles",
      toLabel: "Cicada life cycles",
      story: { hook: "Cicadas that count in primes" },
    });
    expect(incoming?.edges).toEqual([]);
  });

  test("INFERENCE-ONLY `implies` edges never surface in the neighbourhood (no prereq/unlock leak)", async () => {
    // The NodeDrawer turns every returned edge whose `relation === "dependency"`
    // into a prerequisite/unlock arrow + chip. `relationOf("implies")` is
    // "dependency", so an `implies` edge reaching the drawer would render as a
    // (false) prerequisite. The neighbourhood is NOT one of the two blessed
    // inference consumers (implicit-credit + placement), so it must DROP `implies`
    // entirely — this pins that filter.
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const node = (nodeKey: string, domain: string) =>
        ctx.db.insert("knowledgeNodes", { nodeKey, label: nodeKey, domain });
      await node("read_picture_graph", "probability"); // focal (implies TARGET)
      await node("count_objects_within_20", "whole-number-arithmetic"); // implies SOURCE
      await node("compare_graph_categories", "probability"); // a real buildsOn dependent
      // The shipped inference-only edge INTO the focal — must be invisible here.
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: "count_objects_within_20",
        toKey: "read_picture_graph",
        domain: "probability",
        kind: "implies",
        method: "curated",
      });
      // A genuine buildsOn edge OUT of the focal — must still surface as dependency.
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: "read_picture_graph",
        toKey: "compare_graph_categories",
        domain: "probability",
        kind: "buildsOn",
        method: "curated",
      });
    });

    const userId = await seedStaffWithMembership(t, { institutionId: await seedTestInstitution(t), name: "Reader", username: "reader" });
    const asUser = await withUser(t, userId);
    const res = await asUser.query(api.nodeNeighbourhood.neighbourhood, {
      nodeKey: "read_picture_graph",
    });
    expect(res).not.toBeNull();
    const edges = res!.edges as Edge[];

    // The implies edge (and its source neighbour) are ABSENT from the response…
    expect(edges.some((e) => e.kind === "implies")).toBe(false);
    expect(edges.some((e) => e.fromKey === "count_objects_within_20")).toBe(false);
    expect(res!.neighbours.some((n) => n.nodeKey === "count_objects_within_20")).toBe(false);
    // …while the genuine buildsOn dependency is still returned as a "dependency".
    const buildsOn = edges.find((e) => e.kind === "buildsOn");
    expect(buildsOn?.toKey).toBe("compare_graph_categories");
    expect(buildsOn?.relation).toBe("dependency");
    expect(res!.neighbours.some((n) => n.nodeKey === "compare_graph_categories")).toBe(true);
  });

  describe("mastery — the two-axis doctrine (access-proven vs. demonstrated)", () => {
    // Both cases are fluent-or-better by REPS (repetition 4, i.e. proficiency
    // "fluent") so a rep-count-only read would show both as green "fluent".
    // The doctrine (rabbithole-practice-engine.md: "never render inferred
    // credit as green") requires the SOURCE to gate the claim too.
    async function seedFocalWithMastery(
      source: string,
      { repetition = 4, frontier = false } = {},
    ) {
      const t = convexTest(schema, modules);
      const scholarId = await seedScholarInInstitution(t, { institutionId: await seedTestInstitution(t), name: "Scholar", username: "scholar" });
      const teacherId = await seedStaffWithMembership(t, { institutionId: await seedTestInstitution(t), name: "Teacher", username: "teacher" });
      await t.run(async (ctx) => {
        await ctx.db.insert("knowledgeNodes", {
          nodeKey: "add_fractions_unlike",
          label: "Add fractions with unlike denominators",
          domain: "fraction-arithmetic",
        });
        await ctx.db.insert("practiceMastery", {
          scholarId,
          skillKey: "add_fractions_unlike",
          domain: "fraction-arithmetic",
          repetition,
          halfLifeDays: 4,
          lastPracticedAt: Date.now(),
          frontier,
          source,
          updatedAt: Date.now(),
        });
      });
      const asTeacher = await withUser(t, teacherId);
      return asTeacher.query(api.nodeNeighbourhood.neighbourhood, {
        nodeKey: "add_fractions_unlike",
        scholarId,
      });
    }

    test("placement-derived credit surfaces as provisional 'placed', not 'fluent'", async () => {
      const res = await seedFocalWithMastery("placement");
      expect(res?.focalReadings?.mastery).toBe("placed");
    });

    test("accelerated-valve credit also surfaces as 'placed' (inferred, not demonstrated)", async () => {
      const res = await seedFocalWithMastery("accelerated");
      expect(res?.focalReadings?.mastery).toBe("placed");
    });

    test("demonstrated (real-practice) credit at the same reps surfaces as the solid-green 'fluent' — control case", async () => {
      const res = await seedFocalWithMastery("practice");
      expect(res?.focalReadings?.mastery).toBe("fluent");
    });

    test("an explicitly frontier row remains frontier before practice starts", async () => {
      const res = await seedFocalWithMastery("practice", {
        repetition: 0,
        frontier: true,
      });
      expect(res?.focalReadings?.mastery).toBe("frontier");
    });

    test("a placement-derived NEIGHBOUR also surfaces as 'placed' in neighbourMastery", async () => {
      const t = convexTest(schema, modules);
      const scholarId = await seedScholarInInstitution(t, { institutionId: await seedTestInstitution(t), name: "Scholar", username: "scholar2" });
      const teacherId = await seedStaffWithMembership(t, { institutionId: await seedTestInstitution(t), name: "Teacher", username: "teacher2" });
      await t.run(async (ctx) => {
        await ctx.db.insert("knowledgeNodes", {
          nodeKey: "focal_skill",
          label: "Focal skill",
          domain: "fraction-arithmetic",
        });
        await ctx.db.insert("knowledgeNodes", {
          nodeKey: "prereq_skill",
          label: "Prereq skill",
          domain: "fraction-arithmetic",
        });
        await ctx.db.insert("knowledgeNodeEdges", {
          fromKey: "prereq_skill",
          toKey: "focal_skill",
          domain: "fraction-arithmetic",
          kind: "buildsOn",
        });
        await ctx.db.insert("practiceMastery", {
          scholarId,
          skillKey: "prereq_skill",
          domain: "fraction-arithmetic",
          repetition: 4,
          halfLifeDays: 4,
          lastPracticedAt: Date.now(),
          frontier: false,
          source: "placement",
          updatedAt: Date.now(),
        });
      });
      const asTeacher = await withUser(t, teacherId);
      const res = await asTeacher.query(api.nodeNeighbourhood.neighbourhood, {
        nodeKey: "focal_skill",
        scholarId,
      });
      expect(res?.neighbourMastery["prereq_skill"]?.mastery).toBe("placed");
    });
  });
});
