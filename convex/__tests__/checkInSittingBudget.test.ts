import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { gradeTemplateItem } from "../lib/practice/session";
import { CHECK_IN_SITTING_PROBE_BUDGET } from "../../shared/practiceLoop";
import { CHECK_IN_DOMAIN_PRIORITY, checkInDomainPriority } from "../lib/practice/domains";

// ── The per-SITTING check-in budget ────────────────────────────────────────
// A governed per-sitting probe budget on the MIXED "Math Check-In": once a
// scholar has answered CHECK_IN_SITTING_PROBE_BUDGET probes in ONE local day
// (across all domains) while domains remain, the server reports `paused` so the
// scholar surface parks warmly ("great mapping today, more tomorrow"). It is a
// SOFT signal — the loop never withholds a probe, so an instant automated driver
// (or these all-correct tests) still maps the full graph. Every in-progress
// domain keeps its resumable state; the next sitting continues where it left off.
// Foundational domains (whole-number then fraction arithmetic) are probed FIRST
// so they place within the first sitting. These NEW assertions never edit the
// existing placement suites (which drive to `done` ignoring `paused`, and so stay
// green unchanged).

const modules = (import.meta as ImportMeta & { glob: (p: string) => Record<string, () => Promise<unknown>> }).glob("../**/*.ts");

afterEach(() => {
  vi.useRealTimers();
});

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

const NON_PRIORITY = [
  "probability",
  "geometry-measurement",
  "ratio-proportion-percent",
  "integers-coordinates",
  "early-algebra",
  "algebra-1",
];

const DAY_MS = 24 * 60 * 60 * 1000;
// Noon in the default institution timezone (Pacific/Honolulu, UTC-10) — a stable
// mid-day instant so every probe answered in a test run lands on the same local
// day regardless of when CI runs.
const DAY1_NOON = new Date("2026-06-15T22:00:00Z").getTime();

/** Seed a check-in scholar. `gradeLevel` defaults to Grade 9 so the affect-safe
 *  ring admits every registered domain: since finish-the-check-in (founder
 *  2026-08-18) a scholar with NO grade on file is gated to the most restrictive
 *  (K) ring, which would leave the high-floor domains out of the check-in
 *  entirely. That restriction has its own test below; these budget/ordering
 *  tests want the full graph. */
async function seedScholar(
  t: ReturnType<typeof convexTest>,
  username: string,
  // `null` (not `undefined` — that would fall back to the default) means "no
  // grade on file", the state the K-ring test below exercises.
  gradeLevel: string | null = "9",
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Sitting Scholar",
      username,
      role: "scholar",
      ...(gradeLevel ? { gradeLevel } : {}),
    }),
  );
}

async function asUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    // A far-future expiration so a multi-day (fake-clock) test never expires auth.
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: 8_000_000_000_000,
    };
    return ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

async function completedPlacementDomains(t: ReturnType<typeof convexTest>, scholarId: Id<"users">) {
  return await t.run(async (ctx) => {
    const rows = (await ctx.db.query("practicePlacements").collect()).filter(
      (r) => r.scholarId === scholarId,
    );
    return rows.filter((r) => r.status === "complete").map((r) => r.domain).sort();
  });
}

async function totalProbeLogLen(t: ReturnType<typeof convexTest>, scholarId: Id<"users">) {
  return await t.run(async (ctx) => {
    const rows = (await ctx.db.query("practicePlacements").collect()).filter(
      (r) => r.scholarId === scholarId,
    );
    return rows.reduce((n, r) => n + (r.probeLog?.length ?? 0), 0);
  });
}

/** Drive the mixed check-in all-correct to `done`, IGNORING `paused` (the soft
 *  signal an automated driver disregards). Records the served order. */
async function runToDone(
  asScholar: Awaited<ReturnType<typeof asUser>>,
  scholarId: Id<"users">,
  seed = 7,
) {
  const base = { scholarId, seed };
  let cur = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, base);
  const served: { itemId: string; domain: string }[] = [];
  for (let i = 0; i < 300 && !cur.done && cur.probe; i++) {
    const p = cur.probe;
    served.push({ itemId: p.itemId, domain: p.domain });
    cur = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, {
      ...base,
      itemId: p.itemId,
      answer: gradeTemplateItem(p.itemId, "0")?.correctAnswer ?? "0",
    });
  }
  return { cur, served };
}

describe("practiceSkills — mixed check-in per-sitting probe budget", () => {
  test("PAUSES exactly at the budget mid-check-in, and never withholds a probe", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(DAY1_NOON);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "sit_pause");
    const asScholar = await asUser(t, scholar);

    const base = { scholarId: scholar, seed: 7 };
    // Prime — 0 answered, not parked.
    let cur = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, base);
    expect(cur.paused).toBe(false);

    let answered = 0;
    let pausedAt = -1;
    for (let i = 0; i < 250 && !cur.done && cur.probe; i++) {
      const p = cur.probe;
      cur = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, {
        ...base,
        itemId: p.itemId,
        answer: gradeTemplateItem(p.itemId, "0")?.correctAnswer ?? "0",
      });
      answered++;
      // Before the budget: never parked. Each graded probe appends exactly one
      // log entry, so the count is 1:1 with answered probes this sitting.
      if (answered < CHECK_IN_SITTING_PROBE_BUDGET) expect(cur.paused).toBe(false);
      if (cur.paused && pausedAt < 0) pausedAt = answered;
      // A real client stops the instant it is told to park.
      if (cur.paused) break;
    }

    // Parked exactly at the budget, mid-check-in (still domains to place), and the
    // server STILL served the next probe (soft signal — never withheld).
    expect(pausedAt).toBe(CHECK_IN_SITTING_PROBE_BUDGET);
    expect(cur.done).toBe(false);
    expect(cur.probe).not.toBeNull();

    // The read query agrees.
    const read = await asScholar.query(api.practiceSkills.mixedPlacementCurrent, {
      scholarId: scholar,
    });
    expect(read.paused).toBe(true);
    expect(read.done).toBe(false);
    expect(read.needsStart).toBe(false);
    expect(read.sittingAnswered).toBe(CHECK_IN_SITTING_PROBE_BUDGET);
    expect(read.sittingBudget).toBe(CHECK_IN_SITTING_PROBE_BUDGET);
    expect(read.sittingMaxQuestions).toBe(CHECK_IN_SITTING_PROBE_BUDGET);
  });

  // pilot7 f19 (review/pilot7/findings-day2-parked.md): a scholar with ≥1
  // placed domain but an INCOMPLETE (or sitting-paused) mixed check-in must
  // still get a runnable drill on their placed domain(s) — the bug was that
  // the WEB client's `checkInAllDomains` gate (app/scholar/practice/page.tsx)
  // took priority over the playlist regardless. This locks in the server-side
  // contract the client fix depends on: `practiceSession` never withholds
  // items just because the mixed check-in isn't done yet.
  test("a paused, incomplete mixed check-in still serves a real practice session on the placed domain(s)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(DAY1_NOON);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "sit_drill_gate");
    const asScholar = await asUser(t, scholar);

    const base = { scholarId: scholar, seed: 7 };
    let cur = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, base);
    for (let i = 0; i < 250 && !cur.done && cur.probe && !cur.paused; i++) {
      const p = cur.probe;
      cur = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, {
        ...base,
        itemId: p.itemId,
        answer: gradeTemplateItem(p.itemId, "0")?.correctAnswer ?? "0",
      });
    }
    // Parked mid-check-in: domains remain unplaced, exactly the pilot7 state.
    expect(cur.paused).toBe(true);
    expect(cur.done).toBe(false);
    expect(
      await asScholar.query(api.practiceSkills.needsAnyPlacement, { scholarId: scholar }),
    ).toBe(true);

    // At least one domain (foundational-first) IS placed by now.
    const info = await asScholar.query(api.practiceSkills.domainsForScholar, { scholarId: scholar });
    const started = info.filter((d) => d.started).map((d) => d.domain);
    expect(started.length).toBeGreaterThan(0);
    expect(started).toContain("whole-number-arithmetic");

    // The exact query the client's blend/strand entry calls — must serve real
    // items, never an empty queue, purely because the cross-domain check-in
    // hasn't finished. This is the "client path" the routing fix relies on.
    const session = await asScholar.query(api.practiceSkills.practiceSession, {
      scholarId: scholar,
      seed: 11,
      ...(started.length > 1 ? { domains: started } : { domain: started[0] }),
    });
    expect(session.items.length).toBeGreaterThan(0);
  });

  test("resumes the NEXT sitting with state intact — nothing restarts, unplaced domains continue to completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(DAY1_NOON);
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "sit_resume");
    const asScholar = await asUser(t, scholar);

    const base = { scholarId: scholar, seed: 7 };
    // Sitting 1: answer correct until the server parks us.
    let cur = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, base);
    for (let i = 0; i < 250 && !cur.done && cur.probe && !cur.paused; i++) {
      const p = cur.probe;
      cur = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, {
        ...base,
        itemId: p.itemId,
        answer: gradeTemplateItem(p.itemId, "0")?.correctAnswer ?? "0",
      });
    }
    expect(cur.paused).toBe(true);

    // Snapshot the parked state: foundational domains already placed, and the
    // day's probe log at exactly the budget.
    const completedDay1 = await completedPlacementDomains(t, scholar);
    const logLenDay1 = await totalProbeLogLen(t, scholar);
    expect(logLenDay1).toBe(CHECK_IN_SITTING_PROBE_BUDGET);
    expect(completedDay1.length).toBeGreaterThan(0);
    // Foundational-first: whole-number arithmetic placed in sitting one.
    expect(completedDay1).toContain("whole-number-arithmetic");

    // Sitting 2: a full local day later, re-enter the check-in.
    vi.setSystemTime(DAY1_NOON + DAY_MS + 60_000);
    const read = await asScholar.query(api.practiceSkills.mixedPlacementCurrent, {
      scholarId: scholar,
    });
    expect(read.paused).toBe(false); // fresh sitting budget
    expect(read.sittingAnswered).toBe(0);
    expect(read.done).toBe(false);
    expect(read.probe).not.toBeNull(); // resumes on the parked served probe

    // State intact across the day flip — no domain restarted, no log lost.
    expect(await completedPlacementDomains(t, scholar)).toEqual(completedDay1);
    expect(await totalProbeLogLen(t, scholar)).toBe(logLenDay1);

    // Drive to completion, rolling the clock forward whenever a sitting parks.
    let cur2 = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, base);
    for (let i = 0; i < 400 && !cur2.done && cur2.probe; i++) {
      const p = cur2.probe;
      cur2 = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, {
        ...base,
        itemId: p.itemId,
        answer: gradeTemplateItem(p.itemId, "0")?.correctAnswer ?? "0",
      });
      if (cur2.paused && !cur2.done) vi.setSystemTime(Date.now() + DAY_MS + 60_000);
    }
    expect(cur2.done).toBe(true);

    // Every domain placed once, and every sitting-1 completion is still complete.
    const finalCompleted = await completedPlacementDomains(t, scholar);
    expect(finalCompleted).toEqual([...REGISTERED].sort());
    for (const d of completedDay1) expect(finalCompleted).toContain(d);
    expect(
      await asScholar.query(api.practiceSkills.needsAnyPlacement, { scholarId: scholar }),
    ).toBe(false);
  });

  test("foundational-first: whole-number then fraction arithmetic lead the check-in", async () => {
    // The pure priority function: whole-number < fraction < everything else.
    expect([...CHECK_IN_DOMAIN_PRIORITY]).toEqual([
      "whole-number-arithmetic",
      "fraction-arithmetic",
    ]);
    expect(checkInDomainPriority("whole-number-arithmetic")).toBeLessThan(
      checkInDomainPriority("fraction-arithmetic"),
    );
    for (const d of NON_PRIORITY) {
      expect(checkInDomainPriority("fraction-arithmetic")).toBeLessThan(
        checkInDomainPriority(d),
      );
    }
    // Unlisted domains share the trailing rank (round-robin among themselves).
    expect(checkInDomainPriority("probability")).toBe(checkInDomainPriority("early-algebra"));

    // Behavioral: the first probe is whole-number, and fractions FULLY place
    // before any non-priority domain is probed.
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "sit_priority");
    const asScholar = await asUser(t, scholar);
    const { cur, served } = await runToDone(asScholar, scholar);
    expect(cur.done).toBe(true);

    expect(served[0].domain).toBe("whole-number-arithmetic");
    const lastFrac = Math.max(
      ...served.map((s, i) => (s.domain === "fraction-arithmetic" ? i : -1)),
    );
    const firstOther = Math.min(
      ...served.map((s, i) => (NON_PRIORITY.includes(s.domain) ? i : Infinity)),
    );
    expect(lastFrac).toBeGreaterThanOrEqual(0);
    expect(lastFrac).toBeLessThan(firstOther);
  });

  test("prereq gating stays unbroken under the new priority ordering", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "sit_gating");
    const asScholar = await asUser(t, scholar);
    const { cur, served } = await runToDone(asScholar, scholar);
    expect(cur.done).toBe(true);

    const idx = (domain: string) =>
      served.map((s, i) => (s.domain === domain ? i : -1)).filter((i) => i >= 0);
    // Every source domain must fully finish before its dependent domain begins —
    // the priority prior never front-runs a prerequisite.
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
    for (const [domain, sources] of Object.entries(prerequisites)) {
      const target = idx(domain);
      for (const source of sources) {
        const src = idx(source);
        if (src.length && target.length) {
          expect(
            Math.max(...src),
            `${source} must finish before ${domain}`,
          ).toBeLessThan(Math.min(...target));
        }
      }
    }
    // Gating never blocks completion: all domains still placed.
    expect(await completedPlacementDomains(t, scholar)).toEqual([...REGISTERED].sort());
  });

  test("NO GRADE ON FILE: the check-in is gated to the K ring, and completes there", async () => {
    // finish-the-check-in (founder 2026-08-18). `domainHasAffectSafeEntry(nodes,
    // undefined)` admits EVERY domain — latent while the check-in served one
    // domain at a time, live under breadth-first serving, and most of the real
    // roster carries no enrolled grade. Automatic eligibility therefore reads a
    // missing grade as the most restrictive real one (K → the grade+2 ring), so
    // only domains with a node at grade ≤ 2 open by themselves.
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "sit_no_grade", null);
    const asScholar = await asUser(t, scholar);

    const { cur } = await runToDone(asScholar, scholar);
    expect(cur.done).toBe(true);
    // The four domains whose graphs reach down into the K ring — and no others.
    expect(await completedPlacementDomains(t, scholar)).toEqual(
      [
        "whole-number-arithmetic",
        "fraction-arithmetic",
        "geometry-measurement",
        "probability",
      ].sort(),
    );
    // The check-in reports itself finished rather than stalling on the domains
    // it will never open automatically; those stay reachable by deliberate pick.
    expect(
      await asScholar.query(api.practiceSkills.needsAnyPlacement, { scholarId: scholar }),
    ).toBe(false);
  });
});
