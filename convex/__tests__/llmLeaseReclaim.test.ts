// A /session-stream turn whose action dies never releases its lease. The next
// session-stream acquire takes back leases no live placeholder accounts for
// (llmLimiter.acquire `sessionStream`), so two dead turns no longer lock a
// scholar out of the tutor for the lease TTL.
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { LEASE_TTL_MS } from "../lib/llmLimiter";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = TestConvex<typeof schema>;

const NOW = 2_000_000_000_000;

afterEach(() => {
  vi.restoreAllMocks();
});

async function seed(t: T) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Test scholar",
      username: "lease-reclaim",
      role: "scholar",
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId,
      title: "Teach the robot",
      isArchived: false,
      lastMessageAt: NOW - 60_000,
    });
    return { userId, sessionId };
  });
}

async function placeholder(
  t: T,
  sessionId: Id<"sessions">,
  fields: Partial<Doc<"messages">> = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("messages", {
      sessionId,
      role: "assistant",
      content: "",
      flagged: false,
      streamId: crypto.randomUUID(),
      streamTrigger: "appUpdate",
      lastStreamActivityAt: NOW,
      ...fields,
    }),
  );
}

/** A lease a session-stream turn took and never released. */
async function leakedLease(t: T, userId: Id<"users">, startedAt: number) {
  return await t.run(async (ctx) =>
    ctx.db.insert("llmLeases", {
      userId,
      surface: "app-update",
      startedAt,
      active: true,
    }),
  );
}

async function acquireForTurn(
  t: T,
  userId: Id<"users">,
  sessionId: Id<"sessions">,
  assistantMsgId: Id<"messages">,
  surface = "project-stream",
) {
  return await t.run(async (ctx) =>
    ctx.runMutation(internal.llmLimiter.acquire, {
      userId,
      surface,
      sessionStream: { sessionId, assistantMsgId },
    }),
  );
}

async function leaseActive(t: T, leaseId: Id<"llmLeases">) {
  return (await t.run(async (ctx) => ctx.db.get(leaseId)))?.active;
}

describe("llmLimiter.acquire reclaims dead session-stream leases", () => {
  test("two dead app-update turns no longer refuse the scholar's next message", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const t = convexTest(schema, modules);
    const { userId, sessionId } = await seed(t);
    const first = await leakedLease(t, userId, NOW - 60_000);
    const second = await leakedLease(t, userId, NOW - 30_000);
    // The typed turn's own fresh placeholder; the dead turns' rows are gone.
    const own = await placeholder(t, sessionId, { streamTrigger: undefined });

    const result = await acquireForTurn(t, userId, sessionId, own);

    expect(result.ok).toBe(true);
    expect(await leaseActive(t, first)).toBe(false);
    expect(await leaseActive(t, second)).toBe(false);
  });

  test("a dead turn whose placeholder went stale is reclaimed", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const t = convexTest(schema, modules);
    const { userId, sessionId } = await seed(t);
    await placeholder(t, sessionId, { lastStreamActivityAt: NOW - 25_000 });
    const first = await leakedLease(t, userId, NOW - 40_000);
    const second = await leakedLease(t, userId, NOW - 26_000);
    const own = await placeholder(t, sessionId);

    const result = await acquireForTurn(t, userId, sessionId, own, "app-update");

    expect(result.ok).toBe(true);
    expect(await leaseActive(t, first)).toBe(false);
    expect(await leaseActive(t, second)).toBe(false);
  });

  test("a stream still heartbeating in another session keeps its slot", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const t = convexTest(schema, modules);
    const { userId, sessionId } = await seed(t);
    const otherSession = await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId,
        title: "Another tab",
        isArchived: false,
        lastMessageAt: NOW - 5_000,
      }),
    );
    await placeholder(t, otherSession, { lastStreamActivityAt: NOW - 3_000 });
    const dead = await leakedLease(t, userId, NOW - 60_000);
    const live = await leakedLease(t, userId, NOW - 10_000);
    const own = await placeholder(t, sessionId);

    const result = await acquireForTurn(t, userId, sessionId, own);

    // One slot is held by the live stream, one is reclaimed for this turn.
    expect(result.ok).toBe(true);
    expect(await leaseActive(t, dead)).toBe(false);
    expect(await leaseActive(t, live)).toBe(true);
  });

  test("two live streams still refuse a third turn", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const t = convexTest(schema, modules);
    const { userId, sessionId } = await seed(t);
    await placeholder(t, sessionId, { lastStreamActivityAt: NOW - 2_000 });
    await placeholder(t, sessionId, { lastStreamActivityAt: NOW - 4_000 });
    const a = await leakedLease(t, userId, NOW - 8_000);
    const b = await leakedLease(t, userId, NOW - 6_000);
    const own = await placeholder(t, sessionId);

    const result = await acquireForTurn(t, userId, sessionId, own);

    expect(result).toMatchObject({ ok: false, reason: "user-concurrent" });
    expect(await leaseActive(t, a)).toBe(true);
    expect(await leaseActive(t, b)).toBe(true);
  });

  test("other surfaces and acquires without a turn are unchanged", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const t = convexTest(schema, modules);
    const { userId, sessionId } = await seed(t);
    const a = await leakedLease(t, userId, NOW - 60_000);
    const b = await leakedLease(t, userId, NOW - 30_000);
    const own = await placeholder(t, sessionId);

    const withoutTurn = await t.run(async (ctx) =>
      ctx.runMutation(internal.llmLimiter.acquire, {
        userId,
        surface: "project-stream",
      }),
    );
    const otherSurface = await acquireForTurn(
      t,
      userId,
      sessionId,
      own,
      "practice-handoff",
    );

    expect(withoutTurn).toMatchObject({ ok: false, reason: "user-concurrent" });
    expect(otherSurface).toMatchObject({ ok: false, reason: "user-concurrent" });
    expect(await leaseActive(t, a)).toBe(true);
    expect(await leaseActive(t, b)).toBe(true);
  });

  test("a lease past its TTL is left to the stale sweep", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const t = convexTest(schema, modules);
    const { userId, sessionId } = await seed(t);
    const stale = await leakedLease(t, userId, NOW - LEASE_TTL_MS - 1);
    const own = await placeholder(t, sessionId);

    const result = await acquireForTurn(t, userId, sessionId, own);

    expect(result.ok).toBe(true);
    expect(await leaseActive(t, stale)).toBe(false);
  });
});
