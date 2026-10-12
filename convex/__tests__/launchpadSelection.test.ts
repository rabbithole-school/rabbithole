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

// Why this file: the "Can you already do this?" frame's eligibility gate,
// exercised through `practiceSession` (the real path a client takes) on a
// minimal hand-built whole-number graph, with no AI and no browser.
//
// A frame is offered ONLY for an item THE RUN ACTUALLY SERVES, on a node the
// scholar has never attempted, that has an ON-TOPIC move: the item's own
// teaching step, else passed node-grain content. Strand content is never the
// move (2026-10-10: "Make 45¢ out of nickels and dimes" — a skip-count node
// filed under mult-divide — showed the strand's "4 × 3 eggs" lesson).
//
// It used to be exercised through a separate `instructionForDaily` query, which
// picked a strand by graph order and never consulted the playlist -- so it
// could offer a doorway into a strand the run did not serve (18/18
// configurations). `practiceSession` resolves the frame from its own items.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const DOMAIN = "whole-number-arithmetic";
/** Real template skill with NO worked steps ("What number comes right after 7?"). */
const COUNT_KEY = "count_to_20";
/** Real template skill whose every item carries make-a-ten worked steps. */
const STEPS_KEY = "add_within_20_regroup";
const ADD_KEY = "add_within_20";
const COUNTING = "counting";
const ADD_SUB = "add-subtract";
const countingKey = strandInstructionKey(DOMAIN, COUNTING);
const addSubKey = strandInstructionKey(DOMAIN, ADD_SUB);
const stepsNodeKey = nodeInstructionKey(STEPS_KEY);

const workedExample = (label: string) => ({
  kind: "worked_example" as const,
  strategyLabel: label,
  steps: ["Start with 8 + 5.", "Move 2 across to make a ten.", "10 + 3 = 13."],
  examplePrompt: "Use make-a-ten to add 8 + 5.",
  exampleAnswer: "13",
});

/** Passed STRAND content for both strands — the content that must never be
 *  the move. */
async function seedStrandContent(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    for (const [key, strand, title] of [
      [countingKey, COUNTING, "Count on from the bigger number"],
      [addSubKey, ADD_SUB, "Make a ten, then add the rest"],
    ] as const) {
      await ctx.db.insert("instructionContent", {
        key, domain: DOMAIN, strand, version: 1, title,
        atoms: [{ kind: "micro_explain", text: "Anchor to a friendly number first." }, workedExample(title)],
        provenance: "authored", verifyStatus: "passed", platforms: ["web", "native"],
        createdAt: Date.now(), updatedAt: Date.now(),
      });
    }
  });
}

/** Two ROOT nodes, both served new: counting (no worked steps) ordered first,
 *  then the make-a-ten regroup node (worked steps on every item). Both strands
 *  ship passed strand content. */
async function seedGraphAndContent(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: COUNT_KEY, label: "Count to 20", domain: DOMAIN, strand: COUNTING, order: 1,
    });
    await ctx.db.insert("knowledgeNodes", {
      nodeKey: STEPS_KEY, label: "Add within 20 across a ten", domain: DOMAIN, strand: ADD_SUB, order: 2,
    });
  });
  await seedStrandContent(t);
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

type WireEntry = {
  key: string;
  kind: string;
  level: string;
  move?: string;
  title: string;
  masteryEffect: string;
  atoms: { kind: string }[];
  target: { domain: string; strand: string; nodeKey?: string };
};

/** Read the frame off a real served run, the way a client does. */
async function launchpadFor(
  s: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>,
  scholarId: Id<"users">,
  platform?: "web" | "native",
  /** false = an older installed iPad build (no `questionFraming` flag). */
  questionFraming = true,
) {
  const res = await s.query(api.practiceSkills.practiceSession, {
    scholarId,
    domain: DOMAIN,
    size: 6,
    seed: 1,
    ...(platform ? { platform } : {}),
    ...(questionFraming ? { questionFraming: true } : {}),
  });
  return {
    launchpad: (res as { launchpad?: { at: number; entry: WireEntry } }).launchpad ?? null,
    items: res.items as { itemId: string; skillKey: string; lane?: string; domain?: string }[],
  };
}

describe("The framed item on a served run", () => {
  test("REGRESSION: the framed item is always one the run actually serves", async () => {
    const t = convexTest(schema, modules);
    await seedGraphAndContent(t);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);

    const { launchpad, items } = await launchpadFor(s, scholarId);
    expect(launchpad).not.toBeNull();
    const anchor = items[launchpad!.at];
    expect(anchor).toBeDefined();
    expect(anchor.lane).toBe("new");
    expect(anchor.skillKey).toBe(launchpad!.entry.target.nodeKey);
  });

  test("frames the item with its OWN teaching step; strand content never makes an item framable", async () => {
    const t = convexTest(schema, modules);
    await seedGraphAndContent(t);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);

    const { launchpad, items } = await launchpadFor(s, scholarId);
    // counting is served first and has strand content — but no worked steps
    // and no node content, so it is NOT framed. The regroup item is.
    expect(items.some((i) => i.skillKey === COUNT_KEY)).toBe(true);
    const entry = launchpad?.entry ?? null;
    expect(entry?.kind).toBe("launchpad");
    expect(entry?.level).toBe("node");
    expect(entry?.move).toBe("item_steps");
    expect(entry?.key).toBe(stepsNodeKey);
    expect(entry?.target).toEqual({ domain: DOMAIN, strand: ADD_SUB, nodeKey: STEPS_KEY });
    expect(items[launchpad!.at].skillKey).toBe(STEPS_KEY);
    // The move is the item's TeachingStep, so the entry carries no atoms —
    // the strand's lesson can't leak in.
    expect(entry?.atoms).toEqual([]);
    // Structural invariant: a frame NEVER moves mastery.
    expect(entry?.masteryEffect).toBe("none");
  });

  test("the framed item's 'Not yet' lands on a real teaching step for THAT item", async () => {
    // Precedence (a) reuses `teachingStep` verbatim: after the honest
    // don't-know on the framed item, the query hands back its faded steps.
    const t = convexTest(schema, modules);
    await seedGraphAndContent(t);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);

    const { launchpad, items } = await launchpadFor(s, scholarId);
    const itemId = items[launchpad!.at].itemId;
    await s.mutation(api.practiceSkills.submitAnswer, { scholarId, itemId, answer: "", dontKnow: true });
    const step = await s.query(api.practiceSkills.teachingStep, { scholarId, itemId });
    expect(step.steps?.revealed.length).toBeGreaterThan(0);
    expect(step.steps?.faded.length).toBe(1);
  });

  test("no frame when no served item has an on-topic move, even with strand content everywhere", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: COUNT_KEY, label: "Count to 20", domain: DOMAIN, strand: COUNTING, order: 1,
      });
    });
    await seedStrandContent(t);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);

    const { launchpad, items } = await launchpadFor(s, scholarId);
    expect(items.length).toBeGreaterThan(0);
    expect(launchpad).toBeNull();
  });

  test("finding 7: node content authored for one platform only never surfaces on the other", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: COUNT_KEY, label: "Count to 20", domain: DOMAIN, strand: COUNTING, order: 1,
      });
      await ctx.db.insert("instructionContent", {
        key: nodeInstructionKey(COUNT_KEY), domain: DOMAIN, strand: COUNTING, version: 1,
        title: "Count on (native only)",
        atoms: [{ kind: "micro_explain", text: "Say the next number." }, workedExample("native-only")],
        provenance: "authored", verifyStatus: "passed",
        platforms: ["native"],
        createdAt: Date.now(), updatedAt: Date.now(),
      });
    });
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);

    expect((await launchpadFor(s, scholarId)).launchpad).toBeNull();
    expect((await launchpadFor(s, scholarId, "native")).launchpad?.entry.key).toBe(nodeInstructionKey(COUNT_KEY));
  });

  test("seedLaunchpadDemoScholar yields a gate-free scholar on the root (no frame: counting has no on-topic move)", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: COUNT_KEY, label: "Count to 20", domain: DOMAIN, strand: COUNTING, order: 1,
      });
    });
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
    // The seeder (re)seeds the authored STRAND content; the root counting item
    // has no worked steps, so the frame correctly stays off.
    expect((await launchpadFor(s, scholarId)).launchpad).toBeNull();
  });

  test("REGRESSION: no frame when the run serves nothing", async () => {
    const t = convexTest(schema, modules);
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
    });
    await seedStrandContent(t);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await seedFluent(t, scholarId, COUNT_KEY, COUNTING);

    const { launchpad, items } = await launchpadFor(s, scholarId);
    expect(items.length).toBe(0);
    expect(launchpad).toBeNull();
  });

  test("returns null once the framed node's move has been viewed (permanent suppression)", async () => {
    const t = convexTest(schema, modules);
    await seedGraphAndContent(t);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);

    expect((await launchpadFor(s, scholarId)).launchpad?.entry.key).toBe(stepsNodeKey);
    await s.mutation(api.instruction.claimInstructionShown, { scholarId, key: stepsNodeKey, framing: "question" });
    await s.mutation(api.instruction.recordInstructionViewed, { scholarId, key: stepsNodeKey, framing: "question" });

    expect((await launchpadFor(s, scholarId)).launchpad).toBeNull();
  });

  test("an older iPad build (no questionFraming) is never served an item_steps frame, and its writes can't suppress the node", async () => {
    const t = convexTest(schema, modules);
    await seedGraphAndContent(t);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);

    // The new client frames the regroup item with its own teaching step…
    expect((await launchpadFor(s, scholarId, "native")).launchpad?.entry.move).toBe("item_steps");
    // …the old build's card could only render atoms, so it gets no frame.
    expect((await launchpadFor(s, scholarId, "native", false)).launchpad).toBeNull();

    // A stale old-build "Show me" on that content-less key is refused, so the
    // node stays framable for the new build.
    expect(
      await s.mutation(api.instruction.claimInstructionShown, { scholarId, key: stepsNodeKey }),
    ).toEqual({ claimed: false, reason: "suppressed" });
    expect(
      await s.mutation(api.instruction.recordInstructionChoice, { scholarId, key: stepsNodeKey, choice: "show" }),
    ).toBeNull();
    expect(await s.mutation(api.instruction.recordInstructionViewed, { scholarId, key: stepsNodeKey })).toBeNull();
    expect((await launchpadFor(s, scholarId, "native")).launchpad?.entry.key).toBe(stepsNodeKey);

    // The new client's framed writes on the same key do land.
    await s.mutation(api.instruction.claimInstructionShown, { scholarId, key: stepsNodeKey, framing: "question" });
    expect(
      await s.mutation(api.instruction.recordInstructionChoice, {
        scholarId, key: stepsNodeKey, choice: "show", framing: "question",
      }),
    ).not.toBeNull();
  });

  test("a teacher reading a scholar never mints a frame", async () => {
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
// The preview used to list a "First look" doorway row resolved by the run's
// selector. The run's entry now FRAMES an item already listed in `set`, and
// whether an item is framable depends on the item itself (its worked steps),
// which the preview's skill-level rows don't carry — so the preview names no
// doorway at all, and therefore can never promise a beat the run won't serve.
describe("The home playlist preview", () => {
  const seedPlaced = async (t: ReturnType<typeof convexTest>, scholarId: Id<"users">) => {
    await t.run(async (ctx) => {
      await ctx.db.insert("practicePlacements", {
        scholarId, domain: DOMAIN, status: "complete", probesAnswered: 1, updatedAt: Date.now(),
      });
    });
  };

  test("names no doorway even when the run frames an item, and never burns the offer", async () => {
    const t = convexTest(schema, modules);
    await seedGraphAndContent(t);
    const scholarId = await seedScholar(t);
    await seedPlaced(t, scholarId);
    const s = await asScholar(t, scholarId);

    const preview = await s.query(api.practiceSkills.playlistForScholar, { scholarId, domain: DOMAIN });
    expect("launchpad" in preview).toBe(false);
    const events = await t.run(async (ctx) => await ctx.db.query("instructionEvents").collect());
    expect(events).toHaveLength(0);
    expect((await launchpadFor(s, scholarId)).launchpad).not.toBeNull();
  });
});

// ── Node content as the move (precedence b) ────────────────────────────────
//
// A node whose items carry no worked steps is framed only by PASSED content
// keyed to that node, compacted to text + worked example. The graph: counting
// (root) → add-easy → add-hard (stored item, no steps, with node content
// that also carries a manipulative + a story hook). The scholar is fluent on
// counting and add-easy and has never touched add-hard.
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
    await ctx.db.insert("instructionContent", {
      key: addHardNodeKey, domain: DOMAIN, strand: ADD_SUB, version: 1,
      title: "Add across a ten — the hard way",
      atoms: [
        { kind: "story_hook", hook: "Merchants once counted in tens." },
        { kind: "micro_explain", text: "Split the second addend to make a ten first." },
        { kind: "manipulative", spec: JSON.stringify({ kind: "rekenrek", total: 20 }) },
        workedExample("Add across a ten"),
      ],
      provenance: "authored", verifyStatus: "passed", platforms: ["web", "native"],
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    // `add_hard` is fictional, so it needs a stored item to be RUNNABLE. It has
    // no workedSteps — node content is the only on-topic move.
    await ctx.db.insert("practiceItems", {
      skillKey: ADD_HARD_KEY, domain: DOMAIN, stem: "Add across a ten practice item",
      answerType: "integer", answerCanonical: "12", source: "generated", verifiedAt: Date.now(),
    });
  });
}

describe("Node content as the move", () => {
  test("frames a never-attempted node with its own content, compacted to text + worked example", async () => {
    const t = convexTest(schema, modules);
    await seedNodeDoorwayGraph(t);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await seedFluent(t, scholarId, COUNT_KEY, COUNTING);
    await seedFluent(t, scholarId, ADD_EASY_KEY, ADD_SUB);

    const { launchpad, items } = await launchpadFor(s, scholarId);
    expect(launchpad).not.toBeNull();
    expect(launchpad!.entry.level).toBe("node");
    expect(launchpad!.entry.move).toBe("node_content");
    expect(launchpad!.entry.key).toBe(addHardNodeKey);
    expect(launchpad!.entry.target).toEqual({ domain: DOMAIN, strand: ADD_SUB, nodeKey: ADD_HARD_KEY });
    expect(launchpad!.entry.atoms.map((a) => a.kind)).toEqual(["micro_explain", "worked_example"]);
    expect(launchpad!.entry.masteryEffect).toBe("none");
    const anchor = items[launchpad!.at];
    expect(anchor.skillKey).toBe(ADD_HARD_KEY);
    expect(anchor.lane).toBe("new");
  });

  test("node content with no text or worked example is no move — the item is not framed", async () => {
    const t = convexTest(schema, modules);
    await seedNodeDoorwayGraph(t);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("instructionContent")
        .withIndex("by_key_status", (q) => q.eq("key", addHardNodeKey).eq("verifyStatus", "passed"))
        .unique();
      await ctx.db.patch(row!._id, {
        atoms: [{ kind: "manipulative", spec: JSON.stringify({ kind: "rekenrek", total: 20 }) }],
      });
    });
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await seedFluent(t, scholarId, COUNT_KEY, COUNTING);
    await seedFluent(t, scholarId, ADD_EASY_KEY, ADD_SUB);

    expect((await launchpadFor(s, scholarId)).launchpad).toBeNull();
  });

  test("an older iPad build still gets a node_content frame it can render, under the ≤1/day cap", async () => {
    const t = convexTest(schema, modules);
    await seedNodeDoorwayGraph(t);
    await seedStrandContent(t);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await seedFluent(t, scholarId, COUNT_KEY, COUNTING);
    await seedFluent(t, scholarId, ADD_EASY_KEY, ADD_SUB);

    const legacy = (await launchpadFor(s, scholarId, "native", false)).launchpad;
    expect(legacy?.entry.move).toBe("node_content");
    expect(legacy?.entry.atoms.length).toBeGreaterThan(0);

    // Another key already shown today by the old card: the old build is held
    // by the daily cap; the question-framing client is not.
    await s.mutation(api.instruction.claimInstructionShown, { scholarId, key: addSubKey });
    expect((await launchpadFor(s, scholarId, "native", false)).launchpad).toBeNull();
    expect((await launchpadFor(s, scholarId, "native")).launchpad?.entry.key).toBe(addHardNodeKey);
  });

  test("never fires once the scholar has attempted the node itself", async () => {
    const t = convexTest(schema, modules);
    await seedNodeDoorwayGraph(t);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await seedFluent(t, scholarId, COUNT_KEY, COUNTING);
    await seedFluent(t, scholarId, ADD_EASY_KEY, ADD_SUB);
    await seedFluent(t, scholarId, ADD_HARD_KEY, ADD_SUB);

    expect((await launchpadFor(s, scholarId)).launchpad).toBeNull();
  });

  test("respects the fire-once ledger — a dismissed node stays suppressed", async () => {
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

  test("the standalone card's ≤1/day governor is shared across key kinds", async () => {
    const t = convexTest(schema, modules);
    await seedNodeDoorwayGraph(t);
    await seedStrandContent(t);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);

    await s.mutation(api.instruction.claimInstructionShown, { scholarId, key: addHardNodeKey });
    // A second call the same day is idempotent — still claimed (no self-retraction).
    expect(await s.mutation(api.instruction.claimInstructionShown, { scholarId, key: addHardNodeKey })).toEqual({
      claimed: true,
    });
    // A strand key with content, shown the SAME day by the old card, is held.
    expect(await s.mutation(api.instruction.claimInstructionShown, { scholarId, key: addSubKey })).toEqual({
      claimed: false,
      reason: "daily_cap",
    });
  });

  test("a teacher reading a scholar never mints a node frame either", async () => {
    const t = convexTest(schema, modules);
    await seedNodeDoorwayGraph(t);
    const scholarId = await seedScholar(t);
    await seedFluent(t, scholarId, COUNT_KEY, COUNTING);
    await seedFluent(t, scholarId, ADD_EASY_KEY, ADD_SUB);
    // The teacher must have LEGITIMATE institution-scoped access — the point
    // is that even a fully-authorized teacher read never mints the offer.
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
});

// ── The never-ATTEMPTED trigger (2026-10) ──────────────────────────────────
//
// Placement mints rows for almost everything it touches, so a zero-mastery
// trigger fired once in two months of prod. The trigger is "never attempted":
// inferred placement credit (`source: "placement"`, no `lastAttemptAt`) still
// counts as new ground.
describe("The never-attempted trigger", () => {
  const seedPlacementRow = async (
    t: ReturnType<typeof convexTest>,
    scholarId: Id<"users">,
    over: { lastAttemptAt?: number } = {},
  ) =>
    await t.run(async (ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId, skillKey: STEPS_KEY, domain: DOMAIN, strand: ADD_SUB,
        repetition: 1, halfLifeDays: 1, lastPracticedAt: Date.now() - 3 * 86_400_000,
        frontier: true, source: "placement", updatedAt: Date.now(), ...over,
      }),
    );

  test("a placement-credited but never-attempted node still gets the framed item", async () => {
    const t = convexTest(schema, modules);
    await seedGraphAndContent(t);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await seedPlacementRow(t, scholarId);

    const { launchpad, items } = await launchpadFor(s, scholarId);
    expect(items.some((i) => i.skillKey === STEPS_KEY)).toBe(true);
    expect(launchpad?.entry.key).toBe(stepsNodeKey);
    expect(items[launchpad!.at].skillKey).toBe(STEPS_KEY);
  });

  test("one real attempt on the node retires it — lastAttemptAt, not lastPracticedAt", async () => {
    const t = convexTest(schema, modules);
    await seedGraphAndContent(t);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await seedPlacementRow(t, scholarId, { lastAttemptAt: Date.now() - 3 * 86_400_000 });

    const { launchpad } = await launchpadFor(s, scholarId);
    expect(launchpad?.entry.key).not.toBe(stepsNodeKey);
  });

  test("the question framing's claim is exempt from the ≤1/day cap; the old card's claim is not", async () => {
    const t = convexTest(schema, modules);
    await seedGraphAndContent(t);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);

    await s.mutation(api.instruction.claimInstructionShown, { scholarId, key: countingKey, framing: "question" });
    // A standalone-card claim (an older iPad build) for another key is still held.
    expect(await s.mutation(api.instruction.claimInstructionShown, { scholarId, key: addSubKey })).toEqual({
      claimed: false,
      reason: "daily_cap",
    });
    expect(
      await s.mutation(api.instruction.claimInstructionShown, { scholarId, key: addSubKey, framing: "question" }),
    ).toEqual({ claimed: true });
  });

  test("a suppressed (viewed) node frame is gone from the run", async () => {
    const t = convexTest(schema, modules);
    await seedGraphAndContent(t);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await t.run(async (ctx) => {
      await ctx.db.insert("instructionEvents", {
        scholarId, key: stepsNodeKey, offerId: instructionOfferId(scholarId, stepsNodeKey), viewedAt: Date.now(), offerCount: 1, retrievals: [],
      });
    });
    expect((await launchpadFor(s, scholarId)).launchpad).toBeNull();
  });
});
