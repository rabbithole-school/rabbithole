import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { gradeTemplateItem } from "../lib/practice/session";
import { masteryOf } from "../../shared/treeMapLayout";

// ── BREADTH-FIRST placement serving, SERVER SIDE ───────────────────────────
// finish-the-check-in (founder 2026-08-18). This file replaces the open-run
// cap's server-side suite: the cap (one in-progress run per scholar, across
// domains, with a staleness escape hatch) is deleted. Its job was to stop a
// scholar accumulating runs they never chose and to stop a run that was going
// well from being dropped to open another; breadth-first ordering answers that
// directly — every eligible strand gets its first probe, then domains deepen
// foundational-first to convergence.
//
// What must hold now is different, and stronger:
//   • several in-progress runs are a LEGAL shape, and each progresses to its own
//     convergence independently;
//   • a probe already served is never lost — a parked run resumes mid-search,
//     and a deliberate single-domain entry is never refused;
//   • a SHADOW-PLACED domain (mastery rows, no converged run) is searched, and
//     the search does not clobber the mastery it already holds.
// The pure policy is unit-tested in convex/lib/practice/__tests__ (mapping,
// domainMapStatus); the cross-surface ghost guard is in checkInCrossSurface.

const modules = (import.meta as ImportMeta & { glob: (p: string) => Record<string, () => Promise<unknown>> }).glob("../**/*.ts");

const WHOLE = "whole-number-arithmetic";
const FRACTION = "fraction-arithmetic";
const GEOMETRY = "geometry-measurement";
const PROBABILITY = "probability";

async function seedScholar(
  t: ReturnType<typeof convexTest>,
  username: string,
  gradeLevel: string | null = "9",
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Breadth Scholar",
      username,
      role: "scholar",
      ...(gradeLevel ? { gradeLevel } : {}),
    }),
  );
}

async function asUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: 8_000_000_000_000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

async function placementRows(t: ReturnType<typeof convexTest>, scholarId: Id<"users">) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("practicePlacements").collect()).filter((r) => r.scholarId === scholarId),
  );
}

async function placementRow(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  domain: string,
) {
  return (await placementRows(t, scholarId)).find((r) => r.domain === domain) ?? null;
}

type BandItem = { itemId: string; lane?: string; domain?: string; skillKey: string };

async function serveBand(
  asScholar: Awaited<ReturnType<typeof asUser>>,
  scholarId: Id<"users">,
  seed: number,
  extra: { domain?: string; choiceHint?: { domain: string; strand: string } } = {},
): Promise<BandItem[]> {
  const served = (await asScholar.query(api.practiceSkills.practiceSession, {
    scholarId,
    seed,
    includeMapping: true,
    ...extra,
  })) as unknown as { items: BandItem[] };
  return served.items.filter((it) => it.lane === "mapping");
}

/** Answer every mapping item in a served band, all-correct. */
async function answerBand(
  asScholar: Awaited<ReturnType<typeof asUser>>,
  scholarId: Id<"users">,
  items: BandItem[],
  seed: number,
) {
  for (const it of items) {
    await asScholar.mutation(api.practiceSkills.submitMappingAnswer, {
      scholarId,
      domain: it.domain ?? WHOLE,
      itemId: it.itemId,
      seed,
      answer: gradeTemplateItem(it.itemId, "0")?.correctAnswer ?? "0",
    });
  }
}

/** Mark `domains` MAPPED — a converged run plus the mastery a finalize writes. */
async function mapDomains(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  domains: string[],
) {
  await t.run(async (ctx) => {
    const nodes = await ctx.db.query("knowledgeNodes").collect();
    for (const domain of domains) {
      const node = nodes.find((n) => n.domain === domain)!;
      await ctx.db.insert("practiceMastery", {
        scholarId,
        skillKey: node.nodeKey,
        domain,
        strand: node.strand,
        repetition: 3,
        halfLifeDays: 30,
        lastPracticedAt: Date.now(),
        frontier: false,
        source: "placement",
        updatedAt: Date.now(),
      });
      await ctx.db.insert("practicePlacements", {
        scholarId,
        domain,
        status: "complete",
        probesAnswered: 1,
        probeLog: [
          { nodeKey: node.nodeKey, strand: node.strand ?? "", outcome: "correct", at: Date.now() },
        ],
        updatedAt: Date.now(),
      });
    }
  });
}

describe("breadth-first serving — the band spans every servable domain", () => {
  test("FIRST COVERAGE everywhere before any domain converges — and no strand is deepened twice in pass 1", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "breadth_band", null);
    const asScholar = await asUser(t, scholar);
    // Whole-number and fractions mapped → geometry, probability and ratio all
    // become servable at once. Under the old one-domain-at-a-time scoping the
    // band could only ever touch ONE of them until it finished.
    await mapDomains(t, scholar, [WHOLE, FRACTION]);
    const servable = [GEOMETRY, PROBABILITY];

    // Drive the band until the first of them converges. Because pass 1 outranks
    // every deepening candidate, by then EVERY servable domain must already hold
    // answered probes — that is what breadth-first buys.
    let rounds = 0;
    for (; rounds < 200; rounds++) {
      const band = await serveBand(asScholar, scholar, 61 + rounds);
      if (band.length === 0) break;
      // While pass 1 is still running, nothing may be probed twice in a strand.
      const openRows = (await placementRows(t, scholar)).filter((r) => r.status === "in_progress");
      const passOneStillRunning = servable.some(
        (d) => (openRows.find((r) => r.domain === d)?.probeLog?.length ?? 0) === 0,
      );
      if (passOneStillRunning) {
        const strandKeys = openRows.flatMap((r) =>
          (r.probeLog ?? []).map((e: { strand: string }) => `${r.domain}:${e.strand}`),
        );
        expect(new Set(strandKeys).size).toBe(strandKeys.length);
      }
      await answerBand(asScholar, scholar, band, 61 + rounds);
      if ((await placementRows(t, scholar)).some((r) => r.status === "complete" && servable.includes(r.domain))) {
        break;
      }
    }
    expect(rounds).toBeLessThan(200);
    const rows = await placementRows(t, scholar);
    for (const d of servable) {
      expect((rows.find((r) => r.domain === d)?.probeLog?.length ?? 0), d).toBeGreaterThan(0);
    }
  });

  test("a scholar may hold SEVERAL in-progress runs, and each converges on its own", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "breadth_multi_run");
    const asScholar = await asUser(t, scholar);
    await mapDomains(t, scholar, [WHOLE, FRACTION]);

    // Several runs open side by side — the shape the one-run cap forbade.
    let sawSeveralOpen = false;
    for (let round = 0; round < 200; round++) {
      const band = await serveBand(asScholar, scholar, 71 + round);
      if (band.length === 0) break;
      await answerBand(asScholar, scholar, band, 71 + round);
      const open = (await placementRows(t, scholar)).filter(
        (r) => r.status === "in_progress" && (r.probeLog?.length ?? 0) > 0,
      );
      if (open.length > 1) sawSeveralOpen = true;
    }
    expect(sawSeveralOpen).toBe(true);

    // …and none is abandoned `in_progress` behind another: every run finishes.
    const rows = await placementRows(t, scholar);
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.every((r) => r.status === "complete")).toBe(true);
  });
});

describe("breadth-first serving — no probe is ever lost", () => {
  test("PARKED RUN: a row with answered probes and no served probe resumes mid-search on BOTH surfaces", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "breadth_parked", null);
    const asScholar = await asUser(t, scholar);

    // Answer one band batch, then age the rows: this is the shape every
    // in-flight run on prod is in — a probeLog, no `servedProbe`, untouched for
    // weeks. It used to be ignored past the staleness hatch; now it just resumes.
    const first = await serveBand(asScholar, scholar, 81);
    await answerBand(asScholar, scholar, first, 81);
    const before = await placementRow(t, scholar, WHOLE);
    expect(before?.probeLog?.length).toBe(first.length);
    expect(before?.servedProbe).toBeUndefined();
    await t.run(async (ctx) =>
      ctx.db.patch(before!._id, { updatedAt: Date.now() - 30 * 24 * 60 * 60 * 1000 }),
    );

    // The band continues the SAME row rather than restarting it, and never
    // re-asks a node the scholar already answered.
    const answeredKeys = new Set((before!.probeLog ?? []).map((e: { nodeKey: string }) => e.nodeKey));
    const resumed = await serveBand(asScholar, scholar, 82);
    expect(resumed.length).toBeGreaterThan(0);
    expect(resumed.some((it) => answeredKeys.has(it.skillKey))).toBe(false);
    await answerBand(asScholar, scholar, resumed, 82);
    const after = await placementRow(t, scholar, WHOLE);
    expect(after?._id).toBe(before!._id);
    expect(after!.probeLog!.length).toBeGreaterThan(first.length);
    // Nothing from the first sitting was dropped or re-asked.
    const afterKeys = (after!.probeLog ?? []).map((e: { nodeKey: string }) => e.nodeKey);
    expect(new Set(afterKeys).size).toBe(afterKeys.length);
    for (const key of answeredKeys) expect(afterKeys).toContain(key);

    // The check-in resumes the same row too — no restart, no probe re-asked.
    const primed = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, {
      scholarId: scholar,
      seed: 83,
    });
    expect(primed.probe).not.toBeNull();
    const wholeAfterPrime = await placementRow(t, scholar, WHOLE);
    expect(wholeAfterPrime?._id).toBe(before!._id);
    const answeredNow = new Set((wholeAfterPrime!.probeLog ?? []).map((e: { nodeKey: string }) => e.nodeKey));
    expect(answeredNow.has(primed.probe!.skillKey)).toBe(false);
  });

  test("a deliberate single-domain entry is never refused, even with other runs open", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "breadth_single_entry");
    const asScholar = await asUser(t, scholar);

    // Open a run through the band first…
    await answerBand(asScholar, scholar, await serveBand(asScholar, scholar, 91), 91);
    expect((await placementRow(t, scholar, WHOLE))?.probeLog?.length).toBeGreaterThan(0);

    // …then walk into a DIFFERENT domain's single-domain loop. This used to come
    // back `paused` with `openRunDomain` pointing at the first run; it now opens.
    const res = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, {
      scholarId: scholar,
      seed: 92,
      domain: GEOMETRY,
    });
    expect(res.done).toBe(false);
    expect(res.probe).not.toBeNull();
    expect("paused" in res).toBe(false);

    // The read side agrees — a boot/reload lands on the same live probe.
    const current = await asScholar.query(api.practiceSkills.placementCurrent, {
      scholarId: scholar,
      domain: GEOMETRY,
    });
    expect(current.probe?.itemId).toBe(res.probe!.itemId);
    expect(current.needsStart).toBe(false);
    expect((await placementRows(t, scholar)).map((r) => r.domain).sort()).toEqual(
      [GEOMETRY, WHOLE].sort(),
    );
  });

  test("ANTI-STRANDING: a domain with nothing probeable finalizes instead of parking forever", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "breadth_no_strand");
    const asScholar = await asUser(t, scholar);

    // Real nodes, no templates: nothing is probeable, so the search has nothing
    // to ask. Priming must finalize the row rather than leave it in_progress.
    const untemplated = "placement-breadth-untemplated";
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert("knowledgeNodes", {
          nodeKey: `breadth_untemplated_${i}`,
          label: `Untemplated ${i}`,
          domain: untemplated,
          strand: "only",
          order: i,
          source: "practice",
        });
      }
      await ctx.db.insert("practicePlacements", {
        scholarId: scholar,
        domain: untemplated,
        status: "in_progress",
        probesAnswered: 1,
        probeLog: [
          { nodeKey: "breadth_untemplated_0", strand: "only", outcome: "correct", at: Date.now() },
        ],
        updatedAt: Date.now(),
      });
    });

    const res = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, {
      scholarId: scholar,
      seed: 3,
      domain: untemplated,
    });
    expect(res.done).toBe(true);
    expect((await placementRow(t, scholar, untemplated))?.status).toBe("complete");
    expect(
      await asScholar.query(api.practiceSkills.needsPlacement, { scholarId: scholar, domain: untemplated }),
    ).toBe(false);
  });
});

describe("shadow placement — mastery is not a map", () => {
  test("a domain with DEMONSTRATED mastery and no converged run is searched to convergence, and its earned rows survive intact", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "breadth_shadow");
    const asScholar = await asUser(t, scholar);

    // Real drilled mastery across a tier of whole-number (source "practice" —
    // what problem-set grading writes), and NO placement row at all. Before the
    // ruling this domain read as done and was never probed; now it is
    // shadow-placed, and finalize meets these rows for the first time.
    const demonstrated = await t.run(async (ctx) => {
      const nodes = (await ctx.db.query("knowledgeNodes").collect())
        .filter((n) => n.domain === WHOLE)
        .slice(0, 8);
      for (const node of nodes) {
        await ctx.db.insert("practiceMastery", {
          scholarId: scholar,
          skillKey: node.nodeKey,
          domain: WHOLE,
          strand: node.strand,
          repetition: 6,
          halfLifeDays: 40,
          lastPracticedAt: Date.now() - 3 * 86_400_000,
          lastAttemptAt: Date.now() - 3 * 86_400_000,
          becameFluentAt: Date.now() - 20 * 86_400_000,
          frontier: false,
          source: "practice",
          updatedAt: Date.now(),
        });
      }
      return nodes.map((n) => n.nodeKey);
    });
    expect(await placementRow(t, scholar, WHOLE)).toBeNull();
    const before = await t.run(async (ctx) =>
      (await ctx.db.query("practiceMastery").collect()).filter((r) => r.scholarId === scholar),
    );

    // It is servable, and the band searches it — all the way to a converged run,
    // which is the path that reaches `creditPlacementFrontiers`.
    expect(
      await asScholar.query(api.practiceSkills.needsAnyPlacement, { scholarId: scholar }),
    ).toBe(true);
    let probed = 0;
    for (let round = 0; round < 200; round++) {
      const row = await placementRow(t, scholar, WHOLE);
      if (row?.status === "complete") break;
      const band = (await serveBand(asScholar, scholar, 101 + round)).filter(
        (it) => (it.domain ?? WHOLE) === WHOLE,
      );
      if (band.length === 0) break;
      probed += band.length;
      await answerBand(asScholar, scholar, band, 101 + round);
    }
    expect(probed).toBeGreaterThan(0);
    expect((await placementRow(t, scholar, WHOLE))?.status).toBe("complete");

    const after = await t.run(async (ctx) =>
      (await ctx.db.query("practiceMastery").collect()).filter((r) => r.scholarId === scholar),
    );

    // (1) EXACTLY ONE row per skillKey. A blind insert on top of the earned rows
    // would duplicate them, and `loadMastery` is last-row-wins, so the inferred
    // copy would shadow the demonstrated one everywhere.
    const keys = after.map((r) => r.skillKey);
    expect(new Set(keys).size).toBe(keys.length);

    // (2) The demonstrated rows are untouched: still `source: "practice"`, still
    // their earned reps / half-life / fluency stamp. Placement may only ever
    // RAISE, and it had nothing to raise here.
    for (const key of demonstrated) {
      const was = before.find((r) => r.skillKey === key)!;
      const now = after.find((r) => r.skillKey === key);
      expect(now, key).toBeDefined();
      expect(now!._id, key).toBe(was._id);
      expect(now!.source, key).toBe("practice");
      expect(now!.repetition, key).toBe(was.repetition);
      expect(now!.halfLifeDays, key).toBe(was.halfLifeDays);
      expect(now!.becameFluentAt, key).toBe(was.becameFluentAt);
      expect(now!.lastAttemptAt, key).toBe(was.lastAttemptAt);
      // The SR clock is not re-stamped by a credit the scholar never answered.
      expect(now!.lastPracticedAt, key).toBe(was.lastPracticedAt);
    }

    // (3) The map still reads them GREEN. This is the failure the two-axis
    // invariant forbids: an inferred row shadowing an earned one flips
    // `masteryOf` from "fluent" to "placed" — earned green quietly downgraded.
    const tree = await asScholar.query(api.practiceSkills.treeForScholar, {
      scholarId: scholar,
      domain: WHOLE,
    });
    for (const key of demonstrated) {
      const node = tree.nodes.find((n) => n.skillKey === key)!;
      expect(node.demonstrated, key).toBe(true);
      expect(masteryOf(node), key).not.toBe("placed");
      expect(["fluent", "overlearned"]).toContain(masteryOf(node));
    }

    // (4) Nodes the search credited that had NO earned row are ordinary inferred
    // placement credit — the band did really write something.
    const inferred = after.filter((r) => r.source === "placement" && r.repetition > 0);
    expect(inferred.length).toBeGreaterThan(0);
  });

  test("a search never MINTS demonstrated fluency from a below-fluent practised node", async () => {
    // The dual of the test above. There, the earned rows were already fluent, so
    // raise-only had nothing to raise. Here a tier is only PARTLY practised — a
    // single rep, below the FLUENT_REPS floor, not yet green. The search credits
    // below its frontier and MEETS these rows. Keeping `source: "practice"` while
    // lifting reps to the fluent floor would turn a once-practised node GREEN out
    // of inference — demonstrated fluency manufactured by a placement search,
    // which rule 4 forbids. The lift must instead read PROVISIONAL ("placed").
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "breadth_shadow_subfluent");
    const asScholar = await asUser(t, scholar);

    const subFluent: string[] = [];
    const fluent: string[] = [];
    await t.run(async (ctx) => {
      const nodes = (await ctx.db.query("knowledgeNodes").collect())
        .filter((n) => n.domain === WHOLE)
        .slice(0, 8);
      nodes.forEach((node, i) => (i < 4 ? subFluent : fluent).push(node.nodeKey));
      for (const node of nodes) {
        const below = subFluent.includes(node.nodeKey);
        await ctx.db.insert("practiceMastery", {
          scholarId: scholar,
          skillKey: node.nodeKey,
          domain: WHOLE,
          strand: node.strand,
          repetition: below ? 1 : 6,
          halfLifeDays: below ? 2 : 40,
          lastPracticedAt: Date.now() - 3 * 86_400_000,
          lastAttemptAt: Date.now() - 3 * 86_400_000,
          ...(below ? {} : { becameFluentAt: Date.now() - 20 * 86_400_000 }),
          frontier: false,
          source: "practice",
          updatedAt: Date.now(),
        });
      }
    });

    for (let round = 0; round < 200; round++) {
      const row = await placementRow(t, scholar, WHOLE);
      if (row?.status === "complete") break;
      const band = (await serveBand(asScholar, scholar, 400 + round)).filter(
        (it) => (it.domain ?? WHOLE) === WHOLE,
      );
      if (band.length === 0) break;
      await answerBand(asScholar, scholar, band, 400 + round);
    }
    expect((await placementRow(t, scholar, WHOLE))?.status).toBe("complete");

    const after = await t.run(async (ctx) =>
      (await ctx.db.query("practiceMastery").collect()).filter(
        (r) => r.scholarId === scholar && r.domain === WHOLE,
      ),
    );
    const rowFor = (key: string) => after.find((r) => r.skillKey === key)!;

    // THE INVARIANT (F1): no sub-fluent practised node the search lifted to the
    // fluent floor may end up demonstrated-fluent. If it was lifted, it is now
    // provisional (source "placement"); it is NEVER (practice && reps >= 3).
    let lifted = 0;
    for (const key of subFluent) {
      const row = rowFor(key);
      expect(row, key).toBeDefined();
      expect(
        row.source === "practice" && row.repetition >= 3,
        `${key} must not be manufactured demonstrated-fluent`,
      ).toBe(false);
      if (row.repetition >= 3) {
        lifted++;
        expect(row.source, key).toBe("placement");
      }
    }
    expect(lifted).toBeGreaterThan(0); // the credit path actually fired

    // The already-fluent demonstrated rows are the earned green the earlier fix
    // protects — untouched.
    for (const key of fluent) {
      const row = rowFor(key);
      expect(row.source, key).toBe("practice");
      expect(row.repetition, key).toBe(6);
    }

    // The tree agrees: a lifted node reads provisional, a control node green.
    const tree = await asScholar.query(api.practiceSkills.treeForScholar, {
      scholarId: scholar,
      domain: WHOLE,
    });
    const liftedKey = subFluent.find((k) => rowFor(k).repetition >= 3)!;
    const liftedNode = tree.nodes.find((n) => n.skillKey === liftedKey);
    if (liftedNode) {
      expect(masteryOf(liftedNode)).toBe("placed");
      expect(liftedNode.demonstrated).toBe(false);
    }
    const fluentNode = tree.nodes.find((n) => n.skillKey === fluent[0]);
    if (fluentNode) expect(["fluent", "overlearned"]).toContain(masteryOf(fluentNode));
  });

  test("a shadow-placed domain does NOT lose its ordinary practice work to the mapping band", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "breadth_shadow_drill");
    const asScholar = await asUser(t, scholar);

    // A whole tier of real drilled mastery, still unmapped. The band must ride
    // ALONGSIDE that domain's ordinary items (a blend), not replace them —
    // suppressing frontier work is for a domain with nothing earned to serve.
    await t.run(async (ctx) => {
      const nodes = (await ctx.db.query("knowledgeNodes").collect()).filter(
        (n) => n.domain === WHOLE,
      );
      for (const node of nodes.slice(0, 6)) {
        await ctx.db.insert("practiceMastery", {
          scholarId: scholar,
          skillKey: node.nodeKey,
          domain: WHOLE,
          strand: node.strand,
          repetition: 5,
          halfLifeDays: 1,
          lastPracticedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
          lastAttemptAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
          frontier: false,
          source: "practice",
          updatedAt: Date.now(),
        });
      }
    });

    const served = (await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 111,
      includeMapping: true,
      domain: WHOLE,
    })) as unknown as { items: BandItem[]; allMapping: boolean };
    expect(served.items.some((it) => it.lane === "mapping")).toBe(true);
    expect(served.items.some((it) => it.lane !== "mapping")).toBe(true);
    expect(served.allMapping).toBe(false);
  });
});

describe("the affect-safe ring gates AUTOMATIC opening only", () => {
  test("no grade on file → the K ring; a deliberate pick still opens a high-floor domain", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "breadth_no_grade", null);
    const asScholar = await asUser(t, scholar);
    // Everything the K ring reaches is already mapped, so only the high-floor
    // domains remain. Automatic serving must find nothing.
    await mapDomains(t, scholar, [WHOLE, FRACTION, GEOMETRY, PROBABILITY]);

    expect(await serveBand(asScholar, scholar, 121)).toHaveLength(0);
    expect(
      await asScholar.query(api.practiceSkills.needsAnyPlacement, { scholarId: scholar }),
    ).toBe(false);

    // A deliberate pick is not gated — it opens the domain and, once a probe is
    // answered there, the run keeps serving on the default entry too.
    const RATIO = "ratio-proportion-percent";
    const strand = await t.run(async (ctx) => {
      const node = (await ctx.db.query("knowledgeNodes").collect()).find(
        (n) => n.domain === RATIO,
      )!;
      return node.strand ?? "";
    });
    const deliberate = await serveBand(asScholar, scholar, 122, {
      domain: RATIO,
      choiceHint: { domain: RATIO, strand },
    });
    expect(deliberate.length).toBeGreaterThan(0);
    expect(deliberate.every((it) => it.domain === RATIO)).toBe(true);
    await answerBand(asScholar, scholar, deliberate, 122);
    expect((await placementRow(t, scholar, RATIO))?.probeLog?.length).toBeGreaterThan(0);

    // Once the scholar's own choice has opened the run, the DEFAULT entry serves
    // it too — the ring gates which domain opens automatically, it never un-opens
    // one the scholar chose. Drive it out: a deliberate pick maps an out-of-ring
    // domain end to end.
    for (let round = 0; round < 60; round++) {
      const row = await placementRow(t, scholar, RATIO);
      if (row?.status === "complete") break;
      const resumed = await serveBand(asScholar, scholar, 123 + round);
      expect(resumed.length).toBeGreaterThan(0);
      expect(resumed.every((it) => it.domain === RATIO)).toBe(true);
      await answerBand(asScholar, scholar, resumed, 123 + round);
    }
    expect((await placementRow(t, scholar, RATIO))?.status).toBe("complete");
    // And with the whole map now drawn, automatic serving is quiet again.
    expect(await serveBand(asScholar, scholar, 199)).toHaveLength(0);
    expect(
      await asScholar.query(api.practiceSkills.needsAnyPlacement, { scholarId: scholar }),
    ).toBe(false);
  });

  test("REACHABLE above-ring domain (raise-the-ceiling): converged prereqs never make it auto-servable", async () => {
    // Algebra 1 sits well above a grade-4 ring. Once every one of its
    // cross-domain prereqs has converged it becomes `reachable` — offerable on
    // the deliberate new-territory surface (newTerritoryCards.test.ts) — but the
    // AUTOMATIC breadth-first loop must never probe it on its own
    // (`scratch-critiques/slip-confirm-interaction-review.md` §3a).
    const ALGEBRA1 = "algebra-1";
    const A1_PREREQS = [
      WHOLE,
      FRACTION,
      GEOMETRY,
      "ratio-proportion-percent",
      "integers-coordinates",
      "early-algebra",
    ];
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "breadth_reachable_ceiling", "4");
    const asScholar = await asUser(t, scholar);
    await mapDomains(t, scholar, A1_PREREQS);

    // Confirm the classification agrees it's reachable-but-ineligible before
    // touching the serve path at all.
    const map = await asScholar.query(api.practiceSkills.domainMapForScholar, {
      scholarId: scholar,
    });
    const a1Entry = map.find((d) => d.domain === ALGEBRA1);
    expect(a1Entry?.status).toBe("ineligible");
    expect(a1Entry?.eligible).toBe(false);

    // Drive the automatic breadth-first band to quiet, and at every step assert
    // no served item ever comes from algebra-1 and no placement row opens there.
    for (let round = 0; round < 40; round++) {
      const items = await serveBand(asScholar, scholar, 501 + round);
      expect(items.every((it) => it.domain !== ALGEBRA1)).toBe(true);
      if (items.length === 0) break;
      await answerBand(asScholar, scholar, items, 501 + round);
    }
    expect(await placementRow(t, scholar, ALGEBRA1)).toBeNull();

    // The mixed check-in orchestrator agrees too — drive it all-correct and
    // confirm algebra-1 never appears in the served probe sequence.
    let cur = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, {
      scholarId: scholar,
      seed: 601,
    });
    for (let i = 0; i < 200 && !cur.done && cur.probe; i++) {
      const p = cur.probe;
      expect(p.domain).not.toBe(ALGEBRA1);
      cur = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, {
        scholarId: scholar,
        seed: 601,
        itemId: p.itemId,
        answer: gradeTemplateItem(p.itemId, "0")?.correctAnswer ?? "0",
      });
    }
    expect(await placementRow(t, scholar, ALGEBRA1)).toBeNull();
  });
});
