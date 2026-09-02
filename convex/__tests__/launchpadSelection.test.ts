import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { instructionOfferId, strandInstructionKey, nodeInstructionKey } from "../lib/practice/instructionEntries";
import { DEMO_USERNAME } from "../seed/launchpadDemo";

// Why this file: the Launchpad's eligibility gate — a Launchpad is offered ONLY
// for a strand THE RUN ACTUALLY SERVES in the `new` lane, that the scholar has
// zero mastery in, and that has PASSED content, respecting the fire-once ledger.
// It is exercised through `practiceSession` (the real path a client takes) on a
// minimal hand-built whole-number graph, with no AI and no browser.
//
// It used to be exercised through a separate `instructionForDaily` query, which
// picked a strand by walking the graph in node order and never consulted the
// playlist -- so it could offer a doorway into a strand the run did not serve
// (reproduced on 18/18 configurations). That query is gone; `practiceSession`
// now resolves the Launchpad from its own composed items, which is why the
// "the offer always matches the run" invariant below is testable at all.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const DOMAIN = "whole-number-arithmetic";
const COUNT_KEY = "count_to_20";
const ADD_KEY = "add_within_20";
const COUNTING = "counting";
const ADD_SUB = "add-subtract";
const countingKey = strandInstructionKey(DOMAIN, COUNTING);
const addSubKey = strandInstructionKey(DOMAIN, ADD_SUB);

const workedExample = (label: string) => ({
  kind: "worked_example" as const,
  strategyLabel: label,
  steps: ["Start with 8 + 5.", "Move 2 across to make a ten.", "10 + 3 = 13."],
  examplePrompt: "Use make-a-ten to add 8 + 5.",
  exampleAnswer: "13",
});

/** A two-node whole-number graph: counting (root) → add-subtract (locked until
 *  counting is fluent). Both strands ship passed content. */
async function seedGraphAndContent(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: COUNT_KEY, label: "Count to 20", domain: DOMAIN, strand: COUNTING, order: 1,
    });
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: ADD_KEY, label: "Add within 20", domain: DOMAIN, strand: ADD_SUB, order: 2,
    });
    await ctx.db.insert("knowledgeNodeEdges", {
      fromKey: COUNT_KEY, toKey: ADD_KEY, domain: DOMAIN, kind: "buildsOn",
    });
    for (const [key, strand, title] of [
      [countingKey, COUNTING, "Count on from the bigger number"],
      [addSubKey, ADD_SUB, "Make a ten, then add the rest"],
    ] as const) {
      await ctx.db.insert("instructionContent", {
        key, domain: DOMAIN, strand, version: 1, title,
        atoms: [{ kind: "micro_explain", text: "Anchor to a friendly number first." }, workedExample(title)],
        provenance: "authored", verifyStatus: "passed", platforms: ["web"],
        createdAt: Date.now(), updatedAt: Date.now(),
      });
    }
  });
}

async function seedScholar(t: ReturnType<typeof convexTest>) {
  return seedScholarInInstitution(t, { institutionId: await seedTestInstitution(t), name: "Ada", username: "ada" });
}

async function asScholar(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 3_600_000 }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

/** A fluent (past-the-frontier) demonstrated mastery row: repetition ≥ FLUENT_REPS. */
async function seedFluent(t: ReturnType<typeof convexTest>, scholarId: Id<"users">, skillKey: string, strand: string) {
  await t.run(async (ctx) =>
    ctx.db.insert("practiceMastery", {
      scholarId, skillKey, domain: DOMAIN, strand,
      repetition: 3, halfLifeDays: 7, lastPracticedAt: Date.now(),
      frontier: false, source: "practice", updatedAt: Date.now(),
    }),
  );
}

/** Read the Launchpad off a real served run, the way a client does. */
async function launchpadFor(
  s: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>,
  scholarId: Id<"users">,
) {
  const res = await s.query(api.practiceSkills.practiceSession, {
    scholarId,
    domain: DOMAIN,
    size: 6,
    seed: 1,
  });
  return {
    launchpad: (res as { launchpad?: { at: number; entry: { key: string; kind: string; level: string; title: string; masteryEffect: string; atoms: unknown[]; target: { domain: string; strand: string } } } }).launchpad ?? null,
    items: res.items as { skillKey: string; lane?: string; domain?: string }[],
  };
}

describe("Launchpad selection on a served run", () => {
  test("REGRESSION: the offered strand is always one the run actually serves", async () => {
    // The defect this closes: the old selector named a strand by graph order,
    // so a scholar could be shown a doorway into work the run never contained.
    // Reading the strand OFF a served item makes that unrepresentable -- this
    // asserts the resulting invariant end-to-end.
    const t = convexTest(schema, modules);
    await seedGraphAndContent(t);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);

    const { launchpad, items } = await launchpadFor(s, scholarId);
    expect(launchpad).not.toBeNull();
    const anchor = items[launchpad!.at];
    expect(anchor).toBeDefined();
    // The anchor item is in the offered strand, and it is genuinely NEW work.
    expect(anchor.lane).toBe("new");
    const anchorStrand = await t.run(
      async (ctx) =>
        (
          await ctx.db
            .query("knowledgeNodes")
            .withIndex("by_nodeKey", (q) => q.eq("nodeKey", anchor.skillKey))
            .unique()
        )?.strand,
    );
    expect(anchorStrand).toBe(launchpad!.entry.target.strand);
  });


  test("offers the root new strand when the scholar has zero mastery", async () => {
    const t = convexTest(schema, modules);
    await seedGraphAndContent(t);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);

    const { launchpad } = await launchpadFor(s, scholarId);
    const entry = launchpad?.entry ?? null;
    expect(entry).not.toBeNull();
    expect(entry?.kind).toBe("launchpad");
    expect(entry?.level).toBe("strand");
    expect(entry?.key).toBe(countingKey);
    expect(entry?.target).toEqual({ domain: DOMAIN, strand: COUNTING });
    // Structural invariant: a Launchpad NEVER moves mastery.
    expect(entry?.masteryEffect).toBe("none");
    expect(entry?.atoms.length).toBeGreaterThan(0);
  });

  test("finding 7: a doorway authored for one platform only never surfaces on the other", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: COUNT_KEY, label: "Count to 20", domain: DOMAIN, strand: COUNTING, order: 1,
      });
      await ctx.db.insert("instructionContent", {
        key: countingKey, domain: DOMAIN, strand: COUNTING, version: 1,
        title: "Count on from the bigger number (native only)",
        atoms: [{ kind: "micro_explain", text: "Anchor to a friendly number first." }, workedExample("native-only")],
        provenance: "authored", verifyStatus: "passed",
        // Authored for native only — a web request must never see it.
        platforms: ["native"],
        createdAt: Date.now(), updatedAt: Date.now(),
      });
    });
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);

    // Default (no platform arg) → "web" → no doorway.
    const webResult = await s.query(api.practiceSkills.practiceSession, {
      scholarId, domain: DOMAIN, size: 6, seed: 1,
    });
    expect(webResult.launchpad).toBeUndefined();

    // The SAME run, requested as native, DOES get the doorway.
    const nativeResult = await s.query(api.practiceSkills.practiceSession, {
      scholarId, domain: DOMAIN, size: 6, seed: 1, platform: "native",
    });
    expect(nativeResult.launchpad?.entry.key).toBe(countingKey);
  });

  test("seedLaunchpadDemoScholar yields a gate-free scholar with the root Launchpad", async () => {
    const t = convexTest(schema, modules);
    await seedGraphAndContent(t);
    await t.mutation(internal.seed.launchpadDemo.seedLaunchpadDemoScholar, {});

    const scholarId = await t.run(
      async (ctx) =>
        (
          await ctx.db
            .query("users")
            .withIndex("by_username", (q) => q.eq("username", DEMO_USERNAME))
            .unique()
        )!._id,
    );

    // Structural contract: ZERO mastery (so the frontier sits at the root) + a
    // COMPLETE placement (so `needsPlacement` is false and no gate pre-empts it).
    const masteryCount = await t.run(
      async (ctx) =>
        (
          await ctx.db
            .query("practiceMastery")
            .withIndex("by_scholar_domain", (q) =>
              q.eq("scholarId", scholarId).eq("domain", DOMAIN),
            )
            .collect()
        ).length,
    );
    expect(masteryCount).toBe(0);

    const s = await asScholar(t, scholarId);
    expect(
      await s.query(api.practiceSkills.needsPlacement, { scholarId, domain: DOMAIN }),
    ).toBe(false);

    const entry = (await launchpadFor(s, scholarId)).launchpad?.entry ?? null;
    expect(entry?.kind).toBe("launchpad");
    expect(entry?.key).toBe(countingKey);
    expect(entry?.target).toEqual({ domain: DOMAIN, strand: COUNTING });
  });

  // NOTE: "the doorway advances to the next new strand once the prior one has
  // mastery" is covered as a PURE test in
  // convex/lib/practice/__tests__/instructionEntries.test.ts, not here. It is a
  // property of the selector (first new-lane item whose strand has no mastery),
  // and pinning it through `practiceSession` would really be asserting the
  // SCHEDULER's gating -- which strand it decides to serve next -- inside a
  // Launchpad test. Two of the states this file used to reach through that
  // route now serve nothing at all, which is exactly the case below.

  test("REGRESSION: no doorway when the run serves nothing", async () => {
    // The sharpest form of the closed defect. With counting fluent and
    // add-subtract still gated behind it, this scholar's run comes back EMPTY
    // -- and the retired graph-order selector still offered a Launchpad into
    // add-subtract: a doorway onto an empty room. Resolving the offer from the
    // served items makes "a doorway with no work behind it" unrepresentable.
    const t = convexTest(schema, modules);
    await seedGraphAndContent(t);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await seedFluent(t, scholarId, COUNT_KEY, COUNTING);

    const { launchpad, items } = await launchpadFor(s, scholarId);
    expect(items.length).toBe(0);
    expect(launchpad).toBeNull();
  });

  test("returns null once the offered strand has been viewed (permanent suppression)", async () => {
    const t = convexTest(schema, modules);
    await seedGraphAndContent(t);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);

    // Confirm it is offered, then view it.
    expect((await launchpadFor(s, scholarId)).launchpad?.entry.key).toBe(countingKey);
    await s.mutation(api.instruction.claimInstructionShown, { scholarId, key: countingKey });
    await s.mutation(api.instruction.recordInstructionViewed, { scholarId, key: countingKey });

    // The only eligible strand is now suppressed → nothing to offer.
    expect((await launchpadFor(s, scholarId)).launchpad).toBeNull();
  });

  test("returns null when the eligible strand has no passed content", async () => {
    const t = convexTest(schema, modules);
    // Graph only, NO instructionContent seeded.
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", { nodeKey: COUNT_KEY, label: "Count to 20", domain: DOMAIN, strand: COUNTING, order: 1 });
    });

    expect((await launchpadFor(s, scholarId)).launchpad).toBeNull();
  });

  test("a teacher reading a scholar never mints a Launchpad", async () => {
    const t = convexTest(schema, modules);
    await seedGraphAndContent(t);
    const scholarId = await seedScholar(t);
    const teacherId = await seedStaffWithMembership(t, { institutionId: await seedTestInstitution(t), name: "Ms. Frizzle", username: "friz" });
    const teacherSession = await t.run(async (ctx) =>
      ctx.db.insert("authSessions", { userId: teacherId, expirationTime: Date.now() + 3_600_000 }),
    );
    const asTeacher = t.withIdentity({ subject: `${teacherId}|${teacherSession}`, issuer: "https://convex.dev" });

    expect((await launchpadFor(asTeacher, scholarId)).launchpad).toBeNull();
  });
});

// ── The HOME PREVIEW (`playlistForScholar`) ────────────────────────────────
//
// The card calls itself "a byte-faithful stand-in for what Start will actually
// serve — no forked scheduling logic", and it listed only graded skills. So a
// scholar could be promised three skills and be served a "First look" doorway
// first: the receipt and the run disagreed by a whole beat.
//
// It is now resolved by the SAME `resolveRunLaunchpad` the run uses. These
// tests pin AGREEMENT between the two queries rather than the preview's own
// output — a second picker that merely happened to agree today is exactly the
// failure mode P1 deleted.
describe("Launchpad in the home playlist preview", () => {
  /** The card is a PRE-PLACEMENT check-in until the scholar has placed: its CTA
   *  opens the placement quiz, not the daily set, so no doorway is previewed
   *  there (Start would not serve one). These tests are about the ordinary
   *  post-placement card, so they mark the placement complete. */
  const seedPlaced = async (t: ReturnType<typeof convexTest>, scholarId: Id<"users">) => {
    await t.run(async (ctx) => {
      await ctx.db.insert("practicePlacements", {
        scholarId, domain: DOMAIN, status: "complete", probesAnswered: 1, updatedAt: Date.now(),
      });
    });
  };

  const previewFor = async (
    s: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>,
    scholarId: Id<"users">,
  ) =>
    await s.query(api.practiceSkills.playlistForScholar, { scholarId, domain: DOMAIN });

  test("the preview names the SAME doorway the run serves", async () => {
    const t = convexTest(schema, modules);
    await seedGraphAndContent(t);
    const scholarId = await seedScholar(t);
    await seedPlaced(t, scholarId);
    const s = await asScholar(t, scholarId);

    const { launchpad } = await launchpadFor(s, scholarId);
    const preview = await previewFor(s, scholarId);
    expect(launchpad).not.toBeNull();
    expect(preview.launchpad).toBeDefined();
    expect(preview.launchpad!.strand).toBe(launchpad!.entry.target.strand);
    expect(preview.launchpad!.domain).toBe(launchpad!.entry.target.domain);
    expect(preview.launchpad!.title).toBe(launchpad!.entry.title);
  });

  test("`at` indexes the preview's own `set`, and the row it precedes is in the offered strand", async () => {
    const t = convexTest(schema, modules);
    await seedGraphAndContent(t);
    const scholarId = await seedScholar(t);
    await seedPlaced(t, scholarId);
    const s = await asScholar(t, scholarId);

    const preview = await previewFor(s, scholarId);
    const at = preview.launchpad!.at;
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(preview.set.length);
    expect(preview.set[at].strand).toBe(preview.launchpad!.strand);
  });

  test("the preview ships NO atoms — the card needs a title, not the lesson", async () => {
    const t = convexTest(schema, modules);
    await seedGraphAndContent(t);
    const scholarId = await seedScholar(t);
    await seedPlaced(t, scholarId);
    const s = await asScholar(t, scholarId);

    const preview = await previewFor(s, scholarId);
    expect(preview.launchpad).toBeDefined();
    expect(Object.keys(preview.launchpad!).sort()).toEqual(["at", "domain", "strand", "title"]);
  });

  test("previewing NEVER burns the once-a-day offer", async () => {
    // The card is a subscribed home query that re-runs on every reactive tick.
    // If resolving it claimed an impression, merely LOOKING at the home page
    // would spend the doorway — so the run must still offer it afterwards, and
    // no ledger row may appear.
    const t = convexTest(schema, modules);
    await seedGraphAndContent(t);
    const scholarId = await seedScholar(t);
    await seedPlaced(t, scholarId);
    const s = await asScholar(t, scholarId);

    await previewFor(s, scholarId);
    await previewFor(s, scholarId);
    const events = await t.run(async (ctx) => await ctx.db.query("instructionEvents").collect());
    expect(events).toHaveLength(0);
    const { launchpad } = await launchpadFor(s, scholarId);
    expect(launchpad).not.toBeNull();
  });

  test("a teacher reading the card sees no doorway (it is not theirs to spend)", async () => {
    const t = convexTest(schema, modules);
    await seedGraphAndContent(t);
    const scholarId = await seedScholar(t);
    const teacherId = await seedStaffWithMembership(t, { institutionId: await seedTestInstitution(t), name: "Mr K", username: "mrk" });
    const teacher = await asScholar(t, teacherId);

    const preview = await teacher.query(api.practiceSkills.playlistForScholar, {
      scholarId,
      domain: DOMAIN,
    });
    expect(preview.launchpad).toBeUndefined();
  });

  test("a suppressed doorway disappears from the preview too", async () => {
    const t = convexTest(schema, modules);
    await seedGraphAndContent(t);
    const scholarId = await seedScholar(t);
    await seedPlaced(t, scholarId);
    const s = await asScholar(t, scholarId);

    expect((await previewFor(s, scholarId)).launchpad).toBeDefined();
    await t.run(async (ctx) => {
      await ctx.db.insert("instructionEvents", {
        scholarId, key: countingKey, offerId: instructionOfferId(scholarId, countingKey), viewedAt: Date.now(), offerCount: 1, retrievals: [],
      });
    });
    const after = await previewFor(s, scholarId);
    expect(after.launchpad).toBeUndefined();
    expect((await launchpadFor(s, scholarId)).launchpad).toBeNull();
  });

  test("the stretch preview never shows a doorway (challenge rows are not new-lane work)", async () => {
    const t = convexTest(schema, modules);
    await seedGraphAndContent(t);
    const scholarId = await seedScholar(t);
    await seedPlaced(t, scholarId);
    const s = await asScholar(t, scholarId);

    const stretch = await s.query(api.practiceSkills.playlistForScholar, {
      scholarId,
      domain: DOMAIN,
      stretchHint: true,
    });
    expect(stretch.launchpad).toBeUndefined();
  });
});

// ── The NODE doorway (§4.1, Phase 2) ───────────────────────────────────────
//
// A hard node inside an otherwise-known strand can re-open instruction even
// though the whole strand is no longer "genuinely new" — the "almost never"
// fix the node grain exists for. Exercised through the REAL `practiceSession`
// path (never a raw db read) on a 3-node graph: counting (root) →
// add-easy (add-subtract) → add-hard (add-subtract, buildsOn add-easy). The
// scholar is fluent on counting AND add-easy (so add-subtract's STRAND
// doorway is ineligible — the strand is no longer zero-mastery) but has never
// touched add-hard, which carries its OWN passed `node:` content.
const ADD_EASY_KEY = "add_easy";
const ADD_HARD_KEY = "add_hard";
const addHardNodeKey = nodeInstructionKey(ADD_HARD_KEY);

async function seedNodeDoorwayGraph(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: COUNT_KEY, label: "Count to 20", domain: DOMAIN, strand: COUNTING, order: 1,
    });
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: ADD_EASY_KEY, label: "Add easy facts", domain: DOMAIN, strand: ADD_SUB, order: 2,
    });
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: ADD_HARD_KEY, label: "Add across a ten (hard)", domain: DOMAIN, strand: ADD_SUB, order: 3,
    });
    await ctx.db.insert("knowledgeNodeEdges", {
      fromKey: COUNT_KEY, toKey: ADD_EASY_KEY, domain: DOMAIN, kind: "buildsOn",
    });
    await ctx.db.insert("knowledgeNodeEdges", {
      fromKey: ADD_EASY_KEY, toKey: ADD_HARD_KEY, domain: DOMAIN, kind: "buildsOn",
    });
    // Deliberately NO strand-level (`strand:whole-number-arithmetic:add-subtract`)
    // content -- the strand doorway must be structurally unreachable here, so a
    // node doorway firing can only be the NODE path, never a fallback strand
    // pick that happened to share a key. Only the hard node gets content.
    await ctx.db.insert("instructionContent", {
      key: addHardNodeKey, domain: DOMAIN, strand: ADD_SUB, version: 1,
      title: "Add across a ten — the hard way",
      atoms: [
        { kind: "micro_explain", text: "Split the second addend to make a ten first." },
        workedExample("Add across a ten"),
      ],
      provenance: "authored", verifyStatus: "passed", platforms: ["web", "native"],
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    // `add_hard` (unlike `count_to_20`/`add_within_20`, which are REAL
    // template-registered skillKeys) is a fictional node invented for this
    // fixture, so it needs a stored practice item to be RUNNABLE
    // (`runnableSkillKeySet` — a scheduled frontier candidate with no
    // template AND no stored item is silently filtered from `items`, which
    // would make the node doorway untestable through the real served run).
    await ctx.db.insert("practiceItems", {
      skillKey: ADD_HARD_KEY, domain: DOMAIN, stem: "Add across a ten practice item",
      answerType: "integer", answerCanonical: "12", source: "generated", verifiedAt: Date.now(),
    });
  });
}

describe("The NODE doorway (§4.1)", () => {
  test("fires for a hard node inside an otherwise-fluent (no-longer-new) strand", async () => {
    const t = convexTest(schema, modules);
    await seedNodeDoorwayGraph(t);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await seedFluent(t, scholarId, COUNT_KEY, COUNTING);
    await seedFluent(t, scholarId, ADD_EASY_KEY, ADD_SUB);

    const { launchpad, items } = await launchpadFor(s, scholarId);
    expect(launchpad).not.toBeNull();
    expect(launchpad!.entry.level).toBe("node");
    expect(launchpad!.entry.key).toBe(addHardNodeKey);
    expect(launchpad!.entry.target).toEqual({ domain: DOMAIN, strand: ADD_SUB, nodeKey: ADD_HARD_KEY });
    expect(launchpad!.entry.masteryEffect).toBe("none");
    // The anchor item is genuinely the hard node, served as new-lane work.
    const anchor = items[launchpad!.at];
    expect(anchor.skillKey).toBe(ADD_HARD_KEY);
    expect(anchor.lane).toBe("new");
  });

  test("never fires once the scholar has any mastery on the hard node itself", async () => {
    const t = convexTest(schema, modules);
    await seedNodeDoorwayGraph(t);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await seedFluent(t, scholarId, COUNT_KEY, COUNTING);
    await seedFluent(t, scholarId, ADD_EASY_KEY, ADD_SUB);
    await seedFluent(t, scholarId, ADD_HARD_KEY, ADD_SUB);

    const { launchpad } = await launchpadFor(s, scholarId);
    expect(launchpad).toBeNull();
  });

  test("respects the fire-once ledger — a dismissed node doorway stays suppressed", async () => {
    const t = convexTest(schema, modules);
    await seedNodeDoorwayGraph(t);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await seedFluent(t, scholarId, COUNT_KEY, COUNTING);
    await seedFluent(t, scholarId, ADD_EASY_KEY, ADD_SUB);

    expect((await launchpadFor(s, scholarId)).launchpad?.entry.key).toBe(addHardNodeKey);
    await s.mutation(api.instruction.claimInstructionShown, { scholarId, key: addHardNodeKey });
    await s.mutation(api.instruction.recordInstructionDismissed, { scholarId, key: addHardNodeKey });

    expect((await launchpadFor(s, scholarId)).launchpad).toBeNull();
  });

  test("the ≤1/day governor is SHARED across grains — a node shown today blocks a strand doorway, and vice versa", async () => {
    const t = convexTest(schema, modules);
    await seedNodeDoorwayGraph(t);
    // Give the strand a passed doorway too, on a domain-scoped item order that
    // would otherwise reach the node doorway only after the strand's own
    // sibling item; here we simply assert the CROSS-grain governor directly
    // via the ledger, mirroring "still suppresses when a DIFFERENT strand was
    // shown today" for the strand-only case.
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await seedFluent(t, scholarId, COUNT_KEY, COUNTING);
    await seedFluent(t, scholarId, ADD_EASY_KEY, ADD_SUB);

    // Claim the node doorway "shown" today (as the real card would on mount).
    await s.mutation(api.instruction.claimInstructionShown, { scholarId, key: addHardNodeKey });
    // A second call the same day is idempotent — still claimed (no self-retraction).
    const reclaim = await s.mutation(api.instruction.claimInstructionShown, {
      scholarId,
      key: addHardNodeKey,
    });
    expect(reclaim).toEqual({ claimed: true });

    // A DIFFERENT strand's doorway, shown the SAME day, is now held (shared cap).
    const otherStrandKey = strandInstructionKey(DOMAIN, "some-other-strand");
    const claimOther = await s.mutation(api.instruction.claimInstructionShown, {
      scholarId,
      key: otherStrandKey,
    });
    expect(claimOther).toEqual({ claimed: false, reason: "daily_cap" });
  });

  test("a teacher reading a scholar never mints a NODE doorway either", async () => {
    const t = convexTest(schema, modules);
    await seedNodeDoorwayGraph(t);
    const scholarId = await seedScholar(t);
    await seedFluent(t, scholarId, COUNT_KEY, COUNTING);
    await seedFluent(t, scholarId, ADD_EASY_KEY, ADD_SUB);
    // The teacher must have LEGITIMATE institution-scoped access (post-#1582:
    // role alone no longer reaches another user's run) — the point of this
    // test is that even a fully-authorized teacher preview never mints the
    // scholar's doorway offer.
    const institutionId = await seedTestInstitution(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(scholarId, { institutionId });
    });
    const teacherId = await seedStaffWithMembership(t, {
      institutionId,
      name: "Ms. Frizzle",
      username: "friz2",
    });
    const teacherSession = await t.run(async (ctx) =>
      ctx.db.insert("authSessions", { userId: teacherId, expirationTime: Date.now() + 3_600_000 }),
    );
    const asTeacher = t.withIdentity({ subject: `${teacherId}|${teacherSession}`, issuer: "https://convex.dev" });

    expect((await launchpadFor(asTeacher, scholarId)).launchpad).toBeNull();
  });

  test("the home preview names the SAME node doorway the run serves, and never burns the offer", async () => {
    const t = convexTest(schema, modules);
    await seedNodeDoorwayGraph(t);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await t.run(async (ctx) => {
      await ctx.db.insert("practicePlacements", {
        scholarId, domain: DOMAIN, status: "complete", probesAnswered: 1, updatedAt: Date.now(),
      });
    });
    await seedFluent(t, scholarId, COUNT_KEY, COUNTING);
    await seedFluent(t, scholarId, ADD_EASY_KEY, ADD_SUB);

    const { launchpad } = await launchpadFor(s, scholarId);
    const preview = await s.query(api.practiceSkills.playlistForScholar, { scholarId, domain: DOMAIN });
    expect(launchpad!.entry.level).toBe("node");
    expect(preview.launchpad).toBeDefined();
    expect(preview.launchpad!.strand).toBe(launchpad!.entry.target.strand);
    expect(preview.launchpad!.title).toBe(launchpad!.entry.title);

    // Previewing must not have claimed anything.
    const events = await t.run(async (ctx) => await ctx.db.query("instructionEvents").collect());
    expect(events).toHaveLength(0);
    expect((await launchpadFor(s, scholarId)).launchpad).not.toBeNull();
  });
});
