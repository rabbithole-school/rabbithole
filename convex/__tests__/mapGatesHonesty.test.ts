import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
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
// (api.practiceSkills.treeForScholar, and api.skyStars.forSelf — the kid's own
// Sky both clients draw) and comparing what they RENDER against
// api.mapGates.mine — so a future change to a gate predicate, a map query, OR
// the seed that breaks honesty FAILS CI, not just today's snapshot.
//
// The Sky is a strict biconditional: unlocked exactly when forSelf draws a
// star (TRA-708). One deliberate on-ramp is not, and is handled explicitly: a
// `practicePlacements` row (the check-in on-ramp the Tree reveal fires on)
// always opens the Tree. In every real/seeded path a completed placement
// co-writes mastery, so it never opens ahead of a rendered map.
// ─────────────────────────────────────────────────────────────────────────

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const TEST_DOMAIN = "honesty-test-domain";

type T = ReturnType<typeof convexTest>;

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

/** The kid's own Sky renders content when it draws at least one star. */
function skyRendersContent(stars: unknown[]): boolean {
  return stars.length > 0;
}

// ── fixtures ───────────────────────────────────────────────────────────────

async function seedUser(t: T, username: string, role: Doc<"users">["role"] = "scholar") {
  return await t.run(async (ctx) => ctx.db.insert("users", { name: username, username, role }));
}

async function asUser(t: T, userId: Id<"users">) {
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
async function seedPracticeGraph(t: T) {
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

async function addMasteryProgress(t: T, scholarId: Id<"users">) {
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

async function addPlacement(t: T, scholarId: Id<"users">) {
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

type StarRow = { hidden?: boolean; placed?: boolean };

function starRowFields({ hidden = false, placed = true }: StarRow) {
  return { ...(hidden ? { hidden: true } : {}), ...(placed ? { x: 3, y: 5 } : {}) };
}

/** A wonder the kid asked (seed + chat) and its row on their Sky. */
async function addWonderStar(
  t: T,
  scholarId: Id<"users">,
  row: StarRow = {},
  chat: Partial<Doc<"sessions">> = {},
) {
  await t.run(async (ctx) => {
    const seedId = await ctx.db.insert("seeds", {
      scholarId,
      origin: "wonder",
      status: "active",
      topic: "How do bees find their way home?",
      suggestionType: "frontier",
      rationale: "",
    });
    await ctx.db.insert("sessions", {
      userId: scholarId,
      seedId,
      title: "Bees",
      isArchived: false,
      ...chat,
    });
    await ctx.db.insert("skyStars", {
      scholarId,
      seedId,
      label: "Bees finding home",
      ...starRowFields(row),
    });
  });
}

/** One of the kid's own older Quests that they wrote in, and its row. */
async function addQuestStar(t: T, scholarId: Id<"users">, row: StarRow = {}) {
  await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId: scholarId,
      title: "My bee maze game",
      isActive: true,
      authorScholarId: scholarId,
      authorRole: "author",
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      unitId,
      title: "My bee maze game",
      isArchived: false,
    });
    await ctx.db.insert("messages", {
      sessionId,
      role: "user",
      content: "I want the bees to dodge the spiders",
      flagged: false,
    });
    await ctx.db.insert("skyStars", {
      scholarId,
      unitId,
      label: "Bee maze game",
      ...starRowFields(row),
    });
  });
}

/** Everything the OLD Sky unlocked on: a live suggestion seed, an observation
 *  lighting a placed atlas node, and the Welcome unit's badge. */
async function addOldSkyEvidence(t: T, scholarId: Id<"users">) {
  await t.run(async (ctx) => {
    await ctx.db.insert("seeds", {
      scholarId,
      origin: "ai",
      status: "pending",
      topic: "Why do kettles boil faster up a mountain?",
      suggestionType: "leap",
      rationale: "curiosity",
    });
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: "atlas:Photosynthesis",
      label: "Photosynthesis",
      normalizedLabel: normalizeLabel("Photosynthesis"),
      domain: "exploration",
      source: "concept",
      skyX: 50,
      skyY: 50,
    });
    await ctx.db.insert("masteryObservations", {
      scholarId,
      conceptLabel: "Photosynthesis",
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
    });
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
async function inspect(t: T, scholarId: Id<"users">) {
  const me = await asUser(t, scholarId);
  const tree = await me.query(api.practiceSkills.treeForScholar, {
    scholarId,
    domain: TEST_DOMAIN,
  });
  const stars = await me.query(api.skyStars.forSelf, {});
  const gate = await me.query(api.mapGates.mine, {});
  // Read placement without a typed index — the helper's `t` is schema-unbound,
  // so `.withIndex` wouldn't typecheck here; the test table is tiny.
  const placements = await t.run(async (ctx) =>
    ctx.db.query("practicePlacements").collect(),
  );
  const hasPlacement = placements.some((p) => p.scholarId === scholarId);
  return {
    treeRenders: treeRendersContent(tree),
    skyRenders: skyRendersContent(stars),
    gate,
    hasPlacement,
  };
}

/** Assert the honesty biconditional for one scholar: the Sky strictly, the
 *  Tree with its one documented on-ramp (placement always opens it). */
function assertHonest(
  label: string,
  s: {
    treeRenders: boolean;
    skyRenders: boolean;
    gate: { sky: boolean; tree: boolean };
    hasPlacement: boolean;
  },
) {
  expect(s.gate.sky, `${label}: Sky gate disagrees with what the Sky draws`).toBe(
    s.skyRenders,
  );
  // Never lock a Tree that renders content (the critical direction Andy flagged).
  if (s.treeRenders) {
    expect(s.gate.tree, `${label}: tree renders but is LOCKED`).toBe(true);
  }
  // Never unlock an empty Tree, except through the placement on-ramp.
  if (s.gate.tree && !s.treeRenders) {
    expect(s.hasPlacement, `${label}: tree UNLOCKED but empty & no placement`).toBe(
      true,
    );
  }
}

// ── archetype biconditional ──────────────────────────────────────────────

describe("map gates — renderable-evidence honesty (archetypes)", () => {
  test("blank scholar: both maps render empty and are locked", async () => {
    const t = convexTest(schema, modules);
    await seedPracticeGraph(t);
    const id = await seedUser(t, "blank");
    const s = await inspect(t, id);
    expect(s.treeRenders).toBe(false);
    expect(s.skyRenders).toBe(false);
    expect(s.gate.sky).toBe(false);
    expect(s.gate.tree).toBe(false);
    assertHonest("blank", s);
  });

  test("mastery-with-progress: tree renders → tree unlocked (sky stays locked)", async () => {
    const t = convexTest(schema, modules);
    await seedPracticeGraph(t);
    const id = await seedUser(t, "driller");
    await addMasteryProgress(t, id);
    const s = await inspect(t, id);
    expect(s.treeRenders).toBe(true);
    expect(s.gate.tree).toBe(true);
    expect(s.skyRenders).toBe(false);
    expect(s.gate.sky).toBe(false);
    assertHonest("driller", s);
  });

  test("placement-only (mid check-in, no mastery): tree gate opens via the on-ramp", async () => {
    const t = convexTest(schema, modules);
    await seedPracticeGraph(t);
    const id = await seedUser(t, "placing");
    await addPlacement(t, id);
    const s = await inspect(t, id);
    expect(s.gate.tree).toBe(true);
    expect(s.hasPlacement).toBe(true);
    assertHonest("placing", s);
  });

  test("a wonder star: the Sky draws it → Sky unlocked (tree stays locked)", async () => {
    const t = convexTest(schema, modules);
    await seedPracticeGraph(t);
    const id = await seedUser(t, "curious");
    await addWonderStar(t, id);
    const s = await inspect(t, id);
    expect(s.skyRenders).toBe(true);
    expect(s.gate.sky).toBe(true);
    expect(s.gate.tree).toBe(false);
    assertHonest("curious", s);
  });

  test("a Quest star: the Sky draws it → Sky unlocked", async () => {
    const t = convexTest(schema, modules);
    await seedPracticeGraph(t);
    const id = await seedUser(t, "builder");
    await addQuestStar(t, id);
    const s = await inspect(t, id);
    expect(s.skyRenders).toBe(true);
    expect(s.gate.sky).toBe(true);
    assertHonest("builder", s);
  });

  test("hidden and not-yet-placed rows only: Sky draws nothing → LOCKED", async () => {
    const t = convexTest(schema, modules);
    await seedPracticeGraph(t);
    const id = await seedUser(t, "waiting");
    await addWonderStar(t, id, { hidden: true });
    await addWonderStar(t, id, { placed: false });
    await addQuestStar(t, id, { placed: false });
    const s = await inspect(t, id);
    expect(s.skyRenders).toBe(false);
    expect(s.gate.sky).toBe(false);
    assertHonest("waiting", s);
  });

  test("a placed row whose chat no longer counts (a test drive): Sky draws nothing → LOCKED", async () => {
    const t = convexTest(schema, modules);
    await seedPracticeGraph(t);
    const id = await seedUser(t, "rehearsal");
    await addWonderStar(t, id, {}, { isTestDrive: true });
    const s = await inspect(t, id);
    expect(s.skyRenders).toBe(false);
    expect(s.gate.sky).toBe(false);
    assertHonest("rehearsal", s);
  });

  test("the old Sky's evidence only (seed, atlas light, Welcome badge): Sky draws nothing → LOCKED", async () => {
    const t = convexTest(schema, modules);
    await seedPracticeGraph(t);
    const id = await seedUser(t, "oldsky");
    await addOldSkyEvidence(t, id);
    const s = await inspect(t, id);
    expect(s.skyRenders).toBe(false);
    expect(s.gate.sky).toBe(false);
    assertHonest("oldsky", s);
  });

  test("rich scholar (mastery + a star + old evidence): both maps render & unlock", async () => {
    const t = convexTest(schema, modules);
    await seedPracticeGraph(t);
    const id = await seedUser(t, "rich");
    await addMasteryProgress(t, id);
    await addOldSkyEvidence(t, id);
    await addWonderStar(t, id, { hidden: true });
    await addQuestStar(t, id);
    const s = await inspect(t, id);
    expect(s.treeRenders).toBe(true);
    expect(s.skyRenders).toBe(true);
    expect(s.gate.sky).toBe(true);
    expect(s.gate.tree).toBe(true);
    assertHonest("rich", s);
  });

  test("not a scholar: the Sky draws nothing for them → Sky locked, even with a placed row", async () => {
    const t = convexTest(schema, modules);
    const id = await seedUser(t, "grownup", "teacher");
    await addWonderStar(t, id);
    const me = await asUser(t, id);
    const stars = await me.query(api.skyStars.forSelf, {});
    const gate = await me.query(api.mapGates.mine, {});
    expect(skyRendersContent(stars)).toBe(false);
    expect(gate.sky).toBe(false);
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
      const me = await asUser(t, scholar._id);
      // The seed builds no practice graph, so the Tree renders empty for all —
      // and none have mastery/placement, so all Tree gates are closed (honest).
      const tree = await me.query(api.practiceSkills.treeForScholar, {
        scholarId: scholar._id,
        allDomains: true,
      });
      const stars = await me.query(api.skyStars.forSelf, {});
      const gate = await me.query(api.mapGates.mine, {});
      const placement = await t.run(async (ctx) =>
        ctx.db
          .query("practicePlacements")
          .withIndex("by_scholar_domain", (q) => q.eq("scholarId", scholar._id))
          .first(),
      );

      assertHonest(`seed:${scholar.username ?? scholar._id}`, {
        treeRenders: treeRendersContent(tree),
        skyRenders: skyRendersContent(stars),
        gate,
        hasPlacement: placement !== null,
      });
    }
  });
});
