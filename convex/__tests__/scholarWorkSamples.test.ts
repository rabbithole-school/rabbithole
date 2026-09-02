// Tests for the staff-aide "work samples" read path:
//   - the get_scholar_work_samples backing internalQuery
//     (lib/scholarReads.getScholarWorkSamples / readScholarWorkSamples), and
//   - the scan-evidence labelling widened into readScholarMastery.
//
// convex-test drives the registered internalQuery and the plain data function
// directly; no SSE / Anthropic round-trip is involved (the tools that wrap
// these are covered as a pure builder in scholarReadTools.test.ts).

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { readScholarMastery } from "../lib/scholarReads";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedScholar(
  t: ReturnType<typeof convexTest>,
  name: string,
): Promise<Id<"users">> {
  return await t.run((ctx) =>
    ctx.db.insert("users", { name, role: "scholar" } as Doc<"users">),
  );
}

/** Insert a portfolio item and attribute it to a scholar (legacy + link row). */
async function seedItem(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users"> | null,
  overrides: Partial<Doc<"portfolioItems">> = {},
): Promise<Id<"portfolioItems">> {
  return await t.run(async (ctx) => {
    const itemId = await ctx.db.insert("portfolioItems", {
      ...(scholarId ? { scholarId } : {}),
      title: "scan.jpg",
      source: "upload",
      matchStatus: scholarId ? "matched" : "unmatched",
      assignmentStatus: "none",
      processingStatus: "ready",
      ...overrides,
    } as Doc<"portfolioItems">);
    if (scholarId) {
      await ctx.db.insert("portfolioAttributions", {
        portfolioItemId: itemId,
        scholarId,
        attributedAt: Date.now(),
      });
    }
    return itemId;
  });
}

async function seedScanObservation(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  portfolioItemId: Id<"portfolioItems">,
  overrides: Partial<Doc<"masteryObservations">> = {},
): Promise<Id<"masteryObservations">> {
  return await t.run((ctx) =>
    ctx.db.insert("masteryObservations", {
      scholarId,
      conceptLabel: "Area model for multiplication",
      domain: "Mathematics",
      observedAt: Date.now(),
      portfolioItemId,
      transcriptExcerpt: "43 x 6 drawn as 40 + 3",
      masteryLevel: 3,
      confidenceScore: 0.5,
      evidenceSummary: "Solved two-digit products with an area model.",
      evidenceType: "direct_demonstration",
      attemptContext: "portfolio_scan",
      studentInitiated: false,
      isSuperseded: false,
      ...overrides,
    } as Doc<"masteryObservations">),
  );
}

describe("getScholarWorkSamples", () => {
  test("returns a scholar's items with their non-superseded scan observations, newest first", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "Alinda");

    const olderId = await seedItem(t, scholarId, {
      title: "older.jpg",
      documentHeading: "Old Worksheet",
      extractedText: "x".repeat(900),
    });
    // Ensure a strictly later creation time for the second item.
    await new Promise((r) => setTimeout(r, 5));
    const newerId = await seedItem(t, scholarId, {
      title: "newer.jpg",
      documentHeading: "New Worksheet",
      aiCaption: "A drawing of a rocket.",
    });

    // Two observations on the older item: one live, one superseded (excluded).
    await seedScanObservation(t, scholarId, olderId);
    await seedScanObservation(t, scholarId, olderId, {
      conceptLabel: "Superseded concept",
      isSuperseded: true,
    });
    // A misconception observation carries its lifecycle fields.
    await seedScanObservation(t, scholarId, newerId, {
      conceptLabel: "Regrouping",
      evidenceType: "misconception_signal",
      misconceptionStatus: "open",
      misconceptionNote: "Subtracts smaller from larger regardless of place.",
    });

    const samples = await t.query(
      internal.lib.scholarReads.getScholarWorkSamples,
      { scholarId },
    );

    expect(samples.queryMatched).toBe(true);
    expect(samples.items.map((s) => s.itemId)).toEqual([newerId, olderId]);

    const newer = samples.items[0];
    expect(newer.documentHeading).toBe("New Worksheet");
    expect(newer.aiCaption).toBe("A drawing of a rocket.");
    expect(newer.scanObservations).toEqual([
      expect.objectContaining({
        concept: "Regrouping",
        evidenceType: "misconception_signal",
        misconceptionStatus: "open",
        misconceptionNote:
          "Subtracts smaller from larger regardless of place.",
      }),
    ]);

    const older = samples.items[1];
    // Only the live observation, not the superseded one.
    expect(older.scanObservations).toHaveLength(1);
    expect(older.scanObservations[0]).toMatchObject({
      concept: "Area model for multiplication",
      level: 3,
      evidence: "Solved two-digit products with an area model.",
    });
    // extractedText is previewed, not dumped in full.
    expect(older.extractedTextPreview).not.toBeNull();
    expect(older.extractedTextPreview!.length).toBeLessThanOrEqual(501);
    expect(older.extractedTextPreview!.endsWith("…")).toBe(true);
  });

  test("query filter matches label, documentHeading, and title substrings (case-insensitive)", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "Alinda");

    const labelId = await seedItem(t, scholarId, {
      title: "img000.jpg",
      label: "Learning Print",
      documentHeading: "I. STRENGTHS AND INTERESTS",
    });
    const headingId = await seedItem(t, scholarId, {
      title: "img001.jpg",
      documentHeading: "Science Reflection",
    });
    const titleId = await seedItem(t, scholarId, {
      title: "Weekly Reading Log",
    });
    await seedItem(t, scholarId, {
      title: "unrelated.jpg",
      documentHeading: "Math Quiz",
    });

    const byHeading = await t.query(
      internal.lib.scholarReads.getScholarWorkSamples,
      { scholarId, query: "learning print" },
    );
    expect(byHeading.queryMatched).toBe(true);
    expect(byHeading.items.map((s) => s.itemId)).toEqual([labelId]);
    expect(byHeading.items[0].label).toBe("Learning Print");

    const byPrintedHeading = await t.query(
      internal.lib.scholarReads.getScholarWorkSamples,
      { scholarId, query: "science reflection" },
    );
    expect(byPrintedHeading.queryMatched).toBe(true);
    expect(byPrintedHeading.items.map((s) => s.itemId)).toEqual([headingId]);

    const byTitle = await t.query(
      internal.lib.scholarReads.getScholarWorkSamples,
      { scholarId, query: "READING log" },
    );
    expect(byTitle.queryMatched).toBe(true);
    expect(byTitle.items.map((s) => s.itemId)).toEqual([titleId]);

    // A blank/whitespace query is treated as "no filter", not match-everything.
    const noFilter = await t.query(
      internal.lib.scholarReads.getScholarWorkSamples,
      { scholarId, query: "   " },
    );
    expect(noFilter.queryMatched).toBe(true);
    expect(noFilter.items).toHaveLength(4);
  });

  test("excludes capture_station items", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "Alinda");

    const uploadId = await seedItem(t, scholarId, { title: "upload.jpg" });
    await seedItem(t, scholarId, {
      title: "station.jpg",
      source: "capture_station",
    });

    const samples = await t.query(
      internal.lib.scholarReads.getScholarWorkSamples,
      { scholarId },
    );
    expect(samples.items.map((s) => s.itemId)).toEqual([uploadId]);
  });

  test("cross-scholar isolation: scholar B's items never appear for scholar A", async () => {
    const t = convexTest(schema, modules);
    const alinda = await seedScholar(t, "Alinda");
    const bruno = await seedScholar(t, "Bruno");

    const alindaItem = await seedItem(t, alinda, { title: "alinda.jpg" });
    const brunoItem = await seedItem(t, bruno, { title: "bruno.jpg" });

    const forAlinda = await t.query(
      internal.lib.scholarReads.getScholarWorkSamples,
      { scholarId: alinda },
    );
    expect(forAlinda.items.map((s) => s.itemId)).toEqual([alindaItem]);

    const forBruno = await t.query(
      internal.lib.scholarReads.getScholarWorkSamples,
      { scholarId: bruno },
    );
    expect(forBruno.items.map((s) => s.itemId)).toEqual([brunoItem]);
  });
});

describe("readScholarMastery — scan evidence labelling", () => {
  test("carries attemptContext + a source label on a portfolio_scan row and leaves a session row unchanged", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "Alinda");

    const scanItem = await seedItem(t, scholarId, {
      title: "scan.jpg",
      documentHeading: "Learning Print",
    });
    // A scan item whose extraction found no printed heading ("") — the source
    // label must fall back to the item title.
    const untitledScanItem = await seedItem(t, scholarId, {
      title: "field-notes.jpg",
      documentHeading: "",
    });
    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        title: "A tutor session",
        isArchived: false,
      } as Doc<"sessions">),
    );

    await seedScanObservation(t, scholarId, scanItem, {
      conceptLabel: "Area model",
      domain: "Mathematics",
    });
    await seedScanObservation(t, scholarId, untitledScanItem, {
      conceptLabel: "Number line",
      domain: "Geometry",
    });
    // A session-sourced observation: no portfolioItemId, different context.
    await t.run((ctx) =>
      ctx.db.insert("masteryObservations", {
        scholarId,
        conceptLabel: "Rotor energy",
        domain: "Physics",
        observedAt: Date.now(),
        sessionId,
        transcriptExcerpt: "the descent powers the rotor",
        masteryLevel: 3.5,
        confidenceScore: 0.7,
        evidenceSummary: "Explained where the rotor's energy comes from.",
        evidenceType: "direct_demonstration",
        attemptContext: "conversation",
        studentInitiated: true,
        isSuperseded: false,
      } as Doc<"masteryObservations">),
    );

    const byDomain = await t.run((ctx) =>
      readScholarMastery(ctx, scholarId, "teacher"),
    );

    const mathRow = byDomain["Mathematics"][0];
    expect(mathRow.attemptContext).toBe("portfolio_scan");
    expect(mathRow.source).toBe("Learning Print");

    // Empty documentHeading → fall back to the item's title.
    const geometryRow = byDomain["Geometry"][0];
    expect(geometryRow.attemptContext).toBe("portfolio_scan");
    expect(geometryRow.source).toBe("field-notes.jpg");

    const physicsRow = byDomain["Physics"][0];
    expect(physicsRow.attemptContext).toBe("conversation");
    expect(physicsRow.source).toBeUndefined();
  });

  test("a TIER-1 caller (parent/scholar) never gets the scan source label — a staff-only artifact's title cannot leak", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "Alinda");

    // A staff-only capture-station artifact whose printed heading names it.
    const staffOnlyItem = await seedItem(t, scholarId, {
      title: "Sensitive Capture Title",
      documentHeading: "Sensitive Capture Title",
      source: "capture_station",
      familyVisibility: "staff_only",
    });
    // A non-misconception scan observation IS visible to tier-1 callers (only
    // misconception rows are stripped) — so without the role gate its `source`
    // (the staff-only title) would reach a parent/scholar transport.
    await seedScanObservation(t, scholarId, staffOnlyItem, {
      conceptLabel: "Area model",
      domain: "Mathematics",
      evidenceType: "direct_demonstration",
    });

    for (const role of ["parent", "scholar"] as const) {
      const byDomain = await t.run((ctx) =>
        readScholarMastery(ctx, scholarId, role),
      );
      const row = byDomain["Mathematics"][0];
      // The observation still surfaces (it is not a misconception)…
      expect(row.concept).toBe("Area model");
      // …but never the document title, and not on any row in any domain.
      expect(row.source).toBeUndefined();
      const everySource = Object.values(byDomain)
        .flat()
        .map((r) => r.source);
      expect(everySource.every((s) => s === undefined)).toBe(true);
      const serialized = JSON.stringify(byDomain);
      expect(serialized).not.toContain("Sensitive Capture Title");
    }

    // A teacher DOES get the label (control).
    const asTeacher = await t.run((ctx) =>
      readScholarMastery(ctx, scholarId, "teacher"),
    );
    expect(asTeacher["Mathematics"][0].source).toBe("Sensitive Capture Title");
  });
});

describe("getScholarWorkSamples — assignment title resolution", () => {
  test("a standing assignment (no unit) resolves its own title; a unit assignment's custom title overrides the unit", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "Alinda");
    const teacherId = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "T",
        role: "teacher",
      } as Doc<"users">),
    );

    // Standing (practice-mode) assignment: NO unitId, has its own title.
    const standingId = await t.run((ctx) =>
      ctx.db.insert("assignments", {
        teacherId,
        scholarIds: [scholarId],
        startedAt: Date.now(),
        title: "Daily Practice",
      } as Doc<"assignments">),
    );
    // Unit assignment whose custom title overrides the unit's title.
    const { customUnitAssignmentId } = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Unit Title",
        isActive: true,
      } as Doc<"units">);
      const customUnitAssignmentId = await ctx.db.insert("assignments", {
        teacherId,
        unitId,
        scholarIds: [scholarId],
        startedAt: Date.now(),
        title: "Custom Assignment Title",
      } as Doc<"assignments">);
      return { customUnitAssignmentId };
    });

    const standingItem = await seedItem(t, scholarId, {
      title: "standing.jpg",
      assignmentId: standingId,
    });
    await new Promise((r) => setTimeout(r, 5));
    const unitItem = await seedItem(t, scholarId, {
      title: "unit.jpg",
      assignmentId: customUnitAssignmentId,
    });

    const samples = await t.query(
      internal.lib.scholarReads.getScholarWorkSamples,
      { scholarId },
    );
    const byId = new Map(samples.items.map((s) => [s.itemId, s]));

    const standing = byId.get(standingItem)!;
    expect(standing.hasAssignment).toBe(true);
    expect(standing.assignmentTitle).toBe("Daily Practice");

    const unit = byId.get(unitItem)!;
    expect(unit.hasAssignment).toBe(true);
    expect(unit.assignmentTitle).toBe("Custom Assignment Title");
  });
});

describe("getScholarWorkSamples — graceful degradation on a non-matching query", () => {
  test("a non-matching query on a scholar WITH work falls back to recent items and flags queryMatched false", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "Alinda");

    // Real onboarding scans carry section headers, never the colloquial name a
    // teacher uses ("learning print").
    const olderId = await seedItem(t, scholarId, {
      title: "strengths.jpg",
      documentHeading: "I. STRENGTHS AND INTERESTS",
    });
    await new Promise((r) => setTimeout(r, 5));
    const newerId = await seedItem(t, scholarId, {
      title: "goals.jpg",
      documentHeading: "II. GOALS",
    });

    const result = await t.query(
      internal.lib.scholarReads.getScholarWorkSamples,
      { scholarId, query: "learning print" },
    );

    // Nothing matched the name, but the scholar's work is returned anyway,
    // newest-first, honestly flagged as a non-match.
    expect(result.queryMatched).toBe(false);
    expect(result.items.map((s) => s.itemId)).toEqual([newerId, olderId]);
  });

  test("a matching query still reports queryMatched true (no false fallback)", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "Alinda");

    const matchId = await seedItem(t, scholarId, {
      title: "strengths.jpg",
      documentHeading: "I. STRENGTHS AND INTERESTS",
    });
    await seedItem(t, scholarId, {
      title: "goals.jpg",
      documentHeading: "II. GOALS",
    });

    const result = await t.query(
      internal.lib.scholarReads.getScholarWorkSamples,
      { scholarId, query: "strengths" },
    );
    expect(result.queryMatched).toBe(true);
    expect(result.items.map((s) => s.itemId)).toEqual([matchId]);
  });

  test("a scholar with NO work returns an empty list — never a fabricated fallback", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "Alinda");

    const result = await t.query(
      internal.lib.scholarReads.getScholarWorkSamples,
      { scholarId, query: "learning print" },
    );
    expect(result.items).toEqual([]);
    // The query did not match (there was nothing to match), and there is no
    // work to fall back to — the tool layer keys "no work at all" off the empty
    // list, not off this flag.
    expect(result.queryMatched).toBe(false);
  });
});
