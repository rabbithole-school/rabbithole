import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { normalizeLabel } from "../concepts";
import { ONBOARDING_UNIT_SLUG } from "../onboardingData";

// ─────────────────────────────────────────────────────────────────────────
// f6 addendum — the RENDERABLE-EVIDENCE honesty invariant.
//
// Binding rule (Andy): a map gate must mean renderable evidence, honest in BOTH
// directions — if a map's OWN query would render meaningful scholar-specific
// content, the gate is open; if it would render empty, the gate is closed.
//
// This suite asserts that biconditional by calling the REAL map queries
// (api.practiceSkills.treeForScholar, api.concepts.skyFieldForScholar) and
// comparing what they RENDER against api.mapGates.mine — so a future change to a
// gate predicate, a map query, OR the seed that breaks honesty FAILS CI, not
// just today's snapshot.
//
// Two deliberate on-ramp/robustness triggers are NOT strict biconditionals and
// are handled explicitly: a `practicePlacements` row (the check-in on-ramp the
// Tree reveal fires on) always opens the Tree, and welcome-unit completion
// always opens the Sky. In every real/seeded path a completed placement
// co-writes mastery and welcome-completion co-plants seeds, so neither opens
// ahead of a rendered map — which this suite also checks.
// ─────────────────────────────────────────────────────────────────────────

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const TEST_DOMAIN = "honesty-test-domain";

// ── render predicates, derived from the REAL query OUTPUT ──────────────────

/** The Tree renders scholar-specific content when any node shows demonstrated
 *  progress (proficiency/fluency/last-practiced) — NOT the bare frontier a
 *  blank scholar also computes. */
function treeRendersContent(tree: {
  nodes: Array<{
    repetition?: number | null;
    becameFluentAt?: number | null;
    lastPracticedAt?: number | null;
  }>;
}): boolean {
  return tree.nodes.some(
    (n) =>
      (n.repetition ?? 0) > 0 ||
      n.becameFluentAt != null ||
      n.lastPracticedAt != null,
  );
}

/** The Sky renders EXPLORATION content when it lights a GOLD observation star
 *  or shows a SEED star. The night-museum layers deliberately do NOT count
 *  (Andy's ruling, 2026-07-15): the Sky gate keys off exploration evidence
 *  only — the mastery "you built this" floats (seedMeta kind "mastery",
 *  which also merge into `lit`) and the starter warmth layer (kind
 *  "starter") are decoration on an already-earned sky, never what reveals
 *  it. So gold-lit = litCount minus the mastery floats. */
function skyRendersContent(sky: {
  litCount?: number;
  seeds?: unknown[];
  seedMeta?: Record<string, { kind?: string }>;
}): boolean {
  const meta = Object.values(sky.seedMeta ?? {});
  const masteryFloats = meta.filter((m) => m.kind === "mastery").length;
  const goldLit = (sky.litCount ?? 0) - masteryFloats;
  return (
    goldLit > 0 ||
    (sky.seeds?.length ?? 0) > 0 ||
    meta.some((m) => m.kind === "seed")
  );
}

// ── fixtures ───────────────────────────────────────────────────────────────

async function seedScholar(t: ReturnType<typeof convexTest>, username: string) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: username, username, role: "scholar" }),
  );
}

async function asScholar(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 3_600_000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

/** A minimal practice tree graph (n1 → n2) so treeForScholar renders nodes. */
async function seedPracticeGraph(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: "n1",
      label: "Node One",
      domain: TEST_DOMAIN,
      source: "practice",
      order: 0,
    });
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: "n2",
      label: "Node Two",
      domain: TEST_DOMAIN,
      source: "practice",
      order: 1,
    });
    await ctx.db.insert("knowledgeNodeEdges", {
      fromKey: "n1",
      toKey: "n2",
      domain: TEST_DOMAIN,
      kind: "buildsOn",
    });
  });
}

/** A PLACED atlas node (skyX/skyY set) whose normalized label an observation
 *  can light. Returns the concept label to observe. */
async function seedPlacedAtlasNode(
  t: ReturnType<typeof convexTest>,
  label: string,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: `atlas:${label}`,
      label,
      normalizedLabel: normalizeLabel(label),
      domain: "exploration",
      source: "concept",
      skyX: 50,
      skyY: 50,
    });
  });
  return label;
}

async function addMasteryProgress(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
) {
  await t.run(async (ctx) =>
    ctx.db.insert("practiceMastery", {
      scholarId,
      skillKey: "n1",
      domain: TEST_DOMAIN,
      repetition: 3,
      halfLifeDays: 5,
      lastPracticedAt: Date.now(),
      frontier: false,
      source: "practice",
      updatedAt: Date.now(),
    }),
  );
}

async function addPlacement(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
) {
  await t.run(async (ctx) =>
    ctx.db.insert("practicePlacements", {
      scholarId,
      domain: TEST_DOMAIN,
      status: "in_progress",
      probesAnswered: 0,
      updatedAt: Date.now(),
    }),
  );
}

async function addSeed(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  status: "pending" | "active" | "dismissed" | "completed" = "pending",
) {
  await t.run(async (ctx) =>
    ctx.db.insert("seeds", {
      scholarId,
      origin: "ai",
      status,
      topic: "Why do kettles boil faster up a mountain?",
      suggestionType: "leap",
      rationale: "curiosity",
    }),
  );
}

async function addObservation(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  conceptLabel: string,
) {
  await t.run(async (ctx) =>
    ctx.db.insert("masteryObservations", {
      scholarId,
      conceptLabel,
      domain: "exploration",
      observedAt: Date.now(),
      transcriptExcerpt: "…",
      masteryLevel: 2,
      confidenceScore: 0.8,
      evidenceSummary: "showed the idea",
      evidenceType: "direct_demonstration",
      attemptContext: "session",
      studentInitiated: false,
      isSuperseded: false,
    }),
  );
}

async function addWelcomeBadge(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
) {
  await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      title: "Welcome to Rabbithole",
      slug: ONBOARDING_UNIT_SLUG,
      isActive: true,
      teacherId: scholarId,
      badgeOnCompletion: { title: "Explorer's Compass", icon: "🧭" },
    } as never);
    await ctx.db.insert("scholarUnitBadges", {
      scholarId,
      unitId,
      earnedAt: Date.now(),
      badgeSnapshot: { title: "Explorer's Compass", icon: "🧭" },
    });
  });
}

// Call the real queries + the gate for one scholar.
async function inspect(t: ReturnType<typeof convexTest>, scholarId: Id<"users">) {
  const me = await asScholar(t, scholarId);
  const tree = await me.query(api.practiceSkills.treeForScholar, {
    scholarId,
    domain: TEST_DOMAIN,
  });
  const sky = await me.query(api.concepts.skyFieldForScholar, { scholarId });
  const gate = await me.query(api.mapGates.mine, {});
  // Read placement without a typed index — the helper's `t` is schema-unbound,
  // so `.withIndex` wouldn't typecheck here; the test table is tiny.
  const placements = await t.run(async (ctx) =>
    ctx.db.query("practicePlacements").collect(),
  );
  const hasPlacement = placements.some((p) => p.scholarId === scholarId);
  return {
    treeRenders: treeRendersContent(tree),
    skyRenders: skyRendersContent(sky),
    gate,
    hasPlacement,
  };
}

/** Assert the honesty biconditional for one scholar (with the two documented
 *  on-ramp exceptions: placement always opens the Tree; a welcome badge always
 *  opens the Sky). */
function assertHonest(
  label: string,
  s: {
    treeRenders: boolean;
    skyRenders: boolean;
    gate: { sky: boolean; tree: boolean };
    hasPlacement: boolean;
    hasWelcomeBadge?: boolean;
  },
) {
  // Never lock a map that renders content (the critical direction Andy flagged).
  if (s.treeRenders) {
    expect(s.gate.tree, `${label}: tree renders but is LOCKED`).toBe(true);
  }
  if (s.skyRenders) {
    expect(s.gate.sky, `${label}: sky renders but is LOCKED`).toBe(true);
  }
  // Never unlock an empty map — except the placement on-ramp (Tree) / welcome
  // trigger (Sky).
  if (s.gate.tree && !s.treeRenders) {
    expect(s.hasPlacement, `${label}: tree UNLOCKED but empty & no placement`).toBe(
      true,
    );
  }
  if (s.gate.sky && !s.skyRenders) {
    expect(
      s.hasWelcomeBadge ?? false,
      `${label}: sky UNLOCKED but empty & no welcome badge`,
    ).toBe(true);
  }
}

// ── archetype biconditional ──────────────────────────────────────────────

describe("map gates — renderable-evidence honesty (archetypes)", () => {
  test("blank scholar: both maps render empty and are locked", async () => {
    const t = convexTest(schema, modules);
    await seedPracticeGraph(t);
    const id = await seedScholar(t, "blank");
    const s = await inspect(t, id);
    expect(s.treeRenders).toBe(false);
    expect(s.skyRenders).toBe(false);
    expect(s.gate.sky).toBe(false);
    expect(s.gate.tree).toBe(false);
    assertHonest("blank", s);
  });

  test("mastery-with-progress: tree renders → tree unlocked (sky stays locked — fluency isn't exploration)", async () => {
    const t = convexTest(schema, modules);
    await seedPracticeGraph(t);
    const id = await seedScholar(t, "driller");
    await addMasteryProgress(t, id);
    const s = await inspect(t, id);
    expect(s.treeRenders).toBe(true);
    expect(s.gate.tree).toBe(true);
    // The fixture row is demonstrated-fluent, so the sky QUERY would render a
    // night-museum mastery float — but museum layers are decoration, not
    // exploration evidence (see skyRendersContent), so a pure driller's sky
    // stays locked. No seeds/lit observations → renders no exploration
    // content → locked (honest).
    expect(s.skyRenders).toBe(false);
    expect(s.gate.sky).toBe(false);
    assertHonest("driller", s);
  });

  test("placement-only (mid check-in, no mastery): tree gate opens via the on-ramp", async () => {
    const t = convexTest(schema, modules);
    await seedPracticeGraph(t);
    const id = await seedScholar(t, "placing");
    await addPlacement(t, id);
    const s = await inspect(t, id);
    expect(s.gate.tree).toBe(true);
    expect(s.hasPlacement).toBe(true);
    assertHonest("placing", s);
  });

  test("seed-only: sky shows a seed star → sky unlocked (tree stays locked)", async () => {
    const t = convexTest(schema, modules);
    await seedPracticeGraph(t);
    const id = await seedScholar(t, "curious");
    await addSeed(t, id);
    const s = await inspect(t, id);
    expect(s.skyRenders).toBe(true);
    expect(s.gate.sky).toBe(true);
    expect(s.treeRenders).toBe(false);
    expect(s.gate.tree).toBe(false);
    assertHonest("curious", s);
  });

  test("dismissed/completed seed ONLY: sky renders empty → LOCKED (#929)", async () => {
    // buildScholarAtlas renders only pending/active seeds, so a scholar whose
    // only seed is dismissed or completed has an empty sky — the gate must stay
    // locked (a status-blind "any seed" read would falsely unlock it).
    const t = convexTest(schema, modules);
    await seedPracticeGraph(t);
    const id = await seedScholar(t, "spent");
    await addSeed(t, id, "dismissed");
    await addSeed(t, id, "completed");
    const s = await inspect(t, id);
    expect(s.skyRenders).toBe(false);
    expect(s.gate.sky).toBe(false);
    assertHonest("spent", s);
  });

  test("observation on a PLACED atlas node: sky lights → sky unlocked", async () => {
    const t = convexTest(schema, modules);
    await seedPracticeGraph(t);
    const label = await seedPlacedAtlasNode(t, "Photosynthesis");
    const id = await seedScholar(t, "litstar");
    await addObservation(t, id, label);
    const s = await inspect(t, id);
    expect(s.skyRenders).toBe(true);
    expect(s.gate.sky).toBe(true);
    assertHonest("litstar", s);
  });

  test("observation with NO placed atlas node (unprojected sky): renders empty → LOCKED", async () => {
    // The deployment-faithful case: on a worktree the atlas isn't projected, so
    // an observation lights nothing and the sky must stay locked.
    const t = convexTest(schema, modules);
    await seedPracticeGraph(t);
    const id = await seedScholar(t, "darkobs");
    await addObservation(t, id, "Some Concept With No Placed Node");
    const s = await inspect(t, id);
    expect(s.skyRenders).toBe(false);
    expect(s.gate.sky).toBe(false); // honest: empty sky ⇒ locked
    assertHonest("darkobs", s);
  });

  test("welcome badge + planted seed (real onboarding path): sky unlocked & renders", async () => {
    const t = convexTest(schema, modules);
    await seedPracticeGraph(t);
    const id = await seedScholar(t, "graduate");
    await addWelcomeBadge(t, id);
    await addSeed(t, id); // the observer plants seeds during the welcome quest
    const s = await inspect(t, id);
    expect(s.skyRenders).toBe(true);
    expect(s.gate.sky).toBe(true);
    assertHonest("graduate", { ...s, hasWelcomeBadge: true });
  });

  test("bare welcome badge (no seeds): sky opens via the documented trigger", async () => {
    const t = convexTest(schema, modules);
    await seedPracticeGraph(t);
    const id = await seedScholar(t, "bare-grad");
    await addWelcomeBadge(t, id);
    const s = await inspect(t, id);
    expect(s.gate.sky).toBe(true);
    assertHonest("bare-grad", { ...s, hasWelcomeBadge: true });
  });

  test("rich scholar (mastery + seed + lit observation): both maps render & unlock", async () => {
    const t = convexTest(schema, modules);
    await seedPracticeGraph(t);
    const label = await seedPlacedAtlasNode(t, "Fractions");
    const id = await seedScholar(t, "rich");
    await addMasteryProgress(t, id);
    await addSeed(t, id);
    await addObservation(t, id, label);
    const s = await inspect(t, id);
    expect(s.treeRenders).toBe(true);
    expect(s.skyRenders).toBe(true);
    expect(s.gate.sky).toBe(true);
    expect(s.gate.tree).toBe(true);
    assertHonest("rich", s);
  });
});

// ── over the actual rich-cohort seed ───────────────────────────────────────

describe("map gates — honesty over the rich-cohort seed", () => {
  test("every seeded scholar's gate matches what its map queries render", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) =>
      ctx.runMutation(internal.seedRichCohort.seedAll, {}),
    );

    const scholars = await t.run(async (ctx) =>
      ctx.db
        .query("users")
        .withIndex("by_role", (q) => q.eq("role", "scholar"))
        .collect(),
    );
    expect(scholars.length).toBeGreaterThan(0);

    for (const scholar of scholars) {
      const me = await asScholar(t, scholar._id);
      // The seed builds no practice graph, so the Tree renders empty for all —
      // and none have mastery/placement, so all Tree gates are closed (honest).
      const tree = await me.query(api.practiceSkills.treeForScholar, {
        scholarId: scholar._id,
        allDomains: true,
      });
      const sky = await me.query(api.concepts.skyFieldForScholar, {
        scholarId: scholar._id,
      });
      const gate = await me.query(api.mapGates.mine, {});
      const placement = await t.run(async (ctx) =>
        ctx.db
          .query("practicePlacements")
          .withIndex("by_scholar_domain", (q) => q.eq("scholarId", scholar._id))
          .first(),
      );
      const badge = await t.run(async (ctx) => {
        const unit = await ctx.db
          .query("units")
          .withIndex("by_slug", (q) => q.eq("slug", ONBOARDING_UNIT_SLUG))
          .first();
        if (!unit) return null;
        return ctx.db
          .query("scholarUnitBadges")
          .withIndex("by_scholar_unit", (q) =>
            q.eq("scholarId", scholar._id).eq("unitId", unit._id),
          )
          .first();
      });

      assertHonest(`seed:${scholar.username ?? scholar._id}`, {
        treeRenders: treeRendersContent(tree),
        skyRenders: skyRendersContent(sky),
        gate,
        hasPlacement: placement !== null,
        hasWelcomeBadge: badge !== null,
      });
    }
  });
});
