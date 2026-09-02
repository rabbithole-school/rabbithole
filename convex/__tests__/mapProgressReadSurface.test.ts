import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { ELECTIVE_PRACTICE_DOMAINS } from "../knowledgeNodes";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { PRACTICE_DOMAINS } from "../lib/practice/domains";
import { automaticPlacementGrade, domainHasAffectSafeEntry } from "../lib/practice/placement";

// ── The Home CTA / fog-of-war / completion read-surface (finish-the-check-in
// surfaces, PR2) — the thin queries the client reads instead of the stale
// all-seeded-domain counts `mixedPlacementCurrent` used to carry. These tests
// pin the ONE thing PR1 left the client blind to: N and M must read the
// ELIGIBLE (grade-ring) derivation, never every seeded domain, and mastery
// rows alone must never count as "mapped".

const modules = (import.meta as ImportMeta & { glob: (p: string) => Record<string, () => Promise<unknown>> }).glob("../**/*.ts");

async function seedScholar(
  t: TestConvex<typeof schema>,
  username: string,
  gradeLevel?: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Map Progress Scholar",
      username,
      role: "scholar",
      ...(gradeLevel ? { gradeLevel } : {}),
    }),
  );
}

async function asUser(t: TestConvex<typeof schema>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: 8_000_000_000_000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

/** Independently compute the expected eligible domain COUNT for a scholar
 *  grade, mirroring the automatic-placement K-ring gate — so the assertion
 *  below never hardcodes which/how-many of the 8 seeded domains are eligible,
 *  it re-derives it the same way `domainMapStatus.ts` does. */
async function expectedEligibleCount(
  t: TestConvex<typeof schema>,
  scholarGrade: string | undefined,
): Promise<number> {
  return await t.run(async (ctx) => {
    let count = 0;
    for (const { domain } of PRACTICE_DOMAINS) {
      // Electives are never grade-eligible regardless of tags (the loader
      // folds ELECTIVE_PRACTICE_DOMAINS into gradeEligible).
      if (ELECTIVE_PRACTICE_DOMAINS.has(domain)) continue;
      const nodes = await ctx.db
        .query("knowledgeNodes")
        .withIndex("by_domain", (q) => q.eq("domain", domain))
        .collect();
      if (nodes.length === 0) continue; // not seeded
      if (domainHasAffectSafeEntry(nodes, automaticPlacementGrade(scholarGrade))) count++;
    }
    return count;
  });
}

describe("mapProgressForScholar — the Home CTA's honest N-of-M", () => {
  test("counts a CONVERGED run as mapped, and eligible domains only (not every seeded domain)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "map_progress_honest", "5");
    const asScholar = await asUser(t, scholar);

    const whole = PRACTICE_DOMAINS[0].domain;
    await t.run(async (ctx) => {
      await ctx.db.insert("practicePlacements", {
        scholarId: scholar,
        domain: whole,
        status: "complete",
        probesAnswered: 6,
        updatedAt: Date.now(),
      });
    });

    const progress = await asScholar.query(api.practiceSkills.mapProgressForScholar, {
      scholarId: scholar,
    });
    const expectedEligible = await expectedEligibleCount(t, "5");

    expect(progress.mapped).toBe(1);
    expect(progress.eligible).toBe(expectedEligible);
    // The honest denominator must be strictly narrower than "every seeded
    // domain" for this fixture (8 registered domains, a grade-5 ring can't
    // reach algebra-1) — otherwise this test would not be pinning anything.
    expect(progress.eligible).toBeLessThan(PRACTICE_DOMAINS.length);
    expect(progress.allMapped).toBe(progress.mapped === progress.eligible);
    expect(progress.gradeOnFile).toBe(true);
  });

  test("mastery rows with NO converged run do not count as mapped (shadow-placement)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "map_progress_shadow", "5");
    const asScholar = await asUser(t, scholar);

    const whole = PRACTICE_DOMAINS[0].domain;
    const anyNode = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("knowledgeNodes")
          .withIndex("by_domain", (q) => q.eq("domain", whole))
          .collect()
      )[0],
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: anyNode.nodeKey,
        domain: whole,
        repetition: 3,
        halfLifeDays: 4,
        frontier: false,
        source: "practice",
        updatedAt: Date.now(),
      });
    });

    const progress = await asScholar.query(api.practiceSkills.mapProgressForScholar, {
      scholarId: scholar,
    });
    // Mastery with no converged placement run — unmapped, still counted in the
    // eligible denominator, and still servable (there's real work to search).
    expect(progress.mapped).toBe(0);
    expect(progress.hasServable).toBe(true);

    const perDomain = await asScholar.query(api.practiceSkills.domainMapForScholar, {
      scholarId: scholar,
    });
    const wholeEntry = perDomain.find((d) => d.domain === whole);
    expect(wholeEntry?.status).toBe("shadow_placed");
    expect(wholeEntry?.mapped).toBe(false);
    expect(wholeEntry?.eligible).toBe(true);
  });

  test("a missing grade reads as the K ring, not the most permissive one", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "map_progress_no_grade"); // no gradeLevel
    const asScholar = await asUser(t, scholar);

    const progress = await asScholar.query(api.practiceSkills.mapProgressForScholar, {
      scholarId: scholar,
    });
    const expectedEligible = await expectedEligibleCount(t, undefined);
    expect(progress.gradeOnFile).toBe(false);
    expect(progress.eligible).toBe(expectedEligible);
    // The K ring is the most restrictive real one — strictly fewer eligible
    // domains than a grade-5 scholar sees (rule 3).
    const grade5Eligible = await expectedEligibleCount(t, "5");
    expect(progress.eligible).toBeLessThanOrEqual(grade5Eligible);
  });
});

describe("mixedPlacementCurrent — the check-in header reads the SAME N-of-M", () => {
  test("mapped/eligible agree exactly with mapProgressForScholar (one derivation, every surface)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "map_progress_cross_surface", "3");
    const asScholar = await asUser(t, scholar);

    const whole = PRACTICE_DOMAINS[0].domain;
    await t.run(async (ctx) => {
      await ctx.db.insert("practicePlacements", {
        scholarId: scholar,
        domain: whole,
        status: "complete",
        probesAnswered: 6,
        updatedAt: Date.now(),
      });
    });

    const progress = await asScholar.query(api.practiceSkills.mapProgressForScholar, {
      scholarId: scholar,
    });
    const current = (await asScholar.query(api.practiceSkills.mixedPlacementCurrent, {
      scholarId: scholar,
    })) as unknown as { mapped: number; eligible: number };

    expect(current.mapped).toBe(progress.mapped);
    expect(current.eligible).toBe(progress.eligible);
  });
});

describe("mapCompletionForScholar / acknowledgeMapCompletion — the once-ever reveal", () => {
  test("fires 'complete' exactly once, then 'growth' only after M genuinely grows", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    // A grade whose K+2-style ring likely reaches exactly the foundational
    // domain(s) so we can drive `allMapped` by converging just those.
    const scholar = await seedScholar(t, "map_completion_lifecycle", "K");
    const asScholar = await asUser(t, scholar);

    const eligibleDomains = (
      await asScholar.query(api.practiceSkills.domainMapForScholar, { scholarId: scholar })
    ).filter((d) => d.eligible);
    expect(eligibleDomains.length).toBeGreaterThan(0);

    // Nothing mapped yet — no reveal.
    const before = await asScholar.query(api.practiceSkills.mapCompletionForScholar, {});
    expect(before.state).toBe("none");

    // Converge every eligible domain directly (bypassing the full adaptive
    // search — this test is about the reveal lifecycle, not the search itself).
    await t.run(async (ctx) => {
      for (const d of eligibleDomains) {
        await ctx.db.insert("practicePlacements", {
          scholarId: scholar,
          domain: d.domain,
          status: "complete",
          probesAnswered: 4,
          updatedAt: Date.now(),
        });
      }
    });

    const complete = await asScholar.query(api.practiceSkills.mapCompletionForScholar, {});
    expect(complete.state).toBe("complete");
    expect(complete.mapped).toBe(complete.eligible);

    // Acknowledge — the reveal must never replay at the same eligible count.
    await asScholar.mutation(api.practiceSkills.acknowledgeMapCompletion, {});
    const afterAck = await asScholar.query(api.practiceSkills.mapCompletionForScholar, {});
    expect(afterAck.state).toBe("none");

    // Simulate a grade unlock: bump the scholar's grade so a previously
    // ineligible domain becomes eligible (M grows). Any domain now eligible
    // but unmapped must be the newly-opened one (every domain eligible at the
    // last full completion is, by construction, already mapped).
    await t.run(async (ctx) => ctx.db.patch(scholar, { gradeLevel: "6" }));
    const grown = await asScholar.query(api.practiceSkills.mapCompletionForScholar, {});
    // Deterministic on the seed graphs: K's ring (K+2) admits only the
    // foundational domains, grade 6's ring (grade 8) admits every registered
    // domain incl. algebra-1 (min node grade 8) — so the unlock MUST grow M and
    // fire growth. Unconditional on purpose (a conditional here let a
    // regression that stopped grade changes from growing gradeEligibleCount
    // pass silently — cross-family review 2026-08-19).
    expect(grown.eligible).toBeGreaterThan(complete.eligible);
    expect(grown.state).toBe("growth");
    expect(grown.newDomainLabels.length).toBeGreaterThan(0);
    // Acknowledging growth resets to none until M grows again.
    await asScholar.mutation(api.practiceSkills.acknowledgeMapCompletion, {});
    const afterGrowthAck = await asScholar.query(api.practiceSkills.mapCompletionForScholar, {});
    expect(afterGrowthAck.state).toBe("none");
  });

  test("acknowledging when there is nothing to reveal is a no-op", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "map_completion_noop", "5");
    const asScholar = await asUser(t, scholar);

    const before = await asScholar.query(api.practiceSkills.mapCompletionForScholar, {});
    expect(before.state).toBe("none");
    await asScholar.mutation(api.practiceSkills.acknowledgeMapCompletion, {});
    const after = await asScholar.query(api.practiceSkills.mapCompletionForScholar, {});
    expect(after.state).toBe("none");
  });

  test("a DELIBERATE above-ring open (raise-the-ceiling) must NEVER fire the growth reveal for itself", async () => {
    // The scholar's own choice to open a reachable above-ring domain (algebra-1)
    // must not be misread as a grade unlock: `mapCompletionForScholar`'s growth
    // watermark is `gradeEligible`-driven, not `eligibleCount`-driven, exactly
    // so a self-opened `in_flight` above-ring domain can never grow it or land
    // in `newDomainLabels` (`scratch-critiques/slip-confirm-interaction-review.md`
    // §2).
    const ALGEBRA1 = "algebra-1";
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "map_completion_selfopen", "4");
    const asScholar = await asUser(t, scholar);

    // Converge every currently grade-eligible domain (this seeds algebra-1's
    // cross-domain prereqs among them, making it `reachable` — but never
    // algebra-1 itself), so the grade-4 ring's own map finishes ("complete").
    const eligibleDomains = (
      await asScholar.query(api.practiceSkills.domainMapForScholar, { scholarId: scholar })
    ).filter((d) => d.eligible);
    expect(eligibleDomains.some((d) => d.domain === ALGEBRA1)).toBe(false);
    await t.run(async (ctx) => {
      const nodes = await ctx.db.query("knowledgeNodes").collect();
      for (const { domain } of eligibleDomains) {
        const own = nodes.filter((n) => n.domain === domain);
        for (const node of own) {
          await ctx.db.insert("practiceMastery", {
            scholarId: scholar,
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
        }
        await ctx.db.insert("practicePlacements", {
          scholarId: scholar,
          domain,
          status: "complete",
          probesAnswered: 1,
          probeLog: [
            { nodeKey: own[0].nodeKey, strand: own[0].strand ?? "", outcome: "correct", at: Date.now() },
          ],
          updatedAt: Date.now(),
        });
      }
    });

    const map = await asScholar.query(api.practiceSkills.domainMapForScholar, { scholarId: scholar });
    const a1Before = map.find((d) => d.domain === ALGEBRA1);
    expect(a1Before?.status).toBe("ineligible"); // reachable, but not yet opened

    // The scholar's own grade-4 map is now fully drawn — one-time "complete".
    const complete = await asScholar.query(api.practiceSkills.mapCompletionForScholar, {});
    expect(complete.state).toBe("complete");
    await asScholar.mutation(api.practiceSkills.acknowledgeMapCompletion, {});
    const acked = await asScholar.query(api.practiceSkills.mapCompletionForScholar, {});
    expect(acked.state).toBe("none");

    // Now deliberately open algebra-1 (a You-Pick / new-territory choiceHint)
    // and answer one probe — it goes `in_flight`, which DOES grow
    // `summary.eligibleCount`, but must NOT trip the growth reveal.
    await asScholar.query(api.practiceSkills.playlistForScholar, {
      scholarId: scholar,
      domain: ALGEBRA1,
      choiceHint: { domain: ALGEBRA1, strand: "linear-equations" },
      includeMapping: true,
    });
    const served = (await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 1,
      domain: ALGEBRA1,
      includeMapping: true,
      choiceHint: { domain: ALGEBRA1, strand: "linear-equations" },
    })) as unknown as { items: { itemId: string; skillKey: string; lane?: string; domain?: string }[] };
    const mappingItem = served.items.find((it) => it.lane === "mapping");
    expect(mappingItem).toBeTruthy();
    await asScholar.mutation(api.practiceSkills.submitMappingAnswer, {
      scholarId: scholar,
      domain: mappingItem!.domain ?? ALGEBRA1,
      itemId: mappingItem!.itemId,
      seed: 1,
      answer: "0",
    });

    const a1After = await asScholar.query(api.practiceSkills.domainMapForScholar, { scholarId: scholar });
    const a1Entry = a1After.find((d) => d.domain === ALGEBRA1);
    expect(a1Entry?.status).toBe("in_flight");
    expect(a1Entry?.eligible).toBe(true);

    const afterOpen = await asScholar.query(api.practiceSkills.mapCompletionForScholar, {});
    expect(afterOpen.state).toBe("none");
    expect(afterOpen.newDomainLabels).not.toContain("Algebra 1");
    expect(afterOpen.newDomainLabels.length).toBe(0);
  });
});
