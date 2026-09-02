import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

// ── THE DEAD-PROBE ESCAPE (resumed check-in blank screen, 2026-08-18) ───────
//
// A parked `servedProbe` is a REFERENCE (nodeKey + seed / stored-item ref), and
// content moves on underneath it: a graph reseed can remove or rename the node
// it points at, after which `resolvePlacementProbe` correctly returns null
// ("treat as unresolvable, re-prime"). The serving loops must honor that
// contract: a dead parked probe is CLEARED and the next real probe is served.
//
// Before the fix, both loops wrapped the null and handed it back — the prime
// mutation returned `{ done: false, paused: false, probe: null }` forever, and
// the client parked a resumed check-in on a blank quiz card whose Check /
// "I haven't learned this yet" buttons are no-op guards (`if (!probe) return`).
// A real scholar resuming a pre-content-change check-in hit exactly this.

const modules = (import.meta as ImportMeta & { glob: (p: string) => Record<string, () => Promise<unknown>> }).glob("../**/*.ts");

const WHOLE = "whole-number-arithmetic";

async function seedScholar(t: ReturnType<typeof convexTest>, username: string) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "Dead-probe Scholar", username, role: "scholar" }),
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

async function rowFor(t: ReturnType<typeof convexTest>, scholarId: Id<"users">, domain: string) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("practicePlacements").collect()).find(
      (r) => r.scholarId === scholarId && r.domain === domain,
    ) ?? null,
  );
}

/** Point the parked probe at a node the graph no longer contains — the shape a
 *  content reseed leaves behind on an in-flight run. */
async function killServedProbe(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  domain: string,
) {
  await t.run(async (ctx) => {
    const row = (await ctx.db.query("practicePlacements").collect()).find(
      (r) => r.scholarId === scholarId && r.domain === domain,
    )!;
    await ctx.db.patch(row._id, {
      servedProbe: {
        nodeKey: "removed_by_content_change",
        strand: row.servedProbe!.strand,
        itemId: "removed_by_content_change#7",
        seed: 7,
      },
    });
  });
}

describe("dead parked probe — the serving loops clear it and move on", () => {
  test("mixed check-in: resume reads needsStart, prime serves a FRESH probe", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "dead_probe_mixed");
    const asScholar = await asUser(t, scholar);

    // Park a live probe, then let "content move on" underneath it.
    const primed = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, {
      scholarId: scholar,
      seed: 41,
    });
    expect(primed.probe).not.toBeNull();
    const domain = primed.probe!.domain;
    await killServedProbe(t, scholar, domain);

    // The resume read must NOT report a phantom served probe: the scholar gets
    // the start CTA, never a blank quiz.
    const current = await asScholar.query(api.practiceSkills.mixedPlacementCurrent, {
      scholarId: scholar,
    });
    expect(current.probe).toBeNull();
    expect(current.done).toBe(false);
    expect(current.needsStart).toBe(true);

    // Priming clears the corpse and serves the next REAL probe.
    const reprimed = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, {
      scholarId: scholar,
      seed: 43,
    });
    expect(reprimed.done).toBe(false);
    expect(reprimed.probe).not.toBeNull();
    expect(reprimed.probe!.itemId).not.toBe("removed_by_content_change#7");
    expect(reprimed.probe!.stem).toBeTruthy();

    const row = await rowFor(t, scholar, reprimed.probe!.domain);
    expect(row?.servedProbe?.itemId).toBe(reprimed.probe!.itemId);
  });

  test("mixed check-in: a stale submit against a dead probe grades nothing and serves fresh", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "dead_probe_mixed_stale");
    const asScholar = await asUser(t, scholar);

    const primed = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, {
      scholarId: scholar,
      seed: 71,
    });
    const domain = primed.probe!.domain;
    await killServedProbe(t, scholar, domain);

    // A submit whose itemId no longer matches anything (the client's probe went
    // stale) must stay an idempotent no-op — nothing graded — and must NOT echo
    // the dead probe: it re-serves a real one.
    const res = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, {
      scholarId: scholar,
      seed: 73,
      itemId: "whatever#1",
      answer: "0",
    });
    expect(res.graded).toBeNull();
    expect(res.done).toBe(false);
    expect(res.probe).not.toBeNull();
    expect(res.probe!.itemId).not.toBe("removed_by_content_change#7");
    const row = await rowFor(t, scholar, res.probe!.domain);
    expect(row?.probeLog ?? []).toHaveLength(0);
  });

  test("mixed check-in: a submit MATCHING the dead probe's itemId grades nothing (no throw) and serves fresh", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "dead_probe_mixed_match");
    const asScholar = await asUser(t, scholar);

    const primed = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, {
      scholarId: scholar,
      seed: 91,
    });
    const domain = primed.probe!.domain;
    await killServedProbe(t, scholar, domain);

    // The scholar's screen still shows the (now dead) probe and they tap Check:
    // the submit's itemId MATCHES the parked corpse. Grading must be a no-op
    // that re-serves — never a throw (which strands the client mid-submit).
    const res = await asScholar.mutation(api.practiceSkills.submitMixedPlacementAnswer, {
      scholarId: scholar,
      seed: 93,
      itemId: "removed_by_content_change#7",
      answer: "0",
    });
    expect(res.graded).toBeNull();
    expect(res.done).toBe(false);
    expect(res.probe).not.toBeNull();
    expect(res.probe!.itemId).not.toBe("removed_by_content_change#7");
    const row = await rowFor(t, scholar, res.probe!.domain);
    expect(row?.probeLog ?? []).toHaveLength(0);
  });

  test("single-domain placement: prime falls through the dead probe to a fresh one", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "dead_probe_single");
    const asScholar = await asUser(t, scholar);

    const primed = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, {
      scholarId: scholar,
      domain: WHOLE,
      seed: 61,
    });
    expect(primed.probe).not.toBeNull();
    await killServedProbe(t, scholar, WHOLE);

    const reprimed = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, {
      scholarId: scholar,
      domain: WHOLE,
      seed: 63,
    });
    expect(reprimed.done).toBe(false);
    expect(reprimed.probe).not.toBeNull();
    expect(reprimed.probe!.itemId).not.toBe("removed_by_content_change#7");
    expect(reprimed.probe!.stem).toBeTruthy();
  });

  test("single-domain placement: a stale submit against a dead probe grades nothing and serves fresh", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "dead_probe_single_stale");
    const asScholar = await asUser(t, scholar);

    await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, {
      scholarId: scholar,
      domain: WHOLE,
      seed: 81,
    });
    await killServedProbe(t, scholar, WHOLE);

    const res = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, {
      scholarId: scholar,
      domain: WHOLE,
      seed: 83,
      itemId: "whatever#1",
      answer: "0",
    });
    expect(res.graded).toBeNull();
    expect(res.done).toBe(false);
    expect(res.probe).not.toBeNull();
    expect(res.probe!.itemId).not.toBe("removed_by_content_change#7");
    const row = await rowFor(t, scholar, WHOLE);
    expect(row?.probeLog ?? []).toHaveLength(0);
    expect(row?.servedProbe?.itemId).toBe(res.probe!.itemId);
  });

  test("single-domain placement: a submit MATCHING the dead probe's itemId grades nothing (no throw) and serves fresh", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await seedScholar(t, "dead_probe_single_match");
    const asScholar = await asUser(t, scholar);

    await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, {
      scholarId: scholar,
      domain: WHOLE,
      seed: 101,
    });
    await killServedProbe(t, scholar, WHOLE);

    const res = await asScholar.mutation(api.practiceSkills.submitPlacementAnswer, {
      scholarId: scholar,
      domain: WHOLE,
      seed: 103,
      itemId: "removed_by_content_change#7",
      answer: "0",
    });
    expect(res.graded).toBeNull();
    expect(res.done).toBe(false);
    expect(res.probe).not.toBeNull();
    expect(res.probe!.itemId).not.toBe("removed_by_content_change#7");
    const row = await rowFor(t, scholar, WHOLE);
    expect(row?.probeLog ?? []).toHaveLength(0);
  });
});
