import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  strandInstructionKey,
  type InstructionAtom,
} from "../lib/practice/instructionEntries";
import {
  buildInstructionKey,
  instructionMedium,
  parseInstructionKey,
} from "../instruction";

// Why this file: the Launchpad fire-once lifecycle is CLIENT-claimed (a query
// can't write), so the server mutations must be the authoritative guardrails —
// ≤1/day across keys, idempotent same-day re-claims, permanent suppression once
// viewed/dismissed, and NON-terminal retrieval logging. This exercises the real
// mutations + content reads end to end.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const DOMAIN = "whole-number-arithmetic";
const STRAND_A = "add-subtract";
const STRAND_B = "place-value";
const keyA = strandInstructionKey(DOMAIN, STRAND_A);
const keyB = strandInstructionKey(DOMAIN, STRAND_B);

async function seedScholar(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "Ada", username: "ada", role: "scholar" }),
  );
}

async function seedTeacher(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "Grace", username: "grace", role: "teacher" }),
  );
}

async function asScholar(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 3_600_000 }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

const workedExample = {
  kind: "worked_example" as const,
  strategyLabel: "Fill up to ten, then add the rest",
  steps: ["Start with 8 + 5.", "Move 2 to make a ten.", "10 + 3 = 13."],
  examplePrompt: "Use make-a-ten to add 8 + 5.",
  exampleAnswer: "13",
};

describe("instructionMedium", () => {
  test("prioritizes manipulative over video over text", () => {
    const textAtoms: InstructionAtom[] = [
      { kind: "micro_explain", text: "Complete a ten, then add." },
      workedExample,
    ];
    const videoAtom: InstructionAtom = {
      kind: "video",
      provider: "youtube",
      videoId: "abc123",
      startSec: 0,
      endSec: 30,
      captionText: "Watch the regrouping move.",
      sourceLabel: "Example",
      sourceUrl: "https://www.youtube.com/watch?v=abc123",
    };
    const manipulativeAtom: InstructionAtom = {
      kind: "manipulative",
      spec: "{}",
    };

    expect(instructionMedium(textAtoms)).toBe("text");
    expect(instructionMedium([...textAtoms, videoAtom])).toBe("video");
    expect(instructionMedium([videoAtom, manipulativeAtom])).toBe("manipulative");
  });
});

async function seedPassedContent(
  t: ReturnType<typeof convexTest>,
  key: string,
  strand: string,
  title = "A move",
  platforms: string[] = ["web"],
) {
  await t.run(async (ctx) =>
    ctx.db.insert("instructionContent", {
      key,
      domain: DOMAIN,
      strand,
      version: 1,
      title,
      atoms: [{ kind: "micro_explain", text: "Complete a ten, then add." }, workedExample],
      provenance: "authored",
      verifyStatus: "passed",
      platforms,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

async function eventFor(t: TestConvex<typeof schema>, scholarId: Id<"users">, key: string) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("instructionEvents")
      .withIndex("by_scholar_key", (q) => q.eq("scholarId", scholarId).eq("key", key))
      .unique(),
  );
}

describe("claimInstructionShown", () => {
  test("first claim shows; a same-day re-claim is idempotent (no double count)", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);

    const first = await s.mutation(api.instruction.claimInstructionShown, { scholarId, key: keyA });
    expect(first).toEqual({ claimed: true });

    const again = await s.mutation(api.instruction.claimInstructionShown, { scholarId, key: keyA });
    expect(again).toEqual({ claimed: true });

    const row = await eventFor(t, scholarId, keyA);
    expect(row?.offerCount).toBe(1);
    expect(row?.shownAt).toBeTruthy();
  });

  test("≤1 Launchpad/day: a different key is held once one is shown today", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);

    expect(await s.mutation(api.instruction.claimInstructionShown, { scholarId, key: keyA })).toEqual({ claimed: true });
    const second = await s.mutation(api.instruction.claimInstructionShown, { scholarId, key: keyB });
    expect(second).toEqual({ claimed: false, reason: "daily_cap" });

    // The held key was never burned — no row was written for it.
    expect(await eventFor(t, scholarId, keyB)).toBeNull();
  });

  test("a viewed Launchpad is permanently suppressed", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);

    await s.mutation(api.instruction.claimInstructionShown, { scholarId, key: keyA });
    await s.mutation(api.instruction.recordInstructionViewed, { scholarId, key: keyA });

    const reclaim = await s.mutation(api.instruction.claimInstructionShown, { scholarId, key: keyA });
    expect(reclaim).toEqual({ claimed: false, reason: "suppressed" });
  });
});

describe("record* lifecycle", () => {
  test("choice, then a non-terminal retrieval that never suppresses", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await seedPassedContent(t, keyA, STRAND_A);

    await s.mutation(api.instruction.claimInstructionShown, { scholarId, key: keyA });
    await s.mutation(api.instruction.recordInstructionChoice, { scholarId, key: keyA, choice: "try" });
    await s.mutation(api.instruction.recordInstructionRetrieval, { scholarId, key: keyA, source: "post_miss" });

    const row = await eventFor(t, scholarId, keyA);
    expect(row?.initialChoice).toBe("try");
    expect(row?.retrievals).toHaveLength(1);
    expect(row?.retrievals[0].source).toBe("post_miss");
    // A skip + retrieval is NOT terminal: still claimable another day.
    expect(row?.viewedAt).toBeUndefined();
    expect(row?.dismissedAt).toBeUndefined();
  });
});

describe("content reads", () => {
  test("instructionContentForKey returns passed content and skips failed", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await seedPassedContent(t, keyA, STRAND_A);
    // A failed row for another key must never be returned.
    await t.run(async (ctx) =>
      ctx.db.insert("instructionContent", {
        key: keyB,
        domain: DOMAIN,
        strand: STRAND_B,
        version: 1,
        title: "Broken",
        atoms: [{ kind: "micro_explain", text: "nope" }],
        provenance: "authored",
        verifyStatus: "failed",
        platforms: ["web"],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    const good = await s.query(api.instruction.instructionContentForKey, { scholarId, key: keyA });
    expect(good?.title).toBe("A move");
    expect(good?.atoms.length).toBeGreaterThan(0);

    const bad = await s.query(api.instruction.instructionContentForKey, { scholarId, key: keyB });
    expect(bad).toBeNull();
  });

  test("instructionContentForSkill resolves the strand from the item's skillKey", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await seedPassedContent(t, keyA, STRAND_A);
    await t.run(async (ctx) =>
      ctx.db.insert("knowledgeNodes", {
        nodeKey: "add_within_20",
        label: "Add within 20",
        domain: DOMAIN,
        strand: STRAND_A,
      }),
    );

    const content = await s.query(api.instruction.instructionContentForSkill, {
      scholarId,
      skillKey: "add_within_20",
    });
    expect(content?.key).toBe(keyA);

    // An item whose strand has no content yields no shelf.
    const none = await s.query(api.instruction.instructionContentForSkill, {
      scholarId,
      skillKey: "unknown_node",
    });
    expect(none).toBeNull();
  });

  test("instructionLaunchpadForStrand returns full strand detail for curriculum users", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const teacher = await asScholar(t, teacherId);
    await seedPassedContent(t, keyA, STRAND_A, "Make a ten");

    const detail = await teacher.query(api.instruction.instructionLaunchpadForStrand, {
      domain: DOMAIN,
      strand: STRAND_A,
    });
    expect(detail).toMatchObject({
      key: keyA,
      domain: DOMAIN,
      strand: STRAND_A,
      status: "passed",
      provenance: "authored",
      title: "Make a ten",
      subtitle: null,
      atomKinds: ["micro_explain", "worked_example"],
      medium: "text",
      hasWorkedExample: true,
      version: 1,
      verifyReport: null,
    });
    expect(detail?.atoms).toEqual([
      { kind: "micro_explain", text: "Complete a ten, then add." },
      workedExample,
    ]);

    const none = await teacher.query(api.instruction.instructionLaunchpadForStrand, {
      domain: DOMAIN,
      strand: STRAND_B,
    });
    expect(none).toBeNull();
  });
});

describe("instructionCoverage (finding 2 — node-grain rows must never pollute the strand catalog)", () => {
  test("scopes the catalog to its domain while preserving its shaped count and strand order", async () => {
    // Two auth documents plus the two in-domain catalog rows. The unrelated row
    // makes an unindexed whole-table scan exceed this read budget.
    const t = convexTest({ schema, modules, transactionLimits: { documentsRead: 4 } });
    const teacherId = await seedTeacher(t);
    const teacher = await asScholar(t, teacherId);
    await seedPassedContent(t, keyB, STRAND_B, "Place-value move");
    await seedPassedContent(t, keyA, STRAND_A, "Addition move");

    const unrelatedDomain = "fraction-arithmetic";
    const unrelatedStrand = "operations";
    const unrelatedKey = strandInstructionKey(unrelatedDomain, unrelatedStrand);
    await t.run(async (ctx) =>
      ctx.db.insert("instructionContent", {
        key: unrelatedKey,
        domain: unrelatedDomain,
        strand: unrelatedStrand,
        version: 1,
        title: "Unrelated fraction move",
        atoms: [{ kind: "micro_explain", text: "This belongs to another domain." }],
        provenance: "authored",
        verifyStatus: "passed",
        platforms: ["web"],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    const coverage = await teacher.query(api.instruction.instructionCoverage, { domain: DOMAIN });

    expect(coverage).toMatchObject({ domain: DOMAIN, nodeSegments: [] });
    expect(coverage.strands).toHaveLength(2);
    expect(coverage.strands.map(({ strand, key, title, atomKinds, medium }) => ({
      strand,
      key,
      title,
      atomKinds,
      medium,
    }))).toEqual([
      {
        strand: STRAND_A,
        key: keyA,
        title: "Addition move",
        atomKinds: ["micro_explain", "worked_example"],
        medium: "text",
      },
      {
        strand: STRAND_B,
        key: keyB,
        title: "Place-value move",
        atomKinds: ["micro_explain", "worked_example"],
        medium: "text",
      },
    ]);
    expect(coverage.strands.some((row) => row.key === unrelatedKey)).toBe(false);
  });

  test("only strand-grain rows appear; a node-grain row for the same domain/strand is excluded", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const teacher = await asScholar(t, teacherId);
    await seedPassedContent(t, keyA, STRAND_A, "Strand move");

    // A node-grain row stamping the SAME domain/strand as the strand row above
    // — through the real write path (finding 4), so it's a realistic case.
    await t.mutation(internal.instruction.storeInstructionContent, {
      domain: DOMAIN,
      strand: STRAND_A,
      nodeKey: "add_within_20",
      title: "Node move",
      atoms: [{ kind: "micro_explain", text: "The node-level move." }, workedExample],
      provenance: "authored",
    });

    const coverage = await teacher.query(api.instruction.instructionCoverage, { domain: DOMAIN });
    // Exactly one row for STRAND_A — the strand entry, never the node entry
    // silently standing in for (or duplicating) it.
    const strandARows = coverage.strands.filter((r) => r.strand === STRAND_A);
    expect(strandARows).toHaveLength(1);
    expect(strandARows[0].key).toBe(keyA);
    expect(strandARows[0].title).toBe("Strand move");
    expect(strandARows[0].medium).toBe("text");
    // The node-grain key never appears in the strand catalog at all.
    expect(coverage.strands.some((r) => r.key === buildInstructionKey({ kind: "node", nodeKey: "add_within_20" }))).toBe(false);
    // …but IS surfaced separately in `nodeSegments` — METADATA ONLY (fix #7):
    // the always-on coverage subscription must NOT carry every segment's atom
    // bodies or verify report, so the pane can count/flag node segments without
    // paying for their contents on every domain read.
    const nodeSeg = coverage.nodeSegments.find((s) => s.nodeKey === "add_within_20");
    expect(nodeSeg).toBeDefined();
    expect(nodeSeg?.title).toBe("Node move");
    expect(nodeSeg?.strand).toBe(STRAND_A);
    expect(nodeSeg?.medium).toBe("text");
    expect(nodeSeg?.hasWorkedExample).toBe(true);
    expect(nodeSeg?.atomKinds.length).toBeGreaterThan(0);
    // No heavy bodies on the coverage payload.
    expect(nodeSeg).not.toHaveProperty("atoms");
    expect(nodeSeg).not.toHaveProperty("verifyReport");
  });

  test("instructionSegmentForNode returns the full node-grain segment (atoms), or null when none", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const teacher = await asScholar(t, teacherId);

    // No node-grain content yet → null.
    expect(
      await teacher.query(api.instruction.instructionSegmentForNode, { nodeKey: "add_within_20" }),
    ).toBeNull();

    await t.mutation(internal.instruction.storeInstructionContent, {
      domain: DOMAIN,
      strand: STRAND_A,
      nodeKey: "add_within_20",
      title: "Node move",
      atoms: [{ kind: "micro_explain", text: "The node-level move." }, workedExample],
      provenance: "authored",
    });

    const seg = await teacher.query(api.instruction.instructionSegmentForNode, {
      nodeKey: "add_within_20",
    });
    expect(seg).not.toBeNull();
    expect(seg?.nodeKey).toBe("add_within_20");
    expect(seg?.title).toBe("Node move");
    expect(seg?.key).toBe(buildInstructionKey({ kind: "node", nodeKey: "add_within_20" }));
    // The keyed query DOES carry the full atom bodies (the pane fetches it only
    // for the one selected skill).
    expect(seg?.atoms.length).toBeGreaterThan(0);
    // A strand-only nodeKey (no node-grain row) still resolves to null.
    expect(
      await teacher.query(api.instruction.instructionSegmentForNode, { nodeKey: "no_such_node" }),
    ).toBeNull();
  });
});

describe("platform gating (finding 7 — instructionContent.platforms is enforced)", () => {
  test("instructionContentForKey defaults to 'web' and never surfaces a native-only row", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await seedPassedContent(t, keyA, STRAND_A, "Native-only move", ["native"]);

    // No platform arg → defaults to "web"; a native-only row must not surface.
    expect(await s.query(api.instruction.instructionContentForKey, { scholarId, key: keyA })).toBeNull();
    expect(
      await s.query(api.instruction.instructionContentForKey, { scholarId, key: keyA, platform: "web" }),
    ).toBeNull();

    // The SAME row DOES surface when the requesting client is native.
    const forNative = await s.query(api.instruction.instructionContentForKey, {
      scholarId,
      key: keyA,
      platform: "native",
    });
    expect(forNative?.title).toBe("Native-only move");
  });

  test("instructionContentForSkill gates the strand's content by the requesting platform", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await seedPassedContent(t, keyA, STRAND_A, "Web-only move", ["web"]);
    await t.run(async (ctx) =>
      ctx.db.insert("knowledgeNodes", {
        nodeKey: "add_within_20",
        label: "Add within 20",
        domain: DOMAIN,
        strand: STRAND_A,
      }),
    );

    const forWeb = await s.query(api.instruction.instructionContentForSkill, {
      scholarId,
      skillKey: "add_within_20",
      platform: "web",
    });
    expect(forWeb?.title).toBe("Web-only move");

    const forNative = await s.query(api.instruction.instructionContentForSkill, {
      scholarId,
      skillKey: "add_within_20",
      platform: "native",
    });
    expect(forNative).toBeNull();
  });

  test("instructionContentForNode gates BOTH the node-grain and the strand-fallback read by platform", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    // Strand fallback is native-only; the node has no node-grain content.
    await seedPassedContent(t, keyA, STRAND_A, "Native-only strand move", ["native"]);
    await t.run(async (ctx) =>
      ctx.db.insert("knowledgeNodes", {
        nodeKey: "add_within_20",
        label: "Add within 20",
        domain: DOMAIN,
        strand: STRAND_A,
      }),
    );

    // A web request never sees the native-only strand fallback.
    expect(
      await s.query(api.instruction.instructionContentForNode, {
        scholarId,
        nodeKey: "add_within_20",
        platform: "web",
      }),
    ).toBeNull();

    const forNative = await s.query(api.instruction.instructionContentForNode, {
      scholarId,
      nodeKey: "add_within_20",
      platform: "native",
    });
    expect(forNative?.title).toBe("Native-only strand move");
  });
});

describe("buildInstructionKey / parseInstructionKey (§3 key space)", () => {
  test("round-trips the node grain", () => {
    const key = buildInstructionKey({ kind: "node", nodeKey: "add_within_20" });
    expect(key).toBe("node:add_within_20");
    expect(parseInstructionKey(key)).toEqual({ kind: "node", nodeKey: "add_within_20" });
  });

  test("round-trips the strand grain, matching strandInstructionKey", () => {
    const key = buildInstructionKey({ kind: "strand", domain: DOMAIN, strand: STRAND_A });
    expect(key).toBe(strandInstructionKey(DOMAIN, STRAND_A));
    expect(parseInstructionKey(key)).toEqual({ kind: "strand", domain: DOMAIN, strand: STRAND_A });
  });

  test("parseInstructionKey returns null for a malformed or unrecognized key", () => {
    expect(parseInstructionKey("node:")).toBeNull();
    expect(parseInstructionKey("strand:onlydomain")).toBeNull();
    expect(parseInstructionKey("strand:domain:")).toBeNull();
    expect(parseInstructionKey("item:123")).toBeNull();
    expect(parseInstructionKey("")).toBeNull();
  });
});

describe("instructionContentForNode (§4.3 on-demand reference, node-first)", () => {
  test("prefers node-grain content over the node's strand content", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await seedPassedContent(t, keyA, STRAND_A, "Strand-level move");
    await t.run(async (ctx) =>
      ctx.db.insert("knowledgeNodes", {
        nodeKey: "add_within_20",
        label: "Add within 20",
        domain: DOMAIN,
        strand: STRAND_A,
      }),
    );
    // Node-grain content stored through the REAL write path (§3/§4 finding —
    // storeInstructionContent is arg-driven for the node grain, not a raw
    // db.insert), so this exercises the same verify→store gate authored
    // strand content goes through.
    const stored = await t.mutation(internal.instruction.storeInstructionContent, {
      domain: DOMAIN,
      strand: STRAND_A,
      nodeKey: "add_within_20",
      title: "Node-level move",
      atoms: [{ kind: "micro_explain", text: "A node-specific explainer." }, workedExample],
      provenance: "authored",
    });
    const nodeKeyStr = buildInstructionKey({ kind: "node", nodeKey: "add_within_20" });
    expect(stored.key).toBe(nodeKeyStr);
    expect(stored.status).toBe("passed");

    const content = await s.query(api.instruction.instructionContentForNode, {
      scholarId,
      nodeKey: "add_within_20",
    });
    expect(content?.key).toBe(nodeKeyStr);
    expect(content?.title).toBe("Node-level move");
  });

  test("falls back to the strand entry when the node has no node-grain content", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await seedPassedContent(t, keyA, STRAND_A, "Strand-level move");
    await t.run(async (ctx) =>
      ctx.db.insert("knowledgeNodes", {
        nodeKey: "add_within_20",
        label: "Add within 20",
        domain: DOMAIN,
        strand: STRAND_A,
      }),
    );

    const content = await s.query(api.instruction.instructionContentForNode, {
      scholarId,
      nodeKey: "add_within_20",
    });
    expect(content?.key).toBe(keyA);
    expect(content?.title).toBe("Strand-level move");
  });

  test("returns null for an unresolvable node or a strand with no PASSED content", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);

    expect(
      await s.query(api.instruction.instructionContentForNode, { scholarId, nodeKey: "unknown_node" }),
    ).toBeNull();

    await t.run(async (ctx) =>
      ctx.db.insert("knowledgeNodes", {
        nodeKey: "no_content_node",
        label: "No content",
        domain: DOMAIN,
        strand: STRAND_B,
      }),
    );
    expect(
      await s.query(api.instruction.instructionContentForNode, { scholarId, nodeKey: "no_content_node" }),
    ).toBeNull();
  });
});

describe("post-miss escalation write path (§4.2 'Learn this from the start' pull)", () => {
  // Why this block: the escalation is an OFFER inside the existing post_miss
  // explainer, never a second forced beat (§4.2 decision c). Its write path is
  // exactly two calls in sequence — the sheet's own open already logs a
  // post_miss retrieval against the STRAND key (Phase 1 behavior, unchanged);
  // taking the "Learn this from the start" pull logs a SECOND, independent
  // post_miss retrieval against the NODE-FIRST resolved key
  // (`instructionContentForNode`). Both land in the SAME scholar+key ledger
  // rows the existing retrieval mutation already maintains — no new mutation,
  // no new schema, no governor impact (pull, not push).
  test("the sheet's open (strand) and the escalation pull (node) log as TWO separate, independent post_miss retrievals", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await seedPassedContent(t, keyA, STRAND_A, "Strand-level move");
    await t.run(async (ctx) =>
      ctx.db.insert("knowledgeNodes", {
        nodeKey: "add_within_20",
        label: "Add within 20",
        domain: DOMAIN,
        strand: STRAND_A,
      }),
    );
    // The missed item's node carries its OWN node-grain content — richer than
    // (and distinct from) the strand content the sheet opened with.
    const stored = await t.mutation(internal.instruction.storeInstructionContent, {
      domain: DOMAIN,
      strand: STRAND_A,
      nodeKey: "add_within_20",
      title: "The whole move, from the start",
      atoms: [{ kind: "micro_explain", text: "Start from zero." }, workedExample],
      provenance: "authored",
    });
    const nodeKeyStr = buildInstructionKey({ kind: "node", nodeKey: "add_within_20" });
    expect(stored.key).toBe(nodeKeyStr);

    // 1. The explainer opens post_miss on the STRAND content (Phase 1, unchanged).
    await s.mutation(api.instruction.recordInstructionRetrieval, {
      scholarId,
      key: keyA,
      source: "post_miss",
    });

    // 2. The scholar resolves the node-first escalation content (what the
    // client queries before offering "Learn this from the start")...
    const nodeFirst = await s.query(api.instruction.instructionContentForNode, {
      scholarId,
      nodeKey: "add_within_20",
    });
    expect(nodeFirst?.key).toBe(nodeKeyStr);

    // ...and takes the pull, logging a SECOND post_miss retrieval against the
    // node-first key.
    await s.mutation(api.instruction.recordInstructionRetrieval, {
      scholarId,
      key: nodeFirst!.key,
      source: "post_miss",
    });

    const strandRow = await eventFor(t, scholarId, keyA);
    expect(strandRow?.retrievals).toHaveLength(1);
    expect(strandRow?.retrievals[0].source).toBe("post_miss");

    const nodeRow = await eventFor(t, scholarId, nodeKeyStr);
    expect(nodeRow?.retrievals).toHaveLength(1);
    expect(nodeRow?.retrievals[0].source).toBe("post_miss");

    // Non-terminal, no governor impact: neither row carries a shown impression.
    expect(strandRow?.shownAt).toBeUndefined();
    expect(nodeRow?.shownAt).toBeUndefined();
  });

  test("when the node has no node-grain content, the escalation's node-first resolution simply falls back to the SAME strand content — a harmless re-pull, not an error", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await seedPassedContent(t, keyA, STRAND_A, "Strand-level move");
    await t.run(async (ctx) =>
      ctx.db.insert("knowledgeNodes", {
        nodeKey: "add_within_20",
        label: "Add within 20",
        domain: DOMAIN,
        strand: STRAND_A,
      }),
    );

    const nodeFirst = await s.query(api.instruction.instructionContentForNode, {
      scholarId,
      nodeKey: "add_within_20",
    });
    // No dedicated node content exists — resolves to the SAME strand key.
    expect(nodeFirst?.key).toBe(keyA);

    await s.mutation(api.instruction.recordInstructionRetrieval, { scholarId, key: keyA, source: "post_miss" });
    await s.mutation(api.instruction.recordInstructionRetrieval, {
      scholarId,
      key: nodeFirst!.key,
      source: "post_miss",
    });

    // Both calls land on the SAME row (same key) — two retrievals, not two rows.
    const row = await eventFor(t, scholarId, keyA);
    expect(row?.retrievals).toHaveLength(2);
    expect(row?.retrievals.every((r) => r.source === "post_miss")).toBe(true);
  });
});

describe("recordInstructionRetrieval (reference placement logging)", () => {
  test("a FIRST-EVER idea_shelf retrieval (the real drawer/map flow — no prior claimInstructionShown) is honestly logged", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await seedPassedContent(t, keyA, STRAND_A);

    // The reference overlay (§4.3) NEVER calls claimInstructionShown — a
    // scholar can open "See the move" for a node/strand they were never
    // offered a Launchpad doorway into. Exercise exactly that: no prior row.
    expect(await eventFor(t, scholarId, keyA)).toBeNull();

    await s.mutation(api.instruction.recordInstructionRetrieval, {
      scholarId,
      key: keyA,
      source: "idea_shelf",
    });

    const row = await eventFor(t, scholarId, keyA);
    expect(row?.retrievals).toHaveLength(1);
    expect(row?.retrievals[0].source).toBe("idea_shelf");
    // Non-terminal, and never counts toward the ≤1/day governor or re-offer
    // cap: no shown impression was ever claimed.
    expect(row?.shownAt).toBeUndefined();
    expect(row?.lastShownDayBucket).toBeUndefined();
    expect(row?.offerCount).toBe(0);
    expect(row?.viewedAt).toBeUndefined();
    expect(row?.dismissedAt).toBeUndefined();
  });

  test("a second retrieval on the same minted row appends rather than duplicating the row", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await seedPassedContent(t, keyA, STRAND_A);

    await s.mutation(api.instruction.recordInstructionRetrieval, { scholarId, key: keyA, source: "idea_shelf" });
    await s.mutation(api.instruction.recordInstructionRetrieval, { scholarId, key: keyA, source: "post_miss" });

    const row = await eventFor(t, scholarId, keyA);
    expect(row?.retrievals).toHaveLength(2);
    expect(row?.retrievals.map((r) => r.source)).toEqual(["idea_shelf", "post_miss"]);
  });

  test("a retrieval-minted row never blocks or gets suppressed by a later real Launchpad claim on a DIFFERENT key", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await seedPassedContent(t, keyA, STRAND_A);
    await seedPassedContent(t, keyB, STRAND_B, "Another move");

    // A pure reference pull on keyA (no shownAt) must not count as "already
    // shown today" and hold keyB's real doorway claim.
    await s.mutation(api.instruction.recordInstructionRetrieval, { scholarId, key: keyA, source: "idea_shelf" });
    const claim = await s.mutation(api.instruction.claimInstructionShown, { scholarId, key: keyB });
    expect(claim).toEqual({ claimed: true });
  });

  test("a retrieval on an EXISTING (already-claimed) row still appends, matching the doorway's post-miss/idea-shelf reopen", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await seedPassedContent(t, keyA, STRAND_A);

    await s.mutation(api.instruction.claimInstructionShown, { scholarId, key: keyA });
    await s.mutation(api.instruction.recordInstructionRetrieval, {
      scholarId,
      key: keyA,
      source: "idea_shelf",
    });
    const row = await eventFor(t, scholarId, keyA);
    expect(row?.retrievals).toHaveLength(1);
    expect(row?.retrievals[0].source).toBe("idea_shelf");
    // Non-terminal: still not suppressed after the reference pull.
    expect(row?.viewedAt).toBeUndefined();
    expect(row?.dismissedAt).toBeUndefined();
  });

  test("finding 3: rejects a malformed key (fails parseInstructionKey) rather than minting a row for it", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);

    await expect(
      s.mutation(api.instruction.recordInstructionRetrieval, {
        scholarId,
        key: "not-a-real-key-shape",
        source: "idea_shelf",
      }),
    ).rejects.toThrow();

    expect(await eventFor(t, scholarId, "not-a-real-key-shape")).toBeNull();
  });

  test("finding 3: rejects a well-formed key that names no existing PASSED content", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    // Well-formed (parses fine), but nothing was ever stored for it.
    const phantomKey = strandInstructionKey(DOMAIN, "no-such-strand");

    await expect(
      s.mutation(api.instruction.recordInstructionRetrieval, {
        scholarId,
        key: phantomKey,
        source: "idea_shelf",
      }),
    ).rejects.toThrow();

    expect(await eventFor(t, scholarId, phantomKey)).toBeNull();
  });

  test("finding 3: rejects a well-formed key whose only content row is FAILED verification", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await t.mutation(internal.instruction.storeInstructionContent, {
      domain: DOMAIN,
      strand: STRAND_B,
      title: "Bad",
      atoms: [{ kind: "story_hook", hook: "Only a story, no teaching." }],
      provenance: "authored",
    });

    await expect(
      s.mutation(api.instruction.recordInstructionRetrieval, { scholarId, key: keyB, source: "idea_shelf" }),
    ).rejects.toThrow();
    expect(await eventFor(t, scholarId, keyB)).toBeNull();
  });

  test("finding 3: a NATIVE-only key (no 'web' entry) is still accepted — the check is platform-agnostic", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const s = await asScholar(t, scholarId);
    await seedPassedContent(t, keyA, STRAND_A, "Native-only move", ["native"]);

    await s.mutation(api.instruction.recordInstructionRetrieval, {
      scholarId,
      key: keyA,
      source: "idea_shelf",
    });
    const row = await eventFor(t, scholarId, keyA);
    expect(row?.retrievals).toHaveLength(1);
  });

  test("audience finding: a teacher (even one with legitimate access to the scholar) may NEVER write a retrieval against that scholar", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const teacherId = await seedTeacher(t);
    const teacher = await asScholar(t, teacherId);
    await seedPassedContent(t, keyA, STRAND_A);

    // The mutation is authScholar-permissive for OTHER lifecycle writes (a
    // teacher can e.g. trigger a rehearse/preview flow), but retrieval
    // telemetry is scholar-SELF-only, unconditionally — a teacher call must
    // be rejected even though `requireTeacherOrSelf` alone would have let a
    // teacher-of-scholar through.
    await expect(
      teacher.mutation(api.instruction.recordInstructionRetrieval, {
        scholarId,
        key: keyA,
        source: "post_miss",
      }),
    ).rejects.toThrow();

    // No row was minted, and no retrieval was appended, against the scholar.
    expect(await eventFor(t, scholarId, keyA)).toBeNull();
  });

  test("audience finding: a teacher passing their OWN id is also rejected — identity equality alone is not scholar-self", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedTeacher(t);
    const teacher = await asScholar(t, teacherId);
    await seedPassedContent(t, keyA, STRAND_A);

    await expect(
      teacher.mutation(api.instruction.recordInstructionRetrieval, {
        scholarId: teacherId,
        key: keyA,
        source: "post_miss",
      }),
    ).rejects.toThrow();
    expect(await eventFor(t, teacherId, keyA)).toBeNull();
  });
});

describe("storeInstructionContent (verify → store gate)", () => {
  test("passes good content and bumps version only when atoms change", async () => {
    const t = convexTest(schema, modules);

    const r1 = await t.mutation(internal.instruction.storeInstructionContent, {
      domain: DOMAIN,
      strand: STRAND_A,
      title: "Make a ten",
      atoms: [{ kind: "micro_explain", text: "Complete a ten, then add." }, workedExample],
      provenance: "authored",
    });
    expect(r1.status).toBe("passed");
    expect(r1.version).toBe(1);

    // Re-storing identical content is a no-op (no version churn).
    const r2 = await t.mutation(internal.instruction.storeInstructionContent, {
      domain: DOMAIN,
      strand: STRAND_A,
      title: "Make a ten",
      atoms: [{ kind: "micro_explain", text: "Complete a ten, then add." }, workedExample],
      provenance: "authored",
    });
    expect(r2.version).toBe(1);

    // Changed atoms bump the version.
    const r3 = await t.mutation(internal.instruction.storeInstructionContent, {
      domain: DOMAIN,
      strand: STRAND_A,
      title: "Make a ten",
      atoms: [{ kind: "micro_explain", text: "Borrow to complete a ten." }, workedExample],
      provenance: "authored",
    });
    expect(r3.version).toBe(2);

    const rows = await t.run(async (ctx) =>
      ctx.db.query("instructionContent").withIndex("by_key", (q) => q.eq("key", keyA)).collect(),
    );
    expect(rows).toHaveLength(1); // upsert, never duplicate
  });

  test("stores failing content as verifyStatus:failed (auditable, never served)", async () => {
    const t = convexTest(schema, modules);
    const r = await t.mutation(internal.instruction.storeInstructionContent, {
      domain: DOMAIN,
      strand: STRAND_B,
      title: "Bad",
      atoms: [{ kind: "story_hook", hook: "Only a story, no teaching." }],
      provenance: "authored",
    });
    expect(r.status).toBe("failed");
    const row: Doc<"instructionContent"> | null = await t.run(async (ctx) =>
      ctx.db.query("instructionContent").withIndex("by_key", (q) => q.eq("key", keyB)).unique(),
    );
    expect(row?.verifyStatus).toBe("failed");
  });

  test("nodeKey (§3/§4) stores under the node grain, never colliding with the strand row, and upserts by node key", async () => {
    const t = convexTest(schema, modules);
    const nodeKeyStr = buildInstructionKey({ kind: "node", nodeKey: "add_within_20" });

    // A strand-grain row for the SAME domain/strand already exists.
    await t.mutation(internal.instruction.storeInstructionContent, {
      domain: DOMAIN,
      strand: STRAND_A,
      title: "Strand move",
      atoms: [{ kind: "micro_explain", text: "The strand-level move." }, workedExample],
      provenance: "authored",
    });

    const r1 = await t.mutation(internal.instruction.storeInstructionContent, {
      domain: DOMAIN,
      strand: STRAND_A,
      nodeKey: "add_within_20",
      title: "Node move",
      atoms: [{ kind: "micro_explain", text: "The node-level move." }, workedExample],
      provenance: "authored",
    });
    expect(r1.key).toBe(nodeKeyStr);
    expect(r1.status).toBe("passed");
    expect(r1.version).toBe(1);

    // Both rows coexist — the node write never clobbered the strand row.
    const strandRow = await t.run(async (ctx) =>
      ctx.db.query("instructionContent").withIndex("by_key", (q) => q.eq("key", keyA)).unique(),
    );
    expect(strandRow?.title).toBe("Strand move");

    // Re-storing identical node content is a no-op (upsert by node key, no churn).
    const r2 = await t.mutation(internal.instruction.storeInstructionContent, {
      domain: DOMAIN,
      strand: STRAND_A,
      nodeKey: "add_within_20",
      title: "Node move",
      atoms: [{ kind: "micro_explain", text: "The node-level move." }, workedExample],
      provenance: "authored",
    });
    expect(r2.version).toBe(1);

    const nodeRows = await t.run(async (ctx) =>
      ctx.db.query("instructionContent").withIndex("by_key", (q) => q.eq("key", nodeKeyStr)).collect(),
    );
    expect(nodeRows).toHaveLength(1); // upsert, never duplicate
  });
});
