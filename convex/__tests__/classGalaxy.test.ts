import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

// Why this file: the Class Galaxy is the UNION of every in-scope scholar's Sky
// (convex/concepts.ts classGalaxy). It must aggregate per-concept roles across
// scholars (litBy heat, reachedBy standards, seedFor invitations), union each
// scholar's constellation threads, count convergences (≥2 scholars), and honour
// both the institution lens (scope) and an optional scholar group (groupId).

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// ── fixtures (mirroring rabbithole-testing.md conventions) ──────────────────
async function teacher(
  t: ReturnType<typeof convexTest>,
  institutionId?: Id<"institutions">,
) {
  const userId = await seedStaffWithMembership(t, {
    institutionId: institutionId ?? (await seedTestInstitution(t)),
    name: "Teacher",
    username: "t",
  });
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 3_600_000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

async function platformAdmin(t: ReturnType<typeof convexTest>) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      name: "Platform admin",
      username: "platform-admin",
      role: "platform_admin",
    }),
  );
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 3_600_000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

async function scholar(
  t: ReturnType<typeof convexTest>,
  username: string,
  institutionId?: Id<"institutions">,
) {
  return seedScholarInInstitution(t, {
    institutionId: institutionId ?? (await seedTestInstitution(t)),
    name: username,
    username,
  });
}

/** A placed sky node (nodeKey = normalizedLabel), like conceptAtlas produces. */
async function placeNode(
  t: ReturnType<typeof convexTest>,
  label: string,
  source: string,
  extra: { standardId?: Id<"standards">; domain?: string } = {},
) {
  return t.run(async (ctx) =>
    ctx.db.insert("knowledgeNodes", {
      nodeKey: norm(label),
      label,
      normalizedLabel: norm(label),
      domain: extra.domain ?? "math",
      source,
      skyX: 40 + label.length,
      skyY: 30 + (label.length % 20),
      refCount: 1,
      standardId: extra.standardId,
    }),
  );
}

async function makeStandard(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const documentId = await ctx.db.insert("standardsDocuments", {
      asnDocumentId: "doc-1",
      title: "CCSS",
      subject: "Math",
      jurisdiction: "US",
    });
    return ctx.db.insert("standards", {
      asnId: "asn-1",
      description: "Add fractions",
      gradeLevels: ["5"],
      subject: "Math",
      statementLabel: "Standard",
      isLeaf: true,
      documentId,
    });
  });
}

async function observe(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  conceptLabel: string,
  opts: { standardIds?: Id<"standards">[]; domain?: string; level?: number } = {},
) {
  await t.run(async (ctx) => {
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      title: "S",
      isArchived: false,
    });
    await ctx.db.insert("masteryObservations", {
      scholarId,
      conceptLabel,
      domain: opts.domain ?? "math",
      observedAt: Date.now(),
      sessionId,
      transcriptExcerpt: "…",
      masteryLevel: opts.level ?? 3,
      confidenceScore: 0.9,
      evidenceSummary: "demonstrated",
      evidenceType: "demonstration",
      attemptContext: "project",
      studentInitiated: true,
      standardIds: opts.standardIds,
      isSuperseded: false,
    });
  });
}

async function plantSeed(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  topic: string,
  connectionTo?: string,
) {
  await t.run(async (ctx) =>
    ctx.db.insert("seeds", {
      scholarId,
      origin: "ai",
      status: "pending",
      topic,
      rationale: "r",
      suggestionType: "frontier",
      connectionTo,
      domain: "math",
    }),
  );
}

/**
 * Shared world (no institutions → every scholar in scope):
 *   nodes:  fractions·photosynthesis·gravity (mastery), "adding fractions"
 *           (standard S1), "cellular respiration" (seed-source placed node)
 *   A: master fractions (→S1) + photosynthesis; seed "cellular respiration"←photosynthesis (matched)
 *   B: master fractions (→S1)
 *   C: master gravity; seed "gravity waves"←gravity (unmatched → float)
 */
async function world(t: ReturnType<typeof convexTest>, institutions = false) {
  let instP: Id<"institutions"> | undefined;
  let instQ: Id<"institutions"> | undefined;
  if (institutions) {
    instP = await t.run(async (ctx) =>
      ctx.db.insert("institutions", { name: "Primary", slug: "p", kind: "school", isPrimary: true }),
    );
    instQ = await t.run(async (ctx) =>
      ctx.db.insert("institutions", { name: "Other", slug: "q", kind: "school" }),
    );
  }
  const s1 = await makeStandard(t);
  const ids = {
    fractions: await placeNode(t, "fractions", "mastery"),
    photosynthesis: await placeNode(t, "photosynthesis", "mastery", { domain: "biology" }),
    gravity: await placeNode(t, "gravity", "mastery", { domain: "physics" }),
    addFractions: await placeNode(t, "adding fractions", "standard", { standardId: s1 }),
    cellResp: await placeNode(t, "cellular respiration", "seed", { domain: "biology" }),
  };
  const a = await scholar(t, "a", instP);
  const b = await scholar(t, "b", instP);
  const c = await scholar(t, "c", instQ);

  await observe(t, a, "fractions", { standardIds: [s1] });
  await observe(t, a, "photosynthesis", { domain: "biology" });
  await observe(t, b, "fractions", { standardIds: [s1] });
  await observe(t, c, "gravity", { domain: "physics" });

  await plantSeed(t, a, "cellular respiration", "photosynthesis"); // matched → seedFor
  await plantSeed(t, c, "gravity waves", "gravity"); // unmatched → float

  return { ids, a, b, c, instP, instQ };
}

describe("classGalaxy — union of scholar skies", () => {
  test("aggregates roles, convergences, and the union of threads across scholars", async () => {
    const t = convexTest(schema, modules);
    const { ids } = await world(t);
    const asTeacher = await teacher(t);

    const g = await asTeacher.query(api.concepts.classGalaxy, { scope: "" });

    // litBy heat: fractions is a convergence (A+B), photosynthesis/gravity solo.
    expect(g.heat[ids.fractions]).toBe(2);
    expect(g.heat[ids.photosynthesis]).toBe(1);
    expect(g.heat[ids.gravity]).toBe(1);
    expect(g.convergences).toBe(1);
    expect(g.litTotal).toBe(3);
    expect(g.scholarCount).toBe(3);

    // reachedBy: the standard node A+B demonstrated toward — present, and NOT in heat.
    expect(g.reached).toContain(ids.addFractions);
    expect(g.heat[ids.addFractions]).toBeUndefined();

    // seedFor: matched seed rides its real node; unmatched seed free-floats with a
    // per-scholar-namespaced synthetic id.
    expect(g.seeds).toContain(ids.cellResp);
    const floats = g.seeds.filter((id) => id.startsWith("seed:"));
    expect(floats.length).toBe(1);
    expect(g.seedTotal).toBe(2);

    // The float node is present in `nodes` (so the ring renders); matched seeds
    // ride an existing placed node.
    const floatNode = g.nodes.find((n) => n.id === floats[0]);
    expect(floatNode).toBeTruthy();
    expect(floatNode?.source).toBe("seed");
    expect(floatNode?.label).toBe("gravity waves");

    // threads: union of mastery→standard (fractions→adding fractions, deduped
    // across A+B) and mastery→pulled-next-seed (photosynthesis→cellular respiration).
    const threadKeys = g.threads.map(([x, y]) => `${x}|${y}`).sort();
    expect(threadKeys).toEqual(
      [`${ids.fractions}|${ids.addFractions}`, `${ids.photosynthesis}|${ids.cellResp}`].sort(),
    );
  });

  test("groupId narrows the union to that group's scholars", async () => {
    const t = convexTest(schema, modules);
    const { ids, a } = await world(t);
    const asTeacher = await teacher(t);

    const groupId = await t.run(async (ctx) =>
      ctx.db.insert("scholarGroups", { teacherId: a, name: "Pod", scholarIds: [a] }),
    );

    const g = await asTeacher.query(api.concepts.classGalaxy, { scope: "", groupId });

    // Only A counts now → no convergence (fractions lit by A alone), C's gravity gone.
    expect(g.scholarCount).toBe(1);
    expect(g.heat[ids.fractions]).toBe(1);
    expect(g.heat[ids.gravity]).toBeUndefined();
    expect(g.convergences).toBe(0);
    // A's matched seed still lights; C's float is excluded.
    expect(g.seeds).toContain(ids.cellResp);
    expect(g.seeds.some((id) => id.startsWith("seed:"))).toBe(false);
  });

  test("an omitted scope resolves a non-platform staffer's active institution lens", async () => {
    const t = convexTest(schema, modules);
    const { ids, instP } = await world(t, true);
    // A teacher whose only membership is the primary institution: the home lens.
    const asTeacher = await teacher(t, instP);

    const g = await asTeacher.query(api.concepts.classGalaxy, {});

    // A + B are in the primary institution; C is in the other → excluded.
    expect(g.scholarCount).toBe(2);
    expect(g.heat[ids.fractions]).toBe(2); // A + B → still a convergence
    expect(g.convergences).toBe(1);
    expect(g.heat[ids.gravity]).toBeUndefined(); // C excluded
    // C's float seed is gone; A's matched seed remains.
    expect(g.seeds).toContain(ids.cellResp);
    expect(g.seeds.some((id) => id.startsWith("seed:"))).toBe(false);
  });

  test("a platform admin's omitted scope remains global across institutions", async () => {
    const t = convexTest(schema, modules);
    const { ids } = await world(t, true);
    const asAdmin = await platformAdmin(t);

    const g = await asAdmin.query(api.concepts.classGalaxy, {});

    // The global admin view includes the other institution's scholar and data.
    expect(g.scholarCount).toBe(3);
    expect(g.heat[ids.fractions]).toBe(2);
    expect(g.heat[ids.gravity]).toBe(1);
    expect(g.seeds.some((id) => id.startsWith("seed:"))).toBe(true);
  });
});
