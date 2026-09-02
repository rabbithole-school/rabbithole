import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  seedScholarInInstitution,
  seedTestInstitution,
} from "./institutionTestHelpers";

// ─────────────────────────────────────────────────────────────────────────
// Convex wiring for the multi-strand scheduler (roadmap §2). These verify the
// glue in convex/practiceSkills.ts — NOT the pure algorithm (that's covered in
// convex/lib/__tests__/practiceScheduler.test.ts):
//   • `strand` is denormalized onto practiceMastery on every write (so the
//     round-robin read is a cheap mastery-only scan).
//   • `nextForScholar` computes the strand round-robin from MAX(updatedAt)
//     GROUP BY strand and serves the least-recently-served strand first.
// Only EXISTING function signatures are used, so no codegen is required here.
// ─────────────────────────────────────────────────────────────────────────

const modules = (import.meta as ImportMeta & { glob: (p: string) => Record<string, () => Promise<unknown>> }).glob("../**/*.ts");

async function seedScholar(t: ReturnType<typeof convexTest>, username = "strandscholar") {
  return seedScholarInInstitution(t, {
    institutionId: await seedTestInstitution(t),
    name: "Strand Scholar",
    username,
  });
}

async function asUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 3_600_000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

/** Insert a knowledgeNode (procedural facet) directly, with a strand. */
async function insertNode(
  t: ReturnType<typeof convexTest>,
  node: { nodeKey: string; domain: string; strand?: string; grade?: string; order?: number },
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("knowledgeNodes", {
      nodeKey: node.nodeKey,
      label: node.nodeKey,
      domain: node.domain,
      strand: node.strand,
      grade: node.grade,
      order: node.order,
      source: "practice",
    }),
  );
}

async function insertBuildsOn(t: ReturnType<typeof convexTest>, domain: string, fromKey: string, toKey: string) {
  return await t.run(async (ctx) =>
    ctx.db.insert("knowledgeNodeEdges", { fromKey, toKey, domain, kind: "buildsOn" }),
  );
}

async function masteryRow(t: ReturnType<typeof convexTest>, scholarId: Id<"users">, skillKey: string) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("practiceMastery").collect();
    return rows.find((r) => r.scholarId === scholarId && r.skillKey === skillKey) ?? null;
  });
}

// ── strand denormalization on write ───────────────────────────────────────
describe("practiceSkills — strand denormalized onto practiceMastery", () => {
  test("recordAttempt stamps the node's strand onto a fresh mastery row", async () => {
    const t = convexTest(schema, modules);
    const domain = "denorm-attempt";
    await insertNode(t, { nodeKey: "dn1", domain, strand: "gamma" });
    const scholar = await seedScholar(t);

    await t.mutation(internal.practiceSkills.recordAttemptInternal, {
      scholarId: scholar,
      skillKey: "dn1",
      correct: true,
      domain,
    });

    const row = await masteryRow(t, scholar, "dn1");
    expect(row?.strand).toBe("gamma");
  });

  test("placeScholarInternal stamps strand on every placed-out skill", async () => {
    const t = convexTest(schema, modules);
    const domain = "denorm-placement";
    await insertNode(t, { nodeKey: "dn_k", domain, strand: "delta", grade: "K" });
    const scholar = await seedScholar(t);

    await t.mutation(internal.practiceSkills.placeScholarInternal, {
      scholarId: scholar,
      throughGrade: "K",
      domain,
    });

    const row = await masteryRow(t, scholar, "dn_k");
    expect(row?.strand).toBe("delta");
    expect(row?.source).toBe("placement");
  });
});

// Two strands, each with a fluent (fresh, so not due) skill whose updatedAt
// sets the strand's "last served" time, plus one frontier skill built on it.
// Shared by the round-robin tests below.
async function setup(t: ReturnType<typeof convexTest>) {
  const domain = "rr-domain";
  const scholar = await seedScholar(t);
  const now = Date.now();
  const DAY = 86_400_000;

  for (const [strand, done, next] of [
    ["alpha", "alpha_done", "alpha_new"],
    ["beta", "beta_done", "beta_new"],
  ] as const) {
    await insertNode(t, { nodeKey: done, domain, strand });
    await insertNode(t, { nodeKey: next, domain, strand });
    await insertBuildsOn(t, domain, done, next);
  }

  // alpha served most recently (updatedAt=now); beta is the stale strand.
  await t.run(async (ctx) => {
    await ctx.db.insert("practiceMastery", {
      scholarId: scholar, skillKey: "alpha_done", domain, strand: "alpha",
      repetition: 4, halfLifeDays: 60, lastPracticedAt: now - DAY, frontier: false,
      source: "practice", updatedAt: now,
    });
    await ctx.db.insert("practiceMastery", {
      scholarId: scholar, skillKey: "beta_done", domain, strand: "beta",
      repetition: 4, halfLifeDays: 60, lastPracticedAt: now - DAY, frontier: false,
      source: "practice", updatedAt: now - 5_000_000,
    });
  });

  return { domain, scholar };
}

// ── strand round-robin via nextForScholar ─────────────────────────────────
describe("practiceSkills — nextForScholar strand round-robin", () => {
  test("serves the least-recently-served strand's frontier first, interleaved", async () => {
    const t = convexTest(schema, modules);
    const { domain, scholar } = await setup(t);
    const asScholar = await asUser(t, scholar);

    const queue = await asScholar.query(api.practiceSkills.nextForScholar, {
      scholarId: scholar,
      domain,
      limit: 5,
    });
    const newItems = queue.filter((q) => q.reason === "new");
    // beta is stale → beta_new leads; then alpha_new. Both fluent-done skills
    // are fresh, so there are no due reviews ahead of them.
    expect(newItems.map((q) => q.key)).toEqual(["beta_new", "alpha_new"]);
    expect(newItems[0].strand).toBe("beta");
  });

  test("ignores deprecated teacher-focus data when scheduling", async () => {
    const t = convexTest(schema, modules);
    const { domain, scholar } = await setup(t);
    const asScholar = await asUser(t, scholar);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar_skill", (q) =>
          q.eq("scholarId", scholar).eq("skillKey", "alpha_done"),
        )
        .first();
      if (row) await ctx.db.patch(row._id, { teacherFocusSkillKey: "alpha_new" });
    });

    const queue = await asScholar.query(api.practiceSkills.nextForScholar, {
      scholarId: scholar,
      domain,
      limit: 5,
    });
    expect(queue.filter((q) => q.reason === "new")[0]?.key).toBe("beta_new");
  });

  test("round-robin flips after the stale strand is served (updatedAt bumped)", async () => {
    const t = convexTest(schema, modules);
    const { domain, scholar } = await setup(t);
    const asScholar = await asUser(t, scholar);

    // Practicing beta_new bumps beta's updatedAt → alpha becomes the stale one.
    await t.mutation(internal.practiceSkills.recordAttemptInternal, {
      scholarId: scholar, skillKey: "beta_new", correct: true, domain,
    });

    const queue = await asScholar.query(api.practiceSkills.nextForScholar, {
      scholarId: scholar,
      domain,
      limit: 5,
    });
    const newItems = queue.filter((q) => q.reason === "new");
    expect(newItems[0].strand).toBe("alpha"); // alpha now leads
  });
});
