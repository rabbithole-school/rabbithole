import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { CLOSURE_PROMPT_VERSION } from "../lib/closureLinePrompt";
import type { Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const KIND = "practice" as const;
const SIGNAL_HASH = "practice:test-signal";
const STALE_PROMPT_VERSION = `${CLOSURE_PROMPT_VERSION}-stale`;

async function seedScholar(t: ReturnType<typeof convexTest>): Promise<Id<"users">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Test Scholar",
      username: "test-scholar",
      role: "scholar",
    }),
  );
}

async function seedCachedLine(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  signal: string,
  headline = "Cached closure line.",
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("closureLines", {
      scholarId,
      kind: KIND,
      signalHash: SIGNAL_HASH,
      headline,
      signal,
      model: "test-model",
      createdAt: 1,
    }),
  );
}

async function getCached(t: ReturnType<typeof convexTest>, scholarId: Id<"users">) {
  return await t.query(internal.closureLines.getCached, {
    scholarId,
    kind: KIND,
    signalHash: SIGNAL_HASH,
  });
}

describe("closure line prompt-version cache invalidation", () => {
  test("returns a cache entry generated with the current prompt version", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    await seedCachedLine(
      t,
      scholarId,
      JSON.stringify({ v: CLOSURE_PROMPT_VERSION, wrap: "session" }),
    );

    expect(await getCached(t, scholarId)).toBe("Cached closure line.");
  });

  test("rejects entries from the previous prompt contract or without version metadata", async () => {
    for (const signal of [
      JSON.stringify({ v: STALE_PROMPT_VERSION, wrap: "session" }),
      JSON.stringify({ wrap: "session" }),
      "not-json",
    ]) {
      const t = convexTest(schema, modules);
      const scholarId = await seedScholar(t);
      await seedCachedLine(t, scholarId, signal);

      expect(await getCached(t, scholarId)).toBeNull();
    }
  });

  test("refreshes a stale entry in place and makes it cache-eligible", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    await seedCachedLine(
      t,
      scholarId,
      JSON.stringify({ v: STALE_PROMPT_VERSION, wrap: "session" }),
      "Stale closure line.",
    );

    await t.mutation(internal.closureLines.storeLine, {
      scholarId,
      kind: KIND,
      signalHash: SIGNAL_HASH,
      headline: "Fresh closure line.",
      signal: JSON.stringify({ v: CLOSURE_PROMPT_VERSION, wrap: "session" }),
      model: "test-model",
    });

    expect(await getCached(t, scholarId)).toBe("Fresh closure line.");
    const rows = await t.run(async (ctx) => ctx.db.query("closureLines").collect());
    expect(rows).toHaveLength(1);
  });
});
