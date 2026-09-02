import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { gradeTemplateItem, makeItemId } from "../lib/practice/session";
import { FLUENT_REPS, STRUGGLING_MISS_THRESHOLD } from "../lib/practice/scheduler";
import { domainClimb } from "../lib/practice/summits";
import { masteryOf } from "../../shared/treeMapLayout";
import {
  SPIRAL_GAP_MS,
  SPIRAL_MISS_THRESHOLD,
  SPIRAL_SCAN_LIMIT,
} from "../lib/practice/spiralBreaker";
import { strandOrders, gradeRank } from "../lib/practice/placement";
import { hasTemplate } from "../lib/practice/templates";
import { PRACTICE_DOMAINS } from "../lib/practice/domains";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";
import { PLACEMENT_GLOBAL_CAP } from "../../shared/practiceLoop";
import { PRACTICE_ALERT_COMPOSE_DELAY_MS } from "../lib/practice/stuckAlertBody";

const FLUENT_REPS_VALUE = FLUENT_REPS;
const NOW = Date.UTC(2026, 6, 27, 20, 0, 0);

const modules = (import.meta as ImportMeta & { glob: (p: string) => Record<string, () => Promise<unknown>> }).glob("../**/*.ts");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function seedScholar(t: ReturnType<typeof convexTest>, username = "wnascholar") {
  return seedScholarInInstitution(t, {
    institutionId: await seedTestInstitution(t),
    name: "WNA Scholar",
    username,
  });
}

async function asUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 3_600_000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

describe("practiceSkills — graph seed", () => {
  test("seeds the whole-number-arithmetic graph as a valid DAG", async () => {
    const t = convexTest(schema, modules);
    const res = await t.mutation(internal.practiceSkills.seedGraph, {});
    // seedGraph now loads ALL practice graphs: whole-number-arithmetic (87/149)
    // + fraction-arithmetic (31/47) + probability (26/33) + geometry-measurement
    // (60/76) + ratio-proportion-percent (39/68) + integers-coordinates
    // (31/58) + early-algebra (45/78) + algebra-1 (55/79), including their
    // live cross-domain bridges. geometry-measurement went 46/66 → 60/77 when
    // the `measurement-data` strand landed (2026-08-06): 14 length/time/money/
    // capacity nodes and their 10 intra-strand edges. (10, not 11 — the
    // ruler→jar edge was DECLINED on review: the two are analogous, and
    // analogy is not prerequisite.)
    // getDomain (below) is scoped per-domain.
    // 374 → 422 when the elective discrete-math domain landed (48 nodes).
    expect(res.skills).toBe(422);
    // 583 buildsOn edges + 10 INFERENCE-ONLY `implies` edges (probability 3 +
    // geometry 1 + early-algebra 2 + algebra-1 4) — the rebuild absorbs both kinds.
    // 593 → 649 with discrete-math: 56 buildsOn edges (48 in-domain + 8
    // cross-domain from the WNA number-theory strand), 0 implies.
    expect(res.edges).toBe(649);

    const { skills, edges } = await t.query(api.practiceSkills.getDomain, {});
    expect(skills).toHaveLength(87);
    expect(edges).toHaveLength(149);

    // every edge endpoint is a real node…
    const keys = new Set(skills.map((s) => s.skillKey));
    for (const e of edges) {
      expect(keys.has(e.fromKey)).toBe(true);
      expect(keys.has(e.toKey)).toBe(true);
    }
    // …and the graph is acyclic (DFS cycle detection over the seeded edges).
    const adj = new Map<string, string[]>();
    for (const k of keys) adj.set(k, []);
    for (const e of edges) adj.get(e.fromKey)!.push(e.toKey);
    const color = new Map<string, number>();
    const dfs = (u: string): boolean => {
      color.set(u, 1);
      for (const v of adj.get(u) ?? []) {
        const c = color.get(v) ?? 0;
        if (c === 1) return true; // back-edge → cycle
        if (c === 0 && dfs(v)) return true;
      }
      color.set(u, 2);
      return false;
    };
    let hasCycle = false;
    for (const k of keys) if ((color.get(k) ?? 0) === 0 && dfs(k)) hasCycle = true;
    expect(hasCycle).toBe(false);
  });

  test("seeds the fraction-arithmetic graph as a valid DAG (Wave D)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});

    const { skills, edges } = await t.query(api.practiceSkills.getDomain, {
      domain: "fraction-arithmetic",
    });
    expect(skills).toHaveLength(31);
    // 39 in-domain edges + 8 LIVE cross-domain hard prereqs into whole-number
    // arithmetic, stamped to this (to-side) domain: division_as_sharing →
    // unit_fraction / fraction_as_division, plus the six WNA gates on the
    // decimals strand (place value, rounding, the column algorithms,
    // 2-digit×1-digit multiplication, 1-digit-divisor long division).
    expect(edges).toHaveLength(47);

    // every fraction skill sits in one of the five declared strands
    const STRANDS = new Set(["concept", "equivalence", "comparison", "operations", "decimals"]);
    for (const s of skills) expect(STRANDS.has(s.strand ?? "")).toBe(true);

    // every edge endpoint is a real fraction node, EXCEPT the live cross-domain
    // bridges whose from-side is a whole-number-arithmetic node.
    const keys = new Set(skills.map((s) => s.skillKey));
    const FOREIGN_PREREQS = new Set([
      "division_as_sharing",
      "place_value_relationships",
      "round_multidigit",
      "add_multidigit_algorithm",
      "subtract_multidigit_algorithm",
      "mult_2digit_by_1digit",
      "long_division_1digit_divisor",
    ]);
    let bridges = 0;
    for (const e of edges) {
      expect(keys.has(e.toKey)).toBe(true); // to-side is always own-domain
      if (keys.has(e.fromKey)) continue;
      expect(FOREIGN_PREREQS.has(e.fromKey)).toBe(true); // only the known bridges
      expect([
        "unit_fraction",
        "fraction_as_division",
        "decimal_place_value_round",
        "add_subtract_decimals",
        "multiply_decimals",
        "divide_decimals",
      ]).toContain(e.toKey);
      bridges++;
    }
    expect(bridges).toBe(8); // exactly the live cross-domain prereqs

    // …and it's acyclic (DFS back-edge detection over the seeded edges; foreign
    // source nodes added lazily so the cross-domain edges are included).
    const adj = new Map<string, string[]>();
    for (const k of keys) adj.set(k, []);
    for (const e of edges) {
      if (!adj.has(e.fromKey)) adj.set(e.fromKey, []);
      adj.get(e.fromKey)!.push(e.toKey);
    }
    const color = new Map<string, number>();
    const dfs = (u: string): boolean => {
      color.set(u, 1);
      for (const v of adj.get(u) ?? []) {
        const c = color.get(v) ?? 0;
        if (c === 1) return true;
        if (c === 0 && dfs(v)) return true;
      }
      color.set(u, 2);
      return false;
    };
    let hasCycle = false;
    for (const k of adj.keys()) if ((color.get(k) ?? 0) === 0 && dfs(k)) hasCycle = true;
    expect(hasCycle).toBe(false);

    // the two practice graphs are disjoint node sets (no key collision)
    const wna = await t.query(api.practiceSkills.getDomain, {});
    for (const s of wna.skills) expect(keys.has(s.skillKey)).toBe(false);
  });

  test("seeds the probability + statistics graph as a valid DAG", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});

    const { skills, edges } = await t.query(api.practiceSkills.getDomain, {
      domain: "probability",
    });
    expect(skills).toHaveLength(26);
    // 30 in-domain edges + 3 live cross-domain bridges, all stamped to this
    // (to-side) domain.
    expect(edges).toHaveLength(33);

    const STRANDS = new Set([
      "chance",
      "theoretical",
      "experimental",
      "compound",
      "data-displays",
      "center-spread",
    ]);
    for (const s of skills) expect(STRANDS.has(s.strand ?? "")).toBe(true);

    const keys = new Set(skills.map((s) => s.skillKey));
    // The three legal foreign prerequisites. Every OTHER edge endpoint must be
    // an own-domain probability/statistics node.
    const FOREIGN_PREREQS = new Set([
      "fraction_as_parts",
      "fraction_number_line",
      "division_as_sharing",
    ]);
    let bridges = 0;
    for (const e of edges) {
      expect(keys.has(e.toKey)).toBe(true); // to-side is always own-domain
      if (keys.has(e.fromKey)) continue;
      expect(FOREIGN_PREREQS.has(e.fromKey)).toBe(true); // only the known bridge
      expect([
        "probability_as_fraction",
        "read_fractional_line_plot",
        "mean",
      ]).toContain(e.toKey);
      bridges++;
    }
    expect(bridges).toBe(3);

    // Acyclic including the cross-domain edge (foreign source nodes added lazily).
    const adj = new Map<string, string[]>();
    for (const k of keys) adj.set(k, []);
    for (const e of edges) {
      if (!adj.has(e.fromKey)) adj.set(e.fromKey, []);
      adj.get(e.fromKey)!.push(e.toKey);
    }
    const color = new Map<string, number>();
    const dfs = (u: string): boolean => {
      color.set(u, 1);
      for (const v of adj.get(u) ?? []) {
        const c = color.get(v) ?? 0;
        if (c === 1) return true;
        if (c === 0 && dfs(v)) return true;
      }
      color.set(u, 2);
      return false;
    };
    let hasCycle = false;
    for (const k of adj.keys()) if ((color.get(k) ?? 0) === 0 && dfs(k)) hasCycle = true;
    expect(hasCycle).toBe(false);
  });

  test("seedGraph is idempotent (re-run keeps counts stable)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const { skills, edges } = await t.query(api.practiceSkills.getDomain, {});
    expect(skills).toHaveLength(87);
    expect(edges).toHaveLength(149);
  });
});

describe("practiceSkills — probability root serveability (cross-domain ladder)", () => {
  async function insertProbItem(
    t: ReturnType<typeof convexTest>,
    skillKey: string,
    stem: string,
    answer: string,
  ) {
    return await t.run(async (ctx) =>
      ctx.db.insert("practiceItems", {
        skillKey,
        domain: "probability",
        stem,
        answerType: "fraction",
        answerCanonical: answer,
        source: "generated",
        verifiedAt: Date.now(),
      }),
    );
  }

  test("the chance root is served from its deterministic template", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "probscholar_a");
    const asScholar = await asUser(t, scholar);

    const locked = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      size: 8,
      seed: 3,
      domain: "probability",
      choiceHint: { domain: "probability", strand: "chance" },
    });
    expect(locked.items.some((item) => item.skillKey === "likelihood_scale")).toBe(true);
    expect(hasTemplate("likelihood_scale")).toBe(true);
  });

  test("a stored root item keeps the chance strand climbable", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "probscholar_b");
    const asScholar = await asUser(t, scholar);

    await insertProbItem(t, "likelihood_scale", "A bag holds only red marbles. P(red)?", "1");

    const session = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      size: 8,
      seed: 3,
      domain: "probability",
      choiceHint: { domain: "probability", strand: "chance" },
    });
    expect(session.items.length).toBeGreaterThan(0);
    expect(session.items.some((it) => it.skillKey === "likelihood_scale")).toBe(true);
  });
});

describe("practiceSkills — mixed-domain playlists (interleaved cross-domain session)", () => {
  // A standing playlist can blend several practice domains into ONE interleaved
  // session. These pin the engine-level contract of the mixed branch (the pure
  // merge ranking lives in lib/practice/mixedQueue.test.ts): items pull from
  // every blended domain and are tagged, a length-1 blend degrades to that one
  // domain (never the whole-number default), and a blend with nothing serveable
  // yields an empty session (which the UI turns into the summit / caught-up
  // handoff, whose selection logic is unit-tested in shared/practiceSummit).
  async function insertItem(
    t: ReturnType<typeof convexTest>,
    skillKey: string,
    domain: string,
    stem: string,
    answer: string,
  ) {
    return await t.run(async (ctx) =>
      ctx.db.insert("practiceItems", {
        skillKey,
        domain,
        stem,
        answerType: "fraction",
        answerCanonical: answer,
        source: "generated",
        verifiedAt: Date.now(),
      }),
    );
  }

  test("a mixed session interleaves items from EVERY blended domain, each tagged with its domain", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "mixedscholar_a");
    const asScholar = await asUser(t, scholar);

    // Whole-number's root is templated (serves out of the box); probability's is
    // pre-warmed conceptual, so stand in for the seed step with a verified item.
    await insertItem(t, "likelihood_scale", "probability", "A sure thing has probability?", "1");

    const session = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      size: 8,
      seed: 5,
      domains: ["whole-number-arithmetic", "probability"],
    });

    // The blend echoes back: primary = first, full set preserved.
    expect(session.domain).toBe("whole-number-arithmetic");
    expect(session.domains).toEqual(["whole-number-arithmetic", "probability"]);

    expect(session.items.length).toBeGreaterThan(0);
    const served = new Set(session.items.map((it) => it.domain));
    expect(served.has("whole-number-arithmetic")).toBe(true);
    expect(served.has("probability")).toBe(true);
    // Every served item is tagged with one of the blended domains.
    expect(
      session.items.every(
        (it) => it.domain === "whole-number-arithmetic" || it.domain === "probability",
      ),
    ).toBe(true);
  });

  test("a length-1 `domains` array serves THAT domain, never the whole-number default", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "mixedscholar_b");
    const asScholar = await asUser(t, scholar);

    await insertItem(t, "likelihood_scale", "probability", "A sure thing has probability?", "1");

    // No explicit `domain` arg — the single-element blend must resolve to
    // probability (the hardening), not silently drop to whole-number.
    const session = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      size: 8,
      seed: 5,
      domains: ["probability"],
    });

    expect(session.domain).toBe("probability");
    expect(session.items.length).toBeGreaterThan(0);
    expect(session.items.some((it) => it.skillKey === "likelihood_scale")).toBe(true);
    // Nothing whole-number leaked in.
    expect(session.items.every((it) => it.domain !== "whole-number-arithmetic")).toBe(true);
  });

  test("deterministic statistics roots make a fresh probability blend serveable", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "mixedscholar_c");
    const asScholar = await asUser(t, scholar);

    // The older conceptual roots are not pre-warmed here. The statistics
    // extension nevertheless gives probability deterministic, runnable roots.
    const session = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      size: 8,
      seed: 5,
      domains: ["probability", "fraction-arithmetic"],
    });

    expect(session.items.length).toBeGreaterThan(0);
    expect(session.items.some((item) => item.domain === "probability")).toBe(true);
    expect(session.domains).toEqual(["probability", "fraction-arithmetic"]);
  });

  test("the single-domain path is unchanged by the mixed branch (no domains arg)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "mixedscholar_d");
    const asScholar = await asUser(t, scholar);

    const session = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      size: 5,
      seed: 4242,
    });

    // Default single-domain session still serves whole-number and now echoes a
    // one-element `domains` for a uniform client shape.
    expect(session.domain).toBe("whole-number-arithmetic");
    expect(session.domains).toEqual(["whole-number-arithmetic"]);
    expect(session.items.length).toBeGreaterThan(0);
  });
});

describe("practiceSkills — attempts update mastery", () => {
  test("correct attempts advance reps and proficiency band", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);

    let res = await t.mutation(internal.practiceSkills.recordAttemptInternal, {
      scholarId: scholar,
      skillKey: "count_to_10",
      correct: true,
    });
    expect(res.repetition).toBe(1);
    expect(res.proficiency).toBe("practicing");

    for (let i = 0; i < 2; i++) {
      res = await t.mutation(internal.practiceSkills.recordAttemptInternal, {
        scholarId: scholar,
        skillKey: "count_to_10",
        correct: true,
      });
    }
    expect(res.repetition).toBe(3);
    expect(res.proficiency).toBe("fluent");
  });

  test("a miss does not advance the rep count", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    await t.mutation(internal.practiceSkills.recordAttemptInternal, { scholarId: scholar, skillKey: "count_to_10", correct: true });
    const res = await t.mutation(internal.practiceSkills.recordAttemptInternal, { scholarId: scholar, skillKey: "count_to_10", correct: false });
    expect(res.repetition).toBe(1);
  });

  // P1 §1: a PROVISIONAL credit (placement / reprobe / accelerated) must be able
  // to become GREEN once the scholar actually practices it — the write path flips
  // `source` to "practice" on a correct attempt. Without this the entire placed
  // population is stuck provisional forever.
  test("a provisional (placement) credit flips to green on a correct practice attempt", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);

    // Seed an INFERRED credit: placement gave access at FLUENT_REPS, but it's
    // not demonstrated → provisional (accessProven, not isFluent).
    const rowId = await t.run(async (ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: "count_to_10",
        domain: "whole-number-arithmetic",
        repetition: FLUENT_REPS_VALUE,
        halfLifeDays: 4,
        lastPracticedAt: Date.now() - 86_400_000,
        frontier: false,
        source: "placement",
        updatedAt: Date.now() - 86_400_000,
      }),
    );
    let row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.source).toBe("placement"); // provisional at the start

    // Practice it correctly → provenance demotes to demonstrated.
    await t.mutation(internal.practiceSkills.recordAttemptInternal, {
      scholarId: scholar,
      skillKey: "count_to_10",
      correct: true,
    });
    row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.source).toBe("practice"); // now green-eligible
    expect(row!.repetition).toBeGreaterThanOrEqual(FLUENT_REPS_VALUE);
  });

  test("a miss on a provisional credit does NOT claim demonstration (source unchanged)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const rowId = await t.run(async (ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: "count_to_10",
        domain: "whole-number-arithmetic",
        repetition: FLUENT_REPS_VALUE,
        halfLifeDays: 4,
        lastPracticedAt: Date.now() - 86_400_000,
        frontier: false,
        source: "reprobe",
        updatedAt: Date.now() - 86_400_000,
      }),
    );
    await t.mutation(internal.practiceSkills.recordAttemptInternal, {
      scholarId: scholar,
      skillKey: "count_to_10",
      correct: false,
    });
    const row = await t.run(async (ctx) => ctx.db.get(rowId));
    expect(row!.source).toBe("reprobe"); // a wrong answer never flips to "practice"
  });

  // The "struggling" (red) signal: missStreak mirrors accelStreak — it counts
  // consecutive recent misses and resets to 0 on the next correct answer (the
  // "determination of fluency" that supersedes the streak).
  test("missStreak increments on consecutive misses and resets on a correct answer", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const readMiss = () =>
      t.run(async (ctx) =>
        (
          await ctx.db
            .query("practiceMastery")
            .withIndex("by_scholar_skill", (q) =>
              q.eq("scholarId", scholar).eq("skillKey", "count_to_10"),
            )
            .unique()
        )?.missStreak ?? 0,
      );

    await t.mutation(internal.practiceSkills.recordAttemptInternal, {
      scholarId: scholar,
      skillKey: "count_to_10",
      correct: false,
    });
    expect(await readMiss()).toBe(1);

    await t.mutation(internal.practiceSkills.recordAttemptInternal, {
      scholarId: scholar,
      skillKey: "count_to_10",
      correct: false,
    });
    expect(await readMiss()).toBe(STRUGGLING_MISS_THRESHOLD); // 2 → struggling bar

    // A correct answer supersedes the misses.
    await t.mutation(internal.practiceSkills.recordAttemptInternal, {
      scholarId: scholar,
      skillKey: "count_to_10",
      correct: true,
    });
    expect(await readMiss()).toBe(0);
  });

  // The audience gate: struggling is teacher/parent-facing. treeForScholar emits
  // missStreak (so masteryOf → "struggling") for a teacher read, but REDACTS it
  // from the scholar's own map (honors "a portrait, not a report card").
  test("treeForScholar surfaces struggling to a teacher but redacts it from the scholar", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);

    // Two recent misses → missStreak at the struggling bar.
    for (let i = 0; i < STRUGGLING_MISS_THRESHOLD; i++) {
      await t.mutation(internal.practiceSkills.recordAttemptInternal, {
        scholarId: scholar,
        skillKey: "count_to_10",
        correct: false,
      });
    }

    // Scholar's OWN read: missStreak is omitted, so the node can never derive
    // the red "struggling" state.
    const asScholar = await asUser(t, scholar);
    const own = await asScholar.query(api.practiceSkills.treeForScholar, {
      scholarId: scholar,
    });
    const ownNode = own.nodes.find((n) => n.skillKey === "count_to_10")!;
    expect(ownNode.missStreak).toBeUndefined();
    expect(masteryOf(ownNode)).not.toBe("struggling");

    // A teacher read: missStreak present and at the bar → renders "struggling".
    const teacher = await seedStaffWithMembership(t, {
      institutionId: await seedTestInstitution(t),
      name: "T",
      username: "struggle-teacher",
    });
    const asTeacher = await asUser(t, teacher);
    const seen = await asTeacher.query(api.practiceSkills.treeForScholar, {
      scholarId: scholar,
    });
    const seenNode = seen.nodes.find((n) => n.skillKey === "count_to_10")!;
    expect(seenNode.missStreak).toBeGreaterThanOrEqual(STRUGGLING_MISS_THRESHOLD);
    expect(masteryOf(seenNode)).toBe("struggling");
  });

  // Transition stamps (becameFluentAt / frontierAdvancedAt) let a week-over-week
  // rollup report a TRUE "turned fluent / frontier moved this week" instead of a
  // decaying read-time proxy. They must fire exactly on the crossing edge.
  test("practicing a new skill to fluent stamps becameFluentAt + frontierAdvancedAt, once", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const readSkill = () =>
      t.run(async (ctx) =>
        ctx.db
          .query("practiceMastery")
          .withIndex("by_scholar_skill", (q) =>
            q.eq("scholarId", scholar).eq("skillKey", "count_to_10"),
          )
          .first(),
      );

    // Below the demonstrated bar → no crossing yet.
    await t.mutation(internal.practiceSkills.recordAttemptInternal, { scholarId: scholar, skillKey: "count_to_10", correct: true });
    let row = await readSkill();
    expect(row!.becameFluentAt).toBeUndefined();
    expect(row!.frontierAdvancedAt).toBeUndefined();

    // The rep that reaches FLUENT_REPS is the crossing → both stamps land.
    for (let i = 1; i < FLUENT_REPS_VALUE; i++) {
      await t.mutation(internal.practiceSkills.recordAttemptInternal, { scholarId: scholar, skillKey: "count_to_10", correct: true });
    }
    row = await readSkill();
    expect(row!.repetition).toBe(FLUENT_REPS_VALUE);
    expect(typeof row!.becameFluentAt).toBe("number");
    expect(typeof row!.frontierAdvancedAt).toBe("number");

    // Once-only: a further correct rep must not re-stamp (already fluent).
    const stampedAt = row!.becameFluentAt;
    await t.mutation(internal.practiceSkills.recordAttemptInternal, { scholarId: scholar, skillKey: "count_to_10", correct: true });
    row = await readSkill();
    expect(row!.becameFluentAt).toBe(stampedAt);
  });

  test("a practice-earned frontier move stamps one cross-domain reveal", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t, "crossdomainreveal");
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "reveal_p",
        label: "Reveal P",
        domain: "reveal-domain-a",
      });
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "reveal_x",
        label: "Reveal X",
        domain: "reveal-domain-b",
      });
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "reveal_y",
        label: "Reveal Y",
        domain: "reveal-domain-c",
      });
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: "reveal_p",
        toKey: "reveal_x",
        domain: "reveal-domain-b",
        kind: "buildsOn",
      });
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: "reveal_x",
        toKey: "reveal_y",
        domain: "reveal-domain-c",
        kind: "buildsOn",
      });
    });

    for (let i = 0; i < FLUENT_REPS_VALUE; i++) {
      await t.mutation(internal.practiceSkills.recordAttemptInternal, {
        scholarId: scholar,
        skillKey: "reveal_p",
        correct: true,
        domain: "reveal-domain-a",
      });
    }
    let reveals = await t.run(async (ctx) =>
      ctx.db
        .query("nodeReveals")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholar))
        .collect(),
    );
    expect(reveals).toHaveLength(1);
    expect(reveals[0]).toMatchObject({
      nodeKey: "reveal_y",
      source: "practice",
    });

    await t.mutation(internal.practiceSkills.recordAttemptInternal, {
      scholarId: scholar,
      skillKey: "reveal_p",
      correct: true,
      domain: "reveal-domain-a",
    });
    reveals = await t.run(async (ctx) =>
      ctx.db
        .query("nodeReveals")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholar))
        .collect(),
    );
    expect(reveals).toHaveLength(1);
  });

  test("a pinned single-domain scholar read keeps the horizon past a foreign-proven prerequisite", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t, "foreignhorizon");
    await t.run(async (ctx) => {
      // P lives in domain A; X → Y → Z are domain B's chain. A {domain: B}
      // read never loads P's mastery row, so the filter must take P's proven
      // credit from the foreign-aware stateOf or Y wrongly vanishes.
      await ctx.db.insert("knowledgeNodes", { nodeKey: "fh_p", label: "FH P", domain: "fh-domain-a" });
      await ctx.db.insert("knowledgeNodes", { nodeKey: "fh_x", label: "FH X", domain: "fh-domain-b" });
      await ctx.db.insert("knowledgeNodes", { nodeKey: "fh_y", label: "FH Y", domain: "fh-domain-b" });
      await ctx.db.insert("knowledgeNodes", { nodeKey: "fh_z", label: "FH Z", domain: "fh-domain-b" });
      await ctx.db.insert("knowledgeNodeEdges", { fromKey: "fh_p", toKey: "fh_x", domain: "fh-domain-b", kind: "buildsOn" });
      await ctx.db.insert("knowledgeNodeEdges", { fromKey: "fh_x", toKey: "fh_y", domain: "fh-domain-b", kind: "buildsOn" });
      await ctx.db.insert("knowledgeNodeEdges", { fromKey: "fh_y", toKey: "fh_z", domain: "fh-domain-b", kind: "buildsOn" });
      await ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: "fh_p",
        domain: "fh-domain-a",
        repetition: FLUENT_REPS_VALUE,
        halfLifeDays: 1,
        frontier: false,
        source: "practice",
        updatedAt: Date.now(),
        lastPracticedAt: Date.now(),
      });
    });

    const asScholar = await asUser(t, scholar);
    const tree = await asScholar.query(api.practiceSkills.treeForScholar, {
      scholarId: scholar,
      domain: "fh-domain-b",
    });
    const shown = new Set(tree.nodes.map((n) => n.skillKey));
    // X is available (its only prereq is proven, cross-domain) → Y is the
    // one-hop horizon and must render; Z is two hops out and must not.
    expect(shown.has("fh_x")).toBe(true);
    expect(shown.has("fh_y")).toBe(true);
    expect(shown.has("fh_z")).toBe(false);
  });

  test("a placement credit practiced green stamps becameFluentAt but NOT frontierAdvancedAt (access was inferred, not practice-earned)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const readSkill = () =>
      t.run(async (ctx) =>
        ctx.db
          .query("practiceMastery")
          .withIndex("by_scholar_skill", (q) =>
            q.eq("scholarId", scholar).eq("skillKey", "count_to_10"),
          )
          .first(),
      );

    // Inferred credit: already access-proven at placement, so a frontier move
    // was NOT earned through practice — only the demonstrated bar is still open.
    await t.run(async (ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: "count_to_10",
        domain: "whole-number-arithmetic",
        repetition: FLUENT_REPS_VALUE,
        halfLifeDays: 4,
        lastPracticedAt: Date.now() - 86_400_000,
        frontier: false,
        source: "placement",
        updatedAt: Date.now() - 86_400_000,
      }),
    );

    await t.mutation(internal.practiceSkills.recordAttemptInternal, { scholarId: scholar, skillKey: "count_to_10", correct: true });
    const row = await readSkill();
    expect(row!.source).toBe("practice");
    expect(typeof row!.becameFluentAt).toBe("number"); // demonstrated this week
    expect(row!.frontierAdvancedAt).toBeUndefined(); // access predated practice
  });

  test("a miss before the crossing stamps nothing", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    await t.mutation(internal.practiceSkills.recordAttemptInternal, { scholarId: scholar, skillKey: "count_to_10", correct: true });
    await t.mutation(internal.practiceSkills.recordAttemptInternal, { scholarId: scholar, skillKey: "count_to_10", correct: false });
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar_skill", (q) =>
          q.eq("scholarId", scholar).eq("skillKey", "count_to_10"),
        )
        .first(),
    );
    expect(row!.becameFluentAt).toBeUndefined();
    expect(row!.frontierAdvancedAt).toBeUndefined();
  });

  // lastAttemptAt is the REAL drill signal the weekly digest counts practice
  // days + inactivity from — it must be stamped by every recorded attempt
  // (correct OR wrong) and NEVER by placement/reprobe trust-upward, or a
  // just-placed-but-never-drilled scholar would falsely read as "practiced".
  test("a recorded attempt stamps lastAttemptAt (correct and wrong); placement does not", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const readSkill = (skillKey: string) =>
      t.run(async (ctx) =>
        ctx.db
          .query("practiceMastery")
          .withIndex("by_scholar_skill", (q) =>
            q.eq("scholarId", scholar).eq("skillKey", skillKey),
          )
          .first(),
      );

    // A placement-credited row (no attempt) must have NO lastAttemptAt.
    await t.run(async (ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: "count_to_20",
        domain: "whole-number-arithmetic",
        repetition: FLUENT_REPS_VALUE,
        halfLifeDays: 4,
        lastPracticedAt: Date.now() - 86_400_000,
        frontier: false,
        source: "placement",
        updatedAt: Date.now() - 86_400_000,
      }),
    );
    expect((await readSkill("count_to_20"))!.lastAttemptAt).toBeUndefined();

    // A correct attempt stamps it (fresh insert path).
    const before = Date.now();
    await t.mutation(internal.practiceSkills.recordAttemptInternal, { scholarId: scholar, skillKey: "count_to_10", correct: true });
    const correctRow = await readSkill("count_to_10");
    expect(typeof correctRow!.lastAttemptAt).toBe("number");
    expect(correctRow!.lastAttemptAt!).toBeGreaterThanOrEqual(before);

    // A WRONG attempt also stamps it (patch path) — a struggling scholar is
    // still practicing, so their friction must not read as inactivity.
    const missAt = correctRow!.lastAttemptAt!;
    await t.mutation(internal.practiceSkills.recordAttemptInternal, { scholarId: scholar, skillKey: "count_to_10", correct: false });
    const missRow = await readSkill("count_to_10");
    expect(typeof missRow!.lastAttemptAt).toBe("number");
    expect(missRow!.lastAttemptAt!).toBeGreaterThanOrEqual(missAt);
  });

  test("recordAttempt writes exactly one practiceAttempts row with lane and predicted retention", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const before = Date.now();

    await t.mutation(internal.practiceSkills.recordAttemptInternal, {
      scholarId: scholar,
      skillKey: "count_to_10",
      correct: true,
    });

    const attempts = await t.run(async (ctx) => ctx.db.query("practiceAttempts").collect());
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      scholarId: scholar,
      nodeKey: "count_to_10",
      domain: "whole-number-arithmetic",
      strand: "counting",
      lane: "frontier",
      predictedRetention: 1,
      correct: true,
      repetitionBefore: 0,
      source: "practice",
      halfLifeAfter: 1,
    });
    expect(attempts[0].createdAt).toBeGreaterThanOrEqual(before);
  });
});

describe("practiceSkills — frontier gating end to end", () => {
  test("a downstream skill stays locked until its prerequisites are fluent", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    // The single root is the only frontier skill at the start.
    const initial = await asScholar.query(api.practiceSkills.treeForScholar, { scholarId: scholar });
    const frontier0 = initial.nodes.filter((n) => n.frontier).map((n) => n.skillKey);
    expect(frontier0).toEqual(["count_to_10"]);

    // `cardinality_within_10` builds on count_to_10 → not frontier yet.
    const card = initial.nodes.find((n) => n.skillKey === "cardinality_within_10")!;
    expect(card.frontier).toBe(false);
    expect(card.proficiency).toBe("not_started");

    // Make the root fluent (3 correct).
    for (let i = 0; i < 3; i++)
      await t.mutation(internal.practiceSkills.recordAttemptInternal, { scholarId: scholar, skillKey: "count_to_10", correct: true });

    const after = await asScholar.query(api.practiceSkills.treeForScholar, { scholarId: scholar });
    const root = after.nodes.find((n) => n.skillKey === "count_to_10")!;
    expect(root.proficiency).toBe("fluent");
    expect(root.frontier).toBe(false); // past the frontier now
    // its direct dependents are now unlockable
    const cardAfter = after.nodes.find((n) => n.skillKey === "cardinality_within_10")!;
    expect(cardAfter.frontier).toBe(true);
  });

  test("the scholar map shows only the current horizon and preserves reveal latches", async () => {
    const t = convexTest(schema, modules);
    const domain = "thoughtful-reveal-tree";
    await t.run(async (ctx) => {
      for (const nodeKey of ["a", "b", "c"]) {
        await ctx.db.insert("knowledgeNodes", {
          nodeKey,
          label: nodeKey.toUpperCase(),
          domain,
        });
      }
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: "a",
        toKey: "b",
        domain,
        kind: "buildsOn",
      });
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: "b",
        toKey: "c",
        domain,
        kind: "buildsOn",
      });
    });
    const scholar = await seedScholar(t, "revealmap");
    const asScholar = await asUser(t, scholar);

    const initial = await asScholar.query(api.practiceSkills.treeForScholar, {
      scholarId: scholar,
      domain,
    });
    expect(initial.nodes.map((node) => node.skillKey)).toEqual(["a", "b"]);
    expect(initial.edges).toEqual([{ fromKey: "a", toKey: "b" }]);

    await t.run(async (ctx) => {
      await ctx.db.insert("nodeReveals", {
        scholarId: scholar,
        nodeKey: "c",
        revealedAt: Date.now(),
        source: "practice",
      });
    });
    const revealed = await asScholar.query(api.practiceSkills.treeForScholar, {
      scholarId: scholar,
      domain,
    });
    expect(revealed.nodes.map((node) => node.skillKey)).toEqual(["a", "b", "c"]);
    expect(revealed.edges).toEqual([
      { fromKey: "a", toKey: "b" },
      { fromKey: "b", toKey: "c" },
    ]);
  });

  test("the next-practice queue surfaces frontier work, labeled", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const queue = await asScholar.query(api.practiceSkills.nextForScholar, { scholarId: scholar, limit: 3 });
    expect(queue.length).toBeGreaterThan(0);
    expect(queue[0]).toMatchObject({ key: "count_to_10", reason: "new" });
    expect(typeof queue[0].label).toBe("string");
  });
});

describe("practiceSkills — playlistForScholar (scholar-home Playlist card §3)", () => {
  test("a fresh scholar gets a next-up + a queued set, not started", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    const pl = await asScholar.query(api.practiceSkills.playlistForScholar, { scholarId: scholar });
    expect(pl.nextUp).toMatchObject({ key: "count_to_10", reason: "next" });
    expect(typeof pl.nextUp?.label).toBe("string");
    expect(pl.set.length).toBeGreaterThan(0);
    expect(pl.set[0]).toMatchObject({ key: "count_to_10", doneToday: false });
    expect(pl.practicedToday).toBe(false);
    expect(pl.everPracticed).toBe(false);
    expect(pl.skillsPracticedToday).toBe(0);
    // No mastery + no completed placement → still needs the placement check-in
    // (the card labels the CTA a "check-in", not the daily set).
    expect(pl.needsPlacement).toBe(true);
  });

  test("practicing a frontier skill today marks its set row done", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    // One correct (not yet fluent → stays on the frontier) touches the row today.
    await t.mutation(internal.practiceSkills.recordAttemptInternal, {
      scholarId: scholar,
      skillKey: "count_to_10",
      correct: true,
    });

    const pl = await asScholar.query(api.practiceSkills.playlistForScholar, { scholarId: scholar });
    expect(pl.practicedToday).toBe(true);
    expect(pl.skillsPracticedToday).toBe(1);
    const root = pl.set.find((s) => s.key === "count_to_10");
    expect(root?.doneToday).toBe(true);
    // Mastery without a converged placement remains shadow placement: the card
    // must still enter the check-in rather than treating practice as mapping.
    expect(pl.needsPlacement).toBe(true);
  });

  test("placement writes do not count as practice, and days follow the institution calendar", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-07-03T20:00:00Z").getTime();
    vi.setSystemTime(now);

    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const institutionId = await t.run((ctx) =>
      ctx.db.insert("institutions", {
        name: "Moli School",
        slug: "moli",
        kind: "school",
        timeZone: "Pacific/Honolulu",
      }),
    );
    const scholar = await seedScholar(t, "playlist_timezone");
    await t.run(async (ctx) => {
      await ctx.db.patch(scholar, { institutionId });
      await ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: "count_to_10",
        domain: "whole-number-arithmetic",
        repetition: 0,
        halfLifeDays: 1,
        lastPracticedAt: now,
        // 19:00 on July 2 in Honolulu: same UTC date, previous school day.
        lastAttemptAt: new Date("2026-07-03T05:00:00Z").getTime(),
        frontier: true,
        source: "practice",
        // A fresh generic update must not turn into a "practiced today" claim.
        updatedAt: now,
      });
    });
    const asScholar = await asUser(t, scholar);

    const before = await asScholar.query(
      api.practiceSkills.playlistForScholar,
      { scholarId: scholar, dayKey: "2026-07-03" },
    );
    expect(before.practicedToday).toBe(false);
    expect(before.set.find((row) => row.key === "count_to_10")?.doneToday).toBe(
      false,
    );

    await t.run(async (ctx) => {
      const mastery = await ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar_domain", (q) =>
          q.eq("scholarId", scholar).eq("domain", "whole-number-arithmetic"),
        )
        .unique();
      await ctx.db.patch(mastery!._id, { lastAttemptAt: now });
    });
    const after = await asScholar.query(
      api.practiceSkills.playlistForScholar,
      { scholarId: scholar, dayKey: "2026-07-03" },
    );
    expect(after.practicedToday).toBe(true);
    expect(after.set.find((row) => row.key === "count_to_10")?.doneToday).toBe(
      true,
    );
  });

  test("becoming fluent unlocks the next skill → next-up moves off the practiced root", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    // 3 correct → count_to_10 is fluent, leaves the frontier, unlocks dependents.
    for (let i = 0; i < 3; i++) {
      await t.mutation(internal.practiceSkills.recordAttemptInternal, {
        scholarId: scholar,
        skillKey: "count_to_10",
        correct: true,
      });
    }

    const pl = await asScholar.query(api.practiceSkills.playlistForScholar, { scholarId: scholar });
    expect(pl.practicedToday).toBe(true);
    expect(pl.nextUp).not.toBeNull();
    expect(pl.nextUp?.key).not.toBe("count_to_10");
    // The fluent root is off the frontier — no longer in today's set.
    expect(pl.set.some((s) => s.key === "count_to_10")).toBe(false);
  });

  test("a scholar cannot read another scholar's playlist", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const a = await seedScholar(t, "playlist_a");
    const b = await seedScholar(t, "playlist_b");
    const asA = await asUser(t, a);
    await expect(
      asA.query(api.practiceSkills.playlistForScholar, { scholarId: b }),
    ).rejects.toThrow();
  });
});

describe("practiceSkills — practice set + auth", () => {
  test("practiceSet returns deterministic template items for a templated skill", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const items = await asScholar.query(api.practiceSkills.practiceSet, { skillKey: "mult_facts_7_8_9", count: 5, seed: 99 });
    expect(items).toHaveLength(5);
    expect(items[0].source).toBe("template");
    expect(items[0].stem).toMatch(/×/);
  });

  test("a scholar cannot read another scholar's tree", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const a = await seedScholar(t, "scholar_a");
    const b = await seedScholar(t, "scholar_b");
    const asA = await asUser(t, a);
    await expect(asA.query(api.practiceSkills.treeForScholar, { scholarId: b })).rejects.toThrow();
  });
});

describe("practiceSkills — practice session loop", () => {
  test("serves items without answers, and submitAnswer grades + records", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    const session = await asScholar.query(api.practiceSkills.practiceSession, { scholarId: scholar, size: 5, seed: 4242 });
    expect(session.items.length).toBeGreaterThan(0);
    for (const it of session.items) {
      expect(it).toHaveProperty("itemId");
      expect(it).toHaveProperty("stem");
      expect(it).not.toHaveProperty("answer"); // anti-cheat: no answer served
    }

    // A miss NEVER reveals the answer to the client now (anti-offloading, ⑫):
    // correctAnswer is omitted when the submission is wrong.
    const first = session.items[0];
    const res = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: first.itemId,
      answer: "999999", // intentionally wrong → deterministic false
    });
    expect(res.correct).toBe(false);
    expect(res.correctAnswer).toBeUndefined();
    expect(res.skillKey).toBe(first.skillKey);
  });

  test("a correct answer (the revealed truth) advances proficiency", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const session = await asScholar.query(api.practiceSkills.practiceSession, { scholarId: scholar, size: 1, seed: 7 });
    const item = session.items[0];
    // Derive the correct answer server-side (a miss no longer reveals it), then
    // submit it correctly.
    const truth = gradeTemplateItem(item.itemId, "0");
    const right = await asScholar.mutation(api.practiceSkills.submitAnswer, { scholarId: scholar, itemId: item.itemId, answer: truth!.correctAnswer });
    expect(right.correct).toBe(true);
    expect(right.correctAnswer).toBe(truth!.correctAnswer); // echoed back only on correct
    expect(right.repetition).toBeGreaterThanOrEqual(1);
  });

  test("record:false grades without moving mastery (handoff retry)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const session = await asScholar.query(api.practiceSkills.practiceSession, { scholarId: scholar, size: 1, seed: 11 });
    const item = session.items[0];
    // First real attempt (wrong) records and moves the scheduler.
    const first = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: item.itemId,
      answer: "-1",
    });
    const afterFirst = await t.run(async (ctx) =>
      ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar_skill", (q) => q.eq("scholarId", scholar).eq("skillKey", first.skillKey))
        .first(),
    );
    // A grade-only retry: still returns the verdict + correctAnswer, but must NOT
    // touch mastery (no double-penalty on a stuck item).
    const retry = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: item.itemId,
      answer: "-2",
      record: false,
    });
    expect(retry.correct).toBe(false);
    expect(retry.correctAnswer).toBeUndefined(); // a miss never reveals it
    const afterRetry = await t.run(async (ctx) =>
      ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar_skill", (q) => q.eq("scholarId", scholar).eq("skillKey", first.skillKey))
        .first(),
    );
    // The mastery row is byte-for-byte unchanged by the retry.
    expect(afterRetry?.updatedAt).toBe(afterFirst?.updatedAt);
    expect(afterRetry?.repetition).toBe(afterFirst?.repetition);
    const attempts = await t.run(async (ctx) =>
      ctx.db
        .query("practiceAttempts")
        .withIndex("by_scholar_createdAt", (q) => q.eq("scholarId", scholar))
        .order("asc")
        .collect(),
    );
    expect(attempts).toHaveLength(2);
    expect(attempts.find((attempt) => attempt.retry !== true)?.breakerEligible).toBe(
      true,
    );
    expect(attempts.find((attempt) => attempt.retry === true)?.breakerEligible).toBe(
      false,
    );
  });
});

describe("practiceSkills — spiral circuit breaker", () => {
  const NOW = Date.UTC(2026, 6, 27, 20, 0, 0);
  const ITEM_ID = makeItemId("count_to_10", 8675309);

  async function requireBreakerRecovery(
    t: ReturnType<typeof convexTest>,
    result: unknown,
  ) {
    if (
      typeof result !== "object" ||
      result === null ||
      !("breakerRecovery" in result) ||
      typeof result.breakerRecovery !== "object" ||
      result.breakerRecovery === null
    ) {
      throw new Error("Expected the miss to trigger breaker recovery");
    }
    const recovery = result.breakerRecovery;
    if (
      !("version" in recovery) ||
      recovery.version !== 2 ||
      !("triggerAttemptId" in recovery) ||
      typeof recovery.triggerAttemptId !== "string" ||
      !("triggerNodeKey" in recovery) ||
      typeof recovery.triggerNodeKey !== "string" ||
      !("domain" in recovery) ||
      typeof recovery.domain !== "string"
    ) {
      throw new Error("Breaker recovery payload was malformed");
    }
    const rawTriggerAttemptId = recovery.triggerAttemptId;
    const triggerAttemptId = await t.run(async (ctx) =>
      ctx.db.normalizeId("practiceAttempts", rawTriggerAttemptId),
    );
    if (!triggerAttemptId) throw new Error("Breaker trigger attempt ID was invalid");
    return {
      version: recovery.version,
      triggerAttemptId,
      triggerNodeKey: recovery.triggerNodeKey,
      domain: recovery.domain,
    };
  }

  async function seedPriorMisses(
    t: ReturnType<typeof convexTest>,
    scholarId: Id<"users">,
    lane: "review" | "frontier" | "confirmation" | "challenge" = "review",
    count = 2,
  ) {
    await t.run(async (ctx) => {
      for (let i = count; i >= 1; i--) {
        await ctx.db.insert("practiceAttempts", {
          scholarId,
          nodeKey: `prior_${i}`,
          itemId: `prior_${i}`,
          correct: false,
          stemSnapshot: `Prior question ${i}?`,
          answerText: `wrong-${i}`,
          expectedAnswer: `right-${i}`,
          domain: "whole-number-arithmetic",
          lane,
          createdAt: NOW - i,
        });
      }
    });
  }

  async function submitMiss(
    t: ReturnType<typeof convexTest>,
    scholarId: Id<"users">,
    args: {
      answer?: string;
      dontKnow?: boolean;
      record?: boolean;
      replay?: boolean;
      prepareBreakerRepair?: boolean;
      suppressBreaker?: boolean;
      elapsedMs?: number;
    } = {},
  ) {
    const caller = await asUser(t, scholarId);
    return caller.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId: ITEM_ID,
      answer: args.answer ?? "999999",
      ...args,
    });
  }

  async function practiceAlerts(
    t: ReturnType<typeof convexTest>,
    scholarId: Id<"users">,
  ) {
    return await t.run(async (ctx) =>
      (
        await ctx.db.query("alerts").collect()
      ).filter((alert) => alert.scholarId === scholarId),
    );
  }

  async function practiceStuckAlerts(
    t: ReturnType<typeof convexTest>,
    scholarId: Id<"users">,
  ) {
    return (await practiceAlerts(t, scholarId)).filter(
      (alert) => alert.kind === "practice_stuck",
    );
  }

  test("legacy rows without breaker eligibility retain their counted behavior", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_three");
    await seedPriorMisses(t, scholar);
    const legacyAttempts = await t.run(async (ctx) =>
      ctx.db
        .query("practiceAttempts")
        .withIndex("by_scholar_createdAt", (q) => q.eq("scholarId", scholar))
        .collect(),
    );
    expect(legacyAttempts).toHaveLength(2);
    expect(legacyAttempts.every((attempt) => attempt.breakerEligible === undefined)).toBe(
      true,
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        domain: "whole-number-arithmetic",
        frontier: false,
        updatedAt: NOW,
        skillKey: "place_value_to_1000",
        repetition: 4,
        halfLifeDays: 100,
        lastPracticedAt: NOW,
        source: "placement",
      });
    });

    const result = await submitMiss(t, scholar);

    expect(result.backOff).toMatchObject({
      missStreak: 3,
      recoverySkillKey: "place_value_to_1000",
      recoveryDomain: "whole-number-arithmetic",
    });
    expect(result.backOff?.reattached).toBe(false);
    const recovery = await requireBreakerRecovery(t, result);
    expect(recovery.triggerAttemptId).toBe(result.attemptId);
    const trigger = await t.run((ctx) => ctx.db.get(recovery.triggerAttemptId));
    expect(trigger?.breakerEligible).toBe(true);
  });

  test("suppresses the breaker lifecycle and alert for a contained practice mode", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_contained_mode");
    await seedPriorMisses(t, scholar);

    const result = await submitMiss(t, scholar, { suppressBreaker: true });
    expect(result.backOff).toBeUndefined();
    expect(result.breakerRecovery).toBeUndefined();
    const trigger = await t.run((ctx) => ctx.db.get(result.attemptId!));
    expect(trigger?.breakerLifecycle).toBeUndefined();
    await t.finishInProgressScheduledFunctions();
    expect(await practiceAlerts(t, scholar)).toHaveLength(0);
  });

  test("returns repair-unavailable with the threshold-crossing submission when no rung exists", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_prepared_repair");
    await seedPriorMisses(t, scholar);

    const result = await submitMiss(t, scholar, {
      prepareBreakerRepair: true,
    });

    expect(result.breakerRecovery?.initialRepair).toBeDefined();
    expect(result.breakerRecovery?.initialRepair?.rung).toBeNull();
    const trigger = await t.run((ctx) =>
      ctx.db.get(result.breakerRecovery!.triggerAttemptId),
    );
    expect(trigger?.breakerLifecycle?.repairRungKind).toBeUndefined();
    expect(trigger?.breakerLifecycle?.repairUnavailableAt).toBe(NOW);
  });

  test("returns an actionable first repair rung with the triggering submission", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_prepared_step");
    await seedPriorMisses(t, scholar);
    const itemId = await t.run((ctx) =>
      ctx.db.insert("practiceItems", {
        skillKey: "count_to_10",
        domain: "whole-number-arithmetic",
        stem: "What is 5 + 2?",
        answerType: "integer",
        answerCanonical: "7",
        workedSteps: [
          {
            text: "5 + 1 = 6",
            blankText: "5 + 1 = __",
          },
          {
            text: "6 + 1 = 7",
          },
        ],
        source: "generated",
        verifiedAt: NOW,
      }),
    );
    const asScholar = await asUser(t, scholar);

    const result = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: `gen#${itemId}`,
      answer: "9",
      prepareBreakerRepair: true,
    });

    expect(result.breakerRecovery?.initialRepair?.rung).toMatchObject({
      kind: "completion",
      stepIndex: 0,
      prompt: "5 + 1 = ?",
      expected: "6",
    });
    const trigger = await t.run((ctx) =>
      ctx.db.get(result.breakerRecovery!.triggerAttemptId),
    );
    expect(trigger?.breakerLifecycle?.repairRungKind).toBe("completion");
    expect(trigger?.breakerLifecycle?.repairUnavailableAt).toBeUndefined();
  });

  test("replay submissions preserve the answer record without opening a breaker or alert", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_replayed_step");
    await seedPriorMisses(t, scholar);
    const itemId = await t.run((ctx) =>
      ctx.db.insert("practiceItems", {
        skillKey: "count_to_10",
        domain: "whole-number-arithmetic",
        stem: "What is 5 + 2?",
        answerType: "integer",
        answerCanonical: "7",
        workedSteps: [
          {
            text: "5 + 1 = 6",
            blankText: "5 + 1 = __",
          },
          {
            text: "6 + 1 = 7",
          },
        ],
        source: "generated",
        verifiedAt: NOW,
      }),
    );
    const asScholar = await asUser(t, scholar);

    const result = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: `gen#${itemId}`,
      answer: "9",
      prepareBreakerRepair: true,
      replay: true,
    });

    expect(result.backOff).toBeUndefined();
    expect(result.breakerRecovery).toBeUndefined();
    const attempt = await t.run((ctx) => ctx.db.get(result.attemptId!));
    expect(attempt).toMatchObject({
      scholarId: scholar,
      itemId: `gen#${itemId}`,
      correct: false,
      breakerEligible: false,
    });
    expect(attempt?.breakerLifecycle).toBeUndefined();
    const mastery = await t.run((ctx) =>
      ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar_skill", (q) =>
          q.eq("scholarId", scholar).eq("skillKey", "count_to_10"),
        )
        .first(),
    );
    expect(mastery?.repetition).toBe(0);
    const reveals = await t.run((ctx) =>
      ctx.db
        .query("practiceHintReveals")
        .filter((q) => q.eq(q.field("scholarId"), scholar))
        .collect(),
    );
    expect(reveals).toHaveLength(0);
    await t.finishInProgressScheduledFunctions();
    expect(await practiceAlerts(t, scholar)).toEqual([]);
  });

  for (const mode of [
    {
      label: "replay",
      username: "spiral_replay_future",
      args: { replay: true },
    },
    {
      label: "Quick Facts suppression",
      username: "spiral_quick_facts_future",
      args: { suppressBreaker: true },
    },
  ] as const) {
    test(`three ${mode.label} misses followed by one live miss stay below the breaker threshold`, async () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const t = convexTest(schema, modules);
      await t.mutation(internal.practiceSkills.seedGraph, {});
      const scholar = await seedScholar(t, mode.username);

      const excludedIds: Id<"practiceAttempts">[] = [];
      for (let i = 0; i < SPIRAL_MISS_THRESHOLD; i++) {
        const excluded = await submitMiss(t, scholar, mode.args);
        expect(excluded.backOff).toBeUndefined();
        expect(excluded.breakerRecovery).toBeUndefined();
        excludedIds.push(excluded.attemptId!);
        await vi.advanceTimersByTimeAsync(1);
      }
      const live = await submitMiss(t, scholar);

      expect(live.backOff).toBeUndefined();
      expect(live.breakerRecovery).toBeUndefined();
      const attempts = await t.run(async (ctx) =>
        Promise.all(
          [...excludedIds, live.attemptId!].map((attemptId) =>
            ctx.db.get(attemptId),
          ),
        ),
      );
      expect(
        attempts
          .slice(0, SPIRAL_MISS_THRESHOLD)
          .every(
            (attempt) =>
              attempt?.breakerEligible === false &&
              attempt.breakerLifecycle === undefined &&
              attempt.breaker === undefined,
          ),
      ).toBe(true);
      expect(attempts.at(-1)?.breakerEligible).toBe(true);
      await expect(
        (await asUser(t, scholar)).query(
          api.practiceSkills.activeBreakerEpisode,
          { scholarId: scholar },
        ),
      ).resolves.toBeNull();
      await vi.advanceTimersByTimeAsync(PRACTICE_ALERT_COMPOSE_DELAY_MS);
      await t.finishInProgressScheduledFunctions();
      expect(await practiceAlerts(t, scholar)).toEqual([]);
    });
  }

  test("mixed exclusions select the third eligible miss and reattach later misses to it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_mixed_eligibility");

    const first = await submitMiss(t, scholar);
    await vi.advanceTimersByTimeAsync(1);
    const suppressed = await submitMiss(t, scholar, { suppressBreaker: true });
    await vi.advanceTimersByTimeAsync(1);
    const second = await submitMiss(t, scholar);
    await vi.advanceTimersByTimeAsync(1);
    const replayed = await submitMiss(t, scholar, { replay: true });
    await vi.advanceTimersByTimeAsync(1);
    const third = await submitMiss(t, scholar);

    expect(first.backOff).toBeUndefined();
    expect(second.backOff).toBeUndefined();
    expect(suppressed.backOff).toBeUndefined();
    expect(replayed.backOff).toBeUndefined();
    expect(third.backOff).toMatchObject({
      missStreak: SPIRAL_MISS_THRESHOLD,
      reattached: false,
    });
    const recovery = await requireBreakerRecovery(t, third);
    expect(recovery.triggerAttemptId).toBe(third.attemptId);
    const excludedBefore = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.get(suppressed.attemptId!),
        ctx.db.get(replayed.attemptId!),
      ]),
    );
    expect(
      excludedBefore.every(
        (attempt) =>
          attempt?.breakerEligible === false &&
          attempt.breakerLifecycle === undefined &&
          attempt.breaker === undefined,
      ),
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    const excludedAfter = await submitMiss(t, scholar, {
      suppressBreaker: true,
    });
    await vi.advanceTimersByTimeAsync(1);
    const fourth = await submitMiss(t, scholar);
    expect(fourth.backOff).toMatchObject({
      missStreak: SPIRAL_MISS_THRESHOLD + 1,
      reattached: true,
    });
    expect((await requireBreakerRecovery(t, fourth)).triggerAttemptId).toBe(
      recovery.triggerAttemptId,
    );
    expect(
      (await t.run((ctx) => ctx.db.get(excludedAfter.attemptId!)))
        ?.breakerLifecycle,
    ).toBeUndefined();
    await expect(
      (await asUser(t, scholar)).query(
        api.practiceSkills.activeBreakerEpisode,
        { scholarId: scholar },
      ),
    ).resolves.toMatchObject({
      triggerAttemptId: recovery.triggerAttemptId,
      triggerNodeKey: third.skillKey,
    });

    await vi.advanceTimersByTimeAsync(PRACTICE_ALERT_COMPOSE_DELAY_MS);
    await t.finishInProgressScheduledFunctions();
    const alerts = await practiceStuckAlerts(t, scholar);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].practiceTriggerAttemptId).toBe(recovery.triggerAttemptId);
  });

  test("a correct suppressed answer resets prior live misses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_suppressed_correct_reset");

    await submitMiss(t, scholar);
    await vi.advanceTimersByTimeAsync(1);
    await submitMiss(t, scholar);
    await vi.advanceTimersByTimeAsync(1);
    const truth = gradeTemplateItem(ITEM_ID, "0")!.correctAnswer;
    const asScholar = await asUser(t, scholar);
    const suppressedCorrect = await asScholar.mutation(
      api.practiceSkills.submitAnswer,
      {
        scholarId: scholar,
        itemId: ITEM_ID,
        answer: truth,
        suppressBreaker: true,
      },
    );
    expect(suppressedCorrect.correct).toBe(true);
    const suppressedAttempt = await t.run((ctx) =>
      ctx.db.get(suppressedCorrect.attemptId!),
    );
    expect(suppressedAttempt).toMatchObject({
      correct: true,
      breakerEligible: false,
    });
    expect(["review", "frontier", "confirmation"]).toContain(
      suppressedAttempt?.lane,
    );

    await vi.advanceTimersByTimeAsync(1);
    const laterMiss = await submitMiss(t, scholar);
    expect(laterMiss.backOff).toBeUndefined();
    expect(laterMiss.breakerRecovery).toBeUndefined();
    await expect(
      asScholar.query(api.practiceSkills.activeBreakerEpisode, {
        scholarId: scholar,
      }),
    ).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(PRACTICE_ALERT_COMPOSE_DELAY_MS);
    await t.finishInProgressScheduledFunctions();
    expect(await practiceAlerts(t, scholar)).toEqual([]);
  });

  test("three ordinary misses trigger exactly once on the third new attempt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_ordinary_eligibility");

    const first = await submitMiss(t, scholar);
    await vi.advanceTimersByTimeAsync(1);
    const second = await submitMiss(t, scholar);
    await vi.advanceTimersByTimeAsync(1);
    const third = await submitMiss(t, scholar);
    expect(first.backOff).toBeUndefined();
    expect(second.backOff).toBeUndefined();
    expect(third.backOff).toMatchObject({
      missStreak: SPIRAL_MISS_THRESHOLD,
      reattached: false,
    });
    const recovery = await requireBreakerRecovery(t, third);
    expect(recovery.triggerAttemptId).toBe(third.attemptId);
    const attempts = await t.run(async (ctx) =>
      ctx.db
        .query("practiceAttempts")
        .withIndex("by_scholar_createdAt", (q) => q.eq("scholarId", scholar))
        .order("asc")
        .collect(),
    );
    expect(attempts.map((attempt) => attempt.breakerEligible)).toEqual([
      true,
      true,
      true,
    ]);
    expect(attempts[0].breakerLifecycle).toBeUndefined();
    expect(attempts[1].breakerLifecycle).toBeUndefined();
    expect(attempts[2].breakerLifecycle?.triggerNodeKey).toBe(third.skillKey);

    await vi.advanceTimersByTimeAsync(PRACTICE_ALERT_COMPOSE_DELAY_MS);
    await t.finishInProgressScheduledFunctions();
    const alerts = await practiceStuckAlerts(t, scholar);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].practiceTriggerAttemptId).toBe(recovery.triggerAttemptId);
  });

  test("serves an explicitly requested cross-domain practice item", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_cross_domain");
    await seedPriorMisses(t, scholar);
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        domain: "fraction-arithmetic",
        frontier: false,
        updatedAt: NOW,
        skillKey: "add_subtract_like",
        repetition: 4,
        halfLifeDays: 100,
        lastPracticedAt: NOW,
        source: "placement",
      });
    });

    const result = await submitMiss(t, scholar);
    expect(result.backOff).toMatchObject({
      missStreak: 3,
      recoverySkillKey: "add_subtract_like",
      recoveryDomain: "fraction-arithmetic",
    });

    const scholarCaller = await asUser(t, scholar);
    // The threaded domain actually serves the recovery item…
    const served = await scholarCaller.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      size: 1,
      seed: 12345,
      skillKeys: ["add_subtract_like"],
      domain: "fraction-arithmetic",
    });
    expect(served.items.length).toBe(1);
    expect(served.items[0]?.skillKey).toBe("add_subtract_like");

    // …whereas the pre-fix client call (no domain) scopes to the whole-number
    // default, drops the fraction skill, and serves nothing — the bounce.
    const unscoped = await scholarCaller.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      size: 1,
      seed: 12345,
      skillKeys: ["add_subtract_like"],
    });
    expect(unscoped.items.length).toBe(0);
  });

  test("recovers a STORED-ONLY skill (templateless word problem) — servability, not just a template", async () => {
    // The reviewer's second regression. Servability must mean "can produce an
    // item", NOT "has a template". `add_subtract_word_problems_within_10` is a
    // real whole-number node with NO template — it serves only from STORED items.
    // Here it's the scholar's best access-proven credit, so it must be the
    // recovery pick. A `hasTemplate` gate would wrongly exclude it and fall back
    // to the just-missed `count_to_10` (rep 0, templated) — the "one more" would
    // be the very skill they just spiraled on. `runnableSkillKeySet` (template OR
    // a non-stretch stored item) keeps the stored-only skill in the pool.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_stored_only");
    await seedPriorMisses(t, scholar);
    await t.run(async (ctx) => {
      // A non-stretch stored item makes the templateless skill servable.
      await ctx.db.insert("practiceItems", {
        skillKey: "add_subtract_word_problems_within_10",
        domain: "whole-number-arithmetic",
        stem: "Ana had 5 apples and gave away 2. How many are left?",
        answerType: "integer",
        answerCanonical: "3",
        source: "generated",
        verifiedAt: NOW,
      });
      await ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        domain: "whole-number-arithmetic",
        frontier: false,
        updatedAt: NOW,
        skillKey: "add_subtract_word_problems_within_10",
        repetition: 4,
        halfLifeDays: 100,
        lastPracticedAt: NOW,
        source: "placement",
      });
    });

    const result = await submitMiss(t, scholar);
    expect(result.backOff).toMatchObject({
      missStreak: 3,
      recoverySkillKey: "add_subtract_word_problems_within_10",
      recoveryDomain: "whole-number-arithmetic",
    });

    // And the stored-only recovery actually serves an item.
    const scholarCaller = await asUser(t, scholar);
    const served = await scholarCaller.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      size: 1,
      seed: 12345,
      skillKeys: ["add_subtract_word_problems_within_10"],
      domain: "whole-number-arithmetic",
    });
    expect(served.items.length).toBe(1);
    expect(served.items[0]?.skillKey).toBe("add_subtract_word_problems_within_10");
  });

  test("grade-only retries never return backOff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_grade_only");
    await seedPriorMisses(t, scholar, "review", 3);

    const result = await submitMiss(t, scholar, { record: false });

    expect(result).not.toHaveProperty("backOff");
  });

  test("teacher rehearsal never returns backOff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_rehearsal");
    const teacher = await seedStaffWithMembership(t, {
      institutionId: await seedTestInstitution(t),
      name: "Lehua Torres",
      username: "spiral_teacher",
    });
    await seedPriorMisses(t, scholar);
    const asTeacher = await asUser(t, teacher);

    const result = await asTeacher.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: ITEM_ID,
      answer: "999999",
    });

    expect(result).not.toHaveProperty("backOff");
  });

  test("excluded-lane attempts do not return backOff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_stretch");
    await seedPriorMisses(t, scholar);
    const stretchId = await t.run(async (ctx) =>
      ctx.db.insert("practiceItems", {
        skillKey: "count_to_10",
        domain: "whole-number-arithmetic",
        stem: "How many dots are there?",
        answerType: "integer",
        answerCanonical: "4",
        source: "generated",
        verifiedAt: NOW,
        tier: "stretch",
      }),
    );
    const asScholar = await asUser(t, scholar);

    const result = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: `gen#${stretchId}`,
      answer: "5",
    });

    expect(result).not.toHaveProperty("backOff");
  });

  test("recovery selection requires context-aware fluency and is deterministic", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_recovery");
    await seedPriorMisses(t, scholar);
    await t.run(async (ctx) => {
      const base = {
        scholarId: scholar,
        domain: "whole-number-arithmetic",
        frontier: false,
        updatedAt: NOW,
      };
      await ctx.db.insert("practiceMastery", {
        ...base,
        skillKey: "add_within_10",
        repetition: 1,
        halfLifeDays: 100,
        lastPracticedAt: NOW,
        source: "practice",
      });
      await ctx.db.insert("practiceMastery", {
        ...base,
        skillKey: "add_2digit_regroup",
        repetition: 9,
        halfLifeDays: 1,
        lastPracticedAt: NOW - 30 * 86_400_000,
        source: "practice",
      });
      await ctx.db.insert("practiceMastery", {
        ...base,
        skillKey: "compare_3digit",
        repetition: 5,
        halfLifeDays: 100,
        lastPracticedAt: NOW,
        source: "practice",
      });
      await ctx.db.insert("practiceMastery", {
        ...base,
        skillKey: "add_within_5",
        repetition: 5,
        halfLifeDays: 100,
        lastPracticedAt: NOW,
        source: "practice",
      });
    });

    const result = await submitMiss(t, scholar);

    expect(result.backOff).toMatchObject({
      missStreak: 3,
      recoverySkillKey: "add_within_5",
      recoveryDomain: "whole-number-arithmetic",
    });
  });

  test("recordBreakerOutcome records choice immediately and fills recovery monotonically", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_outcome");
    await seedPriorMisses(t, scholar);
    const asScholar = await asUser(t, scholar);
    const result = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: ITEM_ID,
      answer: "999999",
    });
    expect(result.backOff?.missStreak).toBe(3);

    await asScholar.mutation(api.practiceSkills.recordBreakerOutcome, {
      scholarId: scholar,
      itemId: ITEM_ID,
      streak: 3,
      offer: "accepted",
    });

    const choiceOnly = await t.run(async (ctx) =>
      ctx.db
        .query("practiceAttempts")
        .withIndex("by_scholar_item_createdAt", (q) =>
          q.eq("scholarId", scholar).eq("itemId", ITEM_ID),
        )
        .order("desc")
        .first(),
    );
    expect(choiceOnly?.breaker).toEqual({
      streak: 3,
      offer: "accepted",
      recovery: "none",
    });

    await asScholar.mutation(api.practiceSkills.recordBreakerOutcome, {
      scholarId: scholar,
      itemId: ITEM_ID,
      streak: 3,
      offer: "accepted",
      recovery: "won",
    });
    await asScholar.mutation(api.practiceSkills.recordBreakerOutcome, {
      scholarId: scholar,
      itemId: ITEM_ID,
      streak: 3,
      offer: "declined",
    });

    const completed = await t.run(async (ctx) =>
      ctx.db
        .query("practiceAttempts")
        .withIndex("by_scholar_item_createdAt", (q) =>
          q.eq("scholarId", scholar).eq("itemId", ITEM_ID),
        )
        .order("desc")
        .first(),
    );
    expect(completed?.breaker).toEqual({
      streak: 3,
      offer: "accepted",
      recovery: "won",
    });
  });

  test("records the versioned repair lifecycle monotonically and links one fresh same-node result", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_repair");
    await seedPriorMisses(t, scholar);
    const asScholar = await asUser(t, scholar);
    const triggerResult = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: ITEM_ID,
      answer: "999999",
    });

    const breakerRecovery = await requireBreakerRecovery(t, triggerResult);
    const triggerAttemptId = breakerRecovery.triggerAttemptId;
    expect(breakerRecovery).toMatchObject({
      version: 2,
      triggerNodeKey: "count_to_10",
      domain: "whole-number-arithmetic",
    });

    await asScholar.mutation(api.practiceSkills.recordBreakerRecoveryLifecycle, {
      scholarId: scholar,
      triggerAttemptId: triggerAttemptId!,
      event: "repair_shown",
    });
    await asScholar.mutation(api.practiceSkills.recordBreakerRecoveryLifecycle, {
      scholarId: scholar,
      triggerAttemptId: triggerAttemptId!,
      event: "repair_started",
    });
    await asScholar.mutation(api.practiceSkills.recordBreakerRecoveryLifecycle, {
      scholarId: scholar,
      triggerAttemptId: triggerAttemptId!,
      event: "repair_completed",
    });
    await expect(
      asScholar.query(api.practiceSkills.activeBreakerEpisode, {
        scholarId: scholar,
      }),
    ).resolves.toMatchObject({
      triggerAttemptId,
      confirmedLifecycle: [
        "repairShown",
        "repairStarted",
        "repairCompleted",
      ],
    });
    const recovery = await asScholar.mutation(api.practiceSkills.breakerRecoverySession, {
      scholarId: scholar,
      triggerAttemptId: triggerAttemptId!,
      seed: 8675311,
    });
    expect(recovery.items).toHaveLength(1);
    expect(recovery.items[0].skillKey).toBe("count_to_10");
    expect(recovery.items[0].itemId).not.toBe(ITEM_ID);
    expect(recovery.items[0].answerType).not.toBe("manipulative");
    expect(recovery.items[0].answerType).not.toBe("dialogue");
    expect(recovery.items[0].workedSteps).toBeUndefined();
    expect(recovery.items[0].scaffoldLevel).toBeUndefined();
    expect(
      (await t.run((ctx) => ctx.db.get(triggerAttemptId!)))?.breakerLifecycle
        ?.freshItemId,
    ).toBe(recovery.items[0].itemId);
    await vi.advanceTimersByTimeAsync(1);
    // A replay cannot erase a completed repair or replace it with an easy exit.
    await asScholar.mutation(api.practiceSkills.recordBreakerRecoveryLifecycle, {
      scholarId: scholar,
      triggerAttemptId: triggerAttemptId!,
      event: "repair_completed",
    });

    const assistedItemId = makeItemId("count_to_10", 8675310);
    await t.run(async (ctx) =>
      ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: "count_to_10",
        itemId: assistedItemId,
        correct: true,
        retry: true,
        scaffolded: true,
        domain: "whole-number-arithmetic",
        lane: "frontier",
        createdAt: NOW + 1,
      }),
    );
    const rejectedAssisted = await asScholar.mutation(
      api.practiceSkills.recordBreakerRecoveryLifecycle,
      {
        scholarId: scholar,
        triggerAttemptId: triggerAttemptId!,
        event: "fresh_result",
        freshItemId: assistedItemId,
      },
    );
    expect(rejectedAssisted.recorded).toBe(false);
    await expect(
      asScholar.mutation(api.practiceSkills.submitAnswer, {
        scholarId: scholar,
        itemId: assistedItemId,
        answer: "10",
        breakerTriggerAttemptId: triggerAttemptId!,
      }),
    ).rejects.toThrow("Breaker recovery context is invalid");

    const freshItemId = recovery.items[0].itemId;
    const truth = gradeTemplateItem(freshItemId, "0")!.correctAnswer;
    const freshResult = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: freshItemId,
      answer: truth,
      breakerTriggerAttemptId: triggerAttemptId!,
    });
    expect(freshResult.breakerRecoveryVerified).toBe(true);
    expect(
      (await t.run((ctx) => ctx.db.get(triggerAttemptId!)))?.breakerLifecycle
        ?.freshResult,
    ).toMatchObject({ itemId: freshItemId, correct: true, assisted: false });
    // A later incompatible outcome cannot replace the pinned repair result.
    await asScholar.mutation(api.practiceSkills.recordBreakerRecoveryLifecycle, {
      scholarId: scholar,
      triggerAttemptId: triggerAttemptId!,
      event: "easy_exit",
    });

    const trigger = await t.run((ctx) => ctx.db.get(triggerAttemptId!));
    const freshAttemptId = trigger?.breakerLifecycle?.freshResult?.attemptId;
    const freshAttempt = freshAttemptId
      ? await t.run((ctx) => ctx.db.get(freshAttemptId))
      : undefined;
    expect(freshAttempt?.scaffolded).not.toBe(true);
    expect(trigger?.breaker).toBeUndefined(); // v1 rows were not reinterpreted.
    expect(trigger?.breakerLifecycle).toMatchObject({
      version: 2,
      triggerNodeKey: "count_to_10",
      repairShownAt: NOW,
      repairCompletedAt: NOW,
      freshResult: {
        attemptId: freshAttemptId,
        itemId: freshItemId,
        correct: true,
      },
    });
    expect(trigger?.breakerLifecycle?.easyExitedAt).toBeUndefined();

    const arbitraryAttemptId = await t.run((ctx) =>
      ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: "count_to_10",
        itemId: makeItemId("count_to_10", 8675312),
        correct: false,
        domain: "whole-number-arithmetic",
        lane: "frontier",
        createdAt: NOW + 3,
      }),
    );
    await expect(
      asScholar.mutation(api.practiceSkills.recordBreakerRecoveryLifecycle, {
        scholarId: scholar,
        triggerAttemptId: arbitraryAttemptId,
        event: "repair_started",
      }),
    ).resolves.toEqual({ recorded: false });
  });

  test("breakerRecoverySession is idempotent across a retry with a different client seed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_recovery_retry");
    await seedPriorMisses(t, scholar);
    const asScholar = await asUser(t, scholar);
    const trip = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: ITEM_ID,
      answer: "999999",
    });
    const triggerAttemptId = (await requireBreakerRecovery(t, trip)).triggerAttemptId;
    for (const event of ["repair_started", "repair_completed"] as const) {
      await asScholar.mutation(api.practiceSkills.recordBreakerRecoveryLifecycle, {
        scholarId: scholar,
        triggerAttemptId,
        event,
      });
    }

    // First issue.
    const first = await asScholar.mutation(api.practiceSkills.breakerRecoverySession, {
      scholarId: scholar,
      triggerAttemptId,
      seed: 111,
    });
    expect(first.items).toHaveLength(1);
    const issuedItemId = first.items[0].itemId;

    // Simulate the client never seeing that response (dropped reply, reload,
    // or an explicit retry) and calling again with a FRESH random seed — the
    // normal client behavior on a lost mutation response. This must return
    // the EXACT same item rather than throw, and rather than silently drawing
    // a different one.
    const retryDifferentSeed = await asScholar.mutation(
      api.practiceSkills.breakerRecoverySession,
      { scholarId: scholar, triggerAttemptId, seed: 222 },
    );
    expect(retryDifferentSeed.items).toHaveLength(1);
    expect(retryDifferentSeed.items[0].itemId).toBe(issuedItemId);
    expect(retryDifferentSeed.items[0]).toEqual(first.items[0]);

    // A THIRD call, yet another seed, stays pinned too — stability isn't a
    // one-shot fluke of a particular retry.
    const retryAgain = await asScholar.mutation(api.practiceSkills.breakerRecoverySession, {
      scholarId: scholar,
      triggerAttemptId,
      seed: 333,
    });
    expect(retryAgain.items[0].itemId).toBe(issuedItemId);

    // The stored lifecycle only ever recorded the one fresh item.
    const trigger = await t.run((ctx) => ctx.db.get(triggerAttemptId));
    expect(trigger?.breakerEligible).toBe(true);
    expect(trigger?.breakerLifecycle?.freshItemId).toBe(issuedItemId);

    // The pinned item still received the same scaffold stripping as first
    // issue (never manipulative/dialogue, never worked steps).
    expect(retryDifferentSeed.items[0].workedSteps).toBeUndefined();
    expect(retryDifferentSeed.items[0].scaffoldLevel).toBeUndefined();
    expect(retryDifferentSeed.items[0].answerType).not.toBe("manipulative");
    expect(retryDifferentSeed.items[0].answerType).not.toBe("dialogue");

    // A subsequent authoritative submission against the pinned item still
    // closes the lifecycle normally — the retries left no lingering damage.
    await vi.advanceTimersByTimeAsync(1);
    const truth = gradeTemplateItem(issuedItemId, "0")!.correctAnswer;
    const freshResult = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: issuedItemId,
      answer: truth,
      breakerTriggerAttemptId: triggerAttemptId,
    });
    expect(freshResult.breakerRecoveryVerified).toBe(true);
    const closed = await t.run((ctx) => ctx.db.get(triggerAttemptId));
    expect(closed?.breakerLifecycle?.freshResult).toMatchObject({
      itemId: issuedItemId,
      correct: true,
    });

    // A call after closure is refused, same as the non-retried path.
    await expect(
      asScholar.mutation(api.practiceSkills.breakerRecoverySession, {
        scholarId: scholar,
        triggerAttemptId,
        seed: 444,
      }),
    ).rejects.toThrow("Recovery session is not available");
  });

  test("breakerRecoverySession reconstructs a pre-existing freshItemId with no other lifecycle metadata (pre-fix compatibility)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_recovery_legacy_row");
    await seedPriorMisses(t, scholar);
    const asScholar = await asUser(t, scholar);
    const trip = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: ITEM_ID,
      answer: "999999",
    });
    const triggerAttemptId = (await requireBreakerRecovery(t, trip)).triggerAttemptId;
    for (const event of ["repair_started", "repair_completed"] as const) {
      await asScholar.mutation(api.practiceSkills.recordBreakerRecoveryLifecycle, {
        scholarId: scholar,
        triggerAttemptId,
        event,
      });
    }
    const first = await asScholar.mutation(api.practiceSkills.breakerRecoverySession, {
      scholarId: scholar,
      triggerAttemptId,
      seed: 555,
    });
    const issuedItemId = first.items[0].itemId;

    // Retain only the fields required to keep recovery available plus the
    // pre-existing issued id; every optional lifecycle detail is absent.
    const beforeFix = await t.run((ctx) => ctx.db.get(triggerAttemptId));
    const lifecycle = beforeFix!.breakerLifecycle!;
    const legacyLifecycle = {
      version: 2 as const,
      triggerNodeKey: lifecycle.triggerNodeKey,
      triggeredAt: lifecycle.triggeredAt,
      repairCompletedAt: lifecycle.repairCompletedAt!,
      freshItemId: issuedItemId,
    };
    await t.run((ctx) =>
      ctx.db.patch(triggerAttemptId, { breakerLifecycle: legacyLifecycle }),
    );
    expect(await t.run((ctx) => ctx.db.get(triggerAttemptId))).toMatchObject({
      breakerLifecycle: legacyLifecycle,
    });

    const replay = await asScholar.mutation(api.practiceSkills.breakerRecoverySession, {
      scholarId: scholar,
      triggerAttemptId,
      seed: 666,
    });
    expect(replay.items[0].itemId).toBe(issuedItemId);
    expect(replay.items[0]).toEqual(first.items[0]);
  });

  test("allows easy exit after coach and rejects terminal recovery serving", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_coach_exit");
    await seedPriorMisses(t, scholar);
    const asScholar = await asUser(t, scholar);
    const trip = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: ITEM_ID,
      answer: "999999",
    });
    const triggerAttemptId = (await requireBreakerRecovery(t, trip)).triggerAttemptId;
    for (const event of ["repair_started", "coach_escalated", "easy_exit"] as const) {
      await asScholar.mutation(api.practiceSkills.recordBreakerRecoveryLifecycle, {
        scholarId: scholar,
        triggerAttemptId,
        event,
      });
    }
    await expect(
      asScholar.mutation(api.practiceSkills.breakerRecoverySession, {
        scholarId: scholar,
        triggerAttemptId,
        seed: 42,
      }),
    ).rejects.toThrow("Recovery session is not available");
  });

  test("atomically records an easy exit after a missed fresh attempt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_fresh_miss_exit");
    await seedPriorMisses(t, scholar);
    const asScholar = await asUser(t, scholar);
    const trip = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: ITEM_ID,
      answer: "999999",
    });
    const triggerAttemptId = (await requireBreakerRecovery(t, trip)).triggerAttemptId;
    for (const event of ["repair_started", "repair_completed"] as const) {
      await asScholar.mutation(api.practiceSkills.recordBreakerRecoveryLifecycle, {
        scholarId: scholar,
        triggerAttemptId,
        event,
      });
    }
    const recovery = await asScholar.mutation(
      api.practiceSkills.breakerRecoverySession,
      {
        scholarId: scholar,
        triggerAttemptId,
        seed: 8675313,
      },
    );
    const freshItemId = recovery.items[0].itemId;
    await vi.advanceTimersByTimeAsync(1);
    const freshGrade = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: freshItemId,
      answer: "999999",
      breakerTriggerAttemptId: triggerAttemptId,
    });
    expect(freshGrade.correct).toBe(false);
    const easy = await asScholar.mutation(api.practiceSkills.breakerEasyFinishSession, {
      scholarId: scholar,
      triggerAttemptId,
      seed: 8675314,
    });
    expect(easy.available).toBe(true);
    const easyItemId = easy.items[0]!.itemId;
    const easyTruth = gradeTemplateItem(easyItemId, "0")!.correctAnswer;
    await expect(
      asScholar.mutation(api.practiceSkills.submitAnswer, {
        scholarId: scholar,
        itemId: makeItemId(MULT_STRAND[1], 1),
        answer: "0",
        breakerEasyTriggerAttemptId: triggerAttemptId,
      }),
    ).rejects.toThrow("Breaker easy-finish context is invalid");
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: easyItemId,
      answer: easyTruth,
      breakerEasyTriggerAttemptId: triggerAttemptId,
    });

    const trigger = await t.run((ctx) => ctx.db.get(triggerAttemptId));
    expect(trigger?.breakerLifecycle?.freshResult?.correct).toBe(false);
    expect(trigger?.breakerLifecycle?.easyExitedAt).toBe(NOW + 1);
    expect(trigger?.breaker?.recovery).toBe("won");
    await vi.advanceTimersByTimeAsync(1);
    const later = await submitMiss(t, scholar);
    expect(later.backOff).toBeUndefined();
    await expect(
      asScholar.query(api.practiceSkills.activeBreakerEpisode, { scholarId: scholar }),
    ).resolves.toBeNull();
  });

  test("records an explicit stop before a fresh attempt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_stop_before_fresh");
    await seedPriorMisses(t, scholar);
    const asScholar = await asUser(t, scholar);
    const trip = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: ITEM_ID,
      answer: "999999",
    });
    const triggerAttemptId = (await requireBreakerRecovery(t, trip)).triggerAttemptId;

    await expect(
      asScholar.mutation(api.practiceSkills.recordBreakerRecoveryLifecycle, {
        scholarId: scholar,
        triggerAttemptId,
        event: "stopped",
      }),
    ).resolves.toMatchObject({
      recorded: true,
      lifecycle: { stoppedAt: NOW },
    });
  });

  test("rejects a fresh result when that fresh item used the hint ladder", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_hinted_fresh");
    await seedPriorMisses(t, scholar);
    const asScholar = await asUser(t, scholar);
    const trip = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: ITEM_ID,
      answer: "999999",
    });
    const triggerAttemptId = (await requireBreakerRecovery(t, trip)).triggerAttemptId;
    await asScholar.mutation(api.practiceSkills.recordBreakerRecoveryLifecycle, {
      scholarId: scholar,
      triggerAttemptId,
      event: "repair_started",
    });
    await asScholar.mutation(api.practiceSkills.recordBreakerRecoveryLifecycle, {
      scholarId: scholar,
      triggerAttemptId,
      event: "repair_completed",
    });
    const recovery = await asScholar.mutation(api.practiceSkills.breakerRecoverySession, {
      scholarId: scholar,
      triggerAttemptId,
      seed: 8675320,
    });
    const freshItemId = recovery.items[0].itemId;
    await vi.advanceTimersByTimeAsync(1);
    const truth = gradeTemplateItem(freshItemId, "0")!.correctAnswer;
    await t.run((ctx) =>
      ctx.db.insert("practiceHintReveals", {
        scholarId: scholar,
        itemId: freshItemId,
        maxStepServed: 0,
        createdAt: NOW + 1,
      }),
    );
    const hintedResult = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: freshItemId,
      answer: truth,
      breakerTriggerAttemptId: triggerAttemptId,
    });
    expect(hintedResult.breakerRecoveryVerified).toBe(false);

    await expect(
      asScholar.mutation(api.practiceSkills.recordBreakerRecoveryLifecycle, {
        scholarId: scholar,
        triggerAttemptId,
        event: "fresh_result",
        freshItemId,
      }),
    ).resolves.toMatchObject({ recorded: true });
    const trigger = await t.run((ctx) => ctx.db.get(triggerAttemptId));
    expect(trigger?.breakerLifecycle?.freshResult).toMatchObject({
      correct: true,
      assisted: true,
    });
  });

  test("spiral trip raises a single practice_stuck alert on the threshold crossing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_alert");
    await seedPriorMisses(t, scholar);
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: "not_in_streak",
        itemId: "not_in_streak",
        correct: false,
        stemSnapshot: "This challenge-lane miss is not in the streak.",
        answerText: "exclude me",
        expectedAnswer: "excluded",
        domain: "whole-number-arithmetic",
        lane: "challenge",
        createdAt: NOW - 0.5,
      });

    });

    const first = await submitMiss(t, scholar);
    expect(first.backOff?.missStreak).toBe(3);
    const triggerAttemptId = (await requireBreakerRecovery(t, first)).triggerAttemptId;
    const asScholar = await asUser(t, scholar);
    await asScholar.mutation(api.practiceSkills.recordBreakerOutcome, {
      scholarId: scholar,
      itemId: ITEM_ID,
      streak: 3,
      offer: "accepted",
    });
    await vi.advanceTimersByTimeAsync(PRACTICE_ALERT_COMPOSE_DELAY_MS);
    await t.finishInProgressScheduledFunctions();

    const stuckAfterFirst = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("alerts")
          .withIndex("by_scholar", (q) => q.eq("scholarId", scholar))
          .collect()
      ).filter((a) => a.kind === "practice_stuck"),
    );
    expect(stuckAfterFirst).toHaveLength(1);
    expect(stuckAfterFirst[0].severity).toBe("warning");
    expect(stuckAfterFirst[0].source).toBe("practice");
    expect(stuckAfterFirst[0].body).toContain("This sitting: 0 of 3 correct");
    expect(stuckAfterFirst[0].body.match(/^• /gm)).toHaveLength(3);
    expect(stuckAfterFirst[0].body).toContain("`Prior question 2?`");
    expect(stuckAfterFirst[0].body).toContain("answered `wrong-2`");
    expect(stuckAfterFirst[0].body).toContain("`Prior question 1?`");
    expect(stuckAfterFirst[0].body).toContain("answered `wrong-1`");
    const submittedGrade = gradeTemplateItem(ITEM_ID, "999999");
    expect(submittedGrade).not.toBeNull();
    expect(stuckAfterFirst[0].body).toContain(`\`${submittedGrade!.stem}\``);
    expect(stuckAfterFirst[0].body).toContain("answered `999999`");
    expect(stuckAfterFirst[0].body).not.toContain("challenge-lane miss");
    expect(stuckAfterFirst[0].body).not.toContain("_AI read:_");
    expect(stuckAfterFirst[0].body).toContain(
      "Rabbithole paused the run with one step-card repair ready",
    );
    expect(stuckAfterFirst[0].body).not.toContain("What happened next");

    // A 4th miss reads as streak 4 (past the crossing), so it must NOT re-post:
    // the alert fires once per episode, on the threshold crossing, not per miss.
    const second = await submitMiss(t, scholar, { prepareBreakerRepair: true });
    expect(second.backOff?.missStreak).toBe(4);
    expect(second.backOff?.reattached).toBe(true);
    expect((await requireBreakerRecovery(t, second)).triggerAttemptId).toBe(
      triggerAttemptId,
    );
    const secondPassHints = await t.run((ctx) =>
      ctx.db
        .query("practiceHintReveals")
        .filter((q) =>
          q.and(
            q.eq(q.field("scholarId"), scholar),
            q.eq(q.field("itemId"), ITEM_ID),
          ),
        )
        .collect(),
    );
    expect(secondPassHints).toEqual([]);
    await expect(
      asScholar.query(api.practiceSkills.activeBreakerEpisode, { scholarId: scholar }),
    ).resolves.toMatchObject({ triggerAttemptId });
    const stuckAfterSecond = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("alerts")
          .withIndex("by_scholar", (q) => q.eq("scholarId", scholar))
          .collect()
      ).filter((a) => a.kind === "practice_stuck"),
    );
    expect(stuckAfterSecond).toHaveLength(1);
  });

  test("replays a lost threshold-miss response without a second breaker lifecycle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_idempotent_trip");
    await seedPriorMisses(t, scholar);
    const asScholar = await asUser(t, scholar);
    const args = {
      scholarId: scholar,
      itemId: ITEM_ID,
      answer: "999999",
      prepareBreakerRepair: true,
      clientEventId: "practice-answer:threshold",
    };

    const first = await asScholar.mutation(api.practiceSkills.submitAnswer, args);
    const duplicate = await asScholar.mutation(api.practiceSkills.submitAnswer, args);
    expect(duplicate).toEqual(first);
    expect(first.breakerRecovery?.triggerAttemptId).toBeDefined();
    const attemptRows = await t.run((ctx) =>
      ctx.db
        .query("practiceAttempts")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholar))
        .collect(),
    );
    expect(attemptRows).toHaveLength(3);
    expect(
      attemptRows.filter((attempt) => attempt.breakerLifecycle?.triggeredAt !== undefined),
    ).toHaveLength(1);
  });

  test("attaches a legacy above-threshold streak without a second root alert", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_legacy_reattach");
    await seedPriorMisses(t, scholar, "review", 3);

    const result = await submitMiss(t, scholar);
    expect(result.backOff).toMatchObject({ missStreak: 4, reattached: true });
    const triggerAttemptId = (await requireBreakerRecovery(t, result)).triggerAttemptId;
    const trigger = await t.run((ctx) => ctx.db.get(triggerAttemptId));
    expect(trigger?.createdAt).toBe(NOW - 1);
    expect(trigger?.breakerLifecycle).toMatchObject({
      version: 2,
      triggerNodeKey: "prior_1",
    });
    await t.finishInProgressScheduledFunctions();
    expect(await practiceStuckAlerts(t, scholar)).toHaveLength(0);
  });

  test("accepts a compose job queued by the previous deployment shape", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_legacy_compose");
    await seedPriorMisses(t, scholar, "review", SPIRAL_MISS_THRESHOLD);
    const attemptIds = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("practiceAttempts")
          .withIndex("by_scholar_createdAt", (q) => q.eq("scholarId", scholar))
          .order("desc")
          .take(3)
      )
        .reverse()
        .map((attempt) => attempt._id),
    );

    await t.action(internal.practiceStuckAlert.compose, {
      scholarId: scholar,
      missStreak: 3,
      attemptIds,
      fallbackSkillLabel: "Count to 10",
      allDontKnow: false,
    });

    const [alert] = await practiceStuckAlerts(t, scholar);
    expect(alert.practiceTriggerAttemptId).toBe(attemptIds.at(-1));
  });

  test("queued alert composition refuses a persisted excluded attempt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_excluded_compose");
    const attemptIds = await t.run(async (ctx) => {
      const ids: Id<"practiceAttempts">[] = [];
      for (let i = SPIRAL_MISS_THRESHOLD; i >= 1; i--) {
        ids.push(
          await ctx.db.insert("practiceAttempts", {
            scholarId: scholar,
            nodeKey: `excluded_${i}`,
            itemId: `excluded_${i}`,
            correct: false,
            domain: "whole-number-arithmetic",
            lane: "review",
            breakerEligible: false,
            createdAt: NOW - i,
          }),
        );
      }
      return ids;
    });

    await t.action(internal.practiceStuckAlert.compose, {
      scholarId: scholar,
      triggerAttemptId: attemptIds.at(-1),
      missStreak: SPIRAL_MISS_THRESHOLD,
      attemptIds,
      fallbackSkillLabel: "Excluded practice",
      allDontKnow: false,
    });

    expect(await practiceAlerts(t, scholar)).toEqual([]);
  });

  test("stores the Slack parent receipt and fences terminal outcome claims", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_threaded_outcome");
    await seedPriorMisses(t, scholar);
    const asScholar = await asUser(t, scholar);

    const result = await submitMiss(t, scholar);
    await vi.advanceTimersByTimeAsync(PRACTICE_ALERT_COMPOSE_DELAY_MS);
    await t.finishInProgressScheduledFunctions();
    const [alert] = await practiceStuckAlerts(t, scholar);
    expect(alert.practiceTriggerAttemptId).toBe(
      result.breakerRecovery?.triggerAttemptId,
    );

    await t.mutation(internal.alerts.recordSlackDelivery, {
      alertId: alert._id,
      channelId: "C_ALERTS",
      messageTs: "1234.5678",
    });
    await t.run((ctx) =>
      ctx.db.patch(alert._id, { practiceDiagnosisReadyAt: undefined }),
    );
    await asScholar.mutation(
      api.practiceSkills.recordBreakerRecoveryLifecycle,
      {
        scholarId: scholar,
        triggerAttemptId: result.breakerRecovery!.triggerAttemptId,
        event: "easy_exit",
      },
    );
    await asScholar.mutation(api.practiceSkills.recordBreakerOutcome, {
      scholarId: scholar,
      attemptId: result.breakerRecovery!.triggerAttemptId,
      itemId: ITEM_ID,
      streak: 3,
      offer: "declined",
      recovery: "won",
    });

    const firstClaim = await t.mutation(
      internal.practiceStuckAlert.claimOutcome,
      { triggerAttemptId: result.breakerRecovery!.triggerAttemptId },
    );
    expect(firstClaim).toMatchObject({
      alertId: alert._id,
      channelId: "C_ALERTS",
      threadTs: "1234.5678",
    });
    expect(firstClaim?.text).toContain(
      "They chose the easier finish and got that item right.",
    );
    expect(
      await t.mutation(internal.practiceStuckAlert.claimOutcome, {
        triggerAttemptId: result.breakerRecovery!.triggerAttemptId,
      }),
    ).toBeNull();

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1);
    const replacementClaim = await t.mutation(
      internal.practiceStuckAlert.claimOutcome,
      { triggerAttemptId: result.breakerRecovery!.triggerAttemptId },
    );
    expect(replacementClaim?.claimId).not.toBe(firstClaim?.claimId);
    expect(
      await t.mutation(internal.practiceStuckAlert.releaseOutcomeClaim, {
        alertId: alert._id,
        claimId: firstClaim!.claimId,
      }),
    ).toBe(false);
    expect(
      await t.mutation(internal.practiceStuckAlert.finalizeOutcome, {
        alertId: alert._id,
        claimId: firstClaim!.claimId,
      }),
    ).toBe(false);
    await t.mutation(internal.practiceStuckAlert.finalizeOutcome, {
      alertId: alert._id,
      claimId: replacementClaim!.claimId,
    });
    expect(
      await t.mutation(internal.practiceStuckAlert.claimOutcome, {
        triggerAttemptId: result.breakerRecovery!.triggerAttemptId,
      }),
    ).toBeNull();
    const delivered = await t.run((ctx) => ctx.db.get(alert._id));
    expect(delivered).toMatchObject({
      slackChannelId: "C_ALERTS",
      slackMessageTs: "1234.5678",
      practiceOutcomePostedAt: Date.now(),
    });
  });

  test("posts one idempotent Slack thread reply for a terminal outcome", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_thread_delivery");
    await seedPriorMisses(t, scholar);
    const asScholar = await asUser(t, scholar);

    const result = await submitMiss(t, scholar);
    await vi.advanceTimersByTimeAsync(PRACTICE_ALERT_COMPOSE_DELAY_MS);
    await t.finishInProgressScheduledFunctions();
    const [alert] = await practiceStuckAlerts(t, scholar);
    await t.mutation(internal.alerts.recordSlackDelivery, {
      alertId: alert._id,
      channelId: "C_ALERTS",
      messageTs: "1234.5678",
    });
    await asScholar.mutation(
      api.practiceSkills.recordBreakerRecoveryLifecycle,
      {
        scholarId: scholar,
        triggerAttemptId: result.breakerRecovery!.triggerAttemptId,
        event: "easy_exit",
      },
    );
    await asScholar.mutation(api.practiceSkills.recordBreakerOutcome, {
      scholarId: scholar,
      attemptId: result.breakerRecovery!.triggerAttemptId,
      itemId: ITEM_ID,
      streak: 3,
      offer: "declined",
      recovery: "won",
    });

    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/conversations.replies")) {
          return new Response(
            JSON.stringify({
              ok: true,
              messages: [{ ts: "1234.5678", text: "root" }],
              response_metadata: { next_cursor: "" },
            }),
            { status: 200 },
          );
        }
        if (url.endsWith("/chat.postMessage")) {
          const body = JSON.parse(String(init?.body)) as {
            channel: string;
            thread_ts: string;
            markdown_text: string;
            metadata: {
              event_type: string;
              event_payload: { delivery_id: string };
            };
          };
          expect(body).toMatchObject({
            channel: "C_ALERTS",
            thread_ts: "1234.5678",
            metadata: {
              event_type: "rabbithole_practice_alert_outcome",
              event_payload: {
                delivery_id: `practice-outcome:${alert._id}`,
              },
            },
          });
          expect(body.markdown_text).toContain(
            "They chose the easier finish and got that item right.",
          );
          return new Response(
            JSON.stringify({ ok: true, ts: "1234.9999" }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      },
    );
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
    vi.stubGlobal("fetch", fetchMock);
    try {
      await t.action(internal.practiceStuckAlert.postOutcome, {
        triggerAttemptId: result.breakerRecovery!.triggerAttemptId,
      });
      await t.action(internal.practiceStuckAlert.postOutcome, {
        triggerAttemptId: result.breakerRecovery!.triggerAttemptId,
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [delivered] = await practiceStuckAlerts(t, scholar);
    expect(delivered).toMatchObject({
      practiceOutcomePostedAt: NOW,
    });
    expect(delivered.practiceOutcomeClaim).toBeUndefined();
  });

  test("waits through a fresh miss until the scholar stops", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_fresh_miss_stop");
    await seedPriorMisses(t, scholar);
    const asScholar = await asUser(t, scholar);
    const result = await submitMiss(t, scholar);
    await vi.advanceTimersByTimeAsync(PRACTICE_ALERT_COMPOSE_DELAY_MS);
    await t.finishInProgressScheduledFunctions();
    const [alert] = await practiceStuckAlerts(t, scholar);
    await t.mutation(internal.alerts.recordSlackDelivery, {
      alertId: alert._id,
      channelId: "C_ALERTS",
      messageTs: "1234.5678",
    });
    const triggerAttemptId = result.breakerRecovery!.triggerAttemptId;
    for (const event of ["repair_started", "repair_completed"] as const) {
      await asScholar.mutation(api.practiceSkills.recordBreakerRecoveryLifecycle, {
        scholarId: scholar,
        triggerAttemptId,
        event,
      });
    }
    const recovery = await asScholar.mutation(
      api.practiceSkills.breakerRecoverySession,
      { scholarId: scholar, triggerAttemptId, seed: 8675315 },
    );
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: recovery.items[0].itemId,
      answer: "999999",
      breakerTriggerAttemptId: triggerAttemptId,
    });

    expect(
      await t.mutation(internal.practiceStuckAlert.claimOutcome, {
        triggerAttemptId,
      }),
    ).toBeNull();
    await asScholar.mutation(api.practiceSkills.recordBreakerRecoveryLifecycle, {
      scholarId: scholar,
      triggerAttemptId,
      event: "stopped",
    });
    const claim = await t.mutation(
      internal.practiceStuckAlert.claimOutcome,
      { triggerAttemptId },
    );
    expect(claim?.text).toContain(
      "missed the fresh same-skill item, then stopped for now",
    );
  });

  test("extends the sitting timeout from the latest recovery activity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_activity_timeout");
    await seedPriorMisses(t, scholar);
    const asScholar = await asUser(t, scholar);
    const result = await submitMiss(t, scholar);
    await vi.advanceTimersByTimeAsync(PRACTICE_ALERT_COMPOSE_DELAY_MS);
    await t.finishInProgressScheduledFunctions();
    const [alert] = await practiceStuckAlerts(t, scholar);
    await t.mutation(internal.alerts.recordSlackDelivery, {
      alertId: alert._id,
      channelId: "C_ALERTS",
      messageTs: "1234.5678",
    });
    const triggerAttemptId = result.breakerRecovery!.triggerAttemptId;

    vi.setSystemTime(NOW + SPIRAL_GAP_MS - 60_000);
    await asScholar.mutation(api.practiceSkills.recordBreakerRecoveryLifecycle, {
      scholarId: scholar,
      triggerAttemptId,
      event: "repair_started",
    });
    vi.setSystemTime(NOW + SPIRAL_GAP_MS + 1);
    expect(
      await t.mutation(internal.practiceStuckAlert.claimOutcome, {
        triggerAttemptId,
      }),
    ).toBeNull();

    vi.setSystemTime(NOW + 2 * SPIRAL_GAP_MS - 60_000 + 1);
    expect(
      await t.mutation(internal.practiceStuckAlert.claimOutcome, {
        triggerAttemptId,
      }),
    ).toMatchObject({ alertId: alert._id });
  });

  test("an all-dont-know streak keeps back-off and raises only a calm not-yet-taught alert", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_all_dont_know");
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: "placement_probe",
        itemId: "placement_probe",
        correct: true,
        domain: "whole-number-arithmetic",
        lane: "placement",
        createdAt: NOW - 40_000,
      });
      for (const offset of [28_000, 14_000]) {
        await ctx.db.insert("practiceAttempts", {
          scholarId: scholar,
          nodeKey: `dont_know_${offset}`,
          itemId: `dont_know_${offset}`,
          correct: false,
          explanationReason: "dont_know",
          stemSnapshot: `Unknown question ${offset}`,
          expectedAnswer: `answer-${offset}`,
          ...(offset === 14_000 ? { teachOutcome: "hint" as const } : {}),
          domain: "whole-number-arithmetic",
          lane: "frontier",
          ...(offset === 14_000 ? { elapsedMs: 12_000 } : {}),
          createdAt: NOW - offset,
        });
      }
    });

    const result = await submitMiss(t, scholar, {
      answer: "",
      dontKnow: true,
      elapsedMs: 14_000,
    });
    expect(result.backOff?.missStreak).toBe(3);
    expect(result.backOff).not.toHaveProperty("streakAttemptIds");
    await vi.advanceTimersByTimeAsync(PRACTICE_ALERT_COMPOSE_DELAY_MS);
    await t.finishInProgressScheduledFunctions();
    const alerts = await practiceAlerts(t, scholar);
    const notYet = alerts.filter(
      (alert) => alert.kind === "practice_not_yet_taught",
    );
    expect(notYet).toHaveLength(1);
    expect(notYet[0].severity).toBe("info");
    expect(notYet[0].title).toContain("Hasn't met these yet");
    expect(notYet[0].body).toContain("This sitting: 0 of 3 correct");
    expect(notYet[0].body.match(/^• /gm)).toHaveLength(3);
    expect(notYet[0].body).toContain("`Unknown question 28000`");
    expect(notYet[0].body).toContain("(12s on this one)");
    expect(notYet[0].body).toContain("(14s on this one)");
    expect(notYet[0].body).toContain(
      "Teaching follow-up: finished with a hint.",
    );
    expect(notYet[0].body).not.toContain("_AI read:_");
    expect(alerts.filter((alert) => alert.kind === "practice_stuck")).toHaveLength(
      0,
    );
  });

  test("an all-manipulative streak keeps the scholar back-off but raises no alert", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_all_manipulative");
    const itemId = await t.run(async (ctx) => {
      for (const offset of [2, 1]) {
        await ctx.db.insert("practiceAttempts", {
          scholarId: scholar,
          nodeKey: "count_to_10",
          itemId: `manip_prior_${offset}`,
          correct: false,
          stemSnapshot: "Build a set of ten.",
          answerText: JSON.stringify({ perGroup: offset }),
          domain: "whole-number-arithmetic",
          lane: "frontier",
          createdAt: NOW - offset,
        });
      }
      return ctx.db.insert("practiceItems", {
        skillKey: "count_to_10",
        domain: "whole-number-arithmetic",
        stem: "Build a set of ten.",
        answerType: "manipulative",
        answerCanonical: "",
        verifierKind: "manipulative",
        manipulativeSpec: JSON.stringify({
          kind: "distributor",
          id: "stuck-alert-manipulative",
          concept: "Count to ten",
          prompt: "Build a set of ten.",
          total: 10,
          groups: 2,
          goal: { type: "shareEqually" },
        }),
        source: "generated",
        verifiedAt: NOW,
      });
    });
    const asScholar = await asUser(t, scholar);
    const result = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: `gen#${itemId}`,
      answer: JSON.stringify({ perGroup: 2 }),
    });
    expect(result.backOff?.missStreak).toBe(3);
    const latestAttempt = await t.run(async (ctx) =>
      ctx.db
        .query("practiceAttempts")
        .withIndex("by_scholar_item_createdAt", (q) =>
          q.eq("scholarId", scholar).eq("itemId", `gen#${itemId}`),
        )
        .order("desc")
        .first(),
    );
    expect(latestAttempt).not.toBeNull();
    const evidence = await t.query(
      internal.practiceStuckAlert.gatherEvidence,
      {
        scholarId: scholar,
        attemptIds: [latestAttempt!._id],
      },
    );
    expect(evidence).not.toBeNull();
    expect(evidence!.misses[0].answerText).toContain(
      "Each of the 2 plates holds 2 counters",
    );
    expect(evidence!.misses[0].answerText).not.toContain('{"perGroup":2}');
    await vi.advanceTimersByTimeAsync(PRACTICE_ALERT_COMPOSE_DELAY_MS);
    await t.finishInProgressScheduledFunctions();
    expect(await practiceAlerts(t, scholar)).toHaveLength(0);
  });

  test("one diagnosable wrong answer among two dont-knows raises an alert", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_mixed_diagnosable");
    await t.run(async (ctx) => {
      for (const offset of [2, 1]) {
        await ctx.db.insert("practiceAttempts", {
          scholarId: scholar,
          nodeKey: `dont_know_${offset}`,
          itemId: `dont_know_${offset}`,
          correct: false,
          explanationReason: "dont_know",
          stemSnapshot: `Unknown question ${offset}`,
          expectedAnswer: `answer-${offset}`,
          domain: "whole-number-arithmetic",
          lane: "frontier",
          createdAt: NOW - offset,
        });
      }
    });

    const result = await submitMiss(t, scholar);
    expect(result.backOff?.missStreak).toBe(3);
    await vi.advanceTimersByTimeAsync(PRACTICE_ALERT_COMPOSE_DELAY_MS);
    await t.finishInProgressScheduledFunctions();
    const alerts = await practiceStuckAlerts(t, scholar);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].body.match(/^• /gm)).toHaveLength(3);
    expect(alerts[0].body).toContain("answered `999999`");
    expect(
      (await practiceAlerts(t, scholar)).filter(
        (alert) => alert.kind === "practice_not_yet_taught",
      ),
    ).toHaveLength(0);
  });

  test("not-yet-taught alerts deduplicate within the same sitting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_not_yet_dedup");

    const seedDontKnows = async (base: number) => {
      await t.run(async (ctx) => {
        for (const dt of [2_000, 1_000]) {
          await ctx.db.insert("practiceAttempts", {
            scholarId: scholar,
            nodeKey: `dont_know_${base}_${dt}`,
            itemId: `dont_know_${base}_${dt}`,
            correct: false,
            explanationReason: "dont_know",
            stemSnapshot: `Unknown question ${base}-${dt}`,
            expectedAnswer: "not shown",
            domain: "whole-number-arithmetic",
            lane: "frontier",
            createdAt: base - dt,
          });
        }
      });
    };

    await seedDontKnows(NOW);
    const first = await submitMiss(t, scholar, { answer: "", dontKnow: true });
    expect(first.backOff?.missStreak).toBe(3);
    await vi.advanceTimersByTimeAsync(PRACTICE_ALERT_COMPOSE_DELAY_MS);
    await t.finishInProgressScheduledFunctions();

    const secondAt = NOW + 5_000;
    vi.setSystemTime(secondAt);
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: "reset_not_yet",
        itemId: "reset_not_yet",
        correct: true,
        domain: "whole-number-arithmetic",
        lane: "review",
        createdAt: NOW + 1_000,
      });
    });
    await seedDontKnows(secondAt);
    const second = await submitMiss(t, scholar, {
      answer: "",
      dontKnow: true,
    });
    expect(second.backOff?.missStreak).toBe(3);
    await vi.advanceTimersByTimeAsync(PRACTICE_ALERT_COMPOSE_DELAY_MS);
    await t.finishInProgressScheduledFunctions();

    expect(
      (await practiceAlerts(t, scholar)).filter(
        (alert) => alert.kind === "practice_not_yet_taught",
      ),
    ).toHaveLength(1);
  });

  test("a correct recovery attempt before composition cannot replace the pinned three misses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_pinned_before_recovery");
    await seedPriorMisses(t, scholar);
    await t.run(async (ctx) => {
      const attempts = await ctx.db
        .query("practiceAttempts")
        .withIndex("by_scholar_createdAt", (q) => q.eq("scholarId", scholar))
        .collect();
      for (const attempt of attempts) {
        if (attempt.nodeKey === "prior_2") {
          await ctx.db.patch(attempt._id, { elapsedMs: 7_000 });
        } else if (attempt.nodeKey === "prior_1") {
          await ctx.db.patch(attempt._id, { elapsedMs: 8_000 });
        }
      }
    });

    const crossing = await submitMiss(t, scholar, { elapsedMs: 17_000 });
    expect(crossing.backOff?.missStreak).toBe(3);

    vi.setSystemTime(NOW + 1_000);
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: "recovery",
        itemId: "recovery",
        correct: true,
        stemSnapshot: "Recovery question",
        answerText: "right",
        expectedAnswer: "right",
        domain: "whole-number-arithmetic",
        lane: "review",
        createdAt: NOW + 1_000,
      });
    });

    await vi.advanceTimersByTimeAsync(PRACTICE_ALERT_COMPOSE_DELAY_MS);
    await t.finishInProgressScheduledFunctions();

    const stuck = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("alerts")
          .withIndex("by_scholar", (q) => q.eq("scholarId", scholar))
          .collect()
      ).filter((alert) => alert.kind === "practice_stuck"),
    );
    expect(stuck).toHaveLength(1);
    expect(stuck[0].body).toContain("This sitting: 1 of 4 correct");
    expect(stuck[0].body.match(/^• /gm)).toHaveLength(3);
    expect(stuck[0].body).toContain(
      "• *prior\\_2* (7s on this one)\n",
    );
    expect(stuck[0].body).toContain(
      "• *prior\\_1* (8s on this one)\n",
    );
    expect(stuck[0].body).toContain(
      "• *Count to 10 by ones* (17s on this one)\n",
    );
    expect(stuck[0].body).toContain("answered `999999`");
    expect(stuck[0].body).not.toContain("Recovery question");
  });

  test("missing pinned evidence degrades to a deterministic alert instead of silence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_evidence_fallback");
    await seedPriorMisses(t, scholar);

    const crossing = await submitMiss(t, scholar);
    expect(crossing.backOff?.missStreak).toBe(3);
    await t.run(async (ctx) => {
      const pinnedAttempt = await ctx.db
        .query("practiceAttempts")
        .withIndex("by_scholar_createdAt", (q) => q.eq("scholarId", scholar))
        .order("desc")
        .first();
      expect(pinnedAttempt).not.toBeNull();
      await ctx.db.delete(pinnedAttempt!._id);
    });

    await vi.advanceTimersByTimeAsync(PRACTICE_ALERT_COMPOSE_DELAY_MS);
    await t.finishInProgressScheduledFunctions();

    const stuck = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("alerts")
          .withIndex("by_scholar", (q) => q.eq("scholarId", scholar))
          .collect()
      ).filter((alert) => alert.kind === "practice_stuck"),
    );
    expect(stuck).toHaveLength(1);
    expect(stuck[0].body).toBe(
      [
        "Missed 3 practice items in a row. Rabbithole paused the run and offered to talk one through with the tutor, or to finish on an easier one.",
        "Most recently on *Count to 10 by ones*.",
        "Might be a good moment to check in.",
      ].join("\n"),
    );
  });

  test("deduplicates diagnosable episodes inside 30 minutes and re-alerts after the sitting window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_new_episode");
    await seedPriorMisses(t, scholar);

    // First episode: three misses cross the threshold → one alert.
    const first = await submitMiss(t, scholar);
    expect(first.backOff?.missStreak).toBe(3);
    await vi.advanceTimersByTimeAsync(PRACTICE_ALERT_COMPOSE_DELAY_MS);
    await t.finishInProgressScheduledFunctions();

    // A correct attempt resets consecutiveMissStreak to 0, closing the episode.
    // Insert it directly (a raw counted-lane row) so the reset is deterministic
    // and independent of the item's canonical answer.
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: "reset",
        itemId: "reset",
        correct: true,
        domain: "whole-number-arithmetic",
        lane: "review",
        createdAt: NOW + 1_000,
      });
    });

    // A brand-new diagnosable spiral inside the same sitting still returns the
    // child-facing breaker, but the staff alert is coalesced.
    vi.setSystemTime(NOW + 5_000);
    await t.run(async (ctx) => {
      for (const dt of [3_000, 4_000]) {
        await ctx.db.insert("practiceAttempts", {
          scholarId: scholar,
          nodeKey: `relapse_${dt}`,
          itemId: `relapse_${dt}`,
          correct: false,
          domain: "whole-number-arithmetic",
          lane: "review",
          createdAt: NOW + dt,
        });
      }
    });
    const relapse = await submitMiss(t, scholar);
    expect(relapse.backOff?.missStreak).toBe(3);
    await vi.advanceTimersByTimeAsync(PRACTICE_ALERT_COMPOSE_DELAY_MS);
    await t.finishInProgressScheduledFunctions();
    expect(await practiceStuckAlerts(t, scholar)).toHaveLength(1);

    // Once the existing same-sitting window has elapsed, another diagnosable
    // episode earns a new staff alert.
    const later = NOW + SPIRAL_GAP_MS + 5_000;
    vi.setSystemTime(later);
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: "later_reset",
        itemId: "later_reset",
        correct: true,
        domain: "whole-number-arithmetic",
        lane: "review",
        createdAt: later - 3_000,
      });
      for (const dt of [2_000, 1_000]) {
        await ctx.db.insert("practiceAttempts", {
          scholarId: scholar,
          nodeKey: `later_${dt}`,
          itemId: `later_${dt}`,
          correct: false,
          answerText: `wrong-${dt}`,
          expectedAnswer: `right-${dt}`,
          domain: "whole-number-arithmetic",
          lane: "review",
          createdAt: later - dt,
        });
      }
    });
    const laterResult = await submitMiss(t, scholar);
    expect(laterResult.backOff?.missStreak).toBe(3);
    await vi.advanceTimersByTimeAsync(PRACTICE_ALERT_COMPOSE_DELAY_MS);
    await t.finishInProgressScheduledFunctions();
    expect(await practiceStuckAlerts(t, scholar)).toHaveLength(2);
  });

  test("no backOff (below threshold) raises no practice_stuck alert", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_below");
    // Only one prior miss → this submit is the 2nd, under SPIRAL_MISS_THRESHOLD.
    await seedPriorMisses(t, scholar, "review", 1);

    const result = await submitMiss(t, scholar);
    expect(result.backOff).toBeUndefined();
    await vi.advanceTimersByTimeAsync(PRACTICE_ALERT_COMPOSE_DELAY_MS);
    await t.finishInProgressScheduledFunctions();

    const stuck = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("alerts")
          .withIndex("by_scholar", (q) => q.eq("scholarId", scholar))
          .collect()
      ).filter((a) => a.kind === "practice_stuck"),
    );
    expect(stuck).toHaveLength(0);
  });

  test("replay submissions never open a breaker or raise a practice_stuck alert", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_replay");
    await seedPriorMisses(t, scholar);

    // A replayed offline burst may arrive in a tight cluster, but it remains
    // historical evidence: record its grade without opening a current episode.
    const result = await submitMiss(t, scholar, { replay: true });
    expect(result.backOff).toBeUndefined();
    expect(result.breakerRecovery).toBeUndefined();
    const attempt = await t.run((ctx) => ctx.db.get(result.attemptId!));
    expect(attempt?.breakerLifecycle).toBeUndefined();
    await expect(
      (await asUser(t, scholar)).query(api.practiceSkills.activeBreakerEpisode, {
        scholarId: scholar,
      }),
    ).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(PRACTICE_ALERT_COMPOSE_DELAY_MS);
    await t.finishInProgressScheduledFunctions();

    const stuck = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("alerts")
          .withIndex("by_scholar", (q) => q.eq("scholarId", scholar))
          .collect()
      ).filter((a) => a.kind === "practice_stuck"),
    );
    expect(stuck).toHaveLength(0);
  });

  test("recordBreakerOutcome ignores a missing attempt", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t, "spiral_outcome_missing");
    const asScholar = await asUser(t, scholar);

    const result = await asScholar.mutation(api.practiceSkills.recordBreakerOutcome, {
      scholarId: scholar,
      itemId: ITEM_ID,
      streak: 3,
      offer: "accepted",
      recovery: "won",
    });

    expect(result).toEqual({ recorded: false });
  });

  test("a flood of newer retry rows does not dilute the miss-streak scan window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "spiral_retry_flood");

    // Two genuine counted misses, comfortably older than the retry flood below.
    await t.run(async (ctx) => {
      for (let i = 1; i <= SPIRAL_MISS_THRESHOLD - 1; i++) {
        await ctx.db.insert("practiceAttempts", {
          scholarId: scholar,
          nodeKey: `prior_${i}`,
          itemId: `prior_${i}`,
          correct: false,
          domain: "whole-number-arithmetic",
          lane: "review",
          createdAt: NOW - 1_000 - i,
        });
      }
      // A flood of NEWER, lane-less diagnostic retry rows — the exact shape this
      // PR introduces when a struggling scholar re-submits an item repeatedly.
      // There are enough to more than fill the SPIRAL_SCAN_LIMIT fetch window on
      // their own, so an UNFILTERED `.take(SPIRAL_SCAN_LIMIT)` would evict the two
      // counted misses above and report a streak below threshold — silently
      // disabling the back-off for precisely the scholar it targets.
      for (let i = 1; i <= SPIRAL_SCAN_LIMIT + 5; i++) {
        await ctx.db.insert("practiceAttempts", {
          scholarId: scholar,
          nodeKey: "retry_node",
          itemId: "retry_item",
          correct: false,
          domain: "whole-number-arithmetic",
          retry: true,
          createdAt: NOW - i,
        });
      }
    });

    // The recorded miss (newest of all) is the third counted miss. With the
    // query-level retry filter it still sees the two priors within the window,
    // so the back-off fires at exactly the threshold. (Recovery-skill selection
    // is covered separately; this test only asserts the streak survives the
    // retry flood.)
    const result = await submitMiss(t, scholar);
    expect(result.backOff?.missStreak).toBe(SPIRAL_MISS_THRESHOLD);
  });
});

describe("practiceSkills — review visibility + challenge items (P1e)", () => {
  const DAY = 86_400_000;

  test("a due, already-learned skill is served with the 'review' lane; session carries a challenge array", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    // Practice the root once (a real, demonstrated attempt), then age it so its
    // retention has decayed below threshold — now it's a due REVIEW.
    await t.mutation(internal.practiceSkills.recordAttemptInternal, {
      scholarId: scholar,
      skillKey: "count_to_10",
      correct: true,
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar_skill", (q) => q.eq("scholarId", scholar).eq("skillKey", "count_to_10"))
        .first();
      if (row) await ctx.db.patch(row._id, { lastPracticedAt: Date.now() - 90 * DAY, halfLifeDays: 1 });
    });

    const session = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      size: 5,
      seed: 33,
    });
    const c10 = session.items.filter((it) => it.skillKey === "count_to_10");
    expect(c10.length).toBeGreaterThan(0);
    for (const it of c10) expect(it.lane).toBe("review");
    // The challenge tail is always present in the payload (empty here — no band).
    expect(Array.isArray(session.challenge)).toBe(true);
  });

  test("above-band frontier is offered ONLY as a labeled, opt-in challenge tail — never in the required set", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    // Push two of the root's direct dependents well above the scholar's grade
    // band; leave the third (cardinality_within_10) on-band. The root is grade K,
    // so once it's demonstrated fluent the ceiling is grade 1 — the grade-8
    // dependents are above it, the grade-K one is not.
    await t.run(async (ctx) => {
      for (const key of ["count_to_100_tens", "count_to_20"]) {
        const node = await ctx.db
          .query("knowledgeNodes")
          .withIndex("by_nodeKey", (q) => q.eq("nodeKey", key))
          .first();
        if (node) await ctx.db.patch(node._id, { grade: "8" });
      }
    });
    // Make the root demonstrated-fluent so its dependents open on the frontier.
    for (let i = 0; i < 3; i++) {
      await t.mutation(internal.practiceSkills.recordAttemptInternal, {
        scholarId: scholar,
        skillKey: "count_to_10",
        correct: true,
      });
    }

    const session = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      size: 8,
      seed: 77,
    });

    const ABOVE_BAND = new Set(["count_to_100_tens", "count_to_20"]);
    // The required set NEVER contains an above-band skill.
    for (const it of session.items) expect(ABOVE_BAND.has(it.skillKey)).toBe(false);
    // The above-band work surfaces as a clearly-labeled challenge tail instead.
    expect(session.challenge.length).toBeGreaterThan(0);
    for (const it of session.challenge) {
      expect(it.lane).toBe("challenge");
      expect(ABOVE_BAND.has(it.skillKey)).toBe(true);
    }

    const challengeItem = session.challenge[0];
    const truth = gradeTemplateItem(challengeItem.itemId, "0");
    expect(truth).toBeDefined();
    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: challengeItem.itemId,
      answer: truth!.correctAnswer,
    });
    const challengeAttempts = await t.run(async (ctx) =>
      (await ctx.db.query("practiceAttempts").collect()).filter(
        (row) => row.scholarId === scholar && row.itemId === challengeItem.itemId,
      ),
    );
    expect(challengeAttempts).toHaveLength(1);
    expect(challengeAttempts[0].lane).toBe("challenge");
  });

  test("the first required block after placement uses placed-through ceiling and demotes dont-know probes", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t, "firstblock");
    const domain = "first-block-calibration";
    const now = Date.now();

    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "placed_grade_3",
        label: "Placed Grade 3",
        domain,
        strand: "ops",
        grade: "3",
        order: 0,
        source: "practice",
      });
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "unknown_grade_4",
        label: "Unknown Grade 4",
        domain,
        strand: "ops",
        grade: "4",
        order: 1,
        source: "practice",
      });
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: "placed_grade_3",
        toKey: "unknown_grade_4",
        domain,
        kind: "buildsOn",
      });
      await ctx.db.insert("practicePlacements", {
        scholarId: scholar,
        domain,
        status: "complete",
        probesAnswered: 1,
        frontierByStrand: [{ strand: "ops", frontierKey: "unknown_grade_4" }],
        probeLog: [
          {
            nodeKey: "unknown_grade_4",
            strand: "ops",
            outcome: "unknown",
            at: now,
          },
        ],
        updatedAt: now,
      });
      await ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: "placed_grade_3",
        domain,
        strand: "ops",
        repetition: FLUENT_REPS_VALUE,
        halfLifeDays: 4,
        lastPracticedAt: now,
        frontier: false,
        source: "placement",
        updatedAt: now,
      });
      await ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: "unknown_grade_4",
        domain,
        strand: "ops",
        repetition: 0,
        halfLifeDays: 0,
        frontier: true,
        source: "placement",
        updatedAt: now,
      });
    });

    const asScholar = await asUser(t, scholar);
    const firstQueue = await asScholar.query(api.practiceSkills.nextForScholar, {
      scholarId: scholar,
      domain,
      limit: 5,
    });
    expect(firstQueue.find((q) => q.key === "unknown_grade_4")?.reason).toBe("challenge");
    expect(firstQueue.some((q) => q.key === "unknown_grade_4" && q.reason === "new")).toBe(false);

    await t.run(async (ctx) => {
      await ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: "placed_grade_3",
        correct: true,
        domain,
        lane: "frontier",
        source: "practice",
        createdAt: now + 1,
      });
    });

    const laterQueue = await asScholar.query(api.practiceSkills.nextForScholar, {
      scholarId: scholar,
      domain,
      limit: 5,
    });
    expect(laterQueue.find((q) => q.key === "unknown_grade_4")?.reason).toBe("new");
  });

  test("submitAnswer reports the consolidation moment + when the skill comes back", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    // Two correct reps: not yet fluent (FLUENT_REPS is 3).
    for (let i = 0; i < FLUENT_REPS_VALUE - 1; i++) {
      await t.mutation(internal.practiceSkills.recordAttemptInternal, {
        scholarId: scholar,
        skillKey: "count_to_10",
        correct: true,
      });
    }
    // The third, correct, submitted attempt consolidates it (turns it fluent).
    const session = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      size: 4,
      seed: 5,
    });
    const item = session.items.find((it) => it.skillKey === "count_to_10");
    expect(item).toBeDefined();
    const truth = gradeTemplateItem(item!.itemId, "0");
    const res = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: item!.itemId,
      answer: truth!.correctAnswer,
    });
    expect(res.correct).toBe(true);
    expect(res.turnedFluent).toBe(true);
    expect(typeof res.comesBackAt).toBe("number");
    expect(res.comesBackAt as number).toBeGreaterThan(Date.now());
    // count_to_10 is high-fanout, so it uses the scheduler's stricter per-skill
    // target (0.90), not the legacy hardcoded 0.60 threshold (~17h at 1d half-life).
    expect(res.comesBackAt as number).toBeLessThan(Date.now() + DAY / 2);
  });

  test("a non-consolidating attempt carries no comesBackAt", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    const session = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      size: 1,
      seed: 8,
    });
    const item = session.items[0];
    const truth = gradeTemplateItem(item.itemId, "0");
    // First correct attempt (rep 1) — not fluent yet.
    const res = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: item.itemId,
      answer: truth!.correctAnswer,
    });
    expect(res.correct).toBe(true);
    expect(res.turnedFluent).toBe(false);
    expect(res.comesBackAt).toBeUndefined();
  });

  test("treeForScholar exposes dueAt and becameFluentAt for practiced skills, null for untouched", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    for (let i = 0; i < FLUENT_REPS_VALUE; i++) {
      await t.mutation(internal.practiceSkills.recordAttemptInternal, {
        scholarId: scholar,
        skillKey: "count_to_10",
        correct: true,
      });
    }
    const tree = await asScholar.query(api.practiceSkills.treeForScholar, { scholarId: scholar });
    const c10 = tree.nodes.find((n) => n.skillKey === "count_to_10")!;
    expect(typeof c10.dueAt).toBe("number");
    expect(c10.dueAt as number).toBeGreaterThan(0);
    expect(typeof c10.becameFluentAt).toBe("number");
    // A never-practiced node has nothing scheduled yet.
    const untouched = tree.nodes.find((n) => n.skillKey === "cardinality_within_10")!;
    expect(untouched.dueAt).toBeNull();
    expect(untouched.becameFluentAt).toBeNull();
  });
});

describe("practiceSkills — generated (LLM) items grade + mix in", () => {
  async function insertGenItem(t: ReturnType<typeof convexTest>, skillKey: string, stem: string, answer: string) {
    return await t.run(async (ctx) =>
      ctx.db.insert("practiceItems", {
        skillKey,
        domain: "whole-number-arithmetic",
        stem,
        answerType: "integer",
        answerCanonical: answer,
        source: "generated",
        verifiedAt: Date.now(),
      }),
    );
  }

  test("submitAnswer grades a stored generated item by id lookup", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const id = await insertGenItem(t, "mult_2digit_by_1digit", "16 pages × 5 weeks?", "80");

    const wrong = await asScholar.mutation(api.practiceSkills.submitAnswer, { scholarId: scholar, itemId: `gen#${id}`, answer: "79" });
    expect(wrong.correct).toBe(false);
    expect(wrong.correctAnswer).toBeUndefined(); // a miss never reveals the answer (⑫)

    const right = await asScholar.mutation(api.practiceSkills.submitAnswer, { scholarId: scholar, itemId: `gen#${id}`, answer: "80" });
    expect(right.correct).toBe(true);
    expect(right.correctAnswer).toBe("80"); // echoed only on a correct submission
    expect(right.skillKey).toBe("mult_2digit_by_1digit");
  });

  test("practiceSession mixes a generated item in for a frontier skill", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    // count_to_10 is the root → on the frontier for a fresh scholar.
    await insertGenItem(t, "count_to_10", "A dragon has 9 coins and finds 1 more. How many now?", "10");
    const session = await asScholar.query(api.practiceSkills.practiceSession, { scholarId: scholar, size: 8, seed: 1 });
    expect(session.items.some((it) => it.itemId.startsWith("gen#"))).toBe(true);
  });
});

describe("practiceSkills — mastery-gated cross-domain seeds", () => {
  async function seedCount(t: ReturnType<typeof convexTest>, scholarId: Id<"users">) {
    return await t.run(async (ctx) => {
      const rows = await ctx.db.query("seeds").collect();
      return rows.filter(
        (s) => s.scholarId === scholarId && s.origin === "ai-constellation" && s.sourceLens === "math-practice",
      ).length;
    });
  }

  test("a cross-domain seed fires only once its gate skill is fluent", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);

    // 2 correct on the gate skill → still practicing, no seed yet.
    for (let i = 0; i < 2; i++)
      await t.mutation(internal.practiceSkills.recordAttemptInternal, { scholarId: scholar, skillKey: "skip_count_2s_5s_10s", correct: true });
    expect(await seedCount(t, scholar)).toBe(0);

    // 3rd correct → fluent → the gated seed fires.
    await t.mutation(internal.practiceSkills.recordAttemptInternal, { scholarId: scholar, skillKey: "skip_count_2s_5s_10s", correct: true });
    expect(await seedCount(t, scholar)).toBe(1);

    // Further practice does not duplicate it (idempotent).
    await t.mutation(internal.practiceSkills.recordAttemptInternal, { scholarId: scholar, skillKey: "skip_count_2s_5s_10s", correct: true });
    expect(await seedCount(t, scholar)).toBe(1);

    // The seed is scholar-facing and curiosity-framed (no "gap" language).
    const seed = await t.run(async (ctx) => {
      const rows = await ctx.db.query("seeds").collect();
      return rows.find((s) => s.scholarId === scholar && s.sourceLens === "math-practice") ?? null;
    });
    expect(seed?.suggestionType).toBe("cross_domain");
    expect(seed?.scholarInvitation).toBeTruthy();
    expect(seed?.scholarInvitation?.toLowerCase()).not.toContain("gap");
  });

  test("the fractions on-ramp seed stamps its practice-drill target; a plain seed does not", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);

    // Make the on-ramp's gate skill (equal-sharing division) fluent.
    for (let i = 0; i < FLUENT_REPS_VALUE; i++)
      await t.mutation(internal.practiceSkills.recordAttemptInternal, {
        scholarId: scholar,
        skillKey: "division_as_sharing",
        correct: true,
      });

    const onRamp = await t.run(async (ctx) => {
      const rows = await ctx.db.query("seeds").collect();
      return rows.find(
        (s) => s.scholarId === scholar && s.connectionTo === "Fractions",
      ) ?? null;
    });
    // The star routes into the FRACTIONS drill, not back to whole-number.
    expect(onRamp).not.toBeNull();
    expect(onRamp?.practiceDomain).toBe("fraction-arithmetic");

    // A plain cross-domain seed (binary) carries no practice-domain stamp — its
    // star falls back to the display-domain allowlist.
    for (let i = 0; i < FLUENT_REPS_VALUE; i++)
      await t.mutation(internal.practiceSkills.recordAttemptInternal, {
        scholarId: scholar,
        skillKey: "skip_count_2s_5s_10s",
        correct: true,
      });
    const binary = await t.run(async (ctx) => {
      const rows = await ctx.db.query("seeds").collect();
      return rows.find(
        (s) => s.scholarId === scholar && s.topic.startsWith("Counting by 2s"),
      ) ?? null;
    });
    expect(binary).not.toBeNull();
    expect(binary?.practiceDomain).toBeUndefined();
  });
});

describe("practiceSkills — problem_set activity (scoped practice)", () => {
  test("creating a problem set schedules one idempotent durable-item job", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const teacher = await seedScholar(t, "problemset-teacher");
    const { lessonId } = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId: teacher,
        title: "Practice unit",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Practice lesson",
        order: 0,
      });
      return { lessonId };
    });

    const created = await t.mutation(internal.practiceSkills.createProblemSetActivity, {
      lessonId,
      title: "Multiplication warm-up",
      targetSkillKeys: ["mult_facts_7_8_9"],
    });
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].name).toContain("practiceGen:ensureProblemSetItems");
    expect(scheduled[0].args[0]).toEqual({ activityId: created.activityId });
    expect(
      await t.query(internal.practiceSkills.problemSetGenerationTargets, {
        activityId: created.activityId,
      }),
    ).toEqual({ targetSkillKeys: ["mult_facts_7_8_9"] });
  });

  test("filters stale or cross-domain generation targets without scheduling paid work for them", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const activityId = await t.run((ctx) =>
      ctx.db.insert("activities", {
        title: "Invalid targets",
        kind: "problem_set",
        order: 0,
        problemSet: {
          domain: "whole-number-arithmetic",
          targetSkillKeys: ["mult_facts_7_8_9", "fraction_as_division", "missing"],
        },
      }),
    );
    expect(
      await t.query(internal.practiceSkills.problemSetGenerationTargets, { activityId }),
    ).toEqual({ targetSkillKeys: ["mult_facts_7_8_9"] });
  });

  test("problemSetSkills resolves a problem_set activity, and practice scopes to its skills", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    const targetSkillKeys = ["mult_facts_7_8_9", "mult_facts_3_4_6"];
    const activityId = await t.run(async (ctx) =>
      ctx.db.insert("activities", {
        title: "Multiplication warm-up",
        kind: "problem_set",
        order: 0,
        problemSet: { domain: "whole-number-arithmetic", targetSkillKeys, itemCount: 8 },
      }),
    );

    const ps = await asScholar.query(api.practiceSkills.problemSetSkills, { activityId });
    expect(ps?.title).toBe("Multiplication warm-up");
    expect(ps?.targetSkillKeys).toEqual(targetSkillKeys);

    const session = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      size: 8,
      seed: 3,
      skillKeys: targetSkillKeys,
    });
    expect(session.items.length).toBeGreaterThan(0);
    // every served item is one of the activity's target skills
    for (const it of session.items) expect(targetSkillKeys).toContain(it.skillKey);
  });

  test("only a live assigned problem set can bypass a limited Math-plan scope", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "problemset-scope-scholar");
    const asScholar = await asUser(t, scholar);
    const targetSkillKeys = ["mult_facts_7_8_9"];
    const { assignedActivityId, unassignedActivityId } = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId: scholar,
        title: "Assigned practice",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Problem set lesson",
        order: 0,
      });
      const assignedActivityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Assigned multiplication",
        kind: "problem_set",
        order: 0,
        problemSet: {
          domain: "whole-number-arithmetic",
          targetSkillKeys,
        },
      });
      await ctx.db.insert("assignments", {
        teacherId: scholar,
        unitId,
        scholarIds: [scholar],
        startedAt: Date.now(),
        selfPaced: true,
        activitySchedule: [],
      });
      await ctx.db.insert("scholarMathPlans", {
        scholarId: scholar,
        practiceScope: {
          kind: "limited",
          domains: [{ domain: "fraction-arithmetic" }],
        },
        updatedBy: scholar,
        updatedAt: Date.now(),
      });
      const unassignedUnitId = await ctx.db.insert("units", {
        teacherId: scholar,
        title: "Unassigned practice",
        isActive: true,
      });
      const unassignedLessonId = await ctx.db.insert("lessons", {
        unitId: unassignedUnitId,
        title: "Unassigned lesson",
        order: 0,
      });
      const unassignedActivityId = await ctx.db.insert("activities", {
        lessonId: unassignedLessonId,
        title: "Unassigned multiplication",
        kind: "problem_set",
        order: 0,
        problemSet: {
          domain: "whole-number-arithmetic",
          targetSkillKeys,
        },
      });
      return { assignedActivityId, unassignedActivityId };
    });

    const guessed = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      skillKeys: targetSkillKeys,
      size: 4,
      seed: 8,
    });
    const assigned = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      problemSetActivityId: assignedActivityId,
      skillKeys: targetSkillKeys,
      size: 4,
      seed: 8,
    });
    expect(guessed.items).toEqual([]);
    expect(assigned.items.length).toBeGreaterThan(0);
    expect(assigned.items.every((item) => targetSkillKeys.includes(item.skillKey))).toBe(true);

    const unassigned = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      problemSetActivityId: unassignedActivityId,
      skillKeys: targetSkillKeys,
      size: 4,
      seed: 8,
    });
    expect(unassigned.items).toEqual([]);
    expect("blocked" in unassigned && unassigned.blocked).toBe(true);
  });
});

// A small, controlled two-strand domain built from REAL templated skillKeys so
// the adaptive placement flow (probe generation + grading) has real items. Add
// strand and multiply strand are independent tracks; the DAG is a linear chain
// within each strand.
const PLACEMENT_TEST_DOMAIN = "placement-test-2strand";
const ADD_STRAND = [
  "count_to_10",
  "add_within_5",
  "add_within_10",
  "add_within_20_regroup",
  "add_2digit_regroup",
];
const MULT_STRAND = [
  "skip_count_2s_5s_10s",
  "mult_facts_0_1_2_5_10",
  "mult_facts_3_4_6",
  "mult_2digit_by_1digit",
];

async function seedTwoStrandDomain(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    const strands: [string, string[]][] = [
      ["add", ADD_STRAND],
      ["mult", MULT_STRAND],
    ];
    for (const [strand, keys] of strands) {
      for (let i = 0; i < keys.length; i++) {
        await ctx.db.insert("knowledgeNodes", {
          nodeKey: keys[i],
          label: keys[i],
          domain: PLACEMENT_TEST_DOMAIN,
          strand,
          order: i,
          source: "practice",
        });
        if (i > 0) {
          await ctx.db.insert("knowledgeNodeEdges", {
            fromKey: keys[i - 1],
            toKey: keys[i],
            domain: PLACEMENT_TEST_DOMAIN,
            kind: "buildsOn",
          });
        }
      }
    }
  });
}

describe("practiceSkills — hard Math-plan serving scope", () => {
  async function limitToMultiplication(
    t: ReturnType<typeof convexTest>,
    scholarId: Id<"users">,
  ) {
    await t.run((ctx) =>
      ctx.db.insert("scholarMathPlans", {
        scholarId,
        practiceScope: {
          kind: "limited",
          domains: [{ domain: PLACEMENT_TEST_DOMAIN, strands: ["mult"] }],
        },
        updatedBy: scholarId,
        updatedAt: Date.now(),
      }),
    );
  }

  test("filters due reviews, frontier, and arbitrary skill keys to the limited strand", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t, "limited-scope-scholar");
    const asScholar = await asUser(t, scholar);
    await t.run((ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: ADD_STRAND[0],
        domain: PLACEMENT_TEST_DOMAIN,
        strand: "add",
        repetition: FLUENT_REPS_VALUE,
        halfLifeDays: 1,
        lastPracticedAt: Date.now() - 30 * 86_400_000,
        frontier: false,
        source: "practice",
        updatedAt: Date.now(),
      }),
    );
    await limitToMultiplication(t, scholar);

    const queue = await asScholar.query(api.practiceSkills.nextForScholar, {
      scholarId: scholar,
      domain: PLACEMENT_TEST_DOMAIN,
      limit: 12,
    });
    expect(queue).not.toHaveLength(0);
    expect(queue.every((item) => MULT_STRAND.includes(item.key as typeof MULT_STRAND[number]))).toBe(true);

    const scoped = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      domain: PLACEMENT_TEST_DOMAIN,
      skillKeys: [ADD_STRAND[0]],
      size: 4,
      seed: 3,
    });
    expect(scoped.items).toEqual([]);
  });

  test("atomically serves and pins the current in-scope easy finish", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t, "scoped-easy-finish");
    const asScholar = await asUser(t, scholar);
    const { planId, triggerAttemptId } = await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "unit_fraction",
        label: "unit_fraction",
        domain: PLACEMENT_TEST_DOMAIN,
        strand: "mult",
        order: MULT_STRAND.length,
        source: "practice",
      });
      const planId = await ctx.db.insert("scholarMathPlans", {
        scholarId: scholar,
        practiceScope: {
          kind: "limited",
          domains: [{ domain: PLACEMENT_TEST_DOMAIN, strands: ["add"] }],
        },
        updatedBy: scholar,
        updatedAt: NOW,
      });
      for (const [skillKey, strand, repetition] of [
        [ADD_STRAND[1], "add", 9],
        ["unit_fraction", "mult", 9],
      ] as const) {
        await ctx.db.insert("practiceMastery", {
          scholarId: scholar,
          skillKey,
          domain: PLACEMENT_TEST_DOMAIN,
          strand,
          repetition,
          halfLifeDays: 100,
          lastPracticedAt: NOW,
          frontier: false,
          source: "practice",
          updatedAt: NOW,
        });
      }
      for (const offset of [2, 1]) {
        await ctx.db.insert("practiceAttempts", {
          scholarId: scholar,
          nodeKey: ADD_STRAND[0],
          itemId: makeItemId(ADD_STRAND[0], offset + 10),
          correct: false,
          domain: PLACEMENT_TEST_DOMAIN,
          lane: "frontier",
          createdAt: NOW - offset,
        });
      }
      const triggerAttemptId = await ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: ADD_STRAND[0],
        itemId: makeItemId(ADD_STRAND[0], 1),
        correct: false,
        domain: PLACEMENT_TEST_DOMAIN,
        lane: "frontier",
        createdAt: NOW,
        breakerLifecycle: {
          version: 2,
          triggerNodeKey: ADD_STRAND[0],
          triggeredAt: NOW,
        },
      });
      return { planId, triggerAttemptId };
    });

    // The plan changes while the repair card is open. The old broad-mastery
    // preference is add_within_5, but tap-time scope permits only multiplication.
    await t.run((ctx) =>
      ctx.db.patch(planId, {
        practiceScope: {
          kind: "limited",
          domains: [{ domain: PLACEMENT_TEST_DOMAIN, strands: ["mult"] }],
        },
        updatedAt: NOW + 1,
      }),
    );
    const first = await asScholar.mutation(api.practiceSkills.breakerEasyFinishSession, {
      scholarId: scholar,
      triggerAttemptId,
      seed: 11,
    });
    expect(first.available).toBe(true);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      skillKey: "unit_fraction",
      answerShape: "twoD",
    });
    expect(first.items[0]).not.toHaveProperty("answerFormat");

    // A dropped response/retry cannot draw a different close-out item.
    const retry = await asScholar.mutation(api.practiceSkills.breakerEasyFinishSession, {
      scholarId: scholar,
      triggerAttemptId,
      seed: 99,
    });
    expect(retry).toEqual(first);
    const trigger = await t.run((ctx) => ctx.db.get(triggerAttemptId));
    expect(trigger?.breakerLifecycle?.easyItemId).toBe(first.items[0]?.itemId);
    expect(trigger?.breakerLifecycle?.easyDomain).toBe(PLACEMENT_TEST_DOMAIN);
  });

  test("returns a pinned unavailable result when no in-scope mastery is runnable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t, "scoped-easy-unavailable");
    const asScholar = await asUser(t, scholar);
    const triggerAttemptId = await t.run(async (ctx) => {
      await ctx.db.insert("scholarMathPlans", {
        scholarId: scholar,
        practiceScope: {
          kind: "limited",
          domains: [{ domain: PLACEMENT_TEST_DOMAIN, strands: ["mult"] }],
        },
        updatedBy: scholar,
        updatedAt: NOW,
      });
      await ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: ADD_STRAND[1],
        domain: PLACEMENT_TEST_DOMAIN,
        strand: "add",
        repetition: 9,
        halfLifeDays: 100,
        lastPracticedAt: NOW,
        frontier: false,
        source: "practice",
        updatedAt: NOW,
      });
      for (const offset of [2, 1]) {
        await ctx.db.insert("practiceAttempts", {
          scholarId: scholar,
          nodeKey: ADD_STRAND[0],
          itemId: makeItemId(ADD_STRAND[0], offset + 20),
          correct: false,
          domain: PLACEMENT_TEST_DOMAIN,
          lane: "frontier",
          createdAt: NOW - offset,
        });
      }
      return await ctx.db.insert("practiceAttempts", {
        scholarId: scholar,
        nodeKey: ADD_STRAND[0],
        itemId: makeItemId(ADD_STRAND[0], 2),
        correct: false,
        domain: PLACEMENT_TEST_DOMAIN,
        lane: "frontier",
        createdAt: NOW,
        breakerLifecycle: {
          version: 2,
          triggerNodeKey: ADD_STRAND[0],
          triggeredAt: NOW,
        },
      });
    });

    const unavailable = await asScholar.mutation(api.practiceSkills.breakerEasyFinishSession, {
      scholarId: scholar,
      triggerAttemptId,
      seed: 1,
    });
    expect(unavailable).toMatchObject({ available: false, items: [] });
    const replay = await asScholar.mutation(api.practiceSkills.breakerEasyFinishSession, {
      scholarId: scholar,
      triggerAttemptId,
      seed: 2,
    });
    expect(replay).toEqual(unavailable);
  });

  test("returns blocked rather than falling back for an explicitly out-of-scope domain or domain list", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t, "limited-domain-scholar");
    const asScholar = await asUser(t, scholar);
    await limitToMultiplication(t, scholar);

    const direct = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      domain: "outside-practice-scope",
      seed: 1,
    });
    const mixed = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      domains: [PLACEMENT_TEST_DOMAIN, "outside-practice-scope"],
      seed: 2,
    });
    expect("blocked" in direct && direct.blocked).toBe(true);
    expect("blocked" in mixed && mixed.blocked).toBe(true);
    expect([...direct.items, ...mixed.items]).toEqual([]);
  });

  test("suspends an out-of-scope checkpoint instead of letting it steer", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t, "limited-checkpoint-scholar");
    const asScholar = await asUser(t, scholar);
    await limitToMultiplication(t, scholar);
    await t.run(async (ctx) => {
      const groupId = await ctx.db.insert("scholarGroups", {
        teacherId: scholar,
        name: "Checkpoint group",
        scholarIds: [scholar],
      });
      await ctx.db.insert("mathGroupCheckpoint", {
        groupId,
        domain: PLACEMENT_TEST_DOMAIN,
        strand: "add",
        grade: "3",
        updatedBy: scholar,
        updatedAt: Date.now(),
      });
    });

    expect(await asScholar.query(api.mathFocus.myMathCheckpoint, {})).toBeNull();
  });
});

type V2Kind = "correct" | "incorrect" | "unknown";

/**
 * Drive the placement-v2 loop to completion: PRIME (submit with no answer), then
 * grade one probe at a time, choosing each outcome via `kindFor(skillKey)`, until
 * the server reports `done`. Mirrors how the real client drives it.
 */
async function runV2Placement(
  asScholar: Awaited<ReturnType<typeof asUser>>,
  scholarId: Id<"users">,
  domain: string | undefined,
  kindFor: (skillKey: string) => V2Kind,
  seed = 11,
) {
  const base = { scholarId, seed, ...(domain ? { domain } : {}) };
  let cur = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, base);
  const served: { itemId: string; skillKey: string; strand: string }[] = [];
  for (let i = 0; i < 60 && !cur.done && cur.probe; i++) {
    const probe = cur.probe;
    served.push({ itemId: probe.itemId, skillKey: probe.skillKey, strand: probe.strand });
    const kind = kindFor(probe.skillKey);
    const extra =
      kind === "unknown"
        ? { itemId: probe.itemId, answer: "", dontKnow: true }
        : {
            itemId: probe.itemId,
            answer: kind === "correct" ? (gradeTemplateItem(probe.itemId, "0")?.correctAnswer ?? "0") : "-999999",
          };
    cur = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, { ...base, ...extra });
  }
  return { cur, served };
}

async function masteryByKey(t: ReturnType<typeof convexTest>, scholarId: Id<"users">, domain: string) {
  const rows = await t.run(async (ctx) => {
    const all = await ctx.db.query("practiceMastery").collect();
    return all.filter((r) => r.scholarId === scholarId && r.domain === domain);
  });
  return new Map(rows.map((r) => [r.skillKey, r]));
}

describe("practiceSkills — Phase 2 scheduler evidence", () => {
  const oldPracticeAt = () => Date.now() - 20 * 86_400_000;

  async function insertMastery(
    t: ReturnType<typeof convexTest>,
    scholar: Id<"users">,
    skillKey: string,
    overrides: Partial<Doc<"practiceMastery">> = {},
  ) {
    const now = oldPracticeAt();
    return t.run(async (ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey,
        domain: PLACEMENT_TEST_DOMAIN,
        strand: skillKey.startsWith("mult") || skillKey.startsWith("skip") ? "mult" : "add",
        repetition: overrides.repetition ?? 2,
        halfLifeDays: overrides.halfLifeDays ?? 4,
        lastPracticedAt: overrides.lastPracticedAt ?? now,
        frontier: overrides.frontier ?? false,
        source: overrides.source ?? "practice",
        updatedAt: overrides.updatedAt ?? now,
        ...(overrides.lastAttemptAt !== undefined ? { lastAttemptAt: overrides.lastAttemptAt } : {}),
        ...(overrides.accelStreak !== undefined ? { accelStreak: overrides.accelStreak } : {}),
        ...(overrides.latencyMedianMs !== undefined ? { latencyMedianMs: overrides.latencyMedianMs } : {}),
        ...(overrides.latencySamplesMs !== undefined ? { latencySamplesMs: overrides.latencySamplesMs } : {}),
      }),
    );
  }

  async function readMastery(
    t: ReturnType<typeof convexTest>,
    scholar: Id<"users">,
    skillKey: string,
  ) {
    const rows = await t.run(async (ctx) => ctx.db.query("practiceMastery").collect());
    return rows.find(
      (row) =>
        row.scholarId === scholar &&
        row.skillKey === skillKey &&
        row.domain === PLACEMENT_TEST_DOMAIN,
    ) ?? null;
  }

  test("implicit credit still flows when a prerequisite has no struggle signals", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    await insertMastery(t, scholar, "add_within_5", { halfLifeDays: 4 });

    await t.mutation(internal.practiceSkills.recordAttemptInternal, {
      scholarId: scholar,
      domain: PLACEMENT_TEST_DOMAIN,
      skillKey: "add_within_10",
      correct: true,
    });

    const row = await readMastery(t, scholar, "add_within_5");
    expect(row?.halfLifeDays).toBeGreaterThan(4);
    expect(row?.lastImplicitAt).toBeTruthy();
    expect(row?.implicitCount).toBe(1);
  });

  test("implicit credit is skipped when the prereq's last real attempt was a miss", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    // Resident struggle signal: an honest attempt stamp with accelStreak reset to
    // 0 is exactly the shape recordAttemptCore leaves after a miss.
    await insertMastery(t, scholar, "add_within_5", {
      halfLifeDays: 4,
      lastAttemptAt: Date.now() - 1_000,
      accelStreak: 0,
    });

    await t.mutation(internal.practiceSkills.recordAttemptInternal, {
      scholarId: scholar,
      domain: PLACEMENT_TEST_DOMAIN,
      skillKey: "add_within_10",
      correct: true,
    });

    const row = await readMastery(t, scholar, "add_within_5");
    expect(row?.halfLifeDays).toBe(4);
    expect(row?.lastImplicitAt).toBeUndefined();
    expect(row?.implicitCount).toBeUndefined();
  });

  test("implicit credit is skipped when the prereq's last-attempt latency is above 2x baseline", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    // A correct-but-slow last attempt (accelStreak >= 1 so the miss leg is inert):
    // its resident median latency is above 2x the scholar's cross-skill baseline.
    await insertMastery(t, scholar, "add_within_5", {
      halfLifeDays: 4,
      lastAttemptAt: Date.now() - 1_000,
      accelStreak: 1,
      latencyMedianMs: 2_501,
      latencySamplesMs: [2_501],
    });
    for (const key of ["count_to_10", "skip_count_2s_5s_10s", "mult_facts_0_1_2_5_10"]) {
      await insertMastery(t, scholar, key, {
        halfLifeDays: 4,
        latencyMedianMs: 1_000,
        latencySamplesMs: [1_000],
      });
    }

    await t.mutation(internal.practiceSkills.recordAttemptInternal, {
      scholarId: scholar,
      domain: PLACEMENT_TEST_DOMAIN,
      skillKey: "add_within_10",
      correct: true,
    });

    const row = await readMastery(t, scholar, "add_within_5");
    expect(row?.halfLifeDays).toBe(4);
    expect(row?.lastImplicitAt).toBeUndefined();
  });

  test("a miss halves one-hop inferred dependent half-life without reducing reps", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    await insertMastery(t, scholar, "add_within_5", {
      repetition: FLUENT_REPS_VALUE,
      halfLifeDays: 10,
      source: "placement",
    });

    await t.mutation(internal.practiceSkills.recordAttemptInternal, {
      scholarId: scholar,
      domain: PLACEMENT_TEST_DOMAIN,
      skillKey: "count_to_10",
      correct: false,
    });

    const row = await readMastery(t, scholar, "add_within_5");
    expect(row?.halfLifeDays).toBe(5);
    expect(row?.repetition).toBe(FLUENT_REPS_VALUE);
    expect(row?.source).toBe("placement");
  });

  test("upward negative evidence skips demonstrated, attempted, and multi-hop rows", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    const attemptedAt = Date.now() - 5_000;
    await insertMastery(t, scholar, "add_within_5", {
      repetition: FLUENT_REPS_VALUE,
      halfLifeDays: 10,
      source: "practice",
    });
    await insertMastery(t, scholar, "add_within_10", {
      repetition: FLUENT_REPS_VALUE,
      halfLifeDays: 10,
      source: "placement",
    });
    await insertMastery(t, scholar, "mult_facts_0_1_2_5_10", {
      repetition: FLUENT_REPS_VALUE,
      halfLifeDays: 10,
      source: "placement",
      lastAttemptAt: attemptedAt,
    });

    await t.mutation(internal.practiceSkills.recordAttemptInternal, {
      scholarId: scholar,
      domain: PLACEMENT_TEST_DOMAIN,
      skillKey: "count_to_10",
      correct: false,
    });
    await t.mutation(internal.practiceSkills.recordAttemptInternal, {
      scholarId: scholar,
      domain: PLACEMENT_TEST_DOMAIN,
      skillKey: "skip_count_2s_5s_10s",
      correct: false,
    });

    const demonstrated = await readMastery(t, scholar, "add_within_5");
    const multiHop = await readMastery(t, scholar, "add_within_10");
    const attempted = await readMastery(t, scholar, "mult_facts_0_1_2_5_10");
    expect(demonstrated?.halfLifeDays).toBe(10);
    expect(demonstrated?.repetition).toBe(FLUENT_REPS_VALUE);
    expect(multiHop?.halfLifeDays).toBe(10);
    expect(multiHop?.repetition).toBe(FLUENT_REPS_VALUE);
    expect(attempted?.halfLifeDays).toBe(10);
    expect(attempted?.lastAttemptAt).toBe(attemptedAt);
  });
});

describe("practiceSkills — placement flow", () => {
  test("needsPlacement remains true for shadow mastery and flips only after a converged run", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    expect(await asScholar.query(api.practiceSkills.needsPlacement, { scholarId: scholar })).toBe(true);

    // The legacy helper writes mastery without a placement row. That is useful
    // fixture state, but it is not evidence that the domain was mapped.
    await t.mutation(internal.practiceSkills.placeScholarInternal, { scholarId: scholar, throughGrade: "3" });
    expect(await asScholar.query(api.practiceSkills.needsPlacement, { scholarId: scholar })).toBe(true);

    await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, { scholarId: scholar, seed: 1 });
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("practicePlacements").collect()).find(
        (placement) =>
          placement.scholarId === scholar &&
          placement.domain === "whole-number-arithmetic",
      )!;
      await ctx.db.patch(row._id, { status: "complete", servedProbe: undefined });
    });
    expect(await asScholar.query(api.practiceSkills.needsPlacement, { scholarId: scholar })).toBe(false);
  });

  test("adaptive search converges in few probes (~3-4 per strand)", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    // Fluent everywhere: each strand's search should still terminate quickly and
    // credit the whole strand (no frontier node left).
    const { cur, served } = await runV2Placement(asScholar, scholar, PLACEMENT_TEST_DOMAIN, () => "correct");
    expect(cur.done).toBe(true);
    // 2 strands, ≤5 probes each (MAX_PROBES_PER_STRAND) → generously bounded.
    expect(served.length).toBeLessThanOrEqual(10);
    // A fully-fluent 5-node + 4-node domain: whole thing credited, no frontier rows.
    const mastery = await masteryByKey(t, scholar, PLACEMENT_TEST_DOMAIN);
    for (const key of [...ADD_STRAND, ...MULT_STRAND]) {
      expect(mastery.get(key)?.repetition, `credited ${key}`).toBe(FLUENT_REPS_VALUE);
      expect(mastery.get(key)?.halfLifeDays).toBe(4);
    }
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("practicePlacements")
        .withIndex("by_scholar_domain", (q) =>
          q.eq("scholarId", scholar).eq("domain", PLACEMENT_TEST_DOMAIN),
        )
        .first(),
    );
    expect(row?.status).toBe("complete");
    expect(row?.frontierByStrand).toHaveLength(0);
  });

  test("mid-flight pause keeps needsPlacement true; finishing flips it false", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const base = { scholarId: scholar, seed: 5, domain: PLACEMENT_TEST_DOMAIN };

    // Answer ONE probe, then walk away (a paused diagnostic).
    const primed = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, base);
    await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, {
      ...base,
      itemId: primed.probe!.itemId,
      answer: gradeTemplateItem(primed.probe!.itemId, "0")?.correctAnswer ?? "0",
    });

    // Progress persisted (probeLog), but NO mastery seeded yet.
    const rowMid = await t.run(async (ctx) =>
      ctx.db
        .query("practicePlacements")
        .withIndex("by_scholar_domain", (q) =>
          q.eq("scholarId", scholar).eq("domain", PLACEMENT_TEST_DOMAIN),
        )
        .first(),
    );
    expect(rowMid?.status).toBe("in_progress");
    expect(rowMid?.probeLog).toHaveLength(1);
    expect((await masteryByKey(t, scholar, PLACEMENT_TEST_DOMAIN)).size).toBe(0);
    expect(
      await asScholar.query(api.practiceSkills.needsPlacement, {
        scholarId: scholar,
        domain: PLACEMENT_TEST_DOMAIN,
      }),
    ).toBe(true);

    // Finish it (all fluent) — mastery seeds, placement completes.
    const { cur } = await runV2Placement(asScholar, scholar, PLACEMENT_TEST_DOMAIN, () => "correct", 5);
    expect(cur.done).toBe(true);
    expect(
      await asScholar.query(api.practiceSkills.needsPlacement, {
        scholarId: scholar,
        domain: PLACEMENT_TEST_DOMAIN,
      }),
    ).toBe(false);
  });

  test("real multi-strand domain: all-correct converges and credits with short half-life", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    // The seeded whole-number-arithmetic graph now carries 5 strands (counting,
    // place-value, add-subtract, mult-divide, number-theory) → one independent
    // binary search per strand. All-correct credits the foundational nodes in
    // every strand at the short trust-upward half-life.
    const { cur } = await runV2Placement(asScholar, scholar, undefined, () => "correct");
    expect(cur.done).toBe(true);
    const mastery = await masteryByKey(t, scholar, "whole-number-arithmetic");
    expect(mastery.get("count_to_10")?.repetition).toBe(FLUENT_REPS_VALUE);
    expect(mastery.get("count_to_10")?.halfLifeDays).toBe(4);
    expect(mastery.get("count_to_10")?.source).toBe("placement");
  });

  test("submitPlacementAnswer is guarded by a CONVERGED run, not by mastery existence", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    // The legacy grade-anchored path writes mastery and NO placement row, so the
    // domain is SHADOW-PLACED: since finish-the-check-in (founder 2026-08-18)
    // that is unmapped, and placement opens rather than refusing. Mastery is not
    // a map — the guard that used to fire here was the shadow-placement hole.
    await t.mutation(internal.practiceSkills.placeScholarInternal, { scholarId: scholar, throughGrade: "2" });
    const opened = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, { scholarId: scholar, seed: 1 });
    expect(opened.alreadyPlaced).toBe(false);
    expect(opened.probe).not.toBeNull();

    // Once a run has actually CONVERGED, the loop is idempotent again.
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("practicePlacements").collect()).find(
        (r) => r.scholarId === scholar && r.domain === "whole-number-arithmetic",
      )!;
      await ctx.db.patch(row._id, { status: "complete", servedProbe: undefined });
    });
    const res = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, { scholarId: scholar, seed: 1 });
    expect(res.alreadyPlaced).toBe(true);
    expect(res.done).toBe(true);
  });
});

// ── Placement v2 — the server-authoritative one-item-at-a-time loop ──────────

describe("practiceSkills — placement v2 (server-authoritative loop)", () => {
  test("round-robin: serves probes interleaved across strands, never grinding one", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    const { served } = await runV2Placement(asScholar, scholar, PLACEMENT_TEST_DOMAIN, () => "correct");
    // The first two served probes come from DIFFERENT strands (least-answered
    // round-robin), so a kid never grinds one topic to the bottom first.
    expect(served.length).toBeGreaterThanOrEqual(2);
    expect(served[0].strand).not.toBe(served[1].strand);
    // Both strands got served.
    expect(new Set(served.map((s) => s.strand))).toEqual(new Set(["add", "mult"]));
  });

  test("submitPlacementAnswer writes one placement-lane practiceAttempts row", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const base = { scholarId: scholar, seed: 5, domain: PLACEMENT_TEST_DOMAIN };

    const primed = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, base);
    const probe = primed.probe!;
    await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, {
      ...base,
      itemId: probe.itemId,
      answer: gradeTemplateItem(probe.itemId, "0")?.correctAnswer ?? "0",
    });

    const attempts = await t.run(async (ctx) => ctx.db.query("practiceAttempts").collect());
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      scholarId: scholar,
      nodeKey: probe.skillKey,
      domain: PLACEMENT_TEST_DOMAIN,
      strand: probe.strand,
      itemId: probe.itemId,
      lane: "placement",
      correct: true,
      repetitionBefore: 0,
      source: "placement",
    });
    expect(attempts[0].predictedRetention).toBeUndefined();
    expect(attempts[0].halfLifeBefore).toBeUndefined();
  });

  test("submitPlacementAnswer on a MISS also snapshots stem + expected answer (Option 2)", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const base = { scholarId: scholar, seed: 5, domain: PLACEMENT_TEST_DOMAIN };

    const primed = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, base);
    const probe = primed.probe!;
    const truth = gradeTemplateItem(probe.itemId, "0")!;
    await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, {
      ...base,
      itemId: probe.itemId,
      answer: "-999999",
    });

    const attempts = await t.run(async (ctx) => ctx.db.query("practiceAttempts").collect());
    expect(attempts).toHaveLength(1);
    expect(attempts[0].correct).toBe(false);
    expect(attempts[0].stemSnapshot).toBe(truth.stem);
    expect(attempts[0].expectedAnswer).toBe(truth.correctAnswer);
  });

  test("resumable: a re-prime (no answer) re-serves the SAME item; a fresh prime after answering advances", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const base = { scholarId: scholar, seed: 5, domain: PLACEMENT_TEST_DOMAIN };

    const primed = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, base);
    expect(primed.probe).toBeTruthy();
    const firstItemId = primed.probe!.itemId;

    // Re-prime (simulating a reload with no in-memory state) → SAME item.
    const reprimed = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, base);
    expect(reprimed.probe?.itemId).toBe(firstItemId);
    // The read-only query agrees.
    const cur = await asScholar.query(api.practiceSkills.placementCurrent, {
      scholarId: scholar,
      domain: PLACEMENT_TEST_DOMAIN,
    });
    expect(cur.probe?.itemId).toBe(firstItemId);
    expect(cur.maxQuestions).toBe(9);

    // Answer it → the next probe is a DIFFERENT item.
    const graded = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, {
      ...base,
      itemId: firstItemId,
      answer: gradeTemplateItem(firstItemId, "0")?.correctAnswer ?? "0",
    });
    expect(graded.probe?.itemId).not.toBe(firstItemId);
  });

  test("placementCurrent on a COMPLETE row reports done + the placed-through grade (boot→result, not intro)", async () => {
    // Regression for the web bug where finishing placement (or a remount over a
    // completed one) dropped the scholar back to the intro: the client's `boot`
    // phase reads placementCurrent, and if a done row returned no grade it could
    // only route to intro. placementCurrent must report done:true AND re-derive the
    // placed-through grade so the boot phase paints the RESULT screen instead.
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    // Tag every node grade "2" so the credited set derives a real grade.
    await t.run(async (ctx) => {
      const nodes = await ctx.db
        .query("knowledgeNodes")
        .withIndex("by_domain", (q) => q.eq("domain", PLACEMENT_TEST_DOMAIN))
        .collect();
      for (const n of nodes) await ctx.db.patch(n._id, { grade: "2" });
    });
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    // Fluent everywhere → the whole domain is credited (no frontier left).
    const { cur } = await runV2Placement(asScholar, scholar, PLACEMENT_TEST_DOMAIN, () => "correct");
    expect(cur.done).toBe(true);

    // The read-only query a remount/reload boots against: done + the grade.
    const done = await asScholar.query(api.practiceSkills.placementCurrent, {
      scholarId: scholar,
      domain: PLACEMENT_TEST_DOMAIN,
    });
    expect(done.done).toBe(true);
    expect(done.probe).toBeNull();
    expect(done.placedThroughGrade).toBe("2");
    // J3: a fluent-everywhere scholar has NO frontier left, so there's no skill to
    // name — the surface falls back to a warm, numberless line (never "Grade 2").
    expect(done.startingSkillLabel).toBeNull();
  });

  test("placementCurrent carries a null placedThroughGrade while still in progress", async () => {
    // The field is present (and null) on the non-done branches too, so the client
    // type is uniform and a served-probe boot never reads undefined.
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const base = { scholarId: scholar, seed: 5, domain: PLACEMENT_TEST_DOMAIN };
    await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, base); // prime one probe
    const cur = await asScholar.query(api.practiceSkills.placementCurrent, {
      scholarId: scholar,
      domain: PLACEMENT_TEST_DOMAIN,
    });
    expect(cur.done).toBe(false);
    expect(cur.probe).toBeTruthy();
    expect(cur.placedThroughGrade).toBeNull();
    expect(cur.startingSkillLabel).toBeNull();
  });

  test("per-strand independence + finalize crediting (strong add, weak mult)", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    // Strong add, weak mult — each strand must place at its OWN frontier, and the
    // finalize crediting must honor the two-axis invariant (short half-life,
    // source "placement", frontier seeds, no rows above).
    const fluent = new Set([
      "count_to_10",
      "add_within_5",
      "add_within_10",
      "add_within_20_regroup",
      "skip_count_2s_5s_10s",
    ]);
    const { cur } = await runV2Placement(asScholar, scholar, PLACEMENT_TEST_DOMAIN, (k) =>
      fluent.has(k) ? "correct" : "incorrect",
    );
    expect(cur.done).toBe(true);
    expect(cur.alreadyPlaced).toBe(false);

    const mastery = await masteryByKey(t, scholar, PLACEMENT_TEST_DOMAIN);
    // Add strand credited 0..3 fluent (short half-life, source placement); frontier at add_2digit_regroup.
    for (const key of ["count_to_10", "add_within_5", "add_within_10", "add_within_20_regroup"]) {
      expect(mastery.get(key)?.repetition, key).toBe(FLUENT_REPS_VALUE);
      expect(mastery.get(key)?.halfLifeDays).toBe(4);
      expect(mastery.get(key)?.source).toBe("placement");
    }
    expect(mastery.get("add_2digit_regroup")?.repetition).toBe(0);
    expect(mastery.get("add_2digit_regroup")?.frontier).toBe(true);
    // Mult strand: only skip_count credited; frontier at mult_facts_0_1_2_5_10; deeper nodes no row.
    expect(mastery.get("skip_count_2s_5s_10s")?.repetition).toBe(FLUENT_REPS_VALUE);
    expect(mastery.get("mult_facts_0_1_2_5_10")?.frontier).toBe(true);
    expect(mastery.get("mult_facts_3_4_6")).toBeUndefined();

    // J3: the scholar-facing end anchor is the SKILL label of a leading frontier
    // (one of the `frontier: true` "you are here" nodes), never a grade. With no
    // grade tags here the furthest-frontier tie-break is deterministic by skillKey.
    expect(cur.startingSkillLabel).toBe("add_2digit_regroup");
    expect(cur.startingSkillLabel).not.toMatch(/grade/i);
  });

  test("'don't know' credits nothing (caps the ceiling like a miss)", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    const { cur } = await runV2Placement(asScholar, scholar, PLACEMENT_TEST_DOMAIN, () => "unknown");
    expect(cur.done).toBe(true);
    const mastery = await masteryByKey(t, scholar, PLACEMENT_TEST_DOMAIN);
    // Nothing credited fluent — every strand's frontier is its first node.
    const credited = [...mastery.values()].filter((r) => r.repetition >= FLUENT_REPS_VALUE);
    expect(credited).toHaveLength(0);
    expect(mastery.get("count_to_10")?.frontier).toBe(true);
    expect(mastery.get("skip_count_2s_5s_10s")?.frontier).toBe(true);
  });

  test("affect-safe first probe: a graded scholar's first probe is NOT the strand's foundational node", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    // Grade-3 scholar: the add strand's grade tags climb, so the first probe
    // should anchor above count_to_10 (index 0) rather than starting at the floor.
    const scholar = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "G3", username: "g3sch", role: "scholar", gradeLevel: "3" }),
    );
    // Tag the add-strand nodes with climbing grades so the anchor has something to read.
    await t.run(async (ctx) => {
      const gradeByKey: Record<string, string> = {
        count_to_10: "K",
        add_within_5: "1",
        add_within_10: "1",
        add_within_20_regroup: "2",
        add_2digit_regroup: "3",
      };
      for (const [k, g] of Object.entries(gradeByKey)) {
        const node = await ctx.db
          .query("knowledgeNodes")
          .withIndex("by_nodeKey", (q) => q.eq("nodeKey", k))
          .first();
        if (node) await ctx.db.patch(node._id, { grade: g });
      }
    });
    const asScholar = await asUser(t, scholar);
    const primed = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, {
      scholarId: scholar,
      seed: 7,
      domain: PLACEMENT_TEST_DOMAIN,
    });
    // First served probe overall is add (strand order); with grade 3 it should be
    // above the foundational count_to_10.
    const first = primed.probe;
    if (first?.strand === "add") expect(first.skillKey).not.toBe("count_to_10");
  });

  test("global cap: never exceeds PLACEMENT_GLOBAL_CAP probes", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const { served, cur } = await runV2Placement(asScholar, scholar, undefined, () => "correct");
    expect(cur.done).toBe(true);
    expect(served.length).toBeLessThanOrEqual(PLACEMENT_GLOBAL_CAP);
  });

  test("PRIME with nothing probeable FINALIZES (never strands an in_progress row)", async () => {
    const t = convexTest(schema, modules);
    // A domain whose nodes have NO templates → nothing probeable → the very
    // first prime must finalize, not loop the scholar back into placement.
    const domain = "placement-test-untemplated";
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert("knowledgeNodes", {
          nodeKey: `untemplated_node_${i}`,
          label: `Untemplated ${i}`,
          domain,
          strand: "only",
          order: i,
          source: "practice",
        });
      }
    });
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    const res = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, {
      scholarId: scholar,
      seed: 3,
      domain,
    });
    expect(res.done).toBe(true);
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("practicePlacements")
        .withIndex("by_scholar_domain", (q) => q.eq("scholarId", scholar).eq("domain", domain))
        .first(),
    );
    expect(row?.status).toBe("complete");
    // Mastery seeded (the strand's frontier node at floor 0), so the scholar no
    // longer needs placement — no bounce-back.
    expect(
      await asScholar.query(api.practiceSkills.needsPlacement, { scholarId: scholar, domain }),
    ).toBe(false);
  });

  test("staleness guard: a grade whose itemId ≠ the served probe is an idempotent no-op", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const base = { scholarId: scholar, seed: 9, domain: PLACEMENT_TEST_DOMAIN };

    const primed = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, base);
    const servedId = primed.probe!.itemId;

    // A stale/duplicate submit (wrong itemId — e.g. a network retry after the
    // server already advanced): nothing graded, nothing logged, current probe back.
    const stale = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, {
      ...base,
      itemId: "count_to_10#123456", // not the served item
      answer: "5",
    });
    expect(stale.graded).toBeNull();
    expect(stale.done).toBe(false);
    expect(stale.probe?.itemId).toBe(servedId);
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("practicePlacements")
        .withIndex("by_scholar_domain", (q) =>
          q.eq("scholarId", scholar).eq("domain", PLACEMENT_TEST_DOMAIN),
        )
        .first(),
    );
    expect(row?.probeLog ?? []).toHaveLength(0);

    // The REAL submit still grades normally afterwards.
    const real = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, {
      ...base,
      itemId: servedId,
      answer: gradeTemplateItem(servedId, "0")?.correctAnswer ?? "0",
    });
    expect(real.graded?.outcome).toBe("correct");
  });
});

describe("practiceSkills — don't-know in drills", () => {
  test("records a miss, flagged distinctly, no answer reveal, no error classification", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    // Seed a mastery row so the miss is observable as a shrink (a fresh insert
    // starts at reps 0 either way; here we just prove reps don't advance).
    const itemId = makeItemId("count_to_10", 424242);
    const res = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer: "",
      dontKnow: true,
    });
    expect(res.correct).toBe(false);
    expect(res.dontKnow).toBe(true);
    expect(res.correctAnswer).toBeUndefined(); // drills keep withholding the answer
    expect(res.repetition).toBe(0); // a miss never advances reps

    // No error-pattern classification for an honest don't-know.
    const errors = await t.run(async (ctx) =>
      ctx.db
        .query("practiceErrorEvents")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholar))
        .collect(),
    );
    expect(errors).toHaveLength(0);

    // It DID record an attempt (the SR clock moved).
    const row = await t.run(async (ctx) =>
      ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar_skill", (q) => q.eq("scholarId", scholar).eq("skillKey", "count_to_10"))
        .first(),
    );
    expect(row?.lastAttemptAt).toBeTruthy();
  });
});

describe("practiceSkills — excludedStrands enforcement (standing practice)", () => {
  // A standing assignment's practiceConfig.excludedStrands is threaded through
  // practiceSession → nextPractice; an excluded strand's items must never be
  // served. Uses the controlled two-strand domain (add / mult).
  const MULT_KEYS = new Set(MULT_STRAND);

  test("practiceSession never serves an item from an excluded strand", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    // Fresh scholar: the frontier is count_to_10 (add) + skip_count_2s_5s_10s
    // (mult). Excluding "mult" must leave only add-strand items.
    const session = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      size: 12,
      seed: 99,
      domain: PLACEMENT_TEST_DOMAIN,
      excludedStrands: ["mult"],
    });
    expect(session.items.length).toBeGreaterThan(0);
    expect(session.items.every((it) => !MULT_KEYS.has(it.skillKey))).toBe(true);
  });

  test("without exclusion both strands can be served (control)", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    const session = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      size: 12,
      seed: 99,
      domain: PLACEMENT_TEST_DOMAIN,
    });
    // The mult strand's frontier root is reachable when nothing is excluded.
    expect(session.items.some((it) => MULT_KEYS.has(it.skillKey))).toBe(true);
  });

  test("nextForScholar drops excluded-strand skills from the queue", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    const queue = await asScholar.query(api.practiceSkills.nextForScholar, {
      scholarId: scholar,
      domain: PLACEMENT_TEST_DOMAIN,
      limit: 10,
      excludedStrands: ["mult"],
    });
    expect(queue.length).toBeGreaterThan(0);
    expect(queue.every((q) => q.strand !== "mult")).toBe(true);
    expect(queue.every((q) => !MULT_KEYS.has(q.key))).toBe(true);
  });

  test("a due review in an excluded strand is still withheld", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    // Make a mult-strand skill fluent-but-decayed (a due review) and an
    // add-strand skill likewise. Excluding mult must withhold the mult review.
    const longAgo = Date.now() - 90 * 86_400_000;
    await t.run(async (ctx) => {
      for (const [key, strand] of [
        ["mult_facts_0_1_2_5_10", "mult"],
        ["add_within_5", "add"],
      ] as const) {
        await ctx.db.insert("practiceMastery", {
          scholarId: scholar,
          domain: PLACEMENT_TEST_DOMAIN,
          skillKey: key,
          strand,
          repetition: 4,
          halfLifeDays: 5,
          lastPracticedAt: longAgo,
          frontier: false,
          source: "practice",
          updatedAt: longAgo,
        });
      }
    });

    const queue = await asScholar.query(api.practiceSkills.nextForScholar, {
      scholarId: scholar,
      domain: PLACEMENT_TEST_DOMAIN,
      limit: 10,
      excludedStrands: ["mult"],
    });
    // The add review surfaces; the mult review is withheld entirely.
    expect(queue.some((q) => q.key === "add_within_5" && q.reason === "review")).toBe(true);
    expect(queue.every((q) => q.key !== "mult_facts_0_1_2_5_10")).toBe(true);
  });
});

describe("acceleration valve (B1) — end-to-end streak-jump", () => {
  const DOMAIN = "whole-number-arithmetic";

  // Give the scholar a personal latency baseline (≥3 skills with a reading) so
  // the valve's self-relative "fast" gate can fire, and prime count_to_10 (a
  // no-prereq frontier node) to reps 1 / streak 1 so the NEXT clean fast correct
  // is the 2nd of the streak.
  async function primeValve(
    t: ReturnType<typeof convexTest>,
    scholar: Id<"users">,
    opts: { withBaseline: boolean },
  ) {
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("practiceMastery", {
        scholarId: scholar, skillKey: "count_to_10", domain: DOMAIN, strand: "counting",
        repetition: 1, halfLifeDays: 2.3, lastPracticedAt: now, frontier: true,
        source: "practice", accelStreak: 1, updatedAt: now,
        ...(opts.withBaseline ? { latencyMedianMs: 5000, latencySamplesMs: [5000] } : {}),
      });
      if (opts.withBaseline) {
        for (const k of ["count_to_20", "count_to_100_ones", "add_within_5"]) {
          await ctx.db.insert("practiceMastery", {
            scholarId: scholar, skillKey: k, domain: DOMAIN, repetition: 1, halfLifeDays: 2.3,
            lastPracticedAt: now, frontier: false, source: "practice",
            latencyMedianMs: 5000, latencySamplesMs: [5000], updatedAt: now,
          });
        }
      }
    });
  }

  async function submitCount10(t: ReturnType<typeof convexTest>, scholar: Id<"users">, firstKeyMs: number) {
    const asScholar = await asUser(t, scholar);
    const itemId = makeItemId("count_to_10", 12345);
    const answer = gradeTemplateItem(itemId, "0")!.correctAnswer;
    return asScholar.mutation(api.practiceSkills.submitAnswer, { scholarId: scholar, itemId, answer, firstKeyMs });
  }

  async function count10Row(t: ReturnType<typeof convexTest>, scholar: Id<"users">) {
    return t.run(async (ctx) => {
      const rows = await ctx.db.query("practiceMastery").collect();
      return rows.find((r) => r.scholarId === scholar && r.skillKey === "count_to_10") ?? null;
    });
  }

  test("a fast 2nd clean correct at a frontier node jumps to fluent (source accelerated)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    await primeValve(t, scholar, { withBaseline: true });

    const res = await submitCount10(t, scholar, 1000); // 1000ms ≤ 5000 baseline ⇒ fast
    expect(res.correct).toBe(true);

    const row = await count10Row(t, scholar);
    expect(row?.repetition).toBe(FLUENT_REPS_VALUE); // jumped, not merely 2
    expect(row?.source).toBe("accelerated");
  });

  test("does NOT jump without a personal baseline (a fresh kid keeps the full rep count)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    await primeValve(t, scholar, { withBaseline: false });

    const res = await submitCount10(t, scholar, 1000);
    expect(res.correct).toBe(true);

    const row = await count10Row(t, scholar);
    expect(row?.repetition).toBe(2); // ordinary reps 1 → 2, no jump
    expect(row?.source).toBe("practice");
  });

  test("does NOT jump on a SLOW correct even with a baseline (speed gate)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    await primeValve(t, scholar, { withBaseline: true });

    const res = await submitCount10(t, scholar, 30000); // 30s ≫ 5000 baseline ⇒ slow
    expect(res.correct).toBe(true);

    const row = await count10Row(t, scholar);
    expect(row?.repetition).toBe(2);
    expect(row?.source).toBe("practice");
  });
});

// ── C3: practice-derived error flags (§7) ───────────────────────────────────
describe("practiceSkills — error-pattern flags (C3)", () => {
  const SUB_SKILL = "subtract_2digit_regroup";

  async function seedTeacher(t: ReturnType<typeof convexTest>) {
    return seedStaffWithMembership(t, {
      institutionId: await seedTestInstitution(t),
      name: "Teach",
      username: "teach_c3",
    });
  }

  // A stored gen# item whose stem the classifier can read: "52 − 38 = ?" (14).
  // The SMALLER_FROM_LARGER buggy answer is 26 (|5-3||2-8| = 2,6).
  async function insertBorrowItem(t: ReturnType<typeof convexTest>) {
    return t.run(async (ctx) =>
      ctx.db.insert("practiceItems", {
        skillKey: SUB_SKILL,
        domain: "whole-number-arithmetic",
        stem: "52 − 38 = ?",
        answerType: "integer",
        answerCanonical: "14",
        source: "generated",
        verifiedAt: Date.now(),
      }),
    );
  }

  async function events(t: ReturnType<typeof convexTest>, scholar: Id<"users">) {
    return t.run(async (ctx) =>
      (await ctx.db.query("practiceErrorEvents").collect()).filter(
        (e) => e.scholarId === scholar,
      ),
    );
  }

  test("a recorded, classifiable miss logs one practiceErrorEvents row", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const id = await insertBorrowItem(t);

    const res = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: `gen#${id}`,
      answer: "26", // SMALLER_FROM_LARGER
    });
    expect(res.correct).toBe(false);

    const logged = await events(t, scholar);
    expect(logged).toHaveLength(1);
    expect(logged[0].pattern).toBe("SMALLER_FROM_LARGER");
    expect(logged[0].nodeKey).toBe(SUB_SKILL);
    expect(logged[0].domain).toBe("whole-number-arithmetic");
  });

  test("an unclassifiable miss logs nothing", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const id = await insertBorrowItem(t);

    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: `gen#${id}`,
      answer: "999999", // matches no detector for 52−38
    });
    expect(await events(t, scholar)).toHaveLength(0);
  });

  test("a correct answer logs nothing", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const id = await insertBorrowItem(t);

    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: `gen#${id}`,
      answer: "14",
    });
    expect(await events(t, scholar)).toHaveLength(0);
  });

  test("a record:false handoff retry logs nothing (no double-count)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const id = await insertBorrowItem(t);

    await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId: `gen#${id}`,
      answer: "26",
      record: false,
    });
    expect(await events(t, scholar)).toHaveLength(0);
  });

  async function missThrice(t: ReturnType<typeof convexTest>, scholar: Id<"users">) {
    const asScholar = await asUser(t, scholar);
    const id = await insertBorrowItem(t);
    for (let i = 0; i < 3; i++) {
      await asScholar.mutation(api.practiceSkills.submitAnswer, {
        scholarId: scholar,
        itemId: `gen#${id}`,
        answer: "26",
      });
    }
  }

  test("≥3 same-pattern misses open a teacher-visible flag on the node", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const teacher = await seedTeacher(t);
    await missThrice(t, scholar);

    const asTeacher = await asUser(t, teacher);
    const { patterns } = await asTeacher.query(
      api.practiceSkills.practiceErrorFlagsForNode,
      { scholarId: scholar, nodeKey: SUB_SKILL },
    );
    expect(patterns).toHaveLength(1);
    expect(patterns[0].pattern).toBe("SMALLER_FROM_LARGER");
    expect(patterns[0].count).toBe(3);
    expect(patterns[0].phrasing).toMatch(/regrouping not yet stable/);
  });

  test("2 misses do not open the flag (below threshold)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const teacher = await seedTeacher(t);
    const asScholar = await asUser(t, scholar);
    const id = await insertBorrowItem(t);
    for (let i = 0; i < 2; i++) {
      await asScholar.mutation(api.practiceSkills.submitAnswer, {
        scholarId: scholar,
        itemId: `gen#${id}`,
        answer: "26",
      });
    }

    const asTeacher = await asUser(t, teacher);
    const { patterns } = await asTeacher.query(
      api.practiceSkills.practiceErrorFlagsForNode,
      { scholarId: scholar, nodeKey: SUB_SKILL },
    );
    expect(patterns).toHaveLength(0);
  });

  test("REDACTION: a scholar viewing their own node gets no pattern detail", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    await missThrice(t, scholar);

    const asScholar = await asUser(t, scholar);
    const { patterns } = await asScholar.query(
      api.practiceSkills.practiceErrorFlagsForNode,
      { scholarId: scholar, nodeKey: SUB_SKILL },
    );
    expect(patterns).toEqual([]);
  });

  test("the flag lights nodeReadingsForScholar for a teacher, redacted for the scholar", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const teacher = await seedTeacher(t);
    await missThrice(t, scholar);

    // Teacher: the practice-only node appears with hasOpenMisconception=true,
    // even though it has NO conversational observation.
    const asTeacher = await asUser(t, teacher);
    const teacherRes = await asTeacher.query(api.nodeDepth.nodeReadingsForScholar, {
      scholarId: scholar,
    });
    const teacherReading = teacherRes.readings.find((r) => r.nodeKey === SUB_SKILL);
    expect(teacherReading).toBeDefined();
    expect(teacherReading!.hasOpenMisconception).toBe(true);

    // Scholar-self: the flag field is structurally absent (never true/false).
    const asScholar = await asUser(t, scholar);
    const scholarRes = await asScholar.query(api.nodeDepth.nodeReadingsForScholar, {
      scholarId: scholar,
    });
    const scholarReading = scholarRes.readings.find((r) => r.nodeKey === SUB_SKILL);
    // Either the node is absent from the scholar's readings, or present without
    // the teacher-only flag — never present WITH it.
    if (scholarReading) {
      expect("hasOpenMisconception" in scholarReading).toBe(false);
    }
  });
});

// ── P3: strand re-probe (B1 Mechanism 2) ────────────────────────────────────
describe("practiceSkills — strand re-probe (B1-M2)", () => {
  const DOMAIN = "whole-number-arithmetic";

  // Resolve a strand's topological order from the seeded graph (the same order
  // the re-probe searches over).
  async function countingOrder(t: ReturnType<typeof convexTest>): Promise<string[]> {
    const { skills, edges } = await t.query(api.practiceSkills.getDomain, {});
    const orders = strandOrders(
      skills.map((s) => ({ nodeKey: s.skillKey, strand: s.strand, order: s.order })),
      edges.map((e) => ({ fromKey: e.fromKey, toKey: e.toKey })),
    );
    return orders.find((o) => o.strand === "counting")!.orderedKeys;
  }

  // Credit the first `n` counting nodes as accelerated (valve) credits — the
  // under-placed signal that makes the strand a re-probe candidate.
  async function seedAcceleratedFloor(
    t: ReturnType<typeof convexTest>,
    scholar: Id<"users">,
    order: string[],
    n: number,
  ) {
    const now = Date.now();
    await t.run(async (ctx) => {
      for (let i = 0; i < n; i++) {
        await ctx.db.insert("practiceMastery", {
          scholarId: scholar,
          skillKey: order[i],
          domain: DOMAIN,
          strand: "counting",
          repetition: FLUENT_REPS,
          halfLifeDays: 4,
          lastPracticedAt: now,
          frontier: false,
          source: "accelerated",
          updatedAt: now,
        });
      }
    });
  }

  test("reprobeCandidates flags a strand with ≥2 accelerated credits + headroom", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const order = await countingOrder(t);
    await seedAcceleratedFloor(t, scholar, order, 2);

    const { candidates } = await asScholar.query(api.practiceSkills.reprobeCandidates, {
      scholarId: scholar,
    });
    const counting = candidates.find((c) => c.strand === "counting");
    expect(counting).toBeDefined();
    expect(counting!.acceleratedCount).toBeGreaterThanOrEqual(2);
    // the offered frontier is the first NOT-yet-credited node (index 2)
    expect(counting!.frontierKey).toBe(order[2]);
  });

  test("only 1 accelerated credit → NOT a candidate", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const order = await countingOrder(t);
    await seedAcceleratedFloor(t, scholar, order, 1);

    const { candidates } = await asScholar.query(api.practiceSkills.reprobeCandidates, {
      scholarId: scholar,
    });
    expect(candidates.find((c) => c.strand === "counting")).toBeUndefined();
  });

  test("reprobeProbes serves a probe ABOVE the current floor", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const order = await countingOrder(t);
    await seedAcceleratedFloor(t, scholar, order, 2);

    const res = await asScholar.query(api.practiceSkills.reprobeProbes, {
      scholarId: scholar,
      strand: "counting",
      answers: [],
      seed: 123,
    });
    expect(res.done).toBe(false);
    expect(res.probe).not.toBeNull();
    // the probe node is at or above the floor (index ≥ 2) in the strand order
    expect(order.indexOf(res.probe!.skillKey)).toBeGreaterThanOrEqual(2);
    // Integer probes keep the plain input path.
    expect(res.probe).not.toHaveProperty("answerShape");
  });

  test("reprobeProbes preserves the 2-D editor signal for a fraction probe", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "fraction_reprobe");
    const asScholar = await asUser(t, scholar);
    const domain = "fraction-arithmetic";
    const { skills, edges } = await t.query(api.practiceSkills.getDomain, { domain });
    const conceptOrder = strandOrders(
      skills.map((skill) => ({
        nodeKey: skill.skillKey,
        strand: skill.strand,
        order: skill.order,
      })),
      edges.map((edge) => ({ fromKey: edge.fromKey, toKey: edge.toKey })),
    ).find((order) => order.strand === "concept")!.orderedKeys;
    const targetIndex = conceptOrder.indexOf("fraction_as_division");
    expect(targetIndex).toBeGreaterThan(0);

    // Set the re-probe floor immediately before the fraction-as-division item.
    await t.run(async (ctx) => {
      for (const skillKey of conceptOrder.slice(0, targetIndex)) {
        await ctx.db.insert("practiceMastery", {
          scholarId: scholar,
          skillKey,
          domain,
          strand: "concept",
          repetition: FLUENT_REPS,
          halfLifeDays: 30,
          lastPracticedAt: Date.now(),
          frontier: false,
          source: "practice",
          updatedAt: Date.now(),
        });
      }
    });

    const res = await asScholar.query(api.practiceSkills.reprobeProbes, {
      scholarId: scholar,
      strand: "concept",
      domain,
      answers: [],
      seed: 123,
    });
    expect(res.done).toBe(false);
    expect(res.probe).toMatchObject({
      skillKey: "fraction_as_division",
      answerType: "expression",
      answerShape: "twoD",
    });
  });

  test("submitReprobe moves the frontier up + credits new nodes PROVISIONALLY (source reprobe)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const order = await countingOrder(t);
    await seedAcceleratedFloor(t, scholar, order, 2);

    // Answer a HIGHER probeable counting node correctly — trust-upward credits
    // everything below it. Pick the highest-index probeable node in the strand.
    let targetIdx = -1;
    for (let i = order.length - 1; i >= 2; i--) {
      if (hasTemplate(order[i])) { targetIdx = i; break; }
    }
    expect(targetIdx).toBeGreaterThanOrEqual(2);
    const seed = 4242;
    // reprobeProbes uses probeSeed(seed, strand, index) internally; we can't see
    // that seed, so grade via a self-consistent item: build the item for the
    // target node with a known seed and answer it correctly.
    const itemId = makeItemId(order[targetIdx], seed);
    const correct = gradeTemplateItem(itemId, "0")!.correctAnswer;

    const res = await asScholar.mutation(api.practiceSkills.submitReprobe, {
      scholarId: scholar,
      strand: "counting",
      answers: [{ itemId, answer: correct }],
    });
    expect(res.moved).toBe(true);
    // everything from the old floor (2) up to the target is newly credited
    expect(res.creditedKeys).toContain(order[targetIdx]);
    expect(res.creditedKeys).toContain(order[2]);

    // the newly credited rows are source "reprobe" → PROVISIONAL (not green)
    const rows = await t.run(async (ctx) =>
      (await ctx.db.query("practiceMastery").collect()).filter(
        (r) => r.scholarId === scholar && res.creditedKeys.includes(r.skillKey),
      ),
    );
    expect(rows.length).toBe(res.creditedKeys.length);
    for (const r of rows) {
      expect(r.source).toBe("reprobe");
      expect(r.repetition).toBe(FLUENT_REPS);
    }
    // nodes below the old floor keep their accelerated source (untouched)
    const floorRow = await t.run(async (ctx) =>
      (await ctx.db.query("practiceMastery").collect()).find(
        (r) => r.scholarId === scholar && r.skillKey === order[0],
      ),
    );
    expect(floorRow?.source).toBe("accelerated");
  });

  // Reprobe is the ONE trust-upward path that PATCHES an existing mastery row
  // (placement and the accel seed only insert fresh ones), so it is the only
  // place a stale missStreak could survive a credit. Clearing a HIGHER node is a
  // more recent determination of fluency, so it must supersede earlier misses —
  // otherwise `masteryOf` keeps returning "struggling" (TOP priority) and paints
  // a just-credited node red on the teacher's map.
  test("submitReprobe clears a stale missStreak on the rows it credits", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const order = await countingOrder(t);
    await seedAcceleratedFloor(t, scholar, order, 2);

    // Put a node that the reprobe will credit at the struggling bar.
    const strugglingKey = order[2];
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("practiceMastery").collect()).find(
        (r) => r.scholarId === scholar && r.skillKey === strugglingKey,
      );
      if (row) await ctx.db.patch(row._id, { missStreak: STRUGGLING_MISS_THRESHOLD });
      else
        await ctx.db.insert("practiceMastery", {
          scholarId: scholar,
          skillKey: strugglingKey,
          domain: "whole-number-arithmetic",
          repetition: 1,
          halfLifeDays: 1,
          frontier: true,
          source: "practice",
          updatedAt: Date.now(),
          missStreak: STRUGGLING_MISS_THRESHOLD,
        });
    });

    let targetIdx = -1;
    for (let i = order.length - 1; i >= 2; i--) {
      if (hasTemplate(order[i])) { targetIdx = i; break; }
    }
    const itemId = makeItemId(order[targetIdx], 4242);
    const correct = gradeTemplateItem(itemId, "0")!.correctAnswer;

    const res = await asScholar.mutation(api.practiceSkills.submitReprobe, {
      scholarId: scholar,
      strand: "counting",
      answers: [{ itemId, answer: correct }],
    });
    expect(res.creditedKeys).toContain(strugglingKey);

    const row = await t.run(async (ctx) =>
      (await ctx.db.query("practiceMastery").collect()).find(
        (r) => r.scholarId === scholar && r.skillKey === strugglingKey,
      ),
    );
    expect(row!.missStreak).toBe(0);
    // …so a teacher read no longer derives the red state for this node.
    expect(
      masteryOf({
        skillKey: strugglingKey,
        label: "",
        domain: "",
        repetition: row!.repetition,
        proficiency: "fluent",
        retention: "none",
        frontier: false,
        demonstrated: false,
        missStreak: row!.missStreak,
      }),
    ).not.toBe("struggling");
  });

  // The ReprobeOffer component drives an ADAPTIVE loop: reprobeProbes([]) →
  // answer → reprobeProbes([a1]) → … until { done }. Prove that loop terminates
  // and every served probe stays above the floor (never re-probes known nodes).
  test("the adaptive reprobe loop converges to done, always above the floor", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    const order = await countingOrder(t);
    await seedAcceleratedFloor(t, scholar, order, 2);

    const answers: { itemId: string; answer: string }[] = [];
    let done = false;
    let iterations = 0;
    const MAX = 16; // strand is far shorter; a non-terminating loop trips this
    while (!done && iterations < MAX) {
      iterations++;
      const res = await asScholar.query(api.practiceSkills.reprobeProbes, {
        scholarId: scholar,
        strand: "counting",
        answers,
        seed: 4242,
      });
      if (res.done || !res.probe) {
        done = true;
        break;
      }
      // Never re-probe a node the scholar has already cleared (index < floor 2).
      expect(order.indexOf(res.probe.skillKey)).toBeGreaterThanOrEqual(2);
      answers.push({ itemId: res.probe.itemId, answer: "skip" }); // wrong → search narrows
    }
    expect(done).toBe(true);
    expect(iterations).toBeLessThan(MAX);
  });
});

// FIRe — Fractional Implicit Repetition (§4A). A CORRECT explicit attempt
// trickles fractional spaced-repetition credit down the `buildsOn` DAG,
// refreshing retention on already-demonstrated prerequisites WITHOUT touching
// repetition/source/frontier. Uses the linear two-strand ADD chain
// (count_to_10 → add_within_5 → add_within_10 → add_within_20_regroup →
// add_2digit_regroup); default edge weight 0.5, so from the tip the credit is
// 0.5 / 0.25 / 0.125 / 0.0625 — the last (count_to_10) is pruned below the floor.
describe("practiceSkills — FIRe implicit repetition (§4A)", () => {
  const DAY = 86_400_000;

  async function seedAncestor(
    t: ReturnType<typeof convexTest>,
    scholarId: Id<"users">,
    skillKey: string,
    opts: { repetition?: number; halfLifeDays?: number; agoDays?: number } = {},
  ) {
    const now = Date.now();
    const at = now - (opts.agoDays ?? 20) * DAY;
    return t.run(async (ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId,
        skillKey,
        domain: PLACEMENT_TEST_DOMAIN,
        repetition: opts.repetition ?? FLUENT_REPS_VALUE,
        halfLifeDays: opts.halfLifeDays ?? 4,
        lastPracticedAt: at,
        frontier: false,
        source: "practice",
        updatedAt: at,
      }),
    );
  }

  async function recordCorrectTip(t: ReturnType<typeof convexTest>, scholar: Id<"users">) {
    return t.mutation(internal.practiceSkills.recordAttemptInternal, {
      scholarId: scholar,
      skillKey: "add_2digit_regroup",
      correct: true,
      domain: PLACEMENT_TEST_DOMAIN,
    });
  }

  test("a correct attempt trickles credit down the prereq DAG (retention only)", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    // All ancestors of add_2digit_regroup, fluent + decayed 20 days:
    await seedAncestor(t, scholar, "add_within_20_regroup"); // weight 0.5
    await seedAncestor(t, scholar, "add_within_10"); //         weight 0.25
    await seedAncestor(t, scholar, "add_within_5"); //          weight 0.125
    await seedAncestor(t, scholar, "count_to_10"); //           weight 0.0625 → pruned

    const before = Date.now();
    await recordCorrectTip(t, scholar);
    const m = await masteryByKey(t, scholar, PLACEMENT_TEST_DOMAIN);

    const credited = m.get("add_within_20_regroup")!;
    expect(credited.implicitCount).toBe(1);
    expect(credited.lastImplicitAt).toBeGreaterThanOrEqual(before);
    expect(credited.halfLifeDays).toBeGreaterThan(4); // half-life grew
    expect(credited.lastPracticedAt!).toBeGreaterThan(before - 20 * DAY); // decay interval shrank
    // repetition / source / frontier are UNTOUCHED by implicit credit.
    expect(credited.repetition).toBe(FLUENT_REPS_VALUE);
    expect(credited.source).toBe("practice");
    expect(credited.frontier).toBe(false);
    // `updatedAt` is NOT bumped: it's the scholar-visible "practiced today"
    // clock (+ strand round-robin + accel window), and an implicit refresh must
    // leave no scholar-visible trace (§4A invariant). It stays ~20 days ago.
    expect(credited.updatedAt).toBeLessThan(before);

    // Deeper ancestors still above the floor are refreshed too…
    expect(m.get("add_within_10")!.implicitCount).toBe(1);
    expect(m.get("add_within_5")!.implicitCount).toBe(1);
    // …but the floor-pruned prerequisite (0.0625 < 0.1) is never touched.
    const pruned = m.get("count_to_10")!;
    expect(pruned.implicitCount).toBeUndefined();
    expect(pruned.lastImplicitAt).toBeUndefined();
    expect(pruned.halfLifeDays).toBe(4);

    // The answered skill's own row got the EXPLICIT write, not implicit credit.
    const answered = m.get("add_2digit_regroup")!;
    expect(answered.repetition).toBe(1);
    expect(answered.source).toBe("practice");
    expect(answered.implicitCount).toBeUndefined();
    expect(answered.lastImplicitAt).toBeUndefined();
  });

  test("implicitCount increments across repeated descendant successes", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    await seedAncestor(t, scholar, "add_within_20_regroup");

    await recordCorrectTip(t, scholar);
    await recordCorrectTip(t, scholar);

    const m = await masteryByKey(t, scholar, PLACEMENT_TEST_DOMAIN);
    expect(m.get("add_within_20_regroup")!.implicitCount).toBe(2);
  });

  test("a miss propagates no implicit credit", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    await seedAncestor(t, scholar, "add_within_20_regroup");

    await t.mutation(internal.practiceSkills.recordAttemptInternal, {
      scholarId: scholar,
      skillKey: "add_2digit_regroup",
      correct: false,
      domain: PLACEMENT_TEST_DOMAIN,
    });

    const row = (await masteryByKey(t, scholar, PLACEMENT_TEST_DOMAIN)).get("add_within_20_regroup")!;
    expect(row.implicitCount).toBeUndefined();
    expect(row.lastImplicitAt).toBeUndefined();
    expect(row.halfLifeDays).toBe(4); // unchanged
  });

  test("a record:false (retry) grade propagates no implicit credit", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedAncestor(t, scholar, "add_within_20_regroup");

    // Grade a correct answer on the tip but with record:false → the whole
    // record path (and thus implicit propagation) is skipped.
    const itemId = makeItemId("add_2digit_regroup", 99);
    const answer = gradeTemplateItem(itemId, "0")!.correctAnswer;
    const res = await asScholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId: scholar,
      itemId,
      answer,
      record: false,
    });
    expect(res.correct).toBe(true);

    const row = (await masteryByKey(t, scholar, PLACEMENT_TEST_DOMAIN)).get("add_within_20_regroup")!;
    expect(row.implicitCount).toBeUndefined();
    expect(row.lastImplicitAt).toBeUndefined();
  });

  test("implicit credit never CREATES a mastery row", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    // Only ONE ancestor has a row; the others (add_within_20_regroup, add_within_5)
    // are eligible by graph weight but have no mastery row to refresh.
    await seedAncestor(t, scholar, "add_within_10");

    const rowsBefore = await t.run(async (ctx) =>
      (await ctx.db.query("practiceMastery").collect()).filter((r) => r.scholarId === scholar).length,
    );
    await recordCorrectTip(t, scholar);
    const rowsAfter = await t.run(async (ctx) =>
      (await ctx.db.query("practiceMastery").collect()).filter((r) => r.scholarId === scholar).length,
    );

    // Only the answered skill's own row is created; no ancestor rows are invented.
    expect(rowsAfter).toBe(rowsBefore + 1);
    const m = await masteryByKey(t, scholar, PLACEMENT_TEST_DOMAIN);
    expect(m.get("add_within_10")!.implicitCount).toBe(1); // the one that existed got credited
    expect(m.has("add_within_20_regroup")).toBe(false); // never created
    expect(m.has("add_within_5")).toBe(false);
  });
});

// Auto-remediation on plateau (§5, "C"). When a scholar has an OPEN
// error-pattern flag on a node, the engine auto-serves that node's weakest
// already-attempted prerequisite in the reviews channel with reason
// "remediation" — an already-due target is not duplicated, and the reason NEVER
// reaches a scholar surface. Uses the ADD
// chain from seedTwoStrandDomain (…→ add_within_10 → add_within_20_regroup →…),
// so the flagged node's direct prereq is add_within_10.
describe("practiceSkills — auto-remediation on plateau (§5, C)", () => {
  const DAY = 86_400_000;
  const FLAGGED = "add_within_20_regroup";
  const PREREQ = "add_within_10"; // the direct buildsOn prereq of FLAGGED

  /** Seed one mastery row at a chosen retention (fluent reps by default). */
  async function seedMastery(
    t: ReturnType<typeof convexTest>,
    scholarId: Id<"users">,
    skillKey: string,
    opts: { repetition?: number; halfLifeDays?: number; agoDays?: number } = {},
  ) {
    const at = Date.now() - (opts.agoDays ?? 2) * DAY;
    return t.run(async (ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId,
        skillKey,
        domain: PLACEMENT_TEST_DOMAIN,
        repetition: opts.repetition ?? FLUENT_REPS_VALUE,
        halfLifeDays: opts.halfLifeDays ?? 10, // ago 2 / hl 10 → retention ≈0.87: not due for this prereq, still a remediation candidate
        lastPracticedAt: at,
        frontier: false,
        source: "practice",
        updatedAt: at,
      }),
    );
  }

  /** Insert `count` same-pattern misses on `nodeKey`, all inside the 14-day window. */
  async function seedOpenFlag(
    t: ReturnType<typeof convexTest>,
    scholarId: Id<"users">,
    nodeKey: string,
    pattern = "DROPPED_CARRY",
    count = 3,
  ) {
    const now = Date.now();
    await t.run(async (ctx) => {
      for (let i = 0; i < count; i++) {
        await ctx.db.insert("practiceErrorEvents", {
          scholarId,
          nodeKey,
          domain: PLACEMENT_TEST_DOMAIN,
          pattern,
          itemId: `item#${nodeKey}#${i}`,
          createdAt: now - (i + 1) * DAY,
        });
      }
    });
  }

  test("an open flag auto-serves the weakest prereq with reason 'remediation'", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedMastery(t, scholar, PREREQ); // fluent but decayed → candidate, NOT due
    await seedOpenFlag(t, scholar, FLAGGED);

    const queue = await asScholar.query(api.practiceSkills.nextForScholar, {
      scholarId: scholar,
      domain: PLACEMENT_TEST_DOMAIN,
      limit: 12,
    });

    const item = queue.find((q) => q.key === PREREQ);
    expect(item).toBeDefined();
    expect(item!.reason).toBe("remediation");
  });

  test("deprecated teacher-focus data does not suppress auto-remediation", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedMastery(t, scholar, PREREQ);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar_skill", (q) =>
          q.eq("scholarId", scholar).eq("skillKey", PREREQ),
        )
        .first();
      if (row) await ctx.db.patch(row._id, { teacherFocusSkillKey: "add_within_5" });
    });
    await seedOpenFlag(t, scholar, FLAGGED);

    const queue = await asScholar.query(api.practiceSkills.nextForScholar, {
      scholarId: scholar,
      domain: PLACEMENT_TEST_DOMAIN,
      limit: 12,
    });

    expect(queue.some((q) => q.reason === "remediation")).toBe(true);
  });

  test("a target already due is a review, not a duplicate remediation item", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    // Prereq heavily decayed → genuinely DUE (retention ≪ 0.6), so it's a real review.
    await seedMastery(t, scholar, PREREQ, { halfLifeDays: 2, agoDays: 6 });
    await seedOpenFlag(t, scholar, FLAGGED);

    const queue = await asScholar.query(api.practiceSkills.nextForScholar, {
      scholarId: scholar,
      domain: PLACEMENT_TEST_DOMAIN,
      limit: 12,
    });

    const hits = queue.filter((q) => q.key === PREREQ);
    expect(hits.length).toBe(1); // served once, not duplicated
    expect(hits[0].reason).toBe("review");
    expect(queue.some((q) => q.reason === "remediation")).toBe(false);
  });

  test("playlist keeps unlocked remediation without leaking its reason", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedMastery(t, scholar, PREREQ);
    await seedOpenFlag(t, scholar, FLAGGED);

    const pl = await asScholar.query(api.practiceSkills.playlistForScholar, {
      scholarId: scholar,
      domain: PLACEMENT_TEST_DOMAIN,
    });

    expect(pl.set.every((s) => s.reason !== ("remediation" as string))).toBe(true);
    expect(pl.nextUp?.reason).not.toBe("remediation");
    // The remediation prereq is present, but rendered as ordinary practice.
    const s = pl.set.find((x) => x.key === PREREQ);
    expect(s).toBeDefined();
    expect(s!.reason).toBe("new");
  });

  test("non-teacher practiceErrorFlagsForNode still returns empty (unchanged)", async () => {
    const t = convexTest(schema, modules);
    await seedTwoStrandDomain(t);
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    await seedOpenFlag(t, scholar, FLAGGED);

    const flags = await asScholar.query(api.practiceSkills.practiceErrorFlagsForNode, {
      scholarId: scholar,
      nodeKey: FLAGGED,
    });
    expect(flags.patterns).toEqual([]);
  });
});

// ── summaryForScholar domain scoping ─────────────────────────────────
// Contract behind the teacher Assignment Run page's per-scholar practice
// progress (components/AssignmentPanel.tsx → PracticeMasteryRoster). A
// problem_set activity pins its own practice domain, so the summary MUST be
// scoped to that domain — otherwise a teacher on a fractions/probability
// assignment would read whole-number (default-domain) counts. This locks the
// per-domain scoping so a future caller can't silently regress to the default.
describe("practiceSkills — summaryForScholar domain scoping", () => {
  test("total reflects the requested domain (defaults to whole-number)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    // Derive expected per-domain sizes from the seeded graphs (robust to size drift).
    const wn = await asScholar.query(api.practiceSkills.getDomain, {
      domain: "whole-number-arithmetic",
    });
    const fr = await asScholar.query(api.practiceSkills.getDomain, {
      domain: "fraction-arithmetic",
    });
    const pr = await asScholar.query(api.practiceSkills.getDomain, {
      domain: "probability",
    });
    // The three domains are genuinely different sizes — so `total` alone is a
    // faithful witness that scoping happened.
    expect(new Set([wn.skills.length, fr.skills.length, pr.skills.length]).size).toBe(3);

    const dflt = await asScholar.query(api.practiceSkills.summaryForScholar, {
      scholarId: scholar,
    });
    expect(dflt.total).toBe(wn.skills.length); // no domain → whole-number default

    const frSummary = await asScholar.query(api.practiceSkills.summaryForScholar, {
      scholarId: scholar,
      domain: "fraction-arithmetic",
    });
    expect(frSummary.total).toBe(fr.skills.length);

    const prSummary = await asScholar.query(api.practiceSkills.summaryForScholar, {
      scholarId: scholar,
      domain: "probability",
    });
    expect(prSummary.total).toBe(pr.skills.length);
  });

  test("fluent mastery is counted only within its own domain", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    // One fluent FRACTION skill (a real key in the fraction graph).
    await t.run(async (ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: "partition_shapes",
        domain: "fraction-arithmetic",
        repetition: FLUENT_REPS_VALUE,
        halfLifeDays: 30,
        lastPracticedAt: Date.now(),
        frontier: false,
        source: "practice",
        updatedAt: Date.now(),
      }),
    );

    const fr = await asScholar.query(api.practiceSkills.summaryForScholar, {
      scholarId: scholar,
      domain: "fraction-arithmetic",
    });
    const wn = await asScholar.query(api.practiceSkills.summaryForScholar, {
      scholarId: scholar, // default whole-number
    });
    expect(fr.fluentCount).toBeGreaterThanOrEqual(1);
    // The fraction credit must NOT leak into the whole-number summary.
    expect(wn.fluentCount).toBe(0);
  });
});

// ── Stage 2: exhaustion → summit handoff (D5) ─────────────────────────
// The "next-domain moment": when a scholar has climbed a whole domain (every
// skill fluent, nothing left on the frontier), the engine must SAY so — to the
// scholar (summit card + switcher) and the teacher (summit alert). These lock
// the read contracts those surfaces depend on.
describe("practiceSkills — Stage 2 summit / exhaustion", () => {
  // Make a scholar fluent in EVERY skill of a domain — a true summit.
  async function makeExhausted(
    t: ReturnType<typeof convexTest>,
    scholar: Id<"users">,
    domain: string,
  ) {
    const { skills } = await t.query(api.practiceSkills.getDomain, { domain });
    await t.run(async (ctx) => {
      for (const s of skills) {
        await ctx.db.insert("practiceMastery", {
          scholarId: scholar,
          skillKey: s.skillKey,
          domain,
          repetition: FLUENT_REPS_VALUE,
          halfLifeDays: 30,
          lastPracticedAt: Date.now(),
          frontier: false,
          source: "practice",
          updatedAt: Date.now(),
        });
      }
    });
    return skills.length;
  }

  test("domainClimb separates access from demonstrated completion", () => {
    const keys = ["node-one", "node-two"];

    expect(
      domainClimb(keys, [
        { skillKey: "node-one", repetition: FLUENT_REPS_VALUE, source: "placement" },
        { skillKey: "node-two", repetition: FLUENT_REPS_VALUE, source: "placement" },
      ]),
    ).toEqual({ accessComplete: true, demonstratedComplete: false });

    for (const source of ["accelerated", "reprobe", "scaffolded"]) {
      expect(
        domainClimb(keys, keys.map((skillKey) => ({
          skillKey,
          repetition: FLUENT_REPS_VALUE,
          source,
        }))),
      ).toEqual({ accessComplete: true, demonstratedComplete: false });
    }

    expect(
      domainClimb(keys, keys.map((skillKey) => ({
        skillKey,
        repetition: FLUENT_REPS_VALUE,
        source: "practice",
      }))),
    ).toEqual({ accessComplete: true, demonstratedComplete: true });

    // Legacy rows without a source retain the scheduler's practice default.
    expect(
      domainClimb(keys, keys.map((skillKey) => ({
        skillKey,
        repetition: FLUENT_REPS_VALUE,
      }))),
    ).toEqual({ accessComplete: true, demonstratedComplete: true });

    expect(domainClimb([], [])).toEqual({
      accessComplete: false,
      demonstratedComplete: false,
    });
  });

  test("query counts keep provisional access separate from a summit", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "synthetic-placement");
    const domain = "probability";
    const { skills } = await t.query(api.practiceSkills.getDomain, { domain });
    await t.run(async (ctx) => {
      for (const skill of skills) {
        await ctx.db.insert("practiceMastery", {
          scholarId: scholar,
          skillKey: skill.skillKey,
          domain,
          repetition: FLUENT_REPS_VALUE,
          halfLifeDays: 1,
          frontier: false,
          source: "placement",
          updatedAt: Date.now(),
        });
      }
    });
    const asScholar = await asUser(t, scholar);

    const summary = await asScholar.query(api.practiceSkills.summaryForScholar, {
      scholarId: scholar,
      domain,
    });
    expect(summary.accessComplete).toBe(true);
    expect(summary.exhausted).toBe(false);
    expect(summary.fluentCount).toBe(0);
    expect(summary.provisionalCount).toBe(summary.total);

    const domains = await asScholar.query(
      api.practiceSkills.domainsForScholar,
      { scholarId: scholar },
    );
    const standing = domains.find((row) => row.domain === domain);
    expect(standing).toMatchObject({
      accessComplete: true,
      exhausted: false,
      fluentCount: 0,
      provisionalCount: summary.total,
    });
  });

  test("summaryForScholar.exhausted flips only when EVERY skill is demonstrated", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    // Probability is the smallest graph — cheap to exhaust in a test.
    const before = await asScholar.query(api.practiceSkills.summaryForScholar, {
      scholarId: scholar,
      domain: "probability",
    });
    expect(before.exhausted).toBe(false);
    expect(before.total).toBeGreaterThan(0);

    // Half-way (one fluent skill) is NOT a summit.
    await t.run(async (ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: (
          await t.query(api.practiceSkills.getDomain, { domain: "probability" })
        ).skills[0].skillKey,
        domain: "probability",
        repetition: FLUENT_REPS_VALUE,
        halfLifeDays: 30,
        lastPracticedAt: Date.now(),
        frontier: false,
        source: "practice",
        updatedAt: Date.now(),
      }),
    );
    const partial = await asScholar.query(api.practiceSkills.summaryForScholar, {
      scholarId: scholar,
      domain: "probability",
    });
    expect(partial.exhausted).toBe(false);

    await makeExhausted(t, scholar, "probability");
    const after = await asScholar.query(api.practiceSkills.summaryForScholar, {
      scholarId: scholar,
      domain: "probability",
    });
    expect(after.exhausted).toBe(true);
    expect(after.fluentCount).toBe(after.total);
    expect(after.frontierCount).toBe(0);
  });

  test("an empty/unseeded domain is never a summit", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);
    // A domain slug with no seeded nodes: total 0 → exhausted must be false
    // (an empty climb is not a summit), guarding the `total > 0` clause.
    const s = await asScholar.query(api.practiceSkills.summaryForScholar, {
      scholarId: scholar,
      domain: "no-such-domain",
    });
    expect(s.total).toBe(0);
    expect(s.exhausted).toBe(false);
  });

  test("domainsForScholar tags started + exhausted per seeded domain", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    await makeExhausted(t, scholar, "probability");
    // A single NON-fluent fraction skill → started but not exhausted.
    await t.run(async (ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: "partition_shapes",
        domain: "fraction-arithmetic",
        repetition: 1,
        halfLifeDays: 30,
        lastPracticedAt: Date.now(),
        frontier: true,
        source: "practice",
        updatedAt: Date.now(),
      }),
    );

    const domains = await asScholar.query(
      api.practiceSkills.domainsForScholar,
      { scholarId: scholar },
    );
    const byId = Object.fromEntries(domains.map((d) => [d.domain, d]));

    // Every seeded registered domain is present, labeled + discipline-tagged
    // (including the elective discrete-math — this read is a catalog, not the
    // check-in's eligible set).
    expect(domains.length).toBe(9);
    expect(byId["discrete-math"].label).toBe("Discrete math");
    expect(byId["fraction-arithmetic"].label).toBe("Fractions");
    expect(byId["fraction-arithmetic"].discipline).toBe("Mathematics");
    expect(byId["geometry-measurement"].label).toBe("Geometry & measurement");
    expect(byId["geometry-measurement"].discipline).toBe("Mathematics");
    expect(byId["ratio-proportion-percent"].label).toBe("Ratios, rates & percent");
    expect(byId["ratio-proportion-percent"].discipline).toBe("Mathematics");
    expect(byId["integers-coordinates"].label).toBe("Integers & the coordinate plane");
    expect(byId["integers-coordinates"].discipline).toBe("Mathematics");
    expect(byId["early-algebra"].label).toBe("Early algebra");
    expect(byId["early-algebra"].discipline).toBe("Mathematics");
    expect(byId["algebra-1"].label).toBe("Algebra 1");
    expect(byId["algebra-1"].discipline).toBe("Mathematics");

    expect(byId["probability"].started).toBe(true);
    expect(byId["probability"].exhausted).toBe(true);
    expect(byId["probability"].fluentCount).toBe(byId["probability"].total);

    expect(byId["fraction-arithmetic"].started).toBe(true);
    expect(byId["fraction-arithmetic"].exhausted).toBe(false);

    // Untouched whole-number domain: neither started nor exhausted.
    expect(byId["whole-number-arithmetic"].started).toBe(false);
    expect(byId["whole-number-arithmetic"].exhausted).toBe(false);
  });

  test("an exhausted domain automatically serves Go Deeper problems", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "summit_go_deeper");
    const skills = (
      await t.query(api.practiceSkills.getDomain, { domain: "probability" })
    ).skills;
    await makeExhausted(t, scholar, "probability");
    await t.run((ctx) =>
      ctx.db.insert("practiceItems", {
        skillKey: skills[0].skillKey,
        domain: "probability",
        stem: "A deliberately deeper probability problem",
        answerType: "integer",
        answerCanonical: "1",
        source: "generated",
        verifiedAt: Date.now(),
        tier: "stretch",
      }),
    );
    const asScholar = await asUser(t, scholar);

    const playlist = await asScholar.query(
      api.practiceSkills.playlistForScholar,
      { scholarId: scholar, domain: "probability" },
    );
    expect(playlist.set.length).toBeGreaterThan(0);
    expect(playlist.set.every((row) => row.reason === "stretch")).toBe(true);
    expect(playlist.set).toContainEqual(
      expect.objectContaining({ label: skills[0].label }),
    );

    const session = await asScholar.query(
      api.practiceSkills.practiceSession,
      { scholarId: scholar, seed: 7, domain: "probability" },
    );
    expect(session.items.length).toBeGreaterThan(0);
    expect(session.items.every((item) => item.lane === "stretch")).toBe(true);
    expect(session.items).toContainEqual(
      expect.objectContaining({ skillKey: skills[0].skillKey }),
    );
    expect(session.segments).toEqual([
      { kind: "stretch", count: session.items.length },
    ]);
    expect(session.stretch).toEqual([]);
  });

  test("access-complete placement still serves eligible demonstrated Go Deeper work", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "placed_go_deeper");
    const skills = (
      await t.query(api.practiceSkills.getDomain, { domain: "probability" })
    ).skills;
    const now = Date.now();
    await t.run(async (ctx) => {
      for (const [index, skill] of skills.entries()) {
        await ctx.db.insert("practiceMastery", {
          scholarId: scholar,
          domain: "probability",
          skillKey: skill.skillKey,
          repetition: FLUENT_REPS_VALUE,
          halfLifeDays: 4,
          lastPracticedAt: now,
          frontier: false,
          source: index === 0 ? "practice" : "placement",
          updatedAt: now,
        });
      }
      await ctx.db.insert("practiceItems", {
        skillKey: skills[0].skillKey,
        domain: "probability",
        stem: "A deeper problem on the demonstrated skill",
        answerType: "integer",
        answerCanonical: "1",
        source: "generated",
        verifiedAt: now,
        tier: "stretch",
      });
    });
    const asScholar = await asUser(t, scholar);

    const summary = await asScholar.query(api.practiceSkills.summaryForScholar, {
      scholarId: scholar,
      domain: "probability",
    });
    expect(summary).toMatchObject({
      accessComplete: true,
      exhausted: false,
      fluentCount: 1,
      provisionalCount: skills.length - 1,
    });

    const playlist = await asScholar.query(
      api.practiceSkills.playlistForScholar,
      { scholarId: scholar, domain: "probability" },
    );
    expect(playlist.set).toContainEqual(
      expect.objectContaining({
        key: expect.stringMatching(/^gen#/),
        reason: "stretch",
      }),
    );

    const session = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 7,
      domain: "probability",
    });
    expect(session.items).toContainEqual(
      expect.objectContaining({
        skillKey: skills[0].skillKey,
        lane: "stretch",
      }),
    );
    expect(session.stretch).toEqual([]);
  });

  test("Go Deeper only considers the bounded per-skill stretch window before eligibility", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "summit_stretch_scan_cap");
    const skills = (
      await t.query(api.practiceSkills.getDomain, { domain: "probability" })
    ).skills;
    await makeExhausted(t, scholar, "probability");
    await t.run(async (ctx) => {
      // The first sixteen rows are invalid dialogue items. The eligible row after
      // them proves the cap happens before the JavaScript eligibility pass.
      for (let i = 0; i < 16; i++) {
        await ctx.db.insert("practiceItems", {
          skillKey: skills[0].skillKey,
          domain: "probability",
          stem: `Incomplete dialogue stretch ${i}`,
          answerType: "dialogue",
          answerCanonical: "",
          source: "generated",
          verifiedAt: Date.now(),
          tier: "stretch",
        });
      }
    });
    const beyondCapItem = await t.run((ctx) =>
      ctx.db.insert("practiceItems", {
        skillKey: skills[0].skillKey,
        domain: "probability",
        stem: "The eligible item beyond the scan cap",
        answerType: "integer",
        answerCanonical: "1",
        source: "generated",
        verifiedAt: Date.now(),
        tier: "stretch",
      }),
    );
    const asScholar = await asUser(t, scholar);

    const session = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 7,
      domain: "probability",
    });
    expect(session.items.map((item) => item.itemId)).not.toContain(`gen#${beyondCapItem}`);
  });

  test("a story-linked Go Deeper item selects a story-bearing exact edge pair", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "summit_story_exact_pair");
    const skills = (
      await t.query(api.practiceSkills.getDomain, { domain: "probability" })
    ).skills;
    await makeExhausted(t, scholar, "probability");
    const itemId = await t.run(async (ctx) => {
      await ctx.db.insert("practiceItems", {
        skillKey: skills[0].skillKey,
        domain: "probability",
        stem: "An application with duplicate exact-pair edges",
        answerType: "integer",
        answerCanonical: "1",
        source: "generated",
        verifiedAt: Date.now(),
        tier: "stretch",
        storyToKey: "story-target",
      });
      // The first exact-pair row is intentionally storyless. The lookup must
      // retain story filtering after the exact-pair index narrows the scan.
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: skills[0].skillKey,
        toKey: "story-target",
        domain: "probability",
        kind: "bridge",
      });
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: skills[0].skillKey,
        toKey: "story-target",
        domain: "probability",
        kind: "bridge",
        story: {
          kind: "applies",
          hook: "Exact pair story",
          narrative: "This payload belongs to the requested pair.",
          provenance: "authored",
        },
      });
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: skills[0].skillKey,
        toKey: "other-target",
        domain: "probability",
        kind: "bridge",
        story: {
          kind: "applies",
          hook: "Wrong edge story",
          narrative: "This payload belongs to another pair.",
          provenance: "authored",
        },
      });
      return (
        await ctx.db
          .query("practiceItems")
          .withIndex("by_skill", (q) => q.eq("skillKey", skills[0].skillKey))
          .filter((q) => q.eq(q.field("storyToKey"), "story-target"))
          .first()
      )!._id;
    });
    const asScholar = await asUser(t, scholar);

    const session = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 7,
      domain: "probability",
    });
    const served = session.items.find((item) => item.itemId === `gen#${itemId}`);
    expect(served).toBeDefined();
    expect(served?.storyHook).toBe("Exact pair story");
  });

  test("countStoredItems counts only tier-absent core rows", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      for (const tier of [undefined, "stretch", "future-tier"]) {
        await ctx.db.insert("practiceItems", {
          skillKey: "core_count_indexed",
          domain: "probability",
          stem: `Stored ${tier ?? "core"} item`,
          answerType: "integer",
          answerCanonical: "1",
          source: "generated",
          verifiedAt: Date.now(),
          ...(tier === undefined ? {} : { tier }),
        });
      }
    });

    await expect(
      t.query(internal.practiceSkills.countStoredItems, {
        skillKey: "core_count_indexed",
      }),
    ).resolves.toBe(1);
  });

});

// ── D4: cross-domain frontier (Stage 3) ─────────────────────────────────────
// The live demonstrator is the bridge fraction_as_parts (fraction-arithmetic) →
// probability_as_fraction (probability): a grade-forward, leaf-node gate. These
// integration tests prove the foreign-aware `stateOf` (buildFrontierStateOf)
// actually LOCKS and UN-LOCKS the child across every frontier read surface, that
// the inert domains (whole-number, fractions) behave EXACTLY as before, and that
// FIRe implicit credit does NOT leak across the edge. (Remediation's domain-purity
// is proven as a pure test in remediation.test.ts.)
describe("practiceSkills — D4 cross-domain frontier", () => {
  async function makeFluent(
    t: ReturnType<typeof convexTest>,
    scholar: Id<"users">,
    skillKey: string,
    domain: string,
    halfLifeDays = 30,
  ) {
    await t.run(async (ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey,
        domain,
        repetition: FLUENT_REPS_VALUE,
        halfLifeDays,
        lastPracticedAt: Date.now(),
        frontier: false,
        source: "practice",
        updatedAt: Date.now(),
      }),
    );
  }

  const isFrontier = (
    tree: { nodes: { skillKey: string; frontier: boolean }[] },
    key: string,
  ) => tree.nodes.find((n) => n.skillKey === key)?.frontier ?? false;

  test("child skill stays LOCKED while its foreign prereq is unpracticed, UNLOCKS when it turns fluent", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    // Satisfy ONLY the OWN-domain prereq (theoretical_probability_simple). The
    // foreign fraction prereq is still unpracticed → the child must stay locked.
    await makeFluent(t, scholar, "theoretical_probability_simple", "probability");

    const treeLocked = await asScholar.query(api.practiceSkills.treeForScholar, {
      scholarId: scholar,
      domain: "probability",
    });
    expect(isFrontier(treeLocked, "probability_as_fraction")).toBe(false);

    const nextLocked = await asScholar.query(api.practiceSkills.nextForScholar, {
      scholarId: scholar,
      domain: "probability",
      limit: 20,
    });
    expect(nextLocked.map((q) => q.key)).not.toContain("probability_as_fraction");

    const summaryLocked = await asScholar.query(api.practiceSkills.summaryForScholar, {
      scholarId: scholar,
      domain: "probability",
    });

    // Make the FOREIGN fraction prereq fluent (in its OWN domain).
    await makeFluent(t, scholar, "fraction_as_parts", "fraction-arithmetic");

    const treeOpen = await asScholar.query(api.practiceSkills.treeForScholar, {
      scholarId: scholar,
      domain: "probability",
    });
    expect(isFrontier(treeOpen, "probability_as_fraction")).toBe(true);

    // Exactly one new frontier node in probability (the child), nothing else moved.
    // (nextForScholar applies a 2-strand session cap + round-robin, so it does not
    // guarantee a SPECIFIC frontier skill surfaces — the raw frontier flag on
    // treeForScholar / the frontier COUNT on summaryForScholar are the robust
    // unlock surfaces. The LOCKED not-contains check above still proves a foreign-
    // gated skill is never scheduled, exercising the same buildFrontierStateOf
    // seam inside nextPractice.)
    const summaryOpen = await asScholar.query(api.practiceSkills.summaryForScholar, {
      scholarId: scholar,
      domain: "probability",
    });
    expect(summaryOpen.frontierCount).toBe(summaryLocked.frontierCount + 1);
  });

  test("with the foreign prereq fluent but the OWN prereq unmet, the child is still locked (both prereqs required)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    // Only the foreign fraction prereq is fluent; the own-domain one is not.
    await makeFluent(t, scholar, "fraction_as_parts", "fraction-arithmetic");

    const tree = await asScholar.query(api.practiceSkills.treeForScholar, {
      scholarId: scholar,
      domain: "probability",
    });
    expect(isFrontier(tree, "probability_as_fraction")).toBe(false);
  });

  test("the inert domains (whole-number, fractions) have NO foreign gates — frontier roots unchanged", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    // A fresh scholar's whole-number frontier is exactly its single root…
    const wna = await asScholar.query(api.practiceSkills.treeForScholar, {
      scholarId: scholar,
    });
    expect(wna.nodes.filter((n) => n.frontier).map((n) => n.skillKey)).toEqual([
      "count_to_10",
    ]);

    // …and its fraction frontier is exactly its single root — the bridge (which
    // is stamped to the probability domain) leaks nothing into fractions.
    const frac = await asScholar.query(api.practiceSkills.treeForScholar, {
      scholarId: scholar,
      domain: "fraction-arithmetic",
    });
    expect(frac.nodes.filter((n) => n.frontier).map((n) => n.skillKey)).toEqual([
      "partition_shapes",
    ]);
  });

  test("FIRe implicit credit does NOT flow across the cross-domain edge", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);

    // Both prereqs fluent so the child is serveable; the foreign fraction prereq
    // is planted with a known half-life to detect any (illegal) implicit bump.
    await makeFluent(t, scholar, "theoretical_probability_simple", "probability");
    await makeFluent(t, scholar, "fraction_as_parts", "fraction-arithmetic", 4);

    // Practice the child (probability) correctly a few times → implicit credit
    // trickles to its PROBABILITY ancestors, but must never touch the fraction row.
    for (let i = 0; i < 3; i++) {
      await t.mutation(internal.practiceSkills.recordAttemptInternal, {
        scholarId: scholar,
        skillKey: "probability_as_fraction",
        correct: true,
        domain: "probability",
      });
    }

    const fracRow = await t.run(async (ctx) =>
      ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar_skill", (q) =>
          q.eq("scholarId", scholar).eq("skillKey", "fraction_as_parts"),
        )
        .first(),
    );
    // Untouched: no implicit refresh, half-life unchanged, still its own domain.
    expect(fracRow!.domain).toBe("fraction-arithmetic");
    expect(fracRow!.halfLifeDays).toBe(4);
    expect(fracRow!.implicitCount ?? 0).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Confirmation lane (placement-v2) — the wiring in practiceSkills.ts that the
// pure lane logic (convex/lib/__tests__/confirmationLane.test.ts) relies on:
//   (1) recordAttemptCore promotes an inferred placement row on a CORRECT
//       confirmation attempt (source→"practice", lastAttemptAt stamped) and
//       SHRINKS it on a miss (half-life halved, source stays inferred) — so a
//       served confirmation behaves exactly like any practice attempt today.
//   (2) buildStrandScheduling's inferredDueCredit classifier meters the
//       placement flood end-to-end through nextForScholar, keeping a freshly-
//       placed scholar's session frontier-dominant.
// ─────────────────────────────────────────────────────────────────────────
describe("practiceSkills — confirmation lane wiring", () => {
  const DAY = 86_400_000;

  async function insertNode(
    t: ReturnType<typeof convexTest>,
    node: { nodeKey: string; domain: string; strand?: string },
  ) {
    return await t.run(async (ctx) =>
      ctx.db.insert("knowledgeNodes", {
        nodeKey: node.nodeKey,
        label: node.nodeKey,
        domain: node.domain,
        strand: node.strand,
        source: "practice",
      }),
    );
  }

  async function masteryRow(t: ReturnType<typeof convexTest>, scholarId: Id<"users">, skillKey: string) {
    return await t.run(async (ctx) => {
      const rows = await ctx.db.query("practiceMastery").collect();
      return rows.find((r) => r.scholarId === scholarId && r.skillKey === skillKey) ?? null;
    });
  }

  /** Insert an inferred placement-credit row: source "placement", NO lastAttemptAt
   *  (placement never stamps it), due (old lastPracticedAt on the 4-day leash). */
  async function insertPlacementRow(
    t: ReturnType<typeof convexTest>,
    scholarId: Id<"users">,
    skillKey: string,
    domain: string,
    strand: string,
    ageDays: number,
  ) {
    const now = Date.now();
    await t.run(async (ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId, skillKey, domain, strand,
        repetition: FLUENT_REPS_VALUE + 2,
        halfLifeDays: 4, // PLACEMENT_HALF_LIFE_DAYS
        lastPracticedAt: now - ageDays * DAY,
        frontier: false,
        source: "placement",
        updatedAt: now - ageDays * DAY,
      }),
    );
  }

  test("a CORRECT confirmation attempt promotes a placement row (source→practice, lastAttemptAt stamped)", async () => {
    const t = convexTest(schema, modules);
    const domain = "cl-promote";
    await insertNode(t, { nodeKey: "cp0", domain, strand: "placed" });
    const scholar = await seedScholar(t, "clpromote");
    await insertPlacementRow(t, scholar, "cp0", domain, "placed", 10);

    // Pre: inferred credit, never attempted — this is a confirmation-lane row.
    const before = await masteryRow(t, scholar, "cp0");
    expect(before!.source).toBe("placement");
    expect(before!.lastAttemptAt).toBeUndefined();

    await t.mutation(internal.practiceSkills.recordAttemptInternal, {
      scholarId: scholar, skillKey: "cp0", correct: true, domain,
    });

    const after = await masteryRow(t, scholar, "cp0");
    // Confirmed → demonstrated: source flips to "practice" and the honest
    // attempt clock is stamped, so the row leaves the confirmation lane and can
    // finally go green (exactly the promotion the lane counts on).
    expect(after!.source).toBe("practice");
    expect(after!.lastAttemptAt).toBeDefined();
  });

  test("a MISSED confirmation attempt shrinks the half-life and keeps the source inferred (but stamps lastAttemptAt)", async () => {
    const t = convexTest(schema, modules);
    const domain = "cl-miss";
    await insertNode(t, { nodeKey: "cm0", domain, strand: "placed" });
    const scholar = await seedScholar(t, "clmiss");
    await insertPlacementRow(t, scholar, "cm0", domain, "placed", 10);
    const before = await masteryRow(t, scholar, "cm0");

    await t.mutation(internal.practiceSkills.recordAttemptInternal, {
      scholarId: scholar, skillKey: "cm0", correct: false, domain,
    });

    const after = await masteryRow(t, scholar, "cm0");
    // A wrong answer never claims demonstration: source stays inferred. But it
    // WAS genuinely attempted (half-life shrinks, lastAttemptAt stamped) → it is
    // now a demonstrated DUE review, not confirmation-lane credit.
    expect(after!.source).toBe("placement");
    expect(after!.halfLifeDays).toBeLessThan(before!.halfLifeDays);
    expect(after!.lastAttemptAt).toBeDefined();
  });

  test("nextForScholar meters the placement flood — a freshly-placed scholar's session is frontier-dominant", async () => {
    const t = convexTest(schema, modules);
    const domain = "cl-flood";
    // 6 placement-credited (inferred, due) rows on one strand + 3 frontier
    // (untouched, no prereqs) roots on another.
    for (let i = 0; i < 6; i++) await insertNode(t, { nodeKey: `pp${i}`, domain, strand: "placed" });
    for (let i = 0; i < 3; i++) await insertNode(t, { nodeKey: `ff${i}`, domain, strand: "frontier" });
    const scholar = await seedScholar(t, "clflood");
    for (let i = 0; i < 6; i++) await insertPlacementRow(t, scholar, `pp${i}`, domain, "placed", 10 + i);
    const asScholar = await asUser(t, scholar);

    const queue = await asScholar.query(api.practiceSkills.nextForScholar, {
      scholarId: scholar, domain, limit: 5,
    });
    const newCount = queue.filter((q) => q.reason === "new").length;
    const reviewCount = queue.filter((q) => q.reason === "review").length;
    // Frontier-dominant with a metered confirmation trickle (CONFIRMATION_LANE_CAP=2).
    expect(newCount).toBeGreaterThan(reviewCount);
    expect(reviewCount).toBeLessThanOrEqual(2);
  });

  test("nextForScholar does NOT meter placement rows that were genuinely attempted (lastAttemptAt set)", async () => {
    const t = convexTest(schema, modules);
    const domain = "cl-attempted";
    for (let i = 0; i < 4; i++) await insertNode(t, { nodeKey: `ap${i}`, domain, strand: "placed" });
    for (let i = 0; i < 3; i++) await insertNode(t, { nodeKey: `af${i}`, domain, strand: "frontier" });
    const scholar = await seedScholar(t, "clattempted");
    // Placement rows that were attempted-and-missed: source still "placement",
    // but lastAttemptAt set → demonstrated due reviews, NOT confirmation-lane.
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      await t.run(async (ctx) =>
        ctx.db.insert("practiceMastery", {
          scholarId: scholar, skillKey: `ap${i}`, domain, strand: "placed",
          repetition: FLUENT_REPS_VALUE + 1, halfLifeDays: 2,
          lastPracticedAt: now - (10 + i) * DAY,
          lastAttemptAt: now - (10 + i) * DAY, // genuinely attempted
          frontier: false, source: "placement", updatedAt: now - (10 + i) * DAY,
        }),
      );
    }
    const asScholar = await asUser(t, scholar);
    const queue = await asScholar.query(api.practiceSkills.nextForScholar, {
      scholarId: scholar, domain, limit: 5,
    });
    // These are sacred spaced repetition (real attempts) → they fill the review
    // budget as before, unmetered (more than the confirmation-lane cap).
    expect(queue.filter((q) => q.reason === "review").length).toBeGreaterThan(2);
    });

  // ── C-3 acceptance test: the shortened 6-item core still holds the mix
  //    floor (`ceil(6 / 4)` = 2 reserved frontier slots) for the SERVED size,
  //    not just some larger internal candidate pool. A freshly-placed scholar
  //    has a flood of due, INFERRED (placement-source) confirmation-lane
  //    reviews — exactly the scenario the confirmation lane above meters — so
  //    this pins the real `practiceSession` surface (not just `nextForScholar`)
  //    at the new default size. ──
  test("a freshly-placed scholar's 6-item whole-graph session keeps >= 2 frontier items (week-one mix floor)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const domain = "whole-number-arithmetic";
    const scholar = await seedScholar(t, "freshplaced6");
    const asScholar = await asUser(t, scholar);

    // An all-correct placement run credits the scholar (inferred, source
    // "placement") through a real chunk of the graph and leaves real headroom
    // above it — the week-one "placement flood" scenario in production.
    const { cur } = await runV2Placement(asScholar, scholar, domain, () => "correct");
    expect(cur.done).toBe(true);

    const mastery = await masteryByKey(t, scholar, domain);
    expect(mastery.size).toBeGreaterThan(0);
    expect([...mastery.values()].every((row) => row.source === "placement")).toBe(true);

    const session = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      domain,
      size: 6,
      seed: 4242,
    });
    expect(session.items).toHaveLength(6);
    const frontierCount = session.items.filter((item) => item.lane === "new").length;
    expect(frontierCount).toBeGreaterThanOrEqual(2);
  });
});

// ── The unified all-domains tree (one big map, scholar- + teacher-facing) ─────
// treeForScholar({ allDomains: true }) merges every seeded practice domain into
// one tree, tagging each node with its domain — the data behind the domain-banded
// map that replaced the per-domain switcher.
describe("practiceSkills — unified all-domains tree", () => {
  test("an in-progress placement projects provisional floors and real mastery wins per key", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedScholar(t, "mappingtree");
    const domain = "mapping-tree-domain";
    await t.run(async (ctx) => {
      for (const [order, key] of ["map_a", "map_b", "map_c", "map_d"].entries()) {
        await ctx.db.insert("knowledgeNodes", {
          nodeKey: key,
          label: key.toUpperCase(),
          domain,
          strand: "counting",
          order,
        });
      }
      for (const [fromKey, toKey] of [
        ["map_a", "map_b"],
        ["map_b", "map_c"],
        ["map_c", "map_d"],
      ] as const) {
        await ctx.db.insert("knowledgeNodeEdges", {
          fromKey,
          toKey,
          domain,
          kind: "buildsOn",
        });
      }
      await ctx.db.insert("practicePlacements", {
        scholarId: scholar,
        domain,
        status: "in_progress",
        probesAnswered: 1,
        probeLog: [
          {
            nodeKey: "map_b",
            strand: "counting",
            outcome: "correct",
            at: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      });
    });
    const asScholar = await asUser(t, scholar);

    const projected = await asScholar.query(api.practiceSkills.treeForScholar, {
      scholarId: scholar,
      domain,
    });
    const projectedByKey = new Map(
      projected.nodes.map((node) => [node.skillKey, node]),
    );
    for (const key of ["map_a", "map_b"]) {
      expect(projectedByKey.get(key)).toMatchObject({
        proficiency: "fluent",
        repetition: FLUENT_REPS_VALUE,
        demonstrated: false,
        frontier: false,
      });
    }
    expect(projectedByKey.get("map_c")?.frontier).toBe(true);

    await t.run(async (ctx) => {
      await ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: "map_b",
        domain,
        strand: "counting",
        repetition: 1,
        halfLifeDays: 1,
        lastPracticedAt: Date.now(),
        frontier: false,
        source: "practice",
        updatedAt: Date.now(),
      });
    });

    const withMastery = await asScholar.query(api.practiceSkills.treeForScholar, {
      scholarId: scholar,
      domain,
    });
    const masteryByKey = new Map(
      withMastery.nodes.map((node) => [node.skillKey, node]),
    );
    expect(masteryByKey.get("map_a")).toMatchObject({
      proficiency: "fluent",
      demonstrated: false,
    });
    expect(masteryByKey.get("map_b")).toMatchObject({
      proficiency: "practicing",
      repetition: 1,
      demonstrated: true,
      frontier: true,
    });
    expect(masteryByKey.get("map_c")?.frontier).toBe(false);
  });

  test("allDomains merges every seeded domain, tagging each node with its domain", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const admin = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Map Admin",
        username: "mapadmin",
        role: "platform_admin",
      }),
    );
    const asAdmin = await asUser(t, admin);

    const unified = await asAdmin.query(api.practiceSkills.treeForScholar, {
      scholarId: admin,
      allDomains: true,
    });

    // Every seeded domain is present (whole-number 87 + fractions 25 + probability 26
    // + geometry-measurement 46 + ratio-proportion-percent 39 + integers-coordinates 31
    // + early-algebra 45 + algebra-1 55).
    expect(unified.domain).toBeNull();
    expect(new Set(unified.domains)).toEqual(
      new Set([
        "whole-number-arithmetic",
        "fraction-arithmetic",
        "probability",
        "geometry-measurement",
        "ratio-proportion-percent",
        "integers-coordinates",
        "early-algebra",
        "algebra-1",
        "discrete-math",
      ]),
    );
    // geometry-measurement is 60 since the measurement-data strand landed
    // (46 + 14 new length/time/money/capacity nodes).
    expect(unified.nodes).toHaveLength(87 + 31 + 26 + 60 + 39 + 31 + 45 + 55 + 48);

    // Every node carries its domain, and a known key from each domain is present.
    for (const n of unified.nodes) expect(typeof n.domain).toBe("string");
    const domainOf = new Map(unified.nodes.map((n) => [n.skillKey, n.domain]));
    expect(domainOf.get("count_to_10")).toBe("whole-number-arithmetic");
    expect(domainOf.get("fraction_as_parts")).toBe("fraction-arithmetic");
    expect(domainOf.get("probability_as_fraction")).toBe("probability");
    expect(domainOf.get("area_rectangle")).toBe("geometry-measurement");
    expect(domainOf.get("percent_of_quantity")).toBe("ratio-proportion-percent");
    expect(domainOf.get("opposite_numbers")).toBe("integers-coordinates");
    expect(domainOf.get("eq_both_sides")).toBe("early-algebra");
    expect(domainOf.get("quad_formula")).toBe("algebra-1");

    // The cross-domain bridge edge survives the merge (both endpoints present).
    const hasBridge = unified.edges.some(
      (e) => e.fromKey === "fraction_as_parts" && e.toKey === "probability_as_fraction",
    );
    expect(hasBridge).toBe(true);
    expect(
      unified.edges.some(
        (e) => e.fromKey === "fraction_scaling" && e.toKey === "prop_multiplicative_vs_additive",
      ),
    ).toBe(true);
    expect(
      unified.edges.some(
        (e) => e.fromKey === "prop_constant_graph" && e.toKey === "pattern_graph_rate_change",
      ),
    ).toBe(true);
    expect(
      unified.edges.some(
        (e) => e.fromKey === "eq_both_sides" && e.toKey === "lin_eq_combine_terms",
      ),
    ).toBe(true);
  });

  test("the unified frontier matches the per-domain roots (nothing leaks across domains)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t);
    const asScholar = await asUser(t, scholar);

    const unified = await asScholar.query(api.practiceSkills.treeForScholar, {
      scholarId: scholar,
      allDomains: true,
    });
    const frontier = new Set(
      unified.nodes.filter((n) => n.frontier).map((n) => n.skillKey),
    );
    // A fresh scholar's frontier is each domain's OWN root — the cross-domain
    // child (probability_as_fraction) stays locked behind its unmet prereqs.
    expect(frontier.has("count_to_10")).toBe(true); // whole-number root
    expect(frontier.has("partition_shapes")).toBe(true); // fraction root
    expect(frontier.has("probability_as_fraction")).toBe(false);
  });

  test("an explicit domain still pins a single domain (back-compat)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const admin = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Domain Admin",
        username: "domainadmin",
        role: "platform_admin",
      }),
    );
    const asAdmin = await asUser(t, admin);

    const frac = await asAdmin.query(api.practiceSkills.treeForScholar, {
      scholarId: admin,
      domain: "fraction-arithmetic",
    });
    expect(frac.domain).toBe("fraction-arithmetic");
    expect(frac.domains).toEqual(["fraction-arithmetic"]);
    expect(frac.nodes).toHaveLength(31);
    for (const n of frac.nodes) expect(n.domain).toBe("fraction-arithmetic");
  });
});

// ── Mixed multi-domain placement — the "Math Check-In" ─────────────────────
// The FIRST placement covers ALL registered practice domains, interleaved in ONE
// scholar-facing session (Andy-approved). These pin: (1) multi-domain composition
// (probes span every seeded domain, each tagged; completes when all are placed),
// (2) cross-domain inference seeds a later domain's starting ring from a
// completed one, (3) partial-placement folding (only the missing domains are
// probed), (4) a completed domain never restarts, and (5) the two-axis source
// discipline (all placement credit stays inferred — source "placement").
describe("practiceSkills — mixed multi-domain placement (Math Check-In)", () => {
  // The CORE domains the automatic check-in serves. The ELECTIVE
  // discrete-math domain is deliberately absent: it is seeded (so it appears
  // in back-compat all-seeded counts, ALL_SEEDED below) but never probed
  // automatically (convex/__tests__/electiveDomains.test.ts).
  const REGISTERED = [
    "whole-number-arithmetic",
    "fraction-arithmetic",
    "probability",
    "geometry-measurement",
    "ratio-proportion-percent",
    "integers-coordinates",
    "early-algebra",
    "algebra-1",
  ];
  const ALL_SEEDED = [...REGISTERED, "discrete-math"];

  /** A check-in scholar with a grade on file. Since finish-the-check-in (founder
   *  2026-08-18) automatic placement eligibility reads a MISSING enrolled grade
   *  as the most restrictive (K) ring, so a grade-less scholar's check-in covers
   *  only the domains reaching down into it. Grade 9 admits the whole registry,
   *  which is what these composition/ordering tests are about; the K-ring
   *  restriction has its own test in checkInSittingBudget.test.ts. */
  async function seedGradedScholar(
    t: ReturnType<typeof convexTest>,
    username: string,
    gradeLevel = "9",
  ) {
    const id = await seedScholar(t, username);
    await t.run(async (ctx) => ctx.db.patch(id, { gradeLevel }));
    return id;
  }

  /** Drive the mixed-placement loop to completion: PRIME (no answer), then grade
   *  one interleaved probe at a time via `kindFor`, until the server reports
   *  `done`. Mirrors how the real client drives it. */
  async function runMixedPlacement(
    asScholar: Awaited<ReturnType<typeof asUser>>,
    scholarId: Id<"users">,
    kindFor: (skillKey: string, domain: string) => V2Kind,
    seed = 7,
  ) {
    const base = { scholarId, seed };
    let cur = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, base);
    const served: { itemId: string; skillKey: string; strand: string; domain: string; grade: string }[] = [];
    for (let i = 0; i < 250 && !cur.done && cur.probe; i++) {
      const probe = cur.probe;
      served.push({
        itemId: probe.itemId,
        skillKey: probe.skillKey,
        strand: probe.strand,
        domain: probe.domain,
        grade: probe.grade,
      });
      const kind = kindFor(probe.skillKey, probe.domain);
      const extra =
        kind === "unknown"
          ? { itemId: probe.itemId, answer: "", dontKnow: true }
          : {
              itemId: probe.itemId,
              answer: kind === "correct" ? (gradeTemplateItem(probe.itemId, "0")?.correctAnswer ?? "0") : "-999999",
            };
      cur = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, { ...base, ...extra });
    }
    return { cur, served };
  }

  async function completedPlacementDomains(t: ReturnType<typeof convexTest>, scholarId: Id<"users">) {
    return await t.run(async (ctx) => {
      const rows = (await ctx.db.query("practicePlacements").collect()).filter(
        (r) => r.scholarId === scholarId,
      );
      return rows.filter((r) => r.status === "complete").map((r) => r.domain).sort();
    });
  }

  async function allMastery(t: ReturnType<typeof convexTest>, scholarId: Id<"users">) {
    return await t.run(async (ctx) =>
      (await ctx.db.query("practiceMastery").collect()).filter((r) => r.scholarId === scholarId),
    );
  }

  test("a fresh scholar needs a check-in; it interleaves probes from EVERY seeded domain, each tagged, and completes when all are placed", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedGradedScholar(t, "mixed_place_a");
    const asScholar = await asUser(t, scholar);

    expect(await asScholar.query(api.practiceSkills.needsAnyPlacement, { scholarId: scholar })).toBe(true);

    const { cur, served } = await runMixedPlacement(asScholar, scholar, () => "correct");
    expect(cur.done).toBe(true);

    // Probes span every registered seeded domain, and each carries its domain tag.
    const servedDomains = new Set(served.map((s) => s.domain));
    for (const d of REGISTERED) expect(servedDomains.has(d), `probed ${d}`).toBe(true);
    expect(served.every((s) => REGISTERED.includes(s.domain))).toBe(true);

    // Probes run in exact PREREQ ORDER. Peer domains may interleave, but every
    // source domain must finish before its dependent domain begins.
    const prerequisites: Record<string, string[]> = {
      "fraction-arithmetic": ["whole-number-arithmetic"],
      probability: ["whole-number-arithmetic", "fraction-arithmetic"],
      "geometry-measurement": ["whole-number-arithmetic", "fraction-arithmetic"],
      "ratio-proportion-percent": ["whole-number-arithmetic", "fraction-arithmetic"],
      "integers-coordinates": [
        "whole-number-arithmetic",
        "fraction-arithmetic",
        "geometry-measurement",
      ],
      "early-algebra": [
        "whole-number-arithmetic",
        "ratio-proportion-percent",
        "integers-coordinates",
      ],
      "algebra-1": [
        "whole-number-arithmetic",
        "early-algebra",
        "geometry-measurement",
        "ratio-proportion-percent",
        "integers-coordinates",
      ],
    };
    for (const [domain, sourceDomains] of Object.entries(prerequisites)) {
      const targetIndices = served
        .map((probe, index) => (probe.domain === domain ? index : -1))
        .filter((index) => index >= 0);
      for (const sourceDomain of sourceDomains) {
        const sourceIndices = served
          .map((probe, index) => (probe.domain === sourceDomain ? index : -1))
          .filter((index) => index >= 0);
        if (sourceIndices.length && targetIndices.length) {
          expect(
            Math.max(...sourceIndices),
            `${sourceDomain} must finish before ${domain}`,
          ).toBeLessThan(Math.min(...targetIndices));
        }
      }
    }

    // Every seeded domain finished with a completed placement row + mastery.
    expect(await completedPlacementDomains(t, scholar)).toEqual([...REGISTERED].sort());
    expect(await asScholar.query(api.practiceSkills.needsAnyPlacement, { scholarId: scholar })).toBe(false);

    // Two-axis source discipline: ALL placement credit is inferred — never green.
    const mastery = await allMastery(t, scholar);
    expect(mastery.length).toBeGreaterThan(0);
    expect(mastery.every((m) => m.source === "placement")).toBe(true);
  });

  test("cross-domain inference: an ISOLATED high credit does NOT amplify, but a contiguous placed-through band does", async () => {
    // Pre-complete whole-number by crediting a set of access-proven nodes (source
    // "placement" — inferred, as the engine writes it) AND stamping the converged
    // placement row a real finalize would have written — since finish-the-check-in
    // (founder 2026-08-18) mastery alone is shadow placement, so without the row
    // whole-number would still be searched and fractions would stay queued behind
    // it. Then prime → the first fraction probe, anchored to the cross-domain-
    // inferred grade prior.
    async function firstFractionProbe(
      username: string,
      opts: { isolated?: string; contiguousThrough?: string },
    ) {
      const t = convexTest(schema, modules);
      await t.mutation(internal.practiceSkills.seedGraph, {});
      const scholar = await seedScholar(t, username);
      const asScholar = await asUser(t, scholar);
      const creditKeys = await t.run(async (ctx) => {
        if (opts.isolated) return [opts.isolated];
        const nodes = await ctx.db
          .query("knowledgeNodes")
          .withIndex("by_domain", (q) => q.eq("domain", "whole-number-arithmetic"))
          .collect();
        const ceiling = gradeRank(opts.contiguousThrough!);
        return nodes
          .filter((n) => n.grade !== undefined && gradeRank(n.grade) >= 0 && gradeRank(n.grade) <= ceiling)
          .map((n) => n.nodeKey);
      });
      await t.run(async (ctx) => {
        for (const skillKey of creditKeys) {
          await ctx.db.insert("practiceMastery", {
            scholarId: scholar,
            skillKey,
            domain: "whole-number-arithmetic",
            repetition: FLUENT_REPS_VALUE,
            halfLifeDays: 4,
            lastPracticedAt: Date.now(),
            frontier: false,
            source: "placement",
            updatedAt: Date.now(),
          });
        }
        await ctx.db.insert("practicePlacements", {
          scholarId: scholar,
          domain: "whole-number-arithmetic",
          status: "complete",
          probesAnswered: creditKeys.length,
          probeLog: creditKeys.map((nodeKey) => ({
            nodeKey,
            strand: "",
            outcome: "correct" as const,
            at: Date.now(),
          })),
          updatedAt: Date.now(),
        });
      });
      const primed = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, {
        scholarId: scholar,
        seed: 7,
      });
      return primed.probe!;
    }

    // The fix (findings §"Why the prior became Grade 7"): a single isolated
    // Grade-5 credit does NOT lift the fraction prior above a single isolated
    // Grade-K credit — an isolated provisional row can no longer amplify across
    // domains (the pre-fix `inferredGradeFloor` took the max row, so this used to
    // seed the fraction probe higher).
    const isoHigh = await firstFractionProbe("mixed_iso_high", { isolated: "mult_2digit_by_2digit" }); // grade 5
    const isoLow = await firstFractionProbe("mixed_iso_low", { isolated: "count_to_10" }); // grade K
    expect(isoHigh.domain).toBe("fraction-arithmetic");
    expect(isoLow.domain).toBe("fraction-arithmetic");
    expect(gradeRank(isoHigh.grade)).toBe(gradeRank(isoLow.grade));

    // The FEATURE is preserved: a genuinely CONTIGUOUS placed-through band (every
    // whole-number node at/below the grade credited) still seeds the fraction
    // probe higher — inference from an earned level shortens the next domain.
    const contigHigh = await firstFractionProbe("mixed_contig_high", { contiguousThrough: "5" });
    const contigLow = await firstFractionProbe("mixed_contig_low", { contiguousThrough: "K" });
    expect(contigHigh.domain).toBe("fraction-arithmetic");
    expect(gradeRank(contigHigh.grade)).toBeGreaterThan(gradeRank(contigLow.grade));
  });

  test("partial-placement folding: a scholar already placed in one domain gets ONLY the missing domains probed; the completed domain never restarts", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedGradedScholar(t, "mixed_fold");
    const asScholar = await asUser(t, scholar);

    // Pre-MAP whole-number: a converged placement row plus the credited rows the
    // engine writes on finalize. It must be folded OUT of the check-in, never
    // re-probed. (Mastery alone would NOT fold it since finish-the-check-in —
    // that is shadow placement, and shadow-placed domains get searched.)
    const preWna = ["count_to_10", "add_within_10"];
    await t.run(async (ctx) => {
      for (const key of preWna) {
        await ctx.db.insert("practiceMastery", {
          scholarId: scholar,
          skillKey: key,
          domain: "whole-number-arithmetic",
          repetition: FLUENT_REPS_VALUE,
          halfLifeDays: 4,
          lastPracticedAt: Date.now(),
          frontier: false,
          source: "placement",
          updatedAt: Date.now(),
        });
      }
      await ctx.db.insert("practicePlacements", {
        scholarId: scholar,
        domain: "whole-number-arithmetic",
        status: "complete",
        probesAnswered: preWna.length,
        probeLog: preWna.map((nodeKey) => ({
          nodeKey,
          strand: "",
          outcome: "correct" as const,
          at: Date.now(),
        })),
        updatedAt: Date.now(),
      });
    });

    // Still needs a check-in (fractions + probability unplaced).
    expect(await asScholar.query(api.practiceSkills.needsAnyPlacement, { scholarId: scholar })).toBe(true);

    const { cur, served } = await runMixedPlacement(asScholar, scholar, () => "correct");
    expect(cur.done).toBe(true);
    // Whole-number was NEVER probed (folded out).
    expect(served.some((s) => s.domain === "whole-number-arithmetic")).toBe(false);
    // The two missing domains WERE probed (folded in). Chronological grade is
    // unknown here, so there is no ring cap — both are probed regardless.
    expect(served.some((s) => s.domain === "fraction-arithmetic")).toBe(true);
    expect(served.some((s) => s.domain === "probability")).toBe(true);

    // The pre-existing whole-number row was never re-opened or appended to.
    const wnaPlacement = await t.run(async (ctx) =>
      ctx.db
        .query("practicePlacements")
        .withIndex("by_scholar_domain", (q) =>
          q.eq("scholarId", scholar).eq("domain", "whole-number-arithmetic"),
        )
        .first(),
    );
    expect(wnaPlacement?.status).toBe("complete");
    expect(wnaPlacement?.probeLog).toHaveLength(preWna.length);

    // Whole-number mastery is exactly our two pre-seeded rows — not restarted / grown.
    const wnaMastery = (await allMastery(t, scholar)).filter(
      (m) => m.domain === "whole-number-arithmetic",
    );
    expect(wnaMastery.map((m) => m.skillKey).sort()).toEqual([...preWna].sort());
  });

  test("a completed check-in never restarts: re-submitting is an idempotent no-op", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedGradedScholar(t, "mixed_done");
    const asScholar = await asUser(t, scholar);

    await runMixedPlacement(asScholar, scholar, () => "correct");
    expect(await asScholar.query(api.practiceSkills.needsAnyPlacement, { scholarId: scholar })).toBe(false);

    const masteryBefore = (await allMastery(t, scholar)).length;
    const attemptsBefore = await t.run(async (ctx) =>
      (await ctx.db.query("practiceAttempts").collect()).filter((a) => a.scholarId === scholar).length,
    );

    // Re-prime a fully-placed scholar → done, no new work.
    const again = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, {
      scholarId: scholar,
      seed: 99,
    });
    expect(again.done).toBe(true);
    expect(again.probe).toBeNull();

    const masteryAfter = (await allMastery(t, scholar)).length;
    const attemptsAfter = await t.run(async (ctx) =>
      (await ctx.db.query("practiceAttempts").collect()).filter((a) => a.scholarId === scholar).length,
    );
    expect(masteryAfter).toBe(masteryBefore);
    expect(attemptsAfter).toBe(attemptsBefore);
  });

  test("mixedPlacementCurrent reports the served probe mid-flow and a per-domain summary when done", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedGradedScholar(t, "mixed_current");
    const asScholar = await asUser(t, scholar);

    // Prime one probe, then read the current probe (resume parity with web/native).
    const primed = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, {
      scholarId: scholar,
      seed: 7,
    });
    expect(primed.probe).not.toBeNull();
    const current = await asScholar.query(api.practiceSkills.mixedPlacementCurrent, { scholarId: scholar });
    expect(current.done).toBe(false);
    expect(current.probe?.itemId).toBe(primed.probe!.itemId);
    // Back-compat ALL-seeded count (includes the elective); the honest
    // header numbers are mapped/eligible.
    expect(current.totalDomains).toBe(ALL_SEEDED.length);
    // 161 → 166 when the `measurement-data` strand landed (2026-08-06). The cap
    // is a per-strand sum of min(PLACEMENT_MAX_PROBES_PER_STRAND=5, probeable
    // nodes), so ONE new strand adds exactly 5 questions to a full Math
    // Check-In. That is the intended, and the only, placement-length cost of
    // the new strand — worth re-reading this number if it ever moves further.
    expect(current.maxQuestions).toBe(166);

    // Finish; the current read now reports done + a per-domain summary row each.
    await runMixedPlacement(asScholar, scholar, () => "correct");
    const doneRead = await asScholar.query(api.practiceSkills.mixedPlacementCurrent, { scholarId: scholar });
    expect(doneRead.done).toBe(true);
    expect(doneRead.perDomain.map((d) => d.domain).sort()).toEqual([...ALL_SEEDED].sort());
    // Every CORE domain completes; the elective is deliberately untouched by
    // the automatic run (it completes only via a deliberate open).
    for (const d of doneRead.perDomain) {
      expect(d.complete, d.domain).toBe(d.domain !== "discrete-math");
    }
  });

  test("a folded (done) domain carrying a STALE served probe is never re-served", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "mixed_stale");
    const asScholar = await asUser(t, scholar);

    // Whole-number is MAPPED (a converged run + its credited mastery) BUT the row
    // still carries a leftover servedProbe — the exact stale state the fold guard
    // must ignore (never re-serve / re-grade a mapped domain's probe). Note the
    // row must be `complete`: since finish-the-check-in an in-progress row with
    // mastery is SHADOW-PLACED, and its parked probe is deliberately re-served.
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: "count_to_10",
        domain: "whole-number-arithmetic",
        repetition: FLUENT_REPS_VALUE,
        halfLifeDays: 4,
        lastPracticedAt: Date.now(),
        frontier: false,
        source: "placement",
        updatedAt: Date.now(),
      });
      await ctx.db.insert("practicePlacements", {
        scholarId: scholar,
        domain: "whole-number-arithmetic",
        status: "complete",
        probesAnswered: 1,
        probeLog: [{ nodeKey: "count_to_10", strand: "count", outcome: "correct", at: Date.now() }],
        servedProbe: { nodeKey: "count_to_10", strand: "count", itemId: makeItemId("count_to_10", 123), seed: 123 },
        updatedAt: Date.now(),
      });
    });

    const primed = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, { scholarId: scholar, seed: 7 });
    // The first probe must NOT be the stale whole-number one.
    expect(primed.probe?.domain).not.toBe("whole-number-arithmetic");

    const { cur, served } = await runMixedPlacement(asScholar, scholar, () => "correct");
    expect(cur.done).toBe(true);
    expect(served.some((s) => s.domain === "whole-number-arithmetic")).toBe(false);
  });

  test("mixed check-in ignores a stale served probe from a still-gated domain", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const staleSeed = 123;
    const staleItemId = makeItemId("unit_fraction", staleSeed);
    const insertStaleFractionProbe = async (scholarId: Id<"users">) =>
      await t.run(async (ctx) => {
        await ctx.db.insert("practicePlacements", {
          scholarId,
          domain: "fraction-arithmetic",
          status: "in_progress",
          probesAnswered: 0,
          probeLog: [],
          servedProbe: { nodeKey: "unit_fraction", strand: "concept", itemId: staleItemId, seed: staleSeed },
          updatedAt: Date.now(),
        });
      });
    const fractionServedProbe = async (scholarId: Id<"users">) =>
      await t.run(async (ctx) => {
        const row = await ctx.db
          .query("practicePlacements")
          .withIndex("by_scholar_domain", (q) =>
            q.eq("scholarId", scholarId).eq("domain", "fraction-arithmetic"),
          )
          .first();
        return row?.servedProbe;
      });

    const scholar = await seedScholar(t, "mixed_stale_gated_prime");
    const asScholar = await asUser(t, scholar);
    await insertStaleFractionProbe(scholar);

    const currentBefore = await asScholar.query(api.practiceSkills.mixedPlacementCurrent, { scholarId: scholar });
    expect(currentBefore.probe).toBeNull();
    expect(currentBefore.needsStart).toBe(true);

    const primed = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, { scholarId: scholar, seed: 7 });
    expect(primed.probe?.domain).toBe("whole-number-arithmetic");
    expect(await fractionServedProbe(scholar)).toBeFalsy();

    // A direct submit for the stale fractions probe hits the grade path first; it
    // still clears/ignores the gated probe and serves whole-number instead.
    const scholarGrade = await seedScholar(t, "mixed_stale_gated_grade");
    const asScholarGrade = await asUser(t, scholarGrade);
    await insertStaleFractionProbe(scholarGrade);
    const staleSubmit = await asScholarGrade.mutation(api.practiceSkills.submitMixedPlacementAnswer, {
      scholarId: scholarGrade,
      seed: 7,
      itemId: staleItemId,
      answer: "1",
    });
    expect(staleSubmit.graded).toBeNull();
    expect(staleSubmit.probe?.domain).toBe("whole-number-arithmetic");
    expect(await fractionServedProbe(scholarGrade)).toBeFalsy();

    const attempts = await t.run(async (ctx) =>
      (await ctx.db.query("practiceAttempts").collect()).filter((a) => a.scholarId === scholarGrade),
    );
    expect(attempts.some((a) => a.itemId === staleItemId)).toBe(false);
  });

  test("mixed check-in re-serves an unanswered held probe even when its domain is gated", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "mixed_held_gated");
    const asScholar = await asUser(t, scholar);
    const heldSeed = 123;
    const heldItemId = makeItemId("unit_fraction", heldSeed);
    const answeredAt = Date.now() - 1_000;
    const updatedAt = Date.now();
    const probeLog = [
      {
        nodeKey: "partition_shapes",
        strand: "concept",
        outcome: "correct" as const,
        at: answeredAt,
      },
    ];
    const servedProbe = {
      nodeKey: "unit_fraction",
      strand: "concept",
      itemId: heldItemId,
      seed: heldSeed,
    };
    await t.run(async (ctx) => {
      await ctx.db.insert("practicePlacements", {
        scholarId: scholar,
        domain: "fraction-arithmetic",
        status: "in_progress",
        probesAnswered: probeLog.length,
        probeLog,
        servedProbe,
        updatedAt,
      });
    });

    const current = await asScholar.query(
      api.practiceSkills.mixedPlacementCurrent,
      { scholarId: scholar },
    );
    expect(current.probe?.itemId).toBe(heldItemId);

    const primed = await asScholar.mutation(
      api.practiceSkills.submitMixedPlacementAnswer,
      { scholarId: scholar, seed: 7 },
    );
    expect(primed.probe?.itemId).toBe(heldItemId);

    const placement = await t.run((ctx) =>
      ctx.db
        .query("practicePlacements")
        .withIndex("by_scholar_domain", (q) =>
          q
            .eq("scholarId", scholar)
            .eq("domain", "fraction-arithmetic"),
        )
        .first(),
    );
    expect(placement).toMatchObject({
      probesAnswered: 1,
      probeLog,
      servedProbe,
      updatedAt,
    });
    const attempts = await t.run(async (ctx) =>
      (await ctx.db.query("practiceAttempts").collect()).filter(
        (attempt) => attempt.scholarId === scholar,
      ),
    );
    expect(attempts).toEqual([]);
  });

  test("cross-domain prereq gating: dependent domains wait for their arithmetic prerequisites", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedGradedScholar(t, "mixed_gate");
    const asScholar = await asUser(t, scholar);

    // Answer everything correct → whole-number places out, THEN fractions become
    // eligible (they build on division), THEN probability (builds on fractions).
    const { served } = await runMixedPlacement(asScholar, scholar, () => "correct");

    const idxWna = served.map((s, i) => (s.domain === "whole-number-arithmetic" ? i : -1)).filter((i) => i >= 0);
    const idxFrac = served.map((s, i) => (s.domain === "fraction-arithmetic" ? i : -1)).filter((i) => i >= 0);
    const idxProb = served.map((s, i) => (s.domain === "probability" ? i : -1)).filter((i) => i >= 0);
    const idxGeometry = served.map((s, i) => (s.domain === "geometry-measurement" ? i : -1)).filter((i) => i >= 0);
    const idxRatio = served.map((s, i) => (s.domain === "ratio-proportion-percent" ? i : -1)).filter((i) => i >= 0);
    const idxIntegers = served.map((s, i) => (s.domain === "integers-coordinates" ? i : -1)).filter((i) => i >= 0);
    const idxAlgebra = served.map((s, i) => (s.domain === "early-algebra" ? i : -1)).filter((i) => i >= 0);
    const idxAlgebra1 = served.map((s, i) => (s.domain === "algebra-1" ? i : -1)).filter((i) => i >= 0);

    // Every whole-number probe precedes every fraction probe (the gate deferred
    // fractions until whole-number/division was placed).
    if (idxWna.length && idxFrac.length) {
      expect(Math.max(...idxWna)).toBeLessThan(Math.min(...idxFrac));
    }
    // Every fraction probe precedes every probability probe.
    if (idxFrac.length && idxProb.length) {
      expect(Math.max(...idxFrac)).toBeLessThan(Math.min(...idxProb));
    }
    // Geometry applies arrays and fraction multiplication, so it waits for both
    // source domains before its placement probes begin.
    if (idxWna.length && idxGeometry.length) {
      expect(Math.max(...idxWna)).toBeLessThan(Math.min(...idxGeometry));
    }
    if (idxFrac.length && idxGeometry.length) {
      expect(Math.max(...idxFrac)).toBeLessThan(Math.min(...idxGeometry));
    }
    // Ratio work applies multiplication and fraction operations, so it also
    // waits for both arithmetic source domains.
    if (idxWna.length && idxRatio.length) {
      expect(Math.max(...idxWna)).toBeLessThan(Math.min(...idxRatio));
    }
    if (idxFrac.length && idxRatio.length) {
      expect(Math.max(...idxFrac)).toBeLessThan(Math.min(...idxRatio));
    }
    // Signed rational arithmetic builds on whole-number and fraction arithmetic;
    // rational coordinate reads also build on geometry's four-quadrant plane.
    if (idxWna.length && idxIntegers.length) {
      expect(Math.max(...idxWna)).toBeLessThan(Math.min(...idxIntegers));
    }
    if (idxFrac.length && idxIntegers.length) {
      expect(Math.max(...idxFrac)).toBeLessThan(Math.min(...idxIntegers));
    }
    if (idxGeometry.length && idxIntegers.length) {
      expect(Math.max(...idxGeometry)).toBeLessThan(Math.min(...idxIntegers));
    }
    // Early algebra extends arithmetic, signed equations, and proportional
    // tables/graphs, so all three source domains finish before it begins.
    if (idxWna.length && idxAlgebra.length) {
      expect(Math.max(...idxWna)).toBeLessThan(Math.min(...idxAlgebra));
    }
    if (idxRatio.length && idxAlgebra.length) {
      expect(Math.max(...idxRatio)).toBeLessThan(Math.min(...idxAlgebra));
    }
    if (idxIntegers.length && idxAlgebra.length) {
      expect(Math.max(...idxIntegers)).toBeLessThan(Math.min(...idxAlgebra));
    }
    // Algebra 1's hard bridges span arithmetic, early algebra, coordinates,
    // proportional reasoning, and integer operations.
    for (const source of [idxWna, idxAlgebra, idxGeometry, idxRatio, idxIntegers]) {
      if (source.length && idxAlgebra1.length) {
        expect(Math.max(...source)).toBeLessThan(Math.min(...idxAlgebra1));
      }
    }
    // The gate never blocks completion: all seeded domains still get placed.
    expect(await completedPlacementDomains(t, scholar)).toEqual([...REGISTERED].sort());
  });

  test("gated-domain self-select is ALLOWED-with-note: domainsForScholar flags a still-gated domain as prereqGated (never a hard lock)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "mixed_gateflag");
    const asScholar = await asUser(t, scholar);

    // Fresh scholar: nothing placed → fractions (build on whole-number) and
    // probability (build on fractions) are prereq-gated; whole-number is not.
    const before = await asScholar.query(api.practiceSkills.domainsForScholar, { scholarId: scholar });
    const rowOf = (d: string) => before.find((x) => x.domain === d);
    expect(rowOf("whole-number-arithmetic")?.prereqGated).toBe(false);
    expect(rowOf("whole-number-arithmetic")?.prereqGate).toBeNull();
    expect(rowOf("fraction-arithmetic")?.prereqGated).toBe(true);
    expect(rowOf("probability")?.prereqGated).toBe(true);
    expect(rowOf("integers-coordinates")?.prereqGated).toBe(true);
    expect(rowOf("early-algebra")?.prereqGated).toBe(true);
    expect(rowOf("algebra-1")?.prereqGated).toBe(true);
    // The gate NAMES the specific unmet prerequisite (Andy: recommend X, don't
    // hard-block): Fractions builds on "division"; Probability now has both
    // division and fraction bridges, so division is its first unmet concept.
    expect(rowOf("fraction-arithmetic")?.prereqGate?.concept).toBe("division");
    expect(rowOf("fraction-arithmetic")?.prereqGate?.prereqDomain).toBe("whole-number-arithmetic");
    expect(rowOf("probability")?.prereqGate?.concept).toBe("division");
    expect(rowOf("integers-coordinates")?.prereqGate?.concept).toBe("fractions");
    expect(rowOf("early-algebra")?.prereqGate?.concept).toBe("the distributive property");

    // Place whole-number (as the engine writes on finalize) → fractions ungates,
    // probability stays gated (its prereq, fractions, still isn't placed).
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: "division_as_sharing",
        domain: "whole-number-arithmetic",
        repetition: FLUENT_REPS_VALUE,
        halfLifeDays: 4,
        lastPracticedAt: Date.now(),
        frontier: false,
        source: "placement",
        updatedAt: Date.now(),
      });
    });
    const after = await asScholar.query(api.practiceSkills.domainsForScholar, { scholarId: scholar });
    const afterRow = (d: string) => after.find((x) => x.domain === d);
    expect(afterRow("fraction-arithmetic")?.prereqGated).toBe(false);
    expect(afterRow("fraction-arithmetic")?.prereqGate).toBeNull();
    expect(afterRow("probability")?.prereqGated).toBe(true);
    // Probability's note still names its now-primary unmet prereq (fractions).
    expect(afterRow("probability")?.prereqGate?.concept).toBe("fractions");
    expect(afterRow("integers-coordinates")?.prereqGated).toBe(true);
    expect(afterRow("integers-coordinates")?.prereqGate?.concept).toBe("fractions");
    expect(afterRow("early-algebra")?.prereqGated).toBe(true);
    expect(afterRow("algebra-1")?.prereqGated).toBe(true);
    // Once whole-number arithmetic is placed, the new g4 fraction edge is the
    // earliest unmet prerequisite into early algebra.
    expect(afterRow("early-algebra")?.prereqGate?.concept).toBe("fraction multiplication");
  });

  test("post-check-in HANDOFF lands in a REAL first block, not an empty screen (calibrated first block)", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    // A GRADED scholar who answers correctly at/below grade 3 and "I haven't
    // learned this yet" above — the realistic mid-placement whose discovered
    // frontier is a just-flagged don't-know. Pre-fix, the blended hand-off was
    // empty ("Nothing to practice"); the calibration lane now fills the first block.
    const scholar = await t.run(async (ctx) =>
      ctx.db.insert("users", { name: "G3", username: "mixed_handoff", role: "scholar", gradeLevel: "3" }),
    );
    const asScholar = await asUser(t, scholar);

    const base = { scholarId: scholar, seed: 7 };
    let cur = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, base);
    for (let i = 0; i < 250 && !cur.done && cur.probe; i++) {
      const p = cur.probe;
      const g = p.grade === "K" ? 0 : Number(p.grade);
      const correct = !Number.isNaN(g) && g <= 3;
      const extra = correct
        ? { itemId: p.itemId, answer: gradeTemplateItem(p.itemId, "0")?.correctAnswer ?? "0" }
        : { itemId: p.itemId, answer: "", dontKnow: true };
      cur = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, { ...base, ...extra });
    }
    expect(cur.done).toBe(true);

    // The hand-off blends every STARTED domain (what practice.tsx / page.tsx route
    // to after the check-in). It must be NON-EMPTY.
    const info = await asScholar.query(api.practiceSkills.domainsForScholar, { scholarId: scholar });
    const started = info.filter((d) => d.started).map((d) => d.domain);
    expect(started.length).toBeGreaterThan(0);
    const blend = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 11,
      ...(started.length > 1 ? { domains: started } : { domain: started[0] }),
    });
    expect(blend.items.length).toBeGreaterThan(0);
    // …and it's flagged as the first post-placement (calibration) block.
    expect((blend as { firstPostPlacementBlock?: boolean }).firstPostPlacementBlock).toBe(true);

    const playlist = await asScholar.query(
      api.practiceSkills.playlistForScholar,
      { scholarId: scholar, domain: started[0] },
    );
    expect(playlist.firstPostPlacementBlock).toBe(true);
    expect(playlist.practicedToday).toBe(false);
    expect(playlist.everPracticed).toBe(false);
    expect(playlist.set.length).toBeGreaterThan(0);
    expect(playlist.set.every((row) => !row.doneToday)).toBe(true);

    // Source discipline: every served item is inferred placement credit (never a
    // green/demonstrated claim minted by placement) until actually drilled.
    const mastery = (await t.run(async (ctx) =>
      (await ctx.db.query("practiceMastery").collect()).filter((m) => m.scholarId === scholar),
    ));
    expect(mastery.length).toBeGreaterThan(0);
    expect(mastery.every((m) => m.source === "placement")).toBe(true);
  });

  test("an all-not-yet mixed placement hands each automatically entered domain to an aligned runnable foundation without credit", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    // Production pre-warms these conceptual roots with verified items. Seed the
    // same serving contract here; geometry and ratios are fully templated.
    await t.run(async (ctx) => {
      for (const item of [
        {
          skillKey: "count_to_10",
          domain: "whole-number-arithmetic",
          stem: "What number comes after 6?",
        },
        {
          skillKey: "count_to_10",
          domain: "whole-number-arithmetic",
          stem: "What number comes before 8?",
        },
        {
          skillKey: "partition_shapes",
          domain: "fraction-arithmetic",
          stem: "How many equal parts are shown?",
        },
        {
          skillKey: "partition_shapes",
          domain: "fraction-arithmetic",
          stem: "Which shape is split into equal parts?",
        },
        {
          skillKey: "likelihood_scale",
          domain: "probability",
          stem: "Which event is more likely?",
        },
        {
          skillKey: "likelihood_scale",
          domain: "probability",
          stem: "Which event is certain?",
        },
      ]) {
        await ctx.db.insert("practiceItems", {
          ...item,
          answerType: "integer",
          answerCanonical: "1",
          source: "generated",
          verifiedAt: Date.now(),
        });
      }
    });
    const scholar = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "All Not Yet",
        username: "mixed_all_not_yet",
        role: "scholar",
        gradeLevel: "3",
      }),
    );
    const asScholar = await asUser(t, scholar);

    const { cur } = await runMixedPlacement(
      asScholar,
      scholar,
      () => "unknown",
    );
    expect(cur.done).toBe(true);

    const mastery = await allMastery(t, scholar);
    expect(mastery.length).toBeGreaterThan(0);
    expect(mastery.every((row) => row.source === "placement")).toBe(true);
    expect(mastery.filter((row) => row.repetition >= FLUENT_REPS_VALUE)).toHaveLength(0);

    const placedDomains = await completedPlacementDomains(t, scholar);
    const gradeGatedDomains = REGISTERED.filter(
      (domain) => !placedDomains.includes(domain),
    );
    // Grade-3 automatic placement stops before domains whose whole graph begins
    // above the initial grade+2 ring. They remain unmapped for deliberate entry.
    expect(gradeGatedDomains).toContain("ratio-proportion-percent");
    expect(
      mastery.some((row) => row.domain === "ratio-proportion-percent"),
    ).toBe(false);

    const selectedByDomain = new Map<string, string>();
    for (const domain of placedDomains) {
      const playlist = await asScholar.query(
        api.practiceSkills.playlistForScholar,
        { scholarId: scholar, domain },
      );
      expect(playlist.firstPostPlacementBlock, domain).toBe(true);
      expect(playlist.set.length, domain).toBeGreaterThan(0);
      const session = await asScholar.query(api.practiceSkills.practiceSession, {
        scholarId: scholar,
        domain,
        size: 1,
        seed: 29,
      });
      expect(session.items, domain).toHaveLength(1);
      expect(session.items[0].lane, domain).toBe("new");
      selectedByDomain.set(domain, session.items[0].skillKey);

      const row = mastery.find(
        (candidate) =>
          candidate.domain === domain &&
          candidate.skillKey === session.items[0].skillKey,
      );
      if (row) {
        expect(row.repetition, domain).toBe(0);
        expect(row.frontier, domain).toBe(true);
      } else {
        // An untouched runnable root can be served without manufacturing a
        // mastery row. That is still zero credit; the session assertion above
        // proves the selected foundation is runnable.
        expect(["geometry-measurement", "probability"]).toContain(domain);
      }
    }
    for (const domain of gradeGatedDomains) {
      const playlist = await asScholar.query(
        api.practiceSkills.playlistForScholar,
        { scholarId: scholar, domain },
      );
      expect(playlist.firstPostPlacementBlock, domain).toBe(false);
    }

    // A mixed block has a bounded active-strand budget, so rotate the multi-domain
    // request order and prove every automatically-placed foundation participates
    // across deterministic blocks (rather than weakening the invariant to
    // whichever domains happen to fit one block).
    const seenFoundations = new Set<string>();
    for (let offset = 0; offset < placedDomains.length; offset++) {
      const domains = [
        ...placedDomains.slice(offset),
        ...placedDomains.slice(0, offset),
      ];
      const mixed = await asScholar.query(api.practiceSkills.practiceSession, {
        scholarId: scholar,
        domains,
        size: placedDomains.length * 2,
        seed: 29 + offset,
      });
      expect(mixed.firstPostPlacementBlock).toBe(true);
      expect(mixed.domains).toEqual(domains);
      for (const item of mixed.items) {
        if (!item.domain) continue;
        const selected = selectedByDomain.get(item.domain);
        if (item.skillKey === selected && item.lane === "new") {
          seenFoundations.add(item.domain);
        }
      }
    }
    expect(seenFoundations).toEqual(new Set(placedDomains));
  });
});

describe("practiceSkills — first post-placement manipulative", () => {
  async function seedCompletedPlacement(
    t: ReturnType<typeof convexTest>,
    scholarId: Id<"users">,
    withManipulative: boolean,
  ) {
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("practicePlacements", {
        scholarId,
        domain: "whole-number-arithmetic",
        status: "complete",
        probesAnswered: 2,
        probeLog: [],
        updatedAt: now,
      });
      for (const skillKey of ["cardinality_within_10", "count_to_10"]) {
        await ctx.db.insert("practiceMastery", {
          scholarId,
          skillKey,
          domain: "whole-number-arithmetic",
          strand: "counting",
          repetition: FLUENT_REPS_VALUE,
          halfLifeDays: 4,
          lastPracticedAt: now,
          frontier: false,
          source: "placement",
          updatedAt: now,
        });
      }
      if (withManipulative) {
        await ctx.db.insert("practiceItems", {
          skillKey: "count_to_10",
          domain: "whole-number-arithmetic",
          stem: "Build a set of ten.",
          answerType: "manipulative",
          answerCanonical: "",
          verifierKind: "manipulative",
          manipulativeSpec: JSON.stringify({
            kind: "distributor",
            id: "post-placement-count-to-10",
            concept: "count_to_10",
            prompt: "Build a set of ten.",
            goal: { type: "totalCount", count: 10 },
          }),
          source: "authored",
          verifiedAt: now,
        });
      }
    });
  }

  test("starts single- and mixed-domain first blocks with a credited-skill manipulative", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "postplacement_manipulative");
    await seedCompletedPlacement(t, scholar, true);
    const asScholar = await asUser(t, scholar);

    const single = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      domain: "whole-number-arithmetic",
      size: 8,
      seed: 41,
    });
    expect(single.firstPostPlacementBlock).toBe(true);
    expect(single.items[0].answerType).toBe("manipulative");
    expect(single.items[0].skillKey).toBe("count_to_10");

    const mixed = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      domains: ["whole-number-arithmetic", "fraction-arithmetic"],
      size: 8,
      seed: 41,
    });
    expect(mixed.firstPostPlacementBlock).toBe(true);
    expect(mixed.items[0].answerType).toBe("manipulative");
    expect(mixed.items[0].skillKey).toBe("count_to_10");
  });

  test("keeps the existing first-block order when no manipulative rows exist", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "postplacement_no_manipulative");
    await seedCompletedPlacement(t, scholar, false);
    const asScholar = await asUser(t, scholar);

    const session = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      domain: "whole-number-arithmetic",
      size: 8,
      seed: 41,
    });
    expect(session.firstPostPlacementBlock).toBe(true);
    expect(session.items).toHaveLength(8);
    expect(session.items[0].skillKey).toBe("count_objects_within_10");
    expect(session.items.every((item) => item.answerType !== "manipulative")).toBe(
      true,
    );
  });
});

describe("practiceSkills — fact sprint serve coverage", () => {
  test("unscoped single and mixed runs activate from weak facts while scoped runs stay exact", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "fact_sprint_unscoped");
    const asScholar = await asUser(t, scholar);
    const now = Date.now();
    const domain = "whole-number-arithmetic";
    const activeFamily = "mult_facts_7_8_9";

    await t.run(async (ctx) => {
      for (const row of [
        {
          skillKey: activeFamily,
          strand: "mult-divide",
          repetition: 1,
          halfLifeDays: 1,
          lastPracticedAt: now - 30 * 86_400_000,
          latencyMedianMs: 1_000,
        },
        {
          skillKey: "count_to_10",
          strand: "counting",
          repetition: 5,
          halfLifeDays: 100,
          lastPracticedAt: now,
          latencyMedianMs: 1_100,
        },
        {
          skillKey: "count_to_20",
          strand: "counting",
          repetition: 5,
          halfLifeDays: 100,
          lastPracticedAt: now,
          latencyMedianMs: 1_200,
        },
      ]) {
        await ctx.db.insert("practiceMastery", {
          scholarId: scholar,
          domain,
          frontier: false,
          source: "practice",
          updatedAt: now,
          latencySamplesMs: [row.latencyMedianMs],
          latencySpreadMs: 0,
          ...row,
        });
      }
    });

    const singleArgs = {
      scholarId: scholar,
      domain,
      seed: 71,
      size: 5,
    };
    const dormant = await asScholar.query(
      api.practiceSkills.practiceSession,
      singleArgs,
    );
    expect(dormant.items.map((item) => item.skillKey)).toContain(activeFamily);
    expect(
      dormant.segments.some((segment) => segment.kind === "fact_sprint"),
    ).toBe(false);

    await t.run(async (ctx) => {
      for (const factKey of [
        "mul:3x7",
        "mul:3x8",
        "mul:3x9",
        "mul:4x7",
        "mul:4x8",
        "mul:4x9",
        "mul:6x7",
        "mul:6x8",
        "mul:6x9",
      ]) {
        await ctx.db.insert("factFluency", {
          scholarId: scholar,
          factKey,
          // Regression: the last attempt came through the overlapping ×3/4/6
          // family, but this run is actively serving ×7/8/9.
          skillKey: "mult_facts_3_4_6",
          domain,
          seenCount: 6,
          correctCount: 2,
          lastSeenAt: now,
        });
      }
    });

    const single = await asScholar.query(
      api.practiceSkills.practiceSession,
      singleArgs,
    );
    const firstSingleSprint = single.items.findIndex(
      (item) => item.isFactSprint,
    );
    const lastSingleReview = single.items.findLastIndex(
      (item) => item.lane === "review",
    );
    const lastSingleSprint = single.items.findLastIndex(
      (item) => item.isFactSprint,
    );
    const firstSingleFrontier = single.items.findIndex(
      (item, index) =>
        index > lastSingleSprint &&
        item.lane !== "review" &&
        !item.isFactSprint,
    );
    expect(lastSingleReview).toBeGreaterThanOrEqual(0);
    expect(firstSingleSprint).toBe(lastSingleReview + 1);
    expect(lastSingleSprint).toBeLessThan(firstSingleFrontier);
    expect(
      single.items.every(
        (item, index) =>
          item.lane !== "review" || index < firstSingleSprint,
      ),
    ).toBe(true);
    expect(
      single.items
        .filter((item) => item.isFactSprint)
        .every((item) => item.skillKey === activeFamily),
    ).toBe(true);
    expect(
      single.segments.reduce((sum, segment) => sum + segment.count, 0),
    ).toBe(single.items.length);

    const mixed = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      domains: [domain, "probability"],
      seed: 72,
      size: 6,
    });
    const firstMixedSprint = mixed.items.findIndex(
      (item) => item.isFactSprint,
    );
    const lastMixedReview = mixed.items.findLastIndex(
      (item) => item.lane === "review",
    );
    const lastMixedSprint = mixed.items.findLastIndex(
      (item) => item.isFactSprint,
    );
    const firstMixedFrontier = mixed.items.findIndex(
      (item, index) =>
        index > lastMixedSprint &&
        item.lane !== "review" &&
        !item.isFactSprint,
    );
    expect(lastMixedReview).toBeGreaterThanOrEqual(0);
    expect(firstMixedSprint).toBe(lastMixedReview + 1);
    expect(lastMixedSprint).toBeLessThan(firstMixedFrontier);
    expect(
      mixed.items.every(
        (item, index) =>
          item.lane !== "review" || index < firstMixedSprint,
      ),
    ).toBe(true);
    expect(
      mixed.segments.reduce((sum, segment) => sum + segment.count, 0),
    ).toBe(mixed.items.length);

    const issuer = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Lehua Torres",
        username: "fact_sprint_issuer",
        role: "teacher",
      }),
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("calculatorLicenses", {
        scholarId: scholar,
        issuedAt: now,
        issuedBy: issuer,
      });
    });

    const licensedSingle = await asScholar.query(
      api.practiceSkills.practiceSession,
      singleArgs,
    );
    expect(licensedSingle.items.some((item) => item.isFactSprint)).toBe(false);
    expect(
      licensedSingle.segments.some((segment) => segment.kind === "fact_sprint"),
    ).toBe(false);
    expect(licensedSingle.items.map((item) => item.itemId)).toEqual(
      single.items.filter((item) => !item.isFactSprint).map((item) => item.itemId),
    );

    const licensedMixed = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      domains: [domain, "probability"],
      seed: 72,
      size: 6,
    });
    expect(licensedMixed.items.some((item) => item.isFactSprint)).toBe(false);
    expect(
      licensedMixed.segments.some((segment) => segment.kind === "fact_sprint"),
    ).toBe(false);
    expect(licensedMixed.items.map((item) => item.itemId)).toEqual(
      mixed.items.filter((item) => !item.isFactSprint).map((item) => item.itemId),
    );

    const scoped = await asScholar.query(api.practiceSkills.practiceSession, {
      ...singleArgs,
      skillKeys: [activeFamily],
    });
    expect(scoped.items).toHaveLength(singleArgs.size);
    expect(scoped.items.some((item) => item.isFactSprint)).toBe(false);
    expect(
      scoped.segments.some((segment) => segment.kind === "fact_sprint"),
    ).toBe(false);
  });
});

describe("practiceSkills — implicit and standing serving", () => {
  test("with no checkpoint, playlist and session resolve via autoBlend", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "implicit_auto_blend");
    const asScholar = await asUser(t, scholar);

    const playlist = await asScholar.query(
      api.practiceSkills.playlistForScholar,
      { scholarId: scholar },
    );
    expect(playlist.domain).toBe("whole-number-arithmetic");
    expect(playlist).not.toHaveProperty("focusScope");

    const session = await asScholar.query(
      api.practiceSkills.practiceSession,
      { scholarId: scholar, seed: 17, size: 5 },
    );
    expect(session.domain).toBe("whole-number-arithmetic");
    expect(session.segments.every((segment) => segment.kind !== "sweep")).toBe(
      true,
    );

    // An explicit elective domain remains available instead of being restricted
    // to the automatic blend's initial choice.
    const probabilityPlaylist = await asScholar.query(
      api.practiceSkills.playlistForScholar,
      { scholarId: scholar, domain: "probability" },
    );
    expect(probabilityPlaylist.domain).toBe("probability");
    expect(probabilityPlaylist.set.length).toBeGreaterThan(0);
  });

  test("a standing assignment supersedes automatic blend selection", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "standing_assignment_wins");
    await t.run((ctx) =>
      ctx.db.insert("assignments", {
        teacherId: scholar,
        scholarIds: [scholar],
        title: "Probability practice",
        practiceMode: "standing",
        practiceConfig: { domain: "probability" },
        startedAt: Date.now(),
        activitySchedule: [],
      }),
    );
    const asScholar = await asUser(t, scholar);

    const playlist = await asScholar.query(
      api.practiceSkills.playlistForScholar,
      { scholarId: scholar },
    );
    expect(playlist.domain).toBe("probability");

    const session = await asScholar.query(
      api.practiceSkills.practiceSession,
      { scholarId: scholar, seed: 18, size: 5 },
    );
    expect(session.domain).toBe("probability");
  });
});

describe("practiceSkills — checkpoint soft preference (mathGroupCheckpoint / scholarCheckpointOverride)", () => {
  const DAY_MS = 86_400_000;

  async function insertMastery(
    t: ReturnType<typeof convexTest>,
    scholarId: Id<"users">,
    args: {
      skillKey: string;
      domain: string;
      strand: string;
      agoDays: number;
      attempted: boolean;
    },
  ) {
    const at = Date.now() - args.agoDays * DAY_MS;
    await t.run((ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId,
        skillKey: args.skillKey,
        domain: args.domain,
        strand: args.strand,
        repetition: 4,
        halfLifeDays: 1,
        lastPracticedAt: at,
        ...(args.attempted ? { lastAttemptAt: at } : {}),
        frontier: false,
        source: "practice",
        updatedAt: at,
      }),
    );
  }

  test("a soft checkpoint retains cross-domain review", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "checkpoint_soft_runtime");
    await insertMastery(t, scholar, {
      skillKey: "unit_fraction",
      domain: "fraction-arithmetic",
      strand: "concept",
      agoDays: 20,
      attempted: true,
    });
    await t.run(async (ctx) => {
      const groupId = await ctx.db.insert("scholarGroups", {
        teacherId: scholar,
        name: "Current Math",
        scholarIds: [scholar],
      });
      await ctx.db.insert("mathGroupCheckpoint", {
        groupId,
        domain: "whole-number-arithmetic",
        strand: "counting",
        grade: "K",
        updatedBy: scholar,
        updatedAt: Date.now(),
      });
      for (const { domain } of PRACTICE_DOMAINS) {
        await ctx.db.insert("practicePlacements", {
          scholarId: scholar,
          domain,
          status: "complete",
          probesAnswered: 1,
          probeLog: [],
          updatedAt: Date.now(),
        });
        await ctx.db.insert("practiceAttempts", {
          scholarId: scholar,
          nodeKey: `${domain}_prior`,
          itemId: `${domain}_prior`,
          correct: true,
          domain,
          lane: "frontier",
          createdAt: Date.now(),
        });
      }
    });
    const asScholar = await asUser(t, scholar);

    const playlist = await asScholar.query(
      api.practiceSkills.playlistForScholar,
      {
        scholarId: scholar,
        domain: "fraction-arithmetic",
        includeMapping: true,
      },
    );
    expect(playlist.domain).toBe("whole-number-arithmetic");

    const session = await asScholar.query(
      api.practiceSkills.practiceSession,
      {
        scholarId: scholar,
        domain: "fraction-arithmetic",
        includeMapping: true,
        seed: 77,
        size: 6,
      },
    );
    expect(new Set(session.domains)).toEqual(
      new Set(["whole-number-arithmetic", "fraction-arithmetic"]),
    );
    expect(
      session.items.some(
        (item) =>
          item.skillKey === "unit_fraction" &&
          item.domain === "fraction-arithmetic" &&
          item.lane === "review",
      ),
    ).toBe(true);
    const countingKeys = new Set(
      (
        await t.run((ctx) =>
          ctx.db
            .query("knowledgeNodes")
            .withIndex("by_domain_strand", (q) =>
              q
                .eq("domain", "whole-number-arithmetic")
                .eq("strand", "counting"),
            )
            .collect(),
        )
      ).map((node) => node.nodeKey),
    );
    expect(
      session.items.some(
        (item) =>
          item.domain === "whole-number-arithmetic" &&
          item.lane === "new" &&
          countingKeys.has(item.skillKey),
      ),
    ).toBe(true);
  });

  test("an exhausted checkpoint band still falls back to ordinary runnable work in the same domain", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "checkpoint_exhausted_fallback");
    const groupId = await t.run((ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: scholar,
        name: "Counting Checkpoint",
        scholarIds: [scholar],
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert("mathGroupCheckpoint", {
        groupId,
        domain: "whole-number-arithmetic",
        strand: "counting",
        grade: "K",
        updatedBy: scholar,
        updatedAt: Date.now(),
      }),
    );
    const countingKKeys = (
      await t.run((ctx) =>
        ctx.db
          .query("knowledgeNodes")
          .withIndex("by_domain_strand", (q) =>
            q.eq("domain", "whole-number-arithmetic").eq("strand", "counting"),
          )
          .collect(),
      )
    )
      .filter((node) => node.grade === "K")
      .map((node) => node.nodeKey);
    expect(countingKKeys.length).toBeGreaterThan(0);

    // Master the ENTIRE checkpoint band — it is exhausted (bandMode "deeper"),
    // and a soft steer, unlike a hard access gate, must never strand the
    // scholar there with nothing runnable left to serve.
    await t.run(async (ctx) => {
      for (const skillKey of countingKKeys) {
        const at = Date.now() - 5 * DAY_MS;
        await ctx.db.insert("practiceMastery", {
          scholarId: scholar,
          skillKey,
          domain: "whole-number-arithmetic",
          strand: "counting",
          repetition: FLUENT_REPS_VALUE,
          halfLifeDays: 60,
          lastPracticedAt: at,
          lastAttemptAt: at,
          frontier: false,
          source: "practice",
          updatedAt: at,
        });
      }
    });
    const asScholar = await asUser(t, scholar);

    expect(
      await asScholar.query(api.mathFocus.myMathCheckpoint, {}),
    ).toMatchObject({ mode: "deeper" });

    const session = await asScholar.query(
      api.practiceSkills.practiceSession,
      { scholarId: scholar, seed: 19, size: 5 },
    );
    // The checkpoint's domain still serves — from OUTSIDE the exhausted band —
    // ordinary runnable practice, never an empty/stuck session.
    expect(session.domain).toBe("whole-number-arithmetic");
    expect(session.items.length).toBeGreaterThan(0);
    expect(
      session.items.some((item) => !countingKKeys.includes(item.skillKey)),
    ).toBe(true);
  });
});

describe("practiceSkills — gradeBandsForKeys (kinder read-aloud gate)", () => {
  test("returns the grade band only for keyed nodes that carry one", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "count_to_10",
        label: "Count to 10",
        domain: "whole-number-arithmetic",
        grade: "K",
      });
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "add_within_100",
        label: "Add within 100",
        domain: "whole-number-arithmetic",
        grade: "2",
      });
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "no_grade_node",
        label: "Ungraded",
        domain: "whole-number-arithmetic",
      });
    });

    const map = await t.query(api.practiceSkills.gradeBandsForKeys, {
      // includes a duplicate and a totally unknown key
      skillKeys: [
        "count_to_10",
        "add_within_100",
        "no_grade_node",
        "count_to_10",
        "nonexistent_key",
      ],
    });

    expect(map).toEqual({ count_to_10: "K", add_within_100: "2" });
  });

  test("empty input yields an empty map", async () => {
    const t = convexTest(schema, modules);
    const map = await t.query(api.practiceSkills.gradeBandsForKeys, {
      skillKeys: [],
    });
    expect(map).toEqual({});
  });
});
