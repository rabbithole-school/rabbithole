import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { releaseLeaseBeforeClosingStream } from "../sessionStreamHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const NOW = 2_000_000_000_000;

async function seedUser(
  t: ReturnType<typeof convexTest>,
  username: string,
): Promise<Id<"users">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: `Test ${username}`,
      username,
      role: "scholar",
    }),
  );
}

async function acquire(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  surface = "project-stream",
) {
  return await t.run(async (ctx) =>
    ctx.runMutation(internal.llmLimiter.acquire, { userId, surface }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("llmLimiter.acquire and release", () => {
  test("releases the lease before closing a stream that emitted done", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "scholar-stream-lifecycle");
    const lease = await acquire(t, userId);
    if (!lease.ok) throw new Error("Expected stream lease");

    let leaseActive = true;
    let leaseActiveAtClose: boolean | undefined;
    await releaseLeaseBeforeClosingStream({
      release: async () => {
        await t.run(async (ctx) =>
          ctx.runMutation(internal.llmLimiter.release, {
            leaseId: lease.leaseId,
          }),
        );
        leaseActive =
          (await t.run(async (ctx) => ctx.db.get(lease.leaseId)))?.active ??
          false;
      },
      close: () => {
        leaseActiveAtClose = leaseActive;
      },
    });

    const storedLease = await t.run(async (ctx) => ctx.db.get(lease.leaseId));
    expect(storedLease?.active).toBe(false);
    expect(leaseActiveAtClose).toBe(false);
  });

  test("allows two concurrent starts, denies the third, and release frees a slot", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "scholar-one");

    const first = await acquire(t, userId);
    const second = await acquire(t, userId, "practice-handoff");
    const denied = await acquire(t, userId, "story-open");

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(denied).toEqual({
      ok: false,
      reason: "user-concurrent",
      retryAfterSec: 5,
    });

    if (!first.ok) throw new Error("Expected first lease");
    await t.run(async (ctx) => {
      await ctx.runMutation(internal.llmLimiter.release, {
        leaseId: first.leaseId,
      });
      await ctx.runMutation(internal.llmLimiter.release, {
        leaseId: first.leaseId,
      });
    });

    expect(await acquire(t, userId, "story-open")).toMatchObject({ ok: true });
  });

  test("marks a stale active lease inactive and does not count it", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "scholar-stale");
    const staleLeaseId = await t.run(async (ctx) =>
      ctx.db.insert("llmLeases", {
        userId,
        surface: "project-stream",
        startedAt: NOW - 300_001,
        active: true,
      }),
    );

    expect(await acquire(t, userId)).toMatchObject({ ok: true });
    expect(
      await t.run(async (ctx) => (await ctx.db.get(staleLeaseId))?.active),
    ).toBe(false);
  });

  test("enforces the platform cap across different users", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const t = convexTest(schema, modules);
    const candidateId = await seedUser(t, "candidate");

    await t.run(async (ctx) => {
      for (let index = 0; index < 60; index++) {
        const userId = await ctx.db.insert("users", {
          name: `Platform scholar ${index}`,
          username: `platform-scholar-${index}`,
          role: "scholar",
        });
        await ctx.db.insert("llmLeases", {
          userId,
          surface: index % 2 === 0 ? "project-stream" : "practice-handoff",
          startedAt: NOW - 1_000 - index,
          active: true,
        });
      }
    });

    expect(await acquire(t, candidateId)).toEqual({
      ok: false,
      reason: "platform",
      retryAfterSec: 5,
    });
  });

  test("retention sweep deletes old active and released rows but keeps the window", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const t = convexTest(schema, modules);
    const userId = await seedUser(t, "scholar-retention");
    const ids = await t.run(async (ctx) => ({
      oldActive: await ctx.db.insert("llmLeases", {
        userId,
        surface: "project-stream",
        startedAt: NOW - 600_001,
        active: true,
      }),
      oldReleased: await ctx.db.insert("llmLeases", {
        userId,
        surface: "practice-handoff",
        startedAt: NOW - 700_000,
        active: false,
      }),
      fresh: await ctx.db.insert("llmLeases", {
        userId,
        surface: "story-open",
        startedAt: NOW - 599_999,
        active: false,
      }),
    }));

    const result = await t.run(async (ctx) =>
      ctx.runMutation(internal.llmLimiter.retentionSweep, {}),
    );

    expect(result).toEqual({ deleted: 2, more: false });
    expect(await t.run(async (ctx) => ctx.db.get(ids.oldActive))).toBeNull();
    expect(await t.run(async (ctx) => ctx.db.get(ids.oldReleased))).toBeNull();
    expect(await t.run(async (ctx) => ctx.db.get(ids.fresh))).not.toBeNull();
  });
});
