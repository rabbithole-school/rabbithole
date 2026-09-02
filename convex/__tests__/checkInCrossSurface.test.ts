import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { gradeTemplateItem } from "../lib/practice/session";
import { gradeRank } from "../lib/practice/placement";

// ── THE GHOST-PROBE GUARD (finish-the-check-in, founder 2026-08-18) ─────────
//
// Two surfaces now serve the same placement probes: the playlist's `· mapping`
// band and the multi-domain check-in orchestrator. A scholar can abandon a probe
// on either one and come back through the other, so the ruling's decision 3 is a
// hard requirement: **an abandoned probe must visibly re-enter the queue on
// whichever surface asks next, and answering it must grade exactly once.**
//
// The two surfaces park a probe differently, and the guarantee differs with it:
//   • the ORCHESTRATOR persists `servedProbe` on the row, so the band re-serves
//     that EXACT item — same nodeKey, same itemId, same seed;
//   • the BAND persists nothing (it serves a batch, deterministic by itemId), so
//     the orchestrator resumes the same PROBE NODE, derived from the untouched
//     probeLog through the shared candidate/ordering policy. The itemId differs
//     because the two surfaces seed item ids in different namespaces; what must
//     not differ is which skill the scholar is asked about, and that no answer is
//     lost or double-counted.

const modules = (import.meta as ImportMeta & { glob: (p: string) => Record<string, () => Promise<unknown>> }).glob("../**/*.ts");

const WHOLE = "whole-number-arithmetic";

async function seedScholar(t: ReturnType<typeof convexTest>, username: string) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "Cross-surface Scholar", username, role: "scholar" }),
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

type BandItem = { itemId: string; lane?: string; domain?: string; skillKey: string };

async function serveBand(
  asScholar: Awaited<ReturnType<typeof asUser>>,
  scholarId: Id<"users">,
  seed: number,
): Promise<BandItem[]> {
  const served = (await asScholar.query(api.practiceSkills.practiceSession, {
    scholarId,
    seed,
    includeMapping: true,
  })) as unknown as { items: BandItem[] };
  return served.items.filter((it) => it.lane === "mapping");
}

async function rowFor(t: ReturnType<typeof convexTest>, scholarId: Id<"users">, domain: string) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("practicePlacements").collect()).find(
      (r) => r.scholarId === scholarId && r.domain === domain,
    ) ?? null,
  );
}

async function allAttempts(t: ReturnType<typeof convexTest>, scholarId: Id<"users">) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("practiceAttempts").collect()).filter((a) => a.scholarId === scholarId),
  );
}

describe("ghost probe — orchestrator serves, the playlist band picks it up", () => {
  test("a probe abandoned in the check-in is re-served VERBATIM by the mapping band", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "ghost_mixed_to_band");
    const asScholar = await asUser(t, scholar);

    // Prime the check-in and walk away: the probe is parked on the row.
    const primed = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, {
      scholarId: scholar,
      seed: 41,
    });
    const parked = primed.probe!;
    const row = await rowFor(t, scholar, parked.domain);
    expect(row?.servedProbe?.itemId).toBe(parked.itemId);
    expect(row?.probeLog ?? []).toHaveLength(0);

    // The next composed playlist serves THAT probe — same item id, same seed, not
    // a freshly-derived one for the same strand.
    const band = await serveBand(asScholar, scholar, 42);
    const reserved = band.find((it) => it.itemId === parked.itemId);
    expect(reserved, "the parked probe must re-enter the band").toBeDefined();
    expect(reserved!.skillKey).toBe(parked.skillKey);
    expect(reserved!.domain ?? WHOLE).toBe(parked.domain);
  });

  test("answering the re-served probe on the OTHER surface grades it exactly once", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "ghost_graded_once");
    const asScholar = await asUser(t, scholar);

    const primed = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, {
      scholarId: scholar,
      seed: 51,
    });
    const parked = primed.probe!;
    const band = await serveBand(asScholar, scholar, 52);
    const reserved = band.find((it) => it.itemId === parked.itemId)!;

    const graded = await asScholar.mutation(api.practiceSkills.submitMappingAnswer, {
      scholarId: scholar,
      domain: parked.domain,
      itemId: reserved.itemId,
      seed: 52,
      answer: gradeTemplateItem(reserved.itemId, "0")?.correctAnswer ?? "0",
    });
    expect(graded.alreadyMapped).toBe(false);
    expect(graded.outcome).toBe("correct");

    // ONE probeLog entry, ONE attempt row, and the parked probe is released so
    // the check-in cannot hand it out again.
    const after = await rowFor(t, scholar, parked.domain);
    expect(after?.probeLog?.filter((e: { itemId?: string }) => e.itemId === reserved.itemId)).toHaveLength(1);
    expect(after?.probeLog?.filter((e: { nodeKey: string }) => e.nodeKey === parked.skillKey)).toHaveLength(1);
    expect(after?.servedProbe).toBeUndefined();
    expect((await allAttempts(t, scholar)).filter((a) => a.itemId === reserved.itemId)).toHaveLength(1);

    // Re-entering the check-in moves on rather than re-asking the answered node.
    const next = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, {
      scholarId: scholar,
      seed: 53,
    });
    expect(next.probe?.itemId).not.toBe(parked.itemId);
    expect(next.probe?.skillKey).not.toBe(parked.skillKey);
    const stillOne = await rowFor(t, scholar, parked.domain);
    expect(stillOne?.probeLog?.filter((e: { nodeKey: string }) => e.nodeKey === parked.skillKey)).toHaveLength(1);
  });

  test("a stale submit of the parked probe through the CHECK-IN is idempotent, not a second grade", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "ghost_stale_submit");
    const asScholar = await asUser(t, scholar);

    const primed = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, {
      scholarId: scholar,
      seed: 61,
    });
    const parked = primed.probe!;
    const band = await serveBand(asScholar, scholar, 62);
    const reserved = band.find((it) => it.itemId === parked.itemId)!;
    await asScholar.mutation(api.practiceSkills.submitMappingAnswer, {
      scholarId: scholar,
      domain: parked.domain,
      itemId: reserved.itemId,
      seed: 62,
      answer: gradeTemplateItem(reserved.itemId, "0")?.correctAnswer ?? "0",
    });

    // A client still holding the check-in's copy submits it. The served probe is
    // gone, so this is a no-op re-serve — never a second log entry.
    const stale = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, {
      scholarId: scholar,
      seed: 63,
      itemId: parked.itemId,
      answer: gradeTemplateItem(parked.itemId, "0")?.correctAnswer ?? "0",
    });
    expect(stale.graded).toBeNull();
    const after = await rowFor(t, scholar, parked.domain);
    expect(after?.probeLog?.filter((e: { nodeKey: string }) => e.nodeKey === parked.skillKey)).toHaveLength(1);
    expect((await allAttempts(t, scholar)).filter((a) => a.nodeKey === parked.skillKey)).toHaveLength(1);
  });
});

describe("ghost probe — the band serves, the orchestrator picks it up", () => {
  test("a probe abandoned in the band re-enters the check-in on the same node, and grades once", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "ghost_band_to_mixed");
    const asScholar = await asUser(t, scholar);

    // Serve a band and abandon the whole batch. The band persists no
    // `servedProbe` — its items are deterministic by id — so the run's resumable
    // state is exactly the (empty) probeLog.
    const band = await serveBand(asScholar, scholar, 71);
    expect(band.length).toBeGreaterThan(0);
    const abandoned = band[0];
    expect(await rowFor(t, scholar, abandoned.domain ?? WHOLE)).toBeNull();

    // Opening the check-in resumes on the SAME probe node the band was showing:
    // both surfaces derive candidates through the one shared policy.
    const primed = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, {
      scholarId: scholar,
      seed: 72,
    });
    expect(primed.probe?.domain).toBe(abandoned.domain ?? WHOLE);
    expect(primed.probe?.skillKey).toBe(abandoned.skillKey);

    // Answering it there logs exactly one probe for that node — the band's
    // abandoned copy neither double-counts nor blocks it.
    await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, {
      scholarId: scholar,
      seed: 72,
      itemId: primed.probe!.itemId,
      answer: gradeTemplateItem(primed.probe!.itemId, "0")?.correctAnswer ?? "0",
    });
    const after = await rowFor(t, scholar, abandoned.domain ?? WHOLE);
    expect(after?.probeLog?.filter((e: { nodeKey: string }) => e.nodeKey === abandoned.skillKey)).toHaveLength(1);
    expect((await allAttempts(t, scholar)).filter((a) => a.nodeKey === abandoned.skillKey)).toHaveLength(1);

    // …and the band's own abandoned item, submitted late, is refused as a stale
    // id rather than logged a second time for the same node.
    const late = await asScholar.mutation(api.practiceSkills.submitMappingAnswer, {
      scholarId: scholar,
      domain: abandoned.domain ?? WHOLE,
      itemId: abandoned.itemId,
      seed: 71,
      answer: gradeTemplateItem(abandoned.itemId, "0")?.correctAnswer ?? "0",
    });
    const final = await rowFor(t, scholar, abandoned.domain ?? WHOLE);
    const entries = final?.probeLog?.filter((e: { nodeKey: string }) => e.nodeKey === abandoned.skillKey) ?? [];
    expect(entries).toHaveLength(1);
    // Whatever the late submit reports, it must not have moved the search on.
    expect(late.domainJustMapped).toBe(false);
  });

  test("they still agree when CROSS-DOMAIN INFERENCE is live — a lifted start grade moves both surfaces or neither", async () => {
    // The asymmetry this pins: the check-in seeds a fresh strand's first probe
    // from `higherGrade(scholarGrade, inferredGradeFloor(...))`, so a scholar with
    // a CONVERGED prerequisite domain gets a lifted start. While the band used the
    // plain scholar grade, the two surfaces aimed at DIFFERENT nodes exactly where
    // inference bites, and a band-abandoned probe never resurfaced in the check-in.
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "ghost_inferred_priors");
    const asScholar = await asUser(t, scholar);

    // Whole-number CONVERGED with a contiguous placed-through band up to grade 3
    // — enough for `conservativeDomainPrior` to report a real level, which is what
    // makes the inferred floor non-null for fractions.
    const credited = await t.run(async (ctx) => {
      const nodes = (await ctx.db.query("knowledgeNodes").collect()).filter(
        (n) => n.domain === WHOLE,
      );
      const keys = nodes
        .filter((n) => n.grade !== undefined && gradeRank(n.grade) >= 0 && gradeRank(n.grade) <= gradeRank("3"))
        .map((n) => n.nodeKey);
      for (const key of keys) {
        await ctx.db.insert("practiceMastery", {
          scholarId: scholar,
          skillKey: key,
          domain: WHOLE,
          repetition: 3,
          halfLifeDays: 4,
          lastPracticedAt: Date.now(),
          frontier: false,
          source: "placement",
          updatedAt: Date.now(),
        });
      }
      await ctx.db.insert("practicePlacements", {
        scholarId: scholar,
        domain: WHOLE,
        status: "complete",
        probesAnswered: keys.length,
        probeLog: keys.map((nodeKey) => ({ nodeKey, strand: "", outcome: "correct" as const, at: Date.now() })),
        updatedAt: Date.now(),
      });
      return keys;
    });
    expect(credited.length).toBeGreaterThan(0);

    // The band now serves fractions, on a fresh strand, under the lifted prior.
    const band = await serveBand(asScholar, scholar, 101);
    const abandoned = band.find((it) => it.domain === "fraction-arithmetic");
    expect(abandoned, "fractions should be servable once whole-number converged").toBeDefined();
    expect(await rowFor(t, scholar, "fraction-arithmetic")).toBeNull();

    // Abandon it and open the check-in: same domain, same node.
    const primed = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, {
      scholarId: scholar,
      seed: 102,
    });
    expect(primed.probe?.domain).toBe("fraction-arithmetic");
    expect(primed.probe?.skillKey).toBe(abandoned!.skillKey);
  });

  test("the band and the check-in agree on WHICH probe is next, across a whole sitting", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "ghost_agreement");
    const asScholar = await asUser(t, scholar);

    // Alternate surfaces after every answer. Neither may re-ask an answered node,
    // and the probeLog must stay one entry per node throughout.
    for (let round = 0; round < 8; round++) {
      const band = await serveBand(asScholar, scholar, 81 + round);
      if (band.length === 0) break;
      const answeredBefore = new Set(
        ((await rowFor(t, scholar, band[0].domain ?? WHOLE))?.probeLog ?? []).map((e: { nodeKey: string }) => e.nodeKey),
      );
      expect(answeredBefore.has(band[0].skillKey)).toBe(false);
      await asScholar.mutation(api.practiceSkills.submitMappingAnswer, {
        scholarId: scholar,
        domain: band[0].domain ?? WHOLE,
        itemId: band[0].itemId,
        seed: 81 + round,
        answer: gradeTemplateItem(band[0].itemId, "0")?.correctAnswer ?? "0",
      });

      const primed = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, {
        scholarId: scholar,
        seed: 91 + round,
      });
      if (primed.done || !primed.probe) break;
      const answeredNow = new Set(
        ((await rowFor(t, scholar, primed.probe.domain))?.probeLog ?? []).map((e: { nodeKey: string }) => e.nodeKey),
      );
      expect(answeredNow.has(primed.probe.skillKey)).toBe(false);
      await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, {
        scholarId: scholar,
        seed: 91 + round,
        itemId: primed.probe.itemId,
        answer: gradeTemplateItem(primed.probe.itemId, "0")?.correctAnswer ?? "0",
      });
    }

    // No node was ever graded twice, on either surface.
    const rows = await t.run(async (ctx) =>
      (await ctx.db.query("practicePlacements").collect()).filter((r) => r.scholarId === scholar),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const keys = (row.probeLog ?? []).map((e: { nodeKey: string }) => e.nodeKey);
      expect(new Set(keys).size, `${row.domain} logged a node twice`).toBe(keys.length);
    }
    // Placement credit stays INFERRED on both paths — the two-axis invariant.
    const mastery = await t.run(async (ctx) =>
      (await ctx.db.query("practiceMastery").collect()).filter((r) => r.scholarId === scholar),
    );
    expect(mastery.every((m) => m.source === "placement")).toBe(true);
  });
});
