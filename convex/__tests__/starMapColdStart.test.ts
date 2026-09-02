import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { SeedOrigin, SeedStatus } from "../lib/seeds";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function makeScholar(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { name: "Scholar", username: "scholar", role: "scholar" }),
  );
}

async function seed(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  origin: SeedOrigin,
  topic: string,
  opts: { status?: SeedStatus; domain?: string } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("seeds", {
      scholarId,
      origin,
      status: opts.status ?? "pending",
      topic,
      domain: opts.domain,
      suggestionType: origin === "ai-constellation" ? "leap" : "frontier",
      rationale: "because",
      sourceLens: origin === "ai-constellation" ? "interpretive" : undefined,
    }),
  );
}

async function signal(t: ReturnType<typeof convexTest>, scholarId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("sessions", { userId: scholarId, title: "s", isArchived: false }),
  );
  await t.run(async (ctx) =>
    ctx.db.insert("sessionSignals", {
      scholarId,
      sessionId,
      signalType: "curiosity",
      description: "leaned in",
      intensity: "medium",
    }),
  );
}

async function connection(t: ReturnType<typeof convexTest>, scholarId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("sessions", { userId: scholarId, title: "s", isArchived: false }),
  );
  await t.run(async (ctx) =>
    ctx.db.insert("crossDomainConnections", {
      scholarId,
      domains: ["Biology", "Math"],
      conceptLabels: ["fairness"],
      description: "bridged fairness to sharing",
      sessionId,
      studentInitiated: true,
    }),
  );
}

describe("maybeChartFirstSky — cold-start auto-trigger", () => {
  test("fires ONCE: bails if the scholar already has any ai-constellation star", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeScholar(t);
    // A dismissed constellation star still means we've charted before — never re-chart.
    await seed(t, scholarId, "ai-constellation", "Old star", { status: "dismissed" });
    // Plenty of interest signal, so only the fire-once guard can stop it.
    await seed(t, scholarId, "ai", "sharks");
    await seed(t, scholarId, "ai", "redstone");
    await seed(t, scholarId, "ai", "origami");

    const res = await t.mutation(internal.interpretiveHelpers.maybeChartFirstSky, {
      scholarId,
    });
    expect(res.charted).toBe(false);
    expect(res.reason).toBe("already-charted");
  });

  test("holds below the floor: thin signal does not chart", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeScholar(t);
    // One interest-seed only → score 1 < floor 3.
    await seed(t, scholarId, "ai", "sharks");

    const res = await t.mutation(internal.interpretiveHelpers.maybeChartFirstSky, {
      scholarId,
    });
    expect(res.charted).toBe(false);
    expect(res.reason).toBe("below-floor");
  });

  test("charts once the floor is cleared (3 harvested interest-seeds)", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeScholar(t);
    await seed(t, scholarId, "ai", "sharks");
    await seed(t, scholarId, "ai", "redstone");
    await seed(t, scholarId, "ai", "origami");

    const res = await t.mutation(internal.interpretiveHelpers.maybeChartFirstSky, {
      scholarId,
    });
    expect(res.charted).toBe(true);
  });

  test("a self-made cross-domain connection counts double toward the floor", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeScholar(t);
    // 1 connection (×2 = 2) + 1 signal (1) = 3 → clears the floor.
    await connection(t, scholarId);
    await signal(t, scholarId);

    const res = await t.mutation(internal.interpretiveHelpers.maybeChartFirstSky, {
      scholarId,
    });
    expect(res.charted).toBe(true);
  });

  test("ai-constellation and dev-sky seeds do NOT count toward the interest floor", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeScholar(t);
    // These are not harvested interests — the generator's own output / a fixture.
    await seed(t, scholarId, "dev-sky", "seeded star");
    // (no ai-constellation seed here, so the fire-once guard doesn't trip)

    const res = await t.mutation(internal.interpretiveHelpers.maybeChartFirstSky, {
      scholarId,
    });
    expect(res.charted).toBe(false);
    expect(res.reason).toBe("below-floor");
  });
});

describe("gatherInterests — statedInterests (build-from material)", () => {
  test("surfaces harvested interest-seeds, excludes the generator's own + fixtures", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeScholar(t);
    await seed(t, scholarId, "ai", "shark biology", { domain: "Biology" });
    await seed(t, scholarId, "teacher", "tide pools");
    await seed(t, scholarId, "badge_follow", "knot theory");
    await seed(t, scholarId, "ai-constellation", "vampire bat reciprocity");
    await seed(t, scholarId, "dev-sky", "fixture star");

    const interests = await t.query(internal.interpretiveHelpers.gatherInterests, {
      scholarId,
    });

    // Build-from list: the kid's/teacher's actual sparks, with domain when present.
    expect(interests.statedInterests).toContain("shark biology [Biology]");
    expect(interests.statedInterests).toContain("tide pools");
    expect(interests.statedInterests).toContain("knot theory");
    expect(interests.statedInterests).not.toContain("vampire bat reciprocity");
    expect(interests.statedInterests).not.toContain("fixture star");

    // Anti-repeat list still holds every existing seed topic.
    expect(interests.existingTopics).toContain("vampire bat reciprocity");
    expect(interests.existingTopics).toContain("shark biology");
  });
});
